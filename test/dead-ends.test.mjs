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

const D = {};

/**
 * Stranded states by diagnosis: [delivery, anchor shape, ...overlays]. Empty:
 * the step conversions (#563, #566, #562) gave every earlier entry an exit. A
 * new entry needs a diagnosis in D and an open P0 issue.
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
const byDiagnosis = new Map(
  Object.values(D).map((entry) => [entry.diagnosis, entry]),
);

// Cases run one at a time per slot; a slot is one recorded world root.
const slots = Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2)));
const { cases, schedule } = await prepare({
  deliveries: ["regular", "native-stack"],
  slots,
  include: [...Object.values(KNOWN).flat(), ...FIXED],
});

describe("dead ends", { concurrency: true }, () => {
  for (const testCase of cases) {
    test(testCase.name, { timeout: 3_600_000 }, async (t) => {
      const outcome = await schedule(testCase);
      const detail = `${outcome.kind}: ${outcome.reason ?? ""}\n${outcome.trace.join("\n")}`;
      const diagnosis = known.get(testCase.name);
      if (!diagnosis) {
        // A pinned former dead end must still be a state the sample reaches.
        if (fixed.has(testCase.name))
          assert.notEqual(outcome.kind, "unreachable", detail);
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
