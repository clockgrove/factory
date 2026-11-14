import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { OPERATIONS } from "../scripts/lib/adapters/sandbox.mjs";
import { PREVIOUS_IMAGE_MS, imagePrune, prunableImages } from "../scripts/lib/image.mjs";
import { QUOTA_BACKOFF_MS, QUOTA_MAX_TRIES, QUOTA_WAIT_MS, quotaBackoff, quotaWaiting, selectReady, sweepDecision } from "../scripts/lib/logic.mjs";
import { storageLine } from "../scripts/sweep.mjs";
import { renderWorkflow } from "../scripts/setup.mjs";
import { parseYaml } from "../scripts/lib/yaml.mjs";

const NOW = Date.parse("2026-11-20T12:00:00Z");
const MIN = 60_000;
const iso = (ms) => new Date(ms).toISOString();

test("quota: a refused start waits 5, 10, then 20 minutes between tries, and gives up once the wait is spent", () => {
  const first = quotaBackoff(null, NOW);
  assert.deepEqual(first, { since: iso(NOW), tries: 1, retryAt: iso(NOW + QUOTA_BACKOFF_MS[0]) });
  const second = quotaBackoff(first, NOW + 5 * MIN);
  assert.deepEqual(second, { since: iso(NOW), tries: 2, retryAt: iso(NOW + 15 * MIN) });
  const third = quotaBackoff(second, NOW + 15 * MIN);
  assert.equal(third.retryAt, iso(NOW + 35 * MIN));
  assert.equal(quotaBackoff({ ...third, tries: 5 }, NOW + 80 * MIN).retryAt, iso(NOW + QUOTA_WAIT_MS), "never past the wait's end");
  const done = quotaBackoff(third, NOW + QUOTA_WAIT_MS);
  assert.equal(done.giveUp, true);
  assert.equal(done.waitedMs, QUOTA_WAIT_MS);
  assert.deepEqual(quotaBackoff({ since: iso(NOW - 25 * 3600_000), tries: 4, retryAt: iso(NOW - 24 * 3600_000) }, NOW), first, "a past episode's streak starts again");
  assert.deepEqual(quotaBackoff({ since: "junk", tries: "x", retryAt: 5 }, NOW), first, "a malformed streak starts again");
});

test("quota: a late retry (the cron fired hours late) gives up instead of starting a new wait; tries are capped", () => {
  const first = quotaBackoff(null, NOW);
  const late = quotaBackoff(first, NOW + 3 * 3600_000);
  assert.equal(late.giveUp, true, "three hours after the first refusal, past the 90-minute wait");
  assert.equal(late.tries, 2);
  assert.equal(late.since, first.since);
  let q = first;
  for (let i = 2; i < QUOTA_MAX_TRIES; i++) q = quotaBackoff(q, NOW + i * 1000);
  assert.ok(!q.giveUp && q.tries === QUOTA_MAX_TRIES - 1);
  assert.equal(quotaBackoff(q, NOW + 10_000).giveUp, true, "the eighth refusal gives up however fast it came");
});

test("quota: the dispatcher waits out the retry time; a Queued Objective that waits is skipped with its reason", () => {
  assert.equal(quotaWaiting({ quota: { retryAt: iso(NOW + MIN) } }, NOW), true);
  assert.equal(quotaWaiting({ quota: { retryAt: iso(NOW - MIN) } }, NOW), false);
  assert.equal(quotaWaiting(null, NOW), false);
  const issues = [{ number: 1, labels: [] }, { number: 2, labels: [] }];
  const r = selectReady({ issues, maxConcurrent: 2, dailyUsd: 0, deferred: { 1: "the sandbox vendor's quota refused its last start" } });
  assert.deepEqual(r.ready, [2]);
  assert.deepEqual(r.skipped, [{ number: 1, reason: "the sandbox vendor's quota refused its last start" }]);
});

test("sweep: the record's own sandbox is judged at once when its Objective closes; an unrecorded young one waits", () => {
  const young = { id: "factory-aaa", state: "stopped", createdAt: iso(NOW - 5 * MIN), tags: {} };
  const rec = { id: "factory-aaa", state: "stopped", stage: "review", at: iso(NOW - MIN), claim: "c1", home: "/vercel", collected: true };
  const base = { sandbox: young, issue: { state: "closed" }, state: null, record: rec, holds: false, now: NOW, idleMs: 7 * 86_400_000, graceMs: 15 * MIN };
  assert.deepEqual(sweepDecision(base), { destroy: "its Objective is closed", collect: false }, "a seven-minute Objective's sandbox goes when it closes");
  assert.equal(sweepDecision({ ...base, record: null }).keep, "created moments ago");
  assert.equal(sweepDecision({ ...base, record: { ...rec, id: "factory-bbb" } }).keep, "created moments ago");
  assert.equal(sweepDecision({ ...base, holds: true }).keep, "a stage holds it", "never a running stage's");
  assert.equal(sweepDecision({ ...base, issue: { state: "open" }, state: "In review" }).keep, "the Objective is In review", "an open Objective keeps its stop snapshot");
});

