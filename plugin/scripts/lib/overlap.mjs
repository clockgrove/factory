// Sibling Objectives that change the same files (#277, #340). Every Objective with work to write starts: a work stage
// started beside a sibling costs at most one rebase later, while holding it holds the whole stage. What waits is the
// hand-off to review: a work stage delivering a head no review has seen, while a sibling it overlaps heavily is ahead
// of it (aheadOf), leaves its PR ready but unlabelled, with a record on the PR and a note on its issue (reviewHold).
// The dispatcher releases waiting hand-offs one at a time, in the order they began waiting (reviewWaitResume): the
// review label goes on, or a PR that conflicts by then goes back for its rebase first, and that rebase goes to review
// without waiting again. So two PRs that overlap heavily are never reviewed or queued at once, and each waiting PR
// rebases once, onto every merge before it. A start beside a sibling that shares files says so on the issue. Files
// come only from structure Factory already has: an open PR's changed files (GitHub's list) and the plan comment's
// `Files:` lines (factory-objective-plan). An Objective with neither (a first run before its plan) has unknown files:
// it overlaps nothing.
import { addLabels, getIssue, listComments, listIssuesByLabel, objectiveLabeledAt, removeLabel, rest, upsertComment } from "./github.mjs";
import { planOf } from "./handoff.mjs";
import { REVIEW_LABEL, isSelf, marker, priorityOf, selfLogin, stateOf, trustedAuthor } from "./logic.mjs";
import { accountWaitOf } from "./account-wait.mjs";
import { waitOf } from "./third-party-review.mjs";

/** The plan line that names a checklist item's files (factory-objective-plan): `Files: a/b.mjs, c.md`. */
export const PLAN_FILES_KEY = "Files";
/** At most this many paths are kept per Objective: a plan line or a PR past it is read as its first ones. */
export const FILES_MAX = 200;
/** A heavy overlap: at least this many shared files, or half of the smaller Objective's files. */
export const HEAVY_SHARED = 3;
/** The longest a hand-off to review waits for siblings (from its record's start): then the review goes on beside them. */
export const WAIT_MAX_MS = 6 * 3600_000;

/**
 * The states of the siblings a starting Objective's note names: Running (a worker is on it), and In review only when
 * Factory merges reviewed PRs itself (`autoMerge`); without that, an In-review PR waits for a person, as long as they take.
 */
export const activeStates = (autoMerge) => new Set(autoMerge ? ["Running", "In review"] : ["Running"]);

/** Placeholders a plan may write where an item changes no file: never a path. */
const PLACEHOLDER = /^\(?(?:none|n\/a|tbd|nothing|-+|—|–)\)?\.?$/i;

/**
 * One path as a plan names it, repository-relative, or null when it is no plain file path: absolute, `..`, a space, a
 * URL, a placeholder (none, n/a, TBD, a dash), a glob (`*`, `?`, `[`) or a directory (a trailing `/`).
 */
