import "./temp.mjs";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CODEX_PRICES, mergeUsage, parseCodex, priceCodex, sinceSession, unpricedCodex } from "../scripts/lib/usage.mjs";
import { codexRollout, withSubAgents } from "../scripts/lib/codex-threads.mjs";
import { runHarness } from "../scripts/lib/harness.mjs";
import { modelProblem } from "../scripts/lib/choice.mjs";
import { credentialChecks } from "../scripts/doctor.mjs";
import { costOf } from "../../bench/lib/cost.mjs";

// OpenAI's published rates (developers.openai.com/api/docs/pricing and the model pages, read 2026-11-16): a request with
// more than 272K input tokens is priced, every token of it, at the long-context rates; GPT-5.6 Sol's rates are
// promotional until November 30, 2026; the `gpt-5.6` alias routes to GPT-5.6 Sol.

const THREAD = "01a1e000-0000-7000-8000-000000000001";
/** A `codex exec --json` stream whose one turn reported `t` (the thread's running total). */
const stream = (t, thread = THREAD) => `${JSON.stringify({ type: "thread.started", thread_id: thread })}\n${JSON.stringify({ type: "turn.completed", usage: { input_tokens: t.input, cached_input_tokens: t.cached ?? 0, cache_write_input_tokens: t.written ?? 0, output_tokens: t.output } })}\n`;
const usage = (u) => ({ input_tokens: u.input, cached_input_tokens: u.cached ?? 0, cache_write_input_tokens: u.written ?? 0, output_tokens: u.output });
/** Rollout `token_count` lines for `requests` in order (each request's usage), starting from `from` (an earlier total). */
function counts(requests, from = { input: 0, cached: 0, written: 0, output: 0 }) {
  const total = { ...from };
  return requests.map((r) => {
    for (const k of Object.keys(total)) total[k] += r[k] ?? 0;
    return JSON.stringify({ timestamp: "2026-11-16T10:00:00.000Z", type: "event_msg", payload: { type: "token_count", info: { total_token_usage: usage(total), last_token_usage: usage(r), model_context_window: 1050000 } } });
  }).join("\n");
}
const sum = (requests) => requests.reduce((t, r) => ({ input: t.input + r.input, cached: t.cached + (r.cached ?? 0), written: t.written + (r.written ?? 0), output: t.output + r.output }), { input: 0, cached: 0, written: 0, output: 0 });
const NO_LONG = { input: 0, cached: 0, written: 0, output: 0 };

test("corrected rates: the Codex models OpenAI lists at a cached rate of 0.125 and 0.025 are priced at it, not the gateway's rounding", () => {
  const cachedOnly = { input: 1_000_000, cached: 1_000_000, written: 0, output: 0 };
  // These models have no long-context tier, so a figure of any size is priced exactly.
  assert.equal(priceCodex("gpt-5-codex", cachedOnly), 0.125);
  assert.equal(priceCodex("gpt-5.1-codex", cachedOnly), 0.125);
  assert.equal(priceCodex("gpt-5.1-codex-mini", cachedOnly), 0.025);
  assert.equal(CODEX_PRICES.date, "2026-11-16");
});

