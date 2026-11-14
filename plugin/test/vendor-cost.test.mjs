// The sandbox vendor's cost: priced per stage from the vendor's usage totals at dated list rates, bounded before the
// stage starts (it comes off max_usd), booked on the progress comment (which daily_usd sums) and the usage record.
import "./temp.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkRates, harnessBudgetUsd, sessionCeilingUsd, stageVendorCost, storedUsd } from "../scripts/lib/adapters/sandbox.mjs";
import { VERCEL_RATES } from "../scripts/lib/adapters/sandbox-vercel.mjs";
import { spendOf, spendParts, vendorBody, vendorLine } from "../scripts/lib/logic.mjs";
import { progressRunId } from "../scripts/lib/session.mjs";
import { startedFields } from "../scripts/stage.mjs";
import { bookVendor, recordBody, stageEnvironment, stageProgressComment, stageProgressKey, startInSandbox } from "../scripts/launch.mjs";
import { setSelf } from "../scripts/lib/logic.mjs";

const R = VERCEL_RATES;
const H = 3_600_000;
const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: ${a} vs ${b}`);

test("rates: Vercel's are dated, sourced and complete, in one place", () => {
  assert.ok(checkRates(R));
  assert.equal(R.source, "https://vercel.com/docs/sandbox/pricing");
  assert.match(R.date, /^\d{4}-\d\d-\d\d$/);
  assert.equal(checkRates({ ...R, activeCpuHour: undefined }), false);
});

test("stage cost: the totals' difference at list rates, memory rounded up to the minute, the stopped stretch's storage beside it", () => {
  const before = { wallMs: 10 * 60_000, activeCpuMs: 60_000, memoryMb: 4096, vcpus: 2 };
  const after = { wallMs: 10 * 60_000 + 30 * 60_000 + 1, activeCpuMs: 60_000 + 6 * 60_000, memoryMb: 4096, vcpus: 2 };
  const c = stageVendorCost(R, { before, after, stored: { ms: 24 * H, bytes: 2e9 }, ceilingUsd: 1 });
  assert.equal(c.upperBound, false);
  assert.equal(c.activeCpuMs, 6 * 60_000);
  // 6 CPU-minutes, and 4 GB for 31 billed minutes (30 min and 1 ms rounds up).
  close(c.computeUsd, 0.1 * R.activeCpuHour + 4 * (31 / 60) * R.memoryGbHour, "compute");
  close(c.storedUsd, 2 * R.snapshotGbMonth * (24 / 730), "a day of a 2 GB stop snapshot");
  close(c.usd, c.computeUsd + c.storedUsd, "total");
  assert.equal(c.creationUsd, 0, "a resumed sandbox was not created");

  const fresh = stageVendorCost(R, { before: null, after, created: true });
  close(fresh.creationUsd, R.creation, "a created sandbox pays its creation");
  assert.equal(fresh.activeCpuMs, after.activeCpuMs, "created: the totals are all this stage's");
});

test("stage cost: an unread, partial or unsettled reading is the session's ceiling, flagged as an upper bound", () => {
  const after = { wallMs: 1000, activeCpuMs: 10, memoryMb: 4096, vcpus: 2 };
  for (const args of [{ before: null, after }, { before: { wallMs: 0, activeCpuMs: 0 }, after: null }, { before: { wallMs: 0, activeCpuMs: 0 }, after: { ...after, activeCpuMs: null } }, { before: { wallMs: 0, activeCpuMs: 0 }, after, settled: false }]) {
    const c = stageVendorCost(R, { ...args, ceilingUsd: 0.25, stored: { ms: H, bytes: 1e9 } });
    assert.equal(c.upperBound, true, JSON.stringify(args));
    close(c.usd, 0.25 + storedUsd(R, { ms: H, bytes: 1e9 }), "ceiling plus storage");
  }
  assert.equal(stageVendorCost(R, { before: null, after }).usd, null, "no ceiling recorded: unknown, never zero");
});

test("ceiling: every vCPU busy for the whole session plus its memory, so compute cannot pass it", () => {
  const ms = 45 * 60_000;
  const ceiling = sessionCeilingUsd(R, { vcpus: 2, ms, created: true });
  close(ceiling, 2 * 0.75 * R.activeCpuHour + 4 * 0.75 * R.memoryGbHour + R.creation, "45 minutes, 2 vCPU / 4 GB");
  const worst = stageVendorCost(R, { before: null, created: true, after: { wallMs: ms, activeCpuMs: 2 * ms, memoryMb: 4096, vcpus: 2 } });
  assert.ok(worst.usd <= ceiling + 1e-9, "a fully busy session costs the ceiling at most");
});

test("vendor comment: the vendor line carries state, seconds, size and dated rates; its spend line the vendor's dollars", () => {
  const cost = stageVendorCost(R, { before: { wallMs: 0, activeCpuMs: 0 }, after: { wallMs: 212_000, activeCpuMs: 41_200, memoryMb: 4096, vcpus: 2 }, stored: { ms: 3 * H, bytes: 1.2e9 } });
  const line = vendorLine({ id: "factory-a0dd", state: "stopped", cost, rates: R, at: "2026-11-09T01:16:30Z" });
  assert.match(line, /^- 01:16Z sandbox `factory-a0dd` stopped: 41\.2 s active CPU in 212\.0 s, 2 vCPU \/ 4 GB; vercel Pro list rates \(iad1, read 2026-11-08\): \$0\.1280\/CPU-hour, \$0\.0212\/GB-hour, \$0\.0800\/GB-month stored; vendor \$0\.\d{4} this stage; stopped 3\.0 h before it with 1\.20 GB saved: \$0\.\d{4}$/);
  const body = vendorBody({ line, vendorUsd: cost.usd });
  assert.ok(body.includes(line));
  close(spendOf(body), cost.usd, "daily_usd adds the vendor's dollars to the progress comment's model dollars");
  assert.deepEqual(spendParts(body), { usd: spendOf(body), modelUsd: null, vendorUsd: spendOf(body) });
  // A stage that left no progress comment: the usage record's model dollars are here, so the daily sum counts them.
  const alone = vendorBody({ line, vendorUsd: 0.01, modelUsd: 2 });
  close(spendOf(alone), 2.01, "model from the usage record");
  close(spendParts(alone).modelUsd, 2);
  // An upper bound says so; nothing but codes and numbers reaches the comment.
  const bound = vendorLine({ id: "factory-a0dd", state: "running", cost: stageVendorCost(R, { before: null, after: null, ceilingUsd: 0.2 }), rates: R, error: "unavailable" });
  assert.match(bound, /running: usage not settled \(unavailable\), counted at the session's ceiling, .* vendor at most \$0\.2000 this stage/);
  assert.match(vendorLine({ id: "factory-x", state: "stopped", cost, rates: R, error: "vercel: <b>secret text</b>" }), /\(\?\)|stopped/);
  assert.ok(!vendorLine({ id: "factory-x", state: "stopped", cost: { ...cost, upperBound: true }, rates: R, error: "vercel: secret text" }).includes("secret"), "a vendor message never reaches the comment");
});

test("progress key: the launcher names the stage's comment, so the end finds it; the record shows the stage's sandbox cost", () => {
  assert.equal(stageProgressKey("42544172935", "f75ee5806153"), "42544172935-f75ee5806153");
  assert.equal(stageProgressKey("", "f75ee5806153"), "f75ee5806153", "a stage started outside an Actions run has no run id");
  assert.equal(progressRunId({ FACTORY_PROGRESS_RUN: "7-abc", GITHUB_RUN_ID: "7" }), "7-abc");
  // The end finds the comment by the stage's claim alone (the record's other fields can be lost to a race).
  setSelf("factory-app[bot]");
  const bot = { login: "factory-app[bot]", type: "Bot" };
  const claim = "2f176ca16e06";
  const comments = [
    { id: 1, user: bot, body: `<!-- factory:240:progress:work:42564473403-${claim} -->\nFactory work` },
    { id: 2, user: { login: "someone", type: "User" }, body: `<!-- factory:240:progress:review:${claim} -->\nforged` },
    { id: 3, user: bot, body: `<!-- factory:240:progress:review:${claim} -->\nFactory review` },
  ];
  assert.equal(stageProgressComment(comments, 240, "work", claim)?.id, 1);
  assert.equal(stageProgressComment(comments, 240, "review", claim)?.id, 3, "only Factory's own");
  assert.equal(stageProgressComment(comments, 240, "work", "000000000000"), null);
  assert.equal(stageProgressComment(comments, 24, "work", claim), null, "another Objective's number does not match");
  assert.equal(progressRunId({ FACTORY_PROGRESS_RUN: "bad key!", GITHUB_RUN_ID: "7" }), "7");
  const env = stageEnvironment({ inputs: { harness: "claude", model: "m" }, env: {}, stage: "work", issue: 3, claim: "abc", tokens: { write: "w" }, runId: "9" });
  assert.equal(env.FACTORY_PROGRESS_RUN, "9-abc");
  assert.match(recordBody({ id: "factory-a", vendor: "vercel", stage: "work", state: "stopped", exitCode: 0, vendorUsd: 0.0123 }), /sandbox stopped; sandbox cost \$0\.0123 this stage/);
  // The start's readings live under `meter`: the record's `vendor` is the vendor's name, and stays so (found live).
  assert.match(recordBody({ id: "factory-a", vendor: "vercel", meter: { ceilingUsd: 0.25 }, stage: "work", state: "running" }), /`factory-a` \(vercel\)/);
});

const fakeAdapter = (over = {}) => {
  const calls = [];
  const adapter = {
    rates: R,
    calls,
    list: async () => [{ id: "factory-abc", state: "stopped", tags: { factory: "objective", "factory-repo": "1", "factory-issue": "7" } }],
    usage: async () => (calls.push("usage"), { wallMs: 600_000, activeCpuMs: 90_000, memoryMb: 4096, vcpus: 2, storedBytes: 1.5e9 }),
    resume: async () => (calls.push("resume"), { expiresAt: new Date(Date.now() + 45 * 60_000).toISOString() }),
    extend: async () => {
      throw Object.assign(new Error("no"), { code: "invalid" });
    },
    stop: async () => calls.push("stop"),
    writeFiles: async () => {},
    run: async (id, spec) => {
      if (spec.argv.includes("factory-probe")) spec.onStdout("/vercel\nhave\n");
      else {
        adapter.startEnv = spec.env;
        spec.onStdout(`${Date.now()}\n`);
      }
      return { exitCode: 0 };
    },
    ...over,
  };
  return adapter;
};
const start = (adapter, extra) => startInSandbox({ adapter, repo: { owner: "o", name: "r", full: "o/r" }, repoId: "1", issue: 7, recordedId: "factory-abc", baseImage: "base", claim: "c1", env: { FACTORY_TIMEOUT_MINUTES: "30", FACTORY_MAX_USD: "20" }, budgetMs: 46 * 60_000, vcpus: 2, harness: "claude", plugin: { digest: "d", tgz: Buffer.from("") }, ...extra });

test("start: the totals are read before the resume, the stopped stretch is priced, and the harness gets max_usd less the vendor's most", async () => {
  const adapter = fakeAdapter();
  const stoppedAt = new Date(Date.now() - 2 * H).toISOString();
  const r = await start(adapter, { maxUsd: 20, stoppedAt });
  assert.deepEqual(adapter.calls.slice(0, 2), ["usage", "resume"], "the baseline is the stopped sandbox's totals");
  assert.deepEqual(r.meter.base, { wallMs: 600_000, activeCpuMs: 90_000 });
  assert.equal(r.vendor, undefined, "nothing named `vendor` to spread over the record's vendor name");
  assert.equal(r.meter.created, false);
  assert.ok(Math.abs(r.meter.stored.ms - 2 * H) < 5000 && r.meter.stored.bytes === 1.5e9, "two hours of a 1.5 GB stop snapshot");
  const storage = storedUsd(R, r.meter.stored);
  const budget = Number(adapter.startEnv.FACTORY_MAX_USD);
  assert.ok(budget < 20 && budget > 19, `the harness's budget leaves room for the sandbox (${budget})`);
  assert.ok(budget + r.meter.ceilingUsd + storage <= 20, "model and vendor together stay under max_usd");
  assert.equal(r.meter.harnessUsd, budget);
  // The stage gets the record's start fields and writes them with every beat (a beat can land over the launcher's write).
  assert.deepEqual(startedFields(adapter.startEnv.FACTORY_STAGE_RECORD), { id: "factory-abc", home: "/vercel", meter: r.meter, image: null, sessionEnd: r.sessionEnd });
  assert.deepEqual(startedFields(JSON.stringify({ id: "x; rm", home: "rel", meter: { ceilingUsd: "1" } })), {}, "only plain shapes pass");
  assert.deepEqual(startedFields("not json"), {});

  // No cap set: nothing taken off, nothing passed.
  const free = fakeAdapter();
  await start(free, { maxUsd: 0 });
  assert.equal(free.startEnv.FACTORY_MAX_USD, "20", "the setting as it was (0 means no cap; this env's value is the fake's)");

  // A cap the session's ceiling eats starts nothing: the sandbox is stopped and the code is not transient.
  const tight = fakeAdapter();
  await assert.rejects(start(tight, { maxUsd: 0.05 }), (e) => e.code === "budget");
  assert.ok(tight.calls.includes("stop"));

  // A usage read that fails starts the stage anyway; its end counts the ceiling.
  const blind = fakeAdapter({ usage: async () => Promise.reject(Object.assign(new Error("x"), { code: "unavailable" })) });
  const b = await start(blind, { maxUsd: 20 });
  assert.equal(b.meter.base, null);
});

