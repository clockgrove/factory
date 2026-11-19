// The finish card (#498, #589): when an Objective's run ends (merged, Blocked, on a Question, closed without merging), one
// comment on its issue says what happened, how long it took, what it cost and who did what, built only from what GitHub
// and Pendulum's own records hold. Text only (no image): a headline block (a third line for a run that waited, #614:
// how long it worked and how long it waited, each wait with its cause), the action lines of a Blocked or
// Question end, the timeline (a Mermaid gantt) with the stage table that holds its figures, where the money went (a
// one-colour bar chart beside its tables), and Run details. Three parts:
//   finishData      the card's figures from GitHub's answers (pure: the issue's timeline and comments, the PRs with their
//                   timelines, reviews and review comments, the gate's check runs, the usage records, an end other than a
//                   merge);
//   renderFinishCard / finishBlock   the card's markdown, and its headline block for the merged PR's body (pure);
//   postFinishCard  the reads and writes: one card per Objective (the `finish` marker), written in place as its run ends
//                   again, from the dispatcher's Done pass and a stage's own Blocked or Question end (endCard).
// A figure Pendulum has no record of is left out or shown as unknown, never estimated (usage.mjs UNKNOWN_WHY). Every
// marker the card reads is trusted only from Pendulum itself (pendulumOwn: its login here, or its App by id). A stage
// comment by someone else who can push counts as a run of unknown cost, never its dollars; anyone else's counts nothing.

import { pendulumBuild } from "./release.mjs";
import { activationEvents, DRAFT_LABEL, latestDraftEvent, RESUME_OBJECTIVE } from "./activation.mjs";
import { DEFAULTS } from "./inputs.mjs";
import { clockText, objectiveZone, timeZone, zoneDay, zoneOffsetMs } from "./clock.mjs";
import { stageHarnessOf } from "./cost-join.mjs";
import { addTokens, isAnswer, isFix, stagePassFigures, zeroTokens } from "./pass-figures.mjs";
import { checkRuns, getPr, listComments, listReviewComments, ownRunArtifact, primeSelf, requiredCheckSpecs, rest, transientError, updatePr } from "./github.mjs";
import { RUNNING_LABEL, STATE_LABELS, blockCauseOf, bodyFindings, decisionSpendEntries, isPlaceholder, isSelf, ledgerOfComment, marker, githubWriter, rebaseCostOf, restartedAt, selfLogin, spendParts } from "./logic.mjs";
import { pendulumNotice } from "./answer-check.mjs";
import { sanitize } from "./handoff.mjs";
import { goNoted } from "./stop.mjs";
import { BASIS, BASIS_NOTE, COLORS, basisText, billingBasis, billingWords, causeSentences, cellCost, centsOf, costChart, costText, durationText, ganttChart, kindsOf, many, modelId, modelName, plainText, tableCell } from "./card-kit.mjs";

// The shared look's helpers this module has always exported (card-kit.mjs holds them now).
export { COLORS, billingBasis, billingWords, centsOf, costText, durationText, modelName };
import { PREVIOUS_NAME } from "./local.mjs";
import { BILLING, BILLING_WORDS, PASS_KEYS, UNKNOWN_WHY, addBilling, billingRead, modelName as reportName, passRead, rerunRead, unknownRuns } from "./usage.mjs";

const OBJECTIVE = DEFAULTS.objective_label;
const ms = (at) => (typeof at === "number" ? at : at ? Date.parse(at) : NaN);
// The conclusions of a check run that failed (skipped and neutral are neither green nor red).
const RED = new Set(["failure", "timed_out", "cancelled", "action_required", "stale", "startup_failure"]);
const num = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
// GitHub stamps its timeline to the second: the merge queue's own removal of the PR it merges can carry the second before.
const SECOND = 1000;


/**
 * The first activation since `clockAfter`, shared with the scorecard. If the matching start did not survive in the
 * timeline, use the first Running label before any later recovery only if this window has no unaccounted-for Draft.
 * Pendulum's own refusal records identify activation events that did not start work.
 */
export function clockStart(timeline = [], label = OBJECTIVE, clockAfter = null, { issue, comments = [], mine = isSelf } = {}) {
  const floor = clockAfter ? ms(clockAfter) : Number.NEGATIVE_INFINITY;
  const history = timeline || [];
  const markers = [...(comments || []), ...history.filter((e) => e.event === "commented")];
  const events = activationEvents(history, label);
  const refused = (e) => !!issue && goNoted(markers, issue, { at: e.created_at, id: e.id }, mine);
  const start = events.find((e) => ms(e.created_at) >= floor && !refused(e));
  const running = history.filter((e) => e.event === "labeled" && e.label?.name === RUNNING_LABEL && ms(e.created_at) >= floor).sort((a, b) => ms(a.created_at) - ms(b.created_at))[0];
  if (!running) return start ?? null;
  const runningAt = ms(running.created_at);
  const runningIndex = history.indexOf(running);
  const byRunning = (e, index) => ms(e.created_at) < runningAt || (ms(e.created_at) === runningAt && index <= runningIndex);
  if (start && byRunning(start, history.indexOf(start))) return start;
  if (events.some((e) => ms(e.created_at) >= floor && byRunning(e, history.indexOf(e)) && refused(e))) return null;
  const draft = latestDraftEvent(history.filter(byRunning));
  if (draft && (ms(draft.created_at) >= floor || !events.includes(draft) || refused(draft))) return null;
  return running;
}

export const labelTime = (issue, timeline, label = OBJECTIVE, clockAfter = null, options) =>
  clockStart(timeline, label, clockAfter, { issue: issue?.number, ...options })?.created_at ?? null;

/**
 * Whether the issue's clock started before the rename to Pendulum (#567): a label event named exactly
 * `<previous name>:objective` or `<previous name>:running` (local.mjs PREVIOUS_NAME), the name GitHub keeps on the events
 * from before a label was renamed. Its wall clock is then not known: labelTime matches only the current names, so it would
 * start at a later label and come out short. Nothing else is read from those events.
 */
export const clockRenamed = (timeline) => (timeline || []).some((e) => (e?.event === "labeled" || e?.event === "unlabeled") && [`${PREVIOUS_NAME}:objective`, `${PREVIOUS_NAME}:running`].includes(e.label?.name));

/** The reasons a finish card summary records for a wall clock it does not know (`clockWhy`, #587). */
export const CLOCK_WHY = Object.freeze(["renamed"]);

/** Why a card's wall clock is not known (clockRenamed), as the card says it. */
export const RENAMED_CLOCK_WHY = "its wall clock is not known: it was labelled before the rename to Pendulum";
const UNRECORDED_ACTIVATION_WHY = "its wall clock is not known because its activation was not recorded";

/**
 * Whether a comment, review or PR is Pendulum's own, whose markers the card trusts: by the login this process writes as
 * (isSelf), or through Pendulum's own App matched by id (`appId`: GitHub's `performed_via_github_app`, its author that
 * App's `<slug>[bot]`; answer-check.mjs pendulumNotice). No other App or bot, `github-actions[bot]` included.
 */
export const pendulumOwn = (appId = null) => (x) => pendulumNotice(x, appId);

/**
 * Whether a comment came through a GitHub App other than GitHub Actions, as that App's `<slug>[bot]`: another route's
 * Pendulum App when this route has no App id to match it by (local mode without PENDULUM_LOCAL_APP_ID). Its stage
 * comment then counts as a run of unknown cost, never its figures, so a route switch adds "+ unknown", never a wrong total.
 */
export const throughApp = (c) => {
  const app = c?.performed_via_github_app;
  return !!app && app.slug !== "github-actions" && typeof app.slug === "string" && c.user?.login === `${app.slug}[bot]`;
};

/**
 * Whether a closed Objective gets a finish card by its labels (#589): every Objective Pendulum ran (a state label still on
 * it at its close) gets one, merged or not, Blocked or on a Question when it closed.
 */
export const cardable = (labels) => labels.some((n) => STATE_LABELS[n] !== undefined);

const HARNESS_LINE = /^<!-- pendulum:harness (\{[^\n]*\}) -->$/m;
/** The stage's own model from its progress comment's harness line (logic.mjs harnessMarker), or null. */
function stageModel(body) {
  const m = HARNESS_LINE.exec(body || "");
  if (!m) return null;
  try {
    return modelId(JSON.parse(m[1])?.model);
  } catch {
    return null;
  }
}
/**
 * The stage's model from the per-pass ledger line beside its spend line (logic.mjs ledgerOfComment: its usage record's
 * model, Copilot's default one included), or null. Read from a comment the caller trusts (pendulumOwn) only.
 */
const ledgerModel = (body) => (spendParts(body) ? modelId(ledgerOfComment(body)?.model) : null);
/** A GitHub login as the card may print it, else null. */
const login = (v) => (typeof v === "string" && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/.test(v) ? v : null);
const HARNESSES = new Set(["claude", "codex", "copilot"]);
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:[-+][A-Za-z0-9.-]{1,40})?$/;
/** A record's tokens as {input, output, cached, written}: each a count or null. */
const tokensOf = (t) => Object.fromEntries(Object.keys(zeroTokens()).map((k) => [k, Number.isSafeInteger(t?.[k]) && t[k] >= 0 ? t[k] : null]));
/** The reason codes (usage.mjs UNKNOWN_WHY) of `runs` runs of unknown cost: those `why` names, else `unreported`; none for no run. */
const whyOf = (runs, why) => {
  if (!(runs > 0)) return [];
  const codes = [...new Set((Array.isArray(why) ? why : []).filter((w) => typeof w === "string" && Object.hasOwn(UNKNOWN_WHY, w)))].sort();
  return codes.length ? codes : ["unreported"];
};

/**
 * The checks that gated a merge at `mergedAt`, from every attempt of every check run on the gate commit (`all`): per app
 * and name, the latest run completed by the merge; with required checks (`required`, github.mjs requiredCheckSpecs: a
 * name and, when set, the app it must come from), those alone. `{passed, failed, required}`, or null with none green.
 */
export function gateChecks(checks, mergedAt, required = []) {
  const latest = new Map();
  for (const c of checks || []) {
    if (c?.status !== "completed" || !(ms(c.completed_at) <= ms(mergedAt))) continue;
    const key = `${c.app?.id ?? ""}\0${c.name}`;
    const had = latest.get(key);
    if (!had || ms(c.completed_at) > ms(had.completed_at) || (ms(c.completed_at) === ms(had.completed_at) && c.id > had.id)) latest.set(key, c);
  }
  let runs = [...latest.values()];
  const req = (required || []).filter((s) => s?.name);
  if (req.length) runs = runs.filter((c) => req.some((s) => s.name === c.name && (s.app === null || s.app === undefined || s.app === c.app?.id)));
  const passed = runs.filter((c) => c.conclusion === "success").length;
  return passed ? { passed, failed: runs.filter((c) => RED.has(c.conclusion)).length, required: req.length > 0 } : null;
}

/**
 * The stage a usage record came from, by its artifact's name (as bench cost.mjs stageOf reads it): the review job's
 * `pendulum-usage-<n>-review` is the review stage's, `pendulum-usage-<n>` the work stage's; a record with no artifact
 * name is no stage's.
 */
export const artifactStage = (name) => (typeof name !== "string" ? null : /(^|[-/])review([-/]|$)/.test(name) ? "review" : "work");

/**
 * What a stage records it ended paused on (#614), from its spend line (logic.mjs stageSpendLine: `limitPaused`,
 * `outagePaused`), else its usage record (its `usageLimit` or `outage` beside a `paused` or `waiting` exit): `usage-limit`
 * (its account's usage limit, held until a reset or until another account takes the Objective), `outage`, or null.
 */
function pauseOf(line, rec) {
  if (line) return line.limitPaused ? "usage-limit" : line.outagePaused ? "outage" : null;
  const has = (v) => !!v && typeof v === "object" && !Array.isArray(v);
  if ((rec?.exit === "paused" || rec?.exit === "waiting") && has(rec.usageLimit)) return "usage-limit";
  return rec?.exit === "paused" && has(rec.outage) ? "outage" : null;
}

/**
 * An Objective's stages from its issue's comments and its stages' usage records (pure), each counted once: the card's
 * rows and the Objective's spend that max_objective_usd compares (objectiveSpend).
 *  comments   the issue's comments: each stage's progress comment (logic.mjs progress marker, its harness, spend and
 *             rebase lines) and each sandbox stage's vendor comment
 *  records    the stages' usage records (objectiveRecords: the Actions artifacts), read for the dollars of a stage whose
 *             comment has no spend line and for the model of one whose harness line names none: a record counts only for
 *             the comment of its own stage (artifactStage of its `artifact`) whose key is its `progressRun`
 *  mine       whose comments are Pendulum's (pendulumOwn; logic.mjs isSelf by default): only their markers count
 *  pushed     whose comments are by someone who can push or came through another App (finishData): a progress or vendor
 *             comment of theirs that is not Pendulum's is a stage of unknown cost
 *  inRun      whether a comment written at a time is in the Objective's run (finishData: its clock to its merge)
 *  partOf     the split part a stage started at a time worked on (1 for an Objective that never split)
 * Returns {stages, sandbox}: each stage {stage (work or review), rebase (a send-back's rebase line), conflict (that
 * line's conflict pass), part, at, start, end, model, harness (its harness line's, else its record's, else null), usd
 * (known dollars, null for none), unknown (runs of unknown cost), why (their usage.mjs UNKNOWN_WHY codes: its line's or
 * record's, `no-record` with neither, `unattributed` for one Pendulum cannot attribute), byBilling, byPass (usage.mjs
 * passRead: its dollars by pass kind, {} when its record names none), rerun (usage.mjs rerunRead, or null), judgeOnly,
 * sandbox (its own vendor comment's cost {usd, unknown}, or null), ledger (its per-pass ledger: the ledger line beside
 * its spend line, else its usage record's; null for none), version (the Pendulum release that ran it, or null), tokens
 * (its ledger line's passes' or its usage record's), unattributed (true for a stage Pendulum cannot attribute), key (its
 * progress comment's run key, as its usage record and its findings name it), pause (pauseOf, when it ended paused)}, in time order; and the cloud sandbox's own cost
 * {usd, unknown}, every vendor comment's, or null: beyond its stages' own, the runs of unknown cost of vendor comments
 * Pendulum cannot attribute (sandboxWhy), whose stage kinds are `foreignVendors`, one per comment (a vendor comment of a
 * stage that has a progress comment, Pendulum's or not, is that stage's).
 */
