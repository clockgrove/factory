import "./temp.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { RETRY, repoOf } from "../scripts/lib/github.mjs";
import { marker, rebaseCost, rebaseCostOf, rebaseLine, rebaseTally, setSelf, spendOf, vendorBody } from "../scripts/lib/logic.mjs";
import { forgetFiles, plannedFiles, reviewHold, reviewWaitOf, siblingOrder, waitReason } from "../scripts/lib/overlap.mjs";
import { progressReporter, rebaseExitLine, rebaseNotice } from "../scripts/lib/session.mjs";
import { markdownTable, rebaseCell, rebasesOf, spendRecords } from "../../bench/lib/objective.mjs";

RETRY.sleep = async () => {};

// #277: Objectives that change the same files ran at once and rebased over each other one merge at a time (one spent
// $18.32 against a median of $8.55, almost all of it rebases). Every rebase's cost is on the issue and in the scorecard.
// #340: holding the start of such an Objective held its whole work stage (an answered Question's pass, a resumed draft)
// for a sibling's review and merge, so hot-file Objectives ran one at a time. They start; the hand-off to review waits.

const REPO = "acme/app";
const SELF = "pendulum-app[bot]";
const PLAN = (n, files) => ({ id: 500 + n, user: { login: SELF, type: "Bot" }, body: `${marker(n, "plan")}\n## Checklist\n1. The change\n   Files: ${files.join(", ")}\n`, created_at: new Date(Date.now() - 60_000).toISOString() });

/**
 * acme/app on the test's git server (temp.mjs GITHUB_SERVER_URL), where the trial merges fetch from: `main` starts with
 * every file of FILES at LINES lines. `head(tag, edits)` commits on main's first commit, `next(sha, tag, edits)` on
 * `sha`, and `onMain(tag, edits)` on main's head now: each edit `{path: [line, ...]}` writes `tag` over those lines (a
 * path missing starts as LINES lines; `null` deletes the path, `{to, lines}` moves it to `to` and writes there), and the
 * commit is pushed under a ref of its own; each returns its id.
 * `advance(tag, edits)` commits on main and moves main there (another PR merged); `land(sha)` moves main to `sha`, a
 * commit on main's head (the PR merged). Two heads that write different tags over one line conflict there.
 */
const LINES = 30;
const FILES = ["test/fixtures/env.ts", "docs/commands.md", "src/commands/run.ts", "README.md", "src/registry.ts", ...Array.from({ length: 6 }, (_, i) => `src/m${i}.ts`)];
function gitServer() {
  const origin = join(process.env.GITHUB_SERVER_URL, "acme", "app.git");
  const work = mkdtempSync(join(tmpdir(), "work-"));
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.test" };
  const git = (...args) => execFileSync("git", ["-C", work, ...args], { encoding: "utf8", env }).trim();
  mkdirSync(dirname(origin), { recursive: true });
  execFileSync("git", ["init", "-q", "--bare", "--initial-branch=main", origin]);
  git("init", "-q", "-b", "main");
  const lines = (path) => Array.from({ length: LINES }, (_, i) => `${path} ${i}`);
  const put = (path, text) => {
    mkdirSync(dirname(join(work, path)), { recursive: true });
    writeFileSync(join(work, path), text);
  };
  for (const f of FILES) put(f, `${lines(f).join("\n")}\n`);
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  git("push", "-q", origin, "main");
  const base = git("rev-parse", "HEAD");
  let main = base;
  let n = 0;
  const commit = (from, tag, changes) => {
    git("checkout", "-q", "--detach", from);
    for (let [path, at] of Object.entries(changes)) {
      // `null`: the file goes; `{to, lines}`: it moves to `to`, then those lines change there.
      if (at === null) {
        git("rm", "-q", path);
        continue;
      }
      if (!Array.isArray(at)) {
        mkdirSync(dirname(join(work, at.to)), { recursive: true });
        git("mv", path, at.to);
        [path, at] = [at.to, at.lines];
      }
      const file = join(work, path);
      const text = existsSync(file) ? readFileSync(file, "utf8").split("\n").slice(0, -1) : lines(path);
      for (const k of at) text[k] = `${tag} ${path} ${k}`;
      put(path, `${text.join("\n")}\n`);
    }
    git("add", "-A");
    git("commit", "-q", "-m", tag);
    const sha = git("rev-parse", "HEAD");
    git("push", "-q", origin, `HEAD:refs/heads/t${n++}`);
    return sha;
  };
  const land = (sha) => {
    git("push", "-q", origin, `+${sha}:refs/heads/main`);
    main = sha;
  };
  return {
    head: (tag, changes) => commit(base, tag, changes),
    next: (sha, tag, changes) => commit(sha, tag, changes),
    onMain: (tag, changes) => commit(main, tag, changes),
    advance: (tag, changes) => land(commit(main, tag, changes)),
    land,
    /** Main back at its first commit (a test that moved it, done). */
    reset: () => land(base),
  };
}
const G = gitServer();
/** Edits of line `k` in each of `paths`. */
const edits = (paths, k) => Object.fromEntries(paths.map((p) => [p, [k]]));

test("#277: the plan's Files: lines are its file list; prose and odd entries are not read", () => {
  const plan = ["1. Parser", "   Files: `src/parse.ts`, ./docs/usage.md", "- [ ] **Files:** test/fixtures/env.ts", "The Files mentioned in src/other.ts are not a list.", "Files: /etc/passwd, ../up.md, https://x.test/a, has space.md, src/parse.ts"].join("\n");
  assert.deepEqual(plannedFiles(plan), ["src/parse.ts", "docs/usage.md", "test/fixtures/env.ts"]);
  assert.deepEqual(plannedFiles("no list here"), []);
});

