// `pendulum report` (#512): the cost and token data layer. Pendulum reads what its own records say about a period or a set
// of Objectives and emits every figure precomputed, in one versioned JSON schema (REPORT_SCHEMA; docs/REPORT.md) or as
// plain Markdown for a terminal or CI. The harness presents the figures and never adds, averages or derives dollars
// (the pendulum-report skill). Three parts:
//   readReport    the reads, within a call budget: the issue comments (the progress, harness, spend, ledger, vendor,
//                 decision-spend and finish markers; one paged repository-wide read, or each named issue's own), the
//                 Objectives' issues and PRs, and the usage artifacts of the stages whose dollars (no spend line),
//                 per-pass ledger (no ledger line beside the spend line) or model (none on the harness or ledger line)
//                 only their usage record holds, cached on disk by artifact id; a merged Objective with Pendulum's own
//                 finish card is read from its summary alone (summaryFor, #544);
//   buildReport   the figures (pure), through the scorer's own cost join (cost-join.mjs: withLines, costOf);
//   renderReport  the Markdown.
// Dollars are vendor-reported, or API-reported tokens at the published rate, or unknown (usage.mjs UNKNOWN_WHY): never
// an estimate, a bound or a counterfactual. Totals stay split by billing kind (usage.mjs BILLING) and the sandbox
// vendor's cost, never blended. Markers count only from Pendulum's own login or App (finish-card.mjs pendulumOwn), or a
// login `--self` names that can push; a stage comment by someone else who can push, or through another App, is a run of
// unknown cost; anyone else's counts nothing. An artifact a fork's run uploaded is never read (github.mjs ownRunArtifact).
// No reason, Block text, task card, transcript or credential reaches the report, and no account unless asked for.

import { pendulumBuild } from "./release.mjs";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { costOf, coversLine, decisionSpendRecords, loadPrices, stageHarnessOf, stageOf, stageSpendRecords, withLines, ACCOUNT } from "./cost-join.mjs";
import { collaboratorPermission, downloadArtifactResult, ownRunArtifact, rest } from "./github.mjs";
import { DEFAULTS } from "./inputs.mjs";
import { appIdSetLine, appIdWhyText, readAppIdVariable } from "./app-id.mjs";
import { FINDING_OUTCOMES, STATE_LABELS, findingsOf, ledgerOfComment, loginKey, pushAuthor, rebaseCostOf, setSelf, selfLogin, spendParts } from "./logic.mjs";
import { finishMarker, labelTime, modellessStages, pendulumOwn, readSummary, reportStageKind, throughApp } from "./finish-card.mjs";
import { BILLING, BILLING_WORDS, UNKNOWN_WHY, bareModel, codexRow, longShare, sumLong } from "./usage.mjs";
import { EXPERIMENT_NAME, EXPERIMENT_PREFIX, isExperimentLabel } from "./choice.mjs";
import { labelsVouched } from "./objective-trust.mjs";
import { spread } from "./spread.mjs";
import { COST_KINDS, addCost, addTokens, isAnswer, isFix, stagePassFigures, zeroCost, zeroTokens } from "./pass-figures.mjs";

export { COST_KINDS, passLabel } from "./pass-figures.mjs";

/** The report's schema: its name and major version. A change that renames, removes or retypes a field is a new version. */
export const REPORT_SCHEMA = "pendulum-report/1";
/** The default ceiling on GitHub API calls (`--max-calls`). */
export const DEFAULT_MAX_CALLS = 300;
/** The period a report covers when it names neither a period nor a set: the last 30 days. */
export const DEFAULT_DAYS = 30;
/** `pendulum report`'s exit when the call budget stopped it: the report printed is partial (`source.complete` false). */
export const STOPPED_EXIT = 3;
/** What each kind's dollars are, word for word as the harness labels them. */
export const KIND_WORDS = Object.freeze({ ...BILLING_WORDS, api: "billed per use on an API key", sandbox: "the cloud sandbox vendor's cost at its list rates" });
/** The `--by` values whose figures only each stage's own records hold (an account): with one, no Objective is read from its summary. */
export const STAGE_DETAIL = Object.freeze(["account"]);
/** An Objective's end, from its labels and its PRs. */
export const OUTCOMES = Object.freeze(["merged", "blocked", "question", "closed-unmerged", "open"]);

const PER_PAGE = 100;
const ms = (at) => (at ? Date.parse(at) : NaN);
const round6 = (n) => Math.round(n * 1e6) / 1e6;
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const MODEL = /^[A-Za-z0-9._:/-]{1,80}$/;
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:[-+][A-Za-z0-9.-]{1,40})?$/;
const HARNESSES = new Set(["claude", "codex", "copilot"]);
const modelKey = (v) => (typeof v === "string" && MODEL.test(v) ? v : null);

/** Other names of Claude models (GitHub Copilot's model catalog ids) and the Anthropic API id each names. */
export const CLAUDE_MODELS = JSON.parse(readFileSync(join(import.meta.dirname, "claude-models.json"), "utf8"));

/**
 * A model id as the report names it, one name per model: a model the Codex price table lists (usage.mjs codexRow: its id
 * after any provider prefix, or an alias the table records as OpenAI documents it) by the table's own id, a dated
 * snapshot suffix kept (`openai/gpt-6.1-sol` is `gpt-6.1-sol`; `gpt-5.6` is `gpt-5.6-sol`); a Claude model's other name
 * that claude-models.json lists (Copilot's catalog id `claude-sonnet-5.5`) by the Anthropic API id it maps it to
 * (`claude-sonnet-5-5`). Any other id as recorded; null for none.
 */
export function modelName(model, prices, claude = CLAUDE_MODELS) {
  const m = modelKey(model);
  if (!m) return null;
  const named = claude?.aliases && typeof claude.aliases === "object" && Object.hasOwn(claude.aliases, m) ? modelKey(claude.aliases[m]) : null;
  if (named) return named;
  const row = codexRow(prices, m, { at: null });
  if (!row.rate && row.why !== "price-ended") return m;
  const bare = bareModel(m);
  const aliases = prices?.aliases && typeof prices.aliases === "object" ? prices.aliases : {};
  return Object.hasOwn(aliases, bare) && typeof aliases[bare] === "string" ? aliases[bare] : bare;
}

/** A `source.missing` entry's Objectives and the stages among them (`add(n, stages)`, one stage by default). */
const tally = () => {
  const t = {
    issues: new Set(),
    stages: 0,
    add(n, stages = 1) {
      t.issues.add(n);
      t.stages += stages;
    },
  };
  return t;
};
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/;
const DAY_MS = 86_400_000;
/** The UTC midnight at or before `t` (ms), as ISO. */
const midnight = (t) => new Date(Math.floor(t / DAY_MS) * DAY_MS).toISOString().replace(/\.000Z$/, "Z");

// ------------------------------------------------------------------ the command line

/** A `--since` or `--until` value as an ISO time: a date (its UTC midnight) or a time with its zone; null when neither. */
export function reportTime(v) {
  const text = String(v ?? "").trim();
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(text) ? `${text}T00:00:00Z` : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(text) ? text : null;
  return iso && Number.isFinite(Date.parse(iso)) ? new Date(Date.parse(iso)).toISOString().replace(/\.000Z$/, "Z") : null;
}

/** `--issue` values (each a number, or numbers joined by commas) as issue numbers; null when one is not. */
export function reportIssues(values = []) {
  const out = [];
  for (const part of values.flatMap((v) => String(v).split(","))) {
    if (!/^\d+$/.test(part.trim()) || !Number.isSafeInteger(Number(part)) || Number(part) <= 0) return null;
    out.push(Number(part));
  }
  return [...new Set(out)];
}

/** `--rates` values (model ids, each alone or joined by commas) as model ids, in order and once each; null when one is not. */
export function reportModels(values = []) {
  const out = values.flatMap((v) => String(v).split(",")).map((v) => v.trim());
  return out.length && out.every((m) => MODEL.test(m)) ? [...new Set(out)] : null;
}

/** Why `pendulum report`'s flags do not make a report (a line for the usage message), or null. */
export function reportCheck(f) {
  if (f.since !== undefined && !reportTime(f.since)) return `--since takes a date (2026-11-01) or a time with its zone, not ${JSON.stringify(f.since)}`;
  if (f.until !== undefined && !reportTime(f.until)) return `--until takes a date (2026-11-01) or a time with its zone, not ${JSON.stringify(f.until)}`;
  if (f.since !== undefined && f.until !== undefined && !(Date.parse(reportTime(f.since)) < Date.parse(reportTime(f.until)))) return "--since must come before --until";
  if (f.issue !== undefined && !reportIssues(f.issue)) return `--issue takes issue numbers (12, or 12,15), not ${JSON.stringify(f.issue.join(" "))}`;
  if (f.parent !== undefined && !Number.isSafeInteger(f.parent)) return "--parent takes an issue number";
  if ([f.issue, f.label, f.parent, f.compare ?? f["compare-label"]].filter((v) => v !== undefined).length > 1) return "give one of --issue, --label, --parent or --compare";
  if (f.compare !== undefined && f["compare-label"] !== undefined) return "give the two arms as experiment names (--compare) or as labels (--compare-label), not both";
  // A period would cut a merged Objective's dollars to its stages in the window, which are then no longer its dollars.
  if ((f.compare !== undefined || f["compare-label"] !== undefined) && (f.since !== undefined || f.until !== undefined)) return "--compare and --compare-label read each arm's Objectives whole: give no --since or --until";
  const arms = compareArms(f);
  if (arms && arms.some((a) => a === null)) return f.compare !== undefined ? `--compare takes experiment names (letters, digits, . _ -, up to 30; the part after ${EXPERIMENT_PREFIX}), not ${JSON.stringify(f.compare.join(" "))}` : `--compare-label takes label names, not ${JSON.stringify(f["compare-label"].join(" "))}`;
  if (arms && (arms.length !== 2 || arms[0].toLowerCase() === arms[1].toLowerCase())) return "--compare and --compare-label take two different arms (A,B, or the flag twice)";
  if (f.label !== undefined && !/^[^,\s][^,]{0,49}$/.test(f.label)) return `--label takes one label name, not ${JSON.stringify(f.label)}`;
  if (f.by !== undefined && !STAGE_DETAIL.includes(f.by)) return `--by takes account, not ${JSON.stringify(f.by)}`;
  if (f["max-calls"] !== undefined && !Number.isSafeInteger(f["max-calls"])) return "--max-calls takes a whole number of calls";
  if (f.app !== undefined && !Number.isSafeInteger(f.app)) return "--app takes the Pendulum App's numeric id";
  if (f.rates !== undefined && !reportModels(f.rates)) return `--rates takes model ids (gpt-6.1-terra, or several joined by commas), not ${JSON.stringify(f.rates.join(" "))}`;
  if (f.self !== undefined && f.self.some((l) => !LOGIN.test(l))) return `--self takes a GitHub login, not ${JSON.stringify(f.self.find((l) => !LOGIN.test(l)))}`;
  return null;
}

/**
 * The two arms `--compare` (experiment names, each as its `pendulum:experiment:<name>` label) or `--compare-label` (label
 * names) give, each a value or the values joined by commas: their label names, null for a value that names none; null
 * when neither flag is given.
 */
export function compareArms(f) {
  const exp = f.compare !== undefined;
  const values = exp ? f.compare : f["compare-label"];
  if (values === undefined) return null;
  return values
    .flatMap((v) => String(v).split(","))
    .map((v) => v.trim())
    .map((v) => (exp ? (EXPERIMENT_NAME.test(v) ? `${EXPERIMENT_PREFIX}${v}` : null) : /^[^,\s][^,]{0,49}$/.test(v) ? v : null));
}

/**
 * The report's scope from its flags (reportCheck passed): {since, until, defaultPeriod, issues, label, parent, compare
 * (the two arms' label names, or null)}. A period
 * with no start (no set named, and no --since): the DEFAULT_DAYS days before --until (else now), from that day's UTC
 * midnight, said in the report (`scope.defaultPeriod`).
 */
export function reportScope(f, now = Date.now()) {
  const issues = f.issue ? reportIssues(f.issue) : [];
  const compare = compareArms(f);
  const set = issues.length > 0 || f.label !== undefined || f.parent !== undefined || !!compare;
  const until = f.until !== undefined ? reportTime(f.until) : null;
  const defaulted = !set && f.since === undefined;
  const since = f.since !== undefined ? reportTime(f.since) : defaulted ? midnight((until ? Date.parse(until) : now) - DEFAULT_DAYS * DAY_MS) : null;
  return { since, until, defaultPeriod: defaulted, issues, label: f.label ?? null, parent: f.parent ?? null, compare };
}

/** Whether the scope names a set of Objectives (issues, a label, a parent, or two arms) rather than a period. */
const setScope = (scope) => scope.issues.length > 0 || !!scope.label || !!scope.parent || !!scope.compare;
/**
 * The labels whose Objectives count only where the person who last applied the label can push (#545): the two arms of
 * `--compare`, and a `--label` that is an experiment label.
 */
export const vettedLabels = (scope) => scope.compare ?? (isExperimentLabel(scope.label) ? [scope.label] : []);

// ------------------------------------------------------------------ the call budget

/** The budget ran out: the read stops here and the report is partial. */
export class BudgetStop extends Error {
  constructor(what, made, max) {
    super(`stopped at --max-calls ${max} before ${what} (${made} calls made)`);
    this.what = what;
  }
}

/**
 * The GitHub API calls a report may make: `plan(n, what)` says what is about to be read and how many calls at least
 * (logged, before the reads), `take(what)` counts one call or throws BudgetStop at the ceiling.
 */
export class Budget {
  constructor(max, log = () => {}) {
    this.max = max;
    this.made = 0;
    this.planned = 0;
    this.byKind = {};
    this.open = false;
    this.log = log;
  }
  plan(n, what, { atLeast = false } = {}) {
    this.planned += n;
    if (atLeast) this.open = true;
    this.log(`pendulum report: planned ${atLeast ? "at least " : ""}${n} call(s) for ${what}; ${this.open ? "at least " : ""}${this.planned} planned so far, ${this.made} made, --max-calls ${this.max}`);
  }
  take(what) {
    if (this.made >= this.max) throw new BudgetStop(what, this.made, this.max);
    this.made += 1;
    this.byKind[what] = (this.byKind[what] ?? 0) + 1;
  }
}

/** The set names no issue that could be read: nothing more to read. */
class NothingToRead extends Error {}

/**
 * One paged read, a call per page of 100 (the page number in the query), each counted; its first page was planned. After
 * the first page the rest is planned from its Link header's last page (GitHub's `rel="last"`), else as at least one more.
 * `stop(items)` ends it early. Returns the items.
 */
async function paged(path, budget, what, opts, { stop = () => false } = {}) {
  const out = [];
  let last = null;
  for (let page = 1; ; page += 1) {
    budget.take(what);
    let link = null;
    const data = await rest(`${path}${path.includes("?") ? "&" : "?"}per_page=${PER_PAGE}&page=${page}`, { ...opts, onLink: (l) => (link = l) });
    const items = Array.isArray(data) ? data : (data && typeof data === "object" ? Object.values(data).find(Array.isArray) : null) || [];
    out.push(...items);
    if (items.length < PER_PAGE || stop(items)) return out;
    if (page === 1) {
      last = Number(/[?&]page=(\d+)[^>]*>;\s*rel="last"/.exec(link || "")?.[1]) || null;
      if (last && last > 1) budget.plan(last - 1, `the other ${last - 1} page(s) of ${what}`);
      else budget.plan(1, `the next page of ${what}`, { atLeast: true });
    } else if (!last) budget.plan(1, `the next page of ${what}`, { atLeast: true });
  }
}

