#!/usr/bin/env node
// Factory's sandbox sweep (mode: sweep): destroys the Objective sandboxes and the images no live Objective needs, and
// stops one left running with no stage holding it.
//   node scripts/sweep.mjs --repo OWNER/NAME [--dry-run]
// Runs when an Objective closes (its issue closed, its PR merged) or is Blocked, by hand, on its own wakes (sweepWaits:
// what a run left for minutes later), with GitHub's hourly cron as the backstop, and inside a
// launch the vendor refused for its quota (launch.mjs). The job log and summary show the snapshot storage before and after.
// Lists Factory's Objective sandboxes for this repository in the vendor's project (tags `factory=objective` and
// `factory-repo=<repository id>`; image sandboxes and anything else are never listed, never touched) and destroys one
// (logic.mjs sweepDecision) when its Objective is closed, when the Objective's record names another sandbox or none,
// or when it has been stopped longer than `sandbox_idle_days` with the Objective neither Running nor In review. At most
// `sweep_max_destroys` a run. The record's own sandbox, running with no stage holding it on an Objective neither Running
// nor In review (a Block for a vanished stage), is stopped instead and its vendor cost booked: an end never answered.
// A stage's usage tarball the launcher never collected comes out to the runner first, for the job's upload steps (one
// per slot, COLLECT_SLOTS). The record's own sandbox is claimed in the record before it is stopped or destroyed, under
// the record lock as a launcher claims it, so a launch starting meanwhile wins and the sweep leaves it. Then this
// repository's images: the current one stays, and an older one until no stage can still be starting from it
// (lib/image.mjs prunableImages); the rest go.
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { openSandbox } from "./lib/adapters/sandbox.mjs";
import { appToken, armSweepWake, firedByWake } from "./dispatch.mjs";
import { SECRET_ENV } from "./image.mjs";
import { CLAIM_LEASE_MS, bookVendor, sameRecord, writeSandboxRecord } from "./launch.mjs";
import { findProject, getIssue, getRepo, listComments, projectStatuses, repoOf } from "./lib/github.mjs";
import { lockBase } from "./lib/lock.mjs";
import { IMAGE_TAG, pruneImages } from "./lib/image.mjs";
import { log, parseArgs, resolveInputs, setOutput } from "./lib/inputs.mjs";
import { WAKE_SLACK_MS, factorySandboxId, sandboxRecord, settleStale, stageHolds, stateOf, sweepDecision } from "./lib/logic.mjs";

/** Usage tarballs collected per run: the workflow's sweep job has this many upload steps. */
export const COLLECT_SLOTS = 3;
/** A sandbox younger than this is left alone: a launcher may be between creating it and recording it. */
const GRACE_MS = 15 * 60_000;

/** Factory's Objective sandboxes for this repository, by their tags; nothing else the listing holds. */
export const objectiveSandboxes = (listed, repoId) =>
  (listed || []).filter((s) => s.tags?.factory === "objective" && s.tags?.["factory-repo"] === String(repoId) && /^[1-9]\d{0,9}$/.test(s.tags?.["factory-issue"] ?? "") && factorySandboxId(s.id));

/** Where the stage leaves its usage (stage.mjs): `<home>/factory/out/usage-<claim>.tgz`. */
export const usageTarball = (record) => `${record.home}/factory/out/usage-${record.claim}.tgz`;

/** The record's uncollected usage, out of the sandbox and unpacked into `dir`; false when the stage left none. */
async function collect(adapter, id, record, dir) {
  const tgz = await adapter.readFile(id, usageTarball(record));
  if (!tgz) return false;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const file = `${dir}.tgz`;
  writeFileSync(file, tgz);
  try {
    execFileSync("tar", ["xzf", file, "-C", dir, "--no-same-owner", "--no-same-permissions"]);
  } finally {
    rmSync(file, { force: true });
  }
  return true;
}

/**
 * Snapshot storage now: this repository's (its Objective sandboxes and its images, each one's ready snapshots) and the
 * vendor project's whole (every repository sharing it), with the plan's limit when the vendor's API says it.
 */
