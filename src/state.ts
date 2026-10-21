import { assertWorkRoutingState } from "./runner/routing.js";
import { assertWorkflowReflection } from "./workflow-reflection.js";
import {
  assertWorkflowRecipePin,
  assertWorkflowRecipeAdmissionBinding,
} from "./workflow-recipes.js";
import { assertWorkItemScheduling } from "./scheduler.js";
import { assertAdaptiveContextPacket } from "./adaptive-context.js";
import { assertPlanningLookupRecord } from "./compiler/context.js";
import { questionDigest } from "./compiler/packets.js";
import {
  assertDiscoveryOutputManifest,
  assertDiscoverySpecification,
  discoverySpecificationDigest,
} from "./discovery.js";
import { assertRepositoryMemoryBindings } from "./repository-memory.js";
import {
  assertReviewArtifactSelection,
  assertReviewArtifacts,
} from "./review-artifacts.js";
import { assertAgentSessions } from "./agent-session.js";
import { assertFinalAcceptance } from "./completion.js";
import { type Capacity, validateCapacity } from "./config.js";
import type {
  AssetSelectionDecision,
  AuthenticationRequest,
  CapturedAssetSet,
  ContentRef,
  ExecutionHandle,
  NamedCheckEvidence,
  NativeStackLayer,
  ResultReviewCandidate,
  WorkGraph,
} from "./contracts.js";
import {
  assertApprovedPlaybookAdmission,
  assertApprovedPlaybookPin,
} from "./contracts.js";
import { assertPublicationIntents } from "./delivery/publication.js";
import { assertPreIntegrationCheckShape } from "./delivery/readiness.js";
import {
  assertFailedValidationEvidence,
  assertFailedValidationRecord,
  type FailedValidationRecord,
} from "./failed-validation.js";
import {
  assertRepeats,
  assertWait,
  parseRepeatKey,
  type RepeatRecord,
  type Wait,
} from "./fault.js";
import {
  assertGitHubProgressProjection,
  assertLiveStatusRecord,
} from "./github-progress-state.js";
import { assertGitHubProjectStatusProjection } from "./github-project-state.js";
import {
  assertGraphRevisions,
  assertWorkerDiscoveryDisposition,
  graphDigest,
} from "./graph-amendments.js";
import { assertGraphProjectionIntents } from "./graph-projection-control.js";
import { assertExpansionState } from "./runner/expansion.js";
import {
  assertAssetCaptureReceipt,
  assertHydrationReceipt,
  assetSelectionDigest,
  finalValidationLfsMembers,
} from "./media.js";
import { assertNativePrerequisites } from "./native-prerequisite-evidence.js";
import { assertObjectiveKnowledge } from "./objective-knowledge.js";
import { assertAcceptedPlanningDecision } from "./planning-decision-context.js";
import {
  assertCompletedCoverage,
  assertCoverageShape,
  environmentValidationIndices,
  reusableEnvironmentValidationIndices,
  finalReceiptsMatch,
  objectiveCandidate,
} from "./qa.js";
import {
  type Autonomy,
  assertRepairLedger,
  retainedFailedResultFor,
  type WorkRecovery,
} from "./repair-policy.js";
import { assertSemanticRefusalRecord } from "./semantic-refusal.js";
import type { AcceptanceDecision, ValidationEvidence } from "./validation.js";
import {
  assertSelectedLfsValidation,
  assertValidationWorktreeObservation,
  validStoppedLeftovers,
} from "./validation.js";
import {
  assertRetainedReviewEvidence,
  assertValidationExecutionControl,
} from "./validation-evidence.js";
import { assertRepairReadiness } from "./work-repair.js";
import { record } from "./unknown-fields.js";

export type WorkStatus =
  | "pending"
  | "running"
  | "published"
  | "waiting"
  | "done"
  | "skipped"
  | "failed"
  | "cancelled";
export type WorkStep =
  | "execute"
  | "validate"
  | "approve-asset"
  | "approve-result"
  | "deliver";

export interface AcceptancePending {
  criterion: string;
  treeSha: string;
  source?: string;
  quote?: string;
  question: string;
  detail: string;
  reviewFinding?: ResultReviewCandidate;
  /** The other criteria of the same review that also need a human, in criterion order. */
  more?: Omit<AcceptancePending, "more">[];
}

/** Every open question of a review: the pending criterion, then the others it stopped with. */
export function pendingQuestions(
  pending: AcceptancePending,
): Omit<AcceptancePending, "more">[] {
  const { more, ...first } = pending;
  return [first, ...(more ?? [])];
}

export interface WorkState {
  /** Explicit prospective proof selection on the same retained QA attempt. */
  reviewArtifactSelection?: import("./review-artifacts.js").ReviewArtifactSelector[];
  /** Authenticated outcome routing, separate from implementation acceptance. */
  routing?: import("./runner/routing.js").WorkRoutingDisposition;
  /** Immutable selected dispatch packet; operational ownership remains here. */
  adaptiveContextId?: string;
  knowledge?: import("./objective-knowledge.js").ObjectiveKnowledgeRecord;
  recovery?: import("./repair-policy.js").WorkRecovery;
  /** Reservation survives an uncertain effect; item ownership is separate. */
  phaseReservation?: import("./config.js").ResourcePhase;
  requestedPhase?: import("./config.js").ResourcePhase;
  graphRevisionDigest?: string;
  discovery?: import("./contracts.js").WorkDiscovery & { attempt: string };
  discoveryDisposition?: "proposed" | "accepted" | "declined";
  discoveryDecline?: import("./graph-amendments.js").WorkerDiscoveryDecline;
  discoveryOutput?: import("./discovery.js").DiscoveryOutputManifest;
  qaChecks?: NamedCheckEvidence[];
  /** Exact-head successful named checks observed before submitting integration. */
  preIntegrationChecks?: NamedCheckEvidence[];
  status: WorkStatus;
  step?: WorkStep;
  attempt?: string;
  execution?: ExecutionHandle;
  /**
   * Workers of this attempt that stopped without a result. The driver's
   * identity for the current worker is the attempt, then `<attempt>-<n>`.
   */
  worker?: number;
  /** Immutable base supplied to the worker for this attempt. */
  executionBaseSha?: string;
  /** Integrated default-branch head observed when this attempt started. */
  integratedShaAtStart?: string | null;
  /** Mutable validation/delivery base; native replay may advance it. */
  baseSha?: string;
  changeRef?: string;
  /**
   * Strict protection: the PR head GitHub made by updating the branch with
   * its base (update-branch). Its first-parent chain of GitHub merges leads
   * to `changeRef`, the validated result. Unset while the PR head is
   * `changeRef`.
   */
  deliveredHead?: string;
  /**
   * The PR head a GitHub update-branch was requested from. Set before the
   * PUT, cleared once the new head is saved as `deliveredHead`, so a repeat
   * or a restart adopts the update instead of reading GitHub's merge as a
   * foreign change (#576, #620).
   */
  branchUpdateFrom?: string;
  branchUpdateAdmission?: "blocked" | "submitted";
  /**
   * PR heads of this attempt that a later head replaced: GitHub's branch
   * update, or a replay onto a repaired lower native layer. A lease and a
   * lagging read accept them.
   */
  replacedHeads?: string[];
  treeSha?: string;
  validation?: ValidationEvidence;
  /**
   * The worker's own Validate passed on this collected tree with these
   * commands, so a controller failure of it is run once more before it
   * stands (#1595). `failure` is that first failed run, saved before the
   * rerun starts.
   */
  validationRerun?: {
    treeSha: string;
    commands: string[];
    failure?: import("./validation-evidence.js").FirstValidationFailure;
  };
  /** Partial unsuccessful validation, separate from pass-only acceptance evidence. */
  failedValidation?: FailedValidationRecord;
  acceptancePending?: AcceptancePending;
  acceptanceDecisions?: AcceptanceDecision[];
  assets?: CapturedAssetSet[];
  selectedAssetSet?: string;
  selectionDigest?: string;
  selection?: AssetSelectionDecision;
  pullRequest?: number;
  /**
   * The PR whose closing without a merge was put to the operator. Its retry
   * is the answer: delivery then opens a new PR for the same reviewed result.
   */
  closedPullRequest?: number;
  error?: string;
  authentication?: AuthenticationRequest;
  startedAt?: string;
  completedAt?: string;
  integratedSha?: string;
  githubClosure?: "pending" | "complete";
  /** Why the item is not progressing: a step's or the scheduler's structured wait. */
  wait?: Wait;
}

export interface WorkItemTracking {
  issue: number;
  progress?: import("./github-progress-state.js").GitHubProgressProjection;
  projectStatus?: import("./github-project-state.js").GitHubProjectStatusProjection;
  /** The item's live status comment, edited in place while it runs (#1325). */
  live?: import("./github-progress-state.js").LiveStatusRecord;
}

export interface CoordinatorDisposition {
  mode: "running" | "paused" | "draining";
  phase: string;
  phaseStartedAt: string;
  deadlineAt?: string;
  observedAt?: string;
  waitReason?: string;
  cancelError?: string;
  processes?: { pid: number; startTime: string }[];
  /** The operator's mode a rejection hold overrode; its replacement restores it. */
  requestedMode?: "running" | "paused" | "draining";
}

/** Preparation shares the atomic state path; no executable graph is invented. */
export interface PreparationState {
  restoration?: ContinuationRestoration;
  /** Exact immutable definition and resolved arguments retained before planning. */
  workflowRecipePin?: import("./workflow-recipes.js").WorkflowRecipePin;
  /** Observational pointers; absence supplies no historical memory. */
  memoryBindings?: import("./repository-memory.js").RepositoryMemoryBinding[];
  graphProjectionIntents?: Record<
    string,
    import("./graph-projection-control.js").GraphProjectionIntent
  >;
  agentSessions?: Record<string, import("./contracts.js").AgentSessionRef>;
  agentSessionHistory?: import("./contracts.js").AgentSessionRef[];
  githubProjectStatus?: import("./github-project-state.js").GitHubProjectStatusProjection;
  githubProgress?: import("./github-progress-state.js").GitHubProgressProjection;
  /** The Objective's live status comment while it plans; execution keeps the same record. */
  githubLiveStatus?: import("./github-progress-state.js").LiveStatusRecord;
  /** Immutable advisory selection; null is explicit no-input. */
  approvedPlaybookPin: import("./contracts.js").ApprovedPlaybookPin;
  sourcePacketDigest?: string;
  planningRecovery?: import("./compiler.js").PlanningRecoveryRecord;
  /** Limits snapshotted from configuration when the Objective started. */
  autonomy: Autonomy;
  /** Worker ceiling and scheduling resolved when the Objective started. */
  capacity: import("./config.js").Capacity;
  charges?: import("./repair-policy.js").RepairLedger["charges"];
  schemaVersion: 8 | 10 | 12 | 14 | 16 | 18 | 20;
  kind: "preparing";
  repository: string;
  objective: number;
  runId: string;
  configDigest: string;
  baseSha: string;
  objectiveBodyDigest: string;
  coordinator: CoordinatorDisposition;
  /**
   * A run found the Objective body or the sources changed since planning and
   * refused (the base cannot: a preparation keeps the one it recorded). Only
   * a run can see it (status reads no GitHub or checkout); status then names
   * how to end or discard the plan. The next run that finds them as planned
   * clears it. The configuration is not recorded:
   * status compares it live, so restoring it is enough.
   */
  changedSincePlanning?: true;
  /** Present once planning completed; preparation then projects it. */
  plan?: import("./compiler.js").PlanCandidate;
  /** A reviewed split: child Objective issues, their queue admission and parent closure. */
  split?: import("./objective-split.js").ObjectiveSplit;
  /** Issues already projected; projection reconciles the rest by marker. */
  issueByItemId: Record<string, number>;
  /** The login that authored Factory's first issue: its GitHub identity. */
  issueAuthor?: string;
  error?: string;
  cancelRequested?: boolean;
  cancelledAt?: string;
  /** Objective step repeat records (#515). */
  repeats?: Record<string, RepeatRecord>;
  wait?: Wait;
}
export type ContinuationState = FactoryState | PreparationState;

