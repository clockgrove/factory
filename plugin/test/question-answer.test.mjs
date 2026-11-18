// A Question asked on the issue (no PR, or the plan-time Question) says "answer in a comment on the issue" (#344). On
// every route a trusted answer there puts it back in the queue at the next tick: the dispatcher's answered pass, which
// only the sandbox route ran. Which form a Question has is the one decision applyExit makes (logic.mjs questionForm):
// its notice's text and marker, and so whether a comment alone resumes it. Each Question here is asked by the real
// applyExit and each tick is the real dispatch(), against one fake GitHub whose labels, timelines and comments persist
// between ticks, with ETags, so a read can be conditional.
import "./temp.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LOOKUP_DELAYS_MS } from "../scripts/lib/gateway-relay.mjs";
import { RETRY } from "../scripts/lib/github.mjs";
import { questionMarker, setSelf } from "../scripts/lib/logic.mjs";
import { applyExit } from "../scripts/lib/session.mjs";
import { readyOwner, workOwnsBranch } from "../scripts/review.mjs";

RETRY.sleep = async () => {};
// A generation is looked up at once, not after the relay's first wait.
LOOKUP_DELAYS_MS[0] = 0;

const BOT = { login: "pendulum-app[bot]", type: "Bot" };
const PERSON = { login: "maintainer", type: "User" };
const STRANGER = { login: "passer-by", type: "User" };
// GitHub lets anyone with triage access, and an App installed with issue write, apply labels: neither can push.
const TRIAGER = { login: "triager", type: "User" };
const APP = { login: "helper-app[bot]", type: "Bot" };
// A writer GitHub's collaborators list does not name (org-derived access): only a permission read shows it.
const UNLISTED = { login: "org-owner", type: "User" };
// A maintainer the workflow pins by id (PENDULUM_MAINTAINERS `pinned#4242`), whose permission reads as read.
const PINNED = { login: "pinned", id: 4242, type: "User" };
const REPO = { owner: "acme", name: "app", full: "acme/app" };
const OBJ = "pendulum:objective";
const MIN = 60_000;

/**
 * One repository: Objectives, each with an optional open draft PR on pendulum/<n> (`pr`: its body). `asked`: the
 * Question asked that long ago, its issue-form notice with it (else ask() asks one through applyExit). Pages carry an
 * ETag; a request whose If-None-Match matches gets a 304.
 */
