import {
  hold,
  type Offer,
  type Outcome,
  objectiveWide,
  type Step,
} from "../engine.js";
import type { GitHub, IssueSummary } from "../github.js";
import { prose } from "../markdown.js";
import { readShown, shownDigest } from "../shown.js";
import { findState, type ObjectiveState } from "../state.js";
import { fact, facts } from "../work/facts.js";
import { mergeOf } from "../work/merged.js";
import { hostGitExit, isAncestor } from "../worktree.js";
import { acceptedInputs, currentPlan } from "./plan.js";
import type { PlanningDeps } from "./steps.js";

/*
 * Objective dependencies through GitHub's native blocked-by links
 * (docs/reference/queue.md#Predecessors). The `predecessors` step runs before the check:
 * while a blocker is open, or its Objective isn't done, the Objective
 * waits with no question, and takes no slot. A blocker that ended without
 * being done holds; a dependency cycle holds, naming it. Once every
 * predecessor is done, their accepted results are the planner's and the
 * plan review's evidence, checked against the base planning reads
 * (`predecessorsOnBase`).
 */

export const PREDECESSORS = "predecessors";

const MINUTE = 60_000;
/** Issues read while looking for a cycle, per run of the step. */
const CYCLE_READS = 50;

/** What a done predecessor delivered, as its Factory record shows it. */
export interface PredecessorEvidence {
  issue: number;
  title: string;
  /** The default-branch commit its final validation and final review passed on, and that commit's tree. */
  commit: string;
  tree: string;
  /** Its final validation commands. */
  commands: string[];
  /** Its Work Items: the PR and merge commit of each delivered one. */
  items: { id: string; title: string; pr?: number; merged?: string }[];
}

/**
 * A predecessor the operator answered `ignore` to: the Objective proceeds
 * without it, through replans, while the blocked-by link and the
 * predecessor's issue state (`issueState`) are what they were.
 */
export interface IgnoredPredecessor {
  /** `#N` in this repository, `owner/repo#N` in another (`reference`). */
  ref: string;
  /** The blocker's issue state when ignored (`issueState`). */
  state: string;
  reason: string;
  by: string;
  at: string;
}

/** The step's result. */
export interface PredecessorsResult {
  predecessors: PredecessorEvidence[];
  ignored: IgnoredPredecessor[];
}

/** The predecessors' evidence once the step is done; empty without any. */
export function predecessorEvidence(
  state: ObjectiveState,
): PredecessorEvidence[] {
  return (
    (state.done[PREDECESSORS] as PredecessorsResult | undefined)
      ?.predecessors ?? []
  );
}

type Blocker = { ref: string } & (
  | { kind: "done"; evidence: PredecessorEvidence }
  | { kind: "waiting"; why: string }
  | { kind: "ended"; why: string }
);

/**
 * How a blocker is named and matched: `#N` in this repository, else
 * `owner/repo#N`, so an `ignore` of one never skips another repository's
 * issue with the same number.
 */
function reference(github: GitHub, blocker: IssueSummary): string {
  if (github.ownIssue(blocker)) return `#${blocker.number}`;
  const repository = /\/repos\/([^/]+\/[^/]+)$/.exec(
    blocker.repository_url ?? "",
  )?.[1];
  return `${repository ?? "another repository"}#${blocker.number}`;
}

/** A blocker's GitHub state: `open`, or `closed` with why it closed. */
function issueState(blocker: IssueSummary): string {
  return blocker.state === "open"
    ? "open"
    : `closed:${blocker.state_reason ?? ""}`;
}

/** The `ignore` option for a blocker: its arg is the number here, else `owner/repo#N`. */
function ignoreOffer(ref: string): Offer {
  return {
    answer: "ignore",
    arg: ref.startsWith("#") ? ref.slice(1) : ref,
    family: "accept",
    consequence: `Goes on without ${ref}; your reason is recorded.`,
    needsText: true,
  };
}

