import { createHash } from "node:crypto";
import type { ContentRef, ContentStore, WorkGraph } from "../contracts.js";
import { memorySourceHeading } from "../repository-memory.js";
import type { PlanningSource } from "./sources.js";

export type ContextDisposition =
  | "complete"
  | "no-match"
  | "unavailable"
  | "denied"
  | "stale"
  | "incomplete"
  | "exhausted";
export interface ContextLookupBounds {
  maxRounds: number;
  maxRequestsPerRound: number;
  maxResults: number;
  maxBytes: number;
  maxElapsedMs: number;
  maxProviderCalls: number;
}
export const DEFAULT_CONTEXT_LOOKUP_BOUNDS: Readonly<ContextLookupBounds> =
  Object.freeze({
    maxRounds: 4,
    maxRequestsPerRound: 8,
    maxResults: 64,
    maxBytes: 262144,
    maxElapsedMs: 30000,
    maxProviderCalls: 5,
  });
export interface ContextCollection {
  id: string;
  selectors: string[];
  operations: ("read" | "search" | "inventory")[];
  freshness: string;
  completeness: "complete" | "incomplete" | "unavailable";
}
export interface ContextRequest {
  id: string;
  operation: "read" | "search" | "inventory";
  collection: string;
  selector: string;
  query: string;
  required: boolean;
  reason: string;
}
export interface ContextMatch {
  identity: string;
  provenance: Record<string, unknown>;
  content: string;
  digest: string;
  bytes: number;
}
/** Reuse closes over exact bytes in this result or its separately supplied source packet. */
export interface SuppliedSourceReuse {
  kind: "supplied-source";
  sourceIndex: number;
  path: string;
  heading?: string;
  digest: string;
}
export type PlanningMemoryBody =
  | { role: string; ref: ContentRef; text: string }
  | {
      role: string;
      ref: ContentRef;
      reuseRef:
        | SuppliedSourceReuse
        | {
            kind: "context-match";
            identity: string;
            role: string;
            digest: string;
          };
    };
export interface PlanningMemoryProjection {
  format: "factory.memory-projection/v1";
  record: import("../repository-memory.js").RepositoryMemoryRecord;
  content: PlanningMemoryBody[];
}
export interface ContextResult {
  request: ContextRequest;
  disposition: ContextDisposition;
  matches: ContextMatch[];
  detail: string;
}
export interface PlanningContextPacket {
  schemaVersion: 1;
  binding: string;
  bounds: ContextLookupBounds;
  catalog: ContextCollection[];
  automatic: ContextResult[];
  batches: ContextResult[][];
}
export type PlanningTurnResponse =
  | { kind: "graph"; graph: WorkGraph }
  | { kind: "context-request"; requests: ContextRequest[] }
  | {
      kind: "human-dependency";
      dependencyKind: "human-choice" | "permission" | "unavailable-context";
      requestIds: string[];
      question: string;
      detail: string;
    };
