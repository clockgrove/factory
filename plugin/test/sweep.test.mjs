import "./temp.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { checksResume, launchDecision, missedAnswer, sweepDecision } from "../scripts/lib/logic.mjs";
import { objectiveSandboxes, usageTarball } from "../scripts/sweep.mjs";
import { renderWorkflow } from "../scripts/setup.mjs";
import { parseYaml } from "../scripts/lib/yaml.mjs";

const NOW = Date.parse("2026-11-20T12:00:00Z");
const DAY = 86_400_000;
const box = (over = {}) => ({ id: "factory-aaa", state: "stopped", createdAt: "2026-11-01T00:00:00Z", tags: { factory: "objective", "factory-repo": "7", "factory-issue": "4" }, ...over });
const rec = (over = {}) => ({ id: "factory-aaa", state: "stopped", stage: "work", at: "2026-11-10T00:00:00Z", claim: "c1", home: "/home/factory", collected: true, ...over });
const open = { state: "open" };
const base = { sandbox: box(), issue: open, state: "Question", record: rec(), holds: false, now: NOW, idleMs: 7 * DAY, graceMs: 15 * 60_000 };

test("sweep: which Objective sandboxes go", () => {
  assert.deepEqual(sweepDecision({ ...base, issue: { state: "closed" } }), { destroy: "its Objective is closed", collect: false });
  assert.deepEqual(sweepDecision({ ...base, issue: { state: "closed" }, record: rec({ collected: false }) }), { destroy: "its Objective is closed", collect: true }, "its usage comes out first");
  assert.equal(sweepDecision({ ...base, issue: null }).destroy, "its Objective is closed", "no issue by that number");
  assert.equal(sweepDecision({ ...base, record: rec({ id: "factory-bbb" }) }).destroy, "its Objective's record names another sandbox");
  assert.equal(sweepDecision({ ...base, record: null }).destroy, "no sandbox record names it");
  assert.match(sweepDecision(base).destroy, /^stopped 10 days, the Objective Question$/);
  assert.match(sweepDecision({ ...base, record: rec({ at: "2026-11-18T00:00:00Z" }) }).keep, /stopped/, "stopped two days: kept");
  assert.deepEqual(sweepDecision({ ...base, sandbox: box({ state: "running" }) }), { stop: "running with no stage holding it, the Objective Question", collect: false }, "running with no stage: an end never answered");
  const vanished = rec({ state: "running", leaseUntil: new Date(NOW - 30 * 60_000).toISOString(), collected: undefined });
  assert.deepEqual(sweepDecision({ ...base, state: "Blocked", sandbox: box({ state: "running" }), record: vanished }), { stop: "running with no stage holding it, the Objective Blocked", collect: true }, "a Block for a vanished stage stops its sandbox");
  assert.equal(sweepDecision({ ...base, state: "Blocked", sandbox: box({ state: "running" }), record: vanished, holds: true }).keep, "a stage holds it", "a live lease is never stopped");
  assert.equal(sweepDecision({ ...base, state: "Running", sandbox: box({ state: "running" }), record: vanished }).keep, "the Objective is Running", "a Running Objective's stage is the dispatcher's to judge");
  for (const state of ["Running", "In review"]) assert.equal(sweepDecision({ ...base, state }).keep, `the Objective is ${state}`, "a live Objective's own sandbox stays, however long stopped");
  assert.equal(sweepDecision({ ...base, holds: true, issue: { state: "closed" } }).keep, "a stage holds it");
  assert.equal(sweepDecision({ ...base, sandbox: box({ createdAt: new Date(NOW - 60_000).toISOString() }), record: null }).keep, "created moments ago", "a launcher may not have recorded it yet");
});

