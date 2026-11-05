import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { appJwt, normalizePem } from "../scripts/lib/app-token.mjs";
import { input, parseArgs, resolveInputs } from "../scripts/lib/inputs.mjs";
import { decideExit, diffLines, hasQuestion, marker, parseFindings, snapComments } from "../scripts/lib/logic.mjs";
import { renderWorkflow } from "../scripts/setup.mjs";

const ok = { ok: true };
const pr = (body = "## Acceptance\nok", draft = false) => ({ exists: true, draft, body });

test("delivered: PR open, validation green, nothing unaddressed", () => {
  assert.deepEqual(decideExit({ harness: ok, pr: pr(), commits: 3, validation: { passes: 1, green: true } }), { exit: "delivered", reason: "" });
});

test("question: a QUESTION in the PR body or the plan comment opens a draft and moves on", () => {
  assert.equal(decideExit({ harness: ok, pr: pr("## Assumptions\n1. QUESTION: does the API change?"), commits: 1, validation: { passes: 1, green: true } }).exit, "question");
  assert.equal(decideExit({ harness: ok, pr: pr(), commits: 1, validation: { passes: 1, green: true }, planHasQuestion: true }).exit, "question");
  assert.equal(hasQuestion("- questionable"), false, "the marker is the word QUESTION, not a substring");
  assert.equal(hasQuestion("1. QUESTION: x"), true);
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
  assert.equal(decideExit({ harness: ok, pr: pr("## Blocked\nThe migration needs a credential the runner lacks."), commits: 2, validation: green }).reason, "worker blocked: The migration needs a credential the runner lacks.");
  assert.equal(decideExit({ harness: { ok: false, error: "harness error" }, pr: pr(), commits: 2, validation: green }).reason, "harness error");
});

test("a question with red validation is blocked, not question", () => {
  assert.equal(decideExit({ harness: ok, pr: pr("QUESTION: x"), commits: 1, validation: { passes: 2, green: false } }).exit, "blocked");
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
  assert.match(out, /uses: clockgrove\/factory@v1/);
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

test("question: the marker is a list item's first word, not the word in prose", () => {
  assert.equal(hasQuestion("1. **Resolved by the owner (was a QUESTION):** the wire shape is accepted."), false);
  assert.equal(hasQuestion("Assumption 1's QUESTION was answered, so the PR is ready."), false);
  assert.equal(hasQuestion("## Assumptions\n1. **QUESTION: is this wire shape acceptable?** Details."), true);
  assert.equal(hasQuestion("- QUESTION: which port?"), true);
  const harness = { ok: true, died: 0 };
  assert.equal(decideExit({ harness, pr: { exists: true, draft: true, body: "## Assumptions\n1. Resolved (was a QUESTION)." }, commits: 1, validation: { passes: 1, green: true } }).exit, "delivered");
});
