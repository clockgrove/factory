// Visible times in a chosen zone (#586): the Objective's own zone line, the repository's PENDULUM_TIME_ZONE, the
// machine's zone in local mode, else UTC; machine-read text (hidden markers, spend lines, the summary) stays ISO UTC.
import "./temp.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { LINE_CLOCK, useObjectiveZone, zoneMarker } from "../scripts/lib/clock.mjs";
import { setSelf, spendMarker, vendorBody, vendorLine } from "../scripts/lib/logic.mjs";
import { progressReporter } from "../scripts/lib/session.mjs";
import { repoOf } from "../scripts/lib/github.mjs";
import { finishCardBody, finishData, renderFinishCard } from "../scripts/lib/finish-card.mjs";
import { phaseMinutes, stageLastWrite } from "../../bench/lib/phases.mjs";

const at = (iso) => Date.parse(iso);

/** Runs `fn` with process.env's zone settings set as given (undefined: unset), restored after (once its promise settles). */
function withEnv(vars, fn) {
  const before = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  const set = (v) => {
    for (const [k, x] of Object.entries(v)) if (x === undefined) delete process.env[k];
    else process.env[k] = x;
  };
  set(vars);
  let out;
  try {
    out = fn();
  } catch (e) {
    set(before);
    throw e;
  }
  if (out && typeof out.then === "function") return out.finally(() => set(before));
  set(before);
  return out;
}

/** The progress comment a stage writes with these lines at these times, under `vars` (the real reporter, a fake GitHub). */
async function progressBody(vars, objectiveBody = null) {
  const real = globalThis.fetch;
  const realNow = Date.now;
  const posted = [];
  globalThis.fetch = async (url, init = {}) => {
    const json = (v) => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
    if ((init.method || "GET") === "GET") return json([]);
    posted.push(JSON.parse(init.body).body);
    return json({ id: 9, user: { login: "me", type: "User" }, body: posted.at(-1) });
  };
  let t = at("2026-11-01T08:30:00Z");
  Date.now = () => t;
  try {
    return await withEnv(vars, async () => {
      const progress = progressReporter(repoOf("acme/app"), 7, { token: () => "t" }, { stage: "work", runId: "1", harness: "claude", model: "claude-opus-5-5", soFar: null });
      await progress("install");
      useObjectiveZone(objectiveBody);
      t += 3600_000;
      await progress("harness claude (claude-opus-5-5) attempt 1");
      t += 125 * 60_000;
      progress.spend(1.25, { usdByBilling: { api: 1.25 } });
      await progress("exit: delivered");
      return posted.at(-1);
    });
  } finally {
    useObjectiveZone(null);
    globalThis.fetch = real;
    Date.now = realNow;
  }
}

test("markers, spend lines and the scorecard's reads are byte-identical in any zone", async () => {
  const utc = await progressBody({ GITHUB_ACTIONS: "true", PENDULUM_TIME_ZONE: undefined });
  const la = await progressBody({ GITHUB_ACTIONS: "true", PENDULUM_TIME_ZONE: "America/Los_Angeles" });
  const tokyo = await progressBody({ GITHUB_ACTIONS: "true", PENDULUM_TIME_ZONE: "Europe/Berlin" }, zoneMarker("Asia/Tokyo"));
  // Each line written in the zone in force at the write (the Objective's once read), across the fall-back hour.
  assert.match(la, /^Pendulum work run 1: started 1:30 AM PDT<!-- 08:30Z -->, 185 min at the last line\.$/m);
  assert.match(la, /^- 1:30 AM PDT<!-- 08:30Z --> install\n- 1:30 AM PST<!-- 09:30Z --> harness claude/m);
  assert.match(utc, /^- 8:30 AM UTC<!-- 08:30Z --> install$/m);
  assert.match(tokyo, /^- 5:30 PM GMT\+9<!-- 08:30Z --> install$/m, "the whole comment in the Objective's zone once read");
  const hidden = (body) => body.split("\n").filter((l) => l.startsWith("<!--")).concat([...body.matchAll(/<!-- (\d\d:\d\dZ) -->/g)].map((m) => m[1]));
  assert.ok(hidden(utc).some((l) => l.startsWith("<!-- pendulum:spend ")), "the spend line is there");
  assert.deepEqual(hidden(la), hidden(utc));
  assert.deepEqual(hidden(tokyo), hidden(utc));
  // The scorecard reads the same phases and last write from each, and from a line written before the visible zone.
  const comment = (body) => ({ body, created_at: "2026-11-01T08:30:10Z", updated_at: "2026-11-01T11:35:00Z" });
  const legacy = utc.replace(/\d{1,2}:\d\d [AP]M UTC<!-- (\d\d:\d\dZ) -->/g, "$1");
  assert.match(legacy, /^- 08:30Z install$/m);
  for (const body of [la, tokyo, legacy]) {
    assert.deepEqual(phaseMinutes([comment(body)], 7), phaseMinutes([comment(utc)], 7));
    assert.equal(stageLastWrite(comment(body)), stageLastWrite(comment(utc)));
  }
  assert.equal(phaseMinutes([comment(utc)], 7).setupMinutes, 60);
  assert.equal(phaseMinutes([comment(utc)], 7).modelMinutes, 125);
  assert.ok(new RegExp(`^${LINE_CLOCK}$`).test("9:00 AM PST<!-- 17:00Z -->"));
  // The vendor comment's spend line is the same; only its visible line's time moves.
  const line = (vars) => withEnv(vars, () => vendorLine({ id: "pendulum-x", state: "stopped", cost: { usd: 0.5, vcpus: 2, memoryMb: 4096, activeCpuMs: 1000, wallMs: 2000 }, rates: {}, at: "2026-11-17T17:00:00Z" }));
  const vendor = (vars) => vendorBody({ line: line(vars), vendorUsd: 0.5 });
  assert.match(line({ GITHUB_ACTIONS: "true", PENDULUM_TIME_ZONE: "America/Los_Angeles" }), /^- 9:00 AM PST<!-- 17:00Z --> sandbox/);
  assert.equal(vendor({ GITHUB_ACTIONS: "true", PENDULUM_TIME_ZONE: "America/Los_Angeles" }).split("\n").at(-1), vendor({ GITHUB_ACTIONS: "true" }).split("\n").at(-1));
  assert.ok(vendor({ GITHUB_ACTIONS: "true" }).split("\n").at(-1).startsWith(spendMarker(0.5, { vendorUsd: 0.5 }).slice(0, -5)), "the spend line");
});

