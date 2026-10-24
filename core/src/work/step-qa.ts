import { join } from "node:path";
import { type NamedCheck, observeNamedCheck } from "../delivery.js";
import { hold, type Outcome, type Step, type StepContext } from "../engine.js";
import { defaultHead } from "../git.js";
import { validationMembers } from "../media.js";
import { acceptedInputs, currentPlan } from "../planning/plan.js";
import { peerNotes } from "../planning/schedule.js";
import type { WorkItem } from "../planning/types.js";
import { type ResultReview, reviewQa } from "../review/result.js";
import { validateTree } from "../validate.js";
import { worktreePath } from "../worktree.js";
import { fact, facts } from "./facts.js";
import { rereviewCapture, rereviewOf, rereviewRecord } from "./refused.js";
import {
  integrationProblem,
  objectiveMerges,
  pinnedSources,
} from "./shared.js";
import { delivery } from "./step-deliver.js";
import {
  criterionDecisions,
  deliveredHead,
  reviewOutcome,
} from "./step-review.js";
import { acceptedNotes, withKeep } from "./step-work.js";
import {
  type BuildDeps,
  commandTimeoutMs,
  MINUTE,
  REVALIDATE,
  selection,
  stepKey,
  type ValidateResult,
} from "./steps.js";

// ---------------------------------------------------------------------------
// read-only QA, aggregates and not-yet-ported kinds

/** A read-only QA item's validate result: the commit it checked and the named CI checks that passed. */
export interface QaResult extends ValidateResult {
  commit: string;
  checks: NamedCheck[];
}

/**
 * Read-only QA checks the integrated result and delivers nothing: its
 * named CI checks, then its commands in a fresh sandboxed checkout, on the
 * default-branch commit once every dependency has merged. An Objective
 * made only of QA checks the bytes it planned on. A failing check or
 * command refuses: the item holds with the evidence.
 */
export async function qaValidateStep(
  item: WorkItem,
  context: StepContext,
  deps: BuildDeps,
): Promise<Outcome> {
  const { state, signal } = context;
  const { config } = deps;
  const plan = currentPlan(state)!;
  const head = await defaultHead(config.checkout, config.repository, signal);
  const problem = await integrationProblem(state, plan, head, deps, signal);
  if (problem) return problem;
  const checks: NamedCheck[] = [];
  const observed = new Set<string>();
  for (const { itemId, proof } of plan.coverage) {
    if (
      itemId !== item.id ||
      (proof.kind !== "integrated-ci" && proof.kind !== "published-ci")
    )
      continue;
    // published-ci: the check on the target dependency's delivered head.
    let commit = head;
    if (proof.kind === "published-ci") {
      const delivered = deliveredHead(state, proof.targetItem);
      if (!delivered)
        return hold(
          `Read-only QA item ${item.id} proves check ${JSON.stringify(proof.checkName)} on Work Item ${proof.targetItem}'s published PR, and it has none. Answer replan, or cancel.`,
          ["replan", "cancel"],
        );
      commit = delivered;
    }
    if (observed.has(`${proof.checkName}\n${commit}`)) continue;
    observed.add(`${proof.checkName}\n${commit}`);
    const check = await observeNamedCheck(
      delivery(context, deps),
      proof.checkName,
      commit,
    );
    if (check.kind === "refused")
      return qaRefusal(item, head, "a named CI check failed", check.finding);
    if (check.kind !== "passed") return check;
    checks.push(check.check);
  }
  const workDir = deps.workDir(state.issue);
  const result = await validateTree({
    checkout: config.checkout,
    repository: config.repository,
    directory: `${worktreePath(workDir, state.issue, item.id)}.validation`,
    commit: head,
    item,
    plan,
    blocks: acceptedInputs(state).shown.blocks,
    ...(head !== plan.base ? { predecessor: head } : {}),
    reviewArtifacts: {
      configured: config.reviewArtifacts,
      planned: plan.reviewArtifacts,
      ...rereviewCapture(state, item.id, config.reviewArtifacts),
      dir: join(workDir, "artifacts", item.id),
    },
    media: validationMembers(plan, item, selection(state)),
    sandbox: config.sandbox,
    commandTimeoutMs: commandTimeoutMs(deps),
    signal,
    log: context.log,
  });
  switch (result.kind) {
    case "passed": {
      const done: QaResult = {
        commit: head,
        tree: result.tree,
        commands: result.commands,
        ...(result.artifacts ? { artifacts: result.artifacts } : {}),
        ...rereviewRecord(state, item.id),
        checks,
      };
      return { kind: "done", result: done };
    }
    case "failed":
      return qaRefusal(
        item,
        head,
        result.failed
          ? `\`${result.failed.command}\` failed`
          : "its validation was refused",
        result.detail,
      );
    default:
      return result;
  }
}

