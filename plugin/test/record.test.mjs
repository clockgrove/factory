// Compare-and-set record writes (lib/record.mjs) against an in-memory GitHub (fixtures/github-records.mjs): writers
// started together on one comment, under many interleavings, lose nothing; the same writers as blind read-then-PATCH
// writes (what GitHub's comment API alone gives) do lose writes, so the harness can see a loss.
import "./temp.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { marker, setSelf } from "../scripts/lib/logic.mjs";
import { SETTLE_MS, WRITE_WITHIN_MS, casComment, recordRef, versionOf } from "../scripts/lib/record.mjs";
import { BASE, BOT, REPO, githubStore } from "./fixtures/github-records.mjs";

setSelf(BOT.login);
const N = 7;
const HEAD = marker(N, "sandbox");
const REF = recordRef(N, HEAD);
const T0 = Date.parse("2026-11-10T08:00:00Z");
const items = (text) => (text === null ? [] : JSON.parse(text.slice(HEAD.length + 1)).items);
/** Each writer adds its own item to the list the comment holds: a write lost to another shows as a missing item. */
const add = (who) => (text) => JSON.stringify({ items: [...items(text), who] });
const cas = (s, who, over = {}) => casComment(REPO, N, { marker: HEAD, update: add(who), api: s.api, base: BASE, tries: 400, pauseMs: 0, now: () => T0, token: "t", ...over });

test("record: writers started together on one comment each get their change in, under every interleaving tried", async () => {
  for (let seed = 1; seed <= 40; seed += 1) {
    const s = githubStore({ seed });
    const writers = Array.from({ length: 6 }, (_, i) => `w${i}`);
    const results = await Promise.all(writers.map((w) => cas(s, w)));
    assert.ok(results.every((r) => r.ok), `seed ${seed}: every write went in`);
    const text = s.bodyOf(N, HEAD);
    assert.deepEqual([...items(text)].sort(), writers, `seed ${seed}: no write lost, none doubled`);
    assert.equal(s.versionAt(REF), versionOf(text), `seed ${seed}: the register holds the comment's version`);
    assert.equal([...s.comments.values()].length, 1, `seed ${seed}: one comment, the first writer's`);
  }
});

test("record: negative control, the same writers as blind read-then-PATCH writes lose changes", async () => {
  let lost = 0;
  for (let seed = 1; seed <= 40; seed += 1) {
    const s = githubStore({ seed });
    const id = s.put(N, `${HEAD}\n${JSON.stringify({ items: [] })}`);
    const blind = async (who) => {
      const list = await s.api.rest(`repos/${REPO.full}/issues/${N}/comments?per_page=100`);
      const body = add(who)(list.find((c) => c.id === id).body);
      await s.api.rest(`repos/${REPO.full}/issues/comments/${id}`, { method: "PATCH", body: { body: `${HEAD}\n${body}` } });
    };
    await Promise.all(["a", "b", "c", "d"].map(blind));
    if (items(s.bodyOf(N, HEAD)).length < 4) lost += 1;
  }
  assert.ok(lost > 0, "blind writes lose a change under some interleaving: the harness sees a loss");
});

test("record: a list read that lags the last write is never written over", async () => {
  for (let seed = 1; seed <= 20; seed += 1) {
    const s = githubStore({ seed, lag: 3 });
    const results = await Promise.all(["a", "b", "c"].map((w) => cas(s, w)));
    assert.ok(results.every((r) => r.ok), `seed ${seed}`);
    // A write after the others settled, its first reads still lagging.
    assert.ok((await cas(s, "d")).ok);
    assert.deepEqual([...items(s.bodyOf(N, HEAD))].sort(), ["a", "b", "c", "d"], `seed ${seed}: the lagging read was read again, not written over`);
  }
});

test("record: a version moved in whose comment write has not come is waited on; one older than SETTLE_MS is abandoned", async () => {
  const s = githubStore();
  s.put(N, `${HEAD}\n${JSON.stringify({ items: ["old"] })}`);
  s.plant(REF, versionOf(`${HEAD}\n${JSON.stringify({ items: ["old", "in flight"] })}`), { at: T0 - 5_000 });
  const before = s.calls.length;
  assert.deepEqual(await cas(s, "late", { tries: 3 }), { contended: true }, "a write in flight: read again, nothing written");
  assert.equal(s.calls.slice(before).filter((c) => c.startsWith("PATCH") || c.startsWith("updateRefs")).length, 0);
  assert.deepEqual(items(s.bodyOf(N, HEAD)), ["old"]);
  // The in-flight writer never writes once WRITE_WITHIN_MS is past, so a version older than SETTLE_MS never lands.
  assert.ok(SETTLE_MS > WRITE_WITHIN_MS + 10_000, "room for GitHub's 10-second request limit and clock skew");
  const r = await cas(s, "late", { tries: 3, now: () => T0 + SETTLE_MS });
  assert.equal(r.ok, true);
  assert.deepEqual(items(s.bodyOf(N, HEAD)), ["old", "late"], "written over the comment as it is");
});

test("record: a writer past WRITE_WITHIN_MS after its register move writes nothing and moves the register back", async () => {
  const s = githubStore();
  s.put(N, `${HEAD}\n${JSON.stringify({ items: [] })}`);
  assert.ok((await cas(s, "first")).ok);
  const held = s.refs.get(REF);
  let t = T0;
  // The clock jumps between the register move and the comment write (a stall).
  const slow = await cas(s, "slow", { tries: 1, now: () => ((t += WRITE_WITHIN_MS + 1), t) });
  assert.deepEqual(slow, { contended: true });
  assert.equal(s.refs.get(REF), held, "the register is back on the version the comment holds");
  assert.deepEqual(items(s.bodyOf(N, HEAD)), ["first"]);
  assert.ok((await cas(s, "next")).ok, "the next writer is not held up");
});

test("record: update's null writes nothing; a failed comment write moves the register back and throws", async () => {
  const s = githubStore();
  assert.deepEqual(await cas(s, "x", { update: () => null }), { refused: true, text: null });
  assert.equal(s.refs.size, 0, "no register for a refused write");
  assert.ok((await cas(s, "a")).ok);
  const held = s.refs.get(REF);
  const rest = s.api.rest;
  const api = { ...s.api, rest: (p, o = {}) => (o.method === "PATCH" ? Promise.reject(Object.assign(new Error("boom"), { status: 502 })) : rest(p, o)) };
  await assert.rejects(cas(s, "b", { api }), (e) => e.status === 502);
  assert.equal(s.refs.get(REF), held);
  assert.ok((await cas(s, "c")).ok, "the next write does not wait on the failed one");
  assert.deepEqual(items(s.bodyOf(N, HEAD)), ["a", "c"]);
});

test("recordRef: one register per marker comment, plain ref names only", () => {
  assert.equal(recordRef(7, marker(7, "sandbox")), "refs/factory-record/7/sandbox");
  assert.equal(recordRef(7, marker(7, "progress", "work:42593022322-a5e441c92cdf")), "refs/factory-record/7/progress.work.42593022322-a5e441c92cdf");
  for (const bad of [marker(8, "sandbox"), "<!-- factory:7:a..b -->", "<!-- factory:7:x y -->", "<!-- factory:7:x.lock -->", "sandbox"]) assert.throws(() => recordRef(7, bad));
});
