// The finish card (#498): when an Objective merges, one comment on its issue says what happened, how long it took, what
// it cost and what the person did, built only from what GitHub and Pendulum's own records hold. Three parts:
//   finishData      the card's figures from GitHub's answers (pure: the issue's timeline and comments, the merged PRs
//                   with their timelines, reviews and review comments, the gate's check runs, the usage records);
//   renderFinishCard / finishBlock   the card's markdown, and the headline with its badges for the PR body (pure);
//   postFinishCard  the reads and writes, once per Objective (the `finish` marker), from the dispatcher's Done pass.
// A figure Pendulum has no record of is left out or shown as unknown, never estimated (usage.mjs UNKNOWN_WHY).

import { DRAFT_LABEL } from "./stop.mjs";
import { checkRuns, getPr, listComments, listReviewComments, rest, updatePr } from "./github.mjs";
import { STATE_LABELS, bodyFindings, isPlaceholder, isSelf, marker, rebaseCostOf, selfLogin, spendParts, trustedAuthor } from "./logic.mjs";
import { BILLING, unknownRuns } from "./usage.mjs";

const OBJECTIVE = "pendulum:objective";
const RUNNING = "pendulum:running";
const ms = (at) => (at ? Date.parse(at) : NaN);
// The conclusions of a check run that failed (skipped and neutral are neither green nor red).
const RED = new Set(["failure", "timed_out", "cancelled", "action_required", "stale", "startup_failure"]);
const num = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

/** The Pendulum mark the card shows, from the repository's own brand assets. */
export const MARK_URL = "https://raw.githubusercontent.com/clockgrove/pendulum/main/assets/brand/pendulum/web/mark-240.png";

/** The brand colours of the badges and charts. */
export const COLORS = Object.freeze({ amber: "c9822e", brown: "7a4a24", green: "4a7a3a", slate: "2b4a5f", ink: "b06f22" });

/**
 * The Objective's clock, as the scorecard starts it (bench/lib/objective.mjs reads it from here): its first
 * `pendulum:objective` label at or after `clockAfter`, or the first time Pendulum picked it up (its Running label) if
 * that came first, so a recovery's re-applied label is never mistaken for its start. A draft's clock is the last of its
 * label's applications and its draft label's removals before Pendulum first picked it up. Null with neither label event.
 */
export function labelTime(issue, timeline, label = OBJECTIVE, clockAfter = null) {
  const floor = clockAfter ? ms(clockAfter) : Number.NEGATIVE_INFINITY;
  const events = (timeline || []).filter((e) => e.event === "labeled" && (e.label?.name === label || e.label?.name === RUNNING) && ms(e.created_at) >= floor).sort((a, b) => ms(a.created_at) - ms(b.created_at));
  const first = events[0]?.created_at ?? null;
  if (!first || !(timeline || []).some((e) => e.event === "labeled" && e.label?.name === DRAFT_LABEL)) return first;
  const running = events.find((e) => e.label?.name === RUNNING)?.created_at ?? null;
  const starts = (timeline || []).filter((e) => ((e.event === "labeled" && e.label?.name === label) || (e.event === "unlabeled" && e.label?.name === DRAFT_LABEL)) && ms(e.created_at) >= ms(first) && (!running || ms(e.created_at) <= ms(running)));
  return starts.map((e) => e.created_at).sort((a, b) => ms(a) - ms(b)).at(-1) ?? first;
}

/** Whether a closed Objective gets a finish card by its labels: none that ended Blocked or on a Question. */
export const cardable = (labels) => !labels.some((n) => STATE_LABELS[n] === "Blocked" || STATE_LABELS[n] === "Question");

const HARNESS_LINE = /^<!-- pendulum:harness (\{[^\n]*\}) -->$/m;
/** The stage's own model from its progress comment's harness line (logic.mjs harnessMarker), or null. */
function stageModel(body) {
  const m = HARNESS_LINE.exec(body || "");
  if (!m) return null;
  try {
    const v = JSON.parse(m[1]);
    return typeof v?.model === "string" && v.model ? v.model : null;
  } catch {
    return null;
  }
}

/** A record's or spend line's billing (#481's `billing` field: usage.mjs BILLING), or null when it records none. */
const billingOf = (rec) => (BILLING.includes(rec?.billing) ? rec.billing : null);

