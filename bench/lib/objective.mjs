// One Objective's row: the four job-one numbers from what GitHub says about
// the issue, the PR(s) on factory/<issue> and the usage artifact (PLAN.md,
// "Job one and how 0.6 is measured"). Pure: takes the collected facts
// (lib/collect.mjs online, a fixture offline) and returns the row.
//
//   walkAway   binary. The clock starts at the first `factory:objective`
//              label. Any human push, comment, review, edit, draft toggle or
//              merge on the branch or the issue after it breaks it; a Blocked
//              card (the factory:blocked label or the blocked marker comment)
//              is a miss. A Question answered by a human is a miss too.
//   quality    the judge's, not this file's: `pending` with the pair inputs
//              when a baseline is given, else `pending` with what is known.
//   operator   minutes from --minutes; 0 on a clean merge; `unknown` else.
//   cost       lib/cost.mjs, with unit and basis per harness.
//   wall       filed (label) to merged; runner minutes from the job log.
import { phaseMinutes } from "./phases.mjs";
import { costOf } from "./cost.mjs";

export const ROW_VERSION = 1;
const BRANCH = (issue) => `factory/${issue}`;
export const RUNNING_LABEL = "factory:running";
export const OBJECTIVE_LABEL = "factory:objective";
const BLOCKED_LABEL = "factory:blocked";
const QUESTION_LABEL = "factory:question";

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
 * The first `labeled factory:objective` event (the clock), or null. With
 * `clockAfter`, the first such event at or after that date: an issue that an
 * earlier Factory already ran under the same label starts its 0.6 clock there.
 */
export function labelTime(issue, timeline, label = OBJECTIVE_LABEL, clockAfter = null) {
  const floor = clockAfter ? ms(clockAfter) : Number.NEGATIVE_INFINITY;
  // The clock is the Objective's first label at or after the floor, or the first time Factory
  // picked it up (its Running label) if that came first: an issue labelled before the floor and
  // re-labelled later as a recovery must not have its recovery mistaken for its start.
  const events = (timeline || [])
    .filter((e) => e.event === "labeled" && (e.label?.name === label || e.label?.name === RUNNING_LABEL) && ms(e.created_at) >= floor)
    .sort((a, b) => ms(a.created_at) - ms(b.created_at));
  return events[0]?.created_at ?? null;
}