/** The `predecessors` step (workflow.ts): wait, hold or record the evidence. */
export function predecessorsStep(deps: PlanningDeps): Step {
  return {
    key: PREDECESSORS,
    resource: "github",
    deadlineMs: 10 * MINUTE,
    run: async ({ state, answer, signal }): Promise<Outcome> => {
      const { github } = deps;
      const all = await github.blockedBy(state.issue, signal);
      // An ignore stands while its link and the predecessor's state are
      // unchanged, across replans; else the question is asked again.
      let ignored = (fact(state, "predecessors:ignored") ?? []).filter(
        (entry) =>
          all.some(
            (blocker) =>
              reference(github, blocker) === entry.ref &&
              issueState(blocker) === entry.state,
          ),
      );
      const arg = answer?.answer === "ignore" ? answer.arg : undefined;
      const ignoring = arg?.includes("#") ? arg : arg && `#${arg}`;
      const answered = all.find(
        (blocker) => reference(github, blocker) === ignoring,
      );
      if (answered && !ignored.some((entry) => entry.ref === ignoring))
        ignored = [
          ...ignored,
          {
            ref: ignoring!,
            state: issueState(answered),
            reason: (answer!.text ?? "").trim(),
            by: answer!.by,
            at: answer!.at,
          },
        ];
      const keep = facts({
        "predecessors:ignored": ignored.length ? ignored : null,
      });
      const skip = new Set(ignored.map((entry) => entry.ref));
      const linked = all.filter(
        (blocker) => !skip.has(reference(github, blocker)),
      );
      const blockers: Blocker[] = [];
      for (const blocker of linked.sort((a, b) => a.number - b.number))
        blockers.push(await classify(deps, blocker, signal));
      const ended = blockers.filter((b) => b.kind === "ended");
      if (ended.length)
        return {
          ...objectiveWide(
            hold(
              `Objective #${state.issue} is blocked by ${ended.length === 1 ? "an issue that ended" : "issues that ended"} without delivering:\n\n${ended.map((b) => `- ${b.ref}: ${b.why}`).join("\n")}\n\n\`replan\` reads the issue and its blocked-by links again once you have edited them; \`ignore <n> <reason>\` (\`owner/repo#n\` for another repository's issue) goes on without that predecessor; or cancel.`,
              [
                {
                  answer: "replan",
                  family: "replan",
                  consequence:
                    "Reads the issue's blocked-by links again (edit them first) and plans once its predecessors are done.",
                },
                ...ended.map((b) => ignoreOffer(b.ref)),
                "cancel",
              ],
            ),
          ),
          keep,
        };
      const waiting = blockers.filter((b) => b.kind === "waiting");
      if (waiting.length) {
        const cycle = await cycleThrough(github, state.issue, linked, signal);
        if (cycle)
          return {
            ...objectiveWide(
              hold(
                `Objective #${state.issue} is in a dependency cycle: ${cycle.map((n) => `#${n}`).join(" is blocked by ")}. No Objective in it can start. Remove one of these blocked-by links and answer \`retry\`, \`ignore ${cycle[1]} <reason>\` to go on without #${cycle[1]}, or cancel.`,
                ["retry", ignoreOffer(`#${cycle[1]}`), "cancel"],
              ),
            ),
            keep,
          };
        // A wait on another Objective has no deadline, like a human gate:
        // no question, no slot, and status shows what it waits on.
        const on = waiting.map((b) => `${b.ref} (${b.why})`).join(", ");
        return {
          kind: "retry",
          reason: `Waiting on predecessor${waiting.length === 1 ? "" : "s"} ${on}`,
          wait: {
            kind: "gate",
            gate: `predecessor${waiting.length === 1 ? "" : "s"} ${on}`,
          },
          keep,
        };
      }
      const result: PredecessorsResult = {
        predecessors: blockers.flatMap((b) =>
          b.kind === "done" ? [b.evidence] : [],
        ),
        ignored,
      };
      return { kind: "done", result, keep };
    },
  };
}

/**
 * Where one blocker stands: done (with its evidence), still to come, or
 * ended without delivering.
 */
