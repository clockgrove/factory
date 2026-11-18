import "./temp.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { launchDecision, pickSandbox, sandboxTags, stateOf, sweepDecision } from "../scripts/lib/logic.mjs";
import { objectiveSandboxes, usageTarball } from "../scripts/sweep.mjs";

const NOW = Date.parse("2026-11-20T12:00:00Z");
const DAY = 86_400_000;
const box = (over = {}) => ({ id: "pendulum-aaa", state: "stopped", createdAt: "2026-11-01T00:00:00Z", tags: { pendulum: "objective", "pendulum-repo": "7", "pendulum-issue": "4" }, ...over });
const rec = (over = {}) => ({ id: "pendulum-aaa", state: "stopped", stage: "work", at: "2026-11-10T00:00:00Z", claim: "c1", home: "/home/pendulum", collected: true, ...over });
const open = { state: "open" };
const base = { sandbox: box(), issue: open, state: "Question", record: rec(), holds: false, now: NOW, idleMs: 7 * DAY, graceMs: 15 * 60_000 };

test("sweep: which Objective sandboxes go", () => {
  assert.deepEqual(sweepDecision({ ...base, issue: { state: "closed" } }), { destroy: "its Objective is closed", collect: false });
  assert.deepEqual(sweepDecision({ ...base, issue: { state: "closed" }, record: rec({ collected: false }) }), { destroy: "its Objective is closed", collect: true }, "its usage comes out first");
  assert.equal(sweepDecision({ ...base, issue: null }).destroy, "its Objective is closed", "no issue by that number");
  assert.equal(sweepDecision({ ...base, record: rec({ id: "pendulum-bbb" }) }).destroy, "its Objective's record names another sandbox");
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

test("sweep: only Pendulum's Objective sandboxes for this repository are listed; never an image sandbox", () => {
  const listed = [
    box(),
    box({ id: "pendulum-img", tags: { pendulum: "image", "pendulum-image": "7", sha: "a".repeat(40), snapshot: "snap_x" } }),
    box({ id: "pendulum-other", tags: { pendulum: "objective", "pendulum-repo": "8", "pendulum-issue": "4" } }),
    box({ id: "someone-else", tags: { pendulum: "objective", "pendulum-repo": "7", "pendulum-issue": "4" } }),
    box({ id: "pendulum-noissue", tags: { pendulum: "objective", "pendulum-repo": "7" } }),
  ];
  assert.deepEqual(objectiveSandboxes(listed, 7).map((s) => s.id), ["pendulum-aaa"]);
  assert.equal(usageTarball(rec()), "/home/pendulum/pendulum/out/usage-c1.tgz");
});

// The sweep against an in-memory GitHub (fixtures/github-records.mjs, behind fetch) and a fake vendor: one Objective, #7.
// `hooks(store)` returns adapter calls to replace: store.record() reads the claim comment now, store.write(rec) replaces it.
// `card`: the Objective's card on a Pendulum board (its Status), or none (no board).
async function sweepOne({ issue, record, sandbox, card = null, hooks = () => ({}), seal = undefined }) {
  const { githubStore, BOT, REPO } = await import("./fixtures/github-records.mjs");
  const { recordBody } = await import("../scripts/launch.mjs");
  const { sweep } = await import("../scripts/sweep.mjs");
  const { VERCEL_RATES } = await import("../scripts/lib/adapters/sandbox-vercel.mjs");
  const { marker, sandboxRecordOf, setSelf } = await import("../scripts/lib/logic.mjs");
  const N = 7;
  const s = githubStore({ seed: 5, maxTicks: 2 });
  s.put(N, `${marker(N, "sandbox")}\n${recordBody(record)}`);
  const calls = [];
  const box = { id: "pendulum-aaa", state: "running", createdAt: new Date(Date.now() - 3 * 3600_000).toISOString(), tags: { pendulum: "objective", "pendulum-repo": "1", "pendulum-issue": String(N) }, ...sandbox };
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
      const board = { id: "P_1", title: "Pendulum", number: 1, field: { id: "F_1", options: ["Queued", "Running", "In review", "Blocked", "Done"].map((name) => ({ id: name, name })) } };
      if (/projectsV2/.test(body.query)) return json({ data: { repository: { id: "R_1", projectsV2: { nodes: card ? [board] : [] } }, repositoryOwner: null } });
      if (/projectItems/.test(body.query)) return json({ data: { repository: { i0: { number: N, projectItems: { nodes: card ? [{ project: { id: board.id }, fieldValueByName: { name: card } }] : [] } } } } });
      return s.api.graphql(body.query, body.variables).then((data) => json({ data }), (e) => json({ errors: [{ message: e.message }] }));
    }
    if (method === "GET" && u.pathname === `/repos/${REPO.full}/issues/${N}`) return json({ number: N, ...issue });
    return s.api.rest(`${u.pathname.slice(1)}${u.search}`, { method, body }).then((r) => json(r), (e) => json({ message: e.message }, e.status || 500));
  };
  setSelf(BOT.login);
  try {
    const r = await sweep({ adapter, repo: REPO, repoId: "1", opts: {}, idleDays: 7, maxDestroys: 5, staleMs: 60 * 60_000, collectRoot: process.env.TMPDIR, harness: "claude", images: false, seal });
    const vendor = [...s.comments.values()].find((c) => c.body.startsWith(`<!-- pendulum:${N}:vendor:work:`));
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
  const blocked = { state: "open", labels: [{ name: "pendulum:objective" }, { name: "pendulum:blocked" }] };
  // #502's record (the scratch repository, 2026-11-11): started, then died; the lease ran out and the dispatcher Blocked it.
  const started = { vendor: "vercel", stage: "work", event: "issues", run: "1", home: "/vercel", id: "pendulum-aaa", state: "running", at: ago(60), leaseUntil: ago(50), claim: "cd737cfa9cec", launches: [{ stage: "work", event: "issues", ok: true, run: "1", cue: "stint-1", at: ago(60) }], meter: { base: null, created: true, ceilingUsd: 0.603515, stored: { ms: 0, bytes: null }, vcpus: 2 }, sessionEnd: ago(-45) };

  const v = await sweepOne({ issue: blocked, record: started });
  assert.deepEqual(v.r.results.map((x) => [x.action, x.reason]), [["stopped", "running with no stage holding it, the Objective Blocked"]]);
  assert.deepEqual(v.calls, ["stop pendulum-aaa", "usage pendulum-aaa"], "stopped, then its totals read; never destroyed");
  assert.equal(v.rec.state, "stopped");
  assert.equal(v.rec.id, "pendulum-aaa", "the stopped sandbox stays for the Objective's next stage");
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
  const cutOff = { vendor: "vercel", stage: "work", event: "issues", run: "5", id: "pendulum-aaa", state: "running", at: ago(30), claimedAt: ago(30), leaseUntil: ago(20), claim: "aaaaaaaaaaaa", launches: [] };
  const closed = await sweepOne({ issue: { state: "closed", labels: [{ name: "pendulum:objective" }] }, record: cutOff });
  assert.deepEqual(closed.calls, ["destroy pendulum-aaa"]);
  assert.deepEqual(closed.rec.launches.map((l) => [l.ok, l.code]), [[false, "timeout"]], "every launch attempt ends as a stored entry");
  assert.deepEqual([closed.rec.state, closed.rec.id, closed.rec.stage, closed.rec.claim], ["stopped", null, "work", "aaaaaaaaaaaa"]);
});

