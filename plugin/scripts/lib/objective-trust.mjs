// Who wrote an Objective's text. The issue's title and body are the prompt-injection surface: they reach every work,
// fix, review and answer pass. Factory acts on them only when the issue's author, once the body was edited its last
// editor, and once the title was renamed the person who made the latest rename can push to the repository, or are one
// of the workflow's pinned maintainers (FACTORY_NOTIFY, FACTORY_MAINTAINERS as login#id). The text acted on is the one
// read with those people, never a separate read a later edit could have changed. The
// worker and the review job check it before any harness (Actions, local mode, a cloud-sandbox stage), and a session's
// route reads the issue only through it (local.mjs `issue`, `deliver`, `post-review`).
// What text the plan was made from (planGate): a stage never goes on with a plan and code made from one text and an
// Objective that now says another. An edit by people who vouch for it is judged once per new text by the edit check
// (edit-check.mjs): a wording-only edit keeps the plan; an edit anyone else made is never judged.
import { createHash } from "node:crypto";
import { collaboratorPermission, getIssue, graphql, issueTextChangedAt, labelersOf, primeSelf, rest } from "./github.mjs";
import { log } from "./inputs.mjs";
import { keptLine } from "./edit-check.mjs";
import { DRAFT_LABEL } from "./stop.mjs";
import { choiceLabels, choiceOf, chosenInputs, foundationLabel, hostsOf, hostsProblem, isChoiceLabel, routeProblem } from "./choice.mjs";
import { planComment, planTextMarker, stampPlan } from "./handoff.mjs";
import { waitOnAccounts } from "./account-wait.mjs";
import { ACCOUNT_LABEL_PREFIX, NO_ACCOUNT, accountLabelNote, routeAccount, routeAccounts, routeAutoAccounts, routeTwoLine } from "./accounts.mjs";
import { pinnedMaintainer, selfLogin, writersRepo } from "./logic.mjs";

const WRITE = new Set(["admin", "write", "maintain"]);
const ACTOR = "__typename login ... on User { databaseId }";
// The issue's latest rename comes in the same read as its title: who set the title now (objectiveTrusted).
const QUERY = `query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { issue(number: $number) { body lastEditedAt author { ${ACTOR} } editor { ${ACTOR} } title labels(first: 100) { nodes { name } } renames: timelineItems(itemTypes: [RENAMED_TITLE_EVENT], last: 1) { nodes { ... on RenamedTitleEvent { actor { ${ACTOR} } currentTitle } } } } } }`;
/** The label names a GraphQL issue node carries. */
const labelNames = (node) => (node?.labels?.nodes || []).map((l) => l?.name).filter((n) => typeof n === "string");

/** Text as an edit changes it: line ends as LF and no trailing whitespace (a save that changed nothing else is no edit). */
export const settled = (s) => String(s ?? "").replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").trimEnd();
/**
 * The Objective's text as one value: the SHA-256 of its title and body as GitHub returns them, settled, and of its
 * harness, model and host labels (choice.mjs choiceLabels) when it has any: one added, removed or changed is an edit too.
 */
export const objectiveSha = (title, body, labels = []) => {
  const chosen = choiceLabels(labels);
  return createHash("sha256").update(JSON.stringify(chosen.length ? [settled(title), settled(body), chosen] : [settled(title), settled(body)])).digest("hex");
};

/** An actor as a login a person can read: an App as `<slug>[bot]`. */
const shown = (a) => (a?.__typename === "Bot" ? `${a.login}[bot]` : a.login);

/** A REST timeline event's actor in the shape vouches reads: a person is `User`; an App, a mannequin or anyone else never vouches. */
const timelineActor = (a) => (a?.login ? { __typename: a.type === "User" ? "User" : a.type || "Unknown", login: a.login, databaseId: a.id } : null);

/**
 * Who set the issue's title as it is now: the actor of its latest rename (`rename`: {actor, to}, the actor in vouches'
 * shape) when that rename names `title`, else null (no one can be named for it).
 */
const renamer = (rename, title) => (rename?.actor?.login && settled(rename.to) === settled(title) ? rename.actor : null);

/** Whether two actors are the same account (their login and kind). */
const sameActor = (a, b) => !!a?.login && !!b?.login && a.login === b.login && a.__typename === b.__typename;

/** Whether this actor vouches for the text: a person who can push here, or a pinned maintainer of this repository's workflow. */
async function vouches(repo, actor, opts, gh) {
  // An App, a mannequin or any other non-person never vouches: its GraphQL login may be a person's login without `[bot]`.
  if (actor.__typename !== "User") return false;
  if (writersRepo() === repo.full && pinnedMaintainer({ id: actor.databaseId })) return true;
  return WRITE.has(await gh.permission(repo, actor.login, opts));
}

