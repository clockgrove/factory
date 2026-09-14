import { MutationScheduler } from "../../src/platform.js";

/** Exercise production admission with deterministic telemetry timestamps. */
export function fixedClockMutationScheduler(): MutationScheduler {
  const now = Date.parse("2026-01-01T00:00:00Z");
  return new MutationScheduler({
    now: () => new Date(now),
  });
}