test("sweep: a sandbox stage's uncollected usage goes up with its stream and sessions sealed on a public repository, readable on a private one (#490)", async () => {
  const { execFileSync } = await import("node:child_process");
  const { generateKeyPairSync } = await import("node:crypto");
  const { mkdirSync, mkdtempSync, readdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { SEALED_FILE, openSealed, sealKey, usageSeal } = await import("../scripts/lib/seal.mjs");
  const ago = (m) => new Date(Date.now() - m * 60_000).toISOString();
  // The stage's usage directory as stage.mjs packs it in the sandbox (`<home>/pendulum/out/usage-<claim>.tgz`).
  const stage = mkdtempSync(join(tmpdir(), "stage-usage-"));
  mkdirSync(join(stage, "transcript", "proj"), { recursive: true });
  writeFileSync(join(stage, "transcript", "proj", "s1.jsonl"), "the agent read: internal-design-notes\n");
  writeFileSync(join(stage, "events.jsonl"), '{"type":"system","subtype":"init","session_id":"s1"}\n{"type":"user","message":"the agent read: internal-design-notes"}\n');
  writeFileSync(join(stage, "result.json"), JSON.stringify({ harness: "claude", usd: 0.5, session: { harness: "claude", id: "s1", files: ["proj/s1.jsonl"], checkout: "/c" } }));
  const tgz = execFileSync("tar", ["czf", "-", "-C", stage, "."]);
  const blocked = { state: "open", labels: [{ name: "pendulum:objective" }, { name: "pendulum:blocked" }] };
  const started = { vendor: "vercel", stage: "work", event: "issues", run: "1", home: "/vercel", id: "pendulum-aaa", state: "running", at: ago(60), leaseUntil: ago(50), claim: "cd737cfa9cec", launches: [{ stage: "work", event: "issues", ok: true, run: "1", cue: "stint-1", at: ago(60) }], meter: { base: null, created: true, ceilingUsd: 0.603515, stored: { ms: 0, bytes: null }, vcpus: 2 }, sessionEnd: ago(-45) };
  const pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" });
  const key = sealKey(pem, "acme/app");
  const run = (payload) => sweepOne({ issue: blocked, record: started, hooks: () => ({ readFile: async (id, path) => (path === "/vercel/pendulum/out/usage-cd737cfa9cec.tgz" ? tgz : null) }), seal: usageSeal({ key, publish: "", payload }) });

  const pub = await run({ repository: { private: false } });
  const [u] = pub.r.usage;
  assert.deepEqual(readdirSync(u.dir).sort(), ["result.json", SEALED_FILE], "no events.jsonl, no transcript/");
  assert.deepEqual(JSON.parse(readFileSync(join(u.dir, "result.json"), "utf8")).sessions, { calls: 1, sessions: 1 });
  assert.equal((await openSealed(u.dir, key, { bind: { issue: 7, stage: "review" } })).ok, false, "bound to its stage");
  assert.deepEqual(await openSealed(u.dir, key, { bind: { issue: 7, stage: "work" } }), { ok: true }, "the work job's key opens it for a resume");
  assert.match(readFileSync(join(u.dir, "transcript", "proj", "s1.jsonl"), "utf8"), /internal-design-notes/);
  const priv = await run({ repository: { private: true } });
  assert.deepEqual(readdirSync(priv.r.usage[0].dir).sort(), ["events.jsonl", "result.json", "transcript"]);
});

test("sweep: a Question whose card sits in In review is stopped and booked like a Block, then destroyed after its idle days (#57)", async () => {
  const ago = (m) => new Date(Date.now() - m * 60_000).toISOString();
  // the scratch repository's #372/#397: pendulum:question, no pendulum:in-review, the card still In review (applyExit puts a Question there).
  const question = { state: "open", labels: [{ name: "pendulum:objective" }, { name: "pendulum:question" }] };
  const ended = { vendor: "vercel", stage: "work", event: "issues", run: "1", home: "/vercel", id: "pendulum-aaa", state: "ended", at: ago(60), leaseUntil: ago(50), claim: "cd737cfa9cec", launches: [{ stage: "work", event: "issues", ok: true, run: "1", cue: "stint-1", at: ago(90) }], meter: { base: null, created: true, ceilingUsd: 0.603515, stored: { ms: 0, bytes: null }, vcpus: 2 }, sessionEnd: ago(-45) };

  const q = await sweepOne({ issue: question, record: ended, card: "In review" });
  assert.deepEqual(q.r.results.map((x) => [x.action, x.reason]), [["stopped", "running with no stage holding it, the Objective Question"]]);
  assert.deepEqual(q.calls, ["stop pendulum-aaa", "usage pendulum-aaa"], "stopped, then its totals read; never destroyed");
  assert.deepEqual([q.rec.state, q.rec.id, q.rec.stage, q.rec.claim, q.rec.leaseUntil], ["stopped", "pendulum-aaa", "work", "cd737cfa9cec", null], "the stage's own record, stopped and unleased");
  assert.equal(q.rec.vendorBooked, true);
  assert.ok(q.vendor, "the vendor comment daily_usd reads is written");
  // The answer resumes the stage from the stopped sandbox: the answer requeues it, and the next start picks that sandbox.
  assert.ok(launchDecision({ ev: { kind: "comment", issue: 7, human: true }, state: stateOf(question, "In review"), trusted: true }).requeue);
  assert.equal(pickSandbox([{ id: "pendulum-aaa", state: "stopped", tags: sandboxTags("1", 7) }], { repoId: "1", issue: 7, recordedId: q.rec.id }), "pendulum-aaa");

  const idle = await sweepOne({ issue: question, record: { ...ended, state: "stopped", at: ago(8 * 1440), leaseUntil: null, vendorBooked: true }, sandbox: { state: "stopped" }, card: "In review" });
  assert.deepEqual(idle.r.results.map((x) => [x.action, x.reason]), [["destroyed", "stopped 8 days, the Objective Question"]]);
  assert.deepEqual(idle.calls, ["destroy pendulum-aaa"]);

  const live = await sweepOne({ issue: question, record: { ...ended, state: "running", leaseUntil: ago(-5) }, card: "In review" });
  assert.deepEqual(live.r.results.map((x) => [x.action, x.reason]), [["kept", "a stage holds it"]], "a live lease is never stopped");
  assert.deepEqual(live.calls, []);

  const review = await sweepOne({ issue: { state: "open", labels: [{ name: "pendulum:objective" }, { name: "pendulum:in-review" }] }, record: ended, card: "In review" });
  assert.deepEqual(review.r.results.map((x) => [x.action, x.reason]), [["kept", "the Objective is In review"]], "a delivered Objective In review keeps its sandbox");
});

test("sweep review fixes: its claim holds against a launcher, a lost claim stops nothing, a stop error clears, an interrupted sweep's stage is never restored as the stage's", async () => {
  const { stageHolds } = await import("../scripts/lib/logic.mjs");
  const ago = (m) => new Date(Date.now() - m * 60_000).toISOString();
  const blocked = { state: "open", labels: [{ name: "pendulum:objective" }, { name: "pendulum:blocked" }] };
  const started = { vendor: "vercel", stage: "work", event: "issues", run: "1", home: "/vercel", id: "pendulum-aaa", state: "running", at: ago(60), leaseUntil: ago(50), claim: "cd737cfa9cec", launches: [{ stage: "work", event: "issues", ok: true, run: "1", cue: "stint-1", at: ago(60) }] };

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
  assert.deepEqual(failedStop.calls, ["stop pendulum-aaa"]);
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
