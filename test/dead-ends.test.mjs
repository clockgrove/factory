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
const D = {
  configurationChanged: {
    diagnosis:
      "The installation configuration changed after the Objective started: status names `factory retry`, which is accepted, and the next run stops identically (the state does not match this installation)",
    issue: "#739",
    pattern:
      /factory retry does not continue after stopped: Existing Objective state does not match this Factory installation/,
    when: (identity) =>
      has(identity, "the installation configuration changed") &&
      !identity[1].startsWith("preparing"),
  },
};

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

  // The owner's control socket falls back to the application when it does not
  // answer, so a harness that never reaches an owner would still pass.
  test("named commands were applied through a live owner", async () => {
    for (const testCase of cases) await outcomeOf(testCase);
    assert.ok(
      ownerProbes.run > 0,
      "No stop with a live owner had a named command probed",
    );
    assert.ok(
      ownerProbes.answered > 0,
      `The owner's socket answered none of ${ownerProbes.run} probes made with an owner running`,
    );
  });
});
