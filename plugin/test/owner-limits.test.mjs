import "./temp.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULTS, LOCAL_LIMIT_DEFAULTS, LOCAL_WORKFLOW_SETTINGS, OWNER_LIMITS, VARIABLE_SETTINGS, WORKFLOW_ONLY_SETTINGS, localLimits, resolveInputs, variableSettings } from "../scripts/lib/inputs.mjs";
import { LIMIT } from "../scripts/lib/harness.mjs";
import { OUTAGE } from "../scripts/lib/network.mjs";
import { CLAIM_PAUSE_MS } from "../scripts/lib/local.mjs";
import { WAIT_MAX_MS } from "../scripts/lib/overlap.mjs";
import { MAX_PARTS, nextPart } from "../scripts/lib/handoff.mjs";
import { QUEUE_STALL_MS, STALL_DEFAULTS, STEP_STALL_FLOOR_MS, jobStall, queueStall, renderTaskCard, setSelf, stepStallMs, taskCardValues } from "../scripts/lib/logic.mjs";
import { SLOW_UNKNOWN_FLOOR_USD, UNKNOWN_COST_FLOOR_USD, UNKNOWN_STAGE_SHUT } from "../scripts/lib/gateway-relay.mjs";
import { ownerLimitChecks } from "../scripts/doctor.mjs";
import { Local } from "../scripts/local.mjs";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PLUGIN_ROOT } from "../scripts/lib/checkout.mjs";

// #423: limits a person owns are settings through the settings layers, with today's values as defaults and an upper
// bound each, so no value can push a time past what a Date holds.

const HOUR = 3600_000;
const MIN = 60_000;

test("#423: every owner limit is a setting whose default is today's value; a value out of its rule reads as the default", () => {
  const d = resolveInputs({ env: {} });
  assert.deepEqual(
    [d.usageLimitWaits, d.usageLimitMoveMs, d.claimPauseMs, d.siblingWaitMs, d.maxParts, d.stall, d.relay],
    [LIMIT.waits, LIMIT.movePastMs, CLAIM_PAUSE_MS, WAIT_MAX_MS, MAX_PARTS, { ...STALL_DEFAULTS }, { unknownShut: UNKNOWN_STAGE_SHUT, unknownFloorUsd: UNKNOWN_COST_FLOOR_USD, slowFloorUsd: SLOW_UNKNOWN_FLOOR_USD }],
  );
  assert.deepEqual(localLimits({}), { waitMs: OUTAGE.stageWaitMs, outageMs: OUTAGE.blockMs });

  const set = resolveInputs({
    env: {
      FACTORY_USAGE_LIMIT_WAITS: "0",
      FACTORY_USAGE_LIMIT_MOVE_MINUTES: "30",
      FACTORY_CLAIM_PAUSE_HOURS: "48",
      FACTORY_SIBLING_WAIT_HOURS: "1.5",
      FACTORY_MAX_PARTS: "10",
      FACTORY_STEP_STALL_FACTOR: "2",
      FACTORY_STEP_STALL_FLOOR_MINUTES: "5",
      FACTORY_QUEUE_STALL_MINUTES: "20",
      FACTORY_RELAY_UNKNOWN_SHUT: "40",
      FACTORY_RELAY_UNKNOWN_FLOOR_USD: "0.05",
      FACTORY_RELAY_SLOW_FLOOR_USD: "0.5",
    },
  });
  assert.deepEqual(
    [set.usageLimitWaits, set.usageLimitMoveMs, set.claimPauseMs, set.siblingWaitMs, set.maxParts, set.stall, set.relay],
    [0, 30 * MIN, 48 * HOUR, 1.5 * HOUR, 10, { factor: 2, floorMs: 5 * MIN, queueMs: 20 * MIN }, { unknownShut: 40, unknownFloorUsd: 0.05, slowFloorUsd: 0.5 }],
  );
  assert.deepEqual(localLimits({ FACTORY_LOCAL_WAIT_MINUTES: "45", FACTORY_LOCAL_OUTAGE_HOURS: "6" }), { waitMs: 45 * MIN, outageMs: 6 * HOUR });

  // Past its bound, under its least, not a number, or a fraction where a whole number is asked: the default.
  const bad = resolveInputs({ env: { FACTORY_CLAIM_PAUSE_HOURS: "1e12", FACTORY_SIBLING_WAIT_HOURS: "-1", FACTORY_MAX_PARTS: "2.5", FACTORY_USAGE_LIMIT_WAITS: "many", FACTORY_STEP_STALL_FACTOR: "0.5", FACTORY_RELAY_UNKNOWN_SHUT: "0" } });
  assert.deepEqual([bad.claimPauseMs, bad.siblingWaitMs, bad.maxParts, bad.usageLimitWaits, bad.stall.factor, bad.relay.unknownShut], [CLAIM_PAUSE_MS, WAIT_MAX_MS, MAX_PARTS, LIMIT.waits, STALL_DEFAULTS.factor, UNKNOWN_STAGE_SHUT]);
  assert.deepEqual(localLimits({ FACTORY_LOCAL_WAIT_MINUTES: "1e9" }).waitMs, OUTAGE.stageWaitMs);
  // A stall floor or queue stall under a minute would judge every queue commit stalled the moment it is made.
  const tiny = resolveInputs({ env: { FACTORY_STEP_STALL_FLOOR_MINUTES: "1e-9", FACTORY_QUEUE_STALL_MINUTES: "0.5" } }).stall;
  assert.deepEqual([tiny.floorMs, tiny.queueMs], [STALL_DEFAULTS.floorMs, STALL_DEFAULTS.queueMs]);
  assert.equal(resolveInputs({ env: { FACTORY_QUEUE_STALL_MINUTES: "1" } }).stall.queueMs, MIN);
  // A claim pause under two hours would Block a paused Objective between the hourly beats its loop writes.
  assert.equal(resolveInputs({ env: { FACTORY_CLAIM_PAUSE_HOURS: "1" } }).claimPauseMs, CLAIM_PAUSE_MS);
});

