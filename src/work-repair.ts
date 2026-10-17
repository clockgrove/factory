import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import {
  authenticateAdaptiveContextPacket,
  buildAdaptiveContext,
} from "./adaptive-context.js";
import { blameDecision, cappedDiagnosis } from "./blame-decision.js";
import {
  generatePlannerStructured,
  withPlannerAdmission,
} from "./compiler/planning.js";
import {
  planningGraphView,
  workItemSourceResolver,
} from "./compiler/sources.js";
import type {
  ContentRef,
  ContentStore,
  PlanningModel,
  PlanningRequest,
  WorkItem,
} from "./contracts.js";
import {
  CONTROLLER_CAPABILITIES_DIGEST,
  installedControllerCapabilities,
} from "./controller-capabilities.js";
import type { DiagnosticEmitter } from "./diagnostics.js";
import {
  assertFailedValidationEvidence,
  assertFailedValidationRecord,
  type FailedValidationEvidence,
  type FailedValidationRecord,
  failedValidationDigest,
} from "./failed-validation.js";
import { attachFault, faultOf, StepFault, transient } from "./fault.js";
import { graphDigest, recordWorkerDiscovery } from "./graph-amendments.js";
import { completeObjectiveKnowledge } from "./objective-knowledge.js";
import { ownsPath, validOwnershipPath } from "./ownership.js";
import { pinnedGitRaw } from "./process.js";
import { resultReviewCriteria } from "./qa.js";
import { literalBodyBlocks } from "./prompt-bytes.js";
import { awaitCheckpointAdmission } from "./recovery-checkpoint.js";
import {
  archiveAttempt,
  chargeRepair,
  consumption,
  type FailureClass,
  type FailureDisposition,
  failureDigest,
  implementationRepairable,
  itemEvent,
  REVIEW_FINDINGS_ACTOR,
  type RepairCorrection,
  releaseCharge,
  repairScopes,
  validateCorrection,
} from "./repair-policy.js";
import {
  discoveryContextBodies,
  discoveryContextSelections,
  type SelectedDiscoveryInput,
  selectedDiscoveryInputs,
} from "./runner/discovery.js";
import {
  assertSemanticRefusalRecord,
  SemanticAcceptanceFailure,
  semanticValidationDigest,
} from "./semantic-refusal.js";
import {
  assertWorkAdaptiveContext,
  type FactoryState,
  type WorkState,
} from "./state.js";
import { clearRepeats, type StepClock, StepPaused, step } from "./step.js";

/** The exact collected candidate exists, but settled local validation failed: a wrong result. */
export class CandidateValidationFailure extends Error {
  readonly failedValidation?: FailedValidationEvidence;
  constructor(detail: string, failedValidation?: FailedValidationEvidence) {
    super(detail);
    if (failedValidation) {
      assertFailedValidationEvidence(failedValidation);
      this.failedValidation = structuredClone(failedValidation);
    }
    attachFault(this, { kind: "work", evidence: { detail } });
  }
}
/** The controller could not prepare validation; the candidate was never judged. */
export class CandidateEnvironmentFailure extends Error {
  constructor(detail: string) {
    super(detail);
    attachFault(this, {
      kind: "config",
      detail,
      fix: "Restore the controller's validation environment",
    });
  }
}

/** The Work Item whose failure an error carries, set where the failure is recorded. */
const failedItems = new WeakMap<object, string>();
export const failedItemOf = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null
    ? failedItems.get(error)
    : undefined;

const retryCommand = (state: FactoryState, id: string): string =>
  `factory retry --objective ${state.objective} --item ${id}`;

/**
 * Record a failed attempt. Only a contained wrong result (a `work` fault)
 * gets a failure event, so only it is diagnosed and charged. Decisions and
 * config faults normally wait instead (step rule 7); they are recorded here
 * only when a caller ends the attempt on them.
 */
export function recordWorkFailure(
  state: FactoryState,
  id: string,
  error: unknown,
): boolean {
  const work = state.work[id]!;
  if (typeof error === "object" && error !== null) failedItems.set(error, id);
  const detail = error instanceof Error ? error.message : String(error);
  const fault = faultOf(error);
  // A discovery staged beside a wrong result is reviewed like one beside a
  // collected result (#820).
  if (fault.kind === "work" && fault.evidence.discovery && work.attempt)
    recordWorkerDiscovery(state, id, fault.evidence.discovery);
  // A published result that fails (a failed check, a conflict) is repaired
  // by a new attempt that republishes the branch with a lease.
  const isolated =
    !work.integratedSha &&
    !state.coordinator?.cancelError &&
    fault.kind === "work";
  const event = isolated
    ? itemEvent(id, work.step ?? "execute", work.recovery?.history?.length ?? 0)
    : undefined;
  const retry = `\`${retryCommand(state, id)}\``;
  const classification: FailureClass = event
    ? "implementation"
    : fault.kind === "work"
      ? "decision"
      : fault.kind;
  // `factory repair` is named only while it would be accepted.
  const repairable =
    event !== undefined &&
    implementationRepairable(state, event, repairScopes(state, id));
  const decisions: Record<FailureClass, string> = {
    implementation: repairable
      ? `Supply a concrete diagnosis and correction (\`factory repair --objective ${state.objective} --proposal FILE\`), enable implementation repair in the configured autonomy, or start a new attempt with ${retry}`
      : `Implementation repair is not available (its allowance is used up or the class is not enabled); start a new attempt with ${retry}`,
    "planning-output": detail,
    "planning-evidence": detail,
    "planning-choice": detail,
    decision:
      fault.kind === "decision"
        ? `${fault.question} Answer with ${retry}, or cancel`
        : `The result failed after it was integrated or while the Objective was cancelling; inspect it, then ${retry} or cancel`,
    config: `${fault.kind === "config" ? fault.fix : detail}; then ${retry}`,
    transient: `Interrupted outside a repeatable step; check the provider, network or GitHub status, then ${retry}`,
    defect: `Factory hit a defect; report it (evidence: \`factory diagnostics --objective ${state.objective} --logs ${id}\`), then start a new attempt with ${retry}`,
    cancelled: "Cancelled by the operator",
  };
  const failure: FailureDisposition = {
    digest: failureDigest(detail),
    ...(event && { event }),
    detail,
    at: new Date().toISOString(),
    classification,
    continuation: isolated
      ? "new-attempt-from-accepted-base"
      : "operator-decision",
    // A work fault at execute ends the attempt only after the driver
    // disposed of the worker's workspace (attempt.ts endAttempt).
    unfinishedEdits:
      fault.kind === "work" && (work.step ?? "execute") === "execute"
        ? "removed"
        : "unavailable",
    decision: decisions[classification],
  };
  // Retained evidence binds this failure only when its record validates. A
  // binding that does not is left out, and the failure is still recorded:
  // the previous attempt's record must never stay beside this error (#1254).
  const binds = (check: () => void): boolean => {
    try {
      check();
      return true;
    } catch {
      return false;
    }
  };
  let failedValidation: FailedValidationRecord | undefined;
  // Readiness probes also validate the accepted base before any result or
  // attempt exists. They cannot supply a failed result's candidate receipts.
  if (
    error instanceof CandidateValidationFailure &&
    error.failedValidation &&
    work.step === "validate"
  ) {
    const retained: FailedValidationRecord = {
      repository: state.repository,
      objective: state.objective,
      runId: state.runId,
      configDigest: state.configDigest,
      itemId: id,
      attemptId: work.attempt!,
      acceptedBaseSha: state.baseSha,
      executionBaseSha: work.executionBaseSha!,
      resultBaseSha: work.baseSha!,
      graphRevisionDigest: work.graphRevisionDigest ?? graphDigest(state.graph),
      failureDigest: failure.digest,
      ...(failure.event && { failureEvent: failure.event }),
      evidence: error.failedValidation,
    };
    failure.validationCaptureDigest = failedValidationDigest(retained);
    if (
      binds(() =>
        assertFailedValidationRecord(retained, state, id, work, failure),
      )
    )
      failedValidation = retained;
    else delete failure.validationCaptureDigest;
  }
  if (
    isolated &&
    work.step === "validate" &&
    error instanceof SemanticAcceptanceFailure &&
    work.validation
  ) {
    failure.semanticRefusal = {
      ...structuredClone(error.semanticRefusal),
      validationDigest: semanticValidationDigest(work.validation),
    };
    if (!binds(() => assertSemanticRefusalRecord(state, id, work, failure)))
      delete failure.semanticRefusal;
  }
  if (failedValidation)
    work.failedValidation = structuredClone(failedValidation);
  // A new failure starts a fresh record: an earlier correction belongs to
  // the attempt it corrected, which the history keeps.
  work.recovery = {
    scopes: repairScopes(state, id),
    ...(work.recovery?.history && { history: work.recovery.history }),
    failure,
    phase: "stopped",
  };
  return isolated;
}

