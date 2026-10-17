import { createHash } from "node:crypto";
import type {
  ExecutionProfileChoices,
  GraphExpansionEnvelope,
  WorkGraph,
  WorkItem,
} from "./contracts.js";
import {
  assertDiscoveryOutputManifest,
  discoverySpecificationDigest,
  type DiscoveryBody,
  type DiscoveryOutputManifest,
} from "./discovery.js";
import { ownsPath, pathsOverlap, validOwnershipPath } from "./ownership.js";
import { assertWorkItemFields, validateAndOrderGraph } from "./scheduler.js";
import { record } from "./unknown-fields.js";

/** Complete immutable inputs to one materialization, retained before projection. */
export interface GraphExpansionInputPacket {
  schemaVersion: 1;
  parentGraphDigest: string;
  envelope: GraphExpansionEnvelope;
  manifest: DiscoveryOutputManifest;
  body: DiscoveryBody;
  runId: string;
  iteration: 1;
  batches: string[][];
}
export interface GraphExpansionMaterialization {
  graph: WorkGraph;
  childIds: string[];
  inputPacket: GraphExpansionInputPacket;
  digest: string;
  envelopeDigest: string;
}
function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function keys(
  value: Record<string, unknown>,
  fields: string[],
  label: string,
): void {
  if (Object.keys(value).sort().join() !== [...fields].sort().join())
    throw new Error(`${label} has missing or unsupported fields`);
}
function strings(
  value: unknown,
  label: string,
  nonempty = false,
): asserts value is string[] {
  if (
    !Array.isArray(value) ||
    (nonempty && !value.length) ||
    value.some((entry) => typeof entry !== "string" || !entry.trim()) ||
    new Set(value).size !== value.length
  )
    throw new Error(`${label} must contain distinct nonempty strings`);
}
function positive(value: unknown, label: string): void {
  if (!Number.isSafeInteger(value) || Number(value) < 1)
    throw new Error(`${label} must be a finite positive integer`);
}
export function graphExpansionEnvelopeDigest(
  envelope: GraphExpansionEnvelope,
): string {
  return hash(envelope);
}
export function assertGraphExpansionEnvelope(
  value: unknown,
): asserts value is GraphExpansionEnvelope {
  const envelope = record(value, "Expansion envelope");
  keys(
    envelope,
    [
      "schemaVersion",
      "id",
      "input",
      "selectors",
      "workShape",
      "selection",
      "batching",
      "limits",
      "resources",
      "eligibleProfileIds",
      "dependencies",
      "integrationBarrierItemIds",
      "empty",
      "template",
    ],
    "Expansion envelope",
  );
  if (
    envelope.schemaVersion !== 1 ||
    typeof envelope.id !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(envelope.id) ||
    !["migration", "cross-cutting-fix"].includes(String(envelope.workShape)) ||
    envelope.empty !== "settle-without-children"
  )
    throw new Error(
      "Expansion identity, shape or empty semantics are unsupported",
    );
  const input = record(envelope.input, "Expansion input");
  keys(input, ["producerItemId", "role", "schema"], "Expansion input");
  if (
    typeof input.producerItemId !== "string" ||
    !input.producerItemId ||
    typeof input.role !== "string" ||
    !input.role.trim() ||
    input.schema !== "factory.repository-inventory/v1"
  )
    throw new Error("Expansion input must name a repository discovery output");
  for (const field of [
    "selectors",
    "resources",
    "eligibleProfileIds",
    "dependencies",
    "integrationBarrierItemIds",
  ])
    strings(
      envelope[field],
      `Expansion ${field}`,
      ["selectors", "integrationBarrierItemIds"].includes(field),
    );
  if (
    (envelope.selectors as string[]).some(
      (selector) =>
        !validOwnershipPath(selector) ||
        [...selector].some(
          (character) =>
            character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        ),
    )
  )
    throw new Error(
      "Expansion selectors must be literal permitted repository paths",
    );
  const selection = record(envelope.selection, "Expansion selection");
  if (selection.kind === "all-regular-files")
    keys(selection, ["kind"], "Expansion selection");
  else if (selection.kind === "classified") {
    keys(selection, ["kind", "included", "excluded"], "Expansion selection");
    strings(selection.included, "Included classifications", true);
    strings(selection.excluded, "Excluded classifications");
    if (
      selection.included.some((label) =>
        (selection.excluded as string[]).includes(label),
      )
    )
      throw new Error(
        "Expansion included and excluded classifications overlap",
      );
  } else throw new Error("Expansion selection must be explicit and exhaustive");
  const batching = record(envelope.batching, "Expansion batching");
  keys(batching, ["maxFilesPerChild"], "Expansion batching");
  positive(batching.maxFilesPerChild, "Expansion batch size");
  const limits = record(envelope.limits, "Expansion limits");
  keys(limits, ["maxChildren", "maxIterations"], "Expansion limits");
  positive(limits.maxChildren, "Expansion child allowance");
  if (limits.maxIterations !== 1)
    throw new Error(
      "Expansion requires one immutable input materialization; changed inputs require a reviewed successor",
    );
  assertWorkItemFields(envelope.template);
  const template = envelope.template;
  if (
    (template.kind ?? "work") !== "work" ||
    template.discovery ||
    template.children?.length ||
    template.sourceAssets?.length ||
    template.expectedOutputRoles?.length ||
    template.minimumAssetSets ||
    template.requiredLfsRoles?.length ||
    JSON.stringify(template.ownedPaths) !==
      JSON.stringify(envelope.selectors) ||
    JSON.stringify(template.dependencies) !==
      JSON.stringify(envelope.dependencies) ||
    template.discoveryInputs?.length ||
    (template.resources ?? []).some(
      (resource) => !(envelope.resources as string[]).includes(resource),
    )
  )
    throw new Error(
      "Expansion template must be an ordinary bounded work shape with exactly its reviewed selectors and dependencies",
    );
}

