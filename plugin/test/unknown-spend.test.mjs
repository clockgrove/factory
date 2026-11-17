// Spend a harness did not report is unknown (#478, #483): never $0, never a guess, never a bound. Each case below runs
// the real pass (runHarness on a fake harness CLI) and follows its record end to end: the stage's result.json, its
// spend line and exit line, the cap (known dollars only: the stage goes on), the daily_usd total and the scorer. A
// guard keeps every estimate, bound and fallback price out of the code.
import "./temp.mjs";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import { runHarness, seedSessionTotal } from "../scripts/lib/harness.mjs";
import { writeUsage } from "../scripts/lib/session.mjs";
import { capReached, harnessActivity, selectReady, spendMarker, stageSpendLine, sumSpend, usdText } from "../scripts/lib/logic.mjs";
import { CODEX_PRICES, UNKNOWN_WHY, claudeRunningTotals } from "../scripts/lib/usage.mjs";
import { todaysSpend } from "../scripts/dispatch.mjs";
import { costOf } from "../../bench/lib/cost.mjs";
import { spendRecords } from "../../bench/lib/objective.mjs";

const ROOT = join(import.meta.dirname, "..", "..");

/**
 * Fake `claude` and `codex` CLIs on a PATH of their own, each doing what FAKE_MODE says:
 * - claude-killed: its init line and one assistant message with usage, then silence (the wall clock ends it);
 * - claude-zeroed: an assistant message that reported tokens, then an error result with total_cost_usd 0;
 * - claude-resumed: a resumed session's result at $0.80, on Claude Code FAKE_VERSION;
 * - codex-killed: its thread, then silence (no turn.completed);
 * - codex-turn: one completed turn (priced or not by the model the pass names).
 */
function fakeBin() {
  const bin = mkdtempSync(join(tmpdir(), "unknown-spend-"));
  const line = (o) => `console.log(${JSON.stringify(JSON.stringify(o))});`;
  const init = (version) => ({ type: "system", subtype: "init", session_id: "s1", claude_code_version: version });
  const assistant = { type: "assistant", message: { id: "msg_1", model: "claude-opus-5-5", usage: { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 40000, cache_creation_input_tokens: 5000 }, content: [{ type: "text", text: "working" }] } };
  writeFileSync(join(bin, "claude"), `#!${process.execPath}
const mode = process.env.FAKE_MODE;
if (mode === "claude-killed") { ${line(init("2.1.325"))} ${line(assistant)} setTimeout(() => {}, 60000); }
if (mode === "claude-zeroed") { ${line(init("2.1.325"))} ${line(assistant)} ${line({ type: "result", subtype: "error_during_execution", is_error: true, session_id: "s1", num_turns: 3, total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 }, modelUsage: {} })} }
if (mode === "claude-resumed") {
  console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "s1", claude_code_version: process.env.FAKE_VERSION }));
  ${line({ type: "result", subtype: "success", is_error: false, session_id: "s1", num_turns: 2, total_cost_usd: 0.8, result: "ok" })}
}
`, { mode: 0o755 });
  writeFileSync(join(bin, "codex"), `#!${process.execPath}
const mode = process.env.FAKE_MODE;
${line({ type: "thread.started", thread_id: "01a1c6ba-16b2-7a13-b2da-47bf51b4e724" })}
if (mode === "codex-killed") setTimeout(() => {}, 60000);
if (mode === "codex-turn") ${line({ type: "turn.completed", usage: { input_tokens: 200000, cached_input_tokens: 100000, cache_write_input_tokens: 0, output_tokens: 5000, reasoning_output_tokens: 0 } })}
`, { mode: 0o755 });
  return bin;
}

const BIN = fakeBin();
const pass = (harness, model, mode, { resume = null, timeoutMs = 60_000, version = "" } = {}) =>
  runHarness({ harness, model, prompt: "p", maxUsd: 25, resume, cwd: BIN, env: { HOME: process.env.HOME, PATH: `${BIN}:${process.env.PATH}`, CODEX_HOME: join(BIN, "codex-home"), FAKE_MODE: mode, FAKE_VERSION: version }, timeoutMs, label: "work-1" });

/** A fake GitHub that lists `comments` as the repository's comments updated today, and no usage artifact. */
async function fakeGitHub(comments) {
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(/\/issues\/comments/.test(req.url) ? comments : []));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

