// Preloaded (`node --import`) into fault-matrix controller processes, and
// called by in-process suites that wait on step polls. Factory's step
// backoff, CI polls and amendment loops sleep with
// `timers/promises.setTimeout` and expose no clock to the application, so
// the test scales those sleeps. Wall-clock deadlines such as GitHub
// rate-limit waits or lag windows still compare against Date.now(), so they
// keep their real meaning; they just poll more often.
import { createRequire, syncBuiltinESMExports } from "node:module";

/** Scale every later `timers/promises` sleep in this process by `scale`. */
export function scaleTimers(scale) {
  if (!Number.isFinite(scale) || scale < 0 || scale === 1) return;
  const timers = createRequire(import.meta.url)("node:timers/promises");
  const original = timers.setTimeout;
  timers.setTimeout = (delay, value, options) =>
    original(Math.ceil((Number(delay) || 0) * scale), value, options);
  syncBuiltinESMExports();
}

scaleTimers(Number(process.env.FACTORY_TEST_TIME_SCALE ?? "1"));
