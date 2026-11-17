// One Objective's row: the four job-one numbers from what GitHub says about
// the issue, the PR(s) on pendulum/<issue> and the usage artifact (PLAN.md,
// "Job one and how 0.6 is measured"). Pure: takes the collected facts
// (lib/collect.mjs online, a fixture offline) and returns the row.
//
//   walkAway   binary. The clock starts at the first `pendulum:objective`
//              label. Any human push, comment, review, edit, draft toggle or
//              merge on the branch or the issue after it breaks it; a Blocked
//              card (the pendulum:blocked label or the blocked marker comment)
//              is a miss. A Question answered by a human is a miss too.
//              Each human action is also split: asked for (it follows a
//              Question, Blocked notice or review request Pendulum made, before
//              Pendulum picked the Objective up again) or unprompted; walk-away
//              is reported a second way, counting only what Pendulum asked for.
//              A merge that sat idle longer than the stall threshold after
//              Pendulum's last action (idleStall) is a stall, not a walk-away.
//              A workflow hand-over is an owner step by default (HANDOVER_SCORING):
//              normal work, shown apart with its own minutes, never input.
//   quality    the judge's, not this file's: `pending` with the pair inputs
//              when a baseline is given, else `pending` with what is known.
//   operator   minutes from --minutes; 0 on a clean merge; `unknown` else.
//   ownerStep  a posted workflow hand-over a person applies after the merge:
//              its minutes from --owner-minutes, apart from the operator's.
//   cost       lib/cost.mjs (the plugin's cost-join.mjs), with unit and basis per harness.
//   wall       filed (label) to merged; runner minutes from the job log.
import { dispatchLatency, pendulumLogin, phaseMinutes, setupSeconds, stageLastWrite } from "./phases.mjs";
import { ACCOUNT, accountUse, costOf, decisionSpendRecords, stageHarnessOf, stageOf, stageSpendRecords, withLines } from "./cost.mjs";
import { BLOCK_CAUSES, blockCauseOf, rebaseTally, spendText } from "../../plugin/scripts/lib/logic.mjs";
import { billingText, unknownText } from "../../plugin/scripts/lib/usage.mjs";
import { HANDOVER_LABEL, carriesHandover, handoverMarker, handoverOf } from "../../plugin/scripts/lib/handover.mjs";
import { labelTime } from "../../plugin/scripts/lib/finish-card.mjs";

export const ROW_VERSION = 1;

/** The cost join's shared parts (plugin cost-join.mjs), as the scorer has always exported them. */
export { accountUse, stageHarnessOf, withLines };
const BRANCH = (issue) => `pendulum/${issue}`;
export const RUNNING_LABEL = "pendulum:running";
export const OBJECTIVE_LABEL = "pendulum:objective";
const DRAFT_LABEL = "pendulum:draft";
const BLOCKED_LABEL = "pendulum:blocked";
/**
 * The stall threshold's default, in minutes: a merged Objective idle longer than this after Pendulum's last action
 * stalled. It is GitHub's default merge-queue timeout, so one healthy CI wait (on the PR or in the queue) fits under it;
 * the wave-5 re-drill's healthy Objectives idled at most 5 minutes, and #295 sat 89 after a queue drop.
 */
export const STALL_MINUTES = 60;
const QUESTION_LABEL = "pendulum:question";
/**
 * How a workflow hand-over is scored (bench/README.md, the pendulum-score skill's reference), one rule per scoring run:
 *   owner-step  the default, for every repository: normal work. The Objective can still walk away; applying the
 *               posted hand-over is the owner's step after the merge, shown apart (`ownerStep`) with its own minutes.
 *   input       the strict read: each merged PR carrying the hand-over line is one asked-for human action, a miss.
 * Why the default: Pendulum never pushes a workflow file and its App has no workflows permission, by design, so an
 * Objective that needs one could never walk away under `input`, however well Pendulum did; that pushed adopters to split
 * such Objectives by hand, which is worse for the record and no safer. One rule for every repository keeps the pooled
 * 1.0 streak one rule.
 */
export const HANDOVER_SCORING = Object.freeze(["owner-step", "input"]);
export const HANDOVER_DEFAULT = "owner-step";

const ms = (at) => (at ? Date.parse(at) : NaN);
export const PASSIVE_EVENTS = new Set(["mentioned", "subscribed", "cross-referenced", "connected", "referenced", "issue_type_added", "issue_type_changed", "issue_type_removed", "milestoned", "demilestoned", "pinned", "unpinned", "added_to_project", "moved_columns_in_project", "removed_from_project", "project_v2_item_status_changed", "added_to_project_v2", "removed_from_project_v2", "converted_note_to_issue"]);
const minutes = (from, to) => (Number.isFinite(ms(from)) && Number.isFinite(ms(to)) ? Math.round((ms(to) - ms(from)) / 60_000) : null);

/** Whether a GitHub actor is a person: not a Bot, not a known machine login. */
export function isHuman(actor, bots = new Set()) {
  if (!actor) return false;
  const login = actor.login ?? actor.name ?? "";
  if (actor.type === "Bot") return false;
  if (/\[bot\]$/i.test(login)) return false;
  if (bots.has(login)) return false;
  return true;
}

/** A commit's author as an actor: the GitHub user when linked, else the git identity. */
function commitActor(commit) {
  if (commit.author && typeof commit.author === "object" && commit.author.login) return commit.author;
  const email = commit.commit?.author?.email ?? "";
  const name = commit.commit?.author?.name ?? "";
  if (/\[bot\]@users\.noreply\.github\.com$/i.test(email) || /\[bot\]$/i.test(name)) return { login: name, type: "Bot" };
  return { login: name || email || "unknown", type: "User", unlinked: true };
}

/**
 * The clock: the first `labeled pendulum:objective` event, or null; a draft's start for a draft. With `clockAfter`, the
 * first such event at or after that date: an issue that an earlier Pendulum already ran under the same label starts its
 * clock there. The finish card starts its clock the same way, so the rule lives with it (plugin finish-card.mjs).
 */
export { labelTime };

/**
 * Minutes of the wall clock spent waiting rather than working: from the clock to Pendulum's first
 * Running label (a queue slot or a blocker), plus every Blocked or Question interval until the
 * next Running label (a human's turn). Null without a merge; the basis says what counted.
 */
export function waitingMinutes(timeline, since, mergedAt) {
  if (!since || !mergedAt) return { minutes: null, basis: "not merged" };
  const labels = (timeline || []).filter((e) => e.event === "labeled" && e.label?.name && ms(e.created_at) >= ms(since)).sort((a, b) => ms(a.created_at) - ms(b.created_at));
  let total = 0;
  const parts = [];
  const firstRunning = labels.find((e) => e.label.name === RUNNING_LABEL);
  if (firstRunning && ms(firstRunning.created_at) > ms(since)) {
    total += ms(firstRunning.created_at) - ms(since);
    parts.push("queue");
  }
  for (let i = 0; i < labels.length; i += 1) {
    const e = labels[i];
    if (e.label.name !== BLOCKED_LABEL && e.label.name !== QUESTION_LABEL) continue;
    const next = labels.slice(i + 1).find((n) => n.label.name === RUNNING_LABEL);
    const end = next ? ms(next.created_at) : ms(mergedAt);
    if (end > ms(e.created_at)) {
      total += end - ms(e.created_at);
      parts.push(e.label.name === BLOCKED_LABEL ? "blocked" : "question");
    }
  }
  return { minutes: Math.round((total / 60000) * 10) / 10, basis: parts.length ? `waiting: ${parts.join(", ")}` : "no waiting" };
}

/** Human actions grouped into decisions: actions by one person within ten minutes of each other are one decision (an edit, a relabel, a note). */
export function decisionsOf(actions) {
  let count = 0;
  let last = null;
  for (const a of [...(actions || [])].sort((x, y) => ms(x.at) - ms(y.at))) {
    if (!last || a.by !== last.by || ms(a.at) - ms(last.at) > 10 * 60000) count += 1;
    last = a;
  }
  return count;
}

/**
 * Local mode (the pendulum:local label): Pendulum acts under the developer's own login, so a person's actions and
 * Pendulum's share an actor. Pendulum's are told apart by structure, never by a time window alone:
 *   - labels: only the pendulum state labels the local loop sets (running, in-review, blocked, question, review) are
 *     Pendulum's, and removing pendulum:restart once it restarted the Objective. Any other label, applying
 *     pendulum:restart and re-applying pendulum:objective among them, is a person's. Removing pendulum:blocked is
 *     Pendulum's only after a re-applied Objective label (the recovery it answers); without one it is a person's
 *     manual un-block.
 *   - comments: Pendulum's comments all carry a `<!-- pendulum:... -->` marker. One without a marker is a person's, even
 *     inside a run (an answer to a Question typed while the stage was running).
 *   - the merge, which the merge queue records as whoever armed auto-merge, is Pendulum's.
 *   - the workflow hand-over's label, read as plugin handoff.mjs handoverApplied reads it: applying pendulum:handover is
 *     Pendulum's when its hand-over comment (`<!-- pendulum:N:handover -->`, the login's) is on the issue or inside a
 *     run's window. Removing it is Pendulum's only when it is Pendulum's drop: inside a run's window, and either that
 *     comment carries no patch (Pendulum replaced it with "carries none") or Pendulum applied the label again later.
 *     Any other removal is the person's mark that they applied it, which Pendulum takes as applied.
 *   - anything else (a push, a review, a draft toggle) is Pendulum's inside a run's window: the login's progress
 *     comment's creation to its last edit, with two minutes' slack.
 * On any route, a Done pass that runs under a person's login (a local loop's dispatcher) posts its `done` record before
 * it removes a closed Objective's state labels: each label its `removed:` line names, removed by the record's author
 * after the record while the issue is closed, is Pendulum's (#2668). No upper bound: a removal that failed waits for a
 * later tick, and the record's edit time need not move on a retry that writes the same body.
 * A local loop where no Action runs labels the Objective it picks pendulum:local itself (plugin lib/local.mjs adoptLocal)
 * and marks that exact label event: a `labeled pendulum:local` event is Pendulum's when a comment by the event's own actor
 * opens with `<!-- pendulum:N:local-route:ID -->` naming the event's id. Any other pendulum:local label is a person's.
 * The returned check takes the event's id as its fourth argument.
 */