/**
 * Whether Factory may act on the issue's text: its author, its last editor when the body was edited, and when the title
 * was renamed the actor of its latest rename (that rename naming the title now; renamer), can push to `repo` or are
 * pinned maintainers. A title never renamed is the author's. Returns {ok, reason, body, people}: `body` and `title` from
 * the same read as the people (the caller acts on exactly the text they vouch for), `people` the [role, login] pairs who
 * vouch for it, `reason` a fixed line ending in `so <what>`. `gh` (graphql, permission) is a test's own.
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
  const people = roles.map(([role, a]) => [role, a.login]);
  // The title, vouched for as the body is: a read without the rename list has no one to name for it.
  const renames = node?.renames?.nodes;
  if (!Array.isArray(renames)) return { ok: false, role: "title renamer", reason: `who set the issue's title could not be read, so ${what}`, body };
  if (renames.length) {
    const r = renames.at(-1);
    const by = renamer({ actor: r?.actor ?? null, to: r?.currentTitle }, title);
    if (!by) return { ok: false, role: "title renamer", reason: `who set the issue's title as it is now could not be read, so ${what}`, body };
    if (!roles.some(([, a]) => sameActor(a, by))) {
      if (!(await vouches(repo, by, opts, gh))) return { ok: false, role: "title renamer", reason: `the issue's title was last renamed by \`${shown(by)}\`, who cannot push to ${repo.full} and is not a pinned maintainer, so ${what}`, body };
      people.push(["title renamer", by.login]);
    }
  }
  const labels = labelNames(node);
  return { ok: true, reason: "", body, title, labels, sha: objectiveSha(title, body, labels), editedAt: node?.lastEditedAt ?? null, people };
}

/**
 * What the Blocked notice tells a person to do, by who failed the check. The author is checked on every run and no edit
 * changes it, so only a new issue fixes an untrusted author; an untrusted last edit is fixed by a writer saving the body.
 */
export const AUTHOR_FIX = {
  author: "Editing this issue cannot fix that, since its author is checked on every run: a person who can push files the Objective as a new issue and labels that one `factory:objective`.",
  "last editor": "Fix by having a person who can push read the body and save it (they become its last editor), then re-apply `factory:objective`.",
  "title renamer": "Fix by having a person who can push read the title and rename the issue (they become its latest renamer), then re-apply `factory:objective`.",
};

/**
 * The issue as a stage acts on it: `issueData` (the REST read) with the title and body read with the people who vouch
 * for them, `labels` (the label names from that same read), `sha` (that text's objectiveSha) and `editedAt` (the body's last edit, GitHub's), or {ok: false, reason, fix} for the stage to Block on before any harness sees the text: `fix` (AUTHOR_FIX)
 * the Blocked notice's remedy for who failed.
 */
export async function trustedIssue(repo, issue, issueData, opts, gh) {
  const t = await objectiveTrusted(repo, issue, opts, { what: "Factory acts on none of its text", ...(gh ? { gh } : {}) });
  // An untrusted author is checked again on a resume and on a restart alike: the notice says neither gets past it.
  if (!t.ok) return { ok: false, reason: t.reason, fix: AUTHOR_FIX[t.role], ...(t.role === "author" ? { next: "none" } : {}) };
  return { ok: true, issueData: { ...issueData, title: t.title ?? issueData?.title, body: t.body }, labels: t.labels, sha: t.sha, editedAt: t.editedAt, people: t.people };
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
  await apply(repo, { issue, pr, exit: "blocked", reason: t.reason, fix: t.fix, cause: "setup", ...(t.next ? { next: t.next } : {}), notify, stage: "author" }, opts);
  return t;
}

/** The Blocked reason and fix when the Objective's text changed after its plan was made (planGate). */
export const EDITED_REASON = "the Objective's title, body or harness, model and host labels (`factory:harness:`, `factory:model:`, `factory:subagent-model:`, `factory:reviewer-model:`, `factory:host:`) changed after its plan was made, and its plan and code follow the earlier ones, so Factory does not go on with the two mixed";
export const EDITED_FIX = "Re-apply `factory:objective` to work from the issue as it is now, its text and its harness, model and host labels: the worker makes its plan again from it, on the same branch and PR.";

/** Factory's own login, read once (logic.mjs selfLogin): unknown, no plan comment could be told apart, so a stage stops. */
export async function knowSelf(opts) {
  if (!selfLogin() && !(await primeSelf(opts))) throw new Error("Factory's own login could not be read, so its plan comment cannot be told from anyone else's");
}

/**
 * When the Objective was last started, from its timeline events: the later of its label's last application and the
 * draft label's last removal (a draft is started by taking that label off, its Objective label on or not), or null.
 */
