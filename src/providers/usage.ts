/**
 * The `model-usage` run-log event: one per model call (planner, reviewer,
 * worker, dream), the same shape for every provider
 * (docs/reference/run-log.md#Model usage). Diagnostics, analysis and the scorecard read it.
 * A count a provider doesn't report is null, never zero.
 */
import { createHash, randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { CAPTURE, type CaptureBody, capturingTools } from "../log.js";

export type ModelRole = "planner" | "reviewer" | "worker" | "dream";

/**
 * Tokens of one call. `input` includes `cached` (read from the prompt
 * cache) and `cacheWrite` (written to it); `output` includes `reasoning`;
 * `total` is input plus output, or the provider's own total when it
 * reports no split. Null: the provider didn't report it.
 */
export interface Tokens {
  input: number | null;
  output: number | null;
  cached: number | null;
  cacheWrite: number | null;
  reasoning: number | null;
  total: number | null;
}

/** Distinct operations or tool calls, in all and by name. */
export interface Tally {
  total: number;
  byName: Record<string, number>;
}

type Count = number | null | undefined;

/** Normalized tokens; a missing or non-finite count is null. */
export function tokens(counts: {
  input?: Count;
  output?: Count;
  cached?: Count;
  cacheWrite?: Count;
  reasoning?: Count;
  total?: Count;
}): Tokens {
  const known = (value: Count) =>
    typeof value === "number" && Number.isFinite(value) ? value : null;
  const input = known(counts.input);
  const output = known(counts.output);
  return {
    input,
    output,
    cached: known(counts.cached),
    cacheWrite: known(counts.cacheWrite),
    reasoning: known(counts.reasoning),
    total:
      input !== null && output !== null ? input + output : known(counts.total),
  };
}

/** The sum of two calls' tokens; a count unknown in either is unknown. */
export function addTokens(a: Tokens, b: Tokens): Tokens {
  const add = (x: number | null, y: number | null) =>
    x === null || y === null ? null : x + y;
  return {
    input: add(a.input, b.input),
    output: add(a.output, b.output),
    cached: add(a.cached, b.cached),
    cacheWrite: add(a.cacheWrite, b.cacheWrite),
    reasoning: add(a.reasoning, b.reasoning),
    total: add(a.total, b.total),
  };
}

/**
 * A call's own tokens with its child threads' (`childTokens`) added: each
 * count both report is summed; a split the children don't report (Codex
 * records no cache writes for a thread) stays the call's own; a count the
 * call itself doesn't report stays unknown.
 */
export function withChildTokens(own: Tokens, children: Tokens): Tokens {
  const known = (value: unknown): value is number =>
    typeof value === "number" && Number.isFinite(value);
  const add = (x: unknown, y: unknown) =>
    known(x) ? x + (known(y) ? y : 0) : null;
  return {
    input: add(own.input, children.input),
    output: add(own.output, children.output),
    cached: add(own.cached, children.cached),
    cacheWrite: add(own.cacheWrite, children.cacheWrite),
    reasoning: add(own.reasoning, children.reasoning),
    total: add(own.total, children.total),
  };
}

/** Counts distinct ids by name: an id seen again (started, then completed) counts once. */
export class Tallies {
  private readonly seen = new Set<string>();
  private readonly byName: Record<string, number> = {};

  add(name: string, id?: string): void {
    if (id !== undefined) {
      if (this.seen.has(id)) return;
      this.seen.add(id);
    }
    this.byName[name] = (this.byName[name] ?? 0) + 1;
  }

  get value(): Tally {
    const byName = { ...this.byName };
    return {
      total: Object.values(byName).reduce((sum, n) => sum + n, 0),
      byName,
    };
  }
}

/**
 * A call's record, before it runs: every normalized field present, null
 * until the adapter learns it, and a `callId` that a later `model-refused`
 * event names. The adapter adds `tokens`, `costUsd`, `sdkOperations`,
 * `nativeToolActivity`, `reportedModel`, `nativeTools`, `outcome`, `ms`,
 * the per-call fields below and its own (session, thread, turns), then
 * logs it with `logUsage`:
 * - `reportedModel`: the model as the provider reported it, null when it didn't.
 * - `timeToFirstTokenMs`: from the call's start to the first model output, where the SDK streams.
 * - `sessionTurn` and `sessionMode`: the turn's ordinal in its provider session (1 is the first) and `fresh` or `resumed`.
 * - `stage`: where a failed call failed (`FailureStage`).
 * - `imageOutputs`: images the model produced.
 * - `providerUsage`: the provider's own usage breakdown, numbers only (`providerUsage`).
 * - `childTokens`: the part of `tokens` the call's child threads spent, with
 *   their count (`threads`), where the provider reports them apart (Codex's
 *   `spawn_agent` threads; a continued session's only by what they added
 *   since the call it continues). Null otherwise: a Claude call's sub-agents
 *   are in `tokens` through its per-model usage, not split out.
 */
export function usageRecord(fields: {
  role: ModelRole;
  provider: string;
  model: string | null;
  effort: string | null;
  phase?: string;
  item?: string;
}): Record<string, unknown> {
  return {
    event: "model-usage",
    callId: randomUUID(),
    ...fields,
    tokens: null,
    childTokens: null,
    costUsd: null,
    sdkOperations: null,
    nativeToolActivity: null,
    reportedModel: null,
  };
}

/**
 * Where a failed call failed: `provider` (the SDK, the transport, a login
 * or a limit), `parse` (the answer wasn't JSON or text it should be),
 * `protocol` (the answer broke its schema or the call's contract), or
 * `semantic` (well formed, refused by Factory's checks: a `model-refused`
 * event, `logRefused`).
 */
export type FailureStage = "provider" | "parse" | "protocol" | "semantic";

const sha256 = (data: string | Buffer): string =>
  createHash("sha256").update(data).digest("hex");

/** One digest over source bodies, in order: what a call's `sourceDigest` holds. */
export function sourceDigest(
  bodies: readonly (string | Buffer)[],
): string | undefined {
  if (!bodies.length) return undefined;
  const hash = createHash("sha256");
  for (const body of bodies) hash.update(sha256(body)).update("\n");
  return hash.digest("hex");
}

/**
 * What a prompt builder knows about the prompt it rendered: byte sizes of
 * its parts (summing to at most the prompt's bytes) and the digest of the
 * source bodies it gave (`sourceDigest`).
 */
export interface PromptFacts {
  sections?: Record<string, number>;
  sourceDigest?: string;
}

/** A rendered prompt and its facts. */
export interface Rendered {
  prompt: string;
  facts: PromptFacts;
}

/** A prompt from its named parts, in order, with each non-empty part's bytes and the digest of `sources`. */
export function rendered(
  parts: readonly [string, string][],
  sources: readonly (string | Buffer)[] = [],
): Rendered {
  const digest = sourceDigest(sources);
  return {
    prompt: parts.map(([, text]) => text).join(""),
    facts: {
      sections: Object.fromEntries(
        parts
          .filter(([, text]) => text)
          .map(([name, text]) => [name, Buffer.byteLength(text)]),
      ),
      ...(digest ? { sourceDigest: digest } : {}),
    },
  };
}

/**
 * Describe the call's request on its record and attach the body for
 * capture (written to a capture file when capture is on, never to the
 * log): `promptDigest`, `schemaDigest` and `sourceDigest` (sha256, hex),
 * `requestBytes` (prompt, schema and images as sent) and
 * `promptComponents` (bytes per part: `prompt`, `schema`, `images`, and
 * the builder's `sections`).
 */
export function describeRequest(
  record: Record<string, unknown>,
  request: {
    prompt: string;
    schema?: unknown;
    images?: readonly string[];
    facts?: PromptFacts;
  },
): void {
  const promptBytes = Buffer.byteLength(request.prompt);
  const schema =
    request.schema === undefined ? undefined : JSON.stringify(request.schema);
  const schemaBytes = schema === undefined ? 0 : Buffer.byteLength(schema);
  let imageBytes = 0;
  for (const image of request.images ?? [])
    try {
      imageBytes += statSync(image).size;
    } catch {
      // Missing: the call holds on it (planner.ts callImages).
    }
  record.promptDigest = sha256(request.prompt);
  record.schemaDigest = schema === undefined ? null : sha256(schema);
  record.sourceDigest = request.facts?.sourceDigest ?? null;
  record.requestBytes = promptBytes + schemaBytes + imageBytes;
  record.promptComponents = {
    prompt: promptBytes,
    ...(schema === undefined ? {} : { schema: schemaBytes }),
    ...(request.images?.length ? { images: imageBytes } : {}),
    ...(request.facts?.sections ? { sections: request.facts.sections } : {}),
  };
  (record as { [CAPTURE]?: CaptureBody })[CAPTURE] = {
    request: request.prompt,
  };
}

/**
 * A resumed turn's request (providers/session.ts): the capture keeps the
 * delta it sent, and `deltaBytes` its size, beside the whole request's
 * digests and bytes from `describeRequest`.
 */
export function captureRequest(
  record: Record<string, unknown>,
  request: string,
): void {
  record.deltaBytes = Buffer.byteLength(request);
  (record as { [CAPTURE]?: CaptureBody })[CAPTURE] = { request };
}

/** Set the call's time to first token, once: at its first model output. */
export function firstToken(
  record: Record<string, unknown>,
  started: number,
): void {
  if (typeof record.timeToFirstTokenMs !== "number")
    record.timeToFirstTokenMs = Date.now() - started;
}

/**
 * A call's native tool calls beyond their names (`Tallies`): `rounds`,
 * the model responses that asked for at least one tool; `outputs`, the
 * calls whose result was seen; `failures`, those the tool or provider
 * reported failed; `missingOutputs`, calls never answered; `ms`, the
 * summed time from each call to its result. With capture on each output
 * goes to the capture file too (`captureToolOutput`), never to the log.
 */
export class NativeTools {
  private readonly open = new Map<string, number>();
  private readonly answered = new Set<string>();
  private pending = false;
  private rounds = 0;
  private outputs = 0;
  private failures = 0;
  private ms = 0;

  /** The model asked for tool call `id`. */
  call(id: string, at = Date.now()): void {
    if (this.open.has(id) || this.answered.has(id)) return;
    this.open.set(id, at);
    this.pending = true;
  }

  /** Tool call `id` returned (`failed`: reported as failed); `ms`: its duration when the provider reports it. */
  result(id: string, failed: boolean, ms?: number): void {
    if (this.answered.has(id)) return;
    this.answered.add(id);
    const started = this.open.get(id);
    this.open.delete(id);
    this.outputs += 1;
    if (failed) this.failures += 1;
    if (typeof ms === "number" && Number.isFinite(ms)) this.ms += ms;
    else if (started !== undefined) this.ms += Date.now() - started;
  }

  /** A model response ended: it was a round if it asked for a tool. */
  response(): void {
    if (this.pending) this.rounds += 1;
    this.pending = false;
  }

  get value(): {
    rounds: number;
    outputs: number;
    failures: number;
    missingOutputs: number;
    ms: number;
  } {
    return {
      rounds: this.rounds + (this.pending ? 1 : 0),
      outputs: this.outputs,
      failures: this.failures,
      missingOutputs: this.open.size,
      ms: this.ms,
    };
  }
}

/** The most tool output one call keeps for its capture file, before the file's own cut. */
const TOOL_OUTPUT_CAPTURE_BYTES = 1024 * 1024;

/**
 * Keep one native tool output for the capture file, only while capture is
 * on (RunLog redacts and bounds it again). The kept slice is a copy, cut
 * by UTF-8 bytes, so it pins no larger string.
 */
export function captureToolOutput(
  record: Record<string, unknown>,
  name: string,
  output: string,
): void {
  const body = (record as { [CAPTURE]?: CaptureBody })[CAPTURE];
  if (!body || !capturingTools()) return;
  const used = body.toolBytes ?? 0;
  if (used >= TOOL_OUTPUT_CAPTURE_BYTES) return;
  // Decoded from bytes: a fresh string; a cut character decodes to U+FFFD, dropped.
  const kept = Buffer.from(output, "utf8")
    .subarray(0, TOOL_OUTPUT_CAPTURE_BYTES - used)
    .toString("utf8")
    .replace(/\uFFFD$/, "");
  body.tools = [...(body.tools ?? []), { name, output: kept }];
  body.toolBytes = used + Buffer.byteLength(kept);
}

/**
 * The provider's own usage breakdown, bounded and numbers only (so no
 * text reaches the log): finite numbers and objects of them, at most 3
 * levels and 64 keys per level. Undefined when nothing numeric is left.
 */
export function providerUsage(
  raw: unknown,
  depth = 0,
): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || depth > 2)
    return undefined;
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw).slice(0, 64)) {
    if (typeof value === "number" && Number.isFinite(value)) kept[key] = value;
    else {
      const inner = providerUsage(value, depth + 1);
      if (inner) kept[key] = inner;
    }
  }
  return Object.keys(kept).length ? kept : undefined;
}

