/**
 * The Claude Worker: one Work Item's implementation turn through the Claude
 * Agent SDK on the operator's subscription login, in-process. The worker gets
 * Read, Edit and Write inside its worktree (Glob and Grep too when it has no
 * shell), `run_command` in the bubblewrap sandbox (no network unless
 * `sandbox.network` is `host`), the
 * owned-file `copy_file` and `delete_file`, Validate, which runs the
 * item's declared commands through `validateTree` on a snapshot commit of
 * its current files, and on a profile with `worktreeRead`, the read-only
 * `read_file`. Every grant is enforced in both SDK permission callbacks.
 * Factory, not the worker, collects and commits the result.
 */

import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import type {
  HookJSONOutput,
  McpSdkServerConfigWithInstance,
  Options,
  Query,
  SDKResultMessage,
  SDKSystemMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { SandboxConfig } from "../config.js";
import { errored, hold } from "../engine.js";
import { openParent, within } from "../paths.js";
import { ownsPath } from "../planning/graph.js";
import type { Plan } from "../planning/types.js";
import { runSandboxed, sandboxAvailable } from "../sandbox.js";
import type { ObjectiveBlock } from "../shown.js";
import { BoundedText, errorMessage, headAndTail } from "../text.js";
import { validationDeadlineMs } from "../validate.js";
import { privateStagingPath } from "../work/collect.js";
import { workItemContract } from "../work/prompt.js";
import {
  SelfValidation,
  UNOWNED_FIX,
  VALIDATION_TOOL_DESCRIPTION,
  VALIDATION_TOOL_NAME,
  worktreeGitlinks,
} from "../work/self-validate.js";
import {
  targetOf,
  type Worker,
  type WorkerInput,
  type WorkerResult,
} from "../work/worker.js";
import { validationEnvironment } from "../worktree.js";
import {
  ACTIVE_TOOL_IDLE_MS,
  apiErrorStatus,
  baselineOf,
  claudeEnvironment,
  claudeSessionEnvironment,
  claudeTurn,
  DEFAULT_MAX_OUTPUT_TOKENS,
  failedResult,
  modelCounts,
  ownCost,
  type SessionFacts,
  SYNTHETIC_MODEL,
  serviceLoginEnvironment,
  sessionOptions,
  toolResultText,
  usageOf,
  withModels,
} from "./claude.js";
import { CLAUDE_TOOLS, type ClaudeEffort } from "./config.js";
import {
  detail,
  IdleWatchdog,
  PlannerError,
  providerOutcome,
} from "./planner.js";
import {
  ResumeOverflow,
  type Session,
  type Turn,
  turnFields,
  withoutPrevious,
} from "./session.js";
import {
  addTokens,
  addUsage,
  captureRequest,
  captureResponse,
  captureToolOutput,
  describeRequest,
  firstToken,
  logUsage,
  NativeTools,
  providerUsage,
  Tallies,
  tokens,
  usageRecord,
} from "./usage.js";

// Configuration

/** Only the operator's own settings: worktree settings are refused at load (providers/config.ts). */
export type ClaudeSettingSource = "user";

/** The operator's Claude worker settings. */
export interface ClaudeWorkerConfig {
  model: string;
  effort: ClaudeEffort;
  permissionMode: "acceptEdits" | "dontAsk";
  /** Filesystem settings the CLI loads: none, or the operator's user settings. */
  settingSources: ClaudeSettingSource[];
  /** Offered tools: Read, Edit, Write, Glob, Grep and Validate. */
  tools: string[];
  /** The tools the permission callbacks allow; a subset of `tools`. */
  allowedTools: string[];
  /** Turns per stretch of work; a turn-limit stop continues twice. */
  maxTurns: number;
}

/** Factory's own tool in `tools`, served over MCP, not an SDK built-in. */
const VALIDATE = "Validate";
const FILE_TOOLS: string[] = CLAUDE_TOOLS.filter((tool) => tool !== VALIDATE);

export const DEFAULT_CLAUDE_WORKER: ClaudeWorkerConfig = {
  model: "claude-opus-5-5",
  effort: "medium",
  permissionMode: "acceptEdits",
  settingSources: [],
  tools: [...FILE_TOOLS, VALIDATE],
  allowedTools: [...FILE_TOOLS, VALIDATE],
  // A turn-limit stop continues the conversation, so this bounds each
  // stretch of work rather than the whole attempt.
  maxTurns: 400,
};

export interface ClaudeWorkerOptions {
  /** Resolved (selection.ts resolvedProvider): what the Objective froze. */
  config: ClaudeWorkerConfig;
  sandbox: SandboxConfig;
  /** The accepted plan: Validate's pins and the handoff's peers. */
  plan: Plan;
  /** The Objective's shown structure as planned: its package-manager and workspace pins. */
  blocks: readonly ObjectiveBlock[];
  /** Origin's `owner/name`: Validate fetches Git LFS objects the local store lacks from it. */
  repository: string;
  /** Operator variables the worker's commands may see, by name. */
  allowedSecretNames?: readonly string[];
  /** Each Validate command's limit: `validation.commandTimeoutSeconds`, in ms. */
  commandTimeoutMs: number;
  /** The item's execution profile serves `read_file` (providers/config.ts `worktreeRead`). */
  worktreeRead?: boolean;
}

// Prompts

const SYSTEM_PROMPT = [
  "You are an implementation worker controlled by Clockgrove Factory.",
  "Work only in the supplied current working directory and only on paths owned by the Work Item.",
  "Do not commit, push, open or edit issues or pull requests, access GitHub credentials, deploy, or change the current Git HEAD.",
  "Return a concise description of the work performed and stop when the Work Item is complete or cannot be completed safely.",
].join(" ");

/** What the shell's network is, for its prompt and tool description. */
const shellNetwork = (sandbox: SandboxConfig) =>
  sandbox.network === "host"
    ? "it shares the host's network, so services on the host's loopback are reachable"
    : "the network is off and only loopback works";

const shellPrompt = (sandbox: SandboxConfig) =>
  `Your run_command tool runs shell commands in your checkout inside an OS sandbox (${shellNetwork(sandbox)}): use it to inspect, compute, build and test. Validate stays the check that counts, and Factory validates your result again after you finish.`;

/**
 * Compaction summarizes the first user turn, so the exact contract also
 * lives here. It is fixed for the item, so the cached prefix stays stable.
 */
function systemPrompt(
  contract: string,
  shell: boolean,
  sandbox: SandboxConfig,
): string {
  return `${SYSTEM_PROMPT}${shell ? ` ${shellPrompt(sandbox)}` : ""}\n\nThe approved Work Item contract, repeated here so it stays exact after context compaction. It grants no tools, paths or authority beyond the rules above. Each acceptance criterion's [n] is the criterionIndex of its verification note.\n\n${contract}`;
}

const CREDENTIAL_RESTART =
  "\n\nAn earlier session of this attempt stopped on a transient provider authentication error. Its uncommitted changes are already in your working tree: continue from them rather than starting over.";

export const VALIDATE_REQUEST = `Run Validate on your final files, fix any failures, then give your final report. ${UNOWNED_FIX}`;

/** `failed`: Validate's last run on the worker's current files failed. */
export function continuation(validating: boolean, failed: boolean): string {
  return `You reached the turn limit before finishing. Continue the same task from where you stopped.${validating ? " Finish only after Validate passes on your final files," : " Finish the change,"} then review your own diff, then give your final report.${failed ? ` Validate failed on your current files. ${UNOWNED_FIX}` : ""}`;
}

// Limits

/** Continuations of one attempt's conversation after a turn-limit stop. */
const MAX_TURN_LIMIT_CONTINUATIONS = 2;
/** Turns that return a handoff manifest collection would reject. */
const MAX_HANDOFF_REFUSALS = 2;
/**
 * Backoff before each fresh query after the API rejected the login (401).
 * Clients sharing one login rotate its OAuth token; a fresh query re-reads
 * it. A login that stays rejected holds.
 */
const CREDENTIAL_RETRY_DELAYS_MS = [3_000, 6_000] as const;
/** Silence that ends a turn; a running tool gets ACTIVE_TOOL_IDLE_MS. */
const IDLE_MS = 15 * 60 * 1_000;

/**
 * Models with a 1M-token window the bundled CLI uses only with a `[1m]`
 * suffix; otherwise it auto-compacts near 170K. Opt-in with
 * FACTORY_CLAUDE_1M=1: measured workers used about four times the input
 * tokens on it with no quality gain.
 */
const LONG_CONTEXT_MODELS = new Set(["claude-sonnet-5-5"]);
/** A typical attempt's context peaks near 400K, so it compacts at most once. */
const LONG_CONTEXT_COMPACT_WINDOW = 400_000;

function sdkModel(model: string): string {
  return process.env.FACTORY_CLAUDE_1M === "1" && LONG_CONTEXT_MODELS.has(model)
    ? `${model}[1m]`
    : model;
}

// Paths

/**
 * Follow a path one component at a time so a symlink or `..` can't escape
 * and a dangling final symlink is never taken for a safe new file. No
 * component, as written or after a link, may be `.git`: a worker that
 * repoints a `.git` file can make host Git run its own filter.
 */
export function pathInsideRoot(path: string, root: string): boolean {
  try {
    if (!path || path.includes("\0")) return false;
    const lexicalRoot = resolve(root);
    const realRoot = realpathSync(root);
    let remainder = path;
    if (isAbsolute(path)) {
      // Strip a literal prefix, so the walk sees every component as written.
      const prefix = [lexicalRoot, realRoot]
        .filter(
          (candidate) =>
            path === candidate || path.startsWith(`${candidate}${sep}`),
        )
        .sort((left, right) => right.length - left.length)[0];
      if (!prefix) return false;
      remainder = path.slice(prefix.length);
    }
    let current = realRoot;
    for (const component of remainder.split(sep)) {
      if (!component || component === ".") continue;
      if (component === "..") current = dirname(current);
      else {
        const next = join(current, component);
        const entry = lstatSync(next, { throwIfNoEntry: false });
        // realpathSync rejects a dangling link, including a final Write
        // destination that would redirect later.
        current = entry?.isSymbolicLink() ? realpathSync(next) : next;
      }
      if (!within(current, realRoot)) return false;
      if (relative(realRoot, current).split(sep).includes(".git")) return false;
    }
    return within(current, realRoot);
  } catch {
    return false;
  }
}

function boundedGlob(pattern: unknown): boolean {
  return (
    typeof pattern === "string" &&
    pattern.length > 0 &&
    !pattern.includes("\0") &&
    !pattern.includes("\\") &&
    !pattern.includes("..") &&
    !isAbsolute(pattern)
  );
}

// MCP tools

const SHELL_SERVER = "factory-shell";
const SHELL_TOOL = `mcp__${SHELL_SERVER}__run_command`;
const VALIDATION_SERVER = "factory-validation";
const VALIDATION_TOOL = `mcp__${VALIDATION_SERVER}__${VALIDATION_TOOL_NAME}`;
const FILES_SERVER = "factory-files";
const DELETE_TOOL = `mcp__${FILES_SERVER}__delete_file`;
const COPY_TOOL = `mcp__${FILES_SERVER}__copy_file`;
const READ_SERVER = "factory-worktree";
const READ_TOOL = `mcp__${READ_SERVER}__read_file`;

const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const MAX_COMMAND_TIMEOUT_MS = 600_000;
/** Characters of combined output kept while a command runs: start and end. */
const KEPT_HEAD = 16 * 1024;
const KEPT_TAIL = 256 * 1024;
/** Characters returned to the model: the start, then the end, where failures report. */
const RETURNED_HEAD = 2_000;
const RETURNED_TAIL = 14_000;
/** The largest file copy_file copies: well above a check's actual values. */
const MAX_COPIED_BYTES = 16 * 1024 * 1024;
const COPY_BOUND = `${MAX_COPIED_BYTES / (1024 * 1024)} MiB copy bound`;
/** The largest file read_file returns: larger ones are read in parts with Read. */
const MAX_READ_BYTES = 256 * 1024;
const READ_BOUND = `${MAX_READ_BYTES / 1024} KiB read_file bound; use Read with offset and limit`;

type SdkModule = typeof import("@anthropic-ai/claude-agent-sdk");
type Zod = typeof import("zod").z;
type ToolText = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

const text = (value: string, isError = false): ToolText => ({
  content: [{ type: "text", text: value }],
  ...(isError && { isError }),
});

/** Plain text, cut to its start and end. */
function returned(output: string): string {
  return headAndTail(
    stripVTControlCharacters(output),
    RETURNED_HEAD,
    RETURNED_TAIL,
    "; redirect long output to a file and read it",
  );
}

/**
 * One worker attempt: its grants, the state its tools share across queries,
 * and the scratch beside the worktree (`<worktree>.shell`).
 */
class Attempt {
  readonly closed = new AbortController();
  readonly root: string;
  /** Validate's runs, and the handoff and final-tree checks. */
  readonly validator: SelfValidation;
  private shellQueue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly input: WorkerInput,
    readonly config: ClaudeWorkerConfig,
    readonly options: ClaudeWorkerOptions,
    readonly grants: {
      shell: boolean;
      validate: boolean;
      files: boolean;
      read: boolean;
    },
    private readonly sdk: SdkModule,
    private readonly z: Zod,
  ) {
    this.root = `${input.worktree}.shell`;
    this.validator = new SelfValidation(input, options, this.signal);
  }

  /** Every tool runs with the attempt: cancel, or the turn ending, stops it. */
  get signal(): AbortSignal {
    return AbortSignal.any([this.input.signal, this.closed.signal]);
  }

  /** Stop running tools and wait for them, then remove the scratch. */
  async close(): Promise<void> {
    this.closed.abort(new Error("the worker attempt ended"));
    await Promise.all([this.shellQueue, this.validator.idle()]);
    rmSync(this.root, { recursive: true, force: true });
  }

  /** Fresh servers for each query; their state lives on the attempt. */
  servers(): Record<string, McpSdkServerConfigWithInstance> {
    return {
      ...(this.grants.validate && { [VALIDATION_SERVER]: this.validation() }),
      ...(this.grants.files && { [FILES_SERVER]: this.files() }),
      ...(this.grants.shell && { [SHELL_SERVER]: this.shell() }),
      ...(this.grants.read && { [READ_SERVER]: this.worktreeRead() }),
    };
  }

  // read_file

  private worktreeRead(): McpSdkServerConfigWithInstance {
    const { tool, createSdkMcpServer } = this.sdk;
    const z = this.z;
    return createSdkMcpServer({
      name: READ_SERVER,
      version: "1.0.0",
      tools: [
        tool(
          "read_file",
          `Read one regular file inside your worktree as UTF-8 text, by its path. Links are followed only while they stay inside the worktree; Git metadata and files over ${MAX_READ_BYTES / 1024} KiB are refused.`,
          { path: z.string().min(1) },
          async ({ path }) => {
            try {
              return text(this.readWorktreeFile(path));
            } catch (error) {
              return text(`File not read: ${errorMessage(error)}`, true);
            }
          },
          {
            alwaysLoad: true,
            annotations: {
              readOnlyHint: true,
              destructiveHint: false,
              idempotentHint: true,
              openWorldHint: false,
            },
          },
        ),
      ],
    });
  }

  /**
   * One worktree file's text, checked as Read is (pathInsideRoot), then
   * opened at its resolved place by held descriptors with no link
   * followed, so a link swapped in after the check can't lead out.
   */
  private readWorktreeFile(path: string): string {
    if (this.closed.signal.aborted) throw new Error("the worker attempt ended");
    const worktree = this.input.worktree;
    if (!pathInsideRoot(path, worktree))
      throw new Error(`${path} is not a file inside the worktree`);
    const root = realpathSync(worktree);
    const relativePath = relative(root, realpathSync(resolve(worktree, path)));
    if (!relativePath || !within(join(root, relativePath), root))
      throw new Error(`${path} is not a file inside the worktree`);
    return this.readRegularFile(
      root,
      relativePath,
      MAX_READ_BYTES,
      READ_BOUND,
    ).toString("utf8");
  }

  // run_command

  private shell(): McpSdkServerConfigWithInstance {
    const { tool, createSdkMcpServer } = this.sdk;
    const z = this.z;
    return createSdkMcpServer({
      name: SHELL_SERVER,
      version: "1.0.0",
      tools: [
        tool(
          "run_command",
          `Run a shell command (sh -c) in your checkout, inside an OS sandbox: your checkout is writable (its .git is read-only), HOME and TMPDIR are private and last this attempt, ${shellNetwork(this.options.sandbox)}, and nothing else on the host is visible. Use it to inspect generated files, compute hashes, run a test or build, or copy and move files. Returns the exit code and the combined output (long output keeps its start and end; redirect it to a file and read that). Commands run one at a time, for at most timeoutMs (default ${DEFAULT_COMMAND_TIMEOUT_MS}, at most ${MAX_COMMAND_TIMEOUT_MS}); a command still running then is stopped with everything it started. Factory still runs the declared validation itself after you finish: run Validate before you finish.`,
          {
            command: z.string().min(1),
            timeoutMs: z
              .number()
              .int()
              .min(1_000)
              .max(MAX_COMMAND_TIMEOUT_MS)
              .optional(),
          },
          async ({ command, timeoutMs }) => {
            const limit = timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
            const result = this.shellQueue.then(() =>
              this.runCommand(command, limit),
            );
            this.shellQueue = result.catch(() => undefined);
            try {
              return text(await result);
            } catch (error) {
              return text(`Command not run: ${errorMessage(error)}`, true);
            }
          },
          {
            alwaysLoad: true,
            annotations: {
              readOnlyHint: false,
              destructiveHint: true,
              idempotentHint: false,
              openWorldHint: false,
            },
          },
        ),
      ],
    });
  }

  /**
   * One command in the sandbox: the worktree writable, a private HOME and
   * TMPDIR under the attempt's scratch, sandbox.network's network. It never runs
   * unsandboxed, whatever `sandbox.required` allows.
   */
  private async runCommand(command: string, timeoutMs: number) {
    const signal = this.signal;
    if (signal.aborted) throw new Error("the Factory shell closed");
    const started = Date.now();
    const output = new BoundedText(KEPT_HEAD, KEPT_TAIL);
    let run: Awaited<ReturnType<typeof runSandboxed>>;
    try {
      run = await runSandboxed(command, {
        cwd: this.input.worktree,
        home: join(this.root, "home"),
        temporary: join(this.root, "tmp"),
        env: {
          ...validationEnvironment(join(this.root, "gh")),
          ...secretEnvironment(this.options.allowedSecretNames),
        },
        config: { ...this.options.sandbox, required: true },
        network: false,
        packageInstall: false,
        signal,
        timeoutMs,
        onOutput: (_stream, chunk) => output.add(chunk),
        outputLimit: 2,
      });
    } catch (error) {
      if (signal.aborted)
        throw new Error("the Factory shell closed while the command ran");
      throw error;
    }
    const ms = Date.now() - started;
    if (run.kind === "fault") throw new Error(`${run.detail}. ${run.fix}`);
    if (!run.sandboxed) throw new Error("The command sandbox is unavailable");
    if (run.timedOut || run.exitCode !== 0)
      this.input.activity({ kind: "command-failed" });
    // What it wrote counts whether it finished or was stopped.
    if (run.diskOverflow)
      throw new Error(`the command ran, but ${run.diskOverflow}`);
    const status = run.timedOut
      ? `Stopped after ${timeoutMs} ms, with everything it started`
      : `Exit code ${run.exitCode ?? "none (ended by a signal)"}`;
    return `${status} (${ms} ms)\n${returned(output.toString())}`;
  }

  // copy_file and delete_file

  private files(): McpSdkServerConfigWithInstance {
    const { tool, createSdkMcpServer } = this.sdk;
    const z = this.z;
    return createSdkMcpServer({
      name: FILES_SERVER,
      version: "1.1.0",
      tools: [
        tool(
          "delete_file",
          "Delete one file this Work Item owns, by its path in the worktree. Use it when the work removes a file. Factory collects the deletion with your other changes. Directories, unowned paths, Git metadata and Factory staging files are refused.",
          { path: z.string().min(1) },
          async ({ path }) => {
            try {
              return text(`Deleted ${this.deleteOwnedFile(path)}`);
            } catch (error) {
              return text(`File not deleted: ${errorMessage(error)}`, true);
            }
          },
          {
            alwaysLoad: true,
            annotations: {
              readOnlyHint: false,
              destructiveHint: true,
              idempotentHint: false,
              openWorldHint: false,
            },
          },
        ),
        tool(
          "copy_file",
          `Copy the exact bytes of one file to another path, both in the worktree and owned by this Work Item. Use it to commit a file a check produced, such as an actual golden that Validate returned, instead of retyping it. The destination is created or replaced. Returns the bytes copied and the copy's SHA-256. Links, non-regular files, unowned paths, Git metadata, Factory staging files and files over ${MAX_COPIED_BYTES / (1024 * 1024)} MiB are refused.`,
          { from: z.string().min(1), to: z.string().min(1) },
          async ({ from, to }) => {
            try {
              const copied = this.copyOwnedFile(from, to);
              return text(
                `Copied ${copied.from} to ${copied.to}: ${copied.bytes} bytes, sha256 ${copied.sha256}`,
              );
            } catch (error) {
              return text(`File not copied: ${errorMessage(error)}`, true);
            }
          },
          {
            alwaysLoad: true,
            annotations: {
              readOnlyHint: false,
              destructiveHint: true,
              idempotentHint: true,
              openWorldHint: false,
            },
          },
        ),
      ],
    });
  }

  /**
   * The normalized Git-relative form of a worker-supplied path inside the
   * worktree that this Work Item owns, never Git metadata or private staging.
   */
  private ownedRelative(root: string, path: string): string {
    if (this.closed.signal.aborted) throw new Error("the worker attempt ended");
    if (!path || path.includes("\0") || path.includes("\\"))
      throw new Error("path must name one file in the worktree");
    let relativePath = path;
    if (isAbsolute(path)) {
      const prefix = [resolve(this.input.worktree), root].find((candidate) =>
        path.startsWith(`${candidate}${sep}`),
      );
      if (!prefix) throw new Error(`${path} is outside the worktree`);
      relativePath = path.slice(prefix.length + 1);
    }
    const parts = relativePath.split("/");
    if (parts.some((part) => !part || part === "." || part === ".."))
      throw new Error(`${path} must be a normalized path inside the worktree`);
    if (parts.includes(".git") || privateStagingPath(relativePath))
      throw new Error(`${relativePath} is Git metadata or Factory staging`);
    if (!ownsPath(relativePath, this.input.item.ownedPaths))
      throw new Error(`${relativePath} is not owned by this Work Item`);
    return relativePath;
  }

  /**
   * Delete one owned file. Every parent is walked by held descriptor, so no
   * symlink, even one swapped in mid-walk, redirects the unlink; the final
   * entry is a file or a link, and unlink never follows it.
   */
  private deleteOwnedFile(path: string): string {
    const root = realpathSync(this.input.worktree);
    const relativePath = this.ownedRelative(root, path);
    const parent = openParent(root, relativePath, false);
    try {
      const target = `${parent.anchor}/${parent.name}`;
      const entry = lstatSync(target, { throwIfNoEntry: false });
      if (!entry) throw new Error(`${relativePath} does not exist`);
      if (entry.isDirectory())
        throw new Error(
          `${relativePath} is not a file reached through real directories`,
        );
      unlinkSync(target);
    } finally {
      closeSync(parent.fd);
    }
    return relativePath;
  }

  /**
   * The bytes of one regular file under the worktree, at most `limit`:
   * never followed through a link, and the read stops one byte past the
   * limit even if the file grows.
   */
  private readRegularFile(
    root: string,
    relativePath: string,
    limit: number,
    bound: string,
  ): Buffer {
    const parent = openParent(root, relativePath, false);
    let fd: number;
    try {
      fd = openSync(
        `${parent.anchor}/${parent.name}`,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch (error) {
      throw new Error(
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? `${relativePath} does not exist`
          : `${relativePath} is not a regular file`,
      );
    } finally {
      closeSync(parent.fd);
    }
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile())
        throw new Error(`${relativePath} is not a regular file`);
      if (stat.size > limit)
        throw new Error(
          `${relativePath} has ${stat.size} bytes, over the ${bound}`,
        );
      const buffer = Buffer.alloc(limit + 1);
      let length = 0;
      for (;;) {
        const read = readSync(fd, buffer, length, buffer.length - length, null);
        if (!read) break;
        length += read;
        if (length > limit)
          throw new Error(
            `${relativePath} grew past the ${bound} while it was read`,
          );
      }
      return buffer.subarray(0, length);
    } finally {
      closeSync(fd);
    }
  }

  /**
   * Copy one owned regular file's exact bytes to an owned destination, so
   * a file a check produced is committed without passing through the model.
   * Neither side is followed through a link, and the destination is
   * truncated only once it proves to be a regular file with one name.
   */
  private copyOwnedFile(from: string, to: string) {
    const root = realpathSync(this.input.worktree);
    const source = this.ownedRelative(root, from);
    const destination = this.ownedRelative(root, to);
    if (source === destination)
      throw new Error("from and to name the same file");
    const content = this.readRegularFile(
      root,
      source,
      MAX_COPIED_BYTES,
      COPY_BOUND,
    );
    const parent = openParent(root, destination, true);
    try {
      let fd: number;
      try {
        fd = openSync(
          `${parent.anchor}/${parent.name}`,
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_NOFOLLOW |
            constants.O_NONBLOCK,
        );
      } catch {
        throw new Error(`${destination} exists and is not a regular file`);
      }
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile())
          throw new Error(`${destination} exists and is not a regular file`);
        if (stat.nlink !== 1)
          throw new Error(`${destination} is a hard link to another file`);
        ftruncateSync(fd, 0);
        writeFileSync(fd, content);
      } finally {
        closeSync(fd);
      }
    } finally {
      closeSync(parent.fd);
    }
    return {
      from: source,
      to: destination,
      bytes: content.length,
      sha256: createHash("sha256").update(content).digest("hex"),
    };
  }

  // Validate

  private validation(): McpSdkServerConfigWithInstance {
    const { tool, createSdkMcpServer } = this.sdk;
    return createSdkMcpServer({
      name: VALIDATION_SERVER,
      version: "1.0.0",
      tools: [
        tool(
          VALIDATION_TOOL_NAME,
          VALIDATION_TOOL_DESCRIPTION,
          {},
          async () => {
            const result = await this.validator.call();
            return text(result.text, result.isError);
          },
          {
            alwaysLoad: true,
            annotations: {
              // It writes only ignored produced files, never the result tree.
              readOnlyHint: false,
              destructiveHint: false,
              openWorldHint: false,
            },
          },
        ),
      ],
    });
  }
}