export function objectiveStages({ issue: n, comments = [], records = [], mine = isSelf, pushed = (c) => githubWriter(c) || throughApp(c), inRun = () => true, partOf = () => 1 }) {
  const own = comments.filter((c) => mine(c)).sort((a, b) => ms(a.created_at) - ms(b.created_at));
  // Stage comments by someone who can push, or through another App, that Pendulum cannot attribute to itself (another
  // route's login or App): each is a run of unknown cost. A stranger's paste counts nothing.
  const vouched = comments.filter((c) => !mine(c) && pushed(c)).sort((a, b) => ms(a.created_at) - ms(b.created_at));

  // Each stage: its progress comment, from its first write (the stage's start) to its last (its exit line).
  const progress = new RegExp(`^<!-- pendulum:${n}:progress:(work|review):([A-Za-z0-9:-]{1,100}) -->`);
  const vendorHead = new RegExp(`^<!-- pendulum:${n}:vendor:((?:work|review):[A-Za-z0-9:-]{1,100}) -->`);
  // A record by its own stage and key; two for one (a run's attempts both uploaded) name none, never the last one read.
  const byRun = new Map();
  for (const r of records) {
    const stage = artifactStage(r?.artifact);
    if (!stage || typeof r.progressRun !== "string") continue;
    const k = `${stage}:${r.progressRun}`;
    byRun.set(k, byRun.has(k) ? null : r);
  }
  const endOf = (c) => (c.updated_at && ms(c.updated_at) >= ms(c.created_at) ? c.updated_at : c.created_at);
  const stages = [];
  const keys = new Set();
  const byKey = new Map();
  for (const c of own) {
    const m = progress.exec(c.body || "");
    if (!m || !inRun(c.created_at)) continue;
    const [, stage, key] = m;
    keys.add(`${stage}:${key}`);
    // Its dollars: the spend line it carries (every route's), else its usage record; with neither, unknown.
    const line = spendParts(c.body);
    // Its usage record: its dollars only when it has no spend line; its model whenever neither its harness line nor the
    // ledger line beside its spend line names one (Copilot's default model is known only from the run's record).
    const record = byRun.get(`${stage}:${key}`) || null;
    const rec = line ? null : record;
    let usd = line ? (line.modelUsd ?? line.usd) : rec ? num(rec.usd) : null;
    const unknown = line ? (line.usdUnknown ?? 0) : rec ? unknownRuns(rec) : 1;
    // A record with no run of unknown cost (no harness pass ran) is a known $0; one with unknown runs and no dollars is unknown.
    if (!unknown && usd === null) usd = 0;
    if (unknown && !usd) usd = null;
    const rebase = rebaseCostOf(c.body);
    const from = line ?? rec ?? {};
    const harness = stageHarnessOf(c.body)?.harness ?? (HARNESSES.has(record?.harness) ? record.harness : null);
    const why = line || rec ? whyOf(unknown, from.usdUnknownWhy) : ["no-record"];
    // Its per-pass ledger, release and tokens, from the source the report reads them from: a stage with a spend line, the
    // ledger line beside it (logic.mjs ledgerOfComment), else its usage record's; one with none, its usage record's (its
    // times to the millisecond). A spend line carries no tokens.
    const written = line ? ledgerOfComment(c.body) : null;
    const onComment = Array.isArray(written?.ledger) ? written : null;
    const ledger = onComment?.ledger ?? (Array.isArray(record?.ledger) ? record.ledger : null);
    const version = [rec?.ran?.pendulum, onComment?.version, record?.ran?.pendulum].find((v) => typeof v === "string" && VERSION.test(v)) ?? null;
    const tokens = onComment ? onComment.ledger.reduce((t, p) => addTokens(t, p.tokens), zeroTokens()) : tokensOf(record?.tokens);
    const pause = pauseOf(line, rec);
    const s = { stage, rebase: !!rebase, conflict: !!rebase?.conflict, part: partOf(c.created_at), at: c.created_at, start: c.created_at, end: endOf(c), model: stageModel(c.body) ?? ledgerModel(c.body) ?? (record?.byok === true ? null : modelId(record?.model)), harness, usd, unknown, why, byBilling: billingRead(from.usdByBilling), byPass: passRead(from.usdByPass), rerun: rerunRead(from.rerun), judgeOnly: from.judgeOnly === true, sandbox: null, ledger, version, tokens, key, ...(from.noPass === true ? { noPass: true } : {}), ...(pause ? { pause } : {}) };
    stages.push(s);
    byKey.set(`${stage}:${key}`, s);
  }
  // The sandbox stages' vendor comments, matched to their stage's progress comment by key whenever they were written.
  // One with no progress comment (a stage that never wrote one) is a stage of its own, with the model dollars the vendor
  // comment carries for it (launch.mjs bookVendor) and its runs of unknown cost other than the vendor's own.
  let sandbox = null;
  for (const c of own) {
    const key = vendorHead.exec(c.body || "")?.[1];
    const parts = key ? spendParts(c.body) : null;
    if (!parts || (!keys.has(key) && !inRun(c.created_at))) continue;
    // The vendor's usage not reported: no figure, or its line names the sandbox as unknown (cost-join.mjs sandboxUnknown).
    const vendor = { usd: parts.vendorUsd ?? 0, unknown: parts.vendorUsd === null || (parts.usdUnknownWhy ?? []).includes("sandbox") ? 1 : 0 };
    sandbox = { usd: (sandbox?.usd ?? 0) + vendor.usd, unknown: (sandbox?.unknown ?? 0) + vendor.unknown };
    const had = byKey.get(key);
    if (had) {
      had.sandbox = { usd: (had.sandbox?.usd ?? 0) + vendor.usd, unknown: (had.sandbox?.unknown ?? 0) + vendor.unknown };
      continue;
    }
    const usd = parts.modelUsd;
    const unknown = Math.max((parts.usdUnknown ?? 0) - vendor.unknown, usd === null ? 1 : 0);
    const s = { stage: key.startsWith("review:") ? "review" : "work", rebase: false, conflict: false, part: partOf(c.created_at), at: c.created_at, start: null, end: null, model: null, harness: null, usd: unknown && !usd ? null : usd, unknown, why: whyOf(unknown, (parts.usdUnknownWhy ?? []).filter((w) => w !== "sandbox")), byBilling: billingRead(parts.usdByBilling), byPass: {}, rerun: null, judgeOnly: false, sandbox: vendor, ledger: null, version: null, tokens: zeroTokens(), key: key.replace(/^(?:work|review):/, "") };
    stages.push(s);
  }
  // Every stage's key with a progress comment, Pendulum's or one it cannot attribute: a vendor comment of one of them is
  // that stage's, never a run of its own.
  const progressKeys = new Set([...own, ...vouched].map((c) => progress.exec(c.body || "")).filter(Boolean).map((m) => `${m[1]}:${m[2]}`));
  const foreignVendors = [];
  for (const c of vouched) {
    const m = progress.exec(c.body || "");
    const vendorKey = vendorHead.exec(c.body || "")?.[1];
    if (m && inRun(c.created_at)) {
      keys.add(`${m[1]}:${m[2]}`);
      stages.push({ stage: m[1], rebase: false, conflict: false, part: partOf(c.created_at), at: c.created_at, start: c.created_at, end: endOf(c), model: null, harness: null, usd: null, unknown: 1, why: ["unattributed"], byBilling: {}, byPass: {}, rerun: null, judgeOnly: false, sandbox: null, ledger: null, version: null, tokens: zeroTokens(), unattributed: true, key: m[2] });
    } else if (vendorKey && !progressKeys.has(vendorKey) && inRun(c.created_at)) {
      sandbox = { usd: sandbox?.usd ?? 0, unknown: (sandbox?.unknown ?? 0) + 1 };
      foreignVendors.push(vendorKey.startsWith("review:") ? "review" : "work");
    }
  }
  stages.sort((a, b) => ms(a.at) - ms(b.at));
  return { stages, sandbox, foreignVendors };
}

/**
 * Where an Objective's run starts over (#517): the latest of its restart record (`pendulum:restart`, logic.mjs
 * restartedAt) and its reopening (the timeline's `reopened` event), or null. The finish card's clock starts at the
 * first activation or proved start at or after it, and max_objective_usd counts from it.
 */
export function objectiveWindow(comments = [], timeline = []) {
  const times = [restartedAt(comments), ...(timeline || []).filter((e) => e?.event === "reopened").map((e) => e.created_at)].filter((t) => Number.isFinite(ms(t)));
  return times.length ? new Date(Math.max(...times.map(ms))).toISOString() : null;
}

/** The progress comment keys of Pendulum's stages that wrote no spend line, by stage: the usage artifacts to read for them. */
export function unlinedStages(comments, n, mine = isSelf) {
  const progress = new RegExp(`^<!-- pendulum:${n}:progress:(work|review):([A-Za-z0-9:-]{1,100}) -->`);
  return comments.filter((c) => mine(c) && !spendParts(c.body)).map((c) => progress.exec(c.body || "")).filter(Boolean).map((m) => ({ stage: m[1], key: m[2] }));
}

/**
 * The progress comment keys of Pendulum's stages whose harness line names no model (Copilot at its default model) and
 * that have no ledger line naming one beside their spend line (ledgerModel), by stage: the usage artifacts the finish
 * card reads for their model alone. A stage with no harness line is none.
 */
export function modellessStages(comments, n, mine = isSelf) {
  const progress = new RegExp(`^<!-- pendulum:${n}:progress:(work|review):([A-Za-z0-9:-]{1,100}) -->`);
  return comments.filter((c) => mine(c) && HARNESS_LINE.test(c.body || "") && stageModel(c.body) === null && ledgerModel(c.body) === null).map((c) => progress.exec(c.body || "")).filter(Boolean).map((m) => ({ stage: m[1], key: m[2] }));
}

/**
 * The Objective's known spend since `since` (objectiveWindow; null: all of it), as max_objective_usd compares it
 * (pure): the known dollars of every stage objectiveStages counts and of the cloud sandbox (`stagesUsd`), and of the
 * decision calls made outside any stage that Pendulum's comments on the issue record (logic.mjs decisionSpendEntries,
 * `decisionsUsd`: every line of a comment written since, and a line of an older comment dated after the day it starts),
 * together `usd`; the runs of unknown cost beside them (`unknown`), which add nothing to it. `stages` counts the stages.
 */
export function objectiveSpend({ issue, comments = [], records = [], mine = isSelf, pushed, since = null }) {
  const inRun = (at) => !since || ms(at) >= ms(since);
  const { stages, sandbox } = objectiveStages({ issue, comments, records, mine, inRun, ...(pushed ? { pushed } : {}) });
  const stagesUsd = stages.reduce((s, x) => s + (x.usd ?? 0), 0) + (sandbox?.usd ?? 0);
  const day = since ? new Date(ms(since)).toISOString().slice(0, 10) : null;
  const lines = comments.filter((c) => mine(c) && /^<!-- pendulum:\d+:/.test(c.body || "")).flatMap((c) => decisionSpendEntries(c.body).filter((e) => !since || inRun(c.created_at) || e.date > day));
  const decisionsUsd = lines.reduce((s, e) => s + e.usd, 0);
  const round = (v) => Math.round(v * 1e6) / 1e6;
  return {
    usd: round(stagesUsd + decisionsUsd),
    stagesUsd: round(stagesUsd),
    decisionsUsd: round(decisionsUsd),
    unknown: stages.reduce((s, x) => s + (x.unknown || 0), 0) + (sandbox?.unknown ?? 0) + lines.reduce((s, e) => s + (e.usdUnknown ?? 0), 0),
    byBilling: addBilling(...stages.map((s) => s.byBilling), lines.length ? { api: round(decisionsUsd) } : {}),
    stages: stages.length,
  };
}

/**
 * What of each stage Pendulum's own churn caused (#517), as `churn` (a list), from what the stage's own records say,
 * never inferred; anything else stays the work the issue asked for:
 * - `rebase-conflict` / `rebase-clean`, the whole stage: a send-back's rebase after other PRs merged (its rebase line);
 * - `catch-up`, its `conflict` passes: the catch-up pass a work stage runs when the default branch changed a workflow
 *   during the run and the branch conflicts with it (worker.mjs catchConflict), caused by another merge;
 * - `block`, the pass kinds its `rerun` record says it ran again after a Block;
 * - `judge`, all of it but its answer and fix passes: a review stage that records it was started only to judge answers
 *   already made (`judgeOnly`, review.mjs: checkState's judgeOnly on the record's own PR since the last re-entry).
 */
export function markChurn(stages) {
  for (const s of stages) {
    s.churn = [];
    if (s.kind === "rebase") {
      s.churn.push({ row: s.conflict ? "rebase-conflict" : "rebase-clean", whole: true });
      continue;
    }
    if (s.byPass?.conflict) s.churn.push({ row: "catch-up", kinds: ["conflict"] });
    const repeated = (s.rerun?.repeated || []).filter((k) => k !== "conflict");
    if (repeated.length) s.churn.push({ row: "block", kinds: repeated });
    if (s.judgeOnly && s.kind === "review") s.churn.push({ row: "judge", remainder: true });
  }
  return stages;
}

/** The ends other than a merge a card is posted for (#589): Blocked, a Question, closed without merging. */
export const ENDS = Object.freeze(["blocked", "question", "closed"]);

/** When a notice of Pendulum's was last written (its latest write: a repeated Block edits its notice in place). */
const noticeAt = (c) => (c.updated_at && ms(c.updated_at) >= ms(c.created_at) ? c.updated_at : c.created_at);

/** Why an Objective waited, as the card and its summary name it (#614): each from a record that says so, never worked out. */
export const WAIT_WHY = Object.freeze(["blocked-by", "usage-limit", "outage", "you"]);
/** A wait's cause as the card words it after "waiting for" (a blocked-by wait names its issues instead). */
const WAIT_CAUSE = Object.freeze({ "usage-limit": "a usage limit", outage: "an outage", you: "you" });

/**
 * What a notice's hold waited on (WAIT_WHY), from its structure alone: a Question waits for you; a Block by its cause line
 * (logic.mjs blockMarker): an outage, a provider's usage limit or quota, or you for a cause a person fixes (the work, a
 * setup gap, Pendulum itself). A notice with no cause line, or one of a cap or budget, names none.
 */
function holdWhy(x) {
  if (x.kind === "question") return "you";
  return { outage: "outage", "provider-quota": "usage-limit", work: "you", setup: "you", pendulum: "you" }[x.cause] ?? null;
}

/**
 * The time the run was on hold after a stage (#589, #614), from Pendulum's own records and their times alone:
 * - a Blocked or Question notice of Pendulum's own (`own`, in the run; session.mjs applyExit: `<!-- pendulum:<n>:blocked:…
 *   -->`, logic.mjs questionMarker) marks the stage whose span holds it as ended that way (`stage.outcome`), and the hold
 *   runs from the notice to the next stage's start;
 * - a stage that records it ended paused on a usage limit or an outage (`stage.pause`, pauseOf) is marked `paused`, and
 *   the hold runs from its last write to the next stage's start.
 * One no later stage follows has no recorded end: no hold. One inside a hold already counted adds none. Returns
 * [{kind (blocked, question, paused), start, end, why (WAIT_WHY, when a record names it), cause (its words)}], oldest first.
 */
