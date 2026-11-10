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
  assert.match(sweepDecision({ ...base, sandbox: box({ state: "running" }) }).keep, /running/);
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
  assert.deepEqual(job.permissions, { contents: "read" });
  assert.equal(job.steps.filter((s) => String(s.uses).startsWith("actions/upload-artifact")).length, 3);
  assert.equal(String(doc.env.FACTORY_SANDBOX_IDLE_DAYS), "7");
  assert.equal(String(doc.env.FACTORY_SWEEP_MAX_DESTROYS), "5");
  assert.doesNotMatch(renderWorkflow(template, { harness: "claude", runs_on: "ubuntu-latest", action: "clockgrove/factory@v1.2.3" }), /mode: sweep|17 \* \* \* \*|FACTORY_SWEEP/);
});