/**
 * The correction for a model result review's refusal: its refused findings,
 * each with its criterion index and cited evidence. The reviewer already
 * stated each gap against the exact candidate, so a diagnosis call would only
 * restate it. Undefined sends the failure to the diagnosis, which still makes
 * the decisions this cannot: a finding with a question may need an operator,
 * and an operator refusal, a command failure or a refusal after an earlier
 * findings repair needs a new judgment. Built from the retained refusal alone, so it is rebuilt
 * identically after a restart.
 */
export function reviewFindingsCorrection(
  state: FactoryState,
  id: string,
): RepairCorrection | undefined {
  const work = state.work[id];
  const failure = work?.recovery?.failure;
  const refusal = failure?.semanticRefusal;
  const item = state.graph.items.find((entry) => entry.id === id);
  if (
    !work ||
    !item ||
    !failure?.event ||
    refusal?.source !== "model" ||
    failure.classification !== "implementation" ||
    // A diagnosis already asked for this failure is answered, not replaced.
    work.recovery?.diagnosisInvocation ||
    // The shortcut is taken once per item: a refusal after a findings repair,
    // however reworded, goes to the diagnosis with that history, which can
    // decide blame, an operator question or a different correction.
    work.recovery?.history?.some(
      (entry) => entry.correction?.actor === REVIEW_FINDINGS_ACTOR,
    )
  )
    return undefined;
  try {
    assertSemanticRefusalRecord(state, id, work, failure);
  } catch {
    return undefined;
  }
  const refused = [
    {
      criterion: refusal.criterion,
      finding: refusal.finding,
      evidence: refusal.evidence,
    },
    ...(refusal.others ?? []),
  ];
  const reviewed = resultReviewCriteria(state.graph, item);
  if (
    refused.some(
      ({ criterion, finding }) =>
        finding.question.trim() || !reviewed.includes(criterion),
    )
  )
    return undefined;
  const correction: RepairCorrection = {
    kind: "implementation",
    failureDigest: failure.digest,
    event: failure.event,
    diagnosis: `The independent result review refused ${refused.length} acceptance ${refused.length === 1 ? "criterion" : "criteria"} of candidate tree ${refusal.treeSha} after its validation commands passed. Each finding states the gap the candidate must close.`,
    correction: `Close every refused finding below within the owned paths, keeping what the review did not refuse. criterionIndex is the criterion's position in the Work Item's acceptance; a finding without one refuses an Objective criterion this Work Item proves, quoted verbatim. evidence is what the reviewer cited.\n${JSON.stringify(
      refused.map(({ criterion, finding, evidence }) => ({
        ...(item.acceptance.includes(criterion) && {
          criterionIndex: item.acceptance.indexOf(criterion),
        }),
        criterion,
        finding: finding.detail,
        // Each finding's own resolved references, as the reviewer cited them.
        evidence: evidence.map(({ path, origin, complete }) => ({
          path,
          origin,
          complete,
        })),
      })),
    )}`,
    actor: REVIEW_FINDINGS_ACTOR,
  };
  try {
    validateCorrection(work, correction);
  } catch {
    // An unchanged repeat of a failed correction goes to the diagnosis.
    return undefined;
  }
  return correction;
}

export function applyWorkCorrection(
  state: FactoryState,
  id: string,
  correction: RepairCorrection,
): void {
  const work = state.work[id];
  if (
    !work ||
    work.integratedSha ||
    state.cancelRequested ||
    state.cancelledAt ||
    state.coordinator?.cancelError ||
    state.coordinator?.processes?.length
  )
    throw new Error(
      "Repair cannot cross an unsettled, integrated or cancelled boundary",
    );
  validateCorrection(work, correction);
  if (correction.actor === "factory-controller") {
    assertRepairReadiness(state, id, work, correction, work.recovery?.failure);
    const current = state.graph.items.find((item) => item.id === id);
    if (
      !current ||
      !ownsPath(correction.readiness!.ownedPath, current.ownedPaths)
    )
      throw new Error(
        "Automatic repair readiness no longer has current ownership",
      );
  } else if (correction.readiness)
    throw new Error(
      "Operator corrections cannot declare controller-checked readiness",
    );
  else if (correction.actor === REVIEW_FINDINGS_ACTOR) {
    // Only the retained refusal's own findings carry this provenance.
    const derived = reviewFindingsCorrection(state, id);
    if (
      derived?.diagnosis !== correction.diagnosis ||
      derived.correction !== correction.correction
    )
      throw new Error(
        "Review findings correction differs from the retained refusal",
      );
  }
  if (correction.kind !== "implementation")
    throw new Error(
      "Only an implementation correction is supported: a diagnosed new attempt",
    );
  // Only a wrong result is corrected; anything else is retried or answered.
  if (work.recovery!.failure!.classification !== "implementation")
    throw new Error(
      `Only a wrong result can be repaired; use \`${retryCommand(state, id)}\``,
    );

  // The correction is bound to the event of the failure it corrects, and
  // archived with that failure and the attempt it ended.
  const { event: _unbound, ...admitted } = correction;
  const event = work.recovery?.failure?.event;
  const bound = { ...admitted, ...(event && { event }) };
  const recovery = archiveAttempt({
    ...work,
    recovery: { ...work.recovery, correction: bound },
  });
  recovery.correction = bound;
  recovery.phase = "ready";
  // A wrong result at delivery (the remote refused its content) published
  // nothing; any other failure there may have.
  if (
    work.status !== "failed" ||
    (work.step === "deliver" && !work.recovery?.failure?.event)
  )
    throw new Error(
      "Implementation repair needs an unpublished failed attempt",
    );
  chargeRepair(
    state,
    work.recovery!.failure!.event,
    correction.kind,
    repairScopes(state, id),
  );
  // The new attempt starts without the old one's step records, as a retry
  // does: a stale diagnose record would stop its failure unasked.
  clearRepeats(state, { item: id });
  state.work[id] = { status: "pending", recovery };
}
const diagnosisSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "diagnosis",
    "correction",
    "decision",
    "predecessor",
    "path",
    "readiness",
    "prerequisites",
    "question",
    "evidenceIndices",
    "commandAssessments",
    "requestedFiles",
  ],
  properties: {
    diagnosis: { type: "string" },
    correction: { type: "string" },
    decision: { type: "string", enum: ["repair", "operator", "predecessor"] },
    // With "predecessor": its id and faulty file. With repair: the owned file.
    predecessor: { type: "string" },
    path: { type: "string" },
    readiness: {
      type: "string",
      enum: ["actionable", "operator-required", "unknown"],
    },
    prerequisites: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["status", "question"],
        properties: {
          status: { type: "string", enum: ["unmet", "unknown"] },
          question: { type: "string" },
        },
      },
    },
    question: { type: "string" },
    evidenceIndices: { type: "array", items: { type: "integer", minimum: 0 } },
    commandAssessments: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["commandIndex", "disposition"],
        properties: {
          commandIndex: { type: "integer", minimum: 0 },
          disposition: {
            type: "string",
            enum: ["owned-change", "operator-required", "unknown"],
          },
        },
      },
    },
    // Owned candidate files the answer needs whole that the request lacks.
    requestedFiles: { type: "array", items: { type: "string" } },
  },
};

type DiagnosisAnswer = {
  diagnosis: string;
  correction: string;
  decision: string;
  predecessor?: string;
  path?: string;
  readiness?: "actionable" | "operator-required" | "unknown";
  prerequisites?: { status: "unmet" | "unknown"; question: string }[];
  question?: string;
  evidenceIndices?: number[];
  commandAssessments?: {
    commandIndex: number;
    disposition: "owned-change" | "operator-required" | "unknown";
  }[];
  requestedFiles?: string[];
};
const inputDigest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const readinessContext = (
  state: FactoryState,
  id: string,
  work: Pick<
    import("./state.js").WorkState,
    | "attempt"
    | "treeSha"
    | "changeRef"
    | "baseSha"
    | "executionBaseSha"
    | "graphRevisionDigest"
  >,
  correction: RepairCorrection,
  failure: FailureDisposition,
  graph: string,
) =>
  inputDigest({
    repository: state.repository,
    objective: state.objective,
    runId: state.runId,
    configDigest: state.configDigest,
    acceptedBaseSha: state.baseSha,
    itemId: id,
    attemptId: work.attempt ?? null,
    treeSha: work.treeSha ?? null,
    commitSha: work.changeRef ?? null,
    resultBaseSha: work.baseSha ?? null,
    executionBaseSha: work.executionBaseSha ?? null,
    attemptGraphDigest: work.graphRevisionDigest ?? null,
    failureDigest: failure.digest,
    failureEvent: failure.event,
    validationCaptureDigest: failure.validationCaptureDigest ?? null,
    ...(failure.semanticRefusal
      ? { semanticRefusal: failure.semanticRefusal }
      : {}),
    graphDigest: graph,
    inputDigest: correction.readiness?.inputDigest,
    ownedPath: correction.readiness?.ownedPath,
    diagnosis: correction.diagnosis,
    correction: correction.correction,
    kind: correction.kind,
  });

