// Launch a harness headless, with the task card as the prompt and a wall clock,
// and turn what it printed into one usage record. The CLI flags are each vendor's
// documented headless flags; the tests in plugin/test/usage.test.mjs pin them.
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync } from "node:fs";
import { appendOwn, dropOwned, writeNew } from "./fsafe.mjs";
import { dirname, join } from "node:path";
import { agentUser, asAgent, exec, onPath, sudoEnv } from "./proc.mjs";
import { readAgentFiles } from "./handoff.mjs";
import { COPILOT_CREDIT_USD, parseUsage, sinceSession } from "./usage.mjs";
import { backend } from "./backend.mjs";
import { FACTORY_SECRET_KEYS, SECRET_INPUTS, input, log, maskable } from "./inputs.mjs";
import { HARNESS_GIT_ENV, claudeLocalSettings, codexLocalConfig, copilotTmpdir, harnessGitEnv, isLocal, pinnedInode, sandboxedVersion, stageTemp } from "./local.mjs";

export const CLI = {
  claude: { bin: "claude", pkg: "@anthropic-ai/claude-code" },
  codex: { bin: "codex", pkg: "@openai/codex" },
  copilot: { bin: "copilot", pkg: "@github/copilot" },
};

/** Keys that must never reach a child that is not the harness (validation commands, git hooks). */
export const MODEL_SECRET_KEYS = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "CODEX_API_KEY", "OPENAI_API_KEY", "COPILOT_GITHUB_TOKEN"];
/** Runner credentials a child could turn into a model or App credential; the harness gets its own credential instead. */
export const RUNNER_SECRET_KEYS = ["ACTIONS_ID_TOKEN_REQUEST_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_URL", "ACTIONS_RUNTIME_TOKEN", "FACTORY_APP_TOKEN", "FACTORY_APP_PRIVATE_KEY", "FACTORY_APP_ID", "VERCEL_TOKEN", "VERCEL_OIDC_TOKEN"];

/** Factory's own service keys (inputs.mjs, where local.mjs reads them too): for Factory's process only, never any child's. */
export { FACTORY_SECRET_KEYS };

/**
 * Env for a non-harness child (and the harness itself, before its own credential is added): the
 * job's env with every secret removed. An `extra` value of undefined or null removes that key.
 */
export function scrubbedEnv(base = process.env, extra = {}) {
  const e = { ...base, ...extra };
  for (const k of [...MODEL_SECRET_KEYS, ...RUNNER_SECRET_KEYS, ...GITHUB_TOKEN_KEYS, ...FACTORY_SECRET_KEYS]) delete e[k];
  for (const k of Object.keys(e)) if (e[k] === undefined || e[k] === null) delete e[k];
  for (const k of Object.keys(e)) if (/^FACTORY_INPUT_(APP_ID|APP_PRIVATE_KEY|APP_TOKEN|ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|CODEX_API_KEY|COPILOT_GITHUB_TOKEN|AI_GATEWAY_API_KEY|GITHUB_TOKEN|ANTHROPIC_OIDC_EXCHANGE_URL|VERCEL_TOKEN|VERCEL_TEAM_ID|VERCEL_PROJECT_ID)$/.test(k)) delete e[k];
  // Every secret input under both names inputs.mjs input() reads it by: FACTORY_INPUT_<NAME> and FACTORY_<NAME>.
  for (const name of SECRET_INPUTS) {
    delete e[`FACTORY_INPUT_${name.toUpperCase()}`];
    delete e[`FACTORY_${name.toUpperCase()}`];
  }
  // Factory's own git config by env (the token's credential helper, local mode's Git LFS endpoint pin) is for Factory's
  // own git, never for the harness or a repository's commands.
  for (const k of Object.keys(e)) if (k === "FACTORY_LFS_PIN" || k === "GIT_NO_REPLACE_OBJECTS" || /^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/.test(k)) delete e[k];
  return e;
}

