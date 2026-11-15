// `factory wait` (#272): an orchestrating session waits on the queue and is told when an Objective Blocks, asks a
// Question, goes In review, merges or closes, or the queue drains. It reads GitHub only, so it works for every route
// (the Action, a cloud sandbox, any machine's `factory serve`) with or without a loop on this machine. One conditional
// read of the repository's issue events per poll: an unchanged page is a 304, which GitHub's rate limit does not count.
// Decided on structure only: the event's type, the label it names, the issue's labels and its PR's merge time.
import { rest } from "./github.mjs";
import { DRAFT_LABEL, isDraft } from "./stop.mjs";

/** What `factory wait` tells, in this order in its usage. */
export const WAIT_KINDS = ["blocked", "question", "in-review", "merged", "closed", "drained"];
/** The exit code when --timeout passes with nothing told. */
export const WAIT_TIMEOUT_EXIT = 3;
/** How often it reads by default: within a minute of the change, as #272 asks. */
export const WAIT_POLL_MS = 30_000;
/** The events page size: small enough that a poll reads little, and the page's ETag changes with few issues. */
export const WAIT_PAGE = 30;

const STATE_KINDS = { "factory:blocked": "blocked", "factory:question": "question", "factory:in-review": "in-review" };
const STATE_LABELS = new Set(["factory:running", ...Object.keys(STATE_KINDS)]);
const names = (issue) => (issue?.labels || []).map((l) => (typeof l === "string" ? l : l.name));

/**
 * A `--since` cursor: an event id (the `cursor` of a line `factory wait` printed) as {id}, or a time GitHub's events
 * are compared with as {at} (ms). Null for anything else.
 */
export function parseCursor(text) {
  const s = String(text ?? "").trim();
  if (/^\d+$/.test(s)) return Number.isSafeInteger(Number(s)) ? { id: Number(s) } : null;
  // A time with its zone, so the cursor means the same on every machine.
  if (!/^\d{4}-\d\d-\d\dT[\d:.]+(Z|[+-]\d\d:?\d\d)$/.test(s)) return null;
  const at = Date.parse(s);
  return Number.isFinite(at) ? { at } : null;
}

/** A cursor as a line prints it, which --since takes back. */
export const cursorText = (c) => (c.id !== undefined ? String(c.id) : new Date(c.at).toISOString());

/** `--on`'s kinds, checked: the list, or null when one is not a kind. Empty means every kind. */
export function parseKinds(text) {
  const list = String(text ?? "").split(/[\s,]+/).filter(Boolean);
  if (list.some((k) => !WAIT_KINDS.includes(k))) return null;
  return list.length ? list : [...WAIT_KINDS];
}

/**
 * The kind one repository issue event tells, before a close is told apart as merged: `labeled` with a state label
 * Factory sets (blocked, question, in-review), or `closed` on an issue carrying the Objective label. Null for any other
 * event, and for any event on a pull request.
 */
export function eventKind(e, objectiveLabel) {
  if (!e?.issue || e.issue.pull_request) return null;
  if (e.event === "labeled") return STATE_KINDS[e.label?.name] ?? null;
  if (e.event === "closed" && names(e.issue).includes(objectiveLabel)) return "closed";
  return null;
}

/**
 * Whether an event can change whether the queue is drained: a state label or the Objective label on or off, or, on an
 * issue carrying the Objective label, the draft label on or off, a close or a reopen.
 */
export function movesQueue(e, objectiveLabel) {
  if (!e?.issue || e.issue.pull_request) return false;
  const label = e.label?.name;
  const labelling = e.event === "labeled" || e.event === "unlabeled";
  if (labelling && (STATE_LABELS.has(label) || label === objectiveLabel)) return true;
  if (!names(e.issue).includes(objectiveLabel)) return false;
  return e.event === "closed" || e.event === "reopened" || (labelling && label === DRAFT_LABEL);
}

/**
 * Whether the watched Objectives are drained: none of them open, not a draft, and neither Blocked nor a Question (so none
 * Queued, Running or In review). `open` is every open issue with the Objective label; `watched` the named issue numbers,
 * or null for the whole queue (a named one no longer open counts as done). With the Blocked and Question ones left.
 */
export function drainedOf(open, watched = null) {
  const mine = open.filter((i) => !i.pull_request && !isDraft(i) && (!watched || watched.has(i.number)));
  const has = (i, l) => names(i).includes(l);
  const blocked = mine.filter((i) => has(i, "factory:blocked")).map((i) => i.number);
  const question = mine.filter((i) => !has(i, "factory:blocked") && has(i, "factory:question")).map((i) => i.number);
  return { drained: mine.length === blocked.length + question.length, blocked, question };
}

/**
 * The repository's issue events after `cursor`, oldest first: page 1 as a conditional read (`cache`), then older pages
 * only while every event on a page is new (a resume after a long gap). Deduplicated by id, since events arriving while
 * pages are read shift older ones onto the next page.
 */
