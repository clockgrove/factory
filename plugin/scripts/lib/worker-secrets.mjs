// Worker secrets (#66): the secrets a repository opts in to its worker's shell, so a pipeline the Objective runs (a paid
// image or 3D generation step, say) can spend through the adopter's own key. Off by default; docs/PLAN.md, "Worker
// secrets", has the risk: any code the worker runs can read and spend such a key, so it must be a dedicated key with a
// budget the gateway enforces.
//
// The opt-in is the `worker_secrets` input: names, each `NAME` (the shell gets the secret SOURCE=NAME) or `NAME=SOURCE`
// (the shell gets SOURCE's value as NAME, so `AI_GATEWAY_API_KEY=WORKER_AI_GATEWAY_API_KEY` hands the adopter's own key
// to a pipeline that reads AI_GATEWAY_API_KEY, while Factory's drift key keeps its name and stays Factory's). The values:
// on Actions and in a cloud sandbox the `worker_secret_values` input, `SOURCE=value` lines, which the workflow template
// passes from the one secret FACTORY_WORKER_SECRET_VALUES (so a re-render of the workflow keeps it); in local mode the
// shell that runs `factory serve`, packed into the work stage's env the same way.
//
// Never the model's credential, Factory's or the runner's tokens, a name the harness or the runner reads, or a name
// that changes how commands run: such an entry is refused. Factory's own AI_GATEWAY_API_KEY is refused as a SOURCE, and
// a value that equals Factory's key is withheld (compared by hash, in this process, never printed).
//
// Only the worker's harness gets them, through one variable (SHELL_SECRETS_ENV) that runHarness unpacks for the harness
// child alone and scrubbedEnv removes everywhere else: the repository's setup, install and validation, Factory's own
// git, and the reviewer never see them.
import { createHash, timingSafeEqual } from "node:crypto";
import { FACTORY_SECRET_KEYS, GITHUB_TOKEN_KEYS, MODEL_SECRET_KEYS, RUNNER_SECRET_KEYS } from "./inputs.mjs";

