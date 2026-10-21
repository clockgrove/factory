import type { ExecutionProfileEnvironment } from "./config.js";
import type { DesignRisk } from "./compiler/work-item-rubric.js";
import type { ControllerCapabilitiesManifest } from "./controller-capabilities.js";
import type { RetainedFailedResult } from "./repair-policy.js";
import type {
  GraphReviewFinding,
  ReviewChoiceFinding,
  ReviewPacket,
} from "./review-evidence.js";

export type Repository = `${string}/${string}`;

export interface SourceAssetBinding {
  /** Omitted kind means a path in the pinned repository checkout. */
  kind?: "repository" | "local" | "github-attachment";
  path: string;
  role: string;
  mediaType: string;
  visibility: "private" | "repository";
}

export interface ExecutionBinding {
  id: string;
  adapter: string;
  model?: string;
  reasoningEffort?: string;
  digest: string;
}

export interface ExecutionProfileSummary extends ExecutionBinding {
  description: string;
  selectionHints: string[];
  /** Built-in configuration only; omitted for opaque registered adapters. */
  environment?: {
    instructions: { present: false } | { present: true; identity: string };
    mcp?: { kind: "factory-worktree-read"; version: 1 };
  };
  constraints: {
    network: "host" | "off";
    tools?: string[];
    permissions?: string[];
  };
}
export interface ExecutionProfileChoices {
  defaultProfile: string;
  profiles: ExecutionProfileSummary[];
}

export interface WorkItem {
  /** A reviewed branch selector; absent or unknown facts never mean false. */
  condition?: { conditionId: string; when: boolean };
  /** Read-only proof node; uses the ordinary scheduler without a worker or PR. */
  kind?: "work" | "qa" | "aggregate" | "discovery";
  /** Bound read-only observation; never coding or publication authority. */
  discovery?: import("./discovery.js").DiscoverySpecification;
  /** Declared dependency observations, selected by exact role and typed fields. */
  discoveryInputs?: {
    producerItemId: string;
    role: string;
    fields: ("path" | "mode" | "blobSha" | "contentRef" | "classification")[];
  }[];
  /** Hierarchy only; every required child also has an explicit dependency edge. */
  children?: string[];
  executionProfile?: { id: string; reason: string };
  /** Controller-generated exact configuration identity; never model settings. */
  executionBinding?: ExecutionBinding;
  id: string;
  title: string;
  goal: string;
  acceptance: string[];
  nonGoals: string[];
  citations: { path: string; heading?: string }[];
  dependencies: string[];
  ownedPaths: string[];
  resources?: string[];
  /** Accepted pending priority: larger values run first, absent means zero. */
  priority?: number;
  /** Advisory duration estimate for ranking, never a resource reservation. */
  scheduling?: { estimatedDurationMs: number; reason: string };
  validation: {
    command: string;
    provenance: "base-observed" | "source-declared";
    source?: string;
  }[];
  brief: string;
  /**
   * Exact controller-selected inputs by reference, bound to the graph's base
   * commit: the Objective body (path OBJECTIVE) or a tracked file, whole
   * (heading "") or one exact heading. Bytes are re-derived and verified
   * against sha256 and length wherever they are needed (resolveWorkItemSources).
   */
  inputSources?: WorkItemSourceRef[];
  sourceAssets?: SourceAssetBinding[];
  expectedOutputRoles?: string[];
  minimumAssetSets?: number;
  requiredLfsRoles?: string[];
}

/** A Work Item source by reference: exact identity of bytes at the graph base. */
export interface WorkItemSourceRef {
  path: string;
  heading?: string;
  sha256: string;
  bytes: number;
}

/** A Work Item source's verified bytes, re-derived for one use and never persisted. */
export interface WorkItemSource {
  path: string;
  heading?: string;
  content: string;
}

/**
 * One thing the delivered result must satisfy: an Objective Acceptance
 * criterion (path OBJECTIVE, controller-enumerated) or an exit item the
 * planner extracted from a cited source, located by its exact zero-based
 * inclusive line range and restated in `statement`.
 */
export interface CoverageObligation {
  criterionId: string;
  /**
   * An Objective criterion carries its text. A source exit item is a
   * reference: path, content digest and line range, re-sliced from the
   * pinned source when needed.
   */
  source: {
    path: string;
    digest: string;
    text?: string;
    lines?: [number, number];
  };
  statement?: string;
}

/** A located source exit item the plan leaves out, justified by Objective lines. */
export interface SourceExclusion {
  /** A reference to the excluded lines. */
  source: {
    path: string;
    digest: string;
    lines: [number, number];
  };
  statement: string;
  reason: string;
  /** Zero-based OBJECTIVE lines whose constraints or out-of-scope text justify it. */
  objectiveLines: number[];
}

export type CoverageProof =
  | { kind: "result-command" | "integrated-command"; validationIndex: number }
  | {
      kind: "result-semantic" | "integrated-semantic";
      /**
       * Absent in new plans: the owner's review judges the obligation itself,
       * with the owner's acceptance as a whole as its proof. Plans retained
       * from earlier releases point at one owner acceptance entry instead.
       */
      acceptanceIndex?: number;
    }
  | { kind: "final-review" }
  | { kind: "final-controller"; guaranteeId: string }
  | { kind: "integrated-ci"; checkName: string }
  | { kind: "published-ci"; checkName: string; targetItem: string };

export interface AcceptanceCoverage extends CoverageObligation {
  itemId: string;
  proof: CoverageProof;
  environment: {
    kind: "local" | "real";
    readiness: "available" | "prepare" | "missing";
    /** Exact source-authorized probe in the owning node's validation commands. */
    probe: string;
    /** Ordered source-authorized preparation in this same fresh checkout. */
    prerequisites?: string[];
    /** Existing prerequisite node, never inferred setup authority. */
    preparedBy: string;
  };
}

export interface RequiredPreIntegrationCheck {
  checkName: string;
  /**
   * The pinned source authorizing this gate, by reference: its path, heading
   * and content digest at the graph base.
   */
  source: { path: string; heading?: string; digest: string };
}

/** Reviewed authority for one deterministic inventory-driven graph addition. */
export interface GraphExpansionEnvelope {
  schemaVersion: 1;
  id: string;
  input: {
    producerItemId: string;
    role: string;
    schema: "factory.repository-inventory/v1";
  };
  selectors: string[];
  workShape: "migration" | "cross-cutting-fix";
  selection:
    | { kind: "all-regular-files" }
    | { kind: "classified"; included: string[]; excluded: string[] };
  batching: { maxFilesPerChild: number };
  limits: { maxChildren: number; maxIterations: 1 };
  resources: string[];
  eligibleProfileIds: string[];
  dependencies: string[];
  integrationBarrierItemIds: string[];
  empty: "settle-without-children";
  /** Reviewed ordinary-work shape, never a separately executable node. */
  template: WorkItem;
}

export interface DeclaredWorkCondition {
  schemaVersion: 1;
  id: string;
  input: {
    producerItemId: string;
    role: string;
    schema: "factory.repository-inventory/v1";
  };
  predicate:
    | { kind: "inventory-empty" }
    | {
        kind: "has-classification";
        classification: string;
        otherClassifications: string[];
      };
}

export interface WorkGraph {
  /** Source-reviewed literal predicates over authenticated structured observations. */
  conditions?: DeclaredWorkCondition[];
  /** Initially reviewed declarations; settlement remains in the atomic snapshot. */
  expansions?: GraphExpansionEnvelope[];
  /** Source-required gates on every ordinary delivery head, separate from final proof. */
  requiredPreIntegrationChecks?: RequiredPreIntegrationCheck[];
  /** Complete Objective-wide mapping from source obligations to executable proof. */
  coverage: AcceptanceCoverage[];
  /** Cited-source exit items the plan leaves out of scope; absent means none. */
  sourceExclusions?: SourceExclusion[];
  objective: number;
  baseSha: string;
  items: WorkItem[];
  /**
   * Child Objectives instead of this Objective's own Work Items: items and
   * coverage are then empty, and each ready child carries its own graph.
   */
  split?: { children: import("./objective-split.js").ChildObjectiveSpec[] };
}

export type ModelInvocationPhase =
  | "propose"
  | "dream"
  | "compile"
  | "diagnosis"
  | "graph-review"
  | "result-review"
  | "objective-review";

