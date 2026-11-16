// #414: the fix-pass fence keeps its exact lists as the trigger; a fenced toolchain file goes only when the fence check
// (lib/fence-check.mjs, a decision call) judges its change part of fixing the red. Real outbox, real git, real holdScope;
// the decider is a fake vendor, or the stage's harness as a fake CLI on PATH.
import "./temp.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FENCE_QUESTION, fenceInput, openFenceCheck } from "../scripts/lib/fence-check.mjs";
import { USAGE_LIMIT } from "../scripts/lib/harness.mjs";
import { decideExit, fixScopeReason, setupPaths } from "../scripts/lib/logic.mjs";
import { openOutbox } from "../scripts/lib/outbox.mjs";
import { holdScope } from "../scripts/lib/session.mjs";

const quiet = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

/** An origin whose main holds `files`, and the agent's clone on factory/1. */
function repos(files) {
  const root = mkdtempSync(join(tmpdir(), "factory-fence-"));
  const origin = join(root, "origin.git");
  const work = join(root, "work");
  const run = (...a) => execFileSync("git", ["-C", work, "-c", "user.email=t@t", "-c", "user.name=t", ...a], { encoding: "utf8", env: { ...process.env, ...quiet } }).trim();
  const put = (file, text) => {
    mkdirSync(join(work, file, ".."), { recursive: true });
    writeFileSync(join(work, file), text);
    run("add", file);
  };
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  execFileSync("git", ["clone", "-q", origin, work], { env: { ...process.env, ...quiet } });
  for (const [f, t] of Object.entries({ "app.txt": "v1\n", ...files })) put(f, t);
  run("commit", "-q", "-m", "base");
  run("push", "-q", "origin", "HEAD:main");
  run("checkout", "-q", "-b", "factory/1");
  const commit = (changes, msg = "change") => {
    for (const [f, t] of Object.entries(changes)) put(f, t);
    run("commit", "-q", "-m", msg);
  };
  return { root, origin, work, run, commit };
}

/** The repository after the work stage: its first push made, then the first fix pass fenced. */
async function fenced(r, extra = {}, fence = {}) {
  const box = await openOutbox({ branch: "factory/1", defaultBranch: "main", checkout: r.work, remote: r.origin, agentEnv: { ...process.env, ...quiet }, protectedList: [".github/"], base: r.root, ...extra });
  r.commit({ "app.txt": "v2\n" }, "work");
  assert.equal(await box.push(), true, box.error);
  await box.fence({ plan: "1. owns `app.txt`", texts: ["FAIL app.txt:1 expected v3"], lead: "--- test: FAIL app.txt:1 expected v3", ...fence });
  return box;
}

/** A fake vendor answering `answer(input)` and keeping each input. */
const vendor = (answer) => {
  const asked = [];
  return { asked, decider: { name: "fake", decide: async (input, question) => (asked.push({ input, question }), answer(input)) } };
};

