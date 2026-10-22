import { join } from "node:path";
import {
  type DeliveryContext,
  merge,
  observeCi,
  publish,
  REPUBLISH,
} from "../delivery.js";
import type { Outcome, Step, StepContext } from "../engine.js";
import { defaultHead } from "../git.js";
import {
  BaseFiles,
  finalCommands,
  fixedScripts,
  planningSources,
} from "../planning/facts.js";
import { packageManagerUpdate } from "../planning/prompts.js";
import { repositoryView } from "../planning/repository.js";
import { guarded, type PlanningDeps, readIssue } from "../planning/steps.js";
import type { Plan, WorkItem } from "../planning/types.js";
import { correction, type RepairFinding } from "../repair.js";
import { reviewObjective } from "../review/final.js";
import {
  type CriterionDecision,
  type ResultReview,
  reviewResult,
} from "../review/result.js";
import type { ObjectiveState } from "../state.js";
import { validateTree } from "../validate.js";
import {
  addWorktree,
  GitRefusal,
  hostGit,
  hostGitExit,
  removeWorktree,
  worktreePath,
} from "../worktree.js";
import { collect } from "./collect.js";
import { prepareWorkPrompt, type RepairContext } from "./prompt.js";
import type { Worker } from "./worker.js";

const MINUTE = 60_000;

/** What execution needs from the installation, beyond planning. */
export interface BuildDeps extends PlanningDeps {
  /** The worker for an Objective's plan. */
  worker(plan: Plan, body: string): Worker;
}

/*
 * One Work Item runs these steps, each saved when it finishes:
 *
 *   item:<id>:work      worker in the kept worktree, then collection
 *   item:<id>:validate  the item's commands on the exact commit
 *   item:<id>:review    the independent result review
 *   item:<id>:publish   push factory/<issue>/<id>, find or open the PR
 *   item:<id>:ci        the PR's checks on the exact head
 *   item:<id>:merge     merge with the head as guard
 *
 * A refused result is a `repair`: the item's steps from `work` on are
 * cleared and the worker continues in its kept worktree with the finding.
 * Facts that outlive repairs are kept in `state.kept`, under item keys.
 */
const PHASES = [
  "work",
  "validate",
  "review",
  "publish",
  "ci",
  "merge",
] as const;
type Phase = (typeof PHASES)[number];

const stepKey = (id: string, phase: Phase) => `item:${id}:${phase}`;
const keptKey = (id: string, fact: string) => `item:${id}:${fact}`;

function kept<T>(
  state: ObjectiveState,
  id: string,
  fact: string,
): T | undefined {
  return (state.kept ?? {})[keptKey(id, fact)] as T | undefined;
}

interface WorkResult {
  base: string;
  commit: string;
  tree: string;
  notes: unknown[];
  validated?: { tree: string; commands: string[] };
}

interface ValidateResult {
  tree: string;
  commands: string[];
}

interface PublishResult {
  pr: number;
  head: string;
  merged: boolean;
}

interface MergeResult {
  mergeSha: string;
  integratedSha: string;
  at: string;
}

/** The runnable item steps: each item whose dependencies have merged. */
export function buildSteps(state: ObjectiveState, deps: BuildDeps): Step[] {
  const plan = state.done.plan as Plan;
  const merged = (id: string) => Boolean(state.done[stepKey(id, "merge")]);
  const steps: Step[] = [];
  for (const item of plan.items) {
    if (merged(item.id)) continue;
    if (!item.dependencies.every(merged)) continue;
    if (item.kind === "aggregate") {
      if ((item.children ?? []).every(merged)) steps.push(aggregateStep(item));
      continue;
    }
    if (item.kind === "qa" || item.kind === "discovery") {
      steps.push(notYet(item, `${item.kind} items`));
      continue;
    }
    const phase = PHASES.find((p) => !state.done[stepKey(item.id, p)]);
    if (phase) steps.push(itemStep(item, phase, deps));
  }
  return steps;
}

/** Whether every item has merged (or, for aggregates, completed). */
export function built(state: ObjectiveState): boolean {
  const plan = state.done.plan as Plan | undefined;
  return Boolean(
    plan?.items.every((item) => state.done[stepKey(item.id, "merge")]),
  );
}

