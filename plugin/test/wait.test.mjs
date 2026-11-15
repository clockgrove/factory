// #272: an orchestrator waits on the queue (`factory wait`) and is told, within a poll, when an Objective Blocks, asks a
// Question, goes In review, merges or closes, or the queue drains. GitHub here answers as it does: the repository's
// issue events newest first, 30 a page, with an ETag; a request that sends that ETag back for an unchanged page gets
// a 304, which GitHub's rate limit does not count.
import "./temp.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { RETRY } from "../scripts/lib/github.mjs";
import { WAIT_KINDS, WAIT_MAX_PAGES, WAIT_PAGE, WAIT_TIMEOUT_EXIT, cursorText, jsonLine, parseCursor, waitQueue } from "../scripts/lib/wait.mjs";
import { parseArgs } from "../scripts/local.mjs";

const SCRIPTS = join(import.meta.dirname, "..", "scripts");
const repo = { owner: "acme", name: "widgets", full: "acme/widgets" };
const OBJ = "factory:objective";
const T0 = Date.parse("2026-11-14T14:00:00Z");
/** A printed cursor's event id and queue state. */
const idOf = (c) => parseCursor(c).id;
const stateOf = (c) => parseCursor(c).drained;

/** One repository's issues, PRs and issue events; `answer(method, url, headers)` is GitHub's answer as [status, body, headers]. */
function repoState() {
  const s = { issues: new Map(), events: [], prs: {}, nextId: 36_000_000_000, at: T0, seen: [] };
  const issue = (number, labels = [OBJ], extra = {}) => s.issues.set(number, { number, title: `Objective ${number}`, html_url: `https://github.com/acme/widgets/issues/${number}`, state: "open", labels: labels.map((name) => ({ name })), ...extra });
  const event = (number, event, label = null, id = null) => {
    const i = s.issues.get(number);
    if (event === "labeled") i.labels = [...i.labels.filter((l) => l.name !== label), { name: label }];
    if (event === "unlabeled") i.labels = i.labels.filter((l) => l.name !== label);
    if (event === "closed") i.state = "closed";
    if (event === "reopened") i.state = "open";
    s.at += 1000;
    s.events.push({ id: id ?? (s.nextId += 7), event, created_at: new Date(s.at).toISOString(), ...(label ? { label: { name: label } } : {}), issue: i });
  };
  /** Factory's setStateLabel: every other state label off, then this one on. */
  const state = (number, to) => {
    for (const l of ["factory:running", "factory:blocked", "factory:question", "factory:in-review"]) if (l !== to && s.issues.get(number).labels.some((x) => x.name === l)) event(number, "unlabeled", l);
    if (to) event(number, "labeled", to);
  };
  const tagged = (status, body, headers = {}) => {
    const text = JSON.stringify(body);
    return [status, text, { etag: `W/"${createHash("sha256").update(text).digest("hex")}"`, ...headers }];
  };
  const answer = (method, url, headers = {}) => {
    const u = new URL(url, "https://api.github.test");
    const q = u.searchParams;
    s.seen.push(`${method} ${u.pathname.replace("/repos/acme/widgets/", "")}${u.search}`);
    let out;
    if (u.pathname.endsWith("/issues/events")) {
      const per = Number(q.get("per_page"));
      const page = Number(q.get("page") || 1);
      const newestFirst = [...s.events].sort((a, b) => b.id - a.id).map((e) => ({ ...e, issue: { ...e.issue, labels: [...e.issue.labels] } }));
      out = tagged(200, newestFirst.slice((page - 1) * per, page * per));
    } else if (u.pathname.endsWith("/issues") && q.get("state") === "open") {
      out = tagged(200, [...s.issues.values()].filter((i) => i.state === "open" && i.labels.some((l) => l.name === q.get("labels"))));
    } else if (u.pathname.endsWith("/pulls")) {
      const branch = q.get("head").split(":")[1];
      out = tagged(200, (s.prs[branch] || []).slice(0, Number(q.get("per_page"))));
    } else return [404, JSON.stringify({ message: "Not Found" }), {}];
    if (headers["if-none-match"] && headers["if-none-match"] === out[2].etag) {
      s.seen[s.seen.length - 1] += " 304";
      return [304, "", { etag: out[2].etag }];
    }
    return out;
  };
  return { s, issue, event, state, answer };
}