// A restart's label is the person's (a human action); its removal is Pendulum's, once it has restarted the Objective.
const LOCAL_STATE_KIND = /^(?:(un)?labeled pendulum:(running|in-review|blocked|question|review)|unlabeled pendulum:restart)$/;
/** The state labels a Done pass removes from a closed Objective. */
const DONE_LABELS = /^pendulum:(running|in-review|blocked|question)$/;
export function localPendulumActions(collected, { label = OBJECTIVE_LABEL } = {}) {
  const { records: done, closedAt } = doneRecords(collected);
  const routes = localRouteMarks(collected);
  const tidied = (at, actor, kind, id = null) => {
    if (kind === "labeled pendulum:local" && id !== null && id !== undefined && routes.has(`${id} ${actor?.login ?? actor?.name}`)) return true;
    const name = /^unlabeled (\S+)$/.exec(kind)?.[1];
    return !!name && closedAt(at) && done.some((r) => r.login === (actor?.login ?? actor?.name) && r.labels.has(name) && ms(at) >= r.at);
  };
  const login = localLogin(collected);
  if (!login) return tidied;
  const progress = (collected.issueComments || []).filter((c) => /^<!-- pendulum:\d+:progress/.test(c.body || "") && c.user?.login === login);
  const slack = 2 * 60_000;
  const windows = progress.map((c) => [ms(c.created_at) - slack, ms(c.updated_at || c.created_at) + slack]);
  const labels = (collected.issueTimeline || []).filter((e) => e.event === "labeled").sort((a, b) => ms(a.created_at) - ms(b.created_at));
  const inRun = (at) => windows.some(([a, b]) => ms(at) >= a && ms(at) <= b);
  // The workflow hand-over: the login's hand-over comment, and whether it still carries a patch (handoverOf).
  const mark = `${handoverMarker(collected.issue?.number)}\n`;
  const handoverBodies = (collected.issueComments || []).filter((c) => c.user?.login === login).map((c) => String(c.body || "").replace(/\r\n?/g, "\n")).filter((b) => b.startsWith(mark));
  const handoverLabel = (at) => handoverBodies.length > 0 || inRun(at);
  const dropped = handoverBodies.some((b) => handoverOf(b.slice(mark.length)) === null);
  const relabeled = (at) => labels.some((e) => e.label?.name === HANDOVER_LABEL && (e.actor?.login ?? e.actor?.name) === login && ms(e.created_at) > ms(at) && handoverLabel(e.created_at));
  // Pendulum lifts its own Blocked only on recovery: the Objective label re-applied after the latest block.
  const recovered = (at) => {
    const block = labels.filter((e) => e.label?.name === BLOCKED_LABEL && ms(e.created_at) <= ms(at)).at(-1);
    return !!block && labels.some((e) => e.label?.name === label && ms(e.created_at) >= ms(block.created_at) && ms(e.created_at) <= ms(at));
  };
  return (at, actor, kind, id = null) => {
    if (tidied(at, actor, kind, id)) return true;
    if ((actor?.login ?? actor?.name) !== login) return false;
    if (kind === `labeled ${HANDOVER_LABEL}`) return handoverLabel(at);
    if (kind === `unlabeled ${HANDOVER_LABEL}`) return inRun(at) && (dropped || relabeled(at));
    if (/^(un)?labeled /.test(kind)) return LOCAL_STATE_KIND.test(kind) && (kind !== `unlabeled ${BLOCKED_LABEL}` || recovered(at));
    if (kind === "comment") return false;
    if (kind === "marker comment" || kind === "merged") return true;
    return windows.some(([a, b]) => ms(at) >= a && ms(at) <= b);
  };
}

/**
 * The Done records on the issue (dispatch.mjs, logic.mjs doneRecord) by a person's login: who, which state labels,
 * since when; and `closedAt`, whether the issue was closed at a time (a close at or before it, no reopen between).
 * Only one posted while the issue was closed is a Done record.
 */
function doneRecords(collected) {
  const mark = `<!-- pendulum:${collected.issue?.number}:done -->`;
  const events = (collected.issueTimeline || []).filter((e) => e.event === "closed" || e.event === "reopened").sort((a, b) => ms(a.created_at) - ms(b.created_at));
  const closedAt = (at) => events.filter((e) => ms(e.created_at) <= ms(at)).at(-1)?.event === "closed";
  const records = (collected.issueComments || [])
    .filter((c) => (c.body || "").startsWith(mark) && isHuman(c.user) && closedAt(c.created_at))
    .map((c) => ({
      login: c.user.login,
      labels: new Set((/^removed: (.*)$/m.exec(c.body)?.[1] ?? "").split(/\s+/).filter((l) => DONE_LABELS.test(l))),
      at: ms(c.created_at),
    }));
  return { records, closedAt };
}

/** Pendulum's local-route marks (localPendulumActions): each `<labeled event id> <login that posted it>` pair. */
function localRouteMarks(collected) {
  const head = new RegExp(`^<!-- pendulum:${collected.issue?.number}:local-route:(\\d+) -->`);
  const out = new Set();
  for (const c of collected.issueComments || []) {
    const id = head.exec(c.body || "")?.[1];
    if (id && c.user?.login) out.add(`${id} ${c.user.login}`);
  }
  return out;
}

/** The login a local-mode Objective's Pendulum posts as: its first progress comment's author. Null off local mode. */
export function localLogin(collected) {
  const labels = (collected.issue?.labels || []).map((l) => (typeof l === "string" ? l : l.name));
  if (!labels.includes("pendulum:local")) return null;
  const n = collected.issue?.number;
  return (collected.issueComments || []).find((c) => (c.body || "").startsWith(`<!-- pendulum:${n}:progress`))?.user?.login ?? null;
}

/**
 * Whether a PR or issue event is a merge's own consequence, not an act of its own: the PR closed by its merge, its
 * branch deleted after it, the issue closed by its closing keyword. Each is the merge's, whoever merged: a human merge
 * already counts as the merge.
 */
const CONSEQUENCE_MS = 2 * 60_000;
function mergeConsequence(event, at, mergedTimes) {
  if (event !== "closed" && event !== "head_ref_deleted") return false;
  return mergedTimes.some((m) => ms(at) >= m && ms(at) - m <= CONSEQUENCE_MS);
}

/**
 * The adopter drill's record of its own dispatch (bench/drill.mjs --dispatch), posted on each Objective it filed:
 * `<!-- pendulum:N:drill {"dispatch": RUN_ID} -->`, the run id GitHub returned for the dispatch.
 */
export const drillRecord = (issue, runId) => `<!-- pendulum:${issue}:drill ${JSON.stringify({ dispatch: runId })} -->\nThe adopter drill (bench/drill.mjs) started Pendulum's workflow for this Objective as run ${runId}; the scorecard reads that run as the drill's, not as operator input.`;

/**
 * The workflow runs the drill that filed this Objective dispatched itself: the run ids of drill records (drillRecord)
 * posted by the issue's own author, who filed it. Only their first attempt is the drill's (humanRuns).
 */
export function drillDispatches(collected) {
  const n = collected.issue?.number;
  const author = collected.issue?.user?.login;
  const out = new Map();
  if (!author) return out;
  for (const c of collected.issueComments || []) {
    if (c.user?.login !== author) continue;
    const m = new RegExp(`^<!-- pendulum:${n}:drill (\\{[^\\n]*\\}) -->`).exec(c.body || "");
    if (!m) continue;
    try {
      const id = JSON.parse(m[1])?.dispatch;
      if (Number.isSafeInteger(id)) out.set(id, author);
    } catch {
      // a malformed record names no run
    }
  }
  return out;
}

/**
 * The Pendulum workflow runs a person started or re-ran between the clock and the Objective's end (collect.mjs
 * `workflowRuns`): each is operator input. A run tied to Objectives by its jobs (`work (N)`, `launch (N)`, `review
 * (pendulum/N)`) counts for those; one tied to none (a hand-started dispatcher tick) counts for every Objective in
 * flight then. Bots never count. Pendulum never dispatches its own workflow under a person's login, but in local mode
 * its red-check triage re-runs failed jobs with the operator's token (plugin triage.mjs): a re-run by that login of a
 * run on a head Pendulum's own triage record names (`<!-- pendulum:triage {"reruns": [sha]} -->` in its progress
 * comments) is Pendulum's. A person's re-run on that same head reads as Pendulum's too; the record names no run. The
 * dispatch the adopter drill made for the Objectives it filed (drillDispatches: the run id it recorded on the issue, by
 * the issue's author, who must also be the run's triggering actor) is the drill's, not input; a re-run of it is.
 */
