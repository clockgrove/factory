import { objectiveCandidate } from "./qa.js";
import { objectiveComplete } from "./completion.js";
import { graphDigest } from "./graph-amendments.js";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import {
  type CapturePolicy,
  CaptureWriter,
  type InteractionMetadata,
} from "./capture.js";
import { stateRoot } from "./config.js";
import type {
  ModelInvocationObservation,
  ModelInvocationPhase,
  ModelInvocationUsage,
} from "./contracts.js";
import { linearDeliveryUnits } from "./delivery/plan.js";
import { failureDigest } from "./repair-policy.js";
import { itemsConflict } from "./scheduler.js";
import type {
  ContinuationState,
  CoordinatorDisposition,
  FactoryState,
  PreparationState,
  WorkState,
} from "./state.js";
import { shortPlanDigest, summarizeStatus } from "./status-summary.js";
import { type StepScope, type StepState, outageOf } from "./step.js";
import { faultDetail, type Wait } from "./fault.js";
import { normalizeTokenUsage, tokenCategories } from "./usage.js";

/** A scope's structured wait and failing step, redacted for status. */
function waitStatus(
  state: StepState,
  wait: Wait | undefined,
  scope: StepScope,
  secrets: string[],
) {
  const outage = outageOf(state, scope);
  return {
    wait: wait
      ? {
          ...wait,
          detail: redactDiagnosticDetail(wait.detail, secrets),
          ...(wait.fix
            ? { fix: redactDiagnosticDetail(wait.fix, secrets) }
            : {}),
        }
      : null,
    outage: outage
      ? {
          step: outage.step,
          since: outage.since,
          tries: outage.tries,
          last: redactDiagnosticDetail(faultDetail(outage.last), secrets),
          escalated: outage.escalated,
        }
      : null,
  };
}

export interface DiagnosticEvent {
  workerUsage?: import("./contracts.js").WorkerUsageObservation;
  capture?: InteractionMetadata;
  eventId: string;
  at: string;
  repository: string;
  objective: number;
  runId?: string;
  itemId?: string;
  attemptId?: string;
  operation: string;
  outcome: "started" | "completed" | "waiting" | "failed" | "observed";
  durationMs?: number;
  /** Safe, bounded identities only. A future exporter may copy this field. */
  metadata?: Record<string, string | number | boolean>;
  /** Private local detail. Never send this to a remote exporter by default. */
  detail?: string;
}

export function redactDiagnosticDetail(
  value: string,
  secrets: string[] = [],
): string {
  let result = value
    .replace(
      /\b(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}\b/g,
      "[REDACTED]",
    )
    .replace(/(Authorization:\s*Bearer\s+)\S+/gi, "$1[REDACTED]");
  for (const secret of secrets)
    for (const line of secret.split(/\r?\n/))
      if (line.length) result = result.split(line).join("[REDACTED]");
  return result;
}

/** Project private coordinator error strings without changing the snapshot. */
export function redactCoordinatorDisposition(
  coordinator: CoordinatorDisposition | undefined,
  secrets: string[] = [],
): CoordinatorDisposition | undefined {
  return coordinator
    ? {
        ...coordinator,
        ...(coordinator.observationError
          ? {
              observationError: redactDiagnosticDetail(
                coordinator.observationError,
                secrets,
              ),
            }
          : {}),
        ...(coordinator.cancelError
          ? {
              cancelError: redactDiagnosticDetail(
                coordinator.cancelError,
                secrets,
              ),
            }
          : {}),
        ...(coordinator.waitReason
          ? {
              waitReason: redactDiagnosticDetail(
                coordinator.waitReason,
                secrets,
              ),
            }
          : {}),
      }
    : undefined;
}

/** Keep only a suffix that could become a secret when the next chunk arrives. */
function safeStreamingPrefixLength(value: string, secrets: string[]): number {
  let hold = 0;
  const candidates = [
    ...secrets.flatMap((secret) => secret.split(/\r?\n/)).filter(Boolean),
    "ghp_",
    "gho_",
    "ghu_",
    "ghs_",
    "ghr_",
    "github_pat_",
    "sk-",
    "Authorization:",
  ];
  for (const candidate of candidates)
    for (let length = 1; length < candidate.length; length++)
      if (
        value.toLowerCase().endsWith(candidate.slice(0, length).toLowerCase())
      )
        hold = Math.max(hold, length);
  for (const prefix of [
    "ghp_",
    "gho_",
    "ghu_",
    "ghs_",
    "ghr_",
    "github_pat_",
    "sk-",
  ]) {
    const index = value.lastIndexOf(prefix);
    if (
      index >= 0 &&
      /^[A-Za-z0-9_-]*$/.test(value.slice(index + prefix.length))
    )
      hold = Math.max(hold, value.length - index);
  }
  const bearer = value.match(/Authorization:\s*Bearer\s+\S*$/i);
  if (bearer) hold = Math.max(hold, bearer[0].length);
  const partialBearer = value.match(
    /Authorization:\s*(?:B(?:e(?:a(?:r(?:e(?:r)?)?)?)?)?)?$/i,
  );
  if (partialBearer) hold = Math.max(hold, partialBearer[0].length);
  return value.length - hold;
}

export function diagnosticPath(repository: string, objective: number): string {
  return join(
    stateRoot(repository),
    "objectives",
    String(objective),
    "diagnostics.ndjson",
  );
}

export class DiagnosticEmitter {
  private streamBuffers = new Map<string, string>();
  private captureWriters = new Map<string, CaptureWriter>();
  private captureBudgets = new Map<string, { retained: number }>();
  constructor(
    private repository: string,
    private objective: number,
    private secrets: string[] = [],
    private capturePolicy?: CapturePolicy,
    private configDigest?: string,
  ) {}

