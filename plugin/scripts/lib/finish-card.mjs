// The finish card (#498, #589): when an Objective's run ends (merged, Blocked, on a Question, closed without merging), one
// comment on its issue says what happened, how long it took, what it cost and who did what, built only from what GitHub
// and Pendulum's own records hold. Text only (no image): a two-line headline block, the action lines of a Blocked or
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
import { DRAFT_LABEL } from "./stop.mjs";
import { DEFAULTS } from "./inputs.mjs";
import { clockText, objectiveZone, timeZone, zoneDay, zoneOffsetMs } from "./clock.mjs";
import { stageHarnessOf } from "./cost-join.mjs";
import { addTokens, isAnswer, isFix, stagePassFigures, zeroTokens } from "./pass-figures.mjs";
import { checkRuns, getPr, listComments, listReviewComments, ownRunArtifact, primeSelf, requiredCheckSpecs, rest, transientError, updatePr } from "./github.mjs";
import { RUNNING_LABEL, STATE_LABELS, bodyFindings, decisionSpendEntries, isPlaceholder, isSelf, ledgerOfComment, marker, pushAuthor, rebaseCostOf, restartedAt, selfLogin, spendParts } from "./logic.mjs";
import { pendulumNotice } from "./answer-check.mjs";
import { BASIS, BASIS_NOTE, COLORS, MARK_URL, badge, basisText, billingBasis, billingWords, causeSentences, cellCost, centsOf, costChart, costText, durationText, ganttChart, kindsOf, many, modelId, modelName, plainText, tableCell } from "./card-kit.mjs";

// The shared look's helpers this module has always exported (card-kit.mjs holds them now).
export { COLORS, MARK_URL, badge, billingBasis, billingWords, centsOf, costText, durationText, modelName };
import { PREVIOUS_NAME } from "./local.mjs";
import { BILLING, BILLING_WORDS, PASS_KEYS, UNKNOWN_WHY, addBilling, billingRead, passRead, rerunRead, unknownRuns } from "./usage.mjs";

const OBJECTIVE = DEFAULTS.objective_label;
const ms = (at) => (typeof at === "number" ? at : at ? Date.parse(at) : NaN);
// The conclusions of a check run that failed (skipped and neutral are neither green nor red).
const RED = new Set(["failure", "timed_out", "cancelled", "action_required", "stale", "startup_failure"]);
const num = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
// GitHub stamps its timeline to the second: the merge queue's own removal of the PR it merges can carry the second before.
const SECOND = 1000;


/**
 * The Objective's clock, as the scorecard starts it (bench/lib/objective.mjs reads it from here): its first
 * `pendulum:objective` label at or after `clockAfter`, or the first time Pendulum picked it up (its Running label) if
 * that came first, so a recovery's re-applied label is never mistaken for its start. A draft's clock is the last of its
 * label's applications and its draft label's removals before Pendulum first picked it up. Null with neither label event.
 */
export function labelTime(issue, timeline, label = OBJECTIVE, clockAfter = null) {
  const floor = clockAfter ? ms(clockAfter) : Number.NEGATIVE_INFINITY;
  const events = (timeline || []).filter((e) => e.event === "labeled" && (e.label?.name === label || e.label?.name === RUNNING_LABEL) && ms(e.created_at) >= floor).sort((a, b) => ms(a.created_at) - ms(b.created_at));
  const first = events[0]?.created_at ?? null;
  if (!first || !(timeline || []).some((e) => e.event === "labeled" && e.label?.name === DRAFT_LABEL)) return first;
  const running = events.find((e) => e.label?.name === RUNNING_LABEL)?.created_at ?? null;
  const starts = (timeline || []).filter((e) => ((e.event === "labeled" && e.label?.name === label) || (e.event === "unlabeled" && e.label?.name === DRAFT_LABEL)) && ms(e.created_at) >= ms(first) && (!running || ms(e.created_at) <= ms(running)));
  return starts.map((e) => e.created_at).sort((a, b) => ms(a) - ms(b)).at(-1) ?? first;
}

