import {
  hold,
  type Outcome,
  objectiveWide,
  type StepContext,
} from "../engine.js";
import { roleMemory } from "../knowledge/index.js";
import { BaseFiles, planningSources } from "../planning/facts.js";
import { baselineQa } from "../planning/graph.js";
import { acceptedInputs, currentPlan } from "../planning/plan.js";
import { OBJECTIVE_ACCEPTED } from "../planning/steps.js";
import type { Plan, WorkItem } from "../planning/types.js";
import { readShown, shownDigest } from "../shown.js";
import type { ObjectiveState } from "../state.js";
import { isAncestor } from "../worktree.js";
import { fact, facts } from "./facts.js";
import type { MergeResult } from "./merged.js";
import { type BuildDeps, stepKey } from "./steps.js";

// ---------------------------------------------------------------------------
// Shared

/**
 * The Objective was edited or closed after its plan was accepted: ask before
 * the next effect. `continue` keeps the plan and accepts the new text.
 */
export async function objectiveEdited(
  context: StepContext,
  deps: BuildDeps,
): Promise<Outcome | undefined> {
  const { state, signal } = context;
  const issue = await deps.github.renderedIssue(state.issue, signal);
  const planned = acceptedInputs(state);
  const digest = shownDigest(
    readShown(issue.body_html, { sources: planned.writer === true }),
  );
  const accepted =
    fact(state, OBJECTIVE_ACCEPTED) ?? shownDigest(planned.shown);
  if (context.answer?.answer === "continue")
    return digest === accepted
      ? undefined
      : {
          kind: "retry",
          reason: "Continuing with the edited Objective.",
          progress: true,
          keep: facts({ [OBJECTIVE_ACCEPTED]: digest }),
        };
  if (issue.state !== "open")
    return objectiveWide(
      hold(
        `Issue #${state.issue} was closed while Factory was building it. Reopen it and answer \`continue\`, or cancel.`,
        [
          "cancel",
          {
            answer: "continue",
            family: "accept",
            consequence: "Builds on, once the issue is reopened.",
          },
        ],
      ),
    );
  if (digest !== accepted)
    return objectiveWide(
      hold(
        `Objective #${state.issue} was edited after its plan was accepted. \`continue\` keeps building this plan; \`replan\` plans again from the new text.`,
        [
          "replan",
          {
            answer: "continue",
            family: "accept",
            consequence: "Keeps building this plan.",
          },
          "cancel",
        ],
      ),
    );
  return undefined;
}

/**
 * Why the default branch head can't be checked as this Objective's
 * integrated result: an Objective made only of read-only QA qualifies the
 * bytes it planned on, so the branch must not have moved; otherwise every
 * merge must still be on it.
 */
export async function integrationProblem(
  state: ObjectiveState,
  plan: Plan,
  head: string,
  deps: BuildDeps,
  signal: AbortSignal,
): Promise<Outcome | undefined> {
  if (baselineQa(plan.items))
    return head === plan.base
      ? undefined
      : hold(
          `This Objective is made only of read-only QA, which qualifies the bytes it was planned on (${plan.base.slice(0, 12)}), and the default branch has moved to ${head.slice(0, 12)}. Answer \`replan\` to plan again on the current default branch, \`retry\` once it is back at ${plan.base.slice(0, 12)}, or cancel.`,
          ["replan", "retry", "cancel"],
        );
  for (const { id, merged } of objectiveMerges(state, plan))
    if (
      !(await isAncestor(deps.config.checkout, merged.mergeSha, head, signal))
    )
      return hold(
        `Work Item ${id}'s merge \`${merged.mergeSha.slice(0, 12)}\` is not on the default branch (${head.slice(0, 12)}); someone may have reverted or force-pushed it. Restore it and answer \`retry\`, or \`replan\`.`,
        ["retry", "replan", "cancel"],
      );
  return undefined;
}

/** This Objective's merges, in merge order. */
export function objectiveMerges(
  state: ObjectiveState,
  plan: Plan,
): { id: string; merged: MergeResult }[] {
  return plan.items
    .map((item) => ({
      id: item.id,
      merged: state.done[stepKey(item.id, "merge")] as MergeResult | undefined,
    }))
    .filter(
      (entry): entry is { id: string; merged: MergeResult } =>
        !!entry.merged?.mergeSha,
    )
    .sort((a, b) => a.merged.at.localeCompare(b.merged.at));
}

/** The commit the next item builds on: the latest merge, else the plan base. */
export function integrated(state: ObjectiveState, plan: Plan): string {
  let latest: MergeResult | undefined;
  for (const [key, value] of Object.entries(state.done))
    if (key.endsWith(":merge") && (value as MergeResult).integratedSha)
      if (!latest || (value as MergeResult).at > latest.at)
        latest = value as MergeResult;
  return latest?.integratedSha ?? plan.base;
}

/**
 * Repository memory about one Work Item, for its worker, its diagnosis or
 * its result review: the worker and the review ask the same query, so the
 * review sees what the worker saw; the diagnosis searches by the failure
 * first.
 */
export function itemMemory(
  role: "work" | "diagnosis" | "result-review",
  item: WorkItem,
  context: StepContext,
  deps: BuildDeps,
  tree: string,
  supplied: readonly { path: string; heading?: string }[] = item.citations,
  lead: readonly string[] = [],
): Promise<string> {
  return roleMemory({
    role,
    state: context.state,
    checkout: deps.config.checkout,
    tree,
    paths: item.ownedPaths,
    text: [...lead, item.title, item.goal, ...item.acceptance].join("\n"),
    supplied,
    signal: context.signal,
    log: context.log,
  });
}

export async function pinnedSources(
  state: ObjectiveState,
  deps: BuildDeps,
  signal: AbortSignal,
) {
  const plan = currentPlan(state)!;
  const objective = acceptedInputs(state);
  const { sources } = await planningSources(
    objective.shown,
    new BaseFiles(deps.config.checkout, plan.base, signal),
    objective.child === true,
  );
  return sources;
}