/** Recheck immutable admission bindings for both current and archived attempts. */
export function assertRepairReadiness(
  state: FactoryState,
  id: string,
  work: Pick<
    import("./state.js").WorkState,
    | "attempt"
    | "treeSha"
    | "changeRef"
    | "baseSha"
    | "executionBaseSha"
    | "graphRevisionDigest"
    | "validation"
    | "failedValidation"
    | "acceptanceDecisions"
  >,
  correction: RepairCorrection,
  failure: FailureDisposition | undefined,
): void {
  const ready = correction.readiness;
  assertSemanticRefusalRecord(state, id, work, failure);
  if (!ready)
    throw new Error(
      "Automatic repair readiness is unavailable; which original failed command or operator prerequisite has been resolved? Supply an operator correction after establishing it",
    );
  const graph = [
    state.graph,
    ...(state.graphRevisions ?? []).map((revision) => revision.graph),
  ].find((candidate) => graphDigest(candidate) === ready.graphDigest);
  const item = graph?.items.find((entry) => entry.id === id);
  if (
    ready.origin !== "checked-model-diagnosis" ||
    correction.actor !== "factory-controller" ||
    ready.failureEvent !== correction.event ||
    !failure ||
    correction.failureDigest !== failure.digest ||
    ready.validationCaptureDigest !==
      (failure.validationCaptureDigest ?? null) ||
    ready.contextDigest !==
      readinessContext(
        state,
        id,
        work,
        correction,
        failure,
        ready.graphDigest,
      ) ||
    ready.attemptId !== (work.attempt ?? null) ||
    ready.treeSha !== (work.treeSha ?? null) ||
    !item ||
    !validOwnershipPath(ready.ownedPath) ||
    ready.ownedPath.endsWith("/") ||
    !ownsPath(ready.ownedPath, item.ownedPaths)
  )
    throw new Error(
      "Automatic repair readiness does not bind the retained attempt and ownership",
    );
}

/** Canonical outcomes and actual candidate contents supplied to this diagnosis. */
export function repairEvidence(
  state: FactoryState,
  item: WorkItem,
  files: ReturnType<typeof diagnosisFiles>,
) {
  const work = state.work[item.id]!;
  const failure = work.recovery!.failure!;
  assertFailedValidationRecord(
    work.failedValidation,
    state,
    item.id,
    work,
    failure,
  );
  assertSemanticRefusalRecord(state, item.id, work, failure);
  return [
    {
      kind: "failure",
      content: failure.detail,
      complete: true,
      ...(failure.semanticRefusal
        ? { semanticRefusal: failure.semanticRefusal }
        : {}),
    },
    {
      kind: "validation",
      outcome: failure.semanticRefusal
        ? "passed-before-semantic-refusal"
        : work.failedValidation
          ? "failed"
          : "unavailable",
      availability:
        work.failedValidation || failure.semanticRefusal
          ? "available"
          : "unavailable",
      record: work.failedValidation ?? null,
      ...(failure.semanticRefusal
        ? { passingValidation: work.validation }
        : {}),
    },
    ...files.map((file) => ({ kind: "candidate-file", ...file })),
  ];
}

/** Semantic causes are declared; indices, outcomes and ownership are checked facts. */
export function actionableReadiness(
  state: FactoryState,
  item: WorkItem,
  answer: DiagnosisAnswer,
  evidence: ReturnType<typeof repairEvidence>,
  checkout?: string,
  deliveredEvidenceIndices?: readonly number[],
): RepairCorrection["readiness"] | string {
  const work = state.work[item.id]!;
  const failure = work.recovery!.failure!;
  const question = (text?: string) =>
    (typeof text === "string" && text.trim()) ||
    `What concrete correction or operator prerequisite makes Work Item ${item.id} ready to proceed? Supply a diagnosed operator correction after establishing it.`;
  if (
    Object.keys(answer).sort().join(",") !==
      [...diagnosisSchema.required].sort().join(",") ||
    ![
      answer.diagnosis,
      answer.correction,
      answer.predecessor,
      answer.path,
      answer.question,
    ].every((value) => typeof value === "string")
  )
    return question();
  if (answer.readiness !== "actionable") return question(answer.question);
  if (!Array.isArray(answer.prerequisites)) return question();
  if (answer.prerequisites.length) {
    if (
      answer.prerequisites.some(
        (entry) =>
          !entry ||
          typeof entry !== "object" ||
          !["unmet", "unknown"].includes(entry.status) ||
          typeof entry.question !== "string" ||
          !entry.question.trim(),
      )
    )
      return question();
    return answer.prerequisites
      .map((entry) => entry.question.trim())
      .join("\n");
  }
  if (typeof answer.question !== "string") return question();
  if (answer.question.trim()) return question(answer.question);
  const path = answer.path ?? "";
  if (
    typeof path !== "string" ||
    !validOwnershipPath(path) ||
    path.endsWith("/") ||
    !ownsPath(path, item.ownedPaths)
  )
    return question(
      `Which owned file requires a concrete implementation change? ${path || "The diagnosis"} does not establish an actionable owned correction.`,
    );
  const indices = answer.evidenceIndices;
  if (
    !Array.isArray(indices) ||
    !indices.includes(0) ||
    new Set(indices).size !== indices.length ||
    indices.some(
      (index) =>
        !Number.isSafeInteger(index) ||
        index < 0 ||
        index >= evidence.length ||
        (deliveredEvidenceIndices !== undefined &&
          !deliveredEvidenceIndices.includes(index)),
    )
  )
    return question(
      "Which supplied original failure and owned candidate evidence establish the correction? Readiness grounding is unavailable.",
    );
  const capture = work.failedValidation;
  const semantic = failure.semanticRefusal;
  if (work.step === "validate" && !capture && !semantic)
    return question(
      "Can the original validation failure be established from retained command outcomes? Those outcomes are unavailable; supply a diagnosed operator correction.",
    );
  if (semantic) {
    try {
      assertSemanticRefusalRecord(state, item.id, work, failure);
    } catch {
      return question(
        "Can the exact rejected review, candidate and passing commands be established? Semantic refusal evidence is unavailable.",
      );
    }
    if (
      !indices.includes(1) ||
      !work.validation?.worktreeObservation ||
      (semantic.source === "model" &&
        !semantic.evidence.some((entry) => entry.complete))
    )
      return question(
        "Can the rejected review and separate passing command outcomes be grounded completely? Semantic refusal evidence is insufficient.",
      );
  }
  const failed =
    capture?.evidence.commands.filter((command) => !command.passed) ?? [];
  const assessments = answer.commandAssessments;
  if (
    !Array.isArray(assessments) ||
    assessments.length !== failed.length ||
    assessments.some((entry) => !entry || typeof entry !== "object") ||
    new Set(assessments.map((entry) => entry.commandIndex)).size !==
      failed.length ||
    assessments.some(
      (entry) =>
        Object.keys(entry).sort().join(",") !== "commandIndex,disposition" ||
        !failed.some((command) => command.index === entry.commandIndex) ||
        !["owned-change", "operator-required", "unknown"].includes(
          entry.disposition,
        ),
    )
  )
    return question(
      "What makes each retained failed validation command actionable now? The diagnosis omits or misbinds a failed command.",
    );
  if (assessments.some((entry) => entry.disposition !== "owned-change"))
    return question(
      "Which operator prerequisite remains unmet or unestablished for the retained failed validation command? Establish it before supplying a correction.",
    );
  if (
    capture &&
    (!indices.includes(1) ||
      capture.evidence.postCommandStatus !== "unchanged" ||
      capture.evidence.selectedLfsContentBinding !== "not-applicable" ||
      capture.evidence.commands.some(
        (command) =>
          command.worktreeStatusBefore !== "unchanged" ||
          command.worktreeStatusAfter !== "unchanged",
      ))
  )
    return question(
      "Can the failed validation outcomes and candidate bytes be bound exactly? That readiness evidence is unavailable.",
    );
  const fileIndex = evidence.findIndex(
    (entry) =>
      "path" in entry && entry.path === path && entry.kind === "candidate-file",
  );
  if (work.treeSha) {
    let present: boolean;
    try {
      present = Boolean(
        checkout &&
          treeFiles(checkout, work.treeSha, path).some(
            (file) => file.path === path,
          ),
      );
      if (
        checkout &&
        !present &&
        pinnedGitRaw(checkout, "ls-tree", "-z", work.treeSha, "--", path).length
      )
        return question(
          `Can the original candidate content of ${path} be supplied completely? It is not a readable regular file.`,
        );
    } catch {
      return question(
        `Can the original candidate content of ${path} be supplied completely? It is unavailable.`,
      );
    }
    if (
      !checkout ||
      (present &&
        (fileIndex < 0 ||
          !indices.includes(fileIndex) ||
          !(
            "complete" in evidence[fileIndex]! && evidence[fileIndex]!.complete
          )))
    )
      return question(
        `Can the original candidate content of ${path} be supplied completely? It is missing or truncated.`,
      );
  }
  const ready: NonNullable<RepairCorrection["readiness"]> = {
    origin: "checked-model-diagnosis",
    failureEvent: failure.event!,
    attemptId: work.attempt ?? null,
    treeSha: work.treeSha ?? null,
    graphDigest: graphDigest(state.graph),
    validationCaptureDigest: failure.validationCaptureDigest ?? null,
    inputDigest: inputDigest(evidence),
    contextDigest: "",
    ownedPath: path,
  };
  ready.contextDigest = readinessContext(
    state,
    item.id,
    work,
    {
      failureDigest: failure.digest,
      event: failure.event,
      kind: "implementation",
      diagnosis: answer.diagnosis,
      correction: answer.correction,
      actor: "factory-controller",
      readiness: ready,
    },
    failure,
    ready.graphDigest,
  );
  return ready;
}