export async function eventsAfter(repo, cursor, { opts, cache }) {
  const isNew = (e) => (cursor.id !== undefined ? e.id > cursor.id : Date.parse(e.created_at) > cursor.at);
  const found = new Map();
  for (let page = 1; ; page += 1) {
    const list = (await rest(`repos/${repo.full}/issues/events?per_page=${WAIT_PAGE}${page > 1 ? `&page=${page}` : ""}`, { ...opts, cache: page === 1 ? cache : null })) || [];
    let reached = list.length < WAIT_PAGE;
    for (const e of list) {
      if (isNew(e)) found.set(e.id, e);
      else reached = true;
    }
    if (reached) break;
  }
  return [...found.values()].sort((a, b) => a.id - b.id);
}

/** How a closed Objective ended: merged when the newest PR on its factory/<issue> branch is merged, else closed. */
export async function closedAs(repo, issue, opts) {
  const prs = await rest(`repos/${repo.full}/pulls?state=all&head=${encodeURIComponent(`${repo.owner}:factory/${issue}`)}&per_page=1`, opts);
  const pr = Array.isArray(prs) ? prs[0] : null;
  return pr?.merged_at ? { kind: "merged", pr: pr.number } : { kind: "closed", pr: pr?.number ?? null };
}

/**
 * Wait on the queue of `repo` (repoOf) and print one JSON line per event through `emit`: {event, issue, title, url, at,
 * cursor} (and `pr` for merged and closed; `blocked` and `question`, the numbers left, for drained). Every line of one
 * read carries the same `cursor`, the newest event read: `--since` it to go on with nothing missed or told twice.
 * Without `since` it starts from now. `issues` (numbers) narrows it to those Objectives, drained included; `kinds` to
 * those kinds. Drained is told when an event moves the queue and leaves it drained, once until it is no longer so; a
 * wait that starts from now reads whether it already is, so a queue already drained is not told. Returns {code,
 * cursor}: 0 after the first read that told something (with `follow`, it never returns so), WAIT_TIMEOUT_EXIT once
 * `timeoutMs` passed with nothing told, after a `timeout` line with the cursor.
 */
export async function waitQueue(repo, { opts, objectiveLabel = "factory:objective", issues = null, kinds = WAIT_KINDS, since = null, follow = false, intervalMs = WAIT_POLL_MS, timeoutMs = null, emit, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now() }) {
  const cache = new Map();
  const watched = issues?.length ? new Set(issues) : null;
  const deadline = timeoutMs ? now() + timeoutMs : Infinity;
  const openRead = async () => drainedOf((await rest(`repos/${repo.full}/issues?state=open&labels=${encodeURIComponent(objectiveLabel)}&per_page=100`, { ...opts, paginate: true, cache })) || [], watched);
  let cursor = since;
  let wasDrained = null;
  if (!cursor) {
    // The cursor first: an event between the two reads is then told on the first poll, never lost.
    const page = (await rest(`repos/${repo.full}/issues/events?per_page=${WAIT_PAGE}`, { ...opts, cache })) || [];
    cursor = { id: page.reduce((m, e) => Math.max(m, e.id), 0) };
    if (kinds.includes("drained")) wasDrained = (await openRead()).drained;
  }
  for (;;) {
    const events = await eventsAfter(repo, cursor, { opts, cache });
    if (events.length) cursor = { id: events.at(-1).id };
    const lines = [];
    let moved = false;
    for (const e of events) {
      if (watched && !watched.has(e.issue?.number)) continue;
      if (movesQueue(e, objectiveLabel)) moved = true;
      let kind = eventKind(e, objectiveLabel);
      if (!kind) continue;
      let pr;
      if (kind === "closed") {
        if (!kinds.includes("merged") && !kinds.includes("closed")) continue;
        ({ kind, pr } = await closedAs(repo, e.issue.number, opts));
      }
      if (!kinds.includes(kind)) continue;
      lines.push({ event: kind, issue: e.issue.number, title: e.issue.title, url: e.issue.html_url, at: e.created_at, ...(pr !== undefined ? { pr } : {}) });
    }
    if (moved && kinds.includes("drained")) {
      const d = await openRead();
      if (d.drained && wasDrained !== true) lines.push({ event: "drained", issue: null, at: new Date(now()).toISOString(), blocked: d.blocked, question: d.question });
      wasDrained = d.drained;
    }
    const c = cursorText(cursor);
    for (const line of lines) emit({ ...line, cursor: c });
    if (lines.length && !follow) return { code: 0, cursor: c };
    const left = deadline - now();
    if (left <= 0) {
      emit({ event: "timeout", issue: null, at: new Date(now()).toISOString(), cursor: c });
      return { code: WAIT_TIMEOUT_EXIT, cursor: c };
    }
    await sleep(Math.min(intervalMs, left));
  }
}