test("book: the vendor's cost goes into the usage record beside the model's, or a record of its own when the stage left none", async () => {
  const dir = mkdtempSync(join(tmpdir(), "factory-vendor-"));
  writeFileSync(join(dir, "result.json"), JSON.stringify({ harness: "claude", usd: 0.4, runs: 1 }));
  const record = { id: "factory-abc", vendor: "vercel", stage: "work", claim: "c1", meter: { base: { wallMs: 0, activeCpuMs: 0 }, created: false, ceilingUsd: 0.3, stored: { ms: 0, bytes: null }, vcpus: 2 } };
  const adapter = { rates: R };
  const after = { wallMs: 120_000, activeCpuMs: 30_000, memoryMb: 4096, vcpus: 2 };
  const r = await bookVendor({ adapter, repo: { full: "o/r" }, n: 7, opts: {}, record, after, settled: true, state: "stopped", usage: { dir, name: "factory-usage-7" } });
  const rec = JSON.parse(readFileSync(join(dir, "result.json"), "utf8"));
  assert.equal(rec.usd, 0.4, "the model's dollars are untouched");
  assert.equal(rec.vendor.usd, r.vendor.usd);
  assert.equal(rec.vendor.upperBound, false);
  assert.equal(rec.vendor.rates.date, R.date);
  assert.equal(rec.vendor.sandbox, "factory-abc");

  process.env.RUNNER_TEMP = mkdtempSync(join(tmpdir(), "factory-vendor-rt-"));
  const none = await bookVendor({ adapter, repo: { full: "o/r" }, n: 7, opts: {}, record: { ...record, stage: "review" }, after: null, settled: true, state: "stopped", usage: null, harness: "claude", error: "unavailable" });
  assert.equal(none.usage.name, "factory-usage-7-review");
  const own = JSON.parse(readFileSync(join(none.usage.dir, "result.json"), "utf8"));
  assert.equal(own.usd, null, "the model's dollars are unknown, never zero");
  assert.equal(own.spendInProgress, true, "the stage's progress comment carries its spend: daily_usd counts it there, once");
  assert.equal(own.vendor.upperBound, true);
  close(own.vendor.usd, 0.3, "the session's ceiling");
  assert.equal(own.harness, "claude", "a record with no harness: the caller's");
  // A stage on an Objective's label harness (#224): its record names it, whatever the repository's default.
  const labelled = await bookVendor({ adapter, repo: { full: "o/r" }, n: 7, opts: {}, record: { ...record, claim: "c2", harness: "codex" }, after: null, settled: true, state: "stopped", usage: null, harness: "claude", error: "unavailable" });
  assert.equal(JSON.parse(readFileSync(join(labelled.usage.dir, "result.json"), "utf8")).harness, "codex");

  assert.deepEqual(await bookVendor({ adapter, repo: { full: "o/r" }, n: 7, opts: {}, record: { id: "factory-abc", stage: "work" }, after, settled: true, state: "stopped" }), { usage: null, vendor: null }, "a stage started before vendor costs were recorded books nothing");
});

test("budget: max_usd is split in one place; the harness gets what the vendor's most leaves, or the stage does not start", () => {
  assert.equal(harnessBudgetUsd(20, { ceilingUsd: 0.26, storageUsd: 0.0002 }), 19.73, "floored to the cent, so both stay under max_usd");
  assert.equal(harnessBudgetUsd(0, { ceilingUsd: 0.26 }), 0, "no cap set: none taken off");
  assert.equal(harnessBudgetUsd(0.2, { ceilingUsd: 0.26 }), null, "the vendor's most eats the cap");
  assert.equal(harnessBudgetUsd(20, { ceilingUsd: null }), null, "a session the vendor's cost cannot be bounded for does not start under a cap");
  assert.equal(harnessBudgetUsd(20, { ceilingUsd: 0.26, storageUsd: Number.NaN }), 19.74, "storage that cannot be read is none");
});