test("#423: each limit's bound keeps every time it makes a valid Date, counted from now", () => {
  const unit = { HOURS: HOUR, MINUTES: MIN };
  for (const [name, rule] of Object.entries(OWNER_LIMITS)) {
    const ms = rule.max * (unit[/_(HOURS|MINUTES)$/.exec(name)?.[1]] ?? 1);
    assert.doesNotThrow(() => new Date(Date.now() + ms).toISOString(), name);
    // A step's bound is its baseline times the factor: an hour-long step at the most factor is still a Date.
    if (name === "FACTORY_STEP_STALL_FACTOR") assert.doesNotThrow(() => new Date(Date.now() + rule.max * 24 * HOUR).toISOString());
  }
});

test("#423: the relay's limits are set in the workflow file only, as they bound spend; the rest a repository variable may set, and an unusable one is named", () => {
  for (const n of ["RELAY_UNKNOWN_SHUT", "RELAY_UNKNOWN_FLOOR_USD", "RELAY_SLOW_FLOOR_USD"]) assert.ok(WORKFLOW_ONLY_SETTINGS.has(`FACTORY_${n}`) && !VARIABLE_SETTINGS.has(`FACTORY_${n}`), n);
  for (const n of ["USAGE_LIMIT_WAITS", "USAGE_LIMIT_MOVE_MINUTES", "CLAIM_PAUSE_HOURS", "SIBLING_WAIT_HOURS", "MAX_PARTS", "STEP_STALL_FACTOR", "STEP_STALL_FLOOR_MINUTES", "QUEUE_STALL_MINUTES", "LOCAL_WAIT_MINUTES", "LOCAL_OUTAGE_HOURS"]) assert.ok(VARIABLE_SETTINGS.has(`FACTORY_${n}`), n);
  assert.deepEqual(variableSettings({ FACTORY_RELAY_UNKNOWN_SHUT: "50" }).excluded, ["FACTORY_RELAY_UNKNOWN_SHUT"]);
  const v = variableSettings({ FACTORY_SIBLING_WAIT_HOURS: "500", FACTORY_MAX_PARTS: "3", FACTORY_LOCAL_OUTAGE_HOURS: "0" });
  assert.deepEqual(v.kept, { FACTORY_MAX_PARTS: "3" });
  assert.deepEqual(v.invalid.map((x) => [x.name, x.why]), [
    ["FACTORY_LOCAL_OUTAGE_HOURS", "not a number above 0, at most 720"],
    ["FACTORY_SIBLING_WAIT_HOURS", "not a number above 0, at most 168"],
  ]);
  // Every owner limit has its default where its setting lives: an Action input's in DEFAULTS, a local one's beside it.
  for (const name of Object.keys(OWNER_LIMITS)) {
    const key = name.replace(/^FACTORY_/, "").toLowerCase();
    assert.ok(LOCAL_WORKFLOW_SETTINGS.includes(name) ? name in LOCAL_LIMIT_DEFAULTS : key in DEFAULTS, name);
  }
});