/** Classify already typed continuations; validation remains the load boundary. */
export function isPreparationState(
  state: ContinuationState | null | undefined,
): state is PreparationState {
  return (
    state?.schemaVersion === 8 ||
    state?.schemaVersion === 10 ||
    state?.schemaVersion === 12 ||
    state?.schemaVersion === 14 ||
    state?.schemaVersion === 16 ||
    state?.schemaVersion === 18 ||
    state?.schemaVersion === 20
  );
}

export function isExecutionState(
  state: ContinuationState | null | undefined,
): state is FactoryState {
  return (
    state?.schemaVersion === 7 ||
    state?.schemaVersion === 9 ||
    state?.schemaVersion === 11 ||
    state?.schemaVersion === 13 ||
    state?.schemaVersion === 15 ||
    state?.schemaVersion === 17 ||
    state?.schemaVersion === 19
  );
}

/**
 * Projection may create an issue before recording it, so it has started once
 * an issue is recorded or the phase is entered. A plan cannot be refused then.
 */
export function projectionStarted(
  preparation: Pick<PreparationState, "issueByItemId" | "coordinator"> &
    Partial<Pick<PreparationState, "split">>,
): boolean {
  return (
    Object.keys(preparation.issueByItemId).length > 0 ||
    preparation.coordinator.phase === "projection" ||
    // Child Objective issues may exist once a split starts.
    preparation.split !== undefined
  );
}

/**
 * A rejected amendment holds the coordinator paused: a replacement or
 * `factory cancel` is the only way on, and both need the pause. Every change
 * of mode goes through `setCoordinatorMode`, so a drain, a handoff or a resume
 * cannot release it; submitting the replacement does (the rejection is gone).
 */
export function rejectionHoldsPause(state: ContinuationState): boolean {
  return (
    isExecutionState(state) && state.pendingAmendment?.phase === "rejected"
  );
}

/**
 * The planner's open question about the pending amendment, if it still awaits
 * an answer (#1296). A refused amendment is rejected, and its unanswered
 * question is no longer open.
 */
export function openAmendmentQuestion(
  state: ContinuationState,
): { question: string } | undefined {
  if (!isExecutionState(state)) return undefined;
  const pending = state.pendingAmendment;
  const open = pending?.decisions?.at(-1);
  return pending && pending.phase !== "rejected" && open && !open.answer
    ? open
    : undefined;
}

/** The planner's unanswered question that stopped planning with a retained draft. */
export function openPlanningQuestion(
  state: ContinuationState,
): { question: string } | undefined {
  if (!isPreparationState(state) || state.plan) return undefined;
  const record = state.planningRecovery;
  const open = record?.decisions?.at(-1);
  return record?.phase === "stopped" && open && !open.answer ? open : undefined;
}

/**
 * The questions of a plan whose independent review asked the operator
 * (operator-decision findings). An answer revises the plan's retained draft
 * and the revised plan is reviewed again; it never accepts this plan.
 */
export function openReviewDecision(
  state: ContinuationState,
): { question: string; count: number } | undefined {
  if (!isPreparationState(state) || !state.plan) return undefined;
  const review = state.plan.review;
  if (review.status !== "needs-human" || review.acceptable === false)
    return undefined;
  const questions = [
    ...new Set(
      review.findings.flatMap((finding) =>
        "kind" in finding && finding.kind === "operator-decision"
          ? [finding.question]
          : [],
      ),
    ),
  ];
  return questions.length
    ? { question: questions.join("\n"), count: questions.length }
    : undefined;
}

/**
 * The review's questions when an answer can revise the plan: its draft is
 * retained. Without one (older state) decide refuses the answer, so guidance
 * offers only a refusal.
 */
export function reviewDecisionAnswerable(
  state: ContinuationState,
): { question: string; count: number } | undefined {
  const asked = openReviewDecision(state);
  return asked &&
    isPreparationState(state) &&
    state.planningRecovery?.phase === "stopped" &&
    state.planningRecovery.answer
    ? asked
    : undefined;
}

/**
 * The exact open question an accepted `factory decide --answer` is recorded
 * against, as decide selects it; `--question` names its digest.
 */
export function openAnsweredQuestion(
  state: ContinuationState,
): string | undefined {
  if (isExecutionState(state)) return openAmendmentQuestion(state)?.question;
  if (!isPreparationState(state)) return undefined;
  const review = state.plan?.review;
  return (
    openPlanningQuestion(state)?.question ??
    openReviewDecision(state)?.question ??
    (review?.status === "needs-human" && review.acceptable !== false
      ? (review.failure?.question ?? review.findings[0]?.question)
      : undefined)
  );
}

/** That question's digest, which status and printed commands show; null when none is open. */
export function answeredQuestionDigest(
  state: ContinuationState,
): string | null {
  const open = openAnsweredQuestion(state);
  return open === undefined ? null : questionDigest(open);
}

/** Planning stopped at its revision allowance with only fix findings left: accepting grants more revisions. */
export function planningRevisionGrantable(state: ContinuationState): boolean {
  return (
    isPreparationState(state) &&
    !state.plan &&
    state.planningRecovery?.phase === "stopped" &&
    state.planningRecovery.stoppedFor === "revision-allowance"
  );
}

/**
 * Set the coordinator's mode, unless a rejected amendment holds it paused:
 * then the requested mode is kept for the replacement to restore.
 */
export function setCoordinatorMode(
  state: ContinuationState,
  mode: CoordinatorDisposition["mode"],
): void {
  if (!state.coordinator) return;
  if (rejectionHoldsPause(state)) {
    state.coordinator.mode = "paused";
    state.coordinator.requestedMode = mode;
  } else {
    state.coordinator.mode = mode;
    delete state.coordinator.requestedMode;
  }
}

/** Existing native-stack slot: exact creation request, never an inferred remote identity. */
export interface StackPublication {
  request: { layers: NativeStackLayer[]; baseBranch: string };
  disposition: "intent" | "observed" | "unknown" | "blocked";
  number?: number;
  effectId: string;
  recordedAt: string;
}
export function observedStackNumber(
  value: number | StackPublication | undefined,
): number | undefined {
  return typeof value === "number"
    ? value
    : value?.disposition === "observed"
      ? value.number
      : undefined;
}
export interface FactoryState {
  restoration?: ContinuationRestoration;
  workflowRecipePin?: import("./workflow-recipes.js").WorkflowRecipePin;
  /** Original admission fingerprints survive amendments and discovered children. */
  workflowRecipeAdmission?: import("./workflow-recipes.js").WorkflowRecipeAdmission;
  conditionFacts?: Record<
    string,
    import("./runner/routing.js").WorkConditionSettlement
  >;
  workflowReflection?: import("./workflow-reflection.js").WorkflowReflectionState;
  /** Exact role packets selected before calls; historical absence stays absent. */
  adaptiveContexts?: Record<
    string,
    import("./adaptive-context.js").AdaptiveContextPacket
  >;
  /** Observational pointers; absence supplies no historical memory. */
  memoryBindings?: import("./repository-memory.js").RepositoryMemoryBinding[];
  graphProjectionIntents?: Record<
    string,
    import("./graph-projection-control.js").GraphProjectionIntent
  >;
  /** Frozen original preparation inputs; required for a retained planner. */
  sourcePacketDigest?: string;
  agentSessions?: Record<string, import("./contracts.js").AgentSessionRef>;
  agentSessionHistory?: import("./contracts.js").AgentSessionRef[];
  acceptedPlanningDecision?: import("./planning-decision-context.js").AcceptedPlanningDecision;
  githubProjectStatus?: import("./github-project-state.js").GitHubProjectStatusProjection;
  githubProgress?: import("./github-progress-state.js").GitHubProgressProjection;
  /** The Objective's live status comment, edited in place while it runs (#1325). */
  githubLiveStatus?: import("./github-progress-state.js").LiveStatusRecord;
  /**
   * Each Work Item's presentation on its own issue, by item id: progress comments and the
   * card's Project Status. The issue is recorded, so a later graph revision cannot rebind it.
   */
  workItemTracking?: Record<string, WorkItemTracking>;
  publicationContract: "exact-request-v1";
  /** Retained across WorkState replacement; never reconstructed from diagnostics. */
  publicationIntents?: Record<
    string,
    import("./delivery/publication.js").PublicationIntent[]
  >;
  finalAcceptance?: import("./completion.js").FinalAcceptance;
  planningRecovery?: import("./compiler.js").PlanningRecoveryRecord;
  /** Charged failure events (see repair-policy.ts). */
  charges?: import("./repair-policy.js").RepairLedger["charges"];
  backlogDiscoveries?: import("./graph-amendments.js").AmendmentProposal[];
  /** Start admissions charged before discovery effects; survives replacement WorkState. */
  discoveryAttemptCounts?: Record<string, number>;
  graphRevisions?: import("./graph-amendments.js").GraphRevision[];
  pendingAmendment?: import("./graph-amendments.js").PendingAmendment;
  /** Exact deterministic additions, saved before any GitHub projection. */
  pendingExpansion?: import("./runner/expansion.js").PendingGraphExpansion;
  /** Settled immutable inputs and admitted children; no paid review is fabricated. */
  expansionHistory?: import("./runner/expansion.js").GraphExpansionSettlement[];
  /** Superseded known rejections retain their original proposal and evidence. */
  rejectedAmendments?: import("./graph-amendments.js").PendingAmendment[];
  coordinator?: CoordinatorDisposition;
  /** Limits snapshotted from configuration when the Objective started. */
  autonomy: Autonomy;
  /** Worker ceiling and scheduling resolved when the Objective started. */
  capacity: import("./config.js").Capacity;
  /** Digest of the accepted plan's graph; the root of every graph revision. */
  planGraphDigest: string;
  /** Native predecessor facts the plan was made with; absent when it had none. */
  prerequisitesDigest?: string;
  /** Immutable authenticated admission facts, bound to prerequisitesDigest. */
  prerequisites?: import("./contracts.js").PlanningPrerequisites;
  schemaVersion: 7 | 9 | 11 | 13 | 15 | 17 | 19;
  approvedPlaybookAdmission: import("./contracts.js").ApprovedPlaybookAdmission;
  approvedPlaybookPin: import("./contracts.js").ApprovedPlaybookPin;
  repository: string;
  objective: number;
  runId: string;
  configDigest: string;
  baseSha: string;
  graph: WorkGraph;
  objectiveCommands: string[];
  issueByItemId: Record<string, number>;
  /** The login that authored Factory's issues: its GitHub identity. */
  issueAuthor?: string;
  work: Record<string, WorkState>;
  stackNumbers?: Record<string, number | StackPublication>;
  stackMerges?: Record<
    string,
    {
      topPullRequest: number;
      expectedHeadSha: string;
      uuid?: string;
      request?: {
        layers: NativeStackLayer[];
        baseBranch: string;
        stackNumber: number;
        submittedAt: string;
        disposition: "intent" | "observed" | "blocked";
      };
    }
  >;
  integratedSha?: string;
  /**
   * Heads others pushed on top of `integratedSha` that final validation
   * followed, oldest first; the last is the final candidate. `asked` is a
   * further head awaiting the operator's answer.
   */
  finalHead?: { integratedSha: string; heads: string[]; asked?: string };
  finalValidation?: ValidationEvidence & { passed: boolean; detail?: string };
  finalAcceptancePending?: AcceptancePending;
  finalAcceptanceDecisions?: AcceptanceDecision[];
  objectiveBodyDigest: string;
  objectiveClosure?: "pending" | "complete";
  cancelRequested?: boolean;
  cancelledAt?: string;
  error?: string;
  /** The Work Item whose failure ended the run and set `error`; absent for a defect outside any item. */
  errorItem?: string;
  /** Step repeat records for Work Items and the Objective (#515). */
  repeats?: Record<string, RepeatRecord>;
  wait?: Wait;
}

