// The dead-end finder (#515): every reachable non-terminal state must have an
// exit. Each case restarts the real controller once from an enumerated state
// (see test/support/dead-ends.mjs) and fails if the Objective is stranded: the
// restart neither progresses nor completes, and the command the status names
// (if any) does not continue it.
//
// Known dead ends are inverted, like the fault matrix's known failures: the
// test passes while the state stays stranded for its diagnosed reason and fails
// once it has an exit; then remove its entry.
import assert from "node:assert/strict";
import { availableParallelism } from "node:os";
import { describe, test } from "node:test";
import { prepare } from "./support/dead-ends.mjs";

const D = {
  START_AMBIGUOUS: {
    diagnosis:
      "regular delivery: a Work Item persisted at running/execute before its driver handle (the checkpoint just before driver.start) is refused on every restart as 'ambiguous active state at execute; operator direction required', and status names only `factory diagnostics` (the fault matrix's START_AMBIGUOUS, r1 #4)",
    pattern: /ambiguous active state at execute/,
  },
  CANCEL_WITHOUT_HANDLE: {
    diagnosis:
      "cancelling while a Work Item sits at execute without a recorded driver handle never finishes, even when that item already failed: cancelKnownWork refuses 'Active attempt has no stable handle; cessation is unknown', and status names `factory cancel`, which refuses the same way",
    pattern: /factory cancel is refused \(Active attempt has no stable handle/,
  },
  REPAIR_REFUSED: {
    diagnosis:
      "a step failure that is not isolated (an unclassified error or exhausted interruptions) leaves the item's recovery 'stopped' and stops the Objective (state.error): status names `factory repair`, which refuses any Objective with state.error ('Objective is not available for diagnosed repair'); `factory retry`, never named, also refuses at deliver, after a PR, and for an attempt with a handle and an uncertain outcome",
    pattern:
      /factory repair is refused \(.*Objective is not available for diagnosed repair/,
  },
  DECIDE_REFUSED: {
    diagnosis:
      "a pending result or final criterion with state.error set (any stop on a later restart, such as a failed fetch before the final review): status names `factory decide-result`, which refuses while state.error is set ('Objective is not awaiting a result decision'), and with no failed item nothing clears state.error",
    pattern:
      /factory decide-result is refused \(Objective is not awaiting a result decision\)/,
  },
  STOPPED_WITHOUT_EXIT: {
    diagnosis:
      "state.error with no failed, unpublished Work Item (a stop outside any Work Item step, or a failed item with a PR): every restart refuses 'Objective stopped: … Use explicit retry or operator direction', status names only `factory diagnostics`, and retry needs a failed item without a PR (r1 #1, #2)",
    pattern:
      /only inspection \(factory diagnostics\) after stopped: Objective stopped:/,
  },
  DRAINED: {
    diagnosis:
      "a drained Objective (`factory drain`, or the SIGTERM handoff) stays 'draining' in the snapshot: a restarted `factory run` waits forever for a control request, and status names `factory run` instead of `factory resume` (it offers resume only when paused)",
    pattern: /factory run does not continue after idle/,
  },
  PLANNING_CANCEL: {
    diagnosis:
      "an unresolved cancellation during planning (coordinator.cancelError on a preparation): every restart throws 'Objective cancellation requested' because the owner's cancel never clears the earlier cancelError, and preparation status ignores cancelError and names `factory run` instead of `factory cancel`",
    pattern:
      /factory run does not continue after stopped: Objective cancellation requested/,
  },
};

/** Stranded states by diagnosis; names are the enumerated case names. */
const KNOWN = {
  [D.START_AMBIGUOUS.diagnosis]: [
    "regular: alpha running/execute; beta pending",
    "regular: alpha running/execute; beta pending + draining + review phase reserved",
    "regular: alpha running/execute; beta pending + paused + interruptions exhausted",
    "regular: alpha running/execute; beta pending + paused + validation phase reserved",
    "regular: alpha running/execute; beta pending + draining + validation phase reserved",
    "regular: alpha running/execute; beta pending + coding phase reserved + interruptions exhausted",
    "regular: alpha running/execute; beta pending + review phase reserved + interruptions exhausted",
  ],
  [D.CANCEL_WITHOUT_HANDLE.diagnosis]: [
    "regular: alpha running/execute; beta pending + a step exhausts its interruptions + cancel was requested",
    "regular: alpha running/execute; beta pending + cancel was requested + validation phase reserved",
    "regular: alpha running/execute; beta pending + cancel was requested + review phase reserved",
    "regular: alpha running/execute; beta pending + cancellation is unresolved + review phase reserved",
    "native-stack: alpha running/execute; beta pending + the worker settles without a result + cancel was requested",
    "native-stack: alpha running/execute; beta pending + cancel was requested + delivery phase reserved",
    "native-stack: alpha running/execute; beta pending + cancellation is unresolved + validation phase reserved",
  ],
  [D.REPAIR_REFUSED.diagnosis]: [
    "regular: alpha running/validate (handle); beta pending + a step fails with an unclassified error + GitHub observation failed",
    "regular: alpha waiting/approve-result (handle, pending criterion); beta pending + a step exhausts its interruptions + review phase reserved",
    "regular: alpha running/execute; beta pending + a step fails with an unclassified error + validation phase reserved",
    "regular: alpha waiting/approve-result (handle, pending criterion); beta pending + a step fails with an unclassified error + delivery phase reserved",
    "regular: alpha running/deliver (handle); beta pending + a step fails with an unclassified error + draining",
    "regular: alpha published (handle, PR); beta pending + a step exhausts its interruptions + coding phase reserved",
    "regular: alpha running/deliver (handle); beta pending + a step exhausts its interruptions + paused",
    "regular: alpha published (handle, PR); beta pending + a step fails with an unclassified error + review phase reserved",
    "regular: alpha published (handle, PR); beta pending + a step exhausts its interruptions + validation phase reserved",
    "regular: alpha running/execute; beta pending + a step fails with an unclassified error + coding phase reserved",
    "regular: alpha running/execute (handle); beta pending + a step exhausts its interruptions + draining",
    "regular: alpha running/validate (handle); beta pending + a step exhausts its interruptions + delivery phase reserved",
    "regular: alpha running/execute; beta pending + the worker settles without a result + an error stops the Objective outside any Work Item step",
    "regular: alpha running/validate (handle); beta pending + the validation environment fails + an error stops the Objective outside any Work Item step",
    "regular: alpha running/deliver (handle); beta pending + a step fails with an unclassified error + coding phase reserved",
    "regular: alpha running/deliver (handle); beta pending + a step fails with an unclassified error + validation phase reserved",
    "regular: alpha running/deliver (handle); beta pending + a step fails with an unclassified error + review phase reserved",
    "native-stack: alpha running/execute; beta pending + a step fails with an unclassified error + GitHub observation failed",
    "native-stack: alpha waiting/approve-result (pending criterion); beta pending + a step exhausts its interruptions + draining",
    "native-stack: alpha running/deliver (PR); beta pending + a step fails with an unclassified error + validation phase reserved",
    "native-stack: alpha published (PR); beta pending + a step exhausts its interruptions + review phase reserved",
    "native-stack: alpha waiting/approve-result (pending criterion); beta pending + a step fails with an unclassified error + delivery phase reserved",
    "native-stack: alpha running/validate; beta pending + a step fails with an unclassified error + draining",
    "native-stack: alpha running/validate; beta pending + a step exhausts its interruptions + paused",
    "native-stack: alpha running/execute; beta pending + a step exhausts its interruptions + delivery phase reserved",
    "native-stack: alpha running/validate; beta pending + a step fails with an unclassified error + review phase reserved",
    "native-stack: alpha running/validate; beta pending + a step exhausts its interruptions + validation phase reserved",
    "native-stack: alpha running/execute; beta pending + the worker settles without a result + an error stops the Objective outside any Work Item step",
    "native-stack: alpha running/validate; beta pending + the validation environment fails + an error stops the Objective outside any Work Item step",
    "native-stack: alpha running/deliver; beta pending + a step fails with an unclassified error + coding phase reserved",
  ],
  [D.DECIDE_REFUSED.diagnosis]: [
    "regular: alpha done; beta done (handle, PR, closure complete); pending final criterion + an error stops the Objective outside any Work Item step",
    "regular: alpha waiting/approve-result (handle, pending criterion); beta pending + an error stops the Objective outside any Work Item step",
    "native-stack: alpha done; beta done (PR, closure complete); pending final criterion; stack merge pending + an error stops the Objective outside any Work Item step",
    "native-stack: alpha waiting/approve-result (pending criterion); beta pending + an error stops the Objective outside any Work Item step",
  ],
  [D.STOPPED_WITHOUT_EXIT.diagnosis]: [
    "regular: alpha running/validate (handle); beta pending + an error stops the Objective outside any Work Item step + interruptions exhausted",
    "regular: alpha pending; beta pending + an error stops the Objective outside any Work Item step",
    "regular: alpha published (handle, PR); beta pending + an error stops the Objective outside any Work Item step",
    "native-stack: alpha running/validate; beta pending + an error stops the Objective outside any Work Item step + interruptions exhausted",
    "native-stack: alpha published (PR); beta pending + an error stops the Objective outside any Work Item step + review phase reserved",
    "native-stack: alpha pending; beta pending + an error stops the Objective outside any Work Item step",
  ],
  [D.DRAINED.diagnosis]: [
    "regular: alpha running/validate (handle); beta pending + the validation environment fails + draining",
    "regular: alpha published (handle, PR); beta pending + draining + interruptions exhausted",
    "regular: preparing, no plan, 0 issues, planning + draining",
    "regular: preparing, plan clean, planning complete, 1 issues, projection + draining",
    "regular: alpha done; beta done (handle, PR, closure complete); pending final criterion + draining",
    "regular: preparing, no plan, planning submitted, 0 issues, planning + draining",
    "regular: preparing, no plan, planning ready, 0 issues, planning + draining",
    "regular: preparing, plan clean, planning complete, 2 issues, projection + draining",
    "regular: alpha pending; beta pending + draining",
    "regular: alpha running/execute; beta pending + the worker settles without a result + draining",
    "regular: alpha done; beta done (handle, PR, closure complete); final validation + draining",
    "regular: alpha done; beta done (handle, PR, closure complete); final validation; Objective closure pending + draining",
    "native-stack: alpha running/execute (handle); beta pending + the worker settles without a result + draining",
    "native-stack: alpha published (PR); beta pending + draining + validation phase reserved",
    "native-stack: preparing, no plan, 0 issues, planning + draining",
    "native-stack: preparing, plan clean, planning complete, 1 issues, projection + draining",
    "native-stack: alpha done; beta done (PR, closure complete); pending final criterion; stack merge pending + draining",
    "native-stack: preparing, no plan, planning submitted, 0 issues, planning + draining",
    "native-stack: preparing, no plan, planning ready, 0 issues, planning + draining",
    "native-stack: preparing, plan clean, planning complete, 2 issues, projection + draining",
    "native-stack: alpha pending; beta pending + draining",
    "native-stack: alpha running/validate; beta pending + the validation environment fails + draining",
    "native-stack: alpha done; beta done (PR, closure complete); final validation; stack merge pending + draining",
    "native-stack: alpha done; beta done (PR, closure complete); final validation; Objective closure pending; stack merge pending + draining",
  ],
  [D.PLANNING_CANCEL.diagnosis]: [
    "regular: preparing, no plan, 0 issues, planning + cancellation is unresolved",
    "regular: preparing, plan clean, planning complete, 1 issues, projection + cancellation is unresolved",
    "regular: preparing, no plan, planning submitted, 0 issues, planning + cancellation is unresolved",
    "regular: preparing, no plan, planning ready, 0 issues, planning + cancellation is unresolved",
    "regular: preparing, plan clean, planning complete, 2 issues, projection + cancellation is unresolved",
    "native-stack: preparing, no plan, 0 issues, planning + cancellation is unresolved + a repeat record is pending",
    "native-stack: preparing, plan clean, planning complete, 1 issues, projection + cancellation is unresolved",
    "native-stack: preparing, no plan, planning submitted, 0 issues, planning + cancellation is unresolved",
    "native-stack: preparing, no plan, planning ready, 0 issues, planning + cancellation is unresolved",
    "native-stack: preparing, plan clean, planning complete, 2 issues, projection + cancellation is unresolved",
  ],
};

const known = new Map();
for (const [diagnosis, names] of Object.entries(KNOWN))
  for (const name of names) {
    assert.ok(!known.has(name), `Duplicate known dead end: ${name}`);
    known.set(name, diagnosis);
  }
const byDiagnosis = new Map(
  Object.values(D).map((entry) => [entry.diagnosis, entry]),
);

// Cases run one at a time per slot; a slot is one recorded world root.
const slots = Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2)));
const { cases, schedule } = await prepare({
  deliveries: ["regular", "native-stack"],
  slots,
});

describe("dead ends", { concurrency: true }, () => {
  test("every known dead end names an enumerated state", () => {
    const names = new Set(cases.map((testCase) => testCase.name));
    for (const name of known.keys())
      assert.ok(names.has(name), `Not enumerated; remove it: ${name}`);
  });
  for (const testCase of cases) {
    test(testCase.name, { timeout: 3_600_000 }, async (t) => {
      const outcome = await schedule(testCase);
      const detail = `${outcome.kind}: ${outcome.reason ?? ""}\n${outcome.trace.join("\n")}`;
      const diagnosis = known.get(testCase.name);
      if (!diagnosis) {
        assert.notEqual(outcome.kind, "stranded", detail);
        return;
      }
      const { pattern } = byDiagnosis.get(diagnosis);
      if (outcome.kind === "stranded") {
        assert.match(outcome.reason, pattern, detail);
        t.diagnostic(`known dead end: ${diagnosis}`);
        return;
      }
      assert.fail(
        `Known dead end no longer reproduces; remove it from KNOWN in test/dead-ends.test.mjs: ${diagnosis}\n${detail}`,
      );
    });
  }
});
