import { AsyncLocalStorage } from "node:async_hooks";
import { type SpawnOptions, spawn, spawnSync } from "node:child_process";
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
 * Git commands that change or walk a repository's worktree registry
 * (`.git/worktrees/<id>`), which git does not lock: `worktree remove`
 * deletes an entry file by file, and a concurrent fetch, whose connectivity
 * check resolves every worktree's HEAD, or a concurrent `worktree` command
 * dies with "Invalid path '.git/worktrees/<id>'". Concurrent fetches of one
 * branch also race on its remote-tracking ref ("incorrect old value
 * provided"). These run one at a time per repository.
 */
const SERIALIZED_GIT = new Set([
  "worktree",
  "fetch",
  "pull",
  "gc",
  "prune",
  "maintenance",
]);

function serializedGit(args: string[]): boolean {
  return SERIALIZED_GIT.has(gitSubcommand(args));
}

/** A synchronous call cannot wait for the repository lock. */
function assertUnserialized(args: string[]): void {
  if (serializedGit(args))
    throw new Error(
      `git ${gitSubcommand(args)} must run through gitAsync or pinnedGitAsync, which serialize it per repository`,
    );
}

/** The tail of each repository's FIFO queue, keyed by git common directory. */
const repositoryQueues = new Map<string, Promise<void>>();

async function withRepositoryLock<T>(
  key: string,
  run: () => Promise<T>,
): Promise<T> {
  const previous = repositoryQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  // A successor waits for every earlier holder, even one cancelled while queued.
  const tail = previous.then(() => held);
  repositoryQueues.set(key, tail);
  try {
    await turnOrCancellation(previous, currentProcessSignal());
    return await run();
  } finally {
    release();
    if (repositoryQueues.get(key) === tail) repositoryQueues.delete(key);
  }
}

function turnOrCancellation(
  turn: Promise<void>,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (!signal) return turn;
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    void turn.then(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    });
  });
}

/** Linked worktrees share their main checkout's common directory and lock. */
async function repositoryKey(
  checkout: string,
  env: NodeJS.ProcessEnv | undefined,
): Promise<string> {
  return realpathSync(
    await commandAsync(
      "git",
      [
        "-C",
        checkout,
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ],
      undefined,
      env,
    ),
  );
}

function gitProcess(
  checkout: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  const run = () =>
    commandAsync("git", ["-C", checkout, ...args], undefined, env);
  return classifiedGit(args, async () =>
    serializedGit(args)
      ? withRepositoryLock(await repositoryKey(checkout, env), run)
      : run(),
  );
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
  assertUnserialized(args);
  return classifiedGit(args, () => command("git", ["-C", checkout, ...args]));
}

/** Keep inherited Git overrides from redirecting a pinned local tree operation. */
export function pinnedGit(checkout: string, ...args: string[]): string {
  return pinnedGitRaw(checkout, ...args)
    .toString("utf8")
    .trim();
}

/** Preserve exact pinned Git output without trimming or decoding. */
export function pinnedGitRaw(checkout: string, ...args: string[]): Buffer {
  assertUnserialized(args);
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
  return env;
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
  for (const name of readdirSync("/proc")) {
    if (!/^[1-9]\d*$/.test(name)) continue;
    const identity = linuxProcessIdentity(Number(name));
    if (identity?.group === group && identity.state !== "Z") return true;
  }
  return false;
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

export async function subprocessAsync(
  file: string,
  args: string[],
  options: SpawnOptions = {},
  input?: string,
  observe?: (stream: "stdout" | "stderr", chunk: Buffer) => void,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const scope = processCancellation.getStore();
  const signal = scope?.signal;
  signal?.throwIfAborted();
  const child = spawn(file, args, { ...options, detached: true });
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
    for (
      let attempt = 0;
      attempt < 100 && processGroupExists(child.pid);
      attempt++
    )
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    if (cancellationError || processGroupExists(child.pid)) {
      if (scope) scope.unresolved = true;
      throw new Error(
        "Owned subprocess cessation could not be verified; outcome unknown",
        { cause: cancellationError },
      );
    }
  }
  if (owned && !processGroupExists(owned.pid)) scope?.observe?.(owned, true);
  else if (owned) {
    if (scope) scope.unresolved = true;
    throw new Error("Owned subprocess group remains active; outcome unknown");
  }
  if (aborted)
    throw new Error("Owned subprocess cancelled after verified cessation");
  if (error) throw error;
  return {
    status,
    stdout: Buffer.concat(output.stdout).toString("utf8"),
    stderr: Buffer.concat(output.stderr).toString("utf8"),
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
  return gitProcess(checkout, args);
}

export function pinnedGitAsync(
  checkout: string,
  ...args: string[]
): Promise<string> {
  return gitProcess(checkout, args, pinnedGitEnvironment());
}
