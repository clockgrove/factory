import "./temp.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { REBASE_LIMIT, marker, ontoRecord } from "../scripts/lib/logic.mjs";
import { RETRY } from "../scripts/lib/github.mjs";

// The fakes here fail some GitHub reads for good: the client's retries (#168) go at once, not after real backoff waits.
RETRY.sleep = async () => {};

// #243: three to five Objectives run at once on shared files; their PRs merge minutes apart. One In-review PR conflicts
// each time a sibling merges. These ticks run the real dispatcher over a fake GitHub (an Actions route, one Objective #7
// with PR #12) and play the worker's part between them: its rebase record and its push.

const REPO = "acme/app";
const SELF = "factory-app[bot]";
const sha = (c) => c.repeat(40);
const ago = (ms) => new Date(Date.now() - ms).toISOString();
const HOUR = 3600_000;

/** GitHub as the dispatcher reads it: the Objective, its PR, the PR's comments, the default branch and the merge queue. */
function world({ queue = false } = {}) {
  const state = {
    main: sha("d"),
    queued: 0,
    pr: { number: 12, state: "open", draft: false, merged: false, node_id: "PR_12", title: "Objective 7", labels: [], head: { sha: sha("0"), ref: "factory/7" }, base: { ref: "main" }, mergeable: false, mergeable_state: "dirty" },
    comments: { 7: [], 12: [] },
    writes: [],
  };
  let id = 100;
  const issue = { number: 7, state: "open", labels: ["factory:objective", "factory:in-review"].map((name) => ({ name })), body: "", updated_at: new Date().toISOString(), user: { login: "maintainer" } };
  const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const p = u.pathname.replace(`/repos/${REPO}`, "");
    const method = init.method || "GET";
    const body = init.body ? JSON.parse(init.body) : null;
    if (u.pathname === "/graphql") {
      if (body.query.includes("mergeQueue(branch")) return json({ data: { repository: { ref: { target: { oid: state.main, committedDate: ago(HOUR) } }, mergeQueue: { entries: { totalCount: state.queued } } } } });
      return json({ data: {} });
    }
    let m;
    if (method !== "GET") state.writes.push(`${method} ${p}${body?.body ? ` ${body.body}` : ""}`);
    if (method === "GET" && u.pathname === "/user") return json({ login: SELF, type: "Bot" });
    if (method === "GET" && p === "/issues") return json(u.searchParams.get("state") === "closed" ? [] : [issue]);
    if (method === "GET" && p === "") return json({ default_branch: "main" });
    if (method === "GET" && p === "/rulesets") return json(queue ? [{ id: 1, target: "branch", enforcement: "active" }] : []);
    if (method === "GET" && p === "/rulesets/1") return json({ conditions: { ref_name: { include: ["~DEFAULT_BRANCH"] } }, rules: [{ type: "merge_queue" }] });
    if (method === "GET" && u.pathname.endsWith("/collaborators")) return json([{ login: "maintainer" }]);
    if (method === "GET" && /^\/issues\/7\/timeline$/.test(p)) return json([{ event: "labeled", label: { name: "factory:objective" }, created_at: ago(30 * HOUR) }]);
    if (method === "GET" && (m = /^\/issues\/(\d+)\/comments$/.exec(p))) return json(state.comments[m[1]] || []);
    if (method === "POST" && (m = /^\/issues\/(\d+)\/comments$/.exec(p))) {
      const c = { id: id++, user: { login: SELF, type: "Bot" }, body: body.body, created_at: new Date().toISOString() };
      (state.comments[m[1]] ||= []).push(c);
      return json(c, 201);
    }
    if (method === "GET" && p === "/pulls") return json(state.pr.state === "open" ? [state.pr] : []);
    if (method === "GET" && p === "/pulls/12") return json(state.pr);
    if (method === "GET" && /\/actions\/(workflows\/[^/]+\/)?runs$/.test(p)) return json({ workflow_runs: [] });
    if (method === "DELETE" || method === "POST" || method === "PATCH" || method === "PUT") return json({}, 200);
    return json({ message: "Not Found" }, 404);
  };
  // A sibling merges: the default branch moves and the PR conflicts with it.
  const siblingMerges = (next) => {
    state.main = next;
    Object.assign(state.pr, { mergeable: false, mergeable_state: "dirty" });
  };
  // The worker's send-back: its record of the rebase (onto the default branch now, conflicting in `files`), then its
  // push, which resolves the conflict (clean) or not (still dirty).
  const workerRebases = async (files, pushed, { resolved = true } = {}) => {
    await fetch(`https://github.test/repos/${REPO}/issues/12/comments`, { method: "POST", body: JSON.stringify({ body: ontoRecord(7, { from: state.pr.head.sha, base: state.main, files }) }) });
    state.pr.head = { ...state.pr.head, sha: pushed };
    Object.assign(state.pr, resolved ? { mergeable: true, mergeable_state: "clean" } : { mergeable: false, mergeable_state: "dirty" });
  };
  return { state, fetch, siblingMerges, workerRebases };
}

