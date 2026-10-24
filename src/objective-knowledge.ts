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
import { DESIGN_QUESTIONS } from "./compiler/work-item-rubric.js";
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
  designRisk?: WorkHandoffNote["designRisk"];
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
/**
 * One design note per design risk: an answer and the file:line locations it rests on. Decision:
 * half the verification-note limits, because a note answers one question, not a whole criterion.
 */
const DESIGN_LIMIT = { summary: 2048, paths: 8 };
/** Every design risk a note may answer: the generic questions, then the repository's own. */
const designRisks: readonly string[] = [
  ...Object.keys(DESIGN_QUESTIONS),
  "repository",
];

/**
 * The most distinct files one item's handoff can cite: every learning note and
 * every criterion's verification map at its path limit. Each cited file
 * becomes one retained source.
 */
export function maxHandoffSources(criterionCount: number): number {
  return (
    LEARNING_LIMIT.notes * LEARNING_LIMIT.paths +
    criterionCount * VERIFICATION_LIMIT.paths +
    designRisks.length * DESIGN_LIMIT.paths
  );
}

const noteKinds = [
  "interface",
  "pitfall",
  "hypothesis",
  "verification",
  "design",
];
/** Verification and design notes describe one result for its own review. */
const reviewNote = (kind: unknown) =>
  kind === "verification" || kind === "design";
/** Name a key in an error without echoing more than a short bound of model text. */
const keyName = (key: string) =>
  JSON.stringify(key.length > 64 ? `${key.slice(0, 64)}…` : key);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** Missing and unexpected keys, so a worker can repair the whole object at once. */
function keyProblems(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): string[] {
  const unexpected = Object.keys(value).filter(
    (key) => !required.includes(key) && !optional.includes(key),
  );
  const missing = required.filter((key) => !Object.hasOwn(value, key));
  return [
    ...(unexpected.length
      ? [`unexpected key ${unexpected.map(keyName).join(", ")}`]
      : []),
    ...(missing.length ? [`missing key ${missing.join(", ")}`] : []),
  ];
}

/** Checks shared by the wire declaration and the controller's own record. */
function noteFieldProblems(note: Record<string, unknown>): string[] {
  const problems: string[] = [];
  const verification = note.kind === "verification";
  const design = note.kind === "design";
  const limit = verification
    ? VERIFICATION_LIMIT
    : design
      ? DESIGN_LIMIT
      : LEARNING_LIMIT;
  if (Object.hasOwn(note, "kind") && !noteKinds.includes(note.kind as string))
    problems.push(`kind must be one of ${noteKinds.join(", ")}`);
  if (verification) {
    if (
      !Number.isSafeInteger(note.criterionIndex) ||
      (note.criterionIndex as number) < 0
    )
      problems.push("a verification note needs an integer criterionIndex >= 0");
  } else if (note.criterionIndex !== undefined)
    problems.push("criterionIndex is allowed only on verification notes");
  if (design) {
    if (!designRisks.includes(note.designRisk as string))
      problems.push(
        `a design note needs a designRisk, one of ${designRisks.join(", ")}`,
      );
  } else if (note.designRisk !== undefined)
    problems.push("designRisk is allowed only on design notes");
  if (Object.hasOwn(note, "summary")) {
    if (typeof note.summary !== "string" || !note.summary.trim())
      problems.push("summary must be a non-empty string");
    else if (note.summary.length > limit.summary)
      problems.push(
        `summary has ${note.summary.length} characters; at most ${limit.summary} for this kind`,
      );
  }
  if (Object.hasOwn(note, "paths")) {
    if (!Array.isArray(note.paths))
      problems.push("paths must be an array of repository file paths");
    else {
      if (note.paths.length > limit.paths)
        problems.push(
          `paths has ${note.paths.length} entries; at most ${limit.paths} for this kind`,
        );
      const invalid = note.paths.findIndex((path) => !filePath(path));
      if (invalid >= 0)
        problems.push(
          `paths[${invalid}] is not a literal repository file path (no directory, .git or .factory- staging path)`,
        );
      if (new Set(note.paths).size !== note.paths.length)
        problems.push("paths has duplicate entries");
    }
  }
  return problems;
}