function holdsOf(n, own, stages) {
  const kindOf = (body) => (new RegExp(`^<!-- pendulum:${n}:blocked:[^\\n]* -->`).test(body) ? "blocked" : new RegExp(`^<!-- pendulum:${n}:question:\\S*:(issue|pr) -->`).test(body) ? "question" : null);
  const notices = own.map((c) => ({ kind: kindOf(c.body || ""), at: noticeAt(c), cause: blockCauseOf(c.body) })).filter((x) => x.kind);
  const timed = stages.filter((s) => s.start);
  const pauses = timed.filter((s) => s.pause).map((s) => ({ kind: "paused", at: s.end, stage: s }));
  const holds = [];
  // Oldest first; at one time, a stage's own pause before a notice about it.
  for (const x of [...pauses, ...notices].sort((a, b) => ms(a.at) - ms(b.at))) {
    const stage = x.stage ?? timed.findLast((s) => ms(s.start) <= ms(x.at) && ms(x.at) <= ms(s.end));
    if (stage && (x.kind !== "paused" || !stage.outcome)) stage.outcome = x.kind;
    if (holds.some((h) => ms(h.start) <= ms(x.at) && ms(x.at) < ms(h.end))) continue;
    const next = timed.find((s) => s !== x.stage && (x.stage ? ms(s.start) >= ms(x.at) : ms(s.start) > ms(x.at)));
    const why = x.stage ? x.stage.pause : holdWhy(x);
    if (next) holds.push({ kind: x.kind, start: x.at, end: next.start, ...(why ? { why, cause: WAIT_CAUSE[why] } : {}) });
  }
  return holds;
}

// An owner as GitHub names one: letters, digits and dashes, and for a managed user (Enterprise Managed Users) an
// underscore and its enterprise's short code of three to eight letters and digits at the end; 39 characters in all.
const OWNER = "(?=[^/]{1,39}/)[A-Za-z0-9][A-Za-z0-9-]*(?:_[A-Za-z0-9]{3,8})?";
/** A repository's `owner/name` as the card may print it, else null. */
const repoName = (v) => (typeof v === "string" && new RegExp(`^${OWNER}/[A-Za-z0-9._-]{1,100}$`).test(v) ? v : null);
/**
 * The repository of a blocking issue (a timeline event's `blocked_by`, or a `blockers` entry): the one it names, this
 * repository (`repo`) when it names none, and null for a name the card would not print: that issue is then left out,
 * never read as this repository's issue of the same number.
 */
const blockerRepo = (b, repo) => {
  const named = b?.repository?.full_name ?? b?.repo;
  return named === undefined || named === null ? repo : repoName(named);
};
/** A blocking issue's id, `owner/name#n`, or null for one that names no issue or a repository the card would not print. */
const blockerId = (b, repo) => (Number.isSafeInteger(b?.number) && b.number > 0 && blockerRepo(b, repo) ? `${blockerRepo(b, repo)}#${b.number}` : null);
const isoTime = (t) => new Date(t).toISOString().replace(".000Z", "Z");

/**
 * The issues that blocked the run before its first stage (#614), from recorded times alone (pure). A wait starts at the
 * issue timeline's `blocked_by_added` event, or at the clock (`started`) when the relation was already there, and ends at
 * the first of that relation's `blocked_by_removed` event and the blocking issue's close (`blockers`: each {repo, number,
 * state, closed_at}, as GitHub answers for it now). It counts only with both, and only when it ended by the first
 * stage's start: a blocker with no close read, one closed after the first stage began (reopened and closed again, so its
 * first close is not what GitHub holds), or a run with no timed stage, shows no wait. Waits that overlap are one, naming
 * each issue. Returns [{kind: "blocked-by", why, start, end, blockers, cause}], oldest first.
 */
function blockedWaits({ repo, timeline, blockers, started, stages }) {
  const first = stages.filter((s) => s.start).sort((a, b) => ms(a.start) - ms(b.start))[0];
  if (!first) return [];
  const idOf = (b) => blockerId(b, repo);
  const events = (timeline || []).filter((e) => (e?.event === "blocked_by_added" || e?.event === "blocked_by_removed") && idOf(e.blocked_by) && Number.isFinite(ms(e.created_at))).sort((a, b) => ms(a.created_at) - ms(b.created_at));
  const spans = [];
  for (const [i, e] of events.entries()) {
    if (e.event !== "blocked_by_added") continue;
    const id = idOf(e.blocked_by);
    const removed = events.slice(i + 1).find((x) => x.event === "blocked_by_removed" && idOf(x.blocked_by) === id);
    const closed = (blockers || []).find((b) => idOf(b) === id && b.state === "closed" && Number.isFinite(ms(b.closed_at)));
    const ends = [removed?.created_at, closed?.closed_at].filter(Boolean).map(ms);
    const start = Math.max(ms(e.created_at), ms(started));
    const end = Math.min(...ends);
    if (!ends.length || !(end > start) || end > ms(first.start)) continue;
    spans.push({ start, end, name: id.startsWith(`${repo}#`) ? id.slice(repo.length) : id });
  }
  const out = [];
  for (const x of spans.sort((a, b) => a.start - b.start)) {
    const last = out.at(-1);
    if (last && x.start <= last.end) {
      last.end = Math.max(last.end, x.end);
      if (!last.blockers.includes(x.name)) last.blockers.push(x.name);
    } else out.push({ start: x.start, end: x.end, blockers: [x.name] });
  }
  return out.map((w) => ({ kind: "blocked-by", why: "blocked-by", start: isoTime(w.start), end: isoTime(w.end), blockers: w.blockers, cause: w.blockers.join(", ") }));
}

/**
 * The blocking issues a card's blocked-by waits need read (postFinishCard): each one a `blocked_by_added` event of the
 * issue timeline names before `before` (the first stage's start: a relation added later is no wait before it), once, as
 * {repo (owner/name), number}. None with no `before`.
 */
export function blockersToRead(repo, timeline, before) {
  const seen = new Map();
  for (const e of timeline || []) {
    const id = e?.event === "blocked_by_added" && ms(e.created_at) < ms(before) ? blockerId(e.blocked_by, repo) : null;
    if (id) seen.set(id, { repo: blockerRepo(e.blocked_by, repo), number: e.blocked_by.number });
  }
  return [...seen.values()];
}

/**
 * The run's waits with no time counted twice (pure): oldest first, each cut to the part no earlier wait covers (its
 * start then the earlier one's end, a recorded time too), and left out when nothing of it is left. Their lengths then
 * add up to the time the run waited (waitedMs).
 */
function apart(holds) {
  const out = [];
  let upTo = -Infinity;
  for (const h of [...holds].sort((a, b) => ms(a.start) - ms(b.start))) {
    if (ms(h.end) <= upTo) continue;
    out.push(ms(h.start) < upTo ? { ...h, start: isoTime(upTo) } : h);
    upTo = ms(h.end);
  }
  return out;
}

/**
 * The card's figures, from GitHub's answers (pure). Null when no PR of the Objective merged and no other end (`end`) is
 * given.
 *  issue        {number, user}
 *  timeline     the issue's timeline events (its label events)
 *  comments     the issue's comments: the plan, each stage's progress comment (logic.mjs progress marker, its harness and
 *               spend lines), each sandbox stage's vendor comment
 *  pulls        the Objective's merged PRs: each {pr (GitHub's full PR), timeline (its issue timeline: the merge queue's
 *               events), reviews, reviewComments}
 *  checks       every attempt of the check runs on the last PR's gate commit (its merge commit when it went through a
 *               merge queue, else its head); `required` the default branch's required checks (gateChecks)
 *  records      the stages' usage records (session.mjs writeUsage: the Actions artifacts), each naming its progress
 *               comment's key (`progressRun`)
 *  mine         whose comments, reviews and PRs are Pendulum's (pendulumOwn; logic.mjs isSelf by default)
 *  end          an end other than a merge (#589): {kind (ENDS), at (when: the Blocked or Question notice, the close),
 *               reason, form (a Question's: issue or pr)}; read only when no PR merged. `pulls` then holds the newest PR on
 *               the Objective's branch, whatever its state, if it has one
 *  pushed       whose comments are by someone who can push (logic.mjs githubWriter: a MEMBER or COLLABORATOR author, or a pinned
 *               maintainer, only on the writer list or once a permission read verified it, github.mjs verifyAuthors) or came through a GitHub App other than
 *               Actions (throughApp): a progress or vendor comment of theirs that is not Pendulum's is a stage of unknown
 *               cost (its time shown, never its figures)
 *  blockers     the issues the timeline's `blocked_by_added` events name (blockersToRead), as GitHub answers for each
 *               now: {repo, number, state, closed_at}; one not read is left out, and its wait is then not shown
 */
export function finishData({ repo, issue, timeline = [], comments = [], pulls = [], checks = [], required = [], records = [], blockers = [], label = OBJECTIVE, mine = isSelf, pushed = (c) => githubWriter(c) || throughApp(c), end = null }) {
  const n = issue.number;
  // An end other than a merge (#589: Blocked, a Question, closed without merging) is the caller's, at its recorded time,
  // and wins: a split Objective's earlier part, merged before this run's Block, is no merge of this run.
  const other = end && ENDS.includes(end.kind) && Number.isFinite(ms(end.at)) ? end : null;
  const merged = pulls.filter((p) => p?.pr?.merged_at && (!other || ms(p.pr.merged_at) <= ms(other.at))).sort((a, b) => ms(a.pr.merged_at) - ms(b.pr.merged_at));
  if (!merged.length && !other) return null;
  const mergedAt = other ? null : merged.at(-1).pr.merged_at;
  const endAt = mergedAt ?? new Date(ms(other.at)).toISOString();
  // The PRs the card names: the merged ones, then, at another end, the newest unmerged one the caller read on the
  // Objective's branch (open, a draft, or closed unmerged).
  const open = other ? pulls.filter((p) => p?.pr?.number && !p.pr.merged_at).slice(-1) : [];
  const shown = [...merged, ...open];
  // The clock starts at the first activation after the most recent restart or reopen.
  const window = objectiveWindow(comments.filter((c) => mine(c)), timeline);
  const start = clockStart(timeline, label, window, { issue: n, comments, mine });
  const started = start?.created_at ?? window ?? shown[0]?.pr.created_at ?? endAt;
  const inRun = (at) => ms(at) >= ms(started) && ms(at) <= ms(endAt);
  const own = comments.filter((c) => mine(c)).sort((a, b) => ms(a.created_at) - ms(b.created_at));
  // Which merged part a stage worked on: the parts merged before it started (a split Objective's PRs merge in order).
  // Unmerged, every stage is the first part's.
  const partOf = (at) => merged.filter((p) => ms(p.pr.merged_at) < ms(at)).length + 1;
  const { stages, sandbox, foreignVendors } = objectiveStages({ issue: n, comments, records, mine, pushed, inRun, partOf });
  // Each stage's name, in time order, from recorded fields only: a review; a send-back's rebase (its rebase line); the
  // first work stage of the Objective (its build) or of a later split part; any other work stage is work.
  const firstOfPart = new Set();
  for (const s of stages) {
    s.kind = "review";
    if (s.stage === "work") {
      s.kind = s.rebase ? "rebase" : !firstOfPart.has(s.part) ? (s.part > 1 ? "part" : "build") : "work";
      if (s.kind === "build" || s.kind === "part") firstOfPart.add(s.part);
    }
    delete s.stage;
    delete s.rebase;
  }
  markChurn(stages);

  // The merge queue: each entry of a merged PR, from its addition to its removal (a drop) or the merge (the queue's own
  // removal of the PR it merged, stamped at the merge's second or the one before).
  const queue = [];
  for (const { pr, timeline: t = [] } of merged) {
    const evs = (t || []).filter((e) => e.event === "added_to_merge_queue" || e.event === "removed_from_merge_queue").sort((a, b) => ms(a.created_at) - ms(b.created_at));
    let open = null;
    for (const e of evs) {
      if (ms(e.created_at) > ms(pr.merged_at)) break;
      if (e.event === "added_to_merge_queue") open = e.created_at;
      else if (open) {
        const atMerge = ms(e.created_at) >= ms(pr.merged_at) - SECOND && !evs.some((x) => x.event === "added_to_merge_queue" && ms(x.created_at) > ms(e.created_at) && ms(x.created_at) <= ms(pr.merged_at));
        queue.push(atMerge ? { start: open, end: pr.merged_at, merged: true } : { start: open, end: e.created_at, merged: false });
        open = null;
      }
    }
    if (open) queue.push({ start: open, end: pr.merged_at, merged: true });
  }

  // Pendulum's reviews and the findings in them: line comments that open a thread (not its placeholder) and those set
  // out in a review body (logic.mjs bodyFindings; a cut tail counts what it stands for).
  const reviews = [];
  let findings = 0;
  for (const { reviews: rs = [], reviewComments = [] } of shown) {
    const ours = (rs || []).filter((r) => mine(r) && (r.body || "").includes(marker(n, "review")));
    const ids = new Set(ours.map((r) => r.id));
    for (const r of ours) {
      reviews.push(r.submitted_at);
      findings += bodyFindings(r.body).reduce((s, f) => s + (Number.isInteger(f.cut) ? f.cut : 1), 0);
    }
    findings += (reviewComments || []).filter((c) => ids.has(c.pull_request_review_id) && !c.in_reply_to_id && !isPlaceholder(c.body)).length;
  }

  const startKind = start?.label.name === DRAFT_LABEL ? "draft" : start?.label.name === label ? "objective" : start ? "running" : null;
  const sum = (k) => shown.reduce((s, p) => s + (Number.isInteger(p.pr[k]) ? p.pr[k] : 0), 0);
  const holds = apart([...blockedWaits({ repo, timeline, blockers, started, stages }), ...holdsOf(n, own.filter((c) => inRun(noticeAt(c))), stages)]);
  const closer = (timeline || []).filter((e) => e.event === "closed").sort((a, b) => ms(a.created_at) - ms(b.created_at)).at(-1)?.actor?.login;
  return {
    repo,
    issue: n,
    author: login(issue.user?.login),
    labeller: login(startKind === "draft" || startKind === "objective" ? start.actor?.login : null),
    startKind,
    prs: shown.map((p) => ({ number: p.pr.number, url: p.pr.html_url ?? `https://github.com/${repo}/pull/${p.pr.number}`, opened: p.pr.created_at, merged: p.pr.merged_at ?? null, ours: mine(p.pr), draft: p.pr.draft === true, open: p.pr.state === "open" && !p.pr.merged_at })),
    started,
    merged: mergedAt,
    // How the run ended (ENDS, `merged` for a merge) and when; a Blocked or Question end's reason, and a Question's form
    // (logic.mjs questionForm) and the PR it asks on.
    end: other ? other.kind : "merged",
    ended: endAt,
    reason: other?.reason ? String(other.reason) : null,
    form: other?.form === "pr" || other?.form === "issue" ? other.form : null,
    // A Block's way on (session.mjs nextStep's code: resume, work, restart, none), when the caller knows it.
    next: ["resume", "work", "restart", "none"].includes(other?.next) ? other.next : null,
    closer: login(closer),
    // The run's recorded waits (#589, #614): the issues that blocked it before its first stage, and the time on hold after
    // each Blocked or Question notice and each paused stage until the next stage started, no time in two of them (apart).
    holds,
    planned: own.some((c) => (c.body || "").startsWith(marker(n, "plan")) && inRun(c.created_at)),
    // The scorecard's first activation without the restart window.
    labelled: labelTime(issue, timeline, label, null, { comments, mine }),
    // Labelled before the rename to Pendulum: no wall clock (clockRenamed).
    clockRenamed: clockRenamed(timeline),
    clockActivationMissing: !start && latestDraftEvent(timeline) !== null,
    commits: sum("commits"),
    additions: sum("additions"),
    deletions: sum("deletions"),
    files: sum("changed_files"),
    checks: mergedAt ? gateChecks(checks, mergedAt, required) : null,
    reviews: reviews.length ? { count: reviews.length, findings, last: reviews.sort((a, b) => ms(a) - ms(b)).at(-1) } : null,
    stages,
    queue,
    sandbox,
    foreignVendors,
    // The zone its filer's machine recorded in its body (clock.mjs objectiveZone), null with none: the card's times only.
    zone: objectiveZone(issue.body),
  };
}

