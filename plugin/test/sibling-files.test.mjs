import "./temp.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { RETRY, repoOf } from "../scripts/lib/github.mjs";
import { marker, rebaseCostOf, rebaseLine, rebaseTally } from "../scripts/lib/logic.mjs";
import { forgetFiles, heavyOverlap, plannedFiles, siblingOrder } from "../scripts/lib/overlap.mjs";
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
  const state = { issues, comments: { ...comments }, prs, writes: [], reads: [] };
  let id = 1000;
  const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const p = u.pathname.replace(`/repos/${REPO}`, "");
    const method = init.method || "GET";
    const body = init.body ? JSON.parse(init.body) : null;
    if (u.pathname === "/graphql") return json({ data: {} });
    let m;
    if (method === "GET") state.reads.push(`${p}${u.search}`);
    else state.writes.push(`${method} ${p}${body?.body ? ` ${body.body}` : ""}`);
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
      const head = u.searchParams.get("head");
      // A fork's PR from a branch of the same name: never one of Factory's.
      const fork = { number: 99, state: "open", head: { ref: "factory/8", sha: "f".repeat(40), repo: { full_name: "mallory/app" } }, base: { ref: "main" } };
      if (!head) return json([...Object.values(state.prs).map((x) => x.pr), fork]);
      const n = /:factory\/(\d+)$/.exec(head)?.[1];
      return json(n && state.prs[n] ? [state.prs[n].pr] : []);
    }
    if (method === "GET" && (m = /^\/pulls\/(\d+)\/files$/.exec(p))) return json(Number(m[1]) === 99 ? ["src/parse.ts", "a.md", "b.md", "c.md"].map((filename) => ({ filename })) : (Object.values(state.prs).find((x) => x.pr.number === Number(m[1]))?.files || []).map((filename) => ({ filename })));
    if (method === "GET" && (m = /^\/pulls\/(\d+)$/.exec(p))) return json(Object.values(state.prs).find((x) => x.pr.number === Number(m[1]))?.pr ?? {});
    if (method === "GET" && /\/actions\/(workflows\/[^/]+\/)?runs$/.test(p)) return json({ workflow_runs: [] });
    if (method === "GET" && /\/timeline$/.test(p)) return json([]);
    // The merge pass's reads and its merge (session.mjs mergeReadyOne): the Objective, the PR's review, green CI.
    if (method === "GET" && (m = /^\/issues\/(\d+)$/.exec(p))) return json(state.issues.find((i) => i.number === Number(m[1])) ?? { message: "Not Found" }, state.issues.some((i) => i.number === Number(m[1])) ? 200 : 404);
    if (method === "GET" && /^\/pulls\/\d+\/comments$/.test(p)) return json([]);
    if (method === "GET" && (m = /^\/pulls\/(\d+)\/reviews$/.exec(p))) return json([{ id: 1, user: { login: SELF, type: "Bot" }, body: `${marker(7, "review")}\nFactory reviewer`, submitted_at: new Date().toISOString() }]);
    if (method === "GET" && /\/check-runs$/.test(p)) return json({ total_count: 1, check_runs: [{ id: 1, name: "ci", status: "completed", conclusion: "success", app: { id: 15368 } }] });
    if (method === "GET" && /\/commits\/[0-9a-f]+\/status$/.test(p)) return json({ statuses: [] });
    if (method === "GET" && (m = /^\/commits\/([0-9a-f]+)$/.exec(p))) return json({ sha: m[1], parents: [], commit: { committer: { date: "2026-01-01T00:00:00Z" } } });
    if (method === "PUT" && (m = /^\/pulls\/(\d+)\/merge$/.exec(p))) {
      const x = Object.values(state.prs).find((y) => y.pr.number === Number(m[1]));
      Object.assign(x.pr, { state: "closed", merged: true });
      state.mergedPrs = [...(state.mergedPrs || []), x.pr.number];
      return json({ merged: true });
    }
    if (method !== "GET") return json({}, 200);
    return json({ message: "Not Found" }, 404);
  };
  return { state, fetch };
}