/** Run waitQueue against `gh` with fetch faked; each sleep runs the next step of `steps` (what happens on GitHub meanwhile). */
async function waiting(gh, steps, options = {}) {
  const saved = { fetch: globalThis.fetch, sleep: RETRY.sleep };
  RETRY.sleep = async () => {};
  globalThis.fetch = async (url, init = {}) => {
    // As fetch does: a request on an aborted signal fails at once.
    if (init.signal?.aborted) throw new DOMException("This operation was aborted", "AbortError");
    const h = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    const [status, body, headers] = gh.answer(init.method || "GET", String(url), h);
    return new Response(status === 304 ? null : body, { status, headers: { "content-type": "application/json", ...headers } });
  };
  let t = T0;
  const lines = [];
  const slept = [];
  try {
    const r = await waitQueue(repo, {
      opts: { token: "t" },
      emit: (l) => lines.push(l),
      now: () => t,
      sleep: async (ms) => {
        slept.push(ms);
        t += ms;
        const step = steps.shift();
        if (step) step();
        else if (!options.timeoutMs) throw new Error("waited past the last step");
      },
      ...options,
    });
    return { ...r, lines, slept };
  } finally {
    globalThis.fetch = saved.fetch;
    RETRY.sleep = saved.sleep;
  }
}

test("a Block is told on the poll after it, once, with the newest event as the cursor; a poll with nothing new is a 304", async () => {
  const gh = repoState();
  gh.issue(5, [OBJ, "factory:running"]);
  gh.issue(6, [OBJ]);
  gh.event(5, "labeled", "factory:running");
  const r = await waiting(gh, [() => {}, () => gh.state(5, "factory:blocked")], { kinds: WAIT_KINDS.filter((k) => k !== "drained") });
  assert.equal(r.code, 0);
  const last = gh.s.events.at(-1).id;
  assert.deepEqual(r.lines.map(({ cursor, ...l }) => l), [{ event: "blocked", issue: 5, title: "Objective 5", url: "https://github.com/acme/widgets/issues/5", at: gh.s.events.at(-1).created_at }]);
  assert.equal(idOf(r.lines[0].cursor), last);
  assert.deepEqual(r.slept, [30_000, 30_000], "a poll every 30 seconds by default");
  // The start reads the newest events; the first poll's read is unchanged (a 304); the next one sees the Block.
  assert.deepEqual(gh.s.seen, ["GET issues/events?per_page=30", "GET issues/events?per_page=30 304", "GET issues/events?per_page=30 304", "GET issues/events?per_page=30"]);
});

test("Question and In review are told, the state labels coming off are not; with --follow every read's lines come out until --timeout", async () => {
  const gh = repoState();
  gh.issue(5, [OBJ, "factory:running"]);
  gh.issue(6, [OBJ, "factory:running"]);
  const r = await waiting(gh, [() => gh.state(5, "factory:in-review"), () => {}, () => (gh.state(6, "factory:question"), gh.state(5, "factory:running"))], { follow: true, timeoutMs: 100_000, kinds: WAIT_KINDS.filter((k) => k !== "drained") });
  assert.equal(r.code, WAIT_TIMEOUT_EXIT);
  assert.deepEqual(r.lines.map((l) => [l.event, l.issue]), [["in-review", 5], ["question", 6], ["timeout", null]]);
  assert.equal(idOf(r.lines[0].cursor), gh.s.events[1].id, "the first read's cursor: its newest event");
  assert.equal(idOf(r.lines[1].cursor), gh.s.events.at(-1).id, "the label running 5 again is read, not told, and still moves the cursor");
  assert.equal(r.lines[2].cursor, r.lines[1].cursor, "the timeout line carries the cursor to go on from");
  assert.deepEqual(r.slept, [30_000, 30_000, 30_000, 10_000], "the last wait ends at the timeout");
});

test("a closed Objective is merged when the newest PR on factory/<issue> merged, else closed; other issues (a state label on one that is no Objective included) and PRs are not told", async () => {
  const gh = repoState();
  gh.issue(5, [OBJ, "factory:in-review"]);
  gh.issue(6, [OBJ, "factory:in-review"]);
  gh.issue(9, ["bug"]);
  gh.issue(70, [OBJ], { pull_request: { url: "x" } });
  gh.s.prs["factory/5"] = [{ number: 71, merged_at: "2026-11-14T14:00:30Z" }];
  // A split Objective's earlier part merged; its newest PR was closed unmerged.
  gh.s.prs["factory/6"] = [{ number: 73, merged_at: null }, { number: 72, merged_at: "2026-11-14T13:00:00Z" }];
  const r = await waiting(gh, [() => (gh.event(70, "closed"), gh.event(9, "labeled", "factory:blocked"), gh.event(9, "closed"), gh.state(5, null), gh.event(5, "closed"), gh.event(6, "closed"), gh.event(70, "labeled", "factory:blocked"))], { kinds: WAIT_KINDS.filter((k) => k !== "drained") });
  assert.deepEqual(r.lines.map(({ event, issue, pr }) => ({ event, issue, pr })), [{ event: "merged", issue: 5, pr: 71 }, { event: "closed", issue: 6, pr: 73 }]);
  assert.ok(gh.s.seen.includes("GET pulls?state=all&head=acme%3Afactory%2F5&per_page=1"), gh.s.seen.join("\n"));
});

