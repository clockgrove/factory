// The sandbox record keeps every start: it is read merged from single-writer parts (logic.mjs sandboxRecord), the
// launcher's claim comment and the stage's own comment, so neither write can land over the other. Shapes from the
// wave-5 drill's #293 and #294, both started from one dispatcher run (42593022322), where #294's work launch and image
// were lost to a beat landing over the launcher's write when both wrote one comment.
import "./temp.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { VERCEL_RATES } from "../scripts/lib/adapters/sandbox-vercel.mjs";
import { marker, sandboxMarkerLine, sandboxRecord, setSelf, stageDeadline, withLaunch } from "../scripts/lib/logic.mjs";
import { recordBody, stageProgressKey, startEntry, startInSandbox, startedRecord, writeSandboxRecord } from "../scripts/launch.mjs";
import { stageWriter, startedFields, startedLaunch } from "../scripts/stage.mjs";
import { BASE, BOT, REPO, githubStore } from "./fixtures/github-records.mjs";

const RUN = "42593022322";
const IMAGE = { snapshot: "snap_famw7CHNm6PKr7p8K7DiwB2RmaGJ", sha: "a6fcd9f08a0eff2a7b93df6d622d1e8f0204fd30" };
const EVENT_AT = "2026-11-09T09:23:09.000Z";
const OBJECTIVES = [
  { n: 293, claim: "a5e441c92cdf", sandbox: "factory-0d2c41aa7b10", cue: "stint-1794216209", commandMs: Date.parse("2026-11-09T09:23:58.230Z") },
  { n: 294, claim: "76991fcd4388", sandbox: "factory-cfecde49e990", cue: "stint-1794216211", commandMs: Date.parse("2026-11-09T09:23:59.441Z") },
];
setSelf(BOT.login);

/** A work stage started from one dispatcher run: the real start against a vendor that creates from the image. */
async function started(o) {
  let env = null;
  const adapter = {
    rates: VERCEL_RATES,
    list: async () => [],
    create: async ({ snapshot }) => {
      assert.equal(snapshot, IMAGE.snapshot);
      return { id: o.sandbox, expiresAt: new Date(Date.now() + 45 * 60_000).toISOString() };
    },
    usage: async () => ({ wallMs: 0, activeCpuMs: 0, memoryMb: 4096, vcpus: 2 }),
    extend: async () => {
      throw Object.assign(new Error("no"), { code: "invalid" });
    },
    stop: async () => {},
    writeFiles: async () => {},
    run: async (id, spec) => {
      if (spec.argv.includes("factory-probe")) spec.onStdout("/vercel\nmissing\n");
      else {
        env = spec.env;
        spec.onStdout(`${o.commandMs}\n`);
      }
      return { exitCode: 0 };
    },
  };
  const launch = startEntry({ stage: "work", event: "pull_request", eventAt: EVENT_AT, run: RUN, cue: o.cue });
  const result = await startInSandbox({ adapter, repo: { owner: "clockgrove", name: "factory-scratch", full: "clockgrove/factory-scratch" }, repoId: "1", issue: o.n, recordedId: null, image: Promise.resolve(IMAGE), baseImage: "node24", claim: o.claim, env: { FACTORY_TIMEOUT_MINUTES: "40" }, budgetMs: 55 * 60_000, vcpus: 2, harness: "claude", plugin: { digest: "d", tgz: Buffer.from("") }, maxUsd: 20, handoff: { progress: stageProgressKey(RUN, o.claim), launch } });
  // What the stage reads at its start (FACTORY_STAGE_COMMAND_MS is what START printed).
  const fields = startedFields(env.FACTORY_STAGE_RECORD, String(o.commandMs), env.FACTORY_TIMEOUT_MINUTES);
  return { result, launch, fields, stageLaunch: startedLaunch(env.FACTORY_STAGE_RECORD, fields) };
}

/**
 * The launcher's claim write (launch.mjs startLocked) as the drill wrote it: no sandbox yet, no launches; here after two
 * quota refusals, whose streak the claim carries over.
 */
const QUOTA = { since: "2026-11-09T09:05:00.000Z", tries: 2, retryAt: "2026-11-09T09:20:00.000Z" };
const claimRecord = (o) => ({ vendor: "vercel", stage: "work", event: "pull_request", eventAt: EVENT_AT, run: RUN, budgetUsd: 20, home: null, id: null, state: "running", at: "2026-11-09T09:23:53.120Z", leaseUntil: "2026-11-09T09:33:53.120Z", claim: o.claim, launches: [], quota: QUOTA });
const MS = { "start.create": 2000, "start.command": 1200 };

