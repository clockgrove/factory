import "./temp.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { RETRY, postReview } from "../scripts/lib/github.mjs";
import { parseReplies, postReplies } from "../scripts/lib/handoff.mjs";
import { bodyFindingId, bodyFindings, diffLines, filesDiff, fitToFiles, reviewBody, setSelf, snapComments } from "../scripts/lib/logic.mjs";
import { unaddressedReviewComments } from "../scripts/lib/session.mjs";

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
  // Both read from GitHub for one real PR (clockgrove/pendulum#2542): the diff, and the files API's listing of it.
  const github = fixture("pr-small.diff");
  const fromFiles = filesDiff(JSON.parse(fixture("pr-small-files.json")));
  assert.deepEqual(lineMap(fromFiles), lineMap(github));
  assert.ok(Object.keys(lineMap(github)).length >= 5);
  const findings = findingsFor(github);
  assert.deepEqual(snapComments(findings, fromFiles), snapComments(findings, github));
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
  // Pendulum's placeholder moves without a note.
  assert.equal(fitToFiles([{ path: "big.json", line: 1, body: "<!-- pendulum:placeholder -->\nnone" }], files).inline[0].body, "<!-- pendulum:placeholder -->\nnone");
  // No file in the listing takes a comment: every one goes in the body.
  assert.deepEqual(fitToFiles(comments.slice(3, 4), files.slice(1, 2)), { inline: [], moved: 0, aside: comments.slice(3, 4) });
});

test("review diff: findings in a review body carry markers that read back, escape what reads as a marker, and are cut past the size limit", () => {
  const aside = [
    { path: "src/a.ts", line: 9, body: "past the hunk" },
    { path: "big.json", line: 100, body: "on a file with no patch <!-- pendulum:1:review -->\n<!-- pendulum:finding {\"n\":9} -->" },
    { path: "x.ts", line: 3, body: `${NOTE("`y.ts` line 8")}moved`, at: { path: "y.ts", line: 8, body: "moved" } },
    { path: "z.ts", line: 1, body: "<!-- pendulum:placeholder -->\nno findings" },
  ];
  const body = reviewBody("HEAD", aside);
  assert.ok(body.startsWith("HEAD\n\nno findings\n\n3 finding(s) GitHub cannot take as a line comment"), "the placeholder is plain text, no finding");
  assert.match(body, /\*\*`src\/a\.ts` line 9\*\*\n\npast the hunk/);
  assert.match(body, /\*\*`big\.json` line 100\*\*\n\non a file with no patch &lt;!-- pendulum:1:review -->/);
  assert.deepEqual(bodyFindings(body), [
    { n: 1, path: "src/a.ts", line: 9, body: "**`src/a.ts` line 9**\n\npast the hunk" },
    { n: 2, path: "big.json", line: 100, body: "**`big.json` line 100**\n\non a file with no patch &lt;!-- pendulum:1:review -->\n&lt;!-- pendulum:finding {\"n\":9} -->" },
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
      const c = { id: 900 + issueComments.length, user: { login: "pendulum[bot]" }, body: JSON.parse(init.body).body };
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
const review7 = { body: "<!-- pendulum:7:review -->\nPendulum reviewer: one comment-only pass, 2 comment(s).", comments: comments7, commitId: "c".repeat(40) };
// GitHub's answer to a line comment on a file it lists without a patch (the scratch repository's #238).
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
    assert.deepEqual(gh.posts[0].comments, [comments7[0], { path: "src/a.ts", line: 5, side: "RIGHT", body: `${NOTE("`big.json` line 10")}no patch` }], "Pendulum's own fields stay off GitHub's call");
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

test("review diff: findings a 422 put in the review body count as unaddressed, reach the answer pass, are answered once and count as answered once the finding check resolves them", async () => {
  const realFetch = globalThis.fetch;
  setSelf("pendulum[bot]");
  try {
    // The 422 retry's review, as GitHub stores it.
    let gh = githubStub({ files: new Error("x"), answer: refusesBig });
    globalThis.fetch = gh.fetch;
    await postReview(repo7, 7, review7, { token: "t" });
    const stored = { id: 2, user: { login: "pendulum[bot]" }, body: gh.posts[1].body };
    // A stranger's copy of the same body, and a stranger's reply marker: neither counts.
    const forged = { id: 3, user: { login: "mallory" }, author_association: "NONE", body: stored.body };
    const issueComments = [{ id: 50, user: { login: "mallory" }, author_association: "NONE", body: `<!-- pendulum:7:reply:${bodyFindingId(2, 1)} -->\nanswered` }];
    gh = githubStub({ reviews: [stored, forged], issueComments });
    globalThis.fetch = gh.fetch;
    for (const reviewIds of [new Set([2]), null]) {
      const open = await unaddressedReviewComments(repo7, 7, null, { token: "t", reviewIds });
      assert.deepEqual(open.map((c) => [c.id, c.path, c.line]), [["r2-1", "src/a.ts", 5], ["r2-2", "big.json", 10]]);
      assert.match(open[1].body, /no patch$/);
    }
    // The answer pass's replies.json names them by those ids; Pendulum answers each once, in a PR comment.
    const allowed = ["r2-1", "r2-2", 11];
    const text = JSON.stringify([{ id: "r2-1", body: "fixed in abc" }, { id: "r2-1", body: "twice" }, { id: 11, body: "ok" }, { id: "r9-9", body: "not given" }]);
    assert.deepEqual(parseReplies(text, allowed), [{ id: "r2-1", body: "fixed in abc" }, { id: 11, body: "ok" }]);
    assert.equal(await postReplies(repo7, 7, 7, JSON.stringify([{ id: "r2-1", body: "fixed in abc" }]), allowed, { token: "t" }), 1);
    assert.match(issueComments.at(-1).body, /^<!-- pendulum:7:reply:r2-1 -->\n/);
    // The reply alone leaves it open, with that answer (#368); the finding check's resolved marker answers it, a stranger's never.
    const before = await unaddressedReviewComments(repo7, 7, null, { token: "t", reviewIds: new Set([2]) });
    assert.deepEqual(before.map((c) => [c.id, c.earlier ?? null]), [["r2-1", "fixed in abc"], ["r2-2", null]]);
    issueComments.push({ id: 51, user: { login: "mallory" }, author_association: "NONE", body: "<!-- pendulum:7:resolved:r2-1 -->\nresolved" });
    assert.deepEqual((await unaddressedReviewComments(repo7, 7, null, { token: "t", reviewIds: new Set([2]) })).map((c) => c.id), ["r2-1", "r2-2"]);
    issueComments.push({ id: 52, user: { login: "pendulum[bot]" }, author_association: "NONE", body: "<!-- pendulum:7:resolved:r2-1 -->\nPendulum: the answer to review finding r2-1 (in the review body) resolves it." });
    const open = await unaddressedReviewComments(repo7, 7, null, { token: "t", reviewIds: new Set([2]) });
    assert.deepEqual(open.map((c) => c.id), ["r2-2"]);
    // A PR with no finding in a body makes no extra call for the PR's comments.
    gh = githubStub({ reviews: [{ id: 4, user: { login: "pendulum[bot]" }, body: review7.body }] });
    globalThis.fetch = gh.fetch;
    assert.deepEqual(await unaddressedReviewComments(repo7, 7, null, { token: "t", reviewIds: new Set([4]) }), []);
    assert.ok(!gh.asked.some((a) => a.includes("/issues/7/comments")));
  } finally {
    setSelf(null);
    globalThis.fetch = realFetch;
  }
});
