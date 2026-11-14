// The four numbers on invented Objectives (fixtures/github.mjs) and the
// usage fixtures per harness (fixtures/usage/). No token, no network.
import "../../plugin/test/temp.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { collectObjective, snapshotApi, usageDirFor, usageFromDir } from "../lib/collect.mjs";
import { cacheOf, costOf, loadPrices, parseUsageText, priceTokens, sessionsOf } from "../lib/cost.mjs";
import { factoryRequests, humanActions, localFactoryActions, markdownTable, scoreObjective, splitInterventions, summaryLine } from "../lib/objective.mjs";
import { bySelf, dispatchLatency, factoryLogin, failedStartsOf, lastWrite, launchesOf, phaseMinutes, setupSeconds } from "../lib/phases.mjs";
import { noWait, waitedRecorded, waitedUnrecorded } from "./fixtures/sandbox-drill.mjs";
import { blocked, cleanMerge, humanPush, questionAnswered, REPO, snapshotOf } from "./fixtures/github.mjs";
import { CODEX_NO_TOKENS, mergeUsage, parseUsage } from "../../plugin/scripts/lib/usage.mjs";
import { usdText } from "../../plugin/scripts/lib/logic.mjs";

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
  assert.equal(row.mergedBy, "acme-factory[bot]");
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

test("human push: the bot's own commits and comments never count, nor the label that starts the clock", () => {
  const actions = humanActions(cleanMerge(42), "2031-03-02T01:00:00Z");
  assert.deepEqual(actions, []);
  // An extra machine login given with --bot is ignored too.
  const c = humanPush(43);
  c.pullDetails[101].commits[1].author = { login: "ci-helper", type: "User" };
  assert.equal(humanActions(c, "2031-03-02T01:00:00Z").length, 1);
  assert.equal(humanActions(c, "2031-03-02T01:00:00Z", { bots: new Set(["ci-helper"]) }).length, 0);
});

