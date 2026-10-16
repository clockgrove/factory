import { createHash } from "node:crypto";
import {
  readAdaptiveContextBytes,
  type AdaptiveContextSelection,
} from "./adaptive-context.js";
import type {
  ContentRef,
  ContentStore,
  ExecutionResult,
  ResultReviewEvidenceSource,
  WorkHandoffNote,
  WorkItem,
} from "./contracts.js";
import { graphDigest } from "./graph-amendments.js";
import { workFault } from "./fault.js";
import { ownsPath, validOwnershipPath } from "./ownership.js";
import { pinnedGitRaw } from "./process.js";
import type { FactoryState, WorkState } from "./state.js";

export interface ObjectiveKnowledgeRecord {
  version: 1;
  repository: string;
  objective: number;
  runId: string;
  configDigest: string;
  graphDigest: string;
  itemId: string;
  attemptId: string;
  commitSha: string;
  treeSha: string;
  /** Immutable private content-store body; never a public artifact. */
  recordRef: ContentRef;
  notes: WorkHandoffNote[];
  sources: { path: string; ref: ContentRef }[];
}
interface KnowledgeViewEntry {
  producerItem: string;
  producerAttempt: string;
  producerGraphDigest: string;
  producerCommitSha: string;
  producerTreeSha: string;
  recordRef: ContentRef;
  relationship: string;
  producerDisposition: string;
  authority: string;
  kind: WorkHandoffNote["kind"];
  criterionIndex?: number;
  summary: string;
  sources: { path: string; ref?: ContentRef; availability: string }[];
}

const digest = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
const gitSha = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{40,64}$/.test(value);
const filePath = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= 512 &&
  !value.endsWith("/") &&
  !value.includes("\0") &&
  validOwnershipPath(value) &&
  !value.split("/").some((part) => part.toLowerCase() === ".git") &&
  !value.startsWith(".factory-");

/**
 * Learnings are short; a verification map names every sub-clause of one
 * acceptance criterion with its proof locations, so it gets more room.
 */
const LEARNING_LIMIT = { notes: 16, summary: 1024, paths: 8 };
/** One verification note per acceptance criterion; the manifest size bounds the rest. */
const VERIFICATION_LIMIT = { summary: 4096, paths: 16 };

/** Reject malformed optional data; the controller never repairs model claims. */
export function parseWorkHandoffNotes(value: unknown): WorkHandoffNote[] {
  const declaration = value as { notes?: unknown } | null;
  if (
    !declaration ||
    typeof declaration !== "object" ||
    Array.isArray(value) ||
    Object.keys(declaration).some((key) => key !== "notes") ||
    !Array.isArray(declaration.notes)
  )
    throw new Error("Handoff must be an object with a notes array");
  const notes = declaration.notes.map((raw: unknown) => {
    const note = raw as WorkHandoffNote | null;
    const verification = note?.kind === "verification";
    const limit = verification ? VERIFICATION_LIMIT : LEARNING_LIMIT;
    if (
      !note ||
      typeof note !== "object" ||
      Array.isArray(note) ||
      Object.keys(note).some(
        (key) =>
          !["kind", "summary", "paths", "consumers", "criterionIndex"].includes(
            key,
          ),
      ) ||
      !["interface", "pitfall", "hypothesis", "verification"].includes(
        note.kind,
      ) ||
      (verification
        ? !Number.isSafeInteger(note.criterionIndex) ||
          (note.criterionIndex as number) < 0 ||
          note.consumers?.length !== 0
        : note.criterionIndex !== undefined) ||
      typeof note.summary !== "string" ||
      !note.summary.trim() ||
      note.summary.length > limit.summary ||
      !Array.isArray(note.paths) ||
      note.paths.length > limit.paths ||
      !note.paths.every(filePath) ||
      new Set(note.paths).size !== note.paths.length ||
      !Array.isArray(note.consumers) ||
      note.consumers.length > 16 ||
      !note.consumers.every(
        (id) =>
          typeof id === "string" &&
          id.length > 0 &&
          id.length <= 128 &&
          !id.includes("\0"),
      ) ||
      new Set(note.consumers).size !== note.consumers.length
    )
      throw new Error(
        "Handoff note has invalid kind, summary, source paths, consumers or criterion",
      );
    return {
      kind: note.kind,
      summary: note.summary,
      paths: [...note.paths],
      consumers: [...note.consumers],
      ...(verification ? { criterionIndex: note.criterionIndex } : {}),
    };
  });
  const verifications = notes.filter((note) => note.kind === "verification");
  if (
    notes.length - verifications.length > LEARNING_LIMIT.notes ||
    new Set(verifications.map((note) => note.criterionIndex)).size !==
      verifications.length
  )
    throw new Error(
      `Handoff must hold at most ${LEARNING_LIMIT.notes} learning notes and one verification note per criterion`,
    );
  return notes;
}

