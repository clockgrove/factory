// Sibling Objectives that change the same files (#277): the dispatcher holds a Queued Objective whose known files
// overlap an active sibling's heavily until that sibling leaves (at most WAIT_MAX_MS), and says so on the waiting
// issue; one that overlaps lightly starts and says it will rebase on the other. Files come only from structure Factory
// already has: an open PR's changed files (GitHub's list) and the plan comment's `Files:` lines (factory-objective-plan).
// An Objective with neither (a first run before its plan) has unknown files: it starts as before and nothing is said.
import { listComments, rest } from "./github.mjs";
import { planOf } from "./handoff.mjs";
import { isSelf, marker, selfLogin, stateOf, trustedAuthor } from "./logic.mjs";

/** The plan line that names a checklist item's files (factory-objective-plan): `Files: a/b.mjs, c.md`. */
export const PLAN_FILES_KEY = "Files";
/** At most this many paths are kept per Objective: a plan line or a PR past it is read as its first ones. */
export const FILES_MAX = 200;
/** A heavy overlap: at least this many shared files, or half of the smaller Objective's files. */
export const HEAVY_SHARED = 3;
/** Queued Objectives past the free slots whose files are read when an earlier one waits. */
export const LOOKAHEAD = 3;
/** The longest a Queued Objective waits for siblings (from its waits comment's start): then it starts beside them. */
export const WAIT_MAX_MS = 6 * 3600_000;

/**
 * The states whose Objectives a Queued one waits for: Running (a worker is on it), and In review only when Factory
 * merges reviewed PRs itself (`autoMerge`); without that, an In-review PR waits for a person, as long as they take.
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
 * The order (pure): `candidates` are the Queued Objectives in pick order, each `{number, files}` (null: unknown);
 * `siblings` the active ones, each `{number, files, state}`; `slots` how many may start; `overdue(number)` whether a
 * candidate has waited WAIT_MAX_MS already. A candidate with known files waits for the first sibling, or earlier
 * starter of this tick, it overlaps heavily, unless overdue: then it starts with a note that says it stopped waiting
 * (`gaveUp`). One it overlaps lightly starts with a note naming them. Returns `{ready, waits: [{number, on, state,
 * shared, of}], notes: [{number, with: [{number, shared}], gaveUp?}]}`; an unknown candidate always starts (while slots
 * last) and gets no note.
 */
export function siblingOrder({ candidates, siblings, slots, overdue = () => false }) {
  const ready = [];
  const waits = [];
  const notes = [];
  const started = [];
  for (const c of candidates) {
    if (ready.length >= slots) break;
    if (!c.files?.length) {
      ready.push(c.number);
      continue;
    }
    const others = [...siblings, ...started].filter((s) => s.number !== c.number && s.files?.length);
    const overlaps = others.map((s) => ({ number: s.number, state: s.state, shared: sharedFiles(c.files, s.files), heavy: false, files: s.files }));
    for (const o of overlaps) o.heavy = heavyOverlap(o.shared, c.files, o.files);
    const heavy = overlaps.find((o) => o.heavy);
    if (heavy && !overdue(c.number)) {
      waits.push({ number: c.number, on: heavy.number, state: heavy.state, shared: heavy.shared, of: new Set(c.files).size });
      continue;
    }
    ready.push(c.number);
    started.push({ number: c.number, files: c.files, state: "Running" });
    const light = overlaps.filter((o) => o.shared.length).map(({ number, shared }) => ({ number, shared }));
    if (light.length) notes.push({ number: c.number, with: light, ...(heavy ? { gaveUp: heavy.number } : {}) });
  }
  return { ready, waits, notes };
}

const list = (paths, max = 5) => `${paths.slice(0, max).map((p) => `\`${p.replace(/`/g, "")}\``).join(", ")}${paths.length > max ? ` and ${paths.length - max} more` : ""}`;
const hours = Math.round(WAIT_MAX_MS / 3600_000);

/** Why a waiting Objective is skipped this tick (the dispatcher's skipped reason). */
export const waitReason = (w) => `waits for #${w.on} to merge: both change ${w.shared.length} file(s) (${list(w.shared, 3)})`;

