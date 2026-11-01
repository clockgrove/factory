/**
 * The Codex Worker: one Work Item's implementation turn through the Codex
 * SDK and the operator's `codex login`. Shell commands and edits run in
 * Codex's own sandbox under Factory's permission profile (workspace
 * writable, `.git` read-only, network host or off), not in Factory's
 * bubblewrap. Validate, which runs the item's declared commands through
 * `validateTree` on a snapshot commit of its current files as the Claude
 * and Copilot workers' does, is served to Codex as an MCP tool
 * (codex-validate.ts); Factory's validation still decides. The worker is
 * told to edit through Codex's apply_patch (`CODEX_EDIT_CALL`), and asked
 * again about a scripted rewrite that changed nothing (work/scripted-edits.ts).
 * Factory collects and commits the result.
 */
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ThreadEvent, ThreadItem } from "@openai/codex-sdk";
import type { SandboxConfig } from "../config.js";
import { errored } from "../engine.js";
import { redact } from "../log.js";
import type { WorkItem } from "../planning/types.js";
import {
  gitMetadata,
  LaunchedGroup,
  namespaceRefused,
  packageCacheEnvironment,
  ROOT_REFUSAL,
  readOnlyMounts,
  runsAsRoot,
  toolchainDirectories,
} from "../sandbox.js";
import { errorMessage } from "../text.js";
import { HeadRewrites, SCRIPTED_EDITS } from "../work/scripted-edits.js";
import {
  FinishRequests,
  type SelfValidateOptions,
  selectedMediaNote,
  validateFailed,
} from "../work/self-validate.js";
import {
  AttemptServices,
  servicesHold,
  servicesNote,
} from "../work/services.js";
import { COLLECTED_RESULT, shellDependencies } from "../work/validate-tool.js";
import {
  ACTIVITY_INTERVAL_MS,
  spendStopped,
  type Worker,
  type WorkerInput,
  type WorkerResult,
} from "../work/worker.js";
import { workerToolchainPath } from "../worktree.js";
import {
  type CodexEffort,
  codexFailure,
  codexHomeOf,
  codexLauncher,
  codexRuntimeDirectory,
  codexStderr,
  privateCodexHome,
  saveModelsCache,
  trimCodexHome,
} from "./codex.js";
import { CodexStderr, withStderr } from "./codex-stderr.js";
import {
  addCodexTelemetry,
  type CodexBaseline,
  codexBaseline,
  codexLiveRecord,
  codexSessionRecord,
  codexTelemetry,
  codexTokens,
  codexTurnUsage,
  modelItem,
  SDK_OPERATIONS,
  turnTokens,
} from "./codex-telemetry.js";
import { CODEX_VALIDATE_CALL, CodexValidate } from "./codex-validate.js";
import {
  detail,
  IdleWatchdog,
  type ModelChoice,
  PlannerError,
  providerOutcome,
} from "./planner.js";
import {
  openTurn,
  ResumeOverflow,
  type Turn,
  turnFields,
  withoutPrevious,
} from "./session.js";
import {
  captureRequest,
  captureResponse,
  describeRequest,
  firstToken,
  logUsage,
  Tallies,
  type Tokens,
  usageRecord,
} from "./usage.js";

export const DEFAULT_CODEX_WORKER_MODEL: ModelChoice<CodexEffort> = {
  model: "gpt-6.1-sol",
  effort: "medium",
};

/** A healthy turn can be silent this long: exec JSON emits no reasoning deltas. */
const WORKER_IDLE_MS = 15 * 60 * 1000;

export interface CodexWorkerOptions {
  /** The provider's `worker` model, effort and serviceTier, resolved (selection.ts resolvedProvider). */
  model: ModelChoice<CodexEffort>;
  /**
   * `required`, `readOnlyPaths` (read grants) and `environment` (the
   * shell's variables) apply: Codex sandboxes its own shell.
   */
  sandbox: SandboxConfig;
  /** The shell's network; `off` (the default) or the host's. */
  network?: "host" | "off";
  /** Operator variables the worker's shell may see, by name. */
  allowedSecretNames?: readonly string[];
  /** Values its reported commands and errors are redacted of (config.secrets). */
  secrets?: readonly string[];
  /** Turns Codex child agents off, for a prompt that says they are. */
  childAgents?: "disabled";
  idleMs?: number;
  /**
   * What Validate needs: the plan, its pins and the validation settings.
   * Absent: no Validate and no handoff check.
   */
  validation?: SelfValidateOptions;
}