/**
 * The card's figures, from GitHub's answers (pure). Null when no PR of the Objective merged.
 *  issue        {number}
 *  timeline     the issue's timeline events (its label events)
 *  comments     the issue's comments: the plan, each stage's progress comment (logic.mjs progress marker, its harness and
 *               spend lines), each sandbox stage's vendor comment
 *  pulls        the Objective's merged PRs, oldest first: each {pr (GitHub's full PR), timeline (its issue timeline:
 *               the merge queue's events), reviews, reviewComments}
 *  checks       the check runs on the last PR's gate commit (its merge commit when it went through a merge queue, else
 *               its head)
 *  records      the stages' usage records (session.mjs writeUsage: the Actions artifacts), each naming its progress
 *               comment's key (`progressRun`)
 *  mine         whose comments and reviews are Pendulum's (logic.mjs trustedAuthor)
 */
export function finishData({ repo, issue, timeline = [], comments = [], pulls = [], checks = [], records = [], label = OBJECTIVE, mine = trustedAuthor }) {
  const n = issue.number;
  const merged = pulls.filter((p) => p?.pr?.merged_at).sort((a, b) => ms(a.pr.merged_at) - ms(b.pr.merged_at));
  if (!merged.length) return null;
  const last = merged.at(-1).pr;
  const mergedAt = last.merged_at;
  const started = labelTime(issue, timeline, label) ?? merged[0].pr.created_at;
  const inRun = (at) => ms(at) >= ms(started) && ms(at) <= ms(mergedAt);
  const own = comments.filter((c) => mine(c) && inRun(c.created_at)).sort((a, b) => ms(a.created_at) - ms(b.created_at));

  // Each stage: its progress comment, from its first write (the stage's start) to its last (its exit line).
  const progress = new RegExp(`^<!-- pendulum:${n}:progress:(work|review):([A-Za-z0-9:-]{1,100}) -->`);
  const vendorHead = new RegExp(`^<!-- pendulum:${n}:vendor:((?:work|review):[A-Za-z0-9:-]{1,100}) -->`);
  const byRun = new Map(records.filter((r) => r && typeof r.progressRun === "string").map((r) => [r.progressRun, r]));
  const vendor = new Map();
  for (const c of own) {
    const key = vendorHead.exec(c.body || "")?.[1];
    if (key) vendor.set(key, { at: c.created_at, parts: spendParts(c.body) });
  }
  const stages = [];
  const keys = new Set();
  let works = 0;
  for (const c of own) {
    const m = progress.exec(c.body || "");
    if (!m) continue;
    const [, stage, key] = m;
    keys.add(`${stage}:${key}`);
    // Its dollars: the spend line it carries (local, cloud sandbox), else its usage record; with neither, unknown.
    const line = spendParts(c.body);
    const rec = line ? null : byRun.get(key);
    const usd = line ? (line.modelUsd ?? line.usd) : rec ? num(rec.usd) : null;
    const unknown = line ? (line.usdUnknown ?? 0) : rec ? unknownRuns(rec) : 1;
    const kind = stage === "review" ? "review" : rebaseCostOf(c.body) ? "rebase" : works++ ? "fix" : "build";
    stages.push({ kind, start: c.created_at, end: c.updated_at && ms(c.updated_at) >= ms(c.created_at) ? c.updated_at : c.created_at, model: stageModel(c.body) ?? rec?.model ?? null, usd: unknown && !usd ? null : usd, unknown, billing: billingOf(line ?? rec) });
  }
  // A sandbox stage that left no progress comment has its model dollars on its vendor comment (launch.mjs bookVendor).
  for (const [key, v] of vendor) {
    if (keys.has(key) || !v.parts || v.parts.modelUsd === null) continue;
    stages.push({ kind: key.startsWith("review:") ? "review" : works++ ? "fix" : "build", start: null, end: null, model: null, usd: v.parts.modelUsd, unknown: 0, billing: billingOf(v.parts) });
  }
  const vendors = [...vendor.values()].filter((v) => v.parts);
  const sandbox = vendors.length ? { usd: vendors.reduce((s, v) => s + (v.parts.vendorUsd ?? 0), 0), unknown: vendors.filter((v) => v.parts.vendorUsd === null).length } : null;

  // The merge queue: each entry of a merged PR, from its addition to its removal (a drop) or the merge (the queue
  // records its own removal at the merge's second).
  const queue = [];
  for (const { pr, timeline: t = [] } of merged) {
    const evs = (t || []).filter((e) => (e.event === "added_to_merge_queue" || e.event === "removed_from_merge_queue") && ms(e.created_at) <= ms(pr.merged_at)).sort((a, b) => ms(a.created_at) - ms(b.created_at));
    let open = null;
    for (const e of evs) {
      if (e.event === "added_to_merge_queue") open = e.created_at;
      else if (open && ms(e.created_at) < ms(pr.merged_at)) {
        queue.push({ start: open, end: e.created_at, merged: false });
        open = null;
      }
    }
    if (open) queue.push({ start: open, end: pr.merged_at, merged: true });
  }

  // Pendulum's reviews and the findings in them: line comments that open a thread (not its placeholder) and those set
  // out in a review body (logic.mjs bodyFindings; a cut tail counts what it stands for).
  const reviews = [];
  let findings = 0;
  for (const { reviews: rs = [], reviewComments = [] } of merged) {
    const ours = (rs || []).filter((r) => mine(r) && (r.body || "").includes(marker(n, "review")));
    const ids = new Set(ours.map((r) => r.id));
    for (const r of ours) {
      reviews.push(r.submitted_at);
      findings += bodyFindings(r.body).reduce((s, f) => s + (Number.isInteger(f.cut) ? f.cut : 1), 0);
    }
    findings += (reviewComments || []).filter((c) => ids.has(c.pull_request_review_id) && !c.in_reply_to_id && !isPlaceholder(c.body)).length;
  }

  // The checks that gated the merge: those that completed by the merge, from the latest attempt of each.
  const gate = (checks || []).filter((c) => c.status === "completed" && ms(c.completed_at) <= ms(mergedAt));
  const sum = (k) => merged.reduce((s, p) => s + (Number.isInteger(p.pr[k]) ? p.pr[k] : 0), 0);
  return {
    repo,
    issue: n,
    prs: merged.map((p) => ({ number: p.pr.number, url: p.pr.html_url ?? `https://github.com/${repo}/pull/${p.pr.number}`, opened: p.pr.created_at, merged: p.pr.merged_at })),
    started,
    merged: mergedAt,
    planned: own.some((c) => (c.body || "").startsWith(marker(n, "plan"))),
    commits: sum("commits"),
    additions: sum("additions"),
    deletions: sum("deletions"),
    files: sum("changed_files"),
    checks: gate.some((c) => c.conclusion === "success") ? { passed: gate.filter((c) => c.conclusion === "success").length, failed: gate.filter((c) => RED.has(c.conclusion)).length } : null,
    reviews: reviews.length ? { count: reviews.length, findings, last: reviews.sort((a, b) => ms(a) - ms(b)).at(-1) } : null,
    stages,
    queue,
    sandbox,
  };
}