export interface PlanningLookupRecord {
  packet: PlanningContextPacket;
  startedAt: string;
  elapsedMs: number;
  providerCalls: number;
  results: number;
  bytes: number;
  requestDigests: string[];
  /** Exact packet bytes are also retained in the installation's existing content store. */
  packetRef?: ContentRef;
}
export type ContextLookupPurpose = "automatic" | "requested";
export interface PlanningContextResolver {
  binding: string;
  catalog: ContextCollection[];
  automatic: ContextRequest[];
  /** Read-only controller semantics shared by native tool requests and structured fallback. */
  resolve(
    request: ContextRequest,
    remaining: { maxResults: number; maxBytes: number; deadlineAt: number },
    purpose?: ContextLookupPurpose,
  ): Promise<ContextResult>;
  contentStore: ContentStore;
  bounds: ContextLookupBounds;
  /** Time spent building eligible catalogs before the first lookup, charged to the same frozen allowance. */
  preparationElapsedMs?: number;
}
export function contextDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
/** Recipe inputs carry frozen controller scopes; equal query text does not merge those facts. */
export function contextRequestIdentity(
  request: ContextRequest,
  purpose: ContextLookupPurpose = "requested",
): string {
  return contextDigest([
    request.collection,
    request.operation,
    request.selector,
    request.query,
    ...(request.id.startsWith("recipe-memory-") ? [request.id] : []),
    ...(purpose === "automatic" && request.id === "automatic-relevant-memory"
      ? ["automatic-source-selection"]
      : []),
  ]);
}
function contextResultIdentity(
  packet: PlanningContextPacket,
  result: ContextResult,
): string {
  return contextRequestIdentity(
    result.request,
    packet.automatic.includes(result) ? "automatic" : "requested",
  );
}
export function contextResultBytes(
  result: Pick<ContextResult, "matches">,
): number {
  return result.matches.reduce(
    (total, match) => total + Buffer.byteLength(JSON.stringify(match)),
    0,
  );
}
export function contextMatch(
  identity: string,
  content: string,
  provenance: Record<string, unknown>,
): ContextMatch {
  return {
    identity,
    content,
    provenance,
    digest: createHash("sha256").update(content).digest("hex"),
    bytes: Buffer.byteLength(content),
  };
}
export function assertContextLookupBounds(value: ContextLookupBounds): void {
  const names = Object.keys(DEFAULT_CONTEXT_LOOKUP_BOUNDS);
  if (
    !value ||
    Object.keys(value).sort().join() !== names.sort().join() ||
    names.some(
      (key) =>
        !Number.isSafeInteger(value[key as keyof ContextLookupBounds]) ||
        value[key as keyof ContextLookupBounds] < 1,
    )
  )
    throw new Error("Context lookup bounds must be finite positive integers");
}
export function assertContextRequest(
  value: unknown,
): asserts value is ContextRequest {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid context request");
  const r = value as ContextRequest;
  if (
    Object.keys(r).sort().join() !==
      "collection,id,operation,query,reason,required,selector" ||
    ![r.id, r.collection, r.selector, r.query, r.reason].every(
      (v) => typeof v === "string",
    ) ||
    !r.id.trim() ||
    !r.collection.trim() ||
    !r.reason.trim() ||
    r.id.length > 128 ||
    r.collection.length > 128 ||
    r.selector.length > 4096 ||
    r.query.length > 1024 ||
    r.reason.length > 4096 ||
    typeof r.required !== "boolean" ||
    !["read", "search", "inventory"].includes(r.operation) ||
    (r.operation !== "search" && r.query !== "") ||
    (r.operation === "search" && !r.query.trim())
  )
    throw new Error("Invalid context request fields");
}
function assertResult(result: ContextResult): void {
  assertContextRequest(result.request);
  if (
    ![
      "complete",
      "no-match",
      "unavailable",
      "denied",
      "stale",
      "incomplete",
      "exhausted",
    ].includes(result.disposition) ||
    typeof result.detail !== "string" ||
    result.detail.length > 4096 ||
    !Array.isArray(result.matches)
  )
    throw new Error("Invalid context result");
  for (const match of result.matches) {
    if (
      typeof match.identity !== "string" ||
      !match.identity ||
      match.identity.length > 4096 ||
      typeof match.content !== "string" ||
      !match.provenance ||
      typeof match.provenance !== "object" ||
      match.bytes !== Buffer.byteLength(match.content) ||
      match.digest !== createHash("sha256").update(match.content).digest("hex")
    )
      throw new Error(
        "Context result complete bytes differ from retained identity",
      );
  }
  assertPlanningMemoryProjection(result);
  if (
    result.disposition === "complete" &&
    result.request.operation === "read" &&
    !result.matches.length
  )
    throw new Error("A complete exact-body read must supply its body");
  if (result.disposition === "no-match" && result.matches.length)
    throw new Error("Scoped no-match cannot contain matches");
}
/** Match only complete original source selections, never merely equal unrelated bodies. */
function memoryBodySourceSelection(
  record: PlanningMemoryProjection["record"],
  ref: ContentRef,
  selection: { path: string; heading?: string },
): boolean {
  return record.sources.some((source) => {
    const path =
      source.path ??
      (source.identity.startsWith("repository:")
        ? source.identity.slice("repository:".length)
        : undefined);
    return (
      source.complete &&
      path === selection.path &&
      memorySourceHeading(source.heading) ===
        memorySourceHeading(selection.heading) &&
      source.ref?.digest === ref.digest &&
      source.ref.bytes === ref.bytes &&
      source.ref.mediaType === ref.mediaType
    );
  });
}
/** Actual source bytes must accompany a supplied-source reference at every consuming boundary. */
export function memoryBodySuppliedSource(
  record: PlanningMemoryProjection["record"],
  body: { ref: ContentRef; text: string },
  sources: readonly PlanningSource[],
): SuppliedSourceReuse | undefined {
  const sourceIndex = sources.findIndex(
    (source) =>
      memoryBodySourceSelection(record, body.ref, source) &&
      source.content === body.text &&
      Buffer.byteLength(source.content) === body.ref.bytes &&
      createHash("sha256").update(source.content).digest("hex") ===
        body.ref.digest,
  );
  if (sourceIndex < 0) return undefined;
  const source = sources[sourceIndex]!;
  const heading = memorySourceHeading(source.heading);
  return {
    kind: "supplied-source",
    sourceIndex,
    path: source.path,
    ...(heading === undefined ? {} : { heading }),
    digest: body.ref.digest,
  };
}
/** Retained validation binds references; supplied sources additionally authenticate their available literal bytes. */
export function assertPlanningMemoryProjection(
  result: ContextResult,
  sources?: readonly PlanningSource[],
): void {
  const bodies = new Map<string, ContentRef>();
  for (const match of result.matches) {
    if (
      result.request.collection !== "memory" ||
      !match.identity.startsWith("memory:")
    )
      continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(match.content);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || !("format" in parsed))
      continue;
    const projection = parsed as PlanningMemoryProjection;
    if (
      projection.format !== "factory.memory-projection/v1" ||
      !projection.record ||
      !Array.isArray(projection.content)
    )
      throw new Error("Invalid planning memory projection");
    const pending: [string, ContentRef][] = [];
    for (const body of projection.content) {
      if (
        !body ||
        typeof body.role !== "string" ||
        !body.role ||
        !body.ref ||
        !/^[a-f0-9]{64}$/.test(body.ref.digest) ||
        !Number.isSafeInteger(body.ref.bytes) ||
        body.ref.bytes < 0
      )
        throw new Error("Invalid projected memory body identity");
      if ("text" in body) {
        if (
          "reuseRef" in body ||
          typeof body.text !== "string" ||
          Buffer.byteLength(body.text) !== body.ref.bytes ||
          createHash("sha256").update(body.text).digest("hex") !==
            body.ref.digest
        )
          throw new Error(
            "Projected memory body differs from its exact retained bytes",
          );
        pending.push([
          JSON.stringify([match.identity, body.role, body.ref.digest]),
          body.ref,
        ]);
      } else if (body.reuseRef?.kind === "supplied-source") {
        const reuse = body.reuseRef;
        if (
          !Number.isSafeInteger(reuse.sourceIndex) ||
          reuse.sourceIndex < 0 ||
          typeof reuse.path !== "string" ||
          !reuse.path ||
          (reuse.heading !== undefined &&
            (typeof reuse.heading !== "string" || !reuse.heading)) ||
          reuse.digest !== body.ref.digest ||
          !memoryBodySourceSelection(projection.record, body.ref, reuse)
        )
          throw new Error(
            "Projected memory reference lacks a complete exact source selection",
          );
        if (sources) {
          const source = sources[reuse.sourceIndex];
          if (
            !source ||
            source.path !== reuse.path ||
            memorySourceHeading(source.heading) !== reuse.heading ||
            Buffer.byteLength(source.content) !== body.ref.bytes ||
            createHash("sha256").update(source.content).digest("hex") !==
              reuse.digest
          )
            throw new Error(
              "Projected memory reference lacks its exact supplied source bytes",
            );
        }
      } else {
        const reuse = body.reuseRef;
        const target =
          reuse?.kind === "context-match" &&
          bodies.get(
            JSON.stringify([reuse.identity, reuse.role, reuse.digest]),
          );
        if (
          !reuse ||
          reuse.kind !== "context-match" ||
          reuse.digest !== body.ref.digest ||
          !target ||
          target.digest !== body.ref.digest ||
          target.bytes !== body.ref.bytes
        )
          throw new Error(
            "Projected memory body reference lacks earlier exact bytes in this result",
          );
      }
    }
    for (const [key, ref] of pending) bodies.set(key, ref);
  }
}
/** Source indices used by the typed memory projection; legacy literal results have none. */
export function planningMemorySourceIndices(
  packet: PlanningContextPacket,
): number[] {
  const indices = new Set<number>();
  for (const result of [...packet.automatic, ...packet.batches.flat()]) {
    if (result.request.collection !== "memory") continue;
    for (const match of result.matches) {
      let projection: PlanningMemoryProjection;
      try {
        projection = JSON.parse(match.content);
      } catch {
        continue;
      }
      if (projection?.format !== "factory.memory-projection/v1") continue;
      for (const body of projection.content)
        if (!("text" in body) && body.reuseRef.kind === "supplied-source")
          indices.add(body.reuseRef.sourceIndex);
    }
  }
  return [...indices].sort((a, b) => a - b);
}
export function assertPlanningContextPacket(
  packet: PlanningContextPacket,
  sources?: readonly PlanningSource[],
): void {
  if (
    !packet ||
    packet.schemaVersion !== 1 ||
    typeof packet.binding !== "string" ||
    !/^[a-f0-9]{64}$/.test(packet.binding) ||
    !Array.isArray(packet.catalog) ||
    !Array.isArray(packet.automatic) ||
    !Array.isArray(packet.batches)
  )
    throw new Error("Invalid retained planning context packet");
  if (
    Object.keys(packet).sort().join() !==
    "automatic,batches,binding,bounds,catalog,schemaVersion"
  )
    throw new Error("Unexpected retained context packet fields");
  assertContextLookupBounds(packet.bounds);
  if (packet.catalog.length > 64 || packet.automatic.length > 128)
    throw new Error(
      "Context catalog or automatic request count exceeds finite admitted results",
    );
  if (packet.batches.length > packet.bounds.maxRounds)
    throw new Error("Retained context exceeds frozen round bounds");
  const ids = new Set<string>();
  for (const collection of packet.catalog) {
    if (
      !collection.id ||
      collection.id.length > 128 ||
      ids.has(collection.id) ||
      !Array.isArray(collection.selectors) ||
      collection.selectors.length > 65 ||
      collection.selectors.some(
        (v) => typeof v !== "string" || v.length > 4096,
      ) ||
      !Array.isArray(collection.operations) ||
      collection.operations.some(
        (v) => !["read", "search", "inventory"].includes(v),
      ) ||
      typeof collection.freshness !== "string" ||
      collection.freshness.length > 4096 ||
      !["complete", "incomplete", "unavailable"].includes(
        collection.completeness,
      )
    )
      throw new Error("Invalid eligible context catalog");
    ids.add(collection.id);
  }
  let bytes = 0,
    results = 0;
  const requestIds = new Set<string>();
  for (const result of [...packet.automatic, ...packet.batches.flat()]) {
    assertResult(result);
    if (sources) assertPlanningMemoryProjection(result, sources);
    if (requestIds.has(result.request.id))
      throw new Error("Retained context repeats a request identity");
    requestIds.add(result.request.id);
    bytes += contextResultBytes(result);
    results += result.matches.length;
  }
  if (
    bytes > packet.bounds.maxBytes ||
    results > packet.bounds.maxResults ||
    packet.batches.some(
      (batch) => batch.length > packet.bounds.maxRequestsPerRound,
    )
  )
    throw new Error("Retained context exceeds frozen result or byte bounds");
}
export function assertPlanningLookupRecord(record: PlanningLookupRecord): void {
  assertPlanningContextPacket(record.packet);
  const all = [...record.packet.automatic, ...record.packet.batches.flat()];
  if (
    !Number.isFinite(Date.parse(record.startedAt)) ||
    !Number.isSafeInteger(record.elapsedMs) ||
    record.elapsedMs < 0 ||
    !Number.isSafeInteger(record.providerCalls) ||
    record.providerCalls < 0 ||
    record.providerCalls > record.packet.bounds.maxProviderCalls ||
    record.results !== all.reduce((n, r) => n + r.matches.length, 0) ||
    record.bytes !== all.reduce((n, r) => n + contextResultBytes(r), 0) ||
    !Array.isArray(record.requestDigests) ||
    record.requestDigests.some((d) => !/^[a-f0-9]{64}$/.test(d))
  )
    throw new Error("Invalid retained lookup accounting");
  if (
    !record.packetRef &&
    record.packet.automatic.length + record.packet.batches.length > 0
  )
    throw new Error("Retained lookup has no exact content packet reference");
  if (
    record.packetRef &&
    (record.packetRef.digest !== contextDigest(record.packet) ||
      record.packetRef.bytes !==
        Buffer.byteLength(JSON.stringify(record.packet)) ||
      record.packetRef.mediaType !== "application/json")
  )
    throw new Error(
      "Retained context packet reference differs from exact bytes",
    );
}
export class MissingPlanningContext extends Error {
  override readonly name = "MissingPlanningContext";
}
/** Complete scoped absence resolves inventory/search facts; exact reads still need bodies. */
function resolvedContextResult(result: ContextResult): boolean {
  const currentTime = Date.now();
  return (
    (result.disposition === "complete" ||
      (result.disposition === "no-match" &&
        result.request.operation !== "read")) &&
    result.matches.every(
      (match) =>
        match.provenance.validUntil === undefined ||
        (typeof match.provenance.validUntil === "string" &&
          Number.isFinite(Date.parse(match.provenance.validUntil)) &&
          Date.parse(match.provenance.validUntil) > currentTime),
    )
  );
}
export function assertContextFactsResolved(
  packet: PlanningContextPacket,
  sources?: readonly PlanningSource[],
): void {
  assertPlanningContextPacket(packet, sources);
  const latest = new Map<string, ContextResult>();
  for (const result of [...packet.automatic, ...packet.batches.flat()]) {
    if (result.request.required)
      latest.set(contextResultIdentity(packet, result), result);
  }
  if (
    !sources &&
    planningMemorySourceIndices({
      ...packet,
      automatic: [...latest.values()],
      batches: [],
    }).length
  )
    throw new MissingPlanningContext(
      "Required memory source reuse needs the actual supplied source bytes",
    );
  const missing = [...latest.values()].filter(
    (result) => !resolvedContextResult(result),
  );
  if (missing.length)
    throw new MissingPlanningContext(
      `Mandatory planning facts remain unknown: ${missing.map((r) => `${r.request.id} (${r.disposition})`).join(", ")}`,
    );
}
export async function retainContextPacket(
  record: PlanningLookupRecord,
  store: ContentStore,
): Promise<void> {
  const bytes = Buffer.from(JSON.stringify(record.packet));
  record.packetRef = await store.put(
    new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    { mediaType: "application/json" },
  );
  assertPlanningLookupRecord(record);
}
export async function initializeContextLookup(
  resolver: PlanningContextResolver,
): Promise<PlanningLookupRecord> {
  const bounds = { ...resolver.bounds };
  assertContextLookupBounds(bounds);
  const record: PlanningLookupRecord = {
    packet: {
      schemaVersion: 1,
      binding: resolver.binding,
      bounds,
      catalog: structuredClone(resolver.catalog),
      automatic: [],
      batches: [],
    },
    startedAt: new Date().toISOString(),
    elapsedMs: resolver.preparationElapsedMs ?? 0,
    providerCalls: 0,
    results: 0,
    bytes: 0,
    requestDigests: [],
  };
  assertPlanningLookupRecord(record);
  record.packet.automatic = await resolveContextRequests(
    record,
    resolver,
    resolver.automatic,
    "automatic",
  );
  await retainContextPacket(record, resolver.contentStore);
  return record;
}
export async function resolveContextRequests(
  record: PlanningLookupRecord,
  resolver: PlanningContextResolver,
  requests: ContextRequest[],
  purpose: ContextLookupPurpose = "requested",
): Promise<ContextResult[]> {
  if (resolver.binding !== record.packet.binding)
    throw new Error(
      "Context resolver differs from admitted source/environment binding",
    );
  const start = Date.now();
  const bounds = record.packet.bounds;
  const deadlineAt =
    start + Math.max(0, bounds.maxElapsedMs - record.elapsedMs);
  const results: ContextResult[] = [];
  const seen = new Set(
    [...record.packet.automatic, ...record.packet.batches.flat()].map(
      (result) => result.request.id,
    ),
  );
  for (const request of requests) {
    assertContextRequest(request);
    if (seen.has(request.id))
      throw new Error(
        "Context request identity is already retained or repeated in this batch",
      );
    seen.add(request.id);
    const collection = record.packet.catalog.find(
      (c) => c.id === request.collection,
    );
    let result: ContextResult;
    if (
      !collection ||
      !collection.operations.includes(request.operation) ||
      !collection.selectors.some(
        (s) =>
          request.selector === s ||
          (s.endsWith("/") && request.selector.startsWith(s)) ||
          s === "",
      )
    ) {
      result = {
        request,
        disposition: "denied",
        matches: [],
        detail:
          "Request is outside the admitted eligible collection/selector scope",
      };
    } else if (
      record.results >= bounds.maxResults ||
      record.bytes >= bounds.maxBytes ||
      Date.now() >= deadlineAt
    ) {
      result = {
        request,
        disposition: "exhausted",
        matches: [],
        detail: "Frozen lookup result, byte or elapsed allowance is exhausted",
      };
    } else {
      const prior = [
        ...record.packet.automatic,
        ...record.packet.batches.flat(),
      ].find(
        (r) =>
          r.disposition === "complete" &&
          r.matches.every(
            (m) =>
              m.provenance.validUntil === undefined ||
              (typeof m.provenance.validUntil === "string" &&
                Date.parse(m.provenance.validUntil) > Date.now()),
          ) &&
          contextResultIdentity(record.packet, r) ===
            contextRequestIdentity(request, purpose),
      );
      result = prior
        ? {
            ...structuredClone(prior),
            request,
            detail: `Reused retained exact result: ${prior.detail}`,
          }
        : await resolver.resolve(
            request,
            {
              maxResults: bounds.maxResults - record.results,
              maxBytes: bounds.maxBytes - record.bytes,
              deadlineAt,
            },
            purpose,
          );
      if (contextDigest(result.request) !== contextDigest(request))
        throw new Error(
          "Context resolver returned a different request binding",
        );
      assertResult(result);
      if (
        Date.now() > deadlineAt ||
        result.matches.length > bounds.maxResults - record.results ||
        contextResultBytes(result) > bounds.maxBytes - record.bytes
      )
        result = {
          request,
          disposition: "exhausted",
          matches: [],
          detail:
            "Resolver could not deliver complete content within frozen lookup bounds",
        };
    }
    record.results += result.matches.length;
    record.bytes += contextResultBytes(result);
    results.push(structuredClone(result));
  }
  record.elapsedMs += Date.now() - start;
  return results;
}
/** Discovery source selectors cannot widen the controller's immutable retrieval admission. */
export function assertDiscoveryContextScope(
  graph: WorkGraph,
  packet?: PlanningContextPacket,
): void {
  const discoveries = graph.items.filter((item) => item.kind === "discovery");
  if (!discoveries.length) return;
  if (!packet)
    throw new Error(
      "Discovery requires this Objective's explicit admitted planning context",
    );
  assertPlanningContextPacket(packet);
  const repository = packet.catalog.find(
    (collection) => collection.id === "repository",
  );
  if (!repository)
    throw new Error(
      "Discovery requires an admitted repository selector ceiling",
    );
  for (const item of discoveries) {
    if (
      !item.discovery ||
      item.discovery.selectors.some(
        (selector) =>
          !repository.selectors.some(
            (scope) =>
              selector === scope ||
              (scope.endsWith("/") && selector.startsWith(scope)),
          ),
      )
    )
      throw new Error(
        `Discovery ${item.id} exceeds admitted repository selectors`,
      );
  }
}