export interface ModelInvocationUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  totalTokens?: number;
}

/** Cumulative provider counters for one worker invocation/provider attempt.
 * This is optional telemetry, never execution or recovery authority. */
export interface WorkerUsageObservation {
  profileId?: string;
  adapter?: string;
  type: "started" | "progress" | "completed" | "failed";
  invocationId: string;
  providerAttempt: number;
  role: "worker";
  phase: "implementation";
  provider?: string;
  model?: string;
  reasoningEffort?: string;
  serviceTier?: import("./config.js").CodexServiceTier;
  reportedServiceTier?: string | null;
  usage?: ModelInvocationUsage;
}

export interface ModelInvocationObservation {
  /** Private transient input for the opt-in observational sink; never lifecycle state. */
  capture?: {
    event: import("./capture.js").CaptureEvent;
    content?: () => unknown;
  };
  type:
    | "started"
    | "progress"
    | "retry-scheduled"
    | "completed"
    | "failed"
    | "response-invalid";
  invocationId: string;
  phase: ModelInvocationPhase;
  ordinal: number;
  /** One-based provider attempt within this logical model invocation. */
  providerAttempt?: number;
  /** Maximum provider attempts allowed for this logical model invocation. */
  providerMaxAttempts?: number;
  retryDelayMs?: number;
  /** Pinned SDK identity of the provider adapter, for opt-in captures. */
  adapter?: string;
  provider?: string;
  model?: string;
  reasoningEffort?: string;
  serviceTier?: import("./config.js").CodexServiceTier;
  reportedServiceTier?: string | null;
  providerThreadId?: string;
  durationMs?: number;
  promptBytes?: number;
  promptDigest?: string;
  schemaBytes?: number;
  schemaDigest?: string;
  sourcePacketBytes?: number;
  sourcePacketDigest?: string;
  responseBytes?: number;
  responseDigest?: string;
  providerEvent?: string;
  providerItemId?: string;
  providerItemType?: string;
  tool?: string;
  usage?: ModelInvocationUsage;
  usageAvailable?: boolean;
  /** Model turns of this provider attempt so far; the provider's own count once it ends. Presentation only. */
  turns?: number;
  /** Tool calls the model made in this provider attempt so far. Presentation only. */
  toolCalls?: number;
  /** Token counts the provider streamed before its final usage; never accounting. */
  liveInputTokens?: number;
  liveCachedInputTokens?: number;
  liveOutputTokens?: number;
  failureClass?: string;
  failureField?: string;
  failureReason?: string;
  /** Exact supplied source label only; never an invented provider value. */
  failureSource?: string;
  detail?: string;
}

/** Capture policy conveyed by the existing observational sink, not model authority. */
export type ModelInvocationObserver = ((
  observation: ModelInvocationObservation,
) => void) & {
  nativeBoundaryTelemetry?: boolean;
};

export interface ModelInvocationContext {
  /** Record and validate each bounded attempt; facts may share the declared following dispatch checkpoint. Absent on cached decode. */
  beforeProviderAttempt?: () => void | Promise<void>;
  /** Awaited dispatch intent and prior attempt facts before transport submission. Confirm admission only after the complete durable checkpoint succeeds. */
  beforeProviderDispatch?: () =>
    | void
    | "admission-complete"
    | Promise<void>
    | Promise<undefined | "admission-complete">;
  /** Exact native return retained before release. Confirm admission only after its durable checkpoint succeeds; void callers retain adapter admission. */
  retainNativeReturn?(receipt: {
    response: string;
    representation: "literal-agent-text" | "sdk-structured-value";
    /** Actual SDK JSON value, not literal model JSON text; serialized only for retention. */
    structuredValue?: import("./config.js").JsonValue;
    providerSessionId?: string;
    terminal: "completed" | "failed" | "interrupted";
    usage?: ModelInvocationUsage;
  }): Promise<"admission-complete"> | Promise<void>;
  invocationId: string;
  phase: ModelInvocationPhase;
  ordinal: number;
  /** Adapter-owned current provider attempt, exposed for correlated diagnostics. */
  providerAttempt?: number;
  /** Adapter-owned bounded provider-attempt count. */
  providerMaxAttempts?: number;
  observe?: ModelInvocationObserver;
}

/** Controller-observed native admission, not target source or WorkGraph edges. */
export interface PlanningPrerequisites {
  provenance: "authenticated-native-dependencies-and-sealed-continuations";
  repository: string;
  objective: number;
  baseSha: string;
  predecessors: {
    objective: number;
    bodyDigest: string;
    acceptance: Pick<
      import("./completion.js").FinalAcceptance,
      | "candidateBasis"
      | "sealedAt"
      | "commit"
      | "tree"
      | "graphDigest"
      | "configDigest"
      | "evidenceDigest"
    >;
    status: "accepted-and-closed";
    baseRelationship: "equal" | "descendant";
  }[];
}

/** Observed controller validation tools, never worker or acceptance readiness. */
export interface PlanningLocalExecutables {
  provenance: "controller-local-validation-executable-preflight";
  baseSha: string;
  finalCommands: string[];
  observations: import("./local-preflight.js").ExecutablePreflightObservation[];
}

/** Controller configuration, not driver capacity or runtime overlap. */
export interface PlanningExecutionBounds {
  configuredConcurrency: number;
}

export function assertPlanningExecutionBounds(
  value: PlanningExecutionBounds,
): void {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).join() !== "configuredConcurrency" ||
    !Number.isSafeInteger(value.configuredConcurrency) ||
    value.configuredConcurrency < 1
  )
    throw new Error("Invalid controller planning execution bounds");
}

/** Approved advisory history; never current source evidence or execution authority. */
export interface ApprovedPlaybook {
  repository: string;
  version: number;
  digest: string;
  content: string;
}
export type ApprovedPlaybookPin = { version: number; digest: string } | null;
/** Original admitted plan binding, retained when its executable graph evolves. */
export interface ApprovedPlaybookAdmission {
  approvedPlaybookPin: ApprovedPlaybookPin;
  configDigest: string;
  graphDigest: string;
  packetDigest: string;
  reviewDigest: string;
  sourcePacketDigest: string;
}
export function assertApprovedPlaybookAdmission(
  pin: unknown,
  admission: unknown,
  configDigest: unknown,
  originalGraphDigest: unknown,
): asserts admission is ApprovedPlaybookAdmission {
  if (admission === undefined)
    throw new Error(
      "Approved playbook pin lacks its original admission binding",
    );
  if (!admission || typeof admission !== "object" || Array.isArray(admission))
    throw new Error("Approved playbook admission differs from the active pin");
  const receipt = admission as Record<string, unknown>;
  if (
    Object.keys(receipt).sort().join(",") !==
    "approvedPlaybookPin,configDigest,graphDigest,packetDigest,reviewDigest,sourcePacketDigest"
  )
    throw new Error("Invalid approved playbook admission binding");
  assertApprovedPlaybookPin(pin);
  assertApprovedPlaybookPin(receipt.approvedPlaybookPin);
  for (const key of [
    "configDigest",
    "graphDigest",
    "packetDigest",
    "reviewDigest",
    "sourcePacketDigest",
  ]) {
    if (
      typeof receipt[key] !== "string" ||
      !/^[a-f0-9]{64}$/.test(receipt[key] as string)
    )
      throw new Error("Invalid approved playbook admission fingerprint");
  }
  if (
    JSON.stringify(pin) !== JSON.stringify(receipt.approvedPlaybookPin) ||
    receipt.configDigest !== configDigest ||
    receipt.graphDigest !== originalGraphDigest
  )
    throw new Error(
      "Approved playbook pin differs from the original admitted plan",
    );
}

export function assertApprovedPlaybookPin(
  value: unknown,
): asserts value is ApprovedPlaybookPin {
  if (value === null) return;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid approved playbook pin");
  const pin = value as Record<string, unknown>;
  if (
    Object.keys(pin).sort().join(",") !== "digest,version" ||
    !Number.isSafeInteger(pin.version) ||
    Number(pin.version) < 1 ||
    typeof pin.digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(pin.digest)
  )
    throw new Error("Invalid approved playbook pin");
}