test("the long-context tier: a request over 272K input tokens is priced at the long rates, read request by request from the rollout", () => {
  // The audit's example: one gpt-5.5 request of 400K input and 10K output is $4.45 (2x input, 1.5x output), not $2.30.
  const one = [{ input: 400_000, output: 10_000 }];
  const rec = parseCodex(stream(sum(one)), "gpt-5.5", { requests: counts(one) });
  assert.equal(rec.usd, 4.45);
  assert.deepEqual(rec.tokens.long, { input: 400_000, cached: 0, written: 0, output: 10_000 });
  assert.ok(!rec.usdUnknown);
  // Two requests: only the one over the threshold is at the long rates, its cached tokens at the long cached rate.
  const two = [{ input: 200_000, cached: 100_000, output: 5_000 }, { input: 300_000, cached: 250_000, output: 5_000 }];
  const mixed = parseCodex(stream(sum(two)), "gpt-5.5", { requests: counts(two) });
  const short = 100_000 * 5 + 100_000 * 0.5 + 5_000 * 30;
  const long = 50_000 * 10 + 250_000 * 1 + 5_000 * 45;
  assert.equal(mixed.usd, Math.round(((short + long) / 1e6) * 10000) / 10000);
  // A rate-limit update repeats the total: it is no request, and nothing is counted twice.
  const lines = counts(two).split("\n");
  assert.equal(parseCodex(stream(sum(two)), "gpt-5.5", { requests: [lines[0], lines[1], lines[1]].join("\n") }).usd, mixed.usd);
  // At most the threshold in all: no request in it can be over, so no rollout is needed.
  assert.equal(parseCodex(stream({ input: 272_000, output: 1_000 }), "gpt-5.5").usd, Math.round(((272_000 * 5 + 1_000 * 30) / 1e6) * 10000) / 10000);
});

test("the long-context tier, unknown: a run past the threshold whose requests cannot be read is of unknown cost, never short-priced", () => {
  const one = [{ input: 400_000, output: 10_000 }];
  for (const [why, requests] of [
    ["no rollout", null],
    ["a rollout that ends before the stream's total", counts([{ input: 100_000, output: 1_000 }])],
    ["requests before the rollout's first that passed the threshold", counts([{ input: 100_000, output: 1_000 }], { input: 300_000, cached: 0, written: 0, output: 9_000 })],
  ]) {
    const rec = parseCodex(stream(sum(one)), "gpt-5.5", { requests });
    assert.equal(rec.usd, null, why);
    assert.deepEqual([rec.usdUnknown, rec.usdUnknownWhy], [1, ["long-context"]], why);
    assert.equal(rec.tokens.long, null, why);
    assert.match(rec.basis, /long-context threshold/, why);
  }
  // Earlier requests the rollout does not hold that together stayed under the threshold had no long-context tokens.
  const later = [{ input: 300_000, output: 1_000 }];
  assert.equal(parseCodex(stream(sum([{ input: 100_000, output: 9_000 }, ...later])), "gpt-5.5", { requests: counts(later, { input: 100_000, cached: 0, written: 0, output: 9_000 }) }).usd, Math.round(((100_000 * 5 + 9_000 * 30 + 300_000 * 10 + 1_000 * 45) / 1e6) * 10000) / 10000);
  // A model with no long-context tier is priced whatever its size.
  assert.equal(parseCodex(stream(sum(one)), "gpt-5.4-mini").usd, Math.round(((400_000 * 0.75 + 10_000 * 4.5) / 1e6) * 10000) / 10000);
});