// ------------------------------------------------------------------ words

const pad = (v) => String(v).padStart(2, "0");
/** A duration as the card's prose and table say it: "59 s", "3 min 55 s", "2 h 5 min", "1 d 3 h". */
export function durationText(d) {
  const s = Math.max(0, Math.round(d / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ""}`;
  if (s < 86400) return `${Math.floor(s / 3600)} h${Math.floor((s % 3600) / 60) ? ` ${Math.floor((s % 3600) / 60)} min` : ""}`;
  return `${Math.floor(s / 86400)} d${Math.floor((s % 86400) / 3600) ? ` ${Math.floor((s % 86400) / 3600)} h` : ""}`;
}
/** The same, short, for a badge: "59s", "3m 55s", "2h 05m", "1d 3h". */
const durationShort = (d) => {
  const s = Math.max(0, Math.round(d / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${pad(s % 60)}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${pad(Math.floor((s % 3600) / 60))}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
};
const dollars = (usd) => `$${usd >= 0.01 || usd === 0 ? usd.toFixed(2) : usd.toFixed(4)}`;
/** Known dollars and runs of unknown cost as a figure: "$0.52", "unknown", "$0.52 + unknown". */
export const costText = (usd, unknown) => (unknown > 0 ? (usd > 0 ? `${dollars(usd)} + unknown` : "unknown") : dollars(usd ?? 0));

/** A model id as people say it: claude-opus-5-5 is Opus 5.5; any other id as it is. */
export function modelName(id) {
  const m = /^claude-([a-z]+)-(\d+)-(\d+)(?:-\d{8})?$/.exec(String(id || ""));
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}` : id ? String(id) : null;
}

const STAGE_NAMES = { build: "Plan + build", fix: "Fix", rebase: "Rebase", review: "Review" };
const stageName = (s, planned) => (s.kind === "build" && !planned ? "Build" : STAGE_NAMES[s.kind]);

/**
 * How the card's dollars are billed, from the stages' records (#481's `billing`): one of BILLING when every stage
 * records the same, "mixed" when they record different ones, null when any records none.
 */
function billingAll(stages) {
  const all = stages.map((s) => s.billing);
  if (!all.length || all.some((b) => b === null)) return null;
  return new Set(all).size === 1 ? all[0] : "mixed";
}

/** The totals the card shows: the wall clock (ms), the known dollars, the runs of unknown cost and the billing. */
export function finishTotals(d) {
  const usd = d.stages.reduce((s, x) => s + (x.usd ?? 0), 0) + (d.sandbox?.usd ?? 0);
  const unknown = d.stages.reduce((s, x) => s + (x.unknown || 0), 0) + (d.sandbox?.unknown ?? 0);
  return { wall: ms(d.merged) - ms(d.started), usd: Math.round(usd * 1e6) / 1e6, unknown, billing: billingAll(d.stages) };
}

/** The cost as the headline says it, by billing: "for $0.52", "for $0.52 API-equivalent", "; its cost is unknown". */
function headlineCost({ usd, unknown, billing }) {
  if (unknown > 0 && !(usd > 0)) return "; its cost is unknown";
  const suffix = billing === "subscription" ? " API-equivalent" : billing === "credits" ? " in included credits" : "";
  return ` for ${dollars(usd)}${suffix}${unknown > 0 ? " plus spend that was not reported" : ""}`;
}

/** The headline: time to merge and the cost. */
export function headline(d) {
  const t = finishTotals(d);
  return `Merged in ${durationText(t.wall)}${headlineCost(t)}.`;
}

/** A shields.io static badge, for-the-badge style: its label and message escaped as shields.io reads them. */
export function badge(label, message, color) {
  const part = (s) => encodeURIComponent(String(s).replace(/-/g, "--").replace(/_/g, "__").replace(/ /g, "_"));
  return `<img alt="${label}: ${message}" src="https://img.shields.io/badge/${part(label)}-${part(message)}-${color}?style=for-the-badge">`;
}

/** The badges: status, wall clock and cost (labelled by billing). */
export function badges(d) {
  const t = finishTotals(d);
  const label = t.billing === "subscription" ? "API-equivalent" : t.billing === "credits" ? "included credits" : "cost";
  return [badge("status", "merged", COLORS.green), badge("wall clock", durationShort(t.wall), COLORS.brown), badge(label, costText(t.usd, t.unknown), COLORS.amber)];
}

const many = (n, one, more = `${one}s`) => `${n} ${n === 1 ? one : more}`;
const utc = (at) => new Date(ms(at)).toISOString().slice(11, 16);

/** What the person did and what Pendulum did, in one plain sentence. */
export function summary(d) {
  const did = [];
  if (d.planned) did.push("planned the work");
  const diff = `(+${d.additions} −${d.deletions} across ${many(d.files, "file")})`;
  did.push(`made **${many(d.commits, "commit")}** ${diff}`);
  if (d.checks) did.push(`got ${d.checks.passed > 1 && !d.checks.failed ? "all " : ""}**${many(d.checks.passed, "check")}** green${d.checks.failed ? ` (${d.checks.failed} red)` : ""}`);
  if (d.reviews) did.push(`had the change reviewed (${d.reviews.findings ? many(d.reviews.findings, "finding") : "no findings"})`);
  const how = d.queue.some((q) => q.merged) ? "it merged through your merge queue" : "it merged";
  return `You wrote the issue and added the label. Pendulum took it from there: it ${did.join(", ")}, and ${how}.`;
}

/** The source line: where the times and dollars come from, and what the dollars are by billing. */
function sources(d, t) {
  const unknownLine = t.unknown ? ` ${t.unknown === 1 ? "One run has" : `${t.unknown} runs have`} no reported cost, so ${t.unknown === 1 ? "it shows" : "they show"} as unknown, not as a number.` : "";
  const billed = {
    api: "billed to your API key",
    subscription: "API-equivalent: what the usage would cost at API prices, covered by your subscription and not billed",
    credits: "your plan's included credits, at their list price",
    mixed: "from stages on different billing: a subscription's figures are API-equivalent, not billed spend",
  }[t.billing];
  const what = billed ? `These are the costs Pendulum recorded for this run, ${billed}.` : "These are the costs Pendulum recorded for this run; Pendulum did not record whether they were billed to an API key or are a subscription's API-equivalent figures.";
  return `${what}${unknownLine} Your CI minutes are not included. Times come from the issue, the PR and the run records.`;
}

// ------------------------------------------------------------------ charts

/**
 * The charts' colours. GitHub's web view applies a diagram's `init` in both colour modes; a viewer that ignores it (the
 * GitHub Mobile app in dark mode) draws with its own light or dark theme instead. So:
 * - every bar is an `active` task: the stock light and dark themes paint those blue with dark text, where a plain task is
 *   grey in the dark theme and a `done` one grey in both;
 * - with `init` applied, the bars are amber with dark text in them, and every text outside a bar (a label too long for
 *   its bar, the section names, the time axis) is a mid-tone ink, #b06f22, which reads at about 4:1 or better on white
 *   and on GitHub's dark background alike (`themeCSS` sets it on an active task's outside label, which the theme
 *   otherwise draws in the bar's dark text colour);
 * - the stage names are the section names, drawn in the theme's own title colour, so under a stock theme they read too;
 *   a bar's own label is only its duration, also in the table;
 * - the section bands are a faint amber wash, and the grid lines a mid grey (`themeCSS`: the axis draws them in its
 *   text colour otherwise), on either page.
 * `gantt.useWidth` draws the timeline at a phone-friendly width, so GitHub's scaling to the comment's width keeps its
 * text legible on a phone.
 */
const INK = `#${COLORS.ink}`;
const GANTT_THEME = {
  theme: "base",
  themeVariables: { fontSize: "16px", taskBkgColor: `#${COLORS.amber}`, taskBorderColor: `#${COLORS.brown}`, activeTaskBkgColor: `#${COLORS.amber}`, activeTaskBorderColor: `#${COLORS.brown}`, taskTextColor: "#1f1206", taskTextDarkColor: "#1f1206", taskTextLightColor: "#1f1206", taskTextOutsideColor: INK, taskTextClickableColor: INK, sectionBkgColor: "rgba(201,130,46,0.12)", altSectionBkgColor: "rgba(201,130,46,0.04)", sectionBkgColor2: "rgba(201,130,46,0.12)", titleColor: INK, textColor: INK, gridColor: "#8b949e", excludeBkgColor: "transparent" },
  themeCSS: `text.taskTextOutsideRight, text.taskTextOutsideLeft { fill: ${INK} !important; } .grid .tick line { stroke: #8b949e; }`,
  gantt: { useWidth: 440, barHeight: 24, barGap: 6, fontSize: 15, sectionFontSize: 15, leftPadding: 80 },
};
const PIE_THEME = { theme: "base", themeVariables: { pie1: `#${COLORS.amber}`, pie2: `#${COLORS.green}`, pie3: `#${COLORS.slate}`, pie4: `#${COLORS.brown}`, pie5: "#8b949e", pieStrokeColor: `#${COLORS.brown}`, pieOuterStrokeColor: `#${COLORS.brown}`, pieTitleTextColor: INK, pieSectionTextColor: "#ffffff", pieLegendTextColor: INK, pieSectionTextSize: "16px", pieOpacity: "1" } };
const init = (theme) => `%%{init: ${JSON.stringify(theme)}}%%`;

/** A tick interval that keeps the time axis to about five labels, so they never collide on a phone. */
function tickFor(span) {
  const steps = [["1minute", 6e4], ["2minute", 12e4], ["5minute", 3e5], ["10minute", 6e5], ["15minute", 9e5], ["30minute", 18e5], ["1hour", 36e5], ["2hour", 72e5], ["6hour", 216e5], ["12hour", 432e5], ["1day", 864e5], ["1week", 6048e5]];
  return (steps.find(([, step]) => span / step <= 5) ?? steps.at(-1))[0];
}

const at0 = (t) => (typeof t === "number" ? t : ms(t));
const isoSecond = (t) => new Date(at0(t)).toISOString().slice(0, 19);
/** Whether the Objective's clock and its merge fall on different UTC days (the times then carry their dates). */
const spansDays = (d) => new Date(ms(d.started)).toISOString().slice(0, 10) !== new Date(ms(d.merged)).toISOString().slice(0, 10);

/** The short names the timeline gives its rows (Mermaid section names: short, so the stock themes' margin fits them). */
const ROW_NAMES = { build: "Build", fix: "Fix", rebase: "Rebase", review: "Review" };

/** The timeline: one row per stage and per merge queue entry, in time order, in UTC. Stages with no recorded time are left out. */
function gantt(d) {
  const span = ms(d.merged) - ms(d.started);
  const rows = [...d.stages.filter((s) => s.start).map((s) => [ROW_NAMES[s.kind], s.start, s.end]), ...d.queue.map((q) => [q.merged ? "Queue" : "Dropped", q.start, q.end])].sort((a, b) => ms(a[1]) - ms(b[1]));
  if (!rows.length) return null;
  const lines = ["gantt", "    dateFormat YYYY-MM-DDTHH:mm:ss", `    axisFormat ${spansDays(d) ? "%b %d %H:%M" : "%H:%M"}`, `    tickInterval ${tickFor(span)}`, "    todayMarker off"];
  for (const [name, s, e] of rows) {
    const end = Math.max(ms(e), ms(s) + 1000);
    lines.push(`    section ${name}`, `    ${durationShort(end - ms(s))} :active, ${isoSecond(s)}, ${isoSecond(end)}`);
  }
  return ["```mermaid", init(GANTT_THEME), ...lines, "```"].join("\n");
}

/** The cost chart: each stage's known dollars, only when every figure is known and there are two or more to compare. */
function pie(d, t) {
  if (t.unknown > 0 || !(t.usd > 0)) return null;
  const slices = new Map();
  for (const s of d.stages) if (s.usd > 0) slices.set(stageName(s, d.planned), (slices.get(stageName(s, d.planned)) ?? 0) + s.usd);
  if (d.sandbox?.usd > 0) slices.set("Cloud sandbox", d.sandbox.usd);
  if (slices.size < 2) return null;
  return ["```mermaid", init(PIE_THEME), "pie showData", ...[...slices].map(([name, usd]) => `    "${name}" : ${Math.round(usd * 100) / 100}`), "```"].join("\n");
}

// ------------------------------------------------------------------ card

/** The cost table by stage and model, with the merge queue's time and the total. */
function costTable(d, t) {
  const cell = (usd, unknown, billing) => `${costText(usd ?? 0, usd === null ? Math.max(1, unknown) : unknown)}${t.billing === "mixed" && billing === "subscription" ? " API-equivalent" : ""}`;
  const rows = d.stages.map((s) => `| ${stageName(s, d.planned)}${s.model ? ` · ${modelName(s.model)}` : ""} | ${s.start ? durationText(ms(s.end) - ms(s.start)) : "—"} | ${cell(s.usd, s.unknown, s.billing)} |`);
  if (d.sandbox) rows.push(`| Cloud sandbox | — | ${cell(d.sandbox.usd, d.sandbox.unknown)} |`);
  const queued = d.queue.reduce((s, q) => s + (ms(q.end) - ms(q.start)), 0);
  if (d.queue.length) rows.push(`| Merge queue · your CI | ${durationText(queued)} | — |`);
  const head = t.billing === "subscription" ? "API-equivalent" : t.billing === "credits" ? "Included credits" : "Cost";
  return [`| Stage | Time | ${head} |`, "| --- | ---: | ---: |", ...rows, `| **Total** | **${durationText(t.wall)}** | **${costText(t.usd, t.unknown)}** |`].join("\n");
}

/** The run log: every recorded event, oldest first. */
function runLog(d) {
  const day = spansDays(d);
  const at = (t) => (day ? new Date(ms(t)).toISOString().slice(0, 19).replace("T", " ") : new Date(ms(t)).toISOString().slice(11, 19));
  const out = [[d.started, "labelled `pendulum:objective`: the clock starts"]];
  for (const s of d.stages) {
    if (!s.start) continue;
    out.push([s.start, `${stageName(s, d.planned).toLowerCase()} stage started${s.model ? ` (${s.model})` : ""}`]);
    out.push([s.end, `${stageName(s, d.planned).toLowerCase()} stage's last line: ${costText(s.usd ?? 0, s.usd === null ? Math.max(1, s.unknown) : s.unknown)}`]);
  }
  for (const p of d.prs) out.push([p.opened, `PR #${p.number} opened`]);
  for (const q of d.queue) {
    out.push([q.start, "added to the merge queue"]);
    if (!q.merged) out.push([q.end, "removed from the merge queue"]);
  }
  if (d.reviews) out.push([d.reviews.last, `last review: ${many(d.reviews.count, "review")} in all, ${d.reviews.findings ? many(d.reviews.findings, "finding") : "no findings"}`]);
  const last = d.prs.at(-1);
  out.push([d.merged, `PR #${last.number} merged${d.checks ? `, ${many(d.checks.passed, "check")} passed` : ""}`]);
  return out
    .map(([t, text], i) => [ms(t), i, `- ${at(t)} ${text}`])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1])
    .map((x) => x[2])
    .join("\n");
}