test("--since goes on from a cursor with nothing missed or told twice, paging back past one page; a time works as a cursor too", async () => {
  const gh = repoState();
  gh.issue(5, [OBJ, "factory:running"]);
  gh.issue(6, [OBJ, "factory:running"]);
  gh.issue(9, ["bug"]);
  gh.state(5, "factory:blocked");
  const cursor = gh.s.events.at(-1).id;
  const told = gh.s.events.at(-1).created_at;
  gh.state(6, "factory:question");
  for (let i = 0; i < 40; i += 1) gh.event(9, i % 2 ? "unlabeled" : "labeled", "P1");
  const r = await waiting(gh, [], { since: parseCursor(String(cursor)), kinds: ["blocked", "question"] });
  assert.deepEqual(r.lines.map((l) => [l.event, l.issue]), [["question", 6]], "the Block at the cursor is not told again; the Question two pages back is");
  assert.equal(idOf(r.lines[0].cursor), gh.s.events.at(-1).id);
  assert.deepEqual(gh.s.seen, ["GET issues/events?per_page=30", "GET issues/events?per_page=30&page=2"]);
  assert.deepEqual(r.slept, [], "told on the first read");
  const byTime = await waiting(gh, [], { since: parseCursor(told), kinds: ["blocked", "question"] });
  assert.deepEqual(byTime.lines.map((l) => [l.event, l.issue]), [["question", 6]]);
  const before = await waiting(gh, [], { since: parseCursor(new Date(T0).toISOString()), kinds: ["blocked", "question"] });
  assert.deepEqual(before.lines.map((l) => [l.event, l.issue]), [["blocked", 5], ["question", 6]]);
});

test("drained: told when the last Objective still to run Blocks or merges, not when the queue was drained already, and once", async () => {
  const gh = repoState();
  gh.issue(5, [OBJ, "factory:in-review"]);
  gh.issue(6, [OBJ, "factory:blocked"]);
  gh.issue(7, [OBJ, "factory:draft"]);
  gh.s.prs["factory/5"] = [{ number: 71, merged_at: "2026-11-14T14:00:30Z" }];
  const r = await waiting(gh, [() => (gh.state(5, null), gh.event(5, "closed"))]);
  assert.deepEqual(r.lines.map(({ event, issue, blocked, question }) => ({ event, issue, blocked, question })), [{ event: "merged", issue: 5, blocked: undefined, question: undefined }, { event: "drained", issue: null, blocked: [6], question: [] }], "a draft is not still to run");
  // Drained already at the start: a Blocked one closed is told, and the queue is not told drained again.
  const again = await waiting(gh, [() => gh.event(6, "closed")]);
  assert.deepEqual(again.lines.map((l) => l.event), ["closed"]);
  // A new Objective moves the queue; its Question drains it again, told once in a --follow.
  gh.issue(8, []);
  const follow = await waiting(gh, [() => gh.event(8, "labeled", OBJ), () => gh.state(8, "factory:running"), () => gh.state(8, "factory:question"), () => gh.event(8, "labeled", "P1")], { follow: true, timeoutMs: 125_000 });
  assert.deepEqual(follow.lines.map((l) => [l.event, l.issue]), [["question", 8], ["drained", null], ["timeout", null]]);
  assert.deepEqual(follow.lines[1].question, [8]);
});

test("named issues: only their events are told, and drained means each of them is done, Blocked or a Question; --on narrows the kinds", async () => {
  const gh = repoState();
  gh.issue(5, [OBJ, "factory:running"]);
  gh.issue(6, [OBJ, "factory:running"]);
  gh.issue(7, [OBJ]);
  gh.s.prs["factory/6"] = [{ number: 76, merged_at: "2026-11-14T14:00:30Z" }];
  const r = await waiting(gh, [() => gh.state(5, "factory:blocked"), () => gh.state(6, "factory:in-review"), () => (gh.state(6, null), gh.event(6, "closed"))], { issues: [6, 5], kinds: ["merged", "drained"] });
  assert.deepEqual(r.lines.map((l) => [l.event, l.issue]), [["merged", 6], ["drained", null]], "#7, Queued and not named, does not hold it");
  assert.deepEqual(r.lines[1].blocked, [5]);
  const one = await waiting(gh, [() => gh.state(7, "factory:blocked")], { issues: [7], kinds: ["blocked"] });
  assert.deepEqual(one.lines.map((l) => [l.event, l.issue]), [["blocked", 7]]);
});

