import "./temp.mjs";
import assert from "node:assert/strict";
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { scrubbedEnv } from "../scripts/lib/harness.mjs";
import { SECRET_INPUTS, resolveInputs } from "../scripts/lib/inputs.mjs";
import { gatewayKeyProblem, localBaseEnv } from "../scripts/lib/local.mjs";
import { setSelf } from "../scripts/lib/logic.mjs";
import { parseDecision } from "../scripts/lib/adapters/decider-ai-gateway.mjs";
import { MIN_CONFIDENCE, TRIAGE_MODEL, TRIAGE_QUESTION, changedNames, failingStep, foldPaths, repoRefs, failureSignature, jobsToTriage, mergeTriage, namesChange, openTriage, rerunWanted, sameFailure, triageInput, triageKey, triageKeyState, triageLine, triageMarker, triageOf } from "../scripts/lib/triage.mjs";

const fixture = (name) => readFileSync(new URL(`./fixtures/red-logs/${name}`, import.meta.url), "utf8");

const flaky = (confidence) => ({ verdict: "flaky_or_infra", confidence });
const change = (confidence) => ({ verdict: "change_caused", confidence });

test("parseDecision: a known choice with its confidence; a refusal or an unknown label is no verdict, with a code", () => {
  const q = TRIAGE_QUESTION;
  assert.deepEqual(parseDecision({ answers: [{ type: "choice", name: "red_cause", choice: "flaky_or_infra", confidence: 0.93 }] }, q), { verdict: "flaky_or_infra", confidence: 0.93 });
  assert.deepEqual(parseDecision({ answers: [{ type: "choice", name: "red_cause", choice: "change_caused" }] }, q), { verdict: "change_caused", confidence: null });
  assert.deepEqual(parseDecision({ answers: [{ type: "refusal", name: "red_cause" }] }, q), { verdict: null, confidence: null, error: "refused" });
  assert.equal(parseDecision({ answers: [{ type: "choice", name: "red_cause", choice: "maybe", confidence: 0.99 }] }, q).error, "no_answer");
  assert.equal(parseDecision({}, q).verdict, null);
});

test("rerunWanted: every failing job flaky at the threshold or more; one change job or a low confidence keeps the fix pass", () => {
  assert.equal(MIN_CONFIDENCE, 0.7);
  assert.equal(rerunWanted([flaky(0.99)]), true, "every share failed at toolchain download");
  assert.equal(rerunWanted([flaky(0.93), flaky(0.71)]), true);
  // The mixed red of the replay: an infra failure in one job and a real assertion in another.
  assert.equal(rerunWanted([flaky(0.99), change(0.6)]), false);
  assert.equal(rerunWanted([flaky(0.57)]), false, "the whole-run call the replay got wrong sits under the threshold");
  assert.equal(rerunWanted([flaky(null)]), false, "no confidence is not enough");
  assert.equal(rerunWanted([{ verdict: null, confidence: null, error: "HTTP 500" }]), false);
  assert.equal(rerunWanted([{ verdict: "base_failure", confidence: 0.9 }]), false);
  assert.equal(rerunWanted([]), false);
});

test("jobsToTriage: only a structural aggregate is left out; a required job is never dropped for an optional one", () => {
  const run = (id, name, suite, started_at, completed_at) => ({ id, name, suite, started_at, completed_at });
  // quality needs: database and checks (same workflow run, started once they completed).
  const shares = [run(2, "database", 9, "2026-11-08T10:00:00Z", "2026-11-08T10:05:00Z"), run(3, "checks", 9, "2026-11-08T10:00:00Z", "2026-11-08T10:06:00Z")];
  const quality = run(1, "quality", 9, "2026-11-08T10:06:10Z", "2026-11-08T10:06:20Z");
  const sigs = new Map([[1, failureSignature("quality", 'test "$RESULT" = success\n##[error]Process completed with exit code 1.')], [2, failureSignature("database", fixture("node-test-assert.txt"))], [3, failureSignature("checks", fixture("jest-npm-math.txt"))]]);
  assert.deepEqual(jobsToTriage([quality, ...shares], ["quality"], sigs).map((r) => r.name), ["database", "checks"]);
  assert.deepEqual(jobsToTriage([quality, ...shares], ["quality"]).map((r) => r.name), ["quality", "database", "checks"], "an aggregate whose log was not read is asked about");
  // A required job queued behind a failing optional one on one runner is no aggregate: its own log has failure lines.
  const lint = run(7, "lint", 7, "2026-11-08T10:00:00Z", "2026-11-08T10:01:00Z");
  const queued = run(8, "test", 7, "2026-11-08T10:01:05Z", "2026-11-08T10:04:00Z");
  const queuedSigs = new Map([[7, failureSignature("lint", "1:1 error 'x' is defined but never used\n##[error]x")], [8, failureSignature("test", fixture("mocha-math.txt"))]]);
  assert.deepEqual(jobsToTriage([lint, queued], ["test"], queuedSigs).map((r) => r.name), ["lint", "test"]);
  // ci_checks test,lint: test fails beside an optional e2e job; test is the real failure and stays.
  const test1 = run(4, "test", 9, "2026-11-08T10:00:00Z", "2026-11-08T10:03:00Z");
  const e2e = run(5, "e2e-optional", 9, "2026-11-08T10:00:00Z", "2026-11-08T10:04:00Z");
  assert.deepEqual(jobsToTriage([test1, e2e], ["test", "lint"]).map((r) => r.name), ["test", "e2e-optional"]);
  // Another workflow run's job is no part of this one's aggregate.
  assert.deepEqual(jobsToTriage([run(1, "quality", 9, "2026-11-08T10:06:10Z"), run(6, "lint", 8, "2026-11-08T10:00:00Z", "2026-11-08T10:01:00Z")], ["quality"]).map((r) => r.name), ["quality", "lint"]);
  assert.deepEqual(jobsToTriage([quality], ["quality"], sigs).map((r) => r.name), ["quality"], "a required check that failed alone is triaged itself");
});

test("failureSignature: real runner output; different failures never collide, the same failure on a rerun does", () => {
  const logs = ["node-test-assert.txt", "node-test-typeerror.txt", "node-test-other-assert.txt", "jest-npm-math.txt", "jest-npm-users.txt"];
  const sigs = logs.map((f) => failureSignature("test", fixture(f)));
  for (const s of sigs) assert.match(s.id, /^[0-9a-f]{12}$/);
  assert.equal(new Set(sigs.map((s) => s.id)).size, logs.length, "five different failures, five signatures (the lines before ##[error] are the same boilerplate in each)");
  assert.equal(sigs[0].line, "AssertionError [ERR_ASSERTION]: 2 == 3");
  assert.equal(sigs[1].line, "TypeError: cannot read properties of undefined (reading 'foo')");
  assert.equal(sigs[3].line, "● math › adds");
  // The same failure on another attempt: other timestamps and durations.
  const again = fixture("node-test-assert.txt").replace(/2026-11-08T10:00:0\d\.\d+Z/g, "2026-11-09T22:41:17.0000001Z").replace(/0\.847209ms/g, "1.12ms");
  assert.equal(failureSignature("test", again).id, sigs[0].id);
  assert.notEqual(failureSignature("unit", fixture("node-test-assert.txt")).id, sigs[0].id, "another job");
  // Infrastructure: the download failure lines are the signature, numbers folded.
  const infra = (code) => `Acquiring 24.21.0 from https://example.test/a1b2c3d4e5f6a7b8/node.tar.gz\nUnexpected HTTP response: ${code}\ncurl: (22) The requested URL returned error: ${code}\n##[error]Process completed with exit code 22.`;
  assert.equal(failureSignature("db", infra(504)).id, failureSignature("db", infra(503)).id);
  assert.equal(failureSignature("db", infra(504)).line, "Unexpected HTTP response: 504");
  // Only wrappers: no signature, and no signature matches anything.
  const bare = failureSignature("test", "npm error Lifecycle script `test` failed with error:\nnpm error code 1\n##[error]Process completed with exit code 1.");
  assert.equal(bare.id, null);
  assert.equal(sameFailure(bare, failureSignature("test", "npm error code 1\n##[error]Process completed with exit code 1.")), false);
  assert.equal(sameFailure(sigs[0], failureSignature("test", again)), true);
  assert.equal(failureSignature("x", "").line, "");
  // A cache download's progress line is no failure; apt's E: line is.
  assert.equal(failureSignature("t", "Received 136604 of 136604 (100.0%), 2.0 MBs/sec\n##[error]Process completed with exit code 1.").id, null);
  assert.equal(failureSignature("t", "Received 1 of 1 (100.0%)\nE: Unable to satisfy dependencies.\n##[error]Process completed with exit code 100.").line, "E: Unable to satisfy dependencies.");
});