export function cleanPath(raw) {
  let p = String(raw ?? "").trim().replace(/^[`'"]+|[`'"]+$/g, "").trim();
  if (PLACEHOLDER.test(p)) return null;
  p = p.replace(/^\.\//, "");
  if (!p || p.length > 300 || /\s/.test(p) || /[*?[\]]/.test(p) || p.endsWith("/") || p.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(p) || p.split("/").includes("..")) return null;
  return p;
}

/**
 * The files a plan's `Files:` lines name (a list marker before the key is allowed), in order, once each, at most
 * FILES_MAX. Entries are separated by commas; one that is not a plain file path is skipped. Prose elsewhere is never read.
 */
export function plannedFiles(text) {
  const out = new Set();
  const key = new RegExp(`^\\s*(?:[-*+]\\s+(?:\\[[ xX]\\]\\s+)?|\\d+[.)]\\s+)?\\**${PLAN_FILES_KEY}:\\**\\s*(.*)$`);
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const m = key.exec(line);
    if (!m) continue;
    for (const part of m[1].split(",")) {
      const p = cleanPath(part);
      if (p && out.size < FILES_MAX) out.add(p);
    }
  }
  return [...out];
}

/** The paths both lists name, sorted. */
export function sharedFiles(a, b) {
  const other = new Set(b || []);
  return [...new Set(a || [])].filter((p) => other.has(p)).sort();
}

/** Whether `shared` paths between lists of `a` and `b` files is a heavy overlap (HEAVY_SHARED, or half the smaller). */
export function heavyOverlap(shared, a, b) {
  const n = shared.length;
  if (!n) return false;
  return n >= HEAVY_SHARED || n * 2 >= Math.min(new Set(a).size, new Set(b).size);
}

/**
 * The notes (pure): `candidates` are the Objectives that may start, in pick order, each `{number, files}` (null:
 * unknown); `siblings` the active ones, each `{number, files, state}`; `slots` how many start. Every candidate starts
 * while slots last, overlap or not: an Objective with known files has a plan, so its work stage has work of its own to
 * write, and waiting holds that whole stage where starting costs at most one rebase (the hand-off waits instead,
 * reviewHold). One that shares files with a sibling, or an earlier starter of this tick, gets a note naming them, with
 * `heavy` the numbers it overlaps heavily. Returns `{ready, notes: [{number, with: [{number, shared}], heavy}]}`.
 */
export function siblingOrder({ candidates, siblings, slots }) {
  const ready = [];
  const notes = [];
  const started = [];
  for (const c of candidates) {
    if (ready.length >= slots) break;
    ready.push(c.number);
    if (!c.files?.length) continue;
    const others = [...siblings, ...started].filter((s) => s.number !== c.number && s.files?.length);
    started.push({ number: c.number, files: c.files, state: "Running" });
    const overlaps = others.map((s) => ({ number: s.number, shared: sharedFiles(c.files, s.files), heavy: heavyOverlap(sharedFiles(c.files, s.files), c.files, s.files) })).filter((o) => o.shared.length);
    if (overlaps.length) notes.push({ number: c.number, with: overlaps.map(({ number, shared }) => ({ number, shared })), heavy: overlaps.filter((o) => o.heavy).map((o) => o.number) });
  }
  return { ready, notes };
}

const list = (paths, max = 5) => `${paths.slice(0, max).map((p) => `\`${p.replace(/`/g, "")}\``).join(", ")}${paths.length > max ? ` and ${paths.length - max} more` : ""}`;
const hours = Math.round(WAIT_MAX_MS / 3600_000);

/** Why a hand-off waits (the dispatcher's log line and the stage's exit reason): `w` is `{on, shared, cause?}`. */
export const waitReason = (w) => `its review waits for #${w.on} to merge${w.cause ? ` (${w.cause})` : ""}: both change ${w.shared.length} file(s) (${list(w.shared, 3)})`;

/** The overlap comment's text on an Objective whose hand-off to review waits (its marker added by the caller). */
export function waitNote(w, prNumber) {
  return `Factory: PR #${prNumber} is ready, and its review waits for #${w.on} to merge${w.cause ? ` (${w.cause})` : ""}: both change ${list(w.shared)}, ${w.shared.length} of this Objective's ${w.of} known file(s). Reviewed together, the one that merges second would rebase over the other after its review. Once #${w.on} merges or stops (Blocked, a Question, its label removed), and no sibling that waited longer is still ahead of it, or after ${hours} h of waiting at most since its first wait, the dispatcher's next tick puts \`${REVIEW_LABEL}\` on the PR, or first sends it back for its rebase when it conflicts. Putting \`${REVIEW_LABEL}\` on the PR yourself starts its review now.`;
}

/** The overlap comment's text on an Objective that starts beside siblings it shares files with. */
export function besideNote(n) {
  const each = n.with.map((o) => `#${o.number} (${list(o.shared, 3)})`).join("; ");
  const heavy = n.heavy?.length ? ` With ${n.heavy.map((x) => `#${x}`).join(", ")} it shares many: whichever is handed to review second waits until the other merges, then rebases once before its review.` : "";
  return `Factory: this Objective starts beside ${each}, which change some of the same files. Whichever merges second rebases onto the other; each rebase and its cost show in that stage's progress comment.${heavy}`;
}

