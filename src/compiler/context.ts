import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import type { ContentRef, ContentStore, WorkGraph } from "../contracts.js";
import { pinnedGitEnvironment } from "../process.js";

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
export interface PlanningContextResolver {
  binding: string;
  catalog: ContextCollection[];
  automatic: ContextRequest[];
  /** Read-only controller semantics shared by native tool requests and structured fallback. */
  resolve(
    request: ContextRequest,
    remaining: { maxResults: number; maxBytes: number; deadlineAt: number },
  ): Promise<ContextResult>;
  contentStore: ContentStore;
  bounds: ContextLookupBounds;
  /** Time spent building eligible catalogs before the first lookup, charged to the same frozen allowance. */
  preparationElapsedMs?: number;
}
export function contextDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
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
  if (
    result.disposition === "complete" &&
    result.request.operation === "read" &&
    !result.matches.length
  )
    throw new Error("A complete exact-body read must supply its body");
  if (result.disposition === "no-match" && result.matches.length)
    throw new Error("Scoped no-match cannot contain matches");
}
export function assertPlanningContextPacket(
  packet: PlanningContextPacket,
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
): void {
  assertPlanningContextPacket(packet);
  const latest = new Map<string, ContextResult>();
  for (const result of [...packet.automatic, ...packet.batches.flat()]) {
    if (result.request.required)
      latest.set(
        contextDigest([
          result.request.collection,
          result.request.operation,
          result.request.selector,
          result.request.query,
        ]),
        result,
      );
  }
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
  );
  await retainContextPacket(record, resolver.contentStore);
  return record;
}
export async function resolveContextRequests(
  record: PlanningLookupRecord,
  resolver: PlanningContextResolver,
  requests: ContextRequest[],
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
          contextDigest([
            r.request.collection,
            r.request.operation,
            r.request.selector,
            r.request.query,
          ]) ===
            contextDigest([
              request.collection,
              request.operation,
              request.selector,
              request.query,
            ]),
      );
      result = prior
        ? {
            ...structuredClone(prior),
            request,
            detail: `Reused retained exact result: ${prior.detail}`,
          }
        : await resolver.resolve(request, {
            maxResults: bounds.maxResults - record.results,
            maxBytes: bounds.maxBytes - record.bytes,
            deadlineAt,
          });
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
/** Deterministic immutable Git reads; no shell, worktree mutation, symlink traversal or caller commands. */
export function repositoryContextResult(
  checkout: string,
  baseSha: string,
  request: ContextRequest,
  remaining: { maxResults: number; maxBytes: number; deadlineAt: number },
): ContextResult {
  const answer = (
    disposition: ContextDisposition,
    matches: ContextMatch[] = [],
    detail = "",
  ): ContextResult => ({ request, disposition, matches, detail });
  if (
    !/^[a-f0-9]{40,64}$/.test(baseSha) ||
    request.selector.startsWith("/") ||
    request.selector.includes("\\") ||
    request.selector.split("/").some((p) => p === "." || p === "..") ||
    request.selector.includes("\0") ||
    /[*?[\]:]/.test(request.selector)
  )
    return answer(
      "denied",
      [],
      "Only admitted literal repository-relative selectors are readable",
    );
  const run = (args: string[]): Buffer =>
    execFileSync("git", ["-C", checkout, ...args], {
      env: pinnedGitEnvironment(),
      maxBuffer: remaining.maxBytes + 65536,
      timeout: Math.max(1, remaining.deadlineAt - Date.now()),
      stdio: ["ignore", "pipe", "pipe"],
    });
  try {
    const entries = run([
      "ls-tree",
      "-rz",
      "--full-tree",
      baseSha,
      ...(request.selector ? ["--", request.selector] : []),
    ])
      .toString("utf8")
      .split("\0")
      .filter(Boolean)
      .map((line) => {
        const tab = line.indexOf("\t");
        const [mode, type, sha] = line.slice(0, tab).split(" ");
        return { path: line.slice(tab + 1), mode, type, sha };
      })
      .filter((e) =>
        request.operation === "read"
          ? e.path === request.selector
          : e.path === request.selector ||
            e.path.startsWith(
              request.selector.endsWith("/")
                ? request.selector
                : `${request.selector}/`,
            ) ||
            request.selector === "",
      );
    if (!entries.length)
      return answer(
        "no-match",
        [],
        "Complete immutable Git tree has no match in this exact scope",
      );
    if (request.operation === "inventory") {
      const content = JSON.stringify(
        entries.map(({ path, mode, type, sha }) => ({ path, mode, type, sha })),
      );
      if (
        entries.length > remaining.maxResults ||
        Buffer.byteLength(content) > remaining.maxBytes
      )
        return answer(
          "incomplete",
          [],
          "Scoped inventory exceeds the remaining allowance; narrow selectors before relying on absence",
        );
      return answer(
        "complete",
        [
          contextMatch(`git:${baseSha}:${request.selector}`, content, {
            baseSha,
            selector: request.selector,
            complete: true,
          }),
        ],
        "Complete scoped immutable Git inventory",
      );
    }
    const matches: ContextMatch[] = [];
    let bytes = 0;
    let unavailable = false;
    for (const entry of entries) {
      if (entry.type !== "blob" || entry.mode === "120000") {
        if (request.operation === "read")
          return answer(
            "unavailable",
            [],
            "Selected Git entry is a symlink or non-file; no target traversal is allowed",
          );
        unavailable = true;
        continue;
      }
      const body = run(["cat-file", "blob", entry.sha!]);
      const content = body.toString("utf8");
      if (!Buffer.from(content).equals(body)) {
        if (request.operation === "read")
          return answer(
            "unavailable",
            [],
            "Selected body is not complete UTF-8 text",
          );
        unavailable = true;
        continue;
      }
      if (
        request.operation === "search" &&
        !content.toLowerCase().includes(request.query.toLowerCase()) &&
        !entry.path.toLowerCase().includes(request.query.toLowerCase())
      )
        continue;
      if (
        matches.length >= remaining.maxResults ||
        bytes + body.length > remaining.maxBytes
      )
        return answer(
          "incomplete",
          matches,
          "Search or read exceeds remaining allowance; returned matches are complete bodies but inventory is incomplete",
        );
      matches.push(
        contextMatch(`git:${baseSha}:${entry.path}`, content, {
          baseSha,
          path: entry.path,
          blobSha: entry.sha,
          complete: true,
        }),
      );
      bytes += body.length;
    }
    if (unavailable)
      return answer(
        "incomplete",
        matches,
        "Some scoped entries are symlinks, non-files or non-UTF8 bodies; their semantics remain unavailable",
      );
    return matches.length
      ? answer(
          "complete",
          matches,
          "Complete attributable bodies from immutable Git scope",
        )
      : answer(
          "no-match",
          [],
          "Complete searchable UTF-8 Git scope has no match; binary and symlink semantics are unavailable",
        );
  } catch {
    return answer(
      "unavailable",
      [],
      "Immutable Git source is unavailable or exceeds the remaining read/time allowance",
    );
  }
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
  if (
    !repository ||
    !repository.operations.includes("read") ||
    !repository.operations.includes("inventory")
  )
    throw new Error(
      "Discovery requires an admitted read-only repository collection",
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
  const identity = (request: ContextRequest) =>
    contextDigest([
      request.collection,
      request.operation,
      request.selector,
      request.query,
    ]);
  for (const id of response.requestIds) {
    const matches = results.filter((result) => result.request.id === id);
    if (matches.length !== 1)
      throw new Error(
        "Human dependency lookup receipt identity is unavailable or ambiguous",
      );
    const result = matches[0]!;
    const latest = [...results]
      .reverse()
      .find((entry) => identity(entry.request) === identity(result.request));
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
