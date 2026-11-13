import "./temp.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { KEEP_LAUNCHES, RETRY_WAKE_MS, START_LOST_MS, START_RETRY_MS, WAKE_KINDS, WAKE_MAX_SLEEP_S, WAKE_SLACK_MS, failedSince, inFlightUntil, launchDecision, marker, nextUtcMidnight, nextWake, parseWake, sandboxMarkerLine, sandboxRecordOf, setSelf, settleStale, startBackoffMs, startFailures, startRetryAt, transientHold, SWEEP_WAKE_KINDS, wakeFiresAt, wakeKinds } from "../scripts/lib/logic.mjs";
import { recordBody, writeSandboxRecord } from "../scripts/launch.mjs";
import { BASE, BOT, REPO, githubStore } from "./fixtures/github-records.mjs";
import { RETRY } from "../scripts/lib/github.mjs";

// The fakes here fail some GitHub reads for good: the client's retries (#168) go at once, not after real backoff waits.
RETRY.sleep = async () => {};

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
  assert.deepEqual(WAKE_KINDS, ["lease", "quota", "start-retry", "daily-cap", "retry", "sweep"]);
  // A private repository sleeps only to the short waits: the lease and the day's turn wait for events and the cron.
  assert.deepEqual(wakeKinds(true), ["lease", "quota", "start-retry", "daily-cap", "retry"], "the sweep's and the image's kinds are theirs, not the dispatcher's");
  for (const v of [false, null, undefined]) assert.deepEqual(wakeKinds(v), ["quota", "start-retry", "retry"], `visibility ${v}`);
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
  assert.match(ownedTickCheck(sandboxOld, {}).detail, /the launch jobs' tick on a failed or deferred launch/);
  // A workflow from before `deferred`: a transient start retried in place would wait for the cron. Doctor names the stall.
  const beforeDeferred = ownedTickCheck(renderWorkflow(template, sandbox).replace(/ \|\| steps\.f\.outputs\.exit == 'deferred'/g, ""), {});
  assert.equal(beforeDeferred.status, "FAIL");
  assert.match(beforeDeferred.detail, /stalls until GitHub's cron fires/);
  // A sandbox workflow from before the sweep armed its own wakes and the dispatcher built an owed image: both wait for GitHub's cron.
  const beforeOwn = renderWorkflow(template, sandbox).replace(/\n {2}sweep-wake:[\s\S]*$/, "\n").replace(/ \|\|\n\s*\(needs\.dispatch\.outputs\.image_owed[^\n]*\)\)/, ")");
  const own = ownedTickCheck(beforeOwn, {});
  assert.equal(own.status, "FAIL");
  assert.match(own.detail, /the sweep's own wake \(sweep-wake\), the sweep's wake after an image build \(image-wake\) that runs past a skipped dispatcher, the dispatcher's owed image build \(image_owed\)/);
  assert.equal(ownedTickCheck(beforeOwn, {}, { job: true }).status, "WARN");
  // #53: an image-wake with no status function is skipped whenever the dispatcher is (push, cron, a manual build).
  const skippedWake = ownedTickCheck(renderWorkflow(template, sandbox).replace("if: needs.image.result == 'success' && needs.image.outputs.wake_at != '' && !cancelled()", "if: needs.image.outputs.wake_at != ''"), {});
  assert.equal(skippedWake.status, "FAIL");
  assert.match(skippedWake.detail, /image-wake\) that runs past a skipped dispatcher/);
  assert.equal(ownedTickCheck(renderWorkflow(template, sandbox), {}).status, "PASS");
  const noTick = ownedTickCheck(renderWorkflow(template, sandbox).replace(" || startsWith(inputs.wake, 'sweep ')", ""), {});
  assert.match(noTick.detail, /the sweep's own wake/, "a wake whose tick the sweep does not run on");
});

