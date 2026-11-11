// The adopter's sandbox image (docs/ADAPTERS.md, "Sandbox image"). A build job runs the adopter's own setup command
// in a fresh sandbox beside a clone at the default branch's head, installs the dependency store and the harness CLIs,
// and snapshots it. Two records, each checked against the other:
// - GitHub's, the index: one marker comment written by the Factory App on Factory's own image issue (label
//   `factory:image`), the newest builds first. Only Factory's own login's issue and comment count (isSelf).
// - The vendor's, the proof: the sandbox each image came from stays in Factory's own project, stopped, tagged with this
//   repository's id, the head and the snapshot id. A snapshot is used or deleted only when that listing shows it.
// Paths inside the image are constants, never read from a record.
import { SNAPSHOT_TAG } from "./adapters/sandbox.mjs";
import { ensureLabel, getRepo, listComments, onDefaultBranch, rest, upsertComment } from "./github.mjs";
import { WAKE_SLACK_MS, isSelf, marker, selfLogin } from "./logic.mjs";

/** The label on Factory's image issue (a hint to find it; anyone with triage can remove it) and its exact title. */
export const IMAGE_LABEL = "factory:image";
export const IMAGE_TITLE = "Factory: sandbox image";
/** The refresh settings: `merge` builds on every push to the default branch until today's builds pass the daily minutes, then the nightly build takes over; `nightly` builds on the nightly schedule only. */
export const REFRESH = Object.freeze(["merge", "nightly"]);
/** The nightly build's cron (UTC): the workflow template's second schedule, matched by the image job's `if:`. */
export const NIGHTLY_CRON = "41 10 * * *";
const NIGHTLY_UTC = { h: 10, m: 41 };
/** The image sandbox's tag holding the repository id; with `factory=image`, `sha=<head>` and the adapter's `snapshot=<id>`. */
export const IMAGE_TAG = "factory-image";
/** Where the image keeps Factory's files, the clone and what setup exported. */
export const IMAGE_DIR = "/opt/factory";
/** Images a build keeps per repository, the newest by the vendor's clock (the one it made and the one before). */
export const KEEP = 2;
/**
 * How long the image before the current one stays once the current is recorded. A stage uses an image only from its
 * launcher's read of the record to its create, inside one launch job (five minutes at most); a sandbox made from it
 * stops, resumes and goes without it (docs/ADAPTERS.md, snapshot).
 */
export const PREVIOUS_IMAGE_MS = 15 * 60_000;
/** Builds kept in the record, newest first. */
const RECORDED = 30;
/** A record's build minutes count up to this, whatever it states. */
const MAX_BUILD_MS = 45 * 60_000;

const ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const SHA = /^[0-9a-f]{40}$/;

/** The image's paths, from constants and the repository's name: the clone and the JSON of what setup exported. */
export const imagePaths = (repo) => ({ checkout: `${IMAGE_DIR}/${repo.name}`, envFile: `${IMAGE_DIR}/setup-env.json` });
/** The tags a build sandbox is created with (the adapter adds `snapshot` when it is kept as an image). */
export const imageTags = (repoId, sha) => ({ factory: "image", [IMAGE_TAG]: String(repoId), sha });

/** One build in the record, checked field by field; null when it is not one. */
export function imageEntry(e) {
  if (!e || typeof e !== "object" || typeof e.vendor !== "string" || !ID.test(e.vendor) || !SHA.test(e.sha ?? "") || !Number.isFinite(Date.parse(e.builtAt))) return null;
  const id = (v) => (typeof v === "string" && ID.test(v) ? v : null);
  const num = (v) => (Number.isFinite(v) && v >= 0 ? v : null);
  return { vendor: e.vendor, snapshot: id(e.snapshot), source: id(e.source), sha: e.sha, builtAt: new Date(Date.parse(e.builtAt)).toISOString(), buildMs: Math.min(num(e.buildMs) ?? 0, MAX_BUILD_MS), sizeBytes: num(e.sizeBytes), usd: num(e.usd) };
}