test("#414: a fenced toolchain change the fence check judges part of the fix goes; one judged to weaken the check stays refused", async () => {
  const r = repos({ "package.json": "{}\n", "package-lock.json": "{}\n", "web/yarn.lock": "#\n" });
  const v = vendor((input) => (input.includes("web/yarn.lock") ? { verdict: "weakens", confidence: 0.95 } : { verdict: "fix", confidence: 0.9 }));
  const box = await fenced(r, {}, { comments: [{ path: "app.txt", line: 1, body: "the lockfile is stale" }] });
  box.fenceCheck = openFenceCheck({ decider: v.decider });
  // The lockfile alone, its manifest neither changed nor named: fenced, then judged part of the fix.
  r.commit({ "app.txt": "v3\n", "package-lock.json": '{"lockfileVersion":3}\n' }, "fix");
  assert.deepEqual(await box.outside(), []);
  assert.equal(v.asked.length, 1);
  const { input, question } = v.asked[0];
  assert.equal(question, FENCE_QUESTION);
  const tag = /<<<BEGIN ([0-9a-f]+)>>>/.exec(input)[1];
  assert.equal(input.split(`<<<BEGIN ${tag}>>>`).length - 1, 5, "path, diff, failure lines, comments and plan, each fenced as data");
  for (const part of ["package-lock.json", '+{"lockfileVersion":3}', "--- test: FAIL app.txt:1 expected v3", "app.txt:1: the lockfile is stale", "1. owns `app.txt`"]) assert.ok(input.includes(part), part);
  assert.equal(await box.push(), true, box.error);
  assert.equal(v.asked.length, 1, "the same change is not asked about again at the push");
  // A lockfile judged to weaken the check: refused, with what the check said; the work's Block.
  r.commit({ "web/yarn.lock": "# pinned below the fix\n" }, "relock");
  const before = execFileSync("git", ["-C", r.origin, "rev-parse", "factory/1"], { encoding: "utf8" }).trim();
  assert.equal(await box.push(), false);
  assert.match(box.error, /^a fix pass changed web\/yarn\.lock \(toolchain, lockfile or CI configuration\), which neither the plan nor the failing check names; the fence check: web\/yarn\.lock: judged to weaken or sidestep the check at 0\.95/);
  assert.equal(box.errorCause, null);
  assert.deepEqual(box.fenceVerdict().told, ["web/yarn.lock: judged to weaken or sidestep the check"], "the worker is told the verdict, not the confidence");
  assert.equal(execFileSync("git", ["-C", r.origin, "rev-parse", "factory/1"], { encoding: "utf8" }).trim(), before);
});

test("#414: only a lockfile is asked about; pins, CI, containers, package-manager configuration, protected and setup files never are", async () => {
  const setup = "bash scripts/setup.sh";
  const r = repos({ "scripts/setup.sh": "echo ok\n", ".gitlab-ci.yml": "test: {}\n", ".npmrc": "\n", "Dockerfile": "FROM node:22\n", ".nvmrc": "22\n", "package-lock.json": "{}\n", "toolchain/zig.sh": "zig\n" });
  const v = vendor(() => ({ verdict: "fix", confidence: 1 }));
  const box = await fenced(r, { setup, toolchain: setupPaths({ setup, install: "none" }), protectedList: [".github/", "/.npmrc"], toolchainPaths: ["toolchain/"] });
  box.fenceCheck = openFenceCheck({ decider: v.decider });
  r.commit({ "app.txt": "v3\n", ".gitlab-ci.yml": "test: { allow_failure: true }\n", ".npmrc": "ignore-scripts=true\n", "Dockerfile": "FROM node:18\n", ".nvmrc": "18\n", "scripts/setup.sh": "true\n", "package-lock.json": '{"v":2}\n', "toolchain/zig.sh": "zig 0.14\n" }, "fix");
  assert.deepEqual(await box.outside(), [".gitlab-ci.yml", ".npmrc", ".nvmrc", "Dockerfile", "scripts/setup.sh", "toolchain/zig.sh"], "the lockfile goes on its yes; the rest stays");
  assert.deepEqual(v.asked.map((a) => /<<<BEGIN \w+>>>\n(.*)\n/.exec(a.input)[1]), ["package-lock.json"]);
  // At the push the setup guard refuses first, as hard as before.
  assert.equal(await box.push(), false);
  assert.equal(box.errorKind, "protected");
});