test("sweep: only Factory's Objective sandboxes for this repository are listed; never an image sandbox", () => {
  const listed = [
    box(),
    box({ id: "factory-img", tags: { factory: "image", "factory-image": "7", sha: "a".repeat(40), snapshot: "snap_x" } }),
    box({ id: "factory-other", tags: { factory: "objective", "factory-repo": "8", "factory-issue": "4" } }),
    box({ id: "someone-else", tags: { factory: "objective", "factory-repo": "7", "factory-issue": "4" } }),
    box({ id: "factory-noissue", tags: { factory: "objective", "factory-repo": "7" } }),
  ];
  assert.deepEqual(objectiveSandboxes(listed, 7).map((s) => s.id), ["factory-aaa"]);
  assert.equal(usageTarball(rec()), "/home/factory/factory/out/usage-c1.tgz");
});

test("lost events: CI finished for the head a stage waits on; a Question answered with no launch", () => {
  const waiting = { stage: "work", waiting: "checks", head: "abc", at: "2026-11-20T11:50:00Z", launches: [] };
  const grace = { graceMs: 3 * 60_000, now: NOW };
  assert.equal(checksResume(waiting, { headSha: "abc", checksDone: true, ...grace }), true);
  assert.equal(checksResume(waiting, { headSha: "def", checksDone: true, ...grace }), false, "the branch moved on");
  assert.equal(checksResume(waiting, { headSha: "abc", checksDone: false, ...grace }), false, "CI still running");
  assert.equal(checksResume({ ...waiting, at: "2026-11-20T11:59:00Z" }, { headSha: "abc", checksDone: true, ...grace }), false, "the event's own launch gets the grace");
  assert.deepEqual(launchDecision({ ev: { kind: "swept" }, state: "Running", record: waiting, headSha: "abc", checksDone: true, runningSince: "2026-11-20T10:00:00Z" }), { stage: "work" });
  assert.equal(launchDecision({ ev: { kind: "swept" }, state: "Running", record: { ...waiting, launches: [{ ok: true, stage: "work", at: "2026-11-20T10:01:00Z" }] }, headSha: "abc", checksDone: false, runningSince: "2026-11-20T10:00:00Z" }).skip, "work already started for this Running stint");
  const asked = "2026-11-20T10:00:00Z";
  assert.ok(missedAnswer([{ created_at: "2026-11-20T11:00:00Z" }], { questionSince: asked, now: NOW, graceMs: 180_000 }));
  assert.equal(missedAnswer([{ created_at: "2026-11-20T09:00:00Z" }], { questionSince: asked, now: NOW, graceMs: 180_000 }), null, "said before the Question");
  assert.equal(missedAnswer([{ created_at: "2026-11-20T11:59:00Z" }], { questionSince: asked, now: NOW, graceMs: 180_000 }), null, "its own launch gets the grace");
  assert.equal(missedAnswer([{ created_at: "2026-11-20T11:00:00Z" }], { questionSince: null, now: NOW, graceMs: 180_000 }), null);
});

test("workflow template: the sweep job, hourly or by hand, with three usage upload slots", () => {
  const template = readFileSync(join(import.meta.dirname, "..", "workflow-template.yml"), "utf8");
  const doc = parseYaml(renderWorkflow(template, { harness: "claude", runs_on: "ubuntu-latest", action: "clockgrove/factory@v1.2.3", sandbox: "vercel", ci_workflow: "Quality", default_branch: "main" }));
  const job = doc.jobs.sweep;
  assert.ok(doc.on.schedule.some((s) => s.cron === "17 * * * *"));
  assert.ok(job.if.includes("github.event.schedule == '17 * * * *'"));
  assert.ok(job.if.includes("github.event.action == 'labeled' && github.event.label.name == 'factory:blocked'"), "a Block runs the sweep at once");
  assert.deepEqual(job.permissions, { contents: "read" });
  assert.equal(job.steps.filter((s) => String(s.uses).startsWith("actions/upload-artifact")).length, 3);
  assert.equal(String(doc.env.FACTORY_SANDBOX_IDLE_DAYS), "7");
  assert.equal(String(doc.env.FACTORY_SWEEP_MAX_DESTROYS), "5");
  assert.doesNotMatch(renderWorkflow(template, { harness: "claude", runs_on: "ubuntu-latest", action: "clockgrove/factory@v1.2.3" }), /mode: sweep|17 \* \* \* \*|FACTORY_SWEEP/);
});

