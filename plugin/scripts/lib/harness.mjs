// Launch a harness headless, with the task card as the prompt and a wall clock,
// and turn what it printed into one usage record. CLI flags follow RESEARCH.md;
// what RESEARCH.md leaves open is recorded in NOTES.md.
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { exec, onPath } from "./proc.mjs";
import { parseUsage } from "./usage.mjs";
import { claudeLocalSettings, localSandbox } from "./local.mjs";

export const CLI = {
  claude: { bin: "claude", pkg: "@anthropic-ai/claude-code" },
  codex: { bin: "codex", pkg: "@openai/codex" },
  copilot: { bin: "copilot", pkg: "@github/copilot" },
};

/** Keys that must never reach a child that is not the harness (validation commands, git hooks). */
export const MODEL_SECRET_KEYS = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "CODEX_API_KEY", "OPENAI_API_KEY", "COPILOT_GITHUB_TOKEN"];
/** Runner credentials a child could turn into a model or App credential; the harness gets its own credential instead. */
export const RUNNER_SECRET_KEYS = ["ACTIONS_ID_TOKEN_REQUEST_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_URL", "ACTIONS_RUNTIME_TOKEN", "FACTORY_APP_TOKEN", "FACTORY_APP_PRIVATE_KEY", "FACTORY_APP_ID"];

/**
 * Env for a non-harness child (and the harness itself, before its own credential is added): the
 * job's env with every secret removed. An `extra` value of undefined or null removes that key.
 */
export function scrubbedEnv(base = process.env, extra = {}) {
  const e = { ...base, ...extra };
  for (const k of [...MODEL_SECRET_KEYS, ...RUNNER_SECRET_KEYS]) delete e[k];
  for (const k of Object.keys(e)) if (e[k] === undefined || e[k] === null) delete e[k];
  for (const k of Object.keys(e)) if (/^FACTORY_INPUT_(APP_ID|APP_PRIVATE_KEY|ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|CODEX_API_KEY|GITHUB_TOKEN|ANTHROPIC_OIDC_EXCHANGE_URL)$/.test(k)) delete e[k];
  return e;
}

/**
 * The credential each harness child gets, and nothing else. Returns {env, basis}
 * or throws when the configured credential is absent.
 *   claude  api : ANTHROPIC_API_KEY, or a federated short-lived token (see federate())
 *           plan: CLAUDE_CODE_OAUTH_TOKEN (a developer's own repository only)
 *   codex   api : CODEX_API_KEY, set on this child only
 *   copilot     : COPILOT_GITHUB_TOKEN = the job's GITHUB_TOKEN (copilot-requests: write),
 *                 which wins over GH_TOKEN so the App token is never billed for Copilot
 *   any   login : the CLI's own login on this machine (PLAN.md's development fallback:
 *                 "the worker run locally uses whatever the CLI is logged in as");
 *                 refused inside Actions, where only API credentials run unattended.
 *                 Outside Actions, `api` with no key present falls back to it with a warning,
 *                 so a local run needs no credential configuration at all.
 */
export function hasApiCredential({ harness, inputs, env = process.env }) {
  if (harness === "claude") return !!(inputs.anthropicApiKey || env.ANTHROPIC_API_KEY || (env.ACTIONS_ID_TOKEN_REQUEST_URL && inputs.anthropicOidcExchangeUrl));
  if (harness === "codex") return !!(inputs.codexApiKey || env.CODEX_API_KEY);
  if (harness === "copilot") return !!(env.COPILOT_GITHUB_TOKEN || inputs.githubToken);
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
    const tok = env.COPILOT_GITHUB_TOKEN || inputs.githubToken;
    if (!tok) throw new Error("no Copilot credential: the job token needs copilot-requests: write");
    out.COPILOT_GITHUB_TOKEN = tok;
    return { env: out, basis: env.COPILOT_GITHUB_TOKEN ? "COPILOT_GITHUB_TOKEN" : "job token (copilot-requests: write)" };
  }
  throw new Error(`unknown harness ${harness}`);
}

/**
 * Workload identity federation: exchange the job's OIDC token for a short-lived
 * Anthropic credential. The exchange endpoint is an input because its URL is not
 * in RESEARCH.md; without it this returns null and the caller asks for a key.
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
  if (env.GITHUB_ACTIONS) process.stdout.write(`::add-mask::${key}\n`);
  return key;
}

/**
 * The command line for one run. `resume` is the session id of the run to continue
 * (Claude --resume, Codex exec resume, Copilot --resume); `agent` names a pinned
 * agent definition to run as (Claude --agent, Copilot --agent; Codex has no flag,
 * so the prompt names the file). `usageFile` is where Copilot writes its final usage.
 */
