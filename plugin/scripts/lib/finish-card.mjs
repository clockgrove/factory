// The finish card (#498): when an Objective merges, one comment on its issue says what happened, how long it took, what
// it cost and who did what, built only from what GitHub and Pendulum's own records hold. Three parts:
//   finishData      the card's figures from GitHub's answers (pure: the issue's timeline and comments, the merged PRs
//                   with their timelines, reviews and review comments, the gate's check runs, the usage records);
//   renderFinishCard / finishBlock   the card's markdown, and the headline with its badges for the PR body (pure);
//   postFinishCard  the reads and writes, once per Objective (the `finish` marker), from the dispatcher's Done pass.
// A figure Pendulum has no record of is left out or shown as unknown, never estimated (usage.mjs UNKNOWN_WHY). Every
// marker the card reads is trusted only from Pendulum itself (pendulumOwn: its login here, or its App by id). A stage
// comment by someone else who can push counts as a run of unknown cost, never its dollars; anyone else's counts nothing.

import { pendulumBuild } from "./release.mjs";
import { DRAFT_LABEL } from "./stop.mjs";
import { DEFAULTS } from "./inputs.mjs";
import { stageHarnessOf } from "./cost-join.mjs";
import { addTokens, isAnswer, isFix, stagePassFigures, zeroTokens } from "./pass-figures.mjs";
import { checkRuns, getPr, listComments, listReviewComments, ownRunArtifact, primeSelf, requiredCheckSpecs, rest, transientError, updatePr } from "./github.mjs";
import { RUNNING_LABEL, STATE_LABELS, bodyFindings, decisionSpendEntries, isPlaceholder, isSelf, ledgerOfComment, marker, pushAuthor, rebaseCostOf, restartedAt, selfLogin, spendParts } from "./logic.mjs";
import { pendulumNotice } from "./answer-check.mjs";
import { PREVIOUS_NAME } from "./local.mjs";
import { BILLING, BILLING_WORDS, PASS_KEYS, UNKNOWN_WHY, addBilling, billingRead, passRead, rerunRead, unknownRuns } from "./usage.mjs";

const OBJECTIVE = DEFAULTS.objective_label;
const ms = (at) => (typeof at === "number" ? at : at ? Date.parse(at) : NaN);
// The conclusions of a check run that failed (skipped and neutral are neither green nor red).
const RED = new Set(["failure", "timed_out", "cancelled", "action_required", "stale", "startup_failure"]);
const num = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
// GitHub stamps its timeline to the second: the merge queue's own removal of the PR it merges can carry the second before.
const SECOND = 1000;

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

/** Whether a closed Objective gets a finish card by its labels: none that ended Blocked or on a Question. */
export const cardable = (labels) => !labels.some((n) => STATE_LABELS[n] === "Blocked" || STATE_LABELS[n] === "Question");

const HARNESS_LINE = /^<!-- pendulum:harness (\{[^\n]*\}) -->$/m;
/** A model id as the card may print it: model-id characters only, else null. */
const modelId = (v) => (typeof v === "string" && /^[A-Za-z0-9._:/-]{1,80}$/.test(v) ? v : null);
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
    const s = { stage, rebase: !!rebase, conflict: !!rebase?.conflict, part: partOf(c.created_at), at: c.created_at, start: c.created_at, end: endOf(c), model: stageModel(c.body) ?? ledgerModel(c.body) ?? modelId(record?.model), harness, usd, unknown, why, byBilling: billingRead(from.usdByBilling), byPass: passRead(from.usdByPass), rerun: rerunRead(from.rerun), judgeOnly: from.judgeOnly === true, sandbox: null, ledger, version, tokens, key };
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

/**
 * The card's figures, from GitHub's answers (pure). Null when no PR of the Objective merged.
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
 *  pushed       whose comments are by someone who can push (logic.mjs pushAuthor) or came through a GitHub App other than
 *               Actions (throughApp): a progress or vendor comment of theirs that is not Pendulum's is a stage of unknown
 *               cost (its time shown, never its figures)
 */
