/**
 * The Codex Worker: one Work Item's implementation turn through the Codex
 * SDK and the operator's `codex login`. Shell commands and edits run in
 * Codex's own sandbox under Factory's permission profile (workspace
 * writable, `.git` read-only, network host or off), not in Factory's
 * bubblewrap; Factory's validation still decides. Factory collects and
 * commits the result.
 */
import {
  existsSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import type { ThreadEvent } from "@openai/codex-sdk";
import type { SandboxConfig } from "../config.js";
import { hold } from "../engine.js";
import { redact } from "../log.js";
import {
  gitMetadata,
  killGroup,
  packageCacheEnvironment,
  processGroups,
  ROOT_REFUSAL,
  runsAsRoot,
  toolchainDirectories,
} from "../sandbox.js";
import { errorMessage } from "../text.js";
import type { Worker, WorkerInput, WorkerResult } from "../work/worker.js";
import { workerToolchainPath } from "../worktree.js";
import {
  type CodexEffort,
  codexFailure,
  codexRuntimeDirectory,
  privateCodexHome,
  saveModelsCache,
} from "./codex.js";
import {
  detail,
  IdleWatchdog,
  type ModelChoice,
  PlannerError,
  providerOutcome,
} from "./planner.js";

export const DEFAULT_CODEX_WORKER_MODEL: ModelChoice<CodexEffort> = {
  model: "gpt-6.1-sol",
  effort: "medium",
};

/** A healthy turn can be silent this long: exec JSON emits no reasoning deltas. */
const WORKER_IDLE_MS = 15 * 60 * 1000;

export interface CodexWorkerOptions {
  /** The provider's `worker` model, effort and serviceTier, resolved (selection.ts resolvedProvider). */
  model: ModelChoice<CodexEffort>;
  /** Only `required` applies: Codex sandboxes its own shell. */
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
const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

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
 * What the worker's shell sees of the proxy variables Codex keeps to reach
 * its API: nothing when the shell has no network; with network, each URL
 * (one without a scheme read as http://) without its user name and
 * password (a URL that doesn't parse is left out), so the shell never
 * holds a proxy credential.
 */
function proxyPolicy(source: NodeJS.ProcessEnv, network: boolean): string {
  const set: string[] = [];
  const exclude: string[] = [];
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
  return `
[shell_environment_policy]
inherit = "all"
${exclude.length ? `exclude = ${JSON.stringify(exclude)}\n` : ""}${set.length ? `\n[shell_environment_policy.set]\n${set.join("\n")}\n` : ""}`;
}

/**
 * A private CODEX_HOME, HOME and TMPDIR for one turn, with Factory's
 * permission profile and a link to the operator's subscription login.
 * Shell commands see only the platform paths Codex calls `:minimal`, the
 * Codex runtime, the PATH's toolchains and the worktree's own git metadata
 * read-only, the private HOME and TMPDIR, and the worktree with its `.git`
 * entry read-only. Not the operator's HOME, logins, SSH keys or gh config,
 * Factory's state, nor the rest of the checkout's git directory. Throws a
 * setup problem; the caller holds with it.
 */
function workerHome(
  worktree: string,
  network: boolean,
  keep: readonly string[],
): WorkerHome {
  const setsid = ["/usr/bin/setsid", "/bin/setsid"].find((path) =>
    existsSync(path),
  );
  if (!setsid)
    throw new Error(
      "setsid (util-linux) is not installed, so Factory can't stop a Codex worker's commands; install util-linux",
    );
  const workspace = real(worktree);
  const source: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: workerToolchainPath(process.env.PATH),
  };
  const runtime = codexRuntimeDirectory();
  return privateCodexHome({
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
        ].map((directory) => `${path(directory)} = "read"`),
        `${path(home)} = "write"`,
        `${path(temporary)} = "write"`,
      ];
      // Name resolution: /etc/resolv.conf often links outside `:minimal`
      // (systemd-resolved under /run, WSL under /mnt/wsl).
      if (network && existsSync("/etc/resolv.conf"))
        grants.push(`${path(realpathSync("/etc/resolv.conf"))} = "read"`);
      return `default_permissions = "factory"

[permissions.factory.filesystem]
${grants.join("\n")}

[permissions.factory.filesystem.":workspace_roots"]
"." = "write"
".git" = "read"

[permissions.factory.network]
enabled = ${network}
${proxyPolicy(source, network)}`;
    },
    finish: ({ root, home, env }) => {
      // Package caches stay in the private HOME, never in the worktree.
      Object.assign(env, packageCacheEnvironment(join(home, ".cache")));
      // The SDK adds the runtime's helper directory (rg) only for its own binary.
      const target = join(
        runtime,
        process.arch === "arm64"
          ? "aarch64-unknown-linux-musl"
          : "x86_64-unknown-linux-musl",
      );
      env.PATH = [join(target, "codex-path"), env.PATH]
        .filter(Boolean)
        .join(":");
      // setsid makes codex the leader of a new process group, so an abort
      // kills it and every command it started, not just codex.
      const pidFile = join(root, "codex.pid");
      const launcher = join(root, "codex");
      writeFileSync(
        launcher,
        `#!/bin/sh\necho $$ > ${quote(pidFile)}\nexec ${setsid} ${quote(join(target, "bin", "codex"))} "$@"\n`,
        { mode: 0o700, flag: "wx" },
      );
      return { root, launcher, pidFile, env };
    },
  });
}

