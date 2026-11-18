import "./temp.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { decideExit } from "../scripts/lib/logic.mjs";
import { PROGRESS_QUESTION, openProgressCheck, progressInput, redProgress } from "../scripts/lib/fix-progress.mjs";
import { validationLoop } from "../scripts/lib/session.mjs";

const sig = (id, line = `not ok 1 - ${id}`) => ({ id, line, lines: [line] });
const red = (head, ...jobs) => ({ head, jobs: jobs.map(([name, s = null]) => ({ name, sig: s })) });

test("redProgress: nothing committed is none; the same jobs with the same lines is none; fewer or other failing counts only when the jobs that failed now pass", () => {
  const before = red("a", ["lint", sig("l1")], ["test", sig("t1")]);
  const pass = (r, ...passed) => ({ ...r, passed });
  assert.deepEqual(redProgress(before, red("a", ["test", sig("t1")])), { progress: false, why: "it committed nothing" });
  assert.deepEqual(redProgress(before, pass(red("b", ["build", sig("b1")]), "lint", "test")), { progress: true, why: "the jobs that failed now pass, and a different set fails" });
  assert.deepEqual(redProgress(before, pass(red("b", ["test", sig("t2")]), "lint")), { progress: true, why: "fewer jobs fail, and the ones that stopped failing pass" });
  assert.deepEqual(redProgress(before, red("b", ["test", sig("t1")], ["lint", sig("l1")])), { progress: false, why: "the same jobs fail with the same failure lines" });
  // A build break that hides the tests: lint and test did not run, so they did not pass.
  assert.equal(redProgress(before, red("b", ["build", sig("b1")])), null, "a disjoint set whose earlier jobs did not run");
  assert.equal(redProgress(before, pass(red("b", ["build", sig("b1")]), "lint")), null, "one of them passed, the other did not run");
  assert.equal(redProgress(before, red("b", ["test", sig("t2")])), null, "fewer, with lint not run");
  assert.equal(redProgress(before, red("b", ["lint", sig("l1")], ["test", sig("t2")])), null, "the same set, another failure");
  assert.equal(redProgress(before, red("b", ["lint", sig("l1")], ["test", sig("t1")], ["build", sig("b1")])), null, "a superset");
  assert.equal(redProgress(red("a", ["test"]), red("b", ["test"])), null, "no signature matches another");
  assert.equal(redProgress(red("a", ["ci"]), red("b")), null, "nothing comparable left (only roll-ups failed)");
  assert.equal(redProgress(red("", ["test", sig("t1")]), red("", ["test", sig("t2")])), null, "heads unread: the sets decide");
});

test("the progress question: closer at the confidence floor or more is progress; under it or not_closer is none; no answer leaves it unjudged, Pendulum's or the outage's", async () => {
  const before = red("a", ["test", sig("t1", "not ok 1 - parses the header")]);
  const after = red("b", ["test", sig("t2", "not ok 4 - writes the footer")]);
  const asked = [];
  const check = (answer) => openProgressCheck({ inputs: {}, decider: { name: "fake", decide: async (input, q) => (asked.push({ input, q }), answer) } });
  assert.deepEqual(await check({ verdict: "closer", confidence: 0.9 }).judge({ before, after, diff: " src/a.mjs | 2 +-\n" }), { progress: true, why: "the decision model (perplexity/pplx-decider-v1.2) judged it closer to green at 0.90" });
  assert.equal(asked[0].q, PROGRESS_QUESTION);
  assert.match(asked[0].input, /Before the fix pass:\n<<<BEGIN (\w+)>>>\nFailing: test\n\n--- test: not ok 1 - parses the header/);
  assert.match(asked[0].input, /After the fix pass:\n<<<BEGIN \w+>>>\nFailing: test\n\n--- test: not ok 4 - writes the footer/);
  assert.match(asked[0].input, /own commits \(git log --stat, merges left out\):\n<<<BEGIN \w+>>>\n src\/a\.mjs \| 2 \+-/);
  assert.equal((await check({ verdict: "closer", confidence: 0.5 }).judge({ before, after })).progress, false);
  assert.deepEqual(await check({ verdict: "not_closer", confidence: 0.9 }).judge({ before, after }), { progress: false, why: "the decision model (perplexity/pplx-decider-v1.2) judged it no closer to green at 0.90" });
  assert.deepEqual(await check({ verdict: null, confidence: null, error: "vendor" }).judge({ before, after }), { progress: false, undecided: true, cause: "pendulum", why: "the decision model (perplexity/pplx-decider-v1.2) gave no answer (vendor)" });
  assert.equal((await check({ verdict: null, confidence: null, error: "unavailable" }).judge({ before, after })).cause, "outage");
  const off = openProgressCheck({ inputs: { decisionRoute: "off" } });
  assert.equal(off.off, "route-off");
  assert.deepEqual(await off.judge({ before, after }), { progress: false, why: "the failing jobs changed without fewer of them failing and the rest passing, and no decision model can judge it (route-off)" });
  // The exact checks never ask.
  asked.length = 0;
  assert.equal((await check({ verdict: "closer", confidence: 0.9 }).judge({ before, after: { ...red("b", ["lint", sig("l1")]), passed: ["test"] } })).why, "the jobs that failed now pass, and a different set fails");
  assert.equal(asked.length, 0);
  assert.doesNotMatch(progressInput({ before, after, diff: null }), /undefined/);
});