// Permissions

const DENIED = "Factory grants only configured file access inside its worktree";

function provenance(server: unknown, name: string): boolean {
  if (!server || typeof server !== "object" || Array.isArray(server))
    return false;
  const source = server as Record<string, unknown>;
  return source.name === name && source.source === "sdk";
}

/**
 * The one access rule both SDK permission callbacks apply: Factory's own
 * tools only from its in-process servers with exactly their arguments, and
 * file tools only inside the worktree, with bounded globs.
 */
function toolAllowed(
  attempt: Attempt,
  toolName: string,
  toolInput: unknown,
  server: unknown,
): boolean {
  const { config, grants, input } = attempt;
  if (!toolInput || typeof toolInput !== "object" || Array.isArray(toolInput))
    return false;
  const args = toolInput as Record<string, unknown>;
  const keys = Object.keys(args).sort().join(",");
  switch (toolName) {
    case VALIDATION_TOOL:
      return grants.validate && provenance(server, VALIDATION_SERVER) && !keys;
    case SHELL_TOOL:
      return (
        grants.shell &&
        provenance(server, SHELL_SERVER) &&
        typeof args.command === "string" &&
        (keys === "command" ||
          (keys === "command,timeoutMs" && typeof args.timeoutMs === "number"))
      );
    case DELETE_TOOL:
      return (
        grants.files &&
        provenance(server, FILES_SERVER) &&
        keys === "path" &&
        typeof args.path === "string"
      );
    case READ_TOOL:
      return (
        grants.read &&
        provenance(server, READ_SERVER) &&
        keys === "path" &&
        typeof args.path === "string" &&
        pathInsideRoot(args.path, input.worktree)
      );
    case COPY_TOOL:
      return (
        grants.files &&
        provenance(server, FILES_SERVER) &&
        keys === "from,to" &&
        typeof args.from === "string" &&
        typeof args.to === "string"
      );
  }
  if (
    server ||
    !config.tools.includes(toolName) ||
    !config.allowedTools.includes(toolName) ||
    !nativeTools(config, grants.shell).includes(toolName)
  )
    return false;
  const path = ["Read", "Edit", "Write"].includes(toolName)
    ? args.file_path
    : args.path === undefined
      ? "."
      : args.path;
  if (typeof path !== "string" || !pathInsideRoot(path, input.worktree))
    return false;
  if (toolName === "Glob" && !boundedGlob(args.pattern)) return false;
  if (toolName === "Grep" && args.glob !== undefined && !boundedGlob(args.glob))
    return false;
  return true;
}