/** The process group a launcher recorded, once codex has started. */
function launchedGroup(pidFile: string): number | undefined {
  try {
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    return Number.isSafeInteger(pid) && pid > 1 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/** Implementation turns through the Codex SDK and the operator's `codex login`. */
export class CodexWorker implements Worker {
  private readonly model: ModelChoice<CodexEffort>;

  constructor(private readonly options: CodexWorkerOptions) {
    this.model = options.model;
  }

  async run(input: WorkerInput): Promise<WorkerResult> {
    // Codex's permission profile keeps the workspace writable, so read-only
    // access is not enforced either.
    if (input.item.kind === "discovery")
      return hold(
        `Work Item ${input.item.id} is a read-only discovery item, which the Codex worker can't run with enforced read-only access. Replan it.`,
        ["replan", "cancel"],
      );
    const started = Date.now();
    const record: Record<string, unknown> = {
      event: "worker-call",
      provider: "codex",
      item: input.item.id,
      model: this.model.model,
      effort: this.model.effort,
    };
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
      input.log(record);
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
    try {
      home = workerHome(input.worktree, this.options.network === "host", keep);
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
    let group: number | undefined;
    /** Track codex's group with the shared registry as soon as it exists. */
    const track = () => {
      if (group !== undefined) return;
      group = launchedGroup(home.pidFile);
      if (group !== undefined) processGroups.add(group);
    };
    const kill = () => {
      track();
      if (group !== undefined) killGroup(group);
    };
    watchdog.signal.addEventListener("abort", kill, { once: true });
    // The SDK hides the child: poll for the group its launcher records, so a
    // service exit kills it even before its first event.
    const polling = setInterval(() => {
      track();
      if (group !== undefined) clearInterval(polling);
    }, 100);
    polling.unref();
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
      const thread = codex.startThread({
        workingDirectory: resolve(input.worktree),
        approvalPolicy: "never",
        model: this.model.model,
        modelReasoningEffort: this.model.effort,
      });
      // The SDK kills codex on this signal; the abort listener kills its group.
      ({ events } = await watchdog.race(
        thread.runStreamed(input.prompt + TMP_SUFFIX, {
          signal: watchdog.signal,
        }),
      ));
      let finalResponse = "";
      let completed = false;
      let streamError: string | undefined;
      for (;;) {
        const next = await watchdog.race(events.next());
        if (next.done) break;
        const event = next.value;
        track();
        const item =
          event.type === "item.started" ||
          event.type === "item.updated" ||
          event.type === "item.completed"
            ? event.item
            : undefined;
        watchdog.progress(item ? `${event.type}:${item.type}` : event.type);
        if (event.type === "thread.started") record.thread = event.thread_id;
        if (item?.type === "agent_message") finalResponse = item.text;
        if (event.type === "item.completed" && item) {
          if (item.type === "command_execution")
            input.log({
              event: "worker-command",
              item: input.item.id,
              command: detail(redact(item.command, secrets)),
              exitCode: item.exit_code,
              status: item.status,
            });
          if (item.type === "file_change")
            input.log({
              event: "worker-edit",
              item: input.item.id,
              status: item.status,
              paths: item.changes
                .map((change) => relative(input.worktree, change.path))
                .slice(0, 16),
            });
        }
        if (event.type === "turn.completed") {
          completed = true;
          record.usage = {
            input: event.usage.input_tokens,
            output: event.usage.output_tokens,
            cached: event.usage.cached_input_tokens,
          };
        }
        if (event.type === "turn.failed")
          return outcome(codexFailure(redact(event.error.message, secrets)));
        // A stream error can precede a CLI retry; read through to the
        // terminal turn and natural EOF before it counts.
        if (event.type === "error") streamError = event.message;
      }
      if (!completed)
        return streamError
          ? outcome(codexFailure(redact(streamError, secrets)))
          : { kind: "retry", reason: "Codex ended without a completed turn" };
      return { kind: "finished", finalResponse };
    } catch (error) {
      if (error instanceof PlannerError) return outcome(error);
      const idle = watchdog.expired;
      // An idle model is an error: three in a row hold.
      if (idle) return { kind: "retry", reason: idle.message, afterMs: -1 };
      // Cancelled or past the step deadline: the engine decides.
      if (input.signal.aborted) throw input.signal.reason ?? error;
      // A failed codex process: its stderr is in the message.
      return outcome(codexFailure(redact(errorMessage(error), secrets)));
    } finally {
      clearInterval(polling);
      watchdog.stop();
      watchdog.signal.removeEventListener("abort", kill);
      // Closing the stream makes the SDK kill a codex process still running.
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
      kill();
      if (group !== undefined) processGroups.delete(group);
      saveModelsCache(join(home.root, "codex-home"));
      rmSync(home.root, { recursive: true, force: true });
    }
  }
}
