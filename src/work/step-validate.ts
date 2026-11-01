import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Outcome, StepContext } from "../engine.js";
import { runningBuild } from "../log.js";
import { type SelectedMember, validationMembers } from "../media.js";
import { packageBootstrap } from "../planning/facts.js";
import {
  ACCEPTED_AT,
  acceptedInputs,
  checkedAtFinal,
  currentPlan,
} from "../planning/plan.js";
import type { Plan, WorkItem } from "../planning/types.js";
import { FAILURE_CHARS, type FailureIdentity } from "../repair.js";
import { type MutationPass, mutationPass } from "../review/mutants.js";
import type { ObjectiveBlock } from "../shown.js";
import type { ObjectiveState } from "../state.js";
import { failureExcerpt } from "../text.js";
import {
  formatRef,
  laterScriptChanges,
  lockfileRef,
  type Validation,
  validateTree,
} from "../validate.js";
import {
  addWorktree,
  clearStaleLocks,
  hostGit,
  hostGitExit,
  installStorePath,
  isAncestor,
  sharedInstallStorePath,
  worktreePath,
} from "../worktree.js";
import { factoryCommit, VALIDATE_STEP_LOG } from "./collect.js";
import { fact, facts, type KeptValidation } from "./facts.js";
import type { MergeResult } from "./merged.js";
import { withRepros } from "./repros.js";
import { boundedValidateLog, failedCommandLog } from "./self-validate.js";
import { integrated, objectiveMerges } from "./shared.js";
import { repairOutcome } from "./step-deliver.js";
import { qaValidateStep } from "./step-qa.js";
import {
  type BuildDeps,
  candidate,
  commandTimeoutMs,
  KEPT_OUTPUT_CHARS,
  type PublishResult,
  type StackPlace,
  selection,
  stepKey,
  type ValidateResult,
  type WorkResult,
} from "./steps.js";

// ---------------------------------------------------------------------------
// validate