/**
 * How a Codex worker edits files (#2283). Codex's apply_patch is a nested
 * tool of code mode's `exec` under this configuration, declared in exec's
 * description, and its edits come back as `file_change` items: a probe of
 * gpt-6.1-sol on Codex 0.160 with this worker home, asked for a one-line
 * edit, called `tools.apply_patch`. Live (0.5.12) workers still edited
 * through Python heredocs' `str.replace`, whose misses fail silently, and
 * no edit was counted. So the worker is told to use it, and how, as for
 * Validate (codex-validate.ts `CODEX_VALIDATE_CALL`).
 */
export const CODEX_EDIT_CALL = `Edit files with Codex's apply_patch tool: it fails when a patch's context lines don't match the file, instead of changing nothing. Inside exec, call it as \`text(await tools.apply_patch("*** Begin Patch\\n*** Update File: path/to/file\\n@@\\n-old line\\n+new line\\n*** End Patch"));\`; where your tools list apply_patch directly, call it there. ${SCRIPTED_EDITS}`;

/** Requests a Codex worker gets about a scripted rewrite that changed nothing (#2283). */
const MAX_REWRITE_REQUESTS = 2;

/**
 * The truth about the worker's own shell, after its prompt (#1647, #2156):
 * Codex's sandbox, not Factory's validation environment. Live (#800), a
 * Codex worker without Validate tried `pnpm install` in it, found no
 * registry, and its repair ended with an operator question about an
 * environment working as designed.
 */
export function codexShellNote(
  network: boolean,
  validating: boolean,
  item: WorkItem,
  /** The attempt's services: only with the network (CodexWorker `services`). */
  services: Pick<SandboxConfig, "services"> = {},
): string {
  const reach = network
    ? "It shares the host's network."
    : "It has no network: no package registry, and no service on the host's loopback.";
  const check = validating
    ? `Your Validate tool runs this Work Item's declared validation commands as Factory will: the exact locked install, then each command, in Factory's validation sandbox, on a commit of your current files made as Factory collects them. It is how you check your work: use it instead of installing dependencies or running those commands in your shell, fix what it reports, and finish only after it passes on your final files. ${CODEX_VALIDATE_CALL}`
    : "You have no tool that runs the declared validation: Factory runs it after you finish.";
  return `\n\nYour shell runs in Codex's sandbox, which differs from Factory's validation environment. ${reach} ${shellDependencies(network)} Your checkout's .git is read-only. You have a private writable $TMPDIR but no /tmp or /var/tmp; Factory's validation has a writable /tmp.${servicesNote(services)} ${COLLECTED_RESULT} ${check} If Factory's validation fails after you finish, the failure comes back to you with the command's output. When a command fails in your shell only because of this environment (no network, no installed dependencies, no /tmp, a read-only .git), it is no defect: do not change files, propose ownership or ask for another environment for that alone; ${validating ? "check with Validate instead" : "report the command and why"}. Factory's validation still decides.${validating ? selectedMediaNote(item) : ""}\n\n${CODEX_EDIT_CALL}`;
}

const real = (path: string) => realpathSync(path);

/** A classified Codex failure as the Worker's outcome (planner.ts providerOutcome). */
const outcome = (error: PlannerError): WorkerResult => providerOutcome(error);

interface WorkerHome {
  root: string;
  /** The launcher the SDK spawns: it runs codex as its own process group. */
  launcher: string;
  /** Where the launcher records that group. */
  pidFile: string;
  /** Codex's standard error (codex.ts codexStderr). */
  stderr: string;
  env: Record<string, string>;
}

/** The proxy variables Codex keeps for itself (codex.ts ENVIRONMENT). */
const PROXY = /^(?:HTTPS?|NO|ALL)_PROXY$/i;

/**
 * The worker shell's environment: sandbox.environment's variables except
 * Factory's own, and of the proxy variables Codex keeps to reach its API,
 * nothing when the shell has no network; with network, each URL (one
 * without a scheme read as http://) without its user name and password (a
 * URL that doesn't parse is left out), so the shell never holds a proxy
 * credential. OPENAI_API_KEY and CODEX_API_KEY are always excluded.
 */