test("drained at the start (#272 review): a drain between the start's reads is told, not taken as the state at the start", async () => {
  const gh = repoState();
  gh.issue(5, [OBJ, "factory:in-review"]);
  gh.issue(6, [OBJ, "factory:blocked"]);
  gh.s.prs["factory/5"] = [{ number: 71, merged_at: "2026-11-14T14:00:30Z" }];
  // #5 merges after the start's first events read, before its read of the open Objectives.
  const answer = gh.answer;
  let opened = false;
  gh.answer = (method, url, h) => {
    if (!opened && /\/issues\?state=open/.test(url)) {
      opened = true;
      gh.state(5, null);
      gh.event(5, "closed");
    }
    return answer(method, url, h);
  };
  const r = await waiting(gh, []);
  assert.deepEqual(r.lines.map((l) => [l.event, l.issue]), [["merged", 5], ["drained", null]]);
  assert.equal(stateOf(r.lines[1].cursor), true, "the cursor says the queue is drained there");
});

test("drained after a restart (#272 review): the cursor carries the queue's state, so a wait started --since it does not tell the same drain again", async () => {
  const gh = repoState();
  gh.issue(5, [OBJ, "factory:running"]);
  gh.issue(6, [OBJ, "factory:blocked"]);
  const first = await waiting(gh, [() => gh.state(5, "factory:question")]);
  assert.deepEqual(first.lines.map((l) => [l.event, l.issue]), [["question", 5], ["drained", null]]);
  const cursor = first.lines.at(-1).cursor;
  assert.equal(stateOf(cursor), true);
  // Still drained: a Blocked one closed is told, the drain is not.
  const again = await waiting(gh, [], { since: parseCursor(cursor), kinds: ["closed", "drained"], timeoutMs: 1 });
  assert.deepEqual(again.lines.map((l) => l.event), ["timeout"]);
  const closed = await waiting(gh, [() => gh.event(6, "closed")], { since: parseCursor(again.lines[0].cursor) });
  assert.deepEqual(closed.lines.map((l) => [l.event, l.issue]), [["closed", 6]]);
  assert.equal(stateOf(closed.lines[0].cursor), true);
  // Active again (a new Objective queued) then drained: told, and a cursor from before the queue moved says so.
  gh.issue(8, []);
  const active = await waiting(gh, [() => gh.event(8, "labeled", OBJ), () => gh.state(8, "factory:blocked")], { since: parseCursor(closed.lines[0].cursor) });
  assert.deepEqual(active.lines.map((l) => [l.event, l.issue]), [["blocked", 8], ["drained", null]]);
});

test("drained is the queue's state (#285 review): told when a read finds it drained and the read before did not, and only then", async () => {
  const gh = repoState();
  gh.issue(5, [OBJ, "factory:running"]);
  gh.issue(6, [OBJ, "factory:blocked"]);
  // #5 Blocks; #6 goes back to work (a read sees it Running), then Blocks again; then #5, Blocked, closes.
  const r = await waiting(gh, [() => gh.state(5, "factory:blocked"), () => gh.state(6, "factory:running"), () => gh.state(6, "factory:blocked"), () => gh.event(5, "closed")], { follow: true, timeoutMs: 155_000, kinds: ["drained"] });
  assert.deepEqual(r.lines.map((l) => l.event), ["drained", "drained", "timeout"], "the close of a Blocked one is no new drain");
  // The Done pass's tidy of a closed Blocked one (its state label off) leaves the queue drained: no drain again.
  const tidy = await waiting(gh, [() => (gh.event(5, "unlabeled", "factory:blocked"))], { since: parseCursor(r.lines.at(-1).cursor), follow: true, timeoutMs: 35_000, kinds: ["drained"] });
  assert.deepEqual(tidy.lines.map((l) => l.event), ["timeout"]);
});

