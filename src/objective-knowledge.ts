import { createHash } from "node:crypto";
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

/** Reject malformed optional data; the controller never repairs model claims. */
export function parseWorkHandoffNotes(value: unknown): WorkHandoffNote[] {
  const declaration = value as { notes?: unknown } | null;
  if (
    !declaration ||
    typeof declaration !== "object" ||
    Array.isArray(value) ||
    Object.keys(declaration).some((key) => key !== "notes") ||
    !Array.isArray(declaration.notes) ||
    declaration.notes.length > 16
  )
    throw new Error("Handoff must be an object with at most 16 notes");
  return declaration.notes.map((raw: unknown) => {
    const note = raw as WorkHandoffNote | null;
    if (
      !note ||
      typeof note !== "object" ||
      Array.isArray(note) ||
      Object.keys(note).some(
        (key) => !["kind", "summary", "paths", "consumers"].includes(key),
      ) ||
      !["interface", "pitfall", "hypothesis"].includes(note.kind) ||
      typeof note.summary !== "string" ||
      !note.summary.trim() ||
      note.summary.length > 1024 ||
      !Array.isArray(note.paths) ||
      note.paths.length > 8 ||
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
        "Handoff note has invalid kind, summary, source paths or consumers",
      );
    return {
      kind: note.kind,
      summary: note.summary,
      paths: [...note.paths],
      consumers: [...note.consumers],
    };
  });
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
): object {
  const ancestors = new Set<string>();
  const visit = (id: string) => {
    if (ancestors.has(id)) return;
    ancestors.add(id);
    for (const dependency of state.graph.items.find((peer) => peer.id === id)
      ?.dependencies ?? [])
      visit(dependency);
  };
  for (const dependency of item.dependencies) visit(dependency);
  const selected: object[] = [];
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
