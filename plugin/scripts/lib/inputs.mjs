// Inputs for every Pendulum script, from one place.
//
// Precedence, highest first:
//   1. a CLI flag (`--max-usd 20`), for the plugin skills and local runs;
//   2. PENDULUM_INPUT_<NAME>, which action.yml sets from `with:` on the job;
//   3. PENDULUM_<NAME>: the repository's settings in layers (settingLayers below): the
//      workflow-level `env:` block the template carries, under a repository variable of
//      the same name (on Actions laid over this process's env when this module loads,
//      applyVariables), under, in local mode, this machine's own environment;
//   4. the default below.
// The action declares no defaults of its own, so an empty `with:` value falls
// through to the env block rather than overriding it with "".
import { appendFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { HOLD_MAX_MS } from "./holds.mjs";

/**
 * Per-harness model defaults (Kirk, Nov 3: Opus high worker, Sonnet implementers, Fable reviewer; Opus xhigh when Fable's
 * quota is out). `reviewer_effort` is passed on every reviewer call, since no harness applies its reviewer agent file's
 * effort to a run that only names that file: Codex's is its agent file's (agents/source.json, `high`). The Claude and
 * Copilot agent files declare none, so those reviewers keep their CLI's default (nothing passed) until a measured run
 * says otherwise; an owner sets one with reviewer_effort.
 */
export const MODEL_DEFAULTS = {
  claude: { model: "claude-opus-5-5", subagent_model: "claude-sonnet-5-5", reviewer_model: "claude-fable-5-2", reviewer_fallback: "claude-opus-5-5", reviewer_fallback_effort: "xhigh", effort: "medium" },
  codex: { model: "gpt-6.1-sol", subagent_model: "gpt-6.1-sol", reviewer_model: "gpt-6.1-sol", reviewer_effort: "high" },
  copilot: { model: "", subagent_model: "", reviewer_model: "" },
};

/** This plugin's version (its manifest), the tag the Action default and setup's fallback pin name. */
export const PENDULUM_VERSION = JSON.parse(readFileSync(new URL("../../.claude-plugin/plugin.json", import.meta.url), "utf8")).version;

/**
 * image_max_age_days (lib/image.mjs imageDecision): its default, and its bounds. A person owns it: at least a day, and
 * never more than IMAGE_MAX_AGE_MAX, so no image goes unrefreshed (its base image, the unpinned things setup fetches)
 * without end. A value outside them is refused (VALUE_RULES) and reads as the default.
 */
export const IMAGE_MAX_AGE_DAYS = 7;
export const IMAGE_MAX_AGE_MAX = 30;

export const DEFAULTS = {
  harness: "claude",
  model: "", // empty: MODEL_DEFAULTS for the harness
  effort: "", // empty: MODEL_DEFAULTS for the harness (the worker's effort)
  compaction_window: "", // empty: the CLI default (Claude and Codex; Copilot has no such setting)
  resume_policy: "fresh", // fresh | fix-passes: which re-entries resume the worker's saved session
  publish_transcripts: "false", // true: a public repository's usage artifacts carry the transcript and the event stream readable (lib/seal.mjs); else sealed
  prompt_cache_ttl: "off", // off | auto | 1h | 5m: Claude's main-conversation cache TTL (harness.mjs promptCacheTtl)
  subagent_model: "",
  reviewer_model: "",
  reviewer_effort: "", // empty: MODEL_DEFAULTS for the harness (the reviewer's effort, on every reviewer call)
  credential: "api", // api | plan (your own repository) | login (a developer's machine only)
  max_concurrent: "3",
  sibling_hold: "on", // on | off: a hand-off to review waits for a sibling on the same files (lib/overlap.mjs)
  rebase_limit: "5", // send-backs for a rebase one Objective gets in 24 h before it Blocks (logic.mjs staleDecision)
  guess_hours: "1, 4, 24", // how long automatic account choice passes over an account whose usage limit reported no reset, by how many in a row (holds.mjs spent)
  daily_usd: "100",
  copilot_credit_usd: "", // empty: GitHub's published $0.01 per AI credit (usage.mjs COPILOT_CREDIT_USD)
  max_usd: "25",
  max_objective_usd: "", // empty or 0: no cap on an Objective's known spend across its stages (objective-cap.mjs capGate)
  timeout_minutes: "240",
  auto_merge: "true",
  notify: "",
  maintainers: "",
  setup: "",
  install: "auto",
  validation: "",
  budget_command: "",
  protected_paths: "",
  toolchain_paths: "", // paths a fix pass may change only in its scope or on the fence check's yes, beside the exact lists (logic.mjs toolchainFile); empty: none
  ci_checks: "",
  third_party_reviewers: "", // reviewer logins outside Pendulum (`greptile-apps[bot]`) whose review the review stage waits for and answers (lib/third-party-review.mjs); empty: none
  third_party_wait_minutes: "20", // how long the review stage waits for their review of the head (lib/third-party-review.mjs)
  harness_version: "latest",
  allowed_domains: "", // The harness's sandbox (Claude Code, Codex, Copilot) on Actions and in a cloud sandbox: hosts its commands may reach beyond GitHub and the npm and Yarn registries (local.mjs runnerDomains)
  node_version: "22",
  project: "", // the Pendulum board's node id, recorded by setup (github.mjs findProject); empty: the board titled exactly "Pendulum: <repo>"
  action: `clockgrove/pendulum@v${PENDULUM_VERSION}`,
  objective_label: "pendulum:objective",
  mode: "",
  issue: "",
  pr: "",
  account: "", // the account the job's account step picked (action.yml PENDULUM_STAGE_ACCOUNT, lib/accounts.mjs, #267); a run's own
  rendered_accounts: "", // the accounts setup rendered the workflow's credential inputs for (action.yml PENDULUM_RENDERED_ACCOUNTS, account mode)
  vars: "", // the workflow's `${{ toJSON(vars) }}`: the repository's variables (applyVariables)
  repo: "",
  app_id: "",
  app_private_key: "",
  anthropic_api_key: "",
  anthropic_oidc_exchange_url: "",
  claude_code_oauth_token: "",
  codex_api_key: "",
  codex_gateway_key: "", // Codex through the Vercel AI Gateway (harness.mjs credentialEnv); wins over codex_api_key when set
  copilot_github_token: "",
  ai_gateway_api_key: "", // the decision calls' AI Gateway models (decider.mjs); empty: the stage's own harness answers them
  decision_route: "auto", // auto | gateway | off: who answers the decision calls (decider.mjs DECISION_ROUTES)
  worker_secrets: "", // the secrets the worker's shell gets, `NAME` or `NAME=SOURCE` each (lib/worker-secrets.mjs); empty: none
  worker_secret_values: "", // their values on Actions and in a cloud sandbox, `SOURCE=value` lines (a secret input)
  triage_model: "", // empty: TRIAGE_MODEL_DEFAULT (triage.mjs TRIAGE_MODEL)
  triage_min_confidence: "", // empty: triage.mjs MIN_CONFIDENCE, measured on TRIAGE_MODEL; goes with triage_model (settingLayers, resolveInputs)
  drift_model: "", // empty: drift.mjs DRIFT_MODEL (the drift advisory, on with ai_gateway_api_key)
  github_token: "",
  app_token: "",
  sandbox: "", // empty: the runner is the sandbox (work and review jobs); `vercel`: launcher jobs start a cloud sandbox
  vercel_token: "",
  vercel_team_id: "",
  vercel_project_id: "",
  image_refresh: "merge", // merge | nightly (lib/image.mjs imageDecision)
  image_daily_minutes: "5",
  image_max_age_days: String(IMAGE_MAX_AGE_DAYS), // lib/image.mjs imageDecision: the current image stands for a head while younger
  image_owed: "", // image.mjs: `true` when the dispatcher's tick found a build owed (lib/image.mjs imageOwed)
  sandbox_idle_days: "7", // sweep.mjs: a stopped sandbox of an Objective neither Running nor In review, this long, goes
  sweep_max_destroys: "5",
  // Limits a person owns (OWNER_LIMITS below has each one's rule and bound).
  usage_limit_waits: "2", // waits in place for a usage limit's reset one pass gets (harness.mjs LIMIT.waits)
  usage_limit_move_minutes: "60", // on Actions and the cloud sandbox, a longer wait moves to a free account (LIMIT.movePastMs)
  claim_pause_hours: "24", // a quiet local claim pauses its Objective this long, then the dispatcher Blocks it (dispatch.mjs)
  sibling_wait_hours: "6", // the longest a hand-off or a rebase waits for a sibling ahead (overlap.mjs)
  max_parts: "6", // the most sequential PRs one Objective splits into (handoff.mjs nextPart)
  step_stall_factor: "3", // a queue check's step is hung past this many times its normal duration (logic.mjs stepStallMs)
  step_stall_floor_minutes: "15", // ... and never before its normal duration plus this
  queue_stall_minutes: "10", // a merge queue commit with no CI begun this long is stalled (logic.mjs queueStall)
};

export const SECRET_INPUTS = new Set(["app_private_key", "anthropic_api_key", "claude_code_oauth_token", "codex_api_key", "codex_gateway_key", "copilot_github_token", "ai_gateway_api_key", "worker_secret_values", "github_token", "app_token", "vercel_token"]);
/**
 * Local mode's own settings a repository's workflow env block may set (docs/LOCAL.md, Configuration); the developer's
 * shell wins over each.
 */
export const LOCAL_WORKFLOW_SETTINGS = ["PENDULUM_LOCAL_DOMAINS", "PENDULUM_LOCAL_ENV", "PENDULUM_LOCAL_SETUP", "PENDULUM_LOCAL_VALIDATION", "PENDULUM_LOCAL_DB", "PENDULUM_LOCAL_DB_INIT", "PENDULUM_PG_BIN", "PENDULUM_LOCAL_MAX_CONCURRENT", "PENDULUM_LOCAL_MEDIA_MAX_MB", "PENDULUM_LOCAL_WAIT_MINUTES", "PENDULUM_LOCAL_OUTAGE_HOURS", "PENDULUM_LOCAL_LAPSE_MAX", "PENDULUM_LOCAL_TOKEN_PROBE_MAX"];
/**
 * Local mode's bounded whole-number settings (docs/LOCAL.md, Configuration), each its default, least and most:
 * `PENDULUM_LOCAL_LAPSE_MAX`, the lapse in a row that Blocks a stage the lapse check judges transient (local.mjs lapse);
 * `PENDULUM_LOCAL_TOKEN_PROBE_MAX`, the most repositories the local token's check probes (local.mjs checkToken).
 */
export const LOCAL_BOUNDS = Object.freeze({
  PENDULUM_LOCAL_LAPSE_MAX: Object.freeze({ fallback: 3, min: 2, max: 10 }),
  PENDULUM_LOCAL_TOKEN_PROBE_MAX: Object.freeze({ fallback: 100, min: 1, max: 1000 }),
});
/**
 * A LOCAL_BOUNDS setting's value (`name`, as set: unset or empty is the default): `{value, problem}`, where a value that is
 * no whole number within the bounds is the default and `problem` names it for the log.
 */
export function localBound(name, value) {
  const b = LOCAL_BOUNDS[name];
  const v = String(value ?? "").trim();
  if (v === "") return { value: b.fallback, problem: null };
  if (/^\d+$/.test(v) && Number(v) >= b.min && Number(v) <= b.max) return { value: Number(v), problem: null };
  return { value: b.fallback, problem: `${name} ${JSON.stringify(v)} is not a whole number from ${b.min} to ${b.max}; using ${b.fallback}` };
}
/** DEFAULTS keys that are no input of the Action (action.yml): Pendulum's own, or a run's argument. */
const NOT_INPUTS = ["action", "objective_label", "repo"];
/**
 * Inputs each run gives (a dispatch's or a stage's own), never a setting: `vars` is the workflow's `vars` context, the
 * repository's variables (applyVariables); `rendered_accounts` is what setup rendered the jobs for.
 */
export const PER_RUN_INPUTS = ["mode", "issue", "pr", "vars", "account", "rendered_accounts"];
/**
 * The PENDULUM_* names a workflow's env block may set (#119): the Action's inputs (DEFAULTS, which test/inputs checks
 * against action.yml) under their env names, but secrets and a run's own, and local mode's settings. Local mode takes
 * only these from the repository's workflow file, which is repository content: any other PENDULUM_* name is Pendulum's
 * own control (a stage's identity, a sandbox's settings file, the bot it is), never the repository's to set.
 */
export const WORKFLOW_SETTINGS = new Set([
  ...Object.keys(DEFAULTS)
    .filter((n) => !NOT_INPUTS.includes(n) && !PER_RUN_INPUTS.includes(n) && !SECRET_INPUTS.has(n))
    .map((n) => `PENDULUM_${n.toUpperCase()}`),
  ...LOCAL_WORKFLOW_SETTINGS,
]);
/** The settings whose value differs between two workflow env blocks (the working tree's and the default branch's, #122). */
export const workflowDrift = (working = {}, committed = {}) => {
  const a = workflowSettings(working).kept;
  const b = workflowSettings(committed).kept;
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k]).sort();
};
/**
 * What local mode says when this working tree's workflow settings differ from the default branch's, which it uses (#122):
 * one line naming the settings, or none.
 */
