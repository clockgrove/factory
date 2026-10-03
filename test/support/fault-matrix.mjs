// The fault matrix: run an uninterrupted two-item Objective (alpha → beta)
// once per delivery strategy, derive every effect boundary from what that
// run did, then inject a crash, a lost response or an unavailable burst at
// each boundary, restart the controller, and check invariants of the end
// state read from GitHub's request log and the repository, not from
// Factory's own state. Nothing here names Factory internals, so the matrix
// survives the recovery redesign.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { availableParallelism } from "node:os";
import { basename, join } from "node:path";
import { describe, test } from "node:test";
import { faults } from "./github-http-fake.mjs";
import { OBJECTIVE, branch, marker, runScenario } from "./fault-harness.mjs";

/**
 * Scenarios run concurrently within one test file: every available core by
 * default, or FACTORY_FAULT_CONCURRENCY to cap a shared machine.
 */
export function scenarioConcurrency() {
  const configured = Number(process.env.FACTORY_FAULT_CONCURRENCY);
  return Number.isSafeInteger(configured) && configured > 0
    ? configured
    : availableParallelism();
}

const KINDS = ["crash-before", "crash-after", "lost", "unavailable"];
const PAID = new Set(["crash-after", "lost"]);

/** The run every case is compared with, once per process and delivery. */
const references = new Map();
export function referenceRun(delivery) {
  if (!references.has(delivery))
    references.set(
      delivery,
      runScenario({ name: `reference-${delivery}`, delivery }),
    );
  return references.get(delivery);
}

function httpRule(endpoint, occurrence, kind) {
  switch (kind) {
    case "crash-before":
    case "crash-after":
      return { match: endpoint, occurrence, kind };
    case "lost":
      return { match: endpoint, occurrence, kind: "drop" };
    case "reset":
      return { match: endpoint, occurrence, kind: "reset" };
    case "unavailable":
      // A burst of two: within Factory's documented repeat budget.
      return { match: endpoint, occurrence, times: 2, ...faults.unavailable() };
  }
  throw new Error(`Unknown kind ${kind}`);
}

const isRead = (entry) =>
  entry.method === "GET" ||
  entry.endpoint === "POST /graphql" ||
  entry.endpoint === "GIT fetch-advertise";

/**
 * Every boundary of the reference run: each applied mutation (REST or git
 * push) by its occurrence among requests to its endpoint, the first read of
 * every read endpoint, and each model and execution-driver call.
 */
export function deriveCases(reference) {
  const cases = [];
  const seen = new Map();
  const firstRead = new Set();
  for (const entry of reference.fake.log) {
    if (entry.unhandled) continue;
    const occurrence = (seen.get(entry.endpoint) ?? 0) + 1;
    seen.set(entry.endpoint, occurrence);
    if (entry.effect)
      for (const kind of KINDS)
        cases.push({
          name: `${kind} at ${entry.endpoint} #${occurrence}`,
          group: "mutations",
          boundaryName: `${entry.endpoint} #${occurrence}`,
          boundary: { kind: "http", endpoint: entry.endpoint, occurrence },
          http: [httpRule(entry.endpoint, occurrence, kind)],
        });
    else if (isRead(entry) && !firstRead.has(entry.endpoint)) {
      firstRead.add(entry.endpoint);
      for (const kind of ["unavailable", "reset"])
        cases.push({
          name: `${kind} at ${entry.endpoint} #1`,
          group: "reads",
          boundaryName: `${entry.endpoint} #1`,
          boundary: { kind: "http", endpoint: entry.endpoint, occurrence: 1 },
          http: [httpRule(entry.endpoint, 1, kind)],
        });
    }
  }
  const calls = new Map();
  for (const call of reference.calls) {
    const key = `${call.target}.${call.method}`;
    const occurrence = (calls.get(key) ?? 0) + 1;
    calls.set(key, occurrence);
    for (const kind of KINDS)
      cases.push({
        name: `${kind} at ${key} #${occurrence}`,
        group: "calls",
        boundaryName: `${key} #${occurrence}`,
        boundary: {
          kind: "call",
          target: call.target,
          method: call.method,
          occurrence,
        },
        inProcess: [
          {
            target: call.target,
            method: call.method,
            occurrence,
            kind,
            ...(kind === "unavailable" ? { times: 2 } : {}),
          },
        ],
      });
  }
  return cases;
}

/** REST endpoints a run applied mutations to (Git transport aside). */
const effectEndpoints = (result) =>
  [
    ...new Set(
      result.fake.log
        .filter((entry) => entry.effect && !entry.endpoint.startsWith("GIT "))
        .map((entry) => entry.endpoint),
    ),
  ].sort();

