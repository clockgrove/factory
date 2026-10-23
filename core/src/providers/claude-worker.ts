/**
 * The Claude Worker: one Work Item's implementation turn through the Claude
 * Agent SDK on the operator's subscription login, in-process. The worker gets
 * Read, Edit and Write inside its worktree (Glob and Grep too when it has no
 * shell), `run_command` in the bubblewrap sandbox with no network, the
 * owned-file `copy_file` and `delete_file`, and Validate, which runs the
 * item's declared commands through `validateTree` on a snapshot commit of
 * its current files. Every grant is enforced in both SDK permission callbacks.
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
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { SandboxConfig } from "../config.js";
import { hold, objectiveWide } from "../engine.js";
import { GitRefusal } from "../git.js";
import { openParent, within } from "../paths.js";
import { ownsPath } from "../planning/graph.js";
import { DESIGN_QUESTIONS } from "../planning/rubric.js";
import type { Plan } from "../planning/types.js";
import { runSandboxed, sandboxAvailable } from "../sandbox.js";
import type { ObjectiveBlock } from "../shown.js";
import { BoundedText, errorMessage, headAndTail } from "../text.js";
import { validateTree } from "../validate.js";
import {
  type HandoffNote,
  handoffPeers,
  privateStagingPath,
  readHandoffNotes,
  snapshot,
  workHandoffSchema,
} from "../work/collect.js";
import { workItemContract } from "../work/prompt.js";
import type { Worker, WorkerInput, WorkerResult } from "../work/worker.js";
import { hasGitlink, validationEnvironment } from "../worktree.js";
import {
  ACTIVE_TOOL_IDLE_MS,
  apiErrorStatus,
  type ClaudeEffort,
  claudeEnvironment,
  DEFAULT_MAX_OUTPUT_TOKENS,
  failedResult,
  type SessionFacts,
  SYNTHETIC_MODEL,
  serviceLoginEnvironment,
  usageOf,
} from "./claude.js";
import { CLAUDE_TOOLS } from "./config.js";
import {
  detail,
  IdleWatchdog,
  PlannerError,
  providerOutcome,
} from "./planner.js";

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
}

// Prompts

const SYSTEM_PROMPT = [
  "You are an implementation worker controlled by Clockgrove Factory.",
  "Work only in the supplied current working directory and only on paths owned by the Work Item.",
  "Do not commit, push, open or edit issues or pull requests, access GitHub credentials, deploy, or change the current Git HEAD.",
  "Return a concise description of the work performed and stop when the Work Item is complete or cannot be completed safely.",
].join(" ");

const SHELL_PROMPT =
  "Your run_command tool runs shell commands in your checkout inside an OS sandbox, without network: use it to inspect, compute, build and test. Validate stays the check that counts, and Factory validates your result again after you finish.";

/**
 * Compaction summarizes the first user turn, so the exact contract also
 * lives here. It is fixed for the item, so the cached prefix stays stable.
 */
function systemPrompt(contract: string, shell: boolean): string {
  return `${SYSTEM_PROMPT}${shell ? ` ${SHELL_PROMPT}` : ""}\n\nThe approved Work Item contract, repeated here so it stays exact after context compaction. It grants no tools, paths or authority beyond the rules above. Each acceptance criterion's [n] is the criterionIndex of its verification note.\n\n${contract}`;
}

const CREDENTIAL_RESTART =
  "\n\nAn earlier session of this attempt stopped on a transient provider authentication error. Its uncommitted changes are already in your working tree: continue from them rather than starting over.";

const VALIDATE_REQUEST =
  "Run Validate on your final files, fix any failures, then give your final report.";