/** Models choose recipients; the controller owns their identities. */
export function workHandoffSchema(
  peerCount: number,
  criterionCount: number,
): Record<string, unknown> {
  const paths = (maxItems: number) => ({
    type: "array",
    maxItems,
    uniqueItems: true,
    items: { type: "string", minLength: 1, maxLength: 512 },
  });
  const learning = {
    type: "object",
    additionalProperties: false,
    required: ["kind", "summary", "paths", "consumerIndices"],
    properties: {
      kind: { type: "string", enum: ["interface", "pitfall", "hypothesis"] },
      summary: {
        type: "string",
        minLength: 1,
        maxLength: LEARNING_LIMIT.summary,
      },
      paths: paths(LEARNING_LIMIT.paths),
      consumerIndices: {
        type: "array",
        maxItems: peerCount === 0 ? 0 : 16,
        uniqueItems: true,
        items: {
          type: "integer",
          minimum: 0,
          ...(peerCount > 0 ? { maximum: peerCount - 1 } : {}),
        },
      },
    },
  };
  const verification = {
    type: "object",
    additionalProperties: false,
    required: ["kind", "summary", "paths", "consumerIndices", "criterionIndex"],
    properties: {
      kind: { type: "string", const: "verification" },
      summary: {
        type: "string",
        minLength: 1,
        maxLength: VERIFICATION_LIMIT.summary,
      },
      paths: paths(VERIFICATION_LIMIT.paths),
      criterionIndex: {
        type: "integer",
        minimum: 0,
        maximum: criterionCount - 1,
      },
      consumerIndices: { type: "array", maxItems: 0 },
    },
  };
  return {
    type: "object",
    additionalProperties: false,
    required: ["notes"],
    properties: {
      notes: {
        type: "array",
        maxItems: LEARNING_LIMIT.notes + criterionCount,
        items:
          criterionCount > 0 ? { oneOf: [learning, verification] } : learning,
      },
    },
  };
}