/** The one variable that carries the worker's shell secrets (JSON {NAME: value}) from worker.mjs to runHarness. */
export const SHELL_SECRETS_ENV = "FACTORY_SHELL_SECRETS";
/** At most this many worker secrets. */
export const WORKER_SECRETS_MAX = 20;

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Prefixes Factory, the runner or a harness CLI reads its own settings or credentials from. */
const OWNED_PREFIX = /^(FACTORY|GITHUB|GH|ACTIONS|RUNNER|ANTHROPIC|CLAUDE|CODEX|OPENAI|COPILOT)_/;
/** Names that change how a process or a command runs, whatever their value. */
const PROCESS_NAMES = new Set(["PATH", "HOME", "TMPDIR", "SHELL", "USER", "LOGNAME", "PWD", "CI", "BASH_ENV", "ENV", "NODE_OPTIONS", "NODE_PATH", "NODE_EXTRA_CA_CERTS", "PYTHONPATH", "PYTHONSTARTUP", "PERL5LIB", "PERL5OPT", "RUBYOPT", "SSL_CERT_FILE", "SSL_CERT_DIR", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"]);
const PROCESS_PREFIX = /^(LD_|DYLD_|GIT_|NPM_CONFIG_|SUDO_)/;

/** Why `name` may not be a variable in the worker's shell, or null when it may. Case-insensitive. */
export function shellNameRefusal(name) {
  if (!ENV_NAME.test(String(name || ""))) return "not-a-name";
  const up = name.toUpperCase();
  if (MODEL_SECRET_KEYS.includes(up)) return "model-credential";
  if (RUNNER_SECRET_KEYS.includes(up) || GITHUB_TOKEN_KEYS.includes(up)) return "factory-token";
  if (OWNED_PREFIX.test(up)) return "reserved-name";
  if (PROCESS_NAMES.has(up) || PROCESS_PREFIX.test(up)) return "process-setting";
  return null;
}

/** Why `name` may not be a SOURCE (where a value comes from), or null: shellNameRefusal, and Factory's own service keys. */
export function sourceRefusal(name) {
  return shellNameRefusal(name) || (FACTORY_SECRET_KEYS.includes(String(name).toUpperCase()) ? "factory-key" : null);
}

/** What each refusal code means, for the log and doctor. */
export const REFUSAL_TEXT = {
  "not-a-name": "not NAME or NAME=SOURCE with environment variable names",
  "model-credential": "a model credential, which never reaches a command",
  "factory-token": "one of Factory's or the runner's tokens",
  "reserved-name": "a name Factory, the runner or a harness reads its own settings from",
  "process-setting": "a name that changes how commands run",
  "factory-key": "Factory's own AI Gateway key; pass a dedicated key under another secret name (NAME=SOURCE)",
  duplicate: "named twice",
  "too-many": `more than ${WORKER_SECRETS_MAX} worker secrets`,
};

/**
 * The `worker_secrets` input: entries split on commas and white space, each `NAME` or `NAME=SOURCE`. Returns
 * {entries: [{name, source}], refused: [{entry, code}]} (REFUSAL_TEXT has each code's meaning).
 */
export function parseWorkerSecrets(spec) {
  const entries = [];
  const refused = [];
  for (const raw of String(spec || "").split(/[\s,]+/).filter(Boolean)) {
    const parts = raw.split("=");
    const name = parts[0];
    const source = parts.length === 2 && parts[1] ? parts[1] : name;
    const code = parts.length > 2 || (parts.length === 2 && !parts[1]) ? "not-a-name" : shellNameRefusal(name) || sourceRefusal(source) || (entries.some((e) => e.name === name) ? "duplicate" : null) || (entries.length >= WORKER_SECRETS_MAX ? "too-many" : null);
    // What the log and doctor may quote: a NAME, and a SOURCE only when it is refused as a well-known name. Never an entry
    // that is no name at all, which could be a key pasted into the wrong setting.
    const nameOk = ENV_NAME.test(name);
    const shown = !nameOk || code === "not-a-name" ? "" : source !== name && !shellNameRefusal(name) && ![null, "not-a-name"].includes(sourceRefusal(source)) ? `${name}=${source}` : name;
    if (code) refused.push({ entry: shown.slice(0, 80), code });
    else entries.push({ name, source });
  }
  return { entries, refused };
}

/** How the log and doctor name a refused entry (parseWorkerSecrets `entry`): quoted, or "an entry" when it may not be shown. */
export const refusedEntry = (r) => (r.entry ? JSON.stringify(r.entry) : "an entry");

/** `worker_secret_values`: `SOURCE=value` lines (blank lines and lines without a name skipped), as a Map. */
export function parseSecretValues(text) {
  const out = new Map();
  for (const line of String(text || "").split(/\r?\n/)) {
    const i = line.indexOf("=");
    if (i <= 0) continue;
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim();
    if (ENV_NAME.test(k) && v) out.set(k, v);
  }
  return out;
}

/** Whether two secrets are equal, by their SHA-256 in this process: neither is ever printed or compared as text. */
export function sameSecret(a, b) {
  if (!a || !b) return false;
  const h = (s) => createHash("sha256").update(String(s)).digest();
  return timingSafeEqual(h(a), h(b));
}

/**
 * The worker's shell secrets: {env: {NAME: value}, entries, refused, missing: [SOURCE without a value],
 * factoryKey: [NAME whose value is Factory's own key, withheld]}. `lookup(source)` gives a value; `factoryKey` is
 * Factory's own AI Gateway key ("" when none).
 */
export function workerSecrets({ spec, lookup, factoryKey = "" }) {
  const { entries, refused } = parseWorkerSecrets(spec);
  const env = {};
  const missing = [];
  const same = [];
  for (const { name, source } of entries) {
    const v = lookup(source);
    if (typeof v !== "string" || !v || v.includes("\n")) missing.push(source);
    else if (sameSecret(v, factoryKey)) same.push(name);
    else env[name] = v;
  }
  return { env, entries, refused, missing, factoryKey: same };
}

/**
 * Local mode: the work stage's `worker_secret_values`, from the shell that runs `factory serve` (`env`): one
 * `SOURCE=value` line for each opted-in source set there on one line. "" when none is.
 */
export function localSecretValues(spec, env = process.env) {
  const lines = [];
  for (const { source } of parseWorkerSecrets(spec).entries) {
    const v = env[source];
    if (typeof v === "string" && v.trim() && !/[\r\n]/.test(v)) lines.push(`${source}=${v.trim()}`);
  }
  return lines.join("\n");
}

/** The carrier for runHarness: {SHELL_SECRETS_ENV: JSON} when there is anything to carry, else {}. */
export const packShellSecrets = (secrets = {}) => (Object.keys(secrets).length ? { [SHELL_SECRETS_ENV]: JSON.stringify(secrets) } : {});

/**
 * runHarness's side: {shell: {NAME: value}, env: `env` without the carrier}. A name shellNameRefusal refuses is dropped
 * here too, whoever packed it.
 */
export function takeShellSecrets(env = {}) {
  const { [SHELL_SECRETS_ENV]: packed, ...rest } = env;
  const shell = {};
  try {
    for (const [k, v] of Object.entries(JSON.parse(packed || "{}"))) if (typeof v === "string" && v && !shellNameRefusal(k)) shell[k] = v;
  } catch {
    // not JSON: nothing is carried
  }
  return { shell, env: rest };
}

/**
 * An exit record's `missingSecrets`: its strings that are environment variable names, once each, at most ten. Values are
 * names, never secrets: a string that is not a name is dropped, so nothing else reaches a GitHub comment.
 */
export const missingSecretsOf = (v) => [...new Set((Array.isArray(v) ? v : []).filter((n) => typeof n === "string").map((n) => n.trim()).filter((n) => ENV_NAME.test(n) && n.length <= 100))].slice(0, 10);

/**
 * The fix line of a Block whose worker named variables its shell lacked (`missingSecrets`): opt them in, unless a name
 * is one no worker may have, which is left out (null when none is left, so the Block keeps the generic fix). `spec` is
 * the run's `worker_secrets`; `route` "local" or "runner" says where the values come from.
 */
export function missingSecretsFix(names, spec = "", route = "runner") {
  const left = missingSecretsOf(names).filter((n) => !shellNameRefusal(n));
  if (!left.length) return null;
  const { entries } = parseWorkerSecrets(spec);
  const opted = left.filter((n) => entries.some((e) => e.name === n));
  const named = (list) => list.map((n) => `\`${n}\``).join(", ");
  const where = route === "local" ? "exported in the shell that runs `factory serve` (a running `serve` reads it when it restarts)" : "as a `SOURCE=value` line of the repository secret `FACTORY_WORKER_SECRET_VALUES`, which the workflow passes as `worker_secret_values`";
  const parts = [];
  const fresh = left.filter((n) => !opted.includes(n));
  if (fresh.length) parts.push(`The worker's shell lacked ${named(fresh)}. If the Objective needs ${fresh.length === 1 ? "it" : "them"}, opt ${fresh.length === 1 ? "it" : "them"} in with the \`worker_secrets\` input (\`FACTORY_WORKER_SECRETS\` in the workflow's env block) as \`NAME=SOURCE\`, with SOURCE's value ${where}.`);
  if (opted.length) parts.push(`${named(opted)} ${opted.length === 1 ? "is" : "are"} opted in with \`worker_secrets\` but had no value: set ${opted.length === 1 ? "its" : "their"} SOURCE ${where}, as a key of its own (never Factory's \`AI_GATEWAY_API_KEY\`).`);
  return `${parts.join(" ")} Any code the worker runs can read and spend such a key: use a dedicated key with a budget the provider enforces (docs/PLAN.md, Worker secrets). Then re-apply \`factory:objective\`.`;
}
