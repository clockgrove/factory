import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import type { FactoryConfig } from "./config.js";
import { stateRoot } from "./config.js";
import type {
  ContentRef,
  ContentStore,
  PlanningRequest,
  ResultReviewEvidenceSource,
  WorkItem,
} from "./contracts.js";
import { graphDigest } from "./graph-amendments.js";
import { pinnedGit } from "./process.js";
import { acceptedPlanningDecisionContext } from "./planning-decision-context.js";
import {
  LocalRepositoryMemory,
  memorySourceHeading,
  type MemoryLookup,
} from "./repository-memory.js";
import type { FactoryState } from "./state.js";

export type AdaptiveContextRole =
  | "compile"
  | "graph-review"
  | "expansion"
  | "dispatch"
  | "diagnosis"
  | "result-review"
  | "objective-review";
export interface AdaptiveContextSelection {
  id: string;
  kind: "memory" | "discovery" | "interface" | "decision" | "supplied";
  disposition:
    | "current"
    | "historical"
    | "stale"
    | "unavailable"
    | "incomplete";
  required: boolean;
  refs: ContentRef[];
}
export interface AdaptiveContextPacket {
  schemaVersion: 1;
  id: string;
  role: AdaptiveContextRole;
  binding: {
    repository: string;
    objective: number;
    runId: string;
    configDigest: string;
    graphDigest: string;
    baseSha: string;
    itemId?: string;
    attemptId?: string;
  };
  contentRef: ContentRef;
  selections: AdaptiveContextSelection[];
  unavailable: string[];
}
export interface AdaptiveContextPayload {
  schemaVersion: 1;
  role: AdaptiveContextRole;
  binding: AdaptiveContextPacket["binding"];
  selections: AdaptiveContextSelection[];
  unavailable: string[];
  delegation: object;
  decisions: string;
  required: object;
  memory: object[];
  interpretation: string;
}
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const byteHash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const isHash = (value: unknown) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid adaptive context object");
  return value as Record<string, unknown>;
}
function fields(value: unknown, allowed: string[]): Record<string, unknown> {
  const entry = record(value);
  if (Object.keys(entry).some((key) => !allowed.includes(key)))
    throw new Error("Unsupported adaptive context field");
  return entry;
}
function text(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value || value.includes("\0"))
    throw new Error("Invalid adaptive context string");
}
function ref(value: unknown): void {
  const entry = fields(value, ["digest", "bytes", "mediaType"]);
  if (
    !isHash(entry.digest) ||
    !Number.isSafeInteger(entry.bytes) ||
    Number(entry.bytes) < 0
  )
    throw new Error("Invalid adaptive context content reference");
  text(entry.mediaType);
}
/** Snapshot validation is pure; missing advisory bytes never prevent cancellation/history inspection. */
export function assertAdaptiveContextPacket(
  value: unknown,
): asserts value is AdaptiveContextPacket {
  const packet = fields(value, [
    "schemaVersion",
    "id",
    "role",
    "binding",
    "contentRef",
    "selections",
    "unavailable",
  ]);
  if (
    packet.schemaVersion !== 1 ||
    !isHash(packet.id) ||
    ![
      "compile",
      "graph-review",
      "expansion",
      "dispatch",
      "diagnosis",
      "result-review",
      "objective-review",
    ].includes(String(packet.role))
  )
    throw new Error("Invalid adaptive context packet");
  const binding = fields(packet.binding, [
    "repository",
    "objective",
    "runId",
    "configDigest",
    "graphDigest",
    "baseSha",
    "itemId",
    "attemptId",
  ]);
  for (const key of ["repository", "runId"]) text(binding[key]);
  for (const key of ["configDigest", "graphDigest"])
    if (!isHash(binding[key]))
      throw new Error("Invalid adaptive context binding digest");
  if (
    !Number.isSafeInteger(binding.objective) ||
    Number(binding.objective) < 1 ||
    typeof binding.baseSha !== "string" ||
    !/^[a-f0-9]{40,64}$/.test(binding.baseSha)
  )
    throw new Error("Invalid adaptive context identity");
  for (const key of ["itemId", "attemptId"])
    if (binding[key] !== undefined) text(binding[key]);
  ref(packet.contentRef);
  if (
    (packet.contentRef as ContentRef).mediaType !== "application/json" ||
    !Array.isArray(packet.selections) ||
    !Array.isArray(packet.unavailable)
  )
    throw new Error("Invalid adaptive context contents");
  const selected = new Set<string>();
  for (const value of packet.selections) {
    const selection = fields(value, [
      "id",
      "kind",
      "disposition",
      "required",
      "refs",
    ]);
    text(selection.id);
    if (
      selected.has(selection.id) ||
      !["memory", "discovery", "interface", "decision", "supplied"].includes(
        String(selection.kind),
      ) ||
      !["current", "historical", "stale", "unavailable", "incomplete"].includes(
        String(selection.disposition),
      ) ||
      typeof selection.required !== "boolean" ||
      !Array.isArray(selection.refs)
    )
      throw new Error("Invalid adaptive context selection");
    selected.add(selection.id);
    for (const body of selection.refs) ref(body);
  }
  for (const gap of packet.unavailable) text(gap);
  const { id, ...body } = packet;
  if (id !== hash(body))
    throw new Error(
      "Adaptive context packet digest differs from its retained identity",
    );
}

