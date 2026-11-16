// #368: a reviewer finding counts as answered only when the finding check (a decision model) reads Factory's answer as
// resolving it, or a person answered it. A no, or no verdict, keeps it open for another answer round within the bound;
// without a decider key, a reply answers its finding as before.
import "./temp.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FINDING_QUESTION, checkAnswers, findingInput, openFindingCheck } from "../scripts/lib/finding-check.mjs";
import { RETRY } from "../scripts/lib/github.mjs";
import { postReplies } from "../scripts/lib/handoff.mjs";
import { decideExit, marker, reviewBody, setSelf } from "../scripts/lib/logic.mjs";
import { openOutbox } from "../scripts/lib/outbox.mjs";
import { ANSWER_ROUNDS, answerDiffs, openFindingsExit, unaddressedReviewComments } from "../scripts/lib/session.mjs";
import { CODE_SCANNING, answeredReviewers } from "../scripts/lib/third-party-review.mjs";
import { answerPrompt } from "../scripts/review.mjs";

RETRY.sleep = async () => {};
const SELF = "factory-app[bot]";
const REPO = { owner: "acme", name: "app", full: "acme/app" };
const app = { login: SELF, type: "Bot" };

/**
 * GitHub for Objective 7's PR 12: Factory's review (id 1) and its line comments, code scanning's, the PR's and the issue's
 * comments, the review threads (one per root line comment, resolved as `resolved` says) and the writes made.
 */
function github({ lineComments = [], reviews = [{ id: 1, user: app, author_association: "NONE", body: "<!-- factory:7:review -->\nFactory reviewer: one comment-only pass." }] } = {}) {
  const state = { lineComments, reviews, prComments: [], issueComments: [], resolved: new Set(), labels: [], writes: [] };
  let id = 50_000;
  const node = (c) => ({ databaseId: c.id, body: c.body, authorAssociation: c.author_association || "NONE", author: { __typename: c.user.type === "Bot" ? "Bot" : "User", login: c.user.login.replace(/\[bot\]$/, "") }, pullRequestReview: c.pull_request_review_id ? { body: state.reviews.find((r) => r.id === c.pull_request_review_id)?.body || "", authorAssociation: "NONE", author: { __typename: "Bot", login: "factory-app" } } : null });
  const threads = () =>
    state.lineComments
      .filter((c) => !c.in_reply_to_id)
      .map((c) => ({ id: `T${c.id}`, isResolved: state.resolved.has(`T${c.id}`), path: c.path, line: c.line, originalLine: c.line, comments: { nodes: [c, ...state.lineComments.filter((r) => r.in_reply_to_id === c.id)].map(node) } }));
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const p = u.pathname.replace("/repos/acme/app", "");
    const method = init.method || "GET";
    const body = init.body ? JSON.parse(init.body) : null;
    const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    if (method !== "GET") state.writes.push(`${method} ${p}`);
    let m;
    if (p.endsWith("/graphql")) {
      if (body.query.includes("resolveReviewThread")) {
        state.resolved.add(body.variables.id);
        return json({ data: { resolveReviewThread: { thread: { isResolved: true } } } });
      }
      if (body.query.includes("reviewThreads")) return json({ data: { repository: { pullRequest: { reviewThreads: { nodes: threads() } } } } });
      return json({ data: {} });
    }
    if (method === "GET" && p === "/pulls/12/comments") return json(state.lineComments);
    if (method === "GET" && p === "/pulls/12/reviews") return json(state.reviews);
    if (method === "POST" && (m = /^\/pulls\/12\/comments\/(\d+)\/replies$/.exec(p))) {
      const c = { id: id++, in_reply_to_id: Number(m[1]), user: app, author_association: "NONE", body: body.body };
      state.lineComments.push(c);
      return json(c, 201);
    }
    const list = (n) => (n === "12" ? state.prComments : state.issueComments);
    if (method === "GET" && (m = /^\/issues\/(\d+)\/comments$/.exec(p))) return json(list(m[1]));
    if (method === "POST" && (m = /^\/issues\/(\d+)\/comments$/.exec(p))) {
      const c = { id: id++, user: app, author_association: "NONE", body: body.body, created_at: new Date().toISOString() };
      list(m[1]).push(c);
      return json(c, 201);
    }
    if (method === "PATCH" && (m = /^\/issues\/comments\/(\d+)$/.exec(p))) {
      const c = [...state.prComments, ...state.issueComments].find((x) => x.id === Number(m[1]));
      c.body = body.body;
      return json(c);
    }
    if (method === "GET" && /^\/issues\/7\/timeline$/.test(p)) return json(state.timeline || []);
    if (method === "POST" && p === "/issues/12/labels") {
      state.labels.push(...body.labels);
      return json([]);
    }
    return json({ message: "Not Found" }, 404);
  };
  return { fetch, state };
}

