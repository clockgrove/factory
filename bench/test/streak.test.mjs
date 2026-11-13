// The rules that let the scorer count the 1.0 streak honestly: a person's Factory workflow run, a manual un-block, an
// answered Question and a local operator's own comment are input; a local merge's consequences are not; dollars come
// from spend lines when no usage artifact exists; a later P1 escape breaks the streak. Invented data, no network.
import "../../plugin/test/temp.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EVENT_PAGES, humanWorkflowRuns, listObjectives } from "../lib/collect.mjs";
import { loadPrices } from "../lib/cost.mjs";
import { drillRecord, humanActions, p1Escapes, scoreObjective, stageHarnessOf } from "../lib/objective.mjs";
import { pooledStreak, pooledTable, streaks, streakTable, tagTime, verdict } from "../lib/streak.mjs";
import { appendScorecard } from "../score.mjs";
import { harnessMarker } from "../../plugin/scripts/lib/logic.mjs";
import { progressTail } from "../../plugin/scripts/lib/session.mjs";
import { blocked, cleanMerge, localMerge, OPERATOR, questionAnswered, REPO } from "./fixtures/github.mjs";

const BENCH = join(import.meta.dirname, "..");
const prices = loadPrices();
const NOW = "2031-03-05T00:00:00Z";
const score = (c) => scoreObjective(c, { prices, now: NOW });
const OWNER = { login: "maintainer", type: "User" };
const run = (id, over = {}) => ({ id, event: "workflow_dispatch", attempt: 1, created_at: "2031-03-02T03:00:00Z", run_started_at: "2031-03-02T03:00:00Z", by: OWNER, issues: [], ...over });

test("the adopter drill's own dispatch, recorded on the Objective it filed, is not input; a person's dispatch or re-run still is", () => {
  // As drill.mjs --dispatch leaves it on clockgrove/factory-scratch#498: the issue's author files it, dispatches run
  // 42936119353 two seconds after the label, and records that run on the issue.
  const WRITER = cleanMerge(42).issue.user;
  const drilled = (runs, by = WRITER) => {
    const c = cleanMerge(42);
    c.issueComments = [...(c.issueComments || []), { user: by, created_at: "2031-03-02T01:00:05Z", body: drillRecord(42, 42936119353) }];
    c.workflowRuns = runs;
    return c;
  };
  const own = score(drilled([run(42936119353, { by: WRITER, created_at: "2031-03-02T01:00:02Z" })]));
  assert.equal(own.walkAway.value, true, "the drill's own tick");
  assert.equal(own.walkAway.humanActions, 0, "its marker comment is not input either");
  // A person's later hand-started tick, another login's run under that id, a record by someone else, a re-run: input.
  assert.equal(score(drilled([run(42936119353, { by: WRITER }), run(77, { by: WRITER })])).walkAway.firstHumanAction.where, "run 77");
  assert.equal(score(drilled([run(42936119353, { by: OWNER })])).walkAway.value, false);
  assert.equal(score(drilled([run(42936119353, { by: OWNER })], OWNER)).walkAway.value, false);
  assert.equal(score(drilled([run(42936119353, { by: WRITER, attempt: 2 })])).walkAway.firstHumanAction.kind, "re-run (attempt 2)");
});

test("a person's dispatch of the Factory workflow while the Objective is live is input: untied counts for every Objective, tied only for its own", () => {
  // cleanMerge: label 01:00, merged 03:30.
  const untied = cleanMerge(42);
  untied.workflowRuns = [run(901)];
  const row = score(untied);
  assert.equal(row.walkAway.value, false);
  assert.equal(row.walkAway.firstHumanAction.kind, "workflow_dispatch");
  assert.equal(row.walkAway.firstHumanAction.where, "run 901");
  assert.match(row.walkAway.firstHumanAction.detail, /tied to no Objective/);
  assert.equal(row.operator.minutes, "unknown");

  const own = cleanMerge(42);
  own.workflowRuns = [run(902, { issues: [42] })];
  assert.equal(score(own).walkAway.value, false);

  // Tied to another Objective, by a bot, or outside the clock-to-merge window: not this Objective's input.
  const other = cleanMerge(42);
  other.workflowRuns = [run(903, { issues: [41] }), run(904, { by: { login: "github-actions[bot]", type: "Bot" } }), run(905, { created_at: "2031-03-02T00:30:00Z" }), run(906, { created_at: "2031-03-02T04:00:00Z" }), run(907, { event: "issues" })];
  const clean = score(other);
  assert.equal(clean.walkAway.value, true);
  assert.ok(!clean.missing.some((m) => /workflow runs/.test(m)));

  // A re-run (attempt 2) of any event is input at the time it was re-run.
  const rerun = cleanMerge(42);
  rerun.workflowRuns = [run(908, { event: "issues", attempt: 2, created_at: "2031-03-02T00:59:00Z", run_started_at: "2031-03-02T02:00:00Z" })];
  const r = score(rerun);
  assert.equal(r.walkAway.firstHumanAction.kind, "re-run (attempt 2)");
  assert.equal(r.walkAway.firstHumanAction.at, "2031-03-02T02:00:00Z");

  // Runs the token could not read are named, never taken as none.
  const unread = cleanMerge(42);
  unread.workflowRuns = null;
  assert.match(score(unread).missing.join(), /workflow runs/);
});

