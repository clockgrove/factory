import { isRecord } from "./graph.js";
import type { Finding, PinnedSource, PlannerDecision } from "./types.js";

/**
 * The plan review's evidence and answer. The reviewer cites evidence rows by
 * index: the operator's recorded answers, an amendment's operator answers
 * to its planners and its operator corrections, the pinned sources, then
 * the controller's execution bounds, native prerequisites and local
 * executable observations when supplied, and an amendment's discovery with
 * the files it cites. A finding is `fix` (the planner corrects the
 * plan within the Objective as written) or `operator-decision` (the
 * correction needs a decision only the operator owns). An answer whose shape
 * is invalid is flagged `invalid` with the reason; the step retries with it
 * and never accepts it.
 */

/** One evidence row the reviewer can cite. Labels and source text never grant authority. */
export interface ReviewEvidence {
  /** `repository`: a file an amendment's discovery cites (amendments.ts `citedFiles`). */
  origin: "source" | "controller" | "repository";
  path: string;
  /** A pinned source's exact heading; absent for the whole file. */
  heading?: string;
  content: string;
  complete: boolean;
}

/**
 * An operator's answer to an amendment's rejection that took in its
 * replacement (amendments.ts `rejectionStep`): a `replace` correction, or a
 * `replace-validation` authorization as its text. The review reads it as an
 * operator answer, as it does a recorded planning decision (#2247).
 */
export interface OperatorCorrection {
  /** The rejected amendment it answers. */
  rejectedAmendmentId: string;
  /** Why that amendment was rejected. */
  rejection: string;
  correction: string;
  by: string;
  /** When its replacement was taken in. */
  at: string;
}

/**
 * An operator's answer to a question an amendment's planner asked
 * (amendments.ts `amendPlanStep`): an `answer`'s text, or a
 * `replace-validation` authorization as its text. The review reads it as an
 * operator answer, as it does a correction (#2247).
 */
export interface OperatorAmendmentAnswer {
  /** The amendment in the replacement chain whose planner asked. */
  amendmentId: string;
  holdId: string;
  question: string;
  answer: string;
  /** Who gave it and when; an answer an earlier Factory kept has neither. */
  by?: string;
  at?: string;
}

/**
 * fix: the planner can correct the plan within the Objective as written.
 * operator-decision: the correction needs a decision only the operator owns.
 */
const GRAPH_FINDING_KINDS = ["fix", "operator-decision"] as const;
type GraphFindingKind = (typeof GRAPH_FINDING_KINDS)[number];

/** A decoded finding before it becomes a plain `Finding`. */
export interface GraphReviewFinding {
  kind: GraphFindingKind;
  /** Graph items the finding concerns; empty when it concerns the plan as a whole. */
  itemIds: string[];
  /** Paths of the evidence rows it cites. */
  evidence: string[];
  detail: string;
  question: string;
}

/**
 * A review finding as a plain `Finding` that keeps every item it concerns.
 * `itemId` is set too when there is exactly one.
 */
export interface ReviewFinding extends Finding {
  source: "review";
  kind: GraphFindingKind;
  itemIds: string[];
}

/** The evidence rows of a plan review, in a stable order for the provider cache. */
export function planningReviewEvidence(input: {
  sources: readonly PinnedSource[];
  decisions?: readonly PlannerDecision[];
  /** An amendment's operator answers to its planners' questions in its replacement chain, oldest first. */
  plannerAnswers?: readonly OperatorAmendmentAnswer[];
  /** An amendment's operator corrections in its replacement chain, oldest first. */
  corrections?: readonly OperatorCorrection[];
  /** The planning execution bounds (configured concurrency and limits). */
  executionBounds?: unknown;
  /** The Objective's native prerequisites. */
  prerequisites?: unknown;
  /** The controller's local executable observations. */
  localExecutables?: unknown;
  /** An amendment's discovery and the plan it amends. */
  amendment?: unknown;
  /** The files an amendment's discovery cites. */
  cited?: readonly { path: string; content: string; complete: boolean }[];
}): ReviewEvidence[] {
  const controller = (path: string, value: unknown): ReviewEvidence[] =>
    value === undefined || value === null
      ? []
      : [
          {
            origin: "controller",
            path,
            content: JSON.stringify(value),
            complete: true,
          },
        ];
  return [
    ...(input.decisions?.length
      ? [
          {
            origin: "controller" as const,
            path: "FACTORY_OPERATOR_PLANNING_DECISIONS",
            content: JSON.stringify(input.decisions),
            complete: true,
          },
        ]
      : []),
    ...(input.plannerAnswers?.length
      ? controller("FACTORY_OPERATOR_AMENDMENT_ANSWERS", input.plannerAnswers)
      : []),
    ...(input.corrections?.length
      ? controller("FACTORY_OPERATOR_AMENDMENT_CORRECTIONS", input.corrections)
      : []),
    ...input.sources.map((source) => ({
      origin: "source" as const,
      path: source.path,
      ...(source.heading ? { heading: source.heading } : {}),
      content: source.content,
      complete: true,
    })),
    ...controller("FACTORY_EXECUTION_BOUNDS", input.executionBounds),
    ...controller(
      "FACTORY_NATIVE_OBJECTIVE_PREREQUISITES",
      input.prerequisites,
    ),
    ...controller(
      "FACTORY_LOCAL_EXECUTABLE_OBSERVATIONS",
      input.localExecutables,
    ),
    ...controller("FACTORY_AMENDMENT", input.amendment),
    ...(input.cited ?? []).map((file) => ({
      origin: "repository" as const,
      ...file,
    })),
  ];
}

