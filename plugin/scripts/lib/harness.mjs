// Launch a harness headless, with the task card as the prompt and a wall clock,
// and turn what it printed into one usage record. The CLI flags are each vendor's
// documented headless flags; the tests in plugin/test/usage.test.mjs pin them.
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync } from "node:fs";
import { appendOwn, dropOwned, writeNew } from "./fsafe.mjs";
import { dirname, join } from "node:path";
import { agentUser, asAgent, exec, onPath, sudoEnv } from "./proc.mjs";
import { readAgentFiles } from "./handoff.mjs";
import { asClaudeAgent, agentServicePorts, archiveSession, captureSession, capturedSession, keepSession, realRoots, resetClaudeState, writeEnvFile, restoreRunnerGit, runnerEnv, runnerLaunch, runnerLayout } from "./claude-runner.mjs";
import { CONFINEMENT_PROBE, DECOY_LAUNCH, PROBE_MARKER, codexRunnerConfig, codexRunnerEnv, codexRunnerLayout, offListHost, presentPaths, resetCodexState } from "./codex-runner.mjs";
import { COPILOT_DECOY_LAUNCH, copilotLaunch, copilotRunnerEnv, copilotRunnerFlags, copilotRunnerLayout, probeEnv, probeMarker, probeModel, probeResult, resetCopilotState, resetProbe } from "./copilot-runner.mjs";
import { COPILOT_CREDIT_USD, parseUsage, refusalFields, sinceSession } from "./usage.mjs";
import { MAX_ROLLOUT_BYTES, codexSessionRoot, codexThreads, localRollouts, withSubAgents } from "./codex-threads.mjs";
import { backend } from "./backend.mjs";
import { CODEX_GATEWAY_ENV, FACTORY_SECRET_KEYS, GITHUB_TOKEN_KEYS, MODEL_SECRET_KEYS, RUNNER_SECRET_KEYS, SECRET_INPUTS, input, log, maskable } from "./inputs.mjs";
import { SHELL_SECRETS_ENV, takeShellSecrets } from "./worker-secrets.mjs";
import { GitRefusal, HARNESS_GIT_ENV, claudeLocalSettings, claudeRunnerSettings, clearHarnessConfig, codexLocalConfig, codexShellExclude, copilotTmpdir, harnessGitEnv, isLocal, pinnedInode, runnerDomains, sandboxedVersion, stageTemp } from "./local.mjs";

export const CLI = {
  claude: { bin: "claude", pkg: "@anthropic-ai/claude-code" },
  codex: { bin: "codex", pkg: "@openai/codex" },
  copilot: { bin: "copilot", pkg: "@github/copilot" },
};

/**
 * The credential lists (inputs.mjs, where local.mjs and worker-secrets.mjs read them too): the model's
 * (MODEL_SECRET_KEYS), the runner's (RUNNER_SECRET_KEYS), GitHub's (GITHUB_TOKEN_KEYS) and Factory's own service keys
 * (FACTORY_SECRET_KEYS), which are for Factory's process only, never any child's.
 */
export { FACTORY_SECRET_KEYS, GITHUB_TOKEN_KEYS, MODEL_SECRET_KEYS, RUNNER_SECRET_KEYS };

/**
 * The credentials the harness must keep out of the commands its model runs, on every route: its own model credential
 * (which it needs, but its shell does not) and any other Factory could hand it. Codex drops them by its shell
 * environment policy, Copilot by --secret-env-vars. Not GitHub's names: the agent's read-only `gh` login is meant for its
 * commands.
 */
export const SHELL_SECRET_KEYS = [...MODEL_SECRET_KEYS, ...RUNNER_SECRET_KEYS, ...FACTORY_SECRET_KEYS];

/**
 * SHELL_SECRET_KEYS less the worker secrets a repository opted in to its worker's shell (lib/worker-secrets.mjs): only a
 * Factory service key's name (AI_GATEWAY_API_KEY, holding the adopter's own key) can be one; a model, runner or GitHub
 * credential's name never leaves the list, whatever `shellSecrets` says.
 */
export const hiddenFromShell = (shellSecrets = []) => SHELL_SECRET_KEYS.filter((k) => !(FACTORY_SECRET_KEYS.includes(k) && shellSecrets.includes(k)));

/**
 * Env for a non-harness child (and the harness itself, before its own credential is added): the
 * job's env with every secret removed. An `extra` value of undefined or null removes that key.
 */
