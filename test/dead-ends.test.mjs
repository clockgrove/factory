// The dead-end finder (#515): every reachable non-terminal state must have an
// exit. Each case restarts the real controller from an enumerated state (see
// test/support/dead-ends.mjs) and fails if the Objective is stranded: the
// restart neither progresses nor completes, and following the commands the
// status names does not continue it.
//
// The named-command finder runs in the same cases. At each sampled stop it
// reads every command the stop names — the status's next action, its other
// sentences (`nextDecision`, reasons, errors, waits) and the run's own message
// — and executes it through the same calls the CLI makes (retry, repair,
// decide, propose-amendment, resume, cancel...): through the owner's control
// socket while one runs, else the application. A stop whose owner is still up
// (paused, draining, a held phase) gets each command both ways. A named
// command that is refused, or after which the next run neither progresses nor
// reaches a terminal or decision stop, is a dead end.
//
// Known dead ends are inverted, like the fault matrix's known failures: the
// test passes while the state stays stranded for its diagnosed reason and fails
// once it has an exit; then remove its entry. A diagnosis names the states it
// strands by structure (`when`: delivery, anchor shape, overlays) and the
// refusal it shows (`pattern`). Every stranding the sample finds must match a
// diagnosis, and every diagnosis must show up in the sample. Entries in KNOWN
// name a state outright and are checked whether or not the pairwise sample
// picks them.
import assert from "node:assert/strict";
import { availableParallelism } from "node:os";
import { describe, test } from "node:test";
import {
  identityName,
  OVERLAY_VALUES,
  ownerProbes,
  prepare,
} from "./support/dead-ends.mjs";

const has = (identity, ...values) =>
  values.some((value) => identity.slice(2).includes(value));

/**
 * Diagnoses of stranded states. `pattern` matches the stranding reason, `when`
 * the identity ([delivery, anchor shape, ...overlays]) of the states it
 * strands, `issue` says where it is tracked. A new diagnosis needs an open P0
 * issue (P1 when the Objective has another exit).
 */
const D = {};

/**
 * Stranded states named outright: diagnosis → [delivery, anchor shape,
 * ...overlays]. Checked whether or not the pairwise sample picks them.
 */
const KNOWN = {};

/**
 * Former dead ends, one or more per earlier diagnosis. They stay in the
 * sample, so each must keep an exit.
 */
