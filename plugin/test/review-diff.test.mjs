import "./temp.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RETRY, postReview, prDiff } from "../scripts/lib/github.mjs";
import { answerPrompt } from "../scripts/review.mjs";
import { parseReplies, postReplies } from "../scripts/lib/handoff.mjs";
import { bodyFindingId, bodyFindings, diffLines, filesDiff, fitToFiles, promptDiff, reviewBody, setSelf, snapComments } from "../scripts/lib/logic.mjs";
import { exec } from "../scripts/lib/proc.mjs";
import { mirrorDiff, unaddressedReviewComments } from "../scripts/lib/session.mjs";

// The fakes here fail some GitHub reads for good: the client's retries (#168) go at once, not after real backoff waits.
RETRY.sleep = async () => {};

const fixture = (name) => readFileSync(join(import.meta.dirname, "fixtures", name), "utf8");
const lineMap = (diff) => Object.fromEntries(Object.entries(diffLines(diff)).filter(([, v]) => v.first !== null).map(([p, v]) => [p, { first: v.first, lines: [...v.lines].sort((a, b) => a - b) }]));
// One finding on every file at a line it shows, one on a line it does not, one off the diff and one with no path.
const findingsFor = (diff) => [
  ...Object.entries(lineMap(diff)).flatMap(([path, v]) => [
    { path, line: v.lines.at(-1), body: `on ${path}` },
    { path, line: 99_999, body: `off a line of ${path}` },
  ]),
  { path: "not/in/the/diff.ts", line: 3, body: "elsewhere" },
  { body: "no path" },
];

test("review diff: a small PR's comments snap the same from GitHub's files API as from its diff media type", () => {
  // Both read from GitHub for one real PR (clockgrove/factory#2542): the diff, and the files API's listing of it.
  const github = fixture("pr-small.diff");
  const fromFiles = filesDiff(JSON.parse(fixture("pr-small-files.json")));
  assert.deepEqual(lineMap(fromFiles), lineMap(github));
  assert.ok(Object.keys(lineMap(github)).length >= 5);
  const findings = findingsFor(github);
  assert.deepEqual(snapComments(findings, fromFiles), snapComments(findings, github));
});

/** A real git repository: a base, a branch with every kind of change, and a default branch that moved on after it. */
function repoWithBranch() {
  const dir = mkdtempSync(join(tmpdir(), "review-diff-"));
  const g = (...args) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }).trim();
  const put = (path, text) => writeFileSync(join(dir, path), text);
  const lines = (n, tag = "") => Array.from({ length: n }, (_, i) => `line ${i + 1}${tag}`).join("\n") + "\n";
  g("init", "-q", "-b", "main");
  put("keep.txt", lines(40));
  put("gone.txt", lines(10));
  put("moved.txt", lines(30));
  put("same.txt", lines(12, " same"));
  put("other.txt", lines(5));
  g("add", "-A");
  g("commit", "-q", "-m", "base");
  g("checkout", "-q", "-b", "feature");
  put("keep.txt", lines(40).replace("line 20\n", "line 20 changed\n").replace("line 3\n", ""));
  put("added.txt", lines(4, " new"));
  put("blob.bin", Buffer.from([0, 1, 2, 3, 0, 255]));
  g("rm", "-q", "gone.txt");
  g("mv", "moved.txt", "renamed.txt");
  put("renamed.txt", lines(30).replace("line 29\n", "line 29 edited\n"));
  g("mv", "same.txt", "same-renamed.txt");
  g("add", "-A");
  g("commit", "-q", "-m", "feature");
  const head = g("rev-parse", "HEAD");
  g("checkout", "-q", "main");
  put("other.txt", lines(5).replace("line 2\n", "line 2 on main after the branch\n"));
  g("commit", "-q", "-am", "main moves on");
  const base = g("rev-parse", "HEAD");
  const mgit = (args, opts = {}) => exec("git", ["-C", dir, ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }, ...opts });
  return { dir, g, base, head, mgit };
}