test("collect: the Factory workflow's runs a person dispatched or re-ran in the window, tied by their jobs; 404 is none", async () => {
  const calls = [];
  const runs = [
    { id: 1, event: "workflow_dispatch", run_attempt: 1, created_at: "2031-03-02T02:00:00Z", triggering_actor: OWNER, actor: OWNER },
    { id: 2, event: "workflow_dispatch", run_attempt: 1, created_at: "2031-03-02T02:05:00Z", triggering_actor: { login: "github-actions[bot]", type: "Bot" } },
    { id: 3, event: "issues", run_attempt: 1, created_at: "2031-03-02T02:06:00Z", triggering_actor: OWNER },
    { id: 4, event: "schedule", run_attempt: 3, created_at: "2031-03-02T02:07:00Z", run_started_at: "2031-03-02T02:40:00Z", triggering_actor: OWNER },
  ];
  const jobs = { 1: [{ name: "dispatch", conclusion: "success" }, { name: "work", conclusion: "skipped" }], 4: [{ name: "work (42)", conclusion: "success" }, { name: "review (factory/7)", conclusion: "success" }, { name: "launch (9)", conclusion: "skipped" }] };
  const api = async (path) => {
    calls.push(path);
    const m = /actions\/runs\/(\d+)\/jobs/.exec(path);
    if (m) return [{ total_count: 1, jobs: jobs[m[1]] }];
    return [{ total_count: runs.length, workflow_runs: runs }];
  };
  const c = cleanMerge(42);
  const got = await humanWorkflowRuns(api, REPO, c.issue, c.issueTimeline, c.pulls);
  assert.deepEqual(got.map((r) => [r.id, r.attempt, r.issues]), [[1, 1, []], [4, 3, [42, 7]]]);
  assert.equal(got[1].run_started_at, "2031-03-02T02:40:00Z");
  // The window is the first Objective label to the merge, on the Factory workflow's own runs.
  assert.equal(calls[0], `repos/${REPO}/actions/workflows/factory.yml/runs?created=${encodeURIComponent("2031-03-02T01:00:00Z..2031-03-02T03:30:00Z")}&per_page=100`);
  const none = async () => {
    const e = new Error("not found");
    e.status = 404;
    throw e;
  };
  assert.deepEqual(await humanWorkflowRuns(none, REPO, c.issue, c.issueTimeline, c.pulls), []);
});

test("local mode: a clean run reads walk-away though the operator's login merged, closed and deleted the branch long after the last stage", () => {
  const row = score(localMerge());
  assert.deepEqual(humanActions(localMerge(), "2031-03-02T01:00:00Z"), []);
  assert.equal(row.walkAway.value, true, row.walkAway.reason);
  assert.deepEqual(row.operator, { minutes: 0, basis: "clean merge" });
});