test("#414: a lockfile the pass created or deleted is never asked about: it can change which install runs", async () => {
  const r = repos({ "package.json": "{}\n", "package-lock.json": "{}\n" });
  const v = vendor(() => ({ verdict: "fix", confidence: 1 }));
  const box = await fenced(r);
  box.fenceCheck = openFenceCheck({ decider: v.decider });
  r.commit({ "pnpm-lock.yaml": "lockfileVersion: '9.0'\n" }, "a new lockfile");
  r.run("rm", "-q", "package-lock.json");
  r.run("commit", "-q", "-m", "and the old one gone");
  assert.deepEqual(await box.outside(), ["package-lock.json", "pnpm-lock.yaml"]);
  assert.equal(v.asked.length, 0);
  assert.deepEqual(box.fenceVerdict().judged, ["package-lock.json: not judged (created or deleted by the pass)", "pnpm-lock.yaml: not judged (created or deleted by the pass)"]);
});

test("#414: no answer refuses as Factory's or an outage's Block only when every refused file is undecided; a refusal to judge is the work's", async () => {
  const r = repos({ "package.json": "{}\n", "package-lock.json": "{}\n", "a/yarn.lock": "#\n", "b/yarn.lock": "#\n" });
  const v = vendor((input) => (input.includes("b/yarn.lock") ? { verdict: "weakens", confidence: 0.9 } : input.includes("a/yarn.lock") ? { verdict: null, confidence: null, error: "refused" } : { verdict: null, confidence: null, error: "unavailable" }));
  const box = await fenced(r);
  box.fenceCheck = openFenceCheck({ decider: v.decider });
  r.commit({ "app.txt": "v3\n", "package-lock.json": '{"v":2}\n' }, "fix");
  assert.deepEqual(await box.outside(), ["package-lock.json"]);
  assert.deepEqual(box.fenceVerdict().undecided, ["package-lock.json"]);
  assert.equal(box.fenceCause(["package-lock.json"]), "outage");
  // Mixed with a file judged to weaken the check, or one the model refused to judge: the work's.
  r.commit({ "b/yarn.lock": "# b\n" }, "b");
  assert.deepEqual(await box.outside(), ["b/yarn.lock", "package-lock.json"]);
  assert.equal(box.fenceCause(["b/yarn.lock", "package-lock.json"]), null);
  r.commit({ "b/yarn.lock": "#\n", "a/yarn.lock": "# a\n" }, "a");
  assert.deepEqual(await box.outside(), ["a/yarn.lock", "package-lock.json"]);
  assert.match(box.fenceVerdict().judged.join("\n"), /a\/yarn\.lock: the decision model \(.*\) refused to judge its change/);
  assert.equal(box.fenceCause(["a/yarn.lock", "package-lock.json"]), null);
  assert.equal(await box.push(), false);
  assert.equal(box.errorCause, null);
  assert.equal(decideExit({ harness: { ok: true }, pr: { exists: true }, commits: 2, pushRejected: box.error, pushCause: box.errorCause }).cause, "work");
  // Undecided alone at the push: asked again (no answer is kept), and the Block is the outage's.
  const r2 = repos({ "package.json": "{}\n", "package-lock.json": "{}\n" });
  const v2 = vendor(() => ({ verdict: null, confidence: null, error: "unavailable" }));
  const box2 = await fenced(r2);
  box2.fenceCheck = openFenceCheck({ decider: v2.decider });
  r2.commit({ "package-lock.json": '{"v":2}\n' }, "relock");
  assert.deepEqual(await box2.outside(), ["package-lock.json"]);
  assert.equal(await box2.push(), false);
  assert.equal(v2.asked.length, 2, "no verdict is kept: the push asks again");
  assert.equal(box2.errorCause, "outage");
  assert.equal(decideExit({ harness: { ok: true }, pr: { exists: true }, commits: 2, pushRejected: box2.error, pushCause: box2.errorCause }).cause, "outage");
});

