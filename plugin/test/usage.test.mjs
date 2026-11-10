import "./temp.mjs";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { credentialEnv, finalText, harnessCommand, promptCacheTtl, scrubbedEnv } from "../scripts/lib/harness.mjs";
import { localSandbox } from "../scripts/lib/local.mjs";
import { resolveInputs } from "../scripts/lib/inputs.mjs";
import { CODEX_PRICES, cacheSummary, copilotSessionTotal, mergeUsage, parseClaude, parseCodex, parseCopilot, parseUsage, priceCodex, sinceSession } from "../scripts/lib/usage.mjs";
import { copilotCount, decideExit, sumSpend, unmeteredRun } from "../scripts/lib/logic.mjs";
import { clampTotal } from "../scripts/lib/usage.mjs";
import { copilotCreditUsd } from "../scripts/lib/harness.mjs";
import { exec } from "../scripts/lib/proc.mjs";

const fixture = (f) => readFileSync(join(import.meta.dirname, "fixtures", f), "utf8");

test("claude: single JSON result; total_cost_usd and modelUsage with sub-agents", () => {
  const rec = parseClaude(fixture("claude-result.json"), "claude-fable-5-1");
  assert.equal(rec.harness, "claude");
  assert.equal(rec.ok, true);
  assert.equal(rec.usd, 7.4312);
  assert.equal(rec.sessionId, "3f1c2a9e-9c1a-4e2a-8d3b-aaa111222333");
  assert.equal(rec.turns, 87);
  // input = inputTokens + cacheRead + cacheCreation across both models
  assert.equal(rec.tokens.input, 1200 + 2400000 + 180000 + 800 + 300000 + 20000);
  assert.equal(rec.tokens.output, 41000 + 9000);
  assert.equal(rec.tokens.cached, 2400000 + 300000);
  assert.equal(typeof rec.tokens.written, "number", "cache writes are kept");
  assert.ok(rec.models && Object.keys(rec.models).length >= 1, "per-model split is kept");
  assert.match(rec.basis, /sub-agents included/);
  assert.equal(rec.budgetExceeded, false);
});

test("claude: stream-json with a non-JSON line and a budget-exceeded result", () => {
  const rec = parseClaude(fixture("claude-stream.jsonl"), null);
  assert.equal(rec.ok, false);
  assert.equal(rec.budgetExceeded, true);
  assert.equal(rec.subtype, "error_max_budget_usd");
  assert.equal(rec.usd, 5.02);
  assert.equal(rec.model, "claude-fable-5-1");
  assert.equal(rec.sessionId, "abc-123");
  assert.equal(finalText("claude", fixture("claude-stream.jsonl")), "Budget of $5 reached");
});

test("claude: no result on stdout is an error record, not a crash", () => {
  const rec = parseClaude("", "m");
  assert.equal(rec.ok, false);
  assert.equal(rec.usd, null);
  assert.match(rec.error, /no JSON result/);
});

test("codex: JSONL turn.completed usage summed and priced from the table", () => {
  const rec = parseCodex(fixture("codex-events.jsonl"), "gpt-6.1-sol");
  assert.equal(rec.ok, true);
  assert.equal(rec.turns, 2);
  assert.equal(rec.sessionId, "thr_01HZX");
  assert.equal(rec.tokens.input, 150000);
  assert.equal(rec.tokens.cached, 115000);
  assert.equal(rec.tokens.output, 10000, "output_tokens already includes the reasoning tokens");
  const p = CODEX_PRICES.perMillion["gpt-6.1-sol"];
  const expected = Math.round(((150000 - 115000) * p.input + 115000 * p.cached + 10000 * p.output) / 1e6 * 10000) / 10000;
  assert.equal(rec.usd, expected);
  assert.match(rec.basis, new RegExp(`priced from table dated ${CODEX_PRICES.date}`));
  assert.equal(finalText("codex", fixture("codex-events.jsonl")).split("\n")[0], "Plan posted.");
});

test("codex: unknown model is unmetered, never zero", () => {
  const rec = parseCodex(fixture("codex-events.jsonl"), "gpt-unknown-9");
  assert.equal(rec.usd, null);
  assert.match(rec.basis, /unmetered: no price for gpt-unknown-9/);
  assert.equal(priceCodex(null, { input: 1 }), null);
  assert.equal(priceCodex("gpt-5.5-codex-2026", { input: 1_000_000, cached: 0, output: 0 }), 5, "prefix match on gpt-5.5 at its published input rate");
});

test("copilot: no usage output is unmetered, never zero; a non-zero exit is an error, not a death", () => {
  const rec = parseCopilot(fixture("copilot-stdout.txt"), null, 0);
  assert.equal(rec.ok, true);
  assert.equal(rec.usd, null);
  assert.deepEqual(rec.tokens, { input: null, output: null, cached: null, written: null });
  assert.match(rec.basis, /unmetered: Copilot wrote no usage/);
  const bad = parseCopilot("", null, 2);
  assert.equal(bad.ok, false);
  assert.equal(bad.subtype, "error", "a subtype means the run is not counted as a process death");
  assert.throws(() => parseUsage("gemini", ""), /unknown harness/);
});

