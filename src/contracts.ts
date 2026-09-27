import type { ControllerCapabilitiesManifest } from "./controller-capabilities.js";

export type Repository = `${string}/${string}`;

export interface SourceAssetBinding {
  /** Omitted kind means a path in the pinned repository checkout. */
  kind?: "repository" | "local" | "github-attachment";
  path: string;
  role: string;
  mediaType: string;
  visibility: "private" | "repository";
}

export interface WorkItem {
  id: string;
  title: string;
  goal: string;
  acceptance: string[];
  nonGoals: string[];
  citations: { path: string; heading?: string }[];
  dependencies: string[];
  ownedPaths: string[];
  resources?: string[];
  validation: {
    command: string;
    provenance: "base-observed" | "source-declared";
    source?: string;
  }[];
  brief: string;
  sourceAssets?: SourceAssetBinding[];
  expectedOutputRoles?: string[];
  minimumAssetSets?: number;
  requiredLfsRoles?: string[];
}

export interface WorkGraph {
  objective: number;
  baseSha: string;
  items: WorkItem[];
}

export type ModelInvocationPhase =
  | "compile"
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

export interface PlanningRequest<T> {
  objective: string;
  baseSha: string;
  sources: { path: string; content: string; heading?: string }[];
  controllerCapabilities: ControllerCapabilitiesManifest;
  controllerCapabilitiesDigest: string;
  schema: unknown;
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
  objective: string;
  baseSha: string;
  sources: { path: string; content: string; heading?: string }[];
  controllerCapabilities: ControllerCapabilitiesManifest;
  controllerCapabilitiesDigest: string;
  graph: WorkGraph;
  commands: PlanCommandAuthorization[];
  finalCommands: string[];
  invocation?: ModelInvocationContext;
}

export interface ValidationCommandReceipt {
  index: number;
  command: string;
  passed: true;
  exitCode: 0;
  treeSha: string;
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

export interface ResultReviewFinding extends ResultReviewCandidate {
  verdict: "pass" | "needs-human" | "refuse";
}

export interface PlanningModel {
  generateStructured<T>(request: PlanningRequest<T>): Promise<T>;
  reviewGraph(request: PlanReviewRequest): Promise<{
    findings: {
      source: string;
      quote: string;
      detail: string;
      question: string;
    }[];
  }>;
  reviewResult?(request: {
    reviewPhase?: "result-review" | "objective-review";
    criteria: string[];
    baseSha: string;
    treeSha: string;
    sources: { path: string; content: string }[];
    change: string;
    commands: ValidationCommandReceipt[];
    evidence?: ResultReviewEvidenceSource[];
    observations?: string;
    invocation?: ModelInvocationContext;
  }): Promise<{
    findings: ResultReviewFinding[];
  }>;
}

export interface ExecutionRequest {
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
  detail?: string;
  authentication?: AuthenticationRequest;
}
export interface ExecutionResult {
  treeSha: string;
  changeRef: string;
  assets?: CapturedAssetSet[];
  evidence?: unknown;
}
export interface ExecutionDriver {
  availableSlots(): Promise<number | "unknown">;
  start(request: ExecutionRequest): Promise<ExecutionHandle>;
  observe(handle: ExecutionHandle): Promise<ExecutionObservation>;
  cancel(handle: ExecutionHandle): Promise<void>;
  collect(handle: ExecutionHandle): Promise<ExecutionResult>;
}

export interface HarnessRequest {
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

export interface SandboxRequest {
  item: WorkItem;
  baseSha: string;
}
export interface SandboxHandle {
  identity: string;
  data?: unknown;
}
export interface SandboxInput {
  path: string;
  digest: string;
}
export interface SandboxCommand {
  command: string;
  cwd?: string;
}
export interface RemoteProcess {
  identity: string;
  data?: unknown;
}
export interface RemoteObservation {
  state: "running" | "complete" | "failed";
  detail?: string;
}
export interface SandboxOutput {
  path: string;
  digest?: string;
}
export interface SandboxProvider {
  create(request: SandboxRequest): Promise<SandboxHandle>;
  upload(handle: SandboxHandle, input: SandboxInput): Promise<void>;
  execute(
    handle: SandboxHandle,
    command: SandboxCommand,
  ): Promise<RemoteProcess>;
  observe(process: RemoteProcess): Promise<RemoteObservation>;
  download(handle: SandboxHandle, output: SandboxOutput): Promise<void>;
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
}
export interface DeliveryResult {
  branch: string;
  pullRequest: number;
  headSha: string;
}
export interface DeliveryObservation {
  state: "open" | "merged" | "closed";
  checks: "pending" | "passing" | "failing";
}
export interface MergeResult {
  integratedSha: string;
}
export interface DeliveryStrategy {
  publish(request: DeliveryRequest): Promise<DeliveryResult>;
  observe(result: DeliveryResult): Promise<DeliveryObservation>;
  merge(result: DeliveryResult): Promise<MergeResult>;
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
  graph: WorkGraph;
  objectiveIssue: number;
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
  number: number;
  branch: string;
  headSha: string;
}
export interface PullRequestObservation {
  state: "open" | "merged" | "closed";
  checks: "pending" | "passing" | "failing";
}
export interface ObjectiveIssue {
  body: string;
  title: string;
}
export interface NativeStackLayer {
  pullRequest: number;
  branch: string;
  headSha: string;
}
export interface GitHubGateway {
  objective(number: number): Promise<ObjectiveIssue>;
  defaultBranch(): string;
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
      onPending: (uuid: string) => void;
      cancelled: () => boolean;
    },
  ): Promise<string>;
}