// ------------------------------------------------------------------ the artifact cache

/**
 * Where downloaded usage records are kept, by artifact id: the user's cache directory (XDG_CACHE_HOME, else ~/.cache;
 * ~/Library/Caches on macOS; LOCALAPPDATA on Windows), under pendulum/artifacts/<API host>/<owner>/<name>/. Never in a
 * repository. An artifact never changes once uploaded, so a record read once is never read again.
 */
export function reportCacheDir(repoFull, env = process.env, home = homedir(), os = platform()) {
  const root = env.XDG_CACHE_HOME && env.XDG_CACHE_HOME.startsWith("/") ? env.XDG_CACHE_HOME : os === "darwin" ? join(home, "Library", "Caches") : os === "win32" && env.LOCALAPPDATA ? env.LOCALAPPDATA : join(home, ".cache");
  let host = "api.github.com";
  try {
    host = new URL(env.GITHUB_API_URL || "https://api.github.com").host.replace(/[^A-Za-z0-9.-]/g, "_");
  } catch {
    // the default host
  }
  const [owner, name] = String(repoFull).split("/");
  return join(root, "pendulum", "artifacts", host, owner, name);
}

/** The fields of a usage record the report reads (the cost join's and the ledger's): all it keeps and caches. */
const RECORD_FIELDS = ["harness", "model", "usd", "usdUnknown", "usdUnknownWhy", "usdByBilling", "billing", "tokens", "runs", "exit", "progressRun", "standIn", "account", "vendor", "subAgents", "workerKeyUsd", "gatewayDecisionUsd", "started", "ended", "premiumRequests", "aiCredits", "aiu", "ledger"];
/** A downloaded result.json cut to RECORD_FIELDS (and of `ran`, the Pendulum release): nothing else is kept or cached. */
export function recordFields(rec) {
  if (!rec || typeof rec !== "object" || Array.isArray(rec)) return null;
  const out = Object.fromEntries(RECORD_FIELDS.filter((k) => Object.hasOwn(rec, k)).map((k) => [k, rec[k]]));
  if (typeof rec.ran?.pendulum === "string") out.ran = { pendulum: rec.ran.pendulum };
  return out;
}

function cachedRecord(dir, id) {
  try {
    const v = JSON.parse(readFileSync(join(dir, `${id}.json`), "utf8"));
    return v && typeof v === "object" && Object.hasOwn(v, "result") ? { result: recordFields(v.result) } : null;
  } catch {
    return null;
  }
}

function keepRecord(dir, id, result) {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = join(dir, `.${id}.${process.pid}.tmp`);
    writeFileSync(tmp, `${JSON.stringify({ result })}\n`, { mode: 0o600 });
    renameSync(tmp, join(dir, `${id}.json`));
  } catch {
    // a cache that cannot be written is read again next time
  }
}

/** An artifact with no result.json: one run of unknown cost (its stage ended before it wrote one), never $0. */
const noResult = (artifact, workflowRun) => ({ artifact, workflowRun, standIn: true, noResult: true, harness: null, usd: null, usdUnknown: 1, usdUnknownWhy: ["unreported"], tokens: { input: null, output: null, cached: null, written: null }, basis: `unknown: no result.json in ${artifact}` });

// ------------------------------------------------------------------ reading

/**
 * Local mode's own usage records of Objective `n` in the clone `checkout` (`<checkout>/.pendulum/<n>/usage-*`
 * `/result.json`, local.mjs), by the progress comment they name (`progressRun`): read for the per-pass ledger, the
 * Pendulum version and the model its harness line names none of only; a local stage's dollars are in its spend line.
 */
export function localRecords(checkout, n) {
  const out = new Map();
  if (!checkout) return out;
  const dir = join(checkout, ".pendulum", String(n));
  let names = [];
  try {
    names = readdirSync(dir).filter((d) => /^usage-[A-Za-z0-9._-]+$/.test(d));
  } catch {
    return out;
  }
  for (const d of names) {
    try {
      const rec = JSON.parse(readFileSync(join(dir, d, "result.json"), "utf8"));
      if (rec && typeof rec.progressRun === "string" && rec.progressRun) out.set(rec.progressRun, rec);
    } catch {
      // no record in it
    }
  }
  return out;
}

/** The Objective number an issue comment belongs to: its marker's, when the comment is on that issue; else null. */
export function markerIssue(c) {
  const m = /^<!-- pendulum:(\d+):/.exec(c?.body || "");
  if (!m) return null;
  const on = /\/issues\/(\d+)$/.exec(c.issue_url || "")?.[1];
  return on === m[1] ? Number(m[1]) : null;
}

/**
 * Whose markers the report takes as Pendulum's own: its login here (the token's, logic.mjs isSelf) or its App by id
 * (finish-card.mjs pendulumOwn), and a login `self` names (`--self`) only on a comment by someone who can push.
 */
export function ownPredicate(appId = null, self = []) {
  const app = pendulumOwn(appId);
  const named = new Set((self || []).map(loginKey));
  return (c) => app(c) || (named.has(loginKey(c?.user?.login)) && pushAuthor(c));
}

/**
 * The finish card summary (#544) a report reads merged Objective `n` from in place of its stages, or null: with no
 * `--by` value that needs each stage's own records (STAGE_DETAIL) and no `stages` (`--rates`: a summary carries no
 * stage's sub-agent threads or long-context share, which its rate ratios weigh), the first comment of Pendulum's own (`mine`) on the
 * issue that is its finish card and carries a summary of a version this reader takes (finish-card.mjs readSummary),
 * when every stage of Pendulum's own in it has its per-pass figures (pass-figures.mjs stagePassFigures, from its ledger),
 * the card's run (its clock to its merge) lies in the period, and every stage comment in the period, Pendulum's or
 * one by someone who can push (`pushed`), is one the card counted: in that run, or a vendor comment of a stage in it;
 * and none of them, in the period or not, was written or edited after the card. A card with no stage is none.
 * Anyone else's card, or a summary that does not read, is none: the stages are read. Returns {comment, summary}.
 */
export function summaryFor(n, comments, scope, { mine, pushed = (c) => pushAuthor(c) || throughApp(c), by = [], stages = false } = {}) {
  if (stages || (by || []).some((b) => STAGE_DETAIL.includes(b))) return null;
  const on = (comments || []).filter((c) => markerIssue(c) === n);
  let found = null;
  for (const c of on.filter((x) => mine(x) && (x.body || "").startsWith(finishMarker(n))).sort((a, b) => ms(a.created_at) - ms(b.created_at))) {
    const summary = readSummary(c.body, n);
    if (summary) {
      found = { comment: c, summary };
      break;
    }
  }
  if (!found) return null;
  // A card with no stage, or a stage of Pendulum's own that has no per-pass ledger in it: its stages are read.
  if (!found.summary.stages.length || found.summary.stages.some((s) => !s.unattributed && !Array.isArray(s.passes))) return null;
  const { started, merged } = found.summary;
  if (!inWindow(started, scope) || (scope.until && !(ms(merged) < ms(scope.until)))) return null;
  const inRun = (at) => ms(at) >= ms(started) && ms(at) <= ms(merged);
  const head = new RegExp(`^<!-- pendulum:${n}:(progress|vendor):((?:work|review):[A-Za-z0-9:-]{1,100}) -->`);
  const stageComments = on.filter((c) => (mine(c) || pushed(c)) && head.test(c.body || ""));
  // A stage comment written or edited after the card (a late vendor booking, a spend line changed) is in no figure of it.
  const card = ms(found.comment.created_at);
  if (stageComments.some((c) => !(ms(c.created_at) <= card) || (c.updated_at && !(ms(c.updated_at) <= card)))) return null;
  const ran = new Set(stageComments.filter((c) => head.exec(c.body)[1] === "progress" && inRun(c.created_at)).map((c) => head.exec(c.body)[2]));
  const counted = (c) => inRun(c.created_at) || (head.exec(c.body)[1] === "vendor" && ran.has(head.exec(c.body)[2]));
  return stageComments.every((c) => !inWindow(c.created_at, scope) || counted(c)) ? found : null;
}

/**
 * Read what a report needs from GitHub and the user's disk, within `maxCalls` GitHub API calls. `scope`: {since, until
 * (ISO or null), issues (numbers), label, parent}. `appId`: Pendulum's App id (pendulumOwn), else the repository variable
 * PENDULUM_APP_ID (one call; on a 403, one more with `fallback()`'s token, the gh login's), else `localCopy`'s id
 * (app-id.mjs readLocalAppId), else `envAppId`; `source.appFrom` names the one taken, or why none was (`unset`,
 * `forbidden`); `self`: the logins `--self` names; `by`: the `--by` values (summaryFor:
 * a merged Objective read from its finish card's summary has no usage artifact read); `stages`: read every Objective's
 * stages, none from its summary (`--rates`). `download(repo, artifact, token)` reads
 * an artifact's result.json (github.mjs downloadArtifactResult). A BudgetStop ends the reads early, with what was read
 * kept and `source.stopped` set.
 */
