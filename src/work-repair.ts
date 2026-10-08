import { createHash, randomUUID } from "node:crypto";
import type { DiagnosticEmitter } from "./diagnostics.js";
import { attachFault, faultOf, StepFault, transient } from "./fault.js";
import { type StepClock, StepPaused, clearRepeats, step } from "./step.js";
import type { PlanningModel, WorkItem } from "./contracts.js";
import { blameDecision, cappedDiagnosis } from "./blame-decision.js";
import { graphDigest, recordWorkerDiscovery } from "./graph-amendments.js";
import { ownsPath, validOwnershipPath } from "./ownership.js";
import { pinnedGitRaw } from "./process.js";
import {
  installedControllerCapabilities,
  CONTROLLER_CAPABILITIES_DIGEST,
} from "./controller-capabilities.js";
import type { FactoryState } from "./state.js";
import {
  assertSemanticRefusalRecord,
  SemanticAcceptanceFailure,
  semanticValidationDigest,
} from "./semantic-refusal.js";
import {
  assertFailedValidationEvidence,
  assertFailedValidationRecord,
  failedValidationDigest,
  type FailedValidationEvidence,
  type FailedValidationRecord,
} from "./failed-validation.js";
import {
  archiveAttempt,
  chargeRepair,
  consumption,
  failureDigest,
  implementationRepairable,
  itemEvent,
  releaseCharge,
  repairScopes,
  validateCorrection,
  type FailureClass,
  type FailureDisposition,
  type RepairCorrection,
} from "./repair-policy.js";

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
    assertFailedValidationRecord(retained, state, id, work, failure);
    work.failedValidation = structuredClone(retained);
  }
  if (
    isolated &&
    work.step === "validate" &&
    error instanceof SemanticAcceptanceFailure
  ) {
    if (!work.validation)
      throw new Error("Semantic refusal has no retained validation evidence");
    failure.semanticRefusal = {
      ...structuredClone(error.semanticRefusal),
      validationDigest: semanticValidationDigest(work.validation),
    };
    assertSemanticRefusalRecord(state, id, work, failure);
  }
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

/** A retained current unpublished refusal; this preview creates no failure event. */
export function savedResultRefusal(state: FactoryState, id: string) {
  const work = state.work[id];
  const refusal = work?.acceptanceDecisions?.at(-1);
  const item = state.graph.items.find((item) => item.id === id);
  if (
    !work ||
    work.recovery?.failure ||
    work.status !== "failed" ||
    work.step !== "validate" ||
    work.integratedSha ||
    work.pullRequest ||
    work.acceptancePending ||
    !work.attempt ||
    !work.changeRef ||
    !work.treeSha ||
    work.validation?.treeSha !== work.treeSha ||
    refusal?.outcome !== "refuse" ||
    refusal.treeSha !== work.treeSha ||
    !item?.acceptance.includes(refusal.criterion) ||
    work.error !== `Acceptance refused: ${refusal.criterion}` ||
    state.error ||
    state.cancelRequested ||
    state.cancelledAt ||
    state.finalAcceptance ||
    state.finalValidation?.passed ||
    state.objectiveClosure === "complete"
  )
    return undefined;
  return { detail: work.error, digest: failureDigest(work.error) };
}