type Blame = Omit<
  NonNullable<FailureDisposition["predecessor"]>,
  "diagnosis" | "graphDigest"
>;

/** Work Items this one depends on, directly or not, that are merged. */
function mergedPredecessors(
  state: FactoryState,
  item: WorkItem,
): { item: WorkItem; pullRequest?: number }[] {
  const found = new Map<string, WorkItem>();
  const visit = (current: WorkItem): void => {
    for (const id of current.dependencies) {
      const dependency = state.graph.items.find((entry) => entry.id === id);
      if (!dependency || found.has(id)) continue;
      found.set(id, dependency);
      visit(dependency);
    }
  };
  visit(item);
  return [...found.values()].flatMap((dependency) => {
    const work = state.work[dependency.id];
    return work?.status === "done" && work.integratedSha
      ? [
          {
            item: dependency,
            ...(work.pullRequest && { pullRequest: work.pullRequest }),
          },
        ]
      : [];
  });
}

/**
 * The merged predecessor that last took over `path`. A new item that takes a
 * done item's file depends on it, so the latest owner is the one no other
 * owner of the path is built on; among independent owners, the one added last.
 */
function latestOwner(
  state: FactoryState,
  predecessors: { item: WorkItem; pullRequest?: number }[],
  path: string,
): { item: WorkItem; pullRequest?: number } | undefined {
  const owners = predecessors.filter((entry) =>
    ownsPath(path, entry.item.ownedPaths),
  );
  const builtOn = new Set<string>();
  for (const owner of owners)
    for (const other of mergedPredecessors(state, owner.item))
      builtOn.add(other.item.id);
  const order = (entry: { item: WorkItem }) =>
    state.graph.items.findIndex((candidate) => candidate.id === entry.item.id);
  return owners
    .filter((entry) => !builtOn.has(entry.item.id))
    .sort((a, b) => order(a) - order(b))
    .at(-1);
}

/** The regular files of a result tree: path, with the blob size, from `git ls-tree -l`. */
function treeFiles(
  checkout: string,
  treeSha: string,
  ...paths: string[]
): { path: string; size: number }[] {
  const listing = pinnedGitRaw(
    checkout,
    "ls-tree",
    "-l",
    "-z",
    ...(paths.length ? [] : ["-r"]),
    treeSha,
    ...(paths.length ? ["--", ...paths] : []),
  ).toString("utf8");
  return listing.split("\0").flatMap((line) => {
    // <mode> <type> <object> <size>\t<path>; only a blob that is not a
    // link (100644, 100755) is a regular file.
    const match = /^(\d+) (\w+) [0-9a-f]+ +(\d+)\t(.*)$/s.exec(line);
    return match?.[1]?.startsWith("100") && match[2] === "blob"
      ? [{ path: match[4]!, size: Number(match[3]) }]
      : [];
  });
}

/**
 * The failure is a merged predecessor's when the file the diagnosis names is
 * owned by that predecessor and not by the failing item, and is a regular file
 * of the failed result. Ownership comes from the accepted graph and the file
 * from the result tree, so the answer is checked as structure, never as prose.
 */