/** The record comment's JSON line (`<` and `>` escaped, as the sandbox record's) and its parse. */
export const imageMarkerLine = (builds) => `<!-- factory:image ${JSON.stringify({ builds }).replace(/</g, "\\u003c").replace(/>/g, "\\u003e")} -->`;
const LINE = /^<!-- factory:image (\{[^\n]*\}) -->$/m;
export function imageRecordOf(body) {
  const m = LINE.exec(body || "");
  if (!m) return [];
  try {
    const r = JSON.parse(m[1]);
    return Array.isArray(r?.builds) ? r.builds.map(imageEntry).filter(Boolean) : [];
  } catch {
    return [];
  }
}

/**
 * Factory's image issue, or null: the oldest issue Factory's own login opened with the exact title. The label is only a
 * hint (the first, cheap query); without it, Factory's own issues are searched by creator. On Actions the issue must be
 * locked, as Factory leaves it, so an unlocked one (Factory's, but not this record's) is not trusted.
 */
export async function findImageIssue(repo, opts, { actions = process.env.GITHUB_ACTIONS === "true" } = {}) {
  const self = selfLogin();
  if (!self) return null;
  const ok = (i) => !i.pull_request && isSelf(i) && i.title === IMAGE_TITLE && (!actions || i.locked === true);
  const query = (extra) => rest(`repos/${repo.full}/issues?creator=${encodeURIComponent(self)}&state=all&sort=created&direction=asc&per_page=100${extra}`, { ...opts, paginate: !extra });
  for (const extra of [`&labels=${encodeURIComponent(IMAGE_LABEL)}`, ""]) {
    const found = (((await query(extra)) || []).filter(ok)).sort((a, b) => a.number - b.number)[0];
    if (found) return found;
  }
  return null;
}

/** The builds Factory recorded, newest first: its own marker comment on its own image issue only. */
export async function listImages(repo, opts) {
  const issue = await findImageIssue(repo, opts);
  if (!issue) return { issue: null, builds: [] };
  const head = marker(issue.number, "image");
  const c = (await listComments(repo, issue.number, opts)).filter((x) => isSelf(x) && (x.body || "").startsWith(head)).sort((a, b) => a.id - b.id)[0];
  return { issue: issue.number, builds: c ? imageRecordOf(c.body) : [] };
}

/**
 * Record a build (failed ones too, with no snapshot), newest first, on Factory's image issue: made the first time,
 * closed and locked, so it neither shows among open issues nor takes comments. Codes, ids and times only.
 */
export async function recordImage(repo, entry, opts) {
  let { issue, builds } = await listImages(repo, opts);
  if (!issue) {
    await ensureLabel(repo, IMAGE_LABEL, "5319e7", "Factory's sandbox image record", opts);
    const body = "Factory keeps the record of this repository's sandbox image here: what each build made, from which head, in how long. Factory reads only its own comment. Do not reopen.";
    issue = (await rest(`repos/${repo.full}/issues`, { ...opts, method: "POST", body: { title: IMAGE_TITLE, body, labels: [IMAGE_LABEL] } })).number;
    await rest(`repos/${repo.full}/issues/${issue}`, { ...opts, method: "PATCH", body: { state: "closed", state_reason: "completed" } });
    // Locked is part of what makes it Factory's record on Actions (findImageIssue): a failed lock fails the record.
    await rest(`repos/${repo.full}/issues/${issue}/lock`, { ...opts, method: "PUT", body: { lock_reason: "resolved" } });
  }
  const next = [imageEntry(entry), ...builds].filter(Boolean).slice(0, RECORDED);
  const e = next[0];
  const human = e.snapshot
    ? `Factory's sandbox image: \`${e.snapshot}\` (${e.vendor}) from \`${e.sha.slice(0, 7)}\`, built in ${Math.round(e.buildMs / 1000)} s at ${e.builtAt.slice(0, 16)}Z.`
    : `Factory's sandbox image: the build of \`${e.sha.slice(0, 7)}\` (${e.vendor}) failed after ${Math.round(e.buildMs / 1000)} s at ${e.builtAt.slice(0, 16)}Z.`;
  await upsertComment(repo, issue, marker(issue, "image"), `${imageMarkerLine(next)}\n${human}`, opts);
  return issue;
}