function itemStep(item: WorkItem, phase: Phase, deps: BuildDeps): Step {
  const key = stepKey(item.id, phase);
  const run = {
    work: workStep,
    validate: validateStep,
    review: reviewStep,
    publish: publishStep,
    ci: ciStep,
    merge: mergeStep,
  }[phase];
  return {
    key,
    ...(phase === "work"
      ? { resource: "worker" as const }
      : phase === "validate"
        ? { resource: "cpu" as const }
        : {}),
    deadlineMs:
      phase === "work"
        ? 2 * 60 * MINUTE
        : phase === "ci"
          ? 10 * MINUTE
          : 45 * MINUTE,
    run: (context) =>
      context.answer?.answer === "replan"
        ? Promise.resolve(replanOutcome(context.state))
        : guardedItem(() => run(item, context, deps)),
  };
}

// ---------------------------------------------------------------------------
// work

async function workStep(
  item: WorkItem,
  context: StepContext,
  deps: BuildDeps,
): Promise<Outcome> {
  const { state, signal } = context;
  const { config } = deps;
  const plan = state.done.plan as Plan;
  const body = objectiveBody(state);
  const worktree = worktreePath(
    deps.workDir(state.issue),
    state.issue,
    item.id,
  );
  // An item builds on the default branch as it is when it starts, which
  // holds every merged dependency; it keeps that base across repairs.
  let base =
    kept<string>(state, item.id, "base") ??
    (await defaultHead(config.checkout, signal));
  await addWorktree(config.checkout, worktree, base, signal);
  if (kept(state, item.id, "rebase")) {
    // A conflict or failed delivery: move onto the current default branch and
    // replay the refused change, so the worker can resolve it there.
    const head = await defaultHead(config.checkout, signal);
    const refused = kept<string>(state, item.id, "refusedCommit");
    if (head !== base) {
      await rebaseWorktree(
        config.checkout,
        worktree,
        base,
        head,
        refused,
        signal,
      );
      base = head;
    }
  }
  const keepBase = {
    [keptKey(item.id, "base")]: base,
    [keptKey(item.id, "rebase")]: false,
  };

  const repair = await repairContext(item, context, deps, base);
  if (repair && "hold" in repair) return withKeep(repair.hold, keepBase);
  const keepAll = { ...keepBase, ...(repair?.keep ?? {}) };

  const files = new BaseFiles(config.checkout, base, signal);
  const scripts = await fixedScripts(
    finalCommands(body, config.finalValidation.requiredCommands),
    files,
  );
  const pin = packageManagerUpdate(body);
  const prepared = await prepareWorkPrompt({
    checkout: config.checkout,
    worktree,
    objective: state.issue,
    objectiveBody: body,
    plan,
    item,
    base,
    conventions: (await repositoryView(config.checkout, base, false, signal))
      .conventions,
    fixedScripts: scripts.map((script) => script.name),
    ...(pin ? { packageManagerUpdate: pin } : {}),
    ...(repair ? { repair: repair.context } : {}),
    signal,
  });
  if ("problem" in prepared)
    return withKeep(
      {
        kind: "hold",
        question: prepared.problem,
        answers: ["retry", "replan", "cancel"],
        recommended: "retry",
      },
      keepAll,
    );

  const result = await deps.worker(plan, body).run({
    worktree,
    prompt: prepared.prompt,
    item,
    commands: item.validation.map((v) => v.command),
    base,
    signal,
    log: context.log,
  });
  if (result.kind !== "finished") return withKeep(result, keepAll);

  const collected = await collect({
    checkout: config.checkout,
    worktree,
    base,
    plan,
    item,
    sandbox: config.sandbox,
    finalResponse: result.finalResponse,
    ...(kept<string>(state, item.id, "refusedTree")
      ? { refusedTree: kept<string>(state, item.id, "refusedTree")! }
      : {}),
    signal,
  });
  switch (collected.kind) {
    case "collected": {
      const done: WorkResult = {
        base,
        commit: collected.commit,
        tree: collected.tree,
        notes: collected.notes,
        ...(result.validated ? { validated: result.validated } : {}),
      };
      return { kind: "done", result: done, keep: keepAll };
    }
    case "repair":
      return repairOutcome(item, "work", collected.finding, {
        ...keepAll,
        [keptKey(item.id, "finding")]: {
          kind: "failure",
          detail: collected.finding,
        } satisfies RepairFinding,
      });
    default:
      return withKeep(collected, keepAll);
  }
}

/** Add facts to keep to any outcome that can carry them. */
function withKeep(outcome: Outcome, keep: Record<string, unknown>): Outcome {
  if (outcome.kind === "fail") return outcome;
  return { ...outcome, keep: { ...(outcome.keep ?? {}), ...keep } };
}

/**
 * Move a kept worktree from `from` to `to` and replay the refused change on
 * it. Conflicts stay in the files for the worker to resolve.
 */
