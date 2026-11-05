import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { appJwt, normalizePem } from "../scripts/lib/app-token.mjs";
import { input, parseArgs, resolveInputs } from "../scripts/lib/inputs.mjs";
import { decideExit, diffLines, isPlaceholder, marker, parseExitRecord, parseFindings, snapComments } from "../scripts/lib/logic.mjs";
import { renderWorkflow } from "../scripts/setup.mjs";

const ok = { ok: true };
const pr = (body = "## Acceptance\nok", draft = false) => ({ exists: true, draft, body });

test("delivered: PR open, validation green, nothing unaddressed", () => {
  assert.deepEqual(decideExit({ harness: ok, pr: pr(), commits: 3, validation: { passes: 1, green: true } }), { exit: "delivered", reason: "" });
});

test("question: the harness's exit record says so; the PR body is never read", () => {
  const green = { passes: 1, green: true };
  const record = { exit: "question", reason: "", questions: ["is this wire shape acceptable?"] };
  assert.deepEqual(decideExit({ harness: ok, pr: pr(), commits: 1, validation: green, record }), { exit: "question", reason: "question: is this wire shape acceptable?" });
  assert.equal(decideExit({ harness: ok, pr: pr("## Assumptions\n1. QUESTION: does the API change?"), commits: 1, validation: green, record: { exit: "delivered", reason: "", questions: [] } }).exit, "delivered", "the word in the body decides nothing");
  assert.equal(decideExit({ harness: ok, pr: pr("1. Resolved (was a QUESTION)."), commits: 1, validation: green, record: null }).exit, "delivered");
  assert.equal(decideExit({ harness: ok, pr: pr(), commits: 1, validation: green, record, question: false }).exit, "delivered", "the review job's draft state overrides");
});

test("parseExitRecord: the first JSON object with a known exit, from a file or a harness answer", () => {
  assert.deepEqual(parseExitRecord('{"exit":"question","questions":["which port?"],"reason":""}'), { exit: "question", reason: "", questions: ["which port?"] });
  assert.deepEqual(parseExitRecord('Sure, here it is:\n```json\n{"exit": "delivered"}\n```'), { exit: "delivered", reason: "", questions: [] });
  assert.deepEqual(parseExitRecord('{"note":"not an exit"} {"exit":"blocked","reason":"no credential","questions":[{"question":"q1"}]}'), { exit: "blocked", reason: "no credential", questions: ["q1"] });
  assert.equal(parseExitRecord('{"exit":"maybe"}'), null);
  assert.equal(parseExitRecord("QUESTION: prose only"), null);
  assert.equal(parseExitRecord(""), null);
  assert.equal(isPlaceholder("<!-- factory:placeholder -->\nFactory reviewer: no findings"), true);
  assert.equal(isPlaceholder("No findings here"), false);
});

test("blocked: each reason in the worker contract, in priority order", () => {
  const green = { passes: 1, green: true };
  assert.equal(decideExit({ harness: { ok: false, died: 2 }, pr: pr(), commits: 1, validation: green }).reason, "worker process died twice");
  assert.equal(decideExit({ harness: { ok: false, timedOut: true }, pr: pr(), commits: 1, validation: green }).reason, "time cap reached");
  assert.equal(decideExit({ harness: { ok: false, budgetExceeded: true }, pr: pr(), commits: 1, validation: green }).reason, "dollar cap reached");
  assert.match(decideExit({ harness: ok, pr: pr(), commits: 1, validation: green, protectedHits: [".github/workflows/ci.yml"] }).reason, /touched protected path \.github\/workflows\/ci\.yml/);
  assert.equal(decideExit({ harness: ok, pr: null, commits: 0 }).reason, "worker ended without commits or a PR");
  assert.equal(decideExit({ harness: { ok: false, error: "boom" }, pr: null, commits: 0 }).reason, "worker ended without commits: boom");
  assert.equal(decideExit({ harness: ok, pr: null, commits: 2 }).reason, "no PR could be opened for the branch");
  assert.equal(decideExit({ harness: ok, pr: pr(), commits: 2, validation: { passes: 2, green: false } }).reason, "validation red after Factory's second pass");
  assert.equal(decideExit({ harness: ok, pr: pr(), commits: 2, validation: { passes: 1, green: false } }).reason, "validation red after Factory's first pass");
  assert.equal(decideExit({ harness: ok, pr: pr(), commits: 2, validation: green, reviewUnaddressed: 2 }).reason, "2 reviewer finding(s) unaddressed after the one pass");
  assert.equal(decideExit({ harness: ok, pr: pr(), commits: 2, validation: green, record: { exit: "blocked", reason: "The migration needs a credential the runner lacks.", questions: [] } }).reason, "worker blocked: The migration needs a credential the runner lacks.");
  assert.equal(decideExit({ harness: { ok: false, error: "harness error" }, pr: pr(), commits: 2, validation: green }).reason, "harness error");
});

