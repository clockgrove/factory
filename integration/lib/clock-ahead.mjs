// Preload (node --import) that runs this process's wall clock ahead by
// DRILL_CLOCK_AHEAD_MS, for the host-clock-ahead drill (operator.clock-ahead).
// Only Date moves; timers and performance.now() keep real time, as a host
// whose clock is set ahead would.
const ahead = Number(process.env.DRILL_CLOCK_AHEAD_MS ?? 0);
if (ahead) {
  const RealDate = Date;
  class AheadDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(RealDate.now() + ahead);
      else super(...args);
    }
    static now() {
      return RealDate.now() + ahead;
    }
  }
  globalThis.Date = AheadDate;
}
