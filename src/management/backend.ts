import type {
  ObligationInventory,
  CompilerJudgeVerdict,
  CompilerInferenceChallenge,
  CompilerEvidence,
  CompilerCaseLabel,
} from "../evaluation/compiler-eval.js";
import type { LegacyGraphConstraints } from "../graph.js";
import type {
  CompilerProposal,
  CompilerProposalValue,
  CompilerRequest,
  CompilerValidationReport,
} from "../compiler/contracts.js";
import type {
  CompilerAssetManifestView,
  CompilerMediaProducerCapability,
} from "../assets/media-intent.js";
import type { WorkerAssetInput } from "../assets/contracts.js";
import type { CompilerProjectionContext, CompilerProjectionTrace } from "../compiler/proposal.js";
import type { CompilerJudgeCandidate } from "../compiler/judge-context.js";
import type { NormalizedArtifact } from "../execution/artifacts.js";
import type { WorkerPacket } from "../protocol/worker-packet.js";
import type { ValidationEvidence } from "../validation/evidence.js";
import type { ModelSelection, RunPolicy } from "../protocol/policy.js";
import type { CompilerWorkItem, DecompositionEvidence } from "../compiler/index.js";
import type { PinnedLfsFacts } from "../repository-profiles/git-lfs.js";
import type { PinnedCompilationTreeProof } from "../execution/pinned-compilation-tree.js";
import type { ProviderQuotaCheckpoint } from "../providers/quota.js";
import type { FindingCandidate } from "../protocol/findings.js";
import type { RepositoryCaptureReviewerCapability } from "../validation/repository-capture.js";

export interface RepositoryCaptureReviewFile {
  kind: "expected" | "observed";
  descriptorDigest: string;
  digest: string;
  bytes: number;
  mediaType: string;
  sourceName: string;
  handlerId: string;
  handlerContract: number;
  profileIds: string[];
  path: string;
  recipeIds: string[];
  outputRole: string | null;
}

export interface RepositoryCaptureReviewBundle {
  validationInvocationDigest: string;
  evidenceDigest: string;
  root: string;
  files: RepositoryCaptureReviewFile[];
}

export interface ManagementUsage {
  inputTokens: number;
  outputTokens: number;
  /** Provider-reported subset of inputTokens; absence means unavailable. */
  cachedInputTokens?: number | undefined;
}

export interface ManagementTerminalOutcome {
  state: "succeeded" | "provider-failed" | "invalid-response";
  usage: ManagementUsage | null;
}

const managementFailureAuthorities = new WeakMap<
  object,
  {
    terminalOutcome?: ManagementTerminalOutcome;
    provenance?: CompilerInvocationProvenance;
  }
>();

/** Preserve provider-owned objects, but make primitive rejections attachable and recoverable. */
export function attachableManagementFailure(error: unknown): object {
  if ((typeof error === "object" && error !== null) || typeof error === "function") return error;
  return new Error(String(error), { cause: error });
}

export function managementFailureDiagnostic(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  )
    return error.message;
  return String(error);
}

/** Retain only complete, exact counters exposed by an existing provider failure object. */
export function managementFailureUsage(error: unknown): ManagementUsage | undefined {
  if (typeof error !== "object" || error === null || !("usage" in error)) return undefined;
  const usage = error.usage;
  if (typeof usage !== "object" || usage === null) return undefined;
  if (
    !("inputTokens" in usage) ||
    !Number.isSafeInteger(usage.inputTokens) ||
    Number(usage.inputTokens) < 0 ||
    !("outputTokens" in usage) ||
    !Number.isSafeInteger(usage.outputTokens) ||
    Number(usage.outputTokens) < 0
  )
    return undefined;
  const cached = "cachedInputTokens" in usage ? usage.cachedInputTokens : undefined;
  if (
    cached !== undefined &&
    (!Number.isSafeInteger(cached) ||
      Number(cached) < 0 ||
      Number(cached) > Number(usage.inputTokens))
  )
    return undefined;
  return {
    inputTokens: Number(usage.inputTokens),
    outputTokens: Number(usage.outputTokens),
    ...(cached === undefined ? {} : { cachedInputTokens: Number(cached) }),
  };
}

/** Bind the structured adapter's observed terminal state without changing its public error type. */
export function bindManagementTerminalOutcome(
  error: unknown,
  outcome: ManagementTerminalOutcome,
): object {
  const normalized = attachableManagementFailure(error);
  managementFailureAuthorities.set(normalized, {
    ...managementFailureAuthorities.get(normalized),
    terminalOutcome: structuredClone(outcome),
  });
  return normalized;
}

