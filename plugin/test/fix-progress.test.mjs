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

test("redProgress: the same signature with other failure lines as logged is not the same red; it goes to the decision model (tsc, Go subtests, node --test, 3 failures to 1)", async () => {
  const { failureSignature } = await import("../scripts/lib/triage.mjs");
  // Each case: three failures as logged, then one of them left.
  const tsc = (n) => `src/a.ts(${n},5): error TS2322: Type 'string' is not assignable to type 'number'.`;
  const cases = {
    tsc: [[tsc(3), tsc(7), tsc(9)], [tsc(9)]],
    go: [["--- FAIL: TestParse (0.00s)", "    --- FAIL: TestParse/case_1 (0.00s)", "    --- FAIL: TestParse/case_2 (0.00s)", "    --- FAIL: TestParse/case_3 (0.00s)", "FAIL"], ["--- FAIL: TestParse (0.00s)", "    --- FAIL: TestParse/case_3 (0.00s)", "FAIL"]],
    node: [["not ok 1 - parses row 1", "not ok 2 - parses row 2", "not ok 3 - parses row 3", "# fail 3"], ["not ok 3 - parses row 3", "# fail 1"]],
  };
  for (const [kind, [lines, left]] of Object.entries(cases)) {
    const all = failureSignature("test", lines.join("\n"));
    const fewer = failureSignature("test", left.join("\n"));
    assert.equal(all.id, fewer.id, `${kind}: the fold makes them one class`);
    assert.notDeepEqual(all.lines, fewer.lines, `${kind}: the lines as logged differ`);
    const before = red("a", ["test", all]);
    const after = red("b", ["test", fewer]);
    assert.equal(redProgress(before, after), null, `${kind}: not "the same jobs fail the same way"`);
    const asked = [];
    const check = openProgressCheck({ inputs: {}, decider: { name: "fake", decide: async (input) => (asked.push(input), { verdict: "closer", confidence: 0.9 }) } });
    assert.equal((await check.judge({ before, after })).progress, true, kind);
    assert.equal(asked.length, 1, `${kind}: the decision model judged it`);
    assert.deepEqual(redProgress(before, red("b", ["test", failureSignature("test", lines.join("\n"))])), { progress: false, why: "the same jobs fail with the same failure lines" }, `${kind}: the same lines are the same red`);
  }
});