/**
 * One Objective's two writers, as launch.mjs and stage.mjs make them: the launcher's post-start write (startedRecord
 * over the record as it is, under the record lock) and the stage's beats (its own comment), on the in-memory GitHub.
 * `order`: at once (the store's seed picks the interleaving), or one after the other. Returns the record as read.
 */
async function race(store, o, s, order, { stageFields = s.fields, stageLaunch = s.stageLaunch } = {}) {
  store.put(o.n, `${marker(o.n, "sandbox")}\n${recordBody(claimRecord(o))}`);
  const launcher = () => {
    const at = "2026-11-09T09:24:00.900Z";
    const entry = { ...s.launch, latencyMs: Date.parse(s.result.commandAt) - Date.parse(EVENT_AT), found: s.result.found, at, ms: MS };
    return writeSandboxRecord(REPO, o.n, {}, (cur) => (cur?.claim === o.claim ? startedRecord(cur, { base: { vendor: "vercel", stage: "work", event: "pull_request", eventAt: EVENT_AT, run: RUN, budgetUsd: 20, home: null }, result: s.result, claim: o.claim, progress: stageProgressKey(RUN, o.claim), latencyMs: entry.latencyMs, at, leaseUntil: "2026-11-09T09:34:00.900Z", entry }) : null), { api: store.api, base: BASE, tries: 400, pauseMs: 0, readBackPauseMs: 0 });
  };
  const write = stageWriter({
    issue: o.n,
    claim: o.claim,
    launch: stageLaunch,
    list: () => store.api.rest(`repos/${REPO.full}/issues/${o.n}/comments?per_page=100`),
    put: (id, body) => (id ? store.api.rest(`repos/${REPO.full}/issues/comments/${id}`, { method: "PATCH", body: { body } }) : store.api.rest(`repos/${REPO.full}/issues/${o.n}/comments`, { method: "POST", body: { body } })),
  });
  const beat = () => write({ ...stageFields, state: "running", leaseUntil: "2026-11-09T09:34:01.000Z" });
  // The stage's beats run one at a time (stage.mjs heartbeat), beside the launcher's write.
  const beats = async () => [await beat(), await beat()];
  const [l, [b, b2]] = order === "together" ? await Promise.all([launcher(), beats()]) : order === "launcher, then beat" ? [await launcher(), await beats()] : (([x, y]) => [y, x])([await beats(), await launcher()]);
  assert.equal(l.ok, true, `#${o.n} (${order}): the launcher's write went in`);
  assert.deepEqual([b, b2], [{ ok: true }, { ok: true }], `#${o.n} (${order}): the beats went in`);
  return sandboxRecord(await store.api.rest(`repos/${REPO.full}/issues/${o.n}/comments?per_page=100`), o.n);
}

const ORDERS = ["together", "launcher, then beat", "beat, then launcher"];

test("two Objectives started from one dispatcher run: each record keeps its work launch and its image, whichever write lands last", async () => {
  const starts = await Promise.all(OBJECTIVES.map(started));
  for (const [i, o] of OBJECTIVES.entries()) {
    const { result, fields, stageLaunch } = starts[i];
    assert.deepEqual(result.image, IMAGE, "created from the image");
    assert.deepEqual(fields.image, IMAGE, "the stage is handed the image");
    assert.equal(fields.commandAt, result.commandAt, "one start time for both writers");
    assert.equal(fields.latencyMs, o.commandMs - Date.parse(EVENT_AT));
    assert.equal(fields.deadlineAt, result.deadlineAt, "one deadline for both writers");
    assert.equal(fields.progress, `${RUN}-${o.claim}`);
    assert.deepEqual([stageLaunch.stage, stageLaunch.cue, stageLaunch.run, stageLaunch.found, stageLaunch.ok], ["work", o.cue, RUN, false, true]);
  }
  for (const [order, seed] of [...ORDERS.map((x) => [x, 1]), ...Array.from({ length: 30 }, (_, i) => ["together", i + 2])]) {
    const store = githubStore({ seed });
    // Both Objectives' writes run at once in one repository, as the two launch jobs and their two stages did.
    const records = await Promise.all(OBJECTIVES.map((o, i) => race(store, o, starts[i], order)));
    for (const [i, o] of OBJECTIVES.entries()) {
      const rec = records[i];
      const work = rec.launches.filter((l) => l.ok === true && l.stage === "work");
      assert.equal(work.length, 1, `#${o.n} (${order}): one work launch, not lost or doubled`);
      assert.deepEqual([work[0].cue, work[0].run, work[0].latencyMs], [o.cue, RUN, o.commandMs - Date.parse(EVENT_AT)], `#${o.n} (${order})`);
      assert.deepEqual(rec.image, IMAGE, `#${o.n} (${order}): the image it started from`);
      assert.deepEqual([rec.id, rec.claim, rec.commandAt, rec.progress], [o.sandbox, o.claim, starts[i].result.commandAt, `${RUN}-${o.claim}`], `#${o.n} (${order})`);
      assert.match(recordBody(rec), /Dispatch latency \d+\.\d s/, `#${o.n} (${order}): the human line has the latency`);
      assert.equal(rec.quota, undefined, `#${o.n} (${order}): the start ended the quota streak`);
      assert.deepEqual([work[0].ms, rec.deadlineAt], [MS, starts[i].result.deadlineAt], `#${o.n} (${order}): the launcher's timings and deadline`);
    }
  }
});