export interface PlanningRequest<T> {
  /** Pinned structural planning input; never source, command or effect authority. */
  workflowRecipe?: import("./workflow-recipes.js").WorkflowRecipeInput;
  /** Authenticated role input; preserves source, command and effect authority. */
  adaptiveContext?: import("./adaptive-context.js").AdaptiveContextPacket;
  /** Retained controller-selected facts, separate from normative source authority. */
  contextLookup?: import("./compiler/context.js").PlanningContextPacket;
  /** Controller-owned planner continuation; never model-authored or persisted in a graph. */
  session?: AgentSessionContinuation;
  approvedPlaybookPin?: ApprovedPlaybookPin;
  /** Trusted transient compile input; not part of canonical or persisted graphs. */
  compileContext?: {
    objectiveNumber: number;
    instructions: string;
    /** The Objective is a split's child (its issue carries the child marker): it never splits again. */
    splitChild?: boolean;
    /** The installation's CI-only commands, refused as validation commands. */
    ciOnlyCommands?: string[];
    previousGraph?: WorkGraph;
    immutableItemIds?: string[];
    /** Retained failed items attempted again; their ownership and dependencies may widen. */
    reattemptItemIds?: string[];
    /** Observed current code; never normative sources or command authority. */
    currentImplementationEvidence?: ResultReviewEvidenceSource[];
    /**
     * A revision of the current plan: the planner answers with only its
     * changes, which Factory applies to `answer` before the full decode.
     */
    revision?: {
      /** The current plan as the planner's last complete compiler answer. */
      answer: unknown;
      /** Exact base bytes of the repository sections the affected items cite. */
      citations: { path: string; heading: string; content: string }[];
    };
  };
  /** Receives the complete compiler answer (a revision already applied) before decoding. */
  retainCompilerAnswer?: (answer: unknown) => void;
  /** Package scripts the acceptance commands run, as the base defines them; validation keeps them fixed. */
  fixedScripts?: { name: string; body: string }[];
  prerequisites?: PlanningPrerequisites;
  localExecutables?: PlanningLocalExecutables;
  executionBounds?: PlanningExecutionBounds;
  purpose?: "diagnosis";
  /** Transient Work Item delivery choices; canonical sources/evidence remain retained. */
  workRepairDiagnosis?: {
    mode: "complete" | "focused-semantic-refusal";
    evidenceDigest: string;
    sourcesDigest: string;
    evidenceIndices: number[];
    sourceIndices: number[];
  };
  /** Actual decoded rejected graph; null when no canonical graph was produced. */
  rejectedGraph?: WorkGraph | null;
  coverageObligations?: CoverageObligation[];
  /** Check names from the base's workflows. */
  checkNames?: string[];
  objective: string;
  baseSha: string;
  sources: { path: string; content: string; heading?: string }[];
  controllerCapabilities: ControllerCapabilitiesManifest;
  controllerCapabilitiesDigest: string;
  executionProfiles?: ExecutionProfileChoices;
  schema?: unknown;
  resultType?: T;
  invocation?: ModelInvocationContext;
}

export interface PlanCommandAuthorization {
  itemId: string;
  command: string;
  provenance: "base-observed" | "source-declared";
  source?: string;
  hostExecution: "authorized" | "blocked";
  reason: string;
}

/**
 * The operator's answer to a question the planner asked while compiling, or
 * to a plan review's operator-decision questions,
 * bound to the retained draft (compiler answer) it was asked about. It is
 * authority for that one choice within the Objective, never new command,
 * ownership or source authority.
 */
export interface OperatorPlanningDecision {
  question: string;
  answer: string;
  actor: string;
  reason: string;
  at: string;
  /** SHA-256 of the exact retained draft the answer revises. */
  draftDigest: string;
}

/**
 * An operator answer a review checks the graph follows. An answer to a
 * pending amendment's question reaches the amendment's next compilation, not
 * a retained draft, and records neither a time nor a draft.
 */
export type ReviewedOperatorDecision =
  | OperatorPlanningDecision
  | Omit<OperatorPlanningDecision, "at" | "draftDigest">;

export interface PlanReviewRequest {
  /** Operator answers to the planner's, plan reviews' and an amendment's questions, in the order asked. */
  operatorDecisions?: ReviewedOperatorDecision[];
  /** Exact pinned structural recipe independently reviewed with this graph. */
  workflowRecipe?: import("./workflow-recipes.js").WorkflowRecipeInput;
  /** Authenticated role input; preserves source, command and effect authority. */
  adaptiveContext?: import("./adaptive-context.js").AdaptiveContextPacket;
  /** The exact context packet used by compilation, independently reviewed. */
  contextLookup?: import("./compiler/context.js").PlanningContextPacket;
  approvedPlaybookPin?: ApprovedPlaybookPin;
  prerequisites?: PlanningPrerequisites;
  localExecutables?: PlanningLocalExecutables;
  executionBounds?: PlanningExecutionBounds;
  amendment?: {
    previousGraph: WorkGraph;
    proposal: unknown;
    work: Record<string, unknown>;
    currentImplementationEvidence?: ResultReviewEvidenceSource[];
  };
  reviewPacket?: ReviewPacket;
  objective: string;
  baseSha: string;
  sources: { path: string; content: string; heading?: string }[];
  controllerCapabilities: ControllerCapabilitiesManifest;
  controllerCapabilitiesDigest: string;
  executionProfiles?: ExecutionProfileChoices;
  graph: WorkGraph;
  commands: PlanCommandAuthorization[];
  finalCommands: string[];
  /** The installation's required final-validation commands, already in finalCommands. */
  requiredFinalCommands?: string[];
  /** The installation's review-artifact selectors compile and graph review saw; absent when none. */
  reviewArtifactSelectors?: import("./review-artifacts.js").ReviewArtifactSelector[];
  /** Check names from the base's workflows. */
  checkNames?: string[];
  /**
   * A planning revision round's review scope. Set only on the request to the
   * reviewer, never in the packet or its digest; absent on a first review.
   */
  revisionScope?: PlanRevisionScope;
  invocation?: ModelInvocationContext;
}

/** What a revision round's review checks first: the last review's findings and the revision's changes. */
export interface PlanRevisionScope {
  /** This review's number among the plan's reviews, from 1. */
  round: number;
  previousFindings: { kind: string; itemIds: string[]; detail: string }[];
  /** Work Items present in both graphs whose definition changed. */
  changedItemIds: string[];
  addedItemIds: string[];
  removedItemIds: string[];
  /** Plan-level graph fields (such as coverage or sourceObligations) the revision changed; operatorDecisions when the operator answered since. */
  changedFields: string[];
}

export interface ValidationCommandReceipt {
  index: number;
  command: string;
  passed: true;
  exitCode: 0;
  treeSha: string;
  /** Observed controller controls, not candidate timers or escaped-resource proof. */
  executionControl?: {
    scope: "controller-owned-process-group";
    cancellation: "active-at-dispatch";
    settlement: "verified";
    /** Omitted unless the armed controller deadline matches the current step. */
    deadlineAt?: string;
  };
  /**
   * Processes the command left running that Factory stopped once the
   * command had exited and its grace period passed. Absent when none.
   */
  stoppedLeftovers?: number;
}

/** Exact controller-materialized observation supplied as native image input. */
export interface ReviewImageInput {
  /** Absolute regular PNG in this invocation's private read-only evidence root. */
  path: string;
  mediaType: "image/png";
  bytes: number;
  digest: string;
  /** Stable packet-local identity; never an ephemeral absolute path. */
  evidencePath: string;
}

export interface ResultReviewEvidenceSource {
  /** Retained citations preserve source/controller provenance when forwarded. */
  origin?: "source" | "controller";
  /** Exact producer-approved literal body within content; no provenance reuse. */
  reusableBody?: { start: number; length: number; digest: string };
  path: string;
  content: string;
  /** False when this source contains only bounded partial text evidence. */
  complete?: boolean;
}

export interface ResultReviewCandidate {
  criterion: string;
  verdict: string;
  source: string;
  quote: string;
  detail: string;
  question: string;
}

export type ResultReviewFinding = ReviewChoiceFinding;

export type AgentSessionRole =
  | "planning"
  | "implementation"
  | "result-review"
  | "objective-review";

/** Resume support is role-specific; it promises no active-turn reattachment. */
export interface AgentSessionCapabilities {
  resumeRoles: readonly AgentSessionRole[];
}

interface AgentObjectiveScope {
  repository: string;
  objective: number;
  runId: string;
  configDigest: string;
}