/**
 * One stage of a known $2.00 pass and `rec` (a run of unknown cost, `why`) followed end to end: its result.json, spend
 * line, exit line, cap, the day's total and the scorecard all carry it as one run of unknown cost beside the $2.00.
 */
async function endToEnd(rec, why, { harness, model }) {
  const known = { harness, model, usd: 2, tokens: { input: 1000, output: 100, cached: 0, written: 0 }, basis: harness === "claude" ? "harness-reported: total_cost_usd, modelUsage (sub-agents included)" : "priced from table", ok: true, label: "work-0", started: "2026-11-16T10:00:00Z", ended: "2026-11-16T10:10:00Z" };
  const records = harness === "claude" ? [known, rec] : [rec];
  const knownUsd = harness === "claude" ? 2 : 0;
  // The record.
  assert.equal(rec.usd, null, `${why}: no dollar figure for what was not reported`);
  assert.deepEqual([rec.usdUnknown, rec.usdUnknownWhy], [1, [why]], why);
  // result.json: the known dollars and the run of unknown cost, never a bound.
  const dir = mkdtempSync(join(tmpdir(), "unknown-usage-"));
  const usage = writeUsage(dir, { harness, model, records, passes: records.length, exit: "delivered", reason: "", credentialBasis: "api-key" });
  const stored = JSON.parse(readFileSync(join(dir, "result.json"), "utf8"));
  assert.deepEqual([stored.usd ?? 0, stored.usdUnknown, stored.usdUnknownWhy], [knownUsd, 1, [why]], `${why}: result.json`);
  for (const k of ["usdLowerBound", "usdUpperBound"]) assert.equal(stored[k], undefined, `${why}: ${k}`);
  // The spend line, and the exit line's dollars.
  const line = stageSpendLine(usage);
  assert.deepEqual(line, { usd: knownUsd, parts: { usdUnknown: 1, usdUnknownWhy: [why] } }, `${why}: spend line`);
  assert.match(usdText(usage), knownUsd ? /^2 plus 1 run of unknown cost \(/ : /^unknown \(/, `${why}: exit line`);
  assert.ok(usdText(usage).includes(UNKNOWN_WHY[why]), `${why}: the exit line says why`);
  // The cap compares the known dollars only: under it the stage goes on; the unknown run never fills it.
  assert.deepEqual(sumSpend(records), { usd: knownUsd, unknown: 1 });
  assert.equal(capReached(knownUsd + 0.01, records), false, `${why}: the stage goes on under its cap`);
  // daily_usd's total: the spend line's known dollars plus one run of unknown cost, and the gate's words say so.
  const body = `<!-- pendulum:7:progress:work:1 -->\nPendulum work.\n${spendMarker(line.usd, line.parts)}`;
  const gh = await fakeGitHub([{ id: 1, user: { login: "owner", type: "User" }, author_association: "OWNER", updated_at: new Date().toISOString(), body }]);
  const saved = process.env.GITHUB_API_URL;
  process.env.GITHUB_API_URL = gh.url;
  let day;
  try {
    day = await todaysSpend({ owner: "o", name: "r", full: "o/r" }, { sandbox: true }, { token: "t" });
  } finally {
    if (saved === undefined) delete process.env.GITHUB_API_URL;
    else process.env.GITHUB_API_URL = saved;
    gh.close();
  }
  assert.deepEqual([day.spentToday, day.unknownToday], [knownUsd, 1], `${why}: daily_usd's total`);
  const gate = selectReady({ issues: [{ number: 9, labels: [] }], maxConcurrent: 3, dailyUsd: 0.01, spentToday: Math.max(day.spentToday, 0.01), unknownToday: day.unknownToday });
  assert.match(gate.skipped[0].reason, /plus 1 run of unknown cost of \$0\.01\)$/, `${why}: daily_usd's words`);
  // The scorer, from the usage artifact and from the spend line.
  const prices = harness === "codex" ? CODEX_PRICES : { date: "x", perMillion: {} };
  for (const [from, rows] of [["artifact", [{ ...stored, artifact: "pendulum-usage-1" }]], ["spend line", spendRecords({ issue: { number: 7, labels: [] }, issueTimeline: [], issueComments: [{ user: { login: "pendulum-app[bot]", type: "Bot" }, created_at: "2031-03-02T03:00:00Z", body: `<!-- pendulum:7:progress:work:1 -->\nPendulum work run 1.\n<!-- pendulum:harness {"harness":"${harness}"} -->\n${spendMarker(line.usd, line.parts)}` }] }, { app: "pendulum-app[bot]" })]]) {
    const cost = costOf(rows, prices, { harness });
    assert.equal(cost.usdUnknown, 1, `${why}: the scorer from the ${from}: ${JSON.stringify(cost)}`);
    assert.equal(cost.usd ?? 0, knownUsd, `${why}: the scorer's known dollars from the ${from}`);
    assert.match(cost.basis, /plus 1 run of unknown cost/, `${why}: the scorer's basis from the ${from}`);
    assert.doesNotMatch(cost.basis, /lower bound|upper bound|estimate|at least|at most/, `${why}: no bound from the ${from}`);
  }
}

test("a Claude pass killed before its result line (the wall clock) is a run of unknown cost end to end", async () => {
  const rec = await pass("claude", "claude-opus-5-5", "claude-killed", { timeoutMs: 1500 });
  assert.equal(rec.timedOut, true);
  await endToEnd(rec, "unreported", { harness: "claude", model: "claude-opus-5-5" });
});

test("a crashed Claude result with a zeroed total_cost_usd after its stream reported tokens is a run of unknown cost end to end", async () => {
  const rec = await pass("claude", "claude-opus-5-5", "claude-zeroed");
  await endToEnd(rec, "zeroed", { harness: "claude", model: "claude-opus-5-5" });
});

test("a resumed Claude session on Claude Code before 2.1.277 is a run of unknown cost end to end; from 2.1.277 its own share counts", async () => {
  assert.deepEqual(["2.1.276", "2.1.277-rc.1", "2.0.999", "", "x"].map(claudeRunningTotals), [false, false, false, false, false]);
  assert.deepEqual(["2.1.277", "2.1.300", "3.0.0"].map(claudeRunningTotals), [true, true, true]);
  // The session's total as Pendulum last read it: $0.50. The resumed pass reports $0.80.
  seedSessionTotal("s1", { usd: 0.5, tokens: { input: 1, output: 1, cached: 0, written: 0 } });
  const old = await pass("claude", "claude-opus-5-5", "claude-resumed", { resume: "s1", version: "2.1.276" });
  assert.equal(old.harnessVersion, "2.1.276");
  assert.deepEqual(old.tokens, { input: null, output: null, cached: null, written: null }, "its tokens are unknown too");
  await endToEnd(old, "resumed-total", { harness: "claude", model: "claude-opus-5-5" });
  // The old pass's total is no running total: the session's last good one stays, and a later pass counts from it.
  const later = await pass("claude", "claude-opus-5-5", "claude-resumed", { resume: "s1", version: "2.1.277" });
  assert.ok(Math.abs(later.usd - 0.3) < 1e-9 && !later.usdUnknown, JSON.stringify({ usd: later.usd, unknown: later.usdUnknown }));
});

test("the running status line shows no dollars where the record has unknown: a zeroed result, a resumed total before 2.1.277", () => {
  const feed = (lines, prior = null) => {
    const a = harnessActivity();
    if (prior) a.since("s1", prior);
    for (const l of lines) a.feed(JSON.stringify(l));
    return a.snapshot().usd;
  };
  const init = (v) => ({ type: "system", subtype: "init", session_id: "s1", claude_code_version: v });
  const said = { type: "assistant", message: { id: "m", usage: { input_tokens: 10, output_tokens: 5 }, content: [] } };
  const result = (usd, error = false) => ({ type: "result", subtype: error ? "error_during_execution" : "success", is_error: error, session_id: "s1", total_cost_usd: usd });
  assert.equal(feed([init("2.1.325"), said, result(0, true)]), null, "a zeroed crash result");
  assert.equal(feed([init("2.1.325"), result(0, true)]), 0, "an error before any token is a real $0");
  assert.equal(feed([init("2.1.276"), said, result(0.8)], { usd: 0.5 }), null, "a resumed total before 2.1.277");
  assert.ok(Math.abs(feed([init("2.1.277"), said, result(0.8)], { usd: 0.5 }) - 0.3) < 1e-9, "from 2.1.277, the pass's own share");
});

test("a Codex pass killed before any turn.completed is a run of unknown cost end to end", async () => {
  const rec = await pass("codex", "gpt-6.1-sol", "codex-killed", { timeoutMs: 1500 });
  assert.equal(rec.timedOut, true);
  await endToEnd(rec, "unreported", { harness: "codex", model: "gpt-6.1-sol" });
});

test("a Codex pass on a model with no price row is a run of unknown cost end to end", async () => {
  const rec = await pass("codex", "gpt-unlisted-9", "codex-turn");
  assert.equal(rec.ok, true);
  assert.equal(rec.tokens.input, 200000, "its tokens stay as reported");
  await endToEnd(rec, "no-price", { harness: "codex", model: "gpt-unlisted-9" });
});

test("no estimate, bound or fallback price is read or described anywhere in the plugin, the bench, the docs or the Action", () => {
  const banned = /usdUpperBound|usdLowerBound|vendorUpperBound|usdEstimated|upperBound|lowerBound|stoppedUsd|live-spend|liveSpend|claude-prices/;
  const skip = new Set([join(ROOT, "plugin", "test"), join(ROOT, "bench", "test"), join(ROOT, "plugin", "vendor")]);
  const hits = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (skip.has(p) || name === "node_modules") continue;
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(mjs|js|json|md|yml|yaml|sh)$/.test(name)) {
        readFileSync(p, "utf8").split("\n").forEach((l, i) => {
          if (banned.test(l)) hits.push(`${relative(ROOT, p)}:${i + 1}`);
        });
      }
    }
  };
  for (const d of ["plugin", "bench", "docs"]) walk(join(ROOT, d));
  for (const f of ["README.md", "action.yml"]) readFileSync(join(ROOT, f), "utf8").split("\n").forEach((l, i) => banned.test(l) && hits.push(`${f}:${i + 1}`));
  // The docs and the Action name no estimate setting or bound in prose either.
  const prose = /relay_unknown_floor_usd|relay_slow_floor_usd|relay_unknown_shut|\bat an estimate\b|counted at max_usd|the session's ceiling, an upper bound|marked a lower bound|its live reading/i;
  for (const f of ["README.md", "action.yml", ...readdirSync(join(ROOT, "docs")).filter((n) => n.endsWith(".md")).map((n) => join("docs", n))]) {
    readFileSync(join(ROOT, f), "utf8").split("\n").forEach((l, i) => prose.test(l) && hits.push(`${f}:${i + 1} (prose)`));
  }
  assert.deepEqual(hits, [], "an estimate or bound is read here");
  // The one price table has a row per model it prices and nothing else: no upper-bound, dearest or fallback row.
  for (const id of Object.keys(CODEX_PRICES.perMillion)) assert.doesNotMatch(id, /upper|bound|dearest|fallback|default|unknown/i, id);
  assert.deepEqual(Object.keys(CODEX_PRICES).filter((k) => /upper|bound|fallback|dearest/i.test(k)), []);
  assert.deepEqual(readdirSync(join(ROOT, "plugin", "scripts", "lib")).filter((f) => /prices\.json$/.test(f)), ["codex-prices.json"], "no other price table");
});

