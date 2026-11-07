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

/** Per-harness model defaults (Kirk, Nov 3: Opus high worker, Sonnet implementers, Fable reviewer; Opus xhigh when Fable's quota is out). */
export const MODEL_DEFAULTS = {
  claude: { model: "claude-opus-5-5", subagent_model: "claude-sonnet-5-5", reviewer_model: "claude-fable-5-1", reviewer_fallback: "claude-opus-5-5", reviewer_fallback_effort: "xhigh", effort: "medium" },
  codex: { model: "gpt-6.1-sol", subagent_model: "gpt-6.1-sol", reviewer_model: "gpt-6.1-sol" },
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
  subagent_model: "",
  reviewer_model: "",
  credential: "api", // api | plan (your own repository) | login (a developer's machine only)
  max_concurrent: "3",
  daily_usd: "100",
  max_usd: "25",
  timeout_minutes: "240",
  auto_merge: "true",
  notify: "",
  setup: "",
  install: "auto",
  validation: "",
  budget_command: "",
  protected_paths: "",
  ci_checks: "",
  harness_version: "latest",
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
  copilot_github_token: "",
  github_token: "",
  app_token: "",
};

export const SECRET_INPUTS = new Set(["app_private_key", "anthropic_api_key", "claude_code_oauth_token", "codex_api_key", "copilot_github_token", "github_token", "app_token"]);

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
  return {
    harness,
    model: get("model") || md.model || "",
    effort: get("effort") || md.effort || "",
    compactionWindow: get("compaction_window").trim(),
    resumePolicy: (get("resume_policy") || "fresh").trim().toLowerCase() === "fix-passes" ? "fix-passes" : "fresh",
    subagentModel: get("subagent_model") || md.subagent_model || "",
    reviewerModel: get("reviewer_model") || md.reviewer_model || get("model") || md.model || "",
    reviewerFallback: md.reviewer_fallback ? { model: md.reviewer_fallback, effort: md.reviewer_fallback_effort } : null,
    credential: get("credential").toLowerCase(),
    maxConcurrent: num(get("max_concurrent"), 3),
    dailyUsd: num(get("daily_usd"), 100),
    maxUsd: num(get("max_usd"), 25),
    timeoutMinutes: num(get("timeout_minutes"), 240),
    autoMerge: bool(get("auto_merge")),
    notify: get("notify").replace(/^@/, ""),
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
    copilotGithubToken: get("copilot_github_token"),
    githubToken: get("github_token") || env.GITHUB_TOKEN || "",
    appToken: get("app_token") || env.FACTORY_APP_TOKEN || "",
  };
}

/** Write `name=value` to $GITHUB_OUTPUT when running in Actions; always echo it. */
export function setOutput(name, value, env = process.env) {
  const line = `${name}=${typeof value === "string" ? value : JSON.stringify(value)}`;
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `${line}\n`);
  process.stdout.write(`[output] ${line}\n`);
}

/** Mask a value in the job log (Actions honours ::add-mask::). */
export function mask(value) {
  if (value && process.env.GITHUB_ACTIONS) process.stdout.write(`::add-mask::${value}\n`);
}

/** Log a line with a stable prefix. Never pass a secret. */
export const log = (...parts) => process.stdout.write(`[factory] ${parts.join(" ")}\n`);

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
