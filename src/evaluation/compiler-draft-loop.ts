import { z } from "zod";
import {
  assertNoSecretMaterial,
  assertWithinBytes,
  boundedText,
  safeId,
} from "../protocol/limits.js";
import {
  compiledGraphDigest,
  parsePersistedCompiledObjective,
  type CompiledObjective,
} from "../graph.js";
import type { CompilerProposal, CompilerValidationReport } from "../compiler/contracts.js";
import { CompilerProposalSchema, CompilerValidationReportSchema } from "../compiler/contracts.js";
import { CompilerInvariantError } from "../compiler/invariant-error.js";
import type { CompilerProjectionTrace } from "../compiler/proposal.js";
import {
  compilerJudgeCandidateFromCompiled,
  type CompilerJudgeCandidate,
} from "../compiler/judge-context.js";
import {
  type CompilerDraftManager,
  CompilerDraftReservationConflictError,
  draftDigest,
  type CompilerDraftBinding,
  type CompilerDraftRecord,
} from "../control/compiler-drafts.js";
import type { LeaseState } from "../control/lease.js";
import { ProviderQuotaError } from "../providers/quota.js";
import { CompilerDraftStopError } from "./compiler-draft-errors.js";
export { CompilerDraftStopError } from "./compiler-draft-errors.js";

function diagnostic(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  try {
    assertNoSecretMaterial(text, "compiler diagnostic");
    return text.slice(0, 4000);
  } catch {
    return "diagnostic withheld: suspected secret material";
  }
}
function safeProposal(error: unknown): Record<string, unknown> {
  if (
    typeof error !== "object" ||
    error === null ||
    !("proposal" in error) ||
    error.proposal === undefined
  )
    return {};
  try {
    assertWithinBytes(error.proposal, 512 * 1024, "compiler proposal");
    assertNoSecretMaterial(error.proposal, "compiler proposal");
    return { proposal: error.proposal };
  } catch {
    return { proposalUnavailable: "unsafe or oversized proposal" };
  }
}
function safeValidationReport(error: unknown): CompilerValidationReport | null {
  if (typeof error !== "object" || error === null || !("validationReport" in error)) return null;
  return CompilerValidationReportSchema.safeParse(error.validationReport).data ?? null;
}
const TimestampSchema = z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER);

const UsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    outputTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    cachedInputTokens: z.number().int().nonnegative().optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.cachedInputTokens === undefined || value.cachedInputTokens <= value.inputTokens,
  );
const CompilerInvocationProvenanceSchema = z
  .object({
    promptDigest: z.string().regex(/^[0-9a-f]{64}$/),
    schemaDigest: z.string().regex(/^[0-9a-f]{64}$/),
    baseSha: z.string().regex(/^[0-9a-f]{40,64}$/),
    model: z.string().min(1).max(200).nullable(),
    reasoning: z.string().min(1).max(200).nullable(),
  })
  .strict();
const ProviderQuotaCheckpointSchema = z
  .object({
    reasonCode: z.literal("provider-quota-exhausted"),
    provider: safeId,
    message: boundedText(320),
    actionUrl: z
      .string()
      .url()
      .max(2_048)
      .refine((value) => value.startsWith("https://"), "provider action URL must use HTTPS")
      .optional(),
  })
  .strict();
