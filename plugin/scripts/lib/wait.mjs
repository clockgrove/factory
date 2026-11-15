// `factory wait` (#272): an orchestrating session waits on the queue and is told when an Objective Blocks, asks a
// Question, goes In review, merges or closes, or the queue drains. It reads GitHub only, so it works for every route
// (the Action, a cloud sandbox, any machine's `factory serve`) with or without a loop on this machine. Each poll reads
// the repository's issue events back through the cursor's window, and the open Objectives when an event is new, all
// conditional: an unchanged page is a 304, which GitHub's rate limit does not count. Blocks, Questions, In review and
// closes are events, each told once by id; drained is the open Objectives' state. Decided on structure only: the
// event's type, the label it names, the issue's labels and its PR's merge time.
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
export const WAIT_SEEN = 50;

const STATE_KINDS = { "factory:blocked": "blocked", "factory:question": "question", "factory:in-review": "in-review" };
const names = (issue) => (issue?.labels || []).map((l) => (typeof l === "string" ? l : l.name));

/**
 * A `--since` cursor: the `cursor` of a line `factory wait` printed, base64url JSON (Node's Buffer and JSON, no format of
 * our own) of {id, drained, seen}: the newest event id read, the watched queue's state there (null when unknown) and the
 * other ids read within WAIT_LOOKBACK_MS of it, as distances below `id`. Parsed as {id, drained, seen} (`seen` with
 * the id itself). Also a bare event id (state unknown, nothing else read), or a time with its zone, which GitHub's events
 * are compared with, as {at} (ms). Null for anything else.
 */
export function parseCursor(text) {
  const s = String(text ?? "").trim();
  if (/^\d+$/.test(s)) return Number.isSafeInteger(Number(s)) ? { id: Number(s), drained: null, seen: [Number(s)] } : null;
  // A time with its zone, so the cursor means the same on every machine.
  if (/^\d{4}-\d\d-\d\dT[\d:.]+(Z|[+-]\d\d:?\d\d)$/.test(s)) {
    const at = Date.parse(s);
    return Number.isFinite(at) ? { at } : null;
  }
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return null;
  let o;
  try {
    o = JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const { id, drained = null, seen = [] } = o ?? {};
  if (!Number.isSafeInteger(id) || id < 0 || ![true, false, null].includes(drained) || !Array.isArray(seen)) return null;
  if (!seen.every((d) => Number.isSafeInteger(d) && d > 0 && d < id)) return null;
  return { id, drained, seen: [id, ...seen.map((d) => id - d)] };
}

/** A cursor as a line prints it, which --since takes back: with the queue's state at it, when known, and `seen`, the other ids read. */
export function cursorText(c, drained = null, seen = []) {
  if (c.id === undefined) return new Date(c.at).toISOString();
  const below = [...seen].filter((id) => id < c.id).sort((a, b) => b - a);
  return Buffer.from(JSON.stringify({ id: c.id, drained, seen: below.map((id) => c.id - id) })).toString("base64url");
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
 * Each event's issue with its labels as they were right after the event: GitHub gives every event its issue as it is
 * now, so walking one issue's events (oldest first, as eventsAfter gives them) back from its newest takes each later
 * label change off again. Keyed by event id.
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
    if (e.event === "labeled") i.labels = i.labels.filter((l) => l !== label);
    else if (e.event === "unlabeled" && label && !i.labels.includes(label)) i.labels = [...i.labels, label];
  }
  return out;
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
 * The repository's issue events after `cursor`, oldest first, each page a conditional read (`cache`): pages back until
 * one reaches the cursor's window, at most WAIT_MAX_PAGES (`gap` when it was not reached). For an id cursor the window
 * is `seen` (the ids already read, the cursor's own included): an unseen event above its oldest id is new too, since
 * GitHub listed it after a newer one was read, so the pages go back to that oldest id, not to the first id seen. For a
 * time cursor, to an event at or before it. Deduplicated by id, since events arriving while pages are read shift older
 * ones onto the next page. `read` is every event read. A cursor newer than every event of the repository is no cursor
 * of it: an error with code `cursor-elsewhere`.
 */
export async function eventsAfter(repo, cursor, { opts, cache, seen = null }) {
  const floor = cursor.id !== undefined ? Math.min(cursor.id, ...(seen?.keys() ?? [])) : null;
  const isNew = (e) => (cursor.id !== undefined ? e.id > cursor.id || (e.id > floor && !seen?.has(e.id)) : Date.parse(e.created_at) > cursor.at);
  const reaches = (e) => (cursor.id !== undefined ? e.id <= floor : !isNew(e));
  const found = new Map();
  const read = [];
  for (let page = 1; ; page += 1) {
    if (page > WAIT_MAX_PAGES) return { events: sorted(found), read, gap: true };
    const list = (await rest(`repos/${repo.full}/issues/events?per_page=${WAIT_PAGE}${page > 1 ? `&page=${page}` : ""}`, { ...opts, cache })) || [];
    if (page === 1 && cursor.id !== undefined && list.length && list.every((e) => e.id < cursor.id)) {
      throw Object.assign(new Error(`the cursor ${cursor.id} is newer than every event of ${repo.full}: it is no cursor of this repository`), { code: "cursor-elsewhere" });
    }
    let reached = list.length < WAIT_PAGE;
    for (const e of list) {
      read.push(e);
      if (isNew(e)) found.set(e.id, e);
      if (reaches(e)) reached = true;
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
 * those kinds. Drained is a state, not a replay of events: a read with any new event reads the open Objectives (a
 * conditional read, free while they are unchanged), and drained is told when that finds the queue drained and the read
 * before did not (or its state was unknown). A wait that starts from now reads whether it already is, and the cursor
 * carries that state on, so neither a queue already drained nor one still drained after a restart is told again. Every
 * other kind is an event, told once by its id, on its issue's labels as they were right after it.
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
    const asOf = issuesAsOf(events);
    for (const ev of events) {
      if (watched && !watched.has(ev.issue?.number)) continue;
      // Its kind on the issue's labels as they were right after the event, never as later events left them.
      const e = { ...ev, issue: asOf.get(ev.id) ?? ev.issue };
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
    if (events.length && kinds.includes("drained")) {
      const d = await openRead();
      if (d.drained && wasDrained !== true) lines.push({ event: "drained", issue: null, at: at(), blocked: d.blocked, question: d.question });
      drained = d.drained;
    }
    return { lines, cursor: next, drained, read };
  }
}