async function rebaseWorktree(
  checkout: string,
  worktree: string,
  from: string,
  to: string,
  refused: string | undefined,
  signal: AbortSignal,
): Promise<void> {
  await hostGit(worktree, ["checkout", "--detach", "--force", to], { signal });
  await hostGit(worktree, ["clean", "-ffdx", "--", "."], { signal });
  if (!refused) return;
  const diff = await hostGit(
    checkout,
    ["diff", "--no-ext-diff", "--no-textconv", from, refused],
    { signal },
  );
  if (!diff.length) return;
  // Applying may conflict; the worker resolves what remains.
  await hostGitExit(worktree, ["apply", "--3way", "--whitespace=nowarn"], {
    input: diff.toString("utf8"),
    signal,
  });
}

/**
 * What a repaired attempt is told: the latest finding and its correction.
 * The correction is diagnosed once per repair and kept, so a rerun of the
 * work step reuses it; an operator question holds.
 */
async function repairContext(
  item: WorkItem,
  context: StepContext,
  deps: BuildDeps,
  base: string,
): Promise<
  | { context: RepairContext; keep: Record<string, unknown> }
  | { hold: Outcome }
  | undefined
> {
  const { state, signal } = context;
  const history = state.repairs?.[stepKey(item.id, "work")];
  const finding = kept<RepairFinding>(state, item.id, "finding");
  if (!history?.count || !finding) return undefined;
  const saved = kept<{ repair: number; context: RepairContext }>(
    state,
    item.id,
    "correction",
  );
  if (saved?.repair === history.count)
    return { context: saved.context, keep: {} };
  const applied = kept<string[]>(state, item.id, "corrections") ?? [];
  const plan = state.done.plan as Plan;
  const previous = state.done[stepKey(item.id, "work")] as
    | WorkResult
    | undefined;
  const sources = await pinnedSources(state, deps, signal);
  const answer =
    context.answer?.answer === "answer" ? context.answer.text : undefined;
  const result = await correction({
    planner: deps.planner,
    plan,
    item,
    finding,
    checkout: deps.config.checkout,
    base,
    commit:
      kept<string>(state, item.id, "refusedCommit") ?? previous?.commit ?? base,
    sources,
    prior: applied,
    ...(answer ? { operatorAnswer: answer } : {}),
    signal,
    log: context.log,
  });
  if (result.kind === "question")
    return {
      hold: {
        kind: "hold",
        question: `Work Item ${item.id} needs your decision before it is repaired:\n\n${result.question}\n\nAnswer with \`answer <decision>\`.`,
        answers: ["answer", "retry", "cancel"],
        recommended: "answer",
      },
    };
  const repairContextValue: RepairContext = {
    finding: result.correction.failure,
    correction: {
      diagnosis: result.correction.diagnosis,
      correction: result.correction.correction,
    },
    ...(finding.kind === "review" ? { fromReview: true } : {}),
  };
  return {
    context: repairContextValue,
    keep: {
      [keptKey(item.id, "correction")]: {
        repair: history.count,
        context: repairContextValue,
      },
      [keptKey(item.id, "corrections")]: [...applied, result.finding],
    },
  };
}

// ---------------------------------------------------------------------------
// validate

async function validateStep(
  item: WorkItem,
  context: StepContext,
  deps: BuildDeps,
): Promise<Outcome> {
  const { state, signal } = context;
  const { config } = deps;
  const plan = state.done.plan as Plan;
  const work = state.done[stepKey(item.id, "work")] as WorkResult;
  const worktree = worktreePath(
    deps.workDir(state.issue),
    state.issue,
    item.id,
  );
  await addWorktree(config.checkout, worktree, work.base, signal);
  const result = await validateTree({
    checkout: config.checkout,
    directory: `${worktree}.validation`,
    commit: work.commit,
    item,
    plan,
    body: objectiveBody(state),
    ...(work.base !== plan.base ? { predecessor: work.base } : {}),
    sandbox: config.sandbox,
    signal,
    log: context.log,
  });
  switch (result.kind) {
    case "passed": {
      const done: ValidateResult = {
        tree: result.tree,
        commands: result.commands,
      };
      return { kind: "done", result: done };
    }
    case "failed": {
      // The worker's own Validate passed this exact tree with these
      // commands: run once more before calling it the result's fault.
      const flakyKey = keptKey(item.id, "flaky");
      const sameAsWorker =
        work.validated?.tree === result.tree &&
        JSON.stringify(work.validated.commands) ===
          JSON.stringify(result.commands);
      const rerun = kept<{ tree: string }>(state, item.id, "flaky");
      if (sameAsWorker && rerun?.tree !== result.tree && result.failed)
        return {
          kind: "retry",
          reason: `\`${result.failed.command}\` failed on a tree the worker's own validation passed; running it once more.`,
          afterMs: 0,
          keep: {
            [flakyKey]: { tree: result.tree, command: result.failed.command },
          },
        };
      return repairOutcome(item, "validate", result.detail, {
        [keptKey(item.id, "finding")]: {
          kind: "failure",
          detail: result.output,
        } satisfies RepairFinding,
        [keptKey(item.id, "refusedTree")]: result.tree,
        [keptKey(item.id, "refusedCommit")]: work.commit,
      });
    }
    default:
      return result;
  }
}