export function workflowDriftLines(working, committed) {
  if (!committed.branch) return [];
  const drift = workflowDrift(working, committed.wf);
  return drift.length ? [`.github/workflows/pendulum.yml here differs from origin/${committed.branch} in ${drift.join(", ")}: local mode uses origin/${committed.branch}'s; commit the change to ${committed.branch} to use it`] : [];
}

/**
 * Settings another route reads from the workflow's env block (plugin/workflow-template.yml): the cloud sandbox's size,
 * which setup writes, and the accounts GitHub Actions and the cloud sandbox run on and their automatic choice
 * (lib/accounts.mjs routeAccounts, routeAutoSetting; local mode's are this machine's own). Local mode leaves them out of every stage, as any name it does not take, but does not
 * warn about them (#179).
 */
export const OTHER_ROUTE_SETTINGS = new Set(["PENDULUM_SANDBOX_VCPUS", "PENDULUM_ACCOUNTS", "PENDULUM_AUTO_ACCOUNT"]);

/**
 * A workflow env block (local.mjs workflowEnv) split into the settings Pendulum takes, the names it drops and warns
 * about, and another route's own settings it drops quietly.
 */
export function workflowSettings(wf = {}) {
  const kept = {};
  const dropped = [];
  const otherRoute = [];
  for (const [k, v] of Object.entries(wf)) {
    if (WORKFLOW_SETTINGS.has(k)) kept[k] = v;
    else if (OTHER_ROUTE_SETTINGS.has(k)) otherRoute.push(k);
    else dropped.push(k);
  }
  return { kept, dropped, otherRoute };
}
/**
 * Settings that steer trust or money's route, whom Pendulum answers and what gates a merge, what a stage may reach or
 * receive or what it publishes, or how it is set up and installed (the binaries it runs and the Node.js it runs on included), and the ids of the App, the sandbox vendor
 * and the federation endpoint the credentials go with, and the dispatcher's own per-run `image_owed`: only the reviewed
 * workflow file sets them, never a repository variable (#284), since anyone with write access can set one. One set as a
 * variable is named and ignored.
 */
export const WORKFLOW_ONLY_SETTINGS = new Set(
  [
    ...["CREDENTIAL", "AUTO_MERGE", "NOTIFY", "MAINTAINERS", "PROTECTED_PATHS", "ALLOWED_DOMAINS", "LOCAL_DOMAINS", "WORKER_SECRETS", "LOCAL_ENV", "SANDBOX", "HARNESS_VERSION", "SETUP", "INSTALL", "BUDGET_COMMAND", "LOCAL_SETUP", "LOCAL_DB"],
    ...["THIRD_PARTY_REVIEWERS", "THIRD_PARTY_WAIT_MINUTES", "CI_CHECKS", "PG_BIN", "NODE_VERSION", "PROJECT"],
    ...["APP_ID", "ANTHROPIC_OIDC_EXCHANGE_URL", "VERCEL_TEAM_ID", "VERCEL_PROJECT_ID", "IMAGE_OWED"],
    ...["PUBLISH_TRANSCRIPTS"],
  ].map((n) => `PENDULUM_${n}`),
);
/** The settings a repository variable of the same name sets over the workflow's env block (#284): caps, money, the harness, models, effort, validation, sweep, scheduling. */
export const VARIABLE_SETTINGS = new Set([...WORKFLOW_SETTINGS].filter((k) => !WORKFLOW_ONLY_SETTINGS.has(k)));
/** The worker's harness, models and effort: a layer that sets another harness drops the lower layers' (settingLayers). */
export const MODEL_SETTINGS = ["PENDULUM_MODEL", "PENDULUM_SUBAGENT_MODEL", "PENDULUM_REVIEWER_MODEL", "PENDULUM_REVIEWER_EFFORT", "PENDULUM_EFFORT"];
/**
 * The settings this machine's own environment sets over the repository's in local mode (local.mjs baseEnv): the harness,
 * models and session settings, set to a non-empty value, and local mode's own settings (PENDULUM_LOCAL_*), set at all.
 */