test("the drill's loss cannot recur: a beat that carries only the sandbox, home and meter keeps the launcher's launch and image", async () => {
  const [o] = OBJECTIVES.slice(1);
  const s = await started(o);
  const old = startedFields(JSON.stringify({ id: s.result.id, home: s.result.home, meter: s.result.meter }));
  for (let seed = 1; seed <= 20; seed += 1) {
    const rec = await race(githubStore({ seed }), o, s, "together", { stageFields: old, stageLaunch: null });
    assert.deepEqual([rec.launches.length, rec.image, rec.launches[0].ms], [1, IMAGE, MS], `seed ${seed}: what #294's record lost is kept`);
  }
});

test("the stage's part: written by that stage alone, in two calls, and read only while the claim comment carries its claim", async () => {
  const [o] = OBJECTIVES;
  const store = githubStore();
  store.put(o.n, `${marker(o.n, "sandbox")}\n${recordBody(claimRecord(o))}`);
  const list = () => store.api.rest(`repos/${REPO.full}/issues/${o.n}/comments?per_page=100`);
  const put = (id, body) => (id ? store.api.rest(`repos/${REPO.full}/issues/comments/${id}`, { method: "PATCH", body: { body } }) : store.api.rest(`repos/${REPO.full}/issues/${o.n}/comments`, { method: "POST", body: { body } }));
  const writers = { [o.claim]: stageWriter({ issue: o.n, claim: o.claim, list, put }), ffffffffffff: stageWriter({ issue: o.n, claim: "ffffffffffff", list, put }) };
  const beat = (claim, state) => writers[claim]({ state, leaseUntil: "2026-11-09T09:40:00.000Z" });
  assert.deepEqual(await beat(o.claim, "running"), { ok: true });
  const before = store.calls.length;
  assert.deepEqual(await beat(o.claim, "running"), { ok: true });
  assert.deepEqual(store.calls.slice(before).map((c) => c.split(" ")[0]), ["GET", "PATCH"], "a beat: one list read and one write");
  let rec = sandboxRecord(await list(), o.n);
  assert.deepEqual([rec.leaseUntil, rec.quota], ["2026-11-09T09:40:00.000Z", undefined], "the stage's lease, the quota streak over");
  assert.deepEqual(await beat("ffffffffffff", "running"), { lost: true }, "another claim: nothing written");
  assert.equal([...store.comments.values()].filter((c) => c.body.includes("ffffffffffff")).length, 0);
  // The launcher's stop folds the stage's part in; the part is read no more.
  [...store.comments.values()].find((c) => c.body.startsWith(`${marker(o.n, "sandbox")}\n`)).body = `${marker(o.n, "sandbox")}\n${recordBody({ ...claimRecord(o), state: "stopped" })}`;
  rec = sandboxRecord(await list(), o.n);
  assert.deepEqual([rec.state, rec.leaseUntil], ["stopped", claimRecord(o).leaseUntil]);
});