export function harnessCommand({ harness, model, prompt, maxUsd, resume, agent, usageFile, effort, local = null }) {
  // Local mode (a developer's box): Claude Code runs in its own sandbox; the other harnesses' local
  // sandboxes are not wired yet, so they refuse rather than run with a disposable runner's permissions.
  if (local && harness !== "claude") throw new Error(`local mode runs the claude harness in this release; ${harness} on a developer box is not sandboxed yet`);
  switch (harness) {
    case "claude": {
      // One cached system-prompt prefix for every worker and reviewer on identical checkouts: the per-machine
      // sections (the auto-memory path) move into the first user message instead of the system prompt.
      // On a runner the VM is disposable, so permissions are skipped; on a developer's box edits stay in the
      // working directory and the added directories, and shell commands run in Claude Code's sandbox.
      // The developer's own user settings, plugins and MCP servers stay out (a runner has none): only the
      // repository's settings and Factory's own apply.
      const perms = local ? ["--permission-mode", "acceptEdits", "--setting-sources", "project,local", "--strict-mcp-config", "--settings", JSON.stringify(claudeLocalSettings({ domains: local.domains, clone: local.clone, readOnly: local.readOnly })), ...local.addDirs.flatMap((d) => ["--add-dir", d])] : ["--dangerously-skip-permissions"];
      const args = ["-p", "--output-format", "stream-json", "--verbose", ...perms, "--exclude-dynamic-system-prompt-sections"];
      if (model) args.push("--model", model);
      if (effort) args.push("--effort", effort);
      if (agent) args.push("--agent", agent);
      if (maxUsd > 0) args.push("--max-budget-usd", String(maxUsd));
      if (resume) args.push("--resume", resume);
      return { cmd: "claude", args, stdin: prompt, canResume: true };
    }
    case "codex": {
      // `codex exec resume <id>` continues a thread; the prompt comes on stdin (`-`) either way.
      const args = resume ? ["exec", "resume", resume] : ["exec"];
      args.push("--json", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check");
      if (model && !resume) args.push("-m", model);
      return { cmd: "codex", args: [...args, "-"], stdin: prompt, canResume: true };
    }
    case "copilot": {
      // --allow-all = tools, paths and URLs; required for non-interactive runs. JSONL on stdout; usage to a file.
      const args = ["-p", prompt, "--allow-all", "--output-format", "json"];
      if (model) args.push("--model", model);
      if (agent) args.push("--agent", agent);
      if (resume) args.push("--resume", resume);
      if (usageFile) args.push("--usage-output-file", usageFile);
      return { cmd: "copilot", args, stdin: undefined, canResume: true };
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

/** The installed CLI version (`<cmd> --version`, first line), so a cost change can be told from a CLI update; null when unknown. */
export function harnessVersion(harness) {
  const cmd = { claude: "claude", codex: "codex", copilot: "copilot" }[harness];
  if (!cmd) return null;
  try {
    return execFileSync(cmd, ["--version"], { encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "ignore"] }).trim().split(/\r?\n/)[0] || null;
  } catch {
    return null;
  }
}

export async function runHarness({ harness, model, prompt, maxUsd, resume, agent, cwd, env, timeoutMs, eventsFile, label = "run", effort, onLine = null, idleMs = HARNESS_IDLE_MS }) {
  const usageFile = harness === "copilot" && eventsFile ? join(dirname(eventsFile), `copilot-usage-${label}.json`) : undefined;
  const { cmd, args, stdin } = harnessCommand({ harness, model, prompt, maxUsd, resume, agent, usageFile, effort, local: localSandbox(env) });
  if (!(await onPath(cmd))) throw new Error(`${cmd} is not on PATH (npm install -g ${CLI[harness].pkg})`);
  if (eventsFile) {
    mkdirSync(dirname(eventsFile), { recursive: true });
    appendFileSync(eventsFile, `${JSON.stringify({ type: "factory.run", label, harness, model: model || null, started: new Date().toISOString(), resume: !!resume })}\n`);
  }
  const started = new Date().toISOString();
  const r = await exec(cmd, args, { cwd, env, input: stdin, timeoutMs, tee: eventsFile, echo: true, onLine, idleMs });
  const ended = new Date().toISOString();
  const rec = parseUsage(harness, r.stdout, model || null, r.code ?? 1, { usageFile });
  rec.label = label;
  rec.finalText = finalText(harness, r.stdout);
  rec.started = started;
  rec.ended = ended;
  rec.timedOut = r.timedOut;
  rec.exitCode = r.code;
  rec.signal = r.signal;
  rec.idle = !!r.idle;
  if (r.timedOut) {
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
  if (eventsFile) appendFileSync(eventsFile, `${JSON.stringify({ type: "factory.run.end", label, ended, ok: rec.ok, exitCode: r.code, timedOut: r.timedOut, usd: rec.usd })}\n`);
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