  emit(
    event: Omit<DiagnosticEvent, "eventId" | "at" | "repository" | "objective">,
  ): void {
    const path = diagnosticPath(this.repository, this.objective);
    const value: DiagnosticEvent = {
      eventId: randomUUID(),
      at: new Date().toISOString(),
      repository: this.repository,
      objective: this.objective,
      ...event,
      detail:
        event.detail === undefined
          ? undefined
          : redactDiagnosticDetail(event.detail, this.secrets),
    };
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      // Refuse links. Logs are observations; a write failure cannot change lifecycle.
      const fd = openSync(
        path,
        constants.O_WRONLY |
          constants.O_APPEND |
          constants.O_CREAT |
          constants.O_NOFOLLOW,
        0o600,
      );
      try {
        if ((fstatSync(fd).mode & 0o077) !== 0)
          throw new Error("diagnostic log permissions are too broad");
        appendFileSync(fd, `${JSON.stringify(value)}\n`);
      } finally {
        closeSync(fd);
      }
    } catch (error) {
      process.stderr.write(
        `Factory diagnostics unavailable: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }

  emitStream(
    event: Omit<
      DiagnosticEvent,
      "eventId" | "at" | "repository" | "objective" | "detail"
    >,
    chunk: string,
    final = false,
  ): void {
    const key = JSON.stringify(event);
    const pending = (this.streamBuffers.get(key) ?? "") + chunk;
    const cut = final
      ? pending.length
      : safeStreamingPrefixLength(pending, this.secrets);
    if (cut) this.emit({ ...event, detail: pending.slice(0, cut) });
    if (final) this.streamBuffers.delete(key);
    else this.streamBuffers.set(key, pending.slice(cut));
  }

  modelObserver(context: {
    scopeId: string;
    runId?: string;
    itemId?: string;
    attemptId?: string;
  }): (observation: ModelInvocationObservation) => void {
    return (observation) => {
      const { scopeId, ...diagnosticContext } = context;
      const captureKey = `${observation.invocationId}:${observation.providerAttempt ?? 1}`;
      let writer = this.captureWriters.get(captureKey);
      if (!writer) {
        const budget = this.captureBudgets.get(observation.invocationId) ?? {
          retained: 0,
        };
        this.captureBudgets.set(observation.invocationId, budget);
        writer = new CaptureWriter(
          {
            repository: this.repository,
            objective: this.objective,
            ...context,
            invocationId: observation.invocationId,
            providerAttempt: observation.providerAttempt ?? 1,
            phase: observation.phase,
            adapter: observation.adapter ?? "@openai/codex-sdk@0.156.0",
            configured: {
              provider: observation.provider ?? "openai-codex-sdk",
              model: observation.model ?? "not-exposed",
              reasoningEffort: observation.reasoningEffort,
            },
            configDigest: this.configDigest,
          },
          this.capturePolicy,
          this.secrets,
          (capture) =>
            this.emit({
              ...diagnosticContext,
              operation: "model-capture",
              outcome: "observed",
              capture,
            }),
          budget,
        );
        this.captureWriters.set(captureKey, writer);
      }
      if (observation.capture)
        writer.record(observation.capture.event, observation.capture.content);
      // A capture-only evaluation is not another provider progress observation.
      if (
        observation.capture &&
        observation.type === "progress" &&
        !observation.providerEvent
      )
        return;
      if (
        observation.type === "completed" ||
        observation.type === "failed" ||
        observation.type === "response-invalid"
      ) {
        const stage =
          observation.type === "response-invalid"
            ? observation.failureClass === "structured-output-parse"
              ? "parse"
              : observation.failureClass === "review-protocol"
                ? "protocol"
                : "semantic"
            : "provider";
        writer.record({
          kind: "outcome",
          durationMs: observation.durationMs,
          providerSessionId: observation.providerThreadId,
          outcome: {
            stage,
            status:
              observation.type === "response-invalid"
                ? "invalid"
                : observation.type,
            failureClass: observation.failureClass,
          },
          ...(observation.usage && {
            usage: {
              scope: "invocation-cumulative",
              terminal: true,
              completeness: observation.usageAvailable
                ? "available-categories"
                : "unavailable",
              normalized: observation.usage,
              deduplicationKey: captureKey,
            },
          }),
        });
      }

      const metadata: Record<string, string | number | boolean> = {
        scopeId,
        invocationId: observation.invocationId,
        phase: observation.phase,
        ordinal: observation.ordinal,
        observationType: observation.type,
      };
      for (const [key, value] of Object.entries({
        providerAttempt: observation.providerAttempt,
        providerMaxAttempts: observation.providerMaxAttempts,
        retryDelayMs: observation.retryDelayMs,
        provider: observation.provider,
        model: observation.model,
        reasoningEffort: observation.reasoningEffort,
        providerThreadId: observation.providerThreadId,
        promptBytes: observation.promptBytes,
        promptDigest: observation.promptDigest,
        schemaBytes: observation.schemaBytes,
        schemaDigest: observation.schemaDigest,
        sourcePacketBytes: observation.sourcePacketBytes,
        sourcePacketDigest: observation.sourcePacketDigest,
        responseBytes: observation.responseBytes,
        responseDigest: observation.responseDigest,
        providerEvent: observation.providerEvent,
        providerItemId: observation.providerItemId,
        providerItemType: observation.providerItemType,
        tool: observation.tool,
        usageAvailable: observation.usageAvailable,
        failureClass: observation.failureClass,
        failureField: observation.failureField,
        failureReason: observation.failureReason,
        failureSource: observation.failureSource,
        ...(observation.usage ?? {}),
      }))
        if (["string", "number", "boolean"].includes(typeof value))
          metadata[key] = value as string | number | boolean;
      const detailLimit = 4096;
      const redactedDetail =
        observation.detail === undefined
          ? undefined
          : redactDiagnosticDetail(observation.detail, this.secrets);
      if ((redactedDetail?.length ?? 0) > detailLimit)
        metadata.detailTruncated = true;
      this.emit({
        ...diagnosticContext,
        operation: "model-invocation",
        outcome:
          observation.type === "started"
            ? "started"
            : observation.type === "completed"
              ? "completed"
              : observation.type === "failed" ||
                  observation.type === "response-invalid"
                ? "failed"
                : "observed",
        durationMs: observation.durationMs,
        metadata,
        detail: redactedDetail?.slice(0, detailLimit),
      });
    };
  }

  async span<T>(
    context: Pick<
      DiagnosticEvent,
      "operation" | "runId" | "itemId" | "attemptId" | "metadata"
    >,
    task: () => Promise<T>,
    completedMetadata?: (
      result: T,
    ) => Record<string, string | number | boolean>,
    errorOutcome?: (error: unknown) => "waiting" | "failed",
  ): Promise<T> {
    const started = Date.now();
    this.emit({ ...context, outcome: "started" });
    try {
      const result = await task();
      let metadata = context.metadata;
      try {
        metadata = { ...metadata, ...completedMetadata?.(result) };
      } catch (error) {
        process.stderr.write(
          `Factory diagnostics unavailable: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
      this.emit({
        ...context,
        outcome: "completed",
        durationMs: Date.now() - started,
        metadata,
      });
      return result;
    } catch (error) {
      this.emit({
        ...context,
        outcome: errorOutcome?.(error) ?? "failed",
        durationMs: Date.now() - started,
        detail: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}

export interface ModelInvocationAggregate {
  invocationCount: number;
  completedCount: number;
  failedCount: number;
  activeCount: number;
  usageAvailableCount: number;
  usageUnavailableCount: number;
  tokenTotals: Partial<ModelInvocationUsage>;
  tokenAvailability: Partial<Record<keyof ModelInvocationUsage, number>>;
  cacheReadRatio: {
    numeratorCachedInputTokens: number;
    denominatorInputTokens: number;
    value: number;
  } | null;
  lastProgressAt?: string;
}

export interface ModelInvocationSummary {
  scope: "planning-and-review-model-invocations";
  objective: ModelInvocationAggregate;
  byPhase: Partial<Record<ModelInvocationPhase, ModelInvocationAggregate>>;
  byScope: Record<string, ModelInvocationAggregate>;
}

type ModelEvent = Pick<DiagnosticEvent, "at" | "operation" | "metadata">;

/** Derive observational totals without treating absent provider usage as zero. */
export function summarizeModelInvocations(
  events: Array<ModelEvent | Record<string, unknown>>,
): ModelInvocationSummary {
  const invocations = new Map<
    string,
    {
      phase: ModelInvocationPhase;
      scopeId: string;
      events: ModelEvent[];
    }
  >();
  for (const rawEvent of events) {
    const event = rawEvent as ModelEvent;
    if (event.operation !== "model-invocation") continue;
    const invocationId = event.metadata?.invocationId;
    const phase = event.metadata?.phase;
    const scopeId = event.metadata?.scopeId;
    if (
      typeof invocationId !== "string" ||
      ![
        "compile",
        "diagnosis",
        "graph-review",
        "result-review",
        "objective-review",
      ].includes(String(phase)) ||
      typeof scopeId !== "string"
    )
      continue;
    const providerAttempt =
      typeof event.metadata?.providerAttempt === "number"
        ? event.metadata.providerAttempt
        : 1;
    const invocationKey = `${invocationId}:${providerAttempt}`;
    const entry = invocations.get(invocationKey) ?? {
      phase: phase as ModelInvocationPhase,
      scopeId,
      events: [],
    };
    entry.events.push(event);
    invocations.set(invocationKey, entry);
  }
  const all = [...invocations.values()];
  const aggregate = (selected: typeof all): ModelInvocationAggregate => {
    const totals: Partial<ModelInvocationUsage> = {};
    const availability: Partial<Record<keyof ModelInvocationUsage, number>> =
      {};
    let completedCount = 0;
    let failedCount = 0;
    let usageAvailableCount = 0;
    let usageUnavailableCount = 0;
    let cacheRatioInputTokens = 0;
    let cacheRatioCachedInputTokens = 0;
    let cacheRatioInvocationCount = 0;
    let lastProgressAt: string | undefined;
    for (const invocation of selected) {
      const observations = invocation.events.map(
        (event) => event.metadata?.observationType,
      );
      const failed = observations.some(
        (type) => type === "failed" || type === "response-invalid",
      );
      const completed = observations.includes("completed");
      if (failed) failedCount += 1;
      else if (completed) completedCount += 1;
      for (const event of invocation.events)
        if (
          event.metadata?.observationType === "progress" &&
          (!lastProgressAt || event.at > lastProgressAt)
        )
          lastProgressAt = event.at;
      if (!failed && !completed) continue;
      const usageEvent = [...invocation.events]
        .reverse()
        .find((event) => event.metadata?.usageAvailable === true);
      if (!usageEvent) {
        usageUnavailableCount += 1;
        continue;
      }
      usageAvailableCount += 1;
      const inputTokens = usageEvent.metadata?.inputTokens;
      const cachedInputTokens = usageEvent.metadata?.cachedInputTokens;
      if (
        typeof inputTokens === "number" &&
        typeof cachedInputTokens === "number"
      ) {
        cacheRatioInputTokens += inputTokens;
        cacheRatioCachedInputTokens += cachedInputTokens;
        cacheRatioInvocationCount += 1;
      }
      for (const key of [
        "inputTokens",
        "cachedInputTokens",
        "cacheWriteInputTokens",
        "outputTokens",
        "reasoningOutputTokens",
        "totalTokens",
      ] as const) {
        const value = usageEvent.metadata?.[key];
        if (typeof value !== "number") continue;
        totals[key] = (totals[key] ?? 0) + value;
        availability[key] = (availability[key] ?? 0) + 1;
      }
    }
    return {
      invocationCount: selected.length,
      completedCount,
      failedCount,
      activeCount: selected.length - completedCount - failedCount,
      usageAvailableCount,
      usageUnavailableCount,
      tokenTotals: totals,
      tokenAvailability: availability,
      cacheReadRatio:
        cacheRatioInvocationCount > 0 && cacheRatioInputTokens > 0
          ? {
              numeratorCachedInputTokens: cacheRatioCachedInputTokens,
              denominatorInputTokens: cacheRatioInputTokens,
              value: cacheRatioCachedInputTokens / cacheRatioInputTokens,
            }
          : null,
      ...(lastProgressAt ? { lastProgressAt } : {}),
    };
  };
  const phases: ModelInvocationPhase[] = [
    "compile",
    "diagnosis",
    "graph-review",
    "result-review",
    "objective-review",
  ];
  return {
    scope: "planning-and-review-model-invocations",
    objective: aggregate(all),
    byPhase: Object.fromEntries(
      phases.flatMap((phase) => {
        const selected = all.filter((entry) => entry.phase === phase);
        return selected.length ? [[phase, aggregate(selected)]] : [];
      }),
    ),
    byScope: Object.fromEntries(
      [...new Set(all.map((entry) => entry.scopeId))].map((scopeId) => [
        scopeId,
        aggregate(all.filter((entry) => entry.scopeId === scopeId)),
      ]),
    ),
  };
}

/** Summary-only telemetry: never read evidence or reconstruct execution state. */
export function summarizeDiagnosticUsage(events: Record<string, unknown>[]) {
  const model = summarizeModelInvocations(events);
  const workerEvents: ModelEvent[] = [];
  const observedAttempts = new Set<string>();
  const knownAttempts = new Set<string>();
  const identities = new Map<
    string,
    {
      attemptId: string;
      invocationId: string;
      providerAttempt: number;
      profileId?: string;
      adapter?: string;
      model?: string;
      reasoningEffort?: string;
      runId?: string;
      itemId?: string;
    }
  >();
  for (const event of events) {
    if (event.operation === "harness" && typeof event.attemptId === "string")
      knownAttempts.add(event.attemptId);
    if (
      event.operation !== "worker-usage" ||
      typeof event.attemptId !== "string"
    )
      continue;
    const value = event.workerUsage;
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const observation = value as Record<string, unknown>;
    if (
      observation.role !== "worker" ||
      observation.phase !== "implementation" ||
      typeof observation.invocationId !== "string" ||
      !observation.invocationId ||
      typeof observation.providerAttempt !== "number" ||
      !Number.isSafeInteger(observation.providerAttempt) ||
      observation.providerAttempt < 1 ||
      !["started", "progress", "completed", "failed"].includes(
        String(observation.type),
      )
    )
      continue;
    const key = JSON.stringify([
      event.attemptId,
      observation.invocationId,
      observation.providerAttempt,
    ]);
    const usage = normalizeTokenUsage(observation.usage);
    observedAttempts.add(event.attemptId);
    identities.set(key, {
      attemptId: event.attemptId,
      invocationId: observation.invocationId,
      providerAttempt: observation.providerAttempt,
      ...Object.fromEntries(
        ["profileId", "adapter", "model", "reasoningEffort"].flatMap((key) =>
          typeof observation[key] === "string" ? [[key, observation[key]]] : [],
        ),
      ),
      ...(typeof event.runId === "string" ? { runId: event.runId } : {}),
      ...(typeof event.workItemId === "string"
        ? { itemId: event.workItemId }
        : {}),
    });
    workerEvents.push({
      at: String(event.at ?? ""),
      operation: "model-invocation",
      metadata: {
        invocationId: key,
        providerAttempt: 1,
        phase: "compile",
        scopeId: key,
        observationType: String(observation.type),
        usageAvailable: Object.keys(usage).length > 0,
        ...usage,
      },
    });
  }
  // Reuse only the observational counter aggregation, not model phase semantics.
  const workers = summarizeModelInvocations(workerEvents);
  const unobservedAttemptCount = [...knownAttempts].filter(
    (id) => !observedAttempts.has(id),
  ).length;
  const combine = (
    left: ModelInvocationAggregate,
    right: ModelInvocationAggregate,
  ): ModelInvocationAggregate => {
    const tokenTotals: ModelInvocationUsage = {};
    const tokenAvailability: Partial<
      Record<keyof ModelInvocationUsage, number>
    > = {};
    for (const key of tokenCategories) {
      if (
        left.tokenTotals[key] !== undefined ||
        right.tokenTotals[key] !== undefined
      )
        tokenTotals[key] =
          (left.tokenTotals[key] ?? 0) + (right.tokenTotals[key] ?? 0);
      if (
        left.tokenAvailability[key] !== undefined ||
        right.tokenAvailability[key] !== undefined
      )
        tokenAvailability[key] =
          (left.tokenAvailability[key] ?? 0) +
          (right.tokenAvailability[key] ?? 0);
    }
    const numerator =
      (left.cacheReadRatio?.numeratorCachedInputTokens ?? 0) +
      (right.cacheReadRatio?.numeratorCachedInputTokens ?? 0);
    const denominator =
      (left.cacheReadRatio?.denominatorInputTokens ?? 0) +
      (right.cacheReadRatio?.denominatorInputTokens ?? 0);
    return {
      invocationCount: left.invocationCount + right.invocationCount,
      completedCount: left.completedCount + right.completedCount,
      failedCount: left.failedCount + right.failedCount,
      activeCount: left.activeCount + right.activeCount,
      usageAvailableCount: left.usageAvailableCount + right.usageAvailableCount,
      usageUnavailableCount:
        left.usageUnavailableCount + right.usageUnavailableCount,
      tokenTotals,
      tokenAvailability,
      cacheReadRatio:
        denominator > 0
          ? {
              numeratorCachedInputTokens: numerator,
              denominatorInputTokens: denominator,
              value: numerator / denominator,
            }
          : null,
    };
  };
  const coverage = (aggregate: ModelInvocationAggregate, unobserved = 0) => ({
    unobservedAttemptCount: unobserved,
    byCategory: Object.fromEntries(
      tokenCategories.map((key) => {
        const supplied = aggregate.tokenAvailability[key] ?? 0;
        const terminal = aggregate.completedCount + aggregate.failedCount;
        return [
          key,
          supplied === 0
            ? "unavailable"
            : supplied === terminal &&
                aggregate.activeCount === 0 &&
                unobserved === 0
              ? "available"
              : "partial",
        ];
      }),
    ),
  });
  const combined = combine(model.objective, workers.objective);
  return {
    ...model,
    modelUsage: {
      scope: model.scope,
      ...model.objective,
      coverage: coverage(model.objective),
    },
    workerUsage: {
      scope: "worker-implementation-invocations",
      role: "worker",
      phase: "implementation",
      ...workers.objective,
      coverage: coverage(workers.objective, unobservedAttemptCount),
      byInvocation: Object.fromEntries(
        Object.entries(workers.byScope).map(([key, aggregate]) => [
          key,
          {
            ...identities.get(key),
            ...aggregate,
            coverage: coverage(aggregate),
          },
        ]),
      ),
    },
    combinedUsage: {
      scope: "observed-model-and-worker-invocations",
      ...combined,
      coverage: coverage(combined, unobservedAttemptCount),
    },
  };
}

export function readDiagnosticMetadata(
  repository: string,
  objective: number,
): Omit<DiagnosticEvent, "detail">[] {
  const path = diagnosticPath(repository, objective);
  if (!existsSync(path)) return [];
  const events: Omit<DiagnosticEvent, "detail">[] = [];
  for (const { detail: _detail, ...event } of privateRecords(path))
    events.push(event as Omit<DiagnosticEvent, "detail">);
  return events;
}

export function readDiagnostics(
  repository: string,
  objective: number,
): DiagnosticEvent[] {
  const path = diagnosticPath(repository, objective);
  if (!existsSync(path)) return [];
  return completeLines(readPrivateFile(path)).map(
    (line) => JSON.parse(line) as DiagnosticEvent,
  );
}

function completeLines(value: string): string[] {
  const lines = value.split("\n");
  if (lines.at(-1) !== "") lines.pop();
  return lines.filter(Boolean);
}

function readPrivateFile(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0)
      throw new Error(
        "Private diagnostic file is not a restricted regular file",
      );
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

export function readWorkerOutput(
  repository: string,
  attemptId: string,
): string {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      attemptId,
    )
  )
    throw new Error("Invalid worker attempt ID");
  const path = join(stateRoot(repository), "harness", `${attemptId}.log`);
  if (!existsSync(path))
    throw new Error("Worker output unavailable for this attempt");
  return readPrivateFile(path);
}

export function readAgentTimeline(
  repository: string,
  objective: number,
  state?: FactoryState,
): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = readDiagnostics(
    repository,
    objective,
  ).map((event) => ({ ...event }));
  const root = join(stateRoot(repository), "harness");
  if (existsSync(root)) {
    const itemByAttempt = new Map<string, string>(
      events
        .filter(
          (event) =>
            typeof event.attemptId === "string" &&
            typeof event.itemId === "string",
        )
        .map((event) => [event.attemptId as string, event.itemId as string]),
    );
    const runByAttempt = new Map<string, string>(
      events
        .filter(
          (event) =>
            typeof event.attemptId === "string" &&
            typeof event.runId === "string",
        )
        .map((event) => [event.attemptId as string, event.runId as string]),
    );
    for (const [id, work] of Object.entries(state?.work ?? {}))
      if (work.attempt) {
        itemByAttempt.set(work.attempt, id);
        if (state?.runId) runByAttempt.set(work.attempt, state.runId);
      }
    for (const name of readdirSync(root).filter((name) =>
      /^[0-9a-f-]{36}\.progress\.ndjson$/.test(name),
    )) {
      const path = join(root, name);
      const attemptId = name.slice(0, 36);
      if (!itemByAttempt.has(attemptId)) continue;
      for (const line of completeLines(readPrivateFile(path))) {
        const event = JSON.parse(line) as Record<string, unknown>;
        events.push({
          ...event,
          repository,
          objective,
          runId: runByAttempt.get(attemptId),
          workItemId: itemByAttempt.get(attemptId),
          attemptId,
        });
      }
    }
  }
  return events.sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

/** Parse every complete record, retaining at most the current record text. */
export function* privateRecords(
  path: string,
): Generator<Record<string, unknown>> {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0)
      throw new Error(
        "Private diagnostic file is not a restricted regular file",
      );
    const buffer = Buffer.alloc(64 * 1024);
    const decoder = new StringDecoder("utf8");
    let pending = "";
    for (;;) {
      const bytes = readSync(fd, buffer, 0, buffer.length, null);
      if (bytes === 0) break;
      pending += decoder.write(buffer.subarray(0, bytes));
      let start = 0;
      for (;;) {
        const end = pending.indexOf("\n", start);
        if (end < 0) break;
        const line = pending.slice(start, end);
        if (line) yield { ...JSON.parse(line) } as Record<string, unknown>;
        start = end + 1;
      }
      pending = pending.slice(start);
    }
    // Like completeLines, ignore the final unterminated record, even if valid.
  } finally {
    closeSync(fd);
  }
}