test("a Blocked Objective closed and reopened, still Blocked (#285 review), leaves the queue drained: no second drain", async () => {
  const gh = repoState();
  gh.issue(5, [OBJ, "factory:running"]);
  gh.issue(6, [OBJ, "factory:blocked"]);
  const r = await waiting(gh, [() => gh.state(5, "factory:blocked"), () => (gh.event(6, "closed"), gh.event(6, "reopened"))], { follow: true, timeoutMs: 65_000, kinds: ["drained"] });
  assert.deepEqual(r.lines.map((l) => l.event), ["drained", "timeout"]);
});

test("a read pages back through the cursor's window (#285 review): an event GitHub lists late, one page below the newest, is told", async () => {
  const gh = repoState();
  gh.issue(5, [OBJ, "factory:running"]);
  gh.issue(9, ["bug"]);
  gh.event(5, "labeled", "factory:running");
  for (let i = 0; i < WAIT_PAGE - 1; i += 1) gh.event(9, i % 2 ? "unlabeled" : "labeled", "P1");
  const r = await waiting(gh, [() => {
    for (let i = 0; i < 15; i += 1) gh.event(9, i % 2 ? "unlabeled" : "labeled", "P1");
  }, () => {
    // #5's Block, its id just above the 31st newest event: GitHub lists it on page 2, below ids the last read returned.
    const below = [...gh.s.events].sort((x, y) => y.id - x.id)[WAIT_PAGE];
    gh.event(5, "labeled", "factory:blocked", below.id + 3);
  }], { follow: true, timeoutMs: 65_000, kinds: ["blocked"] });
  assert.deepEqual(r.lines.map((l) => [l.event, l.issue]), [["blocked", 5], ["timeout", null]]);
});

test("a wait whose kinds leave drained out (#285 review) carries no queue state on its cursor, so a later wait tells the drain", async () => {
  const gh = repoState();
  gh.issue(5, [OBJ, "factory:running"]);
  gh.issue(6, [OBJ, "factory:blocked"]);
  const first = await waiting(gh, [() => gh.state(5, "factory:question")]);
  assert.equal(stateOf(first.lines.at(-1).cursor), true);
  gh.issue(7, [OBJ, "factory:running"]);
  const review = await waiting(gh, [() => gh.state(7, "factory:in-review")], { since: parseCursor(first.lines.at(-1).cursor), kinds: ["in-review"] });
  assert.equal(stateOf(review.lines[0].cursor), null, "no state it did not keep current");
  gh.s.prs["factory/7"] = [{ number: 77, merged_at: "2026-11-14T14:00:30Z" }];
  const drained = await waiting(gh, [() => (gh.state(7, null), gh.event(7, "closed"))], { since: parseCursor(review.lines[0].cursor), kinds: ["drained"] });
  assert.deepEqual(drained.lines.map((l) => l.event), ["drained"]);
});

test("a timeout during the start's read of the open Objectives (#285 review) prints the start's cursor, and a restart from it misses nothing", async () => {
  const gh = repoState();
  gh.issue(5, [OBJ, "factory:running"]);
  gh.event(5, "labeled", "factory:running");
  const start = String(gh.s.events.at(-1).id);
  const stop = new AbortController();
  const answer = gh.answer;
  gh.answer = (method, url, h) => {
    if (/\/issues\?state=open/.test(url) && !stop.signal.aborted) {
      // #5 Blocks just after the first events read; the deadline comes during the open read.
      gh.state(5, "factory:blocked");
      stop.abort();
      throw new DOMException("This operation was aborted", "AbortError");
    }
    return answer(method, url, h);
  };
  const r = await waiting(gh, [], { opts: { token: "t", signal: stop.signal } });
  assert.equal(r.code, WAIT_TIMEOUT_EXIT);
  assert.deepEqual(r.lines.map((l) => [l.event, idOf(l.cursor), stateOf(l.cursor)]), [["timeout", Number(start), null]], "the start's cursor, its queue state unknown");
  const again = await waiting(gh, [], { since: parseCursor(r.lines[0].cursor), kinds: ["blocked"] });
  assert.deepEqual(again.lines.map((l) => [l.event, l.issue]), [["blocked", 5]]);
});