/** GitHub tokens a child must never get from the job: the job's own, gh's, and Factory's write token. */
export const GITHUB_TOKEN_KEYS = ["GITHUB_TOKEN", "GH_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "FACTORY_GIT_TOKEN", "FACTORY_LOCAL_TOKEN", "FACTORY_SECOND_TOKEN", "GH_CONFIG_DIR"];

/**
 * The credential each harness child gets, and nothing else. Returns {env, basis}
 * or throws when the configured credential is absent.
 *   claude  api : ANTHROPIC_API_KEY, or a federated short-lived token (see federate())
 *           plan: CLAUDE_CODE_OAUTH_TOKEN (a developer's own repository only)
 *   codex   api : CODEX_API_KEY, set on this child only
 *   copilot     : COPILOT_GITHUB_TOKEN = the copilot_github_token input (a Copilot Requests token
 *                 that bills its owner's seat); never the job's token, which can write
 *   any   login : the CLI's own login on this machine (PLAN.md's development fallback:
 *                 "the worker run locally uses whatever the CLI is logged in as");
 *                 refused inside Actions, where only API credentials run unattended.
 *                 Outside Actions, `api` with no key present falls back to it with a warning,
 *                 so a local run needs no credential configuration at all.
 */
export function hasApiCredential({ harness, inputs, env = process.env }) {
  if (harness === "claude") return !!(inputs.anthropicApiKey || env.ANTHROPIC_API_KEY || (env.ACTIONS_ID_TOKEN_REQUEST_URL && inputs.anthropicOidcExchangeUrl));
  if (harness === "codex") return !!(inputs.codexApiKey || env.CODEX_API_KEY);
  if (harness === "copilot") return !!(inputs.copilotGithubToken || env.COPILOT_GITHUB_TOKEN);
  return false;
}

export async function credentialEnv({ harness, credential, inputs, env = process.env }) {
  const out = {};
  const local = !env.GITHUB_ACTIONS;
  if (credential === "login" || (local && credential === "api" && !hasApiCredential({ harness, inputs, env }))) {
    if (!local) throw new Error("credential: login is for a developer's machine; unattended runs use api (or plan on your own repository)");
    for (const k of MODEL_SECRET_KEYS) if (env[k]) out[k] = env[k]; // whatever the developer's shell already carries
    return { env: out, basis: `${harness} CLI login on this machine${credential === "api" ? " (no API credential present; local fallback)" : ""}` };
  }
  if (harness === "claude") {
    if (credential === "plan") {
      const tok = inputs.claudeCodeOauthToken || env.CLAUDE_CODE_OAUTH_TOKEN;
      if (!tok) throw new Error("credential: plan needs CLAUDE_CODE_OAUTH_TOKEN (claude setup-token); use it only on your own repository");
      out.CLAUDE_CODE_OAUTH_TOKEN = tok;
      return { env: out, basis: "plan token" };
    }
    const key = inputs.anthropicApiKey || env.ANTHROPIC_API_KEY;
    if (key) {
      out.ANTHROPIC_API_KEY = key;
      return { env: out, basis: "ANTHROPIC_API_KEY" };
    }
    const fed = await federate({ exchangeUrl: inputs.anthropicOidcExchangeUrl, env });
    if (fed) {
      out.ANTHROPIC_API_KEY = fed;
      return { env: out, basis: "workload identity federation" };
    }
    throw new Error("no Claude credential: set ANTHROPIC_API_KEY, or id-token: write with anthropic_oidc_exchange_url for federation");
  }
  if (harness === "codex") {
    const key = inputs.codexApiKey || env.CODEX_API_KEY;
    if (!key) throw new Error("no Codex credential: set CODEX_API_KEY on the worker step");
    out.CODEX_API_KEY = key;
    return { env: out, basis: "CODEX_API_KEY (step-scoped)" };
  }
  if (harness === "copilot") {
    // Never the job's own token: it can write to the repository, and the harness holds no GitHub write access.
    const tok = inputs.copilotGithubToken || env.COPILOT_GITHUB_TOKEN;
    if (!tok) throw new Error("no Copilot credential: set copilot_github_token (a fine-grained token with only the Copilot Requests permission)");
    out.COPILOT_GITHUB_TOKEN = tok;
    return { env: out, basis: inputs.copilotGithubToken ? "copilot_github_token (step-scoped)" : "COPILOT_GITHUB_TOKEN" };
  }
  throw new Error(`unknown harness ${harness}`);
}

/**
 * Workload identity federation: exchange the job's OIDC token for a short-lived
 * Anthropic credential. The exchange endpoint is an input
 * (`anthropic_oidc_exchange_url`), not a constant; without it this returns null and the caller asks for a key.
 */
export async function federate({ exchangeUrl, env = process.env, audience = "anthropic" }) {
  const url = env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const tok = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!url || !tok || !exchangeUrl) return null;
  const r = await fetch(`${url}&audience=${encodeURIComponent(audience)}`, { headers: { Authorization: `bearer ${tok}` } });
  if (!r.ok) throw new Error(`OIDC token request failed: HTTP ${r.status} (is id-token: write on the job?)`);
  const { value: oidc } = await r.json();
  const x = await fetch(exchangeUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ oidc_token: oidc }) });
  if (!x.ok) throw new Error(`federation exchange failed: HTTP ${x.status}`);
  const body = await x.json();
  const key = body.api_key || body.token || body.access_token;
  if (!key) throw new Error("federation exchange returned no credential");
  if (maskable(env)) process.stdout.write(`::add-mask::${key}\n`);
  return key;
}

