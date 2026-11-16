// #350: code written after Factory's review pass (the work stage answering a Question, a maintainer's push, an answer
// pass that applied maintainers' decisions) gets a review pass on those commits before the merge; a pure rebase of the
// reviewed head does not. Decided on trees in Factory's real mirror (outbox.mjs), against a real origin, on every route:
// the review stage (review.mjs) and the worker's rebase (worker.mjs) run the same on Actions, the cloud sandbox and locally.
import "./temp.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { reviewPost } from "../scripts/lib/handoff.mjs";
import { PLACEHOLDER_MARKER, setSelf } from "../scripts/lib/logic.mjs";
import { openOutbox } from "../scripts/lib/outbox.mjs";
import { RETRY } from "../scripts/lib/github.mjs";
import { coveredHead, mirrorDiff, reviewScope, sinceReview, unaddressedReviewComments, writtenSince } from "../scripts/lib/session.mjs";
import { ANSWER_REVIEW_LINES, answerGate, answerList, coverAfter, foundationPrompt, headMovedFrom, reviewRead, reviewerPrompt } from "../scripts/review.mjs";

const ROOT = join(import.meta.dirname, "..", "..");
RETRY.sleep = async () => {};
const quiet = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const SELF = "factory-app[bot]";

/** An origin (serving any commit by its id, as GitHub does) with main, and a clone where factory/7 is worked. */
function repos() {
  const root = mkdtempSync(join(tmpdir(), "factory-350-"));
  const origin = join(root, "origin.git");
  const work = join(root, "work");
  const run = (...a) => execFileSync("git", ["-C", work, "-c", "user.email=t@t", "-c", "user.name=t", ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...quiet } }).trim();
  const put = (file, text) => {
    mkdirSync(join(work, file, ".."), { recursive: true });
    writeFileSync(join(work, file), text);
    run("add", file);
  };
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  execFileSync("git", ["-C", origin, "config", "uploadpack.allowAnySHA1InWant", "true"]);
  execFileSync("git", ["clone", "-q", origin, work], { stdio: "pipe", env: { ...process.env, ...quiet } });
  put("app.txt", "one\ntwo\nthree\n");
  put("other.txt", "a\n");
  run("commit", "-q", "-m", "base");
  run("push", "-q", "origin", "HEAD:main");
  run("checkout", "-q", "-b", "factory/7");
  // The work stage's PR: the head Factory's reviewer read.
  put("app.txt", "one\ntwo reviewed\nthree\n");
  put("feature.txt", "reviewed feature\n");
  run("commit", "-q", "-m", "the work");
  run("push", "-q", "origin", "HEAD:factory/7");
  const reviewed = run("rev-parse", "HEAD");
  /** main moves on: a sibling merged. */
  const mainMoves = (file, text) => {
    run("checkout", "-q", "main");
    run("pull", "-q", "--ff-only", "origin", "main");
    put(file, text);
    run("commit", "-q", "-m", `main changes ${file}`);
    run("push", "-q", "origin", "HEAD:main");
    run("checkout", "-q", "factory/7");
    return run("rev-parse", "main");
  };
  const push = () => {
    run("push", "-q", "-f", "origin", "HEAD:factory/7");
    return run("rev-parse", "HEAD");
  };
  return { root, origin, work, run, put, reviewed, mainMoves, push };
}

const review = (sha, at = "2026-11-15T10:00:00Z") => ({ id: 1, user: { login: SELF, type: "Bot" }, author_association: "NONE", body: "<!-- factory:7:review -->\nFactory reviewer: one comment-only pass, 1 comment(s).", commit_id: sha, submitted_at: at });
const record = (sha, at, answer = false) => ({ id: 2, user: { login: SELF, type: "Bot" }, body: `<!-- factory:7:covered:${sha}${answer ? ":answer" : ""} -->\nFactory: covered.`, created_at: at, updated_at: at });

/** Factory's own mirror of the branch as GitHub has it now (outbox.mjs), for `fn`. */
async function inMirror(r, fn) {
  const box = await openOutbox({ branch: "factory/7", defaultBranch: "main", checkout: r.work, remote: r.origin, agentEnv: { ...process.env, ...quiet }, protectedList: [], base: r.root });
  try {
    return await fn(box);
  } finally {
    await box.close?.();
  }
}