// ------------------------------------------------------------------ words




/** The reason codes of the cloud sandbox's runs of unknown cost: `sandbox` for a stage's own, `unattributed` for the rest. */
export function sandboxWhy(d) {
  const own = d.stages.reduce((n, s) => n + (s.sandbox?.unknown ?? 0), 0);
  return [...(own ? ["sandbox"] : []), ...((d.sandbox?.unknown ?? 0) > own ? ["unattributed"] : [])];
}

/**
 * How long the run waited (#614), in ms: its recorded waits (`d.holds`) inside its clock, time two of them share counted
 * once.
 */
export function waitedMs(d) {
  const from = ms(d.started);
  const to = ms(d.ended ?? d.merged);
  const spans = (d.holds ?? []).map((h) => [Math.max(ms(h.start), from), Math.min(ms(h.end), to)]).filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0]);
  let total = 0;
  let upTo = -Infinity;
  for (const [a, b] of spans) {
    if (b <= upTo) continue;
    total += b - Math.max(a, upTo);
    upTo = b;
  }
  return total;
}

/**
 * The totals the card shows: the wall clock (ms), the known dollars, the runs of unknown cost with their reason codes
 * (`why`) and the dollars by billing; and the wall clock's two parts (#614): `waited`, its recorded waits (waitedMs), and
 * `worked`, the rest of it (null with no wall clock).
 */
export function finishTotals(d) {
  const usd = d.stages.reduce((s, x) => s + (x.usd ?? 0), 0) + (d.sandbox?.usd ?? 0);
  // No stage found at all: the run's cost was not read, so it is unknown, never $0.
  const unknown = d.stages.reduce((s, x) => s + (x.unknown || 0), 0) + (d.sandbox?.unknown ?? 0) + (d.stages.length ? 0 : 1);
  const why = [...new Set([...d.stages.flatMap((x) => (x.unknown ? x.why ?? [] : [])), ...sandboxWhy(d), ...(d.stages.length ? [] : ["no-record"])])].sort();
  const wall = d.clockRenamed || d.clockActivationMissing ? null : ms(d.ended ?? d.merged) - ms(d.started);
  const waited = waitedMs(d);
  return { wall, waited, worked: wall === null ? null : Math.max(0, wall - waited), usd: Math.round(usd * 1e6) / 1e6, unknown, why, byBilling: addBilling(...d.stages.map((s) => s.byBilling)) };
}

/** The zone the card's times are written in (clock.mjs timeZone): the Objective's own, else the repository's, else the default. */
const zoneOf = (d) => timeZone(process.env, { objective: d.zone ?? null }).zone;
const prList = (prs) => (prs.length === 1 ? `PR #${prs[0].number}` : `PRs ${prs.map((p) => `#${p.number}`).join(", ")}`);
/** Whether the Objective's clock and its end fall on different days in the card's zone (the times then carry their dates). */
const spansDays = (d) => zoneDay(ms(d.started), zoneOf(d)) !== zoneDay(ms(d.ended), zoneOf(d));
/** The zone's short name, as the card's times carry it once: "PST", "GMT+1". */
const zoneName = (d) => clockText(ms(d.ended), { zone: zoneOf(d) }).split(" ").at(-1);
/** A time as the card writes it: in its zone, the date when the run crosses midnight, the zone's name with `abbr`. */
const atOf = (d, t, { abbr = false } = {}) => clockText(ms(t), { zone: zoneOf(d), date: spansDays(d), abbr });
const CHECK = () => "CI check";

/** The headline's figure: the known dollars and runs of unknown cost ("$3.67 + unknown", "unknown"), "so far" when not final. */
function headlineMoney(d, t) {
  const figure = t.usd === 0 && t.unknown > 0 ? "unknown" : cellCost(t.usd, t.unknown);
  return `${figure}${d.end === "blocked" || d.end === "question" ? " so far" : ""}`;
}

/**
 * The headline (`### …`): the end, how long, what it cost. A run with a recorded wait says how long it worked and how
 * long it waited, apart (#614), never the two as one figure.
 */
export function headline(d) {
  const t = finishTotals(d);
  const how = t.wall === null ? "" : t.waited > 0 ? ` · ${durationText(t.worked)} working, ${durationText(t.waited)} waiting` : ` ${d.end === "merged" ? "in" : "after"} ${durationText(t.wall)}`;
  const what = { merged: "✅ Merged", closed: "⏹️ Closed without merging", blocked: "⛔ Blocked", question: "❓ Question" }[d.end];
  return `### ${what}${how} · ${headlineMoney(d, t)}`;
}

/**
 * The headline's second line: the issue and its PRs, how and when it ended (the run's span when it crosses midnight),
 * what the dollars are, and its runs of unknown cost.
 */
export function subline(d) {
  const t = finishTotals(d);
  const prs = d.prs.length ? prList(d.prs) : null;
  const parts = [];
  if (d.end === "merged") {
    parts.push(`Issue #${d.issue} → ${prs}`);
    const how = d.queue.some((q) => q.merged) ? "merged through your merge queue" : "merged";
    parts.push(spansDays(d) ? `${atOf(d, d.started)} – ${atOf(d, d.ended, { abbr: true })}` : `${how} at ${atOf(d, d.ended, { abbr: true })}`);
  } else {
    // The run's own PR: the newest unmerged one (a split Objective's earlier parts merged before it).
    const pr = d.prs.findLast((p) => !p.merged) ?? null;
    parts.push(`Issue #${d.issue}`);
    if (pr) parts.push(d.end === "closed" ? (pr.open ? `PR #${pr.number} still open` : `PR #${pr.number} closed, not merged`) : pr.draft ? `PR #${pr.number} is a draft` : `PR #${pr.number} is open`);
    const at = atOf(d, d.ended, { abbr: true });
    parts.push({ closed: `closed at ${at}`, blocked: `Blocked at ${at}`, question: `Question asked at ${at}` }[d.end]);
  }
  const basis = t.usd > 0 ? basisText(t.usd, t.byBilling) || BASIS.unknown : "";
  if (basis) parts.push(basis);
  if (t.unknown) parts.push(`plus ${many(t.unknown, "AI run")} of unknown cost`);
  if (t.wall === null) {
    const why = d.clockRenamed ? RENAMED_CLOCK_WHY : UNRECORDED_ACTIVATION_WHY;
    parts.push(`${why[0].toUpperCase()}${why.slice(1)}`);
  }
  return parts.join(" · ");
}

/** What a wait was for, in the card's words: "blocked by #12", "waiting for a usage limit"; null when no record names it. */
const waitWords = (h) => (h.why === "blocked-by" ? `blocked by ${h.cause}` : h.cause ? `waiting for ${h.cause}` : null);
/** The same after a duration in the headline's third line: "blocked by #12", "on a usage limit", "for you"; "on hold" when no record names it. */
const waitedWords = (h) => (h.why === "blocked-by" ? `blocked by ${h.cause}` : { "usage-limit": "on a usage limit", outage: "on an outage", you: "for you" }[h.why] ?? "on hold");
const listed = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}` : xs[0]);

/**
 * The headline's third line, when the run has a recorded wait (#614): how long it waited on each cause (one figure per
 * cause, in the order they first came; "on hold" for a wait whose record names none), then the whole span the headline's
 * two figures add up to.
 */
function holdLine(d) {
  const holds = d.holds ?? [];
  if (!holds.length) return null;
  const t = finishTotals(d);
  const by = new Map();
  for (const h of holds) {
    const words = waitedWords(h);
    by.set(words, (by.get(words) ?? 0) + (ms(h.end) - ms(h.start)));
  }
  const waits = listed([...by].map(([words, took]) => `${durationText(took)} ${words}`));
  const span = t.wall === null ? "" : `; ${durationText(t.wall)} from ${d.startKind === "draft" ? "Draft removal" : "the label"} to ${{ merged: "the merge", closed: "the close", blocked: "the Block", question: "the Question" }[d.end]}`;
  return `Waited ${waits}${span}.`;
}

/**
 * Text the harness may have written, on one line of a card: sanitised as every harness text Pendulum publishes (handoff.mjs
 * sanitize: no live mention, no closing keyword, no bot command), its line breaks folded to spaces, so nothing it holds
 * starts a line of the card; at most `max` characters.
 */
const oneLine = (text, max = 300) => {
  const one = plainText(sanitize(String(text ?? ""), { max: max * 2 })).replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};

/** The action lines of a Blocked or a Question card: what to do, then why. */
function actionLines(d) {
  const reason = String(d.reason ?? "").replace(/^question:\s*/i, "");
  if (d.end === "blocked") {
    // Its way on (session.mjs nextStep): one that no resume or restart gets past is said so; any other is fixed, then resumed.
    const todo = d.next === "none" ? "a resume or a restart does not get past this; the Blocked notice on this issue says why." : `fix the cause below, then ${RESUME_OBJECTIVE}. The Blocked notice on this issue has the full steps.`;
    return [`> **What to do:** ${todo}`, ">", `> **Why:** ${oneLine(reason.split(/(?<=[.!?])\s/)[0])}`];
  }
  if (d.end === "question") {
    const pr = d.prs.findLast((p) => !p.merged);
    const todo = d.form === "pr" && pr ? `answer in a comment on this issue or PR #${pr.number}, then mark PR #${pr.number} ready. Pendulum goes on from where it stopped.` : "answer the question in a comment on this issue. Pendulum goes on from where it stopped.";
    return [`> **What to do:** ${todo}`, ">", `> **Question:** ${oneLine(reason)}`];
  }
  return [];
}

/** Who did what, and what Pendulum did, in plain sentences: only what the records say. */
export function summary(d) {
  const act = d.startKind === "draft" ? "removed the Draft label to start it" : "added the label";
  const person = d.author && d.labeller ? (d.author === d.labeller ? `You wrote the issue and ${act}.` : `**${d.author}** wrote the issue and **${d.labeller}** ${act}.`) : d.author ? `**${d.author}** wrote the issue.` : "";
  const did = [];
  if (d.planned) did.push("planned the work");
  const change = `${many(d.commits, "commit")}, +${d.additions} −${d.deletions} across ${many(d.files, "file")}`;
  const ours = d.prs.length > 0 && d.prs.every((p) => p.ours);
  if (ours) did.push(`opened ${prList(d.prs)} (**${change}**)`);
  if (d.checks) {
    const what = many(d.checks.passed, CHECK(d.checks));
    const whose = d.prs.length > 1 ? `the last part's ` : "";
    did.push(`got ${whose}${d.checks.passed > 1 && !d.checks.failed ? "all " : ""}**${what}** green${d.checks.failed ? ` (${d.checks.failed} red)` : ""}`);
  }
  if (d.reviews) did.push(`had the change reviewed (${d.reviews.findings ? many(d.reviews.findings, "finding") : "no findings"})`);
  const theirs = ours || !d.prs.length ? "" : ` ${prList(d.prs)} ${d.prs.length === 1 ? "has" : "have"} **${change}**.`;
  let pendulum;
  if (d.end === "merged") {
    const how = d.queue.some((q) => q.merged) ? "it merged through your merge queue" : "it merged";
    pendulum = did.length ? `Pendulum ${did.join(", ")}, and ${how}.` : `${how[0].toUpperCase()}${how.slice(1)}.`;
  } else if (d.end === "closed") {
    const who = d.closer && d.closer === d.author && d.author === d.labeller ? "you closed the issue" : d.closer ? `**${d.closer}** closed the issue` : "the issue was closed";
    pendulum = did.length ? `Pendulum ${listed(did)}; ${who} before it merged.` : `${who[0].toUpperCase()}${who.slice(1)} before it merged.`;
  } else pendulum = `Pendulum ${did.length ? `${did.join(", ")}, and ` : ""}${d.end === "blocked" ? "is Blocked" : "asked a Question"}.`;
  return `${person ? `${person} ` : ""}${pendulum}${theirs}`;
}

// ------------------------------------------------------------------ timeline and stage table

/** A stage's name in the table, the chart and the log, numbered (`n`) when its name repeats. */
const stageName = (s, planned) => ({ build: planned ? "Plan + build" : "Build", part: `Part ${s.part}`, work: "Work", rebase: "Rebase", review: "Review" })[s.kind];
/** The same, short, for a timeline row (Mermaid section names: short, so the stock themes' margin fits them). */
const rowName = (s) => ({ build: "Build", part: `Part ${s.part}`, work: "Work", rebase: "Rebase", review: "Review" })[s.kind];
/** A stage's result words in the table, when it ended Blocked or on a Question. */
const OUTCOME = Object.freeze({ blocked: "⛔ Blocked", question: "❓ Question", paused: "⏸️ Paused" });
/** The same on a timeline bar. */
const BAR_OUTCOME = Object.freeze({ blocked: "Blocked", question: "Question", paused: "Paused" });

/**
 * The timeline's rows and the stage table's (pure), in time order: each stage with a recorded time, its name numbered
 * when it repeats; each time on hold; the merge queue's entries. {kind (stage, hold, queue), name, start, end, stage}.
 */