test("#423: the step stall's factor and floor and the queue stall are the repository's: a warm build's 20 minutes is hung at 2 x and 5 minutes, and a commit with no CI stalls at its setting", () => {
  const job = (startedAgoMs, now) => ({ name: "Quality", status: "in_progress", started_at: new Date(now - startedAgoMs).toISOString(), steps: [{ name: "Run npm run build", status: "in_progress", started_at: new Date(now - startedAgoMs).toISOString() }] });
  const now = Date.now();
  // A 6-minute build running 20: under max(3 x 6, 6 + 15) by default, over max(2 x 6, 6 + 5) at the repository's.
  assert.equal(jobStall(job(20 * MIN, now), { baselineMs: 6 * MIN, now }), null);
  const stall = resolveInputs({ env: { FACTORY_STEP_STALL_FACTOR: "2", FACTORY_STEP_STALL_FLOOR_MINUTES: "5", FACTORY_QUEUE_STALL_MINUTES: "4" } }).stall;
  assert.equal(stepStallMs(6 * MIN, stall), 12 * MIN);
  assert.equal(jobStall(job(20 * MIN, now), { baselineMs: 6 * MIN, now, stall })?.step, "Run npm run build");
  // A queue commit 5 minutes old with no CI begun: waits by default (10), stalled at 4.
  const entry = { head: "a".repeat(40), headAt: new Date(now - 5 * MIN).toISOString(), state: "AWAITING_CHECKS" };
  assert.ok(queueStall(entry, { started: false, now }).waitMs > 0);
  assert.deepEqual(queueStall(entry, { started: false, now, stall }), { stalled: true });
  // Its checks are judged once the commit is the floor old, not the default's 15 minutes.
  assert.deepEqual(queueStall(entry, { started: true, now, hung: [{ name: "Quality", step: "Run npm run build", elapsedMs: 13 * MIN, baselineMs: 6 * MIN }], stall }).stalled, true);
  assert.equal(queueStall(entry, { started: true, now, hung: [] }).waitMs, STEP_STALL_FLOOR_MS - 5 * MIN);
  assert.equal(STALL_DEFAULTS.queueMs, QUEUE_STALL_MS);
});

/** A GitHub that answers nextPart's reads for a split Objective with `parts` merged parts and work left. */
function splitGitHub(issue, parts) {
  const prs = Array.from({ length: parts }, (_, i) => 100 + i);
  const record = { id: 1, user: { login: "factory-app[bot]", type: "Bot" }, created_at: new Date().toISOString(), body: `<!-- factory:${issue}:parts ${JSON.stringify({ prs, remaining: 2 })} -->\nFactory: split.` };
  const deleted = [];
  const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || "GET";
    if (method === "DELETE") return deleted.push(u.pathname), new Response(null, { status: 204 });
    if (u.pathname.endsWith("/pulls") && u.searchParams.get("state") === "open") return json([]);
    if (u.pathname.endsWith("/pulls") && u.searchParams.get("state") === "closed") return json([...prs].reverse().map((number) => ({ number, merged_at: "2026-11-15T00:00:00Z" })));
    if (/\/pulls\/\d+$/.test(u.pathname)) return json({ number: Number(/(\d+)$/.exec(u.pathname)[1]), merged_at: "2026-11-15T00:00:00Z" });
    if (u.pathname.endsWith(`/issues/${issue}/comments`)) return json([record]);
    return json({ message: "Not Found" }, 404);
  };
  return { fetch, deleted };
}

test("#423: max_parts is the part cap: six merged parts with work left Block by default, and go on to a seventh under a cap of ten", async () => {
  const realFetch = globalThis.fetch;
  const savedUrl = process.env.GITHUB_API_URL;
  process.env.GITHUB_API_URL = "https://github.test";
  setSelf("factory-app[bot]");
  const repo = { full: "acme/app", owner: "acme", name: "app" };
  try {
    const gh = splitGitHub(7, 6);
    globalThis.fetch = gh.fetch;
    assert.equal(await nextPart(repo, 7, { token: "t" }), "cap");
    assert.equal(await nextPart(repo, 7, { token: "t" }, { maxParts: resolveInputs({ env: { FACTORY_MAX_PARTS: "10" } }).maxParts }), "next");
    assert.deepEqual(gh.deleted, ["/repos/acme/app/git/refs/heads/factory/7"]);
  } finally {
    globalThis.fetch = realFetch;
    if (savedUrl === undefined) delete process.env.GITHUB_API_URL;
    else process.env.GITHUB_API_URL = savedUrl;
    setSelf(null);
  }
});

test("#423: the task card names the part cap and that each part has its own budget", () => {
  const template = readFileSync(join(PLUGIN_ROOT, "templates", "task-card.md"), "utf8");
  const card = (extra) => renderTaskCard(template, taskCardValues({ issue: 7, maxUsd: 25, timeoutMinutes: 240, validation: [], budgetCommand: "", protectedPaths: [], ...extra }));
  assert.match(card({}), /A split Objective gets at most 6 PRs, each with a budget of its own/);
  assert.match(card({ maxParts: resolveInputs({ env: { FACTORY_MAX_PARTS: "3" } }).maxParts }), /at most 3 PRs/);
});