/**
 * What the settings grant, before an attempt narrows Validate and the shell
 * (no commands, a gitlink, no sandbox, root). Write and Validate together
 * grant the shell: it adds nothing they don't grant together. `read_file`
 * comes only beside Read, so it grants no file the worker couldn't read.
 */
function claudeGrants(
  config: ClaudeWorkerConfig,
  worktreeRead: boolean,
): { shell: boolean; validate: boolean; files: boolean; read: boolean } {
  const granted = (tool: string) =>
    config.tools.includes(tool) && config.allowedTools.includes(tool);
  return {
    shell: granted("Write") && granted(VALIDATE),
    validate: granted(VALIDATE),
    files: granted("Write"),
    read: worktreeRead && granted("Read"),
  };
}

/** The tools a worker on these settings is offered, by name, for the planner. */
export function claudeWorkerTools(
  config: ClaudeWorkerConfig,
  worktreeRead: boolean,
): string[] {
  const grants = claudeGrants(config, worktreeRead);
  return [
    ...nativeTools(config, grants.shell).filter((tool) =>
      config.allowedTools.includes(tool),
    ),
    ...(grants.files ? ["delete_file", "copy_file"] : []),
    ...(grants.read ? ["read_file"] : []),
    ...(grants.validate ? [VALIDATE] : []),
    ...(grants.shell ? ["run_command (sandboxed)"] : []),
  ];
}