export async function validateStep(
  item: WorkItem,
  context: StepContext,
  deps: BuildDeps,
  place: StackPlace | undefined,
): Promise<Outcome> {
  if (item.kind === "qa") return qaValidateStep(item, context, deps);
  const { state, signal } = context;
  const { config } = deps;
  const plan = currentPlan(state)!;
  const work = state.done[stepKey(item.id, "work")] as WorkResult;
  const workDir = deps.workDir(state.issue);
  const worktree = worktreePath(workDir, state.issue, item.id);
  await addWorktree(config.checkout, worktree, work.base, signal, context.log);
  const commit = candidate(state, item.id);
  const blocks = acceptedInputs(state).shown.blocks;
  const media = validationMembers(plan, item, selection(state));
  // Its confirmed refusals' repro commands run after its own (repros.ts).
  const checked = withRepros(state, item);
  // The Objective's merges since this item started, which its candidate
  // doesn't hold: its commands run again on top of them (#2240). A native
  // stack's layer builds on the layer below and merges with its unit.
  const earlier = place
    ? []
    : await mergesMissing(state, plan, item.id, commit, deps, signal);
  const key = validationKey({
    commit,
    plan: state.kept[ACCEPTED_AT] ?? null,
    validation: checked.validation,
    mutation: config.review,
    blocks,
    base: work.base,
    planBase: plan.base,
    reviewArtifacts: {
      configured: config.reviewArtifacts,
      planned: plan.reviewArtifacts ?? null,
    },
    media,
    formatCommand: config.validation.formatCommand ?? null,
    sandbox: config.sandbox,
    commandTimeoutMs: commandTimeoutMs(deps),
    integrated: earlier.map((entry) => entry.merged.mergeSha),
  });
  const kept = fact(state, "validation", item.id);
  if (kept?.commit === commit && kept.key === key)
    return reusedValidation(item, context, place, kept, plan);
  // A run that ends without a result leaves no kept one behind it.
  context.keep(facts({ validation: null }, item.id));
  let mutation: MutationPass | undefined;
  const result = await validateTree({
    checkout: config.checkout,
    repository: config.repository,
    directory: `${worktree}.validation`,
    // The worker's Validate keeps the same stores (self-validate.ts).
    installStore: installStorePath(worktree),
    sharedInstallStore: sharedInstallStorePath(workDir),
    commit,
    item: checked,
    plan,
    blocks,
    base: work.base,
    ...(work.base !== plan.base ? { predecessor: work.base } : {}),
    reviewArtifacts: {
      configured: config.reviewArtifacts,
      planned: plan.reviewArtifacts,
      dir: join(workDir, "artifacts", item.id),
    },
    media,
    // A dependency change's lockfile, which Factory resolves when the
    // worker couldn't, is committed on the candidate (validate.ts).
    lockfile: {
      ref: lockfileRef(state.issue, item.id),
      author: () => deps.github.commitAuthor(signal),
    },
    // The repository's formatter, which Factory applies so no model
    // formats by hand: its output is committed on the candidate too.
    ...(config.validation.formatCommand
      ? {
          format: {
            command: config.validation.formatCommand,
            ref: formatRef(state.issue, item.id),
            author: () => deps.github.commitAuthor(signal),
          },
        }
      : {}),
    sandbox: config.sandbox,
    commandTimeoutMs: commandTimeoutMs(deps),
    signal,
    log: context.log,
    runFile: context.runFile,
    // The mutation pass, on the passed result in its checkout.
    use: async (validated) => {
      mutation = await mutationPass({
        checkout: validated,
        repo: validated.directory,
        base: work.base,
        commit: "HEAD",
        commands: ownCommands(item),
        limits: {
          max: config.review.mutants,
          ms: config.review.mutationSeconds * 1000,
        },
        seed: item.id,
        signal,
        log: context.log,
      });
    },
  });
  switch (result.kind) {
    case "passed": {
      const done: ValidateResult = {
        tree: result.tree,
        commands: result.commands,
        ...(result.artifacts ? { artifacts: result.artifacts } : {}),
        ...(result.regenerated ? { regenerated: result.regenerated } : {}),
        ...(result.formatted ? { formatted: result.formatted } : {}),
        ...(mutation ? { mutation } : {}),
      };
      const integrated = earlier.length
        ? await integratedValidation({
            item,
            context,
            deps,
            plan,
            work,
            commit: validatedCommit(done, commit),
            earlier,
            directory: `${worktree}.validation`,
            installStore: installStorePath(worktree),
            sharedInstallStore: sharedInstallStorePath(workDir),
            blocks,
            media,
          })
        : undefined;
      if (integrated?.kind === "failed") {
        const failed = {
          ...(await keptFailure(
            integrated.result,
            join(workDir, "outputs", item.id),
            integrated.lead,
          )),
          integrated: true as const,
        };
        return failedOutcome(
          item,
          context.state,
          place,
          failed,
          keptValidation(item.id, commit, key, failed),
        );
      }
      if (integrated) return integrated;
      return {
        kind: "done",
        result: done,
        keep: {
          ...keptValidation(item.id, commit, key, { kind: "passed", done }),
          ...(place
            ? {}
            : validatedOn(state, plan, item.id, validatedCommit(done, commit))),
        },
      };
    }
    case "failed": {
      // The worker's own Validate passed this exact tree with these
      // commands: run once more before calling it the result's fault.
      const rerun =
        passedByWorker(work.validated, result) &&
        rerunOnce(
          result,
          fact(state, "flaky", item.id),
          "failed on a tree the worker's own validation passed",
          (flaky) => facts({ flaky }, item.id),
        );
      if (rerun) return rerun;
      const failed = await keptFailure(
        result,
        join(workDir, "outputs", item.id),
      );
      return failedOutcome(
        item,
        context.state,
        place,
        failed,
        keptValidation(item.id, commit, key, failed),
      );
    }
    default:
      return result;
  }
}