function blamedPredecessor(
  state: FactoryState,
  item: WorkItem,
  answer: { predecessor?: string; path?: string },
  checkout: string | undefined,
): Blame {
  const path = answer.path?.trim() ?? "";
  const predecessors = mergedPredecessors(state, item);
  const named = predecessors.find(
    (entry) => entry.item.id === answer.predecessor,
  );
  // A file a later item took over is that item's now: it is the one to build
  // on, even when the answer names the earlier owner.
  const owner =
    named && ownsPath(path, named.item.ownedPaths)
      ? (latestOwner(state, predecessors, path) ?? named)
      : named;
  if (!owner)
    throw new Error(
      `${answer.predecessor || "(none)"} is not a merged predecessor of ${item.id}`,
    );
  if (!path || path.endsWith("/") || !validOwnershipPath(path))
    throw new Error(`${path || "(none)"} is not a file path`);
  if (!ownsPath(path, owner.item.ownedPaths))
    throw new Error(`${path} is not owned by ${owner.item.id}`);
  if (ownsPath(path, item.ownedPaths))
    throw new Error(`${path} is owned by ${item.id} itself`);
  const treeSha = state.work[item.id]?.treeSha;
  if (!checkout || !treeSha)
    throw new Error(`${item.id} has no result tree to hold ${path}`);
  let present: boolean;
  try {
    present = treeFiles(checkout, treeSha, path).some(
      (file) => file.path === path,
    );
  } catch (error) {
    throw new Error(
      `${path} cannot be read from the result of ${item.id}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!present)
    throw new Error(
      `${path} is not a regular file in the result of ${item.id}`,
    );
  return {
    item: owner.item.id,
    path,
    ...(owner.pullRequest && { pullRequest: owner.pullRequest }),
  };
}

const EVIDENCE_TOTAL_BYTES = 128_000;
/**
 * Files an earlier answer asked for and the change-packet files the review
 * cites are read whole first, within their own bound. A larger blob is not
 * read at all: it is not source a diagnosis can use.
 */
const EVIDENCE_NAMED_BYTES = 256_000;

/**
 * The owned files earlier answers to this failure named (`requestedFiles`,
 * and a repair's `path`). Read from the retained answers, so the next request
 * and the ready-correction check rebuild the same evidence.
 */
function requestedDiagnosisFiles(work: WorkState): Set<string> {
  const paths = new Set<string>();
  for (const { response } of work.recovery?.diagnosisInvocation?.rejected ??
    []) {
    if (!response || typeof response !== "object") continue;
    const answer = response as Partial<DiagnosisAnswer>;
    if (Array.isArray(answer.requestedFiles))
      for (const path of answer.requestedFiles)
        if (typeof path === "string") paths.add(path);
    if (answer.decision === "repair" && typeof answer.path === "string")
      paths.add(answer.path);
  }
  return paths;
}

/**
 * The paths an answer needs whole that this request did not supply whole but
 * Factory can: regular files of the failed result that the item or a merged
 * predecessor owns, not asked for before. Asking again with them is a context
 * retry, never an operator question.
 */
function heldCandidateRequests(
  state: FactoryState,
  item: WorkItem,
  answer: DiagnosisAnswer,
  evidence: ReturnType<typeof repairEvidence>,
  checkout: string | undefined,
): string[] {
  const work = state.work[item.id]!;
  if (!checkout || !work.treeSha) return [];
  const asked = new Set([
    ...(Array.isArray(answer.requestedFiles) ? answer.requestedFiles : []),
    ...(answer.decision === "repair" ? [answer.path] : []),
  ]);
  const before = requestedDiagnosisFiles(work);
  const predecessors = mergedPredecessors(state, item);
  return [...asked].filter((path): path is string => {
    if (
      typeof path !== "string" ||
      !validOwnershipPath(path) ||
      path.endsWith("/") ||
      before.has(path) ||
      evidence.some(
        (entry) =>
          entry.kind === "candidate-file" &&
          "path" in entry &&
          entry.path === path &&
          entry.complete,
      ) ||
      !(
        ownsPath(path, item.ownedPaths) ||
        latestOwner(state, predecessors, path)
      )
    )
      return false;
    try {
      return treeFiles(checkout, work.treeSha!, path).some(
        (file) => file.path === path && file.size <= EVIDENCE_NAMED_BYTES,
      );
    } catch {
      return false;
    }
  });
}

/**
 * The files of the failed result that it and its merged predecessors own, as
 * text: what a diagnosis needs to tell whose file is wrong. They are read from
 * the result tree, which holds the integrated predecessors' files. Files an
 * earlier answer asked for, then the change-packet files the review cites,
 * come first, within their own bound. Then the failing item's own files, so
 * the budget never goes to a predecessor before them; within each ownership
 * group, other literal paths in the retained current failure, then the files
 * this attempt changed, then the rest in Git listing order. A cited or changed file that does not fit is listed
 * without its content, so the diagnosis can ask for it.
 */
export function diagnosisFiles(
  state: FactoryState,
  item: WorkItem,
  checkout: string | undefined,
): { path: string; heading: string; content: string; complete: boolean }[] {
  const treeSha = state.work[item.id]?.treeSha;
  if (!checkout || !treeSha) return [];
  const work = state.work[item.id]!;
  const failure = work.recovery?.failure;
  assertFailedValidationRecord(
    work.failedValidation,
    state,
    item.id,
    work,
    failure,
  );
  assertSemanticRefusalRecord(state, item.id, work, failure);
  const refusal = failure?.semanticRefusal;
  const references =
    refusal?.source === "model"
      ? [
          ...refusal.evidence,
          ...(refusal.others ?? []).flatMap((other) => other.evidence),
        ]
      : [];
  const failureText = [
    failure?.detail ?? "",
    ...references.map((entry) => entry.path),
  ].join("\n");
  // The review's own references to exact change-packet files come first.
  const cited = (path: string): boolean =>
    references.some(
      (reference) =>
        reference.origin === "controller" &&
        reference.path ===
          `Exact Git change packet file ${JSON.stringify(path)}`,
    );
  // Match only paths actually listed in the retained candidate. Failure prose
  // supplies presentation relevance, never new ownership or source authority.
  const relevant = (path: string): boolean => {
    if (!failure) return false;
    const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:^|[^\\w.\\-])${escaped}(?=$|[^\\w./\\-])`).test(
      failureText,
    );
  };
  const requested = requestedDiagnosisFiles(work);
  let changed = new Set<string>();
  try {
    if (work.baseSha)
      changed = new Set(
        pinnedGitRaw(
          checkout,
          "diff",
          "--name-only",
          "--no-renames",
          "-z",
          work.baseSha,
          treeSha,
          "--",
        )
          .toString("utf8")
          .split("\0")
          .filter(Boolean),
      );
  } catch {
    // Without the result base, change order is unavailable; the files remain.
  }
  const predecessors = mergedPredecessors(state, item);
  const files: {
    path: string;
    heading: string;
    content: string;
    complete: boolean;
  }[] = [];
  let total = 0;
  let namedTotal = 0;
  // Listing what did not fit is bounded too.
  let listedTotal = 0;
  try {
    const listed = treeFiles(checkout, treeSha);
    const rank = (path: string): number =>
      ownsPath(path, item.ownedPaths) ? 0 : 1;
    const owned = listed
      .map((file) => ({
        ...file,
        requested: requested.has(file.path),
        cited: cited(file.path),
        relevant: relevant(file.path),
        changed: changed.has(file.path),
        owner: ownsPath(file.path, item.ownedPaths)
          ? undefined
          : latestOwner(state, predecessors, file.path),
      }))
      .filter((file) => rank(file.path) === 0 || file.owner)
      .sort(
        (a, b) =>
          Number(b.requested) - Number(a.requested) ||
          Number(b.cited) - Number(a.cited) ||
          rank(a.path) - rank(b.path) ||
          Number(b.relevant) - Number(a.relevant) ||
          Number(b.changed) - Number(a.changed),
      );
    for (const file of owned) {
      const { path, size, owner } = file;
      const heading = owner
        ? `owned by ${owner.item.id} (merged)`
        : `owned by ${item.id} (the failing item)`;
      // Exact Git blob sizes are bytes. Prefer whole files within the bound
      // rather than prefixes that cannot establish readiness.
      const named = file.requested || file.cited;
      const fits = named
        ? namedTotal + size <= EVIDENCE_NAMED_BYTES
        : total + size <= EVIDENCE_TOTAL_BYTES;
      if (!fits) {
        // One file too large for what is left does not hide the smaller
        // ones after it. A cited, changed or requested one is still listed.
        const content = file.requested
          ? `[unavailable: ${size} bytes exceed what is left of the ${EVIDENCE_NAMED_BYTES}-byte bound on named files]`
          : size > EVIDENCE_NAMED_BYTES
            ? `[unavailable: ${size} bytes exceed the ${EVIDENCE_NAMED_BYTES}-byte bound on named files]`
            : `[omitted: ${size} bytes exceed what is left of the ${EVIDENCE_TOTAL_BYTES}-byte candidate bound; name it in requestedFiles to receive it]`;
        if (
          (named || file.relevant || file.changed) &&
          listedTotal + content.length <= EVIDENCE_TOTAL_BYTES
        ) {
          listedTotal += content.length;
          files.push({ path, heading, content, complete: false });
        }
        continue;
      }
      let content: string;
      let complete = false;
      try {
        content = new TextDecoder("utf-8", {
          fatal: true,
          ignoreBOM: true,
        }).decode(pinnedGitRaw(checkout, "show", `${treeSha}:${path}`));
        complete = true;
      } catch {
        content = "[unavailable: candidate is unreadable or not valid UTF-8]";
      }
      // An unreadable file costs its marker, so markers stay bounded.
      const bytes = complete ? size : content.length;
      if (named) namedTotal += bytes;
      else total += bytes;
      files.push({ path, heading, content, complete });
    }
  } catch {
    // Evidence is best effort: the diagnosis still runs on the failure record.
  }
  return files;
}

/** Narrow only a mapped exact-tree refusal; ambiguity keeps the complete workload. */
function focusedDiagnosisSources(
  state: FactoryState,
  item: WorkItem,
  evidence: ReturnType<typeof repairEvidence>,
  sources: PlanningRequest<DiagnosisAnswer>["sources"],
  checkout: string | undefined,
): number[] | undefined {
  const work = state.work[item.id]!;
  const refusal = work.recovery?.failure?.semanticRefusal;
  if (
    !checkout ||
    refusal?.source !== "model" ||
    refusal.finding.question.trim() ||
    // Focusing keeps only the first refusal's evidence; several need it all.
    refusal.others?.length ||
    work.step !== "validate" ||
    work.failedValidation ||
    item.dependencies.length ||
    work.recovery?.history?.length ||
    !work.baseSha ||
    !work.changeRef ||
    !work.validation?.worktreeObservation ||
    work.validation.selectedLfs?.length ||
    sources[0]?.path !== "OBJECTIVE" ||
    planningGraphView(
      { ...state.graph, items: [item] },
      sources,
    ).items[0]!.inputSources?.some((input) => !input.sourceSpan) ||
    state.graph.coverage.some(
      (entry) =>
        entry.itemId === item.id &&
        (entry.environment.readiness !== "available" ||
          entry.environment.preparedBy ||
          [entry.environment.probe, ...(entry.environment.prerequisites ?? [])]
            .filter(Boolean)
            .some(
              (command) => !item.validation.some((v) => v.command === command),
            )),
    )
  )
    return undefined;
  try {
    assertSemanticRefusalRecord(state, item.id, work, work.recovery!.failure);
    if (
      pinnedGitRaw(checkout, "rev-parse", `${work.changeRef}^{tree}`)
        .toString("utf8")
        .trim() !== work.treeSha
    )
      return undefined;
    // This is the change-packet producer's exact path namespace, not review prose.
    // Git supplies names/object identities only; supplied bodies are never reread.
    const changed = pinnedGitRaw(
      checkout,
      "diff",
      "--name-only",
      "--no-renames",
      "-z",
      work.baseSha,
      work.changeRef,
      "--",
    )
      .toString("utf8")
      .split("\0")
      .filter(Boolean);
    const selectedPaths = changed.filter((path) =>
      refusal.evidence.some(
        (reference) =>
          reference.origin === "controller" &&
          reference.complete &&
          reference.path ===
            `Exact Git change packet file ${JSON.stringify(path)}`,
      ),
    );
    if (
      !selectedPaths.length ||
      selectedPaths.some((path) => !ownsPath(path, item.ownedPaths))
    )
      return undefined;
    const files = evidence.filter((entry) => entry.kind === "candidate-file");
    if (
      selectedPaths.some(
        (path) =>
          !files.some(
            (file) => "path" in file && file.path === path && file.complete,
          ),
      )
    )
      return undefined;
    // Keep every complete owned candidate, including neighboring implementation.
    // Verify its original bytes by the tree's blob ID, without a second body read.
    const inventory = new Map(
      pinnedGitRaw(checkout, "ls-tree", "-r", "-z", work.treeSha!)
        .toString("utf8")
        .split("\0")
        .filter(Boolean)
        .map((entry) => {
          const tab = entry.indexOf("\t");
          return [
            entry.slice(tab + 1),
            entry.slice(0, tab).split(" "),
          ] as const;
        }),
    );
    for (const file of files) {
      if (!("path" in file) || !file.complete) continue;
      const descriptor = inventory.get(file.path);
      const content = Buffer.from(file.content);
      const blob = createHash("sha1")
        .update(`blob ${content.length}\0`)
        .update(content)
        .digest("hex");
      if (
        !ownsPath(file.path, item.ownedPaths) ||
        !descriptor ||
        !["100644", "100755"].includes(descriptor[0]!) ||
        descriptor[1] !== "blob" ||
        descriptor[2] !== blob
      )
        return undefined;
    }
    const retained = new Set([0]);
    for (const reference of refusal.evidence) {
      if (reference.origin !== "source") continue;
      const index = sources.findIndex(
        (source) =>
          source.path === reference.path &&
          reference.complete &&
          createHash("sha256").update(source.content).digest("hex") ===
            reference.digest,
      );
      if (index < 0) return undefined;
      retained.add(index);
    }
    const authorityPaths = new Set([
      ...item.validation.map((command) => command.source),
      ...item.citations
        .filter((citation) => citation.heading)
        .map((citation) => citation.path),
      ...state.graph.coverage
        .filter((entry) => entry.itemId === item.id)
        .map((entry) => entry.source.path),
      ...selectedPaths,
      "AGENTS.md",
      "README.md",
    ]);
    if (
      item.validation.some(
        (command) =>
          command.provenance !== "source-declared" ||
          !sources.some((source) => source.path === command.source),
      )
    )
      return undefined;
    sources.forEach((source, index) => {
      if (authorityPaths.has(source.path)) retained.add(index);
    });
    return [...retained].sort((a, b) => a - b);
  } catch {
    return undefined;
  }
}

