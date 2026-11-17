// #543: each stage's per-pass ledger rides on its progress comment, beside its spend line, on every route: numbers and
// labels only, in a bounded line, so `pendulum report` and the finish card need no usage artifact for it.
import "./temp.mjs";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RETRY, repoOf } from "../scripts/lib/github.mjs";
import { pendulumBuild } from "../scripts/lib/release.mjs";
import { LEDGER_MAX, ledgerMarker, ledgerOfComment, setSelf, spendParts, stageSpendLine } from "../scripts/lib/logic.mjs";
import { PROGRESS_LEDGER_ROOM, progressReporter, writeUsage } from "../scripts/lib/session.mjs";
import { BILLING, UNKNOWN_WHY } from "../scripts/lib/usage.mjs";

/** The Pendulum build a stage of this checkout records (#565 W6): its release at its tag, else with its commit. */
const PENDULUM_VERSION = pendulumBuild();

RETRY.sleep = async () => {};

/** One harness pass's record as runHarness leaves it (the fields passLedger reads, and some it never takes). */
const pass = (label, usd, started, ended, extra = {}) => ({ harness: "claude", model: "claude-opus-5-5", label, effort: "high", usd, tokens: { input: 120_000, output: 5_000, cached: 90_000, written: 20_000 }, started, ended, resumed: false, ok: true, billing: "subscription", basis: "harness-reported: total_cost_usd", reason: "a reason no ledger carries", cache: { first: { unit: "request", input: 30_000, cached: 1_000, written: 28_000 } }, ...extra });