test("copilot 1.0.91: the real JSONL and usage file (captured Nov 2): session id and premium requests from the result line, tokens per model from the file", () => {
  const rec = parseCopilot(fixture("copilot-events.jsonl"), null, 0, { usageFile: join(import.meta.dirname, "fixtures", "copilot-usage.json") });
  assert.equal(rec.ok, true);
  assert.equal(rec.sessionId, "9c0cd216-fd38-4b53-bb20-5a6e6d7e3b63");
  assert.equal(rec.model, "claude-sonnet-5");
  assert.equal(rec.turns, 1);
  assert.deepEqual(rec.tokens, { input: 24945, output: 4, cached: 0, written: 24943 });
  assert.equal(rec.premiumRequests, 1);
  assert.equal(rec.aiu, 6.24);
  assert.equal(rec.usd, 0.0624, "AI credits at GitHub's $0.01");
  assert.match(rec.basis, /^harness-reported: 6\.24 AI credits from copilot --usage-output-file at \$0\.01\/credit, 1 premium request/);
  assert.equal(finalText("copilot", fixture("copilot-events.jsonl")), "ok");
  // Without the file the stream's usage checkpoint still gives the credits; tokens stay unknown, never zero.
  const bare = parseCopilot(fixture("copilot-events.jsonl"), null, 0);
  assert.deepEqual(bare.tokens, { input: null, output: null, cached: null, written: null });
  assert.equal(bare.usd, 0.0624);
  assert.match(bare.basis, /from the stream's usage checkpoint/);
  assert.match(parseCopilot("", null, 0).basis, /^unmetered: Copilot wrote no usage/);
});

test("codex 0.160: the real probe JSONL (captured Nov 2) parses to one turn with cached tokens and a thread id", () => {
  const rec = parseCodex(fixture("codex-probe.jsonl"), "gpt-6.1-sol");
  assert.equal(rec.ok, true);
  assert.equal(rec.turns, 1);
  assert.equal(rec.sessionId, "01a19f63-ef53-7ef1-9da6-43fdffaa3891");
  assert.deepEqual(rec.tokens, { input: 14614, output: 5, cached: 12288, written: null });
  assert.equal(finalText("codex", fixture("codex-probe.jsonl")), "ok");
});

test("mergeUsage sums runs and keeps null dollars only when every run is unmetered", () => {
  const a = parseClaude(fixture("claude-result.json"), "m");
  const b = parseClaude(fixture("claude-stream.jsonl"), "m");
  const m = mergeUsage([a, b]);
  assert.equal(m.usd, 7.4312 + 5.02);
  assert.equal(m.turns, 87 + 12);
  assert.equal(m.ok, false);
  assert.equal(m.budgetExceeded, true);
  const c = mergeUsage([parseCopilot("", null, 0), parseCopilot("", null, 0)]);
  assert.equal(c.usd, null);
  assert.equal(mergeUsage([]), null);
});

test("the reviewer's effort reaches the command line: Codex as its agent file says; Claude and Copilot keep their CLI default unless set", () => {
  const source = JSON.parse(readFileSync(join(import.meta.dirname, "..", "agents", "source.json"), "utf8")).agents.find((a) => a.name === "reviewer");
  assert.equal(source.models.codex.reasoning_effort, "high");
  const flags = /^(--effort|--reasoning-effort)$|^model_reasoning_effort=/;
  const r = resolveInputs({ env: { FACTORY_HARNESS: "codex" } });
  const c = harnessCommand({ harness: "codex", model: r.reviewerModel, prompt: "P", maxUsd: 5, effort: r.reviewerEffort });
  assert.deepEqual(c.args.filter((a) => flags.test(a)), ['model_reasoning_effort="high"'], "codex: the reviewer runs at its agent file's high");
  for (const [h, flag] of [["claude", "--effort"], ["copilot", "--reasoning-effort"]]) {
    const d = resolveInputs({ env: { FACTORY_HARNESS: h } });
    assert.equal(d.reviewerEffort, "", `${h}: no default, the CLI's own`);
    assert.equal(harnessCommand({ harness: h, model: d.reviewerModel, prompt: "P", maxUsd: 5, agent: "reviewer", effort: d.reviewerEffort }).args.filter((a) => flags.test(a)).length, 0, `${h}: nothing passed by default`);
    const set = resolveInputs({ env: { FACTORY_HARNESS: h, FACTORY_REVIEWER_EFFORT: "max" } });
    const a = harnessCommand({ harness: h, model: set.reviewerModel, prompt: "P", maxUsd: 5, agent: "reviewer", effort: set.reviewerEffort }).args;
    assert.deepEqual(a.slice(a.indexOf(flag), a.indexOf(flag) + 2), [flag, "max"], `${h}: an owner's setting is passed`);
  }
  // The owner's setting, from the env block or `with:`, wins; an env block written for another harness does not apply.
  assert.equal(resolveInputs({ env: { FACTORY_HARNESS: "codex", FACTORY_REVIEWER_EFFORT: "xhigh" } }).reviewerEffort, "xhigh");
  assert.equal(resolveInputs({ env: { FACTORY_HARNESS: "claude", FACTORY_REVIEWER_EFFORT: "max", FACTORY_INPUT_REVIEWER_EFFORT: "high" } }).reviewerEffort, "high");
  assert.equal(resolveInputs({ env: { FACTORY_HARNESS: "claude", FACTORY_REVIEWER_EFFORT: "low", FACTORY_INPUT_HARNESS: "codex" } }).reviewerEffort, "high");
  // The worker's effort stays its own.
  assert.equal(resolveInputs({ env: { FACTORY_HARNESS: "codex" } }).effort, "");
});

test("the answer pass runs at the worker's effort, not the CLI default", async () => {
  const { workerRun } = await import("../scripts/review.mjs");
  const flags = /^(--effort|--reasoning-effort)$|^model_reasoning_effort=/;
  const effortArgs = (env) => harnessCommand({ ...workerRun(resolveInputs({ env })), prompt: "P", maxUsd: 5 }).args.filter((a) => flags.test(a) || a === "medium" || a === "high");
  assert.deepEqual(effortArgs({ FACTORY_HARNESS: "claude" }), ["--effort", "medium"], "claude: the worker's pinned medium");
  assert.deepEqual(effortArgs({ FACTORY_HARNESS: "codex", FACTORY_EFFORT: "high" }), ['model_reasoning_effort="high"'], "codex: an owner's worker effort");
  assert.deepEqual(effortArgs({ FACTORY_HARNESS: "codex" }), [], "codex: no worker default, the CLI's own");
  assert.deepEqual(effortArgs({ FACTORY_HARNESS: "copilot", FACTORY_EFFORT: "high" }), ["--reasoning-effort", "high"]);
  const r = resolveInputs({ env: { FACTORY_HARNESS: "codex", FACTORY_EFFORT: "high", FACTORY_REVIEWER_EFFORT: "low" } });
  assert.deepEqual(workerRun(r), { harness: "codex", model: r.model, effort: "high" }, "the worker's effort, never the reviewer's");
});

test("harness command lines are the documented headless flags; the prompt goes on stdin for every harness", () => {
  const c = harnessCommand({ harness: "claude", model: "claude-fable-5-1", prompt: "P", maxUsd: 25 });
  assert.equal(c.cmd, "claude");
  assert.ok(c.args.includes("--exclude-dynamic-system-prompt-sections"), "the system prompt prefix is shared across machines");
  const e = harnessCommand({ harness: "claude", model: "claude-opus-5-5", prompt: "P", maxUsd: 25, effort: "medium" });
  assert.ok(e.args.join(" ").includes("--effort medium"), "a pinned effort reaches the CLI");
  const xe = harnessCommand({ harness: "codex", prompt: "P", maxUsd: 0, effort: "high", compaction: "300000" });
  assert.ok(xe.args.includes('model_reasoning_effort="high"') && xe.args.includes("model_auto_compact_token_limit=300000") && !xe.args.includes("--effort"));
  const pe = harnessCommand({ harness: "copilot", prompt: "P", effort: "high", compaction: "300000" });
  assert.deepEqual(pe.args.slice(pe.args.indexOf("--reasoning-effort"), pe.args.indexOf("--reasoning-effort") + 2), ["--reasoning-effort", "high"]);
  assert.deepEqual(harnessCommand({ harness: "claude", prompt: "P", compaction: "300000" }).env, { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "300000" });
  assert.ok(c.args.includes("--output-format") && c.args.includes("--max-budget-usd") && c.args.includes("25"));
  assert.equal(c.stdin, "P");
  const r = harnessCommand({ harness: "claude", prompt: "fix", maxUsd: 0, resume: "sid" });
  assert.deepEqual(r.args.slice(r.args.indexOf("--resume")), ["--resume", "sid"]);
  const x = harnessCommand({ harness: "codex", model: "gpt-6.1-sol", prompt: "P", maxUsd: 1 });
  assert.deepEqual(x.args.slice(0, 2), ["exec", "--json"]);
  assert.ok(x.args.includes("-m") && x.args.at(-1) === "-");
  const xr = harnessCommand({ harness: "codex", prompt: "fix", resume: "thr_1" });
  assert.deepEqual(xr.args.slice(0, 3), ["exec", "resume", "thr_1"]);
  const a = harnessCommand({ harness: "claude", prompt: "review", maxUsd: 0, agent: "reviewer" });
  assert.deepEqual(a.args.slice(a.args.indexOf("--agent"), a.args.indexOf("--agent") + 2), ["--agent", "reviewer"]);
  const p = harnessCommand({ harness: "copilot", prompt: "P", agent: "reviewer", usageFile: "/tmp/u.json" });
  assert.equal(p.stdin, "P");
  assert.ok(!p.args.includes("-p") && !p.args.includes("P"), "copilot takes its prompt on stdin, never as an argument");
  assert.ok(p.args.includes("--allow-all") && p.args.includes("--agent") && !p.args.includes("--no-ask-user"), "copilot 1.0.91 has --allow-all and no --no-ask-user");
  assert.deepEqual(p.args.slice(p.args.indexOf("--output-format"), p.args.indexOf("--output-format") + 2), ["--output-format", "json"]);
  assert.deepEqual(p.args.slice(p.args.indexOf("--usage-output-file")), ["--usage-output-file", "/tmp/u.json"]);
  assert.equal(p.canResume, true);
  const pr = harnessCommand({ harness: "copilot", prompt: "fix", resume: "s-1" });
  assert.deepEqual(pr.args.slice(pr.args.indexOf("--resume"), pr.args.indexOf("--resume") + 2), ["--resume", "s-1"]);
  // Local mode: every harness keeps its own sandbox on and never takes a runner's bypass.
  const local = { addDirs: ["/u"], domains: ["github.com"], clone: "/c", readOnly: ["/u/bin"] };
  const lc = harnessCommand({ harness: "claude", prompt: "P", local });
  assert.ok(lc.args.includes("--settings") && !lc.args.includes("--dangerously-skip-permissions"));
  const lx = harnessCommand({ harness: "codex", prompt: "P", local });
  assert.ok(lx.args.includes('default_permissions="factory"') && lx.args.includes("features.network_proxy=true") && !lx.args.includes("--dangerously-bypass-approvals-and-sandbox"));
  assert.match(lx.args.find((a) => a.startsWith("shell_environment_policy.exclude")), /"CODEX_API_KEY"/);
  assert.ok(lx.args.includes("--ignore-user-config") && lx.args.includes("features.apps=false") && lx.args.includes('projects={"/c"={trust_level="untrusted"}}'));
  const lp = harnessCommand({ harness: "copilot", prompt: "P", local });
  assert.ok(lp.args.includes("--sandbox") && !lp.args.includes("--allow-all") && !lp.args.includes("--allow-all-paths"), "copilot keeps path checks on locally");
  assert.deepEqual(lp.args.slice(lp.args.indexOf("--add-dir"), lp.args.indexOf("--add-dir") + 2), ["--add-dir", "/u"]);
});

test("a prompt over 128 KB starts every harness: it goes on stdin, no argument nears Linux's per-argument cap", async () => {
  // Linux refuses one argv string over 128 KB (MAX_ARG_STRLEN) with E2BIG; a reviewer prompt carries up to ~1 MB of diff.
  const prompt = `review this diff\n${"+ a changed line of the diff under review\n".repeat(6000)}`;
  assert.ok(Buffer.byteLength(prompt) > 200 * 1024);
  const local = { addDirs: ["/u"], domains: ["github.com"], clone: "/c", readOnly: ["/u/bin"] };
  for (const harness of ["claude", "codex", "copilot"]) {
    for (const c of [harnessCommand({ harness, prompt, agent: "reviewer", maxUsd: 1 }), harnessCommand({ harness, prompt, resume: "s-1", local })]) {
      assert.equal(c.stdin, prompt, `${harness}: the prompt is on stdin`);
      assert.ok(c.args.every((a) => Buffer.byteLength(String(a)) < 16 * 1024), `${harness}: no argument carries the prompt`);
      // The real start: the same argument vector to a process that reads stdin, which E2BIG would refuse before it ran.
      const r = await exec(process.execPath, ["-e", "let n=0;process.stdin.on('data',(d)=>n+=d.length).on('end',()=>process.stdout.write(String(n)))", "--", ...c.args], { input: c.stdin, timeoutMs: 60_000 });
      assert.equal(r.code, 0, `${harness}: started`);
      assert.equal(Number(r.stdout), Buffer.byteLength(prompt), `${harness}: the whole prompt arrived`);
    }
  }
});

test("localSandbox: a writable directory swapped for a symlink is refused", () => {
  const root = mkdtempSync(join(tmpdir(), "ls-"));
  const real = join(root, "real");
  mkdirSync(real);
  const env = (dir) => ({ FACTORY_LOCAL: "1", FACTORY_LOCAL_SANDBOX: JSON.stringify({ addDirs: [dir], clone: null }) });
  assert.deepEqual(localSandbox(env(real)).addDirs, [real]);
  const swapped = join(root, "swapped");
  symlinkSync(real, swapped);
  assert.throws(() => localSandbox(env(swapped)), /now resolves to/);
  assert.throws(() => localSandbox({ FACTORY_LOCAL: "1" }), /refusing to run the harness unsandboxed/);
  rmSync(root, { recursive: true, force: true });
});

test("credential: on a developer's machine, api with no key falls back to the CLI login; inside Actions it refuses", async () => {
  const inputs = { anthropicApiKey: "", anthropicOidcExchangeUrl: "", codexApiKey: "", githubToken: "", claudeCodeOauthToken: "" };
  const cp = (inp, env) => credentialEnv({ harness: "copilot", credential: "api", inputs: { ...inputs, ...inp }, env: { GITHUB_ACTIONS: "true", ...env } });
  assert.deepEqual(await cp({ copilotGithubToken: "github_pat_seat", githubToken: "ghs_job" }, { COPILOT_GITHUB_TOKEN: "x" }), { env: { COPILOT_GITHUB_TOKEN: "github_pat_seat" }, basis: "copilot_github_token (step-scoped)" });
  await assert.rejects(cp({ copilotGithubToken: "", githubToken: "ghs_job" }, {}), /no Copilot credential/, "the job token can write: never Copilot's credential");
  const local = await credentialEnv({ harness: "claude", credential: "api", inputs, env: { PATH: "/bin" } });
  assert.match(local.basis, /CLI login on this machine \(no API credential present; local fallback\)/);
  assert.deepEqual(local.env, {});
  const keyed = await credentialEnv({ harness: "claude", credential: "api", inputs: { ...inputs, anthropicApiKey: "sk-1" }, env: { PATH: "/bin" } });
  assert.equal(keyed.basis, "ANTHROPIC_API_KEY");
  await assert.rejects(credentialEnv({ harness: "claude", credential: "api", inputs, env: { GITHUB_ACTIONS: "true" } }), /no Claude credential/);
  await assert.rejects(credentialEnv({ harness: "claude", credential: "login", inputs, env: { GITHUB_ACTIONS: "true" } }), /developer's machine/);
});

test("model, App, runner and GitHub secrets never reach a child", () => {
  const e = scrubbedEnv({ PATH: "/bin", ANTHROPIC_API_KEY: "sk", CODEX_API_KEY: "ck", FACTORY_INPUT_CODEX_API_KEY: "ck", FACTORY_INPUT_APP_PRIVATE_KEY: "pem", FACTORY_INPUT_COPILOT_GITHUB_TOKEN: "cp", FACTORY_INPUT_APP_TOKEN: "ghs", FACTORY_INPUT_MODEL: "m", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc", ACTIONS_ID_TOKEN_REQUEST_URL: "u", ACTIONS_RUNTIME_TOKEN: "rt", FACTORY_APP_TOKEN: "ghs", FACTORY_APP_PRIVATE_KEY: "pem", GITHUB_TOKEN: "job", GH_CONFIG_DIR: "/auth", FACTORY_GIT_TOKEN: "w", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "credential.helper", GIT_CONFIG_VALUE_0: "x" }, { GH_TOKEN: "t" });
  assert.deepEqual(e, { PATH: "/bin", FACTORY_INPUT_MODEL: "m" });
});

test("scrubbedEnv: an undefined or null extra value removes the key (the dispatch run's GITHUB_SHA never reaches a child)", () => {
  const e = scrubbedEnv({ PATH: "/bin", GITHUB_SHA: "abc", GITHUB_REF: "refs/heads/main", KEEP: "1" }, { GITHUB_SHA: undefined, GITHUB_REF: "refs/heads/factory/7", GONE: null });
  assert.deepEqual(e, { PATH: "/bin", GITHUB_REF: "refs/heads/factory/7", KEEP: "1" });
});

test("runnerFileEnv: a setup command's GITHUB_PATH and GITHUB_ENV writes reach the job's later children", async () => {
  const { mkdtempSync, writeFileSync: write } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { runnerFileEnv } = await import("../scripts/lib/checkout.mjs");
  const dir = mkdtempSync(join(tmpdir(), "factory-runner-"));
  write(join(dir, "path"), "/usr/lib/postgresql/18/bin\n/usr/bin\n\n");
  write(join(dir, "env"), "PGHOST=localhost\nNOTE<<EOF\nline one\nline two\nEOF\nBAD LINE\n");
  const out = runnerFileEnv({ PATH: "/usr/bin:/bin", GITHUB_PATH: join(dir, "path"), GITHUB_ENV: join(dir, "env") });
  assert.deepEqual(out, { PATH: "/usr/lib/postgresql/18/bin:/usr/bin:/bin", PGHOST: "localhost", NOTE: "line one\nline two" });
  assert.deepEqual(runnerFileEnv({ PATH: "/bin" }), {});
});

test("sessions: a Codex rollout is saved into the usage directory and restored locally from the newest earlier stage", async () => {
  const { restoreTranscript, saveTranscript } = await import("../scripts/lib/session.mjs");
  const root = mkdtempSync(join(tmpdir(), "sess-"));
  const saved = { CODEX_HOME: process.env.CODEX_HOME, FACTORY_LOCAL: process.env.FACTORY_LOCAL };
  process.env.CODEX_HOME = join(root, "codex");
  process.env.FACTORY_LOCAL = "1";
  try {
    const rel = join("2026", "11", "06", "rollout-2026-11-06T16-42-54-t1.jsonl");
    mkdirSync(join(root, "codex", "sessions", "2026", "11", "06"), { recursive: true });
    writeFileSync(join(root, "codex", "sessions", rel), '{"secret":"sk-live-0123456789"}\n');
    const ws = join(root, "ws");
    const usageDir = join(ws, "usage-work-1");
    mkdirSync(usageDir, { recursive: true });
    const s = saveTranscript({ harness: "codex", sessionId: "t1", usageDir, checkout: "/c", secrets: ["sk-live-0123456789"] });
    assert.deepEqual(s, { harness: "codex", id: "t1", files: [rel], checkout: "/c" });
    assert.match(readFileSync(join(usageDir, "transcript", rel), "utf8"), /\*\*\*/);
    writeFileSync(join(usageDir, "result.json"), JSON.stringify({ session: s }));
    rmSync(join(root, "codex", "sessions"), { recursive: true });
    assert.deepEqual(await restoreTranscript({ checkout: "/c", workDir: ws, harness: "codex" }), { id: "t1", from: "usage-work-1", reason: "" });
    assert.ok(existsSync(join(root, "codex", "sessions", rel)));
    assert.match((await restoreTranscript({ checkout: "/c", workDir: ws, harness: "copilot" })).reason, /codex's; this stage runs copilot/);
    assert.match((await restoreTranscript({ checkout: "/other", workDir: ws, harness: "codex" })).reason, /checkout path differs/);
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
    rmSync(root, { recursive: true, force: true });
  }
});

test("a resumed Claude pass counts its own share, not the session's running total", async () => {
  const { parseUsage, sinceSession, mergeUsage } = await import("../scripts/lib/usage.mjs");
  // Shapes and numbers from a real run: the fix pass resumed the work session and reported the session's totals.
  const result = (turns, usd, opus, sonnet) => JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: turns, session_id: "s1", total_cost_usd: usd,
    modelUsage: { "claude-opus-5-5": { inputTokens: 500, cacheReadInputTokens: opus[0], cacheCreationInputTokens: opus[1], outputTokens: opus[2], costUSD: opus[3] },
      "claude-sonnet-5-5": { inputTokens: 100, cacheReadInputTokens: sonnet[0], cacheCreationInputTokens: sonnet[1], outputTokens: sonnet[2], costUSD: sonnet[3] } } });
  const sonnet = [945877, 60082, 16411, 0.4090027];
  const work = parseUsage("claude", result(172, 12.9695405, [34443249, 336370, 148984, 12.5605378], sonnet), "claude-opus-5-5", 0);
  const fixReported = parseUsage("claude", result(15, 14.2617083, [39815948, 351371, 153859, 13.8527056], sonnet), "claude-opus-5-5", 0);
  const fix = sinceSession(fixReported, work);
  assert.ok(Math.abs(fix.usd - 1.2921678) < 1e-6, `fix pass usd ${fix.usd}`);
  assert.equal(fix.models["claude-sonnet-5-5"].usd, 0, "no sub-agent ran in the fix pass");
  assert.equal(fix.models["claude-opus-5-5"].cached, 39815948 - 34443249);
  assert.equal(fix.turns, 15);
  assert.ok(Math.abs(mergeUsage([work, fix]).usd - 14.2617083) < 1e-6, "the run costs what the session reported last");
  assert.equal(sinceSession(fixReported, undefined), fixReported, "an unknown prior session leaves the record as reported");
});

test("a session restored from an earlier job counts its own share: the transcript's last cost-state is the prior total", async () => {
  const { parseUsage, sinceSession, transcriptTotal } = await import("../scripts/lib/usage.mjs");
  // Shapes and numbers from a real resumed session: Claude Code writes a cost-state line as each process ends.
  const state = (usd, input, output, written) => JSON.stringify({ type: "cost-state", sessionId: "s1", totalCostUSD: usd, modelUsage: { "claude-haiku-5-5": { inputTokens: input, outputTokens: output, cacheReadInputTokens: 0, cacheCreationInputTokens: written, costUSD: usd } } });
  const transcript = [JSON.stringify({ type: "user", message: { content: "say hi" } }), state(0.0040019, 1, 90, 20000), JSON.stringify({ type: "assistant" }), state(0.0060084, 2, 150, 21446), ""].join("\n");
  const prior = transcriptTotal(transcript);
  assert.equal(prior.usd, 0.0060084, "the last cost-state line wins");
  assert.equal(prior.models["claude-haiku-5-5"].output, 150);
  assert.equal(transcriptTotal('{"type":"user"}\n'), null, "no cost-state: no prior total");
  const reported = parseUsage("claude", JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1, session_id: "s1", total_cost_usd: 0.00635726, modelUsage: { "claude-haiku-5-5": { inputTokens: 4, outputTokens: 182, cacheReadInputTokens: 21446, cacheCreationInputTokens: 21446, costUSD: 0.00635726 } } }), "claude-haiku-5-5", 0);
  const own = sinceSession(reported, prior);
  assert.ok(Math.abs(own.usd - 0.00034886) < 1e-9, `resumed pass usd ${own.usd}`);
  assert.equal(own.models["claude-haiku-5-5"].output, 32);
});

test("a resumed Codex pass counts its own share, in this process and from an earlier stage; output is priced once", async () => {
  const { runHarness } = await import("../scripts/lib/harness.mjs");
  const { restoreTranscript } = await import("../scripts/lib/session.mjs");
  // Real Codex 0.167.0 streams: `codex exec`, then `codex exec resume` on its thread at high effort. turn.completed
  // carries the thread's running total; the rollout's own last_token_usage for the resumed turn was input 22888,
  // cached 12288, output 50 of which reasoning 43 (total_tokens 22938 = input + output).
  const bin = mkdtempSync(join(tmpdir(), "factory-codex-resume-"));
  const fixtures = join(import.meta.dirname, "fixtures");
  writeFileSync(join(bin, "codex"), `#!${process.execPath}
const fs = require("node:fs");
const resume = process.argv[3] === "resume" ? process.argv[4] : null;
const text = fs.readFileSync(${JSON.stringify(fixtures)} + (resume ? "/codex-0.167-thread-resumed.jsonl" : "/codex-0.167-thread.jsonl"), "utf8");
process.stdout.write(resume ? text.replaceAll("01a1c6ba-16b2-7a13-b2da-47bf51b4e724", resume) : text);
`, { mode: 0o755 });
  const saved = { PATH: process.env.PATH, CODEX_HOME: process.env.CODEX_HOME, FACTORY_LOCAL: process.env.FACTORY_LOCAL };
  process.env.PATH = `${bin}:${saved.PATH}`;
  const model = "gpt-6.1-sol";
  const run = (resume, label) => runHarness({ harness: "codex", model, prompt: "p", maxUsd: 0, resume, cwd: bin, env: { PATH: process.env.PATH }, timeoutMs: 60_000, label });
  const near = (a, b, why) => assert.ok(Math.abs(a - b) < 1e-3, `${why}: ${a} vs ${b}`);
  try {
    const first = await run(null, "work-1");
    const thread = first.sessionId;
    assert.deepEqual(first.tokens, { input: 16151, output: 5, cached: 12288, written: null });
    const fix = await run(thread, "validation-fix-1");
    assert.deepEqual(fix.tokens, { input: 22888, output: 50, cached: 12288, written: null }, "the resumed pass's own share, reasoning inside output");
    near(fix.usd, priceCodex(model, fix.tokens), "priced on its own share");
    assert.deepEqual(fix.sessionTotal.tokens, { input: 39039, output: 55, cached: 24576, written: null });
    near(mergeUsage([first, fix]).usd, priceCodex(model, fix.sessionTotal.tokens), "the run costs what the thread reported last");

    // A later stage restores the thread: the prior total is the one Factory recorded in the saving stage's result.json.
    const root = mkdtempSync(join(tmpdir(), "factory-codex-stage-"));
    process.env.CODEX_HOME = join(root, "codex");
    process.env.FACTORY_LOCAL = "1";
    const rel = join("2026", "11", "10", "rollout-2026-11-10T10-30-46-t2.jsonl");
    const usageDir = join(root, "ws", "usage-work-1");
    mkdirSync(join(usageDir, "transcript", "2026", "11", "10"), { recursive: true });
    writeFileSync(join(usageDir, "transcript", rel), "{}\n");
    writeFileSync(join(usageDir, "result.json"), JSON.stringify({ session: { harness: "codex", id: "t2", files: [rel], checkout: "/c" }, sessionTotal: first.sessionTotal }));
    assert.equal((await restoreTranscript({ checkout: "/c", workDir: join(root, "ws"), harness: "codex" })).id, "t2");
    delete process.env.FACTORY_LOCAL;
    const review = await run("t2", "review-fix-1");
    assert.deepEqual(review.tokens, fix.tokens, "a restored thread counts only its own share too");
    rmSync(root, { recursive: true, force: true });
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
    rmSync(bin, { recursive: true, force: true });
  }
});

test("a session total is only subtracted when it is a running total", async () => {
  const { sinceSession } = await import("../scripts/lib/usage.mjs");
  const rec = (usd) => ({ usd, tokens: { input: 1, output: 1, cached: 1, written: 1 }, models: null, turns: 3 });
  assert.equal(sinceSession(rec(2), rec(5)).usd, 2, "below the prior total: not cumulative, counted as reported");
  assert.equal(sinceSession(rec(7), rec(null)).usd, 7, "a prior pass with no total subtracts nothing");
  assert.equal(sinceSession(rec(7), rec(5)).usd, 2);
});

test("prompt cache TTL: off by default; auto asks Claude Code for an hour on an API key only; an explicit setting wins; other harnesses get none", () => {
  assert.equal(promptCacheTtl("claude", { ANTHROPIC_API_KEY: "k" }), null, "off until the A/B is run");
  assert.equal(resolveInputs({ env: {} }).promptCacheTtl, "off");
  assert.equal(resolveInputs({ env: { FACTORY_PROMPT_CACHE_TTL: " AUTO " } }).promptCacheTtl, "auto");
  assert.equal(resolveInputs({ env: { FACTORY_INPUT_PROMPT_CACHE_TTL: "2h" } }).promptCacheTtl, "off", "an invalid value warns and reads as off");
  const auto = { FACTORY_PROMPT_CACHE_TTL: "auto" };
  assert.equal(promptCacheTtl("claude", { ...auto, ANTHROPIC_API_KEY: "k" }), "1h");
  assert.equal(promptCacheTtl("claude", { ...auto, ANTHROPIC_API_KEY: "k", CLAUDE_CODE_OAUTH_TOKEN: "t" }), "1h", "the API key wins over the OAuth token, so it is what bills");
  assert.equal(promptCacheTtl("claude", { ...auto, CLAUDE_CODE_OAUTH_TOKEN: "t" }), null, "a plan token already gets an hour");
  assert.equal(promptCacheTtl("claude", auto), null, "a CLI login is left to the CLI");
  assert.equal(promptCacheTtl("claude", { FACTORY_PROMPT_CACHE_TTL: "off", ANTHROPIC_API_KEY: "k" }), null);
  assert.equal(promptCacheTtl("claude", { FACTORY_PROMPT_CACHE_TTL: "5m", ANTHROPIC_API_KEY: "k" }), "5m");
  assert.equal(promptCacheTtl("claude", { FACTORY_PROMPT_CACHE_TTL: "1H", CLAUDE_CODE_OAUTH_TOKEN: "t" }), "1h");
  assert.equal(promptCacheTtl("claude", { FACTORY_PROMPT_CACHE_TTL: "2h", ANTHROPIC_API_KEY: "k" }), null, "a value Claude Code would ignore is not sent");
  for (const h of ["codex", "copilot"]) assert.equal(promptCacheTtl(h, { ANTHROPIC_API_KEY: "k", FACTORY_PROMPT_CACHE_TTL: "1h" }), null);
  assert.deepEqual(harnessCommand({ harness: "claude", prompt: "p", cacheTtl: "1h" }).env, { CLAUDE_CODE_PROMPT_CACHE_TTL: "1h" });
  assert.deepEqual(harnessCommand({ harness: "claude", prompt: "p" }).env, {});
});

test("prompt cache: each harness's first request (or turn) after a CI wait and the stage's write share go in the usage record", () => {
  const msg = (id, u, parent = null) => JSON.stringify({ type: "assistant", parent_tool_use_id: parent, message: { id, usage: u }, session_id: "s" });
  const stream = [
    JSON.stringify({ type: "system", subtype: "init", session_id: "s" }),
    msg("m1", { input_tokens: 3, cache_read_input_tokens: 1000, cache_creation_input_tokens: 40000, cache_creation: { ephemeral_1h_input_tokens: 40000, ephemeral_5m_input_tokens: 0 }, output_tokens: 9 }),
    msg("m2", { input_tokens: 1, cache_read_input_tokens: 41000, cache_creation_input_tokens: 500, output_tokens: 9 }),
    JSON.stringify({ type: "result", subtype: "success", session_id: "s", total_cost_usd: 0.4, usage: { input_tokens: 4, cache_read_input_tokens: 42000, cache_creation_input_tokens: 40500, output_tokens: 18 } }),
  ].join("\n");
  const claude = parseClaude(stream, "m");
  assert.deepEqual(claude.cache.first, { unit: "request", input: 41003, cached: 1000, written: 40000, written1h: 40000, written5m: 0 });
  // A sub-agent's message is not the main thread's first request.
  const sub = parseClaude([msg("x", { input_tokens: 9, cache_creation_input_tokens: 7 }, "toolu_1"), msg("m1", { input_tokens: 1, cache_read_input_tokens: 2, cache_creation_input_tokens: 3 })].join("\n"), "m");
  assert.equal(sub.cache.first.written, 3);
  const codex = parseCodex(fixture("codex-events.jsonl"), "gpt-6.1-sol");
  assert.equal(codex.cache.first.unit, "turn");
  assert.equal(codex.cache.first.written, null, "Codex reports no cache writes");
  const copilot = parseCopilot(fixture("copilot-events.jsonl"), null, 0, { usageFile: join(import.meta.dirname, "fixtures", "copilot-usage.json") });
  assert.equal(copilot.cache.first, null, "Copilot reports the run, not a request");
  assert.equal(copilot.cache.ttlSeconds, 300, "the TTL Copilot chose, from its usage checkpoint");

  const run = (label, started, ended, extra) => ({ ...claude, label, started, ended, cacheTtl: "1h", ...extra });
  const s = cacheSummary([
    run("work", "2026-11-08T10:00:00Z", "2026-11-08T10:20:00Z"),
    run("validation-fix-1", "2026-11-08T10:32:30Z", "2026-11-08T10:40:00Z", { resumed: true }),
  ]);
  assert.equal(s.ttl, "1h");
  assert.equal(s.writeShare, Math.round((81000 / 165008) * 1000) / 1000);
  assert.equal(s.afterWait.length, 1, "only a fix pass follows a CI wait");
  assert.deepEqual({ ...s.afterWait[0], first: undefined }, { label: "validation-fix-1", waitMin: 12.5, resumed: true, first: undefined, writeShare: Math.round((40500 / 82504) * 1000) / 1000 });
  assert.equal(s.afterWait[0].first.written1h, 40000);
  const c = cacheSummary([{ ...copilot, label: "work" }]);
  assert.equal(c.ttl, null);
  assert.equal(c.harnessTtlSeconds, 300);
  assert.equal(c.writeShare, Math.round((24943 / 24945) * 1000) / 1000);
  assert.equal(cacheSummary([{ ...codex, label: "work" }]).writeShare, null, "no writes reported is null, never zero");
});

test("copilot 1.0.107 (captured Nov 8): dollars are the AI credits at the configured rate; a resumed pass counts only its own share", () => {
  const file = (f) => join(import.meta.dirname, "fixtures", f);
  const first = parseCopilot("", null, 0, { usageFile: file("copilot-1.0.107-usage.json") });
  assert.equal(first.model, "claude-sonnet-5.5");
  assert.equal(first.premiumRequests, 1);
  assert.equal(first.aiu, 6.123);
  assert.equal(first.usd, 0.0612, "6,122,800,000 nano-AIU is 6.12 credits: 24,472 cache-write tokens at $2.50 per million");
  assert.equal(parseCopilot("", null, 0, { usageFile: file("copilot-1.0.107-usage.json"), creditUsd: 0.02 }).usd, 0.1225, "the rate is a setting");
  // On --resume the file is the session's running total: two requests, both runs' tokens.
  const total = parseCopilot("", null, 0, { usageFile: file("copilot-1.0.107-usage-resumed.json") });
  assert.equal(total.premiumRequests, 2);
  assert.equal(total.sessionStartTime, first.sessionStartTime, "Copilot keeps the session's start time across --resume");
  const own = sinceSession(total, { usd: first.usd, tokens: first.tokens, models: null, premiumRequests: first.premiumRequests, aiu: first.aiu, sessionStartTime: first.sessionStartTime });
  assert.equal(own.premiumRequests, 1);
  assert.equal(own.aiu, 0.262);
  assert.ok(Math.abs(own.usd - 0.0026) < 1e-9, `resumed pass usd ${own.usd}`);
  assert.deepEqual(own.tokens, { input: 24525, output: 4, cached: 24472, written: 49 });
  // A session restored from an earlier job: its saved events' last session.shutdown snapshot is the prior total.
  const seeded = copilotSessionTotal(readFileSync(file("copilot-1.0.107-session-events.jsonl"), "utf8"));
  assert.deepEqual({ usd: seeded.usd, premiumRequests: seeded.premiumRequests, aiu: seeded.aiu }, { usd: 0.0612, premiumRequests: 1, aiu: 6.123 });
  assert.equal(copilotSessionTotal('{"type":"session.start"}'), null);
  // A stage's runs are summed, premium requests and credits included; the progress line names both.
  const stage = mergeUsage([first, own]);
  assert.equal(stage.premiumRequests, 2);
  assert.equal(stage.aiu, 6.385);
  assert.ok(Math.abs(stage.usd - 0.0638) < 1e-9, `stage usd ${stage.usd}`);
  assert.equal(copilotCount({ premiumRequests: 2, aiCredits: 6.385 }), "; 2 premium requests, 6.385 AI credits");
  assert.equal(copilotCount({ premiumRequests: null, aiCredits: null }), "", "other harnesses add nothing");
  // A usage file with tokens but no AI credits (an older CLI) is unmetered, never zero.
  const dir = mkdtempSync(join(tmpdir(), "factory-copilot-"));
  writeFileSync(join(dir, "u.json"), JSON.stringify({ totalPremiumRequestCost: 3, modelMetrics: { m: { usage: { inputTokens: 10, outputTokens: 2 } } } }));
  const old = parseCopilot("", null, 0, { usageFile: join(dir, "u.json") });
  rmSync(dir, { recursive: true, force: true });
  assert.equal(old.usd, null);
  assert.equal(old.premiumRequests, 3);
  assert.match(old.basis, /^unmetered: no AI credits reported, 3 premium request\(s\)/);
});

test("copilot metering cannot be talked down: negative or forged-low credits, unpriced states, another session's total, an edited saved session", () => {
  const dir = mkdtempSync(join(tmpdir(), "factory-copilot-"));
  const real = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "copilot-1.0.107-usage.json"), "utf8"));
  const write = (name, patch) => {
    writeFileSync(join(dir, name), JSON.stringify({ ...real, ...patch }));
    return join(dir, name);
  };
  const checkpoint = (nano, requests) => JSON.stringify({ type: "session.usage_checkpoint", data: { totalNanoAiu: nano, totalPremiumRequests: requests } });
  const turn = JSON.stringify({ type: "assistant.turn_end" });
  // A negative count is no count: unmetered, and no spend total ever goes down for it.
  const neg = parseCopilot(turn, null, 0, { usageFile: write("neg.json", { totalNanoAiu: -9e12 }) });
  assert.equal(neg.usd, null);
  assert.match(neg.basis, /^unmetered: a negative AI credit count/);
  assert.equal(sumSpend([{ usd: 1 }, { usd: -5 }, { usd: 2 }]), 3);
  assert.equal(mergeUsage([{ usd: -5, tokens: {} }, { usd: 2, tokens: {} }]).usd, 2);
  // A usage file rewritten low loses to the stream's own checkpoint totals.
  const low = parseCopilot([checkpoint(6122800000, 1), checkpoint(90e9, 4), turn].join("\n"), null, 0, { usageFile: write("low.json", { totalNanoAiu: 1e6, totalPremiumRequestCost: 0 }) });
  assert.equal(low.usd, 0.9);
  assert.equal(low.premiumRequests, 4);
  // Pending, unavailable or an unknown status is unmetered; partial is a flagged lower bound; zero credits for tokens is unmetered.
  for (const status of ["pending", "unavailable", "complete\n::error::x"]) assert.equal(parseCopilot(turn, null, 0, { usageFile: write("s.json", { aiCreditsStatus: status }) }).usd, null, status);
  assert.match(parseCopilot(turn, null, 0, { usageFile: write("s.json", { aiCreditsStatus: "nope" }) }).basis, /AI credits unknown/);
  const partial = parseCopilot(turn, null, 0, { usageFile: write("p.json", { aiCreditsStatus: "partial" }) });
  assert.equal(partial.usd, 0.0612);
  assert.equal(partial.usdLowerBound, true);
  assert.match(partial.basis, /lower bound: AI credits partial/);
  assert.equal(parseCopilot(turn, null, 0, { usageFile: write("z.json", { totalNanoAiu: 0 }) }).usd, null);
  // A model name from the file is cleaned before it reaches a log line or the step summary.
  const named = parseCopilot("", null, 0, { usageFile: write("m.json", { modelMetrics: { "evil\n::set-output name=x::y": real.modelMetrics["claude-sonnet-5.5"] } }) });
  assert.equal(named.model, "evilset-outputnamexy");
  // A total from another session start is not this session's running total: counted as reported.
  const first = parseCopilot("", null, 0, { usageFile: join(import.meta.dirname, "fixtures", "copilot-1.0.107-usage.json") });
  const other = parseCopilot("", null, 0, { usageFile: write("o.json", { ...JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "copilot-1.0.107-usage-resumed.json"), "utf8")), sessionStartTime: "2026-11-08T22:00:00.000Z" }) });
  assert.equal(sinceSession(other, { ...first, models: null }).usd, other.usd);
  // A restored session's total (the harness wrote that file) is bounded by what Factory recorded for the stage.
  const seed = { usd: 50, aiu: 5000, premiumRequests: 40, tokens: { input: 9e6, output: 9e4, cached: 8e6, written: 9e5 }, sessionStartTime: first.sessionStartTime };
  assert.deepEqual(clampTotal(seed, { usd: 0.06, aiCredits: 6.123, premiumRequests: 1, tokens: { input: 24476, output: 4, cached: 0, written: 24472 } }), { ...seed, usd: 0.06, aiu: 6.123, premiumRequests: 1, tokens: { input: 24476, output: 4, cached: 0, written: 24472 } });
  assert.equal(clampTotal(seed, { usd: null }), null, "nothing recorded: nothing subtracted");
  rmSync(dir, { recursive: true, force: true });
});