/** Model calls that reached the provider plus worker starts. */
const paidCalls = (result) =>
  result.calls.filter((call) => call.target === "model" && call.reached)
    .length + result.harness.filter((event) => event.type === "start").length;

const compiles = (result) =>
  result.calls.filter(
    (call) => call.method === "generateStructured" && call.reached,
  ).length;

/** Every injected fault and lag took effect; otherwise the case proves nothing. */
export function assertFaultsFired(result) {
  for (const rule of result.fake.rules)
    assert.ok(rule.fired > 0, `fault never fired: ${String(rule.match)}`);
  for (const rule of result.fake.lag)
    assert.ok(rule.served > 0, `lag never served a stale read: ${rule.read}`);
  for (const fault of result.inProcess)
    assert.ok(
      result.calls.some(
        (call) =>
          call.target === fault.target &&
          call.method === fault.method &&
          call.fault === fault.kind,
      ),
      `fault never fired: ${fault.kind} at ${fault.target}.${fault.method} #${fault.occurrence}`,
    );
}

/**
 * The end state every case must reach after restarts, judged from GitHub and
 * the repository: one issue per marker, one PR per branch, one applied merge
 * per PR, a completion comment once, the reference's kinds of mutation and
 * nothing GitHub refused, the scripted files on the default branch, every
 * merge commit an ancestor of it, and the reviewed dependency and sub-issue
 * topology.
 */
export async function assertEndState(result, { foreignIssues = 0 } = {}) {
  const { fake, items, repository } = result;
  const reference = await referenceRun(result.delivery);
  const context = () =>
    JSON.stringify(
      { runs: result.runs, crashes: result.crashes, counts: fake.counts() },
      null,
      1,
    );
  assert.equal(result.final.outcome, "complete", context());
  const objective = fake.issue(OBJECTIVE);
  assert.equal(objective.state, "closed", `Objective closed\n${context()}`);
  assert.equal(fake.commentsOn(OBJECTIVE).length, 1, "Objective comments");
  const issueOf = {};
  for (const item of items) {
    const issues = fake.issuesWithMarker(marker(item.id));
    assert.equal(issues.length, 1, `issues for ${item.id}\n${context()}`);
    issueOf[item.id] = issues[0].number;
    assert.equal(issues[0].state, "closed", `issue for ${item.id} closed`);
    assert.equal(
      fake.commentsOn(issues[0].number).length,
      1,
      `completion comments on ${item.id}`,
    );
  }
  assert.equal(
    Object.keys(fake.state.issues).length,
    1 + items.length * 2 + foreignIssues,
    `issue and PR numbers\n${context()}`,
  );
  for (const item of items) {
    const pulls = fake.pullsForBranch(branch(item.id));
    assert.equal(pulls.length, 1, `PRs for ${item.id}\n${context()}`);
    assert.equal(pulls[0].merges ?? 0, 1, `merges of ${item.id}'s PR`);
    assert.equal(
      repository.merges[pulls[0].number],
      true,
      `${item.id}'s merge commit is on the default branch`,
    );
  }
  assert.deepEqual(
    effectEndpoints(result),
    effectEndpoints(reference),
    "kinds of mutation",
  );
  assert.deepEqual(
    fake.log
      .filter(
        (entry) =>
          [405, 409, 422].includes(entry.status) || entry.unhandled === true,
      )
      .map((entry) => `${entry.endpoint} → ${entry.status}`),
    [],
    context(),
  );
  for (const item of items)
    assert.equal(
      repository.files[`${item.id}.txt`],
      `${item.id}\n`,
      `${item.id}.txt on the default branch`,
    );
  for (const item of items) {
    assert.deepEqual(
      [...(fake.state.blockedBy[issueOf[item.id]] ?? [])].sort(),
      item.dependencies.map((id) => issueOf[id]).sort(),
      `dependencies of ${item.id}`,
    );
    assert.equal(
      fake.state.parent[issueOf[item.id]],
      OBJECTIVE,
      `parent of ${item.id}`,
    );
  }
  const starts = result.harness.filter((event) => event.type === "start");
  assert.equal(
    new Set(starts.map((event) => event.attempt)).size,
    starts.length,
    "an attempt started twice",
  );
}