// ---------------------------------------------------------------------------
// review

async function reviewStep(
  item: WorkItem,
  context: StepContext,
  deps: BuildDeps,
): Promise<Outcome> {
  const { state, signal } = context;
  const plan = state.done.plan as Plan;
  const work = state.done[stepKey(item.id, "work")] as WorkResult;
  const validated = state.done[stepKey(item.id, "validate")] as ValidateResult;
  const worktree = worktreePath(
    deps.workDir(state.issue),
    state.issue,
    item.id,
  );
  const pendingKey = keptKey(item.id, "questions");
  const decisions = criterionDecisions(
    context,
    validated.tree,
    kept<string[]>(state, item.id, "questions"),
  );
  const review = await reviewResult({
    planner: deps.planner,
    plan,
    item,
    checkout: deps.config.checkout,
    base: work.base,
    commit: work.commit,
    validation: validated,
    sources: await pinnedSources(state, deps, signal),
    dir: `${worktree}.review`,
    notes: JSON.stringify(work.notes),
    decisions,
    signal,
    log: context.log,
  });
  return reviewOutcome(review, pendingKey, () =>
    repairOutcome(
      item,
      "review",
      review.kind === "refused"
        ? review.refused.map((r) => `${r.criterion}: ${r.detail}`).join("\n")
        : "",
      {
        [keptKey(item.id, "finding")]: {
          kind: "review",
          tree: review.tree,
          refused: review.kind === "refused" ? review.refused : [],
        } satisfies RepairFinding,
        [keptKey(item.id, "refusedTree")]: review.tree,
        [keptKey(item.id, "refusedCommit")]: work.commit,
      },
    ),
  );
}

/** Pass is done, refused repairs, needs-human asks (saving the criteria it asks about under `pendingKey`). */
function reviewOutcome(
  review: ResultReview,
  pendingKey: string,
  refused: () => Outcome,
): Outcome {
  if (review.kind === "pass")
    return { kind: "done", result: { tree: review.tree } };
  if (review.kind === "refused") return refused();
  const lines = review.questions.map(
    (q, i) =>
      `${i + 1}. ${q.criterion}\n   ${q.question}${q.detail ? `\n   ${q.detail}` : ""}`,
  );
  return {
    kind: "hold",
    question: `The reviewer needs your judgment on this result:\n\n${lines.join("\n")}\n\n\`accept\` accepts ${review.questions.length === 1 ? "it" : "them all"}; \`refuse <reason>\` sends the result back for repair.`,
    answers: ["accept", "refuse", "cancel"],
    recommended: "accept",
    keep: { [pendingKey]: review.questions.map((q) => q.criterion) },
  };
}

/** The operator's accept or refuse, applied to every open question on this tree. */
function criterionDecisions(
  context: StepContext,
  tree: string,
  criteria: string[] | undefined,
): CriterionDecision[] | undefined {
  const answer = context.answer;
  if (
    !answer ||
    !criteria?.length ||
    (answer.answer !== "accept" && answer.answer !== "refuse")
  )
    return undefined;
  const outcome = answer.answer;
  return criteria.map((criterion) => ({
    criterion,
    tree,
    outcome,
    by: answer.by,
    at: answer.at,
    ...(answer.text ? { text: answer.text } : {}),
  }));
}

// ---------------------------------------------------------------------------
// publish, ci, merge

function delivery(
  context: StepContext,
  deps: BuildDeps,
  key: string,
): DeliveryContext {
  const since = context.state.retries[key]?.since;
  return {
    github: deps.github,
    checkout: deps.config.checkout,
    signal: context.signal,
    ...(since ? { retryingSince: since } : {}),
  };
}