/** Reconcile a genuine saved refusal only during locked, settled operator repair. */
export function recordSavedResultRefusal(
  state: FactoryState,
  id: string,
  checkout: string,
): boolean {
  const refusal = savedResultRefusal(state, id);
  if (!refusal) return false;
  if (
    !["paused", "draining"].includes(state.coordinator?.mode ?? "") ||
    state.coordinator?.cancelError ||
    state.coordinator?.processes?.length ||
    Object.values(state.repeats ?? {}).some((record) => record.inFlight)
  )
    throw new Error("Saved refusal repair requires paused, settled ownership");
  const work = state.work[id]!;
  const tree = pinnedGitRaw(checkout, "rev-parse", `${work.changeRef}^{tree}`)
    .toString("utf8")
    .trim();
  if (tree !== work.treeSha)
    throw new Error("Saved refusal differs from the exact candidate tree");
  // recordWorkFailure observes the failure now. The original decision and
  // its time/reason stay in acceptanceDecisions; no command receipt is invented.
  const decision = work.acceptanceDecisions!.at(-1)!;
  recordWorkFailure(
    state,
    id,
    new SemanticAcceptanceFailure(refusal.detail, {
      treeSha: decision.treeSha,
      criterion: decision.criterion,
      source: "operator",
      decision,
    }),
  );
  return true;
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
        !Number.isSafeInteger(index) || index < 0 || index >= evidence.length,
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

const EVIDENCE_FILE_BYTES = 16_000;
const EVIDENCE_TOTAL_BYTES = 64_000;
/** A larger blob is not read at all: it is not source a diagnosis can use. */
const EVIDENCE_READ_BYTES = 1_000_000;
/**
 * The files of the failed result that it and its merged predecessors own, as
 * text: what a diagnosis needs to tell whose file is wrong. They are read from
 * the result tree, which holds the integrated predecessors' files. The failing
 * item's own files come first, so the budget never goes to a predecessor
 * before them.
 */
export function diagnosisFiles(
  state: FactoryState,
  item: WorkItem,
  checkout: string | undefined,
): { path: string; heading: string; content: string; complete: boolean }[] {
  const treeSha = state.work[item.id]?.treeSha;
  if (!checkout || !treeSha) return [];
  const predecessors = mergedPredecessors(state, item);
  const files: {
    path: string;
    heading: string;
    content: string;
    complete: boolean;
  }[] = [];
  let total = 0;
  try {
    const listed = treeFiles(checkout, treeSha);
    // The failing item's files first, so the budget never goes to a
    // predecessor before them.
    const rank = (path: string): number =>
      ownsPath(path, item.ownedPaths) ? 0 : 1;
    const owned = listed
      .map((file) => ({
        ...file,
        owner: ownsPath(file.path, item.ownedPaths)
          ? undefined
          : latestOwner(state, predecessors, file.path),
      }))
      .filter((file) => rank(file.path) === 0 || file.owner)
      .sort((a, b) => rank(a.path) - rank(b.path));
    for (const { path, size, owner } of owned) {
      // The budget is spent: nothing more is read.
      if (total >= EVIDENCE_TOTAL_BYTES) break;
      // Check the size before reading the blob. A character takes at most
      // three bytes, so this bounds what is read from below.
      if (
        size > EVIDENCE_READ_BYTES ||
        total + Math.min(Math.ceil(size / 3), EVIDENCE_FILE_BYTES) >
          EVIDENCE_TOTAL_BYTES
      )
        continue;
      let content: string;
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(
          pinnedGitRaw(checkout, "show", `${treeSha}:${path}`),
        );
      } catch {
        continue;
      }
      const complete = content.length <= EVIDENCE_FILE_BYTES;
      if (!complete)
        content = `${content.slice(0, EVIDENCE_FILE_BYTES)}\n[truncated]`;
      // One file too large for what is left does not hide the smaller
      // ones after it.
      if (total + content.length > EVIDENCE_TOTAL_BYTES) continue;
      total += content.length;
      files.push({
        path,
        heading: owner
          ? `owned by ${owner.item.id} (merged)`
          : `owned by ${item.id} (the failing item)`,
        content,
        complete,
      });
    }
  } catch {
    // Evidence is best effort: the diagnosis still runs on the failure record.
  }
  return files;
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
  // A paid step: a lost answer is asked again, an invalid one again with
  // its validation error, until the paid bound makes it a decision.
  const predecessors = mergedPredecessors(state, item);
  const files = diagnosisFiles(state, item, args.checkout);
  const evidence = repairEvidence(state, item, files);
  let answer: RepairCorrection | string | { blame: Blame; diagnosis: string };
  try {
    answer = await step(
      state,
      { scope: { item: item.id }, name: "diagnose", paid: true },
      (context) => {
        // The last answer's error, kept in the step's record across a restart.
        const rejected = context.previousInvalid();
        return context.paid(async () => {
          const response = await args.model.generateStructured<DiagnosisAnswer>(
            {
              purpose: "diagnosis",
              objective: `Diagnose this failed Work Item using its original evidence. Return a concrete correction within the unchanged acceptance, ownership, commands and configured authority. Do not propose weaker validation, provider changes, new permissions or repeating an unchanged failure. Readiness is actionable only when an owned implementation change can proceed now without any unmet or unknown operator prerequisite. List every outstanding prerequisite with its concrete question, even when decision is repair; never claim an external action happened because a correction proposes it. Command failures require their retained failed-command capture. Assess every retained failed command by its original commandIndex; passed commands are not failed evidence. An explicitly retained semanticRefusal instead names the exact rejected review or operator decision after passing commands: ground that refusal and its separate passingValidation, and return no commandAssessments when there are no failed commands. Missing command outcomes do not imply semantic refusal. Ground the correction with repairEvidence indices, including the original failure, retained validation when available and the complete named owned candidate file when present. Missing or truncated facts are unavailable. With actionable repair, path names the owned file to change, question is empty and prerequisites is empty. Otherwise return operator-required or unknown readiness and a concrete question. If the failure comes from a file this item does not own but a merged predecessor does (see predecessors, and the files under "owned by"), return predecessor with that predecessor's id and the file's path: the item cannot fix it. If evidence cannot establish a correction, return operator. Prior unfinished edits are unavailable; a repair starts from the accepted base.${rejected ? `\nYour previous answer was rejected: ${rejected}. Answer again.` : ""}\n${JSON.stringify({ item, failure, predecessors: predecessors.map((entry) => ({ id: entry.item.id, pullRequest: entry.pullRequest, ownedPaths: entry.item.ownedPaths })), prior: work.recovery?.history?.map((entry) => ({ failure: entry.failure, correction: entry.correction })), treeSha: work.treeSha, changeRef: work.changeRef, repairEvidence: evidence })}`,
              baseSha: work.executionBaseSha ?? state.baseSha,
              sources: [...(args.sources ?? []), ...files],
              controllerCapabilities: installedControllerCapabilities(),
              controllerCapabilitiesDigest: CONTROLLER_CAPABILITIES_DIGEST,
              schema: diagnosisSchema,
              invocation: {
                invocationId: randomUUID(),
                phase: "diagnosis",
                ordinal: consumption(state).implementationRepairs,
                observe: args.diagnostics?.modelObserver({
                  scopeId: work.attempt!,
                  runId: state.runId,
                  itemId: item.id,
                  attemptId: work.attempt,
                }),
              },
            },
          );
          if (
            !response ||
            typeof response !== "object" ||
            Array.isArray(response)
          )
            return "What concrete correction or operator prerequisite makes the original failure ready to proceed? The diagnosis is unavailable.";
          if (response.decision === "predecessor") {
            try {
              return {
                blame: blamedPredecessor(state, item, response, args.checkout),
                diagnosis: response.diagnosis,
              };
            } catch (error) {
              const detail =
                error instanceof Error ? error.message : String(error);
              context.invalid(detail);
              throw new StepFault(
                transient(`Diagnosis was invalid: ${detail}`, true),
              );
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
            context.invalid(detail);
            throw new StepFault(
              transient(`Diagnosis was invalid: ${detail}`, true),
            );
          }
          return proposed;
        });
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
