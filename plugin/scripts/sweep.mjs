#!/usr/bin/env node
// Factory's sandbox sweep (mode: sweep): destroys the Objective sandboxes and the images no live Objective needs.
//   node scripts/sweep.mjs --repo OWNER/NAME [--dry-run]
// Runs hourly, by hand, when an Objective closes (its issue closed, its PR merged), and inside a launch the vendor
// refused for its quota (launch.mjs). The job log and summary show the snapshot storage before and after.
// Lists Factory's Objective sandboxes for this repository in the vendor's project (tags `factory=objective` and
// `factory-repo=<repository id>`; image sandboxes and anything else are never listed, never touched) and destroys one
// (logic.mjs sweepDecision) when its Objective is closed, when the Objective's record names another sandbox or none,
// or when it has been stopped longer than `sandbox_idle_days` with the Objective neither Running nor In review. At most
// `sweep_max_destroys` a run. A stage's usage tarball the launcher never collected comes out to the runner first, for
// the job's upload steps (one per slot, COLLECT_SLOTS). The record's own sandbox is claimed in the record before it is
// destroyed, under the record lock as a launcher claims it, so a launch starting meanwhile wins and the sweep leaves it. Then this
// repository's images: the current one stays, and an older one until no stage can still be starting from it
// (lib/image.mjs prunableImages); the rest go.
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { openSandbox } from "./lib/adapters/sandbox.mjs";
import { appToken } from "./dispatch.mjs";
import { SECRET_ENV } from "./image.mjs";
import { bookVendor, sameRecord, writeSandboxRecord } from "./launch.mjs";
import { findProject, getIssue, getRepo, listComments, projectStatuses, repoOf } from "./lib/github.mjs";
import { lockBase } from "./lib/lock.mjs";
import { IMAGE_TAG, pruneImages } from "./lib/image.mjs";
import { log, parseArgs, resolveInputs, setOutput } from "./lib/inputs.mjs";
import { factorySandboxId, sandboxRecord, settleStale, stageHolds, stateOf, sweepDecision } from "./lib/logic.mjs";

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
 * One sweep. Returns what it did per sandbox: `{id, issue, action: "destroyed" | "kept" | "skipped", reason, usage}`, and
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
        for (const s of mine.filter((x) => x.tags["factory-issue"] === String(n))) out.push({ id: s.id, issue: n, action: "skipped", reason: `issue unreadable (${e.status ?? "error"})` });
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
        out.push({ id: s.id, issue: n, action: "kept", reason: d.keep });
        continue;
      }
      if (destroyed >= maxDestroys) {
        out.push({ id: s.id, issue: n, action: "skipped", reason: `sweep_max_destroys (${maxDestroys}) reached; next run` });
        continue;
      }
      if (d.collect && slots.length >= collectSlots) {
        out.push({ id: s.id, issue: n, action: "skipped", reason: "its usage waits for a collection slot; next run" });
        continue;
      }
      // A stage's vendor cost not yet booked needs a slot for its usage record, unless its usage comes out with it.
      if (issue && record?.id === s.id && record.meter && !record.vendorBooked && !d.collect && slots.length >= collectSlots) {
        out.push({ id: s.id, issue: n, action: "skipped", reason: "its vendor cost waits for a collection slot; next run" });
        continue;
      }
      if (dryRun) {
        out.push({ id: s.id, issue: n, action: "would destroy", reason: d.destroy });
        continue;
      }
      // The record's own sandbox: claim it as a launcher does (under the record lock, over the record read), so a launch
      // starting now wins. Later writes go in only while the record still carries this claim.
      const recorded = issue && record?.id === s.id;
      let claim = null;
      const underClaim = (next) => (cur) => (cur?.claim === claim ? next(cur) : null);
      if (recorded) {
        claim = `sweep-${randomBytes(6).toString("hex")}`;
        base ??= await lockBase(repo, opts);
        const w = await writeSandboxRecord(repo, n, opts, (cur) => (sameRecord(cur, settleStale(record, Date.now())) ? { ...written, state: "running", stage: "sweep", claim, at: new Date(now).toISOString() } : null), { base });
        if (!w.ok) {
          out.push({ id: s.id, issue: n, action: "skipped", reason: w.refused ? "the sandbox record changed since it was read (a launcher claimed it)" : "another writer held the sandbox record's lock" });
          continue;
        }
      }
      let usage = null;
      let vendor = null;
      try {
        if (d.collect) {
          const dir = join(collectRoot, `slot-${slots.length + 1}`);
          if (await collect(adapter, s.id, record, dir)) {
            usage = { dir, name: record.stage === "review" ? `factory-usage-${n}-review` : `factory-usage-${n}` };
            slots.push(usage);
          }
        }
        // A stage whose end was never answered: its vendor cost from the totals now, before they go with the sandbox.
        if (recorded && record.meter && !record.vendorBooked && (usage || slots.length < collectSlots)) {
          const after = await adapter.usage(s.id).catch(() => null);
          const booked = await bookVendor({ adapter, repo, n, opts, base, record: { ...written, id: s.id }, after, settled: s.state === "stopped", state: s.state === "stopped" ? "stopped" : "running", usage, harness, error: after ? null : "unread" });
          if (!usage && booked.usage) slots.push(booked.usage);
          usage = booked.usage ?? usage;
          vendor = booked.vendor;
        }
        await adapter.destroy(s.id);
        destroyed += 1;
        out.push({ id: s.id, issue: n, action: "destroyed", reason: d.destroy, usage: usage?.name ?? null });
      } catch (e) {
        // The job log gets the message; the record keeps codes only. The sandbox stays for the next run.
        log(`sweep: ${s.id} (#${n}): ${e.code ?? "error"}: ${String(e.message).slice(0, 300)}`);
        out.push({ id: s.id, issue: n, action: "skipped", reason: `vendor ${e.code ?? "error"}` });
        if (claim) await writeSandboxRecord(repo, n, opts, underClaim(() => written), { base }).catch(() => {});
        continue;
      }
      if (claim) {
        const at = new Date().toISOString();
        await writeSandboxRecord(repo, n, opts, underClaim(() => ({ ...written, id: null, state: "stopped", destroyedAt: at, collected: usage ? true : written.collected, ...(vendor ? { vendorBooked: true, vendorUsd: vendor.usd } : {}), at, leaseUntil: null })), { base }).then(
          (w) => w.ok || log(`sweep: #${n} record: not written (${w.refused ? "another claim holds it" : "the record lock stayed held"})`),
          (e) => log(`sweep: #${n} record: ${String(e.message).slice(0, 120)}`),
        );
      }
    }
  }
  // This repository's images no stage needs, from Factory's record and the vendor's listing (lib/image.mjs).
  const pruned = images ? await pruneImages(adapter, repo, { ...opts, repoId, now, dryRun, log }).catch((e) => {
    log(`sweep: images not pruned (${e.code ?? e.status ?? "error"}): ${String(e.message).slice(0, 200)}`);
    return [];
  }) : [];
  return { results: out, usage: slots, images: pruned };
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
  const { results, usage, images } = await sweep({ adapter, repo, repoId, opts, idleDays: inputs.sandboxIdleDays, maxDestroys: inputs.sweepMaxDestroys, staleMs: inputs.timeoutMinutes * 60_000, collectRoot, dryRun: args.dry_run === "true", harness: inputs.harness });
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
  const count = (a) => results.filter((r) => r.action === a).length;
  setOutput("destroyed", String(count("destroyed")));
  setOutput("images_destroyed", String(images.filter((i) => i.action === "destroyed").length));
  log(`sweep: ${results.length} Objective sandbox(es); ${count("destroyed")} destroyed, ${count("kept")} kept, ${count("skipped")} left for the next run; ${images.filter((i) => i.action === "destroyed").length} image(s) destroyed`);
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
