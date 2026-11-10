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
  assert.deepEqual(exit, { exit: "blocked", reason });

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
