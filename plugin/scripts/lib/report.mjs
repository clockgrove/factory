// `pendulum report` (#512): the cost and token data layer. Pendulum reads what its own records say about a period or a set
// of Objectives and emits every figure precomputed, in one versioned JSON schema (REPORT_SCHEMA; docs/REPORT.md) or as
// plain Markdown for a terminal or CI. The harness presents the figures and never adds, averages or derives dollars
// (the pendulum-report skill). Three parts:
//   readReport    the reads, within a call budget: the issue comments (the progress, harness, spend, vendor, decision-spend
//                 and finish markers; one paged repository-wide read, or each named issue's own), the Objectives' issues
//                 and PRs, and the usage artifacts of the stages that have no spend line, cached on disk by artifact id;
//   buildReport   the figures (pure), through the scorer's own cost join (cost-join.mjs: withLines, costOf);
//   renderReport  the Markdown.
// Dollars are vendor-reported, or API-reported tokens at the published rate, or unknown (usage.mjs UNKNOWN_WHY): never
// an estimate, a bound or a counterfactual. Totals stay split by billing kind (usage.mjs BILLING) and the sandbox
// vendor's cost, never blended. Markers count only from Pendulum's own login or App (finish-card.mjs pendulumOwn), or a
// login `--self` names that can push; a stage comment by someone else who can push, or through another App, is a run of
// unknown cost; anyone else's counts nothing. An artifact a fork's run uploaded is never read (github.mjs ownRunArtifact).
// No reason, Block text, task card, transcript or credential reaches the report, and no account unless asked for.

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { costOf, coversLine, decisionSpendRecords, loadPrices, stageHarnessOf, stageOf, stageSpendRecords, withLines, ACCOUNT } from "./cost-join.mjs";
import { downloadArtifactResult, ownRunArtifact, rest } from "./github.mjs";
import { APP_ID_VARIABLE, DEFAULTS, PENDULUM_VERSION } from "./inputs.mjs";
import { STATE_LABELS, loginKey, pushAuthor, rebaseCostOf, setSelf, selfLogin, spendParts } from "./logic.mjs";
import { pendulumOwn, throughApp } from "./finish-card.mjs";
import { BILLING, BILLING_WORDS, UNKNOWN_WHY, billingRead } from "./usage.mjs";

/** The report's schema: its name and major version. A change that renames, removes or retypes a field is a new version. */
export const REPORT_SCHEMA = "pendulum-report/1";
/** The default ceiling on GitHub API calls (`--max-calls`). */
export const DEFAULT_MAX_CALLS = 300;
/** The period a report covers when it names neither a period nor a set: the last 30 days. */
export const DEFAULT_DAYS = 30;
/** `pendulum report`'s exit when the call budget stopped it: the report printed is partial (`source.complete` false). */
export const STOPPED_EXIT = 3;
/** The cost kinds a figure is split into, never added together: the billing kinds (usage.mjs BILLING) and the sandbox's. */
export const COST_KINDS = Object.freeze([...BILLING, "sandbox"]);
/** What each kind's dollars are, word for word as the harness labels them. */
export const KIND_WORDS = Object.freeze({ ...BILLING_WORDS, api: "billed per use on an API key", sandbox: "the cloud sandbox vendor's cost at its list rates" });
/** An Objective's end, from its labels and its PRs. */
export const OUTCOMES = Object.freeze(["merged", "blocked", "question", "closed-unmerged", "open"]);

const PER_PAGE = 100;
const ms = (at) => (at ? Date.parse(at) : NaN);
const round6 = (n) => Math.round(n * 1e6) / 1e6;
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const MODEL = /^[A-Za-z0-9._:/-]{1,80}$/;
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:[-+][A-Za-z0-9.-]{1,40})?$/;
const PASS_LABEL = /^[a-z][a-z0-9-]{0,60}$/;
const HARNESSES = new Set(["claude", "codex", "copilot"]);
const modelKey = (v) => (typeof v === "string" && MODEL.test(v) ? v : null);
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