export async function readReport(repo, scope, { token, fallback = null, maxCalls = DEFAULT_MAX_CALLS, appId = null, localCopy = null, envAppId = null, self = [], by = [], stages = false, download = downloadArtifactResult, checkout = null, cacheDir = reportCacheDir(repo.full), log = () => {} } = {}) {
  const opts = { token };
  const budget = new Budget(maxCalls, log);
  const source = { stopped: null, comments: 0, pullsRead: false, artifactsRead: new Set(), artifacts: { listed: 0, downloaded: 0, cached: 0, expired: 0, noResult: 0, failed: 0, unreadable: 0, foreign: 0 }, foreignIssues: new Set(), localRecords: 0, selfKnown: false, login: null, appFrom: appId !== null ? "flag" : null };
  const issues = new Map();
  const pulls = [];
  let comments = [];
  const artifacts = new Map();
  const summaries = new Map();
  // The merged Objectives read from their finish card's summary (summaryFor), from the comments read so far.
  const readSummaries = () => {
    summaries.clear();
    const mine = ownPredicate(app, self);
    for (const n of new Set([...issues.keys(), ...comments.map(markerIssue).filter((x) => x !== null)])) {
      const found = summaryFor(n, comments, scope, { mine, by, stages });
      if (found) summaries.set(n, found);
    }
  };
  const local = new Map();
  // Local mode's own records of an Objective in this clone, read once (no call).
  const localOf = (n) => {
    if (!local.has(n)) local.set(n, localRecords(checkout, n));
    return local.get(n);
  };
  const base = `repos/${repo.full}`;
  const objectiveLabel = DEFAULTS.objective_label;
  const named = scope.issues.length > 0;
  const setMode = setScope(scope);
  const vetted = vettedLabels(scope);
  // Per vetted label: the issues listed under it, and those whose latest `labeled` event is by someone who can push or not.
  const arms = vetted.map((label) => ({ label, listed: [], trusted: [], untrusted: [], unverifiable: [] }));
  const started = new Map();
  let app = appId;
  try {
    // What is known before any read: Pendulum's own login and App, the set, the comments, the Objectives' issues and PRs.
    const first = 1 + (app === null ? 1 : 0) + (named ? scope.issues.length * 3 : (scope.label ? 1 : 0) + (scope.parent ? 1 : 0) + (scope.compare?.length ?? 0) + 1 + (setMode ? 0 : 1) + 1);
    budget.plan(first, `the login${app === null ? ", the App id variable" : ""}, ${setMode ? "the Objective set" : "the period's Objectives"}, their comments and their PRs (a paged read's first page; each further page is planned when the first says how many)`, { atLeast: true });
    budget.take("user");
    try {
      const u = await rest("user", opts);
      if (u?.login) setSelf(u.type === "Bot" && !u.login.endsWith("[bot]") ? `${u.login}[bot]` : u.login);
    } catch (e) {
      if (e instanceof BudgetStop) throw e;
    }
    source.selfKnown = !!selfLogin();
    source.login = selfLogin();
    if (app === null) {
      // The variable, read again with the gh login's token when this one gets a 403 (app-id.mjs readAppIdVariable); then
      // the local copy, then local mode's notice App. With none, appFrom says why: `unset` or `forbidden`.
      // A budget stop on the second read keeps the first's reason, and the copy and env below still apply.
      let v;
      let stop = null;
      try {
        v = await readAppIdVariable(repo, { token, fallback, take: () => budget.take("app id"), plan: () => budget.plan(1, "the App id variable again, with the gh login's token (the token got HTTP 403 or 404)"), isStop: (e) => e instanceof BudgetStop, log: (line) => log(`pendulum report: ${line}`) });
      } catch (e) {
        if (!(e instanceof BudgetStop) || !e.appFirst) throw e;
        stop = e;
        v = { id: null, from: e.appFirst };
      }
      app = v.id;
      source.appFrom = v.from;
      // Why the variable gave no id, kept when the copy or the env stands in for it.
      source.appWhy = v.id === null ? v.from : null;
      source.appNotId = !!v.notId;
      const why = `the repository variable PENDULUM_APP_ID ${appIdWhyText(v)}`;
      if (app === null && localCopy?.id) {
        app = localCopy.id;
        source.appFrom = "local-copy";
        log(`pendulum report: the App id is the local copy's, ${app} (${localCopy.file}), unverified: ${why}`);
      } else if (app === null && localCopy?.problem) log(`pendulum report: the local copy of the App id is not taken: ${localCopy.problem}`);
      if (app === null && envAppId !== null) {
        app = envAppId;
        source.appFrom = "env";
        log(`pendulum report: the App id is PENDULUM_LOCAL_APP_ID's, ${app}, unverified: ${why}`);
      }
      if (stop) throw stop;
    }
    const mine = ownPredicate(app, self);
    const isIssue = (i) => i && !i.pull_request && Number.isSafeInteger(i.number);
    if (named) {
      // Each named issue, its own comments (planned from its comment count) and its own branch's PRs: no repository-wide read.
      for (const n of scope.issues) {
        budget.take("issues");
        let i = null;
        try {
          i = await rest(`${base}/issues/${n}`, opts);
        } catch (e) {
          if (e?.status !== 404) throw e;
        }
        if (!isIssue(i)) continue;
        issues.set(n, i);
        const pages = Math.max(1, Math.ceil((Number(i.comments) || 0) / PER_PAGE));
        if (pages > 1) budget.plan(pages - 1, `the other comment pages of #${n} (${i.comments} comments)`);
        const theirs = await paged(`${base}/issues/${n}/comments`, budget, "comments", opts);
        comments.push(...theirs);
      }
      for (const n of issues.keys()) pulls.push(...(await paged(`${base}/pulls?state=all&head=${encodeURIComponent(`${repo.owner}:pendulum/${n}`)}`, budget, "pulls", opts)));
      source.pullsRead = true;
    } else {
      const listed = async (label) => (await paged(`${base}/issues?labels=${encodeURIComponent(label)}&state=all${scope.since ? `&since=${encodeURIComponent(scope.since)}` : ""}`, budget, "issues", opts)).filter(isIssue);
      if (scope.label) for (const i of await listed(scope.label)) issues.set(i.number, i);
      for (const label of scope.compare ?? []) {
        for (const i of await listed(label)) {
          issues.set(i.number, i);
          arms.find((a) => a.label === label).listed.push(i.number);
        }
      }
      if (arms.length) {
        if (scope.label) arms[0].listed = [...issues.keys()];
        await vetArms(repo, arms, { budget, opts, started, objectiveLabel });
        // Only the Objectives a vetted label counts for are read on, and one both arms count for is in neither.
        for (const n of [...issues.keys()]) if (!armCounted(arms, n)) issues.delete(n);
      }
      if (scope.parent) for (const i of await paged(`${base}/issues/${scope.parent}/sub_issues`, budget, "issues", opts)) if (isIssue(i)) issues.set(i.number, i);
      // The comments: one paged read of the repository's, since the period's start or the set's oldest issue.
      const floor = scope.since ?? (setMode ? [...issues.values()].map((i) => i.created_at).filter(Boolean).sort()[0] ?? null : null);
      if (setMode && !issues.size) throw new NothingToRead();
      comments = await paged(`${base}/issues/comments${floor ? `?since=${encodeURIComponent(floor)}` : ""}`, budget, "comments", opts);
      // The period's Objectives: the labelled ones touched since its start, and each other issue with a stage of Pendulum's in it.
      if (!setMode) {
        for (const i of await paged(`${base}/issues?labels=${encodeURIComponent(objectiveLabel)}&state=all${floor ? `&since=${encodeURIComponent(floor)}` : ""}`, budget, "issues", opts)) if (isIssue(i)) issues.set(i.number, i);
        const marked = [...new Set(comments.map(markerIssue).filter((n) => n !== null && !issues.has(n)))];
        if (marked.length) budget.plan(marked.length, "the other issues Pendulum's markers are on");
        for (const n of marked) {
          budget.take("issues");
          try {
            const i = await rest(`${base}/issues/${n}`, opts);
            if (isIssue(i)) issues.set(n, i);
          } catch (e) {
            if (e?.status !== 404) throw e;
          }
        }
      }
      // The PRs on pendulum/<n> branches, newest first, until they are older than the comments read.
      let early = false;
      pulls.push(...(await paged(`${base}/pulls?state=all&sort=updated&direction=desc`, budget, "pulls", opts, { stop: (items) => (early = !!floor && ms(items.at(-1)?.updated_at) < ms(floor)) })));
      source.pullsRead = true;
      if (early) await olderPulls({ base, repo, floor, issues, pulls, comments, mine, setMode, budget, opts, source });
    }
    source.comments = comments.length;
    // The merged Objectives read from their finish card's summary: none of their stages' usage artifacts is read.
    readSummaries();
    // The usage artifacts of the Objectives with a stage of Pendulum's own in the period whose record the report needs: one
    // with no spend line (its dollars), or one whose comment has no per-pass ledger line beside its spend line (logic.mjs
    // ledgerOfComment: an older stage, or one whose ledger did not fit) and that no local record on this machine gives the
    // ledger of. A spend line's dollars stay the stage's (buildReport); the ledger gives its passes alone.
    const stageKey = (c) => /^<!-- pendulum:\d+:progress:(?:work|review):([A-Za-z0-9-]{1,100}) -->/.exec(c.body || "")?.[1] ?? null;
    const needs = (n) => !summaries.has(n) && comments.some((c) => markerIssue(c) === n && mine(c) && /^<!-- pendulum:\d+:progress:(?:work|review):/.test(c.body || "") && inWindow(c.created_at, scope) && (!spendParts(c.body) || (!Array.isArray(ledgerOfComment(c.body)?.ledger) && !Array.isArray(localOf(n).get(stageKey(c))?.ledger))));
    // Dollars before ledgers: the Objectives with a stage that has no spend line are read first, so a budget that runs
    // out costs per-pass detail before it costs a dollar figure.
    const unlinedIn = (n) => comments.some((c) => markerIssue(c) === n && mine(c) && /^<!-- pendulum:\d+:progress:(?:work|review):/.test(c.body || "") && inWindow(c.created_at, scope) && !spendParts(c.body));
    // A stage whose harness line and ledger line name no model (Copilot at its default model) has it only in its usage
    // record, read for it as the finish card reads it (finish-card.mjs modellessStages), unless local mode's own record of
    // it on this machine names it.
    const modelless = (n) => !summaries.has(n) && modellessStages(comments.filter((c) => markerIssue(c) === n && inWindow(c.created_at, scope)), n, mine).some((s) => !modelKey(localOf(n).get(s.key)?.model));
    const wanted = [...issues.keys()].filter((n) => needs(n) || modelless(n)).sort((a, b) => Number(unlinedIn(b)) - Number(unlinedIn(a)) || a - b);
    source.artifactsWanted = new Set(wanted);
    if (wanted.length) budget.plan(wanted.length * 2, `the usage artifact lists of ${wanted.length} Objective(s) with a stage whose dollars, per-pass ledger or model only its usage record holds`);
    for (const n of wanted) {
      const found = [];
      for (const name of [`pendulum-usage-${n}`, `pendulum-usage-${n}-review`]) {
        try {
          found.push(...(await paged(`${base}/actions/artifacts?name=${encodeURIComponent(name)}`, budget, "artifact lists", opts)));
        } catch (e) {
          if (e?.status !== 403 && e?.status !== 404) throw e;
          source.artifacts.unreadable += 1;
        }
      }
      // An artifact uploaded before the period began is of no stage in it (a stage's artifact follows its start).
      const own = found.filter((a) => Number.isSafeInteger(a?.id) && typeof a.name === "string" && /^[A-Za-z0-9._-]+$/.test(a.name) && ownRunArtifact(a) && (!scope.since || !(ms(a.created_at) < ms(scope.since))));
      const downloads = own.filter((a) => !cachedRecord(cacheDir, a.id) && Number.isSafeInteger(a.workflow_run?.id) && !a.expired).length;
      if (downloads) budget.plan(downloads * 2, `downloading #${n}'s ${downloads} usage artifact(s) not yet cached`);
      const recs = [];
      for (const a of found) {
        if (!Number.isSafeInteger(a?.id) || typeof a.name !== "string" || !/^[A-Za-z0-9._-]+$/.test(a.name)) continue;
        // A fork's run can upload an artifact of any name: never Pendulum's record.
        if (!ownRunArtifact(a)) {
          source.artifacts.foreign += 1;
          source.foreignIssues.add(n);
          continue;
        }
        if (scope.since && ms(a.created_at) < ms(scope.since)) continue;
        source.artifacts.listed += 1;
        const run = Number.isSafeInteger(a.workflow_run?.id) ? a.workflow_run.id : null;
        const kept = cachedRecord(cacheDir, a.id);
        let result;
        if (kept) {
          source.artifacts.cached += 1;
          result = kept.result;
        } else if (run === null) {
          source.artifacts.unreadable += 1;
          continue;
        } else if (a.expired) {
          source.artifacts.expired += 1;
          continue;
        } else {
          budget.take("artifact downloads");
          budget.take("artifact downloads");
          try {
            result = recordFields(await download(repo, a, token));
          } catch {
            source.artifacts.failed += 1;
            continue;
          }
          source.artifacts.downloaded += 1;
          keepRecord(cacheDir, a.id, result ?? null);
        }
        if (result && typeof result === "object" && result.harness) recs.push({ ...result, runs: result.runs ?? 1, artifact: a.name, ...(run !== null ? { workflowRun: run } : {}) });
        else {
          source.artifacts.noResult += 1;
          recs.push(noResult(a.name, run));
        }
      }
      artifacts.set(n, recs);
      source.artifactsRead.add(n);
    }
  } catch (e) {
    if (e instanceof BudgetStop) source.stopped = e.what;
    else if (!(e instanceof NothingToRead)) throw e;
  }
  // A budget stop during the label check leaves issues no label was found to count for: none of their records is read.
  if (arms.length) for (const n of [...issues.keys()]) if (!armCounted(arms, n)) issues.delete(n);
  // A budget stop after the comments were read keeps their summaries.
  readSummaries();
  for (const n of issues.keys()) localOf(n);
  source.localRecords = [...local.values()].reduce((s, m) => s + m.size, 0);
  return { repo, scope, appId: app, self: [...new Set((self || []).map(loginKey))], issues, pulls, comments, artifacts, summaries, local, ...(arms.length ? { arms, started } : {}), source: { ...source, calls: budget } };
}

/**
 * The PRs the period's PR list stopped before (#566): it ends at its first page older than `floor`, so it holds every PR
 * updated since then, and a PR on `pendulum/<n>` is created after issue <n> and updated after that. A closed Objective
 * whose end its PRs decide (no state label) and whose issue was created before the floor, with no PR from the repository
 * itself on its branch created since then in the list, may have its newest PR past the stop: its branch's own PRs are
 * read (one paged read each, planned), as `--issue` reads them. Only the Objectives the report can show: in a set, each;
 * in a period, each with a marker among the comments read that counts (`mine`, Pendulum's own, or one by someone who can
 * push or through another App, which counts as unknown cost); a stranger's paste reads no PR. `source.pullsUnread` keeps those whose read
 * the call budget stopped (their outcome is then null).
 */
async function olderPulls({ base, repo, floor, issues, pulls, comments, mine, setMode, budget, opts, source }) {
  const marked = new Set(comments.filter((c) => mine(c) || pushAuthor(c) || throughApp(c)).map(markerIssue).filter((n) => n !== null));
  const decided = (i) => (i.labels || []).some((l) => ["Blocked", "Question"].includes(STATE_LABELS[typeof l === "string" ? l : l?.name]));
  const want = [...issues.values()]
    .filter((i) => i.state === "closed" && !decided(i) && ms(i.created_at) < ms(floor) && (setMode || marked.has(i.number)) && !(ms(newestPull(i.number, pulls)?.created_at) >= ms(floor)))
    .map((i) => i.number)
    .sort((a, b) => a - b);
  if (!want.length) return;
  source.pullsUnread = new Set(want);
  budget.plan(want.length, `the PRs of ${want.length} closed Objective(s) created before the PR list's stop, on their own branches (a paged read's first page each)`);
  const seen = new Set(pulls.map((p) => p?.number));
  for (const n of want) {
    for (const p of await paged(`${base}/pulls?state=all&head=${encodeURIComponent(`${repo.owner}:pendulum/${n}`)}`, budget, "pulls", opts)) {
      if (seen.has(p?.number)) continue;
      seen.add(p?.number);
      pulls.push(p);
    }
    source.pullsUnread.delete(n);
  }
}

/** Whether a vetted label's check ended for issue `n` (trusted, untrusted or not verifiable). */
const checked = (arm, n) => arm.trusted.includes(n) || arm.untrusted.includes(n) || arm.unverifiable.includes(n);
/**
 * Whether the vetted labels count issue `n`: every arm that lists it was checked, and exactly one of them trusts its label
 * (one both arms count for is in neither).
 */
const armCounted = (arms, n) => arms.every((a) => !a.listed.includes(n) || checked(a, n)) && arms.filter((a) => a.trusted.includes(n)).length === 1;

/** The latest `labeled` event of `label` (its name in any case, as GitHub matches labels) among timeline `events`: {at, actor}. */
const latestLabeled = (events, label) => {
  let out = null;
  for (const e of events || []) if (e?.event === "labeled" && String(e.label?.name ?? "").toLowerCase() === label.toLowerCase() && (!out || ms(e.created_at) > ms(out.at))) out = { at: e.created_at, actor: e.actor ?? null };
  return out;
};

/**
 * Who applied each vetted label (#545): each listed issue's timeline, read once (paged, within the budget), and each
 * label's latest `labeled` event on it vouched for as the choice labels are (objective-trust.mjs labelsVouched: a person
 * who can push, or a pinned maintainer; never a bot or an App), each labeller's permission read once. Fills each arm's
 * `trusted`, `untrusted` and `unverifiable` (the labeller's permission could not be read: a 403, so not vouched for), and
 * `started` with when each issue's Objective started (finish-card.mjs labelTime, the scorer's start of its wall clock).
 * A BudgetStop leaves the rest unchecked.
 */
async function vetArms(repo, arms, { budget, opts, started, objectiveLabel }) {
  const all = [...new Set(arms.flatMap((a) => a.listed))].sort((a, b) => a - b);
  if (!all.length) return;
  budget.plan(all.length, `the timelines of the ${all.length} Objective(s) labelled ${arms.map((a) => a.label).join(" or ")}: who applied the label (a paged read's first page each)`);
  const permissions = new Map();
  const unreadable = new Set();
  const permission = async (r, login, o) => {
    const key = loginKey(login);
    if (!permissions.has(key)) {
      budget.plan(1, "a labeller's permission on the repository");
      budget.take("permissions");
      try {
        permissions.set(key, await collaboratorPermission(r, login, o));
      } catch (e) {
        // A token that may not read collaborators' permissions: this labeller cannot be vouched for, and that is said.
        if (e?.status !== 403) throw e;
        permissions.set(key, null);
        unreadable.add(key);
      }
    }
    return permissions.get(key);
  };
  for (const n of all) {
    const events = await paged(`repos/${repo.full}/issues/${n}/timeline`, budget, "timelines", opts);
    const start = labelTime(null, events, objectiveLabel);
    if (start) started.set(n, start);
    for (const arm of arms.filter((a) => a.listed.includes(n))) {
      const last = latestLabeled(events, arm.label);
      const refused = await labelsVouched(repo, n, [arm.label], opts, { labelers: async () => ({ [arm.label]: last }), permission });
      arm[!refused ? "trusted" : last?.actor?.login && unreadable.has(loginKey(last.actor.login)) ? "unverifiable" : "untrusted"].push(n);
    }
  }
}

/** Whether a time falls in the scope's period: at or after `since`, before `until`. */
export const inWindow = (at, scope) => (!scope.since || ms(at) >= ms(scope.since)) && (!scope.until || ms(at) < ms(scope.until));
/** Whether a decision-spend line's UTC day counts in the scope's period: its start (the day's midnight) falls in it. */
const dayInWindow = (date, scope) => inWindow(`${date}T00:00:00Z`, scope);

// ------------------------------------------------------------------ figures

/**
 * A cost-join part (costOf's), with its record's sandbox booking, as a cost split by kind. A booking two records carry
 * (one claim) counts once, on the last of them, as cost-join.mjs vendorOf counts it (`books`: whether this record does).
 */
