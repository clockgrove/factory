// The fault matrix: for every effect boundary of an uninterrupted two-item
// Objective (alpha → beta), inject a crash, a lost response or an unavailable
// burst at that boundary, restart the controller, and require the same fixed
// end state as an uninterrupted run, read from the strict GitHub fake's
// request log rather than from fake state.
import assert from "node:assert/strict";
import { availableParallelism } from "node:os";
import { describe, test } from "node:test";
import { faults } from "./github-http-fake.mjs";
import { branch, marker, OBJECTIVE, runScenario } from "./fault-harness.mjs";

const repo = "/repos/{owner}/{repo}";

/** Mutations of an uninterrupted run, per endpoint. Every one is a boundary. */
export const REFERENCE_EFFECTS = {
  regular: {
    [`POST ${repo}/labels`]: 2,
    [`POST ${repo}/issues/{number}/labels`]: 1,
    [`POST ${repo}/issues`]: 2,
    [`POST ${repo}/issues/{number}/dependencies/blocked_by`]: 1,
    [`POST ${repo}/issues/{number}/sub_issues`]: 2,
    [`POST ${repo}/pulls`]: 2,
    [`PUT ${repo}/pulls/{number}/merge`]: 2,
    [`POST ${repo}/issues/{number}/comments`]: 3,
    [`PATCH ${repo}/issues/{number}`]: 3,
  },
  "native-stack": {
    [`POST ${repo}/labels`]: 2,
    [`POST ${repo}/issues/{number}/labels`]: 1,
    [`POST ${repo}/issues`]: 2,
    [`POST ${repo}/issues/{number}/dependencies/blocked_by`]: 1,
    [`POST ${repo}/issues/{number}/sub_issues`]: 2,
    [`POST ${repo}/pulls`]: 2,
    [`POST ${repo}/stacks`]: 1,
    [`PUT ${repo}/pulls/{number}/merge-async`]: 1,
    [`POST ${repo}/issues/{number}/comments`]: 3,
    [`PATCH ${repo}/issues/{number}`]: 3,
  },
};

/** Reads of an uninterrupted run; each is faulted on its first occurrence. */
export const REFERENCE_READS = {
  regular: [
    `GET ${repo}/issues/{number}`,
    `GET ${repo}/labels`,
    `GET ${repo}/issues`,
    `GET ${repo}/issues/{number}/dependencies/blocked_by`,
    `GET ${repo}/issues/{number}/sub_issues`,
    `GET ${repo}`,
    `GET ${repo}/pulls`,
    `GET ${repo}/pulls/{number}`,
    `GET ${repo}/commits/{sha}/check-runs`,
    `GET ${repo}/commits/{sha}/status`,
    "POST /graphql",
    `GET ${repo}/issues/{number}/comments`,
    "GIT fetch-advertise",
  ],
  "native-stack": [
    `GET ${repo}/issues/{number}`,
    `GET ${repo}/labels`,
    `GET ${repo}/issues`,
    `GET ${repo}/issues/{number}/dependencies/blocked_by`,
    `GET ${repo}/issues/{number}/sub_issues`,
    `GET ${repo}`,
    `GET ${repo}/pulls`,
    `GET ${repo}/pulls/{number}`,
    `GET ${repo}/commits/{sha}/check-runs`,
    `GET ${repo}/commits/{sha}/status`,
    "POST /graphql",
    `GET ${repo}/stacks`,
    `GET ${repo}/pulls/{number}/merge-async/{uuid}`,
    `GET ${repo}/issues/{number}/timeline`,
    `GET ${repo}/issues/{number}/comments`,
    "GIT fetch-advertise",
  ],
};

/** In-process effects of an uninterrupted run (model and driver calls). */
export const REFERENCE_CALLS = {
  "model.generateStructured": 1,
  "model.reviewGraph": 1,
  "model.reviewResult": 3,
  "driver.start": 2,
  "driver.collect": 2,
};

const KINDS = ["crash-before", "crash-after", "lost", "unavailable"];

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

