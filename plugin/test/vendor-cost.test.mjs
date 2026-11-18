// The sandbox vendor's cost: priced per stage from the vendor's usage totals at dated list rates, bounded before the
// stage starts (it comes off max_usd), booked on the progress comment (which daily_usd sums) and the usage record.
import "./temp.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { harnessBudgetUsd, sessionCeilingUsd, stageVendorCost, storedUsd } from "../scripts/lib/adapters/sandbox.mjs";
import { VERCEL_RATES } from "../scripts/lib/adapters/sandbox-vercel.mjs";
import { spendOf, spendParts, vendorBody, vendorLine } from "../scripts/lib/logic.mjs";
import { startedFields } from "../scripts/stage.mjs";
import { bookVendor, startInSandbox } from "../scripts/launch.mjs";

const R = VERCEL_RATES;
const H = 3_600_000;
const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: ${a} vs ${b}`);

test("stage cost: the totals' difference at list rates, memory rounded up to the minute, the stopped stretch's storage beside it", () => {
  const before = { wallMs: 10 * 60_000, activeCpuMs: 60_000, memoryMb: 4096, vcpus: 2 };
  const after = { wallMs: 10 * 60_000 + 30 * 60_000 + 1, activeCpuMs: 60_000 + 6 * 60_000, memoryMb: 4096, vcpus: 2 };
  const c = stageVendorCost(R, { before, after, stored: { ms: 24 * H, bytes: 2e9 } });
  assert.equal(c.upperBound, undefined, "no bound: the vendor's own totals");
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

test("stage cost: an unread, partial or unsettled reading leaves the compute unknown, never the session's ceiling or $0; the stored bytes stay real; its spend line says so", () => {
  const after = { wallMs: 1000, activeCpuMs: 10, memoryMb: 4096, vcpus: 2 };
  const storedReal = storedUsd(R, { bytes: 1e9, ms: H });
  for (const args of [{ before: null, after }, { before: { wallMs: 0, activeCpuMs: 0 }, after: null }, { before: { wallMs: 0, activeCpuMs: 0 }, after: { ...after, activeCpuMs: null } }, { before: { wallMs: 0, activeCpuMs: 0 }, after, settled: false }]) {
    const c = stageVendorCost(R, { ...args, ceilingUsd: 0.25, stored: { ms: H, bytes: 1e9 } });
    assert.equal(c.usageUnknown, true, JSON.stringify(args));
    assert.equal(c.computeUsd, null);
    close(c.usd, storedReal, "the stored bytes at the published rate, the one real part");
    assert.equal(Object.hasOwn(c, "upperBound"), false, "no bound field");
    // The vendor comment's spend line: the known parts, and one run of unknown cost for the sandbox's usage.
    const line = vendorLine({ id: "pendulum-a0dd", state: "running", cost: c, rates: R, error: "unavailable" });
    assert.match(line, /running: usage not reported \(unavailable\), .* vendor \$0\.\d{4} plus its unknown usage this stage/);
    const body = vendorBody({ line, vendorUsd: c.usd, vendorUnknown: c.usageUnknown, modelUsd: 2 });
    const parts = spendParts(body);
    assert.deepEqual([parts.modelUsd, parts.vendorUsd, parts.usdUnknown, parts.usdUnknownWhy], [2, c.usd, 1, ["sandbox"]]);
    assert.deepEqual(spendOf(body).unknown, 1);
  }
  // A created sandbox's creation is real too: listed per creation.
  const made = stageVendorCost(R, { before: null, after: null, created: true });
  close(made.usd, R.creation, "the creation at its listed price");
  assert.equal(made.usageUnknown, true);
  // No figure at all (an older booking): unknown in full.
  assert.deepEqual(spendParts(vendorBody({ line: "x", vendorUsd: null, modelUsd: 2 })).usdUnknown, 1);
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
  const line = vendorLine({ id: "pendulum-a0dd", state: "stopped", cost, rates: R, at: "2026-11-09T01:16:30Z" });
  assert.match(line, /^- 1:16 AM UTC<!-- 01:16Z --> sandbox `pendulum-a0dd` stopped: 41\.2 s active CPU in 212\.0 s, 2 vCPU \/ 4 GB; vercel Pro list rates \(iad1, read 2026-11-08\): \$0\.1280\/CPU-hour, \$0\.0212\/GB-hour, \$0\.0800\/GB-month stored; vendor \$0\.\d{4} this stage; stopped 3\.0 h before it with 1\.20 GB saved: \$0\.\d{4}$/);
  const body = vendorBody({ line, vendorUsd: cost.usd });
  assert.ok(body.includes(line));
  close(spendOf(body).usd, cost.usd, "daily_usd adds the vendor's dollars to the progress comment's model dollars");
  assert.equal(spendOf(body).unknown, 0);
  assert.deepEqual(spendParts(body), { usd: spendOf(body).usd, modelUsd: null, vendorUsd: spendOf(body).usd, route: "sandbox" });
  // A stage that left no progress comment: the usage record's model dollars are here, so the daily sum counts them, and
  // its runs of unknown cost with them.
  const alone = vendorBody({ line, vendorUsd: 0.01, modelUsd: 2, modelUnknown: { usdUnknown: 1, usdUnknownWhy: ["unreported"] } });
  close(spendOf(alone).usd, 2.01, "model from the usage record");
  close(spendParts(alone).modelUsd, 2);
  assert.deepEqual([spendParts(alone).usdUnknown, spendParts(alone).usdUnknownWhy], [1, ["unreported"]]);
  // Nothing but codes and numbers reaches the comment.
  assert.match(vendorLine({ id: "pendulum-x", state: "stopped", cost, rates: R, error: "vercel: <b>secret text</b>" }), /\(\?\)|stopped/);
  assert.ok(!vendorLine({ id: "pendulum-x", state: "stopped", cost: { ...cost, usd: null }, rates: R, error: "vercel: secret text" }).includes("secret"), "a vendor message never reaches the comment");
});

const fakeAdapter = (over = {}) => {
  const calls = [];
  const adapter = {
    rates: R,
    calls,
    list: async () => [{ id: "pendulum-abc", state: "stopped", tags: { pendulum: "objective", "pendulum-repo": "1", "pendulum-issue": "7" } }],
    usage: async () => (calls.push("usage"), { wallMs: 600_000, activeCpuMs: 90_000, memoryMb: 4096, vcpus: 2, storedBytes: 1.5e9 }),
    resume: async () => (calls.push("resume"), { expiresAt: new Date(Date.now() + 45 * 60_000).toISOString() }),
    extend: async () => {
      throw Object.assign(new Error("no"), { code: "invalid" });
    },
    stop: async () => calls.push("stop"),
    writeFiles: async () => {},
    run: async (id, spec) => {
      if (spec.argv.includes("pendulum-probe")) spec.onStdout("/vercel\nhave\n");
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
const start = (adapter, extra) => startInSandbox({ adapter, repo: { owner: "o", name: "r", full: "o/r" }, repoId: "1", issue: 7, recordedId: "pendulum-abc", baseImage: "base", claim: "c1", env: { PENDULUM_TIMEOUT_MINUTES: "30", PENDULUM_MAX_USD: "20" }, budgetMs: 46 * 60_000, vcpus: 2, harness: "claude", plugin: { digest: "d", tgz: Buffer.from("") }, ...extra });

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
  const budget = Number(adapter.startEnv.PENDULUM_MAX_USD);
  assert.ok(budget < 20 && budget > 19, `the harness's budget leaves room for the sandbox (${budget})`);
  assert.ok(budget + r.meter.ceilingUsd + storage <= 20, "model and vendor together stay under max_usd");
  assert.equal(r.meter.harnessUsd, budget);
  // The stage gets the record's start fields and writes them with every beat (a beat can land over the launcher's write).
  assert.deepEqual(startedFields(adapter.startEnv.PENDULUM_STAGE_RECORD), { id: "pendulum-abc", home: "/vercel", meter: r.meter, image: null, sessionEnd: r.sessionEnd });
  assert.deepEqual(startedFields(JSON.stringify({ id: "x; rm", home: "rel", meter: { ceilingUsd: "1" } })), {}, "only plain shapes pass");
  assert.deepEqual(startedFields("not json"), {});

  // No cap set: nothing taken off, nothing passed.
  const free = fakeAdapter();
  await start(free, { maxUsd: 0 });
  assert.equal(free.startEnv.PENDULUM_MAX_USD, "20", "the setting as it was (0 means no cap; this env's value is the fake's)");

  // A cap the session's ceiling eats starts nothing: the sandbox is stopped and the code is not transient.
  const tight = fakeAdapter();
  await assert.rejects(start(tight, { maxUsd: 0.05 }), (e) => e.code === "budget");
  assert.ok(tight.calls.includes("stop"));

  // A usage read that fails starts the stage anyway; its end is of unknown cost.
  const blind = fakeAdapter({ usage: async () => Promise.reject(Object.assign(new Error("x"), { code: "unavailable" })) });
  const b = await start(blind, { maxUsd: 20 });
  assert.equal(b.meter.base, null);
});

