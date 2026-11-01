/**
 * Codex's native telemetry: the session record (rollout) a call's private
 * CODEX_HOME holds, read before the home is removed. It gives the thread's
 * own token counts (with reasoning, and when the SDK stream ended before
 * `turn.completed`) and the model-visible tool calls by name, for the
 * call's `model-usage` event (usage.ts), and what a failed turn's own
 * records say about it, for its outcome (codex.ts codexFailure). Best
 * effort and bounded: an unreadable or missing record gives nothing, never
 * an error.
 */
import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  captureToolOutput,
  NativeTools,
  providerUsage,
  Tallies,
  type Tally,
  type Tokens,
  tokens,
  withChildTokens,
} from "./usage.js";

/** The end of a session record read: its last token count is at the end. */
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_ENTRIES = 512;

export interface CodexTelemetry {
  /** The thread's cumulative counts at its last `token_count`. */
  tokens?: Tokens;
  /** Native function and custom tool calls by name, each call id once. */
  nativeToolActivity: Tally;
  /** The same calls' rounds, outputs, failures and durations (usage.ts NativeTools). */
  nativeTools: NativeTools["value"];
  /** The model the thread's last turn ran, as Codex recorded it. */
  reportedModel?: string;
  /** Image generation outputs. */
  imageOutputs: number;
  /** The last `token_count`'s info: total and last-response usage. */
  usage?: Record<string, unknown>;
  /** Child (sub-agent) threads' own last totals, summed: cumulative over every turn the home held. */
  descendants?: Record<string, number>;
  /** Each child thread's own last totals, by its session record (`childTokens` takes a turn's increase). */
  children?: Record<string, ChildUsage>;
  /** Each tool output's call name and text, in order, for capture. */
  outputs: { name: string; output: string }[];
  /** The record was larger than the bound: earlier tool calls were not read. */
  partial?: true;
  /** Codex compacted the thread's history in what was read. */
  compacted?: true;
  /**
   * The last turn's error as Codex classified it (`codex_error_info` on its
   * `task_complete`): the kind, and an HTTP failure's status.
   */
  failure?: { kind: string; status?: number };
  /**
   * The usage windows of the last `token_count` that reported them (its
   * `rate_limits`, primary and secondary): percent used, and the reset in
   * epoch milliseconds when Codex gave one.
   */
  limits?: { used: number; resetsAt?: number }[];
}

/** Response items that are a model-visible tool call. */
const CALLS = new Set([
  "function_call",
  "custom_tool_call",
  "local_shell_call",
  "web_search_call",
]);

/**
 * Code mode's tool that only waits on a running `exec` cell, and so on the
 * tool call the cell awaits: each call is a round of its own (#2167).
 */
const CODE_MODE_WAIT = "wait";

/**
 * The telemetry of `thread` in the Codex home `codexHome`, or undefined
 * when its session record isn't there.
 */