function shellPolicy(
  source: NodeJS.ProcessEnv,
  network: boolean,
  configured: Record<string, string>,
  factory: readonly string[],
): string {
  const set: string[] = [];
  // Codex's own API keys stay with Codex, whatever its default excludes are.
  const exclude: string[] = ["OPENAI_API_KEY", "CODEX_API_KEY"];
  for (const [name, value] of Object.entries(source)) {
    if (!PROXY.test(name) || value === undefined) continue;
    if (!network) {
      exclude.push(name);
      continue;
    }
    if (/^no_proxy$/i.test(name)) continue;
    let url: URL;
    try {
      // curl, pip and npm read a proxy without a scheme as http://.
      url = new URL(
        /^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `http://${value}`,
      );
    } catch {
      exclude.push(name);
      continue;
    }
    if (!url.username && !url.password) continue;
    url.username = "";
    url.password = "";
    set.push(`${JSON.stringify(name)} = ${JSON.stringify(url.href)}`);
  }
  // sandbox.environment, as for Factory's sandbox: Factory's own variables win.
  for (const [name, value] of Object.entries(configured))
    if (!factory.includes(name) && !PROXY.test(name))
      set.push(`${JSON.stringify(name)} = ${JSON.stringify(value)}`);
  return `
[shell_environment_policy]
inherit = "all"
exclude = ${JSON.stringify(exclude)}
${set.length ? `\n[shell_environment_policy.set]\n${set.join("\n")}\n` : ""}`;
}

/**
 * A private CODEX_HOME, HOME and TMPDIR for one turn, with Factory's
 * permission profile and a link to the operator's subscription login.
 * Shell commands see only the platform paths Codex calls `:minimal`, the
 * Codex runtime, the PATH's toolchains, sandbox.readOnlyPaths and the
 * worktree's own git metadata read-only, the private HOME and TMPDIR, the
 * attempt's services directory read-only, and the worktree with its `.git`
 * entry read-only. Not the operator's HOME, logins, SSH keys or gh config,
 * Factory's state, nor the rest of the checkout's git directory. Throws a
 * setup problem; the caller holds with it. The worker, readiness's probe
 * and the tests of Validate start Codex in it.
 */
export function codexWorkerHome(
  worktree: string,
  network: boolean,
  keep: readonly string[],
  sandbox: Pick<SandboxConfig, "readOnlyPaths" | "environment">,
  /** A retained conversation's home (privateCodexHome `root`). */
  root?: string,
  /** Validate's MCP server registration (codex-validate.ts CodexValidate.config). */
  mcp = "",
  /** The attempt's services (work/services.ts): their directory read, their variables set. */
  services?: Pick<AttemptServices, "root" | "environment">,
): WorkerHome {
  const workspace = real(worktree);
  const source: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: workerToolchainPath(process.env.PATH),
  };
  const runtime = codexRuntimeDirectory();
  const readOnly = readOnlyMounts(sandbox.readOnlyPaths, workspace);
  return privateCodexHome({
    ...(root && { root }),
    outside: { directory: workspace, name: "worktree" },
    source,
    keep,
    config: ({ home, temporary }) => {
      const path = (value: string) => JSON.stringify(value);
      const grants = [
        `":minimal" = "read"`,
        `${path(runtime)} = "read"`,
        ...[
          ...toolchainDirectories(source, workspace, "Codex workers"),
          ...gitMetadata(workspace),
          ...readOnly,
        ].map((directory) => `${path(directory)} = "read"`),
        `${path(home)} = "write"`,
        `${path(temporary)} = "write"`,
        // A socket in a directory read takes connections; nothing is written there.
        ...(services ? [`${path(services.root)} = "read"`] : []),
      ];
      // Name resolution: /etc/resolv.conf often links outside `:minimal`
      // (systemd-resolved under /run, WSL under /mnt/wsl).
      if (network && existsSync("/etc/resolv.conf"))
        grants.push(`${path(realpathSync("/etc/resolv.conf"))} = "read"`);
      const policy = shellPolicy(
        source,
        network,
        { ...sandbox.environment, ...services?.environment },
        [
          "HOME",
          "PATH",
          "TMPDIR",
          "CODEX_HOME",
          ...Object.keys(packageCacheEnvironment(join(home, ".cache"))),
        ],
      );
      // As planning's configuration (codex.ts): web search, apps, plugins,
      // hooks, memories, browser and computer use, image generation, skill
      // search and instructions, tool suggestions and sleep are off. The
      // shell, unified exec and view_image stay, and so does the code-mode
      // host the shell runs through; multi-agent keeps Codex's default.
      return `default_permissions = "factory"
web_search = "disabled"

[skills]
include_instructions = false

[features]
apps = false
plugins = false
hooks = false
memories = false
browser_use = false
computer_use = false
image_generation = false
skill_search = false
tool_suggest = false
sleep_tool = false

[permissions.factory.filesystem]
${grants.join("\n")}

[permissions.factory.filesystem.":workspace_roots"]
"." = "write"
".git" = "read"

[permissions.factory.network]
enabled = ${network}
${policy}${mcp}`;
    },
    finish: ({ root, home, env }) => {
      // Package caches stay in the private HOME, never in the worktree.
      Object.assign(env, packageCacheEnvironment(join(home, ".cache")));
      // Commands it starts end with it, an abort's included.
      const stderr = codexStderr(root);
      const { launcher, pidFile } = codexLauncher(root, env, stderr);
      return { root, launcher, pidFile, env, stderr };
    },
  });
}