/** The review stage's decision, in Factory's own mirror of the branch as GitHub has it now. */
const scopeNow = (r, { reviews, comments = [] }) => inMirror(r, (box) => reviewScope(box.git, { reviews, comments, issue: 7, base: box.base, head: box.expected() }));

/** GitHub for PR 12 over `state` ({head, reviews, lineComments, comments}), recording the writes. */
async function withGitHub(state, fn) {
  const realFetch = globalThis.fetch;
  const before = process.env.GITHUB_API_URL;
  process.env.GITHUB_API_URL = "https://github.test";
  state.writes = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const p = u.pathname.replace("/repos/acme/app", "");
    const method = init.method || "GET";
    const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    if (method !== "GET") {
      state.writes.push(`${method} ${p}${init.body ? ` ${JSON.parse(init.body).labels?.join(",") ?? ""}` : ""}`.trim());
      return json({});
    }
    if (p === "/pulls/12") return json({ number: 12, head: { sha: state.head, ref: "factory/7" }, base: { ref: "main" } });
    if (p === "/pulls/12/reviews") return json(state.reviews || []);
    if (p === "/pulls/12/comments") return json(state.lineComments || []);
    if (p === "/issues/12/comments") return json(state.comments || []);
    return json({ message: "Not Found" }, 404);
  };
  try {
    return await fn();
  } finally {
    globalThis.fetch = realFetch;
    if (before === undefined) delete process.env.GITHUB_API_URL;
    else process.env.GITHUB_API_URL = before;
  }
}
const REPO = { owner: "acme", name: "app", full: "acme/app" };

const files = (diff) => [...String(diff).matchAll(/^diff --git a\/(\S+) /gm)].map((m) => m[1]).sort();

test("#350: a Question's answer committed after the review pass goes to the reviewer, and only those commits", async () => {
  const r = repos();
  setSelf(SELF);
  try {
    // The review stage that raised the Question ran on `reviewed`; a person answered; the work stage wrote the answer.
    r.put("adopt.txt", "the answer to the Question\n");
    r.put("app.txt", "one\ntwo reviewed\nthree answered\n");
    r.run("commit", "-q", "-m", "answer the Question");
    r.push();
    const s = await scopeNow(r, { reviews: [review(r.reviewed)] });
    assert.equal(s.covered, false, "no merge without a pass");
    assert.equal(s.since, r.reviewed);
    assert.deepEqual(files(s.diff), ["adopt.txt", "app.txt"]);
    assert.match(s.diff, /^\+three answered$/m);
    assert.doesNotMatch(s.diff, /feature\.txt|^\+two reviewed$/m, "the reviewed code is not in the pass");
  } finally {
    setSelf(null);
    rmSync(r.root, { recursive: true, force: true });
  }
});

test("#350: a pure rebase of the reviewed head, and GitHub's update-branch merge of it, get no second pass", async () => {
  const r = repos();
  setSelf(SELF);
  try {
    const reviews = [review(r.reviewed)];
    assert.deepEqual(await scopeNow(r, { reviews }), { head: r.reviewed, first: false, covered: true, since: r.reviewed, diff: null, answer: false }, "the reviewed head itself");
    r.mainMoves("other.txt", "a\nb from a sibling\n");
    r.run("rebase", "-q", "main");
    const rebased = r.push();
    assert.notEqual(rebased, r.reviewed);
    // The reviewed head is no longer on any branch: the mirror fetches it by id, as from GitHub.
    assert.equal((await scopeNow(r, { reviews })).covered, true, "rebased onto a moved main");
    // A merge of the default branch into the branch (GitHub's update-branch), on top of the rebase.
    r.mainMoves("third.txt", "c\n");
    r.run("merge", "-q", "--no-edit", "main");
    r.push();
    assert.equal((await scopeNow(r, { reviews })).covered, true, "a merge of main brings no work of the PR's own");
  } finally {
    setSelf(null);
    rmSync(r.root, { recursive: true, force: true });
  }
});

