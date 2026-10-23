import type { CandidateSet, MediaInput, Selection } from "../media.js";
import type { RepairFinding } from "../repair.js";
import type { ObjectiveState } from "../state.js";
import type { HandoffNote } from "./collect.js";
import type { DiscoveryResult } from "./discovery.js";
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
  /** The criteria the result review asked the operator about. */
  questions: string[];
  /** Every commit pushed to the item's branch, for lease pushes. */
  pushed: string[];
  /** The next publish opens a new PR. */
  republish: boolean;
  /** The secret finding's digest the publish question names. */
  secret: string;
  /** A read-only QA review refused the integrated result: its `retry` checks again from validation. */
  qaRefused: true;
  /**
   * The operator's `revalidate --review-artifacts` for this result: the
   * configured selectors (numbers from 1; empty for none) its validation
   * captures instead of all. A repair clears it.
   */
  rereview: { reviewArtifacts: number[]; by: string; at: string };
  /** A discovery item's complete result (work/discovery.ts): its dependents, conditions and expansions read it. */
  discovery: DiscoveryResult;
}

/** What the Objective's own steps keep, by name. */
export interface ObjectiveFacts {
  /** The digest of the Objective text the build continues with (planning/steps.ts `OBJECTIVE_ACCEPTED`). */
  "objective:accepted": string;
  /** Final validation pushed missing LFS objects to origin again. */
  "final:repushed": true;
  /** The criteria final review asked the operator about. */
  "final-review:questions": string[];
  /** Final review refused the integrated result: its `retry` validates again. */
  "final-review:refused": true;
  /** The Objective runs again (work/steps.ts `RERUN`). */
  rerun: true;
  /** The re-run's cleanup reopened the issue (planning/steps.ts `REOPENED`). */
  "rerun:reopened": true;
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
  selection: Selection;
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