export function scrubbedEnv(base = process.env, extra = {}) {
  const e = { ...base, ...extra };
  // The worker's shell secrets (lib/worker-secrets.mjs) are for its harness alone (runHarness unpacks them there).
  delete e[SHELL_SECRETS_ENV];
  for (const k of [...MODEL_SECRET_KEYS, ...RUNNER_SECRET_KEYS, ...GITHUB_TOKEN_KEYS, ...FACTORY_SECRET_KEYS]) delete e[k];
  for (const k of Object.keys(e)) if (e[k] === undefined || e[k] === null) delete e[k];
  for (const k of Object.keys(e)) if (/^FACTORY_INPUT_(APP_ID|APP_PRIVATE_KEY|APP_TOKEN|ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|CODEX_API_KEY|CODEX_GATEWAY_KEY|COPILOT_GITHUB_TOKEN|AI_GATEWAY_API_KEY|GITHUB_TOKEN|ANTHROPIC_OIDC_EXCHANGE_URL|VERCEL_TOKEN|VERCEL_TEAM_ID|VERCEL_PROJECT_ID)$/.test(k)) delete e[k];
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

/**
 * The credential each harness child gets, and nothing else. Returns {env, basis}
 * or throws when the configured credential is absent.
 *   claude  api : ANTHROPIC_API_KEY, or a federated short-lived token (see federate())
 *           plan: CLAUDE_CODE_OAUTH_TOKEN (a developer's own repository only)
 *   codex   api : FACTORY_CODEX_GATEWAY_KEY (the codex_gateway_key input) when set: Codex through the Vercel AI
 *                 Gateway (codexGatewayArgs), with FACTORY_GATEWAY_SESSION, the stint's session id (gatewaySession);
 *                 else CODEX_API_KEY. Either is set on this child only; with both set the gateway key wins and
 *                 CODEX_API_KEY stays out of the child.
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
  if (harness === "codex") return !!(inputs.codexGatewayKey || inputs.codexApiKey || env.CODEX_API_KEY);
  if (harness === "copilot") return !!(inputs.copilotGithubToken || env.COPILOT_GITHUB_TOKEN);
  return false;
}

export async function credentialEnv({ harness, credential, inputs, env = process.env, session = null }) {
  const out = {};
  const local = !env.GITHUB_ACTIONS;
  if (credential === "login" || (local && credential === "api" && !hasApiCredential({ harness, inputs, env }))) {
    if (!local) throw new Error("credential: login is for a developer's machine; unattended runs use api (or plan on your own repository)");
    // Whatever the developer's shell already carries for the CLI's own sign-in; not the gateway key, which would turn
    // the run onto the gateway (codexGatewayOf).
    for (const k of MODEL_SECRET_KEYS) if (env[k] && k !== CODEX_GATEWAY_ENV) out[k] = env[k];
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
    // The gateway key wins when both are set: one credential per child, and the rule needs no setting.
    if (inputs.codexGatewayKey) {
      out[CODEX_GATEWAY_ENV] = inputs.codexGatewayKey;
      out.FACTORY_GATEWAY_SESSION = session || gatewaySession({});
      return { env: out, basis: `${CODEX_GATEWAY_ENV} (Vercel AI Gateway, step-scoped)` };
    }
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

/** The Vercel AI Gateway's Codex endpoint (its `/codex/v1/models` answers in the shape Codex reads at start). */
export const GATEWAY_CODEX_URL = "https://ai-gateway.vercel.sh/codex/v1";

/**
 * The gateway session id for one Objective's Running stint (`since`: when it last became Running), so every pass and
 * every resume of the stint sends the same `x-session-id` and the gateway keeps it on the provider credential that
 * wrote the thread. Opaque (a hash: the gateway asks for no personal data in it); a stage that cannot read the stint
 * gets one of its own.
 */
export function gatewaySession({ repo = null, issue = null, since = null }) {
  const t = Date.parse(since ?? "");
  const stint = repo && issue && Number.isFinite(t) ? `${repo}#${issue}@${t}` : `stage-${randomUUID()}`;
  return `factory-${createHash("sha256").update(stint).digest("hex").slice(0, 32)}`;
}

/** The gateway route of a Codex child whose env carries the gateway key ({session}), else null. */
export const codexGatewayOf = (harness, env = {}) => (harness === "codex" && env[CODEX_GATEWAY_ENV] ? { session: env.FACTORY_GATEWAY_SESSION || null } : null);

/** A model id as the gateway names it: `openai/<id>`, unless it already has a provider prefix. */
export const gatewayModel = (model) => (String(model).includes("/") ? String(model) : `openai/${model}`);

/**
 * Codex's flags for the Vercel AI Gateway (vercel.com/docs/ai-gateway/coding-agents/openai-codex; keys checked against
 * the Codex config reference and codex-cli 0.167.0): a `vercel` provider on the gateway's Codex endpoint, its key from
 * FACTORY_CODEX_GATEWAY_KEY, the Responses wire API, and the stint's session id as `x-session-id` from
 * FACTORY_GATEWAY_SESSION (session affinity: the pin names the provider credential, so a resume's encrypted reasoning
 * goes back to the account that wrote it).
 */
export function codexGatewayArgs({ session = null } = {}) {
  const p = "model_providers.vercel";
  return [
    'model_provider="vercel"',
    `${p}.name="Vercel AI Gateway"`,
    `${p}.base_url=${JSON.stringify(GATEWAY_CODEX_URL)}`,
    `${p}.env_key=${JSON.stringify(CODEX_GATEWAY_ENV)}`,
    `${p}.wire_api="responses"`,
    ...(session ? [`${p}.env_http_headers={ "x-session-id" = "FACTORY_GATEWAY_SESSION" }`] : []),
  ].flatMap((c) => ["-c", c]);
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
 * A runner's Claude Code run (Actions, a cloud sandbox VM): the agent's checkout (`clone`), the runner layout
 * (lib/claude-runner.mjs: Factory's HOME for Claude Code, its per-start state, the caches) and the hosts its commands
 * may reach (`allowed_domains`). Null for any other harness, in local mode and before the agent uid exists.
 */
export function claudeRunner({ harness, agent, clone, env = process.env, claudeHome, services = null }) {
  if (harness !== "claude" || !agent || !clone || backend(env).name === "local") return null;
  const layout = runnerLayout(agent, claudeHome);
  // Its edit-diff directory is named by the agent's uid; without it the sandbox could not keep commands out of it.
  if (!layout.editDiffs) throw new Error(`no uid for ${agent.user}: refusing to start Claude Code without its sandbox's full write list`);
  // The services the repository's setup started: their loopback ports through the sandbox's proxy (claude-runner.mjs).
  const offered = services ?? agentServicePorts(agent);
  return { clone, ...layout, services: offered, domains: [...runnerDomains(input("allowed_domains", { env })), ...offered.map((p) => `127.0.0.1:${p}`)] };
}

/** The Vercel AI Gateway's host, which a runner's Codex commands may reach when the gateway is Codex's provider. */
export const GATEWAY_HOST = new URL(GATEWAY_CODEX_URL).hostname;

/**
 * A runner's Codex run (Actions, a cloud sandbox VM): the agent's checkout (`clone`), the runner layout
 * (lib/codex-runner.mjs: Factory's HOME for Codex, its fresh CODEX_HOME, the caches) and the hosts its commands may reach
 * (`allowed_domains`, and the gateway's host when it is the provider). `present` is filled before each start: the
 * checkout's read-only paths that exist. Null for any other harness, in local mode and before the agent uid exists.
 */
export function codexRunner({ harness, agent, clone, env = process.env, codexHome }) {
  if (harness !== "codex" || !agent || !clone || backend(env).name === "local") return null;
  const gateway = env[CODEX_GATEWAY_ENV] ? [GATEWAY_HOST] : [];
  return { clone, ...codexRunnerLayout(agent, codexHome), domains: [...new Set([...runnerDomains(input("allowed_domains", { env })), ...gateway])], present: null };
}

/**
 * A runner's Copilot run (Actions, a cloud sandbox VM): the agent's checkout (`clone`), the runner layout
 * (lib/copilot-runner.mjs: Factory's HOME for Copilot with its bwrap and release, its fresh COPILOT_HOME, the caches,
 * the agent's GitHub login) and the hosts its commands may reach (`allowed_domains`). Null for any other harness, in
 * local mode and before the agent uid exists.
 */
export function copilotRunner({ harness, agent, clone, env = process.env, copilotHome }) {
  if (harness !== "copilot" || !agent || !clone || backend(env).name === "local") return null;
  return { clone, ...copilotRunnerLayout(agent, copilotHome), domains: runnerDomains(input("allowed_domains", { env })) };
}

/**
 * The command line for one run. `resume` is the session id of the run to continue
 * (Claude --resume, Codex exec resume, Copilot --resume); `agent` names a pinned
 * agent definition to run as (Claude --agent, Copilot --agent; Codex has no flag,
 * so the prompt names the file). `usageFile` is where Copilot writes its final usage.
 */
export function harnessCommand({ harness, model, prompt, maxUsd, resume, agent, usageFile, effort, compaction = null, local = null, runner = null, cacheTtl = null, creditUsd = COPILOT_CREDIT_USD, shellSecrets = [], gateway = null }) {
  // The credentials kept from the model's commands: every one, less the worker secrets opted in to its shell.
  const hidden = hiddenFromShell(shellSecrets);
  // Local mode (a developer's box): each harness runs its model's commands in its own sandbox, configured by
  // lib/local.mjs to one bar. On a runner and in a cloud sandbox VM (`runner`: the agent uid's checkout, home and temp
  // directory), every harness runs its commands in its own sandbox to the same bar (claudeRunnerSettings,
  // codexRunnerConfig, copilotRunnerSettings), so they never see its credential (PLAN.md, #87).
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
      // On a runner the same flags, Factory's skills from the agent's home and its own settings (claudeRunnerSettings):
      // the checkout and the temp directory ($FACTORY_IN, $FACTORY_OUT) are its working directories.
      const own = local || runner;
      const pluginDir = local?.claudeDir || runner?.pluginDir;
      const plugin = pluginDir ? ["--plugin-dir", join(pluginDir, "plugin"), "--agents", join(pluginDir, "agents.json")] : [];
      // The package caches are writable to shell commands only, never added directories, whose CLAUDE.md would load.
      const caches = local?.cacheDirs || [];
      const settings = local ? claudeLocalSettings({ domains: local.domains, clone: local.clone, readOnly: local.readOnly, writable: caches, secretEnv: hidden }) : runner ? claudeRunnerSettings({ domains: runner.domains, clone: runner.clone, writable: [runner.clone, runner.agentTmp, runner.cmdTmp, ...runner.caches], readOnly: runner.editDiffs ? [runner.editDiffs] : [], secretEnv: hidden }) : null;
      const dirs = local ? [...(local.clone ? [local.clone] : []), ...local.addDirs.filter((d) => !caches.includes(d)), ...(local.readDirs || [])] : runner ? [runner.clone, runner.agentTmp] : [];
      const perms = settings ? ["--permission-mode", "acceptEdits", "--setting-sources", "", "--strict-mcp-config", "--settings", JSON.stringify(settings), ...plugin, ...dirs.flatMap((d) => ["--add-dir", d])] : ["--dangerously-skip-permissions"];
      const args = ["-p", "--output-format", "stream-json", "--verbose", ...perms, "--exclude-dynamic-system-prompt-sections"];
      if (model) args.push("--model", model);
      if (effort) args.push("--effort", effort);
      if (agent) args.push("--agent", agent);
      if (maxUsd > 0) args.push("--max-budget-usd", String(maxUsd));
      if (resume) args.push("--resume", resume);
      return { cmd: "claude", args, stdin: prompt, canResume: true, env: { ...(compaction ? { CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(compaction) } : {}), ...(cacheTtl ? { CLAUDE_CODE_PROMPT_CACHE_TTL: cacheTtl } : {}), ...(own ? { CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: "1", ...HARNESS_GIT_ENV } : {}), ...(runner ? runnerEnv(runner) : {}) } };
    }
    case "codex": {
      // `codex exec resume <id>` continues a thread; the prompt comes on stdin (`-`) either way.
      const args = resume ? ["exec", "resume", resume] : ["exec"];
      // Locally the developer's own Codex config (MCP servers, plugins, hooks, notify) stays out, as with Claude Code;
      // on a runner its CODEX_HOME is made afresh before every start (codex-runner.mjs), and stays out as well.
      // Every route: the model's commands never see the credentials (SHELL_SECRET_KEYS), CODEX_API_KEY included. Only
      // where there is no agent uid and no local sandbox (a developer's /factory:run) are permissions skipped.
      const perms = local ? ["--ignore-user-config", ...codexLocalConfig({ domains: local.domains, clone: local.clone, addDirs: local.addDirs, readOnly: local.readOnly, secretEnv: hidden })] : runner ? ["--ignore-user-config", ...codexRunnerConfig({ runner, secretEnv: hidden })] : ["--dangerously-bypass-approvals-and-sandbox", "-c", codexShellExclude(hidden)];
      args.push("--json", ...perms, "--skip-git-repo-check");
      // Through the Vercel AI Gateway (`gateway`, codexGatewayOf): its provider, and the model as `openai/<id>` on a
      // resume too, which otherwise falls back to the configured default (a bare id) and changes the thread's model
      // (codex-cli 0.167.0 warns "recorded with model openai/... but is resuming with ...").
      if (gateway) args.push(...codexGatewayArgs(gateway));
      if (model && (!resume || gateway)) args.push("-m", gateway ? gatewayModel(model) : model);
      if (effort) args.push("-c", `model_reasoning_effort=${JSON.stringify(effort)}`);
      if (compaction) args.push("-c", `model_auto_compact_token_limit=${Number(compaction)}`);
      // The session id travels as an extra variable, so a runner's agent uid gets it with the key (runHarness agentExtra).
      const gw = gateway?.session ? { FACTORY_GATEWAY_SESSION: gateway.session } : {};
      return { cmd: "codex", args: [...args, "-"], stdin: prompt, canResume: true, env: local ? { ...HARNESS_GIT_ENV, ...gw } : runner ? { ...HARNESS_GIT_ENV, ...codexRunnerEnv(runner), ...gw } : gw };
    }
    case "copilot": {
      // --allow-all = tools, paths and URLs; required for non-interactive runs. JSONL on stdout; usage to a file.
      // Locally --sandbox puts every command in Copilot's sandbox under the policy in $COPILOT_HOME/settings.json,
      // which the local backend writes (lib/local.mjs copilotLocalSettings); --allow-all then only skips prompts.
      // Its file tools are not OS-sandboxed, so locally path checks stay on: tools and URLs are allowed, paths only in
      // the working directory and the added directories (without --allow-all-paths, any other path is refused headless).
      // The package caches are writable to commands through the policy only: an added directory's .github/agents and
      // .github/skills would load as trusted configuration. --trust-folder is never passed (the clone stays untrusted).
      // On a runner the same: its sandbox under the policy in the COPILOT_HOME Factory makes afresh before every start
      // (copilot-runner.mjs), file tools in the checkout and the agent's temp directory. Only where there is no agent uid
      // and no local sandbox (a developer's /factory:run) is everything allowed.
      const perms = local ? ["--sandbox", "--allow-all-tools", "--allow-all-urls", ...local.addDirs.filter((d) => !(local.cacheDirs || []).includes(d)).flatMap((d) => ["--add-dir", d])] : runner ? copilotRunnerFlags(runner) : ["--allow-all"];
      // Copilot's built-in GitHub MCP server would act with whatever token Copilot holds: always off.
      // The prompt goes on stdin, never `-p <prompt>`: one argv string over 128 KB fails to start on Linux (E2BIG), and
      // without -p a piped stdin is a non-interactive prompt (1.0.107, checked live with 200 KB, fresh and --resume).
      // Every route: the credentials (SHELL_SECRET_KEYS, its own COPILOT_GITHUB_TOKEN included) are removed from its shell
      // and MCP environments, and their values masked in its JSON output. One `=` argument: the flag takes several values.
      const args = [...perms, `--secret-env-vars=${hidden.join(",")}`, "--disable-builtin-mcps", "--output-format", "json"];
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
      return { cmd: "copilot", args, stdin: prompt, canResume: true, env: local ? { ...HARNESS_GIT_ENV } : runner ? { ...HARNESS_GIT_ENV, ...copilotRunnerEnv(runner) } : {} };
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

/**
 * Before a runner's harness start (lib/claude-runner.mjs, lib/codex-runner.mjs, lib/copilot-runner.mjs): the checkout's
 * git state put back as Factory pinned it, then local mode's pre-start clear of the checkout (local.mjs
 * clearHarnessConfig), and the harness's state made afresh, and the sandbox's writable roots made real directories; all
 * as the agent. Codex's and Copilot's sandboxes then run the confinement probe. A failure refuses the start.
 */
export async function runnerClear(harness, runner, env) {
  await restoreRunnerGit(runner.clone, env);
  const cleared = await clearHarnessConfig(runner.clone, (inner) => exec(...backend(env).sandbox.git(inner, env), { env })).catch((e) => {
    throw new GitRefusal("git-clear", e.message);
  });
  if (harness === "codex") {
    await resetCodexState(runner, env);
    await realRoots({ fix: [runner.agentTmp, ...runner.caches], check: [runner.clone] }, runner.agentHome, env);
    runner.present = await presentPaths(runner.clone, env);
    await codexSandboxCheck(runner, env);
    return cleared;
  }
  if (harness === "copilot") {
    await resetCopilotState(runner, env);
    await realRoots({ fix: [runner.agentTmp, ...runner.caches], check: [runner.clone] }, runner.agentHome, env);
    await copilotSandboxCheck(runner, env);
    return cleared;
  }
  await resetClaudeState(runner, env);
  await realRoots({ fix: [runner.agentTmp, runner.cmdTmp, ...runner.caches], check: [runner.clone] }, runner.agentHome, env);
  // Its commands' env file, with a relay for each service the setup started (claude-runner.mjs envFileText).
  writeEnvFile(runner, runner.services);
  if (runner.services.length && !SERVICES_SAID.has(runner.services.join(","))) {
    SERVICES_SAID.add(runner.services.join(","));
    log(`Claude Code's commands reach the services setup started on localhost:${runner.services.join(", ")} through its sandbox's proxy`);
  }
  return cleared;
}
const SERVICES_SAID = new Set();

/**
 * Codex's sandbox, before every start, as the agent and launched as Codex is, with the profile its run gets (`codex
 * sandbox`, no model), running CONFINEMENT_PROBE beside a decoy (codex-runner.mjs DECOY_LAUNCH): no environment the probe
 * can read may show the marker Codex's process and the decoy hold (as a run's Codex and its git processes hold the
 * credential), the agent's home and the checkout's .git/config must refuse a write, the agent's temp directory must
 * take one, and a host off the allow-list must be refused. Where the sandbox does not confine (a Codex release that
 * changed its profile or its namespaces), the stage Blocks before any command runs. Where it does not start, it is
 * tried once more (a start that failed once, a timeout); a second failure Blocks. Codex itself would only fail each
 * command. The probe uses `codex sandbox`, the run `codex exec`: the same profile and sandbox code, but not the same
 * entry point (docs/PLAN.md names this).
 */
/** The probe's own rule texts, the only ones a Blocked comment repeats (a host is named by its kind, not by the probe). */
const RULES = new Set(["the decoy outside the sandbox is readable", "the credential stand-in is readable in a process environment", "the agent home is writable", "the agent temp directory is not writable", "the checkout's .git/config is writable", "no curl or node to check the network rule"]);
const ruleOf = (said) => (RULES.has(said) ? said : /^[a-z0-9.-]+, off the allow-list, is reachable$/.test(said) ? "a host off the allow-list is reachable" : "an unknown rule");
export async function codexSandboxCheck(runner, env, { run = exec } = {}) {
  let last = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const marker = randomBytes(16).toString("hex");
    const probe = ["sandbox", ...codexRunnerConfig({ runner, secretEnv: [] }), "--", "/bin/sh", "-c", CONFINEMENT_PROBE, "sh", runner.agentHome, join(runner.clone, ".git", "config"), runner.agentTmp, offListHost(runner.domains), marker];
    const [cmd, args] = runnerLaunch(runner, "/bin/sh", ["-c", DECOY_LAUNCH, "sh", ...probe], env.PATH);
    const r = await run(cmd, args, { cwd: runner.clone, env: { ...env, ...codexRunnerEnv(runner), [PROBE_MARKER]: marker }, agentExtra: ["CODEX_HOME", PROBE_MARKER], timeoutMs: 120_000 }).catch((e) => ({ code: null, stdout: "", stderr: e.message }));
    if (r.code === 4) {
      const said = String(r.stdout).trim().split("\n").at(-1) || "";
      throw new GitRefusal("sandbox", `Codex's sandbox does not confine: ${said.slice(0, 200)}`, { rule: ruleOf(said) });
    }
    if (r.code === 0 && !r.timedOut) return;
    last = r;
    if (attempt === 1) log(`Codex's sandbox probe did not run (${r.timedOut ? "timed out" : `exit ${r.code}`}); trying once more`);
  }
  throw new GitRefusal("sandbox", `Codex's sandbox could not start here: ${String(last.stderr).trim().split("\n").at(-1)?.slice(0, 300) || (last.timedOut ? "timed out" : `exit ${last.code}`)}`);
}

/**
 * Copilot's sandbox, before every start, as the agent and launched as Copilot is (its flags, its HOME, PATH and unit),
 * with the run's settings in a COPILOT_HOME of its own. Copilot has no command that runs one command in its sandbox, so
 * the probe is a Copilot session against a model on this machine's loopback (copilot-runner.mjs probeModel: no network,
 * no bill) that asks for one shell call, CONFINEMENT_PROBE beside a decoy, as for Codex: no environment the probe can
 * read may show the marker Copilot and the decoy hold (as a run's Copilot holds the token: the bubblewrap Copilot starts
 * holds it too unless Factory's shim cleared it), nothing the probe makes in the agent's home may be there afterwards,
 * the checkout's .git/config must refuse a write, the agent's temp directory take one, and a host off the allow-list be
 * refused. A broken rule Blocks; a probe that left no result (Copilot's sandbox did not start, a timeout) is tried once
 * more, then Blocks.
 */
export async function copilotSandboxCheck(runner, env, { run = exec, model = probeModel } = {}) {
  let last = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    await resetProbe(runner, env);
    const marker = probeMarker();
    const mock = await model();
    const flags = [...copilotRunnerFlags(runner), `--secret-env-vars=${[...SHELL_SECRET_KEYS, PROBE_MARKER].join(",")}`, "--disable-builtin-mcps", "--output-format", "json"];
    const [cmd, args] = copilotLaunch(runner, "/bin/sh", ["-c", COPILOT_DECOY_LAUNCH, "sh", ...flags], env.PATH);
    const childEnv = { ...env, ...HARNESS_GIT_ENV, ...mock.env, ...probeEnv(runner, marker, offListHost(runner.domains)) };
    const extra = [...Object.keys(mock.env), ...Object.keys(probeEnv(runner, marker, "")), ...Object.keys(HARNESS_GIT_ENV)];
    // As a run's Copilot: in a unit bubblewrap can start in (claude-runner.mjs asClaudeAgent).
    const [c, a, e] = agentUser() ? asClaudeAgent(cmd, args, childEnv, extra, runner.clone) : [cmd, args, childEnv];
    const r = await run(c, a, { cwd: runner.clone, env: e, input: "Run the one command you are given.", agentExtra: extra, timeoutMs: 180_000 }).catch((err) => ({ code: null, stdout: "", stderr: err.message }));
    const said = mock.toolOutput?.() || "";
    await mock.close();
    const got = await probeResult(runner, env);
    if (got.code === 4) throw new GitRefusal("sandbox", `Copilot's sandbox does not confine: ${got.said.slice(0, 200)}`, { rule: ruleOf(got.said), harness: "copilot" });
    if (got.code === 0) return;
    // For the log: what Copilot answered for the probe's call (the sandbox's own reason where it did not start).
    last = { ...r, said: said.replace(/\s+/g, " ").trim() };
    if (attempt === 1) log(`Copilot's sandbox probe did not run (${r.timedOut ? "timed out" : got.code === null ? `no result, exit ${r.code}` : `exit ${got.code}`}); trying once more`);
  }
  const why = last.code === 5 ? "the probe's decoy did not come up" : last.said ? `its command did not run: ${last.said.slice(0, 400)}` : last.timedOut ? "timed out" : `no result, exit ${last.code}: ${String(last.stderr || "").trim().split("\n").at(-1)?.slice(0, 300) || ""}`;
  throw new GitRefusal("sandbox", `Copilot's sandbox could not start here: ${why}`, { harness: "copilot" });
}

/**
 * Run the harness once; see runOnce. A Codex resume the provider refused because the thread was written through another
 * credential (usage.mjs rotatedPin: an AI Gateway pin that moved between passes) runs once more as a fresh thread with
 * the caller's `freshPrompt` (the full prompt a fresh run needs) and a log line; never twice. Only with a `freshPrompt`:
 * a resumed prompt alone (the exit-record ask's) would start a fresh thread with no context, so without one the refusal
 * stands and the stage Blocks with it.
 */
export async function runHarness(opts) {
  const rec = await runOnce(opts);
  if (!opts.resume || !rec.pinRotated || typeof opts.freshPrompt !== "string" || !opts.freshPrompt) return rec;
  log(`${opts.label || "run"}: the provider refused to resume ${opts.resume.slice(0, 8)} (${rec.refusal ? refusalFields(rec.refusal) : "rotated credential"}): its thread was written through another credential; running a fresh thread once`);
  const fresh = await runOnce({ ...opts, resume: null, prompt: opts.freshPrompt });
  return { ...fresh, resumeRefused: { session: opts.resume, ...(rec.refusal ? { status: rec.refusal.status, type: rec.refusal.type, code: rec.refusal.code } : {}) } };
}

async function runOnce({ harness, model, prompt, maxUsd, resume, agent, cwd, env: given, timeoutMs, eventsFile, label = "run", effort, onLine = null, onResume = null, idleMs = HARNESS_IDLE_MS, signal = null }) {
  // The worker's shell secrets (lib/worker-secrets.mjs): out of every env here but the harness child's own.
  const { shell, env } = takeShellSecrets(given);
  const shellSecrets = Object.keys(shell);
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
  // A runner's Claude Code gets the same pre-start clear, as the agent: its own git and the checkout's protected paths
  // (local.mjs prepareClone) are what its sandbox guards.
  // A runner's Codex and Copilot: their own sandboxes, and the same clear before each start (lib/codex-runner.mjs,
  // lib/copilot-runner.mjs).
  const runner = claudeRunner({ harness, agent: agentUid, clone: cwd, env }) || codexRunner({ harness, agent: agentUid, clone: cwd, env }) || copilotRunner({ harness, agent: agentUid, clone: cwd, env });
  const cleared = runner ? await runnerClear(harness, runner, scrubbedEnv(env)) : await backend(env).sandbox.beforeHarness(scrubbedEnv(env));
  const cacheTtl = promptCacheTtl(harness, env);
  const creditUsd = copilotCreditUsd();
  // Copilot takes no cap under 30 AI credits: with less than that left, no Copilot run starts (the caller Blocks on the
  // budget), rather than one capped above what is left.
  if (harness === "copilot" && maxUsd > 0 && maxUsd < COPILOT_MIN_CREDITS * creditUsd) {
    const now = new Date().toISOString();
    log(`${label}: $${maxUsd} left is under Copilot's ${COPILOT_MIN_CREDITS}-credit minimum cap; not starting the run`);
    return { ...parseUsage(harness, "", model || null, 0, { creditUsd }), label, usd: 0, ok: false, budgetExceeded: true, error: "dollar cap reached", basis: `no run: $${maxUsd} left is under Copilot's ${COPILOT_MIN_CREDITS}-credit minimum cap`, started: now, ended: now, finalText: "", timedOut: false, exitCode: null, signal: null, idle: false, stdoutTail: "", stderrTail: "" };
  }
  const { cmd, args, stdin, env: extraEnv } = harnessCommand({ harness, model, prompt, maxUsd, resume, agent, usageFile, effort, compaction, cacheTtl, creditUsd, local: backend(env).sandbox.harness(env), runner, shellSecrets, gateway: codexGatewayOf(harness, env) });
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
  const childEnv = { ...env, ...extraEnv, ...shell };
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
  // A runner's harness: Factory's HOME for it, its own TMPDIR and a PATH with nothing of the agent's home
  // (claude-runner.mjs runnerLaunch; Copilot's with Factory's bwrap first, copilot-runner.mjs copilotLaunch).
  const [runCmd, runArgs] = outer ? ["srt", ["-s", outer, "--", "env", `TMPDIR=${childEnv.TMPDIR || ""}`, cmd, ...args]] : runner && harness === "copilot" ? copilotLaunch(runner, cmd, args, childEnv.PATH) : runner ? runnerLaunch(runner, cmd, args, childEnv.PATH) : [cmd, args];
  // Its stdout and stderr are files, never pipes (proc.mjs fileStdio): a pipe another process in the chain made
  // non-blocking (srt's Node does) crashed Codex on EAGAIN mid-pass (#2649).
  const agentExtra = [...MODEL_SECRET_KEYS, ...Object.keys(extraEnv), ...shellSecrets, "COPILOT_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR"];
  // A runner's Claude Code and Copilot: as the agent, in a unit bubblewrap can start in (claude-runner.mjs asClaudeAgent).
  // Codex: as the agent in the usual unit (its sandbox starts there: checked on both launchers).
  const [execCmd, execArgs, execEnv] = runner && (harness === "claude" || harness === "copilot") ? asClaudeAgent(runCmd, runArgs, childEnv, agentExtra, cwd) : [runCmd, runArgs, childEnv];
  const r = await exec(execCmd, execArgs, { cwd, env: execEnv, input: stdin, timeoutMs, tee: eventsFile, echo: true, onLine, idleMs, signal, agentExtra, group: backend(env).name === "local", fileStdio: true });
  await backend(env).sandbox.reap();
  const ended = new Date().toISOString();
  // A runner's Claude Code or Codex session, captured before anything else runs as the agent: the next start and the
  // stage's saved transcript use this copy, never what the agent's home holds by then.
  const ranSession = runner || harness === "codex" ? parseUsage(harness, r.stdout, model || null, r.code ?? 1, {}).sessionId : null;
  if (runner && ranSession) await captureSession(runner, ranSession, scrubbedEnv(env));
  // Codex's sub-agent threads (codex-threads.mjs), read from their rollouts now: on a runner each is captured as the
  // run's own session is, before anything else runs as the agent.
  const found = harness === "codex" && ranSession ? await subAgentThreads(ranSession, runner, runner ? scrubbedEnv(env) : childEnv, { label }) : { threads: [], missed: [] };
  // Only a regular file the harness wrote is read (in the outer sandbox's folder, a link could point anywhere).
  let usagePath = usageFile && outer && !lstatSync(usageFile, { throwIfNoEntry: false })?.isFile() ? undefined : usageFile;
  if (agentUid && usageFile) {
    const got = (await readAgentFiles(agentUid.tmp, [usageName], env)).files[usageName];
    usagePath = join(dirname(eventsFile), usageName);
    if (got !== undefined) writeNew(usagePath, got);
  }
  const reported = parseUsage(harness, r.stdout, model || null, r.code ?? 1, { usageFile: usagePath, creditUsd });
  // Each sub-agent thread's own share joins the pass's record, so the caps count it from this pass on; the share is its
  // running total less the one already counted (an earlier pass, or the stage that saved a restored thread).
  const counted = withSubAgents(prior ? sinceSession(reported, prior) : reported, found.threads, (id) => SESSION_TOTALS.get(id) ?? null);
  const rec = counted.rec;
  for (const [id, total] of Object.entries(counted.totals)) SESSION_TOTALS.set(id, total);
  // Threads this run may have spawned that were not read (a rollout absent, too large or unreadable, the read limit),
  // or sub-agent work in the stream with no thread read at all: the dollars are a lower bound, and the log says why. A
  // thread already counted whose rollout is gone (a runner restores only the lineage's own) is no miss, nor is the
  // run's own rollout missing (its stream's sub-agent work with no thread read is caught below).
  const missed = found.missed.filter((m) => m.id !== ranSession && !(m.id && m.why === "no rollout" && SESSION_TOTALS.has(m.id)));
  if (harness === "codex" && (missed.length || (reported.subAgentWork && !found.threads.length))) {
    rec.usdLowerBound = true;
    log(`${label}: Codex sub-agent spend may be missing, so the dollars are a lower bound (${missed.length ? missed.slice(0, 3).map((m) => `${m.id ? m.id.slice(0, 8) : "threads"}: ${m.why}`).join("; ") : "its stream shows sub-agent work but no sub-agent thread was read"})`);
  }
  // Every thread this run's lineage has spawned so far, with its running total: kept with the session's total, so a
  // later stage that resumes the session never counts them again (session.mjs restoreTranscript).
  const children = Object.assign(Object.create(null), prior?.children ?? {}, counted.totals);
  const withChildren = (t) => ({ ...t, ...(Object.keys(children).length ? { children: { ...children } } : {}) });
  // A pass with no result line (killed, crashed) reports no total; the session's last good one stays, with every
  // thread counted so far, so a later stage counts neither the session nor its threads again.
  if (RUNNING_TOTALS.has(harness) && reported.sessionId && reported.usd !== null) {
    const total = withChildren({ usd: reported.usd, tokens: reported.tokens, models: reported.models, premiumRequests: reported.premiumRequests, aiu: reported.aiu, sessionStartTime: reported.sessionStartTime });
    SESSION_TOTALS.set(reported.sessionId, total);
    // The session's running total as Factory read it (for Copilot the larger of the usage file and the stream), kept in
    // the usage record so a later stage that restores the session bounds its saved total by it (session.mjs writeUsage).
    rec.sessionTotal = total;
  } else if (RUNNING_TOTALS.has(harness) && reported.sessionId) {
    const last = SESSION_TOTALS.get(reported.sessionId) ?? null;
    const kept = last ? withChildren(last) : Object.keys(children).length ? withChildren({ usd: null, tokens: null }) : null;
    if (last) SESSION_TOTALS.set(reported.sessionId, kept);
    if (kept) rec.sessionTotal = kept;
    else delete rec.sessionTotal;
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

/**
 * The sub-agent threads under a Codex run's thread (codex-threads.mjs codexThreads): `{threads, missed}`. Locally (and
 * in a developer's own run) their rollouts are read where Codex wrote them (its CODEX_HOME in `env`). On a runner each
 * named thread's files are archived as the agent and read from the archive; the run's own is the copy just captured.
 * Each counted thread's archive is captured too: put back on the next reset (a resumed parent finds its children) and
 * saved with the stage's transcript (session.mjs saveAgentTranscript). Never throws: a failure is a miss.
 */
export async function subAgentThreads(threadId, runner, env, { label = "run" } = {}) {
  try {
    if (!runner) return await codexThreads(localRollouts(codexSessionRoot(env)), threadId);
    const archives = new Map();
    const read = async (id) => {
      // The archive holds the one file, so its length bounds the text.
      const cap = MAX_ROLLOUT_BYTES + 1024 * 1024;
      const a = id === threadId ? capturedSession(id) : await archiveSession(runner, id, env, { timeoutMs: THREAD_READ_MS, maxBytes: cap });
      if (!a) return null;
      if (a.truncated || a.tar.length > cap) return { skip: `over ${MAX_ROLLOUT_BYTES} bytes` };
      if (a.files.length !== 1) return { skip: "more than one rollout" };
      const t = await exec("tar", ["-xOf", "-"], { env, input: a.tar, timeoutMs: THREAD_READ_MS });
      if (t.code !== 0 || t.timedOut) return { skip: t.timedOut ? "unpacking timed out" : "unpacking failed" };
      archives.set(id, a);
      return { text: String(t.stdout) };
    };
    const found = await codexThreads(read, threadId);
    for (const t of found.threads) if (archives.get(t.id)) keepSession(t.id, archives.get(t.id));
    return found;
  } catch (e) {
    log(`${label}: Codex's sub-agent threads could not be read (${String(e?.message || e).slice(0, 160)})`);
    return { threads: [], missed: [{ id: null, why: "the read failed" }] };
  }
}
/** How long one sub-agent rollout's archive or unpacking may take. */
const THREAD_READ_MS = 120_000;

/** Tests: forget every running total this process has seen (a fresh process, as a later stage is). */
export const dropSessionTotals = () => SESSION_TOTALS.clear();

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
