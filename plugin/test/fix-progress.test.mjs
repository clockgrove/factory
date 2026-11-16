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

test("redProgress: nothing committed is none; a disjoint set or a strict subset is progress; the same set failing the same way is none; the rest is undecided", () => {
  const before = red("a", ["lint", sig("l1")], ["test", sig("t1")]);
  assert.deepEqual(redProgress(before, red("a", ["test", sig("t1")])), { progress: false, why: "it committed nothing" });
  assert.deepEqual(redProgress(before, red("b", ["build", sig("b1")])), { progress: true, why: "a different set of jobs fails" });
  assert.deepEqual(redProgress(before, red("b", ["test", sig("t2")])), { progress: true, why: "fewer jobs fail" });
  assert.deepEqual(redProgress(before, red("b", ["test", sig("t1")], ["lint", sig("l1")])), { progress: false, why: "the same jobs fail the same way" });
  assert.equal(redProgress(before, red("b", ["lint", sig("l1")], ["test", sig("t2")])), null, "the same set, another failure");
  assert.equal(redProgress(before, red("b", ["lint", sig("l1")], ["test", sig("t1")], ["build", sig("b1")])), null, "a superset");
  assert.equal(redProgress(red("a", ["test"]), red("b", ["test"])), null, "no signature matches another");
  assert.equal(redProgress(red("", ["test", sig("t1")]), red("", ["test", sig("t2")])), null, "heads unread: the sets decide");
});

test("the progress question: closer at the confidence floor or more is progress; under it, not_closer, no answer or no decider is none", async () => {
  const before = red("a", ["test", sig("t1", "not ok 1 - parses the header")]);
  const after = red("b", ["test", sig("t2", "not ok 4 - writes the footer")]);
  const asked = [];
  const check = (answer) => openProgressCheck({ inputs: {}, decider: { name: "fake", decide: async (input, q) => (asked.push({ input, q }), answer) } });
  assert.deepEqual(await check({ verdict: "closer", confidence: 0.9 }).judge({ before, after, diff: " src/a.mjs | 2 +-\n" }), { progress: true, why: "the decision model (perplexity/pplx-decider-v1.2) judged it closer to green at 0.90" });
  assert.equal(asked[0].q, PROGRESS_QUESTION);
  assert.match(asked[0].input, /Before the fix pass:\n<<<BEGIN (\w+)>>>\nFailing: test\n\n--- test: not ok 1 - parses the header/);
  assert.match(asked[0].input, /After the fix pass:\n<<<BEGIN \w+>>>\nFailing: test\n\n--- test: not ok 4 - writes the footer/);
  assert.match(asked[0].input, /git diff --stat\):\n<<<BEGIN \w+>>>\n src\/a\.mjs \| 2 \+-/);
  assert.equal((await check({ verdict: "closer", confidence: 0.5 }).judge({ before, after })).progress, false);
  assert.equal((await check({ verdict: "not_closer", confidence: 0.9 }).judge({ before, after })).progress, false);
  assert.deepEqual(await check({ verdict: null, confidence: null, error: "vendor" }).judge({ before, after }), { progress: false, why: "the decision model (perplexity/pplx-decider-v1.2) gave no answer (vendor)" });
  const off = openProgressCheck({ inputs: { decisionRoute: "off" } });
  assert.equal(off.off, "route-off");
  assert.deepEqual(await off.judge({ before, after }), { progress: false, why: "the failing jobs changed without getting fewer, and no decision model can judge it (route-off)" });
  // The exact checks never ask.
  asked.length = 0;
  assert.equal((await check({ verdict: "closer", confidence: 0.9 }).judge({ before, after: red("b") })).why, "a different set of jobs fails");
  assert.equal(asked.length, 0);
  assert.doesNotMatch(progressInput({ before, after, diff: null }), /undefined/);
});

/**
 * The real validationLoop on the commands route in a git checkout, with a fake Codex whose call n does `steps[n - 1]`:
 * writes its `write` files and, with `commit`, commits everything (git add -A). Each command fails with its own TAP line until its file
 * exists. Returns the result, the harness calls made and the phase lines.
 */
async function commandsLoop({ commands, steps, progressCheck = null }) {
  const root = mkdtempSync(join(tmpdir(), "fix-progress-"));
  const work = join(root, "work");
  mkdirSync(work);
  const g = (...args) => execFileSync("git", ["-C", work, ...args], { encoding: "utf8" });
  g("init", "-q", "-b", "main");
  g("config", "user.name", "t");
  g("config", "user.email", "t@example.com");
  writeFileSync(join(work, "README"), "x\n");
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
for (const [f, c] of Object.entries(step.write || {})) fs.writeFileSync(f, c);
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
    const result = await validationLoop({ checkout: work, commands, harness: "codex", model: "gpt-6.1-sol", maxUsd: 0, session: { id: null, canResume: false }, taskCard: "card", env, deadlineAt: Date.now() + 120_000, eventsFile: join(root, "events.jsonl"), progressCheck, onPhase: async (l) => phases.push(l) });
    let made = 0;
    try {
      made = readFileSync(calls, "utf8").length;
    } catch {}
    return { result, calls: made, phases };
  } finally {
    process.env.PATH = path;
    rmSync(root, { recursive: true, force: true });
  }
}
// A command that fails with its own TAP line until `file` holds `want` (any content when none), and what it prints.
const needs = (file, want = null) => `parallel: test -f ${file}${want ? ` && grep -qx ${want} ${file}` : ""} || { echo "not ok 1 - ${file} is missing its fix: $(cat ${file} 2>/dev/null || echo none)"; exit 1; }`;
const exitOf = (r) => decideExit({ harness: { ok: true }, pr: { exists: true, draft: true, body: "" }, commits: 1, validation: { passes: r.passes, green: false, command: r.command, stalled: r.stalled } });