export function startTime(events, label) {
  let last = null;
  for (const e of events || []) {
    const start = (e.event === "labeled" && e.label?.name === label) || (e.event === "unlabeled" && e.label?.name === DRAFT_LABEL);
    if (start && Number.isFinite(Date.parse(e.created_at)) && (!last || Date.parse(e.created_at) > Date.parse(last))) last = e.created_at;
  }
  return last;
}

/** When the issue's Objective was last started (startTime), read from its timeline: the label time a work stage plans by. */
export async function startedAt(repo, issue, label, opts) {
  return startTime((await rest(`repos/${repo.full}/issues/${issue}/timeline?per_page=100`, { ...opts, paginate: true })) || [], label);
}

/**
 * When the title, body or harness and model labels last changed: the body's `lastEditedAt` (GitHub's), and the title's
 * latest rename and the latest choice label added or removed (the timeline's).
 */
async function textEditedAt(repo, issue, lastEditedAt, opts, changed = issueTextChangedAt) {
  const times = [lastEditedAt, await changed(repo, issue, opts, isChoiceLabel)].filter((t) => Number.isFinite(Date.parse(t)));
  return times.sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1) ?? null;
}

/** Whether time `t` is after `since` (none: any `t` is). */
const after = (t, since) => !!t && (!since || Date.parse(t) > Date.parse(since));

/**
 * The Objective's text against its plan comment (handoff.mjs planOf): "unplanned" (none: the work stage plans from this
 * text), "same", "replan" (the text changed, and a person applied the label after the work stage last started from the
 * plan's text, or after the edit when the plan's record cannot be read: only the work stage, which makes the plan
 * again) or "changed" (the stage Blocks). With a record, decided on its hash; `kept` (judgedEdit: the edit check read
 * the edit as wording only) is the same text, except that a label applied after the work stage last started is a
 * person's own word and wins: the work stage plans again. A plan comment whose record cannot be read (none, one that
 * does not parse, another App's) is decided on `editedAt`, when the title or body last changed: after the comment was
 * posted is a change. Never on the words.
 */
export function planTextState({ sha, plan, labeledAt = null, editedAt = null, work = false, kept = false }) {
  if (!plan) return "unplanned";
  if (plan.record) {
    if (plan.record.sha256 === sha) return "same";
    if (work && after(labeledAt, plan.record.label)) return "replan";
    return kept ? "same" : "changed";
  }
  if (!editedAt || (plan.at && Date.parse(editedAt) <= Date.parse(plan.at))) return "same";
  return work && after(labeledAt, editedAt) ? "replan" : "changed";
}

/** The Objective's text as a plan's record keeps it (handoff.mjs planTextMarker `text`): its title, body and choice labels. */
export const recordText = ({ title = null, body = "", labels = [] } = {}) => ({ title: typeof title === "string" ? title : null, body: typeof body === "string" ? body : "", labels: choiceLabels(labels) });

/**
 * Whether the person who changed the Objective's title from `before` to `after` vouches for it: the actor of the
 * issue's latest rename, that rename naming the title now, who can push or is a pinned maintainer. No title change, no
 * read. The body is the caller's: the text it passes was read with its author and last editor vouched for. `gh`
 * (timeline, permission) is a test's own.
 */
async function titleVouched(repo, issue, before, after, opts, gh = {}) {
  if (settled(before.title) === settled(after.title)) return true;
  const events = (await (gh.timeline ?? ((r, n, o) => rest(`repos/${r.full}/issues/${n}/timeline?per_page=100`, { ...o, paginate: true })))(repo, issue, opts)) || [];
  const r = events.filter((e) => e.event === "renamed").sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
  const by = renamer({ actor: timelineActor(r?.actor), to: r?.rename?.to }, after.title);
  if (!by) return false;
  return vouches(repo, by, opts, { permission: gh.permission ?? collaboratorPermission });
}

/**
 * The edit check's answer for the Objective's text now (`now`: {sha, title, body, labels}, read with its author and last
 * editor vouched for) against the plan's record (#400). Judged only when the record keeps the text it was made from
 * (and that text is the one its hash names), the harness, model and host labels are the same (a change to one is a
 * changed requirement as it stands), the title's change is vouched for (titleVouched), and `check` (edit-check.mjs
 * openEditCheck, or a function returning one, opened only then) is not `route-off`: otherwise planTextState's rule as
 * ever. A verdict the record already has for this text is used, never asked again. Returns {kept, record, unjudged,
 * said}: `kept` for `wording`; `record` the record with a verdict newly asked (to be written with the plan); `unjudged`
 * when no decider here could ask and another process may (the check's `elsewhere`); `said` the progress line of a kept
 * edit newly judged (edit-check.mjs keptLine).
 */