/**
 * Whether the issue's clock started before the rename to Pendulum (#567): a label event named exactly
 * `<previous name>:objective` or `<previous name>:running` (local.mjs PREVIOUS_NAME), the name GitHub keeps on the events
 * from before a label was renamed. Its wall clock is then not known: labelTime matches only the current names, so it would
 * start at a later label and come out short. Nothing else is read from those events.
 */
export const clockRenamed = (timeline) => (timeline || []).some((e) => (e?.event === "labeled" || e?.event === "unlabeled") && [`${PREVIOUS_NAME}:objective`, `${PREVIOUS_NAME}:running`].includes(e.label?.name));

/** Why a card's wall clock is not known (clockRenamed), as the card says it. */
export const RENAMED_CLOCK_WHY = "its wall clock is not known: it was labelled before the rename to Pendulum";

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
 * progress comment's run key, as its usage record and its findings name it)}, in time order; and the cloud sandbox's own cost
 * {usd, unknown}, every vendor comment's, or null: beyond its stages' own, the runs of unknown cost of vendor comments
 * Pendulum cannot attribute (sandboxWhy), whose stage kinds are `foreignVendors`, one per comment (a vendor comment of a
 * stage that has a progress comment, Pendulum's or not, is that stage's).
 */
export function objectiveStages({ issue: n, comments = [], records = [], mine = isSelf, pushed = (c) => pushAuthor(c) || throughApp(c), inRun = () => true, partOf = () => 1 }) {
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
    const s = { stage, rebase: !!rebase, conflict: !!rebase?.conflict, part: partOf(c.created_at), at: c.created_at, start: c.created_at, end: endOf(c), model: stageModel(c.body) ?? ledgerModel(c.body) ?? modelId(record?.model), harness, usd, unknown, why, byBilling: billingRead(from.usdByBilling), byPass: passRead(from.usdByPass), rerun: rerunRead(from.rerun), judgeOnly: from.judgeOnly === true, sandbox: null, ledger, version, tokens, key, ...(from.noPass === true ? { noPass: true } : {}) };
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
 * first label at or after it, and max_objective_usd counts from it.
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

/**
 * The run's Blocked and Question notices of Pendulum's own (`own`, in the run) and the time on hold after each (#589), from
 * their markers and times alone: a notice (session.mjs applyExit: `<!-- pendulum:<n>:blocked:… -->`, logic.mjs
 * questionMarker) marks the stage whose span holds it as ended that way (`stage.outcome`), and the hold runs from the
 * notice to the next stage's start. A notice no later stage follows has no recorded end: no hold. Notices inside a hold
 * already counted add none. Returns [{kind, start, end}], oldest first.
 */
function holdsOf(n, own, stages) {
  const kindOf = (body) => (new RegExp(`^<!-- pendulum:${n}:blocked:[^\\n]* -->`).test(body) ? "blocked" : new RegExp(`^<!-- pendulum:${n}:question:\\S*:(issue|pr) -->`).test(body) ? "question" : null);
  const notices = own.map((c) => ({ kind: kindOf(c.body || ""), at: noticeAt(c) })).filter((x) => x.kind).sort((a, b) => ms(a.at) - ms(b.at));
  const timed = stages.filter((s) => s.start);
  const holds = [];
  for (const x of notices) {
    const stage = timed.findLast((s) => ms(s.start) <= ms(x.at) && ms(x.at) <= ms(s.end));
    if (stage) stage.outcome = x.kind;
    if (holds.some((h) => ms(h.start) <= ms(x.at) && ms(x.at) < ms(h.end))) continue;
    const next = timed.find((s) => ms(s.start) > ms(x.at));
    if (next) holds.push({ kind: x.kind, start: x.at, end: next.start });
  }
  return holds;
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
 *  pushed       whose comments are by someone who can push (logic.mjs pushAuthor) or came through a GitHub App other than
 *               Actions (throughApp): a progress or vendor comment of theirs that is not Pendulum's is a stage of unknown
 *               cost (its time shown, never its figures)
 */
export function finishData({ repo, issue, timeline = [], comments = [], pulls = [], checks = [], required = [], records = [], label = OBJECTIVE, mine = isSelf, pushed = (c) => pushAuthor(c) || throughApp(c), end = null }) {
  const n = issue.number;
  const merged = pulls.filter((p) => p?.pr?.merged_at).sort((a, b) => ms(a.pr.merged_at) - ms(b.pr.merged_at));
  // An end other than a merge (#589: Blocked, a Question, closed without merging) is the caller's, at its recorded time.
  const other = !merged.length && end && ENDS.includes(end.kind) && Number.isFinite(ms(end.at)) ? end : null;
  if (!merged.length && !other) return null;
  const mergedAt = merged.at(-1)?.pr.merged_at ?? null;
  const endAt = mergedAt ?? new Date(ms(other.at)).toISOString();
  // The PRs the card names: the merged ones, else the newest the caller read on the Objective's branch (open, a draft, or
  // closed unmerged).
  const shown = merged.length ? merged : pulls.filter((p) => p?.pr?.number).slice(-1);
  // The clock: the first label at or after the run's last start over (a restart or a reopen), max_objective_usd's window too.
  const started = labelTime(issue, timeline, label, objectiveWindow(comments.filter((c) => mine(c)), timeline)) ?? shown[0]?.pr.created_at ?? endAt;
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

  // Who filed the issue, and who applied the label that started the clock (its latest application by then).
  const labelled = (timeline || []).filter((e) => e.event === "labeled" && e.label?.name === label && ms(e.created_at) <= ms(started)).sort((a, b) => ms(a.created_at) - ms(b.created_at)).at(-1);
  const sum = (k) => shown.reduce((s, p) => s + (Number.isInteger(p.pr[k]) ? p.pr[k] : 0), 0);
  const holds = holdsOf(n, own.filter((c) => inRun(noticeAt(c))), stages);
  const closer = (timeline || []).filter((e) => e.event === "closed").sort((a, b) => ms(a.created_at) - ms(b.created_at)).at(-1)?.actor?.login;
  return {
    repo,
    issue: n,
    author: login(issue.user?.login),
    labeller: login(labelled?.actor?.login),
    prs: shown.map((p) => ({ number: p.pr.number, url: p.pr.html_url ?? `https://github.com/${repo}/pull/${p.pr.number}`, opened: p.pr.created_at, merged: p.pr.merged_at ?? null, ours: mine(p.pr), draft: p.pr.draft === true, open: p.pr.state === "open" })),
    started,
    merged: mergedAt,
    // How the run ended (ENDS, `merged` for a merge) and when; a Blocked or Question end's reason, and a Question's form
    // (logic.mjs questionForm) and the PR it asks on.
    end: other ? other.kind : "merged",
    ended: endAt,
    reason: other?.reason ? String(other.reason) : null,
    form: other?.form === "pr" || other?.form === "issue" ? other.form : null,
    closer: login(closer),
    // Pendulum's Blocked and Question notices in the run, and the time on hold after each until the next stage started.
    holds,
    planned: own.some((c) => (c.body || "").startsWith(marker(n, "plan")) && inRun(c.created_at)),
    // The scorer's start of the clock: the first label with no restart window (labelTime), null with no label event.
    labelled: labelTime(issue, timeline, label),
    // Labelled before the rename to Pendulum: no wall clock (clockRenamed).
    clockRenamed: clockRenamed(timeline),
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
 * The totals the card shows: the wall clock (ms), the known dollars, the runs of unknown cost with their reason codes
 * (`why`) and the dollars by billing.
 */
export function finishTotals(d) {
  const usd = d.stages.reduce((s, x) => s + (x.usd ?? 0), 0) + (d.sandbox?.usd ?? 0);
  // No stage found at all: the run's cost was not read, so it is unknown, never $0.
  const unknown = d.stages.reduce((s, x) => s + (x.unknown || 0), 0) + (d.sandbox?.unknown ?? 0) + (d.stages.length ? 0 : 1);
  const why = [...new Set([...d.stages.flatMap((x) => (x.unknown ? x.why ?? [] : [])), ...sandboxWhy(d), ...(d.stages.length ? [] : ["no-record"])])].sort();
  return { wall: d.clockRenamed ? null : ms(d.ended ?? d.merged) - ms(d.started), usd: Math.round(usd * 1e6) / 1e6, unknown, why, byBilling: addBilling(...d.stages.map((s) => s.byBilling)) };
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
const once = (n, word) => (n === 1 ? `${word} once` : n === 2 ? `${word} twice` : `${word} ${n} times`);

/** The headline's figure: the known dollars and runs of unknown cost ("$3.67 + unknown", "unknown"), "so far" when not final. */
function headlineMoney(d, t) {
  const figure = t.usd === 0 && t.unknown > 0 ? "unknown" : cellCost(t.usd, t.unknown);
  return `${figure}${d.end === "blocked" || d.end === "question" ? " so far" : ""}`;
}

/** The headline (`### …`): the end, how long, what it cost. */
export function headline(d) {
  const t = finishTotals(d);
  const how = t.wall === null ? "" : ` ${d.end === "merged" ? "in" : "after"} ${durationText(t.wall)}`;
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
    const pr = d.prs[0];
    parts.push(`Issue #${d.issue}`);
    if (pr) parts.push(d.end === "closed" ? (pr.open ? `PR #${pr.number} still open` : `PR #${pr.number} closed, not merged`) : pr.draft ? `PR #${pr.number} is a draft` : `PR #${pr.number} is open`);
    const at = atOf(d, d.ended, { abbr: true });
    parts.push({ closed: `closed at ${at}`, blocked: `Blocked at ${at}`, question: `Question asked at ${at}` }[d.end]);
  }
  const basis = t.usd > 0 ? basisText(t.usd, t.byBilling) || BASIS.unknown : "";
  if (basis) parts.push(basis);
  if (t.unknown) parts.push(`plus ${many(t.unknown, "AI run")} of unknown cost`);
  if (t.wall === null) parts.push(`${RENAMED_CLOCK_WHY[0].toUpperCase()}${RENAMED_CLOCK_WHY.slice(1)}`);
  return parts.join(" · ");
}

/** The headline's third line, when the run waited on a person: how long it was on hold, and why. */
function holdLine(d) {
  const holds = d.holds ?? [];
  if (!holds.length) return null;
  const held = holds.reduce((n, h) => n + (ms(h.end) - ms(h.start)), 0);
  const blocked = holds.filter((h) => h.kind === "blocked").length;
  const questions = holds.filter((h) => h.kind === "question").length;
  if (holds.length === 1) return `${blocked ? "Blocked once" : "Asked a Question once"}: ${durationText(held)} on hold, waiting for you.`;
  const ran = d.stages.filter((s) => s.start).reduce((n, s) => n + (ms(s.end) - ms(s.start)), 0);
  const why = [...(blocked ? [once(blocked, "Blocked")] : []), ...(questions ? [many(questions, "Question")] : [])].join(", ");
  return `Stages ran for ${durationText(ran)} in all; ${durationText(held)} on hold (${why}).`;
}

/** The action lines of a Blocked or a Question card: what to do, then why. */
function actionLines(d) {
  const first = (r) => plainText(String(r ?? "").replace(/^question:\s*/i, "").split(/(?<=[.!?])\s/)[0].slice(0, 300));
  if (d.end === "blocked") return ["> **What to do:** fix the cause below, then re-apply the `pendulum:objective` label. The Blocked notice on this issue has the full steps.", ">", `> **Why:** ${first(d.reason)}`];
  if (d.end === "question") {
    const pr = d.prs[0];
    const todo = d.form === "pr" && pr ? `answer in a comment on this issue or PR #${pr.number}, then mark PR #${pr.number} ready. Pendulum goes on from where it stopped.` : "answer the question in a comment on this issue. Pendulum goes on from where it stopped.";
    return [`> **What to do:** ${todo}`, ">", `> **Question:** ${plainText(String(d.reason ?? "").replace(/^question:\s*/i, "").slice(0, 300))}`];
  }
  return [];
}

/** Who did what, and what Pendulum did, in plain sentences: only what the records say. */
export function summary(d) {
  const person = d.author && d.labeller ? (d.author === d.labeller ? "You wrote the issue and added the label." : `**${d.author}** wrote the issue and **${d.labeller}** added the label.`) : d.author ? `**${d.author}** wrote the issue.` : "";
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
  const list = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}` : xs[0]);
  const theirs = ours || !d.prs.length ? "" : ` ${prList(d.prs)} ${d.prs.length === 1 ? "has" : "have"} **${change}**.`;
  let pendulum;
  if (d.end === "merged") {
    const how = d.queue.some((q) => q.merged) ? "it merged through your merge queue" : "it merged";
    pendulum = did.length ? `Pendulum ${did.join(", ")}, and ${how}.` : `${how[0].toUpperCase()}${how.slice(1)}.`;
  } else if (d.end === "closed") {
    const who = d.closer && d.closer === d.author && d.author === d.labeller ? "you closed the issue" : d.closer ? `**${d.closer}** closed the issue` : "the issue was closed";
    pendulum = did.length ? `Pendulum ${list(did)}; ${who} before it merged.` : `${who[0].toUpperCase()}${who.slice(1)} before it merged.`;
  } else pendulum = `Pendulum ${did.length ? `${did.join(", ")}, and ` : ""}${d.end === "blocked" ? "is Blocked" : "asked a Question"}.`;
  return `${person ? `${person} ` : ""}${pendulum}${theirs}`;
}

// ------------------------------------------------------------------ timeline and stage table

/** A stage's name in the table, the chart and the log, numbered (`n`) when its name repeats. */
const stageName = (s, planned) => ({ build: planned ? "Plan + build" : "Build", part: `Part ${s.part}`, work: "Work", rebase: "Rebase", review: "Review" })[s.kind];
/** The same, short, for a timeline row (Mermaid section names: short, so the stock themes' margin fits them). */
const rowName = (s) => ({ build: "Build", part: `Part ${s.part}`, work: "Work", rebase: "Rebase", review: "Review" })[s.kind];
/** A stage's result words in the table, when it ended Blocked or on a Question. */
const OUTCOME = Object.freeze({ blocked: "⛔ Blocked", question: "❓ Question" });

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

/** The timeline chart (card-kit.mjs ganttChart): stages amber, a Blocked or Question stage red with its word, time on hold grey. */
function gantt(d, rows) {
  const drawn = rows.filter((r) => r.start);
  if (!drawn.length) return null;
  if (drawn.length > TABLE_ROWS) return `Timeline chart left out: ${many(drawn.length, "row")}; the table has every figure.`;
  return ganttChart(
    drawn.map((r) => ({ section: r.short, bars: [{ start: ms(r.start), end: ms(r.end), tag: r.kind === "hold" ? "done" : r.stage?.outcome ? "crit" : "active", label: r.stage?.outcome ? { blocked: "Blocked", question: "Question" }[r.stage.outcome] : "" }] })),
    { zone: zoneOf(d), days: spansDays(d) },
  );
}

/** A stage row's cost cell: its cents and runs of unknown cost, "unknown" with no known figure. */
const stageCost = (r) => (r.usd === null ? "unknown" : cellCost(r.usd > 0 && !r.cents ? r.usd : (r.cents ?? 0) / 100, r.unknown));

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
      lines.push({ at: r.start, name: `${r.name} · waiting for you`, took: ms(r.end) - ms(r.start), cost: "—" });
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
    if (!l.stage) return `| ${atOf(d, l.at)} | ${l.name} | ${durationText(l.took)} | ${l.cost} |`;
    const name = `${l.base}${l.n > 1 ? ` ×${l.n}` : ""}${l.stage.model ? ` · ${modelName(l.stage.model)}` : ""}${l.stage.outcome ? ` · ${OUTCOME[l.stage.outcome]}` : ""}`;
    return `| ${l.at ? atOf(d, l.at) : "—"} | ${tableCell(name)} | ${l.took === null ? "—" : durationText(l.took)} | ${stageCost(l)} |`;
  });
  if (!d.stages.length) out.push(`| — | Pendulum's stages, no record found | — | unknown |`);
  if (d.sandbox) out.push(`| — | Cloud sandbox | — | ${stageCost(costs.at(-1))} |`);
  if (d.queue.length) {
    const queued = d.queue.reduce((n, q) => n + (ms(q.end) - ms(q.start)), 0);
    out.push(`| ${atOf(d, d.queue[0].start)} | Merge queue${d.queue.length > 1 ? ` ×${d.queue.length}` : ""} · your CI | ${durationText(queued)} | — |`);
  }
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
const ASKED = Object.freeze({ work: "Work", review: "Review", answer: "Answering the review", fix: "Fixing CI", decision: "AI judge calls" });
/** The churn the breakdown names apart (markChurn), in its order. */
const CHURN = Object.freeze({
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

/** The notes line under the money: what the bars show and what they leave out. */
function notesLine(t, b, drawn) {
  const none = [...b.asked, ...b.churn].filter((r) => r.usd === null).map((r) => r.name);
  const unknown = t.unknown ? `; ${many(t.unknown, "AI run")} of unknown cost ${t.unknown === 1 ? "is" : "are"} not drawn` : "";
  const named = none.length ? ` ${none.join(", ")} ${none.length === 1 ? "has" : "have"} no recorded dollars.` : "";
  return drawn ? `Bars show recorded dollars only${unknown}.${named} CI minutes are not included.` : "CI minutes are not included.";
}

/** How overhead is counted, for Run details. */
const OVERHEAD_NOTE = "Each item comes from a stage's own record, never a guess. A stage is in the part after the PRs merged before it started; its runs are split by the kinds its spend record names. Overhead is a rebase after other PRs merged (its rebase line), a catch-up run after the default branch changed a workflow, the runs a stage records it ran again after a Block, and a review that records it was started only to judge answers already made (all of it but answering the review and fixing CI). Anything else stays in its stage, as that stage.";

/** The run log: every recorded event, oldest first, in the card's zone (its heading names it). */
function runLog(d) {
  const day = spansDays(d);
  const zone = zoneOf(d);
  const at = (t) => clockText(ms(t), { zone, seconds: true, date: day, abbr: false });
  const out = [[d.started, "labelled `pendulum:objective`: the clock starts"]];
  for (const s of d.stages) {
    if (!s.start) continue;
    const name = stageName(s, d.planned).toLowerCase();
    out.push([s.start, `${name} stage started${s.model ? ` (${s.model})` : ""}`]);
    out.push([s.end, `${name} stage's last line: ${s.usd === null ? "unknown" : costText(s.usd, s.unknown)}${s.outcome ? `, ${OUTCOME[s.outcome].slice(2)}` : ""}`]);
  }
  for (const h of d.holds ?? []) out.push([h.start, `${h.kind === "blocked" ? "Blocked" : "Question"} notice: on hold until the next stage`]);
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
  parts.push(notesLine(t, where, drawn));
  const named = t.usd > 0 ? kindsOf(t.usd, t.byBilling) : [];
  // Dollars no record names a billing for: not recorded, never called billed or API-equivalent.
  const kinds = t.usd > 0 && !named.length ? ["unknown"] : named;
  const details = [];
  const basis = [...new Set(kinds.map((k) => BASIS_NOTE[k || "unknown"]).filter(Boolean))];
  if (basis.length) details.push(`- **Cost basis:** ${basis.join(" ")}`);
  const unknown = unknownSentence(d, t);
  if (unknown) details.push(`- **Unknown cost:** ${unknown}`);
  details.push("- **Where figures come from:** times from the issue, the PR and each stage's own record; dollars from each stage's own record. Nothing is estimated.");
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
 * (#545's arms): `passes` ({total, answer, fix}, null unless every stage's passes are known: each of Pendulum's stages has
 * a ledger and none is one Pendulum cannot attribute), `modelMinutes` (the minutes of every harness pass, null unless
 * `passes` is known and each harness pass has its times), `tokens` (every stage's, summed), and `labelled` and
 * `labelledWallMs` (the scorer's start of the clock, the first `pendulum:objective` label with no restart window, and the
 * wall clock from it to the merge; null with no label event, or one labelled before the rename to Pendulum: clockRenamed).
 */
function objectivePasses(d) {
  const figures = d.stages.map((s) => (Array.isArray(s.ledger) ? stagePassFigures(s.ledger) : null));
  const whole = d.stages.length > 0 && d.stages.every((s, i) => !s.unattributed && figures[i]);
  const kinds = whole ? figures.flat() : [];
  const count = (keep) => kinds.filter((k) => keep(k.kind)).reduce((t, k) => t + k.passes, 0);
  const passes = whole ? { total: count(() => true), answer: count(isAnswer), fix: count(isFix) } : null;
  const modelMinutes = whole && !kinds.some((k) => k.untimed) ? kinds.reduce((t, k) => t + (k.harnessMinutes ?? 0), 0) : null;
  const wall = !d.clockRenamed && d.labelled && ms(d.merged) >= ms(d.labelled) ? ms(d.merged) - ms(d.labelled) : null;
  return { passes, modelMinutes, tokens: d.stages.reduce((t, s) => addTokens(t, s.tokens), zeroTokens()), labelled: d.labelled ?? null, labelledWallMs: wall };
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
  if (!cost || !why || sandbox === undefined || !sandboxWhy || !foreign || [...stages, ...asked, ...churn].includes(null) || !started || !merged || !v.prs.every((p) => countOf(p))) return null;
  const counts = v.stageCounts && typeof v.stageCounts === "object" ? v.stageCounts : {};
  return {
    v: v.v,
    pendulum: typeof v.pendulum === "string" && /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:[-+][A-Za-z0-9.-]{1,40})?$/.test(v.pendulum) ? v.pendulum : null,
    issue: n,
    started,
    merged,
    wallMs: countOf(v.wallMs) ?? null,
    prs: v.prs,
    commits: countOf(v.commits) ?? null,
    additions: countOf(v.additions) ?? null,
    deletions: countOf(v.deletions) ?? null,
    files: countOf(v.files) ?? null,
    checks: v.checks && countOf(v.checks.passed) !== undefined && countOf(v.checks.failed) !== undefined ? { passed: v.checks.passed, failed: v.checks.failed, required: v.checks.required === true } : null,
    reviews: v.reviews && countOf(v.reviews.count) !== undefined && countOf(v.reviews.findings) !== undefined ? { count: v.reviews.count, findings: v.reviews.findings } : null,
    stageCounts: { work: countOf(counts.work) ?? 0, rebase: countOf(counts.rebase) ?? 0, review: countOf(counts.review) ?? 0 },
    passes: v.passes && ["total", "answer", "fix"].every((f) => countOf(v.passes[f]) !== undefined) ? { total: v.passes.total, answer: v.passes.answer, fix: v.passes.fix } : null,
    modelMinutes: usdOf(v.modelMinutes) ?? null,
    tokens: tokensRead(v.tokens ?? {}) ?? zeroTokens(),
    labelled: timeOf(v.labelled) ?? null,
    labelledWallMs: countOf(v.labelledWallMs) ?? null,
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
 * Whether the newest PR on Objective `n`'s branch (`pendulum/<n>`) merged: when a finish card is due (postFinishCard's
 * test, wait.mjs closedAs). One read. A failed read throws.
 */
export async function newestPrMerged(repo, n, opts) {
  const branch = (await rest(`repos/${repo.full}/pulls?state=all&head=${encodeURIComponent(`${repo.owner}:pendulum/${n}`)}&sort=created&direction=desc&per_page=1`, opts)) || [];
  return !!branch[0]?.merged_at;
}

/**
 * Post or update the finish card of Objective `issue` ({number, labels, user, state, closed_at}): one card per Objective
 * (its `finish` marker, by Pendulum itself, pendulumOwn), written in place as the run ends again (#589).
 * - A closed Objective (the dispatcher's Done pass, `end` null): merged when the newest PR on its branch merged
 *   (wait.mjs closedAs), else closed without merging, at its close.
 * - `end` ({kind: blocked or question, at, reason, form}): the stage that ended so, after its last progress write.
 * A card that shows a merge, or a close when the end is a close again, stays as it is ("had"): a merge is final, and a
 * reopened Objective merged again gets no second card. Any other card (Blocked, a Question) is rewritten with the new
 * end. A Blocked or Question card is not written over a card of a later end. With `prBody` (not when Pendulum acts under
 * a person's login), a merged card's PR gets the headline block at the top of its body first, read just before it is
 * written; a refusal of that write (not a passing failure) leaves the PR as it is and the card is still written.
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
  // How the run ended: a stage's Blocked or Question; else, closed, merged when the newest PR on its branch merged.
  const merged = !end && !!branch[0]?.merged_at;
  const ending = end ? end : merged ? null : { kind: "closed", at: issue.closed_at };
  const comments = await listComments(repo, n, opts);
  const timeline = (await rest(`repos/${repo.full}/issues/${n}/timeline?per_page=100`, { ...opts, paginate: true })) || [];
  // Pendulum's own comments only (pendulumOwn): its login here, or its App by id.
  const mine = pendulumOwn(appId);
  const card = comments.find((c) => mine(c) && (c.body || "").startsWith(finishMarker(n)));
  const had = card ? finishEndOf(card.body, n) : null;
  if (had && (had.end === "merged" || (had.end === "closed" && ending?.kind === "closed"))) return "had";
  const started = labelTime(issue, timeline, label, objectiveWindow(comments.filter((c) => mine(c)), timeline));
  // The PRs to read whole: the Objective's merged PRs since its clock (a split Objective's parts), oldest first; unmerged,
  // the newest on its branch.
  const prs = branch.filter((p) => p.merged_at);
  const parts = merged ? prs.filter((p) => !started || ms(p.merged_at) >= ms(started)).sort((a, b) => ms(a.merged_at) - ms(b.merged_at)) : [];
  const pulls = [];
  for (const p of merged ? (parts.length ? parts : prs.slice(0, 1)) : branch.slice(0, 1)) {
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
  // A stage's own card: its comments (its progress comment's last write) are as they stand now, after its exit.
  const d = finishData({ repo: repo.full, issue, timeline, comments, pulls, checks, required, records: want.length ? await records(n, want) : [], label, mine, end: ending });
  if (!d) return "nothing ran";
  if (!merged && !d.stages.length && !d.prs.length) return "nothing ran";
  // A stage's Blocked or Question card is never written over a card of a later end.
  if (end && had?.at && ms(had.at) > ms(d.ended)) return "had";
  if (merged && prBody) {
    const now = await getPr(repo, last.pr.number, opts);
    await updatePr(repo, last.pr.number, { body: withFinishBlock(now.body, d) }, opts).catch((e) => {
      if (transientError(e)) throw e;
      log(`  #${n}: PR #${last.pr.number}'s body was not updated (${Number.isInteger(e?.status) ? `HTTP ${e.status}` : "error"}); the card is posted without it`);
    });
  }
  const body = finishCardBody(d);
  if (card) {
    await rest(`repos/${repo.full}/issues/comments/${card.id}`, { ...opts, method: "PATCH", body: { body } });
    return "updated";
  }
  await rest(`repos/${repo.full}/issues/${n}/comments`, { ...opts, method: "POST", body: { body } });
  return "posted";
}

/**
 * A stage's own finish card on its Blocked or Question end (#589), written after its exit line (its last progress write):
 * `exit` (blocked or question), its `reason`, a Question's `form` (logic.mjs questionForm), `issueData` the issue as the
 * stage read it. Never throws: a card that cannot be written is logged, and the Blocked or Question notice stands alone.
 * Returns postFinishCard's answer, or the error.
 */
export async function endCard(repo, issueData, opts, { exit, reason = "", form = null, appId = null, log = () => {}, now = Date.now() } = {}) {
  if (!ENDS.includes(exit) || exit === "closed") return "no end";
  return postFinishCard(repo, issueData, opts, { prBody: false, appId, log, end: { kind: exit, at: new Date(now).toISOString(), reason, form } }).catch((e) => {
    log(`  #${issueData?.number}: its ${exit === "blocked" ? "Blocked" : "Question"} card was not written (${String(e?.message || e).slice(0, 120)})`);
    return e;
  });
}