export async function storageReport(adapter, repoId) {
  const [objectives, images, project] = await Promise.all([
    adapter.list({ tag: ["factory-repo", String(repoId)] }),
    adapter.list({ tag: [IMAGE_TAG, String(repoId)] }),
    adapter.storage().catch(() => null),
  ]);
  const mine = [...objectiveSandboxes(objectives, repoId), ...images.filter((s) => s.tags?.factory === "image")];
  let snapshots = 0;
  let bytes = 0;
  for (const s of mine) {
    for (const snap of await adapter.snapshots(s.id)) {
      if (snap.state !== "ready") continue;
      snapshots += 1;
      bytes += Number.isFinite(snap.sizeBytes) ? snap.sizeBytes : 0;
    }
  }
  return { repo: { sandboxes: mine.length, snapshots, bytes }, project };
}

const gb = (b) => `${(b / 1e9).toFixed(2)} GB`;
/** One line from storageReport, numbers only. */
export const storageLine = (r) =>
  `this repository ${r.repo.snapshots} snapshot(s), ${gb(r.repo.bytes)} in ${r.repo.sandboxes} sandbox(es); the vendor project ${
    r.project ? `${r.project.snapshots} snapshot(s), ${gb(r.project.bytes)}${Number.isFinite(r.project.limitBytes) ? ` of ${gb(r.project.limitBytes)}` : " (the vendor's API states no limit)"}` : "unread"
  }`;

/**
 * The stage and claim a record holds for its stage: its own, or, over a claim a sweep left (`stage: "sweep"`), the ones
 * that sweep kept as `prior`, else the stage of its last start (claim unknown). Never the sweep's.
 */
export function ownStage(record) {
  if (record?.stage !== "sweep") return { stage: record?.stage ?? null, claim: record?.claim ?? null };
  const p = record.prior;
  if (p && typeof p === "object" && p.stage !== "sweep") return { stage: p.stage ?? null, claim: typeof p.claim === "string" && !p.claim.startsWith("sweep-") ? p.claim : null };
  const last = (record.launches || []).filter((l) => l?.ok === true && (l.stage === "work" || l.stage === "review")).at(-1);
  return { stage: last?.stage ?? null, claim: null };
}

/**
 * One sweep. Returns what it did per sandbox: `{id, issue, action: "destroyed" | "stopped" | "kept" | "skipped", reason, usage}`, and
 * per image (`images`). `collectRoot` is where collected usage goes, one directory per slot; `collectSlots` slots are
 * filled in order (0 in a launcher, which has no upload steps to spare: a sandbox whose usage or vendor cost is still
 * to come out waits for the sweep job).
 */