/** Every case of the matrix for one delivery strategy. */
export function matrixCases(delivery) {
  const cases = [];
  for (const [endpoint, count] of [
    ...Object.entries(REFERENCE_EFFECTS[delivery]),
    ["GIT push", 2],
  ])
    for (let occurrence = 1; occurrence <= count; occurrence++)
      for (const kind of KINDS)
        cases.push({
          name: `${kind} at ${endpoint} #${occurrence}`,
          boundary: { kind: "http", endpoint, occurrence },
          fault: kind,
          http: [httpRule(endpoint, occurrence, kind)],
        });
  for (const endpoint of REFERENCE_READS[delivery])
    for (const kind of ["unavailable", "reset"])
      cases.push({
        name: `${kind} at ${endpoint} #1`,
        boundary: { kind: "http", endpoint, occurrence: 1 },
        fault: kind,
        http: [httpRule(endpoint, 1, kind)],
      });
  for (const [call, count] of Object.entries(REFERENCE_CALLS)) {
    const [target, method] = call.split(".");
    for (let occurrence = 1; occurrence <= count; occurrence++)
      for (const kind of KINDS)
        cases.push({
          name: `${kind} at ${call} #${occurrence}`,
          boundary: { kind: "call", target, method, occurrence },
          fault: kind,
          inProcess: [
            {
              target,
              method,
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
 * The fixed outcome every case must reach after restarts: the same GitHub
 * effects as an uninterrupted run, nothing duplicated, nothing refused.
 */
export function assertCleanOutcome(result, testCase) {
  const { fake, items, delivery, final } = result;
  const context = () =>
    JSON.stringify(
      { runs: result.runs, crashes: result.crashes, counts: fake.counts() },
      null,
      1,
    );
  assert.equal(final.outcome, "completed", context());
  assert.equal(final.finalValidation, true, context());
  // Exact issue count per marker, each closed with one completion comment.
  for (const item of items) {
    const issues = fake.issuesWithMarker(marker(item.id));
    assert.equal(issues.length, 1, `issues for ${item.id}\n${context()}`);
    assert.equal(issues[0].state, "closed", `issue for ${item.id} closed`);
    assert.equal(
      fake.commentsOn(issues[0].number).length,
      1,
      `completion comments on ${item.id}`,
    );
  }
  const objective = fake.issue(OBJECTIVE);
  assert.equal(objective.state, "closed", `Objective closed\n${context()}`);
  assert.equal(fake.commentsOn(OBJECTIVE).length, 1, "Objective comments");
  // Nothing but the Objective, the Work Items, their PRs and issues other
  // actors opened exists.
  assert.equal(
    Object.keys(fake.state.issues).length,
    1 + items.length * 2 + (testCase.foreignIssues ?? 0),
    `issue and PR numbers\n${context()}`,
  );
  // Exactly one PR per branch, merged.
  for (const item of items) {
    const pulls = fake.pullsForBranch(branch(item.id));
    assert.equal(pulls.length, 1, `PRs for ${item.id}\n${context()}`);
    assert.ok(pulls[0].merged_at, `PR for ${item.id} merged\n${context()}`);
  }
  // Exactly the mutations of an uninterrupted run, counted where GitHub
  // applied them (a dropped response still counts as applied).
  for (const [endpoint, count] of Object.entries(REFERENCE_EFFECTS[delivery]))
    assert.equal(
      fake.effects(endpoint).length,
      count,
      `${endpoint} applied\n${context()}`,
    );
  // Factory never sent a request GitHub refused as a duplicate, conflict or
  // invalid state, and never called an endpoint the fake does not serve.
  const refused = fake.log.filter(
    (entry) =>
      [405, 409, 422].includes(entry.status) || entry.unhandled === true,
  );
  assert.deepEqual(
    refused.map((entry) => `${entry.endpoint} → ${entry.status}`),
    [],
    context(),
  );
  // One worker start per attempt; a fault on the driver may add one attempt.
  const starts = result.harness.filter((event) => event.type === "start");
  assert.equal(
    new Set(starts.map((event) => event.attempt)).size,
    starts.length,
    "an attempt started twice",
  );
  const driverFault = testCase.boundary.target === "driver";
  for (const item of items) {
    const count = starts.filter((event) => event.item === item.id).length;
    assert.ok(
      count >= 1 && count <= (driverFault ? 2 : 1),
      `${count} worker starts for ${item.id}`,
    );
  }
  // Model calls that reached the provider stay bounded: at most one more than
  // an uninterrupted run, and only for the faulted method.
  for (const [call, count] of Object.entries(REFERENCE_CALLS)) {
    const [target, method] = call.split(".");
    if (target !== "model") continue;
    const reached = result.calls.filter(
      (entry) =>
        entry.target === target && entry.method === method && entry.reached,
    ).length;
    const faulted =
      testCase.boundary.target === target &&
      testCase.boundary.method === method;
    assert.ok(
      reached >= count && reached <= count + (faulted ? 1 : 0),
      `${reached} ${call} calls (uninterrupted: ${count})`,
    );
  }
}

/** No run stopped for an operator: only injected crashes interrupt it. */
export function assertNoOperatorStop(result) {
  assert.deepEqual(
    result.runs
      .filter(
        (run) => !["completed", "crashed", "returned"].includes(run.outcome),
      )
      .map((run) => `${run.outcome}: ${run.message ?? run.stderr ?? ""}`),
    [],
  );
}

export const OPERATOR_STOP = "without an operator stop";

/**
 * Declare one scenario as two tests over a single run: the fixed end state,
 * and that no run stopped for an operator on its way there. Known failures
 * are `todo` with their diagnosis: they run and report, but do not fail.
 */
export function declareScenario(name, run, testCase, known) {
  let result;
  const once = () =>
    (result ??= run().then((value) => {
      if (process.env.FACTORY_FAULT_REPORT)
        console.log(
          `FAULT-REPORT ${JSON.stringify({
            name,
            runs: value.runs,
            crashes: value.crashes,
            refused: value.fake.log
              .filter(
                (entry) =>
                  (entry.status >= 400 && entry.status !== 404) ||
                  entry.unhandled,
              )
              .map(
                (entry) =>
                  `${entry.endpoint} → ${entry.status}${entry.fault ? ` (${entry.fault})` : ""}`,
              ),
          })}`,
        );
      return value;
    }));
  const options = (todo) => ({ ...(todo ? { todo } : {}), timeout: 300_000 });
  test(name, options(known[name]), async () =>
    assertCleanOutcome(await once(), testCase),
  );
  const stop = `${name} ${OPERATOR_STOP}`;
  test(stop, options(known[stop]), async () =>
    assertNoOperatorStop(await once()),
  );
}

/** Expand {diagnosis: [case names]} into {case name: diagnosis}. */
export function todos(groups) {
  const map = {};
  for (const [diagnosis, names] of Object.entries(groups))
    for (const name of names) {
      if (map[name]) throw new Error(`Duplicate known failure: ${name}`);
      map[name] = diagnosis;
    }
  return map;
}

/** Declare the matrix for one delivery strategy. */
export function defineMatrix(delivery, known) {
  const cases = matrixCases(delivery);
  const names = new Set(
    cases.flatMap((testCase) => [
      testCase.name,
      `${testCase.name} ${OPERATOR_STOP}`,
    ]),
  );
  for (const name of Object.keys(known))
    if (!names.has(name)) throw new Error(`Unknown matrix case: ${name}`);
  describe(`fault matrix: ${delivery} delivery`, {
    concurrency: Math.max(2, Math.floor(availableParallelism() / 2)),
  }, () => {
    declareScenario(
      "uninterrupted run",
      () => runScenario({ name: `reference-${delivery}`, delivery }),
      { boundary: {} },
      {},
    );
    for (const [index, testCase] of cases.entries())
      declareScenario(
        testCase.name,
        () =>
          runScenario({
            name: `${delivery === "regular" ? "r" : "n"}${index}`,
            delivery,
            http: testCase.http ?? [],
            inProcess: testCase.inProcess ?? [],
          }),
        testCase,
        known,
      );
  });
}