test("the sweep's own wakes: minutes, on every repository; only an armed sweep wake covers one", async () => {
  const { armWake } = await import("../scripts/dispatch.mjs");
  assert.deepEqual(SWEEP_WAKE_KINDS, ["sweep"]);
  const repo = { owner: "acme", name: "app", full: "acme/app" };
  const sweepAt = { issue: 4, kind: "sweep", at: iso(T + 10 * min) };
  const jobs = (...wakes) => async () => ({ wakes });
  const arm = (readJobs, firedBy = null) => armWake(repo, [sweepAt], { now: T, firedBy, kinds: SWEEP_WAKE_KINDS, runs: SWEEP_WAKE_KINDS, readJobs });
  // A dispatcher's lease wake ticks first, but its tick runs no sweep: it covers nothing of the sweep's.
  assert.deepEqual(await arm(jobs({ kind: "lease", at: iso(T + 5 * min) })), { kind: "sweep", at: sweepAt.at, issue: 4 });
  assert.equal(await arm(jobs({ kind: "sweep", at: iso(T + 8 * min) })), null, "one sweep sleeper");
  assert.equal(await arm(jobs(), { kind: "sweep", at: sweepAt.at }), null, "a sweep wake's own run never re-arms its deadline");
  // The dispatcher never arms the sweep's kind, and a sweep wake's tick (a workflow_dispatch) also ticks it.
  assert.ok(!wakeKinds(true).includes("sweep"));
});

test("workflow template: the sweep and the image job each have a wake job that sleeps to their deadline and ticks with it", async () => {
  const { renderWorkflow } = await import("../scripts/setup.mjs");
  const { parseYaml } = await import("../scripts/lib/yaml.mjs");
  const template = readFileSync(join(import.meta.dirname, "..", "workflow-template.yml"), "utf8");
  const values = { harness: "claude", runs_on: "ubuntu-latest", action: "clockgrove/factory@v1.2.3", ci_workflow: "Quality" };
  const doc = parseYaml(renderWorkflow(template, { ...values, sandbox: "vercel", default_branch: "main" }));
  for (const job of ["sweep", "image"]) {
    const wake = doc.jobs[`${job}-wake`];
    assert.equal(wake.name, `wake (\${{ needs.${job}.outputs.wake_kind }} \${{ needs.${job}.outputs.wake_at }})`, "the name every armer reads armed wakes from");
    assert.equal(wake.needs, job);
    assert.match(wake.if, new RegExp(`needs\\.${job}\\.outputs\\.wake_at != ''`));
    assert.equal(wake.concurrency, undefined);
    assert.deepEqual(wake.permissions, { actions: "write" });
    assert.ok(Number(wake["timeout-minutes"]) >= 20, "it outlives a sweep wait (about 16 minutes at most)");
    assert.ok(Number(wake["timeout-minutes"]) <= 30, "no long sleeper");
    assert.match(wake.steps[0].run, /gh workflow run factory\.yml -f wake="\$WAKE_KIND \$WAKE_AT"/, "the tick carries its deadline");
    for (const k of ["wake_at", "wake_kind"]) assert.match(doc.jobs[job].outputs[k], new RegExp(`steps\\.f\\.outputs\\.${k}`));
    assert.ok(doc.jobs[job].permissions.actions === "read", "the job token lists the armed wakes");
  }
  assert.doesNotMatch(template, /nightly [0-9]|'nightly '/, "no nightly sleeper");
  // A quota refusal's sweep that left usage for the sweep job's slots: the launch job's tick runs that job too.
  for (const job of ["launch", "launch-event"]) assert.match(doc.jobs[job].steps.at(-1).run, /-f sweep="\$SWEEP"/, job);
  assert.doesNotMatch(renderWorkflow(template, values), /sweep-wake|image-wake/, "no sandbox, no sandbox wakes");
});

test("a hop wake covers only up to when it ticks, not the deadline it is named for", () => {
  const cap = WAKE_MAX_SLEEP_S * 1000;
  const turn = { kind: "daily-cap", at: iso(T + 4 * 3600_000) };
  // A hop started 350 minutes ago for the day's turn: its plain tick is this run, and its job is still finishing.
  const hop = { kind: "daily-cap", at: turn.at, startedAt: iso(T - cap) };
  assert.equal(wakeFiresAt(hop, T), T);
  assert.deepEqual(nextWake([turn], { now: T, armed: [hop] }), { kind: "daily-cap", at: turn.at, issue: null }, "the hop that just ticked does not hide the deadline");
  // A hop for a deadline 6 hours out, started an hour ago, ticks in 4h50m: it covers a later deadline, not the 4-hour one.
  const far = { kind: "daily-cap", at: iso(T + 6 * 3600_000), startedAt: iso(T - 3600_000) };
  assert.equal(wakeFiresAt(far, T), T - 3600_000 + cap);
  assert.equal(nextWake([turn], { now: T, armed: [far] })?.kind, "daily-cap");
  assert.equal(nextWake([{ kind: "daily-cap", at: far.at }], { now: T, armed: [far] }), null);
  // Not started yet: a deadline within one sleep is when it ticks; one further out is not known, so it covers nothing.
  assert.equal(wakeFiresAt({ kind: "quota", at: iso(T + 5 * min) }, T), T + 5 * min);
  assert.equal(wakeFiresAt({ kind: "daily-cap", at: iso(T + cap + min) }, T), null);
  assert.equal(nextWake([turn], { now: T, armed: [{ kind: "daily-cap", at: iso(T + cap + min) }] })?.kind, "daily-cap");
});