/**
 * What the probe runs: a write outside its worktree, a read of one
 * read-only path (when given), a read of a sealed file and, when given a
 * port, a connection to the host's loopback; then their results in the
 * worktree. A file, since a network-off sandbox may not write to the pipe.
 */
const PROBE = `const fs=require("node:fs"),net=require("node:net"),[,out,p,sealedFile,port]=process.argv;let refused="",unread="",sealed=false,connected=false;try{fs.writeFileSync(out+"/outside","x")}catch(e){refused=e.code}if(p)try{fs.statSync(p).isDirectory()?fs.readdirSync(p):fs.closeSync(fs.openSync(p,"r"))}catch(e){unread=e.code||"error"}try{fs.readFileSync(sealedFile);sealed=true}catch{}const done=()=>fs.writeFileSync("result",JSON.stringify({refused,unread,sealed,connected}));if(!Number(port))done();else try{const s=net.connect(Number(port),"127.0.0.1");s.setTimeout(5000);s.on("connect",()=>{connected=true;s.destroy();done()});s.on("error",done);s.on("timeout",()=>{s.destroy();done()})}catch{done()}`;

/**
 * A probe's exit and stderr. After `timeout` ms its whole process group
 * (the launcher's `pidFile`) is killed, and it resolves then whatever the
 * process does.
 */
function probeRun(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeout: number;
    pidFile: string;
  },
): Promise<{
  status: number | null;
  signal: string | null;
  stderr: string;
  error?: Error;
}> {
  return new Promise((resolve) => {
    let stderr = "";
    let settled = false;
    const done = (result: {
      status: number | null;
      signal: string | null;
      error?: Error;
    }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      group.end();
      resolve({ ...result, stderr });
    };
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    // The launcher ignores SIGTERM; killing its group ends its namespace.
    const group = new LaunchedGroup(
      options.pidFile,
      new AbortController().signal,
    );
    const timer = setTimeout(() => {
      group.end();
      child.kill("SIGKILL");
      done({
        status: null,
        signal: "SIGKILL",
        error: new Error(`timed out after ${options.timeout} ms`),
      });
    }, options.timeout);
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 4096) stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => done({ status: null, signal: null, error }));
    child.on("close", (status, signal) => done({ status, signal }));
  });
}

/**
 * Codex's sandbox under a worker's own permission profile, tried with no
 * model call (\`codex sandbox\`): a command must write its worktree, be
 * refused a directory outside it, read the first sandbox.readOnlyPaths
 * entry and not read a sealed file outside its grants; with the network
 * off, a connection to a listener on the host's loopback must fail. The
 * problem, or undefined. Readiness runs it.
 */
