import { z } from "zod";
import { assertNoSecretMaterial, assertWithinBytes } from "../protocol/limits.js";
import {
  compiledGraphDigest,
  parsePersistedCompiledObjective,
  type CompiledObjective,
} from "../graph.js";
import {
  type CompilerDraftManager,
  CompilerDraftReservationConflictError,
  draftDigest,
  type CompilerDraftBinding,
  type CompilerDraftRecord,
} from "../control/compiler-drafts.js";
import type { LeaseState } from "../control/lease.js";
import { ProviderQuotaError } from "../providers/quota.js";

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
export type DraftUsage = z.infer<typeof UsageSchema>;
export class CompilerDraftStopError extends Error {}
/** Admission failed before provider dispatch; absence of provider usage is not a failed paid call. */
export class CompilerDraftAdmissionError extends Error {
  constructor(cause: unknown) {
    super("compiler invocation admission failed", { cause });
  }
}
class CompilerDraftAccountingError extends Error {}

export type DraftStage = "inventory" | "compile" | "repair" | "judge";
export interface DraftInvocation {
  invocationId: string;
  stage: DraftStage;
  revision: number;
  inventory: unknown;
  previous: CompiledObjective | null;
  failure: unknown;
  reviewEvidence?: unknown;
}
export interface DraftInvocationResult {
  value: unknown;
  usage: DraftUsage | null;
}
export interface CompilerDraftCallbacks {
  /** Admission and provider call use the same immutable invocation ID. */
  invoke(
    request: DraftInvocation,
    checkpoint: (result: DraftInvocationResult) => Promise<void>,
    reserve?: () => Promise<void>,
  ): Promise<DraftInvocationResult>;
  /** Prepare locally before recording a possible paid invocation. */
  reserveAtDispatch?: boolean;
  /** Must be idempotent by invocation ID; replay reconciles usage before any new admission. */
  recordUsage(invocationId: string, stage: DraftStage, usage: DraftUsage): Promise<void>;
  validateInventory(value: unknown): unknown | Promise<unknown>;
  /** Re-run mechanical grounding against the pinned context, even after restart. */
  validate(value: unknown): CompiledObjective | Promise<CompiledObjective>;
  /** Parse full-coverage judge evidence and enforce its exact graph/inventory binding. */
  accept(
    value: unknown,
    graph: CompiledObjective,
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
  if (fixedGraph && limits.maxRepairs !== 0)
    throw new Error("fixed historical graph requires zero repairs");
  const fixedGraphDigest = fixedGraph ? compiledGraphDigest(fixedGraph) : null;
  const sourceEvidence = args.sourceEvidence ?? null;
  const records = await manager.load(binding);
  const append = async (kind: CompilerDraftRecord["kind"], payload: Record<string, unknown>) => {
    const record = await manager.append(lease, binding, records.length, kind, payload);
    records.push(record);
    return record;
  };
  const recordUsage = async (invocationId: string, stage: DraftStage, usage: DraftUsage) => {
    try {
      await callbacks.recordUsage(invocationId, stage, usage);
    } catch (error) {
      if (!records.some((item) => item.kind === "selection" || item.kind === "stopped"))
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
      ...(fixedGraph ? { fixedGraph, fixedGraphDigest } : {}),
      ...(sourceEvidence === null ? {} : { sourceEvidence }),
    });
  const first = records[0];
  if (
    first?.kind !== "started" ||
    draftDigest(first.payload.limits) !== draftDigest(limits) ||
    !TimestampSchema.safeParse(first.payload.startedAt).success ||
    (first.payload.fixedGraphDigest ?? null) !== fixedGraphDigest ||
    draftDigest(first.payload.sourceEvidence ?? null) !== draftDigest(sourceEvidence) ||
    (fixedGraph !== undefined &&
      compiledGraphDigest(parsePersistedCompiledObjective(first.payload.fixedGraph)) !==
        fixedGraphDigest)
  )
    throw new Error("compiler draft policy changed");
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
    const inventoryResult = records.find(
      (item) => item.kind === "result" && item.payload.stage === "inventory",
    );
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
    const graph = await callbacks.validate(
      fixedGraph ? { objective: fixedGraph } : proposal!.payload.value,
    );
    parsePersistedCompiledObjective(terminal.payload.graph);
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
          previous: graph,
          failure: reviewEvidence,
          ...(reviewEvidence === null ? {} : { reviewEvidence }),
        })
    )
      throw new Error("compiler selection judge input evidence changed");
    if (
      draftDigest(inventory) !== terminal.payload.inventoryDigest ||
      draftDigest(judged.payload.value) !== terminal.payload.verdictDigest ||
      !callbacks.accept(judged.payload.value, graph, inventory, reviewEvidence)
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
    previous: CompiledObjective | null,
    failure: unknown,
    reviewEvidence: unknown = null,
  ): Promise<unknown> => {
    const invocationId = `compiler-${draftDigest({ binding, stage, revision })}`;
    const completed = records.find(
      (item) => item.kind === "result" && item.payload.invocationId === invocationId,
    );
    const reserved = records.find(
      (item) => item.kind === "invocation" && item.payload.invocationId === invocationId,
    );
    if (
      reserved &&
      reserved.payload.inputDigest !==
        draftDigest({
          inventory,
          previous,
          failure,
          ...(reviewEvidence === null ? {} : { reviewEvidence }),
        })
    )
      throw new Stop("invocation-input-changed");
    if (completed) {
      if (completed.payload.usage === null) throw new Stop("accounting-unavailable");
      if (typeof completed.payload.stopReason === "string")
        throw new Stop(completed.payload.stopReason);
      if (completed.payload.error)
        throw Object.assign(new Error(String(completed.payload.error)), {
          proposal: completed.payload.proposal,
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
    const reserve = async () => {
      if (reserving)
        throw new CompilerDraftAdmissionError(new Error("compiler dispatch already reserved"));
      reserving = true;
      const startedAt = now();
      await append("invocation", {
        startedAt,
        invocationId,
        stage,
        revision,
        inputDigest: draftDigest({
          inventory,
          previous,
          failure,
          ...(reviewEvidence === null ? {} : { reviewEvidence }),
        }),
        ...(reviewEvidence === null ? {} : { reviewEvidence }),
      });
      invocationStartedAt = startedAt;
    };
    if (!callbacks.reserveAtDispatch) await reserve();
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
    const checkpoint = async (result: DraftInvocationResult): Promise<void> => {
      const parsedUsage =
        result.usage === null
          ? { success: true as const, data: null }
          : UsageSchema.safeParse(result.usage);
      if (saved) {
        const usage = parsedUsage.success ? parsedUsage.data : null;
        if (
          !parsedUsage.success ||
          draftDigest(saved) !== draftDigest({ value: result.value, usage })
        ) {
          contradictory = true;
          usageConflict = !parsedUsage.success || draftDigest(saved.usage) !== draftDigest(usage);
          conflictingResultDigest = draftDigest({ value: result.value, usage });
          conflictingUsageDigest = parsedUsage.success ? draftDigest(usage) : null;
          throw new Error("conflicting compiler result checkpoint");
        }
        return;
      }
      if (!parsedUsage.success) throw new Error("compiler result has invalid usage evidence");
      const usage = parsedUsage.data;
      try {
        await append("result", {
          invocationId,
          stage,
          revision,
          value: result.value,
          usage,
          ...timing(),
        });
      } catch (error) {
        throw Object.assign(new Error(diagnostic(error), { cause: error }), {
          usage,
          proposal: result.value,
        });
      }
      saved = { value: result.value, usage };
    };
    let result: DraftInvocationResult;
    try {
      result = await callbacks.invoke(
        { invocationId, stage, revision, inventory, previous, failure, reviewEvidence },
        checkpoint,
        reserve,
      );
      await checkpoint(result);
    } catch (error) {
      if (error instanceof CompilerDraftAdmissionError) throw error;
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
        await append("result", {
          invocationId,
          stage,
          revision,
          value: null,
          usage,
          ...timing(),
          ...safeProposal(error),
          error: diagnostic(error),
          ...(stopCause ? { stopReason: diagnostic(stopCause) } : {}),
        });
        if (usage) {
          tokens += usage.inputTokens + usage.outputTokens;
          // Provider quota metadata and exact usage must cross the durable boundary
          // together. The outer Supervisor owns that authenticated atomic batch.
          if (!(error instanceof ProviderQuotaError)) await recordUsage(invocationId, stage, usage);
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
    const inventory = await callbacks.validateInventory(
      await invoke("inventory", 0, null, null, null),
    );
    let previous: CompiledObjective | null = null;
    let failure: unknown = null;
    let reviewEvidence: unknown = null;
    const seen = new Set<string>();
    const blockerSets = new Set<string>();
    for (let revision = 0; revision <= limits.maxRepairs; revision++) {
      let graph: CompiledObjective;
      let candidate: unknown;
      try {
        const value = fixedGraph
          ? { objective: fixedGraph }
          : await invoke(
              revision === 0 ? "compile" : "repair",
              revision,
              inventory,
              previous,
              failure,
              reviewEvidence,
            );
        candidate = value;
        graph = await callbacks.validate(value);
      } catch (error) {
        if (
          error instanceof CompilerDraftStopError ||
          error instanceof CompilerDraftReservationConflictError ||
          error instanceof CompilerDraftAccountingError ||
          error instanceof CompilerDraftAdmissionError ||
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
        };
        if (
          !records.some((item) => item.kind === "validation" && item.payload.revision === revision)
        )
          await append("validation", { revision, valid: false, failure });
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
        (validated.payload.valid !== true || validated.payload.graphDigest !== graphDigest)
      )
        throw new Stop("draft-grounding-changed");
      reviewEvidence =
        callbacks.reviewEvidence?.(candidate, failure, inventory, reviewEvidence) ?? null;
      const reviewKey = draftDigest({ graphDigest, reviewEvidence });
      if (seen.has(reviewKey)) throw new Stop("draft-cycle");
      seen.add(reviewKey);
      previous = graph;
      if (!records.some((item) => item.kind === "validation" && item.payload.revision === revision))
        await append("validation", { revision, valid: true, graphDigest, graph });
      try {
        const verdict = await invoke(
          "judge",
          revision,
          inventory,
          graph,
          reviewEvidence,
          reviewEvidence,
        );
        if (callbacks.accept(verdict, graph, inventory, reviewEvidence)) {
          if (tokens > limits.maxObservedTokens) throw new Stop("observed-token-limit");
          if (now() - Number(first.payload.startedAt) >= limits.deadlineMs)
            throw new Stop("deadline-exhausted");
          await append("selection", {
            revision,
            graphDigest,
            graph,
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
      error instanceof ProviderQuotaError
    )
      throw error;
    if (error instanceof CompilerDraftStopError) return await stop(error.message);
    return await stop(`invalid-inventory: ${diagnostic(error)}`);
  }
}
