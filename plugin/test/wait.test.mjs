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
import { WAIT_KINDS, WAIT_TIMEOUT_EXIT, parseCursor, waitQueue } from "../scripts/lib/wait.mjs";
import { parseArgs } from "../scripts/local.mjs";

const SCRIPTS = join(import.meta.dirname, "..", "scripts");
const repo = { owner: "acme", name: "widgets", full: "acme/widgets" };
const OBJ = "factory:objective";
const T0 = Date.parse("2026-11-14T14:00:00Z");

/** One repository's issues, PRs and issue events; `answer(method, url, headers)` is GitHub's answer as [status, body, headers]. */
function repoState() {
  const s = { issues: new Map(), events: [], prs: {}, nextId: 36_000_000_000, at: T0, seen: [] };
  const issue = (number, labels = [OBJ], extra = {}) => s.issues.set(number, { number, title: `Objective ${number}`, html_url: `https://github.com/acme/widgets/issues/${number}`, state: "open", labels: labels.map((name) => ({ name })), ...extra });
  const event = (number, event, label = null) => {
    const i = s.issues.get(number);
    if (event === "labeled") i.labels = [...i.labels.filter((l) => l.name !== label), { name: label }];
    if (event === "unlabeled") i.labels = i.labels.filter((l) => l.name !== label);
    if (event === "closed") i.state = "closed";
    if (event === "reopened") i.state = "open";
    s.at += 1000;
    s.events.push({ id: (s.nextId += 7), event, created_at: new Date(s.at).toISOString(), ...(label ? { label: { name: label } } : {}), issue: i });
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
  assert.deepEqual(r.lines, [{ event: "blocked", issue: 5, title: "Objective 5", url: "https://github.com/acme/widgets/issues/5", at: gh.s.events.at(-1).created_at, cursor: String(last) }]);
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
  assert.equal(r.lines[0].cursor, String(gh.s.events[1].id), "the first read's cursor: its newest event");
  assert.equal(r.lines[1].cursor, String(gh.s.events.at(-1).id), "the label running 5 again is read, not told, and still moves the cursor");
  assert.equal(r.lines[2].cursor, r.lines[1].cursor, "the timeout line carries the cursor to go on from");
  assert.deepEqual(r.slept, [30_000, 30_000, 30_000, 10_000], "the last wait ends at the timeout");
});

test("a closed Objective is merged when the newest PR on factory/<issue> merged, else closed; other issues and PRs are not told", async () => {
  const gh = repoState();
  gh.issue(5, [OBJ, "factory:in-review"]);
  gh.issue(6, [OBJ, "factory:in-review"]);
  gh.issue(9, ["bug"]);
  gh.issue(70, [OBJ], { pull_request: { url: "x" } });
  gh.s.prs["factory/5"] = [{ number: 71, merged_at: "2026-11-14T14:00:30Z" }];
  // A split Objective's earlier part merged; its newest PR was closed unmerged.
  gh.s.prs["factory/6"] = [{ number: 73, merged_at: null }, { number: 72, merged_at: "2026-11-14T13:00:00Z" }];
  const r = await waiting(gh, [() => (gh.event(70, "closed"), gh.event(9, "closed"), gh.state(5, null), gh.event(5, "closed"), gh.event(6, "closed"), gh.event(70, "labeled", "factory:blocked"))], { kinds: WAIT_KINDS.filter((k) => k !== "drained") });
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
  assert.equal(r.lines[0].cursor, String(gh.s.events.at(-1).id));
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
  assert.match(r.lines[1].cursor, /^\d+d$/, "the cursor says the queue is drained there");
});