/**
 * The prompt-cache TTL Factory asks Claude Code to use for the main conversation (CLAUDE_CODE_PROMPT_CACHE_TTL, Claude
 * Code 2.1.242 or later), from the `prompt_cache_ttl` setting in FACTORY_PROMPT_CACHE_TTL:
 *   off (default)   nothing set: the CLI default, until the A/B in bench/README.md shows the hour pays
 *   auto            `1h` when the run bills an API key (ANTHROPIC_API_KEY, which wins over an OAuth token): an API
 *                   key gets five minutes otherwise, so a CI wait longer than that re-writes the whole prefix; a plan
 *                   token or a CLI login already gets an hour on the main conversation, so nothing is set
 *   1h | 5m         that TTL on every credential
 * Sub-agents keep the CLI's default either way. Null when nothing is set; Codex and Copilot cache on their own.
 */
export function promptCacheTtl(harness, env = {}) {
  if (harness !== "claude") return null;
  const setting = String(env.FACTORY_PROMPT_CACHE_TTL || "off").trim().toLowerCase();
  if (setting === "1h" || setting === "5m") return setting;
  if (setting !== "auto") return null;
  return env.ANTHROPIC_API_KEY ? "1h" : null;
}

/**
 * The command line for one run. `resume` is the session id of the run to continue
 * (Claude --resume, Codex exec resume, Copilot --resume); `agent` names a pinned
 * agent definition to run as (Claude --agent, Copilot --agent; Codex has no flag,
 * so the prompt names the file). `usageFile` is where Copilot writes its final usage.
 */