/**
 * The item's own commands a mutant runs: its validation without the
 * exact install it may start with, which the checkout ran already.
 */
function ownCommands(item: WorkItem): string[] {
  const commands = item.validation.map((check) => check.command);
  return commands.length && packageBootstrap(commands[0]!) !== undefined
    ? commands.slice(1)
    : commands;
}

/**
 * A failed validation as its repair keeps it. State is saved on every
 * step: it keeps a bounded finding, whose excerpt keeps the failure lines
 * wherever they are (#2201). Output longer than a repair's brief keeps
 * (repair.ts FAILURE_CHARS) is kept in a file under `dir`: the operator's,
 * the diagnosis can ask for it, and the next worker attempt reads a copy in
 * its checkout (step-work.ts). `result.output` bounds each stream and puts
 * stderr after stdout, so the file holds the command's attempt file, as
 * the worker's Validate log does (self-validate.ts `failedCommandLog`).
 * Named by its content, so the same failure again reads as the same
 * finding. `lead`, when given, starts the finding and what it shows: where
 * the commands ran, when that was not the candidate alone.
 */
export async function keptFailure(
  result: Extract<Validation, { kind: "failed" }>,
  dir: string,
  lead = "",
): Promise<KeptFailure> {
  let keptOutput = result.output;
  let outputFile: string | undefined;
  if (result.output.length > FAILURE_CHARS) {
    const log = boundedValidateLog(failedCommandLog(result, result.failed));
    outputFile = join(
      dir,
      `${createHash("sha256").update(log).digest("hex").slice(0, 16)}.txt`,
    );
    await mkdir(dirname(outputFile), { recursive: true, mode: 0o700 });
    await writeFile(outputFile, log, { mode: 0o600 });
    keptOutput = `${result.output.length > KEPT_OUTPUT_CHARS ? failureExcerpt(result.output, KEPT_OUTPUT_CHARS) : result.output}\n[The complete output is kept for the operator at ${outputFile}. The repair diagnosis can ask for it as ${VALIDATE_STEP_LOG}, and the next worker attempt reads it there in its checkout.]`;
  }
  const exit = result.failed?.exit ?? result.formatter?.exit;
  return {
    kind: "failed",
    detail: `${lead}${keptOutput}`,
    shown: `${lead}${result.detail}`,
    ...(result.failed ? { command: result.failed.command } : {}),
    ...(result.formatter ? { formatter: result.formatter.command } : {}),
    ...(exit !== undefined ? { exit } : {}),
    ...(outputFile ? { output: outputFile } : {}),
  };
}

/** A validation failure as the item's `validation` fact keeps it. */
type KeptFailure = Extract<KeptValidation["result"], { kind: "failed" }>;

/**
 * The Objective's merges, other than item `id`'s own, that `commit` doesn't
 * hold: they merged after the item started, so its candidate was built
 * without them, in merge order (#2240).
 */
async function mergesMissing(
  state: ObjectiveState,
  plan: Plan,
  id: string,
  commit: string,
  deps: BuildDeps,
  signal: AbortSignal,
): Promise<{ id: string; merged: MergeResult }[]> {
  const missing: { id: string; merged: MergeResult }[] = [];
  for (const entry of objectiveMerges(state, plan))
    if (
      entry.id !== id &&
      !(await isAncestor(
        deps.config.checkout,
        entry.merged.mergeSha,
        commit,
        signal,
      ))
    )
      missing.push(entry);
  return missing;
}

/** The ref that pins an item's integrated validation commit; report and cancel cleanup delete it. */
export function integratedRef(issue: number, itemId: string): string {
  return `refs/factory/${issue}/${itemId}/integrated`;
}

/** What the integrated validation of a candidate came to, when it ran. */
type Integrated =
  | {
      kind: "failed";
      result: Extract<Validation, { kind: "failed" }>;
      /** Where the commands ran, as the finding starts. */
      lead: string;
    }
  | Extract<Outcome, { kind: "retry" | "hold" }>;