export function codexTelemetry(
  codexHome: string,
  thread: string | undefined,
  /** A continued thread's record size before this turn: only what follows is this turn's. */
  from = 0,
): CodexTelemetry | undefined {
  if (!thread) return undefined;
  const records = sessionRecords(join(codexHome, "sessions"));
  const file = records.find((path) => path.endsWith(`${thread}.jsonl`));
  if (!file) return undefined;
  const tail = readTail(file, MAX_BYTES, from);
  if (!tail) return undefined;
  const { lines, partial } = tail;
  const calls = new Tallies();
  const tools = new NativeTools();
  const names = new Map<string, { name: string; at: number }>();
  const outputs: { name: string; output: string }[] = [];
  let total: Record<string, unknown> | undefined;
  let info: Record<string, unknown> | undefined;
  let reportedModel: string | undefined;
  let imageOutputs = 0;
  let compacted = false;
  let failure: CodexTelemetry["failure"];
  let limits: CodexTelemetry["limits"];
  for (const line of lines) {
    if (!line.trim()) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    const { type, payload, timestamp } = entry as {
      type?: unknown;
      payload?: Record<string, unknown> | null;
      timestamp?: unknown;
    };
    if (!payload || typeof payload !== "object") continue;
    // Codex replaced the thread's history with a summary.
    if (
      type === "compacted" ||
      (type === "event_msg" && payload.type === "context_compacted")
    )
      compacted = true;
    const at = typeof timestamp === "string" ? Date.parse(timestamp) : NaN;
    if (type === "turn_context" && typeof payload.model === "string")
      reportedModel = payload.model;
    if (type === "event_msg" && payload.type === "token_count") {
      // Each count closes a model response: a round if it asked for a tool.
      tools.response();
      const counted = payload.info as Record<string, unknown> | null;
      if (counted && typeof counted === "object") info = counted;
      if (
        counted?.total_token_usage &&
        typeof counted.total_token_usage === "object"
      )
        total = counted.total_token_usage as Record<string, unknown>;
      limits = usageWindows(payload.rate_limits) ?? limits;
    }
    if (type === "event_msg" && payload.type === "task_complete")
      failure = errorKind(payload.error);
    if (type !== "response_item") continue;
    const id = payload.call_id ?? payload.id;
    if (payload.type === "image_generation_call") imageOutputs += 1;
    if (CALLS.has(String(payload.type))) {
      const name =
        typeof payload.name === "string" ? payload.name : String(payload.type);
      calls.add(name, typeof id === "string" ? id : undefined);
      if (typeof id === "string") {
        names.set(id, { name, at });
        tools.call(id, name === CODE_MODE_WAIT);
      }
    }
    if (
      typeof id === "string" &&
      (payload.type === "function_call_output" ||
        payload.type === "custom_tool_call_output" ||
        payload.type === "local_shell_call_output")
    ) {
      const called = names.get(id);
      const { text, failed, ms } = toolOutput(payload.output);
      tools.result(
        id,
        failed,
        ms ?? (called && at >= called.at ? at - called.at : 0),
      );
      if (text !== undefined)
        outputs.push({
          name: called?.name ?? String(payload.type),
          output: text,
        });
    }
  }
  const children = descendantUsage(
    records.filter((path) => path !== file).slice(0, MAX_CHILDREN),
  );
  return {
    // A continued thread's counts are cumulative over its earlier turns.
    ...(total &&
      from === 0 && {
        tokens: tokens({
          input: total.input_tokens as number,
          output: total.output_tokens as number,
          cached: total.cached_input_tokens as number,
          reasoning: total.reasoning_output_tokens as number,
        }),
      }),
    nativeToolActivity: calls.value,
    nativeTools: tools.value,
    ...(reportedModel ? { reportedModel } : {}),
    imageOutputs,
    ...(info ? { usage: info } : {}),
    ...(children && {
      descendants: children.sum,
      children: children.byRecord,
    }),
    outputs,
    ...(partial ? { partial: true as const } : {}),
    ...(compacted ? { compacted: true as const } : {}),
    ...(failure ? { failure } : {}),
    ...(limits ? { limits } : {}),
  };
}

/** A `task_complete` error's `codex_error_info`: a kind's name, or `{kind: details}`. */
function errorKind(error: unknown): CodexTelemetry["failure"] {
  const info = (error as { codex_error_info?: unknown } | null)
    ?.codex_error_info;
  if (typeof info === "string") return { kind: info };
  if (!info || typeof info !== "object") return undefined;
  const [kind, details] = Object.entries(info)[0] ?? [];
  if (!kind) return undefined;
  const status = (details as { http_status_code?: unknown } | null)
    ?.http_status_code;
  return { kind, ...(typeof status === "number" ? { status } : {}) };
}