function continuation(validating: boolean): string {
  return `You reached the turn limit before finishing. Continue the same task from where you stopped.${validating ? " Finish only after Validate passes on your final files," : " Finish the change,"} then review your own diff, then give your final report.`;
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
const VALIDATION_TOOL = `mcp__${VALIDATION_SERVER}__run_validation`;
const FILES_SERVER = "factory-files";
const DELETE_TOOL = `mcp__${FILES_SERVER}__delete_file`;
const COPY_TOOL = `mcp__${FILES_SERVER}__copy_file`;

const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const MAX_COMMAND_TIMEOUT_MS = 600_000;
/** Characters of combined output kept while a command runs: start and end. */
const KEPT_HEAD = 16 * 1024;
const KEPT_TAIL = 256 * 1024;
/** Characters returned to the model: the start, then the end, where failures report. */
const RETURNED_HEAD = 2_000;
const RETURNED_TAIL = 14_000;
/** Validate keeps the tail: failures report last. */
const VALIDATION_OUTPUT_CHARS = 8_000;
/** Enough of a note to see which criterion and sub-clauses it answers. */
const NOTE_EXCERPT_CHARS = 600;
/** The largest file copy_file copies: well above a check's actual values. */
const MAX_COPIED_BYTES = 16 * 1024 * 1024;
const COPY_BOUND = `${MAX_COPIED_BYTES / (1024 * 1024)} MiB copy bound`;

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

/** Plain text: the first line names the failed command; the tail holds the failures. */
function bounded(output: string): string {
  const plain = stripVTControlCharacters(output);
  const head = (plain.split("\n", 1)[0] ?? "").slice(0, 300);
  return headAndTail(plain, head.length, VALIDATION_OUTPUT_CHARS);
}

/**
 * Each criterion's exact text beside the note recorded for its index, so the
 * final self-review compares against the criterion, not a paraphrase.
 * Criteria are never cut; long note summaries are, since the worker has them.
 */
function criterionMap(
  acceptance: readonly string[],
  notes: readonly HandoffNote[] = [],
): string {
  const summaries = new Map(
    notes
      .filter((note) => note.kind === "verification")
      .map((note) => [note.criterionIndex, note.summary]),
  );
  const missing = acceptance.flatMap((_, index) =>
    summaries.has(index) ? [] : [index],
  );
  const lines = acceptance.map((criterion, index) => {
    const summary = summaries.get(index);
    const note =
      summary === undefined
        ? "none recorded"
        : summary.length <= NOTE_EXCERPT_CHARS
          ? summary
          : `${summary.slice(0, NOTE_EXCERPT_CHARS)} [${summary.length - NOTE_EXCERPT_CHARS} more characters]`;
    return `[${index}] ${criterion}\nnote [${index}]: ${note}`;
  });
  return `Check each acceptance criterion's exact text against the verification note recorded for its index. The reviewer checks every sub-clause of this text, not a paraphrase: a note that answers another criterion, merges criteria or omits a sub-clause leaves that criterion unproved. Add any missing proof, then fix the note.${missing.length ? ` No note yet for criteria ${missing.join(", ")}.` : ""}\n${lines.join("\n")}`;
}

interface HandoffCheck {
  passed: boolean;
  text?: string;
  criteria?: string;
}

/**
 * One worker attempt: its grants, the state its tools share across queries,
 * and the scratch beside the worktree (`<worktree>.shell`).
 */
class Attempt {
  readonly closed = new AbortController();
  readonly root: string;
  private shellQueue: Promise<unknown> = Promise.resolve();
  private validationQueue: Promise<unknown> = Promise.resolve();
  private runs = 0;
  private readonly passedTrees = new Set<string>();

  constructor(
    readonly input: WorkerInput,
    readonly config: ClaudeWorkerConfig,
    readonly options: ClaudeWorkerOptions,
    readonly grants: { shell: boolean; validate: boolean; files: boolean },
    private readonly sdk: SdkModule,
    private readonly z: Zod,
  ) {
    this.root = `${input.worktree}.shell`;
  }

  /** Every tool runs with the attempt: cancel, or the turn ending, stops it. */
  get signal(): AbortSignal {
    return AbortSignal.any([this.input.signal, this.closed.signal]);
  }

  /** Stop running tools and wait for them, then remove the scratch. */
  async close(): Promise<void> {
    this.closed.abort(new Error("the worker attempt ended"));
    await Promise.all([this.shellQueue, this.validationQueue]);
    rmSync(this.root, { recursive: true, force: true });
  }

  /** Fresh servers for each query; their state lives on the attempt. */
  servers(): Record<string, McpSdkServerConfigWithInstance> {
    return {
      ...(this.grants.validate && { [VALIDATION_SERVER]: this.validation() }),
      ...(this.grants.files && { [FILES_SERVER]: this.files() }),
      ...(this.grants.shell && { [SHELL_SERVER]: this.shell() }),
    };
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
          `Run a shell command (sh -c) in your checkout, inside an OS sandbox: your checkout is writable (its .git is read-only), HOME and TMPDIR are private and last this attempt, the network is off and only loopback works, and nothing else on the host is visible. Use it to inspect generated files, compute hashes, run a test or build, or copy and move files. Returns the exit code and the combined output (long output keeps its start and end; redirect it to a file and read that). Commands run one at a time, for at most timeoutMs (default ${DEFAULT_COMMAND_TIMEOUT_MS}, at most ${MAX_COMMAND_TIMEOUT_MS}); a command still running then is stopped with everything it started. Factory still runs the declared validation itself after you finish: run Validate before you finish.`,
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
   * TMPDIR under the attempt's scratch, no network. It never runs
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
    this.input.log({
      event: "worker-command",
      exitCode: run.exitCode,
      timedOut: run.timedOut,
      ms,
    });
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
   * The bytes of one regular file under the worktree, at most the copy
   * bound: never followed through a link, and the read stops one byte past
   * the bound even if the file grows.
   */
  private readOwnedFile(root: string, relativePath: string): Buffer {
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
      if (stat.size > MAX_COPIED_BYTES)
        throw new Error(
          `${relativePath} has ${stat.size} bytes, over the ${COPY_BOUND}`,
        );
      const buffer = Buffer.alloc(MAX_COPIED_BYTES + 1);
      let length = 0;
      for (;;) {
        const read = readSync(fd, buffer, length, buffer.length - length, null);
        if (!read) break;
        length += read;
        if (length > MAX_COPIED_BYTES)
          throw new Error(
            `${relativePath} grew past the ${COPY_BOUND} while it was read`,
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
    const content = this.readOwnedFile(root, source);
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
          "run_validation",
          "Run this work item's declared validation commands (the same ones Factory runs after you finish) on a snapshot of your current files, decode .factory-handoff.json as Factory will when it collects your result, and return the result. Files the commands produce under your owned paths that Git ignores (such as actual values a check writes) are copied back to your checkout at the same paths, and the result lists them. Takes several minutes. Run it after implementing and fix any failure it reports. Run it again after your last edit, including self-review and handoff fixes: finish only after a run passes on your final files.",
          {},
          async () => {
            const result = this.validationQueue.then(() => this.validate());
            this.validationQueue = result.catch(() => undefined);
            try {
              return text(await result);
            } catch (error) {
              return text(
                `Factory validation unavailable: ${errorMessage(error)}`,
                true,
              );
            }
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

  /**
   * The declared commands on a snapshot commit of the worker's current
   * files, in a fresh checkout, so the worker's files never change and no
   * build output or other run's temporary files reach the commands. The
   * worker names no command: only the declared ones run.
   */
  private async validate(): Promise<string> {
    const run = ++this.runs;
    const { input, options } = this;
    const signal = this.signal;
    const handoff = await this.checkHandoff();
    const snapped = await snapshot(input.worktree, options.sandbox, signal);
    if ("problem" in snapped)
      return `Validation failed. Fix this before you finish.\n${snapped.problem}`;
    const { tree, commit } = snapped;
    const result = await validateTree({
      checkout: input.worktree,
      repository: options.repository,
      directory: `${input.worktree}.validation`,
      commit,
      item: input.item,
      plan: options.plan,
      blocks: options.blocks,
      sandbox: options.sandbox,
      commandTimeoutMs: options.commandTimeoutMs,
      returnTo: input.worktree,
      predecessor: input.base !== options.plan.base ? input.base : undefined,
      signal,
      log: input.log,
    });
    if (result.kind === "retry") throw new Error(result.reason);
    if (result.kind === "hold") throw new Error(result.question);
    const passed = result.kind === "passed";
    const declared =
      result.kind === "passed"
        ? `All ${result.commands.length} declared validation commands passed:\n${result.commands.map((command) => `- ${command}`).join("\n")}`
        : `Validation failed. Fix this before you finish.\n${bounded(result.failed ? `${result.failed.command} failed:\n${result.output}` : result.output || result.detail)}`;
    const parts = [
      result.produced ? `${declared}\n\n${result.produced}` : declared,
    ];
    if (handoff.text)
      if (handoff.passed) parts.push(handoff.text);
      else parts.unshift(handoff.text);
    // Self-review follows a passing run; after the bounded output, so never cut.
    if (passed && handoff.criteria) parts.push(handoff.criteria);
    if (passed && !handoff.passed)
      parts.unshift("Validation failed. Fix this before you finish.");
    // The handoff is outside the tree; the final check decodes it again.
    if (passed) this.passedTrees.add(tree);
    input.log({
      event: "worker-validate",
      run,
      passed: passed && handoff.passed,
      tree,
      handoffPassed: handoff.passed,
    });
    return parts.join("\n\n");
  }

  /**
   * Decode .factory-handoff.json as collection will, so the worker can
   * repair a manifest that would reject its whole result. `criteria` maps
   * each criterion to its note once the manifest decodes.
   */
  async checkHandoff(): Promise<HandoffCheck> {
    const { item, worktree } = this.input;
    const { plan } = this.options;
    const count = item.acceptance.length;
    const notes = await readHandoffNotes(worktree, plan, item);
    if (notes && "problem" in notes)
      return {
        passed: false,
        text: `.factory-handoff.json would be rejected at collection, and your whole result with it. ${notes.problem}\nRewrite it to match this exact schema, then run validation again: ${JSON.stringify(workHandoffSchema(handoffPeers(plan, item).length, count))}`,
      };
    if (!notes)
      return {
        passed: true,
        ...(count && {
          text: `No .factory-handoff.json yet. Before you finish, record one verification note for each of the ${count} acceptance criteria there, using the schema in your instructions.`,
          criteria: criterionMap(item.acceptance),
        }),
      };
    const verified = notes.filter(
      (note) => note.kind === "verification",
    ).length;
    const answered = new Set<string>(
      notes.flatMap((note) => note.designRisk ?? []),
    );
    const unanswered = Object.keys(DESIGN_QUESTIONS).filter(
      (risk) => !answered.has(risk),
    );
    return {
      passed: true,
      text: `.factory-handoff.json decodes: ${notes.length} notes, verification notes for ${verified} of ${count} acceptance criteria.${unanswered.length ? ` No design note yet for ${unanswered.join(", ")}.` : ""}`,
      ...(count && { criteria: criterionMap(item.acceptance, notes) }),
    };
  }

  /**
   * Whether a passing Validate run covered the files the worker returns,
   * with a handoff collection accepts: the tree, false, or undefined when
   * the files can't be staged (collection reports that itself).
   */
  async finalTree(): Promise<string | false | undefined> {
    if (!this.passedTrees.size) return false;
    try {
      const snapped = await snapshot(
        this.input.worktree,
        this.options.sandbox,
        this.input.signal,
      );
      if ("problem" in snapped) return undefined;
      return this.passedTrees.has(snapped.tree) &&
        (await this.checkHandoff()).passed
        ? snapped.tree
        : false;
    } catch {
      return undefined;
    }
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

/** Which tool a call used and the worktree file or program it targeted, never its content. */
function toolActivity(
  worktree: string,
  name: string,
  input: unknown,
): { tool: string; target?: string } {
  const args =
    input && typeof input === "object"
      ? (input as Record<string, unknown>)
      : {};
  const path = [args.file_path, args.path, args.to].find(
    (value) => typeof value === "string",
  ) as string | undefined;
  let target: string | undefined;
  if (path !== undefined) {
    const inTree = relative(resolve(worktree), resolve(worktree, path));
    if (inTree && !inTree.startsWith("..") && !isAbsolute(inTree))
      target = inTree;
  } else if (typeof args.command === "string")
    target = args.command.trim().split(/\s+/, 1)[0]?.split("/").pop();
  return { tool: name, ...(target && { target: target.slice(0, 200) }) };
}

/** The Worker for Claude, on the operator's Claude login. */
export class ClaudeWorker implements Worker {
  private readonly config: ClaudeWorkerConfig;

  constructor(private readonly options: ClaudeWorkerOptions) {
    this.config = options.config;
  }

  async run(input: WorkerInput): Promise<WorkerResult> {
    input.signal.throwIfAborted();
    if (input.item.kind === "discovery")
      return hold(
        `Work Item ${input.item.id} is a read-only discovery item, which the Claude worker can't run with enforced read-only access. Replan it.`,
        ["replan", "cancel"],
      );
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
    const granted = (tool: string) =>
      config.tools.includes(tool) && config.allowedTools.includes(tool);
    // Host Git must not enter a repository the commands could write behind
    // a gitlink, so neither Validate nor the shell runs in such a checkout.
    let gitlinks: boolean;
    try {
      gitlinks = await hasGitlink(input.worktree, { signal: input.signal });
    } catch (error) {
      if (error instanceof GitRefusal)
        return objectiveWide(hold(error.message));
      throw error;
    }
    const validate =
      granted(VALIDATE) && input.commands.length > 0 && !gitlinks;
    // Write and Validate together grant the shell: it adds nothing they
    // don't grant together. Not as root (the sandbox refuses root), and
    // only where bubblewrap runs.
    const shell =
      granted("Write") &&
      granted(VALIDATE) &&
      !gitlinks &&
      process.geteuid?.() !== 0 &&
      sandboxAvailable().available;
    const attempt = new Attempt(
      input,
      config,
      this.options,
      { shell, validate, files: granted("Write") },
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
      shell,
      validate,
    });
    try {
      return await this.converse(attempt, sdk, login);
    } finally {
      await attempt.close();
    }
  }

  private queryOptions(
    attempt: Attempt,
    login: Record<string, string>,
    abortController: AbortController,
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
      },
      mcpServers: attempt.servers(),
      strictMcpConfig: true,
      agents: {},
      plugins: [],
      skills: [],
      systemPrompt: systemPrompt(
        workItemContract(attempt.input.item),
        attempt.grants.shell,
      ),
      // Prompts carry untrusted source text; never expand @paths or commands.
      verbatimPrompts: true,
      thinking: { type: "adaptive" },
      persistSession: false,
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
  ): Promise<WorkerResult> {
    const { input } = attempt;
    const watchdog = new IdleWatchdog(
      IDLE_MS,
      input.signal,
      ACTIVE_TOOL_IDLE_MS,
    );
    let turns = userTurns();
    let controller = new AbortController();
    let session: Query | undefined;
    let facts: SessionFacts = { initialized: false, modelResponded: false };
    const abort = () => controller.abort(watchdog.signal.reason);
    watchdog.signal.addEventListener("abort", abort, { once: true });
    const start = (prompt: string) => {
      turns = userTurns();
      controller = new AbortController();
      facts = { initialized: false, modelResponded: false };
      turns.send(prompt);
      session = sdk.query({
        prompt: turns.messages(),
        options: this.queryOptions(attempt, login, controller),
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
    let result: SDKResultMessage | undefined;
    try {
      let events = start(input.prompt);
      for (;;) {
        const next = await watchdog.race(events.next());
        if (next.done) break;
        const message = next.value;
        watchdog.progress(
          message.type === "system"
            ? `system.${message.subtype}`
            : message.type,
          undefined,
          message.type === "system" && message.subtype === "api_retry"
            ? message.retry_delay_ms + (message.no_response?.retry_wait_ms ?? 0)
            : 0,
        );
        if (message.type === "assistant" || message.type === "user") {
          const content = message.message.content;
          const tools: { tool: string; target?: string }[] = [];
          if (Array.isArray(content))
            for (const block of content)
              if (block.type === "tool_use") {
                watchdog.progress(`tool_use:${block.name}`, {
                  id: block.id,
                  active: true,
                });
                tools.push(
                  toolActivity(input.worktree, block.name, block.input),
                );
              } else if (block.type === "tool_result")
                watchdog.progress("tool_result", {
                  id: block.tool_use_id,
                  active: false,
                });
          if (tools.length)
            input.log({ event: "worker-tools", tools: tools.slice(0, 16) });
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
        if (message.type === "system" && message.subtype === "init") {
          facts.initialized = true;
          input.log({ event: "worker-session", session: message.session_id });
        }
        if (message.type !== "result") continue;
        result = message;
        if (Number.isFinite(message.total_cost_usd))
          queryUsd = message.total_cost_usd;
        input.log({
          event: "worker-result",
          subtype: message.subtype,
          turns: message.num_turns,
          usage: usageOf(message),
          queryCostUsd: message.total_cost_usd,
          ...(message.stop_reason && { stopReason: message.stop_reason }),
        });
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
          events = start(`${input.prompt}${CREDENTIAL_RESTART}`);
          continue;
        }
        if (
          message.subtype === "error_max_turns" &&
          continuations < MAX_TURN_LIMIT_CONTINUATIONS
        ) {
          // Unfinished work, not a failed attempt: the same conversation
          // and worktree continue.
          continuations += 1;
          turns.send(continuation(attempt.grants.validate));
          continue;
        }
        if (!error && handoffRefusals < MAX_HANDOFF_REFUSALS) {
          const handoff = await watchdog.race(attempt.checkHandoff());
          if (!handoff.passed) {
            handoffRefusals += 1;
            turns.send(
              `Your result is not finished. ${handoff.text}\nThen give your final report.`,
            );
            continue;
          }
        }
        if (
          !error &&
          attempt.grants.validate &&
          !validationRequested &&
          (await watchdog.race(attempt.finalTree())) === false
        ) {
          validationRequested = true;
          turns.send(VALIDATE_REQUEST);
          continue;
        }
        break;
      }
    } catch (error) {
      const idle = watchdog.expired;
      // An idle model is an error: three in a row hold.
      if (idle) return { kind: "retry", reason: idle.message, afterMs: -1 };
      // Cancelled, or past the step's deadline: the engine decides.
      if (input.signal.aborted) throw input.signal.reason ?? error;
      return {
        kind: "retry",
        reason: `The Claude worker's turn was lost: ${detail(errorMessage(error))}`,
      };
    } finally {
      watchdog.signal.removeEventListener("abort", abort);
      watchdog.stop();
      turns.end();
      controller.abort();
      session?.close();
    }
    if (!result)
      return { kind: "retry", reason: "Claude SDK ended without a result" };
    const failed = failure(result, facts);
    if (failed) return failed;
    if (!facts.initialized)
      return {
        kind: "retry",
        reason: "Claude SDK did not report its initialized session",
      };
    const tree = attempt.grants.validate
      ? await attempt.finalTree()
      : undefined;
    input.log({
      event: "worker-finished",
      costUsd: spentUsd + queryUsd,
      ...(attempt.grants.validate && { finalTreeValidated: Boolean(tree) }),
    });
    return {
      kind: "finished",
      finalResponse: result.subtype === "success" ? result.result : "",
      ...(tree && { validated: { tree, commands: [...input.commands] } }),
    };
  }
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
