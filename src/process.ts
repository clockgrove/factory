import { AsyncLocalStorage } from "node:async_hooks";
import { type SpawnOptions, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { type Fault, transient, withFault } from "./fault.js";

export function command(
  file: string,
  args: string[],
  cwd?: string,
  env?: NodeJS.ProcessEnv,
  input?: string,
): string {
  const result = spawnSync(file, args, {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: Number.MAX_SAFE_INTEGER,
    input,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${file} ${args.join(" ")} failed (${result.status}): ${result.stderr || result.stdout}`,
    );
  }
  return result.stdout.trim();
}

/** The git subcommand, with LFS subcommands named in full. */
function gitSubcommand(args: string[]): string {
  let index = 0;
  while (index < args.length && args[index]!.startsWith("-"))
    index += ["-c", "-C"].includes(args[index]!) ? 2 : 1;
  const name = args[index] ?? "";
  return name === "lfs" ? `lfs ${args[index + 1] ?? ""}` : name;
}

const GIT_REMOTE = new Set([
  "push",
  "fetch",
  "pull",
  "clone",
  "ls-remote",
  "lfs push",
  "lfs fetch",
  "lfs pull",
]);

/**
 * Classify a failed git command (the arguments after `-C <checkout>`).
 * Remote transport, credentials and remote refusals are classified; other
 * local failures are defects.
 */
export function gitFault(args: string[], error: unknown): Fault | undefined {
  const detail = error instanceof Error ? error.message : String(error);
  const subcommand = gitSubcommand(args);
  if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT")
    return {
      kind: "config",
      detail: "git is not installed on the controller host",
      fix: "Install git, then `factory run`",
    };
  if (/git: 'lfs' is not a git command/.test(detail))
    return {
      kind: "config",
      detail: "Git LFS is not installed on the controller host",
      fix: "Install Git LFS, then `factory run`",
    };
  // A stalled fetch was stopped so it does not hold the repository lock.
  if (error instanceof GitDeadlineExceeded)
    return transient(`git ${subcommand} stalled in transit`, false);
  // Another git process holds the repository lock; it releases it shortly.
  if (/Unable to create '[^']*\.lock': File exists/.test(detail))
    return transient(`git ${subcommand} found the repository locked`, false);
  if (!GIT_REMOTE.has(subcommand)) return undefined;
  const push = subcommand === "push" || subcommand === "lfs push";
  if (
    /Authentication failed|could not read (Username|Password)|terminal prompts disabled|Permission denied \(publickey\)|Permission to \S+ denied|Repository not found|returned error: 40[13]\b|HTTP 40[13]\b|LFS: Authorization error/i.test(
      detail,
    )
  )
    return {
      kind: "config",
      detail: `git ${subcommand} was refused credentials or access`,
      fix: "Check `gh auth status` and the origin remote's credentials, then `factory run`",
    };
  if (push && /\bGH001\b|exceeds GitHub's file size limit/i.test(detail))
    return {
      kind: "work",
      evidence: {
        detail: `git push refused a file over the size limit: ${detail}`,
      },
    };
  if (
    push &&
    /\bGH006\b|GH013|protected branch|pre-receive hook declined|push declined/i.test(
      detail,
    )
  )
    return {
      kind: "config",
      detail: `The remote refused Factory's branch push: ${detail}`,
      fix: "Allow the Factory login to push its own branches, then `factory run`",
    };
  // Whose head the remote holds is known only at the push site, which
  // checks it with ls-remote (see RegularDelivery.publish).
  if (push && pushRejected(error)) return undefined;
  if (
    /Could not resolve host|Temporary failure in name resolution|Connection (timed out|refused|reset)|Operation timed out|Failed to connect|Network is unreachable|early EOF|unexpected disconnect|remote end hung up|Remote side unexpectedly closed|RPC failed|returned error: (5\d\d|429)\b|HTTP (5\d\d|429)\b|gnutls_handshake|SSL_ERROR|SSL_connect|TLS connection|rate limit/i.test(
      detail,
    )
  )
    return transient(`git ${subcommand} failed in transit`, push);
  return undefined;
}

/** The remote refused a push because its branch moved. */
export function pushRejected(error: unknown): boolean {
  return /\[rejected\]|\(stale info\)|\(fetch first\)|non-fast-forward/.test(
    error instanceof Error ? error.message : String(error),
  );
}

function classifiedGit<T>(args: string[], run: () => T): T {
  return withFault(run, (error) => gitFault(args, error));
}

/**
 * Git takes no lock on a repository's worktree registry
 * (`.git/worktrees/<id>`). `worktree remove` deletes an entry file by file,
 * and a command walking the registry at that moment (fetch's connectivity
 * check resolves every worktree's HEAD; `worktree` commands find their
 * entry) dies with "Invalid path '.git/worktrees/<id>'". Commands that change
 * the registry therefore hold a per-repository lock exclusively and commands
 * that walk it hold it shared. Fetches share it with each other because
 * Factory's fetches write no shared ref (see fetchHead).
 */
type LockMode = "shared" | "exclusive";

function gitLockMode(args: string[]): LockMode | undefined {
  const subcommand = gitSubcommand(args);
  if (subcommand === "fetch") return "shared";
  if (subcommand === "worktree") {
    const index = args.indexOf("worktree");
    return args[index + 1] === "list" ? "shared" : "exclusive";
  }
  if (["pull", "gc", "prune", "maintenance"].includes(subcommand))
    return "exclusive";
  return undefined;
}

/** A synchronous call cannot wait for the repository lock. */
function assertUnlocked(args: string[]): void {
  if (gitLockMode(args))
    throw new Error(
      `git ${gitSubcommand(args)} must run through gitAsync or pinnedGitAsync, which hold the repository lock`,
    );
}

/** A fair reader/writer lock: callers are granted in the order they queued. */
class RepositoryLock {
  private readers = 0;
  private writer = false;
  private readonly queue: { mode: LockMode; grant: () => void }[] = [];

  get idle(): boolean {
    return !this.writer && this.readers === 0 && this.queue.length === 0;
  }

  /** Queues synchronously; a cancelled waiter leaves the queue. */
  acquire(mode: LockMode, signal: AbortSignal | undefined): Promise<void> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise<void>((resolve, reject) => {
      const abort = () => {
        const index = this.queue.indexOf(waiter);
        if (index < 0) return;
        this.queue.splice(index, 1);
        this.drain();
        reject(signal!.reason);
      };
      const waiter = {
        mode,
        grant: () => {
          signal?.removeEventListener("abort", abort);
          resolve();
        },
      };
      this.queue.push(waiter);
      signal?.addEventListener("abort", abort, { once: true });
      this.drain();
    });
  }

  release(mode: LockMode): void {
    if (mode === "exclusive") this.writer = false;
    else this.readers--;
    this.drain();
  }

  private drain(): void {
    for (let next = this.queue[0]; next; next = this.queue[0]) {
      if (this.writer || (next.mode === "exclusive" && this.readers > 0))
        return;
      this.queue.shift();
      if (next.mode === "exclusive") this.writer = true;
      else this.readers++;
      next.grant();
    }
  }
}

/** Locks by git common directory; linked worktrees share their checkout's. */
const repositoryLocks = new Map<string, RepositoryLock>();
/** Common directory by checkout path, resolved once so queueing stays synchronous. */
const repositoryKeys = new Map<string, string>();

function repositoryKey(checkout: string, env: NodeJS.ProcessEnv): string {
  const cacheKey = `${env === process.env ? "ambient" : "pinned"}\0${checkout}`;
  let key = repositoryKeys.get(cacheKey);
  if (!key) {
    const result = spawnSync(
      "git",
      [
        "-C",
        checkout,
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ],
      { env, encoding: "utf8" },
    );
    if (result.error) throw result.error;
    if (result.status !== 0)
      throw new Error(
        `git rev-parse --git-common-dir failed (${result.status}): ${result.stderr}`,
      );
    key = realpathSync(result.stdout.trim());
    repositoryKeys.set(cacheKey, key);
  }
  return key;
}

async function withRepositoryLock<T>(
  key: string,
  mode: LockMode,
  run: () => Promise<T>,
): Promise<T> {
  const lock = repositoryLocks.get(key) ?? new RepositoryLock();
  repositoryLocks.set(key, lock);
  const turn = lock.acquire(mode, currentProcessSignal());
  let held = false;
  try {
    await turn;
    held = true;
    return await run();
  } finally {
    if (held) lock.release(mode);
    if (lock.idle) repositoryLocks.delete(key);
  }
}

/**
 * Configuration for every git command Factory runs. No background
 * maintenance, which would walk the worktree registry unlocked. No
 * repository hooks: they are code from a worker-modified tree or checkout
 * that would run with the controller's environment and credentials.
 * Command-line scope overrides any hooksPath the repository sets.
 */
const GIT_CONFIG: [string, string][] = [
  ["maintenance.auto", "false"],
  ["gc.auto", "0"],
  ["core.hooksPath", "/dev/null"],
];
/** A stalled transfer must not hold the repository lock indefinitely. */
const LOCKED_NETWORK_CONFIG: [string, string][] = [
  ["http.lowSpeedLimit", "1000"],
  ["http.lowSpeedTime", "60"],
];
/** Deadline for a locked network command (fetch, pull); tests shorten it. */
export const lockedNetworkDeadline = { milliseconds: 15 * 60_000 };
/** The SSH counterpart of the HTTP low-speed bound: 4 unanswered 15 s probes. */
export const SSH_KEEPALIVE_COMMAND =
  "ssh -o ServerAliveInterval=15 -o ServerAliveCountMax=4";

/**
 * Bound a stalled SSH transfer the way LOCKED_NETWORK_CONFIG bounds HTTP,
 * unless the operator chose the SSH command (GIT_SSH_COMMAND, GIT_SSH or
 * core.sshCommand), which is then used unchanged. ssh still reads the
 * operator's ssh configuration.
 */
function withSshKeepalive(
  checkout: string,
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  if (env.GIT_SSH_COMMAND || env.GIT_SSH) return env;
  const configured = spawnSync(
    "git",
    ["-C", checkout, "config", "--get", "core.sshCommand"],
    { env, encoding: "utf8" },
  );
  if (configured.error) throw configured.error;
  // Exit 1 means unset; anything else leaves the choice to git itself.
  if (configured.status !== 1) return env;
  return { ...env, GIT_SSH_COMMAND: SSH_KEEPALIVE_COMMAND };
}

/** Append configuration through GIT_CONFIG_COUNT, after any entries already set. */
function withGitConfig(
  env: NodeJS.ProcessEnv,
  entries: [string, string][],
): NodeJS.ProcessEnv {
  const result = { ...env };
  let count = Number(result.GIT_CONFIG_COUNT ?? 0);
  if (!Number.isSafeInteger(count) || count < 0) count = 0;
  for (const [key, value] of entries) {
    result[`GIT_CONFIG_KEY_${count}`] = key;
    result[`GIT_CONFIG_VALUE_${count}`] = value;
    count++;
  }
  result.GIT_CONFIG_COUNT = String(count);
  return result;
}

function ambientGitEnvironment(): NodeJS.ProcessEnv {
  return withGitConfig(process.env, GIT_CONFIG);
}

/** A locked network command outlived lockedNetworkDeadline. */
export class GitDeadlineExceeded extends Error {}

function gitProcess(
  checkout: string,
  args: string[],
  pinned: boolean,
): Promise<string> {
  const mode = gitLockMode(args);
  const network = ["fetch", "pull"].includes(gitSubcommand(args));
  let env = pinned ? pinnedGitEnvironment() : ambientGitEnvironment();
  if (network) env = withGitConfig(env, LOCKED_NETWORK_CONFIG);
  const run = async () => {
    const deadline = network
      ? AbortSignal.timeout(lockedNetworkDeadline.milliseconds)
      : undefined;
    try {
      const result = await subprocessAsync("git", ["-C", checkout, ...args], {
        env: network ? withSshKeepalive(checkout, env) : env,
        ...(deadline && { signal: deadline }),
      });
      if (result.status !== 0)
        throw new Error(
          `git -C ${checkout} ${args.join(" ")} failed (${result.status}): ${result.stderr || result.stdout}`,
        );
      return result.stdout.trim();
    } catch (error) {
      if (deadline?.aborted && !currentProcessSignal()?.aborted)
        throw new GitDeadlineExceeded(
          `git ${gitSubcommand(args)} exceeded ${lockedNetworkDeadline.milliseconds / 1000}s`,
          { cause: error },
        );
      throw error;
    }
  };
  return classifiedGit(args, () => {
    if (!mode) return run();
    let key: string;
    try {
      key = repositoryKey(checkout, pinned ? env : process.env);
    } catch (error) {
      return Promise.reject(error);
    }
    return withRepositoryLock(key, mode, run);
  });
}

/**
 * Fetch `branch` from origin and return its head. The fetch writes neither
 * FETCH_HEAD nor a remote-tracking ref, which concurrent fetches would race
 * on, only a private ref it deletes again (the objects stay).
 */
export async function fetchHead(
  checkout: string,
  branch: string,
): Promise<string> {
  const ref = `refs/factory/fetch/${randomUUID()}`;
  await gitAsync(
    checkout,
    "fetch",
    "--no-tags",
    "--no-write-fetch-head",
    "--refmap=",
    "origin",
    `+refs/heads/${branch}:${ref}`,
  );
  try {
    return await gitAsync(checkout, "rev-parse", "--verify", `${ref}^{commit}`);
  } finally {
    await withProcessCancellation(undefined, () =>
      gitAsync(checkout, "update-ref", "-d", ref),
    );
  }
}

/**
 * Add a detached linked worktree of `checkout` at `commit`. Only the
 * registration holds the repository lock; the files are checked out after.
 */
export async function addWorktree(
  checkout: string,
  worktree: string,
  commit: string,
): Promise<void> {
  await pinnedGitAsync(
    checkout,
    "worktree",
    "add",
    "--no-checkout",
    "--detach",
    worktree,
    commit,
  );
  try {
    await pinnedGitAsync(worktree, "reset", "--quiet", "--hard", commit);
  } catch (error) {
    await removeWorktree(checkout, worktree);
    throw error;
  }
}

/**
 * Delete a linked worktree of `checkout`. Its files go first, outside the
 * repository lock, so the locked `git worktree remove` only unregisters it
 * (milliseconds, where a dependency tree takes seconds to delete). Cleanup
 * ignores cancellation. If git cannot unregister the worktree, its directory
 * is still deleted and git lists the entry as prunable.
 */
export async function removeWorktree(
  checkout: string,
  worktree: string,
): Promise<void> {
  await withProcessCancellation(undefined, async () => {
    try {
      await Promise.all(
        (await readdir(worktree))
          .filter((name) => name !== ".git")
          .map((name) =>
            rm(join(worktree, name), { recursive: true, force: true }),
          ),
      );
      await pinnedGitAsync(checkout, "worktree", "remove", "--force", worktree);
    } catch {
      await rm(worktree, { recursive: true, force: true });
    }
  });
}

export function git(checkout: string, ...args: string[]): string {
  assertUnlocked(args);
  return classifiedGit(args, () =>
    command(
      "git",
      ["-C", checkout, ...args],
      undefined,
      ambientGitEnvironment(),
    ),
  );
}

/** Keep inherited Git overrides from redirecting a pinned local tree operation. */
export function pinnedGit(checkout: string, ...args: string[]): string {
  return pinnedGitRaw(checkout, ...args)
    .toString("utf8")
    .trim();
}

/** Preserve exact pinned Git output without trimming or decoding. */
export function pinnedGitRaw(checkout: string, ...args: string[]): Buffer {
  assertUnlocked(args);
  return classifiedGit(args, () => {
    const result = spawnSync("git", ["-C", checkout, ...args], {
      env: pinnedGitEnvironment(),
      maxBuffer: Number.MAX_SAFE_INTEGER,
    });
    if (result.error) throw result.error;
    if (result.status !== 0)
      throw new Error(
        `git ${args.join(" ")} failed (${result.status}): ${result.stderr.toString("utf8")}`,
      );
    return result.stdout;
  });
}

export function pinnedGitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env))
    if (key.startsWith("GIT_")) delete env[key];
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_LFS_SKIP_SMUDGE: "1",
    GIT_LITERAL_PATHSPECS: "1",
  });
  return withGitConfig(env, GIT_CONFIG);
}