/**
 * The vendor's images for this repository, newest first: sandboxes in Factory's project with the repository's tag,
 * stopped, with a head and a snapshot tag. `others` are the rest with its tag (a build running, or one a crashed job left).
 */
export async function vendorImages(adapter, repoId) {
  const listed = await adapter.list({ tag: [IMAGE_TAG, String(repoId)] });
  const isImage = (s) => s.state === "stopped" && ID.test(s.tags?.[SNAPSHOT_TAG] ?? "") && SHA.test(s.tags?.sha ?? "");
  const images = listed.filter(isImage).map((s) => ({ source: s.id, snapshot: s.tags[SNAPSHOT_TAG], sha: s.tags.sha, createdAt: s.createdAt }));
  images.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return { images, others: listed.filter((s) => !isImage(s)) };
}

/** The recorded builds the vendor's listing confirms, newest first: the sandbox each names, with its head and snapshot. */
export function verifiedRecords(builds, images, vendor) {
  const bySource = new Map(images.map((i) => [i.source, i]));
  return builds.filter((b) => {
    const i = b.source ? bySource.get(b.source) : null;
    return b.vendor === vendor && !!b.snapshot && !!i && i.snapshot === b.snapshot && i.sha === b.sha;
  });
}

/** Whether the vendor still lists the build's snapshot ready, in Factory's project (it expires 30 days after last use). */
export const imageReady = async (adapter, b) => (await adapter.snapshots(b.source)).some((s) => s.snapshot === b.snapshot && s.state === "ready");

/**
 * The build stages start from now (`verified`: verifiedRecords' list, newest first), or null: the newest whose snapshot
 * is ready and whose head is on the default branch. The launcher (currentImage), the build and the prune read it alike.
 */
export async function currentBuild(adapter, repo, verified, opts) {
  for (const b of verified) if ((await imageReady(adapter, b)) && (await onDefaultBranch(repo, b.sha, opts))) return b;
  return null;
}

/**
 * What a stage's sandbox starts from: `{ snapshot, sha, checkout, envFile, builtAt }` for `adapter.create({ snapshot })`,
 * or null when there is no usable image (create from `adapter.baseImage(...)` and run setup cold). The newest build
 * Factory recorded that the vendor's listing confirms, whose snapshot is ready and whose head is on the default branch.
 * `opts` carries the Factory App's token (Factory's login must be known: setSelf), `repoId` the repository's id.
 */
export async function currentImage(adapter, repo, { repoId = null, ...opts }) {
  const id = repoId ?? (await getRepo(repo, opts)).id;
  const [{ builds }, { images }] = await Promise.all([listImages(repo, opts), vendorImages(adapter, id)]);
  const b = await currentBuild(adapter, repo, verifiedRecords(builds, images, adapter.name), opts);
  return b ? { snapshot: b.snapshot, sha: b.sha, builtAt: b.builtAt, ...imagePaths(repo) } : null;
}

/** Milliseconds of image builds (failed ones included) Factory recorded on `now`'s UTC day. */
export function todaysBuildMs(builds, now = new Date()) {
  const day = now.toISOString().slice(0, 10);
  return builds.filter((b) => b.builtAt.slice(0, 10) === day).reduce((sum, b) => sum + (b.buildMs ?? 0), 0);
}

/** The latest nightly build time at or before `now`. */
export function lastNightly(now = new Date()) {
  const t = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), NIGHTLY_UTC.h, NIGHTLY_UTC.m));
  return t > now ? new Date(t.getTime() - 86_400_000) : t;
}

