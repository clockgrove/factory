import { ownsPath } from "./graph.js";
import type { Plan, WorkItem } from "./types.js";

/**
 * Scheduling for the build steps (work/steps.ts buildSteps): which runnable
 * item goes first (`rank`; the engine starts steps in emitted order, so
 * order is priority), which fresh starts a shared resource holds back
 * (`resourceGate`, a wait with no question), and which peer handoff notes a
 * worker and its result review get (`peerNotes`) and final review gets
 * (`objectiveNotes`), from accepted results only. Ported from the
 * old scheduler (src/scheduler.ts) and the old handoff note routing
 * (src/objective-knowledge.ts).
 *
 * Pure: no I/O and no throws. The steps own the state reads and pass a view.
 */

/** The state facts scheduling reads, by item id. */
export interface ScheduleView {
  /** Merged, or completed for an item that never merges (qa, aggregate). */
  settled(id: string): boolean;
  /**
   * Started and not settled: some step of the item is done or has an
   * attempt in `state.attempts`.
   */
  inFlight(id: string): boolean;
}

/**
 * Orders items to start: in-flight first (finish what holds a worktree and
 * resources), then qa and aggregate (cheap, they unblock final proof), then
 * priority descending, then remaining critical path descending, then plan
 * order. `items` defaults to the whole plan; settled items should be left out
 * by the caller.
 *
 * Critical path is the sum of `scheduling.estimatedDurationMs` along the
 * longest unsettled successor chain when every unsettled item has an
 * estimate; otherwise it is the number of remaining stages. One basis for
 * all items keeps the order transitive.
 */
export function rank(
  plan: Pick<Plan, "items">,
  view: ScheduleView,
  items: readonly WorkItem[] = plan.items,
): WorkItem[] {
  const path = criticalPath(plan, view);
  const position = new Map(plan.items.map((item, index) => [item.id, index]));
  const proof = (item: WorkItem) =>
    Number(item.kind === "qa" || item.kind === "aggregate");
  return [...items].sort(
    (a, b) =>
      Number(view.inFlight(b.id)) - Number(view.inFlight(a.id)) ||
      proof(b) - proof(a) ||
      (b.priority ?? 0) - (a.priority ?? 0) ||
      (path.get(b.id) ?? 0) - (path.get(a.id) ?? 0) ||
      (position.get(a.id) ?? 0) - (position.get(b.id) ?? 0),
  );
}

/** Remaining critical path per item, on one basis for the whole plan. */
function criticalPath(
  plan: Pick<Plan, "items">,
  view: Pick<ScheduleView, "settled">,
): Map<string, number> {
  const open = plan.items.filter((item) => !view.settled(item.id));
  const durations = open.every(
    (item) => item.scheduling?.estimatedDurationMs !== undefined,
  );
  const successors = new Map<string, WorkItem[]>();
  for (const item of open)
    for (const dependency of item.dependencies)
      successors.set(dependency, [...(successors.get(dependency) ?? []), item]);
  const values = new Map<string, number>();
  const visiting = new Set<string>();
  const visit = (item: WorkItem): number => {
    const known = values.get(item.id);
    if (known !== undefined) return known;
    // Checked plans are acyclic; a cycle counts as no further path.
    if (visiting.has(item.id) || view.settled(item.id)) return 0;
    visiting.add(item.id);
    const own = durations
      ? (item.scheduling?.estimatedDurationMs as number)
      : 1;
    const value =
      own + Math.max(0, ...(successors.get(item.id) ?? []).map(visit));
    visiting.delete(item.id);
    values.set(item.id, value);
    return value;
  };
  for (const item of plan.items) values.set(item.id, visit(item));
  return values;
}

/** A shared resource held by another item. */
export interface ResourceBlock {
  resource: string;
  /** The item holding it. */
  by: string;
}