/**
 * The real validationLoop on the commands route in a git checkout, with a fake Codex whose call n does `steps[n - 1]`:
 * merges a side branch adding its `merge` file (as Pendulum's catch-up merge brings in the default branch's commits),
 * writes its `write` files, deletes its `remove` files and, with `commit`, commits everything (git add -A). `base`: files
 * the first commit holds. `before(git, work)`: a loop of the same stage, with the same `progressCheck` (and so the same
 * seen reds)
 * first, its first red held for the stage's next pass (holdRed), then `before` (that pass's commit). Returns the result
 * (or the error it rejected with, as `error`), the earlier loop's result (`held`), the harness calls made and the phase
 * lines.
 */
async function commandsLoop({ commands, steps, progressCheck = null, base = {}, before = null }) {
  const root = mkdtempSync(join(tmpdir(), "fix-progress-"));
  const work = join(root, "work");
  mkdirSync(work);
  const g = (...args) => execFileSync("git", ["-C", work, ...args], { encoding: "utf8" });
  g("init", "-q", "-b", "main");
  g("config", "user.name", "t");
  g("config", "user.email", "t@example.com");
  for (const [f, c] of Object.entries({ README: "x\n", ...base })) writeFileSync(join(work, f), c);
  g("add", "-A");
  g("commit", "-q", "-m", "base");
  mkdirSync(join(root, "bin"));
  const calls = join(root, "calls");
  writeFileSync(
    join(root, "bin", "codex"),
    `#!${process.execPath}
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(calls)}, "x");
const n = fs.readFileSync(${JSON.stringify(calls)}, "utf8").length;
const step = ${JSON.stringify(steps)}[n - 1] || {};
if (step.merge) {
  const { execFileSync } = require("node:child_process");
  const git = (...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...a]);
  git("checkout", "-q", "-b", "side");
  fs.writeFileSync(step.merge, "upstream\\n");
  git("add", "-A");
  git("commit", "-qm", "upstream change");
  git("checkout", "-q", "-");
  git("merge", "-q", "--no-ff", "side", "-m", "catch-up merge");
}
for (const [f, c] of Object.entries(step.write || {})) fs.writeFileSync(f, c);
for (const f of step.remove || []) fs.rmSync(f);
if (step.commit) {
  const { execFileSync } = require("node:child_process");
  execFileSync("git", ["add", "-A"]);
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "fix " + n]);
}
console.log(JSON.stringify({ type: "thread.started", thread_id: "t-" + n }));
console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } }));
`,
    { mode: 0o755 },
  );
  const env = { HOME: process.env.HOME, PATH: `${join(root, "bin")}:${process.env.PATH}`, TMPDIR: process.env.TMPDIR, CODEX_HOME: join(root, "codex") };
  const path = process.env.PATH;
  process.env.PATH = env.PATH;
  const phases = [];
  try {
    let error = null;
    const args = { checkout: work, commands, harness: "codex", model: "gpt-6.1-sol", maxUsd: 0, session: { id: null, canResume: false }, taskCard: "card", env, deadlineAt: Date.now() + 120_000, eventsFile: join(root, "events.jsonl"), progressCheck, onPhase: async (l) => phases.push(l) };
    let held = null;
    if (before) {
      held = await validationLoop({ ...args, label: "pre-review-validation", holdRed: () => true });
      before(g, work);
    }
    const result = await validationLoop(args).catch((e) => ((error = e), null));
    let made = 0;
    try {
      made = readFileSync(calls, "utf8").length;
    } catch {}
    return { result, error, held, calls: made, phases };
  } finally {
    process.env.PATH = path;
    rmSync(root, { recursive: true, force: true });
  }
}
// A command that fails with its own TAP line until `file` holds `want` (any content when none), and what it prints.
const needs = (file, want = null) => `parallel: test -f ${file}${want ? ` && grep -qx ${want} ${file}` : ""} || { echo "not ok 1 - ${file} is missing its fix: $(cat ${file} 2>/dev/null || echo none)"; exit 1; }`;
const exitOf = (r) => decideExit({ harness: { ok: true }, pr: { exists: true, draft: true, body: "" }, commits: 1, validation: { passes: r.passes, green: false, command: r.command, stalled: r.stalled, stalledCause: r.stalledCause } });