/** Note-count limits over the notes that are objects. */
function countProblems(notes: readonly Record<string, unknown>[]): string[] {
  const problems: string[] = [];
  const verifications = notes.filter((note) => note.kind === "verification");
  const learning = notes.filter((note) => !reviewNote(note.kind)).length;
  if (learning > LEARNING_LIMIT.notes)
    problems.push(
      `${learning} learning notes; at most ${LEARNING_LIMIT.notes} are allowed`,
    );
  const criteria = verifications.map((note) => note.criterionIndex);
  const repeated = criteria.filter(
    (criterion, index) => criteria.indexOf(criterion) !== index,
  );
  if (repeated.length)
    problems.push(
      `more than one verification note for criterionIndex ${[...new Set(repeated)].map(String).join(", ")}; write exactly one per criterion`,
    );
  const risks = notes
    .filter((note) => note.kind === "design")
    .map((note) => note.designRisk);
  const repeatedRisks = risks.filter(
    (risk, index) => risks.indexOf(risk) !== index,
  );
  if (repeatedRisks.length)
    problems.push(
      `more than one design note for designRisk ${[...new Set(repeatedRisks)].map(String).join(", ")}; write exactly one per risk`,
    );
  return problems;
}

/** One error naming every structural problem found, bounded for prompts and records. */
function handoffError(problems: readonly string[]): Error {
  const shown = problems.slice(0, 12);
  return new Error(
    `Handoff manifest is invalid:${shown.map((problem) => `\n- ${problem}`).join("")}${problems.length > shown.length ? `\n- and ${problems.length - shown.length} more` : ""}`,
  );
}

/** Reject malformed optional data; the controller never repairs model claims. */
function parseWorkHandoffNotes(value: unknown): WorkHandoffNote[] {
  if (!isRecord(value))
    throw handoffError(["the manifest must be an object with a notes array"]);
  const problems = keyProblems(value, ["notes"], []);
  if (!Array.isArray(value.notes))
    throw handoffError([...problems, "notes must be an array"]);
  const objects: Record<string, unknown>[] = [];
  value.notes.forEach((raw: unknown, index) => {
    if (!isRecord(raw)) {
      problems.push(`note ${index} must be an object`);
      return;
    }
    objects.push(raw);
    const consumers = raw.consumers;
    const noteProblems = [
      ...keyProblems(
        raw,
        ["kind", "summary", "paths", "consumers"],
        ["criterionIndex", "designRisk"],
      ),
      ...noteFieldProblems(raw),
    ];
    if (Object.hasOwn(raw, "consumers"))
      if (
        !Array.isArray(consumers) ||
        consumers.length > 16 ||
        !consumers.every(
          (id) =>
            typeof id === "string" &&
            id.length > 0 &&
            id.length <= 128 &&
            !id.includes("\0"),
        ) ||
        new Set(consumers).size !== consumers.length
      )
        noteProblems.push(
          "consumers must be at most 16 distinct Work Item identities",
        );
      else if (reviewNote(raw.kind) && consumers.length !== 0)
        noteProblems.push(`a ${String(raw.kind)} note must have no consumers`);
    if (noteProblems.length)
      problems.push(`note ${index}: ${noteProblems.join("; ")}`);
  });
  problems.push(...countProblems(objects));
  if (problems.length) throw handoffError(problems);
  const notes = (value.notes as WorkHandoffNote[]).map((note) => ({
    kind: note.kind,
    summary: note.summary,
    paths: [...note.paths],
    consumers: [...note.consumers],
    ...(note.kind === "verification"
      ? { criterionIndex: note.criterionIndex }
      : {}),
    ...(note.kind === "design" ? { designRisk: note.designRisk } : {}),
  }));
  const verifications = notes.filter((note) => note.kind === "verification");
  if (citedPaths(notes) > maxHandoffSources(verifications.length))
    throw handoffError([
      `notes cite more than ${maxHandoffSources(verifications.length)} distinct files`,
    ]);
  return notes;
}

