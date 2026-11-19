// The four numbers on invented Objectives (fixtures/github.mjs) and the
// usage fixtures per harness (fixtures/usage/). No token, no network.
import "../../plugin/test/temp.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { collectObjective, humanWorkflowRuns, snapshotApi, usageDirFor, usageFromDir } from "../lib/collect.mjs";
import { costOf, loadPrices, parseUsageText, priceTokens } from "../lib/cost.mjs";
import { RENAMED_WHY, humanActions, localPendulumActions, markdownTable, scoreObjective, summaryLine } from "../lib/objective.mjs";
import { blocked, cleanMerge, humanPush, localMerge, OPERATOR, REPO, snapshotOf, withHandover } from "./fixtures/github.mjs";
import { CODEX_NO_TOKENS } from "../../plugin/scripts/lib/usage.mjs";
import { PREVIOUS_NAME } from "../../plugin/scripts/lib/local.mjs";
import { refusedMarker } from "../../plugin/scripts/lib/stop.mjs";
import { newForms } from "../../plugin/test/fixtures/progress-new-form.mjs";

const BENCH = join(import.meta.dirname, "..");
const USAGE = join(import.meta.dirname, "fixtures", "usage");
const prices = loadPrices();
const read = (f) => readFileSync(f, "utf8");
const usage = (dir) => usageFromDir(join(USAGE, dir), { readdir: readdirSync, read });
const NOW = "2031-03-05T00:00:00Z";

test("clean merge: walk-away yes, operator 0, Claude dollars from total_cost_usd, wall and runner minutes", () => {
  const row = scoreObjective(cleanMerge(42, usage("claude")), { prices, now: NOW });
  assert.equal(row.exit, "merged");
  assert.equal(row.walkAway.value, true);
  assert.equal(row.walkAway.firstHumanAction, null);
  assert.deepEqual(row.operator, { minutes: 0, basis: "clean merge" });
  assert.equal(row.cost.unit, "usd");
  assert.equal(row.cost.usd, 7.4312);
  assert.match(row.cost.basis, /total_cost_usd, modelUsage \(sub-agents included\)/);
  assert.equal(row.wallMinutes, 150); // 01:00 label to 03:30 merged
  assert.equal(row.runnerMinutes, 112); // 69 + 43
  assert.equal(row.quality.status, "pending");
  assert.deepEqual(row.missing, []);
  assert.equal(row.mergedBy, "acme-pendulum[bot]");
});

test("Draft removal starts the walk-away clock and workflow lookback; preparation and activation are not interventions", async () => {
  const c = cleanMerge(42, usage("claude"));
  const [filed, ...working] = c.issueTimeline;
  const draft = { ...filed, label: { name: "pendulum:draft" } };
  const startAt = "2031-03-02T01:02:00Z";
  const start = { ...draft, created_at: startAt, event: "unlabeled" };
  const preparation = { user: OPERATOR, created_at: "2031-03-02T01:01:00Z", body: "Prep the acceptance wording." };
  c.issueTimeline = [filed, draft, start, ...working];
  c.issueComments.unshift(preparation);
  let query;
  await humanWorkflowRuns(async (path) => {
    query = decodeURIComponent(path);
    return [];
  }, REPO, c.issue, c.issueTimeline, c.pulls);
  assert.match(query, /created=2031-03-02T01:02:00Z\.\./);
  const row = scoreObjective(c, { prices });
  assert.deepEqual([row.walkAway.since, row.walkAway.sinceBasis, row.walkAway.humanActions, row.walkAway.value, row.wallMinutes], [startAt, 'first removal of "pendulum:draft"', 0, true, 148]);

  const held = { ...c, issue: { ...c.issue, state: "open", closed_at: null, labels: [filed.label, draft.label] }, issueTimeline: [draft, filed], pulls: [] };
  const waiting = scoreObjective(held, { prices });
  assert.deepEqual([waiting.walkAway.since, waiting.wallMinutes, waiting.parked], [null, null, false]);

  const resumeAt = "2031-03-02T02:00:00Z";
  c.issueTimeline.push({ ...draft, created_at: "2031-03-02T01:45:00Z" }, { ...start, created_at: resumeAt });
  const resumed = scoreObjective(c, { prices });
  assert.deepEqual([resumed.walkAway.since, resumed.walkAway.humanActions, resumed.walkAway.value], [startAt, 2, false]);
});

test("issue-timeline order counts human actions after the exact activation in the same second", () => {
  const c = cleanMerge(42, usage("claude"));
  const [filed, ...working] = c.issueTimeline;
  c.issue.created_at = filed.created_at;
  const draft = { ...filed, label: { name: "pendulum:draft" } };
  const at = "2031-03-02T01:00:20Z";
  const held = { ...draft, created_at: at };
  const start = { ...held, event: "unlabeled" };
  const comment = (body) => ({ actor: OPERATOR, created_at: at, event: "commented", body });
  const ownerLabel = { ...filed, actor: c.issue.user, label: { name: "priority" }, created_at: "2031-03-02T01:00:40Z" };
  c.issueTimeline = [filed, draft, comment("Preparatory note"), start, comment("Change after start"), { ...held }, { ...start }, ownerLabel, ...working];
  const actions = humanActions(c, at);
  assert.deepEqual(actions.map(({ kind, detail }) => [kind, detail]), [
    ["comment", "Change after start"],
    ["labeled pendulum:draft", ""],
    ["unlabeled pendulum:draft", ""],
    ["labeled priority", ""],
  ]);
  assert.equal(scoreObjective(c, { prices }).walkAway.humanActions, 4);
});

test("legacy direct starts keep bundled filing metadata out of walk-away and count a later Draft hold", () => {
  const c = cleanMerge(42, usage("claude"));
  const [filed, ...working] = c.issueTimeline;
  c.issue.created_at = filed.created_at;
  const ownerLabel = (name, created_at = filed.created_at) => ({ ...filed, label: { name }, actor: c.issue.user, created_at });
  c.issueTimeline = [filed, ownerLabel("priority"), ownerLabel("pendulum:local"), ...working];
  assert.equal(scoreObjective(c, { prices }).walkAway.value, true);

  c.issueTimeline.splice(3, 0, ownerLabel("pendulum:draft", "2031-03-02T01:00:40Z"));
  const row = scoreObjective(c, { prices });
  assert.deepEqual([row.walkAway.value, row.walkAway.humanActions, row.walkAway.firstHumanAction.kind], [false, 1, "labeled pendulum:draft"]);
});

