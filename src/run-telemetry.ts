import { existsSync, statSync } from "node:fs";
import type { ModelInvocationUsage } from "./contracts.js";
import { diagnosticPath, privateRecords } from "./diagnostics.js";
import { type ContinuationState, isExecutionState } from "./state.js";
import {
  isCodexUsageIdentity,
  normalizeCodexTokenUsage,
  normalizeTokenUsage,
} from "./usage.js";
import { workerProgressPath } from "./worker-activity.js";

/**
 * One model call of the current run, from recorded telemetry only: planning
 * and review invocations in the Objective's diagnostics, and each worker
 * attempt's own progress stream. Presentation input; never lifecycle state.
 */
export interface ModelCallRow {
  /** A model invocation phase, or `implementation` for a worker. */
  phase: string;
  itemId?: string;
  /** The Work Item attempt's ordinal in this run. */
  attempt?: number;
  /** A provider retry of the same invocation, when above 1. */
  providerAttempt?: number;
  provider?: string;
  harness?: string;
  model?: string;
  effort?: string;
  turns?: number;
  usage: ModelInvocationUsage;
  startedAt: string;
  durationMs?: number;
  outcome: "completed" | "failed" | "running";
}

interface Call {
  phase: string;
  invocationId: string;
  itemId?: string;
  attemptId?: string;
  providerAttempt?: number;
  provider?: string;
  adapter?: string;
  model?: string;
  effort?: string;
  turns?: number;
  usage?: Record<string, unknown>;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  failed?: boolean;
}

/** What a worker attempt's progress stream recorded about its model use. */
interface WorkerStream {
  usage: { at: string; value: unknown }[];
  /** Harness identity by invocation, from the stream's capture records. */
  adapters: Map<string, string>;
  turns?: number;
}

const TERMINAL = ["completed", "failed", "response-invalid"];
const ATTEMPT =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const text = (value: unknown): string | undefined =>
  typeof value === "string" && value ? value : undefined;
const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;

/** Merge one observation of a call: identity from any event, usage from the latest that has it. */
function observe(
  calls: Map<string, Call>,
  key: string,
  at: string,
  type: unknown,
  fields: Omit<Call, "startedAt" | "endedAt" | "failed">,
): void {
  const call = calls.get(key) ?? {
    phase: fields.phase,
    invocationId: fields.invocationId,
  };
  for (const name of [
    "itemId",
    "attemptId",
    "providerAttempt",
    "provider",
    "adapter",
    "model",
    "effort",
  ] as const)
    if (fields[name] !== undefined && call[name] === undefined)
      (call as unknown as Record<string, unknown>)[name] = fields[name];
  call.startedAt ??= at;
  if (fields.usage && Object.keys(fields.usage).length)
    call.usage = fields.usage;
  if (TERMINAL.includes(String(type))) {
    call.endedAt = at;
    call.failed = type !== "completed";
    if (fields.durationMs !== undefined) call.durationMs = fields.durationMs;
  }
  calls.set(key, call);
}

/** A capture record's harness identity for its invocation. */
function noteAdapter(adapters: Map<string, string>, event: unknown): void {
  const capture = (event as { capture?: Record<string, unknown> }).capture;
  const invocation = text(capture?.invocationId);
  const adapter = text(capture?.adapter);
  if (invocation && adapter && !adapters.has(invocation))
    adapters.set(invocation, adapter);
}

/** Parsed worker streams: a stream is re-read only when its file changes. */
const workerStreams = new Map<
  string,
  { size: number; mtimeMs: number; stream: WorkerStream }
>();

/** A worker attempt's usage observations, harness identity and reported turns. */
function workerStream(repository: string, attemptId: string): WorkerStream {
  // Only a local worker attempt has a progress stream.
  if (!ATTEMPT.test(attemptId)) return { usage: [], adapters: new Map() };
  const path = workerProgressPath(repository, attemptId);
  if (!existsSync(path)) return { usage: [], adapters: new Map() };
  const { size, mtimeMs } = statSync(path);
  const cached = workerStreams.get(path);
  if (cached?.size === size && cached.mtimeMs === mtimeMs) return cached.stream;
  const stream: WorkerStream = { usage: [], adapters: new Map() };
  let resultTurns: number | undefined;
  let providerTurns = 0;
  for (const event of privateRecords(path)) {
    if (event.operation === "worker-usage")
      stream.usage.push({ at: text(event.at) ?? "", value: event.workerUsage });
    if (event.operation === "model-capture")
      noteAdapter(stream.adapters, event);
    // Claude reports a query's turns on its result; Codex streams each turn.
    const turns = count(event.turns);
    if (event.operation === "result" && turns !== undefined)
      resultTurns = (resultTurns ?? 0) + turns;
    if (
      event.operation === "turn.completed" ||
      event.operation === "turn.failed"
    )
      providerTurns += 1;
  }
  stream.turns = resultTurns ?? (providerTurns || undefined);
  workerStreams.set(path, { size, mtimeMs, stream });
  return stream;
}

function workerUsage(
  calls: Map<string, Call>,
  attemptId: string,
  at: string,
  value: unknown,
): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const usage = value as Record<string, unknown>;
  const invocationId = text(usage.invocationId);
  if (usage.phase !== "implementation" || !invocationId) return;
  const providerAttempt = count(usage.providerAttempt);
  observe(
    calls,
    `${attemptId}:${invocationId}:${providerAttempt ?? 1}`,
    at,
    usage.type,
    {
      phase: "implementation",
      invocationId,
      attemptId,
      providerAttempt,
      provider: text(usage.provider),
      adapter: text(usage.adapter),
      model: text(usage.model),
      effort: text(usage.reasoningEffort),
      usage: usage.usage as Record<string, unknown> | undefined,
    },
  );
}