/** The overlap comment's text once a waiting Objective's wait is over. */
export const clearedNote = (on, gaveUp = false) => (gaveUp ? `Factory: this Objective stopped waiting for #${on} after ${hours} h, the longest Factory holds a review for a sibling; its review goes on beside it.` : `Factory: this Objective no longer waits for #${on}: no sibling In review shares its files now.`);

// What was read, across ticks of one process (a local loop's serve keeps its process; an Actions tick starts empty):
// an issue's comments while its `updated_at` and comment count stay, a PR's files while its head stays.
const commentCache = new Map();
const prFileCache = new Map();
const CACHE_MAX = 500;
const remember = (map, key, value) => {
  if (map.size >= CACHE_MAX) map.clear();
  map.set(key, value);
  return value;
};
/** Empty both caches (tests: a new fake GitHub). */
export function forgetFiles() {
  commentCache.clear();
  prFileCache.clear();
}

/** The issue's comments, from the cache while its `updated_at` and comment count are what they were. */
async function commentsOf(repo, issue, opts) {
  if (!(issue.comments > 0)) return [];
  const id = `${repo.full}#${issue.number}`;
  const key = `${issue.updated_at}|${issue.comments}`;
  const hit = commentCache.get(id);
  if (hit?.key === key) return hit.comments;
  const comments = await listComments(repo, issue.number, opts);
  remember(commentCache, id, { key, comments });
  return comments;
}

/** The PR's changed files (the first page, 100), from the cache while its head is the same commit. */
async function prFiles(repo, pr, opts) {
  const key = `${repo.full}#${pr.number}@${pr.head?.sha}`;
  if (prFileCache.has(key)) return prFileCache.get(key);
  const files = ((await rest(`repos/${repo.full}/pulls/${pr.number}/files?per_page=100`, opts)) || []).map((f) => f?.filename).filter((f) => typeof f === "string");
  return remember(prFileCache, key, files);
}

/**
 * The open `factory/<n>` PR of an issue: from `known` (the PRs this tick's review pass already read, by issue; null
 * for none), else from one listing of the repository's open PRs, made at most once per call of this function's
 * result. Only PRs from this repository's own branches count: a fork's branch of the same name is no Factory PR.
 */
export function prFinder(repo, opts, known = {}) {
  let listed = null;
  return async (n) => {
    if (Object.hasOwn(known, n)) return known[n];
    listed ??= rest(`repos/${repo.full}/pulls?state=open&per_page=100`, { ...opts, paginate: true }).then((all) => {
      const out = new Map();
      for (const pr of all || []) {
        const m = /^factory\/(\d+)$/.exec(pr?.head?.ref || "");
        if (m && pr.head?.repo?.full_name?.toLowerCase() === repo.full.toLowerCase()) out.set(Number(m[1]), pr);
      }
      return out;
    });
    return (await listed).get(n) ?? null;
  };
}

/**
 * The files Factory knows an Objective will change: its open PR's changed files (the first 100) and its plan comment's
 * `Files:` lines, joined; null when it has neither. An issue with no comments has no plan and no Factory PR (a PR
 * comes with progress comments), so it costs no read. `prOf` is a prFinder.
 */
export async function knownFiles(repo, issue, opts, prOf) {
  if (!(issue.comments > 0)) return { files: null, comments: [] };
  const all = await commentsOf(repo, issue, opts);
  const planned = plannedFiles(planOf(all, issue.number)?.text ?? "");
  const pr = await prOf(issue.number);
  const changed = pr ? await prFiles(repo, pr, opts) : [];
  const files = [...new Set([...changed, ...planned])].slice(0, FILES_MAX);
  return { files: files.length ? files : null, comments: all };
}

/** The overlap comment's marker: its kind (`waits-<sibling>-<since, epoch s>`, `beside`, `cleared`), read by overlapOf. */
export const overlapMarker = (n, kind) => marker(n, "overlap", kind);