test("closedIssueTicks: a closed issue runs the dispatcher only when it was an Objective or blocks one", async () => {
  const { closedIssueTicks } = await import("../scripts/dispatch.mjs");
  let reads = 0;
  const objectives = (list) => async () => {
    reads += 1;
    return list;
  };
  const closed = (issue) => ({ action: "closed", issue });
  const opts = (list = []) => ({ objectiveLabel: "factory:objective", objectives: objectives(list) });
  assert.equal(await closedIssueTicks("issues", { action: "labeled", issue: { number: 3 } }, opts()), true);
  assert.equal(await closedIssueTicks("schedule", {}, opts()), true);
  assert.equal(await closedIssueTicks("issues", closed({ number: 3, labels: [{ name: "factory:objective" }] }), opts()), true);
  assert.equal(await closedIssueTicks("issues", closed({ number: 3, labels: [], issue_dependencies_summary: { blocking: 1, blocked_by: 0 } }), opts()), true);
  assert.equal(reads, 0);
  assert.equal(await closedIssueTicks("issues", closed({ number: 3, labels: [], issue_dependencies_summary: { blocking: 0, blocked_by: 0 } }), opts([{ number: 9, body: "Blocked by #3" }])), true, "a body line");
  assert.equal(await closedIssueTicks("issues", closed({ number: 3, labels: [], issue_dependencies_summary: { blocking: 0, blocked_by: 0 } }), opts([{ number: 9, body: "Blocked by #4" }])), false, "blocks nothing: no run");
  assert.equal(await closedIssueTicks("issues", closed({ number: 3, labels: [] }), opts()), true, "no count in the payload rules nothing out");
});

const SINCE = "2026-11-10T11:00:00.000Z";
const at = (m) => iso(Date.parse(SINCE) + m * min);
const fail = (m, code, stage = "work") => ({ stage, ok: false, at: at(m), ...(code ? { code } : {}) });

test("a vendor's transient start failures back off 2, 4, 8, 16, then every 30 minutes and never Block", async () => {
  const { startFailure } = await import("../scripts/launch.mjs");
  for (const code of ["unavailable", "rate_limited", "timeout"]) assert.equal(startFailure({ code }), "retry", code);
  assert.equal(startFailure({ code: "quota" }), "quota");
  assert.equal(startFailure({ code: "auth" }), "block", "any other error Blocks at once");
  // Its Block's cause: the vendor's plan quota after the wait is external (provider-quota); any other failed start is Factory's.
  const { failedStartCause } = await import("../scripts/launch.mjs");
  assert.equal(failedStartCause(startFailure({ code: "quota" })), "provider-quota");
  assert.equal(failedStartCause(startFailure({ code: "auth" })), "factory");
  assert.deepEqual([1, 2, 3, 4, 5, 6, 9].map(startBackoffMs), [2, 4, 8, 16, 30, 30, 30].map((m) => m * min));
  // An hour-long outage: eight transient failures in the stint, no Block, the next try 30 minutes after the last.
  const outage = { state: "failed", launches: [1, 3, 7, 15, 31, 61, 91, 121].map((m) => fail(m, "unavailable")) };
  const now = Date.parse(at(125));
  assert.equal(failedSince(outage, SINCE, now), 0);
  assert.deepEqual(launchDecision({ ev: { kind: "swept", issue: 1 }, state: "Running", runningSince: SINCE, record: outage, now }), { stage: "work" });
  assert.equal(startRetryAt(outage, SINCE, now), Date.parse(at(121)) + 30 * min);
  // The route's new picks wait through the first VENDOR_HOLD_MAX refusals (about 30 minutes of backoff); past that the
  // failure looks like this Objective's own, and only its own retries go on.
  assert.equal(transientHold({ ...outage, launches: outage.launches.slice(0, 4) }, SINCE, Date.parse(at(32))), true, "the route's new picks wait");
  assert.equal(transientHold({ ...outage, launches: outage.launches.slice(0, 5) }, SINCE, Date.parse(at(32))), false, "a fifth refusal in a row: the route is free again");
  assert.equal(transientHold(outage, SINCE, now), false);
  // Real failures keep three strikes, whatever transient ones came between.
  const real = { state: "failed", launches: [fail(1, "error"), fail(3, "unavailable"), fail(7, "error"), fail(15, "error")] };
  assert.match(launchDecision({ ev: { kind: "swept", issue: 1 }, state: "Running", runningSince: SINCE, record: real, now }).block, /3 sandbox starts failed/);
  assert.equal(startRetryAt(real, SINCE, now), Date.parse(at(15)), "at once: the launcher Blocks it");
  assert.equal(transientHold(real, SINCE, now), false);
});