export function finishData({ repo, issue, timeline = [], comments = [], pulls = [], checks = [], required = [], records = [], label = OBJECTIVE, mine = isSelf, pushed = (c) => pushAuthor(c) || throughApp(c) }) {
  const n = issue.number;
  const merged = pulls.filter((p) => p?.pr?.merged_at).sort((a, b) => ms(a.pr.merged_at) - ms(b.pr.merged_at));
  if (!merged.length) return null;
  const last = merged.at(-1).pr;
  const mergedAt = last.merged_at;
  // The clock: the first label at or after the run's last start over (a restart or a reopen), max_objective_usd's window too.
  const started = labelTime(issue, timeline, label, objectiveWindow(comments.filter((c) => mine(c)), timeline)) ?? merged[0].pr.created_at;
  const inRun = (at) => ms(at) >= ms(started) && ms(at) <= ms(mergedAt);
  const own = comments.filter((c) => mine(c)).sort((a, b) => ms(a.created_at) - ms(b.created_at));
  // Which merged part a stage worked on: the parts merged before it started (a split Objective's PRs merge in order).
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
  for (const { reviews: rs = [], reviewComments = [] } of merged) {
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
  const sum = (k) => merged.reduce((s, p) => s + (Number.isInteger(p.pr[k]) ? p.pr[k] : 0), 0);
  return {
    repo,
    issue: n,
    author: login(issue.user?.login),
    labeller: login(labelled?.actor?.login),
    prs: merged.map((p) => ({ number: p.pr.number, url: p.pr.html_url ?? `https://github.com/${repo}/pull/${p.pr.number}`, opened: p.pr.created_at, merged: p.pr.merged_at, ours: mine(p.pr) })),
    started,
    merged: mergedAt,
    planned: own.some((c) => (c.body || "").startsWith(marker(n, "plan")) && inRun(c.created_at)),
    // The scorer's start of the clock: the first label with no restart window (labelTime), null with no label event.
    labelled: labelTime(issue, timeline, label),
    // Labelled before the rename to Pendulum: no wall clock (clockRenamed).
    clockRenamed: clockRenamed(timeline),
    commits: sum("commits"),
    additions: sum("additions"),
    deletions: sum("deletions"),
    files: sum("changed_files"),
    checks: gateChecks(checks, mergedAt, required),
    reviews: reviews.length ? { count: reviews.length, findings, last: reviews.sort((a, b) => ms(a) - ms(b)).at(-1) } : null,
    stages,
    queue,
    sandbox,
    foreignVendors,
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
const cents = (n) => `$${(n / 100).toFixed(2)}`;
const dollars = (usd) => cents(Math.round(usd * 100));
/** Known dollars and runs of unknown cost as a figure: "$0.52", "unknown", "$0.52 + unknown". */
export const costText = (usd, unknown) => (unknown > 0 ? (usd > 0 ? `${dollars(usd)} + unknown` : "unknown") : dollars(usd ?? 0));

/** A model id as people say it: claude-opus-5-5 is Opus 5.5; any other id as it is. */
export function modelName(id) {
  const m = /^claude-([a-z]+)-(\d+)-(\d+)(?:-\d{8})?$/.exec(String(id || ""));
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}` : modelId(id);
}

/** A stage's name in the table, the chart and the log. */
const stageName = (s, planned) => ({ build: planned ? "Plan + build" : "Build", part: `Part ${s.part}`, work: "Work", rebase: "Rebase", review: "Review" })[s.kind];
/** The same, short, for a timeline row (Mermaid section names: short, so the stock themes' margin fits them). */
const rowName = (s) => ({ build: "Build", part: `Part ${s.part}`, work: "Work", rebase: "Rebase", review: "Review" })[s.kind];

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
  return { wall: d.clockRenamed ? null : ms(d.merged) - ms(d.started), usd: Math.round(usd * 1e6) / 1e6, unknown, why, byBilling: addBilling(...d.stages.map((s) => s.byBilling)) };
}

/**
 * Each cost row's known dollars in whole cents, so the rows and the chart add up to the total's cents: each row rounded
 * down, and the cents left given to the rows with the largest remainders (`rows`: dollar figures; null stays null).
 */
export function centsOf(rows) {
  const known = rows.map((usd, i) => [i, usd]).filter(([, usd]) => usd !== null && usd > 0);
  const out = rows.map((usd) => (usd === null ? null : 0));
  const want = Math.round(known.reduce((s, [, usd]) => s + usd, 0) * 100);
  for (const [i, usd] of known) out[i] = Math.floor(usd * 100 + 1e-9);
  let left = want - known.reduce((s, [i]) => s + out[i], 0);
  for (const [i] of [...known].sort((a, b) => (b[1] * 100 - Math.floor(b[1] * 100 + 1e-9)) - (a[1] * 100 - Math.floor(a[1] * 100 + 1e-9)) || a[0] - b[0])) {
    if (left <= 0) break;
    out[i] += 1;
    left -= 1;
  }
  return out;
}

/**
 * What a figure's dollars are, from its dollars by billing (usage.mjs BILLING, read through billingRead): the kinds that
 * hold at least half a cent of it, "" standing for dollars no record names a billing for (a sandbox vendor's).
 */
function kindsOf(usd, byBilling) {
  const map = billingRead(byBilling);
  const out = Object.keys(map).filter((k) => map[k] >= 0.005);
  const unnamed = typeof usd === "number" ? usd - Object.values(map).reduce((s, n) => s + n, 0) : 0;
  if (out.length && unnamed >= 0.005) out.push("");
  return out;
}

/** The card's short words for a kind other than billed API spend; `unknown` is no billing, so it says none was recorded. */
const SHORT = { subscription: "API-equivalent", credits: "Copilot AI credits", unknown: "billing not recorded" };

/**
 * The words after a dollar figure: none for billed API spend or when nothing names a billing; for one other kind
 * " API-equivalent", " in Copilot AI credits" or " (billing not recorded)"; for a mix the kinds other than billed spend,
 * " (part API-equivalent, part billing not recorded)". The table spells each stage out.
 */
export function billingWords(usd, byBilling) {
  const kinds = kindsOf(usd, byBilling);
  const odd = kinds.filter((k) => k && k !== "api" && SHORT[k]);
  if (!odd.length) return "";
  if (kinds.length === 1) return { subscription: " API-equivalent", credits: " in Copilot AI credits", unknown: " (billing not recorded)" }[odd[0]];
  return ` (part ${odd.map((k) => SHORT[k]).join(", part ")})`;
}

/** The cost as the headline says it, with what the dollars are (billingWords). */
function headlineCost({ usd, unknown, byBilling }) {
  if (unknown > 0 && !(usd > 0)) return "; its cost is unknown";
  return ` for ${dollars(usd)}${billingWords(usd, byBilling)}${unknown > 0 ? " plus spend that was not reported" : ""}`;
}

/** The headline: time to merge and the cost. */
export function headline(d) {
  const t = finishTotals(d);
  return `Merged${t.wall === null ? "" : ` in ${durationText(t.wall)}`}${headlineCost(t)}.${t.wall === null ? ` ${RENAMED_CLOCK_WHY[0].toUpperCase()}${RENAMED_CLOCK_WHY.slice(1)}.` : ""}`;
}

/** A shields.io static badge, for-the-badge style: its label and message escaped as shields.io reads them. */
export function badge(label, message, color) {
  const part = (s) => encodeURIComponent(String(s).replace(/-/g, "--").replace(/_/g, "__").replace(/ /g, "_"));
  return `<img alt="${label}: ${message}" src="https://img.shields.io/badge/${part(label)}-${part(message)}-${color}?style=for-the-badge">`;
}

/**
 * The cost badge's label: what its dollars are when they are all of one kind other than billed API spend and that kind
 * is a billing (an API-equivalent figure, Copilot AI credits); "cost" otherwise (billed, not recorded, or a mix, which the
 * headline and table spell out).
 */
function costLabel(t) {
  const kinds = kindsOf(t.usd, t.byBilling);
  return kinds.length === 1 && (kinds[0] === "subscription" || kinds[0] === "credits") ? SHORT[kinds[0]] : "cost";
}

/** The badges: status, wall clock and cost. */
export function badges(d) {
  const t = finishTotals(d);
  return [badge("status", "merged", COLORS.green), badge("wall clock", t.wall === null ? "not known" : durationShort(t.wall), COLORS.brown), badge(costLabel(t), costText(t.usd, t.unknown), COLORS.amber)];
}

const many = (n, one, more = `${one}s`) => `${n} ${n === 1 ? one : more}`;
const utc = (at) => new Date(ms(at)).toISOString().slice(11, 16);
const prList = (prs) => (prs.length === 1 ? `PR #${prs[0].number}` : `PRs ${prs.map((p) => `#${p.number}`).join(", ")}`);

/** Who did what, and what Pendulum did, in plain sentences: only what the records say. */
export function summary(d) {
  const person = d.author && d.labeller ? (d.author === d.labeller ? "You wrote the issue and added the label." : `**${d.author}** wrote the issue and **${d.labeller}** added the label.`) : d.author ? `**${d.author}** wrote the issue.` : "";
  const did = [];
  if (d.planned) did.push("planned the work");
  const change = `${many(d.commits, "commit")}, +${d.additions} −${d.deletions} across ${many(d.files, "file")}`;
  const ours = d.prs.every((p) => p.ours);
  if (ours) did.push(`opened ${prList(d.prs)} (**${change}**)`);
  if (d.checks) {
    const what = many(d.checks.passed, d.checks.required ? "required check" : "check");
    const whose = d.prs.length > 1 ? `the last part's ` : "";
    did.push(`got ${whose}${d.checks.passed > 1 && !d.checks.failed ? "all " : ""}**${what}** green${d.checks.failed ? ` (${d.checks.failed} red)` : ""}`);
  }
  if (d.reviews) did.push(`had the change reviewed (${d.reviews.findings ? many(d.reviews.findings, "finding") : "no findings"})`);
  const how = d.queue.some((q) => q.merged) ? "it merged through your merge queue" : "it merged";
  const pendulum = did.length ? `Pendulum took it from there: it ${did.join(", ")}, and ${how}.` : `${how[0].toUpperCase()}${how.slice(1)}.`;
  const theirs = ours ? "" : ` ${prList(d.prs)} ${d.prs.length === 1 ? "has" : "have"} **${change}**.`;
  return `${person ? `${person} ` : ""}${pendulum}${theirs}`;
}

/** The source line: where the times and dollars come from, and what the dollars are. */
function sources(d, t) {
  const unknownLine = !d.stages.length ? " Pendulum found no record of this run's stages, so its cost shows as unknown, not as a number." : t.unknown ? ` ${t.unknown === 1 ? "One run has" : `${t.unknown} runs have`} no reported cost, so ${t.unknown === 1 ? "it shows" : "they show"} as unknown, not as a number.` : "";
  const kinds = t.usd > 0 ? kindsOf(t.usd, t.byBilling) : [];
  const said = [];
  if (kinds.length && kinds.every((k) => k === "api")) said.push("They are billed spend on your API key or AI Gateway key.");
  if (kinds.includes("subscription")) said.push("An API-equivalent figure is what the usage would cost at API list prices, on your subscription; it is not billed.");
  if (kinds.includes("credits")) said.push(`Copilot AI credits are ${BILLING_WORDS.credits.replace(/^Copilot AI credits, /, "")}.`);
  // Not recorded: the `unknown` kind, dollars no record names, or no kind at all. "Some" only beside a recorded kind.
  const recorded = kinds.some((k) => k && k !== "unknown");
  if (t.usd > 0 && (!kinds.length || kinds.includes("unknown") || kinds.includes(""))) said.push(recorded ? "For some of these dollars Pendulum did not record how they were billed." : "Pendulum did not record how these dollars were billed.");
  const what = ["These are the costs Pendulum recorded for this run.", ...said].join(" ");
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

const isoSecond = (t) => new Date(ms(t)).toISOString().slice(0, 19);
/** Whether the Objective's clock and its merge fall on different UTC days (the times then carry their dates). */
const spansDays = (d) => new Date(ms(d.started)).toISOString().slice(0, 10) !== new Date(ms(d.merged)).toISOString().slice(0, 10);

/** The timeline: one row per stage and per merge queue entry, in time order, in UTC. Stages with no recorded time are left out. */
function gantt(d) {
  const span = ms(d.merged) - ms(d.started);
  const rows = [...d.stages.filter((s) => s.start).map((s) => [rowName(s), s.start, s.end]), ...d.queue.map((q) => [q.merged ? "Queue" : "Dropped", q.start, q.end])].sort((a, b) => ms(a[1]) - ms(b[1]));
  if (!rows.length) return null;
  const lines = ["gantt", "    dateFormat YYYY-MM-DDTHH:mm:ss", `    axisFormat ${spansDays(d) ? "%b %d %H:%M" : "%H:%M"}`, `    tickInterval ${tickFor(span)}`, "    todayMarker off"];
  for (const [name, s, e] of rows) {
    const end = Math.max(ms(e), ms(s) + SECOND);
    lines.push(`    section ${name}`, `    ${durationShort(end - ms(s))} :active, ${isoSecond(s)}, ${isoSecond(end)}`);
  }
  return ["```mermaid", init(GANTT_THEME), ...lines, "```"].join("\n");
}

/** The cost rows: each stage, then the cloud sandbox's own cost: {name, model, time, usd, unknown, byBilling, cents}. */
function costRows(d) {
  const rows = d.stages.map((s) => ({ name: stageName(s, d.planned), model: s.model, time: s.start ? durationText(ms(s.end) - ms(s.start)) : "—", usd: s.usd, unknown: s.unknown, byBilling: s.byBilling }));
  if (!d.stages.length) rows.push({ name: "Pendulum's stages, no record found", model: null, time: "—", usd: null, unknown: 1, byBilling: {} });
  if (d.sandbox) rows.push({ name: "Cloud sandbox", model: null, time: "—", usd: d.sandbox.unknown && !d.sandbox.usd ? null : d.sandbox.usd, unknown: d.sandbox.unknown, byBilling: {} });
  const c = centsOf(rows.map((r) => r.usd));
  return rows.map((r, i) => ({ ...r, cents: c[i] }));
}

/**
 * The cost chart: each row's known cents, only when every figure is known and two or more rows have a cent to show.
 * Rows under a cent are left out of it, and a line under it says so.
 */
function pie(rows, t) {
  if (t.unknown > 0 || !(t.usd > 0)) return null;
  const slices = new Map();
  for (const r of rows) if (r.cents > 0) slices.set(r.name, (slices.get(r.name) ?? 0) + r.cents);
  if (slices.size < 2) return null;
  const small = rows.some((r) => r.usd > 0 && !r.cents);
  const chart = ["```mermaid", init(PIE_THEME), "pie showData", ...[...slices].map(([name, c]) => `    "${name}" : ${(c / 100).toFixed(2)}`), "```"].join("\n");
  return small ? `${chart}\n\n<sub>Stages that cost under a cent are left out of the chart.</sub>` : chart;
}

// ------------------------------------------------------------------ card

/** The cost table by stage and model, with the merge queue's time and the total. */
/** What the whole run's dollars are when they are all of one kind other than billed spend (the column then says it once), else null. */
const oneKind = (t) => {
  const all = kindsOf(t.usd, t.byBilling);
  return all.length === 1 && SHORT[all[0]] ? SHORT[all[0]] : null;
};
/** A cost cell: a row's cents, "+ unknown" beside them, "unknown" alone, and what its dollars are unless `one` says it. */
const costCell = (r, one) => (r.usd === null ? "unknown" : `${r.unknown > 0 ? `${cents(r.cents)} + unknown` : cents(r.cents)}${one ? "" : billingWords(r.usd, r.byBilling)}`);

function costTable(d, t, rows) {
  // All of one kind other than billed spend: the column says what the dollars are, once; otherwise each cell does.
  const one = oneKind(t);
  const cell = (r) => costCell(r, one);
  const lines = rows.map((r) => `| ${r.name}${r.model ? ` · ${modelName(r.model)}` : ""} | ${r.time} | ${cell(r)} |`);
  const queued = d.queue.reduce((s, q) => s + (ms(q.end) - ms(q.start)), 0);
  if (d.queue.length) lines.push(`| Merge queue · your CI | ${durationText(queued)} | — |`);
  return [`| Stage | Time | ${one ? `Cost (${one})` : "Cost"} |`, "| --- | ---: | ---: |", ...lines, `| **Total** | **${t.wall === null ? "not known" : durationText(t.wall)}** | **${costText(t.usd, t.unknown)}${t.usd > 0 && !one ? billingWords(t.usd, t.byBilling) : ""}** |`].join("\n");
}

/** The pass kinds' and stages' words in the breakdown (usage.mjs PASS_KEYS less `conflict`, which is churn), in its order. */
const ASKED = Object.freeze({ work: "Work", review: "Review", answer: "Answer passes", fix: "Fix passes", decision: "Decision calls" });
/** The churn the breakdown names apart (markChurn), in its order. */
const CHURN = Object.freeze({
  "rebase-conflict": "Conflict rebases after other PRs merged",
  "rebase-clean": "Clean rebases after other PRs merged",
  "catch-up": "Catch-up passes after the default branch changed a workflow",
  judge: "Reviews run again only to judge answers already made",
  block: "Passes run again after a Block",
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
  const askedRows = [...asked.values()].sort((a, b) => a.part - b.part || order.indexOf(a.what) - order.indexOf(b.what)).map((r) => done({ ...r, name: parts ? `Part ${r.part}: ${word(r.what).toLowerCase()}` : word(r.what) }));
  if (d.sandbox) askedRows.push({ name: "Cloud sandbox, every stage", usd: d.sandbox.unknown && !d.sandbox.usd ? null : d.sandbox.usd, unknown: d.sandbox.unknown, byBilling: {} });
  const churnRows = Object.keys(CHURN).filter((k) => churn.has(k)).map((k) => done({ ...churn.get(k), row: k, name: CHURN[k] }));
  const c = centsOf([...askedRows, ...churnRows].map((r) => r.usd));
  askedRows.forEach((r, i) => (r.cents = c[i]));
  churnRows.forEach((r, i) => (r.cents = c[askedRows.length + i]));
  return { asked: askedRows, churn: churnRows, shown: parts || churnRows.length > 0 || askedRows.some((r) => r.what === "answer" || r.what === "fix") };
}

/** The breakdown's tables (spendBreakdown): the work the issue asked for, then the churn apart, and where each item comes from. */
function breakdownTables(b, t) {
  const one = oneKind(t);
  const head = one ? `Cost (${one})` : "Cost";
  const out = [[`| What the issue asked for | ${head} |`, "| --- | ---: |", ...b.asked.map((r) => `| ${r.name} | ${costCell(r, one)} |`)].join("\n")];
  if (b.churn.length) out.push([`| Churn Pendulum caused | Stages | ${head} |`, "| --- | ---: | ---: |", ...b.churn.map((r) => `| ${r.name} | ${r.stages} | ${costCell(r, one)} |`)].join("\n"));
  out.push("<sub>Each item comes from a stage's own record, never a guess. A stage is in the part after the PRs merged before it started; its passes are split by the kinds its spend record names. Churn is a send-back's rebase (its rebase line), a catch-up pass after the default branch changed a workflow, the passes a stage records it ran again after a Block, and a review that records it was started only to judge answers already made (all of it but its answer and fix passes). Anything else stays in its stage, as that stage.</sub>");
  return out;
}

/** The run log: every recorded event, oldest first. */
function runLog(d) {
  const day = spansDays(d);
  const at = (t) => (day ? new Date(ms(t)).toISOString().slice(0, 19).replace("T", " ") : new Date(ms(t)).toISOString().slice(11, 19));
  const out = [[d.started, "labelled `pendulum:objective`: the clock starts"]];
  for (const s of d.stages) {
    if (!s.start) continue;
    const name = stageName(s, d.planned).toLowerCase();
    out.push([s.start, `${name} stage started${s.model ? ` (${s.model})` : ""}`]);
    out.push([s.end, `${name} stage's last line: ${s.usd === null ? "unknown" : costText(s.usd, s.unknown)}`]);
  }
  for (const p of d.prs) out.push([p.opened, `PR #${p.number} opened`]);
  for (const q of d.queue) {
    out.push([q.start, "added to the merge queue"]);
    if (!q.merged) out.push([q.end, "removed from the merge queue"]);
  }
  if (d.reviews) out.push([d.reviews.last, `last review: ${many(d.reviews.count, "review")} in all, ${d.reviews.findings ? many(d.reviews.findings, "finding") : "no findings"}`]);
  const last = d.prs.at(-1);
  out.push([d.merged, `PR #${last.number} merged${d.checks ? `, ${many(d.checks.passed, d.checks.required ? "required check" : "check")} green` : ""}`]);
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
  const rows = costRows(d);
  const parts = [`<p align="center"><img src="${MARK_URL}" width="96" alt="Pendulum"></p>`, `<h3 align="center">${headline(d)}</h3>`, landedLine(d), `<p align="center">\n${badges(d).join("\n")}\n</p>`, summary(d)];
  const timeline = gantt(d);
  if (timeline) parts.push("**How the time went** (UTC)", timeline);
  parts.push("**What it cost**", costTable(d, t, rows));
  const chart = pie(rows, t);
  if (chart) parts.push(chart);
  const where = spendBreakdown(d);
  if (where.shown) parts.push("**Where the dollars went**", ...breakdownTables(where, t));
  parts.push(`<sub>${sources(d, t)}</sub>`, `<details><summary>Full run log</summary>\n\n${runLog(d)}\n\n</details>`);
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
    stages: d.stages.map((s, i) => ({ kind: s.kind, key: s.key ?? null, part: s.part, model: s.model, harness: s.harness, version: s.version ?? null, ms: s.start ? ms(s.end) - ms(s.start) : null, ...money({ ...s, cents: rows[i].cents }), why: s.why, sandbox: s.sandbox, churn: s.churn.map((c) => c.row), tokens: s.tokens ?? zeroTokens(), passes: Array.isArray(s.ledger) ? stagePassFigures(s.ledger) : null, ...(s.unattributed ? { unattributed: true } : {}) })),
    asked: b.asked.map((r) => ({ part: r.part ?? null, what: r.what ?? "sandbox", ...money(r) })),
    churn: b.churn.map((r) => ({ row: r.row, stages: r.stages, ...money(r) })),
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

/**
 * The finish card comment's whole body: its `finish` marker on its first line, its summary marker on its second, and the
 * card. With no summary that fits (summaryMarker null), or a body over COMMENT_MAX with it, the card is posted without it.
 */
export function finishCardBody(d) {
  const card = renderFinishCard(d);
  const summary = summaryMarker(d);
  const body = summary ? `${finishMarker(d.issue)}\n${summary}\n${card}` : null;
  return body && body.length <= COMMENT_MAX ? body : `${finishMarker(d.issue)}\n${card}`;
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
    return { kind: s.kind, key: s.key, part: s.part, model: s.model, harness: s.harness, version: s.version, ms: s.ms, ...money, why: stageWhy, sandbox: own ? { usd: own.usd, unknown: own.unknown } : null, churn: Array.isArray(s.churn) ? s.churn.filter((c) => Object.hasOwn(CHURN, c)) : [], tokens, passes, ...(s.unattributed === true ? { unattributed: true } : {}) };
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
 * Post the finish card of closed Objective `issue` ({number, labels, user}) once: none for one that ended Blocked or on
 * a Question, or whose newest PR on its branch did not merge, or that already has its card (its `finish` marker, by
 * Pendulum itself, pendulumOwn: a reopened and merged-again Objective gets no second one). `appId`: Pendulum's App
 * (the Action's app_id, or a local loop's PENDULUM_LOCAL_APP_ID), whose comments are Pendulum's too. With `prBody` (not when Pendulum acts
 * under a person's login), the merged PR's body gets the headline and badges at its top first, read just before it is
 * written; a refusal of that write (not a passing failure) leaves the PR as it is and the card is still posted.
 * Returns "posted", "had" (posted before), or why none is due: "not merged", "blocked", "no self" (Pendulum's own login
 * unknown, so no marker can be trusted). `records(n, want)`: the usage records (objectiveRecords) of its stages with no spend line, for their
 * dollars, and of its stages whose harness line names no model, for their model; read only when there is such a stage.
 * A failed read or write throws.
 */
/**
 * Whether the newest PR on Objective `n`'s branch (`pendulum/<n>`) merged: when a finish card is due (postFinishCard's
 * test, wait.mjs closedAs). One read. A failed read throws.
 */
export async function newestPrMerged(repo, n, opts) {
  const branch = (await rest(`repos/${repo.full}/pulls?state=all&head=${encodeURIComponent(`${repo.owner}:pendulum/${n}`)}&sort=created&direction=desc&per_page=1`, opts)) || [];
  return !!branch[0]?.merged_at;
}

export async function postFinishCard(repo, issue, opts, { records = async () => [], label = OBJECTIVE, prBody = true, appId = null, log = () => {} } = {}) {
  const n = issue.number;
  const names = (issue.labels || []).map((l) => (typeof l === "string" ? l : l.name));
  if (!cardable(names)) return "blocked";
  if (!selfLogin()) await primeSelf(opts);
  if (!selfLogin()) return "no self";
  // Merged when the newest PR on its branch merged (wait.mjs closedAs): a person who closed the issue with a later part's
  // PR still open, or its PR closed unmerged, gets no card.
  const branch = (await rest(`repos/${repo.full}/pulls?state=all&head=${encodeURIComponent(`${repo.owner}:pendulum/${n}`)}&sort=created&direction=desc&per_page=20`, opts)) || [];
  if (!branch[0]?.merged_at) return "not merged";
  const prs = branch.filter((p) => p.merged_at);
  const comments = await listComments(repo, n, opts);
  const timeline = (await rest(`repos/${repo.full}/issues/${n}/timeline?per_page=100`, { ...opts, paginate: true })) || [];
  // Pendulum's own comments only (pendulumOwn): its login here, or its App by id.
  const mine = pendulumOwn(appId);
  if (comments.some((c) => mine(c) && (c.body || "").startsWith(finishMarker(n)))) return "had";
  const started = labelTime(issue, timeline, label, objectiveWindow(comments.filter((c) => mine(c)), timeline));
  // The Objective's merged PRs since its clock (a split Objective's parts), oldest first, each read whole.
  const parts = prs.filter((p) => !started || ms(p.merged_at) >= ms(started)).sort((a, b) => ms(a.merged_at) - ms(b.merged_at));
  const pulls = [];
  for (const p of parts.length ? parts : prs.slice(0, 1)) {
    const [pr, t, reviews, reviewComments] = await Promise.all([getPr(repo, p.number, opts), rest(`repos/${repo.full}/issues/${p.number}/timeline?per_page=100`, { ...opts, paginate: true }), rest(`repos/${repo.full}/pulls/${p.number}/reviews?per_page=100`, { ...opts, paginate: true }), listReviewComments(repo, p.number, opts)]);
    pulls.push({ pr, timeline: t || [], reviews: reviews || [], reviewComments });
  }
  const last = pulls.at(-1);
  // The checks that gated the merge: the merge queue's, on the merge commit it made; without a queue, the head's.
  const queued = (last.timeline || []).some((e) => e.event === "added_to_merge_queue");
  const gateSha = queued && last.pr.merge_commit_sha ? last.pr.merge_commit_sha : last.pr.head?.sha;
  const checks = gateSha ? await checkRuns(repo, gateSha, opts, { all: true }) : [];
  // The required checks, when the repository's rules can be read (a token that may not read them counts every check).
  const required = await requiredCheckSpecs(repo, opts).catch((e) => {
    if (transientError(e)) throw e;
    return [];
  });
  // The usage artifacts of the stages with no spend line of their own (their dollars) or whose harness line names no
  // model (their model), and only theirs.
  const since = comments.filter((c) => ms(c.created_at) >= ms(started));
  const unlined = unlinedStages(since, n, mine);
  const want = [...unlined, ...modellessStages(since, n, mine).filter((w) => !unlined.some((u) => u.stage === w.stage && u.key === w.key))];
  const d = finishData({ repo: repo.full, issue, timeline, comments, pulls, checks, required, records: want.length ? await records(n, want) : [], label, mine });
  if (!d) return "not merged";
  if (prBody) {
    const now = await getPr(repo, last.pr.number, opts);
    await updatePr(repo, last.pr.number, { body: withFinishBlock(now.body, d) }, opts).catch((e) => {
      if (transientError(e)) throw e;
      log(`  #${n}: PR #${last.pr.number}'s body was not updated (${Number.isInteger(e?.status) ? `HTTP ${e.status}` : "error"}); the card is posted without it`);
    });
  }
  await rest(`repos/${repo.full}/issues/${n}/comments`, { ...opts, method: "POST", body: { body: finishCardBody(d) } });
  return "posted";
}