/** The overlap comment's text on a waiting Objective (its marker added by the caller). */
export function waitNote(w) {
  return `Factory: this Objective waits for #${w.on} (${String(w.state || "running").toLowerCase()}) to merge before it starts: both change ${list(w.shared)}, ${w.shared.length} of this Objective's ${w.of} known file(s). Started together, the one that merges second would rebase over the other. It starts on the first dispatcher tick after #${w.on} merges or stops (Blocked, a Question, its label removed), or after ${hours} h of waiting at most. A run named by hand for this issue starts it now.`;
}

/** The overlap comment's text on an Objective that starts beside siblings it shares files with. */
export function besideNote(n) {
  const each = n.with.map((o) => `#${o.number} (${list(o.shared, 3)})`).join("; ");
  const why = n.gaveUp ? `this Objective stopped waiting for #${n.gaveUp} after ${hours} h, the longest Factory holds one for a sibling, and starts beside ` : "this Objective starts beside ";
  return `Factory: ${why}${each}, which change some of the same files. Whichever merges second rebases onto the other; each rebase and its cost show in that stage's progress comment.`;
}

/** The overlap comment's text once a waiting Objective starts with no overlap left. */
export const clearedNote = (on) => `Factory: this Objective no longer waits for #${on}: no active sibling shares its files now, so it started.`;

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
 * The dispatcher's pass (dispatch.mjs, after selectReady): `ready` the picks and `waiting` the Queued Objectives left
 * out for max_concurrent, both in pick order, with `slots` free; `prs` the open PRs the tick's review pass read, by
 * issue; `landed` the Objectives whose PR the tick merged. Reads files only when a slot is free and a sibling is active or two picks could start together; a failed read
 * leaves that Objective unknown (it starts, as before). Writes the waiting Objectives' comments unless `dryRun`, each
 * only when its text changed; the started ones' notes wait for the tick's final picks (announceStarts). Returns
 * `{ready, waits, notes, seen}` (siblingOrder; `seen` the comments read, by issue).
 */
export async function orderSiblings(repo, { issues, statuses = {}, ready, waiting = [], slots, prs = {}, autoMerge = true, landed = [] }, opts, { dryRun = false, log = () => {}, now = Date.now() } = {}) {
  const byNumber = new Map(issues.map((i) => [i.number, i]));
  const states = activeStates(autoMerge);
  // One whose PR this tick merged (`landed`) is still listed In review, but is gone as a sibling.
  const active = issues.filter((i) => states.has(stateOf(i, statuses[i.number] ?? null)) && !ready.includes(i.number) && !landed.includes(i.number));
  const pool = slots > 0 ? [...ready, ...waiting].slice(0, slots + LOOKAHEAD).map((n) => byNumber.get(n)).filter(Boolean) : [];
  const none = { ready: ready.slice(0, Math.max(0, slots)), waits: [], notes: [], seen: {} };
  // Nothing to compare: no active sibling, and at most one pick can start.
  if (!pool.length || (!active.length && Math.min(slots, pool.length) < 2)) return none;
  const prOf = prFinder(repo, opts, prs);
  const read = async (issue) =>
    knownFiles(repo, issue, opts, prOf).catch((e) => {
      log(`  #${issue.number}: its files are unread (${String(e.message).slice(0, 80)}); taken as unknown`);
      return { files: null, comments: null };
    });
  const candidates = [];
  const seen = {};
  for (const issue of pool) {
    seen[issue.number] = await read(issue);
    candidates.push({ number: issue.number, files: seen[issue.number].files });
  }
  // Siblings are read only when some candidate's files are known: nothing can overlap an unknown one.
  const siblings = [];
  if (candidates.some((c) => c.files?.length)) for (const issue of active) siblings.push({ number: issue.number, state: stateOf(issue, statuses[issue.number] ?? null), files: (await read(issue)).files });
  const waitedSince = (n) => {
    const old = overlapOf(seen[n]?.comments, n);
    return old?.kind === "waits" ? old.since : null;
  };
  const order = siblingOrder({ candidates, siblings, slots, overdue: (n) => waitedSince(n) !== null && now - waitedSince(n) >= WAIT_MAX_MS });
  if (!dryRun)
    for (const w of order.waits) {
      // The wait's start stays with its comment across ticks (and a change of the sibling it waits for): the bound counts from it.
      const since = Math.floor((waitedSince(w.number) ?? now) / 1000);
      await say(repo, w.number, overlapOf(seen[w.number]?.comments, w.number), `waits-${w.on}-${since}`, waitNote(w), opts, log);
    }
  for (const w of order.waits) log(`  #${w.number}: ${waitReason(w)}`);
  return { ...order, seen };
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
