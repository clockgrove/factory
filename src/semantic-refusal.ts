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
      /** Every further criterion the same review refused, so one repair sees them all. */
      others?: {
        criterion: string;
        finding: ReviewFinding;
        /** Absent on refusals retained before each finding kept its own references. */
        evidence?: ReviewEvidenceReference[];
      }[];
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
const disproved = (criterion: string, finding: { detail: string }) =>
  `Acceptance criterion disproved: ${criterion}: ${finding.detail}`;

/** The failure detail for a model refusal: every criterion that review refused. */
export function semanticRefusalDetail(value: {
  criterion: string;
  finding: { detail: string };
  others?: { criterion: string; finding: { detail: string } }[];
}): string {
  return [
    disproved(value.criterion, value.finding),
    ...(value.others ?? []).map((other) =>
      disproved(other.criterion, other.finding),
    ),
  ].join("\n\n");
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
      "others",
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
      failure.detail !== semanticRefusalDetail(value)
    )
      throw new Error("Semantic refusal lacks its exact rejected finding");
    const references = [...value.evidence];
    if (value.others !== undefined) {
      const seen = new Set([value.criterion]);
      if (!Array.isArray(value.others) || !value.others.length)
        throw new Error("Semantic refusal lists no further refusals");
      for (const other of value.others) {
        object(other, ["criterion", "finding", "evidence"], "Further refusal");
        object(
          other.finding,
          ["criterionId", "verdict", "evidenceIds", "detail", "question"],
          "Further refused finding",
        );
        if (
          seen.has(other.criterion) ||
          !item.acceptance.includes(other.criterion) ||
          other.finding.verdict !== "refuse" ||
          typeof other.finding.criterionId !== "string" ||
          !other.finding.criterionId ||
          typeof other.finding.detail !== "string" ||
          !other.finding.detail.trim() ||
          typeof other.finding.question !== "string" ||
          !Array.isArray(other.finding.evidenceIds) ||
          new Set(other.finding.evidenceIds).size !==
            other.finding.evidenceIds.length ||
          (other.evidence !== undefined &&
            (!Array.isArray(other.evidence) ||
              !isDeepStrictEqual(
                other.finding.evidenceIds,
                other.evidence.map((entry) => entry.id),
              )))
        )
          throw new Error("Semantic refusal has an invalid further refusal");
        seen.add(other.criterion);
        if (other.evidence) references.push(...other.evidence);
      }
    }
    for (const reference of references) {
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
    if ("finding" in value || "evidence" in value || "others" in value)
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
      // The recorded decision binds the refusal; the failure's detail is
      // only its rendering, which differs by producer.
      !work.acceptanceDecisions?.some((entry) =>
        isDeepStrictEqual(entry, decision),
      )
    )
      throw new Error("Semantic refusal lacks its exact operator decision");
  } else throw new Error("Semantic refusal producer is unknown");
}