test("the stage's part: a fresh part missing from the list is written again by its id, not posted twice; the latest part is read", async () => {
  const [o] = OBJECTIVES;
  const store = githubStore({ hideNew: 2 });
  store.put(o.n, `${marker(o.n, "sandbox")}\n${recordBody(claimRecord(o))}`);
  const write = stageWriter({
    issue: o.n,
    claim: o.claim,
    list: () => store.api.rest(`repos/${REPO.full}/issues/${o.n}/comments?per_page=100`),
    put: (id, body) => (id ? store.api.rest(`repos/${REPO.full}/issues/comments/${id}`, { method: "PATCH", body: { body } }) : store.api.rest(`repos/${REPO.full}/issues/${o.n}/comments`, { method: "POST", body: { body } })),
  });
  assert.deepEqual((await write({ state: "running", leaseUntil: "2026-11-09T09:40:00.000Z" })).ok, true);
  // A stage that fails fast: its end comes while its first write is still missing from the list.
  assert.deepEqual((await write({ state: "ended", exitCode: 1, leaseUntil: null })).ok, true);
  const parts = [...store.comments.values()].filter((c) => c.body.startsWith(`${marker(o.n, "stage", o.claim)}\n`));
  assert.equal(parts.length, 1, "one part, written again by its id");
  const rec = sandboxRecord([...store.comments.values()], o.n);
  assert.deepEqual([rec.state, rec.exitCode, rec.leaseUntil], ["ended", 1, null], "the end is read: the Objective is not held until its lease lapses");
  // Two parts of one claim (one made before this fix): the one written last is read, whatever its id.
  const two = [
    { id: 1, user: BOT, body: `${marker(o.n, "sandbox")}\n${recordBody(claimRecord(o))}` },
    { id: 2, user: BOT, body: `${marker(o.n, "stage", o.claim)}\n${sandboxMarkerLine({ state: "ended", exitCode: 1, at: "2026-11-09T09:31:00.000Z" })}` },
    { id: 3, user: BOT, body: `${marker(o.n, "stage", o.claim)}\n${sandboxMarkerLine({ state: "running", at: "2026-11-09T09:30:00.000Z" })}` },
  ];
  assert.equal(sandboxRecord(two, o.n).state, "ended");
});

test("stageDeadline: the wall clock from the start, never past the session's end less the reserve", () => {
  const at = "2026-11-09T09:24:00.000Z";
  assert.equal(stageDeadline(at, 40, "2026-11-09T11:00:00.000Z"), "2026-11-09T10:04:00.000Z");
  assert.equal(stageDeadline(at, 40, "2026-11-09T10:06:00.000Z"), "2026-11-09T10:00:00.000Z");
  assert.equal(stageDeadline(at, 40, null), "2026-11-09T10:04:00.000Z");
  assert.equal(stageDeadline(null, 40, null), null);
  assert.equal(stageDeadline(at, 0, null), null);
});

test("withLaunch: one entry per cue and run; the launcher's replaces the stage's, the stage's never replaces the launcher's", () => {
  const stage = { stage: "work", ok: true, cue: "stint-1", run: "9", at: "a" };
  const launcher = { ...stage, at: "b", ms: { "start.command": 1 } };
  const review = { stage: "review", ok: true, cue: "asked-2", run: "10", at: "c" };
  const failed = { stage: "work", ok: false, cue: "stint-1", run: "9", at: "z" };
  assert.deepEqual(withLaunch([failed], stage), [failed, stage], "a failed try of the same cue is kept beside the start");
  assert.deepEqual(withLaunch([stage], launcher, { replace: true }), [launcher]);
  assert.deepEqual(withLaunch([launcher], stage), [launcher], "a later beat keeps the launcher's timings");
  assert.deepEqual(withLaunch([launcher], review), [launcher, review], "the review's start keeps the work's");
  assert.equal(withLaunch(Array.from({ length: 12 }, (_, i) => ({ ok: false, cue: `c${i}`, run: "1" })), stage).length, 10, "the record keeps the latest ten");
  assert.deepEqual(withLaunch(undefined, stage), [stage]);
});

test("startedLaunch: only the launcher's plain shapes pass; a missing or mangled entry hands nothing over", () => {
  const ok = { stage: "work", event: "pull_request", eventAt: EVENT_AT, ok: true, run: RUN, cue: "stint-1", found: false };
  const fields = startedFields(JSON.stringify({ launch: ok }), String(Date.parse(EVENT_AT) + 50_000));
  assert.deepEqual(startedLaunch(JSON.stringify({ launch: ok }), fields), { ...ok, latencyMs: 50_000, at: fields.commandAt });
  for (const bad of [{ ...ok, stage: "sweep" }, { ...ok, cue: "x y" }, { ...ok, run: "1; rm" }, { ...ok, found: "no" }, { ...ok, event: "<b>" }]) assert.equal(startedLaunch(JSON.stringify({ launch: bad }), fields), null);
  assert.equal(startedLaunch(JSON.stringify({ launch: { ...ok, delivery: "0f8fad5b-d9cb-469f-a165-70867728950e" } }), fields).delivery, undefined, "no field beyond the launcher's own");
  assert.equal(startedLaunch("{}", fields), null);
  assert.equal(startedLaunch("not json", fields), null);
  assert.deepEqual(startedFields(JSON.stringify({ image: { snapshot: "snap x", sha: "1" }, sessionEnd: "soon", progress: "<p>" }), "12"), {}, "only plain shapes pass");
});