test("validation loop: while each fix pass leaves fewer jobs failing, it goes on past two passes to green (#399)", async () => {
  // Three commands red; each fix pass fixes one, so each red is a strict subset of the one before.
  const files = ["a", "b", "c"];
  const r = await commandsLoop({ commands: files.map((f) => needs(f)), steps: files.map((f) => ({ write: { [f]: "ok\n" }, commit: true })) });
  assert.equal(r.result.green, true, r.phases.join("\n"));
  assert.equal(r.result.passes, 4);
  assert.equal(r.calls, 3, "three fix passes, never capped at two");
  assert.ok(r.phases.some((l) => /^validation pass 3 red: .*; fix run \(progress: fewer jobs fail\)$/.test(l)), r.phases.join("\n"));
});

test("validation loop: a fix pass that committed, with the same command failing the same way after it, Blocks naming the red (#399)", async () => {
  const r = await commandsLoop({ commands: [needs("fixed")], steps: [{ write: { other: "x\n" }, commit: true }, { write: { fixed: "ok\n" }, commit: true }] });
  assert.equal(r.result.green, false);
  assert.equal(r.calls, 1, "no second fix pass");
  const cmd = "test -f fixed || { echo \"not ok 1 - fixed is missing its fix: $(cat fixed 2>/dev/null || echo none)\"; exit 1; }";
  assert.equal(r.result.stalled, `the fix pass before it made no progress: the same jobs fail the same way; failing: ${cmd} (${cmd}: not ok 1 - fixed is missing its fix: none)`);
  assert.deepEqual(exitOf(r.result), { exit: "blocked", reason: `validation red on Factory's pass 2 (${cmd}): ${r.result.stalled}`, cause: "work" });
});

test("validation loop: a fix pass that committed nothing is no progress, and Blocks (#399)", async () => {
  // The pass writes the fix but never commits it: the red after it is on the same head.
  const r = await commandsLoop({ commands: [needs("fixed", "done"), needs("other")], steps: [{ write: { fixed: "wip\n" } }, { write: { fixed: "done\n" }, commit: true }] });
  assert.equal(r.result.green, false);
  assert.equal(r.calls, 1);
  assert.match(r.result.stalled, /^the fix pass before it made no progress: it committed nothing; failing: /);
});

test("validation loop: the same command failing another way asks the decision model; closer goes on, not closer Blocks (#399)", async () => {
  // Each fix pass commits another state: the command's failure line changes, the failing set stays.
  const answers = [{ verdict: "closer", confidence: 0.9 }, { verdict: "not_closer", confidence: 0.8 }];
  const asked = [];
  const progressCheck = openProgressCheck({ inputs: {}, decider: { name: "fake", decide: async (input) => (asked.push(input), answers[asked.length - 1]) } });
  const steps = ["one", "two", "done"].map((x) => ({ write: { state: `${x}\n` }, commit: true }));
  const r = await commandsLoop({ commands: [needs("state", "done")], steps, progressCheck });
  assert.equal(r.result.green, false);
  assert.equal(asked.length, 2);
  assert.equal(r.calls, 2, "closer bought a second fix pass; not closer Blocked before a third");
  assert.equal(r.result.passes, 3);
  assert.match(asked[0], /Before the fix pass:\n<<<BEGIN \w+>>>\nFailing: test -f state[^\n]*\n\n--- [^\n]*: not ok 1 - state is missing its fix: none/);
  assert.match(asked[0], /After the fix pass:\n<<<BEGIN \w+>>>\nFailing: [^\n]*\n\n--- [^\n]*: not ok 1 - state is missing its fix: one/);
  assert.match(asked[0], /git diff --stat\):\n<<<BEGIN \w+>>>\n state \| 1 \+/);
  assert.ok(r.phases.some((l) => /^validation pass 2 red: .*; fix run \(progress: the decision model \(perplexity\/pplx-decider-v1\.2\) judged it closer to green at 0\.90\)$/.test(l)), r.phases.join("\n"));
  assert.match(r.result.stalled, /^the fix pass before it made no progress: the decision model \(perplexity\/pplx-decider-v1\.2\) judged it no closer to green at 0\.80; failing: .*state is missing its fix: two\)$/);
});

test("validation loop: with no decider, a red the exact checks cannot judge counts as no progress and Blocks (#399)", async () => {
  const steps = ["one", "done"].map((x) => ({ write: { state: `${x}\n` }, commit: true }));
  for (const progressCheck of [null, openProgressCheck({ inputs: { decisionRoute: "off" } })]) {
    const r = await commandsLoop({ commands: [needs("state", "done")], steps, progressCheck });
    assert.equal(r.result.green, false);
    assert.equal(r.calls, 1);
    assert.match(r.result.stalled, /^the fix pass before it made no progress: the failing jobs changed without getting fewer, and no decision model can judge it( \(route-off\))?; failing: /);
  }
});