export function humanRuns(collected, since, end, { bots = new Set() } = {}) {
  const n = collected.issue.number;
  const local = localLogin(collected);
  const triaged = local ? triageReruns(collected, local) : new Set();
  const drill = drillDispatches(collected);
  const out = [];
  for (const r of collected.workflowRuns || []) {
    const rerun = (r.attempt ?? 1) > 1;
    if (!rerun && r.event !== "workflow_dispatch") continue;
    const at = rerun ? r.run_started_at ?? r.created_at : r.created_at;
    if (!(ms(at) > ms(since)) || (end && ms(at) > ms(end))) continue;
    if (!isHuman(r.by, bots)) continue;
    if (rerun && r.by?.login === local && r.head_sha && triaged.has(r.head_sha)) continue;
    if (!rerun && drill.has(r.id) && drill.get(r.id) === r.by?.login) continue;
    const tied = r.issues || [];
    if (tied.length && !tied.includes(n)) continue;
    out.push({ at, where: `run ${r.id}`, kind: rerun ? `re-run (attempt ${r.attempt})` : "workflow_dispatch", by: r.by.login ?? "unknown", detail: tied.length ? `tied to #${tied.join(", #")}` : "tied to no Objective: counts for every Objective in flight" });
  }
  return out;
}

/** The heads local-mode triage re-ran failed jobs on: the `reruns` of the triage records in `login`'s progress comments. */
function triageReruns(collected, login) {
  const n = collected.issue.number;
  const out = new Set();
  for (const c of collected.issueComments || []) {
    if (c.user?.login !== login || !(c.body || "").startsWith(`<!-- pendulum:${n}:progress:`)) continue;
    const m = /^<!-- pendulum:triage (\{[^\n]*\}) -->$/m.exec(c.body || "");
    if (!m) continue;
    try {
      for (const sha of JSON.parse(m[1])?.reruns || []) if (typeof sha === "string" && sha) out.add(sha);
    } catch {
      // a malformed record: nothing re-run by Pendulum
    }
  }
  return out;
}