function timelineRows(d) {
  const rows = [...d.stages.filter((s) => s.start).map((s) => ({ kind: "stage", name: stageName(s, d.planned), short: rowName(s), start: s.start, end: s.end, stage: s })), ...(d.holds ?? []).map((h) => ({ kind: "hold", name: "On hold", short: "On hold", start: h.start, end: h.end, hold: h })), ...d.queue.map((q) => ({ kind: "queue", name: "Merge queue", short: q.merged ? "Queue" : "Dropped", start: q.start, end: q.end, queue: q }))].sort((a, b) => ms(a.start) - ms(b.start));
  const count = new Map();
  for (const r of rows) if (r.kind !== "queue") count.set(r.name, (count.get(r.name) ?? 0) + 1);
  const seen = new Map();
  for (const r of rows) {
    if (r.kind === "queue" || count.get(r.name) < 2) continue;
    seen.set(r.name, (seen.get(r.name) ?? 0) + 1);
    r.name = `${r.name} ${seen.get(r.name)}`;
  }
  return rows;
}

/** The most stage rows the table shows before like stages fold, and the most timeline rows the chart draws. */
export const TABLE_ROWS = 20;

/**
 * The timeline chart (card-kit.mjs ganttChart): stages amber, a Blocked or Question stage red with its word, a paused one
 * amber with its word, time on hold grey.
 */
function gantt(d, rows) {
  const drawn = rows.filter((r) => r.start);
  if (!drawn.length) return null;
  if (drawn.length > TABLE_ROWS) return `Timeline chart left out: ${many(drawn.filter((r) => r.kind === "stage").length, "stage")}; the table has every figure.`;
  return ganttChart(
    drawn.map((r) => ({ section: r.short, bars: [{ start: ms(r.start), end: ms(r.end), tag: r.kind === "hold" ? "done" : r.stage?.outcome && r.stage.outcome !== "paused" ? "crit" : "active", label: r.stage?.outcome ? BAR_OUTCOME[r.stage.outcome] : "" }] })),
    { zone: zoneOf(d), days: spansDays(d) },
  );
}

/** A stage row's cost cell: its cents and runs of unknown cost, "unknown" with no known figure. */
const stageCost = (r) => (r.usd === null ? "unknown" : r.usd === 0 && !r.unknown ? "—" : cellCost(r.usd > 0 && !r.cents ? r.usd : (r.cents ?? 0) / 100, r.unknown));

/**
 * The stage table (`| Time | Stage | Took | Cost |`), the timeline's figures: each stage, each time on hold, the merge
 * queue, the cloud sandbox, and the Total. Past TABLE_ROWS stage rows, consecutive stages of one kind, model and result
 * fold into one row (`Review ×3 · Fable 5.2`), their times and dollars summed; `folded` says so (the per-stage list
 * moves to Run details).
 */
function stageTable(d, t, rows, costs) {
  const cost = new Map(d.stages.map((s, i) => [s, costs[i]]));
  let lines = [];
  const stageRows = rows.filter((r) => r.kind === "stage");
  const fold = stageRows.length > TABLE_ROWS;
  for (const r of rows) {
    if (r.kind === "queue") continue;
    if (r.kind === "hold") {
      lines.push({ at: r.start, name: waitWords(r.hold) ? `${r.name} · ${waitWords(r.hold)}` : r.name, took: ms(r.end) - ms(r.start), cost: "—" });
      continue;
    }
    const s = r.stage;
    const c = cost.get(s);
    const prev = lines.at(-1);
    if (fold && prev?.stage && prev.stage.kind === s.kind && prev.stage.model === s.model && prev.stage.outcome === s.outcome) {
      prev.n += 1;
      prev.took += ms(s.end) - ms(s.start);
      prev.usd = prev.usd === null || c.usd === null ? (prev.usd ?? c.usd) : prev.usd + c.usd;
      prev.cents = (prev.cents ?? 0) + (c.cents ?? 0);
      prev.unknown += c.unknown;
      continue;
    }
    lines.push({ at: r.start, base: fold ? stageName(s, d.planned) : r.name, stage: s, n: 1, took: ms(s.end) - ms(s.start), usd: c.usd, cents: c.cents, unknown: c.unknown });
  }
  // Stages with no recorded time (a sandbox stage that left only its vendor comment): last, their time unknown.
  for (const s of d.stages.filter((x) => !x.start)) {
    const c = cost.get(s);
    lines.push({ at: null, base: stageName(s, d.planned), stage: s, n: 1, took: null, usd: c.usd, cents: c.cents, unknown: c.unknown });
  }
  const out = lines.map((l) => {
    if (!l.stage) return `| ${atOf(d, l.at)} | ${tableCell(l.name)} | ${durationText(l.took)} | ${l.cost} |`;
    const name = `${l.base}${l.n > 1 ? ` ×${l.n}` : ""}${l.stage.model ? ` · ${modelName(l.stage.model)}` : ""}${l.stage.outcome ? ` · ${OUTCOME[l.stage.outcome]}` : ""}`;
    return `| ${l.at ? atOf(d, l.at) : "—"} | ${tableCell(name)} | ${l.took === null ? "—" : durationText(l.took)} | ${stageCost(l)} |`;
  });
  if (!d.stages.length) out.push(`| — | Pendulum's stages, no record found | — | unknown |`);
  if (d.sandbox) out.push(`| — | Cloud sandbox | — | ${stageCost(costs.at(-1))} |`);
  if (d.queue.length) {
    const queued = d.queue.reduce((n, q) => n + (ms(q.end) - ms(q.start)), 0);
    out.push(`| ${atOf(d, d.queue[0].start)} | Merge queue${d.queue.length > 1 ? ` ×${d.queue.length}` : ""} · your CI | ${durationText(queued)} | — |`);
  }
  // A run that waited (#614): the Total's two parts, each its own row above it.
  if (t.waited > 0 && t.wall !== null) out.push(`| | Working | ${durationText(t.worked)} | |`, `| | Waiting | ${durationText(t.waited)} | |`);
  const total = `| | **Total** | **${t.wall === null ? "not known" : durationText(t.wall)}** | **${cellCost(t.usd, t.unknown)}** |`;
  return { table: ["| Time | Stage | Took | Cost |", "| :-- | :-- | --: | --: |", ...out, total].join("\n"), folded: fold };
}

/** Each stage's line for Run details, when the table folded them. */
const stageList = (d, costs) => d.stages.map((s, i) => `- ${s.start ? atOf(d, s.start) : "—"} ${stageName(s, d.planned)}${s.model ? ` · ${modelName(s.model)}` : ""}${s.outcome ? ` · ${OUTCOME[s.outcome]}` : ""}: ${s.start ? durationText(ms(s.end) - ms(s.start)) : "time not recorded"}, ${stageCost(costs[i])}`).join("\n");

/** The cost rows: each stage, then the cloud sandbox's own cost: {name, model, time, usd, unknown, byBilling, cents}. */
function costRows(d) {
  const rows = d.stages.map((s) => ({ name: stageName(s, d.planned), model: s.model, time: s.start ? durationText(ms(s.end) - ms(s.start)) : "—", usd: s.usd, unknown: s.unknown, byBilling: s.byBilling }));
  if (!d.stages.length) rows.push({ name: "Pendulum's stages, no record found", model: null, time: "—", usd: null, unknown: 1, byBilling: {} });
  if (d.sandbox) rows.push({ name: "Cloud sandbox", model: null, time: "—", usd: d.sandbox.unknown && !d.sandbox.usd ? null : d.sandbox.usd, unknown: d.sandbox.unknown, byBilling: {} });
  const c = centsOf(rows.map((r) => r.usd));
  return rows.map((r, i) => ({ ...r, cents: c[i] }));
}

/** The pass kinds' and stages' words in the breakdown (usage.mjs PASS_KEYS less `conflict`, which is churn), in its order. */
export const ASKED = Object.freeze({ work: "Work", review: "Review", answer: "Answering the review", fix: "Fixing CI", decision: "AI judge calls" });
/** The churn the breakdown names apart (markChurn), in its order. */
export const CHURN = Object.freeze({
  "rebase-conflict": "Rebases after other PRs merged (conflict)",
  "rebase-clean": "Rebases after other PRs merged (clean)",
  "catch-up": "Catch-up runs after a workflow changed on the default branch",
  judge: "Reviews run again only to judge answers",
  block: "Runs repeated after a Block",
});
const round6 = (n) => Math.round(n * 1e6) / 1e6;

/**
 * Where the dollars went (#517), from the stages' records only (pure): `asked`, the work the issue asked for, per split
 * part and per kind (each stage's dollars by pass kind, usage.mjs usdByPass, with the rest under its stage's own kind,
 * work or review); `churn`, what Pendulum's own churn caused (markChurn: a whole stage, some of its pass kinds, or all
 * of it but its answer and fix passes), by what caused it, with how many stages it came from; and the cloud sandbox's
 * own cost, a row of its own. A stage whose kinds do not fit inside its own figure, or whose figure is unknown, cannot
 * be split exactly: it stays whole, under its churn when the whole stage is churn, else under its own kind. Each row
 * {name, usd (null: none known), unknown, byBilling, stages?, cents}, an asked row with its `part` and `what` (its
 * kind), a churn row with its `row` (markChurn's code); the rows' cents add up to the total's. `shown` says whether it
 * adds to the stage table: a split Objective, any churn, or any answer or fix pass.
 */
export function spendBreakdown(d) {
  const asked = new Map();
  const churn = new Map();
  const add = (map, key, base, { usd, unknown = 0, byBilling = {} }, stage = null) => {
    const r = map.get(key) ?? { ...base, usd: 0, known: false, unknown: 0, byBilling: {}, from: new Set() };
    if (usd !== null && usd !== undefined) {
      r.usd = round6(r.usd + usd);
      r.known = true;
    }
    r.unknown += unknown || 0;
    r.byBilling = addBilling(r.byBilling, byBilling);
    if (stage) r.from.add(stage);
    map.set(key, r);
  };
  for (const s of d.stages) {
    const own = s.kind === "review" ? "review" : "work";
    const items = s.churn || [];
    const whole = items.find((i) => i.whole);
    const kinds = Object.entries(s.byPass || {});
    const fits = s.usd !== null && kinds.reduce((n, [, p]) => n + p.usd, 0) <= s.usd + 1e-6 && kinds.reduce((n, [, p]) => n + (p.usdUnknown ?? 0), 0) <= s.unknown;
    const remainder = items.find((i) => i.remainder);
    // A whole stage of churn; or one that cannot be split: its churn row when all of it is churn (a judge-only review
    // that ran no pass of a kind), else its own kind.
    if (whole || !fits) {
      const row = whole ?? (remainder && !kinds.length ? remainder : null);
      if (row) add(churn, row.row, {}, s, s);
      else add(asked, `${s.part}:${own}`, { part: s.part, what: own }, s, s);
      continue;
    }
    const churnOf = new Map(items.filter((i) => i.kinds).flatMap((i) => i.kinds.map((k) => [k, i.row])));
    const left = { usd: s.usd, unknown: s.unknown, byBilling: { ...s.byBilling } };
    for (const [kind, p] of kinds) {
      const unknown = p.usdUnknown ?? 0;
      const part = { usd: unknown && !p.usd ? null : p.usd, unknown, byBilling: p.usdByBilling };
      const row = churnOf.get(kind) ?? (remainder && kind !== "answer" && kind !== "fix" ? remainder.row : null);
      if (row) add(churn, row, {}, part, s);
      else add(asked, `${s.part}:${kind}`, { part: s.part, what: kind }, part);
      left.usd = round6(left.usd - p.usd);
      left.unknown -= unknown;
      for (const [k, v] of Object.entries(p.usdByBilling || {})) left.byBilling[k] = round6((left.byBilling[k] ?? 0) - v);
    }
    left.byBilling = Object.fromEntries(Object.entries(left.byBilling).filter(([, v]) => v > 0));
    if (left.usd > 0 || left.unknown > 0 || !kinds.length) {
      if (remainder) add(churn, remainder.row, {}, { ...left, usd: Math.max(0, left.usd) }, s);
      else add(asked, `${s.part}:${own}`, { part: s.part, what: own }, { ...left, usd: Math.max(0, left.usd) });
    }
  }
  const order = Object.keys(ASKED);
  const parts = d.prs.length > 1 || d.stages.some((s) => s.part > 1);
  const done = (r) => {
    const { known, from, ...row } = r;
    return { ...row, usd: known ? r.usd : r.unknown ? null : 0, ...(from ? { stages: from.size } : {}) };
  };
  const word = (what) => ASKED[what] ?? ASKED.work;
  const askedRows = [...asked.values()].sort((a, b) => a.part - b.part || order.indexOf(a.what) - order.indexOf(b.what)).map((r) => done({ ...r, name: parts ? `Part ${r.part}: ${word(r.what)[0].toLowerCase()}${word(r.what).slice(1)}` : word(r.what) }));
  if (d.sandbox) askedRows.push({ name: "Cloud sandbox, every stage", usd: d.sandbox.unknown && !d.sandbox.usd ? null : d.sandbox.usd, unknown: d.sandbox.unknown, byBilling: {} });
  const churnRows = Object.keys(CHURN).filter((k) => churn.has(k)).map((k) => done({ ...churn.get(k), row: k, name: CHURN[k] }));
  const c = centsOf([...askedRows, ...churnRows].map((r) => r.usd));
  askedRows.forEach((r, i) => (r.cents = c[i]));
  churnRows.forEach((r, i) => (r.cents = c[askedRows.length + i]));
  return { asked: askedRows, churn: churnRows, shown: parts || churnRows.length > 0 || askedRows.some((r) => r.what === "answer" || r.what === "fix") };
}

/** The breakdown's rows as the cost chart labels them: short names, each with its figure. */
const CHART_CHURN = Object.freeze({ "rebase-conflict": "Overhead: rebases", "rebase-clean": "Overhead: rebases", "catch-up": "Overhead: catch-up runs", judge: "Overhead: judging again", block: "Overhead: after a Block" });

/** The breakdown's tables (spendBreakdown): the work the issue asked for, then the overhead apart. */
function breakdownTables(b) {
  const out = [["| What the issue asked for | Cost |", "| :-- | --: |", ...b.asked.map((r) => `| ${r.name} | ${stageCost(r)} |`)].join("\n")];
  if (b.churn.length) out.push(["| Overhead Pendulum caused | Stages | Cost |", "| :-- | --: | --: |", ...b.churn.map((r) => `| ${r.name} | ${r.stages} | ${stageCost(r)} |`)].join("\n"));
  return out;
}

/** The cost chart (card-kit.mjs costChart): one bar per breakdown row with recorded dollars, its figure in its label. */
function costBars(b) {
  const bar = (name, r) => {
    const label = `${name} ${stageCost(r)}`;
    return { label, usd: (r.cents ?? 0) / 100 };
  };
  return costChart([...b.asked.map((r) => bar(r.name, r)), ...b.churn.map((r) => bar(CHART_CHURN[r.row] ?? r.name, r))]);
}

