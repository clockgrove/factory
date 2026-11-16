// A Question asked on the issue (no PR, or the plan-time Question) says "answer in a comment on the issue" (#344). On
// every route a trusted answer there puts it back in the queue at the next tick: the dispatcher's answered pass, which
// only the sandbox route ran. Which form a Question has is the one decision applyExit makes (logic.mjs questionForm):
// its notice's text and marker, and so whether a comment alone resumes it. Each Question here is asked by the real
// applyExit and each tick is the real dispatch(), against one fake GitHub whose labels, timelines and comments persist
// between ticks, with ETags, so a read can be conditional.
import "./temp.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { RETRY } from "../scripts/lib/github.mjs";
import { asksQuestion, missedAnswer, questionForm, questionFormOf, questionMarker, setSelf } from "../scripts/lib/logic.mjs";
import { applyExit, questionNotice } from "../scripts/lib/session.mjs";
import { workOwnsBranch } from "../scripts/review.mjs";

RETRY.sleep = async () => {};

const BOT = { login: "factory-app[bot]", type: "Bot" };
const PERSON = { login: "maintainer", type: "User" };
const STRANGER = { login: "passer-by", type: "User" };
const REPO = { owner: "acme", name: "app", full: "acme/app" };
const OBJ = "factory:objective";
const MIN = 60_000;

/**
 * One repository: Objectives, each with an optional open draft PR on factory/<n> (`pr`: its body). `asked`: the
 * Question asked that long ago, its issue-form notice with it (else ask() asks one through applyExit). Pages carry an
 * ETag; a request whose If-None-Match matches gets a 304.
 */
function fakeGitHub(open, { self = BOT } = {}) {
  let last = 0;
  const stamp = () => new Date((last = Math.max(Date.now(), last + 1))).toISOString();
  const issues = new Map();
  let ids = 1000;
  for (const { number, asked = null, pr = null } of open) {
    const labels = asked === null ? [OBJ] : [OBJ, "factory:question"];
    const at = new Date(Date.now() - (asked ?? 60 * MIN)).toISOString();
    issues.set(number, {
      issue: { number, state: "open", body: "", user: PERSON, labels: [...labels] },
      timeline: [
        { event: "labeled", label: { name: OBJ }, actor: PERSON, created_at: new Date(Date.parse(at) - 20 * MIN).toISOString() },
        ...labels.filter((l) => l !== OBJ).map((name) => ({ event: "labeled", label: { name }, actor: self, created_at: at })),
      ],
      comments: asked === null ? [] : [{ id: (ids += 1), user: self, body: `${questionMarker(number, { stage: "work", runId: "1", form: "issue" })}\nQuestion (work): which one?`, created_at: at, updated_at: at }],
      pr: pr === null ? null : { number: number * 10, node_id: `PR_${number}`, state: "open", draft: true, body: pr, head: { ref: `factory/${number}` }, labels: [], user: self },
    });
  }
  const reads = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || "GET";
    const body = init.body ? JSON.parse(init.body) : null;
    const path = decodeURIComponent(u.pathname).replace("/repos/acme/app", "");
    const tag = init.headers?.["If-None-Match"] ?? null;
    const json = (b, status = 200) => {
      const text = JSON.stringify(b);
      const etag = `"${createHash("sha1").update(text).digest("hex")}"`;
      if (method === "GET") reads.push({ path, conditional: !!tag, unchanged: tag === etag });
      if (method === "GET" && status === 200 && tag === etag) return new Response(null, { status: 304, headers: { etag } });
      return new Response(text, { status, headers: { "content-type": "application/json", ...(method === "GET" ? { etag } : {}) } });
    };
    if (u.pathname === "/graphql") return json({ data: {} });
    const n = Number(/^\/issues\/(\d+)/.exec(path)?.[1]);
    const one = issues.get(n);
    if (method === "GET" && path === "/issues") {
      if (u.searchParams.get("state") === "closed") return json([]);
      const label = u.searchParams.get("labels");
      return json([...issues.values()].map((i) => i.issue).filter((i) => i.labels.includes(label)).map((i) => ({ ...i, labels: i.labels.map((name) => ({ name })) })));
    }
    if (method === "GET" && /^\/issues\/\d+$/.test(path) && one) return json({ ...one.issue, labels: one.issue.labels.map((name) => ({ name })) });
    if (method === "GET" && /^\/issues\/\d+\/timeline$/.test(path) && one) return json(one.timeline);
    if (method === "GET" && /^\/issues\/\d+\/comments$/.test(path) && one) return json(one.comments);
    if (method === "POST" && /^\/issues\/\d+\/comments$/.test(path) && one) {
      const c = { id: (ids += 1), user: self, body: body.body, created_at: stamp(), updated_at: stamp() };
      one.comments.push(c);
      return json(c, 201);
    }
    if (method === "POST" && /^\/issues\/\d+\/labels$/.test(path) && one) {
      for (const name of body.labels)
        if (!one.issue.labels.includes(name)) {
          one.issue.labels.push(name);
          one.timeline.push({ event: "labeled", label: { name }, actor: self, created_at: stamp() });
        }
      return json(one.issue.labels.map((name) => ({ name })));
    }
    const off = /^\/issues\/\d+\/labels\/(.+)$/.exec(path);
    if (method === "DELETE" && off && one) {
      if (!one.issue.labels.includes(off[1])) return json({ message: "Label does not exist" }, 404);
      one.issue.labels = one.issue.labels.filter((l) => l !== off[1]);
      one.timeline.push({ event: "unlabeled", label: { name: off[1] }, actor: self, created_at: stamp() });
      return json({});
    }
    if (method === "GET" && path === "/pulls") {
      const head = u.searchParams.get("head");
      const prs = [...issues.values()].map((i) => i.pr).filter(Boolean);
      return json(head ? prs.filter((p) => `acme:${p.head.ref}` === head) : prs);
    }
    const onePr = /^\/pulls\/(\d+)$/.exec(path);
    if (method === "GET" && onePr) {
      const p = [...issues.values()].map((i) => i.pr).find((x) => x?.number === Number(onePr[1]));
      return p ? json(p) : json({ message: "Not Found" }, 404);
    }
    if (method === "GET" && /^\/(issues|pulls)\/\d+\/(comments|reviews)$/.test(path)) return json([]);
    if (method === "GET" && path === "/collaborators") return json([{ login: PERSON.login }]);
    if (method === "GET" && /^\/collaborators\/[^/]+\/permission$/.test(path)) return json({ permission: "read" });
    if (method === "GET" && /^\/actions\/workflows\/[^/]+\/runs$/.test(path)) return json({ workflow_runs: [] });
    if (method === "GET" && path === "/actions/artifacts") return json({ artifacts: [] });
    if (method === "GET" && path === "/issues/comments") return json([]);
    return json({ message: "Not Found" }, 404);
  };
  return {
    fetch,
    reads,
    labels: (n) => [...issues.get(n).issue.labels].sort(),
    pr: (n) => issues.get(n).pr,
    /** A comment on the issue, `ago` ms back (0: now, after every write so far). */
    comment(n, user, text, ago = 0) {
      const at = ago ? new Date(Date.now() - ago).toISOString() : stamp();
      issues.get(n).comments.push({ id: (ids += 1), user, body: text, created_at: at, updated_at: at });
    },
  };
}

