import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Current-call file bindings only; never persisted into canonical packets. */
export interface ReviewBodyFile {
  evidenceIndex: number;
  root: string;
  path: string;
  encoding: "utf-8";
  bytes: number;
  digest: string;
}

/** Transient wire identities; labels and repository text never define authority. */
export interface ReviewEvidenceInput {
  origin: "source" | "controller";
  path: string;
  content: string;
  complete?: boolean;
  /** Producer-approved literal component; offsets count JavaScript string units. */
  reusableBody?: { start: number; length: number; digest: string };
}
export interface ReviewEvidenceReference {
  id: string;
  origin: "source" | "controller";
  path: string;
  digest: string;
  complete: boolean;
}
export interface ReviewPacket {
  id: string;
  criteria: { id: string; text: string }[];
  evidence: (ReviewEvidenceReference &
    Pick<ReviewEvidenceInput, "content" | "reusableBody">)[];
}
export interface ReviewFinding {
  criterionId: string;
  verdict: "pass" | "needs-human" | "refuse";
  evidenceIds: string[];
  detail: string;
  question: string;
}
export interface ReviewChoiceFinding {
  criterionIndex: number;
  verdict: "pass" | "needs-human" | "refuse";
  evidenceIndices: number[];
  detail: string;
  question: string;
}
export interface GraphReviewFinding {
  /** Graph items the finding concerns; empty when it concerns the plan as a whole. */
  itemIds: string[];
  evidenceIndices: number[];
  detail: string;
  question: string;
}
export interface ResolvedGraphFinding {
  itemIds: string[];
  evidence: ReviewEvidenceReference[];
  detail: string;
  question: string;
}
export class ReviewProtocolError extends Error {
  override readonly name = "ReviewProtocolError";
}

export function reviewPacket(
  criteria: string[],
  sources: ReviewEvidenceInput[],
): ReviewPacket {
  return packetWithIdentity(randomUUID(), criteria, sources);
}

function packetWithIdentity(
  id: string,
  criteria: string[],
  sources: ReviewEvidenceInput[],
): ReviewPacket {
  const identity = (kind: string, index: number) =>
    createHash("sha256")
      .update(`${id}:${kind}:${index}`)
      .digest("hex")
      .slice(0, 24);
  return {
    id,
    criteria: criteria.map((text, index) => ({
      id: identity("criterion", index),
      text,
    })),
    evidence: sources.map((source, index) => ({
      ...source,
      id: identity("evidence", index),
      digest: createHash("sha256").update(source.content).digest("hex"),
      complete: source.complete !== false,
    })),
  };
}

/** Check a retained request; never assign its identity to a different request. */
export function assertReviewPacketBinding(
  packet: ReviewPacket,
  criteria: string[],
  sources: ReviewEvidenceInput[],
): void {
  if (
    !packet ||
    typeof packet.id !== "string" ||
    !packet.id ||
    !isDeepStrictEqual(
      JSON.parse(JSON.stringify(packet)),
      JSON.parse(
        JSON.stringify(packetWithIdentity(packet.id, criteria, sources)),
      ),
    )
  )
    throw new ReviewProtocolError(
      "Retained review packet differs from its inputs",
    );
}

/**
 * The packet's criteria and evidence as provider choices, which omit opaque
 * identities. This part repeats across calls over the same sources.
 */