function usageEvent(
  event: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const { at, operation, attemptId, runId, workItemId } = event;
  if (operation === "harness") return { at, operation, attemptId };
  if (operation === "model-invocation") {
    const metadata = event.metadata as DiagnosticEvent["metadata"];
    return {
      at,
      operation,
      metadata:
        metadata &&
        Object.fromEntries(
          [
            "invocationId",
            "providerAttempt",
            "phase",
            "scopeId",
            "observationType",
            "usageAvailable",
            ...tokenCategories,
          ].map((key) => [key, metadata[key]]),
        ),
    };
  }
  if (operation !== "worker-usage") return;
  const value = event.workerUsage;
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const observation = value as Record<string, unknown>;
  return {
    at,
    operation,
    attemptId,
    runId,
    workItemId,
    workerUsage: {
      type: observation.type,
      role: observation.role,
      phase: observation.phase,
      invocationId: observation.invocationId,
      providerAttempt: observation.providerAttempt,
      ...Object.fromEntries(
        ["profileId", "adapter", "model", "reasoningEffort"].flatMap((key) =>
          typeof observation[key] === "string" ? [[key, observation[key]]] : [],
        ),
      ),
      usage: normalizeTokenUsage(observation.usage),
    },
  };
}

/** Summary input only: stream private files without retaining command detail. */
export function readUsageSummaryEvents(
  repository: string,
  objective: number,
  state?: FactoryState,
): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  const itemByAttempt = new Map<string, string>();
  const runByAttempt = new Map<string, string>();
  const path = diagnosticPath(repository, objective);
  if (existsSync(path))
    for (const event of privateRecords(path)) {
      // Match timeline correlation from all controller records, in file order.
      if (typeof event.attemptId === "string") {
        if (typeof event.itemId === "string")
          itemByAttempt.set(event.attemptId, event.itemId);
        if (typeof event.runId === "string")
          runByAttempt.set(event.attemptId, event.runId);
      }
      const selected = usageEvent(event);
      if (selected) events.push(selected);
    }
  for (const [id, work] of Object.entries(state?.work ?? {}))
    if (work.attempt) {
      itemByAttempt.set(work.attempt, id);
      if (state?.runId) runByAttempt.set(work.attempt, state.runId);
    }
  const root = join(stateRoot(repository), "harness");
  if (existsSync(root))
    for (const name of readdirSync(root).filter((name) =>
      /^[0-9a-f-]{36}\.progress\.ndjson$/.test(name),
    )) {
      const attemptId = name.slice(0, 36);
      if (!itemByAttempt.has(attemptId)) continue;
      for (const event of privateRecords(join(root, name))) {
        const selected = usageEvent({
          ...event,
          attemptId,
          runId: runByAttempt.get(attemptId),
          workItemId: itemByAttempt.get(attemptId),
        });
        if (selected) events.push(selected);
      }
    }
  return events.sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

