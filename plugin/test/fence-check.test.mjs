// #414: the fix-pass fence keeps its exact lists as the trigger; a fenced toolchain file goes only when the fence check
// (lib/fence-check.mjs, a decision call) judges its change part of fixing the red. Real outbox, real git, real holdScope;
// the decider is a fake vendor, or the stage's harness as a fake CLI on PATH.
import "./temp.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FENCE_QUESTION, fenceInput, openFenceCheck } from "../scripts/lib/fence-check.mjs";
import { USAGE_LIMIT } from "../scripts/lib/harness.mjs";
import { decideExit, setupPaths } from "../scripts/lib/logic.mjs";
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
  const r = repos({ "package.json": "{}\n", "package-lock.json": "{}\n", ".nvmrc": "22\n" });
  const v = vendor((input) => (input.includes(".nvmrc") ? { verdict: "weakens", confidence: 0.95 } : { verdict: "fix", confidence: 0.9 }));
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
  // A pin judged to weaken the check: refused, with what the check said; the work's Block.
  r.commit({ ".nvmrc": "18\n" }, "pin");
  const before = execFileSync("git", ["-C", r.origin, "rev-parse", "factory/1"], { encoding: "utf8" }).trim();
  assert.equal(await box.push(), false);
  assert.match(box.error, /^a fix pass changed \.nvmrc \(toolchain, lockfile or CI configuration\), which neither the plan nor the failing check names; the fence check: \.nvmrc: judged to weaken or sidestep the check at 0\.95/);
  assert.equal(box.errorCause, null);
  assert.equal(execFileSync("git", ["-C", r.origin, "rev-parse", "factory/1"], { encoding: "utf8" }).trim(), before);
});

test("#414: the checks' configuration, a protected path and what setup runs are refused with no question; `fix` under the floor is no", async () => {
  const setup = "bash scripts/setup.sh";
  const r = repos({ "scripts/setup.sh": "echo ok\n", ".gitlab-ci.yml": "test: {}\n", ".npmrc": "\n", "package-lock.json": "{}\n", "toolchain/zig.sh": "zig\n" });
  const v = vendor((input) => (input.includes("toolchain/zig.sh") ? { verdict: "fix", confidence: 0.5 } : { verdict: "fix", confidence: 1 }));
  const box = await fenced(r, { setup, toolchain: setupPaths({ setup }), protectedList: [".github/", "/.npmrc"], toolchainPaths: ["toolchain/"] });
  box.fenceCheck = openFenceCheck({ decider: v.decider });
  r.commit({ "app.txt": "v3\n", ".gitlab-ci.yml": "test: { allow_failure: true }\n", ".npmrc": "ignore-scripts=true\n", "scripts/setup.sh": "true\n", "package-lock.json": '{"v":2}\n', "toolchain/zig.sh": "zig 0.14\n" }, "fix");
  assert.deepEqual(await box.outside(), [".gitlab-ci.yml", ".npmrc", "scripts/setup.sh", "toolchain/zig.sh"], "the lockfile goes on its yes; the rest stays");
  assert.deepEqual(v.asked.map((a) => /<<<BEGIN \w+>>>\n(.*)\n/.exec(a.input)[1]), ["package-lock.json", "toolchain/zig.sh"], "asked only about the lockfile and the file on toolchain_paths");
  assert.match(box.fenceVerdict().judged.join("\n"), /toolchain\/zig\.sh: judged part of the fix at 0\.50, under 0\.7/);
  // At the push the setup guard refuses first, as hard as before.
  assert.equal(await box.push(), false);
  assert.equal(box.errorKind, "protected");
});