/** Why `pendulum report`'s flags do not make a report (a line for the usage message), or null. */
export function reportCheck(f) {
  if (f.since !== undefined && !reportTime(f.since)) return `--since takes a date (2026-11-01) or a time with its zone, not ${JSON.stringify(f.since)}`;
  if (f.until !== undefined && !reportTime(f.until)) return `--until takes a date (2026-11-01) or a time with its zone, not ${JSON.stringify(f.until)}`;
  if (f.since !== undefined && f.until !== undefined && !(Date.parse(reportTime(f.since)) < Date.parse(reportTime(f.until)))) return "--since must come before --until";
  if (f.issue !== undefined && !reportIssues(f.issue)) return `--issue takes issue numbers (12, or 12,15), not ${JSON.stringify(f.issue.join(" "))}`;
  if (f.parent !== undefined && !Number.isSafeInteger(f.parent)) return "--parent takes an issue number";
  if ([f.issue, f.label, f.parent].filter((v) => v !== undefined).length > 1) return "give one of --issue, --label or --parent";
  if (f.label !== undefined && !/^[^,\s][^,]{0,49}$/.test(f.label)) return `--label takes one label name, not ${JSON.stringify(f.label)}`;
  if (f.by !== undefined && f.by !== "account") return `--by takes account, not ${JSON.stringify(f.by)}`;
  if (f["max-calls"] !== undefined && !Number.isSafeInteger(f["max-calls"])) return "--max-calls takes a whole number of calls";
  if (f.app !== undefined && !Number.isSafeInteger(f.app)) return "--app takes the Pendulum App's numeric id";
  if (f.self !== undefined && f.self.some((l) => !LOGIN.test(l))) return `--self takes a GitHub login, not ${JSON.stringify(f.self.find((l) => !LOGIN.test(l)))}`;
  return null;
}

/**
 * The report's scope from its flags (reportCheck passed): {since, until, defaultPeriod, issues, label, parent}. A period
 * with no start (no set named, and no --since): the DEFAULT_DAYS days before --until (else now), from that day's UTC
 * midnight, said in the report (`scope.defaultPeriod`).
 */
export function reportScope(f, now = Date.now()) {
  const issues = f.issue ? reportIssues(f.issue) : [];
  const set = issues.length > 0 || f.label !== undefined || f.parent !== undefined;
  const until = f.until !== undefined ? reportTime(f.until) : null;
  const defaulted = !set && f.since === undefined;
  const since = f.since !== undefined ? reportTime(f.since) : defaulted ? midnight((until ? Date.parse(until) : now) - DEFAULT_DAYS * DAY_MS) : null;
  return { since, until, defaultPeriod: defaulted, issues, label: f.label ?? null, parent: f.parent ?? null };
}

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
const noResult = (artifact, workflowRun) => ({ artifact, workflowRun, standIn: true, harness: null, usd: null, usdUnknown: 1, usdUnknownWhy: ["unreported"], tokens: { input: null, output: null, cached: null, written: null }, basis: `unknown: no result.json in ${artifact}` });

// ------------------------------------------------------------------ reading

/**
 * Local mode's own usage records of Objective `n` in the clone `checkout` (`<checkout>/.pendulum/<n>/usage-*`
 * `/result.json`, local.mjs), by the progress comment they name (`progressRun`): read for the per-pass ledger and the
 * Pendulum version only; a local stage's dollars are in its spend line.
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
 * Read what a report needs from GitHub and the user's disk, within `maxCalls` GitHub API calls. `scope`: {since, until
 * (ISO or null), issues (numbers), label, parent}. `appId`: Pendulum's App id (pendulumOwn), else the repository variable
 * PENDULUM_APP_ID (one call), else `envAppId`; `self`: the logins `--self` names. `download(repo, artifact, token)` reads
 * an artifact's result.json (github.mjs downloadArtifactResult). A BudgetStop ends the reads early, with what was read
 * kept and `source.stopped` set.
 */
