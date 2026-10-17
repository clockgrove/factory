import { pathsOverlap, validOwnershipPath } from "./ownership.js";

export { pathsOverlap } from "./ownership.js";

import type { WorkGraph, WorkItem } from "./contracts.js";
import { assertDeclaredConditions } from "./adaptive-routing.js";
import { assertCoverageShape } from "./qa.js";
import { assertDiscoverySpecification } from "./discovery.js";
import { expansionBlocksItem } from "./expansion-readiness.js";
import type { WorkState } from "./state.js";

/** Admission and restored snapshots share the same optional advisory hint shape. */
export function assertWorkItemScheduling(value?: unknown): void {
  if (value === undefined) return;
  const hint = value as Record<string, unknown>;
  if (
    !hint ||
    typeof hint !== "object" ||
    Array.isArray(hint) ||
    Object.keys(hint).sort().join() !== "estimatedDurationMs,reason" ||
    !Number.isSafeInteger(hint.estimatedDurationMs) ||
    Number(hint.estimatedDurationMs) <= 0 ||
    typeof hint.reason !== "string" ||
    !hint.reason.trim()
  )
    throw new Error(
      "Work Item scheduling requires a positive advisory duration and reason",
    );
}

/** A refused plan, naming the Work Item ID or field that failed. */
export class GraphValidationError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
  }
}

/** Native item types must hold before proof, path, scheduler or review consumers. */
export function assertWorkItemFields(
  value: unknown,
): asserts value is WorkItem {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Work Item must be an object");
  const item = value as Record<string, unknown>;
  for (const field of ["id", "title", "goal", "brief"])
    if (typeof item[field] !== "string" || !(item[field] as string).length)
      throw new GraphValidationError(
        field,
        `Work Item ${field} must be a nonempty string`,
      );
  for (const field of [
    "acceptance",
    "nonGoals",
    "dependencies",
    "ownedPaths",
    "resources",
    "children",
    "expectedOutputRoles",
    "requiredLfsRoles",
  ]) {
    if (
      [
        "resources",
        "children",
        "expectedOutputRoles",
        "requiredLfsRoles",
      ].includes(field) &&
      item[field] === undefined
    )
      continue;
    if (
      !Array.isArray(item[field]) ||
      !(item[field] as unknown[]).every((entry) => typeof entry === "string")
    )
      throw new GraphValidationError(
        field,
        `Work Item ${field} must be a string array`,
      );
  }
  if (
    !Array.isArray(item.citations) ||
    !item.citations.every(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        !Array.isArray(entry) &&
        typeof entry.path === "string" &&
        !!entry.path &&
        (entry.heading === undefined || typeof entry.heading === "string"),
    )
  )
    throw new Error("Work Item citations must contain typed source references");
  if (
    !Array.isArray(item.validation) ||
    !item.validation.every(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        !Array.isArray(entry) &&
        typeof entry.command === "string" &&
        !!entry.command &&
        typeof entry.provenance === "string" &&
        (entry.source === undefined || typeof entry.source === "string"),
    )
  )
    throw new Error("Work Item validation must contain typed commands");
  if (
    item.minimumAssetSets !== undefined &&
    (!Number.isSafeInteger(item.minimumAssetSets) ||
      (item.minimumAssetSets as number) < 0)
  )
    throw new Error("Work Item minimumAssetSets must be a nonnegative integer");
  if (item.priority !== undefined && !Number.isSafeInteger(item.priority))
    throw new Error("Work Item priority must be an integer");
  assertWorkItemScheduling(item.scheduling);
  if (
    item.sourceAssets !== undefined &&
    (!Array.isArray(item.sourceAssets) ||
      !item.sourceAssets.every((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry))
          return false;
        const asset = entry as Record<string, unknown>;
        return (
          ["path", "role", "mediaType"].every(
            (field) => typeof asset[field] === "string" && !!asset[field],
          ) &&
          (asset.kind === undefined ||
            ["repository", "local", "github-attachment"].includes(
              asset.kind as string,
            )) &&
          ["private", "repository"].includes(asset.visibility as string)
        );
      }))
  )
    throw new Error(
      "Work Item sourceAssets must contain typed asset declarations",
    );
}