/** Factory-owned scope; native session identifiers remain inside adapters. */
export type AgentSessionScope = AgentObjectiveScope &
  (
    | {
        role: "planning";
        planningInputDigest: string;
        graphDigest?: never;
        itemId?: never;
      }
    | {
        role: "implementation" | "result-review";
        graphDigest: string;
        itemId: string;
        planningInputDigest?: never;
      }
    | {
        role: "objective-review";
        graphDigest: string;
        itemId?: never;
        planningInputDigest?: never;
      }
  );

/** The current admitted turn, not native history, acceptance or telemetry. */
export interface AgentSessionTurn {
  invocationId: string;
  requestDigest: string;
  /** Admitted elapsed ceiling, immutable for this turn; absent when there is no deadline. */
  deadlineAt?: string;
  graphDigest?: string;
  candidateDigest?: string;
  evidenceDigest?: string;
  schemaDigest?: string;
  dispatch: "intent" | "submitted";
  terminal?: "completed" | "failed" | "interrupted";
  resources: "active" | "settled" | "unknown";
}

/** Durable adapter receipt, separate from a paid attempt or acceptance verdict. */
export interface AgentSessionRef {
  scope: AgentSessionScope;
  /** Durable execution owner; absent for reviews or when ownership is unknown. */
  executionIdentity?: string;
  adapter: string;
  identity: string;
  data?: unknown;
  turn: number;
  currentTurn?: AgentSessionTurn;
  status: "ready" | "in-flight" | "unavailable" | "released";
}

export interface AgentSessionRequest {
  scope: AgentSessionScope;
  /** Transient current graph binding; planning lifetime identity excludes it. */
  currentGraphDigest?: string;
  /** Controller-allocated logical identity; distinct from native thread IDs. */
  identity: string;
  retained?: AgentSessionRef;
}

/** Controller callback only; never serialized into a worker or model prompt. */
export interface AgentSessionContinuation extends AgentSessionRequest {
  /** Current controller-owned Objective ceiling; never a native session setting. */
  objectiveDeadlineAt?: string;
  checkpoint(ref: AgentSessionRef): void;
}

/** Private advisory learning; never source, command or acceptance authority. */
export interface WorkHandoffNote {
  kind: "interface" | "pitfall" | "hypothesis" | "verification" | "design";
  summary: string;
  paths: string[];
  consumers: string[];
  /**
   * A verification note's zero-based acceptance criterion: the implementer's
   * claimed map from that criterion's sub-clauses to the files proving them.
   * It is an index for review, never proof.
   */
  criterionIndex?: number;
  /**
   * A design note's checklist question: the implementer's claimed answer, with
   * the file:line locations it rests on. Like a verification map, it is an
   * index for review, never proof.
   */
  designRisk?: DesignRisk;
}

/** Authenticated adapter recovery; observational captures never supply this. */
export type AgentSessionReconciliation =
  | { disposition: "active" | "unknown" }
  | {
      /**
       * The adapter proved the turn's recorded process ceased and holds no
       * outcome for it. `session` is the receipt with its resources settled
       * and its turn still unknown, for settlement as abandoned.
       */
      disposition: "ceased";
      session: AgentSessionRef;
    }
  | {
      disposition: "settled";
      session: AgentSessionRef;
      /** Exact retained final bytes; normal shared decoding/grounding still applies. */
      response?: string;
      nativeReturn?: Parameters<
        NonNullable<ModelInvocationContext["retainNativeReturn"]>
      >[0];
      usage?: ModelInvocationUsage;
    };

export interface RetainedPlannerCheckpointCoverage {
  contract: "retained-planner-native-checkpoint-v1";
  adapter: string;
}

export interface PlanningModel {
  readonly retainedPlannerCheckpointCoverage?: RetainedPlannerCheckpointCoverage;
  readonly providerAttemptAdmission?: "controller-checkpoint-v1";
  /** Invoke the awaited dispatch callback after complete local attempt admission and before any transport effect; a declared native route may compose it with its complete final pre-effect checkpoint. */
  readonly providerDispatchAdmission?: "after-attempt-admission-v1";
  readonly sessionCapabilities?: AgentSessionCapabilities;
  reconcileSession?(
    session: AgentSessionRef,
  ): Promise<AgentSessionReconciliation>;
  /** Decode authenticated recovered bytes with the ordinary request decoder; no provider call. */
  decodeSessionResponse?<T>(request: PlanningRequest<T>, response: string): T;
  releaseSession?(session: AgentSessionRef): Promise<void>;
  approvedPlaybook?: ApprovedPlaybook;
  approvedPlaybookPin?: ApprovedPlaybookPin;
  generateStructured<T>(request: PlanningRequest<T>): Promise<T>;
  reviewGraph(
    request: PlanReviewRequest,
  ): Promise<{ packetId: string; findings: GraphReviewFinding[] }>;
  reviewResult?(request: {
    adaptiveContext?: import("./adaptive-context.js").AdaptiveContextPacket;
    reviewPhase?: "result-review" | "objective-review";
    criteria: string[];
    /** Result review: criteria from this index on are Objective criteria the item proves. */
    itemCriteria?: number;
    reviewPacket: ReviewPacket;
    baseSha: string;
    treeSha: string;
    sources: { path: string; content: string }[];
    change: string;
    commands: ValidationCommandReceipt[];
    evidence?: ResultReviewEvidenceSource[];
    observations?: string;
    invocation?: ModelInvocationContext;
    /** Why the previous answer was invalid; answer again without the error. */
    previousInvalid?: string;
    /** Current authenticated pinned-source files; absent for inline review. */
    reviewFiles?: import("./review-evidence.js").ReviewBodyFile[];
    reviewImages?: ReviewImageInput[];
    /** Exported exact candidate and approved source files; no Git metadata. */
    tree?: string;
    session?: AgentSessionContinuation;
  }): Promise<{
    packetId: string;
    findings: ResultReviewFinding[];
  }>;
}

export interface ExecutionRequest {
  /** Current admitted graph recipients; models select indices, never identities. */
  handoffPeers?: { id: string; title: string }[];
  /** Authenticated role input; preserves source, command and effect authority. */
  adaptiveContext?: import("./adaptive-context.js").AdaptiveContextPacket;
  /** Controller-required native child prohibition; never a copied parent allowance. */
  childAgents?: "disabled";
  /** Controller-authenticated selector-bound observation supplied to discovery. */
  discovery?: { manifest: import("./discovery.js").DiscoveryOutputManifest };
  session?: AgentSessionRequest;
  captureContext?: {
    objective: number;
    runId: string;
    attemptId?: string;
    configDigest?: string;
  };
  item: WorkItem;
  /** Original accepted citation base, distinct from the integrated execution base. */
  sourceBaseSha?: string;
  baseSha: string;
  /** Exported symbols and duplicated helpers at baseSha; reference data only. */
  conventions?: string;
  attemptId?: string;
  sourceAssets?: { binding: SourceAssetBinding; ref: ContentRef }[];
  objectiveBody?: string;
  selectedAssets?: SelectedAssetInput[];
  /** The selected LFS bytes controller validation restores for this item at its base. */
  validationLfsMembers?: ValidationLfsMember[];
  /** Archived failed commit only; never an accepted execution base or proof. */
  retainedFailedResult?: RetainedFailedResult;
  /** Trusted graph selection; never commands inferred from the authored brief. */
  environmentReadiness?: {
    validationIndices: number[];
    /** Readiness-only rows; excludes every substantive command proof. */
    reusableValidationIndices?: number[];
    acceptedBaseSha: string;
    lfsMembers: ValidationLfsMember[];
    workspacePackageAdditions: string[];
    packageManagerUpdate?: string;
  };
}
export interface ExecutionHandle {
  provider: string;
  identity: string;
  data?: unknown;
}
export interface AuthenticationRequest {
  /** Adapter/provider whose developer-local login is missing or expired. */
  provider: string;
  /** Interactive command the operator runs outside the detached worker. */
  command: string;
}
export class AuthenticationRequiredError extends Error {
  override readonly name = "AuthenticationRequiredError";

