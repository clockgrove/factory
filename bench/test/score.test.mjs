// The four numbers on invented Objectives (fixtures/github.mjs) and the
// usage fixtures per harness (fixtures/usage/). No token, no network.
import "../../plugin/test/temp.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { collectObjective, snapshotApi, usageDirFor, usageFromDir } from "../lib/collect.mjs";
import { cacheOf, costOf, loadPrices, parseUsageText, priceTokens, sessionsOf } from "../lib/cost.mjs";
import { pendulumRequests, handoverSteps, humanActions, localPendulumActions, markdownTable, scoreObjective, splitInterventions, summaryLine } from "../lib/objective.mjs";
import { bySelf, dispatchLatency, pendulumLogin, failedStartsOf, lastWrite, launchesOf, phaseMinutes, setupSeconds } from "../lib/phases.mjs";
import { noWait, waitedRecorded, waitedUnrecorded } from "./fixtures/sandbox-drill.mjs";
import { blocked, cleanMerge, humanPush, localMerge, OPERATOR, questionAnswered, REPO, snapshotOf, withHandover } from "./fixtures/github.mjs";
import { CODEX_NO_TOKENS, mergeUsage, parseUsage } from "../../plugin/scripts/lib/usage.mjs";
import { harnessMarker, usdText } from "../../plugin/scripts/lib/logic.mjs";
import { handoverLine } from "../../plugin/scripts/lib/handover.mjs";

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

test("workflow hand-over, scored as input: a merged PR carrying Pendulum's hand-over line leaves a person's step, asked for, counted like any other operator minute", () => {
  const c = cleanMerge(45, usage("claude"));
  c.pulls[0].body = `${handoverLine({ issue: 45, url: "https://github.test/c", files: [".github/workflows/ci.yml"] })}\n\n## Undone\n- the CI trigger: handed over\n\nCloses #45\n`;
  const input = { prices, now: NOW, handover: "input" };
  const row = scoreObjective(c, input);
  assert.equal(row.exit, "merged");
  assert.equal(row.walkAway.value, false);
  assert.deepEqual(row.walkAway.firstHumanAction, { at: c.pulls[0].merged_at, where: "PR #100", kind: "workflow hand-over", by: "a person (applies the patch)", detail: "", asked: "workflow hand-over" });
  assert.equal(row.walkAway.askedOnly.value, false);
  assert.equal(row.walkAway.bucket, "miss");
  assert.deepEqual(row.operator, { minutes: "unknown", basis: "a workflow hand-over is a person's step: give --minutes <issue>=<n> from a stopwatch" });
  assert.deepEqual(scoreObjective(c, { ...input, minutes: 4 }).operator, { minutes: 4, basis: "--minutes (stopwatch)" });
  assert.equal(row.ownerStep, null);
  assert.equal(row.walkAway.handover, "input");
  // The same body without Pendulum's marker line (a person's copy, or none) is no hand-over.
  c.pulls[0].body = "## Undone\n- nothing\n\nCloses #45\n";
  assert.equal(scoreObjective(c, input).walkAway.value, true);
});