export const MACHINE_SETTINGS = ["PENDULUM_HARNESS", ...MODEL_SETTINGS, "PENDULUM_RESUME_POLICY", "PENDULUM_COMPACTION_WINDOW", "PENDULUM_PROMPT_CACHE_TTL", "PENDULUM_TRIAGE_MODEL", "PENDULUM_TRIAGE_MIN_CONFIDENCE", "PENDULUM_DRIFT_MODEL", "PENDULUM_DECISION_ROUTE", "PENDULUM_WORKER_SECRETS"];
const MACHINE_LOCAL = LOCAL_WORKFLOW_SETTINGS.filter((k) => k.startsWith("PENDULUM_LOCAL_"));

/**
 * The repository's variables ({NAME: value}, as GitHub lists them or the `vars` context holds them) as settings: `kept`,
 * the VARIABLE_SETTINGS they set (an empty value sets nothing); `excluded`, the WORKFLOW_ONLY_SETTINGS names they set,
 * which are ignored; `unknown`, any other PENDULUM_* name, no setting. Names without the PENDULUM_ prefix are not Pendulum's.
 */
/**
 * The repository variable that records Pendulum's App id (`pendulum setup` writes it beside the PENDULUM_APP_ID secret):
 * no setting, so no run reads it; `pendulum report` and doctor do (report.mjs, doctor.mjs appIdVariableCheck).
 */
export const APP_ID_VARIABLE = "PENDULUM_APP_ID";

export function variableSettings(vars = {}) {
  const kept = {};
  const excluded = [];
  const unknown = [];
  const invalid = [];
  for (const [k, v] of Object.entries(vars && typeof vars === "object" ? vars : {})) {
    const name = String(k).toUpperCase();
    if (!name.startsWith("PENDULUM_") || name === APP_ID_VARIABLE) continue;
    if (VARIABLE_SETTINGS.has(name)) {
      if (v === null || v === undefined || String(v) === "") continue;
      const why = valueProblem(name, String(v));
      if (why) invalid.push({ name, value: String(v), why });
      else kept[name] = name === "PENDULUM_HARNESS" ? harnessName(v) : String(v);
    } else if (WORKFLOW_ONLY_SETTINGS.has(name)) excluded.push(name);
    else unknown.push(name);
  }
  return { kept, excluded: excluded.sort(), unknown: unknown.sort(), invalid: invalid.sort((a, b) => a.name.localeCompare(b.name)) };
}

/** The longest third-party wait (third_party_wait_minutes), and the most a wait record's `minutes` is taken as. */
export const THIRD_PARTY_WAIT_MAX_MINUTES = 24 * 60;
/** The longest step of the no-reset guess (guess_hours): the longest hold a record keeps (holds.mjs HOLD_MAX_MS). */
export const GUESS_MAX_HOURS = HOLD_MAX_MS / 3600_000;
/** Whether `hours` (numbers) is a usable guess: at least one step, each above 0 and at most GUESS_MAX_HOURS. */
export const guessHoursValid = (hours) => Array.isArray(hours) && hours.length > 0 && hours.every((h) => typeof h === "number" && Number.isFinite(h) && h > 0 && h <= GUESS_MAX_HOURS);

const number = (v) => v.trim() !== "" && Number.isFinite(Number(v));

/**
 * Limits a person owns (#423), each a setting whose default is DEFAULTS's (or LOCAL_LIMIT_DEFAULTS's) and whose value
 * must lie in its range: `whole` a whole number, `from` the least it may be (`above` true: it must be above it), `max`
 * the most, so no value can push a time past what a Date holds. A value out of its rule reads as the default, and a
 * repository variable that sets one is named as invalid (VALUE_RULES).
 */
export const OWNER_LIMITS = {
  PENDULUM_USAGE_LIMIT_WAITS: { whole: true, from: 0, max: 10 },
  PENDULUM_USAGE_LIMIT_MOVE_MINUTES: { from: 0, above: true, max: 24 * 60 },
  // At least two of the hourly beats a loop writes on a paused Objective's claim (local.mjs PAUSED_BEAT_MS), and twice
  // the most a local stage waits in place writing none (PENDULUM_LOCAL_WAIT_MINUTES).
  PENDULUM_CLAIM_PAUSE_HOURS: { from: 2, max: 30 * 24 },
  PENDULUM_SIBLING_WAIT_HOURS: { from: 0, above: true, max: 7 * 24 },
  PENDULUM_MAX_PARTS: { whole: true, from: 1, max: 50 },
  PENDULUM_STEP_STALL_FACTOR: { from: 1, max: 100 },
  // At least a minute each: near 0, every queue commit is stalled the moment it is made (dequeued, requeued, Blocked, so
  // nothing merges), and every running check's job is read again on each poll, on the shared API quota.
  PENDULUM_STEP_STALL_FLOOR_MINUTES: { from: 1, max: 24 * 60 },
  PENDULUM_QUEUE_STALL_MINUTES: { from: 1, max: 24 * 60 },
  // At most half the claim pause's least (two hours): a stage waiting in place writes no heartbeat while this machine's
  // network is down, so its wait ends well before the dispatcher could take its quiet claim for a loop gone away.
  PENDULUM_LOCAL_WAIT_MINUTES: { from: 0, above: true, max: 60 },
  PENDULUM_LOCAL_OUTAGE_HOURS: { from: 0, above: true, max: 30 * 24 },
};
/** Local mode's own limits (LOCAL_WORKFLOW_SETTINGS, no Action input): their defaults. */
export const LOCAL_LIMIT_DEFAULTS = { PENDULUM_LOCAL_WAIT_MINUTES: "15", PENDULUM_LOCAL_OUTAGE_HOURS: "12" };

/** Whether `v` (text) meets owner limit `rule`. */
const limitOk = (rule, v) => {
  const s = String(v ?? "").trim();
  if (rule.whole ? !/^\d+$/.test(s) : !number(s)) return false;
  const n = Number(s);
  return (rule.above ? n > rule.from : n >= rule.from) && n <= rule.max;
};
/** What owner limit `rule` asks for, as a variable's refusal names it. */
const limitText = (rule) => `${rule.whole ? "a whole number" : "a number"} ${rule.above ? `above ${rule.from}` : rule.from === 0 ? "0 or more" : `at least ${rule.from}`}, at most ${rule.max}`;

/** Owner limit `name`'s value in force from `value` (a setting's text): the value when it meets its rule, else the default. */
export function ownerLimit(name, value) {
  const rule = OWNER_LIMITS[name];
  if (limitOk(rule, value)) return Number(String(value).trim());
  return Number(LOCAL_LIMIT_DEFAULTS[name] ?? DEFAULTS[name.replace(/^PENDULUM_/, "").toLowerCase()]);
}

/**
 * Local mode's own limits from a local stage's or serve's env (local.mjs baseEnv: the developer's own over the
 * repository's): `waitMs`, how long a local stage waits in place for the network or a usage limit's reset before it
 * ends paused for serve to resume (PENDULUM_LOCAL_WAIT_MINUTES, network.mjs OUTAGE.stageWaitMs); `outageMs`, how long
 * serve keeps an Objective paused on one outage before it Blocks it (PENDULUM_LOCAL_OUTAGE_HOURS, OUTAGE.blockMs).
 */
