// The dead-end finder (#515): every reachable non-terminal state must have an
// exit. Each case restarts the real controller from an enumerated state (see
// test/support/dead-ends.mjs) and fails if the Objective is stranded: the
// restart neither progresses nor completes, and following the commands the
// status names does not continue it.
//
// Known dead ends are inverted, like the fault matrix's known failures: the
// test passes while the state stays stranded for its diagnosed reason and fails
// once it has an exit; then remove its entry. Entries name a state by its
// structure — delivery, anchor shape, overlays — and are checked whether or
// not the pairwise sample picks them.
import assert from "node:assert/strict";
import { availableParallelism } from "node:os";
import { describe, test } from "node:test";
import { identityName, prepare } from "./support/dead-ends.mjs";

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
  PLAN_REFUSAL_DISCARDS: {
    diagnosis:
      "planning stopped for a decision while the Objective is paused or draining: status names `factory decide --outcome refuse`, which deletes the whole preparation, so the pause or drain is silently dropped and the next `factory run` plans again",
    pattern:
      /factory decide discards the preparation with its (paused|draining) mode/,
  },
  PLANNING_CANCEL: {
    diagnosis:
      "a cancel during planning whose cessation cannot be verified (here a recorded subprocess whose pid was reused) records cancelError; the owner's cancel never clears it, so every restart throws 'Objective cancellation requested', and preparation status ignores cancelError and names `factory run`",
    pattern:
      /factory run does not continue after stopped: Objective cancellation requested/,
  },
  DECIDE_REFUSED: {
    diagnosis:
      "a pending result or final criterion with state.error set (any stop on a later restart, such as a failed fetch before the final review): status names `factory decide-result`, which refuses while state.error is set ('Objective is not awaiting a result decision'), and with no failed item nothing clears state.error",
    pattern:
      /factory decide-result is refused \(Objective is not awaiting a result decision\)/,
  },
  REPAIR_REFUSED: {
    diagnosis:
      "a step failure that is not isolated (an unclassified error or exhausted interruptions) leaves the item's recovery 'stopped' and stops the Objective (state.error): status names `factory repair`, which refuses any Objective with state.error ('Objective is not available for diagnosed repair'); `factory retry`, never named, also refuses at deliver, after a PR, and for an attempt with a handle and an uncertain outcome",
    pattern:
      /factory repair is refused \(.*Objective is not available for diagnosed repair/,
  },
  REUSED_PID: {
    diagnosis:
      "a recorded subprocess whose pid now leads another process group (pid reuse after a crash or reboot, so its start time differs) never resolves: the restart's subprocess cleanup throws 'Subprocess owner identity is unresolved; operator direction required', stopping the Objective, and `factory cancel` throws the same, so no command clears the record",
    pattern: /Subprocess owner identity is unresolved/,
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
    pattern:
      /factory run does not continue after idle: .*\(coordinator draining/,
  },
};

/** Stranded states by diagnosis: [delivery, anchor shape, ...overlays]. */
const KNOWN = {
  [D.START_AMBIGUOUS.diagnosis]: [
    ["regular", "alpha running/execute; beta pending"],
    [
      "regular",
      "alpha running/execute; beta pending",
      "paused",
      "interruptions exhausted",
    ],
    [
      "regular",
      "alpha running/execute; beta pending",
      "coding phase reserved",
      "a recorded subprocess has exited",
    ],
    [
      "regular",
      "alpha running/execute; beta pending",
      "paused",
      "validation phase reserved",
    ],
  ],
  [D.CANCEL_WITHOUT_HANDLE.diagnosis]: [
    [
      "regular",
      "alpha running/execute; beta pending",
      "a step exhausts its interruptions",
      "cancel was requested",
    ],
    [
      "regular",
      "alpha running/execute; beta pending",
      "cancellation is unresolved",
      "validation phase reserved",
    ],
    [
      "native-stack",
      "alpha running/execute; beta pending",
      "a step fails with an unclassified error",
      "cancellation is unresolved",
    ],
    [
      "native-stack",
      "alpha running/execute; beta pending",
      "cancel was requested",
      "validation phase reserved",
    ],
    [
      "native-stack",
      "alpha running/execute; beta pending",
      "cancellation is unresolved",
      "validation phase reserved",
    ],
  ],
  [D.PLAN_REFUSAL_DISCARDS.diagnosis]: [
    [
      "regular",
      "preparing, no plan, 0 issues, planning",
      "draining",
      "planning stopped",
    ],
    [
      "regular",
      "preparing, no plan, 0 issues, planning",
      "paused",
      "planning stopped",
    ],
    [
      "native-stack",
      "preparing, no plan, 0 issues, planning",
      "draining",
      "planning stopped",
    ],
    [
      "native-stack",
      "preparing, no plan, 0 issues, planning",
      "paused",
      "planning stopped",
    ],
  ],
  [D.PLANNING_CANCEL.diagnosis]: [
    [
      "regular",
      "preparing, no plan, 0 issues, planning",
      "cancel was requested",
      "a recorded subprocess's pid was reused",
    ],
    [
      "regular",
      "preparing, plan clean, planning complete, 2 issues, projection",
      "cancel was requested",
      "a recorded subprocess's pid was reused",
    ],
    [
      "native-stack",
      "preparing, no plan, 0 issues, planning",
      "cancel was requested",
      "a recorded subprocess's pid was reused",
    ],
    [
      "native-stack",
      "preparing, plan clean, planning complete, 2 issues, projection",
      "cancel was requested",
      "a recorded subprocess's pid was reused",
    ],
  ],
  [D.DECIDE_REFUSED.diagnosis]: [
    [
      "regular",
      "alpha done; beta done (handle, PR, closure complete); pending final criterion",
      "an error stops the Objective outside any Work Item step",
      "a recorded subprocess's pid was reused",
    ],
    [
      "regular",
      "alpha waiting/approve-result (handle, pending criterion); beta pending",
      "an error stops the Objective outside any Work Item step",
    ],
    [
      "native-stack",
      "alpha done; beta done (PR, closure complete); pending final criterion; stack merge pending",
      "an error stops the Objective outside any Work Item step",
    ],
    [
      "native-stack",
      "alpha waiting/approve-result (pending criterion); beta pending",
      "an error stops the Objective outside any Work Item step",
    ],
  ],
  [D.REPAIR_REFUSED.diagnosis]: [
    [
      "regular",
      "alpha running/validate (handle); beta pending",
      "a step fails with an unclassified error",
      "GitHub observation failed",
    ],
    [
      "regular",
      "alpha waiting/approve-result (handle, pending criterion); beta pending",
      "a step exhausts its interruptions",
      "draining",
    ],
    [
      "regular",
      "alpha published (handle, PR); beta pending",
      "a step fails with an unclassified error",
      "a recorded subprocess has exited",
    ],
    [
      "regular",
      "alpha running/execute (handle); beta pending",
      "a step fails with an unclassified error",
      "a recorded subprocess's pid was reused",
    ],
    [
      "regular",
      "alpha waiting/approve-result (handle, pending criterion); beta pending",
      "a step fails with an unclassified error",
      "review phase reserved",
    ],
    [
      "regular",
      "alpha published (handle, PR); beta pending",
      "a step exhausts its interruptions",
      "coding phase reserved",
    ],
    [
      "regular",
      "alpha running/execute; beta pending",
      "a step fails with an unclassified error",
      "review phase reserved",
    ],
    [
      "regular",
      "alpha running/validate (handle); beta pending",
      "validation fails",
      "an error stops the Objective outside any Work Item step",
    ],
    [
      "regular",
      "alpha running/deliver (handle); beta pending",
      "a step exhausts its interruptions",
      "paused",
    ],
    [
      "regular",
      "alpha published (handle, PR); beta pending",
      "a step exhausts its interruptions",
      "review phase reserved",
    ],
    [
      "regular",
      "alpha running/validate (handle); beta pending",
      "the validation environment fails",
      "an error stops the Objective outside any Work Item step",
    ],
    [
      "regular",
      "alpha waiting/approve-result (handle, pending criterion); beta pending",
      "a step fails with an unclassified error",
      "coding phase reserved",
    ],
    [
      "regular",
      "alpha running/deliver (handle); beta pending",
      "a step exhausts its interruptions",
      "a recorded subprocess has exited",
    ],
    [
      "regular",
      "alpha running/deliver (handle); beta pending",
      "a step exhausts its interruptions",
      "a recorded subprocess's pid was reused",
    ],
    [
      "regular",
      "alpha running/execute; beta pending",
      "a step fails with an unclassified error",
      "draining",
    ],
    [
      "regular",
      "alpha running/execute (handle); beta pending",
      "the worker settles without a result",
      "a recorded subprocess's pid was reused",
    ],
    [
      "regular",
      "alpha running/validate (handle); beta pending",
      "the validation environment fails",
      "a recorded subprocess's pid was reused",
    ],
    [
      "regular",
      "alpha running/deliver (handle); beta pending",
      "a step fails with an unclassified error",
      "coding phase reserved",
    ],
    [
      "regular",
      "alpha running/deliver (handle); beta pending",
      "a step fails with an unclassified error",
      "review phase reserved",
    ],
    [
      "native-stack",
      "alpha running/execute; beta pending",
      "a step fails with an unclassified error",
      "GitHub observation failed",
    ],
    [
      "native-stack",
      "alpha waiting/approve-result (pending criterion); beta pending",
      "a step exhausts its interruptions",
      "a recorded subprocess's pid was reused",
    ],
    [
      "native-stack",
      "alpha running/deliver (PR); beta pending",
      "a step fails with an unclassified error",
      "a recorded subprocess has exited",
    ],
    [
      "native-stack",
      "alpha waiting/approve-result (pending criterion); beta pending",
      "a step fails with an unclassified error",
      "draining",
    ],
    [
      "native-stack",
      "alpha running/deliver (PR); beta pending",
      "a step exhausts its interruptions",
      "review phase reserved",
    ],
    [
      "native-stack",
      "alpha published (PR); beta pending",
      "a step fails with an unclassified error",
      "coding phase reserved",
    ],
    [
      "native-stack",
      "alpha running/validate; beta pending",
      "a step fails with an unclassified error",
      "a recorded subprocess's pid was reused",
    ],
    [
      "native-stack",
      "alpha running/validate; beta pending",
      "a step exhausts its interruptions",
      "paused",
    ],
    [
      "native-stack",
      "alpha waiting/approve-result (pending criterion); beta pending",
      "a step fails with an unclassified error",
      "review phase reserved",
    ],
    [
      "native-stack",
      "alpha running/validate; beta pending",
      "a step exhausts its interruptions",
      "a recorded subprocess has exited",
    ],
    [
      "native-stack",
      "alpha waiting/approve-result (pending criterion); beta pending",
      "a step fails with an unclassified error",
      "coding phase reserved",
    ],
    [
      "native-stack",
      "alpha running/execute; beta pending",
      "a step fails with an unclassified error",
      "review phase reserved",
    ],
    [
      "native-stack",
      "alpha running/execute; beta pending",
      "a step exhausts its interruptions",
      "draining",
    ],
    [
      "native-stack",
      "alpha running/execute (handle); beta pending",
      "the worker settles without a result",
      "an error stops the Objective outside any Work Item step",
    ],
    [
      "native-stack",
      "alpha running/execute (handle); beta pending",
      "the worker settles without a result",
      "a recorded subprocess's pid was reused",
    ],
    [
      "native-stack",
      "alpha running/validate; beta pending",
      "the validation environment fails",
      "an error stops the Objective outside any Work Item step",
    ],
    [
      "native-stack",
      "alpha running/validate; beta pending",
      "the validation environment fails",
      "a recorded subprocess's pid was reused",
    ],
    [
      "native-stack",
      "alpha running/deliver; beta pending",
      "a step fails with an unclassified error",
      "coding phase reserved",
    ],
    [
      "native-stack",
      "alpha published (PR); beta pending",
      "a step fails with an unclassified error",
      "review phase reserved",
    ],
  ],
  [D.REUSED_PID.diagnosis]: [
    [
      "regular",
      "alpha done; beta done (handle, PR, closure pending)",
      "GitHub closure failed",
      "a recorded subprocess's pid was reused",
    ],
    [
      "regular",
      "alpha waiting/approve-result (handle, pending criterion); beta pending",
      "cancellation is unresolved",
      "a recorded subprocess's pid was reused",
    ],
    [
      "regular",
      "alpha running/validate (handle); beta pending",
      "draining",
      "a recorded subprocess's pid was reused",
    ],
    [
      "regular",
      "alpha published (handle, PR); beta pending",
      "paused",
      "a recorded subprocess's pid was reused",
    ],
    [
      "regular",
      "alpha pending; beta pending",
      "cancel was requested",
      "a recorded subprocess's pid was reused",
    ],
    [
      "native-stack",
      "alpha done; beta done (PR, closure pending); stack merge pending",
      "GitHub closure failed",
      "a recorded subprocess's pid was reused",
    ],
    [
      "native-stack",
      "alpha running/execute (handle); beta pending",
      "paused",
      "a recorded subprocess's pid was reused",
    ],
    [
      "native-stack",
      "alpha running/deliver; beta pending",
      "cancel was requested",
      "a recorded subprocess's pid was reused",
    ],
    [
      "native-stack",
      "alpha waiting/approve-result (pending criterion); beta pending",
      "cancellation is unresolved",
      "a recorded subprocess's pid was reused",
    ],
    [
      "native-stack",
      "alpha pending; beta pending",
      "an error stops the Objective outside any Work Item step",
      "a recorded subprocess's pid was reused",
    ],
    [
      "native-stack",
      "alpha published (PR); beta pending",
      "cancellation is unresolved",
      "a recorded subprocess's pid was reused",
    ],
    [
      "native-stack",
      "alpha running/execute; beta pending",
      "validation phase reserved",
      "a recorded subprocess's pid was reused",
    ],
    [
      "native-stack",
      "alpha running/validate; beta pending",
      "review phase reserved",
      "a recorded subprocess's pid was reused",
    ],
  ],
  [D.STOPPED_WITHOUT_EXIT.diagnosis]: [
    [
      "regular",
      "alpha running/validate (handle); beta pending",
      "an error stops the Objective outside any Work Item step",
      "interruptions exhausted",
    ],
    [
      "regular",
      "alpha published (handle, PR); beta pending",
      "an error stops the Objective outside any Work Item step",
    ],
    [
      "regular",
      "alpha pending; beta pending",
      "an error stops the Objective outside any Work Item step",
    ],
    [
      "native-stack",
      "alpha running/validate; beta pending",
      "an error stops the Objective outside any Work Item step",
      "validation phase reserved",
    ],
    [
      "native-stack",
      "alpha running/execute (handle); beta pending",
      "an error stops the Objective outside any Work Item step",
      "interruptions exhausted",
    ],
    [
      "native-stack",
      "alpha running/deliver; beta pending",
      "an error stops the Objective outside any Work Item step",
      "a recorded subprocess has exited",
    ],
    [
      "native-stack",
      "alpha published (PR); beta pending",
      "an error stops the Objective outside any Work Item step",
      "a recorded subprocess has exited",
    ],
  ],
  [D.DRAINED.diagnosis]: [
    [
      "regular",
      "alpha pending; beta pending",
      "draining",
      "a recorded subprocess has exited",
    ],
    [
      "regular",
      "preparing, plan clean, planning complete, 2 issues, projection",
      "draining",
      "a recorded subprocess has exited",
    ],
    [
      "regular",
      "alpha done; beta done (handle, PR, closure complete); pending final criterion",
      "draining",
      "a recorded subprocess has exited",
    ],
    [
      "regular",
      "alpha running/execute (handle); beta pending",
      "the worker settles without a result",
      "draining",
    ],
    [
      "regular",
      "preparing, no plan, planning submitted, 0 issues, planning",
      "draining",
      "a recorded subprocess's pid was reused",
    ],
    ["regular", "preparing, no plan, 0 issues, planning", "draining"],
    [
      "regular",
      "preparing, no plan, planning ready, 0 issues, planning",
      "draining",
    ],
    [
      "regular",
      "preparing, plan clean, planning complete, 1 issues, projection",
      "draining",
    ],
    [
      "regular",
      "alpha running/validate (handle); beta pending",
      "the validation environment fails",
      "draining",
    ],
    [
      "regular",
      "alpha done; beta done (handle, PR, closure complete); final validation",
      "draining",
    ],
    [
      "regular",
      "alpha done; beta done (handle, PR, closure complete); final validation; Objective closure pending",
      "draining",
    ],
    [
      "native-stack",
      "alpha pending; beta pending",
      "draining",
      "a recorded subprocess has exited",
    ],
    [
      "native-stack",
      "alpha running/execute (handle); beta pending",
      "the worker settles without a result",
      "draining",
    ],
    [
      "native-stack",
      "preparing, plan clean, planning complete, 2 issues, projection",
      "draining",
      "a recorded subprocess has exited",
    ],
    [
      "native-stack",
      "alpha done; beta done (PR, closure complete); pending final criterion; stack merge pending",
      "draining",
      "a recorded subprocess's pid was reused",
    ],
    [
      "native-stack",
      "preparing, no plan, planning submitted, 0 issues, planning",
      "draining",
      "a recorded subprocess's pid was reused",
    ],
    [
      "native-stack",
      "alpha running/validate; beta pending",
      "the validation environment fails",
      "draining",
    ],
    ["native-stack", "preparing, no plan, 0 issues, planning", "draining"],
    [
      "native-stack",
      "preparing, no plan, planning ready, 0 issues, planning",
      "draining",
    ],
    [
      "native-stack",
      "preparing, plan clean, planning complete, 1 issues, projection",
      "draining",
    ],
    ["native-stack", "alpha published (PR); beta pending", "draining"],
    [
      "native-stack",
      "alpha done; beta done (PR, closure complete); final validation; stack merge pending",
      "draining",
    ],
    [
      "native-stack",
      "alpha done; beta done (PR, closure complete); final validation; Objective closure pending; stack merge pending",
      "draining",
    ],
  ],
};

const known = new Map();
for (const [diagnosis, identities] of Object.entries(KNOWN))
  for (const identity of identities) {
    const name = identityName(identity);
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
  include: Object.values(KNOWN).flat(),
});

describe("dead ends", { concurrency: true }, () => {
  for (const testCase of cases) {
    test(testCase.name, { timeout: 3_600_000 }, async (t) => {
      const outcome = await schedule(testCase);
      const detail = `${outcome.kind}: ${outcome.reason ?? ""}\n${outcome.trace.join("\n")}`;
      const diagnosis = known.get(testCase.name);
      if (!diagnosis) {
        assert.notEqual(outcome.kind, "stranded", detail);
        return;
      }
      assert.notEqual(
        outcome.kind,
        "unreachable",
        `Known dead end is no longer a reachable state; remove it from KNOWN: ${diagnosis}`,
      );
      if (outcome.kind === "stranded") {
        assert.match(
          outcome.reason,
          byDiagnosis.get(diagnosis).pattern,
          detail,
        );
        t.diagnostic(`known dead end: ${diagnosis}`);
        return;
      }
      assert.fail(
        `Known dead end no longer reproduces; remove it from KNOWN in test/dead-ends.test.mjs: ${diagnosis}\n${detail}`,
      );
    });
  }
});