/** Admission validation also applies to templates that are never executable nodes. */
export function assertGraphExpansions(
  graph: WorkGraph,
  options: { executionProfiles?: ExecutionProfileChoices } = {},
): void {
  if (graph.expansions === undefined) return;
  if (!Array.isArray(graph.expansions) || !graph.expansions.length)
    throw new Error(
      "Expansion declarations must be a nonempty array when present",
    );
  const ids = new Set(graph.items.map((item) => item.id));
  const envelopeIds = new Set<string>();
  const templateIds = new Set<string>();
  for (const envelope of graph.expansions) {
    assertGraphExpansionEnvelope(envelope);
    if (
      ids.has(envelope.id) ||
      envelopeIds.has(envelope.id) ||
      templateIds.has(envelope.id) ||
      ids.has(envelope.template.id) ||
      templateIds.has(envelope.template.id) ||
      envelopeIds.has(envelope.template.id)
    )
      throw new Error(
        "Expansion and template identities must be unique outside executable nodes",
      );
    envelopeIds.add(envelope.id);
    templateIds.add(envelope.template.id);
    const producer = graph.items.find(
      (item) => item.id === envelope.input.producerItemId,
    );
    if (
      producer?.kind !== "discovery" ||
      producer.discovery?.role !== envelope.input.role ||
      producer.discovery.schema !== envelope.input.schema ||
      envelope.selectors.some(
        (selector) => !ownsPath(selector, producer.discovery!.selectors),
      ) ||
      (envelope.selection.kind === "classified" &&
        producer.discovery.mode !== "semantic")
    )
      throw new Error(
        "Expansion input or permitted scope differs from its declared discovery producer",
      );
    for (const dependency of envelope.dependencies)
      if (
        !ids.has(dependency) ||
        envelope.integrationBarrierItemIds.includes(dependency)
      )
        throw new Error(
          "Expansion requires real settled dependencies outside its integration barriers",
        );
    for (const barrierId of envelope.integrationBarrierItemIds) {
      const barrier = graph.items.find((item) => item.id === barrierId);
      if (
        !barrier ||
        barrier.kind === "discovery" ||
        barrier.id === producer.id
      )
        throw new Error(
          "Expansion integration barrier must name an existing proof or integration consumer",
        );
    }
    const templateGraph = structuredClone(graph);
    templateGraph.items.push({
      ...structuredClone(envelope.template),
      dependencies: [...new Set([...envelope.dependencies, producer.id])],
    });
    // Validate the reviewed future join on a private clone. The real initial graph
    // retains its exact coverage and node bytes until durable materialization.
    for (const barrierId of envelope.integrationBarrierItemIds) {
      const barrier = templateGraph.items.find(
        (item) => item.id === barrierId,
      )!;
      barrier.dependencies = [
        ...new Set([
          ...barrier.dependencies,
          producer.id,
          envelope.template.id,
        ]),
      ];
      if (barrier.kind === "aggregate")
        barrier.children = [
          ...new Set([...(barrier.children ?? []), envelope.template.id]),
        ];
    }
    delete templateGraph.expansions;
    validateAndOrderGraph(
      templateGraph,
      graph.objective,
      graph.baseSha,
      new Set(
        templateGraph.items.flatMap((item) =>
          item.citations.map((citation) => citation.path),
        ),
      ),
    );
    const profile = envelope.template.executionProfile?.id;
    if (profile !== undefined && !envelope.eligibleProfileIds.includes(profile))
      throw new Error(
        "Expansion template selected a profile outside its reviewed eligibility",
      );
    if (
      envelope.template.executionBinding &&
      envelope.template.executionBinding.id !== profile
    )
      throw new Error(
        "Expansion template execution binding differs from its selected profile",
      );
    if (
      Object.hasOwn(options, "executionProfiles") &&
      !options.executionProfiles &&
      (envelope.eligibleProfileIds.length ||
        profile ||
        envelope.template.executionBinding)
    )
      throw new Error(
        "Expansion cannot name profiles when execution profiles are not configured",
      );
    if (options.executionProfiles) {
      for (const id of envelope.eligibleProfileIds)
        if (
          !options.executionProfiles.profiles.some((entry) => entry.id === id)
        )
          throw new Error(
            "Expansion contains an unavailable execution profile",
          );
      if (!profile || !envelope.template.executionBinding)
        throw new Error(
          "Expansion template lacks its configured immutable execution profile binding",
        );
      const selected = options.executionProfiles.profiles.find(
        (entry) => entry.id === profile,
      )!;
      const binding = {
        id: selected.id,
        adapter: selected.adapter,
        ...(selected.model ? { model: selected.model } : {}),
        ...(selected.reasoningEffort
          ? { reasoningEffort: selected.reasoningEffort }
          : {}),
        digest: selected.digest,
      };
      if (
        JSON.stringify(envelope.template.executionBinding) !==
        JSON.stringify(binding)
      )
        throw new Error(
          "Expansion template profile differs from its exact admitted configuration",
        );
    }
  }
  for (let index = 0; index < graph.expansions.length; index++)
    for (const other of graph.expansions.slice(index + 1))
      if (
        graph.expansions[index]!.selectors.some((left) =>
          other.selectors.some((right) => pathsOverlap(left, right)),
        )
      )
        throw new Error(
          "Expansion envelopes must have disjoint permitted ownership",
        );
}