/** What the money note says, once, when a row's cents are not its own figure's (sharedOut). */
export const SHARED_NOTE = "The rows' cents are shared out to add up to the total, so a row can be a cent off its stage's own figure.";
/**
 * Whether any of `rows` (costRows', spendBreakdown's) shows cents other than its own dollars' (#617): centsOf gave it a
 * cent, or took one, so the rows add up to the total's cents, where the stage's own record, its progress comment and the
 * run log show its own figure.
 */
const sharedOut = (rows) => rows.some((r) => r.usd > 0 && r.cents && cellCost(r.cents / 100) !== cellCost(r.usd));

/** The notes line under the money: what the bars show and what they leave out, and that rows are shared out when one is. */
function notesLine(t, b, drawn, shared = false) {
  const none = [...b.asked, ...b.churn].filter((r) => r.usd === null).map((r) => r.name);
  const unknown = t.unknown ? `; ${many(t.unknown, "AI run")} of unknown cost ${t.unknown === 1 ? "is" : "are"} not drawn` : "";
  const named = none.length ? ` ${none.join(", ")} ${none.length === 1 ? "has" : "have"} no recorded dollars.` : "";
  const said = shared ? `${SHARED_NOTE} ` : "";
  return drawn ? `Bars show recorded dollars only${unknown}.${named} ${said}CI minutes are not included.` : `${said}CI minutes are not included.`;
}

/** How the wall clock's two parts are counted (#614), for Run details. */
const WAIT_NOTE = "Waiting is the time on hold in the table, each from a recorded start and end: an issue that blocked this one, from the blocked-by relation (or the label, when later) to that issue's close or the relation's removal; a stage that recorded a pause for a usage limit or an outage, and a Blocked or Question notice, each until the next stage started. A wait with no recorded start and end is not counted. Working is the rest of the time from the label to the end.";

/** How overhead is counted, for Run details. */
const OVERHEAD_NOTE = "Each item comes from a stage's own record, never a guess. A stage is in the part after the PRs merged before it started; its runs are split by the kinds its spend record names. Overhead is a rebase after other PRs merged (its rebase line), a catch-up run after the default branch changed a workflow, the runs a stage records it ran again after a Block, and a review that records it was started only to judge answers already made (all of it but answering the review and fixing CI). Anything else stays in its stage, as that stage.";

/** The run log: every recorded event, oldest first, in the card's zone (its heading names it). */
function runLog(d) {
  const day = spansDays(d);
  const zone = zoneOf(d);
  const at = (t) => clockText(ms(t), { zone, seconds: true, date: day, abbr: false });
  const start = d.startKind === "draft" ? "removed `pendulum:draft`: the clock starts"
    : d.startKind === "running" ? "marked Running: the first record of the start"
    : d.startKind === null ? "the first recorded point of the run"
    : "labelled `pendulum:objective`: the clock starts";
  const out = [[d.started, start]];
  for (const s of d.stages) {
    if (!s.start) continue;
    const name = stageName(s, d.planned).toLowerCase();
    // The model's id as the report names it (usage.mjs modelName, with claude-models.json alone).
    out.push([s.start, `${name} stage started${s.model ? ` (${reportName(s.model, null)})` : ""}`]);
    out.push([s.end, `${name} stage's last line: ${s.usd === null ? "unknown" : costText(s.usd, s.unknown)}${s.outcome ? `, ${BAR_OUTCOME[s.outcome]}` : ""}`]);
  }
  for (const h of d.holds ?? []) {
    if (h.kind === "blocked-by") out.push([h.start, `blocked by ${h.cause}: on hold`], [h.end, `no longer blocked by ${h.cause}`]);
    else out.push([h.start, `${{ blocked: "Blocked notice", question: "Question notice", paused: h.cause ? `paused for ${h.cause}` : "paused" }[h.kind]}: on hold until the next stage`]);
  }
  for (const p of d.prs) out.push([p.opened, `PR #${p.number} opened`]);
  for (const q of d.queue) {
    out.push([q.start, "added to the merge queue"]);
    if (!q.merged) out.push([q.end, "removed from the merge queue"]);
  }
  if (d.reviews) out.push([d.reviews.last, `last review: ${many(d.reviews.count, "review")} in all, ${d.reviews.findings ? many(d.reviews.findings, "finding") : "no findings"}`]);
  if (d.end === "merged") {
    const last = d.prs.at(-1);
    out.push([d.merged, `PR #${last.number} merged${d.checks ? `, ${many(d.checks.passed, CHECK(d.checks))} green` : ""}`]);
  } else out.push([d.ended, { closed: "the issue closed", blocked: "Blocked", question: "Question asked" }[d.end]]);
  return out
    .map(([t, text], i) => [ms(t), i, `- ${at(t)} ${text}`])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1])
    .map((x) => x[2])
    .join("\n");
}

/** The headline block: the top of the card and of the merged PR's body (#589: text only, no image). */
export function finishBlock(d) {
  const hold = holdLine(d);
  return [headline(d), subline(d), ...(hold ? [hold] : [])].join("\n");
}

/** The unknown cost by cause, with its counts: one sentence per cause (card-kit.mjs causeSentences). */
function unknownSentence(d, t) {
  const counts = d.stages.filter((s) => s.unknown).map((s) => [s.why?.[0] ?? "no-record", s.unknown]);
  if (d.sandbox?.unknown) counts.push([sandboxWhy(d)[0] ?? "sandbox", d.sandbox.unknown]);
  if (!d.stages.length) counts.push(["no-record", 1]);
  return t.unknown ? causeSentences(counts) : "";
}

/**
 * The finish card's markdown (pure): see the module comment, and USAGE.md "The finish card". `fit` (finishCardBody's
 * size rule): drop the run log (`log: false`), the per-stage list (`list: false`), the cost chart (`chart: false`).
 */
export function renderFinishCard(d, { log = true, list = true, chart = true } = {}) {
  const t = finishTotals(d);
  const costs = costRows(d);
  const parts = [finishBlock(d)];
  const act = actionLines(d);
  if (act.length) parts.push(act.join("\n"));
  parts.push(summary(d));
  const rows = timelineRows(d);
  const timeline = gantt(d, rows);
  if (timeline) parts.push(`**Timeline** (${zoneName(d)})`, timeline);
  const { table, folded } = stageTable(d, t, rows, costs);
  parts.push(table);
  const where = spendBreakdown(d);
  let drawn = false;
  if (where.shown) {
    const bars = chart ? costBars(where) : null;
    drawn = !!bars;
    parts.push("**Where the money went**", ...(bars ? [bars] : []), ...breakdownTables(where));
  }
  parts.push(notesLine(t, where, drawn, sharedOut([...costs, ...(where.shown ? [...where.asked, ...where.churn] : [])])));
  const named = t.usd > 0 ? kindsOf(t.usd, t.byBilling) : [];
  // Dollars no record names a billing for: not recorded, never called billed or API-equivalent.
  const kinds = t.usd > 0 && !named.length ? ["unknown"] : named;
  const details = [];
  const basis = [...new Set(kinds.map((k) => BASIS_NOTE[k || "unknown"]).filter(Boolean))];
  if (basis.length) details.push(`- **Cost basis:** ${basis.join(" ")}`);
  const unknown = unknownSentence(d, t);
  if (unknown) details.push(`- **Unknown cost:** ${unknown}`);
  details.push("- **Where figures come from:** times from the issue, the PR and each stage's own record; dollars from each stage's own record. Nothing is estimated.");
  if (t.waited > 0) details.push(`- **Working and waiting:** ${WAIT_NOTE}`);
  details.push("- — in Took means no time was recorded for that row; in Cost, that no AI dollars were (a stage that ran no AI, the merge queue, time on hold).");
  if (where.churn.length) details.push(`- **How overhead is counted:** ${OVERHEAD_NOTE}`);
  const version = d.stages.find((s) => s.version)?.version;
  if (version) details.push(`- **Pendulum** ${version}`);
  if (folded && list) details.push("", "**Each stage**", stageList(d, costs));
  if (log) details.push("", `**Run log** (${zoneName(d)})`, runLog(d));
  parts.push(`<details><summary>Run details</summary>\n\n${details.join("\n")}\n\n</details>`);
  return parts.join("\n\n");
}

// ------------------------------------------------------------------ summary marker

/** The summary marker's version: a change that renames, removes or retypes a field is a new one, which no older reader takes. */
export const SUMMARY_VERSION = 1;
const STAGE_KINDS = new Set(["build", "part", "work", "rebase", "review"]);
/** A card stage's kind as the report counts stages: `work` (a build, a split part, any other work stage), `rebase` or `review`. */
export const reportStageKind = (kind) => (kind === "review" || kind === "rebase" ? kind : "work");

/**
 * The Objective's own pass measures, from its stages' ledgers (stagePassFigures), for a reader that compares Objectives
 * (#545's arms): `passes` ({total, answer, fix}: its harness passes, null unless every stage's passes are known: each of
 * Pendulum's stages has a ledger and none is one Pendulum cannot attribute), `decisionRecords` (its stages' decision
 * records, which are no pass and are counted apart as the report counts them, report.mjs foldPasses, #617; null as
 * `passes` is), `modelMinutes` (the minutes of every harness pass, null unless
 * `passes` is known and each harness pass has its times), `tokens` (every stage's, summed), and `labelled` and
 * `labelledWallMs` (the first activation with no restart window, and the wall clock from it to the merge; null with
 * no clock event, or one labelled before the rename to Pendulum: clockRenamed),
 * and `clockWhy`, why the wall clock is not known when that is the rename (`renamed`; null otherwise), so a reader takes
 * it from the card (#587) rather than from the shape of its other fields.
 */
function objectivePasses(d) {
  const figures = d.stages.map((s) => (Array.isArray(s.ledger) ? stagePassFigures(s.ledger) : null));
  const whole = d.stages.length > 0 && d.stages.every((s, i) => !s.unattributed && figures[i]);
  const kinds = whole ? figures.flat() : [];
  const count = (keep) => kinds.filter((k) => keep(k.kind)).reduce((t, k) => t + k.passes, 0);
  const isDecision = (kind) => kind === "decision";
  const passes = whole ? { total: count((kind) => !isDecision(kind)), answer: count(isAnswer), fix: count(isFix) } : null;
  const decisionRecords = whole ? count(isDecision) : null;
  const modelMinutes = whole && !kinds.some((k) => k.untimed) ? kinds.reduce((t, k) => t + (k.harnessMinutes ?? 0), 0) : null;
  const wall = !d.clockRenamed && d.labelled && ms(d.merged) >= ms(d.labelled) ? ms(d.merged) - ms(d.labelled) : null;
  return { passes, decisionRecords, modelMinutes, tokens: d.stages.reduce((t, s) => addTokens(t, s.tokens), zeroTokens()), labelled: d.labelled ?? null, labelledWallMs: wall, clockWhy: d.clockRenamed ? "renamed" : null };
}

/**
 * The finish card's figures as one machine-readable summary (#544), from the same finishData `d` the card is rendered
 * from (finishTotals, costRows and spendBreakdown, never worked out another way), so a cross-Objective report reads one
 * comment per merged Objective. See docs/REPORT.md "The finish card's summary".
 */
export function finishSummary(d) {
  const t = finishTotals(d);
  const rows = costRows(d);
  const b = spendBreakdown(d);
  const stageCounts = { work: 0, rebase: 0, review: 0 };
  for (const s of d.stages) stageCounts[reportStageKind(s.kind)] += 1;
  const money = (r) => ({ usd: r.usd, cents: r.cents, unknown: r.unknown, byBilling: billingRead(r.byBilling) });
  return {
    v: SUMMARY_VERSION,
    pendulum: pendulumBuild(),
    issue: d.issue,
    started: d.started,
    merged: d.merged,
    wallMs: t.wall,
    // The wall clock's two parts and the recorded waits behind them (#614), as the card shows them.
    workMs: t.worked,
    waitMs: t.waited,
    waits: (d.holds ?? []).map((h) => ({ kind: h.kind, why: h.why ?? null, start: h.start, end: h.end, ...(h.blockers ? { blockers: [...h.blockers] } : {}) })),
    prs: d.prs.map((p) => p.number),
    commits: d.commits,
    additions: d.additions,
    deletions: d.deletions,
    files: d.files,
    checks: d.checks,
    reviews: d.reviews ? { count: d.reviews.count, findings: d.reviews.findings } : null,
    stageCounts,
    ...objectivePasses(d),
    cost: { usd: t.usd, cents: Math.round(t.usd * 100), unknown: t.unknown, why: t.why, byBilling: t.byBilling },
    sandbox: d.sandbox ? { usd: d.sandbox.usd, cents: rows.at(-1).cents, unknown: d.sandbox.unknown, why: sandboxWhy(d), foreign: [...(d.foreignVendors ?? [])] } : null,
    stages: d.stages.map((s, i) => ({ kind: s.kind, key: s.key ?? null, part: s.part, model: s.model, harness: s.harness, version: s.version ?? null, ms: s.start ? ms(s.end) - ms(s.start) : null, ...money({ ...s, cents: rows[i].cents }), why: s.why, sandbox: s.sandbox, churn: s.churn.map((c) => c.row), tokens: s.tokens ?? zeroTokens(), passes: Array.isArray(s.ledger) ? stagePassFigures(s.ledger) : null, ...(s.noPass ? { noPass: true } : {}), ...(s.unattributed ? { unattributed: true } : {}) })),
    asked: b.asked.map((r) => ({ part: r.part ?? null, what: r.what ?? "sandbox", ...money(r) })),
    churn: b.churn.map((r) => ({ row: r.row, stages: r.stages, ...money(r) })),
    // An end other than a merge (#589): its kind and time; `merged` is then null, so no reader takes it for a merge.
    ...(d.end && d.end !== "merged" ? { end: d.end, ended: d.ended } : {}),
  };
}

/** The longest summary line a card carries, in characters: a longer one is written with no stage's passes (SUMMARY_MAX). */
export const SUMMARY_MAX = 30_000;
// The marker leaves out what reads back as its default: a cost kind at $0, no runs of unknown cost or reasons, a token
// count none reports, a pass kind's empty `cache`, `priced` and `unpriced`, and its `minutes` when none has its times.
const costOut = (c) => ({ usd: Object.fromEntries(Object.entries(c.usd).filter(([, v]) => v !== 0)), ...(c.unknownRuns ? { unknownRuns: c.unknownRuns } : {}), ...(c.unknownWhy.length ? { unknownWhy: c.unknownWhy } : {}) });
const tokensOut = (t) => Object.fromEntries(Object.entries(t).filter(([, v]) => v !== null));
const passesOut = (list) => list.map((k) => ({ kind: k.kind, passes: k.passes, cost: costOut(k.cost), tokens: tokensOut(k.tokens), ...(k.minutes !== null ? { minutes: k.minutes } : {}), ...(k.harnessMinutes !== k.minutes ? { harnessMinutes: k.harnessMinutes } : {}), ...(k.untimed ? { untimed: k.untimed } : {}), ...(k.cache ? { cache: k.cache } : {}), ...(k.priced.passes ? { priced: { minutes: k.priced.minutes, passes: k.priced.passes, cost: costOut(k.priced.cost) } } : {}), ...(k.unpriced ? { unpriced: k.unpriced } : {}) }));
const markerJson = (v) => JSON.stringify(v).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");

