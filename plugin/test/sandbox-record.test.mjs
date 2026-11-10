// The sandbox record keeps every start: two writers share it (the launcher after a start, the stage with every beat)
// and GitHub has no compare-and-set on a comment, so either can land over the other. Shapes from the wave-5 drill's
// #293 and #294, both started from one dispatcher run (42593022322), where #294's work launch and image were lost.
import "./temp.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { VERCEL_RATES } from "../scripts/lib/adapters/sandbox-vercel.mjs";
import { launcherWrote, marker, sandboxRecord, sandboxRecordOf, stageDeadline, withLaunch } from "../scripts/lib/logic.mjs";
import { recordBody, stageProgressKey, startEntry, startInSandbox, startedRecord } from "../scripts/launch.mjs";
import { awaitLauncher, startedFields, startedLaunch, writeRecord } from "../scripts/stage.mjs";

const RUN = "42593022322";
const IMAGE = { snapshot: "snap_famw7CHNm6PKr7p8K7DiwB2RmaGJ", sha: "a6fcd9f08a0eff2a7b93df6d622d1e8f0204fd30" };
const EVENT_AT = "2026-11-09T09:23:09.000Z";
const OBJECTIVES = [
  { n: 293, claim: "a5e441c92cdf", sandbox: "factory-0d2c41aa7b10", cue: "stint-1794216209", commandMs: Date.parse("2026-11-09T09:23:58.230Z") },
  { n: 294, claim: "76991fcd4388", sandbox: "factory-cfecde49e990", cue: "stint-1794216211", commandMs: Date.parse("2026-11-09T09:23:59.441Z") },
];
const bot = { login: "factory-app[bot]", type: "Bot" };
const self = (c) => c.user?.login === bot.login;

/** One repository's comments: the record comment per Objective, written whole (GitHub's PATCH). */
function comments() {
  const byId = new Map();
  return {
    list: (n) => [...byId.values()].filter((c) => c.issue === n),
    put: (n, id, rec) => byId.set(id, { id, issue: n, user: bot, body: `${marker(n, "sandbox")}\n${recordBody(rec)}` }),
    get: (id) => byId.get(id),
  };
}

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
 * One Objective's two writers. The launcher reads the record and writes startedRecord over it; the stage's first beat
 * is awaitLauncher (reads until the launcher's write is in, or `waits` reads pass), then writeRecord (read from the
 * list, read the comment, compare, patch). `order` says how they interleave. `waits: 0` is the beat without the wait.
 */
async function race(store, o, s, order, { stageFields = s.fields, stageLaunch = s.stageLaunch, waits = 3 } = {}) {
  const id = o.n * 1000;
  store.put(o.n, id, claimRecord(o));
  let now = null;
  const launcherRead = () => (now = sandboxRecord(store.list(o.n), o.n, { self }));
  const launcherWrite = () => {
    const at = "2026-11-09T09:24:00.900Z";
    const entry = { ...s.launch, latencyMs: Date.parse(s.result.commandAt) - Date.parse(EVENT_AT), found: s.result.found, at, ms: MS };
    if (now?.claim === o.claim) store.put(o.n, id, startedRecord(now, { base: { vendor: "vercel", stage: "work", event: "pull_request", eventAt: EVENT_AT, run: RUN, budgetUsd: 20, home: null }, result: s.result, claim: o.claim, progress: stageProgressKey(RUN, o.claim), latencyMs: entry.latencyMs, at, leaseUntil: "2026-11-09T09:34:00.900Z", entry }));
  };
  // `afterRead` runs after the stage's first read of the record, `beforePatch` just before its write.
  const beat = async ({ afterRead = () => {}, beforePatch = () => {} } = {}) => {
    let reads = 0;
    const record = async () => {
      const r = sandboxRecord(store.list(o.n), o.n, { self });
      const out = r && { ...r, body: store.get(r.commentId).body };
      if ((reads += 1) === 1) afterRead();
      return out;
    };
    if (waits) await awaitLauncher({ record, launch: stageLaunch, claim: o.claim, tries: waits, pauseMs: 1 });
    return writeRecord({
      claim: o.claim,
      launch: stageLaunch,
      change: { ...stageFields, state: "running", leaseUntil: "2026-11-09T09:34:01.000Z" },
      pauseMs: 1,
      record,
      read: async (cid) => ({ body: store.get(cid).body }),
      patch: async (cid, rec) => {
        beforePatch();
        store.put(o.n, cid, rec);
      },
    });
  };
  const launcher = () => (launcherRead(), launcherWrite());
  // The drill's interleaving: the stage's first read comes before the launcher's write, its write after.
  if (order === "beat over the launcher") await beat(waits ? { afterRead: launcher } : { beforePatch: launcher });
  else if (order === "launcher, then beat") (launcher(), await beat());
  // The launcher's write never came while the beat waited: the beat goes ahead, the launcher's write lands after it.
  else if (order === "beat, then launcher") (await beat(), launcher());
  else if (order === "launcher over the beat") (launcherRead(), await beat(), launcherWrite());
  return sandboxRecordOf(store.get(id).body);
}