/**
 * The candidate's commands on the default branch as it will merge there
 * (#2240): an item that started before other Work Items of this Objective
 * merged was validated without their change, and each item then used, say,
 * a base-relative budget's whole allowance, which their sum exceeds once
 * final validation runs on the default branch. So once the candidate's own
 * validation passed, Factory merges the validated commit into the
 * Objective's integrated head (shared.ts `integrated`: the latest merge,
 * which holds every earlier one) as a commit of its own, pinned at
 * `integratedRef` until cleanup and never published, and runs there the
 * item's commands final validation will run itself (planning/plan.ts
 * `checkedAtFinal`), as it will, the plan's base as FACTORY_BASE_SHA. It
 * leaves out the others: one that names its base (it checks only this
 * item's change), any but a final command when the plan has those (final
 * validation never runs it, and with the plan's base it would count other
 * Objectives' merges), and one whose package script an earlier merge
 * changed. A command that fails by itself
 * there is the item's to repair, before it merges: the work step moves it
 * onto the current default branch (`rebase`), so the worker sees the
 * Objective's change so far. A merge that conflicts is left to the merge
 * step, which repairs the conflict; a failure no command made (a pin, the
 * mutation check) is final validation's to judge. Undefined when nothing
 * ran or it passed.
 */
async function integratedValidation(input: {
  item: WorkItem;
  context: StepContext;
  deps: BuildDeps;
  plan: Plan;
  work: WorkResult;
  /** The commit the candidate's own validation passed: Factory's last commit on it, if any. */
  commit: string;
  earlier: { id: string; merged: MergeResult }[];
  directory: string;
  installStore: string;
  sharedInstallStore: string;
  blocks: readonly ObjectiveBlock[];
  media: readonly SelectedMember[];
}): Promise<Integrated | undefined> {
  const { item, context, deps, plan, work, earlier } = input;
  const { state, signal } = context;
  const { checkout } = deps.config;
  const onto = integrated(state, plan);
  const ids = [...new Set(earlier.map((entry) => entry.id))];
  const tree = await hostGitExit(
    checkout,
    ["merge-tree", "--write-tree", "--no-messages", onto, input.commit],
    { signal },
  );
  if (tree.code !== 0) {
    context.log({
      event: "integrated-validation-skipped",
      item: item.id,
      onto,
      reason:
        tree.code === 1
          ? "the candidate conflicts with the Objective's earlier merges; the merge step repairs that"
          : `git merge-tree failed: ${tree.stderr.slice(0, 300)}`,
    });
    return undefined;
  }
  const predecessor = work.base !== plan.base ? work.base : undefined;
  const merged = (
    await hostGit(
      checkout,
      [
        ...factoryCommit(undefined).config,
        "commit-tree",
        tree.stdout.toString("utf8").split("\n")[0]!,
        "-p",
        onto,
        "-p",
        input.commit,
        "-m",
        `Factory: validate Work Item ${item.id} on the Objective's merges`,
      ],
      { signal },
    )
  )
    .toString("utf8")
    .trim();
  await clearStaleLocks(checkout, { signal, log: context.log });
  await hostGit(
    checkout,
    ["update-ref", integratedRef(state.issue, item.id), merged],
    { signal },
  );
  const atFinal = checkedAtFinal(plan);
  const own = item.validation.filter((check) => atFinal(check.command));
  const changed = await laterScriptChanges({
    checkout,
    base: plan.base,
    ...(predecessor ? { predecessor } : {}),
    head: merged,
    commands: own.map((check) => check.command),
    merges: earlier.map(({ id, merged }) => ({
      items: merged.items ?? [id],
      mergeSha: merged.mergeSha,
    })),
    signal,
  });
  const kept = own.filter(
    (check) => !changed.some((entry) => entry.command === check.command),
  );
  // A command left out shifts the indices `after` names: declared order.
  const validation =
    kept.length < item.validation.length
      ? kept.map(({ command }) => ({ command }))
      : kept;
  context.log({
    event: "integrated-validation",
    item: item.id,
    onto,
    commit: merged,
    merged: ids,
    commands: validation.map((check) => check.command),
    ...(changed.length && { skipped: changed }),
  });
  if (!validation.length) return undefined;
  const result = await validateTree({
    checkout,
    repository: deps.config.repository,
    directory: input.directory,
    installStore: input.installStore,
    sharedInstallStore: input.sharedInstallStore,
    commit: merged,
    item: { ...item, validation },
    plan,
    blocks: input.blocks,
    ...(predecessor ? { predecessor } : {}),
    media: input.media,
    sandbox: deps.config.sandbox,
    commandTimeoutMs: commandTimeoutMs(deps),
    signal,
    log: context.log,
    runFile: (kind) => context.runFile(`integrated-${kind}`),
  });
  if (result.kind === "passed") return undefined;
  if (result.kind !== "failed") return result;
  if (result.failed?.exit === undefined) {
    context.log({
      event: "integrated-validation-skipped",
      item: item.id,
      onto,
      reason: `no command failed by itself: ${result.detail.slice(0, 300)}`,
    });
    return undefined;
  }
  return {
    kind: "failed",
    result,
    lead: `Validated on the default branch with this Objective's merges since Work Item ${item.id} started (Work Item${ids.length === 1 ? "" : "s"} ${ids.join(", ")}; Factory's merge ${merged.slice(0, 12)} of ${onto.slice(0, 12)} and the candidate), as final validation will run it, with FACTORY_BASE_SHA the plan's base ${plan.base.slice(0, 12)}. A check that compares with the base counts the Objective's whole change there, so this result must fit what the earlier merges left. Factory moves the item onto the current default branch for this repair.\n\n`,
  };
}