function reviewPacketChoices(
  packet: ReviewPacket,
  files: ReviewBodyFile[] = [],
) {
  const bodyFiles = new Map<number, ReviewBodyFile>();
  for (const file of files) {
    const entry = packet.evidence[file.evidenceIndex];
    if (
      !Number.isSafeInteger(file.evidenceIndex) ||
      file.evidenceIndex < 0 ||
      !entry ||
      entry.origin !== "source" ||
      entry.complete !== true ||
      bodyFiles.has(file.evidenceIndex) ||
      file.path !== `pinned/${file.evidenceIndex}.txt` ||
      file.encoding !== "utf-8" ||
      file.digest !== entry.digest ||
      file.bytes !== Buffer.byteLength(entry.content) ||
      !lstatSync(file.root, { throwIfNoEntry: false })?.isDirectory() ||
      !lstatSync(join(file.root, "pinned"), {
        throwIfNoEntry: false,
      })?.isDirectory() ||
      !lstatSync(join(file.root, file.path), {
        throwIfNoEntry: false,
      })?.isFile() ||
      !readFileSync(join(file.root, file.path)).equals(
        Buffer.from(entry.content),
      )
    )
      throw new ReviewProtocolError(
        "Current review body file differs from its complete source",
      );
    bodyFiles.set(file.evidenceIndex, file);
  }
  const candidates = packet.evidence.map((entry) => {
    if (
      typeof entry.content !== "string" ||
      typeof entry.complete !== "boolean" ||
      !["source", "controller"].includes(entry.origin) ||
      typeof entry.path !== "string" ||
      !entry.path ||
      typeof entry.id !== "string" ||
      !entry.id ||
      digest(entry.content) !== entry.digest
    )
      throw new ReviewProtocolError("Review evidence content digest differs");
    const range = entry.reusableBody ?? {
      start: 0,
      length: entry.content.length,
      digest: entry.digest,
    };
    if (
      !Number.isSafeInteger(range.start) ||
      !Number.isSafeInteger(range.length) ||
      range.start < 0 ||
      range.length < 0 ||
      range.start + range.length > entry.content.length
    )
      throw new ReviewProtocolError("Review body selector is invalid");
    const content = entry.content.slice(
      range.start,
      range.start + range.length,
    );
    if (
      digest(content) !== range.digest ||
      Buffer.from(content, "utf8").toString("utf8") !== content
    )
      throw new ReviewProtocolError("Review body bytes/digest differ");
    return {
      content,
      range,
      key: `${range.digest}:${entry.complete}:${entry.origin}`,
    };
  });
  const counts = new Map<string, number>();
  for (const { key } of candidates) counts.set(key, (counts.get(key) ?? 0) + 1);
  const bodies: {
    bodyIndex: number;
    encoding: "utf-8";
    bytes: number;
    digest: string;
    complete: boolean;
    content: string;
  }[] = [];
  const indices = new Map<string, number>();
  // Keep complete normative source bodies inline ahead of dynamic bindings.
  for (const [index, entry] of packet.evidence.entries()) {
    const body = candidates[index]!;
    if (entry.origin !== "controller" || counts.get(body.key)! < 2) continue;
    const prior = indices.get(body.key);
    if (prior !== undefined) {
      if (bodies[prior]!.content !== body.content)
        throw new ReviewProtocolError("Conflicting review body bytes");
      continue;
    }
    const bodyIndex = bodies.length;
    indices.set(body.key, bodyIndex);
    bodies.push({
      bodyIndex,
      encoding: "utf-8",
      bytes: Buffer.byteLength(body.content),
      digest: body.range.digest,
      complete: entry.complete,
      content: body.content,
    });
  }
  const choices = {
    ...(bodies.length ? { bodies } : {}),
    evidence: packet.evidence.map(
      ({ id: _id, reusableBody: _range, content, ...entry }, evidenceIndex) => {
        const body = candidates[evidenceIndex]!;
        const bodyIndex = indices.get(body.key);
        const file = bodyFiles.get(evidenceIndex);
        return {
          evidenceIndex,
          ...entry,
          content: file
            ? {
                file: file.path,
                encoding: file.encoding,
                bytes: file.bytes,
                digest: file.digest,
              }
            : bodyIndex === undefined
              ? content
              : {
                  prefix: content.slice(0, body.range.start),
                  bodyIndex,
                  suffix: content.slice(body.range.start + body.range.length),
                },
        };
      },
    ),
    criteria: packet.criteria.map(({ text }, criterionIndex) => ({
      criterionIndex,
      text,
    })),
  };
  for (const [index, entry] of packet.evidence.entries())
    if (resolveReviewBodyContent(choices, index, packet) !== entry.content)
      throw new ReviewProtocolError(
        "Review literal binding differs from its source",
      );
  return choices;
}