async function publishStep(
  item: WorkItem,
  context: StepContext,
  deps: BuildDeps,
): Promise<Outcome> {
  const { state } = context;
  const changed = await objectiveEdited(context, deps);
  if (changed) return changed;
  const work = state.done[stepKey(item.id, "work")] as WorkResult;
  const validated = state.done[stepKey(item.id, "validate")] as ValidateResult;
  const pushed = kept<string[]>(state, item.id, "pushed") ?? [];
  const republish =
    context.answer?.answer === REPUBLISH ||
    Boolean(kept(state, item.id, "republish"));
  const rerun = kept<{ tree: string; command: string }>(
    state,
    item.id,
    "flaky",
  );
  const flaky = rerun?.tree === validated.tree ? rerun : undefined;
  const result = await publish(
    delivery(context, deps, stepKey(item.id, "publish")),
    {
      issue: state.issue,
      item,
      base: work.base,
      commit: work.commit,
      tree: validated.tree,
      pushedHeads: pushed,
      validation: {
        commands: validated.commands,
        ...(flaky ? { flaky: { command: flaky.command, exitCode: null } } : {}),
      },
      ...(republish ? { republish: true } : {}),
    },
  );
  if (result.kind === "empty")
    return repairOutcome(item, "publish", result.finding, {
      [keptKey(item.id, "finding")]: {
        kind: "failure",
        detail: result.finding,
      } satisfies RepairFinding,
    });
  if (result.kind !== "published")
    return republish
      ? { ...result, keep: { [keptKey(item.id, "republish")]: true } }
      : result;
  const done: PublishResult = {
    pr: result.pr,
    head: result.head,
    merged: result.merged,
  };
  return {
    kind: "done",
    result: done,
    keep: {
      [keptKey(item.id, "pushed")]: [...new Set([...pushed, work.commit])],
      [keptKey(item.id, "republish")]: false,
    },
  };
}

function pullInput(
  state: ObjectiveState,
  item: WorkItem,
  context: StepContext,
) {
  const plan = state.done.plan as Plan;
  const published = state.done[stepKey(item.id, "publish")] as PublishResult;
  return {
    issue: state.issue,
    item: item.id,
    pr: published.pr,
    head: published.head,
    pushedHeads: kept<string[]>(state, item.id, "pushed") ?? [],
    requiredChecks: (plan.requiredPreIntegrationChecks ?? []).map(
      (c) => c.checkName,
    ),
    ...(context.answer?.answer === REPUBLISH ? { republish: true } : {}),
  };
}

async function ciStep(
  item: WorkItem,
  context: StepContext,
  deps: BuildDeps,
): Promise<Outcome> {
  const result = await observeCi(
    delivery(context, deps, stepKey(item.id, "ci")),
    pullInput(context.state, item, context),
  );
  switch (result.kind) {
    case "ready":
      return {
        kind: "done",
        result: { head: result.head, merged: result.merged },
      };
    case "repair":
      return deliveryRepair(item, context, result.finding, "ci");
    case "republish":
      return republishOutcome(item, result.reason);
    default:
      return result;
  }
}

async function mergeStep(
  item: WorkItem,
  context: StepContext,
  deps: BuildDeps,
): Promise<Outcome> {
  const { state } = context;
  const plan = state.done.plan as Plan;
  const ci = state.done[stepKey(item.id, "ci")] as { head: string };
  const result = await merge(
    delivery(context, deps, stepKey(item.id, "merge")),
    {
      ...pullInput(state, item, context),
      head: ci.head,
      integrated: integrated(state, plan),
    },
  );
  switch (result.kind) {
    case "merged": {
      const done: MergeResult = {
        mergeSha: result.mergeSha,
        integratedSha: result.integratedSha,
        at: new Date().toISOString(),
      };
      return { kind: "done", result: done };
    }
    case "repair":
      return deliveryRepair(item, context, result.finding, "merge");
    case "republish":
      return republishOutcome(item, result.reason);
    default:
      return result;
  }
}

/** Failed CI or a conflict: the worker repairs, and the same PR gets the new head. */
function deliveryRepair(
  item: WorkItem,
  context: StepContext,
  finding: string,
  phase: Phase,
): Outcome {
  const work = context.state.done[stepKey(item.id, "work")] as WorkResult;
  return repairOutcome(item, phase, finding, {
    [keptKey(item.id, "finding")]: {
      kind: "failure",
      detail: finding,
    } satisfies RepairFinding,
    [keptKey(item.id, "refusedCommit")]: work.commit,
    [keptKey(item.id, "refusedTree")]: work.tree,
    [keptKey(item.id, "rebase")]: true,
  });
}