/**
 * The digest of what a validation of the item's candidate runs under
 * (#2174): the candidate commit (so its tree and its base), the accepted
 * plan and the item's commands, everything else `validateTree` is given,
 * and the environment: Factory's build and this service process, so a
 * restart (after a change on the host, say) never reuses a result.
 */
export function validationKey(
  inputs: Record<string, unknown>,
  environment: Record<string, unknown> = serviceEnvironment(),
): string {
  return createHash("sha256")
    .update(JSON.stringify({ ...inputs, environment }))
    .digest("hex");
}

/** This service process, for `validationKey`: its pid and when it started. */
const SERVICE_PROCESS = `${process.pid}@${new Date(Date.now() - process.uptime() * 1000).toISOString()}`;

/** The environment `validationKey` takes by default: Factory's build and this process. */
function serviceEnvironment(): Record<string, unknown> {
  const { factoryVersion, sourceDigest } = runningBuild();
  return { factoryVersion, sourceDigest, process: SERVICE_PROCESS };
}

/** The item's `validation` fact: the latest validation's result, under `key`. */
function keptValidation(
  id: string,
  commit: string,
  key: string,
  result: KeptValidation["result"],
): Record<string, unknown> {
  return facts(
    {
      validation: { commit, key, at: new Date().toISOString(), result },
    },
    id,
  );
}

/**
 * A failed validation's identity (repair.ts `FailureIdentity`): the failed
 * command, or the repository's formatter that failed by itself, with how it
 * ended. A pin, the formatter's refused change or the mutation check has
 * none, and neither has a result kept before 0.5.10.
 */
export function validationIdentity(
  failed: Extract<KeptValidation["result"], { kind: "failed" }>,
): FailureIdentity | undefined {
  if (failed.command !== undefined)
    return {
      kind: "validation",
      command: failed.command,
      ...(failed.exit !== undefined && { exit: failed.exit }),
    };
  if (failed.formatter !== undefined && failed.exit !== undefined)
    return { kind: "format", command: failed.formatter, exit: failed.exit };
  return undefined;
}

/**
 * A validation failure as the work step's repair, with its identity
 * (`validationIdentity`). One on the Objective's merges (`integrated`)
 * moves the item onto the current default branch, which holds them.
 */