/** No model call: authenticated observations instantiate an already reviewed shape. */
export function materializeGraphExpansion(args: {
  graph: WorkGraph;
  envelopeId: string;
  manifest: DiscoveryOutputManifest;
  body: DiscoveryBody;
  runId: string;
  immutableItemIds?: readonly string[];
  executionProfiles?: ExecutionProfileChoices;
}): GraphExpansionMaterialization {
  assertGraphExpansions(args.graph, args);
  const envelope = args.graph.expansions?.find(
    (entry) => entry.id === args.envelopeId,
  );
  if (!envelope)
    throw new Error("Expansion envelope is not admitted in the current graph");
  const producer = args.graph.items.find(
    (item) => item.id === envelope.input.producerItemId,
  )!;
  const manifest = args.manifest;
  assertDiscoveryOutputManifest(manifest);
  const encodedBody = Buffer.from(JSON.stringify(args.body));
  if (
    !args.runId ||
    manifest.producer.runId !== args.runId ||
    manifest.producer.objective !== args.graph.objective ||
    manifest.producer.itemId !== producer.id ||
    manifest.status !== "complete" ||
    manifest.role !== envelope.input.role ||
    manifest.schema !== envelope.input.schema ||
    manifest.specificationDigest !==
      discoverySpecificationDigest(producer.discovery!) ||
    JSON.stringify(manifest.source.selectors) !==
      JSON.stringify(producer.discovery!.selectors) ||
    manifest.body.digest !==
      createHash("sha256").update(encodedBody).digest("hex") ||
    manifest.body.bytes !== encodedBody.length ||
    args.body.schema !== manifest.schema ||
    args.body.failures.length ||
    args.body.entries.length !== manifest.selectedEntries ||
    (producer.discovery!.mode === "semantic" &&
      args.body.semantic?.status !== "complete")
  )
    throw new Error(
      "Expansion requires complete exact producer-bound discovery bytes; stale, partial or missing input cannot settle it",
    );
  const seen = new Set<string>();
  const selected: string[] = [];
  for (const entry of args.body.entries) {
    if (
      seen.has(entry.path) ||
      !validOwnershipPath(entry.path) ||
      !ownsPath(entry.path, producer.discovery!.selectors)
    )
      throw new Error(
        "Expansion contains duplicate or unauthenticated discovered paths",
      );
    seen.add(entry.path);
    // The complete producer inventory may be broader than an envelope; it grants no ownership there.
    if (!ownsPath(entry.path, envelope.selectors)) continue;
    let included = true;
    if (envelope.selection.kind === "classified") {
      if (
        !entry.classification ||
        ![
          ...envelope.selection.included,
          ...envelope.selection.excluded,
        ].includes(entry.classification)
      )
        throw new Error(
          "Expansion classification is unresolved; use a supported reviewed amendment or human decision",
        );
      included = envelope.selection.included.includes(entry.classification);
    }
    if (!included) continue;
    if (!["100644", "100755"].includes(entry.mode))
      throw new Error(
        "Expansion cannot grant implementation ownership through a discovered symlink",
      );
    selected.push(entry.path);
  }
  selected.sort();
  const batches: string[][] = [];
  let directory: string | undefined;
  for (const path of selected) {
    const parent = path.includes("/")
      ? path.slice(0, path.lastIndexOf("/"))
      : "";
    const batch = batches.at(-1);
    if (
      !batch ||
      parent !== directory ||
      batch.length === envelope.batching.maxFilesPerChild
    )
      batches.push([path]);
    else batch.push(path);
    directory = parent;
  }
  if (batches.length > envelope.limits.maxChildren)
    throw new Error(
      "Expansion exceeds its reviewed child allowance; use a supported amendment rather than truncating the affected set",
    );
  const inputPacket: GraphExpansionInputPacket = {
    schemaVersion: 1,
    parentGraphDigest: hash(args.graph),
    envelope: structuredClone(envelope),
    manifest: structuredClone(manifest),
    body: structuredClone(args.body),
    runId: args.runId,
    iteration: 1,
    batches,
  };
  const digest = hash(inputPacket);
  const graph = structuredClone(args.graph);
  const childIds: string[] = [];
  for (const batch of batches) {
    const id = `${envelope.id}-${hash([digest, batch]).slice(0, 24)}`;
    if (graph.items.some((item) => item.id === id))
      throw new Error(
        "Expansion child identity already exists; reuse its recorded materialization instead of replaying it",
      );
    const child: WorkItem = {
      ...structuredClone(envelope.template),
      id,
      title: `${envelope.template.title}: ${batch.join(", ")}`,
      ownedPaths: [...batch],
      dependencies: [...new Set([...envelope.dependencies, producer.id])],
      discoveryInputs: [
        {
          producerItemId: producer.id,
          role: envelope.input.role,
          fields: [
            "path",
            "mode",
            "blobSha",
            "contentRef",
            ...(producer.discovery!.mode === "semantic"
              ? ["classification" as const]
              : []),
          ],
        },
      ],
      brief: `${envelope.template.brief}\n\nController-bound batch: ${JSON.stringify(batch)}. Complete this reviewed work shape only for these literal owned files. Other inventory entries are dependency context, not additional ownership. Original Objective acceptance remains with its integration barriers.`,
    };
    graph.items.push(child);
    childIds.push(id);
  }
  for (const barrierId of envelope.integrationBarrierItemIds) {
    if (args.immutableItemIds?.includes(barrierId))
      throw new Error(
        "Expansion cannot rewrite the dependencies of a started or completed integration barrier",
      );
    const barrier = graph.items.find((item) => item.id === barrierId)!;
    barrier.dependencies = [
      ...new Set([...barrier.dependencies, producer.id, ...childIds]),
    ];
    if (barrier.kind === "aggregate")
      barrier.children = [
        ...new Set([...(barrier.children ?? []), ...childIds]),
      ];
  }
  const ordered = validateAndOrderGraph(
    graph,
    graph.objective,
    graph.baseSha,
    new Set(
      graph.items.flatMap((item) =>
        item.citations.map((citation) => citation.path),
      ),
    ),
  );
  const ancestorIds = new Map<string, Set<string>>();
  for (const item of ordered) {
    const inherited = new Set<string>();
    for (const dependency of item.dependencies) {
      inherited.add(dependency);
      for (const predecessor of ancestorIds.get(dependency)!)
        inherited.add(predecessor);
    }
    ancestorIds.set(item.id, inherited);
  }
  for (const childId of childIds) {
    const child = ordered.find((item) => item.id === childId)!;
    for (const existing of args.graph.items)
      if (
        child.ownedPaths.some((left) =>
          existing.ownedPaths.some((right) => pathsOverlap(left, right)),
        ) &&
        !ancestorIds.get(child.id)!.has(existing.id) &&
        !ancestorIds.get(existing.id)!.has(child.id)
      )
        throw new Error(
          "Expansion ownership overlaps independent admitted work",
        );
  }
  return {
    graph,
    childIds,
    inputPacket,
    digest,
    envelopeDigest: graphExpansionEnvelopeDigest(envelope),
  };
}