export async function judgedEdit({ repo, issue, record, now, check = null, opts, gh = {} }) {
  const none = { kept: false, record: null, unjudged: false, said: null };
  if (!record || record.sha256 === now.sha || !record.text) return none;
  const before = recordText(record.text);
  if (objectiveSha(before.title, before.body, before.labels) !== record.sha256) return none;
  const after = recordText(now);
  if (JSON.stringify(before.labels) !== JSON.stringify(after.labels)) return none;
  if (!(await titleVouched(repo, issue, before, after, opts, gh))) {
    log(`#${issue}: the Objective's title was changed since its plan by someone who cannot push and is not a pinned maintainer, so the edit is not judged`);
    return none;
  }
  const c = typeof check === "function" ? await check() : check;
  // No decider at all (decision_route off): any edit is a change, a verdict stored before included.
  if (!c || c.off === "route-off") return none;
  const stored = record.verdicts?.[now.sha];
  if (stored) return { ...none, kept: stored === "wording" };
  if (!c.judge) return { ...none, unjudged: !!c.elsewhere };
  const v = await c.judge(before, after);
  if (!v?.verdict) {
    log(`#${issue}: edit check (${c.model}): no verdict on the edit since the plan (${v?.error || "no_answer"})`);
    return none;
  }
  const kept = v.verdict === "wording";
  const said = kept ? keptLine({ asked: c.asked?.(), confidence: v.confidence }) : null;
  log(`#${issue}: ${said ?? `edit check (${c.model}): the edit since the plan is a changed requirement`}`);
  return { kept, record: { ...record, verdicts: { ...(record.verdicts || {}), [now.sha]: v.verdict } }, unjudged: false, said };
}

/** Whether two plan-text records are written alike (handoff.mjs planTextMarker). */
const sameRecord = (a, b) => !!a && !!b && planTextMarker(a) === planTextMarker(b);

/**
 * Every stage's second check, after authorGate: the text it acts on (`sha`, `text` ({title, body, labels}) and
 * `editedAt`, trustedIssue's) against the text its plan was made from, an edit judged by `check` (judgedEdit; the
 * stage's edit check, opened only when a question is due), its verdict written on the plan comment and a kept edit's
 * line through `progress`. A work stage started by a label applied after the plan's record asks nothing: it plans again.
 * "changed" Blocks (cause `work`: an edit is a person's action), through `apply` after `before`, with the PR as a draft.
 * Returns {ok, state, record}: `record` the plan-text record this stage writes with the plan comment (handoff.mjs
 * planSync). The work stage records this text with the latest label time, `labeledAt` read before the text (an edit and
 * a re-applied label between the two reads then count as after the plan), and writes it at once on a plan made from the
 * same text (or an edit judged wording only, the record then keeping the plan's text), so a later edit with no new label
 * is told from one the person re-applied the label after; the review stage keeps the plan's record. `read`
 * (planComment, labeledAt, changedAt, timeline, permission) is a test's own.
 */
export async function planGate({ repo, issue, sha, text = null, editedAt = null, labeledAt, work = false, pr = null, objectiveLabel = "factory:objective", notify, opts, apply, before = null, stage, check = null, progress = null, read = {} }) {
  await knowSelf(opts);
  const posted = await (read.planComment ?? planComment)(repo, issue, opts);
  const label = work ? (labeledAt !== undefined ? labeledAt : await (read.labeledAt ?? startedAt)(repo, issue, objectiveLabel, opts)) : null;
  const edited = posted && !posted.record ? await textEditedAt(repo, issue, editedAt, opts, read.changedAt) : null;
  const relabeled = work && !!posted?.record && after(label, posted.record.label);
  const judged = text && !relabeled ? await judgedEdit({ repo, issue, record: posted?.record, now: { sha, ...text }, check, opts, gh: read }) : { kept: false, record: null, said: null };
  const state = planTextState({ sha, plan: posted, labeledAt: label, editedAt: edited, work, kept: judged.kept });
  if (judged.said && progress) await progress(judged.said);
  // The plan's record as it stands now: with a verdict newly asked, written with the plan's text.
  const planned = judged.record ?? posted?.record ?? null;
  const stamp = (record) => (posted?.text !== null && posted?.text !== undefined ? stampPlan(repo, issue, posted, record, opts) : null);
  if (state === "changed") {
    if (judged.record) await stamp(judged.record);
    if (before) await before();
    await apply(repo, { issue, pr, exit: "blocked", reason: EDITED_REASON, fix: EDITED_FIX, cause: "work", notify, stage }, opts);
    return { ok: false, state, reason: EDITED_REASON, record: planned };
  }
  if (!work) {
    if (judged.record) await stamp(judged.record);
    return { ok: true, state, record: planned };
  }
  // The same text (or an edit judged wording only): the plan's record with this start's label time, its text kept (a
  // record from before it kept its text gets this one, the same by its hash); else this text's own record.
  const record = state === "same" && planned ? { ...planned, label, text: planned.text ?? (text ? recordText(text) : undefined) } : { sha256: sha, label, ...(text ? { text: recordText(text) } : {}) };
  if (!record.text) delete record.text;
  // The same text: the record goes on this login's plan comment now, with this start's label time.
  if (state === "same" && !(posted.own && sameRecord(posted.record, record))) await stamp(record);
  return { ok: true, state, record };
}