test("the long-context share follows a resumed pass, a stage's passes, a sub-agent thread and the bench's re-pricing", () => {
  // A resumed pass: the thread's running share less the one counted before.
  const firstReqs = [{ input: 200_000, output: 2_000 }];
  const first = parseCodex(stream(sum(firstReqs)), "gpt-5.5", { requests: counts(firstReqs) });
  const allReqs = [...firstReqs, { input: 300_000, output: 3_000 }];
  const resumed = parseCodex(stream(sum(allReqs)), "gpt-5.5", { requests: counts(allReqs) });
  const own = sinceSession(resumed, { usd: first.usd, tokens: first.tokens });
  assert.deepEqual(own.tokens, { input: 300_000, output: 3_000, cached: 0, written: 0, long: { input: 300_000, cached: 0, written: 0, output: 3_000 } });
  assert.equal(Math.round(own.usd * 10000) / 10000, Math.round(((300_000 * 10 + 3_000 * 45) / 1e6) * 10000) / 10000);
  // Two passes of a stage, each under the threshold: their sum passes it, with no long-context tokens.
  const a = parseCodex(stream({ input: 200_000, output: 1_000 }), "gpt-5.5");
  const b = parseCodex(stream({ input: 200_000, output: 1_000 }, "01a1e000-0000-7000-8000-000000000002"), "gpt-5.5");
  const stage = mergeUsage([a, b]);
  assert.deepEqual(stage.tokens.long, NO_LONG);
  const bench = costOf([{ harness: "codex", model: "gpt-5.5", runs: 1, tokens: stage.tokens, ended: "2026-11-16T10:00:00Z" }], CODEX_PRICES);
  assert.equal(bench.usd, stage.usd, "the bench re-prices the same record to the same dollars");
  // A record without its share (one written before Pendulum read it) whose input passed the threshold: unknown.
  const legacy = costOf([{ harness: "codex", model: "gpt-5.5", runs: 1, tokens: { input: 400_000, cached: 0, written: 0, output: 10_000 }, ended: "2026-11-16T10:00:00Z" }], CODEX_PRICES);
  assert.equal(legacy.usd, null);
  assert.deepEqual(legacy.usdUnknownWhy, ["long-context"]);
  // A sub-agent thread's own rollout gives its share; the run's record and the bench price it the same way.
  const childReqs = [{ input: 100_000, output: 1_000 }, { input: 280_000, output: 2_000 }];
  const meta = JSON.stringify({ type: "session_meta", payload: { id: "01a1e000-0000-7000-8000-0000000000c1", source: { subagent: { thread_spawn: { parent_thread_id: THREAD } } } } });
  const child = codexRollout(`${meta}\n${counts(childReqs)}\n`);
  assert.deepEqual(child.tokens.long, { input: 280_000, cached: 0, written: 0, output: 2_000 });
  const parent = parseCodex(stream({ input: 10_000, output: 100 }), "gpt-5.5");
  const { rec } = withSubAgents(parent, [child]);
  const childUsd = Math.round(((100_000 * 5 + 1_000 * 30 + 280_000 * 10 + 2_000 * 45) / 1e6) * 10000) / 10000;
  assert.equal(rec.subAgents[0].usd, childUsd);
  assert.equal(costOf([{ harness: "codex", model: "gpt-5.5", runs: 1, tokens: rec.tokens, subAgents: rec.subAgents, ended: "2026-11-16T10:00:00Z" }], CODEX_PRICES).usd, rec.usd);
});

test("the long-context tier through runHarness: the pass's rollout prices its requests", async () => {
  const work = mkdtempSync(join(tmpdir(), "codex-long-"));
  const home = join(work, "codex");
  const day = join(home, "sessions", "2026", "11", "16");
  mkdirSync(day, { recursive: true });
  const bin = join(work, "bin");
  mkdirSync(bin);
  const one = [{ input: 400_000, output: 10_000 }];
  writeFileSync(join(work, "stdout.jsonl"), stream(sum(one)));
  writeFileSync(join(work, "rollout.jsonl"), `${JSON.stringify({ type: "session_meta", payload: { id: THREAD } })}\n${counts(one)}\n`);
  // A fake codex: writes its thread's rollout where Codex does, then prints its stream.
  writeFileSync(join(bin, "codex"), `#!${process.execPath}\nconst fs = require("node:fs");\nfs.copyFileSync(${JSON.stringify(join(work, "rollout.jsonl"))}, ${JSON.stringify(join(day, `rollout-2026-11-16T10-00-00-${THREAD}.jsonl`))});\nprocess.stdout.write(fs.readFileSync(${JSON.stringify(join(work, "stdout.jsonl"))}, "utf8"));\n`, { mode: 0o755 });
  const saved = { PATH: process.env.PATH, CODEX_HOME: process.env.CODEX_HOME };
  process.env.PATH = `${bin}:${saved.PATH}`;
  process.env.CODEX_HOME = home;
  try {
    const rec = await runHarness({ harness: "codex", model: "gpt-5.5", prompt: "p", maxUsd: 0, cwd: work, env: { HOME: process.env.HOME, PATH: process.env.PATH, CODEX_HOME: home }, timeoutMs: 60_000, label: "work-1" });
    assert.equal(rec.usd, 4.45);
    assert.ok(!rec.usdUnknown);
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
    rmSync(work, { recursive: true, force: true });
  }
});