test("#350: a rebase with new work: the pass reads the new work, not the default branch's changes; a resolved conflict gets the whole PR", async () => {
  const r = repos();
  setSelf(SELF);
  try {
    const reviews = [review(r.reviewed)];
    r.mainMoves("other.txt", "a\nb from a sibling\n");
    r.run("rebase", "-q", "main");
    r.put("feature.txt", "reviewed feature\nand a maintainer's push\n");
    r.run("commit", "-q", "-m", "a maintainer's push");
    r.push();
    const s = await scopeNow(r, { reviews });
    assert.equal(s.covered, false);
    assert.deepEqual(files(s.diff), ["feature.txt"], "other.txt is main's, app.txt was reviewed");
    // main changes the reviewed line: the rebase's resolution cannot be told from new work.
    const c = repos();
    try {
      c.mainMoves("app.txt", "one\ntwo from main\nthree\n");
      try {
        c.run("rebase", "-q", "main");
      } catch {
        c.put("app.txt", "one\ntwo reviewed and main\nthree\n");
        c.run("-c", "core.editor=true", "rebase", "--continue");
      }
      c.push();
      const whole = await scopeNow(c, { reviews: [review(c.reviewed)] });
      assert.equal(whole.covered, false);
      assert.equal(whole.diff, null, "the whole PR goes to the reviewer");
      assert.match(whole.why, /does not replay cleanly/);
    } finally {
      rmSync(c.root, { recursive: true, force: true });
    }
  } finally {
    setSelf(null);
    rmSync(r.root, { recursive: true, force: true });
  }
});

test("#350: the head covered is the later of Factory's last review and its own covered record; nobody else's record counts", async () => {
  const r = repos();
  setSelf(SELF);
  try {
    // The review stage's answer pass answered its findings in a commit: that stage recorded its head as covered.
    r.put("app.txt", "one\ntwo reviewed and fixed\nthree\n");
    r.run("commit", "-q", "-m", "answer the findings");
    const answered = r.push();
    const reviews = [review(r.reviewed, "2026-11-15T10:00:00Z")];
    const comments = [record(answered, "2026-11-15T10:20:00Z")];
    assert.deepEqual(await scopeNow(r, { reviews, comments }), { head: answered, first: false, covered: true, since: answered, diff: null, answer: false });
    // A pasted record (a writer's or anyone's) is no record of Factory's.
    const pasted = [{ ...comments[0], user: { login: "kirk", type: "User" }, author_association: "OWNER" }];
    assert.equal((await scopeNow(r, { reviews, comments: pasted })).covered, false);
    assert.deepEqual(coveredHead({ reviews, comments: [{ ...comments[0], body: comments[0].body.replace("factory:7", "factory:8") }], issue: 7 }), { sha: r.reviewed, at: "2026-11-15T10:00:00Z", answer: false }, "another issue's record");
    // A later review (a pass on the commits since) is what covers from then on.
    assert.deepEqual(coveredHead({ reviews: [...reviews, review(answered, "2026-11-15T11:00:00Z")], comments: [record(r.reviewed, "2026-11-15T10:30:00Z")], issue: 7 }), { sha: answered, at: "2026-11-15T11:00:00Z", answer: false });
    assert.equal(coveredHead({ reviews, comments: [record(r.reviewed, "2026-11-15T10:30:00Z", true)], issue: 7 }).answer, true, "the answer-bound record");
    // No Factory review at all: the first pass.
    assert.deepEqual(await scopeNow(r, { reviews: [] }), { head: answered, first: true, covered: false, since: null, diff: null, answer: false });
  } finally {
    setSelf(null);
    rmSync(r.root, { recursive: true, force: true });
  }
});

test("#350: a git whose merge-tree fails (no --merge-base before 2.40) is told from a conflict, and the whole PR is reviewed", async () => {
  const r = repos();
  setSelf(SELF);
  try {
    r.put("adopt.txt", "x\n");
    r.run("commit", "-q", "-m", "more");
    const head = r.push();
    await inMirror(r, async (box) => {
      const oldGit = (args, o) => (args[0] === "merge-tree" ? Promise.resolve({ code: 129, stdout: "", stderr: "error: unknown option `merge-base='" }) : box.git(args, o));
      const s = await sinceReview(oldGit, { base: box.base, covered: r.reviewed, head });
      assert.deepEqual([s.rebase, s.diff], [false, null]);
      assert.match(s.why, /^git merge-tree failed \(exit 129\)/);
      assert.equal(await writtenSince(oldGit, { base: box.base, from: r.reviewed, head }), null);
    });
  } finally {
    setSelf(null);
    rmSync(r.root, { recursive: true, force: true });
  }
});