test("#414: what is not judged: a change over the bound, a binary or empty change, a symlink, past the cap of 10 files, an unreadable setup guard", async () => {
  const r = repos({ "package.json": "{}\n", "package-lock.json": "{}\n", "bun.lockb": "a\n", "web/package-lock.json": "{}\n" });
  const v = vendor(() => ({ verdict: "fix", confidence: 1 }));
  const box = await fenced(r);
  box.fenceCheck = openFenceCheck({ decider: v.decider });
  r.commit({ "package-lock.json": `${"x".repeat(40 * 1024)}\n`, "bun.lockb": "\u0000\u0001binary\n" }, "relock");
  r.run("rm", "-q", "web/package-lock.json");
  mkdirSync(join(r.work, "web"), { recursive: true });
  symlinkSync("../package-lock.json", join(r.work, "web/package-lock.json"));
  r.run("add", "web/package-lock.json");
  r.run("commit", "-q", "-m", "link");
  assert.deepEqual(await box.outside(), ["bun.lockb", "package-lock.json", "web/package-lock.json"]);
  assert.equal(v.asked.length, 0);
  assert.deepEqual(box.fenceVerdict().judged, ["bun.lockb: not judged (no textual change to read)", "package-lock.json: not judged (a change over 32 KiB)", "web/package-lock.json: not judged (not a regular file)"]);
  // The cap: ten files asked about, the rest not judged.
  const r2 = repos({ "package.json": "{}\n", ...Object.fromEntries(Array.from({ length: 12 }, (_, k) => [`d${String(k).padStart(2, "0")}/yarn.lock`, "#\n"])) });
  const v2 = vendor(() => ({ verdict: "weakens", confidence: 1 }));
  const box2 = await fenced(r2);
  box2.fenceCheck = openFenceCheck({ decider: v2.decider });
  r2.commit(Object.fromEntries(Array.from({ length: 12 }, (_, k) => [`d${String(k).padStart(2, "0")}/yarn.lock`, "# relocked\n"])), "relock all");
  assert.equal((await box2.outside()).length, 12);
  assert.equal(v2.asked.length, 10);
  assert.deepEqual(box2.fenceVerdict().judged.filter((j) => j.includes("over the cap")), ["d10/yarn.lock: not judged (over the cap of 10 files)", "d11/yarn.lock: not judged (over the cap of 10 files)"]);
  assert.match(fixScopeReason(["d10/yarn.lock", "d11/yarn.lock"], [], box2.fenceVerdict().judged), /the fence check: d10\/yarn\.lock: not judged \(over the cap of 10 files\); d11\/yarn\.lock: not judged \(over the cap of 10 files\);/);
  // A setup guard that cannot be read: nothing is judged.
  const r3 = repos({ "package.json": "{}\n", "package-lock.json": "{}\n" });
  const v3 = vendor(() => ({ verdict: "fix", confidence: 1 }));
  const box3 = await fenced(r3, { setup: "npm ci" });
  box3.fenceCheck = openFenceCheck({ decider: v3.decider });
  box3.setupFiles = async () => {
    throw new Error("tree unreadable");
  };
  r3.commit({ "package-lock.json": '{"v":2}\n' }, "relock");
  assert.deepEqual(await box3.outside(), ["package-lock.json"]);
  assert.equal(v3.asked.length, 0);
});

test("#414: a path is read literally: pathspec magic in a file name shows the decider that file's change alone", async () => {
  const r = repos({ "package.json": "{}\n" });
  const name = ":!x/yarn.lock";
  mkdirSync(join(r.work, ":!x"));
  writeFileSync(join(r.work, name), "#\n");
  r.run("add", "-A");
  r.run("commit", "-q", "-m", "magic name");
  r.run("push", "-q", "origin", "HEAD:main");
  const v = vendor(() => ({ verdict: "weakens", confidence: 1 }));
  const box = await fenced(r);
  box.fenceCheck = openFenceCheck({ decider: v.decider });
  writeFileSync(join(r.work, name), "# relocked\n");
  writeFileSync(join(r.work, "app.txt"), "SECRET-OTHER-CHANGE\n");
  r.run("add", "-A");
  r.run("commit", "-q", "-m", "fix");
  assert.deepEqual(await box.outside(), [name]);
  assert.equal(v.asked.length, 1);
  assert.ok(v.asked[0].input.includes("+# relocked"));
  assert.ok(!v.asked[0].input.includes("SECRET-OTHER-CHANGE"), "no other file's change");
});