/** A stage's Question exit on `gh`, as the worker applies it (session.mjs applyExit): its PR, if any, and its form. */
async function ask(gh, n, { askOnIssue = false, pr = null, self = BOT } = {}) {
  const realFetch = globalThis.fetch;
  const saved = process.env.GITHUB_API_URL;
  process.env.GITHUB_API_URL = "https://github.test";
  globalThis.fetch = gh.fetch;
  setSelf(self.login);
  try {
    await applyExit(REPO, { issue: n, pr, exit: "question", reason: "question: which one?", notify: "kirk", stage: "work", askOnIssue }, { token: "t" });
  } finally {
    globalThis.fetch = realFetch;
    setSelf(null);
    if (saved === undefined) delete process.env.GITHUB_API_URL;
    else process.env.GITHUB_API_URL = saved;
  }
}

/** One dispatcher tick on `gh`: the Action's route, or a local loop's (`local`, where Factory posts as the person). */
async function tick(gh, { local = false, sandbox = undefined, localStopped = {}, localHeld = {}, readCache = null } = {}) {
  const { dispatch } = await import("../scripts/dispatch.mjs");
  const realFetch = globalThis.fetch;
  const keys = ["FACTORY_LOCAL", "FACTORY_LOCAL_ALL", "GITHUB_API_URL", "GITHUB_RUN_ID"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  process.env.GITHUB_API_URL = "https://github.test";
  delete process.env.GITHUB_RUN_ID;
  if (local) Object.assign(process.env, { FACTORY_LOCAL: "1", FACTORY_LOCAL_ALL: "1" });
  else {
    delete process.env.FACTORY_LOCAL;
    delete process.env.FACTORY_LOCAL_ALL;
  }
  globalThis.fetch = gh.fetch;
  setSelf(local ? PERSON.login : BOT.login);
  try {
    return await dispatch({ repo: REPO.full, objectiveLabel: OBJ, maxConcurrent: 5, dailyUsd: 0, ciChecks: [], timeoutMinutes: 60, notify: "kirk", ...(sandbox ? { sandbox } : {}) }, { token: "t", localStopped, localHeld, readCache });
  } finally {
    globalThis.fetch = realFetch;
    setSelf(null);
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

const PR_BODY = "## Assumptions\n- the simplest reading";

test("one decision, questionForm, picks the notice's instruction and its marker; questionFormOf reads Factory's latest since the Question", () => {
  const pr = { number: 70 };
  assert.equal(questionForm({ pr: null }), "issue");
  assert.equal(questionForm({ pr, askOnIssue: true }), "issue");
  assert.equal(questionForm({ pr }), "pr");
  assert.match(questionNotice({ stage: "work", reason: "question: which one?" }), /Answer in a comment on the issue\.$/);
  assert.match(questionNotice({ stage: "work", reason: "which one?", pr, askOnIssue: true }), /answer here on the issue, not by marking it ready/);
  assert.match(questionNotice({ stage: "work", reason: "which one?", pr }), /Answer in a comment on the issue or the PR, then mark the PR ready\.$/);
  assert.equal(asksQuestion("## Assumptions\n- QUESTION: which one?"), true);
  assert.equal(asksQuestion(PR_BODY), false);

  const since = "2026-11-15T10:00:00Z";
  const notice = (form, at, user = BOT) => ({ user, body: `${questionMarker(7, { stage: "work", runId: "9-1", form })}\nQuestion`, created_at: at, updated_at: at });
  assert.equal(questionFormOf([notice("issue", "2026-11-15T10:00:00Z")], { issue: 7, since }), "issue", "posted with the label's second");
  assert.equal(questionFormOf([notice("issue", "2026-11-15T09:00:00Z")], { issue: 7, since }), null, "an earlier Question's notice");
  assert.equal(questionFormOf([notice("issue", "2026-11-15T10:01:00Z"), notice("pr", "2026-11-15T10:02:00Z")], { issue: 7, since }), "pr", "the latest counts");
  assert.equal(questionFormOf([notice("issue", "2026-11-15T10:01:00Z", STRANGER)], { issue: 7, since }), null, "a stranger's pasted marker");
  assert.equal(questionFormOf([{ ...notice("issue", "2026-11-15T10:01:00Z"), body: "<!-- factory:7:question:work:1 -->\nQuestion" }], { issue: 7, since }), null, "a notice with no form");
  // With no grace, an answer whose GitHub time is ahead of this machine's clock still counts.
  assert.ok(missedAnswer([{ created_at: "2026-11-15T10:05:00Z" }], { questionSince: since, now: Date.parse("2026-11-15T10:04:00Z"), graceMs: 0 }));
});

test("Actions without a sandbox: a maintainer's comment after an issue Question requeues it at the next tick; Factory's own, a stranger's or an earlier one does not", async () => {
  const gh = fakeGitHub([{ number: 7 }]);
  gh.comment(7, PERSON, "an earlier thought, before the Question", 40 * MIN);
  await ask(gh, 7);
  gh.comment(7, STRANGER, "use the second one");
  gh.comment(7, BOT, "<!-- factory:7:progress:1 -->\nFactory's progress");
  const before = await tick(gh);
  assert.deepEqual(before.answered, [], "no trusted answer since the Question");
  assert.deepEqual(gh.labels(7), [OBJ, "factory:question"].sort());

  gh.comment(7, PERSON, "use the second one");
  const r = await tick(gh);
  assert.deepEqual(r.answered, [7]);
  assert.ok(r.ready.includes(7), "picked in the same tick");
  assert.ok(!gh.labels(7).includes("factory:question"), "no longer a Question");
});

test("Actions without a sandbox: a Question its PR asks waits for the ready mark, even with no QUESTION: line in the body; a plan-time Question with a PR resumes on the comment", async () => {
  const gh = fakeGitHub([
    { number: 8, pr: PR_BODY },
    { number: 9, pr: PR_BODY },
  ]);
  // The same PR body, no QUESTION: line in either: only the Question's form tells them apart.
  await ask(gh, 8, { pr: gh.pr(8) });
  await ask(gh, 9, { pr: gh.pr(9), askOnIssue: true });
  gh.comment(8, PERSON, "yes, change it");
  gh.comment(9, PERSON, "do it in this repository alone");
  const r = await tick(gh);
  assert.deepEqual(r.answered, [9]);
  assert.ok(gh.labels(8).includes("factory:question"), "the PR's Question waits for the PR to be marked ready");
  assert.ok(!gh.labels(9).includes("factory:question"));

  // An earlier Question asked on the issue, answered, then a Question the PR asks: the old notice does not count.
  const later = fakeGitHub([{ number: 10, pr: PR_BODY }]);
  await ask(later, 10, { pr: later.pr(10), askOnIssue: true });
  later.comment(10, PERSON, "do it here");
  assert.deepEqual((await tick(later)).answered, [10]);
  await ask(later, 10, { pr: later.pr(10) });
  later.comment(10, PERSON, "yes, change it");
  assert.deepEqual((await tick(later)).answered, [], "the PR's Question waits for its ready mark");
});

test("local loop: Factory's own comments, posted as the person's login, never answer; the person's answer releases the stop and requeues it", async () => {
  const gh = fakeGitHub([{ number: 7 }], { self: PERSON });
  await ask(gh, 7, { self: PERSON });
  gh.comment(7, PERSON, "<!-- factory:7:progress:1 -->\nFactory's progress, as the person's login");
  const stopped = { 7: "its stage here ended with a Question" };
  const held = await tick(gh, { local: true, localStopped: stopped });
  assert.deepEqual([held.answered, held.released, held.ready], [[], [], []]);
  assert.ok(gh.labels(7).includes("factory:question"));

  gh.comment(7, PERSON, "use the second one");
  const reviewing = await tick(gh, { local: true, localStopped: stopped, localHeld: { 7: "its review runs on this box" } });
  assert.deepEqual(reviewing.answered, [], "a stage of it running on this box decides first");
  const r = await tick(gh, { local: true, localStopped: stopped });
  assert.deepEqual(r.answered, [7]);
  assert.deepEqual(r.released, [7], "the loop's stop is released by the answer");
  assert.ok(r.ready.includes(7), "picked");
  assert.ok(!gh.labels(7).includes("factory:question"));
});

test("a kept read cache makes the next tick's Question reads conditional (GitHub counts no 304)", async () => {
  const gh = fakeGitHub([{ number: 7, pr: PR_BODY }]);
  await ask(gh, 7, { pr: gh.pr(7), askOnIssue: true });
  const readCache = new Map();
  await tick(gh, { readCache });
  const first = gh.reads.length;
  await tick(gh, { readCache });
  const second = gh.reads.slice(first).filter((r) => /^\/issues\/7\/(timeline|comments)$/.test(r.path) || r.path === "/pulls");
  assert.ok(second.length >= 3, `the Question's timeline, comments and PR are read: ${JSON.stringify(second)}`);
  assert.ok(second.every((r) => r.conditional && r.unchanged), `each one a 304: ${JSON.stringify(second)}`);
});

test("the sandbox route keeps its rule: any Question a maintainer answered past the launch's grace is requeued, its PR's too", async () => {
  const gh = fakeGitHub([{ number: 8, asked: 30 * MIN, pr: "## Assumptions\n- QUESTION: change the exported type?" }]);
  gh.comment(8, PERSON, "yes, change it", 1 * MIN);
  const young = await tick(gh, { sandbox: "vercel" });
  assert.deepEqual(young.answered, [], "within the grace the comment's own launch is due first");
  assert.ok(young.deadlines.some((d) => d.issue === 8 && d.kind === "answer-grace"));
  gh.comment(8, PERSON, "and keep the old name as an alias", 10 * MIN);
  const r = await tick(gh, { sandbox: "vercel" });
  assert.deepEqual(r.answered, [8]);
});

test("review: a person's ready mark while the Objective is Queued or Running starts no review; a Question's, an In-review one's or Factory's own does", () => {
  const issue = (...labels) => ({ number: 7, labels: [OBJ, ...labels].map((name) => ({ name })) });
  const ready = { action: "ready_for_review", sender: PERSON };
  assert.match(workOwnsBranch({ ...ready, issue: issue("factory:running") }), /Running: its work stage owns factory\/7/);
  assert.match(workOwnsBranch({ ...ready, issue: issue() }), /Queued/);
  assert.equal(workOwnsBranch({ ...ready, issue: issue("factory:question") }), null, "the answer to a Question");
  assert.equal(workOwnsBranch({ ...ready, issue: issue("factory:in-review") }), null);
  assert.equal(workOwnsBranch({ action: "ready_for_review", sender: BOT, issue: issue("factory:running") }), null, "Factory's own mark");
  assert.equal(workOwnsBranch({ action: null, issue: issue("factory:running") }), null, "the review label the worker applies while it is still Running");
});