test("only a Pendulum-owned refusal excludes the exact Draft removal from clock and workflow lookback", async () => {
  const c = cleanMerge(42, usage("claude"));
  const [filed, ...working] = c.issueTimeline;
  const draft = { ...filed, label: { name: "pendulum:draft" } };
  const at = "2031-03-02T01:02:00Z";
  const rejected = { ...draft, id: 901, created_at: at, event: "unlabeled" };
  const chosen = { ...rejected, id: 902 };
  const bot = working.find((e) => e.label?.name === "pendulum:running").actor;
  const refusal = (id, user) => ({ user, created_at: at, body: refusedMarker(c.issue.number, { id, at }) });
  c.issueTimeline = [filed, draft, rejected, { ...draft, created_at: at }, chosen, ...working];
  c.issueComments.unshift(refusal(901, bot), refusal(902, OPERATOR));
  const row = scoreObjective(c, { prices });
  assert.deepEqual([row.walkAway.since, row.walkAway.humanActions, row.walkAway.value], [at, 0, true]);
  c.issueTimeline.splice(4, 1, { ...chosen, created_at: "2031-03-02T01:03:00Z" });
  let query;
  await humanWorkflowRuns(async (path) => {
    query = decodeURIComponent(path);
    return [];
  }, REPO, c.issue, c.issueTimeline, c.pulls, { comments: c.issueComments });
  assert.match(query, /created=2031-03-02T01:03:00Z\.\./);
});