export function statusDocument(
  state: FactoryState | undefined,
  repository: string,
  objective: number,
  delivery: "regular" | "native-stack",
  secrets: string[] = [],
  concurrency?: number,
  runActive: boolean | null = null,
) {
  if (!state) {
    const view = {
      repository,
      objective,
      state: "not-started" as const,
      work: [],
    };
    return { ...summarizeStatus(view), ...view };
  }
  const unitByItem = new Map(
    linearDeliveryUnits(state.graph).flatMap((unit) =>
      unit.items.map((item) => [item.id, unit.id] as const),
    ),
  );
  const pendingDecision = (pending: FactoryState["finalAcceptancePending"]) =>
    pending
      ? {
          criterion: redactDiagnosticDetail(pending.criterion, secrets),
          treeSha: pending.treeSha,
          source: pending.source,
          question: redactDiagnosticDetail(pending.question, secrets),
          detail: redactDiagnosticDetail(pending.detail, secrets),
          reviewFinding: pending.reviewFinding
            ? Object.fromEntries(
                Object.entries(pending.reviewFinding).map(([key, value]) => [
                  key,
                  redactDiagnosticDetail(value, secrets),
                ]),
              )
            : null,
          reviewRejection: pending.reviewRejection ?? null,
        }
      : null;
  const activeCount = Object.values(state.work).filter(
    (item) =>
      item.phaseReservation === "coding" ||
      (!item.phaseReservation &&
        item.status === "running" &&
        item.step === "execute"),
  ).length;
  const configuredSlots =
    concurrency === undefined
      ? undefined
      : Math.max(0, concurrency - activeCount);
  const work = state.graph.items.map((item) => {
    const current = state.work[item.id]!;
    let blockedReason: string | undefined = current.requestedPhase
      ? current.waitingReason
      : undefined;
    let eligible = false;
    if (current.status === "pending") {
      const dependency = item.dependencies.find(
        (id) =>
          state.work[id]?.status !== "done" &&
          !(
            delivery === "native-stack" &&
            state.work[id]?.status === "published" &&
            unitByItem.get(id) === unitByItem.get(item.id)
          ),
      );
      const conflict = state.graph.items.find(
        (candidate) =>
          state.work[candidate.id]?.status === "running" &&
          itemsConflict(item, candidate),
      );
      eligible = !dependency && !conflict;
      blockedReason = dependency
        ? `dependency:${dependency}`
        : conflict
          ? `resource:${conflict.id}`
          : item.kind !== "qa" &&
              item.kind !== "aggregate" &&
              configuredSlots === 0
            ? "capacity"
            : current.waitingReason;
    } else if (current.status === "waiting")
      blockedReason =
        current.step === "approve-result"
          ? "acceptance-decision"
          : (current.waitingReason ?? "asset-selection");
    return {
      id: item.id,
      issue: state.issueByItemId[item.id],
      status: current.status,
      step: current.step ?? null,
      phaseReservation: current.phaseReservation ?? null,
      requestedPhase: current.requestedPhase ?? null,
      priority: item.priority ?? 0,
      eligible,
      // Provider capacity is not persisted in the state snapshot.
      ready: current.status === "pending" && !blockedReason ? null : false,
      blockedReason: blockedReason ?? null,
      waitingReason: current.waitingReason
        ? redactDiagnosticDetail(current.waitingReason, secrets)
        : null,
      attemptId: current.attempt ?? null,
      ...(item.executionBinding
        ? {
            assignedExecution: item.executionBinding,
            actualExecution:
              (
                current.execution?.data as
                  | { executionBinding?: unknown }
                  | undefined
              )?.executionBinding ?? null,
          }
        : {}),
      providerProgress:
        current.attempt &&
        existsSync(
          join(
            stateRoot(repository),
            "harness",
            `${current.attempt}.progress.ndjson`,
          ),
        )
          ? "streamed"
          : "unavailable",
      baseSha: current.baseSha ?? null,
      treeSha: current.treeSha ?? null,
      headSha: current.changeRef ?? null,
      pullRequest: current.pullRequest ?? null,
      stack: state.stackNumbers?.[unitByItem.get(item.id) ?? ""] ?? null,
      candidateAssetSets: current.assets?.map((set) => set.id) ?? [],
      assetSets:
        current.assets?.map((set) => ({
          id: set.id,
          members: set.members.map((member) => ({
            role: member.role,
            destination: member.destination,
            digest: member.ref.digest,
          })),
        })) ?? [],
      selectedAssetSet: current.selectedAssetSet ?? null,
      acceptancePending: pendingDecision(current.acceptancePending),
      lastError: current.error
        ? redactDiagnosticDetail(current.error, secrets)
        : null,
      ...waitStatus(state, current.wait, { item: item.id }, secrets),
      authentication: current.authentication
        ? {
            provider: redactDiagnosticDetail(
              current.authentication.provider,
              secrets,
            ),
            command: redactDiagnosticDetail(
              current.authentication.command,
              secrets,
            ),
          }
        : null,
    };
  });
  const view = {
    repository,
    objective,
    runActive,
    state: state.cancelledAt
      ? ("cancelled" as const)
      : state.error
        ? ("failed" as const)
        : state.finalAcceptancePending
          ? ("waiting" as const)
          : objectiveComplete(state)
            ? ("complete" as const)
            : ("active" as const),
    runId: state.runId,
    coordinator:
      redactCoordinatorDisposition(state.coordinator, secrets) ?? null,
    graphDigest: graphDigest(state.graph),
    graphRevisionCount: state.graphRevisions?.length ?? 1,
    pendingAmendment: state.pendingAmendment
      ? {
          id: state.pendingAmendment.id,
          phase: state.pendingAmendment.phase,
          expectedGraphDigest:
            state.pendingAmendment.proposal.expectedGraphDigest,
          failureDigest: state.pendingAmendment.error
            ? failureDigest(state.pendingAmendment.error)
            : null,
          error: state.pendingAmendment.error
            ? redactDiagnosticDetail(state.pendingAmendment.error, secrets)
            : null,
        }
      : null,
    allowanceConsumption: state.allowanceConsumption ?? null,
    repairConsumption: state.repairConsumption ?? null,
    repairs: Object.fromEntries(
      Object.entries(state.work)
        .filter(([, work]) => work.recovery)
        .map(([id, work]) => [
          id,
          {
            phase: work.recovery!.phase ?? null,
            failureClass: work.recovery!.failure?.classification ?? null,
            failureDigest: work.recovery!.failure?.digest ?? null,
            continuation: work.recovery!.failure?.continuation ?? null,
            unfinishedEdits: work.recovery!.failure?.unfinishedEdits ?? null,
            priorAttempts: work.recovery!.history?.length ?? 0,
            nextDecision: work.recovery!.failure?.decision
              ? redactDiagnosticDetail(work.recovery!.failure.decision, secrets)
              : null,
          },
        ]),
    ),
    configuredSlots: configuredSlots ?? null,
    baseSha: state.baseSha,
    integratedSha: state.integratedSha ?? null,
    candidate: objectiveCandidate(state) ?? null,
    finalValidation: state.finalValidation?.passed ?? false,
    finalAcceptance: state.finalAcceptance ?? null,
    finalAcceptancePending: pendingDecision(state.finalAcceptancePending),
    objectiveClosure: state.objectiveClosure ?? null,
    lastError:
      state.error || state.githubClosureError
        ? redactDiagnosticDetail(
            state.error ?? state.githubClosureError!,
            secrets,
          )
        : null,
    githubClosureError: state.githubClosureError
      ? redactDiagnosticDetail(state.githubClosureError, secrets)
      : null,
    ...waitStatus(state, state.wait, "objective", secrets),
    work,
  };
  return { ...summarizeStatus(view), ...view };
}