/** Factory's own overlap comment on issue `n` among `comments`: {id, body, kind, on, since (ms)}, or null. */
export function overlapOf(comments, n) {
  const prefix = marker(n, "overlap").replace(/ -->$/, ":");
  // Only Factory's own comment (anyone can paste the marker); before Factory knows its login, one by a writer (as upsertComment).
  const c = (comments || []).find((x) => (selfLogin() ? isSelf(x) : trustedAuthor(x)) && (x.body || "").startsWith(prefix));
  if (!c) return null;
  const kind = /^([a-z]+)(?:-(\d+))?(?:-(\d+))? -->/.exec(c.body.slice(prefix.length));
  return { id: c.id, body: c.body, kind: kind?.[1] ?? null, on: kind?.[2] ? Number(kind[2]) : null, since: kind?.[3] ? Number(kind[3]) * 1000 : null };
}

/** Write issue `n`'s overlap comment as `kind` and `text` over `old` (overlapOf), unless it already says exactly that. */
async function say(repo, n, old, kind, text, opts, log) {
  const body = `${overlapMarker(n, kind)}\n${text}`;
  if (old?.body === body) return;
  await rest(old ? `repos/${repo.full}/issues/comments/${old.id}` : `repos/${repo.full}/issues/${n}/comments`, { ...opts, method: old ? "PATCH" : "POST", body: { body } }).catch((e) => log(`  #${n}: overlap comment: ${String(e.message).slice(0, 120)}`));
  commentCache.delete(`${repo.full}#${n}`);
}

/**
 * The dispatcher's pass (dispatch.mjs, after selectReady): `ready` the picks in pick order; `prs` the open PRs the
 * tick's review pass read, by issue; `landed` the Objectives whose PR the tick merged. Reads files only when a sibling
 * is active or two picks start together; a failed read leaves that Objective unknown (no note). Holds nothing: the
 * started ones' notes wait for the tick's final picks (announceStarts). Returns `{ready, notes, seen}` (siblingOrder;
 * `seen` the comments read, by issue).
 */
export async function orderSiblings(repo, { issues, statuses = {}, ready, prs = {}, autoMerge = true, landed = [] }, opts, { log = () => {} } = {}) {
  const byNumber = new Map(issues.map((i) => [i.number, i]));
  const states = activeStates(autoMerge);
  // One whose PR this tick merged (`landed`) is still listed In review, but is gone as a sibling.
  const active = issues.filter((i) => states.has(stateOf(i, statuses[i.number] ?? null)) && !ready.includes(i.number) && !landed.includes(i.number));
  const pool = ready.map((n) => byNumber.get(n)).filter(Boolean);
  const none = { ready, notes: [], seen: {} };
  // Nothing to compare: no active sibling, and at most one pick.
  if (!pool.length || (!active.length && pool.length < 2)) return none;
  const prOf = prFinder(repo, opts, prs);
  const read = (issue) => readFiles(repo, issue, opts, prOf, log);
  const candidates = [];
  const seen = {};
  for (const issue of pool) {
    seen[issue.number] = await read(issue);
    candidates.push({ number: issue.number, files: seen[issue.number].files });
  }
  // Siblings are read only when some candidate's files are known: nothing can overlap an unknown one.
  const siblings = [];
  if (candidates.some((c) => c.files?.length)) for (const issue of active) siblings.push({ number: issue.number, state: stateOf(issue, statuses[issue.number] ?? null), files: (await read(issue)).files });
  return { ...siblingOrder({ candidates, siblings, slots: pool.length }), seen };
}

/** knownFiles, with a failed read taken as unknown files (and said in the log). */
const readFiles = (repo, issue, opts, prOf, log) =>
  knownFiles(repo, issue, opts, prOf).catch((e) => {
    log(`  #${issue.number}: its files are unread (${String(e.message).slice(0, 80)}); taken as unknown`);
    return { files: null, comments: null };
  });

/**
 * The PR record of a hand-off's wait (reviewHold): a comment whose first line is `<prefix><on>-<since, epoch s> -->`
 * while it waits, `-released -->` once its wait is over. Released records stay: they keep the Objective's first wait
 * start (the bound is per Objective), and they mark a PR that went through its wait as ahead of those still waiting.
 */
