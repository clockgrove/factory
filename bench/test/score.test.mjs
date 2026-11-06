// The four numbers on invented Objectives (fixtures/github.mjs) and the
// usage fixtures per harness (fixtures/usage/). No token, no network.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { collectObjective, snapshotApi, usageFromDir } from "../lib/collect.mjs";
import { costOf, loadPrices, parseUsageText, priceTokens } from "../lib/cost.mjs";
import { humanActions, markdownTable, scoreObjective } from "../lib/objective.mjs";
import { blocked, cleanMerge, humanPush, questionAnswered, REPO, snapshotOf } from "./fixtures/github.mjs";

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

test("cost: Codex tokens are priced from prices.json, with its date in the basis", () => {
  const row = scoreObjective(cleanMerge(46, usage("codex")), { prices, now: NOW });
  assert.equal(row.harness, "codex");
  assert.equal(row.cost.unit, "usd"); // dollars priced from the table are the measure
  // 35,000 uncached in, 115,000 cached, 10,500 out at the gpt-6.1-sol standard rates (2.00 / 0.10 / 10.00)
  assert.equal(row.cost.usd, priceTokens(prices, "gpt-6.1-sol", { input: 150000, cached: 115000, output: 10500 }));
  assert.equal(row.cost.usd, 0.1865);
  assert.match(row.cost.basis, /prices\.json dated 2026-11-05$|prices\.json dated 2026-11-05;/);
  assert.equal(row.cost.priceTableDate, "2026-11-05");
  assert.equal(row.cost.note, null);
  // Raw events.jsonl beside result.json is the same run: one record, the normalized one.
  assert.equal(usage("codex").length, 1);
  const raw = parseUsageText(read(join(USAGE, "codex", "events.jsonl")), { model: "gpt-6.1-sol" });
  assert.deepEqual(raw.tokens, { input: 150000, output: 10500, cached: 115000 });
  assert.equal(costOf([raw], prices).usd, 0.1865);
  assert.equal(costOf([{ ...raw, model: "gpt-unknown-9" }], prices).usd, null);
  assert.match(costOf([{ ...raw, model: "gpt-unknown-9" }], prices).basis, /no price for gpt-unknown-9/);
});

test("cost: Copilot is unmetered in credits with the billing-window note", () => {
  const row = scoreObjective(cleanMerge(47, usage("copilot")), { prices, now: NOW });
  assert.equal(row.harness, "copilot");
  assert.equal(row.cost.unit, "credits");
  assert.equal(row.cost.usd, null);
  assert.equal(row.cost.basis, "unmetered");
  assert.match(row.cost.note, /AI Credits/);
  assert.match(markdownTable([row]), /\| unmetered \| credits \| unmetered \|/);
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
  assert.match(out, /\| #42 \| merged \| yes \| pending \| 0 \| \$7\.43 \| usd \|/);
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
  const { humanActions } = await import("../lib/objective.mjs");
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
