import type { CandidateSet, MediaInput, Selection } from "../media.js";
import type { WorkDiscovery } from "../planning/amendments.js";
import type { IgnoredPredecessor } from "../planning/predecessors.js";
import type { Retirement } from "../planning/types.js";
import type { Session } from "../providers/session.js";
import type { Correction, RepairFinding } from "../repair.js";
import type { CriterionDecision, ResultReview } from "../review/result.js";
import type { ObjectiveState } from "../state.js";
import type { HandoffNote } from "./collect.js";
import type { RepairContext } from "./prompt.js";
import type { WorkerSpend } from "./worker.js";

/*
 * Facts that outlive retries, restarts and repairs (`state.kept`, written
 * through an outcome's `keep`). Every read and write goes through `fact`
 * and `facts`, which build the keys and type the values. A null value
 * deletes the fact (engine.ts `applyChange`).
 */

/** What each Work Item keeps, under `item:<id>:<name>`. */
export interface ItemFacts {
  /** The commit the item builds on, from its first work attempt on. */
  base: string;
  /** Move the kept worktree onto the current start and replay the change (a conflict, failed delivery, or the stack layer below repaired). */
  rebase: boolean;
  /** The head a merge check named for the stack layer below, to start on. */
  onto: string;
  finished: Finished;
  selection: KeptSelection;
  /**
   * The candidate sets the operator sent back with a select `repair`, as
   * Factory's copies under `<media>/sent-back/`: the attempts after it get
   * them read-only, since the answer ("other colours") is about them.
   * Capturing new sets clears it.
   */
  sentBack: CandidateSet[];
  /** The latest repair's finding, for the next attempt's repair context. */
  finding: RepairFinding;
  refused: Refused;
  /** The media inputs the worker last got, for review. */
  inputs: MediaInput[];
  /** A paid worker's spend so far. */
  spend: WorkerSpend;
  /**
   * The correction diagnosed for repair `repair`, and every finding
   * diagnosed so far; `answered`: the question whose operator answer it
   * carries, so that answer is applied once.
   */
  diagnosis: {
    repair: number;
    context: RepairContext;
    applied: string[];
    answered?: string;
  };
  /** A validation command run once more on a tree the worker's own Validate passed. */
  flaky: { tree: string; command: string };
  /** The result review that asked the operator, while its questions are answered. */
  held: ResultReview;
  /** The operator's `accept <n>` and `refuse <n>` at this item's reviews and refusals (planning/plan.ts `decisionsOf`). */
  decisions: CriterionDecision[];
  /** Every commit pushed to the item's branch, for lease pushes. */
  pushed: string[];
  /** The next publish opens a new PR. */
  republish: boolean;
  /** The secret finding's digest the publish question names. */
  secret: string;
  /** A read-only QA review refused the integrated result: its `retry` checks again from validation. */
  qaRefused: true;
  /**
   * Work attempt `attempt`'s in-scope `.factory-discovery.json`, kept
   * while its question is open: collection deletes the file.
   */
  discovered: { attempt: number; discovery: WorkDiscovery };
  /** The operator's `decline-discovery` of attempt `attempt`'s discovery. */
  declined: { attempt: number; reason: string; by: string; at: string };
  /**
   * Repair `repair`'s failure blamed on merged predecessor `predecessor`:
   * its `amend` answer proposes the follow-up work from this.
   */
  blamed: { repair: number; predecessor: string; correction: Correction };
  /** The worker's retained conversation, which a repair continues (providers/session.ts); `fresh` forgets it. */
  workSession: Session;
  /** The result reviewer's retained conversation, which a re-review continues. */
  reviewSession: Session;
}