test("#350: a maintainer's push during the stage is neither read nor covered by the pass that read the head before it", async () => {
  const r = repos();
  setSelf(SELF);
  try {
    // Covered: `reviewed`. M1, a maintainer's push after it; the stage starts on M1 and scopes it.
    r.put("m1.txt", "m1\n");
    r.run("commit", "-q", "-m", "m1");
    const m1 = r.push();
    await inMirror(r, async (box) => {
      const reviews = [review(r.reviewed)];
      const rescope = (head) => reviewScope(box.git, { reviews, comments: [], issue: 7, base: box.base, head });
      const scope = await rescope(box.expected());
      assert.equal(scope.head, m1);
      // M2 lands on GitHub while the reviewer runs: Factory's checkout, and what the reviewer reads, stay on M1.
      r.put("m2.txt", "m2\n");
      r.run("commit", "-q", "-m", "m2");
      const m2 = r.push();
      const read = await reviewRead({ scope, head: box.expected(), rescope, wholeDiff: (h) => mirrorDiff(box.git, box.base, h, { mergeBase: true }) });
      assert.deepEqual([read.head, read.since], [m1, r.reviewed]);
      assert.deepEqual(files(read.reviewDiff), ["m1.txt"]);
      assert.deepEqual(files(read.diff), ["app.txt", "feature.txt", "m1.txt"], "the comments are fitted to the PR at M1");
      // Before the review goes up, GitHub's head is not Factory's: nothing is posted and the review label goes back on.
      const gh = { head: m2 };
      assert.equal(await withGitHub(gh, () => headMovedFrom({ repo: REPO, prNumber: 12, own: box.expected(), token: { token: "t" } })), m2);
      assert.ok(gh.writes.some((w) => w.startsWith("DELETE /issues/12/labels/")) && gh.writes.at(-1) === "POST /issues/12/labels factory:review", gh.writes.join("\n"));
      // A review on M1 (where it goes up when the head is still Factory's) covers M1 only: the next stage reads M2.
      const next = await scopeNow(r, { reviews: [...reviews, review(read.head, "2026-11-15T11:00:00Z")] });
      assert.equal(next.covered, false);
      assert.deepEqual(files(next.diff), ["m2.txt"]);
    });
  } finally {
    setSelf(null);
    rmSync(r.root, { recursive: true, force: true });
  }
});

test("#350: Factory's fix passes move the head the review reads (before the reviewer) but not the one it goes up on (after it)", async () => {
  const r = repos();
  setSelf(SELF);
  try {
    r.put("m1.txt", "m1\n");
    r.run("commit", "-q", "-m", "a maintainer's push");
    const m1 = r.push();
    const reviews = [review(r.reviewed)];
    // A fix pass before the reviewer (a head known red): the reviewer reads M1 and the fix, decided again on the new head.
    const scope = await scopeNow(r, { reviews });
    r.put("app.txt", "one\ntwo reviewed\nthree fixed\n");
    r.run("commit", "-q", "-m", "fix pass");
    const fixed = r.push();
    await inMirror(r, async (box) => {
      const read = await reviewRead({ scope, head: box.expected(), rescope: (head) => reviewScope(box.git, { reviews, comments: [], issue: 7, base: box.base, head }), wholeDiff: (h) => mirrorDiff(box.git, box.base, h, { mergeBase: true }) });
      assert.deepEqual([scope.head, read.scope.head, read.head], [m1, fixed, fixed]);
      assert.deepEqual(files(read.reviewDiff), ["app.txt", "m1.txt"]);
    });
    // A fix pass after the reviewer (the red the checks beside it showed), published before the review goes up: the
    // head on GitHub is Factory's, so the review goes up on the head it read, and the fix is the review's answer.
    r.put("app.txt", "one\ntwo reviewed\nthree fixed again\n");
    r.run("commit", "-q", "-m", "fix pass after the reviewer");
    const after = r.push();
    const gh = { head: after };
    assert.equal(await withGitHub(gh, () => headMovedFrom({ repo: REPO, prNumber: 12, own: after, token: { token: "t" } })), null);
    assert.deepEqual(gh.writes, []);
    await inMirror(r, async (box) => {
      const written = await writtenSince(box.git, { base: box.base, from: fixed, head: after });
      assert.deepEqual(written, { files: [{ path: "app.txt", lines: 2 }], lines: 2 });
      const gate = answerGate({ written, texts: ["FAIL test/app.test.js: app.txt line 3 is not 'three fixed again'"] });
      assert.deepEqual(coverAfter({ answerQuestion: false, answerFrom: after, answerTo: after, head: after, reviewedAt: fixed, gate }), { review: false, answer: false, record: after });
    });
  } finally {
    setSelf(null);
    rmSync(r.root, { recursive: true, force: true });
  }
});