export async function sweep({ adapter, repo, repoId, opts, idleDays, maxDestroys, staleMs, collectRoot, now = Date.now(), dryRun = false, harness = null, collectSlots = COLLECT_SLOTS, images = true }) {
  const mine = objectiveSandboxes(await adapter.list({ tag: ["factory-repo", String(repoId)] }), repoId);
  const project = await findProject(repo, opts).catch(() => null);
  const numbers = [...new Set(mine.map((s) => Number(s.tags["factory-issue"])))];
  const statuses = project ? await projectStatuses(project, repo, numbers, opts).catch(() => ({})) : {};
  const out = [];
  const slots = [];
  let destroyed = 0;
  // The record lock's base (lib/lock.mjs lockBase), read once, when a record is first claimed.
  let base = null;
  for (const n of numbers) {
    let issue = null;
    try {
      issue = await getIssue(repo, n, opts);
    } catch (e) {
      // A missing issue is gone for good; any other failure is a read to try again next run.
      if (e.status !== 404 && e.status !== 410) {
        for (const s of mine.filter((x) => x.tags["factory-issue"] === String(n))) out.push({ id: s.id, issue: n, action: "skipped", reason: `issue unreadable (${e.status ?? "error"})`, retry: "error" });
        continue;
      }
    }
    const comments = issue ? await listComments(repo, n, opts) : [];
    const record = sandboxRecord(comments, n);
    // The record as written, without the comment's own id and time that sandboxRecord adds.
    const written = record && Object.fromEntries(Object.entries(record).filter(([k]) => k !== "commentId" && k !== "updatedAt"));
    const state = issue ? stateOf(issue, statuses[n] ?? null) : null;
    for (const s of mine.filter((x) => x.tags["factory-issue"] === String(n))) {
      const d = sweepDecision({ sandbox: s, issue, state, record, holds: stageHolds(record, now, staleMs), now, idleMs: idleDays * 86_400_000, graceMs: GRACE_MS });
      if (d.keep) {
        out.push({ id: s.id, issue: n, action: "kept", reason: d.keep, ...(d.until ? { until: d.until, idle: !!d.idle } : {}) });
        continue;
      }
      if (d.destroy && destroyed >= maxDestroys) {
        out.push({ id: s.id, issue: n, action: "skipped", reason: `sweep_max_destroys (${maxDestroys}) reached; next run`, retry: "cap" });
        continue;
      }
      if (d.collect && slots.length >= collectSlots) {
        out.push({ id: s.id, issue: n, action: "skipped", reason: "its usage waits for a collection slot; next run", retry: "cap" });
        continue;
      }
      // A stage's vendor cost not yet booked needs a slot for its usage record, unless its usage comes out with it.
      if (issue && record?.id === s.id && record.meter && !record.vendorBooked && !d.collect && slots.length >= collectSlots) {
        out.push({ id: s.id, issue: n, action: "skipped", reason: "its vendor cost waits for a collection slot; next run", retry: "cap" });
        continue;
      }
      if (dryRun) {
        out.push({ id: s.id, issue: n, action: d.stop ? "would stop" : "would destroy", reason: d.stop ?? d.destroy });
        continue;
      }
      // The record's own sandbox: claim it as a launcher does (under the record lock, over the record read, with a lease
      // of its own, so a launcher reads it as held and starts nothing), so a launch starting now wins. Later writes go in
      // only while the record still carries this claim, each over the record as it is then (`cur`, settled by
      // writeSandboxRecord), so an attempt stored meanwhile is kept. `own` is the stage and claim the record holds for
      // its stage, which the claim keeps as `prior` and the later writes put back: never the sweep's, even over a claim
      // an earlier sweep left behind.
      const recorded = issue && record?.id === s.id;
      const own = ownStage(written);
      let claim = null;
      let from = null;
      const underClaim = (next) => (cur) => (cur?.claim === claim ? { ...next(cur), stage: own.stage, claim: own.claim, prior: undefined } : null);
      if (recorded) {
        claim = `sweep-${randomBytes(6).toString("hex")}`;
        base ??= await lockBase(repo, opts);
        const w = await writeSandboxRecord(repo, n, opts, (cur) => (sameRecord(cur, settleStale(record, Date.now())) ? ((from = cur), { ...cur, state: "running", stage: "sweep", claim, prior: own, at: new Date(now).toISOString(), leaseUntil: new Date(Date.now() + CLAIM_LEASE_MS).toISOString() }) : null), { base });
        if (!w.ok) {
          out.push({ id: s.id, issue: n, action: "skipped", reason: w.refused ? "the sandbox record changed since it was read (a launcher claimed it)" : "another writer held the sandbox record's lock", ...(w.refused ? {} : { retry: "error" }) });
          continue;
        }
      }
      // Under the record lock, right before the sandbox is stopped or destroyed: the record still carries this claim, and
      // its lease is renewed, so a collection that ran past the lease still hands the stop a fresh window.
      const stillClaimed = async () => {
        let held = false;
        const w = await writeSandboxRecord(repo, n, opts, (cur) => ((held = cur?.claim === claim) ? { ...cur, leaseUntil: new Date(Date.now() + CLAIM_LEASE_MS).toISOString() } : null), { base });
        return held && !!w.ok;
      };
      let usage = null;
      let vendor = null;
      // What the record says once the sandbox is stopped or destroyed (with a claim only).
      let end = null;
      try {
        if (d.collect) {
          const dir = join(collectRoot, `slot-${slots.length + 1}`);
          if (await collect(adapter, s.id, { ...record, ...own }, dir)) {
            usage = { dir, name: own.stage === "review" ? `factory-usage-${n}-review` : `factory-usage-${n}` };
            slots.push(usage);
          }
        }
        if (claim && !(await stillClaimed())) {
          // A launcher's claim (or the lock held throughout) since this sweep claimed it: the sandbox is the launcher's now.
          out.push({ id: s.id, issue: n, action: "skipped", reason: "the sandbox record no longer carries the sweep's claim (a launcher claimed it)", usage: usage?.name ?? null });
          continue;
        }
        // Stopped before its cost is read, so the totals are its session's whole (an end the stage never announced).
        let stoppedAt = null;
        if (d.stop) {
          await adapter.stop(s.id);
          stoppedAt = new Date().toISOString();
        }
        const settled = !!stoppedAt || s.state === "stopped";
        // A stage whose end was never answered: its vendor cost from the totals now, before they go with the sandbox.
        if (recorded && record.meter && !record.vendorBooked && (usage || slots.length < collectSlots)) {
          const after = await adapter.usage(s.id).catch(() => null);
          const booked = await bookVendor({ adapter, repo, n, opts, base, record: { ...written, ...own, id: s.id }, after, settled, state: settled ? "stopped" : "running", usage, harness, error: after ? null : "unread" });
          if (!usage && booked.usage) slots.push(booked.usage);
          usage = booked.usage ?? usage;
          vendor = booked.vendor;
        }
        if (d.destroy) {
          await adapter.destroy(s.id);
          destroyed += 1;
        }
        out.push({ id: s.id, issue: n, action: d.stop ? "stopped" : "destroyed", reason: d.stop ?? d.destroy, usage: usage?.name ?? null });
        // A stop that went through clears an earlier one's error, so the next start books the stopped stretch's storage.
        if (claim) end = d.stop ? { state: "stopped", stoppedAt, stopError: undefined } : { id: null, state: "stopped", destroyedAt: new Date().toISOString() };
      } catch (e) {
        // The job log gets the message; the record keeps codes only. The sandbox stays for the next run.
        log(`sweep: ${s.id} (#${n}): ${e.code ?? "error"}: ${String(e.message).slice(0, 300)}`);
        out.push({ id: s.id, issue: n, action: "skipped", reason: `vendor ${e.code ?? "error"}`, retry: "error" });
        if (claim) await writeSandboxRecord(repo, n, opts, underClaim((cur) => ({ ...cur, state: from.state, at: from.at, leaseUntil: from.leaseUntil })), { base }).catch(() => {});
        continue;
      }
      if (claim) {
        const at = new Date().toISOString();
        await writeSandboxRecord(repo, n, opts, underClaim((cur) => ({ ...cur, ...end, collected: usage ? true : from.collected, ...(vendor ? { vendorBooked: true, vendorUsd: vendor.usd } : {}), at, leaseUntil: null })), { base }).then(
          (w) => w.ok || log(`sweep: #${n} record: not written (${w.refused ? "another claim holds it" : "the record lock stayed held"})`),
          (e) => log(`sweep: #${n} record: ${String(e.message).slice(0, 120)}`),
        );
      }
    }
  }
  // This repository's images no stage needs, from Factory's record and the vendor's listing (lib/image.mjs).
  const pruned = images ? await pruneImages(adapter, repo, { ...opts, repoId, now, dryRun, log }).catch((e) => {
    log(`sweep: images not pruned (${e.code ?? e.status ?? "error"}): ${String(e.message).slice(0, 200)}`);
    return { images: [], until: null, failed: true };
  }) : { images: [], until: null };
  return { results: out, usage: slots, images: pruned.images, imagesUntil: pruned.until, imagesFailed: !!pruned.failed || pruned.images.some((i) => i.action === "skipped") };
}

