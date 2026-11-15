import "./temp.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { RETRY, repoOf } from "../scripts/lib/github.mjs";
import { marker, rebaseCost, rebaseCostOf, rebaseLine, rebaseTally, setSelf, spendOf, vendorBody } from "../scripts/lib/logic.mjs";
import { forgetFiles, heavyOverlap, plannedFiles, reviewHold, siblingOrder, waitReason } from "../scripts/lib/overlap.mjs";
import { progressReporter, rebaseExitLine, rebaseNotice } from "../scripts/lib/session.mjs";
import { markdownTable, rebaseCell, rebasesOf, spendRecords } from "../../bench/lib/objective.mjs";

RETRY.sleep = async () => {};

// #277: Objectives that change the same files ran at once and rebased over each other one merge at a time (one spent
// $18.32 against a median of $8.55, almost all of it rebases). Every rebase's cost is on the issue and in the scorecard.
// #340: holding the start of such an Objective held its whole work stage (an answered Question's pass, a resumed draft)
// for a sibling's review and merge, so hot-file Objectives ran one at a time. They start; the hand-off to review waits.

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

test("#340: siblingOrder starts every pick while slots last, heavy overlap or not, and notes each overlap, heavy ones named", () => {
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
    slots: 4,
  });
  assert.deepEqual(r.ready, [8, 9, 10, 11], "nothing waits at its start: each has work of its own to write");
  assert.deepEqual(r.notes, [
    { number: 8, with: [{ number: 7, shared: ["a", "b", "c"] }], heavy: [7] },
    { number: 10, with: [{ number: 7, shared: ["a"] }, { number: 8, shared: ["a"] }], heavy: [] },
    { number: 11, with: [{ number: 10, shared: ["x", "y"] }], heavy: [10] },
  ]);
  assert.equal(r.waits, undefined);
});

