// Inputs for every Factory script, from one place.
//
// Precedence, highest first:
//   1. a CLI flag (`--max-usd 20`), for the plugin skills and local runs;
//   2. FACTORY_INPUT_<NAME>, which action.yml sets from `with:` on the job;
//   3. FACTORY_<NAME>, the workflow-level `env:` block the template carries;
//   4. the default below.
// The action declares no defaults of its own, so an empty `with:` value falls
// through to the env block rather than overriding it with "".
import { appendFileSync, readFileSync } from "node:fs";

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
export const FACTORY_VERSION = JSON.parse(readFileSync(new URL("../../.claude-plugin/plugin.json", import.meta.url), "utf8")).version;

export const DEFAULTS = {
  harness: "claude",
  model: "", // empty: MODEL_DEFAULTS for the harness
  effort: "", // empty: MODEL_DEFAULTS for the harness (the worker's effort)
  compaction_window: "", // empty: the CLI default (Claude and Codex; Copilot has no such setting)
  resume_policy: "fresh", // fresh | fix-passes: which re-entries resume the worker's saved session
  prompt_cache_ttl: "off", // off | auto | 1h | 5m: Claude's main-conversation cache TTL (harness.mjs promptCacheTtl)
  subagent_model: "",
  reviewer_model: "",
  reviewer_effort: "", // empty: MODEL_DEFAULTS for the harness (the reviewer's effort, on every reviewer call)
  credential: "api", // api | plan (your own repository) | login (a developer's machine only)
  max_concurrent: "3",
  daily_usd: "100",
  copilot_credit_usd: "", // empty: GitHub's published $0.01 per AI credit (usage.mjs COPILOT_CREDIT_USD)
  max_usd: "25",
  timeout_minutes: "240",
  auto_merge: "true",
  notify: "",
  maintainers: "",
  setup: "",
  install: "auto",
  validation: "",
  budget_command: "",
  protected_paths: "",
  ci_checks: "",
  harness_version: "latest",
  allowed_domains: "", // Claude Code's sandbox on Actions and in a cloud sandbox: hosts its commands may reach beyond GitHub and the npm and Yarn registries (local.mjs runnerDomains)
  node_version: "22",
  action: `clockgrove/factory@v${FACTORY_VERSION}`,
  objective_label: "factory:objective",
  mode: "",
  issue: "",
  pr: "",
  repo: "",
  app_id: "",
  app_private_key: "",
  anthropic_api_key: "",
  anthropic_oidc_exchange_url: "",
  claude_code_oauth_token: "",
  codex_api_key: "",
  codex_gateway_key: "", // Codex through the Vercel AI Gateway (harness.mjs credentialEnv); wins over codex_api_key when set
  copilot_github_token: "",
  ai_gateway_api_key: "", // red-check triage (triage.mjs) and the drift advisory (drift.mjs); empty turns both off
  worker_secrets: "", // the secrets the worker's shell gets, `NAME` or `NAME=SOURCE` each (lib/worker-secrets.mjs); empty: none
  worker_secret_values: "", // their values on Actions and in a cloud sandbox, `SOURCE=value` lines (a secret input)
  triage_model: "", // empty: triage.mjs TRIAGE_MODEL
  drift_model: "", // empty: drift.mjs DRIFT_MODEL (the drift advisory, on with ai_gateway_api_key)
  github_token: "",
  app_token: "",
  sandbox: "", // empty: the runner is the sandbox (work and review jobs); `vercel`: launcher jobs start a cloud sandbox
  vercel_token: "",
  vercel_team_id: "",
  vercel_project_id: "",
  image_refresh: "merge", // merge | nightly (lib/image.mjs imageDecision)
  image_daily_minutes: "5",
  image_owed: "", // image.mjs: `true` when the dispatcher's tick found a build owed (lib/image.mjs imageOwed)
  sandbox_idle_days: "7", // sweep.mjs: a stopped sandbox of an Objective neither Running nor In review, this long, goes
  sweep_max_destroys: "5",
};

export const SECRET_INPUTS = new Set(["app_private_key", "anthropic_api_key", "claude_code_oauth_token", "codex_api_key", "codex_gateway_key", "copilot_github_token", "ai_gateway_api_key", "worker_secret_values", "github_token", "app_token", "vercel_token"]);
/** Factory's own service keys (red-check triage's decision model): for Factory's process only, never any child's. */
export const FACTORY_SECRET_KEYS = ["AI_GATEWAY_API_KEY"];
/**
 * The env name Codex reads its AI Gateway key from (its provider's `env_key`): the `codex_gateway_key` input's own
 * workflow-level name, and the repository secret's. Never AI_GATEWAY_API_KEY, which is Factory's own (FACTORY_SECRET_KEYS).
 */