test("#350: a clean pass on new commits leaves the earlier review's unanswered findings to answer", async () => {
  setSelf(SELF);
  try {
    const own = (id, sha) => ({ id, user: { login: SELF, type: "Bot" }, author_association: "NONE", body: "<!-- factory:7:review -->\nFactory reviewer", commit_id: sha, submitted_at: "2026-11-15T10:00:00Z" });
    const gh = {
      head: "c".repeat(40),
      // Stage 1's review on a, with a finding nobody answered; stage 2's pass on the commits since, clean (its placeholder).
      reviews: [own(1, "a".repeat(40)), own(2, "b".repeat(40))],
      lineComments: [
        { id: 11, pull_request_review_id: 1, path: "app.txt", line: 2, user: { login: SELF, type: "Bot" }, body: "acceptance A: two is wrong" },
        { id: 21, pull_request_review_id: 2, path: "m1.txt", line: 1, user: { login: SELF, type: "Bot" }, body: `${PLACEHOLDER_MARKER}\nFactory reviewer: no findings; the pass ran and returned nothing line-tied.` },
      ],
    };
    const open = await withGitHub(gh, () => unaddressedReviewComments(REPO, 12, SELF, { token: "t", reviewIds: new Set([1, 2]), thirdParty: [] }));
    assert.deepEqual(open.map((c) => c.id), [11]);
    assert.deepEqual(answerList(open, { placeholder: true, first: false }).map((c) => c.id), [11], "the earlier finding is still answered");
    assert.deepEqual(answerList(open, { placeholder: true, first: true }), [], "a clean first review has nothing of Factory's to answer");
  } finally {
    setSelf(null);
  }
});

test("#350: the answer and fix passes stay the review's answer within the bound; past it they get one review pass, whose own answer is not gated", async () => {
  const r = repos();
  setSelf(SELF);
  const comments = [{ id: 11, path: "app.txt", line: 2, body: "acceptance A: two is wrong" }];
  const since = (head) => inMirror(r, (box) => writtenSince(box.git, { base: box.base, from: r.reviewed, head }));
  try {
    // Within: a few lines on the file the finding is on.
    r.put("app.txt", "one\ntwo reviewed and fixed\nthree\n");
    r.run("commit", "-q", "-m", "answer");
    const small = r.push();
    let written = await since(small);
    assert.deepEqual(written, { files: [{ path: "app.txt", lines: 2 }], lines: 2 });
    let gate = answerGate({ written, comments });
    assert.equal(gate.review, false);
    assert.deepEqual(coverAfter({ answerQuestion: false, answerFrom: r.reviewed, answerTo: small, head: small, reviewedAt: r.reviewed, gate }), { review: false, answer: false, record: small });
    // A file no finding or failure names: past the bound.
    r.put("unrelated.txt", "x\n");
    r.run("commit", "-q", "-m", "and more");
    const wide = r.push();
    written = await since(wide);
    gate = answerGate({ written, comments });
    assert.equal(gate.review, true);
    assert.match(gate.why, /changed unrelated\.txt, which no finding or failure names/);
    assert.equal(answerGate({ written, comments, texts: ["FAIL unrelated.txt:1 expected y"] }).review, false, "a failure the fix pass was given names it");
    // Over the line bound on the finding's own file.
    r.put("app.txt", Array.from({ length: ANSWER_REVIEW_LINES + 1 }, (_, i) => `line ${i}`).join("\n") + "\n");
    r.run("rm", "-q", "unrelated.txt");
    r.run("commit", "-q", "-m", "a rewrite");
    const big = r.push();
    written = await since(big);
    gate = answerGate({ written, comments });
    assert.equal(gate.review, true);
    assert.match(gate.why, new RegExp(`changed ${written.lines} lines, over ${ANSWER_REVIEW_LINES}`));
    assert.equal(answerGate({ written: null, comments }).review, true, "what was written cannot be told");
    // Past the bound: no merge, the review stage covers up to the head its review read, recorded as the answer's.
    const c = coverAfter({ answerQuestion: false, answerFrom: r.reviewed, answerTo: big, head: big, reviewedAt: r.reviewed, gate });
    assert.deepEqual([c.review, c.answer, c.record], [true, true, r.reviewed]);
    // The next stage reads that record: a pass on the answer's commits, which is the answer's review...
    const next = await scopeNow(r, { reviews: [review(r.reviewed)], comments: [record(r.reviewed, "2026-11-15T10:30:00Z", true)] });
    assert.deepEqual([next.covered, next.since, next.answer], [false, r.reviewed, true]);
    assert.deepEqual(files(next.diff), ["app.txt"]);
    // ...and its own answer, however large, is covered: no loop.
    const x = "e".repeat(40);
    assert.deepEqual(coverAfter({ answerQuestion: false, answerFrom: big, answerTo: x, head: x, reviewedAt: big, gate: null, answering: true }), { review: false, answer: false, record: x });
  } finally {
    setSelf(null);
    rmSync(r.root, { recursive: true, force: true });
  }
});