/**
 * The independent review of what QA validated: its acceptance and the
 * obligations its review proves, on that commit, over this Objective's
 * merges. A refusal holds; its `retry` checks again from validation, on
 * the default branch as it is then.
 */
export async function qaReviewStep(
  item: WorkItem,
  context: StepContext,
  deps: BuildDeps,
): Promise<Outcome> {
  const { state, signal } = context;
  const steps = [stepKey(item.id, "validate"), stepKey(item.id, "review")];
  const again = context.answer?.answer;
  // `retry` after the operator's fix, or `revalidate` (a result rereview,
  // charged when it landed): validation and review again, on the default
  // branch as it is now.
  if (
    (again === "retry" || again === REVALIDATE) &&
    fact(state, "qaRefused", item.id)
  )
    return {
      kind: "repair",
      finding:
        again === "retry"
          ? `Read-only QA item ${item.id} checks the default branch again after the operator's fix.`
          : `The operator asked to check read-only QA item ${item.id} again on the current default branch (a result rereview).`,
      target: steps[0]!,
      clear: steps,
      ...(again === REVALIDATE ? { rereview: true as const } : {}),
      keep: facts(
        { qaRefused: null, rereview: rereviewOf(context.answer) },
        item.id,
      ),
    };
  const plan = currentPlan(state)!;
  const checked = state.done[steps[0]!] as QaResult;
  const decided = criterionDecisions(
    context,
    fact(state, "held", item.id),
    item.id,
  );
  const merges = objectiveMerges(state, plan).map(
    (entry) => entry.merged.mergeSha,
  );
  const review = await reviewQa({
    planner: deps.planner,
    plan,
    item,
    checkout: deps.config.checkout,
    base: plan.base,
    commit: checked.commit,
    ...(merges.length ? { merges } : {}),
    validation: checked,
    checks: checked.checks,
    sources: await pinnedSources(state, deps, signal),
    dir: `${worktreePath(deps.workDir(state.issue), state.issue, item.id)}.review`,
    peerNotes: peerNotes(plan, acceptedNotes(state, plan), item),
    ...(checked.artifacts ? { artifacts: checked.artifacts } : {}),
    decisions: decided.decisions,
    ...(decided.earlier ? { earlier: decided.earlier } : {}),
    signal,
    log: context.log,
  });
  const held = (asked: ResultReview | null) => facts({ held: asked }, item.id);
  return withKeep(
    reviewOutcome(
      review,
      held,
      "and the QA item holds as refused",
      (refusal) => ({
        ...qaRefusal(
          item,
          checked.commit,
          "its review refused",
          refusal.refused
            .map((r) => `- ${r.criterion}: ${r.detail}`)
            .join("\n"),
        ),
        keep: { ...facts({ qaRefused: true }, item.id), ...held(null) },
      }),
    ),
    decided.keep,
  );
}

/** A QA refusal: no worker repairs it, so it holds with the evidence. */
export function qaRefusal(
  item: WorkItem,
  commit: string,
  what: string,
  evidence: string,
): Outcome {
  return hold(
    `Read-only QA item ${item.id} refused the integrated result at ${commit.slice(0, 12)}: ${what}.\n\n${evidence}\n\nAnswer \`replan\` to plan the fix, \`retry\` to check again once the default branch is fixed, or cancel.`,
    ["replan", "retry", "cancel"],
  );
}

/** The merge step of an item that delivers nothing (aggregate, QA): it settles. */
export function settleStep(item: WorkItem): Step {
  return {
    key: stepKey(item.id, "merge"),
    deadlineMs: MINUTE,
    async run(): Promise<Outcome> {
      return { kind: "done", result: { settled: item.kind } };
    },
  };
}

export function notYet(item: WorkItem, what: string): Step {
  return {
    key: stepKey(item.id, "work"),
    deadlineMs: MINUTE,
    async run(): Promise<Outcome> {
      return hold(
        `Work Item ${item.id} is one of the ${what}, which this Factory build can't run yet.`,
        ["cancel", "retry", "replan"],
      );
    },
  };
}