/** Status of an Objective still planning; no executable graph exists yet. */
export function preparationStatusDocument(
  preparation: PreparationState,
  secrets: string[] = [],
  runActive: boolean | null = null,
) {
  const redact = (value: string | undefined) =>
    value ? redactDiagnosticDetail(value, secrets) : null;
  const review = preparation.plan?.review;
  const question = review?.failure?.question ?? review?.findings?.[0]?.question;
  const view = {
    repository: preparation.repository,
    objective: preparation.objective,
    runId: preparation.runId,
    runActive,
    state: "preparing" as const,
    coordinator:
      redactCoordinatorDisposition(preparation.coordinator, secrets) ?? null,
    planned: Boolean(preparation.plan),
    planReview: review?.status
      ? {
          status: review.status,
          question: redact(question),
          digest: shortPlanDigest(preparation.plan!),
        }
      : null,
    planningStopped:
      !preparation.plan && preparation.planningRecovery?.phase === "stopped",
    issueByItemId: preparation.issueByItemId,
    cancelledAt: preparation.cancelledAt ?? null,
    error: redact(preparation.error),
    waitReason: redact(preparation.coordinator.waitReason),
    ...waitStatus(preparation, preparation.wait, "objective", secrets),
  };
  return { ...summarizeStatus(view), ...view };
}

