// Interleavings of two concurrent Work Items' effects. Each family runs once
// under the empty schedule; explore() derives schedules around every pair of
// effects that conflict on a git resource, plus a fixed-seed sample of
// crash-consistency schedules, from each Work Item's own effect sequence, so
// a seed names the same tests on every runner. Each schedule must reach the
// fault matrix's end state with no operator stop and nothing ambiguous,
// uncertain or stranded after a restart. Every invariant a schedule breaks
// must be explained by a known race in test/support/interleave-known.mjs;
// the pinned reproductions there are inverted known failures.
//
// A schedule whose hold Factory cannot satisfy (it serializes the two
// effects) is skipped with that reason. A controller run that times out is
// an infrastructure failure, not a race, unless a hold had reordered it.
//
// FACTORY_INTERLEAVE_SAMPLES (default 8 per family; 1000 explores every
// schedule) and FACTORY_INTERLEAVE_SEED widen or move that sample.
// FACTORY_INTERLEAVE_CONCURRENCY (default 4) bounds the scenarios that run
// at once: each runs a controller that holds effects against wall-clock
// quiet windows, so an overloaded runner would mistake load for deadlock.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { workItem } from "./support/fault-harness.mjs";
import {
  checkInvariants,
  explore,
  runInterleaving,
} from "./support/interleave.mjs";
import { DIAGNOSES, PINNED } from "./support/interleave-known.mjs";

const SAMPLES = Number(process.env.FACTORY_INTERLEAVE_SAMPLES ?? 8);
const SEED = Number(process.env.FACTORY_INTERLEAVE_SEED ?? 515);
const CONCURRENCY = Number(process.env.FACTORY_INTERLEAVE_CONCURRENCY ?? 4);

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

for (const pinned of PINNED)
  if (!DIAGNOSES[pinned.known] || !FAMILIES[pinned.family])
    throw new Error(`Unknown pinned race ${pinned.known} in ${pinned.family}`);

/** The schedule and what came of it, for a report. */
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

/** The known races explaining a failure. */
const explaining = (failure, result) =>
  Object.entries(DIAGNOSES)
    .filter(
      ([, known]) =>
        known.match[failure.invariant]?.test(failure.message) &&
        (known.when?.(failure, result) ?? true),
    )
    .map(([id]) => id);

/**
 * Judge a run: throw for a hung run (infrastructure, unless a hold had
 * reordered it) or any failure no known race explains; return the known
 * races that explain the rest.
 */
function judge(name, schedule, result, reference) {
  const failures = checkInvariants(result, reference);
  const details = () =>
    `${name}\n${report(schedule, result)}\n${failures
      .map(
        (failure) =>
          `${failure.invariant}${failure.consequence ? " (after a stop)" : ""}: ${failure.message}`,
      )
      .join("\n")}`;
  if (failures.some((failure) => failure.invariant === "hung"))
    throw new Error(
      result.holds.some((hold) => hold.outcome === "applied")
        ? `New race (the run hung after a reordering): ${details()}`
        : `Infrastructure: a controller run timed out without any reordering; not a race. Lower FACTORY_INTERLEAVE_CONCURRENCY or check the runner. ${details()}`,
    );
  const known = new Set();
  const unexplained = [];
  for (const failure of failures) {
    if (failure.consequence) continue;
    const ids = explaining(failure, result);
    if (!ids.length) unexplained.push(failure);
    for (const id of ids) known.add(id);
  }
  if (unexplained.length)
    throw new Error(
      `New race (unexplained: ${unexplained.map((failure) => failure.invariant).join(", ")}): ${details()}`,
    );
  return known;
}

const infeasible = (result) =>
  result.holds.filter((hold) => hold.outcome === "infeasible");

describe("interleavings of two Work Items", {
  concurrency: CONCURRENCY,
}, () => {
  for (const [family, { title, chain: items }] of Object.entries(FAMILIES)) {
    const reference = references[family];
    // The unscheduled run can meet a known race on its own on a slow runner.
    test(`${title}: the unscheduled run holds every invariant`, (t) => {
      const known = judge("the unscheduled run", {}, reference, reference);
      if (known.size) t.diagnostic(`known race ${[...known].join(", ")}`);
    });

    for (const pinned of PINNED.filter((entry) => entry.family === family))
      test(`${title}: ${pinned.name} (known race ${pinned.known})`, {
        timeout: 300_000,
      }, async (t) => {
        const { diagnosis } = DIAGNOSES[pinned.known];
        const result = await run(family, pinned.schedule);
        t.diagnostic(report(pinned.schedule, result));
        const known = judge(pinned.name, pinned.schedule, result, reference);
        if (!known.has(pinned.known))
          assert.fail(
            `Known race no longer reproduces${infeasible(result).length ? " (Factory now serializes the held effects)" : ""}; remove it from test/support/interleave-known.mjs: ${diagnosis}\n${report(pinned.schedule, result)}`,
          );
        t.diagnostic(`known race: ${diagnosis}`);
      });

    for (const entry of explore(reference, items(), {
      samples: SAMPLES,
      seed: SEED,
    }))
      test(`${title}: [${entry.family}] ${entry.name}`, {
        timeout: 300_000,
      }, async (t) => {
        const result = await run(family, entry.schedule);
        t.diagnostic(report(entry.schedule, result));
        const known = judge(entry.name, entry.schedule, result, reference);
        if (known.size) t.diagnostic(`known race ${[...known].join(", ")}`);
        const unsatisfied = infeasible(result);
        if (unsatisfied.length)
          t.skip(
            `infeasible: Factory cannot reach ${unsatisfied
              .map((hold) => `${hold.until} while ${hold.hold} waits`)
              .join("; ")}`,
          );
      });
  }
});