const FIXED = [
  [
    "regular",
    "alpha running/execute; beta pending",
    "a step fails with an unclassified error",
    "a recorded subprocess's pid was reused",
  ],
  [
    "native-stack",
    "alpha running/execute (handle); beta pending",
    "a step fails with an unclassified error",
    "a recorded subprocess has exited",
  ],
  [
    "native-stack",
    "alpha running/validate; beta pending",
    "a step fails with an unclassified error",
    "a recorded subprocess has exited",
  ],
  [
    "regular",
    "alpha running/execute (handle); beta pending",
    "a step fails with an unclassified error",
    "a recorded subprocess's pid was reused",
  ],
  ["regular", "alpha running/execute; beta pending"],
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
  [
    "regular",
    "alpha running/execute; beta pending",
    "cancel was requested",
    "validation phase reserved",
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
    "regular",
    "alpha running/validate (handle); beta pending",
    "validation fails",
    "an error stops the Objective outside any Work Item step",
  ],
  [
    "native-stack",
    "alpha running/execute (handle); beta pending",
    "the worker settles without a result",
    "an error stops the Objective outside any Work Item step",
  ],
  [
    "regular",
    "alpha pending; beta pending",
    "an error stops the Objective outside any Work Item step",
  ],
  [
    "native-stack",
    "alpha published (PR); beta pending",
    "an error stops the Objective outside any Work Item step",
    "a recorded subprocess has exited",
  ],
  [
    "regular",
    "alpha published (handle, PR); beta pending",
    "a step fails with an unclassified error",
    "a recorded subprocess has exited",
  ],
  [
    "regular",
    "alpha running/deliver (handle); beta pending",
    "a step fails with an unclassified error",
    "review phase reserved",
  ],
  [
    "native-stack",
    "alpha running/deliver (PR); beta pending",
    "a step fails with an unclassified error",
    "a recorded subprocess has exited",
  ],
  [
    "native-stack",
    "alpha published (PR); beta pending",
    "a step fails with an unclassified error",
    "coding phase reserved",
  ],
  [
    "regular",
    "alpha pending; beta pending",
    "draining",
    "a recorded subprocess has exited",
  ],
  // Rejected amendments (#715, #716, #717): status names cancel unless a
  // replacement fits, and a supplied graph is never replaced.
  [
    "regular",
    "alpha running/execute; beta pending",
    "an amendment was rejected with a planning revision to spare",
  ],
  [
    "native-stack",
    "alpha published (PR); beta pending",
    "an amendment was rejected with a planning revision to spare",
  ],
  [
    "regular",
    "alpha pending; beta pending",
    "a supplied graph amendment was rejected with a planning revision to spare",
  ],
  [
    "regular",
    "alpha pending; beta pending",
    "no repair class is enabled",
    "an amendment was rejected with a planning revision to spare",
  ],
  // The run that rejected an amendment stopped on it, so the Objective has an
  // error: status names the rejection's exit, not the retry of that error.
  [
    "regular",
    "alpha pending; beta pending",
    "an amendment was rejected and the run stopped",
  ],
  [
    "native-stack",
    "alpha published (PR); beta pending",
    "an amendment was rejected and the run stopped with a planning revision to spare",
  ],
  // An unrelated stop beside the rejection: the replacement is refused until
  // that stop is cleared, so status names the retry (ownership settles).
  [
    "regular",
    "alpha pending; beta pending",
    "an amendment was rejected beside an unrelated stop",
  ],
  // The installation configuration changed after the Objective started
  // (#739): status names cancel, which ends it.
  [
    "regular",
    "alpha pending; beta pending",
    "the installation configuration changed",
  ],
  [
    "native-stack",
    "alpha running/execute; beta pending",
    "the installation configuration changed",
  ],
  [
    "regular",
    "alpha running/execute; beta pending",
    "a step fails with an unclassified error",
    "the installation configuration changed",
  ],
  // Final acceptance sealed under a changed configuration: cancel is refused,
  // so status names the run that restoring the configuration allows.
  [
    "regular",
    "alpha done; beta done (handle, PR, closure complete); final validation; Objective closure pending",
    "the installation configuration changed",
  ],
  [
    "native-stack",
    "alpha done; beta done (PR, closure complete); final validation; Objective closure pending; stack merge pending",
    "the installation configuration changed",
  ],
  // A preparation under a changed configuration: a refusal discards the plan
  // before projection; once issues exist only cancel ends it.
  [
    "regular",
    "preparing, plan clean, planning complete, 0 issues, planning",
    "the installation configuration changed",
  ],
  [
    "native-stack",
    "preparing, plan clean, planning complete, 0 issues, projection",
    "the installation configuration changed",
  ],
  [
    "regular",
    "preparing, plan clean, planning complete, 1 issues, projection",
    "the installation configuration changed",
  ],
  [
    "native-stack",
    "preparing, no plan, 0 issues, planning",
    "the installation configuration changed",
  ],
  // A rejection is held paused (a handoff or a resume does not release it), so
  // status keeps naming the replacement or cancel, also with no planning
  // revision left (a permanent refusal goes straight to cancel).
  [
    "regular",
    "alpha pending; beta pending",
    "an amendment was rejected, then the mode was left draining",
  ],
  [
    "regular",
    "alpha pending; beta pending",
    "an amendment was rejected, then the mode was left running",
  ],
  [
    "regular",
    "alpha pending; beta pending",
    "an amendment was rejected with no planning revision left, then the mode was left draining",
  ],
  [
    "native-stack",
    "alpha published (PR); beta pending",
    "an amendment was rejected and the run stopped, then the mode was left running",
  ],
  [
    "regular",
    "alpha running/execute; beta pending",
    "an amendment was rejected and the run stopped, then the mode was left draining",
  ],
  // A pause or drain of a preparation outranks a changed configuration: a
  // refusal would discard it.
  [
    "regular",
    "preparing, plan clean, planning complete, 0 issues, planning",
    "paused",
    "the installation configuration changed",
  ],
  [
    "native-stack",
    "preparing, plan clean, planning complete, 0 issues, projection",
    "draining",
    "the installation configuration changed",
  ],
  [
    "regular",
    "preparing, plan clean, planning complete, 1 issues, projection",
    "paused",
    "the installation configuration changed",
  ],
  // The base, the Objective body or the sources changed during preparation:
  // the run refuses and status names what ends or discards the plan.
  [
    "regular",
    "preparing, plan clean, planning complete, 0 issues, planning",
    "the base changed since planning",
  ],
  [
    "native-stack",
    "preparing, plan clean, planning complete, 0 issues, projection",
    "the Objective body changed since planning",
  ],
  [
    "regular",
    "preparing, plan clean, planning complete, 1 issues, projection",
    "the sources changed since planning",
  ],
  [
    "native-stack",
    "preparing, no plan, 0 issues, planning",
    "the base changed since planning",
  ],
  [
    "regular",
    "preparing, plan clean, planning complete, 0 issues, planning",
    "paused",
    "the base changed since planning",
  ],
  // A changed configuration beside changed inputs: restoring the configuration
  // is not enough, and the refusal that status names still ends it.
  [
    "regular",
    "preparing, plan clean, planning complete, 0 issues, planning",
    "the installation configuration changed",
    "the base changed since planning",
  ],
  // A cancelled item of a live Objective (#718).
  [
    "native-stack",
    "alpha pending; beta pending",
    "an item was cancelled and the Objective retried",
  ],
  ["native-stack", "alpha published (PR); beta pending", "draining"],
  [
    "regular",
    "alpha done; beta done (handle, PR, closure complete); final validation",
    "draining",
  ],
];