test("review diff: from history it is the PR's three-dot diff, and snaps the same as one made from per-file patches", async () => {
  const { dir, g, base, head, mgit } = repoWithBranch();
  try {
    const diff = await mirrorDiff(mgit, base, head, { mergeBase: true });
    const mb = g("merge-base", base, head);
    assert.equal(diff, g("diff", "--no-color", "--no-ext-diff", "--no-textconv", mb, head) + "\n", "from the merge base to the head");
    assert.ok(!diff.includes("other.txt"), "what the default branch did after the branch point is not the PR's");
    assert.deepEqual(Object.keys(lineMap(diff)).sort(), ["added.txt", "keep.txt", "renamed.txt"], "deletions, binaries and pure renames take no comment");
    // The files API's listing of the same change: status, names and each file's hunks (GitHub's `patch`).
    const listing = g("diff", "--name-status", "-M", mb, head).split("\n").map((l) => {
      const [code, a, b] = l.split("\t");
      const status = { M: "modified", A: "added", D: "deleted", R: "renamed" }[code[0]];
      const file = { filename: b || a, status: status === "deleted" ? "removed" : status, ...(b ? { previous_filename: a } : {}) };
      const patch = g("diff", "-M", mb, head, "--", ...(b ? [a, b] : [a])).split("\n");
      const at = patch.findIndex((x) => x.startsWith("@@"));
      if (at >= 0) file.patch = patch.slice(at).join("\n");
      if (code === "R100") file.changes = 0;
      return file;
    });
    const fromFiles = filesDiff(listing);
    assert.deepEqual(lineMap(fromFiles), lineMap(diff));
    const findings = [...findingsFor(diff), { path: "gone.txt", line: 2, body: "on a deleted file" }, { path: "blob.bin", line: 1, body: "on a binary" }];
    assert.deepEqual(snapComments(findings, fromFiles), snapComments(findings, diff));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("review diff: a commit missing from the mirror that cannot be fetched throws, so the caller falls back", async () => {
  const { dir, base, mgit } = repoWithBranch();
  try {
    await assert.rejects(mirrorDiff(mgit, base, "f".repeat(40), { mergeBase: true }), /could not be fetched/);
    await assert.rejects(mirrorDiff(mgit, "HEAD", base, { mergeBase: true }), /not a commit id/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("review diff: past GitHub's 300-file diff limit, the files API's pages make the diff; a file without a patch takes no comment", () => {
  // The shape of an adopter PR with 406 files, mostly deletions, one too large for a patch.
  const files = [
    ...Array.from({ length: 404 }, (_, i) => ({ filename: `old/f${i}.txt`, status: "removed", changes: 3, patch: "@@ -1,3 +0,0 @@\n-a\n-b\n-c" })),
    { filename: "big.json", status: "modified", changes: 90_000 },
    { filename: "src/kept.ts", status: "modified", changes: 2, patch: "@@ -4,3 +4,3 @@ x\n ctx\n-old\n+new\n ctx" },
  ];
  const diff = filesDiff(files);
  assert.equal(diff.match(/^diff --git /gm).length, 406);
  assert.deepEqual(lineMap(diff), { "src/kept.ts": { first: 5, lines: [4, 5, 6] } });
  assert.match(diff, /^\+\+\+ b\/big\.json\n\(GitHub lists this file without a patch/m);
  assert.deepEqual(snapComments([{ path: "big.json", line: 10, body: "x" }, { path: "old/f1.txt", line: 1, body: "y" }, { path: "src/kept.ts", line: 6, body: "z" }], diff), [
    { path: "src/kept.ts", line: 5, side: "RIGHT", body: "**Finding on `big.json` line 10**, which this PR's diff does not show, so it is placed here:\n\nx", at: { path: "big.json", line: 10, body: "x" } },
    { path: "src/kept.ts", line: 5, side: "RIGHT", body: "**Finding on `old/f1.txt` line 1**, which this PR's diff does not show, so it is placed here:\n\ny", at: { path: "old/f1.txt", line: 1, body: "y" } },
    { path: "src/kept.ts", line: 6, side: "RIGHT", body: "z" },
  ]);
  assert.equal(filesDiff([]), "");
});

test("review diff: prDiff uses history when it can, else every page of the files API", async () => {
  const realFetch = globalThis.fetch;
  const asked = [];
  const page = (n) => Array.from({ length: n }, (_, i) => ({ filename: `d/f${asked.length}-${i}.txt`, status: "removed", changes: 1, patch: "@@ -1 +0,0 @@\n-x" }));
  globalThis.fetch = async (url) => {
    const u = String(url);
    asked.push(u);
    const next = asked.length < 5 ? { link: `<https://api.github.com/repositories/1/pulls/7/files?per_page=100&page=${asked.length + 1}>; rel="next"` } : {};
    return new Response(JSON.stringify(asked.length < 5 ? page(100) : [...page(5), { filename: "src/a.ts", status: "added", changes: 1, patch: "@@ -0,0 +1 @@\n+a" }]), { status: 200, headers: { "content-type": "application/json", ...next } });
  };
  const repo = { full: "o/r", owner: "o", name: "r" };
  const pr = { number: 7, changed_files: 3100, base: { sha: "b".repeat(40) }, head: { sha: "c".repeat(40) } };
  try {
    const seen = [];
    const fromHistory = await prDiff(repo, pr, { token: "t" }, { diffOf: async (b, h) => (seen.push([b, h]), "diff --git a/x b/x\n") });
    assert.deepEqual(fromHistory, { text: "diff --git a/x b/x\n", source: "history", historyError: "", unlisted: 0, unpatched: 0 });
    assert.deepEqual(seen, [[pr.base.sha, pr.head.sha]]);
    assert.equal(asked.length, 0, "no API call when history makes the diff");
    const fallback = await prDiff(repo, pr, { token: "t" }, { diffOf: async () => { throw new Error("commit ccccccc could not be fetched"); } });
    assert.equal(asked.length, 5);
    assert.match(asked[0], /\/repos\/o\/r\/pulls\/7\/files\?per_page=100$/);
    assert.equal(fallback.source, "files");
    assert.equal(fallback.historyError, "commit ccccccc could not be fetched");
    assert.equal(fallback.unpatched, 0, "every listed file carries its patch");
    assert.equal(fallback.text.match(/^diff --git /gm).length, 406);
    assert.equal(fallback.unlisted, 3100 - 406);
    assert.deepEqual(lineMap(fallback.text), { "src/a.ts": { first: 1, lines: [1] } });
    asked.length = 0;
    assert.equal((await prDiff(repo, { ...pr, changed_files: 406 }, { token: "t" })).historyError, "no local history");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("review diff: the reviewer's prompt carries the whole diff up to the cap, then whole files only, with a count of the rest", () => {
  const file = (i) => `diff --git a/f${i} b/f${i}\n--- a/f${i}\n+++ b/f${i}\n@@ -1 +1 @@\n-a\n+${"x".repeat(80)}\n`;
  const diff = Array.from({ length: 10 }, (_, i) => file(i)).join("");
  assert.equal(promptDiff(diff), diff);
  assert.equal(promptDiff(diff, diff.length), diff);
  const cut = promptDiff(diff, file(0).length * 3 + 5);
  assert.ok(cut.startsWith(file(0) + file(1) + file(2)));
  assert.match(cut, /\(the diff is cut here at \d+ of \d+ characters; 7 file\(s\) are not shown in full/);
  assert.ok(!cut.includes("diff --git a/f3 "));
  assert.match(promptDiff(file(0), 40), /^diff --git a\/f0 b\/f0\n--- a\/f0\n\+\+\+ b\/f0\n\(the diff is cut here at 39 of \d+ characters; 1 file\(s\)/, "a first file alone over the cap is cut at a line");
});

test("review diff: a diff over maxBytes throws (exec says it cut the output), so prDiff falls back to the files API", async () => {
  const { dir, base, head, mgit } = repoWithBranch();
  const realFetch = globalThis.fetch;
  try {
    const whole = await mirrorDiff(mgit, base, head, { mergeBase: true });
    assert.equal((await exec("git", ["-C", dir, "diff", base, head], { maxBytes: 10 })).truncated, true);
    assert.equal((await exec("git", ["-C", dir, "diff", base, head])).truncated, false);
    await assert.rejects(mirrorDiff(mgit, base, head, { mergeBase: true, maxBytes: whole.length - 1 }), /the diff is over \d+ bytes/);
    assert.equal(await mirrorDiff(mgit, base, head, { mergeBase: true, maxBytes: whole.length }), whole);
    globalThis.fetch = async () => new Response(JSON.stringify([{ filename: "a.ts", status: "added", changes: 1, patch: "@@ -0,0 +1 @@\n+a" }]), { status: 200, headers: { "content-type": "application/json" } });
    const prd = await prDiff({ full: "o/r" }, { number: 1, changed_files: 1, base: { sha: base }, head: { sha: head } }, { token: "t" }, { diffOf: (b, h) => mirrorDiff(mgit, b, h, { mergeBase: true, maxBytes: 100 }) });
    assert.equal(prd.source, "files");
    assert.equal(prd.historyError, "the diff is over 100 bytes");
  } finally {
    globalThis.fetch = realFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});

const NOTE = (at) => `**Finding on ${at}**, where GitHub takes no line comment, so it is placed here:\n\n`;

test("review diff: a comment GitHub cannot place (no patch, or a line outside the hunk) moves to a line it takes, with a note naming its own file and line", () => {
  const files = [
    { filename: "src/a.ts", status: "modified", changes: 2, patch: "@@ -4,3 +4,4 @@ x\n ctx\n-old\n+new\n+more\n ctx" },
    { filename: "big.json", status: "added", changes: 40_000 },
    { filename: "old.txt", status: "removed", changes: 2, patch: "@@ -1,2 +0,0 @@\n-a\n-b" },
    { filename: "src/b.ts", status: "modified", changes: 1, patch: "@@ -1,2 +1,2 @@\n-x\n+y\n z" },
  ];
  const comments = [
    { path: "src/a.ts", line: 5, side: "RIGHT", body: "on a changed line" },
    { path: "src/a.ts", line: 7, side: "RIGHT", body: "on context" },
    { path: "src/a.ts", line: 9, side: "RIGHT", body: "past the hunk" },
    { path: "big.json", line: 100, side: "RIGHT", body: "on a file with no patch" },
    { path: "big.json", line: 6, side: "RIGHT", body: "no patch, a line the first file shows" },
    { path: "old.txt", line: 1, side: "RIGHT", body: "on a deleted file" },
    { path: "src/b.ts", line: 40, side: "RIGHT", body: "outside b's hunk" },
  ];
  const { inline, moved, aside } = fitToFiles(comments, files);
  assert.deepEqual(aside, []);
  assert.equal(moved, 5);
  assert.deepEqual(inline.map((c) => [c.path, c.line, c.body]), [
    ["src/a.ts", 5, "on a changed line"],
    ["src/a.ts", 7, "on context"],
    ["src/a.ts", 5, `${NOTE("`src/a.ts` line 9")}past the hunk`],
    ["src/a.ts", 5, `${NOTE("`big.json` line 100")}on a file with no patch`],
    ["src/a.ts", 6, `${NOTE("`big.json` line 6")}no patch, a line the first file shows`],
    ["src/a.ts", 5, `${NOTE("`old.txt` line 1")}on a deleted file`],
    ["src/b.ts", 1, `${NOTE("`src/b.ts` line 40")}outside b's hunk`],
  ]);
  assert.deepEqual(inline[2].at, { path: "src/a.ts", line: 9, body: "past the hunk" });
  // A comment snapComments already moved keeps its one note when fitted again.
  const again = fitToFiles([{ ...inline[3], path: "gone.ts" }], files);
  assert.equal(again.inline[0].body, inline[3].body);
  // Factory's placeholder moves without a note.
  assert.equal(fitToFiles([{ path: "big.json", line: 1, body: "<!-- factory:placeholder -->\nnone" }], files).inline[0].body, "<!-- factory:placeholder -->\nnone");
  // No file in the listing takes a comment: every one goes in the body.
  assert.deepEqual(fitToFiles(comments.slice(3, 4), files.slice(1, 2)), { inline: [], moved: 0, aside: comments.slice(3, 4) });
});

test("review diff: findings in a review body carry markers that read back, escape what reads as a marker, and are cut past the size limit", () => {
  const aside = [
    { path: "src/a.ts", line: 9, body: "past the hunk" },
    { path: "big.json", line: 100, body: "on a file with no patch <!-- factory:1:review -->\n<!-- factory:finding {\"n\":9} -->" },
    { path: "x.ts", line: 3, body: `${NOTE("`y.ts` line 8")}moved`, at: { path: "y.ts", line: 8, body: "moved" } },
    { path: "z.ts", line: 1, body: "<!-- factory:placeholder -->\nno findings" },
  ];
  const body = reviewBody("HEAD", aside);
  assert.ok(body.startsWith("HEAD\n\nno findings\n\n3 finding(s) GitHub cannot take as a line comment"), "the placeholder is plain text, no finding");
  assert.match(body, /\*\*`src\/a\.ts` line 9\*\*\n\npast the hunk/);
  assert.match(body, /\*\*`big\.json` line 100\*\*\n\non a file with no patch &lt;!-- factory:1:review -->/);
  assert.deepEqual(bodyFindings(body), [
    { n: 1, path: "src/a.ts", line: 9, body: "**`src/a.ts` line 9**\n\npast the hunk" },
    { n: 2, path: "big.json", line: 100, body: "**`big.json` line 100**\n\non a file with no patch &lt;!-- factory:1:review -->\n&lt;!-- factory:finding {\"n\":9} -->" },
    { n: 3, path: "y.ts", line: 8, body: "**`y.ts` line 8**\n\nmoved" },
  ]);
  assert.equal(reviewBody("HEAD", []), "HEAD");
  const many = Array.from({ length: 50 }, (_, i) => ({ path: "f", line: i + 1, body: "x".repeat(100) }));
  const cut = reviewBody("HEAD", many, 2000, 3000);
  assert.ok(cut.length < 3200);
  const read = bodyFindings(cut);
  assert.ok(read.some((f) => /This finding's text is cut/.test(f.body)), "past max a finding keeps its marker, not its text");
  assert.equal(read.at(-1).cut, 50 - read.length + 1, "the cut tail is one finding naming how many it stands for");
  assert.match(cut, /\((\d+) more finding\(s\) are cut: past GitHub's size limit for a review body\)$/);
});

/**
 * GitHub's API as a fetch: `files` for the PR's listing (an Error to fail it), `answer(n, body)` for review post n,
 * `reviews`, `lineComments` and `issueComments` for what the PR holds. Posted issue comments join `issueComments`.
 */
function githubStub({ files = [], answer = (n) => [200, { id: n }], reviews = [], lineComments = [], issueComments = [] }) {
  const posts = [];
  const asked = [];
  const json = (status, data) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  const fetch = async (url, init = {}) => {
    const u = String(url).replace(/^https:\/\/api\.github\.com/, "");
    const method = init.method || "GET";
    asked.push(`${method} ${u}`);
    if (method === "GET" && /\/pulls\/7\/files\?per_page=100$/.test(u)) return files instanceof Error ? json(500, { message: "boom" }) : json(200, files);
    if (method === "GET" && /\/pulls\/7\/reviews\?per_page=100$/.test(u)) return json(200, reviews);
    if (method === "GET" && /\/pulls\/7\/comments\?per_page=100$/.test(u)) return json(200, lineComments);
    if (method === "GET" && /\/issues\/7\/comments\?per_page=100$/.test(u)) return json(200, issueComments);
    if (method === "POST" && /\/issues\/7\/comments$/.test(u)) {
      const c = { id: 900 + issueComments.length, user: { login: "factory[bot]" }, body: JSON.parse(init.body).body };
      issueComments.push(c);
      return json(201, c);
    }
    if (method === "POST" && /\/pulls\/7\/reviews$/.test(u)) {
      const body = JSON.parse(init.body);
      posts.push(body);
      const [status, data] = answer(posts.length, body);
      return json(status, data);
    }
    return json(404, { message: "Not Found" });
  };
  return { fetch, posts, asked };
}

const repo7 = { full: "o/r", owner: "o", name: "r" };
const files7 = [
  { filename: "src/a.ts", status: "modified", changes: 2, patch: "@@ -4,3 +4,3 @@ x\n ctx\n-old\n+new\n ctx" },
  { filename: "big.json", status: "added", changes: 40_000 },
];
const comments7 = [
  { path: "src/a.ts", line: 5, side: "RIGHT", body: "fine" },
  { path: "big.json", line: 10, side: "RIGHT", body: "no patch" },
];
const review7 = { body: "<!-- factory:7:review -->\nFactory reviewer: one comment-only pass, 2 comment(s).", comments: comments7, commitId: "c".repeat(40) };
// GitHub's answer to a line comment on a file it lists without a patch (clockgrove/factory-scratch#238).
const tooLarge = [422, { message: "Unprocessable Entity", errors: ["Diff entry big.json diff is too large"] }];
const refusesBig = (n, b) => (b.comments.some((c) => c.path === "big.json") ? tooLarge : [200, { id: n }]);

test("review diff: postReview moves what GitHub cannot place to a line it takes, and retries once all in the body on a 422", async () => {
  const realFetch = globalThis.fetch;
  try {
    // The listing says big.json takes no line comment: it moves to src/a.ts with its note, one post, nothing in the body.
    let gh = githubStub({ files: files7, answer: refusesBig });
    globalThis.fetch = gh.fetch;
    const placed = await postReview(repo7, 7, review7, { token: "t" });
    assert.deepEqual(placed, { review: { id: 1 }, inline: 2, moved: 1, inBody: 0, retried: 0, sent: gh.posts[0].comments });
    assert.equal(gh.posts.length, 1);
    assert.deepEqual(gh.posts[0].comments, [comments7[0], { path: "src/a.ts", line: 5, side: "RIGHT", body: `${NOTE("`big.json` line 10")}no patch` }], "Factory's own fields stay off GitHub's call");
    assert.equal(gh.posts[0].event, "COMMENT");
    assert.equal(gh.posts[0].commit_id, "c".repeat(40));
    assert.equal(gh.posts[0].body, review7.body);

    // No listing (the API failed): every comment is tried where it is; GitHub's 422 sends them all to the body, once.
    gh = githubStub({ files: new Error("x"), answer: refusesBig });
    globalThis.fetch = gh.fetch;
    assert.deepEqual(await postReview(repo7, 7, review7, { token: "t" }), { review: { id: 2 }, inline: 0, moved: 0, inBody: 2, retried: 422, sent: [] });
    assert.equal(gh.posts.length, 2);
    assert.deepEqual(gh.posts[0].comments, comments7);
    assert.deepEqual(gh.posts[1].comments, []);
    assert.deepEqual(bodyFindings(gh.posts[1].body).map((f) => [f.n, f.path, f.line]), [[1, "src/a.ts", 5], [2, "big.json", 10]]);

    // A 422 for a line the listing showed (GitHub moved on): the same one retry; a moved finding is set out at its own place.
    const moved = snapComments([{ path: "gone.ts", line: 3, body: "on a file the diff lost" }], "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -4,3 +4,3 @@\n ctx\n-old\n+new\n ctx\n");
    gh = githubStub({ files: files7, answer: (n) => (n === 1 ? [422, { message: "Unprocessable Entity", errors: ["Line could not be resolved"] }] : [200, { id: n }]) });
    globalThis.fetch = gh.fetch;
    assert.equal((await postReview(repo7, 7, { ...review7, comments: moved }, { token: "t" })).retried, 422);
    assert.equal(gh.posts.length, 2);
    assert.deepEqual(bodyFindings(gh.posts[1].body), [{ n: 1, path: "gone.ts", line: 3, body: "**`gone.ts` line 3**\n\non a file the diff lost" }]);

    // No file in the listing takes a comment: the findings go in the body on the first post.
    gh = githubStub({ files: files7.slice(1) });
    globalThis.fetch = gh.fetch;
    assert.deepEqual(await postReview(repo7, 7, review7, { token: "t" }), { review: { id: 1 }, inline: 0, moved: 0, inBody: 2, retried: 0, sent: [] });
    assert.equal(bodyFindings(gh.posts[0].body).length, 2);

    // Only one retry, and none for another status (a transient error requeues the job, as before).
    gh = githubStub({ files: new Error("x"), answer: () => tooLarge });
    globalThis.fetch = gh.fetch;
    await assert.rejects(postReview(repo7, 7, review7, { token: "t" }), (e) => e.status === 422);
    assert.equal(gh.posts.length, 2);
    gh = githubStub({ files: files7, answer: () => [502, { message: "Bad Gateway" }] });
    globalThis.fetch = gh.fetch;
    await assert.rejects(postReview(repo7, 7, review7, { token: "t" }), (e) => e.status === 502);
    assert.equal(gh.posts.length, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("review diff: a diff that only deletes still gets every finding posted and counted, in the review body or on context", async () => {
  const gone = "diff --git a/old.ts b/old.ts\ndeleted file mode 100644\n--- a/old.ts\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-a\n-b\n";
  const cut = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -4,4 +4,3 @@\n ctx\n-old\n ctx\n ctx\n";
  const findings = [{ path: "old.ts", line: 2, body: "a caller still imports this" }, { path: "./src/a.ts", line: 40, body: "off the hunk" }, { body: "no place named" }];
  // Nothing on the right side: unplaced, each with its own path and line.
  assert.deepEqual(snapComments(findings, gone), [
    { path: "old.ts", line: 2, side: "RIGHT", body: "a caller still imports this" },
    { path: "src/a.ts", line: 40, side: "RIGHT", body: "off the hunk" },
    { path: null, line: null, side: "RIGHT", body: "no place named" },
  ]);
  // Context lines take comments: a hunk that only deletes keeps its findings as line comments.
  assert.deepEqual(snapComments(findings, cut).map((c) => [c.path, c.line, c.body.split("\n")[0]]), [
    ["src/a.ts", 4, "**Finding on `old.ts` line 2**, which this PR's diff does not show, so it is placed here:"],
    ["src/a.ts", 4, "**Finding on `src/a.ts` line 40**, which this PR's diff does not show, so it is placed here:"],
    ["src/a.ts", 4, "no place named"],
  ]);
  const realFetch = globalThis.fetch;
  setSelf("factory[bot]");
  try {
    // GitHub lists the deleted file with a patch of removed lines only: every finding goes in the body, on the first post.
    const listing = [{ filename: "old.ts", status: "removed", changes: 2, patch: "@@ -1,2 +0,0 @@\n-a\n-b" }];
    const comments = snapComments(findings, gone);
    let gh = githubStub({ files: listing });
    globalThis.fetch = gh.fetch;
    const review = { body: "<!-- factory:7:review -->\nFactory reviewer: one comment-only pass, 3 comment(s).", comments, commitId: "c".repeat(40) };
    assert.deepEqual(await postReview(repo7, 7, review, { token: "t" }), { review: { id: 1 }, inline: 0, moved: 0, inBody: 3, retried: 0, sent: [] });
    assert.deepEqual(gh.posts[0].comments, []);
    assert.deepEqual(bodyFindings(gh.posts[0].body).map((f) => [f.n, f.path, f.line]), [[1, "old.ts", 2], [2, "src/a.ts", 40], [3, "", null]]);
    assert.match(gh.posts[0].body, /\*\*the PR as a whole \(no file named\)\*\*\n\nno place named/);
    // They count until answered: the deletion-only PR does not go to merge with them unseen.
    gh = githubStub({ reviews: [{ id: 1, user: { login: "factory[bot]" }, body: gh.posts[0].body }] });
    globalThis.fetch = gh.fetch;
    const open = await unaddressedReviewComments(repo7, 7, null, { token: "t", reviewIds: new Set([1]) });
    assert.deepEqual(open.map((c) => c.id), ["r1-1", "r1-2", "r1-3"]);
    assert.match(answerPrompt({ taskCard: "", prNumber: 7, comments: open.map((c) => ({ id: c.id, path: c.path, line: c.line, body: c.body })) }), /^- \(review body\) \(comment id "r1-3"\)/m);
    // No listing: what has no file and line goes in the body at once; no 422 round trip for it.
    gh = githubStub({ files: new Error("x") });
    globalThis.fetch = gh.fetch;
    const placeholder = [{ path: null, line: null, side: "RIGHT", body: "<!-- factory:placeholder -->\nFactory reviewer: no findings; the pass ran and returned nothing line-tied." }];
    assert.deepEqual(await postReview(repo7, 7, { ...review, comments: placeholder }, { token: "t" }), { review: { id: 1 }, inline: 0, moved: 0, inBody: 0, retried: 0, sent: [] });
    assert.equal(gh.posts.length, 1);
    assert.deepEqual(gh.posts[0].comments, []);
    assert.match(gh.posts[0].body, /\n\nFactory reviewer: no findings; the pass ran and returned nothing line-tied\.$/);
    assert.deepEqual(bodyFindings(gh.posts[0].body), []);
  } finally {
    setSelf(null);
    globalThis.fetch = realFetch;
  }
});

test("review diff: findings a 422 put in the review body count as unaddressed, reach the answer pass and are answered once", async () => {
  const realFetch = globalThis.fetch;
  setSelf("factory[bot]");
  try {
    // The 422 retry's review, as GitHub stores it.
    let gh = githubStub({ files: new Error("x"), answer: refusesBig });
    globalThis.fetch = gh.fetch;
    await postReview(repo7, 7, review7, { token: "t" });
    const stored = { id: 2, user: { login: "factory[bot]" }, body: gh.posts[1].body };
    // A stranger's copy of the same body, and a stranger's reply marker: neither counts.
    const forged = { id: 3, user: { login: "mallory" }, author_association: "NONE", body: stored.body };
    const issueComments = [{ id: 50, user: { login: "mallory" }, author_association: "NONE", body: `<!-- factory:7:reply:${bodyFindingId(2, 1)} -->\nanswered` }];
    gh = githubStub({ reviews: [stored, forged], issueComments });
    globalThis.fetch = gh.fetch;
    for (const reviewIds of [new Set([2]), null]) {
      const open = await unaddressedReviewComments(repo7, 7, null, { token: "t", reviewIds });
      assert.deepEqual(open.map((c) => [c.id, c.path, c.line]), [["r2-1", "src/a.ts", 5], ["r2-2", "big.json", 10]]);
      assert.match(open[1].body, /no patch$/);
    }
    // The answer pass's replies.json names them by those ids; Factory answers each once, in a PR comment.
    const allowed = ["r2-1", "r2-2", 11];
    const text = JSON.stringify([{ id: "r2-1", body: "fixed in abc" }, { id: "r2-1", body: "twice" }, { id: 11, body: "ok" }, { id: "r9-9", body: "not given" }]);
    assert.deepEqual(parseReplies(text, allowed), [{ id: "r2-1", body: "fixed in abc" }, { id: 11, body: "ok" }]);
    assert.equal(await postReplies(repo7, 7, 7, JSON.stringify([{ id: "r2-1", body: "fixed in abc" }]), allowed, { token: "t" }), 1);
    assert.match(issueComments.at(-1).body, /^<!-- factory:7:reply:r2-1 -->\n/);
    const open = await unaddressedReviewComments(repo7, 7, null, { token: "t", reviewIds: new Set([2]) });
    assert.deepEqual(open.map((c) => c.id), ["r2-2"]);
    // A PR with no finding in a body makes no extra call for the PR's comments.
    gh = githubStub({ reviews: [{ id: 4, user: { login: "factory[bot]" }, body: review7.body }] });
    globalThis.fetch = gh.fetch;
    assert.deepEqual(await unaddressedReviewComments(repo7, 7, null, { token: "t", reviewIds: new Set([4]) }), []);
    assert.ok(!gh.asked.some((a) => a.includes("/issues/7/comments")));
  } finally {
    setSelf(null);
    globalThis.fetch = realFetch;
  }
});