export function managementTerminalOutcome(error: unknown): ManagementTerminalOutcome | null {
  if ((typeof error !== "object" || error === null) && typeof error !== "function") return null;
  const outcome = managementFailureAuthorities.get(error)?.terminalOutcome;
  return outcome ? structuredClone(outcome) : null;
}

/** A paid response was observed but could not become a valid management result. */
export class ManagementOutputError extends Error {
  readonly usage: ManagementUsage;
  readonly proposal: unknown;

  constructor(cause: unknown, usage: ManagementUsage, proposal?: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "ManagementOutputError";
    this.usage = { ...usage };
    this.proposal = proposal;
  }
}

/** A paid output was observed, but its isolated provider home could not be proven removed. */
export class ManagementCleanupError extends ManagementOutputError {
  readonly provenance: CompilerInvocationProvenance | undefined;
  readonly cleanupDiagnostic: string;

  constructor(
    cause: unknown,
    usage: ManagementUsage,
    proposal: unknown,
    provenance?: CompilerInvocationProvenance,
  ) {
    const cleanupError = attachableManagementFailure(cause);
    super(cleanupError, usage, proposal);
    this.name = "ManagementCleanupError";
    this.message = "management provider output cleanup is unresolved";
    this.provenance = provenance ? { ...provenance } : undefined;
    this.cleanupDiagnostic = managementFailureDiagnostic(cleanupError);
  }
}

/** A provider terminal failure and a later cleanup failure are separate durable facts. */
export class ManagementFailureCleanupError extends Error {
  readonly primaryError: object;
  readonly cleanupError: object;
  readonly providerDiagnostic: string;
  readonly cleanupDiagnostic: string;
  readonly usage?: ManagementUsage;
  readonly proposal?: unknown;

  constructor(primary: unknown, cleanup: unknown) {
    const primaryError = attachableManagementFailure(primary);
    const cleanupError = attachableManagementFailure(cleanup);
    const providerDiagnostic = managementFailureDiagnostic(primaryError);
    const cleanupDiagnostic = managementFailureDiagnostic(cleanupError);
    super(providerDiagnostic, {
      cause: new AggregateError(
        [primaryError, cleanupError],
        "management provider failure and isolated-home cleanup both failed",
      ),
    });
    this.name = "ManagementFailureCleanupError";
    this.primaryError = primaryError;
    this.cleanupError = cleanupError;
    this.providerDiagnostic = providerDiagnostic;
    this.cleanupDiagnostic = cleanupDiagnostic;
    const usage = managementFailureUsage(primaryError);
    if (usage) this.usage = usage;
    if ("proposal" in primaryError) this.proposal = primaryError.proposal;
  }
}

export interface CompilationContext {
  repository: string;
  objective: { number: number; title: string; body: string };
  defaultBranch: string;
  baseSha: string;
  repositoryFiles: string[];
  /** Unforgeable in-process proof that repository is an active Factory-owned exact-base tree. */
  pinnedCompilationTree?: PinnedCompilationTreeProof;
  repositoryLfs?: PinnedLfsFacts;
  allowedNetworkDestinations: string[];
  /** Exact immutable policy activated for this compilation. */
  runPolicy: RunPolicy;
  modelSelection?: ModelSelection;
  /** Remaining per-invocation operation-stall bound, capped by immutable policy
   * and the Objective deadline; not a hard provider token cap. */
  invocationTimeoutMs?: number;
  /** Trusted pinned source evidence captured once for the draft envelope. */
  repositoryEvidence?: CompilerEvidence[];
  /** Immutable Objective assets are described textually by opaque IDs. Verified media paths and
   * types are delivered separately to an adapter that declares those exact input media types. */
  mediaPlanning?: {
    assetManifest: CompilerAssetManifestView | null;
    mediaInputs: Array<{ assetId: string; mediaType: string; path: string }>;
    assetBindings: Array<{ assetId: string; input: WorkerAssetInput }>;
    assetEgress: {
      mode: "denied" | "public-assets" | "private-assets";
      policyDigest: string;
    };
    producerCapabilities: CompilerMediaProducerCapability[];
    reviewRules: CompilerRequest["media"]["reviewRules"];
  };
  /** Authenticated pre-v2 issue core. The compiler may enrich, never decompose or rewrite it. */
  legacyGraphConstraints?: LegacyGraphConstraints;
  /** Authenticated predecessor terminal diagnostic for a graphless compilation recovery.
   * The predecessor proposal is deliberately unavailable and grants no graph authority. */
  priorCompilationFailure?: {
    reason: string;
    rawProposalAvailable: false;
  };
  /** Read-only trusted observations after grounding; omitted callers retain explicit unknowns. */
  economicEvidence?: (items: readonly CompilerWorkItem[]) => Promise<DecompositionEvidence>;
}