export function harnessCommand({ harness, model, prompt, maxUsd, resume, agent, usageFile, effort, compaction = null, local = null, cacheTtl = null, creditUsd = COPILOT_CREDIT_USD }) {
  // Local mode (a developer's box): each harness runs its model's commands in its own sandbox, configured by
  // lib/local.mjs to one bar; on a runner the VM is disposable, so permissions are skipped.
  switch (harness) {
    case "claude": {
      // One cached system-prompt prefix for every worker and reviewer on identical checkouts: the per-machine
      // sections (the auto-memory path) move into the first user message instead of the system prompt.
      // On a runner the VM is disposable, so permissions are skipped; on a developer's box edits stay in the
      // working directory and the added directories, and shell commands run in Claude Code's sandbox.
      // Locally only Factory's flag settings apply: no user settings (the developer's own plugins, hooks and MCP servers)
      // and no project or local ones, which the clone carries and sandboxed code can write, so a planted hook or helper
      // would run on the host outside every sandbox. The repository's CLAUDE.md still loads (as an added directory); Factory's
      // skills and agent definitions, and the repository's own, come from a copy in the stage's usage directory, which no
      // sandbox may write (checkout.mjs claudePlugin).
      const plugin = local?.claudeDir ? ["--plugin-dir", join(local.claudeDir, "plugin"), "--agents", join(local.claudeDir, "agents.json")] : [];
      // The package caches are writable to shell commands only, never added directories, whose CLAUDE.md would load.
      const caches = local?.cacheDirs || [];
      const perms = local ? ["--permission-mode", "acceptEdits", "--setting-sources", "", "--strict-mcp-config", "--settings", JSON.stringify(claudeLocalSettings({ domains: local.domains, clone: local.clone, readOnly: local.readOnly, writable: caches })), ...plugin, ...[...(local.clone ? [local.clone] : []), ...local.addDirs.filter((d) => !caches.includes(d)), ...(local.readDirs || [])].flatMap((d) => ["--add-dir", d])] : ["--dangerously-skip-permissions"];
      const args = ["-p", "--output-format", "stream-json", "--verbose", ...perms, "--exclude-dynamic-system-prompt-sections"];
      if (model) args.push("--model", model);
      if (effort) args.push("--effort", effort);
      if (agent) args.push("--agent", agent);
      if (maxUsd > 0) args.push("--max-budget-usd", String(maxUsd));
      if (resume) args.push("--resume", resume);
      return { cmd: "claude", args, stdin: prompt, canResume: true, env: { ...(compaction ? { CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(compaction) } : {}), ...(cacheTtl ? { CLAUDE_CODE_PROMPT_CACHE_TTL: cacheTtl } : {}), ...(local ? { CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: "1", ...HARNESS_GIT_ENV } : {}) } };
    }
    case "codex": {
      // `codex exec resume <id>` continues a thread; the prompt comes on stdin (`-`) either way.
      const args = resume ? ["exec", "resume", resume] : ["exec"];
      // Locally the developer's own Codex config (MCP servers, plugins, hooks, notify) stays out, as with Claude Code.
      const perms = local ? ["--ignore-user-config", ...codexLocalConfig({ domains: local.domains, clone: local.clone, addDirs: local.addDirs, readOnly: local.readOnly, secretEnv: [...MODEL_SECRET_KEYS, ...RUNNER_SECRET_KEYS, ...FACTORY_SECRET_KEYS] })] : ["--dangerously-bypass-approvals-and-sandbox"];
      args.push("--json", ...perms, "--skip-git-repo-check");
      if (model && !resume) args.push("-m", model);
      if (effort) args.push("-c", `model_reasoning_effort=${JSON.stringify(effort)}`);
      if (compaction) args.push("-c", `model_auto_compact_token_limit=${Number(compaction)}`);
      return { cmd: "codex", args: [...args, "-"], stdin: prompt, canResume: true, env: local ? { ...HARNESS_GIT_ENV } : {} };
    }
    case "copilot": {
      // --allow-all = tools, paths and URLs; required for non-interactive runs. JSONL on stdout; usage to a file.
      // Locally --sandbox puts every command in Copilot's sandbox under the policy in $COPILOT_HOME/settings.json,
      // which the local backend writes (lib/local.mjs copilotLocalSettings); --allow-all then only skips prompts.
      // Its file tools are not OS-sandboxed, so locally path checks stay on: tools and URLs are allowed, paths only in
      // the working directory and the added directories (without --allow-all-paths, any other path is refused headless).
      // The package caches are writable to commands through the policy only: an added directory's .github/agents and
      // .github/skills would load as trusted configuration. --trust-folder is never passed (the clone stays untrusted).
      const perms = local ? ["--sandbox", "--allow-all-tools", "--allow-all-urls", ...local.addDirs.filter((d) => !(local.cacheDirs || []).includes(d)).flatMap((d) => ["--add-dir", d])] : ["--allow-all"];
      // Copilot's built-in GitHub MCP server would act with whatever token Copilot holds: always off.
      // The prompt goes on stdin, never `-p <prompt>`: one argv string over 128 KB fails to start on Linux (E2BIG), and
      // without -p a piped stdin is a non-interactive prompt (1.0.107, checked live with 200 KB, fresh and --resume).
      const args = [...perms, "--disable-builtin-mcps", "--output-format", "json"];
      if (model) args.push("--model", model);
      if (effort) args.push("--reasoning-effort", effort);
      // Copilot has no compaction setting: it manages its own context, so `compaction` does not apply.
      if (agent) args.push("--agent", agent);
      if (resume) args.push("--resume", resume);
      if (usageFile) args.push("--usage-output-file", usageFile);
      // The dollars left as AI credits. The cap is per process: a resumed session's earlier credits do not count against
      // it (1.0.107, checked live), so it is what is left, never plus the session's past. Copilot takes no less than 30
      // credits; with less than that left runHarness starts no Copilot run at all.
      if (maxUsd > 0) args.push("--max-ai-credits", String(Math.max(COPILOT_MIN_CREDITS, Math.floor(maxUsd / creditUsd))));
      return { cmd: "copilot", args, stdin: prompt, canResume: true, env: local ? { ...HARNESS_GIT_ENV } : {} };
    }
    default:
      throw new Error(`unknown harness ${harness}`);
  }
}

