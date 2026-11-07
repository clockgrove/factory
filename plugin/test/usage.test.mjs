import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { credentialEnv, finalText, harnessCommand, scrubbedEnv } from "../scripts/lib/harness.mjs";
import { localSandbox } from "../scripts/lib/local.mjs";
import { CODEX_PRICES, mergeUsage, parseClaude, parseCodex, parseCopilot, parseUsage, priceCodex } from "../scripts/lib/usage.mjs";

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
  assert.equal(rec.tokens.output, 10500);
  const p = CODEX_PRICES.perMillion["gpt-6.1-sol"];
  const expected = Math.round(((150000 - 115000) * p.input + 115000 * p.cached + 10500 * p.output) / 1e6 * 10000) / 10000;
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
  assert.equal(rec.usd, null);
  assert.match(rec.basis, /usage-output-file, 1 premium request/);
  assert.equal(finalText("copilot", fixture("copilot-events.jsonl")), "ok");
  // Without the file the stream alone gives no token counts: unmetered, never zero.
  const bare = parseCopilot(fixture("copilot-events.jsonl"), null, 0);
  assert.deepEqual(bare.tokens, { input: null, output: null, cached: null, written: null });
  assert.match(bare.basis, /unmetered/);
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

test("harness command lines follow RESEARCH.md; the prompt goes on stdin for claude and codex", () => {
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
  assert.deepEqual(p.args.slice(0, 2), ["-p", "P"]);
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
  assert.equal((await cp({ copilotGithubToken: "", githubToken: "ghs_job" }, {})).basis, "job token (copilot-requests: write)");
  const local = await credentialEnv({ harness: "claude", credential: "api", inputs, env: { PATH: "/bin" } });
  assert.match(local.basis, /CLI login on this machine \(no API credential present; local fallback\)/);
  assert.deepEqual(local.env, {});
  const keyed = await credentialEnv({ harness: "claude", credential: "api", inputs: { ...inputs, anthropicApiKey: "sk-1" }, env: { PATH: "/bin" } });
  assert.equal(keyed.basis, "ANTHROPIC_API_KEY");
  await assert.rejects(credentialEnv({ harness: "claude", credential: "api", inputs, env: { GITHUB_ACTIONS: "true" } }), /no Claude credential/);
  await assert.rejects(credentialEnv({ harness: "claude", credential: "login", inputs, env: { GITHUB_ACTIONS: "true" } }), /developer's machine/);
});

test("model, App and runner secrets never reach a non-harness child", () => {
  const e = scrubbedEnv({ PATH: "/bin", ANTHROPIC_API_KEY: "sk", CODEX_API_KEY: "ck", FACTORY_INPUT_CODEX_API_KEY: "ck", FACTORY_INPUT_APP_PRIVATE_KEY: "pem", FACTORY_INPUT_MODEL: "m", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc", ACTIONS_ID_TOKEN_REQUEST_URL: "u", ACTIONS_RUNTIME_TOKEN: "rt", FACTORY_APP_TOKEN: "ghs", FACTORY_APP_PRIVATE_KEY: "pem" }, { GH_TOKEN: "t" });
  assert.deepEqual(e, { PATH: "/bin", FACTORY_INPUT_MODEL: "m", GH_TOKEN: "t" });
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