test("#414: no answer from the fence check refuses the file as Factory's or an outage's Block, asked again at the push; a change over the bound is not judged", async () => {
  const r = repos({ "package.json": "{}\n", "package-lock.json": "{}\n", "yarn.lock": "#\n" });
  const v = vendor(() => ({ verdict: null, confidence: null, error: "unavailable" }));
  const box = await fenced(r);
  box.fenceCheck = openFenceCheck({ decider: v.decider });
  r.commit({ "app.txt": "v3\n", "package-lock.json": '{"v":2}\n' }, "fix");
  assert.deepEqual(await box.outside(), ["package-lock.json"]);
  assert.deepEqual(box.fenceVerdict().undecided, ["package-lock.json"]);
  assert.equal(await box.push(), false);
  assert.equal(v.asked.length, 2, "no verdict is kept: the push asks again");
  assert.equal(box.errorKind, "fix-scope");
  assert.equal(box.errorCause, "outage");
  assert.equal(decideExit({ harness: { ok: true }, pr: { exists: true }, commits: 2, pushRejected: box.error, pushCause: box.errorCause }).cause, "outage");

  const r2 = repos({ "package.json": "{}\n", "package-lock.json": "{}\n" });
  const v2 = vendor(() => ({ verdict: "fix", confidence: 1 }));
  const box2 = await fenced(r2);
  box2.fenceCheck = openFenceCheck({ decider: v2.decider });
  r2.commit({ "package-lock.json": `${"x".repeat(40 * 1024)}\n` }, "relock");
  assert.deepEqual(await box2.outside(), ["package-lock.json"]);
  assert.equal(v2.asked.length, 0);
  assert.deepEqual(box2.fenceVerdict().judged, ["package-lock.json: not judged (a change over 32 KiB)"]);
});

test("#414: the stage harness's usage limit in the fence check ends the stage through UsageLimitReached, with nothing of the pass pushed and no corrective turn", async () => {
  const bin = mkdtempSync(join(tmpdir(), "factory-fence-claude-"));
  const fixture = join(import.meta.dirname, "fixtures", "claude-2.1.323-usage-limit.jsonl");
  const log = join(bin, "calls");
  writeFileSync(join(bin, "claude"), `#!/bin/sh\necho call >> '${log}'\ncat >/dev/null\ncat '${fixture}'\nexit 1\n`, { mode: 0o755 });
  const stage = { harness: "claude", model: "m-1", env: { HOME: homedir(), PATH: `${bin}:${process.env.PATH}`, TMPDIR: process.env.TMPDIR, CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-dummy" }, record: () => {} };
  const r = repos({ "package.json": "{}\n", "package-lock.json": "{}\n" });
  const box = await fenced(r);
  box.fenceCheck = openFenceCheck({ inputs: {}, env: {}, stage });
  r.commit({ "app.txt": "v3\n", "package-lock.json": '{"v":2}\n' }, "fix");
  const pass = { outbox: box, session: { id: null, canResume: false }, harness: "claude", model: "m-1", taskCard: "card", cwd: r.work, env: stage.env, eventsFile: join(r.root, "events.jsonl"), deadlineAt: Date.now() + 3_600_000, maxUsd: 0, label: "validation-scope-1" };
  await assert.rejects(holdScope(pass), (e) => e.code === USAGE_LIMIT && e.refusal.harness === "claude");
  assert.equal(readFileSync(log, "utf8").trim().split("\n").length, 1, "the decision call only: no corrective turn ran");
  assert.equal(box.failed, true);
  assert.match(box.error, /^the fence check met claude's usage limit; nothing of the fix pass was pushed/);
  assert.equal(await box.push(), false, "nothing goes out after it");
});

test("#414: the question's input is redacted and fenced; a missing diff, failure or comment says so", () => {
  const input = fenceInput({ path: ".nvmrc", diff: "", lead: "", comments: [], plan: "" }, "abc");
  for (const s of ["(no change shown)", "(none: the pass answers review comments)", "The review comments the pass answers:\n<<<BEGIN abc>>>\n(none)"]) assert.ok(input.includes(s), s);
  assert.equal(openFenceCheck({ inputs: { decisionRoute: "off" } }).off, "route-off");
});
