import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { StepFault } from "./fault.js";
import { graphDigest } from "./graph-amendments.js";
import type { FailureDisposition } from "./repair-policy.js";
import { assertCommandReceipts } from "./result-evidence.js";
import type {
  ReviewEvidenceReference,
  ReviewFinding,
} from "./review-evidence.js";
import type { FactoryState, WorkState } from "./state.js";
import { refuseUnknownFields } from "./unknown-fields.js";
import {
  type AcceptanceDecision,
  assertValidationWorktreeObservation,
  type ValidationEvidence,
} from "./validation-evidence.js";

/** Produced only by a decoded refusal or an exact-tree operator decision. */
export type SemanticRefusalEvidence = {
  treeSha: string;
  criterion: string;
} & (
  | {
      source: "model";
      finding: ReviewFinding;
      evidence: ReviewEvidenceReference[];
    }
  | { source: "operator"; decision: AcceptanceDecision }
);

/** The existing failure binds passing commands without relabeling them as failed. */
export type SemanticRefusalRecord = SemanticRefusalEvidence & {
  validationDigest: string;
};
/** Keep the existing work-fault wire shape; retain typed producer evidence locally. */
export class SemanticAcceptanceFailure extends StepFault {
  readonly semanticRefusal: SemanticRefusalEvidence;
  constructor(detail: string, evidence: SemanticRefusalEvidence) {
    super({ kind: "work", evidence: { detail } });
    this.semanticRefusal = structuredClone(evidence);
  }
}
export const semanticValidationDigest = (value: ValidationEvidence) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

const object = (value: unknown, keys: string[], label: string) => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} is invalid`);
  refuseUnknownFields(value as Record<string, unknown>, keys, label);
};

/** Reject conflicting, incomplete or rebound evidence; absence remains unknown. */
export function assertSemanticRefusalRecord(
  state: FactoryState,
  id: string,
  work: Pick<
    WorkState,
    | "treeSha"
    | "validation"
    | "failedValidation"
    | "graphRevisionDigest"
    | "acceptanceDecisions"
  >,
  failure: FailureDisposition | undefined,
): void {
  if (!failure || failure.semanticRefusal === undefined) return;
  const value = failure.semanticRefusal;
  object(
    value,
    [
      "treeSha",
      "criterion",
      "source",
      "finding",
      "evidence",
      "decision",
      "validationDigest",
    ],
    "Semantic refusal",
  );
  const graph = [
    state.graph,
    ...(state.graphRevisions ?? []).map((entry) => entry.graph),
  ].find((entry) => graphDigest(entry) === work.graphRevisionDigest);
  const item = graph?.items.find((entry) => entry.id === id);
  const validation = work.validation;
  if (
    work.failedValidation ||
    failure.validationCaptureDigest ||
    value.treeSha !== work.treeSha ||
    !/^[a-f0-9]{40}$/.test(value.treeSha) ||
    !item?.acceptance.includes(value.criterion) ||
    !validation ||
    value.validationDigest !== semanticValidationDigest(validation) ||
    validation.commands.length !== item.validation.length ||
    validation.commands.some(
      (command, index) => command.command !== item.validation[index]?.command,
    )
  )
    throw new Error(
      "Semantic refusal does not bind its original candidate and passing commands",
    );
  assertCommandReceipts(validation, value.treeSha, "Semantic refusal");
  assertValidationWorktreeObservation(
    validation.worktreeObservation,
    value.treeSha,
    validation.selectedLfs,
  );
  if (value.source === "model") {
    if ("decision" in value)
      throw new Error("Semantic refusal has conflicting producers");
    const finding = value.finding;
    object(
      finding,
      ["criterionId", "verdict", "evidenceIds", "detail", "question"],
      "Rejected finding",
    );
    if (
      finding.verdict !== "refuse" ||
      typeof finding.criterionId !== "string" ||
      !finding.criterionId ||
      typeof finding.detail !== "string" ||
      !finding.detail.trim() ||
      typeof finding.question !== "string" ||
      !Array.isArray(finding.evidenceIds) ||
      !Array.isArray(value.evidence) ||
      !finding.evidenceIds.length ||
      new Set(finding.evidenceIds).size !== finding.evidenceIds.length ||
      !isDeepStrictEqual(
        finding.evidenceIds,
        value.evidence.map((entry) => entry.id),
      ) ||
      failure.detail !==
        `Acceptance criterion disproved: ${value.criterion}: ${finding.detail}`
    )
      throw new Error("Semantic refusal lacks its exact rejected finding");
    for (const reference of value.evidence) {
      object(
        reference,
        ["id", "origin", "path", "digest", "complete"],
        "Rejected review reference",
      );
      if (
        typeof reference.id !== "string" ||
        !reference.id ||
        !["source", "controller"].includes(reference.origin) ||
        typeof reference.path !== "string" ||
        !reference.path ||
        !/^[a-f0-9]{64}$/.test(reference.digest) ||
        typeof reference.complete !== "boolean"
      )
        throw new Error("Semantic refusal review reference is invalid");
    }
  } else if (value.source === "operator") {
    if ("finding" in value || "evidence" in value)
      throw new Error("Semantic refusal has conflicting producers");
    const decision = value.decision;
    object(
      decision,
      ["criterion", "treeSha", "actor", "at", "outcome", "reason"],
      "Rejected decision",
    );
    if (
      decision.outcome !== "refuse" ||
      decision.criterion !== value.criterion ||
      decision.treeSha !== value.treeSha ||
      !Number.isFinite(Date.parse(decision.at)) ||
      typeof decision.actor !== "string" ||
      !decision.actor.trim() ||
      typeof decision.reason !== "string" ||
      !decision.reason.trim() ||
      !work.acceptanceDecisions?.some((entry) =>
        isDeepStrictEqual(entry, decision),
      ) ||
      ![
        `Acceptance refused: ${value.criterion}`,
        `Acceptance criterion refused by ${decision.actor}: ${value.criterion}`,
      ].includes(failure.detail)
    )
      throw new Error("Semantic refusal lacks its exact operator decision");
  } else throw new Error("Semantic refusal producer is unknown");
}