export const localLimits = (env = process.env) => ({ waitMs: ownerLimit("PENDULUM_LOCAL_WAIT_MINUTES", env.PENDULUM_LOCAL_WAIT_MINUTES) * 60_000, outageMs: ownerLimit("PENDULUM_LOCAL_OUTAGE_HOURS", env.PENDULUM_LOCAL_OUTAGE_HOURS) * 3600_000 });
/**
 * What a variable's value must be for Pendulum to take it as given (#284), where the env block's parsing would fall back
 * to a default or refuse it (resolveInputs, promptCacheSetting, harness.mjs copilotCreditUsd, machine.mjs loopCap): each
 * a test and what it asks for. Any other setting takes any text.
 */
const VALUE_RULES = (() => {
  const whole = [(v) => /^\s*\d+\s*$/.test(v) && Number(v) > 0, "a whole number above 0"];
  const atLeast0 = [(v) => number(v) && Number(v) >= 0, "a number, 0 or more"];
  const above0 = [(v) => number(v) && Number(v) > 0, "a number above 0"];
  const oneOf = (...xs) => [(v) => xs.includes(v.trim().toLowerCase()), xs.join(", ")];
  return {
    PENDULUM_HARNESS: oneOf("claude", "codex", "copilot"),
    PENDULUM_MAX_CONCURRENT: whole,
    PENDULUM_REBASE_LIMIT: whole,
    PENDULUM_LOCAL_MAX_CONCURRENT: whole,
    PENDULUM_COMPACTION_WINDOW: whole,
    PENDULUM_DAILY_USD: atLeast0,
    PENDULUM_MAX_USD: atLeast0,
    PENDULUM_MAX_OBJECTIVE_USD: atLeast0,
    PENDULUM_IMAGE_DAILY_MINUTES: atLeast0,
    PENDULUM_IMAGE_MAX_AGE_DAYS: [(v) => /^\s*\d+\s*$/.test(v) && Number(v) >= 1 && Number(v) <= IMAGE_MAX_AGE_MAX, `a whole number of days, 1 to ${IMAGE_MAX_AGE_MAX}`],
    PENDULUM_SANDBOX_IDLE_DAYS: atLeast0,
    PENDULUM_SWEEP_MAX_DESTROYS: atLeast0,
    PENDULUM_TIMEOUT_MINUTES: above0,
    PENDULUM_THIRD_PARTY_WAIT_MINUTES: [(v) => number(v) && Number(v) > 0 && Number(v) <= THIRD_PARTY_WAIT_MAX_MINUTES, `a number above 0, at most ${THIRD_PARTY_WAIT_MAX_MINUTES} (24 hours)`],
    PENDULUM_GUESS_HOURS: [(v) => guessHoursMs(v) !== null, `a list of hours, each a number above 0, at most ${GUESS_MAX_HOURS}`],
    PENDULUM_COPILOT_CREDIT_USD: above0,
    PENDULUM_TRIAGE_MIN_CONFIDENCE: [(v) => confidenceValue(v) !== null, "a number from 0 to 1"],
    PENDULUM_LOCAL_MEDIA_MAX_MB: above0,
    ...Object.fromEntries(Object.entries(LOCAL_BOUNDS).map(([k, b]) => [k, [(v) => localBound(k, v).problem === null, `a whole number from ${b.min} to ${b.max}`]])),
    PENDULUM_RESUME_POLICY: oneOf("fresh", "fix-passes"),
    PENDULUM_SIBLING_HOLD: oneOf("on", "off"),
    PENDULUM_DECISION_ROUTE: oneOf("auto", "gateway", "off"),
    PENDULUM_PROMPT_CACHE_TTL: oneOf("off", "auto", "1h", "5m"),
    PENDULUM_IMAGE_REFRESH: oneOf("merge", "nightly"),
    ...Object.fromEntries(Object.entries(OWNER_LIMITS).map(([k, rule]) => [k, [(v) => limitOk(rule, v), limitText(rule)]])),
  };
})();
/**
 * A `guess_hours` value as milliseconds: a list of hours, comma or space separated, each a number above 0 and at most
 * GUESS_MAX_HOURS (the same rule as machine.json's `guess_hours`, machine.mjs machineLimits); null when it is not one.
 */
export function guessHoursMs(value) {
  const hours = String(value ?? "").split(/[\s,]+/).filter(Boolean).map(Number);
  return guessHoursValid(hours) ? hours.map((h) => h * 3600_000) : null;
}

/** A `triage_min_confidence` value as a number from 0 to 1, or null when it is none (empty, not a number, out of range). */
export function confidenceValue(value) {
  const v = String(value ?? "").trim();
  if (!number(v)) return null;
  const n = Number(v);
  return n >= 0 && n <= 1 ? n : null;
}

/** Why a variable's value for setting `name` is not taken (VALUE_RULES), or null. */
export const valueProblem = (name, value) => (VALUE_RULES[name] && !VALUE_RULES[name][0](value) ? `not ${VALUE_RULES[name][1]}` : null);

/** This machine's own settings in local mode, from its environment (`env`): MACHINE_SETTINGS's rule. */
export function machineSettings(env = process.env) {
  const own = {};
  for (const k of MACHINE_SETTINGS) if (env[k]) own[k] = env[k];
  for (const k of MACHINE_LOCAL) if (env[k] !== undefined) own[k] = env[k];
  return own;
}

/** The default decision model of red-check triage and the calls on its decider (triage.mjs TRIAGE_MODEL). */
export const TRIAGE_MODEL_DEFAULT = "perplexity/pplx-decider-v1.2";
/** The triage model's confidence floor (`triage_min_confidence`), which goes with `triage_model`. */
const TRIAGE_FLOOR_OF = "PENDULUM_TRIAGE_MIN_CONFIDENCE";

/**
 * A repository's Pendulum settings in layers, each over the one below (#284): Pendulum's defaults (DEFAULTS), the
 * committed workflow's env block (`workflow`, workflowSettings's kept), the repository's variables (`variables`, all of
 * them: variableSettings takes the settings), and this machine's own (`machine`: in local mode machineSettings's).
 * A layer that sets another harness than the layers below drops their models and effort for that harness's defaults,
 * unless it sets them itself, as the workflow's models belong to its harness; one that sets another `triage_model`
 * drops their `triage_min_confidence` the same way, as a floor belongs to the model it was set for. Returns {values,
 * from, excluded, unknown, invalid} (variableSettings's):
 * `values` holds the settings some layer sets (the workflow's own empty ones included, which read as the default),
 * `from` the layer each came from (`workflow`, `variable` or `machine`).
 */
export function settingLayers({ workflow = {}, variables = {}, machine = {} } = {}) {
  const values = {};
  const from = {};
  const harnessOf = harnessName;
  const drop = (k) => {
    delete values[k];
    delete from[k];
  };
  const take = (layer, set) => {
    if (set.PENDULUM_HARNESS && harnessOf(set.PENDULUM_HARNESS) !== harnessOf(values.PENDULUM_HARNESS)) {
      for (const k of MODEL_SETTINGS) if (!(k in set)) drop(k);
    }
    // The confidence floor is the triage model's own: a layer that names another model drops the floor below it.
    if ("PENDULUM_TRIAGE_MODEL" in set && !(TRIAGE_FLOOR_OF in set) && triageModelOf(set.PENDULUM_TRIAGE_MODEL) !== triageModelOf(values.PENDULUM_TRIAGE_MODEL)) drop(TRIAGE_FLOOR_OF);
    for (const [k, v] of Object.entries(set)) {
      values[k] = v;
      from[k] = layer;
    }
  };
  take("workflow", Object.fromEntries(Object.entries(workflow).filter(([k]) => WORKFLOW_SETTINGS.has(k))));
  const v = variableSettings(variables);
  take("variable", v.kept);
  take("machine", Object.fromEntries(Object.entries(machine).filter(([k]) => WORKFLOW_SETTINGS.has(k))));
  return { values, from, excluded: v.excluded, unknown: v.unknown, invalid: v.invalid };
}

/** Where each layer comes from, as the settings report names it. */
const LAYER_NAMES = { workflow: "workflow", variable: "repository variable", machine: "this machine" };

