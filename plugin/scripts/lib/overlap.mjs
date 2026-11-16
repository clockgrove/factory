// Sibling Objectives that change the same files (#277, #340, #365, #366). Every Objective with work to write starts: a
// work stage started beside a sibling costs at most one rebase later, while holding it holds the whole stage. What waits
// is the hand-off to review: a work stage delivering a head no review has seen, while a sibling whose head it conflicts
// with is ahead of it (aheadOf), leaves its PR ready but unlabelled, with a record on the PR and a note on its issue
// (reviewHold). Whether two heads conflict is a trial merge of the two (git merge-tree in a scratch mirror,
// siblingTrials), never a count of shared files. The dispatcher releases waiting hand-offs one at a time, in the order
// they began waiting (reviewWaitResume): the review label goes on, or a PR that conflicts by then goes back for its
// rebase first, and that rebase goes to review without waiting again. So two PRs that conflict are never reviewed or
// queued at once, and each waiting PR rebases once, onto every merge before it. The send-backs of conflicting In-review
// PRs go in the release order too (sendBackOrder): one is sent back only when no sibling ahead of it, which merges first,
// would make it conflict again. A start beside a sibling that shares files says so on the issue. Files come only from
// structure Factory already has: an open PR's changed files (GitHub's list) and the plan comment's `Files:` lines
// (factory-objective-plan). An Objective with neither (a first run before its plan) has unknown files: it overlaps
// nothing at its start.
import { addLabels, getIssue, listComments, listIssuesByLabel, objectiveLabeledAt, removeLabel, rest, upsertComment } from "./github.mjs";
import { planOf } from "./handoff.mjs";
import { REVIEW_LABEL, isSelf, marker, priorityOf, selfLogin, stateOf, trustedAuthor } from "./logic.mjs";
import { accountWaitOf } from "./account-wait.mjs";
import { TrialUnread, trialMerges } from "./outbox.mjs";
import { waitOf } from "./third-party-review.mjs";

/** The plan line that names a checklist item's files (factory-objective-plan): `Files: a/b.mjs, c.md`. */
export const PLAN_FILES_KEY = "Files";
/** At most this many paths are kept per Objective: a plan line or a PR past it is read as its first ones. */
export const FILES_MAX = 200;
/**
 * The new trial merges one PR's judgement computes at most (a hand-off, a waiting hand-off's tick, a send-back's tick):
 * a pair of heads already merged in this process is read from its cache and counts nothing, and each PR has its own
 * bound, so early PRs never use up a later one's. A tick's merges are bounded by the pairs of its PRs, at most once
 * each (the cache). A bound on one PR's git work, not a judgement: past it, a pair is unread. `max` is settable (tests).
 */
export const TRIALS = { max: 50 };
/**
 * The longest a hand-off to review waits for siblings (from its record's start): then the review goes on beside them.
 * The default of the repository's sibling_wait_hours (inputs.mjs resolveInputs `siblingWaitMs`), which every function
 * here that bounds a wait takes as `waitMaxMs`.
 */
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

