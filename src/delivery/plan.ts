import type { WorkGraph, WorkItem } from "../contracts.js";

export interface DeliveryUnit {
  id: string;
  items: WorkItem[];
  externalDependencies: string[];
}

/** A fork ends its parent's chain; a join starts a new chain. */
export function linearDeliveryUnits(graph: WorkGraph): DeliveryUnit[] {
  const byId = new Map(graph.items.map((item) => [item.id, item]));
  const ordered: WorkItem[] = [];
  const remaining = new Set(graph.items.map((item) => item.id));
  while (remaining.size) {
    const next = graph.items.find(
      (item) =>
        remaining.has(item.id) &&
        item.dependencies.every((dependency) => !remaining.has(dependency)),
    );
    if (!next) throw new Error("Delivery graph contains a dependency cycle");
    ordered.push(next);
    remaining.delete(next.id);
  }
  const children = new Map<string, string[]>();
  for (const item of graph.items)
    for (const dependency of item.dependencies)
      children.set(dependency, [...(children.get(dependency) ?? []), item.id]);
  const continuation = new Map<string, string>();
  const childOf = new Set<string>();
  for (const item of graph.items) {
    if (item.kind === "qa" || item.dependencies.length !== 1) continue;
    // Environment preparation must integrate before the consumer is admitted.
    if (
      graph.coverage?.some(
        (entry) =>
          entry.itemId === item.id && entry.environment.readiness === "prepare",
      )
    )
      continue;
    const parent = item.dependencies[0]!;
    if (byId.get(parent)?.kind === "qa" || children.get(parent)?.length !== 1)
      continue;
    continuation.set(parent, item.id);
    childOf.add(item.id);
  }
  const units: DeliveryUnit[] = [];
  const assigned = new Set<string>();
  for (const root of ordered) {
    if (childOf.has(root.id) || assigned.has(root.id)) continue;
    const items: WorkItem[] = [];
    let current: string | undefined = root.id;
    while (current) {
      if (assigned.has(current))
        throw new Error("Delivery chain contains a cycle");
      const item = byId.get(current);
      if (!item) throw new Error(`Unknown delivery item ${current}`);
      items.push(item);
      assigned.add(current);
      current = continuation.get(current);
    }
    const own = new Set(items.map((item) => item.id));
    units.push({
      id: items[0]!.id,
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
  if (assigned.size !== graph.items.length)
    throw new Error("Delivery graph has unassigned Work Items");
  return units;
}