test("images: the current one stays, an older recorded one until no stage can still be starting from it, the rest go", () => {
  const images = ["new", "cur", "prev", "old", "older", "stray"].map((source) => ({ source, snapshot: `snap_${source}` }));
  const rec = (source, endMs) => ({ source, snapshot: `snap_${source}`, builtAt: iso(endMs - 90_000), buildMs: 90_000 });
  const T = NOW - 20 * MIN;
  const current = rec("cur", T);
  const verified = [rec("new", T + 30 * MIN), current, rec("prev", T - 3 * MIN), rec("old", T - 60 * MIN), rec("older", T - 120 * MIN)];
  const pruned = (now, list = images, cur = current) => prunableImages(list, cur, verified, now).map((i) => i.source);
  assert.deepEqual(pruned(T + MIN), ["older", "stray"], "two builds a few minutes apart: both before the current stay; one superseded an hour ago and an unrecorded one go");
  assert.deepEqual(pruned(T - 3 * MIN + PREVIOUS_IMAGE_MS + MIN), ["old", "older", "stray"], "the one two back goes 15 min after the one before the current superseded it");
  assert.deepEqual(pruned(T + PREVIOUS_IMAGE_MS), ["prev", "old", "older", "stray"], "past the hand-over: all older go");
  assert.deepEqual(prunableImages(images, null, verified, NOW), [], "no confirmed current image: nothing goes");
  assert.deepEqual(prunableImages(images, { ...current, source: "gone" }, verified, NOW), [], "a current the listing does not show: nothing goes");
  assert.deepEqual(pruned(NOW, images.slice(1, 2)), [], "only the current: it stays");
  assert.ok(!pruned(NOW).includes("new"), "a newer image (being recorded, or off the default branch) stays");
  // When the first image kept for a starting stage becomes prunable: the sweep's own next run.
  assert.equal(imagePrune(images, current, verified, T + MIN).until, T - 3 * MIN + PREVIOUS_IMAGE_MS, "the one two back, superseded 3 minutes before the current");
  assert.equal(imagePrune(images, current, verified, T + PREVIOUS_IMAGE_MS).until, null, "none kept: no wait");
});

test("storage: one line of numbers; the adapter contract has storage", () => {
  assert.ok(OPERATIONS.includes("storage"));
  assert.equal(storageLine({ repo: { sandboxes: 3, snapshots: 3, bytes: 5.4e9 }, project: { snapshots: 7, bytes: 12.6e9, limitBytes: null } }), "this repository 3 snapshot(s), 5.40 GB in 3 sandbox(es); the vendor project 7 snapshot(s), 12.60 GB (the vendor's API states no limit)");
  assert.match(storageLine({ repo: { sandboxes: 0, snapshots: 0, bytes: 0 }, project: { snapshots: 1, bytes: 1e9, limitBytes: 15e9 } }), /1\.00 GB of 15\.00 GB$/);
  assert.match(storageLine({ repo: { sandboxes: 0, snapshots: 0, bytes: 0 }, project: null }), /the vendor project unread$/);
});

test("workflow template: the sweep also runs when an Objective closes or its PR merges, in sandbox mode only; any closed issue ticks the dispatcher", () => {
  const template = readFileSync(join(import.meta.dirname, "..", "workflow-template.yml"), "utf8");
  const sandbox = parseYaml(renderWorkflow(template, { harness: "claude", runs_on: "ubuntu-latest", action: "clockgrove/factory@v1.2.3", sandbox: "vercel", ci_workflow: "Quality", default_branch: "main" }));
  const runner = parseYaml(renderWorkflow(template, { harness: "claude", runs_on: "ubuntu-latest", action: "clockgrove/factory@v1.2.3" }));
  // `unlabeled`: a removed factory:objective label (a person's stop) ticks the dispatcher, which leaves its PR a draft.
  assert.deepEqual(sandbox.on.issues.types, ["opened", "labeled", "unlabeled", "closed"]);
  assert.deepEqual(runner.on.issues.types, ["opened", "labeled", "unlabeled", "closed"]);
  const cond = sandbox.jobs.sweep.if;
  assert.match(cond, /github\.event_name == 'issues' && github\.event\.action == 'closed' && contains\(join\(github\.event\.issue\.labels\.\*\.name, ','\), 'factory:objective'\)/);
  assert.match(cond, /github\.event\.pull_request\.merged == true && startsWith\(github\.head_ref, 'factory\/'\) && github\.event\.pull_request\.head\.repo\.full_name == github\.repository/);
  // A closed issue may have blocked an Objective (a plain issue fires no other event Factory hears): every route ticks.
  for (const wf of [sandbox, runner]) assert.match(wf.jobs.dispatch.if, /github\.event_name == 'issues' && \(github\.event\.action == 'closed' \|\|/);
  assert.doesNotMatch(runner.jobs.sweep?.if ?? "", /closed/, "no sweep job without a sandbox");
});