test("validation loop: a fix pass that committed, with the same command failing the same way after it, Blocks naming the red (#399)", async () => {
  const r = await commandsLoop({ commands: [needs("fixed")], steps: [{ write: { other: "x\n" }, commit: true }, { write: { fixed: "ok\n" }, commit: true }] });
  assert.equal(r.result.green, false);
  assert.equal(r.calls, 1, "no second fix pass");
  const cmd = "test -f fixed || { echo \"not ok 1 - fixed is missing its fix: $(cat fixed 2>/dev/null || echo none)\"; exit 1; }";
  assert.equal(r.result.stalled, `the fix pass before it made no progress: the same jobs fail with the same failure lines; failing: ${cmd} (${cmd}: not ok 1 - fixed is missing its fix: none)`);
  assert.deepEqual(exitOf(r.result), { exit: "blocked", reason: `validation red on Pendulum's pass 2 (${cmd}): ${r.result.stalled}`, cause: "work" });
});

test("redProgress: a red equal to one seen earlier in the stage is no progress, naming both; unsigned jobs match by name (#399)", () => {
  const a = { ...red("1", ["lint", sig("l1")]), at: "pass 1 on 1111111" };
  const b = { ...red("2", ["test", sig("t1")]), at: "pass 2 on 2222222" };
  const again = { ...red("3", ["lint", sig("l1")]), at: "pass 3 on 3333333", passed: ["test"] };
  assert.deepEqual(redProgress(b, again, [a, b]), { progress: false, why: "it brought back the red of pass 1 on 1111111: lint, failing the same way, after the red it was handed (pass 2 on 2222222: test)" });
  assert.deepEqual(redProgress(b, again, []), { progress: true, why: "the jobs that failed now pass, and a different set fails" }, "without the history, a disjoint set");
  assert.deepEqual(redProgress(b, { ...red("3", ["lint", sig("l2")]), passed: ["test"] }, [a, b]).progress, true, "the same job failing another way is not that red");
  assert.equal(redProgress(b, { ...red("3", ["lint"]), passed: ["test"] }, [red("1", ["lint"]), b]).progress, false, "unsigned on both sides: matched by name");
  assert.equal(redProgress(b, { ...red("3", ["lint"]), passed: ["test"] }, [a, b]).progress, true, "unsigned against signed: no match");
});

test("validation loop: the stage harness's usage limit in the progress question ends the stage through UsageLimitReached, never as no progress (#399)", async () => {
  // The decision call runs on the stage's own Claude Code, which answers with its usage limit.
  const { USAGE_LIMIT } = await import("../scripts/lib/harness.mjs");
  const bin = mkdtempSync(join(tmpdir(), "limit-claude-"));
  const limitRun = readFileSync(new URL("./fixtures/claude-2.1.323-usage-limit.jsonl", import.meta.url), "utf8");
  writeFileSync(join(bin, "claude"), `#!${process.execPath}\nrequire("node:fs").readFileSync(0);\nprocess.stdout.write(${JSON.stringify(limitRun)});\nprocess.exit(1);\n`, { mode: 0o755 });
  const kept = [];
  const stage = { harness: "claude", model: "m-1", env: { HOME: process.env.HOME, PATH: `${bin}:${process.env.PATH}`, TMPDIR: process.env.TMPDIR, CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-dummy" }, record: (x) => kept.push(x) };
  try {
    const steps = ["one", "done"].map((x) => ({ write: { state: `${x}\n` }, commit: true }));
    const r = await commandsLoop({ commands: [needs("state", "done")], steps, progressCheck: openProgressCheck({ inputs: {}, env: {}, stage }) });
    assert.equal(r.result, null, "the loop ended on the limit, with no Block of its own");
    assert.equal(r.error?.code, USAGE_LIMIT, String(r.error?.stack || r.error));
    assert.equal(r.error.refusal.code, "usage_limit_reached");
    assert.match(r.error.message, /^fix-progress check: claude reached/);
    assert.equal(r.calls, 1, "no further fix pass");
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});