test("a read cut off at --timeout (#285 review) leaves the cursor where it was: the timeout line carries it, and a restart from it tells the batch", async () => {
  const gh = repoState();
  gh.issue(5, [OBJ, "factory:in-review"]);
  gh.s.prs["factory/5"] = [{ number: 71, merged_at: "2026-11-14T14:00:30Z" }];
  const stop = new AbortController();
  const answer = gh.answer;
  // The deadline comes while the merged PR is read (a network drop the client waits on until then).
  gh.answer = (method, url, h) => {
    if (/\/pulls\?/.test(url) && !stop.signal.aborted) {
      stop.abort();
      throw new DOMException("This operation was aborted", "AbortError");
    }
    return answer(method, url, h);
  };
  const before = gh.s.events.length ? String(gh.s.events.at(-1).id) : "0";
  const r = await waiting(gh, [() => (gh.state(5, null), gh.event(5, "closed"))], { opts: { token: "t", signal: stop.signal } });
  assert.equal(r.code, WAIT_TIMEOUT_EXIT);
  assert.deepEqual(r.lines.map((l) => [l.event, idOf(l.cursor), stateOf(l.cursor)]), [["timeout", Number(before), false]], "the cursor from before the read, not past the close");
  const again = await waiting(gh, [], { since: parseCursor(r.lines[0].cursor) });
  assert.deepEqual(again.lines.map((l) => [l.event, l.issue]), [["merged", 5], ["drained", null]]);
});

test("a failure ends with an error line carrying the cursor to go on from (#285 review); a cursor of another repository is one", async () => {
  const gh = repoState();
  gh.issue(5, [OBJ, "factory:running"]);
  gh.issue(6, [OBJ, "factory:running"]);
  const answer = gh.answer;
  let refuse = false;
  gh.answer = (method, url, h) => (refuse && /\/issues\?state=open/.test(url) ? [403, JSON.stringify({ message: "Resource not accessible by personal access token" }), {}] : answer(method, url, h));
  const first = await waiting(gh, [() => gh.state(5, "factory:in-review")]);
  const cursor = first.lines.at(-1).cursor;
  // The Block's read of the open Objectives is refused: the wait fails, after an error line with the cursor before it.
  refuse = true;
  const failed = [];
  await assert.rejects(waiting(gh, [() => gh.state(6, "factory:blocked")], { since: parseCursor(cursor), emit: (l) => failed.push(l) }), /403/);
  assert.deepEqual(failed.map((l) => [l.event, l.cursor]), [["error", cursor]]);
  assert.match(failed[0].message, /403/);
  refuse = false;
  const again = await waiting(gh, [], { since: parseCursor(failed[0].cursor) });
  assert.deepEqual(again.lines.map((l) => [l.event, l.issue]), [["blocked", 6]], "restarted from it, the Block is told (#5, In review, keeps the queue active)");
  const elsewhere = [];
  await assert.rejects(waiting(gh, [], { since: parseCursor(String(gh.s.events.at(-1).id + 1_000_000)), emit: (l) => elsewhere.push(l) }), (e) => e.code === "cursor-elsewhere");
  assert.deepEqual(elsewhere.map((l) => l.event), ["error"]);
});

test("a cursor more than WAIT_MAX_PAGES pages back (#285 review): a gap line first, then what the pages read tell", async () => {
  const gh = repoState();
  gh.issue(5, [OBJ, "factory:running"]);
  gh.issue(9, ["bug"]);
  gh.event(9, "labeled", "P1");
  const cursor = String(gh.s.events.at(-1).id);
  for (let i = 0; i < WAIT_MAX_PAGES * WAIT_PAGE + 5; i += 1) gh.event(9, i % 2 ? "unlabeled" : "labeled", "P1");
  gh.state(5, "factory:blocked");
  const r = await waiting(gh, [], { since: parseCursor(cursor), kinds: ["blocked"] });
  assert.deepEqual(r.lines.map((l) => [l.event, l.issue]), [["gap", null], ["blocked", 5]]);
  assert.equal(idOf(r.lines[0].cursor), gh.s.events.at(-1).id);
  assert.equal(gh.s.seen.filter((l) => /issues\/events/.test(l)).length, WAIT_MAX_PAGES);
});

test("an event GitHub lists late, below an id already read (#285 review), is told on the next read, and once", async () => {
  const gh = repoState();
  gh.issue(5, [OBJ, "factory:running"]);
  gh.issue(6, [OBJ, "factory:running"]);
  gh.event(5, "labeled", "factory:running");
  let late;
  const r = await waiting(gh, [() => gh.state(5, "factory:in-review"), () => {
    // Its id is below #5's In review, which the last read already returned.
    late = gh.s.events.at(-1).id - 3;
    gh.event(6, "unlabeled", "factory:running", late);
    gh.event(6, "labeled", "factory:blocked", late + 1);
  }, () => {}], { follow: true, timeoutMs: 95_000, kinds: ["blocked", "in-review"] });
  assert.deepEqual(r.lines.map((l) => [l.event, l.issue]), [["in-review", 5], ["blocked", 6], ["timeout", null]]);
});

