// #605: a MEMBER or COLLABORATOR author association says only that a person belongs to the organization or was added
// to the repository: a read-only member, or a read- or triage-role collaborator, has one without write access. Pendulum
// counts such an author as someone who can push only once GitHub's permission read says write, read at most once per
// login and within a bound; a read that fails trusts nobody.
import "./temp.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { RETRY, listComments, reviewThreads, verifyAuthors } from "../scripts/lib/github.mjs";
import { AUTHOR_READS_MAX, marker, reviewBody, setSelf, setWriters, trustedAuthor } from "../scripts/lib/logic.mjs";
import { unaddressedReviewComments } from "../scripts/lib/session.mjs";
import { findingInput } from "../scripts/lib/finding-check.mjs";

RETRY.sleep = async () => {};
const SELF = "pendulum-app[bot]";
const REPO = { owner: "acme", name: "app", full: "acme/app" };
const app = { login: SELF, type: "Bot" };
const user = (login) => ({ login, type: "User" });

/**
 * GitHub for PR 12 of acme/app: its reviews, line comments, issue comments and review threads (GraphQL's shape), and
 * each login's permission (`permissions`: a login's answer, or a status to fail with). The writer list (`collaborators`)
 * names nobody: an App's token lists no one with organization-derived access. `reads` counts permission reads by login.
 */
function github({ reviews = [], lineComments = [], comments = [], threads = [], permissions = {} } = {}) {
  const reads = {};
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const p = u.pathname.replace("/repos/acme/app", "");
    const method = init.method || "GET";
    const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    let m;
    if (method === "POST" && u.pathname === "/graphql") return json({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: threads } } } } });
    if (method !== "GET") return json({ message: "Not Found" }, 404);
    if (u.pathname === "/user") return json({ login: SELF, type: "Bot" });
    if (p === "/pulls/12/reviews") return json(reviews);
    if (p === "/pulls/12/comments") return json(lineComments);
    if (p === "/issues/12/comments") return json(comments);
    if (p === "/collaborators") return json([]);
    if ((m = /^\/collaborators\/([^/]+)\/permission$/.exec(p))) {
      const login = decodeURIComponent(m[1]);
      reads[login] = (reads[login] || 0) + 1;
      const answer = permissions[login];
      if (typeof answer === "number") return json({ message: "Server Error" }, answer);
      return answer ? json({ permission: answer }) : json({ message: "Not Found" }, 404);
    }
    return json({ message: "Not Found" }, 404);
  };
  return { fetch, reads };
}

async function withGitHub(gh, fn) {
  const realFetch = globalThis.fetch;
  const before = process.env.GITHUB_API_URL;
  process.env.GITHUB_API_URL = "https://github.test";
  globalThis.fetch = gh.fetch;
  setSelf(SELF);
  // Each test starts with no writer list and no permission read in memory.
  setWriters(REPO.full, []);
  try {
    return await fn();
  } finally {
    setSelf(null);
    setWriters(null, []);
    globalThis.fetch = realFetch;
    if (before === undefined) delete process.env.GITHUB_API_URL;
    else process.env.GITHUB_API_URL = before;
  }
}

// A review carrying Pendulum's review marker, its findings in the body (as postReview sets out those GitHub took in no line).
const markedReview = (id, author, association) => ({ id, user: author, author_association: association, body: reviewBody(`${marker(7, "review")}\nPendulum reviewer: one comment-only pass.`, [{ path: "src/a.ts", line: 3, body: "FINDING, acceptance 1" }]), commit_id: "a".repeat(40) });

test("#605: a read-only MEMBER's review body with Pendulum's marker is not Pendulum's: its findings are nobody's to answer; a member who can write is trusted", async () => {
  const gh = github({ reviews: [markedReview(1, user("viewer"), "MEMBER"), markedReview(2, user("triager"), "COLLABORATOR")], permissions: { viewer: "read", triager: "triage" } });
  await withGitHub(gh, async () => {
    assert.deepEqual(await unaddressedReviewComments(REPO, 12, null, { token: "t" }), [], "local mode, where Pendulum's reviews are told by author: a read-only author's are none");
  });
  const writer = github({ reviews: [markedReview(3, user("dev"), "MEMBER")], permissions: { dev: "write" } });
  await withGitHub(writer, async () => {
    assert.deepEqual((await unaddressedReviewComments(REPO, 12, null, { token: "t" })).map((f) => f.id), ["r3-1"]);
  });
});

