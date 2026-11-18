import "./temp.mjs";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SHELL_SECRET_KEYS, finalText, harnessCommand, scrubbedEnv } from "../scripts/lib/harness.mjs";
import { localSandbox } from "../scripts/lib/local.mjs";
import { CODEX_PRICES, copilotSessionTotal, mergeUsage, parseClaude, parseCodex, parseCopilot, parseUsage, priceCodex, sinceSession } from "../scripts/lib/usage.mjs";
import { copilotCount, harnessActivity, sumSpend } from "../scripts/lib/logic.mjs";
import { clampTotal } from "../scripts/lib/usage.mjs";

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

test("codex: a stream error (a dropped stream it reconnected) is a run of unknown cost beside its priced turns (#116, #483)", () => {
  const turn = { type: "turn.completed", usage: { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 100 } };
  const clean = parseCodex([{ type: "thread.started", thread_id: "t1" }, turn].map((e) => JSON.stringify(e)).join("\n"), "gpt-6.1-sol");
  assert.equal(clean.usdUnknown, undefined, "a clean stream is all known");
  const lines = [{ type: "thread.started", thread_id: "t1" }, { type: "error", message: "Reconnecting... 1/5 (stream disconnected before completion: idle timeout waiting for SSE)" }, turn];
  const rec = parseCodex(lines.map((e) => JSON.stringify(e)).join("\n"), "gpt-6.1-sol");
  assert.deepEqual([rec.usdUnknown, rec.usdUnknownWhy], [1, ["failed-request"]], "the dropped attempt may be billed without reported tokens");
  assert.equal(rec.usd, clean.usd, "the reported tokens are still priced");
  const failed = parseCodex([{ type: "thread.started", thread_id: "t1" }, { type: "turn.failed", error: { message: "boom" } }].map((e) => JSON.stringify(e)).join("\n"), "gpt-6.1-sol");
  assert.deepEqual([failed.usd, failed.usdUnknown, failed.usdUnknownWhy], [null, 1, ["failed-request", "unreported"]]);
});

test("codex: JSONL turn.completed usage, the thread's running total, read at its last event and priced from the table", () => {
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
  assert.match(rec.basis, new RegExp(`priced at OpenAI's Standard rates from table dated ${CODEX_PRICES.date}`));
  assert.equal(finalText("codex", fixture("codex-events.jsonl")).split("\n")[0], "Plan posted.");
});

test("#480: Codex's turn.completed totals are cumulative within one process, so they are never summed; the live line counts the same", () => {
  const ev = (o) => JSON.stringify(o);
  const turn = (input, output) => ev({ type: "turn.completed", usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: output } });
  const stream = [ev({ type: "thread.started", thread_id: "t1" }), turn(1_000_000, 10_000), turn(1_500_000, 20_000)];
  const rec = parseCodex(stream.join("\n"), "gpt-6.1-sol");
  assert.deepEqual([rec.tokens.input, rec.tokens.output, rec.turns], [1_500_000, 20_000, 2], "1.0M then 1.5M is 1.5M, not 2.5M");
  assert.equal(rec.usd, priceCodex("gpt-6.1-sol", { input: 1_500_000, cached: 0, output: 20_000 }));
  // A turn.completed with no usage, or one that reports no count, leaves the last total.
  assert.equal(parseCodex([...stream, ev({ type: "turn.completed" })].join("\n"), "gpt-6.1-sol").tokens.input, 1_500_000);
  const counts = (r) => (({ input, output, cached, written }) => ({ input, output, cached, written }))(r.tokens);
  assert.deepEqual(counts(parseCodex([...stream, ev({ type: "turn.completed", usage: {} })].join("\n"), "gpt-6.1-sol")), { input: 1_500_000, output: 20_000, cached: 0, written: null });
  // One that reports some counts only: each count it leaves out keeps its value before it.
  const partial = ev({ type: "turn.completed", usage: { input_tokens: 1_600_000 } });
  assert.deepEqual(counts(parseCodex([...stream, partial].join("\n"), "gpt-6.1-sol")), { input: 1_600_000, output: 20_000, cached: 0, written: null });
  const some = harnessActivity(() => 0);
  for (const line of [...stream, partial]) some.feed(line);
  assert.deepEqual(some.snapshot().tokens, { input: 1_600_000, output: 20_000, written: 0 }, "the live line keeps the output it had");
  const empty = harnessActivity(() => 0);
  for (const line of [...stream.slice(0, 2), ev({ type: "turn.completed", usage: {} }), stream[2]]) empty.feed(line);
  assert.deepEqual(empty.snapshot().tokens, { input: 1_500_000, output: 20_000, written: 0 }, "the live line counts from the last total, not from an empty one");
  // The progress comment's live status: the same reading, from the prior total of a resumed thread on.
  const live = harnessActivity(() => 0);
  live.since("t1", { tokens: { input: 400_000, output: 4_000 } });
  for (const line of stream) live.feed(line);
  assert.deepEqual(live.snapshot().tokens, { input: 1_100_000, output: 16_000, written: 0 });
});