/** Decode only the indexed declaration; never repair a rejected response. */
export function decodeWorkHandoffNotes(
  value: unknown,
  peers: readonly { id: string; title: string }[] = [],
  criterionCount?: number,
): WorkHandoffNote[] {
  if (
    !peers.every(
      (peer) =>
        typeof peer.id === "string" &&
        peer.id.length > 0 &&
        peer.id.length <= 128 &&
        !peer.id.includes("\0") &&
        typeof peer.title === "string",
    ) ||
    new Set(peers.map((peer) => peer.id)).size !== peers.length
  )
    throw new Error("Handoff peer catalog differs from its admitted graph");
  const declaration = value as { notes?: unknown } | null;
  if (
    !declaration ||
    typeof declaration !== "object" ||
    Array.isArray(declaration) ||
    Object.keys(declaration).some((key) => key !== "notes") ||
    !Array.isArray(declaration.notes) ||
    (criterionCount !== undefined &&
      declaration.notes.length > LEARNING_LIMIT.notes + criterionCount)
  )
    throw new Error(
      `Handoff must be an object with at most ${LEARNING_LIMIT.notes} learning notes and one verification note per criterion`,
    );
  const notes = declaration.notes.map((raw) => {
    if (
      !raw ||
      typeof raw !== "object" ||
      Array.isArray(raw) ||
      Object.keys(raw).some(
        (key) =>
          ![
            "kind",
            "summary",
            "paths",
            "consumerIndices",
            "criterionIndex",
          ].includes(key),
      )
    )
      throw new Error("Handoff note differs from the indexed declaration");
    const criterionIndex = (raw as { criterionIndex?: unknown }).criterionIndex;
    if (
      criterionIndex !== undefined &&
      (!Number.isSafeInteger(criterionIndex) ||
        (criterionCount !== undefined &&
          (criterionIndex as number) >= criterionCount))
    )
      throw new Error(
        "Handoff verification note names a criterion absent from this Work Item",
      );
    const note = raw as Record<string, unknown>,
      indices = note.consumerIndices;
    if (
      !Array.isArray(indices) ||
      indices.length > 16 ||
      new Set(indices).size !== indices.length ||
      !indices.every(
        (index) =>
          Number.isSafeInteger(index) && index >= 0 && index < peers.length,
      )
    )
      throw new Error(
        "Handoff consumer index is absent from the admitted graph",
      );
    return {
      kind: note.kind,
      summary: note.summary,
      paths: note.paths,
      consumers: indices.map((index) => peers[index]!.id),
      ...(criterionIndex === undefined ? {} : { criterionIndex }),
    };
  });
  return parseWorkHandoffNotes({ notes });
}

function body(
  record:
    | Omit<ObjectiveKnowledgeRecord, "recordRef">
    | ObjectiveKnowledgeRecord,
): string {
  const {
    version,
    repository,
    objective,
    runId,
    configDigest,
    graphDigest: acceptedGraphDigest,
    itemId,
    attemptId,
    commitSha,
    treeSha,
    notes,
    sources,
  } = record;
  return JSON.stringify({
    version,
    repository,
    objective,
    runId,
    configDigest,
    graphDigest: acceptedGraphDigest,
    itemId,
    attemptId,
    commitSha,
    treeSha,
    notes,
    sources,
  });
}

function contentRef(ref: ContentRef): boolean {
  return (
    !!ref &&
    Object.keys(ref).every((key) =>
      ["digest", "bytes", "mediaType"].includes(key),
    ) &&
    /^[a-f0-9]{64}$/.test(ref.digest) &&
    Number.isSafeInteger(ref.bytes) &&
    ref.bytes >= 0 &&
    typeof ref.mediaType === "string" &&
    ref.mediaType.length > 0
  );
}