/**
 * Run the harness once. Streams stdout to `eventsFile` (usage/events.jsonl), returns
 * the usage record plus {timedOut, exitCode, stdoutTail, finalText}. Never logs the
 * prompt or the env.
 */
export const HARNESS_IDLE_MS = 30 * 60_000;

/**
 * The installed CLI version (`<cmd> --version`, first line), so a cost change can be told from a CLI update; null when
 * unknown. Locally it runs in srt (local.mjs sandboxedVersion): a binary a run replaced must not run on the host.
 */
export function harnessVersion(harness, env = process.env) {
  const cmd = { claude: "claude", codex: "codex", copilot: "copilot" }[harness];
  if (!cmd) return null;
  if (isLocal(env)) {
    // Its settings where no sandbox may write (the stage's own temp directory is writable to its commands).
    const dir = stageTemp("version-");
    try {
      return sandboxedVersion(cmd, dir, { env: scrubbedEnv(env) });
    } finally {
      dropOwned(dir);
    }
  }
  try {
    // On Actions the CLI is the agent's to run: as the agent, never as the runner.
    const [c, a, e] = agentUser() ? asAgent(cmd, ["--version"], process.env) : [cmd, ["--version"], process.env];
    return execFileSync(c, a, { encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "ignore"], env: agentUser() ? sudoEnv(a, e) : e }).trim().split(/\r?\n/)[0] || null;
  } catch {
    return null;
  }
}

// The running totals each session (a Codex thread) last reported in this process, so a resumed pass counts only its own
// share: every harness reports a resumed session's usage as the session's total.
const SESSION_TOTALS = new Map();
const RUNNING_TOTALS = new Set(["claude", "codex", "copilot"]);

/**
 * The dollars per Copilot AI credit: the `copilot_credit_usd` setting, else GitHub's published $0.01. A value that is
 * not a positive number is refused with a warning (zero would make every Copilot run free to the caps).
 */
let warnedCreditUsd = null;
export function copilotCreditUsd(env = process.env) {
  const v = String(input("copilot_credit_usd", { env })).trim();
  if (v === "") return COPILOT_CREDIT_USD;
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) return n;
  if (warnedCreditUsd !== v) {
    warnedCreditUsd = v;
    log(`copilot_credit_usd ${JSON.stringify(v.slice(0, 40))} is not a positive number; using GitHub's $${COPILOT_CREDIT_USD} per AI credit`);
  }
  return COPILOT_CREDIT_USD;
}

/** Copilot refuses a --max-ai-credits below this (1.0.107: "Use at least 30 AI credits"). */
export const COPILOT_MIN_CREDITS = 30;

/** A restored session's last running total (its transcript's), unless this process has already seen a later one. */
export function seedSessionTotal(sessionId, total) {
  if (sessionId && total && !SESSION_TOTALS.has(sessionId)) SESSION_TOTALS.set(sessionId, total);
}