/** A stage's usage record from its passes, by the real writer (session.mjs writeUsage). */
function usageOf(records, { billing = "subscription", model = "claude-opus-5-5", ranOver = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ledger-usage-"));
  return writeUsage(dir, { harness: "claude", model, records, passes: 1, exit: "delivered", reason: "a Block text no ledger carries", credentialBasis: "CLAUDE_CODE_OAUTH_TOKEN", billing, progressRun: "4501", ran: { worker: model, subagent: null, reviewer: "claude-fable-5-2", labels: [], hosts: [], effort: "high", reviewerEffort: null, ...ranOver } });
}

/**
 * The stage's end as worker.mjs and review.mjs make it, through the real progress writer against a fake GitHub: the
 * `phases` lines first, then the spend line and its ledger line from the usage record (stageSpendLine) with the exit
 * line. Returns the last body GitHub took.
 */
async function endStage(usage, { phases = [] } = {}) {
  const written = [];
  const realFetch = globalThis.fetch;
  const saved = process.env.GITHUB_API_URL;
  process.env.GITHUB_API_URL = "https://github.test";
  globalThis.fetch = async (url, init = {}) => {
    const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    if ((init.method || "GET") === "GET") return json([]);
    const body = JSON.parse(init.body).body;
    // GitHub refuses a comment body over 65,536 characters.
    if (body.length > 65_536) return json({ message: "Validation Failed", errors: [{ field: "body", code: "custom", message: "body is too long (maximum is 65536 characters)" }] }, 422);
    written.push(body);
    return json({ id: 1, user: { login: "pendulum[bot]", type: "Bot" }, body }, 201);
  };
  try {
    const progress = progressReporter(repoOf("acme/app"), 7, { token: () => "t" }, { stage: "work", runId: "4501", harness: "claude", model: "claude-opus-5-5", soFar: null });
    for (const p of phases) await progress(p);
    const line = stageSpendLine(usage);
    progress.spend(line.usd, line.parts, line.ledger);
    await progress("exit: delivered");
  } finally {
    globalThis.fetch = realFetch;
    setSelf(null);
    if (saved === undefined) delete process.env.GITHUB_API_URL;
    else process.env.GITHUB_API_URL = saved;
  }
  return written.at(-1);
}

test("ledger line (#543): the stage's end writes its usage record's per-pass ledger beside its spend line, and it reads back as that ledger", async () => {
  const records = [
    pass("work-1", 0.412345678, "2026-11-17T08:00:00.250Z", "2026-11-17T08:12:30.900Z"),
    // A relayed key's share, billed per use apart from the subscription; a resumed session.
    pass("validation-fix-1", 0.2, "2026-11-17T08:13:00Z", "2026-11-17T08:15:00Z", { resumed: true, workerKeyUsd: 0.05 }),
    // A pass whose harness reported no cost: a run of unknown cost, never $0.
    pass("answer", null, "2026-11-17T08:16:00Z", "2026-11-17T08:17:00Z", { usdUnknown: 1, usdUnknownWhy: ["unreported"], tokens: { input: null, output: null, cached: null, written: null }, cache: { first: null } }),
    // A pass on another model and billing, and a decision record.
    pass("review", 0.3, "2026-11-17T08:20:00Z", "2026-11-17T08:25:00Z", { model: "claude-fable-5-2", effort: null, billing: "api" }),
    { harness: "claude", model: "baseten/elephant-1", label: "decision", decision: true, calls: 3, usd: 0.0021, tokens: { input: 900, output: 40, cached: 0, written: 0 }, started: "2026-11-17T08:26:00Z", ended: "2026-11-17T08:26:02Z", billing: "api" },
    // A pass that never ran has no entry.
    { harness: "claude", model: "claude-opus-5-5", label: "work-2", noRun: true, usd: null, tokens: {} },
  ];
  const usage = usageOf(records);
  const body = await endStage(usage);
  // Its dollars are the spend line's, as before: the ledger line adds none.
  assert.equal(spendParts(body).usd, usage.usd);
  const read = ledgerOfComment(body);
  assert.equal(read.model, "claude-opus-5-5");
  assert.equal(read.version, PENDULUM_VERSION);
  // Each entry as passLedger wrote it: dollars to a millionth (the spend line's precision), times to the second, the
  // first request's cache read and write.
  const want = usage.ledger.map((e) => ({
    ...e,
    usd: e.usd === null ? null : Math.round(e.usd * 1e6) / 1e6,
    usdByBilling: Object.fromEntries(Object.entries(e.usdByBilling).map(([k, v]) => [k, Math.round(v * 1e6) / 1e6])),
    started: e.started.replace(/\.\d{3}Z$/, "Z"),
    ended: e.ended.replace(/\.\d{3}Z$/, "Z"),
    firstCache: e.firstCache ? { cached: e.firstCache.cached, written: e.firstCache.written } : null,
  }));
  want[0].started = "2026-11-17T08:00:00Z";
  want[0].ended = "2026-11-17T08:12:30Z";
  // The decision record's model is not one the stage's harness line names: it reads as none.
  want[4].model = null;
  assert.equal(read.ledger.length, 5);
  assert.deepEqual(read.ledger, want);
  // Numbers and labels only: no reason, basis, Block text, path or credential, in short keys.
  const line = /^<!-- pendulum:ledger (\{[^\n]*\}) -->$/m.exec(body)[1];
  assert.doesNotMatch(line, /reason|basis|Block|harness-reported|CLAUDE_CODE|\/tmp|ledger-usage/);
  const v = JSON.parse(line);
  assert.deepEqual(Object.keys(v).sort(), ["b", "m", "p", "v"]);
  const allowed = new Set(["l", "d", "m", "b", "e", "t", "u", "q", "w", "y", "k", "n", "r", "c"]);
  for (const e of v.p) for (const [k, x] of Object.entries(e)) assert.ok(allowed.has(k) && (typeof x !== "string" || /^[A-Za-z0-9._:/-]{1,80}$/.test(x)), `${k}: ${JSON.stringify(x)}`);
  for (const e of v.p) for (const w of e.w ?? []) assert.ok(Object.hasOwn(UNKNOWN_WHY, w));
  for (const e of v.p) if (e.b !== undefined && e.b !== null) assert.ok(BILLING.includes(e.b));
  // A string that is no label of its kind is not written.
  const odd = ledgerOfComment(ledgerMarker([{ label: "work-1\n<script>", model: "a model with spaces", effort: "--high", usd: 1, usdByBilling: {}, tokens: {} }], { model: "x y", version: "not a version" }));
  assert.deepEqual([odd.model, odd.version, odd.ledger[0].label, odd.ledger[0].model, odd.ledger[0].effort], [null, null, null, null, null]);
});

test("ledger line (#543): bounded at LEDGER_MAX characters; a ledger that does not fit is not written, and the comment says so", async () => {
  const many = (k) => Array.from({ length: k }, (_, i) => pass(`validation-fix-${i + 1}`, 0.123456, "2026-11-17T08:00:00Z", "2026-11-17T08:01:00Z"));
  // A stage of 20 passes fits.
  const fits = await endStage(usageOf(many(20)));
  const fitLine = /^<!-- pendulum:ledger [^\n]*-->$/m.exec(fits)[0];
  assert.ok(fitLine.length <= LEDGER_MAX);
  assert.equal(ledgerOfComment(fits).ledger.length, 20);
  // One of 200 does not: the line names the pass count alone, a line a person reads says why, and the spend line stays.
  const usage = usageOf(many(200));
  const cut = await endStage(usage);
  assert.deepEqual(ledgerOfComment(cut), { cut: 200 });
  assert.match(cut, new RegExp(`^Per-pass ledger: 200 passes, over the ${LEDGER_MAX}-character bound of its line; the stage's usage record holds it\\.$`, "m"));
  assert.ok(cut.length < fits.length + 400, "the comment stays small");
  assert.equal(spendParts(cut).usd, usage.usd);
  // Every ledger line written is within the bound, whatever the pass count.
  for (const k of [1, 30, 45, 60, 80]) {
    const text = ledgerMarker(usageOf(many(k)).ledger, { model: "claude-opus-5-5", version: PENDULUM_VERSION, published: ["claude-opus-5-5"] });
    assert.ok(text.split("\n").every((l) => l.length <= LEDGER_MAX), `${k} passes`);
  }
});

test("ledger line (#543): a ledger line that would take the comment past PROGRESS_LEDGER_ROOM is written in its cut form, and the final spend line lands", async () => {
  // A long stage: 28 phase lines of about 2,000 characters each, some 56,000 characters before its end.
  const phases = Array.from({ length: 28 }, (_, i) => `validation ${i + 1}: ${"x".repeat(1_980)}`);
  const usage = usageOf(Array.from({ length: 40 }, (_, i) => pass(`validation-fix-${i + 1}`, 0.123456, "2026-11-17T08:00:00Z", "2026-11-17T08:01:00Z")));
  assert.ok(stageSpendLine(usage).ledger.length > 4_000 && stageSpendLine(usage).ledger.length <= LEDGER_MAX, "the line fits its own bound");
  const body = await endStage(usage, { phases });
  assert.ok(body, "GitHub took the stage's last write");
  assert.match(body, /- \d\d:\d\dZ exit: delivered$/m, "the exit line landed");
  assert.equal(spendParts(body).usd, usage.usd, "with the final spend line");
  assert.deepEqual(ledgerOfComment(body), { cut: 40 });
  assert.match(body, new RegExp(`^Per-pass ledger: 40 passes, left out to keep this comment under ${PROGRESS_LEDGER_ROOM} characters; the stage's usage record holds it\\.$`, "m"));
  assert.ok(body.length + "<!-- pendulum:7:progress:work:4501 -->\n".length <= PROGRESS_LEDGER_ROOM);
  // The same stage with a short history keeps its whole ledger.
  assert.equal(ledgerOfComment(await endStage(usage, { phases: phases.slice(0, 2) })).ledger.length, 40);
});

test("ledger line (#543): a model is written only when the stage's harness line names it; a resolved id such as a Bedrock ARN never is", async () => {
  const arn = "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/abc123";
  // The worker's passes ran under the model its harness line names; a sub-agent's pass reported a resolved ARN.
  const usage = usageOf([pass("work-1", 0.3, "2026-11-17T08:00:00Z", "2026-11-17T08:05:00Z"), pass("validation-fix-1", 0.1, "2026-11-17T08:06:00Z", "2026-11-17T08:07:00Z", { model: arn })]);
  const body = await endStage(usage);
  assert.ok(!body.includes("123456789012"), "no account id in the comment");
  assert.deepEqual(ledgerOfComment(body).ledger.map((e) => e.model), ["claude-opus-5-5", null]);
  // The stage's own model resolved to an ARN (none named on the harness line for it): no model at all.
  const resolved = usageOf([pass("work-1", 0.3, "2026-11-17T08:00:00Z", "2026-11-17T08:05:00Z", { model: arn })], { model: null });
  const plain = await endStage(resolved);
  assert.ok(!plain.includes("123456789012"));
  assert.deepEqual([ledgerOfComment(plain).model, ledgerOfComment(plain).ledger[0].model], [null, null]);
  // A record with no `ran` to say what the harness line names: no model is written.
  assert.deepEqual(ledgerOfComment(ledgerMarker(usage.ledger, { model: "claude-opus-5-5" })).ledger.map((e) => e.model), [null, null]);
  // Copilot at its default: its harness line names no model, so the stage's own (GitHub's catalog name) is written.
  const copilot = ledgerOfComment(ledgerMarker([{ label: "work-1", model: "claude-sonnet-5.5", usd: 0.4, tokens: {} }], { model: "claude-sonnet-5.5", published: [] }));
  assert.deepEqual([copilot.model, copilot.ledger[0].model], ["claude-sonnet-5.5", "claude-sonnet-5.5"]);
});