test("an alias OpenAI documents resolves to its model; other aliases and -latest ids stay of unknown cost", () => {
  const t = { input: 100_000, cached: 50_000, written: 10_000, output: 1_000 };
  const at = "2026-11-16T10:00:00Z";
  assert.equal(priceCodex("gpt-5.6", t, { at }), priceCodex("gpt-5.6-sol", t, { at }));
  assert.equal(priceCodex("openai/gpt-5.6", t, { at }), priceCodex("gpt-5.6-sol", t, { at }));
  assert.equal(priceCodex("gpt-5.6", t, { at }), Math.round(((40_000 * 4 + 50_000 * 0.4 + 10_000 * 5 + 1_000 * 20) / 1e6) * 10000) / 10000);
  assert.equal(modelProblem("codex", "gpt-5.6"), null, "a model the table prices runs");
  for (const id of ["gpt-daybreak-blue-latest", "gpt-daybreak-red-latest", "chat-latest", "gpt-5.5-pro", "gpt-5.6-latest"]) {
    assert.equal(priceCodex(id, t, { at }), null, id);
    const rec = parseCodex(stream(t), id, { at });
    assert.deepEqual([rec.usd, rec.usdUnknownWhy], [null, ["no-price"]], id);
  }
});

test("a promotional rate prices spend before its end only, and doctor warns in the week before and fails from then on", async () => {
  const t = { input: 100_000, cached: 0, written: 0, output: 1_000 };
  const before = parseCodex(stream(t), "gpt-5.6-sol", { at: "2026-11-29T23:59:59Z" });
  assert.equal(before.usd, Math.round(((100_000 * 4 + 1_000 * 20) / 1e6) * 10000) / 10000);
  const after = parseCodex(stream(t), "gpt-5.6-sol", { at: "2026-11-30T00:00:00Z" });
  assert.deepEqual([after.usd, after.usdUnknown, after.usdUnknownWhy], [null, 1, ["price-ended"]]);
  assert.match(unpricedCodex("codex", "gpt-5.6", { at: "2026-12-01T00:00:00Z" }), /^gpt-5\.6's rate in the Codex price table .* is OpenAI's promotional rate for gpt-5\.6-sol, which ended 2026-11-30: its runs are of unknown cost/);
  // The bench dates each record by its own time; a record with none cannot be priced at a dated rate.
  const record = (ended) => ({ harness: "codex", model: "gpt-5.6-sol", runs: 1, tokens: t, ...(ended ? { ended } : {}) });
  assert.equal(costOf([record("2026-11-20T10:00:00Z")], CODEX_PRICES).usd, before.usd);
  for (const ended of ["2026-12-01T10:00:00Z", null]) {
    const cost = costOf([record(ended)], CODEX_PRICES);
    assert.deepEqual([cost.usd, cost.usdUnknownWhy], [null, ["price-ended"]], String(ended));
  }
  // Doctor, on the workflow's model or the alias that routes to it.
  const env = { GITHUB_ACTIONS: "true", PENDULUM_INPUT_CODEX_API_KEY: "sk-c" };
  const row = async (model, now) => (await credentialChecks({ inputs: { harness: "codex", credential: "api", model, codexApiKey: "sk-c" }, env, now: Date.parse(now) })).find((c) => c.name === "codex model") ?? null;
  assert.equal(await row("gpt-5.6-sol", "2026-11-22T23:59:59Z"), null, "more than 7 days before: nothing to say");
  const warn = await row("gpt-5.6-sol", "2026-11-23T00:00:00Z");
  assert.equal(warn?.status, "WARN");
  assert.match(warn.detail, /promotional rate for gpt-5\.6-sol, which ends 2026-11-30/);
  const fail = await row("gpt-5.6", "2026-11-30T00:00:00Z");
  assert.equal(fail?.status, "FAIL");
  assert.match(fail.detail, /^gpt-5\.6 is priced at OpenAI's promotional rate for gpt-5\.6-sol, which ended 2026-11-30: its runs are of unknown cost/);
  assert.equal(await row("gpt-6.1-sol", "2026-12-01T00:00:00Z"), null, "a rate with no end: nothing to say");
});

test("a resume after a pass of unknown cost counts only its own tokens: the unknown pass's running total is subtracted", async () => {
  // Pass 1 passed the threshold with no rollout to read: unknown. Pass 2 resumes the thread, whose rollout now reads.
  const first = [{ input: 300_000, output: 2_000 }];
  const all = [...first, { input: 160_000, output: 1_000 }];
  const one = parseCodex(stream(sum(first)), "gpt-6.1-sol");
  assert.deepEqual([one.usd, one.usdUnknownWhy], [null, ["long-context"]]);
  const two = sinceSession(parseCodex(stream(sum(all)), "gpt-6.1-sol", { requests: counts(all) }), { usd: one.usd, tokens: one.tokens });
  assert.deepEqual(two.tokens, { input: 160_000, output: 1_000, cached: 0, written: 0 });
  assert.equal(two.usd, Math.round(((160_000 * 2 + 1_000 * 10) / 1e6) * 10000) / 10000, "its own 160K, never pass 1's 300K again");
  assert.ok(!two.usdUnknown);
  // The same through runHarness: the unknown pass's total is kept as the session's, and the resume subtracts it.
  const work = mkdtempSync(join(tmpdir(), "codex-resume-"));
  const home = join(work, "codex");
  const day = join(home, "sessions", "2026", "11", "16");
  const bin = join(work, "bin");
  mkdirSync(bin, { recursive: true });
  // The fake codex prints `stdout.jsonl` and, when there is one, copies `rollout.jsonl` where Codex writes it.
  writeFileSync(join(bin, "codex"), `#!${process.execPath}\nconst fs = require("node:fs");\nif (fs.existsSync(${JSON.stringify(join(work, "rollout.jsonl"))})) { fs.mkdirSync(${JSON.stringify(day)}, { recursive: true }); fs.copyFileSync(${JSON.stringify(join(work, "rollout.jsonl"))}, ${JSON.stringify(join(day, `rollout-2026-11-16T10-00-00-${THREAD}.jsonl`))}); }\nprocess.stdout.write(fs.readFileSync(${JSON.stringify(join(work, "stdout.jsonl"))}, "utf8"));\n`, { mode: 0o755 });
  const saved = { PATH: process.env.PATH, CODEX_HOME: process.env.CODEX_HOME };
  process.env.PATH = `${bin}:${saved.PATH}`;
  process.env.CODEX_HOME = home;
  const run = (resume, label) => runHarness({ harness: "codex", model: "gpt-6.1-sol", prompt: "p", maxUsd: 0, resume, cwd: work, env: { HOME: process.env.HOME, PATH: process.env.PATH, CODEX_HOME: home }, timeoutMs: 60_000, label });
  try {
    writeFileSync(join(work, "stdout.jsonl"), stream(sum(first)));
    const a = await run(null, "work-1");
    assert.deepEqual([a.usd, a.usdUnknownWhy], [null, ["long-context"]]);
    writeFileSync(join(work, "stdout.jsonl"), stream(sum(all)));
    writeFileSync(join(work, "rollout.jsonl"), `${JSON.stringify({ type: "session_meta", payload: { id: THREAD } })}\n${counts(all)}\n`);
    const b = await run(THREAD, "validation-fix-1");
    assert.equal(b.usd, two.usd);
    assert.ok(!b.usdUnknown);
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
    rmSync(work, { recursive: true, force: true });
  }
});

test("a thread across the promotional rate's end: each pass is priced at its own time, and none is counted twice", () => {
  const t1 = { input: 100_000, output: 1_000 };
  const t2 = { input: 150_000, output: 1_500 };
  const t3 = { input: 180_000, output: 1_800 };
  const p1 = parseCodex(stream(t1), "gpt-5.6-sol", { at: "2026-11-29T20:00:00Z" });
  assert.equal(p1.usd, Math.round(((100_000 * 4 + 1_000 * 20) / 1e6) * 10000) / 10000);
  // Ended after it: of unknown cost, its share 50K.
  const p2 = sinceSession(parseCodex(stream(t2), "gpt-5.6-sol", { at: "2026-11-30T01:00:00Z" }), { usd: p1.usd, tokens: p1.tokens }, { at: "2026-11-30T01:00:00Z" });
  assert.deepEqual([p2.usd, p2.usdUnknownWhy, p2.tokens.input], [null, ["price-ended"], 50_000]);
  // The next pass subtracts that pass's total, though its dollars were unknown.
  const p3 = sinceSession(parseCodex(stream(t3), "gpt-5.6-sol", { at: "2026-12-01T00:00:00Z" }), { usd: p2.sessionTotal.usd, tokens: p2.sessionTotal.tokens }, { at: "2026-12-01T00:00:00Z" });
  assert.deepEqual([p3.usd, p3.usdUnknownWhy, p3.tokens.input], [null, ["price-ended"], 30_000]);
});

test("the bench dates a stage by its latest record's end: a stage across the promotional rate's end is of unknown cost", () => {
  const pass = (t, ended, extra = {}) => ({ ...parseCodex(stream(t), "gpt-5.6-sol", { at: ended }), started: ended, ended, ...extra });
  const before = pass({ input: 100_000, output: 1_000 }, "2026-11-29T20:00:00Z");
  const after = pass({ input: 50_000, output: 500 }, "2026-11-30T02:00:00Z");
  // A decision call, kept last in the stage's records, that ended before the last pass.
  const decision = pass({ input: 2_000, output: 50 }, "2026-11-29T21:00:00Z", { decision: true, label: "decision" });
  const stage = mergeUsage([before, decision, after]);
  assert.equal(stage.ended, "2026-11-30T02:00:00Z");
  assert.equal(mergeUsage([before, after, decision]).ended, "2026-11-30T02:00:00Z", "whatever the order");
  const cost = costOf([{ ...stage, runs: 2 }], CODEX_PRICES);
  assert.deepEqual([cost.usd, cost.usdUnknownWhy], [null, ["price-ended"]]);
  // A record with a start but no end is not dated by its start.
  const { ended: _, ...noEnd } = before;
  assert.deepEqual(costOf([{ ...noEnd, runs: 1 }], CODEX_PRICES).usd, null);
  assert.equal(costOf([{ ...before, runs: 1 }], CODEX_PRICES).usd, before.usd);
});

test("doctor: a Codex API key's dollars assume the OpenAI project's Standard Service Tier, which Codex does not report", async () => {
  const checks = await credentialChecks({ inputs: { harness: "codex", credential: "api", model: "gpt-6.1-sol", codexApiKey: "sk-c" }, env: { GITHUB_ACTIONS: "true", PENDULUM_INPUT_CODEX_API_KEY: "sk-c" } });
  const row = checks.find((c) => c.name === "codex tier");
  assert.equal(row?.status, "WARN");
  assert.match(row.detail, /Standard rates.*Service Tier is Standard.*Fast is billed 2× those rates \(2\.5× on gpt-5\.5, 1\.8× on gpt-5-mini\)/);
  const gateway = await credentialChecks({ inputs: { harness: "codex", credential: "api", model: "gpt-6.1-sol", codexGatewayKey: "vck_g" }, env: { GITHUB_ACTIONS: "true", PENDULUM_INPUT_CODEX_GATEWAY_KEY: "vck_g" } });
  assert.equal(gateway.find((c) => c.name === "codex tier"), undefined, "the gateway's own account, not the adopter's project");
});