/** No run stopped for an operator: only injected crashes interrupt it. */
export function assertNoOperatorStop(result) {
  // Name each stopped Work Item's recorded failure: a needs-decision summary
  // alone does not say why the run stopped.
  const failures = (run) =>
    Object.entries(run.work ?? {})
      .filter(([, work]) => work.failure)
      .map(([id, work]) => ` [${id}: ${work.failure.trim()}]`)
      .join("");
  const stops = result.runs
    .filter((run) => !["complete", "crashed"].includes(run.outcome))
    .map(
      (run) =>
        `${run.outcome}: ${run.message ?? run.stderr ?? ""}${failures(run)}`,
    );
  assert.deepEqual(stops, [], `operator stops: ${stops.join(" | ")}`);
}

/**
 * Paid work (model calls that reached the provider, worker starts) stays
 * within the reference plus one per injected fault that reached a paid call.
 */
export async function assertPaidBudget(result) {
  const reference = await referenceRun(result.delivery);
  const injected = result.calls.filter((call) => PAID.has(call.fault)).length;
  assert.ok(
    paidCalls(result) <= paidCalls(reference) + injected,
    `${paidCalls(result)} paid calls; uninterrupted ${paidCalls(reference)}, ${injected} injected`,
  );
}

/** An interrupted plan review reviews the compiled plan; it does not compile again. */
export async function assertPlanCompiledOnce(result) {
  const reference = await referenceRun(result.delivery);
  assert.equal(compiles(result), compiles(reference), "plan compilations");
}

/**
 * Factory refused to continue past a fact it must not accept: a run stopped
 * with `refuses`, and neither the Objective nor any Work Item issue was
 * closed as completed.
 */
export function assertRefusal(result, { refuses }) {
  assert.ok(
    result.runs.some(
      (run) =>
        !["complete", "crashed"].includes(run.outcome) &&
        refuses.test(`${run.message ?? ""} ${JSON.stringify(run.work ?? {})}`),
    ),
    `no run refused with ${refuses}: ${JSON.stringify(result.runs)}`,
  );
  assert.equal(result.fake.issue(OBJECTIVE).state, "open", "Objective open");
  for (const item of result.items)
    for (const issue of result.fake.issuesWithMarker(marker(item.id)))
      assert.equal(issue.state, "open", `issue for ${item.id} open`);
}

export const CHECKS = {
  refusal: { suffix: " is refused", assert: assertRefusal },
  end: { suffix: "", assert: assertEndState },
  stop: { suffix: " without an operator stop", assert: assertNoOperatorStop },
  budget: { suffix: " within the paid-call budget", assert: assertPaidBudget },
  plan: { suffix: " compiles the plan once", assert: assertPlanCompiledOnce },
};

/** Test names a scenario declares for `checks`. */
export const testNames = (name, checks) =>
  checks.map((check) => `${name}${CHECKS[check].suffix}`);

/** A known failure must name a declared test. */
export function checkKnown(known, names) {
  const declared = new Set(names);
  for (const name of Object.keys(known))
    if (!declared.has(name)) throw new Error(`Unknown scenario test: ${name}`);
}

/** With FACTORY_FAULT_REPORT=<file>, append one JSON line per scenario run. */
function report(name, value) {
  if (!process.env.FACTORY_FAULT_REPORT) return;
  appendFileSync(
    process.env.FACTORY_FAULT_REPORT,
    `${JSON.stringify({
      suite: basename(process.argv[1] ?? ""),
      name,
      runs: value.runs,
      crashes: value.crashes,
      refused: value.fake.log
        .filter(
          (entry) =>
            (entry.status >= 400 && entry.status !== 404) || entry.unhandled,
        )
        .map(
          (entry) =>
            `${entry.endpoint} → ${entry.status}${entry.fault ? ` (${entry.fault})` : ""}`,
        ),
    })}\n`,
  );
}

/**
 * Declare one scenario as one test per check over a single run. Every test
 * first requires that each injected fault fired. A known failure is inverted:
 * it passes only while its check fails with a message matching its
 * diagnosis pattern, fails naming the reason when the check fails another
 * way, and fails once the bug is fixed so its entry must be removed. A racy
 * known failure may also pass.
 */
export function declareScenario(name, run, options, known) {
  const { checks = ["end", "stop", "budget"], ...context } = options;
  let result;
  const once = () =>
    (result ??= run().then((value) => {
      report(name, value);
      return value;
    }));
  for (const check of checks) {
    const testName = `${name}${CHECKS[check].suffix}`;
    const diagnosis = known[testName];
    test(testName, { timeout: 300_000 }, async (t) => {
      const value = await once();
      assertFaultsFired(value);
      if (!diagnosis) return CHECKS[check].assert(value, context);
      try {
        await CHECKS[check].assert(value, context);
      } catch (error) {
        const message = String(error?.message ?? error);
        if (!diagnosis.pattern.test(message))
          assert.fail(
            `Known failure ${diagnosis.key} failed for another reason (expected ${diagnosis.pattern}): ${message.slice(0, 4000)}`,
          );
        t.diagnostic(
          `${diagnosis.racy ? "racy " : ""}known failure ${diagnosis.key}: ${diagnosis.text}`,
        );
        return;
      }
      if (diagnosis.racy) return;
      assert.fail(
        `Known failure ${diagnosis.key} no longer reproduces; remove it from test/support/fault-known.mjs: ${diagnosis.text}`,
      );
    });
  }
}