const RepairableInvalidClaimsSchema = z
  .object({
    kind: z.literal("deterministic-obligation-claims-validation-v1"),
    proposalDigest: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type DraftUsage = z.infer<typeof UsageSchema>;
/** Admission failed before provider dispatch; absence of provider usage is not a failed paid call. */
export class CompilerDraftAdmissionError extends Error {
  constructor(cause: unknown) {
    super("compiler invocation admission failed", { cause });
  }
}
class CompilerDraftAccountingError extends Error {}

export function repairableInvalidClaimsEvidence(proposal: unknown) {
  return {
    kind: "deterministic-obligation-claims-validation-v1" as const,
    proposalDigest: draftDigest(proposal),
  };
}

function retainedRepairableInvalidClaims(
  payload: Record<string, unknown>,
): z.infer<typeof RepairableInvalidClaimsSchema> | null {
  const parsed = RepairableInvalidClaimsSchema.safeParse(payload.repairableInvalidClaims);
  if (
    !parsed.success ||
    payload.proposal === undefined ||
    parsed.data.proposalDigest !== draftDigest(payload.proposal)
  )
    return null;
  return parsed.data;
}

export type DraftStage = "inventory" | "compile" | "repair" | "judge";
export interface ValidatedCompilerDraft {
  proposal: CompilerJudgeCandidate;
  objective: CompiledObjective;
  projectionTrace: CompilerProjectionTrace;
  report: CompilerValidationReport;
  requestDigest: string;
}
export interface DraftInvocation {
  invocationId: string;
  stage: DraftStage;
  revision: number;
  inventory: unknown;
  previous: CompilerJudgeCandidate | null;
  projection: CompilerProjectionTrace | null;
  failure: unknown;
  reviewEvidence?: unknown;
}
export interface DraftInvocationResult {
  value: unknown;
  usage: DraftUsage | null;
  provenance?: z.infer<typeof CompilerInvocationProvenanceSchema>;
}
export interface DraftReservationEvidence {
  compilerRequestDigest?: string;
  expectedProvenance?: z.infer<typeof CompilerInvocationProvenanceSchema>;
}
export interface CompilerDraftCallbacks {
  /** Admission and provider call use the same immutable invocation ID. */
  invoke(
    request: DraftInvocation,
    checkpoint: (result: DraftInvocationResult) => Promise<void>,
    reserve?: (evidence?: DraftReservationEvidence) => Promise<void>,
    checkpointProviderRefusal?: (error: ProviderQuotaError) => Promise<void>,
  ): Promise<DraftInvocationResult>;
  /** Prepare locally before recording a possible paid invocation. */
  reserveAtDispatch?: boolean;
  /** Must be idempotent by invocation ID; replay reconciles usage before any new admission. */
  recordUsage(invocationId: string, stage: DraftStage, usage: DraftUsage): Promise<void>;
  validateInventory(value: unknown): unknown | Promise<unknown>;
  /** Re-run mechanical grounding against the pinned context, even after restart. */
  validate(
    value: unknown,
    revision: number,
    compilerRequestDigest?: string,
  ): ValidatedCompilerDraft | Promise<ValidatedCompilerDraft>;
  /** Parse full-coverage judge evidence and enforce its exact graph/inventory binding. */
  accept(
    value: unknown,
    draft: ValidatedCompilerDraft,
    inventory: unknown,
    reviewEvidence?: unknown,
  ): boolean;
  /** Narrow cited challenges only; compiler private reasoning is never judge evidence. */
  reviewEvidence?(
    candidate: unknown,
    priorFailure: unknown,
    inventory: unknown,
    priorReviewEvidence: unknown,
  ): unknown;
}
export interface CompilerDraftLimits {
  maxRepairs?: number;
  maxInvocations?: number;
  maxObservedTokens?: number;
  deadlineMs?: number;
}
export type CompilerDraftOutcome =
  | {
      status: "accepted";
      graph: CompiledObjective;
      graphDigest: string;
      revision: number;
      records: CompilerDraftRecord[];
    }
  | { status: "stopped"; reason: string; records: CompilerDraftRecord[] };
const LimitsSchema = z
  .object({
    maxRepairs: z.number().int().min(0).max(2),
    maxInvocations: z.number().int().min(1).max(7),
    maxObservedTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    deadlineMs: z.number().int().positive().max(86_400_000),
  })
  .strict();

const DraftStageSchema = z.enum(["inventory", "compile", "repair", "judge"]);
const DraftAdapterModeSchema = z.enum(["local", "provider"]);

/** Pure grammar check for the whole immutable chain. It must run before replay causes effects. */
export function validateCompilerDraftJournal(
  records: readonly CompilerDraftRecord[],
  expected: {
    binding: CompilerDraftBinding;
    limits: z.infer<typeof LimitsSchema>;
    sourceEvidence: unknown;
    fixedGraph?: CompiledObjective;
    adapterMode: z.infer<typeof DraftAdapterModeSchema>;
  },
): void {
  if (expected.fixedGraph && expected.limits.maxRepairs !== 0)
    throw new Error("fixed historical graph requires zero repairs");
  if (records.length === 0) return;
  const sourceEvidenceDigest = draftDigest(expected.sourceEvidence);
  const fixedGraphDigest = expected.fixedGraph ? compiledGraphDigest(expected.fixedGraph) : null;
  const first = records[0];
  if (
    first?.kind !== "started" ||
    first.sequence !== 0 ||
    draftDigest(first.binding) !== draftDigest(expected.binding) ||
    draftDigest(first.payload.limits) !== draftDigest(expected.limits) ||
    !TimestampSchema.safeParse(first.payload.startedAt).success ||
    first.payload.sourceEvidenceDigest !== sourceEvidenceDigest ||
    first.payload.fixedGraphDigest !== fixedGraphDigest ||
    first.payload.adapterMode !== expected.adapterMode
  )
    throw new Error("compiler draft policy changed");

  let cursor = 1;
  if (expected.sourceEvidence !== null) {
    const source = records[cursor];
    if (!source) return;
    if (
      source.kind !== "source-evidence" ||
      source.payload.sourceEvidenceDigest !== sourceEvidenceDigest ||
      draftDigest(source.payload.sourceEvidence) !== sourceEvidenceDigest
    )
      throw new Error("compiler draft source evidence changed");
    cursor += 1;
  }
  if (expected.fixedGraph) {
    const fixed = records[cursor];
    if (!fixed) return;
    if (
      fixed.kind !== "fixed-graph" ||
      fixed.payload.fixedGraphDigest !== fixedGraphDigest ||
      compiledGraphDigest(parsePersistedCompiledObjective(fixed.payload.fixedGraph)) !==
        fixedGraphDigest
    )
      throw new Error("compiler draft fixed graph changed");
    cursor += 1;
  }

  const invocations = new Map<string, CompilerDraftRecord>();
  const results = new Map<string, CompilerDraftRecord>();
  const validations = new Map<number, CompilerDraftRecord>();
  const failures = new Map<number, CompilerDraftRecord>();
  const reconciledFailures = new Set<number>();
  const proposalResults = new Map<number, CompilerDraftRecord>();
  const judgeResults = new Map<number, CompilerDraftRecord>();
  const isProviderProposalIntent = (intent: CompilerDraftRecord): boolean =>
    expected.adapterMode === "provider" &&
    (intent.payload.stage === "compile" || intent.payload.stage === "repair");
  const retainedProposal = (result: CompilerDraftRecord): unknown =>
    result.payload.error
      ? result.payload.proposal
      : (result.payload.value as { proposal?: unknown } | undefined)?.proposal;
  const failedResultEvidence = (result: CompilerDraftRecord): Record<string, unknown> => ({
    error: String(result.payload.error),
    ...(result.payload.proposal === undefined ? {} : { proposal: result.payload.proposal }),
    ...(result.payload.validationReport === undefined
      ? {}
      : { validationReport: result.payload.validationReport }),
  });
  let inventoryResult: CompilerDraftRecord | undefined;
  let nextInventoryRevision = 0;
  let terminal: CompilerDraftRecord | undefined;
  for (let index = cursor; index < records.length; index++) {
    const record = records[index]!;
    if (record.sequence !== index || draftDigest(record.binding) !== draftDigest(expected.binding))
      throw new Error("compiler draft inputs changed");
    if (record.kind === "source-evidence" || record.kind === "fixed-graph")
      throw new Error("compiler draft has misplaced source evidence");
    if (terminal) throw new Error("compiler draft contains records after its terminal state");
    if (
      [...failures.keys()].some((sequence) => !reconciledFailures.has(sequence)) &&
      record.kind !== "accounting-reconciled"
    )
      throw new Error("compiler draft has unresolved accounting failure before progression");

    if (record.kind === "invocation") {
      const stage = DraftStageSchema.parse(record.payload.stage);
      const revision = z.number().int().min(0).max(2).parse(record.payload.revision);
      const invocationId = safeId.parse(record.payload.invocationId);
      if (
        invocationId !== `compiler-${draftDigest({ binding: expected.binding, stage, revision })}`
      )
        throw new Error("compiler invocation identity is not deterministic");
      if (
        (stage === "compile" && revision !== 0) ||
        (stage === "repair" && revision === 0) ||
        typeof record.payload.inputDigest !== "string" ||
        !/^[a-f0-9]{64}$/.test(record.payload.inputDigest)
      )
        throw new Error("compiler invocation stage or revision is invalid");
      if (invocations.has(invocationId)) throw new Error("duplicate compiler invocation identity");
      if ([...invocations.keys()].some((id) => !results.has(id)))
        throw new Error("compiler invocation overlaps an unresolved predecessor");
      TimestampSchema.parse(record.payload.startedAt);
      if (record.payload.expectedProvenance !== undefined) {
        const provenance = CompilerInvocationProvenanceSchema.parse(
          record.payload.expectedProvenance,
        );
        if (provenance.baseSha !== expected.binding.baseSha)
          throw new Error("compiler invocation provenance base differs");
      }
      if (stage === "inventory") {
        if (inventoryResult || revision !== nextInventoryRevision)
          throw new Error("compiler inventory lifecycle is out of order");
        const priorInventory = [...results.values()].find(
          (candidate) =>
            candidate.payload.stage === "inventory" && candidate.payload.revision === revision - 1,
        );
        const failure =
          revision === 0
            ? null
            : priorInventory
              ? {
                  error: String(priorInventory.payload.error),
                  proposal: priorInventory.payload.proposal,
                }
              : undefined;
        if (failure === undefined)
          throw new Error("compiler inventory repair lacks its prior failure");
        const expectedInputDigest = draftDigest({
          inventory: null,
          previous: null,
          projection: null,
          failure,
        });
        if (record.payload.inputDigest !== expectedInputDigest)
          throw new Error("compiler inventory input digest differs");
      } else {
        if (!inventoryResult) throw new Error("compiler proposal lifecycle precedes inventory");
        if (stage === "compile") {
          if (expected.fixedGraph || proposalResults.size || validations.size)
            throw new Error("compiler compile lifecycle is out of order");
          const expectedInputDigest = draftDigest({
            inventory: inventoryResult.payload.value,
            previous: null,
            projection: null,
            failure: null,
          });
          if (record.payload.inputDigest !== expectedInputDigest)
            throw new Error("compiler compile input digest differs");
        } else if (stage === "repair") {
          const priorRevision = revision - 1;
          const priorProposal = proposalResults.get(priorRevision);
          const priorValidation = validations.get(priorRevision);
          if (
            expected.fixedGraph ||
            !priorProposal ||
            (!priorProposal.payload.error &&
              (!priorValidation ||
                (priorValidation.payload.valid === true && !judgeResults.has(priorRevision))))
          )
            throw new Error("compiler repair lifecycle is out of order");
          const priorJudge = judgeResults.get(priorRevision);
          const priorJudgeIntent = priorJudge
            ? invocations.get(String(priorJudge.payload.invocationId))
            : undefined;
          const priorFailure = priorJudge
            ? priorJudge.payload.error
              ? { error: String(priorJudge.payload.error) }
              : priorJudge.payload.value
            : priorProposal.payload.error
              ? failedResultEvidence(priorProposal)
              : priorValidation?.payload.failure;
          const previous = retainedProposal(priorProposal);
          const priorProposalIntent = invocations.get(String(priorProposal.payload.invocationId));
          if (priorProposalIntent && isProviderProposalIntent(priorProposalIntent)) {
            if (priorFailure === undefined)
              throw new Error("compiler repair lacks its exact prior failure");
            let latestProposal: CompilerProposal | null = null;
            for (
              let candidateRevision = 0;
              candidateRevision <= priorRevision;
              candidateRevision++
            ) {
              const retained = proposalResults.get(candidateRevision);
              if (!retained) continue;
              const parsed = CompilerProposalSchema.safeParse(retainedProposal(retained));
              if (parsed.success) latestProposal = parsed.data;
            }
            const reviewEvidence = priorJudgeIntent?.payload.reviewEvidence ?? null;
            const expectedInputDigest = draftDigest({
              inventory: inventoryResult.payload.value,
              previous: latestProposal,
              projection: null,
              failure: priorFailure,
              ...(reviewEvidence === null ? {} : { reviewEvidence }),
            });
            if (record.payload.inputDigest !== expectedInputDigest)
              throw new Error("compiler repair input digest differs");
          } else if (priorFailure !== undefined && previous !== undefined) {
            const reviewEvidence = priorJudgeIntent?.payload.reviewEvidence ?? null;
            const expectedInputDigest = draftDigest({
              inventory: inventoryResult.payload.value,
              previous,
              projection: null,
              failure: priorFailure,
              ...(reviewEvidence === null ? {} : { reviewEvidence }),
            });
            if (record.payload.inputDigest !== expectedInputDigest)
              throw new Error("compiler repair input digest differs");
          }
        } else {
          const validation = validations.get(revision);
          if (validation?.payload.valid !== true || judgeResults.has(revision))
            throw new Error("compiler judge lifecycle is out of order");
          const proposalResult = proposalResults.get(revision);
          const proposal = expected.fixedGraph
            ? compilerJudgeCandidateFromCompiled(expected.fixedGraph)
            : proposalResult
              ? retainedProposal(proposalResult)
              : undefined;
          if (!proposal) {
            const proposalIntent = proposalResult
              ? invocations.get(String(proposalResult.payload.invocationId))
              : undefined;
            if (proposalIntent && isProviderProposalIntent(proposalIntent))
              throw new Error("compiler judge lacks its proposal binding");
          } else {
            const reviewEvidence = record.payload.reviewEvidence ?? null;
            const expectedInputDigest = draftDigest({
              inventory: inventoryResult.payload.value,
              previous: proposal,
              projection: validation.payload.projectionTrace,
              failure: reviewEvidence,
              ...(reviewEvidence === null ? {} : { reviewEvidence }),
            });
            if (record.payload.inputDigest !== expectedInputDigest)
              throw new Error("compiler judge input digest differs");
          }
        }
      }
      invocations.set(invocationId, record);
      continue;
    }

    if (record.kind === "result") {
      const invocationId = safeId.parse(record.payload.invocationId);
      const intent = invocations.get(invocationId);
      if (!intent || intent.sequence >= record.sequence || results.has(invocationId))
        throw new Error("compiler result invocation binding mismatch");
      if (
        record.payload.stage !== intent.payload.stage ||
        record.payload.revision !== intent.payload.revision
      )
        throw new Error("compiler result invocation binding mismatch");
      const completedAt = TimestampSchema.parse(record.payload.completedAt);
      const startedAt = TimestampSchema.parse(intent.payload.startedAt);
      if (record.payload.observedMilliseconds === null) {
        if (
          completedAt >= startedAt ||
          record.payload.timingUnavailable !== "local-clock-moved-backward"
        )
          throw new Error("compiler timing unavailable without evidence");
      } else if (
        TimestampSchema.parse(record.payload.observedMilliseconds) !==
        completedAt - startedAt
      )
        throw new Error("compiler invocation interval mismatch");
      const usage = record.payload.usage === null ? null : UsageSchema.parse(record.payload.usage);
      const localTerminal = record.payload.preProviderTerminal === true;
      const hasError = typeof record.payload.error === "string";
      if (localTerminal) {
        if (
          usage !== null ||
          record.payload.value !== null ||
          !hasError ||
          typeof record.payload.stopReason !== "string" ||
          record.payload.providerQuota !== undefined ||
          record.payload.provenance !== undefined
        )
          throw new Error("compiler pre-provider terminal payload is invalid");
      } else {
        const provenance =
          record.payload.provenance === undefined
            ? undefined
            : CompilerInvocationProvenanceSchema.parse(record.payload.provenance);
        if (
          intent.payload.expectedProvenance === undefined ||
          !provenance ||
          provenance.baseSha !== expected.binding.baseSha ||
          draftDigest(provenance) !== draftDigest(intent.payload.expectedProvenance)
        )
          throw new Error("compiler result provenance differs from reserved invocation");
        if (hasError ? record.payload.value !== null : usage === null)
          throw new Error("compiler result terminal shape is invalid");
        if (!hasError && (record.payload.value === null || record.payload.stopReason !== undefined))
          throw new Error("compiler success terminal shape is invalid");
        if (record.payload.providerQuota !== undefined) {
          ProviderQuotaCheckpointSchema.parse(record.payload.providerQuota);
          if (!hasError) throw new Error("compiler provider quota result lacks failure");
        }
      }
      results.set(invocationId, record);
      if (intent.payload.stage === "inventory") {
        if (hasError) nextInventoryRevision += 1;
        else inventoryResult = record;
      } else if (intent.payload.stage === "compile" || intent.payload.stage === "repair") {
        const revision = Number(intent.payload.revision);
        proposalResults.set(revision, record);
        if (
          !localTerminal &&
          isProviderProposalIntent(intent) &&
          (typeof intent.payload.compilerRequestDigest !== "string" ||
            !/^[a-f0-9]{64}$/.test(intent.payload.compilerRequestDigest))
        )
          throw new Error("compiler proposal lacks its reserved request binding");
        if (!localTerminal && !hasError) {
          const value = record.payload.value as
            | { provenance?: { requestDigest?: unknown } }
            | undefined;
          const persistedRequestDigest = value?.provenance?.requestDigest;
          if (
            isProviderProposalIntent(intent) &&
            persistedRequestDigest !== intent.payload.compilerRequestDigest
          )
            throw new Error("compiler proposal request binding differs");
          const persisted = record.payload.value as
            | { request?: unknown; provenance?: { requestDigest?: unknown } }
            | undefined;
          if (
            isProviderProposalIntent(intent) &&
            (persisted?.request === undefined ||
              !CompilerProposalSchema.safeParse(retainedProposal(record)).success ||
              draftDigest(persisted.request) !== intent.payload.compilerRequestDigest ||
              (persisted.request as { revision?: unknown }).revision !== intent.payload.revision)
          )
            throw new Error("compiler proposal request payload differs");
        }
      } else if (intent.payload.stage === "judge") {
        judgeResults.set(Number(intent.payload.revision), record);
      }
      continue;
    }

    if (record.kind === "validation") {
      const revision = z.number().int().min(0).max(2).parse(record.payload.revision);
      if (validations.has(revision)) throw new Error("duplicate compiler validation revision");
      const proposalResult = proposalResults.get(revision);
      if (expected.fixedGraph) {
        if (revision !== 0 || proposalResult)
          throw new Error("fixed compiler validation lifecycle is invalid");
      } else if (!proposalResult || proposalResult.payload.error)
        throw new Error("compiler validation lacks its proposal result");
      const proposal = expected.fixedGraph
        ? compilerJudgeCandidateFromCompiled(expected.fixedGraph)
        : retainedProposal(proposalResult!);
      const proposalInvocation = proposalResult
        ? invocations.get(String(proposalResult.payload.invocationId))
        : undefined;
      const providerProposal = proposalInvocation
        ? isProviderProposalIntent(proposalInvocation)
        : false;
      const requestDigest = expected.fixedGraph
        ? draftDigest({ fixedGraph: fixedGraphDigest })
        : providerProposal && typeof proposalInvocation?.payload.compilerRequestDigest === "string"
          ? proposalInvocation.payload.compilerRequestDigest
          : record.payload.requestDigest;
      if (
        record.payload.resultDigest !==
          (expected.fixedGraph
            ? draftDigest(expected.fixedGraph)
            : draftDigest(proposalResult!.payload.value)) ||
        ((expected.fixedGraph || providerProposal) &&
          (proposal === undefined || record.payload.proposalDigest !== draftDigest(proposal))) ||
        record.payload.requestDigest !== requestDigest
      )
        throw new Error("compiler validation proposal binding differs");
      if (record.payload.valid === true) {
        for (const field of ["graphDigest", "proposalDigest", "traceDigest", "requestDigest"])
          z.string()
            .regex(/^[a-f0-9]{64}$/)
            .parse(record.payload[field]);
        if (draftDigest(record.payload.projectionTrace) !== record.payload.traceDigest)
          throw new Error("compiler validation projection trace differs");
        const trace = record.payload.projectionTrace as Record<string, unknown>;
        if (
          trace.proposalDigest !== record.payload.proposalDigest ||
          trace.requestDigest !== record.payload.requestDigest ||
          trace.graphDigest !== record.payload.graphDigest
        )
          throw new Error("compiler validation trace binding differs");
      } else if (
        record.payload.valid !== false ||
        !z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .safeParse(record.payload.reportDigest).success
      )
        throw new Error("compiler validation payload is invalid");
      else if (
        record.payload.failure === undefined ||
        record.payload.reportDigest !==
          draftDigest(
            (record.payload.failure as { validationReport?: unknown }).validationReport ?? null,
          )
      )
        throw new Error("compiler validation failure binding differs");
      validations.set(revision, record);
      continue;
    }

    if (record.kind === "accounting-failure") {
      const invocationId = safeId.parse(record.payload.invocationId);
      const result = results.get(invocationId);
      if (
        !result ||
        record.payload.stage !== result.payload.stage ||
        typeof record.payload.error !== "string"
      )
        throw new Error("compiler accounting failure lacks its result binding");
      failures.set(record.sequence, record);
      continue;
    }

    if (record.kind === "accounting-reconciled") {
      const failureSequence = z.number().int().nonnegative().parse(record.payload.failureSequence);
      const failure = failures.get(failureSequence);
      if (
        !failure ||
        reconciledFailures.has(failureSequence) ||
        record.payload.invocationId !== failure.payload.invocationId ||
        record.payload.stage !== failure.payload.stage
      )
        throw new Error("compiler accounting reconciliation lacks its failure binding");
      reconciledFailures.add(failureSequence);
      continue;
    }

    if (record.kind === "terminal-conflict") {
      const invocationId = safeId.parse(record.payload.invocationId);
      if (!results.has(invocationId))
        throw new Error("compiler terminal conflict lacks its result binding");
      if (record.payload.usageConflict !== true && record.payload.usageConflict !== false)
        throw new Error("compiler terminal conflict payload is invalid");
      continue;
    }

    if (record.kind === "selection" || record.kind === "stopped") {
      if ([...failures.keys()].some((sequence) => !reconciledFailures.has(sequence)))
        throw new Error("compiler terminal state has unresolved accounting failure");
      if (record.kind === "selection") {
        const revision = z.number().int().min(0).max(2).parse(record.payload.revision);
        if (validations.get(revision)?.payload.valid !== true)
          throw new Error("compiler selection lacks its validation binding");
        for (const field of [
          "graphDigest",
          "proposalDigest",
          "requestDigest",
          "traceDigest",
          "inventoryDigest",
          "verdictDigest",
        ])
          z.string()
            .regex(/^[a-f0-9]{64}$/)
            .parse(record.payload[field]);
        const validation = validations.get(revision)!;
        const judged = judgeResults.get(revision);
        if (
          !judged ||
          judged.payload.error ||
          record.payload.graphDigest !== validation.payload.graphDigest ||
          record.payload.proposalDigest !== validation.payload.proposalDigest ||
          record.payload.requestDigest !== validation.payload.requestDigest ||
          record.payload.traceDigest !== validation.payload.traceDigest ||
          record.payload.inventoryDigest !== draftDigest(inventoryResult?.payload.value) ||
          record.payload.verdictDigest !== draftDigest(judged.payload.value) ||
          draftDigest(record.payload.reviewEvidence ?? null) !==
            draftDigest(
              invocations.get(String(judged.payload.invocationId))?.payload.reviewEvidence ?? null,
            )
        )
          throw new Error("compiler selection durable bindings differ");
      } else if (typeof record.payload.reason !== "string")
        throw new Error("compiler stopped record lacks its reason");
      terminal = record;
      continue;
    }

    throw new Error(`unexpected compiler draft record kind: ${record.kind}`);
  }

  const unresolved = [...invocations.entries()].filter(([id]) => !results.has(id));
  if (
    unresolved.length > 1 ||
    (unresolved.length === 1 && unresolved[0]![1].sequence !== records.at(-1)?.sequence)
  )
    throw new Error("compiler invocation-only state is not the final uncertain tail");
}

export interface PersistedCompilerDraftJournalAuthority {
  binding: CompilerDraftBinding;
  limits: {
    maxRepairs: number;
    maxInvocations: number;
    maxObservedTokens: number;
    deadlineMs: number;
  };
  sourceEvidence: unknown;
  fixedGraph?: CompiledObjective;
  adapterMode: "local" | "provider";
}

/**
 * Derive the self-contained persisted envelope, then apply the same whole-chain
 * grammar used before executable replay. Git lineage and record binding have
 * already been authenticated by loadCompilerDrafts.
 */
export function validatePersistedCompilerDraftJournal(
  records: readonly CompilerDraftRecord[],
): PersistedCompilerDraftJournalAuthority | null {
  if (!records.length) return null;
  const first = records[0]!;
  const limits = LimitsSchema.parse(first.payload.limits);
  const adapterMode = DraftAdapterModeSchema.parse(first.payload.adapterMode);
  let cursor = 1;
  let sourceEvidence: unknown = null;
  if (records[cursor]?.kind === "source-evidence") {
    sourceEvidence = records[cursor]!.payload.sourceEvidence;
    cursor += 1;
  }
  const fixedGraph =
    records[cursor]?.kind === "fixed-graph"
      ? parsePersistedCompiledObjective(records[cursor]!.payload.fixedGraph)
      : undefined;
  const authority: PersistedCompilerDraftJournalAuthority = {
    binding: first.binding,
    limits,
    sourceEvidence,
    adapterMode,
    ...(fixedGraph ? { fixedGraph } : {}),
  };
  validateCompilerDraftJournal(records, authority);
  return authority;
}

/** Drafts never publish Work Items. A durable exact selection is the caller's only projection authority. */
export async function runCompilerDraftLoop(args: {
  manager: CompilerDraftManager;
  lease: LeaseState;
  binding: CompilerDraftBinding;
  callbacks: CompilerDraftCallbacks;
  limits?: CompilerDraftLimits;
  now?: () => number;
  /** Capture before bounded source gathering; an existing durable start always wins. */
  startedAt?: number;
  fixedGraph?: CompiledObjective;
  sourceEvidence?: unknown;
}): Promise<CompilerDraftOutcome> {
  const { manager, lease, binding, callbacks } = args;
  const clock = args.now ?? Date.now;
  const now = () => TimestampSchema.parse(clock());
  const limits = LimitsSchema.parse({
    maxRepairs: args.limits?.maxRepairs ?? 2,
    maxInvocations: args.limits?.maxInvocations ?? 7,
    maxObservedTokens: args.limits?.maxObservedTokens ?? Number.MAX_SAFE_INTEGER,
    deadlineMs: args.limits?.deadlineMs ?? 600_000,
  });
  const fixedGraph =
    args.fixedGraph === undefined ? undefined : parsePersistedCompiledObjective(args.fixedGraph);
  const fixedGraphDigest = fixedGraph ? compiledGraphDigest(fixedGraph) : null;
  const sourceEvidence = args.sourceEvidence ?? null;
  const adapterMode = DraftAdapterModeSchema.parse(
    callbacks.reserveAtDispatch ? "provider" : "local",
  );
  const records = await manager.load(binding);
  const sourceEvidenceDigest = draftDigest(sourceEvidence);
  validateCompilerDraftJournal(records, {
    binding,
    limits,
    sourceEvidence,
    adapterMode,
    ...(fixedGraph ? { fixedGraph } : {}),
  });
  const append = async (kind: CompilerDraftRecord["kind"], payload: Record<string, unknown>) => {
    const record = await manager.append(lease, binding, records.length, kind, payload);
    records.push(record);
    return record;
  };
  const recordUsage = async (invocationId: string, stage: DraftStage, usage: DraftUsage) => {
    const pendingFailures = records.filter(
      (item) =>
        item.kind === "accounting-failure" &&
        item.payload.invocationId === invocationId &&
        item.payload.stage === stage &&
        !records.some(
          (candidate) =>
            candidate.kind === "accounting-reconciled" &&
            candidate.payload.failureSequence === item.sequence,
        ),
    );
    try {
      await callbacks.recordUsage(invocationId, stage, usage);
      for (const failure of pendingFailures)
        await append("accounting-reconciled", {
          invocationId,
          stage,
          failureSequence: failure.sequence,
        });
    } catch (error) {
      if (
        pendingFailures.length === 0 &&
        !records.some((item) => item.kind === "selection" || item.kind === "stopped")
      )
        await append("accounting-failure", {
          invocationId,
          stage,
          error: diagnostic(error),
        });
      throw new CompilerDraftAccountingError("compiler accounting reconciliation failed", {
        cause: error,
      });
    }
  };
  if (!records.length)
    await append("started", {
      limits,
      startedAt: TimestampSchema.parse(args.startedAt ?? now()),
      sourceEvidenceDigest,
      fixedGraphDigest,
      adapterMode,
    });
  const first = records[0];
  if (
    first?.kind !== "started" ||
    draftDigest(first.payload.limits) !== draftDigest(limits) ||
    !TimestampSchema.safeParse(first.payload.startedAt).success ||
    first.payload.fixedGraphDigest !== fixedGraphDigest ||
    first.payload.sourceEvidenceDigest !== sourceEvidenceDigest ||
    first.payload.adapterMode !== adapterMode
  )
    throw new Error("compiler draft policy changed");
  let companionSequence = 1;
  if (sourceEvidence !== null) {
    if (!records[companionSequence])
      await append("source-evidence", { sourceEvidence, sourceEvidenceDigest });
    const sourceRecord = records[companionSequence];
    if (
      sourceRecord?.kind !== "source-evidence" ||
      sourceRecord.payload.sourceEvidenceDigest !== sourceEvidenceDigest ||
      draftDigest(sourceRecord.payload.sourceEvidence) !== sourceEvidenceDigest
    )
      throw new Error("compiler draft source evidence changed");
    companionSequence += 1;
  }
  if (fixedGraph) {
    if (!records[companionSequence]) await append("fixed-graph", { fixedGraph, fixedGraphDigest });
    const graphRecord = records[companionSequence];
    if (
      graphRecord?.kind !== "fixed-graph" ||
      graphRecord.payload.fixedGraphDigest !== fixedGraphDigest ||
      compiledGraphDigest(parsePersistedCompiledObjective(graphRecord.payload.fixedGraph)) !==
        fixedGraphDigest
    )
      throw new Error("compiler draft fixed graph changed");
    companionSequence += 1;
  }
  if (
    records.some(
      (record, index) =>
        index >= companionSequence &&
        (record.kind === "source-evidence" || record.kind === "fixed-graph"),
    )
  )
    throw new Error("compiler draft has misplaced source evidence");
  for (const record of records) {
    if (record.kind === "invocation" && record.payload.startedAt !== undefined)
      TimestampSchema.parse(record.payload.startedAt);
    if (record.kind === "result" && record.payload.completedAt !== undefined) {
      const completedAt = TimestampSchema.parse(record.payload.completedAt);
      const invocation = records.find(
        (item) =>
          item.kind === "invocation" && item.payload.invocationId === record.payload.invocationId,
      );
      const start = TimestampSchema.parse(invocation?.payload.startedAt);
      if (record.payload.observedMilliseconds === null) {
        if (
          completedAt >= start ||
          record.payload.timingUnavailable !== "local-clock-moved-backward"
        )
          throw new Error("compiler timing unavailable without evidence");
      } else if (TimestampSchema.parse(record.payload.observedMilliseconds) !== completedAt - start)
        throw new Error("compiler invocation interval mismatch");
    }
  }
  const providerQuotaResults = records.filter(
    (record) => record.kind === "result" && record.payload.providerQuota !== undefined,
  );
  if (providerQuotaResults.length > 1)
    throw new Error("compiler draft contains conflicting provider quota checkpoints");
  const providerQuotaResult = providerQuotaResults[0];
  if (providerQuotaResult) {
    const invocationId = safeId.parse(providerQuotaResult.payload.invocationId);
    const intent = records.filter(
      (record) => record.kind === "invocation" && record.payload.invocationId === invocationId,
    );
    if (
      intent.length !== 1 ||
      intent[0]?.payload.stage !== providerQuotaResult.payload.stage ||
      intent[0]?.payload.revision !== providerQuotaResult.payload.revision ||
      providerQuotaResult.payload.value !== null ||
      typeof providerQuotaResult.payload.error !== "string"
    )
      throw new Error("compiler provider quota checkpoint lacks its exact invocation binding");
    const gate = ProviderQuotaCheckpointSchema.parse(providerQuotaResult.payload.providerQuota);
    const usage =
      providerQuotaResult.payload.usage === null
        ? undefined
        : UsageSchema.parse(providerQuotaResult.payload.usage);
    throw new ProviderQuotaError(gate, {
      invocationId,
      ...(usage ? { usage } : {}),
    });
  }
  const conflicts = records.filter((item) => item.kind === "terminal-conflict");
  const disputedUsage = new Set(
    conflicts
      .filter((item) => item.payload.usageConflict === true)
      .map((item) => String(item.payload.invocationId)),
  );
  // Disputed counters are not exact actual usage. Preserve both digests and keep admission closed.
  // All other known terminal usage is reconciled, including rejected and failed calls.
  let tokens = 0;
  for (const record of records.filter((item) => item.kind === "result")) {
    if (disputedUsage.has(String(record.payload.invocationId))) continue;
    const usage = record.payload.usage === null ? null : UsageSchema.parse(record.payload.usage);
    if (usage) {
      tokens += usage.inputTokens + usage.outputTokens;
      await recordUsage(
        String(record.payload.invocationId),
        record.payload.stage as DraftStage,
        usage,
      );
    }
  }
  const terminal = records.find((item) => item.kind === "selection" || item.kind === "stopped");
  if (conflicts.length) {
    if (terminal?.kind === "selection")
      throw new Error("compiler selection contradicts terminal conflict evidence");
    if (!terminal)
      await append("stopped", {
        reason: disputedUsage.size
          ? "conflicting-terminal-accounting"
          : "conflicting-terminal-output",
      });
    return {
      status: "stopped",
      reason: disputedUsage.size
        ? "conflicting-terminal-accounting"
        : "conflicting-terminal-output",
      records,
    };
  }
  if (terminal?.kind === "selection") {
    const inventoryResults = records.filter(
      (item) => item.kind === "result" && item.payload.stage === "inventory" && !item.payload.error,
    );
    if (inventoryResults.length !== 1) throw new Error("compiler selection inventory is ambiguous");
    const inventoryResult = inventoryResults[0];
    const proposal = records.find(
      (item) =>
        item.kind === "result" &&
        item.payload.revision === terminal.payload.revision &&
        (item.payload.stage === "compile" || item.payload.stage === "repair"),
    );
    const judged = records.find(
      (item) =>
        item.kind === "result" &&
        item.payload.stage === "judge" &&
        item.payload.revision === terminal.payload.revision,
    );
    if (
      !inventoryResult ||
      (!proposal && !fixedGraph) ||
      !judged ||
      records.some((item) => item.kind === "result" && item.payload.usage === null)
    )
      throw new Error("compiler selection lacks known invocation evidence");
    const inventory = await callbacks.validateInventory(inventoryResult.payload.value);
    const proposalInvocation = proposal
      ? records.find(
          (item) =>
            item.kind === "invocation" &&
            item.payload.invocationId === proposal.payload.invocationId,
        )
      : undefined;
    const draft = await callbacks.validate(
      fixedGraph ? { fixedGraph } : proposal!.payload.value,
      Number(terminal.payload.revision),
      typeof proposalInvocation?.payload.compilerRequestDigest === "string"
        ? proposalInvocation.payload.compilerRequestDigest
        : undefined,
    );
    const graph = draft.objective;
    const reviewEvidence = terminal.payload.reviewEvidence ?? null;
    const judgeIntent = records.find(
      (item) =>
        item.kind === "invocation" && item.payload.invocationId === judged.payload.invocationId,
    );
    if (
      !judgeIntent ||
      draftDigest(judgeIntent.payload.reviewEvidence ?? null) !== draftDigest(reviewEvidence) ||
      judgeIntent.payload.inputDigest !==
        draftDigest({
          inventory,
          previous: draft.proposal,
          projection: draft.projectionTrace,
          failure: reviewEvidence,
          ...(reviewEvidence === null ? {} : { reviewEvidence }),
        })
    )
      throw new Error("compiler selection judge input evidence changed");
    if (
      draftDigest(inventory) !== terminal.payload.inventoryDigest ||
      draftDigest(judged.payload.value) !== terminal.payload.verdictDigest ||
      draftDigest(draft.proposal) !== terminal.payload.proposalDigest ||
      draftDigest(draft.projectionTrace) !== terminal.payload.traceDigest ||
      draft.requestDigest !== terminal.payload.requestDigest ||
      !callbacks.accept(judged.payload.value, draft, inventory, reviewEvidence)
    )
      throw new Error("compiler selection acceptance no longer validates");
    if (compiledGraphDigest(graph) !== terminal.payload.graphDigest)
      throw new Error("compiler selection digest mismatch");
    return {
      status: "accepted",
      graph,
      graphDigest: compiledGraphDigest(graph),
      revision: Number(terminal.payload.revision),
      records,
    };
  }
  if (terminal) return { status: "stopped", reason: String(terminal.payload.reason), records };
  const stop = async (reason: string): Promise<CompilerDraftOutcome> => {
    const safeReason = diagnostic(reason);
    await append("stopped", { reason: safeReason });
    return { status: "stopped", reason: safeReason, records };
  };
  if (records.some((item) => item.kind === "terminal-conflict"))
    return await stop("conflicting-terminal-output");
  class Stop extends CompilerDraftStopError {}
  const invoke = async (
    stage: DraftStage,
    revision: number,
    inventory: unknown,
    previous: CompilerJudgeCandidate | null,
    failure: unknown,
    reviewEvidence: unknown = null,
    projection: DraftInvocation["projection"] = null,
  ): Promise<unknown> => {
    const invocationId = `compiler-${draftDigest({ binding, stage, revision })}`;
    const inputDigest = draftDigest({
      inventory,
      previous,
      projection,
      failure,
      ...(reviewEvidence === null ? {} : { reviewEvidence }),
    });
    const completed = records.find(
      (item) => item.kind === "result" && item.payload.invocationId === invocationId,
    );
    const reserved = records.find(
      (item) => item.kind === "invocation" && item.payload.invocationId === invocationId,
    );
    if (reserved && reserved.payload.inputDigest !== inputDigest)
      throw new Stop("invocation-input-changed");
    if (completed) {
      if (
        typeof completed.payload.stopReason === "string" &&
        completed.payload.preProviderTerminal === true
      )
        throw new Stop(completed.payload.stopReason);
      if (completed.payload.usage === null) throw new Stop("accounting-unavailable");
      if (typeof completed.payload.stopReason === "string")
        throw new Stop(completed.payload.stopReason);
      if (completed.payload.error)
        throw Object.assign(new Error(String(completed.payload.error)), {
          proposal: completed.payload.proposal,
          validationReport: completed.payload.validationReport,
          repairableInvalidClaims: completed.payload.repairableInvalidClaims,
        });
      return completed.payload.value;
    }
    if (
      records.some(
        (item) => item.kind === "invocation" && item.payload.invocationId === invocationId,
      )
    )
      throw new Stop("uncertain-invocation-accounting");
    if (now() - Number(first.payload.startedAt) >= limits.deadlineMs)
      throw new Stop("deadline-exhausted");
    if (tokens >= limits.maxObservedTokens) throw new Stop("observed-token-limit");
    if (records.filter((item) => item.kind === "invocation").length >= limits.maxInvocations)
      throw new Stop("invocation-limit");
    let invocationStartedAt: number | null = null;
    let reserving = false;
    let reservedExpectedProvenance = reserved?.payload.expectedProvenance;
    const reserve = async (evidence?: DraftReservationEvidence) => {
      if (reserving)
        throw new CompilerDraftAdmissionError(new Error("compiler dispatch already reserved"));
      reserving = true;
      const startedAt = now();
      await append("invocation", {
        startedAt,
        invocationId,
        stage,
        revision,
        inputDigest,
        ...(evidence?.compilerRequestDigest
          ? { compilerRequestDigest: evidence.compilerRequestDigest }
          : {}),
        ...(evidence?.expectedProvenance
          ? {
              expectedProvenance: CompilerInvocationProvenanceSchema.parse(
                evidence.expectedProvenance,
              ),
            }
          : {}),
        ...(reviewEvidence === null ? {} : { reviewEvidence }),
      });
      invocationStartedAt = startedAt;
      reservedExpectedProvenance = evidence?.expectedProvenance;
    };
    if (!callbacks.reserveAtDispatch)
      await reserve({
        expectedProvenance: {
          promptDigest: inputDigest,
          schemaDigest: draftDigest({ protocol: "clockgrove.factory/local-draft-callback", stage }),
          baseSha: binding.baseSha,
          model: null,
          reasoning: null,
        },
      });
    const timing = () => {
      if (invocationStartedAt === null)
        throw new Error("compiler result has no dispatch reservation");
      const completedAt = now();
      // Local wall-clock intervals are observations, never provider billing or summed Objective time.
      const observedMilliseconds = completedAt - invocationStartedAt;
      if (observedMilliseconds < 0)
        return {
          completedAt,
          observedMilliseconds: null,
          timingUnavailable: "local-clock-moved-backward",
        };
      return { completedAt, observedMilliseconds: TimestampSchema.parse(observedMilliseconds) };
    };
    let saved: DraftInvocationResult | null = null;
    let contradictory = false;
    let conflictingResultDigest: string | null = null;
    let conflictingUsageDigest: string | null = null;
    let usageConflict = false;
    let savedProviderQuota: ProviderQuotaError | null = null;
    const checkpoint = async (result: DraftInvocationResult): Promise<void> => {
      if (savedProviderQuota)
        throw new Error("compiler success conflicts with its provider refusal checkpoint");
      const parsedUsage =
        result.usage === null
          ? { success: true as const, data: null }
          : UsageSchema.safeParse(result.usage);
      const parsedProvenance =
        result.provenance === undefined
          ? { success: true as const, data: undefined }
          : CompilerInvocationProvenanceSchema.safeParse(result.provenance);
      const effectiveProvenance =
        parsedProvenance.success && parsedProvenance.data
          ? parsedProvenance.data
          : !callbacks.reserveAtDispatch && reservedExpectedProvenance
            ? CompilerInvocationProvenanceSchema.parse(reservedExpectedProvenance)
            : undefined;
      const normalized = {
        value: result.value,
        usage: parsedUsage.success ? parsedUsage.data : null,
        ...(effectiveProvenance ? { provenance: effectiveProvenance } : {}),
      };
      if (saved) {
        const usage = parsedUsage.success ? parsedUsage.data : null;
        if (
          !parsedUsage.success ||
          !parsedProvenance.success ||
          draftDigest(saved) !== draftDigest(normalized)
        ) {
          contradictory = true;
          usageConflict = !parsedUsage.success || draftDigest(saved.usage) !== draftDigest(usage);
          conflictingResultDigest = draftDigest(normalized);
          conflictingUsageDigest = parsedUsage.success ? draftDigest(usage) : null;
          throw new Error("conflicting compiler result checkpoint");
        }
        return;
      }
      if (!parsedUsage.success) throw new Error("compiler result has invalid usage evidence");
      if (!parsedProvenance.success)
        throw new Error("compiler result has invalid invocation provenance");
      if (
        reservedExpectedProvenance !== undefined &&
        (!effectiveProvenance ||
          draftDigest(effectiveProvenance) !== draftDigest(reservedExpectedProvenance))
      )
        throw new Error("compiler result provenance differs from reserved invocation");
      const usage = parsedUsage.data;
      try {
        await append("result", {
          invocationId,
          stage,
          revision,
          value: result.value,
          usage,
          ...(effectiveProvenance ? { provenance: effectiveProvenance } : {}),
          ...timing(),
        });
      } catch (error) {
        throw Object.assign(new Error(diagnostic(error), { cause: error }), {
          usage,
          proposal: result.value,
        });
      }
      saved = {
        value: result.value,
        usage,
        ...(effectiveProvenance ? { provenance: effectiveProvenance } : {}),
      };
    };
    const checkpointProviderRefusal = async (error: ProviderQuotaError): Promise<void> => {
      if (saved) throw new Error("compiler provider refusal conflicts with its result checkpoint");
      error.bindInvocation(invocationId);
      const gate = ProviderQuotaCheckpointSchema.parse(error.gate);
      const usage = error.usage ? UsageSchema.parse(error.usage) : null;
      if (savedProviderQuota) {
        if (
          draftDigest({
            gate: savedProviderQuota.gate,
            usage: savedProviderQuota.usage ?? null,
          }) !== draftDigest({ gate, usage })
        )
          throw new Error("conflicting compiler provider refusal checkpoint");
        return;
      }
      await append("result", {
        invocationId,
        stage,
        revision,
        value: null,
        usage,
        ...timing(),
        error: diagnostic(error),
        providerQuota: gate,
        ...(reservedExpectedProvenance
          ? { provenance: CompilerInvocationProvenanceSchema.parse(reservedExpectedProvenance) }
          : {}),
      });
      savedProviderQuota = error;
    };
    let result: DraftInvocationResult;
    try {
      result = await callbacks.invoke(
        {
          invocationId,
          stage,
          revision,
          inventory,
          previous,
          projection,
          failure,
          reviewEvidence,
        },
        checkpoint,
        reserve,
        checkpointProviderRefusal,
      );
      await checkpoint(result);
    } catch (error) {
      if (error instanceof CompilerDraftAdmissionError) throw error;
      if (savedProviderQuota) throw error;
      // A successful terminal checkpoint survives a caller/transport failure after it.
      if (contradictory) {
        await append("terminal-conflict", {
          invocationId,
          stage,
          revision,
          conflictingResultDigest,
          conflictingUsageDigest,
          usageConflict,
        });
        const known = records.find(
          (item) => item.kind === "result" && item.payload.invocationId === invocationId,
        );
        if (known?.payload.usage && !usageConflict) {
          const usage = UsageSchema.parse(known.payload.usage);
          tokens += usage.inputTokens + usage.outputTokens;
          await recordUsage(invocationId, stage, usage);
        }
        throw new Stop(
          usageConflict ? "conflicting-terminal-accounting" : "conflicting-terminal-output",
        );
      }
      if (saved) result = saved;
      else {
        const known =
          typeof error === "object" && error !== null && "usage" in error
            ? UsageSchema.safeParse(error.usage)
            : null;
        const usage = known?.success ? known.data : null;
        const stopCause =
          error instanceof CompilerDraftStopError
            ? error
            : error instanceof Error && error.cause instanceof CompilerDraftStopError
              ? error.cause
              : null;
        const preProviderTerminal =
          stopCause !== null &&
          typeof error === "object" &&
          error !== null &&
          "preProviderTerminal" in error &&
          error.preProviderTerminal === true;
        const providerQuota =
          error instanceof ProviderQuotaError
            ? ProviderQuotaCheckpointSchema.parse(error.bindInvocation(invocationId).gate)
            : undefined;
        const proposal = safeProposal(error);
        const validationReport = safeValidationReport(error);
        const repairableInvalidClaims =
          typeof error === "object" && error !== null && "repairableInvalidClaims" in error
            ? RepairableInvalidClaimsSchema.safeParse(error.repairableInvalidClaims)
            : null;
        const retainedRepairability =
          stage === "inventory" &&
          repairableInvalidClaims?.success &&
          proposal.proposal !== undefined &&
          repairableInvalidClaims.data.proposalDigest === draftDigest(proposal.proposal)
            ? { repairableInvalidClaims: repairableInvalidClaims.data }
            : {};
        const provenance =
          typeof error === "object" && error !== null && "provenance" in error
            ? CompilerInvocationProvenanceSchema.safeParse(error.provenance).data
            : !callbacks.reserveAtDispatch && reservedExpectedProvenance
              ? CompilerInvocationProvenanceSchema.parse(reservedExpectedProvenance)
              : undefined;
        if (
          !preProviderTerminal &&
          reservedExpectedProvenance !== undefined &&
          (!provenance || draftDigest(provenance) !== draftDigest(reservedExpectedProvenance))
        )
          throw new Stop("invocation-provenance-unavailable");
        await append("result", {
          invocationId,
          stage,
          revision,
          value: null,
          usage,
          ...timing(),
          ...proposal,
          ...(validationReport ? { validationReport } : {}),
          ...retainedRepairability,
          ...(!preProviderTerminal && provenance ? { provenance } : {}),
          error: diagnostic(error),
          ...(providerQuota ? { providerQuota } : {}),
          ...(stopCause ? { stopReason: diagnostic(stopCause) } : {}),
          ...(preProviderTerminal ? { preProviderTerminal: true } : {}),
        });
        if (usage) {
          tokens += usage.inputTokens + usage.outputTokens;
          // Provider quota metadata and exact usage must cross the durable boundary
          // together. The outer Supervisor owns that authenticated atomic batch.
          if (!(error instanceof ProviderQuotaError)) await recordUsage(invocationId, stage, usage);
        } else if (stopCause && preProviderTerminal) {
          // A locally rejected request can be durably reserved and terminated
          // before provider admission. Its explicit stop reason proves no model
          // accounting is expected for this invocation.
          throw stopCause;
        } else if (!(error instanceof ProviderQuotaError)) throw new Stop("accounting-unavailable");
        if (error instanceof ProviderQuotaError) throw error;
        if (stopCause) throw stopCause;
        throw error;
      }
    }
    const usage = result.usage;
    if (!usage) throw new Stop("accounting-unavailable");
    tokens += usage.inputTokens + usage.outputTokens;
    await recordUsage(invocationId, stage, usage);
    if (tokens > limits.maxObservedTokens) throw new Stop("observed-token-limit");
    if (now() - Number(first.payload.startedAt) >= limits.deadlineMs)
      throw new Stop("deadline-exhausted");
    return result.value;
  };
  try {
    let inventory: unknown;
    let inventoryRepairs = 0;
    let inventoryFailure: unknown = null;
    for (let revision = 0; ; revision++) {
      try {
        const value = await invoke("inventory", revision, null, null, inventoryFailure);
        inventory = await callbacks.validateInventory(value);
        break;
      } catch (error) {
        if (
          error instanceof CompilerDraftStopError ||
          error instanceof CompilerDraftReservationConflictError ||
          error instanceof CompilerDraftAccountingError ||
          error instanceof CompilerDraftAdmissionError ||
          error instanceof CompilerInvariantError ||
          error instanceof ProviderQuotaError
        )
          throw error;
        const failed = records.find(
          (item) =>
            item.kind === "result" &&
            item.payload.stage === "inventory" &&
            item.payload.revision === revision &&
            item.payload.error &&
            item.payload.usage !== null &&
            retainedRepairableInvalidClaims(item.payload) !== null,
        );
        // A backend success that no longer validates is changed grounding, not
        // authority to issue a second paid call.
        if (!failed) throw error;
        inventoryFailure = {
          error: String(failed.payload.error),
          proposal: failed.payload.proposal,
        };
        if (inventoryRepairs >= limits.maxRepairs)
          return await stop(`invalid-inventory: ${diagnostic(error)}`);
        inventoryRepairs += 1;
      }
    }
    let previousProposal: CompilerProposal | null = null;
    let failure: unknown = null;
    let reviewEvidence: unknown = null;
    const seen = new Set<string>();
    const blockerSets = new Set<string>();
    const graphRepairs = limits.maxRepairs - inventoryRepairs;
    for (let revision = 0; revision <= graphRepairs; revision++) {
      let draft: ValidatedCompilerDraft;
      let graph: CompiledObjective;
      let candidate: unknown;
      try {
        const value = fixedGraph
          ? { fixedGraph }
          : await invoke(
              revision === 0 ? "compile" : "repair",
              revision,
              inventory,
              previousProposal,
              failure,
              reviewEvidence,
            );
        candidate = value;
        const proposalInvocation = records.find(
          (item) =>
            item.kind === "invocation" &&
            item.payload.stage === (revision === 0 ? "compile" : "repair") &&
            item.payload.revision === revision,
        );
        draft = await callbacks.validate(
          value,
          revision,
          typeof proposalInvocation?.payload.compilerRequestDigest === "string"
            ? proposalInvocation.payload.compilerRequestDigest
            : undefined,
        );
        graph = draft.objective;
      } catch (error) {
        if (
          error instanceof CompilerDraftStopError ||
          error instanceof CompilerDraftReservationConflictError ||
          error instanceof CompilerDraftAccountingError ||
          error instanceof CompilerDraftAdmissionError ||
          error instanceof CompilerInvariantError ||
          error instanceof ProviderQuotaError
        )
          throw error;
        if (
          records.some(
            (item) =>
              item.kind === "validation" &&
              item.payload.revision === revision &&
              item.payload.valid === true,
          )
        )
          throw new Stop("draft-grounding-changed");
        failure = {
          error: diagnostic(error),
          ...safeProposal(error),
          ...(safeValidationReport(error) ? { validationReport: safeValidationReport(error) } : {}),
        };
        const candidateProposal =
          candidate && typeof candidate === "object" && "proposal" in candidate
            ? candidate.proposal
            : undefined;
        const retained = CompilerProposalSchema.safeParse(
          candidateProposal ??
            (typeof error === "object" && error !== null && "proposal" in error
              ? error.proposal
              : undefined),
        );
        if (retained.success) previousProposal = retained.data;
        if (
          candidate !== undefined &&
          !records.some((item) => item.kind === "validation" && item.payload.revision === revision)
        ) {
          const proposal = fixedGraph
            ? compilerJudgeCandidateFromCompiled(fixedGraph)
            : candidate && typeof candidate === "object" && "proposal" in candidate
              ? candidate.proposal
              : typeof error === "object" && error !== null && "proposal" in error
                ? error.proposal
                : candidate;
          const proposalInvocation = records.find(
            (item) =>
              item.kind === "invocation" &&
              item.payload.stage === (revision === 0 ? "compile" : "repair") &&
              item.payload.revision === revision,
          );
          if (proposal === undefined) throw new Stop("draft-validation-binding-unavailable");
          await append("validation", {
            revision,
            valid: false,
            reportDigest: draftDigest(safeValidationReport(error)),
            failure,
            proposalDigest: draftDigest(proposal),
            resultDigest: fixedGraph ? draftDigest(fixedGraph) : draftDigest(candidate),
            requestDigest: fixedGraph
              ? draftDigest({ fixedGraph: fixedGraphDigest })
              : typeof proposalInvocation?.payload.compilerRequestDigest === "string"
                ? proposalInvocation.payload.compilerRequestDigest
                : draftDigest({ invocationId: proposalInvocation?.payload.invocationId }),
          });
        }
        continue;
      }
      const graphDigest = compiledGraphDigest(graph);
      if (fixedGraphDigest !== null && graphDigest !== fixedGraphDigest)
        throw new Stop("fixed-graph-changed");
      const validated = records.find(
        (item) => item.kind === "validation" && item.payload.revision === revision,
      );
      if (
        validated &&
        (validated.payload.valid !== true ||
          validated.payload.graphDigest !== graphDigest ||
          validated.payload.proposalDigest !== draftDigest(draft.proposal) ||
          validated.payload.traceDigest !== draftDigest(draft.projectionTrace) ||
          validated.payload.requestDigest !== draft.requestDigest)
      )
        throw new Stop("draft-grounding-changed");
      reviewEvidence =
        callbacks.reviewEvidence?.(candidate, failure, inventory, reviewEvidence) ?? null;
      const reviewKey = draftDigest({ proposal: draft.proposal, graphDigest, reviewEvidence });
      if (seen.has(reviewKey)) throw new Stop("draft-cycle");
      seen.add(reviewKey);
      previousProposal =
        draft.proposal.protocol === "clockgrove.factory/compiler-proposal"
          ? draft.proposal
          : previousProposal;
      if (!records.some((item) => item.kind === "validation" && item.payload.revision === revision))
        await append("validation", {
          revision,
          valid: true,
          graphDigest,
          proposalDigest: draftDigest(draft.proposal),
          resultDigest: fixedGraph ? draftDigest(fixedGraph) : draftDigest(candidate),
          traceDigest: draftDigest(draft.projectionTrace),
          projectionTrace: draft.projectionTrace,
          requestDigest: draft.requestDigest,
        });
      try {
        const verdict = await invoke(
          "judge",
          revision,
          inventory,
          draft.proposal,
          reviewEvidence,
          reviewEvidence,
          draft.projectionTrace,
        );
        if (callbacks.accept(verdict, draft, inventory, reviewEvidence)) {
          if (tokens > limits.maxObservedTokens) throw new Stop("observed-token-limit");
          if (now() - Number(first.payload.startedAt) >= limits.deadlineMs)
            throw new Stop("deadline-exhausted");
          await append("selection", {
            revision,
            graphDigest,
            proposalDigest: draftDigest(draft.proposal),
            requestDigest: draft.requestDigest,
            traceDigest: draftDigest(draft.projectionTrace),
            inventoryDigest: draftDigest(inventory),
            verdictDigest: draftDigest(verdict),
            ...(reviewEvidence === null ? {} : { reviewEvidence }),
          });
          return { status: "accepted", revision, graphDigest, graph, records };
        }
        if (
          verdict &&
          typeof verdict === "object" &&
          "findings" in verdict &&
          Array.isArray(verdict.findings)
        ) {
          const roots = verdict.findings
            .filter(
              (finding: unknown): finding is Record<string, unknown> =>
                !!finding &&
                typeof finding === "object" &&
                "severity" in finding &&
                (finding.severity === "blocking" || finding.severity === "material-efficiency"),
            )
            .map((finding) => ({
              rootCause:
                typeof finding.rootCause === "string"
                  ? finding.rootCause.trim().replace(/\s+/g, " ").toLowerCase()
                  : null,
              correction:
                typeof finding.correction === "string"
                  ? finding.correction.trim().replace(/\s+/g, " ").toLowerCase()
                  : null,
              dimension: finding.dimension ?? null,
              obligationIds: Array.isArray(finding.obligationIds)
                ? [...finding.obligationIds].sort()
                : null,
              itemIds: Array.isArray(finding.itemIds) ? [...finding.itemIds].sort() : null,
              evidenceIds: Array.isArray(finding.evidenceIds)
                ? [...finding.evidenceIds].sort()
                : null,
            }));
          if (roots.length) {
            const key = draftDigest({ roots: roots.map(draftDigest).sort(), reviewEvidence });
            if (blockerSets.has(key)) throw new Stop("unchanged-blockers");
            blockerSets.add(key);
          }
        }
        failure = verdict;
      } catch (error) {
        if (
          error instanceof CompilerDraftStopError ||
          error instanceof CompilerDraftReservationConflictError ||
          error instanceof CompilerDraftAccountingError ||
          error instanceof CompilerDraftAdmissionError ||
          error instanceof ProviderQuotaError
        )
          throw error;
        failure = {
          error: diagnostic(error),
        };
      }
    }
    return await stop("repair-limit-unresolved");
  } catch (error) {
    if (error instanceof CompilerDraftAdmissionError) throw error.cause;
    if (
      error instanceof CompilerDraftReservationConflictError ||
      error instanceof CompilerDraftAccountingError ||
      error instanceof CompilerDraftAdmissionError ||
      error instanceof CompilerInvariantError ||
      error instanceof ProviderQuotaError
    )
      throw error;
    if (error instanceof CompilerDraftStopError) return await stop(error.message);
    return await stop(`invalid-inventory: ${diagnostic(error)}`);
  }
}