  constructor(
    message: string,
    readonly authentication: AuthenticationRequest,
    /**
     * The provider rejected the credentials it was sent (HTTP 401) before any
     * model turn. Another client on the host may have just rotated a shared
     * login, so a fresh session that reads it again can succeed.
     */
    readonly credentialRejected = false,
  ) {
    super(message);
  }
}
export interface ExecutionObservation {
  state: "running" | "complete" | "failed" | "cancelled";
  /** Failed only because the worker ended without writing a result; repeat it. */
  interrupted?: boolean;
  detail?: string;
  authentication?: AuthenticationRequest;
}
export interface WorkDiscovery {
  scope: "in-scope" | "backlog";
  reason: string;
  evidence: string[];
  ownership: string[];
  acceptance: string[];
  dependencies: string[];
}

export interface ExecutionResult {
  discoveryOutput?: import("./discovery.js").DiscoveryOutputManifest;
  session?: AgentSessionRef;
  handoff?: {
    notes: WorkHandoffNote[];
    sources: { path: string; ref: ContentRef }[];
  };
  discovery?: WorkDiscovery;
  /** Driver observation during successful original-worktree collection, not continuous retention. */
  collection?: { acceptedIgnoredLinks: string[] };
  treeSha: string;
  changeRef: string;
  assets?: CapturedAssetSet[];
  evidence?: unknown;
}
/** A provider resource a lost response may have created that Factory cannot find to delete. */
export interface ExecutionOrphan {
  resource: string;
  detail: string;
}
/** Persist before each external mutation; callbacks are controller-owned, never serialized. */
export interface ExecutionContext {
  /** Await durable admission after exact local checkpoint and before effects or result disposal. */
  checkpointedEffects?: true;
  admitEffect?(
    reason?: "before-effect" | "settled" | "explicit",
  ): Promise<void>;
  checkpointSession?(session: AgentSessionRef): void;
  observeReadiness?(observation: {
    workerIdentity: string;
    index: number;
    command: string;
    passed: boolean;
    exitCode: number;
    durationMs: number;
    output: string;
    baseSha: string;
    treeSha: string;
    worktree: string;
    source: string;
  }): void;
  observeReadinessOffer?(observation: {
    workerIdentity: string;
    status: "bound-current" | "ineligible" | "invalidated";
    eligibleCommandCount: number;
    receiptDigest?: string;
  }): void;
  observeUsage?(observation: WorkerUsageObservation): void;
  /** Diagnostic only: records a possible orphan for operator cleanup. */
  observeOrphan?(orphan: ExecutionOrphan): void;
  cancelled(): boolean;
  checkpoint(handle: ExecutionHandle): void;
}

export interface ExecutionDriver {
  /** Enforces awaited controller barriers before owned effects and result disposal. */
  readonly effectAdmission?: "controller-checkpoint-v1";
  /** Can enforce an explicitly requested child prohibition, or refuse before dispatch. */
  readonly childAgents?: "disabled";
  /** Semantic discovery is admitted only after this driver's selector-bound read-only preflight. */
  readonly readonlyDiscovery?: "selector-bound-read-only-v1";
  readonly sessionCapabilities?: AgentSessionCapabilities;
  releaseSession?(session: AgentSessionRef): Promise<void>;
  /** Supports authenticated preparation in its actual fresh worker checkout. */
  readonly freshCheckoutReadiness?: true;
  /** Can expose an authenticated retained failed Git result in its fresh checkout. */
  readonly retainedFailedResultContext?: true;
  preflight?(graph: WorkGraph): Promise<void>;
  availableSlots(): Promise<number | "unknown">;
  start(
    request: ExecutionRequest,
    context?: ExecutionContext,
  ): Promise<ExecutionHandle>;
  /**
   * Join this driver's existing start owner before capturing cleanup checkpoints.
   * Uses that operation's existing bounds; completion alone proves no cessation.
   * Its original caller retains any rejection and submitted-effect uncertainty.
   */
  settleStartingAttempt?(attemptId: string): Promise<void>;
  /**
   * Adopt a recorded attempt before repeating its step (#515): the handle to
   * continue with, or undefined once the driver confirmed nothing of the
   * attempt runs and it left no result, so a new attempt may start. A worker
   * that failed with a result to report is continued; collect reports it.
   * `start` and `collect` are idempotent per attempt: a repeated start
   * returns the running attempt and a repeated collect the saved result.
   */
  find(
    handle: ExecutionHandle,
    context?: ExecutionContext,
  ): Promise<ExecutionHandle | undefined>;
  /**
   * Stop whatever an attempt whose handle was never recorded started under
   * `attemptId`; resolves once nothing of it runs. A driver that checkpoints
   * before its first effect has nothing to stop.
   */
  cancelUnrecorded(
    attemptId: string,
    context?: ExecutionContext,
  ): Promise<void>;
  observe(
    handle: ExecutionHandle,
    context?: ExecutionContext,
  ): Promise<ExecutionObservation>;
  cancel(handle: ExecutionHandle, context?: ExecutionContext): Promise<void>;
  collect(
    handle: ExecutionHandle,
    context?: ExecutionContext,
  ): Promise<ExecutionResult>;
}

export interface HarnessRequest {
  /** Controller-supplied peer choices, scoped to this exact execution request. */
  handoffPeers?: { id: string; title: string }[];
  /** Authenticated role input; preserves source, command and effect authority. */
  adaptiveContext?: import("./adaptive-context.js").AdaptiveContextPacket;
  /** Explicit attempt policy; absence preserves the configured static workflow. */
  childAgents?: "disabled";
  /** Only authenticated selected blobs are exposed to a read-only discovery harness. */
  discovery?: {
    manifest: import("./discovery.js").DiscoveryOutputManifest;
    body: import("./discovery.js").DiscoveryBody;
  };
  /** Controller preparation in this exact checkout; never acceptance or lifetime proof. */
  workerReadiness?: import("./worker-readiness.js").WorkerReadinessReceipt;
  session?: AgentSessionRequest;
  /** Pinned Objective section, parsed by the controller; never model-granted authority. */
  packageManagerUpdate?: string;
  capture?: {
    context: import("./capture.js").CaptureContext;
    policy?: import("./capture.js").CapturePolicy;
  };
  /** Installation-owned private preparation; never part of the Work Item graph. */
  environment?: ExecutionProfileEnvironment;
  /** Exact Factory-owned worktree. The harness may operate only inside it. */
  item: WorkItem;
  /** Original accepted source pin and current owned file presentation. */
  sourceBaseSha?: string;
  sourceDelivery?: import("./compiler/source-delivery.js").PlanningSourceDelivery;
  /** Exported symbols and duplicated helpers at the attempt base; reference data only. */
  conventions?: string;
  worktree: string;
  attemptId?: string;
  sourceAssets?: {
    binding: SourceAssetBinding;
    ref: ContentRef;
    path?: string;
  }[];
  selectedAssets?: (SelectedAssetInput & { path: string })[];
  /** The controller's private store of exactly these members' verified bytes, outside the worktree. */
  validationLfs?: { members: ValidationLfsMember[]; store: string };
  /** The operator's OS sandbox policy for commands the worker causes; absent is strict. */
  commandSandbox?: import("./execution/sandbox.js").CommandSandboxPolicy;
  /** The controller's admitted checkpoint bounds; a worker's snapshot stages no more than collection could retain. */
  candidateBounds?: { maxBytes: number; maxFiles: number };
}
export interface HarnessHandle {
  /** Provider attempt identity, stable across controller restarts. */
  identity: string;
  /** JSON-safe durable data only; no live process, closure, or credential. */
  data?: unknown;
}
export interface HarnessObservation {
  /** Settled native context may survive a subsequently failed candidate. */
  session?: AgentSessionRef;
  state: "running" | "complete" | "failed" | "cancelled";
  /** Failed only because the worker ended without writing a result; repeat it. */
  interrupted?: boolean;
  /** The provider's limit reset time (ISO 8601), when it gave one. */
  retryAt?: string;
  detail?: string;
  /** Present when the attempt is paused on a developer-local login. */
  authentication?: AuthenticationRequest;
}
export interface HarnessResult {
  session?: AgentSessionRef;
  assets?: ProducedAssetSet[];
  evidence?: unknown;
}
export interface AgentHarnessCapabilities {
  /** Starts one durable parent-admitted worker invocation; no opaque effect dispatch. */
  effectAdmission?: "controller-checkpoint-v1";
  /** Can enforce HarnessRequest.childAgents; does not describe an omitted policy. */
  childAgents?: "disabled";
  discovery?: {
    schema: "factory.repository-inventory/v1";
    worktree: "read-only";
    children: "disabled";
    network: "off";
    freshConversation: true;
  };
  protocolVersion: 1;
  worktree: "factory-owned-read-write";
  head: "preserve";
  lifecycle: "restart-safe-durable-handle";
  publication: "controller-only";
  assetSets: true;
  authentication: "local-environment" | "adapter-owned" | "none";
}
export interface AgentHarness {
  readonly sessionCapabilities?: AgentSessionCapabilities;
  readonly sessionAdapter?: string;
  /**
   * "fresh": an attempt that continues a refused candidate starts a new native
   * conversation instead of resuming the earlier one. Its worktree holds the
   * candidate and its prompt carries the findings, so the earlier transcript
   * adds context but no needed fact.
   */
  readonly candidateContinuationSession?: "fresh";
  releaseSession?(session: AgentSessionRef): Promise<void>;
  /** Declared before composition; Factory rejects incompatible semantics. */
  readonly capabilities: AgentHarnessCapabilities;
  /**
   * Start one attempt in the supplied worktree without moving HEAD. The
   * harness does not commit, push, publish, or receive Factory's GitHub
   * gateway. A returned handle must support restart-safe observation,
   * cancellation, and collection without duplicating an ambiguous attempt.
   */
  start(request: HarnessRequest): Promise<HarnessHandle>;
  observe(handle: HarnessHandle): Promise<HarnessObservation>;
  cancel(handle: HarnessHandle): Promise<void>;
  collect(handle: HarnessHandle): Promise<HarnessResult>;
  /**
   * Stop whatever a start of `identity` spawned before its handle was
   * recorded (a crash between spawn and save). Harnesses that spawn
   * processes implement it; it is a no-op when nothing runs.
   */
  cancelUnrecorded?(identity: string): Promise<void>;
}