async function classify(
  deps: PlanningDeps,
  blocker: IssueSummary,
  signal: AbortSignal,
): Promise<Blocker> {
  const issue = blocker.number;
  const ref = reference(deps.github, blocker);
  if (!deps.github.ownIssue(blocker))
    return blocker.state === "open"
      ? { ref, kind: "waiting", why: "open, in another repository" }
      : {
          ref,
          kind: "ended",
          why: "it is in another repository, so Factory has no accepted result for it",
        };
  if (blocker.state === "open") return { ref, kind: "waiting", why: "open" };
  if (blocker.state_reason && blocker.state_reason !== "completed")
    return {
      ref,
      kind: "ended",
      why: `closed as ${prose(blocker.state_reason.replace(/_/g, " "))}`,
    };
  const loaded = findState(deps.objectives, issue);
  if (loaded?.kind === "unreadable")
    return { ref, kind: "waiting", why: "its Factory state can't be read" };
  const previous = loaded?.state;
  if (!previous)
    return {
      ref,
      kind: "ended",
      why: "closed, but Factory never ran it here, so it has no accepted result",
    };
  if (previous.status === "cancelled")
    return { ref, kind: "ended", why: "its Objective was cancelled" };
  if (previous.status !== "done")
    return { ref, kind: "waiting", why: "its Objective isn't done" };
  const plan = currentPlan(previous);
  const final = previous.done.final as
    | { commit: string; tree: string; commands: string[] }
    | undefined;
  if (!plan || !final)
    return {
      ref,
      kind: "ended",
      why: "its Objective is done, but its record has no accepted result",
    };
  // What its issue shows now must be what Factory accepted.
  const accepted = acceptedInputs(previous);
  const rendered = await deps.github.renderedIssue(issue, signal);
  const digest =
    fact(previous, "objective:accepted") ?? shownDigest(accepted.shown);
  if (
    rendered.title !== accepted.title ||
    shownDigest(
      readShown(rendered.body_html, { sources: accepted.writer === true }),
    ) !== digest
  )
    return {
      ref,
      kind: "ended",
      why: "its issue was edited after Factory accepted its result",
    };
  return {
    ref,
    kind: "done",
    evidence: {
      issue,
      title: accepted.title,
      commit: final.commit,
      tree: final.tree,
      commands: final.commands,
      items: plan.items.map((item) => {
        const pr = (
          previous.done[`item:${item.id}:publish`] as
            | { pr?: number }
            | undefined
        )?.pr;
        const merged = mergeOf(previous, item.id)?.mergeSha;
        return {
          id: item.id,
          title: item.title,
          ...(pr !== undefined ? { pr } : {}),
          ...(merged ? { merged } : {}),
        };
      }),
    },
  };
}

/**
 * The shortest cycle of open blocked-by links through `self`, as the
 * issues along it from `self` back to `self`; undefined when none is found
 * within CYCLE_READS reads. A link it can't read is passed over: the wait
 * looks again on its next run.
 */
async function cycleThrough(
  github: GitHub,
  self: number,
  direct: readonly IssueSummary[],
  signal: AbortSignal,
): Promise<number[] | undefined> {
  const open = (issue: IssueSummary) =>
    issue.state === "open" && github.ownIssue(issue);
  const queue = direct.filter(open).map((issue) => [self, issue.number]);
  const seen = new Set([self]);
  let reads = 0;
  while (queue.length && reads < CYCLE_READS) {
    const path = queue.shift()!;
    const issue = path.at(-1)!;
    if (seen.has(issue)) continue;
    seen.add(issue);
    reads += 1;
    let next: IssueSummary[] = [];
    try {
      next = await github.blockedBy(issue, signal);
    } catch (error) {
      if (signal.aborted) throw error;
    }
    for (const blocker of next.filter(open)) {
      if (blocker.number === self) return [...path, self];
      if (!seen.has(blocker.number)) queue.push([...path, blocker.number]);
    }
  }
  return undefined;
}

/**
 * Why the predecessors' accepted results aren't on `base`, the default
 * branch commit planning reads; undefined when they are. Each accepted
 * commit must be in Git with the tree Factory accepted, and it and every
 * merge it delivered must be on `base`.
 */
export async function predecessorsOnBase(
  checkout: string,
  evidence: readonly PredecessorEvidence[],
  base: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  const at = base.slice(0, 12);
  for (const predecessor of evidence) {
    const name = `Predecessor #${predecessor.issue}`;
    const tree = await hostGitExit(
      checkout,
      ["rev-parse", "--verify", "--quiet", `${predecessor.commit}^{tree}`],
      { signal, timeoutMs: MINUTE },
    );
    if (tree.code !== 0)
      return `${name}'s accepted commit ${predecessor.commit.slice(0, 12)} isn't in Git`;
    if (tree.stdout.toString("utf8").trim() !== predecessor.tree)
      return `${name}'s accepted tree ${predecessor.tree.slice(0, 12)} isn't the tree Git has for its commit ${predecessor.commit.slice(0, 12)}`;
    for (const sha of [
      predecessor.commit,
      ...predecessor.items.flatMap((item) =>
        item.merged ? [item.merged] : [],
      ),
    ]) {
      const known = await hostGitExit(
        checkout,
        ["rev-parse", "--verify", "--quiet", `${sha}^{commit}`],
        { signal, timeoutMs: MINUTE },
      );
      if (known.code !== 0 || !(await isAncestor(checkout, sha, base, signal)))
        return `${name}'s merge ${sha.slice(0, 12)} isn't on the default branch at ${at}, the base planning reads`;
    }
  }
  return undefined;
}

/** A failed Git check of the predecessors (`predecessorsOnBase`), as a hold. */
export function predecessorsHold(problem: string): Outcome {
  return objectiveWide(
    hold(
      `${problem}. Factory plans only on a default branch that has its predecessors' accepted work. Fix the default branch and answer \`retry\`, or cancel.`,
    ),
  );
}