/**
 * The summary marker: one hidden line, its JSON with `<` and `>` escaped so nothing in it can close the comment. Over
 * SUMMARY_MAX characters it is written with every stage's `passes` null, so a reader reads that Objective's stages; still
 * over it, null: the card carries no summary.
 */
export function summaryMarker(d) {
  const sum = finishSummary(d);
  const line = (stages) => `<!-- pendulum:${d.issue}:summary ${markerJson({ ...sum, tokens: tokensOut(sum.tokens), stages })} -->`;
  const full = line(sum.stages.map((s) => ({ ...s, tokens: tokensOut(s.tokens), passes: s.passes && passesOut(s.passes) })));
  if (full.length <= SUMMARY_MAX) return full;
  const bare = line(sum.stages.map((s) => ({ ...s, tokens: tokensOut(s.tokens), passes: null })));
  return bare.length <= SUMMARY_MAX ? bare : null;
}

/** The most characters GitHub takes in a comment's body. */
export const COMMENT_MAX = 65_536;

/** The line under a card's markers that says how its run ended and when (#589): what a later write compares. */
export const finishEndMarker = (d) => `<!-- pendulum:${d.issue}:finish-end ${JSON.stringify({ end: d.end ?? "merged", at: d.ended ?? d.merged })} -->`;
/**
 * How the run a card's `body` shows ended (finishEndMarker), for Objective `n`: {end, at}; a card written before the line
 * was only ever posted on a merge, so it reads as one. Null for a body that is no card.
 */
export function finishEndOf(body, n) {
  const text = String(body ?? "");
  if (!text.startsWith(finishMarker(n))) return null;
  const m = new RegExp(`^<!-- pendulum:${n}:finish-end (\\{[^\\n]*\\}) -->$`, "m").exec(text);
  if (!m) return { end: "merged", at: null };
  try {
    const v = JSON.parse(m[1]);
    return { end: v.end === "merged" || ENDS.includes(v.end) ? v.end : "merged", at: typeof v.at === "string" ? v.at : null };
  } catch {
    return { end: "merged", at: null };
  }
}

/**
 * The finish card comment's whole body: its `finish` marker on its first line, its summary marker on its second, the
 * end line, and the card. Over COMMENT_MAX, the card leaves out its run log, then its per-stage list, then its cost
 * chart; with no summary that fits (summaryMarker null), or a body still over COMMENT_MAX with it, it goes without it.
 */
export function finishCardBody(d) {
  const summary = summaryMarker(d);
  const head = (withSummary) => [finishMarker(d.issue), ...(withSummary && summary ? [summary] : []), finishEndMarker(d)].join("\n");
  for (const fit of [{}, { log: false }, { log: false, list: false }, { log: false, list: false, chart: false }]) {
    const body = `${head(true)}\n${renderFinishCard(d, fit)}`;
    if (body.length <= COMMENT_MAX) return body;
  }
  return `${head(false)}\n${renderFinishCard(d, { log: false, list: false, chart: false })}`;
}
const usdOf = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);
const countOf = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : undefined);
const whyRead = (v) => (Array.isArray(v) && v.every((w) => typeof w === "string" && Object.hasOwn(UNKNOWN_WHY, w)) ? [...new Set(v)].sort() : undefined);
const timeOf = (v) => (typeof v === "string" && Number.isFinite(Date.parse(v)) ? v : undefined);
const billingOf = (v) => (v && typeof v === "object" && !Array.isArray(v) && Object.entries(v).every(([k, n]) => BILLING.includes(k) && usdOf(n) !== undefined) ? { ...v } : undefined);
const tokensRead = (t) => (t && typeof t === "object" && !Array.isArray(t) && Object.keys(zeroTokens()).every((k) => t[k] === undefined || t[k] === null || countOf(t[k]) !== undefined) ? tokensOf(t) : undefined);
const COST_KEYS = [...BILLING, "sandbox"];
/** A report cost ({usd: {kind: dollars}, unknownRuns, unknownWhy}, pass-figures.mjs zeroCost) read back, or undefined. */
const costRead = (c) => {
  const unknownWhy = whyRead(c?.unknownWhy ?? []);
  const runs = countOf(c?.unknownRuns ?? 0);
  if (!c?.usd || typeof c.usd !== "object" || Array.isArray(c.usd) || !Object.keys(c.usd).every((k) => COST_KEYS.includes(k) && usdOf(c.usd[k]) !== undefined) || runs === undefined || !unknownWhy) return undefined;
  return { usd: Object.fromEntries(COST_KEYS.map((k) => [k, c.usd[k] ?? 0])), unknownRuns: runs, unknownWhy };
};
const KIND = /^(?:[a-z][a-z0-9-]{0,60})$/;
/** A stage's passes by kind (pass-figures.mjs stagePassFigures) read back, or undefined for a broken one. */
const passesRead = (list) => {
  if (!Array.isArray(list)) return undefined;
  const out = list.map((k) => {
    const cost = costRead(k?.cost);
    const tokens = tokensRead(k?.tokens);
    const priced = k?.priced ?? { minutes: 0, passes: 0, cost: { usd: {} } };
    const pricedCost = costRead(priced.cost);
    const minutes = k?.minutes ?? null;
    const harnessMinutes = k && Object.hasOwn(k, "harnessMinutes") ? k.harnessMinutes : minutes;
    const unpriced = countOf(k?.unpriced ?? 0);
    const untimed = countOf(k?.untimed ?? 0);
    const cache = k?.cache === undefined ? null : ["passes", "written", "input"].every((f) => countOf(k.cache?.[f]) !== undefined) ? { passes: k.cache.passes, written: k.cache.written, input: k.cache.input } : undefined;
    if (typeof k?.kind !== "string" || !KIND.test(k.kind) || countOf(k.passes) === undefined || !cost || !tokens || (minutes !== null && usdOf(minutes) === undefined) || cache === undefined || !pricedCost || usdOf(priced.minutes) === undefined || countOf(priced.passes) === undefined || unpriced === undefined || untimed === undefined || (harnessMinutes !== null && usdOf(harnessMinutes) === undefined)) return null;
    return { kind: k.kind, passes: k.passes, cost, tokens, minutes, harnessMinutes, cache, untimed, priced: { minutes: priced.minutes, passes: priced.passes, cost: pricedCost }, unpriced };
  });
  return out.includes(null) ? undefined : out;
};
/** The kinds of wait a summary names (finishData's holds): what recorded it. */
export const WAIT_KINDS = Object.freeze(["blocked-by", "blocked", "question", "paused"]);
const BLOCKER = new RegExp(`^(?:${OWNER}/[A-Za-z0-9._-]{1,100})?#[1-9]\\d{0,15}$`);
/**
 * A summary's waits read back (#614): each {kind (WAIT_KINDS), why (WAIT_WHY, or null), start, end, blockers (a blocked-by
 * wait's issues, "#12" or "owner/name#12")}. Null for a card written before waits were recorded, undefined for a broken list.
 */
const waitsRead = (list) => {
  if (list === undefined) return null;
  if (!Array.isArray(list)) return undefined;
  const out = list.map((w) => {
    const start = timeOf(w?.start);
    const end = timeOf(w?.end);
    const blockers = w?.blockers === undefined ? [] : Array.isArray(w.blockers) && w.blockers.every((b) => typeof b === "string" && BLOCKER.test(b)) ? w.blockers : null;
    if (!start || !end || !(Date.parse(end) >= Date.parse(start)) || !WAIT_KINDS.includes(w.kind) || (w.why !== null && !WAIT_WHY.includes(w.why)) || !blockers) return null;
    return { kind: w.kind, why: w.why, start, end, ...(blockers.length ? { blockers: [...blockers] } : {}) };
  });
  return out.includes(null) ? undefined : out;
};
/** A summary's money fields read back, or undefined for a broken one. */
const moneyRead = (r, { nullable = false } = {}) => {
  const usd = nullable && r?.usd === null ? null : usdOf(r?.usd);
  const unknown = countOf(r?.unknown);
  const cents = r?.cents === null ? null : countOf(r?.cents);
  const byBilling = billingOf(r?.byBilling ?? {});
  return [usd, unknown, cents, byBilling].includes(undefined) ? undefined : { usd, cents, unknown, byBilling };
};

/**
 * The summary in a finish card comment's `body` for Objective `n` (summaryMarker), read back: only a marker of this
 * SUMMARY_VERSION for this issue whose every figure has its type, else null (a reader then reads the stages). Whose
 * comment it is, is the caller's to check: the marker counts only on Pendulum's own (pendulumOwn).
 */