test("codex: a model with no price row is a run of unknown cost, never zero", () => {
  const rec = parseCodex(fixture("codex-events.jsonl"), "gpt-unknown-9");
  assert.equal(rec.usd, null);
  assert.deepEqual([rec.usdUnknown, rec.usdUnknownWhy], [1, ["no-price"]]);
  assert.match(rec.basis, /unknown: no price for gpt-unknown-9/);
  assert.equal(priceCodex(null, { input: 1 }), null);
  assert.equal(priceCodex("gpt-5.5-codex-2026", { input: 1_000_000, cached: 0, output: 0 }), null, "no prefix match: an unlisted model is unmetered, not priced as gpt-5.5");
});

test("copilot: no usage output is a run of unknown cost, never zero; a non-zero exit is an error, not a death", () => {
  const rec = parseCopilot(fixture("copilot-stdout.txt"), null, 0);
  assert.equal(rec.ok, true);
  assert.equal(rec.usd, null);
  assert.deepEqual([rec.usdUnknown, rec.usdUnknownWhy], [1, ["unreported"]]);
  assert.deepEqual(rec.tokens, { input: null, output: null, cached: null, written: null });
  assert.match(rec.basis, /unknown: Copilot wrote no usage/);
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
  assert.equal(rec.usd, 0.0624015, "AI credits at GitHub's $0.01, not rounded (#565 W8)");
  assert.match(rec.basis, /^harness-reported: 6\.24 AI credits from copilot --usage-output-file at \$0\.01\/credit, 1 premium request/);
  assert.equal(finalText("copilot", fixture("copilot-events.jsonl")), "ok");
  // Without the file the stream's usage checkpoint still gives the credits; tokens stay unknown, never zero.
  const bare = parseCopilot(fixture("copilot-events.jsonl"), null, 0);
  assert.deepEqual(bare.tokens, { input: null, output: null, cached: null, written: null });
  assert.equal(bare.usd, 0.0624015);
  assert.match(bare.basis, /from the stream's usage checkpoint/);
  assert.match(parseCopilot("", null, 0).basis, /^unknown: Copilot wrote no usage/);
});

test("codex 0.160: the real probe JSONL (captured Nov 2) parses to one turn with cached tokens and a thread id", () => {
  const rec = parseCodex(fixture("codex-probe.jsonl"), "gpt-6.1-sol");
  assert.equal(rec.ok, true);
  assert.equal(rec.turns, 1);
  assert.equal(rec.sessionId, "01a19f63-ef53-7ef1-9da6-43fdffaa3891");
  assert.deepEqual(rec.tokens, { input: 14614, output: 5, cached: 12288, written: 0 });
  assert.equal(finalText("codex", fixture("codex-probe.jsonl")), "ok");
});

test("mergeUsage sums the known dollars, keeps null only when no run reported any, and counts the runs of unknown cost", () => {
  const a = parseClaude(fixture("claude-result.json"), "m");
  const b = parseClaude(fixture("claude-stream.jsonl"), "m");
  const m = mergeUsage([a, b]);
  assert.equal(m.usd, 7.4312 + 5.02);
  assert.equal(m.turns, 87 + 12);
  assert.equal(m.ok, false);
  assert.equal(m.budgetExceeded, true);
  const c = mergeUsage([parseCopilot("", null, 0), parseCopilot("", null, 0)]);
  assert.equal(c.usd, null);
  assert.deepEqual([c.usdUnknown, c.usdUnknownWhy], [2, ["unreported"]]);
  const mixed = mergeUsage([a, parseClaude("", "m"), parseCodex(fixture("codex-events.jsonl"), "gpt-unknown-9")]);
  assert.deepEqual([mixed.usd, mixed.usdUnknown, mixed.usdUnknownWhy], [7.4312, 2, ["unreported", "no-price"]], "an unknown run adds nothing to usd and is counted");
  assert.equal(mergeUsage([]), null);
});

test("on every route the model's commands never see a credential: Codex excludes them from its shell, Copilot names them secret", () => {
  const local = { addDirs: ["/u"], domains: ["github.com"], clone: "/c", readOnly: ["/u/bin"] };
  for (const route of [null, local]) {
    const x = harnessCommand({ harness: "codex", prompt: "P", local: route });
    const exclude = x.args.filter((a) => a.startsWith("shell_environment_policy.exclude="));
    assert.equal(exclude.length, 1, `codex ${route ? "local" : "runner"}: one exclude list`);
    assert.equal(x.args[x.args.indexOf(exclude[0]) - 1], "-c");
    for (const k of ["CODEX_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "COPILOT_GITHUB_TOKEN", "PENDULUM_APP_TOKEN", "AI_GATEWAY_API_KEY", "VERCEL_TOKEN"]) assert.ok(exclude[0].includes(JSON.stringify(k)), `codex: ${k} excluded`);
    const p = harnessCommand({ harness: "copilot", prompt: "P", local: route });
    const secret = p.args.filter((a) => a.startsWith("--secret-env-vars="));
    assert.equal(secret.length, 1, `copilot ${route ? "local" : "runner"}: one secret list`);
    assert.deepEqual(secret[0].slice("--secret-env-vars=".length).split(","), SHELL_SECRET_KEYS);
  }
  assert.ok(SHELL_SECRET_KEYS.includes("COPILOT_GITHUB_TOKEN") && !SHELL_SECRET_KEYS.includes("GH_CONFIG_DIR"), "the agent's read-only gh login stays");
});

test("localSandbox: a writable directory swapped for a symlink is refused", () => {
  const root = mkdtempSync(join(tmpdir(), "ls-"));
  const real = join(root, "real");
  mkdirSync(real);
  const env = (dir) => ({ PENDULUM_LOCAL: "1", PENDULUM_LOCAL_SANDBOX: JSON.stringify({ addDirs: [dir], clone: null }) });
  assert.deepEqual(localSandbox(env(real)).addDirs, [real]);
  const swapped = join(root, "swapped");
  symlinkSync(real, swapped);
  assert.throws(() => localSandbox(env(swapped)), /now resolves to/);
  assert.throws(() => localSandbox({ PENDULUM_LOCAL: "1" }), /refusing to run the harness unsandboxed/);
  rmSync(root, { recursive: true, force: true });
});

test("model, App, runner and GitHub secrets never reach a child", () => {
  const e = scrubbedEnv({ PATH: "/bin", ANTHROPIC_API_KEY: "sk", CODEX_API_KEY: "ck", PENDULUM_INPUT_CODEX_API_KEY: "ck", PENDULUM_INPUT_APP_PRIVATE_KEY: "pem", PENDULUM_INPUT_COPILOT_GITHUB_TOKEN: "cp", PENDULUM_INPUT_APP_TOKEN: "ghs", PENDULUM_INPUT_MODEL: "m", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc", ACTIONS_ID_TOKEN_REQUEST_URL: "u", ACTIONS_RUNTIME_TOKEN: "rt", PENDULUM_APP_TOKEN: "ghs", PENDULUM_APP_PRIVATE_KEY: "pem", GITHUB_TOKEN: "job", GH_CONFIG_DIR: "/auth", PENDULUM_GIT_TOKEN: "w", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "credential.helper", GIT_CONFIG_VALUE_0: "x" }, { GH_TOKEN: "t" });
  assert.deepEqual(e, { PATH: "/bin", PENDULUM_INPUT_MODEL: "m" });
});

test("sessions: a stage saves every session it ran (the reviewer's own too), masked, and only the lineage's is restored", async () => {
  const { restoreTranscript, saveTranscript } = await import("../scripts/lib/session.mjs");
  const root = mkdtempSync(join(tmpdir(), "sess-"));
  const saved = { CODEX_HOME: process.env.CODEX_HOME, PENDULUM_LOCAL: process.env.PENDULUM_LOCAL };
  process.env.CODEX_HOME = join(root, "codex");
  process.env.PENDULUM_LOCAL = "1";
  try {
    const day = join(root, "codex", "sessions", "2026", "11", "11");
    mkdirSync(day, { recursive: true });
    const rel = (id) => join("2026", "11", "11", `rollout-2026-11-11T09-00-00-${id}.jsonl`);
    for (const id of ["fix1", "rev1", "rev2"]) writeFileSync(join(root, "codex", "sessions", rel(id)), `{"id":"${id}","key":"sk-live-0123456789"}\n`);
    const ws = join(root, "ws");
    // A fresh review (no lineage): the reviewer's first pass and its rerun, each once, a record without a session skipped.
    const review = join(ws, "usage-review-1");
    mkdirSync(review, { recursive: true });
    const r = saveTranscript({ harness: "codex", sessionId: null, also: ["rev1", null, "rev2", "rev1"], usageDir: review, checkout: "/c", secrets: ["sk-live-0123456789"] });
    assert.deepEqual(r, { harness: "codex", id: null, files: [], checkout: "/c", others: [{ id: "rev1", files: [rel("rev1")] }, { id: "rev2", files: [rel("rev2")] }] });
    for (const id of ["rev1", "rev2"]) assert.equal(readFileSync(join(review, "transcript", rel(id)), "utf8"), `{"id":"${id}","key":"***"}\n`);
    // A review with a fix pass: the lineage's id and files as before, the reviewer's beside it.
    const fix = join(ws, "usage-review-2");
    mkdirSync(fix, { recursive: true });
    const s = saveTranscript({ harness: "codex", sessionId: "fix1", also: ["rev1", "fix1"], usageDir: fix, checkout: "/c", secrets: [] });
    assert.deepEqual(s, { harness: "codex", id: "fix1", files: [rel("fix1")], checkout: "/c", others: [{ id: "rev1", files: [rel("rev1")] }] });
    assert.equal(saveTranscript({ harness: "codex", sessionId: null, also: ["gone"], usageDir: join(ws, "none"), checkout: "/c" }), null);
    writeFileSync(join(fix, "result.json"), JSON.stringify({ session: s }));
    writeFileSync(join(review, "result.json"), JSON.stringify({ session: r }));
    rmSync(join(root, "codex", "sessions"), { recursive: true });
    // The newest stage saved only the reviewer's sessions: the restore looks past it to the lineage, and puts back its files only.
    assert.deepEqual(await restoreTranscript({ checkout: "/c", workDir: ws, harness: "codex" }), { id: "fix1", from: "usage-review-2", reason: "" });
    assert.ok(existsSync(join(root, "codex", "sessions", rel("fix1"))));
    assert.ok(!existsSync(join(root, "codex", "sessions", rel("rev1"))));
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
    rmSync(root, { recursive: true, force: true });
  }
});

test("a resumed Claude pass counts its own share, not the session's running total", async () => {
  // Shapes and numbers from a real run: the fix pass resumed the work session and reported the session's totals. Its
  // stream's init line names the Claude Code that ran (2.1.277 and later carry the running total on a resume).
  const init = JSON.stringify({ type: "system", subtype: "init", session_id: "s1", claude_code_version: "2.1.325" });
  const result = (turns, usd, opus, sonnet) => init + "\n" + JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: turns, session_id: "s1", total_cost_usd: usd,
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

test("a resumed Codex pass counts its own share, in this process and from an earlier stage; output is priced once", async () => {
  const { runHarness } = await import("../scripts/lib/harness.mjs");
  const { restoreTranscript } = await import("../scripts/lib/session.mjs");
  // Real Codex 0.167.0 streams: `codex exec`, then `codex exec resume` on its thread at high effort. turn.completed
  // carries the thread's running total; the rollout's own last_token_usage for the resumed turn was input 22888,
  // cached 12288, output 50 of which reasoning 43 (total_tokens 22938 = input + output).
  const bin = mkdtempSync(join(tmpdir(), "pendulum-codex-resume-"));
  const fixtures = join(import.meta.dirname, "fixtures");
  writeFileSync(join(bin, "codex"), `#!${process.execPath}
const fs = require("node:fs");
const resume = process.argv[3] === "resume" ? process.argv[4] : null;
const text = fs.readFileSync(${JSON.stringify(fixtures)} + (resume ? "/codex-0.167-thread-resumed.jsonl" : "/codex-0.167-thread.jsonl"), "utf8");
process.stdout.write(resume ? text.replaceAll("01a1c6ba-16b2-7a13-b2da-47bf51b4e724", resume) : text);
`, { mode: 0o755 });
  const saved = { PATH: process.env.PATH, CODEX_HOME: process.env.CODEX_HOME, PENDULUM_LOCAL: process.env.PENDULUM_LOCAL };
  process.env.PATH = `${bin}:${saved.PATH}`;
  const model = "gpt-6.1-sol";
  // Each pass feeds a live counter as the progress line does (session.mjs liveActivity), resumed passes told their prior.
  const live = [];
  const run = (resume, label) => {
    const tracker = harnessActivity();
    live.push(tracker);
    return runHarness({ harness: "codex", model, prompt: "p", maxUsd: 0, resume, cwd: bin, env: { HOME: process.env.HOME, PATH: process.env.PATH }, timeoutMs: 60_000, label, onLine: tracker.feed, onResume: tracker.since });
  };
  const shown = () => live.at(-1).snapshot().tokens;
  const turn = (input, cached) => ({ unit: "turn", input, cached, written: 0 });
  const near = (a, b, why) => assert.ok(Math.abs(a - b) < 1e-3, `${why}: ${a} vs ${b}`);
  try {
    const first = await run(null, "work-1");
    const thread = first.sessionId;
    assert.deepEqual(first.tokens, { input: 16151, output: 5, cached: 12288, written: 0 });
    assert.deepEqual(shown(), { input: 16151, output: 5, written: 0 }, "the live counter: input includes cached, output includes reasoning");
    const fix = await run(thread, "validation-fix-1");
    assert.deepEqual(fix.tokens, { input: 22888, output: 50, cached: 12288, written: 0 }, "the resumed pass's own share, reasoning inside output");
    assert.deepEqual(shown(), { input: 22888, output: 50, written: 0 }, "the live counter shows the resumed pass's own share");
    assert.deepEqual(fix.cache.first, turn(22888, 12288), "the cache split after a CI wait is the pass's own");
    near(fix.usd, priceCodex(model, fix.tokens), "priced on its own share");
    assert.deepEqual(fix.sessionTotal.tokens, { input: 39039, output: 55, cached: 24576, written: 0 });
    near(mergeUsage([first, fix]).usd, priceCodex(model, fix.sessionTotal.tokens), "the run costs what the thread reported last");

    // A later stage restores the thread: the prior total is the one Pendulum recorded in the saving stage's result.json.
    const root = mkdtempSync(join(tmpdir(), "pendulum-codex-stage-"));
    process.env.CODEX_HOME = join(root, "codex");
    process.env.PENDULUM_LOCAL = "1";
    const rel = join("2026", "11", "10", "rollout-2026-11-10T10-30-46-t2.jsonl");
    const usageDir = join(root, "ws", "usage-work-1");
    mkdirSync(join(usageDir, "transcript", "2026", "11", "10"), { recursive: true });
    writeFileSync(join(usageDir, "transcript", rel), "{}\n");
    writeFileSync(join(usageDir, "result.json"), JSON.stringify({ session: { harness: "codex", id: "t2", files: [rel], checkout: "/c" }, sessionTotal: first.sessionTotal }));
    assert.equal((await restoreTranscript({ checkout: "/c", workDir: join(root, "ws"), harness: "codex" })).id, "t2");
    delete process.env.PENDULUM_LOCAL;
    const review = await run("t2", "review-fix-1");
    assert.deepEqual(review.tokens, fix.tokens, "a restored thread counts only its own share too");
    assert.deepEqual(shown(), { input: 22888, output: 50, written: 0 });
    assert.deepEqual(review.cache.first, turn(22888, 12288));
    rmSync(root, { recursive: true, force: true });
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
    rmSync(bin, { recursive: true, force: true });
  }
});

test("copilot 1.0.107 (captured Nov 8): dollars are the AI credits at the configured rate; a resumed pass counts only its own share", () => {
  const file = (f) => join(import.meta.dirname, "fixtures", f);
  const first = parseCopilot("", null, 0, { usageFile: file("copilot-1.0.107-usage.json") });
  assert.equal(first.model, "claude-sonnet-5.5");
  assert.equal(first.premiumRequests, 1);
  assert.equal(first.aiu, 6.123);
  assert.equal(first.usd, 0.061228, "6,122,800,000 nano-AIU is 6.1228 credits: 24,472 cache-write tokens at $2.50 per million");
  assert.equal(parseCopilot("", null, 0, { usageFile: file("copilot-1.0.107-usage.json"), creditUsd: 0.02 }).usd, 0.122456, "the rate is a setting");
  // On --resume the file is the session's running total: two requests, both runs' tokens.
  const total = parseCopilot("", null, 0, { usageFile: file("copilot-1.0.107-usage-resumed.json") });
  assert.equal(total.premiumRequests, 2);
  assert.equal(total.sessionStartTime, first.sessionStartTime, "Copilot keeps the session's start time across --resume");
  const own = sinceSession(total, { usd: first.usd, tokens: first.tokens, models: null, premiumRequests: first.premiumRequests, aiu: first.aiu, sessionStartTime: first.sessionStartTime });
  assert.equal(own.premiumRequests, 1);
  assert.equal(own.aiu, 0.262);
  assert.ok(Math.abs(own.usd - 0.0026177) < 1e-9, `resumed pass usd ${own.usd}`);
  assert.deepEqual(own.tokens, { input: 24525, output: 4, cached: 24472, written: 49 });
  // A session restored from an earlier job: its saved events' last session.shutdown snapshot is the prior total.
  const seeded = copilotSessionTotal(readFileSync(file("copilot-1.0.107-session-events.jsonl"), "utf8"));
  assert.deepEqual({ usd: seeded.usd, premiumRequests: seeded.premiumRequests, aiu: seeded.aiu }, { usd: 0.061228, premiumRequests: 1, aiu: 6.123 });
  assert.equal(copilotSessionTotal('{"type":"session.start"}'), null);
  // A stage's runs are summed, premium requests and credits included; the progress line names both.
  const stage = mergeUsage([first, own]);
  assert.equal(stage.premiumRequests, 2);
  assert.equal(stage.aiu, 6.385);
  // #565 W8: the stage's passes add up to the session's credits' worth: no cent fraction lost to a pass's rounding.
  assert.ok(Math.abs(stage.usd - total.usd) < 1e-9, `stage usd ${stage.usd}`);
  assert.ok(Math.abs(stage.usd - 0.0638457) < 1e-9, `stage usd ${stage.usd}`);
  assert.equal(copilotCount({ premiumRequests: 2, aiCredits: 6.385 }), "; 2 premium requests, 6.385 AI credits");
  assert.equal(copilotCount({ premiumRequests: null, aiCredits: null }), "", "other harnesses add nothing");
  // A usage file with tokens but no AI credits (an older CLI) is a run of unknown cost, never zero.
  const dir = mkdtempSync(join(tmpdir(), "pendulum-copilot-"));
  writeFileSync(join(dir, "u.json"), JSON.stringify({ totalPremiumRequestCost: 3, modelMetrics: { m: { usage: { inputTokens: 10, outputTokens: 2 } } } }));
  const old = parseCopilot("", null, 0, { usageFile: join(dir, "u.json") });
  rmSync(dir, { recursive: true, force: true });
  assert.equal(old.usd, null);
  assert.deepEqual([old.usdUnknown, old.usdUnknownWhy], [1, ["credits"]]);
  assert.equal(old.premiumRequests, 3);
  assert.match(old.basis, /^unknown: no AI credits reported, 3 premium request\(s\)/);
});

test("copilot metering cannot be talked down: negative or forged-low credits, unpriced states, another session's total, an edited saved session", () => {
  const dir = mkdtempSync(join(tmpdir(), "pendulum-copilot-"));
  const real = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "copilot-1.0.107-usage.json"), "utf8"));
  const write = (name, patch) => {
    writeFileSync(join(dir, name), JSON.stringify({ ...real, ...patch }));
    return join(dir, name);
  };
  const checkpoint = (nano, requests) => JSON.stringify({ type: "session.usage_checkpoint", data: { totalNanoAiu: nano, totalPremiumRequests: requests } });
  const turn = JSON.stringify({ type: "assistant.turn_end" });
  // A negative count is no count: unknown, and no spend total ever goes down for it.
  const neg = parseCopilot(turn, null, 0, { usageFile: write("neg.json", { totalNanoAiu: -9e12 }) });
  assert.equal(neg.usd, null);
  assert.match(neg.basis, /^unknown: a negative AI credit count/);
  assert.deepEqual(sumSpend([{ usd: 1 }, { usd: -5 }, { usd: 2 }]), { usd: 3, unknown: 0 });
  assert.equal(mergeUsage([{ usd: -5, tokens: {} }, { usd: 2, tokens: {} }]).usd, 2);
  // A usage file rewritten low loses to the stream's own checkpoint totals.
  const low = parseCopilot([checkpoint(6122800000, 1), checkpoint(90e9, 4), turn].join("\n"), null, 0, { usageFile: write("low.json", { totalNanoAiu: 1e6, totalPremiumRequestCost: 0 }) });
  assert.equal(low.usd, 0.9);
  assert.equal(low.premiumRequests, 4);
  // Pending, unavailable or an unknown status is unknown; partial prices what was reported and the rest is unknown; zero
  // credits for tokens is unknown.
  for (const status of ["pending", "unavailable", "complete\n::error::x"]) assert.equal(parseCopilot(turn, null, 0, { usageFile: write("s.json", { aiCreditsStatus: status }) }).usd, null, status);
  assert.match(parseCopilot(turn, null, 0, { usageFile: write("s.json", { aiCreditsStatus: "nope" }) }).basis, /AI credits unknown/);
  const partial = parseCopilot(turn, null, 0, { usageFile: write("p.json", { aiCreditsStatus: "partial" }) });
  assert.equal(partial.usd, 0.061228);
  assert.deepEqual([partial.usdUnknown, partial.usdUnknownWhy], [1, ["credits", "unreported"]], "partial credits, and no result line after them");
  assert.match(partial.basis, /AI credits partial: the rest unknown/);
  assert.equal(parseCopilot(turn, null, 0, { usageFile: write("z.json", { totalNanoAiu: 0 }) }).usd, null);
  // A model name from the file is cleaned before it reaches a log line or the step summary.
  const named = parseCopilot("", null, 0, { usageFile: write("m.json", { modelMetrics: { "evil\n::set-output name=x::y": real.modelMetrics["claude-sonnet-5.5"] } }) });
  assert.equal(named.model, "evilset-outputnamexy");
  // A total from another session start is not this session's running total: counted as reported.
  const first = parseCopilot("", null, 0, { usageFile: join(import.meta.dirname, "fixtures", "copilot-1.0.107-usage.json") });
  const other = parseCopilot("", null, 0, { usageFile: write("o.json", { ...JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "copilot-1.0.107-usage-resumed.json"), "utf8")), sessionStartTime: "2026-11-08T22:00:00.000Z" }) });
  assert.equal(sinceSession(other, { ...first, models: null }).usd, other.usd);
  // A restored session's total (the harness wrote that file) is bounded by what Pendulum recorded for the stage.
  const seed = { usd: 50, aiu: 5000, premiumRequests: 40, tokens: { input: 9e6, output: 9e4, cached: 8e6, written: 9e5 }, sessionStartTime: first.sessionStartTime };
  assert.deepEqual(clampTotal(seed, { usd: 0.06, aiCredits: 6.123, premiumRequests: 1, tokens: { input: 24476, output: 4, cached: 0, written: 24472 } }), { ...seed, usd: 0.06, aiu: 6.123, premiumRequests: 1, tokens: { input: 24476, output: 4, cached: 0, written: 24472 } });
  assert.equal(clampTotal(seed, { usd: null }), null, "nothing recorded: nothing subtracted");
  rmSync(dir, { recursive: true, force: true });
});


test("a session restored from an earlier job counts its own share: the transcript's last cost-state is the prior total", async () => {
  const { transcriptTotal } = await import("../scripts/lib/usage.mjs");
  // Shapes and numbers from a real resumed session: Claude Code writes a cost-state line as each process ends.
  const state = (usd, input, output, written) => JSON.stringify({ type: "cost-state", sessionId: "s1", totalCostUSD: usd, modelUsage: { "claude-haiku-5-5": { inputTokens: input, outputTokens: output, cacheReadInputTokens: 0, cacheCreationInputTokens: written, costUSD: usd } } });
  const transcript = [JSON.stringify({ type: "user", message: { content: "say hi" } }), state(0.0040019, 1, 90, 20000), JSON.stringify({ type: "assistant" }), state(0.0060084, 2, 150, 21446), ""].join("\n");
  const prior = transcriptTotal(transcript);
  assert.equal(prior.usd, 0.0060084, "the last cost-state line wins");
  assert.equal(prior.models["claude-haiku-5-5"].output, 150);
  assert.equal(transcriptTotal('{"type":"user"}\n'), null, "no cost-state: no prior total");
  const reported = parseUsage("claude", JSON.stringify({ type: "system", subtype: "init", session_id: "s1", claude_code_version: "2.1.277" }) + "\n" + JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1, session_id: "s1", total_cost_usd: 0.00635726, modelUsage: { "claude-haiku-5-5": { inputTokens: 4, outputTokens: 182, cacheReadInputTokens: 21446, cacheCreationInputTokens: 21446, costUSD: 0.00635726 } } }), "claude-haiku-5-5", 0);
  const own = sinceSession(reported, prior);
  assert.ok(Math.abs(own.usd - 0.00034886) < 1e-9, `resumed pass usd ${own.usd}`);
  assert.equal(own.models["claude-haiku-5-5"].output, 32);
});

test("copilot caps: --max-ai-credits from what is left, at least 30, and none with no cap", () => {
  const credits = (maxUsd, creditUsd) => {
    const a = harnessCommand({ harness: "copilot", prompt: "P", maxUsd, creditUsd }).args;
    return a.includes("--max-ai-credits") ? a[a.indexOf("--max-ai-credits") + 1] : null;
  };
  assert.equal(credits(25, 0.01), "2500");
  assert.equal(credits(0.1, 0.01), "30", "Copilot refuses fewer than 30");
  assert.equal(credits(0, 0.01), null, "no cap set, no flag");
});