test("a restart --since a cursor (#285 review) tells an event GitHub lists late, below the cursor, and nothing already told", async () => {
  const gh = repoState();
  gh.issue(5, [OBJ, "factory:running"]);
  gh.issue(6, [OBJ, "factory:running"]);
  gh.event(5, "labeled", "factory:running");
  const first = await waiting(gh, [() => gh.state(5, "factory:in-review")], { kinds: ["blocked", "in-review"] });
  assert.deepEqual(first.lines.map((l) => [l.event, l.issue]), [["in-review", 5]]);
  // After that wait exits, GitHub lists #6's Block, its id below the In review the cursor names.
  gh.event(6, "labeled", "factory:blocked", gh.s.events.at(-1).id - 3);
  const again = await waiting(gh, [() => {}], { since: parseCursor(first.lines[0].cursor), follow: true, timeoutMs: 35_000, kinds: ["blocked", "in-review"] });
  assert.deepEqual(again.lines.map((l) => [l.event, l.issue]), [["blocked", 6], ["timeout", null]]);
});

test("each event is decided on its issue's labels as they were then (#285 review), not as later events in the read left them", async () => {
  const gh = repoState();
  gh.issue(5, [OBJ, "factory:running"]);
  gh.issue(9, ["bug"]);
  gh.event(5, "labeled", "factory:running");
  // Between two reads: #5 Blocks, then loses the Objective label; #9, no Objective, gets a state label, then the Objective label.
  const r = await waiting(gh, [() => (gh.state(5, "factory:blocked"), gh.event(5, "unlabeled", OBJ), gh.event(9, "labeled", "factory:question"), gh.event(9, "labeled", OBJ))], { follow: true, timeoutMs: 35_000, kinds: ["blocked", "question"] });
  assert.deepEqual(r.lines.map((l) => [l.event, l.issue]), [["blocked", 5], ["timeout", null]]);
});

test("jsonLine escapes U+2028, U+2029 and U+0085, and parses back to the same value", () => {
  const o = { title: "a\u2028b\u2029c\u0085d" };
  const line = jsonLine(o);
  assert.doesNotMatch(line, /[\u2028\u2029\u0085\n\r]/);
  assert.deepEqual(JSON.parse(line), o);
});

test("factory wait's command line: issue numbers, a cursor or a time, kinds, --follow; anything else is a usage error", () => {
  assert.deepEqual(parseArgs(["wait", "166", "169", "--since", "36176470266", "--on", "blocked,question", "--timeout", "600"]), { cmd: "wait", flags: { _: ["wait", "166", "169"], since: "36176470266", on: "blocked,question", timeout: 600 } });
  assert.deepEqual(parseArgs(["wait", "--follow", "--since=2026-11-14T14:00:00Z"]), { cmd: "wait", flags: { _: ["wait"], follow: true, since: "2026-11-14T14:00:00Z" } });
  for (const a of ["wait x", "wait --on blocked,done", "wait --since yesterday", "wait --since 2026-11-14T14:00:00", "wait --timeout 0", "wait --follow=1"]) assert.throws(() => parseArgs(a.split(" ")), (e) => e.usage === true, a);
  assert.deepEqual(parseCursor("2026-11-14T14:00:00-08:00"), { at: Date.parse("2026-11-14T22:00:00Z") });
  // A printed cursor parses back to its id, queue state and ids read; a bare event id is one too, its state unknown.
  for (const drained of [true, false, null]) assert.deepEqual(parseCursor(cursorText({ id: 36176470266 }, drained, [36176470259, 36176470266, 36176470224])), { id: 36176470266, drained, seen: [36176470266, 36176470259, 36176470224] });
  assert.match(cursorText({ id: 36176470266 }, true, [36176470259]), /^[A-Za-z0-9_-]+$/, "safe on a command line unquoted");
  assert.deepEqual(parseCursor("36176470266"), { id: 36176470266, drained: null, seen: [36176470266] });
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  for (const bad of ["36176470266x", "yesterday", enc({ id: 5, seen: [5] }), enc({ id: 5, drained: "yes" }), enc({ id: -1 }), enc([1]), "e30="]) assert.equal(parseCursor(bad), null, bad);
});