function partCost(part, rec, books) {
  const c = zeroCost();
  const known = num(part.usd);
  const by = part.usdByBilling || {};
  let named = 0;
  for (const k of BILLING) {
    if (num(by[k]) !== null) {
      c.usd[k] = round6(by[k]);
      named += by[k];
    }
  }
  // Known dollars no record names a billing for: billing not recorded.
  if (known !== null && known - named > 1e-9) c.usd.unknown = round6(c.usd.unknown + known - named);
  c.unknownRuns = Number.isInteger(part.usdUnknown) ? part.usdUnknown : 0;
  c.unknownWhy = c.unknownRuns ? [...(part.usdUnknownWhy?.length ? part.usdUnknownWhy : ["unreported"])] : [];
  // The sandbox vendor's cost, booked once per stage (its claim), beside the model's (cost-join.mjs vendorOf).
  const v = rec.vendor;
  if (v && typeof v === "object" && books) {
    if (num(v.usd) !== null) c.usd.sandbox = round6(Math.max(0, v.usd));
    if (num(v.usd) === null || v.usageUnknown === true || (v.usdUnknown ?? 0) > 0) {
      c.unknownRuns += 1;
      c.unknownWhy = [...new Set([...c.unknownWhy, "sandbox"])];
    }
  }
  c.unknownWhy = c.unknownWhy.filter((w) => Object.hasOwn(UNKNOWN_WHY, w)).sort();
  return c;
}

/**
 * A finish card summary stage's cost (finish-card.mjs finishSummary) split by kind, as partCost splits a record's: its
 * known dollars by billing, those no billing names as `unknown`, and its cloud sandbox's own cost (`sandbox`) as
 * `sandbox`; its runs of unknown cost with their reasons (`why`, and `sandboxWhy` for the sandbox's).
 */
function summaryCost(stage, sandbox, why, sandboxWhy) {
  const c = zeroCost();
  let named = 0;
  for (const k of BILLING) {
    const v = num(stage.byBilling?.[k]);
    if (v !== null) {
      c.usd[k] = round6(v);
      named += v;
    }
  }
  if (num(stage.usd) !== null && stage.usd - named > 1e-9) c.usd.unknown = round6(c.usd.unknown + stage.usd - named);
  c.unknownRuns = stage.unknown;
  c.unknownWhy = stage.unknown ? [...why] : [];
  if (sandbox) {
    c.usd.sandbox = round6(sandbox.usd);
    c.unknownRuns += sandbox.unknown;
    if (sandbox.unknown) c.unknownWhy = [...c.unknownWhy, ...sandboxWhy];
  }
  c.unknownWhy = [...new Set(c.unknownWhy)].filter((w) => Object.hasOwn(UNKNOWN_WHY, w)).sort();
  return c;
}

/**
 * An Objective's end (OUTCOMES): Blocked or Question by its state label; else open while its issue is open; else merged
 * when the newest PR on its branch from this repository itself (not a fork's: `head.repo.id` is `base.repo.id`) merged,
 * else closed unmerged. Null for a closed one whose PRs were not read (`pullsRead` false: the call budget stopped first).
 */
export function outcomeOf(issue, pulls, { pullsRead = true } = {}) {
  const names = (issue?.labels || []).map((l) => (typeof l === "string" ? l : l?.name));
  if (names.some((n) => STATE_LABELS[n] === "Blocked")) return "blocked";
  if (names.some((n) => STATE_LABELS[n] === "Question")) return "question";
  if (issue?.state !== "closed") return "open";
  if (!pullsRead) return null;
  return newestPull(issue.number, pulls)?.merged_at ? "merged" : "closed-unmerged";
}

/** The newest PR on Objective `n`'s branch from this repository itself (not a fork's), or undefined. */
const newestPull = (n, pulls) => (pulls || []).filter((p) => p?.head?.ref === `pendulum/${n}` && p.head?.repo?.id === p.base?.repo?.id).sort((a, b) => ms(b.created_at) - ms(a.created_at))[0];

/** A breakdown's rows: one per key, in the order of their first stage, each with its stage count, cost and tokens. */
function breakdown() {
  const rows = new Map();
  return {
    add(key, cost, tokens, count = 1) {
      const k = key ?? null;
      const r = rows.get(k) ?? { key: k, stages: 0, cost: zeroCost(), tokens: zeroTokens() };
      r.stages += count;
      addCost(r.cost, cost);
      addTokens(r.tokens, tokens);
      rows.set(k, r);
    },
    rows: () => [...rows.values()],
  };
}

/**
 * The report's figures from what readReport read (pure). `prices`: the Codex price table (cost-join.mjs loadPrices).
 * `by`: the extra breakdowns asked for (`account`). `rates`: the candidate models of `--rates` (rateRatios), or null.
 * `tables`: the published rate tables (rateTables). `now`: when it was made (ISO).
 */
