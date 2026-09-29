import { pathsOverlap, validOwnershipPath } from "./ownership.js";
export { pathsOverlap } from "./ownership.js";
import type { WorkGraph, WorkItem } from "./contracts.js";
import { assertCoverageShape } from "./qa.js";
import type { WorkState } from "./state.js";

export function itemsConflict(left: WorkItem, right: WorkItem): boolean {
  return (
    left.ownedPaths.some((a) =>
      right.ownedPaths.some((b) => pathsOverlap(a, b)),
    ) ||
    (left.resources ?? []).some((name) =>
      (right.resources ?? []).includes(name),
    )
  );
}

/** Stable topological order: ties follow accepted graph order. */
export function validateAndOrderGraph(
  graph: WorkGraph,
  objective: number,
  baseSha: string,
  sources: Set<string>,
): WorkItem[] {
  if (
    graph.objective !== objective ||
    graph.baseSha !== baseSha ||
    !graph.items.length
  ) {
    throw new Error(
      "Compiled graph must target the exact Objective and base with at least one Work Item",
    );
  }
  assertCoverageShape(graph);
  const byId = new Map<string, WorkItem>();
  for (const item of graph.items) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(item.id) || byId.has(item.id))
      throw new Error(`Invalid or duplicate Work Item ID: ${item.id}`);
    for (const path of item.ownedPaths) {
      if (!validOwnershipPath(path))
        throw new Error(
          `Work Item ${item.id} has invalid ownership path ${JSON.stringify(path)}; use a literal repository-relative file or directory ending in /. Wildcards * and ? are unsupported; do not use globs or normalize paths.`,
        );
    }
    if (
      !item.title ||
      !item.goal ||
      !item.brief ||
      !item.acceptance.length ||
      !item.nonGoals?.length ||
      (!["qa", "aggregate"].includes(item.kind ?? "work") &&
        !item.ownedPaths.length) ||
      !item.citations.length ||
      !item.citations.every((citation) => sources.has(citation.path))
    ) {
      throw new Error(
        `Work Item ${item.id} lacks acceptance, non-goals, ownership, or source citations`,
      );
    }
    if (
      item.kind !== undefined &&
      !["qa", "work", "aggregate"].includes(item.kind)
    )
      throw new Error("Unknown Work Item kind");
    if (
      ["qa", "aggregate"].includes(item.kind ?? "work") &&
      (item.ownedPaths.length ||
        item.sourceAssets?.length ||
        item.expectedOutputRoles?.length ||
        item.executionProfile ||
        item.executionBinding)
    )
      throw new Error(
        "Read-only QA nodes cannot own changes, assets, or workers",
      );
    for (const check of item.validation) {
      if (
        !check.command ||
        !["base-observed", "source-declared"].includes(check.provenance) ||
        (check.provenance === "source-declared" &&
          !sources.has(check.source ?? ""))
      ) {
        throw new Error(
          `Work Item ${item.id} has invalid command provenance for ${JSON.stringify(check.command)} from ${JSON.stringify(check.source)}`,
        );
      }
    }
    if (item.priority !== undefined && !Number.isSafeInteger(item.priority))
      throw new Error(`Work Item ${item.id} has invalid priority`);
    byId.set(item.id, item);
  }
  const parents = new Set<string>();
  for (const item of graph.items) {
    const children = item.children ?? [];
    if (
      !Array.isArray(children) ||
      (item.kind === "aggregate" ? !children.length : children.length)
    )
      throw new Error("Only aggregate parents have required children");
    for (const child of children) {
      if (
        parents.has(child) ||
        !byId.has(child) ||
        child === item.id ||
        !item.dependencies.includes(child)
      )
        throw new Error(
          "Aggregate children require unique hierarchy and explicit dependencies",
        );
      parents.add(child);
    }
    for (const dependency of item.dependencies) {
      if (!byId.has(dependency) || dependency === item.id)
        throw new Error(
          `Work Item ${item.id} has invalid dependency ${dependency}`,
        );
    }
  }
  const remaining = new Map(
    graph.items.map((item) => [item.id, new Set(item.dependencies)]),
  );
  const order: WorkItem[] = [];
  while (order.length < graph.items.length) {
    const next = graph.items.find(
      (item) => remaining.has(item.id) && remaining.get(item.id)!.size === 0,
    );
    if (!next) throw new Error("Work Item graph contains a dependency cycle");
    order.push(next);
    remaining.delete(next.id);
    for (const waiting of remaining.values()) waiting.delete(next.id);
  }
  return order;
}

export function readyItems(
  graph: WorkGraph,
  work: Record<string, WorkState>,
  active: Set<string>,
  slots: number,
): WorkItem[] {
  const admitted: WorkItem[] = [];
  for (const item of rankPending(graph, work)) {
    if (admitted.length >= slots) break;
    if (
      work[item.id]?.status !== "pending" ||
      !item.dependencies.every((id) => work[id]?.status === "done")
    )
      continue;
    if (
      [...active, ...admitted.map((candidate) => candidate.id)].some((id) =>
        itemsConflict(
          item,
          graph.items.find((candidate) => candidate.id === id)!,
        ),
      )
    )
      continue;
    admitted.push(item);
  }
  return admitted;
}

/** Rank only after the caller establishes dependencies/ownership eligibility. Completion gets the next opportunity. */
export function rankPending(
  graph: WorkGraph,
  work: Record<string, WorkState>,
): WorkItem[] {
  const prerequisite = (id: string): boolean =>
    graph.items.some(
      (item) =>
        work[item.id]?.status !== "done" && item.dependencies.includes(id),
    );
  return [...graph.items].sort(
    (a, b) =>
      Number(b.kind === "qa" || b.kind === "aggregate") -
        Number(a.kind === "qa" || a.kind === "aggregate") ||
      (b.priority ?? 0) - (a.priority ?? 0) ||
      Number(prerequisite(b.id)) - Number(prerequisite(a.id)),
  );
}
