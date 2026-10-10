import { randomUUID } from "node:crypto";
import { COMPILER_READINESS_GUIDANCE } from "../compiler-wire.js";
import type {
  ApprovedPlaybookPin,
  ExecutionProfileChoices,
  ModelInvocationContext,
  ModelInvocationObservation,
  ModelInvocationPhase,
  PlanningExecutionBounds,
  PlanningLocalExecutables,
  PlanningModel,
  PlanningPrerequisites,
  PlanReviewRequest,
  WorkGraph,
} from "../contracts.js";
import {
  CONTROLLER_CAPABILITIES_DIGEST,
  installedControllerCapabilities,
} from "../controller-capabilities.js";
import { attachedFault, decision, StepFault } from "../fault.js";
import { UnsettledSubprocessError } from "../process.js";
import {
  allowanceAvailable,
  chargeRepair,
  consumption,
  failureDigest,
  objectiveEvent,
  PAID_ATTEMPTS,
  type RepairClass,
  type RepairLedger,
} from "../repair-policy.js";
import {
  assertReviewPacketBinding,
  decodeGraphReview,
  type ReviewPacket,
  reviewPacket,
} from "../review-evidence.js";
import type { ContinuationState } from "../state.js";
import {
  buildPlanCandidate,
  type PlanCandidate,
  verifyPlanCandidate,
} from "./candidate.js";
import {
  invalidOutput,
  MalformedPlannerOutput,
  PlanValidationError,
} from "./faults.js";
import { digest, planningReviewEvidence, planReviewPacket } from "./packets.js";
import {
  checkedPlanReview,
  compileObjective,
  generatePlannerStructured,
  type PlanCorrection,
  PlanningNeedsDecision,
  withPlannerAdmission,
} from "./planning.js";
import { planningSources } from "./sources.js";

/** Compile and independently review a candidate without GitHub or run-state writes. */
export interface PlanningReviewRecord {
  contextDigest: string;
  packet: ReviewPacket;
  response?: Awaited<ReturnType<PlanningModel["reviewGraph"]>>;
}

export interface PlanningRecoveryRecord {
  phase: "ready" | "submitted" | "complete" | "stopped";
  invocation?: { id: string; phase: string };
  invocations?: { id: string; phase: string; resultDigest?: string }[];
  response?: unknown;
  responseFailure?: string;
  diagnosisResponse?: { kind: string; diagnosis: string; correction: string };
  review?: PlanningReviewRecord;
  history: {
    failure: string;
    detail: string;
    invocations: { id: string; phase: string; resultDigest?: string }[];
    kind: RepairClass;
    diagnosis: string;
    correction: string;
    review?: PlanningReviewRecord;
  }[];
}

class PlanningReviewBindingError extends Error {}

function retainedPlanningReview(
  record: PlanningRecoveryRecord,
  packet: PlanReviewRequest,
  configDigest: string,
): PlanningReviewRecord {
  const contextDigest = digest(JSON.stringify([configDigest, packet]));
  if (record.review) {
    if (record.review.contextDigest !== contextDigest)
      throw new PlanningReviewBindingError(
        "Retained planning review context changed; preserve its evidence and use supported cancellation before a corrected successor",
      );
    try {
      assertReviewPacketBinding(
        record.review.packet,
        [],
        planningReviewEvidence(packet),
      );
    } catch {
      throw new PlanningReviewBindingError(
        "Retained planning review request binding is invalid; do not reconstruct or replay it",
      );
    }
    return record.review;
  }
  return {
    contextDigest,
    packet: reviewPacket([], planningReviewEvidence(packet)),
  };
}

export interface PlanningRecoveryContext {
  sessionState?: ContinuationState;
  state: RepairLedger & {
    planningRecovery?: PlanningRecoveryRecord;
    plan?: PlanCandidate;
    approvedPlaybookPin?: ApprovedPlaybookPin;
  };
  save: () => void;
  stopped?: () => boolean;
}

/**
 * The one planning path: compile, review independently, and revise against
 * the allowance, recording each model call in `context.state` so a repeat
 * (a step's, a restart's) never pays again for a call that completed.
 */
export async function compilePlan(
  ...args: Parameters<typeof compilePlanAdmitted>
): Promise<PlanCandidate> {
  const context = args[8];
  return context.sessionState
    ? withPlannerAdmission(
        context.sessionState,
        context.stopped ?? (() => false),
        () => compilePlanAdmitted(...args),
      )
    : compilePlanAdmitted(...args);
}