/** Pin shape is lifecycle-readable; runtime authenticates its retained bodies before use. */
export function assertStateWorkflowRecipe(state: ContinuationState): void {
  const pin = state.workflowRecipePin;
  const preparation = isPreparationState(state);
  const recipeFormat = preparation
    ? state.schemaVersion === 16 ||
      ([18, 20].includes(Number(state.schemaVersion)) && pin !== undefined)
    : state.schemaVersion === 15 ||
      ([17, 19].includes(Number(state.schemaVersion)) && pin !== undefined);
  if (preparation && Object.hasOwn(state, "workflowRecipeAdmission"))
    throw new Error(
      "Original recipe admission receipt belongs only to execution snapshots",
    );
  const admission = preparation ? undefined : state.workflowRecipeAdmission;
  if (pin === undefined) {
    if (
      recipeFormat ||
      admission !== undefined ||
      (preparation &&
        (state.plan?.schemaVersion === 7 ||
          state.plan?.workflowRecipe !== undefined))
    )
      throw new Error("Recipe snapshot lacks its original pinned admission");
    return;
  }
  if (!recipeFormat)
    throw new Error(
      "Pinned recipe requires preparation16 or execution15 snapshot semantics",
    );
  assertWorkflowRecipePin(pin);
  if (pin.origin.kind === "repository" && pin.origin.baseSha !== state.baseSha)
    throw new Error(
      "Pinned repository recipe differs from its original admission base",
    );
  if (
    typeof state.sourcePacketDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(state.sourcePacketDigest)
  )
    throw new Error("Pinned recipe lacks its immutable source packet binding");
  if (preparation) {
    if (
      state.plan &&
      (state.plan.schemaVersion !== 7 ||
        JSON.stringify(state.plan.workflowRecipe?.pin) !== JSON.stringify(pin))
    )
      throw new Error("Preparation plan differs from its original recipe pin");
    return;
  }
  if (!admission || !state.planGraphDigest)
    throw new Error("Pinned recipe lacks its original graph admission");
  assertWorkflowRecipeAdmissionBinding(admission, {
    pin,
    baseSha: state.baseSha,
    configDigest: state.configDigest,
    sourcePacketDigest: state.sourcePacketDigest!,
    graphDigest: state.planGraphDigest,
    // These are the retained original review fingerprints, not the current
    // amended graph's review; creation authenticates them against the candidate.
    packetDigest: admission.packetDigest,
    reviewDigest: admission.reviewDigest,
  });
}

/** Validate retained packet identities without requiring advisory bodies for lifecycle reads. */
export function assertStateAdaptiveContexts(state: FactoryState): void {
  if (state.adaptiveContexts === undefined) return;
  const packets = record(state.adaptiveContexts, "adaptiveContexts");
  const graphs = new Set([
    graphDigest(state.graph),
    ...(state.graphRevisions ?? []).map((revision) => revision.digest),
  ]);
  for (const [id, packet] of Object.entries(packets)) {
    assertAdaptiveContextPacket(packet);
    const scope = packet.binding;
    if (
      id !== packet.id ||
      scope.repository !== state.repository ||
      scope.objective !== state.objective ||
      scope.runId !== state.runId ||
      scope.configDigest !== state.configDigest ||
      !graphs.has(scope.graphDigest)
    )
      throw new Error(
        "Retained adaptive context differs from its Objective scope",
      );
    if (scope.itemId !== undefined) {
      const graph =
        graphDigest(state.graph) === scope.graphDigest
          ? state.graph
          : state.graphRevisions?.find(
              (revision) => revision.digest === scope.graphDigest,
            )?.graph;
      if (!graph?.items.some((item) => item.id === scope.itemId))
        throw new Error(
          "Retained adaptive context names an unadmitted Work Item",
        );
    }
  }
}

/** A current or archived worker only consumes the packet frozen for its own attempt. */
export function assertWorkAdaptiveContext(
  state: FactoryState,
  id: string,
  work: WorkState,
): void {
  if (work.adaptiveContextId === undefined) return;
  const packet = state.adaptiveContexts?.[work.adaptiveContextId];
  if (
    !packet ||
    packet.role !== "dispatch" ||
    packet.binding.itemId !== id ||
    packet.binding.attemptId !== work.attempt ||
    packet.binding.baseSha !== (work.executionBaseSha ?? work.baseSha) ||
    (work.graphRevisionDigest !== undefined &&
      packet.binding.graphDigest !== work.graphRevisionDigest)
  )
    throw new Error(
      `Work Item ${id} selected adaptive context differs from its admitted attempt`,
    );
}

/** Discovery completion is authenticated observation, separate from QA and delivery. */
export function assertWorkDiscoveryOutput(
  state: FactoryState,
  id: string,
  work: WorkState,
): void {
  assertWorkerDiscoveryDisposition(state, id, work);
  const attemptGraph =
    work.graphRevisionDigest === undefined
      ? state.graph
      : (state.graphRevisions?.find(
          (revision) => revision.digest === work.graphRevisionDigest,
        )?.graph ?? state.graph);
  const accepted = attemptGraph.items.find((item) => item.id === id);
  if (!accepted)
    throw new Error(`Work Item ${id} has no admitted discovery definition`);
  if (work.discoveryOutput !== undefined) {
    if (accepted.kind !== "discovery" || !accepted.discovery)
      throw new Error(`Work Item ${id} has an undeclared discovery output`);
    assertDiscoveryOutputManifest(work.discoveryOutput);
    const output = work.discoveryOutput;
    if (
      output.producer.objective !== state.objective ||
      output.producer.runId !== state.runId ||
      output.producer.itemId !== id ||
      output.producer.attemptId !== work.attempt ||
      output.source.commitSha !== work.baseSha ||
      output.role !== accepted.discovery.role ||
      output.schema !== accepted.discovery.schema ||
      output.specificationDigest !==
        discoverySpecificationDigest(accepted.discovery) ||
      JSON.stringify(output.source.selectors) !==
        JSON.stringify(accepted.discovery.selectors)
    )
      throw new Error(
        `Work Item ${id} discovery output differs from its admitted attempt`,
      );
  }
  if (accepted.kind === "discovery") {
    if (
      work.pullRequest !== undefined ||
      work.changeRef !== undefined ||
      work.treeSha !== undefined ||
      work.integratedSha !== undefined ||
      work.validation !== undefined ||
      work.assets !== undefined ||
      work.selectedAssetSet !== undefined ||
      work.selection !== undefined ||
      accepted.ownedPaths.length ||
      accepted.validation.length ||
      accepted.sourceAssets?.length ||
      accepted.minimumAssetSets ||
      accepted.expectedOutputRoles?.length ||
      accepted.requiredLfsRoles?.length
    )
      throw new Error(
        `Discovery Work Item ${id} cannot contain delivery, QA or asset evidence`,
      );
    if (
      work.status === "done" &&
      (work.execution !== undefined ||
        work.discoveryOutput === undefined ||
        (
          work.discoveryOutput as import("./discovery.js").DiscoveryOutputManifest
        ).status !== "complete" ||
        (accepted.discovery?.mode === "semantic" &&
          (
            work.discoveryOutput as import("./discovery.js").DiscoveryOutputManifest
          ).disposition !== "advisory"))
    )
      throw new Error(
        `Discovery Work Item ${id} lacks settled complete output`,
      );
  }
}

export function assertCoordinator(value: unknown): void {
  if (value === undefined) return;
  const entry = record(value, "coordinator");
  if (
    !["running", "paused", "draining"].includes(String(entry.mode)) ||
    typeof entry.phase !== "string" ||
    !Number.isFinite(Date.parse(String(entry.phaseStartedAt)))
  )
    throw new Error("Invalid coordinator disposition");
  for (const key of ["deadlineAt", "observedAt"])
    if (
      entry[key] !== undefined &&
      !Number.isFinite(Date.parse(String(entry[key])))
    )
      throw new Error(`Invalid coordinator ${key}`);
  if (
    entry.processes !== undefined &&
    (!Array.isArray(entry.processes) ||
      entry.processes.some(
        (process) =>
          !process ||
          !Number.isSafeInteger(process.pid) ||
          process.pid <= 0 ||
          typeof process.startTime !== "string",
      ))
  )
    throw new Error("Invalid coordinator process identities");
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value)
    throw new Error(`${label} must be a nonempty string`);
  return value;
}

function sha(value: unknown, label: string, length = 40): string {
  const text = string(value, label);
  if (!new RegExp(`^[0-9a-f]{${length}}$`).test(text))
    throw new Error(
      `${label} must be a SHA-${length === 40 ? "1" : "256"} hex digest`,
    );
  return text;
}

function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every((part) => typeof part === "string"))
    throw new Error(`${label} must be a string array`);
  return value;
}

