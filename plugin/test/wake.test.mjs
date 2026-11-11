import "./temp.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RETRY_WAKE_MS, WAKE_KINDS, WAKE_SLACK_MS, marker, nextUtcMidnight, nextWake, parseWake, sandboxMarkerLine, setSelf, wakeKinds } from "../scripts/lib/logic.mjs";

const T = Date.parse("2026-11-10T12:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();
const min = 60_000;

test("nextWake: the earliest sleeper deadline still ahead; owners' kinds, past ones and covered ones arm nothing", () => {
  const deadlines = [
    { issue: 4, kind: "launch-grace", at: iso(T + 1 * min) },
    { issue: 5, kind: "quota", at: iso(T + 7 * min) },
    { issue: 6, kind: "lease", at: iso(T + 4 * min) },
    { issue: 7, kind: "lease", at: iso(T - 1 * min) },
    { issue: null, kind: "daily-cap", at: iso(nextUtcMidnight(T)) },
  ];
  assert.deepEqual(nextWake(deadlines, { now: T }), { kind: "lease", at: iso(T + 4 * min), issue: 6 });
  assert.equal(nextWake([{ kind: "answer-grace", at: iso(T + min) }, { kind: "lease", at: iso(T - min) }], { now: T }), null, "only WAKE_KINDS, only ahead");
  // A wake already queued or sleeping covers a deadline it fires before, or within the slack after.
  assert.equal(nextWake(deadlines, { now: T, armed: [{ kind: "quota", at: iso(T + 2 * min) }] }), null);
  assert.equal(nextWake(deadlines, { now: T, armed: [{ kind: "quota", at: iso(T + 4 * min + WAKE_SLACK_MS) }] }), null);
  assert.equal(nextWake(deadlines, { now: T, armed: [{ kind: "quota", at: iso(T + 4 * min + WAKE_SLACK_MS + 1000) }] })?.issue, 6, "a later sleeper does not cover it");
  assert.equal(nextWake(deadlines, { now: T, armed: [{ kind: "lease", at: iso(T - 30_000) }] })?.issue, 6, "one already past its deadline (firing, or this run's own) covers nothing");
  assert.deepEqual(WAKE_KINDS, ["lease", "quota", "daily-cap", "retry"]);
  // A private repository sleeps only to the short waits: the lease and the day's turn wait for events and the cron.
  assert.deepEqual(wakeKinds(true), WAKE_KINDS);
  for (const v of [false, null, undefined]) assert.deepEqual(wakeKinds(v), ["quota", "retry"], `visibility ${v}`);
  assert.deepEqual(nextWake(deadlines, { now: T, kinds: wakeKinds(false) }), { kind: "quota", at: iso(T + 7 * min), issue: 5 });
  assert.equal(nextWake([{ kind: "daily-cap", at: iso(nextUtcMidnight(T)) }, { kind: "lease", at: iso(T + min) }], { now: T, kinds: wakeKinds(false) }), null);
});

test("nextWake: a wake's own run never re-arms its deadline, and a retry is armed once", () => {
  const lease = { issue: 6, kind: "lease", at: iso(T + 30_000) };
  // A runner clock behind the sleeper's: the same deadline reads as ahead; it is not armed again.
  assert.equal(nextWake([lease], { now: T, firedBy: { kind: "lease", at: lease.at } }), null);
  // Another Objective's lease half a minute later is its own deadline.
  assert.equal(nextWake([lease, { issue: 8, kind: "lease", at: iso(T + 60_000) }], { now: T, firedBy: { kind: "lease", at: lease.at } })?.issue, 8);
  const retry = { issue: null, kind: "retry", at: iso(T + RETRY_WAKE_MS) };
  assert.equal(nextWake([retry], { now: T })?.kind, "retry");
  assert.equal(nextWake([retry], { now: T, firedBy: { kind: "retry", at: iso(T - 1000) } }), null, "a read that keeps failing waits for an event or the cron");
});

test("parseWake and nextUtcMidnight: job names and tick inputs read strictly; the UTC day's turn", () => {
  assert.deepEqual(parseWake("wake (lease 2026-11-10T12:04:00.000Z)"), { kind: "lease", at: "2026-11-10T12:04:00.000Z" });
  assert.deepEqual(parseWake("daily-cap 2026-11-11T00:00:00.000Z"), { kind: "daily-cap", at: "2026-11-11T00:00:00.000Z" });
  for (const bad of ["wake ( )", "wake (lease)", "wake (nap 2026-11-10T12:04:00.000Z)", "lease 2026-11-10T12:04:00Z; rm -rf", "", null, "work (12)"]) assert.equal(parseWake(bad), null, String(bad));
  assert.equal(iso(nextUtcMidnight(T)), "2026-11-11T00:00:00.000Z");
  assert.equal(iso(nextUtcMidnight(Date.parse("2026-12-31T23:59:59Z"))), "2027-01-01T00:00:00.000Z");
});

test("armWake: reads the armed wakes only when one is due; an unreadable list arms anyway; firedByWake reads the tick's input", async () => {
  const { armWake, firedByWake } = await import("../scripts/dispatch.mjs");
  const repo = { owner: "acme", name: "app", full: "acme/app" };
  const now = T;
  let reads = 0;
  const readJobs = async () => {
    reads += 1;
    return { wakes: [{ kind: "quota", at: iso(T + 3 * min) }] };
  };
  assert.equal(await armWake(repo, [{ kind: "checks-grace", at: iso(T + min) }], { now, isPublic: true, readJobs }), null);
  assert.equal(await armWake(repo, [{ issue: 2, kind: "lease", at: iso(T + min) }], { now, readJobs }), null, "a private repository (the default) leaves a lease to events and the cron");
  assert.equal(reads, 0, "no deadline of its kinds: no read");
  assert.equal(await armWake(repo, [{ issue: 2, kind: "lease", at: iso(T + 4 * min) }], { now, isPublic: true, readJobs }), null, "covered by the sleeper at +3 min");
  assert.equal((await armWake(repo, [{ issue: 2, kind: "lease", at: iso(T + 1 * min) }], { now, isPublic: true, readJobs }))?.at, iso(T + 1 * min), "it fires before the sleeper at +3 min");
  const failing = async () => {
    throw new Error("HTTP 502");
  };
  assert.equal((await armWake(repo, [{ issue: 2, kind: "lease", at: iso(T + 4 * min) }], { now, isPublic: true, readJobs: failing }))?.kind, "lease", "a second sleeper only ticks twice");
  assert.deepEqual(firedByWake("workflow_dispatch", { inputs: { wake: "quota 2026-11-10T12:07:00.000Z" } }), { kind: "quota", at: "2026-11-10T12:07:00.000Z" });
  assert.equal(firedByWake("workflow_dispatch", { inputs: { issue: "12" } }), null);
  assert.equal(firedByWake("schedule", { inputs: { wake: "quota 2026-11-10T12:07:00.000Z" } }), null);
});

test("repoIsPublic: the event's repository payload first; one read only when a long wait needs it; unknown is private", async () => {
  const { repoIsPublic } = await import("../scripts/dispatch.mjs");
  let reads = 0;
  const read = (r) => async () => {
    reads += 1;
    if (r instanceof Error) throw r;
    return r;
  };
  const lease = [{ kind: "lease", at: iso(T + min) }];
  assert.equal(await repoIsPublic({ repository: { private: false } }, lease, read({ private: true })), true);
  assert.equal(await repoIsPublic({ repository: { private: true } }, lease, read({ private: false })), false);
  assert.equal(reads, 0, "the payload answers: no read");
  assert.equal(await repoIsPublic({ schedule: "*/10 * * * *" }, [{ kind: "quota", at: iso(T + min) }], read({ private: false })), false);
  assert.equal(reads, 0, "only short waits: the answer changes nothing, so no read");
  assert.equal(await repoIsPublic({ schedule: "*/10 * * * *" }, lease, read({ private: false })), true);
  assert.equal(await repoIsPublic({}, lease, read(new Error("HTTP 502"))), false, "an unread repository counts as private");
  assert.equal(reads, 2);
});

test("longWaitCheck: a private repository is told its long waits fall back to the cron; a public one gets no line", async () => {
  const { longWaitCheck } = await import("../scripts/doctor.mjs");
  const line = longWaitCheck({ private: true });
  assert.equal(line.status, "PASS");
  assert.match(line.detail, /fall back to events and GitHub's cron/);
  assert.equal(longWaitCheck({ private: false }), null);
  assert.equal(longWaitCheck(null), null);
});

test("dispatch deadlines: a stage's lease, a quota retry and the UTC day's turn, or one retry when today's spend is unread", async () => {
  const { dispatch } = await import("../scripts/dispatch.mjs");
  const now = Date.now();
  const self = { login: "factory-app[bot]", type: "Bot" };
  setSelf(self.login);
  const iss = (number, labels) => ({ number, state: "open", labels: labels.map((name) => ({ name })), body: "", updated_at: iso(now), user: { login: "maintainer" } });
  const record = (n, rec) => ({ id: 100 + n, user: self, body: `${marker(n, "sandbox")}\n${sandboxMarkerLine(rec)}`, updated_at: iso(now) });
  const leaseUntil = iso(now + 5 * min);
  const retryAt = iso(now + 7 * min);
  const comments = {
    10: [record(10, { vendor: "vercel", stage: "work", state: "running", at: iso(now - min), leaseUntil, claim: "abc", launches: [] })],
    11: [record(11, { vendor: "vercel", stage: "work", state: "failed", at: iso(now - min), quota: { since: iso(now - 3 * min), tries: 1, retryAt }, launches: [] })],
  };
  const open = [iss(10, ["factory:objective", "factory:running"]), iss(11, ["factory:objective"]), iss(12, ["factory:objective"])];
  const spend = { id: 900, user: self, updated_at: iso(now), body: `<!-- factory:9:progress:x -->\n<!-- factory:spend {"usd":5} -->` };
  const tick = async ({ spendFails = false } = {}) => {
    const realFetch = globalThis.fetch;
    const saved = process.env.GITHUB_API_URL;
    process.env.GITHUB_API_URL = "https://github.test";
    globalThis.fetch = async (url, init = {}) => {
      const u = new URL(url);
      const method = init.method || "GET";
      const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
      if (method === "GET" && u.pathname === "/repos/acme/app/issues") return json(u.searchParams.get("state") === "closed" ? [] : open);
      if (method === "GET" && u.pathname === "/repos/acme/app/issues/comments") return spendFails ? json({ message: "Server Error" }, 500) : json([spend]);
      if (method === "GET" && /\/issues\/(\d+)\/comments$/.test(u.pathname)) return json(comments[Number(/\/issues\/(\d+)\//.exec(u.pathname)[1])] || []);
      if (method === "GET" && /\/issues\/\d+\/timeline$/.test(u.pathname)) return json([{ event: "labeled", label: { name: "factory:running" }, created_at: iso(now - 30 * min) }]);
      if (method === "GET" && u.pathname.endsWith("/collaborators")) return json([{ login: "maintainer" }]);
      if (method !== "GET") return json({}, 200);
      return json({ message: "Not Found" }, 404);
    };
    try {
      return await dispatch({ repo: "acme/app", objectiveLabel: "factory:objective", maxConcurrent: 3, dailyUsd: 1, ciChecks: [], timeoutMinutes: 60, sandbox: "vercel" }, { token: "t", now: new Date(now) });
    } finally {
      globalThis.fetch = realFetch;
      if (saved === undefined) delete process.env.GITHUB_API_URL;
      else process.env.GITHUB_API_URL = saved;
    }
  };
  const capped = await tick();
  assert.equal(capped.reason, "daily_usd reached");
  const kinds = (r) => r.deadlines.map((d) => `${d.kind}${d.issue ? ` #${d.issue}` : ""} ${d.at}`).sort();
  assert.deepEqual(kinds(capped), [`daily-cap ${iso(nextUtcMidnight(now))}`, `lease #10 ${iso(Date.parse(leaseUntil) + WAKE_SLACK_MS)}`, `quota #11 ${retryAt}`].sort());
  assert.deepEqual(nextWake(capped.deadlines, { now }), { kind: "lease", at: iso(Date.parse(leaseUntil) + WAKE_SLACK_MS), issue: 10 });
  // Today's spend unread: the cap counts as reached, but the day's turn is no deadline; one retry is.
  const unread = await tick({ spendFails: true });
  assert.deepEqual(unread.deadlines.filter((d) => d.kind === "retry" || d.kind === "daily-cap").map((d) => d.kind), ["retry"]);
  setSelf(null);
});

test("workflow template: the wake job sleeps to the dispatcher's deadline in no concurrency group, then ticks it with its deadline", async () => {
  const { renderWorkflow } = await import("../scripts/setup.mjs");
  const { parseYaml } = await import("../scripts/lib/yaml.mjs");
  const template = readFileSync(join(import.meta.dirname, "..", "workflow-template.yml"), "utf8");
  const values = { harness: "claude", runs_on: "ubuntu-latest", action: "clockgrove/factory@v1.2.3", ci_workflow: "Quality" };
  const action = parseYaml(readFileSync(join(import.meta.dirname, "..", "..", "action.yml"), "utf8")).outputs;
  for (const v of [values, { ...values, sandbox: "vercel", default_branch: "main" }]) {
    const doc = parseYaml(renderWorkflow(template, v));
    const wake = doc.jobs.wake;
    assert.equal(wake.concurrency, undefined, "a sleeper is never cancelled by a newer one");
    assert.match(wake.if, /needs\.dispatch\.outputs\.wake_at != ''/);
    assert.equal(wake.name, "wake (${{ needs.dispatch.outputs.wake_kind }} ${{ needs.dispatch.outputs.wake_at }})", "the name the dispatcher reads armed wakes from");
    assert.deepEqual(wake.permissions, { actions: "write" });
    assert.ok(Number(wake["timeout-minutes"]) * 60 > 21000, "the job outlives its longest sleep");
    const run = wake.steps[0].run;
    assert.match(run, /sleep 21000/);
    assert.match(run, /gh workflow run factory\.yml -f wake="\$WAKE_KIND \$WAKE_AT"/);
    assert.match(wake.steps[0].env.GH_REPO, /github\.repository/);
    assert.ok(doc.on.workflow_dispatch.inputs.wake, "the tick says which deadline it slept to");
    for (const k of ["wake_at", "wake_kind"]) {
      assert.match(doc.jobs.dispatch.outputs[k], new RegExp(`steps\\.f\\.outputs\\.${k}`));
      assert.ok(action[k], `the Action has an output ${k}`);
    }
  }
});

test("ownedTickCheck: an installed workflow without the dispatcher's own ticks is named, FAIL by hand and WARN in a run", async () => {
  const { ownedTickCheck } = await import("../scripts/doctor.mjs");
  const { renderWorkflow } = await import("../scripts/setup.mjs");
  const template = readFileSync(join(import.meta.dirname, "..", "workflow-template.yml"), "utf8");
  const values = { harness: "claude", runs_on: "ubuntu-latest", action: "clockgrove/factory@v1.2.3", ci_workflow: "Quality" };
  const sandbox = { ...values, sandbox: "vercel", default_branch: "main" };
  for (const v of [values, sandbox]) assert.equal(ownedTickCheck(renderWorkflow(template, v), {}).status, "PASS");
  // A runner workflow rendered before: no closed issue tick, no wake job.
  const old = renderWorkflow(template, values).replace("types: [opened, labeled, closed]", "types: [opened, labeled]").replace(/\n {2}wake:[\s\S]*?(?=\n {2}work:)/, "");
  const by = ownedTickCheck(old, {});
  assert.equal(by.status, "FAIL");
  assert.match(by.detail, /a dispatcher tick on a closed issue, the wake job/);
  assert.equal(ownedTickCheck(old, {}, { job: true }).status, "WARN", "a run never Blocks every Objective before the re-render");
  const sandboxOld = renderWorkflow(template, sandbox).replace(/steps\.f\.outcome != 'success' \|\| /g, "");
  assert.match(ownedTickCheck(sandboxOld, {}).detail, /the launch jobs' tick on a failed launch/);
});