export function readSummary(body, n) {
  // Only on the line under the card's `finish` marker, where finishCardBody writes it.
  const [head, second] = String(body ?? "").split("\n", 2);
  if (head !== finishMarker(n)) return null;
  const m = new RegExp(`^<!-- pendulum:${n}:summary (\\{[^\\n]*\\}) -->$`).exec(second ?? "");
  if (!m) return null;
  let v;
  try {
    v = JSON.parse(m[1]);
  } catch {
    return null;
  }
  if (!v || v.v !== SUMMARY_VERSION || v.issue !== n || !Array.isArray(v.stages) || !Array.isArray(v.prs)) return null;
  // A card on an end other than a merge (#589) is no merged Objective's summary: its stages are read instead.
  if (v.end !== undefined && v.end !== "merged") return null;
  const cost = moneyRead(v.cost);
  const why = whyRead(v.cost?.why);
  const sandbox = v.sandbox === null ? null : moneyRead(v.sandbox);
  const sandboxWhy = v.sandbox === null ? [] : whyRead(v.sandbox?.why);
  const foreign = v.sandbox === null ? [] : Array.isArray(v.sandbox?.foreign) && v.sandbox.foreign.every((k) => k === "work" || k === "review") ? v.sandbox.foreign : undefined;
  const stages = v.stages.map((s) => {
    const money = moneyRead(s, { nullable: true });
    const stageWhy = whyRead(s?.why);
    const own = s?.sandbox === null || s?.sandbox === undefined ? null : moneyRead({ ...s.sandbox, cents: null });
    const tokens = tokensRead(s?.tokens);
    const passes = s?.passes === null ? null : passesRead(s?.passes);
    if (!money || !stageWhy || own === undefined || !tokens || passes === undefined || !STAGE_KINDS.has(s.kind) || (s.key !== null && !/^[A-Za-z0-9:-]{1,100}$/.test(String(s.key))) || !countOf(s.part) || (s.model !== null && modelId(s.model) === null) || (s.harness !== null && !HARNESSES.has(s.harness)) || (s.version !== null && !VERSION.test(String(s.version))) || (s.ms !== null && countOf(s.ms) === undefined)) return null;
    return { kind: s.kind, key: s.key, part: s.part, model: s.model, harness: s.harness, version: s.version, ms: s.ms, ...money, why: stageWhy, sandbox: own ? { usd: own.usd, unknown: own.unknown } : null, churn: Array.isArray(s.churn) ? s.churn.filter((c) => Object.hasOwn(CHURN, c)) : [], tokens, passes, ...(s.noPass === true ? { noPass: true } : {}), ...(s.unattributed === true ? { unattributed: true } : {}) };
  });
  const asked = (Array.isArray(v.asked) ? v.asked : []).map((r) => {
    const money = moneyRead(r, { nullable: true });
    return money && [...PASS_KEYS, "sandbox"].includes(r.what) ? { part: countOf(r.part) ?? null, what: r.what, ...money } : null;
  });
  const churn = (Array.isArray(v.churn) ? v.churn : []).map((r) => {
    const money = moneyRead(r, { nullable: true });
    return money && Object.hasOwn(CHURN, r.row) && countOf(r.stages) !== undefined ? { row: r.row, stages: r.stages, ...money } : null;
  });
  const started = timeOf(v.started);
  const merged = timeOf(v.merged);
  // The waits (#614): null on a card from before they were recorded, as are its two parts of the wall clock; a broken
  // list reads as none recorded, never as no wait.
  const waits = waitsRead(v.waits) ?? null;
  if (!cost || !why || sandbox === undefined || !sandboxWhy || !foreign || [...stages, ...asked, ...churn].includes(null) || !started || !merged || !v.prs.every((p) => countOf(p))) return null;
  const counts = v.stageCounts && typeof v.stageCounts === "object" ? v.stageCounts : {};
  const passes = v.passes && ["total", "answer", "fix"].every((f) => countOf(v.passes[f]) !== undefined) ? { total: v.passes.total, answer: v.passes.answer, fix: v.passes.fix } : null;
  // Its decision records, apart from its passes (#617). A card from before they were counted apart has no such field and
  // counted them in `passes.total`: they are taken back out of it from its stages' passes, which hold each decision
  // record by kind. Such a card written with no stage's passes (summaryMarker's short form) cannot say how many of its
  // total they are: its total stays as written and `decisionRecords` is undefined, never 0.
  let decisionRecords = null;
  if (passes && Object.hasOwn(v, "decisionRecords")) decisionRecords = countOf(v.decisionRecords) ?? null;
  else if (passes && stages.every((s) => s.passes)) {
    decisionRecords = stages.reduce((t, s) => t + s.passes.filter((k) => k.kind === "decision").reduce((n, k) => n + k.passes, 0), 0);
    passes.total = Math.max(0, passes.total - decisionRecords);
  } else if (passes) decisionRecords = undefined;
  return {
    v: v.v,
    pendulum: typeof v.pendulum === "string" && /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:[-+][A-Za-z0-9.-]{1,40})?$/.test(v.pendulum) ? v.pendulum : null,
    issue: n,
    started,
    merged,
    wallMs: countOf(v.wallMs) ?? null,
    workMs: waits ? (countOf(v.workMs) ?? null) : null,
    waitMs: waits ? (countOf(v.waitMs) ?? null) : null,
    waits,
    prs: v.prs,
    commits: countOf(v.commits) ?? null,
    additions: countOf(v.additions) ?? null,
    deletions: countOf(v.deletions) ?? null,
    files: countOf(v.files) ?? null,
    checks: v.checks && countOf(v.checks.passed) !== undefined && countOf(v.checks.failed) !== undefined ? { passed: v.checks.passed, failed: v.checks.failed, required: v.checks.required === true } : null,
    reviews: v.reviews && countOf(v.reviews.count) !== undefined && countOf(v.reviews.findings) !== undefined ? { count: v.reviews.count, findings: v.reviews.findings } : null,
    stageCounts: { work: countOf(counts.work) ?? 0, rebase: countOf(counts.rebase) ?? 0, review: countOf(counts.review) ?? 0 },
    passes,
    decisionRecords,
    modelMinutes: usdOf(v.modelMinutes) ?? null,
    tokens: tokensRead(v.tokens ?? {}) ?? zeroTokens(),
    labelled: timeOf(v.labelled) ?? null,
    labelledWallMs: countOf(v.labelledWallMs) ?? null,
    // Why its wall clock is not known, as the card records it (#587): `renamed`, else null; undefined on a card from before
    // it recorded the reason, whose reader checks the issue's timeline itself.
    clockWhy: !Object.hasOwn(v, "clockWhy") ? undefined : CLOCK_WHY.includes(v.clockWhy) ? v.clockWhy : null,
    cost: { ...cost, why },
    sandbox: sandbox ? { usd: sandbox.usd, cents: sandbox.cents, unknown: sandbox.unknown, why: sandboxWhy, foreign: [...foreign] } : null,
    stages,
    asked,
    churn,
  };
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
 * (GitHub's 5xx, its rate limit, the network: a later tick tries again). Past it, the tidy goes on without the card:
 * half the Done pass's 48-hour window, so the label never outlives the window that clears it.
 */
export const FINISH_RETRY_MS = 24 * 3600_000;

/** The card's marker: one card per Objective. */
export const finishMarker = (n) => marker(n, "finish");

/**
 * The usage records of an Objective's stages asked for (`want`, each {stage, key}: unlinedStages, and on the finish card
 * modellessStages too): of its `pendulum-usage-<n>` (work) and `pendulum-usage-<n>-review` artifacts (the job token's actions: read; a token that
 * may not read them reads none), only those of a stage asked for whose workflow run is the stage's own, its id the
 * progress key's run (`<run id>` or `<run id>-<attempt>`), and only a run of this repository on this repository's own
 * code: a run whose head repository is another (a fork's pull request, which can upload any artifact under any name) or
 * that names none is never read. Each record carries its artifact's name, so it counts only for its own stage
 * (artifactStage). An artifact that cannot be downloaded is no record: its stage shows as unknown. `download(artifact)`
 * reads one's result.json (github.mjs downloadArtifactResult). Nothing is read when no stage is asked for.
 */
export async function objectiveRecords(repo, n, { token, download, want = [] }) {
  const out = [];
  for (const [stage, name] of [["work", `pendulum-usage-${n}`], ["review", `pendulum-usage-${n}-review`]]) {
    const runs = new Set(want.filter((w) => w.stage === stage).map((w) => /^(\d{1,20})(?:-\d{1,3})?$/.exec(w.key)?.[1]).filter(Boolean).map(Number));
    if (!runs.size) continue;
    // A token that may not read artifacts (403, 404) reads none; any other failure throws, for a later tick to read again.
    const page = await rest(`repos/${repo.full}/actions/artifacts?name=${encodeURIComponent(name)}&per_page=100`, { token }).catch((e) => {
      if (e?.status === 403 || e?.status === 404) return null;
      throw e;
    });
    for (const a of page?.artifacts || []) {
      const run = a.workflow_run;
      if (a.expired || a.name !== name || !Number.isSafeInteger(run?.id) || !runs.has(run.id)) continue;
      // A fork's run can upload an artifact of this name: only this repository's own runs are read (ownRunArtifact).
      if (!ownRunArtifact(a)) continue;
      const rec = await download(a).catch(() => null);
      if (rec && typeof rec === "object") out.push({ ...rec, artifact: name });
    }
  }
  return out;
}

/**
 * Post or update the finish card of Objective `issue` ({number, labels, user, state, closed_at}): one card per Objective
 * (its `finish` marker, by Pendulum itself, pendulumOwn), written in place as the run ends again (#589).
 * - A closed Objective (the dispatcher's Done pass, `end` null): merged when the newest PR on its branch merged
 *   (wait.mjs closedAs), else closed without merging, at its close.
 * - `end` ({kind: blocked or question, at, reason, form, next}): a Block or a Question applied (session.mjs applyExit).
 *   Its PRs are the run's own: those merged since its clock (a split Objective's earlier parts) and the newest unmerged
 *   one; a PR merged before the clock (a reopened Objective's) is no part of it.
 * A card that shows a merge stays as it is ("had"): a merge is final, and a reopened Objective merged again gets no second
 * card. A card of a close stays for the same close, and is written again for a later one. A Blocked or Question card is
 * written again with the new end, never over a card of a later end. The card is read again just before the write, so a
 * write that raced another (two routes, a stage and the Done pass) never puts an older end over a newer one; when it
 * finds more than one card of Pendulum's, it writes the first and deletes the rest. With `prBody` (not when Pendulum acts
 * under a person's login), a merged card's PR gets the headline block at the top of its body first, read just before it
 * is written; a refusal of that write (not a passing failure) leaves the PR as it is and the card is still written.
 * Returns "posted", "updated", "had", "nothing ran" (no stage and no PR: nothing to show), or "no self" (Pendulum's own
 * login unknown, so no marker can be trusted). `records(n, want)`: the usage records (objectiveRecords) of its stages
 * with no spend line, for their dollars, and of its stages whose harness line names no model, for their model; read
 * only when there is such a stage. A failed read or write throws.
 */
export async function postFinishCard(repo, issue, opts, { records = async () => [], label = OBJECTIVE, prBody = true, appId = null, log = () => {}, end = null } = {}) {
  const n = issue.number;
  if (!selfLogin()) await primeSelf(opts);
  if (!selfLogin()) return "no self";
  const branch = (await rest(`repos/${repo.full}/pulls?state=all&head=${encodeURIComponent(`${repo.owner}:pendulum/${n}`)}&sort=created&direction=desc&per_page=20`, opts)) || [];
  // How the run ended: a Block or a Question applied; else, closed, merged when the newest PR on its branch merged.
  const merged = !end && !!branch[0]?.merged_at;
  const ending = end ? end : merged ? null : { kind: "closed", at: issue.closed_at };
  const comments = await listComments(repo, n, opts);
  // Whose comments are by someone who can push, taken as listComments verified them (github.mjs verifyAuthors): a
  // permission read's answer counts for a window (logic.mjs VERIFIED_TTL_MS) that may end during the reads below.
  const pushers = new Set(comments.filter((c) => githubWriter(c)));
  const pushed = (c) => pushers.has(c) || throughApp(c);
  const timeline = (await rest(`repos/${repo.full}/issues/${n}/timeline?per_page=100`, { ...opts, paginate: true })) || [];
  // Pendulum's own comments only (pendulumOwn): its login here, or its App by id.
  const mine = pendulumOwn(appId);
  const cardsOf = (list) => list.filter((c) => mine(c) && (c.body || "").startsWith(finishMarker(n))).sort((a, b) => ms(a.created_at) - ms(b.created_at) || a.id - b.id);
  // Whether a card already there stands: a merge is final; a close stays for the same close or a later one; a Block or
  // Question card stands over an older end of this kind.
  const stands = (had) => !!had && (had.end === "merged" || (had.end === "closed" && ending?.kind === "closed" && (!had.at || ms(had.at) >= ms(ending.at))) || (ending && had.end !== "closed" && !!had.at && ms(had.at) > ms(ending.at)));
  if (stands(cardsOf(comments)[0] && finishEndOf(cardsOf(comments)[0].body, n))) return "had";
  const window = objectiveWindow(comments.filter((c) => mine(c)), timeline);
  const started = labelTime(issue, timeline, label, window, { comments, mine }) ?? window;
  // The PRs to read whole: the Objective's merged PRs since its clock (a split Objective's parts), oldest first; at another
  // end, then, the newest unmerged one on its branch.
  const sinceClock = (p) => !started || ms(p.merged_at) >= ms(started);
  const prs = branch.filter((p) => p.merged_at);
  const parts = prs.filter(sinceClock).sort((a, b) => ms(a.merged_at) - ms(b.merged_at));
  // The run's own open or closed PR: one opened since the clock, never an older one left from before a restart.
  const unmerged = branch.find((p) => !p.merged_at && (!started || ms(p.created_at) >= ms(started)));
  const reads = merged ? (parts.length ? parts : prs.slice(0, 1)) : [...parts, ...(unmerged ? [unmerged] : [])];
  const pulls = [];
  for (const p of reads) {
    const [pr, t, reviews, reviewComments] = await Promise.all([getPr(repo, p.number, opts), rest(`repos/${repo.full}/issues/${p.number}/timeline?per_page=100`, { ...opts, paginate: true }), rest(`repos/${repo.full}/pulls/${p.number}/reviews?per_page=100`, { ...opts, paginate: true }), listReviewComments(repo, p.number, opts)]);
    pulls.push({ pr, timeline: t || [], reviews: reviews || [], reviewComments });
  }
  const last = pulls.at(-1);
  // The checks that gated the merge: the merge queue's, on the merge commit it made; without a queue, the head's.
  let checks = [];
  let required = [];
  if (merged) {
    const queued = (last.timeline || []).some((e) => e.event === "added_to_merge_queue");
    const gateSha = queued && last.pr.merge_commit_sha ? last.pr.merge_commit_sha : last.pr.head?.sha;
    checks = gateSha ? await checkRuns(repo, gateSha, opts, { all: true }) : [];
    // The required checks, when the repository's rules can be read (a token that may not read them counts every check).
    required = await requiredCheckSpecs(repo, opts).catch((e) => {
      if (transientError(e)) throw e;
      return [];
    });
  }
  // The usage artifacts of the stages with no spend line of their own (their dollars) or whose harness line names no
  // model (their model), and only theirs.
  const since = comments.filter((c) => ms(c.created_at) >= ms(started));
  const unlined = unlinedStages(since, n, mine);
  const want = [...unlined, ...modellessStages(since, n, mine).filter((w) => !unlined.some((u) => u.stage === w.stage && u.key === w.key))];
  // The issues the timeline says blocked this one before its first stage (#614: the first progress comment of the run,
  // Pendulum's or one by someone who can push), each read once for its close, together: one GitHub will not show (403,
  // 404, 410: another repository's, or one deleted) is left out, and its wait is then not shown; a rate limit or any
  // other failure throws, for a later write to read again.
  const stageAt = new RegExp(`^<!-- pendulum:${n}:progress:(?:work|review):`);
  const firstStage = since.filter((c) => (mine(c) || pushed(c)) && stageAt.test(c.body || "")).map((c) => c.created_at).sort((a, b) => ms(a) - ms(b))[0];
  const blockers = (
    await Promise.all(
      blockersToRead(repo.full, timeline, firstStage).map(async (b) => {
        const read = await rest(`repos/${b.repo}/issues/${b.number}`, opts).catch((e) => {
          if (!e?.rateLimited && [403, 404, 410].includes(e?.status)) return null;
          throw e;
        });
        return read ? { repo: b.repo, number: b.number, state: read.state, closed_at: read.closed_at ?? null } : null;
      }),
    )
  ).filter(Boolean);
  const d = finishData({ repo: repo.full, issue, timeline, comments, pulls, checks, required, records: want.length ? await records(n, want) : [], blockers, label, mine, pushed, end: ending });
  if (!d) return "nothing ran";
  if (!merged && !d.stages.length && !d.prs.length) return "nothing ran";
  const body = finishCardBody(d);
  // Read again just before the write: a card another writer wrote meanwhile decides as one there from the start.
  const now = cardsOf(await listComments(repo, n, opts));
  if (stands(now[0] && finishEndOf(now[0].body, n))) return "had";
  if (merged && prBody) {
    const pr = await getPr(repo, last.pr.number, opts);
    await updatePr(repo, last.pr.number, { body: withFinishBlock(pr.body, d) }, opts).catch((e) => {
      if (transientError(e)) throw e;
      log(`  #${n}: PR #${last.pr.number}'s body was not updated (${Number.isInteger(e?.status) ? `HTTP ${e.status}` : "error"}); the card is posted without it`);
    });
  }
  if (!now.length) {
    await rest(`repos/${repo.full}/issues/${n}/comments`, { ...opts, method: "POST", body: { body } });
    return "posted";
  }
  await rest(`repos/${repo.full}/issues/comments/${now[0].id}`, { ...opts, method: "PATCH", body: { body } });
  // Two writers that both found none posted one each: the first stays, the rest go.
  for (const extra of now.slice(1)) await rest(`repos/${repo.full}/issues/comments/${extra.id}`, { ...opts, method: "DELETE" }).catch((e) => log(`  #${n}: a second finish card (${extra.id}) was not deleted (${Number.isInteger(e?.status) ? `HTTP ${e.status}` : "error"})`));
  return "updated";
}

/** How long a Block's or a Question's card may take before its caller goes on without it (endCard). */
export const END_CARD_MS = 20_000;

/**
 * The finish card of a Block or a Question applied (#589; session.mjs applyExit, in a stage or outside one): `exit`
 * (blocked or question), its `reason`, a Question's `form` (logic.mjs questionForm), a Block's way on (`next`: session.mjs
 * nextStep's code). `issue`: the issue object, or its number (then read here, one call). Bounded by `timeoutMs`: past it
 * the caller goes on and the card's own writes finish or fail by themselves. Never throws: a card that cannot be written
 * is logged, and the Blocked or Question notice stands alone. Returns postFinishCard's answer, "timed out", "no end" (an
 * exit that gets no card here), or the error.
 */
export async function endCard(repo, issue, opts, { exit, reason = "", form = null, next = null, appId = null, log = () => {}, timeoutMs = END_CARD_MS, now = Date.now() } = {}) {
  if (exit !== "blocked" && exit !== "question") return "no end";
  const number = typeof issue === "object" && issue ? issue.number : Number(issue);
  const fail = (e) => {
    log(`  #${number}: its ${exit === "blocked" ? "Blocked" : "Question"} card was not written (${String(e?.message || e).slice(0, 120)})`);
    return e;
  };
  let timer;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => {
      log(`  #${number}: its ${exit === "blocked" ? "Blocked" : "Question"} card took over ${Math.round(timeoutMs / 1000)} s; going on without waiting for it`);
      resolve("timed out");
    }, timeoutMs);
    timer.unref?.();
  });
  const work = (async () => {
    const data = typeof issue === "object" && issue ? issue : await rest(`repos/${repo.full}/issues/${number}`, opts);
    return postFinishCard(repo, data, opts, { prBody: false, appId, log, end: { kind: exit, at: new Date(now).toISOString(), reason, form, next } });
  })().catch(fail);
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}