/** One dispatcher tick over `w`; `inputs` and `opts` on top of an auto-merging Actions route with two slots. */
async function tick(w, inputs = {}, opts = {}) {
  const { dispatch } = await import("../scripts/dispatch.mjs");
  const realFetch = globalThis.fetch;
  const saved = Object.fromEntries(["FACTORY_LOCAL", "FACTORY_LOCAL_ALL", "GITHUB_API_URL"].map((k) => [k, process.env[k]]));
  process.env.GITHUB_API_URL = "https://github.test";
  delete process.env.FACTORY_LOCAL;
  delete process.env.FACTORY_LOCAL_ALL;
  globalThis.fetch = w.fetch;
  try {
    return await dispatch({ repo: REPO, objectiveLabel: "factory:objective", maxConcurrent: 2, dailyUsd: 0, ciChecks: [], timeoutMinutes: 60, autoMerge: true, notify: "", ...inputs }, { token: "t", ...opts });
  } finally {
    globalThis.fetch = realFetch;
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

const UPDATED = new Date(Date.now() - 3600_000).toISOString();
const issue = (n, labels = [], comments = 0) => ({ number: n, state: "open", title: `Objective ${n}`, labels: ["factory:objective", ...labels].map((name) => ({ name })), body: "", comments, updated_at: UPDATED, user: { login: "maintainer" } });
const overlap = (w, n) => (w.state.comments[n] || []).filter((c) => c.body.startsWith(marker(n, "overlap").replace(/ -->$/, "")));
// #7 is In review with PR #12 under review (its label on: no merge this tick) on the fixture, docs and command files.
const PR7 = () => ({ 7: { pr: { number: 12, state: "open", draft: false, mergeable: true, mergeable_state: "clean", head: { sha: "a".repeat(40), ref: "factory/7", repo: { full_name: REPO } }, base: { ref: "main" }, labels: [{ name: "factory:review" }] }, files: ["test/fixtures/env.ts", "docs/commands.md", "src/commands/run.ts", "README.md"] } });
const SHARED3 = ["test/fixtures/env.ts", "docs/commands.md", "src/commands/run.ts"];
const waitsComment = (n, on, sinceMs) => ({ id: 900 + n, user: { login: SELF, type: "Bot" }, body: `${marker(n, "overlap", `waits-${on}-${Math.floor(sinceMs / 1000)}`)}\nFactory: this Objective waits for #${on}.`, created_at: new Date(sinceMs).toISOString() });

test("#277: a real dispatcher tick holds the Objective whose plan overlaps an In-review PR heavily, says so on it, starts the next, and starts it once the sibling is gone", async () => {
  forgetFiles();
  // #8 (a rerun: its plan names #7's files) and #9 (fresh: no plan, no comments) are Queued, then #10, whose plan
  // shares one file with #7's PR.
  const w = world([issue(7, ["factory:in-review"], 3), issue(8, [], 1), issue(9), issue(10, [], 1)], {
    comments: { 7: [PLAN(7, SHARED3)], 8: [PLAN(8, [...SHARED3, "src/new.ts"])], 10: [PLAN(10, ["README.md", "src/a.ts", "src/b.ts"])] },
    prs: PR7(),
  });
  const r = await tick(w);
  assert.deepEqual(r.ready, [9, 10], "#8 waits; its slot goes to #10");
  assert.match(r.skipped.find((s) => s.number === 8)?.reason ?? "", /^waits for #7 to merge: both change 3 file\(s\)/);
  const [held] = overlap(w, 8);
  assert.ok(held?.body.startsWith(marker(8, "overlap", "waits-7").replace(/ -->$/, "-")), held?.body);
  assert.match(held.body, /waits for #7 \(in review\) to merge before it starts: both change `docs\/commands\.md`, `src\/commands\/run\.ts`, `test\/fixtures\/env\.ts`, 3 of this Objective's 4 known file\(s\).*or after 6 h of waiting at most/);
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

test("#277: a sibling whose PR this tick merges is no longer waited for: the overlapping pick starts the same tick", async () => {
  forgetFiles();
  const prs = PR7();
  // Reviewed (its review label off), validated and recorded mergeable, CI green: the merge pass merges it this tick.
  prs[7].pr.labels = [];
  const record = { id: 777, user: { login: SELF, type: "Bot" }, body: `${marker(7, "mergeable").replace(/ -->$/, "")}:${prs[7].pr.head.sha} -->\nFactory: reviewed and validated.`, created_at: new Date().toISOString() };
  // #7's known files are its PR's (no plan comment: the merge's check of the text against a plan is not this test's).
  const w = world([issue(7, ["factory:in-review"], 3), issue(8, [], 1)], { comments: { 8: [PLAN(8, SHARED3)], 12: [record] }, prs });
  const r = await tick(w, { ciChecks: ["ci"] });
  assert.deepEqual(w.state.mergedPrs, [12], `the merge pass merged #7's PR: ${JSON.stringify(r.merged)}`);
  assert.deepEqual(r.merged, [7]);
  assert.deepEqual(r.ready, [8], "not held for a sibling that merged this tick");
  assert.equal(overlap(w, 8).length, 0);
});

test("#277: an unchanged queue costs no comment or PR-file reads on the next tick; PRs come from one listing and the review pass's own reads; a fork's branch is no Factory PR", async () => {
  forgetFiles();
  // A fork's PR from `factory/8` (in the fake's listing) would make #8 overlap #11 heavily if it counted.
  const w = world([issue(7, ["factory:in-review"], 3), issue(8, [], 1), issue(11, ["factory:running"], 1)], { comments: { 7: [PLAN(7, SHARED3)], 8: [PLAN(8, [...SHARED3, "src/new.ts"])], 11: [PLAN(11, ["src/parse.ts", "a.md", "b.md"])] }, prs: PR7() });
  const first = await tick(w);
  assert.deepEqual(first.ready, []);
  assert.match(first.skipped.find((s) => s.number === 8)?.reason ?? "", /^waits for #7/, "the fork's files are not #8's");
  const tickReads = w.state.reads.slice();
  assert.equal(tickReads.filter((r) => /^\/pulls\?state=open&head=.*factory%2F7/.test(r)).length, 1, `#7's PR is read once, by the review pass: ${tickReads.join(" ")}`);
  assert.equal(tickReads.filter((r) => /^\/pulls\?state=open&per_page=100/.test(r)).length, 1, "one listing for the rest");
  assert.equal(tickReads.filter((r) => /^\/pulls\?state=open&head=.*factory%2F(8|11)/.test(r)).length, 0, "no PR read per issue");

  // The waits comment Factory posted moved #8's comment count: read once more, then not again.
  w.state.issues = [issue(7, ["factory:in-review"], 3), issue(8, [], 2), issue(11, ["factory:running"], 1)];
  await tick(w);
  const from = w.state.reads.length;
  const second = await tick(w);
  assert.deepEqual(second.ready, []);
  const reads = w.state.reads.slice(from);
  // (#11's comments are still read by the Running pass, which is not this one's.)
  assert.deepEqual(reads.filter((r) => /^\/issues\/(7|8)\/comments|^\/pulls\/\d+\/files/.test(r)), [], `nothing re-read on an unchanged queue: ${reads.join(" ")}`);

  // A new comment on #8 (its count moves) is read again; #7's PR files only when its head moves.
  w.state.issues = [issue(7, ["factory:in-review"], 3), issue(8, [], 3), issue(11, ["factory:running"], 1)];
  w.state.prs[7].pr.head.sha = "b".repeat(40);
  const mark = w.state.reads.length;
  await tick(w);
  const now = w.state.reads.slice(mark);
  assert.ok(now.some((r) => r.startsWith("/issues/8/comments")), now.join(" "));
  assert.ok(now.some((r) => r.startsWith("/pulls/12/files")), "a new head is read");
});

test("#277: placeholders, globs and directories in Files: lines are no files, so they make no overlap", async () => {
  forgetFiles();
  const placeholders = { id: 600, user: { login: SELF, type: "Bot" }, body: `${marker(7, "plan")}\n1. Notes only\n   Files: none\n2. Docs\n   Files: docs/, src/*.ts, (none)\n3. Code\n   Files: src/a.ts\n` };
  const w = world([issue(7, ["factory:running"], 1), issue(8, [], 1)], { comments: { 7: [placeholders], 8: [PLAN(8, ["(none)", "n/a", "TBD", "-", "—", "docs/", "src/*.ts", "none", "src/b.ts"])] } });
  const r = await tick(w);
  assert.deepEqual(r.ready, [8]);
  assert.equal(overlap(w, 8).length, 0, "no shared file");
});

test("#277: a waits comment is cleared when the pick starts on a quiet tick with nothing to compare", async () => {
  forgetFiles();
  const w = world([issue(8, [], 1)], { comments: { 8: [waitsComment(8, 7, Date.now() - 3600_000)] } });
  const r = await tick(w, { maxConcurrent: 1 });
  assert.deepEqual(r.ready, [8]);
  assert.ok(overlap(w, 8)[0].body.startsWith(marker(8, "overlap", "cleared")), overlap(w, 8)[0].body);
});

test("#277: without auto_merge an In-review sibling waits for a person, so nothing waits for it", async () => {
  forgetFiles();
  const w = world([issue(7, ["factory:in-review"], 3), issue(8, [], 1)], { comments: { 7: [PLAN(7, SHARED3)], 8: [PLAN(8, SHARED3)] }, prs: PR7() });
  const r = await tick(w, { autoMerge: false });
  assert.deepEqual(r.ready, [8]);
  assert.equal(overlap(w, 8).length, 0);
});

test("#277: a wait is bounded: 6 h after its waits comment began, the pick starts beside the sibling and says why; before that the start time is kept", async () => {
  forgetFiles();
  const hourAgo = Date.now() - 3600_000;
  const w = world([issue(7, ["factory:in-review"], 3), issue(8, [], 2)], { comments: { 7: [PLAN(7, SHARED3)], 8: [PLAN(8, SHARED3), waitsComment(8, 7, hourAgo)] }, prs: PR7() });
  const r = await tick(w);
  assert.deepEqual(r.ready, []);
  assert.ok(overlap(w, 8)[0].body.startsWith(marker(8, "overlap", `waits-7-${Math.floor(hourAgo / 1000)}`)), `the wait's start is kept: ${overlap(w, 8)[0].body}`);

  forgetFiles();
  const v = world([issue(7, ["factory:in-review"], 3), issue(8, [], 2)], { comments: { 7: [PLAN(7, SHARED3)], 8: [PLAN(8, SHARED3), waitsComment(8, 7, Date.now() - 7 * 3600_000)] }, prs: PR7() });
  const t = await tick(v);
  assert.deepEqual(t.ready, [8]);
  const [note] = overlap(v, 8);
  assert.ok(note.body.startsWith(marker(8, "overlap", "beside")), note.body);
  assert.match(note.body, /stopped waiting for #7 after 6 h, the longest Factory holds one for a sibling, and starts beside #7/);
});

test("#277: notes go only to the tick's final picks: a pick a later hold drops gets none", async () => {
  forgetFiles();
  const w = world([issue(7, ["factory:in-review"], 3), issue(9), issue(10, [], 1)], { comments: { 7: [PLAN(7, SHARED3)], 10: [PLAN(10, ["README.md", "src/a.ts", "src/b.ts"])] }, prs: PR7() });
  const r = await tick(w, {}, { localSlots: 1 });
  assert.deepEqual(r.ready, [9]);
  assert.equal(overlap(w, 10).length, 0, "#10 did not start this tick");
});

test("#277: a run named by hand never waits; with no active sibling and one slot, no files are read", async () => {
  forgetFiles();
  const w = world([issue(7, ["factory:running"], 1), issue(8, [], 1)], { comments: { 7: [PLAN(7, ["a.md", "b.md"])], 8: [PLAN(8, ["a.md", "b.md"])] } });
  const r = await tick(w, { issue: 8 });
  assert.deepEqual(r.ready, [8]);
  assert.equal(overlap(w, 8).length, 0);

  forgetFiles();
  // Two Queued with plans that overlap, one slot, nothing active: only one can start, so nothing is compared.
  const v = world([issue(8, [], 1), issue(11, [], 1)], { comments: { 8: [PLAN(8, ["a.md"])], 11: [PLAN(11, ["a.md"])] } });
  const t = await tick(v, { maxConcurrent: 1 });
  assert.deepEqual(t.ready, [8]);
  // Only the started pick's comments, once, for a waits comment to clear (none here).
  assert.deepEqual(v.state.reads.filter((p) => /\/issues\/(8|11)\/comments|\/pulls/.test(p)), ["/issues/8/comments?per_page=100"], v.state.reads.join(", "));
});

test("#277: the rebase exit line names the passes that ran, and leaves out the count and total when the earlier rebases were unread", () => {
  assert.equal(rebaseLine({ usd: 0, conflict: false, passes: 0 }, { count: 1, usd: 2, unmetered: 0 }), "rebase 2 of this Objective (clean, no model run): $0.00; all its rebases: $2.00");
  assert.equal(rebaseLine({ usd: 0.8, conflict: false, passes: 2 }, { count: 0, usd: 0, unmetered: 0 }), "rebase 1 of this Objective (clean, 2 fix pass(es)): $0.80; all its rebases: $0.80");
  assert.equal(rebaseLine({ usd: 1.25, conflict: true, passes: 1 }, null), "rebase (a conflict pass): $1.25");
  assert.equal(rebaseLine({ usd: null, conflict: true, passes: 0 }, null), "rebase (clean, no model run): unmetered");
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
    await progress(`exit: delivered; usd 1.25; ${rebaseLine({ usd: 1.25, conflict: true, passes: 1 }, { count: 2, usd: 0.5, unmetered: 0 })}`);
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
