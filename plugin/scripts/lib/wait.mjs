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
/** The most pages one read goes back for a cursor: past it, a `gap` line says events before it may be missing. */
export const WAIT_MAX_PAGES = 10;
/**
 * How far back, from the newest event read, the ids read are kept (and carried on the cursor), so an event GitHub lists
 * late, below one already read, is still told, after a restart too; at most WAIT_SEEN of them.
 */
export const WAIT_LOOKBACK_MS = 5 * 60_000;
export const WAIT_SEEN = 100;

const STATE_KINDS = { "factory:blocked": "blocked", "factory:question": "question", "factory:in-review": "in-review" };
const STATE_LABELS = new Set(["factory:running", ...Object.keys(STATE_KINDS)]);
const names = (issue) => (issue?.labels || []).map((l) => (typeof l === "string" ? l : l.name));

/**
 * A `--since` cursor: the `cursor` of a line `factory wait` printed, an event id with the watched queue's state there
 * when it was known (`d` drained, `a` not) and the other ids read within WAIT_LOOKBACK_MS of it (after a `.`, each one's
 * distance below the one before, base 36), as {id, drained, seen} (`seen` with the id itself); or a time GitHub's events
 * are compared with as {at} (ms), the state unknown. Null for anything else.
 */
export function parseCursor(text) {
  const s = String(text ?? "").trim();
  const m = /^(\d+)([ad]?)(?:\.([0-9a-z]+(?:,[0-9a-z]+)*))?$/.exec(s);
  if (m) {
    const id = Number(m[1]);
    if (!Number.isSafeInteger(id)) return null;
    const seen = [id];
    for (const d of m[3] ? m[3].split(",") : []) {
      const below = seen.at(-1) - parseInt(d, 36);
      if (!(below > 0 && below < seen.at(-1))) return null;
      seen.push(below);
    }
    return { id, drained: m[2] ? m[2] === "d" : null, seen };
  }
  // A time with its zone, so the cursor means the same on every machine.
  if (!/^\d{4}-\d\d-\d\dT[\d:.]+(Z|[+-]\d\d:?\d\d)$/.test(s)) return null;
  const at = Date.parse(s);
  return Number.isFinite(at) ? { at } : null;
}

/** A cursor as a line prints it, which --since takes back: with the queue's state at it, when known, and `seen`, the other ids read. */
export function cursorText(c, drained = null, seen = []) {
  if (c.id === undefined) return new Date(c.at).toISOString();
  const below = [...seen].filter((id) => id < c.id).sort((a, b) => b - a);
  const steps = below.map((id, k) => ((k ? below[k - 1] : c.id) - id).toString(36));
  return `${c.id}${drained === true ? "d" : drained === false ? "a" : ""}${steps.length ? `.${steps.join(",")}` : ""}`;
}

/**
 * One event as the line `factory wait` prints: JSON, with the line and paragraph separators (U+2028, U+2029) and NEL
 * (U+0085), which JSON.stringify leaves as they are, escaped, so a reader that splits on them never splits a title.
 */