function failedOutcome(
  item: WorkItem,
  state: ObjectiveState,
  place: StackPlace | undefined,
  failed: KeptFailure,
  keep: Record<string, unknown> = {},
): Outcome {
  const identity = validationIdentity(failed);
  return repairOutcome(
    item,
    "validate",
    {
      kind: "failure",
      detail: failed.detail,
      ...(failed.output ? { output: failed.output } : {}),
      ...(identity && { identity }),
    },
    state,
    place,
    {
      ...(failed.shown !== undefined ? { shown: failed.shown } : {}),
      keep: {
        ...failedCommandKept(state, item.id, failed.command),
        ...(failed.integrated ? facts({ rebase: true }, item.id) : {}),
        ...keep,
      },
    },
  );
}

/**
 * The item's candidate is the commit its latest validation ran on, under
 * the same plan, commands, configuration and environment (`validationKey`):
 * a question answered with no new commit, such as Factory's own
 * `revalidate` after the worker resubmitted its refused result unchanged.
 * That validation's result stands again, with nothing run (#2174). The
 * operator's own `revalidate` drops the kept result (step-work.ts), so it
 * always runs the commands again.
 */
function reusedValidation(
  item: WorkItem,
  context: StepContext,
  place: StackPlace | undefined,
  kept: KeptValidation,
  plan: Plan,
): Outcome {
  context.log({
    event: "validation-reused",
    item: item.id,
    commit: kept.commit,
    validatedAt: kept.at,
    passed: kept.result.kind === "passed",
  });
  if (kept.result.kind !== "passed")
    return failedOutcome(item, context.state, place, kept.result);
  const { done } = kept.result;
  // The key names the merges the candidate lacked, so the same ones counted.
  return {
    kind: "done",
    result: done,
    ...(place
      ? {}
      : {
          keep: validatedOn(
            context.state,
            plan,
            item.id,
            validatedCommit(done, kept.commit),
          ),
        }),
  };
}

/** The commit a passed validation ran on: Factory's last commit on the candidate, if any. */
function validatedCommit(done: ValidateResult, candidate: string): string {
  return done.formatted?.commit ?? done.regenerated?.commit ?? candidate;
}

/**
 * The item's `validatedOn` fact: the Objective's merges of other Work
 * Items so far, which its validation of `commit` counted (#2240).
 */
function validatedOn(
  state: ObjectiveState,
  plan: Plan,
  id: string,
  commit: string,
): Record<string, unknown> {
  return facts(
    { validatedOn: { commit, merges: otherMerges(state, plan, id) } },
    id,
  );
}

/** The merge commits of the Objective's Work Items other than `id`, in merge order. */
function otherMerges(state: ObjectiveState, plan: Plan, id: string): string[] {
  return objectiveMerges(state, plan)
    .filter((entry) => entry.id !== id)
    .map((entry) => entry.merged.mergeSha);
}

/**
 * Whether Work Item `id`'s merge step validates its candidate again first
 * (`validateBeforeMerge`): another Work Item of the Objective merged that
 * its validation didn't count (`validatedOn`). That step then takes a CPU
 * slot and the time of the item's commands (steps.ts `itemStep`).
 */
export function unvalidatedMerges(
  state: ObjectiveState,
  plan: Plan,
  id: string,
): boolean {
  const kept = fact(state, "validatedOn", id);
  const counted =
    kept?.commit === candidate(state, id)
      ? new Set(kept.merges)
      : new Set<string>();
  return otherMerges(state, plan, id).some((sha) => !counted.has(sha));
}

/**
 * Before a Work Item outside a native stack merges (step-deliver.ts
 * `mergeStep`), its candidate is validated again on the Objective's merges
 * its validation didn't count (#2240). Items run side by side: each is
 * often validated before the other merges, so the one that merges second
 * was validated without the first's merge, and nothing else runs its
 * commands on it before final validation. So the merge step runs them
 * there first, as the validate step does (`integratedValidation`), and a
 * command that fails is the item's repair onto the current default branch,
 * before it merges. A PR already merged (the merge step resumed after
 * GitHub merged it) is past this. Undefined when the merge goes ahead: the
 * merges counted are kept (`validatedOn`), so the step's retries don't run
 * the commands again.
 */
