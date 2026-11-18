// Visible times in a chosen zone (#586): the Objective's own zone line, the repository's PENDULUM_TIME_ZONE, the
// machine's zone in local mode, else UTC; machine-read text (hidden markers, spend lines, the summary) stays ISO UTC.
import "./temp.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { LINE_CLOCK, clockText, lineClock, logTime, objectiveZone, repositoryZone, timeZone, useObjectiveZone, whenText, zoneMarker } from "../scripts/lib/clock.mjs";
import { VARIABLE_SETTINGS, WORKFLOW_SETTINGS, machineSettings, resolveInputs, settingLayers, timeZoneName, variableSettings } from "../scripts/lib/inputs.mjs";
import { setSelf, spendMarker, vendorBody, vendorLine } from "../scripts/lib/logic.mjs";
import { progressReporter } from "../scripts/lib/session.mjs";
import { repoOf } from "../scripts/lib/github.mjs";
import { finishCardBody, finishData, renderFinishCard } from "../scripts/lib/finish-card.mjs";
import { Local, takeZone } from "../scripts/local.mjs";
import { timeZoneCheck } from "../scripts/doctor.mjs";
import { phaseMinutes, stageLastWrite } from "../../bench/lib/phases.mjs";

const PLUGIN = join(import.meta.dirname, "..");
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

test("a given zone renders with its abbreviation across both of its daylight-saving changes", () => {
  const env = { GITHUB_ACTIONS: "true", PENDULUM_TIME_ZONE: "America/Los_Angeles" };
  // Spring forward, 2026-03-08: 1:59 AM PST, then 3:00 AM PDT a minute later.
  assert.equal(clockText(at("2026-03-08T09:59:00Z"), { env }), "1:59 AM PST");
  assert.equal(clockText(at("2026-03-08T10:00:00Z"), { env }), "3:00 AM PDT");
  // Fall back, 2026-11-01: 1:30 AM twice, an hour apart, told apart by the abbreviation.
  assert.equal(clockText(at("2026-11-01T08:30:00Z"), { env }), "1:30 AM PDT");
  assert.equal(clockText(at("2026-11-01T09:30:00Z"), { env }), "1:30 AM PST");
  assert.equal(whenText(at("2026-11-17T17:00:05Z"), { env }), "Nov 17, 9:00 AM PST");
  assert.equal(clockText(at("2026-11-17T17:00:05Z"), { env, seconds: true }), "9:00:05 AM PST");
  assert.equal(logTime(at("2026-11-17T17:00:12Z"), { env }), "Nov 17, 9:00:12 AM PST", "a log line keeps the seconds");
  // Intl's short name: an offset where the zone has no abbreviation in English.
  assert.equal(clockText(at("2026-11-17T17:00:00Z"), { env: { GITHUB_ACTIONS: "true", PENDULUM_TIME_ZONE: "Europe/Berlin" } }), "6:00 PM GMT+1");
  // A progress line's clock: the zone's time, then its UTC minute hidden.
  assert.equal(lineClock(at("2026-11-17T17:00:05Z"), { env }), "9:00 AM PST<!-- 17:00Z -->");
  assert.equal(clockText(NaN, { env }), "?");
});

test("local mode and a command run by hand default to the machine's zone; the setting wins over it", () => {
  withEnv({ TZ: "Asia/Tokyo" }, () => {
    assert.deepEqual(timeZone({ PENDULUM_LOCAL: "1" }), { zone: "Asia/Tokyo", from: "machine", set: null, invalid: null });
    assert.equal(timeZone({}).zone, "Asia/Tokyo", "a command run by hand, on neither Actions nor a sandbox");
    assert.equal(clockText(at("2026-11-17T17:00:00Z"), { env: { PENDULUM_LOCAL: "1" } }), "2:00 AM GMT+9");
    assert.equal(timeZone({ PENDULUM_LOCAL: "1", PENDULUM_TIME_ZONE: "Europe/Berlin" }).zone, "Europe/Berlin");
  });
  // `pendulum zone`, the line pendulum-file starts an Objective's body with, names this machine's zone.
  const cli = (TZ) => execFileSync(process.execPath, [join(PLUGIN, "scripts", "local.mjs"), "zone"], { env: { PATH: process.env.PATH, HOME: process.env.HOME, TZ }, encoding: "utf8" });
  assert.equal(cli("America/Los_Angeles"), "<!-- pendulum:tz America/Los_Angeles -->\n");
  assert.equal(objectiveZone(`${cli("Asia/Tokyo")}\n## Goal\nA thing.`), "Asia/Tokyo");
});