/** A `token_count`'s `rate_limits` windows; undefined when it reports none. */
function usageWindows(limits: unknown): CodexTelemetry["limits"] {
  if (!limits || typeof limits !== "object") return undefined;
  const { primary, secondary } = limits as Record<string, unknown>;
  const windows: NonNullable<CodexTelemetry["limits"]> = [];
  for (const window of [primary, secondary]) {
    const { used_percent: used, resets_at: resets } =
      (window as Record<string, unknown> | null) ?? {};
    if (typeof used !== "number" || !Number.isFinite(used)) continue;
    windows.push({
      used,
      ...(typeof resets === "number" && Number.isFinite(resets)
        ? { resetsAt: resets * 1000 }
        : {}),
    });
  }
  return windows.length ? windows : undefined;
}

/**
 * A tool output's text, and what it reports structurally: a JSON output
 * with `metadata.exit_code` (failed when not 0) and `duration_seconds`,
 * or an object output with `success`. Plain text reports neither.
 */
function toolOutput(output: unknown): {
  text?: string;
  failed: boolean;
  ms?: number;
} {
  let parsed: unknown = output;
  if (typeof output === "string")
    try {
      parsed = JSON.parse(output);
    } catch {
      return { text: output, failed: false };
    }
  if (!parsed || typeof parsed !== "object")
    return {
      ...(typeof output === "string" ? { text: output } : {}),
      failed: false,
    };
  const fields = parsed as {
    output?: unknown;
    content?: unknown;
    success?: unknown;
    metadata?: { exit_code?: unknown; duration_seconds?: unknown };
  };
  const exit = fields.metadata?.exit_code;
  const seconds = fields.metadata?.duration_seconds;
  const text =
    typeof fields.output === "string"
      ? fields.output
      : typeof fields.content === "string"
        ? fields.content
        : typeof output === "string"
          ? output
          : undefined;
  return {
    ...(text !== undefined ? { text } : {}),
    failed:
      fields.success === false || (typeof exit === "number" && exit !== 0),
    ...(typeof seconds === "number" && Number.isFinite(seconds)
      ? { ms: Math.round(seconds * 1000) }
      : {}),
  };
}

/** The most child-thread records read for `descendants`. */
const MAX_CHILDREN = 32;

/**
 * The `rollout-*.jsonl` records under `sessions/YYYY/MM/DD`, bounded: the
 * call's own thread and any sub-agent threads it started in the same home.
 */
function sessionRecords(dir: string): string[] {
  let entries = 0;
  const found: string[] = [];
  const walk = (at: string, depth: number): void => {
    let names: string[];
    try {
      names = readdirSync(at);
    } catch {
      return;
    }
    for (const name of names) {
      if (++entries > MAX_ENTRIES) return;
      const path = join(at, name);
      if (depth < 3) walk(path, depth + 1);
      else if (name.startsWith("rollout-") && name.endsWith(".jsonl"))
        found.push(path);
    }
  };
  walk(dir, 0);
  return found;
}