/**
 * The plan comment and planTextState's answer for a stage that never plans again (a session's `factory issue`,
 * `deliver` and `post-review`): {posted, state, record}. `sha`, `editedAt` and the text (`issueData`, `labels`) from
 * trustedIssue; `check` the edit check (judgedEdit), whose verdict is not written here: `record` is the plan's record
 * with it, for `deliver` to write with the plan. `read` (planComment, changedAt, timeline, permission) a test's own.
 */
export async function planStateNow(repo, issue, { sha, editedAt = null, issueData = null, labels = [] }, opts, read = {}, check = null) {
  await knowSelf(opts);
  const posted = await (read.planComment ?? planComment)(repo, issue, opts);
  const edited = posted && !posted.record ? await textEditedAt(repo, issue, editedAt, opts, read.changedAt) : null;
  const judged = issueData ? await judgedEdit({ repo, issue, record: posted?.record, now: { sha, title: issueData.title, body: issueData.body, labels }, check, opts, gh: read }) : { kept: false, record: null };
  return { posted, state: planTextState({ sha, plan: posted, editedAt: edited, kept: judged.kept }), record: judged.record ?? posted?.record ?? null };
}

/**
 * Whether the Objective's text changed since its plan was made (the merge's check, session.mjs mergeReadyOne): its
 * title, body and harness and model labels now against the plan comment, as planTextState decides for a review, an edit
 * judged by `check` (judgedEdit: the merge pass's process has no stage harness, so the AI Gateway's model when this
 * process holds the key and the route allows), its verdict written on the plan comment and a kept edit's line through
 * `progress`. "same" (no plan comment, the same text, or an edit judged wording only), "changed", or "unjudged": an edit
 * no decider here can judge and another process may (the caller hands it to a review stage, whose start judges it).
 * `gh` (graphql, permission, timeline), `read` and `changed` are a test's own.
 */
export async function editedSincePlan(repo, issue, opts, { gh = { graphql }, read = planComment, changed = issueTextChangedAt, check = null, progress = null } = {}) {
  await knowSelf(opts);
  const posted = await read(repo, issue, opts);
  if (!posted) return "same";
  const node = (await gh.graphql(QUERY, { owner: repo.owner, name: repo.name, number: Number(issue) }, opts))?.repository?.issue;
  if (!node) throw new Error(`#${issue} could not be read`);
  let sha = objectiveSha(typeof node.title === "string" ? node.title : null, typeof node.body === "string" ? node.body : "", labelNames(node));
  const editedAt = posted.record ? null : await textEditedAt(repo, issue, node.lastEditedAt ?? null, opts, changed);
  let judged = { kept: false, record: null, unjudged: false, said: null };
  if (posted.record?.text && posted.record.sha256 !== sha) {
    // Judged only on text read with its author and last editor vouched for (objectiveTrusted): else as ever.
    const t = await objectiveTrusted(repo, issue, opts, { gh: { graphql: gh.graphql, permission: gh.permission ?? collaboratorPermission } });
    if (t.ok) {
      sha = t.sha;
      judged = await judgedEdit({ repo, issue, record: posted.record, now: { sha, title: t.title, body: t.body, labels: t.labels }, check, opts, gh });
    }
  }
  if (judged.record && posted.text !== null) await stampPlan(repo, issue, posted, judged.record, opts);
  if (judged.said && progress) await progress(judged.said);
  if (planTextState({ sha, plan: posted, editedAt, kept: judged.kept }) !== "changed") return "same";
  return judged.unjudged ? "unjudged" : "changed";
}

/** What a Blocked notice tells a person to do about a harness, model or foundation label Factory did not act on. */
export const CHOICE_FIX = "A person who can push removes the label and applies it again, or removes it to run this Objective without it (on the repository's defaults, with the one-pass review), then re-applies `factory:objective`.";