// The sweep against an in-memory GitHub (fixtures/github-records.mjs, behind fetch) and a fake vendor: one Objective, #7.
// `hooks(store)` returns adapter calls to replace: store.record() reads the claim comment now, store.write(rec) replaces it.
async function sweepOne({ issue, record, sandbox, hooks = () => ({}) }) {
  const { githubStore, BOT, REPO } = await import("./fixtures/github-records.mjs");
  const { recordBody } = await import("../scripts/launch.mjs");
  const { sweep } = await import("../scripts/sweep.mjs");
  const { VERCEL_RATES } = await import("../scripts/lib/adapters/sandbox-vercel.mjs");
  const { marker, sandboxRecordOf, setSelf } = await import("../scripts/lib/logic.mjs");
  const N = 7;
  const s = githubStore({ seed: 5, maxTicks: 2 });
  s.put(N, `${marker(N, "sandbox")}\n${recordBody(record)}`);
  const calls = [];
  const box = { id: "factory-aaa", state: "running", createdAt: new Date(Date.now() - 3 * 3600_000).toISOString(), tags: { factory: "objective", "factory-repo": "1", "factory-issue": String(N) }, ...sandbox };
  const adapter = {
    rates: VERCEL_RATES,
    list: async () => [box],
    stop: async (id) => (calls.push(`stop ${id}`), (box.state = "stopped")),
    usage: async (id) => (calls.push(`usage ${id}`), { wallMs: 40 * 60_000, activeCpuMs: 60_000, memoryMb: 4096, vcpus: 2, storedBytes: 0 }),
    readFile: async () => null,
    destroy: async (id) => calls.push(`destroy ${id}`),
  };
  const head = marker(N, "sandbox");
  const id = [...s.comments.values()].find((c) => c.body.startsWith(`${head}\n`)).id;
  Object.assign(adapter, hooks({ calls, record: () => sandboxRecordOf(s.bodyOf(N, head)), write: (rec) => s.api.rest(`repos/${REPO.full}/issues/comments/${id}`, { method: "PATCH", body: { body: `${head}\n${recordBody(rec)}` } }) }));
  const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  const realFetch = globalThis.fetch;
  const saved = { api: process.env.GITHUB_API_URL, gql: process.env.GITHUB_GRAPHQL_URL };
  process.env.GITHUB_API_URL = "https://github.test";
  delete process.env.GITHUB_GRAPHQL_URL;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    if (u.pathname === "/graphql") {
      if (/projectsV2/.test(body.query)) return json({ data: { repository: { id: "R_1", projectsV2: { nodes: [] } }, repositoryOwner: null } });
      return s.api.graphql(body.query, body.variables).then((data) => json({ data }), (e) => json({ errors: [{ message: e.message }] }));
    }
    if (method === "GET" && u.pathname === `/repos/${REPO.full}/issues/${N}`) return json({ number: N, ...issue });
    return s.api.rest(`${u.pathname.slice(1)}${u.search}`, { method, body }).then((r) => json(r), (e) => json({ message: e.message }, e.status || 500));
  };
  setSelf(BOT.login);
  try {
    const r = await sweep({ adapter, repo: REPO, repoId: "1", opts: {}, idleDays: 7, maxDestroys: 5, staleMs: 60 * 60_000, collectRoot: process.env.TMPDIR, harness: "claude", images: false });
    const vendor = [...s.comments.values()].find((c) => c.body.startsWith(`<!-- factory:${N}:vendor:work:`));
    return { r, calls, rec: sandboxRecordOf(s.bodyOf(N, marker(N, "sandbox"))), vendor };
  } finally {
    globalThis.fetch = realFetch;
    for (const [k, v] of [["GITHUB_API_URL", saved.api], ["GITHUB_GRAPHQL_URL", saved.gql]]) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
    setSelf(null);
  }
}