function citedPaths(notes: readonly WorkHandoffNote[]): number {
  return new Set(notes.flatMap((note) => note.paths)).size;
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
  const design = {
    type: "object",
    additionalProperties: false,
    required: ["kind", "designRisk", "summary", "paths", "consumerIndices"],
    properties: {
      kind: { type: "string", const: "design" },
      designRisk: { type: "string", enum: designRisks },
      summary: {
        type: "string",
        minLength: 1,
        maxLength: DESIGN_LIMIT.summary,
      },
      paths: paths(DESIGN_LIMIT.paths),
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
        maxItems: LEARNING_LIMIT.notes + criterionCount + designRisks.length,
        items: {
          oneOf:
            criterionCount > 0
              ? [learning, verification, design]
              : [learning, design],
        },
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
  if (!isRecord(value))
    throw handoffError([
      "the manifest must be a JSON object whose only key is notes",
    ]);
  const extra = Object.keys(value).filter((key) => key !== "notes");
  const problems = extra.length
    ? [
        `unexpected top-level key ${extra.map(keyName).join(", ")}; the only top-level key is notes`,
      ]
    : [];
  if (!Array.isArray(value.notes))
    throw handoffError([...problems, "notes must be an array of note objects"]);
  if (
    criterionCount !== undefined &&
    value.notes.length >
      LEARNING_LIMIT.notes + criterionCount + designRisks.length
  )
    problems.push(
      `${value.notes.length} notes; at most ${LEARNING_LIMIT.notes} learning notes, one verification note for each of the ${criterionCount} criteria and one design note for each of the ${designRisks.length} design risks`,
    );
  const objects: Record<string, unknown>[] = [];
  value.notes.forEach((raw: unknown, index) => {
    if (!isRecord(raw)) {
      problems.push(`note ${index} must be an object`);
      return;
    }
    objects.push(raw);
    const noteProblems = [
      ...keyProblems(
        raw,
        ["kind", "summary", "paths", "consumerIndices"],
        ["criterionIndex", "designRisk"],
      ),
      ...noteFieldProblems(raw),
    ];
    const criterionIndex = raw.criterionIndex;
    if (
      Number.isSafeInteger(criterionIndex) &&
      criterionCount !== undefined &&
      (criterionIndex as number) >= criterionCount
    )
      noteProblems.push(
        `criterionIndex ${criterionIndex} names no acceptance criterion of this Work Item (it has ${criterionCount})`,
      );
    else if (
      criterionIndex !== undefined &&
      !Number.isSafeInteger(criterionIndex)
    )
      noteProblems.push("criterionIndex must be an integer");
    const indices = raw.consumerIndices;
    if (
      Object.hasOwn(raw, "consumerIndices") &&
      (!Array.isArray(indices) ||
        indices.length > 16 ||
        new Set(indices).size !== indices.length ||
        !indices.every(
          (index) =>
            Number.isSafeInteger(index) && index >= 0 && index < peers.length,
        ))
    )
      noteProblems.push(
        peers.length
          ? `consumerIndices must be at most 16 distinct integers from 0 to ${peers.length - 1}`
          : "consumerIndices must be [] (this Work Item has no peers)",
      );
    if (noteProblems.length)
      problems.push(`note ${index}: ${noteProblems.join("; ")}`);
  });
  problems.push(...countProblems(objects));
  if (problems.length) throw handoffError(problems);
  const notes = objects.map((note) => ({
    kind: note.kind,
    summary: note.summary,
    paths: note.paths,
    consumers: (note.consumerIndices as number[]).map(
      (index) => peers[index]!.id,
    ),
    ...(note.criterionIndex === undefined
      ? {}
      : { criterionIndex: note.criterionIndex }),
    ...(note.designRisk === undefined ? {} : { designRisk: note.designRisk }),
  }));
  const parsed = parseWorkHandoffNotes({ notes });
  if (
    criterionCount !== undefined &&
    citedPaths(parsed) > maxHandoffSources(criterionCount)
  )
    throw handoffError([
      `notes cite more than ${maxHandoffSources(criterionCount)} distinct files`,
    ]);
  return parsed;
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
    record.sources.length >
      maxHandoffSources(
        knownGraph?.items.find((peer) => peer.id === itemId)?.acceptance
          .length ?? 0,
      ) ||
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
  // Validate before keeping it: an invalid record must never enter state,
  // where every later save would refuse it.
  try {
    assertObjectiveKnowledge(state, item.id, { ...work, knowledge: record });
  } catch (error) {
    throw workFault(
      `Handoff knowledge is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  work.knowledge = record;
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
      // Result review judges the item's acceptance first, then the
      // Objective criteria it proves; every one must be accepted.
      work.validation?.criteria !== undefined &&
      work.validation.criteria.length >= peer.acceptance.length &&
      work.validation.criteria.every(
        (finding, index) =>
          (index >= peer.acceptance.length ||
            finding.criterion === peer.acceptance[index]) &&
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
      // Verification maps and design notes index their own item's review,
      // not other workers.
      if (reviewNote(note.kind) && !ownClaim && !options?.objectiveReview)
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
        ...(note.designRisk === undefined
          ? {}
          : { designRisk: note.designRisk }),
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
