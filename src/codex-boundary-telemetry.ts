import { StringDecoder } from "node:string_decoder";
import type { ThreadEvent } from "@openai/codex-sdk";
import type { ModelBoundaryObservation } from "./capture.js";

type Boundary = Omit<ModelBoundaryObservation, "elapsedMs" | "source">;

/** Parse the pinned native formatter, including quoted values; never match inside errors. */
function fields(text: string): Map<string, string> | undefined {
  const result = new Map<string, string>();
  let offset = 0;
  while (offset < text.length) {
    const match = /^\s*([\w.]+)=/.exec(text.slice(offset));
    if (!match) return text.slice(offset).trim() ? undefined : result;
    offset += match[0].length;
    let value: string;
    if (text[offset] === '"') {
      const start = offset++;
      let escaped = false;
      while (offset < text.length) {
        const next = text[offset++];
        if (!escaped && next === '"') break;
        escaped = !escaped && next === "\\";
      }
      try {
        value = JSON.parse(text.slice(start, offset)) as string;
      } catch {
        return undefined;
      }
      if (typeof value !== "string") return undefined;
    } else {
      const start = offset;
      while (offset < text.length && !/\s/.test(text[offset]!)) offset++;
      value = text.slice(start, offset);
    }
    if (result.has(match[1]!) || !value.length) return undefined;
    result.set(match[1]!, value);
  }
  return result;
}