/** The record's last `max` bytes as complete lines; undefined when unreadable. */
function readTail(
  file: string,
  max = MAX_BYTES,
  /** Read nothing before this offset (a continued thread's earlier turns). */
  from = 0,
): { lines: string[]; partial: boolean; bytes: number } | undefined {
  try {
    const size = statSync(file).size;
    const start = Math.max(from, size - max);
    const fd = openSync(file, "r");
    try {
      const buffer = Buffer.alloc(size - start);
      const read = readSync(fd, buffer, 0, buffer.length, start);
      const lines = buffer.subarray(0, read).toString("utf8").split("\n");
      if (start > from) lines.shift();
      return { lines, partial: start > from, bytes: read };
    } catch {
      return undefined;
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

/** One child thread's last `total_token_usage`. */
export interface ChildUsage {
  input: number;
  cached: number;
  output: number;
  reasoning: number;
  total: number;
}

const CHILD_KEYS = ["input", "cached", "output", "reasoning", "total"] as const;

/**
 * Each child record's last `total_token_usage`, by record, and summed with
 * the thread count; undefined for none.
 */
function descendantUsage(files: readonly string[]):
  | {
      sum: Record<string, number>;
      byRecord: Record<string, ChildUsage>;
    }
  | undefined {
  const sum = {
    threads: 0,
    input: 0,
    cached: 0,
    output: 0,
    reasoning: 0,
    total: 0,
  };
  const byRecord: Record<string, ChildUsage> = {};
  // The last token_count is near a record's end: 64 KiB first, wider
  // only when it isn't there, within one budget across all children.
  let budget = CHILD_BYTES;
  for (const file of files) {
    for (const width of [64 * 1024, 1024 * 1024]) {
      if (budget <= 0) break;
      const tail = readTail(file, Math.min(width, budget));
      if (!tail) break;
      budget -= tail.bytes;
      const usage = lastTotalUsage(tail.lines);
      if (usage) {
        const n = (key: string) =>
          typeof usage[key] === "number" && Number.isFinite(usage[key])
            ? (usage[key] as number)
            : 0;
        const child: ChildUsage = {
          input: n("input_tokens"),
          cached: n("cached_input_tokens"),
          output: n("output_tokens"),
          reasoning: n("reasoning_output_tokens"),
          total: n("total_tokens"),
        };
        byRecord[file] = child;
        sum.threads += 1;
        for (const key of CHILD_KEYS) sum[key] += child[key];
        break;
      }
      if (!tail.partial) break;
    }
  }
  return sum.threads ? { sum, byRecord } : undefined;
}

/**
 * The tokens a call's child threads spent (`childTokens`): each child
 * record's last totals less what it held before the call (`before`, a
 * continued thread's baseline: its earlier turns' children), with the
 * threads that spent any. Undefined when none did.
 */
export function childTokens(
  now: Record<string, ChildUsage> | undefined,
  before: Record<string, ChildUsage> = {},
): (Tokens & { threads: number }) | undefined {
  const sum: ChildUsage = {
    input: 0,
    cached: 0,
    output: 0,
    reasoning: 0,
    total: 0,
  };
  let threads = 0;
  for (const [file, usage] of Object.entries(now ?? {})) {
    const earlier = before[file];
    const added = Object.fromEntries(
      CHILD_KEYS.map((key) => [
        key,
        Math.max(0, usage[key] - (earlier?.[key] ?? 0)),
      ]),
    ) as unknown as ChildUsage;
    if (!added.total && !added.input && !added.output) continue;
    threads += 1;
    for (const key of CHILD_KEYS) sum[key] += added[key];
  }
  if (!threads) return undefined;
  return {
    ...tokens({
      input: sum.input,
      output: sum.output,
      cached: sum.cached,
      reasoning: sum.reasoning,
      // Codex records no cache writes for a thread.
      cacheWrite: null,
      total: sum.total,
    }),
    threads,
  };
}

/** The read bytes across all child records of one call. */
const CHILD_BYTES = 4 * 1024 * 1024;

/** The last `token_count`'s `total_token_usage` in `lines`. */
function lastTotalUsage(
  lines: readonly string[],
): Record<string, unknown> | undefined {
  for (let at = lines.length - 1; at >= 0; at--) {
    let usage: Record<string, unknown> | undefined;
    try {
      const entry = JSON.parse(lines[at]!) as {
        type?: unknown;
        payload?: { type?: unknown; info?: { total_token_usage?: unknown } };
      };
      if (entry.type === "event_msg" && entry.payload?.type === "token_count")
        usage = entry.payload.info?.total_token_usage as
          | Record<string, unknown>
          | undefined;
    } catch {
      continue;
    }
    if (usage && typeof usage === "object") return usage;
  }
  return undefined;
}

/**
 * Add the native telemetry of the record's `thread` to a `model-usage`
 * record: its tool calls, and its tokens when the SDK reported none (a
 * call that ended before `turn.completed`). `tokenSource` says which.
 * Its child threads' tokens (`childTokens`, a continued thread's only by
 * what they added since `baseline`) go into `tokens`, as a Claude call's
 * sub-agents do (#2168).
 */
export function addCodexTelemetry(
  record: Record<string, unknown>,
  codexHome: string,
  /** A continued thread before this turn (codexBaseline). */
  baseline?: CodexBaseline,
): void {
  const native = codexTelemetry(
    codexHome,
    typeof record.thread === "string" ? record.thread : undefined,
    baseline?.size,
  );
  // A worker that stopped before `turn.completed` set its own (native).
  if (record.tokens) record.tokenSource ??= "sdk";
  if (!native) return;
  record.nativeToolActivity = native.nativeToolActivity;
  record.nativeTools = native.nativeTools;
  record.imageOutputs = native.imageOutputs;
  if (native.reportedModel) record.reportedModel = native.reportedModel;
  const usage = providerUsage(native.usage);
  const descendants = providerUsage(native.descendants);
  if (usage || descendants)
    record.providerUsage = {
      ...(record.providerUsage as Record<string, unknown> | undefined),
      ...(usage ? { native: usage } : {}),
      ...(descendants ? { descendants } : {}),
    };
  for (const { name, output } of native.outputs)
    captureToolOutput(record, name, output);
  if (native.partial) record.nativePartial = true;
  if (native.compacted) record.compacted = true;
  if (!record.tokens && native.tokens) {
    record.tokens = native.tokens;
    record.tokenSource = "native";
  }
  const children = childTokens(native.children, baseline?.children);
  if (children) {
    record.childTokens = children;
    // Unknown stays unknown: the spend then charges the children alone (spend.ts amountOf).
    if (record.tokens)
      record.tokens = withChildTokens(record.tokens as Tokens, children);
  }
}

/**
 * A continued thread before its new turn: its record's byte size, and its
 * cumulative counts so far. Codex reports a continued thread's counts
 * cumulatively, so the turn's own are the new totals less these.
 */
export interface CodexBaseline {
  size: number;
  tokens?: Tokens;
  /** Its child threads' totals so far: a resumed call's own are what follows. */
  children?: Record<string, ChildUsage>;
}

export function codexBaseline(
  codexHome: string,
  thread: string,
): CodexBaseline {
  const file = codexSessionRecord(codexHome, thread);
  let size = 0;
  try {
    size = file ? statSync(file).size : 0;
  } catch {
    return { size: 0 };
  }
  const native = codexTelemetry(codexHome, thread);
  return {
    size,
    ...(native?.tokens && { tokens: native.tokens }),
    ...(native?.children && { children: native.children }),
  };
}

/** A continued turn's own counts: cumulative `total` less `baseline`; unknown without one. */
export function turnTokens(total: Tokens, baseline?: Tokens): Tokens {
  const less = (a: number | null, b: number | null | undefined) =>
    a === null || b === null || b === undefined ? null : Math.max(0, a - b);
  return tokens({
    input: less(total.input, baseline?.input),
    output: less(total.output, baseline?.output),
    cached: less(total.cached, baseline?.cached),
    cacheWrite: less(total.cacheWrite, baseline?.cacheWrite),
    reasoning: less(total.reasoning, baseline?.reasoning),
  });
}

/** `thread`'s session record in the Codex home `codexHome`, when it is there. */
export function codexSessionRecord(
  codexHome: string,
  thread: string,
): string | undefined {
  return sessionRecords(join(codexHome, "sessions")).find((path) =>
    path.endsWith(`${thread}.jsonl`),
  );
}

/** The Codex SDK items that are operations (not messages, reasoning or errors). */
export const SDK_OPERATIONS: ReadonlySet<string> = new Set([
  "command_execution",
  "file_change",
  "mcp_tool_call",
  "web_search",
  "todo_list",
]);

/** The SDK's `turn.completed` usage as the record's `providerUsage.turn`. */
export function codexTurnUsage(
  record: Record<string, unknown>,
  usage: unknown,
): void {
  const turn = providerUsage(usage);
  if (turn)
    record.providerUsage = {
      ...(record.providerUsage as Record<string, unknown> | undefined),
      turn,
    };
}

/** An SDK item the model produced: its first marks the call's first token. */
export const modelItem = (item: { type: string } | undefined): boolean =>
  item !== undefined && item.type !== "error";

/** The SDK's `turn.completed` usage, normalized. */
export function codexTokens(usage: {
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
  cache_write_input_tokens?: number;
  reasoning_output_tokens?: number;
}): Tokens {
  return tokens({
    input: usage.input_tokens,
    output: usage.output_tokens,
    cached: usage.cached_input_tokens,
    cacheWrite: usage.cache_write_input_tokens,
    reasoning: usage.reasoning_output_tokens,
  });
}

/** The most of a session record one live read takes; older lines are skipped. */
const LIVE_BYTES = 8 * 1024 * 1024;

/**
 * A running thread's context and compactions, read from its session record
 * as it grows: each call reads what was appended since the last one and
 * returns the last `token_count`'s context (its last request's input
 * tokens and the model's window), the thread's cumulative counts then
 * (`total`), and the compactions it saw. Best effort: a missing or
 * unreadable record gives nothing.
 */
export function codexLiveRecord(
  codexHome: string,
  /** A continued thread's record size before this turn. */
  from = 0,
): (thread: string) => {
  context?: { tokens: number; window?: number };
  /** The thread's counts at the last `token_count` read, cumulative over its turns. */
  total?: Tokens;
  compactions: number;
  /** Model responses since the last read (one `token_count` each). */
  responses: number;
} {
  let file: string | undefined;
  let offset = from;
  let rest = "";
  // Codex writes a compaction as a `compacted` record and a
  // `context_compacted` event: one compaction until the next count or item.
  let compacting = false;
  return (thread) => {
    let compactions = 0;
    let responses = 0;
    let context: { tokens: number; window?: number } | undefined;
    let total: Tokens | undefined;
    file ??= sessionRecords(join(codexHome, "sessions")).find((path) =>
      path.endsWith(`${thread}.jsonl`),
    );
    if (!file) return { compactions, responses };
    let text: string;
    try {
      const size = statSync(file).size;
      if (size <= offset) return { compactions, responses };
      const start = Math.max(offset, size - LIVE_BYTES);
      if (start > offset) rest = "";
      const fd = openSync(file, "r");
      try {
        const buffer = Buffer.alloc(size - start);
        const read = readSync(fd, buffer, 0, buffer.length, start);
        offset = start + read;
        text = rest + buffer.subarray(0, read).toString("utf8");
      } finally {
        closeSync(fd);
      }
    } catch {
      return { compactions, responses };
    }
    const lines = text.split("\n");
    rest = lines.pop() ?? "";
    for (const line of lines) {
      let entry: { type?: unknown; payload?: Record<string, unknown> | null };
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const payload = entry?.payload;
      if (!payload || typeof payload !== "object") continue;
      if (
        entry.type === "compacted" ||
        (entry.type === "event_msg" && payload.type === "context_compacted")
      ) {
        if (!compacting) compactions += 1;
        compacting = true;
        continue;
      }
      if (entry.type === "response_item") compacting = false;
      if (entry.type !== "event_msg" || payload.type !== "token_count")
        continue;
      compacting = false;
      const info = payload.info as Record<string, unknown> | null | undefined;
      const counted = info?.total_token_usage as
        | Record<string, unknown>
        | undefined;
      if (counted && typeof counted === "object")
        total = tokens({
          input: counted.input_tokens as number,
          output: counted.output_tokens as number,
          cached: counted.cached_input_tokens as number,
          reasoning: counted.reasoning_output_tokens as number,
        });
      const last = info?.last_token_usage as
        | Record<string, unknown>
        | undefined;
      const input = last?.input_tokens;
      if (typeof input !== "number") continue;
      responses += 1;
      const window = info?.model_context_window;
      context = {
        tokens: input,
        ...(typeof window === "number" ? { window } : {}),
      };
    }
    return {
      ...(context ? { context } : {}),
      ...(total ? { total } : {}),
      compactions,
      responses,
    };
  };
}