test("a question with red validation is blocked, not question", () => {
  assert.equal(decideExit({ harness: ok, pr: pr(), commits: 1, validation: { passes: 2, green: false }, record: { exit: "question", reason: "", questions: ["x"] } }).exit, "blocked");
});

test("review: findings parse from a fenced block and snap to diff lines", () => {
  const diff = readFileSync(join(import.meta.dirname, "fixtures", "sample.diff"), "utf8");
  const lines = diffLines(diff);
  assert.deepEqual([...lines["src/a.ts"].lines].sort((a, b) => a - b), [1, 2, 3, 4, 5]);
  assert.equal(lines["src/a.ts"].first, 2);
  assert.equal(lines["src/new.ts"].first, 1);
  assert.equal(lines["old.ts"], undefined, "a deleted file has no right side");
  const findings = parseFindings('Here are my findings.\n```json\n{"comments":[{"path":"src/a.ts","line":3,"body":"acceptance 1: b is unused"},{"path":"src/a.ts","line":99,"body":"rule x"},{"path":"elsewhere.ts","line":1,"body":"acceptance 2"},{"body":""}]}\n```');
  assert.equal(findings.length, 4);
  const comments = snapComments(findings, diff);
  assert.deepEqual(comments, [
    { path: "src/a.ts", line: 3, side: "RIGHT", body: "acceptance 1: b is unused" },
    { path: "src/a.ts", line: 2, side: "RIGHT", body: "rule x" },
    { path: "src/a.ts", line: 1, side: "RIGHT", body: "acceptance 2 (on elsewhere.ts)" }, // line 1 is a context line in the hunk, so it is kept
  ]);
  assert.deepEqual(parseFindings("no json here"), []);
  assert.deepEqual(parseFindings('prose {"comments": [{"path":"a","line":1,"body":"x"}]}'), [{ path: "a", line: 1, body: "x" }]);
  assert.deepEqual(snapComments(findings, ""), []);
});

test("markers follow the 0.5 idempotent shape lane 1 adopted", () => {
  assert.equal(marker(811, "plan"), "<!-- factory:811:plan -->");
  assert.equal(marker(811, "blocked", "work"), "<!-- factory:811:blocked:work -->");
});

test("inputs: flag, then with:, then workflow env, then default; booleans and lists", () => {
  const env = { FACTORY_INPUT_MAX_USD: "", FACTORY_MAX_USD: "12", FACTORY_INPUT_HARNESS: "codex", FACTORY_VALIDATION: "a, b\nc", FACTORY_AUTO_MERGE: "false", GITHUB_REPOSITORY: "o/r" };
  assert.equal(input("max_usd", { env }), "12", "empty with: falls through to the env block");
  assert.equal(input("harness", { env }), "codex");
  assert.equal(input("harness", { env, args: { harness: "claude" } }), "claude");
  assert.equal(input("timeout_minutes", { env }), "240");
  const r = resolveInputs({ env, args: parseArgs(["--issue", "5", "--notify=@kirk", "--dry-run"]) });
  assert.equal(r.maxUsd, 12);
  assert.equal(r.autoMerge, false);
  assert.deepEqual(r.validation, ["a", "b", "c"]);
  assert.equal(r.issue, 5);
  assert.equal(r.notify, "kirk");
  assert.equal(r.repo, "o/r");
  assert.equal(r.model, "gpt-6.1-sol", "an empty model takes the harness default");
  assert.equal(r.reviewerModel, "gpt-6.1-sol", "reviewer_model defaults to the harness's reviewer default");
  const c = resolveInputs({ env: { GITHUB_REPOSITORY: "o/r" }, args: {} });
  assert.deepEqual([c.model, c.subagentModel, c.reviewerModel], ["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1"], "Claude: Opus worker, Sonnet implementers, Fable reviewer");
  assert.deepEqual(c.reviewerFallback, { model: "claude-opus-5-5", effort: "xhigh" });
});

test("workflow template renders with defaults for empty values and stays valid YAML-shaped", () => {
  const template = readFileSync(join(import.meta.dirname, "..", "workflow-template.yml"), "utf8");
  const out = renderWorkflow(template, { harness: "claude", max_concurrent: "4", timeout_minutes: "", runs_on: "ubuntu-latest", version: "v1" });
  assert.match(out, /FACTORY_HARNESS: claude/);
  assert.match(out, /max-parallel: 4/);
  assert.match(out, /timeout-minutes: 240/);
  assert.match(out, /uses: clockgrove\/factory@v0\.6/);
  assert.doesNotMatch(out, /\{\{\w+\}\}/, "every {{key}} placeholder rendered; ${{ }} expressions stay");
  assert.match(out, /contents: read/);
  assert.doesNotMatch(out, /contents: write/);
});