test("missing Draft removal leaves the merged wall clock and walk-away unknown", () => {
  const c = cleanMerge(42, usage("claude"));
  const [filed, ...working] = c.issueTimeline;
  c.issueTimeline = [filed, { ...filed, label: { name: "pendulum:draft" } }, ...working];
  const row = scoreObjective(c, { prices });
  assert.deepEqual([row.walkAway.since, row.walkAway.value, row.walkAway.askedOnly.value, row.walkAway.bucket, row.wallMinutes], [null, null, null, "unknown", null]);
  assert.ok(row.missing.includes("Draft activation event"));
  assert.equal(row.operator.minutes, "unknown");
  assert.match(summaryLine([row]), /Not known \(Draft activation was not recorded\), in no count: #42\./);
});

test("human push: a maintainer's commit on the branch after the label breaks walk-away and names itself", () => {
  const row = scoreObjective(humanPush(43, usage("claude")), { prices, now: NOW });
  assert.equal(row.exit, "merged");
  assert.equal(row.walkAway.value, false);
  assert.equal(row.walkAway.firstHumanAction.kind, "push");
  assert.equal(row.walkAway.firstHumanAction.by, "maintainer");
  assert.equal(row.walkAway.firstHumanAction.where, "PR #101");
  assert.match(row.walkAway.reason, /first human action: push on PR #101 by maintainer/);
  // Not a clean merge, no stopwatch: operator minutes are unknown, never guessed.
  assert.equal(row.operator.minutes, "unknown");
  const timed = scoreObjective(humanPush(43, usage("claude")), { prices, minutes: 12, now: NOW });
  assert.deepEqual(timed.operator, { minutes: 12, basis: "--minutes (stopwatch)" });
});

test("workflow hand-over, scored as an owner step (the default): the Objective walks away, and the person's step is shown apart with its own minutes", () => {
  const MAINTAINER = { login: "maintainer", type: "User" };
  const c = withHandover(cleanMerge(47, usage("claude")));
  const merged = c.pulls[0].merged_at;
  const row = scoreObjective(c, { prices, now: NOW });
  assert.equal(row.walkAway.handover, "owner-step");
  assert.equal(row.walkAway.value, true);
  assert.equal(row.walkAway.bucket, "walk-away");
  assert.equal(row.walkAway.askedOnly.value, true);
  assert.equal(row.walkAway.humanActions, 0);
  assert.match(row.walkAway.reason, /^merged with no human action after the label; owner step: workflow hand-over \(PR #100\)$/);
  // Pendulum still asked for it: the request is listed, and nothing answered it inside the run.
  assert.deepEqual(row.walkAway.interventions.requests.filter((r) => r.kind === "workflow hand-over").map((r) => r.at), [merged]);
  assert.deepEqual(row.operator, { minutes: 0, basis: "clean merge; the owner step's minutes are apart (ownerStep)" });
  assert.deepEqual(row.ownerStep, { kind: "workflow hand-over", steps: [{ at: merged, where: "PR #100" }], applied: null, minutes: "unknown", basis: "not applied yet (pendulum:handover still on); give --owner-minutes <issue>=<n> from a stopwatch" });
  // The person removing pendulum:handover after the merge marks it applied: part of the owner step, not input. Its
  // minutes come from --owner-minutes, never from --minutes or the timestamps.
  c.issueTimeline.push({ event: "unlabeled", label: { name: "pendulum:handover" }, actor: MAINTAINER, created_at: "2031-03-02T05:00:00Z" });
  const done = scoreObjective(c, { prices, ownerMinutes: 7, now: NOW });
  assert.equal(done.walkAway.value, true);
  assert.equal(done.walkAway.humanActions, 0);
  assert.deepEqual(done.ownerStep.applied, { at: "2031-03-02T05:00:00Z", by: "maintainer" });
  assert.deepEqual([done.ownerStep.minutes, done.ownerStep.basis], [7, "--owner-minutes (stopwatch)"]);
  assert.equal(done.operator.minutes, 0);
  const table = markdownTable([done]);
  assert.match(table, /\| Operator min \| Owner step min \| Cost \|/);
  assert.match(table, /\| #47 \| merged \| yes, owner step: workflow hand-over \| yes \| 0 \/ 0 \| pending \| 0 \| 7 \(workflow hand-over\) \|/);
  assert.match(summaryLine([done]), /^Walk-away: 1 of 1 .* Owner steps \(a workflow hand-over, scored as normal work, its minutes apart\): #47 7 \(workflow hand-over\)\.$/);
  assert.match(markdownTable([row]), /\| 0 \| unknown \(workflow hand-over, not applied yet\) \|/);

  // The same row under the strict rule: one asked-for action at the merge, and the label removal is input too.
  const strict = scoreObjective(c, { prices, now: NOW, handover: "input" });
  assert.equal(strict.walkAway.value, false);
  assert.equal(strict.walkAway.humanActions, 2);
  assert.equal(strict.ownerStep, null);
  assert.match(summaryLine([strict]), / Workflow hand-overs scored as input: #47\.$/);
  assert.throws(() => scoreObjective(c, { prices, now: NOW, handover: "skip" }), /handover: skip is not one of owner-step, input/);
});

test("human push: the bot's own commits and comments never count, nor the label that starts the clock", () => {
  const actions = humanActions(cleanMerge(42), "2031-03-02T01:00:00Z");
  assert.deepEqual(actions, []);
  // An extra machine login given with --bot is ignored too.
  const c = humanPush(43);
  c.pullDetails[101].commits[1].author = { login: "ci-helper", type: "User" };
  assert.equal(humanActions(c, "2031-03-02T01:00:00Z").length, 1);
  assert.equal(humanActions(c, "2031-03-02T01:00:00Z", { bots: new Set(["ci-helper"]) }).length, 0);
});

test("cost: a raw stream is never priced; an artifact with no result.json is one run of unknown cost (#483)", () => {
  // Real Codex 0.167.0 streams as the worker tees them, and a raw Claude result: neither is a stage's record.
  const fixtures = join(BENCH, "..", "plugin", "test", "fixtures");
  const pass = (label, f) => `{"type":"pendulum.run","label":"${label}","harness":"codex"}\n${read(join(fixtures, f))}`;
  assert.equal(parseUsageText(pass("work-1", "codex-0.167-thread.jsonl") + pass("validation-fix-1", "codex-0.167-thread-resumed.jsonl")), null);
  assert.equal(parseUsageText(read(join(USAGE, "claude-result.json"))), null);
  // A stage killed before its result.json: its artifact holds only the raw stream (a Claude stream of two passes, each
  // with a result line, the second a resumed session's running total). It scores as one run of unknown cost.
  const dir = mkdtempSync(join(tmpdir(), "score-noresult-"));
  try {
    mkdirSync(join(dir, "pendulum-usage-61"));
    const result = (usd) => JSON.stringify({ type: "result", subtype: "success", session_id: "s1", total_cost_usd: usd });
    writeFileSync(join(dir, "pendulum-usage-61", "events.jsonl"), `${result(1)}\n${result(3)}\n`);
    const records = usageFromDir(dir, { readdir: (p) => readdirSync(p), read: (p) => readFileSync(p, "utf8"), isDir: (p) => statSync(p).isDirectory() });
    assert.equal(records.length, 1);
    assert.deepEqual([records[0].usd, records[0].usdUnknown, records[0].usdUnknownWhy], [null, 1, ["unreported"]]);
    const cost = costOf(records, prices, { harness: "claude" });
    assert.deepEqual([cost.usd, cost.usdUnknown], [null, 1], "never $4 (both totals summed) and never $0");
    assert.match(cost.basis, /plus 1 run of unknown cost/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cost: Codex tokens are priced from the Codex price table, with its date in the basis", () => {
  const row = scoreObjective(cleanMerge(46, usage("codex")), { prices, now: NOW });
  assert.equal(row.harness, "codex");
  assert.equal(row.cost.unit, "usd"); // dollars priced from the table are the measure
  // 35,000 uncached in, 115,000 cached, 10,000 out (reasoning is inside output_tokens) at the gpt-6.1-sol standard rates (2.00 / 0.10 / 10.00)
  assert.equal(row.cost.usd, priceTokens(prices, "gpt-6.1-sol", { input: 150000, cached: 115000, output: 10000 }));
  assert.equal(row.cost.usd, 0.1815);
  assert.match(row.cost.basis, /codex-prices\.json dated 2026-11-16$|codex-prices\.json dated 2026-11-16;/);
  assert.equal(row.cost.priceTableDate, "2026-11-16");
  assert.equal(row.cost.note, null);
  // Raw events.jsonl beside result.json is the same run: one record, the normalized one.
  assert.equal(usage("codex").length, 1);
  const rec = usage("codex")[0];
  assert.equal(costOf([{ ...rec, model: "gpt-unknown-9" }], prices).usd, null);
  assert.match(costOf([{ ...rec, model: "gpt-unknown-9" }], prices).basis, /no price for gpt-unknown-9/);
});

test("cost: Copilot dollars are the AI credits the worker priced, premium requests beside; an old artifact without credits is of unknown cost", () => {
  const work = { harness: "copilot", model: "claude-sonnet-5.5", artifact: "pendulum-usage-47/result.json", usd: 0.4123, premiumRequests: 3, aiCredits: 41.23, tokens: { input: 90000, output: 900, cached: 60000, written: 29000 }, basis: "harness-reported: 41.23 AI credits from copilot --usage-output-file at $0.01/credit, 3 premium request(s)", runs: 2 };
  const review = { ...work, artifact: "pendulum-usage-47-review/result.json", usd: 0.1, premiumRequests: 1, aiCredits: 10 };
  const row = scoreObjective(cleanMerge(47, [work, review]), { prices, now: NOW });
  assert.equal(row.harness, "copilot");
  assert.equal(row.cost.unit, "usd");
  assert.equal(row.cost.usd, 0.5123);
  assert.equal(row.cost.premiumRequests, 4);
  assert.equal(row.cost.aiCredits, 51.23);
  assert.match(row.cost.basis, /^harness-reported: 51\.23 AI credits, 4 premium request\(s\)/);
  assert.equal(row.cost.note, null);
  assert.match(markdownTable([row]), /\| \$0\.51 \(/);
  const old = scoreObjective(cleanMerge(46, usage("copilot")), { prices, now: NOW });
  assert.equal(old.cost.usd, null);
  assert.match(old.cost.basis, /^unknown: no AI credits in the usage artifact; plus 1 run of unknown cost/);
  assert.equal(old.cost.usdUnknown, 1);
  assert.match(old.cost.note, /no AI credits/);
});

test("cost: the reviewer's artifact is summed with the worker's, cache writes and the per-model split kept", () => {
  const both = [...usage("claude"), ...usage("review")];
  const row = scoreObjective(cleanMerge(48, both), { prices, now: NOW });
  assert.equal(row.cost.usd, 8.2312);
  assert.match(row.cost.basis, /2 artifacts summed/);
  // Cache writes and the per-model split are kept: cost by component without re-reading the artifact.
  const [work] = usage("claude");
  assert.equal(costOf([work], prices).tokens.written, work.tokens.written ?? null);
  assert.match(markdownTable([row]), /\$8\.23 \(\d+k in \/ \d+k cached \/ \d+k written \/ \d+k out\)/);
});

test("no usage artifact: the row says so instead of guessing", () => {
  const row = scoreObjective(cleanMerge(49, []), { prices, now: NOW });
  assert.deepEqual(row.missing, ["usage artifact"]);
  assert.equal(row.cost.usd, null);
  assert.equal(row.cost.basis, "unknown: no usage artifact");
  assert.match(markdownTable([row]), /#49: missing usage artifact/);
});

test("collect over a snapshot gives the fixture back, and score.mjs --replay writes the table, the JSON and the standing scorecard", async () => {
  const fixture = cleanMerge(42, usage("claude"));
  const snapshot = snapshotOf(fixture);
  const collected = await collectObjective(snapshotApi(snapshot), REPO, 42, { usage: usage("claude") });
  assert.equal(collected.pulls.length, 1);
  assert.equal(collected.pulls[0].merged_by.login, "acme-pendulum[bot]");
  assert.equal(collected.jobs.length, 2);
  assert.equal(collected.harness, "claude");
  const rowA = scoreObjective(collected, { prices, now: NOW });
  const rowB = scoreObjective(fixture, { prices, now: NOW });
  assert.equal(rowA.walkAway.value, true);
  assert.equal(rowA.runnerMinutes, rowB.runnerMinutes);

  const dir = mkdtempSync(join(tmpdir(), "pendulum-bench-test-"));
  const file = join(dir, "snapshot.json");
  writeFileSync(file, JSON.stringify(snapshot));
  const standing = join(dir, "scorecard.json");
  writeFileSync(standing, JSON.stringify({ version: 1, rows: [{ repository: REPO, issue: 7, walkAway: { value: true } }, { repository: REPO, issue: 42, walkAway: { value: false } }] }));
  const out = execFileSync("node", [join(BENCH, "score.mjs"), "--replay", file, "--usage", join(USAGE, "claude"), "--out", join(dir, "rows.json"), "--append", standing], { encoding: "utf8", cwd: dir });
  assert.match(out, /^\| Issue \| Exit \| Walk-away \|/);
  assert.match(out, /^\| Issue \| Exit \| Walk-away \| Walk-away \(asked only\) \| Asked \/ unprompted \| Quality \|/);
  assert.match(out, /\| #42 \| merged \| yes \| yes \| 0 \/ 0 \| pending \| 0 \| none \| \$7\.43 \(201k in \/ 2700k cached \/ 0k written \/ 50k out\) \| usd \|/);
  assert.match(out, /^Walk-away: 1 of 1 Objective\(s\) \(1 merged\) with no human input; 1 of 1 counting only input Pendulum asked for\. Interventions: 0 asked for \(Question, Blocked notice, review request\), 0 unprompted\.$/m);
  const rows = JSON.parse(read(join(dir, "rows.json"))).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].issue, 42);
  // The row names the checkout's skills by the digest computed from bench/skills.json's entries, as --check prints it.
  const check = execFileSync("node", [join(BENCH, "skills.mjs"), "--check"], { encoding: "utf8" });
  assert.equal(`skills unchanged: ${rows[0].skills.digest}\n`, check);
  assert.deepEqual(Object.keys(rows[0].skills), ["digest"]);
  const card = JSON.parse(read(standing));
  assert.deepEqual(card.rows.map((r) => r.issue), [7, 42]);
  assert.equal(card.rows[1].walkAway.value, true); // replaced, not duplicated
  assert.equal(card.rows[0].walkAway.value, true); // kept
});

test("cost: a sandbox stage's vendor cost is summed beside the model's, with a total, in the row, the table and the baseline", async () => {
  const rates = { vendor: "vercel", plan: "Pro", region: "iad1", date: "2026-11-08" };
  const work = { harness: "claude", artifact: "pendulum-usage-50/result.json", usd: 0.26, runs: 1, tokens: { input: 1e5, output: 1e3, cached: 9e4, written: 5e3 }, vendor: { usd: 0.0063, storedUsd: 0, rates } };
  const review = { harness: "claude", artifact: "pendulum-usage-50-review/result.json", usd: 0.5, runs: 1, tokens: { input: 1e5, output: 1e3, cached: 9e4, written: 5e3 }, vendor: { usd: null, storedUsd: 0.0002, rates } };
  const row = scoreObjective(cleanMerge(50, [work, review]), { prices, now: NOW });
  assert.equal(row.cost.usd, 0.76, "the model's dollars stay the harness's");
  // The review stage's sandbox usage was not reported: a run of unknown cost, never its session's ceiling.
  assert.equal(row.cost.vendorUsd, 0.0063);
  assert.equal(row.cost.totalUsd, 0.7663);
  assert.equal(row.cost.vendor.parts, 2);
  assert.equal(row.cost.vendor.usdUnknown, 1);
  assert.equal(row.cost.totalUnknown, 1);
  assert.match(row.cost.vendor.basis, /2 sandbox stage\(s\), 1 of unknown cost \(the sandbox vendor did not report the stage's usage\); vercel Pro list rates \(iad1\) read 2026-11-08/);
  const table = markdownTable([row]);
  assert.match(table, /\$0\.76 \([^)]*\) \+ \$0\.0063 sandbox plus 1 run of unknown cost = \$0\.77 plus 1 run of unknown cost/);
  assert.doesNotMatch(table, /≤|at most|at least|upper bound/);
  assert.match(table, /- #50: sandbox 2 sandbox stage\(s\)/);
  const { baselineOf } = await import("../lib/baseline.mjs");
  // A row with a run of unknown cost is left out of the dollar medians, and counted beside them.
  const line = baselineOf([row], {});
  assert.deepEqual([line.measures.vendorUsd.median, line.measures.vendorUsd.leftOut, line.measures.totalUsd.leftOut], [null, 1, 1]);
  const known = baselineOf([scoreObjective(cleanMerge(50, [work]), { prices, now: NOW })], {});
  assert.deepEqual([known.measures.vendorUsd.median, known.measures.totalUsd.median], [0.0063, 0.27]);
  // One booking per stage: the same stage's booking carried by two artifacts (a retried launch) counts once.
  const once = { ...work, vendor: { ...work.vendor, claim: "0123456789ab" } };
  const twice = scoreObjective(cleanMerge(52, [once, { ...once, artifact: "pendulum-usage-52/result.json", usd: null }]), { prices, now: NOW });
  assert.equal(twice.cost.vendorUsd, 0.0063);
  assert.equal(twice.cost.vendor.parts, 1);
  // A runner Objective has no vendor part: its total is its model cost.
  const plain = scoreObjective(cleanMerge(51, usage("claude")), { prices, now: NOW });
  assert.equal(plain.cost.vendor, null);
  assert.equal(plain.cost.vendorUsd, null);
  assert.equal(plain.cost.totalUsd, plain.cost.usd);
});

test("--usage: an issue with no directory of its own has no usage, never the other issues'", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pendulum-bench-usage-"));
  const isDir = (f) => statSync(f).isDirectory();
  mkdirSync(join(dir, "42", "pendulum-usage-42"), { recursive: true });
  cpSync(join(USAGE, "claude", "result.json"), join(dir, "42", "pendulum-usage-42", "result.json"));
  assert.equal(usageDirFor(dir, 42, { scored: 2, readdir: readdirSync, isDir }), join(dir, "42"));
  assert.equal(usageDirFor(dir, 44, { scored: 2, readdir: readdirSync, isDir }), null);
  assert.equal(usageDirFor(dir, 44, { scored: 1, readdir: readdirSync, isDir }), null, "other issues' directories are not this issue's unzip");
  // One artifact's unzip: the directory itself for one issue, nobody's for several.
  assert.equal(usageDirFor(join(USAGE, "claude"), 44, { scored: 1, readdir: readdirSync, isDir }), join(USAGE, "claude"));
  assert.equal(usageDirFor(join(USAGE, "claude"), 44, { scored: 2, readdir: readdirSync, isDir }), null);

  // score.mjs end to end: #44 Blocked before any stage ran, scored beside #42 from one per-issue directory.
  const a = snapshotOf(cleanMerge(42));
  const b = snapshotOf(blocked(44));
  const file = join(dir, "snapshot.json");
  writeFileSync(file, JSON.stringify({ repository: REPO, issues: [42, 44], calls: { ...a.calls, ...b.calls } }));
  execFileSync("node", [join(BENCH, "score.mjs"), "--replay", file, "--usage", dir, "--out", join(dir, "rows.json")], { encoding: "utf8", cwd: dir });
  const rows = JSON.parse(read(join(dir, "rows.json"))).rows;
  assert.equal(rows.find((r) => r.issue === 42).cost.usd, 7.4312);
  const none = rows.find((r) => r.issue === 44);
  assert.equal(none.cost.usd, null);
  assert.ok(none.missing.includes("usage artifact"));

  // A snapshot an older bench wrote with --usage stored #44's borrowed records: --usage decides on the replay too.
  const old = join(dir, "old-snapshot.json");
  writeFileSync(old, JSON.stringify({ repository: REPO, issues: [42, 44], calls: { ...a.calls, ...b.calls }, collected: { 44: blocked(44, usage("claude")) } }));
  execFileSync("node", [join(BENCH, "score.mjs"), "--replay", old, "--usage", dir, "--out", join(dir, "old-rows.json")], { encoding: "utf8", cwd: dir });
  const replayed = JSON.parse(read(join(dir, "old-rows.json"))).rows.find((r) => r.issue === 44);
  assert.equal(replayed.cost.usd, null);
  assert.ok(replayed.missing.includes("usage artifact"));
});

test("local mode where no Action runs: the pendulum:local label a loop applied is Pendulum's when its local-route mark names that exact event; a person's own pendulum:local label stays a person's (#455)", async () => {
  const picked = { id: 9001, event: "labeled", label: { name: "pendulum:local" }, actor: OPERATOR, created_at: "2031-03-02T01:00:40Z" };
  const mark = (id, user = OPERATOR) => ({ id: 8000 + id, user, created_at: "2031-03-02T01:00:42Z", updated_at: "2031-03-02T01:00:42Z", body: `<!-- pendulum:60:local-route:${id} -->\nPendulum: no Action runs Objectives in this repository, so a local loop took this Objective and labelled it \`pendulum:local\`; it stays that machine's.` });
  // The loop's pick: the label event and Pendulum's mark naming it. No human action.
  const serve = localMerge(60);
  serve.issueTimeline.splice(1, 0, picked);
  serve.issueComments.push(mark(9001));
  const row = scoreObjective(serve, { prices, now: NOW });
  assert.equal(row.walkAway.value, true, row.walkAway.reason);
  assert.equal(row.walkAway.humanActions, 0);
  // No mark: the same label is a person's decision.
  const unmarked = localMerge(60);
  unmarked.issueTimeline.splice(1, 0, picked);
  const miss = scoreObjective(unmarked, { prices, now: NOW });
  assert.equal(miss.walkAway.value, false);
  assert.equal(miss.walkAway.firstHumanAction.kind, "labeled pendulum:local");
  // A person's own pendulum:local label (another event) stays theirs beside the loop's mark; a mark by another login, or
  // naming another event, counts for nothing.
  const own = localMerge(60);
  own.issueTimeline.splice(1, 0, picked);
  own.issueTimeline.push({ id: 9002, event: "labeled", label: { name: "pendulum:local" }, actor: OPERATOR, created_at: "2031-03-02T01:30:00Z" });
  own.issueComments.push(mark(9001));
  const person = scoreObjective(own, { prices, now: NOW });
  assert.equal(person.walkAway.humanActions, 1);
  assert.equal(person.walkAway.firstHumanAction.at, "2031-03-02T01:30:00Z");
  const check = localPendulumActions({ ...own, issueComments: [...own.issueComments, mark(9002, { login: "someone", type: "User" })] });
  assert.equal(check("2031-03-02T01:00:40Z", OPERATOR, "labeled pendulum:local", 9001), true);
  assert.equal(check("2031-03-02T01:30:00Z", OPERATOR, "labeled pendulum:local", 9002), false, "a mark by another login");
  assert.equal(check("2031-03-02T01:00:40Z", OPERATOR, "labeled pendulum:local", null), false, "no event id, no mark");
  // Two marks naming one event, by two logins: each pair counts on its own, never the last one only.
  const both = localPendulumActions({ ...serve, issueComments: [...serve.issueComments, mark(9001, { login: "someone", type: "User" })] });
  assert.equal(both("2031-03-02T01:00:40Z", OPERATOR, "labeled pendulum:local", 9001), true);
  // Pendulum's activity spans count the marked label as its act too.
  const { pendulumActivity } = await import("../lib/objective.mjs");
  const at = Date.parse("2031-03-02T01:00:40Z");
  assert.ok(pendulumActivity(serve).some(([a, b]) => a === at && b === at));
  assert.ok(!pendulumActivity(unmarked).some(([a, b]) => a === at && b === at));
});

test("cost: runs of unknown cost are counted beside the known dollars, from a result.json and a spend line alike; never a bound or $0", async () => {
  const { spendRecords } = await import("../lib/objective.mjs");
  // A work stage on Actions whose result.json holds $3 and one run that ended before its harness reported (#478), and a
  // local review stage whose spend line holds $2 and one such run.
  const artifact = { harness: "claude", model: "claude-opus-5-5", artifact: "pendulum-usage-61/result.json", usd: 3, usdUnknown: 1, usdUnknownWhy: ["unreported"], runs: 2, tokens: { input: 1, output: 1, cached: 0, written: 0 }, basis: "harness-reported: total_cost_usd, modelUsage (sub-agents included)" };
  const local = localMerge(61);
  local.issueComments = local.issueComments.filter((c) => !c.body.includes(":progress:work:"));
  local.issueComments[1].body = local.issueComments[1].body.replace(/<!-- pendulum:spend .*-->/, `<!-- pendulum:spend ${JSON.stringify({ usd: 2, usdUnknown: 1, usdUnknownWhy: ["zeroed"] })} -->`);
  const lines = spendRecords(local, { all: true });
  assert.deepEqual(lines.map((l) => [l.usd, l.usdUnknown, l.usdUnknownWhy]), [[2, 1, ["zeroed"]]]);
  const cost = costOf([artifact, ...lines], prices, { harness: "claude" });
  assert.equal(cost.usd, 5, "the known dollars only");
  assert.equal(cost.usdUnknown, 2);
  assert.deepEqual(cost.usdUnknownWhy, ["unreported", "zeroed"]);
  assert.match(cost.basis, /; plus 2 runs of unknown cost \(the run ended before its harness reported its cost; Claude Code's error result carried a zeroed cost/);
  assert.doesNotMatch(cost.basis, /lower bound|upper bound|estimate|at least|at most|partial/);
  for (const k of ["usdLowerBound", "usdUpperBound", "usdEstimated"]) assert.equal(cost[k], undefined, k);
  // The row and its table cell, local mode: the spend line's unknown run beside the known figure.
  const row = scoreObjective(local, { prices, now: NOW });
  assert.equal(row.cost.usd, 2);
  assert.equal(row.cost.usdUnknown, 1);
  assert.match(markdownTable([row]), /\| \$2\.00 plus 1 run of unknown cost \|/);
});

test("#479 cost: decision calls outside a stage (the decision-spend lines in Pendulum's own comments) join the row on every route, and a Codex stage's gateway decision dollars survive its re-pricing", () => {
  // A local Objective whose stages' spend lines hold $2, and the dispatcher's decision calls about it: $0.0031 and one
  // call the gateway gave no cost for.
  const local = localMerge(63);
  const at = "2031-03-02T00:30:00Z";
  // One in the dispatcher's decisions comment, one carried by an answer check's notice.
  local.issueComments.push({ id: 77, user: OPERATOR, created_at: at, updated_at: at, body: `<!-- pendulum:63:decisions:dispatcher -->\nDecision calls by UTC day:\n<!-- pendulum:decision-spend ${JSON.stringify({ date: "2031-03-02", calls: 1, usd: 0.0021 })} -->` });
  local.issueComments.push({ id: 79, user: OPERATOR, created_at: at, updated_at: at, body: `<!-- pendulum:63:question:unanswered:x -->\nQuestion still open.\n<!-- pendulum:decision-spend ${JSON.stringify({ date: "2031-03-02", calls: 2, usd: 0.001, usdUnknown: 1, usdUnknownWhy: ["decision"] })} -->` });
  // Someone else's paste of the marker counts nothing.
  local.issueComments.push({ id: 78, user: { login: "passer-by", type: "User" }, created_at: at, updated_at: at, body: `<!-- pendulum:63:decisions:dispatcher -->\n<!-- pendulum:decision-spend {"date":"2031-03-02","calls":1,"usd":100} -->` });
  const before = scoreObjective(localMerge(63), { prices, now: NOW }).cost.usd;
  const row = scoreObjective(local, { prices, now: NOW });
  assert.ok(Math.abs(row.cost.usd - before - 0.0031) < 1e-9);
  assert.equal(row.cost.usdUnknown, 1);
  assert.deepEqual(row.cost.usdUnknownWhy, ["decision"]);
  assert.ok(Math.abs((row.cost.usdByBilling?.api ?? 0) - 0.0031) < 1e-9, "billed to the gateway key: `api`");
  assert.match(row.cost.basis, /includes 0\.0031 USD of decision calls outside a stage \(the AI Gateway's cost, 2 comment\(s\)\)/);
  // With usage artifacts too (#506's withLines matches records to spend lines): the decision calls stay rows of their own,
  // never a stand-in and never matched to a stage's record or line, counted once.
  const claudeArtifact = { harness: "claude", model: "claude-opus-5-5", artifact: "pendulum-usage-63/result.json", usd: 1.5, tokens: { input: 1, output: 1, cached: 0, written: 0 }, runs: 1, basis: "harness-reported: total_cost_usd, modelUsage (sub-agents included)" };
  const plain = { ...localMerge(63), usage: [claudeArtifact] };
  const withDecisions = { ...local, usage: [claudeArtifact] };
  const base = scoreObjective(plain, { prices, now: NOW }).cost;
  const both = scoreObjective(withDecisions, { prices, now: NOW }).cost;
  assert.ok(Math.abs(both.usd - base.usd - 0.0031) < 1e-9, "the decision calls once, beside the stages");
  assert.equal(both.parts.filter((p) => p.harness === null && /decision calls outside a stage/.test(p.basis ?? "")).length, 2);
  // On Actions the stage dollars are the artifacts', and the comment still adds its own.
  const artifact = { harness: "codex", model: "gpt-6.1-sol", artifact: "pendulum-usage-63/result.json", usd: 0.2, gatewayDecisionUsd: 0.0042, tokens: { input: 150000, output: 10000, cached: 115000, written: null }, runs: 1, basis: "priced" };
  const priced = costOf([{ ...artifact, gatewayDecisionUsd: undefined }], prices).usd;
  const cost = costOf([artifact], prices);
  assert.ok(Math.abs(cost.usd - priced - 0.0042) < 1e-9, "the Codex tokens re-priced, the gateway's decision dollars kept");
});

test("cost: a Codex run killed before any turn completed stays a run of unknown cost on the scorecard, beside the priced one; never $0, never dropped", () => {
  const priced = { harness: "codex", model: "gpt-6.1-sol", artifact: "pendulum-usage-62/result.json", usd: 0.1815, tokens: { input: 150000, output: 10000, cached: 115000, written: null }, runs: 1, basis: "priced" };
  const killed = { harness: "codex", model: "gpt-6.1-sol", artifact: "pendulum-usage-62-review/result.json", usd: null, usdUnknown: 1, usdUnknownWhy: ["unreported"], tokens: { input: null, output: null, cached: null, written: null }, runs: 1, basis: CODEX_NO_TOKENS };
  const cost = costOf([priced, killed], prices);
  assert.equal(cost.usd, 0.1815);
  assert.equal(cost.usdUnknown, 1);
  assert.deepEqual(cost.parts.map((p) => [p.usd, p.usdUnknown]), [[0.1815, 0], [null, 1]]);
  assert.match(cost.basis, /^tokens priced at OpenAI's Standard rates from codex-prices\.json dated [^;]+; 2 artifacts summed \(worker \+ review\); plus 1 run of unknown cost \(the run ended before its harness reported its cost\)$/);
  const row = scoreObjective(cleanMerge(62, [priced, killed]), { prices, now: NOW });
  assert.match(markdownTable([row]), /\$0\.18 plus 1 run of unknown cost \(/);
});

/**
 * #480: a mixed-route Objective, its work on GitHub Actions (a progress comment with no spend line, its usage artifact
 * naming the comment) and its review run locally (a spend line only). `review` is the local review's spend line.
 */
function mixedRoute(number, { review = { usd: 3 }, work = null, workKey = "5551", reviewKey = "1700000002", artifact = {} } = {}) {
  const c = cleanMerge(number);
  const app = c.issueComments[0].user;
  const progress = (kind, key, spend, created) => ({ user: app, created_at: created, body: `<!-- pendulum:${number}:progress:${kind}:${key} -->\nPendulum ${kind} run ${key}\n- 01:02Z harness claude (claude-opus-5-5) attempt 1${spend ? `\n<!-- pendulum:spend ${JSON.stringify(spend)} -->` : ""}` });
  // `review: false`: no review stage at all.
  c.issueComments.push(progress("work", workKey, work, "2031-03-02T01:02:00Z"), ...(review === false ? [] : [progress("review", reviewKey, review, "2031-03-02T02:20:00Z")]));
  // A field given as undefined is left out: a record from before records named their comment has no `progressRun` at all.
  const rec = { harness: "claude", model: "claude-opus-5-5", artifact: `pendulum-usage-${number}/result.json`, progressRun: workKey, usd: 8, runs: 1, tokens: { input: 1, output: 1, cached: 0, written: 0 }, basis: "harness-reported: total_cost_usd, modelUsage (sub-agents included)", ...artifact };
  c.usage = [Object.fromEntries(Object.entries(rec).filter(([, v]) => v !== undefined))];
  c.harness = "claude";
  return c;
}

test("#480: a mixed-route Objective's dollars are its Actions artifacts' and its local stages' spend lines together: $8 + $3 = $11", () => {
  const row = scoreObjective(mixedRoute(70), { prices, now: NOW });
  assert.equal(row.cost.usd, 11);
  assert.equal(row.cost.usdUnknown, undefined, "the Actions stage's comment, which its artifact names, is no run of unknown cost");
  assert.deepEqual(row.cost.parts.map((p) => p.usd), [8, 3]);
  assert.match(row.cost.basis, /; 1 artifact\(s\) and 1 spend line\(s\) summed$/);
  assert.match(markdownTable([row]), /\| \$11\.00 \(/);
  assert.deepEqual([row.activity.workRuns, row.activity.reviewRuns], [1, 1]);
});

test("#480: a stage seen in both its usage artifact and its progress comment's spend line counts once, whatever its comment's key", () => {
  // A cloud sandbox stage: its spend line and its artifact (uploaded at its end) hold the same $8; its key is `<run>-<claim>`.
  const sandbox = mixedRoute(71, { workKey: "5552-abcdef012345", work: { usd: 8 } });
  const row = scoreObjective(sandbox, { prices, now: NOW });
  assert.equal(row.cost.usd, 11, "$8 once, plus the local review's $3");
  assert.deepEqual(row.cost.parts.map((p) => p.artifact), ["pendulum-usage-71/result.json", "spend/review/1700000002"]);
});

test("#506 review: a record stands for the comments of its own stage it names exactly: an Actions re-run's key, an old sandbox claim, never a comment it does not name", () => {
  const score = (c) => scoreObjective(c, { prices, now: NOW });
  // An artifact from before `progressRun`, uploaded by run 5553, whose work comment is its second attempt's.
  const rerun = mixedRoute(80, { workKey: "5553-2", artifact: { progressRun: undefined, workflowRun: 5553 } });
  assert.deepEqual([score(rerun).cost.usd, score(rerun).cost.usdUnknown], [11, undefined], "the artifact is that comment's stage; the local review's $3 still counts");
  // Another run's artifact names neither comment: both count (its comment is a run of unknown cost beside it).
  const other = mixedRoute(81, { workKey: "5553-2", artifact: { progressRun: undefined, workflowRun: 6000 } });
  assert.deepEqual([score(other).cost.usd, score(other).cost.usdUnknown], [11, 1]);
  // An old sandbox artifact (no `progressRun`), matched to its comment `<run>-<claim>` by its claim: $8 and the vendor once.
  const sandbox = mixedRoute(82, { workKey: "5552-abcdef012345", work: { usd: 8 }, artifact: { progressRun: undefined, vendor: { claim: "abcdef012345", usd: 0.6 } } });
  const s = score(sandbox);
  assert.deepEqual([s.cost.usd, s.cost.vendorUsd, s.cost.usdUnknown], [11, 0.6, undefined]);
  // A review artifact keyed as the work's comment (one run for both jobs) stands for the review's comment only: the work's
  // artifact expired, so its comment is a run of unknown cost.
  const shared = mixedRoute(83, { review: null, reviewKey: "5551", artifact: { artifact: "pendulum-usage-83-review/result.json", progressRun: "5551", usd: 3 } });
  assert.deepEqual([score(shared).cost.usd, score(shared).cost.usdUnknown], [3, 1]);
  // An artifact with no result.json and no run to match (read from --usage): it stands for no comment, so the local
  // review's line still counts beside it.
  assert.equal(score(mixedRoute(84, { artifact: { progressRun: undefined, standIn: true, harness: null, usd: null, usdUnknown: 1, usdUnknownWhy: ["unreported"] } })).cost.usd, 3);
});

test("#506 review S3: a record that cannot say which comment is its own never doubles a figure: its dollars are unknown beside an unnamed comment of its stage", () => {
  const score = (c) => scoreObjective(c, { prices, now: NOW });
  // S3: a local result.json from before #266 (no progressRun field, no account) beside its stage's $5 comment that no record
  // names: it may be that stage, so its $5 is unknown there, never $10.
  const s3 = mixedRoute(94, { workKey: "1700000001", work: { usd: 5 }, review: false, artifact: { artifact: "usage-work-1/result.json", progressRun: undefined, usd: 5 } });
  const r3 = score(s3);
  assert.deepEqual([r3.cost.usd, r3.cost.usdUnknown, r3.cost.usdUnknownWhy], [5, 1, ["unmatched"]]);
  // An artifact with no result.json and no run to match (read from --usage): it stands for no comment, so the local
  // review's line still counts beside it.
  const unread = mixedRoute(96, { artifact: { progressRun: undefined, standIn: true, harness: null, usd: null, usdUnknown: 1, usdUnknownWhy: ["unreported"] } });
  // Its stage's comment (no spend line, as on Actions) is a run of unknown cost too: the trade-off of a record that names
  // nothing is one more unknown run, never a known figure twice.
  assert.deepEqual([score(unread).cost.usd, score(unread).cost.usdUnknown], [3, 2]);
});

/** `c` labelled before the rename to Pendulum: its first label under the old name, a day before the fixture's (#567). */
const renamed = (c, name = `${PREVIOUS_NAME}:objective`) => ({ ...c, issueTimeline: [{ event: "labeled", label: { name }, actor: OPERATOR, created_at: "2031-03-01T01:00:00Z" }, ...c.issueTimeline] });

test("an Objective labelled before the rename to Pendulum (#567): a clean merge's walk-away, operator minutes, waiting and wall clock are unknown and in no walk-away count; nothing else changes", async () => {
  const { streaks, pooledStreak, verdict } = await import("../lib/streak.mjs");
  const { baselineOf } = await import("../lib/baseline.mjs");
  const plain = scoreObjective(cleanMerge(42, usage("claude")), { prices, now: NOW });
  assert.deepEqual([plain.wallMinutes, plain.walkAway.value, plain.operator.minutes], [150, true, 0]);
  for (const name of [`${PREVIOUS_NAME}:objective`, `${PREVIOUS_NAME}:running`]) {
    const row = scoreObjective(renamed(cleanMerge(42, usage("claude")), name), { prices, now: NOW });
    assert.deepEqual([row.wallMinutes, row.workingMinutes, row.wallBasis], [null, null, "unknown: labelled before the rename to Pendulum"], name);
    assert.deepEqual([row.walkAway.value, row.walkAway.bucket, row.walkAway.reason, row.walkAway.askedOnly.value, row.walkAway.clockRenamed], [null, "unknown", RENAMED_WHY, null, true]);
    assert.equal(row.operator.minutes, "unknown");
    assert.equal(row.waitingMinutes, null);
    assert.ok(row.missing.includes("clock start (labelled before the rename to Pendulum)"));
    // A stopwatch reading is a measure of its own: it stands.
    assert.equal(scoreObjective(renamed(cleanMerge(42, usage("claude")), name), { prices, now: NOW, minutes: 12 }).operator.minutes, 12);
    // What the later window read stands as read; the exit, the cost and the rest of the row are as without the event.
    const rest = ({ walkAway: { value, bucket, reason, askedOnly, clockRenamed, ...w }, operator, wallMinutes, wallBasis, workingMinutes, waitingMinutes, waitingBasis, missing, ...r }) => ({ w, r });
    assert.deepEqual(rest(row), rest(plain));
    // The table says unknown; the summary leaves it out of every count and names it.
    const other = scoreObjective(cleanMerge(43, usage("claude")), { prices, now: NOW });
    const table = markdownTable([row, other]);
    assert.match(table, new RegExp(`^\\| #42 \\| merged \\| unknown: not known: labelled before the rename to Pendulum[^|]* \\| unknown \\| 0 / 0 \\|`, "m"));
    assert.match(table, new RegExp(`\\| ${plain.runnerMinutes} \\| unknown \\|`));
    assert.match(table, /^Walk-away: 1 of 1 Objective\(s\) \(1 merged\) with no human input; 1 of 1 counting only input Pendulum asked for\. [^\n]* Not known \(labelled before the rename to Pendulum\), in no count: #42\.$/m);
    // The streak skips it: it neither extends nor breaks, and is not finished; the baseline's walk-away rate leaves it out.
    assert.deepEqual(verdict(row), { ok: null, unknown: true, why: `walk-away unknown: ${RENAMED_WHY}` });
    const h = Object.values(streaks([row, other], { from: "2031-02-01T00:00:00Z" }).harnesses)[0];
    assert.deepEqual([h.finished, h.walkAway, h.current, h.sequence.map((x) => [x.issue, x.ok])], [1, 1, 1, [[42, null], [43, true]]]);
    const pooled = pooledStreak([{ ...row, repository: REPO }, { ...other, repository: REPO }], { from: "2031-02-01T00:00:00Z" });
    assert.deepEqual([pooled.finished, pooled.walkAway, pooled.current], [1, 1, 1]);
    assert.equal(baselineOf([row, other]).walkAway, 100);
  }
});

test("#589: the scorecard reads progress comments with the card over their log as the same comments before it", () => {
  for (const make of [() => localMerge(60), () => cleanMerge(42, usage("claude")), () => blocked(44, usage("claude"))]) {
    const c = make();
    const fresh = make();
    fresh.issueComments = newForms(fresh.issueComments);
    fresh.issueTimeline = newForms(fresh.issueTimeline);
    assert.deepEqual(scoreObjective(fresh, { prices, now: NOW }), scoreObjective(c, { prices, now: NOW }));
  }
  const local = localMerge(60);
  assert.ok(newForms(local.issueComments).some((x, i) => x.body !== local.issueComments[i].body), "the fixture has progress comments, now in the new form");
});
