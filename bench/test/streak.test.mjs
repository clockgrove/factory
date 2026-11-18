// The rules that let the scorer count the 1.0 streak honestly: a person's Pendulum workflow run, a manual un-block, an
// answered Question and a local operator's own comment are input; a local merge's consequences are not; dollars come
// from spend lines when no usage artifact exists; a later P1 escape breaks the streak. Invented data, no network.
import "../../plugin/test/temp.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { humanWorkflowRuns } from "../lib/collect.mjs";
import { loadPrices } from "../lib/cost.mjs";
import { humanActions, p1Escapes, scoreObjective } from "../lib/objective.mjs";
import { pooledStreak, pooledTable, streaks, streakTable, verdict } from "../lib/streak.mjs";
import { appendScorecard } from "../score.mjs";
import { PREVIOUS_NAME } from "../../plugin/scripts/lib/local.mjs";
import { blocked, cleanMerge, localMerge, OPERATOR, REPO } from "./fixtures/github.mjs";

const BENCH = join(import.meta.dirname, "..");
const prices = loadPrices();
const NOW = "2031-03-05T00:00:00Z";
const score = (c) => scoreObjective(c, { prices, now: NOW });
const OWNER = { login: "maintainer", type: "User" };
const run = (id, over = {}) => ({ id, event: "workflow_dispatch", attempt: 1, created_at: "2031-03-02T03:00:00Z", run_started_at: "2031-03-02T03:00:00Z", by: OWNER, issues: [], ...over });