/**
 * Whether this event builds the image. `trigger` is `merge` (a push to the default branch), `nightly` (the nightly
 * schedule), `owed` (the dispatcher saw a head an earlier day left unbuilt, imageOwed) or `manual` (workflow_dispatch). `current` is the newest confirmed, ready image; `lastAttemptAt` when the
 * newest build Factory recorded started, failed ones included. A head already built is never built again, except by
 * hand. On a merge, `refresh: nightly` leaves it to the nightly build; so do today's builds at `dailyMinutes` or more,
 * unless no build was even tried since the last nightly time (GitHub's cron does not always fire): then one merge
 * builds, and its attempt closes the window whether it succeeds or not.
 */
export function imageDecision({ trigger, refresh, head, current, lastAttemptAt = null, todayMs, dailyMinutes, now = new Date() }) {
  if (trigger === "manual") return { build: true };
  if (current?.sha === head) return { skip: `the image is already built from ${head.slice(0, 7)}` };
  if (trigger === "nightly" || trigger === "owed") return { build: true };
  if (trigger !== "merge") return { skip: `no image build on ${trigger}` };
  if (refresh === "nightly") return { skip: "image_refresh is nightly; the nightly build refreshes it" };
  if (todayMs < dailyMinutes * 60_000) return { build: true };
  if (!lastAttemptAt || Date.parse(lastAttemptAt) < lastNightly(now).getTime()) return { build: true, note: "today's minutes are used up, but no build was tried since the last nightly time" };
  return { skip: `today's image builds took ${(todayMs / 60_000).toFixed(1)} min, at or over image_daily_minutes (${dailyMinutes}); the nightly build refreshes it` };
}

/**
 * Whether the image is owed a build now (the dispatcher's tick runs the image job when it is): the default branch's
 * head (`head`, committed at `headAt`) is not the newest build Factory tried (`builds`, newest first, failed ones
 * included), it was committed before today's 00:00 UTC (a head an earlier day's minutes or `image_refresh: nightly`
 * left to the nightly build; a merge today builds on its own push), and today's turn allows one: `merge`, today's
 * builds under `dailyMinutes`; `nightly`, none tried yet today. So an owed build runs on the first dispatcher tick of
 * the UTC day, an event's or a wake's, never on GitHub's nightly cron alone, which stays the backstop.
 */
export function imageOwed({ refresh, head, headAt, builds = [], todayMs, dailyMinutes, now = new Date() }) {
  if (!head || builds[0]?.sha === head) return false;
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  if (!(Date.parse(headAt) < today)) return false;
  if (refresh === "nightly") return !builds.some((b) => Date.parse(b.builtAt) >= today);
  return todayMs < dailyMinutes * 60_000;
}

/**
 * imageOwed from GitHub: Factory's record and the default branch's head commit (`commits/HEAD`), three reads. False when either
 * cannot be read: the next tick, the next merge or the nightly cron tries again.
 */
export async function imageOwedNow(repo, { refresh, dailyMinutes, now = new Date() }, opts) {
  const [{ builds }, commit] = await Promise.all([listImages(repo, opts), rest(`repos/${repo.full}/commits/HEAD`, opts)]);
  return imageOwed({ refresh, head: commit?.sha, headAt: commit?.commit?.committer?.date, builds, todayMs: todaysBuildMs(builds, now), dailyMinutes, now });
}

/**
 * The image job's own next run, as deadlines (lib/logic.mjs nextWake): when a build left an older image a stage may
 * still be starting from, the sweep `PREVIOUS_IMAGE_MS` on (plus WAKE_SLACK_MS), which destroys it (prunableImages).
 */
export function imageWaits({ built = false, olderImage = false, now = Date.now() }) {
  return built && olderImage ? [{ issue: null, kind: "sweep", at: new Date(now + PREVIOUS_IMAGE_MS + WAKE_SLACK_MS).toISOString() }] : [];
}

