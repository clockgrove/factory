import { describe, expect, it } from "vitest";

import { runlessSuiteVerdict } from "../src/github.js";

/**
 * Tests for runless check suites (§9).
 *
 * A `pull_request` workflow can fail at *startup* and produce zero jobs, so its
 * check suite concludes `FAILURE` with `latest_check_runs_count: 0`.
 * `statusCheckRollup` is derived from check *runs*, so it stays `null` — the
 * same shape as "no CI configured". Suites are therefore consulted whenever the
 * rollup is silent.
 */
function suite(
  conclusion: string | null,
  totalCount = 0,
  status = "COMPLETED",
): { status: string; conclusion: string | null; checkRuns: { totalCount: number } } {
  return { status, conclusion, checkRuns: { totalCount } };
}

describe("runlessSuiteVerdict", () => {
  it("is silent when there are no suites at all", () => {
    expect(runlessSuiteVerdict([])).toBeNull();
  });

  it("is silent when every suite produced check runs", () => {
    // The rollup already accounts for these; consulting them again would
    // double-count and could contradict it.
    expect(runlessSuiteVerdict([suite("FAILURE", 3), suite("SUCCESS", 1)])).toBeNull();
  });

  // The exact shape of a workflow that fails at startup before producing jobs.
  it("reports FAILURE for a completed suite that produced no check runs", () => {
    expect(runlessSuiteVerdict([suite("FAILURE")])).toBe("FAILURE");
  });

  it("treats a startup failure as a failure, not an absence", () => {
    expect(runlessSuiteVerdict([suite("STARTUP_FAILURE")])).toBe("FAILURE");
  });

  it.each(["CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STALE"])(
    "treats a runless %s suite as a failure",
    (conclusion) => {
      expect(runlessSuiteVerdict([suite(conclusion)])).toBe("FAILURE");
    },
  );

  it("stays silent for benign runless conclusions", () => {
    // A suite that concluded SUCCESS/NEUTRAL/SKIPPED without emitting a run
    // genuinely had nothing to say about this commit (e.g. every job was
    // filtered out by a path or branch condition). Blocking on that would
    // deadlock ordinary repositories.
    for (const conclusion of ["SUCCESS", "NEUTRAL", "SKIPPED"]) {
      expect(runlessSuiteVerdict([suite(conclusion)])).toBeNull();
    }
  });

  it("reports PENDING while a runless suite is still in flight", () => {
    expect(runlessSuiteVerdict([suite(null, 0, "QUEUED")])).toBe("PENDING");
    expect(runlessSuiteVerdict([suite(null, 0, "IN_PROGRESS")])).toBe("PENDING");
  });

  it("prefers PENDING over FAILURE when one suite is still running", () => {
    // Something is still coming, so the honest answer is "not settled" — the
    // loop waits a cycle rather than retrying against a half-reported result.
    expect(runlessSuiteVerdict([suite("FAILURE"), suite(null, 0, "IN_PROGRESS")])).toBe(
      "PENDING",
    );
  });

  it("ignores run-producing suites when judging runless ones", () => {
    expect(runlessSuiteVerdict([suite("SUCCESS", 2), suite("FAILURE")])).toBe("FAILURE");
  });
});