test("entries from before codes were recorded are no strikes, a quota refusal among them", () => {
  const old = { state: "failed", launches: [fail(1), fail(2), fail(3)] };
  assert.equal(failedSince(old, SINCE), 0);
  assert.equal(startRetryAt(old, SINCE), null);
  assert.equal(failedSince({ launches: [fail(1, "quota"), fail(2, "quota"), fail(3, "quota")] }, SINCE), 0);
});

test("every launch attempt ends stored: a lost marker and a cut-off claim become entries no later write erases", async () => {
  const { startingRecord } = await import("../scripts/dispatch.mjs");
  const { failedStartRecord, settledLaunches } = await import("../scripts/launch.mjs");
  const named = startingRecord(null, { vendor: "vercel", stage: "work", at: at(1), run: "5" });
  assert.equal(named.launches[0].ok, null);
  const later = Date.parse(at(1)) + START_LOST_MS + 1000;
  assert.deepEqual(settleStale(named, later).launches, [{ stage: "work", event: "dispatch", ok: false, run: "5", at: iso(Date.parse(at(1)) + START_LOST_MS), code: "lost" }]);
  assert.equal(settleStale(named, later - 2000), named, "not before a launch job's limit and its runner wait");
  // A young marker is a launch in flight: not named again before it turns into an outcome.
  assert.equal(inFlightUntil(named, SINCE, Date.parse(at(3))), Date.parse(at(1)) + START_LOST_MS + 1000);
  assert.equal(inFlightUntil(named, SINCE, later), null);
  // An outcome settles a pending marker; a stored failure is never dropped.
  assert.deepEqual(settledLaunches(named.launches), []);
  const stored = settleStale(named, later);
  assert.deepEqual(settledLaunches(stored.launches).map((l) => l.code), ["lost"]);
  const failed = failedStartRecord(stored, { vendor: "vercel", stage: "work", event: "issues", run: "6", at: at(13), code: "error" });
  assert.deepEqual(failed.launches.map((l) => l.code), ["lost", "error"]);
  // A launcher cut off in its vendor calls: its claim's lease ran out with no start after it.
  const cut = { stage: "work", state: "running", claim: "abcabcabcabc", at: at(2), claimedAt: at(2), leaseUntil: at(12), launches: [] };
  const settled = settleStale(cut, Date.parse(at(13)));
  assert.deepEqual([settled.state, settled.leaseUntil, settled.launches.map((l) => [l.code, l.at])], ["failed", null, [["timeout", at(12)]]]);
  assert.equal(settleStale({ ...cut, launches: [{ stage: "work", ok: true, at: at(3) }] }, Date.parse(at(13))).launches.length, 1, "a stage that started is no failed start");
});

const N7 = 7;
const HEAD7 = marker(N7, "sandbox");
const storeWrite = (s, next, nowMs) => writeSandboxRecord(REPO, N7, {}, next, { api: s.api, base: BASE, tries: 400, pauseMs: 0, readBackPauseMs: 0, now: () => nowMs });