export function buildReport(read, { prices = loadPrices(), by = [], rates = null, tables = rateTables(prices), now = new Date().toISOString() } = {}) {
  const { repo, scope, issues, pulls, comments, artifacts, local, source } = read;
  const mine = ownPredicate(read.appId ?? null, read.self ?? []);
  const pushed = (c) => pushAuthor(c) || throughApp(c);
  const totals = zeroCost();
  const totalTokens = zeroTokens();
  const unknownItems = [];
  // The stages among them (a decision record, or a vendor comment with no stage of its own, is none).
  let unknownStages = 0;
  const mixes = mixBook(prices);
  const views = { stage: breakdown(), pass: breakdown(), model: breakdown(), harness: breakdown(), version: breakdown(), account: breakdown() };
  const passMinutes = new Map();
  const cacheByKind = new Map();
  const objectives = [];
  // Review findings (#546): by reviewer and by review stage, beside the review stages' dollars.
  const findingRows = new Map();
  const findingStages = [];
  const findingTotals = { findings: 0, outcomes: zeroOutcomes(), reviewStages: 0, cost: zeroCost(), unnamed: 0 };
  const trust = { own: 0, vouched: 0, ignored: 0 };
  const missing = { noRecord: tally(), stopped: tally(), unattributed: tally(), noLedger: tally(), noVersion: tally(), noModel: tally(), modelStopped: tally(), unreadIssue: new Set() };
  // The merged Objectives read from their finish card's summary (readReport, summaryFor), unless `by` or `rates` needs
  // their stages.
  const summaries = rates || by.some((b) => STAGE_DETAIL.includes(b)) ? new Map() : read.summaries ?? new Map();
  let stagesSeen = 0;
  let summariesUsed = 0;
  let passesSeen = 0;
  // The arms' measures that are no field of an Objective's row (#545): the minutes of every harness pass, and the wall clock.
  const armMeasures = new Map();
  // With vetted labels, only the Objectives exactly one of them counts for (readReport vetArms): in an arm, not in both.
  const counted = read.arms ? new Set([...issues.keys()].filter((n) => armCounted(read.arms, n))) : null;

  // Each comment with a marker on its own issue, by its author: Pendulum's own, someone it cannot attribute, or ignored.
  const byIssue = new Map();
  for (const c of comments || []) {
    const n = markerIssue(c);
    if (n === null) continue;
    const who = mine(c) ? "own" : pushed(c) ? "vouched" : "ignored";
    trust[who] += 1;
    if (who === "ignored") continue;
    const list = byIssue.get(n) ?? { own: [], vouched: [] };
    list[who].push(c);
    byIssue.set(n, list);
  }

  const numbers = [...new Set([...(issues?.keys() ?? []), ...byIssue.keys()])].sort((a, b) => a - b);
  for (const n of numbers) {
    const issue = issues?.get(n) ?? null;
    const setMode = setScope(scope);
    if (setMode && !issue) continue;
    if (counted && !counted.has(n)) continue;
    const summary = summaries.get(n)?.summary ?? null;
    // An Objective read from its summary: the summary stands for its stage comments, Pendulum's and anyone's who can push.
    const { own: ownAll = [], vouched: vouchedAll = [] } = byIssue.get(n) ?? {};
    const isStage = (c) => new RegExp(`^<!-- pendulum:${n}:(?:progress|vendor):`).test(c.body || "");
    const own = summary ? ownAll.filter((c) => !isStage(c)) : ownAll;
    const vouched = summary ? vouchedAll.filter((c) => !isStage(c)) : vouchedAll;
    const sorted = (list) => [...list].sort((a, b) => ms(a.created_at) - ms(b.created_at));
    const progress = new RegExp(`^<!-- pendulum:${n}:progress:(work|review)[:\\s-]`);
    const vendorHead = new RegExp(`^<!-- pendulum:${n}:vendor:(work|review)[:\\s-]`);
    const keyOf = (body, kind) => new RegExp(`^<!-- pendulum:${n}:${kind}:([A-Za-z0-9:-]{1,100}) -->`).exec(body || "")?.[1] ?? null;
    // A progress comment's run key, as its stage's usage record names it (`progressRun`; stageSpendRecords reads it so).
    const runOf = (body) => new RegExp(`^<!-- pendulum:${n}:progress:(?:work|review):([A-Za-z0-9-]{1,100}) -->`).exec(body || "")?.[1] ?? null;
    const allStages = sorted(own.filter((c) => progress.test(c.body || "")));
    const allVendors = sorted(own.filter((c) => vendorHead.test(c.body || "")));
    const stages = allStages.filter((c) => inWindow(c.created_at, scope));
    const stageKeys = new Set(stages.map((c) => keyOf(c.body, "progress")));
    const vendors = allVendors.filter((c) => stageKeys.has(keyOf(c.body, "vendor")) || (!allStages.some((p) => keyOf(p.body, "progress") === keyOf(c.body, "vendor")) && inWindow(c.created_at, scope)));
    // The comments Pendulum cannot attribute to itself: a progress comment is a stage of unknown cost; a vendor comment
    // of a stage that has a progress comment adds nothing, and one alone is a run of unknown cost but no stage; one with
    // decision-spend lines is decision calls of unknown cost.
    const progressKeys = new Set([...own, ...vouched].filter((c) => progress.test(c.body || "")).map((c) => keyOf(c.body, "progress")));
    const theirStages = sorted(vouched.filter((c) => progress.test(c.body || "") && inWindow(c.created_at, scope)));
    const theirVendors = sorted(vouched.filter((c) => vendorHead.test(c.body || "") && !progressKeys.has(keyOf(c.body, "vendor")) && inWindow(c.created_at, scope)));
    const theirDecisions = sorted(vouched.filter((c) => !progress.test(c.body || "") && !vendorHead.test(c.body || "") && decisionSpendRecords(n, [c], { keep: (e) => dayInWindow(e.date, scope) }).length));
    const decisions = decisionSpendRecords(n, sorted(own), { keep: (e) => dayInWindow(e.date, scope) });
    if (!summary && !stages.length && !vendors.length && !theirStages.length && !theirVendors.length && !theirDecisions.length && !decisions.length && !setMode) continue;
    if (!issue) missing.unreadIssue.add(n);

    // Every stage once (cost-join.mjs withLines): a stage with no spend line by its usage record when one was read, else
    // as unknown; a stage with a spend line by its line, its usage record giving only its per-pass ledger, version and
    // model (`ledgerOf`), so no dollar is counted twice. A record of a stage outside the period is left out; one that names no
    // stage counts when it ended in the period.
    const allLines = stageSpendRecords(n, allStages, allVendors, { all: true });
    const lines = stageSpendRecords(n, stages, vendors, { all: true });
    const lineKeys = new Set(lines.map((l) => l.progressRun));
    const unlined = new Set(stages.filter((c) => !spendParts(c.body)).map((c) => runOf(c.body)));
    const ledgerOf = new Map();
    // The stage comments Pendulum cannot attribute to itself, as lines: a record that names one of them is that stage's
    // own record, the same stage, so it is neither counted beside it nor its dollars taken (that stage stays unknown).
    const theirLines = stageSpendRecords(n, sorted(vouched.filter((c) => progress.test(c.body || ""))), [], { all: true });
    const records = (summary ? [] : artifacts?.get(n) || []).filter((r) => {
      const covered = allLines.filter(coversLine(r));
      if (!covered.length) return !theirLines.some(coversLine(r)) && inWindow(r.ended ?? r.started, scope);
      const inPeriod = covered.filter((l) => lineKeys.has(l.progressRun));
      if (!inPeriod.length) return false;
      if (inPeriod.some((l) => unlined.has(l.progressRun))) return true;
      for (const l of inPeriod) if (!ledgerOf.has(l.progressRun) || r.standIn !== true) ledgerOf.set(l.progressRun, r);
      return false;
    });
    const joined = withLines(records, lines);
    // Whether this Objective's usage records were read: when the call budget stopped first, its stages are `stopped`.
    const notReached = !!source.stopped && !source.artifactsRead?.has(n);
    for (const r of joined) {
      // A stage of Pendulum's with no spend line and no record read for it: its cost is unknown, and why. An artifact of
      // it that was read and holds no result.json (its stage ended before writing one) gives way to the comment: its
      // harness never reported the cost (`unreported`), and its record was read.
      if (r.source === "spend" && unlined.has(r.progressRun) && r.usd === null && !r.usdUnknown) {
        const noResult = records.some((x) => x.noResult === true && coversLine(x)(r));
        r.usdUnknown = 1;
        r.usdUnknownWhy = [notReached ? "stopped" : noResult ? "unreported" : "no-record"];
        if (!noResult) missing[notReached ? "stopped" : "noRecord"].add(n);
      }
    }
    // What Pendulum cannot attribute to itself: runs of unknown cost, never their figures.
    const unattributedRec = (c, stage, extra = {}) => ({ source: "spend", unattributed: true, harness: null, model: null, usd: null, usdUnknown: 1, usdUnknownWhy: ["unattributed"], tokens: zeroTokens(), runs: 1, artifact: `spend/${stage}/${c.id}`, ...extra });
    const unattributed = [...theirStages.map((c) => unattributedRec(c, progress.exec(c.body || "")[1])), ...theirVendors.map((c) => unattributedRec(c, vendorHead.exec(c.body || "")[1], { notStage: true }))];
    const theirCalls = theirDecisions.map((c) => ({ source: "decisions", unattributed: true, harness: null, model: null, usd: null, usdUnknown: 1, usdUnknownWhy: ["unattributed"], tokens: zeroTokens(), basis: `unknown: decision-spend lines in comment ${c.id}, not attributed` }));
    if (unattributed.length || theirCalls.length) missing.unattributed.add(n, theirStages.length);
    const all = [...joined, ...unattributed, ...decisions, ...theirCalls];
    // Each sandbox booking once, on the last record that carries its claim (cost-join.mjs vendorOf).
    const claimOf = (r) => (typeof r?.vendor?.claim === "string" && /^[0-9a-f]{12}$/.test(r.vendor.claim) ? r.vendor.claim : null);
    const lastByClaim = new Map(all.map((r, i) => [claimOf(r), i]).filter(([k]) => k !== null));
    const cost = costOf(all, prices);

    // Each part's stage: its comment (by the key it names or covers), for its kind (a rebase), harness, model and account.
    const comment = (r) => {
      const keys = r.source === "spend" ? [r.progressRun] : lines.filter(coversLine(r)).map((l) => l.progressRun);
      return stages.find((c) => keys.includes(runOf(c.body))) ?? null;
    };
    const localRecs = local?.get(n) ?? new Map();
    // Each review stage's dollars and model, by its run key, for the findings it raised (#546).
    const reviewStages = new Map();
    const row = { issue: n, title: typeof issue?.title === "string" ? issue.title : null, url: `https://github.com/${repo.full}/issues/${n}`, outcome: issue ? outcomeOf(issue, pulls, { pullsRead: source.pullsRead !== false && !source.pullsUnread?.has(n) }) : null, stages: { work: 0, rebase: 0, review: 0 }, passes: null, cost: zeroCost(), tokens: zeroTokens(), modelMinutes: null, usdPerModelMinute: null };
    const minutes = { priced: 0, passes: 0, usd: zeroCost(), unpriced: 0, all: 0, untimed: 0 };
    let ledgered = 0;
    let unledgered = 0;
    // A stage's passes (pass-figures.mjs stagePassFigures, by kind) into the Objective's and the report's figures.
    const foldPasses = (figures) => {
      ledgered += 1;
      row.passes ??= { total: 0, answer: 0, fix: 0 };
      for (const k of figures) {
        passesSeen += k.passes;
        row.passes.total += k.passes;
        if (isAnswer(k.kind)) row.passes.answer += k.passes;
        if (isFix(k.kind)) row.passes.fix += k.passes;
        views.pass.add(k.kind, k.cost, k.tokens, k.passes);
        if (k.cache) {
          const c = cacheByKind.get(k.kind) ?? { passLabel: k.kind, passes: 0, written: 0, input: 0 };
          c.passes += k.cache.passes;
          c.written += k.cache.written;
          c.input += k.cache.input;
          cacheByKind.set(k.kind, c);
        }
        if (k.minutes !== null) passMinutes.set(k.kind, (passMinutes.get(k.kind) ?? 0) + k.minutes);
        // Every harness pass's minutes, and the harness passes with no times (the arms' model minutes, #545).
        minutes.all += k.harnessMinutes ?? 0;
        minutes.untimed += k.untimed;
        // Cost per model minute: over the harness passes whose dollars were all reported, each kind's dollars apart.
        minutes.unpriced += k.unpriced;
        minutes.priced += k.priced.minutes;
        minutes.passes += k.priced.passes;
        addCost(minutes.usd, k.priced.cost);
      }
    };
    // Stages Pendulum cannot attribute to itself: no ledger of theirs is read, so the arm measures leave this Objective out.
    let unattributedStages = 0;
    if (summary) {
      // Its stages as its finish card counted them, each with the cost, tokens, release and passes the card recorded, in
      // the order the stage path counts them (Pendulum's stages, then its sandbox stages with no progress comment, then
      // those it cannot attribute and their vendor comments), before the decision calls outside a stage (cost.parts).
      summariesUsed += 1;
      const count = (kind, c, s, stage) => {
        const tokens = s.tokens ?? zeroTokens();
        const model = modelName(s.model, prices);
        addCost(row.cost, c);
        addCost(totals, c);
        addTokens(row.tokens, tokens);
        addTokens(totalTokens, tokens);
        views.stage.add(kind, c, tokens, stage ? 1 : 0);
        views.harness.add(s.harness ?? null, c, tokens, stage ? 1 : 0);
        views.model.add(model, c, tokens, stage ? 1 : 0);
        views.version.add(s.version ?? null, c, tokens, stage ? 1 : 0);
        if (stage) {
          stagesSeen += 1;
          row.stages[kind] += 1;
          if (!s.version && !s.unattributed) missing.noVersion.add(n);
          if (!model && !s.unattributed) missing.noModel.add(n);
        }
        if (c.unknownRuns) unknownItems.push({ issue: n, stage: kind, runs: c.unknownRuns, why: c.unknownWhy });
        if (c.unknownRuns && stage) unknownStages += 1;
        // A review stage's dollars and model, by its run key, for the findings it raised (#546), as the stage path keeps them.
        if (stage && kind === "review" && s.key && !s.unattributed) {
          const r = reviewStages.get(s.key) ?? { cost: zeroCost(), model };
          addCost(r.cost, c);
          reviewStages.set(s.key, r);
        }
        // Its passes (summaryFor reads a card only when every stage of Pendulum's own has them).
        if (stage && s.unattributed) unattributedStages += 1;
        else if (stage) foldPasses(s.passes);
      };
      const ordered = [...summary.stages.filter((s) => !s.unattributed && s.ms !== null), ...summary.stages.filter((s) => !s.unattributed && s.ms === null), ...summary.stages.filter((s) => s.unattributed)];
      for (const s of ordered) count(reportStageKind(s.kind), summaryCost(s, s.sandbox, s.why, s.sandbox?.unknown ? ["sandbox"] : []), s, true);
      // Each vendor comment Pendulum cannot attribute, with no stage of its own: a run of unknown cost of its stage's kind.
      const foreign = summary.sandbox?.foreign ?? [];
      for (const kind of foreign) count(kind, summaryCost({ usd: 0, unknown: 0, byBilling: {} }, { usd: 0, unknown: 1 }, [], ["unattributed"]), {}, false);
      if (foreign.length || summary.stages.some((s) => s.unattributed)) missing.unattributed.add(n, summary.stages.filter((s) => s.unattributed).length);
    }
    cost.parts.forEach((part, i) => {
      const rec = all[i];
      const c = partCost(part, rec, claimOf(rec) === null || lastByClaim.get(claimOf(rec)) === i);
      const at = rec.source === "decisions" ? null : comment(rec);
      const stageKind = rec.source === "decisions" ? "decisions" : stageOf(rec) === "review" ? "review" : at && rebaseCostOf(at.body) ? "rebase" : "work";
      const line = at ? stageHarnessOf(at.body) : null;
      const key = at ? runOf(at.body) : typeof rec.progressRun === "string" ? rec.progressRun : null;
      const localRec = key ? localRecs.get(key) : null;
      // A lined stage's usage record, read for its ledger and version alone.
      const recordOf = rec.source === "spend" && key ? ledgerOf.get(key) ?? null : null;
      // A lined stage's per-pass ledger line, beside the spend line in its own progress comment (logic.mjs ledgerOfComment):
      // its passes, model, release and tokens with no artifact read. Never its dollars: those are the spend line's.
      const written = rec.source === "spend" && !rec.unattributed && at && spendParts(at.body) ? ledgerOfComment(at.body) : null;
      const onComment = Array.isArray(written?.ledger) ? written : null;
      // A lined stage's tokens, from where its ledger comes (below), as its finish card takes them: its ledger line's
      // passes', else its usage record's, else local mode's own record's of it in this clone. A spend line carries none,
      // so none is counted twice.
      const tokens = onComment ? onComment.ledger.reduce((t, p) => addTokens(t, p.tokens), zeroTokens()) : ([recordOf, localRec].map((x) => (rec.source === "spend" ? x?.tokens : null)).find((t) => t && typeof t === "object") ?? part.tokens);
      const harness = rec.source === "decisions" ? "decisions" : HARNESSES.has(rec.harness) ? rec.harness : HARNESSES.has(line?.harness) ? line.harness : null;
      // A stage's model from its own records alone, as the finish card names it (finish-card.mjs objectiveStages): its
      // harness line's, else its ledger line's, else its usage record's (Copilot's default model is known only from the
      // run's record) or local mode's own record of it; never another stage's. Null when none names one (`no-model`).
      const recorded = rec.source === "decisions" ? "decisions" : (modelKey(line?.model) ?? modelKey(onComment?.model) ?? modelKey((rec.source === "spend" ? recordOf : rec)?.model) ?? modelKey(localRec?.model));
      // One name per model (modelName); the `--rates` mix keeps the recorded id, its rows named so in turn (mixBook).
      const model = rec.source === "decisions" ? "decisions" : modelName(recorded, prices);
      if (model === null && !rec.unattributed && !rec.notStage) missing[notReached && source.artifactsWanted?.has(n) ? "modelStopped" : "noModel"].add(n);
      // The Pendulum release from the first record that names one, or the ledger line's (a harness line names none).
      const version = [rec.ran?.pendulum, onComment?.version, recordOf?.ran?.pendulum, localRec?.ran?.pendulum].find((v) => typeof v === "string" && VERSION.test(v)) ?? null;
      const account = rec.source === "decisions" ? null : [rec.account, line?.account].find((a) => typeof a === "string" && ACCOUNT.test(a)) ?? null;
      addCost(row.cost, c);
      addCost(totals, c);
      if (stageKind === "review" && key && !rec.unattributed) {
        const s = reviewStages.get(key) ?? { cost: zeroCost(), model };
        addCost(s.cost, c);
        reviewStages.set(key, s);
      }
      addTokens(row.tokens, tokens);
      addTokens(totalTokens, tokens);
      // A sandbox booking with no stage of its own counts its cost, but no stage.
      const count = rec.notStage ? 0 : 1;
      views.stage.add(stageKind, c, tokens, count);
      views.harness.add(harness, c, tokens, count);
      views.model.add(model, c, tokens, count);
      // The stage's per-pass ledger, as its finish card takes it (finish-card.mjs objectiveStages), so the card path and
      // the stage path give the same figures whatever else of the Objective is read: its progress comment's ledger line
      // (times to the second), else its usage record's or local mode's own record of it (to the millisecond). A record
      // the cost join withheld as `unmatched` (cost-join.mjs withLines: it may be another stage's) gives no passes.
      const unmatched = rec.unmatched === true;
      const ledger = unmatched ? null : ([onComment, rec, recordOf, localRec].map((x) => x?.ledger).find(Array.isArray) ?? null);
      // The token mix `--rates` weighs (mixBook): a stage's whole tokens from its record when one is at hand (with its
      // long-context share and its sub-agent threads), else as the model breakdown counts them; split by its ledger's
      // passes when they ran on more than one model. The Objective's worker and sub-agent models from its harness line's
      // or record's `ran`.
      if (rates && rec.source !== "decisions" && !rec.notStage && !rec.unattributed) {
        const src = rec.source === "spend" ? recordOf ?? (localRec?.tokens ? localRec : null) : rec;
        const whole = src?.tokens && typeof src.tokens === "object" ? src.tokens : tokens;
        const ran = (k) => modelKey(line?.ran?.[k]) ?? modelKey(src?.ran?.[k]);
        // The mix splits a stage by its passes' models, which its record names in full where the ledger line may not.
        const mixLedger = unmatched ? null : ([rec, recordOf, localRec, onComment].map((x) => x?.ledger).find(Array.isArray) ?? null);
        mixes.stage(recorded, whole, { subs: harness === "codex" && whole === src?.tokens ? src.subAgents ?? [] : null, ledger: mixLedger, worker: ran("worker"), subagent: ran("subagent") });
      }
      views.version.add(rec.source === "decisions" ? "decisions" : version, c, tokens, count);
      if (by.includes("account")) views.account.add(rec.source === "decisions" ? "decisions" : account, c, tokens, count);
      if (rec.source !== "decisions" && !rec.notStage) {
        stagesSeen += 1;
        row.stages[stageKind] += 1;
        if (!version && !rec.unattributed) missing.noVersion.add(n);
      }
      if (c.unknownRuns) unknownItems.push({ issue: n, stage: stageKind, runs: c.unknownRuns, why: c.unknownWhy });
      if (c.unknownRuns && rec.source !== "decisions" && !rec.notStage) unknownStages += 1;
      // The stage's passes, from its per-pass ledger.
      if (rec.unattributed && !rec.notStage) unattributedStages += 1;
      if (rec.source === "decisions" || rec.unattributed || unmatched) return;
      if (!ledger) {
        unledgered += 1;
        // The call budget stopped before this Objective's usage records were read: said by stage, apart from a record
        // that holds no ledger.
        if (notReached && source.artifactsWanted?.has(n)) (missing.ledgerStopped ??= []).push({ issue: n, stage: stageKind, key });
        else missing.noLedger.add(n);
        return;
      }
      foldPasses(stagePassFigures(ledger));
    });
    if (ledgered && !unledgered) {
      row.modelMinutes = round2(minutes.priced);
      // Each kind's dollars over the same priced passes' minutes: one ratio per kind, never summed across kinds.
      row.usdPerModelMinute = minutes.priced > 0 ? Object.fromEntries(BILLING.filter((k) => minutes.usd.usd[k] > 0).map((k) => [k, { usd: minutes.usd.usd[k], modelMinutes: round2(minutes.priced), passes: minutes.passes, usdPerModelMinute: round6(minutes.usd.usd[k] / minutes.priced) }])) : {};
      row.unpricedPasses = minutes.unpriced;
    } else if (ledgered) row.passes = null;
    // Its findings records are its review stages' own comments, read whatever its figures come from (its card or its stages).
    row.findings = findingsFor({ n, own: summary ? sorted(ownAll.filter((c) => progress.test(c.body || ""))) : allStages, scope, runOf, reviewStages, rows: findingRows, stageRows: findingStages, totals: findingTotals });
    objectives.push(row);
    if (counted && summary) {
      // Read from its finish card: the measures its summary carries, from the same ledgers and the scorer's start.
      armMeasures.set(n, { modelMinutes: summary.modelMinutes === null ? null : round2(summary.modelMinutes), fixPasses: summary.passes?.fix ?? null, wallMinutes: summary.labelledWallMs === null ? null : round2(summary.labelledWallMs / 60_000) });
    } else if (counted) {
      const start = read.started?.get(n);
      const mergedAt = row.outcome === "merged" ? newestPull(n, pulls)?.merged_at : null;
      // Known only when each stage has a ledger (a stage Pendulum cannot attribute to itself has none it reads).
      const whole = ledgered && !unledgered && !unattributedStages;
      armMeasures.set(n, {
        // Every harness pass's minutes, known only when each pass has its start and end too.
        modelMinutes: whole && !minutes.untimed ? round2(minutes.all) : null,
        fixPasses: whole ? row.passes.fix : null,
        // From the Objective's start (finish-card.mjs labelTime) to the merge, as the scorer counts it.
        wallMinutes: start && mergedAt && ms(mergedAt) >= ms(start) ? round2((ms(mergedAt) - ms(start)) / 60_000) : null,
      });
    }
  }

  const rank = (items, field) => items.sort((a, b) => b[field] - a[field] || (a.issue ?? 0) - (b.issue ?? 0) || String(a.passLabel ?? "").localeCompare(String(b.passLabel ?? "")));
  const passRows = views.pass.rows().map((r) => ({ key: r.key, passes: r.stages, cost: r.cost, tokens: r.tokens, modelMinutes: passMinutes.has(r.key) ? round2(passMinutes.get(r.key)) : null }));
  const report = {
    schema: REPORT_SCHEMA,
    repository: repo.full,
    generatedAt: now,
    pendulum: pendulumBuild(),
    scope: { since: scope.since ?? null, until: scope.until ?? null, defaultPeriod: !!scope.defaultPeriod, issues: scope.issues, label: scope.label ?? null, parent: scope.parent ?? null, compare: scope.compare ?? null, by },
    words: { ...KIND_WORDS },
    totals: { objectives: objectives.length, stages: stagesSeen, passes: passesSeen, cost: totals, tokens: totalTokens },
    unknown: {
      runs: totals.unknownRuns,
      stages: unknownStages,
      reasons: reasonsOf(unknownItems),
      items: unknownItems,
    },
    breakdowns: {
      stage: views.stage.rows(),
      pass: passRows,
      model: views.model.rows(),
      harness: views.harness.rows(),
      version: views.version.rows(),
      ...(by.includes("account") ? { account: views.account.rows() } : {}),
    },
    objectives,
    findings: {
      outcomes: [...FINDING_OUTCOMES],
      totals: findingTotals,
      byReviewer: [...findingRows.values()],
      byStage: findingStages,
    },
    hotSpots: {
      reviewLoops: { rankBy: "reviews", items: rank(objectives.filter((o) => o.stages.review > 0).map((o) => ({ issue: o.issue, reviews: o.stages.review })), "reviews") },
      answerAndFixPasses: { rankBy: "passes", items: rank(objectives.filter((o) => o.passes && o.passes.answer + o.passes.fix > 0).map((o) => ({ issue: o.issue, answer: o.passes.answer, fix: o.passes.fix, passes: o.passes.answer + o.passes.fix })), "passes"), unrecorded: objectives.filter((o) => !o.passes).map((o) => o.issue) },
      cacheWriteShare: { rankBy: "share", items: rank([...cacheByKind.values()].filter((k) => k.input > 0).map((k) => ({ ...k, share: Math.round((k.written / k.input) * 10000) / 10000 })), "share") },
      costPerModelMinute: { rankBy: "usdPerModelMinute", items: BILLING.flatMap((kind) => rank(objectives.filter((o) => o.usdPerModelMinute?.[kind]).map((o) => ({ issue: o.issue, billing: kind, ...o.usdPerModelMinute[kind] })), "usdPerModelMinute")) },
      blockedOrUnmergedSpend: { rankBy: "stages", items: rank(objectives.filter((o) => o.outcome === "blocked" || o.outcome === "closed-unmerged").map((o) => ({ issue: o.issue, outcome: o.outcome, stages: o.stages.work + o.stages.rebase + o.stages.review, cost: o.cost })), "stages") },
    },
    comparison: scope.compare && read.arms ? comparisonOf(read.arms, objectives, armMeasures) : null,
    rates: rates ? rateRatios(mixes.rows(), rates, tables, { at: now }) : null,
    source: sourceOf(source, trust, missing, read, summariesUsed),
  };
  return report;
}