export async function readAdaptiveContextBytes(
  store: ContentStore,
  body: ContentRef,
): Promise<Buffer> {
  await store.verify(body);
  const bytes = Buffer.from(
    await new Response(await store.open(body)).arrayBuffer(),
  );
  if (
    bytes.length !== body.bytes ||
    createHash("sha256").update(bytes).digest("hex") !== body.digest
  )
    throw new Error("Adaptive context content changed while opening");
  return bytes;
}
export async function authenticateAdaptiveContextPacket(
  store: ContentStore,
  packet: AdaptiveContextPacket,
): Promise<AdaptiveContextPayload> {
  assertAdaptiveContextPacket(packet);
  const bytes = await readAdaptiveContextBytes(store, packet.contentRef);
  const payload = JSON.parse(
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
  ) as AdaptiveContextPayload;
  fields(payload, [
    "schemaVersion",
    "role",
    "binding",
    "selections",
    "unavailable",
    "delegation",
    "decisions",
    "required",
    "memory",
    "interpretation",
  ]);
  if (
    payload.schemaVersion !== 1 ||
    payload.role !== packet.role ||
    hash(payload.binding) !== hash(packet.binding) ||
    hash(payload.selections) !== hash(packet.selections) ||
    hash(payload.unavailable) !== hash(packet.unavailable)
  )
    throw new Error("Adaptive context body differs from snapshot binding");
  record(payload.delegation);
  record(payload.required);
  if (
    !Array.isArray(payload.memory) ||
    typeof payload.decisions !== "string" ||
    typeof payload.interpretation !== "string"
  )
    throw new Error("Invalid adaptive context payload");
  return payload;
}
export function adaptiveContextEvidence(
  packet: AdaptiveContextPacket,
  payload: AdaptiveContextPayload,
): ResultReviewEvidenceSource {
  return {
    path: `Controller selected ${packet.role} context (${packet.id})`,
    origin: "controller",
    complete: true,
    content: JSON.stringify(payload),
  };
}

/** One admitted attempt keeps its exact dispatch input across checkpoints and reattachment. */
export async function retainedAdaptiveDispatchContext(input: {
  state: FactoryState;
  item: WorkItem;
  baseSha: string;
  store: ContentStore;
  sources?: PlanningRequest<unknown>["sources"];
}): Promise<
  | {
      packet: AdaptiveContextPacket;
      payload: AdaptiveContextPayload;
      evidence: ResultReviewEvidenceSource;
    }
  | undefined
> {
  const { state, item } = input;
  const work = state.work[item.id];
  if (work?.execution && !work.adaptiveContextId)
    throw new Error(
      "Retained adaptive worker lacks its original dispatch packet; preserve its ownership for supported reconciliation or cancellation",
    );
  if (!work?.attempt) return undefined;
  const attemptGraph = work.graphRevisionDigest ?? graphDigest(state.graph);
  const matches = (packet: AdaptiveContextPacket) =>
    packet.role === "dispatch" &&
    packet.binding.repository === state.repository &&
    packet.binding.objective === state.objective &&
    packet.binding.runId === state.runId &&
    packet.binding.configDigest === state.configDigest &&
    packet.binding.graphDigest === attemptGraph &&
    packet.binding.baseSha === input.baseSha &&
    packet.binding.baseSha === (work.executionBaseSha ?? work.baseSha) &&
    packet.binding.itemId === item.id &&
    packet.binding.attemptId === work.attempt;
  const candidates = work.adaptiveContextId
    ? []
    : Object.values(state.adaptiveContexts ?? {}).filter(matches);
  if (candidates.length > 1)
    throw new Error(
      "Pre-submit dispatch context is ambiguous; preserve the admitted attempt for supported reconciliation",
    );
  const packet = work.adaptiveContextId
    ? state.adaptiveContexts?.[work.adaptiveContextId]
    : candidates[0];
  if (!packet && !work.adaptiveContextId) return undefined;
  if (!packet || !matches(packet))
    throw new Error(
      "Retained dispatch context differs from the admitted attempt and source binding",
    );
  const supplied = (input.sources ?? item.inputSources ?? []).map(
    (source) =>
      `supplied:${source.path}#${source.heading ?? ""}:${byteHash(source.content)}`,
  );
  if (
    JSON.stringify(
      packet.selections
        .filter((selection) => selection.kind === "supplied")
        .map((selection) => selection.id),
    ) !== JSON.stringify(supplied)
  )
    throw new Error(
      "Retained dispatch context differs from complete supplied Source bytes",
    );
  const payload = await authenticateAdaptiveContextPacket(input.store, packet);
  return {
    packet,
    payload,
    evidence: adaptiveContextEvidence(packet, payload),
  };
}