test("local mode: dollars and harness from the spend lines when no usage artifact exists; a stage without one is unmetered", () => {
  const row = score(localMerge());
  assert.equal(row.cost.usd, 1.5);
  assert.equal(row.cost.unit, "usd");
  assert.equal(row.harness, "codex");
  assert.equal(row.model, "gpt-test");
  assert.match(row.cost.basis, /factory:spend lines in 2 progress comment\(s\), the worker's own pricing/);
  assert.equal(row.activity.workRuns, 1);
  assert.equal(row.activity.reviewRuns, 1);
  assert.ok(!row.missing.includes("usage artifact"));
  // A spend line pasted by someone else is not Factory's.
  const pasted = localMerge();
  pasted.issueComments.push({ user: OWNER, created_at: "2031-03-02T01:55:00Z", body: "<!-- factory:60:progress:work:1 -->\n<!-- factory:spend {\"usd\":100} -->" });
  assert.equal(score(pasted).cost.usd, 1.5);
  // A stage that wrote no spend line leaves the figure partial, never complete.
  const partial = localMerge();
  partial.issueComments[2].body = partial.issueComments[2].body.replace(/\n<!-- factory:spend .*-->/, "");
  const p = score(partial);
  assert.equal(p.cost.usd, 1.25);
  assert.match(p.cost.basis, /^partial: 1 of 2/);
  // An Actions Objective with no artifact and no spend line still says it has no usage.
  const actions = score(cleanMerge(42));
  assert.equal(actions.cost.usd, null);
  assert.ok(actions.missing.includes("usage artifact"));
});

test("local mode: an operator's own comment inside a run's window is input; Factory's marker comments are not", () => {
  const c = localMerge();
  // Inside the work stage's window (01:01 to 01:40): an answer typed while the stage ran.
  c.pullDetails[200].comments.push({ user: OPERATOR, created_at: "2031-03-02T01:30:00Z", body: "Answer: yes, keep the header." });
  const row = score(c);
  assert.equal(row.walkAway.value, false);
  assert.equal(row.walkAway.firstHumanAction.kind, "comment");
  assert.equal(row.walkAway.firstHumanAction.where, "PR #200");
  // An issue label other than Factory's state labels is a person's, inside the window or not.
  const l = localMerge();
  l.issueTimeline.push({ event: "labeled", label: { name: "P1" }, actor: OPERATOR, created_at: "2031-03-02T01:10:00Z" });
  assert.equal(score(l).walkAway.firstHumanAction.kind, "labeled P1");
});

test("local mode: a manual un-block is input; Factory's own un-block after a re-applied label is not, the relabel is", () => {
  const blockedThenCleared = () => {
    const c = localMerge();
    c.issueTimeline.push(
      { event: "unlabeled", label: { name: "factory:in-review" }, actor: OPERATOR, created_at: "2031-03-02T01:49:00Z" },
      { event: "labeled", label: { name: "factory:blocked" }, actor: OPERATOR, created_at: "2031-03-02T01:49:01Z" },
    );
    c.issueComments.push({ user: OPERATOR, created_at: "2031-03-02T01:49:03Z", body: "<!-- factory:60:blocked:review:1 -->\n@dev Blocked (review): the merge failed" });
    return c;
  };
  const manual = blockedThenCleared();
  // Removed by hand a minute later, still inside the review stage's window, with no relabel.
  manual.issueTimeline.push({ event: "unlabeled", label: { name: "factory:blocked" }, actor: OPERATOR, created_at: "2031-03-02T01:50:30Z" });
  const row = score(manual);
  assert.equal(row.walkAway.value, false);
  assert.equal(row.walkAway.humanActions, 1);
  assert.equal(row.walkAway.firstHumanAction.kind, "unlabeled factory:blocked");
  assert.equal(row.walkAway.firstHumanAction.asked, "blocked");

  const relabel = blockedThenCleared();
  relabel.issueTimeline.push({ event: "labeled", label: { name: "factory:objective" }, actor: OPERATOR, created_at: "2031-03-02T01:50:20Z" }, { event: "unlabeled", label: { name: "factory:blocked" }, actor: OPERATOR, created_at: "2031-03-02T01:50:30Z" });
  const r = score(relabel);
  assert.deepEqual(r.walkAway.firstHumanAction && [r.walkAway.firstHumanAction.kind, r.walkAway.humanActions], ["labeled factory:objective", 1]);
});

test("an answered Question is input even when the answer is nowhere the scorer reads", () => {
  const c = cleanMerge(42);
  // Factory asked (its label), then picked the Objective up again: someone answered somewhere.
  c.issueTimeline.push({ event: "labeled", label: { name: "factory:question" }, actor: { login: "acme-factory[bot]", type: "Bot" }, created_at: "2031-03-02T01:30:00Z" }, { event: "labeled", label: { name: "factory:running" }, actor: { login: "acme-factory[bot]", type: "Bot" }, created_at: "2031-03-02T02:00:00Z" });
  const row = score(c);
  assert.equal(row.walkAway.value, false);
  assert.equal(row.walkAway.firstHumanAction.kind, "answered Question");
  assert.equal(row.walkAway.firstHumanAction.asked, "question");
  assert.equal(row.walkAway.askedOnly.value, false);
  // An answer the scorer does see is counted once, not twice.
  const seen = score(questionAnswered(45));
  assert.equal(seen.walkAway.humanActions, 2);
  assert.ok(!seen.walkAway.firstHumanAction.kind.includes("answered Question"));
});

test("P1 escapes: an issue labelled P1, opened after the merge, that references the merged PR, a P1 Objective among them; earlier issues are not", () => {
  const c = cleanMerge(42);
  const ref = (number, labels, created_at, extra = {}) => ({ event: "cross-referenced", created_at, source: { type: "issue", issue: { number, title: `issue ${number}`, created_at, labels: labels.map((name) => ({ name })), repository: { full_name: REPO }, ...extra } } });
  c.pullDetails[100].timeline.push(
    ref(70, ["P1"], "2031-03-03T00:00:00Z"),
    ref(71, ["P1"], "2031-03-01T00:00:00Z"), // a tracker opened before the merge
    ref(72, ["P1", "factory:objective"], "2031-03-03T00:00:00Z"), // the escape filed as an Objective to fix it
    ref(42, ["P1", "factory:objective"], "2031-03-03T00:00:00Z"), // the Objective itself
    ref(73, ["P2"], "2031-03-03T00:00:00Z"),
    ref(74, ["P1"], "2031-03-03T00:00:00Z", { pull_request: {} }),
  );
  assert.deepEqual(p1Escapes(c, c.pulls[0]).map((e) => e.issue), [`${REPO}#70`, `${REPO}#72`]);
  const row = score(c);
  assert.equal(row.quality.escapes[0].priority, "P1");
  assert.match(verdict({ ...row, walkAway: { ...row.walkAway, value: true } }).why, /P1 escape: acme\/widgets#70, acme\/widgets#72/);
  // The standing scorecard keeps hand-filled escapes beside the found ones, once per issue: a hand-filled string naming
  // a found issue is that issue. A found one no longer found (its P1 label removed) is dropped; a hand-filled one stays.
  const standing = ["acme/widgets#80 (P1, by hand)", "acme/widgets#70 P1", { issue: `${REPO}#81`, priority: "P1" }, { issue: `${REPO}#85`, priority: "P1", source: "references PR #100" }];
  const card = appendScorecard({ rows: [{ repository: REPO, issue: 42, quality: { escapes: standing } }] }, [row]);
  assert.deepEqual(card.rows[0].quality.escapes.map((e) => (typeof e === "string" ? e : e.issue)), [`${REPO}#70`, `${REPO}#72`, "acme/widgets#80 (P1, by hand)", `${REPO}#81`]);
});

const row = (issue, over = {}) => ({ issue, harness: "claude", exit: "merged", mergedAt: `2031-03-0${issue % 9 + 1}T00:00:00Z`, closedAt: null, walkAway: { value: true, since: "2031-03-01T00:00:00Z", reason: "merged with no human action after the label", blocked: null, unseen: [] }, quality: { escapes: [] }, ...over });

test("streaks: consecutive walk-away merges per harness in the order they ended; input, Blocked, an unmerged end and a P1 escape break it", () => {
  const rows = [
    row(1),
    row(2),
    row(3, { quality: { escapes: [{ issue: "acme/widgets#90", priority: "P1" }] } }),
    row(4),
    row(5),
    row(6, { harness: "codex", exit: "blocked", mergedAt: null, walkAway: { value: false, since: "2031-03-01T00:00:00Z", reason: "not merged (blocked)", blocked: { at: "2031-03-02T00:00:00Z" } } }),
    row(7, { harness: "codex" }),
    row(8, { harness: "codex", exit: "in review", mergedAt: null }),
    row(9, { walkAway: { value: true, since: "2031-02-27T00:00:00Z", unseen: [] } }), // started before the tag
    row(10, { harness: "codex", exit: "closed unmerged", mergedAt: null, closedAt: "2031-03-09T00:00:00Z", walkAway: { value: false, since: "2031-03-01T00:00:00Z", reason: "not merged (closed unmerged)" } }),
  ];
  const s = streaks(rows, { from: "2031-02-28T00:00:00Z" });
  assert.deepEqual([s.harnesses.claude.current, s.harnesses.claude.best, s.harnesses.claude.walkAway, s.harnesses.claude.finished], [2, 2, 4, 5]);
  assert.deepEqual(s.harnesses.claude.sequence.map((x) => [x.issue, x.ok]), [[1, true], [2, true], [3, false], [4, true], [5, true]]);
  assert.match(s.harnesses.claude.sequence[2].why, /P1 escape: acme\/widgets#90/);
  assert.deepEqual([s.harnesses.codex.current, s.harnesses.codex.best, s.harnesses.codex.inFlight], [0, 1, [8]]);
  assert.deepEqual(s.harnesses.codex.sequence.map((x) => x.issue), [6, 7, 10]);
  assert.deepEqual(s.before, [9]);
  const md = streakTable(s, { repository: REPO, tag: "v9.9.9" });
  assert.match(md, /^\| claude \| 2 \| 2 \| 4 \/ 5 \| none \|$/m);
  assert.match(md, /^\| codex \| 0 \| 1 \| 1 \/ 3 \| #8 \|$/m);
  assert.match(md, /Left out \(clock started before v9\.9\.9\): #9/);
  // The header names every break, a stall among them (walk-away includes the stall check).
  assert.match(md, /Blocked, a stall, an unmerged end, a later P1 escape or an input source not read breaks it/);
});

test("tagTime: the tag's Release time, else its commit's date", async () => {
  const api = (answers) => async (path) => {
    if (path in answers) return answers[path];
    const e = new Error("404");
    e.status = 404;
    throw e;
  };
  assert.equal(await tagTime(api({ "repos/acme/factory/releases/tags/v1.2.3": { published_at: "2031-03-01T10:00:00Z" } }), "acme/factory", "v1.2.3"), "2031-03-01T10:00:00Z");
  assert.equal(await tagTime(api({ "repos/acme/factory/commits/v1.2.3": { commit: { committer: { date: "2031-03-01T09:00:00Z" } } } }), "acme/factory", "v1.2.3"), "2031-03-01T09:00:00Z");
});

test("score.mjs --streak --since TAG over a snapshot prints the streak per harness", () => {
  const dir = mkdtempSync(join(tmpdir(), "factory-bench-streak-"));
  const clean = cleanMerge(42);
  const local = localMerge(60);
  const dispatched = cleanMerge(43);
  dispatched.workflowRuns = [run(901)];
  const snapshot = { repository: REPO, issues: [42, 43, 60], calls: { "repos/acme/factory/releases/tags/v9.9.9": { published_at: "2031-03-01T00:00:00Z" } }, collected: { 42: clean, 43: dispatched, 60: local } };
  const file = join(dir, "snapshot.json");
  writeFileSync(file, JSON.stringify(snapshot));
  const out = execFileSync("node", [join(BENCH, "score.mjs"), "--replay", file, "--streak", "--since", "v9.9.9", "--factory", "acme/factory", "--out", join(dir, "rows.json")], { encoding: "utf8", cwd: dir });
  assert.match(out, /^Streak on acme\/widgets from v9\.9\.9 \(2031-03-01T00:00:00Z\)/);
  // #60 (codex) merged first. #42 and #43 record no harness; #43's hand-started dispatch breaks every harness's streak.
  assert.match(out, /^\| codex \| 0 \| 1 \| 1 \/ 1 \| none \|$/m);
  assert.match(out, /^\| unknown \| 0 \| 1 \| 1 \/ 2 \| none \|$/m);
  assert.match(out, /^codex, oldest first:\n- #60 [^\n]*: yes\n- #43 2031-03-02T03:30:00Z: no: harness unknown, breaks every harness: first human action: workflow_dispatch on run 901/m);
  const saved = JSON.parse(readFileSync(join(dir, "rows.json"), "utf8"));
  assert.equal(saved.streak.tag, "v9.9.9");
});

test("streaks: a row with an input source not read never extends a streak, and the table says why", () => {
  // Without actions: read, the workflow runs read null: a person's rescue dispatch may hide there.
  const c = cleanMerge(52);
  c.workflowRuns = null;
  c.issueComments.push({ user: { login: "acme-factory[bot]", type: "Bot" }, created_at: "2031-03-02T01:06:00Z", body: `<!-- factory:52:progress:work:7 -->\n- 01:06Z harness claude (claude-test) attempt 1` });
  const r = score(c);
  assert.equal(r.harness, "claude");
  assert.deepEqual(r.walkAway.unseen, ["workflow runs"]);
  const edits = cleanMerge(53);
  edits.bodyEdits = null;
  assert.deepEqual(score(edits).walkAway.unseen, ["body edits"]);
  const s = streaks([row(1), r, row(3)], { from: "2031-02-28T00:00:00Z" });
  assert.deepEqual([s.harnesses.claude.current, s.harnesses.claude.best, s.harnesses.claude.walkAway], [1, 1, 2]);
  const md = streakTable(s, { repository: REPO });
  assert.match(md, /- #52 2031-03-02T03:30:00Z: no: input not readable \(workflow runs\): walk-away unproven/);
  // A row from before the scorer recorded its unread sources is unproven too.
  const old = row(4);
  delete old.walkAway.unseen;
  assert.equal(verdict(old).ok, false);
});

test("streaks: a row with no harness that breaks breaks every harness's streak; one that is clean extends none", () => {
  const rows = [row(1), row(2, { harness: "codex" }), row(3, { harness: null }), row(4), row(5, { harness: null, mergedAt: null, exit: "blocked", walkAway: { value: false, since: "2031-03-01T00:00:00Z", reason: "not merged (blocked)", blocked: { at: "2031-03-06T00:00:00Z" }, unseen: [] } }), row(7)];
  const s = streaks(rows, { from: "2031-02-28T00:00:00Z" });
  // claude: #1, #4 (the clean unknown #3 credits no harness), broken by #5, then #7.
  assert.deepEqual(s.harnesses.claude.sequence.map((x) => [x.issue, x.ok]), [[1, true], [4, true], [5, false], [7, true]]);
  assert.deepEqual([s.harnesses.claude.current, s.harnesses.claude.best, s.harnesses.claude.finished], [1, 2, 3]);
  assert.deepEqual([s.harnesses.codex.current, s.harnesses.codex.best], [0, 1]);
  assert.match(s.harnesses.codex.sequence.at(-1).why, /^harness unknown, breaks every harness: not merged \(blocked\)/);
  assert.deepEqual(s.harnesses.unknown.sequence.map((x) => [x.issue, x.ok]), [[3, true], [5, false]]);
});

test("harness from structure: Factory's harness line, else its start line with or without a model; two harnesses read none", () => {
  const APP = { login: "acme-factory[bot]", type: "Bot" };
  const stage = (n, kind, id, tail, user = APP) => ({ user, created_at: `2031-03-02T01:0${id}:00Z`, body: `<!-- factory:${n}:progress:${kind}:${id} -->\nFactory ${kind} run ${id}\n- 01:0${id}Z setup${tail}` });
  // An Actions Objective Blocked before any spend, with no usage artifact: the stage's harness line still names it.
  const b = cleanMerge(46);
  b.issueComments.push(stage(46, "work", 1, progressTail({ harness: "codex", model: "gpt-test" })));
  assert.equal(stageHarnessOf(harnessMarker("codex", "gpt-test")).harness, "codex");
  assert.equal(score(b).harness, "codex");
  // Copilot runs with no model set (its default): the start line has no "(model)".
  const cp = cleanMerge(47);
  cp.issueComments.push(stage(47, "work", 1, "\n- 01:02Z harness copilot attempt 1"));
  assert.equal(score(cp).harness, "copilot");
  const local = localMerge();
  local.issueComments[0].body = local.issueComments[0].body.replace("harness codex (gpt-test) attempt 1", "harness copilot attempt 1");
  assert.equal(score(local).harness, "copilot");
  // A relabel that switched harness: neither is credited.
  const mixed = cleanMerge(48);
  mixed.issueComments.push(stage(48, "work", 1, "\n- 01:02Z harness claude (claude-test) attempt 1"), stage(48, "work", 2, "\n- 01:03Z harness codex (gpt-test) attempt 1"));
  const m = score(mixed);
  assert.equal(m.harness, null);
  assert.equal(m.harnessMixed, true);
  // Anyone else's comment naming a harness is not Factory's.
  const pasted = cleanMerge(49);
  pasted.issueComments.push(stage(49, "work", 1, `\n${harnessMarker("claude")}`, OWNER));
  assert.equal(score(pasted).harness, null);
});

test("local mode: Factory's own triage re-run (attempt 2 on a head its triage record names) is not input; a person's re-run is", () => {
  const rerun = (by) => run(950, { event: "pull_request", attempt: 2, created_at: "2031-03-02T01:25:00Z", run_started_at: "2031-03-02T01:35:00Z", head_sha: "cafe0001", by, issues: [] });
  const triaged = () => {
    const c = localMerge();
    c.issueComments[0].body += `\n<!-- factory:triage {"reruns":["cafe0001"],"sigs":["s1"]} -->`;
    return c;
  };
  const own = triaged();
  own.workflowRuns = [rerun(OPERATOR)];
  assert.equal(score(own).walkAway.value, true, score(own).walkAway.reason);
  // No triage record for that head: the operator's login re-ran it by hand.
  const manual = localMerge();
  manual.workflowRuns = [rerun(OPERATOR)];
  assert.equal(score(manual).walkAway.firstHumanAction.kind, "re-run (attempt 2)");
  // Another person's re-run, or a triage record pasted by someone else, is not Factory's.
  const other = triaged();
  other.workflowRuns = [rerun(OWNER)];
  assert.equal(score(other).walkAway.value, false);
  const pasted = localMerge();
  pasted.issueComments.push({ user: OWNER, created_at: "2031-03-02T01:30:00Z", body: `<!-- factory:60:progress:work:9 -->\n<!-- factory:triage {"reruns":["cafe0001"]} -->` });
  pasted.workflowRuns = [rerun(OPERATOR)];
  assert.equal(score(pasted).walkAway.value, false);
});

test("collect: more runs than GitHub lists for a created filter is unread, never a short list; head_sha is kept", async () => {
  const c = cleanMerge(42);
  const many = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, event: "schedule", run_attempt: 1, created_at: "2031-03-02T02:00:00Z", triggering_actor: OWNER }));
  const capped = async (path) => (/\/jobs/.test(path) ? [{ jobs: [] }] : [{ total_count: 1500, workflow_runs: many }]);
  await assert.rejects(humanWorkflowRuns(capped, REPO, c.issue, c.issueTimeline, c.pulls), /1500 Factory workflow runs in the window/);
  const one = async (path) => (/\/jobs/.test(path) ? [{ jobs: [] }] : [{ total_count: 1, workflow_runs: [{ id: 5, event: "workflow_dispatch", run_attempt: 1, created_at: "2031-03-02T02:00:00Z", head_sha: "cafe0001", triggering_actor: OWNER }] }]);
  assert.equal((await humanWorkflowRuns(one, REPO, c.issue, c.issueTimeline, c.pulls))[0].head_sha, "cafe0001");
});

test("streakTable: a backslash or pipe in a cell cannot break the Markdown row", () => {
  const s = streaks([row(1, { harness: "c\\|x" })], { from: "2031-02-28T00:00:00Z" });
  const md = streakTable(s, { repository: "o/r" });
  assert.ok(md.includes("| c\\\\\\|x |"), md);
  assert.ok(!md.includes("| c\\|x |"), md);
});

test("sandbox stages: the vendor comment's dollars sit beside the progress comment's model dollars; one without a progress comment is its own row", async () => {
  const { spendRecords } = await import("../lib/objective.mjs");
  const app = { login: "factory-app[bot]", type: "Bot" };
  const at = "2031-03-02T03:00:00Z";
  const c = (body) => ({ user: app, created_at: at, body });
  const collected = {
    issue: { number: 48, labels: [] },
    issueTimeline: [{ event: "labeled", label: { name: "factory:running" }, actor: app }],
    issueComments: [
      c('<!-- factory:48:progress:work:9-0123456789ab -->\nFactory work run 9-0123456789ab.\n<!-- factory:spend {"usd":0.5} -->'),
      c('<!-- factory:48:vendor:work:9-0123456789ab -->\nFactory\'s sandbox cost for this stage:\n- 03:10Z sandbox `factory-a` stopped\n<!-- factory:spend {"usd":0.02,"vendorUsd":0.02} -->'),
      c('<!-- factory:48:vendor:review:10-ba9876543210 -->\nFactory\'s sandbox cost for this stage:\n- 03:30Z sandbox `factory-a` stopped\n<!-- factory:spend {"usd":0.33,"modelUsd":0.3,"vendorUsd":0.03} -->'),
      // An older stage's progress spend line, model and vendor in one.
      c('<!-- factory:48:progress:review:8-aaaaaaaaaaaa -->\nFactory review run 8.\n<!-- factory:spend {"usd":0.45,"modelUsd":0.4,"vendorUsd":0.05} -->'),
    ],
  };
  const rows = spendRecords(collected);
  assert.deepEqual(rows.map((r) => [r.usd, r.vendor?.usd ?? null]), [[0.5, 0.02], [0.4, 0.05], [0.3, 0.03]]);
  // A booking is not an act of Factory's: the sweep's late vendor comment leaves a dead stage's wait idle.
  const { factoryActivity } = await import("../lib/objective.mjs");
  const late = { ...collected, issueComments: [{ ...collected.issueComments[1], created_at: "2031-03-02T09:00:00Z" }] };
  assert.deepEqual(factoryActivity(late), []);
});

test("sandbox stages: the record's launches are read merged as the plugin reads them, a stage's own entry included", async () => {
  const { factoryLogin, launchesOf } = await import("../lib/phases.mjs");
  const { marker, sandboxMarkerLine } = await import("../../plugin/scripts/lib/logic.mjs");
  const app = { login: "factory-app[bot]", type: "Bot" };
  const self = factoryLogin(null, app.login);
  const claim = "0123456789ab";
  const comments = [
    { id: 1, user: app, body: `${marker(48, "sandbox")}\n${sandboxMarkerLine({ state: "running", claim, stage: "work", launches: [] })}` },
    // The launcher's post-start write never came; the stage's part carries the start.
    { id: 2, user: app, body: `${marker(48, "stage", claim)}\n${sandboxMarkerLine({ state: "running", at: "2031-03-02T03:01:00Z", launch: { stage: "work", ok: true, run: "9", cue: "stint-1", event: "pull_request", eventAt: "2031-03-02T03:00:00Z" } })}` },
  ];
  assert.deepEqual(launchesOf(comments, 48, self), [{ stage: "work", run: "9", event: "pull_request", at: Date.parse("2031-03-02T03:00:00Z") }]);
});

test("listObjectives: an issue whose label was removed after --since, once Factory took it, is listed; the event history is read only back to --since", async () => {
  const SINCE = "2031-03-01T00:00:00Z";
  const ev = (event, name, issue, created_at, extra = {}) => ({ event, label: { name }, created_at, issue: { number: issue, ...extra } });
  const page1 = [
    ev("unlabeled", "factory:objective", 77, "2031-03-04T00:00:00Z"), // parked: started below, label removed later
    ev("unlabeled", "factory:objective", 78, "2031-03-04T00:00:00Z"), // removed before Factory ever took it
    ev("unlabeled", "factory:objective", 79, "2031-03-04T00:00:00Z", { pull_request: {} }),
    ev("labeled", "factory:blocked", 77, "2031-03-03T00:00:00Z"),
    ev("labeled", "factory:running", 77, "2031-03-02T00:00:00Z"),
    ...Array.from({ length: 95 }, (_, i) => ev("labeled", "P2", 200 + i, "2031-03-02T00:00:00Z")),
  ];
  // The second page crosses --since: events older than it are not read as removals, and no third page is asked for.
  const page2 = [ev("labeled", "factory:running", 80, "2031-03-01T01:00:00Z"), ev("unlabeled", "factory:objective", 80, "2031-02-20T00:00:00Z"), ev("unlabeled", "factory:objective", 81, "2031-02-20T00:00:00Z"), ev("labeled", "factory:running", 81, "2031-02-19T00:00:00Z")];
  const calls = [];
  const api = async (path) => {
    calls.push(path);
    if (path.startsWith(`repos/${REPO}/issues?`)) return [{ number: 42, state: "closed", closed_at: "2031-03-02T00:00:00Z", labels: [{ name: "factory:objective" }] }, { number: 43, state: "open", labels: [{ name: "factory:objective" }, { name: "factory:running" }] }, { number: 44, state: "open", labels: [{ name: "factory:objective" }] }];
    const page = Number(/[?&]page=(\d+)/.exec(path)?.[1]);
    return { 1: page1, 2: page2 }[page] ?? [];
  };
  assert.deepEqual(await listObjectives(api, REPO, { since: SINCE }), [42, 43, 77]);
  assert.deepEqual(calls.slice(1), [`repos/${REPO}/issues/events?per_page=100&page=1`, `repos/${REPO}/issues/events?per_page=100&page=2`]);
  // A history longer than the page bound fails, never lists short.
  const full = async (path) => (path.includes("/events?") ? Array.from({ length: 100 }, () => ev("labeled", "P2", 1, "2031-03-02T00:00:00Z")) : []);
  await assert.rejects(listObjectives(full, REPO, { since: SINCE, maxEventPages: 2 }), /more than 200 issue events/);
  assert.ok(EVENT_PAGES >= 10);
});

test("a parked Objective is a row: stopped when Blocked, in flight when its Question waits, never a walk-away", () => {
  const OWNER_ = { login: "maintainer", type: "User" };
  const park = (c, at) => {
    c.issue.labels = [];
    c.issueTimeline.push({ event: "unlabeled", label: { name: "factory:objective" }, actor: OWNER_, created_at: at });
    return c;
  };
  const stopped = score(park(blocked(70), "2031-03-02T05:00:00Z"));
  assert.deepEqual([stopped.parked, stopped.exit, stopped.walkAway.value], [true, "blocked", false]);
  const waiting = blocked(71);
  waiting.issueTimeline = waiting.issueTimeline.map((e) => (e.label?.name === "factory:blocked" ? { ...e, label: { name: "factory:question" } } : e));
  waiting.issueComments = waiting.issueComments.slice(0, 1);
  const asked = score(park(waiting, "2031-03-02T05:00:00Z"));
  assert.deepEqual([asked.parked, asked.exit, asked.walkAway.value], [true, "question", false]);
  const s = streaks([stopped, asked], { from: "2031-02-28T00:00:00Z" });
  assert.deepEqual(s.harnesses.unknown.sequence.map((x) => [x.issue, x.ok]), [[70, false]]);
  assert.deepEqual(s.harnesses.unknown.inFlight, [71]);
  const p = pooledStreak([stopped, asked], { from: "2031-02-28T00:00:00Z" });
  assert.deepEqual([p.finished, p.inFlight], [1, [{ repository: REPO, issue: 71 }]]);
  // A labelled Objective is not parked.
  assert.equal(score(blocked(72)).parked, false);
});

test("pooledStreak: two repositories' rows in the order they ended, any harness; any miss resets it", () => {
  const A = "acme/widgets";
  const B = "acme/gadgets";
  const at = (d) => `2031-03-${String(d).padStart(2, "0")}T00:00:00Z`;
  const r = (repository, issue, day, over = {}) => row(issue, { repository, mergedAt: at(day), ...over });
  const rows = [
    r(A, 1, 2),
    r(B, 1, 3, { harness: "codex" }), // the same issue number in another repository is its own entry
    r(A, 2, 4, { harness: null, walkAway: { value: false, since: at(1), reason: "first human action: comment", unseen: [] } }),
    r(B, 2, 5, { harness: "copilot" }),
    r(A, 3, 6),
    r(B, 3, 7, { harness: null }), // unknown harness, clean: it still extends the pooled streak
    r(A, 4, 8, { exit: "in review", mergedAt: null }),
    r(B, 4, 9, { walkAway: { value: true, since: "2031-02-20T00:00:00Z", unseen: [] } }),
  ];
  const p = pooledStreak(rows, { from: "2031-02-28T00:00:00Z" });
  assert.deepEqual(p.sequence.map((x) => [x.repository, x.issue, x.harness, x.ok]), [[A, 1, "claude", true], [B, 1, "codex", true], [A, 2, "unknown", false], [B, 2, "copilot", true], [A, 3, "claude", true], [B, 3, "unknown", true]]);
  assert.deepEqual([p.current, p.best, p.walkAway, p.finished], [3, 3, 5, 6]);
  assert.deepEqual(p.inFlight, [{ repository: A, issue: 4 }]);
  assert.deepEqual(p.before, [{ repository: B, issue: 4 }]);
  const md = pooledTable(p, { repositories: [A, B], tag: "v9.9.9" });
  assert.match(md, /^Pooled streak across acme\/widgets, acme\/gadgets from v9\.9\.9/);
  assert.match(md, /^\| 3 \| 3 \| 5 \/ 6 \| acme\/widgets#4 \|$/m);
  assert.match(md, /^- acme\/widgets#2 \(unknown\) 2031-03-04T00:00:00Z: no: first human action: comment$/m);
  assert.match(md, /Left out \(clock started before v9\.9\.9\): acme\/gadgets#4/);
});

test("score.mjs: several --repo values need --streak and --since, and take no issue-keyed option", () => {
  const fail = (args) => {
    try {
      execFileSync("node", [join(BENCH, "score.mjs"), ...args], { encoding: "utf8", stdio: "pipe" });
      return 0;
    } catch (e) {
      return [e.status, e.stderr];
    }
  };
  assert.deepEqual(fail(["--repo", "a/x", "--repo", "b/y", "--since", "v9.9.9"])[0], 64);
  const [code, err] = fail(["--repo", "a/x", "--repo", "b/y", "--streak", "--since", "v9.9.9", "--issue", "3"]);
  assert.equal(code, 64);
  assert.match(err, /--issue takes one --repo/);
});
