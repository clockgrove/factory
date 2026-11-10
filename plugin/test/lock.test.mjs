// The launch lock (lib/lock.mjs) against an in-memory ref store that answers as GitHub did when probed on the scratch
// adopter: creating an existing ref is 422, a missing ref reads 404, deleting a missing ref is 422, and updateRefs
// refuses (a GraphQL error) when the ref no longer points at beforeOid. Commits are named by their content, as in git:
// two identical commits are one object. The live behaviour is the PR's scratch proof.
import "./temp.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { LOCK_STALE_MS, listLocks, lockRef, readLock, releaseLock, sweepLocks, takeLock } from "../scripts/lib/lock.mjs";

const repo = { owner: "acme", name: "widgets", full: "acme/widgets" };
const ZERO = "0".repeat(40);
const T0 = Date.parse("2026-11-08T22:00:00Z");
const base = { repositoryId: "R_1", tree: "t".repeat(40) };
const err = (status, message) => Object.assign(new Error(message), { status });

/** GitHub's git refs and commits for one repository. `beforeSwap` runs before each updateRefs is applied. */
function store({ beforeSwap = async () => {} } = {}) {
  const refs = new Map();
  const objects = new Map();
  let next = 0;
  const calls = [];
  const prefix = `repos/${repo.full}/git/`;
  const rest = async (path, { method = "GET", body } = {}) => {
    calls.push(`${method} ${path.slice(prefix.length)}`);
    const p = path.slice(prefix.length);
    if (method === "POST" && p === "commits") {
      const sha = createHash("sha1").update(JSON.stringify([body.message, body.tree, body.parents, body.author])).digest("hex");
      objects.set(sha, { type: "commit", sha, message: body.message, author: body.author, tree: body.tree });
      return { sha };
    }
    if (method === "POST" && p === "refs") {
      if (!objects.has(body.sha)) throw err(422, "Object does not exist");
      if (refs.has(body.ref)) throw err(422, "Reference already exists");
      refs.set(body.ref, body.sha);
      return { ref: body.ref };
    }
    if (method === "GET" && p.startsWith("ref/")) {
      const ref = `refs/${p.slice(4)}`;
      if (!refs.has(ref)) throw err(404, "Not Found");
      const o = objects.get(refs.get(ref));
      return { ref, object: { sha: o.sha, type: o.type } };
    }
    if (method === "GET" && p.startsWith("commits/")) return objects.get(p.slice(8)) ?? Promise.reject(err(404, "Not Found"));
    if (method === "GET" && p.startsWith("matching-refs/")) {
      const want = `refs/${p.slice(14)}`;
      return [...refs].filter(([r]) => r.startsWith(want)).map(([r, sha]) => ({ ref: r, object: { sha, type: objects.get(sha).type } }));
    }
    throw new Error(`unexpected ${method} ${path}`);
  };
  const graphql = async (_q, { repositoryId, refUpdates: [u] }) => {
    assert.equal(repositoryId, base.repositoryId);
    calls.push(`updateRefs ${u.beforeOid.slice(0, 4)}->${u.afterOid.slice(0, 4)}`);
    await beforeSwap(u);
    const now = refs.get(u.name) ?? ZERO;
    if (now !== u.beforeOid) throw err(0, "Something went wrong while executing your query");
    if (u.afterOid === ZERO) refs.delete(u.name);
    else refs.set(u.name, u.afterOid);
    return { updateRefs: { clientMutationId: null } };
  };
  /** A lock as another process made it, `ageMs` old, or a foreign object. */
  const plant = (ref, { ageMs = 0, author = { name: "Factory", email: "factory@users.noreply.github.com" }, message = ref, type = "commit" } = {}) => {
    const sha = (++next).toString(16).padStart(40, "p");
    objects.set(sha, { type, sha, message, author: { ...author, date: new Date(T0 - ageMs).toISOString() } });
    refs.set(ref, sha);
    return sha;
  };
  return { api: { rest, graphql }, refs, calls, plant };
}