test("factory wait, run for real: GitHub's rate limit spent mid-wait is waited out as serve does; the Block after it is one JSON line and exit 0; with nothing by --timeout, or a read still in flight at it, a timeout line and exit 3", async () => {
  const gh = repoState();
  // A title with the separators JSON.stringify leaves raw: the line must stay one line for any reader.
  gh.issue(5, [OBJ, "factory:running"], { title: "Objective 5\u2028second\u2029third\u0085fourth" });
  gh.event(5, "labeled", "factory:running");
  let reads = 0;
  let hang = false;
  const server = createServer((req, res) => {
    // A read GitHub never answers: --timeout must end it.
    if (hang) return;
    reads += /issues\/events/.test(req.url) ? 1 : 0;
    // The third events read meets the REST quota spent for 20 minutes; the fifth finds the Block.
    if (reads === 3) {
      const reset = Date.now() + 20 * 60_000;
      res.writeHead(403, { "content-type": "application/json", "x-ratelimit-limit": "5000", "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.ceil(reset / 1000)), "x-ratelimit-resource": "core" });
      res.end(JSON.stringify({ message: "API rate limit exceeded for user ID 1." }));
      return;
    }
    if (reads === 5 && gh.s.events.length === 1) gh.state(5, "factory:blocked");
    const [status, body, headers] = gh.answer(req.method, req.url, req.headers);
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(status === 304 ? undefined : body);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  // The network waits pass at once on a clock of their own (so the 20-minute reset takes no time), in the one module
  // instance the command loads.
  const pre = join(process.env.TMPDIR, "wait-pre.mjs");
  writeFileSync(pre, `import { OUTAGE } from ${JSON.stringify(pathToFileURL(join(SCRIPTS, "lib", "network.mjs")).href)};\nimport { RETRY } from ${JSON.stringify(pathToFileURL(join(SCRIPTS, "lib", "github.mjs")).href)};\nlet ahead = 0;\nOUTAGE.now = RETRY.now = () => Date.now() + ahead;\nOUTAGE.sleep = RETRY.sleep = async (ms) => { ahead += Math.max(0, ms); };\n`);
  const run = async (...args) => {
    const child = spawn(process.execPath, ["--import", pathToFileURL(pre).href, join(SCRIPTS, "local.mjs"), "wait", "--repo", "acme/widgets", "--interval", "0.05", ...args], { env: { PATH: process.env.PATH, HOME: process.env.TMPDIR, TMPDIR: process.env.TMPDIR, GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`, FACTORY_LOCAL_TOKEN: "github_pat_test" }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    const code = await new Promise((r) => child.on("exit", r));
    return { code, out, err };
  };
  try {
    const told = await run("--on", "blocked");
    assert.equal(told.code, 0, told.out + told.err);
    const lines = told.out.trim().split("\n");
    assert.equal(lines.length, 1, told.out);
    assert.doesNotMatch(told.out, /[\u2028\u2029\u0085]/);
    assert.deepEqual(JSON.parse(lines[0]), { event: "blocked", issue: 5, title: "Objective 5\u2028second\u2029third\u0085fourth", url: "https://github.com/acme/widgets/issues/5", at: gh.s.events.at(-1).created_at, cursor: JSON.parse(lines[0]).cursor });
    assert.equal(idOf(JSON.parse(lines[0]).cursor), gh.s.events.at(-1).id);
    assert.ok(gh.s.seen.some((l) => / 304$/.test(l)), gh.s.seen.join("\n"));
    assert.match(told.out + told.err, /rate limit on 127\.0\.0\.1:\d+ is spent until/);
    assert.deepEqual(gh.s.seen.slice(0, 4), ["GET issues/events?per_page=30", "GET issues/events?per_page=30 304", "GET issues/events?per_page=30 304", "GET issues/events?per_page=30"], "one read again after the reset, none before it");
    const quiet = await run("--since", String(gh.s.events.at(-1).id), "--timeout", "0.3");
    assert.equal(quiet.code, WAIT_TIMEOUT_EXIT, quiet.out + quiet.err);
    const last = JSON.parse(quiet.out.trim().split("\n").at(-1));
    assert.equal(last.event, "timeout");
    assert.equal(idOf(last.cursor), gh.s.events.at(-1).id);
    hang = true;
    const started = Date.now();
    const hung = await run("--since", String(gh.s.events.at(-1).id), "--timeout", "0.5");
    assert.equal(hung.code, WAIT_TIMEOUT_EXIT, hung.out + hung.err);
    assert.ok(Date.now() - started < 5_000, `ended at its timeout, not when the read would (${Date.now() - started} ms)`);
    const timedOut = JSON.parse(hung.out.trim());
    assert.deepEqual(timedOut, { event: "timeout", issue: null, at: timedOut.at, cursor: timedOut.cursor });
    assert.equal(idOf(timedOut.cursor), gh.s.events.at(-1).id);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