export async function readReport(repo, scope, { token, maxCalls = DEFAULT_MAX_CALLS, appId = null, envAppId = null, self = [], download = downloadArtifactResult, checkout = null, cacheDir = reportCacheDir(repo.full), log = () => {} } = {}) {
  const opts = { token };
  const budget = new Budget(maxCalls, log);
  const source = { stopped: null, comments: 0, pullsRead: false, artifactsRead: new Set(), artifacts: { listed: 0, downloaded: 0, cached: 0, expired: 0, noResult: 0, failed: 0, unreadable: 0, foreign: 0 }, foreignIssues: new Set(), localRecords: 0, selfKnown: false, login: null, appFrom: appId !== null ? "flag" : null };
  const issues = new Map();
  const pulls = [];
  let comments = [];
  const artifacts = new Map();
  const local = new Map();
  const base = `repos/${repo.full}`;
  const objectiveLabel = DEFAULTS.objective_label;
  const named = scope.issues.length > 0;
  const setMode = named || !!scope.label || !!scope.parent;
  let app = appId;
  try {
    // What is known before any read: Pendulum's own login and App, the set, the comments, the Objectives' issues and PRs.
    const first = 1 + (app === null ? 1 : 0) + (named ? scope.issues.length * 3 : (scope.label ? 1 : 0) + (scope.parent ? 1 : 0) + 1 + (setMode ? 0 : 1) + 1);
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
      budget.take("app id");
      try {
        const v = await rest(`${base}/actions/variables/${APP_ID_VARIABLE}`, opts);
        if (/^\d+$/.test(String(v?.value ?? "").trim())) {
          app = Number(String(v.value).trim());
          source.appFrom = "variable";
        }
      } catch (e) {
        if (e?.status !== 404 && e?.status !== 403) throw e;
      }
      if (app === null && envAppId !== null) {
        app = envAppId;
        source.appFrom = "env";
      }
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
      if (scope.label) for (const i of await paged(`${base}/issues?labels=${encodeURIComponent(scope.label)}&state=all${scope.since ? `&since=${encodeURIComponent(scope.since)}` : ""}`, budget, "issues", opts)) if (isIssue(i)) issues.set(i.number, i);
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
      pulls.push(...(await paged(`${base}/pulls?state=all&sort=updated&direction=desc`, budget, "pulls", opts, { stop: (items) => !!floor && ms(items.at(-1)?.updated_at) < ms(floor) })));
      source.pullsRead = true;
    }
    source.comments = comments.length;
    // The usage artifacts of the Objectives with a stage of Pendulum's own that has no spend line (an Actions stage).
    const unlined = [...issues.keys()].filter((n) => comments.some((c) => markerIssue(c) === n && mine(c) && /^<!-- pendulum:\d+:progress:(?:work|review):/.test(c.body || "") && !spendParts(c.body) && inWindow(c.created_at, scope)));
    if (unlined.length) budget.plan(unlined.length * 2, `the usage artifact lists of ${unlined.length} Objective(s) whose stages have no spend line (each download not yet cached adds 2)`);
    for (const n of unlined) {
      const found = [];
      for (const name of [`pendulum-usage-${n}`, `pendulum-usage-${n}-review`]) {
        try {
          found.push(...(await paged(`${base}/actions/artifacts?name=${encodeURIComponent(name)}`, budget, "artifact lists", opts)));
        } catch (e) {
          if (e?.status !== 403 && e?.status !== 404) throw e;
          source.artifacts.unreadable += 1;
        }
      }
      const recs = [];
      for (const a of found) {
        if (!Number.isSafeInteger(a?.id) || typeof a.name !== "string" || !/^[A-Za-z0-9._-]+$/.test(a.name)) continue;
        // A fork's run can upload an artifact of any name: never Pendulum's record.
        if (!ownRunArtifact(a)) {
          source.artifacts.foreign += 1;
          source.foreignIssues.add(n);
          continue;
        }
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
          budget.plan(2, `downloading ${a.name} (artifact ${a.id})`);
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
  for (const n of issues.keys()) {
    const recs = localRecords(checkout, n);
    if (recs.size) local.set(n, recs);
    source.localRecords += recs.size;
  }
  return { repo, scope, appId: app, self: [...new Set((self || []).map(loginKey))], issues, pulls, comments, artifacts, local, source: { ...source, calls: budget } };
}

/** Whether a time falls in the scope's period: at or after `since`, before `until`. */
export const inWindow = (at, scope) => (!scope.since || ms(at) >= ms(scope.since)) && (!scope.until || ms(at) < ms(scope.until));
/** Whether a decision-spend line's UTC day counts in the scope's period: its start (the day's midnight) falls in it. */
const dayInWindow = (date, scope) => inWindow(`${date}T00:00:00Z`, scope);

// ------------------------------------------------------------------ figures

/** A cost with every kind at zero: dollars per kind (COST_KINDS), the runs of unknown cost and why (UNKNOWN_WHY codes). */
const zeroCost = () => ({ usd: Object.fromEntries(COST_KINDS.map((k) => [k, 0])), unknownRuns: 0, unknownWhy: [] });
const addCost = (into, c) => {
  for (const k of COST_KINDS) into.usd[k] = round6(into.usd[k] + c.usd[k]);
  into.unknownRuns += c.unknownRuns;
  into.unknownWhy = [...new Set([...into.unknownWhy, ...c.unknownWhy])].sort();
  return into;
};
const zeroTokens = () => ({ input: null, output: null, cached: null, written: null });
const addTokens = (into, t) => {
  for (const k of Object.keys(into)) if (num(t?.[k]) !== null) into[k] = (into[k] ?? 0) + t[k];
  return into;
};

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

/** A pass label's kind: the label without its count (`work-2` is `work`, `validation-fix-3` is `validation-fix`). */
export const passKind = (label) => (typeof label === "string" && PASS_LABEL.test(label) ? label.replace(/-\d+$/, "") : "other");
const isFix = (kind) => /-(?:fix|fresh)$/.test(kind);
const isAnswer = (kind) => kind === "answer" || kind.startsWith("answer-");

/** One ledger entry as the report reads it: its kind, cost by billing, tokens and minutes; null for a broken one. */
function ledgerPass(e) {
  if (!e || typeof e !== "object") return null;
  const c = zeroCost();
  const usd = num(e.usd);
  const kind = BILLING.includes(e.billing) ? e.billing : "unknown";
  // Its dollars by kind as the ledger split them (a relayed key's share is `api`), the rest at the pass's own kind.
  const by = billingRead(e.usdByBilling);
  let named = 0;
  for (const [k, n] of Object.entries(by)) {
    c.usd[k] = round6(c.usd[k] + n);
    named += n;
  }
  if (usd !== null && usd - named > 1e-9) c.usd[kind] = round6(c.usd[kind] + usd - named);
  c.unknownRuns = Number.isInteger(e.usdUnknown) && e.usdUnknown > 0 ? e.usdUnknown : usd === null ? 1 : 0;
  c.unknownWhy = c.unknownRuns ? (Array.isArray(e.usdUnknownWhy) && e.usdUnknownWhy.length ? e.usdUnknownWhy : ["unreported"]).filter((w) => Object.hasOwn(UNKNOWN_WHY, w)).sort() : [];
  const minutes = Number.isFinite(ms(e.started)) && Number.isFinite(ms(e.ended)) && ms(e.ended) >= ms(e.started) ? (ms(e.ended) - ms(e.started)) / 60_000 : null;
  return { kind: e.decision ? "decision" : passKind(e.label), priced: usd !== null, cost: c, tokens: e.tokens || {}, minutes, decision: e.decision === true };
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
  const newest = (pulls || []).filter((p) => p?.head?.ref === `pendulum/${issue.number}` && p.head?.repo?.id === p.base?.repo?.id).sort((a, b) => ms(b.created_at) - ms(a.created_at))[0];
  return newest?.merged_at ? "merged" : "closed-unmerged";
}

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
 * `by`: the extra breakdowns asked for (`account`). `now`: when it was made (ISO).
 */
export function buildReport(read, { prices = loadPrices(), by = [], now = new Date().toISOString() } = {}) {
  const { repo, scope, issues, pulls, comments, artifacts, local, source } = read;
  const mine = ownPredicate(read.appId ?? null, read.self ?? []);
  const pushed = (c) => pushAuthor(c) || throughApp(c);
  const totals = zeroCost();
  const totalTokens = zeroTokens();
  const unknownItems = [];
  const views = { stage: breakdown(), pass: breakdown(), model: breakdown(), harness: breakdown(), version: breakdown(), account: breakdown() };
  const passMinutes = new Map();
  const cacheByKind = new Map();
  const objectives = [];
  const trust = { own: 0, vouched: 0, ignored: 0 };
  const missing = { noRecord: new Set(), stopped: new Set(), unattributed: new Set(), noLedger: new Set(), noVersion: new Set(), unreadIssue: new Set() };
  let stagesSeen = 0;
  let passesSeen = 0;

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
    const setMode = scope.issues.length > 0 || !!scope.label || !!scope.parent;
    if (setMode && !issue) continue;
    const { own = [], vouched = [] } = byIssue.get(n) ?? {};
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
    if (!stages.length && !vendors.length && !theirStages.length && !theirVendors.length && !theirDecisions.length && !decisions.length && !setMode) continue;
    if (!issue) missing.unreadIssue.add(n);

    // Every stage once (cost-join.mjs withLines): its usage record when one was read for it, else its spend line. A
    // record of a stage outside the period is left out; one that names no stage counts when it ended in the period.
    const allLines = stageSpendRecords(n, allStages, allVendors, { all: true });
    const lines = stageSpendRecords(n, stages, vendors, { all: true });
    const lineKeys = new Set(lines.map((l) => l.progressRun));
    const records = (artifacts?.get(n) || []).filter((r) => {
      const covered = allLines.filter(coversLine(r));
      return covered.length ? covered.some((l) => lineKeys.has(l.progressRun)) : inWindow(r.ended ?? r.started, scope);
    });
    const joined = withLines(records, lines);
    const unlined = new Set(stages.filter((c) => !spendParts(c.body)).map((c) => runOf(c.body)));
    // Whether this Objective's usage records were read: when the call budget stopped first, its stages are `stopped`.
    const notReached = !!source.stopped && !source.artifactsRead?.has(n);
    for (const r of joined) {
      // A stage of Pendulum's with no spend line and no record read for it: its cost is unknown, and why.
      if (r.source === "spend" && unlined.has(r.progressRun) && r.usd === null && !r.usdUnknown) {
        r.usdUnknown = 1;
        r.usdUnknownWhy = [notReached ? "stopped" : "no-record"];
        missing[notReached ? "stopped" : "noRecord"].add(n);
      }
    }
    // What Pendulum cannot attribute to itself: runs of unknown cost, never their figures.
    const unattributedRec = (c, stage, extra = {}) => ({ source: "spend", unattributed: true, harness: null, model: null, usd: null, usdUnknown: 1, usdUnknownWhy: ["unattributed"], tokens: zeroTokens(), runs: 1, artifact: `spend/${stage}/${c.id}`, ...extra });
    const unattributed = [...theirStages.map((c) => unattributedRec(c, progress.exec(c.body || "")[1])), ...theirVendors.map((c) => unattributedRec(c, vendorHead.exec(c.body || "")[1], { notStage: true }))];
    const theirCalls = theirDecisions.map((c) => ({ source: "decisions", unattributed: true, harness: null, model: null, usd: null, usdUnknown: 1, usdUnknownWhy: ["unattributed"], tokens: zeroTokens(), basis: `unknown: decision-spend lines in comment ${c.id}, not attributed` }));
    if (unattributed.length || theirCalls.length) missing.unattributed.add(n);
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
    const row = { issue: n, title: typeof issue?.title === "string" ? issue.title : null, url: `https://github.com/${repo.full}/issues/${n}`, outcome: issue ? outcomeOf(issue, pulls, { pullsRead: source.pullsRead !== false }) : null, stages: { work: 0, rebase: 0, review: 0 }, passes: null, cost: zeroCost(), tokens: zeroTokens(), modelMinutes: null, usdPerModelMinute: null };
    const minutes = { priced: 0, passes: 0, usd: zeroCost(), unpriced: 0 };
    let ledgered = 0;
    let unledgered = 0;
    cost.parts.forEach((part, i) => {
      const rec = all[i];
      const c = partCost(part, rec, claimOf(rec) === null || lastByClaim.get(claimOf(rec)) === i);
      const at = rec.source === "decisions" ? null : comment(rec);
      const stageKind = rec.source === "decisions" ? "decisions" : stageOf(rec) === "review" ? "review" : at && rebaseCostOf(at.body) ? "rebase" : "work";
      const line = at ? stageHarnessOf(at.body) : null;
      const key = at ? runOf(at.body) : typeof rec.progressRun === "string" ? rec.progressRun : null;
      const localRec = key ? localRecs.get(key) : null;
      const harness = rec.source === "decisions" ? "decisions" : HARNESSES.has(rec.harness) ? rec.harness : HARNESSES.has(line?.harness) ? line.harness : null;
      const model = rec.source === "decisions" ? "decisions" : modelKey(rec.model) ?? modelKey(line?.model);
      const ran = rec.ran ?? localRec?.ran ?? null;
      const version = typeof ran?.pendulum === "string" && VERSION.test(ran.pendulum) ? ran.pendulum : null;
      const account = rec.source === "decisions" ? null : [rec.account, line?.account].find((a) => typeof a === "string" && ACCOUNT.test(a)) ?? null;
      addCost(row.cost, c);
      addCost(totals, c);
      addTokens(row.tokens, part.tokens);
      addTokens(totalTokens, part.tokens);
      // A sandbox booking with no stage of its own counts its cost, but no stage.
      const count = rec.notStage ? 0 : 1;
      views.stage.add(stageKind, c, part.tokens, count);
      views.harness.add(harness, c, part.tokens, count);
      views.model.add(model, c, part.tokens, count);
      views.version.add(rec.source === "decisions" ? "decisions" : version, c, part.tokens, count);
      if (by.includes("account")) views.account.add(rec.source === "decisions" ? "decisions" : account, c, part.tokens, count);
      if (rec.source !== "decisions" && !rec.notStage) {
        stagesSeen += 1;
        row.stages[stageKind] += 1;
        if (!version && !rec.unattributed) missing.noVersion.add(n);
      }
      if (c.unknownRuns) unknownItems.push({ issue: n, stage: stageKind, runs: c.unknownRuns, why: c.unknownWhy });
      // The stage's passes, from its per-pass ledger (its usage record's, or local mode's own record of it).
      const ledger = Array.isArray(rec.ledger) ? rec.ledger : Array.isArray(localRec?.ledger) ? localRec.ledger : null;
      if (rec.source === "decisions" || rec.unattributed) return;
      if (!ledger) {
        unledgered += 1;
        missing.noLedger.add(n);
        return;
      }
      ledgered += 1;
      row.passes ??= { total: 0, answer: 0, fix: 0 };
      for (const p of ledger.map(ledgerPass).filter(Boolean)) {
        passesSeen += 1;
        row.passes.total += 1;
        if (isAnswer(p.kind)) row.passes.answer += 1;
        if (isFix(p.kind)) row.passes.fix += 1;
        views.pass.add(p.kind, p.cost, p.tokens);
        const t = p.tokens;
        if (num(t.input) !== null && num(t.written) !== null) {
          const k = cacheByKind.get(p.kind) ?? { passKind: p.kind, passes: 0, written: 0, input: 0 };
          k.passes += 1;
          k.written += t.written;
          k.input += t.input;
          cacheByKind.set(p.kind, k);
        }
        if (p.minutes !== null) passMinutes.set(p.kind, (passMinutes.get(p.kind) ?? 0) + p.minutes);
        // Cost per model minute: over the harness passes whose dollars were all reported, each kind's dollars apart.
        if (!p.decision && p.minutes !== null) {
          if (p.cost.unknownRuns || !p.priced) minutes.unpriced += 1;
          else {
            minutes.priced += p.minutes;
            minutes.passes += 1;
            addCost(minutes.usd, p.cost);
          }
        }
      }
    });
    if (ledgered && !unledgered) {
      row.modelMinutes = round2(minutes.priced);
      // Each kind's dollars over the same priced passes' minutes: one ratio per kind, never summed across kinds.
      row.usdPerModelMinute = minutes.priced > 0 ? Object.fromEntries(BILLING.filter((k) => minutes.usd.usd[k] > 0).map((k) => [k, { usd: minutes.usd.usd[k], modelMinutes: round2(minutes.priced), passes: minutes.passes, usdPerModelMinute: round6(minutes.usd.usd[k] / minutes.priced) }])) : {};
      row.unpricedPasses = minutes.unpriced;
    } else if (ledgered) row.passes = null;
    objectives.push(row);
  }

  const rank = (items, field) => items.sort((a, b) => b[field] - a[field] || (a.issue ?? 0) - (b.issue ?? 0) || String(a.passKind ?? "").localeCompare(String(b.passKind ?? "")));
  const passRows = views.pass.rows().map((r) => ({ key: r.key, passes: r.stages, cost: r.cost, tokens: r.tokens, modelMinutes: passMinutes.has(r.key) ? round2(passMinutes.get(r.key)) : null }));
  const report = {
    schema: REPORT_SCHEMA,
    repository: repo.full,
    generatedAt: now,
    pendulum: PENDULUM_VERSION,
    scope: { since: scope.since ?? null, until: scope.until ?? null, defaultPeriod: !!scope.defaultPeriod, issues: scope.issues, label: scope.label ?? null, parent: scope.parent ?? null, by },
    words: { ...KIND_WORDS },
    totals: { objectives: objectives.length, stages: stagesSeen, passes: passesSeen, cost: totals, tokens: totalTokens },
    unknown: {
      runs: totals.unknownRuns,
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
    hotSpots: {
      reviewLoops: { rankBy: "reviews", items: rank(objectives.filter((o) => o.stages.review > 0).map((o) => ({ issue: o.issue, reviews: o.stages.review })), "reviews") },
      answerAndFixPasses: { rankBy: "passes", items: rank(objectives.filter((o) => o.passes && o.passes.answer + o.passes.fix > 0).map((o) => ({ issue: o.issue, answer: o.passes.answer, fix: o.passes.fix, passes: o.passes.answer + o.passes.fix })), "passes"), unrecorded: objectives.filter((o) => !o.passes).map((o) => o.issue) },
      cacheWriteShare: { rankBy: "share", items: rank([...cacheByKind.values()].filter((k) => k.input > 0).map((k) => ({ ...k, share: Math.round((k.written / k.input) * 10000) / 10000 })), "share") },
      costPerModelMinute: { rankBy: "usdPerModelMinute", items: BILLING.flatMap((kind) => rank(objectives.filter((o) => o.usdPerModelMinute?.[kind]).map((o) => ({ issue: o.issue, billing: kind, ...o.usdPerModelMinute[kind] })), "usdPerModelMinute")) },
      blockedOrUnmergedSpend: { rankBy: "stages", items: rank(objectives.filter((o) => o.outcome === "blocked" || o.outcome === "closed-unmerged").map((o) => ({ issue: o.issue, outcome: o.outcome, stages: o.stages.work + o.stages.rebase + o.stages.review, cost: o.cost })), "stages") },
    },
    source: sourceOf(source, trust, missing, read),
  };
  return report;
}

const round2 = (n) => Math.round(n * 100) / 100;

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

/** The source section: the calls made, what was read and what was missing, each a count and the issues it touches. */
function sourceOf(source, trust, missing, read) {
  const calls = source.calls;
  const out = [];
  const add = (code, issues, text) => {
    const list = issuesOf(issues);
    if (list.length) out.push({ code, count: list.length, issues: list, text });
  };
  if (source.stopped) out.push({ code: "stopped", count: 1, issues: [], text: `the reads stopped at --max-calls ${calls.max} before ${source.stopped}: what is shown is partial` });
  if (!source.selfKnown) out.push({ code: "self-unknown", count: 1, issues: [], text: "the login the token belongs to could not be read, so only Pendulum's App (--app) counts as Pendulum's own" });
  if (trust.vouched && read.appId === null) out.push({ code: "app-not-given", count: trust.vouched, issues: [], text: "comments by another login that can push or through a GitHub App are not attributed to Pendulum: no App id was given (--app) or found (the repository variable PENDULUM_APP_ID)" });
  add("unattributed", missing.unattributed, UNKNOWN_WHY.unattributed);
  add("no-record", missing.noRecord, UNKNOWN_WHY["no-record"]);
  add("stopped-before-records", missing.stopped, UNKNOWN_WHY.stopped);
  add("artifact-foreign", source.foreignIssues ?? new Set(), `usage artifacts uploaded by runs from forks (${source.artifacts.foreign}), never read as Pendulum's`);
  add("no-ledger", missing.noLedger, "stages whose usage record has no per-pass ledger (an older record, or a local stage's spend line with no local record on this machine): no pass breakdown, answer and fix passes or cost per model minute for them");
  add("no-version", missing.noVersion, "stages whose record names no Pendulum version (an older record, or a spend line)");
  add("issue-unread", missing.unreadIssue, "issues with Pendulum's markers that could not be read: no outcome or title for them");
  if (source.artifacts.expired) out.push({ code: "artifact-expired", count: source.artifacts.expired, issues: [], text: "usage artifacts past GitHub's retention, not cached here" });
  if (source.artifacts.failed) out.push({ code: "artifact-failed", count: source.artifacts.failed, issues: [], text: "usage artifacts that could not be downloaded" });
  if (source.artifacts.unreadable) out.push({ code: "artifacts-unreadable", count: source.artifacts.unreadable, issues: [], text: "artifact lists the token may not read (it needs actions: read), or artifacts that name no workflow run" });
  return {
    complete: !source.stopped,
    stoppedAt: source.stopped ?? null,
    maxCalls: calls.max,
    calls: { planned: calls.planned, plannedAtLeast: !!calls.open, made: calls.made, byKind: { ...calls.byKind } },
    // Whose markers were taken as Pendulum's: the token's own login, the logins --self named (each only on a comment by
    // someone who can push) and the App, with where its id came from (`flag`, `variable`, `env`).
    trusted: { logins: [...new Set([source.login, ...(read.self ?? [])].filter(Boolean))], app: read.appId ?? null, appFrom: read.appId === null || read.appId === undefined ? null : source.appFrom ?? null },
    read: { comments: source.comments, pendulumComments: trust.own, unattributedComments: trust.vouched, ignoredComments: trust.ignored, issues: read.issues?.size ?? 0, pulls: read.pulls?.length ?? 0, artifacts: { ...source.artifacts }, localRecords: source.localRecords },
    missing: out,
  };
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
  const what = s.issues.length ? `issues ${s.issues.map((n) => `#${n}`).join(", ")}` : s.label ? `issues labelled \`${s.label}\`` : s.parent ? `the sub-issues of #${s.parent}` : "every Objective";
  const when = s.since || s.until ? ` with stages from ${s.since ?? "the start"} to ${s.until ?? "now"}${s.defaultPeriod ? " (the default period)" : ""}` : "";
  const out = [`# Pendulum cost report: ${r.repository}`, "", `${what}${when}. ${r.totals.objectives} Objective(s), ${r.totals.stages} stage(s). Made ${r.generatedAt} by Pendulum ${r.pendulum} (schema ${r.schema}).`];
  if (!r.source.complete) out.push("", `**Partial:** ${r.source.missing.find((m) => m.code === "stopped").text}.`);
  out.push("", "## Totals", "", "Each kind's dollars are apart; they are never added together.", "", table(COST_HEAD, [costCells(r.totals.cost)]));
  out.push("", `- API: ${r.words.api}. Subscription: ${r.words.subscription}. Copilot: ${r.words.credits}. Sandbox: ${r.words.sandbox}.`);
  out.push(`- Runs of unknown cost: ${r.unknown.runs}${r.unknown.reasons.length ? ` (${r.unknown.reasons.map((x) => `${x.stages} stage(s)${x.runs === null ? "" : `, ${x.runs} run(s)`}: ${x.text}`).join("; ")})` : ""}.`);
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
  const h = r.hotSpots;
  out.push("", "## Hot spots", "", "Ranked by exact counts; nothing is flagged against a threshold.");
  const list = (title, items, line) => out.push("", `**${title}**: ${items.length ? items.map(line).join("; ") : "none"}`);
  list("Review stages", h.reviewLoops.items, (x) => `#${x.issue} ${x.reviews}`);
  list("Answer and fix passes", h.answerAndFixPasses.items, (x) => `#${x.issue} ${x.passes} (${x.answer} answer, ${x.fix} fix)`);
  list("Cache-write share by pass kind", h.cacheWriteShare.items, (x) => `${x.passKind} ${(x.share * 100).toFixed(1)}% (${x.written} of ${x.input} input tokens)`);
  list("Cost per model minute", h.costPerModelMinute.items, (x) => `#${x.issue} ${money(x.usdPerModelMinute)}/min ${x.billing} (${money(x.usd)} over ${x.modelMinutes} min)`);
  list("Spend in Objectives that ended Blocked or closed unmerged", h.blockedOrUnmergedSpend.items, (x) => `#${x.issue} ${x.outcome}, ${x.stages} stage(s): ${COST_KINDS.filter((k) => x.cost.usd[k]).map((k) => `${money(x.cost.usd[k])} ${k}`).join(", ") || "$0.00"}${x.cost.unknownRuns ? ` plus ${x.cost.unknownRuns} run(s) of unknown cost` : ""}`);
  const src = r.source;
  out.push("", "## Source", "", `${src.calls.made} GitHub API call(s) of --max-calls ${src.maxCalls}. Read: ${src.read.comments} comment(s) (${src.read.pendulumComments} of Pendulum's own, ${src.read.unattributedComments} not attributed, ${src.read.ignoredComments} ignored), ${src.read.issues} issue(s), ${src.read.pulls} PR(s), ${src.read.artifacts.listed} usage artifact(s) (${src.read.artifacts.downloaded} downloaded, ${src.read.artifacts.cached} from the cache), ${src.read.localRecords} local record(s).`);
  out.push("", src.missing.length ? src.missing.map((m) => `- Missing: ${m.text} (${m.count}${m.issues.length ? `: ${m.issues.map((n) => `#${n}`).join(", ")}` : ""})`).join("\n") : "- Nothing missing.");
  return `${out.join("\n")}\n`;
}