/** A compiler request and its projection policy must derive network authority from one source. */
export function assertCompilationContextPolicyAuthority(context: CompilationContext): void {
  const requested = [...context.allowedNetworkDestinations].sort();
  const policy = [...context.runPolicy.allowedNetworkDestinations].sort();
  if (JSON.stringify(requested) !== JSON.stringify(policy))
    throw new Error("compilation context network authority differs from run policy");
}

export interface CompilerInvocationProvenance {
  promptDigest: string;
  schemaDigest: string;
  model: string | null;
  reasoning: string | null;
  baseSha: string;
  assetManifestDigest?: string;
  mediaEgressDigest?: string;
}

/** Bind authoritative invocation provenance without requiring a mutable provider-owned error. */
export function bindManagementFailureProvenance(
  error: unknown,
  provenance: CompilerInvocationProvenance,
): object {
  const normalized = attachableManagementFailure(error);
  const retained = { ...provenance };
  managementFailureAuthorities.set(normalized, {
    ...managementFailureAuthorities.get(normalized),
    provenance: retained,
  });
  try {
    if (Object.isExtensible(normalized)) Object.assign(normalized, { provenance: { ...retained } });
  } catch {
    // The WeakMap is authoritative when a provider object rejects mutation.
  }
  return normalized;
}

/** Recover bound provenance through Factory-owned wrappers without trusting mutation support. */
export function managementFailureProvenance(error: unknown): CompilerInvocationProvenance | null {
  const seen = new Set<unknown>();
  let current = error;
  while (
    ((typeof current === "object" && current !== null) || typeof current === "function") &&
    !seen.has(current)
  ) {
    seen.add(current);
    const bound = managementFailureAuthorities.get(current)?.provenance;
    if (bound) return { ...bound };
    try {
      if ("provenance" in current && current.provenance && typeof current.provenance === "object")
        return { ...(current.provenance as CompilerInvocationProvenance) };
      current = "cause" in current ? current.cause : null;
    } catch {
      return null;
    }
  }
  return null;
}

export interface CompilerProposalProvenance extends CompilerInvocationProvenance {
  requestDigest: string;
}

export interface CompilerProposalResult {
  request: CompilerRequest;
  proposal: CompilerProposalValue;
  report: CompilerValidationReport;
  provenance: CompilerProposalProvenance;
  usage: ManagementUsage;
}
export interface CompilerWorkItemsProposalResult extends CompilerProposalResult {
  proposal: CompilerProposal;
}
export type CompilerProposalCheckpoint = (result: CompilerProposalResult) => Promise<void>;

export interface ObligationResult {
  inventory: ObligationInventory;
  provenance: CompilerInvocationProvenance;
  usage: ManagementUsage;
}
export type ObligationCheckpoint = (result: ObligationResult) => Promise<void>;
export interface ObligationRepairContext {
  revision: number;
  validationReport: CompilerValidationReport;
  previousProposal: unknown;
}
export interface PlanJudgeContext {
  challenges?: CompilerInferenceChallenge[];
  compilation: CompilationContext;
  inventory: ObligationInventory;
  proposal: CompilerJudgeCandidate;
  projectionTrace: CompilerProjectionTrace;
  graphDigest: string;
}
export interface PlanJudgeResult {
  verdict: CompilerJudgeVerdict;
  provenance: CompilerInvocationProvenance;
  usage: ManagementUsage;
}
export type PlanJudgeCheckpoint = (result: PlanJudgeResult) => Promise<void>;
export interface CompilerCaseLabelContext {
  compilation: CompilationContext;
  caseDigest: string;
  pass: "blinded" | "adjudication";
  priorLabel?: CompilerCaseLabel;
}
export interface CompilerCaseLabelResult {
  provenance: {
    promptDigest: string;
    schemaDigest: string;
    sourceDigest: string;
    baseSha: string;
    requestedModel: string | null;
    requestedReasoning: string | null;
    providerReportedModel: null;
    priorLabelDigest: string | null;
  };
  label: CompilerCaseLabel;
  usage: ManagementUsage;
}
export type CompilerCaseLabelCheckpoint = (result: CompilerCaseLabelResult) => Promise<void>;
export interface SemanticReview {
  accepted: boolean;
  summary: string;
  unmetCriteria: string[];
  risks: string[];
  findings?: FindingCandidate[] | undefined;
}