/** A context absence question cites actual unresolved required receipts, never catalog availability alone. */
export function assertHumanPlanningDependency(
  response: Extract<PlanningTurnResponse, { kind: "human-dependency" }>,
  packet: PlanningContextPacket,
): void {
  if (
    !["human-choice", "permission", "unavailable-context"].includes(
      response.dependencyKind,
    ) ||
    !Array.isArray(response.requestIds) ||
    response.requestIds.length > packet.bounds.maxResults ||
    response.requestIds.some(
      (id) => typeof id !== "string" || !id || id.length > 128,
    ) ||
    new Set(response.requestIds).size !== response.requestIds.length
  )
    throw new Error(
      "Human dependency requires a supported kind and unique bounded receipt references",
    );
  if (response.dependencyKind !== "unavailable-context") {
    if (response.requestIds.length)
      throw new Error(
        "Human choice and permission dependencies do not reinterpret lookup receipts as authority",
      );
    return;
  }
  if (!response.requestIds.length)
    throw new Error(
      "Unavailable context requires an actual required unsuccessful lookup receipt before asking a human",
    );
  const results = [...packet.automatic, ...packet.batches.flat()];
  for (const id of response.requestIds) {
    const matches = results.filter((result) => result.request.id === id);
    if (matches.length !== 1)
      throw new Error(
        "Human dependency lookup receipt identity is unavailable or ambiguous",
      );
    const result = matches[0]!;
    const latest = [...results]
      .reverse()
      .find(
        (entry) =>
          contextResultIdentity(packet, entry) ===
          contextResultIdentity(packet, result),
      );
    if (
      !result.request.required ||
      resolvedContextResult(result) ||
      !latest ||
      resolvedContextResult(latest)
    )
      throw new Error(
        "Human context dependency must cite a still-unresolved required lookup result",
      );
  }
}
