// #414: the fix-pass fence keeps its exact lists as the trigger; a fenced toolchain file goes only when the fence check
// (lib/fence-check.mjs, a decision call) judges its change part of fixing the red. Real outbox, real git, real holdScope;
// the decider is a fake vendor, or the stage's harness as a fake CLI on PATH.
import "./temp.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FENCE_QUESTION, fenceInput, openFenceCheck } from "../scripts/lib/fence-check.mjs";
import { setupPaths } from "../scripts/lib/logic.mjs";
import { openOutbox } from "../scripts/lib/outbox.mjs";

const quiet = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

/** An origin whose main holds `files`, and the agent's clone on pendulum/1. */
function repos(files) {
  const root = mkdtempSync(join(tmpdir(), "pendulum-fence-"));
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
  run("checkout", "-q", "-b", "pendulum/1");
  const commit = (changes, msg = "change") => {
    for (const [f, t] of Object.entries(changes)) put(f, t);
    run("commit", "-q", "-m", msg);
  };
  return { root, origin, work, run, commit };
}

/** The repository after the work stage: its first push made, then the first fix pass fenced. */
async function fenced(r, extra = {}, fence = {}) {
  const box = await openOutbox({ branch: "pendulum/1", defaultBranch: "main", checkout: r.work, remote: r.origin, agentEnv: { ...process.env, ...quiet }, protectedList: [".github/"], base: r.root, ...extra });
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
  const before = execFileSync("git", ["-C", r.origin, "rev-parse", "pendulum/1"], { encoding: "utf8" }).trim();
  assert.equal(await box.push(), false);
  assert.match(box.error, /^a fix pass changed web\/yarn\.lock \(toolchain, lockfile or CI configuration\), which neither the plan nor the failing check names; the fence check: web\/yarn\.lock: judged to weaken or sidestep the check at 0\.95/);
  assert.equal(box.errorCause, null);
  assert.deepEqual(box.fenceVerdict().told, ["web/yarn.lock: judged to weaken or sidestep the check"], "the worker is told the verdict, not the confidence");
  assert.equal(execFileSync("git", ["-C", r.origin, "rev-parse", "pendulum/1"], { encoding: "utf8" }).trim(), before);
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
