import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKENDS, backend } from "../scripts/lib/backend.mjs";
import { trustedAuthor } from "../scripts/lib/logic.mjs";

const issue = (...labels) => ({ labels: labels.map((name) => ({ name })) });

test("backend: FACTORY_LOCAL=1 picks local, anything else the Action's runner", () => {
  assert.equal(backend({ FACTORY_LOCAL: "1" }).name, "local");
  assert.equal(backend({}).name, "actions");
  assert.equal(backend({ FACTORY_LOCAL_SANDBOX: "{}" }).name, "local", "sandbox settings alone still mean local");
});

test("trigger: the Action takes unlabelled Objectives, a local loop the factory:local ones (or all with FACTORY_LOCAL_ALL)", () => {
  assert.equal(BACKENDS.actions.trigger.routes(issue("factory:objective")), true);
  assert.equal(BACKENDS.actions.trigger.routes(issue("factory:objective", "factory:local")), false);
  assert.equal(BACKENDS.local.trigger.routes(issue("factory:objective"), {}), false);
  assert.equal(BACKENDS.local.trigger.routes(issue("factory:objective", "factory:local"), {}), true);
  assert.equal(BACKENDS.local.trigger.routes(issue("factory:objective"), { FACTORY_LOCAL_ALL: "1" }), true);
});

test("sandbox and gate: local wraps Factory's commands in srt (and factory-db for validation), notes TMPDIR, runs commands first", async () => {
  const inner = ["bash", "-eo", "pipefail", "-c", "npm test"];
  assert.deepEqual(BACKENDS.actions.sandbox.command(inner, {}), ["bash", ["-eo", "pipefail", "-c", "npm test"]]);
  const env = { FACTORY_LOCAL: "1", FACTORY_LOCAL_SRT: "/s.json", FACTORY_LOCAL_DB: "1", FACTORY_DB_WRAP: "1", FACTORY_LOCAL_SANDBOX: JSON.stringify({ addDirs: [], clone: null }) };
  assert.deepEqual(BACKENDS.local.sandbox.command(inner, env), ["srt", ["-s", "/s.json", "--", "factory-db", ...inner]]);
  assert.deepEqual(BACKENDS.local.sandbox.command(inner, { ...env, FACTORY_DB_WRAP: "" }), ["srt", ["-s", "/s.json", "--", ...inner]]);
  assert.equal(BACKENDS.actions.sandbox.harness({ FACTORY_LOCAL_SANDBOX: "{}" }), null);
  assert.throws(() => BACKENDS.local.sandbox.harness({ FACTORY_LOCAL: "1" }), /unsandboxed/);
  assert.equal(BACKENDS.actions.sandbox.cardNotes(), "");
  assert.match(BACKENDS.local.sandbox.cardNotes({}), /\$TMPDIR/);
  assert.doesNotMatch(BACKENDS.local.sandbox.cardNotes({}), /factory-db/);
  assert.match(BACKENDS.local.sandbox.cardNotes({ FACTORY_LOCAL_DB: "1" }), /factory-db npm run test:db/);
  assert.deepEqual([BACKENDS.actions.gate.commandsFirst, BACKENDS.local.gate.commandsFirst], [false, true]);
  assert.equal(await BACKENDS.local.trigger.stepsAside(), false);
});

test("trustedAuthor: Factory acts on a marker only from an App or someone who can push", () => {
  assert.equal(trustedAuthor({ user: { type: "Bot", login: "clockgrove-factory[bot]" }, author_association: "NONE" }), true);
  for (const a of ["OWNER", "MEMBER", "COLLABORATOR"]) assert.equal(trustedAuthor({ user: { type: "User" }, author_association: a }), true);
  for (const a of ["NONE", "CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", "FIRST_TIMER", undefined]) assert.equal(trustedAuthor({ user: { type: "User" }, author_association: a }), false);
});

test("whichSync: a PATH scan, never a shell; names with separators or shell syntax resolve to nothing", async () => {
  const { whichSync } = await import("../scripts/lib/proc.mjs");
  assert.ok(whichSync("node"));
  for (const bad of ["node;touch /tmp/factory-which-probe", "$(id)", "../node", "/usr/bin/node", ""]) assert.equal(whichSync(bad), null);
});