const reviewWaitPrefix = (n) => marker(n, "review-wait").replace(/ -->$/, ":");

/**
 * The PR's review-wait record (reviewHold) among its comments: `{id, on, since (ms), released, at (ms, its last write)}`,
 * or null. Factory's own, or one by a writer who can push: a local loop writes as its developer, the Action as its App,
 * and either reads the other's.
 */
export function reviewWaitOf(comments, n) {
  const prefix = reviewWaitPrefix(n);
  const c = [...(comments || [])].reverse().find((x) => trustedAuthor(x) && String(x.body || "").startsWith(prefix));
  const m = c && /^(\d+)-(\d+)(-released)? -->/.exec(c.body.slice(prefix.length));
  return m ? { id: c.id, on: Number(m[1]), since: Number(m[2]) * 1000, released: !!m[3], at: Date.parse(c.updated_at || c.created_at) || null } : null;
}

/** Write issue `n`'s PR record (reviewWaitOf's form), over Factory's earlier one. */
function writeWait(repo, n, prNumber, { on, since, released = false }, text, opts) {
  return upsertComment(repo, prNumber, reviewWaitPrefix(n), text, opts, { head: `${on}-${Math.floor(since / 1000)}${released ? "-released" : ""} -->` });
}

/** The release order of waiting hand-offs: the oldest first wait, then priority, then number. */
const keyOf = (since, issue) => [since, priorityOf(issue), issue.number];
const before = (a, b) => (a[0] - b[0] || a[1] - b[1] || a[2] - b[2]) < 0;

/** A sibling's PR, its record and what its own review waits for (a third-party reviewer, an account label), read once per `memo`. */
function siblingState(repo, n, opts, prOf, memo) {
  if (!memo.has(n))
    memo.set(
      n,
      (async () => {
        const pr = await prOf(n);
        if (!pr) return { pr: null, record: null, cause: null };
        const comments = await listComments(repo, pr.number, opts);
        const cause = waitOf(comments, n) ? "its review waits for a third-party reviewer" : accountWaitOf(comments, n) ? "its review waits for one account label" : null;
        return { pr, record: reviewWaitOf(comments, n), cause };
      })(),
    );
  return memo.get(n);
}

/**
 * The first sibling, by priority then number, that `issue` (its listing) overlaps heavily and that is ahead of it:
 * `{on, shared, of, cause}`, or null. `others` are the other Objectives In review or Running, `stateOf(s)` the state of
 * one, `key` this Objective's place in the release order (keyOf). Ahead is: In review with no record (in review or in
 * the merge queue); a record whose wait is over, on an open ready PR (In review, or Running its rebase after the wait);
 * a record still waiting, In review, earlier in the release order. A Running sibling with no record is not ahead: the
 * first to hand off goes first. Files come from knownFiles; unknown files overlap nothing.
 */
async function aheadOf(repo, { issue, key, others, state }, opts, prOf, memo, log) {
  const mine = (await readFiles(repo, issue, opts, prOf, log)).files;
  if (!mine) return null;
  const order = [...others].filter((s) => s.number !== issue.number).sort((a, b) => priorityOf(a) - priorityOf(b) || a.number - b.number);
  for (const s of order) {
    const theirs = (await readFiles(repo, s, opts, prOf, log)).files;
    const shared = sharedFiles(mine, theirs);
    if (!theirs || !heavyOverlap(shared, mine, theirs)) continue;
    const { pr, record, cause } = await siblingState(repo, s.number, opts, prOf, memo);
    const st = state(s);
    const ahead = record?.released ? !!pr && !pr.draft : record ? st === "In review" && before(keyOf(record.since, s), key) : st === "In review";
    if (ahead) return { on: s.number, shared, of: new Set(mine).size, cause: record && !record.released ? `it waits for #${record.on} itself` : cause };
  }
  return null;
}