test("failureSignature: Mocha, Playwright, pytest, Python and Go; files the failure points at are part of it", () => {
  const sig = (f, name = "test") => failureSignature(name, fixture(f));
  const pairs = [["mocha-math.txt", "mocha-invoice.txt"], ["playwright-cart.txt", "playwright-login.txt"], ["go-add.txt", "go-total.txt"]];
  for (const [a, b] of pairs) {
    assert.match(sig(a).id, /^[0-9a-f]{12}$/);
    assert.notEqual(sig(a).id, sig(b).id, `${a} and ${b} are different failures`);
  }
  // The same failure on a rerun: other durations.
  assert.equal(failureSignature("test", fixture("mocha-math.txt").replace("(12ms)", "(40ms)")).id, sig("mocha-math.txt").id);
  assert.equal(failureSignature("test", fixture("playwright-cart.txt").replace(/\(2\.1s\)/g, "(3.7s)").replace("(14.2s)", "(16.0s)")).id, sig("playwright-cart.txt").id);
  // The same failure lines in another test file is another failure.
  assert.notEqual(failureSignature("test", fixture("mocha-math.txt").replace("test/math.test.js", "test/other.test.js")).id, sig("mocha-math.txt").id);
  assert.equal(sig("pytest-math.txt").line, "E       assert 2 == 3");
  assert.match(sig("python-traceback.txt").id, /^[0-9a-f]{12}$/);
  assert.equal(sig("python-traceback.txt").line, "TypeError: unsupported operand type(s) for +: 'int' and 'NoneType'");
  assert.deepEqual(sig("python-traceback.txt").context.flatMap(repoRefs), ["app/models.py"], "the runner's tool cache is not the repository");
  assert.deepEqual(repoRefs("at Context.<anonymous> (file:///home/runner/work/app/app/test/x.test.js:5:12) at f (node_modules/mocha/lib/runner.js:1:1) node:internal/timers:483:21"), ["test/x.test.js"]);
});

test("namesChange: a failure that names a changed path, file name or added test is never rerun", () => {
  const names = changedNames([
    { filename: "test/x.test.mjs", patch: "@@ -1 +1,2 @@\n+test(\"adds\", () => assert.equal(1 + 1, 3));\n test(\"ok\", () => {});" },
    { filename: "src/users.ts", patch: "+export const name = () => undefined;" },
  ]);
  assert.deepEqual([...names.tests], ["adds"]);
  const node = failureSignature("test", fixture("node-test-assert.txt"));
  assert.equal(namesChange(node, names), "adds", "the failing test is one the PR added");
  assert.equal(namesChange(node, changedNames([{ filename: "test/x.test.mjs", patch: "-old line" }])), "x.test.mjs", "the stack and the test location name the changed test file");
  assert.equal(namesChange(node, changedNames([{ filename: "README.md", patch: "+docs" }])), null);
  assert.equal(namesChange(failureSignature("test", "✖ adds (1ms)\n##[error]Process completed with exit code 1."), changedNames([{ filename: "lib/a.js", patch: "+it('adds', () => {})" }])), "adds");
  const infra = failureSignature("db", "curl: (22) The requested URL returned error: 504\n##[error]x");
  assert.equal(namesChange(infra, names), null);
  // Go's t.Errorf location and pytest's and Python's lines name changed files too.
  assert.equal(namesChange(failureSignature("go", fixture("go-add.txt")), changedNames([{ filename: "math/math_test.go", patch: "-x" }])), "math_test.go");
  assert.equal(namesChange(failureSignature("py", fixture("pytest-math.txt")), changedNames([{ filename: "tests/test_math.py", patch: "-x" }])), "tests/test_math.py");
  assert.equal(namesChange(failureSignature("py", fixture("python-traceback.txt")), changedNames([{ filename: "app/models.py", patch: "-x" }])), "app/models.py");
  assert.equal(namesChange(failureSignature("go", fixture("go-add.txt")), changedNames([{ filename: "invoice/invoice_test.go", patch: "-x" }])), null);
});

test("triage records: written in the progress comment, read back only from Factory's own progress comments", () => {
  setSelf("factory-app[bot]");
  const rec = { reruns: new Set(["a1b2c3d4e5f60718293a4b5c6d7e8f9012345678"]), sigs: new Set(["0123456789ab"]) };
  const progress = (login, body) => ({ user: { login }, body });
  const comments = [
    progress("factory-app[bot]", `<!-- factory:7:progress:work:1 -->\nFactory work run 1\n${triageMarker(rec)}`),
    progress("someone", `<!-- factory:7:progress:work:2 -->\n${triageMarker({ reruns: ["ffffffffffffffffffffffffffffffffffffffff"], sigs: ["ffffffffffff"] })}`),
    progress("factory-app[bot]", `a plain comment\n${triageMarker({ reruns: ["eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"], sigs: [] })}`),
    progress("factory-app[bot]", `<!-- factory:8:progress:work:3 -->\n${triageMarker({ reruns: ["dddddddddddddddddddddddddddddddddddddddd"], sigs: [] })}`),
  ];
  const got = triageOf(comments, { issue: 7 });
  assert.deepEqual([...got.reruns], ["a1b2c3d4e5f60718293a4b5c6d7e8f9012345678"]);
  assert.deepEqual([...got.sigs], ["0123456789ab"]);
  assert.equal(got.refused, false);
  // A refused rerun is remembered for the Objective.
  const refused = triageOf([progress("factory-app[bot]", `<!-- factory:7:progress:review:4 -->\n${triageMarker(mergeTriage({ refused: true }))}`)], { issue: 7 });
  assert.equal(refused.refused, true);
  assert.equal(mergeTriage(got, refused).refused, true);
  setSelf(null);
});

test("triageInput and triageLine: one job per question; the line names each verdict, confidence and signature", () => {
  const input = triageInput({ repo: "o/r", prNumber: 5, sha: "a".repeat(40), job: "browser-build", excerpt: "boom", files: [{ filename: "src/a.ts", additions: 3, deletions: 1 }, { filename: "test/a.test.ts", additions: 2, deletions: 0 }] });
  assert.match(input, /Failing CI job: browser-build/);
  assert.match(input, /2 files changed, 5 insertions\(\+\), 1 deletions\(-\)/);
  assert.match(input, /src\/a\.ts\ntest\/a\.test\.ts/);
  assert.match(input, /boom$/);
  const line = triageLine({ sha: "abcdef1234", model: TRIAGE_MODEL, outcome: "fix pass", jobs: [{ name: "checks", ...flaky(0.93), sig: { id: "0123456789ab", line: "504 Gateway Timeout" } }, { name: "build", ...change(0.88), sig: { id: "ba9876543210", line: "" } }] });
  assert.equal(line, `triage of the red on abcdef1 (${TRIAGE_MODEL}): checks: flaky_or_infra 0.93 [0123456789ab \`504 Gateway Timeout\`]; build: change_caused 0.88 [ba9876543210] → fix pass`);
  assert.match(triageLine({ sha: "abcdef1234", model: "m", outcome: "fix pass", jobs: [{ name: "t", verdict: null, error: "auth", sig: { id: null, line: "" } }] }), /t: no verdict \(auth\) \[no failure line found\]/);
});