test("repeated cut-off launches Block after three in a row, and never hold the vendor's route", async () => {
  setSelf(BOT.login);
  const s = githubStore({ seed: 5 });
  s.put(N7, `${HEAD7}\n${recordBody({ vendor: "vercel", stage: "work", state: "stopped", at: at(0), launches: [] })}`);
  for (const [k, m] of [[1, 1], [2, 25], [3, 49]]) {
    // Each launcher claims the record (its write stores the earlier claim's cut-off first), then is cut off.
    const claim = `${k}`.repeat(12);
    const w = await storeWrite(s, (cur) => ({ ...cur, stage: "work", state: "running", claim, at: at(m), claimedAt: at(m), leaseUntil: at(m + 10) }), Date.parse(at(m)));
    assert.ok(w.ok);
  }
  // The next writer (the dispatcher's marker) stores the third cut-off before its own change.
  await storeWrite(s, (cur) => ({ ...cur }), Date.parse(at(61)));
  const rec = sandboxRecordOf(s.bodyOf(N7, HEAD7));
  const now = Date.parse(at(62));
  assert.deepEqual(startFailures(rec, SINCE, now).map((f) => f.code), ["timeout", "timeout", "timeout"]);
  assert.match(launchDecision({ ev: { kind: "swept", issue: N7 }, state: "Running", runningSince: SINCE, record: rec, now }).block, /3 sandbox starts in a row ran past the launch job's limit \(timeout\)/);
  assert.equal(transientHold(rec, SINCE, now), false, "a cut-off says nothing about the vendor");
  assert.equal(startRetryAt(rec, SINCE, now), Date.parse(at(59)), "at once: the launcher Blocks it");
  setSelf(null);
});

test("repeated lost launches reach three strikes, each stored as the next marker is written", async () => {
  const { startingRecord } = await import("../scripts/dispatch.mjs");
  setSelf(BOT.login);
  const s = githubStore({ seed: 9 });
  for (const m of [1, 13, 25]) await storeWrite(s, (cur) => startingRecord(cur, { vendor: "vercel", stage: "work", at: at(m), run: String(m) }), Date.parse(at(m)));
  const rec = sandboxRecordOf(s.bodyOf(N7, HEAD7));
  assert.deepEqual(rec.launches.map((l) => l.code ?? null), ["lost", "lost", null], "two stored as later markers were written; the last still pending");
  const now = Date.parse(at(37));
  assert.equal(failedSince(rec, SINCE, now), 3);
  assert.match(launchDecision({ ev: { kind: "swept", issue: N7 }, state: "Running", runningSince: SINCE, record: rec, now }).block, /3 sandbox starts failed/);
  setSelf(null);
});

test("recordFailedStart writes under the record lock: a sweep's destroy in between is kept, never the stale sandbox id", async () => {
  const { recordFailedStart, recordBody, writeSandboxRecord } = await import("../scripts/launch.mjs");
  setSelf(BOT.login);
  const N = 7;
  const HEAD = marker(N, "sandbox");
  for (let seed = 1; seed <= 30; seed += 1) {
    const s = githubStore({ seed });
    s.put(N, `${HEAD}\n${recordBody({ vendor: "vercel", id: "factory-old", stage: "work", state: "stopped", claim: "000000000000", at: at(0), launches: [] })}`);
    const fast = { api: s.api, base: BASE, tries: 400, pauseMs: 0, readBackPauseMs: 0 };
    const sweep = writeSandboxRecord(REPO, N, {}, (cur) => ({ ...cur, id: null, destroyedAt: at(1) }), fast);
    const failure = recordFailedStart({ inputs: { sandbox: "vercel" }, eventName: "workflow_dispatch", runId: "9", repo: REPO, n: N, opts: {}, claim: null, base: BASE }, { stage: "work", error: { code: "unavailable" }, at: at(1), api: s.api, lockOpts: { tries: 400, pauseMs: 0, readBackPauseMs: 0 } });
    const [a, b] = await Promise.all([sweep, failure]);
    assert.ok(a.ok && b.ok, `seed ${seed}: both written`);
    const rec = sandboxRecordOf(s.bodyOf(N, HEAD));
    assert.equal(rec.id, null, `seed ${seed}: the destroyed sandbox stays destroyed`);
    assert.equal(rec.launches.at(-1).code, "unavailable", `seed ${seed}: the failed start is in`);
    assert.equal(s.refs.size, 0);
  }
  setSelf(null);
});

test("dispatch: transient retries hold the route's new picks; a failed start waits its pause; a failed launch's grace wakes; each named stage gets a marker", async () => {
  const { dispatch } = await import("../scripts/dispatch.mjs");
  const now = Date.now();
  setSelf(BOT.login);
  const iss = (number, running = true) => ({ number, state: "open", labels: [{ name: "factory:objective" }, ...(running ? [{ name: "factory:running" }] : [])], body: "", updated_at: iso(now), user: { login: "maintainer" } });
  const record = (n, launches) => [{ id: 100 + n, user: BOT, updated_at: iso(now), body: `${marker(n, "sandbox")}\n${sandboxMarkerLine({ vendor: "vercel", stage: "work", state: "failed", at: iso(now - 60 * min), launches })}` }];
  const f = (ms, code) => ({ stage: "work", ok: false, at: iso(now - ms), code });
  // #20: the vendor failed its start 30 s ago (transient): its retry waits 2 minutes, and nothing new starts meanwhile.
  // #22: three real failures: named at once, so its launcher Blocks it. #24: Running a minute, its launch job just failed.
  // #30: Queued, held by #20's outage.
  // #26: Running 30 minutes; named 2 minutes ago and its launcher threw before it could record anything: in flight.
  const since = { 20: 4 * min, 22: 30 * min, 24: min, 26: 30 * min };
  const comments = { 20: record(20, [f(30_000, "unavailable")]), 22: record(22, [f(20 * min, "error"), f(15 * min, "error"), f(10 * min, "error")]), 26: record(26, [{ stage: "work", event: "dispatch", ok: null, run: "1", at: iso(now - 2 * min) }]) };
  const s = githubStore({ seed: 3 });
  for (const n of [20, 22]) s.put(n, comments[n][0].body);
  const realFetch = globalThis.fetch;
  const saved = process.env.GITHUB_API_URL;
  process.env.GITHUB_API_URL = "https://github.test";
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || "GET";
    const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    const n = Number(/\/issues\/(\d+)\//.exec(u.pathname)?.[1]);
    if (method === "GET" && u.pathname === `/repos/${REPO.full}/issues`) return json(u.searchParams.get("state") === "closed" ? [] : [iss(20), iss(22), iss(24), iss(26), iss(30, false)]);
    if (method === "GET" && u.pathname === `/repos/${REPO.full}/issues/comments`) return json([]);
    if (method === "GET" && /\/issues\/\d+\/comments$/.test(u.pathname)) return json(comments[n] || []);
    if (method === "GET" && /\/issues\/\d+\/timeline$/.test(u.pathname)) return json(since[n] ? [{ event: "labeled", label: { name: "factory:running" }, created_at: iso(now - since[n]) }] : []);
    if (method === "GET" && u.pathname.endsWith("/collaborators")) return json([{ login: "maintainer" }]);
    if (method !== "GET") return json({}, 200);
    return json({ message: "Not Found" }, 404);
  };
  try {
    const r = await dispatch({ repo: REPO.full, objectiveLabel: "factory:objective", maxConcurrent: 10, dailyUsd: 100, ciChecks: [], timeoutMinutes: 60, sandbox: "vercel" }, { token: "t", now: new Date(now), failedLaunch: 24, recordWrites: { api: s.api, base: BASE } });
    assert.deepEqual(r.ready, [], "#20's outage holds the route's new picks");
    assert.match(r.skipped.find((x) => x.number === 30).reason, /failing starts/);
    assert.deepEqual(r.relaunch, [22]);
    const kinds = Object.fromEntries(r.deadlines.filter((d) => d.issue).map((d) => [d.issue, [d.kind, d.at]]));
    assert.deepEqual(kinds[20], ["start-retry", iso(now - 30_000 + START_RETRY_MS)]);
    assert.equal(kinds[24][0], "start-retry", "a failed launch's grace is a wake of its own, not a wait for the cron");
    assert.deepEqual(kinds[26], ["start-retry", iso(now - 2 * min + START_LOST_MS + 1000)], "an unrecordable throw is not named again inside its marker's window");
    const marked = sandboxRecordOf(s.bodyOf(22, marker(22, "sandbox")));
    assert.deepEqual(marked.launches.at(-1).ok, null, "the relaunch is marked as it is named");
  } finally {
    globalThis.fetch = realFetch;
    if (saved === undefined) delete process.env.GITHUB_API_URL;
    else process.env.GITHUB_API_URL = saved;
    setSelf(null);
  }
});

test("every kind a wake is armed for is read back from its job name and its tick: an armed start-retry covers its deadline", async () => {
  const { firedByWake } = await import("../scripts/dispatch.mjs");
  assert.ok(WAKE_KINDS.every((k) => parseWake(`wake (${k} ${iso(T + 5 * min)})`)?.kind === k), "no sleeper the dispatcher cannot see");
  assert.deepEqual(firedByWake("workflow_dispatch", { inputs: { wake: `start-retry ${iso(T + 5 * min)}` } }), { kind: "start-retry", at: iso(T + 5 * min) });
  const armed = [{ ...parseWake(`wake (start-retry ${iso(T + 5 * min)})`), startedAt: iso(T - min) }];
  assert.equal(nextWake([{ issue: 20, kind: "start-retry", at: iso(T + 5 * min) }], { now: T, armed, kinds: wakeKinds(false) }), null, "one sleeper, not one per tick");
});

test("a started stage whose lease lapsed is no cut-off launch: its own end and token requests still count", () => {
  const now = Date.now();
  const since = iso(now - 60 * min);
  const started = { stage: "work", event: "issues", ok: true, run: "1", cue: "stint-1", at: iso(now - 59 * min) };
  // The merged record's `at` is the stage's last beat (15 minutes ago), long after the start; the claim is older.
  for (const rec of [
    { vendor: "vercel", id: "factory-abc", stage: "work", state: "running", claim: "abcabcabcabc", at: iso(now - 15 * min), leaseUntil: iso(now - 5 * min), launches: [started] },
    { vendor: "vercel", id: "factory-abc", stage: "work", state: "running", claim: "abcabcabcabc", run: "1", claimedAt: iso(now - 60 * min), at: iso(now - 15 * min), leaseUntil: iso(now - 5 * min), launches: [started] },
  ]) {
    const settled = settleStale(rec, now);
    assert.equal(settled.state, "running");
    assert.deepEqual(startFailures(settled, since, now), []);
    assert.deepEqual(launchDecision({ ev: { kind: "stage", issue: 10, claim: rec.claim, want: "token" }, state: "Running", record: settled, fromSelf: true, runningSince: since, now }), { token: true });
    assert.doesNotMatch(JSON.stringify(launchDecision({ ev: { kind: "stage", issue: 10, claim: rec.claim, want: "ended" }, state: "Running", record: { ...settled, state: "ended" }, fromSelf: true, runningSince: since, now })), /claim/);
  }
});

test("a runner clock a little behind GitHub's still files its marker and its failure under the stint", () => {
  const labelAt = "2026-11-10T12:00:05Z";
  const named = { state: "named", launches: [{ stage: "work", event: "dispatch", ok: null, run: "1", at: "2026-11-10T12:00:03.800Z" }] };
  assert.ok(inFlightUntil(named, labelAt, Date.parse(labelAt) + min) !== null, "in flight");
  const t2 = Date.parse("2026-11-10T12:00:03.800Z") + START_LOST_MS + 5000;
  assert.deepEqual(startFailures(named, labelAt, t2).map((f) => f.code), ["lost"], "its strike counts");
  const early = { state: "failed", launches: [{ stage: "work", ok: false, at: "2026-11-10T12:00:03.800Z", code: "error" }] };
  assert.deepEqual(startFailures(early, labelAt, Date.parse(labelAt) + min).map((f) => f.code), ["error"], "a failure the launcher stamped a second early");
});

test("a deferred stage's note: the vendor's code, the try count, the next try, and whether it still holds the route", async () => {
  const { deferredNote } = await import("../scripts/launch.mjs");
  const note = deferredNote({ stage: "work", vendor: "vercel", code: "unavailable", tries: 5, next: Date.parse("2026-11-10T12:30:00Z"), holds: false });
  assert.match(note, /`unavailable`/);
  assert.match(note, /5 time\(s\) in a row/);
  assert.match(note, /2026-11-10 12:30Z/);
  assert.match(note, /no longer holds new Objectives/);
  assert.match(deferredNote({ stage: "work", vendor: "vercel", code: "<script>", tries: 1, next: NaN, holds: true }), /`\?`.*New Objectives on this route wait/);
});

test("dispatch: the run that names a launch owns it: a wake for its marker's expiry, and a launch that started nothing ticks", async () => {
  const { dispatch } = await import("../scripts/dispatch.mjs");
  const { renderWorkflow } = await import("../scripts/setup.mjs");
  const { parseYaml } = await import("../scripts/lib/yaml.mjs");
  const now = Date.now();
  setSelf(BOT.login);
  const s = githubStore({ seed: 3 });
  const open = [{ number: 40, state: "open", labels: [{ name: "factory:objective" }, { name: "factory:running" }], body: "", updated_at: iso(now), user: { login: "maintainer" } }];
  const realFetch = globalThis.fetch;
  const saved = process.env.GITHUB_API_URL;
  process.env.GITHUB_API_URL = "https://github.test";
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || "GET";
    const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    if (method === "GET" && u.pathname === `/repos/${REPO.full}/issues`) return json(u.searchParams.get("state") === "closed" ? [] : open);
    if (method === "GET" && /\/issues\/\d+\/timeline$/.test(u.pathname)) return json([{ event: "labeled", label: { name: "factory:running" }, created_at: iso(now - 30 * min) }]);
    if (method === "GET" && u.pathname.endsWith("/collaborators")) return json([{ login: "maintainer" }]);
    if (method === "GET" && /comments/.test(u.pathname)) return json([]);
    if (method !== "GET") return json({}, 200);
    return json({ message: "Not Found" }, 404);
  };
  try {
    const r = await dispatch({ repo: REPO.full, objectiveLabel: "factory:objective", maxConcurrent: 3, dailyUsd: 100, ciChecks: [], timeoutMinutes: 60, sandbox: "vercel" }, { token: "t", now: new Date(now), recordWrites: { api: s.api, base: BASE } });
    assert.deepEqual(r.relaunch, [40]);
    const marked = sandboxRecordOf(s.bodyOf(40, marker(40, "sandbox"))).launches.at(-1);
    assert.equal(marked.ok, null);
    assert.deepEqual(r.deadlines.filter((d) => d.issue === 40).map((d) => [d.kind, d.at]), [["start-retry", iso(Date.parse(marked.at) + START_LOST_MS + 1000)]]);
  } finally {
    globalThis.fetch = realFetch;
    if (saved === undefined) delete process.env.GITHUB_API_URL;
    else process.env.GITHUB_API_URL = saved;
    setSelf(null);
  }
  const template = readFileSync(join(import.meta.dirname, "..", "workflow-template.yml"), "utf8");
  const doc = parseYaml(renderWorkflow(template, { harness: "claude", runs_on: "ubuntu-latest", action: "clockgrove/factory@v1.2.3", ci_workflow: "Quality", sandbox: "vercel", default_branch: "main" }));
  for (const job of ["launch", "launch-event"]) assert.match(doc.jobs[job].steps.find((x) => /gh workflow run factory\.yml/.test(x.run || "")).if, /exit == 'skipped'/, `${job}: a launch that started nothing ticks`);
});