async function tick(w) {
  const { dispatch } = await import("../scripts/dispatch.mjs");
  const realFetch = globalThis.fetch;
  const saved = Object.fromEntries(["FACTORY_LOCAL", "FACTORY_LOCAL_ALL", "GITHUB_API_URL"].map((k) => [k, process.env[k]]));
  process.env.GITHUB_API_URL = "https://github.test";
  delete process.env.FACTORY_LOCAL;
  delete process.env.FACTORY_LOCAL_ALL;
  globalThis.fetch = w.fetch;
  const from = w.state.writes.length;
  try {
    const r = await dispatch({ repo: REPO, objectiveLabel: "factory:objective", maxConcurrent: 5, dailyUsd: 0, ciChecks: [], timeoutMinutes: 60, autoMerge: true, notify: "" }, { token: "t" });
    const writes = w.state.writes.slice(from);
    return { r, writes, blocked: writes.find((x) => x.startsWith("POST /issues/7/comments") && x.includes(marker(7, "blocked").replace(/ -->$/, ""))) };
  } finally {
    globalThis.fetch = realFetch;
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

const notices = (w) => w.state.comments[12].filter((c) => c.body.startsWith(marker(7, "rebase").replace(/ -->$/, "")));

for (const queue of [false, true]) {
  test(`#243: three successive sibling merges each send the PR back for a new rebase, never a Block (${queue ? "a merge queue dequeues it for the conflict" : "no merge queue"})`, async () => {
    const w = world({ queue });
    const files = ["docs/decisions.md", "test/fixtures/env.ts"];
    // The first sibling merged: the PR conflicts (with a queue, the queue dropped it for that conflict).
    let t = await tick(w);
    assert.deepEqual(t.r.sentBack, [7]);
    assert.equal(t.blocked, undefined);
    for (const [n, next] of [[1, sha("e")], [2, sha("f")]]) {
      await w.workerRebases(files, sha(String(n)));
      // Clean after the rebase: nothing to send back.
      t = await tick(w);
      assert.deepEqual(t.r.sentBack, []);
      // The next sibling merges on the same files: a new base, so a new send-back, not a Block.
      w.siblingMerges(next);
      t = await tick(w);
      assert.deepEqual(t.r.sentBack, [7], `send-back ${n + 1}`);
      assert.equal(t.blocked, undefined, `no Block after ${n} rebase(s): ${t.blocked}`);
    }
    assert.equal(notices(w).length, 3, "one notice per send-back, each naming the head it saw");
    assert.ok(notices(w)[2].body.startsWith(marker(7, "rebase", sha("2"))));
  });
}

test("#243: the same conflict back on the same base after the worker's resolution Blocks, naming the files, as the work's", async () => {
  const w = world();
  await tick(w);
  // The worker's push did not take the base: the PR still conflicts, and nothing merged since.
  await w.workerRebases(["docs/decisions.md", "src/commands/run.ts"], sha("1"), { resolved: false });
  const t = await tick(w);
  assert.deepEqual(t.r.sentBack, [], "no third pass on the same conflict");
  assert.ok(t.blocked, "Blocked");
  assert.match(t.blocked, /rebasing makes no progress: the branch still conflicts with `main` at ddddddd/);
  assert.match(t.blocked, /`docs\/decisions\.md`, `src\/commands\/run\.ts`/);
  assert.match(t.blocked, /"cause":"work"/);

  // A sibling merging meanwhile is a new base instead: sent back again.
  const v = world();
  await tick(v);
  await v.workerRebases(["docs/decisions.md"], sha("1"), { resolved: false });
  v.siblingMerges(sha("e"));
  const u = await tick(v);
  assert.deepEqual(u.r.sentBack, [7]);
  assert.equal(u.blocked, undefined);
});

test(`#243: the bound: ${REBASE_LIMIT} rebases in 24 h, then the next conflict Blocks; older rebases do not count`, async () => {
  const w = world();
  const bases = ["e", "f", "1", "2", "3", "4"].map(sha);
  await tick(w);
  for (let n = 0; n < REBASE_LIMIT; n += 1) {
    await w.workerRebases(["docs/decisions.md"], sha(String.fromCharCode(97 + n)));
    w.siblingMerges(bases[n]);
    const t = await tick(w);
    if (n < REBASE_LIMIT - 1) {
      assert.deepEqual(t.r.sentBack, [7], `rebase ${n + 2} goes ahead`);
      assert.equal(t.blocked, undefined);
    } else {
      assert.deepEqual(t.r.sentBack, [], "no sixth rebase");
      assert.match(t.blocked, new RegExp(`the branch was rebased ${REBASE_LIMIT} times in 24 h as other PRs merged.*last conflict: \`docs/decisions\\.md\`.*blocked_by`));
      assert.match(t.blocked, /"cause":"work"/);
    }
  }

  // The same history a day old: the window has passed, so it goes back again.
  const v = world();
  await tick(v);
  for (let n = 0; n < REBASE_LIMIT; n += 1) {
    await v.workerRebases(["docs/decisions.md"], sha(String.fromCharCode(97 + n)));
    v.siblingMerges(bases[n]);
    if (n < REBASE_LIMIT - 1) await tick(v);
  }
  for (const c of v.state.comments[12]) c.created_at = ago(25 * HOUR);
  const t = await tick(v);
  assert.deepEqual(t.r.sentBack, [7]);
  assert.equal(t.blocked, undefined);
});

test("#243: the worker's rebase record reads back as written, whatever the file names; a conflict pass that left the branch off its base Blocks as the work's, after the caps", async () => {
  const { decideExit, parseOnto } = await import("../scripts/lib/logic.mjs");
  const files = ["docs/decisions.md", "odd --> name.md", "src/<x>.ts"];
  const body = ontoRecord(7, { from: sha("a"), base: sha("b"), files, defaultBranch: "main" });
  assert.ok(!body.split("\n")[0].slice(0, -4).includes("-->"), "no file name closes the marker");
  assert.deepEqual(parseOnto(7, body), { from: sha("a"), base: sha("b"), files });
  assert.equal(parseOnto(8, body), null, "another Objective's record is not this one's");
  const unresolved = "the worker could not resolve the conflict with `main` at bbbbbbb in `docs/decisions.md`: the branch it left is not rebased onto it";
  const pr = { exists: true, draft: false, body: "Closes #7" };
  assert.deepEqual(decideExit({ harness: { ok: true }, pr, commits: 1, unresolved, record: { exit: "delivered", reason: "", questions: [] } }), { exit: "blocked", reason: unresolved, cause: "work" });
  assert.equal(decideExit({ harness: { ok: true, timedOut: true }, pr, commits: 1, unresolved }).reason, "time cap reached", "a cap keeps its own reason");
  assert.equal(decideExit({ harness: { ok: true, budgetExceeded: true }, pr, commits: 1, unresolved }).cause, "max-usd");
});