const REF = lockRef(7, "review", "asked-1794175200");
const take = (s, over = {}) => takeLock(repo, REF, { base, now: () => T0, api: s.api, token: "t", ...over });

test("lock: one creator holds it; the other is told when it was taken", async () => {
  const s = store();
  const [a, b] = await Promise.all([take(s), take(s)]);
  assert.equal([a, b].filter((x) => x.taken).length, 1, "exactly one start");
  const lost = a.taken ? b : a;
  assert.equal(lost.at, new Date(T0).toISOString());
  assert.equal(s.refs.get(REF), (a.taken ? a : b).oid);
  assert.equal((await readLock(repo, REF, {}, s.api)).foreign, false);
});

test("lock: two takers of one stale lock, both having read it, cannot both take it over", async () => {
  // Negative control first: a lock younger than the bound is never taken over.
  const fresh = store();
  fresh.plant(REF, { ageMs: LOCK_STALE_MS - 60_000 });
  assert.equal((await take(fresh)).taken, false);
  // Both takers read the stale lock before either swaps (the interleaving that DELETE-then-create let through).
  let waiting = 0;
  let release;
  const gate = new Promise((r) => (release = r));
  const s = store({
    beforeSwap: async () => {
      waiting += 1;
      if (waiting === 2) release();
      await gate;
    },
  });
  const stale = s.plant(REF, { ageMs: LOCK_STALE_MS + 60_000 });
  const [a, b] = await Promise.all([take(s), take(s)]);
  assert.equal([a, b].filter((x) => x.taken).length, 1, "exactly one took it over");
  const won = a.taken ? a : b;
  assert.equal(won.tookOver, new Date(T0 - LOCK_STALE_MS - 60_000).toISOString());
  assert.equal(s.refs.get(REF), won.oid);
  assert.notEqual(s.refs.get(REF), stale);
  assert.equal(s.calls.filter((c) => c.startsWith("DELETE")).length, 0, "no unconditional delete");
});

test("lock: a refused create with no ref there is an error, not a held lock", async () => {
  const s = store();
  // A create GitHub refuses for another reason (here: the object it names does not exist) leaves no ref behind.
  s.api.rest = ((inner) => async (path, o = {}) => (o.method === "POST" && path.endsWith("/git/refs") ? Promise.reject(err(422, "Object does not exist")) : inner(path, o)))(s.api.rest);
  await assert.rejects(take(s), (e) => e.status === 422);
});

test("lock: a foreign ref blocks its cue but is never taken over by a launcher; the dispatcher's pass releases it", async () => {
  for (const foreign of [{ type: "tag" }, { author: { name: "someone", email: "x@example.com" } }, { message: "hello" }]) {
    const s = store();
    s.plant(REF, { ageMs: LOCK_STALE_MS * 4, ...foreign });
    const r = await take(s);
    assert.deepEqual([r.taken, r.foreign], [false, true]);
    const swept = await sweepLocks(repo, { base, now: () => T0, api: s.api });
    assert.deepEqual(swept.map((x) => [x.action, x.reason]), [["released", "foreign lock"]]);
    assert.equal(s.refs.has(REF), false);
  }
});

test("release: only the lock taken as that oid is dropped", async () => {
  const s = store();
  const mine = await take(s);
  assert.equal(await releaseLock(repo, REF, { oid: mine.oid, base, api: s.api }), true);
  assert.equal(s.refs.has(REF), false);
  assert.equal(await releaseLock(repo, REF, { oid: mine.oid, base, api: s.api }), false, "already gone: not an error");
  // Taken over meanwhile (a holder past the bound): the late release leaves the new holder's lock.
  const old = await take(s);
  const theirs = s.plant(REF);
  assert.equal(await releaseLock(repo, REF, { oid: old.oid, base, api: s.api }), false);
  assert.equal(s.refs.get(REF), theirs);
});

