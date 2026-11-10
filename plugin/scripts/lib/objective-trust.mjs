// Who wrote an Objective's text. The issue body is the prompt-injection surface: it reaches every work, fix, review and
// answer pass. Factory acts on it only when the issue's author and, once the body was edited, its last editor can push
// to the repository, or are one of the workflow's pinned maintainers (FACTORY_NOTIFY, FACTORY_MAINTAINERS as login#id).
// The body acted on is the one read with those people, never a separate read a later edit could have changed. The
// worker and the review job check it before any harness (Actions, local mode, a cloud-sandbox stage), and a session's
// route reads the issue only through it (local.mjs `issue`, `deliver`, `post-review`).
import { collaboratorPermission, graphql } from "./github.mjs";
import { pinnedMaintainer, writersRepo } from "./logic.mjs";

const WRITE = new Set(["admin", "write", "maintain"]);
const ACTOR = "__typename login ... on User { databaseId }";
const QUERY = `query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { issue(number: $number) { body lastEditedAt author { ${ACTOR} } editor { ${ACTOR} } title } } }`;

/** An actor as a login a person can read: an App as `<slug>[bot]`. */
const shown = (a) => (a?.__typename === "Bot" ? `${a.login}[bot]` : a.login);

/** Whether this actor vouches for the text: a person who can push here, or a pinned maintainer of this repository's workflow. */
async function vouches(repo, actor, opts, gh) {
  // An App, a mannequin or any other non-person never vouches: its GraphQL login may be a person's login without `[bot]`.
  if (actor.__typename !== "User") return false;
  if (writersRepo() === repo.full && pinnedMaintainer({ id: actor.databaseId })) return true;
  return WRITE.has(await gh.permission(repo, actor.login, opts));
}

/**
 * Whether Factory may act on the issue's text: its author, and its last editor when the body was edited, can push to
 * `repo` or are pinned maintainers. Returns {ok, reason, body, people}: `body` from the same read as the people (the
 * caller acts on exactly the text they vouch for), `people` the [role, login] pairs who vouch for it, `reason` a fixed
 * line ending in `so <what>`. `gh` (graphql, permission) is a test's own.
 */
export async function objectiveTrusted(repo, issue, opts, { what = "Factory acts on none of its text", gh = { graphql, permission: collaboratorPermission } } = {}) {
  const d = await gh.graphql(QUERY, { owner: repo.owner, name: repo.name, number: Number(issue) }, opts);
  const node = d?.repository?.issue;
  const body = typeof node?.body === "string" ? node.body : "";
  const author = node?.author ?? null;
  const editor = node?.editor ?? null;
  // An edited body whose editor cannot be read (a deleted account) has no one to vouch for the edit.
  const edited = !!editor || !!node?.lastEditedAt;
  const roles = [["author", author], ...(edited && !(editor?.login && author?.login && editor.login === author.login && editor.__typename === author.__typename) ? [["last editor", editor]] : [])];
  for (const [role, actor] of roles) {
    if (!actor?.login) return { ok: false, role, reason: `the issue's ${role} could not be read, so ${what}`, body };
    if (!(await vouches(repo, actor, opts, gh))) return { ok: false, role, reason: `the issue's ${role} \`${shown(actor)}\` cannot push to ${repo.full} and is not a pinned maintainer, so ${what}`, body };
  }
  return { ok: true, reason: "", body, title: typeof node?.title === "string" ? node.title : null, people: roles.map(([role, a]) => [role, a.login]) };
}

/**
 * What the Blocked notice tells a person to do, by who failed the check. The author is checked on every run and no edit
 * changes it, so only a new issue fixes an untrusted author; an untrusted last edit is fixed by a writer saving the body.
 */
export const AUTHOR_FIX = {
  author: "Editing this issue cannot fix that, since its author is checked on every run: a person who can push files the Objective as a new issue and labels that one `factory:objective`.",
  "last editor": "Fix by having a person who can push read the body and save it (they become its last editor), then re-apply `factory:objective`.",
};

/**
 * The issue as a stage acts on it: `issueData` (the REST read) with the title and body read with the people who vouch
 * for them, or {ok: false, reason, fix} for the stage to Block on before any harness sees the text: `fix` (AUTHOR_FIX)
 * the Blocked notice's remedy for who failed.
 */
export async function trustedIssue(repo, issue, issueData, opts, gh) {
  const t = await objectiveTrusted(repo, issue, opts, { what: "Factory acts on none of its text", ...(gh ? { gh } : {}) });
  if (!t.ok) return { ok: false, reason: t.reason, fix: AUTHOR_FIX[t.role] };
  return { ok: true, issueData: { ...issueData, title: t.title ?? issueData?.title, body: t.body }, people: t.people };
}

/**
 * Every stage's check (worker, review job, local mode's `deliver`): trustedIssue, and on a refusal the Block itself,
 * stage `author`, through `apply` (session.mjs applyExit) after `before` (the review job drops its label). Returns
 * trustedIssue's answer: the stage acts on its `issueData`, or stops when `ok` is false, with no text for a harness.
 */
export async function authorGate({ repo, issue, issueData, pr = null, notify, opts, apply, before = null, gh }) {
  const t = await trustedIssue(repo, issue, issueData, opts, gh);
  if (t.ok) return t;
  if (before) await before();
  await apply(repo, { issue, pr, exit: "blocked", reason: t.reason, fix: t.fix, notify, stage: "author" }, opts);
  return t;
}