test("a person's dispatch of the Pendulum workflow while the Objective is live is input: untied counts for every Objective, tied only for its own", () => {
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

test("local mode: a clean run reads walk-away though the operator's login merged, closed and deleted the branch long after the last stage", () => {
  const row = score(localMerge());
  assert.deepEqual(humanActions(localMerge(), "2031-03-02T01:00:00Z"), []);
  assert.equal(row.walkAway.value, true, row.walkAway.reason);
  assert.deepEqual(row.operator, { minutes: 0, basis: "clean merge" });
});

test("local mode: dollars and harness from the spend lines when no usage artifact exists; a stage without one is of unknown cost", () => {
  const row = score(localMerge());
  assert.equal(row.cost.usd, 1.5);
  assert.equal(row.cost.unit, "usd");
  assert.equal(row.harness, "codex");
  assert.equal(row.model, "gpt-test");
  assert.match(row.cost.basis, /pendulum:spend lines in 2 progress comment\(s\), the worker's own pricing/);
  assert.equal(row.activity.workRuns, 1);
  assert.equal(row.activity.reviewRuns, 1);
  assert.ok(!row.missing.includes("usage artifact"));
  // A spend line pasted by someone else is not Pendulum's.
  const pasted = localMerge();
  pasted.issueComments.push({ user: OWNER, created_at: "2031-03-02T01:55:00Z", body: "<!-- pendulum:60:progress:work:1 -->\n<!-- pendulum:spend {\"usd\":100} -->" });
  assert.equal(score(pasted).cost.usd, 1.5);
  // A stage that wrote no spend line is a run of unknown cost beside the known figure, never $0.
  const partial = localMerge();
  partial.issueComments[2].body = partial.issueComments[2].body.replace(/\n<!-- pendulum:spend .*-->/, "");
  const p = score(partial);
  assert.equal(p.cost.usd, 1.25);
  assert.equal(p.cost.usdUnknown, 1);
  assert.match(p.cost.basis, /; plus 1 run of unknown cost \(the run ended before its harness reported its cost\)$/);
  // An Actions Objective with no artifact and no spend line still says it has no usage.
  const actions = score(cleanMerge(42));
  assert.equal(actions.cost.usd, null);
  assert.ok(actions.missing.includes("usage artifact"));
});

test("local mode: an operator's own comment inside a run's window is input; Pendulum's marker comments are not", () => {
  const c = localMerge();
  // Inside the work stage's window (01:01 to 01:40): an answer typed while the stage ran.
  c.pullDetails[200].comments.push({ user: OPERATOR, created_at: "2031-03-02T01:30:00Z", body: "Answer: yes, keep the header." });
  const row = score(c);
  assert.equal(row.walkAway.value, false);
  assert.equal(row.walkAway.firstHumanAction.kind, "comment");
  assert.equal(row.walkAway.firstHumanAction.where, "PR #200");
  // An issue label other than Pendulum's state labels is a person's, inside the window or not.
  const l = localMerge();
  l.issueTimeline.push({ event: "labeled", label: { name: "P1" }, actor: OPERATOR, created_at: "2031-03-02T01:10:00Z" });
  assert.equal(score(l).walkAway.firstHumanAction.kind, "labeled P1");
});

test("P1 escapes: an issue labelled P1, opened after the merge, that references the merged PR, a P1 Objective among them; earlier issues are not", () => {
  const c = cleanMerge(42);
  const ref = (number, labels, created_at, extra = {}) => ({ event: "cross-referenced", created_at, source: { type: "issue", issue: { number, title: `issue ${number}`, created_at, labels: labels.map((name) => ({ name })), repository: { full_name: REPO }, ...extra } } });
  c.pullDetails[100].timeline.push(
    ref(70, ["P1"], "2031-03-03T00:00:00Z"),
    ref(71, ["P1"], "2031-03-01T00:00:00Z"), // a tracker opened before the merge
    ref(72, ["P1", "pendulum:objective"], "2031-03-03T00:00:00Z"), // the escape filed as an Objective to fix it
    ref(42, ["P1", "pendulum:objective"], "2031-03-03T00:00:00Z"), // the Objective itself
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

test("score.mjs --streak --since TAG over a snapshot prints the streak per harness", () => {
  const dir = mkdtempSync(join(tmpdir(), "pendulum-bench-streak-"));
  const clean = cleanMerge(42);
  const local = localMerge(60);
  const dispatched = cleanMerge(43);
  dispatched.workflowRuns = [run(901)];
  const snapshot = { repository: REPO, issues: [42, 43, 60], calls: { "repos/acme/pendulum/releases/tags/v9.9.9": { published_at: "2031-03-01T00:00:00Z" } }, collected: { 42: clean, 43: dispatched, 60: local } };
  const file = join(dir, "snapshot.json");
  writeFileSync(file, JSON.stringify(snapshot));
  const out = execFileSync("node", [join(BENCH, "score.mjs"), "--replay", file, "--streak", "--since", "v9.9.9", "--pendulum", "acme/pendulum", "--out", join(dir, "rows.json")], { encoding: "utf8", cwd: dir });
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
  c.issueComments.push({ user: { login: "acme-pendulum[bot]", type: "Bot" }, created_at: "2031-03-02T01:06:00Z", body: `<!-- pendulum:52:progress:work:7 -->\n- 01:06Z harness claude (claude-test) attempt 1` });
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

test("collect: more runs than GitHub lists for a created filter is unread, never a short list; head_sha is kept", async () => {
  const c = cleanMerge(42);
  const many = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, event: "schedule", run_attempt: 1, created_at: "2031-03-02T02:00:00Z", triggering_actor: OWNER }));
  const capped = async (path) => (/\/jobs/.test(path) ? [{ jobs: [] }] : [{ total_count: 1500, workflow_runs: many }]);
  await assert.rejects(humanWorkflowRuns(capped, REPO, c.issue, c.issueTimeline, c.pulls), /1500 Pendulum workflow runs in the window/);
  const one = async (path) => (/\/jobs/.test(path) ? [{ jobs: [] }] : [{ total_count: 1, workflow_runs: [{ id: 5, event: "workflow_dispatch", run_attempt: 1, created_at: "2031-03-02T02:00:00Z", head_sha: "cafe0001", triggering_actor: OWNER }] }]);
  assert.equal((await humanWorkflowRuns(one, REPO, c.issue, c.issueTimeline, c.pulls))[0].head_sha, "cafe0001");
});

test("sandbox stages: the vendor comment's dollars sit beside the progress comment's model dollars; one without a progress comment is its own row", async () => {
  const { spendRecords } = await import("../lib/objective.mjs");
  const app = { login: "pendulum-app[bot]", type: "Bot" };
  const at = "2031-03-02T03:00:00Z";
  const c = (body) => ({ user: app, created_at: at, body });
  const collected = {
    issue: { number: 48, labels: [] },
    issueTimeline: [{ event: "labeled", label: { name: "pendulum:running" }, actor: app }],
    issueComments: [
      c('<!-- pendulum:48:progress:work:9-0123456789ab -->\nPendulum work run 9-0123456789ab.\n<!-- pendulum:spend {"usd":0.5} -->'),
      c('<!-- pendulum:48:vendor:work:9-0123456789ab -->\nPendulum\'s sandbox cost for this stage:\n- 03:10Z sandbox `pendulum-a` stopped\n<!-- pendulum:spend {"usd":0.02,"vendorUsd":0.02} -->'),
      c('<!-- pendulum:48:vendor:review:10-ba9876543210 -->\nPendulum\'s sandbox cost for this stage:\n- 03:30Z sandbox `pendulum-a` stopped\n<!-- pendulum:spend {"usd":0.33,"modelUsd":0.3,"vendorUsd":0.03} -->'),
      // An older stage's progress spend line, model and vendor in one.
      c('<!-- pendulum:48:progress:review:8-aaaaaaaaaaaa -->\nPendulum review run 8.\n<!-- pendulum:spend {"usd":0.45,"modelUsd":0.4,"vendorUsd":0.05} -->'),
    ],
  };
  const rows = spendRecords(collected);
  assert.deepEqual(rows.map((r) => [r.usd, r.vendor?.usd ?? null]), [[0.5, 0.02], [0.4, 0.05], [0.3, 0.03]]);
  // A booking is not an act of Pendulum's: the sweep's late vendor comment leaves a dead stage's wait idle.
  const { pendulumActivity } = await import("../lib/objective.mjs");
  const late = { ...collected, issueComments: [{ ...collected.issueComments[1], created_at: "2031-03-02T09:00:00Z" }] };
  assert.deepEqual(pendulumActivity(late), []);
});

test("a parked Objective is a row: stopped when Blocked, in flight when its Question waits, never a walk-away", () => {
  const OWNER_ = { login: "maintainer", type: "User" };
  const park = (c, at) => {
    c.issue.labels = [];
    c.issueTimeline.push({ event: "unlabeled", label: { name: "pendulum:objective" }, actor: OWNER_, created_at: at });
    return c;
  };
  const stopped = score(park(blocked(70), "2031-03-02T05:00:00Z"));
  assert.deepEqual([stopped.parked, stopped.exit, stopped.walkAway.value], [true, "blocked", false]);
  const waiting = blocked(71);
  waiting.issueTimeline = waiting.issueTimeline.map((e) => (e.label?.name === "pendulum:blocked" ? { ...e, label: { name: "pendulum:question" } } : e));
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

test("External: a Block for each external cause scores External; a mix with any other stop, a Question or an older uncoded Block is a miss", async () => {
  const { blockMarker } = await import("../../plugin/scripts/lib/logic.mjs");
  const APP = { login: "acme-pendulum[bot]", type: "Bot" };
  const stopped = (n, ...causes) => {
    const c = blocked(n);
    c.bodyEdits = [];
    c.workflowRuns = [];
    // The fixture's one notice, then one more per further cause, each recording its cause.
    c.issueComments[1].body += causes[0] === undefined ? "" : `\n${blockMarker(causes[0])}`;
    causes.slice(1).forEach((cause, i) => c.issueComments.push({ user: APP, created_at: `2031-03-02T0${5 + i}:00:00Z`, body: `<!-- pendulum:${n}:blocked:work:${i + 2} -->\nBlocked (work): again\n${blockMarker(cause)}` }));
    return score(c);
  };
  for (const cause of ["max-usd", "gateway-budget", "provider-quota", "outage"]) {
    const r = stopped(80, cause);
    assert.deepEqual([r.walkAway.bucket, r.walkAway.value, r.walkAway.blocks.map((b) => b.cause)], ["external", false, [cause]], cause);
  }
  assert.equal(stopped(81, "max-usd", "provider-quota").walkAway.bucket, "external");
  assert.equal(stopped(82, "max-usd", "setup").walkAway.bucket, "miss");
  assert.equal(stopped(83, "work").walkAway.bucket, "miss");
  assert.equal(stopped(84).walkAway.bucket, "miss", "a notice with no cause line scores as before");
  // A Question beside the external Block: a person's answer was asked for, so a miss.
  const asked = blocked(85);
  Object.assign(asked, { bodyEdits: [], workflowRuns: [] });
  asked.issueComments[1].body += `\n${blockMarker("max-usd")}`;
  asked.issueTimeline.push({ event: "labeled", label: { name: "pendulum:question" }, actor: APP, created_at: "2031-03-02T02:00:00Z" });
  assert.equal(score(asked).walkAway.bucket, "miss");
  // A person's marker comment is not Pendulum's notice.
  const forged = blocked(86);
  Object.assign(forged, { bodyEdits: [], workflowRuns: [] });
  forged.issueComments[1].user = { login: "maintainer", type: "User" };
  forged.issueComments[1].body += `\n${blockMarker("max-usd")}`;
  assert.equal(score(forged).walkAway.bucket, "miss");
});

test("#465: an Objective from before the rename (its events and markers under the previous name, its label renamed in place) is left out of a --since v0.10.0 streak, never a miss", () => {
  const tag = "2031-03-04T00:00:00Z";
  const old = (c) => {
    const o = JSON.parse(JSON.stringify(c).replaceAll("pendulum:", `${PREVIOUS_NAME}:`));
    o.issue.labels = [{ name: "pendulum:objective" }];
    return o;
  };
  // As GitHub may list the label events: under the name each label had then, or under its current name.
  const before = [old(cleanMerge(45)), cleanMerge(46)].map(score);
  assert.ok(before[0].walkAway.since < tag && before[1].walkAway.since < tag);
  // One labelled after the tag, all its times moved past it.
  const shifted = JSON.parse(JSON.stringify(cleanMerge(47)), (k, v) => (typeof v === "string" && /^2031-03-0[1-3]T/.test(v) ? v.replace(/^2031-03-0[1-3]/, "2031-03-05") : v));
  const s = streaks([...before, score(shifted)], { from: tag });
  assert.deepEqual(s.before, [45, 46]);
  const all = Object.values(s.harnesses).flatMap((h) => h.sequence);
  assert.deepEqual(all.map((e) => [e.issue, e.ok]), [[47, true]]);
});