/** The images a build destroys: all but the newest KEEP by the vendor's clock, never `keep` (the one just built). */
export const staleImages = (images, keep) => images.filter((i) => i.source !== keep).slice(KEEP - 1);

/** When Factory recorded a build (its build's end), in ms; a launcher reading the record sees it from then. */
const recordedAt = (b) => Date.parse(b.builtAt) + (Number.isFinite(b.buildMs) ? b.buildMs : 0);

/**
 * The images to destroy (`images`: vendorImages' list, newest first) given `current` (currentBuild: the build stages start
 * from) and `verified` (verifiedRecords' list). A launcher starts from the image it read until its create is done, so an
 * older recorded image stays while a newer recorded build superseded it less than PREVIOUS_IMAGE_MS ago (two builds a few
 * minutes apart keep both before the current). The rest older than the current goes, unrecorded ones at once. Images newer than the current (a build
 * being recorded, or one stages do not start from) stay. With no current, or one the listing does not show, nothing goes.
 */
export function prunableImages(images, current, verified = [], now = Date.now()) {
  return imagePrune(images, current, verified, now).prune;
}

/**
 * prunableImages' list (`prune`), and `until`: when the first image it keeps for a stage that may still be starting from
 * it becomes prunable (ms; null when it keeps none), the sweep's next run (sweep.mjs sweepWaits).
 */
export function imagePrune(images, current, verified = [], now = Date.now()) {
  const at = current?.source ? images.findIndex((i) => i.source === current.source) : -1;
  if (at < 0) return { prune: [], until: null };
  const when = new Map((verified || []).filter((b) => b.source).map((b) => [b.source, recordedAt(b)]));
  // When the image under the cursor stopped being what a launcher reads: the earliest record of a build newer than it,
  // from the current down. A time that cannot be read counts as now (kept).
  const known = (t) => (Number.isFinite(t) ? t : now);
  let superseded = known(recordedAt(current));
  const prune = [];
  let until = null;
  for (const i of images.slice(at + 1)) {
    // An image no confirmed record names was never what a launcher reads.
    if (!when.has(i.source) || now - superseded >= PREVIOUS_IMAGE_MS) prune.push(i);
    else until = Math.min(until ?? Infinity, superseded + PREVIOUS_IMAGE_MS);
    if (when.has(i.source)) superseded = Math.min(superseded, known(when.get(i.source)));
  }
  return { prune, until };
}

/**
 * Destroy this repository's images no stage needs (prunableImages), from the vendor's listing in this project and
 * Factory's own record: never another repository's (the listing is by this repository's tag). Returns what it did per
 * image, `images: [{source, snapshot, action: "destroyed" | "would destroy" | "skipped", reason}]`, and `until`
 * (imagePrune): when an image it kept for a starting stage becomes prunable, or null.
 */
export async function pruneImages(adapter, repo, { repoId, now = Date.now(), dryRun = false, log = () => {}, ...opts }) {
  const [{ builds }, { images }] = await Promise.all([listImages(repo, opts), vendorImages(adapter, String(repoId))]);
  const verified = verifiedRecords(builds, images, adapter.name);
  const current = await currentBuild(adapter, repo, verified, opts);
  const out = [];
  const { prune, until } = imagePrune(images, current, verified, now);
  for (const i of prune) {
    const reason = `superseded by the current image ${current.snapshot}`;
    if (dryRun) {
      out.push({ source: i.source, snapshot: i.snapshot, action: "would destroy", reason });
      continue;
    }
    try {
      await adapter.destroy(i.source);
      out.push({ source: i.source, snapshot: i.snapshot, action: "destroyed", reason });
    } catch (e) {
      log(`image: destroying ${i.source} failed (${e.code ?? "error"}): ${String(e.message).slice(0, 200)}`);
      out.push({ source: i.source, snapshot: i.snapshot, action: "skipped", reason: `vendor ${e.code ?? "error"}` });
    }
  }
  return { images: out, until };
}