test("drained after a restart (#272 review): the cursor carries the queue's state, so a wait started --since it does not tell the same drain again", async () => {
  const gh = repoState();
  gh.issue(5, [OBJ, "factory:running"]);
  gh.issue(6, [OBJ, "factory:blocked"]);
  const first = await waiting(gh, [() => gh.state(5, "factory:question")]);
  assert.deepEqual(first.lines.map((l) => [l.event, l.issue]), [["question", 5], ["drained", null]]);
  const cursor = first.lines.at(-1).cursor;
  assert.match(cursor, /^\d+d$/);
  // Still drained: a Blocked one closed is told, the drain is not.
  const again = await waiting(gh, [], { since: parseCursor(cursor), kinds: ["closed", "drained"], timeoutMs: 1 });
  assert.deepEqual(again.lines.map((l) => l.event), ["timeout"]);
  const closed = await waiting(gh, [() => gh.event(6, "closed")], { since: parseCursor(again.lines[0].cursor) });
  assert.deepEqual(closed.lines.map((l) => [l.event, l.issue]), [["closed", 6]]);
  assert.match(closed.lines[0].cursor, /^\d+d$/);
  // Active again (a new Objective queued) then drained: told, and a cursor from before the queue moved says so.
  gh.issue(8, []);
  const active = await waiting(gh, [() => gh.event(8, "labeled", OBJ), () => gh.state(8, "factory:blocked")], { since: parseCursor(closed.lines[0].cursor) });
  assert.deepEqual(active.lines.map((l) => [l.event, l.issue]), [["blocked", 8], ["drained", null]]);
});

test("factory wait's command line: issue numbers, a cursor or a time, kinds, --follow; anything else is a usage error", () => {
  assert.deepEqual(parseArgs(["wait", "166", "169", "--since", "36176470266", "--on", "blocked,question", "--timeout", "600"]), { cmd: "wait", flags: { _: ["wait", "166", "169"], since: "36176470266", on: "blocked,question", timeout: 600 } });
  assert.deepEqual(parseArgs(["wait", "--follow", "--since=2026-11-14T14:00:00Z"]), { cmd: "wait", flags: { _: ["wait"], follow: true, since: "2026-11-14T14:00:00Z" } });
  for (const a of ["wait x", "wait --on blocked,done", "wait --since yesterday", "wait --since 2026-11-14T14:00:00", "wait --timeout 0", "wait --follow=1"]) assert.throws(() => parseArgs(a.split(" ")), (e) => e.usage === true, a);
  assert.deepEqual(parseCursor("2026-11-14T14:00:00-08:00"), { at: Date.parse("2026-11-14T22:00:00Z") });
  assert.deepEqual(parseCursor("36176470266d"), { id: 36176470266, drained: true });
  assert.deepEqual(parseCursor("36176470266a"), { id: 36176470266, drained: false });
  assert.deepEqual(parseCursor("36176470266"), { id: 36176470266, drained: null });
  assert.equal(parseCursor("36176470266x"), null);
});

test("factory wait, run for real: GitHub's rate limit spent mid-wait is waited out as serve does; the Block after it is one JSON line and exit 0; with nothing by --timeout, or a read still in flight at it, a timeout line and exit 3", async () => {
  const gh = repoState();
  gh.issue(5, [OBJ, "factory:running"]);
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
    assert.deepEqual(JSON.parse(lines[0]), { event: "blocked", issue: 5, title: "Objective 5", url: "https://github.com/acme/widgets/issues/5", at: gh.s.events.at(-1).created_at, cursor: String(gh.s.events.at(-1).id) });
    assert.ok(gh.s.seen.some((l) => / 304$/.test(l)), gh.s.seen.join("\n"));
    assert.match(told.out + told.err, /rate limit on 127\.0\.0\.1:\d+ is spent until/);
    assert.deepEqual(gh.s.seen.slice(0, 4), ["GET issues/events?per_page=30", "GET issues/events?per_page=30 304", "GET issues/events?per_page=30 304", "GET issues/events?per_page=30"], "one read again after the reset, none before it");
    const quiet = await run("--since", String(gh.s.events.at(-1).id), "--timeout", "0.3");
    assert.equal(quiet.code, WAIT_TIMEOUT_EXIT, quiet.out + quiet.err);
    const last = JSON.parse(quiet.out.trim().split("\n").at(-1));
    assert.equal(last.event, "timeout");
    assert.equal(last.cursor, String(gh.s.events.at(-1).id));
    hang = true;
    const started = Date.now();
    const hung = await run("--since", String(gh.s.events.at(-1).id), "--timeout", "0.5");
    assert.equal(hung.code, WAIT_TIMEOUT_EXIT, hung.out + hung.err);
    assert.ok(Date.now() - started < 5_000, `ended at its timeout, not when the read would (${Date.now() - started} ms)`);
    assert.deepEqual(JSON.parse(hung.out.trim()), { event: "timeout", issue: null, at: JSON.parse(hung.out.trim()).at, cursor: String(gh.s.events.at(-1).id) });
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