test("a Copilot run that reports no AI credits is a run of unknown cost, and the stage goes on to its next pass", async () => {
  const { validationLoop } = await import("../scripts/lib/session.mjs");
  const { execFileSync } = await import("node:child_process");
  const root = mkdtempSync(join(tmpdir(), "unknown-copilot-"));
  const work = join(root, "work");
  mkdirSync(work);
  const git = (...a) => execFileSync("git", ["-C", work, "-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { encoding: "utf8" });
  git("init", "-q", "-b", "main");
  writeFileSync(join(work, "README"), "x\n");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  // A fake Copilot: each pass fixes the next file and commits it, and reports its tokens with its AI credits pending:
  // its cost is unknown.
  mkdirSync(join(root, "bin"));
  const calls = join(root, "calls");
  writeFileSync(join(root, "bin", "copilot"), `#!${process.execPath}
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
fs.appendFileSync(${JSON.stringify(calls)}, "x");
const n = fs.readFileSync(${JSON.stringify(calls)}, "utf8").length;
fs.writeFileSync(["a", "b"][n - 1] || "c", "ok\\n");
execFileSync("git", ["add", "-A"]);
execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "fix " + n]);
const at = process.argv.findIndex((a) => a.startsWith("--usage-output-file"));
const file = at < 0 ? null : process.argv[at].includes("=") ? process.argv[at].split("=")[1] : process.argv[at + 1];
if (file) fs.writeFileSync(file, JSON.stringify({ totalPremiumRequestCost: 1, aiCreditsStatus: "pending", modelMetrics: { "claude-sonnet-5": { usage: { inputTokens: 900, outputTokens: 40 } } } }));
console.log(JSON.stringify({ type: "assistant.turn_end", data: {} }));
console.log(JSON.stringify({ type: "result", sessionId: "s" + n, exitCode: 0, usage: { premiumRequests: 1 } }));
`, { mode: 0o755 });
  const env = { HOME: process.env.HOME, PATH: `${join(root, "bin")}:${process.env.PATH}`, TMPDIR: process.env.TMPDIR };
  const path = process.env.PATH;
  process.env.PATH = env.PATH;
  try {
    const needs = (f) => `test -f ${f} || { echo "not ok 1 - ${f} is missing"; exit 1; }`;
    const result = await validationLoop({ checkout: work, commands: [needs("a"), needs("b")], harness: "copilot", model: "claude-sonnet-5", maxUsd: 25, session: { id: null, canResume: false }, taskCard: "card", env, deadlineAt: Date.now() + 120_000, eventsFile: join(root, "events.jsonl") });
    assert.equal(readFileSync(calls, "utf8").length, 2, "a second fix pass ran after the first reported no credits");
    assert.equal(result.green, true, JSON.stringify({ ...result, usage: undefined }));
    assert.equal(result.harness?.budgetExceeded, undefined, "never stopped at the cap for unknown spend");
    for (const rec of result.usage) assert.deepEqual([rec.usd, rec.usdUnknown, rec.usdUnknownWhy, !!rec.budgetExceeded], [null, 1, ["credits"], false]);
    assert.deepEqual(sumSpend(result.usage), { usd: 0, unknown: 2 });
  } finally {
    process.env.PATH = path;
  }
});

test("an Actions stage killed before it wrote result.json counts toward daily_usd as a run of unknown cost, never dropped", async () => {
  const { todaysUsage } = await import("../scripts/lib/github.mjs");
  const today = new Date().toISOString();
  const artifact = (id, name) => ({ id, name, expired: false, created_at: today, workflow_run: { id: 1000 + id } });
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ total_count: 2, artifacts: [artifact(1, "pendulum-usage-7"), artifact(2, "pendulum-usage-8")] }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const saved = process.env.GITHUB_API_URL;
  process.env.GITHUB_API_URL = `http://127.0.0.1:${server.address().port}`;
  try {
    // #7 wrote its result.json; #8's stage was killed first, so its artifact (the upload runs always) has none.
    const download = async (_repo, a) => (a.name === "pendulum-usage-7" ? { harness: "claude", usd: 2, runs: 1 } : null);
    const records = await todaysUsage({ owner: "o", name: "r", full: "o/r" }, { token: "t", download });
    assert.deepEqual(records.map((r) => [r.artifact, r.usd, r.usdUnknown ?? 0]), [["pendulum-usage-7", 2, 0], ["pendulum-usage-8", null, 1]]);
    assert.deepEqual(sumSpend(records), { usd: 2, unknown: 1 });
  } finally {
    if (saved === undefined) delete process.env.GITHUB_API_URL;
    else process.env.GITHUB_API_URL = saved;
    server.close();
  }
});

test("#483 review: the smaller cases of unknown spend each read as unknown, and the day's unread spend is no $0", async () => {
  const { parseUsage, sinceSession } = await import("../scripts/lib/usage.mjs");
  const { joinLost } = await import("../scripts/lib/harness.mjs");
  const { costByPhase, spendText } = await import("../scripts/lib/logic.mjs");
  const { killedUsage } = await import("../scripts/stage.mjs");
  // S1: a Copilot run killed after a usage checkpoint keeps the credits it reported, and the rest is unknown.
  const checkpoint = JSON.stringify({ type: "session.usage_checkpoint", data: { totalNanoAiu: 5e9, totalPremiumRequests: 1 } });
  const killed = parseUsage("copilot", `${checkpoint}\n${JSON.stringify({ type: "assistant.turn_end" })}`, null, 137);
  assert.deepEqual([killed.usd, killed.usdUnknown, killed.usdUnknownWhy], [0.05, 1, ["unreported"]]);
  const ended = parseUsage("copilot", `${checkpoint}\n${JSON.stringify({ type: "result", sessionId: "s", exitCode: 0 })}`, null, 0);
  assert.deepEqual([ended.usd, ended.usdUnknown], [0.05, undefined], "one that printed its result line reported all");
  // S4: the version is the init line's, not the first system line's.
  const init = (v) => JSON.stringify({ type: "system", subtype: "init", session_id: "s1", claude_code_version: v });
  const other = JSON.stringify({ type: "system", subtype: "hook_started", session_id: "s1" });
  const result = JSON.stringify({ type: "result", subtype: "success", session_id: "s1", total_cost_usd: 0.8 });
  assert.equal(parseUsage("claude", [other, init("2.1.300"), result].join("\n"), null).harnessVersion, "2.1.300");
  // A resumed total below the one already counted is no running total: unknown, for every harness.
  for (const harness of ["claude", "codex"]) {
    const below = sinceSession({ harness, harnessVersion: "2.1.300", usd: 0.4, tokens: { input: 1, output: 1, cached: 0, written: 0 } }, { usd: 1, tokens: {} });
    assert.deepEqual([below.usd, below.usdUnknown, below.usdUnknownWhy], [null, 1, ["resumed-total"]], harness);
  }
  // S7: a pass run again keeps every run's relayed calls of unknown cost.
  const lost = { usd: 1, tokens: {}, workerKeyUsd: 0.1, workerKeyUnknown: 2, usdUnknown: 1, usdUnknownWhy: ["relay"], started: "a", basis: "b" };
  assert.equal(joinLost([lost], { usd: 2, tokens: {}, workerKeyUsd: 0.2, workerKeyUnknown: 1, usdUnknown: 1, usdUnknownWhy: ["relay"], basis: "c" }).workerKeyUnknown, 3);
  // S3: a stage its launcher ended books what its progress comment's last line showed, and the pass it was in.
  assert.deepEqual(Object.values((({ usd, usdUnknown, usdUnknownWhy }) => ({ usd, usdUnknown, usdUnknownWhy }))(killedUsage({ harness: "claude", soFar: { usd: 18, unknown: 1 } }))), [18, 1, ["unreported"]]);
  assert.deepEqual([killedUsage({ harness: "claude", soFar: { usd: 18, unknown: 0 } }).usdUnknown, killedUsage({ harness: "claude" }).usd], [1, null]);
  // S2: a total that could not be read is unknown, and the gate says so.
  assert.deepEqual([spendText({ usd: Number.POSITIVE_INFINITY }), spendText({ usd: null }), spendText({ usd: 0, unknown: 2 })], ["unknown", "unknown", "unknown, 2 runs"]);
  const gate = selectReady({ issues: [{ number: 9, labels: [] }], maxConcurrent: 3, dailyUsd: 100, spentToday: Number.POSITIVE_INFINITY });
  assert.equal(gate.skipped[0].reason, "daily_usd reached (today's spend could not be read)");
  // The exit line's passes: each one's known dollars or unknown.
  assert.equal(costByPhase([{ label: "work-1", usd: 7.9 }, { label: "fix-1", usd: null, usdUnknown: 1 }, { label: "fix-2", usd: 0.3, usdUnknown: 1 }]), " (work-1 7.90, fix-1 unknown, fix-2 0.30 plus unknown)");
});

test("#483 review: a stage killed after its progress comment's last write leaves that line's spend beside its session totals", async () => {
  const { spawnSync } = await import("node:child_process");
  const { pathToFileURL } = await import("node:url");
  const { lastSpendLine } = await import("../scripts/stage.mjs");
  const dir = mkdtempSync(join(tmpdir(), "unknown-line-"));
  // A stage of its own (a process): one finished Codex pass, priced from the table, in usage directory `dir`; then the
  // commit a landed progress write makes.
  const lib = (f) => JSON.stringify(pathToFileURL(join(import.meta.dirname, "..", "scripts", "lib", f)).href);
  const script = `
    import { runHarness, stageSpendNow } from ${lib("harness.mjs")};
    await runHarness({ harness: "codex", model: "gpt-6.1-sol", prompt: "p", maxUsd: 0, cwd: ${JSON.stringify(BIN)}, env: { HOME: process.env.HOME, PATH: process.env.PATH, CODEX_HOME: ${JSON.stringify(join(BIN, "codex-home"))}, FAKE_MODE: "codex-turn" }, timeoutMs: 60_000, eventsFile: ${JSON.stringify(join(dir, "events.jsonl"))}, label: "work-1" });
    const now = stageSpendNow();
    now.commit();
    process.stdout.write(JSON.stringify({ usd: now.usd, unknown: now.unknown }));
  `;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", env: { HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, PATH: `${BIN}:${process.env.PATH}` } });
  assert.equal(r.status, 0, r.stderr);
  const now = JSON.parse(r.stdout);
  assert.ok(now.usd > 0, r.stdout);
  assert.deepEqual(lastSpendLine(dir), now, "what the launcher books for the stage is what the line showed");
});