/**
 * The first resource `item` declares that an in-flight item other than it
 * also declares. Ownership overlap is not checked here: plan checks keep
 * items that can run at once from owning the same paths.
 */
function resourceBlocked(
  plan: Pick<Plan, "items">,
  startedIds: Iterable<string>,
  item: WorkItem,
): ResourceBlock | undefined {
  const resources = item.resources ?? [];
  if (!resources.length) return undefined;
  const byId = new Map(plan.items.map((entry) => [entry.id, entry]));
  for (const id of startedIds) {
    if (id === item.id) continue;
    const held = byId.get(id)?.resources ?? [];
    const resource = resources.find((name) => held.includes(name));
    if (resource !== undefined) return { resource, by: id };
  }
  return undefined;
}

/**
 * Resource exclusion for one steps() call. `admit` lets an in-flight item
 * through, and lets a fresh start through only when no in-flight item and no
 * item already admitted in this call holds one of its resources; an admitted
 * fresh start then holds its resources for the rest of the call. So at most
 * one fresh start per resource name per call, and none while a holder runs.
 */
export function resourceGate(
  plan: Pick<Plan, "items">,
  inFlightIds: Iterable<string>,
): { admit(item: WorkItem): ResourceBlock | undefined } {
  const holders = [...inFlightIds];
  const inFlight = new Set(holders);
  return {
    admit(item) {
      if (inFlight.has(item.id)) return undefined;
      const block = resourceBlocked(plan, holders, item);
      if (block) return block;
      if (item.resources?.length) holders.push(item.id);
      inFlight.add(item.id);
      return undefined;
    },
  };
}

/** The fields of a handoff note that routing reads (work/collect.ts HandoffNote). */
export interface RoutedNote {
  kind: string;
  paths: string[];
  consumers: string[];
}

/**
 * Peer handoff notes for `item`'s worker, in plan order of their producers.
 * A note is routed when its producer is a transitive dependency of the item,
 * when its consumers name the item, or when one of its paths is in the
 * item's ownedPaths. Verification and design notes index their own item's
 * review, so they never go to other workers. The item's own notes are left
 * out (repair context carries them).
 */
export function peerNotes<Note extends RoutedNote>(
  plan: Pick<Plan, "items">,
  notesByItem: ReadonlyMap<string, readonly Note[]>,
  item: WorkItem,
): (Note & { from: string })[] {
  const ancestors = dependencyClosure(plan, item);
  const routed: (Note & { from: string })[] = [];
  for (const producer of plan.items) {
    if (producer.id === item.id) continue;
    for (const note of notesByItem.get(producer.id) ?? []) {
      if (note.kind === "verification" || note.kind === "design") continue;
      if (
        ancestors.has(producer.id) ||
        note.consumers.includes(item.id) ||
        note.paths.some((path) => ownsPath(path, item.ownedPaths))
      )
        routed.push({ ...note, from: producer.id });
    }
  }
  return routed;
}

/**
 * Every item's notes, verification and design notes included, in plan order
 * of their producers: the Objective-wide set final review reads (as the old
 * objective-review knowledge view).
 */
export function objectiveNotes<Note extends RoutedNote>(
  plan: Pick<Plan, "items">,
  notesByItem: ReadonlyMap<string, readonly Note[]>,
): (Note & { from: string })[] {
  return plan.items.flatMap((producer) =>
    (notesByItem.get(producer.id) ?? []).map((note) => ({
      ...note,
      from: producer.id,
    })),
  );
}

/** Every item `item` depends on, directly or transitively. */
function dependencyClosure(
  plan: Pick<Plan, "items">,
  item: WorkItem,
): Set<string> {
  const byId = new Map(plan.items.map((entry) => [entry.id, entry]));
  const seen = new Set<string>();
  const pending = [...item.dependencies];
  for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
    if (seen.has(id)) continue;
    seen.add(id);
    pending.push(...(byId.get(id)?.dependencies ?? []));
  }
  return seen;
}