/** The PR line: the issue, the PRs and when it landed. */
function landedLine(d) {
  const prs = d.prs.map((p) => `<a href="${p.url}">PR #${p.number}</a>`).join(", ");
  const how = d.queue.some((q) => q.merged) ? "landed through your merge queue" : "landed";
  return `<p align="center"><sub><b>Clockgrove Pendulum</b> · issue #${d.issue} → ${prs} · ${how} at ${utc(d.merged)} UTC</sub></p>`;
}

/** The headline and badges, centred: the top of the card and of the merged PR's body. */
export function finishBlock(d) {
  return [`<h3 align="center">${headline(d)}</h3>`, "", `<p align="center">\n${badges(d).join("\n")}\n</p>`].join("\n");
}

/** The finish card's markdown (pure): see the module comment, and USAGE.md "The finish card". */
export function renderFinishCard(d) {
  const t = finishTotals(d);
  const parts = [`<p align="center"><img src="${MARK_URL}" width="96" alt="Pendulum"></p>`, `<h3 align="center">${headline(d)}</h3>`, landedLine(d), `<p align="center">\n${badges(d).join("\n")}\n</p>`, summary(d)];
  const timeline = gantt(d);
  if (timeline) parts.push("**How the time went** (UTC)", timeline);
  parts.push("**What it cost**", costTable(d, t));
  const chart = pie(d, t);
  if (chart) parts.push(chart);
  parts.push(`<sub>${sources(d, t)}</sub>`, `<details><summary>Full run log</summary>\n\n${runLog(d)}\n\n</details>`);
  return parts.join("\n\n");
}