/** The status document for whichever continuation snapshot exists. */
export function continuationStatusDocument(
  continuation: ContinuationState | undefined,
  repository: string,
  objective: number,
  delivery: "regular" | "native-stack",
  secrets: string[] = [],
  concurrency?: number,
  runActive: boolean | null = null,
) {
  return continuation?.schemaVersion === 7
    ? preparationStatusDocument(continuation, secrets, runActive)
    : statusDocument(
        continuation,
        repository,
        objective,
        delivery,
        secrets,
        concurrency,
        runActive,
      );
}

/** Observe snapshot changes after saving; the snapshot alone controls continuation. */
export class StateDiagnostics {
  private previous = new Map<string, WorkState>();
  private previousReadiness = new Map<string, string>();
  private previousStacks = new Map<string, number>();
  private previousFinal = false;
  private previousFinalPending?: string | null;
  private previousIntegrated?: string;
  constructor(
    private emitter: DiagnosticEmitter,
    private state: FactoryState,
    private delivery: "regular" | "native-stack",
    private concurrency: number,
  ) {}

  observe(): void {
    for (const [id, work] of Object.entries(this.state.work)) {
      const before = this.previous.get(id);
      if (
        work.acceptancePending &&
        before?.acceptancePending?.treeSha !== work.acceptancePending.treeSha
      ) {
        this.emitter.emit({
          runId: this.state.runId,
          itemId: id,
          attemptId: work.attempt,
          operation: "acceptance-pending",
          outcome: before ? "waiting" : "observed",
          metadata: { treeSha: work.acceptancePending.treeSha },
          detail: JSON.stringify({
            question: work.acceptancePending.question,
            detail: work.acceptancePending.detail,
            reviewFinding: work.acceptancePending.reviewFinding ?? null,
            reviewRejection: work.acceptancePending.reviewRejection ?? null,
          }),
        });
      }
      if (
        before?.execution?.identity !== work.execution?.identity &&
        (before?.execution || work.execution)
      ) {
        this.emitter.emit({
          runId: this.state.runId,
          itemId: id,
          attemptId: work.attempt,
          operation: "harness",
          outcome: !before
            ? "observed"
            : work.execution
              ? "started"
              : "completed",
          durationMs:
            before?.execution && !work.execution && work.startedAt
              ? Math.max(0, Date.now() - Date.parse(work.startedAt))
              : undefined,
          metadata: {
            ...(() => {
              const assigned = this.state.graph.items.find(
                (item) => item.id === id,
              )?.executionBinding;
              const actual = (
                (work.execution ?? before?.execution)?.data as
                  | {
                      executionBinding?: {
                        id: string;
                        adapter: string;
                        model?: string;
                        reasoningEffort?: string;
                        digest: string;
                      };
                    }
                  | undefined
              )?.executionBinding;
              return {
                ...(assigned
                  ? {
                      assignedProfile: assigned.id,
                      assignedAdapter: assigned.adapter,
                      profileDigest: assigned.digest,
                    }
                  : {}),
                ...(actual
                  ? {
                      actualProfile: actual.id,
                      actualAdapter: actual.adapter,
                      ...(actual.model ? { actualModel: actual.model } : {}),
                      ...(actual.reasoningEffort
                        ? { actualReasoningEffort: actual.reasoningEffort }
                        : {}),
                    }
                  : {}),
              };
            })(),
            provider:
              work.execution?.provider ??
              before?.execution?.provider ??
              "unknown",
          },
        });
      }
      if (
        !before ||
        before.status !== work.status ||
        before.step !== work.step ||
        before.pullRequest !== work.pullRequest ||
        before.githubClosure !== work.githubClosure
      ) {
        const outcome = !before
          ? "observed"
          : work.status === "failed" || work.status === "cancelled"
            ? "failed"
            : work.status === "waiting"
              ? "waiting"
              : work.status === "done"
                ? "completed"
                : work.status === "pending"
                  ? "observed"
                  : "started";
        const operation =
          before?.githubClosure !== work.githubClosure &&
          work.githubClosure === "complete"
            ? "github-closure"
            : (work.step ??
              (work.pullRequest && work.status === "done"
                ? "merge"
                : work.status));
        this.emitter.emit({
          runId: this.state.runId,
          itemId: id,
          attemptId: work.attempt,
          operation,
          outcome,
          durationMs:
            work.completedAt && work.startedAt
              ? Math.max(
                  0,
                  Date.parse(work.completedAt) - Date.parse(work.startedAt),
                )
              : undefined,
          metadata: {
            ...(this.state.issueByItemId[id]
              ? { issue: this.state.issueByItemId[id] }
              : {}),
            ...(work.pullRequest ? { pullRequest: work.pullRequest } : {}),
            ...(work.baseSha ? { baseSha: work.baseSha } : {}),
            ...(work.treeSha ? { treeSha: work.treeSha } : {}),
          },
          detail: work.error,
        });
      }
      this.previous.set(id, { ...work });
    }
    const finalPending = this.state.finalAcceptancePending?.treeSha ?? null;
    if (finalPending && finalPending !== this.previousFinalPending)
      this.emitter.emit({
        runId: this.state.runId,
        operation: "objective-acceptance-pending",
        outcome:
          this.previousFinalPending === undefined ? "observed" : "waiting",
        metadata: { treeSha: finalPending },
        detail: this.state.finalAcceptancePending
          ? JSON.stringify({
              question: this.state.finalAcceptancePending.question,
              detail: this.state.finalAcceptancePending.detail,
              reviewFinding:
                this.state.finalAcceptancePending.reviewFinding ?? null,
              reviewRejection:
                this.state.finalAcceptancePending.reviewRejection ?? null,
            })
          : undefined,
      });
    this.previousFinalPending = finalPending;
    const view = statusDocument(
      this.state,
      this.state.repository,
      this.state.objective,
      this.delivery,
      [],
      this.concurrency,
    );
    for (const item of view.work) {
      const reason =
        item.status === "pending"
          ? (item.blockedReason ?? "eligible-provider-unknown")
          : "inactive";
      if (
        reason !== this.previousReadiness.get(item.id) &&
        item.status === "pending"
      )
        this.emitter.emit({
          runId: this.state.runId,
          itemId: item.id,
          operation: "scheduling",
          outcome: item.blockedReason ? "waiting" : "observed",
          metadata: { reason },
        });
      this.previousReadiness.set(item.id, reason);
    }
    for (const [unit, number] of Object.entries(this.state.stackNumbers ?? {}))
      if (this.previousStacks.get(unit) !== number) {
        this.emitter.emit({
          runId: this.state.runId,
          operation: "github-stack",
          outcome: "completed",
          metadata: { unit, stack: number },
        });
        this.previousStacks.set(unit, number);
      }
    if (
      this.state.integratedSha !== this.previousIntegrated &&
      this.state.integratedSha
    ) {
      this.emitter.emit({
        runId: this.state.runId,
        operation: "integrated-head",
        outcome: "completed",
        metadata: { headSha: this.state.integratedSha },
      });
      this.previousIntegrated = this.state.integratedSha;
    }
    if (objectiveComplete(this.state) && !this.previousFinal) {
      this.emitter.emit({
        runId: this.state.runId,
        operation: "objective-finalization",
        outcome: "completed",
        metadata: {
          candidateCommitSha: objectiveCandidate(this.state)!.commitSha,
          candidateBasis: objectiveCandidate(this.state)!.basis,
          ...(this.state.integratedSha
            ? { integratedSha: this.state.integratedSha }
            : {}),
        },
      });
      this.previousFinal = true;
    }
  }
}