/**
 * `--compare`'s two arms side by side (#545), each over the Objectives its label counts for: n, the outcomes, and per
 * merged Objective the median and p25..p75 (spread.mjs, the bench baseline's) of the dollars of each billing kind (a
 * merged Objective with runs of unknown cost left out of every dollar measure, and counted), the model minutes, the wall
 * clock, the review rounds and the fix passes (a merged Objective whose measure is not recorded left out of it), and the
 * runs of unknown cost; and the review findings of its Objectives with a findings record (armFindings), counts only. No
 * total across kinds, no difference between the arms and no significance: the figures only, with n in every measure and
 * every arm's rows.
 */
function comparisonOf(arms, objectives, measures) {
  const both = new Set(arms[0].trusted.filter((n) => arms[1].trusted.includes(n)));
  const measured = (rows, pick, digits) => {
    const xs = rows.map(pick);
    const s = spread(xs, digits);
    return { median: s.median, p25: s.p25, p75: s.p75, n: s.n, leftOut: rows.length - s.n };
  };
  return {
    inBoth: [...both].sort((a, b) => a - b),
    arms: arms.map((arm) => {
      const rows = objectives.filter((o) => arm.trusted.includes(o.issue) && !both.has(o.issue));
      const merged = rows.filter((o) => o.outcome === "merged");
      const known = merged.filter((o) => !o.cost.unknownRuns);
      const reasons = new Map();
      for (const o of rows) for (const code of o.cost.unknownWhy) reasons.set(code, (reasons.get(code) ?? 0) + 1);
      const m = (o) => measures.get(o.issue) ?? {};
      return {
        label: arm.label,
        experiment: isExperimentLabel(arm.label) ? arm.label.slice(EXPERIMENT_PREFIX.length) : null,
        n: rows.length,
        outcomes: Object.fromEntries([...OUTCOMES, null].map((k) => [k ?? "unread", rows.filter((o) => o.outcome === k).length])),
        merged: merged.length,
        usdPerMerged: Object.fromEntries(COST_KINDS.map((k) => [k, { ...measured(known, (o) => o.cost.usd[k], 6), leftOut: merged.length - known.length }])),
        modelMinutes: measured(merged, (o) => m(o).modelMinutes ?? null, 2),
        wallMinutes: measured(merged, (o) => m(o).wallMinutes ?? null, 2),
        reviewRounds: measured(merged, (o) => o.stages.review, 2),
        fixPasses: measured(merged, (o) => m(o).fixPasses ?? null, 2),
        findings: armFindings(rows),
        unknown: { runs: rows.reduce((t, o) => t + o.cost.unknownRuns, 0), objectives: rows.filter((o) => o.cost.unknownRuns).map((o) => o.issue), reasons: [...reasons].map(([code, count]) => ({ code, objectives: count, text: UNKNOWN_WHY[code] })).sort((a, b) => b.objectives - a.objectives || a.code.localeCompare(b.code)) },
        untrusted: [...arm.untrusted].sort((a, b) => a - b),
        unverifiable: [...arm.unverifiable].sort((a, b) => a - b),
        unchecked: arm.listed.filter((n) => !checked(arm, n)).sort((a, b) => a - b),
        objectives: rows.map((o) => ({ issue: o.issue, outcome: o.outcome, usd: { ...o.cost.usd }, unknownRuns: o.cost.unknownRuns, modelMinutes: m(o).modelMinutes ?? null, wallMinutes: m(o).wallMinutes ?? null, reviewRounds: o.stages.review, fixPasses: m(o).fixPasses ?? null, findings: o.findings?.findings ?? null })),
      };
    }),
  };
}

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * An arm's review findings (#546): over its Objectives with a findings record (`objectives`, their count), the findings,
 * a count per outcome, the recorded review stages and the findings no record names one by one. Counts only: the review
 * stages' dollars stay each Objective's (`objectives[].findings.cost`).
 */
function armFindings(rows) {
  const out = { objectives: 0, findings: 0, outcomes: zeroOutcomes(), reviewStages: 0, unnamed: 0 };
  for (const f of rows.map((o) => o.findings).filter(Boolean)) {
    out.objectives += 1;
    out.findings += f.findings;
    for (const o of FINDING_OUTCOMES) out.outcomes[o] += f.outcomes[o];
    out.reviewStages += f.reviewStages;
    out.unnamed += f.unnamed;
  }
  return out;
}

/** A recorded review stage the cost join gave no part: one run of unknown cost, never $0. */
const noRecordCost = () => ({ ...zeroCost(), unknownRuns: 1, unknownWhy: ["no-record"] });
/** A count per finding outcome (logic.mjs FINDING_OUTCOMES), each at zero. */
const zeroOutcomes = () => Object.fromEntries(FINDING_OUTCOMES.map((o) => [o, 0]));

/**
 * One Objective's review findings (#546), from the findings records in Pendulum's own review progress comments (`own`,
 * its stage comments, oldest first; logic.mjs findingsOf), never from prose. A finding's outcome is the one the latest
 * stage that names it recorded in a record written (the comment's last edit) before the period's end, except that a
 * stage's listed `open` replaces only an earlier `open`, never a judgement; with no such record it is `open`. It was
 * raised by the stage whose record names the review it came from (Pendulum's reviewer: that stage's reviewer model) or,
 * for a reviewer outside Pendulum, by that login, first named in the stage that first listed it; a finding of
 * Pendulum's reviewer whose review no record names (a review no recorded stage posted, such as one made in a session)
 * has no reviewer (null). A finding counts when that stage is in the period. The review stages counted are the ones in
 * the period with a record, each with its dollars (`reviewStages`: the cost loop's, by run key; one run of unknown cost
 * where the loop gave it none) and model. Adds to `rows` (by reviewer), `stageRows` (by review stage, the findings its
 * own reviewer raised) and `totals`; returns the Objective's figures (zero counts when its records are all outside the
 * period), or null when it has no findings record at all.
 */
function findingsFor({ n, own, scope, runOf, reviewStages, rows, stageRows, totals }) {
  const head = new RegExp(`^<!-- pendulum:${n}:progress:review:`);
  const recorded = own
    .filter((c) => head.test(c.body || ""))
    .map((c) => ({ key: runOf(c.body), at: c.created_at, written: c.updated_at ?? c.created_at, rec: findingsOf(c.body) }))
    .filter((s) => s.rec && s.key);
  const counted = recorded.filter((s) => inWindow(s.at, scope));
  const raisedIn = new Map();
  for (const s of recorded) for (const r of s.rec.reviews) if (!raisedIn.has(r)) raisedIn.set(r, s);
  // An outcome only from a record written before the period's end, so the same period reads the same; a later listed
  // `open` (no check of that stage's judged it) replaces only an earlier `open`, never a judgement.
  const byId = new Map();
  for (const s of recorded) {
    const settled = !scope.until || ms(s.written) < ms(scope.until);
    for (const x of s.rec.items) {
      const had = byId.get(String(x.id));
      const outcome = !settled ? (had?.outcome ?? "open") : x.listed && had && had.outcome !== "open" ? had.outcome : x.outcome;
      byId.set(String(x.id), { first: had?.first ?? s, outcome, review: had?.review ?? x.review ?? null, from: had?.from ?? x.from ?? null });
    }
  }
  if (!counted.length && !byId.size) return null;
  const rowsByKey = new Map(counted.map((s) => [s.key, { issue: n, stage: s.key, model: reviewStages.get(s.key)?.model ?? null, findings: 0, outcomes: zeroOutcomes(), cost: reviewStages.get(s.key)?.cost ?? noRecordCost() }]));
  const rowOf = (key, outside) => {
    const k = `${outside ? "outside" : "pendulum"}:${key ?? ""}`;
    if (!rows.has(k)) rows.set(k, { key: key ?? null, outside, findings: 0, outcomes: zeroOutcomes(), reviewStages: outside ? null : 0, cost: outside ? null : zeroCost() });
    return rows.get(k);
  };
  const out = { findings: 0, outcomes: zeroOutcomes(), reviewStages: counted.length, cost: zeroCost(), unnamed: 0 };
  for (const s of counted) {
    const r = rowOf(rowsByKey.get(s.key).model, false);
    r.reviewStages += 1;
    addCost(r.cost, rowsByKey.get(s.key).cost);
    addCost(out.cost, rowsByKey.get(s.key).cost);
    out.unnamed += s.rec.more;
  }
  for (const f of byId.values()) {
    const by = f.from ? null : f.review !== null ? raisedIn.get(f.review) ?? null : null;
    if (!inWindow((by ?? f.first).at, scope)) continue;
    out.findings += 1;
    out.outcomes[f.outcome] += 1;
    const r = rowOf(f.from ?? (by ? rowsByKey.get(by.key)?.model ?? reviewStages.get(by.key)?.model ?? null : null), !!f.from);
    r.findings += 1;
    r.outcomes[f.outcome] += 1;
    const st = by ? rowsByKey.get(by.key) : null;
    if (st) {
      st.findings += 1;
      st.outcomes[f.outcome] += 1;
    }
  }
  stageRows.push(...rowsByKey.values());
  totals.findings += out.findings;
  for (const o of FINDING_OUTCOMES) totals.outcomes[o] += out.outcomes[o];
  totals.reviewStages += out.reviewStages;
  addCost(totals.cost, out.cost);
  totals.unnamed += out.unnamed;
  return out;
}

/**
 * The reasons for unknown cost: per code, the stages (and decision records) naming it, and its runs where they are its
 * alone (every item naming it names no other reason; else null: a stage's runs are not split between its reasons).
 */
function reasonsOf(items) {
  const by = new Map();
  for (const u of items) {
    for (const code of u.why) {
      const r = by.get(code) ?? { code, stages: 0, runs: 0, text: UNKNOWN_WHY[code] };
      r.stages += 1;
      r.runs = r.runs === null || u.why.length > 1 ? null : r.runs + u.runs;
      by.set(code, r);
    }
  }
  return [...by.values()].sort((a, b) => b.stages - a.stages || a.code.localeCompare(b.code));
}
const issuesOf = (set) => [...set].sort((a, b) => a - b);

/**
 * The source section: the calls made, what was read and what was missing. Each missing entry's `count` is its code's own
 * unit (Objectives, stages, comments or artifacts, as docs/REPORT.md lists them), and `counts` gives both the
 * Objectives it touches and the stages among them, each null where the code is not about them.
 */