const known = new Map();
for (const [diagnosis, identities] of Object.entries(KNOWN))
  for (const identity of identities) {
    const name = identityName(identity);
    assert.ok(!known.has(name), `Duplicate known dead end: ${name}`);
    known.set(name, diagnosis);
  }
const fixed = new Set(FIXED.map(identityName));

// Cases run one at a time per slot; a slot is one recorded world root.
const slots = Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2)));
const { cases, schedule } = await prepare({
  deliveries: ["regular", "native-stack"],
  slots,
  include: [...Object.values(KNOWN).flat(), ...FIXED],
});

/** Run each case once; the test of the case and the final check share it. */
const outcomes = new Map();
const outcomeOf = (testCase) => {
  if (!outcomes.has(testCase)) outcomes.set(testCase, schedule(testCase));
  return outcomes.get(testCase);
};

/**
 * Every stranding of a case: the restart's own, then each named command that
 * was refused or did not continue.
 */
const reasonsOf = (outcome) => [
  ...(outcome.kind === "stranded" ? [outcome.reason] : []),
  ...(outcome.problems ?? []),
];

/** The diagnosis of each reason, undefined when it has none. */
const diagnose = (testCase, reasons) =>
  reasons.map(
    (reason) =>
      Object.entries(D).find(
        ([key, entry]) =>
          entry.pattern.test(reason) &&
          (entry.when(testCase.identity) || known.get(testCase.name) === key),
      )?.[0],
  );

