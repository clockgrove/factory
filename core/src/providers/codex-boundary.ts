/**
 * Codex's boundary telemetry (docs/reference/run-log.md#Codex boundary): what
 * the Codex runtime's own trace-safe records (`codex_otel.trace_safe`, the
 * pinned runtime's format) say about one call's requests, responses and
 * retries. Codex writes them to its standard error, which the launcher
 * appends to a file in the call's Codex home (codex.ts codexLauncher); this
 * reads that file once the call has stopped, from where the call began. It
 * keeps numbers and enumerated names only, never text, and gives back the
 * other standard error lines for the call's error message, which the SDK
 * would otherwise have carried. It only observes.
 */
import { closeSync, openSync, readSync, statSync } from "node:fs";

/** Codex's own errors, as before, and its trace-safe records. */
export const BOUNDARY_RUST_LOG = "error,codex_otel.trace_safe=trace";

/** The most of a call's standard error that is read: its end. */
const READ_MAX = 8 * 1024 * 1024;
/** A record longer than this is not one of the pinned format's. */
const LINE_MAX = 8 * 1024;
/** Standard error lines kept for an error message: the last of them. */
const ORDINARY_MAX = 16 * 1024;
/** Retries logged one by one per call; the rest are only counted. */
const RETRIES_LOGGED = 20;

/** One call's boundary, in its `model-usage` event as `codexBoundary`. */
export interface CodexBoundary {
  /** `observed`: records were read; `incomplete`: some lines couldn't be; `unavailable`: none came. */
  coverage: "observed" | "incomplete" | "unavailable";
  /** Model requests sent (a WebSocket request, or an HTTP request to `/responses`), and those that failed at the transport. */
  requests: number;
  failedRequests: number;
  /** WebSocket connections made. */
  connects: number;
  /** Responses that reached `response.completed`, the start-up warm-up's included, and those with no output tokens (the warm-up's left out). */
  responsesCompleted: number;
  zeroOutputResponses: number;
  /** Streams that ended in a failure Codex reported. */
  streamFailures: number;
  /** Codex's own retries, by layer, and their delays summed. */
  retries: { http: number; stream: number };
  retryDelayMs: number;
  /** Time to the first output token, as Codex measured it. */
  firstOutputMs?: number;
  /**
   * The call ended without its turn completing, with no stream failure
   * reported, and with a request whose response never completed: a lost
   * `response.completed`, the stall a hedge works around.
   */
  completionLost: boolean;
}

/** One retry Codex made: its layer and operation, delay and attempt, and Codex's time. */
export interface CodexRetry {
  layer: "http" | "stream";
  operation: string;
  delayMs: number;
  attempt: number;
  nativeAt?: string;
}

/** A call's standard error file, read from where the call began. */
export class CodexStderr {
  private readonly from: number;

  constructor(readonly file: string) {
    this.from = sizeOf(file);
  }

