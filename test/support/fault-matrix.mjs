// The fault matrix: run an uninterrupted two-item Objective (alpha → beta)
// once per delivery strategy, derive every effect boundary from what that
// run did, then inject a crash, a lost response or an unavailable burst at each boundary, restart the controller, and check
// invariants of the end state read from GitHub's request log and the
// repository, not from Factory's own state. Driver lifecycle premises (an
// operator cancel, a run stopped for a decision) reach the execution
// driver's cancel and observe calls, which an uninterrupted run never makes;
// the matrix derives and faults those the same way. Nothing here names
// Factory internals, so the matrix survives the recovery redesign.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { availableParallelism } from "node:os";
import { basename, join } from "node:path";
import { describe, test } from "node:test";
import { faults } from "./github-http-fake.mjs";
import {
  OBJECTIVE,
  branch,
  marker,
  runScenario,
  workItem,
} from "./fault-harness.mjs";

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
const MERGE_ASYNC = "PUT /repos/{owner}/{repo}/pulls/{number}/merge-async";
const MERGE_ASYNC_STATUS =
  "GET /repos/{owner}/{repo}/pulls/{number}/merge-async/{uuid}";
const PAID = new Set(["crash-after", "lost"]);

/**
 * Whether the log entry at `index` is a merge-async 409 that directly
 * follows a dropped or crashed merge-async on the same PR, and that Factory
 * then used: after a lost response, the 409 naming the pending request is
 * the only way to learn its uuid, so a status poll of that PR's merge
 * request must follow. Any other 409 is Factory's request refused.
 */