async function withGitHub(gh, fn) {
  const realFetch = globalThis.fetch;
  const before = process.env.GITHUB_API_URL;
  process.env.GITHUB_API_URL = "https://github.test";
  globalThis.fetch = gh.fetch;
  setSelf(SELF);
  try {
    return await fn();
  } finally {
    setSelf(null);
    globalThis.fetch = realFetch;
    if (before === undefined) delete process.env.GITHUB_API_URL;
    else process.env.GITHUB_API_URL = before;
  }
}

/** A decider that answers per finding as `verdicts` says (by a text the finding's body holds), recording each input. */
function decider(verdicts) {
  const asked = [];
  return {
    asked,
    name: "fake",
    model: "fake/decider",
    async decide(input, question) {
      asked.push({ input, question });
      const hit = Object.entries(verdicts).find(([k]) => input.includes(k));
      const v = hit?.[1] ?? "unresolved";
      if (v instanceof Error || v === "auth" || v === "unavailable") return { verdict: null, confidence: null, error: v instanceof Error ? "vendor" : v };
      return { verdict: v, confidence: 0.9 };
    },
  };
}

const root = (id, path, line, body) => ({ id, pull_request_review_id: 1, path, line, user: app, author_association: "NONE", body });
const alert = { id: 300, pull_request_review_id: 9, path: "src/merge.ts", line: 8, user: { login: CODE_SCANNING, type: "Bot" }, author_association: "NONE", body: "## CodeQL / Prototype-polluting assignment\nFINDING-C" };
const list = (opts = {}) => unaddressedReviewComments(REPO, 12, SELF, { token: "t", reviewIds: new Set([1]), thirdParty: answeredReviewers([]), ...opts });
const diffs = async (paths) => new Map(paths.map((p) => [p, p === "src/a.ts" ? "diff --git a/src/a.ts b/src/a.ts\n-  return x;\n+  if (x == null) throw new Error('x');\n+  return x;" : ""]));

