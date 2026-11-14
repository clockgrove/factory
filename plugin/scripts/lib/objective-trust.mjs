// Who wrote an Objective's text. The issue body is the prompt-injection surface: it reaches every work, fix, review and
// answer pass. Factory acts on it only when the issue's author and, once the body was edited, its last editor can push
// to the repository, or are one of the workflow's pinned maintainers (FACTORY_NOTIFY, FACTORY_MAINTAINERS as login#id).
// The body acted on is the one read with those people, never a separate read a later edit could have changed. The
// worker and the review job check it before any harness (Actions, local mode, a cloud-sandbox stage), and a session's
// route reads the issue only through it (local.mjs `issue`, `deliver`, `post-review`).
// What text the plan was made from (planGate): a stage never goes on with a plan and code made from one text and an
// Objective that now says another.
import { createHash } from "node:crypto";
import { collaboratorPermission, graphql, issueRenamedAt, objectiveLabeledAt, primeSelf } from "./github.mjs";
import { planComment, stampPlan } from "./handoff.mjs";
import { pinnedMaintainer, selfLogin, writersRepo } from "./logic.mjs";

const WRITE = new Set(["admin", "write", "maintain"]);
const ACTOR = "__typename login ... on User { databaseId }";
const QUERY = `query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { issue(number: $number) { body lastEditedAt author { ${ACTOR} } editor { ${ACTOR} } title } } }`;

/** Text as an edit changes it: line ends as LF and no trailing whitespace (a save that changed nothing else is no edit). */
export const settled = (s) => String(s ?? "").replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").trimEnd();
/** The Objective's text as one value: the SHA-256 of its title and body as GitHub returns them, settled. */
export const objectiveSha = (title, body) => createHash("sha256").update(JSON.stringify([settled(title), settled(body)])).digest("hex");

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
  const title = typeof node?.title === "string" ? node.title : null;
  return { ok: true, reason: "", body, title, sha: objectiveSha(title, body), editedAt: node?.lastEditedAt ?? null, people: roles.map(([role, a]) => [role, a.login]) };
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
 * for them, `sha` (that text's objectiveSha) and `editedAt` (the body's last edit, GitHub's), or {ok: false, reason, fix} for the stage to Block on before any harness sees the text: `fix` (AUTHOR_FIX)
 * the Blocked notice's remedy for who failed.
 */
export async function trustedIssue(repo, issue, issueData, opts, gh) {
  const t = await objectiveTrusted(repo, issue, opts, { what: "Factory acts on none of its text", ...(gh ? { gh } : {}) });
  if (!t.ok) return { ok: false, reason: t.reason, fix: AUTHOR_FIX[t.role] };
  return { ok: true, issueData: { ...issueData, title: t.title ?? issueData?.title, body: t.body }, sha: t.sha, editedAt: t.editedAt, people: t.people };
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
  await apply(repo, { issue, pr, exit: "blocked", reason: t.reason, fix: t.fix, cause: "setup", notify, stage: "author" }, opts);
  return t;
}

/** The Blocked reason and fix when the Objective's text changed after its plan was made (planGate). */
export const EDITED_REASON = "the Objective's title or body changed after its plan was made, and its plan and code follow the earlier text, so Factory does not go on with the two mixed";
export const EDITED_FIX = "Re-apply `factory:objective` to work from the new text: the worker makes its plan again from it, on the same branch and PR.";

/** Factory's own login, read once (logic.mjs selfLogin): unknown, no plan comment could be told apart, so a stage stops. */
export async function knowSelf(opts) {
  if (!selfLogin() && !(await primeSelf(opts))) throw new Error("Factory's own login could not be read, so its plan comment cannot be told from anyone else's");
}

/** When the title or body was last changed: the body's `lastEditedAt` (GitHub's) and the title's latest rename. */
async function textEditedAt(repo, issue, lastEditedAt, opts, renamed = issueRenamedAt) {
  const times = [lastEditedAt, await renamed(repo, issue, opts)].filter((t) => Number.isFinite(Date.parse(t)));
  return times.sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1) ?? null;
}

/**
 * The Objective's text against its plan comment (handoff.mjs planOf): "unplanned" (none: the work stage plans from this
 * text), "same", "replan" (the text changed, and a person applied the label after the work stage last started from the
 * plan's text, or after the edit when the plan's record cannot be read: only the work stage, which makes the plan
 * again) or "changed" (the stage Blocks). With a record, decided on its hash; a plan comment whose record cannot be read
 * (none, one that does not parse, another App's) is decided on `editedAt`, when the title or body last changed: after
 * the comment was posted is a change. Never on the words.
 */