/** Routing settles a dependency without supplying implementation acceptance. */
export function workSettled(work: WorkState | undefined): boolean {
  return (
    work?.status === "done" ||
    (work?.status === "skipped" && work.routing?.disposition === "skipped")
  );
}

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

/** A command line is executable text, never a Markdown wrapper or list item. */
export function validValidationCommand(command: string): boolean {
  return (
    command.trim().length > 0 &&
    !/[\r\n\0]/.test(command) &&
    !/^(?:`|#{1,6}(?:\s|$)|[-*]\s|>\s)/.test(command.trimStart())
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
    !Array.isArray(graph.items) ||
    !graph.items.length
  ) {
    throw new Error(
      "Compiled graph must target the exact Objective and base with at least one Work Item",
    );
  }
  for (const item of graph.items) assertWorkItemFields(item);
  assertCoverageShape(graph);
  assertDeclaredConditions(graph);
  const byId = new Map<string, WorkItem>();
  for (const item of graph.items) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(item.id) || byId.has(item.id))
      throw new GraphValidationError(
        item.id,
        `Invalid or duplicate Work Item ID: ${item.id}`,
      );
    for (const path of item.ownedPaths) {
      if (!validOwnershipPath(path))
        throw new GraphValidationError(
          item.id,
          `Work Item ${item.id} has invalid ownership path ${JSON.stringify(path)}; use a literal repository-relative file or directory ending in /. Wildcards * and ? are unsupported; do not use globs or normalize paths.`,
        );
    }
    if (
      !item.title ||
      !item.goal ||
      !item.brief ||
      !item.acceptance.length ||
      !item.nonGoals?.length ||
      (!["qa", "aggregate", "discovery"].includes(item.kind ?? "work") &&
        !item.ownedPaths.length) ||
      !item.citations.length ||
      !item.citations.every((citation) => sources.has(citation.path))
    ) {
      throw new GraphValidationError(
        item.id,
        `Work Item ${item.id} lacks acceptance, non-goals, ownership, or source citations`,
      );
    }
    if (
      item.kind !== undefined &&
      !["qa", "work", "aggregate", "discovery"].includes(item.kind)
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
    if (item.kind === "discovery") {
      assertDiscoverySpecification(item.discovery);
      if (
        item.ownedPaths.length ||
        item.validation.length ||
        item.sourceAssets?.length ||
        item.expectedOutputRoles?.length ||
        item.minimumAssetSets ||
        item.requiredLfsRoles?.length ||
        (item.discovery.mode === "inventory" &&
          (item.executionProfile || item.executionBinding))
      )
        throw new Error(
          "Discovery cannot own changes, validation, media or inventory workers",
        );
    } else if (item.discovery !== undefined)
      throw new Error("Only discovery nodes declare a discovery specification");
    for (const check of item.validation) {
      if (!validValidationCommand(check.command))
        throw new GraphValidationError(
          item.id,
          `Work Item ${item.id} validation needs an executable command line, not Markdown or prose surrounding a code span`,
        );
      if (
        !check.command ||
        !["base-observed", "source-declared"].includes(check.provenance) ||
        (check.provenance === "source-declared" &&
          !sources.has(check.source ?? ""))
      ) {
        throw new GraphValidationError(
          item.id,
          `Work Item ${item.id} has invalid command provenance for ${JSON.stringify(check.command)} from ${JSON.stringify(check.source)}`,
        );
      }
    }
    if (item.priority !== undefined && !Number.isSafeInteger(item.priority))
      throw new GraphValidationError(
        item.id,
        `Work Item ${item.id} has invalid priority`,
      );
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
    if (item.discoveryInputs !== undefined) {
      if (!Array.isArray(item.discoveryInputs))
        throw new Error(
          "Discovery inputs must declare selected producers, roles and fields",
        );
      if (item.discoveryInputs.length && (item.kind ?? "work") !== "work")
        throw new Error(
          "Discovery inputs currently require an ordinary work consumer",
        );
      const seen = new Set<string>();
      for (const selection of item.discoveryInputs) {
        const producer = byId.get(selection?.producerItemId);
        if (
          !selection ||
          typeof selection !== "object" ||
          Object.keys(selection).some(
            (key) => !["producerItemId", "role", "fields"].includes(key),
          ) ||
          !producer ||
          producer.kind !== "discovery" ||
          !item.dependencies.includes(producer.id) ||
          selection.role !== producer.discovery?.role ||
          seen.has(producer.id) ||
          !Array.isArray(selection.fields) ||
          !selection.fields.length ||
          new Set(selection.fields).size !== selection.fields.length ||
          selection.fields.some(
            (field) =>
              ![
                "path",
                "mode",
                "blobSha",
                "contentRef",
                "classification",
              ].includes(field),
          )
        )
          throw new Error(
            "Discovery input selection differs from its declared direct dependency output",
          );
        if (
          selection.fields.includes("classification") &&
          producer.discovery?.mode !== "semantic"
        )
          throw new Error("Inventory discovery has no classification field");
        seen.add(producer.id);
      }
    }
    for (const dependency of item.dependencies) {
      if (!byId.has(dependency) || dependency === item.id)
        throw new GraphValidationError(
          item.id,
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
  resolvedExpansionIds?: ReadonlySet<string>,
): WorkItem[] {
  const admitted: WorkItem[] = [];
  for (const item of rankPending(graph, work)) {
    if (admitted.length >= slots) break;
    if (
      work[item.id]?.status !== "pending" ||
      pendingItemBlocker(
        graph,
        work,
        item,
        new Set([...active, ...admitted.map((candidate) => candidate.id)]),
        resolvedExpansionIds,
      )
    )
      continue;
    admitted.push(item);
  }
  return admitted;
}

export interface SchedulingBlocker {
  kind:
    | "dependency"
    | "ownership"
    | "resource"
    | "expansion"
    | "operator"
    | "condition";
  detail: string;
  blockedBy?: string;
}

/** Current graph/state facts only. Hierarchy and old observations grant no admission. */
export function pendingItemBlocker(
  graph: WorkGraph,
  work: Record<string, WorkState>,
  item: WorkItem,
  active: ReadonlySet<string>,
  resolvedExpansionIds?: ReadonlySet<string>,
  dependencyReady: (id: string) => boolean = (id) => workSettled(work[id]),
): SchedulingBlocker | undefined {
  const wait = work[item.id]?.wait;
  if (wait && ["decision", "prerequisite"].includes(wait.kind))
    return { kind: "operator", detail: wait.detail };
  if (item.condition && work[item.id]?.routing?.disposition !== "selected")
    return {
      kind: "condition",
      detail:
        work[item.id]?.routing?.disposition === "held"
          ? (work[item.id]!.routing as { detail: string }).detail
          : "Declared branch condition has no authenticated selected disposition",
    };
  if (expansionBlocksItem(graph, item.id, resolvedExpansionIds))
    return {
      kind: "expansion",
      detail: "Required discovery expansion is not authenticated and settled",
    };
  const dependency = item.dependencies.find((id) => !dependencyReady(id));
  if (dependency) {
    const held = work[dependency]?.wait;
    return {
      kind:
        held && ["decision", "prerequisite"].includes(held.kind)
          ? "operator"
          : "dependency",
      blockedBy: dependency,
      detail:
        held && ["decision", "prerequisite"].includes(held.kind)
          ? `Dependency ${dependency} awaits its operator prerequisite`
          : `Dependency ${dependency} has not completed acceptance`,
    };
  }
  for (const id of active) {
    if (id === item.id) continue;
    const other = graph.items.find((candidate) => candidate.id === id);
    if (!other || !itemsConflict(item, other)) continue;
    const ownership = item.ownedPaths.some((a) =>
      other.ownedPaths.some((b) => pathsOverlap(a, b)),
    );
    return {
      kind: ownership ? "ownership" : "resource",
      blockedBy: id,
      detail: ownership
        ? `Literal ownership is held by ${id}`
        : `Declared shared resource is held by ${id}`,
    };
  }
  return undefined;
}

/** Remaining DAG stages are a proxy; absent duration estimates remain unknown. */
export function criticalPathValues(
  graph: WorkGraph,
  work: Record<string, WorkState>,
) {
  const successors = new Map<string, WorkItem[]>();
  for (const item of graph.items)
    for (const dependency of item.dependencies)
      successors.set(dependency, [...(successors.get(dependency) ?? []), item]);
  const values = new Map<
    string,
    { remainingStages: number; estimatedDurationMs: number | null }
  >();
  const visiting = new Set<string>();
  const visit = (
    item: WorkItem,
  ): { remainingStages: number; estimatedDurationMs: number | null } => {
    const previous = values.get(item.id);
    if (previous) return previous;
    if (visiting.has(item.id))
      throw new Error("Scheduling graph contains a dependency cycle");
    visiting.add(item.id);
    const children = (successors.get(item.id) ?? [])
      .filter((child) => !workSettled(work[child.id]))
      .map(visit);
    const remainingStages = workSettled(work[item.id])
      ? 0
      : 1 + Math.max(0, ...children.map((child) => child.remainingStages));
    const estimate = item.scheduling?.estimatedDurationMs;
    const duration = workSettled(work[item.id])
      ? 0
      : estimate === undefined ||
          children.some((child) => child.estimatedDurationMs === null)
        ? null
        : estimate +
          Math.max(0, ...children.map((child) => child.estimatedDurationMs!));
    const estimatedDurationMs =
      duration !== null && !Number.isSafeInteger(duration) ? null : duration;
    const result = { remainingStages, estimatedDurationMs };
    visiting.delete(item.id);
    values.set(item.id, result);
    return result;
  };
  for (const item of graph.items) visit(item);
  return values;
}

export function schedulingObservations(
  graph: WorkGraph,
  work: Record<string, WorkState>,
  now = Date.now(),
) {
  const values = criticalPathValues(graph, work);
  const rankingBasis = graph.items
    .filter((item) => !workSettled(work[item.id]))
    .every((item) => values.get(item.id)!.estimatedDurationMs !== null)
    ? "declared-duration"
    : "remaining-stages";
  return new Map(
    graph.items.map((item) => {
      const current = work[item.id];
      const start =
        current?.startedAt === undefined
          ? undefined
          : Date.parse(current.startedAt);
      const end =
        current?.completedAt === undefined
          ? undefined
          : Date.parse(current.completedAt);
      const elapsedToCompletionMs =
        start !== undefined &&
        end !== undefined &&
        Number.isFinite(start) &&
        Number.isFinite(end) &&
        end >= start
          ? end - start
          : null;
      return [
        item.id,
        {
          rankingBasis,
          remainingCriticalPathStages: values.get(item.id)!.remainingStages,
          estimatedCriticalPathMs: values.get(item.id)!.estimatedDurationMs,
          elapsedSinceStartMs:
            start !== undefined &&
            Number.isFinite(start) &&
            now >= start &&
            end === undefined
              ? now - start
              : null,
          elapsedToCompletionMs,
          queueMs: null,
          deliveryHeadReplacements: current?.replacedHeads?.length ?? 0,
          ownedPathCount: item.ownedPaths.length,
        },
      ] as const;
    }),
  );
}
export type SchedulingObservation =
  ReturnType<typeof schedulingObservations> extends Map<string, infer Value>
    ? Value
    : never;

/** Completion and explicit priority win; one common basis keeps ranking transitive. */
export function rankPending(
  graph: WorkGraph,
  work: Record<string, WorkState>,
): WorkItem[] {
  const values = criticalPathValues(graph, work);
  const estimatesComplete = graph.items
    .filter((item) => !workSettled(work[item.id]))
    .every((item) => values.get(item.id)!.estimatedDurationMs !== null);
  return [...graph.items].sort(
    (a, b) =>
      Number(b.kind === "qa" || b.kind === "aggregate") -
        Number(a.kind === "qa" || a.kind === "aggregate") ||
      (b.priority ?? 0) - (a.priority ?? 0) ||
      (estimatesComplete
        ? values.get(b.id)!.estimatedDurationMs! -
          values.get(a.id)!.estimatedDurationMs!
        : values.get(b.id)!.remainingStages -
          values.get(a.id)!.remainingStages),
  );
}