/**
 * The harness, model and host labels among `names` (the issue's, read with its text) as Factory may act on them:
 * choice.mjs choiceOf and hostsOf, and each label's latest `labeled` event on the timeline by a person who can push or a
 * pinned maintainer. The foundation label (choice.mjs FOUNDATION_LABEL) is checked the same way: `foundation` is true
 * when it is on the issue. Returns {ok, choice, hosts, labels, foundation} or {ok: false, reason, fix}, the reason naming
 * the label. `gh` (labelers, permission) is a test's own.
 */
export async function choiceTrusted(repo, issue, names, opts, gh = {}) {
  const chose = choiceOf(names);
  const opened = hostsOf(names);
  const foundation = foundationLabel(names);
  if (!chose.ok) return chose;
  if (!opened.ok) return opened;
  const parsed = { ...chose, hosts: opened.hosts };
  if (!parsed.labels.length && !foundation) return { ...parsed, foundation: false };
  const refused = await labelsVouched(repo, issue, [...parsed.labels, ...(foundation ? [foundation] : [])], opts, gh, "Factory does not run on its choice");
  if (refused) return { ok: false, labels: parsed.labels, reason: refused, fix: CHOICE_FIX };
  return { ...parsed, foundation: !!foundation };
}

/**
 * Why Factory does not act on one of `labels`, or null when each one's latest `labeled` event on the issue's timeline is
 * by a person who can push or a pinned maintainer: one timeline read for all of them. With `event` "unlabeled", the
 * latest removal of each is checked instead. The reason names the label and ends `so <what>`. `gh` (labelers,
 * permission) is a test's own.
 */
export async function labelsVouched(repo, issue, labels, opts, gh = {}, what = "Factory does not act on it", event = "labeled") {
  const read = { labelers: labelersOf, permission: collaboratorPermission, ...gh };
  const by = await read.labelers(repo, issue, labels, opts, event);
  const did = event === "unlabeled" ? "removed" : "applied";
  for (const label of labels) {
    const a = by?.[label]?.actor;
    // The REST timeline's actor, in the shape vouches reads: a person is `User`; an App, a mannequin or anyone else never vouches.
    const actor = a?.login ? { __typename: a.type === "User" ? "User" : a.type || "Unknown", login: a.login, databaseId: a.id } : null;
    if (!actor) return `who ${did} \`${label}\` could not be read from the issue's timeline, so ${what}`;
    if (!(await vouches(repo, actor, opts, read))) return `\`${label}\` was ${did} by \`${actor.login}\`, who cannot push to ${repo.full} and is not a pinned maintainer, so ${what}`;
  }
  return null;
}

/**
 * Whether the Objective is a foundation one as Factory may act on it, from its label names (read with its text): no
 * `factory:foundation` is {ok, foundation: false} with no timeline read; one is vouched for as choiceTrusted vouches for a
 * choice label. {ok, foundation} or {ok: false, reason, fix}. A session's route (local.mjs `issue`, `post-review`) uses it.
 */
export async function foundationTrusted(repo, issue, names, opts, gh = {}) {
  const label = foundationLabel(names);
  if (!label) return { ok: true, foundation: false };
  const t = await choiceTrusted(repo, issue, [label], opts, gh);
  return t.ok ? { ok: true, foundation: true } : { ok: false, reason: t.reason, fix: t.fix };
}

/**
 * The inputs an Objective runs on before any stage starts (the launcher, the local loop): its labels read now,
 * choiceTrusted, then choice.mjs chosenInputs over `args` and `env` (`gateway`: whether Codex has the AI Gateway key, when
 * `env` no longer holds it). {ok, inputs, labels, hosts, names} or {ok: false, reason, fix}: `hosts` those its approved
 * host labels open (local mode's loop sets the stage's sandboxes up with them), `names` every label the read found.
 * `gh` (issue, labelers, permission) is a test's own.
 */
export async function objectiveInputs({ repo, issue, args = {}, env = process.env, opts, gateway, gh = {} }) {
  const names = ((await (gh.issue ?? getIssue)(repo, issue, opts))?.labels || []).map((l) => (typeof l === "string" ? l : l?.name));
  const t = await choiceTrusted(repo, issue, names, opts, gh);
  if (!t.ok) return t;
  const c = chosenInputs({ args, env, choice: t.choice, gateway });
  return c.ok ? { ...c, labels: t.labels, hosts: t.hosts, names } : c;
}

/**
 * Every stage's harness and models (the worker, the review job), after authorGate: `labels` (trustedIssue's, read with
 * the text) through choiceTrusted and chosenInputs, then against the harness this stage's route prepared
 * (FACTORY_STAGE_HARNESS: the Action's install, the launcher's sandbox credential, the local loop's sandbox; none on a
 * route that prepares every harness alike), and its host labels against the hosts local mode's loop set its sandboxes
 * up with (FACTORY_STAGE_HOSTS; on a runner the stage opens its own). A refusal Blocks (cause setup) through `apply`
 * after `before`, before any harness, and returns {ok: false, reason}; else {ok, inputs, labels, hosts}, the stage
 * running on `inputs` (choice.mjs CHOSEN_FIELDS) and opening `hosts` (local.mjs openStageHosts). `gh` (labelers,
 * permission) is a test's own.
 */