export async function codexSandboxProblem(
  network: boolean,
  keep: readonly string[],
  sandbox: Pick<SandboxConfig, "readOnlyPaths" | "environment">,
): Promise<string | undefined> {
  let worktree: string | undefined;
  let outside: string | undefined;
  let home: WorkerHome | undefined;
  const listener = createServer((socket) => socket.destroy());
  try {
    worktree = mkdtempSync(join(tmpdir(), "factory-probe-"));
    outside = mkdtempSync(join(tmpdir(), "factory-probe-outside-"));
    const sealedFile = join(outside, "sealed");
    writeFileSync(sealedFile, "sealed", { mode: 0o600 });
    home = codexWorkerHome(worktree, network, keep, sandbox);
    let port = 0;
    if (!network) {
      await new Promise<void>((listening, failed) => {
        listener.once("error", failed);
        listener.listen(0, "127.0.0.1", listening);
      });
      port = (listener.address() as AddressInfo).port;
    }
    // workerHome checked it exists; read where it is granted.
    const readable = sandbox.readOnlyPaths[0] && real(sandbox.readOnlyPaths[0]);
    // Codex's standard error goes to its file (codex.ts codexStderr).
    const probeStderr = new CodexStderr(home.stderr);
    const run = await probeRun(
      home.launcher,
      [
        "sandbox",
        "--",
        "node",
        "-e",
        PROBE,
        outside,
        readable ?? "",
        sealedFile,
        String(port),
      ],
      { cwd: worktree, env: home.env, timeout: 30_000, pidFile: home.pidFile },
    );
    let found: {
      refused?: unknown;
      unread?: unknown;
      sealed?: unknown;
      connected?: unknown;
    };
    try {
      found = JSON.parse(readFileSync(join(worktree, "result"), "utf8"));
    } catch {
      return `Codex's sandbox couldn't run a command that writes its worktree (${run.error?.message ?? `exit ${run.status ?? run.signal}`}): ${detail(`${run.stderr}${probeStderr.tail()}`.trim())}`;
    }
    if (
      !["EACCES", "EPERM", "EROFS", "ENOENT"].includes(String(found.refused)) ||
      existsSync(join(outside, "outside"))
    )
      return "Codex's sandbox let a command write outside its worktree";
    if (found.unread)
      return `Codex's sandbox couldn't read read-only path ${readable} (${found.unread})`;
    if (found.sealed !== false)
      return "Codex's sandbox let a command read a file outside its grants";
    if (found.connected !== false)
      return "Codex's sandbox let a command connect out with the network off";
    return undefined;
  } catch (error) {
    return `Factory could not set up a Codex worker home: ${detail(errorMessage(error))}`;
  } finally {
    listener.close();
    for (const directory of [worktree, outside, home?.root])
      if (directory) rmSync(directory, { recursive: true, force: true });
  }
}

/** A Codex item as worker activity: tools by name, edits by path, commands. */
function codexActivity(
  input: WorkerInput,
  type: ThreadEvent["type"],
  item: ThreadItem,
): void {
  const phase =
    type === "item.started"
      ? "started"
      : type === "item.completed"
        ? "finished"
        : undefined;
  if (!phase) return;
  const tool =
    item.type === "command_execution"
      ? "shell"
      : item.type === "mcp_tool_call"
        ? `${item.server}.${item.tool}`
        : item.type === "web_search"
          ? "web_search"
          : undefined;
  const target =
    item.type === "command_execution"
      ? item.command
      : item.type === "web_search"
        ? item.query
        : undefined;
  if (tool)
    input.activity({
      kind: "tool",
      phase,
      tool,
      ...(phase === "started" && target ? { target } : {}),
    });
  if (phase === "started" && item.type === "command_execution")
    input.activity({ kind: "command", command: item.command });
  if (
    phase === "finished" &&
    item.type === "command_execution" &&
    (item.status === "failed" || (item.exit_code ?? 0) !== 0)
  )
    input.activity({ kind: "command-failed" });
  if (phase === "finished" && item.type === "file_change")
    for (const change of item.changes)
      input.activity({ kind: "edit", path: change.path });
  if (phase === "finished" && item.type === "agent_message")
    input.activity({ kind: "turn" });
}

/** Implementation turns through the Codex SDK and the operator's `codex login`. */
export class CodexWorker implements Worker {
  private readonly model: ModelChoice<CodexEffort>;

  constructor(private readonly options: CodexWorkerOptions) {
    this.model = options.model;
  }

  get validation(): SelfValidateOptions | undefined {
    return this.options.validation;
  }

  async run(input: WorkerInput): Promise<WorkerResult> {
    try {
      return await this.once(input);
    } catch (error) {
      // A continued thread ran out of context: once more, fresh.
      if (!(error instanceof ResumeOverflow)) throw error;
      return this.once({
        ...input,
        conversation: withoutPrevious(input.conversation),
      });
    }
  }

  private async once(input: WorkerInput): Promise<WorkerResult> {
    const started = Date.now();
    const record = usageRecord({
      role: "worker",
      provider: "codex",
      model: this.model.model,
      effort: this.model.effort,
      item: input.item.id,
    });
    describeRequest(record, {
      prompt: input.prompt,
      ...(input.facts ? { facts: input.facts } : {}),
    });
    try {
      const result = await this.turn(input, record);
      record.outcome = result.kind;
      if (result.kind === "retry") record.reason = result.reason;
      if (result.kind === "hold") record.reason = result.question;
      return result;
    } catch (error) {
      record.outcome = "error";
      record.error = detail(String(error));
      throw error;
    } finally {
      record.ms = Date.now() - started;
      logUsage(input.log, record);
    }
  }

