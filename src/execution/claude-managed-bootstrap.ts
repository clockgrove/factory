import { isDeepStrictEqual } from "node:util";
import type { BetaManagedAgentsSessionEvent } from "@anthropic-ai/sdk/resources/beta/sessions/events";
import { claudeTurnDisposition } from "./claude-managed-events.js";
import { claudeByteDigest } from "./claude-managed-transfer.js";
import type { ClaudePreparedInput } from "./claude-managed-input.js";

/** A provider-recorded execution of our immutable foreground script plus complete byte receipts.
 * Agent-written messages are deliberately not evidence of materialization.
 */
export function verifyClaudeBootstrap(
  events: BetaManagedAgentsSessionEvent[],
  inputEventId: string,
  command: string,
  receiptBytes: Uint8Array,
  input: Pick<ClaudePreparedInput, "digest" | "treeSha" | "files"> & {
    baseSha: string;
  },
): {
  inputEventId: string;
  endEventId: string;
  toolEventId: string;
  receiptDigest: string;
  historyDigest: string;
} {
  const turn = claudeTurnDisposition(events, { inputEventId });
  if (turn.state !== "output-pending")
    throw new Error("Claude bootstrap is not a completed owned turn");
  const tools = events.filter((event) => event.type === "agent.tool_use");
  const tool = tools[0];
  if (
    tools.length !== 1 ||
    !tool ||
    tool.name !== "bash" ||
    tool.input.command !== command ||
    Object.keys(tool.input).some(
      (key) => !["command", "timeout_ms"].includes(key),
    ) ||
    (tool.input.timeout_ms !== undefined &&
      (!Number.isSafeInteger(tool.input.timeout_ms) ||
        Number(tool.input.timeout_ms) < 0))
  )
    throw new Error(
      "Claude bootstrap executed outside its exact foreground command",
    );
  const results = events.filter((event) => event.type === "agent.tool_result");
  const result = results[0];
  if (
    results.length !== 1 ||
    !result ||
    result.tool_use_id !== tool.id ||
    result.is_error === true ||
    !result.processed_at ||
    events.indexOf(tool) <=
      events.findIndex((event) => event.id === inputEventId) ||
    events.indexOf(result) >=
      events.findIndex((event) => event.id === turn.endEventId)
  )
    throw new Error(
      "Claude bootstrap lacks its successful provider tool result",
    );
  const allowed = new Set([
    "user.message",
    "agent.message",
    "agent.thinking",
    "agent.tool_use",
    "agent.tool_result",
    "session.status_running",
    "session.status_idle",
    "span.model_request_start",
    "span.model_request_end",
    "session.usage",
  ]);
  if (
    events.some((event) => !allowed.has(event.type)) ||
    events.filter((event) => event.type === "user.message").length !== 1
  )
    throw new Error("Claude bootstrap history contains unexplained activity");
  const receipt: unknown = JSON.parse(
    Buffer.from(receiptBytes).toString("utf8"),
  );
  const expected = {
    inputDigest: input.digest,
    baseSha: input.baseSha,
    treeSha: input.treeSha,
    files: input.files,
  };
  if (!isDeepStrictEqual(receipt, expected))
    throw new Error(
      "Claude bootstrap workspace differs from the complete pinned input",
    );
  return {
    inputEventId,
    endEventId: turn.endEventId,
    toolEventId: tool.id,
    receiptDigest: claudeByteDigest(receiptBytes),
    historyDigest: claudeByteDigest(Buffer.from(JSON.stringify(events))),
  };
}
