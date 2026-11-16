// A Question asked on the issue (no PR, or the plan-time Question its PR body does not ask) says "answer in a comment on
// the issue" (#344). On every route a trusted answer there puts it back in the queue at the next tick: the dispatcher's
// answered pass, which only the sandbox route ran. Each tick is the real dispatch() against one fake GitHub whose
// labels, timelines and comments persist between ticks, with ETags, so a read can be conditional.
import "./temp.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { RETRY } from "../scripts/lib/github.mjs";
import { asksQuestion, marker, setSelf } from "../scripts/lib/logic.mjs";
import { questionNotice } from "../scripts/lib/session.mjs";

RETRY.sleep = async () => {};

const BOT = { login: "factory-app[bot]", type: "Bot" };
const PERSON = { login: "maintainer", type: "User" };
const STRANGER = { login: "passer-by", type: "User" };
const REPO = { owner: "acme", name: "app", full: "acme/app" };
const OBJ = "factory:objective";
const MIN = 60_000;

/**
 * One repository: Objectives asked a Question `asked` ago (its factory:question label), each with an optional open PR
 * on factory/<n> (`pr`: its body). Pages carry an ETag; a request whose If-None-Match matches gets a 304.
 */
function fakeGitHub(open, { self = BOT } = {}) {
  let last = 0;
  const stamp = () => new Date((last = Math.max(Date.now(), last + 1))).toISOString();
  const issues = new Map();
  let ids = 1000;
  for (const { number, labels = [OBJ, "factory:question"], asked = 30 * MIN, pr = null } of open) {
    const at = new Date(Date.now() - asked).toISOString();
    issues.set(number, {
      issue: { number, state: "open", body: "", user: PERSON, labels: [...labels] },
      timeline: [
        { event: "labeled", label: { name: OBJ }, actor: PERSON, created_at: new Date(Date.parse(at) - 20 * MIN).toISOString() },
        ...labels.filter((l) => l !== OBJ).map((name) => ({ event: "labeled", label: { name }, actor: self, created_at: at })),
      ],
      // Factory's own Question notice, made as the Question was asked.
      comments: [{ id: (ids += 1), user: self, body: `${marker(number, "question", "work:1")}\nQuestion (work): which one? Answer in a comment on the issue.`, created_at: at, updated_at: at }],
      pr: pr === null ? null : { number: number * 10, state: "open", draft: true, body: pr, head: { ref: `factory/${number}` }, labels: [] },
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
    /** A comment on the issue, `ago` ms back (0: now). */
    comment(n, user, text, ago = 0) {
      const at = new Date(Date.now() - ago).toISOString();
      issues.get(n).comments.push({ id: (ids += 1), user, body: text, created_at: at, updated_at: at });
    },
  };
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

test("the notice a Question with no PR posts tells the person to answer in a comment on the issue", () => {
  assert.match(questionNotice({ stage: "work", reason: "question: which one?" }), /Answer in a comment on the issue\.$/);
  assert.match(questionNotice({ stage: "work", reason: "which one?", pr: { number: 70 }, askOnIssue: true }), /answer here on the issue, not by marking it ready/);
  assert.equal(asksQuestion("## Assumptions\n- QUESTION: which one?"), true);
  assert.equal(asksQuestion("## Assumptions\n- the simplest reading"), false);
});

test("Actions without a sandbox: a maintainer's comment after an issue Question requeues it at the next tick; Factory's own, a stranger's or an earlier one does not", async () => {
  const gh = fakeGitHub([{ number: 7 }]);
  gh.comment(7, PERSON, "an earlier thought, before the Question", 40 * MIN);
  gh.comment(7, STRANGER, "use the second one", 5 * MIN);
  gh.comment(7, BOT, `${marker(7, "progress", "1")}\nFactory's progress`, 4 * MIN);
  const before = await tick(gh);
  assert.deepEqual(before.answered, [], "no trusted answer since the Question");
  assert.deepEqual(gh.labels(7), [OBJ, "factory:question"].sort());

  gh.comment(7, PERSON, "use the second one");
  const r = await tick(gh);
  assert.deepEqual(r.answered, [7]);
  assert.ok(r.ready.includes(7), "picked in the same tick");
  assert.ok(!gh.labels(7).includes("factory:question"), "no longer a Question");
});

test("Actions without a sandbox: a Question its PR asks waits for the ready mark; one asked on the issue with a PR (plan time) resumes on the comment", async () => {
  const gh = fakeGitHub([
    { number: 8, pr: "## Assumptions\n- QUESTION: change the exported type?" },
    { number: 9, pr: "## Assumptions\n- the simplest reading" },
  ]);
  gh.comment(8, PERSON, "yes, change it");
  gh.comment(9, PERSON, "do it in this repository alone");
  const r = await tick(gh);
  assert.deepEqual(r.answered, [9]);
  assert.ok(gh.labels(8).includes("factory:question"), "the PR's Question waits for the PR to be marked ready");
  assert.ok(!gh.labels(9).includes("factory:question"));
});

test("local loop: Factory's own comments, posted as the person's login, never answer; the person's answer releases the stop and requeues it", async () => {
  const gh = fakeGitHub([{ number: 7 }], { self: PERSON });
  gh.comment(7, PERSON, `${marker(7, "progress", "1")}\nFactory's progress, as the person's login`, 2 * MIN);
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
  const gh = fakeGitHub([{ number: 7 }]);
  const readCache = new Map();
  await tick(gh, { readCache });
  const first = gh.reads.length;
  await tick(gh, { readCache });
  const second = gh.reads.slice(first).filter((r) => /^\/issues\/7\/(timeline|comments)$/.test(r.path) || r.path === "/pulls");
  assert.ok(second.length >= 3, `the Question's timeline, comments and PR are read: ${JSON.stringify(second)}`);
  assert.ok(second.every((r) => r.conditional && r.unchanged), `each one a 304: ${JSON.stringify(second)}`);
});

test("the sandbox route keeps its rule: any Question a maintainer answered past the launch's grace is requeued, its PR's too", async () => {
  const gh = fakeGitHub([{ number: 8, pr: "## Assumptions\n- QUESTION: change the exported type?" }]);
  gh.comment(8, PERSON, "yes, change it", 1 * MIN);
  const young = await tick(gh, { sandbox: "vercel" });
  assert.deepEqual(young.answered, [], "within the grace the comment's own launch is due first");
  assert.ok(young.deadlines.some((d) => d.issue === 8 && d.kind === "answer-grace"));
  gh.comment(8, PERSON, "and keep the old name as an alias", 10 * MIN);
  const r = await tick(gh, { sandbox: "vercel" });
  assert.deepEqual(r.answered, [8]);
});