let nextIds = 0;
function fakeGitHub(open, { self = BOT } = {}) {
  let last = 0;
  const stamp = () => new Date((last = Math.max(Date.now(), last + 1))).toISOString();
  const issues = new Map();
  // Comment ids are unique across every fake of the file, as GitHub's are: a process that keeps a comment's id (a
  // decision-spend comment, decision-spend.mjs) never edits another fake's comment by it.
  let ids = (nextIds += 1000);
  for (const { number, asked = null, pr = null } of open) {
    const labels = asked === null ? [OBJ] : [OBJ, "pendulum:question"];
    const at = new Date(Date.now() - (asked ?? 60 * MIN)).toISOString();
    issues.set(number, {
      issue: { number, state: "open", body: "", user: PERSON, labels: [...labels] },
      timeline: [
        { event: "labeled", label: { name: OBJ }, actor: PERSON, created_at: new Date(Date.parse(at) - 20 * MIN).toISOString() },
        ...labels.filter((l) => l !== OBJ).map((name) => ({ event: "labeled", label: { name }, actor: self, created_at: at })),
      ],
      comments: asked === null ? [] : [{ id: (ids += 1), user: self, body: `${questionMarker(number, { stage: "work", runId: "1", form: "issue" })}\nQuestion (work): which one?`, created_at: at, updated_at: at }],
      pr: pr === null ? null : { number: number * 10, node_id: `PR_${number}`, state: "open", draft: true, body: pr, head: { ref: `pendulum/${number}` }, labels: [], user: self },
    });
  }
  const reads = [];
  // The AI Gateway's decisions endpoint: each call's input kept, answered by `verdict` (a function of the input). With
  // `cost` set, each answer names a generation whose record (`/v1/generation`) gives that total_cost.
  const gateway = { calls: [], verdict: () => ({ choice: "decision", confidence: 0.9 }), cost: null, lookups: 0 };
  // Writes whose body matches one of `writes` fail with a 500; `permission`: every permission read fails; `jobs`: the
  // Action's live jobs cannot be listed.
  const fail = { writes: [], permission: false, jobs: false };
  // What GitHub reads as each login's permission (anyone else: read). The App's says write: its type alone refuses it.
  const permissions = { [PERSON.login]: "write", [TRIAGER.login]: "triage", [APP.login]: "write", [UNLISTED.login]: "admin" };
  // The Objectives with a review job running on the Action (`review (pendulum/<n>)`).
  const reviewJobs = new Set();
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || "GET";
    const body = init.body ? JSON.parse(init.body) : null;
    if (u.host === "ai-gateway.vercel.sh" && u.pathname === "/v1/generation") {
      gateway.lookups += 1;
      return gateway.cost === null ? new Response("{}", { status: 404 }) : new Response(JSON.stringify({ data: { total_cost: gateway.cost } }), { status: 200 });
    }
    if (u.host === "ai-gateway.vercel.sh") {
      gateway.calls.push(body);
      const v = gateway.verdict(body.input);
      if (v.status) return new Response("{}", { status: v.status });
      const generation = gateway.cost === null ? {} : { "x-generation-id": `gen_FAKE${String(gateway.calls.length).padStart(20, "0")}` };
      return new Response(JSON.stringify({ answers: [{ type: "choice", ...v }] }), { status: 200, headers: { "content-type": "application/json", ...generation } });
    }
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
    const prLine = /^\/issues\/(\d+)\/timeline$/.exec(path);
    if (method === "GET" && prLine) {
      const p = [...issues.values()].map((i) => i.pr).find((x) => x?.number === Number(prLine[1]));
      if (p) return json(p.events || []);
    }
    if (method === "GET" && /^\/issues\/\d+\/comments$/.test(path) && one) return json(one.comments);
    if ((method === "POST" || method === "PATCH") && fail.writes.some((re) => re.test(body?.body || ""))) return json({ message: "Server Error" }, 500);
    if (method === "POST" && /^\/issues\/\d+\/comments$/.test(path) && one) {
      const c = { id: (ids += 1), user: self, body: body.body, created_at: stamp(), updated_at: stamp() };
      one.comments.push(c);
      one.timeline.push({ event: "commented", id: c.id, body: c.body, user: self, actor: self, created_at: c.created_at });
      return json(c, 201);
    }
    const edit = /^\/issues\/comments\/(\d+)$/.exec(path);
    if (method === "PATCH" && edit) {
      const c = [...issues.values()].flatMap((i) => i.comments).find((x) => x.id === Number(edit[1]));
      if (!c) return json({ message: "Not Found" }, 404);
      Object.assign(c, { body: body.body, updated_at: stamp() });
      return json(c);
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
    const perm = /^\/collaborators\/([^/]+)\/permission$/.exec(path);
    if (method === "GET" && perm) return fail.permission ? json({ message: "Server Error" }, 500) : json({ permission: permissions[perm[1]] ?? "read" });
    if (method === "GET" && /^\/actions\/workflows\/[^/]+\/runs$/.test(path)) return fail.jobs ? json({ message: "Server Error" }, 500) : json({ workflow_runs: reviewJobs.size ? [{ id: 1 }] : [] });
    if (method === "GET" && path === "/actions/runs/1/jobs") return json({ jobs: [...reviewJobs].map((n) => ({ name: `review (pendulum/${n})`, status: "in_progress" })) });
    if (method === "GET" && path === "/actions/artifacts") return json({ artifacts: [] });
    if (method === "GET" && path === "/issues/comments") return json([...issues.values()].flatMap((i) => i.comments).filter((c) => c.updated_at >= (u.searchParams.get("since") ?? "")));
    return json({ message: "Not Found" }, 404);
  };
  return {
    fetch,
    reads,
    gateway,
    fail,
    comments: (n) => issues.get(n).comments,
    /** A comment deleted now. */
    drop(n, id) {
      const one = issues.get(n);
      one.comments = one.comments.filter((c) => c.id !== id);
    },
    /** A person editing their comment now. */
    edit(id, text) {
      const c = [...issues.values()].flatMap((i) => i.comments).find((x) => x.id === id);
      Object.assign(c, { body: text, updated_at: stamp() });
    },
    /** A label taken off now, as the dispatcher's requeue does, or by `by`. */
    unlabel(n, name, by = self) {
      const one = issues.get(n);
      one.issue.labels = one.issue.labels.filter((l) => l !== name);
      one.timeline.push({ event: "unlabeled", label: { name }, actor: by, created_at: stamp() });
    },
    timeline: (n) => issues.get(n).timeline,
    /** A person (`by`, the maintainer by default) applying `name` to the issue now. */
    label(n, name, by = PERSON) {
      const one = issues.get(n);
      if (!one.issue.labels.includes(name)) one.issue.labels.push(name);
      one.timeline.push({ event: "labeled", label: { name }, actor: by, created_at: stamp() });
    },
    /** A review job of `n` running on the Action (`on`), or ended. */
    reviewJob(n, on) {
      if (on) reviewJobs.add(n);
      else reviewJobs.delete(n);
    },
    labels: (n) => [...issues.get(n).issue.labels].sort(),
    /** A person marking the PR of `n` ready for review now. */
    ready(n) {
      const p = issues.get(n).pr;
      p.draft = false;
      (p.events ??= []).push({ event: "ready_for_review", actor: PERSON, created_at: stamp() });
    },
    /** Every time on the issue so far moved `ms` into the past, as if it all happened that long ago. */
    age(n, ms) {
      const one = issues.get(n);
      const back = (t) => new Date(Date.parse(t) - ms).toISOString();
      for (const e of one.timeline) e.created_at = back(e.created_at);
      for (const c of one.comments) Object.assign(c, { created_at: back(c.created_at), updated_at: back(c.updated_at) });
    },
    pr: (n) => issues.get(n).pr,
    /** A comment on the issue, `ago` ms back (0: now, after every write so far). */
    comment(n, user, text, ago = 0) {
      const at = ago ? new Date(Date.now() - ago).toISOString() : stamp();
      issues.get(n).comments.push({ id: (ids += 1), user, body: text, created_at: at, updated_at: at });
    },
  };
}

/** A stage's Question exit on `gh`, as the worker applies it (session.mjs applyExit): its PR, if any, and its form. */
async function ask(gh, n, { askOnIssue = false, pr = null, self = BOT, stage = "work" } = {}) {
  const realFetch = globalThis.fetch;
  const saved = process.env.GITHUB_API_URL;
  process.env.GITHUB_API_URL = "https://github.test";
  globalThis.fetch = gh.fetch;
  setSelf(self.login);
  try {
    await applyExit(REPO, { issue: n, pr, exit: "question", reason: "question: which one?", notify: "kirk", stage, askOnIssue }, { token: "t" });
  } finally {
    globalThis.fetch = realFetch;
    setSelf(null);
    if (saved === undefined) delete process.env.GITHUB_API_URL;
    else process.env.GITHUB_API_URL = saved;
  }
}