function resumesLostMerge(log, index) {
  const entry = log[index];
  if (entry.endpoint !== MERGE_ASYNC || entry.status !== 409) return false;
  const previous = log
    .slice(0, index)
    .findLast(
      (other) => other.endpoint === MERGE_ASYNC && other.path === entry.path,
    );
  const polled = log
    .slice(index + 1)
    .some(
      (other) =>
        other.endpoint === MERGE_ASYNC_STATUS &&
        other.path.startsWith(`${entry.path.split("?")[0]}/`),
    );
  return ["dropped", "crash"].includes(previous?.status) && polled;
}

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
      cases.push({
        name: `unavailable at ${entry.endpoint} #1`,
        group: "reads",
        boundaryName: `${entry.endpoint} #1`,
        boundary: { kind: "http", endpoint: entry.endpoint, occurrence: 1 },
        http: [httpRule(entry.endpoint, 1, "unavailable")],
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

/**
 * Premises under which a run reaches the execution driver's cancel and
 * observe calls. Each runs once uninterrupted as its own reference; its
 * driver.cancel and driver.observe calls in the first controller run become
 * boundaries (the main matrix covers every other call). The snapshot records
 * each premise's boundaries, so a premise that stops reaching them, or a
 * driver path that appears, fails until it is reviewed.
 */
const repo = "/repos/{owner}/{repo}";
export const VARIANTS = [
  {
    key: "cancel-running",
    when: "when an operator cancels while alpha's worker runs",
    // The cancel sweep stops the recorded attempt.
    scenario: {
      actions: { alpha: { barrier: true } },
      operator: { action: "cancel", method: "collect", item: "alpha" },
    },
    checks: ["cancelled"],
  },
  {
    key: "cancel-starting",
    when: "when an operator cancels while alpha's worker is starting",
    // The delivery runner cancels the handle that start returns.
    scenario: {
      actions: { alpha: { barrier: true } },
      operator: { action: "cancel", method: "start", item: "alpha" },
    },
    checks: ["cancelled"],
  },
  {
    key: "edit-running",
    when: "when the Objective is edited while beta's worker runs",
    // Independent items run together. The edit at alpha's PR is an
    // Objective decision (contracts 2 and 4): the Objective waits for it, and
    // beta's running worker is neither failed nor stopped. Beta's barrier
    // opens only after the edit, so beta's worker spans it.
    scenario: {
      items: [workItem("alpha"), workItem("beta")],
      actions: { beta: { barrier: true } },
      http: [
        {
          match: `POST ${repo}/pulls`,
          kind: "after",
          run: (fake, _entry, { release }) => {
            fake.editIssueBody(
              OBJECTIVE,
              `${fake.issue(OBJECTIVE).body}\nEdited by the Objective's author.\n`,
            );
            release("beta");
          },
        },
      ],
    },
    checks: ["refusal"],
    refuses:
      /needs a decision: The Objective issue body changed outside Factory/,
    untouched: ["beta"],
  },
];

const LIFECYCLE = new Set(["cancel", "observe"]);

/** Driver cancel and observe boundaries of one premise's reference run. */
export function deriveVariantCases(variant, reference) {
  const cases = [];
  const calls = new Map();
  for (const call of reference.calls) {
    if (call.run !== 0 || call.target !== "driver") continue;
    if (!LIFECYCLE.has(call.method)) continue;
    const key = `${call.target}.${call.method}`;
    const occurrence = (calls.get(key) ?? 0) + 1;
    calls.set(key, occurrence);
    for (const kind of KINDS)
      cases.push({
        name: `${kind} at ${key} #${occurrence} ${variant.when}`,
        group: variant.key,
        boundaryName: `${key} #${occurrence}`,
        boundary: {
          kind: "call",
          target: call.target,
          method: call.method,
          occurrence,
        },
        variant,
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

/**
 * Every injected fault and lag took effect, and nothing outside the harness
 * signalled a controller; otherwise the case proves nothing about Factory.
 */
export function assertFaultsFired(result) {
  const runs = () => result.runs.map(summarizeRun).join(" | ");
  assert.deepEqual(
    result.signals ?? [],
    [],
    `a controller received a signal from outside the harness (SIGTERM makes Factory drain and release ownership), so the scenario is void, not a Factory result: ${runs()}`,
  );
  for (const rule of result.fake.rules)
    assert.ok(
      rule.fired > 0,
      `fault never fired: ${String(rule.match)}; runs: ${runs()}`,
    );
  for (const rule of result.fake.lag)
    assert.ok(
      rule.served > 0,
      `lag never served a stale read: ${rule.read}; runs: ${runs()}`,
    );
  for (const fault of result.inProcess)
    assert.ok(
      result.calls.some(
        (call) =>
          call.target === fault.target &&
          call.method === fault.method &&
          call.fault === fault.kind,
      ),
      `fault never fired: ${fault.kind} at ${fault.target}.${fault.method} #${fault.occurrence}; runs: ${runs()}`,
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
export async function assertEndState(
  result,
  { foreignIssues = 0, extraMutations = [] } = {},
) {
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
    assert.equal(
      issues.length,
      1,
      `Work Item ${item.id} has ${issues.length} issues with its marker\n${context()}`,
    );
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
    [...new Set([...effectEndpoints(reference), ...extraMutations])].sort(),
    "kinds of mutation",
  );
  assert.deepEqual(
    fake.log
      .filter(
        (entry, index) =>
          // A refusal the test injected is not Factory's request refused.
          (entry.fault !== "status" &&
            [405, 409, 422].includes(entry.status) &&
            !resumesLostMerge(fake.log, index)) ||
          entry.unhandled === true,
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
 * closed as completed, and none of the `unsent` endpoints was requested.
 */
export function assertRefusal(
  result,
  { refuses, unsent = [], untouched = [] },
) {
  // Items an Objective-scope stop must leave in place: never failed and
  // their workers never stopped (contract 2).
  for (const id of untouched) {
    assert.deepEqual(
      result.harness.filter(
        (event) => event.type === "cancel" && event.item === id,
      ),
      [],
      `${id}'s worker was stopped: ${result.runs.map(summarizeRun).join(" | ")}`,
    );
    for (const run of result.runs)
      assert.notEqual(
        run.work?.[id]?.status,
        "failed",
        `${id} failed: ${summarizeRun(run)}`,
      );
  }
  // Requests Factory must refuse before sending.
  for (const endpoint of unsent)
    assert.equal(result.fake.requests(endpoint).length, 0, `sent ${endpoint}`);
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

/**
 * The operator's cancellation took effect: the last run reports the
 * Objective cancelled without an unresolved cessation, every worker attempt
 * that started was cancelled, and nothing was delivered or closed on GitHub.
 */
export function assertCancelled(result) {
  const runs = () => result.runs.map(summarizeRun).join(" | ");
  assert.equal(result.final.cancel, "done", `cancellation: ${runs()}`);
  assert.equal(
    result.final.cancelError,
    undefined,
    `cancellation error: ${runs()}`,
  );
  const cancelled = new Set(
    result.harness
      .filter((event) => event.type === "cancel")
      .map((event) => event.attempt),
  );
  for (const start of result.harness.filter((event) => event.type === "start"))
    assert.ok(
      cancelled.has(start.attempt),
      `${start.item}'s attempt ${start.attempt} was never cancelled: ${runs()}`,
    );
  assert.equal(result.fake.issue(OBJECTIVE).state, "open", "Objective open");
  for (const item of result.items)
    for (const issue of result.fake.issuesWithMarker(marker(item.id)))
      assert.equal(issue.state, "open", `issue for ${item.id} open`);
  assert.deepEqual(
    Object.values(result.fake.state.pulls)
      .filter((pull) => (pull.merges ?? 0) > 0)
      .map((pull) => pull.number),
    [],
    "merged PRs",
  );
}

/**
 * A paid step hit its bound and the operator's answer converged: the first
 * run made exactly `bound.calls` paid tries of the faulted call (three
 * transient faults, then the fourth becomes a decision) and stopped for a
 * decision with the Work Item still in place, not failed; the restart ran the
 * `factory retry` command the status named (`bound.answer`), and the step
 * ran again. The end state is checked separately.
 */
export function assertBoundAnswered(result, { bound }) {
  const runs = () => result.runs.map(summarizeRun).join(" | ");
  const [first, second] = result.runs;
  assert.equal(first?.outcome, "needs-decision", `first run: ${runs()}`);
  if (bound.item)
    assert.notEqual(
      first.work?.[bound.item]?.status,
      "failed",
      `${bound.item} waits in place for the decision: ${runs()}`,
    );
  if (bound.call) {
    const tries = result.calls.filter(
      (call) =>
        call.run === 0 &&
        call.target === bound.call.target &&
        call.method === bound.call.method &&
        (bound.call.phase === undefined || call.phase === bound.call.phase) &&
        (bound.call.item === undefined || call.item === bound.call.item),
    );
    assert.deepEqual(
      tries.map((call) => call.fault ?? "none"),
      Array(bound.calls).fill(bound.call.kind),
      `paid tries of ${bound.call.target}.${bound.call.method} before the decision: ${runs()}`,
    );
  }
  if (bound.worker) {
    const events = (type) =>
      result.harness.filter(
        (event) => event.type === type && event.item === bound.worker,
      ).length;
    assert.equal(events("died"), bound.calls, `${bound.worker}'s workers died`);
    assert.equal(
      events("start"),
      bound.calls + 1,
      `${bound.worker}'s workers started: ${runs()}`,
    );
  }
  assert.deepEqual(
    second?.answered,
    { command: bound.answer, applied: "step" },
    `the operator's answer: ${runs()}`,
  );
}

export const CHECKS = {
  bound: {
    suffix: " stops for a decision that factory retry answers",
    assert: assertBoundAnswered,
  },
  cancelled: { suffix: " is cancelled", assert: assertCancelled },
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
      summaries: value.runs.map(summarizeRun),
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
 * One controller run as a single line: its outcome, its message, and where
 * each Work Item stood. Diagnosis patterns anchor on this, so they name where
 * a run stopped, not just generic transport text.
 */
export function summarizeRun(run) {
  const entries = Object.entries(run.work ?? {}).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  const work = entries.length
    ? entries
        .map(
          ([id, item]) =>
            `${id}:${item.status}${item.step ? `@${item.step}` : ""}`,
        )
        .join(",")
    : "none";
  const failures = entries
    .filter(([, item]) => item.failure)
    .map(([id, item]) => `; failure[${id}]=${item.failure.trim()}`)
    .join("");
  const message = (run.message ?? run.stderr ?? "").replace(/\s+/g, " ").trim();
  const cancel = run.cancel
    ? `; cancel=${run.cancel}${run.cancelError ? `; cancelError=${run.cancelError.replace(/\s+/g, " ").trim()}` : ""}`
    : "";
  return `outcome=${run.outcome}; message=${message}; work=${work}${failures}${cancel}`;
}

/**
 * What a known failure's pattern must match: the run that ended the scenario
 * when it did not complete; for the operator-stop check, the last run that
 * stopped; otherwise the check's own failure message (a fact about the end
 * state, such as a duplicate issue). Matching one run, not all runs, keeps an
 * earlier run's message from hiding a later, different failure.
 */
export function diagnosisTarget(result, check, error) {
  const final = result.runs.at(-1);
  if (final && final.outcome !== "complete") return summarizeRun(final);
  if (check === "stop") {
    const stop = result.runs.findLast(
      (run) => !["complete", "crashed"].includes(run.outcome),
    );
    if (stop) return summarizeRun(stop);
  }
  return String(error?.message ?? error);
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
        const target = diagnosisTarget(value, check, error);
        if (!diagnosis.pattern.test(target))
          assert.fail(
            `Known failure ${diagnosis.key} failed for another reason (expected ${diagnosis.pattern} on: ${target.slice(0, 2000)}): ${String(error?.message ?? error).slice(0, 2000)}`,
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
  testCase.variant
    ? testCase.variant.checks
    : testCase.boundary.kind === "call" &&
        testCase.boundary.method === "reviewGraph"
      ? ["end", "stop", "budget", "plan"]
      : ["end", "stop", "budget"];

export const SNAPSHOT = join(import.meta.dirname, "fault-boundaries.json");

/** The delivery modes the matrix derives boundaries for; the snapshot holds exactly these. */
export const MATRIX_DELIVERIES = ["native-stack", "regular"];

/**
 * Derived boundary names by group, sorted so request interleaving cannot
 * reorder them. Every premise has a group, empty when it reaches no
 * boundary.
 */
export function boundarySnapshot(cases) {
  const groups = { mutations: new Set(), reads: new Set(), calls: new Set() };
  for (const variant of VARIANTS) groups[variant.key] = new Set();
  for (const testCase of cases)
    groups[testCase.group].add(testCase.boundaryName);
  return Object.fromEntries(
    Object.entries(groups).map(([group, names]) => [group, [...names].sort()]),
  );
}

/**
 * Differences between the committed snapshot and one delivery's derived
 * boundaries, including deliveries the snapshot holds that the matrix no
 * longer derives. Empty when they agree.
 */
export function snapshotDifferences(committed, delivery, snapshot) {
  const differences = [];
  if (!MATRIX_DELIVERIES.includes(delivery))
    differences.push(`+ delivery ${delivery} is not a matrix delivery`);
  for (const stale of Object.keys(committed))
    if (!MATRIX_DELIVERIES.includes(stale))
      differences.push(`- delivery ${stale} is no longer derived`);
  const expected = committed[delivery] ?? {};
  for (const group of new Set([
    ...Object.keys(snapshot),
    ...Object.keys(expected),
  ])) {
    const now = new Set(snapshot[group] ?? []);
    const before = new Set(expected[group] ?? []);
    for (const name of now)
      if (!before.has(name)) differences.push(`+ ${group}: ${name}`);
    for (const name of before)
      if (!now.has(name)) differences.push(`- ${group}: ${name}`);
  }
  return differences;
}

const pause = (ms) =>
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Record one delivery's boundaries in `path` under an exclusive lock, so
 * concurrent update runs cannot lose each other's write. Deliveries the
 * matrix no longer derives are dropped.
 */
export function updateSnapshot(path, delivery, snapshot) {
  const lock = `${path}.lock`;
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (error) {
      if (error.code !== "EEXIST" || Date.now() > deadline) throw error;
      pause(25);
    }
  }
  try {
    const committed = existsSync(path)
      ? JSON.parse(readFileSync(path, "utf8"))
      : {};
    committed[delivery] = snapshot;
    const ordered = Object.fromEntries(
      Object.keys(committed)
        .filter((key) => MATRIX_DELIVERIES.includes(key))
        .sort()
        .map((key) => [key, committed[key]]),
    );
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(ordered, null, 2)}\n`);
    renameSync(temporary, path);
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

/**
 * Compare the derived boundaries with the committed snapshot. A boundary or
 * delivery added or removed changes what the matrix tests, so it fails until
 * the snapshot is regenerated deliberately (`npm run test:fault-boundaries`,
 * which sets FACTORY_UPDATE_FAULT_BOUNDARIES=1).
 */
export function checkBoundarySnapshot(delivery, snapshot, path = SNAPSHOT) {
  if (process.env.FACTORY_UPDATE_FAULT_BOUNDARIES === "1")
    return updateSnapshot(path, delivery, snapshot);
  const committed = existsSync(path)
    ? JSON.parse(readFileSync(path, "utf8"))
    : {};
  const differences = snapshotDifferences(committed, delivery, snapshot);
  if (differences.length)
    throw new Error(
      `Fault boundaries for ${delivery} delivery differ from test/support/fault-boundaries.json: boundary added or removed; update the snapshot deliberately with \`npm run test:fault-boundaries\` and review the diff.\n${differences.join("\n")}`,
    );
}

/** A premise's reference run, once per process, delivery and premise. */
const variantReferences = new Map();
export function variantReferenceRun(variant, delivery) {
  const key = `${variant.key}/${delivery}`;
  if (!variantReferences.has(key))
    variantReferences.set(
      key,
      runScenario({
        name: `${variant.key}-${delivery}`,
        delivery,
        ...variant.scenario,
      }),
    );
  return variantReferences.get(key);
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
  const [reference, ...premises] = await Promise.all([
    referenceRun(delivery),
    ...VARIANTS.map((variant) => variantReferenceRun(variant, delivery)),
  ]);
  const cases = [
    ...deriveCases(reference),
    ...VARIANTS.flatMap((variant, index) =>
      deriveVariantCases(variant, premises[index]),
    ),
  ];
  checkBoundarySnapshot(delivery, boundarySnapshot(cases));
  const premiseName = (variant) => `premise run ${variant.when}`;
  checkKnown(known, [
    ...cases.flatMap((testCase) =>
      testNames(testCase.name, checksFor(testCase)),
    ),
    ...VARIANTS.flatMap((variant) =>
      testNames(premiseName(variant), variant.checks),
    ),
  ]);
  describe(`fault matrix: ${delivery} delivery (${part}/${parts})`, {
    concurrency: scenarioConcurrency(),
  }, () => {
    if (part === 1) {
      declareScenario(
        "uninterrupted run",
        () => referenceRun(delivery),
        { checks: ["end", "stop"] },
        {},
      );
      // Each premise must hold uninterrupted before its faults mean anything.
      for (const variant of VARIANTS)
        declareScenario(
          premiseName(variant),
          () => variantReferenceRun(variant, delivery),
          {
            checks: variant.checks,
            refuses: variant.refuses,
            untouched: variant.untouched,
          },
          known,
        );
    }
    for (const [index, testCase] of cases.entries()) {
      if (partOf(testCase.name, parts) !== part) continue;
      const premise = testCase.variant?.scenario ?? {};
      declareScenario(
        testCase.name,
        () =>
          runScenario({
            name: `${delivery === "regular" ? "r" : "n"}${index}`,
            delivery,
            ...premise,
            http: [...(premise.http ?? []), ...(testCase.http ?? [])],
            inProcess: testCase.inProcess ?? [],
          }),
        {
          checks: checksFor(testCase),
          refuses: testCase.variant?.refuses,
          untouched: testCase.variant?.untouched,
        },
        known,
      );
    }
  });
}
