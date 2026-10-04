// Interleavings of two concurrent Work Items' effects. Each family runs once
// under the empty schedule; explore() derives schedules around every pair of
// its effects that conflict on a git resource, plus a fixed-seed sample of
// crash-consistency schedules, and each schedule must reach the fault
// matrix's end state with no operator stop and nothing ambiguous, uncertain
// or stranded after a restart. A schedule that breaks an invariant must
// match a known race in test/support/interleave-known.mjs; the pinned
// reproductions there are inverted known failures.
//
// FACTORY_INTERLEAVE_SAMPLES (default 8 per family; 1000 explores every
// schedule) and FACTORY_INTERLEAVE_SEED widen or move that sample.
import assert from "node:assert/strict";
import { availableParallelism } from "node:os";
import { describe, test } from "node:test";
import { workItem } from "./support/fault-harness.mjs";
import {
  assertInvariants,
  explore,
  runInterleaving,
} from "./support/interleave.mjs";
import { DIAGNOSES, PINNED } from "./support/interleave-known.mjs";

const SAMPLES = Number(process.env.FACTORY_INTERLEAVE_SAMPLES ?? 8);
const SEED = Number(process.env.FACTORY_INTERLEAVE_SEED ?? 515);

const chain = () => [workItem("alpha"), workItem("beta", ["alpha"])];
const FAMILIES = {
  dependent: { title: "regular alpha → beta", delivery: "regular", chain },
  independent: {
    title: "regular alpha ∥ beta",
    delivery: "regular",
    chain: () => [workItem("alpha"), workItem("beta")],
  },
  native: {
    title: "native-stack alpha → beta",
    delivery: "native-stack",
    chain,
  },
};

let scenarios = 0;
const run = (family, schedule) =>
  runInterleaving({
    name: `il${scenarios++}`,
    delivery: FAMILIES[family].delivery,
    items: FAMILIES[family].chain(),
    schedule,
  });

const references = Object.fromEntries(
  await Promise.all(
    Object.keys(FAMILIES).map(async (family) => [
      family,
      await run(family, {}),
    ]),
  ),
);

/** The schedule and what came of it, for a race report. */
function report(schedule, result) {
  const holds = (result.holds ?? []).map(
    (hold) =>
      `hold ${hold.hold} at ${hold.at} until ${hold.until} reached ${hold.phase}: ${hold.outcome}`,
  );
  const crash = result.crashed
    ? `crash ${result.crashed.phase === "start" ? "before" : "after"} ${result.crashed.label}`
    : schedule.crash
      ? `crash at ${schedule.crash.at} never fired`
      : "no crash";
  const runs = result.runs.map(
    (entry, index) =>
      `run ${index}: ${entry.outcome}${entry.message ? ` (${entry.message.split("\n")[0]})` : ""}`,
  );
  return [...holds, crash, ...runs].join("\n");
}

const matching = (error) =>
  Object.entries(DIAGNOSES)
    .filter(([, known]) => known.pattern.test(String(error?.message ?? error)))
    .map(([id]) => id);

/** Hold every invariant, or fail only as a known race does. */
function assertKnown(t, name, schedule, result, reference) {
  try {
    assertInvariants(result, reference);
  } catch (error) {
    const known = matching(error);
    if (!known.length)
      throw new Error(
        `New race: ${name}\n${report(schedule, result)}\n${error.message}`,
        { cause: error },
      );
    t.diagnostic(`known race ${known.join(" or ")}`);
  }
}

for (const pinned of PINNED)
  if (!DIAGNOSES[pinned.known])
    throw new Error(`Unknown diagnosis ${pinned.known}`);

describe("interleavings of two Work Items", {
  concurrency: availableParallelism(),
}, () => {
  for (const [family, { title }] of Object.entries(FAMILIES)) {
    const reference = references[family];
    // The unscheduled run can meet a known race on its own on a slow runner.
    test(`${title}: the unscheduled run holds every invariant`, (t) =>
      assertKnown(t, "the unscheduled run", {}, reference, reference));

    for (const pinned of PINNED.filter((entry) => entry.family === family))
      test(`${title}: ${pinned.name} (known race ${pinned.known})`, {
        timeout: 300_000,
      }, async (t) => {
        const { diagnosis, pattern } = DIAGNOSES[pinned.known];
        const result = await run(family, pinned.schedule);
        t.diagnostic(report(pinned.schedule, result));
        let failure;
        try {
          assertInvariants(result, reference);
        } catch (error) {
          failure = error;
        }
        if (!failure)
          assert.fail(
            `Known race no longer reproduces; remove it from test/support/interleave-known.mjs: ${diagnosis}`,
          );
        if (!pattern.test(String(failure.message))) throw failure;
        t.diagnostic(`known race: ${diagnosis}`);
      });

    for (const entry of explore(reference, { samples: SAMPLES, seed: SEED }))
      test(`${title}: [${entry.family}] ${entry.name}`, {
        timeout: 300_000,
      }, async (t) => {
        const result = await run(family, entry.schedule);
        t.diagnostic(report(entry.schedule, result));
        assertKnown(t, entry.name, entry.schedule, result, reference);
      });
  }
});