/** Exact ordinary publication preparation, recorded by its existing snapshot owner. */
export interface PublicationEffectRequest {
  kind: "lfs-upload" | "branch-push" | "merge";
  pullRequest?: number;
  branch: string;
  headSha: string;
  /** The exact remote head used by the existing leased product branch push. */
  expectedRemoteHead?: string | null;
}

/** Exclusive controller ownership; persisted intent never regenerates a create permit. */
export interface PublicationControl {
  readonly reconcileOnly: boolean;
  readonly expectedPublication?: { titleDigest: string; bodyDigest: string };
  assertRequest(request: PullRequestPublication): void;
  beforeEffect(
    request: PullRequestPublication,
    effect: PublicationEffectRequest,
  ): Promise<void>;
  observedEffect(
    request: PullRequestPublication,
    effect: PublicationEffectRequest,
  ): Promise<void>;
  beforeCreate(request: PullRequestPublication): void | Promise<void>;
  observed(
    request: PullRequestPublication,
    identity: PullRequestIdentity,
  ): void | Promise<void>;
}

export interface DeliveryRequest {
  item: WorkItem;
  baseSha: string;
  treeSha: string;
  changeRef: string;
  branch: string;
  baseBranch?: string;
  /** Required by ordinary publication; created by the exclusive snapshot owner. */
  publication?: PublicationControl;
  /** Controller-rendered publication text from public intent and exact candidate facts. */
  body: string;
  lfs?: boolean;
  /** Commits earlier attempts of this Work Item produced for this branch. */
  earlierHeads?: string[];
}
export interface DeliveryResult {
  branch: string;
  pullRequest: number;
  headSha: string;
  /** Heads earlier attempts pushed to `branch`; a read may still show one. */
  earlierHeads?: string[];
}
export interface DeliveryObservation {
  /** Successful uniquely named check runs observed on this exact PR head. */
  namedChecks?: NamedCheckEvidence[];
  /**
   * Every check name with any run (queued, running or ended, whatever the
   * conclusion) or commit status on this exact PR head. A name here has
   * reported; namedChecks lists only the successful ones.
   */
  reportedChecks?: string[];
  state: "open" | "merged" | "closed";
  /** When a closed PR was closed. */
  closedAt?: string;
  checks: "pending" | "passing" | "failing";
  /**
   * Check runs and commit statuses on this exact head that ended without
   * success (failed, cancelled, timed out, errored), required or not. A
   * cancelled or stale run here has no successor of the same name, app
   * and, for GitHub Actions, workflow.
   */
  failedChecks?: FailedCheck[];
  /**
   * Check names on this exact head still running or pending, and required
   * checks not reported yet.
   */
  pendingChecks?: string[];
  /**
   * When the pending set last changed, from GitHub's own times: the latest
   * start of a check still running, update of a pending status, or, for a
   * required check not reported yet, the push of the head. Absent when
   * nothing is pending or a time is unknown.
   */
  pendingSince?: string;
  /**
   * When an open PR's head was pushed, from GitHub's repository activity;
   * observed only when no GitHub Actions check has reported on the head.
   * Absent when GitHub does not show it.
   */
  pushedAt?: string;
  /** Whether a GitHub Actions check run is on this exact open PR head. */
  actionsChecks?: boolean;
  /**
   * Whether the repository has an active Actions workflow; observed only
   * when other checks, but none from Actions, reported on an open PR head.
   * Absent when unknown.
   */
  actionsWorkflows?: boolean;
  /**
   * Authenticated target protection readiness; absent only on custom
   * gateways. `ready`: GitHub allows the merge, even with checks the
   * repository does not require still running or failed; `conflict`: the
   * head conflicts with the base; `draft`: someone made the PR a draft.
   */
  mergeReadiness?: "ready" | "waiting" | "conflict" | "draft" | "behind";
}
export interface MergeResult {
  integratedSha: string;
}
export interface MergeControl {
  beforeMerge(identity: PullRequestIdentity): Promise<void>;
  observedMerge(
    identity: PullRequestIdentity,
    result: MergeResult,
  ): Promise<void>;
}

export interface DeliveryStrategy {
  readonly effectAdmission?: "controller-checkpoint-v1";
  publish(request: DeliveryRequest): Promise<DeliveryResult>;
  observe(result: DeliveryResult): Promise<DeliveryObservation>;
  /** Merge the published head, or confirm a merge already made. */
  merge(result: DeliveryResult, control?: MergeControl): Promise<MergeResult>;
}

export interface ContentMetadata {
  mediaType: string;
}
export interface ContentRef {
  digest: string;
  bytes: number;
  mediaType: string;
}
export interface ContentStore {
  put(
    stream: ReadableStream<Uint8Array>,
    metadata: ContentMetadata,
  ): Promise<ContentRef>;
  open(ref: ContentRef): Promise<ReadableStream<Uint8Array>>;
  verify(ref: ContentRef): Promise<void>;
  materialize(ref: ContentRef, destination: string): Promise<void>;
}

export interface ProducedAssetSet {
  id: string;
  members: {
    role: string;
    path: string;
    mediaType: string;
    destination?: string;
    /** Uninterpreted, harness-declared format details from a named authority. */
    formatMetadata?: { source: string; values: Record<string, unknown> };
  }[];
  relationships?: { from: string; toRole: string; kind: string }[];
  provenance: {
    source: string;
    rights: string;
    visibility: "private" | "repository";
    lineage: string[];
  };
  /** Supplied by the harness or an authoritative tool, when available. */
  production?: {
    model?: string;
    tool?: string;
    request?: unknown;
    parameters?: unknown;
  };
}

export interface CapturedAssetSet {
  id: string;
  /** Literal original declaration shared by every candidate, not reconstructed JSON. */
  manifestRef?: ContentRef;
  inputs?: { binding: SourceAssetBinding; ref: ContentRef }[];
  members: {
    role: string;
    ref: ContentRef;
    destination: string;
    formatMetadata?: { source: string; values: Record<string, unknown> };
  }[];
  relationships?: ProducedAssetSet["relationships"];
  provenance: ProducedAssetSet["provenance"];
  production?: ProducedAssetSet["production"];
  evidence: { harnessIdentity: string; resultDigest: string };
  /**
   * Controller-generated from the imported source identities after every
   * declared member has been verified as a regular file beneath the private
   * media staging root and imported into the content store.
   */
  capture: AssetCaptureReceipt;
}

