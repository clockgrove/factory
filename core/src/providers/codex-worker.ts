/**
 * The Codex Worker: one Work Item's implementation turn through the Codex
 * SDK and the operator's `codex login`. Shell commands and edits run in
 * Codex's own sandbox under Factory's permission profile (workspace
 * writable, `.git` read-only, network host or off), not in Factory's
 * bubblewrap; Factory's validation still decides. Factory collects and
 * commits the result.
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
import {
  gitMetadata,
  LaunchedGroup,
  packageCacheEnvironment,
  ROOT_REFUSAL,
  readOnlyMounts,
  runsAsRoot,
  toolchainDirectories,
} from "../sandbox.js";
import { errorMessage } from "../text.js";
import {
  ACTIVITY_INTERVAL_MS,
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
  privateCodexHome,
  saveModelsCache,
  trimCodexHome,
} from "./codex.js";
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
}

// Codex's sandbox mounts only granted paths: no /tmp (#1647).
const TMP_SUFFIX =
  "\n\nYour shell runs in Codex's sandbox, which differs from Factory's validation environment: it has a private writable $TMPDIR but no /tmp or /var/tmp. Factory's validation runs the same commands with a writable /tmp. When a command fails here only because it uses /tmp, do not change files or propose ownership for that alone: report the command and that it needs /tmp; Factory's validation still decides.";

const real = (path: string) => realpathSync(path);

/** A classified Codex failure as the Worker's outcome (planner.ts providerOutcome). */
const outcome = (error: PlannerError): WorkerResult => providerOutcome(error);

interface WorkerHome {
  root: string;
  /** The launcher the SDK spawns: it runs codex as its own process group. */
  launcher: string;
  /** Where the launcher records that group. */
  pidFile: string;
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
 * worktree's own git metadata read-only, the private HOME and TMPDIR, and the worktree with its `.git`
 * entry read-only. Not the operator's HOME, logins, SSH keys or gh config,
 * Factory's state, nor the rest of the checkout's git directory. Throws a
 * setup problem; the caller holds with it.
 */
function workerHome(
  worktree: string,
  network: boolean,
  keep: readonly string[],
  sandbox: Pick<SandboxConfig, "readOnlyPaths" | "environment">,
  /** A retained conversation's home (privateCodexHome `root`). */
  root?: string,
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
      ];
      // Name resolution: /etc/resolv.conf often links outside `:minimal`
      // (systemd-resolved under /run, WSL under /mnt/wsl).
      if (network && existsSync("/etc/resolv.conf"))
        grants.push(`${path(realpathSync("/etc/resolv.conf"))} = "read"`);
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
${shellPolicy(source, network, sandbox.environment, [
  "HOME",
  "PATH",
  "TMPDIR",
  "CODEX_HOME",
  ...Object.keys(packageCacheEnvironment(join(home, ".cache"))),
])}`;
    },
    finish: ({ root, home, env }) => {
      // Package caches stay in the private HOME, never in the worktree.
      Object.assign(env, packageCacheEnvironment(join(home, ".cache")));
      // Commands it starts end with it, an abort's included.
      const { launcher, pidFile } = codexLauncher(root, env);
      return { root, launcher, pidFile, env };
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
    home = workerHome(worktree, network, keep, sandbox);
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
      return `Codex's sandbox couldn't run a command that writes its worktree (${run.error?.message ?? `exit ${run.status ?? run.signal}`}): ${detail(run.stderr.trim())}`;
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
      home = workerHome(
        input.worktree,
        this.options.network === "host",
        keep,
        this.options.sandbox,
        conversation && codexHomeOf(conversation.dir),
      );
    } catch (error) {
      return outcome(
        new PlannerError(
          "hold",
          `Factory could not set up the Codex worker home: ${detail(errorMessage(error))}. Fix the host or installation, then answer retry.`,
        ),
      );
    }
    const watchdog = new IdleWatchdog(
      this.options.idleMs ?? WORKER_IDLE_MS,
      input.signal,
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
    // record gives the context and compactions as they happen.
    const live = codexLiveRecord(join(home.root, "codex-home"), baseline?.size);
    const readLive = () => {
      const thread = (record.thread as string | undefined) ?? turn.resumed?.id;
      if (!thread) return;
      const { context, compactions } = live(thread);
      if (context) input.activity({ kind: "context", ...context });
      for (let n = 0; n < compactions; n++)
        input.activity({ kind: "compaction" });
    };
    const reading = setInterval(readLive, ACTIVITY_INTERVAL_MS);
    reading.unref();
    // The SDK hides the child: the group its launcher records is killed on
    // an abort, and a service exit kills it even before its first event.
    const group = new LaunchedGroup(home.pidFile, watchdog.signal);
    try {
      const tier =
        this.model.serviceTier === "fast"
          ? "priority"
          : this.model.serviceTier === "standard"
            ? "default"
            : undefined;
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
      // The abort kills the launcher's group, and with it the namespace.
      ({ events } = await watchdog.race(
        thread.runStreamed(turn.prompt + TMP_SUFFIX, {
          signal: watchdog.signal,
        }),
      ));
      let finalResponse = "";
      let completed = false;
      let streamError: string | undefined;
      const operations = new Tallies();
      record.sdkOperations = operations.value;
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
        watchdog.progress(item ? `${event.type}:${item.type}` : event.type);
        if (event.type === "thread.started") record.thread = event.thread_id;
        if (modelItem(item)) firstToken(record, callStarted);
        if (item?.type === "agent_message") finalResponse = item.text;
        if (item) codexActivity(input, event.type, item);
        if (item && SDK_OPERATIONS.has(item.type)) {
          operations.add(item.type, item.id);
          record.sdkOperations = operations.value;
        }
        if (event.type === "turn.completed") {
          completed = true;
          record.tokens = baseline
            ? turnTokens(codexTokens(event.usage), baseline.tokens)
            : codexTokens(event.usage);
          codexTurnUsage(record, event.usage);
        }
        if (event.type === "turn.failed")
          return failed(codexFailure(redact(event.error.message, secrets)));
        // A stream error can precede a CLI retry; read through to the
        // terminal turn and natural EOF before it counts.
        if (event.type === "error") streamError = event.message;
      }
      if (!completed)
        return streamError
          ? failed(codexFailure(redact(streamError, secrets)))
          : { kind: "retry", reason: "Codex ended without a completed turn" };
      captureResponse(record, finalResponse);
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
      };
    } catch (error) {
      if (error instanceof ResumeOverflow) throw error;
      if (error instanceof PlannerError) return failed(error);
      const idle = watchdog.expired;
      // An idle model is an error: three in a row hold.
      if (idle) return errored(idle.message);
      // Cancelled or past the step deadline: the engine decides.
      if (input.signal.aborted) throw input.signal.reason ?? error;
      // A failed codex process: its stderr is in the message.
      return failed(codexFailure(redact(errorMessage(error), secrets)));
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
      addCodexTelemetry(record, join(home.root, "codex-home"), baseline?.size);
      // A retained conversation's Codex state stays for the item's next
      // repair; its HOME, caches and scratch go now, as for any turn.
      // A later turn may have taken the directory: then it isn't this one's.
      if (input.conversation) {
        if (turn.owns()) trimCodexHome(home.root);
      } else rmSync(home.root, { recursive: true, force: true });
    }
  }
}