/** Give workers and validators only the ambient variables needed for local work. */
export function sanitizedWorkerEnvironment(
  credentialDirectory: string,
  allowedSecretNames: string[] = [],
): Record<string, string> {
  const env: Record<string, string> = {};
  const allowedNames = new Set([
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "LANG",
    "TERM",
    "TMPDIR",
    "TMP",
    "TEMP",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_RUNTIME_DIR",
    "CODEX_HOME",
    "CODEX_SQLITE_HOME",
  ]);
  for (const [key, value] of Object.entries(process.env)) {
    const declared =
      allowedSecretNames.includes(key) &&
      !/^(GH_|GITHUB_|GIT_|SSH_)/i.test(key);
    if (
      value &&
      (allowedNames.has(key) || /^LC_[A-Z_]+$/.test(key) || declared)
    )
      env[key] = value;
  }
  Object.assign(env, {
    GH_CONFIG_DIR: credentialDirectory,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "Never",
  });
  return env;
}

/** Validation and its read-only lookup use the supplied PATH, not login profiles. */
export function localValidationShellArguments(command: string): string[] {
  return ["-c", command];
}

export function localValidationEnvironment(
  credentialDirectory: string,
): Record<string, string> {
  return sanitizedWorkerEnvironment(credentialDirectory);
}