/** State-loader authentication binds notes to one retained producer result. */
export function assertObjectiveKnowledge(
  state: FactoryState,
  itemId: string,
  retainedWork: WorkState | undefined = state.work[itemId],
): void {
  const work = retainedWork;
  const record = work?.knowledge;
  if (!record) return;
  parseWorkHandoffNotes({ notes: record.notes });
  const knownGraph =
    record.graphDigest === graphDigest(state.graph)
      ? state.graph
      : state.graphRevisions?.find(
          (revision) => revision.digest === record.graphDigest,
        )?.graph;
  if (
    Object.keys(record).some(
      (key) =>
        ![
          "version",
          "repository",
          "objective",
          "runId",
          "configDigest",
          "graphDigest",
          "itemId",
          "attemptId",
          "commitSha",
          "treeSha",
          "recordRef",
          "notes",
          "sources",
        ].includes(key),
    ) ||
    record.version !== 1 ||
    record.repository !== state.repository ||
    record.objective !== state.objective ||
    record.runId !== state.runId ||
    record.configDigest !== state.configDigest ||
    !knownGraph ||
    record.itemId !== itemId ||
    typeof record.attemptId !== "string" ||
    !record.attemptId ||
    record.attemptId !== work.attempt ||
    (work.graphRevisionDigest !== undefined &&
      record.graphDigest !== work.graphRevisionDigest) ||
    !gitSha(record.commitSha) ||
    !gitSha(record.treeSha) ||
    !Array.isArray(record.sources) ||
    record.sources.length > 128 ||
    new Set(record.sources.map((source) => source.path)).size !==
      record.sources.length ||
    !record.sources.every(
      (source) =>
        Object.keys(source).every((key) => ["path", "ref"].includes(key)) &&
        filePath(source.path) &&
        contentRef(source.ref) &&
        record.notes.some((note) => note.paths.includes(source.path)),
    ) ||
    record.notes.some((note) =>
      note.consumers.some(
        (id) => !knownGraph?.items.some((peer) => peer.id === id),
      ),
    ) ||
    record.notes.some(
      (note) =>
        note.criterionIndex !== undefined &&
        note.criterionIndex >=
          (knownGraph?.items.find((peer) => peer.id === itemId)?.acceptance
            .length ?? 0),
    ) ||
    !contentRef(record.recordRef) ||
    record.recordRef.mediaType !== "application/json" ||
    record.recordRef.digest !== digest(body(record)) ||
    record.recordRef.bytes !== Buffer.byteLength(body(record))
  )
    throw new Error(
      "Objective knowledge differs from its immutable scope or result",
    );
}

export async function publishObjectiveKnowledge(
  state: FactoryState,
  item: WorkItem,
  result: ExecutionResult,
  store: ContentStore,
): Promise<void> {
  if (!result.handoff) return;
  const work = state.work[item.id]!;
  const notes = parseWorkHandoffNotes({ notes: result.handoff.notes });
  if (
    notes.some((note) =>
      note.consumers.some(
        (id) => !state.graph.items.some((peer) => peer.id === id),
      ),
    )
  )
    throw workFault("Handoff consumer is absent from the accepted graph");
  const payload: Omit<ObjectiveKnowledgeRecord, "recordRef"> = {
    version: 1,
    repository: state.repository,
    objective: state.objective,
    runId: state.runId,
    configDigest: state.configDigest,
    graphDigest: work.graphRevisionDigest ?? graphDigest(state.graph),
    itemId: item.id,
    attemptId: work.attempt!,
    commitSha: result.changeRef,
    treeSha: result.treeSha,
    notes,
    sources: result.handoff.sources,
  };
  const recordRef = await store.put(
    new ReadableStream({
      start(controller) {
        controller.enqueue(Buffer.from(body(payload)));
        controller.close();
      },
    }),
    { mediaType: "application/json" },
  );
  const record: ObjectiveKnowledgeRecord = { ...payload, recordRef };
  if (
    work.knowledge &&
    JSON.stringify(work.knowledge) !== JSON.stringify(record)
  )
    throw new Error(
      "An immutable Objective knowledge record cannot be replaced",
    );
  work.knowledge = record;
  assertObjectiveKnowledge(state, item.id);
}

