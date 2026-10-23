/**
 * Codex's native telemetry: the session record (rollout) a call's private
 * CODEX_HOME holds, read before the home is removed. It gives the thread's
 * own token counts (with reasoning, and when the SDK stream ended before
 * `turn.completed`) and the model-visible tool calls by name, for the
 * call's `model-usage` event (usage.ts). Best effort and bounded: an
 * unreadable or missing record gives nothing, never an error.
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
  /** Child (sub-agent) threads' own last totals, summed; their own view, never added to `tokens`. */
  descendants?: Record<string, number>;
  /** Each tool output's call name and text, in order, for capture. */
  outputs: { name: string; output: string }[];
  /** The record was larger than the bound: earlier tool calls were not read. */
  partial?: true;
}

/** Response items that are a model-visible tool call. */
const CALLS = new Set([
  "function_call",
  "custom_tool_call",
  "local_shell_call",
  "web_search_call",
]);

/**
 * The telemetry of `thread` in the Codex home `codexHome`, or undefined
 * when its session record isn't there.
 */
export function codexTelemetry(
  codexHome: string,
  thread: string | undefined,
): CodexTelemetry | undefined {
  if (!thread) return undefined;
  const records = sessionRecords(join(codexHome, "sessions"));
  const file = records.find((path) => path.endsWith(`${thread}.jsonl`));
  if (!file) return undefined;
  const tail = readTail(file);
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
    }
    if (type !== "response_item") continue;
    const id = payload.call_id ?? payload.id;
    if (payload.type === "image_generation_call") imageOutputs += 1;
    if (CALLS.has(String(payload.type))) {
      const name =
        typeof payload.name === "string" ? payload.name : String(payload.type);
      calls.add(name, typeof id === "string" ? id : undefined);
      if (typeof id === "string") {
        names.set(id, { name, at });
        tools.call(id);
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
  return {
    ...(total && {
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
    descendants: descendantUsage(
      records.filter((path) => path !== file).slice(0, MAX_CHILDREN),
    ),
    outputs,
    ...(partial ? { partial: true as const } : {}),
  };
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
): { lines: string[]; partial: boolean; bytes: number } | undefined {
  try {
    const size = statSync(file).size;
    const start = Math.max(0, size - max);
    const fd = openSync(file, "r");
    try {
      const buffer = Buffer.alloc(size - start);
      const read = readSync(fd, buffer, 0, buffer.length, start);
      const lines = buffer.subarray(0, read).toString("utf8").split("\n");
      if (start > 0) lines.shift();
      return { lines, partial: start > 0, bytes: read };
    } catch {
      return undefined;
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

/** Each child record's last `total_token_usage`, summed, with the thread count; undefined for none. */
function descendantUsage(
  files: readonly string[],
): Record<string, number> | undefined {
  const sum = {
    threads: 0,
    input: 0,
    cached: 0,
    output: 0,
    reasoning: 0,
    total: 0,
  };
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
        sum.threads += 1;
        sum.input += n("input_tokens");
        sum.cached += n("cached_input_tokens");
        sum.output += n("output_tokens");
        sum.reasoning += n("reasoning_output_tokens");
        sum.total += n("total_tokens");
        break;
      }
      if (!tail.partial) break;
    }
  }
  return sum.threads ? sum : undefined;
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
 */
export function addCodexTelemetry(
  record: Record<string, unknown>,
  codexHome: string,
): void {
  const native = codexTelemetry(
    codexHome,
    typeof record.thread === "string" ? record.thread : undefined,
  );
  if (record.tokens) record.tokenSource = "sdk";
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
  if (!record.tokens && native.tokens) {
    record.tokens = native.tokens;
    record.tokenSource = "native";
  }
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
  reasoning_output_tokens?: number;
}): Tokens {
  return tokens({
    input: usage.input_tokens,
    output: usage.output_tokens,
    cached: usage.cached_input_tokens,
    reasoning: usage.reasoning_output_tokens,
  });
}