/**
 * settingLayers's result as lines for serve's log and doctor: each setting a layer sets, `NAME: "value" (layer)`, in name
 * order (values cut at 80 characters; an empty one reads as the default), then one line naming the rest, at Pendulum's
 * defaults (unless `defaults` is false: serve without --verbose, doctor without --verbose), and one each for the
 * variables ignored.
 */
export function layerLines({ values = {}, from = {}, excluded = [], unknown = [], invalid = [] } = {}, { defaults = true } = {}) {
  const show = (v) => JSON.stringify(v.length > 80 ? `${v.slice(0, 77)}...` : v);
  const set = Object.keys(values).filter((k) => values[k] !== "").sort();
  const rest = [...WORKFLOW_SETTINGS].filter((k) => !set.includes(k)).sort();
  const lines = set.map((k) => `${k}: ${show(values[k])} (${LAYER_NAMES[from[k]] || from[k]})`);
  if (defaults && rest.length) lines.push(`Pendulum's defaults: ${rest.join(", ")}`);
  return [...lines, ...ignoredLines({ excluded, unknown, invalid })];
}

/** The repository variables settingLayers ignored, one line for the excluded names and one for the rest. */
export function ignoredLines({ excluded = [], unknown = [], invalid = [] } = {}) {
  const s = (n) => (n.length === 1 ? "" : "s");
  const show = (v) => JSON.stringify(v.length > 40 ? `${v.slice(0, 37)}...` : v);
  return [
    ...(excluded.length ? [`repository variable${s(excluded)} ${excluded.join(", ")} ignored: only the reviewed workflow file sets ${excluded.length === 1 ? "it" : "them"}`] : []),
    ...(unknown.length ? [`repository variable${s(unknown)} ${unknown.join(", ")} ignored: no Pendulum setting`] : []),
    ...invalid.map((x) => `repository variable ${x.name} ${show(x.value)} ignored: ${x.why}`),
  ];
}

/**
 * What serve and doctor say of PENDULUM_* organization variables shared with the repository (`names`): Pendulum's variable
 * layer is the repository's own variables. On Actions the `vars` context cannot tell the two apart, so there such a
 * variable applies unless the repository sets the same name; local mode never takes it. Null for none.
 */
export function organizationVariablesLine(names = []) {
  if (!names?.length) return null;
  const one = names.length === 1;
  return `organization variable${one ? "" : "s"} ${names.join(", ")} ${one ? "is" : "are"} not supported: Pendulum's settings take the repository's own variables only, so local mode ignores ${one ? "it" : "them"}, while on Actions ${one ? "it reaches" : "they reach"} the jobs unless the repository sets the same name; set ${one ? "it" : "them"} on the repository and remove ${one ? "it" : "them"} from the organization`;
}

/**
 * On Actions: the repository's variables (the workflow's `vars: ${{ toJSON(vars) }}`, which action.yml passes as
 * PENDULUM_INPUT_VARS) laid over the workflow's env block in `env`, by settingLayers, so every script, the cloud sandbox's
 * stage env the launcher builds included, reads one set of settings. Run once when this module loads, before any script
 * reads a setting; the variables' JSON then leaves `env`, so no child gets it. A workflow rendered without the input has
 * no variable layer on Actions. PENDULUM_TIMEOUT_MINUTES may only come down here: the runner jobs' own `timeout-minutes`
 * is the workflow file's, which its env block mirrors. Says what it laid over, and each variable it ignored, once.
 */
export function applyVariables(env = process.env, { say = log } = {}) {
  const raw = env.PENDULUM_INPUT_VARS;
  delete env.PENDULUM_INPUT_VARS;
  if (raw === undefined || raw === "") return null;
  let vars;
  try {
    vars = JSON.parse(raw);
  } catch {
    say("repository variables: the vars input is not JSON; the workflow's settings stand");
    return null;
  }
  const workflow = {};
  for (const k of WORKFLOW_SETTINGS) if (env[k] !== undefined) workflow[k] = env[k];
  APP_ID_VAR = vars && typeof vars === "object" && Object.hasOwn(vars, APP_ID_VARIABLE) ? String(vars[APP_ID_VARIABLE]) : null;
  const layers = settingLayers({ workflow, variables: vars });
  layers.workflowHarness = harnessName(workflow.PENDULUM_HARNESS);
  const ceiling = Number(workflow.PENDULUM_TIMEOUT_MINUTES || DEFAULTS.timeout_minutes);
  if (layers.from.PENDULUM_TIMEOUT_MINUTES === "variable" && Number(layers.values.PENDULUM_TIMEOUT_MINUTES) > ceiling) {
    say(`repository variable PENDULUM_TIMEOUT_MINUTES ${layers.values.PENDULUM_TIMEOUT_MINUTES} is over the workflow's ${ceiling}, the runner jobs' own timeout-minutes: kept at ${ceiling} on Actions`);
    if (workflow.PENDULUM_TIMEOUT_MINUTES === undefined) delete layers.values.PENDULUM_TIMEOUT_MINUTES;
    else layers.values.PENDULUM_TIMEOUT_MINUTES = workflow.PENDULUM_TIMEOUT_MINUTES;
    layers.from.PENDULUM_TIMEOUT_MINUTES = "workflow";
  }
  for (const k of WORKFLOW_SETTINGS) {
    if (layers.from[k] === "variable") env[k] = layers.values[k];
    else if (!(k in layers.values)) delete env[k];
  }
  const taken = Object.keys(layers.from).filter((k) => layers.from[k] === "variable").sort();
  if (taken.length) say(`repository variables set ${taken.map((k) => `${k}=${JSON.stringify(layers.values[k])}`).join(", ")} over the workflow's env block`);
  for (const line of ignoredLines(layers)) say(line);
  return layers;
}
/** Pendulum's own service keys (red-check triage's decision model): for Pendulum's process only, never any child's. */
export const PENDULUM_SECRET_KEYS = ["AI_GATEWAY_API_KEY"];
/**
 * The env name Codex reads its AI Gateway key from (its provider's `env_key`): the `codex_gateway_key` input's own
 * workflow-level name, and the repository secret's. Never AI_GATEWAY_API_KEY, which is Pendulum's own (PENDULUM_SECRET_KEYS).
 */