/**
 * The SDK built-ins a worker is offered. Glob and Grep walk the worktree on
 * the host, and a shell can link any host path into it, so they are
 * withheld with the shell; its `find` walks the same files in the sandbox.
 */
function nativeTools(config: ClaudeWorkerConfig, shell: boolean): string[] {
  return config.tools.filter(
    (tool) =>
      FILE_TOOLS.includes(tool) &&
      !(shell && (tool === "Glob" || tool === "Grep")),
  );
}

// The turn loop

/**
 * The user turns of one streaming query. Streaming input keeps the
 * conversation, its tools and MCP servers open after a result, so a
 * turn-limit stop continues in place with a fresh turn budget.
 */
function userTurns() {
  const pending: string[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  const notify = () => {
    wake?.();
    wake = undefined;
  };
  return {
    async *messages(): AsyncGenerator<SDKUserMessage> {
      for (;;) {
        const content = pending.shift();
        if (content !== undefined)
          yield {
            type: "user",
            message: { role: "user", content },
            parent_tool_use_id: null,
          };
        else if (ended) return;
        else await new Promise<void>((done) => (wake = done));
      }
    },
    send(content: string): void {
      pending.push(content);
      notify();
    },
    end(): void {
      ended = true;
      notify();
    },
  };
}

function resultError(result: SDKResultMessage): string | undefined {
  if (result.subtype !== "success") return result.errors.join("; ");
  return result.is_error ? result.result : undefined;
}

const LOGIN_HOLD =
  "Worker login expired: run `claude auth login` on the service host, then answer retry";

/**
 * A failed result's outcome, from structured fields only: a refusal holds,
 * then claude.ts failedResult classifies the rest as the planner does;
 * anything unclassified retries in a fresh attempt.
 */
function failure(
  result: SDKResultMessage,
  facts: SessionFacts,
  /** The query continued a session: running out of context runs it again fresh (ResumeOverflow). */
  resumed: boolean,
): WorkerResult | undefined {
  const succeeded = result.subtype === "success" && !result.is_error;
  const ended = `Claude worker ended with ${result.subtype}${result.stop_reason ? ` (stop_reason ${result.stop_reason})` : ""}: ${detail(resultError(result) ?? "") || "no detail"}`;
  if (result.stop_reason === "refusal")
    return hold(
      `Claude refused to continue this Work Item (${ended}). Answer retry to run it again.`,
    );
  if (succeeded) return undefined;
  const failed = failedResult(result, facts, ended);
  switch (failed.kind) {
    case "billing":
      return providerOutcome(new PlannerError("hold", failed.message));
    case "login":
      return providerOutcome(
        new PlannerError("hold", `${LOGIN_HOLD} (${ended})`),
      );
    case "too-long":
      if (resumed) throw new ResumeOverflow();
      return hold(
        `The Work Item's prompt is larger than the worker model's context window; choose a model with a larger window or replan the item smaller, then answer retry (${ended})`,
      );
    case "limit":
      return {
        kind: "retry",
        reason: failed.message,
        ...(failed.wait ? { wait: failed.wait } : {}),
      };
    case "other":
      return { kind: "retry", reason: ended };
  }
}

/** A path as the filesystem resolves it, links followed where it exists. */
function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * The session must start as configured: another directory or permission
 * mode, or a reported effort that differs, holds before any tool runs.
 * Init echoes the requested model, so the model is checked on the answers
 * (`servedOther`).
 */
function startedOther(
  message: SDKSystemMessage,
  config: ClaudeWorkerConfig,
  worktree: string,
): WorkerResult | undefined {
  if (real(message.cwd) !== real(worktree))
    return hold(
      `Claude SDK initialized in ${detail(message.cwd)}, not the Work Item's worktree; check the host's Claude installation, then answer retry`,
    );
  if (message.permissionMode !== config.permissionMode)
    return hold(
      `Claude SDK selected permission mode ${message.permissionMode}, not the configured ${config.permissionMode}; check the operator's Claude settings, then answer retry`,
    );
  // The pinned SDK may omit effort or report null: only a value can differ.
  const effort = (message as { effort?: unknown }).effort;
  if (effort !== undefined && effort !== null && effort !== config.effort)
    return substitutionHold(
      `${message.model} at ${String(effort)} effort`,
      config,
    );
  return undefined;
}

/** A model id without the `[1m]` window suffix or a `-YYYYMMDD` snapshot date. */
const modelId = (model: string) =>
  model.replace(/\[1m\]$/, "").replace(/-\d{8}$/, "");

/**
 * The main thread's answer came from another model than the configured
 * full id. An alias (`opus`, `sonnet`) names no exact model, so it is
 * never compared.
 */
function servedOther(
  served: string,
  config: ClaudeWorkerConfig,
): WorkerResult | undefined {
  if (!config.model.startsWith("claude-")) return undefined;
  return modelId(served) === modelId(config.model)
    ? undefined
    : substitutionHold(served, config);
}

/** Copilot's substitution hold, for Claude: fix the model, then `switch`. */
function substitutionHold(
  served: string,
  config: ClaudeWorkerConfig,
): WorkerResult {
  return hold(
    `Claude served ${served}, not the configured ${config.model} at ${config.effort} effort. Set this provider's worker model to one the Claude login can use and restart the service, then answer \`switch NAME\` with this provider's name to run on its new settings, or with another configured provider's name; or cancel.`,
    ["switch", "cancel"],
  );
}

/** Built-in tools whose path argument names the file they write. */
const EDIT_TOOLS = ["Write", "Edit", "MultiEdit", "NotebookEdit", COPY_TOOL];

/** A tool call as worker activity: its name, the file it edits, the command it runs. */
function reportToolUse(input: WorkerInput, tool: string, args: unknown): void {
  const fields =
    args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  const path = [fields.file_path, fields.notebook_path, fields.to].find(
    (value) => typeof value === "string",
  ) as string | undefined;
  input.activity({
    kind: "tool",
    phase: "started",
    tool,
    ...targetOf(fields),
  });
  if (path !== undefined && EDIT_TOOLS.includes(tool))
    input.activity({ kind: "edit", path });
  if (typeof fields.command === "string")
    input.activity({ kind: "command", command: fields.command });
}

/** The Worker for Claude, on the operator's Claude login. */
export class ClaudeWorker implements Worker {
  private readonly config: ClaudeWorkerConfig;

  constructor(private readonly options: ClaudeWorkerOptions) {
    this.config = options.config;
  }

  async run(input: WorkerInput): Promise<WorkerResult> {
    try {
      return await this.once(input);
    } catch (error) {
      // A continued session ran out of context: once more, fresh.
      if (!(error instanceof ResumeOverflow)) throw error;
      return this.once({
        ...input,
        conversation: withoutPrevious(input.conversation),
      });
    }
  }

  private async once(input: WorkerInput): Promise<WorkerResult> {
    input.signal.throwIfAborted();
    let sdk: SdkModule;
    let z: Zod;
    try {
      [sdk, { z }] = await Promise.all([
        import("@anthropic-ai/claude-agent-sdk"),
        import("zod"),
      ]);
    } catch (error) {
      return providerOutcome(
        new PlannerError(
          "hold",
          `The Claude worker needs the optional @anthropic-ai/claude-agent-sdk package; install it, then answer retry (${detail(String(error))})`,
        ),
      );
    }
    let login: Record<string, string>;
    try {
      login = serviceLoginEnvironment();
    } catch (error) {
      if (error instanceof PlannerError) return providerOutcome(error);
      throw error;
    }
    const { config } = this;
    const granted = claudeGrants(config, this.options.worktreeRead === true);
    // Host Git must not enter a repository the commands could write behind
    // a gitlink, so neither Validate nor the shell runs in such a checkout.
    const gitlinks = await worktreeGitlinks(input);
    if (typeof gitlinks !== "boolean") return gitlinks;
    const attempt = new Attempt(
      input,
      config,
      this.options,
      {
        ...granted,
        validate: granted.validate && input.commands.length > 0 && !gitlinks,
        // Not as root (the sandbox refuses root), and only where bubblewrap runs.
        shell:
          granted.shell &&
          !gitlinks &&
          process.geteuid?.() !== 0 &&
          sandboxAvailable().available,
      },
      sdk,
      z,
    );
    // A fresh attempt's scratch: the disk budget measures from its first command.
    rmSync(attempt.root, { recursive: true, force: true });
    for (const directory of ["home", "tmp", "gh"])
      mkdirSync(join(attempt.root, directory), {
        recursive: true,
        mode: 0o700,
      });
    input.log({
      event: "worker-start",
      provider: "claude",
      model: config.model,
      effort: config.effort,
      shell: attempt.grants.shell,
      validate: attempt.grants.validate,
      worktreeRead: attempt.grants.read,
    });
    const record = usageRecord({
      role: "worker",
      provider: "claude",
      model: config.model,
      effort: config.effort,
      item: input.item.id,
    });
    describeRequest(record, {
      prompt: input.prompt,
      ...(input.facts ? { facts: input.facts } : {}),
    });
    // A repair continues the item's conversation when it can; never with
    // the operator's own settings, which the transcript doesn't bind.
    let retained: Retained | undefined;
    if (!config.settingSources.length && input.conversation)
      try {
        const turn = claudeTurn(input.conversation, input.prompt, config.model);
        if (turn)
          retained = {
            turn,
            env: claudeSessionEnvironment(input.conversation.dir),
          };
      } catch (error) {
        await attempt.close();
        return providerOutcome(
          new PlannerError(
            "hold",
            `Factory could not set up the Claude worker conversation; fix the host's work directory, then answer retry (${detail(String(error))})`,
          ),
        );
      }
    if (retained) {
      turnFields(record, retained.turn);
      if (retained.turn.resumed) captureRequest(record, retained.turn.prompt);
    }
    const started = Date.now();
    try {
      const result = await this.converse(attempt, sdk, login, record, retained);
      record.outcome = result.kind;
      return result;
    } catch (error) {
      record.outcome = "error";
      record.error = detail(String(error));
      throw error;
    } finally {
      record.ms = Date.now() - started;
      logUsage(input.log, record);
      await attempt.close();
    }
  }

  private queryOptions(
    attempt: Attempt,
    login: Record<string, string>,
    abortController: AbortController,
    retained: Retained | undefined,
  ): Options {
    const { config } = this;
    const model = sdkModel(config.model);
    const allowed = (name: string, toolInput: unknown, server: unknown) =>
      toolAllowed(attempt, name, toolInput, server);
    return {
      abortController,
      cwd: attempt.input.worktree,
      model,
      effort: config.effort,
      tools: nativeTools(config, attempt.grants.shell),
      // Bare allowedTools bypass canUseTool in the SDK; Factory's allow-list
      // lives in the callbacks below, never here.
      allowedTools: [],
      permissionMode: config.permissionMode,
      permissionPrompts: "host",
      hooks: {
        PreToolUse: [
          {
            hooks: [
              async (hook): Promise<HookJSONOutput> => {
                const ok =
                  hook.hook_event_name === "PreToolUse" &&
                  allowed(hook.tool_name, hook.tool_input, hook.mcp_server);
                return {
                  hookSpecificOutput: {
                    hookEventName: "PreToolUse",
                    permissionDecision: ok ? "allow" : "deny",
                    ...(!ok && { permissionDecisionReason: DENIED }),
                  },
                };
              },
            ],
          },
        ],
      },
      canUseTool: async (name, toolInput, permission) =>
        allowed(name, toolInput, permission.mcpServer)
          ? { behavior: "allow", toolUseID: permission.toolUseID }
          : {
              behavior: "deny",
              message: DENIED,
              interrupt: true,
              toolUseID: permission.toolUseID,
            },
      settingSources: [...config.settingSources],
      // Account sync, personal and project instructions and auto-memory are
      // not worker inputs. Managed policy keeps precedence.
      settings: {
        syncClaudeAiPlugins: false,
        syncClaudeAiSkills: false,
        autoMemoryEnabled: false,
        disableBundledSkills: true,
        claudeMdExcludes: ["**"],
        ...(model !== config.model && {
          autoCompactWindow: LONG_CONTEXT_COMPACT_WINDOW,
        }),
      },
      maxTurns: config.maxTurns,
      env: {
        ...claudeEnvironment(
          join(attempt.root, "gh"),
          DEFAULT_MAX_OUTPUT_TOKENS,
          login,
        ),
        // A Read over this many tokens fails and tells the worker to use
        // offset/limit or search; whole-file reads otherwise fill its context.
        CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS: "8000",
        ...retained?.env,
      },
      mcpServers: attempt.servers(),
      strictMcpConfig: true,
      agents: {},
      plugins: [],
      skills: [],
      systemPrompt: systemPrompt(
        workItemContract(attempt.input.item),
        attempt.grants.shell,
        this.options.sandbox,
      ),
      // Prompts carry untrusted source text; never expand @paths or commands.
      verbatimPrompts: true,
      thinking: { type: "adaptive" },
      ...sessionOptions(retained?.turn),
    };
  }

  /**
   * One attempt's conversation. A turn-limit stop continues in place twice;
   * a result with a handoff collection would reject is refused twice; a
   * result no passing Validate covered gets one request to validate; a
   * rejected login gets two fresh queries. Silence ends it as a retry.
   */
  private async converse(
    attempt: Attempt,
    sdk: SdkModule,
    login: Record<string, string>,
    record: Record<string, unknown>,
    retained: Retained | undefined,
  ): Promise<WorkerResult> {
    const turn = retained?.turn;
    // Where this query's cumulative cost and counts start (claude.ts
    // baselineOf); a credential restart moves it.
    let base = baselineOf(turn);
    let compacted = false;
    const { input } = attempt;
    const prompt = turn?.prompt ?? input.prompt;
    // A running Validate or shell command sends no events; its silence is
    // bounded by the item's whole validation deadline, as for Copilot.
    const watchdog = new IdleWatchdog(
      IDLE_MS,
      input.signal,
      attempt.grants.validate || attempt.grants.shell
        ? Math.max(
            ACTIVE_TOOL_IDLE_MS,
            validationDeadlineMs(input.item, attempt.options.commandTimeoutMs),
          )
        : ACTIVE_TOOL_IDLE_MS,
    );
    let turns = userTurns();
    let controller = new AbortController();
    let session: Query | undefined;
    let facts: SessionFacts = { initialized: false, modelResponded: false };
    const abort = () => controller.abort(watchdog.signal.reason);
    watchdog.signal.addEventListener("abort", abort, { once: true });
    // A query continues the item's session when its turn resumes one; its
    // turns count on from the session's.
    record.sessionMode = turn?.resumed ? "resumed" : "fresh";
    record.imageOutputs = 0;
    const callStarted = Date.now();
    const send = (content: string) => {
      record.sessionTurn = (record.sessionTurn as number) + 1;
      turns.send(content);
    };
    const start = (prompt: string) => {
      turns = userTurns();
      controller = new AbortController();
      facts = { initialized: false, modelResponded: false };
      record.sessionTurn = (turn?.number ?? 1) - 1;
      send(prompt);
      session = sdk.query({
        prompt: turns.messages(),
        options: this.queryOptions(attempt, login, controller, retained),
      });
      return session[Symbol.asyncIterator]();
    };
    let continuations = 0;
    let handoffRefusals = 0;
    let validationRequested = false;
    let credentialRetries = 0;
    // A query's results report its running total; credential retries add queries.
    let spentUsd = 0;
    let queryUsd = 0;
    // Tokens likewise: the queries a credential retry ended, and the running one.
    let spentTokens = tokens({ input: 0, output: 0, cached: 0, cacheWrite: 0 });
    let queryTokens = spentTokens;
    // The provider's own usage, summed over queries like the tokens.
    let spentUsage: Record<string, unknown> | undefined;
    let queryUsage: Record<string, unknown> | undefined;
    let result: SDKResultMessage | undefined;
    /** Running tool calls' names by id, for their results. */
    const toolNames = new Map<string, string>();
    const calls = new Tallies();
    const tools = new NativeTools();
    let response: string | undefined;
    try {
      let events = start(prompt);
      for (;;) {
        const next = await watchdog.race(events.next());
        if (next.done) break;
        const message = next.value;
        input.output(message);
        watchdog.progress(
          message.type === "system"
            ? `system.${message.subtype}`
            : message.type,
          undefined,
          message.type === "system" && message.subtype === "api_retry"
            ? message.retry_delay_ms + (message.no_response?.retry_wait_ms ?? 0)
            : 0,
        );
        if (message.type === "stream_event") firstToken(record, callStarted);
        if (
          message.type === "assistant" &&
          message.message.model !== SYNTHETIC_MODEL
        ) {
          firstToken(record, callStarted);
          record.reportedModel = message.message.model;
          if (message.parent_tool_use_id === null) {
            const other = servedOther(message.message.model, this.config);
            if (other) return other;
          }
          // The main thread's context at this request; the SDK gives no window.
          const usage = message.message.usage;
          if (message.parent_tool_use_id === null && usage)
            input.activity({
              kind: "context",
              tokens:
                usage.input_tokens +
                (usage.cache_read_input_tokens ?? 0) +
                (usage.cache_creation_input_tokens ?? 0),
            });
          // One response may arrive split over several messages with its id.
          if (message.message.id !== response) tools.response();
          response = message.message.id;
        }
        if (message.type === "assistant" || message.type === "user") {
          const content = message.message.content;
          if (Array.isArray(content))
            for (const block of content)
              if (message.type === "assistant" && block.type === "image")
                record.imageOutputs = (record.imageOutputs as number) + 1;
              else if (block.type === "tool_use") {
                tools.call(block.id);
                watchdog.progress(`tool_use:${block.name}`, {
                  id: block.id,
                  active: true,
                });
                calls.add(block.name, block.id);
                record.nativeToolActivity = calls.value;
                toolNames.set(block.id, block.name);
                reportToolUse(input, block.name, block.input);
              } else if (block.type === "tool_result") {
                watchdog.progress("tool_result", {
                  id: block.tool_use_id,
                  active: false,
                });
                const tool = toolNames.get(block.tool_use_id);
                toolNames.delete(block.tool_use_id);
                tools.result(block.tool_use_id, block.is_error === true);
                captureToolOutput(
                  record,
                  tool ?? "unknown",
                  toolResultText(block.content),
                );
                if (tool)
                  input.activity({ kind: "tool", phase: "finished", tool });
              }
          if (
            message.type === "assistant" &&
            message.message.model !== SYNTHETIC_MODEL
          )
            input.activity({ kind: "turn" });
        }
        if (
          message.type === "rate_limit_event" &&
          message.rate_limit_info.status === "rejected"
        )
          facts.limit = message.rate_limit_info;
        if (message.type === "assistant") {
          if (message.error) facts.assistantError = message.error;
          if (message.message.model !== SYNTHETIC_MODEL)
            facts.modelResponded = true;
        }
        if (
          message.type === "system" &&
          message.subtype === "compact_boundary"
        ) {
          compacted = true;
          input.activity({ kind: "compaction" });
        }
        if (message.type === "system" && message.subtype === "init") {
          facts.initialized = true;
          record.session = message.session_id;
          record.reportedModel = message.model;
          const other = startedOther(message, this.config, input.worktree);
          if (other) return other;
        }
        if (message.type !== "result") continue;
        result = message;
        // A continued session reports its cost and per-model counts
        // cumulatively: this turn's are what follows the kept total.
        queryUsd = ownCost(message, base) ?? queryUsd;
        queryTokens = tokens({ ...usageOf(message, base.models) });
        record.tokens = addTokens(spentTokens, queryTokens);
        record.costUsd = spentUsd + queryUsd;
        record.turns = message.num_turns;
        record.resultSubtype = message.subtype;
        queryUsage = providerUsage({
          usage: message.usage,
          modelUsage: message.modelUsage,
        });
        record.providerUsage = addUsage(spentUsage, queryUsage) ?? null;
        if (message.stop_reason) record.stopReason = message.stop_reason;
        const error = resultError(message);
        if (
          facts.initialized &&
          message.subtype === "success" &&
          message.is_error &&
          apiErrorStatus(message) === 401 &&
          credentialRetries < CREDENTIAL_RETRY_DELAYS_MS.length
        ) {
          // The login this query read was rejected, likely rotated by
          // another client. A fresh query reads it again; the worktree and
          // the tools' state carry on.
          const delayMs = CREDENTIAL_RETRY_DELAYS_MS[credentialRetries++] ?? 0;
          turns.end();
          session?.close();
          input.log({
            event: "worker-credential-retry",
            retry: credentialRetries,
            delayMs,
          });
          watchdog.progress("credential-retry", undefined, delayMs);
          await watchdog.race(
            sleep(delayMs, undefined, { signal: watchdog.signal }),
          );
          result = undefined;
          spentUsd += queryUsd;
          queryUsd = 0;
          // A resumed turn's restart resumes the same session, whose totals
          // now include this query; a fresh turn's starts a new session.
          base = turn?.resumed
            ? {
                costUsd: Number.isFinite(message.total_cost_usd)
                  ? message.total_cost_usd
                  : base.costUsd,
                models: modelCounts(message) ?? base.models,
              }
            : baselineOf(undefined);
          spentTokens = addTokens(spentTokens, queryTokens);
          spentUsage = addUsage(spentUsage, queryUsage);
          queryUsage = undefined;
          queryTokens = tokens({ input: 0, output: 0, cached: 0 });
          events = start(`${prompt}${CREDENTIAL_RESTART}`);
          continue;
        }
        if (
          message.subtype === "error_max_turns" &&
          continuations < MAX_TURN_LIMIT_CONTINUATIONS
        ) {
          // Unfinished work, not a failed attempt: the same conversation
          // and worktree continue.
          continuations += 1;
          send(
            continuation(
              attempt.grants.validate,
              attempt.grants.validate &&
                (await watchdog.race(attempt.validator.finalFailed())),
            ),
          );
          continue;
        }
        if (!error && handoffRefusals < MAX_HANDOFF_REFUSALS) {
          const handoff = await watchdog.race(attempt.validator.checkHandoff());
          if (!handoff.passed) {
            handoffRefusals += 1;
            send(
              `Your result is not finished. ${handoff.text}\nThen give your final report.`,
            );
            continue;
          }
        }
        if (
          !error &&
          attempt.grants.validate &&
          !validationRequested &&
          (await watchdog.race(attempt.validator.finalTree())) === false
        ) {
          validationRequested = true;
          send(VALIDATE_REQUEST);
          continue;
        }
        break;
      }
    } catch (error) {
      const idle = watchdog.expired;
      // An idle model is an error: three in a row hold.
      if (idle) return errored(idle.message);
      // Cancelled, or past the step's deadline: the engine decides.
      if (input.signal.aborted) throw input.signal.reason ?? error;
      return {
        kind: "retry",
        reason: `The Claude worker's turn was lost: ${detail(errorMessage(error))}`,
      };
    } finally {
      tools.response();
      record.nativeTools = tools.value;
      watchdog.signal.removeEventListener("abort", abort);
      watchdog.stop();
      turns.end();
      controller.abort();
      session?.close();
    }
    if (!result)
      return { kind: "retry", reason: "Claude SDK ended without a result" };
    const failed = failure(result, facts, Boolean(turn?.resumed));
    if (failed) return failed;
    if (!facts.initialized)
      return {
        kind: "retry",
        reason: "Claude SDK did not report its initialized session",
      };
    const tree = attempt.grants.validate
      ? await attempt.validator.finalTree()
      : undefined;
    if (attempt.grants.validate) record.finalTreeValidated = Boolean(tree);
    const finalResponse = result.subtype === "success" ? result.result : "";
    captureResponse(record, finalResponse);
    const sessionId = record.session as string | undefined;
    return {
      kind: "finished",
      finalResponse,
      ...withSession(
        turn &&
          sessionId &&
          turn.end(sessionId, {
            compacted,
            costUsd: result.total_cost_usd,
            ...withModels(modelCounts(result)),
          }),
      ),
      ...(tree && { validated: { tree, commands: [...input.commands] } }),
    };
  }
}

/** A retained turn and the environment that keeps its transcript (claude.ts claudeSessionEnvironment). */
interface Retained {
  turn: Turn;
  env: Record<string, string>;
}

/** The session a turn left, as a WorkerResult field. */
function withSession(session: Session | "" | undefined): {
  session?: Session;
} {
  return session ? { session } : {};
}

/** The named operator variables a worker's commands may see; never Git, GitHub or SSH ones. */
function secretEnvironment(
  names: readonly string[] = [],
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of names)
    if (
      process.env[name] !== undefined &&
      !/^(GH_|GITHUB_|GIT_|SSH_)/.test(name)
    )
      env[name] = process.env[name]!;
  return env;
}