  private async turn(
    input: WorkerInput,
    record: Record<string, unknown>,
  ): Promise<WorkerResult> {
    // Under a root controller Codex's `:minimal` profile reads root-only
    // host files (/etc/shadow, SSH host keys) too.
    if (runsAsRoot() && this.options.sandbox.required !== false)
      return outcome(new PlannerError("hold", ROOT_REFUSAL));
    input.signal.throwIfAborted();
    let Codex: typeof import("@openai/codex-sdk").Codex;
    try {
      ({ Codex } = await import("@openai/codex-sdk"));
    } catch (error) {
      return outcome(
        new PlannerError(
          "hold",
          `Codex workers need the @openai/codex-sdk package; install it, then answer retry (${detail(String(error))})`,
        ),
      );
    }
    // Validate, as the Claude worker's (codex-validate.ts): its handoff
    // check always, the tool when the item allows it.
    const validation =
      this.options.validation &&
      (await CodexValidate.start(input, this.options.validation));
    if (validation && !(validation instanceof CodexValidate)) return validation;
    let services: Awaited<ReturnType<CodexWorker["services"]>>;
    try {
      services = await this.services(input);
    } catch (error) {
      await validation?.close();
      throw error;
    }
    if (services && "problem" in services) {
      await validation?.close();
      return outcome(new PlannerError("hold", servicesHold(services.problem)));
    }
    input.log({
      event: "worker-start",
      provider: "codex",
      model: this.model.model,
      effort: this.model.effort,
      network: this.options.network ?? "off",
      validate: Boolean(validation?.tool),
    });
    try {
      return await this.converse(input, record, Codex, validation, services);
    } finally {
      await services?.stop();
      await validation?.close();
    }
  }

  /**
   * The attempt's throwaway services (work/services.ts), on the host's
   * network, only when the shell has it: with the network off, Codex's
   * sandbox refuses every socket connection, a Unix socket's too.
   */
  private async services(
    input: WorkerInput,
  ): Promise<AttemptServices | { problem: string } | undefined> {
    if (this.options.network !== "host" || !this.options.sandbox.services)
      return undefined;
    return AttemptServices.start(
      this.options.sandbox,
      "host",
      input.signal,
      input.log,
    );
  }