/** GitHub as the dispatcher reads it: Objectives, their comments, one open PR per In-review Objective with its files. */
function world(issues, { comments = {}, prs = {} } = {}) {
  const state = { issues, comments: { ...comments }, prs, writes: [], reads: [], timelines: {} };
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
    if (method === "GET" && p === "/issues") return json(u.searchParams.get("state") === "closed" ? [] : state.issues.filter((i) => i.labels.some((l) => l.name === u.searchParams.get("labels"))));
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
    if (method === "DELETE" && (m = /^\/issues\/comments\/(\d+)$/.exec(p))) {
      for (const k of Object.keys(state.comments)) state.comments[k] = state.comments[k].filter((c) => c.id !== Number(m[1]));
      return new Response(null, { status: 204 });
    }
    // Labels on PRs (an issue number that is a PR's): kept on the PR, with the label's time in its timeline.
    if ((m = /^\/issues\/(\d+)\/labels(?:\/(.+))?$/.exec(p))) {
      const x = Object.values(state.prs).find((y) => y.pr.number === Number(m[1]));
      if (x && method === "POST") {
        x.pr.labels = [...x.pr.labels.filter((l) => !body.labels.includes(l.name)), ...body.labels.map((name) => ({ name }))];
        (state.timelines[m[1]] ||= []).push(...body.labels.map((name) => ({ event: "labeled", label: { name }, created_at: new Date().toISOString() })));
        return json(x.pr.labels);
      }
      if (x && method === "DELETE") {
        x.pr.labels = x.pr.labels.filter((l) => l.name !== decodeURIComponent(m[2]));
        return json(x.pr.labels);
      }
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
    if (method === "GET" && (m = /^\/issues\/(\d+)\/timeline$/.exec(p))) return json(state.timelines[m[1]] || []);
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
// #8 is Running or In review with PR #13 on #7's files and one more.
const PR8 = (extra = {}) => ({ pr: { number: 13, state: "open", draft: false, mergeable: true, mergeable_state: "clean", head: { sha: "c".repeat(40), ref: "factory/8", repo: { full_name: REPO } }, base: { ref: "main" }, labels: [], ...extra }, files: [...SHARED3, "src/new.ts"] });
/** Factory's review-wait record on `n`'s PR, waiting for `on` since `sinceMs` (overlap.mjs reviewHold writes it). */
const holdRecord = (n, on, sinceMs, id = 950 + n) => ({ id, user: { login: SELF, type: "Bot" }, body: `${marker(n, "review-wait").replace(/ -->$/, "")}:${on}-${Math.floor(sinceMs / 1000)} -->\nFactory: its review waits for #${on}.`, created_at: new Date(sinceMs).toISOString(), updated_at: new Date(sinceMs).toISOString() });
const prLabels = (w, n) => w.state.prs[n].pr.labels.map((l) => l.name);
const waitsComment = (n, on, sinceMs) => ({ id: 900 + n, user: { login: SELF, type: "Bot" }, body: `${marker(n, "overlap", `waits-${on}-${Math.floor(sinceMs / 1000)}`)}\nFactory: this Objective waits for #${on}.`, created_at: new Date(sinceMs).toISOString() });

test("#340: a real dispatcher tick starts the Objective whose plan overlaps an In-review PR heavily (an answered Question's work pass), beside the next, and says on it that its review will wait", async () => {
  forgetFiles();
  // #8 (a rerun after its Question: its plan names #7's files) and #9 (fresh: no plan, no comments) are Queued, then
  // #10, whose plan shares one file with #7's PR.
  const w = world([issue(7, ["factory:in-review"], 3), issue(8, [], 1), issue(9), issue(10, [], 1)], {
    comments: { 7: [PLAN(7, SHARED3)], 8: [PLAN(8, [...SHARED3, "src/new.ts"])], 10: [PLAN(10, ["README.md", "src/a.ts", "src/b.ts"])] },
    prs: PR7(),
  });
  const r = await tick(w, { maxConcurrent: 3 });
  assert.deepEqual(r.ready, [8, 9, 10], "no pick waits at its start");
  assert.equal(r.skipped.filter((x) => /waits for/.test(x.reason)).length, 0);
  const [heavy] = overlap(w, 8);
  assert.ok(heavy?.body.startsWith(marker(8, "overlap", "beside")), heavy?.body);
  assert.match(heavy.body, /starts beside #7 \(`docs\/commands\.md`, `src\/commands\/run\.ts`, `test\/fixtures\/env\.ts`\).*With #7 it shares many: whichever is handed to review second waits until the other merges, then rebases once before its review\./);
  const [light] = overlap(w, 10);
  assert.match(light.body, /starts beside #7 \(`README\.md`\)/);
  assert.doesNotMatch(light.body, /shares many/);
  assert.equal(overlap(w, 9).length, 0, "a fresh Objective's files are unknown: nothing said");
});

test("#277: a sibling whose PR this tick merges is no sibling: the overlapping pick starts with no note", async () => {
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
  assert.deepEqual(r.ready, [8]);
  assert.equal(overlap(w, 8).length, 0, "a sibling that merged this tick is no sibling: no note");
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

test("#277: notes go only to the tick's final picks: a pick a later hold drops gets none", async () => {
  forgetFiles();
  const w = world([issue(7, ["factory:in-review"], 3), issue(9), issue(10, [], 1)], { comments: { 7: [PLAN(7, SHARED3)], 10: [PLAN(10, ["README.md", "src/a.ts", "src/b.ts"])] }, prs: PR7() });
  const r = await tick(w, {}, { localSlots: 1 });
  assert.deepEqual(r.ready, [9]);
  assert.equal(overlap(w, 10).length, 0, "#10 did not start this tick");
});

/** `fn` with `w` as GitHub (its fetch and URL), Factory's login known. */
async function withWorld(w, fn) {
  const realFetch = globalThis.fetch;
  const saved = process.env.GITHUB_API_URL;
  process.env.GITHUB_API_URL = "https://github.test";
  globalThis.fetch = w.fetch;
  setSelf(SELF);
  try {
    return await fn();
  } finally {
    globalThis.fetch = realFetch;
    if (saved === undefined) delete process.env.GITHUB_API_URL;
    else process.env.GITHUB_API_URL = saved;
  }
}

test("#340: the work stage's hand-off waits, unlabelled, while a sibling it overlaps heavily is In review: a record on the PR, a note on the issue; a Running sibling, one that waits itself, or no auto_merge holds nothing", async () => {
  forgetFiles();
  const now = Date.now();
  const w = world([issue(7, ["factory:in-review"], 3), issue(8, ["factory:running"], 1)], { comments: { 7: [PLAN(7, SHARED3)], 8: [PLAN(8, [...SHARED3, "src/new.ts"])] }, prs: { ...PR7(), 8: PR8() } });
  const held = await withWorld(w, () => reviewHold(repoOf(REPO), { issue: 8, pr: w.state.prs[8].pr, autoMerge: true }, { token: "t" }, { now }));
  assert.deepEqual(held, { on: 7, shared: [...SHARED3].sort(), of: 4 });
  assert.equal(waitReason(held), "its review waits for #7 to merge: both change 3 file(s) (`docs/commands.md`, `src/commands/run.ts`, `test/fixtures/env.ts`)");
  const record = w.state.comments[13].at(-1);
  assert.ok(record.body.startsWith(`<!-- factory:8:review-wait:7-${Math.floor(now / 1000)} -->`), record.body);
  assert.deepEqual(prLabels(w, 8), [], "no review label: no review starts");
  const [note] = overlap(w, 8);
  assert.ok(note.body.startsWith(marker(8, "overlap", `waits-7-${Math.floor(now / 1000)}`)), note.body);
  assert.match(note.body, /PR #13 is ready, and its review waits for #7 \(in review\) to merge: both change .*3 of this Objective's 4 known file\(s\).*after 6 h of waiting at most.*sends it back for one rebase when it conflicts/);

  // #7 Running (its work stage, not yet handed off): the first to hand off goes first, so nothing waits for it.
  forgetFiles();
  const running = world([issue(7, ["factory:running"], 3), issue(8, ["factory:running"], 1)], { comments: { 7: [PLAN(7, SHARED3)], 8: [PLAN(8, SHARED3)] }, prs: { 8: PR8() } });
  assert.equal(await withWorld(running, () => reviewHold(repoOf(REPO), { issue: 8, pr: running.state.prs[8].pr, autoMerge: true }, { token: "t" })), null);
  assert.equal(running.state.writes.length, 0);

  // #7's own hand-off waits (for #8, say, after its rebase): it is not waited for, so the two never hold each other.
  forgetFiles();
  const both = world([issue(7, ["factory:in-review"], 3), issue(8, ["factory:running"], 1)], { comments: { 7: [PLAN(7, SHARED3)], 8: [PLAN(8, SHARED3)], 12: [holdRecord(7, 8, now - 60_000)] }, prs: { ...PR7(), 8: PR8() } });
  assert.equal(await withWorld(both, () => reviewHold(repoOf(REPO), { issue: 8, pr: both.state.prs[8].pr, autoMerge: true }, { token: "t" })), null);

  // Without auto_merge a person merges In-review PRs, as long as they take: nothing waits, nothing is read.
  forgetFiles();
  const manual = world([issue(7, ["factory:in-review"], 3), issue(8, ["factory:running"], 1)], { comments: { 7: [PLAN(7, SHARED3)], 8: [PLAN(8, SHARED3)] }, prs: { ...PR7(), 8: PR8() } });
  assert.equal(await withWorld(manual, () => reviewHold(repoOf(REPO), { issue: 8, pr: manual.state.prs[8].pr, autoMerge: false }, { token: "t" })), null);
  assert.deepEqual(manual.state.reads, []);
});

test("#340: a real dispatcher tick leaves a waiting hand-off alone while its sibling is In review (no send-back, no review), then rebases it once the sibling merged, before its review", async () => {
  forgetFiles();
  const since = Date.now() - 3600_000;
  // #8's PR conflicts already (#7 is not merged: another PR landed): without the wait it would go back for a rebase now.
  const w = world([issue(7, ["factory:in-review"], 3), issue(8, ["factory:in-review"], 2)], {
    comments: { 7: [PLAN(7, SHARED3)], 8: [PLAN(8, [...SHARED3, "src/new.ts"]), waitsComment(8, 7, since)], 13: [holdRecord(8, 7, since)] },
    prs: { ...PR7(), 8: PR8({ mergeable_state: "dirty" }) },
  });
  const r = await tick(w);
  assert.deepEqual(r.reviewHeld, [8]);
  assert.deepEqual(r.sentBack, [], "no rebase while #7 is in review: a second sibling merge would need another");
  assert.deepEqual(prLabels(w, 8), []);
  assert.ok(w.state.comments[13].some((c) => c.id === 958), "the record stays");

  // #7 merged (its issue closed, its PR gone): #8's wait is over and it conflicts, so it goes back for its one rebase
  // this tick (the rebase's hand-off then labels it); the record goes and the note says so.
  w.state.issues = [issue(8, ["factory:in-review"], 2)];
  delete w.state.prs[7];
  const after = await tick(w);
  assert.deepEqual(after.reviewHeld, []);
  assert.deepEqual(after.sentBack, [8]);
  assert.ok(w.state.comments[13].some((c) => c.body.startsWith(marker(8, "rebase", "c".repeat(40)))), "the send-back's notice");
  assert.ok(!w.state.comments[13].some((c) => c.id === 958), "the record is gone");
  assert.ok(overlap(w, 8)[0].body.startsWith(marker(8, "overlap", "cleared")), overlap(w, 8)[0].body);
  assert.match(overlap(w, 8)[0].body, /no longer waits for #7: no sibling In review shares its files now/);
});

test("#340: a waiting hand-off that does not conflict once its sibling merged gets its review label the same tick; a stale record (a label put on since) is dropped and the PR handled as any", async () => {
  forgetFiles();
  const since = Date.now() - 3600_000;
  const w = world([issue(8, ["factory:in-review"], 2)], { comments: { 8: [PLAN(8, SHARED3), waitsComment(8, 7, since)], 13: [holdRecord(8, 7, since)] }, prs: { 8: PR8() } });
  const r = await tick(w);
  assert.deepEqual(r.reviewResumed, [8]);
  assert.deepEqual(prLabels(w, 8), ["factory:review"]);
  assert.deepEqual(w.state.comments[13], [], "the record is gone once the label is on");

  // A person put the review label on after the record (and the review took it off): the record is stale.
  forgetFiles();
  const v = world([issue(7, ["factory:in-review"], 3), issue(8, ["factory:in-review"], 2)], { comments: { 7: [PLAN(7, SHARED3)], 8: [PLAN(8, SHARED3)], 13: [holdRecord(8, 7, since)] }, prs: { ...PR7(), 8: PR8() } });
  v.state.timelines[13] = [{ event: "labeled", label: { name: "factory:review" }, created_at: new Date(since + 60_000).toISOString() }];
  const t = await tick(v);
  assert.deepEqual([t.reviewHeld, t.reviewResumed], [[], []]);
  assert.deepEqual(v.state.comments[13], [], "dropped");
  assert.deepEqual(prLabels(v, 8), [], "no label put on: its review already ran");
});

test("#340: a hand-off waits 6 h at most from its record, then its review goes on beside the sibling and the note says why; two that wait on each other are never both held", async () => {
  forgetFiles();
  const long = Date.now() - 7 * 3600_000;
  const w = world([issue(7, ["factory:in-review"], 3), issue(8, ["factory:in-review"], 2)], { comments: { 7: [PLAN(7, SHARED3)], 8: [PLAN(8, SHARED3), waitsComment(8, 7, long)], 13: [holdRecord(8, 7, long)] }, prs: { ...PR7(), 8: PR8() } });
  const r = await tick(w);
  assert.deepEqual(r.reviewResumed, [8]);
  assert.deepEqual(prLabels(w, 8), ["factory:review"]);
  assert.match(overlap(w, 8)[0].body, /stopped waiting for #7 after 6 h, the longest Factory holds a review for a sibling; its review goes on beside it/);

  // #7 and #8 both In review, each recorded waiting for the other (a race of two hand-offs): one tick releases one.
  forgetFiles();
  const since = Date.now() - 60_000;
  const prs = { ...PR7(), 8: PR8() };
  prs[7].pr.labels = [];
  const v = world([issue(7, ["factory:in-review"], 3), issue(8, ["factory:in-review"], 2)], { comments: { 7: [PLAN(7, SHARED3)], 8: [PLAN(8, SHARED3)], 12: [holdRecord(7, 8, since)], 13: [holdRecord(8, 7, since)] }, prs });
  const t = await tick(v);
  assert.equal(t.reviewHeld.length, 1, JSON.stringify(t));
  assert.equal(t.reviewResumed.length, 1);
  assert.notEqual(t.reviewHeld[0], t.reviewResumed[0]);
  // The next tick, the released one is In review with its label: the other still waits for it.
  const again = await tick(v);
  assert.deepEqual(again.reviewHeld, t.reviewHeld);
  assert.deepEqual(again.reviewResumed, []);
});

test("#340: \`factory run\` on an Objective whose hand-off waits reviews it now: the label goes on, the record goes", async () => {
  forgetFiles();
  const { Local } = await import("../scripts/local.mjs");
  const since = Date.now() - 60_000;
  const w = world([issue(7, ["factory:in-review"], 3), issue(8, ["factory:in-review"], 2)], { comments: { 8: [waitsComment(8, 7, since)], 13: [holdRecord(8, 7, since)] }, prs: { ...PR7(), 8: PR8() } });
  const seen = [];
  const loop = Object.assign(Object.create(Local.prototype), {
    repo: repoOf(REPO),
    opts: { token: "t" },
    reapHere: () => {},
    ws: () => "/nonexistent-ws",
    withClaim: async (_n, fn) => fn(),
    review: async (n, p) => (seen.push(["review", n, p, prLabels(w, 8)]), { exit: "delivered" }),
    followMerge: async () => assert.fail("its review comes first"),
  });
  const r = await withWorld(w, () => loop.runIssue(8, { waitMs: 1 }));
  assert.deepEqual(r, { exit: "delivered" });
  assert.deepEqual(seen, [["review", 8, 13, ["factory:review"]]]);
  assert.deepEqual(w.state.comments[13], []);
  assert.ok(overlap(w, 8)[0].body.startsWith(marker(8, "overlap", "cleared")));
});

test("#277: a run named by hand gets no note; with no active sibling and one slot, no files are read", async () => {
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

test("#277: a stopped rebase stage whose end runs out of time still leaves its rebase line: set before the slow read, written by the stop's write, never overwritten by the fallback", async () => {
  const { createServer } = await import("node:http");
  const { spawn } = await import("node:child_process");
  const { pathToFileURL } = await import("node:url");
  const { join } = await import("node:path");
  const lib = (f) => JSON.stringify(pathToFileURL(join(import.meta.dirname, "..", "scripts", "lib", f)).href);
  const bodies = [];
  const server = createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.method === "GET") return res.end("[]");
      const text = JSON.parse(b || "{}").body || "";
      bodies.push(`${req.method} ${text}`);
      res.end(JSON.stringify({ id: 9, user: { login: "me", type: "User" }, body: text }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const run = async (steps) => {
    const script = `
      import { progressReporter, rebaseExitLine, stoppedRebase } from ${lib("session.mjs")};
      import { repoOf } from ${lib("github.mjs")};
      const progress = progressReporter(repoOf("acme/app"), 7, { token: () => "t" }, { stage: "work", runId: "1", soFar: null });
      await progress("harness");
      ${steps}
      progress.flushNow();
      process.exit(0);
    `;
    bodies.length = 0;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { env: { HOME: process.env.HOME, PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, GITHUB_API_URL: `http://127.0.0.1:${server.address().port}` }, stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    child.stderr.on("data", (c) => (err += c));
    assert.equal(await new Promise((r) => child.on("exit", r)), 0, err);
    return bodies.at(-1) || "";
  };
  try {
    // The end's read of the earlier rebases never answers; the stop's fallback (worker endNow) runs meanwhile.
    const slow = await run(`void rebaseExitLine(progress, 7, { cost: { usd: 0.6 }, conflict: true, passes: 1 }, () => new Promise(() => {}));
      stoppedRebase(progress, true, [{ label: "work-1", usd: null }]);`);
    assert.match(slow, /^PATCH /, "the stop's write is made");
    assert.deepEqual(rebaseCostOf(slow), { usd: 0.6, conflict: true }, "the end's own figure, not the fallback's");
    // A clean rebase stopped before its end set the line: $0 spend already shown, the rebase line still written.
    const clean = await run(`progress.spend(0);
      stoppedRebase(progress, false, [{ label: "rebase", usd: 0, noRun: true }]);`);
    assert.deepEqual(rebaseCostOf(clean), { usd: 0, conflict: false });
    // A stopped pass counts at its live reading (stop.mjs stoppedRecords), a lower bound; so does a sum missing a pass.
    const cut = await run(`stoppedRebase(progress, false, [{ label: "fix-1", usd: 0.42, usdLowerBound: true }]);`);
    assert.deepEqual(rebaseCostOf(cut), { usd: 0.42, conflict: false, usdLowerBound: true });
    const part = await run(`stoppedRebase(progress, false, [{ label: "fix-1", usd: 0.2 }, { label: "fix-2", usd: null }]);`);
    assert.deepEqual(rebaseCostOf(part), { usd: 0.2, conflict: false, usdLowerBound: true });
  } finally {
    server.close();
  }
});

test("#277: a rebase's partial cost keeps its bound marks from the end's figure to the tally and the scorecard, and a sandbox rebase counts its sandbox", async () => {
  // As the spend line: a pass with no price beside a priced one leaves a lower bound; one priced at the dearest rates an estimate.
  assert.deepEqual(rebaseCost({ usd: 1.2, usdLowerBound: true }, { records: [{ usd: 1.2 }, { usd: null }] }), { usd: 1.2, usdLowerBound: true });
  assert.deepEqual(rebaseCost({ usd: 0.5, usdUpperBound: true }, { records: [{ usd: 0.5, usdUpperBound: true }] }), { usd: 0.5, usdUpperBound: true });
  assert.deepEqual(rebaseCost(null, { records: [{ usd: null }], known: { usd: 0.3 } }), { usd: 0.3, usdLowerBound: true });
  assert.deepEqual(rebaseCost({ usd: null }, { records: [{ usd: null }] }), { usd: null });
  assert.deepEqual(rebaseCost({ usd: null }, { records: [{ usd: null, noRun: true }] }), { usd: 0 });

  const written = [];
  const realFetch = globalThis.fetch;
  const savedUrl = process.env.GITHUB_API_URL;
  process.env.GITHUB_API_URL = "https://github.test";
  globalThis.fetch = async (url, init = {}) => {
    if ((init.method || "GET") === "GET") return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    written.push(JSON.parse(init.body).body);
    return new Response(JSON.stringify({ id: 1 }), { status: 200, headers: { "content-type": "application/json" } });
  };
  let line;
  try {
    const progress = progressReporter(repoOf(REPO), 7, { token: "t" }, { stage: "work", runId: "43", soFar: null });
    const cost = rebaseCost({ usd: 1.2, usdLowerBound: true }, { records: [{ usd: 1.2 }, { usd: null }] });
    const before = `${marker(7, "progress", "work:41")}\nFactory work: started.\n<!-- factory:rebase-cost {"usd":0.5,"conflict":false} -->`;
    line = await rebaseExitLine(progress, 7, { cost, conflict: true, passes: 2 }, async () => [{ id: 1, user: { login: SELF, type: "Bot" }, body: before }]);
    await progress(`exit: delivered; ${line}`);
  } finally {
    globalThis.fetch = realFetch;
    if (savedUrl === undefined) delete process.env.GITHUB_API_URL;
    else process.env.GITHUB_API_URL = savedUrl;
  }
  assert.equal(line, "rebase 2 of this Objective (a conflict pass): at least $1.20; all its rebases: at least $1.70");
  const body = written.at(-1);
  assert.deepEqual(rebaseCostOf(body), { usd: 1.2, conflict: true, usdLowerBound: true });

  const at = (m) => new Date(Date.UTC(2026, 10, 14, 10, m)).toISOString();
  const own = (b, m) => ({ id: m, user: { login: SELF, type: "Bot" }, body: b, created_at: at(m) });
  // The sandbox route: the launcher books the sandbox's dollars in a vendor comment keyed as the stage's progress comment.
  const sandbox = own(`${marker(7, "progress", "work:44")}\nFactory work: started.\n<!-- factory:rebase-cost {"usd":0.3,"conflict":false} -->`, 3);
  const vendor = own(`${marker(7, "vendor", "work:44")}\n${vendorBody({ line: "sandbox", vendorUsd: 0.05 })}`, 4);
  const comments = [own(body.startsWith("<!--") ? body : `${marker(7, "progress", "work:43")}\n${body}`, 2), sandbox, vendor];
  assert.deepEqual(rebaseTally(comments, 7, (c) => c.user.login === SELF), { count: 2, usd: 1.55, unmetered: 0, conflicts: 1, usdLowerBound: true });

  const collected = { repository: REPO, issue: { number: 7, title: "x", created_at: at(0), labels: [], state: "open" }, issueTimeline: [{ event: "labeled", label: { name: "factory:running" }, actor: { login: SELF, type: "Bot" }, created_at: at(0) }], issueComments: comments, pulls: [], pullDetails: {} };
  const rebases = rebasesOf(collected);
  assert.deepEqual(rebases, { sentBack: 0, stages: 2, usd: 1.55, unmetered: 0, conflicts: 1, usdLowerBound: true });
  assert.match(rebaseCell(rebases), /^0, at least \$1\.55/);
});

test("#277: a sandbox rebase's vendor cost keeps its marks: the session's ceiling makes the rebases an upper bound, an unpriced sandbox a lower bound, in the tally, the cell and the row's cost", () => {
  const at = (m) => new Date(Date.UTC(2026, 10, 14, 10, m)).toISOString();
  const own = (b, m) => ({ id: m, user: { login: SELF, type: "Bot" }, body: b, created_at: at(m) });
  const stage = (run, m) => own(`${marker(7, "progress", `work:${run}`)}\nFactory work: started.\n<!-- factory:spend {"usd":0.3} -->\n<!-- factory:rebase-cost {"usd":0.3,"conflict":false} -->`, m);
  // stageVendorCost's ceiling (its usage not read or not settled), booked as the launcher books it.
  const ceiling = own(`${marker(7, "vendor", "work:51")}\n${vendorBody({ line: "sandbox", vendorUsd: 0.08, upperBound: true })}`, 2);
  const unpriced = own(`${marker(7, "vendor", "work:52")}\n${vendorBody({ line: "sandbox", vendorUsd: null })}`, 4);
  assert.equal(spendOf(unpriced.body), 0, "an unpriced sandbox adds nothing to the daily sum");
  const mine = (c) => c.user.login === SELF;
  assert.deepEqual(rebaseTally([stage(51, 1), ceiling], 7, mine), { count: 1, usd: 0.38, unmetered: 0, conflicts: 0, usdUpperBound: true });
  assert.deepEqual(rebaseTally([stage(52, 3), unpriced], 7, mine), { count: 1, usd: 0.3, unmetered: 0, conflicts: 0, usdLowerBound: true });
  assert.equal(rebaseLine({ usd: 0.1, conflict: false, passes: 1 }, rebaseTally([stage(51, 1), ceiling], 7, mine)), "rebase 2 of this Objective (clean, 1 fix pass(es)): $0.10; all its rebases: at most $0.48 (an estimate)");

  const comments = [stage(51, 1), ceiling, stage(52, 3), unpriced];
  const collected = { repository: REPO, issue: { number: 7, title: "x", created_at: at(0), labels: [], state: "open" }, issueTimeline: [{ event: "labeled", label: { name: "factory:running" }, actor: { login: SELF, type: "Bot" }, created_at: at(0) }], issueComments: comments, pulls: [], pullDetails: {} };
  const rebases = rebasesOf(collected);
  assert.deepEqual(rebases, { sentBack: 0, stages: 2, usd: 0.68, unmetered: 0, conflicts: 0, usdLowerBound: true, usdUpperBound: true });
  assert.match(rebaseCell(rebases), /^0, about \$0\.68/);
  // The row's cost reads the same vendor comments: the ceiling stays an upper bound, the unpriced one unpriced.
  assert.deepEqual(spendRecords(collected).map((r) => r.vendor), [{ usd: 0.08, upperBound: true }, { usd: null }]);
});
