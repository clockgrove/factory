import type { BetaManagedAgentsSessionEvent } from "@anthropic-ai/sdk/resources/beta/sessions/events";

export interface ClaudeAttemptBoundary {
  inputEventId: string;
  interruptEventId?: string;
}
export type ClaudeTurnDisposition =
  | { state: "running"; detail: string }
  | { state: "failed"; detail: string; endEventId?: string }
  | { state: "output-pending"; endEventId: string }
  | { state: "interrupted"; endEventId: string };

/** Session history, not transport disconnect or idle alone, establishes the turn boundary.
 * Interrupted means the provider applied the interrupt; it does NOT assert shell-child cessation.
 */
export function claudeTurnDisposition(
  events: BetaManagedAgentsSessionEvent[],
  boundary: ClaudeAttemptBoundary,
): ClaudeTurnDisposition {
  const seen = new Set<string>();
  for (const event of events) {
    if (!event.id || seen.has(event.id))
      throw new Error(
        "Claude session history contains duplicate or missing identities",
      );
    seen.add(event.id);
  }
  const inputIndex = events.findIndex(
    (event) => event.id === boundary.inputEventId,
  );
  const input = events[inputIndex];
  if (!input || input.type !== "user.message" || !input.processed_at)
    return { state: "running", detail: "Recorded input is not yet processed" };
  const later = events.slice(inputIndex + 1);
  if (
    later.some(
      (event) =>
        event.type === "user.message" ||
        event.type === "system.message" ||
        event.type === "session.updated" ||
        event.type === "session.thread_created" ||
        event.type === "agent.mcp_tool_use" ||
        event.type === "agent.custom_tool_use",
    )
  )
    throw new Error(
      "Claude session contains activity outside the bound attempt",
    );
  const interrupts = later.filter((event) => event.type === "user.interrupt");
  if (interrupts.some((event) => event.id !== boundary.interruptEventId))
    throw new Error("Claude session contains an unowned interrupt");
  const outstanding = new Set<string>();
  let end:
    | Extract<BetaManagedAgentsSessionEvent, { type: "session.status_idle" }>
    | undefined;
  for (const event of later) {
    if (event.type === "agent.tool_use") outstanding.add(event.id);
    if (event.type === "agent.tool_result") {
      if (!outstanding.delete(event.tool_use_id))
        throw new Error("Claude tool result has no matching attempt tool call");
    }
    if (
      event.type === "session.status_running" ||
      event.type === "session.status_rescheduled"
    )
      end = undefined;
    if (event.type === "session.status_idle") end = event;
    if (
      event.type === "session.status_terminated" ||
      event.type === "session.deleted"
    )
      return {
        state: "failed",
        detail: "Claude session terminated without a complete result boundary",
        endEventId: event.id,
      };
  }
  if (!end || outstanding.size)
    return {
      state: "running",
      detail: "Claude turn or tool calls remain active",
    };
  if (
    end.stop_reason.type === "budget_reached" ||
    end.stop_reason.type === "retries_exhausted"
  )
    return {
      state: "failed",
      detail: `Claude stopped: ${end.stop_reason.type}`,
      endEventId: end.id,
    };
  if (end.stop_reason.type !== "end_turn")
    return {
      state: "running",
      detail: "Claude awaits an external tool decision",
    };
  if (boundary.interruptEventId) {
    const index = later.findIndex(
      (event) => event.id === boundary.interruptEventId,
    );
    const interrupt = later[index];
    if (!interrupt?.processed_at || index >= later.indexOf(end))
      return {
        state: "running",
        detail: "Claude interrupt is not yet applied",
      };
    return { state: "interrupted", endEventId: end.id };
  }
  return { state: "output-pending", endEventId: end.id };
}