describe("dead ends", { concurrency: true }, () => {
  // A diagnosis that no case shows any more is fixed: remove it. One test per
  // diagnosis, each waiting only for the cases its `when` names (the only ones
  // that can show it), and defined first so those cases are scheduled first.
  for (const [key, entry] of Object.entries(D)) {
    test(`diagnosis ${key} is still reproduced`, async () => {
      const candidates = cases.filter(
        (testCase) =>
          entry.when(testCase.identity) || known.get(testCase.name) === key,
      );
      const shown = await Promise.all(
        candidates.map(async (testCase) =>
          diagnose(testCase, reasonsOf(await outcomeOf(testCase))).includes(
            key,
          ),
        ),
      );
      assert.ok(
        shown.includes(true),
        `No case shows this diagnosis any more; remove ${key} from D in test/dead-ends.test.mjs: ${entry.diagnosis}\n${candidates.length} case(s) were in the states it names`,
      );
    });
  }

  // The owner's control socket falls back to the application when it does not
  // answer, so a harness that never reaches an owner would still pass. Only a
  // parked owner (paused or draining) is a live owner at a stop. The commands
  // this PR's stops name must each have been answered by one: wait for the
  // cases at those stops, in order, until every one has been.
  test("named commands were applied through a live owner", {
    timeout: 3_600_000,
  }, async () => {
    const wanted = [
      ["rejected amendment", "cancel"],
      ["rejected amendment", "propose-amendment"],
      // A controller does not stay up at a cancelled item (its run ends with
      // the decision), so the live owner there is the paused or draining one,
      // and the retry that status names next is applied without it.
      ["cancelled item", "resume"],
    ];
    const answered = ([stop, verb]) =>
      ownerProbes.applied.some(
        (command) =>
          command.stop === stop && command.verb === verb && command.viaOwner,
      );
    const parked = cases.filter(
      (testCase) =>
        !testCase.unreachable &&
        Object.values(testCase.values ?? {}).some(
          (value) =>
            /^an? (supplied graph )?amendment was rejected/.test(value) ||
            value === "an item was cancelled and the Objective retried" ||
            value === "paused" ||
            value === "draining",
        ),
    );
    for (const testCase of parked) {
      await outcomeOf(testCase);
      if (wanted.every(answered)) break;
    }
    assert.ok(
      ownerProbes.run > 0,
      "No stop with a live owner had a named command probed",
    );
    assert.ok(
      ownerProbes.applied.some(
        (command) =>
          command.stop === "cancelled item" && command.verb === "retry",
      ),
      "No case applied the retry status names for a cancelled item",
    );
    assert.deepEqual(
      wanted.filter((pair) => !answered(pair)).map((pair) => pair.join(": ")),
      [],
      `The owner's socket did not answer these commands at these stops; ${ownerProbes.answered} of ${ownerProbes.run} probes made with an owner running were answered; commands applied with an owner: ${JSON.stringify(ownerProbes.applied)}`,
    );
  });

  // A rejection whose mode is not paused (the raw state a bypass of the
  // setter or an old state file leaves) gets `factory pause` from status; the
  // finder must apply it, then reach the replacement.
  test("the pause status names for an unpaused rejection is applied", {
    timeout: 3_600_000,
  }, async () => {
    const applied = () =>
      ownerProbes.applied.some(
        (command) =>
          command.stop === "rejected amendment" && command.verb === "pause",
      );
    for (const testCase of cases) {
      if (
        testCase.unreachable ||
        !Object.values(testCase.values ?? {}).some((value) =>
          /, then the mode was left /.test(value),
        )
      )
        continue;
      await outcomeOf(testCase);
      if (applied()) break;
    }
    assert.ok(
      applied(),
      "No case applied factory pause at a rejected amendment",
    );
  });

  for (const testCase of cases) {
    test(testCase.name, { timeout: 3_600_000 }, async () => {
      const outcome = await outcomeOf(testCase);
      const reasons = reasonsOf(outcome);
      const detail = `${outcome.kind}: ${outcome.reason ?? ""}\n${reasons.join("\n")}\n${outcome.trace.join("\n")}`;
      const pinned = known.get(testCase.name);
      if (outcome.kind === "unreachable") {
        // A pinned former dead end must still be a state the sample reaches.
        assert.ok(
          !pinned,
          `Known dead end is no longer a reachable state; remove it from KNOWN: ${pinned}`,
        );
        assert.ok(!fixed.has(testCase.name), detail);
        return;
      }
      // Each stranding is a diagnosed one, in a state its diagnosis names.
      const diagnosed = diagnose(testCase, reasons);
      assert.deepEqual(
        reasons.filter((_, index) => !diagnosed[index]),
        [],
        detail,
      );
      if (pinned)
        assert.ok(
          diagnosed.includes(pinned),
          `Known dead end no longer reproduces; remove it from KNOWN in test/dead-ends.test.mjs: ${D[pinned].diagnosis}\n${detail}`,
        );
    });
  }

  // An overlay the sampler never picks is a scenario CI does not run.
  test("every overlay value is exercised", () => {
    const used = new Set(
      cases.flatMap((testCase) => Object.values(testCase.values ?? {})),
    );
    assert.deepEqual(
      OVERLAY_VALUES.filter((value) => !used.has(value)),
      [],
      "No case applies these overlays; they change nothing or apply to no anchor",
    );
  });
});