test("book: the vendor's cost goes into the usage record beside the model's, or a record of its own when the stage left none", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pendulum-vendor-"));
  writeFileSync(join(dir, "result.json"), JSON.stringify({ harness: "claude", usd: 0.4, runs: 1 }));
  const record = { id: "pendulum-abc", vendor: "vercel", stage: "work", claim: "c1", meter: { base: { wallMs: 0, activeCpuMs: 0 }, created: false, ceilingUsd: 0.3, stored: { ms: 0, bytes: null }, vcpus: 2 } };
  const adapter = { rates: R };
  const after = { wallMs: 120_000, activeCpuMs: 30_000, memoryMb: 4096, vcpus: 2 };
  const r = await bookVendor({ adapter, repo: { full: "o/r" }, n: 7, opts: {}, record, after, settled: true, state: "stopped", usage: { dir, name: "pendulum-usage-7" } });
  const rec = JSON.parse(readFileSync(join(dir, "result.json"), "utf8"));
  assert.equal(rec.usd, 0.4, "the model's dollars are untouched");
  assert.equal(rec.vendor.usd, r.vendor.usd);
  assert.equal(Object.hasOwn(rec.vendor, "upperBound"), false);
  assert.equal(rec.vendor.rates.date, R.date);
  assert.equal(rec.vendor.sandbox, "pendulum-abc");

  process.env.RUNNER_TEMP = mkdtempSync(join(tmpdir(), "pendulum-vendor-rt-"));
  const none = await bookVendor({ adapter, repo: { full: "o/r" }, n: 7, opts: {}, record: { ...record, stage: "review" }, after: null, settled: true, state: "stopped", usage: null, harness: "claude", error: "unavailable" });
  assert.equal(none.usage.name, "pendulum-usage-7-review");
  const own = JSON.parse(readFileSync(join(none.usage.dir, "result.json"), "utf8"));
  assert.equal(own.usd, null, "the model's dollars are unknown, never zero");
  assert.deepEqual([own.usdUnknown, own.usdUnknownWhy], [1, ["unreported"]], "one run of unknown cost, said in structure");
  assert.equal(own.spendInProgress, true, "the stage's progress comment carries its spend: daily_usd counts it there, once");
  assert.deepEqual([own.vendor.usd, own.vendor.usageUnknown], [0, true], "the vendor's usage was not read: unknown (nothing else real to count), never the session's ceiling");
  assert.match(own.vendor.basis, /^unknown: /);
  assert.equal(own.harness, "claude", "a record with no harness: the caller's");
  // A stage on an Objective's label harness (#224): its record names it, whatever the repository's default.
  const labelled = await bookVendor({ adapter, repo: { full: "o/r" }, n: 7, opts: {}, record: { ...record, claim: "c2", harness: "codex" }, after: null, settled: true, state: "stopped", usage: null, harness: "claude", error: "unavailable" });
  assert.equal(JSON.parse(readFileSync(join(labelled.usage.dir, "result.json"), "utf8")).harness, "codex");

  assert.deepEqual(await bookVendor({ adapter, repo: { full: "o/r" }, n: 7, opts: {}, record: { id: "pendulum-abc", stage: "work" }, after, settled: true, state: "stopped" }), { usage: null, vendor: null }, "a stage started before vendor costs were recorded books nothing");
});

test("budget: max_usd is split in one place; the harness gets what the vendor's most leaves, or the stage does not start", () => {
  assert.equal(harnessBudgetUsd(20, { ceilingUsd: 0.26, storageUsd: 0.0002 }), 19.73, "floored to the cent, so both stay under max_usd");
  assert.equal(harnessBudgetUsd(0, { ceilingUsd: 0.26 }), 0, "no cap set: none taken off");
  assert.equal(harnessBudgetUsd(0.2, { ceilingUsd: 0.26 }), null, "the vendor's most eats the cap");
  assert.equal(harnessBudgetUsd(20, { ceilingUsd: null }), null, "a session the vendor's cost cannot be bounded for does not start under a cap");
  assert.equal(harnessBudgetUsd(20, { ceilingUsd: 0.26, storageUsd: Number.NaN }), 19.74, "storage that cannot be read is none");
});
