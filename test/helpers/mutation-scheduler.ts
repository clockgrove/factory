import { MutationScheduler } from "../../src/platform.js";

/** Exercise production admission rules without waiting for wall-clock quota windows. */
export function advancingMutationScheduler(): MutationScheduler {
  let now = Date.parse("2026-01-01T00:00:00Z");
  return new MutationScheduler({
    now: () => new Date(now),
    sleep: async (milliseconds) => {
      now += milliseconds;
    },
  });
}