function digest(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Resolve only exact supplied literal spans; no normalization or label aliases. */
export function resolveReviewBodyContent(
  choices: ReturnType<typeof reviewPacketChoices>,
  evidenceIndex: number,
  packet: ReviewPacket,
): string {
  const entry = choices.evidence[evidenceIndex];
  const binding = packet.evidence[evidenceIndex];
  if (
    !entry ||
    !binding ||
    entry.origin !== binding.origin ||
    entry.path !== binding.path ||
    entry.digest !== binding.digest ||
    entry.complete !== binding.complete ||
    !Number.isSafeInteger(evidenceIndex) ||
    entry.evidenceIndex !== evidenceIndex ||
    typeof entry.complete !== "boolean"
  )
    throw new ReviewProtocolError("Review binding index is invalid");
  let content: string;
  if (typeof entry.content === "string") content = entry.content;
  else if ("file" in entry.content) {
    if (
      entry.content.file !== `pinned/${evidenceIndex}.txt` ||
      entry.content.encoding !== "utf-8" ||
      entry.content.bytes !== Buffer.byteLength(binding.content) ||
      entry.content.digest !== binding.digest
    )
      throw new ReviewProtocolError(
        "Review body file binding differs from its source",
      );
    content = binding.content;
  } else {
    if (
      !entry.content ||
      typeof entry.content.prefix !== "string" ||
      typeof entry.content.suffix !== "string" ||
      !Number.isSafeInteger(entry.content.bodyIndex)
    )
      throw new ReviewProtocolError("Review body reference is invalid");
    const body = choices.bodies?.[entry.content.bodyIndex];
    if (
      !body ||
      body.bodyIndex !== entry.content.bodyIndex ||
      body.complete !== entry.complete ||
      body.encoding !== "utf-8" ||
      body.bytes !== Buffer.byteLength(body.content) ||
      body.digest !== digest(body.content)
    )
      throw new ReviewProtocolError(
        "Review body reference is unresolved or conflicting",
      );
    content = entry.content.prefix + body.content + entry.content.suffix;
  }
  if (digest(content) !== entry.digest || content !== binding.content)
    throw new ReviewProtocolError("Review literal binding digest differs");
  return content;
}

/**
 * The packet as one JSON value. The packet id is fresh per call, so it comes
 * last and the choices before it stay a stable prompt prefix for the provider
 * cache.
 */
export function renderReviewPacket(
  packet: ReviewPacket,
  files?: ReviewBodyFile[],
): string {
  return JSON.stringify({
    ...reviewPacketChoices(packet, files),
    packetId: packet.id,
  });
}

/** The packet's repeatable choices without its per-call id; see `renderReviewPacketId`. */
export function renderReviewPacketChoices(
  packet: ReviewPacket,
  files?: ReviewBodyFile[],
): string {
  return JSON.stringify(reviewPacketChoices(packet, files));
}

/** The per-call packet id, rendered for the end of a prompt. */
export function renderReviewPacketId(packet: ReviewPacket): string {
  return JSON.stringify({ packetId: packet.id });
}

/** Packet-local choices; passing findings can cite only complete evidence. */
export function reviewSchema(packet: ReviewPacket, graph = false): unknown {
  reviewPacketChoices(packet);
  // Exact packet identity and current index membership stay decoder-enforced.
  // Stable wire schemas avoid changing the provider prefix for every packet.
  const index = () => ({ type: "integer", minimum: 0 });
  const finding = (
    verdicts = ["pass", "needs-human", "refuse"],
    evidenceIndex: unknown = index(),
  ) => ({
    type: "object",
    properties: {
      ...(graph
        ? {}
        : {
            criterionIndex: index(),
            verdict: {
              type: "string",
              enum: verdicts,
            },
          }),
      ...(graph
        ? { itemIds: { type: "array", items: { type: "string" } } }
        : {}),
      evidenceIndices: {
        type: "array",
        minItems: 1,
        description:
          "Select unique evidence binding indices, not body indices.",
        items: evidenceIndex,
      },
      detail: {
        type: "string",
        minLength: 1,
        description:
          "Nonempty text containing at least one non-whitespace character.",
      },
      question: {
        type: "string",
        ...(verdicts.length === 1 && verdicts[0] === "needs-human"
          ? {
              minLength: 1,
              description:
                "A specific question containing at least one non-whitespace character.",
            }
          : {}),
      },
    },
    required: [
      ...(graph ? ["itemIds"] : ["criterionIndex", "verdict"]),
      "evidenceIndices",
      "detail",
      "question",
    ],
    additionalProperties: false,
  });
  const hasCompleteEvidence = packet.evidence.some((entry) => entry.complete);
  const items = graph
    ? finding()
    : {
        anyOf: [
          ...(hasCompleteEvidence
            ? [
                finding(["pass"], {
                  ...index(),
                  description:
                    "Select only evidence indices whose packet entries have complete true; incomplete entries cannot support a pass.",
                }),
              ]
            : []),
          finding(["needs-human"]),
          finding(["refuse"]),
        ],
      };
  return {
    type: "object",
    properties: {
      packetId: { type: "string" },
      findings: {
        type: "array",
        items,
      },
    },
    required: ["packetId", "findings"],
    additionalProperties: false,
  };
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ReviewProtocolError("Review response/finding must be an object");
  return value as Record<string, unknown>;
}
function text(value: unknown, field: string, required = true): string {
  if (typeof value !== "string" || (required && !value.trim()))
    throw new ReviewProtocolError(
      `Review ${field} must be ${required ? "nonempty " : ""}text`,
    );
  return value;
}
export function resolveReviewReferences(
  ids: unknown,
  packet: ReviewPacket,
  requireComplete: boolean,
): ReviewEvidenceReference[] {
  if (
    !Array.isArray(ids) ||
    ids.length === 0 ||
    new Set(ids).size !== ids.length
  )
    throw new ReviewProtocolError(
      "Review evidence IDs must be a nonempty unique array",
    );
  return ids.map((id) => {
    const entry = packet.evidence.find((source) => source.id === id);
    if (!entry)
      throw new ReviewProtocolError(
        "Review evidence ID is unknown to this packet",
      );
    if (requireComplete && !entry.complete)
      throw new ReviewProtocolError(
        "A passing review cannot rely on incomplete cited evidence",
      );
    const { content: _content, reusableBody: _body, ...reference } = entry;
    return reference;
  });
}
function reviewResponse(response: unknown, packet: ReviewPacket): unknown[] {
  const root = object(response);
  if (
    root.packetId !== packet.id ||
    Object.keys(root).some((key) => !["packetId", "findings"].includes(key)) ||
    !Array.isArray(root.findings)
  )
    throw new ReviewProtocolError(
      "Review response requires this exact packetId and a findings array",
    );
  return root.findings;
}

function reviewEvidenceIds(value: unknown, packet: ReviewPacket): string[] {
  if (
    !Array.isArray(value) ||
    !value.length ||
    new Set(value).size !== value.length
  )
    throw new ReviewProtocolError(
      "Review evidence indices must be a nonempty unique array",
    );
  return value.map((index) => {
    if (
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= packet.evidence.length
    )
      throw new ReviewProtocolError(
        "Review evidence index is invalid for this packet",
      );
    return packet.evidence[index]!.id;
  });
}

export function decodeReview(
  response: unknown,
  packet: ReviewPacket,
): {
  findings: (ReviewFinding | undefined)[];
  errors: (string | undefined)[];
  packetError?: string;
} {
  reviewPacketChoices(packet);
  const rawFindings = reviewResponse(response, packet);
  const grouped = new Map<number, unknown[]>();
  let packetError: string | undefined;
  for (const raw of rawFindings) {
    if (
      !raw ||
      typeof raw !== "object" ||
      Array.isArray(raw) ||
      !Number.isSafeInteger((raw as Record<string, unknown>).criterionIndex) ||
      ((raw as Record<string, unknown>).criterionIndex as number) < 0 ||
      ((raw as Record<string, unknown>).criterionIndex as number) >=
        packet.criteria.length
    ) {
      packetError = "Review contains an unknown or malformed criterion index";
      continue;
    }
    const index = (raw as Record<string, unknown>).criterionIndex as number;
    grouped.set(index, [...(grouped.get(index) ?? []), raw]);
  }
  const errors: (string | undefined)[] = [];
  const findings = packet.criteria.map((criterion, index) => {
    try {
      const candidates = grouped.get(index) ?? [];
      if (candidates.length !== 1)
        throw new ReviewProtocolError(
          "Review criterion index is missing or duplicated",
        );
      const value = object(candidates[0]);
      if (
        Object.keys(value).some(
          (key) =>
            ![
              "criterionIndex",
              "verdict",
              "evidenceIndices",
              "detail",
              "question",
            ].includes(key),
        )
      )
        throw new ReviewProtocolError("Review finding contains unknown fields");
      if (
        typeof value.verdict !== "string" ||
        !["pass", "needs-human", "refuse"].includes(value.verdict)
      )
        throw new ReviewProtocolError("Review verdict is invalid");
      const verdict = value.verdict as ReviewFinding["verdict"];
      const evidenceIds = reviewEvidenceIds(value.evidenceIndices, packet);
      resolveReviewReferences(evidenceIds, packet, verdict === "pass");
      return {
        criterionId: criterion.id,
        verdict,
        evidenceIds,
        detail: text(value.detail, "detail"),
        question: text(value.question, "question", verdict === "needs-human"),
      };
    } catch (error) {
      errors[index] = error instanceof Error ? error.message : String(error);
      return undefined;
    }
  });
  return { findings, errors, ...(packetError ? { packetError } : {}) };
}
function graphItemReferences(
  value: unknown,
  graphItemIds: readonly string[],
): string[] {
  if (
    !Array.isArray(value) ||
    new Set(value).size !== value.length ||
    value.some((id) => typeof id !== "string" || !graphItemIds.includes(id))
  )
    throw new ReviewProtocolError(
      "Graph finding item ids must be a unique array of items in the reviewed graph",
    );
  return value as string[];
}

/**
 * Findings name the graph items they concern. Every id must be an item of
 * the reviewed graph. The field is required: an empty array is a finding
 * about the plan as a whole, and a missing field is invalid review output.
 */
export function decodeGraphReview(
  response: unknown,
  packet: ReviewPacket,
  graphItemIds: readonly string[],
): ResolvedGraphFinding[] {
  reviewPacketChoices(packet);
  return reviewResponse(response, packet).map((raw) => {
    const value = object(raw);
    if (
      Object.keys(value).some(
        (key) =>
          !["itemIds", "evidenceIndices", "detail", "question"].includes(key),
      )
    )
      throw new ReviewProtocolError("Graph finding contains unknown fields");
    const detail = text(value.detail, "detail");
    const question = text(value.question, "question", false).trim();
    // A finding without a question is still a finding: its detail says what
    // to change. A detail with no words gives nothing to ask about, so the
    // finding is invalid review output.
    const subject = detail.trim().replace(/[.?!:;\s]+$/, "");
    if (!question && !/[\p{L}\p{N}]/u.test(subject))
      throw new ReviewProtocolError(
        "Review finding needs a question or a detail to derive one from",
      );
    return {
      itemIds: graphItemReferences(value.itemIds, graphItemIds),
      evidence: resolveReviewReferences(
        reviewEvidenceIds(value.evidenceIndices, packet),
        packet,
        false,
      ),
      detail,
      question:
        question || `How should the plan change to fix this: ${subject}?`,
    };
  });
}