function sourceOf(source, trust, missing, read, summaries = 0) {
  const calls = source.calls;
  const out = [];
  const none = { objectives: null, stages: null };
  // `of`: a Set of issues (no stage count), or a tally (its issues and stages).
  const add = (code, of, text) => {
    const list = issuesOf(of instanceof Set ? of : of.issues);
    if (list.length) out.push({ code, count: list.length, counts: { objectives: list.length, stages: of instanceof Set ? null : of.stages }, issues: list, text });
  };
  if (source.stopped) out.push({ code: "stopped", count: 1, counts: none, issues: [], text: `the reads stopped at --max-calls ${calls.max} before ${source.stopped}: what is shown is partial` });
  if (!source.selfKnown) out.push({ code: "self-unknown", count: 1, counts: none, issues: [], text: "the login the token belongs to could not be read, so only Pendulum's App (--app) counts as Pendulum's own" });
  // No App id, whether or not a comment through an App was read (#564): unreadable (403) apart from not set (404).
  const unattributed = `so comments through a GitHub App or by another login that can push are not attributed to Pendulum (the count: those read, ${trust.vouched})`;
  if (read.appId === null && source.appFrom === "forbidden") out.push({ code: "app-unreadable", count: trust.vouched, counts: none, issues: [], text: `the repository variable PENDULUM_APP_ID could not be read (HTTP 403: the token may not read the repository's variables, and no gh login could either) and no App id was given (--app), ${unattributed}; give the token Variables: read, log in with gh, or pass --app ID` });
  if (read.appId === null && source.appFrom === "unset") out.push({ code: "app-not-given", count: trust.vouched, counts: none, issues: [], text: `the repository variable PENDULUM_APP_ID ${source.appNotId ? "is no App id (a number)" : "is not set"} and no App id was given (--app), ${unattributed}; set it once: ${appIdSetLine(read.repo?.full ?? "OWNER/NAME")}` });
  add("unattributed", missing.unattributed, UNKNOWN_WHY.unattributed);
  add("no-record", missing.noRecord, UNKNOWN_WHY["no-record"]);
  add("stopped-before-records", missing.stopped, UNKNOWN_WHY.stopped);
  add("artifact-foreign", source.foreignIssues ?? new Set(), `usage artifacts uploaded by runs from forks, or naming no repository (${source.artifacts.foreign}), never read as Pendulum's`);
  add("no-ledger", missing.noLedger, "stages with no per-pass ledger in their progress comment or usage record (an older stage, or a local stage whose ledger did not fit its comment and that has no local record on this machine): no pass breakdown, answer and fix passes or cost per model minute for them");
  if (missing.ledgerStopped?.length) out.push({ code: "ledger-stopped", count: missing.ledgerStopped.length, counts: { objectives: new Set(missing.ledgerStopped.map((x) => x.issue)).size, stages: missing.ledgerStopped.length }, issues: issuesOf(new Set(missing.ledgerStopped.map((x) => x.issue))), stages: missing.ledgerStopped, text: "stages whose per-pass ledger is in a usage record the call budget stopped the report before reading: no pass breakdown for them" });
  add("no-model", missing.noModel, "stages whose harness line, ledger line and usage record name no model, or that have no usage record: under no model in the model breakdown");
  add("model-stopped", missing.modelStopped, "stages whose model only their usage record names, which the call budget stopped the report before reading: under no model in the model breakdown");
  add("no-version", missing.noVersion, "stages whose record names no Pendulum version (an older record, or a spend line)");
  add("issue-unread", missing.unreadIssue, "issues with Pendulum's markers that could not be read: no outcome or title for them");
  // The vetted labels (#545): an issue whose label's last applier cannot push is not counted, nor one whose was not read.
  const arms = read.arms ?? [];
  add("label-untrusted", new Set(arms.flatMap((a) => a.untrusted)), `issues whose ${arms.map((a) => `\`${a.label}\``).join(" or ")} label was last applied by someone who cannot push (or by a bot or an App), or by no one the timeline names: not counted for it`);
  add("label-unverifiable", new Set(arms.flatMap((a) => a.unverifiable)), "issues whose label's last applier's permission the token may not read (403): not vouched for, so not counted for it");
  add("label-unchecked", new Set(arms.flatMap((a) => a.listed.filter((n) => !checked(a, n)))), "issues whose label's applier the call budget stopped the report before reading: not counted");
  if (arms.length === 2) add("in-both-arms", new Set(arms[0].trusted.filter((n) => arms[1].trusted.includes(n))), "issues both arms' labels count for: in neither arm");
  if (source.artifacts.expired) out.push({ code: "artifact-expired", count: source.artifacts.expired, counts: none, issues: [], text: "usage artifacts past GitHub's retention, not cached here" });
  if (source.artifacts.failed) out.push({ code: "artifact-failed", count: source.artifacts.failed, counts: none, issues: [], text: "usage artifacts that could not be downloaded" });
  if (source.artifacts.unreadable) out.push({ code: "artifacts-unreadable", count: source.artifacts.unreadable, counts: none, issues: [], text: "artifact lists the token may not read (it needs actions: read), or artifacts that name no workflow run" });
  return {
    complete: !source.stopped,
    stoppedAt: source.stopped ?? null,
    maxCalls: calls.max,
    calls: { planned: calls.planned, plannedAtLeast: !!calls.open, made: calls.made, byKind: { ...calls.byKind } },
    // Whose markers were taken as Pendulum's: the token's own login, the logins --self named (each only on a comment by
    // someone who can push) and the App, with where its id came from (`flag`, `variable`, `variable-gh`, `local-copy`,
    // `env`) or why there is none (`unset`, `forbidden`; null when the call budget stopped before the read); `appWhy`,
    // why the variable gave no id (`unset`, `forbidden`), kept when the local copy or the env stands in for it.
    trusted: { logins: [...new Set([source.login, ...(read.self ?? [])].filter(Boolean))], app: read.appId ?? null, appFrom: source.appFrom ?? null, appWhy: source.appWhy ?? null },
    read: { comments: source.comments, pendulumComments: trust.own, unattributedComments: trust.vouched, ignoredComments: trust.ignored, issues: read.issues?.size ?? 0, pulls: read.pulls?.length ?? 0, artifacts: { ...source.artifacts }, localRecords: source.localRecords, summaries },
    missing: out,
  };
}

// ------------------------------------------------------------------ rate ratios (--rates)

/** What a rate ratio is, word for word as the harness labels it: no dollar unit, never a cost. */
export const RATIO_WORDS = "ratio of published rates on the recorded token mix (no dollar unit)";
/** Why a model, a candidate or a pair of them has no rate ratio. */
export const RATIO_WHY = Object.freeze({
  "no-rate-table": "Pendulum holds no published rates for this model (it holds OpenAI's alone; Claude Code and Copilot report their own dollars)",
  "price-ended": "its rate in the table was a promotional one, which has ended",
  "other-vendor": "the two models are of different vendors, whose rates are never compared",
  "same-model": "the candidate is the recorded model itself",
  "no-tokens": "a stage of this model has no input or output tokens recorded",
  "sub-agents": "a stage's tokens include sub-agents on another model that no record splits out",
  "pass-models": "a stage's passes may have run on another model than its own, and no ledger says which",
  "long-context": "its tokens from requests over the long-context threshold are not known, or are not zero and one of the two models has no long-context rate",
});

/**
 * The published rate tables a rate ratio reads, one per vendor (#547): OpenAI's is the Codex price table (cost-join.mjs
 * loadPrices). Pendulum holds no other vendor's rates: Claude Code and Copilot report their own dollars.
 */
export const rateTables = (prices) => [{ vendor: "openai", file: "codex-prices.json", table: prices }];

const TOKEN_KEYS = ["input", "cached", "written", "output"];
const noLong = () => ({ input: 0, cached: 0, written: 0, output: 0 });

/**
 * The recorded token mix of each model, for `--rates`: each stage's tokens under its model, as the model breakdown counts
 * them, but a Codex stage's sub-agent threads (its record's `subAgents`) under each thread's own model, the rest under the
 * stage's, as the cost join prices them (usage.mjs priceStage); its decision records' tokens are in no model's. A stage
 * whose ledger's harness passes (its decision records left out) name more than one model (a review stage's review pass on
 * the reviewer's model, its answer and fix passes on the worker's), or one that is not the stage's (an alias or a dated
 * snapshot of it aside), is split by them: each model gets its own passes' tokens, a thread's taken from the passes it
 * ran in (its `run`, their label) and put under the thread's model. A stage whose passes may have run on another model
 * than its own that no ledger names (no ledger, or a pass on a model the ledger line does not name, on a stage not on the
 * worker's model) marks its model and the worker's `pass-models`. Where no record splits the threads out (a progress
 * comment's ledger line, or another harness's record), the tokens of passes on the worker's model mark that model and
 * the sub-agent model, when it is another, `sub-agents`, as does a thread no pass's label places. `long` is the part of
 * the mix from requests over `above` input tokens (usage.mjs longShare), summed over the stages, null once any stage's
 * is not known (a pass's, from a ledger, is known only when its whole input is under `above`). A stage with no input or
 * output tokens marks its model `no-tokens`.
 */
function mixBook(prices) {
  const above = prices?.longContextAbove;
  // Two names of one model: the same, or the same row of the price table (an alias, a dated snapshot).
  const same = (a, b) => a === b || codexRow(prices, a, { at: null }).id === codexRow(prices, b, { at: null }).id;
  const rows = new Map();
  const row = (m) => {
    if (!rows.has(m)) rows.set(m, { key: m, tokens: zeroTokens(), long: noLong(), why: new Set() });
    return rows.get(m);
  };
  const add = (m, tokens, long) => {
    const r = row(m);
    if (num(tokens?.input) === null || num(tokens?.output) === null) r.why.add("no-tokens");
    addTokens(r.tokens, tokens);
    r.long = r.long && long ? sumLong([r.long, long]) : null;
  };
  const mark = (models, why) => {
    for (const m of models) if (m) row(m).why.add(why);
  };
  // `threads` taken out of `tokens` (and their long-context share out of `long`), each count kept null where it is null.
  const less = (tokens, long, threads) => {
    const sum = (k) => threads.reduce((n, t) => n + (num(t.tokens[k]) ?? 0), 0);
    return [Object.fromEntries(TOKEN_KEYS.map((k) => [k, num(tokens?.[k]) === null ? null : Math.max(0, tokens[k] - sum(k))])), sumLong([long, ...threads.map((t) => longShare(t.tokens, above))], -1)];
  };
  return {
    /**
     * One stage on `model` with `tokens`: `subs` the sub-agent threads its record lists (an exact split; null when no
     * record splits them), `ledger` its per-pass ledger, `worker` and `subagent` the Objective's models.
     */
    stage(model, tokens, { subs = null, ledger = null, worker = null, subagent = null } = {}) {
      if (!model) return;
      const threads = (Array.isArray(subs) ? subs : []).filter((t) => t?.tokens && typeof t.tokens === "object");
      // Passes on the worker's model may hold sub-agent threads no record splits out.
      const unsplit = (m) => !Array.isArray(subs) && !!subagent && subagent !== m && (worker === null || m === worker);
      const passes = Array.isArray(ledger) ? ledger.filter((e) => e && typeof e === "object" && e.decision !== true) : null;
      const models = passes?.length && passes.every((e) => modelKey(e.model)) ? [...new Set(passes.map((e) => e.model))] : null;
      if (models && (models.length > 1 || !same(models[0], model))) {
        const by = new Map(models.map((m) => [m, { tokens: zeroTokens(), long: noLong(), whole: true, threads: [] }]));
        for (const e of passes) {
          const r = by.get(e.model);
          if (num(e.tokens?.input) === null || num(e.tokens?.output) === null) r.whole = false;
          addTokens(r.tokens, e.tokens);
          r.long = r.long && sumLong([r.long, longShare(e.tokens, above)]);
        }
        for (const t of threads) {
          const on = [...new Set(passes.filter((e) => typeof t.run === "string" && e.label === t.run).map((e) => e.model))];
          if (on.length === 1) by.get(on[0]).threads.push(t);
          else mark([...models, modelKey(t.model)], "sub-agents");
        }
        for (const [m, r] of by) {
          if (unsplit(m)) mark([m, subagent], "sub-agents");
          const [own, long] = less(r.tokens, r.long, r.threads);
          add(m, r.whole ? own : { ...own, input: null }, long);
          for (const t of r.threads) add(modelKey(t.model) ?? m, t.tokens, longShare(t.tokens, above));
        }
        return;
      }
      if (!models && worker && worker !== model) mark([model, worker], "pass-models");
      if (unsplit(model)) mark([model, subagent], "sub-agents");
      // Its decision records' tokens (a record's `tokens` holds them, session.mjs writeUsage) are no pass's: taken out,
      // so its mix is its passes' alone, the record's long-context share kept.
      const decisions = Array.isArray(ledger) ? ledger.filter((e) => e?.decision === true && e.tokens && typeof e.tokens === "object") : [];
      if (!threads.length && !decisions.length) return add(model, tokens, longShare(tokens, above));
      const [own, long] = less(tokens, longShare(tokens, above), [...decisions, ...threads]);
      add(model, own, long);
      for (const t of threads) add(modelKey(t.model) ?? model, t.tokens, longShare(t.tokens, above));
    },
    // Each model under one name (modelName), the rows of its other names added in.
    rows: () => {
      const named = new Map();
      for (const r of rows.values()) {
        const key = modelName(r.key, prices);
        const had = named.get(key);
        if (!had) named.set(key, { key, tokens: addTokens(zeroTokens(), r.tokens), long: r.long, why: new Set(r.why) });
        else {
          addTokens(had.tokens, r.tokens);
          had.long = had.long && r.long ? sumLong([had.long, r.long]) : null;
          for (const w of r.why) had.why.add(w);
        }
      }
      return [...named.values()].map((r) => ({ key: r.key, tokens: r.tokens, long: r.long, why: [...r.why].sort() }));
    },
  };
}

/** A model's published rates: `{vendor, file, id, rate}` from the first table that lists it, else `{why}` (RATIO_WHY). */
function publishedRate(tables, model, at) {
  let ended = null;
  for (const t of tables) {
    const row = codexRow(t.table, model, { at });
    if (row.rate) return { vendor: t.vendor, file: t.file, id: row.id, rate: row.rate };
    if (row.why === "price-ended") ended ??= { vendor: t.vendor, id: row.id, why: "price-ended" };
  }
  return ended ?? { why: "no-rate-table" };
}

/** Tokens (Pendulum's shape: input includes the cache reads and writes) as the four parts a rate row prices. */
const partsOf = (t) => ({ uncached: Math.max(0, (t.input ?? 0) - (t.cached ?? 0) - (t.written ?? 0)), cached: t.cached ?? 0, written: t.written ?? 0, output: t.output ?? 0 });
/**
 * Parts weighed at a row of published rates, per million tokens: uncached input at `input`, cache reads at `cached`, cache
 * writes at `write` (`input` for a model with none), output at `output`. A weight, not dollars: only the ratio of two of
 * them on one mix is ever reported.
 */
const weigh = (p, r) => p.uncached * r.input + p.cached * r.cached + p.written * (r.write ?? r.input) + p.output * r.output;
/** Tokens weighed as usage.mjs codexPrice prices them: the long-context share at the `long` rates, the rest at the standard. */
const weighTiers = (tokens, long, r) => weigh(partsOf(Object.fromEntries(TOKEN_KEYS.map((k) => [k, Math.max(0, (tokens[k] ?? 0) - long[k])]))), r) + (r.long ? weigh(partsOf(long), r.long) : 0);

/**
 * `--rates`: for each model's recorded token mix (mixBook) with published rates, the ratio of each named candidate's rates
 * to the model's own on that mix, weighed as the cost join prices tokens (codexPrice): with a long-context share, the
 * share at each model's `long` rates. Only within one vendor's table. No ratio, and a `skipped` entry with its code
 * (RATIO_WHY), for: a model or candidate no table lists or whose promotional rate ended, a pair of two vendors, a candidate
 * that is the model itself, a model whose mix is not known whole (`no-tokens`, `sub-agents`, `pass-models`), and a
 * long-context share not known, or not zero where either model has no `long` rates (two models with none price every
 * token at the standard rates, the share aside). Candidates are taken once each, an alias with the model it names. No dollar figure: a ratio
 * has no unit, and the mix is token counts. `at`: when the rates are read (a promotional rate counts only before its end).
 */
export function rateRatios(mixes, candidates, tables, { at }) {
  const items = [];
  const skipped = [];
  const asked = [];
  for (const name of candidates) {
    const c = { candidate: name, ...publishedRate(tables, name, at) };
    if (!asked.some((a) => a.candidate === name || (c.id && a.id === c.id && a.vendor === c.vendor))) asked.push(c);
  }
  for (const c of asked) if (c.why) skipped.push({ model: null, candidate: c.candidate, why: c.why });
  for (const row of mixes) {
    if (row.key === null || row.key === "decisions") continue;
    const own = publishedRate(tables, row.key, at);
    const whyNot = own.why ? [own.why] : row.why;
    const t = row.tokens;
    if (!whyNot.length && !(weigh(partsOf(t), own.rate) > 0)) whyNot.push("no-tokens");
    if (whyNot.length) {
      for (const why of whyNot) skipped.push({ model: row.key, candidate: null, why });
      continue;
    }
    const longSome = row.long !== null && TOKEN_KEYS.some((k) => row.long[k] > 0);
    for (const c of asked) {
      if (c.why) continue;
      const why = c.vendor !== own.vendor ? "other-vendor" : c.id === own.id ? "same-model" : !own.rate.long && !c.rate.long ? null : row.long === null || (longSome && !(own.rate.long && c.rate.long)) ? "long-context" : null;
      if (why) {
        skipped.push({ model: row.key, candidate: c.candidate, why });
        continue;
      }
      const long = own.rate.long || c.rate.long ? row.long : noLong();
      items.push({ model: row.key, rateOf: own.id, candidate: c.candidate, candidateRateOf: c.id, vendor: own.vendor, mix: partsOf(t), long: partsOf(long), ratio: round6(weighTiers(t, long, c.rate) / weighTiers(t, long, own.rate)) });
    }
  }
  const used = tables.filter((t) => items.some((i) => i.vendor === t.vendor));
  const basis = used.map((t) => `${t.vendor}'s published rates from ${t.file} dated ${t.table.date}, the long-context share at the long-context rates`).join("; ");
  return { words: RATIO_WORDS, candidates: asked.map((c) => c.candidate), basis: basis || null, tables: tables.map((t) => ({ vendor: t.vendor, file: t.file, date: t.table.date ?? null })), items, skipped: skipped.map((x) => ({ ...x, text: RATIO_WHY[x.why] })) };
}

