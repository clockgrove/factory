import { z } from "zod";
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
export type DraftStage = "inventory" | "compile" | "repair" | "judge";
export interface DraftInvocation {
  invocationId: string;
  stage: DraftStage;
  revision: number;
  inventory: unknown;
  previous: CompiledObjective | null;
  failure: unknown;
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
  ): Promise<DraftInvocationResult>;
  /** Must be idempotent by invocation ID; replay reconciles usage before any new admission. */
  recordUsage(invocationId: string, stage: DraftStage, usage: DraftUsage): Promise<void>;
  validateInventory(value: unknown): unknown | Promise<unknown>;
  /** Re-run mechanical grounding against the pinned context, even after restart. */
  validate(value: unknown): CompiledObjective | Promise<CompiledObjective>;
  /** Parse full-coverage judge evidence and enforce its exact graph/inventory binding. */
  accept(value: unknown, graph: CompiledObjective, inventory: unknown): boolean;
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
}): Promise<CompilerDraftOutcome> {
  const { manager, lease, binding, callbacks } = args;
  const now = args.now ?? Date.now;
  const limits = LimitsSchema.parse({
    maxRepairs: args.limits?.maxRepairs ?? 2,
    maxInvocations: args.limits?.maxInvocations ?? 7,
    maxObservedTokens: args.limits?.maxObservedTokens ?? Number.MAX_SAFE_INTEGER,
    deadlineMs: args.limits?.deadlineMs ?? 600_000,
  });
  const records = await manager.load(binding);
  const append = async (kind: CompilerDraftRecord["kind"], payload: Record<string, unknown>) => {
    const record = await manager.append(lease, binding, records.length, kind, payload);
    records.push(record);
    return record;
  };
  if (!records.length) await append("started", { limits, startedAt: now() });
  const first = records[0];
  if (
    first?.kind !== "started" ||
    draftDigest(first.payload.limits) !== draftDigest(limits) ||
    typeof first.payload.startedAt !== "number"
  )
    throw new Error("compiler draft policy changed");
  // All known terminal usage is reconciled, including rejected and failed calls, before returning/restarting.
  let tokens = 0;
  for (const record of records.filter((item) => item.kind === "result")) {
    const usage = record.payload.usage === null ? null : UsageSchema.parse(record.payload.usage);
    if (usage) {
      tokens += usage.inputTokens + usage.outputTokens;
      await callbacks.recordUsage(
        String(record.payload.invocationId),
        record.payload.stage as DraftStage,
        usage,
      );
    }
  }
  const terminal = records.find((item) => item.kind === "selection" || item.kind === "stopped");
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
      !proposal ||
      !judged ||
      records.some((item) => item.kind === "result" && item.payload.usage === null)
    )
      throw new Error("compiler selection lacks known invocation evidence");
    const inventory = await callbacks.validateInventory(inventoryResult.payload.value);
    const graph = await callbacks.validate(proposal.payload.value);
    parsePersistedCompiledObjective(terminal.payload.graph);
    if (
      draftDigest(inventory) !== terminal.payload.inventoryDigest ||
      draftDigest(judged.payload.value) !== terminal.payload.verdictDigest ||
      !callbacks.accept(judged.payload.value, graph, inventory)
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
    await append("stopped", { reason });
    return { status: "stopped", reason, records };
  };
  class Stop extends Error {}
  const invoke = async (
    stage: DraftStage,
    revision: number,
    inventory: unknown,
    previous: CompiledObjective | null,
    failure: unknown,
  ): Promise<unknown> => {
    const invocationId = `compiler-${draftDigest({ binding, stage, revision })}`;
    const completed = records.find(
      (item) => item.kind === "result" && item.payload.invocationId === invocationId,
    );
    const reserved = records.find(
      (item) => item.kind === "invocation" && item.payload.invocationId === invocationId,
    );
    if (reserved && reserved.payload.inputDigest !== draftDigest({ inventory, previous, failure }))
      throw new Stop("invocation-input-changed");
    if (completed) {
      if (completed.payload.usage === null) throw new Stop("accounting-unavailable");
      if (completed.payload.error) throw new Error(String(completed.payload.error));
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
    await append("invocation", {
      invocationId,
      stage,
      revision,
      inputDigest: draftDigest({ inventory, previous, failure }),
    });
    let saved: DraftInvocationResult | null = null;
    const checkpoint = async (result: DraftInvocationResult): Promise<void> => {
      const usage = result.usage === null ? null : UsageSchema.parse(result.usage);
      if (saved) {
        if (draftDigest(saved) !== draftDigest({ value: result.value, usage }))
          throw new Error("conflicting compiler result checkpoint");
        return;
      }
      await append("result", { invocationId, stage, revision, value: result.value, usage });
      saved = { value: result.value, usage };
    };
    let result: DraftInvocationResult;
    try {
      result = await callbacks.invoke(
        { invocationId, stage, revision, inventory, previous, failure },
        checkpoint,
      );
      await checkpoint(result);
    } catch (error) {
      // A successful terminal checkpoint survives a caller/transport failure after it.
      if (saved) result = saved;
      else {
        const known =
          typeof error === "object" && error !== null && "usage" in error
            ? UsageSchema.safeParse(error.usage)
            : null;
        const usage = known?.success ? known.data : null;
        await append("result", {
          invocationId,
          stage,
          revision,
          value: null,
          usage,
          error:
            error instanceof Error ? error.message.slice(0, 4000) : "management invocation failed",
        });
        if (usage) {
          tokens += usage.inputTokens + usage.outputTokens;
          await callbacks.recordUsage(invocationId, stage, usage);
        } else throw new Stop("accounting-unavailable");
        throw error;
      }
    }
    const usage = result.usage;
    if (!usage) throw new Stop("accounting-unavailable");
    tokens += usage.inputTokens + usage.outputTokens;
    await callbacks.recordUsage(invocationId, stage, usage);
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
    const seen = new Set<string>();
    for (let revision = 0; revision <= limits.maxRepairs; revision++) {
      let graph: CompiledObjective;
      try {
        const value = await invoke(
          revision === 0 ? "compile" : "repair",
          revision,
          inventory,
          previous,
          failure,
        );
        graph = await callbacks.validate(value);
      } catch (error) {
        if (error instanceof Stop || error instanceof CompilerDraftReservationConflictError)
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
          error: error instanceof Error ? error.message.slice(0, 4000) : "invalid draft",
        };
        if (
          !records.some((item) => item.kind === "validation" && item.payload.revision === revision)
        )
          await append("validation", { revision, valid: false, failure });
        continue;
      }
      const graphDigest = compiledGraphDigest(graph);
      const validated = records.find(
        (item) => item.kind === "validation" && item.payload.revision === revision,
      );
      if (
        validated &&
        (validated.payload.valid !== true || validated.payload.graphDigest !== graphDigest)
      )
        throw new Stop("draft-grounding-changed");
      if (seen.has(graphDigest)) throw new Stop("draft-cycle");
      seen.add(graphDigest);
      previous = graph;
      if (!records.some((item) => item.kind === "validation" && item.payload.revision === revision))
        await append("validation", { revision, valid: true, graphDigest, graph });
      try {
        const verdict = await invoke("judge", revision, inventory, graph, null);
        if (callbacks.accept(verdict, graph, inventory)) {
          if (tokens > limits.maxObservedTokens) throw new Stop("observed-token-limit");
          if (now() - Number(first.payload.startedAt) >= limits.deadlineMs)
            throw new Stop("deadline-exhausted");
          await append("selection", {
            revision,
            graphDigest,
            graph,
            inventoryDigest: draftDigest(inventory),
            verdictDigest: draftDigest(verdict),
          });
          return { status: "accepted", revision, graphDigest, graph, records };
        }
        failure = verdict;
      } catch (error) {
        if (error instanceof Stop || error instanceof CompilerDraftReservationConflictError)
          throw error;
        failure = {
          error: error instanceof Error ? error.message.slice(0, 4000) : "invalid judge verdict",
        };
      }
    }
    return await stop("repair-limit-unresolved");
  } catch (error) {
    if (error instanceof CompilerDraftReservationConflictError) throw error;
    if (error instanceof Stop) return await stop(error.message);
    return await stop(
      `invalid-inventory: ${error instanceof Error ? error.message.slice(0, 4000) : "unknown"}`,
    );
  }
}