export const CODEX_GATEWAY_ENV = "PENDULUM_CODEX_GATEWAY_KEY";
/** Keys that must never reach a child that is not the harness (validation commands, git hooks). */
export const MODEL_SECRET_KEYS = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "CODEX_API_KEY", CODEX_GATEWAY_ENV, "OPENAI_API_KEY", "COPILOT_GITHUB_TOKEN"];
/** Runner credentials a child could turn into a model or App credential; the harness gets its own credential instead. */
export const RUNNER_SECRET_KEYS = ["ACTIONS_ID_TOKEN_REQUEST_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_URL", "ACTIONS_RUNTIME_TOKEN", "PENDULUM_APP_TOKEN", "PENDULUM_APP_PRIVATE_KEY", "PENDULUM_APP_ID", "VERCEL_TOKEN", "VERCEL_OIDC_TOKEN"];
/** GitHub tokens a child must never get from the job: the job's own, gh's, and Pendulum's write token. */
export const GITHUB_TOKEN_KEYS = ["GITHUB_TOKEN", "GH_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "PENDULUM_GIT_TOKEN", "PENDULUM_LOCAL_TOKEN", "PENDULUM_SECOND_TOKEN", "GH_CONFIG_DIR"];
/** A name that carries one of Pendulum's own service keys: the bare name, or the input under PENDULUM_ or PENDULUM_INPUT_. */
/**
 * Pendulum's own control variables (#119): a stage's identity and launcher plumbing (launch.mjs, stage.mjs), the bot it
 * acts as, its progress comment's key, its read token, the key of the usage artifacts' seal (seal.mjs), local mode's
 * host-only settings, the tests' fake GitHub for setup's app step (app-manifest.mjs TEST_WEB_ENV). Each is read by the process it was
 * given to (from process.env), never by a child, so scrubbedEnv (harness.mjs) removes them from every child, and a local
 * stage's base env never takes one from PENDULUM_LOCAL_ENV (lib/local.mjs localBaseEnv).
 */
export const PENDULUM_CONTROL_KEYS = ["PENDULUM_STAGE", "PENDULUM_STAGE_ISSUE", "PENDULUM_STAGE_CLAIM", "PENDULUM_STAGE_PR", "PENDULUM_STAGE_RECORD", "PENDULUM_STAGE_COMMAND_MS", "PENDULUM_STAGE_SESSION_END", "PENDULUM_STAGE_SESSION_CAP", "PENDULUM_STAGE_HARNESS", "PENDULUM_STAGE_HOSTS", "PENDULUM_STAGE_ACCOUNT", "PENDULUM_STAGE_AUTO_ACCOUNT", "PENDULUM_ACCOUNTS", "PENDULUM_RENDERED_ACCOUNTS", "PENDULUM_AUTO_ACCOUNT", "PENDULUM_APP_SLUG", "PENDULUM_PROGRESS_RUN", "PENDULUM_READ_TOKEN", "PENDULUM_IMAGE_CHECKOUT", "PENDULUM_IMAGE_ENV_FILE", "PENDULUM_ADAPTER_INSTALL", "PENDULUM_SANDBOX_VCPUS", "PENDULUM_LOCAL_FIRST_SETUP_MS", "PENDULUM_LOCAL_APP_ID", "PENDULUM_LOCAL_APP_KEY", "PENDULUM_NOTICE_APP_ID", "PENDULUM_LOCAL_AUTO_ACCOUNT", "PENDULUM_GATEWAY_URL", "PENDULUM_STATE_DIR", "PENDULUM_RELAY_SOCKET_DIR", "PENDULUM_SERVE_SWITCHED_AT", "PENDULUM_SERVE_SWITCHED_FROM", "PENDULUM_TEST_GITHUB_WEB", "PENDULUM_SEAL_KEY"];

export const isPendulumSecret = (k) => PENDULUM_SECRET_KEYS.some((n) => k === n || k === `PENDULUM_${n}` || k === `PENDULUM_INPUT_${n}`);

/** Other names a command-line flag answers to: `--dir` is `--checkout`, the clone's flag on every command that takes one. */
export const FLAG_ALIASES = { dir: "checkout" };

/**
 * A command line checked against its flags (`spec`: name → `bool`, which takes no value, or {value, number?}, which
 * takes one, a positive number where `number` is set, every value given in a list where `many` is set), FLAG_ALIASES
 * read as their names: {_: arguments, flag: value}.
 * Throws `fail(why)` for an unknown flag, a value given to a bool, or a missing or non-numeric value.
 */
export function readFlags(argv, spec, fail) {
  const flags = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("-")) {
      flags._.push(a);
      continue;
    }
    const m = /^--([a-z-]+)(?:=(.*))?$/s.exec(a);
    const key = m && Object.hasOwn(FLAG_ALIASES, m[1]) ? FLAG_ALIASES[m[1]] : m?.[1];
    const kind = m && Object.hasOwn(spec, key) ? spec[key] : null;
    if (!kind) throw fail(`unknown flag ${a}`);
    if (kind === "bool") {
      if (m[2] !== undefined) throw fail(`--${m[1]} takes no value`);
      flags[key] = true;
      continue;
    }
    let value = m[2];
    if (value === undefined) {
      value = argv[i + 1];
      if (value === undefined || value.startsWith("-")) throw fail(`--${m[1]} needs a value`);
      i += 1;
    }
    if (kind.number) {
      const n = Number(value);
      if (!value.trim() || !Number.isFinite(n) || n <= 0) throw fail(`--${m[1]} needs a positive number, not ${JSON.stringify(value)}`);
      flags[key] = n;
    } else if (kind.many) (flags[key] ??= []).push(value);
    else flags[key] = value;
  }
  return flags;
}

/** Parse `--name value`, `--name=value` and bare `--flag` into {name: value}. Names use underscores. */
export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      out._.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    const name = (eq >= 0 ? a.slice(2, eq) : a.slice(2)).replace(/-/g, "_");
    if (eq >= 0) out[name] = a.slice(eq + 1);
    else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      out[name] = argv[i + 1];
      i += 1;
    } else out[name] = "true";
  }
  return out;
}

const upper = (name) => name.toUpperCase();

/** Resolve one input by the precedence above. */
export function input(name, { args = {}, env = process.env, defaults = DEFAULTS } = {}) {
  const fromArg = args[name];
  if (fromArg !== undefined && fromArg !== "") return String(fromArg);
  const fromWith = env[`PENDULUM_INPUT_${upper(name)}`];
  if (fromWith !== undefined && fromWith !== "") return fromWith;
  const fromEnv = env[`PENDULUM_${upper(name)}`];
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  return defaults[name] ?? "";
}