test("the finish card writes its times in the Objective's zone; its markers and summary stay byte-identical", () => {
  const real = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "finish-scratch-3.json"), "utf8"));
  const data = (body) => {
    setSelf("clockgrove-pendulum[bot]");
    try {
      return finishData({ repo: "clockgrove/pendulum-scratch", issue: { ...real.issue, body }, timeline: real.timeline, comments: real.comments, pulls: [{ pr: real.pr, timeline: real.prTimeline, reviews: real.reviews, reviewComments: real.reviewComments }], checks: real.checks, records: real.records });
    } finally {
      setSelf(null);
    }
  };
  const card = (vars, body = real.issue.body) => withEnv(vars, () => finishCardBody(data(body)));
  const utc = card({ GITHUB_ACTIONS: "true", PENDULUM_TIME_ZONE: undefined });
  const berlin = card({ GITHUB_ACTIONS: "true", PENDULUM_TIME_ZONE: "Europe/Berlin" });
  const la = card({ GITHUB_ACTIONS: "true", PENDULUM_TIME_ZONE: "Europe/Berlin" }, `${zoneMarker("America/Los_Angeles")}\n\n${real.issue.body}`);
  assert.match(utc, /merged (through your merge queue )?at \d{1,2}:\d\d [AP]M UTC · /);
  assert.match(utc, /\*\*Timeline\*\* \(UTC\)/);
  assert.match(berlin, /merged (through your merge queue )?at \d{1,2}:\d\d [AP]M GMT\+1 · /);
  assert.match(la, /\*\*Timeline\*\* \(PST\)/);
  assert.match(la, /\*\*Run log\*\* \(PST\)/);
  assert.match(la, /merged (through your merge queue )?at \d{1,2}:\d\d [AP]M PST · /);
  // The chart's bars sit on the zone's clock: Los Angeles is 8 hours behind UTC in November.
  const bars = (md) => [...md.matchAll(/:active, (\S+), (\S+)$/gm)].map((m) => [Date.parse(`${m[1]}Z`), Date.parse(`${m[2]}Z`)]);
  assert.ok(bars(utc).length > 0);
  assert.deepEqual(bars(la), bars(utc).map(([a, b]) => [a - 8 * 3600_000, b - 8 * 3600_000]));
  // The finish marker and the summary marker: the same bytes in every zone.
  const markers = (md) => md.split("\n").filter((l) => l.startsWith("<!--"));
  assert.equal(markers(utc).length, 3, "the finish, summary and end lines");
  assert.deepEqual(markers(berlin), markers(utc));
  assert.deepEqual(markers(la), markers(utc));
  assert.doesNotMatch(markers(la).join("\n"), /America|tz/);
  assert.equal(renderFinishCard(data(real.issue.body)).includes("UTC"), true, "the test's own env: GITHUB_ACTIONS unset, TZ UTC");
});