test("App JWT is RS256 with iss, iat and exp; a flattened PEM is restored", () => {
  const { generateKeyPairSync } = globalThis.process.getBuiltinModule("node:crypto");
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs1", format: "pem" });
  const flat = pem.replace(/\n/g, " ");
  assert.equal(normalizePem(flat).split("\n").length > 3, true);
  const jwt = appJwt("12345", flat, 1_700_000_000);
  const [h, p, s] = jwt.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(h, "base64url")), { alg: "RS256", typ: "JWT" });
  assert.deepEqual(JSON.parse(Buffer.from(p, "base64url")), { iat: 1_700_000_000 - 30, exp: 1_700_000_000 + 540, iss: "12345" });
  assert.ok(s.length > 300);
});

test("decideExit: a red validation names the command that failed", () => {
  const harness = { ok: true, died: 0 };
  const pr = { exists: true, draft: false, body: "## Assumptions\nnone" };
  assert.equal(decideExit({ harness, pr, commits: 1, validation: { passes: 2, green: false, command: "pnpm test" } }).reason, "validation red after Factory's second pass (pnpm test)");
  assert.equal(decideExit({ harness, pr, commits: 1, validation: { passes: 1, green: false } }).reason, "validation red after Factory's first pass");
});


test("evaluateChecks: required checks from a head's check-runs, latest run per name, missing is not red", async () => {
  const { evaluateChecks } = await import("../scripts/lib/logic.mjs");
  const runs = [
    { id: 1, name: "quality", status: "completed", conclusion: "failure", started_at: "2026-11-05T01:00:00Z" },
    { id: 2, name: "quality", status: "completed", conclusion: "success", started_at: "2026-11-05T02:00:00Z" },
    { id: 3, name: "tests", status: "in_progress", conclusion: null, started_at: "2026-11-05T02:00:00Z" },
  ];
  assert.deepEqual(evaluateChecks(["quality"], runs), { done: true, green: true, missing: [], failed: [], pending: [] });
  assert.deepEqual(evaluateChecks(["quality", "tests"], runs), { done: false, green: false, missing: [], failed: [], pending: ["tests"] });
  assert.deepEqual(evaluateChecks(["quality", "lint"], runs), { done: false, green: false, missing: ["lint"], failed: [], pending: [] });
  assert.deepEqual(evaluateChecks(["quality"], [runs[0]]), { done: true, green: false, missing: [], failed: [{ name: "quality", conclusion: "failure", id: 1 }], pending: [] });
  assert.deepEqual(evaluateChecks([], []), { done: true, green: true, missing: [], failed: [], pending: [] });
});

test("harnessActivity: turns, tool calls, sub-agents, tokens and the status line from the harness's own events", async () => {
  const { harnessActivity, activityLine } = await import("../scripts/lib/logic.mjs");
  let t = 0;
  const a = harnessActivity(() => t);
  const lines = [
    '{"type":"system","subtype":"init","model":"claude-opus-5-5"}',
    '{"type":"assistant","message":{"content":[{"type":"text","text":"Planning."},{"type":"tool_use","name":"Agent","input":{"subagent_type":"implementer","description":"Web: reducer"}}],"usage":{"input_tokens":2,"cache_read_input_tokens":13001,"cache_creation_input_tokens":11978,"output_tokens":3}}}',
    '{"type":"system","subtype":"task_started","task_id":"a1","description":"Web: reducer","subagent_type":"implementer"}',
    '{"type":"assistant","parent_tool_use_id":"toolu_1","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"pnpm test --filter web"}}],"usage":{"input_tokens":10,"output_tokens":5}}}',
    'not json',
    '{"type":"system","subtype":"task_notification","task_id":"a1","status":"completed"}',
  ];
  for (const l of lines) {
    t += 60_000;
    a.feed(l);
  }
  const snap = a.snapshot();
  assert.equal(snap.turns, 1, "a sub-agent's assistant message is not a turn");
  assert.equal(snap.toolCalls, 2);
  assert.equal(snap.lastTool, "Bash: pnpm test --filter web");
  assert.deepEqual([snap.subagentsActive.length, snap.subagentsDone], [0, 1]);
  assert.deepEqual(snap.tokens, { input: 24991, output: 8 });
  assert.equal(snap.events, 5);
  const line = activityLine(snap, { harness: "claude", model: "claude-opus-5-5" });
  assert.match(line, /^claude \(claude-opus-5-5\) working: 6 min, 1 turns, 2 tool calls; sub-agents 1 done; active now; 25k tokens in, 8 out; last tool Bash: pnpm test --filter web$/);
  t += 7 * 60_000;
  a.feed('{"type":"system","subtype":"task_started","task_id":"a2","description":"Runtime: journey test","subagent_type":"implementer"}');
  t += 5 * 60_000;
  assert.match(activityLine(a.snapshot(), { harness: "claude" }), /sub-agents 1 active \(implementer: Runtime: journey test, 5 min\), 1 done; last event 5 min ago/);
  a.feed('{"type":"result","total_cost_usd":1.25}');
  assert.match(activityLine(a.snapshot(), { harness: "claude" }), /finished: .*; ended; .*\$1\.25/);
  assert.equal(activityLine(harnessActivity(() => 0).snapshot(), { harness: "codex" }), "codex started 0 min ago; no event from it yet");
  const c = harnessActivity(() => 0);
  c.feed('{"type":"turn.started"}');
  c.feed('{"type":"item.started","item":{"type":"command_execution","command":"npm test"}}');
  c.feed('{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":50,"output_tokens":20,"reasoning_output_tokens":5}}');
  assert.deepEqual([c.snapshot().turns, c.snapshot().toolCalls, c.snapshot().lastTool, c.snapshot().tokens], [1, 1, "command: npm test", { input: 150, output: 25 }]);
});