test("redProgress with durations in the failure lines: A again with only its durations changed is the same red; A, B, then A Blocks; 3 failures to 1 goes to the decision model (#399 review)", async () => {
  const { failureSignature } = await import("../scripts/lib/triage.mjs");
  const node = (ms) => [`✖ parses row 1 (${ms[0]}ms)`, `✖ parses row 2 (${ms[1]}ms)`, `✖ parses row 3 (${ms[2]}ms)`];
  const go = (s) => ["--- FAIL: TestParse (0.02s)", `    --- FAIL: TestParse/case_1 (${s[0]}s)`, `    --- FAIL: TestParse/case_2 (${s[1]}s)`, `    --- FAIL: TestParse/case_3 (${s[2]}s)`, "FAIL"];
  const cases = {
    node: [node([2.1, 3.4, 0.9]), node([1.7, 4.2, 1.1]), [`✖ parses row 3 (1.3ms)`]],
    go: [go(["0.01", "0.00", "0.03"]), go(["0.02", "0.01", "0.00"]), ["--- FAIL: TestParse (0.01s)", "    --- FAIL: TestParse/case_2 (0.04s)", "FAIL"]],
  };
  const lint = { ...red("2", ["lint", failureSignature("lint", "src/a.js\n  3:7  error  'x' is not defined  no-undef")]), at: "validation pass 2 on 2222222" };
  for (const [kind, [first, again, one]] of Object.entries(cases)) {
    const a = { ...red("1", ["test", failureSignature("test", first.join("\n"))]), at: "validation pass 1 on 1111111" };
    const a2 = { ...red("3", ["test", failureSignature("test", again.join("\n"))]), at: "validation pass 3 on 3333333", passed: ["lint"] };
    assert.notDeepEqual(a.jobs[0].sig.lines, a2.jobs[0].sig.lines, `${kind}: the durations differ as logged`);
    // A, then A with only its durations changed: the same red, never a question.
    assert.deepEqual(redProgress(a, { ...a2, passed: [] }), { progress: false, why: "the same jobs fail with the same failure lines" }, kind);
    // A, B, then A again: lint passed on A's return, which alone would read as progress; A was seen.
    assert.deepEqual(redProgress(lint, a2, [a, lint]), { progress: false, why: `it brought back the red of validation pass 1 on 1111111: test, failing the same way, after the red it was handed (validation pass 2 on 2222222: lint)` }, kind);
    // Three failures, then one of them left (its duration changed too): the decision model is asked.
    const fewer = red("4", ["test", failureSignature("test", one.join("\n"))]);
    assert.equal(fewer.jobs[0].sig.id, a.jobs[0].sig.id, `${kind}: one class`);
    assert.equal(redProgress(a, fewer), null, `${kind}: 3 to 1 is not the same red`);
    const asked = [];
    const check = openProgressCheck({ inputs: {}, decider: { name: "fake", decide: async (input) => (asked.push(input), { verdict: "closer", confidence: 0.9 }) } });
    assert.equal((await check.judge({ before: a, after: fewer })).progress, true);
    assert.equal(asked.length, 1, `${kind}: asked`);
  }
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

test("validation loop: while each fix pass leaves fewer jobs failing, it goes on past two passes to green (#399)", async () => {
  // Three commands red; each fix pass fixes one, so each red is a strict subset of the one before.
  const files = ["a", "b", "c"];
  const r = await commandsLoop({ commands: files.map((f) => needs(f)), steps: files.map((f) => ({ write: { [f]: "ok\n" }, commit: true })) });
  assert.equal(r.result.green, true, r.phases.join("\n"));
  assert.equal(r.result.passes, 4);
  assert.equal(r.calls, 3, "three fix passes, never capped at two");
  assert.ok(r.phases.some((l) => /^validation pass 3 red: .*; fix run \(progress: fewer jobs fail, and the ones that stopped failing pass\)$/.test(l)), r.phases.join("\n"));
});

test("validation loop: a fix pass that committed, with the same command failing the same way after it, Blocks naming the red (#399)", async () => {
  const r = await commandsLoop({ commands: [needs("fixed")], steps: [{ write: { other: "x\n" }, commit: true }, { write: { fixed: "ok\n" }, commit: true }] });
  assert.equal(r.result.green, false);
  assert.equal(r.calls, 1, "no second fix pass");
  const cmd = "test -f fixed || { echo \"not ok 1 - fixed is missing its fix: $(cat fixed 2>/dev/null || echo none)\"; exit 1; }";
  assert.equal(r.result.stalled, `the fix pass before it made no progress: the same jobs fail with the same failure lines; failing: ${cmd} (${cmd}: not ok 1 - fixed is missing its fix: none)`);
  assert.deepEqual(exitOf(r.result), { exit: "blocked", reason: `validation red on Pendulum's pass 2 (${cmd}): ${r.result.stalled}`, cause: "work" });
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
  // The first fix pass also takes a catch-up merge of upstream.txt: the question shows only the pass's own commits.
  const steps = ["one", "two", "done"].map((x, i) => ({ write: { state: `${x}\n` }, commit: true, ...(i === 0 ? { merge: "upstream.txt" } : {}) }));
  const r = await commandsLoop({ commands: [needs("state", "done")], steps, progressCheck });
  assert.equal(r.result.green, false);
  assert.equal(asked.length, 2);
  assert.equal(r.calls, 2, "closer bought a second fix pass; not closer Blocked before a third");
  assert.equal(r.result.passes, 3);
  assert.match(asked[0], /Before the fix pass:\n<<<BEGIN \w+>>>\nFailing: test -f state[^\n]*\n\n--- [^\n]*: not ok 1 - state is missing its fix: none/);
  assert.match(asked[0], /After the fix pass:\n<<<BEGIN \w+>>>\nFailing: [^\n]*\n\n--- [^\n]*: not ok 1 - state is missing its fix: one/);
  assert.match(asked[0], /own commits \(git log --stat, merges left out\):\n<<<BEGIN \w+>>>\n[0-9a-f]{7,} fix 1\n\n state \| 1 \+/);
  assert.doesNotMatch(asked[0], /upstream/, "nothing of the catch-up merge");
  assert.ok(r.phases.some((l) => /^validation pass 2 red: .*; fix run \(progress: the decision model \(perplexity\/pplx-decider-v1\.2\) judged it closer to green at 0\.90\)$/.test(l)), r.phases.join("\n"));
  assert.match(r.result.stalled, /^the fix pass before it made no progress: the decision model \(perplexity\/pplx-decider-v1\.2\) judged it no closer to green at 0\.80; failing: .*state is missing its fix: two\)$/);
});

test("validation loop: with no decider, a red the exact checks cannot judge counts as no progress and Blocks (#399)", async () => {
  const steps = ["one", "done"].map((x) => ({ write: { state: `${x}\n` }, commit: true }));
  for (const progressCheck of [null, openProgressCheck({ inputs: { decisionRoute: "off" } })]) {
    const r = await commandsLoop({ commands: [needs("state", "done")], steps, progressCheck });
    assert.equal(r.result.green, false);
    assert.equal(r.calls, 1);
    assert.match(r.result.stalled, /^the fix pass before it made no progress: the failing jobs changed without fewer of them failing and the rest passing, and no decision model can judge it( \(route-off\))?; failing: /);
  }
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

test("validation loop: a red that flips back to one seen before (A, then B, then A) Blocks, naming both (#399)", async () => {
  // Two commands; the first pass fixes A and breaks B, the second fixes B and breaks A again.
  const commands = [needs("fa"), needs("fb")];
  const steps = [{ write: { fa: "ok\n" }, remove: ["fb"], commit: true }, { write: { fb: "ok\n" }, remove: ["fa"], commit: true }, { write: { fa: "ok\n" }, commit: true }];
  const r = await commandsLoop({ commands, steps, base: { fb: "ok\n" } });
  assert.equal(r.result.green, false);
  assert.equal(r.calls, 2, "no third fix pass");
  const [ca, cb] = commands.map((c) => c.replace(/^parallel: /, ""));
  assert.ok(r.phases.some((l) => l.startsWith("validation pass 2 red: ") && l.endsWith("(progress: the jobs that failed now pass, and a different set fails)")), r.phases.join("\n"));
  const reason = `it brought back the red of validation pass 1 on ${"x".repeat(7)}: ${ca}, failing the same way, after the red it was handed (validation pass 2 on ${"y".repeat(7)}: ${cb})`;
  const said = r.result.stalled.replace(/validation pass 1 on [0-9a-f]{7}/, `validation pass 1 on ${"x".repeat(7)}`).replace(/validation pass 2 on [0-9a-f]{7}/, `validation pass 2 on ${"y".repeat(7)}`);
  assert.ok(said.startsWith(`the fix pass before it made no progress: ${reason}; failing: ${ca} (`), said);
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

test("validation loops of one stage share their reds: A held by the first, B after the stage's own pass, then A again Blocks (#399)", async () => {
  const commands = [needs("fa"), needs("fb")];
  // The stage's answer pass between the loops fixes A and breaks B; the second loop's fix pass fixes B and breaks A.
  const answer = (g, work) => {
    writeFileSync(join(work, "fa"), "ok\n");
    rmSync(join(work, "fb"));
    g("add", "-A");
    g("commit", "-q", "-m", "answer");
  };
  const steps = [{ write: { fb: "ok\n" }, remove: ["fa"], commit: true }, { write: { fa: "ok\n" }, commit: true }];
  // One progress check for the stage's loops, as review.mjs opens it once and passes it to both.
  const shared = await commandsLoop({ commands, steps, base: { fb: "ok\n" }, progressCheck: openProgressCheck({ inputs: { decisionRoute: "off" } }), before: answer });
  assert.ok(shared.held.held, "the first loop held its red for the stage's pass");
  assert.equal(shared.calls, 1, "one fix pass in the second loop, then the Block");
  assert.match(shared.result.stalled, /^the fix pass before it made no progress: it brought back the red of pre-review-validation pass 1 on [0-9a-f]{7}: test -f fa .*, failing the same way, after the red it was handed \(validation pass 1 on [0-9a-f]{7}: test -f fb /);
  // Each loop on its own list (no check shared): the second loop never saw A, so it reads as a new set and gets another pass.
  const apart = await commandsLoop({ commands, steps, base: { fb: "ok\n" }, before: answer });
  assert.equal(apart.calls, 2);
});

test("validation loop: a decision model that gives no answer leaves the judgement unmade: the Block is Pendulum's, or the outage's, never the work's (#399 review)", async () => {
  const steps = ["one", "done"].map((x) => ({ write: { state: `${x}\n` }, commit: true }));
  for (const [error, cause] of [["vendor", "pendulum"], ["unavailable", "outage"]]) {
    const progressCheck = openProgressCheck({ inputs: {}, decider: { name: "fake", decide: async () => ({ verdict: null, confidence: null, error }) } });
    const r = await commandsLoop({ commands: [needs("state", "done")], steps, progressCheck });
    assert.equal(r.calls, 1);
    assert.equal(r.result.stalledCause, cause);
    assert.match(r.result.stalled, new RegExp(`^the fix pass before it could not be judged for progress: the decision model \\(perplexity/pplx-decider-v1\\.2\\) gave no answer \\(${error}\\); failing: `));
    const exit = exitOf(r.result);
    assert.equal(exit.cause, cause);
    assert.match(exit.reason, /could not be judged for progress/);
  }
});
