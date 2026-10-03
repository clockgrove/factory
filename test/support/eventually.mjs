import { setTimeout as sleep } from "node:timers/promises";

/**
 * Poll `check` until it returns a truthy value or throws no more, then return
 * that value. A thrown error or falsy result before the deadline is retried;
 * at the deadline the last error (or a timeout error) is raised. Prefer this to
 * fixed-count polling loops: the budget is wall time, so a loaded machine slows
 * the poll instead of failing it.
 */
export async function eventually(
  check,
  { timeoutMs = 30_000, intervalMs = 20, message = "condition" } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    try {
      const value = await check();
      if (value) return value;
      last = undefined;
    } catch (error) {
      last = error;
    }
    if (Date.now() >= deadline)
      throw (
        last ??
        new Error(`Timed out after ${timeoutMs}ms waiting for ${message}`)
      );
    await sleep(intervalMs);
  }
}