  private async converse(
    input: WorkerInput,
    record: Record<string, unknown>,
    Codex: typeof import("@openai/codex-sdk").Codex,
    validation: CodexValidate | undefined,
    services: AttemptServices | undefined,
  ): Promise<WorkerResult> {
    const validating = Boolean(validation?.tool);
    const keep = this.options.allowedSecretNames ?? [];
    const secrets = this.options.secrets ?? [];
    let home: WorkerHome;
    let turn: Turn;
    try {
      // A repair continues the item's thread when it can; its home is kept.
      const conversation = input.conversation;
      turn = openTurn(
        conversation,
        input.prompt,
        "codex",
        this.model.model,
        (session) =>
          codexSessionRecord(
            join(codexHomeOf(conversation!.dir), "codex-home"),
            session.id,
          ) !== undefined,
      );
      home = codexWorkerHome(
        input.worktree,
        this.options.network === "host",
        keep,
        this.options.sandbox,
        conversation && codexHomeOf(conversation.dir),
        validation?.config(),
        services,
      );
    } catch (error) {
      return outcome(
        new PlannerError(
          "hold",
          `Factory could not set up the Codex worker home: ${detail(errorMessage(error))}. Fix the host or installation, then answer retry.`,
        ),
      );
    }
    const idleMs = this.options.idleMs ?? WORKER_IDLE_MS;
    // A running Validate sends no events: its silence is bounded by the
    // item's whole validation deadline, as for Claude and Copilot.
    const watchdog = new IdleWatchdog(
      idleMs,
      input.signal,
      validation?.tool ? Math.max(idleMs, validation.deadlineMs) : undefined,
    );
    let events: AsyncGenerator<ThreadEvent> | undefined;
    // A continued thread out of context runs again fresh (`run`).
    const failed = (error: PlannerError): WorkerResult => {
      if (turn.resumed && error.tooLarge) throw new ResumeOverflow();
      return outcome(error);
    };
    turnFields(record, turn);
    let baseline: CodexBaseline | undefined;
    if (turn.resumed) {
      record.thread = turn.resumed.id;
      captureRequest(record, turn.prompt);
      baseline = codexBaseline(join(home.root, "codex-home"), turn.resumed.id);
    }
    // The SDK stream has no token counts until the turn ends: the session
    // record gives the context, compactions and counts as they happen.
    const live = codexLiveRecord(join(home.root, "codex-home"), baseline?.size);
    let counted: Tokens | undefined;
    // This call's counts so far: a continued thread's less its baseline.
    const spent = () =>
      counted && (baseline ? turnTokens(counted, baseline.tokens) : counted);
    const readLive = () => {
      const thread = (record.thread as string | undefined) ?? turn.resumed?.id;
      if (!thread) return;
      const { context, total, compactions } = live(thread);
      if (total) counted = total;
      if (context) input.activity({ kind: "context", ...context });
      for (let n = 0; n < compactions; n++)
        input.activity({ kind: "compaction" });
    };
    const reading = setInterval(readLive, ACTIVITY_INTERVAL_MS);
    reading.unref();
    // Codex's standard error since this turn began, for a failure's message.
    const stderr = new CodexStderr(home.stderr);
    // A failure's outcome, with what this turn's session record says about it.
    const failure = (message: string) =>
      failed(
        codexFailure(
          redact(message, secrets),
          codexTelemetry(
            join(home.root, "codex-home"),
            (record.thread as string | undefined) ?? turn.resumed?.id,
            baseline?.size,
          ),
          namespaceRefused(home.pidFile),
        ),
      );
    // The SDK hides the child: the group its launcher records is killed on
    // an abort, and a service exit kills it even before its first event.
    let group = new LaunchedGroup(home.pidFile, watchdog.signal);
    try {
      const tier =
        this.model.serviceTier === "fast"
          ? "priority"
          : this.model.serviceTier === "standard"
            ? "default"
            : undefined;
      // The tier asked for; Codex's default when none.
      record.serviceTier = this.model.serviceTier ?? null;
      const codex = new Codex({
        codexPathOverride: home.launcher,
        env: home.env,
        config: {
          ...(tier && { service_tier: tier }),
          ...(this.options.childAgents === "disabled" && {
            agents: { enabled: false },
            features: { multi_agent: false, multi_agent_v2: false },
          }),
        },
      });
      const callStarted = Date.now();
      const options = {
        workingDirectory: resolve(input.worktree),
        approvalPolicy: "never" as const,
        model: this.model.model,
        modelReasoningEffort: this.model.effort,
      };
      const thread = turn.resumed
        ? codex.resumeThread(turn.resumed.id, options)
        : codex.startThread(options);
      let finalResponse = "";
      const operations = new Tallies();
      record.sdkOperations = operations.value;
      // A handoff collection would reject, or a result no passing Validate
      // covered, is asked again on the same thread (FinishRequests).
      const finish =
        validation &&
        new FinishRequests(
          validation.validator,
          validating,
          input.item,
          CODEX_VALIDATE_CALL,
        );
      let request =
        turn.prompt +
        codexShellNote(
          this.options.network === "host",
          validating,
          input.item,
          services ? this.options.sandbox : {},
        );
      // Codex runs the commands, so a scripted rewrite that changed nothing
      // is told in the next request, before the result is taken (#2283).
      const rewrites = new HeadRewrites(input.worktree, watchdog.signal);
      let rewriteRequests = 0;
      for (let run = 0; ; run++) {
        if (run) {
          // Each run is a codex process of its own: the last one's group
          // ends, and the next is tracked from its own launcher record.
          group.end();
          rmSync(home.pidFile, { force: true });
          group = new LaunchedGroup(home.pidFile, watchdog.signal);
        }
        // The abort kills the launcher's group, and with it the namespace.
        ({ events } = await watchdog.race(
          thread.runStreamed(request, { signal: watchdog.signal }),
        ));
        let completed = false;
        let streamError: string | undefined;
        for (;;) {
          const next = await watchdog.race(events.next());
          if (next.done) break;
          const event = next.value;
          input.output(event);
          const item =
            event.type === "item.started" ||
            event.type === "item.updated" ||
            event.type === "item.completed"
              ? event.item
              : undefined;
          // A running Validate is a running tool (the watchdog's tool bound).
          watchdog.progress(
            item ? `${event.type}:${item.type}` : event.type,
            item?.type === "mcp_tool_call"
              ? { id: item.id, active: event.type !== "item.completed" }
              : undefined,
          );
          if (event.type === "thread.started") record.thread = event.thread_id;
          if (modelItem(item)) firstToken(record, callStarted);
          if (item?.type === "agent_message") finalResponse = item.text;
          if (item) codexActivity(input, event.type, item);
          if (
            event.type === "item.completed" &&
            item?.type === "command_execution"
          )
            rewrites.ran(item.command);
          if (event.type === "item.completed" && item?.type === "file_change")
            for (const change of item.changes) rewrites.edited(change.path);
          if (item && SDK_OPERATIONS.has(item.type)) {
            operations.add(item.type, item.id);
            record.sdkOperations = operations.value;
          }
          if (event.type === "turn.completed") {
            completed = true;
            // A thread's counts are cumulative from its first run, so
            // the last run's, less a continued thread's baseline, are
            // this turn's.
            record.tokens = baseline
              ? turnTokens(codexTokens(event.usage), baseline.tokens)
              : codexTokens(event.usage);
            codexTurnUsage(record, event.usage);
          }
          if (event.type === "turn.failed") return failure(event.error.message);
          // A completed item is a turn boundary: past the spend limit's
          // margin, the worker stops here (spendStopped), charged with the
          // counts so far; its child threads' are added at the end.
          if (event.type === "item.completed" && input.overspent) {
            readLive();
            const tokens = spent();
            if (tokens?.total != null && input.overspent(tokens.total)) {
              record.tokens = tokens;
              record.tokenSource = "native";
              return spendStopped();
            }
          }
          // A stream error can precede a CLI retry; read through to the
          // terminal turn and natural EOF before it counts.
          if (event.type === "error") streamError = event.message;
        }
        if (!completed)
          return streamError
            ? failure(streamError)
            : { kind: "retry", reason: "Codex ended without a completed turn" };
        const missed =
          rewriteRequests < MAX_REWRITE_REQUESTS
            ? await watchdog.race(rewrites.note("apply_patch"))
            : undefined;
        if (missed) {
          rewriteRequests += 1;
          request = `${missed}\nThen give your final report.`;
          continue;
        }
        const next = await finish?.next((operation) =>
          watchdog.race(operation),
        );
        if (!next) break;
        request = next;
      }
      captureResponse(record, finalResponse);
      // The tree a passing Validate covered: a validate step failure on it
      // runs once more before it counts (work/step-validate.ts).
      const tree = validating
        ? await validation?.validator.finalTree()
        : undefined;
      if (validating) record.finalTreeValidated = Boolean(tree);
      const threadId =
        (record.thread as string | undefined) ?? turn.resumed?.id;
      const session =
        threadId &&
        turn.end(threadId, {
          compacted: Boolean(
            codexTelemetry(
              join(home.root, "codex-home"),
              threadId,
              baseline?.size,
            )?.compacted,
          ),
        });
      return {
        kind: "finished",
        finalResponse,
        ...(session ? { session } : {}),
        ...(tree && { validated: { tree, commands: [...input.commands] } }),
        ...validateFailed(validating ? validation?.validator : undefined),
      };
    } catch (error) {
      if (error instanceof ResumeOverflow) throw error;
      if (error instanceof PlannerError) return failed(error);
      const idle = watchdog.expired;
      // An idle model is an error: three in a row hold.
      if (idle) return errored(idle.message);
      // Cancelled or past the step deadline: the engine decides.
      if (input.signal.aborted) throw input.signal.reason ?? error;
      // A failed codex process: its standard error ends the message.
      return failure(withStderr(error, stderr));
    } finally {
      clearInterval(reading);
      readLive();
      watchdog.stop();
      // Closing the stream ends the SDK's read; group.end kills codex.
      if (events) {
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([
          events.return(undefined).catch(() => undefined),
          new Promise((done) => {
            timer = setTimeout(done, 10_000);
          }),
        ]);
        clearTimeout(timer);
      }
      // Commands the worker left running end with its turn.
      group.end();
      saveModelsCache(join(home.root, "codex-home"));
      addCodexTelemetry(record, join(home.root, "codex-home"), baseline);
      // A retained conversation's Codex state stays for the item's next
      // repair; its HOME, caches and scratch go now, as for any turn.
      // A later turn may have taken the directory: then it isn't this one's.
      if (input.conversation) {
        if (turn.owns()) trimCodexHome(home.root);
      } else rmSync(home.root, { recursive: true, force: true });
    }
  }
}