/** Every input at once, typed where it matters. */
export function resolveInputs({ args = {}, env = process.env } = {}) {
  const get = (n) => input(n, { args, env });
  const bool = (v) => /^(true|1|yes|on)$/i.test(String(v).trim());
  const num = (v, fallback) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };
  // A limit that must be above 0: anything else is its default.
  const above0 = (v, fallback) => {
    const n = num(String(v).trim() || "x", fallback);
    return n > 0 ? n : fallback;
  };
  const list = (v) =>
    String(v || "")
      .split(/\r?\n|,/)
      .map((s) => s.trim())
      .filter(Boolean);
  const limit = (n) => ownerLimit(`PENDULUM_${upper(n)}`, get(n));
  const repoFull = get("repo") || env.GITHUB_REPOSITORY || "";
  const harness = get("harness").toLowerCase();
  const md = MODEL_DEFAULTS[harness] || {};
  // The env block's models are for the env block's harness: a run that overrides the harness (workflow_dispatch's
  // `harness`) takes that harness's defaults, unless it names models of its own (a flag or `with:`).
  const envHarness = String(env.PENDULUM_HARNESS || "").trim().toLowerCase();
  const own = envHarness && harness !== envHarness ? (n) => input(n, { args, env: Object.fromEntries(Object.entries(env).filter(([k]) => !/^PENDULUM_(MODEL|SUBAGENT_MODEL|REVIEWER_MODEL|REVIEWER_EFFORT|EFFORT)$/.test(k))), defaults: { ...DEFAULTS } }) : get;
  return {
    harness,
    model: own("model") || md.model || "",
    effort: own("effort") || md.effort || "",
    compactionWindow: get("compaction_window").trim(),
    resumePolicy: (get("resume_policy") || "fresh").trim().toLowerCase() === "fix-passes" ? "fix-passes" : "fresh",
    // Whether a public repository's usage artifacts carry the transcript and the event stream readable: `true` only.
    publishTranscripts: get("publish_transcripts").trim().toLowerCase() === "true",
    promptCacheTtl: promptCacheSetting(get("prompt_cache_ttl")),
    subagentModel: own("subagent_model") || md.subagent_model || "",
    reviewerModel: own("reviewer_model") || md.reviewer_model || own("model") || md.model || "",
    reviewerEffort: own("reviewer_effort") || md.reviewer_effort || "",
    reviewerFallback: md.reviewer_fallback ? { model: md.reviewer_fallback, effort: md.reviewer_fallback_effort } : null,
    credential: get("credential").toLowerCase(),
    maxConcurrent: num(get("max_concurrent"), 3),
    siblingHold: (get("sibling_hold") || "on").trim().toLowerCase() !== "off",
    rebaseLimit: Math.floor(above0(get("rebase_limit"), 5)) || 5,
    guessMs: guessHoursMs(get("guess_hours")) ?? guessHoursMs(DEFAULTS.guess_hours),
    // Who answers the decision calls (decider.mjs): any other value reads as the default, `auto`.
    decisionRoute: ((v) => (["auto", "gateway", "off"].includes(v) ? v : "auto"))((get("decision_route") || "auto").trim().toLowerCase()),
    dailyUsd: num(get("daily_usd"), 100),
    maxUsd: num(get("max_usd"), 25),
    // The Objective-wide dollar cap (objective-cap.mjs capGate): a number above 0, else none.
    maxObjectiveUsd: ((n) => (n > 0 ? n : null))(num(String(get("max_objective_usd")).trim() || "x", 0)),
    timeoutMinutes: num(get("timeout_minutes"), 240),
    autoMerge: bool(get("auto_merge")),
    // The handle Blocked comments @mention; `login#id` pins it (below), and the mention uses the login.
    notify: get("notify").trim().replace(/^@/, "").replace(/#\d+$/, ""),
    // Pendulum's maintainers beside the notify user, each `login#id` (logic.mjs setMaintainers): their comments answer
    // Questions and their markers count, matched by numeric id so a login renamed away is a stranger.
    maintainers: [get("notify"), ...list(get("maintainers"))].map((l) => l.trim().replace(/^@/, "")).filter(Boolean),
    setup: get("setup"),
    install: get("install"),
    validation: list(get("validation")),
    budgetCommand: get("budget_command"),
    protectedAdditions: list(get("protected_paths")),
    toolchainPaths: list(get("toolchain_paths")),
    ciChecks: list(get("ci_checks")),
    thirdPartyReviewers: list(get("third_party_reviewers")),
    thirdPartyWaitMs: ((m) => (m <= THIRD_PARTY_WAIT_MAX_MINUTES ? m : 20))(above0(get("third_party_wait_minutes"), 20)) * 60_000,
    harnessVersion: get("harness_version"),
    objectiveLabel: get("objective_label"),
    mode: get("mode"),
    issue: get("issue") ? Number(get("issue")) : null,
    pr: get("pr") ? Number(get("pr")) : null,
    repo: repoFull,
    appId: get("app_id"),
    appPrivateKey: get("app_private_key"),
    anthropicApiKey: get("anthropic_api_key"),
    anthropicOidcExchangeUrl: get("anthropic_oidc_exchange_url"),
    claudeCodeOauthToken: get("claude_code_oauth_token"),
    codexApiKey: get("codex_api_key"),
    codexGatewayKey: get("codex_gateway_key"),
    copilotGithubToken: get("copilot_github_token"),
    aiGatewayApiKey: get("ai_gateway_api_key"),
    // The secrets the worker's shell gets (lib/worker-secrets.mjs): the opt-in, and their values where a runner has them.
    workerSecrets: get("worker_secrets"),
    workerSecretValues: get("worker_secret_values"),
    triageModel: get("triage_model").trim(),
    triageMinConfidence: triageFloorSetting({ args, env }),
    driftModel: get("drift_model").trim(),
    githubToken: get("github_token") || env.GITHUB_TOKEN || "",
    appToken: get("app_token") || env.PENDULUM_APP_TOKEN || "",
    sandbox: get("sandbox").trim().toLowerCase(),
    // The sandbox vendor's credentials (docs/ADAPTERS.md), for the launcher only; never in a child's environment.
    vercelToken: get("vercel_token"),
    vercelTeamId: get("vercel_team_id"),
    vercelProjectId: get("vercel_project_id"),
    // The sandbox image's refresh (lib/image.mjs): on merges until today's builds reach the minutes, else nightly.
    imageRefresh: get("image_refresh").trim().toLowerCase() === "nightly" ? "nightly" : "merge",
    imageDailyMinutes: num(get("image_daily_minutes"), 5),
    imageOwed: get("image_owed").trim() === "true",
    imageMaxAgeDays: ((d) => (Number.isInteger(d) && d >= 1 && d <= IMAGE_MAX_AGE_MAX ? d : IMAGE_MAX_AGE_DAYS))(num(get("image_max_age_days").trim() || "x", IMAGE_MAX_AGE_DAYS)),
    sandboxIdleDays: num(get("sandbox_idle_days"), 7),
    sweepMaxDestroys: Math.max(0, Math.floor(num(get("sweep_max_destroys"), 5))),
    nodeVersion: get("node_version").trim(),
    // Limits a person owns (OWNER_LIMITS): a value out of its rule reads as the default.
    usageLimitWaits: limit("usage_limit_waits"),
    usageLimitMoveMs: limit("usage_limit_move_minutes") * 60_000,
    claimPauseMs: limit("claim_pause_hours") * 3600_000,
    siblingWaitMs: limit("sibling_wait_hours") * 3600_000,
    maxParts: limit("max_parts"),
    stall: { factor: limit("step_stall_factor"), floorMs: limit("step_stall_floor_minutes") * 60_000, queueMs: limit("queue_stall_minutes") * 60_000 },
    project: get("project").trim(),
  };
}

/** Input `name`'s value at each precedence tier above, highest first: a flag, the Action's `with:`, the settings. */
const inputTiers = (name, { args, env }) => [args[name], env[`PENDULUM_INPUT_${upper(name)}`], env[`PENDULUM_${upper(name)}`]];
const isSet = (v) => v !== undefined && v !== "";
/** Where input `name` comes from by the precedence above: 0 a flag, 1 the Action's `with:`, 2 the settings, 3 the default. */
const inputTier = (name, ctx) => {
  const i = inputTiers(name, ctx).findIndex(isSet);
  return i < 0 ? 3 : i;
};
/** The triage model a value names, the default resolved: an empty one is TRIAGE_MODEL_DEFAULT. */
export const triageModelOf = (v) => String(v ?? "").trim() || TRIAGE_MODEL_DEFAULT;

/**
 * `triage_min_confidence` as a number from 0 to 1, or null for triage.mjs's default floor. A floor belongs to the model
 * it was set for: one set under a flag or `with:` that names another `triage_model` (the default resolved, so naming the
 * default model is no other model) is not that model's, so it is not taken. A value that is no number from 0 to 1 is refused with a line and reads as null.
 */
export function triageFloorSetting({ args = {}, env = process.env } = {}) {
  const tier = inputTier("triage_min_confidence", { args, env });
  if (tier === 3) return null;
  // The model the floor's own tier and those below name, against the model that answers.
  const beside = triageModelOf(inputTiers("triage_model", { args, env }).slice(tier).find(isSet));
  if (beside !== triageModelOf(input("triage_model", { args, env }))) {
    log(`triage_min_confidence is set below the triage_model it would go with (a flag or the Action's input names the model): the default floor applies`);
    return null;
  }
  const raw = input("triage_min_confidence", { args, env });
  const n = confidenceValue(raw);
  if (n === null) log(`triage_min_confidence ${JSON.stringify(String(raw).slice(0, 40))} is not a number from 0 to 1; the default floor applies`);
  return n;
}

/** `prompt_cache_ttl` as one of its four values; anything else is refused with a warning and reads as `off`. */
export const PROMPT_CACHE_TTLS = ["off", "auto", "1h", "5m"];
export function promptCacheSetting(value) {
  const v = String(value ?? "").trim().toLowerCase();
  if (!v) return "off";
  if (PROMPT_CACHE_TTLS.includes(v)) return v;
  log(`prompt_cache_ttl ${JSON.stringify(v.slice(0, 40))} is not one of ${PROMPT_CACHE_TTLS.join(", ")}; using off`);
  return "off";
}

/** Write `name=value` to $GITHUB_OUTPUT when running in Actions; always echo it. */
export function setOutput(name, value, env = process.env) {
  const line = `${name}=${redactSecrets(typeof value === "string" ? value : JSON.stringify(value))}`;
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `${line}\n`);
  process.stdout.write(`[output] ${line}\n`);
}

/**
 * Mask a value in the job log (Actions honours ::add-mask::). Only where a runner reads the line: in a cloud sandbox
 * stage (PENDULUM_STAGE_SANDBOX) the log is a file, where the line would be the secret in plain text.
 */
export const maskable = (env = process.env) => !!env.GITHUB_ACTIONS && env.PENDULUM_STAGE_SANDBOX !== "1";
export function mask(value) {
  if (value && maskable()) process.stdout.write(`::add-mask::${value}\n`);
}
/** Log a line with a stable prefix. Never pass a secret; a held one (holdSecrets) is redacted anyway. */
/** Where log lines go: stdout, unless a command whose stdout is its data (`pendulum wait`) sends them to stderr (logTo). */
let LOG_STREAM = null;
export const logTo = (stream) => {
  LOG_STREAM = stream;
};
export const log = (...parts) => (LOG_STREAM ?? process.stdout).write(`[pendulum] ${redactSecrets(parts.join(" "))}\n`);

/**
 * A thrown error as a Blocked reason may carry it, which `log` (this process's log: the local loop's, or a stage's) has
 * whole: a system error (Node's, with its `syscall`: a file or process call, whose message names the path, an account's
 * folder or token file included) by its code and call alone; any other by its message, the home directory shortened to
 * `~`.
 */