async function compilePlanAdmitted(
  objective: number,
  body: string,
  baseSha: string,
  checkout: string,
  model: PlanningModel,
  configDigest: string,
  observe: ((observation: ModelInvocationObservation) => void) | undefined,
  executionProfiles: ExecutionProfileChoices | undefined,
  context: PlanningRecoveryContext,
  prerequisites?: PlanningPrerequisites,
  localExecutables?: PlanningLocalExecutables,
  executionBounds?: PlanningExecutionBounds,
): Promise<PlanCandidate> {
  const { state, save } = context;
  if (
    JSON.stringify(state.approvedPlaybookPin) !==
    JSON.stringify(model.approvedPlaybookPin)
  )
    throw new Error(
      "Planning model differs from the retained advisory selection",
    );
  state.planningRecovery ??= { phase: "ready", history: [] };
  const record = state.planningRecovery;
  const recoverInvocationId =
    record.phase === "submitted" ? record.invocation?.id : undefined;
  // Submitted calls retain their original owner until authenticated settlement.
  if (
    record.phase === "submitted" &&
    (!context.sessionState || record.invocation?.phase === "graph-review")
  )
    throw new StepFault(
      decision(
        "Submitted planning call cannot be replayed without authenticated adapter settlement; preserve the retained invocation",
      ),
    );
  if (record.phase === "stopped")
    throw new PlanningNeedsDecision(
      "Planning recovery stopped; inspect the preserved exact decision",
    );
  if ("reviewResponse" in record)
    throw new PlanningReviewBindingError(
      "Retained planning review lacks its original request binding; stop owned work and use supported cancellation before a corrected successor",
    );
  const sources = planningSources(body, baseSha, checkout);
  if (record.review) {
    try {
      assertReviewPacketBinding(
        record.review.packet,
        [],
        planningReviewEvidence({
          sources,
          prerequisites,
          localExecutables,
          executionBounds,
        }),
      );
    } catch {
      throw new PlanningReviewBindingError(
        "Retained planning review evidence changed or its binding is invalid; preserve the original and use supported cancellation before a corrected successor",
      );
    }
  }
  if (record.phase === "complete") {
    if (!state.plan || record.review?.response === undefined)
      throw new PlanningReviewBindingError(
        "Completed planning review lacks its original request binding; do not reconstruct or replay it",
      );
    const packet = planReviewPacket(
      body,
      baseSha,
      sources,
      state.plan.graph,
      checkout,
      executionProfiles,
      prerequisites,
      localExecutables,
      executionBounds,
      state.approvedPlaybookPin,
    );
    retainedPlanningReview(record, packet, configDigest);
    if (
      decodeGraphReview(
        record.review.response,
        record.review.packet,
        state.plan.graph.items.map((item) => item.id),
      ).length
    )
      throw new PlanningReviewBindingError(
        "Completed planning review retains unresolved findings",
      );
    verifyPlanCandidate(
      state.plan,
      objective,
      body,
      baseSha,
      checkout,
      configDigest,
    );
    return structuredClone(state.plan);
  }
  let corrections: PlanCorrection[] = record.history.length
    ? [{ source: "diagnosis", detail: record.history.at(-1)!.correction }]
    : [];
  const invocation = (phase: ModelInvocationPhase): ModelInvocationContext => {
    if (context.stopped?.()) throw new Error("Planning is paused or cancelled");
    if (
      (phase === "compile" &&
        (record.response !== undefined ||
          record.responseFailure !== undefined)) ||
      (phase === "graph-review" && record.review?.response !== undefined) ||
      (phase === "diagnosis" && record.diagnosisResponse !== undefined)
    )
      return {
        invocationId: record.invocation?.id ?? "preserved",
        phase,
        ordinal: consumption(state).planningRevisions,
      };
    if (record.phase === "submitted") {
      if (record.invocation?.phase !== phase)
        throw new StepFault(
          decision(
            "A different submitted planner invocation still owns this scope",
          ),
        );
      return {
        invocationId: record.invocation.id,
        phase,
        ordinal: consumption(state).planningRevisions,
        observe,
      };
    }
    const id = randomUUID();
    record.phase = "submitted";
    record.invocation = { id, phase };
    record.invocations ??= [];
    record.invocations.push({ id, phase });
    save();
    return {
      invocationId: id,
      phase,
      ordinal: consumption(state).planningRevisions,
      observe,
    };
  };
  const retainResult = (result: unknown): void => {
    const receipt = record.invocations?.at(-1);
    if (receipt) receipt.resultDigest = failureDigest(JSON.stringify(result));
  };
  const observedModel: PlanningModel = {
    ...(model.sessionCapabilities
      ? { sessionCapabilities: model.sessionCapabilities }
      : {}),
    ...(model.releaseSession
      ? { releaseSession: model.releaseSession.bind(model) }
      : {}),
    ...(model.reconcileSession
      ? { reconcileSession: model.reconcileSession.bind(model) }
      : {}),
    ...(model.decodeSessionResponse
      ? { decodeSessionResponse: model.decodeSessionResponse.bind(model) }
      : {}),
    approvedPlaybook: model.approvedPlaybook,
    approvedPlaybookPin: model.approvedPlaybookPin,
    generateStructured: async (request) => {
      if (record.response !== undefined)
        return structuredClone(record.response) as never;
      if (record.responseFailure) throw invalidOutput(record.responseFailure);
      let result;
      try {
        result = context.sessionState
          ? await generatePlannerStructured(
              model,
              context.sessionState,
              save,
              request,
              request.invocation?.invocationId === recoverInvocationId,
            )
          : await model.generateStructured(request);
      } catch (error) {
        if (
          error instanceof MalformedPlannerOutput ||
          error instanceof PlanValidationError
        ) {
          retainResult(error.message);
          record.responseFailure = error.message;
          record.phase = "ready";
          save();
        }
        throw error;
      }
      retainResult(result);
      record.response = structuredClone(result);
      record.phase = "ready";
      save();
      return result;
    },
    reviewGraph: async (request) => {
      if (record.review?.response !== undefined)
        return structuredClone(record.review.response);
      const result = await model.reviewGraph(request);
      retainResult(result);
      record.review!.response = structuredClone(result);
      record.phase = "ready";
      save();
      return result;
    },
  };
  while (true) {
    let graph: WorkGraph | undefined;
    let packet: PlanReviewRequest | undefined;
    let review: Awaited<ReturnType<typeof checkedPlanReview>> | undefined;
    let reviewing = false;
    let failure: string;
    try {
      graph = await compileObjective(
        objective,
        body,
        baseSha,
        checkout,
        observedModel,
        [],
        corrections,
        invocation("compile"),
        executionProfiles,
        undefined,
        prerequisites,
        localExecutables,
        executionBounds,
        (decoded) => {
          graph = decoded;
        },
      );
      packet = planReviewPacket(
        body,
        baseSha,
        sources,
        graph,
        checkout,
        executionProfiles,
        prerequisites,
        localExecutables,
        executionBounds,
        state.approvedPlaybookPin,
      );
      record.review = retainedPlanningReview(record, packet, configDigest);
      save();
      reviewing = true;
      review = await checkedPlanReview(
        observedModel,
        packet,
        invocation("graph-review"),
        record.review.packet,
      );
      if (!review.findings.length && !review.failure) {
        const candidate = buildPlanCandidate(
          objective,
          body,
          baseSha,
          configDigest,
          executionProfiles,
          sources,
          graph,
          packet,
          review,
          record.history.length,
        );
        state.plan = candidate;
        delete record.response;
        delete record.responseFailure;
        record.phase = "complete";
        save();
        return candidate;
      }
      // A review that did not answer validly is not a revision. A paid step
      // sees it as a fault of its paid call and re-asks within its bound
      // (paidPlanningModel); without a step it is kept for the operator.
      failure = JSON.stringify(review);
    } catch (error) {
      // Only an answered plan (refused or invalid) is revised against the
      // allowance; a transient or configuration fault is never charged.
      // checkedPlanReview turns every answered review into a finding or a
      // failure, so whatever escapes it (even invalid output) is the step's.
      const fault = attachedFault(error);
      const answered =
        !reviewing &&
        (error instanceof MalformedPlannerOutput ||
          error instanceof PlanValidationError);
      if (
        error instanceof UnsettledSubprocessError ||
        error instanceof PlanningReviewBindingError ||
        context.stopped?.() ||
        (String(record.phase) === "submitted" &&
          (record.invocation?.phase !== "diagnosis" || reviewing)) ||
        fault?.kind === "config" ||
        fault?.kind === "decision" ||
        fault?.kind === "cancelled" ||
        (fault?.kind === "transient" && !answered)
      )
        throw error;
      if (record.review)
        throw new PlanningReviewBindingError(
          "Retained planning review compiled input cannot be validated; preserve its evidence and use supported cancellation before a corrected successor",
        );
      failure = error instanceof Error ? error.message : String(error);
    }
    const identity = failureDigest(failure);
    const unchanged = record.history.some(
      (entry) => entry.failure === identity,
    );
    // Diagnosis is bounded independently; only an admitted engineering
    // correction consumes a revision. An operator question changes no graph.
    const permitted = (
      ["planning-output", "planning-evidence", "planning-choice"] as const
    ).filter((kind) => state.autonomy.repairClasses.includes(kind));
    // One revision is charged per failed round; the round is the number of
    // accepted corrections before it.
    const event = objectiveEvent("plan", record.history.length);
    const unanswered = Boolean(review && !review.findings.length);
    const diagnosed = (record.invocations ?? []).filter(
      (entry) => entry.phase === "diagnosis",
    ).length;
    if (
      unchanged ||
      unanswered ||
      (diagnosed >= PAID_ATTEMPTS &&
        record.invocation?.phase !== "diagnosis") ||
      !permitted.length ||
      !allowanceAvailable(state, event, "planningRevisions", ["$planning"])
    ) {
      // A reviewed graph waits for an operator plan decision; anything else stops planning.
      record.phase = "stopped";
      if (graph && packet && review) {
        const candidate = buildPlanCandidate(
          objective,
          body,
          baseSha,
          configDigest,
          executionProfiles,
          sources,
          graph,
          packet,
          review,
          record.history.length,
        );
        state.plan = candidate;
        save();
        return candidate;
      }
      save();
      throw new PlanningNeedsDecision(
        unchanged
          ? "Unchanged planning failure; operator decision required"
          : diagnosed >= PAID_ATTEMPTS
            ? `Planning diagnosis did not answer ${PAID_ATTEMPTS} times; operator decision required`
            : "Planning correction is disabled or its allowance is exhausted",
      );
    }
    if (context.stopped?.())
      throw new Error("Planning is paused or cancelled before diagnosis");
    const diagnosisInvocation = invocation("diagnosis");
    const diagnosisRequest = {
      ...(prerequisites ? { prerequisites } : {}),
      ...(localExecutables ? { localExecutables } : {}),
      ...(executionBounds ? { executionBounds } : {}),
      purpose: "diagnosis" as const,
      rejectedGraph: graph ?? null,
      objective: `Classify this planning failure from the supplied sources. Allowed engineering corrections: planning-output (malformed or invalid generated graph including invented assets), planning-evidence (omitted already supplied source facts), planning-choice (routine engineering choice already delegated by the Objective). ${COMPILER_READINESS_GUIDANCE} Return operator for missing product/security decisions, new authority or unsupported capability. Give a concrete correction within the permitted classes and recorded attempt limits; never waive findings, claim a future probe passed or infer extra retry/spending authority.\nObjective:\n${body}\nFailure:\n${failure}`,
      baseSha,
      sources,
      controllerCapabilities: installedControllerCapabilities(),
      controllerCapabilitiesDigest: CONTROLLER_CAPABILITIES_DIGEST,
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "diagnosis", "correction"],
        properties: {
          kind: { type: "string", enum: [...permitted, "operator"] },
          diagnosis: { type: "string" },
          correction: { type: "string" },
        },
      },
      invocation: diagnosisInvocation,
    };
    const diagnosis =
      record.diagnosisResponse ??
      (context.sessionState
        ? await generatePlannerStructured<{
            kind: string;
            diagnosis: string;
            correction: string;
          }>(
            model,
            context.sessionState,
            save,
            diagnosisRequest,
            diagnosisInvocation.invocationId === recoverInvocationId,
          )
        : await model.generateStructured<{
            kind: string;
            diagnosis: string;
            correction: string;
          }>(diagnosisRequest));
    record.diagnosisResponse = structuredClone(diagnosis);
    retainResult(diagnosis);
    record.phase = "ready";
    save();
    if (
      !permitted.includes(diagnosis.kind as (typeof permitted)[number]) ||
      !diagnosis.diagnosis?.trim() ||
      !diagnosis.correction?.trim()
    ) {
      record.phase = "stopped";
      save();
      if (graph && packet && review)
        return buildPlanCandidate(
          objective,
          body,
          baseSha,
          configDigest,
          executionProfiles,
          sources,
          graph,
          packet,
          review,
          record.history.length,
        );
      throw new PlanningNeedsDecision(
        `Planning needs an undelegated decision: ${diagnosis.diagnosis || failure}`,
      );
    }
    chargeRepair(state, event, diagnosis.kind as RepairClass, ["$planning"]);
    record.history.push({
      failure: identity,
      detail: failure,
      invocations: structuredClone(record.invocations ?? []),
      kind: diagnosis.kind as RepairClass,
      diagnosis: diagnosis.diagnosis,
      correction: diagnosis.correction,
      ...(record.review ? { review: structuredClone(record.review) } : {}),
    });
    record.invocations = [];
    corrections = [{ source: "diagnosis", detail: diagnosis.correction }];
    delete record.response;
    delete record.responseFailure;
    delete record.review;
    delete record.diagnosisResponse;
    record.phase = "ready";
    save();
  }
}