test("#423: doctor shows the limits in force, and warns when the local outage bound is not under the claim pause", () => {
  const inputs = resolveInputs({ env: { FACTORY_CLAIM_PAUSE_HOURS: "8", FACTORY_MAX_PARTS: "4", FACTORY_RELAY_UNKNOWN_SHUT: "30" } });
  const [row, ...rest] = ownerLimitChecks({ inputs });
  assert.equal(row.status, "PASS");
  for (const said of ["a quiet local claim Blocked after 8 h", "4 part(s) per Objective at most", "a sibling waited for 6 h at most", "shut at 30 calls of unknown cost, each booked at least $0.25 ($1 past 30 s upstream)", "past 3 x its normal duration and at least 15 min over it", "no CI begun stalled after 10 min", "waited out in place 2 time(s) per pass", "over 60 min away moves to a free account"]) assert.ok(row.detail.includes(said), said);
  assert.deepEqual(rest, [], "off the local route nothing about local limits");
  const local = ownerLimitChecks({ inputs, local: true, stage: { FACTORY_LOCAL_WAIT_MINUTES: "20", FACTORY_LOCAL_OUTAGE_HOURS: "10" } });
  assert.match(local[0].detail, /a local stage waits in place 20 min, and an Objective paused on one outage Blocks after 10 h/);
  assert.equal(local[1].status, "WARN");
  assert.match(local[1].detail, /FACTORY_LOCAL_OUTAGE_HOURS \(10 h\) is not under claim_pause_hours \(8 h\)/);
  assert.equal(ownerLimitChecks({ inputs: resolveInputs({ env: {} }), local: true, stage: {} }).length, 1, "12 h under the default day: no warning");
});

test("#423: a local stage's in-place wait stays under the least claim pause, and doctor warns when it is not under the outage bound", () => {
  // A stage waiting in place writes no heartbeat while the network is down: a wait past an hour reads as the default.
  assert.equal(localLimits({ FACTORY_LOCAL_WAIT_MINUTES: "600" }).waitMs, OUTAGE.stageWaitMs);
  assert.equal(localLimits({ FACTORY_LOCAL_WAIT_MINUTES: "60" }).waitMs, 60 * MIN);
  assert.ok(OWNER_LIMITS.FACTORY_LOCAL_WAIT_MINUTES.max * MIN < OWNER_LIMITS.FACTORY_CLAIM_PAUSE_HOURS.from * HOUR);
  const inputs = resolveInputs({ env: {} });
  const rows = ownerLimitChecks({ inputs, local: true, stage: { FACTORY_LOCAL_WAIT_MINUTES: "45", FACTORY_LOCAL_OUTAGE_HOURS: "0.5" } });
  assert.deepEqual(rows.map((r) => r.status), ["PASS", "WARN"]);
  assert.match(rows[1].detail, /FACTORY_LOCAL_WAIT_MINUTES \(45 min\) is not under FACTORY_LOCAL_OUTAGE_HOURS \(0\.5 h\)/);
});

test("#423: serve takes its outage bounds as now set each tick, the defaults once a setting is gone", () => {
  const saved = { blockMs: OUTAGE.blockMs, stageWaitMs: OUTAGE.stageWaitMs, env: Object.fromEntries(["FACTORY_LOCAL_WAIT_MINUTES", "FACTORY_LOCAL_OUTAGE_HOURS"].map((k) => [k, process.env[k]])) };
  for (const k of Object.keys(saved.env)) delete process.env[k];
  try {
    const loop = Object.assign(Object.create(Local.prototype), { harness: "claude", wf: { FACTORY_LOCAL_WAIT_MINUTES: "30", FACTORY_LOCAL_OUTAGE_HOURS: "6" } });
    loop.applyLocalLimits();
    assert.deepEqual([OUTAGE.stageWaitMs, OUTAGE.blockMs], [30 * MIN, 6 * HOUR]);
    loop.wf = {};
    loop.applyLocalLimits();
    assert.deepEqual([OUTAGE.stageWaitMs, OUTAGE.blockMs], [15 * MIN, 12 * HOUR]);
    // The loop takes them each tick.
    assert.match(readFileSync(join(PLUGIN_ROOT, "scripts", "local.mjs"), "utf8"), /await this\.refreshSettings\(\)[^\n]*\n\s*this\.applyLocalLimits\(\);/);
  } finally {
    Object.assign(OUTAGE, { blockMs: saved.blockMs, stageWaitMs: saved.stageWaitMs });
    for (const [k, v] of Object.entries(saved.env)) if (v !== undefined) process.env[k] = v;
  }
});