function jsonSafe(
  value: unknown,
  label: string,
  seen = new Set<unknown>(),
): void {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${label} must be JSON-safe`);
    return;
  }
  if (typeof value !== "object" || seen.has(value))
    throw new Error(`${label} must be JSON-safe`);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      for (const [index, entry] of value.entries())
        jsonSafe(entry, `${label}[${index}]`, seen);
      return;
    }
    if (
      (Object.getPrototypeOf(value) !== Object.prototype &&
        Object.getPrototypeOf(value) !== null) ||
      Object.getOwnPropertySymbols(value).length
    )
      throw new Error(`${label} must contain only JSON objects`);
    for (const [key, entry] of Object.entries(value))
      jsonSafe(entry, `${label}.${key}`, seen);
  } finally {
    seen.delete(value);
  }
}

function acceptanceDecisions(value: unknown, label: string): void {
  if (!Array.isArray(value)) throw new Error(`${label} is invalid`);
  for (const raw of value) {
    const decision = record(raw, label);
    string(decision.criterion, `${label}.criterion`);
    sha(decision.treeSha, `${label}.treeSha`);
    string(decision.actor, `${label}.actor`);
    string(decision.reason, `${label}.reason`);
    if (
      Number.isNaN(Date.parse(string(decision.at, `${label}.at`))) ||
      !["accept", "refuse"].includes(String(decision.outcome))
    )
      throw new Error(`${label} has invalid outcome or time`);
  }
}

function acceptancePending(
  value: unknown,
  label: string,
  nested = false,
): void {
  const pending = record(value, label);
  if (pending.more !== undefined) {
    if (nested || !Array.isArray(pending.more))
      throw new Error(`${label}.more is invalid`);
    for (const [index, other] of pending.more.entries())
      acceptancePending(other, `${label}.more[${index}]`, true);
  }
  for (const key of ["criterion", "question", "detail"])
    string(pending[key], `${label}.${key}`);
  for (const key of ["source", "quote"])
    if (pending[key] !== undefined) string(pending[key], `${label}.${key}`);
  sha(pending.treeSha, `${label}.treeSha`);
  if (pending.reviewFinding !== undefined) {
    const finding = record(pending.reviewFinding, `${label}.reviewFinding`);
    for (const key of [
      "criterion",
      "verdict",
      "source",
      "quote",
      "detail",
      "question",
    ]) {
      if (typeof finding[key] !== "string" || finding[key].length > 4_096)
        throw new Error(`${label}.reviewFinding.${key} is invalid`);
    }
  }
}

/** A failed first run of exactly this tree (#1595). */
function firstValidationFailure(
  value: unknown,
  treeSha: string,
  label: string,
): void {
  const failure = record(value, label);
  string(failure.detail, `${label}.detail`);
  if (failure.evidence === undefined) return;
  assertFailedValidationEvidence(failure.evidence);
  if (failure.evidence.treeSha !== treeSha)
    throw new Error(`${label} is not bound to its tree`);
}

function validationEvidence(value: unknown, label: string): string[] {
  const evidence = record(value, label);
  const treeSha = sha(evidence.treeSha, `${label}.treeSha`);
  if (evidence.flakyRerun !== undefined)
    firstValidationFailure(evidence.flakyRerun, treeSha, `${label}.flakyRerun`);
  assertRetainedReviewEvidence(evidence as unknown as ValidationEvidence);
  assertSelectedLfsValidation(evidence.selectedLfs, treeSha);
  assertValidationWorktreeObservation(
    evidence.worktreeObservation,
    treeSha,
    evidence.selectedLfs as
      | import("./validation.js").SelectedLfsValidation[]
      | undefined,
  );
  if (evidence.preparation !== undefined) {
    if (!Array.isArray(evidence.preparation))
      throw new Error(`${label}.preparation must be an array`);
    if (
      evidence.preparation.length &&
      evidence.worktreeObservation === undefined
    )
      throw new Error(
        `${label}.preparation lacks its actual fresh-checkout observation`,
      );
    validationEvidence(
      { treeSha, commands: evidence.preparation },
      `${label}.preparation`,
    );
  }
  if (!Array.isArray(evidence.commands))
    throw new Error(`${label}.commands must be an array`);
  for (const [index, raw] of evidence.commands.entries()) {
    const receipt = record(raw, `${label}.commands[${index}]`);
    assertValidationExecutionControl(receipt.executionControl);
    string(receipt.command, `${label}.commands[${index}].command`);
    if (
      receipt.index !== index ||
      receipt.passed !== true ||
      receipt.exitCode !== 0 ||
      sha(receipt.treeSha, `${label}.commands[${index}].treeSha`) !== treeSha ||
      !validStoppedLeftovers(receipt.stoppedLeftovers)
    )
      throw new Error(
        `${label}.commands[${index}] is not bound to the exact tree and order`,
      );
  }
  assertReviewArtifacts(
    evidence.reviewArtifacts,
    treeSha,
    evidence.commands as unknown as import("./contracts.js").ValidationCommandReceipt[],
  );
  return evidence.commands.map(
    (raw) => (raw as Record<string, unknown>).command as string,
  );
}

const statuses = new Set<WorkStatus>([
  "pending",
  "running",
  "published",
  "waiting",
  "done",
  "skipped",
  "failed",
  "cancelled",
]);
const steps = new Set<WorkStep>([
  "execute",
  "validate",
  "approve-asset",
  "approve-result",
  "deliver",
]);

/** Validate persisted state before it can control processes, Git, or GitHub. */
export function parseFactoryState(
  value: unknown,
  repository: string,
  objective: number,
): FactoryState {
  const state = record(value, "state");
  assertCoordinator(state.coordinator);
  assertContinuationRestoration(state as unknown as ContinuationState);
  if (
    (state.schemaVersion !== 7 &&
      state.schemaVersion !== 9 &&
      state.schemaVersion !== 11 &&
      state.schemaVersion !== 13 &&
      state.schemaVersion !== 15 &&
      ![17, 19].includes(Number(state.schemaVersion))) ||
    state.repository !== repository ||
    state.objective !== objective
  )
    throw new Error(
      "schema version, repository, or Objective identity differs from the installation",
    );
  string(state.runId, "runId");
  if (state.memoryBindings !== undefined)
    assertRepositoryMemoryBindings(state.memoryBindings);
  const lookup = (state.planningRecovery as FactoryState["planningRecovery"])
    ?.contextLookup;
  if (lookup !== undefined) {
    if (
      state.schemaVersion !== 9 &&
      state.schemaVersion !== 11 &&
      state.schemaVersion !== 13 &&
      state.schemaVersion !== 15 &&
      ![17, 19].includes(Number(state.schemaVersion))
    )
      throw new Error("Adaptive context requires execution schema version 9");
    assertPlanningLookupRecord(lookup);
  }
  assertGitHubProgressProjection(state.githubProgress, {
    repository,
    objective,
    runId: state.runId as string,
    configDigest: state.configDigest as string,
  });
  assertGitHubProjectStatusProjection(state.githubProjectStatus, {
    repository,
    objective,
    runId: state.runId as string,
    configDigest: state.configDigest as string,
  });
  if (state.workItemTracking !== undefined) {
    const tracking = state.workItemTracking;
    if (!tracking || typeof tracking !== "object" || Array.isArray(tracking))
      throw new Error("Invalid workItemTracking");
    for (const [id, raw] of Object.entries(tracking)) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw))
        throw new Error("Invalid Work Item tracking");
      const entry = raw as Record<string, unknown>;
      if (
        Object.keys(entry).some(
          (key) =>
            !["issue", "progress", "projectStatus", "live"].includes(key),
        ) ||
        !Number.isSafeInteger(entry.issue) ||
        (entry.issue as number) <= 0
      )
        throw new Error("Invalid Work Item tracking");
      const context = {
        repository,
        objective,
        runId: state.runId as string,
        configDigest: state.configDigest as string,
      };
      const issue = entry.issue as number;
      assertGitHubProgressProjection(entry.progress, {
        ...context,
        item: { id, issue },
      });
      assertGitHubProjectStatusProjection(entry.projectStatus, {
        ...context,
        issue,
      });
      assertLiveStatusRecord(entry.live);
    }
  }
  assertLiveStatusRecord(state.githubLiveStatus);
  assertPublicationIntents(state as unknown as FactoryState);
  sha(state.configDigest, "configDigest", 64);
  if (state.sourcePacketDigest !== undefined)
    sha(state.sourcePacketDigest, "sourcePacketDigest", 64);
  assertApprovedPlaybookPin(state.approvedPlaybookPin);
  sha(state.planGraphDigest, "planGraphDigest", 64);
  assertStateWorkflowRecipe(state as unknown as FactoryState);
  assertAcceptedPlanningDecision(
    state.acceptedPlanningDecision,
    state.planGraphDigest as string,
  );
  assertApprovedPlaybookAdmission(
    state.approvedPlaybookPin,
    state.approvedPlaybookAdmission,
    state.configDigest,
    state.planGraphDigest,
  );
  validateCapacity(state.capacity as Capacity);
  if (state.prerequisitesDigest !== undefined)
    sha(state.prerequisitesDigest, "prerequisitesDigest", 64);
  sha(state.baseSha, "baseSha");
  assertNativePrerequisites(state as unknown as FactoryState);
  const graph = record(state.graph, "graph");
  if (
    graph.objective !== objective ||
    graph.baseSha !== state.baseSha ||
    !Array.isArray(graph.items) ||
    !graph.items.length
  )
    throw new Error("graph identity or items are invalid");
  assertPreIntegrationCheckShape(graph as unknown as WorkGraph);
  assertCoverageShape(graph as unknown as WorkGraph);
  assertGraphRevisions(state as unknown as FactoryState);
  assertStateAdaptiveContexts(state as unknown as FactoryState);
  for (const retainedGraph of [
    graph as unknown as WorkGraph,
    ...((state.graphRevisions as FactoryState["graphRevisions"]) ?? []).map(
      (revision) => revision.graph,
    ),
  ]) {
    for (const item of retainedGraph.items)
      assertWorkItemScheduling(item.scheduling);
    for (const expansion of retainedGraph.expansions ?? [])
      assertWorkItemScheduling(expansion.template.scheduling);
  }
  assertGraphProjectionIntents(state as unknown as FactoryState);
  assertExpansionState(state as unknown as FactoryState);
  assertAgentSessions(state as unknown as FactoryState);
  assertWorkRoutingState(state as unknown as FactoryState);
  if (
    state.workflowReflection !== undefined &&
    state.schemaVersion !== 13 &&
    state.schemaVersion !== 15 &&
    ![17, 19].includes(Number(state.schemaVersion))
  )
    throw new Error(
      "Workflow reflection requires execution snapshot version 13",
    );
  assertWorkflowReflection(state as unknown as FactoryState);
  assertRepairLedger(state as unknown as FactoryState);
  const ids = new Set<string>();
  for (const [index, raw] of graph.items.entries()) {
    const item = record(raw, `graph.items[${index}]`);
    const id = string(item.id, "Work Item ID");
    if (item.kind === "discovery") {
      if (
        state.schemaVersion !== 9 &&
        state.schemaVersion !== 11 &&
        state.schemaVersion !== 13 &&
        state.schemaVersion !== 15 &&
        ![17, 19].includes(Number(state.schemaVersion))
      )
        throw new Error("Discovery requires execution schema version 9");
      assertDiscoverySpecification(item.discovery);
    } else if (item.discovery !== undefined) {
      throw new Error(
        `Work Item ${id} has discovery specification without discovery kind`,
      );
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id) || ids.has(id))
      throw new Error(`invalid or duplicate Work Item ID ${id}`);
    if (
      item.executionProfile !== undefined ||
      item.executionBinding !== undefined
    ) {
      const profile = record(item.executionProfile, `${id}.executionProfile`);
      const binding = record(item.executionBinding, `${id}.executionBinding`);
      string(profile.id, `${id}.executionProfile.id`);
      string(profile.reason, `${id}.executionProfile.reason`);
      string(binding.adapter, `${id}.executionBinding.adapter`);
      sha(binding.digest, `${id}.executionBinding.digest`, 64);
      if (profile.id !== binding.id)
        throw new Error(
          `Work Item ${id} profile identity differs from binding`,
        );
      for (const key of ["model", "reasoningEffort"])
        if (binding[key] !== undefined)
          string(binding[key], `${id}.executionBinding.${key}`);
    }
    if (item.priority !== undefined && !Number.isSafeInteger(item.priority))
      throw new Error(`Work Item ${id} has invalid priority`);
    ids.add(id);
    for (const key of ["title", "goal", "brief"])
      string(item[key], `${id}.${key}`);
    for (const key of [
      "acceptance",
      "nonGoals",
      "dependencies",
      "ownedPaths",
      "resources",
      "expectedOutputRoles",
      "requiredLfsRoles",
    ])
      strings(item[key], `${id}.${key}`);
    if (
      !Array.isArray(item.sourceAssets) ||
      !item.sourceAssets.every((raw: unknown) => {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
        const binding = raw as Record<string, unknown>;
        return (
          typeof binding.path === "string" &&
          !!binding.path &&
          typeof binding.role === "string" &&
          !!binding.role &&
          typeof binding.mediaType === "string" &&
          !!binding.mediaType &&
          (binding.kind === undefined ||
            ["repository", "local", "github-attachment"].includes(
              String(binding.kind),
            )) &&
          ["private", "repository"].includes(String(binding.visibility))
        );
      })
    )
      throw new Error(`${id}.sourceAssets are invalid`);
    if (
      !Number.isSafeInteger(item.minimumAssetSets) ||
      Number(item.minimumAssetSets) < 0
    )
      throw new Error(`${id}.minimumAssetSets is invalid`);
    if (
      !Array.isArray(item.citations) ||
      !item.citations.every((citation) => typeof citation?.path === "string")
    )
      throw new Error(`${id}.citations are invalid`);
    if (
      !Array.isArray(item.validation) ||
      !item.validation.every(
        (check) =>
          typeof check?.command === "string" &&
          ["base-observed", "source-declared"].includes(check.provenance),
      )
    )
      throw new Error(`${id}.validation is invalid`);
  }
  if (state.discoveryAttemptCounts !== undefined) {
    if (
      state.schemaVersion !== 9 &&
      state.schemaVersion !== 11 &&
      state.schemaVersion !== 13 &&
      state.schemaVersion !== 15 &&
      ![17, 19].includes(Number(state.schemaVersion))
    )
      throw new Error(
        "Discovery start admissions require execution schema version 9",
      );
    const counts = record(
      state.discoveryAttemptCounts,
      "discoveryAttemptCounts",
    );
    const revisions =
      (state.graphRevisions as FactoryState["graphRevisions"]) ?? [];
    for (const [id, count] of Object.entries(counts)) {
      // Accepted revisions retain historical identities; counters are never dropped
      // merely because a graph no longer selects their discovery item.
      const admitted =
        (graph.items as WorkGraph["items"]).find(
          (item) => item.id === id && item.kind === "discovery",
        ) ??
        [...revisions]
          .reverse()
          .flatMap((revision) => revision.graph.items)
          .find((item) => item.id === id && item.kind === "discovery");
      if (!admitted?.discovery)
        throw new Error(
          `Discovery start admissions name an unadmitted item ${id}`,
        );
      assertDiscoverySpecification(admitted.discovery);
      if (
        !Number.isSafeInteger(count) ||
        Number(count) < 0 ||
        Number(count) > admitted.discovery.allowance.maxAttempts
      )
        throw new Error(
          `Discovery start admissions exceed the recorded allowance for ${id}`,
        );
    }
  }
  if (
    state.schemaVersion === 9 &&
    lookup === undefined &&
    !(graph.items as Record<string, unknown>[]).some(
      (item) => item.kind === "discovery",
    )
  )
    throw new Error(
      "Adaptive execution lacks its retained context or discovery semantics",
    );
  const checkpointState = state as unknown as FactoryState;
  if (
    (state.schemaVersion === 13 ||
      state.schemaVersion === 15 ||
      ([17, 19].includes(Number(state.schemaVersion)) &&
        (state.workflowRecipePin !== undefined ||
          state.conditionFacts !== undefined ||
          state.workflowReflection !== undefined ||
          state.adaptiveContexts !== undefined ||
          state.pendingExpansion !== undefined ||
          state.expansionHistory !== undefined ||
          [
            checkpointState.graph,
            ...(checkpointState.graphRevisions ?? []).map(
              (revision) => revision.graph,
            ),
            ...[
              checkpointState.pendingAmendment,
              ...(checkpointState.rejectedAmendments ?? []),
            ].flatMap((amendment) =>
              amendment
                ? [
                    ...(amendment.graph ? [amendment.graph] : []),
                    ...(amendment.proposal.graph
                      ? [amendment.proposal.graph]
                      : []),
                  ]
                : [],
            ),
          ].some(
            (retained) =>
              retained.conditions?.length ||
              retained.expansions?.length ||
              retained.items.some((item) => item.kind === "discovery"),
          )))) &&
    lookup === undefined
  )
    throw new Error(
      "Execution snapshot version 13 requires its original admitted planning context",
    );
  for (const raw of graph.items) {
    const item = raw as Record<string, unknown>;
    if (
      !(item.dependencies as string[]).every(
        (id) => ids.has(id) && id !== item.id,
      )
    )
      throw new Error(`Work Item ${item.id} has an unknown dependency`);
  }
  const projected = record(state.issueByItemId, "issueByItemId");
  if (state.issueAuthor !== undefined) string(state.issueAuthor, "issueAuthor");
  const work = record(state.work, "work");
  if (new Set(Object.values(projected)).size !== ids.size)
    throw new Error("Projected Work Item Issue identities are not unique");
  if (
    Object.keys(projected).length !== ids.size ||
    Object.keys(work).length !== ids.size
  )
    throw new Error(
      "graph, projected Issues, and work state have different keys",
    );
  for (const id of ids) {
    assertObjectiveKnowledge(state as unknown as FactoryState, id);
    assertWorkAdaptiveContext(
      state as unknown as FactoryState,
      id,
      work[id] as WorkState,
    );
    if (!Number.isSafeInteger(projected[id]) || Number(projected[id]) <= 0)
      throw new Error(`Work Item ${id} has no projected Issue identity`);
    const item = record(work[id], `work.${id}`);
    if (item.reviewArtifactSelection !== undefined) {
      const planned = (graph.items as WorkGraph["items"]).find(
        (entry) => entry.id === id,
      )!;
      if (planned.kind !== "qa" && planned.kind !== "aggregate")
        throw new Error(
          "Prospective review evidence requires a read-only QA item",
        );
      assertReviewArtifactSelection(
        item.reviewArtifactSelection,
        planned.validation.map((check) => check.command),
      );
    }
    // Records Factory no longer keeps; an in-flight effect must not be dropped.
    for (const field of ["pendingEffect", "interruptions", "waitingReason"])
      if (item[field] !== undefined)
        throw new Error(
          `Work Item ${id} records ${field}, which Factory no longer keeps; start the Objective fresh`,
        );
    if (!statuses.has(item.status as WorkStatus))
      throw new Error(`Work Item ${id} has an invalid status`);
    for (const field of ["phaseReservation", "requestedPhase"])
      if (
        item[field] !== undefined &&
        !["coding", "validation", "review", "delivery"].includes(
          String(item[field]),
        )
      )
        throw new Error(`Work Item ${id} has an invalid resource phase`);
    if (item.step !== undefined && !steps.has(item.step as WorkStep))
      throw new Error(`Work Item ${id} has an invalid step`);
    if (
      item.worker !== undefined &&
      (!Number.isSafeInteger(item.worker) || Number(item.worker) < 1)
    )
      throw new Error(`Work Item ${id} has an invalid worker count`);
    if (item.authentication !== undefined) {
      const authentication = record(
        item.authentication,
        `work.${id}.authentication`,
      );
      string(authentication.provider, `${id}.authentication.provider`);
      string(authentication.command, `${id}.authentication.command`);
      if (item.status !== "failed")
        throw new Error(
          `Work Item ${id} authentication request requires failed status`,
        );
    }
    for (const key of [
      "baseSha",
      "executionBaseSha",
      "treeSha",
      "changeRef",
      "deliveredHead",
      "branchUpdateFrom",
    ])
      if (item[key] !== undefined) sha(item[key], `${id}.${key}`);
    if (item.replacedHeads !== undefined) {
      if (!Array.isArray(item.replacedHeads))
        throw new Error(`Work Item ${id} replacedHeads must be an array`);
      for (const [index, head] of item.replacedHeads.entries())
        sha(head, `${id}.replacedHeads[${index}]`);
    }
    if (item.deliveredHead !== undefined && !item.pullRequest)
      throw new Error(`Work Item ${id} delivered head lacks a pull request`);
    if (
      item.integratedShaAtStart !== undefined &&
      item.integratedShaAtStart !== null
    )
      sha(item.integratedShaAtStart, `${id}.integratedShaAtStart`);
    if (item.integratedSha !== undefined)
      sha(item.integratedSha, `${id}.integratedSha`);
    if (
      item.closedPullRequest !== undefined &&
      !Number.isSafeInteger(item.closedPullRequest)
    )
      throw new Error(`Work Item ${id} closedPullRequest must be an integer`);
    if (
      item.branchUpdateAdmission !== undefined &&
      (![17, 19].includes(Number(state.schemaVersion)) ||
        item.branchUpdateFrom === undefined ||
        !["blocked", "submitted"].includes(String(item.branchUpdateAdmission)))
    )
      throw new Error("Invalid checkpointed branch update admission");
    if (item.branchUpdateFrom !== undefined && !item.pullRequest)
      throw new Error(`Work Item ${id} branch update lacks a pull request`);
    if (
      item.startedAt !== undefined &&
      Number.isNaN(Date.parse(string(item.startedAt, `${id}.startedAt`)))
    )
      throw new Error(`Work Item ${id} has an invalid startedAt`);
    if (item.status === "running" && (!item.step || !item.baseSha))
      throw new Error(`Running Work Item ${id} lacks step or base`);
    if (
      item.status === "waiting" &&
      (item.step !== "approve-asset" ||
        !Array.isArray(item.assets) ||
        !item.assets.length ||
        item.selectedAssetSet) &&
      (item.step !== "approve-result" || !item.acceptancePending)
    )
      throw new Error(`Waiting Work Item ${id} lacks candidate assets`);
    if (item.acceptancePending !== undefined)
      acceptancePending(item.acceptancePending, `${id}.acceptancePending`);
    if (item.acceptanceDecisions !== undefined)
      acceptanceDecisions(
        item.acceptanceDecisions,
        `${id}.acceptanceDecisions`,
      );
    if (item.validationRerun !== undefined) {
      const rerun = record(item.validationRerun, `${id}.validationRerun`);
      const treeSha = sha(rerun.treeSha, `${id}.validationRerun.treeSha`);
      if (!strings(rerun.commands, `${id}.validationRerun.commands`).length)
        throw new Error(`Work Item ${id} validationRerun lacks its commands`);
      if (rerun.failure !== undefined)
        firstValidationFailure(
          rerun.failure,
          treeSha,
          `${id}.validationRerun.failure`,
        );
    }
    if (item.validation !== undefined) {
      if (record(item.validation, `${id}.validation`).preparation !== undefined)
        throw new Error(
          `Work Item ${id} requires its full ordered command map, not separate preparation receipts`,
        );
      const receiptCommands = validationEvidence(
        item.validation,
        `${id}.validation`,
      );
      const declaredCommands = (
        (graph.items as Record<string, unknown>[]).find(
          (candidate) => candidate.id === id,
        )!.validation as { command: string }[]
      ).map((check) => check.command);
      if (JSON.stringify(receiptCommands) !== JSON.stringify(declaredCommands))
        throw new Error(
          `Work Item ${id} validation receipts differ from declared commands`,
        );
      if ((item.validation as { treeSha: string }).treeSha !== item.treeSha)
        throw new Error(
          `Work Item ${id} validation tree differs from result tree`,
        );
    }
    if (
      item.status === "published" &&
      (!Number.isSafeInteger(item.pullRequest) || !item.changeRef)
    )
      throw new Error(`Published Work Item ${id} lacks PR or change identity`);
    for (const field of ["qaChecks", "preIntegrationChecks"] as const) {
      if (item[field] === undefined) continue;
      if (!Array.isArray(item[field]))
        throw new Error(`${id}.${field} is invalid`);
      const names = new Set<string>();
      for (const raw of item[field] as unknown[]) {
        const check = record(raw, `${id}.${field}`);
        if (
          !Number.isSafeInteger(check.id) ||
          Number(check.id) <= 0 ||
          check.status !== "completed" ||
          check.conclusion !== "success" ||
          (field === "preIntegrationChecks" &&
            (check.headSha !== item.changeRef || names.has(String(check.name))))
        )
          throw new Error(`${id}.${field} lacks successful result identity`);
        sha(check.headSha, `${id}.${field}.headSha`);
        string(check.name, `${id}.${field}.name`);
        string(check.detailsUrl, `${id}.${field}.detailsUrl`);
        names.add(check.name as string);
      }
    }
    const accepted = (graph.items as WorkGraph["items"]).find(
      (candidate) => candidate.id === id,
    )!;
    assertWorkDiscoveryOutput(
      state as unknown as FactoryState,
      id,
      item as unknown as WorkState,
    );
    const controllerState = state as unknown as FactoryState;
    const currentWork = item as unknown as WorkState;
    const failure = currentWork.recovery?.failure;
    // Repair keeps the original failure beside the new attempt, while its
    // capture belongs to the archived work. Validate that pair below.
    const archivedFailure = currentWork.recovery?.history?.some(
      (prior) =>
        prior.work.attempt !== currentWork.attempt &&
        prior.failure?.digest === failure?.digest &&
        prior.failure?.event === failure?.event &&
        prior.failure?.validationCaptureDigest ===
          failure?.validationCaptureDigest &&
        JSON.stringify(prior.failure?.semanticRefusal) ===
          JSON.stringify(failure?.semanticRefusal),
    );
    assertFailedValidationRecord(
      currentWork.failedValidation,
      controllerState,
      id,
      currentWork,
      archivedFailure && currentWork.failedValidation === undefined
        ? undefined
        : failure,
    );
    if (!archivedFailure)
      assertSemanticRefusalRecord(controllerState, id, currentWork, failure);
    for (const prior of currentWork.recovery?.history ?? []) {
      assertWorkAdaptiveContext(controllerState, id, prior.work);
      assertWorkDiscoveryOutput(controllerState, id, prior.work);
      assertObjectiveKnowledge(
        state as unknown as FactoryState,
        id,
        prior.work,
      );
      assertSemanticRefusalRecord(
        controllerState,
        id,
        prior.work,
        prior.failure,
      );
      assertFailedValidationRecord(
        prior.work.failedValidation,
        controllerState,
        id,
        prior.work,
        prior.failure,
      );
      if (prior.correction?.readiness)
        assertRepairReadiness(
          controllerState,
          id,
          prior.work,
          prior.correction,
          prior.failure,
        );
    }
    const correction = currentWork.recovery?.correction;
    if (correction?.readiness) {
      const retained = currentWork.recovery?.history?.filter(
        (prior) => prior.failure?.event === correction.event,
      );
      if (retained && retained.length > 1)
        throw new Error(
          "Automatic repair readiness has ambiguous retained attempts",
        );
      const prior = retained?.[0];
      assertRepairReadiness(
        controllerState,
        id,
        prior?.work ?? currentWork,
        correction,
        prior?.failure ?? failure,
      );
    }
    if (
      (accepted.kind === "qa" || accepted.kind === "aggregate") &&
      (item.execution !== undefined ||
        item.pullRequest !== undefined ||
        accepted.ownedPaths.length)
    )
      throw new Error(`Read-only QA ${id} cannot contain a worker or PR`);
    if (
      item.pullRequest !== undefined &&
      (!Number.isSafeInteger(item.pullRequest) || Number(item.pullRequest) <= 0)
    )
      throw new Error(`Work Item ${id} PR identity is invalid`);
    if (
      item.githubClosure !== undefined &&
      (!["done", "skipped"].includes(String(item.status)) ||
        !["pending", "complete"].includes(String(item.githubClosure)))
    )
      throw new Error(`Work Item ${id} GitHub closure is invalid`);
    if (
      item.selectedAssetSet !== undefined &&
      (typeof item.selectedAssetSet !== "string" ||
        !Array.isArray(item.assets) ||
        !item.assets.some(
          (set: { id?: unknown }) => set.id === item.selectedAssetSet,
        ))
    )
      throw new Error(`Work Item ${id} has an invalid asset selection`);
    if (item.selectionDigest !== undefined)
      sha(item.selectionDigest, `${id}.selectionDigest`, 64);
    if (
      item.selectedAssetSet !== undefined &&
      (item.selection === undefined || item.selectionDigest === undefined)
    )
      throw new Error(`Work Item ${id} lacks a selection decision`);
    if (item.selection !== undefined) {
      const decision = record(item.selection, `${id}.selection`);
      string(decision.actor, "Selection actor");
      if (Number.isNaN(Date.parse(string(decision.at, "Selection time"))))
        throw new Error("Selection time is invalid");
      if (decision.reason !== undefined && typeof decision.reason !== "string")
        throw new Error("Selection reason is invalid");
      if (
        decision.surface !== undefined &&
        !["factory-cli", "application"].includes(String(decision.surface))
      )
        throw new Error("Selection surface is invalid");
      if (
        !Array.isArray(decision.downstreamItems) ||
        !decision.downstreamItems.every(
          (name: unknown) => typeof name === "string" && !!name,
        )
      )
        throw new Error("Selection downstream items are invalid");
      if (
        !Array.isArray(decision.destinations) ||
        !decision.destinations.every((raw: unknown) => {
          if (!raw || typeof raw !== "object" || Array.isArray(raw))
            return false;
          const destination = raw as Record<string, unknown>;
          return (
            typeof destination.role === "string" &&
            !!destination.role &&
            typeof destination.path === "string" &&
            !!destination.path &&
            typeof destination.digest === "string" &&
            /^[0-9a-f]{64}$/.test(destination.digest)
          );
        })
      )
        throw new Error("Selection destinations are invalid");
    }
    if (item.assets !== undefined) {
      if (!Array.isArray(item.assets))
        throw new Error(`Work Item ${id} assets are invalid`);
      const acceptedItem = (graph.items as WorkGraph["items"]).find(
        (candidate) => candidate.id === id,
      )!;
      const acceptedSourceBindings = (acceptedItem.sourceAssets ?? []).map(
        (binding) => ({
          kind: binding.kind ?? "repository",
          path: binding.path,
          role: binding.role,
          mediaType: binding.mediaType,
          visibility: binding.visibility,
        }),
      );
      let sharedInputIdentity: string | undefined;
      for (const rawSet of item.assets) {
        const set = record(rawSet, `work.${id}.assetSet`);
        string(set.id, "AssetSet ID");
        const provenance = record(set.provenance, "AssetSet provenance");
        string(provenance.source, "AssetSet source");
        string(provenance.rights, "AssetSet rights");
        if (!["private", "repository"].includes(String(provenance.visibility)))
          throw new Error("AssetSet visibility is invalid");
        strings(provenance.lineage, "AssetSet lineage");
        if (set.inputs !== undefined) {
          if (!Array.isArray(set.inputs))
            throw new Error("AssetSet inputs are invalid");
          for (const rawInput of set.inputs) {
            const input = record(rawInput, "AssetSet input");
            const binding = record(input.binding, "AssetSet source binding");
            string(binding.path, "AssetSet source path");
            string(binding.role, "AssetSet source role");
            string(binding.mediaType, "AssetSet source media type");
            if (
              binding.kind !== undefined &&
              !["repository", "local", "github-attachment"].includes(
                String(binding.kind),
              )
            )
              throw new Error("AssetSet source kind is invalid");
            if (!["private", "repository"].includes(String(binding.visibility)))
              throw new Error("AssetSet source visibility is invalid");
            const ref = record(input.ref, "AssetSet source ref");
            sha(ref.digest, "AssetSet source digest", 64);
            if (
              !Number.isSafeInteger(ref.bytes) ||
              Number(ref.bytes) < 0 ||
              typeof ref.mediaType !== "string"
            )
              throw new Error("AssetSet source reference is invalid");
          }
        }
        const canonicalInputs = (
          (set.inputs ?? []) as NonNullable<CapturedAssetSet["inputs"]>
        ).map((input) => ({
          binding: {
            kind: input.binding.kind ?? "repository",
            path: input.binding.path,
            role: input.binding.role,
            mediaType: input.binding.mediaType,
            visibility: input.binding.visibility,
          },
          ref: {
            digest: input.ref.digest,
            bytes: input.ref.bytes,
            mediaType: input.ref.mediaType,
          },
        }));
        if (
          JSON.stringify(canonicalInputs.map((input) => input.binding)) !==
          JSON.stringify(acceptedSourceBindings)
        )
          throw new Error(
            "AssetSet inputs differ from accepted source bindings",
          );
        const inputIdentity = JSON.stringify(canonicalInputs);
        if (
          sharedInputIdentity !== undefined &&
          sharedInputIdentity !== inputIdentity
        )
          throw new Error("AssetSet inputs differ across candidate sets");
        sharedInputIdentity = inputIdentity;
        if (!Array.isArray(set.members) || !set.members.length)
          throw new Error("AssetSet has no members");
        const memberRoles = new Set<string>();
        const evidence = record(set.evidence, "AssetSet harness evidence");
        string(evidence.harnessIdentity, "AssetSet harness identity");
        sha(evidence.resultDigest, "AssetSet harness result digest", 64);
        if (set.production !== undefined) {
          const production = record(
            set.production,
            "AssetSet production evidence",
          );
          for (const key of ["model", "tool"])
            if (production[key] !== undefined)
              string(production[key], `AssetSet ${key}`);
        }
        for (const rawMember of set.members) {
          const member = record(rawMember, "AssetSet member");
          string(member.role, "AssetSet role");
          memberRoles.add(member.role as string);
          string(member.destination, "AssetSet destination");
          if (member.formatMetadata !== undefined) {
            const format = record(
              member.formatMetadata,
              "AssetSet format metadata",
            );
            string(format.source, "AssetSet format metadata source");
            record(format.values, "AssetSet format metadata values");
          }
          const ref = record(member.ref, "AssetSet content ref");
          sha(ref.digest, "AssetSet content digest", 64);
          if (
            !Number.isSafeInteger(ref.bytes) ||
            Number(ref.bytes) < 0 ||
            typeof ref.mediaType !== "string"
          )
            throw new Error("AssetSet content reference is invalid");
        }
        if (set.relationships !== undefined) {
          if (
            !Array.isArray(set.relationships) ||
            !set.relationships.every((raw: unknown) => {
              if (!raw || typeof raw !== "object" || Array.isArray(raw))
                return false;
              const edge = raw as Record<string, unknown>;
              return (
                typeof edge.from === "string" &&
                !!edge.from &&
                typeof edge.toRole === "string" &&
                memberRoles.has(edge.toRole) &&
                typeof edge.kind === "string" &&
                !!edge.kind
              );
            })
          )
            throw new Error("AssetSet relationships are invalid");
        }
        assertAssetCaptureReceipt(set as unknown as CapturedAssetSet);
      }
    }
    if (item.selectedAssetSet !== undefined) {
      const selected = (item.assets as CapturedAssetSet[]).find(
        (candidate) => candidate.id === item.selectedAssetSet,
      )!;
      if (item.selectionDigest !== assetSelectionDigest(selected))
        throw new Error(
          `Work Item ${id} selection digest differs from its AssetSet`,
        );
      const decision = item.selection as unknown as AssetSelectionDecision;
      if (
        JSON.stringify(decision.destinations) !==
        JSON.stringify(
          selected.members.map((member) => ({
            role: member.role,
            path: member.destination,
            digest: member.ref.digest,
          })),
        )
      )
        throw new Error(
          `Work Item ${id} selection destinations differ from its AssetSet`,
        );
      if (
        decision.downstreamItems.some(
          (name) =>
            !(graph.items as { id: string; dependencies: string[] }[]).some(
              (candidate) =>
                candidate.id === name && candidate.dependencies.includes(id),
            ),
        )
      )
        throw new Error(`Work Item ${id} has an invalid downstream binding`);
    }
    if (item.execution !== undefined) {
      const execution = record(item.execution, `work.${id}.execution`);
      if (
        typeof execution.provider !== "string" ||
        !execution.provider ||
        typeof execution.identity !== "string" ||
        !execution.identity
      )
        throw new Error(`Work Item ${id} execution identity is invalid`);
      if (execution.data !== undefined)
        jsonSafe(execution.data, `work.${id}.execution.data`);
      if (execution.data !== undefined) {
        const active = record(execution.data, `work.${id}.execution.data`);
        if (
          active.rejectedCollection !== undefined &&
          (![17, 19].includes(Number(state.schemaVersion)) ||
            !["local", "openai-agents", "claude-managed-agents"].includes(
              String(execution.provider),
            ) ||
            active.result !== undefined)
        )
          throw new Error("Invalid rejected collection disposition");
        if (
          active.admissionBlockedAt !== undefined &&
          (![17, 19].includes(Number(state.schemaVersion)) ||
            execution.provider !== "local" ||
            active.phase !== "prepared" ||
            Number.isNaN(
              Date.parse(
                string(
                  active.admissionBlockedAt,
                  "Local blocked admission time",
                ),
              ),
            ))
        )
          throw new Error("Invalid local checkpoint admission disposition");
        if (active.checkpointAdmission !== undefined) {
          if (
            ![17, 19].includes(Number(state.schemaVersion)) ||
            !["openai-agents", "claude-managed-agents"].includes(
              String(execution.provider),
            )
          )
            throw new Error(
              "Unsupported managed checkpoint admission metadata",
            );
          const admission = record(
            active.checkpointAdmission,
            "Managed checkpoint admission",
          );
          if (
            Object.keys(admission).sort().join() !==
              "at,boundary,knownNotDispatched,phase" ||
            typeof admission.phase !== "string" ||
            !admission.phase ||
            !["before-effect", "settled", "explicit"].includes(
              String(admission.boundary),
            ) ||
            typeof admission.knownNotDispatched !== "boolean" ||
            admission.knownNotDispatched !==
              (admission.boundary === "before-effect") ||
            Number.isNaN(
              Date.parse(
                string(admission.at, "Managed checkpoint admission time"),
              ),
            )
          )
            throw new Error("Invalid managed checkpoint admission disposition");
        }
      }
      if (execution.provider === "local") {
        const active = record(execution.data, `work.${id}.execution.data`);
        const request = record(active.request, `work.${id}.execution.request`);
        const attemptedItem = record(request.item, `work.${id}.execution.item`);
        if (request.adaptiveContext !== undefined) {
          assertAdaptiveContextPacket(request.adaptiveContext);
          if (
            request.adaptiveContext.id !== item.adaptiveContextId ||
            JSON.stringify(request.adaptiveContext) !==
              JSON.stringify(
                (state.adaptiveContexts as FactoryState["adaptiveContexts"])?.[
                  request.adaptiveContext.id
                ],
              )
          )
            throw new Error(
              `Work Item ${id} active request lost its retained adaptive packet`,
            );
        } else if (item.adaptiveContextId !== undefined) {
          throw new Error(
            `Work Item ${id} active request omits its selected adaptive packet`,
          );
        }
        const acceptedItem = (graph.items as Record<string, unknown>[]).find(
          (candidate) => candidate.id === id,
        )!;
        if (
          JSON.stringify(attemptedItem.executionProfile) !==
            JSON.stringify(acceptedItem.executionProfile) ||
          JSON.stringify(attemptedItem.executionBinding) !==
            JSON.stringify(acceptedItem.executionBinding) ||
          JSON.stringify(active.executionBinding) !==
            JSON.stringify(acceptedItem.executionBinding)
        )
          throw new Error(
            `Work Item ${id} execution profile differs from accepted graph`,
          );
        // Coverage may change in a reviewed amendment while this item's
        // recorded attempt and definition remain unchanged. Authenticate its
        // historical preparation against that attempt's admitted revision.
        const attemptGraph =
          item.graphRevisionDigest === undefined
            ? (graph as unknown as WorkGraph)
            : ((state.graphRevisions as FactoryState["graphRevisions"])?.find(
                (revision) => revision.digest === item.graphRevisionDigest,
              )?.graph ??
              (graphDigest(graph as unknown as WorkGraph) ===
              item.graphRevisionDigest
                ? (graph as unknown as WorkGraph)
                : undefined));
        if (!attemptGraph)
          throw new Error(`Work Item ${id} has no authenticated attempt graph`);
        // Exactly the result dispatch continued from (#1313): the same rule,
        // skipping this attempt's own archive entry (rereview archives it
        // while its execution stays).
        if (
          request.retainedFailedResult !== undefined &&
          JSON.stringify(
            retainedFailedResultFor(
              item.recovery as WorkRecovery | undefined,
              typeof item.attempt === "string" ? item.attempt : undefined,
            ),
          ) !== JSON.stringify(request.retainedFailedResult)
        )
          throw new Error(
            `Work Item ${id} retained failed result differs from its archived repair`,
          );
        const readiness = request.environmentReadiness;
        const expectedIndices = environmentValidationIndices(attemptGraph, id);
        if (readiness !== undefined) {
          const selected = record(readiness, `work.${id}.execution.readiness`);
          if (
            JSON.stringify(selected.validationIndices) !==
              JSON.stringify(expectedIndices) ||
            (selected.reusableValidationIndices !== undefined &&
              JSON.stringify(selected.reusableValidationIndices) !==
                JSON.stringify(
                  reusableEnvironmentValidationIndices(attemptGraph, id),
                )) ||
            selected.acceptedBaseSha !== state.baseSha ||
            JSON.stringify(attemptedItem.validation) !==
              JSON.stringify(acceptedItem.validation)
          )
            throw new Error(
              `Work Item ${id} readiness differs from accepted command authority`,
            );
          const readinessReceipt = record(
            active.environmentReadiness,
            `work.${id}.execution.readinessReceipt`,
          );
          if (
            readinessReceipt.commitSha !== request.baseSha ||
            readinessReceipt.worktree !== active.worktree
          )
            throw new Error(
              `Work Item ${id} readiness has a different checkout scope`,
            );
          const observedReadiness = record(
            readinessReceipt.evidence,
            `${id}.readinessEvidence`,
          );
          if (
            observedReadiness.worktreeObservation === undefined ||
            observedReadiness.preparation !== undefined
          )
            throw new Error(
              `Work Item ${id} readiness lacks its complete same-checkout command observation`,
            );
          const commands = validationEvidence(
            readinessReceipt.evidence,
            `work.${id}.execution.readinessEvidence`,
          );
          const checks = acceptedItem.validation as { command: string }[];
          if (
            JSON.stringify(commands) !==
            JSON.stringify(
              expectedIndices.map((index) => checks[index]!.command),
            )
          )
            throw new Error(
              `Work Item ${id} readiness receipts differ from selected commands`,
            );
        } else if (
          attemptGraph.coverage.some(
            (entry) =>
              entry.itemId === id &&
              (entry.environment.prerequisites?.length ?? 0) > 0,
          )
        ) {
          throw new Error(
            `Work Item ${id} lacks declared fresh-checkout readiness`,
          );
        }
        const prepared = active.phase === "prepared";
        const handle = prepared
          ? undefined
          : record(active.handle, `work.${id}.harness`);
        if (prepared) {
          if (active.handle !== undefined)
            throw new Error(
              "Prepared execution cannot claim a spawned harness",
            );
          const payload = record(
            active.preparedHarnessRequest,
            `work.${id}.preparedHarnessRequest`,
          );
          const preparedItem = record(
            payload.item,
            `work.${id}.preparedHarnessRequest.item`,
          );
          if (
            payload.worktree !== active.worktree ||
            payload.attemptId !== execution.identity ||
            preparedItem.id !== id ||
            JSON.stringify(preparedItem.executionBinding) !==
              JSON.stringify(acceptedItem.executionBinding) ||
            JSON.stringify(preparedItem.executionProfile) !==
              JSON.stringify(acceptedItem.executionProfile)
          )
            throw new Error(
              "Prepared harness request differs from its admitted attempt",
            );
        }
        if (
          typeof active.worktree !== "string" ||
          typeof active.adapterIdentity !== "string" ||
          !active.adapterIdentity ||
          attemptedItem.id !== id ||
          (request.baseSha !== item.baseSha &&
            item.status !== "done" &&
            item.status !== "published") ||
          (!prepared &&
            (typeof handle?.identity !== "string" || !handle.identity))
        )
          throw new Error(`Work Item ${id} active attempt handle is invalid`);
        if (handle?.data !== undefined)
          jsonSafe(handle.data, `work.${id}.harness.data`);
      }
    }
  }
  if (state.integratedSha !== undefined)
    sha(state.integratedSha, "integratedSha");
  if (state.finalHead !== undefined) {
    const followed = record(state.finalHead, "finalHead");
    const keys = Object.keys(followed).sort().join(",");
    if (
      !["heads,integratedSha", "asked,heads,integratedSha"].includes(keys) ||
      !Array.isArray(followed.heads) ||
      !followed.heads.length ||
      new Set(followed.heads).size !== followed.heads.length
    )
      throw new Error("Followed final heads are invalid");
    sha(followed.integratedSha, "finalHead.integratedSha");
    for (const head of followed.heads) sha(head, "finalHead.heads");
    if (followed.asked !== undefined) sha(followed.asked, "finalHead.asked");
  }
  if (state.stackNumbers !== undefined) {
    const numbers = record(state.stackNumbers, "stackNumbers");
    for (const [unit, value] of Object.entries(numbers)) {
      if (!unit) throw new Error("Native stack identity is invalid");
      if (typeof value === "number") {
        if (!Number.isSafeInteger(value) || value <= 0)
          throw new Error("Native stack identity is invalid");
        continue;
      }
      if (![17, 19].includes(Number(state.schemaVersion)))
        throw new Error(
          "Native stack creation requires checkpoint reader capability",
        );
      const publication = record(value, "Native stack publication");
      if (
        Object.keys(publication).some(
          (key) =>
            ![
              "request",
              "disposition",
              "number",
              "effectId",
              "recordedAt",
            ].includes(key),
        ) ||
        !["intent", "observed", "unknown", "blocked"].includes(
          String(publication.disposition),
        ) ||
        typeof publication.effectId !== "string" ||
        !/^[a-f0-9]{64}$/.test(publication.effectId) ||
        (publication.disposition === "observed"
          ? !Number.isSafeInteger(publication.number) ||
            Number(publication.number) < 1
          : publication.number !== undefined) ||
        Number.isNaN(
          Date.parse(
            string(publication.recordedAt, "Native stack publication time"),
          ),
        )
      )
        throw new Error("Native stack creation receipt is invalid");
      const request = record(
        publication.request,
        "Native stack creation request",
      );
      if (
        Object.keys(request).sort().join() !== "baseBranch,layers" ||
        !Array.isArray(request.layers) ||
        !request.layers.length
      )
        throw new Error("Native stack creation request is invalid");
      string(request.baseBranch, "Native stack creation base branch");
      for (const layer of request.layers) {
        const entry = record(layer, "Native stack creation layer");
        if (
          Object.keys(entry).sort().join() !== "branch,headSha,pullRequest" ||
          !Number.isSafeInteger(entry.pullRequest) ||
          Number(entry.pullRequest) < 1
        )
          throw new Error("Native stack creation layer is invalid");
        string(entry.branch, "Native stack creation branch");
        sha(entry.headSha, "Native stack creation layer head");
      }
    }
  }
  if (state.stackMerges !== undefined) {
    const merges = record(state.stackMerges, "stackMerges");
    for (const [unit, raw] of Object.entries(merges)) {
      const merge = record(raw, `stackMerges.${unit}`);
      if (
        !unit ||
        !Number.isSafeInteger(merge.topPullRequest) ||
        Number(merge.topPullRequest) <= 0 ||
        (merge.uuid !== undefined &&
          (typeof merge.uuid !== "string" || !merge.uuid)) ||
        (merge.uuid === undefined && merge.request === undefined)
      )
        throw new Error("Pending native merge identity is invalid");
      sha(merge.expectedHeadSha, "Pending native merge head");
      if (merge.request !== undefined) {
        if (![17, 19].includes(Number(state.schemaVersion)))
          throw new Error(
            "Native merge intent requires checkpoint reader capability",
          );
        const request = record(merge.request, "Pending native merge request");
        if (
          Object.keys(request).sort().join() !==
            "baseBranch,disposition,layers,stackNumber,submittedAt" ||
          !Array.isArray(request.layers) ||
          !request.layers.length ||
          !Number.isSafeInteger(request.stackNumber) ||
          Number(request.stackNumber) < 1 ||
          !["intent", "observed", "blocked"].includes(
            String(request.disposition),
          ) ||
          (merge.uuid === undefined &&
            !["intent", "blocked"].includes(String(request.disposition))) ||
          (merge.uuid !== undefined && request.disposition !== "observed")
        )
          throw new Error("Pending native merge request is invalid");
        string(request.baseBranch, "Native merge base branch");
        if (
          Number.isNaN(
            Date.parse(
              string(request.submittedAt, "Native merge submission time"),
            ),
          )
        )
          throw new Error("Invalid native merge submission time");
        for (const layer of request.layers) {
          const entry = record(layer, "Native merge layer");
          if (
            Object.keys(entry).sort().join() !== "branch,headSha,pullRequest" ||
            !Number.isSafeInteger(entry.pullRequest) ||
            Number(entry.pullRequest) < 1
          )
            throw new Error("Pending native merge layer is invalid");
          string(entry.branch, "Native merge branch");
          sha(entry.headSha, "Native merge layer head");
        }
        const top = request.layers.at(-1) as {
          pullRequest: number;
          headSha: string;
        };
        if (
          top.pullRequest !== merge.topPullRequest ||
          top.headSha !== merge.expectedHeadSha
        )
          throw new Error(
            "Native merge request differs from its exact top layer",
          );
      }
    }
  }
  if (state.finalValidation !== undefined) {
    const final = record(state.finalValidation, "finalValidation");
    const receiptCommands = validationEvidence(final, "finalValidation");
    if (
      !finalReceiptsMatch(
        graph as unknown as WorkGraph,
        strings(state.objectiveCommands, "objectiveCommands"),
        {
          preparation:
            (final.preparation as { command: string }[] | undefined)?.map(
              (entry) => entry.command,
            ) ?? [],
          commands: receiptCommands,
        },
      )
    )
      throw new Error(
        "Final validation receipts differ from the Objective's declared commands and fresh-checkout prerequisites",
      );
    const selections = (graph as unknown as WorkGraph).items.flatMap((item) => {
      const itemWork = (work as Record<string, WorkState>)[item.id];
      const set = itemWork?.assets?.find(
        (candidate) => candidate.id === itemWork.selectedAssetSet,
      );
      return set ? [{ itemId: item.id, set }] : [];
    });
    if (selections.length) {
      assertHydrationReceipt(
        final.hydrationReceipt,
        sha(
          objectiveCandidate(state as unknown as FactoryState)?.commitSha,
          "final candidate",
        ),
        sha(final.treeSha, "finalValidation.treeSha"),
        selections,
      );
    } else if (final.hydrationReceipt !== undefined) {
      throw new Error("Final validation has unexpected hydration evidence");
    }
    if (final.passed !== true)
      throw new Error("Final validation evidence is invalid");
  }
  if (state.finalAcceptancePending !== undefined)
    acceptancePending(state.finalAcceptancePending, "finalAcceptancePending");
  if (state.finalAcceptanceDecisions !== undefined)
    acceptanceDecisions(
      state.finalAcceptanceDecisions,
      "finalAcceptanceDecisions",
    );
  strings(state.objectiveCommands, "objectiveCommands");
  sha(state.objectiveBodyDigest, "objectiveBodyDigest", 64);
  if (
    state.objectiveClosure !== undefined &&
    (state.finalValidation === undefined ||
      !["pending", "complete"].includes(String(state.objectiveClosure)))
  )
    throw new Error("Objective GitHub closure is invalid");
  if (state.error !== undefined && typeof state.error !== "string")
    throw new Error("state.error is invalid");
  if (state.errorItem !== undefined && typeof state.errorItem !== "string")
    throw new Error("state.errorItem is invalid");
  // An item named for a stop that is gone is dropped, not refused.
  if (state.error === undefined) delete state.errorItem;
  assertRepeats(state.repeats, "repeats");
  // Records of items no longer in the graph are dropped, not refused.
  const repeats = state.repeats as Record<string, unknown> | undefined;
  for (const key of Object.keys(repeats ?? {})) {
    const item = parseRepeatKey(key)?.item;
    if (item !== undefined && !ids.has(item)) delete repeats![key];
  }
  assertWait(state.wait, "wait");
  for (const id of ids)
    assertWait((work[id] as { wait?: unknown }).wait, `work.${id}.wait`);
  const validated = value as FactoryState;
  objectiveCandidate(validated);
  const selectedMembers = finalValidationLfsMembers(validated);
  // Item validation may hydrate dependencies or selected sibling pointers already
  // present in its tree, so compare against all selected required-LFS members.
  for (const evidence of [
    ...Object.values(validated.work).map((item) => item.validation),
    validated.finalValidation,
  ]) {
    for (const receipt of evidence?.selectedLfs ?? []) {
      if (
        !selectedMembers.some(
          (member) =>
            member.destination === receipt.destination &&
            member.digest === receipt.digest &&
            member.bytes === receipt.bytes,
        )
      )
        throw new Error(
          "Selected LFS validation evidence does not match a selected member",
        );
    }
  }
  if (validated.finalValidation?.passed) assertCompletedCoverage(validated);
  // Portable metadata decoding precedes verified content hydration.
  assertFinalAcceptance(validated, { verifyAccountingBodies: false });
  return validated;
}

/** Verified installation provenance, never replacement execution authority. */
export interface ContinuationRestoration {
  schemaVersion: 1;
  checkpoint: { commitSha: string; payloadDigest: string };
  archive: ContentRef;
  original: {
    snapshot: ContentRef;
    configDigest: string;
    schemaVersion: number;
  };
  source: {
    authorityDigest: string;
    configDigest: string;
    checkout: string;
    stateRoot: string;
  };
  installation: {
    identity: string;
    configDigest: string;
    authorityDigest: string;
    checkout: string;
    stateRoot: string;
  };
  status: "held" | "reconciled";
  reason: string;
}
export function assertContinuationRestoration(state: ContinuationState): void {
  const value = state.restoration;
  if (!value) {
    if (state.schemaVersion === 19 || state.schemaVersion === 20)
      throw new Error(
        "Restored continuation requires its original checkpoint provenance",
      );
    return;
  }
  if (state.schemaVersion !== 19 && state.schemaVersion !== 20)
    throw new Error("Restoration requires execution19 or preparation20");
  const exact = (value: unknown, keys: string[]): Record<string, unknown> => {
    const object = record(value, "restoration");
    if (Object.keys(object).some((key) => !keys.includes(key)))
      throw new Error("Unknown restoration provenance field");
    return object;
  };
  exact(value, [
    "schemaVersion",
    "checkpoint",
    "archive",
    "original",
    "source",
    "installation",
    "status",
    "reason",
  ]);
  const hash = (value: unknown, label: string) => sha(value, label, 64);
  const archive = exact(value.archive, ["digest", "bytes", "mediaType"]);
  if (
    archive.digest !== value.checkpoint.payloadDigest ||
    !Number.isSafeInteger(archive.bytes) ||
    Number(archive.bytes) < 0 ||
    archive.mediaType !== "application/json"
  )
    throw new Error("Restoration archive differs from its exact checkpoint");
  const checkpoint = exact(value.checkpoint, ["commitSha", "payloadDigest"]);
  sha(checkpoint.commitSha, "restoration checkpoint");
  hash(checkpoint.payloadDigest, "restoration payload");
  const original = exact(value.original, [
    "snapshot",
    "configDigest",
    "schemaVersion",
  ]);
  hash(original.configDigest, "restoration original configuration");
  if (
    original.configDigest !== state.configDigest ||
    !Number.isSafeInteger(original.schemaVersion) ||
    Number(original.schemaVersion) < 7
  )
    throw new Error(
      "Restoration original differs from its frozen configuration",
    );
  const snapshot = exact(original.snapshot, ["digest", "bytes", "mediaType"]);
  hash(snapshot.digest, "restoration original snapshot");
  if (
    !Number.isSafeInteger(snapshot.bytes) ||
    Number(snapshot.bytes) < 0 ||
    snapshot.mediaType !== "application/json"
  )
    throw new Error("Invalid restoration original snapshot reference");
  const layout = (value: unknown, source: boolean) => {
    const object = exact(
      value,
      source
        ? ["authorityDigest", "configDigest", "checkout", "stateRoot"]
        : [
            "identity",
            "authorityDigest",
            "configDigest",
            "checkout",
            "stateRoot",
          ],
    );
    hash(object.authorityDigest, "restoration authority");
    hash(object.configDigest, "restoration configuration");
    if (!source) string(object.identity, "restoration installation identity");
    for (const key of ["checkout", "stateRoot"])
      if (
        typeof object[key] !== "string" ||
        !(object[key] as string).startsWith("/")
      )
        throw new Error(
          "Restoration layout must retain exact absolute host paths",
        );
  };
  layout(value.source, true);
  layout(value.installation, false);
  if (
    value.schemaVersion !== 1 ||
    !["held", "reconciled"].includes(value.status) ||
    !value.reason?.trim()
  )
    throw new Error("Invalid restoration disposition");
}
