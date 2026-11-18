// #272: an orchestrator waits on the queue (`pendulum wait`) and is told, within a poll, when an Objective Blocks, asks a
// Question, goes In review, merges or closes, or the queue drains. GitHub here answers as it does: the repository's
// issue events newest first, 30 a page, with an ETag; a request that sends that ETag back for an unchanged page gets
// a 304, which GitHub's rate limit does not count.
import "./temp.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { RETRY } from "../scripts/lib/github.mjs";
import { WAIT_KINDS, jsonLine, parseCursor, waitQueue } from "../scripts/lib/wait.mjs";

const repo = { owner: "acme", name: "widgets", full: "acme/widgets" };
const OBJ = "pendulum:objective";
const T0 = Date.parse("2026-11-14T14:00:00Z");
/** A printed cursor's event id and queue state. */
const idOf = (c) => parseCursor(c).id;

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
  /** Pendulum's setStateLabel: every other state label off, then this one on. */
  const state = (number, to) => {
    for (const l of ["pendulum:running", "pendulum:blocked", "pendulum:question", "pendulum:in-review"]) if (l !== to && s.issues.get(number).labels.some((x) => x.name === l)) event(number, "unlabeled", l);
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
  gh.issue(5, [OBJ, "pendulum:running"]);
  gh.issue(6, [OBJ]);
  gh.event(5, "labeled", "pendulum:running");
  const r = await waiting(gh, [() => {}, () => gh.state(5, "pendulum:blocked")], { kinds: WAIT_KINDS.filter((k) => k !== "drained") });
  assert.equal(r.code, 0);
  const last = gh.s.events.at(-1).id;
  assert.deepEqual(r.lines.map(({ cursor, ...l }) => l), [{ event: "blocked", issue: 5, title: "Objective 5", url: "https://github.com/acme/widgets/issues/5", at: gh.s.events.at(-1).created_at }]);
  assert.equal(idOf(r.lines[0].cursor), last);
  assert.deepEqual(r.slept, [30_000, 30_000], "a poll every 30 seconds by default");
  // The start reads the newest events; the first poll's read is unchanged (a 304); the next one sees the Block.
  assert.deepEqual(gh.s.seen, ["GET issues/events?per_page=30", "GET issues/events?per_page=30 304", "GET issues/events?per_page=30 304", "GET issues/events?per_page=30"]);
});

test("--since goes on from a cursor with nothing missed or told twice, paging back past one page; a time works as a cursor too", async () => {
  const gh = repoState();
  gh.issue(5, [OBJ, "pendulum:running"]);
  gh.issue(6, [OBJ, "pendulum:running"]);
  gh.issue(9, ["bug"]);
  gh.state(5, "pendulum:blocked");
  const cursor = gh.s.events.at(-1).id;
  const told = gh.s.events.at(-1).created_at;
  gh.state(6, "pendulum:question");
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
  gh.issue(5, [OBJ, "pendulum:in-review"]);
  gh.issue(6, [OBJ, "pendulum:blocked"]);
  gh.issue(7, [OBJ, "pendulum:draft"]);
  gh.s.prs["pendulum/5"] = [{ number: 71, merged_at: "2026-11-14T14:00:30Z" }];
  const r = await waiting(gh, [() => (gh.state(5, null), gh.event(5, "closed"))]);
  assert.deepEqual(r.lines.map(({ event, issue, blocked, question }) => ({ event, issue, blocked, question })), [{ event: "merged", issue: 5, blocked: undefined, question: undefined }, { event: "drained", issue: null, blocked: [6], question: [] }], "a draft is not still to run");
  // Drained already at the start: a Blocked one closed is told, and the queue is not told drained again.
  const again = await waiting(gh, [() => gh.event(6, "closed")]);
  assert.deepEqual(again.lines.map((l) => l.event), ["closed"]);
  // A new Objective moves the queue; its Question drains it again, told once in a --follow.
  gh.issue(8, []);
  const follow = await waiting(gh, [() => gh.event(8, "labeled", OBJ), () => gh.state(8, "pendulum:running"), () => gh.state(8, "pendulum:question"), () => gh.event(8, "labeled", "P1")], { follow: true, timeoutMs: 125_000 });
  assert.deepEqual(follow.lines.map((l) => [l.event, l.issue]), [["question", 8], ["drained", null], ["timeout", null]]);
  assert.deepEqual(follow.lines[1].question, [8]);
});

test("an event GitHub lists late, below an id already read (#285 review), is told on the next read, and once", async () => {
  const gh = repoState();
  gh.issue(5, [OBJ, "pendulum:running"]);
  gh.issue(6, [OBJ, "pendulum:running"]);
  gh.event(5, "labeled", "pendulum:running");
  let late;
  const r = await waiting(gh, [() => gh.state(5, "pendulum:in-review"), () => {
    // Its id is below #5's In review, which the last read already returned.
    late = gh.s.events.at(-1).id - 3;
    gh.event(6, "unlabeled", "pendulum:running", late);
    gh.event(6, "labeled", "pendulum:blocked", late + 1);
  }, () => {}], { follow: true, timeoutMs: 95_000, kinds: ["blocked", "in-review"] });
  assert.deepEqual(r.lines.map((l) => [l.event, l.issue]), [["in-review", 5], ["blocked", 6], ["timeout", null]]);
});

test("jsonLine escapes U+2028, U+2029 and U+0085, and parses back to the same value", () => {
  const o = { title: "a\u2028b\u2029c\u0085d" };
  const line = jsonLine(o);
  assert.doesNotMatch(line, /[\u2028\u2029\u0085\n\r]/);
  assert.deepEqual(JSON.parse(line), o);
});