// ------------------------------------------------------------------ PR body

const BLOCK_START = (n) => `<!-- pendulum:${n}:finish-pr -->`;
const BLOCK_END = (n) => `<!-- pendulum:${n}:finish-pr:end -->`;
/** The PR body with the finish block at its top, replacing one already there (so a second write changes nothing). */
export function withFinishBlock(body, d) {
  const n = d.issue;
  const text = String(body ?? "");
  const start = text.indexOf(BLOCK_START(n));
  const end = start >= 0 ? text.indexOf(BLOCK_END(n), start) : -1;
  const others = start >= 0 && end >= 0 ? `${text.slice(0, start)}${text.slice(end + BLOCK_END(n).length)}`.replace(/^\n+/, "") : text;
  return `${BLOCK_START(n)}\n${finishBlock(d)}\n${BLOCK_END(n)}\n\n${others}`;
}

// ------------------------------------------------------------------ post

/**
 * How long after an Objective's close the Done pass keeps its state label while its finish card meets a passing failure
 * (GitHub's 5xx, its rate limit, the network: the next tick tries again). Past it, the tidy goes on without the card: half the Done pass's 48-hour
 * window, so the label never outlives the window that clears it.
 */
export const FINISH_RETRY_MS = 24 * 3600_000;

/** The card's marker: one card per Objective. */
export const finishMarker = (n) => marker(n, "finish");