test("copilot caps: --max-ai-credits from what is left (per process, at least 30); an unmetered run stops further passes; a bad rate is refused", () => {
  const credits = (maxUsd, creditUsd) => {
    const a = harnessCommand({ harness: "copilot", prompt: "P", maxUsd, creditUsd }).args;
    return a.includes("--max-ai-credits") ? a[a.indexOf("--max-ai-credits") + 1] : null;
  };
  assert.equal(credits(25, 0.01), "2500");
  assert.equal(credits(0.1, 0.01), "30", "Copilot refuses fewer than 30");
  assert.equal(credits(25, 0.02), "1250");
  assert.equal(credits(0, 0.01), null, "no cap set, no flag");
  assert.equal(unmeteredRun({ harness: "copilot", usd: null, turns: 3 }), true);
  assert.equal(unmeteredRun({ harness: "copilot", usd: null, turns: 0 }), false);
  assert.equal(unmeteredRun({ harness: "copilot", usd: 0.4, turns: 3 }), false);
  assert.equal(unmeteredRun({ harness: "codex", usd: null, turns: 3 }), false);
  assert.equal(decideExit({ harness: { budgetExceeded: true, unmetered: true } }).reason, "unmetered: max_usd cannot be enforced");
  assert.equal(decideExit({ harness: { budgetExceeded: true } }).reason, "dollar cap reached");
  assert.equal(copilotCreditUsd({ FACTORY_INPUT_COPILOT_CREDIT_USD: "0.02" }), 0.02);
  for (const bad of ["0", "-1", "abc"]) assert.equal(copilotCreditUsd({ FACTORY_INPUT_COPILOT_CREDIT_USD: bad }), 0.01, bad);
  assert.equal(copilotCreditUsd({}), 0.01);
});