/** How soon the sweep runs again for what a run left: a cap it reached, or a read or vendor call that failed. */
export const SWEEP_RETRY_MS = 10 * 60_000;

/**
 * The sweep's own next runs, as `sweep` deadlines (`{issue, kind, at}`, lib/logic.mjs nextWake) from what one sweep
 * left, each a wait of minutes:
 * - a minute after a wait ends: a stage that ended moments ago (the launcher's end answers it first), a sandbox created
 *   moments ago, a superseded image a stage may still be starting from, or any such wait that ended during this run;
 * - SWEEP_RETRY_MS on: what a cap left (sweep_max_destroys, the collection slots), and once, never from a run a `sweep`
 *   wake started, what a failure left (an unreadable issue, a vendor error, a held lock).
 * A stopped sandbox's idle days (days, not minutes) get no wake: the next sweep an event runs (an Objective closing,
 * merging or Blocking), or the hourly cron's, destroys it.
 */
export function sweepWaits({ results = [], imagesUntil = null, imagesFailed = false, now = Date.now(), firedBy = null }) {
  const out = [];
  const soon = (ms) => new Date(Math.max(ms, now) + WAKE_SLACK_MS).toISOString();
  for (const r of results) {
    if (r.action === "kept" && Number.isFinite(r.until) && (!r.idle || r.until <= now)) out.push({ issue: r.issue, kind: "sweep", at: soon(r.until) });
    if (r.retry === "cap" || (r.retry === "error" && firedBy?.kind !== "sweep")) out.push({ issue: r.issue, kind: "sweep", at: new Date(now + SWEEP_RETRY_MS).toISOString() });
  }
  if (Number.isFinite(imagesUntil)) out.push({ issue: null, kind: "sweep", at: soon(imagesUntil) });
  if (imagesFailed && firedBy?.kind !== "sweep") out.push({ issue: null, kind: "sweep", at: new Date(now + SWEEP_RETRY_MS).toISOString() });
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputs = resolveInputs({ args });
  for (const k of Object.keys(process.env)) if (SECRET_ENV.has(k)) delete process.env[k];
  if (!inputs.repo) throw new Error("--repo OWNER/NAME (or GITHUB_REPOSITORY) is required");
  if (!inputs.sandbox) throw new Error("mode sweep needs the sandbox input (for example `vercel`)");
  const repo = repoOf(inputs.repo);
  const token = await appToken(inputs);
  inputs.appPrivateKey = "";
  const opts = { token };
  const adapter = await openSandbox(inputs.sandbox, { VERCEL_TOKEN: inputs.vercelToken, VERCEL_TEAM_ID: inputs.vercelTeamId, VERCEL_PROJECT_ID: inputs.vercelProjectId });
  inputs.vercelToken = "";
  const repoId = String(process.env.GITHUB_REPOSITORY_ID || (await getRepo(repo, opts)).id);
  const collectRoot = join(process.env.RUNNER_TEMP || tmpdir(), "factory-sweep-usage");
  const storage = () => storageReport(adapter, repoId).catch((e) => (log(`sweep: storage not read (${e.code ?? "error"})`), null));
  const before = await storage();
  if (before) log(`sweep: storage before: ${storageLine(before)}`);
  const { results, usage, images, imagesUntil, imagesFailed } = await sweep({ adapter, repo, repoId, opts, idleDays: inputs.sandboxIdleDays, maxDestroys: inputs.sweepMaxDestroys, staleMs: inputs.timeoutMinutes * 60_000, collectRoot, dryRun: args.dry_run === "true", harness: inputs.harness });
  for (const r of results) log(`sweep: #${r.issue} ${r.id}: ${r.action} (${r.reason})${r.usage ? `; usage collected as ${r.usage}` : ""}`);
  for (const i of images) log(`sweep: image ${i.source} (${i.snapshot}): ${i.action} (${i.reason})`);
  const after = await storage();
  if (after) log(`sweep: storage after: ${storageLine(after)}`);
  for (const [k, r] of [["before", before], ["after", after]]) {
    if (!r) continue;
    setOutput(`snapshots_${k}`, String(r.repo.snapshots));
    setOutput(`snapshot_bytes_${k}`, String(r.repo.bytes));
  }
  usage.forEach((u, i) => {
    setOutput(`usage_dir_${i + 1}`, u.dir);
    setOutput(`usage_name_${i + 1}`, u.name);
  });
  // Its own next run (workflow-template.yml `sweep-wake`): GitHub's hourly cron is only the backstop.
  if (args.dry_run !== "true") {
    const eventName = process.env.GITHUB_EVENT_NAME || "";
    let payload = {};
    try {
      payload = process.env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")) : {};
    } catch {
      payload = {};
    }
    const now = Date.now();
    const waits = sweepWaits({ results, imagesUntil, imagesFailed, now, firedBy: firedByWake(eventName, payload) });
    await armSweepWake("sweep", waits, { repo, payload, eventName, token: inputs.githubToken || token, now });
  }
  const count = (a) => results.filter((r) => r.action === a).length;
  setOutput("destroyed", String(count("destroyed")));
  setOutput("images_destroyed", String(images.filter((i) => i.action === "destroyed").length));
  log(`sweep: ${results.length} Objective sandbox(es); ${count("destroyed")} destroyed, ${count("stopped")} stopped, ${count("kept")} kept, ${count("skipped")} left for the next run; ${images.filter((i) => i.action === "destroyed").length} image(s) destroyed`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const rows = [...results.map((r) => `| #${r.issue} | \`${r.id}\` | ${r.action} | ${r.reason} |`), ...images.map((i) => `| image | \`${i.source}\` | ${i.action} | ${i.reason} |`)];
    const lines = [before && `Storage before: ${storageLine(before)}.`, after && `Storage after: ${storageLine(after)}.`].filter(Boolean).join("\n\n");
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Factory sandbox sweep\n\n${lines}\n\n${rows.length ? `| Objective | Sandbox | Action | Why |\n| --- | --- | --- | --- |\n${rows.join("\n")}\n` : ""}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    process.stderr.write(`[factory] sweep failed: ${e.message}\n`);
    process.exit(1);
  });
}