test("#605: a read-only MEMBER's thread is not a writer's: their review is not Pendulum's and their reply answers nothing; a writer's reply does", async () => {
  const review = (author, association) => ({ body: `${marker(7, "review")}\nPendulum's review`, authorAssociation: association, author });
  const root = (by) => ({ databaseId: 100, body: "acceptance 1: a finding", authorAssociation: "NONE", author: { __typename: "Bot", login: "pendulum-app" }, pullRequestReview: by });
  const reply = (login, body) => ({ databaseId: 101, body, authorAssociation: "MEMBER", author: { __typename: "User", login } });
  const thread = (id, by, replies = []) => ({ id, isResolved: false, path: "src/a.ts", line: 3, originalLine: 3, comments: { nodes: [root(by), ...replies] } });
  const ours = review({ __typename: "Bot", login: "pendulum-app" }, "NONE");
  const gh = github({
    threads: [thread("T_forged", review({ __typename: "User", login: "viewer" }, "MEMBER")), thread("T_viewer", ours, [reply("viewer", "Fine as is.")]), thread("T_dev", ours, [reply("dev", "Keep it: decided.")])],
    permissions: { viewer: "read", dev: "maintain" },
  });
  await withGitHub(gh, async () => {
    const byId = Object.fromEntries((await reviewThreads(REPO, 12, 7, { token: "t" })).map((t) => [t.id, t]));
    assert.equal(byId.T_forged.by, null, "a review a read-only member wrote with Pendulum's marker opens no thread of Pendulum's");
    assert.deepEqual([byId.T_viewer.by, byId.T_viewer.answered], ["ours", false], "a read-only member's reply answers nothing");
    assert.deepEqual([byId.T_dev.by, byId.T_dev.answered], ["ours", true], "a member who can write answers");
    assert.deepEqual(gh.reads, { viewer: 1, dev: 1 }, "each login's permission is read once");
  });
});

test("#605: a failed permission read fails closed: the author is not trusted, and is read again next time, within the bound", async () => {
  const restart = { id: 1, user: user("dev"), author_association: "COLLABORATOR", body: `${marker(7, "queue-red")}x` };
  const gh = github({ comments: [restart], permissions: { dev: 502 } });
  await withGitHub(gh, async () => {
    const [c] = await listComments(REPO, 12, { token: "t" });
    assert.equal(trustedAuthor(c), false, "unread: not trusted");
    gh.reads.dev = 0;
    await listComments(REPO, 12, { token: "t" });
    assert.equal(gh.reads.dev, RETRY.tries, "a failed read is tried again at the next read of the comments");
  });
  // The same login, once its permission reads as write, is trusted, with no read after the first.
  const ok = github({ comments: [restart], permissions: { dev: "write" } });
  await withGitHub(ok, async () => {
    const [c] = await listComments(REPO, 12, { token: "t" });
    assert.equal(trustedAuthor(c), true);
    await listComments(REPO, 12, { token: "t" });
    assert.equal(ok.reads.dev, 1);
  });
});

test("#605: permission reads are bounded per read of the writer list; past the bound an author is not trusted, and a fresh writer list starts the count again", async () => {
  const many = Array.from({ length: AUTHOR_READS_MAX + 3 }, (_, i) => ({ id: i + 1, user: user(`member${i}`), author_association: "MEMBER", body: "x" }));
  const permissions = Object.fromEntries(many.map((c) => [c.user.login, "write"]));
  const gh = github({ comments: many, permissions });
  await withGitHub(gh, async () => {
    const read = await listComments(REPO, 12, { token: "t" });
    assert.equal(Object.keys(gh.reads).length, AUTHOR_READS_MAX);
    assert.deepEqual(read.map(trustedAuthor), many.map((_, i) => i < AUTHOR_READS_MAX));
    // Pendulum itself, the writer list's writers and the repository's owner need no read.
    await verifyAuthors(REPO, [{ user: app, author_association: "MEMBER" }, { user: user("boss"), author_association: "OWNER" }], { token: "t" });
    assert.equal(Object.keys(gh.reads).length, AUTHOR_READS_MAX);
    // The writer list read again (primeWriters, every few minutes in a long-lived loop): the reads start over.
    setWriters(REPO.full, []);
    const rest = await verifyAuthors(REPO, many.slice(AUTHOR_READS_MAX), { token: "t" });
    assert.equal(Object.keys(gh.reads).length, AUTHOR_READS_MAX + 3);
    assert.deepEqual(rest.map(trustedAuthor), [true, true, true]);
  });
});

test("#605: a writer's own line comment goes to the finding check as a maintainer's, its body still fenced", () => {
  const tag = "t".repeat(16);
  const input = findingInput({ repo: "acme/app", prNumber: 12, finding: { id: 5, path: "src/a.ts", line: 3, body: "Rename this.", writer: "dev" }, reply: "Renamed.", diff: "" }, tag);
  assert.match(input, /^Finding by dev, a maintainer \(someone with write access to the repository\), at src\/a\.ts:3:\n<<<BEGIN t{16}>>>\nRename this\.\n<<<END t{16}>>>$/m);
  assert.doesNotMatch(input, /Pendulum's reviewer/);
  assert.match(findingInput({ repo: "acme/app", prNumber: 12, finding: { id: 6, path: "src/a.ts", line: 3, body: "x" }, reply: "y", diff: "" }, tag), /^Finding by Pendulum's reviewer, at /m);
});