/**
 * The usage records of an Objective's Actions stages: its `pendulum-usage-<n>` and `pendulum-usage-<n>-review`
 * artifacts (the job token's actions: read; a token that may not read them reads none, and those stages show as
 * unknown). `download(artifact)` reads one's result.json (github.mjs downloadArtifactResult).
 */
export async function objectiveRecords(repo, n, { token, download }) {
  const out = [];
  for (const name of [`pendulum-usage-${n}`, `pendulum-usage-${n}-review`]) {
    // A token that may not read artifacts (403, 404) reads none; any other failure throws, for the next tick to read again.
    const page = await rest(`repos/${repo.full}/actions/artifacts?name=${encodeURIComponent(name)}&per_page=100`, { token }).catch((e) => {
      if (e?.status === 403 || e?.status === 404) return null;
      throw e;
    });
    for (const a of page?.artifacts || []) {
      if (a.expired || !Number.isSafeInteger(a.workflow_run?.id)) continue;
      const rec = await download(a);
      if (rec && typeof rec === "object") out.push(rec);
    }
  }
  return out;
}

/**
 * Post the finish card of closed Objective `issue` ({number, labels}) once: none for one that ended Blocked or on a
 * Question, or whose newest PR on its branch did not merge, or that already has its card (its `finish` marker, Pendulum's own).
 * The merged PR's body gets the headline and badges at its top first, so a card that failed to post is retried next
 * tick with both. Returns "posted", "had" (posted before), or the reason none is due: "not merged", "blocked".
 * `records(n)`: the usage records of its Actions stages (objectiveRecords). A failed read or write throws.
 */
