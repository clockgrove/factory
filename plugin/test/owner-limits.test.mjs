import "./temp.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { localLimits, resolveInputs } from "../scripts/lib/inputs.mjs";
import { LIMIT } from "../scripts/lib/harness.mjs";
import { OUTAGE } from "../scripts/lib/network.mjs";
import { CLAIM_PAUSE_MS } from "../scripts/lib/local.mjs";
import { WAIT_MAX_MS } from "../scripts/lib/overlap.mjs";
import { MAX_PARTS, nextPart } from "../scripts/lib/handoff.mjs";
import { STALL_DEFAULTS, setSelf } from "../scripts/lib/logic.mjs";

// #423: limits a person owns are settings through the settings layers, with today's values as defaults and an upper
// bound each, so no value can push a time past what a Date holds.

const HOUR = 3600_000;
const MIN = 60_000;

test("#423: every owner limit is a setting whose default is today's value; a value out of its rule reads as the default", () => {
  const d = resolveInputs({ env: {} });
  assert.deepEqual(
    [d.usageLimitWaits, d.usageLimitMoveMs, d.claimPauseMs, d.siblingWaitMs, d.maxParts, d.stall, d.relay],
    [LIMIT.waits, LIMIT.movePastMs, CLAIM_PAUSE_MS, WAIT_MAX_MS, MAX_PARTS, { ...STALL_DEFAULTS }, undefined],
  );
  assert.deepEqual(localLimits({}), { waitMs: OUTAGE.stageWaitMs, outageMs: OUTAGE.blockMs });

  const set = resolveInputs({
    env: {
      PENDULUM_USAGE_LIMIT_WAITS: "0",
      PENDULUM_USAGE_LIMIT_MOVE_MINUTES: "30",
      PENDULUM_CLAIM_PAUSE_HOURS: "48",
      PENDULUM_SIBLING_WAIT_HOURS: "1.5",
      PENDULUM_MAX_PARTS: "10",
      PENDULUM_STEP_STALL_FACTOR: "2",
      PENDULUM_STEP_STALL_FLOOR_MINUTES: "5",
      PENDULUM_QUEUE_STALL_MINUTES: "20",
    },
  });
  assert.deepEqual(
    [set.usageLimitWaits, set.usageLimitMoveMs, set.claimPauseMs, set.siblingWaitMs, set.maxParts, set.stall],
    [0, 30 * MIN, 48 * HOUR, 1.5 * HOUR, 10, { factor: 2, floorMs: 5 * MIN, queueMs: 20 * MIN }],
  );
  assert.deepEqual(localLimits({ PENDULUM_LOCAL_WAIT_MINUTES: "45", PENDULUM_LOCAL_OUTAGE_HOURS: "6" }), { waitMs: 45 * MIN, outageMs: 6 * HOUR });

  // Past its bound, under its least, not a number, or a fraction where a whole number is asked: the default.
  const bad = resolveInputs({ env: { PENDULUM_CLAIM_PAUSE_HOURS: "1e12", PENDULUM_SIBLING_WAIT_HOURS: "-1", PENDULUM_MAX_PARTS: "2.5", PENDULUM_USAGE_LIMIT_WAITS: "many", PENDULUM_STEP_STALL_FACTOR: "0.5" } });
  assert.deepEqual([bad.claimPauseMs, bad.siblingWaitMs, bad.maxParts, bad.usageLimitWaits, bad.stall.factor], [CLAIM_PAUSE_MS, WAIT_MAX_MS, MAX_PARTS, LIMIT.waits, STALL_DEFAULTS.factor]);
  assert.deepEqual(localLimits({ PENDULUM_LOCAL_WAIT_MINUTES: "1e9" }).waitMs, OUTAGE.stageWaitMs);
  // A stall floor or queue stall under a minute would judge every queue commit stalled the moment it is made.
  const tiny = resolveInputs({ env: { PENDULUM_STEP_STALL_FLOOR_MINUTES: "1e-9", PENDULUM_QUEUE_STALL_MINUTES: "0.5" } }).stall;
  assert.deepEqual([tiny.floorMs, tiny.queueMs], [STALL_DEFAULTS.floorMs, STALL_DEFAULTS.queueMs]);
  assert.equal(resolveInputs({ env: { PENDULUM_QUEUE_STALL_MINUTES: "1" } }).stall.queueMs, MIN);
  // A claim pause under two hours would Block a paused Objective between the hourly beats its loop writes.
  assert.equal(resolveInputs({ env: { PENDULUM_CLAIM_PAUSE_HOURS: "1" } }).claimPauseMs, CLAIM_PAUSE_MS);
});

/** A GitHub that answers nextPart's reads for a split Objective with `parts` merged parts and work left. */
function splitGitHub(issue, parts) {
  const prs = Array.from({ length: parts }, (_, i) => 100 + i);
  const record = { id: 1, user: { login: "pendulum-app[bot]", type: "Bot" }, created_at: new Date().toISOString(), body: `<!-- pendulum:${issue}:parts ${JSON.stringify({ prs, remaining: 2 })} -->\nPendulum: split.` };
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
  setSelf("pendulum-app[bot]");
  const repo = { full: "acme/app", owner: "acme", name: "app" };
  try {
    const gh = splitGitHub(7, 6);
    globalThis.fetch = gh.fetch;
    assert.equal(await nextPart(repo, 7, { token: "t" }), "cap");
    assert.equal(await nextPart(repo, 7, { token: "t" }, { maxParts: resolveInputs({ env: { PENDULUM_MAX_PARTS: "10" } }).maxParts }), "next");
    assert.deepEqual(gh.deleted, ["/repos/acme/app/git/refs/heads/pendulum/7"]);
  } finally {
    globalThis.fetch = realFetch;
    if (savedUrl === undefined) delete process.env.GITHUB_API_URL;
    else process.env.GITHUB_API_URL = savedUrl;
    setSelf(null);
  }
});