  /**
   * What the file says since the call began. `completed`: the SDK saw the
   * turn complete. The ordinary lines are its non-telemetry standard error.
   */
  read(completed: boolean): {
    boundary: CodexBoundary;
    retries: CodexRetry[];
    unlogged: number;
    ordinary: string;
  } {
    const text = tail(this.file, this.from);
    const boundary: CodexBoundary = {
      coverage: "unavailable",
      requests: 0,
      failedRequests: 0,
      connects: 0,
      responsesCompleted: 0,
      zeroOutputResponses: 0,
      streamFailures: 0,
      retries: { http: 0, stream: 0 },
      retryDelayMs: 0,
      completionLost: false,
    };
    const retries: CodexRetry[] = [];
    let unlogged = 0;
    let ordinary = "";
    let unread = 0;
    let parsed = 0;
    // The last response.completed, until the next record says whether it was the start-up warm-up.
    let lastResponse: { zero: boolean } | undefined;
    for (const line of text.split("\n")) {
      const marker = line.indexOf("codex_otel.trace_safe");
      if (marker < 0) {
        if (line.trim()) ordinary += `${line}\n`;
        continue;
      }
      const values =
        line.length <= LINE_MAX ? fields(afterPrefix(line)) : undefined;
      if (!values) {
        unread += 1;
        continue;
      }
      parsed += 1;
      const success = values.get("success");
      const name = values.get("event.name");
      // Codex warms its WebSocket up with a response of no output at start.
      if (
        lastResponse?.zero &&
        name === "codex.startup_phase" &&
        values.get("startup.phase") === "startup_prewarm_websocket_warmup"
      )
        boundary.zeroOutputResponses -= 1;
      lastResponse = undefined;
      switch (name) {
        case "codex.api_request":
          // Model list and other reads are not model requests.
          if (!values.get("endpoint")?.startsWith("/responses")) break;
          boundary.requests += 1;
          if (success === "false") boundary.failedRequests += 1;
          break;
        case "codex.websocket_request":
          boundary.requests += 1;
          if (success === "false") boundary.failedRequests += 1;
          break;
        case "codex.websocket_connect":
          boundary.connects += 1;
          break;
        case "codex.turn_ttft": {
          const ms = integer(values, "duration_ms");
          if (ms !== undefined) boundary.firstOutputMs ??= ms;
          break;
        }
        case "codex.retry": {
          const layer = values.get("retry.layer");
          const delayMs = integer(values, "retry.delay_ms") ?? 0;
          if (layer !== "http" && layer !== "stream") break;
          boundary.retries[layer] += 1;
          boundary.retryDelayMs += delayMs;
          const operation = values.get("retry.operation");
          const at = values.get("event.timestamp");
          if (retries.length >= RETRIES_LOGGED) unlogged += 1;
          else
            retries.push({
              layer,
              operation:
                operation && /^[a-z_0-9]{1,40}$/.test(operation)
                  ? operation
                  : "unknown",
              delayMs,
              attempt: integer(values, "retry.attempt") ?? 0,
              ...(at && Number.isFinite(Date.parse(at))
                ? { nativeAt: new Date(at).toISOString() }
                : {}),
            });
          break;
        }
        case "codex.sse_event":
          if (values.has("error.message")) boundary.streamFailures += 1;
          else if (values.get("event.kind") === "response.completed") {
            boundary.responsesCompleted += 1;
            const zero = integer(values, "output_token_count") === 0;
            if (zero) boundary.zeroOutputResponses += 1;
            lastResponse = { zero };
          }
          break;
      }
    }
    boundary.coverage = unread
      ? "incomplete"
      : parsed
        ? "observed"
        : "unavailable";
    boundary.completionLost =
      !completed &&
      boundary.streamFailures === 0 &&
      boundary.requests > boundary.responsesCompleted;
    return {
      boundary,
      retries,
      unlogged,
      ordinary: ordinary.slice(-ORDINARY_MAX),
    };
  }
}

/** A failed codex run's error with its standard error, as the SDK reported it before it went to the file. */
export function withStderr(error: unknown, ordinary: string): unknown {
  if (!(error instanceof Error) || !ordinary) return error;
  if (!/^Codex Exec exited with [^:]*: $/.test(error.message)) return error;
  return new Error(`${error.message}${ordinary}`);
}

/** The record after its level and target: `event.name="codex.retry" retry.layer=http ...`. */
function afterPrefix(line: string): string {
  const prefix =
    /^(?:\S+\s+)?(?:TRACE|DEBUG|INFO|WARN|ERROR)\s+codex_otel\.trace_safe:\s*/.exec(
      line,
    );
  return prefix ? line.slice(prefix[0].length) : "";
}

/** `key=value` pairs, values bare or JSON-quoted; undefined for anything else. */
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
  return result.size ? result : undefined;
}

function integer(values: Map<string, string>, key: string): number | undefined {
  const value = values.get(key);
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function sizeOf(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

/** The file's text from `from`, its last READ_MAX bytes at most; empty when unreadable. */
function tail(file: string, from: number): string {
  const size = sizeOf(file);
  const start = Math.max(from, size - READ_MAX);
  if (size <= start) return "";
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const buffer = Buffer.alloc(size - start);
    const read = readSync(fd, buffer, 0, buffer.length, start);
    return buffer.subarray(0, read).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** After a call: its boundary into `record` (`codexBoundary`), and one `codex-retry` event per retry Codex made. */
export function logBoundary(
  record: Record<string, unknown>,
  log: (event: Record<string, unknown>) => void,
  stderr: CodexStderr,
  completed: boolean,
): void {
  const { boundary, retries, unlogged } = stderr.read(completed);
  record.codexBoundary = boundary;
  for (const retry of retries)
    log({ event: "codex-retry", callId: record.callId, ...retry });
  if (unlogged) log({ event: "codex-retry", callId: record.callId, unlogged });
}