export async function validateBeforeMerge(
  item: WorkItem,
  context: StepContext,
  deps: BuildDeps,
): Promise<Outcome | undefined> {
  const { state, signal } = context;
  const plan = currentPlan(state)!;
  if (!unvalidatedMerges(state, plan, item.id)) return undefined;
  const published = state.done[stepKey(item.id, "publish")] as PublishResult;
  if ((await deps.github.pull(published.pr, signal)).merged) return undefined;
  const commit = candidate(state, item.id);
  const work = state.done[stepKey(item.id, "work")] as WorkResult;
  const workDir = deps.workDir(state.issue);
  const worktree = worktreePath(workDir, state.issue, item.id);
  const earlier = await mergesMissing(
    state,
    plan,
    item.id,
    commit,
    deps,
    signal,
  );
  const integrated = earlier.length
    ? await integratedValidation({
        item,
        context,
        deps,
        plan,
        work,
        commit,
        earlier,
        directory: `${worktree}.validation`,
        installStore: installStorePath(worktree),
        sharedInstallStore: sharedInstallStorePath(workDir),
        blocks: acceptedInputs(state).shown.blocks,
        media: validationMembers(plan, item, selection(state)),
      })
    : undefined;
  if (integrated?.kind === "failed")
    return failedOutcome(item, state, undefined, {
      ...(await keptFailure(
        integrated.result,
        join(workDir, "outputs", item.id),
        integrated.lead,
      )),
      integrated: true,
    });
  if (integrated) return integrated;
  context.keep(validatedOn(state, plan, item.id, commit));
  return undefined;
}

/**
 * Whether the worker's own Validate passed the tree this failed validation
 * started from, with the same commands. The worker's Validate records its
 * snapshot's tree, before Factory's commits (the formatter's output, a
 * resolved lockfile), so the comparison is with the candidate's tree,
 * never the tree Factory's last commit made.
 */
export function passedByWorker(
  validated: WorkResult["validated"],
  result: { tree: string; candidateTree?: string; commands: readonly string[] },
): boolean {
  return (
    validated?.tree === (result.candidateTree ?? result.tree) &&
    JSON.stringify(validated.commands) === JSON.stringify(result.commands)
  );
}

/**
 * The item's `validationFailed` fact with `command` added: the commands
 * the validate step failed its results on under the plan accepted now,
 * which an amendment may replace (#2107). Nothing when no command failed
 * (a pin or the mutation check).
 */
export function failedCommandKept(
  state: ObjectiveState,
  itemId: string,
  command: string | undefined,
): Record<string, unknown> {
  if (command === undefined) return {};
  const plan = String(state.kept[ACCEPTED_AT] ?? "");
  const earlier = fact(state, "validationFailed", itemId);
  const commands = earlier?.plan === plan ? earlier.commands : [];
  return commands.includes(command)
    ? {}
    : facts(
        { validationFailed: { plan, commands: [...commands, command] } },
        itemId,
      );
}

/**
 * One more run of a failed command before the failure counts, once per
 * tree: a continuation that keeps the rerun (`keep`), or undefined when
 * no command failed or this tree has had its rerun.
 */
export function rerunOnce(
  result: { tree: string; failed?: { command: string } },
  earlier: { tree: string } | undefined,
  why: string,
  keep: (rerun: { tree: string; command: string }) => Record<string, unknown>,
): Outcome | undefined {
  if (!result.failed || earlier?.tree === result.tree) return undefined;
  const { command } = result.failed;
  return {
    kind: "retry",
    reason: `\`${command}\` ${why}; running it once more.`,
    progress: true,
    keep: keep({ tree: result.tree, command }),
  };
}