/**
 * The account a stage on GitHub Actions or the cloud sandbox runs on (#267). With accounts declared (FACTORY_ACCOUNTS,
 * accounts.mjs routeAccounts): the one the labels (`labels`, names) pick for `harness` (routeAccount; an account label's
 * labeler read afresh, labelsVouched), checked against the one the route prepared the stage for (FACTORY_STAGE_ACCOUNT:
 * the workflow's account step, whose account's credential is the only one the stage holds; with automatic account choice
 * on and no pin, any declared account of the harness, the one the step picked, #268). {refusal: {reason, fix}} for a
 * declaration or label that cannot be used, two account labels, or an account other than the prepared one; else
 * {account, note: "", pinned} (`pinned`: a label, or one a removal left standing, chose it). With none declared, the repository's one credential as ever: {account: null, note}, `note`
 * accountLabelNote's line for an account label, which does nothing then. `gh` (labelers, permission) is a test's own.
 */
export async function routeAccountCheck({ repo, issue, harness, labels = [], env = process.env, opts, gh = {} }) {
  const declared = routeAccounts(env.FACTORY_ACCOUNTS);
  if (declared.ok && !declared.declared) return { account: null, note: accountLabelNote(labels, false, false) };
  if (!declared.ok) return { refusal: { reason: `${declared.problem}, so no stage on GitHub Actions or the cloud sandbox starts`, fix: ACCOUNTS_FIX } };
  const prepared = String(env.FACTORY_STAGE_ACCOUNT ?? "").trim();
  // A pin an untrusted removal left standing (trustedRoutePin) is read from the timeline only when the job's account
  // step (which read it) prepared another account than the harness's default: it took the step's answer otherwise.
  // With automatic account choice on (#268) it is always read: whether a pin chose the account decides whether a usage
  // limit may move the stage (route-holds.mjs routeLimits `pinned`), and the default is a pick the step could make either way.
  const byDefault = prepared === (declared.accounts[harness]?.[0] ?? harness) && !routeAutoAccounts(env, harness);
  const r = await routeAccount({ declared, harness, names: labels, vouch: (label) => labelsVouched(repo, issue, [label], opts, gh, "Factory does not run the Objective on that account"), kept: byDefault ? null : () => trustedRoutePin(repo, issue, opts, gh) });
  // Two account labels: the Objective waits until one is left, never Blocked for it (the caller's wait, account-wait.mjs).
  if (r.two) return { wait: r.two };
  if (r.problem) return { refusal: { reason: `${r.problem}, so no stage of it starts`, fix: ROUTE_PIN_FIX } };
  if (!prepared) return { refusal: { reason: "this repository declares accounts (FACTORY_ACCOUNTS), but its workflow was not rendered for them, so this stage holds no account's credential: its jobs pass the secrets of the accounts setup rendered them for, by name", fix: "Re-render the workflow (`/factory:factory-setup`, or setup --apply workflow) after every change to FACTORY_ACCOUNTS: it names each declared account's secrets in the jobs and passes each stage only its account's. Merge it, then re-apply `factory:objective`." } };
  // The account step ran and could pick none (its labels then could not be used), so it passed no credential.
  if (prepared === NO_ACCOUNT) return { refusal: { reason: `the job's account step picked no account, so this stage holds no account's credential; the labels now pick \`${r.account.name}\`: its account label changed while the stage started`, fix: "Re-apply `factory:objective`: the next stage gets the credential of the account its labels pick." } };
  // Automatic account choice (#268): with no pin, the step picks any declared account of the harness (route-holds.mjs).
  if (prepared !== r.account.name && !r.label && routeAutoAccounts(env, harness)?.includes(prepared)) return { account: prepared, note: "", pinned: false };
  if (prepared !== r.account.name) return { refusal: { reason: `this stage was prepared with account \`${prepared}\`'s credential, but the Objective's labels now pick \`${r.account.name}\`: its account label changed while the stage started`, fix: "Re-apply `factory:objective`: the next stage gets the credential of the account its labels pick." } };
  return { account: r.account.name, note: "", pinned: !!r.label };
}

