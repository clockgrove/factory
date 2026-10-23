/**
 * The `model-usage` run-log event: one per model call (planner, reviewer,
 * worker, discovery, dream), the same shape for every provider
 * (CORE.md#Model usage). Diagnostics, analysis and the scorecard read it.
 * A count a provider doesn't report is null, never zero.
 */
import { CAPTURE, type CaptureBody } from "../log.js";

export type ModelRole =
  | "planner"
  | "reviewer"
  | "worker"
  | "discovery"
  | "dream";

/**
 * Tokens of one call. `input` includes `cached`; `output` includes
 * `reasoning`; `total` is input plus output, or the provider's own total
 * when it reports no split. Null: the provider didn't report it.
 */
export interface Tokens {
  input: number | null;
  output: number | null;
  cached: number | null;
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
    reasoning: add(a.reasoning, b.reasoning),
    total: add(a.total, b.total),
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
 * until the adapter learns it. The adapter adds `tokens`, `costUsd`,
 * `sdkOperations`, `nativeToolActivity`, `outcome`, `ms` and its own
 * fields (session, thread, turns), then logs it with `logUsage`.
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
    ...fields,
    tokens: null,
    costUsd: null,
    sdkOperations: null,
    nativeToolActivity: null,
  };
}

/** The planner role a call logs: discovery and dream are their own. */
export function plannerRole(
  role: "planner" | "reviewer",
  phase: string,
): ModelRole {
  return phase === "discovery" || phase === "dream" ? phase : role;
}

/** Attach the call's request body: written to a capture file when capture is on, never to the log. */
export function captureRequest(
  record: Record<string, unknown>,
  request: string,
): void {
  (record as { [CAPTURE]?: CaptureBody })[CAPTURE] = { request };
}

/** Add the response body to the request `captureRequest` attached. */
export function captureResponse(
  record: Record<string, unknown>,
  response: string,
): void {
  const body = (record as { [CAPTURE]?: CaptureBody })[CAPTURE];
  if (body) body.response = response;
}

/**
 * Settle the record's `cacheEffectiveness` from its tokens, then log it.
 * The hit rate is cached over input of this one call, null when either is
 * unknown or input is zero; `uncachedInput` is input minus cached.
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
  log(record);
}