test("on Actions and in the cloud sandbox the default is UTC, whatever the machine's zone", () => {
  withEnv({ TZ: "Asia/Tokyo" }, () => {
    assert.deepEqual(timeZone({ GITHUB_ACTIONS: "true" }), { zone: "UTC", from: "utc", set: null, invalid: null });
    assert.equal(timeZone({ PENDULUM_STAGE_CLAIM: "c1" }).zone, "UTC", "a cloud sandbox's stage");
    assert.equal(timeZone({ PENDULUM_STAGE_SANDBOX: "1" }).zone, "UTC", "the stage a cloud sandbox's stage.mjs starts");
    assert.equal(clockText(at("2026-11-17T17:00:00Z"), { env: { GITHUB_ACTIONS: "true" } }), "5:00 PM UTC");
    // The setting, from the env block or a repository variable (laid over the env) or `with:`.
    // The name as given, when Intl knows it: `EST` is not shown as ICU's America/Panama.
    assert.equal(timeZone({ GITHUB_ACTIONS: "true", PENDULUM_TIME_ZONE: "EST" }).zone, "EST");
    assert.equal(clockText(at("2026-11-17T17:00:00Z"), { env: { GITHUB_ACTIONS: "true", PENDULUM_TIME_ZONE: "EST" } }), "12:00 PM EST");
    assert.equal(timeZone({ GITHUB_ACTIONS: "true", PENDULUM_INPUT_TIME_ZONE: "Europe/Berlin", PENDULUM_TIME_ZONE: "Asia/Tokyo" }).zone, "Europe/Berlin");
  });
});