test("#368: only the finding check's yes resolves a finding's thread; a no or no verdict keeps it open with its earlier answer, for the next answer pass", async () => {
  const gh = github({ lineComments: [root(100, "src/a.ts", 5, "acceptance 1 not met: FINDING-A, null input crashes"), root(200, "src/b.ts", 9, "AGENTS.md rule 3: FINDING-B, no test for the new branch"), alert] });
  await withGitHub(gh, async () => {
    const toAnswer = await list();
    assert.deepEqual(toAnswer.map((c) => c.id), [100, 200, 300]);
    const replies = JSON.stringify([
      { id: 100, body: "Fixed in abc1234: null input throws." },
      { id: 200, body: "Acceptance 3 does not require this." },
      { id: 300, body: "Not reachable: the key is checked." },
    ]);
    assert.equal(await postReplies(REPO, 12, 7, replies, toAnswer.map((c) => c.id), { token: "t" }), 3);
    // On main, any reply answered a finding: here all three are still open until the check reads them.
    assert.deepEqual((await list()).map((c) => c.id), [100, 200, 300]);
    const fake = decider({ "FINDING-A": "fixed", "FINDING-B": "unresolved", "FINDING-C": "unavailable" });
    const progress = [];
    const out = await checkAnswers({ repo: REPO, issue: 7, prNumber: 12, findings: toAnswer, repliesText: replies, check: openFindingCheck({ inputs: { triageModel: "fake/decider" }, decider: fake }), diffsOf: diffs, issueBody: "## Acceptance\n1. null input is refused", opts: { token: "t" }, progress: async (l) => progress.push(l) });
    assert.deepEqual(out, { resolved: [100], open: [200, 300] });
    assert.deepEqual([...gh.state.resolved], ["T100"], "only the yes is resolved");
    // Each question carries the finding, the reply, the answer's diff to that file and the issue, and asks the one question.
    assert.equal(fake.asked.length, 3);
    assert.equal(fake.asked[0].question, FINDING_QUESTION);
    assert.match(fake.asked[0].input, /Finding by Factory's reviewer, at src\/a\.ts:5:\nacceptance 1 not met: FINDING-A/);
    assert.match(fake.asked[0].input, /The author's reply:\nFixed in abc1234/);
    assert.match(fake.asked[0].input, /\+  if \(x == null\) throw/);
    assert.match(fake.asked[0].input, /1\. null input is refused/);
    assert.match(fake.asked[1].input, /The change the answer made to src\/b\.ts .*:\n\(no change\)/);
    assert.match(fake.asked[2].input, /Finding by github-advanced-security\[bot\], a reviewer outside Factory/);
    assert.deepEqual(progress, ["finding check (fake/decider): 1 of 3 answer(s) resolve their findings; still open: src/b.ts:9, src/merge.ts:8"]);
    // The next answer pass gets the two still open, each with the answer the check did not accept.
    const open = await list();
    assert.deepEqual(open.map((c) => [c.id, c.earlier]), [[200, "Acceptance 3 does not require this."], [300, "Not reachable: the key is checked."]]);
    const prompt = answerPrompt({ taskCard: "", prNumber: 12, comments: open.map((c) => ({ id: c.id, path: c.path, line: c.line, body: c.body, earlier: c.earlier, ...(c.from ? { from: c.from } : {}) })) });
    assert.match(prompt, /\(comment id 200\): AGENTS\.md rule 3: FINDING-B, no test for the new branch\n {2}Still open: Factory's check read your earlier answer as not resolving it: "Acceptance 3 does not require this\."/);
  });
});

test("#368: without a decider key a reply answers its finding as before, said once on the progress comment; no question is asked", async () => {
  const gh = github({ lineComments: [root(100, "src/a.ts", 5, "FINDING-A"), root(200, "src/b.ts", 9, "FINDING-B")] });
  // No key: no ai_gateway_api_key input on Actions; locally, no key file in the (fake) home.
  const home = mkdtempSync(join(tmpdir(), "fc-home-"));
  const check = openFindingCheck({ inputs: {}, env: {}, home });
  assert.deepEqual(check, { model: "perplexity/pplx-decider-v1.2", off: "no-key" });
  assert.equal(openFindingCheck({ inputs: { harness: "claude" }, env: { GITHUB_ACTIONS: "true" }, home }).off, "no-key");
  await withGitHub(gh, async () => {
    const toAnswer = await list();
    const replies = JSON.stringify([{ id: 100, body: "Fixed." }, { id: 200, body: "Not a defect." }]);
    await postReplies(REPO, 12, 7, replies, [100, 200], { token: "t" });
    const progress = [];
    const out = await checkAnswers({ repo: REPO, issue: 7, prNumber: 12, findings: toAnswer, repliesText: replies, check, diffsOf: diffs, opts: { token: "t" }, progress: async (l) => progress.push(l) });
    assert.deepEqual(out, { resolved: [100, 200], open: [] });
    assert.deepEqual(progress, ["finding check: off (no-key); a reply answers its finding"]);
    assert.deepEqual(await list(), []);
  });
});

test("#368: a key the gateway refuses is asked no more in the stage; those findings stay open", async () => {
  const fake = decider({ "FINDING-A": "auth", "FINDING-B": "fixed" });
  const check = openFindingCheck({ decider: fake });
  const [a] = await check.judge([{ id: 1, path: "a", line: 1, body: "FINDING-A", reply: "r", diff: "" }]);
  assert.deepEqual(a, { id: 1, verdict: null, confidence: null, error: "auth" });
  const [b] = await check.judge([{ id: 2, path: "b", line: 1, body: "FINDING-B", reply: "r", diff: "" }]);
  assert.deepEqual(b, { id: 2, verdict: null, confidence: null, error: "auth" });
  assert.equal(fake.asked.length, 1);
  // A verdict outside the question's choices is no verdict.
  const odd = openFindingCheck({ decider: { model: "m", decide: async () => ({ verdict: "maybe", confidence: 1 }) } });
  assert.deepEqual(await odd.judge([{ id: 3, body: "x", reply: "y", diff: "" }]), [{ id: 3, verdict: null, confidence: null, error: "no_answer" }]);
  // The input is cut per part and held secrets never go out in it.
  const input = findingInput({ repo: "acme/app", prNumber: 12, finding: { path: "a", line: 2, body: "b".repeat(9000) }, reply: "r", diff: null });
  assert.match(input, /\[cut at 4000 characters\]/);
  assert.match(input, /\(the change could not be read\)/);
});

test("#368: a finding in the review body is resolved by Factory's resolved marker on the check's yes; a no leaves it open", async () => {
  // As postReview sets out the findings GitHub took in no line.
  const body = reviewBody("<!-- factory:7:review -->\nFactory reviewer: one comment-only pass.", [{ path: "src/c.ts", line: 4, body: "FINDING-D, acceptance 2" }, { path: "src/d.ts", line: 6, body: "FINDING-E, rule 1" }]);
  const gh = github({ reviews: [{ id: 1, user: app, author_association: "NONE", body }] });
  await withGitHub(gh, async () => {
    const toAnswer = await list();
    const ids = toAnswer.map((c) => c.id);
    assert.deepEqual(ids, ["r1-1", "r1-2"]);
    const replies = JSON.stringify(toAnswer.map((c) => ({ id: c.id, body: `answer to ${c.id}` })));
    await postReplies(REPO, 12, 7, replies, ids, { token: "t" });
    assert.deepEqual((await list()).map((c) => c.id), ids, "a reply alone answers no body finding");
    const yes = toAnswer[0];
    const out = await checkAnswers({ repo: REPO, issue: 7, prNumber: 12, findings: toAnswer, repliesText: replies, check: openFindingCheck({ decider: decider({ "FINDING-D": "rebutted" }) }), diffsOf: diffs, opts: { token: "t" } });
    assert.deepEqual(out.resolved, [yes.id]);
    assert.ok(gh.state.prComments.some((c) => c.body.startsWith(marker(7, "resolved", yes.id))));
    const left = await list();
    assert.deepEqual(left.map((c) => c.id), ids.slice(1));
    assert.equal(left[0]?.earlier, `answer to ${ids[1]}`);
  });
});

test("#368: findings still open after the answer pass get another answer round within the bound, then the Block names them; code scanning's rounds share the bound", async () => {
  const gh = github();
  const open = [{ id: 200, path: "src/b.ts", line: 9 }, { id: "r1-1", path: "src/c.ts", line: 4 }];
  await withGitHub(gh, async () => {
    const stage = () => openFindingsExit(decideExit({ harness: { ok: true }, pr: { exists: true }, commits: 1, validation: { green: true, passes: 0 }, reviewUnaddressed: open.length }), { repo: REPO, issue: 7, prNumber: 12, objectiveLabel: "factory:objective", open }, { token: "t" });
    for (let round = 1; round <= ANSWER_ROUNDS; round += 1) {
      const d = await stage();
      assert.deepEqual(d, { exit: "delivered", rerun: true, reason: `2 reviewer finding(s) still open after the answer pass (src/b.ts:9; src/c.ts:4); the review runs again to answer them (round ${round} of ${ANSWER_ROUNDS})` });
    }
    assert.deepEqual(gh.state.labels, ["factory:review", "factory:review"]);
    assert.equal(gh.state.issueComments.filter((c) => c.body.startsWith(marker(7, "answer-rounds"))).length, 1, "one record on the issue");
    const d = await stage();
    assert.deepEqual(d, { exit: "blocked", cause: "work", reason: "2 reviewer finding(s) still open on PR #12 after 2 answer round(s): src/b.ts:9; src/c.ts:4. Fix or answer them on the branch, or resolve their threads on the PR, then re-apply `factory:objective` to resume" });
    assert.equal(gh.state.labels.length, 2, "no third round");
    // A re-entry (the Objective label applied again) starts the count over.
    gh.state.timeline = [{ event: "labeled", label: { name: "factory:objective" }, created_at: new Date(Date.now() + 1000).toISOString() }];
    assert.equal((await stage()).rerun, true);
  });
});

test("#368: the answer's diff to a file leaves out the default branch's changes the answer pass rebased onto", async () => {
  const quiet = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const rootDir = mkdtempSync(join(tmpdir(), "fc-git-"));
  const origin = join(rootDir, "origin.git");
  const work = join(rootDir, "work");
  const run = (...a) => execFileSync("git", ["-C", work, "-c", "user.email=t@t", "-c", "user.name=t", ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...quiet } }).trim();
  const put = (file, text) => {
    mkdirSync(join(work, file, ".."), { recursive: true });
    writeFileSync(join(work, file), text);
    run("add", file);
  };
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  execFileSync("git", ["-C", origin, "config", "uploadpack.allowAnySHA1InWant", "true"]);
  execFileSync("git", ["clone", "-q", origin, work], { stdio: "pipe", env: { ...process.env, ...quiet } });
  put("src/a.ts", "one\ntwo\n");
  put("src/m.ts", "main\n");
  run("commit", "-q", "-m", "base");
  run("push", "-q", "origin", "HEAD:main");
  run("checkout", "-q", "-b", "factory/7");
  put("src/a.ts", "one\ntwo reviewed\n");
  run("commit", "-q", "-m", "work");
  run("push", "-q", "origin", "HEAD:factory/7");
  const from = run("rev-parse", "HEAD");
  // A sibling merged on main, then the answer pass rebased onto it and fixed the finding.
  run("checkout", "-q", "main");
  put("src/m.ts", "main moved\n");
  run("commit", "-q", "-m", "sibling");
  run("push", "-q", "origin", "HEAD:main");
  run("checkout", "-q", "factory/7");
  run("rebase", "-q", "main");
  put("src/a.ts", "one\ntwo reviewed\nthree fixed\n");
  run("commit", "-q", "-m", "answer");
  run("push", "-q", "-f", "origin", "HEAD:factory/7");
  const box = await openOutbox({ branch: "factory/7", defaultBranch: "main", checkout: work, remote: origin, agentEnv: { ...process.env, ...quiet }, protectedList: [], base: rootDir });
  try {
    const d = await answerDiffs(box.git, { base: box.base, from, head: box.expected(), paths: ["src/a.ts", "src/m.ts"] });
    assert.match(d.get("src/a.ts"), /^\+three fixed$/m);
    assert.doesNotMatch(d.get("src/a.ts"), /^[-+]two reviewed$/m, "what the review already read is not the answer's");
    assert.equal(d.get("src/m.ts"), "", "the default branch's change is not the answer's");
    assert.equal((await answerDiffs(box.git, { base: box.base, from, head: from, paths: ["src/a.ts"] })).get("src/a.ts"), "");
  } finally {
    await box.close?.();
  }
});

test("#368: the review stage judges the answer pass's replies before it resolves threads, and takes another answer round for findings still open", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(join(import.meta.dirname, "..", "scripts", "review.mjs"), "utf8");
  const judged = src.indexOf("await checkAnswers({");
  assert.ok(judged > 0 && judged < src.indexOf("await resolveFactoryThreads(repo, pr.number"), "judged before the threads are resolved");
  assert.match(src, /check: openFindingCheck\(\{ inputs \}\)/);
  assert.match(src, /if \(decision\.findingsOpen && [^\n]*decideExit\(\{ \.\.\.exitArgs, reviewUnaddressed: 0 \}\)\.exit === "delivered"\) await openFindingsExit\(decision/);
});