/** Issue `n`'s note on its waiting hand-off (`wait`, from `since`), written only when its text changed. */
export async function sayWaiting(repo, issue, prNumber, wait, since, opts, { log = () => {} } = {}) {
  const comments = await commentsOf(repo, issue, opts).catch(() => null);
  await say(repo, issue.number, overlapOf(comments, issue.number), `waits-${wait.on}-${Math.floor(since / 1000)}`, waitNote(wait, prNumber), opts, log);
}

/**
 * The work stage's hand-off of a head no review has seen (worker.mjs, its PR `pr` delivered and ready, the review label
 * off). With `autoMerge`, a sibling ahead of it (aheadOf) holds it: the record goes on the PR first, keeping the
 * Objective's first wait start when it waited before, then the note on the issue, and the review label stays off; the
 * stage ends delivered and the Objective In review, its slot free. Returns the wait (`{on, shared, of, cause}`) or null:
 * the caller puts the review label on. Nothing holds a reviewed head Factory rebased (`rebaseMode` and `reviewed`), nor
 * the rebase of a hand-off whose wait is over (its record released): it goes next. A read that fails holds nothing (the
 * review goes on, as without siblings); a record that cannot be written holds nothing either.
 */
export async function reviewHold(repo, { issue, pr, autoMerge, objectiveLabel = "factory:objective", rebaseMode = false, reviewed = false }, opts, { log = () => {}, now = Date.now() } = {}) {
  if (!autoMerge || !pr || (rebaseMode && reviewed)) return null;
  try {
    const has = (i, name) => (i.labels || []).some((l) => (typeof l === "string" ? l : l.name) === name);
    const others = new Map();
    for (const label of ["factory:in-review", "factory:running"]) for (const i of await listIssuesByLabel(repo, label, opts)) if (i.number !== issue && has(i, objectiveLabel)) others.set(i.number, i);
    if (!others.size) return null;
    const own = reviewWaitOf(await listComments(repo, pr.number, opts), issue);
    if (rebaseMode && own?.released) return null;
    const self = await getIssue(repo, issue, opts);
    const since = own ? own.since : now;
    const prOf = prFinder(repo, opts, { [issue]: pr });
    const wait = await aheadOf(repo, { issue: self, key: keyOf(since, self), others: [...others.values()], state: (s) => (has(s, "factory:in-review") ? "In review" : "Running") }, opts, prOf, new Map(), log);
    if (!wait) return null;
    await writeWait(repo, issue, pr.number, { on: wait.on, since }, `Factory: ${waitReason(wait)}; the dispatcher puts \`${REVIEW_LABEL}\` on this PR once it has.`, opts);
    await sayWaiting(repo, self, pr.number, wait, since, opts, { log });
    return wait;
  } catch (e) {
    log(`#${issue}: siblings on the same files unread (${String(e?.message || e).slice(0, 120)}); handed to review`);
    return null;
  }
}

/**
 * The dispatcher's half (dispatch.mjs, an In-review Objective `issue` whose PR `pr` is unlabelled with a waiting record
 * `wait`): `issues` and `statuses` the tick's Objectives, `landed` those whose PR the tick merged, `memo` the siblings
 * this tick read (siblingState). Returns, writing nothing when `dryRun`:
 * - "draft": the PR went back to a draft (a stop, a Block); the record goes and no label goes on;
 * - "stale": the review label went on after the record (a person, or a review resumed): the record is released and the
 *   PR handled as any In-review PR;
 * - `{waiting}`: a sibling is ahead of it (aheadOf) and it has waited less than WAIT_MAX_MS since its first wait;
 * - "unsettled": GitHub has not worked out whether it conflicts; the next tick decides;
 * - "rebase": it conflicts, so its record is released and the send-back takes it, before any review;
 * - "released": the review label goes on, then the record is released.
 * Without `autoMerge` nothing waits for an In-review sibling, so a record found then is released at once. The issue's
 * note says when the wait is over. A failed read or write throws (the next tick tries again).
 */