test("an invalid zone name is reported and ignored, for the default", () => {
  for (const bad of ["Mars/Olympus_Mons", "+05:30", "PST8PDT x", "../etc"]) {
    assert.equal(timeZoneName(bad), null, bad);
    assert.deepEqual(timeZone({ GITHUB_ACTIONS: "true", PENDULUM_TIME_ZONE: bad }), { zone: "UTC", from: "utc", set: null, invalid: bad });
  }
  // A repository variable with it is named and ignored, as any value Pendulum would not take.
  const v = variableSettings({ PENDULUM_TIME_ZONE: "Mars/Olympus_Mons", PENDULUM_MAX_USD: "5" });
  assert.deepEqual(v.kept, { PENDULUM_MAX_USD: "5" });
  assert.deepEqual(v.invalid.map((x) => x.name), ["PENDULUM_TIME_ZONE"]);
  assert.deepEqual(variableSettings({ PENDULUM_TIME_ZONE: "Europe/Berlin" }).kept, { PENDULUM_TIME_ZONE: "Europe/Berlin" });
  assert.ok(WORKFLOW_SETTINGS.has("PENDULUM_TIME_ZONE") && VARIABLE_SETTINGS.has("PENDULUM_TIME_ZONE"));
  // Doctor's row: the zone in force, or a WARN naming the one it ignores.
  const bad = timeZoneCheck({ PENDULUM_TIME_ZONE: "Mars/Olympus_Mons" });
  assert.equal(bad.status, "WARN");
  assert.match(bad.detail, /"Mars\/Olympus_Mons" is no IANA time zone name, so it is ignored/);
  assert.equal(timeZoneCheck({ PENDULUM_TIME_ZONE: "Europe/Berlin" }).status, "PASS");
  assert.match(timeZoneCheck({ PENDULUM_TIME_ZONE: "Europe/Berlin" }).detail, /^visible times are written in Europe\/Berlin \(PENDULUM_TIME_ZONE\)/);
  assert.match(timeZoneCheck({}).detail, /^PENDULUM_TIME_ZONE is not set: visible times are written in this machine's zone \(UTC\) in local mode, UTC on Actions/);
  assert.equal(resolveInputs({ args: { time_zone: "Asia/Tokyo" }, env: {} }).timeZone, "Asia/Tokyo", "setup's --time-zone");
});

test("an Objective's zone line wins over the repository's setting on the Actions path; an invalid one falls through", () => {
  const env = { GITHUB_ACTIONS: "true", PENDULUM_TIME_ZONE: "Europe/Berlin" };
  const body = `${zoneMarker("America/Los_Angeles")}\n\n## Goal\nA thing.\n\n## Acceptance\n- it works`;
  assert.equal(objectiveZone(body), "America/Los_Angeles");
  assert.deepEqual(timeZone(env, { objective: objectiveZone(body) }), { zone: "America/Los_Angeles", from: "objective", set: "Europe/Berlin", invalid: null });
  // Only the body's first line counts: a later one, a fenced example or a quoted one names nothing.
  const fenced = `## Goal\nA thing.\n\n\`\`\`\n${zoneMarker("Asia/Tokyo")}\n\`\`\`\n`;
  assert.equal(objectiveZone(`${zoneMarker("America/Los_Angeles")}\r\n\n${fenced}`), "America/Los_Angeles", "the real first line, beside a fenced example");
  assert.equal(objectiveZone(`${zoneMarker("Asia/Tokyo")}\n${zoneMarker("Europe/Paris")}`), "Asia/Tokyo");
  // Invalid, or not the body's first line: no Objective zone, so the setting applies.
  for (const b of [fenced, `\`\`\`\n${zoneMarker("Asia/Tokyo")}\n\`\`\``, `x\n${zoneMarker("Asia/Tokyo")}`, `> ${zoneMarker("Asia/Tokyo")}`, ` ${zoneMarker("Asia/Tokyo")}`, "<!-- pendulum:tz Mars/Olympus_Mons -->\nx", "<!-- pendulum:tz +05:30 -->", `see ${zoneMarker("Asia/Tokyo")}`, `${zoneMarker("Asia/Tokyo")} x`, "<!-- pendulum:tz  Asia/Tokyo -->", "<!--pendulum:tz Asia/Tokyo-->", null]) {
    assert.equal(objectiveZone(b), null, String(b));
    assert.equal(timeZone(env, { objective: objectiveZone(b) }).zone, "Europe/Berlin", String(b));
  }
  // A stage takes the zone once it has read its issue (worker.mjs, review.mjs), for every time it writes after.
  try {
    assert.equal(useObjectiveZone(body), "America/Los_Angeles");
    assert.equal(clockText(at("2026-11-17T17:00:00Z"), { env }), "9:00 AM PST");
    assert.equal(useObjectiveZone("<!-- pendulum:tz Mars/Olympus_Mons -->"), null);
    assert.equal(clockText(at("2026-11-17T17:00:00Z"), { env }), "6:00 PM GMT+1");
    // The shared holds issue is no one Objective's: its comments take the repository's zone, whatever this stage's.
    useObjectiveZone(body);
    assert.equal(repositoryZone(env), "Europe/Berlin");
    assert.equal(whenText(at("2026-11-17T17:00:00Z"), { env, zone: repositoryZone(env) }), "Nov 17, 6:00 PM GMT+1");
  } finally {
    useObjectiveZone(null);
  }
});

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

test("serve and its stages take the repository's zone, else the developer's shell's, else the machine's", () => {
  const env = {};
  takeZone({ PENDULUM_TIME_ZONE: "Europe/Berlin" }, env, "Asia/Tokyo");
  assert.equal(env.PENDULUM_TIME_ZONE, "Europe/Berlin", "the repository's wins");
  takeZone({}, env, "Asia/Tokyo");
  assert.equal(env.PENDULUM_TIME_ZONE, "Asia/Tokyo", "the shell's where the repository sets none");
  takeZone({}, env, undefined);
  assert.ok(!("PENDULUM_TIME_ZONE" in env));
  // The layers serve and doctor report, and the settings a local stage gets (machineSettings over the repository's).
  const shell = { PENDULUM_TIME_ZONE: "Asia/Tokyo", PENDULUM_MODEL: "m" };
  assert.deepEqual(machineSettings(shell, { PENDULUM_TIME_ZONE: "Europe/Berlin" }), { PENDULUM_MODEL: "m" });
  assert.deepEqual(machineSettings(shell, {}), shell);
  const layered = (workflow) => settingLayers({ workflow, machine: shell });
  assert.deepEqual([layered({ PENDULUM_TIME_ZONE: "Europe/Berlin" }).values.PENDULUM_TIME_ZONE, layered({ PENDULUM_TIME_ZONE: "Europe/Berlin" }).from.PENDULUM_TIME_ZONE], ["Europe/Berlin", "workflow"]);
  assert.deepEqual([layered({}).values.PENDULUM_TIME_ZONE, layered({}).from.PENDULUM_TIME_ZONE], ["Asia/Tokyo", "machine"]);
  assert.equal(layered({ PENDULUM_MODEL: "w" }).values.PENDULUM_MODEL, "m", "the other machine settings still win");
  // A local stage's env (serve's baseEnv): the repository's zone, else the shell's.
  withEnv({ PENDULUM_TIME_ZONE: "Asia/Tokyo" }, () => {
    const loop = Object.assign(Object.create(Local.prototype), { wf: { PENDULUM_TIME_ZONE: "Europe/Berlin" }, harness: "claude" });
    assert.equal(loop.baseEnv().PENDULUM_TIME_ZONE, "Europe/Berlin");
    loop.wf = {};
    assert.equal(loop.baseEnv().PENDULUM_TIME_ZONE, "Asia/Tokyo");
  });
});