test("the key: the Action's input on Actions, only the key file elsewhere; none turns triage off", () => {
  const home = mkdtempSync(join(tmpdir(), "factory-triage-"));
  const actions = { GITHUB_ACTIONS: "true" };
  try {
    assert.equal(triageKey({ inputs: { aiGatewayApiKey: "k-input" }, env: { ...actions, AI_GATEWAY_API_KEY: "k-env" }, home }), "k-input");
    assert.equal(triageKey({ inputs: {}, env: { ...actions, AI_GATEWAY_API_KEY: "k-env" }, home }), "", "no env route on a runner");
    assert.equal(triageKey({ inputs: { aiGatewayApiKey: "k-input" }, env: { AI_GATEWAY_API_KEY: "k-env" }, home }), "", "locally neither the env nor an input");
    mkdirSync(join(home, ".config", "factory"), { recursive: true });
    writeFileSync(join(home, ".config", "factory", "ai-gateway-key"), "k-file\n", { mode: 0o600 });
    assert.equal(triageKey({ inputs: {}, env: {}, home }), "k-file");
    assert.equal(triageKey({ inputs: {}, env: actions, home }), "", "a runner reads no key file");
    assert.equal(openTriage({ inputs: {}, env: actions, repo: { full: "o/r" }, issue: 1, prNumber: 2 }).off, "no-key");
    assert.equal(openTriage({ inputs: { aiGatewayApiKey: "k", triageModel: "x/y" }, env: actions, repo: { full: "o/r" }, issue: 1, prNumber: 2 }).model, "x/y");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
  const inputs = resolveInputs({ env: { FACTORY_INPUT_AI_GATEWAY_API_KEY: "k", FACTORY_TRIAGE_MODEL: "m/n" } });
  assert.equal(inputs.aiGatewayApiKey, "k");
  assert.equal(inputs.triageModel, "m/n");
});

test("locally the key file is held to the key-file rules, and each way it fails has a code", () => {
  const home = mkdtempSync(join(tmpdir(), "factory-triage-"));
  const dir = join(home, ".config", "factory");
  const file = join(dir, "ai-gateway-key");
  const state = () => triageKeyState({ inputs: {}, env: {}, home });
  try {
    assert.deepEqual(state(), { key: "", code: "no-key" });
    assert.equal(gatewayKeyProblem({ CODEX_HOME: home }, home, "codex"), null, "no key file, nothing to expose");
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, "k-file\n", { mode: 0o644 });
    chmodSync(file, 0o644);
    assert.deepEqual(state(), { key: "", code: "key-file-mode" });
    chmodSync(file, 0o600);
    assert.deepEqual(state(), { key: "k-file", code: null });
    // A harness home the outer sandbox leaves readable (#2551) that holds ~/.config/factory exposes the key: refused,
    // and serve will not start with the file there; a harness home elsewhere is fine.
    const exposed = (harness, env) => triageKeyState({ inputs: { harness }, env, home });
    assert.deepEqual(exposed("claude", { CLAUDE_CONFIG_DIR: join(home, ".config") }), { key: "", code: "key-dir-exposed" });
    assert.deepEqual(exposed("codex", { CODEX_HOME: home }), { key: "", code: "key-dir-exposed" });
    assert.deepEqual(exposed("copilot", { COPILOT_HOME: dir }), { key: "", code: "key-dir-exposed" });
    assert.deepEqual(exposed("claude", { CLAUDE_CONFIG_DIR: join(home, ".config", "factory-claude") }), { key: "k-file", code: null }, "a sibling is not inside");
    assert.deepEqual(exposed("codex", {}), { key: "k-file", code: null });
    assert.match(gatewayKeyProblem({ CODEX_HOME: join(home, ".config") }, home, "codex"), /inside the codex harness's home/);
    assert.equal(gatewayKeyProblem({}, home, "codex"), null);
    linkSync(file, join(home, "second-link"));
    assert.deepEqual(state(), { key: "", code: "key-file-links" }, "a second hard link reaches the key outside ~/.config/factory");
    rmSync(join(home, "second-link"));
    writeFileSync(join(home, "elsewhere"), "k-other\n", { mode: 0o600 });
    rmSync(file);
    symlinkSync(join(home, "elsewhere"), file);
    assert.deepEqual(state(), { key: "", code: "key-file-not-regular" }, "a symlink points the read past the sandboxes' deny list");
    rmSync(file);
    writeFileSync(file, "\n", { mode: 0o600 });
    assert.deepEqual(state(), { key: "", code: "key-file-empty" });
    // ~/.config/factory itself a symlink: the sandboxes deny the literal path, not where it leads.
    rmSync(join(home, ".config", "factory"), { recursive: true });
    mkdirSync(join(home, "real-dir"));
    writeFileSync(join(home, "real-dir", "ai-gateway-key"), "k\n", { mode: 0o600 });
    symlinkSync(join(home, "real-dir"), dir);
    assert.deepEqual(state(), { key: "", code: "key-dir-symlink" });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("local triage: on with the key file, the key in no stage env; off says so once, with its code", async () => {
  const home = mkdtempSync(join(tmpdir(), "factory-triage-"));
  const repo = { full: "o/r" };
  const red = { sha: "abcdef1234567", failedRuns: [{ id: 1, name: "checks" }], required: ["checks"] };
  try {
    // No key file: the first red of the stage says triage is off and why, in the job log and the progress comment.
    const lines = [];
    const off = openTriage({ inputs: {}, env: {}, home, repo, issue: 1, prNumber: 2, progress: async (l) => lines.push(l) });
    assert.equal(off.off, "no-key");
    assert.deepEqual(await off.red(red), { rerun: false });
    assert.deepEqual(await off.red(red), { rerun: false });
    const again = openTriage({ inputs: {}, env: {}, home, repo, issue: 1, prNumber: 2, progress: async (l) => lines.push(l) });
    await again.red(red);
    assert.deepEqual(lines, ["triage: off (no-key); fix pass"], "once per stage, a code and no text from anywhere else");
    // The key file in place: triage is on, read by this process alone.
    mkdirSync(join(home, ".config", "factory"), { recursive: true });
    writeFileSync(join(home, ".config", "factory", "ai-gateway-key"), "k-file\n", { mode: 0o600 });
    const env = { PATH: "/usr/bin", HOME: home };
    const on = openTriage({ inputs: {}, env, home, repo, issue: 1, prNumber: 2 });
    assert.equal(on.off, undefined);
    assert.equal(typeof on.red, "function");
    assert.deepEqual(env, { PATH: "/usr/bin", HOME: home }, "reading the key puts nothing in the environment");
    // A stage's env starts from localBaseEnv: the developer's shell and the workflow's FACTORY_LOCAL_ENV cannot carry it.
    const shell = { PATH: "/usr/bin", HOME: home, AI_GATEWAY_API_KEY: "k-env", FACTORY_AI_GATEWAY_API_KEY: "k-env", FACTORY_INPUT_AI_GATEWAY_API_KEY: "k-env", DATABASE_URL: "postgres://x" };
    const stage = localBaseEnv(shell, ["AI_GATEWAY_API_KEY", "FACTORY_AI_GATEWAY_API_KEY", "FACTORY_INPUT_AI_GATEWAY_API_KEY", "DATABASE_URL"]);
    assert.equal(stage.DATABASE_URL, "postgres://x");
    for (const [k, v] of Object.entries(stage)) assert.ok(!/AI_GATEWAY/.test(k) && v !== "k-env" && v !== "k-file", `${k} carries the key`);
    // And a child of the stage (the harness, a command) never gets it under any name.
    assert.deepEqual(Object.keys(scrubbedEnv(shell)).sort(), ["DATABASE_URL", "HOME", "PATH"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("no secret input reaches a child under either name input() reads it by", () => {
  const env = scrubbedEnv({ AI_GATEWAY_API_KEY: "k", FACTORY_INPUT_TRIAGE_MODEL: "m", FACTORY_TRIAGE_MODEL: "m", PATH: "/usr/bin" });
  assert.deepEqual(Object.keys(env).sort(), ["FACTORY_INPUT_TRIAGE_MODEL", "FACTORY_TRIAGE_MODEL", "PATH"]);
  for (const name of SECRET_INPUTS) {
    const upper = name.toUpperCase();
    const left = scrubbedEnv({ [`FACTORY_INPUT_${upper}`]: "s1", [`FACTORY_${upper}`]: "s2" });
    assert.deepEqual(left, {}, `${name} under FACTORY_INPUT_ and FACTORY_`);
    assert.equal(resolveInputs({ env: { [`FACTORY_${upper}`]: "s2" } })[name.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] !== undefined, true);
  }
  assert.ok(SECRET_INPUTS.has("ai_gateway_api_key") && SECRET_INPUTS.has("codex_api_key") && SECRET_INPUTS.has("anthropic_api_key") && SECRET_INPUTS.has("copilot_github_token"));
});

test("failureSignature: random and runner-specific paths fold, so the same failure hashes the same on any runner and rerun", () => {
  const sig = (f) => failureSignature("test", fixture(`paths/${f}`));
  const base = sig("mocha.txt");
  assert.match(base.id, /^[0-9a-f]{12}$/);
  // The checkout prefix: hosted Linux, a self-hosted runner's _work, Windows' D:\a\ and a file:///D:/a/ URL.
  for (const f of ["mocha-hosted-abs.txt", "mocha-self-hosted.txt", "mocha-windows.txt", "mocha-windows-url.txt"]) {
    assert.equal(sig(f).id, base.id, f);
    assert.deepEqual(sig(f).context.flatMap(repoRefs), ["test/math.test.js"], f);
  }
  // Temp directories differ per run and are no repository file; bundle chunk hashes differ per build.
  assert.equal(sig("mocha-tmp-a.txt").id, sig("mocha-tmp-b.txt").id);
  assert.deepEqual(sig("mocha-tmp-a.txt").context.flatMap(repoRefs), ["test/math.test.js"]);
  assert.equal(sig("mocha-chunk-a.txt").id, sig("mocha-chunk-b.txt").id);
  assert.deepEqual(sig("mocha-chunk-a.txt").context.flatMap(repoRefs), ["test/math.test.js", "dist/main.HASH.js"]);
  assert.notEqual(sig("mocha-chunk-a.txt").id, base.id, "a frame in another file is another failure");
  const cases = {
    "at f (/home/runner/work/_temp/0a1b/run.js:1:1)": "at f (<tmp>:1:1)",
    "at f (/private/var/folders/x1/abc/T/f.js:1:1)": "at f (<tmp>:1:1)",
    "at f (C:\\Users\\runneradmin\\AppData\\Local\\Temp\\x\\f.js:1:1)": "at f (<tmp>:1:1)",
    "at f (D:\\a\\_temp\\x.js:1:1)": "at f (<tmp>:1:1)",
    "/tmp/pytest-of-runner/pytest-12/test_a0/conftest.py:3: in f": "<tmp>:3: in f",
    "at r (dist/assets/index-BqXmRtkA.js:1:2)": "at r (dist/assets/index-HASH.js:1:2)",
    "at r (dist/chunks/482.js:1:2)": "at r (dist/chunks/N.js:1:2)",
    "rootdir: /home/runner/work/app/app/tests/pytest-3/": "rootdir: tests/pytest-N/",
    "at f (src/my-settings.js:3:1)": "at f (src/my-settings.js:3:1)",
    "at r (/home/runner/work/_actions/actions/setup-node/v6/dist/setup/index.js:1:2)": "at r (/home/runner/work/_actions/actions/setup-node/v6/dist/setup/index.js:1:2)",
  };
  for (const [line, folded] of Object.entries(cases)) assert.equal(foldPaths(line), folded, line);
  assert.deepEqual(repoRefs("at r (/home/runner/work/_actions/actions/setup-node/v6/dist/setup/index.js:1:2)"), [], "an action's own code is not the repository's");
  assert.deepEqual(repoRefs("at r (D:\\a\\_actions\\actions\\cache\\v4\\dist\\index.js:1:2)"), []);
  // A failure line that names a temp path is the same failure on the next run.
  const tmpLine = (d) => `Error: ENOENT: no such file or directory, open '/tmp/${d}/fixture.json'\n##[error]Process completed with exit code 1.`;
  assert.equal(failureSignature("t", tmpLine("tmp-4821-Xq7ZbA")).id, failureSignature("t", tmpLine("tmp-5093-Lp2RwK")).id);
});

test("failureSignature: only the failing step counts; setup noise and post-job lines stay out", () => {
  const log = fixture("steps-mocha.txt");
  const lines = failingStep(log.replace(/^\S+Z /gm, "").split("\n").map((l) => l.trim()).filter(Boolean));
  assert.equal(lines[0], "##[group]Run npm test");
  assert.equal(lines.at(-1), "##[error]Process completed with exit code 1.");
  const sig = failureSignature("test", log);
  assert.ok(!sig.lines.some((l) => /Cache service|post-step/.test(l)), "the setup step's and the post-job step's error lines are not this failure");
  assert.ok(!sig.context.some((l) => /legacy\.js/.test(l)), "a passing step's frames are not its context");
  // The setup step's noise can differ between runs (another cache outage, another warning): the signature does not move.
  assert.equal(failureSignature("test", log.replace("responded with 503", "timed out after 30000 ms").replace("legacy.js:9:9", "other.js:1:1")).id, sig.id);
  assert.equal(sig.id, failureSignature("test", fixture("paths/mocha.txt")).id, "the same failure as the bare test output: the other steps add nothing");
  // A runner Factory does not recognise (Gradle's output has no failure line it knows) gets no signature from setup
  // noise; read whole, the setup step's `Error:` line would have given it one.
  const gradle = fixture("steps-gradle.txt");
  assert.equal(failureSignature("test", gradle).id, null);
  assert.match(failureSignature("test", gradle.replace(/^.*##\[group\].*$/gm, "")).id, /^[0-9a-f]{12}$/);
  // No ##[error], or no group before it: the whole log, as before.
  assert.deepEqual(failingStep(["a", "b"]), ["a", "b"]);
  assert.deepEqual(failingStep(["x", "##[error]boom"]), ["x", "##[error]boom"]);
});

// ------------------------------------------------------------------ a required job GitHub never started (#2676)

// The real one: clockgrove/clockgrove's `quality` job while its Actions were locked for billing (no step, no runner).
const locked = JSON.parse(fixture("../never-started/billing-locked.json"));
const ranAndFailed = { ...locked.job, steps: [{ name: "Run npm test", status: "completed", conclusion: "failure", number: 3 }], runner_id: 42, runner_name: "GitHub Actions 42" };

/** A GitHub API on fetch for one head: its check runs, and per check-run id the Actions job and its annotations. */
async function withGitHub({ runs, jobs, annotations = {} }, fn) {
  const realFetch = globalThis.fetch;
  const before = process.env.GITHUB_API_URL;
  process.env.GITHUB_API_URL = "https://github.test";
  const reads = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    reads.push(`${init.method || "GET"} ${u.pathname}`);
    const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    if (/\/commits\/[0-9a-f]+\/check-runs$/.test(u.pathname)) return json({ total_count: runs.length, check_runs: runs });
    let m = /\/actions\/jobs\/(\d+)$/.exec(u.pathname);
    if (m && typeof jobs[m[1]] === "number") return json({ message: "Resource not accessible by integration" }, jobs[m[1]]);
    if (m && jobs[m[1]]) return json(jobs[m[1]]);
    m = /\/check-runs\/(\d+)\/annotations$/.exec(u.pathname);
    if (m) return json(annotations[m[1]] ?? []);
    return json({ message: "Not Found" }, 404);
  };
  try {
    return await fn(reads);
  } finally {
    globalThis.fetch = realFetch;
    if (before === undefined) delete process.env.GITHUB_API_URL;
    else process.env.GITHUB_API_URL = before;
  }
}

test("neverStarted: a failed job with no step and no runner is infrastructure, decided on structure; a job that ran and failed is not", async () => {
  const { neverStarted, notStartedJobs, notStartedReason } = await import("../scripts/lib/triage.mjs");
  assert.equal(neverStarted(locked.job), true, "GitHub's own shape: steps [], runner_id 0, runner_name ''");
  assert.equal(neverStarted({ ...locked.job, runner_id: null, runner_name: null }), true, "a null runner is no runner");
  assert.equal(neverStarted(ranAndFailed), false, "it ran a step on a runner: the change may have broken it");
  assert.equal(neverStarted({ ...locked.job, steps: [], runner_id: 42, runner_name: "r" }), false, "a runner took it");
  assert.equal(neverStarted({ ...locked.job, conclusion: "success" }), false);
  assert.equal(neverStarted({ ...locked.job, steps: undefined }), false, "no steps field read is no answer");
  assert.equal(neverStarted(null), false);
  // The words never decide: the same job with any annotation, or none, is the same verdict.
  const repo = { full: "acme/app" };
  const at = (s) => `2026-11-10T01:36:${s}Z`;
  const run = (id, name, suite, started_at, completed_at) => ({ id, name, conclusion: "failure", suite, started_at, completed_at });
  await withGitHub({ runs: [], jobs: { 1: locked.job, 2: ranAndFailed, 3: { ...locked.job, name: "build-m" } }, annotations: { 1: locked.annotations, 3: [{ annotation_level: "failure", message: "No runner matches the label ubuntu-latest-m." }] } }, async () => {
    const one = await notStartedJobs({ repo, failedRuns: [run(1, "quality", 9, at(34), at(36))], required: ["quality"], token: "t" });
    assert.deepEqual(one, [{ id: 1, name: "quality", check: "quality", annotation: "The job was not started because your account is locked due to a billing issue." }]);
    assert.equal(notStartedReason(one), "GitHub did not start the required job quality: The job was not started because your account is locked due to a billing issue.");
    assert.deepEqual(await notStartedJobs({ repo, failedRuns: [run(2, "quality", 9, at(34), at(36))], required: ["quality"], token: "t" }), [], "a job that ran goes to triage as before");
    assert.deepEqual(await notStartedJobs({ repo, failedRuns: [run(3, "build-m", 9, at(34), at(36))], required: ["quality"], token: "t" }), [], "an optional job that never started holds no required check red");
    // A larger-runner job no runner serves, gathered by a required aggregate that ran after it and failed.
    const gathered = await notStartedJobs({ repo, failedRuns: [run(2, "gate", 9, at(40), at(45)), run(3, "build-m", 9, at(34), at(36))], required: ["gate"], token: "t" });
    assert.equal(notStartedReason(gathered), "GitHub did not start the required job build-m (needed by the required check gate): No runner matches the label ubuntu-latest-m.");
    assert.deepEqual(await notStartedJobs({ repo, failedRuns: [run(99, "quality", 9, at(34), at(36))], required: ["quality"], token: "t" }), [], "a check that is no readable Actions job is none");
  });
});

test("validation loop: a required job GitHub never started gets no triage and no fix pass and Blocks quoting GitHub; a job that ran and failed is triaged and fixed as before", async () => {
  const { validationLoop } = await import("../scripts/lib/session.mjs");
  const { decideExit } = await import("../scripts/lib/logic.mjs");
  const sha = "a".repeat(40);
  const repo = { owner: "acme", name: "app", full: "acme/app" };
  const checkRun = { id: 1, name: "quality", status: "completed", conclusion: "failure", check_suite: { id: 9 }, started_at: locked.job.started_at, completed_at: locked.job.completed_at };
  const loop = async (job) => {
    const triaged = [];
    const phases = [];
    const result = await withGitHub({ runs: [checkRun], jobs: { 1: job }, annotations: { 1: locked.annotations } }, () =>
      validationLoop({
        checkout: "/nonexistent",
        commands: [],
        harness: "codex",
        maxUsd: 0,
        session: {},
        taskCard: "",
        env: process.env,
        // Under a minute left: a fix pass is reached but never started (it returns the time cap instead of running a harness).
        deadlineAt: Date.now() + 30_000,
        checks: { repo, issue: 4, prNumber: 5, names: ["quality"], token: "t" },
        outbox: { push: async () => true, expected: () => sha },
        triage: { red: async (r) => (triaged.push(r.failedRuns.map((f) => f.name)), { rerun: false }) },
        onPhase: async (l) => phases.push(l),
      }),
    );
    return { result, triaged, phases };
  };

  const stuck = await loop(locked.job);
  const reason = "GitHub did not start the required job quality: The job was not started because your account is locked due to a billing issue.";
  assert.equal(stuck.result.notStarted, reason);
  assert.equal(stuck.result.harness, undefined, "no fix pass was reached");
  assert.equal(stuck.result.passes, 1);
  assert.deepEqual(stuck.triaged, [], "never asked as change_caused or flaky: no triage, no rerun");
  assert.ok(stuck.phases.includes(`validation pass 1 red: ${reason}; infrastructure, no fix run`), stuck.phases.join("\n"));
  const exit = decideExit({ harness: { ok: true }, pr: { exists: true, draft: false, body: "" }, commits: 1, validation: { passes: stuck.result.passes, green: false, notStarted: stuck.result.notStarted } });
  assert.deepEqual(exit, { exit: "blocked", reason, cause: "outage" });

  const real = await loop(ranAndFailed);
  assert.equal(real.result.notStarted, undefined);
  assert.deepEqual(real.triaged, [["quality"]], "a job that ran and failed is triaged");
  assert.deepEqual(real.result.harness, { timedOut: true }, "and goes on to the fix pass");
  assert.ok(real.phases.some((l) => /red: required checks quality on a{7}; fix run$/.test(l)), real.phases.join("\n"));
});

test("notStartedJobs: a required aggregate red from a gathered job that ran is the change's, never pinned on one that never started", async () => {
  const { notStartedJobs } = await import("../scripts/lib/triage.mjs");
  const repo = { full: "acme/app" };
  const at = (s) => `2026-11-10T01:36:${s}Z`;
  const run = (id, name, suite, started_at, completed_at) => ({ id, name, conclusion: "failure", suite, started_at, completed_at });
  // Suite 9: docs never started (a larger runner gone), test ran and failed on the branch's code, the required gate
  // gathers both and failed. The red in test is a fix pass's, never a Block pinned on docs.
  await withGitHub({ runs: [], jobs: { 1: { ...locked.job, name: "docs" }, 2: { ...ranAndFailed, name: "test" }, 3: { ...ranAndFailed, name: "gate" } }, annotations: { 1: locked.annotations } }, async () => {
    const failedRuns = [run(1, "docs", 9, at(34), at(36)), run(2, "test", 9, at(34), at(50)), run(3, "gate", 9, at(52), at(55))];
    assert.deepEqual(await notStartedJobs({ repo, failedRuns, required: ["gate"], token: "t" }), [], "a gathered job ran and failed: triage and the fix pass");
    assert.deepEqual((await notStartedJobs({ repo, failedRuns: [failedRuns[0], failedRuns[2]], required: ["gate"], token: "t" })).map((j) => `${j.name}<-${j.check}`), ["docs<-gate"], "every gathered job never started: Blocked");
  });
});

test("notStartedJobs: the required check is found past the read cap; only candidates are read", async () => {
  const { notStartedJobs } = await import("../scripts/lib/triage.mjs");
  const repo = { full: "acme/app" };
  const at = (s) => `2026-11-10T01:36:${s}Z`;
  const run = (id, name, suite, started_at, completed_at) => ({ id, name, conclusion: "failure", suite, started_at, completed_at });
  // Eleven matrix jobs and the required ci listed twelfth, all never started: ci is read, past the cap of the others.
  const matrix = Array.from({ length: 11 }, (_, i) => run(10 + i, `matrix (${i})`, 9, at(34), at(36)));
  const jobs = Object.fromEntries([...matrix.map((r) => [r.id, { ...locked.job, name: r.name }]), [30, { ...locked.job, name: "ci" }]]);
  await withGitHub({ runs: [], jobs, annotations: { 30: locked.annotations } }, async (reads) => {
    const out = await notStartedJobs({ repo, failedRuns: [...matrix, run(30, "ci", 9, at(34), at(36))], required: ["ci"], token: "t" });
    assert.deepEqual(out.map((j) => j.name), ["ci"]);
    assert.ok(!reads.some((r) => /\/actions\/jobs\/1\d$/.test(r)), "an optional job holding no required check is not read");
  });
});

test("notStartedJobs: a job the token cannot read (403) is skipped, and the log says so", async () => {
  const { notStartedJobs } = await import("../scripts/lib/triage.mjs");
  const repo = { full: "acme/app" };
  const at = (s) => `2026-11-10T01:36:${s}Z`;
  const run = (id, name, suite, started_at, completed_at) => ({ id, name, conclusion: "failure", suite, started_at, completed_at });
  // No actions: read on the token (403): skipped, and the log says so.
  const said = [];
  const write = process.stdout.write;
  process.stdout.write = (chunk, ...rest) => (said.push(String(chunk)), write.call(process.stdout, chunk, ...rest));
  try {
    await withGitHub({ runs: [], jobs: { 1: 403 } }, async () => {
      assert.deepEqual(await notStartedJobs({ repo, failedRuns: [run(1, "quality", 9, at(34), at(36))], required: ["quality"], token: "t" }), []);
    });
  } finally {
    process.stdout.write = write;
  }
  assert.ok(said.includes("[factory] job 1 (quality) unreadable (403): never-started check skipped\n"), said.join(""));
});

// ------------------------------------------------------------------ a flaky red whose rerun GitHub refused (#74)

const supplyChain = "AssertionError [ERR_ASSERTION]: 2 supply-chain failures: registry.npmjs.org ECONNRESET";
// The failing job: its failure line, then unrelated stderr long enough to push it out of a tail, then GitHub's error.
const failingLog = ["##[group]Run npm test", "ok 1 - lockfile parses", "# Subtest: supply-chain policy", `  ${supplyChain}`, ...Array.from({ length: 40 }, (_, i) => `ok ${i + 3} - an unrelated check printed its own stderr here, line ${i}`), "##[error]Process completed with exit code 1.", "##[group]Post job cleanup.", ...Array.from({ length: 30 }, (_, i) => `/usr/bin/git config --local --unset-all http.https://github.com/.extraheader ${i}`)].join("\n");
// The required aggregate: no failure of its own, then actions/checkout's post-job cleanup.
const aggregateLog = ['##[group]Run test "$RESULT" = success', 'test "$RESULT" = success', "##[error]Process completed with exit code 1.", "##[group]Post job cleanup.", ...Array.from({ length: 40 }, (_, i) => `[command]/usr/bin/git config --local --name-only --get-regexp core\\.sshCommand ${i}`)].join("\n");

/** GitHub on fetch for a red head: check runs, jobs (with their workflow run), logs, and the rerun's answer. */
async function withRed({ runs, jobs = {}, logs = {}, rerun = 403 }, fn) {
  const realFetch = globalThis.fetch;
  const before = process.env.GITHUB_API_URL;
  process.env.GITHUB_API_URL = "https://github.test";
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || "GET";
    const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    if (/\/commits\/[0-9a-f]+\/check-runs$/.test(u.pathname)) return json({ total_count: runs.length, check_runs: runs });
    let m = /\/actions\/jobs\/(\d+)\/logs$/.exec(u.pathname);
    if (m) return new Response(logs[m[1]] ?? "", { status: 200 });
    m = /\/actions\/jobs\/(\d+)$/.exec(u.pathname);
    if (m && jobs[m[1]]) return json(jobs[m[1]]);
    if (/\/actions\/runs\/\d+$/.test(u.pathname)) return json({ status: "completed" });
    if (method === "POST" && /\/actions\/runs\/\d+\/rerun-failed-jobs$/.test(u.pathname)) return json({ message: "Resource not accessible by personal access token" }, rerun);
    if (/\/issues\/\d+\/comments$/.test(u.pathname) || /\/pulls\/\d+\/files$/.test(u.pathname)) return json([]);
    return json({ message: "Not Found" }, 404);
  };
  try {
    return await fn();
  } finally {
    globalThis.fetch = realFetch;
    if (before === undefined) delete process.env.GITHUB_API_URL;
    else process.env.GITHUB_API_URL = before;
  }
}

test("triage: a flaky verdict whose rerun GitHub refuses comes back with the verdicts, the failure lines and the refusal", async () => {
  const repo = { owner: "acme", name: "app", full: "acme/app" };
  const failedRuns = [{ id: 21, name: "test", conclusion: "failure", suite: 9, started_at: "2026-11-10T01:00:00Z", completed_at: "2026-11-10T01:05:00Z" }];
  const decider = { decide: async () => ({ verdict: "flaky_or_infra", confidence: 0.99 }) };
  await withRed({ runs: [], jobs: { 21: { id: 21, run_id: 500 } }, logs: { 21: failingLog } }, async () => {
    const t = openTriage({ inputs: {}, env: {}, repo, issue: 1, prNumber: 2, token: "t", decider });
    const r = await t.red({ sha: "b".repeat(40), failedRuns, required: ["test"] });
    assert.equal(r.rerun, false);
    assert.deepEqual({ ...r.refused, jobs: r.refused.jobs.map(({ name, verdict, confidence, line }) => ({ name, verdict, confidence, line })) }, { status: 403, permission: true, rateLimited: false, where: "local", jobs: [{ name: "test", verdict: "flaky_or_infra", confidence: 0.99, line: supplyChain }] });
  });
});

test("the last red, triaged flaky with its rerun refused, Blocks naming the verdict, the refusal and the remedy, quoting the failing job's own line first", async () => {
  const { validationLoop, DETAIL_CHARS } = await import("../scripts/lib/session.mjs");
  const { decideExit } = await import("../scripts/lib/logic.mjs");
  const { refusedRerunText } = await import("../scripts/lib/triage.mjs");
  const sha = "c".repeat(40);
  const repo = { owner: "acme", name: "app", full: "acme/app" };
  const runs = [
    { id: 31, name: "test", status: "completed", conclusion: "failure", check_suite: { id: 9 }, started_at: "2026-11-10T01:00:00Z", completed_at: "2026-11-10T01:05:00Z" },
    { id: 32, name: "quality", status: "completed", conclusion: "failure", check_suite: { id: 9 }, started_at: "2026-11-10T01:05:10Z", completed_at: "2026-11-10T01:05:20Z" },
  ];
  const refused = { status: 403, permission: true, where: "local", jobs: [{ name: "test", verdict: "flaky_or_infra", confidence: 0.99, line: supplyChain, lines: [supplyChain] }] };
  const result = await withRed({ runs, logs: { 31: failingLog, 32: aggregateLog } }, () =>
    validationLoop({
      checkout: "/nonexistent",
      commands: [],
      harness: "codex",
      maxUsd: 0,
      session: {},
      taskCard: "",
      env: process.env,
      deadlineAt: Date.now() + 30_000,
      // The red is on the last allowed pass: no fix pass follows it.
      maxPasses: 0,
      checks: { repo, issue: 4, prNumber: 5, names: ["quality"], token: "t" },
      outbox: { push: async () => true, expected: () => sha },
      triage: { red: async () => ({ rerun: false, refused }) },
    }),
  );
  assert.equal(result.green, false);
  assert.equal(result.harness, undefined);
  assert.equal(result.triageRefused, refusedRerunText(refused));
  const exit = decideExit({ harness: { ok: true }, pr: { exists: true, draft: true, body: "" }, commits: 1, validation: { passes: result.passes, green: false, command: result.command, triageRefused: result.triageRefused } });
  assert.equal(exit.reason, "validation red after Factory's first pass (required checks quality on ccccccc); red-check triage read it as a flake or infrastructure (test: flaky_or_infra 0.99), but GitHub refused the rerun (403: the token cannot rerun jobs); rerun the failed jobs on GitHub, or give the token Actions read and write, then re-apply the label");
  // What the Blocked notice quotes (applyExit keeps the last DETAIL_CHARS): the failing job's own line leads it.
  const shown = result.lastOutput.slice(-2500);
  assert.equal(DETAIL_CHARS, 2500);
  assert.ok(shown.startsWith(`--- test: ${supplyChain}`), shown.slice(0, 300));
  assert.ok(!/^--- quality/m.test(shown.split("\n\n")[0]), "the aggregate printed no failure of its own: it does not lead");
  // On Actions the grant is the workflow's, and a refusal that is no 403 names no permission.
  assert.match(refusedRerunText({ ...refused, where: "actions" }), /or give the workflow's work and review jobs `actions: write`, then/);
  assert.match(refusedRerunText({ ...refused, status: 404, permission: false }), /refused the rerun \(404\); rerun the failed jobs on GitHub then re-apply the label$/);
});

// ------------------------------------------------------------------ a red on GitHub's side (#165)

// GitHub's jobs API for a job whose checkout failed: Set up job passed, the checkout step failed, the rest skipped.
const checkoutFailed = { id: 41, run_id: 600, name: "quality", conclusion: "failure", runner_id: 7, runner_name: "GitHub Actions 7", steps: [
  { name: "Set up job", status: "completed", conclusion: "success", number: 1 },
  { name: "Run actions/checkout@v4", status: "completed", conclusion: "failure", number: 2 },
  { name: "Run npm test", status: "completed", conclusion: "skipped", number: 3 },
  { name: "Post Run actions/checkout@v4", status: "completed", conclusion: "success", number: 5 },
  { name: "Complete job", status: "completed", conclusion: "success", number: 6 },
] };
const setupFailed = { ...checkoutFailed, steps: [{ name: "Set up job", status: "completed", conclusion: "failure", number: 1 }, { name: "Run actions/checkout@v4", status: "completed", conclusion: "skipped", number: 2 }] };
const testFailed = { ...checkoutFailed, steps: [{ name: "Set up job", status: "completed", conclusion: "success", number: 1 }, { name: "Run actions/checkout@v4", status: "completed", conclusion: "success", number: 2 }, { name: "Run npm test", status: "completed", conclusion: "failure", number: 3 }] };
const CI_YML = "on: pull_request\njobs:\n  quality:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n        with:\n          lfs: true\n      - name: Fetch media\n        uses: actions/checkout@v4\n      - run: npm test\n";
const lfsLog = ["##[group]Run actions/checkout@v4", "##[group]Fetching LFS objects", "[command]/usr/bin/git lfs fetch origin refs/remotes/pull/9/merge", "batch response: Fatal error: Server error https://github.com/acme/app.git/info/lfs/objects/batch from HTTP 502", "##[error]The process '/usr/bin/git' failed with exit code 2"].join("\n");

/**
 * GitHub on fetch for one red head, before and after a rerun: `runs` the head's check runs (`rerunRuns` once a rerun was
 * accepted), `jobs` by id, `logs` by job id, the workflow file at the head, and the rerun's answer (`rerun`, a status).
 */
async function withHead({ runs, rerunRuns = runs, jobs = {}, logs = {}, workflow = CI_YML, rerun = 201 }, fn) {
  const realFetch = globalThis.fetch;
  const before = process.env.GITHUB_API_URL;
  process.env.GITHUB_API_URL = "https://github.test";
  const seen = { reruns: 0, contents: 0 };
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const p = u.pathname;
    const method = init.method || "GET";
    const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    if (/\/commits\/[0-9a-f]+\/check-runs$/.test(p)) {
      const now = seen.reruns ? rerunRuns : runs;
      return json({ total_count: now.length, check_runs: now });
    }
    let m = /\/actions\/jobs\/(\d+)\/logs$/.exec(p);
    if (m) return new Response(logs[m[1]] ?? "", { status: 200 });
    m = /\/actions\/jobs\/(\d+)$/.exec(p);
    if (m && jobs[m[1]]) return json(jobs[m[1]]);
    if (method === "POST" && /\/actions\/runs\/\d+\/rerun-failed-jobs$/.test(p)) {
      if (rerun >= 400) return json({ message: "Resource not accessible by integration" }, rerun);
      seen.reruns += 1;
      return json({}, rerun);
    }
    if (/\/actions\/runs\/\d+$/.test(p)) return json({ status: "completed", path: ".github/workflows/ci.yml" });
    if (/\/contents\/\.github\/workflows\/ci\.yml$/.test(p)) return (seen.contents += 1), new Response(workflow, { status: 200 });
    if (/\/issues\/\d+\/comments$/.test(p) || /\/pulls\/\d+\/files$/.test(p)) return json([]);
    return json({ message: "Not Found" }, 404);
  };
  try {
    return await fn(seen);
  } finally {
    globalThis.fetch = realFetch;
    if (before === undefined) delete process.env.GITHUB_API_URL;
    else process.env.GITHUB_API_URL = before;
  }
}

/** A decider that records each question and answers `answer`; the real decision model is never called. */
const asking = (answer) => {
  const asked = [];
  return { asked, decide: async (input) => (asked.push(input), answer) };
};
const repo165 = { owner: "acme", name: "app", full: "acme/app" };
const red41 = [{ id: 41, name: "quality", conclusion: "failure", suite: 9, started_at: "2026-11-11T21:55:00Z", completed_at: "2026-11-11T21:57:00Z" }];

test("setupFailure: a job that failed in its set-up or its checkout, with no step of the repository's failed, is decided on the jobs API's steps and the workflow's uses", async () => {
  const { checkoutSteps, failedStep, setupFailure } = await import("../scripts/lib/triage.mjs");
  assert.deepEqual([...checkoutSteps(CI_YML, "quality")], ["Run actions/checkout@v4", "Fetch media"]);
  assert.deepEqual([...checkoutSteps(CI_YML, "other")], [], "another job's steps are not this one's");
  assert.equal(failedStep(checkoutFailed).name, "Run actions/checkout@v4");
  assert.equal(setupFailure(checkoutFailed, CI_YML), "checkout");
  assert.equal(setupFailure(setupFailed, null), "set-up", "GitHub's own first step: no workflow needed");
  assert.equal(setupFailure({ ...checkoutFailed, steps: checkoutFailed.steps.map((x) => (x.number === 2 ? { ...x, name: "Fetch media" } : x)) }, CI_YML), "checkout", "a named checkout step");
  assert.equal(setupFailure(testFailed, CI_YML), null, "a run: step failed: the change's code ran");
  assert.equal(setupFailure(checkoutFailed, "jobs:\n  quality:\n    steps:\n      - run: ./checkout.sh\n"), null, "a step named like checkout that is no actions/checkout is not one");
  assert.equal(setupFailure(checkoutFailed, ""), null, "an unread workflow proves nothing");
  assert.equal(setupFailure({ ...checkoutFailed, steps: [...checkoutFailed.steps.slice(0, 2), { name: "Run npm test", conclusion: "failure", number: 3 }] }, CI_YML), null, "a run: step failed as well");
  // The failed step's name is part of what the model is asked.
  assert.match(triageInput({ repo: "acme/app", prNumber: 2, sha: "a".repeat(40), job: "quality", step: "Run npm test", excerpt: "x" }), /^Failing CI job: quality\nFailed step: Run npm test$/m);
  assert.doesNotMatch(triageInput({ repo: "acme/app", prNumber: 2, sha: "a".repeat(40), job: "quality", excerpt: "x" }), /Failed step/);
});

test("triage: a checkout or set-up failure is rerun once on its head without the decision model; a run: step failure is asked, with its step's name", async () => {
  for (const job of [checkoutFailed, setupFailed]) {
    const decider = asking({ verdict: "change_caused", confidence: 0.99 });
    const lines = [];
    await withHead({ runs: [], jobs: { 41: job }, logs: { 41: lfsLog } }, async (seen) => {
      const t = openTriage({ inputs: {}, env: {}, repo: repo165, issue: 1, prNumber: 2, token: "t", decider, progress: async (l) => lines.push(l) });
      const r = await t.red({ sha: "d".repeat(40), failedRuns: red41, required: ["quality"] });
      assert.equal(r.rerun, true);
      assert.equal(seen.reruns, 1);
      assert.equal(decider.asked.length, 0, "no model asked");
      assert.equal(seen.contents, job === setupFailed ? 0 : 1, "the workflow is read only to tell a checkout step");
      assert.match(lines[0], new RegExp(`quality: failed in its ${job === setupFailed ? "set-up step \\(Set up job\\)" : "checkout step \\(Run actions/checkout@v4\\)"}, no model asked \\[[0-9a-f]{12} \`batch response: Fatal error`));
      // Once per head: the same head is not rerun again.
      assert.equal((await t.red({ sha: "d".repeat(40), failedRuns: red41, required: ["quality"] })).rerun, false);
      assert.equal(seen.reruns, 1);
    });
  }
  const decider = asking({ verdict: "flaky_or_infra", confidence: 0.55 });
  await withHead({ runs: [], jobs: { 41: testFailed }, logs: { 41: failingLog } }, async (seen) => {
    const t = openTriage({ inputs: {}, env: {}, repo: repo165, issue: 1, prNumber: 2, token: "t", decider });
    assert.equal((await t.red({ sha: "d".repeat(40), failedRuns: red41, required: ["quality"] })).rerun, false, "below the bar: fix pass");
    assert.equal(seen.reruns, 0);
    assert.equal(decider.asked.length, 1);
    assert.match(decider.asked[0], /^Failed step: Run npm test$/m);
  });
});

test("failureSignature: Git LFS's own failure lines are a signature, also behind a tool's prefix", () => {
  const sig = failureSignature("quality", lfsLog);
  assert.ok(sig.id);
  assert.match(sig.line, /^batch response: Fatal error: Server error/);
  assert.match(failureSignature("quality", "##[group]Run ./setup.sh\nError downloading object: assets/yard.png (4f2a9c1): Smudge error: Error downloading assets/yard.png\n##[error]Process completed with exit code 2.").line, /^Error downloading object: assets\/yard\.png/);
  assert.ok(failureSignature("quality", "##[group]Run pnpm quality\nquality:media: batch response: Fatal error: Server error from HTTP 502\n##[error]Process completed with exit code 2.").id);
  assert.equal(failureSignature("quality", "##[group]Run npm test\nbatch processing done\n##[error]Process completed with exit code 1.").id, null, "the words alone are no LFS line");
});

test("again: the failed jobs of a head a fix pass left unchanged are rerun once, no model asked, with or without a key; a refusal is named", async () => {
  const decider = asking({ verdict: "flaky_or_infra", confidence: 0.99 });
  await withHead({ runs: [], jobs: { 41: testFailed } }, async (seen) => {
    const t = openTriage({ inputs: {}, env: {}, repo: repo165, issue: 1, prNumber: 2, token: "t", decider });
    const r = await t.again({ sha: "e".repeat(40), failedRuns: red41 });
    assert.equal(r.rerun, true);
    assert.deepEqual([...r.ignoreIds], [41]);
    assert.equal(decider.asked.length, 0);
    assert.deepEqual(await t.again({ sha: "e".repeat(40), failedRuns: red41 }), { rerun: false, already: true }, "once per head");
    assert.equal((await t.red({ sha: "e".repeat(40), failedRuns: red41, required: ["quality"] })).rerun, false, "the head's one rerun is shared with red()");
    assert.equal(seen.reruns, 1);
  });
  // No key: red() is off, but the unchanged head's rerun needs no model.
  const home = mkdtempSync(join(tmpdir(), "nokey-"));
  await withHead({ runs: [], jobs: { 41: testFailed }, rerun: 403 }, async () => {
    const t = openTriage({ inputs: {}, env: {}, home, repo: repo165, issue: 1, prNumber: 2, token: "t" });
    assert.equal(t.off, "no-key");
    const r = await t.again({ sha: "e".repeat(40), failedRuns: red41 });
    assert.equal(r.rerun, false);
    assert.deepEqual(r.refused, { status: 403, permission: true, rateLimited: false, where: "local", unchanged: true });
    const { refusedRerunText } = await import("../scripts/lib/triage.mjs");
    assert.equal(refusedRerunText(r.refused), "GitHub refused the rerun of the failed jobs (403: the token cannot rerun jobs); rerun the failed jobs on GitHub, or give the token Actions read and write, then re-apply the label");
    assert.equal((await t.again({ sha: "f".repeat(40), failedRuns: red41 })).refused.earlier, true, "refused once on the Objective: not asked again");
  });
  rmSync(home, { recursive: true, force: true });
});

/**
 * A fix pass that commits nothing: a fake `codex` on PATH that ends its turn and changes no file. Returns the env for
 * the loop and a put-back.
 */
function idleCodex() {
  const work = mkdtempSync(join(tmpdir(), "idle-codex-"));
  mkdirSync(join(work, "bin"));
  writeFileSync(join(work, "bin", "codex"), `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(`${JSON.stringify({ type: "thread.started", thread_id: "t-165" })}\n${JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 1 } })}\n`)});\n`, { mode: 0o755 });
  const saved = { PATH: process.env.PATH, CODEX_HOME: process.env.CODEX_HOME };
  process.env.PATH = `${join(work, "bin")}:${saved.PATH}`;
  process.env.CODEX_HOME = join(work, "codex");
  const env = { PATH: process.env.PATH, CODEX_HOME: process.env.CODEX_HOME };
  return {
    work,
    env,
    putBack: () => {
      for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
      else process.env[k] = v;
      rmSync(work, { recursive: true, force: true });
    },
  };
}

test("validation loop: a fix pass that commits nothing never counts the same red twice; the head's failed jobs are rerun once, and a red or refused rerun Blocks saying so", async () => {
  const { validationLoop } = await import("../scripts/lib/session.mjs");
  const { decideExit } = await import("../scripts/lib/logic.mjs");
  const { refusedRerunText } = await import("../scripts/lib/triage.mjs");
  const sha = "9".repeat(40);
  const red = [{ id: 51, name: "quality", status: "completed", conclusion: "failure", check_suite: { id: 9 }, started_at: "2026-11-11T21:55:00Z", completed_at: "2026-11-11T21:57:00Z" }];
  const rerunRed = [{ ...red[0], id: 52 }];
  const rerunGreen = [{ ...red[0], id: 52, conclusion: "success" }];
  // Job ids of its own: a job log once read is not read again in this process (github.mjs jobLog).
  // The real run: the model reads the red as flaky, below the bar (0.55), so a fix pass runs, and it commits nothing.
  const run = async (github, { jobs = { 51: testFailed, 52: testFailed }, key = true } = {}) => {
    const codex = idleCodex();
    const home = mkdtempSync(join(tmpdir(), "nokey-"));
    const decider = asking({ verdict: "flaky_or_infra", confidence: 0.55 });
    const phases = [];
    try {
      const result = await withHead({ runs: red, jobs, logs: { 51: failingLog, 52: failingLog }, ...github }, (seen) =>
        validationLoop({
          checkout: codex.work,
          commands: [],
          harness: "codex",
          maxUsd: 0,
          session: {},
          taskCard: "",
          env: codex.env,
          deadlineAt: Date.now() + 10 * 60_000,
          checks: { repo: repo165, issue: 4, prNumber: 5, names: ["quality"], token: "t", appearMs: 0, pollMs: 1, timeoutMs: 2000 },
          outbox: { push: async () => true, expected: () => sha },
          triage: openTriage({ inputs: {}, env: {}, home, repo: repo165, issue: 4, prNumber: 5, token: "t", ...(key ? { decider } : {}) }),
          onPhase: async (l) => phases.push(l),
        }).then((r) => ({ ...r, reruns: seen.reruns })),
      );
      return { result, phases, asked: decider.asked.length };
    } finally {
      codex.putBack();
      rmSync(home, { recursive: true, force: true });
    }
  };

  const again = await run({ rerunRuns: rerunRed });
  assert.equal(again.result.green, false);
  assert.equal(again.result.usage.length, 1, "one fix pass, as before");
  assert.equal(again.result.passes, 1, "the unchanged head is not a second pass");
  assert.equal(again.asked, 1, "the same red is not asked of the model again");
  assert.equal(again.result.reruns, 1, "its failed jobs were rerun once");
  assert.deepEqual(again.result.unchanged, { reason: `the fix pass changed nothing, so the red on 9999999 is unchanged (quality: ${supplyChain}); its failed jobs were rerun once and failed again; read the failing job on GitHub, fix the cause on the branch or rerun the failed jobs there, then re-apply the label`, cause: "work" }, "a run: step failed: the work's");
  assert.ok(again.result.lastOutput.startsWith(`--- quality: ${supplyChain}`), "the Block quotes the failure's lead");
  assert.deepEqual(decideExit({ harness: { ok: true }, pr: { exists: true, draft: true, body: "" }, commits: 1, validation: { passes: again.result.passes, green: false, command: again.result.command, unchanged: again.result.unchanged } }), { exit: "blocked", ...again.result.unchanged });
  // What a person reads in the log is true: no second pass, the rerun named.
  assert.ok(!again.phases.some((l) => /validation pass 2/.test(l)), again.phases.join("\n"));
  assert.ok(again.phases.includes("validation: the fix pass changed nothing; rerunning the failed jobs on 9999999"), again.phases.join("\n"));

  // Checkout failed, with no key (so the first red goes to the fix pass), and the rerun fails in its checkout again: GitHub's side.
  const outage = await run({ rerunRuns: rerunRed }, { jobs: { 51: checkoutFailed, 52: checkoutFailed }, key: false });
  assert.equal(outage.result.reruns, 1);
  assert.equal(outage.result.unchanged.cause, "outage");
  assert.match(outage.result.unchanged.reason, /rerun once and failed again, again in their set-up or checkout \(GitHub's side\)/);
  // A checkout red the first time, a test red after the rerun: not the same way, so the work's.
  assert.equal((await run({ rerunRuns: rerunRed }, { jobs: { 51: checkoutFailed, 52: testFailed }, key: false })).result.unchanged.cause, "work");

  const green = await run({ rerunRuns: rerunGreen });
  assert.equal(green.result.green, true, "the rerun passed: the stage goes on");
  assert.equal(green.result.passes, 1);
  assert.equal(green.result.usage.length, 1);

  const refused = await run({ rerun: 403 });
  assert.equal(refused.result.reruns, 0);
  assert.deepEqual(refused.result.unchanged, { reason: `the fix pass changed nothing, so the red on 9999999 is unchanged (quality: ${supplyChain}); ${refusedRerunText({ status: 403, permission: true, where: "local", unchanged: true })}`, cause: "setup" });
  assert.match(refused.result.unchanged.reason, /GitHub refused the rerun of the failed jobs \(403: the token cannot rerun jobs\)/);
});