/** The graph review's answer schema. Index membership is decoder-enforced. */
export function graphReviewSchema(): Record<string, unknown> {
  const index = () => ({ type: "integer", minimum: 0 });
  return {
    type: "object",
    properties: {
      findings: {
        type: "array",
        items: {
          type: "object",
          properties: {
            kind: {
              type: "string",
              enum: [...GRAPH_FINDING_KINDS],
              description:
                "fix when the plan can be corrected within the Objective and supplied sources as written; operator-decision when the correction needs a product, scope or authority decision only the operator can make, asked in question.",
            },
            itemIds: { type: "array", items: { type: "string" } },
            evidenceIndices: {
              type: "array",
              description:
                "Select unique evidence binding indices, not body indices. Use [] when the finding cites only item fields.",
              items: index(),
            },
            detail: {
              type: "string",
              minLength: 1,
              description:
                "Nonempty text containing at least one non-whitespace character.",
            },
            question: { type: "string" },
          },
          required: [
            "kind",
            "itemIds",
            "evidenceIndices",
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

/** A decoded review answer, or an invalid one the step retries with `reason`. */
export type GraphReviewDecode =
  | { invalid: false; findings: ReviewFinding[]; decoded: GraphReviewFinding[] }
  | { invalid: true; reason: string };

/**
 * Decode one review answer. Every item id must be an item of the reviewed
 * graph; the field is required, and an empty array is a finding about the
 * plan as a whole. evidenceIndices may be empty or absent when a finding
 * cites only item fields. The first problem flags the answer `invalid`, with
 * a reason phrased so a retry with it can pass.
 */
export function decodeGraphReview(
  value: unknown,
  evidence: readonly ReviewEvidence[],
  graphItemIds: readonly string[],
): GraphReviewDecode {
  const invalid = (reason: string): GraphReviewDecode => ({
    invalid: true,
    reason,
  });
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => key !== "findings") ||
    !Array.isArray(value.findings)
  )
    return invalid(
      'The review answer must be an object with only a "findings" array.',
    );
  const decoded: GraphReviewFinding[] = [];
  for (const [at, raw] of value.findings.entries()) {
    const where = `Finding ${at}`;
    if (!isRecord(raw)) return invalid(`${where} must be an object.`);
    const unknown = Object.keys(raw).filter(
      (key) =>
        !["kind", "itemIds", "evidenceIndices", "detail", "question"].includes(
          key,
        ),
    );
    if (unknown.length)
      return invalid(
        `${where} has unknown fields ${unknown.join(", ")}; use only kind, itemIds, evidenceIndices, detail and question.`,
      );
    if (!GRAPH_FINDING_KINDS.includes(raw.kind as GraphFindingKind))
      return invalid(`${where} kind must be fix or operator-decision.`);
    if (
      !Array.isArray(raw.itemIds) ||
      new Set(raw.itemIds).size !== raw.itemIds.length ||
      raw.itemIds.some(
        (id) => typeof id !== "string" || !graphItemIds.includes(id),
      )
    )
      return invalid(
        `${where} itemIds must be a unique array of item ids in the reviewed graph (${graphItemIds.join(", ") || "none"}); use [] for the plan as a whole.`,
      );
    const indices = raw.evidenceIndices ?? [];
    if (
      !Array.isArray(indices) ||
      new Set(indices).size !== indices.length ||
      indices.some(
        (index) =>
          !Number.isSafeInteger(index) ||
          (index as number) < 0 ||
          (index as number) >= evidence.length,
      )
    )
      return invalid(
        `${where} evidenceIndices must be a unique array of evidence indices${evidence.length ? ` 0-${evidence.length - 1}` : " (there are no evidence rows, so use [])"}; use [] when the finding cites only item fields.`,
      );
    if (typeof raw.detail !== "string" || !raw.detail.trim())
      return invalid(`${where} detail must be nonempty text.`);
    if (typeof raw.question !== "string")
      return invalid(`${where} question must be text (it may be empty).`);
    const detail = raw.detail;
    const question = raw.question.trim();
    // A finding without a question is still a finding: its detail says what
    // to change. A detail with no words gives nothing to ask about, so the
    // finding is invalid review output.
    const subject = detail.trim().replace(/[.?!:;\s]+$/, "");
    if (!question && !/[\p{L}\p{N}]/u.test(subject))
      return invalid(
        `${where} needs a question or a detail to derive one from.`,
      );
    decoded.push({
      kind: raw.kind as GraphFindingKind,
      itemIds: raw.itemIds as string[],
      evidence: (indices as number[]).map((index) => evidence[index]!.path),
      detail,
      question:
        question || `How should the plan change to fix this: ${subject}?`,
    });
  }
  return { invalid: false, findings: decoded.map(reviewFinding), decoded };
}

/** A decoded finding as a `ReviewFinding`: the message carries question and evidence. */
function reviewFinding(finding: GraphReviewFinding): ReviewFinding {
  return {
    source: "review",
    kind: finding.kind,
    message: `${finding.detail}\nQuestion: ${finding.question}${finding.evidence.length ? `\nEvidence: ${finding.evidence.join(", ")}` : ""}`,
    itemIds: [...finding.itemIds],
    ...(finding.itemIds.length === 1 ? { itemId: finding.itemIds[0]! } : {}),
  };
}