export const postedError = (e, { home = homedir(), log = "the local loop's log" } = {}) => {
  if (typeof e?.syscall !== "string") return String(e?.message || e).replaceAll(home, "~");
  const code = typeof e.code === "string" && /^[A-Z][A-Z0-9_]*$/.test(e.code) ? e.code : "a system error";
  return /^[a-z_]+$/.test(e.syscall) ? `${code} from ${e.syscall}; ${log} names the path` : `${code}; ${log} names the path`;
};

/**
 * What a failed git command said, for a log line or a Blocked reason: each `error:` or `fatal:` line with the paths git
 * lists under it (five at most), not its closing line ("Aborting" names no cause). A line with none of those: the first
 * line. Credentials in a URL and GitHub tokens are masked; at most 300 characters.
 */
export function gitError(stderr) {
  const lines = String(stderr ?? "").split("\n").map((l) => l.replace(/\s+$/, "")).filter(Boolean);
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^(error|fatal): /.test(lines[i])) continue;
    const head = lines[i];
    const paths = [];
    while (i + 1 < lines.length && /^\s/.test(lines[i + 1])) paths.push(lines[++i].trim());
    const shown = paths.slice(0, 5).join(", ") + (paths.length > 5 ? ` (+${paths.length - 5} more)` : "");
    blocks.push(shown ? `${head} ${shown}` : head);
  }
  const text = (blocks.length ? blocks.join("; ") : lines[0] ?? "").replace(/(\w+:\/\/)[^\s/@'"]+@/g, "$1***@").replace(/\b(gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,})/g, "***");
  return text.slice(0, 300);
}

/**
 * `text` with every absolute path on this machine replaced by `<path>` (a clone, a temp, home or account folder, inside
 * the home directory or out of it), a `file:` URL included. A path in quotes is replaced up to its closing quote, spaces
 * and commas in it included (`'/srv/my repo/.git/index.lock'`); one outside quotes ends at a space, comma, colon or
 * bracket. A path git prints relative to the clone stays, and so does any other URL, its credentials masked.
 */
export const withoutLocalPaths = (text) =>
  String(text ?? "").replace(
    /(['"`])((?:file:\/\/|~(?=\/)|\/(?!\/))(?:(?!\1)[^\n])*)\1|file:\/\/[^\s'"`]*|([a-z][a-z0-9+.-]*:\/\/)([^\s'"`]*)|(^|[\s'"`(=:,[])(?:~(?=\/)|\/(?!\/))[^\s'"`)\],;:]*/gi,
    (m, quote, _path, scheme, rest, lead) => (quote ? `${quote}<path>${quote}` : scheme ? `${scheme}${rest.replace(/^[^\s/@]+@/, "***@")}` : lead === undefined ? "<path>" : `${lead}<path>`),
  );

/** The log a Blocked reason points to: this machine's (local mode), or the job's (a runner, a cloud sandbox stage). */
export const logName = (env = process.env) => (env.PENDULUM_LOCAL === "1" || !env.GITHUB_ACTIONS ? "this machine's log" : "the job log");

/**
 * A command Pendulum ran that failed (`r`: exec's {code, signal, stderr}), as an error a Blocked reason may carry, on
 * every route: `what`, the exit, and the command's cause (gitError: its `error:` and `fatal:` lines, else its first line)
 * with every absolute path on this machine replaced (withoutLocalPaths), so a person reading the Block sees why. The
 * output's last lines, paths included, go to this process's log.
 */
export function commandFailed(what, r, fields = {}) {
  const exit = r?.code ?? r?.signal ?? null;
  const said = `${what}${exit === null ? "" : ` (exit ${exit})`}`;
  const lines = String(r?.stderr ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length) log(`${said}: ${lines.slice(-5).join(" | ").slice(0, 1000)}`);
  const cause = withoutLocalPaths(gitError(r?.stderr)).slice(0, 300);
  return Object.assign(new Error(`${said}${cause ? `: ${cause}` : ""}; ${logName()} has its output`), fields);
}

/**
 * The forms a secret takes in text Pendulum stores or posts: itself, its JSON-escaped inner form, its
 * encodeURIComponent form (upper- and lower-case hex), and its base64 at each of the three byte offsets a surrounding text can put it at (the
 * characters that also carry a neighbour's bits left out). Only forms of eight characters or more: a shorter one would
 * mask ordinary text.
 */
export function secretForms(value) {
  const v = String(value ?? "");
  if (v.length < 8) return [];
  const url = encodeURIComponent(v);
  // Percent-encoding with lower-case hex (%2f) as well as upper-case (%2F): both decode to the value.
  const forms = new Set([v, JSON.stringify(v).slice(1, -1), url, url.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase())]);
  const bytes = Buffer.from(v, "utf8");
  for (let k = 0; k < 3; k += 1) {
    const b64 = Buffer.concat([Buffer.alloc(k), bytes]).toString("base64").replace(/=+$/, "");
    // Leading characters that hold a prefix byte's bits: none at offset 0, two at 1, three at 2. The last character
    // holds the next byte's bits too, unless the encoded bytes end on a 3-byte boundary.
    const start = [0, 2, 3][k];
    const end = (k + bytes.length) % 3 === 0 ? b64.length : b64.length - 1;
    forms.add(b64.slice(start, end));
  }
  return [...forms].filter((f) => f.length >= 8);
}

/**
 * Secrets this process must never post or store as text (the worker secrets' values, lib/worker-secrets.mjs): every
 * GitHub request body (github.mjs), the usage record, the drift advisory's input, the log and Pendulum's push check
 * (outbox.mjs) redact or refuse them.
 */
const HELD = new Set();
export function holdSecrets(values = []) {
  for (const v of values) if (typeof v === "string" && v.length >= 8) HELD.add(v);
}
export const heldSecrets = () => [...HELD];
/** Tests: forget every held secret. */
export const dropHeldSecrets = () => HELD.clear();

/** `x` with every form of every held secret (or of `values`) replaced by ***: strings, and arrays and objects deeply. */
export function redactSecrets(x, values = heldSecrets()) {
  if (!values.length) return x;
  const forms = values.flatMap(secretForms).sort((a, b) => b.length - a.length);
  const walk = (y) => {
    if (typeof y === "string") return forms.reduce((t, f) => (t.includes(f) ? t.split(f).join("***") : t), y);
    if (Array.isArray(y)) return y.map(walk);
    if (y && typeof y === "object") return Object.fromEntries(Object.entries(y).map(([k, v]) => [k, walk(v)]));
    return y;
  };
  return walk(x);
}

/** Who fired this job's event ({login, type}: type "Bot" for an App), from GITHUB_EVENT_PATH; null outside Actions. */
export function eventSender(env = process.env) {
  if (!env.GITHUB_EVENT_PATH) return null;
  try {
    const s = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8")).sender;
    return s ? { login: s.login, type: s.type } : null;
  } catch {
    return null;
  }
}

/** The `action` of the event that fired this job (GITHUB_EVENT_PATH), or null outside Actions. */
export function eventAction(env = process.env) {
  if (!env.GITHUB_EVENT_PATH) return null;
  try {
    return JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8")).action ?? null;
  } catch {
    return null;
  }
}

// On Actions, before any script reads a setting (applyVariables); what it laid over, for doctor's report.
let APP_ID_VAR = null;
let APPLIED = null;
if (process.env.PENDULUM_INPUT_VARS !== undefined) APPLIED = applyVariables(process.env);
/** On Actions, the layers applyVariables laid over this process's env when this module loaded; null without the input. */
export const appliedLayers = () => APPLIED;
/** On Actions, the PENDULUM_APP_ID repository variable's value as the `vars` input held it (APP_ID_VARIABLE), else null. */
export const appIdVariable = () => APP_ID_VAR;
/** A harness setting's value as Pendulum reads it: trimmed, lower case, claude when empty. */
export function harnessName(v) {
  return String(v || "").trim().toLowerCase() || DEFAULTS.harness;
}
/**
 * The harness the workflow's own env block names (PENDULUM_HARNESS as written there, before any repository variable): the
 * one its `harness_version` pin is for (choice.mjs harnessVersionFor). Any other, a variable's, a run's or a label's,
 * installs its latest.
 */
export const workflowHarness = (env = process.env) => (APPLIED ? APPLIED.workflowHarness : harnessName(env.PENDULUM_HARNESS));