function republishOutcome(item: WorkItem, reason: string): Outcome {
  return {
    kind: "repair",
    finding: reason,
    target: stepKey(item.id, "publish"),
    clear: (["publish", "ci", "merge"] as const).map((p) =>
      stepKey(item.id, p),
    ),
    keep: { [keptKey(item.id, "republish")]: true },
  };
}

/** Clear the item's steps from `work` and run the worker again with the finding. */
function repairOutcome(
  item: WorkItem,
  _from: Phase,
  finding: string,
  keep: Record<string, unknown>,
): Outcome {
  return {
    kind: "repair",
    finding,
    target: stepKey(item.id, "work"),
    clear: PHASES.map((p) => stepKey(item.id, p)),
    keep,
  };
}

/**
 * `replan` after the plan was accepted: forget the plan and the build, and
 * check the Objective again from the issue and the default branch. Merged
 * work is on the default branch, so the new plan starts from it.
 */
function replanOutcome(state: ObjectiveState): Outcome {
  return {
    kind: "repair",
    finding: "The operator asked to replan.",
    target: "check",
    clear: Object.keys(state.done),
    keep: Object.fromEntries(
      Object.keys(state.kept ?? {}).map((key) => [key, null]),
    ),
  };
}

// ---------------------------------------------------------------------------
// aggregates and not-yet-ported kinds

function aggregateStep(item: WorkItem): Step {
  return {
    key: stepKey(item.id, "merge"),
    deadlineMs: MINUTE,
    async run(): Promise<Outcome> {
      return { kind: "done", result: { aggregate: true } };
    },
  };
}

function notYet(item: WorkItem, what: string): Step {
  return {
    key: stepKey(item.id, "work"),
    deadlineMs: MINUTE,
    async run(): Promise<Outcome> {
      return {
        kind: "hold",
        question: `Work Item ${item.id} is one of the ${what}, which this Factory build can't run yet.`,
        answers: ["retry", "replan", "cancel"],
        recommended: "cancel",
      };
    },
  };
}

// ---------------------------------------------------------------------------
// final validation and final review

interface FinalResult {
  commit: string;
  tree: string;
  commands: string[];
}

/** `final`: the final commands on the default branch head after every merge. */
export function finalStep(deps: BuildDeps): Step {
  return {
    key: "final",
    resource: "cpu",
    deadlineMs: 60 * MINUTE,
    run: (context) =>
      guardedItem(async () => {
        const { state, signal } = context;
        const { config } = deps;
        const plan = state.done.plan as Plan;
        if (context.answer?.answer === "replan") return replanOutcome(state);
        const head = await defaultHead(config.checkout, signal);
        for (const item of plan.items) {
          const merged = state.done[stepKey(item.id, "merge")] as
            | MergeResult
            | undefined;
          if (!merged?.mergeSha) continue;
          const on = await hostGitExit(
            config.checkout,
            ["merge-base", "--is-ancestor", merged.mergeSha, head],
            { signal },
          );
          if (on.code !== 0)
            return {
              kind: "hold",
              question: `Work Item ${item.id}'s merge \`${merged.mergeSha.slice(0, 12)}\` is not on the default branch (${head.slice(0, 12)}); someone may have reverted or force-pushed it. Restore it and answer \`retry\`, or \`replan\`.`,
              answers: ["retry", "replan", "cancel"],
              recommended: "retry",
            };
        }
        const result = await validateTree({
          checkout: config.checkout,
          directory: join(deps.workDir(state.issue), "final"),
          commit: head,
          plan,
          body: objectiveBody(state),
          sandbox: config.sandbox,
          signal,
          log: context.log,
        });
        if (result.kind === "passed") {
          const done: FinalResult = {
            commit: head,
            tree: result.tree,
            commands: result.commands,
          };
          return { kind: "done", result: done };
        }
        if (result.kind === "failed")
          return {
            kind: "hold",
            question: `Final validation failed on the default branch (${head.slice(0, 12)}):\n\n${result.detail}\n\nFix it on the default branch and answer \`retry\`, or cancel.`,
            answers: ["retry", "cancel"],
            recommended: "retry",
          };
        return result;
      }),
  };
}