export const CODEX_GATEWAY_ENV = "FACTORY_CODEX_GATEWAY_KEY";
/** Keys that must never reach a child that is not the harness (validation commands, git hooks). */
export const MODEL_SECRET_KEYS = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "CODEX_API_KEY", CODEX_GATEWAY_ENV, "OPENAI_API_KEY", "COPILOT_GITHUB_TOKEN"];
/** Runner credentials a child could turn into a model or App credential; the harness gets its own credential instead. */
export const RUNNER_SECRET_KEYS = ["ACTIONS_ID_TOKEN_REQUEST_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_URL", "ACTIONS_RUNTIME_TOKEN", "FACTORY_APP_TOKEN", "FACTORY_APP_PRIVATE_KEY", "FACTORY_APP_ID", "VERCEL_TOKEN", "VERCEL_OIDC_TOKEN"];
/** GitHub tokens a child must never get from the job: the job's own, gh's, and Factory's write token. */
export const GITHUB_TOKEN_KEYS = ["GITHUB_TOKEN", "GH_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "FACTORY_GIT_TOKEN", "FACTORY_LOCAL_TOKEN", "FACTORY_SECOND_TOKEN", "GH_CONFIG_DIR"];
/** A name that carries one of Factory's own service keys: the bare name, or the input under FACTORY_ or FACTORY_INPUT_. */
export const isFactorySecret = (k) => FACTORY_SECRET_KEYS.some((n) => k === n || k === `FACTORY_${n}` || k === `FACTORY_INPUT_${n}`);

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
  const fromWith = env[`FACTORY_INPUT_${upper(name)}`];
  if (fromWith !== undefined && fromWith !== "") return fromWith;
  const fromEnv = env[`FACTORY_${upper(name)}`];
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
  const list = (v) =>
    String(v || "")
      .split(/\r?\n|,/)
      .map((s) => s.trim())
      .filter(Boolean);
  const repoFull = get("repo") || env.GITHUB_REPOSITORY || "";
  const harness = get("harness").toLowerCase();
  const md = MODEL_DEFAULTS[harness] || {};
  // The env block's models are for the env block's harness: a run that overrides the harness (workflow_dispatch's
  // `harness`) takes that harness's defaults, unless it names models of its own (a flag or `with:`).
  const envHarness = String(env.FACTORY_HARNESS || "").trim().toLowerCase();
  const own = envHarness && harness !== envHarness ? (n) => input(n, { args, env: Object.fromEntries(Object.entries(env).filter(([k]) => !/^FACTORY_(MODEL|SUBAGENT_MODEL|REVIEWER_MODEL|REVIEWER_EFFORT|EFFORT)$/.test(k))), defaults: { ...DEFAULTS } }) : get;
  return {
    harness,
    model: own("model") || md.model || "",
    effort: own("effort") || md.effort || "",
    compactionWindow: get("compaction_window").trim(),
    resumePolicy: (get("resume_policy") || "fresh").trim().toLowerCase() === "fix-passes" ? "fix-passes" : "fresh",
    promptCacheTtl: promptCacheSetting(get("prompt_cache_ttl")),
    subagentModel: own("subagent_model") || md.subagent_model || "",
    reviewerModel: own("reviewer_model") || md.reviewer_model || own("model") || md.model || "",
    reviewerEffort: own("reviewer_effort") || md.reviewer_effort || "",
    reviewerFallback: md.reviewer_fallback ? { model: md.reviewer_fallback, effort: md.reviewer_fallback_effort } : null,
    credential: get("credential").toLowerCase(),
    maxConcurrent: num(get("max_concurrent"), 3),
    dailyUsd: num(get("daily_usd"), 100),
    maxUsd: num(get("max_usd"), 25),
    timeoutMinutes: num(get("timeout_minutes"), 240),
    autoMerge: bool(get("auto_merge")),
    // The handle Blocked comments @mention; `login#id` pins it (below), and the mention uses the login.
    notify: get("notify").trim().replace(/^@/, "").replace(/#\d+$/, ""),
    // Factory's maintainers beside the notify user, each `login#id` (logic.mjs setMaintainers): their comments answer
    // Questions and their markers count, matched by numeric id so a login renamed away is a stranger.
    maintainers: [get("notify"), ...list(get("maintainers"))].map((l) => l.trim().replace(/^@/, "")).filter(Boolean),
    setup: get("setup"),
    install: get("install"),
    validation: list(get("validation")),
    budgetCommand: get("budget_command"),
    protectedAdditions: list(get("protected_paths")),
    ciChecks: list(get("ci_checks")),
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
    driftModel: get("drift_model").trim(),
    githubToken: get("github_token") || env.GITHUB_TOKEN || "",
    appToken: get("app_token") || env.FACTORY_APP_TOKEN || "",
    sandbox: get("sandbox").trim().toLowerCase(),
    // The sandbox vendor's credentials (docs/ADAPTERS.md), for the launcher only; never in a child's environment.
    vercelToken: get("vercel_token"),
    vercelTeamId: get("vercel_team_id"),
    vercelProjectId: get("vercel_project_id"),
    // The sandbox image's refresh (lib/image.mjs): on merges until today's builds reach the minutes, else nightly.
    imageRefresh: get("image_refresh").trim().toLowerCase() === "nightly" ? "nightly" : "merge",
    imageDailyMinutes: num(get("image_daily_minutes"), 5),
    imageOwed: get("image_owed").trim() === "true",
    sandboxIdleDays: num(get("sandbox_idle_days"), 7),
    sweepMaxDestroys: Math.max(0, Math.floor(num(get("sweep_max_destroys"), 5))),
    nodeVersion: get("node_version").trim(),
  };
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
 * stage (FACTORY_STAGE_SANDBOX) the log is a file, where the line would be the secret in plain text.
 */
export const maskable = (env = process.env) => !!env.GITHUB_ACTIONS && env.FACTORY_STAGE_SANDBOX !== "1";
export function mask(value) {
  if (value && maskable()) process.stdout.write(`::add-mask::${value}\n`);
}
/** Log a line with a stable prefix. Never pass a secret; a held one (holdSecrets) is redacted anyway. */
export const log = (...parts) => process.stdout.write(`[factory] ${redactSecrets(parts.join(" "))}\n`);

/**
 * The forms a secret takes in text Factory stores or posts: itself, its JSON-escaped inner form, its
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
 * GitHub request body (github.mjs), the usage record, the drift advisory's input, the log and Factory's push check
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