export function planTextState({ sha, plan, labeledAt = null, editedAt = null, work = false }) {
  if (!plan) return "unplanned";
  const after = (t, since) => !!t && (!since || Date.parse(t) > Date.parse(since));
  if (plan.record) {
    if (plan.record.sha256 === sha) return "same";
    return work && after(labeledAt, plan.record.label) ? "replan" : "changed";
  }
  if (!editedAt || (plan.at && Date.parse(editedAt) <= Date.parse(plan.at))) return "same";
  return work && after(labeledAt, editedAt) ? "replan" : "changed";
}

/**
 * Every stage's second check, after authorGate: the text it acts on (`sha` and `editedAt`, trustedIssue's) against the
 * text its plan was made from. "changed" Blocks (cause `work`: an edit is a person's action), through `apply` after
 * `before`, with the PR as a draft. Returns {ok, state, record}: `record` the plan-text record this stage writes with the
 * plan comment (handoff.mjs planSync). The work stage records this text with the latest label time, `labeledAt` read
 * before the text (an edit and a re-applied label between the two reads then count as after the plan), and writes it at
 * once on a plan made from the same text, so a later edit with no new label is told from one the person re-applied the
 * label after; the review stage keeps the plan's record. `read` (planComment, labeledAt, renamedAt) is a test's own.
 */
export async function planGate({ repo, issue, sha, editedAt = null, labeledAt, work = false, pr = null, objectiveLabel = "factory:objective", notify, opts, apply, before = null, stage, read = {} }) {
  await knowSelf(opts);
  const posted = await (read.planComment ?? planComment)(repo, issue, opts);
  const label = work ? (labeledAt !== undefined ? labeledAt : await (read.labeledAt ?? objectiveLabeledAt)(repo, issue, objectiveLabel, opts)) : null;
  const edited = posted && !posted.record ? await textEditedAt(repo, issue, editedAt, opts, read.renamedAt) : null;
  const state = planTextState({ sha, plan: posted, labeledAt: label, editedAt: edited, work });
  if (state === "changed") {
    if (before) await before();
    await apply(repo, { issue, pr, exit: "blocked", reason: EDITED_REASON, fix: EDITED_FIX, cause: "work", notify, stage }, opts);
    return { ok: false, state, reason: EDITED_REASON, record: posted.record };
  }
  if (!work) return { ok: true, state, record: posted?.record ?? null };
  const record = { sha256: sha, label };
  // The same text: the record goes on this login's plan comment now, with this start's label time.
  if (state === "same" && posted.text !== null && !(posted.own && posted.record?.sha256 === sha && posted.record.label === label)) await stampPlan(repo, issue, posted, record, opts);
  return { ok: true, state, record };
}

/**
 * The plan comment and planTextState's answer for a stage that never plans again (a session's `factory issue` and
 * `post-review`): {posted, state}. `sha` and `editedAt` from trustedIssue; `read` (planComment, renamedAt) a test's own.
 */
export async function planStateNow(repo, issue, { sha, editedAt = null }, opts, read = {}) {
  await knowSelf(opts);
  const posted = await (read.planComment ?? planComment)(repo, issue, opts);
  const edited = posted && !posted.record ? await textEditedAt(repo, issue, editedAt, opts, read.renamedAt) : null;
  return { posted, state: planTextState({ sha, plan: posted, editedAt: edited }) };
}

/**
 * Whether the Objective's text changed since its plan was made (the merge's check, session.mjs mergeReadyOne): its
 * title and body now against the plan comment, as planTextState decides for a review. False with no plan comment.
 * `gh` (graphql), `read` and `renamed` are a test's own.
 */
export async function editedSincePlan(repo, issue, opts, { gh = { graphql }, read = planComment, renamed = issueRenamedAt } = {}) {
  await knowSelf(opts);
  const posted = await read(repo, issue, opts);
  if (!posted) return false;
  const node = (await gh.graphql(QUERY, { owner: repo.owner, name: repo.name, number: Number(issue) }, opts))?.repository?.issue;
  if (!node) throw new Error(`#${issue} could not be read`);
  const sha = objectiveSha(typeof node.title === "string" ? node.title : null, typeof node.body === "string" ? node.body : "");
  const editedAt = posted.record ? null : await textEditedAt(repo, issue, node.lastEditedAt ?? null, opts, renamed);
  return planTextState({ sha, plan: posted, editedAt }) === "changed";
}
