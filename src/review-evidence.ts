import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

/** Transient wire identities; labels and repository text never define authority. */
export interface ReviewEvidenceInput {
  origin: "source" | "controller";
  path: string;
  content: string;
  complete?: boolean;
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
  evidence: (ReviewEvidenceReference & { content: string })[];
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
function reviewPacketChoices(packet: ReviewPacket) {
  return {
    criteria: packet.criteria.map(({ text }, criterionIndex) => ({
      criterionIndex,
      text,
    })),
    evidence: packet.evidence.map(({ id: _id, ...entry }, evidenceIndex) => ({
      evidenceIndex,
      ...entry,
    })),
  };
}

/**
 * The packet as one JSON value. The packet id is fresh per call, so it comes
 * last and the choices before it stay a stable prompt prefix for the provider
 * cache.
 */
export function renderReviewPacket(packet: ReviewPacket): string {
  return JSON.stringify({
    ...reviewPacketChoices(packet),
    packetId: packet.id,
  });
}

/** The packet's repeatable choices without its per-call id; see `renderReviewPacketId`. */
export function renderReviewPacketChoices(packet: ReviewPacket): string {
  return JSON.stringify(reviewPacketChoices(packet));
}

/** The per-call packet id, rendered for the end of a prompt. */
export function renderReviewPacketId(packet: ReviewPacket): string {
  return JSON.stringify({ packetId: packet.id });
}

/** Packet-local choices; passing findings can cite only complete evidence. */
export function reviewSchema(packet: ReviewPacket, graph = false): unknown {
  const index = (length: number) => ({
    type: "integer",
    minimum: 0,
    // An empty packet has no valid selection; the decoder also checks membership.
    maximum: Math.max(0, length - 1),
  });
  const finding = (
    verdicts = ["pass", "needs-human", "refuse"],
    evidenceIndex: unknown = index(packet.evidence.length),
  ) => ({
    type: "object",
    properties: {
      ...(graph
        ? {}
        : {
            criterionIndex: index(packet.criteria.length),
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
        description: "Select unique evidence indices from this packet.",
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
  const completeIndices = packet.evidence.flatMap((entry, index) =>
    entry.complete ? [index] : [],
  );
  const items = graph
    ? finding()
    : {
        anyOf: [
          ...(completeIndices.length
            ? [finding(["pass"], { type: "integer", enum: completeIndices })]
            : []),
          finding(["needs-human"]),
          finding(["refuse"]),
        ],
      };
  return {
    type: "object",
    properties: {
      packetId: { type: "string", enum: [packet.id] },
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
    const { content: _content, ...reference } = entry;
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
