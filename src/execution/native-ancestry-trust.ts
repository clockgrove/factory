import { deduplicateFactoryEvents } from "../control/receipts.js";
import type { FactoryEvent } from "../protocol/events.js";
import { parseRunPolicy } from "../protocol/policy.js";

/** Additional restrictions from an already authenticated recovery source run.
 * This does not authenticate a source or grant execution authority. */
export function nativeSourceRequiresIsolation(
  sourceRunId: string,
  authenticatedEvents: readonly FactoryEvent[],
): boolean {
  const starts = deduplicateFactoryEvents([...authenticatedEvents]).filter(
    (event) =>
      event.kind === "run" && event.event === "FactoryRunStarted" && event.runId === sourceRunId,
  );
  const start = starts[0];
  if (starts.length !== 1 || start?.kind !== "run" || start.event !== "FactoryRunStarted")
    throw new Error("stack execution ancestor lacks a unique authenticated source policy");
  return parseRunPolicy(start.policy).trust === "sandbox_untrusted";
}