export interface ReviewContext {
  /** Source object repository. Filesystem-consuming backends must prepare the
   * exact artifact/evidence tree; this mutable checkout is not review evidence. */
  repository: string;
  objectiveNumber: number;
  workItemNumber: number;
  packet: WorkerPacket;
  artifact: NormalizedArtifact;
  evidence: ValidationEvidence;
  repositoryCaptureBundle?: RepositoryCaptureReviewBundle;
  publicationBaseBranch?: string;
  modelSelection?: ModelSelection;
  /** Remaining per-invocation operation-stall bound for legacy review adapters.
   * Implementations with reviewWithAdmission clamp its fresher final-boundary
   * callback by this bound. */
  invocationTimeoutMs?: number;
  /** Includes current/source policy and inherited execution isolation. Packet
   * trust remains independently authoritative, including for legacy callers. */
  requiresIsolation?: boolean;
}

export interface ReviewResult {
  review: SemanticReview;
  usage: ManagementUsage;
}

/** Same paid-result durability boundary as Objective compilation. */
export type ReviewCheckpoint = (result: ReviewResult) => Promise<void>;

/** Called once after local preparation, immediately before dispatch; may return remaining timeout milliseconds. */
export interface CompilerModelAdmissionReceipt {
  timeoutMs?: number;
  modelInvocationId: string;
  /**
   * A bounded provider refusal is a terminal result of this exact paid
   * invocation. The adapter must await this owner-supplied durability port
   * before it exposes the refusal or begins fallible local cleanup.
   */
  checkpointProviderRefusal: ProviderQuotaCheckpoint;
}
export type CompilerModelAdmission = (
  expectedProvenance?: CompilerInvocationProvenance,
) => Promise<number | void | CompilerModelAdmissionReceipt>;
export interface ManagementBackend {
  /** Required for evaluated drafts; older backends must not silently ignore admission. */
  readonly supportsCompilerAdmission?: true;
  /** Exact media types the adapter can carry separately from the textual compiler request. */
  readonly compilerInputMediaTypes?: readonly string[];
  readonly repositoryCaptureReviewerCapability?: RepositoryCaptureReviewerCapability | undefined;
  readonly id: string;
  probe(): Promise<{ available: boolean; authenticated: boolean; reason?: string }>;
  proposePlan(
    request: CompilerRequest,
    checkpoint: CompilerProposalCheckpoint,
    projection: CompilerProjectionContext,
    beforeModelInvocation?: CompilerModelAdmission,
    execution?: CompilationContext,
  ): Promise<CompilerProposalResult>;
  /** Draft-stage calls share the compile accounting/checkpoint boundary. Legacy backends
   * may omit them; callers must refuse judge-enabled compilation when unavailable. */
  labelCompilerCase?(
    context: CompilerCaseLabelContext,
    checkpoint: CompilerCaseLabelCheckpoint,
  ): Promise<CompilerCaseLabelResult>;
  extractObligations?(
    context: CompilationContext,
    checkpoint: ObligationCheckpoint,
    beforeModelInvocation?: CompilerModelAdmission,
    repair?: ObligationRepairContext,
  ): Promise<ObligationResult>;
  judgePlan?(
    context: PlanJudgeContext,
    checkpoint: PlanJudgeCheckpoint,
    beforeModelInvocation?: CompilerModelAdmission,
  ): Promise<PlanJudgeResult>;
  review(context: ReviewContext, checkpoint: ReviewCheckpoint): Promise<ReviewResult>;
  /** Optional local preparation boundary. The backend must call the admission
   * callback exactly once immediately before paid invocation dispatch, after
   * non-model preparation, and use its returned remaining timeout. */
  reviewWithAdmission?(
    context: ReviewContext,
    checkpoint: ReviewCheckpoint,
    beforeModelInvocation: CompilerModelAdmission,
  ): Promise<ReviewResult>;
}
/** A durable model result does not prove its private review checkout was removed. */
export class ReviewCheckoutCleanupError extends Error {
  readonly usage: ManagementUsage | undefined;

  constructor(cause: unknown, reviewFailure?: unknown) {
    super("semantic review private checkout cleanup is unresolved", { cause });
    this.name = "ReviewCheckoutCleanupError";
    this.usage =
      reviewFailure instanceof ManagementOutputError ? { ...reviewFailure.usage } : undefined;
  }
}