export async function reviewWaitResume(repo, { issue, pr, wait, issues, statuses = {}, landed = [], autoMerge = true, prOf, memo = new Map() }, opts, { dryRun = false, log = () => {}, now = Date.now() } = {}) {
  if (pr.draft) {
    if (!dryRun) await rest(`repos/${repo.full}/issues/comments/${wait.id}`, { ...opts, method: "DELETE" });
    return "draft";
  }
  const release = (how, text) => writeWait(repo, issue.number, pr.number, { on: wait.on, since: wait.since, released: true }, text, opts).then(() => how);
  const labelledAt = await objectiveLabeledAt(repo, pr.number, REVIEW_LABEL, opts);
  if (labelledAt && wait.at && Date.parse(labelledAt) > wait.at) return dryRun ? "stale" : release("stale", "Factory: the review label went on after this PR's wait began; it waits no more.");
  const gaveUp = now - wait.since >= WAIT_MAX_MS;
  if (autoMerge && !gaveUp) {
    const others = issues.filter((i) => i.number !== issue.number && !landed.includes(i.number) && ["In review", "Running"].includes(stateOf(i, statuses[i.number] ?? null)));
    const on = await aheadOf(repo, { issue, key: keyOf(wait.since, issue), others, state: (s) => stateOf(s, statuses[s.number] ?? null) }, opts, prOf, memo, log);
    if (on) return { waiting: on };
  }
  if (!pr.mergeable_state || pr.mergeable_state === "unknown") return "unsettled";
  const how = pr.mergeable_state === "dirty" ? "rebase" : "released";
  if (dryRun) return how;
  // The label first: once it is on, the record's wait is over whatever its text says (its time is earlier).
  if (how === "released") {
    await removeLabel(repo, pr.number, REVIEW_LABEL, opts);
    await addLabels(repo, pr.number, [REVIEW_LABEL], opts);
  }
  await release(how, how === "rebase" ? `Factory: this PR's wait for #${wait.on} is over; it rebases, then goes to review.` : `Factory: this PR's wait for #${wait.on} is over; it goes to review.`);
  const old = overlapOf(await commentsOf(repo, issue, opts).catch(() => null), issue.number);
  if (old?.kind === "waits") await say(repo, issue.number, old, "cleared", clearedNote(wait.on, gaveUp && autoMerge), opts, log);
  return how;
}

/**
 * A run a person named for this Objective (local.mjs `factory run <issue>`) does not wait: the review label goes on, its
 * PR's waiting record (`wait`, reviewWaitOf) is released, and the issue's note says the wait is over. A failed write throws.
 */
export async function reviewNow(repo, { issue, prNumber, wait }, opts) {
  await removeLabel(repo, prNumber, REVIEW_LABEL, opts);
  await addLabels(repo, prNumber, [REVIEW_LABEL], opts);
  await writeWait(repo, issue, prNumber, { on: wait.on, since: wait.since, released: true }, "Factory: a run named by hand for this Objective started its review.", opts);
  const old = overlapOf(await listComments(repo, issue, opts).catch(() => null), issue);
  if (old?.kind === "waits") await say(repo, issue, old, "cleared", `Factory: this Objective no longer waits for #${wait.on}: a run named for it by hand started its review.`, opts, () => {});
}

/**
 * The notes of the Objectives this tick starts (`started`, the dispatcher's final picks, after every later hold):
 * `order`'s light-overlap notes (orderSiblings, or null when it did not run), and for a pick whose earlier waits
 * comment is still up, that it no longer waits. A pick's comments are read only when `order` did not read them and
 * it has any (a quiet tick that started what used to wait).
 */
export async function announceStarts(repo, { started, issues, order = null }, opts, { log = () => {} } = {}) {
  const byNumber = new Map(issues.map((i) => [i.number, i]));
  for (const n of started) {
    const issue = byNumber.get(n);
    if (!issue) continue;
    const comments = order?.seen?.[n]?.comments ?? (await commentsOf(repo, issue, opts).catch(() => null));
    const old = overlapOf(comments, n);
    const note = order?.notes?.find((x) => x.number === n);
    if (note) await say(repo, n, old, "beside", besideNote(note), opts, log);
    else if (old?.kind === "waits") await say(repo, n, old, "cleared", clearedNote(old.on), opts, log);
  }
}