/** Two `providerUsage` views added key by key (numbers summed, objects merged); either may be absent. */
export function addUsage(
  a: Record<string, unknown> | undefined,
  b: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!a || !b) return a ?? b;
  const sum: Record<string, unknown> = { ...a };
  for (const [key, value] of Object.entries(b)) {
    const had = sum[key];
    sum[key] =
      typeof value === "number" && typeof had === "number"
        ? had + value
        : value && typeof value === "object" && had && typeof had === "object"
          ? addUsage(
              had as Record<string, unknown>,
              value as Record<string, unknown>,
            )
          : (had ?? value);
  }
  return sum;
}

/**
 * A well-formed answer Factory's checks refused (the `semantic` stage):
 * logged after its call's `model-usage` event, naming it by `callId`.
 */
export function logRefused(
  log: (event: Record<string, unknown>) => void,
  callId: string | undefined,
  reason: string,
): void {
  log({
    event: "model-refused",
    ...(callId ? { callId } : {}),
    stage: "semantic",
    reason: reason.length > 300 ? `${reason.slice(0, 300)}…` : reason,
  });
}

/** The planner role a call logs: dream is its own. */
export function plannerRole(
  role: "planner" | "reviewer",
  phase: string,
): ModelRole {
  return phase === "dream" ? phase : role;
}