test("an orphan starting marker: none over a live claim, and a skipping launcher drops its own (#42)", async () => {
  const { startingRecord } = await import("../scripts/dispatch.mjs");
  const { withoutOwnMarker } = await import("../scripts/launch.mjs");
  setSelf(BOT.login);
  const s = githubStore({ seed: 11 });
  // An event launcher claims work; the dispatcher, which read the record before that claim, then tries to mark its own
  // launch of the same stage (that launch will skip: the stage holds). Then the event's start fails transiently.
  await storeWrite(s, () => ({ vendor: "vercel", stage: "work", state: "running", at: at(3), claimedAt: at(3), leaseUntil: at(13), claim: "eeeeeeeeeeee", launches: [] }), Date.parse(at(3)));
  const marked = await storeWrite(s, (cur) => startingRecord(cur, { vendor: "vercel", stage: "work", at: at(3.1), run: "900" }), Date.parse(at(3.1)));
  assert.equal(marked.ok, undefined, "no marker over a live claim");
  await storeWrite(s, (cur) => (cur?.claim === "eeeeeeeeeeee" ? { ...cur, state: "failed", error: { code: "unavailable", status: 503 }, at: at(4), leaseUntil: null, launches: [...cur.launches, { stage: "work", ok: false, code: "unavailable", at: at(4) }] } : null), Date.parse(at(4)));
  await storeWrite(s, (cur) => ({ ...cur }), Date.parse(at(14)));
  const rec = sandboxRecordOf(s.bodyOf(N7, HEAD7));
  assert.deepEqual(startFailures(rec, SINCE, Date.parse(at(14))).map((f) => f.code), ["unavailable"]);
  assert.equal(failedSince(rec, SINCE, Date.parse(at(14))), 0, "a transient failure stays transient: no orphan strike");
  // A launch that skips drops its own run's pending marker only.
  const two = { launches: [{ stage: "work", ok: false, code: "error", at: at(1) }, { stage: "work", event: "dispatch", ok: null, run: "800", at: at(2) }, { stage: "work", event: "dispatch", ok: null, run: "900", at: at(3) }] };
  assert.deepEqual(withoutOwnMarker(two, { run: "900", stage: "work" }).launches.map((l) => l.run ?? l.code), ["error", "800"]);
  assert.equal(withoutOwnMarker(two, { run: "900", stage: "review" }), null, "another stage's marker is not its own");
  assert.equal(withoutOwnMarker(two, { run: "901" }), null);
  assert.equal(withoutOwnMarker(null, { run: "900" }), null);
  setSelf(null);
});