export function resolveLocalExecutable(
  executable: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  shell: string,
) {
  return spawnSync(
    shell,
    [
      ...localValidationShellArguments('command -v "$1"'),
      "factory-preflight",
      executable,
    ],
    { cwd, env, encoding: "utf8" },
  );
}

export function linuxProcessIdentity(
  pid: number,
): { group: number; startTime: string; state: string } | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(") ");
    if (close < 0) throw new Error(`Cannot parse process identity for ${pid}`);
    const fields = stat
      .slice(close + 2)
      .trim()
      .split(/\s+/);
    const group = Number(fields[2]);
    const startTime = fields[19];
    if (!Number.isSafeInteger(group) || !startTime || !fields[0])
      throw new Error(`Cannot parse process identity for ${pid}`);
    return { group, startTime, state: fields[0] };
  } catch (error) {
    if (
      ["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")
    )
      return null;
    throw error;
  }
}

export function processGroupExists(group: number): boolean {
  return processGroupMembers(group, 1) > 0;
}

/** Live (non-zombie) members of a process group, counted up to `limit`. */
function processGroupMembers(group: number, limit = Infinity): number {
  let members = 0;
  for (const name of readdirSync("/proc")) {
    if (!/^[1-9]\d*$/.test(name)) continue;
    const identity = linuxProcessIdentity(Number(name));
    if (identity?.group === group && identity.state !== "Z")
      if (++members >= limit) break;
  }
  return members;
}

