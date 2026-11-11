// Single-writer records against an in-memory GitHub (fixtures/github-records.mjs), whose calls interleave by seed:
// the claim comment, the one part with several writers, written under the Objective's record lock; the vendor comment,
// written by the one booker holding the stage's book lock. The same writers as blind read-then-PATCH writes of one
// comment (what GitHub's comment API alone gives) do lose writes, so the harness can see a loss.
import "./temp.mjs";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { VERCEL_RATES } from "../scripts/lib/adapters/sandbox-vercel.mjs";
import { marker, sandboxRecordOf, setSelf, spendOf } from "../scripts/lib/logic.mjs";
import { bookVendor, recordBody, sameRecord, writeSandboxRecord } from "../scripts/launch.mjs";
import { BASE, BOT, REPO, githubStore } from "./fixtures/github-records.mjs";

setSelf(BOT.login);
const N = 7;
const HEAD = marker(N, "sandbox");
const SEEDS = 40;
const fast = (s) => ({ api: s.api, base: BASE, tries: 400, pauseMs: 0, readBackPauseMs: 0 });
const record = (s) => sandboxRecordOf(s.bodyOf(N, HEAD));

test("claims: two launchers and the sweep claiming over one read record at once: exactly one claim, the others told", async () => {
  for (let seed = 1; seed <= SEEDS; seed += 1) {
    const s = githubStore({ seed });
    const read = { vendor: "vercel", stage: "work", state: "stopped", claim: "000000000000", launches: [] };
    s.put(N, `${HEAD}\n${recordBody(read)}`);
    const claimers = ["aaaaaaaaaaaa", "bbbbbbbbbbbb", "sweep-cccccccccccc"];
    const results = await Promise.all(claimers.map((claim) => writeSandboxRecord(REPO, N, {}, (cur) => (sameRecord(cur, read) ? { ...read, state: "running", claim } : null), fast(s))));
    assert.equal(results.filter((r) => r.ok).length, 1, `seed ${seed}: exactly one claim`);
    assert.ok(results.every((r) => r.ok || r.refused), `seed ${seed}: the others are told, not lost or left contended`);
    assert.equal(record(s).claim, claimers[results.findIndex((r) => r.ok)], `seed ${seed}: the winner's claim is the record's`);
    assert.equal(s.refs.size, 0, `seed ${seed}: the record lock is released`);
  }
});

test("claim comment: writers at once under the record lock each get their change in, a lagging list read included", async () => {
  for (const lag of [0, 2]) {
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      const s = githubStore({ seed, lag });
      const writers = ["w0", "w1", "w2", "w3", "w4"];
      const results = await Promise.all(writers.map((w) => writeSandboxRecord(REPO, N, {}, (cur) => ({ ...(cur || {}), launches: [...(cur?.launches || []), { cue: w }] }), fast(s))));
      assert.ok(results.every((r) => r.ok), `seed ${seed}, lag ${lag}: every write went in`);
      assert.deepEqual(record(s).launches.map((l) => l.cue).sort(), writers, `seed ${seed}, lag ${lag}: no write lost`);
      assert.equal([...s.comments.values()].length, 1, `seed ${seed}, lag ${lag}: one claim comment`);
    }
  }
});

test("negative control: the same writers as blind read-then-PATCH writes of one comment lose changes", async () => {
  let lost = 0;
  for (let seed = 1; seed <= SEEDS; seed += 1) {
    const s = githubStore({ seed });
    const id = s.put(N, `${HEAD}\n${recordBody({ launches: [] })}`);
    const blind = async (w) => {
      const list = await s.api.rest(`repos/${REPO.full}/issues/${N}/comments?per_page=100`);
      const cur = sandboxRecordOf(list.find((c) => c.id === id).body);
      await s.api.rest(`repos/${REPO.full}/issues/comments/${id}`, { method: "PATCH", body: { body: `${HEAD}\n${recordBody({ ...cur, launches: [...cur.launches, { cue: w }] })}` } });
    };
    await Promise.all(["w0", "w1", "w2", "w3", "w4"].map(blind));
    if (record(s).launches.length < 5) lost += 1;
  }
  assert.ok(lost > 0, "blind writes lose a change under some interleaving: the harness sees a loss");
});

test("vendor booking: the launcher and the sweep booking one stage at once write one vendor comment, and never the progress comment", async () => {
  process.env.RUNNER_TEMP = mkdtempSync(join(tmpdir(), "factory-book-"));
  const claim = "0123456789ab";
  const progress = `${marker(N, "progress", `work:9-${claim}`)}\nFactory work run 9-${claim}.\n- 03:00Z setup\n<!-- factory:spend {"usd":0.5} -->`;
  const rec = { id: "factory-abc", vendor: "vercel", stage: "work", run: "9", claim, meter: { base: { wallMs: 0, activeCpuMs: 0 }, created: false, ceilingUsd: 0.3, stored: { ms: 0, bytes: null }, vcpus: 2 } };
  const after = { wallMs: 120_000, activeCpuMs: 30_000, memoryMb: 4096, vcpus: 2 };
  for (let seed = 1; seed <= SEEDS; seed += 1) {
    const s = githubStore({ seed });
    s.put(N, progress);
    const book = () => bookVendor({ adapter: { rates: VERCEL_RATES }, repo: REPO, n: N, opts: {}, record: rec, after, settled: true, state: "stopped", api: s.api, base: BASE });
    const [a, b] = await Promise.all([book(), book()]);
    const vendorWrites = s.calls.filter((c) => /^(POST|PATCH) issues\//.test(c));
    assert.equal(vendorWrites.length, 1, `seed ${seed}: one booker wrote`);
    assert.equal(s.bodyOf(N, marker(N, "progress", `work:9-${claim}`)), progress, `seed ${seed}: the progress comment is the stage's alone`);
    const vendor = s.bodyOf(N, marker(N, "vendor", `work:9-${claim}`));
    assert.match(vendor, /sandbox `factory-abc` stopped/);
    const sum = [...s.comments.values()].reduce((t, c) => t + spendOf(c.body), 0);
    assert.ok(Math.abs(sum - (0.5 + a.vendor.usd)) < 1e-9, `seed ${seed}: the daily sum counts model and vendor once each`);
    assert.equal(a.vendor.usd, b.vendor.usd);
  }
});