/**
 * Minutes of the wall clock spent waiting rather than working: from the clock to Factory's first
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

/** The human actions after `since` on the issue and its PRs, oldest first: each {at, where, kind, by, detail}. */
export function humanActions(collected, since, { bots = new Set(), label = OBJECTIVE_LABEL } = {}) {
  const out = [];
  const after = (at) => Number.isFinite(ms(at)) && ms(at) > ms(since);
  const push = (at, where, kind, actor, detail = "") => {
    if (after(at) && isHuman(actor, bots)) out.push({ at, where, kind, by: actor.login ?? actor.name ?? "unknown", detail });
  };
  const issue = `#${collected.issue.number}`;
  for (const e of collected.issueTimeline || []) {
    // Passive events (mentioned, subscribed, cross-referenced from elsewhere) and bookkeeping (issue type,
    // milestone, pin, project card) are not input to the Objective's work.
    if (PASSIVE_EVENTS.has(e.event)) continue;
    if (e.event === "labeled" && e.label?.name === label && e.created_at === since) continue; // the clock itself
    if (e.event === "commented") {
      if (/<!-- factory:/.test(e.body || "")) continue; // Factory's own protocol (plan, progress, hold, blocked markers), whoever posted it
      push(e.created_at, issue, "comment", e.user ?? e.actor, (e.body || "").slice(0, 80));
      continue;
    }
    push(e.created_at, issue, e.event === "labeled" || e.event === "unlabeled" ? `${e.event} ${e.label?.name ?? ""}` : e.event, e.actor);
  }
  for (const c of collected.issueComments || []) if (!/<!-- factory:/.test(c.body || "")) push(c.created_at, issue, "comment", c.user, (c.body || "").slice(0, 80));
  for (const pr of collected.pulls || []) {
    const where = `PR #${pr.number}`;
    const d = collected.pullDetails?.[pr.number] ?? {};
    push(pr.created_at, where, "opened", pr.user);
    if (pr.merged_at) push(pr.merged_at, where, "merged", pr.merged_by);
    for (const c of d.commits || []) push(c.commit?.committer?.date ?? c.commit?.author?.date, where, "push", commitActor(c), (c.sha || "").slice(0, 7));
    for (const e of d.timeline || []) {
      if (["mentioned", "subscribed", "cross-referenced", "connected", "referenced", "commented", "committed", "reviewed", "review_requested"].includes(e.event)) continue;
      push(e.created_at, where, e.event, e.actor);
    }
    for (const c of d.comments || []) push(c.created_at, where, "comment", c.user, (c.body || "").slice(0, 80));
    for (const r of d.reviews || []) push(r.submitted_at, where, `review ${String(r.state || "").toLowerCase()}`, r.user, (r.body || "").slice(0, 80));
    for (const c of d.reviewComments || []) push(c.created_at, where, "review comment", c.user, (c.body || "").slice(0, 80));
  }
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

/** The one-line reason from the worker's Blocked comment (session.mjs applyExit): "Blocked (stage): <reason> — ..." */
function blockedReason(body) {
  const text = String(body || "").replace(/<!--[^>]*-->/g, "").replace(/^\s*@\S+\s*/, "").trim();
  const m = /Blocked \(([^)]*)\):\s*([^\n]*?)(?:\s+—\s+PR #\d+|\s+Fix by pushing|$)/m.exec(text);
  return m ? `${m[2].trim()} (${m[1]})`.slice(0, 200) : text.split("\n")[0].slice(0, 200);
}

/** Whether the Objective reached Blocked after `since`: the label, or the worker's blocked marker comment. */
export function blockedAt(collected, since) {
  const n = collected.issue.number;
  const marker = `<!-- factory:${n}:blocked`;
  const hits = [];
  for (const e of collected.issueTimeline || []) if (e.event === "labeled" && e.label?.name === BLOCKED_LABEL && ms(e.created_at) >= ms(since)) hits.push({ at: e.created_at, reason: null });
  for (const c of collected.issueComments || []) if ((c.body || "").includes(marker) && ms(c.created_at) >= ms(since)) hits.push({ at: c.created_at, reason: blockedReason(c.body) });
  hits.sort((a, b) => ms(a.at) - ms(b.at));
  if (!hits.length) return null;
  return { at: hits[0].at, reason: hits.find((h) => h.reason)?.reason ?? null };
}

/** Whether the worker raised a Question: the label, or QUESTION in a draft PR body or the plan comment. */
export function questionAt(collected, since) {
  const n = collected.issue.number;
  const plan = `<!-- factory:${n}:plan -->`;
  for (const e of collected.issueTimeline || []) if (e.event === "labeled" && e.label?.name === QUESTION_LABEL && ms(e.created_at) >= ms(since)) return { at: e.created_at, source: "label" };
  for (const pr of collected.pulls || []) if (/\bQUESTION\b/.test(pr.body || "")) return { at: pr.created_at, source: `PR #${pr.number} body` };
  for (const c of collected.issueComments || []) if ((c.body || "").includes(plan) && /\bQUESTION\b/.test(c.body || "")) return { at: c.created_at, source: "plan comment" };
  return null;
}

/** The PRs whose head is factory/<issue>, merged first, then newest. */
export function branchPulls(collected) {
  const head = BRANCH(collected.issue.number);
  return (collected.pulls || [])
    .filter((pr) => (pr.head?.ref ?? pr.headRefName) === head)
    .sort((a, b) => (b.merged_at ? 1 : 0) - (a.merged_at ? 1 : 0) || ms(b.created_at) - ms(a.created_at));
}

/** Runner minutes for this issue's jobs, from the job log when collected; null with a reason otherwise. */
export function runnerMinutes(collected) {
  const jobs = collected.jobs || [];
  if (!jobs.length) return { minutes: null, basis: collected.jobs ? "no job for this issue in the factory workflow" : "unknown: no job log collected" };
  let total = 0;
  for (const j of jobs) total += Math.max(0, (ms(j.completed_at) - ms(j.started_at)) / 60_000 || 0);
  return { minutes: Math.round(total * 10) / 10, basis: `${jobs.length} job(s): ${jobs.map((j) => j.name).join(", ")}` };
}

/**
 * The row. `opts`: prices (lib/cost.mjs), minutes (number or undefined),
 * baseline (a ref or sha the judge compares against, or null), bots (a Set
 * of extra machine logins), label (the Objective label).
 */
export function scoreObjective(collected, opts = {}) {
  const { prices, minutes: given, baseline = null, bots = new Set(), label = OBJECTIVE_LABEL, clockAfter = null, checks = [] } = opts;
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
  const actions = humanActions(collected, since, { bots, label });
  const waiting = waitingMinutes(collected.issueTimeline, since, merged?.merged_at ?? null);
  const exit = merged ? "merged" : blocked ? "blocked" : question ? "question" : open ? (open.draft ? "draft" : "in review") : pulls.length ? "closed unmerged" : "no PR";

  const bodyEdit = collected.bodyEdits?.find((e) => ms(e.at) > ms(since) && isHuman(e.by, bots)) ?? null;
  if (bodyEdit) actions.unshift({ at: bodyEdit.at, where: bodyEdit.where, kind: "body edit", by: bodyEdit.by.login, detail: "" });
  if (collected.bodyEdits === null) missing.push("body edits (GraphQL unavailable)"); // undefined: not attempted (a fixture or a snapshot)
  const walkAway = {
    value: Boolean(merged) && !blocked && actions.length === 0,
    since,
    sinceBasis,
    firstHumanAction: actions[0] ?? null,
    humanActions: actions.length,
    blocked: blocked ? { at: blocked.at, reason: blocked.reason } : null,
    question: question ? { ...question, answered: actions.some((a) => a.kind === "ready_for_review" || (a.where.startsWith("PR") && ms(a.at) >= ms(question.at))) } : null,
  };
  walkAway.reason = walkAway.value
    ? "merged with no human action after the label"
    : !merged
      ? `not merged (${exit}${blocked?.reason ? `: ${blocked.reason}` : ""})`
      : blocked
        ? `Blocked at ${blocked.at}${blocked.reason ? `: ${blocked.reason}` : ""}`
        : `${question ? "Question answered; " : ""}first human action: ${actions[0].kind} on ${actions[0].where} by ${actions[0].by} at ${actions[0].at}`;

  const usage = collected.usage || [];
  if (!usage.length) missing.push("usage artifact");
  const cost = costOf(usage, prices, { harness: collected.harness ?? null });

  const runner = runnerMinutes(collected);
  const phases = phaseMinutes(collected.issueComments, issue.number);
  if (collected.jobs === null || collected.jobs === undefined) missing.push("job log");
  const wall = merged ? minutes(since, merged.merged_at) : null;

  let operator;
  if (typeof given === "number" && Number.isFinite(given)) operator = { minutes: given, basis: "--minutes (stopwatch)" };
  else if (walkAway.value) operator = { minutes: 0, basis: "clean merge" };
  else operator = { minutes: "unknown", basis: "give --minutes <issue>=<n> from a stopwatch" };

  const candidateSha = merged?.merge_commit_sha ?? merged?.head?.sha ?? open?.head?.sha ?? pulls[0]?.head?.sha ?? null;
  const quality = {
    status: "pending",
    basis: baseline ? "judge: run bench/judge.mjs on the pair below" : "no baseline given: owner's read of the merged diff, or give --baseline <ref>",
    candidate: candidateSha ? { ref: candidateSha, pr: (merged ?? open ?? pulls[0])?.number ?? null, branch: BRANCH(issue.number) } : null,
    baseline: baseline ? { ref: baseline } : null,
    escapes: [],
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
    harness: cost.harness,
    model: cost.model,
    exit,
    pr: (merged ?? open ?? pulls[0])?.number ?? null,
    mergedAt: merged?.merged_at ?? null,
    mergedBy: merged?.merged_by?.login ?? null,
    walkAway,
    quality,
    operator,
    cost,
    phases,
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

const fmtUsd = (n) => (n === null || n === undefined ? "unmetered" : `$${n.toFixed(2)}`);
/** Token split in thousands: uncached input, cache reads, cache writes, output; the cost's shape at a glance. */
const fmtTokens = (t) => {
  const k = (n) => `${Math.round((n ?? 0) / 1000)}k`;
  const uncached = Math.max(0, (t.input ?? 0) - (t.cached ?? 0) - (t.written ?? 0));
  return `${k(uncached)} in / ${k(t.cached)} cached / ${k(t.written)} written / ${k(t.output)} out`;
};
const fmtMin = (n) => (n === null || n === undefined ? "unknown" : typeof n === "number" ? `${n}` : String(n));
/** One table cell: no pipe, no line break (a Blocked reason may carry either). */
const cell = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

/** The Markdown table: one row per Objective, oldest issue first. */
export function markdownTable(rows) {
  const head = ["Issue", "Exit", "Walk-away", "Quality", "Operator min", "Cost", "Unit", "Basis", "Runner min", "Wall min (filed→merged)", "Setup min", "Model min", "CI wait min", "Harness"];
  const lines = [`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`];
  for (const r of [...rows].sort((a, b) => a.issue - b.issue)) {
    const walk = r.walkAway.value ? "yes" : `no: ${r.walkAway.reason}`;
    const q = r.quality.read && r.quality.read !== "unread" ? `read: ${r.quality.read}` : r.quality.status === "pending" ? (r.quality.baseline ? "pending (judge)" : "pending") : r.quality.status;
    const cost = r.cost.usd !== null && r.cost.tokens.input !== null ? `${fmtUsd(r.cost.usd)} (${fmtTokens(r.cost.tokens)})` : fmtUsd(r.cost.usd);
    const cells = [`#${r.issue}`, r.exit, walk, q, fmtMin(r.operator.minutes), cost, r.cost.unit ?? "?", r.cost.basis ?? "", fmtMin(r.runnerMinutes), fmtMin(r.wallMinutes), fmtMin(r.phases?.setupMinutes), fmtMin(r.phases?.modelMinutes), fmtMin(r.phases?.ciWaitMinutes), `${r.harness ?? "?"}${r.model ? ` ${r.model}` : ""}`];
    lines.push(`| ${cells.map(cell).join(" | ")} |`);
  }
  const notes = [];
  for (const r of rows) if (r.cost.note) notes.push(`- #${r.issue}: ${cell(r.cost.note)}`);
  for (const r of rows) if (r.missing.length) notes.push(`- #${r.issue}: missing ${r.missing.join(", ")}`);
  return `${lines.join("\n")}${notes.length ? `\n\n${notes.join("\n")}` : ""}\n`;
}