export interface OwnedSubprocess {
  pid: number;
  startTime: string;
}
interface ProcessScope {
  unresolved?: boolean;
  signal?: AbortSignal;
  observe?: (process: OwnedSubprocess, settled: boolean) => void;
}
const processCancellation = new AsyncLocalStorage<ProcessScope>();
export function hasUnresolvedSubprocesses(): boolean {
  return processCancellation.getStore()?.unresolved === true;
}
export function currentProcessSignal(): AbortSignal | undefined {
  return processCancellation.getStore()?.signal;
}

/** Bind controller subprocesses to the current coordinator cancellation request. */
export function withProcessCancellation<T>(
  signal: AbortSignal | undefined,
  operation: () => Promise<T>,
  observe?: ProcessScope["observe"],
): Promise<T> {
  return processCancellation.run({ signal, observe }, operation);
}

/** How long an exited command's leftover descendants may run before they are stopped; tests shorten it. */
export const lingeringDescendants = { graceMilliseconds: 5_000 };

/** Whether process group `group` is gone within `milliseconds`. */
async function groupEnds(
  group: number,
  milliseconds: number,
): Promise<boolean> {
  const deadline = Date.now() + milliseconds;
  while (processGroupExists(group)) {
    if (Date.now() >= deadline) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  return true;
}

export async function subprocessAsync(
  file: string,
  args: string[],
  options: SpawnOptions = {},
  input?: string,
  observe?: (stream: "stdout" | "stderr", chunk: Buffer) => void,
): Promise<{
  status: number | null;
  stdout: string;
  stderr: string;
  /** Processes the exited command left running that were stopped after the grace period. */
  stoppedLeftovers?: number;
}> {
  const scope = processCancellation.getStore();
  let stoppedLeftovers = 0;
  // `options.signal` (such as a deadline) also stops the whole process group.
  const { signal: extra, ...spawnOptions } = options;
  const signal =
    scope?.signal && extra
      ? AbortSignal.any([scope.signal, extra])
      : (scope?.signal ?? extra);
  signal?.throwIfAborted();
  const child = spawn(file, args, { ...spawnOptions, detached: true });
  const identity = child.pid ? linuxProcessIdentity(child.pid) : null;
  const owned =
    child.pid && identity
      ? { pid: child.pid, startTime: identity.startTime }
      : undefined;
  if (owned) scope?.observe?.(owned, false);
  let cancellationError: unknown;
  let aborted = false;
  const cancel = () => {
    aborted = true;
    if (!child.pid) return;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH")
        cancellationError = error;
    }
  };
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  const output: Record<"stdout" | "stderr", Buffer[]> = {
    stdout: [],
    stderr: [],
  };
  for (const stream of ["stdout", "stderr"] as const)
    child[stream]?.on("data", (chunk: Buffer) => {
      output[stream].push(chunk);
      observe?.(stream, chunk);
    });
  // A child may exit before consuming input; its exit status remains authoritative.
  child.stdin?.on("error", () => {
    /* Child exit status is authoritative. */
  });
  child.stdin?.end(input);
  let error: Error | undefined;
  const status = await new Promise<number | null>((resolve) => {
    child.on("error", (cause) => {
      error = cause;
    });
    child.on("close", resolve);
  });
  signal?.removeEventListener("abort", cancel);
  if (aborted && child.pid) {
    // SIGKILL is asynchronous. Allow the kernel to reap runnable descendants.
    if (cancellationError || !(await groupEnds(child.pid, 1_000))) {
      if (scope) scope.unresolved = true;
      throw new Error(
        "Owned subprocess cessation could not be verified; outcome unknown",
        { cause: cancellationError },
      );
    }
  } else if (
    owned &&
    !(await groupEnds(owned.pid, lingeringDescendants.graceMilliseconds))
  ) {
    // The command has exited, but descendants it left in its group (such as
    // a git transport helper after a connection reset) are still running.
    // Stop them and verify they are gone; the exit status stays authoritative.
    stoppedLeftovers = processGroupMembers(owned.pid);
    let stopError: unknown;
    try {
      process.kill(-owned.pid, "SIGKILL");
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ESRCH") stopError = cause;
    }
    if (stopError || !(await groupEnds(owned.pid, 1_000))) {
      if (scope) scope.unresolved = true;
      throw new Error(
        "Owned subprocess group remains active; outcome unknown",
        { cause: stopError },
      );
    }
  }
  if (owned) scope?.observe?.(owned, true);
  if (aborted)
    throw new Error("Owned subprocess cancelled after verified cessation");
  if (error) throw error;
  return {
    status,
    stdout: Buffer.concat(output.stdout).toString("utf8"),
    stderr: Buffer.concat(output.stderr).toString("utf8"),
    ...(stoppedLeftovers && { stoppedLeftovers }),
  };
}

export async function commandAsync(
  file: string,
  args: string[],
  cwd?: string,
  env?: NodeJS.ProcessEnv,
  input?: string,
): Promise<string> {
  const result = await subprocessAsync(file, args, { cwd, env }, input);
  if (result.status !== 0)
    throw new Error(
      `${file} ${args.join(" ")} failed (${result.status}): ${result.stderr || result.stdout}`,
    );
  return result.stdout.trim();
}

export function gitAsync(checkout: string, ...args: string[]): Promise<string> {
  return gitProcess(checkout, args, false);
}

export function pinnedGitAsync(
  checkout: string,
  ...args: string[]
): Promise<string> {
  return gitProcess(checkout, args, true);
}