test("#350: an answer pass that applied maintainers' decisions in new commits gets a review pass before the merge", () => {
  const [a, b, c] = ["a", "b", "c"].map((x) => x.repeat(40));
  // The Question's answer applied in new commits: a review pass before the merge, covering only up to a.
  assert.deepEqual(coverAfter({ answerQuestion: true, answerFrom: a, answerTo: b, head: c, reviewedAt: a }), { review: true, answer: false, record: null });
  // A covered PR (reviewed at an earlier stage, now at a) whose answer pass applied decisions after a fix pass took it to b.
  assert.deepEqual(coverAfter({ answerQuestion: true, answerFrom: b, answerTo: c, head: c, reviewedAt: a }), { review: true, answer: false, record: b });
  // Even the answer to a pass on an answer's commits: decisions are new work.
  assert.equal(coverAfter({ answerQuestion: true, answerFrom: a, answerTo: b, head: b, reviewedAt: a, answering: true }).review, true);
  // Decisions that needed no commit: nothing new, the merge goes on.
  assert.deepEqual(coverAfter({ answerQuestion: true, answerFrom: a, answerTo: a, head: a, reviewedAt: a }), { review: false, answer: false, record: null });
  // A refused push: nothing reached GitHub, nothing recorded.
  assert.deepEqual(coverAfter({ answerQuestion: false, answerFrom: a, answerTo: a, head: null, reviewedAt: a }), { review: false, answer: false, record: null });
});