export async function runHarness({ harness, model, prompt, maxUsd, resume, agent, cwd, env, timeoutMs, eventsFile, label = "run", effort, onLine = null, onResume = null, idleMs = HARNESS_IDLE_MS, signal = null }) {
  // On Actions the agent uid writes Copilot's usage file in its own temp directory; Factory reads it back as the agent.
  const agentUid = agentUser();
  const usageName = `copilot-usage-${label}-${Date.now()}.json`;
  // Locally the harness's outer sandbox lets it write only the usage directory's `harness` folder.
  const outer = backend(env).sandbox.outer(env);
  const usageFile = harness === "copilot" && eventsFile ? join(agentUid ? agentUid.tmp : outer ? join(dirname(eventsFile), "harness") : dirname(eventsFile), usageName) : undefined;
  const compaction = env?.FACTORY_COMPACTION_WINDOW || null;
  // Copilot's sandbox opens the TMPDIR it starts with: locally that must be the stage's own (lib/local.mjs copilotTmpdir).
  if (harness === "copilot") {
    const sandboxed = backend(env).sandbox.harness(env);
    if (sandboxed) copilotTmpdir(sandboxed, env);
  }
  // Locally: whatever hook, settings or MCP server a sandboxed command left in the clone is gone before the harness starts.
  const cleared = await backend(env).sandbox.beforeHarness(scrubbedEnv(env));
  const cacheTtl = promptCacheTtl(harness, env);
  const creditUsd = copilotCreditUsd();
  // Copilot takes no cap under 30 AI credits: with less than that left, no Copilot run starts (the caller Blocks on the
  // budget), rather than one capped above what is left.
  if (harness === "copilot" && maxUsd > 0 && maxUsd < COPILOT_MIN_CREDITS * creditUsd) {
    const now = new Date().toISOString();
    log(`${label}: $${maxUsd} left is under Copilot's ${COPILOT_MIN_CREDITS}-credit minimum cap; not starting the run`);
    return { ...parseUsage(harness, "", model || null, 0, { creditUsd }), label, usd: 0, ok: false, budgetExceeded: true, error: "dollar cap reached", basis: `no run: $${maxUsd} left is under Copilot's ${COPILOT_MIN_CREDITS}-credit minimum cap`, started: now, ended: now, finalText: "", timedOut: false, exitCode: null, signal: null, idle: false, stdoutTail: "", stderrTail: "" };
  }
  const { cmd, args, stdin, env: extraEnv } = harnessCommand({ harness, model, prompt, maxUsd, resume, agent, usageFile, effort, compaction, cacheTtl, creditUsd, local: backend(env).sandbox.harness(env) });
  if (cleared?.submodules?.length) Object.assign(extraEnv, harnessGitEnv(cleared.submodules));
  if (!(await onPath(cmd))) throw new Error(`${cmd} is not on PATH (npm install -g ${CLI[harness].pkg})`);
  if (eventsFile) {
    mkdirSync(dirname(eventsFile), { recursive: true });
    appendOwn(eventsFile, `${JSON.stringify({ type: "factory.run", label, harness, model: model || null, effort: effort || null, started: new Date().toISOString(), resume: !!resume })}\n`);
  }
  // A resumed session's prior running total, for the live counter (onResume) and for this pass's own share (sinceSession).
  const prior = RUNNING_TOTALS.has(harness) && resume ? (SESSION_TOTALS.get(resume) ?? null) : null;
  if (prior) onResume?.(resume, prior);
  const started = new Date().toISOString();
  // On Actions the harness runs as the agent uid (its cwd is the agent's checkout), with its model credential and nothing
  // else from the job; locally it leads its own process group, killed when it exits. Then its leftovers are reaped.
  const childEnv = { ...env, ...extraEnv };
  // Locally the harness's git is Factory's guard (local.mjs gitGuardScript), checking the .git the pre-start clear checked.
  const sandboxed = backend(env).sandbox.harness(env);
  if (sandboxed?.gitBin && sandboxed.clone) {
    childEnv.PATH = `${sandboxed.gitBin}:${childEnv.PATH || ""}`;
    childEnv.FACTORY_GIT_DIR = join(sandboxed.clone, ".git");
    // The inode Factory pinned when it cloned (beforeHarness checked .git against it), never read from the clone now.
    childEnv.FACTORY_GIT_ID = pinnedInode(sandboxed.gitId);
  }
  // Each would make Copilot load the clone's hooks, settings, .mcp.json or extensions (COPILOT_ALLOW_ALL trusts the folder).
  if (harness === "copilot") for (const k of ["COPILOT_ALLOW_ALL", "GITHUB_COPILOT_PROMPT_MODE_REPO_HOOKS", "GITHUB_COPILOT_PROMPT_MODE_EXTENSIONS"]) delete childEnv[k];
  // Linux: the harness process itself in srt, the stage's TMPDIR put back (srt points it at its shared /tmp/claude).
  const [runCmd, runArgs] = outer ? ["srt", ["-s", outer, "--", "env", `TMPDIR=${childEnv.TMPDIR || ""}`, cmd, ...args]] : [cmd, args];
  // Its stdout and stderr are files, never pipes (proc.mjs fileStdio): a pipe another process in the chain made
  // non-blocking (srt's Node does) crashed Codex on EAGAIN mid-pass (#2649).
  const r = await exec(runCmd, runArgs, { cwd, env: childEnv, input: stdin, timeoutMs, tee: eventsFile, echo: true, onLine, idleMs, signal, agentExtra: [...MODEL_SECRET_KEYS, ...Object.keys(extraEnv), "COPILOT_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR"], group: backend(env).name === "local", fileStdio: true });
  await backend(env).sandbox.reap();
  const ended = new Date().toISOString();
  // Only a regular file the harness wrote is read (in the outer sandbox's folder, a link could point anywhere).
  let usagePath = usageFile && outer && !lstatSync(usageFile, { throwIfNoEntry: false })?.isFile() ? undefined : usageFile;
  if (agentUid && usageFile) {
    const got = (await readAgentFiles(agentUid.tmp, [usageName], env)).files[usageName];
    usagePath = join(dirname(eventsFile), usageName);
    if (got !== undefined) writeNew(usagePath, got);
  }
  const reported = parseUsage(harness, r.stdout, model || null, r.code ?? 1, { usageFile: usagePath, creditUsd });
  const rec = prior ? sinceSession(reported, prior) : reported;
  // A pass with no result line (killed, crashed) reports no total; the session's last good one stays.
  if (RUNNING_TOTALS.has(harness) && reported.sessionId && reported.usd !== null) {
    const total = { usd: reported.usd, tokens: reported.tokens, models: reported.models, premiumRequests: reported.premiumRequests, aiu: reported.aiu, sessionStartTime: reported.sessionStartTime };
    SESSION_TOTALS.set(reported.sessionId, total);
    // The session's running total as Factory read it (for Copilot the larger of the usage file and the stream), kept in
    // the usage record so a later stage that restores the session bounds its saved total by it (session.mjs writeUsage).
    rec.sessionTotal = total;
  }
  rec.label = label;
  rec.resumed = !!resume;
  rec.cacheTtl = cacheTtl;
  rec.finalText = finalText(harness, r.stdout);
  rec.started = started;
  rec.ended = ended;
  rec.timedOut = r.timedOut;
  rec.exitCode = r.code;
  rec.signal = r.signal;
  rec.idle = !!r.idle;
  // Stopped by Factory (`signal`: the plan-time Question, worker.mjs): no crash, and the run is not retried.
  rec.stopped = !!r.stopped;
  if (r.stopped && !r.timedOut) {
    rec.ok = false;
    rec.error = "stopped by Factory";
  } else if (r.timedOut) {
    rec.ok = false;
    rec.error = rec.error || "wall clock reached";
  } else if (r.idle) {
    rec.ok = false;
    rec.error = `no output from the harness for ${Math.round(idleMs / 60000)} min; killed`;
  } else if (r.code !== 0 && rec.ok) {
    rec.ok = false;
    rec.error = `${cmd} exited ${r.code ?? r.signal}`;
  }
  rec.stdoutTail = String(r.stdout).slice(-4000);
  rec.stderrTail = String(r.stderr).slice(-4000);
  if (eventsFile) appendOwn(eventsFile, `${JSON.stringify({ type: "factory.run.end", label, ended, ok: rec.ok, exitCode: r.code, timedOut: r.timedOut, usd: rec.usd })}\n`);
  return rec;
}

/** The last text the harness produced (Claude result.result, Codex agent_message items, Copilot stdout). */
export function finalText(harness, stdout) {
  const lines = String(stdout || "").split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith("{"));
  const parsed = [];
  for (const l of lines) {
    try {
      parsed.push(JSON.parse(l));
    } catch {
      // not JSON
    }
  }
  if (harness === "claude") {
    const res = [...parsed].reverse().find((e) => e.type === "result");
    if (typeof res?.result === "string") return res.result;
    const msgs = parsed.filter((e) => e.type === "assistant").flatMap((e) => e.message?.content || []).filter((c) => c.type === "text");
    return msgs.map((c) => c.text).join("\n");
  }
  if (harness === "codex") {
    return parsed
      .filter((e) => e.type === "item.completed" && e.item?.type === "agent_message")
      .map((e) => e.item.text || "")
      .join("\n");
  }
  // Copilot JSONL: the assistant's messages (user.message carries the prompt, not an answer); else the raw stdout.
  const texts = parsed.filter((e) => e.type === "assistant.message" && typeof e.data?.content === "string").map((e) => e.data.content);
  return texts.length ? texts.join("\n") : String(stdout || "");
}
