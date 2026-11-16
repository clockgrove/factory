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
import { setSelf } from "../scripts/lib/logic.mjs";
import { openOutbox } from "../scripts/lib/outbox.mjs";
import { coveredHead, reviewScope } from "../scripts/lib/session.mjs";
import { coverAfter, foundationPrompt, reviewerPrompt } from "../scripts/review.mjs";

const ROOT = join(import.meta.dirname, "..", "..");
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
const record = (sha, at) => ({ id: 2, user: { login: SELF, type: "Bot" }, body: `<!-- factory:7:covered:${sha} -->\nFactory: covered.`, created_at: at, updated_at: at });

/** The review stage's decision, in Factory's own mirror of the branch as GitHub has it now. */
async function scopeNow(r, { reviews, comments = [] }) {
  const box = await openOutbox({ branch: "factory/7", defaultBranch: "main", checkout: r.work, remote: r.origin, agentEnv: { ...process.env, ...quiet }, protectedList: [], base: r.root });
  try {
    return await reviewScope(box.git, { reviews, comments, issue: 7, base: box.base, head: box.expected() });
  } finally {
    await box.close?.();
  }
}

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
    assert.deepEqual(await scopeNow(r, { reviews }), { first: false, covered: true, since: r.reviewed, diff: null }, "the reviewed head itself");
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
    assert.deepEqual(await scopeNow(r, { reviews, comments }), { first: false, covered: true, since: answered, diff: null });
    // A pasted record (a writer's or anyone's) is no record of Factory's.
    const pasted = [{ ...comments[0], user: { login: "kirk", type: "User" }, author_association: "OWNER" }];
    assert.equal((await scopeNow(r, { reviews, comments: pasted })).covered, false);
    assert.deepEqual(coveredHead({ reviews, comments: [record(answered, "2026-11-15T10:20:00Z").body.replace("factory:7", "factory:8")].map((body) => ({ ...comments[0], body })), issue: 7 }), { sha: r.reviewed, at: "2026-11-15T10:00:00Z" }, "another issue's record");
    // A later review (a pass on the commits since) is what covers from then on.
    assert.deepEqual(coveredHead({ reviews: [...reviews, review(answered, "2026-11-15T11:00:00Z")], comments: [record(r.reviewed, "2026-11-15T10:30:00Z")], issue: 7 }), { sha: answered, at: "2026-11-15T11:00:00Z" });
    // No Factory review at all: the first pass.
    assert.deepEqual(await scopeNow(r, { reviews: [] }), { first: true, covered: false, since: null, diff: null });
  } finally {
    setSelf(null);
    rmSync(r.root, { recursive: true, force: true });
  }
});

test("#350: what a review stage covers as it ends: its own answer to the findings yes, an answer that applied maintainers' decisions no", () => {
  const [a, b, c] = ["a", "b", "c"].map((x) => x.repeat(40));
  // The reviewer ran on a; the answer pass answered its findings in b: b is covered, recorded.
  assert.deepEqual(coverAfter({ answerQuestion: false, answerFrom: a, answerTo: b, head: b, reviewedAt: a }), { review: false, record: b });
  // Nothing to answer: the review's own head stands, nothing recorded.
  assert.deepEqual(coverAfter({ answerQuestion: false, answerFrom: a, answerTo: a, head: a, reviewedAt: a }), { review: false, record: null });
  // A validation fix pass after the answer (c): still the review's answer.
  assert.deepEqual(coverAfter({ answerQuestion: false, answerFrom: a, answerTo: b, head: c, reviewedAt: a }), { review: false, record: c });
  // The Question's answer applied in new commits: a review pass before the merge, covering only up to a.
  assert.deepEqual(coverAfter({ answerQuestion: true, answerFrom: a, answerTo: b, head: c, reviewedAt: a }), { review: true, record: null });
  // A covered PR (reviewed at an earlier stage, now at a) whose answer pass applied decisions: a stays covered.
  assert.deepEqual(coverAfter({ answerQuestion: true, answerFrom: b, answerTo: c, head: c, reviewedAt: a }), { review: true, record: b });
  // Decisions that needed no commit: nothing new, the merge goes on.
  assert.deepEqual(coverAfter({ answerQuestion: true, answerFrom: a, answerTo: a, head: a, reviewedAt: a }), { review: false, record: null });
  // A refused push: nothing reached GitHub, nothing recorded.
  assert.deepEqual(coverAfter({ answerQuestion: false, answerFrom: a, answerTo: a, head: null, reviewedAt: a }), { review: false, record: null });
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

test("#350: the review stage and the worker's rebase decide on reviewScope, and an answer that applied decisions reruns the review", () => {
  const src = readFileSync(join(ROOT, "plugin", "scripts", "review.mjs"), "utf8");
  assert.match(src, /const scope = await reviewScope\(outbox\.git, \{ reviews, comments: marks\.comments, issue, base: outbox\.base, head: startHead, maxBytes: REVIEW_DIFF_BYTES \}\);\n\s+const alreadyReviewed = scope\.covered;/);
  assert.doesNotMatch(src, /const alreadyReviewed = covered\.reviewed/);
  assert.match(src, /const reviewDiff = sinceReviewed \? scope\.diff : diff;/);
  assert.equal((src.match(/reviewerPrompt\(\{[^\n]*diff: reviewDiff, since: sinceReviewed,/g) || []).length, 2, "the reviewer and its rerun");
  assert.match(src, /foundationPrompt\(\{[^\n]*diff: reviewDiff, since: sinceReviewed,/);
  assert.match(src, /if \(cover\.record\) await recordCovered\(repo, pr\.number, issue, cover\.record, token\)/);
  assert.match(src, /if \(decision\.exit === "delivered" && !decision\.rerun && !conflict && cover\.review\) \{\n\s+decision\.rerun = true;[\s\S]{0,400}addLabels\(repo, pr\.number, \[REVIEW_LABEL\], token\)/);
  // The merge comes after that rerun is decided.
  assert.ok(src.indexOf("cover.review) {") < src.indexOf("let stoppedAtMerge = null;"));
  const worker = readFileSync(join(ROOT, "plugin", "scripts", "worker.mjs"), "utf8");
  assert.match(worker, /if \(reviewed\) \{\n\s+const scope = await reviewScope\(outbox\.git, \{ reviews: prReviews, comments: prComments, issue, base: outbox\.base, head: rebasedTo \}\);\n\s+if \(!scope\.covered\) \{/);
  assert.ok(worker.indexOf("const scope = await reviewScope(") < worker.indexOf("await recordMergeable(repo, pr.number, issue, rebasedTo, token);"));
});