test("#414: a yes holds for that change and that question; a changed file or another red asks again; a file refused twice is not asked again", async () => {
  const r = repos({ "package.json": "{}\n", "package-lock.json": "{}\n", "yarn.lock": "#\n" });
  // The lockfile beside package.json is judged part of the fix; yarn.lock not.
  const v = vendor((input) => (input.includes("yarn.lock") ? { verdict: "unrelated", confidence: 1 } : { verdict: "fix", confidence: 1 }));
  const yarn = () => v.asked.filter((a) => a.input.includes("yarn.lock")).length;
  const box = await fenced(r);
  box.fenceCheck = openFenceCheck({ decider: v.decider });
  r.commit({ "package-lock.json": '{"v":2}\n' }, "a");
  assert.deepEqual(await box.outside(), []);
  assert.deepEqual(await box.outside(), []);
  assert.equal(v.asked.length, 1, "the same change and question: asked once");
  r.commit({ "package-lock.json": '{"v":3}\n' }, "b");
  assert.deepEqual(await box.outside(), []);
  assert.equal(v.asked.length, 2, "a changed file is asked about again");
  await box.fence({ lead: "--- test: another red" });
  assert.deepEqual(await box.outside(), []);
  assert.equal(v.asked.length, 3, "another red asks again");
  // Refused: the same change is not asked again; a new one once more; after two refusals, none.
  r.commit({ "yarn.lock": "# 1\n" }, "y1");
  assert.deepEqual(await box.outside(), ["yarn.lock"]);
  assert.deepEqual(await box.outside(), ["yarn.lock"]);
  await box.fence({ lead: "--- test: a third red" });
  assert.deepEqual(await box.outside(), ["yarn.lock"]);
  assert.equal(yarn(), 1, "a refused change is not asked again, whatever the red");
  r.commit({ "yarn.lock": "# 2\n" }, "y2");
  assert.deepEqual(await box.outside(), ["yarn.lock"]);
  assert.equal(yarn(), 2);
  r.commit({ "yarn.lock": "# 3\n" }, "y3");
  assert.deepEqual(await box.outside(), ["yarn.lock"]);
  assert.equal(yarn(), 2);
  assert.deepEqual(box.fenceVerdict().judged, ["yarn.lock: not judged (judged twice already in this stage)"]);
});