function integer(values: Map<string, string>, key: string): number | undefined {
  const value = values.get(key);
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function project(values: Map<string, string>): Boundary | undefined {
  const durationMs = integer(values, "duration_ms");
  const nativeAttempt = integer(values, "attempt");
  const success = values.get("success");
  const common = {
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(nativeAttempt === undefined ? {} : { nativeAttempt }),
    ...(success === "true" || success === "false"
      ? { success: success === "true" }
      : {}),
  };
  switch (values.get("event.name")) {
    case "codex.api_request":
    case "codex.websocket_connect":
    case "codex.websocket_request": {
      const statusCode = integer(values, "http.response.status_code");
      return {
        event: "transport-completed",
        ...common,
        transport:
          values.get("event.name") === "codex.api_request"
            ? "http"
            : values.get("event.name") === "codex.websocket_connect"
              ? "websocket-connect"
              : "websocket-request",
        ...(statusCode !== undefined && statusCode >= 100 && statusCode <= 599
          ? { statusCode }
          : {}),
      };
    }
    case "codex.turn_ttft":
      return durationMs === undefined
        ? undefined
        : { event: "first-output", durationMs };
    case "codex.retry": {
      const retryLayer = values.get("retry.layer");
      const retryOperation = values.get("retry.operation");
      const delayMs = integer(values, "retry.delay_ms");
      const attempt = integer(values, "retry.attempt");
      if (
        (retryLayer !== "http" && retryLayer !== "stream") ||
        (retryOperation !== "request" &&
          retryOperation !== "sampling" &&
          retryOperation !== "remote_compaction_v2") ||
        delayMs === undefined ||
        attempt === undefined
      )
        return undefined;
      return {
        event: "retry",
        retryLayer,
        retryOperation,
        delayMs,
        nativeAttempt: attempt,
      };
    }
    case "codex.sse_event": {
      // Pinned trace_safe emits completed responses and failures; ordinary
      // successful SSE events use a different target that we never enable.
      if (values.has("error.message"))
        return { event: "stream-terminal", ...common, success: false };
      if (values.get("event.kind") !== "response.completed") return undefined;
      const responseCounters: NonNullable<
        ModelBoundaryObservation["responseCounters"]
      > = {};
      for (const [source, destination] of [
        ["input_token_count", "inputTokens"],
        ["output_token_count", "outputTokens"],
        ["cached_token_count", "cachedInputTokens"],
        ["cache_write_token_count", "cacheWriteInputTokens"],
        ["reasoning_token_count", "reasoningOutputTokens"],
        ["tool_token_count", "totalTokens"],
        ["ttft_ms", "ttftMs"],
      ] as const) {
        const value = integer(values, source);
        if (value !== undefined) responseCounters[destination] = value;
      }
      return { event: "response-completed", ...common, responseCounters };
    }
    default:
      return undefined;
  }
}

/** Live, bounded metadata; quarantines every safe-target line from generic stderr. */
export function codexBoundaryTelemetry(
  observe: (event: Boundary) => void,
  ordinary: (chunk: Buffer) => void,
) {
  const decoder = new StringDecoder("utf8");
  const limit = 64 * 1024;
  let pending = "";
  let dropping = false;
  let finished = false;
  let observedBytes = 0;
  let parsedBytes = 0;
  let parsedRecords = 0;
  let unparsedRecords = 0;
  let truncatedRecords = 0;
  const emit = (event: Boundary) => {
    try {
      void Promise.resolve(observe(event)).catch(() => undefined);
    } catch {
      /* Telemetry is observational. */
    }
  };
  const line = (text: string) => {
    const marker = text.indexOf("codex_otel.trace_safe");
    if (marker < 0) {
      ordinary(Buffer.from(`${text}\n`));
      return;
    }
    parsedBytes += Buffer.byteLength(text) + 1;
    if (parsedBytes > limit) {
      truncatedRecords++;
      return;
    }
    const prefix =
      /^(?:\S+\s+)?(?:TRACE|DEBUG|INFO|WARN|ERROR)\s+codex_otel\.trace_safe:\s*/.exec(
        text,
      );
    const values = prefix ? fields(text.slice(prefix[0].length)) : undefined;
    const projected =
      values &&
      (!values.has("app.version") || values.get("app.version") === "0.160.0")
        ? project(values)
        : undefined;
    if (!projected) {
      unparsedRecords++;
      return;
    }
    parsedRecords++;
    emit(projected);
  };
  const consume = (text: string) => {
    for (const next of text) {
      if (next === "\n") {
        if (!dropping) line(pending.replace(/\r$/, ""));
        pending = "";
        dropping = false;
      } else if (!dropping) {
        pending += next;
        if (pending.length > 8192) {
          pending = "";
          dropping = true;
          parsedBytes = limit + 1;
          truncatedRecords++;
        }
      }
    }
  };
  return {
    chunk(chunk: Buffer) {
      if (!finished) {
        observedBytes += chunk.length;
        consume(decoder.write(chunk));
      }
    },
    finish() {
      if (finished) return;
      consume(decoder.end());
      finished = true;
      if (pending || dropping) truncatedRecords++;
      emit({
        event: "telemetry-coverage",
        status:
          truncatedRecords || unparsedRecords
            ? "incomplete"
            : parsedRecords
              ? "observed"
              : "unavailable",
        parsedRecords,
        unparsedRecords,
        truncatedRecords,
        observedBytes,
        submission: "unsupported",
      });
    },
  };
}

/** Exposed tool spans only; no tool text and no inference about time between spans. */
export function codexJsonBoundaries(observe: (event: Boundary) => void) {
  const tools = new Map<string, number>();
  let firstOutput = false;
  return (event: ThreadEvent) => {
    if (event.type === "thread.started") observe({ event: "thread-started" });
    if (event.type === "turn.completed") observe({ event: "turn-completed" });
    if (event.type === "turn.failed") observe({ event: "turn-failed" });
    if (
      event.type !== "item.started" &&
      event.type !== "item.updated" &&
      event.type !== "item.completed"
    )
      return;
    const item = event.item;
    if (
      !firstOutput &&
      event.type === "item.completed" &&
      (item.type === "agent_message" || item.type === "reasoning") &&
      item.text.trim().length > 0
    ) {
      firstOutput = true;
      observe({ event: "visible-output-item" });
    }
    if (item.type !== "command_execution" && item.type !== "mcp_tool_call")
      return;
    const tool = item.type === "command_execution" ? "shell" : "mcp";
    if (item.status === "in_progress" && !tools.has(item.id)) {
      tools.set(item.id, performance.now());
      observe({
        event: "tool-start",
        tool,
        ...(typeof item.id === "string" && /^[\w-]{1,256}$/.test(item.id)
          ? { toolCallId: item.id }
          : {}),
        toolStatus: item.status,
      });
    }
    if (event.type === "item.completed") {
      const start = tools.get(item.id);
      tools.delete(item.id);
      observe({
        event: "tool-end",
        tool,
        ...(typeof item.id === "string" && /^[\w-]{1,256}$/.test(item.id)
          ? { toolCallId: item.id }
          : {}),
        toolStatus: item.status,
        ...(start === undefined
          ? {}
          : { durationMs: Math.max(0, performance.now() - start) }),
      });
    }
  };
}