/** The human actions after `since` on the issue and its PRs, oldest first: each {at, where, kind, by, detail}. */
export function humanActions(collected, since, { bots = new Set(), label = OBJECTIVE_LABEL } = {}) {
  const out = [];
  const after = (at) => Number.isFinite(ms(at)) && ms(at) > ms(since);
  const pendulumLocal = localPendulumActions(collected, { label });
  const push = (at, where, kind, actor, detail = "", id = null) => {
    if (after(at) && isHuman(actor, bots) && !pendulumLocal(at, actor, kind, id)) out.push({ at, where, kind, by: actor.login ?? actor.name ?? "unknown", detail });
  };
  const issue = `#${collected.issue.number}`;
  const branch = branchPulls(collected);
  const mergedTimes = branch.filter((pr) => pr.merged_at).map((pr) => ms(pr.merged_at));
  for (const e of collected.issueTimeline || []) {
    if (mergeConsequence(e.event, e.created_at, mergedTimes)) continue;
    // Passive events (mentioned, subscribed, cross-referenced from elsewhere) and bookkeeping (issue type,
    // milestone, pin, project card) are not input to the Objective's work.
    if (PASSIVE_EVENTS.has(e.event)) continue;
    if (e.event === "labeled" && e.label?.name === label && e.created_at === since) continue; // the clock itself
    if (e.event === "unlabeled" && e.label?.name === DRAFT_LABEL && e.created_at === since) continue; // a draft's start: the clock
    // Labels the issue's author applies while filing it (a priority, the type's labels) are part of filing, not input.
    if (e.event === "labeled" && (e.actor?.login ?? null) === (collected.issue.user?.login ?? undefined) && ms(e.created_at) - ms(collected.issue.created_at) <= 60_000) continue;
    if (e.event === "commented") {
      if (/<!-- pendulum:/.test(e.body || "")) continue; // Pendulum's own protocol (plan, progress, hold, blocked markers), whoever posted it
      push(e.created_at, issue, "comment", e.user ?? e.actor, (e.body || "").slice(0, 80));
      continue;
    }
    push(e.created_at, issue, e.event === "labeled" || e.event === "unlabeled" ? `${e.event} ${e.label?.name ?? ""}` : e.event, e.actor, "", e.id ?? null);
  }
  for (const c of collected.issueComments || []) if (!/<!-- pendulum:/.test(c.body || "")) push(c.created_at, issue, "comment", c.user, (c.body || "").slice(0, 80));
  for (const pr of collected.pulls || []) {
    const where = `PR #${pr.number}`;
    const d = collected.pullDetails?.[pr.number] ?? {};
    push(pr.created_at, where, "opened", pr.user);
    if (pr.merged_at) push(pr.merged_at, where, "merged", pr.merged_by);
    for (const c of d.commits || []) push(c.commit?.committer?.date ?? c.commit?.author?.date, where, "push", commitActor(c), (c.sha || "").slice(0, 7));
    for (const e of d.timeline || []) {
      if (["mentioned", "subscribed", "cross-referenced", "connected", "referenced", "commented", "committed", "reviewed", "review_requested"].includes(e.event)) continue;
      if (mergeConsequence(e.event, e.created_at, mergedTimes)) continue;
      push(e.created_at, where, e.label ? `${e.event} ${e.label.name}` : e.event, e.actor);
    }
    // Pendulum's own PR comments carry a marker; in local mode they are its own, posted as the operator.
    for (const c of d.comments || []) push(c.created_at, where, /<!-- pendulum:/.test(c.body || "") ? "marker comment" : "comment", c.user, (c.body || "").slice(0, 80));
    for (const r of d.reviews || []) push(r.submitted_at, where, `review ${String(r.state || "").toLowerCase()}`, r.user, (r.body || "").slice(0, 80));
    for (const c of d.reviewComments || []) push(c.created_at, where, "review comment", c.user, (c.body || "").slice(0, 80));
  }
  const end = branch.find((pr) => pr.merged_at)?.merged_at ?? collected.issue.closed_at ?? null;
  out.push(...humanRuns(collected, since, end, { bots }));
  // Oldest first; duplicates from the timeline and the comments endpoint collapse on (at, where, kind).
  const seen = new Set();
  return out
    .sort((a, b) => ms(a.at) - ms(b.at))
    .filter((a) => {
      const key = `${a.at}|${a.where}|${a.kind}|${a.by}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/**
 * What Pendulum asked a person for after `since`, oldest first: each {at, kind, until}. A request is Pendulum's when
 * it carries a `<!-- pendulum:N:... -->` marker (the Blocked notice, a QUESTION in the plan comment) or its actor is a
 * machine, or, in local mode where Pendulum acts as the operator's login, localPendulumActions says it is Pendulum's:
 *   question        the pendulum:question label, or QUESTION in the plan comment or a Pendulum PR's body
 *   blocked         the pendulum:blocked label, or the blocked marker comment
 *   review request  a review requested on a pendulum/<issue> PR
 *   workflow hand-over  each merged PR whose body carries Pendulum's hand-over line (handoverSteps), at its merge
 * A request stays open until Pendulum next labels the Objective pendulum:running (it picked the work up again).
 */
export function pendulumRequests(collected, since, { bots = new Set() } = {}) {
  const n = collected.issue.number;
  const pendulumLocal = localPendulumActions(collected);
  const byPendulum = (at, actor, kind) => !isHuman(actor, bots) || pendulumLocal(at, actor, kind);
  const after = (at) => Number.isFinite(ms(at)) && ms(at) >= ms(since);
  const out = [];
  const resumed = [];
  for (const e of collected.issueTimeline || []) {
    if (e.event !== "labeled" || !after(e.created_at) || !byPendulum(e.created_at, e.actor, `labeled ${e.label?.name}`)) continue;
    if (e.label?.name === QUESTION_LABEL) out.push({ at: e.created_at, kind: "question" });
    if (e.label?.name === BLOCKED_LABEL) out.push({ at: e.created_at, kind: "blocked" });
    if (e.label?.name === RUNNING_LABEL) resumed.push(ms(e.created_at));
  }
  for (const c of collected.issueComments || []) {
    const body = c.body || "";
    if (!after(c.created_at)) continue;
    if (body.startsWith(`<!-- pendulum:${n}:blocked`)) out.push({ at: c.created_at, kind: "blocked" });
    if (body.startsWith(`<!-- pendulum:${n}:plan -->`) && /\bQUESTION\b/.test(body)) out.push({ at: c.created_at, kind: "question" });
  }
  for (const pr of branchPulls(collected)) {
    for (const step of handoverSteps(collected, [pr])) if (after(step.at)) out.push({ at: step.at, kind: "workflow hand-over" });
    if (after(pr.created_at) && /\bQUESTION\b/.test(pr.body || "") && byPendulum(pr.created_at, pr.user, "opened")) out.push({ at: pr.created_at, kind: "question" });
    for (const e of collected.pullDetails?.[pr.number]?.timeline || []) if (e.event === "review_requested" && after(e.created_at) && byPendulum(e.created_at, e.actor, e.event)) out.push({ at: e.created_at, kind: "review request" });
  }
  return out
    .sort((a, b) => ms(a.at) - ms(b.at))
    .map((r) => {
      const next = resumed.filter((t) => t > ms(r.at)).sort((a, b) => a - b)[0];
      return { ...r, until: next === undefined ? null : new Date(next).toISOString() };
    });
}

/**
 * The workflow hand-over's steps: Pendulum never pushes a workflow file, so each merged PR of the Objective (every part
 * of a split one) whose body carries Pendulum's hand-over line (plugin handover.mjs, read on its marker) leaves a person's
 * step at its merge, asked for (pendulumRequests reads the same list). scoreObjective scores them by HANDOVER_SCORING: an
 * owner step apart from the walk-away, or one human action each. `pulls`: the Objective's PRs (branchPulls).
 */
export function handoverSteps(collected, pulls = branchPulls(collected)) {
  return pulls
    .filter((pr) => pr.merged_at && carriesHandover(pr.body, collected.issue.number))
    .sort((a, b) => ms(a.merged_at) - ms(b.merged_at))
    .map((pr) => ({ at: pr.merged_at, where: `PR #${pr.number}`, kind: "workflow hand-over", by: "a person (applies the patch)", detail: "" }));
}

/**
 * Whether an act on the issue is Pendulum's own for the hand-over: its App's login (pendulumLogin: `app`, else the App
 * that applied pendulum:running), or in local mode the operator's where localPendulumActions says so. Never just any
 * bot: another machine's comment or label is not Pendulum's hand-over.
 */
function handoverActor(collected, { app = null } = {}) {
  const self = pendulumLogin(collected.issueTimeline, app);
  const local = localPendulumActions(collected);
  return (at, actor, kind) => (!!self && String(actor?.login ?? "").toLowerCase() === self) || local(at, actor, kind);
}

/**
 * Whether Pendulum's hand-over comment is on the issue with a patch in it (`<!-- pendulum:N:handover -->` first, then
 * handoverOf's fenced diff): the hand-over a person can apply. Only Pendulum's own comment (handoverActor) counts.
 */
export function handoverPosted(collected, { app = null } = {}) {
  const mark = `${handoverMarker(collected.issue.number)}\n`;
  const pendulum = handoverActor(collected, { app });
  return (collected.issueComments || []).some((c) => {
    const body = String(c.body || "").replace(/\r\n?/g, "\n");
    return body.startsWith(mark) && pendulum(c.created_at, c.user, "marker comment") && handoverOf(body.slice(mark.length)) !== null;
  });
}

/**
 * The person's mark that the hand-over is applied, as Pendulum reads it (plugin handoff.mjs handoverApplied): their
 * latest removal of pendulum:handover in `marks`, unless Pendulum applied the label again after it (a later part's new
 * patch, still pending). `{at, by}` or null.
 */
function handoverApplied(collected, marks, { app = null } = {}) {
  const last = marks.at(-1);
  if (!last) return null;
  const pendulum = handoverActor(collected, { app });
  const again = (collected.issueTimeline || []).some((e) => e.event === "labeled" && e.label?.name === HANDOVER_LABEL && ms(e.created_at) > ms(last.at) && pendulum(e.created_at, e.actor, `labeled ${HANDOVER_LABEL}`));
  return again ? null : { at: last.at, by: last.by };
}

/**
 * An answered Question is operator input on every route. Pendulum asks by labelling the Objective pendulum:question
 * (its own label event) and waits; it resumes (labels it Running again) or merges only after a person answered. When
 * no human action of the row falls between the Question and that resume, the answer happened where the scorer cannot
 * see it, and it still counts: one `answered Question` action per such Question, at the Question.
 */
export function unattributedAnswers(collected, since, actions, mergedAt, { bots = new Set() } = {}) {
  const pendulumLocal = localPendulumActions(collected);
  const byPendulum = (e) => !isHuman(e.actor, bots) || pendulumLocal(e.created_at, e.actor, `${e.event} ${e.label?.name}`);
  const labels = (collected.issueTimeline || []).filter((e) => e.event === "labeled" && ms(e.created_at) >= ms(since) && byPendulum(e)).sort((a, b) => ms(a.created_at) - ms(b.created_at));
  const out = [];
  for (const q of labels.filter((e) => e.label?.name === QUESTION_LABEL)) {
    const resumed = labels.find((e) => e.label?.name === RUNNING_LABEL && ms(e.created_at) > ms(q.created_at))?.created_at ?? mergedAt;
    if (!resumed) continue; // still waiting: not answered yet
    if (actions.some((a) => ms(a.at) >= ms(q.created_at) && ms(a.at) <= ms(resumed))) continue;
    out.push({ at: q.created_at, where: `#${collected.issue.number}`, kind: "answered Question", by: "unattributed", detail: `Pendulum resumed at ${resumed} after its Question; the answer is not on the issue or the PR` });
  }
  return out;
}

/**
 * Each action with `asked`: the kind of the open Pendulum request it answers (the latest one made at or before it and
 * not yet followed by Pendulum's pick-up), or null when nothing was asked: an owner's note, scope added after the label,
 * a push or a relabel on their own initiative.
 */
export function splitInterventions(actions, requests) {
  return actions.map((a) => {
    const open = requests.filter((r) => ms(r.at) <= ms(a.at) && (r.until === null || ms(a.at) < ms(r.until)));
    return { ...a, asked: open.at(-1)?.kind ?? null };
  });
}

/**
 * When Pendulum was acting on the Objective, as [start, end] spans in ms, oldest first. Pendulum is its App's login
 * (pendulumLogin) or, in local mode, the operator's login where localPendulumActions says the act is Pendulum's. Each act
 * on the issue or its PRs (a label, a comment, a review, an enqueue, the merge it armed) is a point; a progress comment
 * spans its stage (created to the stage's own last write, stageLastWrite), and each job of the runs that uploaded usage
 * spans its run. Another machine's act (the merge queue dropping a PR) is not Pendulum's, nor is booking a stage's
 * sandbox cost: the sandbox record's late edits (rewritten even after the merge) and the stage's vendor comment
 * (written by the sweep hours later for a lost stage; in older stages, an edit of the progress comment), so a stage
 * that died and waited for the sweep shows as idle.
 */
export function pendulumActivity(collected, { app = null } = {}) {
  const self = pendulumLogin(collected.issueTimeline, app);
  const local = localPendulumActions(collected);
  const mine = (at, actor, kind, id = null) => (!!self && String(actor?.login ?? "").toLowerCase() === self) || local(at, actor, kind, id);
  const spans = [];
  const point = (at, actor, kind, id = null) => {
    if (Number.isFinite(ms(at)) && mine(at, actor, kind, id)) spans.push([ms(at), ms(at)]);
  };
  const n = collected.issue.number;
  for (const e of collected.issueTimeline || []) point(e.created_at, e.actor ?? e.user, e.label ? `${e.event} ${e.label.name}` : e.event, e.id ?? null);
  for (const c of collected.issueComments || []) {
    if ((c.body || "").startsWith(`<!-- pendulum:${n}:vendor:`)) continue;
    if ((c.body || "").startsWith(`<!-- pendulum:${n}:progress`) && mine(c.created_at, c.user, "progress")) {
      const end = Math.max(ms(c.created_at), stageLastWrite(c) ?? 0);
      if (Number.isFinite(ms(c.created_at))) spans.push([ms(c.created_at), end]);
    } else point(c.created_at, c.user, /<!-- pendulum:/.test(c.body || "") ? "marker comment" : "comment");
  }
  for (const pr of branchPulls(collected)) {
    const d = collected.pullDetails?.[pr.number] ?? {};
    point(pr.created_at, pr.user, "opened");
    if (pr.merged_at) point(pr.merged_at, pr.merged_by, "merged");
    for (const e of d.timeline || []) point(e.created_at ?? e.submitted_at, e.actor ?? e.user, e.event === "merged" ? "merged" : e.event);
    for (const c of d.comments || []) point(c.created_at, c.user, /<!-- pendulum:/.test(c.body || "") ? "marker comment" : "comment");
    for (const r of d.reviews || []) point(r.submitted_at, r.user, "review");
    for (const c of d.reviewComments || []) point(c.created_at, c.user, "review comment");
  }
  for (const j of collected.jobs || []) if (Number.isFinite(ms(j.started_at))) spans.push([ms(j.started_at), Math.max(ms(j.started_at), ms(j.completed_at) || 0)]);
  return spans.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

/**
 * The longest time a merged Objective sat idle between Pendulum's acts, from its first act after the clock to the
 * merge: `{minutes, from, until, thresholdMinutes, stalled}`, or null when it did not merge or Pendulum never acted.
 * The label-to-first-act wait is not counted: it is the first run's dispatch (dispatchLatency, slot wait apart). A
 * gap while a Question or Blocked request of Pendulum's was open is a person's turn, not idle. `stalled` when the gap is
 * longer than the threshold: something other than Pendulum had to move it (the next tick, an unrelated event).
 */
export function idleStall(collected, since, mergedAt, { app = null, requests = [], thresholdMinutes = STALL_MINUTES } = {}) {
  if (!mergedAt || !Number.isFinite(ms(mergedAt))) return null;
  const stop = ms(mergedAt);
  const spans = pendulumActivity(collected, { app }).filter(([a, b]) => b >= ms(since) && a <= stop);
  if (!spans.length) return null;
  const waits = requests.filter((r) => r.kind === "question" || r.kind === "blocked").map((r) => [ms(r.at), r.until === null ? Number.POSITIVE_INFINITY : ms(r.until)]);
  let end = Math.max(ms(since), spans[0][1]);
  let worst = null;
  for (const [a, b] of [...spans.slice(1), [stop, stop]]) {
    const gap = a - end;
    if (gap > 0 && !waits.some(([w0, w1]) => w0 <= end && w1 >= a) && (!worst || gap > worst.gap)) worst = { gap, from: end, until: a };
    end = Math.max(end, b);
  }
  if (!worst) return { minutes: 0, from: null, until: null, thresholdMinutes, stalled: false };
  const minutes = Math.round((worst.gap / 60_000) * 10) / 10;
  const iso = (t) => new Date(t).toISOString().replace(/\.000Z$/, "Z");
  return { minutes, from: iso(worst.from), until: iso(worst.until), thresholdMinutes, stalled: minutes > thresholdMinutes };
}

/** `s` without its `<!-- ... -->` spans; an unclosed one runs to the end. A scan, not a regex, so nothing it cuts can rejoin. */
function withoutComments(s) {
  let out = "";
  let i = 0;
  for (;;) {
    const open = s.indexOf("<!--", i);
    if (open < 0) return out + s.slice(i);
    out += s.slice(i, open);
    const close = s.indexOf("-->", open + 4);
    if (close < 0) return out;
    i = close + 3;
  }
}

/** The one-line reason from the worker's Blocked comment (session.mjs applyExit): "Blocked (stage): <reason> — ..." */
function blockedReason(body) {
  const text = withoutComments(String(body || "")).replace(/^\s*@\S+\s*/, "").trim();
  const m = /Blocked \(([^)]*)\):\s*([^\n]*?)(?:\s+—\s+PR #\d+|\s+Fix by pushing|$)/m.exec(text);
  return m ? `${m[2].trim()} (${m[1]})`.slice(0, 200) : text.split("\n")[0].slice(0, 200);
}

/** Whether the Objective reached Blocked after `since`: the label, or the worker's blocked marker comment. */
export function blockedAt(collected, since) {
  const n = collected.issue.number;
  const marker = `<!-- pendulum:${n}:blocked`;
  const hits = [];
  for (const e of collected.issueTimeline || []) if (e.event === "labeled" && e.label?.name === BLOCKED_LABEL && ms(e.created_at) >= ms(since)) hits.push({ at: e.created_at, reason: null });
  for (const c of collected.issueComments || []) if ((c.body || "").includes(marker) && ms(c.created_at) >= ms(since)) hits.push({ at: c.created_at, reason: blockedReason(c.body) });
  hits.sort((a, b) => ms(a.at) - ms(b.at));
  if (!hits.length) return null;
  return { at: hits[0].at, reason: hits.find((h) => h.reason)?.reason ?? null };
}

/**
 * Pendulum's Blocked notices after `since`, oldest first, each with the cause its notice records (plugin logic.mjs
 * blockMarker), null for a notice written before causes were (or one off the list). Only Pendulum's own notices: a
 * person's comment carrying the marker is input, never a cause.
 */
export function blockStops(collected, since, { bots = new Set() } = {}) {
  const n = collected.issue.number;
  const pendulumLocal = localPendulumActions(collected);
  return (collected.issueComments || [])
    .filter((c) => (c.body || "").includes(`<!-- pendulum:${n}:blocked`) && ms(c.created_at) >= ms(since) && (!isHuman(c.user, bots) || pendulumLocal(c.created_at, c.user, "marker comment")))
    .map((c) => ({ at: c.created_at, cause: blockCauseOf(c.body) }))
    .sort((a, b) => ms(a.at) - ms(b.at));
}

/**
 * The walk-away bucket (docs/PLAN.md, Job one): `walk-away`; `external` when every stop was outside Pendulum and the
 * work: at least one Block, each recording an external cause (BLOCK_CAUSES), no Question, every human action an answer
 * to a Block (asked for by it), no stall and every input source read; else `miss`. Nothing here changes how input is
 * found: it reads the actions, requests and stops the row already has.
 */
export function walkAwayBucket({ value, blocks, question, actions, stall, unseen }) {
  if (value) return "walk-away";
  const external = blocks.length > 0 && blocks.every((b) => BLOCK_CAUSES[b.cause]?.external === true);
  const answeredBlocks = actions.every((a) => a.asked === "blocked");
  return external && !question && answeredBlocks && !stall && unseen.length === 0 ? "external" : "miss";
}

/** Whether the worker raised a Question: the label, or QUESTION in a draft PR body or the plan comment. */
export function questionAt(collected, since) {
  const n = collected.issue.number;
  const plan = `<!-- pendulum:${n}:plan -->`;
  for (const e of collected.issueTimeline || []) if (e.event === "labeled" && e.label?.name === QUESTION_LABEL && ms(e.created_at) >= ms(since)) return { at: e.created_at, source: "label" };
  for (const pr of collected.pulls || []) if (/\bQUESTION\b/.test(pr.body || "")) return { at: pr.created_at, source: `PR #${pr.number} body` };
  for (const c of collected.issueComments || []) if ((c.body || "").includes(plan) && /\bQUESTION\b/.test(c.body || "")) return { at: c.created_at, source: "plan comment" };
  return null;
}

/** Pendulum's own vendor comments for the Objective's sandbox stages (plugin launch.mjs bookVendor), oldest first. */
function vendorComments(collected, { app = null } = {}) {
  const n = collected.issue.number;
  const self = pendulumLogin(collected.issueTimeline, app);
  const mine = (c) => self && String(c.user?.login ?? "").toLowerCase() === self;
  return (collected.issueComments || []).filter((c) => new RegExp(`^<!-- pendulum:${n}:vendor:(work|review)[:\\s-]`).test(c.body || "") && mine(c)).sort((a, b) => ms(a.created_at) - ms(b.created_at));
}
/** Pendulum's own progress comments for the Objective's work and review stages, oldest first: its App's login, or in local mode the login its progress comments are posted as. */
function pendulumStages(collected, { app = null } = {}) {
  const n = collected.issue.number;
  const self = pendulumLogin(collected.issueTimeline, app);
  const local = localLogin(collected);
  const mine = (c) => (self && String(c.user?.login ?? "").toLowerCase() === self) || (local && c.user?.login === local);
  return (collected.issueComments || []).filter((c) => new RegExp(`^<!-- pendulum:${n}:progress:(work|review)[:\\s-]`).test(c.body || "") && mine(c)).sort((a, b) => ms(a.created_at) - ms(b.created_at));
}

/**
 * The harness and models an Objective ran on: the worker's model as its harness reported it (the cost row's), else as
 * its last work stage recorded it; that stage's sub-agent model; its last review stage's reviewer model; and the
 * harness and model labels that chose them, none when it ran on the repository's defaults. Each from a usage record's
 * `ran` (plugin choice.mjs ranWith: the usage artifact's result.json, or a local stage's progress line); null where no
 * record names one (an older stage, or a harness's own default).
 */
export function objectiveModels(usage, cost) {
  const last = (stage) => (usage || []).filter((r) => r?.ran && stageOf(r) === stage).at(-1)?.ran ?? null;
  const work = last("work");
  const review = last("review");
  return { worker: cost?.model ?? work?.worker ?? null, subagent: work?.subagent ?? review?.subagent ?? null, reviewer: review?.reviewer ?? work?.reviewer ?? null, labels: [...new Set([...(work?.labels || []), ...(review?.labels || [])])].sort() };
}

/**
 * The local accounts an Objective's stages ran on (plugin accounts.mjs), by name, in the order first seen: each usage
 * record's `account` (a stage's result.json, or its progress comment's harness line). Empty where none names one.
 */
export const objectiveAccounts = (usage) => [...new Set((usage || []).map((r) => r?.account).filter((a) => typeof a === "string" && ACCOUNT.test(a)))];

/** One account's share as the Harness cell shows it: "alpha (3 stages, $1.20 plus 1 run of unknown cost, 1 limit pause)". */
const useText = (u) => `${u.account} (${u.stages} stage${u.stages === 1 ? "" : "s"}, ${spendText({ usd: u.usd, unknown: u.unknown ?? 0, byBilling: u.usdByBilling })}${u.limitPauses ? `, ${u.limitPauses} limit pause${u.limitPauses === 1 ? "" : "s"}` : ""})`;

/** The scorecard's Harness cell: the harness, the worker model, the sub-agent and reviewer models, the local accounts (each with its share, accountUse), and the labels that chose them. */
export function harnessCell(r) {
  const m = r.models || {};
  const parts = [`${r.harness ?? "?"}${(m.worker ?? r.model) ? ` ${m.worker ?? r.model}` : ""}`];
  if (m.subagent) parts.push(`sub-agents ${m.subagent}`);
  if (m.reviewer) parts.push(`reviewer ${m.reviewer}`);
  if (r.accountUse?.length) parts.push(`account${r.accountUse.length > 1 ? "s" : ""} ${r.accountUse.map(useText).join(", ")}`);
  else if (r.accounts?.length) parts.push(`account${r.accounts.length > 1 ? "s" : ""} ${r.accounts.join(", ")}`);
  return `${parts.join("; ")}${m.labels?.length ? ` (by label: ${m.labels.join(", ")})` : ""}`;
}

/**
 * The harness the Objective's work ran on, from Pendulum's own progress comments (stageHarnessOf): its work stages, else
 * its review stages: `{harness, mixed}`. Two different harnesses (a relabel with another harness) read `mixed` and
 * no harness, none reads no harness: the streak then cannot credit any one harness.
 */
export function objectiveHarness(collected, { app = null } = {}) {
  const stages = pendulumStages(collected, { app });
  const n = collected.issue.number;
  const of = (kind) => new Set(stages.filter((c) => (c.body || "").startsWith(`<!-- pendulum:${n}:progress:${kind}`)).map((c) => stageHarnessOf(c.body)?.harness).filter(Boolean));
  const work = of("work");
  const seen = work.size ? work : of("review");
  return { harness: seen.size === 1 ? [...seen][0] : null, mixed: seen.size > 1 };
}

/**
 * Usage records from Pendulum's spend lines (`<!-- pendulum:spend {...} -->`, plugin logic.mjs spendMarker), one per
 * progress comment of Pendulum's own: its App's login, or in local mode the login its progress comments are posted as.
 * A sandbox stage's vendor dollars are in its vendor comment (`<!-- pendulum:<n>:vendor:<key> -->`, the progress
 * comment's key; one of a stage that left no progress comment is a row of its own); an older stage's progress spend
 * line carries them itself. A stage whose comment has no spend line is a part of unknown cost. A line's runs of unknown
 * cost (`usdUnknown`) ride on the record, a sandbox the vendor reported no usage for on its `vendor` (usd null). The
 * harness and model are the stage's own (stageHarnessOf), carried to the review stages; dollars are the worker's own pricing.
 */
export function spendRecords(collected, { app = null, all = false } = {}) {
  return stageSpendRecords(collected.issue.number, pendulumStages(collected, { app }), vendorComments(collected, { app }), { all });
}

/**
 * Usage records of the decision calls made about the Objective outside any stage (the dispatcher's, the launcher's and
 * local mode's answer, comment, edit and lapse checks): the decision-spend lines (plugin logic.mjs decisionSpendMarker)
 * in Pendulum's own comments on the issue, one record per comment that has any, summed over its days: their known
 * dollars and calls of unknown cost, `source` "decisions", on every route (no usage artifact carries them). A line in
 * anyone else's comment counts nothing.
 */
export function decisionRecords(collected, { app = null } = {}) {
  const self = pendulumLogin(collected.issueTimeline, app);
  const local = localLogin(collected);
  const mine = (c) => (self && String(c.user?.login ?? "").toLowerCase() === self) || (local && c.user?.login === local);
  return decisionSpendRecords(collected.issue.number, (collected.issueComments || []).filter(mine));
}

/**
 * The Objective's send-back rebases (#277): `sentBack`, Pendulum's send-back notices on its PRs (each names the head it
 * saw, `<!-- pendulum:<n>:rebase:<sha> -->`), and from its own work stages' rebase lines (plugin logic.mjs
 * rebaseCostMarker, written on every route) `stages` (the rebases that ran), `usd` (their known dollars with their
 * sandboxes', also in the row's cost), `unknown` (the runs of unknown cost in them), `byBilling` (their known dollars by billing, when the lines name it) and `conflicts` (the ones a harness
 * resolved). A stage from before the rebase line is in `sentBack` only.
 */
export function rebasesOf(collected, { app = null } = {}) {
  const n = collected.issue.number;
  const self = pendulumLogin(collected.issueTimeline, app);
  const local = localLogin(collected);
  const mine = (c) => (self && String(c.user?.login ?? "").toLowerCase() === self) || (local && c.user?.login === local);
  // The stages' own vendor comments ride along: a sandbox rebase's dollars include its sandbox's (rebaseTally).
  const tally = rebaseTally([...pendulumStages(collected, { app }), ...vendorComments(collected, { app })], n, () => true);
  const notice = `<!-- pendulum:${n}:rebase:`;
  let sentBack = 0;
  for (const pr of branchPulls(collected)) sentBack += (collected.pullDetails?.[pr.number]?.comments || []).filter((c) => mine(c) && (c.body || "").startsWith(notice)).length;
  return { sentBack, stages: tally.count, usd: tally.usd, unknown: tally.unknown, conflicts: tally.conflicts, ...(tally.byBilling ? { byBilling: tally.byBilling } : {}) };
}

/**
 * The P1 escapes GitHub shows for the merged PR: an issue (not a PR) that references it, labelled P1, opened after the
 * merge. A P1 Objective that cites it counts too: filing the fix as an Objective is the usual way to fix an escape.
 * Only the Objective itself is no escape. Each is
 * `{issue: "owner/name#N", priority: "P1", at, title, source}`; the owner adds others by hand (kept across --append).
 */
export function p1Escapes(collected, merged) {
  if (!merged?.merged_at) return [];
  const own = `${collected.repository}#${collected.issue.number}`;
  const out = new Map();
  for (const e of collected.pullDetails?.[merged.number]?.timeline || []) {
    const src = e.event === "cross-referenced" ? e.source?.issue : null;
    if (!src || src.pull_request) continue;
    const names = (src.labels || []).map((l) => (typeof l === "string" ? l : l.name));
    if (!names.includes("P1")) continue;
    if (!(ms(src.created_at) > ms(merged.merged_at))) continue;
    const key = `${src.repository?.full_name ?? collected.repository}#${src.number}`;
    if (key === own) continue;
    out.set(key, { issue: key, priority: "P1", at: src.created_at, title: String(src.title ?? "").slice(0, 120), source: `references PR #${merged.number}` });
  }
  return [...out.values()];
}

/** The PRs whose head is pendulum/<issue>, merged first, then newest. */
export function branchPulls(collected) {
  const head = BRANCH(collected.issue.number);
  return (collected.pulls || [])
    .filter((pr) => (pr.head?.ref ?? pr.headRefName) === head)
    .sort((a, b) => (b.merged_at ? 1 : 0) - (a.merged_at ? 1 : 0) || ms(b.created_at) - ms(a.created_at));
}

/** Runner minutes for this issue's jobs, from the job log when collected; null with a reason otherwise. */
export function runnerMinutes(collected) {
  const jobs = collected.jobs || [];
  if (!jobs.length) return { minutes: null, basis: collected.jobs ? "no job for this issue in the pendulum workflow" : "unknown: no job log collected" };
  let total = 0;
  for (const j of jobs) total += Math.max(0, (ms(j.completed_at) - ms(j.started_at)) / 60_000 || 0);
  return { minutes: Math.round(total * 10) / 10, basis: `${jobs.length} job(s): ${jobs.map((j) => j.name).join(", ")}` };
}

/**
 * The row. `opts`: prices (lib/cost.mjs), minutes (number or undefined),
 * baseline (a ref or sha the judge compares against, or null), bots (a Set
 * of extra machine logins), label (the Objective label), app (Pendulum's App
 * login, else read from the timeline: lib/phases.mjs pendulumLogin).
 */
export function scoreObjective(collected, opts = {}) {
  const { prices, minutes: given, ownerMinutes = undefined, handover = HANDOVER_DEFAULT, baseline = null, bots = new Set(), label = OBJECTIVE_LABEL, clockAfter = null, checks = [], app = null, stallMinutes = STALL_MINUTES } = opts;
  if (!HANDOVER_SCORING.includes(handover)) throw new Error(`handover: ${handover} is not one of ${HANDOVER_SCORING.join(", ")}`);
  // read: the owner's read of the merged diff ("ok", "defect" or "unread"), given with --read, kept across --append.
  const issue = collected.issue;
  const missing = [];
  let since = labelTime(issue, collected.issueTimeline, label, clockAfter);
  let sinceBasis = clockAfter ? `first "${label}" label at or after ${clockAfter}` : `first "${label}" label`;
  if (!since) {
    since = clockAfter && ms(issue.created_at) < ms(clockAfter) ? clockAfter : issue.created_at;
    sinceBasis = clockAfter && since === clockAfter ? `--clock-after (no "${label}" label event at or after it)` : `issue created (no "${label}" label event found)`;
    missing.push("label event");
  }
  const pulls = branchPulls(collected);
  const merged = pulls.find((pr) => pr.merged_at) ?? null;
  const open = pulls.find((pr) => !pr.merged_at && pr.state === "open") ?? null;
  const blocked = blockedAt(collected, since);
  const question = questionAt(collected, since);
  let actions = humanActions(collected, since, { bots, label });
  const waiting = waitingMinutes(collected.issueTimeline, since, merged?.merged_at ?? null);
  const exit = merged ? "merged" : blocked ? "blocked" : question ? "question" : open ? (open.draft ? "draft" : "in review") : pulls.length ? "closed unmerged" : "no PR";
  // Parked: open, its label removed after Pendulum took it (it waits on other work). Its exit still says where it
  // stopped; it is never a walk-away (not merged) and the streak counts it only once it ended (lib/streak.mjs endedAt).
  const parked = issue.state === "open" && !missing.includes("label event") && Array.isArray(issue.labels) && !issue.labels.some((l) => (typeof l === "string" ? l : l?.name) === label);

  const pendulumLocal = localPendulumActions(collected);
  // Every body edit after the clock by a person, oldest first: never Pendulum's own login (its App's finish block on the
  // merged PR's body, plugin finish-card.mjs), nor, in local mode, what localPendulumActions says is Pendulum's.
  const self = pendulumLogin(collected.issueTimeline, app);
  const bodyEdit = [...(collected.bodyEdits || [])].sort((a, b) => ms(a.at) - ms(b.at)).find((e) => ms(e.at) > ms(since) && isHuman(e.by, bots) && !(self && e.by?.login === self) && !pendulumLocal(e.at, e.by, "body edit")) ?? null;
  if (bodyEdit) actions.unshift({ at: bodyEdit.at, where: bodyEdit.where, kind: "body edit", by: bodyEdit.by.login, detail: "" });
  if (collected.bodyEdits === null) missing.push("body edits (GraphQL unavailable)"); // undefined: not attempted (a fixture or a snapshot)
  actions.push(...unattributedAnswers(collected, since, actions, merged?.merged_at ?? null, { bots }));
  // A workflow hand-over (HANDOVER_SCORING): under owner-step, a posted one is the owner's step after the merge, never
  // input; the person's removal of pendulum:handover from then on is their mark that they applied it, part of that step.
  // Unposted (no Pendulum comment holds the patch), or under input, each step is one human action, as asked for.
  const steps = handoverSteps(collected).filter((a) => ms(a.at) > ms(since));
  const owned = handover === "owner-step" && steps.length > 0 && handoverPosted(collected, { app });
  let ownerStep = null;
  if (owned) {
    const mark = (a) => a.where === `#${issue.number}` && a.kind === `unlabeled ${HANDOVER_LABEL}` && ms(a.at) >= ms(steps[0].at);
    const applied = handoverApplied(collected, actions.filter(mark), { app });
    actions = actions.filter((a) => !mark(a));
    const timed = typeof ownerMinutes === "number" && Number.isFinite(ownerMinutes);
    ownerStep = {
      kind: "workflow hand-over",
      steps: steps.map(({ at, where }) => ({ at, where })),
      applied: applied ? { at: applied.at, by: applied.by } : null,
      minutes: timed ? ownerMinutes : "unknown",
      basis: timed ? "--owner-minutes (stopwatch)" : `${applied ? "" : `not applied yet (${HANDOVER_LABEL} still on); `}give --owner-minutes <issue>=<n> from a stopwatch`,
    };
  } else actions.push(...steps.map((a) => (handover === "owner-step" ? { ...a, detail: "Pendulum's hand-over comment with the patch is not on the issue" } : a)));
  actions.sort((a, b) => ms(a.at) - ms(b.at));
  const ownerNote = ownerStep ? `; owner step: workflow hand-over (${ownerStep.steps.map((s) => s.where).join(", ")})` : "";
  if (collected.workflowRuns === null) missing.push("workflow runs (a hand-started or re-run Pendulum run is not seen)"); // undefined: not attempted
  // The input sources this row could not read (null: unreadable; undefined: never collected, an old snapshot or a
  // fixture): human input may hide there, so the streak never credits the row (lib/streak.mjs).
  const unseen = [...(collected.bodyEdits == null ? ["body edits"] : []), ...(collected.workflowRuns == null ? ["workflow runs"] : [])];
  const requests = pendulumRequests(collected, since, { bots });
  const split = splitInterventions(actions, requests);
  const asked = split.filter((a) => a.asked);
  const unprompted = split.filter((a) => !a.asked);
  const idle = idleStall(collected, since, merged?.merged_at ?? null, { app, requests, thresholdMinutes: stallMinutes });
  const stall = idle?.stalled ? { minutes: idle.minutes, from: idle.from, until: idle.until, thresholdMinutes: idle.thresholdMinutes } : null;
  const stallReason = stall ? `stalled ${stall.minutes} min after Pendulum's last action (${stall.from} to ${stall.until}; threshold ${stall.thresholdMinutes} min)` : null;
  const walkAway = {
    value: Boolean(merged) && !blocked && actions.length === 0 && !stall,
    // The rule this row scored a workflow hand-over by (HANDOVER_SCORING).
    handover,
    since,
    sinceBasis,
    // The longest idle span after Pendulum's first act, to the merge (idleStall); a stall when over the threshold.
    longestIdleMinutes: idle?.minutes ?? null,
    stall,
    firstHumanAction: split[0] ?? null,
    humanActions: actions.length,
    // The split (bench/README.md, the pendulum-score skill's reference): actions Pendulum asked for and the rest; requests are Pendulum's.
    interventions: { asked: asked.length, unprompted: unprompted.length, requests: requests.map(({ at, kind }) => ({ at, kind })), firstUnprompted: unprompted[0] ?? null },
    blocked: blocked ? { at: blocked.at, reason: blocked.reason } : null,
    unseen,
    question: question ? { ...question, answered: actions.some((a) => a.kind === "ready_for_review" || (a.where.startsWith("PR") && ms(a.at) >= ms(question.at))) } : null,
  };
  walkAway.blocks = blockStops(collected, since, { bots });
  walkAway.bucket = walkAwayBucket({ value: walkAway.value, blocks: walkAway.blocks, question, actions: split, stall, unseen });
  walkAway.reason = walkAway.value
    ? `merged with no human action after the label${ownerNote}`
    : !merged
      ? `not merged (${exit}${blocked?.reason ? `: ${blocked.reason}` : ""})`
      : blocked
        ? `Blocked at ${blocked.at}${blocked.reason ? `: ${blocked.reason}` : ""}`
        : actions.length
          ? `${question ? "Question answered; " : ""}first human action: ${actions[0].kind} on ${actions[0].where} by ${actions[0].by} at ${actions[0].at}${stall ? `; ${stallReason}` : ""}`
          : `${stallReason}; no human action`;
  // Walk-away counting only what Pendulum asked for: a merge with no Blocked and no human action answering a request.
  // Unprompted actions (an owner's note, scope added after the label) are left out of this one, never out of `value`.
  walkAway.askedOnly = {
    value: Boolean(merged) && !blocked && asked.length === 0 && !stall,
    reason: !merged
      ? walkAway.reason
      : blocked
        ? walkAway.reason
        : stall && !asked.length
          ? `${stallReason}${unprompted.length ? `; ${unprompted.length} unprompted human action(s), none asked for` : ""}`
          : asked.length
          ? `first asked-for action: ${asked[0].kind} on ${asked[0].where} by ${asked[0].by} at ${asked[0].at}, answering a ${asked[0].asked}`
          : unprompted.length
            ? `merged; ${unprompted.length} unprompted human action(s), none asked for`
            : `merged with no human action after the label${ownerNote}`,
  };

  // Every stage on every route, once: the usage artifacts (GitHub Actions, the cloud sandbox) and the spend lines in
  // Pendulum's own progress comments (local mode uploads no artifact), a line a record names left out (withLines). Beside
  // artifacts every stage's line counts, one with no spend line as a run of unknown cost (an artifact that expired).
  const artifacts = collected.usage || [];
  const stages = withLines(artifacts, spendRecords(collected, { app, all: artifacts.length > 0 }));
  if (!stages.length) missing.push("usage artifact");
  // The decision calls made outside any stage, on every route: in no stage's record or spend line, so never matched to a
  // stage's by withLines, and added once beside them.
  const usage = [...stages, ...decisionRecords(collected, { app })];
  const cost = costOf(usage, prices, { harness: collected.harness ?? null });
  // The harness for the streak: the usage's, else Pendulum's own progress comments; two harnesses on one Objective, none.
  const ran = objectiveHarness(collected, { app });

  const runner = runnerMinutes(collected);
  const phases = phaseMinutes(collected.issueComments, issue.number);
  const setup = setupSeconds(collected, issue.number);
  phases.setupSeconds = setup.maxSeconds;
  phases.setupRuns = setup.runs;
  phases.setupBasis = setup.basis;
  const dispatch = dispatchLatency(collected, issue.number, { app });
  if (collected.jobs === null || collected.jobs === undefined) missing.push("job log");
  const wall = merged ? minutes(since, merged.merged_at) : null;

  let operator;
  if (typeof given === "number" && Number.isFinite(given)) operator = { minutes: given, basis: "--minutes (stopwatch)" };
  else if (walkAway.value) operator = { minutes: 0, basis: ownerStep ? "clean merge; the owner step's minutes are apart (ownerStep)" : "clean merge" };
  else if (merged && !blocked && !actions.length) operator = { minutes: 0, basis: "no human action (stalled)" };
  else operator = { minutes: "unknown", basis: actions.some((a) => a.kind === "workflow hand-over") ? "a workflow hand-over is a person's step: give --minutes <issue>=<n> from a stopwatch" : "give --minutes <issue>=<n> from a stopwatch" };

  const candidateSha = merged?.merge_commit_sha ?? merged?.head?.sha ?? open?.head?.sha ?? pulls[0]?.head?.sha ?? null;
  const quality = {
    status: "pending",
    basis: baseline ? "judge: run bench/judge.mjs on the pair below" : "no baseline given: owner's read of the merged diff, or give --baseline <ref>",
    candidate: candidateSha ? { ref: candidateSha, pr: (merged ?? open ?? pulls[0])?.number ?? null, branch: BRANCH(issue.number) } : null,
    baseline: baseline ? { ref: baseline } : null,
    escapes: p1Escapes(collected, merged),
    read: opts.read ?? "unread",
  };
  // The judge compares the candidate with a rival solution's tree (--baseline); the auto-grader needs the
  // pre-change base, which is the PR's own base commit, so the two never share one ref.
  const preChangeBase = (merged ?? open ?? pulls[0])?.base?.sha ?? null;
  if (candidateSha && (baseline || preChangeBase))
    quality.judge = {
      objective: `objectives/${issue.number}.md`,
      ...(baseline ? { command: `node bench/judge.mjs --repo <clone of ${collected.repository}> --a ${candidateSha} --b ${baseline} --objective objectives/${issue.number}.md --judge "<judge command>"` } : {}),
      ...(preChangeBase ? { gradeAuto: `node bench/grade-auto.mjs --repo <clone of ${collected.repository}> --commit ${candidateSha} --base ${preChangeBase} --objective objectives/${issue.number}.md ${(checks.length ? checks : ["<validation command>"]).map((c) => `--check ${JSON.stringify(c)}`).join(" ")} --out grades/${issue.number}.json` } : {}),
    };

  return {
    version: ROW_VERSION,
    repository: collected.repository,
    issue: issue.number,
    title: issue.title ?? null,
    harness: ran.mixed ? null : cost.harness ?? ran.harness,
    harnessMixed: ran.mixed,
    model: cost.model,
    models: objectiveModels(usage, cost),
    // The accounts from both: a stage run locally (`pendulum review`) on an Objective whose work ran on Actions is only in
    // its progress line.
    accounts: objectiveAccounts([...usage, ...spendRecords(collected, { app, all: true })]),
    // Per account: the usage given (a local stage's own result.json names its account) and every local stage's progress
    // line, dollars or none, but a line whose stage a given record names (its `progressRun`) counts once, as the record.
    accountUse: accountUse(withLines(artifacts, spendRecords(collected, { app, all: true }))),
    exit,
    parked,
    pr: (merged ?? open ?? pulls[0])?.number ?? null,
    mergedAt: merged?.merged_at ?? null,
    mergedBy: merged?.merged_by?.login ?? null,
    closedAt: issue.closed_at ?? null,
    walkAway,
    quality,
    operator,
    ownerStep,
    cost,
    phases,
    dispatch,
    activity: cost.activity,
    rebases: rebasesOf(collected, { app }),
    runnerMinutes: runner.minutes,
    runnerBasis: runner.basis,
    wallMinutes: wall,
    wallBasis: merged ? `${sinceBasis} to merged` : "not merged",
    waitingMinutes: waiting.minutes,
    waitingBasis: waiting.basis,
    workingMinutes: wall === null || waiting.minutes === null ? null : Math.max(0, Math.round((wall - waiting.minutes) * 10) / 10),
    decisions: decisionsOf(actions),
    skills: opts.skills ?? null,
    missing,
    scoredAt: opts.now ?? new Date().toISOString(),
  };
}

const fmtUsd = (n) => (n === null || n === undefined ? "unknown" : `$${n.toFixed(2)}`);
const fmtUsd4 = (n) => (n === null || n === undefined ? "unknown" : `$${n.toFixed(4)}`);
/** Token split in thousands: uncached input, cache reads, cache writes, output; the cost's shape at a glance. */
const fmtTokens = (t) => {
  const k = (n) => `${Math.round((n ?? 0) / 1000)}k`;
  const uncached = Math.max(0, (t.input ?? 0) - (t.cached ?? 0) - (t.written ?? 0));
  return `${k(uncached)} in / ${k(t.cached)} cached / ${k(t.written)} written / ${k(t.output)} out`;
};
const fmtMin = (n) => (n === null || n === undefined ? "unknown" : typeof n === "number" ? `${n}` : String(n));
/** One table cell: no pipe, no line break (a Blocked reason may carry either). */
const cell = (s) => String(s ?? "").replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

/**
 * The Rebases cell: the send-backs, and the rebase stages' known dollars when any recorded them ("3, $4.10"), with
 * their runs of unknown cost ("3, $4.10 plus 1 run of unknown cost"); "?" for an old row.
 */
export const rebaseCell = (r) => (!r ? "?" : `${r.sentBack}${r.stages ? `, ${spendText({ usd: r.usd, unknown: r.unknown ?? 0, byBilling: r.byBilling })}` : ""}`);

/** The Markdown table: one row per Objective, oldest issue first. */
/** An External row's stops, by cause: "Blocked: max-usd, provider-quota". */
export const externalWhy = (r) => `Blocked: ${[...new Set((r.walkAway.blocks || []).map((b) => b.cause))].join(", ")}`;

export function markdownTable(rows) {
  const head = ["Issue", "Exit", "Walk-away", "Walk-away (asked only)", "Asked / unprompted", "Quality", "Operator min", "Owner step min", "Cost", "Unit", "Basis", "Runner min", "Wall min (filed→merged)", "Dispatch s (max)", "Slot wait s", "Setup s (max)", "Model min", "CI wait min", "Review beside CI min", "Turns", "Runs", "Sessions", "Rebases", "Harness"];
  const lines = [`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`];
  for (const r of [...rows].sort((a, b) => a.issue - b.issue)) {
    const walk = r.walkAway.value ? (r.ownerStep ? "yes, owner step: workflow hand-over" : "yes") : r.walkAway.bucket === "external" ? `external: ${externalWhy(r)}` : `no: ${r.walkAway.reason}`;
    const q = r.quality.read && r.quality.read !== "unread" ? `read: ${r.quality.read}` : r.quality.status === "pending" ? (r.quality.baseline ? "pending (judge)" : "pending") : r.quality.status;
    // The known dollars, and the runs of unknown cost beside them: never a figure for what was not reported.
    // How the dollars are billed (plugin usage.mjs BILLING): billed per use bare, any other kind said, each part of a mix.
    const known = r.cost.usd === null && r.cost.usdUnknown ? spendText({ usd: null, unknown: r.cost.usdUnknown }) : `${fmtUsd(r.cost.usd)}${r.cost.usd === null ? "" : billingText(r.cost.usd, r.cost.usdByBilling)}${unknownText(r.cost.usdUnknown)}`;
    const model = r.cost.usd !== null && r.cost.tokens.input !== null ? `${known} (${fmtTokens(r.cost.tokens)})` : known;
    // The spend through a relayed gateway key (#97) is in the dollars: named beside them.
    const keyNote = r.cost.workerKeyUsd > 0 ? ` incl. ${fmtUsd(r.cost.workerKeyUsd)} worker key` : "";
    // A sandbox's vendor cost beside the model's, and the total: dollars per merged Objective counts both.
    const cost = r.cost.vendorUsd === null || r.cost.vendorUsd === undefined ? `${model}${keyNote}` : `${model}${keyNote} + ${fmtUsd4(r.cost.vendorUsd)} sandbox${unknownText(r.cost.vendor?.usdUnknown)} = ${fmtUsd(r.cost.totalUsd)}${unknownText(r.cost.totalUnknown)}`;
    const askedOnly = r.walkAway.askedOnly ? (r.walkAway.askedOnly.value ? "yes" : `no: ${r.walkAway.askedOnly.reason}`) : "?";
    const split = r.walkAway.interventions ? `${r.walkAway.interventions.asked} / ${r.walkAway.interventions.unprompted}` : "?";
    const cells = [`#${r.issue}`, r.parked ? `${r.exit} (parked)` : r.exit, walk, askedOnly, split, q, fmtMin(r.operator.minutes), ownerCell(r), cost, r.cost.unit ?? "?", r.cost.basis ?? "", fmtMin(r.runnerMinutes), fmtMin(r.wallMinutes), fmtMin(r.dispatch?.maxSeconds), fmtMin(r.dispatch?.slotWaitSeconds), fmtMin(r.phases?.setupSeconds), fmtMin(r.phases?.modelMinutes), fmtMin(r.phases?.ciWaitMinutes), fmtMin(r.phases?.overlapMinutes), fmtMin(r.activity?.turns), `${r.activity?.workRuns ?? 0}+${r.activity?.reviewRuns ?? 0}`, fmtMin(r.activity?.sessions), rebaseCell(r.rebases), harnessCell(r)];
    lines.push(`| ${cells.map(cell).join(" | ")} |`);
  }
  const notes = [];
  for (const r of rows) if (r.cost.note) notes.push(`- #${r.issue}: ${cell(r.cost.note)}`);
  for (const r of rows) if (r.cost.vendor) notes.push(`- #${r.issue}: sandbox ${cell(r.cost.vendor.basis)}`);
  for (const r of rows) {
    const c = r.cost.cache;
    if (!c?.afterWait?.length) continue;
    const k = (n) => (n === null || n === undefined ? "?" : `${Math.round(n / 1000)}k`);
    const each = c.afterWait.map((w) => `${w.label} after ${w.waitMin ?? "?"} min: ${w.first ? `${k(w.first.written)} written of ${k(w.first.input)} (per ${w.first.unit})` : "no per-request split"}`);
    notes.push(`- #${r.issue}: prompt cache (TTL ${c.ttl}), first request after each CI wait: ${cell(each.join("; "))}`);
  }
  for (const r of rows) if (r.missing.length) notes.push(`- #${r.issue}: missing ${r.missing.join(", ")}`);
  return `${lines.join("\n")}\n\n${summaryLine(rows)}${notes.length ? `\n\n${notes.join("\n")}` : ""}\n`;
}

/** The owner step's cell: none, or its minutes and kind, and whether a person has applied it yet. */
export const ownerCell = (r) => (r.ownerStep ? `${fmtMin(r.ownerStep.minutes)} (workflow hand-over${r.ownerStep.applied ? "" : ", not applied yet"})` : "none");

/** The summary under the table: walk-away both ways, the interventions split and the owner steps, over every row. */
export function summaryLine(rows) {
  const n = rows.length;
  const merged = rows.filter((r) => r.exit === "merged").length;
  const strict = rows.filter((r) => r.walkAway.value).length;
  const askedOnly = rows.filter((r) => r.walkAway.askedOnly?.value).length;
  const stalled = rows.filter((r) => r.walkAway.stall);
  const sum = (k) => rows.reduce((s, r) => s + (r.walkAway.interventions?.[k] ?? 0), 0);
  const stalls = stalled.length ? ` Stalled: ${stalled.map((r) => `#${r.issue} ${r.walkAway.stall.minutes} min`).join(", ")} idle after Pendulum's last action (threshold ${stalled[0].walkAway.stall.thresholdMinutes} min).` : "";
  // A workflow hand-over, by the rule each row was scored by: an owner step apart, or input (HANDOVER_SCORING).
  const owners = rows.filter((r) => r.ownerStep);
  const inputs = rows.filter((r) => !r.ownerStep && (r.walkAway.interventions?.requests || []).some((q) => q.kind === "workflow hand-over"));
  const handovers = `${owners.length ? ` Owner steps (a workflow hand-over, scored as normal work, its minutes apart): ${owners.map((r) => `#${r.issue} ${ownerCell(r)}`).join(", ")}.` : ""}${inputs.length ? ` Workflow hand-overs scored as input: ${inputs.map((r) => `#${r.issue}`).join(", ")}.` : ""}`;
  return `Walk-away: ${strict} of ${n} Objective(s) (${merged} merged) with no human input; ${askedOnly} of ${n} counting only input Pendulum asked for. Interventions: ${sum("asked")} asked for (Question, Blocked notice, review request), ${sum("unprompted")} unprompted.${stalls}${handovers}`;
}