const normalized = (call: Call): ModelInvocationUsage =>
  isCodexUsageIdentity(call.provider) || isCodexUsageIdentity(call.adapter)
    ? normalizeCodexTokenUsage(call.usage)
    : normalizeTokenUsage(call.usage);

/**
 * The current run's model calls in start order: what Factory already
 * recorded, with absent facts left absent. Reads the Objective's diagnostics
 * and its worker attempts' progress streams; no state, no writes.
 */
export function readRunTelemetry(
  repository: string,
  state: ContinuationState,
  now: number,
): ModelCallRow[] {
  const calls = new Map<string, Call>();
  const adapters = new Map<string, string>();
  /** Each Work Item attempt of this run, by its first observation. */
  const attempts = new Map<string, { itemId: string; at: string }>();
  const noteAttempt = (attemptId: unknown, itemId: unknown, at: string) => {
    if (
      typeof attemptId === "string" &&
      typeof itemId === "string" &&
      !attempts.has(attemptId)
    )
      attempts.set(attemptId, { itemId, at });
  };
  const path = diagnosticPath(repository, state.objective);
  if (existsSync(path))
    for (const event of privateRecords(path)) {
      if (event.runId !== state.runId) continue;
      const at = text(event.at) ?? "";
      if (event.operation === "execute" || event.operation === "harness")
        noteAttempt(event.attemptId, event.itemId, at);
      if (event.operation === "model-capture") noteAdapter(adapters, event);
      if (event.operation === "worker-usage" && text(event.attemptId))
        workerUsage(calls, String(event.attemptId), at, event.workerUsage);
      if (event.operation !== "model-invocation") continue;
      const metadata = event.metadata as Record<string, unknown> | undefined;
      const invocationId = text(metadata?.invocationId);
      const phase = text(metadata?.phase);
      if (!metadata || !invocationId || !phase) continue;
      const providerAttempt = count(metadata.providerAttempt);
      observe(
        calls,
        `${invocationId}:${providerAttempt ?? 1}`,
        at,
        metadata.observationType,
        {
          phase,
          invocationId,
          itemId: text(event.itemId),
          attemptId: text(event.attemptId),
          providerAttempt,
          provider: text(metadata.provider),
          model: text(metadata.model),
          effort: text(metadata.reasoningEffort),
          usage: metadata.usageAvailable === true ? metadata : undefined,
          durationMs: count(event.durationMs),
        },
      );
    }
  if (isExecutionState(state))
    for (const [itemId, work] of Object.entries(state.work))
      if (work.attempt) noteAttempt(work.attempt, itemId, work.startedAt ?? "");
  const turns = new Map<string, number>();
  for (const attemptId of attempts.keys()) {
    const stream = workerStream(repository, attemptId);
    for (const { at, value } of stream.usage)
      workerUsage(calls, attemptId, at, value);
    for (const [invocation, adapter] of stream.adapters)
      if (!adapters.has(invocation)) adapters.set(invocation, adapter);
    if (stream.turns !== undefined) turns.set(attemptId, stream.turns);
  }
  // Each item's attempts are numbered in the order they started.
  const ordinals = new Map<string, number>();
  const perItem = new Map<string, number>();
  for (const [attemptId, { itemId }] of [...attempts].sort(([, a], [, b]) =>
    a.at.localeCompare(b.at),
  )) {
    const next = (perItem.get(itemId) ?? 0) + 1;
    perItem.set(itemId, next);
    ordinals.set(attemptId, next);
  }
  return [...calls.values()]
    .filter((call) => call.startedAt)
    .map((call): ModelCallRow => {
      const adapter = call.adapter ?? adapters.get(call.invocationId);
      const attempt = call.attemptId ? attempts.get(call.attemptId) : undefined;
      const itemId = call.itemId ?? attempt?.itemId;
      const worker = call.phase === "implementation" && call.attemptId;
      const callTurns = worker ? turns.get(call.attemptId!) : undefined;
      const started = Date.parse(call.startedAt!);
      const ended = call.endedAt ? Date.parse(call.endedAt) : now;
      const durationMs =
        call.durationMs ??
        (Number.isFinite(started) && Number.isFinite(ended)
          ? Math.max(0, ended - started)
          : undefined);
      return {
        phase: call.phase,
        ...(itemId && { itemId }),
        ...(call.attemptId &&
          ordinals.has(call.attemptId) && {
            attempt: ordinals.get(call.attemptId),
          }),
        ...(call.providerAttempt &&
          call.providerAttempt > 1 && {
            providerAttempt: call.providerAttempt,
          }),
        ...(call.provider && { provider: call.provider }),
        ...(adapter && { harness: adapter }),
        ...(call.model && { model: call.model }),
        ...(call.effort && { effort: call.effort }),
        ...(callTurns !== undefined && { turns: callTurns }),
        usage: normalized({ ...call, adapter }),
        startedAt: call.startedAt!,
        ...(durationMs !== undefined && { durationMs }),
        outcome: call.endedAt
          ? call.failed
            ? "failed"
            : "completed"
          : "running",
      };
    })
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}