test("sweep: a Block for a vanished stage stops its running sandbox, books its cost and records it stopped; a live lease is left alone", async () => {
  const ago = (m) => new Date(Date.now() - m * 60_000).toISOString();
  const blocked = { state: "open", labels: [{ name: "factory:objective" }, { name: "factory:blocked" }] };
  // #502's record (factory-scratch, 2026-11-11): started, then died; the lease ran out and the dispatcher Blocked it.
  const started = { vendor: "vercel", stage: "work", event: "issues", run: "1", home: "/vercel", id: "factory-aaa", state: "running", at: ago(60), leaseUntil: ago(50), claim: "cd737cfa9cec", launches: [{ stage: "work", event: "issues", ok: true, run: "1", cue: "stint-1", at: ago(60) }], meter: { base: null, created: true, ceilingUsd: 0.603515, stored: { ms: 0, bytes: null }, vcpus: 2 }, sessionEnd: ago(-45) };

  const v = await sweepOne({ issue: blocked, record: started });
  assert.deepEqual(v.r.results.map((x) => [x.action, x.reason]), [["stopped", "running with no stage holding it, the Objective Blocked"]]);
  assert.deepEqual(v.calls, ["stop factory-aaa", "usage factory-aaa"], "stopped, then its totals read; never destroyed");
  assert.equal(v.rec.state, "stopped");
  assert.equal(v.rec.id, "factory-aaa", "the stopped sandbox stays for the Objective's next stage");
  assert.equal(v.rec.leaseUntil, null);
  assert.ok(Date.parse(v.rec.stoppedAt), "its stop time, for the next stage's storage");
  assert.deepEqual([v.rec.stage, v.rec.claim], ["work", "cd737cfa9cec"], "the stage's own claim is put back");
  assert.equal(v.rec.vendorBooked, true);
  assert.ok(Number.isFinite(v.rec.vendorUsd) && v.rec.vendorUsd > 0);
  assert.ok(v.vendor, "the vendor comment daily_usd reads is written");
  assert.equal(v.r.usage.length, 1, "its usage record goes up with the sweep job");

  const live = await sweepOne({ issue: blocked, record: { ...started, leaseUntil: ago(-5) } });
  assert.deepEqual(live.r.results.map((x) => [x.action, x.reason]), [["kept", "a stage holds it"]]);
  assert.deepEqual(live.calls, []);
  assert.equal(live.rec.state, "running");

  // A launcher cut off after its claim (no start): the attempt is stored as a timeout, and the sweep's writes keep it.
  const cutOff = { vendor: "vercel", stage: "work", event: "issues", run: "5", id: "factory-aaa", state: "running", at: ago(30), claimedAt: ago(30), leaseUntil: ago(20), claim: "aaaaaaaaaaaa", launches: [] };
  const closed = await sweepOne({ issue: { state: "closed", labels: [{ name: "factory:objective" }] }, record: cutOff });
  assert.deepEqual(closed.calls, ["destroy factory-aaa"]);
  assert.deepEqual(closed.rec.launches.map((l) => [l.ok, l.code]), [[false, "timeout"]], "every launch attempt ends as a stored entry");
  assert.deepEqual([closed.rec.state, closed.rec.id, closed.rec.stage, closed.rec.claim], ["stopped", null, "work", "aaaaaaaaaaaa"]);
});