/** Add the response body to the request `captureRequest` attached. */
export function captureResponse(
  record: Record<string, unknown>,
  response: string,
): void {
  // Its size and digest whether or not capture keeps its body.
  record.responseBytes = Buffer.byteLength(response);
  record.responseDigest = sha256(response);
  const body = (record as { [CAPTURE]?: CaptureBody })[CAPTURE];
  if (body) body.response = response;
}

/**
 * Settle the record's `cacheEffectiveness` from its tokens, its `currency`
 * (`USD` beside a known cost: every provider reports list cost in USD),
 * and a failed call's `stage` (`provider` unless the adapter set one),
 * then log it. The hit rate is cached over input of this one call, null
 * when either is unknown or input is zero; `uncachedInput` is input minus
 * cached.
 */
export function logUsage(
  log: (event: Record<string, unknown>) => void,
  record: Record<string, unknown>,
): void {
  const counts = record.tokens as Tokens | null;
  const input = counts?.input ?? null;
  const cached = counts?.cached ?? null;
  record.cacheEffectiveness =
    input === null || cached === null
      ? null
      : {
          hitRate:
            input > 0 ? Math.round((cached / input) * 10_000) / 10_000 : null,
          uncachedInput: Math.max(0, input - cached),
        };
  if (typeof record.costUsd !== "number" || !Number.isFinite(record.costUsd))
    record.costUsd = null;
  record.currency = record.costUsd === null ? null : "USD";
  if (!["done", "finished"].includes(String(record.outcome)))
    record.stage ??= "provider";
  log(record);
}