/** Controller-selected facts only. Required inputs stay complete and outside optional retrieval bounds. */
export async function buildAdaptiveContext(input: {
  state: FactoryState;
  role: AdaptiveContextRole;
  item?: WorkItem;
  baseSha: string;
  checkout: string;
  store: ContentStore;
  config?: FactoryConfig;
  sources?: PlanningRequest<unknown>["sources"];
  required?: object;
  requiredSelections?: AdaptiveContextSelection[];
  /** Complete already supplied bytes; provenance-only references never imply delivery. */
  suppliedBodies?: { ref: ContentRef; bytes: Uint8Array }[];
  save: () => void;
}): Promise<
  | {
      packet: AdaptiveContextPacket;
      payload: AdaptiveContextPayload;
      evidence: ResultReviewEvidenceSource;
    }
  | undefined
> {
  const { state, item, store } = input;
  const recorded = state.planningRecovery?.contextLookup?.packet;
  if (!recorded) return undefined;
  if (input.role === "dispatch" && item) {
    const retained = await retainedAdaptiveDispatchContext({
      state,
      item,
      baseSha: input.baseSha,
      store,
      sources: input.sources,
    });
    if (retained) {
      const work = state.work[item.id]!;
      if (work.adaptiveContextId !== retained.packet.id) {
        work.adaptiveContextId = retained.packet.id;
        input.save();
      }
      return retained;
    }
  }
  const binding: AdaptiveContextPacket["binding"] = {
    repository: state.repository,
    objective: state.objective,
    runId: state.runId,
    configDigest: state.configDigest,
    graphDigest: graphDigest(state.graph),
    baseSha: input.baseSha,
    ...(item ? { itemId: item.id } : {}),
    ...(item && state.work[item.id]?.attempt
      ? { attemptId: state.work[item.id]!.attempt! }
      : {}),
  };
  const decisions = JSON.stringify(acceptedPlanningDecisionContext(state));
  const selections: AdaptiveContextSelection[] = [
    ...(input.requiredSelections ?? []),
  ];
  for (const selection of selections) {
    if (
      selection.required &&
      ["unavailable", "incomplete"].includes(selection.disposition)
    )
      throw new Error(
        `Required role context ${selection.id} is ${selection.disposition}`,
      );
    for (const ref of selection.refs) await store.verify(ref);
  }
  for (const body of input.suppliedBodies ?? []) {
    ref(body.ref);
    if (
      body.bytes.byteLength !== body.ref.bytes ||
      createHash("sha256").update(body.bytes).digest("hex") !== body.ref.digest
    )
      throw new Error(
        "Supplied complete adaptive body differs from its reference",
      );
  }
  const sources = input.sources ?? [];
  for (const source of sources)
    selections.push({
      id: `supplied:${source.path}#${source.heading ?? ""}:${byteHash(source.content)}`,
      kind: "supplied",
      disposition: "current",
      required: true,
      refs: [],
    });
  selections.push({
    id: `decision:${byteHash(decisions)}`,
    kind: "decision",
    disposition: "current",
    required: true,
    refs: [],
  });
  // A restarted request consumes its retained exact selection; new memory cannot
  // silently change a submitted worker/diagnosis/review request under one identity.
  for (const packet of Object.values(state.adaptiveContexts ?? {})) {
    if (packet.role !== input.role || hash(packet.binding) !== hash(binding))
      continue;
    const payload = await authenticateAdaptiveContextPacket(store, packet);
    if (
      hash(payload.required) === hash(input.required ?? {}) &&
      payload.decisions === decisions &&
      hash(
        packet.selections.filter((selection) => selection.kind !== "memory"),
      ) === hash(selections)
    )
      return {
        packet,
        payload,
        evidence: adaptiveContextEvidence(packet, payload),
      };
  }
  const unavailable: string[] = [];
  const memory: object[] = [];
  const started = Date.now();
  // Scope comes from the originally admitted catalog, never a new larger config selector.
  const collection = recorded.catalog.find(
    (entry) => entry.id === "repository",
  );
  if (collection && recorded.catalog.some((entry) => entry.id === "memory")) {
    try {
      const retained = new LocalRepositoryMemory(
        stateRoot(state.repository),
        state.repository,
      );
      for (const source of sources)
        retained.suppliedContent(Buffer.from(source.content));
      for (const body of input.suppliedBodies ?? []) {
        retained.suppliedContent(body.bytes);
      }
      const bodyProviders = new Map<string, string>([
        ...sources.map(
          (source) =>
            [byteHash(source.content), "supplied-source"] as [string, string],
        ),
        ...(input.suppliedBodies ?? []).map(
          (body) => [body.ref.digest, "required-context"] as [string, string],
        ),
      ]);
      const relatedIds = new Set<string>();
      const visit = (id: string) => {
        if (relatedIds.has(id)) return;
        relatedIds.add(id);
        for (const dependency of state.graph.items.find(
          (peer) => peer.id === id,
        )?.dependencies ?? [])
          visit(dependency);
      };
      if (item) visit(item.id);
      else for (const peer of state.graph.items) visit(peer.id);
      const relevantPaths = [
        ...sources
          .filter((source) => source.path !== "OBJECTIVE")
          .map((source) => source.path),
        ...state.graph.items
          .filter((peer) => relatedIds.has(peer.id))
          .flatMap((peer) => peer.ownedPaths),
      ];
      const admittedPaths = [
        ...new Set(
          relevantPaths.flatMap((path) =>
            collection.selectors.flatMap((selector) =>
              path === selector ||
              (selector.endsWith("/") && path.startsWith(selector))
                ? [path]
                : path.endsWith("/") && selector.startsWith(path)
                  ? [selector]
                  : [],
            ),
          ),
        ),
      ];
      const lookup: MemoryLookup = {
        access: {
          repository: state.repository,
          visibility: ["repository", "private"],
        },
        scope: {
          objective: state.objective,
          paths: admittedPaths,
          itemIds: [...relatedIds],
        },
        suppliedBodyDigests: [...bodyProviders.keys()],
        suppliedSources: sources.map((source) => ({
          path: source.path,
          ...(memorySourceHeading(source.heading) === undefined
            ? {}
            : { heading: memorySourceHeading(source.heading) }),
          digest: byteHash(source.content),
        })),
        applicability: {
          objective: state.objective,
          treeSha: pinnedGit(
            input.checkout,
            "rev-parse",
            `${input.baseSha}^{tree}`,
          ),
          environment: { configDigest: state.configDigest },
          paths: Object.fromEntries(
            sources
              .filter(
                (source) =>
                  source.path !== "OBJECTIVE" &&
                  memorySourceHeading(source.heading) === undefined,
              )
              .map((source) => [source.path, byteHash(source.content)]),
          ),
          sources: Object.fromEntries(
            sources.map((source) => [
              `${source.path}#${source.heading ?? ""}`,
              { version: byteHash(source.content) },
            ]),
          ),
        },
        limit: Math.min(256, recorded.bounds.maxResults),
        maxBytes: recorded.bounds.maxBytes,
      };
      const metadata = retained.metadata(
        lookup,
        [input.role, item?.goal ?? "", ...admittedPaths].join(" "),
      );
      if (!metadata.complete)
        unavailable.push("Eligible memory catalog incomplete");
      unavailable.push(...metadata.unavailable);
      let remaining = recorded.bounds.maxBytes;
      for (const entry of metadata.entries) {
        if (Date.now() - started > recorded.bounds.maxElapsedMs) {
          unavailable.push(
            "Optional memory selection elapsed allowance exhausted",
          );
          break;
        }
        const considered = new Set(bodyProviders.keys());
        let freshBytes = 0;
        let fullBytes = 0;
        for (const body of entry.record.bodies)
          if (body.ref) {
            fullBytes += body.ref.bytes;
            if (!considered.has(body.ref.digest)) {
              freshBytes += body.ref.bytes;
              considered.add(body.ref.digest);
            }
          }
        if (freshBytes > remaining) {
          unavailable.push(
            `Optional memory ${entry.binding.id} exceeds remaining byte allowance`,
          );
          continue;
        }
        const result = retained.read({
          ...lookup,
          id: entry.binding.id,
          maxBytes: fullBytes,
        });
        if (!result) continue;
        const selection: AdaptiveContextSelection = {
          id: `memory:${entry.binding.id}`,
          kind: "memory",
          disposition: result.disposition,
          required: false,
          refs: result.content.map((body) => body.ref),
        };
        if (["incomplete", "unavailable"].includes(result.disposition)) {
          selections.push({ ...selection, refs: [] });
          unavailable.push(`Memory ${entry.binding.id}: ${result.disposition}`);
          continue;
        }
        const newProviders = new Map(bodyProviders);
        const content = result.content.map((body) => {
          const provider = newProviders.get(body.ref.digest);
          if (provider)
            return { role: body.role, ref: body.ref, reuse: provider };
          newProviders.set(body.ref.digest, `memory:${entry.binding.id}`);
          return body;
        });
        const match = {
          binding: result.binding,
          provenance: {
            repository: result.record.repository,
            kind: result.record.kind,
            producer: result.record.producer,
            authority: result.record.authority,
            sources: result.record.sources,
            bindings: result.record.bindings,
            validity: result.record.validity,
          },
          summary: result.record.summary,
          disposition: result.disposition,
          content,
          gaps: result.gaps,
        };
        const cost = Buffer.byteLength(JSON.stringify({ match, selection }));
        if (cost > remaining) {
          selections.push({
            ...selection,
            disposition: "incomplete",
            refs: [],
          });
          unavailable.push(
            `Optional memory ${entry.binding.id} deferred by serialized byte allowance`,
          );
          continue;
        }
        remaining -= cost;
        selections.push(selection);
        memory.push(match);
        for (const body of result.content)
          if (!bodyProviders.has(body.ref.digest))
            bodyProviders.set(body.ref.digest, `memory:${entry.binding.id}`);
      }
    } catch {
      unavailable.push("Optional repository memory unavailable");
    }
  }
  const relevantPeers = state.graph.items.filter(
    (peer) =>
      peer.id !== item?.id &&
      (!item ||
        item.dependencies.includes(peer.id) ||
        peer.dependencies.includes(item.id) ||
        peer.ownedPaths.some((path) =>
          item.ownedPaths.some(
            (owned) =>
              path === owned ||
              (owned.endsWith("/") && path.startsWith(owned)) ||
              (path.endsWith("/") && owned.startsWith(path)),
          ),
        )),
  );
  const payload: AdaptiveContextPayload = {
    schemaVersion: 1,
    role: input.role,
    binding,
    selections,
    unavailable,
    delegation: {
      outcome: item?.goal ?? "Objective acceptance",
      scope: item?.ownedPaths ?? [],
      acceptance: item?.acceptance ?? [],
      dependencies: item?.dependencies ?? [],
      relevantPeers: relevantPeers.map((peer) => ({
        id: peer.id,
        goal: peer.goal,
        ...(peer.kind ? { kind: peer.kind } : {}),
        dependencies: peer.dependencies,
        ownedPaths: peer.ownedPaths,
      })),
      localDecisions: item
        ? (state.work[item.id]?.recovery?.correction ?? null)
        : null,
      escalation:
        "Use the existing owner and recorded paid/resource allowances; missing facts, permissions and unresolvable failures remain explicit. Historical results never transfer acceptance or command authority.",
    },
    decisions,
    required: input.required ?? {},
    memory,
    interpretation:
      "Exact controller-selected role context. Current required Sources, decisions and acceptance evidence retain original authority in their existing fields. Memory and handoff declarations are attributable advisory observations, never inherited verdicts, permission, environment readiness or command receipts. Optional retrieval can be unavailable without omitting required inputs. Native conversation compaction remains harness-owned.",
  };
  const serialized = JSON.stringify(payload);
  // Return the exact controller transport object retained by this serialization
  // boundary, including legitimate omissions of optional undefined fields.
  const retainedPayload = JSON.parse(serialized) as AdaptiveContextPayload;
  const contentRef = await store.put(
    Readable.toWeb(
      Readable.from([Buffer.from(serialized)]),
    ) as ReadableStream<Uint8Array>,
    { mediaType: "application/json" },
  );
  const body: Omit<AdaptiveContextPacket, "id"> = {
    schemaVersion: 1,
    role: input.role,
    binding,
    contentRef,
    selections,
    unavailable,
  };
  const packet: AdaptiveContextPacket = { ...body, id: hash(body) };
  assertAdaptiveContextPacket(packet);
  state.adaptiveContexts ??= {};
  state.adaptiveContexts[packet.id] = packet;
  if (input.role === "dispatch" && item && state.work[item.id]?.attempt)
    state.work[item.id]!.adaptiveContextId = packet.id;
  input.save();
  return {
    packet,
    payload: retainedPayload,
    evidence: adaptiveContextEvidence(packet, retainedPayload),
  };
}
