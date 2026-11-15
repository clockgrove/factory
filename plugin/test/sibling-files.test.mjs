import "./temp.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { RETRY, repoOf } from "../scripts/lib/github.mjs";
import { marker, rebaseCostOf, rebaseLine, rebaseTally } from "../scripts/lib/logic.mjs";
import { heavyOverlap, plannedFiles, siblingOrder } from "../scripts/lib/overlap.mjs";
import { progressReporter, rebaseNotice } from "../scripts/lib/session.mjs";
import { markdownTable, rebasesOf } from "../../bench/lib/objective.mjs";

RETRY.sleep = async () => {};

// #277: Objectives that change the same files ran at once and rebased over each other one merge at a time (one spent
// $18.32 against a median of $8.55, almost all of it rebases). The dispatcher now orders the ones whose files it knows,
// and every rebase's cost is on the issue and in the scorecard.

const REPO = "acme/app";
const SELF = "factory-app[bot]";
const PLAN = (n, files) => ({ id: 500 + n, user: { login: SELF, type: "Bot" }, body: `${marker(n, "plan")}\n## Checklist\n1. The change\n   Files: ${files.join(", ")}\n`, created_at: new Date(Date.now() - 60_000).toISOString() });

test("#277: the plan's Files: lines are its file list; prose and odd entries are not read", () => {
  const plan = ["1. Parser", "   Files: `src/parse.ts`, ./docs/usage.md", "- [ ] **Files:** test/fixtures/env.ts", "The Files mentioned in src/other.ts are not a list.", "Files: /etc/passwd, ../up.md, https://x.test/a, has space.md, src/parse.ts"].join("\n");
  assert.deepEqual(plannedFiles(plan), ["src/parse.ts", "docs/usage.md", "test/fixtures/env.ts"]);
  assert.deepEqual(plannedFiles("no list here"), []);
});

test("#277: heavy is three shared files or half of the smaller list; one shared file of many is light", () => {
  const ten = Array.from({ length: 10 }, (_, i) => `f${i}`);
  assert.equal(heavyOverlap(["f0"], ten, ten), false);
  assert.equal(heavyOverlap(["f0", "f1", "f2"], ten, ten), true);
  assert.equal(heavyOverlap(["f0"], ["f0", "x"], ten), true, "half of a two-file Objective");
  assert.equal(heavyOverlap([], ["a"], ["a"]), false);
});

test("#277: siblingOrder holds a heavy overlap, passes its slot on, notes a light one, starts unknowns, and orders two picks of one tick", () => {
  const siblings = [{ number: 7, state: "In review", files: ["a", "b", "c", "q"] }];
  const r = siblingOrder({
    candidates: [
      { number: 8, files: ["a", "b", "c", "d"] },
      { number: 9, files: null },
      { number: 10, files: ["a", "x", "y"] },
      { number: 11, files: ["x", "y"] },
      { number: 12, files: ["z"] },
    ],
    siblings,
    slots: 3,
  });
  assert.deepEqual(r.ready, [9, 10, 12], "#8 waits on #7; #11 waits on #10, started this tick; #12 takes the slot");
  assert.deepEqual(
    r.waits.map((w) => [w.number, w.on, w.shared]),
    [
      [8, 7, ["a", "b", "c"]],
      [11, 10, ["x", "y"]],
    ],
  );
  assert.deepEqual(r.notes, [{ number: 10, with: [{ number: 7, shared: ["a"] }] }]);
});