test("exec: onLine sees each stdout line; a child silent for idleMs is killed and reported idle", async () => {
  const { exec } = await import("../scripts/lib/proc.mjs");
  const seen = [];
  const r = await exec(process.execPath, ["-e", "process.stdout.write('a\\nb'); setTimeout(() => process.stdout.write('c\\n'), 50)"], { onLine: (l) => seen.push(l) });
  assert.deepEqual([r.code, r.idle, seen], [0, false, ["a", "bc"]]);
  const hung = await exec(process.execPath, ["-e", "console.log('x'); setTimeout(() => {}, 60000)"], { idleMs: 300 });
  assert.equal(hung.idle, true);
  assert.ok(hung.signal, "killed by signal");
});

test("harnessActivity: background commands are counted apart from sub-agents", async () => {
  const { harnessActivity, activityLine } = await import("../scripts/lib/logic.mjs");
  const a = harnessActivity(() => 0);
  a.feed('{"type":"system","subtype":"task_started","task_id":"b1","description":"pnpm test > /tmp/t.log","task_type":"local_bash"}');
  a.feed('{"type":"system","subtype":"task_started","task_id":"a1","description":"Runtime: journey test","subagent_type":"implementer","task_type":"local_agent"}');
  const snap = a.snapshot();
  assert.deepEqual([snap.subagentsActive.length, snap.backgroundCommands], [1, 1]);
  assert.match(activityLine(snap, { harness: "claude" }), /sub-agents 1 active \(implementer: Runtime: journey test, 0 min\); 1 background command running;/);
});

test("prepareBranch refuses a branch name that collides with refs under it, before any harness spend", async () => {
  const { prepareBranch } = await import("../scripts/lib/checkout.mjs");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { execFileSync } = await import("node:child_process");
  const dir = mkdtempSync(join(tmpdir(), "factory-refs-"));
  const bare = join(dir, "remote.git");
  const work = join(dir, "work");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  execFileSync("git", ["-C", work, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "base"]);
  execFileSync("git", ["-C", work, "remote", "add", "origin", bare]);
  execFileSync("git", ["-C", work, "push", "-q", "origin", "main", "main:refs/heads/factory/5/old-slice"]);
  await assert.rejects(prepareBranch(work, { issue: 5, defaultBranch: "main" }), (e) => e.code === "ref-collision" && /factory\/5 cannot be created: factory\/5\/old-slice exists/.test(e.message));
  const ok = await prepareBranch(work, { issue: 6, defaultBranch: "main" });
  assert.deepEqual([ok.branch, ok.resumed], ["factory/6", false]);
});

test("decideExit: a rejected push is the reason, not 'no PR could be opened'", () => {
  const harness = { ok: true, died: 0 };
  assert.equal(decideExit({ harness, pr: null, commits: 3, pushRejected: "! [remote rejected] HEAD -> factory/808 (cannot lock ref)" }).reason, "push rejected: ! [remote rejected] HEAD -> factory/808 (cannot lock ref)");
  assert.equal(decideExit({ harness, pr: null, commits: 3 }).reason, "no PR could be opened for the branch");
});

test("costByPhase: each harness run's cost by label on the exit line", async () => {
  const { costByPhase } = await import("../scripts/lib/logic.mjs");
  assert.equal(costByPhase([{ label: "work-1", usd: 7.9 }, { label: "validation-fix-1", usd: 0.543 }]), " (work-1 7.90, validation-fix-1 0.54)");
  assert.equal(costByPhase([{ label: "work-1", usd: 7.9 }]), "");
  assert.equal(costByPhase([{ label: "work-1", usd: null }, { label: "exit", usd: 0.1 }]), "");
});