/** `final-review`: every Objective criterion against the integrated result. */
export function finalReviewStep(deps: BuildDeps): Step {
  return {
    key: "final-review",
    deadlineMs: 45 * MINUTE,
    run: (context) =>
      guardedItem(async () => {
        const { state, signal } = context;
        if (context.answer?.answer === "replan") return replanOutcome(state);
        // A fix on the default branch: validate the new head before reviewing again.
        if (context.answer?.answer === "retry")
          return {
            kind: "repair",
            finding: "Final review runs again after the operator's fix.",
            target: "final",
            clear: ["final", "final-review"],
          };
        const plan = state.done.plan as Plan;
        const final = state.done.final as FinalResult;
        const review = await reviewObjective({
          planner: deps.planner,
          plan,
          checkout: deps.config.checkout,
          base: plan.base,
          commit: final.commit,
          merges: plan.items
            .map(
              (item) =>
                state.done[stepKey(item.id, "merge")] as
                  | MergeResult
                  | undefined,
            )
            .filter((merged): merged is MergeResult => !!merged?.mergeSha)
            .sort((a, b) => a.at.localeCompare(b.at))
            .map((merged) => merged.mergeSha),
          validation: { tree: final.tree, commands: final.commands },
          sources: await pinnedSources(state, deps, signal),
          dir: join(deps.workDir(state.issue), "final-review"),
          ...(criterionDecisions(
            context,
            final.tree,
            (state.kept ?? {})["final:questions"] as string[] | undefined,
          )
            ? {
                decisions: criterionDecisions(
                  context,
                  final.tree,
                  (state.kept ?? {})["final:questions"] as string[],
                )!,
              }
            : {}),
          signal,
          log: context.log,
        });
        return reviewOutcome(review, "final:questions", () => ({
          kind: "hold",
          question: `Final review refused the integrated result:\n\n${review.kind === "refused" ? review.refused.map((r) => `- ${r.criterion}: ${r.detail}`).join("\n") : ""}\n\nFix it on the default branch and answer \`retry\`, or \`replan\` to plan the remaining work, or cancel.`,
          answers: ["retry", "replan", "cancel"],
          recommended: "retry",
        }));
      }),
  };
}

// ---------------------------------------------------------------------------
// Shared

/**
 * The Objective was edited or closed after its plan was accepted: ask before
 * the next effect. `continue` keeps the plan and accepts the new text.
 */
async function objectiveEdited(
  context: StepContext,
  deps: BuildDeps,
): Promise<Outcome | undefined> {
  const { state, signal } = context;
  const issue = await readIssue(state.issue, deps, signal);
  const body = (issue.body ?? "").replace(/\r\n/g, "\n").trim();
  const accepted = (
    ((state.kept ?? {})["objective:accepted"] as string | undefined) ??
    objectiveBody(state)
  )
    .replace(/\r\n/g, "\n")
    .trim();
  if (context.answer?.answer === "continue")
    return body === accepted
      ? undefined
      : {
          kind: "retry",
          reason: "Continuing with the edited Objective.",
          afterMs: 0,
          keep: { "objective:accepted": body },
        };
  if (issue.state !== "open")
    return {
      kind: "hold",
      question: `Issue #${state.issue} was closed while Factory was building it. Reopen it and answer \`continue\`, or cancel.`,
      answers: ["continue", "cancel"],
      recommended: "cancel",
    };
  if (body !== accepted)
    return {
      kind: "hold",
      question: `Objective #${state.issue} was edited after its plan was accepted. \`continue\` keeps building this plan; \`replan\` plans again from the new text.`,
      answers: ["continue", "replan", "cancel"],
      recommended: "replan",
    };
  return undefined;
}

/** The Objective body as planning read it. */
function objectiveBody(state: ObjectiveState): string {
  let latest = (state.done.check as { body: string }).body;
  for (const [key, value] of Object.entries(state.done))
    if (
      /^plan:\d+:1$/.test(key) &&
      (value as { inputs?: { body: string } }).inputs
    )
      latest = (value as { inputs: { body: string } }).inputs.body;
  return latest;
}

/** The commit the next item builds on: the latest merge, else the plan base. */
function integrated(state: ObjectiveState, plan: Plan): string {
  let latest: MergeResult | undefined;
  for (const [key, value] of Object.entries(state.done))
    if (key.endsWith(":merge") && (value as MergeResult).integratedSha)
      if (!latest || (value as MergeResult).at > latest.at)
        latest = value as MergeResult;
  return latest?.integratedSha ?? plan.base;
}

async function pinnedSources(
  state: ObjectiveState,
  deps: BuildDeps,
  signal: AbortSignal,
) {
  const plan = state.done.plan as Plan;
  const { sources } = await planningSources(
    objectiveBody(state),
    new BaseFiles(deps.config.checkout, plan.base, signal),
  );
  return sources;
}

