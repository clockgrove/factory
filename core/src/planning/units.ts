import type { Plan, WorkItem } from "./types.js";

/**
 * Delivery units for native-stack delivery: the plan split into linear
 * chains. Each chain is delivered as chained PRs (layer i's base is layer
 * i-1's branch) and merged as one native stack on its top item. A unit of
 * one item is an ordinary PR, so a plan with no chains delivers exactly like
 * regular delivery.
 *
 * Pure: no I/O, and a malformed plan is a problem, never a throw; checked
 * plans never produce one. work/steps.ts runs the layers: a layer above the
 * bottom starts from the delivered head of the layer below, and only the
 * top layer has a merge step, which merges the whole stack.
 */
export interface DeliveryUnit {
  /** Bottom first; each item's only dependency is the one before it. */
  items: WorkItem[];
  /** Dependencies outside the unit, which must merge before it starts. */
  externalDependencies: string[];
}

export type Units = { units: DeliveryUnit[] } | { problem: string };

/** A fork ends its parent's chain; a join starts a new chain. */
export function units(plan: Pick<Plan, "items" | "coverage">): Units {
  const byId = new Map(plan.items.map((item) => [item.id, item]));
  for (const item of plan.items)
    for (const dependency of item.dependencies)
      if (!byId.has(dependency))
        return {
          problem: `Work Item ${item.id} depends on ${dependency}, which is not in the plan`,
        };
  const ordered: WorkItem[] = [];
  const remaining = new Set(plan.items.map((item) => item.id));
  while (remaining.size) {
    const next = plan.items.find(
      (item) =>
        remaining.has(item.id) &&
        item.dependencies.every((dependency) => !remaining.has(dependency)),
    );
    if (!next)
      return {
        problem: `The plan's dependencies form a cycle among: ${[...remaining].join(", ")}`,
      };
    ordered.push(next);
    remaining.delete(next.id);
  }
  const children = new Map<string, string[]>();
  for (const item of plan.items)
    for (const dependency of item.dependencies)
      children.set(dependency, [...(children.get(dependency) ?? []), item.id]);
  // Items that never join a chain, as a child or as a parent.
  const standalone = (item: WorkItem | undefined) =>
    item === undefined || item.kind === "qa" || item.kind === "aggregate";
  const continuation = new Map<string, string>();
  const childOf = new Set<string>();
  for (const item of plan.items) {
    if (standalone(item) || item.dependencies.length !== 1) continue;
    // Environment preparation must integrate before the consumer is admitted.
    if (
      plan.coverage.some(
        (entry) =>
          entry.itemId === item.id && entry.environment.readiness === "prepare",
      )
    )
      continue;
    const parent = item.dependencies[0] as string;
    if (standalone(byId.get(parent)) || children.get(parent)?.length !== 1)
      continue;
    continuation.set(parent, item.id);
    childOf.add(item.id);
  }
  const result: DeliveryUnit[] = [];
  for (const root of ordered) {
    if (childOf.has(root.id)) continue;
    const items: WorkItem[] = [];
    // Each item has at most one parent and one continuation, and the order
    // above is acyclic, so every chain ends.
    for (
      let current: string | undefined = root.id;
      current;
      current = continuation.get(current)
    )
      items.push(byId.get(current) as WorkItem);
    const own = new Set(items.map((item) => item.id));
    result.push({
      items,
      externalDependencies: [
        ...new Set(
          items.flatMap((item) =>
            item.dependencies.filter((dependency) => !own.has(dependency)),
          ),
        ),
      ],
    });
  }
  return { units: result };
}

/** The unit holding an item, and the item's layer (0 is the bottom). */
export function unitOf(
  all: readonly DeliveryUnit[],
  id: string,
): { unit: DeliveryUnit; layer: number } | undefined {
  for (const unit of all) {
    const layer = unit.items.findIndex((item) => item.id === id);
    if (layer >= 0) return { unit, layer };
  }
  return undefined;
}