/** GitHub as the dispatcher reads it: Objectives, their comments, one open PR per In-review Objective with its files. */
function world(issues, { comments = {}, prs = {} } = {}) {
  const state = { issues, comments: { ...comments }, prs, writes: [] };
  let id = 1000;
  const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const p = u.pathname.replace(`/repos/${REPO}`, "");
    const method = init.method || "GET";
    const body = init.body ? JSON.parse(init.body) : null;
    if (u.pathname === "/graphql") return json({ data: {} });
    let m;
    if (method !== "GET") state.writes.push(`${method} ${p}${body?.body ? ` ${body.body}` : ""}`);
    if (method === "GET" && u.pathname === "/user") return json({ login: SELF, type: "Bot" });
    if (method === "GET" && p === "/issues") return json(u.searchParams.get("state") === "closed" ? [] : u.searchParams.get("labels") === "factory:objective" ? state.issues : []);
    if (method === "GET" && p === "") return json({ default_branch: "main" });
    if (method === "GET" && p === "/rulesets") return json([]);
    if (method === "GET" && u.pathname.endsWith("/collaborators")) return json([{ login: "maintainer" }]);
    if (method === "GET" && (m = /^\/issues\/(\d+)\/comments$/.exec(p))) return json(state.comments[m[1]] || []);
    if (method === "POST" && (m = /^\/issues\/(\d+)\/comments$/.exec(p))) {
      const c = { id: id++, user: { login: SELF, type: "Bot" }, body: body.body, created_at: new Date().toISOString() };
      (state.comments[m[1]] ||= []).push(c);
      return json(c, 201);
    }
    if (method === "PATCH" && (m = /^\/issues\/comments\/(\d+)$/.exec(p))) {
      for (const list of Object.values(state.comments)) for (const c of list) if (c.id === Number(m[1])) c.body = body.body;
      return json({ id: Number(m[1]) });
    }
    if (method === "GET" && p === "/pulls") {
      const head = /:factory\/(\d+)$/.exec(u.searchParams.get("head") || "")?.[1];
      return json(head && state.prs[head] ? [state.prs[head].pr] : []);
    }
    if (method === "GET" && (m = /^\/pulls\/(\d+)\/files$/.exec(p))) return json((Object.values(state.prs).find((x) => x.pr.number === Number(m[1]))?.files || []).map((filename) => ({ filename })));
    if (method === "GET" && (m = /^\/pulls\/(\d+)$/.exec(p))) return json(Object.values(state.prs).find((x) => x.pr.number === Number(m[1]))?.pr ?? {});
    if (method === "GET" && /\/actions\/(workflows\/[^/]+\/)?runs$/.test(p)) return json({ workflow_runs: [] });
    if (method === "GET" && /\/timeline$/.test(p)) return json([]);
    if (method !== "GET") return json({}, 200);
    return json({ message: "Not Found" }, 404);
  };
  return { state, fetch };
}