test("sweep review fixes: its claim holds against a launcher, a lost claim stops nothing, a stop error clears, an interrupted sweep's stage is never restored as the stage's", async () => {
  const { launchDecision, stageHolds } = await import("../scripts/lib/logic.mjs");
  const ago = (m) => new Date(Date.now() - m * 60_000).toISOString();
  const blocked = { state: "open", labels: [{ name: "factory:objective" }, { name: "factory:blocked" }] };
  const started = { vendor: "vercel", stage: "work", event: "issues", run: "1", home: "/vercel", id: "factory-aaa", state: "running", at: ago(60), leaseUntil: ago(50), claim: "cd737cfa9cec", launches: [{ stage: "work", event: "issues", ok: true, run: "1", cue: "stint-1", at: ago(60) }] };

  // The sweep's claim, as a launcher reads it while the sweep stops the sandbox: held, so nothing starts in it.
  let seen = null;
  await sweepOne({
    issue: blocked,
    record: started,
    hooks: (st) => ({
      stop: async (id) => {
        const r = st.record();
        seen = { holds: stageHolds(r, Date.now(), 60 * 60_000), decision: launchDecision({ ev: { kind: "swept" }, state: "Running", record: r, runningSince: ago(1), staleMs: 3600_000 }) };
        st.calls.push(`stop ${id}`);
      },
    }),
  });
  assert.equal(seen?.holds, true, "the sweep's claim carries a live lease of its own");
  assert.ok(seen.decision.skip, "a launcher starts nothing over it");

  // A collection that ran past the claim's lease: the stop still gets a fresh window, and a launcher reading then skips.
  let late = null;
  await sweepOne({
    issue: blocked,
    record: started,
    hooks: (st) => ({
      readFile: async () => (await st.write({ ...st.record(), leaseUntil: ago(1) }), null),
      stop: async (id) => {
        const r = st.record();
        late = { holds: stageHolds(r, Date.now(), 60 * 60_000), decision: launchDecision({ ev: { kind: "swept" }, state: "Running", record: r, runningSince: ago(1), staleMs: 3600_000 }) };
        st.calls.push(`stop ${id}`);
      },
    }),
  });
  assert.equal(late?.holds, true, "the claim's lease is renewed right before the stop");
  assert.ok(late.decision.skip, "a launcher still starts nothing");

  // A launcher's claim that lands after the sweep's (between its claim and its stop): the sweep stops nothing.
  const lost = await sweepOne({
    issue: blocked,
    record: started,
    hooks: (st) => ({ readFile: async () => (await st.write({ ...st.record(), stage: "work", claim: "bbbbbbbbbbbb", state: "running", at: ago(0), leaseUntil: ago(-10) }), null) }),
  });
  assert.deepEqual(lost.calls, [], "the new stage's sandbox is not stopped");
  assert.equal(lost.r.results[0].action, "skipped");
  assert.equal(lost.rec.claim, "bbbbbbbbbbbb");

  // An earlier stop that failed: this one clears its error, so the next start books the stopped stretch.
  const failedStop = await sweepOne({ issue: blocked, record: { ...started, state: "stopped", stopError: "error", leaseUntil: null, collected: true, vendorBooked: true } });
  assert.deepEqual(failedStop.calls, ["stop factory-aaa"]);
  assert.equal(failedStop.rec.stopError, undefined);
  assert.ok(Date.parse(failedStop.rec.stoppedAt));

  // A claim an interrupted sweep left: the stage and claim it kept go back, else the last start's stage; never "sweep".
  const left = { ...started, stage: "sweep", claim: "sweep-0123456789ab", at: ago(30), leaseUntil: ago(20) };
  const kept = await sweepOne({ issue: blocked, record: { ...left, prior: { stage: "work", claim: "cd737cfa9cec" } } });
  assert.deepEqual([kept.rec.state, kept.rec.stage, kept.rec.claim, kept.rec.prior], ["stopped", "work", "cd737cfa9cec", undefined]);
  const bare = await sweepOne({ issue: blocked, record: left });
  assert.deepEqual([bare.rec.state, bare.rec.stage], ["stopped", "work"]);
  assert.ok(!String(bare.rec.claim).startsWith("sweep-"), "no sweep's claim is taken for the stage's");
});

test("sweep: a stage that said it ended moments ago is left to the launcher's end (one usage upload)", () => {
  const ended = rec({ state: "ended", at: new Date(NOW - 2 * 60_000).toISOString(), collected: undefined });
  const d = { ...base, state: "Blocked", sandbox: box({ state: "running" }), record: ended };
  assert.equal(sweepDecision(d).keep, "its stage ended moments ago; the launcher's end answers it");
  assert.equal(sweepDecision({ ...d, record: { ...ended, at: new Date(NOW - 20 * 60_000).toISOString() } }).stop, "running with no stage holding it, the Objective Blocked", "an end whose event was lost is the sweep's after the grace");
});
