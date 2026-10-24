// Input checked where it enters: request files and state files that the
// service can't take are refused or held, and never stop the loop.
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  cli,
  closedPort,
  configured,
  installation,
  item,
  plan,
  refusal,
  seed,
  serve,
  stateOf,
  status,
  stopped,
  until,
} from "./helpers.mjs";

/** Issue `issue`'s logged `event`s, over every run. */
const logged = (inst, issue, event) => {
  const dir = join(inst.logs, String(issue));
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".jsonl"))
    .flatMap((name) =>
      readFileSync(join(dir, name), "utf8").split("\n").filter(Boolean),
    )
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.event === event);
};

const result = (inst, id) =>
  JSON.parse(readFileSync(join(inst.requests, `${id}.result`), "utf8"));

test("a request file that can't be taken moves aside and is refused; the rest still apply", async () => {
  const inst = installation();
  seed(inst, 8);
  mkdirSync(inst.requests, { recursive: true });
  // Sorted first, so the good request after them shows they stop nothing.
  writeFileSync(join(inst.requests, "0-garbled.json"), "{ not json");
  writeFileSync(
    join(inst.requests, "0-shape.json"),
    JSON.stringify({
      id: "0-shape",
      at: new Date().toISOString(),
      by: "someone",
      request: { kind: "cancel", issue: "8" },
    }),
  );
  const service = serve(inst);
  await until(() => status(inst).service === "running", "service");
  assert.equal(cli(inst, "cancel", "8").code, 0);
  assert.equal(stateOf(inst, 8).status, "cancelled");
  for (const id of ["0-garbled", "0-shape"]) {
    assert.equal(result(inst, id).code, "invalid_request");
    assert.ok(existsSync(join(inst.requests, "rejected", `${id}.json`)), id);
  }
  assert.match(result(inst, "0-shape").message, /issue "8" isn't an issue/);
  assert.deepEqual(
    readdirSync(inst.requests).filter((name) => name.endsWith(".json")),
    [],
  );
  await stopped(service);
});

test("a request whose apply fails is refused after one try, never retried", async () => {
  const inst = installation();
  // A state path the service can never read: every apply for #12 throws.
  mkdirSync(join(inst.objectives, "12.json"), { recursive: true });
  const service = serve(inst);
  await until(() => status(inst).service === "running", "service");
  const cancelled = cli(inst, "cancel", "12");
  assert.equal(cancelled.code, 1);
  assert.equal(refusal(cancelled), "request_failed");
  assert.match(cancelled.err, /EISDIR/);
  assert.deepEqual(
    readdirSync(inst.requests).filter((name) => name.endsWith(".json")),
    [],
  );
  await stopped(service);
});

test("a state file of the current version but another shape is unreadable, never a crash", async () => {
  const inst = installation();
  seed(inst, 9, "holding", { holds: "none" });
  seed(inst, 10);
  const service = serve(inst);
  await until(() => status(inst).service === "running", "service");
  const rows = status(inst).objectives;
  const broken = rows.find((row) => row.issue === 9);
  assert.equal(broken.status, "unreadable");
  assert.match(broken.error, /holds isn't a list/);
  assert.deepEqual(
    broken.holds[0].options.map((option) => option.answer),
    ["reset", "cancel"],
  );
  // The other Objective runs on.
  assert.notEqual(rows.find((row) => row.issue === 10).status, "unreadable");
  assert.equal(cli(inst, "cancel", "9").code, 0);
  await until(() => stateOf(inst, 9).status === "cancelled", "cancelled");
  assert.equal(service.child.exitCode, null, "the service still runs");
  await stopped(service);
});

test("a plan the service can't run is unreadable at load; the other Objective runs on", async () => {
  const inst = installation();
  // GitHub is down: #12's check runs and waits on it.
  configured(inst, `http://127.0.0.1:${await closedPort()}`);
  // Saved without its final commands (undefined isn't written).
  seed(inst, 11, "building", {
    done: { check: {}, plan: plan([item("a")], { finalCommands: undefined }) },
    kept: { "plan:acceptedAt": "2026-01-01T00:00:00.000Z" },
  });
  seed(inst, 12);
  const service = serve(inst);
  await until(() => stateOf(inst, 12).retries.check, "#12's check runs");
  const broken = status(inst).objectives.find((row) => row.issue === 11);
  assert.equal(broken.status, "unreadable");
  assert.match(broken.error, /done\.plan\.finalCommands isn't a list/);
  assert.deepEqual(
    broken.holds[0].options.map((option) => option.answer),
    ["reset", "cancel"],
  );
  assert.equal(cli(inst, "cancel", "11").code, 0);
  await until(() => stateOf(inst, 11).status === "cancelled", "cancelled");
  assert.equal(service.child.exitCode, null, "the service still runs");
  assert.equal(cli(inst, "cancel", "12").code, 0);
  await stopped(service);
});

test("an Objective whose work keeps throwing is set aside with retry, reset and cancel; the others run on", async () => {
  const inst = installation();
  // GitHub is down: #12's check runs and waits on it.
  configured(inst, `http://127.0.0.1:${await closedPort()}`);
  // Each loads (a kept value is its module's to check), but reading its
  // plan throws, on every tick.
  for (const issue of [11, 13])
    seed(inst, issue, "checking", { kept: { "amend:x:proposal": null } });
  seed(inst, 12);
  let service = serve(inst);
  await until(
    () => logged(inst, 11, "objective-set-aside").length === 1,
    "#11 is set aside",
  );
  assert.ok(logged(inst, 11, "objective-error").length >= 10);
  await until(() => stateOf(inst, 12).retries.check, "#12's check runs");
  const row = (issue) =>
    status(inst).objectives.find((entry) => entry.issue === issue);
  await until(() => row(11).status === "unreadable", "status shows it");
  assert.match(row(11).error, /failed 10 ticks in a row/);
  assert.deepEqual(
    row(11).holds[0].options.map((option) => option.answer),
    ["retry", "reset", "cancel"],
  );
  // Cancel answers it with a cancelled record.
  await until(() => row(13).status === "unreadable", "#13 is set aside");
  assert.equal(cli(inst, "cancel", "13").code, 0);
  await until(() => stateOf(inst, 13).status === "cancelled", "cancelled");
  // A restart reads its file again: it throws again, and is set aside again.
  await stopped(service);
  service = serve(inst);
  await until(
    () => logged(inst, 11, "objective-set-aside").length === 2,
    "#11 is set aside again",
  );
  // Mended meanwhile (nothing writes a set-aside file): `retry` reads it
  // again, and it runs on.
  seed(inst, 11);
  assert.equal(cli(inst, "retry", "11").code, 0);
  await until(() => stateOf(inst, 11).retries.check, "#11's check runs");
  assert.equal(row(11).status, "checking");
  assert.equal(service.child.exitCode, null, "the service still runs");
  for (const issue of ["11", "12"])
    assert.equal(cli(inst, "cancel", issue).code, 0);
  await stopped(service);
});

test("saves that fail for a while are tried again, never set aside", {
  skip: process.getuid?.() === 0 && "root writes any directory",
}, async () => {
  const inst = installation();
  configured(inst, `http://127.0.0.1:${await closedPort()}`);
  seed(inst, 12);
  const service = serve(inst);
  await until(() => stateOf(inst, 12).retries.check, "#12's check runs");
  // No state can be saved for a while: each tick's start of the check fails.
  chmodSync(inst.objectives, 0o555);
  await until(
    () => logged(inst, 12, "objective-error").length >= 10,
    "ten failed ticks",
  );
  chmodSync(inst.objectives, 0o755);
  // The start that kept failing is made at once.
  const { attempts } = stateOf(inst, 12).retries.check;
  await until(
    () => stateOf(inst, 12).retries.check.attempts > attempts,
    "#12's check runs again",
  );
  assert.deepEqual(logged(inst, 12, "objective-set-aside"), []);
  assert.equal(cli(inst, "cancel", "12").code, 0);
  await stopped(service);
});