/** One dispatcher tick on `gh`: the Action's route, or a local loop's (`local`, where Pendulum posts as the person). */
async function tick(gh, { local = false, sandbox = undefined, localStopped = {}, localHeld = {}, readCache = null, key = false, maintainers = undefined } = {}) {
  const { dispatch } = await import("../scripts/dispatch.mjs");
  const realFetch = globalThis.fetch;
  const keys = ["PENDULUM_LOCAL", "PENDULUM_LOCAL_ALL", "GITHUB_API_URL", "GITHUB_RUN_ID", "GITHUB_ACTIONS"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  process.env.GITHUB_API_URL = "https://github.test";
  delete process.env.GITHUB_RUN_ID;
  // The AI Gateway key as local mode keeps it (decider.mjs deciderKeyState), in the fake home; none without `key`.
  delete process.env.GITHUB_ACTIONS;
  gatewayKey(key);
  if (local) Object.assign(process.env, { PENDULUM_LOCAL: "1", PENDULUM_LOCAL_ALL: "1" });
  else {
    delete process.env.PENDULUM_LOCAL;
    delete process.env.PENDULUM_LOCAL_ALL;
  }
  globalThis.fetch = gh.fetch;
  setSelf(local ? PERSON.login : BOT.login);
  try {
    return await dispatch({ repo: REPO.full, objectiveLabel: OBJ, maxConcurrent: 5, dailyUsd: 0, ciChecks: [], timeoutMinutes: 60, notify: "kirk", ...(sandbox ? { sandbox } : {}), ...(maintainers ? { maintainers } : {}) }, { token: "t", localStopped, localHeld, readCache });
  } finally {
    globalThis.fetch = realFetch;
    setSelf(null);
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

/** Local mode's AI Gateway key file in the fake home (temp.mjs), there or not. */
function gatewayKey(on) {
  const dir = join(homedir(), ".config", "pendulum");
  if (!on) return rmSync(join(dir, "ai-gateway-key"), { force: true });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, "ai-gateway-key"), "k\n", { mode: 0o600 });
}

const PR_BODY = "## Assumptions\n- the simplest reading";

test("Actions without a sandbox: a maintainer's comment after an issue Question requeues it at the next tick; Pendulum's own, a stranger's or an earlier one does not", async () => {
  const gh = fakeGitHub([{ number: 7 }]);
  gh.comment(7, PERSON, "an earlier thought, before the Question", 40 * MIN);
  await ask(gh, 7);
  gh.comment(7, STRANGER, "use the second one");
  gh.comment(7, BOT, "<!-- pendulum:7:progress:1 -->\nPendulum's progress");
  const before = await tick(gh);
  assert.deepEqual(before.answered, [], "no trusted answer since the Question");
  assert.deepEqual(gh.labels(7), [OBJ, "pendulum:question"].sort());

  gh.comment(7, PERSON, "use the second one");
  const r = await tick(gh);
  assert.deepEqual(r.answered, [7]);
  assert.ok(r.ready.includes(7), "picked in the same tick");
  assert.ok(!gh.labels(7).includes("pendulum:question"), "no longer a Question");
});

test("local loop: Pendulum's own comments, posted as the person's login, never answer; the person's answer releases the stop and requeues it", async () => {
  const gh = fakeGitHub([{ number: 7 }], { self: PERSON });
  await ask(gh, 7, { self: PERSON });
  gh.comment(7, PERSON, "<!-- pendulum:7:progress:1 -->\nPendulum's progress, as the person's login");
  const stopped = { 7: "its stage here ended with a Question" };
  const held = await tick(gh, { local: true, localStopped: stopped });
  assert.deepEqual([held.answered, held.released, held.ready], [[], [], []]);
  assert.ok(gh.labels(7).includes("pendulum:question"));

  gh.comment(7, PERSON, "use the second one");
  const reviewing = await tick(gh, { local: true, localStopped: stopped, localHeld: { 7: "its review runs on this box" } });
  assert.deepEqual(reviewing.answered, [], "a stage of it running on this box decides first");
  const r = await tick(gh, { local: true, localStopped: stopped });
  assert.deepEqual(r.answered, [7]);
  assert.deepEqual(r.released, [7], "the loop's stop is released by the answer");
  assert.ok(r.ready.includes(7), "picked");
  assert.ok(!gh.labels(7).includes("pendulum:question"));
});

test("review: a person's ready mark while the Objective is Queued or Running starts no review; a Question's, an In-review one's or Pendulum's own does", () => {
  const issue = (...labels) => ({ number: 7, labels: [OBJ, ...labels].map((name) => ({ name })) });
  const ready = { action: "ready_for_review", sender: PERSON };
  assert.match(workOwnsBranch({ ...ready, issue: issue("pendulum:running") }), /Running: its work stage owns pendulum\/7/);
  assert.match(workOwnsBranch({ ...ready, issue: issue() }), /Queued/);
  assert.equal(workOwnsBranch({ ...ready, issue: issue("pendulum:question") }), null, "the answer to a Question");
  assert.equal(workOwnsBranch({ ...ready, issue: issue("pendulum:in-review") }), null);
  assert.equal(workOwnsBranch({ action: "ready_for_review", sender: BOT, issue: issue("pendulum:running") }), null, "Pendulum's own mark");
  assert.equal(workOwnsBranch({ action: null, issue: issue("pendulum:running") }), null, "the review label the worker applies while it is still Running");
});

// The answer check (#398): whether the writer comments since a Question give a decision on it is a decision call. Each
// one is asked through the real decider (decider.mjs): on the AI Gateway, whose endpoint the fake GitHub answers, or on
// a stage's harness, a fake CLI on PATH.
const verdictFor = (gh, byBody) => {
  gh.gateway.verdict = (input) => {
    for (const [text, v] of Object.entries(byBody)) if (input.includes(text)) return v;
    return { choice: "decision", confidence: 0.9 };
  };
};
const NO = { choice: "no_decision", confidence: 0.92 };
const YES = { choice: "decision", confidence: 0.9 };
const unanswered = (gh, n) => gh.comments(n).filter((c) => /^<!-- pendulum:\d+:question:unanswered:/.test(c.body));
const answeredRecords = (gh, n) => gh.comments(n).filter((c) => /^<!-- pendulum:\d+:answered:/.test(c.body));

/** `fn` with the fake GitHub as the API and Pendulum's login set, as a stage runs. */
async function onGitHub(gh, fn, self = BOT) {
  const realFetch = globalThis.fetch;
  const saved = process.env.GITHUB_API_URL;
  process.env.GITHUB_API_URL = "https://github.test";
  globalThis.fetch = gh.fetch;
  setSelf(self.login);
  try {
    return await fn();
  } finally {
    globalThis.fetch = realFetch;
    setSelf(null);
    if (saved === undefined) delete process.env.GITHUB_API_URL;
    else process.env.GITHUB_API_URL = saved;
  }
}

/** A home of its own with an AI Gateway key file (local mode's), for a stage's decider; without `key`, none. */
function stageHome(name, key = true) {
  const home = join(homedir(), name);
  mkdirSync(join(home, ".config", "pendulum"), { recursive: true, mode: 0o700 });
  if (key) writeFileSync(join(home, ".config", "pendulum", "ai-gateway-key"), "k\n", { mode: 0o600 });
  return home;
}

/**
 * The work stage's answer check as worker.mjs runs it first thing (answerGuard): its real settle, reopen and Block, with
 * `finish` kept. `check` is the stage's decider. Returns {ended, finished}.
 */
async function workStage(gh, n, check, { prepare = null } = {}) {
  const { answerGuard } = await import("../scripts/worker.mjs");
  const { objectiveDecisions } = await import("../scripts/lib/session.mjs");
  const { resetStageStop } = await import("../scripts/lib/stop.mjs");
  resetStageStop();
  const finished = [];
  const ended = await onGitHub(gh, () =>
    answerGuard({ repo: REPO, issue: n, check, decisions: () => objectiveDecisions(REPO, { issue: n }, { token: "t" }), label: OBJ, opts: { token: "t" }, prepare, notify: "kirk", finish: async (exit, reason) => finished.push({ exit, reason }) }),
  );
  return { ended, finished };
}

test("dispatcher with an AI Gateway key: a comment that gives no decision keeps the Question open, said once; a decision requeues it and is recorded", async () => {
  const gh = fakeGitHub([{ number: 7 }]);
  await ask(gh, 7);
  verdictFor(gh, { "use the second one": YES, "back tomorrow": NO });
  gh.comment(7, PERSON, "thanks, I'll look at this when I'm back tomorrow");
  const held = await tick(gh, { key: true });
  assert.deepEqual(held.answered, [], "no decision: the Question stays open");
  assert.ok(gh.labels(7).includes("pendulum:question"));
  assert.equal(gh.gateway.calls.length, 1);
  assert.equal(gh.gateway.calls[0].questions[0].name, "question_answered");
  assert.match(gh.gateway.calls[0].input, /Question \(work\): which one\?/, "given the Question as Pendulum's notice asked it");
  assert.match(gh.gateway.calls[0].input, /back tomorrow/, "and the comment");
  assert.equal(unanswered(gh, 7).length, 1, "the notice says so");
  assert.match(unanswered(gh, 7)[0].body, /does not give a decision on the Question/);

  const again = await tick(gh, { key: true });
  assert.deepEqual(again.answered, []);
  assert.equal(gh.gateway.calls.length, 1, "a comment judged once is not asked about again");
  assert.equal(unanswered(gh, 7).length, 1, "and the notice is not posted again");

  gh.comment(7, PERSON, "use the second one");
  const r = await tick(gh, { key: true });
  assert.deepEqual(r.answered, [7], "a decision resumes the work");
  assert.equal(gh.gateway.calls.length, 2);
  assert.match(gh.gateway.calls[1].input, /Comment 1 of 2[^]*back tomorrow[^]*Comment 2 of 2[^]*use the second one/, "each writer comment since the Question, oldest first");
  assert.equal(answeredRecords(gh, 7).length, 1, "the decision is recorded for the work stage");
  assert.ok(!gh.labels(7).includes("pendulum:question"));

  // The work stage it resumes finds that record and asks nothing, on its own decider.
  const { openAnswerCheck } = await import("../scripts/lib/answer-check.mjs");
  const { ended } = await workStage(gh, 7, openAnswerCheck({ inputs: {}, env: {}, home: stageHome("dispatcher-judged") }));
  assert.equal(ended, false, "the stage goes on");
  assert.equal(gh.gateway.calls.length, 2, "no second call for the same comment");
});

test("#479 dispatcher: an answer check's gateway call outside any stage is carried by the notice or record it writes, where daily_usd reads it; one the gateway gives no cost for is unknown", async () => {
  const { todaysSpend } = await import("../scripts/dispatch.mjs");
  const { decisionSpendEntries } = await import("../scripts/lib/logic.mjs");
  const today = new Date().toISOString().slice(0, 10);
  const gh = fakeGitHub([{ number: 47 }, { number: 48 }]);
  await ask(gh, 47);
  await ask(gh, 48);
  verdictFor(gh, { "use the second one": YES, "back tomorrow": NO });
  gh.gateway.cost = 0.0031;
  gh.comment(47, PERSON, "thanks, I'll look at this when I'm back tomorrow");
  const writes = gh.comments(47).length;
  await tick(gh, { key: true });
  assert.equal(gh.gateway.calls.length, 1);
  assert.equal(gh.gateway.lookups, 1, "the call's generation looked up");
  const [notice] = unanswered(gh, 47);
  assert.deepEqual(decisionSpendEntries(notice.body), [{ date: today, calls: 1, usd: 0.0031 }], "the unanswered notice carries the call");
  assert.equal(gh.comments(47).length, writes + 1, "no comment beside the notice");
  assert.equal(decisionsComments(gh, 47).length, 0);
  const spent = await onGitHub(gh, () => todaysSpend(REPO, { dailyUsd: 10 }, { token: "t" }));
  assert.ok(Math.abs(spent.spentToday - 0.0031) < 1e-9);
  assert.equal(spent.unknownToday, 0);
  const { localSpendToday } = await import("../scripts/lib/github.mjs");
  assert.deepEqual((await onGitHub(gh, () => localSpendToday(REPO, { token: "t" }))).byBilling, { api: 0.0031 }, "billed to the gateway key: `api`");
  // A call the gateway gives no cost for (no generation named) is unknown, carried by the answered record; the screen goes on.
  gh.gateway.cost = null;
  gh.comment(47, PERSON, "use the second one");
  assert.deepEqual((await tick(gh, { key: true })).answered, [47], "an unknown cost never stops the screen");
  // Its line says why (#565): the gateway answered and gave no cost.
  assert.deepEqual(decisionSpendEntries(answeredRecords(gh, 47)[0].body), [{ date: today, calls: 1, usd: 0, usdUnknown: 1, usdUnknownWhy: ["decision-no-cost"] }]);
  const later = await onGitHub(gh, () => todaysSpend(REPO, { dailyUsd: 10 }, { token: "t" }));
  assert.ok(Math.abs(later.spentToday - 0.0031) < 1e-9);
  assert.equal(later.unknownToday, 1);
  // A stranger's paste of a decision-spend line counts nothing.
  gh.comment(48, STRANGER, `<!-- pendulum:48:decisions:dispatcher -->\n<!-- pendulum:decision-spend {"date":"${today}","calls":1,"usd":100} -->`);
  const pasted = await onGitHub(gh, () => todaysSpend(REPO, { dailyUsd: 10 }, { token: "t" }));
  assert.ok(Math.abs(pasted.spentToday - 0.0031) < 1e-9);
});

const decisionsComments = (gh, n) => gh.comments(n).filter((c) => new RegExp(`^<!-- pendulum:${n}:decisions:dispatcher -->\n`).test(c.body));

test("#479 a decisions comment's write: one gone by the write (PATCH 404) is posted again; a write that landed but lost its answer is not added twice", async () => {
  const { decisionSpendEntries } = await import("../scripts/lib/logic.mjs");
  const { bookDecisionSpend, decisionsMarker, flushDecisionSpend } = await import("../scripts/lib/decision-spend.mjs");
  const today = new Date().toISOString().slice(0, 10);
  const mark = decisionsMarker(50, "serve");
  // A GitHub of one issue's comments, as `api` (rest, listComments): `onPatch` decides each edit's fate.
  const github = (comments, onPatch) => {
    const posts = [];
    return {
      posts,
      comments,
      api: {
        listComments: async () => comments.map((c) => ({ ...c })),
        rest: async (path, { method, body }) => {
          if (method === "POST") {
            const c = { id: 900 + posts.length, user: PERSON, body: body.body };
            posts.push(c);
            comments.push(c);
            return c;
          }
          return onPatch(Number(/(\d+)$/.exec(path)[1]), body.body);
        },
      },
    };
  };
  setSelf(PERSON.login);
  try {
    // Gone between the read and the write: posted again with the days the read held.
    const held = `${mark}\n<!-- pendulum:decision-spend {"date":"${today}","calls":1,"usd":0.001} -->`;
    const gone = github([{ id: 1, user: PERSON, body: held }], async () => {
      throw Object.assign(new Error("Not Found"), { status: 404 });
    });
    bookDecisionSpend({ issue: 50, repo: REPO.full }, { calls: 1, settled: Promise.resolve({ usd: 0.002 }) });
    await flushDecisionSpend(REPO, { token: "t" }, { role: "serve", api: gone.api });
    assert.equal(gone.posts.length, 1);
    assert.ok(gone.posts[0].body.startsWith(`${mark}\n`));
    assert.deepEqual(decisionSpendEntries(gone.posts[0].body), [{ date: today, calls: 2, usd: 0.003 }]);
    // The edit lands, then its answer is lost (a 502): a fresh read shows the body sent, so it is not tried again.
    const lost = github([{ id: 2, user: PERSON, body: held }], async (id, body) => {
      lost.comments.find((c) => c.id === id).body = body;
      throw Object.assign(new Error("Bad Gateway"), { status: 502 });
    });
    bookDecisionSpend({ issue: 50, repo: REPO.full }, { calls: 1, settled: Promise.resolve({ usd: 0.002 }) });
    await flushDecisionSpend(REPO, { token: "t" }, { role: "serve", api: lost.api });
    assert.equal(lost.posts.length, 0);
    assert.deepEqual(decisionSpendEntries(lost.comments[0].body), [{ date: today, calls: 2, usd: 0.003 }], "added once");
    // An edit that did not land is tried once more from a fresh read.
    let tries = 0;
    const flaky = github([{ id: 3, user: PERSON, body: held }], async (id, body) => {
      tries += 1;
      if (tries === 1) throw Object.assign(new Error("Bad Gateway"), { status: 502 });
      flaky.comments.find((c) => c.id === id).body = body;
      return {};
    });
    bookDecisionSpend({ issue: 50, repo: REPO.full }, { calls: 1, settled: Promise.resolve({ usd: 0.002 }) });
    await flushDecisionSpend(REPO, { token: "t" }, { role: "serve", api: flaky.api });
    assert.equal(tries, 2);
    assert.deepEqual(decisionSpendEntries(flaky.comments[0].body), [{ date: today, calls: 2, usd: 0.003 }]);
  } finally {
    setSelf(null);
  }
});

test("work stage, the real wiring: with nothing judged before, a no decision commits the exit, puts the Objective back to Question with one notice and ends it held; a relaunch, a re-applied label or a send-back asks nothing", async () => {
  const { openAnswerCheck } = await import("../scripts/lib/answer-check.mjs");
  const { stopHold } = await import("../scripts/lib/local.mjs");
  const gh = fakeGitHub([{ number: 7, pr: PR_BODY }]);
  await ask(gh, 7, { pr: gh.pr(7), askOnIssue: true });
  gh.comment(7, PERSON, "busy this week");
  // The dispatcher has no key (an Actions dispatch job never has one): it requeues, as a writer's comment always did.
  assert.deepEqual((await tick(gh)).answered, [7]);
  assert.equal(gh.gateway.calls.length, 0);
  const check = () => openAnswerCheck({ inputs: {}, env: {}, home: stageHome("work-stage") });

  gh.gateway.verdict = () => NO;
  const { ended, finished } = await workStage(gh, 7, check());
  assert.equal(ended, true);
  assert.equal(gh.gateway.calls.length, 1);
  assert.deepEqual(finished.map((f) => f.exit), ["question"], "the stage ends with a Question");
  assert.ok(stopHold({ exit: finished[0].exit }), "which a local loop holds for an answer");
  assert.ok(gh.labels(7).includes("pendulum:question"), "back to Question");
  assert.equal(unanswered(gh, 7).length, 1, "the notice says so once");
  assert.deepEqual((await tick(gh)).answered, [], "the comment it judged is from before the Question asked again");
  gh.comment(7, PERSON, "go with the second one");
  assert.deepEqual((await tick(gh)).answered, [7], "a new comment resumes it (its notice is dated after the label, PR or not), for the stage to judge");

  gh.gateway.verdict = () => YES;
  assert.equal((await workStage(gh, 7, check())).ended, false, "a decision: the stage goes on");
  assert.equal(gh.gateway.calls.length, 2);
  assert.equal(answeredRecords(gh, 7).length, 1, "and is recorded");
  assert.equal((await workStage(gh, 7, check())).ended, false, "a relaunch, a new stint or a continued local pause finds the record");
  assert.equal(gh.gateway.calls.length, 2, "and asks nothing");

  // A person re-applying the label is a go; a send-back's stage follows an In review: neither resumes a Question.
  gh.label(7, OBJ);
  gh.comment(7, PERSON, "hmm, not sure");
  assert.equal((await workStage(gh, 7, check())).ended, false);
  const sentBack = fakeGitHub([{ number: 9 }]);
  await ask(sentBack, 9);
  sentBack.comment(9, PERSON, "hmm, not sure");
  sentBack.label(9, "pendulum:in-review");
  assert.equal((await workStage(sentBack, 9, check())).ended, false);
  assert.equal(gh.gateway.calls.length + sentBack.gateway.calls.length, 2, "neither asks");

  // No decider (`decision_route` off): today's rule, nothing asked.
  const off = fakeGitHub([{ number: 10 }]);
  await ask(off, 10);
  off.comment(10, PERSON, "hmm");
  assert.equal((await workStage(off, 10, openAnswerCheck({ inputs: { decisionRoute: "off" }, env: {}, home: stageHome("work-stage") }))).ended, false);
  assert.equal(off.gateway.calls.length, 0);
});

test("#605: on the launcher, a MEMBER's comment wakes a Question only when their permission reads as write: a read- or triage-role member's does not", async () => {
  const { launchOne } = await import("../scripts/launch.mjs");
  const gh = fakeGitHub([{ number: 7 }]);
  await ask(gh, 7);
  const realFetch = globalThis.fetch;
  const keys = ["GITHUB_API_URL", "GITHUB_ACTIONS", "GITHUB_RUN_ID"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  process.env.GITHUB_API_URL = "https://github.test";
  delete process.env.GITHUB_ACTIONS;
  delete process.env.GITHUB_RUN_ID;
  globalThis.fetch = gh.fetch;
  setSelf(BOT.login);
  // The association GitHub shows any organization member; only TRIAGER's and UNLISTED's permission reads tell them apart.
  const launch = (user) => {
    gh.comment(7, user, "go with the second one");
    const c = gh.comments(7).at(-1);
    return launchOne({ inputs: { repo: REPO.full, appToken: "t", objectiveLabel: OBJ, timeoutMinutes: 60, ciChecks: [], maintainers: [] }, eventName: "issue_comment", payload: { action: "created", issue: { number: 7 }, comment: { ...c, author_association: "MEMBER" } } });
  };
  try {
    const triager = await launch(TRIAGER);
    assert.equal(triager.exit, "skipped", JSON.stringify(triager));
    assert.match(triager.reason, /not a maintainer/);
    assert.ok(gh.labels(7).includes("pendulum:question"));
    const writer = await launch(UNLISTED);
    assert.equal(writer.exit, "queued", JSON.stringify(writer));
    assert.ok(!gh.labels(7).includes("pendulum:question"));
  } finally {
    globalThis.fetch = realFetch;
    setSelf(null);
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/**
 * One tick of the real serve (local.mjs) on `gh`, as the person's login: its own pendingReviews and dispatch, with a stage
 * recorded instead of run (`started`: each stage it starts, `work` or `review`, by issue).
 */
async function serveTick(gh) {
  const { Local } = await import("../scripts/local.mjs");
  const { fakeProc } = await import("./fixtures/machine.mjs");
  const realFetch = globalThis.fetch;
  const keys = ["PENDULUM_LOCAL", "PENDULUM_LOCAL_ALL", "GITHUB_API_URL", "GITHUB_RUN_ID", "GITHUB_ACTIONS"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  Object.assign(process.env, { GITHUB_API_URL: "https://github.test", PENDULUM_LOCAL: "1", PENDULUM_LOCAL_ALL: "1" });
  delete process.env.GITHUB_RUN_ID;
  delete process.env.GITHUB_ACTIONS;
  gatewayKey(false);
  globalThis.fetch = gh.fetch;
  setSelf(PERSON.login);
  const started = [];
  const scratch = mkdtempSync(join(tmpdir(), "serve-"));
  const loop = Object.assign(Object.create(Local.prototype), {
    repo: REPO,
    repoFull: REPO.full,
    token: "t",
    notice: null,
    wf: { PENDULUM_LOCAL_MAX_CONCURRENT: "2" },
    machine: { home: join(scratch, "home"), proc: fakeProc(join(scratch, "proc")) },
    opts: { token: "t" },
    children: new Set(),
    baseEnv: () => ({ PENDULUM_LOCAL_ALL: "1", PENDULUM_INPUT_MAX_CONCURRENT: "2" }),
    cleanup: async () => {},
    pausedHere: async () => [],
    withClaim: (n, fn) => fn(),
    runObjective: async (n) => (started.push({ n, stage: "work" }), { exit: "delivered" }),
    review: async (n) => (started.push({ n, stage: "review" }), { exit: "delivered" }),
  });
  try {
    await loop.serve({ once: true, intervalMs: 5 });
  } finally {
    globalThis.fetch = realFetch;
    setSelf(null);
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return started;
}

test("#446 local loop: a review-stage Question answered, its PR marked ready and its label re-applied 36 s later runs its work stage at the next tick, its Question label off; no review beside it", async () => {
  const gh = fakeGitHub([{ number: 7, pr: PR_BODY }], { self: PERSON });
  gh.label(7, "pendulum:in-review");
  await ask(gh, 7, { pr: gh.pr(7), self: PERSON, stage: "review" });
  assert.ok(gh.labels(7).includes("pendulum:question"));
  // The Question 36 s ago; the person answers, marks the PR ready, and takes the Objective label off and on again.
  gh.age(7, 36_000);
  gh.comment(7, PERSON, "hand it off, marked", 6_000);
  gh.ready(7);
  gh.unlabel(7, OBJ);
  gh.label(7, OBJ);
  assert.deepEqual(await serveTick(gh), [{ n: 7, stage: "work" }], "the work stage reruns, and no review of the ready mark holds it");
  assert.ok(!gh.labels(7).includes("pendulum:question"), "the stale Question label is off");

  // A ready mark with the writer's answer and no re-applied label is the review's to answer (#339), as before.
  const ready = fakeGitHub([{ number: 8, pr: PR_BODY }], { self: PERSON });
  ready.label(8, "pendulum:in-review");
  await ask(ready, 8, { pr: ready.pr(8), self: PERSON, stage: "review" });
  ready.comment(8, PERSON, "hand it off, marked");
  ready.ready(8);
  assert.deepEqual(await serveTick(ready), [{ n: 8, stage: "review" }]);
});

/** The review job's start check on `gh` (review.mjs readyOwner), as the job runs it on a person's ready mark: its writers read first. */
async function readyCheck(gh, n) {
  const { getIssue, primeWriters } = await import("../scripts/lib/github.mjs");
  const realFetch = globalThis.fetch;
  const saved = process.env.GITHUB_API_URL;
  process.env.GITHUB_API_URL = "https://github.test";
  globalThis.fetch = gh.fetch;
  setSelf(BOT.login);
  try {
    const opts = { token: "t" };
    await primeWriters(REPO, opts);
    return await readyOwner({ repo: REPO, action: "ready_for_review", sender: PERSON, issue: await getIssue(REPO, n, opts), label: OBJ, opts });
  } finally {
    globalThis.fetch = realFetch;
    setSelf(null);
    if (saved === undefined) delete process.env.GITHUB_API_URL;
    else process.env.GITHUB_API_URL = saved;
  }
}

/** Pendulum's notes on `n` that a re-apply was not taken. */
const refusals = (gh, n) => gh.comments(n).filter((c) => /^<!-- pendulum:\d+:relabel-refused:/.test(c.body));

test("#448 Actions: a Question's PR marked ready and its label re-applied by a writer in one tick: the review job stands down, the dispatcher waits for it, then only the worker starts", async () => {
  const gh = fakeGitHub([{ number: 7, pr: PR_BODY }]);
  await ask(gh, 7, { pr: gh.pr(7) });
  gh.age(7, 36_000);
  gh.comment(7, PERSON, "hand it off");
  // Both events: the ready mark (its review job starts) and the label taken off and on again.
  gh.ready(7);
  gh.reviewJob(7, true);
  gh.unlabel(7, OBJ);
  gh.label(7, OBJ);
  assert.match(await readyCheck(gh, 7), /re-applied since the Question: its work stage runs again on pendulum\/7/, "the review job ends at once");
  const during = await tick(gh);
  assert.ok(!during.ready.includes(7), "no worker while its review job still runs");
  assert.ok(gh.labels(7).includes("pendulum:question"), "nothing changed on it yet");
  assert.ok(during.deadlines.some((d) => d.kind === "retry"), "looked at again soon");
  gh.reviewJob(7, false);
  const after = await tick(gh);
  assert.ok(after.ready.includes(7), "the worker gets it once the review job has ended");
  assert.ok(!gh.labels(7).includes("pendulum:question"));
  assert.deepEqual(refusals(gh, 7), []);

  // A ready mark with no re-applied label is the review's to answer (#339): the check lets it run.
  const plain = fakeGitHub([{ number: 8, pr: PR_BODY }]);
  await ask(plain, 8, { pr: plain.pr(8) });
  plain.ready(8);
  assert.equal(await readyCheck(plain, 8), null);
});

test("#449 dispatcher: a re-applied pendulum:objective requeues a Question only from a person who can push; a triager's or an App's changes nothing and is said once", async () => {
  for (const local of [false, true]) {
    const self = local ? PERSON : BOT;
    const gh = fakeGitHub(
      [7, 8, 9].map((number) => ({ number, pr: PR_BODY })),
      { self },
    );
    for (const n of [7, 8, 9]) {
      await ask(gh, n, { pr: gh.pr(n), self });
      gh.age(n, 36_000);
      gh.unlabel(n, OBJ);
    }
    gh.label(7, OBJ, TRIAGER);
    gh.label(8, OBJ, APP);
    gh.label(9, OBJ, PERSON);
    const r = await tick(gh, { local });
    const route = local ? "local loop" : "Action";
    assert.ok(r.ready.includes(9) && !gh.labels(9).includes("pendulum:question"), `${route}: the writer's re-apply requeues it`);
    for (const [n, who] of [
      [7, TRIAGER],
      [8, APP],
    ]) {
      assert.ok(!r.ready.includes(n), `${route}: #${n} by ${who.login} not picked`);
      assert.ok(gh.labels(n).includes("pendulum:question"), `${route}: #${n} stays a Question`);
      const said = refusals(gh, n);
      assert.equal(said.length, 1, `${route}: #${n} one note`);
      const line = `\`pendulum:objective\` re-applied by ${who.login} was not taken, so the Objective stays Question`;
      assert.ok(said[0].body.includes(line), `${route}: #${n} names who: ${said[0].body}`);
    }
    // The next tick changes nothing and says nothing more: the note is on the timeline it reads.
    const posts = gh.comments(7).length + gh.comments(8).length;
    const again = await tick(gh, { local });
    assert.ok(!again.ready.includes(7) && !again.ready.includes(8));
    assert.equal(gh.comments(7).length + gh.comments(8).length, posts, `${route}: said once`);
    assert.deepEqual(refusals(gh, 9), []);
  }
});

/** A Question (its PR's) on `gh`'s Objective `n`, its Objective label then taken off: the next label is the re-apply. */
async function questionToReapply(gh, n, { self = BOT } = {}) {
  await ask(gh, n, { pr: gh.pr(n), self });
  gh.age(n, 36_000);
  gh.unlabel(n, OBJ);
}

test("#449 restart: pendulum:restart applied by an App is refused and taken off with its note; a maintainer pinned by id re-applies pendulum:objective", async () => {
  const gh = fakeGitHub([{ number: 7, pr: PR_BODY }, { number: 8, pr: PR_BODY }]);
  gh.label(7, "pendulum:restart", APP);
  await questionToReapply(gh, 8);
  gh.label(8, OBJ, PINNED);
  try {
    const r = await tick(gh, { maintainers: ["pinned#4242"] });
    assert.deepEqual(r.restarted, []);
    assert.ok(!gh.labels(7).includes("pendulum:restart"), "the App's restart label is taken off");
    assert.ok(gh.comments(7).some((c) => /restart-refused/.test(c.body) && /applied by helper-app\[bot\] was ignored/.test(c.body)));
    assert.ok(r.ready.includes(8) && !gh.labels(8).includes("pendulum:question"), "the pinned maintainer's re-apply requeues it");
  } finally {
    await tick(fakeGitHub([]), { maintainers: [] });
  }
});

test("#449 the newest start decides, in the pick and in requeuedIn alike: a writer's go, then a triager's remove and re-apply, is refused", async () => {
  const { requeuedIn } = await import("../scripts/lib/stop.mjs");
  const at = (m) => new Date(Date.parse("2026-11-15T10:00:00Z") + m * MIN).toISOString();
  const ev = (event, name, m, actor) => ({ event, label: { name }, actor, created_at: at(m) });
  const trusted = async (actor) => actor?.login === PERSON.login;
  const events = [ev("labeled", OBJ, 0, PERSON), ev("labeled", "pendulum:question", 1, BOT), ev("labeled", OBJ, 2, PERSON), ev("unlabeled", OBJ, 3, TRIAGER), ev("labeled", OBJ, 4, TRIAGER)];
  const go = await requeuedIn(events, OBJ, trusted);
  assert.deepEqual([go.requeued, go.refused.map((r) => r.actor.login)], [false, ["triager"]], "the triager's re-apply is the go that decides");
  assert.equal((await requeuedIn(events.slice(0, 3), OBJ, trusted)).requeued, true, "the writer's alone requeues");

  // Through the dispatcher: a Question the writer re-applied, then the triager took off and on again.
  const q = fakeGitHub([{ number: 7, pr: PR_BODY }]);
  await questionToReapply(q, 7);
  q.label(7, OBJ, PERSON);
  q.unlabel(7, OBJ, TRIAGER);
  q.label(7, OBJ, TRIAGER);
  const r = await tick(q);
  assert.ok(!r.ready.includes(7) && q.labels(7).includes("pendulum:question"), "stays a Question");
  assert.equal(refusals(q, 7).length, 1);
  // And a Queued one the writer labelled, then the triager took off and on again: held at its pick, the same way.
  const p = fakeGitHub([{ number: 8 }]);
  p.unlabel(8, OBJ, TRIAGER);
  p.label(8, OBJ, TRIAGER);
  assert.ok(!(await tick(p)).ready.includes(8));
  assert.equal(refusals(p, 8).length, 1);
});