// ------------------------------------------------------------------ Markdown

const money = (n) => `$${n.toFixed(n !== 0 && Math.abs(n) < 0.01 ? 4 : 2)}`;
/** A cost as Markdown cells, one per kind, never added together. */
const costCells = (c) => [...COST_KINDS.map((k) => (c.usd[k] ? money(c.usd[k]) : "—")), String(c.unknownRuns)];
const COST_HEAD = ["API", "Subscription (API-equivalent)", "Copilot AI credits", "Billing not recorded", "Sandbox", "Unknown runs"];
const cell = (s) => String(s ?? "").replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
const table = (head, rows) => [`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`)].join("\n");

/** The report as plain Markdown, for a terminal or CI: the same figures as the JSON, none added. */
export function renderReport(r) {
  const s = r.scope;
  const what = s.compare ? `issues labelled \`${s.compare[0]}\` against issues labelled \`${s.compare[1]}\`` : s.issues.length ? `issues ${s.issues.map((n) => `#${n}`).join(", ")}` : s.label ? `issues labelled \`${s.label}\`` : s.parent ? `the sub-issues of #${s.parent}` : "every Objective";
  const when = s.since || s.until ? ` with stages from ${s.since ?? "the start"} to ${s.until ?? "now"}${s.defaultPeriod ? " (the default period)" : ""}` : "";
  const out = [`# Pendulum cost report: ${r.repository}`, "", `${what}${when}. ${r.totals.objectives} Objective(s), ${r.totals.stages} stage(s). Made ${r.generatedAt} by Pendulum ${r.pendulum} (schema ${r.schema}).`];
  if (!r.source.complete) out.push("", `**Partial:** ${r.source.missing.find((m) => m.code === "stopped").text}.`);
  if (r.comparison) {
    // Two arms: their figures side by side, and the source; no figure across both arms.
    out.push(...renderComparison(r.comparison, r.words));
    return `${[...out, ...renderRates(r.rates), ...renderSource(r.source)].join("\n")}\n`;
  }
  out.push("", "## Totals", "", "Each kind's dollars are apart; they are never added together.", "", table(COST_HEAD, [costCells(r.totals.cost)]));
  out.push("", `- API: ${r.words.api}. Subscription: ${r.words.subscription}. Copilot: ${r.words.credits}. Sandbox: ${r.words.sandbox}.`);
  // The stages (and decision records) with runs of unknown cost, then each reason's: a stage naming two reasons is under both.
  const others = r.unknown.items.length - r.unknown.stages;
  const where = r.unknown.items.length ? ` in ${r.unknown.stages} stage(s)${others ? ` and ${others} record(s) outside a stage (decision calls, or a vendor comment with no stage)` : ""}` : "";
  out.push(`- Runs of unknown cost: ${r.unknown.runs}${where}.${r.unknown.reasons.length ? ` By reason (a stage that names two is under each): ${r.unknown.reasons.map((x) => `${x.stages} stage(s)${x.runs === null ? "" : `, ${x.runs} run(s)`}: ${x.text}`).join("; ")}.` : ""}`);
  const t = r.totals.tokens;
  if (t.input !== null || t.output !== null) out.push(`- Tokens reported: ${t.input ?? "?"} in (${t.cached ?? "?"} cache reads, ${t.written ?? "?"} cache writes), ${t.output ?? "?"} out.`);
  const view = (title, rows, name = "Key", count = "Stages") => {
    if (!rows.length) return;
    out.push("", `## By ${title}`, "", table([name, count, ...COST_HEAD], rows.map((x) => [x.key ?? "not recorded", x.stages ?? x.passes, ...costCells(x.cost)])));
  };
  view("stage", r.breakdowns.stage, "Stage");
  view("pass", r.breakdowns.pass, "Pass", "Passes");
  view("model", r.breakdowns.model, "Model");
  view("harness", r.breakdowns.harness, "Harness");
  view("Pendulum version", r.breakdowns.version, "Version");
  if (r.breakdowns.account) view("account", r.breakdowns.account, "Account");
  if (r.objectives.length) out.push("", "## Objectives", "", table(["Issue", "Outcome", "Work", "Rebase", "Review", ...COST_HEAD], r.objectives.map((o) => [`#${o.issue}`, o.outcome ?? "unread", o.stages.work, o.stages.rebase, o.stages.review, ...costCells(o.cost)])));
  const f = r.findings;
  if (f.totals.findings || f.totals.reviewStages) {
    const counts = (x) => [x.findings, ...f.outcomes.map((o) => x.outcomes[o])];
    const noCost = COST_HEAD.map(() => "—");
    out.push("", "## Review findings", "", `How each reviewer finding ended, from Pendulum's own records: ${f.totals.findings} finding(s) over ${f.totals.reviewStages} recorded review stage(s)${f.totals.unnamed ? `, and ${f.totals.unnamed} more no record names one by one` : ""}. A review stage's dollars are all its passes'; a reviewer outside Pendulum has none here.`);
    out.push("", table(["Reviewer", "Findings", ...f.outcomes, "Review stages", ...COST_HEAD], f.byReviewer.map((x) => [x.outside ? `${x.key} (outside Pendulum)` : (x.key ?? "not recorded"), ...counts(x), x.outside ? "—" : x.reviewStages, ...(x.cost ? costCells(x.cost) : noCost)])));
    const rows = r.objectives.filter((o) => o.findings);
    if (rows.length) out.push("", table(["Issue", "Findings", ...f.outcomes, "Review stages", ...COST_HEAD], rows.map((o) => [`#${o.issue}`, ...counts(o.findings), o.findings.reviewStages, ...costCells(o.findings.cost)])));
    if (f.byStage.length) out.push("", table(["Issue", "Review stage", "Model", "Findings raised", ...f.outcomes, ...COST_HEAD], f.byStage.map((x) => [`#${x.issue}`, x.stage, x.model ?? "not recorded", ...counts(x), ...costCells(x.cost)])));
  }
  const h = r.hotSpots;
  out.push("", "## Hot spots", "", "Ranked by exact counts; nothing is flagged against a threshold.");
  const list = (title, items, line) => out.push("", `**${title}**: ${items.length ? items.map(line).join("; ") : "none"}`);
  list("Review stages", h.reviewLoops.items, (x) => `#${x.issue} ${x.reviews}`);
  list("Answer and fix passes", h.answerAndFixPasses.items, (x) => `#${x.issue} ${x.passes} (${x.answer} answer, ${x.fix} fix)`);
  // The Objectives with a stage that has no per-pass ledger, whose passes are not known: on the same line.
  if (h.answerAndFixPasses.unrecorded.length) out[out.length - 1] += `; not recorded (a stage with no per-pass ledger): ${h.answerAndFixPasses.unrecorded.map((n) => `#${n}`).join(", ")}`;
  list("Cache-write share by pass label", h.cacheWriteShare.items, (x) => `${x.passLabel} ${(x.share * 100).toFixed(1)}% (${x.written} of ${x.input} input tokens)`);
  list("Cost per model minute", h.costPerModelMinute.items, (x) => `#${x.issue} ${money(x.usdPerModelMinute)}/min ${x.billing} (${money(x.usd)} over ${x.modelMinutes} min)`);
  list("Spend in Objectives that ended Blocked or closed unmerged", h.blockedOrUnmergedSpend.items, (x) => `#${x.issue} ${x.outcome}, ${x.stages} stage(s): ${COST_KINDS.filter((k) => x.cost.usd[k]).map((k) => `${money(x.cost.usd[k])} ${k}`).join(", ") || "$0.00"}${x.cost.unknownRuns ? ` plus ${x.cost.unknownRuns} run(s) of unknown cost` : ""}`);
  return `${[...out, ...renderRates(r.rates), ...renderSource(r.source)].join("\n")}\n`;
}

/** `--rates`' lines: each ratio with its basis, never a dollar figure, then what has none and why. */
function renderRates(rates) {
  if (!rates) return [];
  const out = ["", "## Rate ratios", "", `Each ratio is the ${rates.words}: the candidate's published rates over the recorded model's, on that model's recorded tokens in this report (its long-context share at the long-context rates), within one vendor's rates. It is no cost, and no figure here is dollars.`];
  if (rates.basis) out.push("", `Rates: ${rates.basis}.`);
  const longIn = (x) => x.long.uncached + x.long.cached + x.long.written;
  out.push("", rates.items.length ? table(["Model", "Candidate", "Ratio", "Uncached in", "Cache reads", "Cache writes", "Out", "Long-context in, out"], rates.items.map((x) => [x.model, x.candidate, `${x.ratio}×`, x.mix.uncached, x.mix.cached, x.mix.written, x.mix.output, longIn(x) || x.long.output ? `${longIn(x)}, ${x.long.output}` : "—"])) : "No ratio.");
  for (const s of rates.skipped) out.push(`- No ratio for ${[s.model, s.candidate].filter(Boolean).map((m) => `\`${m}\``).join(" to ")}: ${s.text}.`);
  return out;
}

/** The source section's lines. */
function renderSource(src) {
  const out = [];
  out.push("", "## Source", "", `${src.calls.made} GitHub API call(s) of --max-calls ${src.maxCalls}. Read: ${src.read.comments} comment(s) (${src.read.pendulumComments} of Pendulum's own, ${src.read.unattributedComments} not attributed, ${src.read.ignoredComments} ignored), ${src.read.issues} issue(s), ${src.read.pulls} PR(s), ${src.read.artifacts.listed} usage artifact(s) (${src.read.artifacts.downloaded} downloaded, ${src.read.artifacts.cached} from the cache), ${src.read.localRecords} local record(s).`);
  // Each entry's count in its own unit, or its Objectives and the stages among them where it gives them.
  const counted = (m) => (m.counts?.objectives === null || m.counts?.objectives === undefined ? String(m.count) : `${m.counts.objectives} Objective(s)${m.counts.stages === null ? "" : `, ${m.counts.stages} stage(s)`}`);
  out.push("", src.missing.length ? src.missing.map((m) => `- Missing: ${m.text} (${counted(m)}${m.issues.length ? `: ${m.issues.map((n) => `#${n}`).join(", ")}` : ""})`).join("\n") : "- Nothing missing.");
  return out;
}

/** `--compare`'s lines: one column per arm, each measure's median (p25..p75, n), then each arm's rows. */
function renderComparison(c, words) {
  const [a, b] = c.arms;
  const name = (arm) => arm.experiment ?? arm.label;
  const fmt = (m, unit = (x) => String(x)) => (m.median === null ? `none${m.leftOut ? ` (${m.leftOut} left out)` : ""}` : `${unit(m.median)} (${unit(m.p25)}..${unit(m.p75)}, n=${m.n}${m.leftOut ? `, ${m.leftOut} left out` : ""})`);
  const kindName = { api: "API", subscription: "Subscription (API-equivalent)", credits: "Copilot AI credits", unknown: "Billing not recorded", sandbox: "Sandbox" };
  // A kind no merged Objective of either arm has dollars of is left out of the table (its medians are all $0).
  const kinds = COST_KINDS.filter((k) => c.arms.some((arm) => arm.objectives.some((o) => o.outcome === "merged" && o.usd[k] > 0)));
  const rows = [
    ["Objectives", a.n, b.n],
    ["Merged", a.merged, b.merged],
    ["Blocked, question, closed unmerged, open", ...[a, b].map((x) => `${x.outcomes.blocked}, ${x.outcomes.question}, ${x.outcomes["closed-unmerged"]}, ${x.outcomes.open}${x.outcomes.unread ? ` (${x.outcomes.unread} unread)` : ""}`)],
    ...kinds.map((k) => [`$ per merged Objective: ${kindName[k]}`, fmt(a.usdPerMerged[k], money), fmt(b.usdPerMerged[k], money)]),
    // No kind with dollars: one row still says how many were measured ($0 at every kind) and how many left out.
    ...(kinds.length ? [] : [["$ per merged Objective (no kind has dollars)", fmt(a.usdPerMerged.api, money), fmt(b.usdPerMerged.api, money)]]),
    ["Model minutes", fmt(a.modelMinutes), fmt(b.modelMinutes)],
    ["Wall clock minutes", fmt(a.wallMinutes), fmt(b.wallMinutes)],
    ["Review rounds", fmt(a.reviewRounds), fmt(b.reviewRounds)],
    ["Fix passes", fmt(a.fixPasses), fmt(b.fixPasses)],
    [`Review findings (${FINDING_OUTCOMES.join(", ")}), over Objectives recorded`, ...[a, b].map((x) => `${x.findings.findings} (${FINDING_OUTCOMES.map((o) => x.findings.outcomes[o]).join(", ")}), ${x.findings.reviewStages} review stage(s), ${x.findings.objectives} Objective(s)`)],
    ["Runs of unknown cost", ...[a, b].map((x) => `${x.unknown.runs}${x.unknown.reasons.length ? ` (${x.unknown.reasons.map((r) => `${r.code}: ${r.objectives} Objective(s)`).join("; ")})` : ""}`)],
  ];
  const out = ["", "## Comparison", "", "Medians with p25..p75 over each arm's merged Objectives; `left out`: merged Objectives with runs of unknown cost (dollars) or with the measure not recorded. Each kind's dollars are apart, and nothing is added across kinds or arms. No difference between the arms is claimed to be significant: these are the figures only.", "", table(["Measure", name(a), name(b)], rows)];
  if (kinds.length) out.push("", `- ${kinds.map((k) => `${kindName[k]}: ${words[k]}`).join(". ")}.`);
  if (c.inBoth.length) out.push(`- In both arms, so in neither: ${c.inBoth.map((n) => `#${n}`).join(", ")}.`);
  const issues = (list) => list.map((n) => `#${n}`).join(", ");
  for (const arm of [a, b]) {
    if (arm.untrusted.length) out.push(`- Not counted for ${name(arm)}, its label applied by someone who cannot push: ${issues(arm.untrusted)}.`);
    if (arm.unverifiable.length) out.push(`- Not counted for ${name(arm)}, its labeller's permission unreadable with this token: ${issues(arm.unverifiable)}.`);
    if (arm.unchecked.length) out.push(`- Not counted for ${name(arm)}, its labeller not read before the call budget ran out: ${issues(arm.unchecked)}.`);
  }
  for (const arm of [a, b]) {
    out.push("", `**${name(arm)}**: ${arm.n} Objective(s), ${arm.merged} merged.`, "", table(["Issue", "Outcome", ...COST_KINDS.map((k) => kindName[k]), "Unknown runs", "Model min", "Wall min", "Review rounds", "Fix passes", "Findings"], arm.objectives.map((o) => [`#${o.issue}`, o.outcome ?? "unread", ...COST_KINDS.map((k) => (o.usd[k] ? money(o.usd[k]) : "—")), o.unknownRuns, o.modelMinutes ?? "—", o.wallMinutes ?? "—", o.reviewRounds, o.fixPasses ?? "—", o.findings ?? "—"])));
  }
  return out;
}