/** A stage whose harness (a fake claude on PATH) answers every call with its usage limit; `calls()` counts its runs. */
function limitedStage() {
  const bin = mkdtempSync(join(tmpdir(), "factory-fence-claude-"));
  const fixture = join(import.meta.dirname, "fixtures", "claude-2.1.323-usage-limit.jsonl");
  const log = join(bin, "calls");
  writeFileSync(join(bin, "claude"), `#!/bin/sh\necho call >> '${log}'\ncat >/dev/null\ncat '${fixture}'\nexit 1\n`, { mode: 0o755 });
  const stage = { harness: "claude", model: "m-1", env: { HOME: homedir(), PATH: `${bin}:${process.env.PATH}`, TMPDIR: process.env.TMPDIR, CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-dummy" }, record: () => {} };
  return { stage, calls: () => readFileSync(log, "utf8").trim().split("\n").length };
}

test("#414: the stage harness's usage limit in the fence check ends the stage through UsageLimitReached, with nothing of the pass pushed and no corrective turn", async () => {
  const { stage, calls } = limitedStage();
  const r = repos({ "package.json": "{}\n", "package-lock.json": "{}\n" });
  const box = await fenced(r);
  box.fenceCheck = openFenceCheck({ inputs: {}, env: {}, stage });
  r.commit({ "app.txt": "v3\n", "package-lock.json": '{"v":2}\n' }, "fix");
  const pass = { outbox: box, session: { id: null, canResume: false }, harness: "claude", model: "m-1", taskCard: "card", cwd: r.work, env: stage.env, eventsFile: join(r.root, "events.jsonl"), deadlineAt: Date.now() + 3_600_000, maxUsd: 0, label: "validation-scope-1" };
  await assert.rejects(holdScope(pass), (e) => e.code === USAGE_LIMIT && e.refusal.harness === "claude");
  assert.equal(calls(), 1, "the decision call only: no corrective turn ran");
  assert.equal(box.failed, true);
  assert.match(box.error, /^the fence check met claude's usage limit; nothing of the fix pass was pushed/);
  assert.equal(await box.push(), false, "nothing goes out after it");
});

test("#414: a usage limit met in the fence check at the push pauses the stage the same way, never a refusal of the work", async () => {
  const { stage } = limitedStage();
  const r = repos({ "package.json": "{}\n", "package-lock.json": "{}\n" });
  const box = await fenced(r);
  box.fenceCheck = openFenceCheck({ inputs: {}, env: {}, stage });
  r.commit({ "app.txt": "v3\n", "package-lock.json": '{"v":2}\n' }, "fix");
  const before = execFileSync("git", ["-C", r.origin, "rev-parse", "factory/1"], { encoding: "utf8" }).trim();
  await assert.rejects(box.push(), (e) => e.code === USAGE_LIMIT);
  assert.equal(box.errorKind, "");
  assert.match(box.error, /^the fence check met claude's usage limit/);
  assert.equal(execFileSync("git", ["-C", r.origin, "rev-parse", "factory/1"], { encoding: "utf8" }).trim(), before);
});

test("#414: the question's input is fenced; a missing failure or comment says so; an empty change is never asked about", async () => {
  const input = fenceInput({ path: ".nvmrc", diff: "@@ -1 +1 @@\n-22\n+18", lead: "", comments: [], plan: "" }, "abc");
  for (const s of ["(none: the pass answers review comments)", "The review comments the pass answers:\n<<<BEGIN abc>>>\n(none)", "+18"]) assert.ok(input.includes(s), s);
  const v = vendor(() => ({ verdict: "fix", confidence: 1 }));
  assert.deepEqual(await openFenceCheck({ decider: v.decider }).judge({ path: ".nvmrc", diff: " \n" }), { allow: false, why: ".nvmrc: not judged (no textual change to read)", told: ".nvmrc: not judged (no textual change to read)" });
  assert.equal(v.asked.length, 0);
  assert.equal(openFenceCheck({ inputs: { decisionRoute: "off" } }).off, "route-off");
  // The floor is triage_min_confidence while the gateway's triage_model answers (triage.mjs confidenceFloor), else 0.7.
  const item = { path: ".nvmrc", diff: "@@ -1 +1 @@\n-22\n+18" };
  const at = (name) => ({ name, decide: async () => ({ verdict: "fix", confidence: 0.9 }) });
  assert.equal((await openFenceCheck({ decider: at("ai-gateway") }).judge(item)).allow, true);
  const strict = await openFenceCheck({ inputs: { triageMinConfidence: 0.95 }, decider: at("ai-gateway") }).judge(item);
  assert.equal(strict.allow, false);
  assert.match(strict.why, /under 0\.95/);
  assert.equal((await openFenceCheck({ inputs: { triageMinConfidence: 0.95 }, decider: at("harness") }).judge(item)).allow, true, "another model than the setting's: the default floor");
  // A lower setting cannot weaken this gate: never under 0.7.
  const low = { name: "ai-gateway", decide: async () => ({ verdict: "fix", confidence: 0.6 }) };
  const lowered = await openFenceCheck({ inputs: { triageMinConfidence: 0.5 }, decider: low }).judge(item);
  assert.equal(lowered.allow, false);
  assert.match(lowered.why, /under 0\.7/);
});