/**
 * The notes (pure): `candidates` are the Objectives that may start, in pick order, each `{number, files}` (null:
 * unknown); `siblings` the active ones, each `{number, files, state}`; `slots` how many start. Every candidate starts
 * while slots last, overlap or not: an Objective with known files has a plan, so its work stage has work of its own to
 * write, and waiting holds that whole stage where starting costs at most one rebase (the hand-off waits instead,
 * reviewHold). One that shares files with a sibling, or an earlier starter of this tick, gets a note naming them.
 * Returns `{ready, notes: [{number, with: [{number, shared}]}]}`.
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
    const overlaps = others.map((s) => ({ number: s.number, shared: sharedFiles(c.files, s.files) })).filter((o) => o.shared.length);
    if (overlaps.length) notes.push({ number: c.number, with: overlaps });
  }
  return { ready, notes };
}

/** A path for a comment: no backtick, angle bracket or line break of its own, so it ends no code span and starts no marker. */
const safePath = (p) => String(p).replace(/`/g, "").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/[\r\n]+/g, " ");
const list = (paths, max = 5) => `${paths.slice(0, max).map((p) => `\`${safePath(p)}\``).join(", ")}${paths.length > max ? ` and ${paths.length - max} more` : ""}`;
/** A wait's bound in hours, as a note says it (6, 1.5). */
const hours = (waitMaxMs) => Number((waitMaxMs / 3600_000).toFixed(2));

/** What a trial merge found (`w.files`, the paths it conflicts in), after a wait's sibling and cause. */
const found = (w, max) => (w.files?.length ? `: a trial merge of the two heads conflicts in ${w.files.length} file(s) (${list(w.files, max)})` : w.unread?.length || w.order ? "" : ": a trial merge of the two heads conflicts");
const causeOf = (w) => (w.cause ? ` (${w.cause})` : "");

/** Why a hand-off waits (the dispatcher's log line and the stage's exit reason): `w` is `{on, files, cause?, unread?}`. */
export const waitReason = (w) => `its review waits for #${w.on} to merge${causeOf(w)}${found(w, 3)}`;

/** The overlap comment's text on an Objective whose hand-off to review waits (its marker added by the caller). */
export function waitNote(w, prNumber, waitMaxMs = WAIT_MAX_MS) {
  return `Factory: PR #${prNumber} is ready, and its review waits for #${w.on} to merge${causeOf(w)}${found(w, 5)}. Reviewed together, the one that merges second would rebase over the other after its review. Once #${w.on} merges or stops (Blocked, a Question, its label removed), and no sibling that waited longer is still ahead of it, or after ${hours(waitMaxMs)} h of waiting at most since its first wait, the dispatcher's next tick puts \`${REVIEW_LABEL}\` on the PR, or first sends it back for its rebase when it conflicts. Putting \`${REVIEW_LABEL}\` on the PR yourself starts its review now.`;
}

/** Why a conflicting PR's rebase waits (sendBackOrder; the dispatcher's log line and its PR record). */
export const rebaseWaitReason = (w) => `its rebase waits for #${w.on} to merge first${causeOf(w)}${found(w, 3)}`;

/** The overlap comment's text on an Objective whose conflicting PR's rebase waits (its marker added by the caller). */
export const rebaseWaitNote = (w, prNumber, waitMaxMs = WAIT_MAX_MS) =>
  `Factory: PR #${prNumber} conflicts with the default branch, and its rebase waits for #${w.on} to merge first${causeOf(w)}${found(w, 5)}. Rebased now, it would need another rebase once #${w.on} merges. Once #${w.on} merges or stops, or after ${hours(waitMaxMs)} h of waiting at most (counted with any wait of its review before), the dispatcher sends it back for its rebase.`;

/**
 * The overlap comment's text on an Objective that starts beside siblings it shares files with; `hold` when a hand-off
 * waits for a sibling it conflicts with (Factory merges, sibling_hold on).
 */
export function besideNote(n, hold = false) {
  const each = n.with.map((o) => `#${o.number} (${list(o.shared, 3)})`).join("; ");
  const wait = hold ? " Where their changes conflict, whichever is handed to review second waits until the other merges, then rebases once before its review." : "";
  return `Factory: this Objective starts beside ${each}, which change some of the same files. Whichever merges second rebases onto the other when they conflict; each rebase and its cost show in that stage's progress comment.${wait}`;
}

/** The overlap comment's text once a waiting Objective's wait is over. */
export const clearedNote = (on, gaveUp = false, waitMaxMs = WAIT_MAX_MS) => (gaveUp ? `Factory: this Objective stopped waiting for #${on} after ${hours(waitMaxMs)} h, the longest Factory holds a review for a sibling; its review goes on beside it.` : `Factory: this Objective no longer waits for #${on}: no sibling ahead of it conflicts with it now.`);

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
/** Empty the caches (tests: a new fake GitHub). */
export function forgetFiles() {
  commentCache.clear();
  prFileCache.clear();
  trialCache.clear();
}

// The paths each pair of heads conflicts in, across ticks of one process: a commit never changes, so neither does that.
const trialCache = new Map();

/** The git URL of `repo` on the GitHub server the run belongs to (GITHUB_SERVER_URL, else github.com). */
export const gitRemote = (repo) => `${(process.env.GITHUB_SERVER_URL || "https://github.com").replace(/\/+$/, "")}/${repo.full}.git`;

/** Past TRIALS.max new trial merges in one PR's judgement. */
export class TrialCap extends Error {}

/**
 * Trial merges of PR heads for one dispatcher tick or one hand-off (outbox.mjs trialMerges, one scratch mirror).
 * `scope()` is one PR's judgement: its `conflicts(a, b)` resolves to `{conflict, files}` for the two heads against the
 * default branch's head now, from this process's cache when that pair was merged on that head before; it rejects with
 * TrialUnread when the pair cannot be merged (`missing` the heads the server did not have) and with TrialCap past
 * `max` new merges in that scope. `conflicts` itself is one scope's. `max` bounds one PR's judgement; a tick's merges are
 * bounded by the pairs of its PRs, each merged at most once (the cache). The caller closes it.
 */
export function siblingTrials(repo, opts, { max = TRIALS.max } = {}) {
  const token = typeof opts?.token === "function" ? opts.token : () => opts?.token ?? null;
  const box = trialMerges({ remote: gitRemote(repo), token });
  const scope = () => {
    let left = max;
    return {
      async conflicts(a, b) {
        const [x, y] = [a, b].sort();
        const key = `${repo.full}|${await box.main()}|${x}|${y}`;
        if (trialCache.has(key)) return trialCache.get(key);
        if (left <= 0) throw new TrialCap(`past the ${max} trial merges one PR's judgement computes`);
        left -= 1;
        const { conflict, files } = await box.conflicts(x, y);
        return remember(trialCache, key, { conflict, files });
      },
    };
  };
  return { ...scope(), scope, close: () => box.close() };
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
  const { notes, ...order } = siblingOrder({ candidates, siblings, slots: pool.length });
  return { ...order, notes: notes.map((n) => ({ ...n, hold: autoMerge })), seen };
}

/** knownFiles, with a failed read taken as unknown files (and said in the log). */
const readFiles = (repo, issue, opts, prOf, log) =>
  knownFiles(repo, issue, opts, prOf).catch((e) => {
    log(`  #${issue.number}: its files are unread (${String(e.message).slice(0, 80)}); taken as unknown`);
    return { files: null, comments: null };
  });

/**
 * The PR records of a wait: a hand-off's (reviewHold, `review-wait`) and a send-back's (sendBackOrder, `sendback-wait`).
 * Each is a comment whose first line is `<prefix><on>-<since, epoch s>[-u<sha>] -->` while it waits, with `-released`
 * before ` -->` once its wait is over (`-over` instead when a send-back's wait ended with nothing left to rebase: its
 * bound ends with it); `u<sha>[.<sha>...]` names the sibling heads that could not be fetched for a trial
 * merge, so the next tick that cannot fetch them either goes on without them. Released records stay: they keep the Objective's first wait
 * start (the bound is per Objective), and a released hand-off record marks a PR that went through its wait as ahead of
 * those still waiting.
 */
const recordPrefix = (n, kind) => marker(n, kind).replace(/ -->$/, ":");

/** The newest record of `kind` on a PR among its comments (Factory's own, or one by a writer who can push). */
function waitRecordOf(comments, n, kind) {
  const prefix = recordPrefix(n, kind);
  const c = [...(comments || [])].reverse().find((x) => trustedAuthor(x) && String(x.body || "").startsWith(prefix));
  const m = c && /^(\d+)-(\d+)(?:-u([0-9a-f]{40}(?:\.[0-9a-f]{40})*))?(-released|-over)? -->/.exec(c.body.slice(prefix.length));
  return m ? { id: c.id, on: Number(m[1]), since: Number(m[2]) * 1000, unread: m[3] ? m[3].split(".") : [], released: !!m[4], over: m[4] === "-over", at: Date.parse(c.updated_at || c.created_at) || null } : null;
}

/**
 * The PR's review-wait record (reviewHold) among its comments: `{id, on, since (ms), unread, released, at (ms, its last
 * write)}`, or null. Factory's own, or one by a writer who can push: a local loop writes as its developer, the Action as
 * its App, and either reads the other's.
 */
export const reviewWaitOf = (comments, n) => waitRecordOf(comments, n, "review-wait");
/** The PR's sendback-wait record (sendBackOrder), as reviewWaitOf. */
export const rebaseWaitOf = (comments, n) => waitRecordOf(comments, n, "sendback-wait");

/** Write issue `n`'s PR record of `kind` (waitRecordOf's form), over Factory's earlier one. */
function writeRecord(repo, n, prNumber, kind, { on, since, unread = [], released = false, over = false }, text, opts) {
  return upsertComment(repo, prNumber, recordPrefix(n, kind), text, opts, { head: `${on}-${Math.floor(since / 1000)}${unread?.length ? `-u${unread.join(".")}` : ""}${over ? "-over" : released ? "-released" : ""} -->` });
}
const writeWait = (repo, n, prNumber, wait, text, opts) => writeRecord(repo, n, prNumber, "review-wait", wait, text, opts);

/** The release order of waiting hand-offs: the oldest first wait, then priority, then number. */
const keyOf = (since, issue) => [since, priorityOf(issue), issue.number];
const before = (a, b) => (a[0] - b[0] || a[1] - b[1] || a[2] - b[2]) < 0;

/** Whether a trusted comment among `comments` starts with marker `mark` (any id after it). */
const hasMark = (comments, mark) => (comments || []).some((c) => trustedAuthor(c) && String(c.body || "").startsWith(mark.replace(/ -->$/, ":")));
/** Whether issue `n`'s PR was handed to review before (its worker's validated or handed-off marker, on any head). */
const handedOff = (comments, n) => hasMark(comments, marker(n, "validated")) || hasMark(comments, marker(n, "handed-off"));

/** A sibling's PR, its records and what its own review waits for (a third-party reviewer, an account label), read once per `memo`. */
function siblingState(repo, n, opts, prOf, memo) {
  if (!memo.has(n))
    memo.set(
      n,
      (async () => {
        const pr = await prOf(n);
        if (!pr) return { pr: null, record: null, rebaseWait: null, cause: null };
        const comments = await listComments(repo, pr.number, opts);
        const cause = waitOf(comments, n) ? "its review waits for a third-party reviewer" : accountWaitOf(comments, n) ? "its review waits for one account label" : null;
        return { pr, record: reviewWaitOf(comments, n), rebaseWait: rebaseWaitOf(comments, n), cause, sentBack: handedOff(comments, n) && hasMark(comments, marker(n, "rebase")) };
      })(),
    );
  return memo.get(n);
}

/** A wait's cause when sibling heads could not be fetched. */
const unreadCause = (unread) => `${unread.length > 1 ? `${unread.length} sibling heads` : "its head"} could not be fetched for a trial merge`;

/** The release order of siblings (aheadOf, sendBackOrder): priority, then number. */
const byRelease = (a, b) => priorityOf(a) - priorityOf(b) || a.number - b.number;

/**
 * The trial merge of `head` with a sibling's `theirs`: `{conflict, files}`, or `{unread: theirs}` when the server did not
 * have the sibling's head (a push in flight, a branch moved), or null when that same head could not be fetched last time
 * either (`skip`, the heads the waiting PR's record names): it is left out. Anything else unread throws.
 */
async function trial(trials, head, theirs, skip = []) {
  try {
    return await trials.conflicts(head, theirs);
  } catch (e) {
    if (!(e instanceof TrialUnread) || !e.missing.includes(theirs) || e.missing.includes(head)) throw e;
    return skip.includes(theirs) ? null : { unread: theirs };
  }
}

/**
 * The first sibling, by priority then number, whose PR head conflicts with `head` (this Objective's PR head) by a trial
 * merge against the default branch (siblingTrials), and that is ahead of it: `{on, files, cause, unread}` (`files` the
 * paths the merge conflicts in), or null. `others` are the other Objectives In review or Running, `stateOf(s)` the state
 * of one, `key` this Objective's place in the release order (keyOf), `stuck(s)` whether one can run no stage now (two
 * account labels, as Blocked), and a sibling whose own review waits (a third-party reviewer, an account label) will
 * not merge soon: neither is ahead. `trials` a siblingTrials, `skip` a sibling head this Objective's record says could not be
 * fetched before. Ahead is: In review with no record (in review or in the merge queue); Running the send-back rebase of
 * an open ready PR it handed to review before; a record whose wait is over, on an open ready PR (In review, or Running
 * its rebase after the wait); a record still waiting, In review, earlier in the release order. A Running sibling that
 * has not handed off is not ahead: the first to hand off goes first. A sibling with no open ready PR has no head to
 * merge: it is not ahead. One ahead whose head cannot be fetched is taken as conflicting once (`unread` its head, for
 * the record): the next time, still unfetched, it is left out. Anything else unread throws (TrialUnread, TrialCap).
 */
async function aheadOf(repo, { issue, head, key, others, state, stuck = () => false, skip = [] }, opts, prOf, memo, trials) {
  if (!head) return null;
  // Siblings ahead whose heads could not be fetched: every one of them is named, so none alternates with another.
  const unread = [];
  let first = null;
  for (const s of [...others].filter((x) => x.number !== issue.number).sort(byRelease)) {
    if (stuck(s)) continue;
    const theirs = await prOf(s.number);
    if (!theirs?.head?.sha || theirs.draft) continue;
    const r = await trial(trials, head, theirs.head.sha, skip);
    if (!r || (!r.unread && !r.conflict)) continue;
    const { record, sentBack, cause } = await siblingState(repo, s.number, opts, prOf, memo);
    // Its own review waits for a third-party reviewer or one account label: it will not merge soon, as sendBackOrder holds.
    if (cause) continue;
    const st = state(s);
    const ahead = record?.released || (record ? st === "In review" && before(keyOf(record.since, s), key) : st === "In review" || (st === "Running" && sentBack));
    if (!ahead) continue;
    if (r.unread) {
      unread.push(r.unread);
      first ??= s.number;
      continue;
    }
    return { on: s.number, files: r.files, cause: record && !record.released ? `it waits for #${record.on} itself` : null, unread };
  }
  return unread.length ? { on: first, files: [], cause: unreadCause(unread), unread } : null;
}

/**
 * When a send-back wait's bound counts from (sendBackOrder), at `now`: the start of the Objective's wait still running
 * (its sendback-wait record not released), else of the last one (a hand-off's or a send-back's record) whose wait ended
 * within WAIT_MAX_MS, so one bound covers a hand-off's wait and the send-back that follows it; else now. A send-back
 * wait that ended with nothing left to rebase (`over`: the conflict went away) ends the bound too: what ended up to it
 * counts no more. `released` says the hand-off record was released this tick.
 */
export function waitStart({ reviewWait = null, rebaseWait = null, released = false }, now = Date.now(), waitMaxMs = WAIT_MAX_MS) {
  if (rebaseWait && !rebaseWait.released) return rebaseWait.since;
  const cut = rebaseWait?.over ? rebaseWait.at ?? now : -Infinity;
  const ended = [reviewWait && (released || reviewWait.released) ? { ...reviewWait, at: released ? now : reviewWait.at } : null, rebaseWait?.over ? null : rebaseWait].filter((r) => r && r.at && now - r.at < waitMaxMs && r.at > cut);
  // A new wait starts at the second its record can name.
  return ended.length ? Math.min(...ended.map((r) => r.since)) : Math.floor(now / 1000) * 1000;
}

/**
 * The dispatcher's send-backs (dispatch.mjs, #366): `dirty` the In-review PRs this tick sends back for a rebase (each
 * `{issue, pr, reviewWait, rebaseWait}`, staleDecision "rebase", with the PR's records); `issues`, `statuses` and
 * `landed` the tick's; `held` and `released` the Objectives whose hand-off this tick found still waiting, or released
 * (reviewWaitResume), the others' waits read from their records (reviewHold); `stuck(s)` whether a sibling will merge
 * nothing soon (two account labels, a usage-limit hold, red checks, a person took it out of the merge queue); a sibling
 * whose own review waits (a third-party reviewer, an account label) will not either. Each dirty PR, in the release order
 * (priority, then number), is sent back unless a sibling ahead of it would make it conflict again once that sibling
 * merges: one earlier in the release order that is In review (not waiting) or Running the rebase of a PR that went to
 * review (sent back, or through its wait), whose head conflicts with this PR's head by a trial merge against the
 * default branch. Such a PR waits, at most WAIT_MAX_MS from waitStart: rebased now, it would be rebased again after that
 * merge. The order is fixed, so no two wait on each other. A sibling head that cannot be fetched holds it once (its
 * record names the head), then is left out. When the trial merges cannot be computed (past TRIALS.max, a fetch that
 * fails), the release order alone decides: the first dirty PR goes back and the later ones wait. Returns the dirty PRs
 * in the release order, each with `wait` (`{on, files, since, unread, cause}`, or null: sent back) and `since`.
 */
export async function sendBackOrder(repo, { dirty, issues, statuses = {}, landed = [], held = new Set(), released = new Set(), stuck = () => false, prOf, memo = new Map(), trials, waitMaxMs = WAIT_MAX_MS }, opts, { log = () => {}, now = Date.now() } = {}) {
  const sorted = [...dirty].sort((a, b) => byRelease(a.issue, b.issue));
  const out = [];
  for (const [i, d] of sorted.entries()) {
    const head = d.pr?.head?.sha;
    const since = waitStart({ reviewWait: d.reviewWait, rebaseWait: d.rebaseWait, released: released.has(d.issue.number) }, now, waitMaxMs);
    let wait = null;
    if (now - since < waitMaxMs) {
      // This PR's own trial merges (its scope of the tick's), and the sibling heads its record says could not be fetched.
      const scope = trials.scope();
      const skip = d.rebaseWait && !d.rebaseWait.released ? d.rebaseWait.unread : [];
      const unread = [];
      let first = null;
      try {
        const earlier = issues.filter((s) => s.number !== d.issue.number && byRelease(s, d.issue) < 0 && !landed.includes(s.number) && !held.has(s.number) && ["In review", "Running"].includes(stateOf(s, statuses[s.number] ?? null))).sort(byRelease);
        for (const s of head ? earlier : []) {
          if (await stuck(s)) continue;
          const theirs = await prOf(s.number);
          if (!theirs?.head?.sha || theirs.draft) continue;
          const r = await trial(scope, head, theirs.head.sha, skip);
          if (!r || (!r.unread && !r.conflict)) continue;
          const { record, sentBack, cause } = await siblingState(repo, s.number, opts, prOf, memo);
          // Its hand-off waits (it waits for others; it would not merge first), unless this tick released it.
          if (record && !record.released && !released.has(s.number)) continue;
          // Its own review waits for a third-party reviewer or one account label: it will not merge soon.
          if (cause) continue;
          // Running: ahead only while it rebases a PR that went to review (its send-back, or the rebase after its wait).
          if (stateOf(s, statuses[s.number] ?? null) === "Running" && !sentBack && !record?.released) continue;
          if (r.unread) {
            unread.push(r.unread);
            first ??= s.number;
            continue;
          }
          wait = { on: s.number, files: r.files, since, unread, cause: null };
          break;
        }
        if (!wait && unread.length) wait = { on: first, files: [], since, unread, cause: unreadCause(unread) };
      } catch (e) {
        // Unread: the release order alone. The first dirty PR goes back; a later one waits for the one before it.
        log(`  #${d.issue.number}: its trial merges with the siblings ahead are unread (${String(e?.message || e).slice(0, 120)}); the release order decides`);
        wait = i === 0 ? null : { on: sorted[i - 1].issue.number, files: [], since, unread: [], order: true, cause: "the trial merges could not be computed this tick, so the release order decides" };
      }
    }
    out.push({ ...d, wait, since });
  }
  return out;
}

/** Issue `n`'s note on its waiting hand-off (`wait`, from `since`), written only when its text changed. */
export async function sayWaiting(repo, issue, prNumber, wait, since, opts, { log = () => {}, waitMaxMs = WAIT_MAX_MS } = {}) {
  const comments = await commentsOf(repo, issue, opts).catch(() => null);
  await say(repo, issue.number, overlapOf(comments, issue.number), `waits-${wait.on}-${Math.floor(since / 1000)}`, waitNote(wait, prNumber, waitMaxMs), opts, log);
}

/**
 * A conflicting PR's send-back waiting (sendBackOrder): its sendback-wait record on the PR (unless it already says this)
 * and the note on its issue, both written only when their text changed. A failed write throws.
 */
export async function sayRebaseWait(repo, { issue, prNumber, wait, record }, opts, { log = () => {}, waitMaxMs = WAIT_MAX_MS } = {}) {
  const head = { on: wait.on, since: wait.since, unread: wait.unread ?? [] };
  if (!record || record.released || record.on !== head.on || record.since !== Math.floor(head.since / 1000) * 1000 || record.unread.join(".") !== head.unread.join(".")) await writeRecord(repo, issue.number, prNumber, "sendback-wait", head, `Factory: ${rebaseWaitReason(wait)}.`, opts);
  const comments = await commentsOf(repo, issue, opts).catch(() => null);
  await say(repo, issue.number, overlapOf(comments, issue.number), `rebasewait-${wait.on}-${Math.floor(wait.since / 1000)}`, rebaseWaitNote(wait, prNumber, waitMaxMs), opts, log);
}

/**
 * A send-back wait that is over: its sendback-wait record released and the issue's note cleared. `how`: "sent" (sent
 * back now), "gaveUp" (sent back at WAIT_MAX_MS) or "over" (the PR conflicts no more, or left review: nothing to rebase).
 */
export async function clearRebaseWait(repo, { issue, prNumber, record, how = "sent" }, opts, { log = () => {}, waitMaxMs = WAIT_MAX_MS } = {}) {
  const text = { sent: `this Objective's rebase no longer waits for #${record.on}; it rebases now`, gaveUp: `this Objective's rebase stopped waiting for #${record.on} after ${hours(waitMaxMs)} h, the longest Factory holds one for a sibling; it rebases now`, over: `this Objective's PR no longer waits for #${record.on} to rebase: it conflicts no more, or left review` }[how];
  await writeRecord(repo, issue.number, prNumber, "sendback-wait", { on: record.on, since: record.since, unread: record.unread, released: true, over: how === "over" }, `Factory: ${text}.`, opts);
  const old = overlapOf(await commentsOf(repo, issue, opts).catch(() => null), issue.number);
  if (old?.kind === "rebasewait") await say(repo, issue.number, old, "cleared", `Factory: ${text}.`, opts, log);
}

/**
 * The work stage's hand-off of a head no review has seen (worker.mjs, its PR `pr` delivered and ready, the review label
 * off, `head` the commit Factory pushed). With `autoMerge`, a sibling ahead of it (aheadOf) holds it: the record goes on
 * the PR first, keeping the Objective's first wait start when it waited before, then the note on the issue, and the
 * review label stays off; the stage ends delivered and the Objective In review, its slot free. Returns the wait (`{on,
 * files, cause, unread}`) or null: the caller puts the review label on. With `hold` off (sibling_hold) nothing waits.
 * Nothing holds a reviewed head Factory rebased (`rebaseMode` and `reviewed`), nor the rebase of a PR that was ahead
 * already (its wait over, or handed to review before and sent back): it goes next. A hold within WAIT_MAX_MS of the
 * Objective's last one keeps that one's start (one episode); a later one starts its own. A read or a trial merge that
 * fails holds nothing (the review goes on, as without siblings), except a sibling head that cannot be fetched (aheadOf);
 * a record that cannot be written holds nothing either.
 */
export async function reviewHold(repo, { issue, pr, head = pr?.head?.sha, autoMerge, hold = true, objectiveLabel = "factory:objective", rebaseMode = false, reviewed = false, waitMaxMs = WAIT_MAX_MS }, opts, { log = () => {}, now = Date.now() } = {}) {
  if (!autoMerge || !hold || !pr || !head || (rebaseMode && reviewed)) return null;
  const trials = siblingTrials(repo, opts);
  try {
    const has = (i, name) => (i.labels || []).some((l) => (typeof l === "string" ? l : l.name) === name);
    const others = new Map();
    for (const label of ["factory:in-review", "factory:running"]) for (const i of await listIssuesByLabel(repo, label, opts)) if (i.number !== issue && has(i, objectiveLabel)) others.set(i.number, i);
    if (!others.size) return null;
    const ownComments = await listComments(repo, pr.number, opts);
    const own = reviewWaitOf(ownComments, issue);
    // A rebase of a PR that was ahead already (its wait over, or handed to review before and sent back) is next.
    if (rebaseMode && (own?.released || (!own && handedOff(ownComments, issue)))) return null;
    const self = await getIssue(repo, issue, opts);
    // One hold episode keeps its first start; held again past the bound, a new episode starts.
    const since = own && now - own.since < waitMaxMs ? own.since : now;
    const prOf = prFinder(repo, opts, { [issue]: pr });
    const wait = await aheadOf(repo, { issue: self, head, key: keyOf(since, self), others: [...others.values()], state: (s) => (has(s, "factory:in-review") ? "In review" : "Running") }, opts, prOf, new Map(), trials);
    if (!wait) return null;
    await writeWait(repo, issue, pr.number, { on: wait.on, since, unread: wait.unread }, `Factory: ${waitReason(wait)}; the dispatcher puts \`${REVIEW_LABEL}\` on this PR once it has.`, opts);
    await sayWaiting(repo, self, pr.number, wait, since, opts, { log, waitMaxMs });
    return wait;
  } catch (e) {
    log(`#${issue}: siblings on the same files unread (${String(e?.message || e).slice(0, 120)}); handed to review`);
    return null;
  } finally {
    trials.close();
  }
}

/**
 * The dispatcher's half (dispatch.mjs, an In-review Objective `issue` whose PR `pr` is unlabelled with a waiting record
 * `wait`): `issues` and `statuses` the tick's Objectives, `landed` those whose PR the tick merged, `memo` the siblings
 * this tick read (siblingState), `stuck(s)` whether a sibling can run no stage now (aheadOf), `trials` the tick's
 * siblingTrials. Returns, writing nothing when `dryRun`:
 * - "draft": the PR went back to a draft (a stop, a Block); the record goes and no label goes on;
 * - "stale": the review label went on after the record (a person, or a review resumed): the record is released and the
 *   PR handled as any In-review PR;
 * - `{waiting}`: a sibling is ahead of it (aheadOf) and it has waited less than WAIT_MAX_MS since its first wait; a
 *   sibling head that could not be fetched is named in its record, so the next tick goes on without it;
 * - "deferred": the trial merges could not be computed this tick (past TRIALS.max, or a fetch failed); it still waits
 *   and the next tick decides;
 * - "unsettled": GitHub has not worked out whether it conflicts; the next tick decides;
 * - "rebase": it conflicts, so its record is released and the send-back takes it, before any review;
 * - "released": the review label goes on, then the record is released.
 * Without `autoMerge`, or with `hold` off (sibling_hold), nothing waits, so a record found then is released at once. The issue's
 * note says when the wait is over. A failed read or write throws (the next tick tries again).
 */
export async function reviewWaitResume(repo, { issue, pr, wait, issues, statuses = {}, landed = [], autoMerge = true, hold = true, stuck = () => false, prOf, memo = new Map(), trials, waitMaxMs = WAIT_MAX_MS }, opts, { dryRun = false, log = () => {}, now = Date.now() } = {}) {
  if (pr.draft) {
    if (!dryRun) await rest(`repos/${repo.full}/issues/comments/${wait.id}`, { ...opts, method: "DELETE" });
    return "draft";
  }
  const release = (how, text) => writeWait(repo, issue.number, pr.number, { on: wait.on, since: wait.since, released: true }, text, opts).then(() => how);
  const labelledAt = await objectiveLabeledAt(repo, pr.number, REVIEW_LABEL, opts);
  if (labelledAt && wait.at && Date.parse(labelledAt) > wait.at) return dryRun ? "stale" : release("stale", "Factory: the review label went on after this PR's wait began; it waits no more.");
  const gaveUp = now - wait.since >= waitMaxMs;
  if (autoMerge && hold && !gaveUp) {
    const others = issues.filter((i) => i.number !== issue.number && !landed.includes(i.number) && ["In review", "Running"].includes(stateOf(i, statuses[i.number] ?? null)));
    let on;
    try {
      on = await aheadOf(repo, { issue, head: pr.head?.sha, key: keyOf(wait.since, issue), others, state: (s) => stateOf(s, statuses[s.number] ?? null), stuck, skip: wait.unread }, opts, prOf, memo, trials.scope());
    } catch (e) {
      if (e instanceof TrialUnread || e instanceof TrialCap) {
        log(`  #${issue.number}: its trial merges are unread this tick (${String(e.message).slice(0, 120)}); it still waits`);
        return "deferred";
      }
      throw e;
    }
    if (on) {
      // A sibling head that could not be fetched: named in the record, so the next tick goes on without it.
      if (!dryRun && on.unread.length && on.unread.join(".") !== wait.unread.join(".")) await writeWait(repo, issue.number, pr.number, { on: on.on, since: wait.since, unread: on.unread }, `Factory: ${waitReason(on)}; the dispatcher puts \`${REVIEW_LABEL}\` on this PR once it has.`, opts);
      return { waiting: on };
    }
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
  if (old?.kind === "waits" || old?.kind === "rebasewait") await say(repo, issue.number, old, "cleared", clearedNote(wait.on, gaveUp && autoMerge && hold, waitMaxMs), opts, log);
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
    if (note) await say(repo, n, old, "beside", besideNote(note, note.hold), opts, log);
    else if (old?.kind === "waits" || old?.kind === "rebasewait") await say(repo, n, old, "cleared", clearedNote(old.on), opts, log);
  }
}