const ORDERS = ["beat over the launcher", "launcher, then beat", "beat, then launcher", "launcher over the beat"];

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
  for (const order of ORDERS) {
    const store = comments();
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

test("without the first beat's wait, a beat landing over the launcher still clears the quota streak and keeps the deadline", async () => {
  const [o] = OBJECTIVES;
  const s = await started(o);
  const rec = await race(comments(), o, s, "beat over the launcher", { waits: 0 });
  assert.equal(rec.quota, undefined, "the stage's write drops the streak its stale read carried");
  assert.equal(rec.deadlineAt, s.result.deadlineAt, "the stage writes the launcher's deadline");
  assert.equal(rec.launches[0].ms, undefined, "negative control: the timings are the launcher's alone, which the wait keeps");
});

test("awaitLauncher: reads until the launcher's entry, with its timings, is in the record", async () => {
  const launch = { stage: "work", ok: true, cue: "stint-1", run: "9", at: "a" };
  const reads = (...recs) => {
    let i = 0;
    return async () => recs[Math.min(i++, recs.length - 1)];
  };
  const mine = { claim: "c", launches: [launch] };
  const written = { claim: "c", launches: [{ ...launch, ms: { "start.command": 1 } }] };
  assert.equal(await awaitLauncher({ record: reads(mine, mine, written), launch, claim: "c", tries: 5, pauseMs: 1 }), "written");
  assert.equal(await awaitLauncher({ record: reads(mine), launch, claim: "c", tries: 3, pauseMs: 1 }), "timeout", "the stage's own entry is not the launcher's");
  assert.equal(await awaitLauncher({ record: reads({ ...written, claim: "other" }), launch, claim: "c", tries: 3, pauseMs: 1 }), "lost");
  assert.equal(await awaitLauncher({ record: reads(written), launch: null, claim: "c", tries: 3, pauseMs: 1 }), "none");
  assert.equal(launcherWrote([{ ...launch, run: "10", ms: {} }], launch), false, "another run's start");
});

test("stageDeadline: the wall clock from the start, never past the session's end less the reserve", () => {
  const at = "2026-11-09T09:24:00.000Z";
  assert.equal(stageDeadline(at, 40, "2026-11-09T11:00:00.000Z"), "2026-11-09T10:04:00.000Z");
  assert.equal(stageDeadline(at, 40, "2026-11-09T10:06:00.000Z"), "2026-11-09T10:00:00.000Z");
  assert.equal(stageDeadline(at, 40, null), "2026-11-09T10:04:00.000Z");
  assert.equal(stageDeadline(null, 40, null), null);
  assert.equal(stageDeadline(at, 0, null), null);
});

test("the drill's loss, reproduced: a beat that carries only the sandbox, home and meter lands over the launcher's write", async () => {
  const [o] = OBJECTIVES.slice(1);
  const s = await started(o);
  const old = startedFields(JSON.stringify({ id: s.result.id, home: s.result.home, meter: s.result.meter }));
  const rec = await race(comments(), o, s, "beat over the launcher", { stageFields: old, stageLaunch: null, waits: 0 });
  assert.deepEqual([rec.launches.length, rec.image], [0, undefined], "what #294's record showed before its review: no work launch, no image");
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
