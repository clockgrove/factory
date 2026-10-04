import type { ExecutionProfileEnvironment } from "./config.js";
import type { ControllerCapabilitiesManifest } from "./controller-capabilities.js";
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
  /** Read-only proof node; uses the ordinary scheduler without a worker or PR. */
  kind?: "work" | "qa" | "aggregate";
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
  validation: {
    command: string;
    provenance: "base-observed" | "source-declared";
    source?: string;
  }[];
  brief: string;
  /** Exact controller-selected pinned inputs, separate from authored instructions. */
  inputSources?: { path: string; heading?: string; content: string }[];
  sourceAssets?: SourceAssetBinding[];
  expectedOutputRoles?: string[];
  minimumAssetSets?: number;
  requiredLfsRoles?: string[];
}

export interface CoverageObligation {
  criterionId: string;
  source: { path: string; digest: string; text: string };
}

export type CoverageProof =
  | { kind: "result-command" | "integrated-command"; validationIndex: number }
  | { kind: "result-semantic" | "integrated-semantic"; acceptanceIndex: number }
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
    /** Existing prerequisite node, never inferred setup authority. */
    preparedBy: string;
  };
}

export interface RequiredPreIntegrationCheck {
  checkName: string;
  /** Exact pinned source span authorizing this gate, hydrated by the controller. */
  source: { path: string; digest: string; text: string };
}

export interface WorkGraph {
  /** Source-required gates on every ordinary delivery head, separate from final proof. */
  requiredPreIntegrationChecks?: RequiredPreIntegrationCheck[];
  /** Complete Objective-wide mapping from source obligations to executable proof. */
  coverage: AcceptanceCoverage[];
  objective: number;
  baseSha: string;
  items: WorkItem[];
}

export type ModelInvocationPhase =
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
  failureClass?: string;
  failureField?: string;
  failureReason?: string;
  /** Exact supplied source label only; never an invented provider value. */
  failureSource?: string;
  detail?: string;
}