/** A compact view of settled claims, with actual availability in this execution base. */
export function objectiveKnowledgeView(
  state: FactoryState,
  item: WorkItem,
  checkout: string,
  baseSha: string,
  options?: { includeOwnClaims?: true; objectiveReview?: true },
) {
  const ancestors = new Set<string>();
  const visit = (id: string) => {
    if (ancestors.has(id)) return;
    ancestors.add(id);
    for (const dependency of state.graph.items.find((peer) => peer.id === id)
      ?.dependencies ?? [])
      visit(dependency);
  };
  for (const dependency of item.dependencies) visit(dependency);
  const selected: KnowledgeViewEntry[] = [];
  for (const peer of state.graph.items) {
    const work = state.work[peer.id];
    const ownClaim = options?.includeOwnClaims && peer.id === item.id;
    // Native stacks dispatch the next layer after the predecessor's exact
    // validation/review and publication, before the whole stack integrates.
    const acceptedPublished =
      work?.status === "published" &&
      work.validation?.treeSha === work.treeSha &&
      work.validation?.criteria?.length === peer.acceptance.length &&
      work.validation.criteria.every(
        (finding, index) =>
          finding.criterion === peer.acceptance[index] &&
          (finding.verdict === "pass" ||
            (finding.verdict === "human-accept" &&
              work.acceptanceDecisions?.some(
                (decision) =>
                  decision.criterion === finding.criterion &&
                  decision.treeSha === work.treeSha &&
                  decision.outcome === "accept",
              ))),
      );
    if (
      (peer.id === item.id && !ownClaim) ||
      (work?.status !== "done" && !acceptedPublished && !ownClaim) ||
      !work?.knowledge
    )
      continue;
    assertObjectiveKnowledge(state, peer.id);
    const record = work.knowledge;
    for (const note of record.notes) {
      // A verification map indexes its own item's review, not other workers.
      if (
        note.kind === "verification" &&
        !ownClaim &&
        !options?.objectiveReview
      )
        continue;
      if (
        !options?.objectiveReview &&
        !ownClaim &&
        !ancestors.has(peer.id) &&
        !note.consumers.includes(item.id) &&
        !note.paths.some((path) => ownsPath(path, item.ownedPaths))
      )
        continue;
      const sources = note.paths.map((path) => {
        const source = record.sources.find((entry) => entry.path === path);
        let current: Buffer | undefined;
        const entry = pinnedGitRaw(
          checkout,
          "ls-tree",
          "-z",
          baseSha,
          "--",
          path,
        ).toString("utf8");
        const blob = /^(100644|100755) blob ([a-f0-9]{40,64})\t/.exec(
          entry,
        )?.[2];
        if (blob) current = pinnedGitRaw(checkout, "cat-file", "blob", blob);
        return {
          path,
          ...(source ? { ref: source.ref } : {}),
          availability:
            source &&
            current &&
            digest(current) === source.ref.digest &&
            current.length === source.ref.bytes
              ? "current-bytes"
              : current
                ? "changed-or-unbound-bytes"
                : "unavailable-in-execution-base",
        };
      });
      const entry = {
        producerItem: peer.id,
        producerAttempt: record.attemptId,
        producerGraphDigest: record.graphDigest,
        producerCommitSha: record.commitSha,
        producerTreeSha: record.treeSha,
        recordRef: record.recordRef,
        relationship: ancestors.has(peer.id)
          ? "settled-dependency"
          : ownClaim
            ? "current-item-implementation-claim"
            : "cross-branch-lead",
        producerDisposition: ownClaim
          ? "implementation-claims-without-acceptance-authority"
          : "settled-result-claims-without-inherited-verdict",
        authority: "advisory-agent-claim",
        kind: note.kind,
        ...(note.criterionIndex === undefined
          ? {}
          : { criterionIndex: note.criterionIndex }),
        summary: note.summary,
        sources,
      };
      selected.push(entry);
    }
  }
  return {
    repository: state.repository,
    objective: state.objective,
    runId: state.runId,
    configDigest: state.configDigest,
    graphDigest: graphDigest(state.graph),
    itemId: item.id,
    executionBaseCommitSha: baseSha,
    entries: selected,
    interpretation:
      "Summaries remain advisory, including interface claims. Only current-bytes authenticates identical referenced file bytes in this checkout; it does not authenticate the claim or transfer prior validation/acceptance. Changed or unavailable sources are historical investigation leads. Own requirements, pinned inputs and human decisions remain authoritative.",
  };
}