async function tick(w, inputs = {}) {
  const { dispatch } = await import("../scripts/dispatch.mjs");
  const realFetch = globalThis.fetch;
  const saved = Object.fromEntries(["FACTORY_LOCAL", "FACTORY_LOCAL_ALL", "GITHUB_API_URL"].map((k) => [k, process.env[k]]));
  process.env.GITHUB_API_URL = "https://github.test";
  delete process.env.FACTORY_LOCAL;
  delete process.env.FACTORY_LOCAL_ALL;
  globalThis.fetch = w.fetch;
  try {
    return await dispatch({ repo: REPO, objectiveLabel: "factory:objective", maxConcurrent: 2, dailyUsd: 0, ciChecks: [], timeoutMinutes: 60, autoMerge: false, notify: "", ...inputs }, { token: "t" });
  } finally {
    globalThis.fetch = realFetch;
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

const issue = (n, labels = [], comments = 0) => ({ number: n, state: "open", title: `Objective ${n}`, labels: ["factory:objective", ...labels].map((name) => ({ name })), body: "", comments, updated_at: new Date().toISOString(), user: { login: "maintainer" } });
const overlap = (w, n) => (w.state.comments[n] || []).filter((c) => c.body.startsWith(marker(n, "overlap").replace(/ -->$/, "")));

test("#277: a real dispatcher tick holds the Objective whose plan overlaps an In-review PR heavily, says so on it, starts the next, and starts it once the sibling is gone", async () => {
  // #7 is In review with PR #12 on the fixture, docs and command files. #8 (a rerun: its plan names the same files)
  // and #9 (fresh: no plan, no comments) are Queued, then #10, whose plan shares one file with #7's PR.
  const w = world([issue(7, ["factory:in-review"], 3), issue(8, [], 1), issue(9), issue(10, [], 1)], {
    comments: { 7: [PLAN(7, ["test/fixtures/env.ts", "docs/commands.md", "src/commands/run.ts"])], 8: [PLAN(8, ["test/fixtures/env.ts", "docs/commands.md", "src/commands/run.ts", "src/new.ts"])], 10: [PLAN(10, ["README.md", "src/a.ts", "src/b.ts"])] },
    prs: { 7: { pr: { number: 12, state: "open", draft: false, head: { sha: "a".repeat(40), ref: "factory/7" }, base: { ref: "main" }, labels: [] }, files: ["test/fixtures/env.ts", "docs/commands.md", "src/commands/run.ts", "README.md"] } },
  });
  const r = await tick(w);
  assert.deepEqual(r.ready, [9, 10], "#8 waits; its slot goes to #10");
  assert.match(r.skipped.find((s) => s.number === 8)?.reason ?? "", /^waits for #7 to merge: both change 3 file\(s\)/);
  const [held] = overlap(w, 8);
  assert.ok(held, "the waiting issue says why");
  assert.ok(held.body.startsWith(marker(8, "overlap", "waits-7")), held.body);
  assert.match(held.body, /waits for #7 \(in review\) to merge before it starts: both change `docs\/commands\.md`, `src\/commands\/run\.ts`, `test\/fixtures\/env\.ts`, 3 of this Objective's 4 known file\(s\)/);
  const [beside] = overlap(w, 10);
  assert.ok(beside?.body.startsWith(marker(10, "overlap", "beside")), "the light overlap starts and says so");
  assert.match(beside.body, /starts beside #7 \(`README\.md`\)/);
  assert.equal(overlap(w, 9).length, 0, "a fresh Objective's files are unknown: nothing said");

  // The next tick, #7 still In review (#9 and #10 now Running): #8 still waits, and its comment is not written again.
  w.state.issues = [issue(7, ["factory:in-review"], 3), issue(8, [], 2), issue(9, ["factory:running"]), issue(10, ["factory:running"], 2)];
  const writes = w.state.writes.length;
  const again = await tick(w, { maxConcurrent: 3 });
  assert.deepEqual(again.ready, []);
  assert.equal(w.state.writes.slice(writes).filter((x) => x.includes(":overlap:")).length, 0, "an unchanged note is not written again");

  // #7 merged (its issue closed, so no longer listed): #8 starts, and its note says it no longer waits.
  w.state.issues = [issue(8, [], 2), issue(9, ["factory:running"]), issue(10, ["factory:running"], 2)];
  delete w.state.prs[7];
  const after = await tick(w, { maxConcurrent: 3 });
  assert.deepEqual(after.ready, [8]);
  assert.equal(overlap(w, 8).length, 1, "the one comment, edited");
  assert.ok(overlap(w, 8)[0].body.startsWith(marker(8, "overlap", "cleared")), overlap(w, 8)[0].body);
  assert.match(overlap(w, 8)[0].body, /no longer waits for #7/);
});

test("#277: a run named by hand for an issue never waits, and a tick with no active sibling reads no files", async () => {
  const w = world([issue(7, ["factory:running"], 1), issue(8, [], 1)], { comments: { 7: [PLAN(7, ["a.md", "b.md"])], 8: [PLAN(8, ["a.md", "b.md"])] } });
  const r = await tick(w, { issue: 8 });
  assert.deepEqual(r.ready, [8]);
  assert.equal(overlap(w, 8).length, 0);

  const v = world([issue(8, [], 1)], { comments: { 8: [PLAN(8, ["a.md"])] } });
  const reads = [];
  const fetch = v.fetch;
  v.fetch = async (url, init) => {
    reads.push(new URL(url).pathname);
    return fetch(url, init);
  };
  const t = await tick(v);
  assert.deepEqual(t.ready, [8]);
  assert.ok(!reads.some((p) => /\/issues\/8\/comments$|\/pulls/.test(p)), `no file reads with nothing to compare: ${reads.join(", ")}`);
});

test("#277: a rebase stage's progress comment carries its rebase line on every route, and the tally and scorecard read it back", async () => {
  const written = [];
  const realFetch = globalThis.fetch;
  const savedUrl = process.env.GITHUB_API_URL;
  process.env.GITHUB_API_URL = "https://github.test";
  globalThis.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    if ((init.method || "GET") === "GET") return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    written.push(body.body);
    return new Response(JSON.stringify({ id: 1 }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    // The Actions route: no spend line in the progress comment (its dollars are in the usage artifact).
    const progress = progressReporter(repoOf(REPO), 7, { token: "t" }, { stage: "work", runId: "42", soFar: null });
    progress.rebase({ usd: 1.25, conflict: true });
    await progress(`exit: delivered; usd 1.25; ${rebaseLine({ usd: 1.25, conflict: true }, { count: 2, usd: 0.5, unmetered: 0 })}`);
  } finally {
    globalThis.fetch = realFetch;
    if (savedUrl === undefined) delete process.env.GITHUB_API_URL;
    else process.env.GITHUB_API_URL = savedUrl;
  }
  const body = written.at(-1);
  assert.deepEqual(rebaseCostOf(body), { usd: 1.25, conflict: true });
  assert.doesNotMatch(body, /factory:spend/, "no spend line on the Actions route: the daily sum is unchanged");
  assert.match(body, /rebase 3 of this Objective \(a conflict pass\): \$1\.25; all its rebases: \$1\.75/);

  const at = (m) => new Date(Date.UTC(2026, 10, 14, 10, m)).toISOString();
  const own = (b, m) => ({ id: m, user: { login: SELF, type: "Bot" }, body: b, created_at: at(m) });
  const clean = `${marker(7, "progress", "work:41")}\nFactory work: started.\n<!-- factory:rebase-cost {"usd":0,"conflict":false} -->`;
  const pasted = { id: 99, user: { login: "someone", type: "User" }, author_association: "NONE", body: `${marker(7, "progress", "work:9")}\n<!-- factory:rebase-cost {"usd":50,"conflict":true} -->`, created_at: at(9) };
  const comments = [own(clean, 1), own(body.startsWith("<!--") ? body : `${marker(7, "progress", "work:42")}\n${body}`, 2), pasted];
  assert.deepEqual(rebaseTally(comments, 7, (c) => c.user.login === SELF), { count: 2, usd: 1.25, unmetered: 0, conflicts: 1 });

  const pr = { number: 12, state: "closed", merged_at: at(30), head: { ref: "factory/7", sha: "b".repeat(40) }, base: { sha: "c".repeat(40) }, created_at: at(0) };
  const notices = [rebaseNotice(7, { head: { sha: "1".repeat(40) }, base: { ref: "main" }, mergeable_state: "dirty" }, 0), rebaseNotice(7, { head: { sha: "2".repeat(40) }, base: { ref: "main" }, mergeable_state: "dirty" }, 1)];
  assert.match(notices[1], /rebase 2 of at most 5 in 24 h/);
  const collected = {
    repository: REPO,
    issue: { number: 7, title: "x", created_at: at(0), labels: [], state: "closed" },
    issueTimeline: [{ event: "labeled", label: { name: "factory:running" }, actor: { login: SELF, type: "Bot" }, created_at: at(0) }],
    issueComments: comments,
    pulls: [pr],
    pullDetails: { 12: { comments: notices.map((b, i) => own(b, 10 + i)), commits: [], timeline: [], reviews: [], reviewComments: [] } },
  };
  const rebases = rebasesOf(collected);
  assert.deepEqual(rebases, { sentBack: 2, stages: 2, usd: 1.25, unmetered: 0, conflicts: 1 });
  const row = { issue: 7, exit: "merged", parked: false, walkAway: { value: true, interventions: { asked: 0, unprompted: 0 }, askedOnly: { value: true } }, quality: { status: "pending" }, operator: { minutes: 0 }, cost: { usd: 3, tokens: { input: null }, unit: "usd", basis: "b" }, missing: [], rebases, activity: {} };
  const table = markdownTable([row]);
  assert.match(table.split("\n")[0], /\| Rebases \| Harness \|$/);
  assert.match(table.split("\n")[2], /\| 2, \$1\.25 \|/);
});