/** What the Objective's own steps keep, by name. */
export interface ObjectiveFacts {
  /** The digest of the Objective text the build continues with (planning/steps.ts `OBJECTIVE_ACCEPTED`). */
  "objective:accepted": string;
  /** Final validation pushed missing LFS objects to origin again. */
  "final:repushed": true;
  /** The final review that asked the operator, while its questions are answered. */
  "final-review:held": ResultReview;
  /** The operator's `accept <n>` and `refuse <n>` at final review (planning/plan.ts `decisionsOf`). */
  "final-review:decisions": CriterionDecision[];
  /** Final review refused the integrated result: its `retry` validates again. */
  "final-review:refused": true;
  /** A final validation command run once more on the tree it failed on. */
  "final:flaky": { tree: string; command: string };
  /** The command final validation failed on, for `retire-command <n>`. */
  "final:failed": { index: number; command: string };
  /** The commands the operator retired from final validation (planning/plan.ts reads them). */
  "final:retired": Retirement[];
  /** The Objective runs again (work/steps.ts `RERUN`). */
  rerun: true;
  /** The re-run's cleanup reopened the issue (planning/steps.ts `REOPENED`). */
  "rerun:reopened": true;
  /** Predecessors the operator answered `ignore` to (planning/predecessors.ts). */
  "predecessors:ignored": IgnoredPredecessor[];
  /** The planner's retained conversation across plan revisions and amendments (providers/session.ts). */
  "session:planner": Session;
  /** The plan reviewer's retained conversation across review rounds and amendment reviews. */
  "session:graph-review": Session;
  /** The final reviewer's retained conversation across re-reviews. */
  "session:final-review": Session;
}

/** A finished worker run, kept until its result is collected, so a collection question doesn't run the worker again. */
export interface Finished {
  finalResponse: string;
  /** Factory's clean replay of the kept change, with no worker: its notes are that change's. */
  replayed?: true;
  validated?: { tree: string; commands: string[] };
  /** Captured once; absent until then. */
  sets?: CandidateSet[];
}

/**
 * An operator's selection kept across a repair that isn't about the media,
 * with the sets it was chosen from: the repaired attempt stages no media,
 * and the select step writes the same set on the new work commit.
 */
export interface KeptSelection {
  /** The choice; its commit and tree are the old work commit's, which a repair replaces. */
  selection: Omit<Selection, "commit" | "tree">;
  sets: CandidateSet[];
}

/**
 * The item's last work result a repair cleared, kept on every repair that
 * clears one. A rebase replays its change (`commit`, `notes` for a replay
 * without a worker). Unless `replayOnly`, the repair refused it: its commit
 * is the diagnosis's evidence, collection reads its tree on the same base
 * as no change, and `revalidate` checks it again with its notes.
 * `replayOnly`: a media repair, which may rightly end on the same tree, or
 * a stack layer moved because the layer below is repaired.
 */
export interface Refused {
  commit: string;
  tree: string;
  notes: HandoffNote[];
  replayOnly?: true;
  /** The work step found it can't be checked again as it is (gone, or off its base): `revalidate` isn't offered until a new repair. */
  unrecheckable?: true;
}

type Writes<F> = { [N in keyof F]?: F[N] | null };

const itemKey = (id: string, name: string) => `item:${id}:${name}`;

/** A kept fact of the Objective, or with `item`, of that Work Item. */
export function fact<N extends keyof ObjectiveFacts>(
  state: ObjectiveState,
  name: N,
): ObjectiveFacts[N] | undefined;
export function fact<N extends keyof ItemFacts>(
  state: ObjectiveState,
  name: N,
  item: string,
): ItemFacts[N] | undefined;
export function fact(
  state: ObjectiveState,
  name: string,
  item?: string,
): unknown {
  return state.kept[item === undefined ? name : itemKey(item, name)];
}

/** An outcome's `keep` for facts of the Objective, or with `item`, of that Work Item; null deletes one. */
export function facts(values: Writes<ObjectiveFacts>): Record<string, unknown>;
export function facts(
  values: Writes<ItemFacts>,
  item: string,
): Record<string, unknown>;
export function facts(
  values: Record<string, unknown>,
  item?: string,
): Record<string, unknown> {
  if (item === undefined) return { ...values };
  return Object.fromEntries(
    Object.entries(values).map(([name, value]) => [itemKey(item, name), value]),
  );
}

/** What a `keep` writes for a Work Item's fact: its value, null when it deletes it, else undefined. */
export function written<N extends keyof ItemFacts>(
  keep: Record<string, unknown>,
  name: N,
  item: string,
): ItemFacts[N] | null | undefined {
  return keep[itemKey(item, name)] as ItemFacts[N] | null | undefined;
}

/** The Work Items that keep fact `name`. */
export function itemsWith(
  state: ObjectiveState,
  name: keyof ItemFacts,
): string[] {
  const suffix = `:${name}`;
  return Object.entries(state.kept)
    .filter(
      ([key, value]) =>
        key.startsWith("item:") && key.endsWith(suffix) && value != null,
    )
    .map(([key]) => key.slice("item:".length, -suffix.length));
}