export interface ModelInvocationContext {
  invocationId: string;
  phase: ModelInvocationPhase;
  ordinal: number;
  /** Adapter-owned current provider attempt, exposed for correlated diagnostics. */
  providerAttempt?: number;
  /** Adapter-owned bounded provider-attempt count. */
  providerMaxAttempts?: number;
  observe?: (observation: ModelInvocationObservation) => void;
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

export interface PlanningRequest<T> {
  /** Trusted transient compile input; not part of canonical or persisted graphs. */
  compileContext?: {
    objectiveNumber: number;
    instructions: string;
    previousGraph?: WorkGraph;
    immutableItemIds?: string[];
  };
  prerequisites?: PlanningPrerequisites;
  localExecutables?: PlanningLocalExecutables;
  executionBounds?: PlanningExecutionBounds;
  purpose?: "diagnosis";
  /** Actual decoded rejected graph; null when no canonical graph was produced. */
  rejectedGraph?: WorkGraph | null;
  coverageObligations?: CoverageObligation[];
  /** Check names from the base's workflows and the Objective's Required checks. */
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

export interface PlanReviewRequest {
  prerequisites?: PlanningPrerequisites;
  localExecutables?: PlanningLocalExecutables;
  executionBounds?: PlanningExecutionBounds;
  amendment?: unknown;
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
  /** Check names from the base's workflows and the Objective's Required checks. */
  checkNames?: string[];
  invocation?: ModelInvocationContext;
}

export interface ValidationCommandReceipt {
  index: number;
  command: string;
  passed: true;
  exitCode: 0;
  treeSha: string;
  /**
   * Processes the command left running that Factory stopped once the
   * command had exited and its grace period passed. Absent when none.
   */
  stoppedLeftovers?: number;
}

export interface ResultReviewEvidenceSource {
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

export interface PlanningModel {
  generateStructured<T>(request: PlanningRequest<T>): Promise<T>;
  reviewGraph(
    request: PlanReviewRequest,
  ): Promise<{ packetId: string; findings: GraphReviewFinding[] }>;
  reviewResult?(request: {
    reviewPhase?: "result-review" | "objective-review";
    criteria: string[];
    reviewPacket: ReviewPacket;
    baseSha: string;
    treeSha: string;
    sources: { path: string; content: string }[];
    change: string;
    commands: ValidationCommandReceipt[];
    evidence?: ResultReviewEvidenceSource[];
    observations?: string;
    invocation?: ModelInvocationContext;
  }): Promise<{
    packetId: string;
    findings: ResultReviewFinding[];
  }>;
}

export interface ExecutionRequest {
  captureContext?: { objective: number; runId: string };
  item: WorkItem;
  baseSha: string;
  attemptId?: string;
  sourceAssets?: { binding: SourceAssetBinding; ref: ContentRef }[];
  objectiveBody?: string;
  selectedAssets?: SelectedAssetInput[];
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
  discovery?: WorkDiscovery;
  /** Driver observation during successful original-worktree collection, not continuous retention. */
  collection?: { acceptedIgnoredLinks: string[] };
  treeSha: string;
  changeRef: string;
  assets?: CapturedAssetSet[];
  evidence?: unknown;
}
/** Persist before each external mutation; callbacks are controller-owned, never serialized. */
/** A provider resource a lost response may have created that Factory cannot find to delete. */
export interface ExecutionOrphan {
  resource: string;
  detail: string;
}
export interface ExecutionContext {
  observeUsage?(observation: WorkerUsageObservation): void;
  /** Diagnostic only: records a possible orphan for operator cleanup. */
  observeOrphan?(orphan: ExecutionOrphan): void;
  cancelled(): boolean;
  checkpoint(handle: ExecutionHandle): void;
}

export interface ExecutionDriver {
  preflight?(graph: WorkGraph): Promise<void>;
  availableSlots(): Promise<number | "unknown">;
  start(
    request: ExecutionRequest,
    context?: ExecutionContext,
  ): Promise<ExecutionHandle>;
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
  capture?: {
    context: import("./capture.js").CaptureContext;
    policy?: import("./capture.js").CapturePolicy;
  };
  /** Installation-owned private preparation; never part of the Work Item graph. */
  environment?: ExecutionProfileEnvironment;
  /** Exact Factory-owned worktree. The harness may operate only inside it. */
  item: WorkItem;
  worktree: string;
  attemptId?: string;
  sourceAssets?: {
    binding: SourceAssetBinding;
    ref: ContentRef;
    path?: string;
  }[];
  selectedAssets?: (SelectedAssetInput & { path: string })[];
}
export interface HarnessHandle {
  /** Provider attempt identity, stable across controller restarts. */
  identity: string;
  /** JSON-safe durable data only; no live process, closure, or credential. */
  data?: unknown;
}
export interface HarnessObservation {
  state: "running" | "complete" | "failed" | "cancelled";
  /** Failed only because the worker ended without writing a result; repeat it. */
  interrupted?: boolean;
  detail?: string;
  /** Present when the attempt is paused on a developer-local login. */
  authentication?: AuthenticationRequest;
}
export interface HarnessResult {
  assets?: ProducedAssetSet[];
  evidence?: unknown;
}
export interface AgentHarnessCapabilities {
  protocolVersion: 1;
  worktree: "factory-owned-read-write";
  head: "preserve";
  lifecycle: "restart-safe-durable-handle";
  publication: "controller-only";
  assetSets: true;
  authentication: "local-environment" | "adapter-owned" | "none";
}
export interface AgentHarness {
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
}

/** Infrastructure only; the configured AgentHarness runs in a separate installed process. */
export interface SandboxRequest {
  attemptId: string;
}
export interface SandboxHandle {
  identity: string;
  attemptId: string;
  workspace: string;
  data?: unknown;
}
export interface SandboxInput {
  localPath: string;
  remotePath: string;
  digest: string;
  bytes: number;
}
export interface SandboxCommand {
  argv: string[];
  cwd: string;
}
export interface RemoteProcess {
  identity: string;
  sandboxIdentity: string;
  attemptId: string;
  data?: unknown;
}
export interface RemoteObservation {
  state: "running" | "complete" | "failed" | "cancelled";
  detail?: string;
}
export interface SandboxOutput {
  remotePath: string;
  localPath: string;
}
export interface SandboxRepositoryInput {
  repository: string;
  baseSha: string;
  treeSha: string;
  /** Fetch only these declared LFS sources into workspace/lfs/<index>. Keep repository paths as pointers. */
  lfsSources: { path: string; digest: string; bytes: number }[];
}
export interface SandboxProvider {
  /** This attempt's tagged sandbox, if one exists. Never creates one. */
  find(request: SandboxRequest): Promise<SandboxHandle | undefined>;
  /** Return this attempt's sandbox: adopt the one `find` returns, or create one tagged with the attempt, so a call whose response was lost can repeat. */
  create(request: SandboxRequest): Promise<SandboxHandle>;
  /** Trusted preparation, before any harness runs: fetch exact Git objects into workspace/repo and selected LFS objects into workspace/lfs/<index>. Remove all usable GitHub authentication, credential helpers and auth-bearing remotes before returning. Never put credentials in handles, config, argv or returned data. Failure must not start a harness. */
  prepareRepository(
    handle: SandboxHandle,
    input: SandboxRepositoryInput,
  ): Promise<void>;
  upload(handle: SandboxHandle, input: SandboxInput): Promise<void>;
  execute(
    handle: SandboxHandle,
    command: SandboxCommand,
  ): Promise<RemoteProcess>;
  observe(
    handle: SandboxHandle,
    process: RemoteProcess,
  ): Promise<RemoteObservation>;
  /** Resolve termination of this process and its descendants; uncertainty must throw. */
  cancel(handle: SandboxHandle, process: RemoteProcess): Promise<void>;
  download(
    handle: SandboxHandle,
    output: SandboxOutput,
  ): Promise<{ digest: string; bytes: number }>;
  /** Confirm this owned sandbox and all its processes are absent, including after an earlier destruction; uncertainty must throw. */
  destroy(handle: SandboxHandle): Promise<void>;
}

export interface DeliveryRequest {
  item: WorkItem;
  baseSha: string;
  treeSha: string;
  changeRef: string;
  branch: string;
  baseBranch?: string;
  lfs?: boolean;
  /** Commits earlier attempts of this Work Item produced for this branch. */
  earlierHeads?: string[];
}
export interface DeliveryResult {
  branch: string;
  pullRequest: number;
  headSha: string;
}
export interface DeliveryObservation {
  /** Successful uniquely named check runs observed on this exact PR head. */
  namedChecks?: NamedCheckEvidence[];
  state: "open" | "merged" | "closed";
  checks: "pending" | "passing" | "failing";
  /** Authenticated target protection readiness; absent only on custom gateways. */
  mergeReadiness?: "ready" | "waiting" | "blocked";
}
export interface MergeResult {
  integratedSha: string;
}
export interface DeliveryStrategy {
  publish(request: DeliveryRequest): Promise<DeliveryResult>;
  observe(result: DeliveryResult): Promise<DeliveryObservation>;
  merge(
    result: DeliveryResult,
    beforeMerge?: (observation: DeliveryObservation) => void,
  ): Promise<MergeResult>;
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
   * media staging root and imported into the content store. Older snapshots
   * may not contain this receipt and therefore cannot use it as automatic
   * review evidence.
   */
  capture?: AssetCaptureReceipt;
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

export interface GraphProjection {
  previousGraph?: WorkGraph;
  completedItems?: string[];
  graph: WorkGraph;
  objectiveIssue: number;
  knownIssues?: Record<string, number>;
  beforeCreate?: (itemId: string) => void | Promise<void>;
  projected?: (itemId: string, issue: number) => void;
}
export interface ProjectedGraph {
  issueByItemId: Record<string, number>;
}
export interface PullRequestPublication {
  branch: string;
  base: string;
  treeSha: string;
  title: string;
  body: string;
}
export interface PullRequestIdentity {
  baseBranch?: string;
  number: number;
  branch: string;
  headSha: string;
}
export type PullRequestObservation = DeliveryObservation;
export interface IntakeIssuePage {
  status: number;
  etag?: string;
  data?: { number: number; state: "open" | "closed"; labels: string[] }[];
}
export interface ObjectiveIssue {
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
export interface NamedCheckEvidence {
  id: number;
  headSha: string;
  name: string;
  status: string;
  conclusion: string | null;
  detailsUrl: string;
}

export interface GitHubGateway {
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
    expected: { body?: string; workItem?: { objective: number; id: string } },
  ): Promise<void>;
  projectGraph(request: GraphProjection): Promise<ProjectedGraph>;
  findOpenPullRequest(
    branch: string,
    base: string,
    headSha: string,
  ): Promise<PullRequestIdentity | undefined>;
  publish(request: PullRequestPublication): Promise<PullRequestIdentity>;
  observe(identity: PullRequestIdentity): Promise<PullRequestObservation>;
  merge(
    identity: PullRequestIdentity,
    expectedHead: string,
  ): Promise<MergeResult>;
  ensureNativeStack(
    layers: NativeStackLayer[],
    baseBranch: string,
  ): Promise<number>;
  mergeNativeStack(
    layers: NativeStackLayer[],
    baseBranch: string,
    expectedStack: number,
    options: {
      resumeUuid?: string;
      beforeMerge?: () => void;
      onPending: (uuid: string) => void;
      cancelled: () => boolean;
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

/**
 * A step that did not finish for reasons unrelated to the work itself, such
 * as a lost provider response. Repeating the step is safe.
 */
export class Interruption extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "Interruption";
  }
}