/**
 * The sources the failing item pins: the Objective, the repository guides,
 * and what its citations, inputs, commands and coverage name. Other items'
 * sources are listed by identity only.
 */
function itemSourceIndices(
  state: FactoryState,
  item: WorkItem,
  view: ReturnType<typeof planningGraphView>["items"][number],
  sources: PlanningRequest<DiagnosisAnswer>["sources"],
): number[] {
  const pinned: { path: string; heading?: string }[] = [
    ...item.citations,
    ...(item.inputSources ?? []),
    ...item.validation.flatMap((command) =>
      command.source ? [{ path: command.source }] : [],
    ),
    ...state.graph.coverage
      .filter((entry) => entry.itemId === item.id)
      .map((entry) => entry.source),
  ];
  const spans = new Set(
    (view.inputSources ?? []).flatMap((input) =>
      input.sourceSpan ? [input.sourceSpan.sourceIndex] : [],
    ),
  );
  return sources.flatMap((source, index) =>
    spans.has(index) ||
    ["OBJECTIVE", "AGENTS.md", "README.md"].includes(source.path) ||
    pinned.some(
      (entry) =>
        entry.path === source.path &&
        (!entry.heading || !source.heading || entry.heading === source.heading),
    )
      ? [index]
      : [],
  );
}

/** Transient diagnosis inputs; canonical graph and indexed repair evidence remain unchanged. */
export function workRepairDiagnosisRequest(args: {
  state: FactoryState;
  item: WorkItem;
  evidence: ReturnType<typeof repairEvidence>;
  sources: PlanningRequest<DiagnosisAnswer>["sources"];
  rejected?: string;
  invocation?: PlanningRequest<DiagnosisAnswer>["invocation"];
  checkout?: string;
}): PlanningRequest<DiagnosisAnswer> {
  const { state, item, evidence, sources, rejected, invocation } = args;
  const work = state.work[item.id]!;
  const failure = work.recovery!.failure!;
  const predecessors = mergedPredecessors(state, item);
  const focusedSources = focusedDiagnosisSources(
    state,
    item,
    evidence,
    sources,
    args.checkout,
  );
  const evidenceIndices = evidence.flatMap((entry, index) =>
    !focusedSources ||
    index < 2 ||
    (entry.kind === "candidate-file" &&
      "path" in entry &&
      entry.complete &&
      ownsPath(entry.path, item.ownedPaths))
      ? [index]
      : [],
  );
  const { inputSources: historicalInputs, ...focusedItem } = item;
  const view = planningGraphView(
    { ...state.graph, items: [item] },
    sources,
    args.checkout
      ? workItemSourceResolver({
          checkout: args.checkout,
          baseSha: state.graph.baseSha,
          objectiveBody: sources.find((source) => source.path === "OBJECTIVE")
            ?.content,
        })
      : undefined,
  ).items[0]!;
  // Inputs no pinned source holds render once as literal blocks, not as
  // escaped JSON strings.
  const inputBodies: { label: string; content: string }[] = [];
  const itemView = focusedSources
    ? focusedItem
    : {
        ...view,
        ...(view.inputSources && {
          inputSources: view.inputSources.map((input) => {
            if (input.content === undefined) return input;
            const { content, ...identity } = input;
            const label = `input ${inputBodies.length}`;
            inputBodies.push({ label, content });
            return { ...identity, content: { block: label } };
          }),
        }),
      };
  const inputs = literalBodyBlocks(inputBodies);
  const visibleEvidence = evidence.map((entry, index) => {
    if (evidenceIndices.includes(index) || !("content" in entry)) return entry;
    const { content, ...metadata } = entry;
    return {
      ...metadata,
      contentDelivery: "omitted",
      contentBytes: Buffer.byteLength(content),
      contentDigest: createHash("sha256").update(content).digest("hex"),
    };
  });
  return {
    purpose: "diagnosis",
    workRepairDiagnosis: {
      mode: focusedSources ? "focused-semantic-refusal" : "complete",
      evidenceDigest: inputDigest(evidence),
      sourcesDigest: inputDigest(sources),
      evidenceIndices,
      sourceIndices:
        focusedSources ?? itemSourceIndices(state, item, view, sources),
    },
    objective: `Diagnose this failed Work Item using its original evidence. Return a concrete correction within the unchanged acceptance, ownership, commands and configured authority. Do not propose weaker validation, provider changes, new permissions or repeating an unchanged failure. Readiness is actionable only when an owned implementation change can proceed now without any unmet or unknown operator prerequisite. List every outstanding prerequisite with its concrete question, even when decision is repair; never claim an external action happened because a correction proposes it. Command failures require their retained failed-command capture. Assess every retained failed command by its original commandIndex; passed commands are not failed evidence. An explicitly retained semanticRefusal instead names the exact rejected review or operator decision after passing commands: ground that refusal and its separate passingValidation, and return commandAssessments as [] when there are no failed commands. Include every required output field; commandAssessments must never be omitted. Missing command outcomes do not imply semantic refusal. Ground the correction with repairEvidence indices, including the original failure, retained validation when available and the complete named owned candidate file when present. Missing or truncated facts are unavailable. Candidate-file entries are the failed result's owned files: first the files an earlier answer asked for and the change-packet files the review cites, whole within ${EVIDENCE_NAMED_BYTES} bytes; then other files the failure names, the files this attempt changed and the rest, whole within ${EVIDENCE_TOTAL_BYTES} bytes; an entry with complete false is a file Factory holds but did not supply whole. Factory holds every owned file of the result: when your answer needs one this request does not supply whole, list its path in requestedFiles and Factory asks again with it supplied. Never ask the operator for candidate contents or other evidence Factory holds. Otherwise requestedFiles is []. With actionable repair, path names the owned file to change, question is empty and prerequisites is empty. Otherwise return operator-required or unknown readiness and a concrete question. If the failure comes from a file this item does not own but a merged predecessor does (see predecessors, and the files under "owned by"), return predecessor with that predecessor's id and the file's path: the item cannot fix it. If evidence cannot establish a correction, return operator. Prior unfinished uncommitted edits are unavailable. A repair continues from the refused committed result when it is retained (its files are in the repair's working tree), otherwise from the accepted base.\n${JSON.stringify({ item: itemView, ...(focusedSources && { historicalWorkerInputs: { contentDelivery: "omitted", count: historicalInputs?.length ?? 0, digest: inputDigest(historicalInputs ?? []) } }), failure, predecessors: predecessors.map((entry) => ({ id: entry.item.id, pullRequest: entry.pullRequest, ownedPaths: entry.item.ownedPaths })), prior: work.recovery?.history?.map((entry) => ({ failure: entry.failure, correction: entry.correction })), treeSha: work.treeSha, changeRef: work.changeRef, repairEvidence: visibleEvidence })}${inputBodies.length ? `\nWork Item input bodies. ${inputs.guidance} An input content {"block": LABEL} is the complete literal body in that block.\n${inputs.text}` : ""}${rejected ? `\nYour previous answer was rejected: ${rejected}. Answer again.` : ""}`,
    baseSha: work.executionBaseSha ?? state.baseSha,
    sources,
    controllerCapabilities: installedControllerCapabilities(),
    controllerCapabilitiesDigest: CONTROLLER_CAPABILITIES_DIGEST,
    schema: diagnosisSchema,
    invocation,
  };
}