test("#340: siblingOrder starts every pick while slots last, overlap or not, and notes each overlap", () => {
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
    { number: 8, with: [{ number: 7, shared: ["a", "b", "c"] }] },
    { number: 10, with: [{ number: 7, shared: ["a"] }, { number: 8, shared: ["a"] }] },
    { number: 11, with: [{ number: 10, shared: ["x", "y"] }] },
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
    // The merge queue's reads (github.mjs inMergeQueue, mergeQueueRemovals, mergeQueueEntry), from `state.queue` by PR.
    if (u.pathname === "/graphql") {
      const q = state.queue?.[body?.variables?.n];
      if (!q) return json({ data: {} });
      const pullRequest = body.query.includes("isInMergeQueue") ? { isInMergeQueue: !!q.entry } : body.query.includes("timelineItems") ? { timelineItems: { nodes: q.removals || [] } } : { mergeQueueEntry: q.entry ?? null };
      return json({ data: { repository: { pullRequest } } });
    }
    let m;
    if (method === "GET") state.reads.push(`${p}${u.search}`);
    else state.writes.push(`${method} ${p}${body?.body ? ` ${body.body}` : ""}`);
    if (method === "GET" && u.pathname === "/user") return json({ login: SELF, type: "Bot" });
    if (method === "GET" && p === "/issues") return json(u.searchParams.get("state") === "closed" ? [] : state.issues.filter((i) => i.labels.some((l) => l.name === u.searchParams.get("labels"))));
    if (method === "GET" && p === "") return json({ default_branch: "main" });
    // `state.queue` set: a ruleset with a merge queue on the default branch.
    if (method === "GET" && p === "/rulesets") return json(state.queue ? [{ id: 1, target: "branch", enforcement: "active" }] : []);
    if (method === "GET" && p === "/rulesets/1" && state.queue) return json({ conditions: { ref_name: { include: ["~DEFAULT_BRANCH"] } }, rules: [{ type: "merge_queue", parameters: {} }] });
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
      // A fork's PR from a branch of the same name: never one of Pendulum's.
      const fork = { number: 99, state: "open", head: { ref: "pendulum/8", sha: "f".repeat(40), repo: { full_name: "mallory/app" } }, base: { ref: "main" } };
      if (!head) return json([...Object.values(state.prs).map((x) => x.pr), fork]);
      const n = /:pendulum\/(\d+)$/.exec(head)?.[1];
      return json(n && state.prs[n] ? [state.prs[n].pr] : []);
    }
    if (method === "GET" && (m = /^\/pulls\/(\d+)\/files$/.exec(p))) return json(Number(m[1]) === 99 ? ["src/parse.ts", "a.md", "b.md", "c.md"].map((filename) => ({ filename })) : (Object.values(state.prs).find((x) => x.pr.number === Number(m[1]))?.files || []).map((filename) => ({ filename })));
    if (method === "GET" && (m = /^\/pulls\/(\d+)$/.exec(p))) return json(Object.values(state.prs).find((x) => x.pr.number === Number(m[1]))?.pr ?? {});
    if (method === "GET" && /\/actions\/(workflows\/[^/]+\/)?runs$/.test(p)) return json({ workflow_runs: [] });
    if (method === "GET" && (m = /^\/issues\/(\d+)\/timeline$/.exec(p))) return json(state.timelines[m[1]] || []);
    // The merge pass's reads and its merge (session.mjs mergeReadyOne): the Objective, the PR's review, green CI.
    if (method === "GET" && (m = /^\/issues\/(\d+)$/.exec(p))) return json(state.issues.find((i) => i.number === Number(m[1])) ?? { message: "Not Found" }, state.issues.some((i) => i.number === Number(m[1])) ? 200 : 404);
    if (method === "GET" && /^\/pulls\/\d+\/comments$/.test(p)) return json([]);
    if (method === "GET" && (m = /^\/pulls\/(\d+)\/reviews$/.exec(p))) return json([{ id: 1, user: { login: SELF, type: "Bot" }, body: `${marker(7, "review")}\nPendulum reviewer`, submitted_at: state.reviewedAt ?? new Date().toISOString() }]);
    if (method === "GET" && /\/check-runs$/.test(p)) return json({ total_count: 1, check_runs: [{ id: 1, name: "ci", status: "completed", conclusion: "success", app: { id: 15368 } }] });
    if (method === "GET" && /\/commits\/[0-9a-f]+\/status$/.test(p)) return json({ statuses: [] });
    if (method === "GET" && (m = /^\/commits\/([0-9a-f]+)$/.exec(p))) return json({ sha: m[1], parents: [], commit: { committer: { date: "2026-01-01T00:00:00Z" } } });
    if (method === "PUT" && (m = /^\/pulls\/(\d+)\/merge$/.exec(p))) {
      const x = Object.values(state.prs).find((y) => y.pr.number === Number(m[1]));
      Object.assign(x.pr, { state: "closed", merged: true });
      state.mergedPrs = [...(state.mergedPrs || []), x.pr.number];
      state.onMerge?.(x.pr.number);
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
  const saved = Object.fromEntries(["PENDULUM_LOCAL", "PENDULUM_LOCAL_ALL", "GITHUB_API_URL"].map((k) => [k, process.env[k]]));
  process.env.GITHUB_API_URL = "https://github.test";
  delete process.env.PENDULUM_LOCAL;
  delete process.env.PENDULUM_LOCAL_ALL;
  globalThis.fetch = w.fetch;
  try {
    return await dispatch({ repo: REPO, objectiveLabel: "pendulum:objective", maxConcurrent: 2, dailyUsd: 0, ciChecks: [], timeoutMinutes: 60, autoMerge: true, notify: "", ...inputs }, { token: "t", ...opts });
  } finally {
    globalThis.fetch = realFetch;
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

const UPDATED = new Date(Date.now() - 3600_000).toISOString();
const issue = (n, labels = [], comments = 0) => ({ number: n, state: "open", title: `Objective ${n}`, labels: ["pendulum:objective", ...labels].map((name) => ({ name })), body: "", comments, updated_at: UPDATED, user: { login: "maintainer" } });
const overlap = (w, n) => (w.state.comments[n] || []).filter((c) => c.body.startsWith(marker(n, "overlap").replace(/ -->$/, "")));
const SHARED3 = ["test/fixtures/env.ts", "docs/commands.md", "src/commands/run.ts"];
// #7's head and #8's both write line 2 of the fixture, docs and command files: a trial merge conflicts in those three.
const H7 = G.head("seven", edits([...SHARED3, "README.md"], 2));
const H8 = G.head("eight", { ...edits(SHARED3, 2), "src/new.ts": [0] });
// #7 is In review with PR #12 under review (its label on: no merge this tick) on the fixture, docs and command files.
const PR7 = () => ({ 7: { pr: { number: 12, state: "open", draft: false, mergeable: true, mergeable_state: "clean", head: { sha: H7, ref: "pendulum/7", repo: { full_name: REPO } }, base: { ref: "main" }, labels: [{ name: "pendulum:review" }] }, files: ["test/fixtures/env.ts", "docs/commands.md", "src/commands/run.ts", "README.md"] } });
// #8 is Running or In review with PR #13 on #7's files and one more.
const PR8 = (extra = {}) => ({ pr: { number: 13, state: "open", draft: false, mergeable: true, mergeable_state: "clean", head: { sha: H8, ref: "pendulum/8", repo: { full_name: REPO } }, base: { ref: "main" }, labels: [], ...extra }, files: [...SHARED3, "src/new.ts"] });
/** Pendulum's review-wait record on `n`'s PR, waiting for `on` since `sinceMs` (overlap.mjs reviewHold writes it). */
const holdRecord = (n, on, sinceMs, id = 950 + n, released = false) => ({ id, user: { login: SELF, type: "Bot" }, body: `${marker(n, "review-wait").replace(/ -->$/, "")}:${on}-${Math.floor(sinceMs / 1000)}${released ? "-released" : ""} -->\nPendulum: its review waits for #${on}.`, created_at: new Date(sinceMs).toISOString(), updated_at: new Date(sinceMs).toISOString() });
const prLabels = (w, n) => w.state.prs[n].pr.labels.map((l) => l.name);
const waitsComment = (n, on, sinceMs) => ({ id: 900 + n, user: { login: SELF, type: "Bot" }, body: `${marker(n, "overlap", `waits-${on}-${Math.floor(sinceMs / 1000)}`)}\nPendulum: this Objective waits for #${on}.`, created_at: new Date(sinceMs).toISOString() });

test("#340: a real dispatcher tick starts the Objective whose plan overlaps an In-review PR (an answered Question's work pass), beside the next, and says on it that its review waits where they conflict", async () => {
  forgetFiles();
  // #8 (a rerun after its Question: its plan names #7's files) and #9 (fresh: no plan, no comments) are Queued, then
  // #10, whose plan shares one file with #7's PR.
  const w = world([issue(7, ["pendulum:in-review"], 3), issue(8, [], 1), issue(9), issue(10, [], 1)], {
    comments: { 7: [PLAN(7, SHARED3)], 8: [PLAN(8, [...SHARED3, "src/new.ts"])], 10: [PLAN(10, ["README.md", "src/a.ts", "src/b.ts"])] },
    prs: PR7(),
  });
  const r = await tick(w, { maxConcurrent: 3 });
  assert.deepEqual(r.ready, [8, 9, 10], "no pick waits at its start");
  assert.equal(r.skipped.filter((x) => /waits for/.test(x.reason)).length, 0);
  const [many] = overlap(w, 8);
  assert.ok(many?.body.startsWith(marker(8, "overlap", "beside")), many?.body);
  assert.match(many.body, /starts beside #7 \(`docs\/commands\.md`, `src\/commands\/run\.ts`, `test\/fixtures\/env\.ts`\).*Where their changes conflict, whichever is handed to review second waits until the other merges, then rebases once before its review\./);
  const [one] = overlap(w, 10);
  assert.match(one.body, /starts beside #7 \(`README\.md`\)/);
  // Without auto_merge a person merges, and nothing waits: the note does not say it would.
  forgetFiles();
  const manual = world([issue(7, ["pendulum:running"], 3), issue(8, [], 1)], { comments: { 7: [PLAN(7, SHARED3)], 8: [PLAN(8, SHARED3)] } });
  await tick(manual, { autoMerge: false });
  assert.match(overlap(manual, 8)[0].body, /starts beside #7/);
  assert.doesNotMatch(overlap(manual, 8)[0].body, /waits until the other merges/);
  assert.equal(overlap(w, 9).length, 0, "a fresh Objective's files are unknown: nothing said");
});

test("#277: a sibling whose PR this tick merges is no sibling: the overlapping pick starts with no note", async () => {
  forgetFiles();
  const prs = PR7();
  // Reviewed (its review label off), validated and recorded mergeable, CI green: the merge pass merges it this tick.
  prs[7].pr.labels = [];
  const record = { id: 777, user: { login: SELF, type: "Bot" }, body: `${marker(7, "mergeable").replace(/ -->$/, "")}:${prs[7].pr.head.sha} -->\nPendulum: reviewed and validated.`, created_at: new Date().toISOString() };
  // #7's known files are its PR's (no plan comment: the merge's check of the text against a plan is not this test's).
  const w = world([issue(7, ["pendulum:in-review"], 3), issue(8, [], 1)], { comments: { 8: [PLAN(8, SHARED3)], 12: [record] }, prs });
  const r = await tick(w, { ciChecks: ["ci"] });
  assert.deepEqual(w.state.mergedPrs, [12], `the merge pass merged #7's PR: ${JSON.stringify(r.merged)}`);
  assert.deepEqual(r.merged, [7]);
  assert.deepEqual(r.ready, [8]);
  assert.equal(overlap(w, 8).length, 0, "a sibling that merged this tick is no sibling: no note");
});

test("#277: placeholders, globs and directories in Files: lines are no files, so they make no overlap", async () => {
  forgetFiles();
  const placeholders = { id: 600, user: { login: SELF, type: "Bot" }, body: `${marker(7, "plan")}\n1. Notes only\n   Files: none\n2. Docs\n   Files: docs/, src/*.ts, (none)\n3. Code\n   Files: src/a.ts\n` };
  const w = world([issue(7, ["pendulum:running"], 1), issue(8, [], 1)], { comments: { 7: [placeholders], 8: [PLAN(8, ["(none)", "n/a", "TBD", "-", "—", "docs/", "src/*.ts", "none", "src/b.ts"])] } });
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
  const w = world([issue(7, ["pendulum:in-review"], 3), issue(9), issue(10, [], 1)], { comments: { 7: [PLAN(7, SHARED3)], 10: [PLAN(10, ["README.md", "src/a.ts", "src/b.ts"])] }, prs: PR7() });
  const r = await tick(w, {}, { localSlots: 1 });
  assert.deepEqual(r.ready, [9]);
  assert.equal(overlap(w, 10).length, 0, "#10 did not start this tick");
});

/** `fn` with `w` as GitHub (its fetch and URL), Pendulum's login known. */
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

test("#340: the work stage's hand-off waits, unlabelled, while a sibling it overlaps heavily is ahead of it: a record on the PR, a note on the issue; a Running sibling, a later waiter, or no auto_merge holds nothing", async () => {
  forgetFiles();
  const now = Date.now();
  const w = world([issue(7, ["pendulum:in-review"], 3), issue(8, ["pendulum:running"], 1)], { comments: { 7: [PLAN(7, SHARED3)], 8: [PLAN(8, [...SHARED3, "src/new.ts"])] }, prs: { ...PR7(), 8: PR8() } });
  const held = await withWorld(w, () => reviewHold(repoOf(REPO), { issue: 8, pr: w.state.prs[8].pr, autoMerge: true }, { token: "t" }, { now }));
  assert.deepEqual(held, { on: 7, files: [...SHARED3].sort(), cause: null, unread: [] });
  assert.equal(waitReason(held), "its review waits for #7 to merge: a trial merge of the two heads conflicts in 3 file(s) (`docs/commands.md`, `src/commands/run.ts`, `test/fixtures/env.ts`)");
  const record = w.state.comments[13].at(-1);
  assert.ok(record.body.startsWith(`<!-- pendulum:8:review-wait:7-${Math.floor(now / 1000)} -->`), record.body);
  assert.deepEqual(prLabels(w, 8), [], "no review label: no review starts");
  const [note] = overlap(w, 8);
  assert.ok(note.body.startsWith(marker(8, "overlap", `waits-7-${Math.floor(now / 1000)}`)), note.body);
  assert.match(note.body, /PR #13 is ready, and its review waits for #7 to merge: a trial merge of the two heads conflicts in 3 file\(s\) \(`docs\/commands\.md`, `src\/commands\/run\.ts`, `test\/fixtures\/env\.ts`\)\..*after 6 h of waiting at most since its first wait.*sends it back for its rebase when it conflicts/);

  // #7 Running its work stage (no record: not handed off yet): the first to hand off goes first.
  forgetFiles();
  const running = world([issue(7, ["pendulum:running"], 3), issue(8, ["pendulum:running"], 1)], { comments: { 7: [PLAN(7, SHARED3)], 8: [PLAN(8, SHARED3)] }, prs: { ...PR7(), 8: PR8() } });
  running.state.prs[7].pr.labels = [];
  assert.equal(await withWorld(running, () => reviewHold(repoOf(REPO), { issue: 8, pr: running.state.prs[8].pr, autoMerge: true }, { token: "t" })), null);
  assert.equal(running.state.writes.length, 0);
  // #7 Running the rebase that follows its own wait (its record released): it is ahead.
  running.state.comments[12] = [holdRecord(7, 6, now - 3600_000, 957, true)];
  forgetFiles();
  assert.equal((await withWorld(running, () => reviewHold(repoOf(REPO), { issue: 8, pr: running.state.prs[8].pr, autoMerge: true }, { token: "t" })))?.on, 7);

  // #7 waits itself (for #6), from earlier: it is ahead, and the note says why it holds. A local loop wrote #7's record
  // as its developer: a writer's record counts.
  forgetFiles();
  const dev = { ...holdRecord(7, 6, now - 60_000), user: { login: "kirk", type: "User" }, author_association: "MEMBER" };
  const chain = world([issue(7, ["pendulum:in-review", "pendulum:local"], 3), issue(8, ["pendulum:running"], 1)], { comments: { 7: [PLAN(7, SHARED3)], 8: [PLAN(8, SHARED3)], 12: [dev] }, prs: { ...PR7(), 8: PR8() } });
  chain.state.prs[7].pr.labels = [];
  const behind = await withWorld(chain, () => reviewHold(repoOf(REPO), { issue: 8, pr: chain.state.prs[8].pr, autoMerge: true }, { token: "t" }, { now }));
  assert.equal(behind?.cause, "it waits for #6 itself");
  assert.match(overlap(chain, 8)[0].body, /waits for #7 to merge \(it waits for #6 itself\)/);
  // #8 waited before (its own record, released, from two hours ago): it keeps that start, so #7, waiting since a
  // minute ago, comes after it in the release order and does not hold it.
  forgetFiles();
  chain.state.comments[13] = [holdRecord(8, 5, now - 2 * 3600_000, 958, true)];
  chain.state.writes.length = 0;
  assert.equal(await withWorld(chain, () => reviewHold(repoOf(REPO), { issue: 8, pr: chain.state.prs[8].pr, autoMerge: true }, { token: "t" }, { now })), null);
  // Held again, it keeps its first wait start (the bound is per Objective).
  chain.state.comments[12] = [];
  forgetFiles();
  await withWorld(chain, () => reviewHold(repoOf(REPO), { issue: 8, pr: chain.state.prs[8].pr, autoMerge: true }, { token: "t" }, { now }));
  assert.ok(chain.state.comments[13].at(-1).body.startsWith(`<!-- pendulum:8:review-wait:7-${Math.floor((now - 2 * 3600_000) / 1000)} -->`), chain.state.comments[13].at(-1).body);

  // The rebase that follows #8's own wait (its record released) goes to review: it is next. So does a reviewed head
  // Pendulum rebased, with nothing read.
  forgetFiles();
  const next = world([issue(7, ["pendulum:in-review"], 3), issue(8, ["pendulum:running"], 1)], { comments: { 7: [PLAN(7, SHARED3)], 8: [PLAN(8, SHARED3)], 13: [holdRecord(8, 7, now - 60_000, 958, true)] }, prs: { ...PR7(), 8: PR8() } });
  assert.equal(await withWorld(next, () => reviewHold(repoOf(REPO), { issue: 8, pr: next.state.prs[8].pr, autoMerge: true, rebaseMode: true }, { token: "t" })), null);
  assert.equal(next.state.writes.length, 0);
  next.state.reads.length = 0;
  assert.equal(await withWorld(next, () => reviewHold(repoOf(REPO), { issue: 8, pr: next.state.prs[8].pr, autoMerge: true, rebaseMode: true, reviewed: true }, { token: "t" })), null);
  assert.deepEqual(next.state.reads, []);

  // Without auto_merge a person merges In-review PRs, as long as they take: nothing waits, nothing is read.
  forgetFiles();
  const manual = world([issue(7, ["pendulum:in-review"], 3), issue(8, ["pendulum:running"], 1)], { comments: { 7: [PLAN(7, SHARED3)], 8: [PLAN(8, SHARED3)] }, prs: { ...PR7(), 8: PR8() } });
  assert.equal(await withWorld(manual, () => reviewHold(repoOf(REPO), { issue: 8, pr: manual.state.prs[8].pr, autoMerge: false }, { token: "t" })), null);
  assert.deepEqual(manual.state.reads, []);

  // The worker hands off through reviewHold with its rebase state, and labels only what it does not hold.
  const src = readFileSync(join(import.meta.dirname, "..", "scripts", "worker.mjs"), "utf8");
  assert.match(src, /const held = await reviewHold\(repo, \{ issue, pr, head: outbox\?\.expected\(\) \|\| pr\.head\?\.sha, autoMerge: inputs\.autoMerge, hold: inputs\.siblingHold, objectiveLabel: inputs\.objectiveLabel, rebaseMode, reviewed, waitMaxMs: inputs\.siblingWaitMs \}, token, \{ log \}\);\n\s*if \(held\) decision\.reason = [^\n]*\n\s*else await exitStep\(decision, "the review label could not be applied[^\n]*addLabels\(repo, pr\.number, \[REVIEW_LABEL\], token\)\);/);
});

/**
 * The worker's rebase of a PR the dispatcher sent back, as far as GitHub sees it: a new head (one more commit on the
 * old, so it still conflicts with the siblings it conflicted with), no conflict with main, its hand-off.
 */
async function rebased(w, n, { held = null, onto = null } = {}) {
  const x = w.state.prs[n];
  // `onto`: its edits made again on main's head now (the conflict resolved), else one more commit on its head.
  x.pr.head.sha = onto ? G.onMain(`rebased ${n}`, onto) : G.next(x.pr.head.sha, `rebased ${n}`, { [`src/rebased${n}.ts`]: [0] });
  x.pr.mergeable_state = "clean";
  forgetFiles();
  const wait = held ?? (await withWorld(w, () => reviewHold(repoOf(REPO), { issue: n, pr: x.pr, autoMerge: true, rebaseMode: true }, { token: "t" })));
  assert.equal(wait, null, `#${n}'s rebase after its wait goes to review`);
  x.pr.labels = [{ name: "pendulum:review" }];
  w.state.issues = w.state.issues.map((i) => (i.number === n ? issue(n, ["pendulum:in-review"], i.comments) : i));
}

test("#340: three hand-offs waiting on one sibling that conflict once it merges each rebase exactly once: one goes per merge, the oldest wait first, and none is sent back while the one ahead rebases", async () => {
  forgetFiles();
  const t0 = Date.now() - 3 * 3600_000;
  const files = (n) => [...SHARED3, `src/${n}.ts`];
  // Each head writes line 2 of the three hot files: every two of them conflict.
  const pr = (n, number) => ({ pr: { number, state: "open", draft: false, mergeable: true, mergeable_state: "dirty", head: { sha: G.head(`h${n}`, { ...edits(SHARED3, 2), [`src/${n}.ts`]: [0] }), ref: `pendulum/${n}`, repo: { full_name: REPO } }, base: { ref: "main" }, labels: [] }, files: files(n) });
  // #10 waited first, then #8, then #9: the release order is #10, #8, #9, whatever their numbers.
  const since = { 10: t0, 8: t0 + 60_000, 9: t0 + 120_000 };
  const w = world([issue(8, ["pendulum:in-review"], 1), issue(9, ["pendulum:in-review"], 1), issue(10, ["pendulum:in-review"], 1)], {
    comments: { 8: [PLAN(8, files(8))], 9: [PLAN(9, files(9))], 10: [PLAN(10, files(10))], 13: [holdRecord(8, 7, since[8])], 14: [holdRecord(9, 7, since[9])], 15: [holdRecord(10, 7, since[10])] },
    prs: { 8: pr(8, 13), 9: pr(9, 14), 10: pr(10, 15) },
  });
  const prOf = { 8: 13, 9: 14, 10: 15 };
  const notices = (n) => (w.state.comments[prOf[n]] || []).filter((c) => c.body.startsWith(marker(n, "rebase").replace(/ -->$/, ""))).length;
  const merge = (n) => {
    w.state.issues = w.state.issues.filter((i) => i.number !== n);
    delete w.state.prs[n];
    // Each merge on the hot files makes every PR still open conflict again.
    for (const x of Object.values(w.state.prs)) x.pr.mergeable_state = "dirty";
  };
  const running = (n) => (w.state.issues = w.state.issues.map((i) => (i.number === n ? issue(n, ["pendulum:running"], i.comments) : i)));
  for (const n of [10, 8, 9]) {
    // #7 (then each earlier one) merged: the first in order goes back for its rebase; the others wait.
    const r = await tick(w);
    assert.deepEqual(r.sentBack, [n], `tick after a merge: ${JSON.stringify({ sentBack: r.sentBack, held: r.reviewHeld })}`);
    assert.deepEqual(r.reviewHeld.sort(), w.state.issues.filter((i) => i.number !== n).map((i) => i.number).sort());
    // While it rebases (Running, its record released) the others still wait: none is sent back beside it.
    running(n);
    const during = await tick(w);
    assert.deepEqual(during.sentBack, []);
    assert.deepEqual(during.reviewHeld.sort(), w.state.issues.filter((i) => i.number !== n).map((i) => i.number).sort());
    // Its rebase goes to review; in review it is still ahead.
    await rebased(w, n);
    const review = await tick(w);
    assert.deepEqual(review.sentBack, []);
    merge(n);
  }
  assert.deepEqual([8, 9, 10].map(notices), [1, 1, 1], "each rebased exactly once");
});

test("#340: a PR sent back for an unrelated merge after it went to review is still ahead while it rebases, and that rebase goes to review: the PR waiting on it rebases once", async () => {
  forgetFiles();
  const since = Date.now() - 3600_000;
  const head = "c".repeat(40);
  // #8 handed off with no wait (its validated marker), then another merge made it conflict: it was sent back (the
  // send-back's notice on its head) and is Running that rebase. #9 waits for #8.
  const own = (n, body) => ({ id: 800 + body.length, user: { login: SELF, type: "Bot" }, body, created_at: new Date(since).toISOString() });
  const w = world([issue(8, ["pendulum:running"], 1), issue(9, ["pendulum:in-review"], 2)], {
    comments: { 8: [PLAN(8, SHARED3)], 9: [PLAN(9, [...SHARED3, "src/nine.ts"])], 13: [own(8, `${marker(8, "validated", "b".repeat(40))}\nPendulum: validated.`), own(8, `${marker(8, "rebase", head)}\nPendulum: the branch conflicts with main.`)], 14: [holdRecord(9, 8, since)] },
    prs: { 8: PR8({ mergeable_state: "dirty" }), 9: { pr: { number: 14, state: "open", draft: false, mergeable: true, mergeable_state: "dirty", head: { sha: G.head("nine", { ...edits(SHARED3, 2), "src/nine.ts": [0] }), ref: "pendulum/9", repo: { full_name: REPO } }, base: { ref: "main" }, labels: [] }, files: [...SHARED3, "src/nine.ts"] } },
  });
  const r = await tick(w);
  assert.deepEqual([r.reviewHeld, r.reviewResumed, r.sentBack], [[9], [], []], "#9 waits while #8 rebases");
  // #8's rebase hands off: it was ahead, so it goes to review although #9 began waiting first.
  forgetFiles();
  assert.equal(await withWorld(w, () => reviewHold(repoOf(REPO), { issue: 8, pr: w.state.prs[8].pr, autoMerge: true, rebaseMode: true }, { token: "t" })), null);
  assert.equal(reviewWaitOf(w.state.comments[13], 8), null, "no record written");
  // A PR that never went to review (it conflicted at its delivery) has no such standing: its rebase waits behind #9.
  w.state.comments[13] = [own(8, `${marker(8, "rebase", head)}\nPendulum: the branch conflicts with main.`)];
  forgetFiles();
  assert.equal((await withWorld(w, () => reviewHold(repoOf(REPO), { issue: 8, pr: w.state.prs[8].pr, autoMerge: true, rebaseMode: true }, { token: "t" })))?.on, 9);
});

test("#365: the hold is a trial merge of the two heads: many shared files that merge cleanly hold nothing, one shared file that conflicts holds", async () => {
  forgetFiles();
  const ten = [...SHARED3, "README.md", ...FILES.filter((f) => /^src\/m\d\.ts$/.test(f))];
  // #7 writes line 2 of ten files, #8 line 20 of the same ten: every file shared, no conflict.
  const prs = { ...PR7(), 8: PR8() };
  prs[7].pr.head.sha = G.head("seven-wide", edits(ten, 2));
  prs[7].files = ten;
  prs[8].pr.head.sha = G.head("eight-wide", edits(ten, 20));
  prs[8].files = ten;
  const w = world([issue(7, ["pendulum:in-review"], 3), issue(8, ["pendulum:running"], 1)], { comments: { 7: [PLAN(7, ten)], 8: [PLAN(8, ten)] }, prs });
  assert.equal(await withWorld(w, () => reviewHold(repoOf(REPO), { issue: 8, pr: w.state.prs[8].pr, autoMerge: true }, { token: "t" })), null, "ten shared files that merge cleanly: no hold");
  assert.deepEqual(w.state.writes, []);

  // #8 shares one of #7's ten files and writes the same line of it: they conflict there, so #8 waits.
  forgetFiles();
  const mine = ["README.md", "src/one.ts", "src/two.ts", "src/three.ts", "src/four.ts"];
  const one = { ...PR7(), 8: PR8() };
  one[7].pr.head.sha = prs[7].pr.head.sha;
  one[7].files = ten;
  one[8].pr.head.sha = G.head("eight-one", { ...edits(mine.slice(1), 0), "README.md": [2] });
  one[8].files = mine;
  const v = world([issue(7, ["pendulum:in-review"], 3), issue(8, ["pendulum:running"], 1)], { comments: { 7: [PLAN(7, ten)], 8: [PLAN(8, mine)] }, prs: one });
  const held = await withWorld(v, () => reviewHold(repoOf(REPO), { issue: 8, pr: v.state.prs[8].pr, autoMerge: true }, { token: "t" }));
  assert.deepEqual(held, { on: 7, files: ["README.md"], cause: null, unread: [] });
  assert.ok(reviewWaitOf(v.state.comments[13], 8), "its record is on the PR");

  // The dispatcher's half decides the same way: a waiting hand-off whose sibling ahead merges cleanly with it goes to
  // review at the next tick; one that conflicts with it keeps waiting.
  forgetFiles();
  const since = Date.now() - 3600_000;
  const u = world([issue(7, ["pendulum:in-review"], 3), issue(8, ["pendulum:in-review"], 2)], { comments: { 7: [PLAN(7, ten)], 8: [PLAN(8, ten)], 13: [holdRecord(8, 7, since)] }, prs });
  const r = await tick(u);
  assert.deepEqual([r.reviewHeld, r.reviewResumed], [[], [8]]);
  forgetFiles();
  const k = world([issue(7, ["pendulum:in-review"], 3), issue(8, ["pendulum:in-review"], 2)], { comments: { 7: [PLAN(7, ten)], 8: [PLAN(8, mine)], 13: [holdRecord(8, 7, since)] }, prs: one });
  const t = await tick(k);
  assert.deepEqual([t.reviewHeld, t.reviewResumed], [[8], []]);
  assert.match(overlap(k, 8)[0].body, /waits for #7 to merge: a trial merge of the two heads conflicts in 1 file\(s\) \(`README\.md`\)/);
});

test("#365: trial merges are cached by the pair of heads, and a tick computes at most its bound of new ones", async () => {
  const { siblingTrials } = await import("../scripts/lib/overlap.mjs");
  forgetFiles();
  const a = G.head("pair-a", edits(["src/m0.ts"], 5));
  const b = G.head("pair-b", edits(["src/m0.ts"], 5));
  const c = G.head("pair-c", edits(["src/m1.ts"], 5));
  const one = siblingTrials(repoOf(REPO), { token: "t" }, { max: 1 });
  try {
    assert.deepEqual(await one.conflicts(a, b), { conflict: true, files: ["src/m0.ts"] });
    assert.deepEqual(await one.conflicts(b, a), { conflict: true, files: ["src/m0.ts"] }, "the same pair either way round: from the cache");
    await assert.rejects(one.conflicts(a, c), /past the 1 trial merges one PR's judgement computes/);
  } finally {
    one.close();
  }
  // Another tick in this process reads the pair from the cache; a commit the server lacks is unread.
  const next = siblingTrials(repoOf(REPO), { token: "t" }, { max: 1 });
  try {
    assert.deepEqual(await next.conflicts(a, b), { conflict: true, files: ["src/m0.ts"] });
    assert.deepEqual(await next.conflicts(a, c), { conflict: false, files: [] });
    await assert.rejects(siblingTrials(repoOf(REPO), { token: "t" }).conflicts(a, "e".repeat(40)), /could not be fetched/);
  } finally {
    next.close();
  }
});

/** Objective n In review with PR 10 + n, reviewed and handed off (its validated marker), conflicting with main. */
const dirtyPr = (n, head) => ({ pr: { number: 10 + n, state: "open", draft: false, mergeable: false, mergeable_state: "dirty", head: { sha: head, ref: `pendulum/${n}`, repo: { full_name: REPO } }, base: { ref: "main" }, labels: [] }, files: ["src/registry.ts"] });
const validated = (n, head) => ({ id: 700 + n, user: { login: SELF, type: "Bot" }, body: `${marker(n, "validated", head)}\nPendulum: validated.`, created_at: new Date(Date.now() - 3600_000).toISOString() });

for (const siblingHold of [true, false]) {
  test(`#366: six conflicting In-review PRs on one registry go back one per merge, in the release order, each rebased once (sibling_hold ${siblingHold ? "on" : "off"})`, async (t) => {
    forgetFiles();
    const ns = [21, 22, 23, 24, 25, 26];
    // Each writes its own entry over the same registry line: every two of them conflict, and #20's entry, merged on
    // main, conflicts with each.
    const entry = (n) => ({ "src/registry.ts": [29], [`src/entry${n}.ts`]: [0] });
    const heads = Object.fromEntries(ns.map((n) => [n, G.head(`entry ${n}`, entry(n))]));
    G.advance("entry 20", entry(20));
    const w = world(
      ns.map((n) => issue(n, ["pendulum:in-review"], 1)),
      { comments: Object.fromEntries(ns.map((n) => [10 + n, [validated(n, heads[n])]])), prs: Object.fromEntries(ns.map((n) => [n, dirtyPr(n, heads[n])])) },
    );
    const notices = (n) => (w.state.comments[10 + n] || []).filter((c) => c.body.startsWith(marker(n, "rebase").replace(/ -->$/, ""))).length;
    const running = (n) => (w.state.issues = w.state.issues.map((i) => (i.number === n ? issue(n, ["pendulum:running"], i.comments) : i)));
    const merge = (n) => {
      G.land(w.state.prs[n].pr.head.sha);
      w.state.issues = w.state.issues.filter((i) => i.number !== n);
      delete w.state.prs[n];
      for (const x of Object.values(w.state.prs)) x.pr.mergeable_state = "dirty";
    };
    const inputs = { siblingHold, maxConcurrent: 6 };
    t.after(() => G.reset());
    for (const n of ns) {
      const rest = w.state.issues.map((i) => i.number).filter((x) => x !== n);
      // A merge made every open PR conflict: only the first in the release order goes back; a rebase of the others now
      // would conflict again once it merges.
      const r = await tick(w, inputs);
      assert.deepEqual([r.sentBack, r.rebaseHeld], [[n], rest], `after a merge, #${n} first`);
      // While it rebases, and once it is back in review, it is still ahead: the others wait.
      running(n);
      const during = await tick(w, inputs);
      assert.deepEqual([during.sentBack, during.rebaseHeld], [[], rest]);
      await rebased(w, n, { onto: entry(n) });
      const review = await tick(w, inputs);
      assert.deepEqual([review.sentBack, review.rebaseHeld], [[], rest]);
      merge(n);
    }
    assert.deepEqual(ns.map(notices), [1, 1, 1, 1, 1, 1], "each rebased exactly once");
  });
}

test("#366: a conflicting PR that merges cleanly with every sibling ahead of it goes back the same tick; one that conflicts with an In-review sibling ahead waits for it", async () => {
  forgetFiles();
  const reg = (n) => G.head(`reg ${n}`, { "src/registry.ts": [29] });
  // #21 and #22 write the registry line; #23 conflicts with main elsewhere and with neither of them; #24 conflicts with
  // #20, which is In review ahead of it (clean, under review), and with nothing else.
  const h20 = G.head("twenty", edits(["src/m5.ts"], 7));
  const heads = { 21: reg(21), 22: reg(22), 23: G.head("twenty-three", edits(["src/m3.ts"], 4)), 24: G.head("twenty-four", edits(["src/m5.ts"], 7)) };
  const prs = Object.fromEntries(Object.entries(heads).map(([n, h]) => [n, dirtyPr(Number(n), h)]));
  prs[20] = { pr: { ...dirtyPr(20, h20).pr, mergeable: true, mergeable_state: "clean", labels: [{ name: "pendulum:review" }] }, files: ["src/m5.ts"] };
  const w = world(
    [20, 21, 22, 23, 24].map((n) => issue(n, ["pendulum:in-review"], 1)),
    { comments: Object.fromEntries([20, 21, 22, 23, 24].map((n) => [10 + n, [validated(n, n === 20 ? h20 : heads[n])]])), prs },
  );
  const r = await tick(w, { maxConcurrent: 6 });
  assert.deepEqual([r.sentBack, r.rebaseHeld], [[21, 23], [22, 24]]);
  assert.equal(w.state.comments[32].filter((c) => c.body.startsWith(marker(22, "rebase").replace(/ -->$/, ""))).length, 0, "no notice on a PR that waits");
  // Without auto_merge a person merges, in an order of their own: each conflicting PR goes back at once, as before.
  forgetFiles();
  const m = world(
    [20, 21, 22, 23, 24].map((n) => issue(n, ["pendulum:in-review"], 1)),
    { comments: Object.fromEntries([20, 21, 22, 23, 24].map((n) => [10 + n, [validated(n, n === 20 ? h20 : heads[n])]])), prs: Object.fromEntries(Object.entries(prs).map(([n, x]) => [n, { ...x, pr: { ...x.pr } }])) },
  );
  const o = await tick(m, { maxConcurrent: 6, autoMerge: false });
  assert.deepEqual([o.sentBack, o.rebaseHeld], [[21, 22, 23, 24], []]);
});

/** Objective n In review with PR 10 + n, clean, under review (its label on), at `head`. */
const reviewingPr = (n, head) => ({ pr: { ...dirtyPr(n, head).pr, mergeable: true, mergeable_state: "clean", labels: [{ name: "pendulum:review" }] }, files: [] });
/** The comments of PR `prNumber` that start with Objective n's record marker of `kind`. */
const records = (w, n, prNumber, kind) => (w.state.comments[prNumber] || []).filter((c) => c.body.startsWith(marker(n, kind).replace(/ -->$/, ":")));
/** A record of `kind` on n's PR waiting for `on` since `sinceMs` (overlap.mjs writeRecord's form). */
const waitRecord = (n, kind, on, sinceMs, id = 960 + n) => ({ id, user: { login: SELF, type: "Bot" }, body: `${marker(n, kind).replace(/ -->$/, "")}:${on}-${Math.floor(sinceMs / 1000)} -->\nPendulum: waits.`, created_at: new Date(sinceMs).toISOString(), updated_at: new Date(sinceMs).toISOString() });

test("#365: heads on different bases are judged against main: a stale head does not conflict with a sibling over a change of main's that the sibling never touched", async (t) => {
  const { siblingTrials } = await import("../scripts/lib/overlap.mjs");
  forgetFiles();
  t.after(() => G.reset());
  // #31 branched before main changed line 5 of src/m4.ts and changed that line too: it conflicts with main. #30 branched
  // from main since and changes src/m1.ts only; #32, from main too, changes line 1 of src/m0.ts, as #31 does.
  const w31 = G.head("w", { "src/m4.ts": [5], "src/m0.ts": [1] });
  G.advance("main", { "src/m4.ts": [5] });
  const x30 = G.onMain("x", { "src/m1.ts": [3] });
  const y32 = G.onMain("y", { "src/m0.ts": [1] });
  const trials = siblingTrials(repoOf(REPO), { token: "t" });
  try {
    assert.deepEqual(await trials.conflicts(w31, x30), { conflict: false, files: [] }, "main's change is #31's own conflict, not one with #30");
    assert.deepEqual(await trials.conflicts(w31, y32), { conflict: true, files: ["src/m0.ts"] }, "both change line 1 of src/m0.ts");
    assert.deepEqual(await trials.conflicts(x30, y32), { conflict: false, files: [] });
  } finally {
    trials.close();
  }

  // #30's hand-off is not held behind the stale #31 (In review, conflicting with main) ...
  forgetFiles();
  const comments = { 41: [validated(31, w31)] };
  const hand = world([issue(30, ["pendulum:running"], 1), issue(31, ["pendulum:in-review"], 1)], { comments, prs: { 30: { pr: { ...reviewingPr(30, x30).pr, labels: [] }, files: ["src/m1.ts"] }, 31: dirtyPr(31, w31) } });
  assert.equal(await withWorld(hand, () => reviewHold(repoOf(REPO), { issue: 30, pr: hand.state.prs[30].pr, autoMerge: true }, { token: "t" })), null);
  // ... and #31 goes back for its rebase rather than wait for #30, In review ahead of it.
  forgetFiles();
  const back = world([issue(30, ["pendulum:in-review"], 1), issue(31, ["pendulum:in-review"], 1)], { comments, prs: { 30: reviewingPr(30, x30), 31: dirtyPr(31, w31) } });
  const r = await tick(back, { maxConcurrent: 6 });
  assert.deepEqual([r.sentBack, r.rebaseHeld], [[31], []]);
});

test("#366: a send-back that waits says so on its PR and issue and arms a wake; it waits 6 h at most, counted with its hand-off's wait, and not for a sibling whose own review waits", async () => {
  forgetFiles();
  const h21 = G.head("reg 21", { "src/registry.ts": [29] });
  const h22 = G.head("reg 22", { "src/registry.ts": [29] });
  const setup = (comments = {}) => world([issue(21, ["pendulum:in-review"], 1), issue(22, ["pendulum:in-review"], 1)], { comments: { 31: [validated(21, h21)], 32: [validated(22, h22)], ...comments }, prs: { 21: reviewingPr(21, h21), 22: dirtyPr(22, h22) } });
  const w = setup();
  const before = Date.now();
  const r = await tick(w, { maxConcurrent: 6 });
  assert.deepEqual([r.sentBack, r.rebaseHeld], [[], [22]]);
  const [rec] = records(w, 22, 32, "sendback-wait");
  const since = Number(/sendback-wait:21-(\d+) -->/.exec(rec?.body ?? "")?.[1]) * 1000;
  assert.ok(since >= Math.floor(before / 1000) * 1000, rec?.body);
  assert.match(rec.body, /its rebase waits for #21 to merge first: a trial merge of the two heads conflicts in 1 file\(s\) \(`src\/registry\.ts`\)/);
  assert.ok(overlap(w, 22)[0].body.startsWith(marker(22, "overlap", `rebasewait-21-${since / 1000}`)), overlap(w, 22)[0]?.body);
  assert.match(overlap(w, 22)[0].body, /PR #32 conflicts with the default branch, and its rebase waits for #21 to merge first.*after 6 h of waiting at most/);
  assert.deepEqual(r.deadlines.filter((d) => d.kind === "sibling-wait"), [{ issue: 22, kind: "sibling-wait", at: new Date(since + 6 * 3600_000 + 60_000).toISOString() }]);
  assert.equal(records(w, 22, 32, "rebase").length, 0, "no send-back notice");
  // The next tick still waits, with nothing written again.
  const writes = w.state.writes.length;
  assert.deepEqual((await tick(w, { maxConcurrent: 6 })).rebaseHeld, [22]);
  assert.equal(w.state.writes.length, writes);

  // Waiting since 7 h ago: it goes back now; its record is released and the note says why.
  forgetFiles();
  const late = setup({ 32: [validated(22, h22), waitRecord(22, "sendback-wait", 21, Date.now() - 7 * 3600_000)], 22: [] });
  const l = await tick(late, { maxConcurrent: 6 });
  assert.deepEqual([l.sentBack, l.rebaseHeld], [[22], []]);
  assert.match(records(late, 22, 32, "sendback-wait")[0].body, /-released -->/);

  // A hand-off released at its 6 h bound that conflicts goes back at once: the bound covers both waits.
  forgetFiles();
  const held = setup({ 32: [validated(22, h22), holdRecord(22, 21, Date.now() - 7 * 3600_000)] });
  const h = await tick(held, { maxConcurrent: 6 });
  assert.deepEqual([h.sentBack, h.rebaseHeld], [[22], []]);

  // #21's own review waits for a third-party reviewer: it will not merge soon, so #22 does not wait for it.
  forgetFiles();
  const thirdParty = { id: 941, user: { login: SELF, type: "Bot" }, body: `${marker(21, "third-party").replace(/ -->$/, "")} {"sha":"${h21}","logins":["greptile-apps[bot]"],"at":"${new Date().toISOString()}"} -->\nPendulum: waiting.`, created_at: new Date().toISOString() };
  const tp = setup({ 31: [validated(21, h21), thirdParty] });
  const p = await tick(tp, { maxConcurrent: 6 });
  assert.deepEqual([p.sentBack, p.rebaseHeld], [[22], []]);
  // One left behind on an older head is no wait: #21 still merges first, and #22's rebase waits for it (#423).
  forgetFiles();
  const stale = setup({ 31: [validated(21, h21), { ...thirdParty, body: thirdParty.body.replace(h21, "a".repeat(40)) }] });
  const st = await tick(stale, { maxConcurrent: 6 });
  assert.deepEqual([st.sentBack, st.rebaseHeld], [[], [22]]);
});

test("#366: trial merges that cannot be computed fall back to the release order (the first conflicting PR goes back, the later ones wait) and keep a waiting hand-off waiting without an error", async () => {
  forgetFiles();
  const heads = { 21: G.head("a21", edits(["src/m1.ts"], 3)), 22: G.head("a22", edits(["src/m2.ts"], 3)), 23: G.head("a23", edits(["src/m3.ts"], 3)), 24: G.head("a24", edits(["src/m4.ts"], 3)) };
  const w = world([21, 22, 23, 24].map((n) => issue(n, ["pendulum:in-review"], 1)), {
    comments: { ...Object.fromEntries([21, 22, 23].map((n) => [10 + n, [validated(n, heads[n])]])), 34: [holdRecord(24, 21, Date.now() - 3600_000)] },
    prs: { ...Object.fromEntries([21, 22, 23].map((n) => [n, dirtyPr(n, heads[n])])), 24: { pr: { ...dirtyPr(24, heads[24]).pr, mergeable_state: "clean" }, files: [] } },
  });
  // The git server cannot be reached this tick.
  const saved = process.env.GITHUB_SERVER_URL;
  process.env.GITHUB_SERVER_URL = join(saved, "nowhere");
  try {
    const r = await tick(w, { maxConcurrent: 6 });
    assert.deepEqual([r.sentBack, r.rebaseHeld], [[21], [22, 23]]);
    assert.match(records(w, 23, 33, "sendback-wait")[0].body, /its rebase waits for #22 to merge first \(the trial merges could not be computed this tick, so the release order decides\)\./);
    assert.deepEqual([r.reviewResumed, r.reviewHeld], [[], []]);
    assert.equal(reviewWaitOf(w.state.comments[34], 24)?.released, false, "the hand-off still waits");
    assert.ok(r.deadlines.some((d) => d.kind === "retry"));
  } finally {
    process.env.GITHUB_SERVER_URL = saved;
  }
});

test("#366: a sibling head the server does not have counts as conflicting for one tick, named in the record, then is left out", async () => {
  forgetFiles();
  const gone = "e".repeat(40);
  const h22 = G.head("reg 22b", { "src/registry.ts": [29] });
  const w = world([issue(21, ["pendulum:in-review"], 1), issue(22, ["pendulum:in-review"], 1)], { comments: { 31: [validated(21, gone)], 32: [validated(22, h22)] }, prs: { 21: reviewingPr(21, gone), 22: dirtyPr(22, h22) } });
  const r = await tick(w, { maxConcurrent: 6 });
  assert.deepEqual([r.sentBack, r.rebaseHeld], [[], [22]]);
  assert.match(records(w, 22, 32, "sendback-wait")[0].body, new RegExp(`^<!-- pendulum:22:sendback-wait:21-\\d+-u${gone} -->\\nPendulum: its rebase waits for #21 to merge first \\(its head could not be fetched for a trial merge\\)\\.`));
  forgetFiles();
  const again = await tick(w, { maxConcurrent: 6 });
  assert.deepEqual([again.sentBack, again.rebaseHeld], [[22], []]);

  // The same for a hand-off: held once, named in its record; the dispatcher's next tick goes on without it.
  forgetFiles();
  const prs = { ...PR7(), 8: PR8() };
  prs[7].pr.head.sha = gone;
  const v = world([issue(7, ["pendulum:in-review"], 3), issue(8, ["pendulum:running"], 1)], { comments: { 7: [PLAN(7, SHARED3)], 8: [PLAN(8, SHARED3)] }, prs });
  const wait = await withWorld(v, () => reviewHold(repoOf(REPO), { issue: 8, pr: v.state.prs[8].pr, autoMerge: true }, { token: "t" }));
  assert.deepEqual(wait, { on: 7, files: [], cause: "its head could not be fetched for a trial merge", unread: [gone] });
  assert.deepEqual(reviewWaitOf(v.state.comments[13], 8)?.unread, [gone]);
  v.state.issues = [issue(7, ["pendulum:in-review"], 3), issue(8, ["pendulum:in-review"], 2)];
  forgetFiles();
  const t = await tick(v);
  assert.deepEqual([t.reviewHeld, t.reviewResumed], [[], [8]]);
});

test("#365: renames and line regions count: a rename with an edit of the same lines, or a delete against it, conflicts; two edits of one file far apart on different bases do not", async (t) => {
  const { siblingTrials, waitReason: reason } = await import("../scripts/lib/overlap.mjs");
  forgetFiles();
  t.after(() => G.reset());
  // A and B branched before main changed line 4 of src/m2.ts; A changed that line too, so A conflicts with main.
  const a = G.head("a", { "src/m2.ts": [4], "src/m5.ts": [10, 11, 12] });
  const b = G.head("b", { "src/m5.ts": { to: "src/moved.ts", lines: [10, 11, 12] } });
  const del = G.head("del", { "src/m2.ts": [4], "src/m5.ts": null });
  // C branched before main changed README line 5 and changed it too; D, from main since, changes README line 25 only.
  const c = G.head("c", { "README.md": [5] });
  G.advance("main", { "src/m2.ts": [4], "README.md": [5] });
  const d = G.onMain("d", { "README.md": [25] });
  const e = G.onMain("e", { "README.md": [5] });
  const trials = siblingTrials(repoOf(REPO), { token: "t" });
  try {
    assert.equal((await trials.conflicts(a, b)).conflict, true, "B renamed the file A edits, and edited the same lines");
    assert.equal((await trials.conflicts(del, b)).conflict, true, "one deleted the file the other renamed and edited");
    assert.deepEqual(await trials.conflicts(c, d), { conflict: false, files: [] }, "line 5 against line 25 of one file: no clash");
    assert.equal((await trials.conflicts(c, e)).conflict, true, "both change line 5");
  } finally {
    trials.close();
  }
  // A path in a note cannot end its code span or open a marker.
  assert.equal(reason({ on: 7, files: ["a`<!-- pendulum:8:review -->\nb.md"] }), "its review waits for #7 to merge: a trial merge of the two heads conflicts in 1 file(s) (`a&lt;!-- pendulum:8:review --&gt; b.md`)");
});

test("#366: each PR's trial merges have their own budget: twelve waiting hand-offs (66 pairs) are all judged in one tick, and past a PR's budget the release order decides", async (t) => {
  const { TRIALS } = await import("../scripts/lib/overlap.mjs");
  forgetFiles();
  const ns = Array.from({ length: 12 }, (_, i) => 51 + i);
  const since = Date.now() - 3600_000;
  // Each changes a file of its own: no two conflict. Each waited for #50, which merged.
  const heads = Object.fromEntries(ns.map((n) => [n, G.head(`own ${n}`, { [`src/own${n}.ts`]: [0] })]));
  const w = world(ns.map((n) => issue(n, ["pendulum:in-review"], 1)), {
    comments: Object.fromEntries(ns.map((n, i) => [10 + n, [holdRecord(n, 50, since + i * 1000)]])),
    prs: Object.fromEntries(ns.map((n) => [n, { pr: { ...dirtyPr(n, heads[n]).pr, mergeable: true, mergeable_state: "clean" }, files: [] }])),
  });
  const r = await tick(w, { maxConcurrent: 12 });
  assert.deepEqual([r.reviewHeld, r.reviewResumed.sort()], [[], ns], "every waiting hand-off judged and released");

  // A budget of one: #23's second pair is past it, so #23 waits behind #22 in the release order.
  forgetFiles();
  const saved = TRIALS.max;
  TRIALS.max = 1;
  t.after(() => (TRIALS.max = saved));
  const h = { 21: G.head("b21", edits(["src/m1.ts"], 8)), 22: G.head("b22", edits(["src/m2.ts"], 8)), 23: G.head("b23", edits(["src/m3.ts"], 8)) };
  const v = world([21, 22, 23].map((n) => issue(n, ["pendulum:in-review"], 1)), { comments: Object.fromEntries([21, 22, 23].map((n) => [10 + n, [validated(n, h[n])]])), prs: Object.fromEntries([21, 22, 23].map((n) => [n, dirtyPr(n, h[n])])) });
  const o = await tick(v, { maxConcurrent: 6 });
  assert.deepEqual([o.sentBack, o.rebaseHeld], [[21, 22], [23]]);
  assert.match(records(v, 23, 33, "sendback-wait")[0].body, /waits for #22 to merge first \(the trial merges could not be computed this tick, so the release order decides\)/);
});

test("#366: a send-back does not wait for a sibling that cannot merge soon: a usage-limit hold of the local loop, or its pinned account held on the Actions route", async () => {
  const { holdLine } = await import("../scripts/lib/route-holds.mjs");
  forgetFiles();
  const h21 = G.head("held 21", { "src/registry.ts": [29] });
  const h22 = G.head("held 22", { "src/registry.ts": [29] });
  const setup = (labels21 = [], extra = []) => world([issue(21, ["pendulum:in-review", ...labels21], 1), issue(22, ["pendulum:in-review"], 1), ...extra.map((x) => x.issue)], { comments: { 31: [validated(21, h21)], 32: [validated(22, h22)], ...Object.fromEntries(extra.map((x) => [x.issue.number, x.comments])) }, prs: { 21: reviewingPr(21, h21), 22: dirtyPr(22, h22) } });
  // Waits for #21 when nothing holds it ...
  assert.deepEqual((await tick(setup(), { maxConcurrent: 6 })).rebaseHeld, [22]);
  // ... goes back when the loop holds #21 for its account's usage limit ...
  forgetFiles();
  const r = await tick(setup(), { maxConcurrent: 6 }, { localHold: (i) => (i.number === 21 ? "its account's usage limit is spent" : null) });
  assert.deepEqual([r.sentBack, r.rebaseHeld], [[22], []]);
  // ... and when #21 is pinned to an account the Actions route holds for its usage limit.
  forgetFiles();
  const now = Date.now();
  const holds = { issue: { number: 900, state: "open", locked: true, title: "Pendulum: account holds", labels: [{ name: "pendulum:holds" }], user: { login: SELF, type: "Bot" }, comments: 1, body: "" }, comments: [{ id: 901, user: { login: SELF, type: "Bot" }, body: `${holdLine({ harness: "claude", streak: 0, account: "claude-2", until: now + 2 * 3600_000, at: now - 60_000 })}\nPendulum: held`, created_at: new Date(now - 60_000).toISOString(), updated_at: new Date(now - 60_000).toISOString() }] };
  const saved = process.env.PENDULUM_ACCOUNTS;
  process.env.PENDULUM_ACCOUNTS = JSON.stringify({ claude: ["claude", "claude-2"] });
  try {
    const p = await tick(setup(["pendulum:account:claude-2"], [holds]), { maxConcurrent: 6 });
    assert.deepEqual([p.sentBack, p.rebaseHeld], [[22], []]);
    forgetFiles();
    const q = await tick(setup(["pendulum:account:claude"], [holds]), { maxConcurrent: 6 });
    assert.deepEqual(q.rebaseHeld, [22], "its account is free: it merges first, so #22 waits");
  } finally {
    if (saved === undefined) delete process.env.PENDULUM_ACCOUNTS;
    else process.env.PENDULUM_ACCOUNTS = saved;
  }
});

test("#366: every sibling head the server lacks is named in the record, so two of them are left out together the next tick; a wait that ends outside the send-back is cleared", async () => {
  forgetFiles();
  const [e, d] = ["e".repeat(40), "d".repeat(40)];
  const h22 = G.head("two 22", { "src/registry.ts": [29] });
  const w = world([issue(20, ["pendulum:in-review"], 1), issue(21, ["pendulum:in-review"], 1), issue(22, ["pendulum:in-review"], 1)], { comments: { 30: [validated(20, e)], 31: [validated(21, d)], 32: [validated(22, h22)] }, prs: { 20: reviewingPr(20, e), 21: reviewingPr(21, d), 22: dirtyPr(22, h22) } });
  const r = await tick(w, { maxConcurrent: 6 });
  assert.deepEqual(r.rebaseHeld, [22]);
  assert.match(records(w, 22, 32, "sendback-wait")[0].body, new RegExp(`^<!-- pendulum:22:sendback-wait:20-\\d+-u${e}\\.${d} -->\\nPendulum: its rebase waits for #20 to merge first \\(2 sibling heads could not be fetched for a trial merge\\)\\.`));
  forgetFiles();
  assert.deepEqual((await tick(w, { maxConcurrent: 6 })).sentBack, [22]);

  // #22 waited; then a person resolved its conflict: the record is released and the issue's note cleared.
  forgetFiles();
  const h21 = G.head("over 21", { "src/registry.ts": [29] });
  const v = world([issue(21, ["pendulum:in-review"], 1), issue(22, ["pendulum:in-review"], 1)], { comments: { 31: [validated(21, h21)], 32: [validated(22, h22)] }, prs: { 21: reviewingPr(21, h21), 22: dirtyPr(22, h22) } });
  assert.deepEqual((await tick(v, { maxConcurrent: 6 })).rebaseHeld, [22]);
  v.state.prs[22].pr.mergeable_state = "clean";
  forgetFiles();
  const after = await tick(v, { maxConcurrent: 6 });
  assert.deepEqual([after.sentBack, after.rebaseHeld], [[], []]);
  assert.match(records(v, 22, 32, "sendback-wait")[0].body, /-over -->\nPendulum: this Objective's PR no longer waits for #21 to rebase: it conflicts no more, or left review\./);
  assert.ok(overlap(v, 22)[0].body.startsWith(marker(22, "overlap", "cleared")), overlap(v, 22)[0].body);
});

test("#365: a stale head's own lines win when made again on a sibling's base: changes main made between the two bases are no clash of theirs", async (t) => {
  const { siblingTrials } = await import("../scripts/lib/overlap.mjs");
  forgetFiles();
  t.after(() => G.reset());
  // Main changes line 0 of src/m0.ts; A, from before, changes it too (so A conflicts with main) and line 5 of src/m1.ts.
  // Then main changes line 10 of src/m2.ts, and B, from main now, changes that line again.
  const a = G.head("a", { "src/m0.ts": [0], "src/m1.ts": [5] });
  const a2 = G.head("a2", { "src/m0.ts": [0], "src/m1.ts": [5], "src/m2.ts": [10] });
  G.advance("main 1", { "src/m0.ts": [0] });
  G.advance("main 2", { "src/m2.ts": [10] });
  const b = G.onMain("b", { "src/m2.ts": [10] });
  const trials = siblingTrials(repoOf(REPO), { token: "t" });
  try {
    assert.deepEqual(await trials.conflicts(a, b), { conflict: false, files: [] }, "A and B never change the same lines");
    assert.deepEqual(await trials.conflicts(b, a), { conflict: false, files: [] });
    assert.deepEqual(await trials.conflicts(a2, b), { conflict: true, files: ["src/m2.ts"] }, "both change line 10 of src/m2.ts");
  } finally {
    trials.close();
  }
});

test("#366: a sibling's usage-limit hold slows it only while it needs a stage; a send-back wait that ended with nothing to rebase ends its bound", async () => {
  const { waitStart } = await import("../scripts/lib/overlap.mjs");
  forgetFiles();
  const h21 = G.head("stage 21", { "src/registry.ts": [29] });
  const h22 = G.head("stage 22", { "src/registry.ts": [29] });
  // #21 is reviewed and waits for its merge (no review label, no merge record yet): no stage runs on it, so a hold of
  // its account does not slow it, and #22 waits for it.
  const w = world([issue(21, ["pendulum:in-review"], 1), issue(22, ["pendulum:in-review"], 1)], { comments: { 31: [validated(21, h21)], 32: [validated(22, h22)] }, prs: { 21: { pr: { ...reviewingPr(21, h21).pr, labels: [] }, files: [] }, 22: dirtyPr(22, h22) } });
  const r = await tick(w, { maxConcurrent: 6 }, { localHold: (i) => (i.number === 21 ? "its account's usage limit is spent" : null) });
  assert.deepEqual([r.sentBack, r.rebaseHeld], [[], [22]]);

  // A wait that ended `over` (the conflict went away) ends the bound: a new conflict an hour later starts its own, even
  // with a hand-off wait that ended before it.
  const now = Date.now();
  const H = 3600_000;
  assert.equal(waitStart({ reviewWait: { since: now - 5 * H, released: true, at: now - 3 * H }, rebaseWait: { since: now - 3 * H, released: true, over: true, at: now - H } }, now), Math.floor(now / 1000) * 1000);
  assert.equal(waitStart({ reviewWait: { since: now - 5 * H, released: true, at: now - 3 * H }, rebaseWait: { since: now - 3 * H, released: true, over: false, at: now - H } }, now), now - 5 * H, "sent back, not over: one bound");
});

test("#340: a sibling that can run no stage (two account labels) is not ahead; a hold more than 6 h after the Objective's last starts a new wait", async () => {
  forgetFiles();
  const since = Date.now() - 3600_000;
  const saved = process.env.PENDULUM_ACCOUNTS;
  process.env.PENDULUM_ACCOUNTS = JSON.stringify({ claude: ["claude", "claude-2"] });
  try {
    const w = world([issue(7, ["pendulum:in-review", "pendulum:account:claude", "pendulum:account:claude-2"], 3), issue(8, ["pendulum:in-review"], 2)], { comments: { 7: [PLAN(7, SHARED3)], 8: [PLAN(8, SHARED3)], 12: [holdRecord(7, 6, since - 60_000, 957, true)], 13: [holdRecord(8, 7, since)] }, prs: { ...PR7(), 8: PR8() } });
    w.state.prs[7].pr.mergeable_state = "dirty";
    w.state.prs[7].pr.labels = [];
    const r = await tick(w);
    assert.deepEqual(r.reviewResumed, [8], "#7 cannot rebase while two account labels are on it: it holds no one");
  } finally {
    if (saved === undefined) delete process.env.PENDULUM_ACCOUNTS;
    else process.env.PENDULUM_ACCOUNTS = saved;
  }

  // #8's last wait began 7 h ago (released since): held again now, its new wait starts now and has its own 6 h.
  forgetFiles();
  const now = Date.now();
  const v = world([issue(7, ["pendulum:in-review"], 3), issue(8, ["pendulum:running"], 1)], { comments: { 7: [PLAN(7, SHARED3)], 8: [PLAN(8, SHARED3)], 13: [holdRecord(8, 6, now - 7 * 3600_000, 958, true)] }, prs: { ...PR7(), 8: PR8() } });
  assert.equal((await withWorld(v, () => reviewHold(repoOf(REPO), { issue: 8, pr: v.state.prs[8].pr, autoMerge: true }, { token: "t" }, { now })))?.on, 7);
  assert.equal(reviewWaitOf(v.state.comments[13], 8).since, Math.floor(now / 1000) * 1000);
});

test("#340: a dispatcher tick leaves a waiting hand-off alone while its sibling is In review (no send-back, no review), arms a wake for the bound, then rebases it once the sibling merged, before its review", async () => {
  forgetFiles();
  const since = Date.now() - 3600_000;
  // #8's PR conflicts already (#7 is not merged: another PR landed): without the wait it would go back for a rebase now.
  const w = world([issue(7, ["pendulum:in-review"], 3), issue(8, ["pendulum:in-review"], 2)], {
    comments: { 7: [PLAN(7, SHARED3)], 8: [PLAN(8, [...SHARED3, "src/new.ts"]), waitsComment(8, 7, since)], 13: [holdRecord(8, 7, since)] },
    prs: { ...PR7(), 8: PR8({ mergeable_state: "dirty" }) },
  });
  const r = await tick(w);
  assert.deepEqual(r.reviewHeld, [8]);
  assert.deepEqual(r.sentBack, [], "no rebase while #7 is in review: a second sibling merge would need another");
  assert.deepEqual(prLabels(w, 8), []);
  assert.ok(reviewWaitOf(w.state.comments[13], 8) && !reviewWaitOf(w.state.comments[13], 8).released, "the record still waits");
  assert.deepEqual(
    r.deadlines.filter((d) => d.kind === "sibling-wait"),
    [{ issue: 8, kind: "sibling-wait", at: new Date(Math.floor(since / 1000) * 1000 + 6 * 3600_000 + 60_000).toISOString() }],
  );

  // #7 merged (its issue closed, its PR gone): #8's wait is over and it conflicts, so it goes back for its one rebase
  // this tick (that rebase's hand-off then labels it); the record is released and the note says so.
  w.state.issues = [issue(8, ["pendulum:in-review"], 2)];
  delete w.state.prs[7];
  const after = await tick(w);
  assert.deepEqual(after.reviewHeld, []);
  assert.deepEqual(after.sentBack, [8]);
  assert.ok(w.state.comments[13].some((c) => c.body.startsWith(marker(8, "rebase", H8))), "the send-back's notice");
  assert.equal(reviewWaitOf(w.state.comments[13], 8)?.released, true);
  assert.ok(overlap(w, 8)[0].body.startsWith(marker(8, "overlap", "cleared")), overlap(w, 8)[0].body);
  assert.match(overlap(w, 8)[0].body, /no longer waits for #7: no sibling ahead of it conflicts with it now/);
});

test("#340: a hand-off whose wait is over gets its review label the same tick when it does not conflict; GitHub not yet sure it does waits a tick; without auto_merge it goes at once", async () => {
  forgetFiles();
  const since = Date.now() - 3600_000;
  const w = world([issue(8, ["pendulum:in-review"], 2)], { comments: { 8: [PLAN(8, SHARED3), waitsComment(8, 7, since)], 13: [holdRecord(8, 7, since)] }, prs: { 8: PR8() } });
  const r = await tick(w);
  assert.deepEqual(r.reviewResumed, [8]);
  assert.deepEqual(prLabels(w, 8), ["pendulum:review"]);
  assert.equal(reviewWaitOf(w.state.comments[13], 8)?.released, true, "released, keeping its start");

  // GitHub has not worked out the PR's mergeable state: no label and no send-back on a guess; a retry is due.
  forgetFiles();
  const u = world([issue(8, ["pendulum:in-review"], 2)], { comments: { 8: [PLAN(8, SHARED3)], 13: [holdRecord(8, 7, since)] }, prs: { 8: PR8({ mergeable_state: null }) } });
  const t = await tick(u);
  assert.deepEqual([t.reviewResumed, t.sentBack, prLabels(u, 8)], [[], [], []]);
  assert.equal(reviewWaitOf(u.state.comments[13], 8)?.released, false, "it still waits");
  assert.ok(t.deadlines.some((d) => d.kind === "retry"));

  // Without auto_merge a person merges #7, as long as they take: the wait is over at once.
  forgetFiles();
  const m = world([issue(7, ["pendulum:in-review"], 3), issue(8, ["pendulum:in-review"], 2)], { comments: { 7: [PLAN(7, SHARED3)], 8: [PLAN(8, SHARED3)], 13: [holdRecord(8, 7, since)] }, prs: { ...PR7(), 8: PR8() } });
  const o = await tick(m, { autoMerge: false });
  assert.deepEqual(o.reviewResumed, [8]);
  assert.deepEqual(prLabels(m, 8), ["pendulum:review"]);
});

test("#340: a stale record (a review label put on since) is released and the PR handled as any; a waiting PR turned to a draft loses its record and gets no label", async () => {
  forgetFiles();
  const since = Date.now() - 3600_000;
  const v = world([issue(7, ["pendulum:in-review"], 3), issue(8, ["pendulum:in-review"], 2)], { comments: { 7: [PLAN(7, SHARED3)], 8: [PLAN(8, SHARED3)], 13: [holdRecord(8, 7, since)] }, prs: { ...PR7(), 8: PR8() } });
  v.state.timelines[13] = [{ event: "labeled", label: { name: "pendulum:review" }, created_at: new Date(since + 60_000).toISOString() }];
  const t = await tick(v);
  assert.deepEqual([t.reviewHeld, t.reviewResumed], [[], []]);
  assert.equal(reviewWaitOf(v.state.comments[13], 8)?.released, true);
  assert.deepEqual(prLabels(v, 8), [], "no label put on: its review already ran");

  forgetFiles();
  const d = world([issue(7, ["pendulum:in-review"], 3), issue(8, ["pendulum:in-review"], 2)], { comments: { 7: [PLAN(7, SHARED3)], 8: [PLAN(8, SHARED3)], 13: [holdRecord(8, 7, since)] }, prs: { ...PR7(), 8: PR8({ draft: true }) } });
  const e = await tick(d);
  assert.deepEqual([e.reviewHeld, e.reviewResumed], [[], []]);
  assert.deepEqual(d.state.comments[13], [], "the record is gone");
  assert.deepEqual(prLabels(d, 8), []);
});

test("#340: a hand-off waits 6 h at most from its first wait, then its review goes on beside the sibling and the note says why; two that wait on each other go in the release order, never both held", async () => {
  forgetFiles();
  const long = Date.now() - 7 * 3600_000;
  const w = world([issue(7, ["pendulum:in-review"], 3), issue(8, ["pendulum:in-review"], 2)], { comments: { 7: [PLAN(7, SHARED3)], 8: [PLAN(8, SHARED3), waitsComment(8, 7, long)], 13: [holdRecord(8, 7, long)] }, prs: { ...PR7(), 8: PR8() } });
  const r = await tick(w);
  assert.deepEqual(r.reviewResumed, [8]);
  assert.deepEqual(prLabels(w, 8), ["pendulum:review"]);
  assert.match(overlap(w, 8)[0].body, /stopped waiting for #7 after 6 h, the longest Pendulum holds a review for a sibling; its review goes on beside it/);

  // #7 and #8 both In review, each recorded waiting for the other (two hand-offs in one moment): #8 waited first, so it goes.
  forgetFiles();
  const since = Date.now() - 60_000;
  const prs = { ...PR7(), 8: PR8() };
  prs[7].pr.labels = [];
  const v = world([issue(7, ["pendulum:in-review"], 3), issue(8, ["pendulum:in-review"], 2)], { comments: { 7: [PLAN(7, SHARED3)], 8: [PLAN(8, SHARED3)], 12: [holdRecord(7, 8, since)], 13: [holdRecord(8, 7, since - 1000)] }, prs });
  const t = await tick(v);
  assert.deepEqual([t.reviewHeld, t.reviewResumed], [[7], [8]]);
  assert.match(overlap(v, 7)[0].body, /its review waits for #8 to merge/);
  // The next tick #8 is In review with its label: #7 still waits for it.
  const again = await tick(v);
  assert.deepEqual([again.reviewHeld, again.reviewResumed], [[7], []]);
});

test("#423: sibling_wait_hours is the bound: a hand-off waiting three hours still waits at the default six, and its review goes on at two, the note saying so", async () => {
  const { resolveInputs } = await import("../scripts/lib/inputs.mjs");
  const three = Date.now() - 3 * 3600_000;
  const waiting = () => world([issue(7, ["pendulum:in-review"], 3), issue(8, ["pendulum:in-review"], 2)], { comments: { 7: [PLAN(7, SHARED3)], 8: [PLAN(8, SHARED3), waitsComment(8, 7, three)], 13: [holdRecord(8, 7, three)] }, prs: { ...PR7(), 8: PR8() } });
  forgetFiles();
  const w = waiting();
  const r = await tick(w);
  assert.deepEqual([r.reviewHeld, r.reviewResumed], [[8], []]);
  const wake = r.deadlines.find((d) => d.issue === 8 && d.kind === "sibling-wait");
  assert.ok(Math.abs(Date.parse(wake.at) - (three + 6 * 3600_000)) < 5 * 60_000, "the wake at the default bound");
  forgetFiles();
  const v = waiting();
  const t = await tick(v, { siblingWaitMs: resolveInputs({ env: { PENDULUM_SIBLING_WAIT_HOURS: "2" } }).siblingWaitMs });
  assert.deepEqual(t.reviewResumed, [8]);
  assert.deepEqual(prLabels(v, 8), ["pendulum:review"]);
  assert.match(overlap(v, 8)[0].body, /stopped waiting for #7 after 2 h, the longest Pendulum holds a review for a sibling/);
});

test("#340: a sibling on the other route counts by its own record: the Action's tick releases its hand-off ahead of a local Objective that waited later, and holds it behind one that waited first; a sibling whose own review waits for a third-party reviewer is not ahead (#423)", async () => {
  const since = Date.now() - 3600_000;
  const prs = () => {
    const p = { ...PR7(), 8: PR8() };
    p[7].pr.labels = [];
    return p;
  };
  // #7 is local (its loop's tick, not this one, settles it) and waits for #8; #8 is the Action's and waits for #7.
  const local = (sinceOf7) => ({ ...holdRecord(7, 8, sinceOf7), user: { login: "kirk", type: "User" }, author_association: "MEMBER" });
  forgetFiles();
  const w = world([issue(7, ["pendulum:in-review", "pendulum:local"], 3), issue(8, ["pendulum:in-review"], 2)], { comments: { 7: [PLAN(7, SHARED3)], 8: [PLAN(8, SHARED3)], 12: [local(since + 60_000)], 13: [holdRecord(8, 7, since)] }, prs: prs() });
  const r = await tick(w);
  assert.deepEqual(r.reviewResumed, [8], "#8 waited first: not held until the bound by #7's wait");
  forgetFiles();
  const v = world([issue(7, ["pendulum:in-review", "pendulum:local"], 3), issue(8, ["pendulum:in-review"], 2)], { comments: { 7: [PLAN(7, SHARED3)], 8: [PLAN(8, SHARED3)], 12: [local(since - 60_000)], 13: [holdRecord(8, 7, since)] }, prs: prs() });
  const t = await tick(v);
  assert.deepEqual(t.reviewHeld, [8], "#7 waited first: it goes first, on its own route");

  // #7 In review, its review waiting for a third-party reviewer on its head (its record on its PR): it will not merge
  // soon, so it is not ahead, as a send-back already reads it, and #8's review goes on.
  const thirdPartyOn = (sha, createdAt = new Date().toISOString(), minutes = 20) => ({ id: 940, user: { login: SELF, type: "Bot" }, body: `${marker(7, "third-party").replace(/ -->$/, "")} {"sha":"${sha}","logins":["greptile-apps[bot]"],"minutes":${minutes}} -->\nPendulum: waiting.`, created_at: createdAt });
  const waitingOn7 = (record, timeline = []) => {
    forgetFiles();
    const x = world([issue(7, ["pendulum:in-review"], 3), issue(8, ["pendulum:in-review"], 2)], { comments: { 7: [PLAN(7, SHARED3)], 8: [PLAN(8, SHARED3)], 12: [record], 13: [holdRecord(8, 7, since)] }, prs: prs() });
    x.state.timelines[12] = timeline;
    return x;
  };
  const p = waitingOn7(thirdPartyOn(H7));
  const q = await tick(p);
  assert.deepEqual([q.reviewHeld, q.reviewResumed], [[], [8]]);
  assert.deepEqual(prLabels(p, 8), ["pendulum:review"]);

  // A record that is no longer current says nothing about when #7 merges: it is still ahead, and #8 waits. A third-party
  // record on an older head, one past its bound, and an account-wait record older than #7's latest review label.
  const old = new Date(Date.now() - 2 * 3600_000).toISOString();
  const account = (at) => ({ id: 941, user: { login: SELF, type: "Bot" }, body: `${marker(7, "account-wait")}\nPendulum: the review waits.`, created_at: at, updated_at: at });
  const labelled = [{ event: "labeled", label: { name: "pendulum:review" }, created_at: new Date(Date.now() - 3600_000).toISOString() }];
  for (const [why, x] of [
    ["an older head", waitingOn7(thirdPartyOn("a".repeat(40)))],
    ["past its bound", waitingOn7(thirdPartyOn(H7, old))],
    ["the review label went on since", waitingOn7(thirdPartyOn(H7, old, 240), labelled)],
    ["an account wait the label came back over", waitingOn7(account(old), labelled)],
  ]) {
    const held = await tick(x);
    assert.deepEqual([held.reviewHeld, held.reviewResumed], [[8], []], why);
  }
});

test("#439: a hand-off, and the rebase of one that conflicts by then, do not wait for a sibling a person took out of the merge queue: both go on the tick that sees it, whichever PR it reads first; put back, the sibling is ahead again", async () => {
  const since = Date.now() - 3600_000;
  // #7 is reviewed (its head recorded mergeable, its checks green, no review label) and a person took PR #12 out of the
  // merge queue after its review; #8's hand-off waits for #7 (their heads conflict).
  const setup = (order, { pr8 = {}, entry = null } = {}) => {
    forgetFiles();
    const prs = { ...PR7(), 8: PR8(pr8) };
    prs[7].pr.labels = [];
    const mergeable = { id: 970, user: { login: SELF, type: "Bot" }, body: `${marker(7, "mergeable", H7)}\nPendulum: mergeable.`, created_at: new Date(since - 3600_000).toISOString() };
    const w = world(
      order.map((n) => (n === 7 ? issue(7, ["pendulum:in-review"]) : issue(8, ["pendulum:in-review"], 2))),
      { comments: { 8: [PLAN(8, SHARED3), waitsComment(8, 7, since)], 12: [mergeable], 13: [holdRecord(8, 7, since)] }, prs },
    );
    w.state.reviewedAt = new Date(since - 3600_000).toISOString();
    w.state.queue = { 12: { removals: [{ createdAt: new Date(since + 60_000).toISOString(), reason: "dequeued", actor: { login: "maintainer", __typename: "User" } }], entry } };
    return w;
  };
  for (const order of [
    [7, 8],
    [8, 7],
  ]) {
    const w = setup(order);
    const r = await tick(w);
    assert.deepEqual([r.reviewHeld, r.reviewResumed], [[], [8]], `#${order[0]} read first`);
    assert.deepEqual(prLabels(w, 8), ["pendulum:review"]);
    assert.equal(reviewWaitOf(w.state.comments[13], 8)?.released, true);
    assert.match(overlap(w, 8)[0].body, /no longer waits for #7/);
  }
  // #8 conflicts by then: it goes back for its rebase the same tick, with no rebase wait for #7.
  const d = setup([8, 7], { pr8: { mergeable_state: "dirty" } });
  const s = await tick(d);
  assert.deepEqual([s.reviewHeld, s.sentBack, s.rebaseHeld], [[], [8], []]);
  assert.equal(reviewWaitOf(d.state.comments[13], 8)?.released, true);
  // The person put PR #12 back in the merge queue: #7 is ahead again and #8 still waits.
  const b = setup([8, 7], { entry: { state: "QUEUED", enqueuedAt: new Date().toISOString(), headCommit: null } });
  const q = await tick(b);
  assert.deepEqual([q.reviewHeld, q.reviewResumed], [[8], []]);
  assert.deepEqual(prLabels(b, 8), []);
});

test("#439: a waiting hand-off whose sibling merges in the same tick is decided on its PR as read after that merge: one that conflicts by then goes back for its rebase, not to review", async () => {
  forgetFiles();
  const since = Date.now() - 3600_000;
  // No merge queue: #7 is reviewed (its head recorded mergeable, its checks green, no review label), so the merge pass
  // merges PR #12 this tick; #8's hand-off waits for #7, and its PR #13 conflicts with the default branch once #12 merged.
  const prs = { ...PR7(), 8: PR8() };
  prs[7].pr.labels = [];
  const mergeable = { id: 970, user: { login: SELF, type: "Bot" }, body: `${marker(7, "mergeable", H7)}\nPendulum: mergeable.`, created_at: new Date(since - 3600_000).toISOString() };
  // GitHub lists the newest first: #8 is read before #7.
  const w = world([issue(8, ["pendulum:in-review"], 2), issue(7, ["pendulum:in-review"])], { comments: { 8: [PLAN(8, SHARED3), waitsComment(8, 7, since)], 12: [mergeable], 13: [holdRecord(8, 7, since)] }, prs });
  w.state.reviewedAt = new Date(since - 3600_000).toISOString();
  w.state.onMerge = (n) => {
    if (n === 12) w.state.prs[8].pr.mergeable_state = "dirty";
  };
  const r = await tick(w, { ciChecks: ["ci"] });
  assert.deepEqual(w.state.mergedPrs, [12]);
  assert.deepEqual([r.reviewHeld, r.reviewResumed, r.sentBack], [[], [], [8]]);
  assert.deepEqual(prLabels(w, 8), [], "no review of a head that conflicts with the default branch");
  assert.equal(reviewWaitOf(w.state.comments[13], 8)?.released, true);
});

test("#340: `pendulum run` on an Objective whose hand-off waits reviews it now: the label goes on, the record is released", async () => {
  forgetFiles();
  const { Local } = await import("../scripts/local.mjs");
  const since = Date.now() - 60_000;
  const w = world([issue(7, ["pendulum:in-review"], 3), issue(8, ["pendulum:in-review"], 2)], { comments: { 8: [waitsComment(8, 7, since)], 13: [holdRecord(8, 7, since)] }, prs: { ...PR7(), 8: PR8() } });
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
  assert.deepEqual(seen, [["review", 8, 13, ["pendulum:review"]]]);
  assert.equal(reviewWaitOf(w.state.comments[13], 8)?.released, true);
  assert.ok(overlap(w, 8)[0].body.startsWith(marker(8, "overlap", "cleared")));
});

test("#340: sibling_hold off holds nothing and says nothing: a waiting PR gets its review label at the next tick, a hand-off reads nothing, a start gets no note; a repository variable sets it and serve takes it hot", async () => {
  const { resolveInputs, variableSettings } = await import("../scripts/lib/inputs.mjs");
  const { HOT_SETTINGS } = await import("../scripts/local.mjs");
  assert.equal(resolveInputs({ env: {} }).siblingHold, true, "on by default");
  assert.equal(resolveInputs({ env: { PENDULUM_SIBLING_HOLD: "off" } }).siblingHold, false);
  assert.deepEqual(variableSettings({ PENDULUM_SIBLING_HOLD: "off" }).kept, { PENDULUM_SIBLING_HOLD: "off" }, "scheduling only: a repository variable may set it");
  assert.deepEqual(variableSettings({ PENDULUM_SIBLING_HOLD: "no" }).invalid.map((x) => x.why), ["not on, off"]);
  assert.ok(HOT_SETTINGS.includes("PENDULUM_SIBLING_HOLD"));

  forgetFiles();
  const since = Date.now() - 60_000;
  const w = world([issue(7, ["pendulum:in-review"], 3), issue(8, ["pendulum:in-review"], 2), issue(9, [], 1)], {
    comments: { 7: [PLAN(7, SHARED3)], 8: [PLAN(8, SHARED3), waitsComment(8, 7, since)], 9: [PLAN(9, SHARED3)], 13: [holdRecord(8, 7, since)] },
    prs: { ...PR7(), 8: PR8() },
  });
  const r = await tick(w, { siblingHold: false });
  assert.deepEqual([r.reviewHeld, r.reviewResumed, r.ready], [[], [8], [9]]);
  assert.deepEqual(prLabels(w, 8), ["pendulum:review"]);
  assert.equal(overlap(w, 9).length, 0, "no note on a start");
  assert.match(overlap(w, 8)[0].body, /no longer waits for #7/);

  forgetFiles();
  const h = world([issue(7, ["pendulum:in-review"], 3), issue(8, ["pendulum:running"], 1)], { comments: { 7: [PLAN(7, SHARED3)], 8: [PLAN(8, SHARED3)] }, prs: { ...PR7(), 8: PR8() } });
  assert.equal(await withWorld(h, () => reviewHold(repoOf(REPO), { issue: 8, pr: h.state.prs[8].pr, autoMerge: true, hold: false }, { token: "t" })), null);
  assert.deepEqual(h.state.reads, []);
});

test("#277: a run named by hand gets no note; with no active sibling and one slot, no files are read", async () => {
  forgetFiles();
  const w = world([issue(7, ["pendulum:running"], 1), issue(8, [], 1)], { comments: { 7: [PLAN(7, ["a.md", "b.md"])], 8: [PLAN(8, ["a.md", "b.md"])] } });
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
  assert.equal(rebaseLine({ usd: 0, conflict: false, passes: 0 }, { count: 1, usd: 2, unknown: 0 }), "rebase 2 of this Objective (clean, no model run): $0.00; all its rebases: $2.00");
  assert.equal(rebaseLine({ usd: 0.8, conflict: false, passes: 2 }, { count: 0, usd: 0, unknown: 0 }), "rebase 1 of this Objective (clean, 2 fix pass(es)): $0.80; all its rebases: $0.80");
  assert.equal(rebaseLine({ usd: 1.25, conflict: true, passes: 1 }, null), "rebase (a conflict pass): $1.25");
  assert.equal(rebaseLine({ usd: null, conflict: true, passes: 0 }, null), "rebase (clean, no model run): unknown");
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
    await progress(`exit: delivered; usd 1.25; ${rebaseLine({ usd: 1.25, conflict: true, passes: 1 }, { count: 2, usd: 0.5, unknown: 0 })}`);
  } finally {
    globalThis.fetch = realFetch;
    if (savedUrl === undefined) delete process.env.GITHUB_API_URL;
    else process.env.GITHUB_API_URL = savedUrl;
  }
  const body = written.at(-1);
  assert.deepEqual(rebaseCostOf(body), { usd: 1.25, conflict: true });
  assert.doesNotMatch(body, /pendulum:spend/, "no spend line on the Actions route: the daily sum is unchanged");
  assert.match(body, /rebase 3 of this Objective \(a conflict pass\): \$1\.25; all its rebases: \$1\.75/);

  const at = (m) => new Date(Date.UTC(2026, 10, 14, 10, m)).toISOString();
  const own = (b, m) => ({ id: m, user: { login: SELF, type: "Bot" }, body: b, created_at: at(m) });
  const clean = `${marker(7, "progress", "work:41")}\nPendulum work: started.\n<!-- pendulum:rebase-cost {"usd":0,"conflict":false} -->`;
  const pasted = { id: 99, user: { login: "someone", type: "User" }, author_association: "NONE", body: `${marker(7, "progress", "work:9")}\n<!-- pendulum:rebase-cost {"usd":50,"conflict":true} -->`, created_at: at(9) };
  const comments = [own(clean, 1), own(body.startsWith("<!--") ? body : `${marker(7, "progress", "work:42")}\n${body}`, 2), pasted];
  assert.deepEqual(rebaseTally(comments, 7, (c) => c.user.login === SELF), { count: 2, usd: 1.25, unknown: 0, conflicts: 1 });

  const pr = { number: 12, state: "closed", merged_at: at(30), head: { ref: "pendulum/7", sha: "b".repeat(40) }, base: { sha: "c".repeat(40) }, created_at: at(0) };
  const notices = [rebaseNotice(7, { head: { sha: "1".repeat(40) }, base: { ref: "main" }, mergeable_state: "dirty" }, 0), rebaseNotice(7, { head: { sha: "2".repeat(40) }, base: { ref: "main" }, mergeable_state: "dirty" }, 1)];
  assert.match(notices[1], /rebase 2 of at most 5 in 24 h/);
  const collected = {
    repository: REPO,
    issue: { number: 7, title: "x", created_at: at(0), labels: [], state: "closed" },
    issueTimeline: [{ event: "labeled", label: { name: "pendulum:running" }, actor: { login: SELF, type: "Bot" }, created_at: at(0) }],
    issueComments: comments,
    pulls: [pr],
    pullDetails: { 12: { comments: notices.map((b, i) => own(b, 10 + i)), commits: [], timeline: [], reviews: [], reviewComments: [] } },
  };
  const rebases = rebasesOf(collected);
  assert.deepEqual(rebases, { sentBack: 2, stages: 2, usd: 1.25, unknown: 0, conflicts: 1 });
  const row = { issue: 7, exit: "merged", parked: false, walkAway: { value: true, interventions: { asked: 0, unprompted: 0 }, askedOnly: { value: true } }, quality: { status: "pending" }, operator: { minutes: 0 }, cost: { usd: 3, tokens: { input: null }, unit: "usd", basis: "b" }, missing: [], rebases, activity: {} };
  const table = markdownTable([row]);
  assert.match(table.split("\n")[0], /\| Rebases \| Harness \|$/);
  assert.match(table.split("\n")[2], /\| 2, \$1\.25 \|/);
});

test("#277: a stopped rebase stage whose end runs out of time still leaves its rebase line: set before the slow read, written by the stop's write, never overwritten by the fallback", async () => {
  const { createServer } = await import("node:http");
  const { spawn } = await import("node:child_process");
  const { pathToFileURL } = await import("node:url");
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
    // A stopped pass with no figure (stop.mjs stoppedRecords) is a run of unknown cost beside the known dollars.
    const cut = await run(`stoppedRebase(progress, false, [{ label: "fix-1", usd: null, usdUnknown: 1, usdUnknownWhy: ["unreported"] }]);`);
    assert.deepEqual(rebaseCostOf(cut), { usd: null, conflict: false, usdUnknown: 1, usdUnknownWhy: ["unreported"] });
    const part = await run(`stoppedRebase(progress, false, [{ label: "fix-1", usd: 0.2 }, { label: "fix-2", usd: null }]);`);
    assert.deepEqual(rebaseCostOf(part), { usd: 0.2, conflict: false, usdUnknown: 1, usdUnknownWhy: ["unreported"] });
  } finally {
    server.close();
  }
});

test("#277: a rebase's runs of unknown cost go from the end's figure to the tally and the scorecard, and a sandbox rebase counts its sandbox", async () => {
  // As the spend line: a pass with no figure beside a priced one is a run of unknown cost beside the known dollars.
  const one = { usdUnknown: 1, usdUnknownWhy: ["unreported"] };
  assert.deepEqual(rebaseCost({ usd: 1.2, ...one }, { records: [{ usd: 1.2 }, { usd: null }] }), { usd: 1.2, ...one });
  assert.deepEqual(rebaseCost({ usd: null }, { records: [{ usd: null }] }), { usd: null, ...one });
  assert.deepEqual(rebaseCost({ usd: 0 }, { records: [{ usd: null, noRun: true }] }), { usd: 0 });

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
    const cost = rebaseCost({ usd: 1.2, ...one }, { records: [{ usd: 1.2 }, { usd: null }] });
    const before = `${marker(7, "progress", "work:41")}\nPendulum work: started.\n<!-- pendulum:rebase-cost {"usd":0.5,"conflict":false} -->`;
    line = await rebaseExitLine(progress, 7, { cost, conflict: true, passes: 2 }, async () => [{ id: 1, user: { login: SELF, type: "Bot" }, body: before }]);
    await progress(`exit: delivered; ${line}`);
  } finally {
    globalThis.fetch = realFetch;
    if (savedUrl === undefined) delete process.env.GITHUB_API_URL;
    else process.env.GITHUB_API_URL = savedUrl;
  }
  assert.equal(line, "rebase 2 of this Objective (a conflict pass): $1.20 plus 1 run of unknown cost; all its rebases: $1.70 plus 1 run of unknown cost");
  const body = written.at(-1);
  assert.deepEqual(rebaseCostOf(body), { usd: 1.2, conflict: true, ...one });

  const at = (m) => new Date(Date.UTC(2026, 10, 14, 10, m)).toISOString();
  const own = (b, m) => ({ id: m, user: { login: SELF, type: "Bot" }, body: b, created_at: at(m) });
  // The sandbox route: the launcher books the sandbox's dollars in a vendor comment keyed as the stage's progress comment.
  const sandbox = own(`${marker(7, "progress", "work:44")}\nPendulum work: started.\n<!-- pendulum:rebase-cost {"usd":0.3,"conflict":false} -->`, 3);
  const vendor = own(`${marker(7, "vendor", "work:44")}\n${vendorBody({ line: "sandbox", vendorUsd: 0.05 })}`, 4);
  const comments = [own(body.startsWith("<!--") ? body : `${marker(7, "progress", "work:43")}\n${body}`, 2), sandbox, vendor];
  assert.deepEqual(rebaseTally(comments, 7, (c) => c.user.login === SELF), { count: 2, usd: 1.55, unknown: 1, conflicts: 1 });

  const collected = { repository: REPO, issue: { number: 7, title: "x", created_at: at(0), labels: [], state: "open" }, issueTimeline: [{ event: "labeled", label: { name: "pendulum:running" }, actor: { login: SELF, type: "Bot" }, created_at: at(0) }], issueComments: comments, pulls: [], pullDetails: {} };
  const rebases = rebasesOf(collected);
  assert.deepEqual(rebases, { sentBack: 0, stages: 2, usd: 1.55, unknown: 1, conflicts: 1 });
  assert.match(rebaseCell(rebases), /^0, \$1\.55 plus 1 run of unknown cost/);
});

test("#277: a sandbox rebase's vendor cost: a reported one adds its dollars, one the vendor did not report is a run of unknown cost, in the tally, the cell and the row's cost", () => {
  const at = (m) => new Date(Date.UTC(2026, 10, 14, 10, m)).toISOString();
  const own = (b, m) => ({ id: m, user: { login: SELF, type: "Bot" }, body: b, created_at: at(m) });
  const stage = (run, m) => own(`${marker(7, "progress", `work:${run}`)}\nPendulum work: started.\n<!-- pendulum:spend {"usd":0.3} -->\n<!-- pendulum:rebase-cost {"usd":0.3,"conflict":false} -->`, m);
  // A sandbox the vendor reported, and one whose usage it did not (stageVendorCost: null), booked as the launcher books them.
  const priced = own(`${marker(7, "vendor", "work:51")}\n${vendorBody({ line: "sandbox", vendorUsd: 0.08 })}`, 2);
  const unpriced = own(`${marker(7, "vendor", "work:52")}\n${vendorBody({ line: "sandbox", vendorUsd: null })}`, 4);
  assert.deepEqual(spendOf(unpriced.body), { usd: 0, unknown: 1 }, "an unreported sandbox adds no dollars to the daily sum and is counted as unknown");
  const mine = (c) => c.user.login === SELF;
  assert.deepEqual(rebaseTally([stage(51, 1), priced], 7, mine), { count: 1, usd: 0.38, unknown: 0, conflicts: 0 });
  assert.deepEqual(rebaseTally([stage(52, 3), unpriced], 7, mine), { count: 1, usd: 0.3, unknown: 1, conflicts: 0 });
  assert.equal(rebaseLine({ usd: 0.1, conflict: false, passes: 1 }, rebaseTally([stage(52, 3), unpriced], 7, mine)), "rebase 2 of this Objective (clean, 1 fix pass(es)): $0.10; all its rebases: $0.40 plus 1 run of unknown cost");

  const comments = [stage(51, 1), priced, stage(52, 3), unpriced];
  const collected = { repository: REPO, issue: { number: 7, title: "x", created_at: at(0), labels: [], state: "open" }, issueTimeline: [{ event: "labeled", label: { name: "pendulum:running" }, actor: { login: SELF, type: "Bot" }, created_at: at(0) }], issueComments: comments, pulls: [], pullDetails: {} };
  const rebases = rebasesOf(collected);
  assert.deepEqual(rebases, { sentBack: 0, stages: 2, usd: 0.68, unknown: 1, conflicts: 0 });
  assert.match(rebaseCell(rebases), /^0, \$0\.68 plus 1 run of unknown cost/);
  // The row's cost reads the same vendor comments: the reported one priced, the unreported one unknown.
  assert.deepEqual(spendRecords(collected).map((r) => r.vendor), [{ usd: 0.08 }, { usd: null, usdUnknown: 1 }]);
});