test("the dispatcher's pass: stale and foreign locks released, a live one kept; listLocks names the Objective", async () => {
  const s = store();
  const live = lockRef(7, "work", "stint-1");
  const dead = lockRef(12, "work", "checks-abcdef012345");
  s.plant(live, { ageMs: 60_000 });
  s.plant(dead, { ageMs: LOCK_STALE_MS + 1 });
  assert.deepEqual((await listLocks(repo, {}, { api: s.api })).map((l) => [l.ref, l.issue]).sort((x, y) => x[1] - y[1]), [[live, 7], [dead, 12]]);
  assert.deepEqual((await listLocks(repo, {}, { n: 12, api: s.api })).map((l) => l.issue), [12]);
  const out = await sweepLocks(repo, { base, now: () => T0, api: s.api });
  assert.deepEqual(Object.fromEntries(out.map((r) => [r.ref, r.action])), { [live]: "kept", [dead]: "released" });
  assert.deepEqual([...s.refs.keys()], [live]);
});

test("launcher: a second launcher of one stage start, hand-over or end loses the lock and does nothing", async () => {
  const { launchCue, stageLock, withLock } = await import("../scripts/launch.mjs");
  const s = store();
  const run = { repo, n: 9, opts: { api: s.api, token: "t" }, base, out: (o) => ({ issue: 9, ...o }) };
  // The first launcher holds the lock while it acts; the second, at the same time, does nothing.
  const acted = [];
  let finish;
  const act = (name, keep = false) => {
    const busy = name === "first" ? new Promise((r) => (finish = r)) : null;
    return async (hold) => {
      acted.push(name);
      hold.keep = keep;
      await busy;
      return { exit: "done" };
    };
  };
  const end = stageLock(9, { kind: "stage", want: "ended", claim: "a1b2c3d4e5f6" }, { stage: "work" });
  assert.equal(end, "refs/factory-launch/9/work-ended-a1b2c3d4e5f6");
  const first = withLock(run, end, act("first"));
  await new Promise((r) => setImmediate(r));
  const second = await withLock(run, end, act("second"));
  assert.match(second.reason, /another launcher holds factory-launch\/9\/work-ended-a1b2c3d4e5f6/);
  finish();
  assert.deepEqual(await first, { exit: "done" });
  assert.deepEqual(acted, ["first"], "only the holder acted");
  assert.equal(s.refs.has(end), false, "an end's lock is released after it (the record, now stopped, turns later launchers away)");
  // A hand-over keeps its lock: the same request is answered once, even by a launcher that comes after.
  const ask = stageLock(9, { kind: "stage", want: "token", claim: "a1b2c3d4e5f6", ask: 1794175200 }, { stage: "work" });
  assert.equal((await withLock(run, ask, act("token", true))).exit, "done");
  assert.match((await withLock(run, ask, act("token again"))).reason, /another launcher holds/);
  assert.notEqual(stageLock(9, { kind: "stage", want: "token", claim: "a1b2c3d4e5f6", ask: 1794177600 }, { stage: "work" }), ask, "the stage's next request is its own cue");
  assert.equal(stageLock(9, { kind: "stage", want: "ended", claim: "../x" }, { stage: "work" }), null, "a claim not of Factory's form locks nothing");
  // The work's end starting the review and the PR's labeled event (two Action runs) meet at one cue.
  const review = { pr: 40, labelled: true, since: "2026-11-08T22:00:05Z" };
  const fromEnd = launchCue({ kind: "stage", issue: 9 }, "review", { review });
  assert.equal(fromEnd, launchCue({ kind: "review", issue: 9 }, "review", { review }));
  const startRef = lockRef(9, "review", fromEnd);
  const winner = withLock(run, startRef, act("first"));
  await new Promise((r) => setImmediate(r));
  assert.match((await withLock(run, startRef, act("labeled"))).reason, /another launcher holds/);
  assert.equal(acted.includes("labeled"), false);
  finish();
  await winner;
  assert.equal(launchCue({ kind: "stage", issue: 9 }, "work", { runningSince: "2026-11-08T21:00:00Z" }), "stint-1794171600", "a work start after an end is the Running stint's cue, as the sweep's is");
});
