// Preloaded (`node --import`) into fault-matrix controller processes only.
// Factory's repeat backoff and amendment loops sleep with
// `timers/promises.setTimeout` and expose no clock to inject, so the test
// scales those sleeps by FACTORY_TEST_TIME_SCALE. Wall-clock deadlines such as
// GitHub rate-limit waits still compare against Date.now(), so they keep their
// real meaning; they just poll more often.
import { createRequire, syncBuiltinESMExports } from "node:module";

const scale = Number(process.env.FACTORY_TEST_TIME_SCALE ?? "1");
if (Number.isFinite(scale) && scale >= 0 && scale !== 1) {
  const timers = createRequire(import.meta.url)("node:timers/promises");
  const original = timers.setTimeout;
  timers.setTimeout = (delay, value, options) =>
    original(Math.ceil((Number(delay) || 0) * scale), value, options);
  syncBuiltinESMExports();
}