export async function postFinishCard(repo, issue, opts, { records = async () => [], label = OBJECTIVE } = {}) {
  const n = issue.number;
  const names = (issue.labels || []).map((l) => (typeof l === "string" ? l : l.name));
  if (!cardable(names)) return "blocked";
  // Merged when the newest PR on its branch merged (wait.mjs closedAs): a person who closed the issue with a later part's
  // PR still open, or its PR closed unmerged, gets no card.
  const branch = (await rest(`repos/${repo.full}/pulls?state=all&head=${encodeURIComponent(`${repo.owner}:pendulum/${n}`)}&sort=created&direction=desc&per_page=20`, opts)) || [];
  if (!branch[0]?.merged_at) return "not merged";
  const prs = branch.filter((p) => p.merged_at);
  const comments = await listComments(repo, n, opts);
  const ours = (c) => (selfLogin() ? isSelf(c) : trustedAuthor(c)) && (c.body || "").startsWith(finishMarker(n));
  if (comments.some(ours)) return "had";
  const timeline = (await rest(`repos/${repo.full}/issues/${n}/timeline?per_page=100`, { ...opts, paginate: true })) || [];
  const started = labelTime(issue, timeline, label);
  // The Objective's merged PRs since its clock (a split Objective's parts), oldest first, each read whole.
  const mine = prs.filter((p) => !started || Date.parse(p.merged_at) >= Date.parse(started)).sort((a, b) => ms(a.merged_at) - ms(b.merged_at));
  const pulls = [];
  for (const p of mine.length ? mine : prs.slice(0, 1)) {
    const [pr, t, reviews, reviewComments] = await Promise.all([getPr(repo, p.number, opts), rest(`repos/${repo.full}/issues/${p.number}/timeline?per_page=100`, { ...opts, paginate: true }), rest(`repos/${repo.full}/pulls/${p.number}/reviews?per_page=100`, { ...opts, paginate: true }), listReviewComments(repo, p.number, opts)]);
    pulls.push({ pr, timeline: t || [], reviews: reviews || [], reviewComments });
  }
  const last = pulls.at(-1);
  // The checks that gated the merge: the merge queue's, on the merge commit it made; without a queue, the head's.
  const queued = (last.timeline || []).some((e) => e.event === "added_to_merge_queue");
  const gateSha = queued && last.pr.merge_commit_sha ? last.pr.merge_commit_sha : last.pr.head?.sha;
  const checks = gateSha ? await checkRuns(repo, gateSha, opts) : [];
  const d = finishData({ repo: repo.full, issue, timeline, comments, pulls, checks, records: await records(n), label });
  if (!d) return "not merged";
  await updatePr(repo, last.pr.number, { body: withFinishBlock(last.pr.body, d) }, opts);
  await rest(`repos/${repo.full}/issues/${n}/comments`, { ...opts, method: "POST", body: { body: `${finishMarker(n)}\n${renderFinishCard(d)}` } });
  return "posted";
}