export const jsonLine = (o) => JSON.stringify(o).replace(/[\u2028\u2029\u0085]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

/** `--on`'s kinds, checked: the list, or null when one is not a kind. Empty means every kind. */
export function parseKinds(text) {
  const list = String(text ?? "").split(/[\s,]+/).filter(Boolean);
  if (list.some((k) => !WAIT_KINDS.includes(k))) return null;
  return list.length ? list : [...WAIT_KINDS];
}

/**
 * The kind one repository issue event tells, before a close is told apart as merged, on an issue carrying the Objective
 * label: `labeled` with a state label Factory sets (blocked, question, in-review), or `closed`. Null for any other event,
 * any event on another issue, and any event on a pull request.
 */
export function eventKind(e, objectiveLabel) {
  if (!e?.issue || e.issue.pull_request || !names(e.issue).includes(objectiveLabel)) return null;
  if (e.event === "labeled") return STATE_KINDS[e.label?.name] ?? null;
  if (e.event === "closed") return "closed";
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
 * Each event's issue as it was right after the event: GitHub gives every event its issue as it is now, so walking one
 * issue's events (oldest first, as eventsAfter gives them) back from its newest takes each later close, reopen and label
 * change off again. Keyed by event id.
 */
export function issuesAsOf(events) {
  const now = new Map();
  const out = new Map();
  for (let k = events.length - 1; k >= 0; k -= 1) {
    const e = events[k];
    if (!e?.issue) continue;
    const n = e.issue.number;
    if (!now.has(n)) now.set(n, { ...e.issue, labels: names(e.issue) });
    const i = now.get(n);
    out.set(e.id, { ...i, labels: [...i.labels] });
    const label = e.label?.name;
    if (e.event === "closed") i.state = "open";
    else if (e.event === "reopened") i.state = "closed";
    else if (e.event === "labeled") i.labels = i.labels.filter((l) => l !== label);
    else if (e.event === "unlabeled" && label && !i.labels.includes(label)) i.labels = [...i.labels, label];
  }
  return out;
}

/**
 * Whether an event puts an Objective back to work (Queued, Running or In review), on an issue open, no draft and
 * carrying the Objective label right after it (issuesAsOf): its Objective label on, a Blocked or Question label off, the
 * Running or In review label on, the draft label off, or a reopen. A drain told before it can then be told again, even
 * when the read after it finds the queue drained once more, and even when the Objective has closed again since.
 */
export function activates(e, objectiveLabel) {
  // Only on an Objective that can run: a closed, draft or stopped one's labels coming off (the Done pass's tidy) resume nothing.
  if (!e?.issue || e.issue.pull_request || e.issue.state !== "open" || isDraft(e.issue) || !names(e.issue).includes(objectiveLabel)) return false;
  const label = e.label?.name;
  if (e.event === "labeled") return label === objectiveLabel || label === "factory:running" || label === "factory:in-review";
  if (e.event === "unlabeled") return label === "factory:blocked" || label === "factory:question" || label === DRAFT_LABEL;
  return e.event === "reopened";
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
 * only while every event on a page is new (a resume after a long gap), at most WAIT_MAX_PAGES (`gap` when the cursor
 * was not reached). Deduplicated by id, since events arriving while pages are read shift older ones onto the next page.
 * With `seen` (ids already read, at most WAIT_SEEN), an unseen event at or below the cursor but within the ids kept is
 * new too: GitHub listed it after a newer one was read. `read` is every event read. A cursor newer than every event of the
 * repository is no cursor of it: an error with code `cursor-elsewhere`.
 */
export async function eventsAfter(repo, cursor, { opts, cache, seen = null }) {
  const floor = seen?.size ? Math.min(...seen.keys()) : Infinity;
  const isNew = (e) => (cursor.id !== undefined ? e.id > cursor.id || (e.id > floor && !seen.has(e.id)) : Date.parse(e.created_at) > cursor.at);
  const found = new Map();
  const read = [];
  for (let page = 1; ; page += 1) {
    if (page > WAIT_MAX_PAGES) return { events: sorted(found), read, gap: true };
    const list = (await rest(`repos/${repo.full}/issues/events?per_page=${WAIT_PAGE}${page > 1 ? `&page=${page}` : ""}`, { ...opts, cache: page === 1 ? cache : null })) || [];
    if (page === 1 && cursor.id !== undefined && list.length && list.every((e) => e.id < cursor.id)) {
      throw Object.assign(new Error(`the cursor ${cursor.id} is newer than every event of ${repo.full}: it is no cursor of this repository`), { code: "cursor-elsewhere" });
    }
    let reached = list.length < WAIT_PAGE;
    for (const e of list) {
      read.push(e);
      if (isNew(e)) found.set(e.id, e);
      else reached = true;
    }
    if (reached) return { events: sorted(found), read, gap: false };
  }
}
const sorted = (found) => [...found.values()].sort((a, b) => a.id - b.id);

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
 * those kinds. Drained is told when an event moves the queue and leaves it drained, once until an Objective goes back to
 * work (activates, which a read that finds it drained again does not hide); a wait that starts from now reads whether
 * it already is, and the cursor carries that state on, so neither a queue already drained nor one still drained after
 * a restart is told again.
 *
 * A read moves the cursor only once all its reads (events, PRs, the open Objectives) have answered, so a read cut off
 * leaves it where it was. Besides the events: a `gap` line when the cursor was more than WAIT_MAX_PAGES pages back
 * (events before the oldest read may be missing; the read's other lines follow it); a `timeout` line once `timeoutMs`
 * passed with nothing told, or `opts.signal` aborted a read (the command's deadline); an `error` line (with `message`)
 * before a failure is thrown. Returns {code, cursor}: 0 after the first read that told something (with `follow`, it
 * never returns so), WAIT_TIMEOUT_EXIT after the timeout line.
 */
export async function waitQueue(repo, { opts, objectiveLabel = "factory:objective", issues = null, kinds = WAIT_KINDS, since = null, follow = false, intervalMs = WAIT_POLL_MS, timeoutMs = null, emit, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now() }) {
  const cache = new Map();
  const watched = issues?.length ? new Set(issues) : null;
  const deadline = timeoutMs ? now() + timeoutMs : Infinity;
  const openRead = async () => drainedOf((await rest(`repos/${repo.full}/issues?state=open&labels=${encodeURIComponent(objectiveLabel)}&per_page=100`, { ...opts, paginate: true, cache })) || [], watched);
  let cursor = since;
  // Carried on only by a wait that keeps it current: one whose kinds leave drained out never reads it again.
  let wasDrained = kinds.includes("drained") ? (since?.drained ?? null) : null;
  // The ids read within WAIT_LOOKBACK_MS of the newest one read (id -> its time, null until read here), at most
  // WAIT_SEEN: the cursor's own, so a restart from it tells an event GitHub lists late as this wait would.
  const seen = new Map((since?.seen ?? []).map((id) => [id, null]));
  const remember = (events) => {
    for (const e of events) seen.set(e.id, Date.parse(e.created_at));
    const times = [...seen.values()].filter(Number.isFinite);
    // Ids rise with creation time: the window starts at the oldest id read within it.
    const top = Math.max(...times);
    const from = Math.min(...[...seen].filter(([, t]) => t >= top - WAIT_LOOKBACK_MS).map(([id]) => id));
    const keep = new Set([...seen.keys()].filter((id) => !(id < from)).sort((a, b) => b - a).slice(0, WAIT_SEEN));
    for (const id of [...seen.keys()]) if (!keep.has(id)) seen.delete(id);
  };
  const at = () => new Date(now()).toISOString();
  const text = () => (cursor ? cursorText(cursor, wasDrained, seen.keys()) : null);
  // A read cut off at the deadline ends as a timeout; any other failure gets its line, with the cursor to go on from.
  const failed = (e) => {
    if (opts?.signal?.aborted) {
      emit({ event: "timeout", issue: null, at: at(), cursor: text() });
      return { code: WAIT_TIMEOUT_EXIT, cursor: text() };
    }
    emit({ event: "error", issue: null, at: at(), cursor: text(), message: String(e?.message || e).slice(0, 300) });
    throw e;
  };
  try {
    if (!cursor) {
      const page = (await rest(`repos/${repo.full}/issues/events?per_page=${WAIT_PAGE}`, { ...opts, cache })) || [];
      const start = { id: page.reduce((m, e) => Math.max(m, e.id), 0) };
      // The cursor to go on from as soon as it is read, so a timeout or failure in the checks below still prints it.
      cursor = start;
      wasDrained = null;
      remember(page);
      // The queue's state at the cursor, when no event came between the two event reads (the second then a 304); else
      // it stays unknown, so a drain the events after the cursor make is told, never taken as the state at the start.
      if (kinds.includes("drained")) {
        const d = (await openRead()).drained;
        const again = (await rest(`repos/${repo.full}/issues/events?per_page=${WAIT_PAGE}`, { ...opts, cache })) || [];
        if (again.reduce((m, e) => Math.max(m, e.id), 0) === start.id) wasDrained = d;
      }
    }
  } catch (e) {
    return failed(e);
  }
  for (;;) {
    let r;
    try {
      r = await poll();
    } catch (e) {
      return failed(e);
    }
    cursor = r.cursor;
    wasDrained = r.drained;
    remember(r.read);
    const c = text();
    for (const line of r.lines) emit({ ...line, cursor: c });
    if (r.lines.length && !follow) return { code: 0, cursor: c };
    const left = deadline - now();
    if (left <= 0) {
      emit({ event: "timeout", issue: null, at: at(), cursor: c });
      return { code: WAIT_TIMEOUT_EXIT, cursor: c };
    }
    await sleep(Math.min(intervalMs, left));
  }

  /** One read: its lines and the cursor, drained state and ids read it leads to, nothing changed until it all answered. */
  async function poll() {
    const { events, read, gap } = await eventsAfter(repo, cursor, { opts, cache, seen });
    const next = events.length ? { id: Math.max(cursor.id ?? 0, events.at(-1).id) } : cursor;
    const lines = gap ? [{ event: "gap", issue: null, at: at() }] : [];
    let moved = false;
    let active = false;
    const asOf = issuesAsOf(events);
    for (const ev of events) {
      if (watched && !watched.has(ev.issue?.number)) continue;
      // Every decision on the issue as it was right after the event, never as later events left it.
      const e = { ...ev, issue: asOf.get(ev.id) ?? ev.issue };
      if (movesQueue(e, objectiveLabel)) moved = true;
      if (activates(e, objectiveLabel)) active = true;
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
    let drained = wasDrained;
    if (moved && kinds.includes("drained")) {
      const d = await openRead();
      if (d.drained && (wasDrained !== true || active)) lines.push({ event: "drained", issue: null, at: at(), blocked: d.blocked, question: d.question });
      drained = d.drained;
    }
    return { lines, cursor: next, drained, read };
  }
}