export async function diagnoseWorkRepair(args: {
  state: FactoryState;
  item: WorkItem;
  model: PlanningModel;
  save: () => void;
  stopped: () => boolean;
  diagnostics?: DiagnosticEmitter;
  sources?: { path: string; content: string; heading?: string }[];
  /** The target checkout: the failed result's files are read from it. */
  checkout?: string;
  /** Existing retained-content seam for adaptive diagnosis context. */
  contentStore?: ContentStore;
  /** The run's cancel signal: ends the diagnose step's wait or try. */
  signal?: AbortSignal;
  /** The run's pause signal: ends the diagnose step's wait; it resumes later. */
  pause?: AbortSignal;
  /** Backoff time for the diagnose step; tests inject one. */
  clock?: StepClock;
}): Promise<boolean> {
  const { state, item, save } = args;
  const work = state.work[item.id]!;
  const failure = work.recovery?.failure;
  // Only a wrong result has a failure event; anything else is repeated or
  // fixed, never diagnosed against an allowance. A cancelled run diagnoses
  // nothing.
  if (!failure?.event || work.status !== "failed" || args.signal?.aborted)
    return false;
  const retry = retryCommand(state, item.id);
  const stop = (decision: string): false => {
    work.recovery!.phase = "stopped";
    failure.decision = decision;
    save();
    return false;
  };
  if (work.recovery?.phase === "ready" && work.recovery.correction) {
    // The next pass applies a ready correction once the run goes on.
    if (args.stopped()) return false;
    const correction = work.recovery.correction;
    try {
      assertRepairReadiness(state, item.id, work, correction, failure);
      if (
        correction.readiness!.inputDigest !==
        inputDigest(
          repairEvidence(
            state,
            item,
            diagnosisFiles(state, item, args.checkout),
          ),
        )
      )
        throw new Error(
          "Saved automatic repair inputs changed or are unavailable; which concrete correction is ready now?",
        );
      applyWorkCorrection(state, item.id, correction);
    } catch (error) {
      return stop(error instanceof Error ? error.message : String(error));
    }
    save();
    return true;
  }
  // The charge is keyed by the failure event, so a diagnosis repeated after
  // a restart or a lost response is not charged again.
  try {
    chargeRepair(
      state,
      failure.event,
      "implementation",
      repairScopes(state, item.id),
    );
  } catch (error) {
    return stop(
      `${error instanceof Error ? error.message : String(error)}; start a new attempt with \`${retry}\``,
    );
  }
  work.recovery!.phase = "diagnosing";
  save();
  // Paused, or an amendment pending: the diagnosis is due, not dropped. The
  // phase is "diagnosing", so resumeDiagnoses asks it once the run goes on
  // (pause is not cancel; its event is already charged).
  if (args.stopped()) return false;
  // A model review's refused findings already say what to fix: they go to
  // the repair as its correction, under the charge above, with no diagnosis.
  const findings = reviewFindingsCorrection(state, item.id);
  if (findings) {
    try {
      applyWorkCorrection(state, item.id, findings);
    } catch (error) {
      return stop(error instanceof Error ? error.message : String(error));
    }
    save();
    return true;
  }
  // A paid step: a lost answer is asked again, an invalid one again with
  // its validation error, until the paid bound makes it a decision.
  let answer: RepairCorrection | string | { blame: Blame; diagnosis: string };
  try {
    answer = await step(
      state,
      { scope: { item: item.id }, name: "diagnose", paid: true },
      (context) => {
        // The last answer's error, kept in the step's record across a restart.
        const rejected = context.previousInvalid();
        return context.paid(() =>
          withPlannerAdmission(state, args.stopped, async () => {
            if (
              state.work[item.id] !== work ||
              work.status !== "failed" ||
              work.recovery?.failure !== failure
            )
              throw new StepFault({
                kind: "decision",
                evidence: [],
                question:
                  "Work Item failure changed while waiting for the planner; revalidate the current failure before diagnosis",
              });
            const evidence = repairEvidence(
              state,
              item,
              diagnosisFiles(state, item, args.checkout),
            );
            const recovering =
              work.recovery!.diagnosisInvocation?.submitted === true;
            work.recovery!.diagnosisInvocation ??= {
              id: randomUUID(),
              submitted: false,
            };
            const invocation = work.recovery!.diagnosisInvocation;
            const invalidDiagnosis = (
              detail: string,
              response: unknown,
            ): never => {
              work.recovery!.diagnosisInvocation = {
                id: randomUUID(),
                submitted: false,
                rejected: [
                  ...(invocation.rejected ?? []),
                  {
                    id: invocation.id,
                    response: structuredClone(response),
                    ...(invocation.nativeReturns && {
                      nativeReturns: structuredClone(invocation.nativeReturns),
                    }),
                  },
                ],
              };
              save();
              context.invalid(detail);
              throw new StepFault(
                transient(`Diagnosis was invalid: ${detail}`, true),
              );
            };
            const request = workRepairDiagnosisRequest({
              state,
              item,
              evidence,
              sources: args.sources ?? [],
              checkout: args.checkout,
              rejected,
              invocation: {
                invocationId: invocation.id,
                ...(args.model.providerDispatchAdmission ===
                "after-attempt-admission-v1"
                  ? {
                      beforeProviderDispatch: async () => {
                        if (work.recovery?.diagnosisInvocation !== invocation)
                          throw new Error(
                            "Diagnosis dispatch differs from its current owner",
                          );
                        // An earlier provider attempt of this invocation may
                        // have dispatched; only this attempt's own intent is
                        // withdrawn when its admission fails.
                        const intended = !invocation.submitted;
                        invocation.submitted = true;
                        try {
                          save();
                        } catch (error) {
                          if (intended) invocation.submitted = false;
                          throw error;
                        }
                        if (![17, 19].includes(state.schemaVersion)) return;
                        try {
                          await awaitCheckpointAdmission(
                            state.repository,
                            "before-effect",
                          );
                        } catch (error) {
                          // The native call follows this hook, so nothing was
                          // sent: withdraw the intent instead of leaving a
                          // submission no settlement can ever resolve.
                          if (
                            intended &&
                            work.recovery?.diagnosisInvocation === invocation
                          ) {
                            invocation.submitted = false;
                            save();
                          }
                          throw error;
                        }
                        return "admission-complete" as const;
                      },
                    }
                  : {}),
                ...([17, 19].includes(state.schemaVersion)
                  ? {
                      // The declared dispatch hook above follows with no effect
                      // between; it admits these attempt facts with its intent.
                      ...(args.model.providerDispatchAdmission !==
                        "after-attempt-admission-v1" && {
                        beforeProviderAttempt: () =>
                          awaitCheckpointAdmission(
                            state.repository,
                            "before-effect",
                          ),
                      }),
                      retainNativeReturn: async (
                        receipt: Parameters<
                          NonNullable<
                            import("./contracts.js").ModelInvocationContext["retainNativeReturn"]
                          >
                        >[0],
                      ) => {
                        if (
                          !args.contentStore ||
                          work.recovery?.diagnosisInvocation !== invocation
                        )
                          throw new Error(
                            "Native diagnosis return lacks its current owned content store",
                          );
                        const bytes = Buffer.from(
                          JSON.stringify({
                            schemaVersion: 1,
                            invocationId: invocation.id,
                            phase: "diagnosis",
                            ...receipt,
                          }),
                        );
                        const ref = await args.contentStore.put(
                          Readable.toWeb(
                            Readable.from([bytes]),
                          ) as ReadableStream<Uint8Array>,
                          { mediaType: "application/json" },
                        );
                        invocation.nativeReturns ??= [];
                        invocation.nativeReturns.push(ref);
                        save();
                        // Retained locally; the next pre-effect checkpoint
                        // carries it.
                        await awaitCheckpointAdmission(
                          state.repository,
                          "settled",
                        );
                        return "admission-complete" as const;
                      },
                    }
                  : {}),
                phase: "diagnosis",
                ordinal: consumption(state).implementationRepairs,
                observe: args.diagnostics?.modelObserver({
                  scopeId: work.attempt!,
                  runId: state.runId,
                  itemId: item.id,
                  attemptId: work.attempt,
                }),
              },
            });
            if (state.planningRecovery?.contextLookup?.packet) {
              if (!args.checkout || !args.contentStore)
                throw new StepFault({
                  kind: "decision",
                  evidence: [],
                  question:
                    "Adaptive diagnosis requires its admitted checkout and retained content store; preserve the current failure and restore those inputs before diagnosis",
                });
              assertWorkAdaptiveContext(state, item.id, work);
              const dispatchPacket = work.adaptiveContextId
                ? state.adaptiveContexts?.[work.adaptiveContextId]
                : undefined;
              const dispatch = dispatchPacket
                ? await authenticateAdaptiveContextPacket(
                    args.contentStore,
                    dispatchPacket,
                  )
                : undefined;
              // QA and preparation failures legitimately have no coding dispatch.
              // Select their declared inputs now without inventing old consumption.
              const baseSha = work.changeRef ?? work.baseSha ?? state.baseSha;
              const discovered = dispatch
                ? undefined
                : await selectedDiscoveryInputs({
                    state,
                    item,
                    checkout: args.checkout,
                    store: args.contentStore,
                  });
              const discoveryBodies = discovered
                ? discoveryContextBodies(discovered)
                : [];
              const knowledge = dispatch
                ? undefined
                : await completeObjectiveKnowledge({
                    state,
                    item,
                    checkout: args.checkout,
                    baseSha,
                    store: args.contentStore,
                    suppliedDigests: [
                      ...discoveryBodies.map((body) => body.ref.digest),
                      ...request.sources.map((source) =>
                        createHash("sha256")
                          .update(source.content)
                          .digest("hex"),
                      ),
                    ],
                  });
              const retainedInputs = dispatch?.required as
                | {
                    discoveryInputs?: SelectedDiscoveryInput[];
                    knowledge?: {
                      bodies?: { ref: ContentRef; bytes: string }[];
                    };
                  }
                | undefined;
              const selected = await buildAdaptiveContext({
                state,
                role: "diagnosis",
                item,
                baseSha,
                checkout: args.checkout,
                store: args.contentStore,
                sources: request.sources,
                required: {
                  failureEvent: failure.event,
                  suppliedCaseDigest: inputDigest(evidence),
                  failingAttemptInputs: dispatch?.required ?? {
                    discoveryInputs: discovered ?? [],
                    knowledge: knowledge?.view ?? {},
                  },
                  ...(dispatch
                    ? { failingAttemptDelegation: dispatch.delegation }
                    : {}),
                  inputOrigin: dispatch
                    ? "retained-dispatch"
                    : "diagnosis-selection",
                  interpretation:
                    "The complete failing case and authorized sources are already supplied by this diagnosis request; this binding reuses those bytes without repeating them.",
                },
                requiredSelections: dispatchPacket
                  ? dispatchPacket.selections.filter(
                      (selection) =>
                        selection.required &&
                        selection.kind !== "decision" &&
                        selection.kind !== "supplied",
                    )
                  : [
                      ...discoveryContextSelections(discovered ?? []),
                      ...(knowledge?.selections ?? []),
                    ],
                suppliedBodies: dispatch
                  ? [
                      ...discoveryContextBodies(
                        retainedInputs?.discoveryInputs ?? [],
                      ),
                      ...(retainedInputs?.knowledge?.bodies ?? []).map(
                        (body) => ({
                          ref: body.ref,
                          bytes: Buffer.from(body.bytes, "base64"),
                        }),
                      ),
                    ]
                  : [...discoveryBodies, ...(knowledge?.suppliedBodies ?? [])],
                save,
              });
              if (selected) {
                request.adaptiveContext = selected.packet;
                request.objective += `\n${selected.evidence.content}`;
              }
            }
            const requestDigest = createHash("sha256")
              .update(JSON.stringify(request))
              .digest("hex");
            if (recovering && invocation.requestDigest !== requestDigest)
              throw new StepFault({
                kind: "decision",
                evidence: [],
                question:
                  "The retained diagnosis request differs from current evidence; preserve the original submission rather than replaying it",
              });
            invocation.requestDigest = requestDigest;
            // Local evidence authentication can fail without any submitted effect.
            // Freeze the complete request before dispatch, never before hydration.
            // Opaque models cannot establish an admission/dispatch boundary.
            // Declared models freeze this intent only after every admission hook passes.
            if (
              args.model.providerDispatchAdmission !==
              "after-attempt-admission-v1"
            )
              invocation.submitted = true;
            save();
            const response = (invocation.response ??
              (await generatePlannerStructured<DiagnosisAnswer>(
                args.model,
                state,
                save,
                request,
                recovering,
              ))) as DiagnosisAnswer;
            invocation.response = structuredClone(response);
            save();
            if (
              !response ||
              typeof response !== "object" ||
              Array.isArray(response)
            )
              return "What concrete correction or operator prerequisite makes the original failure ready to proceed? The diagnosis is unavailable.";
            // Evidence Factory holds is supplied, not asked of the operator:
            // the files named here are read whole into the next request.
            const held = heldCandidateRequests(
              state,
              item,
              response,
              evidence,
              args.checkout,
            );
            if (held.length)
              invalidDiagnosis(
                `it needs ${held.join(", ")} whole, which this request did not supply; Factory holds ${held.length === 1 ? "it" : "them"} and repairEvidence now supplies ${held.length === 1 ? "it" : "them"}`,
                response,
              );
            if (response.decision === "predecessor") {
              try {
                return {
                  blame: blamedPredecessor(
                    state,
                    item,
                    response,
                    args.checkout,
                  ),
                  diagnosis: response.diagnosis,
                };
              } catch (error) {
                const detail =
                  error instanceof Error ? error.message : String(error);
                invalidDiagnosis(detail, response);
              }
            }
            if (response.decision !== "repair")
              return (
                response.question?.trim() ||
                "What concrete operator decision resolves the original failure?"
              );
            const readiness = actionableReadiness(
              state,
              item,
              response,
              evidence,
              args.checkout,
              request.workRepairDiagnosis?.evidenceIndices,
            );
            if (typeof readiness === "string") return readiness;
            const proposed: RepairCorrection = {
              kind: "implementation",
              failureDigest: failure.digest,
              event: failure.event,
              diagnosis: response.diagnosis,
              correction: response.correction,
              actor: "factory-controller",
              readiness,
            };
            try {
              validateCorrection(work, proposed);
            } catch (error) {
              const detail =
                error instanceof Error ? error.message : String(error);
              invalidDiagnosis(detail, response);
            }
            return proposed;
          }),
        );
      },
      {
        save,
        ...(args.signal && { signal: args.signal }),
        ...(args.pause && { pause: args.pause }),
        ...(args.clock && { clock: args.clock }),
      },
    );
  } catch (error) {
    // Paused or cancelled: stop quietly. The phase stays "diagnosing", so
    // the next run asks again (its event is already charged).
    if (error instanceof StepPaused) return false;
    // A decision (the paid bound, a refusal) stops the diagnosis for the
    // operator; a configuration fix leaves it due (step rule 7): the step
    // waits, and the next run asks again under the event already charged.
    // Anything else is a defect.
    const fault = faultOf(error);
    if (fault.kind === "cancelled") return false;
    if (fault.kind === "decision")
      return stop(
        `${fault.question} Supply a correction (\`factory repair --objective ${state.objective} --proposal FILE\`) or start a new attempt with \`${retry}\``,
      );
    if (fault.kind === "config") {
      failure.decision = `${fault.fix}; then \`factory run --objective ${state.objective}\` asks the diagnosis again`;
      save();
      return false;
    }
    throw error;
  }
  if (typeof answer === "string") return stop(answer);
  if ("blame" in answer) {
    // The defect is in a merged predecessor: no repair of this item can pass,
    // so none is spent. The allowance the diagnosis took is given back and
    // the failure becomes a decision about the predecessor.
    const { blame, diagnosis } = answer;
    releaseCharge(state, failure.event);
    delete failure.event;
    failure.classification = "decision";
    failure.continuation = "operator-decision";
    failure.predecessor = {
      ...blame,
      diagnosis: cappedDiagnosis(diagnosis),
      graphDigest: graphDigest(state.graph),
    };
    return stop(
      blameDecision(state, item.id, failure.predecessor.graphDigest)!,
    );
  }
  const correction = answer;
  work.recovery!.correction = correction;
  work.recovery!.phase = "ready";
  save();
  if (args.stopped()) return false;
  applyWorkCorrection(state, item.id, correction);
  save();
  return true;
}

/**
 * Ask again any diagnosis a restart left under way.
 * Its event is already charged, so asking again is free.
 */
export async function resumeDiagnoses(
  args: Omit<Parameters<typeof diagnoseWorkRepair>[0], "item">,
): Promise<void> {
  for (const item of args.state.graph.items) {
    const work = args.state.work[item.id];
    if (work?.status === "failed" && work.recovery?.phase === "diagnosing")
      await diagnoseWorkRepair({ ...args, item });
  }
}