export interface AssetCaptureReceipt {
  authority: "factory-controller";
  declarationPath?: ".factory-assets.json";
  declarationDigest?: string;
  declarationProvenance?: ProducedAssetSet["provenance"];
  mediaRoot: ".factory-media";
  complete: true;
  setId: string;
  inputs?: {
    binding: {
      kind: NonNullable<SourceAssetBinding["kind"]>;
      path: string;
      role: string;
      mediaType: string;
      visibility: SourceAssetBinding["visibility"];
    };
    ref: ContentRef;
  }[];
  members: {
    role: string;
    stagingPath: string;
    destination: string;
    digest: string;
    bytes: number;
    mediaType: string;
  }[];
}

/** Exact selected LFS bytes that an exact-tree validation must restore locally. */
export interface ValidationLfsMember {
  itemId: string;
  setId: string;
  role: string;
  destination: string;
  digest: string;
  bytes: number;
  mediaType: string;
}

export interface SelectedAssetInput {
  fromItem: string;
  setId: string;
  role: string;
  ref: ContentRef;
  visibility: "private" | "repository";
  destination: string;
  provenance: ProducedAssetSet["provenance"];
  formatMetadata?: ProducedAssetSet["members"][number]["formatMetadata"];
}

export interface AssetSelectionDecision {
  actor: string;
  at: string;
  reason?: string;
  surface?: "factory-cli" | "application";
  destinations: { role: string; path: string; digest: string }[];
  downstreamItems: string[];
}

export interface GraphProjectionEffectRequest {
  id: string;
  key: string;
  method: "POST" | "PATCH" | "DELETE";
  path: string;
  bodyDigest: string;
}
export interface GraphProjectionEffectObservation {
  outcome: "responded" | "reconciled" | "unknown" | "rejected";
  responseDigest?: string;
  status?: number;
  identity?: { id?: number; number?: number; name?: string };
}
export interface GraphProjectionEffect extends GraphProjectionEffectRequest {
  /** Set only after a known pre-transport checkpoint rejection. */
  admission?: "blocked";
  admissionFailures?: { at: string; reason: string }[];
  observation?: GraphProjectionEffectObservation;
  /** Read-only reconciliation never replaces the original transport observation. */
  reconciliation?: GraphProjectionEffectObservation;
}
export interface GraphProjection {
  expansionControl?: {
    effects: GraphProjectionEffect[];
    beforeWrite(effect: GraphProjectionEffectRequest): void | Promise<void>;
    /** Records several exact requests under one checkpoint admission; absent when the snapshot cannot record withdrawn intents. */
    beforeWrites?(effects: GraphProjectionEffectRequest[]): Promise<void>;
    /** Rechecks step admission and projection owner before one batched request is sent; no new checkpoint. */
    beforeSend?(effect: GraphProjectionEffectRequest): void;
    /** Marks admitted requests that were never sent, so only an identical request may admit them again. */
    withdraw?(effectIds: string[], reason: string): void | Promise<void>;
    observed(
      effectId: string,
      receipt: GraphProjectionEffectObservation,
    ): void | Promise<void>;
    /** Acknowledge all locally retained observations before the projection returns or yields on failure. */
    complete(): void | Promise<void>;
  };
  previousGraph?: WorkGraph;
  completedItems?: string[];
  graph: WorkGraph;
  objectiveIssue: number;
  knownIssues?: Record<string, number>;
  /** The login that authored Factory's issues, once known. */
  author?: string;
  /** Learned the author from Factory's first created issue. */
  authored?: (login: string) => void;
  beforeCreate?: (itemId: string) => void | Promise<void>;
  projected?: (itemId: string, issue: number) => void;
}
/** A reviewed split's child Objective issues, created and linked under its parent. */
export interface ChildObjectiveProjection {
  parent: number;
  /** In dependency order: a child's dependencies come before it. */
  children: { key: string; title: string; body: string; dependsOn: string[] }[];
  knownIssues?: Record<string, number>;
  author?: string;
  authored?: (login: string) => void;
  beforeCreate?: (key: string) => void | Promise<void>;
  projected?: (key: string, issue: number) => void;
  control?: GraphProjection["expansionControl"];
}
export interface ProjectedGraph {
  issueByItemId: Record<string, number>;
}
export interface PullRequestPublication {
  /** Persisted unknown/observed requests allow reads only; absence is also read-only. */
  reconcileOnly?: boolean;
  /** One-shot owner callback saves exact intent immediately before the sole POST. */
  beforeCreate?: () => void | Promise<void>;
  /** Exact recorded observation or submitted request metadata during reconciliation. */
  expectedPublication?: { titleDigest: string; bodyDigest: string };
  branch: string;
  base: string;
  /** The commit Factory pushed to `branch`. */
  headSha: string;
  /** Heads earlier attempts pushed to `branch`; a PR may still show one. */
  earlierHeads?: string[];
  treeSha: string;
  title: string;
  body: string;
}
export interface PullRequestIdentity {
  /** Actual authenticated publication context, separate from desired request text. */
  publication?: {
    repository: string;
    baseBranch: string;
    titleDigest: string;
    bodyDigest: string;
    author?: string;
  };
  baseBranch?: string;
  number: number;
  branch: string;
  headSha: string;
  /** Heads earlier attempts pushed to `branch`; a read may still show one. */
  earlierHeads?: string[];
}
export type PullRequestObservation = DeliveryObservation;
export interface IntakeIssuePage {
  status: number;
  etag?: string;
  data?: { number: number; state: "open" | "closed"; labels: string[] }[];
}
/** Explicit authority for an existing Project's two dedicated queue fields. */
export interface ProjectQueueBinding {
  repository: string;
  projectId: string;
  metadataFieldId: string;
  orderFieldId: string;
  controlItemId: string;
  factoryManagedFields: true;
}
export interface ProjectQueueCard {
  itemId: string;
  issueNodeId: string;
  objective: number;
  repository: string;
  title: string;
  state: "open" | "closed";
  body: string;
  order: number | null;
  metadata: string | null;
  archived: boolean;
}
/** Stable lookup hints from authenticated original receipts; never current authority. */
export interface ProjectQueueKnownTarget {
  objective: number;
  issueNodeId: string;
  itemId: string;
}
/** Paginated Project index plus freshly reconciled known Issue memberships, not unseen absence proof. */
export interface ProjectQueueSnapshot {
  binding: ProjectQueueBinding;
  observedAt: string;
  actorId: number;
  owner: string;
  control: { itemId: string; metadata: string | null };
  cards: ProjectQueueCard[];
  ignoredCards: {
    itemId: string;
    kind: "draft" | "foreign-issue" | "pull-request";
    archived: boolean;
  }[];
}
/** Exact current command target; never a complete Project scheduling observation. */
export type ProjectQueueTarget = Omit<
  ProjectQueueCard,
  "title" | "body" | "state"
>;
export interface ProjectQueueInspection {
  scope: "target";
  binding: ProjectQueueBinding;
  observedAt: string;
  actorId: number;
  owner: string;
  control: { itemId: string; metadata: string | null };
  target?: ProjectQueueTarget;
  issue?: Pick<
    ProjectQueueCard,
    "issueNodeId" | "objective" | "repository" | "title" | "body" | "state"
  >;
  /** Complete membership for only the requested Issue in the configured Project. */
  membership?: { itemId: string; archived: boolean }[];
}
export interface ProjectQueueExpectedTarget {
  itemId: string;
  metadata: string | null;
  order?: number | null;
  issueNodeId?: string;
  objective?: number;
}
export type ProjectQueueAction =
  | { action: "ensure-card"; issueNodeId: string }
  | { action: "set-metadata"; itemId: string; metadata: string }
  | {
      action: "set-admission-fields";
      itemId: string;
      order: number;
      metadata: string;
    };
export type ProjectQueueIntent = ProjectQueueAction & {
  binding: ProjectQueueBinding;
  requestId: string;
  actorId: number;
  observedAt: string;
  fieldId?: string;
  /** Exact fixed adapter request retained before the effect, including selection variables. */
  request: { query: string; variables: Record<string, unknown> };
};
/** A generated card identity comes only from the named original ensure receipt. */
export type ProjectQueueItemSelector =
  | { itemId: string }
  | { resultOf: string };