test("workflow hand-over: on a split Objective each merged part with Pendulum's line is one step, and the actions and Pendulum's requests agree", () => {
  const c = cleanMerge(46, usage("claude"));
  const line = handoverLine({ issue: 46, url: "https://github.test/c", files: [".github/workflows/ci.yml"] });
  const second = { ...c.pulls[0], number: 101, created_at: "2031-03-02T04:00:00Z", merged_at: "2031-03-02T05:00:00Z", body: `${line}\n\npart 2\n\nCloses #46\n` };
  c.pulls[0].body = `${line}\n\npart 1\n\nRefs #46\n`;
  c.pulls.push(second);
  c.pullDetails[101] = { commits: [], timeline: [], comments: [], reviews: [], reviewComments: [] };
  const steps = handoverSteps(c).map((a) => a.at);
  assert.deepEqual(steps, [c.pulls[0].merged_at, second.merged_at]);
  assert.deepEqual(pendulumRequests(c, "2031-03-02T01:00:00Z").filter((r) => r.kind === "workflow hand-over").map((r) => r.at), steps);
  const row = scoreObjective(c, { prices, now: NOW, handover: "input" });
  assert.equal(row.walkAway.interventions.asked, 2);
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

test("workflow hand-over: an owner step only when Pendulum's comment with the patch is on the issue; else it stays a person's action", () => {
  const unposted = scoreObjective(withHandover(cleanMerge(47), { posted: false }), { prices, now: NOW });
  assert.equal(unposted.walkAway.value, false);
  assert.equal(unposted.ownerStep, null);
  assert.equal(unposted.walkAway.firstHumanAction.kind, "workflow hand-over");
  assert.equal(unposted.walkAway.firstHumanAction.detail, "Pendulum's hand-over comment with the patch is not on the issue");
  // A person's comment carrying the marker is not Pendulum's hand-over; nor is Pendulum's notice with no patch in it.
  assert.equal(scoreObjective(withHandover(cleanMerge(47), { by: { login: "maintainer", type: "User" } }), { prices, now: NOW }).ownerStep, null);
  // Nor is another machine's: only Pendulum's own login (the App that applied pendulum:running, or --app) posts it.
  assert.equal(scoreObjective(withHandover(cleanMerge(47), { by: { login: "other-tool[bot]", type: "Bot" } }), { prices, now: NOW }).ownerStep, null);
  assert.equal(scoreObjective(withHandover(cleanMerge(47), { by: { login: "other-tool[bot]", type: "Bot" } }), { prices, now: NOW, app: "other-tool[bot]" }).walkAway.value, true);
  const notice = withHandover(cleanMerge(47));
  notice.issueComments.at(-1).body = notice.issueComments.at(-1).body.replace(/```diff[\s\S]*```/, "");
  assert.equal(scoreObjective(notice, { prices, now: NOW }).walkAway.value, false);
});

test("workflow hand-over on a split Objective: Pendulum applying the label again for a later part's patch makes it pending again, until the person removes it again", () => {
  const MAINTAINER = { login: "maintainer", type: "User" };
  const APP = { login: "acme-pendulum[bot]", type: "Bot" };
  const c = withHandover(cleanMerge(48));
  const line = c.pulls[0].body.split("\n\n")[0];
  c.pulls[0].body = `${line}\n\npart 1\n\nRefs #48\n`;
  c.pulls.push({ ...c.pulls[0], number: 101, created_at: "2031-03-02T04:00:00Z", merged_at: "2031-03-02T05:00:00Z", body: `${line}\n\npart 2\n\nCloses #48\n` });
  c.pullDetails[101] = { commits: [], timeline: [], comments: [], reviews: [], reviewComments: [] };
  const removed = (at) => ({ event: "unlabeled", label: { name: "pendulum:handover" }, actor: MAINTAINER, created_at: at });
  c.issueTimeline.push(removed("2031-03-02T03:45:00Z"), { event: "labeled", label: { name: "pendulum:handover" }, actor: APP, created_at: "2031-03-02T04:00:30Z" });
  const pending = scoreObjective(c, { prices, now: NOW });
  assert.equal(pending.walkAway.value, true);
  assert.deepEqual(pending.ownerStep.steps.map((x) => x.where), ["PR #100", "PR #101"]);
  assert.equal(pending.ownerStep.applied, null);
  c.issueTimeline.push(removed("2031-03-02T06:00:00Z"));
  assert.deepEqual(scoreObjective(c, { prices, now: NOW }).ownerStep.applied, { at: "2031-03-02T06:00:00Z", by: "maintainer" });
});

test("workflow hand-over in local mode: Pendulum's own pendulum:handover label under the operator's login is Pendulum's, the operator's later removal is the owner step's", () => {
  const c = withHandover(localMerge(60), { by: OPERATOR });
  c.issueTimeline.push({ event: "labeled", label: { name: "pendulum:handover" }, actor: OPERATOR, created_at: "2031-03-02T01:20:05Z" });
  c.issueTimeline.push({ event: "unlabeled", label: { name: "pendulum:handover" }, actor: OPERATOR, created_at: "2031-03-02T04:00:00Z" });
  const own = localPendulumActions(c);
  assert.equal(own("2031-03-02T01:20:05Z", OPERATOR, "labeled pendulum:handover"), true);
  // A removal is the person's "applied" mark, inside a run's window too, unless it is Pendulum's drop; after the merge,
  // outside any window, it is the person's.
  assert.equal(own("2031-03-02T01:30:00Z", OPERATOR, "unlabeled pendulum:handover"), false);
  assert.equal(own("2031-03-02T04:00:00Z", OPERATOR, "unlabeled pendulum:handover"), false);
  const row = scoreObjective(c, { prices, now: NOW });
  assert.equal(row.walkAway.value, true, row.walkAway.reason);
  assert.deepEqual(row.ownerStep.applied, { at: "2031-03-02T04:00:00Z", by: "dev" });
  // Under the strict rule the first action is the hand-over at the merge, not Pendulum's own label.
  const strict = scoreObjective(c, { prices, now: NOW, handover: "input" });
  assert.equal(strict.walkAway.firstHumanAction.kind, "workflow hand-over");
});

test("workflow hand-over in local mode: a removal inside a run is Pendulum's only when it is Pendulum's drop; else it is the person's applying it, input before the merge", () => {
  const removedAt = (c, at) => c.issueTimeline.push({ event: "unlabeled", label: { name: "pendulum:handover" }, actor: OPERATOR, created_at: at });
  const labeledAt = (c, at) => c.issueTimeline.push({ event: "labeled", label: { name: "pendulum:handover" }, actor: OPERATOR, created_at: at });
  // The operator removes it at 01:30, inside the work run, with Pendulum's patch posted and no relabel: the plugin reads
  // that as applied (handoff.mjs handoverApplied), so it is the person's input before the merge, a miss.
  const person = withHandover(localMerge(60), { by: OPERATOR });
  labeledAt(person, "2031-03-02T01:20:05Z");
  removedAt(person, "2031-03-02T01:30:00Z");
  const miss = scoreObjective(person, { prices, now: NOW });
  assert.equal(miss.walkAway.value, false);
  assert.equal(miss.walkAway.humanActions, 1);
  assert.equal(miss.walkAway.firstHumanAction.kind, "unlabeled pendulum:handover");
  // Pendulum's drop: it applied the label again later in a run...
  const again = withHandover(localMerge(60), { by: OPERATOR });
  labeledAt(again, "2031-03-02T01:20:05Z");
  removedAt(again, "2031-03-02T01:30:00Z");
  labeledAt(again, "2031-03-02T01:35:00Z");
  assert.equal(localPendulumActions(again)("2031-03-02T01:30:00Z", OPERATOR, "unlabeled pendulum:handover"), true);
  assert.equal(scoreObjective(again, { prices, now: NOW }).walkAway.value, true);
  // ...or its hand-over comment now carries no patch (the PR carries none). Outside a run it is still the person's.
  const none = localMerge(60);
  none.issueComments.push({ user: OPERATOR, created_at: "2031-03-02T01:20:00Z", updated_at: "2031-03-02T01:30:00Z", body: `<!-- pendulum:60:handover -->\nPendulum: PR #200 carries no workflow hand-over.` });
  const own = localPendulumActions(none);
  assert.equal(own("2031-03-02T01:30:00Z", OPERATOR, "unlabeled pendulum:handover"), true);
  assert.equal(own("2031-03-02T04:00:00Z", OPERATOR, "unlabeled pendulum:handover"), false);
});

test("workflow hand-over in local mode: the operator applying pendulum:handover by hand is the person's, unless Pendulum's hand-over comment is there or it falls in a run", () => {
  const c = localMerge(60);
  const own = localPendulumActions(c);
  assert.equal(own("2031-03-02T05:00:00Z", OPERATOR, "labeled pendulum:handover"), false);
  assert.equal(own("2031-03-02T01:30:00Z", OPERATOR, "labeled pendulum:handover"), true);
  assert.equal(localPendulumActions(withHandover(localMerge(60), { by: OPERATOR }))("2031-03-02T05:00:00Z", OPERATOR, "labeled pendulum:handover"), true);
  c.issueTimeline.push({ event: "labeled", label: { name: "pendulum:handover" }, actor: OPERATOR, created_at: "2031-03-02T05:00:00Z" });
  assert.equal(scoreObjective(c, { prices, now: NOW }).walkAway.firstHumanAction.kind, "labeled pendulum:handover");
});

test("workflow hand-over in local mode, split: the operator applying part one's hand-over during part two's run is the owner step's applied mark", () => {
  const c = withHandover(localMerge(60), { by: OPERATOR });
  const first = c.pulls[0];
  const line = first.body.split("\n\n")[0];
  first.body = `${line}\n\npart 1\n\nRefs #60\n`;
  c.pulls.push({ ...first, number: 201, created_at: "2031-03-02T03:30:00Z", merged_at: "2031-03-02T04:30:00Z", body: `${line}\n\npart 2\n\nCloses #60\n` });
  c.pullDetails[201] = { commits: [], timeline: [], comments: [], reviews: [], reviewComments: [] };
  c.issueComments.push({ id: 1700000003, user: OPERATOR, created_at: "2031-03-02T02:40:00Z", updated_at: "2031-03-02T04:00:00Z", body: "<!-- pendulum:60:progress:work:1700000003 -->\nPendulum work run 1700000003\n- 02:40Z harness codex (gpt-test) attempt 1\n- 04:00Z exit: delivered; usd 1" });
  c.issueTimeline.push({ event: "unlabeled", label: { name: "pendulum:handover" }, actor: OPERATOR, created_at: "2031-03-02T03:00:00Z" });
  const row = scoreObjective(c, { prices, now: NOW });
  assert.equal(row.walkAway.value, true, row.walkAway.reason);
  assert.deepEqual(row.ownerStep.steps.map((x) => x.where), ["PR #200", "PR #201"]);
  assert.deepEqual(row.ownerStep.applied, { at: "2031-03-02T03:00:00Z", by: "dev" });
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
  assert.equal(row.walkAway.blocked.reason, "validation red after Pendulum's second pass (work)");
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

test("cost: a Codex stage with no completed turn says so, in the worker's record, its exit line and the scorecard alike; never a missing price", () => {
  // the scratch repository's #498: three gpt-6.1-sol calls, each refused before any turn completed (events.jsonl, one run's lines).
  const events = read(join(import.meta.dirname, "..", "..", "plugin", "test", "fixtures", "codex-0.167-refused-400.jsonl"));
  const worker = mergeUsage([1, 2, 3].map(() => parseUsage("codex", events, "gpt-6.1-sol", 1)));
  assert.equal(worker.usd, null, "spend unknown, not zero: a cut turn may have spent tokens");
  assert.equal(worker.basis, CODEX_NO_TOKENS);
  assert.equal(worker.usdUnknown, 3, "three runs of unknown cost");
  assert.match(usdText(worker), /^unknown, 3 runs \(.*the run ended before its harness reported its cost/);
  // The scorecard, from the uploaded result.json (as session.mjs writes it): unknown, never $0.
  const result = { harness: "codex", model: "gpt-6.1-sol", usd: null, usdUnknown: worker.usdUnknown, usdUnknownWhy: worker.usdUnknownWhy, tokens: worker.tokens, basis: worker.basis, turns: 0, runs: 3, artifact: "pendulum-usage-498/result.json" };
  for (const [rec, n] of [[result, 3]]) {
    const cost = costOf([rec], prices);
    assert.equal(cost.usd, null);
    assert.equal(cost.usdUnknown, n);
    assert.ok(cost.basis.startsWith(CODEX_NO_TOKENS), cost.basis);
    assert.match(cost.basis, new RegExp(`plus ${n} runs? of unknown cost`));
  }
  // A model the table lacks, with tokens, is still a missing price.
  assert.match(costOf([{ ...result, model: "gpt-unknown-9", tokens: { input: 10, output: 1, cached: 0, written: null } }], prices).basis, /no price for gpt-unknown-9/);
  assert.equal(usdText({ usd: 0.25, basis: "x" }), "0.25");
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

test("cost: the row's model is the work stage's whatever order the artifacts are listed in (#49)", () => {
  const work = { harness: "claude", model: "claude-opus-5-5", artifact: "pendulum-usage-49/result.json", usd: 2, runs: 1, tokens: { input: 1e5, output: 1e3, cached: 9e4, written: 5e3 } };
  const review = { ...work, model: "claude-fable-5-2", artifact: "pendulum-usage-49-review/result.json", usd: 1 };
  for (const records of [[work, review], [review, work]]) {
    const row = scoreObjective(cleanMerge(49, records), { prices, now: NOW });
    assert.equal(row.model, "claude-opus-5-5");
    assert.equal(row.cost.model, "claude-opus-5-5");
    assert.deepEqual([row.activity.workRuns, row.activity.reviewRuns], [1, 1]);
  }
});

test("cost: the prompt cache after each CI wait is summed across artifacts and noted under the table", () => {
  const first = (written, input) => ({ unit: "request", input, cached: input - written, written, written1h: written, written5m: 0 });
  const work = { harness: "claude", artifact: "pendulum-usage-49/result.json", usd: 2, runs: 3, tokens: { input: 1e6, output: 1e4, cached: 9e5, written: 1e5 }, cache: { ttl: "1h", writeShare: 0.1, afterWait: [{ label: "validation-fix-1", waitMin: 14, resumed: true, first: first(2000, 90000), writeShare: 0.05 }] } };
  const review = { harness: "claude", artifact: "pendulum-usage-49-review/result.json", usd: 1, runs: 2, tokens: { input: 5e5, output: 5e3, cached: 4e5, written: 1e5 }, cache: { ttl: "1h", writeShare: 0.2, afterWait: [{ label: "review-validation-fix-1", waitMin: 9, resumed: true, first: first(3000, 95000), writeShare: 0.1 }] } };
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

test("score.mjs --handover: owner-step by default, input on request, the rule in the JSON; --owner-minutes times the owner step; a bad rule exits 64", () => {
  const dir = mkdtempSync(join(tmpdir(), "pendulum-bench-test-"));
  const file = join(dir, "snapshot.json");
  const c = withHandover(cleanMerge(47));
  c.issueTimeline.push({ event: "unlabeled", label: { name: "pendulum:handover" }, actor: { login: "maintainer", type: "User" }, created_at: "2031-03-02T05:00:00Z" });
  writeFileSync(file, JSON.stringify(snapshotOf(c)));
  const score = (...args) => execFileSync("node", [join(BENCH, "score.mjs"), "--replay", file, "--usage", join(USAGE, "claude"), ...args], { encoding: "utf8", cwd: dir, stdio: "pipe" });
  const out = score("--owner-minutes", "47=7", "--out", join(dir, "rows.json"));
  assert.match(out, /\| #47 \| merged \| yes, owner step: workflow hand-over \| yes \| 0 \/ 0 \| pending \| 0 \| 7 \(workflow hand-over\) \|/);
  const json = JSON.parse(read(join(dir, "rows.json")));
  assert.equal(json.handover, "owner-step");
  assert.deepEqual([json.rows[0].walkAway.handover, json.rows[0].ownerStep.minutes, json.rows[0].ownerStep.applied.by], ["owner-step", 7, "maintainer"]);
  assert.match(score("--handover", "input"), /\| #47 \| merged \| no: first human action: workflow hand-over on PR #100 /);
  let code = 0;
  try {
    score("--handover", "skip");
  } catch (error) {
    code = error.status;
    assert.match(String(error.stderr), /--handover takes owner-step or input, not skip/);
  }
  assert.equal(code, 64);
});

test("labelTime: a Running label before a recovery relabel is the clock", async () => {
  const { labelTime } = await import("../lib/objective.mjs");
  const timeline = [
    { event: "labeled", label: { name: "pendulum:objective" }, created_at: "2026-10-26T04:00:00Z" },
    { event: "labeled", label: { name: "pendulum:running" }, created_at: "2026-11-05T17:50:00Z" },
    { event: "labeled", label: { name: "pendulum:question" }, created_at: "2026-11-05T19:54:00Z" },
    { event: "labeled", label: { name: "pendulum:objective" }, created_at: "2026-11-05T20:29:48Z" },
  ];
  assert.equal(labelTime({}, timeline, "pendulum:objective", "2026-11-05T17:00:00Z"), "2026-11-05T17:50:00Z");
  assert.equal(labelTime({}, timeline, "pendulum:objective", null), "2026-10-26T04:00:00Z");
});

test("waitingMinutes and decisionsOf: queue and human-turn time apart from working time; one person's burst is one decision", async () => {
  const { waitingMinutes, decisionsOf } = await import("../lib/objective.mjs");
  const t = [
    { event: "labeled", label: { name: "pendulum:objective" }, created_at: "2026-11-05T09:40:00Z" },
    { event: "labeled", label: { name: "pendulum:running" }, created_at: "2026-11-05T10:00:00Z" },
    { event: "labeled", label: { name: "pendulum:question" }, created_at: "2026-11-05T11:00:00Z" },
    { event: "labeled", label: { name: "pendulum:running" }, created_at: "2026-11-05T12:00:00Z" },
    { event: "labeled", label: { name: "pendulum:in-review" }, created_at: "2026-11-05T12:30:00Z" },
  ];
  const w = waitingMinutes(t, "2026-11-05T09:40:00Z", "2026-11-05T13:00:00Z");
  assert.deepEqual(w, { minutes: 80, basis: "waiting: queue, question" });
  assert.equal(waitingMinutes(t, "2026-11-05T09:40:00Z", null).minutes, null);
  const acts = [
    { at: "2026-11-05T11:05:00Z", by: "kirk", kind: "body edit" },
    { at: "2026-11-05T11:06:00Z", by: "kirk", kind: "unlabeled pendulum:objective" },
    { at: "2026-11-05T11:06:10Z", by: "kirk", kind: "labeled pendulum:objective" },
    { at: "2026-11-05T11:08:00Z", by: "kirk", kind: "comment" },
    { at: "2026-11-05T12:40:00Z", by: "kirk", kind: "comment" },
  ];
  assert.equal(decisionsOf(acts), 2);
  assert.equal(decisionsOf([]), 0);
});

test("humanActions: board bookkeeping and Pendulum-marker comments are not human actions", async () => {
  const collected = {
    issue: { number: 9 },
    issueTimeline: [
      { event: "labeled", label: { name: "pendulum:objective" }, created_at: "2026-11-06T01:45:23Z", actor: { login: "kirk", type: "User" } },
      { event: "added_to_project_v2", created_at: "2026-11-06T01:45:40Z", actor: { login: "kirk", type: "User" } },
      { event: "project_v2_item_status_changed", created_at: "2026-11-06T01:45:50Z", actor: { login: "kirk", type: "User" } },
      { event: "commented", created_at: "2026-11-06T01:46:00Z", actor: { login: "kirk", type: "User" }, body: "<!-- pendulum:9:held -->\nHeld on the board." },
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
  const body = (n, lines) => `<!-- pendulum:${n}:progress:work:1 -->\nPendulum work run 1\n${lines.map((l) => `- ${l}`).join("\n")}`;
  const work = body(7, ["23:50Z setup", "23:52Z install", "00:01Z harness claude (claude-opus-5-5) attempt 1", "00:31Z waiting for required checks (quality) on abc1234", "00:45Z validation pass 1 red: required checks quality on abc1234; fix run", "00:55Z waiting for required checks (quality) on def5678", "01:05Z exit: delivered; usd 1.00"]);
  const review = `<!-- pendulum:7:progress:review:2 -->\nPendulum review run 2\n- 01:10Z setup\n- 01:11Z reviewer claude-fable-5-1\n- 01:20Z answer pass: 2 comment(s)\n- 01:24Z exit: delivered; usd 0.50`;
  const p = phaseMinutes([{ body: "<!-- pendulum:7:plan -->" }, { body: work }, { body: review }], 7);
  assert.deepEqual(p, { runs: 2, firstSetupMinutes: 0, setupMinutes: 11 + 1, modelMinutes: 30 + 10 + 9 + 4, ciWaitMinutes: 14 + 10, overlapMinutes: 0, otherMinutes: 0, basis: "2 progress comment(s)" });
  assert.equal(phaseMinutes([{ body: "<!-- pendulum:8:progress:work:1 -->\n- 01:00Z setup" }], 7).runs, 0);
  assert.equal(phaseMinutes([], 7).modelMinutes, null);
  // A local Objective's first stage on a machine: the clone's seconds ride its line, the cold install is its own phase.
  const firstRun = "<!-- pendulum:7:progress:work:9 -->\n- 10:00Z first-time setup: cloned in 90 s\n- 10:00Z install (first time on this machine)\n- 10:03Z harness\n- 10:13Z exit: delivered";
  const f = phaseMinutes([{ body: firstRun }], 7);
  assert.equal(f.firstSetupMinutes, 1.5 + 3);
  assert.equal(f.setupMinutes, 0);
  assert.equal(f.modelMinutes, 10);
  const row = scoreObjective(cleanMerge(42, usage("claude")), { prices, now: NOW });
  assert.equal(row.phases.runs, 0);
  assert.match(markdownTable([row]), /\| Dispatch s \(max\) \| Slot wait s \| Setup s \(max\) \| Model min \| CI wait min \| Review beside CI min \| Turns \| Runs \| Sessions \| Rebases \| Harness \|/);
});

test("phaseMinutes: a reviewer beside the required checks counts its minutes once, as review beside CI, from the review stage's own lines (#312)", async () => {
  const { reviewOverlap } = await import("../../plugin/scripts/review.mjs");
  // The review stage's lines as reviewOverlap writes them, with a validation pass that settles when told to.
  const run = async (end) => {
    const lines = [];
    const progress = async (l) => lines.push(l);
    let settle;
    const o = reviewOverlap({
      progress,
      head: () => "abc1234def".padEnd(40, "0"),
      run: async (more) => {
        await more.onPhase("pre-review-validation pass 1 (required checks)");
        await more.onPhase("waiting for required checks (quality) on abc1234");
        more.onRead({ done: false, green: true, failed: [], pending: ["quality"], missing: [] }, [{ id: 1, name: "quality", status: "in_progress" }]);
        return new Promise((r) => (settle = r));
      },
    });
    assert.equal(await o.beside(), true);
    await progress(`reviewer claude-fable-5-2${o.besideText()}`);
    if (end === "during") {
      settle({ green: true, passes: 1, usage: [] });
      await o.done;
    }
    const after = o.reviewerDone();
    if (end === "after") settle({ green: true, passes: 1, usage: [] });
    await after;
    await progress("answer pass: 2 comment(s)");
    return lines;
  };
  const at = (lines, clocks) => `<!-- pendulum:7:progress:review:3 -->\nPendulum review run 3\n${lines.map((l, i) => `- ${clocks[i]} ${l}`).join("\n")}\n- 01:40Z exit: delivered; usd 1.00`;
  // The checks outlast the reviewer: 1 min CI wait, 8 min side by side, 5 min CI wait after it, 10 min answer pass.
  const after = await run("after");
  assert.deepEqual(after, ["pre-review-validation pass 1 (required checks)", "waiting for required checks (quality) on abc1234", "reviewer claude-fable-5-2 beside the required checks on abc1234", "waiting for required checks on abc1234 after the reviewer", "answer pass: 2 comment(s)"]);
  const p = phaseMinutes([{ body: at(after, ["01:15Z", "01:16Z", "01:17Z", "01:25Z", "01:30Z"]) }], 7);
  assert.deepEqual([p.otherMinutes, p.ciWaitMinutes, p.overlapMinutes, p.modelMinutes], [1, 1 + 5, 8, 10]);
  // The checks end first: 6 min side by side, then the reviewer alone for 3 (model), no CI wait after it.
  const during = await run("during");
  assert.deepEqual(during.slice(2), ["reviewer claude-fable-5-2 beside the required checks on abc1234", "required checks on abc1234 green while the reviewer runs", "answer pass: 2 comment(s)"]);
  const q = phaseMinutes([{ body: at(during, ["01:15Z", "01:16Z", "01:17Z", "01:23Z", "01:26Z"]) }], 7);
  assert.deepEqual([q.ciWaitMinutes, q.overlapMinutes, q.modelMinutes], [1, 6, 3 + 14]);
  // Each minute once: the phases add up to the run's wall clock (01:15 to 01:40).
  for (const x of [p, q]) assert.equal(x.otherMinutes + x.ciWaitMinutes + x.overlapMinutes + x.modelMinutes + x.setupMinutes, 25);
  // The pass's own lines during the overlap stay in it.
  assert.equal(phaseMinutes([{ body: "<!-- pendulum:7:progress:review:4 -->\n- 02:00Z reviewer m beside the required checks on abc1234\n- 02:03Z during the reviewer: triage: off (no-key); fix pass\n- 02:07Z required checks on abc1234 red while the reviewer runs\n- 02:09Z exit: delivered" }], 7).overlapMinutes, 7);
});

test("dispatchLatency: each run's pickup against the latest trigger since the previous run; skipped duplicates and Running are not triggers", () => {
  const progress = (stage, id, at, lines) => ({ created_at: at, body: `<!-- pendulum:7:progress:${stage}:${id} -->\nPendulum ${stage} run\n${lines.map((l) => `- ${l}`).join("\n")}` });
  const collected = {
    issue: { created_at: "2026-11-06T08:20:13Z" },
    issueTimeline: [
      { event: "labeled", label: { name: "pendulum:objective" }, created_at: "2026-11-06T08:20:13Z" },
      { event: "labeled", label: { name: "pendulum:running" }, created_at: "2026-11-06T08:20:40Z" },
      { event: "commented", body: "<!-- pendulum:7:local -->", created_at: "2026-11-06T08:20:41Z" },
      { event: "unlabeled", label: { name: "pendulum:question" }, created_at: "2026-11-06T09:00:00Z" },
    ],
    issueComments: [
      progress("work", 1, "2026-11-06T08:21:02Z", ["08:21Z setup", "08:24Z exit: delivered"]),
      progress("review", 2, "2026-11-06T08:24:19Z", ["08:24Z exit: skipped (ready_for_review is not a review cue)"]),
      progress("review", 3, "2026-11-06T08:24:41Z", ["08:24Z setup", "08:26Z exit: delivered"]),
      progress("work", 4, "2026-11-06T09:20:00Z", ["09:20Z setup"]),
      progress("work", 5, "2026-11-06T09:40:00Z", ["09:40Z setup"]),
    ],
    pullDetails: { 8: { timeline: [{ event: "ready_for_review", created_at: "2026-11-06T08:24:04Z" }, { event: "labeled", label: { name: "pendulum:review" }, created_at: "2026-11-06T08:24:05Z" }] } },
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
  // Real artifacts are named pendulum-usage-<issue> and pendulum-usage-<issue>-review; the fixture dirs are not.
  const both = [...usage("claude").map((r) => ({ ...r, artifact: "pendulum-usage-48" })), ...usage("review").map((r) => ({ ...r, artifact: "pendulum-usage-48-review" }))];
  const row = scoreObjective(cleanMerge(48, both), { prices, now: NOW });
  assert.equal(row.activity.workRuns, 1);
  assert.equal(row.activity.reviewRuns, 1);
  assert.equal(row.activity.turns, 87 + (usage("review")[0].turns ?? 0));
  assert.match(markdownTable([row]), /\| Turns \| Runs \| Sessions \| Rebases \| Harness \|/);
  assert.match(markdownTable([row]), /\| 1\+1 \|/);
});

test("interventions: what Pendulum asked for (Question, Blocked notice, review request) is split from unprompted input; walk-away both ways", () => {
  // A Question answered: Pendulum's label, its review request and the QUESTION in its PR body all ask; both of the owner's actions answer it.
  const q = scoreObjective(questionAnswered(45, usage("claude")), { prices, now: NOW });
  assert.deepEqual(q.walkAway.interventions.requests.map((r) => r.kind), ["question", "question", "review request"]);
  assert.equal(q.walkAway.interventions.asked, 2);
  assert.equal(q.walkAway.interventions.unprompted, 0);
  assert.equal(q.walkAway.firstHumanAction.asked, "review request");
  assert.equal(q.walkAway.value, false);
  assert.equal(q.walkAway.askedOnly.value, false, "Pendulum needed a person: a miss both ways");
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

  // Once Pendulum picks the Objective up again (its pendulum:running label), a later note is unprompted again.
  const c = questionAnswered(46);
  c.issueTimeline.push({ event: "labeled", label: { name: "pendulum:running" }, actor: { login: "acme-pendulum[bot]", type: "Bot" }, created_at: "2031-03-03T08:31:00Z" });
  c.issueComments.push({ user: { login: "maintainer", type: "User" }, created_at: "2031-03-03T09:30:00Z", body: "Also add a TSV export while you are there." });
  const later = scoreObjective(c, { prices, now: NOW });
  assert.equal(later.walkAway.interventions.asked, 2);
  assert.equal(later.walkAway.interventions.unprompted, 1);
  assert.match(later.walkAway.interventions.firstUnprompted.detail, /TSV/);

  // A person who applies pendulum:question or pendulum:blocked by hand asks nothing: only Pendulum's own labels are requests.
  const h = humanPush(47);
  h.issueTimeline.push({ event: "labeled", label: { name: "pendulum:blocked" }, actor: { login: "maintainer", type: "User" }, created_at: "2031-03-02T01:30:00Z" });
  assert.deepEqual(pendulumRequests(h, "2031-03-02T01:00:00Z"), []);

  // Local mode: Pendulum posts as the operator's login, so its requests are told apart by its markers and its run windows.
  const local = blocked(48);
  local.issue.labels.push({ name: "pendulum:local" });
  const op = { login: "maintainer", type: "User" };
  for (const e of local.issueTimeline) if (e.actor?.type === "Bot") e.actor = op;
  for (const cm of local.issueComments) cm.user = op;
  local.issueComments.push({ user: op, created_at: "2031-03-02T01:05:00Z", updated_at: "2031-03-02T04:00:00Z", body: "<!-- pendulum:48:progress:work:1 -->\nPendulum work" });
  local.issueComments.push({ user: op, created_at: "2031-03-02T06:00:00Z", body: "Pushed a fix; re-running." });
  local.issueTimeline.push({ event: "labeled", label: { name: "pendulum:objective" }, actor: op, created_at: "2031-03-02T06:01:00Z" });
  const reqs = pendulumRequests(local, "2031-03-02T01:00:00Z");
  assert.deepEqual(reqs.map((r) => r.kind), ["blocked", "blocked"]);
  const split = splitInterventions(humanActions(local, "2031-03-02T01:00:00Z"), reqs);
  assert.deepEqual(split.map((a) => [a.kind, a.asked]), [["comment", "blocked"], ["labeled pendulum:objective", "blocked"]]);

  // The table carries both columns and the summary both rates and both counts.
  const md = markdownTable([q, p]);
  assert.match(md, /\| #43 \| merged \| no: first human action: push on PR #101 by maintainer at [^|]+ \| yes \| 0 \/ 1 \|/);
  assert.match(md, /\| #45 \| merged \| no: [^|]+ \| no: first asked-for action: [^|]+ \| 2 \/ 0 \|/);
  assert.equal(summaryLine([q, p]), "Walk-away: 0 of 2 Objective(s) (2 merged) with no human input; 1 of 2 counting only input Pendulum asked for. Interventions: 2 asked for (Question, Blocked notice, review request), 1 unprompted.");
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
  // Only Pendulum's own record counts: a person's copy of the marker is not read, nor another App's.
  const self = pendulumLogin(waitedRecorded().issueTimeline);
  assert.equal(self, "acme-pendulum[bot]", "the App that applied pendulum:running");
  assert.equal(pendulumLogin(waitedRecorded().issueTimeline, "Other-App[bot]"), "other-app[bot]", "--app wins");
  const e = waitedRecorded();
  e.issueComments = e.issueComments.map((x) => (x.body.includes(":sandbox -->") ? { ...x, user: { login: "maintainer", type: "User" } } : x));
  assert.deepEqual(launchesOf(e.issueComments, 253, self), []);
  e.issueComments = e.issueComments.map((x) => (x.body.includes(":sandbox -->") ? { ...x, user: { login: "other-ci[bot]", type: "Bot" } } : x));
  assert.deepEqual(launchesOf(e.issueComments, 253, self), []);
  assert.deepEqual(launchesOf(waitedRecorded().issueComments, 253, null), [], "no known Pendulum login: nothing is Pendulum's");
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
  cron.issueTimeline = [{ event: "labeled", label: { name: "pendulum:objective" }, actor: { login: "maintainer", type: "User" }, created_at: "2026-11-09T07:00:00Z" }, { event: "labeled", label: { name: "pendulum:running" }, actor: { login: "acme-pendulum[bot]", type: "Bot" }, created_at: "2026-11-09T07:10:30Z" }];
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
    o.issueTimeline.push({ event: "unlabeled", label: { name: "pendulum:in-review" }, actor: { login: "acme-pendulum[bot]", type: "Bot" }, created_at: "2026-11-09T07:09:30Z" });
    o.issueComments.push({ id: 9, user: { login: "acme-pendulum[bot]", type: "Bot" }, created_at: "2026-11-09T07:10:40Z", body: "<!-- pendulum:253:progress:work:42577500000-aa11bb22cc33 -->\nPendulum work run.\n- 07:10Z setup" });
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
  // A person's progress marker is never a launching run: collect.mjs reads ids from Pendulum's comments only.
  assert.equal(bySelf({ user: { login: "maintainer" } }, "acme-pendulum[bot]"), false);
  assert.equal(bySelf({ user: { login: "Acme-Pendulum[bot]" } }, "acme-pendulum[bot]"), true);
});

test("no slot wait for an Objective picked and sent back before the tick: a transient failed start stays dispatch", () => {
  // #253's drill shape, but the dispatcher picked it at once (a slot was free): Running at 06:56:40, its sandbox start
  // failed with a transient code at 06:57:00 and the launcher sent it back to Queued (Running off at 06:57:01). Nothing
  // re-ticked; the sibling's merge at 07:01:44 started it. The 392 s are dispatch (the 60 s bar sees them), not a wait.
  const APP = { login: "acme-pendulum[bot]", type: "Bot" };
  const failedEntry = '{"stage":"work","event":"issues","ok":false,"found":false,"run":"42576100000","at":"2026-11-09T06:57:00.000Z","cue":"stint-1794207400"},';
  const requeued = ({ label = true, entry = true } = {}) => {
    const o = waitedRecorded();
    if (label) o.issueTimeline.splice(1, 0, { event: "labeled", label: { name: "pendulum:running" }, actor: APP, created_at: "2026-11-09T06:56:40Z" }, { event: "unlabeled", label: { name: "pendulum:running" }, actor: APP, created_at: "2026-11-09T06:57:01Z" });
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
  assert.deepEqual(failedStartsOf(waitedRecorded().issueComments, 253, "acme-pendulum[bot]"), []);
  // The real waits stay: #253's own Running label came after the tick, and a person's Running label is not a pick.
  assert.equal(dispatchLatency(waitedRecorded(), 253).runs[0].slotWaitSeconds, 333);
  const person = waitedRecorded();
  person.issueTimeline.splice(1, 0, { event: "labeled", label: { name: "pendulum:running" }, actor: { login: "maintainer", type: "User" }, created_at: "2026-11-09T06:56:40Z" }, { event: "unlabeled", label: { name: "pendulum:running" }, actor: { login: "maintainer", type: "User" }, created_at: "2026-11-09T06:57:01Z" });
  assert.equal(dispatchLatency(person, 253).runs[0].slotWaitSeconds, 333);
  // A failed start of another stage (the review) is not this work stage's.
  const review = waitedRecorded();
  review.issueComments = review.issueComments.map((x) => (x.body.includes(":sandbox -->") ? { ...x, body: x.body.replace('"launches":[', `"launches":[${failedEntry.replace('"stage":"work"', '"stage":"review"')}`) } : x));
  assert.equal(dispatchLatency(review, 253).runs[0].slotWaitSeconds, 333);
});

test("a lost launch still Running when a later tick relaunched it, and an answered Question's own tick, are no slot wait", () => {
  const APP = { login: "acme-pendulum[bot]", type: "Bot" };
  const OWNER = { login: "maintainer", type: "User" };
  const lab = (name, actor, at, event = "labeled") => ({ event, label: { name }, actor, created_at: at });
  const rec = (launches) => ({ id: 1, user: APP, created_at: "2026-11-09T06:59:59Z", body: `<!-- pendulum:9:sandbox -->\n<!-- pendulum:sandbox ${JSON.stringify({ vendor: "vercel", stage: "work", state: "running", launches })} -->` });
  const prog = (id, run, at) => ({ id, user: APP, created_at: at, body: `<!-- pendulum:9:progress:work:${run}-abc -->\n- ${at.slice(11, 16)}Z setup` });
  const objective = (timeline, comments) => ({ issue: { number: 9, created_at: "2026-11-09T06:59:00Z" }, issueTimeline: timeline, issueComments: comments, pullDetails: {}, stageRuns: {} });
  const first = { stage: "work", event: "issues", eventAt: "2026-11-09T07:00:01Z", ok: true, latencyMs: 40000, run: "100", at: "2026-11-09T07:00:41Z" };

  // Picked at 07:00:20, the launch lost with no record entry and Running left on; a sibling's merge at 07:20:00 ticked
  // the dispatcher, whose sweep launched it again. The slot was held throughout: 1250 s of dispatch, no slot wait.
  const lost = dispatchLatency(objective([lab("pendulum:objective", OWNER, "2026-11-09T07:00:00Z"), lab("pendulum:running", APP, "2026-11-09T07:00:20Z")], [rec([{ stage: "work", event: "pull_request", eventAt: "2026-11-09T07:20:00Z", ok: true, latencyMs: 40000, run: "200", at: "2026-11-09T07:20:40Z" }]), prog(2, "200", "2026-11-09T07:20:50Z")]), 9);
  assert.deepEqual(lost.runs, [{ stage: "work", seconds: 1250, slotWaitSeconds: 0, from: "own trigger", tickEvent: "relaunched" }]);
  assert.equal(lost.basis, "1/1 run(s) matched to an event; 1 started by a later tick that freed no slot (relaunched)");
  // A real wait: Running only after the tick, so the 600 s stay a slot wait.
  const waited = dispatchLatency(objective([lab("pendulum:objective", OWNER, "2026-11-09T07:00:00Z"), lab("pendulum:running", APP, "2026-11-09T07:10:20Z")], [rec([{ stage: "work", event: "pull_request", eventAt: "2026-11-09T07:10:00Z", ok: true, latencyMs: 40000, run: "200", at: "2026-11-09T07:10:40Z" }]), prog(2, "200", "2026-11-09T07:10:50Z")]), 9);
  assert.deepEqual(waited.runs, [{ stage: "work", seconds: 50, slotWaitSeconds: 600, from: "launch record", tickEvent: "pull_request" }]);

  // An answered Question on the sandbox path: the person's comment at 07:30:00, the launcher's requeue takes
  // pendulum:question off at 07:30:20 and its step ticks the dispatcher (workflow_dispatch) at 07:30:25. That tick is
  // the Objective's own: timed from the unlabel, no slot wait.
  const answered = (unlabelActor = APP, comment = true) => {
    const timeline = [lab("pendulum:objective", OWNER, "2026-11-09T07:00:00Z"), lab("pendulum:running", APP, "2026-11-09T07:00:20Z"), lab("pendulum:running", APP, "2026-11-09T07:05:00Z", "unlabeled"), lab("pendulum:question", APP, "2026-11-09T07:05:00Z")];
    if (comment) timeline.push({ event: "commented", user: OWNER, actor: OWNER, body: "use X", created_at: "2026-11-09T07:30:00Z" });
    timeline.push(lab("pendulum:question", unlabelActor, "2026-11-09T07:30:20Z", "unlabeled"), lab("pendulum:running", APP, "2026-11-09T07:30:40Z"));
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
    o.issueTimeline.push({ event: "unlabeled", label: { name: "pendulum:in-review" }, actor: { login: "acme-pendulum[bot]", type: "Bot" }, created_at: "2026-11-09T07:09:30Z" });
    o.issueComments.push({ id: 9, user: { login: "acme-pendulum[bot]", type: "Bot" }, created_at: "2026-11-09T07:26:00Z", body: "<!-- pendulum:253:progress:work:42577500000-aa11bb22cc33 -->\nPendulum work run.\n- 07:26Z setup" });
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

/** #295's shape: reviewed and enqueued, dropped by the queue, idle until an unrelated tick enqueued it again. */
function queueDropped(number = 46) {
  const c = cleanMerge(number);
  const APP = { login: "acme-pendulum[bot]", type: "Bot" };
  const QUEUE = { login: "github-merge-queue[bot]", type: "Bot" };
  c.pulls[0].merged_at = "2031-03-02T05:00:00Z";
  c.issue.closed_at = "2031-03-02T05:00:00Z";
  for (const e of c.issueTimeline) if (e.created_at === "2031-03-02T03:30:00Z") e.created_at = "2031-03-02T05:00:00Z";
  c.pullDetails[100].timeline = [
    { event: "labeled", label: { name: "pendulum:review" }, actor: APP, created_at: "2031-03-02T02:11:00Z" },
    { event: "added_to_merge_queue", actor: APP, created_at: "2031-03-02T03:00:00Z" },
    { event: "removed_from_merge_queue", actor: QUEUE, created_at: "2031-03-02T04:00:00Z" },
    { event: "added_to_merge_queue", actor: APP, created_at: "2031-03-02T04:55:00Z" },
    { event: "merged", actor: APP, created_at: "2031-03-02T05:00:00Z" },
  ];
  // The sandbox record is rewritten when a stage is booked, after the merge too: its last edit is not Pendulum acting.
  c.issueComments.push({ user: APP, created_at: "2031-03-02T01:06:00Z", updated_at: "2031-03-02T05:01:00Z", body: `<!-- pendulum:${number}:sandbox -->\n<!-- pendulum:sandbox {} -->` });
  return c;
}

test("a merge idle past the stall threshold after Pendulum's last act is a stall, not a walk-away, with how long it sat", async () => {
  const { idleStall, STALL_MINUTES } = await import("../lib/objective.mjs");
  assert.equal(STALL_MINUTES, 60);
  const row = scoreObjective(queueDropped(), { prices, now: NOW });
  assert.equal(row.exit, "merged");
  assert.equal(row.walkAway.value, false);
  assert.equal(row.walkAway.humanActions, 0);
  // The queue's drop is not Pendulum's act: idle from the enqueue at 03:00 to the re-enqueue at 04:55.
  assert.deepEqual(row.walkAway.stall, { minutes: 115, from: "2031-03-02T03:00:00Z", until: "2031-03-02T04:55:00Z", thresholdMinutes: 60 });
  assert.equal(row.walkAway.longestIdleMinutes, 115);
  assert.equal(row.walkAway.reason, "stalled 115 min after Pendulum's last action (2031-03-02T03:00:00Z to 2031-03-02T04:55:00Z; threshold 60 min); no human action");
  assert.equal(row.walkAway.askedOnly.value, false);
  assert.deepEqual(row.operator, { minutes: 0, basis: "no human action (stalled)" });
  assert.match(markdownTable([row]), /\| #46 \| merged \| no: stalled 115 min after Pendulum's last action/);
  assert.match(summaryLine([row, scoreObjective(cleanMerge(42), { prices, now: NOW })]), /^Walk-away: 1 of 2 .* Stalled: #46 115 min idle after Pendulum's last action \(threshold 60 min\)\.$/);
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
  assert.equal(idleStall(q, "2031-03-02T01:00:00Z", q.pulls[0].merged_at, { requests: pendulumRequests(q, "2031-03-02T01:00:00Z") }).stalled, false);
  assert.equal(idleStall(blocked(44), "2031-03-02T01:00:00Z", null), null);
  // Another login's act is not Pendulum's: a person relabelling inside the gap does not shorten it.
  const c = queueDropped();
  c.issueTimeline.push({ event: "labeled", label: { name: "P2" }, actor: { login: "maintainer", type: "User" }, created_at: "2031-03-02T04:30:00Z" });
  assert.equal(idleStall(c, "2031-03-02T01:00:00Z", c.pulls[0].merged_at).minutes, 115);
});

test("a stage that died and was booked late by the sweep is idle from its own last write, not its comment's last edit", async () => {
  const { idleStall } = await import("../lib/objective.mjs");
  const { stageLastWrite } = await import("../lib/phases.mjs");
  const APP = { login: "acme-pendulum[bot]", type: "Bot" };
  const c = cleanMerge(48);
  c.pulls[0].merged_at = "2031-03-02T05:00:00Z";
  for (const e of [...c.issueTimeline, ...c.pullDetails[100].timeline]) if (e.created_at === "2031-03-02T03:30:00Z") e.created_at = "2031-03-02T05:00:00Z";
  // A sandbox work stage started 03:00 and last wrote ten minutes in; the sweep booked its cost into the comment at
  // 04:50 (the header stays) and the dispatcher picked the Objective up again.
  const progress = { user: APP, created_at: "2031-03-02T03:00:20Z", updated_at: "2031-03-02T04:50:00Z", body: "<!-- pendulum:48:progress:work:9-0123456789ab -->\nPendulum work run 9-0123456789ab: started 03:00Z, 10 min at the last line.\n- 03:00Z setup\n- 03:10Z harness\n- 04:50Z sandbox stopped: $0.01\n<!-- pendulum:spend 0.5 -->" };
  c.issueComments.push(progress);
  c.issueTimeline.push({ event: "labeled", label: { name: "pendulum:running" }, actor: APP, created_at: "2031-03-02T04:50:00Z" });
  assert.equal(new Date(stageLastWrite(progress)).toISOString(), "2031-03-02T03:11:30.000Z");
  assert.deepEqual(idleStall(c, "2031-03-02T01:00:00Z", c.pulls[0].merged_at), { minutes: 98.5, from: "2031-03-02T03:11:30Z", until: "2031-03-02T04:50:00Z", thresholdMinutes: 60, stalled: true });
  // A stage that started before midnight UTC and first wrote after it; a comment with no header falls back to its last edit.
  assert.equal(new Date(stageLastWrite({ created_at: "2031-03-03T00:00:10Z", updated_at: "2031-03-03T00:30:00Z", body: "<!-- x -->\nPendulum review run 7: started 23:59Z, 20 min at the last line." })).toISOString(), "2031-03-03T00:20:30.000Z");
  assert.equal(new Date(stageLastWrite({ created_at: "2031-03-02T03:00:00Z", updated_at: "2031-03-02T04:00:00Z", body: "<!-- x -->\nPendulum work run abc: the stage left no progress of its own." })).toISOString(), "2031-03-02T04:00:00.000Z");
  // The header never stretches a span past the comment's last edit.
  assert.equal(new Date(stageLastWrite({ created_at: "2031-03-02T03:00:20Z", updated_at: "2031-03-02T03:05:00Z", body: "Pendulum work run 9: started 03:00Z, 5 min at the last line." })).toISOString(), "2031-03-02T03:05:00.000Z");
});

test("usage still owed: the latest stage of each kind Pendulum ran needs its artifact, created at or after the stage started", async () => {
  const { usagePending } = await import("../lib/collect.mjs");
  const APP = { login: "acme-pendulum[bot]", type: "Bot" };
  const self = "acme-pendulum[bot]";
  const work = { user: APP, created_at: "2031-03-02T01:10:00Z", body: "<!-- pendulum:47:progress:work:123-abc -->\nPendulum work run." };
  const review = { user: APP, created_at: "2031-03-02T02:15:00Z", body: "<!-- pendulum:47:progress:review:124-def -->\nPendulum review run." };
  const art = (name, created_at) => ({ id: 1, name, created_at, expired: false, workflow_run: 9 });
  // Blocked before any stage ran: nothing is owed, so the drill scores it at once.
  assert.deepEqual(usagePending(47, [], [], { self }), []);
  // Blocked by a stage whose upload lands after the label: owed until the artifact exists.
  assert.deepEqual(usagePending(47, [work], [], { self }), ["pendulum-usage-47"]);
  assert.deepEqual(usagePending(47, [work], [art("pendulum-usage-47", "2031-03-02T01:40:03Z")], { self }), []);
  // An earlier run's artifact of the same name does not stand in for the last stage's.
  const fix = { ...work, created_at: "2031-03-02T03:00:00Z" };
  assert.deepEqual(usagePending(47, [work, review, fix], [art("pendulum-usage-47", "2031-03-02T01:40:00Z"), art("pendulum-usage-47-review", "2031-03-02T02:20:00Z")], { self }), ["pendulum-usage-47"]);
  assert.deepEqual(usagePending(47, [work, review], [art("pendulum-usage-47", "2031-03-02T01:40:00Z")], { self }), ["pendulum-usage-47-review"]);
  // A pasted marker is not Pendulum's stage, nor is another issue's.
  assert.deepEqual(usagePending(47, [{ ...work, user: { login: "writer", type: "User" } }], [], { self }), []);
  assert.deepEqual(usagePending(48, [work], [], { self }), []);
});

test("score.mjs refuses a --usage directory that does not exist, with exit 64 and no stack", () => {
  let code = 0;
  try {
    execFileSync("node", [join(BENCH, "score.mjs"), "--repo", "acme/widgets", "--issue", "1", "--usage", join(tmpdir(), "pendulum-no-such-usage-dir")], { encoding: "utf8", stdio: "pipe" });
  } catch (error) {
    code = error.status;
    assert.match(String(error.stderr), /^--usage: .* is not a directory$/m);
  }
  assert.equal(code, 64);
});

test("the drill's usage wait: a Blocked Objective's artifact that lands after the label is waited for and fetched; one that never comes is named; a running one's finished stages are fetched", async () => {
  const { awaitUsage } = await import("../lib/collect.mjs");
  const APP = { login: "acme-pendulum[bot]", type: "Bot" };
  const timeline = [{ event: "labeled", label: { name: "pendulum:running" }, actor: APP, created_at: "2031-03-02T01:05:00Z" }, { event: "labeled", label: { name: "pendulum:blocked" }, actor: APP, created_at: "2031-03-02T01:30:00Z" }];
  const work = (n) => ({ user: APP, created_at: "2031-03-02T01:06:00Z", body: `<!-- pendulum:${n}:progress:work:77-abc -->\nPendulum work run.` });
  const review49 = { user: APP, created_at: "2031-03-02T01:25:00Z", body: "<!-- pendulum:49:progress:review:80-def -->\nPendulum review run." };
  let polls = 0;
  const answers = (path) => {
    const n = Number(/issues\/(\d+)\//.exec(path)?.[1] ?? /pendulum-usage-(\d+)/.exec(path)?.[1]);
    if (path.includes("/timeline")) return timeline;
    if (path.includes("/comments")) return n === 44 ? [] : n === 49 ? [work(n), review49] : [work(n)];
    if (path.includes("actions/artifacts")) {
      // #47's upload lands on the second poll; #48's never does; #49 is still in review at the deadline, its work uploaded.
      if (n === 49 && /pendulum-usage-49&/.test(path)) return [{ artifacts: [{ id: 9, name: "pendulum-usage-49", created_at: "2031-03-02T01:20:00Z", expired: false, workflow_run: { id: 79 } }] }];
      if (n === 47 && /pendulum-usage-47&/.test(path) && polls >= 2) return [{ artifacts: [{ id: 5, name: "pendulum-usage-47", created_at: "2031-03-02T01:30:03Z", expired: false, workflow_run: { id: 77 } }] }];
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
  assert.deepEqual(fetched, [[47, "pendulum-usage-47", 77], [49, "pendulum-usage-49", 79]]);
  assert.deepEqual(missing, { 48: ["pendulum-usage-48"], 49: ["pendulum-usage-49-review (still running)"] });
  assert.match(logs[0], /^waiting for usage: #47 pendulum-usage-47; #48 pendulum-usage-48$/);
  assert.equal(clock, 60_000, "the wait is bounded");
  // A failed download is named, never thrown.
  polls = 2;
  const failed = await awaitUsage(api, REPO, [47], { sleep: async () => {}, fetch: async () => { throw Object.assign(new Error("gh"), { code: 1 }); } });
  assert.deepEqual(failed.missing, { 47: ["pendulum-usage-47 (download failed: exit 1)"] });
});

test("Done pass under a person's login (#2668): its removal of a closed Objective's state label is Pendulum's only with its done record", async () => {
  const { doneRecord } = await import("../../plugin/scripts/lib/logic.mjs");
  const op = { login: "maintainer", type: "User" };
  // #373's shape: a non-local Objective the App merged and closed; 17 s later a local loop's Done pass, as the operator,
  // removes pendulum:in-review. `record` is what it posted first, as whom and when.
  const collected = (record = null, { by = op, at = "2031-03-02T03:30:16Z", removal = "2031-03-02T03:30:17Z", issue = 60 } = {}) => {
    const c = cleanMerge(issue);
    c.issueTimeline = c.issueTimeline.filter((e) => e.event !== "unlabeled");
    c.issueTimeline.push({ event: "unlabeled", label: { name: "pendulum:in-review" }, actor: op, created_at: removal });
    if (record) c.issueComments.push({ user: by, created_at: at, updated_at: at, body: `<!-- pendulum:${issue}:done -->\n${record}` });
    return c;
  };
  const tidied = (record, o) => scoreObjective(collected(record, o), { prices, now: NOW }).walkAway;
  const miss = tidied();
  assert.equal(miss.value, false, "unmarked, the operator's removal is a person's");
  assert.equal(miss.firstHumanAction.kind, "unlabeled pendulum:in-review");
  assert.equal(tidied(doneRecord(["pendulum:in-review"])).value, true, "recorded first: Pendulum's, and the merge walked away");
  assert.equal(tidied(doneRecord(["pendulum:in-review"]), { by: { login: "someone-else", type: "User" } }).value, false, "a record by another login excuses nothing");
  assert.equal(tidied(doneRecord(["pendulum:blocked"])).value, false, "only the labels the record names");
  assert.equal(tidied(doneRecord(["pendulum:in-review"]), { at: "2031-03-02T03:29:00Z" }).value, false, "a record posted while the issue was open is no Done record");
  assert.equal(tidied(doneRecord(["pendulum:in-review"]), { at: "2031-03-02T03:40:00Z" }).value, false, "a removal before the record is not covered");
  // A removal that failed waits for a later tick, whose retry rewrites the same body: GitHub need not move updated_at.
  assert.equal(tidied(doneRecord(["pendulum:in-review"]), { removal: "2031-03-02T03:45:00Z" }).value, true, "a removal ticks after its record is still covered");
  // Reopened, the operator's own removal of a named label is theirs, whatever the record's later edits span.
  const reopened = collected(doneRecord(["pendulum:in-review"]), { removal: "2031-03-02T04:10:00Z" });
  reopened.issueTimeline.push({ event: "reopened", actor: op, created_at: "2031-03-02T04:00:00Z" }, { event: "closed", actor: op, created_at: "2031-03-02T04:20:00Z" });
  reopened.issueComments.at(-1).updated_at = "2031-03-02T04:20:05Z";
  assert.equal(localPendulumActions(reopened)("2031-03-02T04:10:00Z", op, "unlabeled pendulum:in-review"), false, "a removal while the issue is open is a person's");
  assert.equal(localPendulumActions(reopened)("2031-03-02T04:20:06Z", op, "unlabeled pendulum:in-review"), true, "re-closed, the Done pass's removal is Pendulum's again");
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

test("#480: a local stage of unknown cost, and an Actions stage whose artifact expired, carry through beside the known dollars", () => {
  const unknown = mixedRoute(73, { review: { usd: 0, usdUnknown: 1, usdUnknownWhy: ["unreported"] } });
  const row = scoreObjective(unknown, { prices, now: NOW });
  assert.deepEqual([row.cost.usd, row.cost.usdUnknown, row.cost.usdUnknownWhy], [8, 1, ["unreported"]]);
  assert.match(markdownTable([row]), /\| \$8\.00 plus 1 run of unknown cost \(/);
  // Work and review both on Actions; the work's artifact expired (not downloaded), the review's names its comment: the
  // work stage's comment, with no spend line, is a run of unknown cost.
  const expired = mixedRoute(74, { review: null, artifact: { artifact: "pendulum-usage-74-review/result.json", progressRun: "1700000002", usd: 3 } });
  const e = scoreObjective(expired, { prices, now: NOW });
  assert.deepEqual([e.cost.usd, e.cost.usdUnknown], [3, 1]);
  assert.match(markdownTable([e]), /\| \$3\.00 plus 1 run of unknown cost \(/);
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

test("#506 review: a stand-in record gives way to its stage's progress comment, which keeps the stand-in's sandbox cost when it has none", () => {
  const score = (c) => scoreObjective(c, { prices, now: NOW });
  // A sandbox stage its launcher ended: the stand-in carries the comment's last figure; the comment counts, once.
  const killed = mixedRoute(85, { workKey: "5552-abcdef012345", work: { usd: 4.1, usdUnknown: 1, usdUnknownWhy: ["unreported"] }, artifact: { progressRun: "5552-abcdef012345", standIn: true, usd: 4.1, usdUnknown: 1, usdUnknownWhy: ["unreported"], vendor: { claim: "abcdef012345", usd: 0.6 } } });
  const k = score(killed);
  assert.deepEqual([k.cost.usd, k.cost.usdUnknown, k.cost.vendorUsd], [7.1, 1, 0.6], "never $4.10 twice and 2 runs of unknown cost");
  assert.deepEqual(k.cost.parts.map((p) => p.artifact), ["spend/work/5552-abcdef012345", "spend/review/1700000002"]);
  // An Actions artifact with no result.json, uploaded by the stage's run: one run of unknown cost, not two.
  const noResult = mixedRoute(86, { artifact: { progressRun: undefined, workflowRun: 5551, standIn: true, harness: null, usd: null, usdUnknown: 1, usdUnknownWhy: ["unreported"] } });
  assert.deepEqual([score(noResult).cost.usd, score(noResult).cost.usdUnknown], [3, 1]);
});

test("#506 review: a mixed Codex row's basis names both sources, the price table for the artifacts and the worker's own pricing for the spend lines", () => {
  const c = mixedRoute(87, { artifact: { harness: "codex", model: "gpt-6.1-sol", usd: null, tokens: { input: 150000, output: 10000, cached: 115000, written: null } } });
  c.harness = "codex";
  const row = scoreObjective(c, { prices, now: NOW });
  assert.equal(row.cost.usd, 3.1815);
  assert.match(row.cost.basis, /^artifacts: tokens priced [^;]*codex-prices\.json dated [^;]+; spend lines: the worker's own pricing, in 1 progress comment\(s\); 1 artifact\(s\) and 1 spend line\(s\) summed$/);
});

test("#506 review F2: a stage's usage directory is read for its result.json and stream only, never its session totals", () => {
  const dir = mkdtempSync(join(tmpdir(), "score-stage-dir-"));
  try {
    writeFileSync(join(dir, "result.json"), JSON.stringify({ harness: "claude", model: "claude-opus-5-5", usd: 18, usdUnknown: 1, usdUnknownWhy: ["unreported"], runs: 2 }));
    writeFileSync(join(dir, "session-totals.json"), JSON.stringify({ harness: "claude", sessions: { s1: { usd: 18 } }, spend: { usd: 18, unknown: 1 } }));
    const records = usageFromDir(dir, { readdir: (p) => readdirSync(p), read: (p) => readFileSync(p, "utf8"), isDir: (p) => statSync(p).isDirectory() });
    assert.deepEqual(records.map((r) => r.artifact), ["result.json"]);
    const cost = costOf(records, prices, { harness: "claude" });
    assert.deepEqual([cost.usd, cost.usdUnknown], [18, 1], "$18 plus 1 run of unknown cost, never 2");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#506 review B1: the records' order never changes the row: a stand-in and its stage's own record, a sandbox stub or one on an account", () => {
  const score = (c) => scoreObjective(c, { prices, now: NOW });
  const both = (c, recs) => [recs, [...recs].reverse()].map((usage) => {
    const row = score({ ...c, usage });
    return [row.cost.usd, row.cost.usdUnknown, row.cost.vendorUsd];
  });
  // The launcher's collection failed, so bookVendor wrote its stub (the stage's key, the vendor); a later run uploaded the
  // stage's own result.json (the same key, no vendor). The stage's comment shows $4.
  const c = mixedRoute(90, { workKey: "5552-abcdef012345", work: { usd: 4 }, review: false });
  const stub = { artifact: "pendulum-usage-90/result.json", harness: "claude", progressRun: "5552-abcdef012345", standIn: true, usd: null, usdUnknown: 1, usdUnknownWhy: ["unreported"], runs: 1, vendor: { claim: "abcdef012345", usd: 0.6 } };
  const own = { artifact: "pendulum-usage-90/result.json", harness: "claude", progressRun: "5552-abcdef012345", usd: 4, runs: 1, tokens: { input: 1, output: 1, cached: 0, written: 0 }, basis: "harness-reported: total_cost_usd" };
  assert.deepEqual(both(c, [stub, own]), [[4, undefined, 0.6], [4, undefined, 0.6]], "$4 once and the sandbox's $0.60, in either order");
  // A stand-in on an account (no progressRun field) beside the stage's own record on that account and its comment ($7).
  const local = mixedRoute(91, { workKey: "1700000001", work: { usd: 7 }, review: false });
  local.issueComments.at(-1).body += `\n${harnessMarker("claude", "claude-opus-5-5", { harness: "claude", worker: "claude-opus-5-5", account: "alpha" })}`;
  const standIn = { artifact: "usage-work-1/result.json", harness: "claude", account: "alpha", standIn: true, usd: 5, usdUnknown: 1, usdUnknownWhy: ["unreported"], runs: 1 };
  const ownLocal = { artifact: "usage-work-2/result.json", harness: "claude", account: "alpha", progressRun: "1700000001", usd: 7, runs: 1, tokens: { input: 1, output: 1, cached: 0, written: 0 } };
  assert.deepEqual(both(local, [standIn, ownLocal]), [[7, undefined, null], [7, undefined, null]], "never $12 for $7");
});


test("#506 review S1: a local stage's record with no progress comment (progressRun null) takes none of its account's comments", async () => {
  const score = (c) => scoreObjective(c, { prices, now: NOW });
  const account = (body) => `${body}\n${harnessMarker("claude", "claude-opus-5-5", { harness: "claude", worker: "claude-opus-5-5", account: "alpha" })}`;
  const { earlyOutageEnd } = await import("../../plugin/scripts/lib/session.mjs");
  // S1: a local stage the network ended before its comment: its record says it had none (progressRun null) on alpha; the
  // Objective's $5 work comment on alpha still counts.
  const dir = mkdtempSync(join(tmpdir(), "score-early-"));
  const saved = Object.fromEntries(["GITHUB_RUN_ID", "PENDULUM_PROGRESS_RUN", "PENDULUM_STAGE_ACCOUNT", "GITHUB_OUTPUT"].map((k) => [k, process.env[k]]));
  delete process.env.GITHUB_RUN_ID;
  delete process.env.PENDULUM_PROGRESS_RUN;
  Object.assign(process.env, { PENDULUM_STAGE_ACCOUNT: "alpha", GITHUB_OUTPUT: join(dir, "out") });
  try {
    await earlyOutageEnd({ origin: "https://api.github.com", since: Date.now(), code: "ECONNRESET" }, { local: true, usageDir: join(dir, "usage-work-1"), harness: "claude", model: null });
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  const early = JSON.parse(readFileSync(join(dir, "usage-work-1", "result.json"), "utf8"));
  assert.deepEqual([early.progressRun, early.account], [null, "alpha"]);
  const s1 = mixedRoute(92, { workKey: "1700000001", work: { usd: 5 }, review: false });
  s1.issueComments[s1.issueComments.length - 1].body = account(s1.issueComments.at(-1).body);
  s1.usage = [{ ...early, artifact: "usage-work-1/result.json" }];
  assert.equal(score(s1).cost.usd, 5, "the comment's $5, never taken by a record that had no comment");
  rmSync(dir, { recursive: true, force: true });
});

test("#506 review S2: a record from before progressRun on an account takes that account's comments of its own stage only", () => {
  const score = (c) => scoreObjective(c, { prices, now: NOW });
  const account = (body) => `${body}\n${harnessMarker("claude", "claude-opus-5-5", { harness: "claude", worker: "claude-opus-5-5", account: "alpha" })}`;
  // S2: a local work record from before records named their comment (on alpha, no progressRun field) takes alpha's work
  // comments only: alpha's $3 review comment still counts.
  const s2 = mixedRoute(93, { workKey: "1700000001", work: { usd: 5 }, artifact: { artifact: "usage-work-1/result.json", progressRun: undefined, account: "alpha", usd: 5 } });
  s2.issueComments = s2.issueComments.map((x) => (/:progress:/.test(x.body) ? { ...x, body: account(x.body) } : x));
  assert.deepEqual([score(s2).cost.usd, score(s2).cost.usdUnknown], [8, undefined]);
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

test("#506 review N2: an Actions run's artifact never takes a sandbox comment whose claim is all digits", () => {
  const score = (c) => scoreObjective(c, { prices, now: NOW });
  // An all-digit claim never reads as a re-run's attempt: run 5551's artifact is not the sandbox stage 5551-123456789012.
  const digits = mixedRoute(88, { workKey: "5551-123456789012", work: { usd: 4 }, artifact: { progressRun: undefined, workflowRun: 5551 } });
  // It names no comment, so beside the unnamed $4 work comment its $8 may be that stage's: unknown there, never added.
  assert.deepEqual([score(digits).cost.usd, score(digits).cost.usdUnknown, score(digits).cost.usdUnknownWhy], [7, 1, ["unmatched"]]);
});

test("#506 review N3: the row's accounts come from the records and the comments they stand for", () => {
  const score = (c) => scoreObjective(c, { prices, now: NOW });
  const account = (body) => `${body}\n${harnessMarker("claude", "claude-opus-5-5", { harness: "claude", worker: "claude-opus-5-5", account: "alpha" })}`;
  // N3: a record that names its comment but no account: the row's accounts come from that comment's harness line too.
  const n3 = mixedRoute(95, { review: false });
  n3.issueComments[n3.issueComments.length - 1].body = account(n3.issueComments.at(-1).body);
  assert.deepEqual(score(n3).accounts, ["alpha"]);
});

test("#506 re-check: a record that is no stand-in takes the sandbox cost of the comment it stands for when it has none", () => {
  // Probe: the stage's own result.json ($4, no vendor) and its comment, whose vendor comment booked the sandbox's $0.60.
  const c = mixedRoute(97, { workKey: "5552-abcdef012345", work: { usd: 4 }, review: false, artifact: { progressRun: "5552-abcdef012345", usd: 4 } });
  const app = c.issueComments[0].user;
  c.issueComments.push({ user: app, created_at: "2031-03-02T02:00:00Z", body: "<!-- pendulum:97:vendor:work:5552-abcdef012345 -->\nSandbox cost.\n<!-- pendulum:spend {\"usd\":0.6,\"vendorUsd\":0.6} -->" });
  const row = scoreObjective(c, { prices, now: NOW });
  assert.deepEqual([row.cost.usd, row.cost.vendorUsd, row.cost.totalUsd, row.cost.usdUnknown], [4, 0.6, 4.6, undefined]);
});