/**
 * The account label that still pins an Objective with none on it now (#267), or null (its harness's default): its
 * timeline's account-label events replayed oldest first with two sets. `actual`, the labels on the issue, follows every
 * event. `trusted`, the pins of people who can push or pinned maintainers (vouches), follows only theirs: a trusted
 * `labeled X` keeps the pins still on the issue just before it and adds X (a pin already gone is replaced), a trusted
 * `unlabeled X` takes X away, and anyone else's event changes nothing. A person who cannot push can neither move the pin
 * nor take it away, and a pin a pusher replaced never comes back. With more than one left, the most recently added; it
 * never yields two (two labels wait only while both are on the issue). `gh` (timeline, permission) is a test's own;
 * each actor's permission is read once.
 */
export async function trustedRoutePin(repo, issue, opts, gh = {}) {
  const read = { permission: collaboratorPermission, ...gh };
  const events = ((await (gh.timeline ?? ((r, n, o) => rest(`repos/${r.full}/issues/${n}/timeline?per_page=100`, { ...o, paginate: true })))(repo, issue, opts)) || [])
    .filter((e) => (e.event === "labeled" || e.event === "unlabeled") && typeof e.label?.name === "string" && e.label.name.toLowerCase().startsWith(ACCOUNT_LABEL_PREFIX))
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  const vouchedBy = new Map();
  const vouched = async (a) => {
    if (!a?.login) return false;
    const key = `${a.type}:${a.login}:${a.id}`;
    if (!vouchedBy.has(key)) vouchedBy.set(key, await vouches(repo, { __typename: a.type === "User" ? "User" : a.type || "Unknown", login: a.login, databaseId: a.id }, opts, read));
    return vouchedBy.get(key);
  };
  const actual = new Set();
  // Trusted pins in the order they were added: the last is the newest.
  let trusted = [];
  for (const e of events) {
    const x = e.label.name;
    if (await vouched(e.actor)) {
      if (e.event === "labeled") trusted = [...trusted.filter((t) => t !== x && actual.has(t)), x];
      else trusted = trusted.filter((t) => t !== x);
    }
    if (e.event === "labeled") actual.add(x);
    else actual.delete(x);
  }
  return trusted.at(-1) ?? null;
}

/**
 * Every stage's account off local mode (#267), after choiceGate: routeAccountCheck, whose refusal Blocks (cause setup)
 * through `apply` after `before`, before any harness, and returns {ok: false, reason}; two account labels make the
 * stage wait (account-wait.mjs waitOnAccounts: a review's label off and its wait recorded, a work stage back to Queued),
 * {ok: false, wait: line}; else {ok, account, note}. Local mode's loop picks its own (local.mjs harnessFor): {ok,
 * account: null, note: ""}.
 */
export async function accountGate({ repo, issue, harness, labels = [], env = process.env, local = false, pr = null, notify, opts, apply, before = null, stage, gh = {} }) {
  if (local) return { ok: true, account: null, note: "" };
  const c = await routeAccountCheck({ repo, issue, harness, labels, env, opts, gh });
  // Two account labels: the stage waits (account-wait.mjs), never Blocks.
  if (c.wait) return { ok: false, wait: await waitOnAccounts({ repo, issue, stage, pr, two: c.wait, opts }) };
  if (!c.refusal) return { ok: true, account: c.account, note: c.note, pinned: !!c.pinned };
  if (before) await before();
  await apply(repo, { issue, pr, exit: "blocked", reason: c.refusal.reason, fix: c.refusal.fix, cause: "setup", notify, stage }, opts);
  return { ok: false, reason: c.refusal.reason };
}
const ACCOUNTS_FIX = 'Fix FACTORY_ACCOUNTS in .github/workflows/factory.yml: a JSON object of each harness\'s account names, such as {"claude": ["claude", "claude-2"]} (docs/INSTALL.md, Several accounts), then re-apply `factory:objective`.';
const ROUTE_PIN_FIX = "A person who can push removes the account label, or applies one naming an account FACTORY_ACCOUNTS declares for the Objective's harness, then re-applies `factory:objective`.";

export async function choiceGate({ repo, issue, labels, args = {}, env = process.env, pr = null, notify, opts, apply, before = null, stage, gh }) {
  const t = await choiceTrusted(repo, issue, labels, opts, gh);
  const c = t.ok ? chosenInputs({ args, env, choice: t.choice }) : t;
  const refusal = c.ok ? routeProblem(env.FACTORY_STAGE_HARNESS, c.inputs.harness) || hostsProblem(env.FACTORY_STAGE_HOSTS, t.hosts) : c;
  if (!refusal) return { ...c, labels: t.labels, hosts: t.hosts, foundation: t.foundation };
  if (before) await before();
  await apply(repo, { issue, pr, exit: "blocked", reason: refusal.reason, fix: refusal.fix, cause: "setup", notify, stage }, opts);
  return { ok: false, reason: refusal.reason };
}
