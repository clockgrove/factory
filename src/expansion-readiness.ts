import type { WorkGraph } from "./contracts.js";

/** Only authenticated snapshot settlements may release an expansion barrier. */
export function expansionBlocksItem(
  graph: WorkGraph,
  itemId: string,
  resolvedExpansionIds?: ReadonlySet<string>,
): boolean {
  const unresolvedBarriers = new Set(
    (graph.expansions ?? [])
      .filter((envelope) => !resolvedExpansionIds?.has(envelope.id))
      .flatMap((envelope) => envelope.integrationBarrierItemIds),
  );
  if (!unresolvedBarriers.size) return false;
  const items = new Map(graph.items.map((item) => [item.id, item]));
  const visited = new Set<string>();
  const blocked = (id: string): boolean => {
    if (unresolvedBarriers.has(id)) return true;
    if (visited.has(id)) return false;
    visited.add(id);
    return items.get(id)?.dependencies.some(blocked) ?? false;
  };
  return blocked(itemId);
}

/** Empty settlements resolve inventory; they do not remove Objective proof. */
export function assertExpansionsSettled(
  graph: WorkGraph,
  resolvedExpansionIds: ReadonlySet<string>,
): void {
  const unresolved = (graph.expansions ?? [])
    .filter((envelope) => !resolvedExpansionIds.has(envelope.id))
    .map((envelope) => envelope.id);
  if (unresolved.length)
    throw new Error(
      `Objective expansion remains unresolved: ${unresolved.join(", ")}; integration and final acceptance must wait`,
    );
}