const checksFor = (testCase) =>
  testCase.boundary.kind === "call" &&
  testCase.boundary.method === "reviewGraph"
    ? ["end", "stop", "budget", "plan"]
    : ["end", "stop", "budget"];

const SNAPSHOT = join(import.meta.dirname, "fault-boundaries.json");

/** Derived boundary names by group, sorted so request interleaving cannot reorder them. */
export function boundarySnapshot(cases) {
  const groups = { mutations: new Set(), reads: new Set(), calls: new Set() };
  for (const testCase of cases)
    groups[testCase.group].add(testCase.boundaryName);
  return Object.fromEntries(
    Object.entries(groups).map(([group, names]) => [group, [...names].sort()]),
  );
}

/**
 * Compare the derived boundaries with the committed snapshot. A boundary added
 * or removed changes what the matrix tests, so it fails until the snapshot is
 * regenerated deliberately (`npm run test:fault-boundaries`, which sets
 * FACTORY_UPDATE_FAULT_BOUNDARIES=1).
 */
export function checkBoundarySnapshot(delivery, snapshot) {
  const committed = existsSync(SNAPSHOT)
    ? JSON.parse(readFileSync(SNAPSHOT, "utf8"))
    : {};
  if (process.env.FACTORY_UPDATE_FAULT_BOUNDARIES === "1") {
    // Read-modify-write per delivery; the update script runs one file at a time.
    committed[delivery] = snapshot;
    const ordered = Object.fromEntries(
      Object.keys(committed)
        .sort()
        .map((key) => [key, committed[key]]),
    );
    writeFileSync(SNAPSHOT, `${JSON.stringify(ordered, null, 2)}\n`);
    return;
  }
  const expected = committed[delivery] ?? {};
  const differences = [];
  for (const group of Object.keys(snapshot)) {
    const now = new Set(snapshot[group]);
    const before = new Set(expected[group] ?? []);
    for (const name of now)
      if (!before.has(name)) differences.push(`+ ${group}: ${name}`);
    for (const name of before)
      if (!now.has(name)) differences.push(`- ${group}: ${name}`);
  }
  if (differences.length)
    throw new Error(
      `Fault boundaries for ${delivery} delivery differ from test/support/fault-boundaries.json: boundary added or removed; update the snapshot deliberately with \`npm run test:fault-boundaries\` and review the diff.\n${differences.join("\n")}`,
    );
}

/** Stable part (1-based) for a case, independent of every other case. */
export function partOf(caseName, parts) {
  const hash = createHash("sha256").update(caseName).digest();
  return (hash.readUInt32BE(0) % parts) + 1;
}

/**
 * Declare part `part` of `parts` of the matrix for one delivery strategy.
 * Each case goes to the part given by a hash of its name, `<kind> at
 * <boundary>`, so slow cases (crash-after, closure) spread across files and
 * CI shards, and adding or removing a boundary moves no other case. Hashing
 * the boundary alone keeps a boundary's kinds together but, with about 45
 * boundaries, splits 62/90; hashing the case splits about evenly.
 */
export async function defineMatrix(delivery, known, part = 1, parts = 2) {
  const reference = await referenceRun(delivery);
  const cases = deriveCases(reference);
  checkBoundarySnapshot(delivery, boundarySnapshot(cases));
  checkKnown(
    known,
    cases.flatMap((testCase) => testNames(testCase.name, checksFor(testCase))),
  );
  describe(`fault matrix: ${delivery} delivery (${part}/${parts})`, {
    concurrency: scenarioConcurrency(),
  }, () => {
    if (part === 1)
      declareScenario(
        "uninterrupted run",
        () => referenceRun(delivery),
        { checks: ["end", "stop"] },
        {},
      );
    for (const [index, testCase] of cases.entries()) {
      if (partOf(testCase.name, parts) !== part) continue;
      declareScenario(
        testCase.name,
        () =>
          runScenario({
            name: `${delivery === "regular" ? "r" : "n"}${index}`,
            delivery,
            http: testCase.http ?? [],
            inProcess: testCase.inProcess ?? [],
          }),
        { checks: checksFor(testCase) },
        known,
      );
    }
  });
}