test("copilot follow-ups: the session's running total is recorded and bounds a restored seed; no exit-record ask when unmetered; no run under the 30-credit floor", async () => {
  const { writeUsage, exitRecord } = await import("../scripts/lib/session.mjs");
  const { runHarness } = await import("../scripts/lib/harness.mjs");
  // A three-stage session: this stage's own spend is small, the session's total is not; the seed is bounded by the total.
  const dir = mkdtempSync(join(tmpdir(), "factory-usage-"));
  const total = { usd: 0.5, tokens: { input: 9e4, output: 900, cached: 6e4, written: 2e4 }, models: null, premiumRequests: 3, aiu: 50, sessionStartTime: "2026-11-08T21:01:11.345Z" };
  const result = writeUsage(dir, { harness: "copilot", model: "m", records: [{ harness: "copilot", sessionId: "other", usd: 0.01, tokens: {}, sessionTotal: { usd: 9 } }, { harness: "copilot", sessionId: "s1", usd: 0.06, tokens: { input: 1, output: 1, cached: 0, written: 0 }, sessionTotal: total }], passes: 0, exit: "delivered", reason: "", credentialBasis: "x", session: { harness: "copilot", id: "s1", files: ["s1"] } });
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "result.json"), "utf8")).sessionTotal, total);
  assert.equal(writeUsage(dir, { harness: "copilot", records: [], passes: 0, exit: "blocked", reason: "", credentialBasis: "x" }).sessionTotal, null);
  rmSync(dir, { recursive: true, force: true });
  const seed = { usd: 0.4, aiu: 40, premiumRequests: 3, tokens: { input: 8e4, output: 800, cached: 5e4, written: 2e4 }, sessionStartTime: total.sessionStartTime };
  assert.equal(clampTotal(seed, result).usd, 0.4, "bounded by the session's total, not the stage's own $0.06");
  assert.equal(clampTotal(seed, { usd: 0.06 }).usd, 0.06, "an older result.json with no session total: the stage's own figures");
  assert.equal(clampTotal({ ...seed, usd: 7 }, result).usd, 0.5);
  // With max_usd unenforceable the harness is not asked for an exit record; an exit file it wrote is still read.
  const asked = await exitRecord({ text: undefined, harness: "copilot", deadlineAt: Date.now() + 3600_000, maxUsd: 25, unmetered: true });
  assert.deepEqual([asked.record.exit, asked.record.reason, asked.usage.length], ["blocked", "unmetered: max_usd cannot be enforced", 0]);
  assert.equal((await exitRecord({ text: '{"exit":"delivered"}', harness: "copilot", deadlineAt: Date.now() + 3600_000, maxUsd: 25, unmetered: true })).record.exit, "delivered");
  assert.equal(decideExit({ harness: { budgetExceeded: true, unmetered: true } }).reason, "unmetered: max_usd cannot be enforced");
  // Under 30 AI credits left no Copilot run starts: a zero-cost record over budget, never an unmetered one.
  const floor = await runHarness({ harness: "copilot", prompt: "p", maxUsd: 0.29, cwd: tmpdir(), env: {}, timeoutMs: 1000, label: "work-1" });
  assert.deepEqual([floor.budgetExceeded, floor.usd, floor.ok, floor.error, unmeteredRun(floor)], [true, 0, false, "dollar cap reached", false]);
});