test("blocked: a Blocked card is a miss with the worker's reason, exit blocked, no merge", () => {
  const row = scoreObjective(blocked(44, usage("claude")), { prices, now: NOW });
  assert.equal(row.exit, "blocked");
  assert.equal(row.walkAway.value, false);
  assert.equal(row.walkAway.blocked.at, "2031-03-02T04:00:00Z");
  assert.equal(row.walkAway.blocked.reason, "validation red after Factory's second pass (work)");
  assert.match(row.walkAway.reason, /not merged \(blocked: .*validation red/);
  assert.equal(row.wallMinutes, null);
  assert.equal(row.operator.minutes, "unknown");
  assert.equal(row.pr, 102);
});

test("question answered: merged, but the owner's answer and ready-for-review are human input, so walk-away is a miss that names the question", () => {
  const row = scoreObjective(questionAnswered(45, usage("claude")), { prices, now: NOW });
  assert.equal(row.exit, "merged");
  assert.equal(row.walkAway.value, false);
  assert.equal(row.walkAway.question.source, "label");
  assert.equal(row.walkAway.question.answered, true);
  assert.match(row.walkAway.reason, /^Question answered; first human action: comment on PR #103 by maintainer/);
  assert.equal(row.walkAway.firstHumanAction.kind, "comment");
  assert.equal(row.walkAway.firstHumanAction.by, "maintainer");
  assert.equal(row.walkAway.humanActions, 2); // the comment and ready_for_review
  assert.equal(row.wallMinutes, 33 * 60); // Mar 2 01:00 to Mar 3 10:00
});

test("cost: a raw Codex stream counts a resumed pass's own share", () => {
  // Real Codex 0.167.0 streams as the worker tees them: `codex exec`, then `codex exec resume` on the same thread, whose
  // turn.completed is the thread's running total. Together they cost what the thread reported last.
  const fixtures = join(BENCH, "..", "plugin", "test", "fixtures");
  const pass = (label, f) => `{"type":"factory.run","label":"${label}","harness":"codex"}\n${read(join(fixtures, f))}`;
  const raw = parseUsageText(pass("work-1", "codex-0.167-thread.jsonl") + pass("validation-fix-1", "codex-0.167-thread-resumed.jsonl"), { model: "gpt-6.1-sol" });
  assert.deepEqual(raw.tokens, { input: 39039, output: 55, cached: 24576, written: 0 });
  assert.equal(raw.turns, 2);
});

test("cost: Codex tokens are priced from the Codex price table, with its date in the basis", () => {
  const row = scoreObjective(cleanMerge(46, usage("codex")), { prices, now: NOW });
  assert.equal(row.harness, "codex");
  assert.equal(row.cost.unit, "usd"); // dollars priced from the table are the measure
  // 35,000 uncached in, 115,000 cached, 10,000 out (reasoning is inside output_tokens) at the gpt-6.1-sol standard rates (2.00 / 0.10 / 10.00)
  assert.equal(row.cost.usd, priceTokens(prices, "gpt-6.1-sol", { input: 150000, cached: 115000, output: 10000 }));
  assert.equal(row.cost.usd, 0.1815);
  assert.match(row.cost.basis, /codex-prices\.json dated 2026-11-11$|codex-prices\.json dated 2026-11-11;/);
  assert.equal(row.cost.priceTableDate, "2026-11-11");
  assert.equal(row.cost.note, null);
  // Raw events.jsonl beside result.json is the same run: one record, the normalized one.
  assert.equal(usage("codex").length, 1);
  const raw = parseUsageText(read(join(USAGE, "codex", "events.jsonl")), { model: "gpt-6.1-sol" });
  assert.deepEqual(raw.tokens, { input: 150000, output: 10000, cached: 115000, written: null });
  assert.equal(costOf([raw], prices).usd, 0.1815);
  assert.equal(costOf([{ ...raw, model: "gpt-unknown-9" }], prices).usd, null);
  assert.match(costOf([{ ...raw, model: "gpt-unknown-9" }], prices).basis, /no price for gpt-unknown-9/);
});

test("cost: a Codex stage with no completed turn says so, in the worker's record, its exit line and the scorecard alike; never a missing price", () => {
  // clockgrove/factory-scratch#498: three gpt-6.1-sol calls, each refused before any turn completed (events.jsonl, one run's lines).
  const events = read(join(import.meta.dirname, "..", "..", "plugin", "test", "fixtures", "codex-0.167-refused-400.jsonl"));
  const worker = mergeUsage([1, 2, 3].map(() => parseUsage("codex", events, "gpt-6.1-sol", 1)));
  assert.equal(worker.usd, null, "spend unknown, not zero: a cut turn may have spent tokens");
  assert.equal(worker.basis, CODEX_NO_TOKENS);
  assert.equal(usdText(worker), "unmetered (no Codex turn completed, so Codex reported no tokens)");
  // The scorecard, from the uploaded result.json (as session.mjs writes it) or from the raw events.
  const result = { harness: "codex", model: "gpt-6.1-sol", usd: null, tokens: worker.tokens, basis: worker.basis, turns: 0, runs: 3, artifact: "factory-usage-498/result.json" };
  for (const rec of [result, parseUsageText(events, { model: "gpt-6.1-sol" })]) {
    const cost = costOf([rec], prices);
    assert.equal(cost.usd, null);
    assert.equal(cost.basis, CODEX_NO_TOKENS);
  }
  // A model the table lacks, with tokens, is still a missing price.
  assert.match(costOf([{ ...result, model: "gpt-unknown-9", tokens: { input: 10, output: 1, cached: 0, written: null } }], prices).basis, /no price for gpt-unknown-9/);
  assert.equal(usdText({ usd: 0.25, basis: "x" }), "0.25");
});

test("cost: Copilot dollars are the AI credits the worker priced, premium requests beside; an old artifact without credits stays unmetered", () => {
  const work = { harness: "copilot", model: "claude-sonnet-5.5", artifact: "factory-usage-47/result.json", usd: 0.4123, premiumRequests: 3, aiCredits: 41.23, tokens: { input: 90000, output: 900, cached: 60000, written: 29000 }, basis: "harness-reported: 41.23 AI credits from copilot --usage-output-file at $0.01/credit, 3 premium request(s)", runs: 2 };
  const review = { ...work, artifact: "factory-usage-47-review/result.json", usd: 0.1, premiumRequests: 1, aiCredits: 10 };
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
  assert.match(old.cost.basis, /^unmetered: no AI credits in the usage artifact/);
  assert.match(old.cost.note, /no AI credits/);
});

test("cost: the reviewer's artifact is summed with the worker's; a raw Claude result is read too", () => {
  const both = [...usage("claude"), ...usage("review")];
  const row = scoreObjective(cleanMerge(48, both), { prices, now: NOW });
  assert.equal(row.cost.usd, 8.2312);
  assert.match(row.cost.basis, /2 artifacts summed/);
  const raw = parseUsageText(read(join(USAGE, "claude-result.json")));
  assert.equal(raw.harness, "claude");
  assert.equal(raw.usd, 7.4312);
  assert.equal(raw.model, "claude-fable-5-1");
  assert.equal(raw.tokens.output, 50000);
  // Cache writes and the per-model split are kept: cost by component without re-reading the artifact.
  assert.equal(typeof raw.tokens.written, "number");
  assert.ok(raw.models && raw.models["claude-fable-5-1"]);
  assert.equal(Object.values(raw.models).reduce((s, m) => s + m.output, 0), raw.tokens.output);
  assert.equal(costOf([raw], prices).tokens.written, raw.tokens.written);
  assert.match(markdownTable([row]), /\$8\.23 \(\d+k in \/ \d+k cached \/ \d+k written \/ \d+k out\)/);
});

test("cost: the row's model is the work stage's whatever order the artifacts are listed in (#49)", () => {
  const work = { harness: "claude", model: "claude-opus-5-5", artifact: "factory-usage-49/result.json", usd: 2, runs: 1, tokens: { input: 1e5, output: 1e3, cached: 9e4, written: 5e3 } };
  const review = { ...work, model: "claude-fable-5-2", artifact: "factory-usage-49-review/result.json", usd: 1 };
  for (const records of [[work, review], [review, work]]) {
    const row = scoreObjective(cleanMerge(49, records), { prices, now: NOW });
    assert.equal(row.model, "claude-opus-5-5");
    assert.equal(row.cost.model, "claude-opus-5-5");
    assert.deepEqual([row.activity.workRuns, row.activity.reviewRuns], [1, 1]);
  }
});

test("cost: the prompt cache after each CI wait is summed across artifacts and noted under the table", () => {
  const first = (written, input) => ({ unit: "request", input, cached: input - written, written, written1h: written, written5m: 0 });
  const work = { harness: "claude", artifact: "factory-usage-49/result.json", usd: 2, runs: 3, tokens: { input: 1e6, output: 1e4, cached: 9e5, written: 1e5 }, cache: { ttl: "1h", writeShare: 0.1, afterWait: [{ label: "validation-fix-1", waitMin: 14, resumed: true, first: first(2000, 90000), writeShare: 0.05 }] } };
  const review = { harness: "claude", artifact: "factory-usage-49-review/result.json", usd: 1, runs: 2, tokens: { input: 5e5, output: 5e3, cached: 4e5, written: 1e5 }, cache: { ttl: "1h", writeShare: 0.2, afterWait: [{ label: "review-validation-fix-1", waitMin: 9, resumed: true, first: first(3000, 95000), writeShare: 0.1 }] } };
  const c = cacheOf([work, review]);
  assert.equal(c.ttl, "1h");
  assert.equal(c.firstWritten, 5000);
  assert.equal(c.firstInput, 185000);
  assert.deepEqual(c.afterWait.map((w) => w.artifact), [work.artifact, review.artifact]);
  assert.equal(cacheOf([{ harness: "claude", usd: 1 }]), null, "an artifact from before the cache record has none");
  const row = scoreObjective(cleanMerge(49, [work, review]), { prices, now: NOW });
  assert.equal(row.cost.cache.firstWritten, 5000);
  assert.match(markdownTable([row]), /#49: prompt cache \(TTL 1h\), first request after each CI wait: validation-fix-1 after 14 min: 2k written of 90k \(per request\); review-validation-fix-1 after 9 min: 3k written of 95k/);
});

test("no usage artifact: the row says so instead of guessing", () => {
  const row = scoreObjective(cleanMerge(49, []), { prices, now: NOW });
  assert.deepEqual(row.missing, ["usage artifact"]);
  assert.equal(row.cost.usd, null);
  assert.equal(row.cost.basis, "unknown: no usage artifact");
  assert.match(markdownTable([row]), /#49: missing usage artifact/);
});

test("a baseline makes the row carry the judge's pair inputs", () => {
  const row = scoreObjective(cleanMerge(42, usage("claude")), { prices, baseline: "main~1", now: NOW });
  assert.equal(row.quality.status, "pending");
  assert.equal(row.quality.candidate.ref, "merge10000");
  assert.equal(row.quality.baseline.ref, "main~1");
  assert.match(row.quality.judge.command, /bench\/judge\.mjs --repo .* --a merge10000 --b main~1/);
  assert.match(row.quality.judge.gradeAuto, /grade-auto\.mjs .* --commit merge10000 --base base0000 /, "the auto-grader takes the PR's own base, never the judge's rival ref");
  assert.equal(row.quality.read, "unread");
  assert.equal(scoreObjective(cleanMerge(42, usage("claude")), { prices, read: "ok", now: NOW }).quality.read, "ok");
});

test("collect over a snapshot gives the fixture back, and score.mjs --replay writes the table, the JSON and the standing scorecard", async () => {
  const fixture = cleanMerge(42, usage("claude"));
  const snapshot = snapshotOf(fixture);
  const collected = await collectObjective(snapshotApi(snapshot), REPO, 42, { usage: usage("claude") });
  assert.equal(collected.pulls.length, 1);
  assert.equal(collected.pulls[0].merged_by.login, "acme-factory[bot]");
  assert.equal(collected.jobs.length, 2);
  assert.equal(collected.harness, "claude");
  const rowA = scoreObjective(collected, { prices, now: NOW });
  const rowB = scoreObjective(fixture, { prices, now: NOW });
  assert.equal(rowA.walkAway.value, true);
  assert.equal(rowA.runnerMinutes, rowB.runnerMinutes);

  const dir = mkdtempSync(join(tmpdir(), "factory-bench-test-"));
  const file = join(dir, "snapshot.json");
  writeFileSync(file, JSON.stringify(snapshot));
  const standing = join(dir, "scorecard.json");
  writeFileSync(standing, JSON.stringify({ version: 1, rows: [{ repository: REPO, issue: 7, walkAway: { value: true } }, { repository: REPO, issue: 42, walkAway: { value: false } }] }));
  const out = execFileSync("node", [join(BENCH, "score.mjs"), "--replay", file, "--usage", join(USAGE, "claude"), "--out", join(dir, "rows.json"), "--append", standing], { encoding: "utf8", cwd: dir });
  assert.match(out, /^\| Issue \| Exit \| Walk-away \|/);
  assert.match(out, /^\| Issue \| Exit \| Walk-away \| Walk-away \(asked only\) \| Asked \/ unprompted \| Quality \|/);
  assert.match(out, /\| #42 \| merged \| yes \| yes \| 0 \/ 0 \| pending \| 0 \| \$7\.43 \(201k in \/ 2700k cached \/ 0k written \/ 50k out\) \| usd \|/);
  assert.match(out, /^Walk-away: 1 of 1 Objective\(s\) \(1 merged\) with no human input; 1 of 1 counting only input Factory asked for\. Interventions: 0 asked for \(Question, Blocked notice, review request\), 0 unprompted\.$/m);
  const rows = JSON.parse(read(join(dir, "rows.json"))).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].issue, 42);
  const card = JSON.parse(read(standing));
  assert.deepEqual(card.rows.map((r) => r.issue), [7, 42]);
  assert.equal(card.rows[1].walkAway.value, true); // replaced, not duplicated
  assert.equal(card.rows[0].walkAway.value, true); // kept
});

test("score.mjs refuses a bad invocation with exit 64", () => {
  let code = 0;
  try {
    execFileSync("node", [join(BENCH, "score.mjs"), "--repo", "acme/widgets"], { encoding: "utf8", stdio: "pipe" });
  } catch (error) {
    code = error.status;
    assert.match(String(error.stderr), /--issue N/);
  }
  assert.equal(code, 64);
});

test("labelTime: a Running label before a recovery relabel is the clock", async () => {
  const { labelTime } = await import("../lib/objective.mjs");
  const timeline = [
    { event: "labeled", label: { name: "factory:objective" }, created_at: "2026-10-26T04:00:00Z" },
    { event: "labeled", label: { name: "factory:running" }, created_at: "2026-11-05T17:50:00Z" },
    { event: "labeled", label: { name: "factory:question" }, created_at: "2026-11-05T19:54:00Z" },
    { event: "labeled", label: { name: "factory:objective" }, created_at: "2026-11-05T20:29:48Z" },
  ];
  assert.equal(labelTime({}, timeline, "factory:objective", "2026-11-05T17:00:00Z"), "2026-11-05T17:50:00Z");
  assert.equal(labelTime({}, timeline, "factory:objective", null), "2026-10-26T04:00:00Z");
});

test("waitingMinutes and decisionsOf: queue and human-turn time apart from working time; one person's burst is one decision", async () => {
  const { waitingMinutes, decisionsOf } = await import("../lib/objective.mjs");
  const t = [
    { event: "labeled", label: { name: "factory:objective" }, created_at: "2026-11-05T09:40:00Z" },
    { event: "labeled", label: { name: "factory:running" }, created_at: "2026-11-05T10:00:00Z" },
    { event: "labeled", label: { name: "factory:question" }, created_at: "2026-11-05T11:00:00Z" },
    { event: "labeled", label: { name: "factory:running" }, created_at: "2026-11-05T12:00:00Z" },
    { event: "labeled", label: { name: "factory:in-review" }, created_at: "2026-11-05T12:30:00Z" },
  ];
  const w = waitingMinutes(t, "2026-11-05T09:40:00Z", "2026-11-05T13:00:00Z");
  assert.deepEqual(w, { minutes: 80, basis: "waiting: queue, question" });
  assert.equal(waitingMinutes(t, "2026-11-05T09:40:00Z", null).minutes, null);
  const acts = [
    { at: "2026-11-05T11:05:00Z", by: "kirk", kind: "body edit" },
    { at: "2026-11-05T11:06:00Z", by: "kirk", kind: "unlabeled factory:objective" },
    { at: "2026-11-05T11:06:10Z", by: "kirk", kind: "labeled factory:objective" },
    { at: "2026-11-05T11:08:00Z", by: "kirk", kind: "comment" },
    { at: "2026-11-05T12:40:00Z", by: "kirk", kind: "comment" },
  ];
  assert.equal(decisionsOf(acts), 2);
  assert.equal(decisionsOf([]), 0);
});

test("humanActions: board bookkeeping and Factory-marker comments are not human actions", async () => {
  const collected = {
    issue: { number: 9 },
    issueTimeline: [
      { event: "labeled", label: { name: "factory:objective" }, created_at: "2026-11-06T01:45:23Z", actor: { login: "kirk", type: "User" } },
      { event: "added_to_project_v2", created_at: "2026-11-06T01:45:40Z", actor: { login: "kirk", type: "User" } },
      { event: "project_v2_item_status_changed", created_at: "2026-11-06T01:45:50Z", actor: { login: "kirk", type: "User" } },
      { event: "commented", created_at: "2026-11-06T01:46:00Z", actor: { login: "kirk", type: "User" }, body: "<!-- factory:9:held -->\nHeld on the board." },
      { event: "commented", created_at: "2026-11-06T02:46:00Z", actor: { login: "kirk", type: "User" }, body: "Please also handle the dark theme." },
    ],
    issueComments: [],
    pulls: [],
    pullDetails: {},
  };
  const acts = humanActions(collected, "2026-11-06T01:45:23Z");
  assert.deepEqual(acts.map((a) => a.kind), ["comment"]);
});

test("phaseMinutes: minutes between progress lines go to the earlier line's phase; midnight is crossed; no comment is null", () => {
  const body = (n, lines) => `<!-- factory:${n}:progress:work:1 -->\nFactory work run 1\n${lines.map((l) => `- ${l}`).join("\n")}`;
  const work = body(7, ["23:50Z setup", "23:52Z install", "00:01Z harness claude (claude-opus-5-5) attempt 1", "00:31Z waiting for required checks (quality) on abc1234", "00:45Z validation pass 1 red: required checks quality on abc1234; fix run", "00:55Z waiting for required checks (quality) on def5678", "01:05Z exit: delivered; usd 1.00"]);
  const review = `<!-- factory:7:progress:review:2 -->\nFactory review run 2\n- 01:10Z setup\n- 01:11Z reviewer claude-fable-5-1\n- 01:20Z answer pass: 2 comment(s)\n- 01:24Z exit: delivered; usd 0.50`;
  const p = phaseMinutes([{ body: "<!-- factory:7:plan -->" }, { body: work }, { body: review }], 7);
  assert.deepEqual(p, { runs: 2, firstSetupMinutes: 0, setupMinutes: 11 + 1, modelMinutes: 30 + 10 + 9 + 4, ciWaitMinutes: 14 + 10, otherMinutes: 0, basis: "2 progress comment(s)" });
  assert.equal(phaseMinutes([{ body: "<!-- factory:8:progress:work:1 -->\n- 01:00Z setup" }], 7).runs, 0);
  assert.equal(phaseMinutes([], 7).modelMinutes, null);
  // A local Objective's first stage on a machine: the clone's seconds ride its line, the cold install is its own phase.
  const firstRun = "<!-- factory:7:progress:work:9 -->\n- 10:00Z first-time setup: cloned in 90 s\n- 10:00Z install (first time on this machine)\n- 10:03Z harness\n- 10:13Z exit: delivered";
  const f = phaseMinutes([{ body: firstRun }], 7);
  assert.equal(f.firstSetupMinutes, 1.5 + 3);
  assert.equal(f.setupMinutes, 0);
  assert.equal(f.modelMinutes, 10);
  const row = scoreObjective(cleanMerge(42, usage("claude")), { prices, now: NOW });
  assert.equal(row.phases.runs, 0);
  assert.match(markdownTable([row]), /\| Dispatch s \(max\) \| Slot wait s \| Setup s \(max\) \| Model min \| CI wait min \| Turns \| Runs \| Sessions \| Harness \|/);
});

test("dispatchLatency: each run's pickup against the latest trigger since the previous run; skipped duplicates and Running are not triggers", () => {
  const progress = (stage, id, at, lines) => ({ created_at: at, body: `<!-- factory:7:progress:${stage}:${id} -->\nFactory ${stage} run\n${lines.map((l) => `- ${l}`).join("\n")}` });
  const collected = {
    issue: { created_at: "2026-11-06T08:20:13Z" },
    issueTimeline: [
      { event: "labeled", label: { name: "factory:objective" }, created_at: "2026-11-06T08:20:13Z" },
      { event: "labeled", label: { name: "factory:running" }, created_at: "2026-11-06T08:20:40Z" },
      { event: "commented", body: "<!-- factory:7:local -->", created_at: "2026-11-06T08:20:41Z" },
      { event: "unlabeled", label: { name: "factory:question" }, created_at: "2026-11-06T09:00:00Z" },
    ],
    issueComments: [
      progress("work", 1, "2026-11-06T08:21:02Z", ["08:21Z setup", "08:24Z exit: delivered"]),
      progress("review", 2, "2026-11-06T08:24:19Z", ["08:24Z exit: skipped (ready_for_review is not a review cue)"]),
      progress("review", 3, "2026-11-06T08:24:41Z", ["08:24Z setup", "08:26Z exit: delivered"]),
      progress("work", 4, "2026-11-06T09:20:00Z", ["09:20Z setup"]),
      progress("work", 5, "2026-11-06T09:40:00Z", ["09:40Z setup"]),
    ],
    pullDetails: { 8: { timeline: [{ event: "ready_for_review", created_at: "2026-11-06T08:24:04Z" }, { event: "labeled", label: { name: "factory:review" }, created_at: "2026-11-06T08:24:05Z" }] } },
  };
  const d = dispatchLatency(collected, 7);
  // No launch record and no launching run read: each run is timed from its own trigger, and its slot wait is unknown.
  const own = (stage, seconds) => ({ stage, seconds, slotWaitSeconds: null, from: seconds === null ? null : "own trigger", tickEvent: null });
  assert.deepEqual(d.runs, [own("work", 49), own("review", 36), own("work", 1200), own("work", null)]);
  assert.equal(d.slotWaitSeconds, null);
  assert.equal(d.maxSeconds, 1200);
  assert.equal(d.basis, "3/4 run(s) matched to an event");
  assert.equal(dispatchLatency({ issueComments: [] }, 7).maxSeconds, null);
});

test("activity: turns, harness calls, sessions and run counts come from the artifacts", () => {
  const events = [
    '{"type":"system","subtype":"init","session_id":"s-1"}',
    '{"type":"assistant","session_id":"s-1"}',
    '{"type":"result","session_id":"s-1","num_turns":3,"total_cost_usd":0.1}',
    '{"type":"system","subtype":"init","session_id":"s-1"}',
    '{"type":"result","session_id":"s-1","num_turns":2,"total_cost_usd":0.1}',
  ].join("\n");
  assert.deepEqual(sessionsOf(events), { calls: 2, sessions: 1 });
  assert.equal(sessionsOf('{"type":"thread.started","thread_id":"t-9"}\n{"type":"turn.completed","usage":{"input_tokens":1}}').sessions, 1);
  assert.equal(sessionsOf("not json"), null);
  // Real artifacts are named factory-usage-<issue> and factory-usage-<issue>-review; the fixture dirs are not.
  const both = [...usage("claude").map((r) => ({ ...r, artifact: "factory-usage-48" })), ...usage("review").map((r) => ({ ...r, artifact: "factory-usage-48-review" }))];
  const row = scoreObjective(cleanMerge(48, both), { prices, now: NOW });
  assert.equal(row.activity.workRuns, 1);
  assert.equal(row.activity.reviewRuns, 1);
  assert.equal(row.activity.turns, 87 + (usage("review")[0].turns ?? 0));
  assert.match(markdownTable([row]), /\| Turns \| Runs \| Sessions \| Harness \|/);
  assert.match(markdownTable([row]), /\| 1\+1 \|/);
});

test("interventions: what Factory asked for (Question, Blocked notice, review request) is split from unprompted input; walk-away both ways", () => {
  // A Question answered: Factory's label, its review request and the QUESTION in its PR body all ask; both of the owner's actions answer it.
  const q = scoreObjective(questionAnswered(45, usage("claude")), { prices, now: NOW });
  assert.deepEqual(q.walkAway.interventions.requests.map((r) => r.kind), ["question", "question", "review request"]);
  assert.equal(q.walkAway.interventions.asked, 2);
  assert.equal(q.walkAway.interventions.unprompted, 0);
  assert.equal(q.walkAway.firstHumanAction.asked, "review request");
  assert.equal(q.walkAway.value, false);
  assert.equal(q.walkAway.askedOnly.value, false, "Factory needed a person: a miss both ways");
  assert.match(q.walkAway.askedOnly.reason, /^first asked-for action: comment on PR #103 by maintainer/);

  // An owner's push nobody asked for: a miss on the strict count, a walk-away on the asked-only one.
  const p = scoreObjective(humanPush(43, usage("claude")), { prices, now: NOW });
  assert.equal(p.walkAway.interventions.asked, 0);
  assert.equal(p.walkAway.interventions.unprompted, 1);
  assert.equal(p.walkAway.interventions.firstUnprompted.kind, "push");
  assert.equal(p.walkAway.value, false);
  assert.equal(p.walkAway.askedOnly.value, true);
  assert.equal(p.walkAway.askedOnly.reason, "merged; 1 unprompted human action(s), none asked for");

  // A Blocked card is a miss both ways, whatever came after it.
  const b = scoreObjective(blocked(44, usage("claude")), { prices, now: NOW });
  assert.deepEqual(b.walkAway.interventions.requests.map((r) => r.kind), ["blocked", "blocked"]);
  assert.equal(b.walkAway.askedOnly.value, false);

  // Once Factory picks the Objective up again (its factory:running label), a later note is unprompted again.
  const c = questionAnswered(46);
  c.issueTimeline.push({ event: "labeled", label: { name: "factory:running" }, actor: { login: "acme-factory[bot]", type: "Bot" }, created_at: "2031-03-03T08:31:00Z" });
  c.issueComments.push({ user: { login: "maintainer", type: "User" }, created_at: "2031-03-03T09:30:00Z", body: "Also add a TSV export while you are there." });
  const later = scoreObjective(c, { prices, now: NOW });
  assert.equal(later.walkAway.interventions.asked, 2);
  assert.equal(later.walkAway.interventions.unprompted, 1);
  assert.match(later.walkAway.interventions.firstUnprompted.detail, /TSV/);

  // A person who applies factory:question or factory:blocked by hand asks nothing: only Factory's own labels are requests.
  const h = humanPush(47);
  h.issueTimeline.push({ event: "labeled", label: { name: "factory:blocked" }, actor: { login: "maintainer", type: "User" }, created_at: "2031-03-02T01:30:00Z" });
  assert.deepEqual(factoryRequests(h, "2031-03-02T01:00:00Z"), []);

  // Local mode: Factory posts as the operator's login, so its requests are told apart by its markers and its run windows.
  const local = blocked(48);
  local.issue.labels.push({ name: "factory:local" });
  const op = { login: "maintainer", type: "User" };
  for (const e of local.issueTimeline) if (e.actor?.type === "Bot") e.actor = op;
  for (const cm of local.issueComments) cm.user = op;
  local.issueComments.push({ user: op, created_at: "2031-03-02T01:05:00Z", updated_at: "2031-03-02T04:00:00Z", body: "<!-- factory:48:progress:work:1 -->\nFactory work" });
  local.issueComments.push({ user: op, created_at: "2031-03-02T06:00:00Z", body: "Pushed a fix; re-running." });
  local.issueTimeline.push({ event: "labeled", label: { name: "factory:objective" }, actor: op, created_at: "2031-03-02T06:01:00Z" });
  const reqs = factoryRequests(local, "2031-03-02T01:00:00Z");
  assert.deepEqual(reqs.map((r) => r.kind), ["blocked", "blocked"]);
  const split = splitInterventions(humanActions(local, "2031-03-02T01:00:00Z"), reqs);
  assert.deepEqual(split.map((a) => [a.kind, a.asked]), [["comment", "blocked"], ["labeled factory:objective", "blocked"]]);

  // The table carries both columns and the summary both rates and both counts.
  const md = markdownTable([q, p]);
  assert.match(md, /\| #43 \| merged \| no: first human action: push on PR #101 by maintainer at [^|]+ \| yes \| 0 \/ 1 \|/);
  assert.match(md, /\| #45 \| merged \| no: [^|]+ \| no: first asked-for action: [^|]+ \| 2 \/ 0 \|/);
  assert.equal(summaryLine([q, p]), "Walk-away: 0 of 2 Objective(s) (2 merged) with no human input; 1 of 2 counting only input Factory asked for. Interventions: 2 asked for (Question, Blocked notice, review request), 1 unprompted.");
});

test("cost: a sandbox stage's vendor cost is summed beside the model's, with a total, in the row, the table and the baseline", async () => {
  const rates = { vendor: "vercel", plan: "Pro", region: "iad1", date: "2026-11-08" };
  const work = { harness: "claude", artifact: "factory-usage-50/result.json", usd: 0.26, runs: 1, tokens: { input: 1e5, output: 1e3, cached: 9e4, written: 5e3 }, vendor: { usd: 0.0063, upperBound: false, storedUsd: 0, rates } };
  const review = { harness: "claude", artifact: "factory-usage-50-review/result.json", usd: 0.5, runs: 1, tokens: { input: 1e5, output: 1e3, cached: 9e4, written: 5e3 }, vendor: { usd: 0.21, upperBound: true, storedUsd: 0.0002, rates } };
  const row = scoreObjective(cleanMerge(50, [work, review]), { prices, now: NOW });
  assert.equal(row.cost.usd, 0.76, "the model's dollars stay the harness's");
  assert.equal(row.cost.vendorUsd, 0.2163);
  assert.equal(row.cost.totalUsd, 0.9763);
  assert.equal(row.cost.vendor.parts, 2);
  assert.equal(row.cost.vendor.upperBound, true);
  assert.match(row.cost.vendor.basis, /2 sandbox stage\(s\), 1 at the session's ceiling \(an upper bound\); vercel Pro list rates \(iad1\) read 2026-11-08/);
  const table = markdownTable([row]);
  assert.match(table, /\$0\.76 \([^)]*\) \+ ≤\$0\.2163 sandbox = \$0\.98/);
  assert.match(table, /- #50: sandbox 2 sandbox stage\(s\)/);
  const { baselineOf } = await import("../lib/baseline.mjs");
  const line = baselineOf([row], {});
  assert.equal(line.measures.vendorUsd.median, 0.2163);
  assert.equal(line.measures.totalUsd.median, 0.98);
  // One booking per stage: the same stage's booking carried by two artifacts (a retried launch) counts once.
  const once = { ...work, vendor: { ...work.vendor, claim: "0123456789ab" } };
  const twice = scoreObjective(cleanMerge(52, [once, { ...once, artifact: "factory-usage-52/result.json", usd: null }]), { prices, now: NOW });
  assert.equal(twice.cost.vendorUsd, 0.0063);
  assert.equal(twice.cost.vendor.parts, 1);
  // A runner Objective has no vendor part: its total is its model cost.
  const plain = scoreObjective(cleanMerge(51, usage("claude")), { prices, now: NOW });
  assert.equal(plain.cost.vendor, null);
  assert.equal(plain.cost.vendorUsd, null);
  assert.equal(plain.cost.totalUsd, plain.cost.usd);
});

test("dispatch from the event that started the stage: a work stage that waited for a slot is timed from the tick, the wait reported apart", () => {
  // The record shows the launch: its event time is the entry's `at` less its `latencyMs` (07:01:44.2, a sibling's merge).
  const a = dispatchLatency(waitedRecorded(), 253);
  assert.deepEqual(a.runs, [
    { stage: "work", seconds: 59, slotWaitSeconds: 333, from: "launch record", tickEvent: "pull_request" },
    { stage: "review", seconds: 74, slotWaitSeconds: null, from: "own trigger", tickEvent: null },
  ]);
  assert.equal(a.maxSeconds, 74, "not 392: the label-to-pickup time held the slot wait");
  assert.equal(a.slotWaitSeconds, 333);
  assert.equal(a.basis, "2/2 run(s) matched to an event; 1 waited for a slot");
  // The record lost the work launch: the Actions run that launched it (its progress key) is the tick.
  const b = dispatchLatency(waitedUnrecorded(), 263);
  assert.deepEqual(b.runs, [
    { stage: "work", seconds: 73, slotWaitSeconds: 397, from: "launching run", tickEvent: "pull_request" },
    { stage: "review", seconds: 74, slotWaitSeconds: null, from: "own trigger", tickEvent: null },
  ]);
  // Without the launching run either, the old reading stands, and the wait is unknown rather than zero.
  const c = waitedUnrecorded();
  c.stageRuns = null;
  assert.deepEqual(dispatchLatency(c, 263).runs[0], { stage: "work", seconds: 470, slotWaitSeconds: null, from: "own trigger", tickEvent: null });
  // A free slot: the tick came before the Objective's own label (a sibling's filing), so its own label is the start.
  assert.deepEqual(dispatchLatency(noWait(), 262).runs, [{ stage: "work", seconds: 72, slotWaitSeconds: 0, from: "own trigger", tickEvent: null }]);
  // A tick from the Objective's own kind of event (its label, a comment) is GitHub's delivery lag, never a wait.
  const d = noWait();
  d.issueComments = d.issueComments.filter((x) => !x.body.includes(":sandbox -->"));
  d.stageRuns = { 42578525960: { event: "issues", created_at: "2026-11-09T07:18:48Z" } };
  assert.deepEqual(dispatchLatency(d, 262).runs[0], { stage: "work", seconds: 72, slotWaitSeconds: 0, from: "own trigger", tickEvent: null });
  // Only Factory's own record counts: a person's copy of the marker is not read, nor another App's.
  const self = factoryLogin(waitedRecorded().issueTimeline);
  assert.equal(self, "acme-factory[bot]", "the App that applied factory:running");
  assert.equal(factoryLogin(waitedRecorded().issueTimeline, "Other-App[bot]"), "other-app[bot]", "--app wins");
  const e = waitedRecorded();
  e.issueComments = e.issueComments.map((x) => (x.body.includes(":sandbox -->") ? { ...x, user: { login: "maintainer", type: "User" } } : x));
  assert.deepEqual(launchesOf(e.issueComments, 253, self), []);
  e.issueComments = e.issueComments.map((x) => (x.body.includes(":sandbox -->") ? { ...x, user: { login: "other-ci[bot]", type: "Bot" } } : x));
  assert.deepEqual(launchesOf(e.issueComments, 253, self), []);
  assert.deepEqual(launchesOf(waitedRecorded().issueComments, 253, null), [], "no known Factory login: nothing is Factory's");
  assert.deepEqual(launchesOf(waitedRecorded().issueComments, 253, self).map((l) => l.stage), ["work", "review"]);
  // A launch entry with the launcher's `eventAt` is read as written, not as `at` less `latencyMs`.
  const f = waitedRecorded();
  f.issueComments = f.issueComments.map((x) => (x.body.includes(":sandbox -->") ? { ...x, body: x.body.replace('"latencyMs":49946,', '"eventAt":"2026-11-09T07:01:44.000Z","latencyMs":49946,') } : x));
  assert.equal(launchesOf(f.issueComments, 253, self)[0].at, Date.parse("2026-11-09T07:01:44.000Z"));
  assert.equal(launchesOf(waitedRecorded().issueComments, 253, self)[0].at, Date.parse("2026-11-09T07:02:34.147Z") - 49946);
});

test("slot wait only for a tick that freed a slot: a cron recovery or the Objective's own stage end stays dispatch", () => {
  // The cron picked the Objective up (its own `issues` dispatcher run lost or replaced): no slot was full, so the
  // ten minutes are dispatch, the 60 s bar sees them, and the tick is named.
  const cron = noWait();
  cron.issueTimeline = [{ event: "labeled", label: { name: "factory:objective" }, actor: { login: "maintainer", type: "User" }, created_at: "2026-11-09T07:00:00Z" }, { event: "labeled", label: { name: "factory:running" }, actor: { login: "acme-factory[bot]", type: "Bot" }, created_at: "2026-11-09T07:10:30Z" }];
  cron.issue.created_at = "2026-11-09T06:59:59Z";
  cron.issueComments = cron.issueComments.filter((x) => !x.body.includes(":sandbox -->")).map((x) => ({ ...x, created_at: "2026-11-09T07:11:00Z" }));
  cron.stageRuns = { 42578525960: { event: "schedule", created_at: "2026-11-09T07:10:02Z" } };
  const c = dispatchLatency(cron, 262);
  assert.deepEqual(c.runs, [{ stage: "work", seconds: 660, slotWaitSeconds: 0, from: "own trigger", tickEvent: "schedule" }]);
  assert.equal(c.slotWaitSeconds, 0);
  assert.equal(c.maxSeconds, 660);
  assert.equal(c.basis, "1/1 run(s) matched to an event; 1 started by a later tick that freed no slot (schedule)");

  // A fix pass started by its own review's end holds no slot wait, on the sandbox path (the review's stage-end
  // repository_dispatch, in the record) and on the runner path (the review job's workflow_dispatch tick).
  const fix = (tick) => {
    const o = waitedRecorded();
    o.issueTimeline.push({ event: "unlabeled", label: { name: "factory:in-review" }, actor: { login: "acme-factory[bot]", type: "Bot" }, created_at: "2026-11-09T07:09:30Z" });
    o.issueComments.push({ id: 9, user: { login: "acme-factory[bot]", type: "Bot" }, created_at: "2026-11-09T07:10:40Z", body: "<!-- factory:253:progress:work:42577500000-aa11bb22cc33 -->\nFactory work run.\n- 07:10Z setup" });
    tick(o);
    return dispatchLatency(o, 253).runs.at(-1);
  };
  const sandbox = fix((o) => {
    o.issueComments = o.issueComments.map((x) => (x.body.includes(":sandbox -->") ? { ...x, body: x.body.replace('"cue":"asked-1794207923"}]', '"cue":"asked-1794207923"},{"stage":"work","event":"repository_dispatch","eventAt":"2026-11-09T07:09:41Z","ok":true,"latencyMs":50000,"found":true,"run":"42577500000","at":"2026-11-09T07:10:31Z"}]') } : x));
  });
  assert.deepEqual(sandbox, { stage: "work", seconds: 70, slotWaitSeconds: 0, from: "own trigger", tickEvent: "repository_dispatch" });
  const runner = fix((o) => {
    o.stageRuns = { 42577500000: { event: "workflow_dispatch", created_at: "2026-11-09T07:09:50Z" } };
  });
  assert.deepEqual(runner, { stage: "work", seconds: 70, slotWaitSeconds: 0, from: "own trigger", tickEvent: "workflow_dispatch" });

  // Another Objective's job end (a workflow_dispatch tick) after a plain wait in the queue is a slot wait.
  const other = waitedUnrecorded();
  other.stageRuns = { 42579245832: { event: "workflow_dispatch", created_at: "2026-11-09T07:25:26Z" } };
  assert.equal(dispatchLatency(other, 263).runs[0].slotWaitSeconds, 397);
  // A person's progress marker is never a launching run: collect.mjs reads ids from Factory's comments only.
  assert.equal(bySelf({ user: { login: "maintainer" } }, "acme-factory[bot]"), false);
  assert.equal(bySelf({ user: { login: "Acme-Factory[bot]" } }, "acme-factory[bot]"), true);
});

test("no slot wait for an Objective picked and sent back before the tick: a transient failed start stays dispatch", () => {
  // #253's drill shape, but the dispatcher picked it at once (a slot was free): Running at 06:56:40, its sandbox start
  // failed with a transient code at 06:57:00 and the launcher sent it back to Queued (Running off at 06:57:01). Nothing
  // re-ticked; the sibling's merge at 07:01:44 started it. The 392 s are dispatch (the 60 s bar sees them), not a wait.
  const APP = { login: "acme-factory[bot]", type: "Bot" };
  const failedEntry = '{"stage":"work","event":"issues","ok":false,"found":false,"run":"42576100000","at":"2026-11-09T06:57:00.000Z","cue":"stint-1794207400"},';
  const requeued = ({ label = true, entry = true } = {}) => {
    const o = waitedRecorded();
    if (label) o.issueTimeline.splice(1, 0, { event: "labeled", label: { name: "factory:running" }, actor: APP, created_at: "2026-11-09T06:56:40Z" }, { event: "unlabeled", label: { name: "factory:running" }, actor: APP, created_at: "2026-11-09T06:57:01Z" });
    if (entry) o.issueComments = o.issueComments.map((x) => (x.body.includes(":sandbox -->") ? { ...x, body: x.body.replace('"launches":[', `"launches":[${failedEntry}`) } : x));
    return dispatchLatency(o, 253);
  };
  const both = requeued();
  assert.deepEqual(both.runs[0], { stage: "work", seconds: 392, slotWaitSeconds: 0, from: "own trigger", tickEvent: "requeued" });
  assert.equal(both.slotWaitSeconds, 0);
  assert.equal(both.maxSeconds, 392);
  assert.equal(both.basis, "2/2 run(s) matched to an event; 1 started by a later tick that freed no slot (requeued)");
  // Either signal alone: the Running label that came off (a record that lost the entry), or the failed start (a
  // launch-event start that failed and ticked the dispatcher itself, its Running label never shown).
  assert.equal(requeued({ entry: false }).runs[0].tickEvent, "requeued");
  assert.equal(requeued({ label: false }).runs[0].tickEvent, "requeued");
  assert.deepEqual(failedStartsOf(waitedRecorded().issueComments, 253, "acme-factory[bot]"), []);
  // The real waits stay: #253's own Running label came after the tick, and a person's Running label is not a pick.
  assert.equal(dispatchLatency(waitedRecorded(), 253).runs[0].slotWaitSeconds, 333);
  const person = waitedRecorded();
  person.issueTimeline.splice(1, 0, { event: "labeled", label: { name: "factory:running" }, actor: { login: "maintainer", type: "User" }, created_at: "2026-11-09T06:56:40Z" }, { event: "unlabeled", label: { name: "factory:running" }, actor: { login: "maintainer", type: "User" }, created_at: "2026-11-09T06:57:01Z" });
  assert.equal(dispatchLatency(person, 253).runs[0].slotWaitSeconds, 333);
  // A failed start of another stage (the review) is not this work stage's.
  const review = waitedRecorded();
  review.issueComments = review.issueComments.map((x) => (x.body.includes(":sandbox -->") ? { ...x, body: x.body.replace('"launches":[', `"launches":[${failedEntry.replace('"stage":"work"', '"stage":"review"')}`) } : x));
  assert.equal(dispatchLatency(review, 253).runs[0].slotWaitSeconds, 333);
});

test("a lost launch still Running when a later tick relaunched it, and an answered Question's own tick, are no slot wait", () => {
  const APP = { login: "acme-factory[bot]", type: "Bot" };
  const OWNER = { login: "maintainer", type: "User" };
  const lab = (name, actor, at, event = "labeled") => ({ event, label: { name }, actor, created_at: at });
  const rec = (launches) => ({ id: 1, user: APP, created_at: "2026-11-09T06:59:59Z", body: `<!-- factory:9:sandbox -->\n<!-- factory:sandbox ${JSON.stringify({ vendor: "vercel", stage: "work", state: "running", launches })} -->` });
  const prog = (id, run, at) => ({ id, user: APP, created_at: at, body: `<!-- factory:9:progress:work:${run}-abc -->\n- ${at.slice(11, 16)}Z setup` });
  const objective = (timeline, comments) => ({ issue: { number: 9, created_at: "2026-11-09T06:59:00Z" }, issueTimeline: timeline, issueComments: comments, pullDetails: {}, stageRuns: {} });
  const first = { stage: "work", event: "issues", eventAt: "2026-11-09T07:00:01Z", ok: true, latencyMs: 40000, run: "100", at: "2026-11-09T07:00:41Z" };

  // Picked at 07:00:20, the launch lost with no record entry and Running left on; a sibling's merge at 07:20:00 ticked
  // the dispatcher, whose sweep launched it again. The slot was held throughout: 1250 s of dispatch, no slot wait.
  const lost = dispatchLatency(objective([lab("factory:objective", OWNER, "2026-11-09T07:00:00Z"), lab("factory:running", APP, "2026-11-09T07:00:20Z")], [rec([{ stage: "work", event: "pull_request", eventAt: "2026-11-09T07:20:00Z", ok: true, latencyMs: 40000, run: "200", at: "2026-11-09T07:20:40Z" }]), prog(2, "200", "2026-11-09T07:20:50Z")]), 9);
  assert.deepEqual(lost.runs, [{ stage: "work", seconds: 1250, slotWaitSeconds: 0, from: "own trigger", tickEvent: "relaunched" }]);
  assert.equal(lost.basis, "1/1 run(s) matched to an event; 1 started by a later tick that freed no slot (relaunched)");
  // A real wait: Running only after the tick, so the 600 s stay a slot wait.
  const waited = dispatchLatency(objective([lab("factory:objective", OWNER, "2026-11-09T07:00:00Z"), lab("factory:running", APP, "2026-11-09T07:10:20Z")], [rec([{ stage: "work", event: "pull_request", eventAt: "2026-11-09T07:10:00Z", ok: true, latencyMs: 40000, run: "200", at: "2026-11-09T07:10:40Z" }]), prog(2, "200", "2026-11-09T07:10:50Z")]), 9);
  assert.deepEqual(waited.runs, [{ stage: "work", seconds: 50, slotWaitSeconds: 600, from: "launch record", tickEvent: "pull_request" }]);

  // An answered Question on the sandbox path: the person's comment at 07:30:00, the launcher's requeue takes
  // factory:question off at 07:30:20 and its step ticks the dispatcher (workflow_dispatch) at 07:30:25. That tick is
  // the Objective's own: timed from the unlabel, no slot wait.
  const answered = (unlabelActor = APP, comment = true) => {
    const timeline = [lab("factory:objective", OWNER, "2026-11-09T07:00:00Z"), lab("factory:running", APP, "2026-11-09T07:00:20Z"), lab("factory:running", APP, "2026-11-09T07:05:00Z", "unlabeled"), lab("factory:question", APP, "2026-11-09T07:05:00Z")];
    if (comment) timeline.push({ event: "commented", user: OWNER, actor: OWNER, body: "use X", created_at: "2026-11-09T07:30:00Z" });
    timeline.push(lab("factory:question", unlabelActor, "2026-11-09T07:30:20Z", "unlabeled"), lab("factory:running", APP, "2026-11-09T07:30:40Z"));
    const tick = { stage: "work", event: "workflow_dispatch", eventAt: "2026-11-09T07:30:25Z", ok: true, latencyMs: 30000, run: "400", at: "2026-11-09T07:30:55Z" };
    return dispatchLatency(objective(timeline, [rec([first, tick]), prog(2, "100", "2026-11-09T07:00:50Z"), prog(3, "400", "2026-11-09T07:31:00Z")]), 9).runs[1];
  };
  assert.deepEqual(answered(), { stage: "work", seconds: 40, slotWaitSeconds: 0, from: "own trigger", tickEvent: "workflow_dispatch" });
  // A person who took the label off after answering: still the answer's own tick.
  assert.equal(answered(OWNER).slotWaitSeconds, 0);
  // A person's unlabel with no answer, then another Objective's job end ticking: a slot wait.
  assert.equal(answered(OWNER, false).slotWaitSeconds, 5);
});

test("after a review, a workflow_dispatch tick is its own only shortly after the review's last write", () => {
  // #253 on the runner path: the review exited at 07:09Z, In review came off at 07:09:30, and a fix pass started.
  const fix = (tickAt, updated = null) => {
    const o = waitedRecorded();
    o.issueComments = o.issueComments.filter((x) => !x.body.includes(":sandbox -->")).map((x) => (updated && x.body.includes(":progress:review:") ? { ...x, updated_at: updated } : x));
    o.issueTimeline.push({ event: "unlabeled", label: { name: "factory:in-review" }, actor: { login: "acme-factory[bot]", type: "Bot" }, created_at: "2026-11-09T07:09:30Z" });
    o.issueComments.push({ id: 9, user: { login: "acme-factory[bot]", type: "Bot" }, created_at: "2026-11-09T07:26:00Z", body: "<!-- factory:253:progress:work:42577500000-aa11bb22cc33 -->\nFactory work run.\n- 07:26Z setup" });
    o.stageRuns = { 42576687052: { event: "pull_request", created_at: "2026-11-09T07:01:44Z" }, 42577500000: { event: "workflow_dispatch", created_at: tickAt } };
    return dispatchLatency(o, 253).runs.at(-1);
  };
  // The review job's own tick, seconds after its exit line: the fix pass is timed from In review coming off.
  assert.deepEqual(fix("2026-11-09T07:10:20Z"), { stage: "work", seconds: 990, slotWaitSeconds: 0, from: "own trigger", tickEvent: "workflow_dispatch" });
  // Its own tick found both slots taken; another Objective's job end at 07:25:26 started the fix pass: a slot wait.
  assert.deepEqual(fix("2026-11-09T07:25:26Z"), { stage: "work", seconds: 34, slotWaitSeconds: 956, from: "launching run", tickEvent: "workflow_dispatch" });
  // The comment's updated_at, where the API gives it, is the exit to the second: 07:09:12 + 5 min bounds the own tick.
  assert.equal(fix("2026-11-09T07:14:10Z", "2026-11-09T07:09:12Z").slotWaitSeconds, 0);
  assert.equal(fix("2026-11-09T07:14:20Z", "2026-11-09T07:09:12Z").slotWaitSeconds, 290);
  assert.equal(fix("2026-11-09T07:14:20Z").slotWaitSeconds, 0, "without updated_at the exit line's minute runs to 07:09:59");
  // The last write's time: updated_at, else the end of the last line's minute, across midnight UTC.
  assert.equal(lastWrite({ created_at: "2026-11-09T23:58:40Z", body: "- 23:58Z setup\n- 00:03Z exit: delivered" }), Date.parse("2026-11-10T00:03:59.999Z"));
  assert.equal(lastWrite({ created_at: "2026-11-09T07:06:40Z", updated_at: "2026-11-09T07:09:12Z", body: "- 07:06Z setup" }), Date.parse("2026-11-09T07:09:12Z"));
  assert.equal(lastWrite({ created_at: "2026-11-09T07:06:40Z", body: "no lines" }), null);
});

test("setup in seconds per run: progress comment to the usage record's harness start, not minute-rounded lines", () => {
  assert.deepEqual(setupSeconds(waitedRecorded(), 253), { runs: [{ stage: "work", seconds: 22 }, { stage: "review", seconds: 21 }], maxSeconds: 22, basis: "2/2 run(s) matched to a usage record's harness start" });
  assert.deepEqual(setupSeconds(waitedUnrecorded(), 263).runs, [{ stage: "work", seconds: 26 }, { stage: "review", seconds: 21 }]);
  // A run whose record is missing has no setup; the next run's harness start is never borrowed.
  const c = waitedRecorded();
  c.usage = [c.usage[1]];
  assert.deepEqual(setupSeconds(c, 253).runs, [{ stage: "work", seconds: null }, { stage: "review", seconds: 21 }]);
  const row = scoreObjective(waitedRecorded(), { prices, now: NOW });
  assert.equal(row.phases.setupSeconds, 22);
  assert.equal(row.phases.setupMinutes, 1, "the minute-rounded lines read a whole minute for 22 s and 21 s");
  assert.equal(row.dispatch.slotWaitSeconds, 333);
  assert.match(markdownTable([row]), /\| 74 \| 333 \| 22 \|/);
});

test("--usage: an issue with no directory of its own has no usage, never the other issues'", async () => {
  const dir = mkdtempSync(join(tmpdir(), "factory-bench-usage-"));
  const isDir = (f) => statSync(f).isDirectory();
  mkdirSync(join(dir, "42", "factory-usage-42"), { recursive: true });
  cpSync(join(USAGE, "claude", "result.json"), join(dir, "42", "factory-usage-42", "result.json"));
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

/** #295's shape: reviewed and enqueued, dropped by the queue, idle until an unrelated tick enqueued it again. */
function queueDropped(number = 46) {
  const c = cleanMerge(number);
  const APP = { login: "acme-factory[bot]", type: "Bot" };
  const QUEUE = { login: "github-merge-queue[bot]", type: "Bot" };
  c.pulls[0].merged_at = "2031-03-02T05:00:00Z";
  c.issue.closed_at = "2031-03-02T05:00:00Z";
  for (const e of c.issueTimeline) if (e.created_at === "2031-03-02T03:30:00Z") e.created_at = "2031-03-02T05:00:00Z";
  c.pullDetails[100].timeline = [
    { event: "labeled", label: { name: "factory:review" }, actor: APP, created_at: "2031-03-02T02:11:00Z" },
    { event: "added_to_merge_queue", actor: APP, created_at: "2031-03-02T03:00:00Z" },
    { event: "removed_from_merge_queue", actor: QUEUE, created_at: "2031-03-02T04:00:00Z" },
    { event: "added_to_merge_queue", actor: APP, created_at: "2031-03-02T04:55:00Z" },
    { event: "merged", actor: APP, created_at: "2031-03-02T05:00:00Z" },
  ];
  // The sandbox record is rewritten when a stage is booked, after the merge too: its last edit is not Factory acting.
  c.issueComments.push({ user: APP, created_at: "2031-03-02T01:06:00Z", updated_at: "2031-03-02T05:01:00Z", body: `<!-- factory:${number}:sandbox -->\n<!-- factory:sandbox {} -->` });
  return c;
}

test("a merge idle past the stall threshold after Factory's last act is a stall, not a walk-away, with how long it sat", async () => {
  const { idleStall, STALL_MINUTES } = await import("../lib/objective.mjs");
  assert.equal(STALL_MINUTES, 60);
  const row = scoreObjective(queueDropped(), { prices, now: NOW });
  assert.equal(row.exit, "merged");
  assert.equal(row.walkAway.value, false);
  assert.equal(row.walkAway.humanActions, 0);
  // The queue's drop is not Factory's act: idle from the enqueue at 03:00 to the re-enqueue at 04:55.
  assert.deepEqual(row.walkAway.stall, { minutes: 115, from: "2031-03-02T03:00:00Z", until: "2031-03-02T04:55:00Z", thresholdMinutes: 60 });
  assert.equal(row.walkAway.longestIdleMinutes, 115);
  assert.equal(row.walkAway.reason, "stalled 115 min after Factory's last action (2031-03-02T03:00:00Z to 2031-03-02T04:55:00Z; threshold 60 min); no human action");
  assert.equal(row.walkAway.askedOnly.value, false);
  assert.deepEqual(row.operator, { minutes: 0, basis: "no human action (stalled)" });
  assert.match(markdownTable([row]), /\| #46 \| merged \| no: stalled 115 min after Factory's last action/);
  assert.match(summaryLine([row, scoreObjective(cleanMerge(42), { prices, now: NOW })]), /^Walk-away: 1 of 2 .* Stalled: #46 115 min idle after Factory's last action \(threshold 60 min\)\.$/);
  // The threshold is named: above the idle span it is a clean walk-away, and the span is still on the row.
  const lenient = scoreObjective(queueDropped(), { prices, now: NOW, stallMinutes: 120 });
  assert.equal(lenient.walkAway.value, true);
  assert.equal(lenient.walkAway.stall, null);
  assert.equal(lenient.walkAway.longestIdleMinutes, 115);
  // A clean merge: the longest idle is the review's end (02:58) to the merge (03:30).
  const clean = scoreObjective(cleanMerge(42), { prices, now: NOW });
  assert.equal(clean.walkAway.value, true);
  assert.equal(clean.walkAway.longestIdleMinutes, 32);
  // Time a person had the turn (an open Question) is not idle, nor is an Objective that never merged.
  const q = questionAnswered(45);
  assert.equal(idleStall(q, "2031-03-02T01:00:00Z", q.pulls[0].merged_at, { requests: factoryRequests(q, "2031-03-02T01:00:00Z") }).stalled, false);
  assert.equal(idleStall(blocked(44), "2031-03-02T01:00:00Z", null), null);
  // Another login's act is not Factory's: a person relabelling inside the gap does not shorten it.
  const c = queueDropped();
  c.issueTimeline.push({ event: "labeled", label: { name: "P2" }, actor: { login: "maintainer", type: "User" }, created_at: "2031-03-02T04:30:00Z" });
  assert.equal(idleStall(c, "2031-03-02T01:00:00Z", c.pulls[0].merged_at).minutes, 115);
});

test("a stage that died and was booked late by the sweep is idle from its own last write, not its comment's last edit", async () => {
  const { idleStall } = await import("../lib/objective.mjs");
  const { stageLastWrite } = await import("../lib/phases.mjs");
  const APP = { login: "acme-factory[bot]", type: "Bot" };
  const c = cleanMerge(48);
  c.pulls[0].merged_at = "2031-03-02T05:00:00Z";
  for (const e of [...c.issueTimeline, ...c.pullDetails[100].timeline]) if (e.created_at === "2031-03-02T03:30:00Z") e.created_at = "2031-03-02T05:00:00Z";
  // A sandbox work stage started 03:00 and last wrote ten minutes in; the sweep booked its cost into the comment at
  // 04:50 (the header stays) and the dispatcher picked the Objective up again.
  const progress = { user: APP, created_at: "2031-03-02T03:00:20Z", updated_at: "2031-03-02T04:50:00Z", body: "<!-- factory:48:progress:work:9-0123456789ab -->\nFactory work run 9-0123456789ab: started 03:00Z, 10 min at the last line.\n- 03:00Z setup\n- 03:10Z harness\n- 04:50Z sandbox stopped: $0.01\n<!-- factory:spend 0.5 -->" };
  c.issueComments.push(progress);
  c.issueTimeline.push({ event: "labeled", label: { name: "factory:running" }, actor: APP, created_at: "2031-03-02T04:50:00Z" });
  assert.equal(new Date(stageLastWrite(progress)).toISOString(), "2031-03-02T03:11:30.000Z");
  assert.deepEqual(idleStall(c, "2031-03-02T01:00:00Z", c.pulls[0].merged_at), { minutes: 98.5, from: "2031-03-02T03:11:30Z", until: "2031-03-02T04:50:00Z", thresholdMinutes: 60, stalled: true });
  // A stage that started before midnight UTC and first wrote after it; a comment with no header falls back to its last edit.
  assert.equal(new Date(stageLastWrite({ created_at: "2031-03-03T00:00:10Z", updated_at: "2031-03-03T00:30:00Z", body: "<!-- x -->\nFactory review run 7: started 23:59Z, 20 min at the last line." })).toISOString(), "2031-03-03T00:20:30.000Z");
  assert.equal(new Date(stageLastWrite({ created_at: "2031-03-02T03:00:00Z", updated_at: "2031-03-02T04:00:00Z", body: "<!-- x -->\nFactory work run abc: the stage left no progress of its own." })).toISOString(), "2031-03-02T04:00:00.000Z");
  // The header never stretches a span past the comment's last edit.
  assert.equal(new Date(stageLastWrite({ created_at: "2031-03-02T03:00:20Z", updated_at: "2031-03-02T03:05:00Z", body: "Factory work run 9: started 03:00Z, 5 min at the last line." })).toISOString(), "2031-03-02T03:05:00.000Z");
});

test("usage still owed: the latest stage of each kind Factory ran needs its artifact, created at or after the stage started", async () => {
  const { usagePending } = await import("../lib/collect.mjs");
  const APP = { login: "acme-factory[bot]", type: "Bot" };
  const self = "acme-factory[bot]";
  const work = { user: APP, created_at: "2031-03-02T01:10:00Z", body: "<!-- factory:47:progress:work:123-abc -->\nFactory work run." };
  const review = { user: APP, created_at: "2031-03-02T02:15:00Z", body: "<!-- factory:47:progress:review:124-def -->\nFactory review run." };
  const art = (name, created_at) => ({ id: 1, name, created_at, expired: false, workflow_run: 9 });
  // Blocked before any stage ran: nothing is owed, so the drill scores it at once.
  assert.deepEqual(usagePending(47, [], [], { self }), []);
  // Blocked by a stage whose upload lands after the label: owed until the artifact exists.
  assert.deepEqual(usagePending(47, [work], [], { self }), ["factory-usage-47"]);
  assert.deepEqual(usagePending(47, [work], [art("factory-usage-47", "2031-03-02T01:40:03Z")], { self }), []);
  // An earlier run's artifact of the same name does not stand in for the last stage's.
  const fix = { ...work, created_at: "2031-03-02T03:00:00Z" };
  assert.deepEqual(usagePending(47, [work, review, fix], [art("factory-usage-47", "2031-03-02T01:40:00Z"), art("factory-usage-47-review", "2031-03-02T02:20:00Z")], { self }), ["factory-usage-47"]);
  assert.deepEqual(usagePending(47, [work, review], [art("factory-usage-47", "2031-03-02T01:40:00Z")], { self }), ["factory-usage-47-review"]);
  // A pasted marker is not Factory's stage, nor is another issue's.
  assert.deepEqual(usagePending(47, [{ ...work, user: { login: "writer", type: "User" } }], [], { self }), []);
  assert.deepEqual(usagePending(48, [work], [], { self }), []);
});

test("score.mjs refuses a --usage directory that does not exist, with exit 64 and no stack", () => {
  let code = 0;
  try {
    execFileSync("node", [join(BENCH, "score.mjs"), "--repo", "acme/widgets", "--issue", "1", "--usage", join(tmpdir(), "factory-no-such-usage-dir")], { encoding: "utf8", stdio: "pipe" });
  } catch (error) {
    code = error.status;
    assert.match(String(error.stderr), /^--usage: .* is not a directory$/m);
  }
  assert.equal(code, 64);
});

test("the drill's usage wait: a Blocked Objective's artifact that lands after the label is waited for and fetched; one that never comes is named; a running one's finished stages are fetched", async () => {
  const { awaitUsage } = await import("../lib/collect.mjs");
  const APP = { login: "acme-factory[bot]", type: "Bot" };
  const timeline = [{ event: "labeled", label: { name: "factory:running" }, actor: APP, created_at: "2031-03-02T01:05:00Z" }, { event: "labeled", label: { name: "factory:blocked" }, actor: APP, created_at: "2031-03-02T01:30:00Z" }];
  const work = (n) => ({ user: APP, created_at: "2031-03-02T01:06:00Z", body: `<!-- factory:${n}:progress:work:77-abc -->\nFactory work run.` });
  const review49 = { user: APP, created_at: "2031-03-02T01:25:00Z", body: "<!-- factory:49:progress:review:80-def -->\nFactory review run." };
  let polls = 0;
  const answers = (path) => {
    const n = Number(/issues\/(\d+)\//.exec(path)?.[1] ?? /factory-usage-(\d+)/.exec(path)?.[1]);
    if (path.includes("/timeline")) return timeline;
    if (path.includes("/comments")) return n === 44 ? [] : n === 49 ? [work(n), review49] : [work(n)];
    if (path.includes("actions/artifacts")) {
      // #47's upload lands on the second poll; #48's never does; #49 is still in review at the deadline, its work uploaded.
      if (n === 49 && /factory-usage-49&/.test(path)) return [{ artifacts: [{ id: 9, name: "factory-usage-49", created_at: "2031-03-02T01:20:00Z", expired: false, workflow_run: { id: 79 } }] }];
      if (n === 47 && /factory-usage-47&/.test(path) && polls >= 2) return [{ artifacts: [{ id: 5, name: "factory-usage-47", created_at: "2031-03-02T01:30:03Z", expired: false, workflow_run: { id: 77 } }] }];
      return [{ artifacts: [] }];
    }
    throw Object.assign(new Error(`no answer for ${path}`), { status: 404 });
  };
  const api = async (path) => {
    if (path.includes("/timeline") && path.includes("/47/")) polls += 1;
    return answers(path);
  };
  let clock = 0;
  const fetched = [];
  const logs = [];
  const { missing } = await awaitUsage(api, REPO, [44, 47, 48, 49], { ended: [44, 47, 48], waitMs: 60_000, pollMs: 15_000, now: () => clock, sleep: async (ms) => { clock += ms; }, fetch: async (issue, a) => fetched.push([issue, a.name, a.workflow_run]), log: (l) => logs.push(l) });
  // #49 is not waited for (the log never names it), but its finished work stage's usage is fetched and its review named.
  assert.deepEqual(fetched, [[47, "factory-usage-47", 77], [49, "factory-usage-49", 79]]);
  assert.deepEqual(missing, { 48: ["factory-usage-48"], 49: ["factory-usage-49-review (still running)"] });
  assert.match(logs[0], /^waiting for usage: #47 factory-usage-47; #48 factory-usage-48$/);
  assert.equal(clock, 60_000, "the wait is bounded");
  // A failed download is named, never thrown.
  polls = 2;
  const failed = await awaitUsage(api, REPO, [47], { sleep: async () => {}, fetch: async () => { throw Object.assign(new Error("gh"), { code: 1 }); } });
  assert.deepEqual(failed.missing, { 47: ["factory-usage-47 (download failed: exit 1)"] });
});

test("Done pass under a person's login (#2668): its removal of a closed Objective's state label is Factory's only with its done record", async () => {
  const { doneRecord } = await import("../../plugin/scripts/lib/logic.mjs");
  const op = { login: "maintainer", type: "User" };
  // #373's shape: a non-local Objective the App merged and closed; 17 s later a local loop's Done pass, as the operator,
  // removes factory:in-review. `record` is what it posted first, as whom and when.
  const collected = (record = null, { by = op, at = "2031-03-02T03:30:16Z", removal = "2031-03-02T03:30:17Z", issue = 60 } = {}) => {
    const c = cleanMerge(issue);
    c.issueTimeline = c.issueTimeline.filter((e) => e.event !== "unlabeled");
    c.issueTimeline.push({ event: "unlabeled", label: { name: "factory:in-review" }, actor: op, created_at: removal });
    if (record) c.issueComments.push({ user: by, created_at: at, updated_at: at, body: `<!-- factory:${issue}:done -->\n${record}` });
    return c;
  };
  const tidied = (record, o) => scoreObjective(collected(record, o), { prices, now: NOW }).walkAway;
  const miss = tidied();
  assert.equal(miss.value, false, "unmarked, the operator's removal is a person's");
  assert.equal(miss.firstHumanAction.kind, "unlabeled factory:in-review");
  assert.equal(tidied(doneRecord(["factory:in-review"])).value, true, "recorded first: Factory's, and the merge walked away");
  assert.equal(tidied(doneRecord(["factory:in-review"]), { by: { login: "someone-else", type: "User" } }).value, false, "a record by another login excuses nothing");
  assert.equal(tidied(doneRecord(["factory:blocked"])).value, false, "only the labels the record names");
  assert.equal(tidied(doneRecord(["factory:in-review"]), { at: "2031-03-02T03:29:00Z" }).value, false, "a record posted while the issue was open is no Done record");
  assert.equal(tidied(doneRecord(["factory:in-review"]), { at: "2031-03-02T03:40:00Z" }).value, false, "a removal before the record is not covered");
  // A removal that failed waits for a later tick, whose retry rewrites the same body: GitHub need not move updated_at.
  assert.equal(tidied(doneRecord(["factory:in-review"]), { removal: "2031-03-02T03:45:00Z" }).value, true, "a removal ticks after its record is still covered");
  // Reopened, the operator's own removal of a named label is theirs, whatever the record's later edits span.
  const reopened = collected(doneRecord(["factory:in-review"]), { removal: "2031-03-02T04:10:00Z" });
  reopened.issueTimeline.push({ event: "reopened", actor: op, created_at: "2031-03-02T04:00:00Z" }, { event: "closed", actor: op, created_at: "2031-03-02T04:20:00Z" });
  reopened.issueComments.at(-1).updated_at = "2031-03-02T04:20:05Z";
  assert.equal(localFactoryActions(reopened)("2031-03-02T04:10:00Z", op, "unlabeled factory:in-review"), false, "a removal while the issue is open is a person's");
  assert.equal(localFactoryActions(reopened)("2031-03-02T04:20:06Z", op, "unlabeled factory:in-review"), true, "re-closed, the Done pass's removal is Factory's again");
});