/** Item steps map Git refusals to a hold; everything else goes through planning's mapping. */
async function guardedItem(work: () => Promise<Outcome>): Promise<Outcome> {
  return guarded(async () => {
    try {
      return await work();
    } catch (error) {
      if (error instanceof GitRefusal)
        return {
          kind: "hold",
          question: error.message,
          answers: ["retry", "cancel"],
          recommended: "retry",
        };
      throw error;
    }
  });
}

// ---------------------------------------------------------------------------
// report and cancel cleanup

/** `report`: post the outcome on the issue, close it, and remove worktrees. */
export function reportStep(deps: BuildDeps): Step {
  return {
    key: "report",
    deadlineMs: 10 * MINUTE,
    run: (context) =>
      guardedItem(async () => {
        const { state, signal } = context;
        const { config, github } = deps;
        if (context.answer?.answer === "replan") return replanOutcome(state);
        const marker = `<!-- factory:${state.issue}:report -->`;
        // Once the report is posted, the issue close that follows is Factory's
        // own: a restart after it must not read it as the operator's.
        const reported = await github.findComment(
          state.issue,
          marker,
          undefined,
          signal,
        );
        if (!reported) {
          const changed = await objectiveEdited(context, deps);
          if (changed) return changed;
        }
        const plan = state.done.plan as Plan;
        const final = state.done.final as FinalResult;
        const lines = plan.items.map((item) => {
          const published = state.done[stepKey(item.id, "publish")] as
            | PublishResult
            | undefined;
          const merged = state.done[stepKey(item.id, "merge")] as
            | MergeResult
            | undefined;
          return `- **${item.id}** ${item.title}${published ? ` — #${published.pr}` : ""}${merged?.mergeSha ? ` merged as \`${merged.mergeSha.slice(0, 12)}\`` : ""}`;
        });
        const repairs = Object.values(state.repairs ?? {}).reduce(
          (sum, r) => sum + r.count,
          0,
        );
        const body = `${marker}\n**Factory finished this Objective.**\n\n${lines.join("\n")}\n\nFinal validation and final review passed on \`${final.commit.slice(0, 12)}\` (${final.commands.map((c) => `\`${c}\``).join(", ")}).${repairs ? ` ${repairs} repair${repairs === 1 ? "" : "s"} along the way.` : ""}`;
        if (!reported)
          await github.rest(
            "POST",
            `/repos/${config.repository}/issues/${state.issue}/comments`,
            { body },
            signal,
          );
        const issue = await github.rest<{ state: string }>(
          "GET",
          `/repos/${config.repository}/issues/${state.issue}`,
          undefined,
          signal,
        );
        if (issue.state === "open")
          await github.rest(
            "PATCH",
            `/repos/${config.repository}/issues/${state.issue}`,
            { state: "closed", state_reason: "completed" },
            signal,
          );
        await removeWorktrees(state, deps, signal);
        return { kind: "done" };
      }),
  };
}

/** After cancel: close Factory's open PRs and remove worktrees. It retries; it never asks. */
export function cancelCleanupStep(deps: BuildDeps): Step {
  return {
    key: "cancel:cleanup",
    deadlineMs: 10 * MINUTE,
    run: async ({ state, signal }) => {
      const plan = state.done.plan as Plan | undefined;
      const { config, github } = deps;
      for (const item of plan?.items ?? []) {
        const branch = `${config.repository.split("/")[0]}:factory/${state.issue}/${item.id}`;
        const pulls = await github.rest<{ number: number }[]>(
          "GET",
          `/repos/${config.repository}/pulls?head=${encodeURIComponent(branch)}&state=open`,
          undefined,
          signal,
        );
        for (const pull of pulls) {
          const marker = `<!-- factory:${state.issue}:pr-cancelled:${item.id} -->`;
          if (
            !(await github.findComment(pull.number, marker, undefined, signal))
          )
            await github.rest(
              "POST",
              `/repos/${config.repository}/issues/${pull.number}/comments`,
              {
                body: `${marker}\nFactory cancelled Objective #${state.issue}; closing this PR.`,
              },
              signal,
            );
          await github.rest(
            "PATCH",
            `/repos/${config.repository}/pulls/${pull.number}`,
            { state: "closed" },
            signal,
          );
        }
      }
      await removeWorktrees(state, deps, signal);
      return { kind: "done" };
    },
  };
}

async function removeWorktrees(
  state: ObjectiveState,
  deps: BuildDeps,
  signal: AbortSignal,
): Promise<void> {
  const plan = state.done.plan as Plan | undefined;
  for (const item of plan?.items ?? [])
    await removeWorktree(
      deps.config.checkout,
      worktreePath(deps.workDir(state.issue), state.issue, item.id),
      signal,
    );
}