export type ProjectQueuePlannedAction =
  | { action: "ensure-card"; issueNodeId: string }
  | {
      action: "set-metadata";
      target: ProjectQueueItemSelector;
      fieldId: string;
      metadata: string;
    }
  | {
      action: "set-admission-fields";
      target: ProjectQueueItemSelector;
      orderFieldId: string;
      metadataFieldId: string;
      order: number;
      metadata: string;
    };
export type ProjectQueuePlannedEffectInput = ProjectQueuePlannedAction & {
  operationId: string;
  requestId: string;
  actorId: number;
  expectedIssue?: {
    issueNodeId: string;
    objective: number;
    bodyDigest: string;
  };
  /** Initial exact target, or the target in the named validated preceding response. */
  prior: { target: ProjectQueueExpectedTarget | null } | { resultOf: string };
  /** Current control remains exact, including an explicitly planned preceding control write. */
  control: { metadata: string | null } | { resultOf: string };
};
/** Immutable command obligation; it grants no permission to replay an effect. */
export type ProjectQueuePlannedEffect = ProjectQueuePlannedEffectInput & {
  /** Only declared itemId inputs may contain the explicit resultOf selector. */
  request: { query: string; variables: Record<string, unknown> };
};
export type ProjectQueueWriteRequest = ProjectQueueAction & {
  binding: ProjectQueueBinding;
  requestId: string;
  /** Current Issue contents required by admission/publication, never cached approval. */
  expectedIssue?: {
    issueNodeId: string;
    objective: number;
    bodyDigest: string;
  };
  /** Exact operation inspection or unchanged preceding original response, never persisted as authority. */
  observation?: ProjectQueueInspection | ProjectQueueWriteReceipt;
  /** Ephemeral current target proof, rechecked after durable admission. */
  expectedTarget?: ProjectQueueExpectedTarget;
  /** The exact whole-command declaration already retained by the owning controller. */
  plannedEffect?: ProjectQueuePlannedEffect;
  /** Actual validated originals used solely to hydrate declared dependencies. */
  dependencyReceipts?: ProjectQueueWriteReceipt[];
  /** The owner durably retains this exact intent and admits it before transport. */
  beforeWrite(intent: ProjectQueueIntent): void | Promise<void>;
  /** A submitted prior effect permits no further mutation. */
  pending?: ProjectQueueIntent;
};
export interface ProjectQueueWriteReceipt {
  intent: ProjectQueueIntent;
  itemId: string;
  observedAt: string;
  kind: "response" | "existing-read";
  /** The original authenticated GraphQL data, never a later confirmation read. */
  original: unknown;
}
export interface ObjectiveIssue {
  nodeId?: string;
  labels?: string[];
  state?: "open" | "closed";
  body: string;
  title: string;
}
export interface NativeStackLayer {
  pullRequest: number;
  branch: string;
  headSha: string;
}
/** A check run or commit status that ended without success on a PR head. */
export interface FailedCheck {
  name: string;
  /** The check run's conclusion, or the commit status's state. */
  conclusion: string;
  url?: string;
  /** Its failure annotations and job log tail, bounded; repair evidence. */
  excerpt?: string;
}

export interface NamedCheckEvidence {
  id: number;
  headSha: string;
  name: string;
  status: string;
  conclusion: string | null;
  detailsUrl: string;
}

export interface GitHubGateway {
  readonly effectAdmission?: "controller-checkpoint-v1";
  readonly projectionMutationAdmission?: "controller-checkpoint-v1";
  /** One finite owned operation; reuse is private and never grants spending authority. */
  withProjectQueueObservation?<T>(
    binding: ProjectQueueBinding,
    task: () => Promise<T>,
  ): Promise<T>;
  projectQueueRead?(
    binding: ProjectQueueBinding,
    knownTargets?: readonly ProjectQueueKnownTarget[],
  ): Promise<ProjectQueueSnapshot>;
  projectQueueInspect?(
    binding: ProjectQueueBinding,
    request?: { itemId?: string; objective?: number },
  ): Promise<ProjectQueueInspection>;
  projectQueueWrite?(
    request: ProjectQueueWriteRequest,
  ): Promise<ProjectQueueWriteReceipt>;
  projectStatus?(
    request: import("./github-project-state.js").ProjectStatusRequest,
  ): Promise<import("./github-project-state.js").ProjectStatusObservation>;
  /** Read-only: the default Project's Status field and options by name, else undefined. */
  discoverProjectStatus?(discovery: {
    projectId: string;
    reservedFieldIds: string[];
  }): Promise<
    import("./github-project-state.js").GitHubProjectStatusConfig | undefined
  >;
  /** Owned Objective or Work Item progress; an unresolved prior write permits reads only. */
  progressComment?(request: {
    objective: number;
    /** A Work Item's own issue instead of the Objective's. */
    item?: { id: string; issue: number };
    runId: string;
    body: string;
    snapshotId: string;
    pending?: import("./github-progress-state.js").ProgressCommentIntent;
    /** Durable exact intent immediately before the sole POST. */
    beforeWrite: (actorId: number) => void | Promise<void>;
  }): Promise<import("./github-progress-state.js").ProgressCommentIdentity>;
  /**
   * The issue's live status comment: created once (the intent is recorded
   * before the sole POST; an unresolved create is reconciled by reading
   * only) and edited in place afterwards. Returns the settled record.
   */
  liveStatusComment?(request: {
    objective: number;
    item?: { id: string; issue: number };
    runId: string;
    body: string;
    record?: import("./github-progress-state.js").LiveStatusRecord;
    beforeWrite: (actorId: number) => void | Promise<void>;
  }): Promise<import("./github-progress-state.js").LiveStatusRecord>;
  /** Strict protection: GitHub merges the base into the PR from exactly `identity.headSha`; returns the verified new head. */
  updateBranch(
    identity: PullRequestIdentity,
    beforeRequest?: () => Promise<void>,
  ): Promise<string>;
  intakePage?(page: number, etag?: string): Promise<IntakeIssuePage>;
  objectiveDependencies?(number: number): Promise<number[]>;
  namedCheck?(
    headSha: string,
    name: string,
  ): Promise<NamedCheckEvidence | undefined>;
  objective(number: number): Promise<ObjectiveIssue>;
  defaultBranch(): string | Promise<string>;
  closeIssue(
    number: number,
    comment: string,
    expected: {
      body?: string;
      workItem?: { objective: number; id: string };
      /** The login that authored Factory's issues, once known. */
      author?: string;
      /** Close as not planned (a cancelled Objective's Work Item); default completed. */
      reason?: "not_planned";
      /** A cancelled Objective closes only what is still open: an issue already closed is settled. */
      cancellation?: true;
    },
  ): Promise<void>;
  projectGraph(request: GraphProjection): Promise<ProjectedGraph>;
  projectChildObjectives?(
    request: ChildObjectiveProjection,
  ): Promise<Record<string, number>>;
  /** Observe the pushed branch first; create only after its one-shot durable owner callback. */
  publish(request: PullRequestPublication): Promise<PullRequestIdentity>;
  observe(identity: PullRequestIdentity): Promise<PullRequestObservation>;
  merge(
    identity: PullRequestIdentity,
    expectedHead: string,
    control?: MergeControl,
  ): Promise<MergeResult>;
  ensureNativeStack(
    layers: NativeStackLayer[],
    baseBranch: string,
    control?: {
      beforeRequest(): Promise<void>;
      observed(number: number): Promise<void>;
    },
  ): Promise<number>;
  mergeNativeStack(
    layers: NativeStackLayer[],
    baseBranch: string,
    expectedStack: number,
    options: {
      /** The pending merge request an earlier repeat recorded. */
      resumeUuid?: string;
      /** Record a pending merge request before it is polled. */
      beforeRequest?: () => void | Promise<void>;
      onPending: (uuid: string) => void | Promise<void>;
      /** A poll answered: the merge is progressing. */
      progress?: () => void;
      /** Queued without a request to poll: wait for CI, then observe again. */
      queued: (detail: string) => never;
      /**
       * The merge request ended failed: observe the layers again. Throws a
       * CI wait while a required check is pending (#626); returns when the
       * layers are ready, and the failure stands.
       */
      failed?: () => Promise<void>;
    },
  ): Promise<string>;
}

/** Adapter evidence that a model turn ended, even when its returned content is invalid. */
export class CompletedModelInvocationError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "CompletedModelInvocationError";
  }
}
