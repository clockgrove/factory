import { createHash, randomUUID } from "node:crypto";

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
export interface GraphReviewFinding {
  evidenceIds: string[];
  detail: string;
  question: string;
}
export interface ResolvedGraphFinding {
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
  const id = randomUUID();
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

/** JSON escaping prevents repository text from closing a controller delimiter. */
export function renderReviewPacket(packet: ReviewPacket): string {
  return JSON.stringify(packet);
}

export function reviewSchema(_packet: ReviewPacket, graph = false): unknown {
  return {
    type: "object",
    properties: {
      findings: {
        type: "array",
        items: {
          type: "object",
          properties: {
            ...(graph
              ? {}
              : {
                  criterionId: { type: "string" },
                  verdict: {
                    type: "string",
                    enum: ["pass", "needs-human", "refuse"],
                  },
                }),
            evidenceIds: {
              type: "array",
              items: { type: "string" },
            },
            detail: { type: "string" },
            question: { type: "string" },
          },
          required: [
            ...(graph ? [] : ["criterionId", "verdict"]),
            "evidenceIds",
            "detail",
            "question",
          ],
          additionalProperties: false,
        },
      },
    },
    required: ["findings"],
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
export function decodeReview(
  response: unknown,
  packet: ReviewPacket,
): {
  findings: (ReviewFinding | undefined)[];
  errors: (string | undefined)[];
  packetError?: string;
} {
  const root = object(response);
  if (
    Object.keys(root).some((key) => key !== "findings") ||
    !Array.isArray(root.findings)
  )
    throw new ReviewProtocolError(
      "Review response must contain only a findings array",
    );
  const grouped = new Map<string, unknown[]>();
  let packetError: string | undefined;
  for (const raw of root.findings) {
    if (
      !raw ||
      typeof raw !== "object" ||
      Array.isArray(raw) ||
      !packet.criteria.some(
        (c) => c.id === (raw as Record<string, unknown>).criterionId,
      )
    ) {
      packetError = "Review contains an unknown or malformed criterion ID";
      continue;
    }
    const id = (raw as Record<string, unknown>).criterionId as string;
    grouped.set(id, [...(grouped.get(id) ?? []), raw]);
  }
  const errors: (string | undefined)[] = [];
  const findings = packet.criteria.map((criterion, index) => {
    try {
      const candidates = grouped.get(criterion.id) ?? [];
      if (candidates.length !== 1)
        throw new ReviewProtocolError(
          "Review criterion ID is missing or duplicated",
        );
      const value = object(candidates[0]);
      if (
        Object.keys(value).some(
          (key) =>
            ![
              "criterionId",
              "verdict",
              "evidenceIds",
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
      resolveReviewReferences(value.evidenceIds, packet, verdict === "pass");
      return {
        criterionId: criterion.id,
        verdict,
        evidenceIds: value.evidenceIds as string[],
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
export function decodeGraphReview(
  response: unknown,
  packet: ReviewPacket,
): ResolvedGraphFinding[] {
  const root = object(response);
  if (
    Object.keys(root).some((key) => key !== "findings") ||
    !Array.isArray(root.findings)
  )
    throw new ReviewProtocolError(
      "Graph review must contain only a findings array",
    );
  return root.findings.map((raw) => {
    const value = object(raw);
    if (
      Object.keys(value).some(
        (key) => !["evidenceIds", "detail", "question"].includes(key),
      )
    )
      throw new ReviewProtocolError("Graph finding contains unknown fields");
    return {
      evidence: resolveReviewReferences(value.evidenceIds, packet, false),
      detail: text(value.detail, "detail"),
      question: text(value.question, "question"),
    };
  });
}
