// bench/run.mjs against a stand-in Factory CLI (fixtures/bench/factory-cli.mjs).
// `factory run` queues the Objective and then follows it for as long as it
// runs, so run.mjs stops that follower once status shows the Objective
// admitted (its Queued line comes before the service answers) and follows
// with `factory status`; a non-zero exit of any Factory command is a
// result it records, never a crash.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { BENCH_DIR } from "../bench/lib/definition.mjs";
import { HOME_ENV } from "../bench/lib/home.mjs";
import { EXAMPLE, FIXTURE_STATE } from "./bench-fixture.mjs";

const CLI = fileURLToPath(
  new URL("./fixtures/bench/factory-cli.mjs", import.meta.url),
);
const dir = mkdtempSync(join(tmpdir(), "bench-run-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const POLICY_AS = "factory-bench operator policy";
const objective = (status, holds = []) => ({ issue: 42, status, holds });
const view = (service, ...objectives) => ({ service, objectives });
const SPEND = {
  id: "q-spend",
  question:
    "Model spend reached 12,000,000 of the 12,000,000 tokens this Objective may spend",
  options: [{ answer: "more" }, { answer: "cancel" }],
  askedAt: "2031-03-04T10:00:00.000Z",
};
const REVIEW = {
  id: "q-review",
  question: "The reviewer needs your judgment on the query API's result",
  options: [{ answer: "accept" }, { answer: "retry" }],
  askedAt: "2031-03-04T11:00:00.000Z",
};

/** A run directory whose record runs the stand-in with `stand` (run, status, answer). */
function runDir(name, stand) {
  const at = join(dir, name);
  mkdirSync(at);
  const record = {
    runId: name,
    label: name,
    group: name,
    repository: "acme/widgets",
    issue: 42,
    stateDir: FIXTURE_STATE,
    definitionFile: EXAMPLE,
    resultsDir: join(at, "results"),
    factory: { kind: "release", cli: CLI },
  };
  writeFileSync(join(at, "run.json"), JSON.stringify(record));
  standIn(at, stand);
  return at;
}

/** Point a run's stand-in at `stand`, keeping what the run recorded. */
function standIn(at, { run = "follow", status, answer = "ok" }) {
  const file = join(at, "run.json");
  const record = JSON.parse(readFileSync(file, "utf8"));
  // The stand-in sees these only through the record's environment.
  record.env = {
    BENCH_FACTORY_RUN: run,
    BENCH_FACTORY_STATUS: JSON.stringify(status),
    BENCH_FACTORY_ANSWER: answer,
    BENCH_FACTORY_CALLS: join(at, "calls.jsonl"),
  };
  writeFileSync(file, JSON.stringify(record));
}

/** `node bench/run.mjs --run-dir AT`, polling every 10 ms, without the environment's bench home. */
function benchRun(at, ...args) {
  const env = { ...process.env };
  delete env[HOME_ENV];
  return spawnSync(
    process.execPath,
    [
      join(BENCH_DIR, "run.mjs"),
      ...args,
      "--run-dir",
      at,
      "--interval",
      "0.01",
    ],
    { encoding: "utf8", env, timeout: 60_000 },
  );
}

const lines = (file) =>
  existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
const events = (at) =>
  lines(join(at, "decisions.jsonl")).map((entry) => entry.event);
const calls = (at) => lines(join(at, "calls.jsonl"));
const recorded = (at) => JSON.parse(readFileSync(join(at, "run.json"), "utf8"));

test("factory run is stopped once status shows the Objective admitted, and the run is followed by status through a restart to its end", () => {
  const at = runDir("follow", {
    status: [
      // While queuing: not yet admitted, a restart, then admitted.
      view("running"),
      { exit: 1, error: "Error: ENOENT: no such file or directory" },
      view("running", objective("building")),
      // Following.
      { exit: 1, error: "Error: ENOENT: no such file or directory" },
      view("stopped", objective("building")),
      view("running", objective("building", [SPEND])),
      view("running", objective("done")),
    ],
  });
  const run = benchRun(at);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /#42 done; scored into /);
  // The follower printed Queued and was stopped as Ctrl-C stops it, only
  // after the third status showed the Objective admitted.
  const made = calls(at);
  assert.deepEqual(
    made.slice(0, 5).map((call) => call.signal ?? call.command),
    ["run", "status", "status", "status", "SIGINT"],
  );
  assert.deepEqual(
    made.filter((call) => call.command === "run"),
    [
      { command: "run", args: ["42"] },
      { command: "run", args: ["42"], signal: "SIGINT" },
    ],
  );
  assert.ok(recorded(at).queuedAt);
  // A failed status is the service seen down, until one reads it running.
  assert.match(run.stderr, /status failed, trying again: factory: Error/);
  assert.deepEqual(events(at), [
    "queued",
    "service-down",
    "service-up",
    "answered",
    "ended",
  ]);
  assert.deepEqual(made.find((call) => call.command === "answer").args, [
    "42",
    "more",
    "--question",
    "q-spend",
    "--as",
    POLICY_AS,
  ]);
  assert.ok(existsSync(join(at, "results", "acme-widgets-42", "follow.json")));
});

test("a follower that ends on an open hold queued the Objective, and a rerun doesn't queue it again", () => {
  const at = runDir("hold", {
    run: "hold",
    status: [view("running", objective("building", [REVIEW]))],
  });
  const run = benchRun(at);
  assert.equal(run.status, 2, run.stderr);
  assert.match(run.stdout, /PAUSED for the operator: review hold q-review/);
  assert.ok(recorded(at).queuedAt);
  assert.deepEqual(events(at), ["queued", "paused"]);
  const again = benchRun(at);
  assert.equal(again.status, 2, again.stderr);
  assert.equal(calls(at).filter((call) => call.command === "run").length, 1);
  assert.deepEqual(events(at), ["queued", "paused"]);
});

test("no service running is reported, not queued, and the next run queues it", () => {
  const at = runDir("no-service", {
    run: "no-service",
    status: [view("running", objective("done"))],
  });
  const run = benchRun(at);
  assert.equal(run.status, 75, run.stderr);
  assert.match(
    run.stderr,
    /The service isn't running, so #42 isn't queued: start it/,
  );
  assert.equal(recorded(at).queuedAt, undefined);
  assert.deepEqual(events(at), ["service-down"]);
  assert.ok(!calls(at).some((call) => call.command === "status"));
  // Started: queued, and the service seen up again.
  standIn(at, {
    status: [
      view("running", objective("building")),
      view("running", objective("done")),
    ],
  });
  const started = benchRun(at);
  assert.equal(started.status, 0, started.stderr);
  assert.ok(recorded(at).queuedAt);
  assert.deepEqual(events(at), [
    "service-down",
    "queued",
    "service-up",
    "ended",
  ]);
});

test("a request the service refuses after the Queued line is reported without a stack and not queued", () => {
  const at = runDir("refused", {
    run: "refused",
    // Never admitted: status doesn't show it.
    status: [view("running")],
  });
  const run = benchRun(at);
  assert.equal(run.status, 1, run.stderr);
  assert.match(
    run.stderr,
    /^factory run 42 didn't queue it \(exit 1\): factory: The queue is paused, so #42 isn't admitted/,
  );
  assert.doesNotMatch(run.stderr, /\n\s+at /);
  assert.equal(recorded(at).queuedAt, undefined);
  assert.deepEqual(events(at), []);
  // Looked for the admission while waiting, and never stopped the follower.
  const made = calls(at);
  assert.ok(made.some((call) => call.command === "status"));
  assert.ok(!made.some((call) => call.signal));
});

test("a refused policy answer is recorded, and a hold still open after it pauses for the operator", () => {
  const at = runDir("answer-refused", {
    answer: "refused",
    status: [view("running", objective("building", [SPEND]))],
  });
  const run = benchRun(at);
  assert.equal(run.status, 2, run.stderr);
  assert.match(
    run.stderr,
    /The policy's more to q-spend was refused: factory: #42 has no open question q-spend/,
  );
  assert.match(run.stdout, /PAUSED for the operator: spend hold q-spend/);
  assert.match(run.stdout, /The policy's more was refused/);
  assert.equal(calls(at).filter((call) => call.command === "answer").length, 1);
  assert.deepEqual(events(at), ["queued", "answer-refused", "paused"]);
  // The operator's answer, refused too, isn't recorded and exits with Factory's code.
  const answered = benchRun(at, "answer", "more", "--question", "q-spend");
  assert.equal(answered.status, 1);
  assert.match(answered.stderr, /no open question q-spend/);
  assert.deepEqual(events(at), ["queued", "answer-refused", "paused"]);
});