test("#350: the pass on the commits since is told so, and its review says so", () => {
  const since = "4ac21cf4".padEnd(40, "0");
  const args = { issue: 7, issueTitle: "T", issueBody: "Acceptance:\n- A: adopt re-renders", prBody: "body", diff: "diff --git a/x b/x\n", harness: "claude" };
  const p = reviewerPrompt({ ...args, since });
  assert.match(p, /already reviewed this PR at 4ac21cf, and commits were written after that review\. .* still judge every acceptance entry on the PR as it now stands\./);
  assert.match(p, /^## Diff since 4ac21cf$/m);
  const whole = reviewerPrompt(args);
  assert.doesNotMatch(whole, /already reviewed/);
  assert.match(whole, /^## Diff$/m);
  const f = foundationPrompt({ ...args, since });
  assert.match(f, /already reviewed this PR at 4ac21cf/);
  assert.doesNotMatch(f, /judge every acceptance entry/, "the foundation pass judges no entry");
  const diff = "diff --git a/x.txt b/x.txt\n--- a/x.txt\n+++ b/x.txt\n@@ -1 +1 @@\n-a\n+b\n";
  const post = reviewPost({ issue: 7, review: { comments: [], acceptance: [] }, diff, since });
  assert.match(post.body, /^Factory reviewer: one comment-only pass on the commits since 4ac21cf, 1 comment\(s\)\.$/m);
  assert.match(reviewPost({ issue: 7, review: { comments: [], acceptance: [] }, diff }).body, /^Factory reviewer: one comment-only pass, 1 comment\(s\)\.$/m);
});

test("#350: the worker's rebase keeps the review only for a rebase of the covered head (its stage wiring)", () => {
  // The review stage's steps are the functions above; these are the calls that join them where no stage runs in a test.
  const src = readFileSync(join(ROOT, "plugin", "scripts", "review.mjs"), "utf8");
  assert.match(src, /const alreadyReviewed = scope\.covered;/);
  assert.match(src, /postReview\(repo, pr\.number, \{ body: post\.body, comments, commitId: read\.head \}, token\)/);
  assert.ok(src.indexOf("await headMovedFrom(") < src.indexOf("commitId: read.head"), "the head is checked before the review goes up");
  assert.match(src, /await headMovedFrom\(\{[^\n]*before: \(\) => beforeExit\?\.\(\) \}\)/);
  assert.ok(src.indexOf("await settleCover({") < src.indexOf("let stoppedAtMerge = null;"));
  const worker = readFileSync(join(ROOT, "plugin", "scripts", "worker.mjs"), "utf8");
  assert.match(worker, /const scope = await reviewScope\(outbox\.git, \{ reviews: prReviews, comments: prComments, issue, base: outbox\.base, head: rebasedTo \}\);\n\s+if \(!scope\.covered\) \{/);
  assert.ok(worker.indexOf("const scope = await reviewScope(") < worker.indexOf("await recordMergeable(repo, pr.number, issue, rebasedTo, token);"));
});

test("#350: a large fix pass after the review, then an answer that applied decisions: the next pass reads from the reviewed head", async () => {
  const r = repos();
  setSelf(SELF);
  try {
    // The review went up on `reviewed`; a fix pass beside it rewrote a file no failure names; then the answer pass
    // applied a maintainer's decision.
    r.put("big.txt", Array.from({ length: ANSWER_REVIEW_LINES + 1 }, (_, i) => `fix ${i}`).join("\n") + "\n");
    r.run("commit", "-q", "-m", "fix pass beside the reviewer");
    const fixed = r.push();
    r.put("decided.txt", "as the maintainer said\n");
    r.run("commit", "-q", "-m", "the decision");
    const decided = r.push();
    // The bound is on what came before the decision's answer pass.
    const written = await inMirror(r, (box) => writtenSince(box.git, { base: box.base, from: r.reviewed, head: fixed }));
    const gate = answerGate({ written, texts: ["FAIL app.txt"] });
    assert.equal(gate.review, true);
    const c = coverAfter({ answerQuestion: true, answerFrom: fixed, answerTo: decided, head: decided, reviewedAt: r.reviewed, gate });
    assert.deepEqual([c.review, c.answer, c.record], [true, true, r.reviewed], "not the fix pass's head");
    const next = await scopeNow(r, { reviews: [review(r.reviewed)], comments: [record(c.record, "2026-11-15T10:30:00Z", c.answer)] });
    assert.deepEqual(files(next.diff), ["big.txt", "decided.txt"], "the fix pass and the decision, both read");
    // Within the bound, the decision alone is read.
    assert.deepEqual(coverAfter({ answerQuestion: true, answerFrom: fixed, answerTo: decided, head: decided, reviewedAt: r.reviewed, gate: { review: false } }), { review: true, answer: false, record: fixed });
  } finally {
    setSelf(null);
    rmSync(r.root, { recursive: true, force: true });
  }
});

test("#350: a moved head honours a stop before the review label goes back on", async () => {
  const gh = { head: "b".repeat(40) };
  const stopped = new Error("stopped");
  await assert.rejects(
    withGitHub(gh, () =>
      headMovedFrom({
        repo: REPO,
        prNumber: 12,
        own: "a".repeat(40),
        token: { token: "t" },
        before: async () => {
          throw stopped;
        },
      }),
    ),
    stopped,
  );
  assert.deepEqual(gh.writes, [], "no label written for a stopped stage");
  const order = [];
  const moved = await withGitHub(gh, () => headMovedFrom({ repo: REPO, prNumber: 12, own: "a".repeat(40), token: { token: "t" }, before: async () => order.push("stop check") }));
  assert.equal(moved, gh.head);
  assert.deepEqual(order, ["stop check"]);
  assert.equal(gh.writes.at(-1), "POST /issues/12/labels factory:review");
});