/** Full selected source bytes accompany settled interfaces; claims never become proof. */
export async function completeObjectiveKnowledge(input: {
  state: FactoryState;
  item: WorkItem;
  checkout: string;
  baseSha: string;
  store: ContentStore;
  review?: "result" | "objective";
  suppliedDigests?: string[];
}): Promise<{
  view: object;
  selections: AdaptiveContextSelection[];
  suppliedBodies: { ref: ContentRef; bytes: Uint8Array }[];
}> {
  const view = objectiveKnowledgeView(
    input.state,
    input.item,
    input.checkout,
    input.baseSha,
    input.review === "objective"
      ? { objectiveReview: true }
      : input.review === "result"
        ? { includeOwnClaims: true }
        : undefined,
  );
  const bodies = new Map<
    string,
    { ref: ContentRef; encoding: "base64"; bytes: string }
  >();
  const selections: AdaptiveContextSelection[] = [];
  for (const entry of view.entries) {
    await input.store.verify(entry.recordRef);
    const refs: ContentRef[] = [entry.recordRef];
    for (const source of entry.sources) {
      if (!source.ref) {
        if (
          entry.relationship === "settled-dependency" &&
          entry.kind === "interface"
        )
          throw new Error(
            "Required settled interface lacks its complete bound source body",
          );
        continue;
      }
      refs.push(source.ref);
      if (
        bodies.has(source.ref.digest) ||
        input.suppliedDigests?.includes(source.ref.digest)
      )
        continue;
      const bytes = await readAdaptiveContextBytes(input.store, source.ref);
      bodies.set(source.ref.digest, {
        ref: source.ref,
        encoding: "base64",
        bytes: bytes.toString("base64"),
      });
    }
    selections.push({
      id: `interface:${entry.producerItem}:${entry.producerAttempt}:${digest(JSON.stringify(entry))}`,
      kind: "interface",
      disposition: entry.sources.every(
        (source) => source.availability === "current-bytes",
      )
        ? "current"
        : "historical",
      required:
        entry.relationship === "settled-dependency" &&
        entry.kind === "interface",
      refs,
    });
  }
  return {
    suppliedBodies: [...bodies.values()].map((body) => ({
      ref: body.ref,
      bytes: Buffer.from(body.bytes, "base64"),
    })),
    view: {
      ...view,
      bodies: [...bodies.values()],
      suppliedBodyDigests: input.suppliedDigests ?? [],
    },
    selections,
  };
}

/** Review sees declarations as claims; only current independent evidence proves acceptance. */
export function reviewObjectiveKnowledge(
  state: FactoryState,
  itemId: string | undefined,
  checkout: string,
  candidateCommitSha: string,
): ResultReviewEvidenceSource[] {
  const item =
    itemId === undefined
      ? {
          ...state.graph.items[0]!,
          id: "objective-review",
          dependencies: state.graph.items.map((peer) => peer.id),
          ownedPaths: [],
        }
      : state.graph.items.find((peer) => peer.id === itemId);
  if (!item)
    throw new Error("Knowledge review item is absent from the accepted graph");
  const view = objectiveKnowledgeView(
    state,
    item,
    checkout,
    candidateCommitSha,
    itemId === undefined
      ? { objectiveReview: true }
      : { includeOwnClaims: true },
  );
  return [
    {
      path: "Controller-scoped Objective knowledge declarations (advisory claims only)",
      origin: "controller",
      complete: true,
      content: JSON.stringify({
        purpose:
          "This entry authenticates retained declarations, producer scopes and referenced file-byte availability only. It supplies no semantic acceptance proof or inherited verdict. Independently check every required criterion using current exact candidate files, pinned requirements and current command receipts. Current-item notes may be entirely unaccepted implementer claims; historical or unavailable file bytes never supply missing current evidence.",
        candidateCommitSha,
        reviewRole: itemId === undefined ? "objective-review" : "result-review",
        view,
      }),
    },
  ];
}
