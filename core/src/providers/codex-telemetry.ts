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
import { Tallies, type Tally, type Tokens, tokens } from "./usage.js";

/** The end of a session record read: its last token count is at the end. */
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_ENTRIES = 512;

export interface CodexTelemetry {
  /** The thread's cumulative counts at its last `token_count`. */
  tokens?: Tokens;
  /** Native function and custom tool calls by name, each call id once. */
  nativeToolActivity: Tally;
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
  const file = sessionRecord(join(codexHome, "sessions"), thread);
  if (!file) return undefined;
  let text: string;
  let partial = false;
  try {
    const size = statSync(file).size;
    const start = Math.max(0, size - MAX_BYTES);
    partial = start > 0;
    const fd = openSync(file, "r");
    try {
      const buffer = Buffer.alloc(size - start);
      const read = readSync(fd, buffer, 0, buffer.length, start);
      text = buffer.subarray(0, read).toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
  const lines = text.split("\n");
  if (partial) lines.shift();
  const calls = new Tallies();
  let total: Record<string, unknown> | undefined;
  for (const line of lines) {
    if (!line.trim()) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    const { type, payload } = entry as {
      type?: unknown;
      payload?: Record<string, unknown> | null;
    };
    if (!payload || typeof payload !== "object") continue;
    if (type === "event_msg" && payload.type === "token_count") {
      const info = payload.info as { total_token_usage?: unknown } | null;
      if (info?.total_token_usage && typeof info.total_token_usage === "object")
        total = info.total_token_usage as Record<string, unknown>;
    }
    if (type === "response_item" && CALLS.has(String(payload.type))) {
      const name =
        typeof payload.name === "string" ? payload.name : String(payload.type);
      const id = payload.call_id ?? payload.id;
      calls.add(name, typeof id === "string" ? id : undefined);
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
    ...(partial ? { partial: true as const } : {}),
  };
}

/** The `rollout-*-<thread>.jsonl` under `sessions/YYYY/MM/DD`, bounded. */
function sessionRecord(dir: string, thread: string): string | undefined {
  let entries = 0;
  const walk = (at: string, depth: number): string | undefined => {
    let names: string[];
    try {
      names = readdirSync(at);
    } catch {
      return undefined;
    }
    for (const name of names) {
      if (++entries > MAX_ENTRIES) return undefined;
      const path = join(at, name);
      if (depth === 3) {
        if (name.startsWith("rollout-") && name.endsWith(`${thread}.jsonl`))
          return path;
      } else {
        const found = walk(path, depth + 1);
        if (found) return found;
      }
    }
    return undefined;
  };
  return walk(dir, 0);
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
