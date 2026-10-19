import { AsyncLocalStorage } from "node:async_hooks";
import {
  type ChildProcess,
  type SpawnOptions,
  spawn,
  spawnSync,
} from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { type Fault, StepFault, transient, withFault } from "./fault.js";
import {
  assertOrigin,
  boundRepository,
  isBoundRepository,
  OriginBindingChanged,
  remoteRepository,
} from "./origin-binding.js";

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

/** Where the subcommand is, after git's own options. */
function subcommandIndex(args: string[]): number {
  let index = 0;
  while (index < args.length && args[index]!.startsWith("-"))
    index += ["-c", "-C"].includes(args[index]!) ? 2 : 1;
  return index;
}

/** The git subcommand, with LFS subcommands named in full. */
function gitSubcommand(args: string[]): string {
  const index = subcommandIndex(args);
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

/** A git command exited non-zero; what it showed, as structure. */
export class GitFailure extends Error {
  constructor(
    message: string,
    /** The directory the command ran in (`-C`). */
    readonly directory: string,
    readonly status: number | null,
    readonly stdout: string,
    readonly stderr: string,
    readonly trace: GitTraceFacts = { errors: [], unanswered: false },
  ) {
    super(message);
  }
}

/** What a remote command's traces showed (see GitTraces). */
interface GitTraceFacts {
  /** Format strings of git's `error` trace2 events, from git and its helpers. */
  errors: string[];
  /** The final HTTP status of the last answered request, once all are answered. */
  httpStatus?: number;
  /** A request was sent and never answered. */
  unanswered: boolean;
}

/** Where trace directories live: `factory-git-<pid>-<start time>-<random>`. */
const TRACE_PREFIX = "factory-git-";

/**
 * Trace files a remote command writes, read once it ends. Git reports why a
 * transfer failed as structure only in its traces: trace2 `error` events carry
 * each message's format string (git's own source text, since Factory pins
 * LC_MESSAGES=C), and the curl trace (git) or Git LFS's trace carries every
 * HTTP request and status line. Only request and status lines are read.
 *
 * The traces can hold what a URL or header carries: the curl trace omits
 * bodies and redacts Authorization and cookie headers, but not a credential
 * inside a URL, which also appears in trace2's child arguments. So a command
 * naming a URL with userinfo is not traced, and origin bindings refuse such
 * URLs (see remoteRepository). The directory is private to this user, named
 * for the owning process, and removed after the read; removeStaleGitTraces
 * removes those of processes that died first.
 */
export class GitTraces {
  private readonly directory: string;
  private constructor(private readonly lfs: boolean) {
    const { pid, startTime } = ownIdentity();
    this.directory = mkdtempSync(
      join(tmpdir(), `${TRACE_PREFIX}${pid}-${startTime}-`),
    );
  }

  /**
   * Traces for a remote command. Other commands, and any naming an HTTP URL
   * with userinfo (a credential the traces would record), have none.
   */
  static open(args: string[]): GitTraces | undefined {
    const subcommand = gitSubcommand(args);
    if (!GIT_REMOTE.has(subcommand)) return undefined;
    if (args.some((arg) => /^https?:\/\/[^/]*@/i.test(arg))) return undefined;
    return new GitTraces(subcommand.startsWith("lfs "));
  }

  env(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    return this.lfs
      ? { ...env, GIT_TRACE: join(this.directory, "lfs") }
      : {
          ...env,
          GIT_TRACE2_EVENT: join(this.directory, "trace2"),
          GIT_TRACE_CURL: join(this.directory, "curl"),
          GIT_TRACE_CURL_NO_DATA: "1",
          GIT_TRACE_REDACT: "1",
        };
  }

  facts(): GitTraceFacts {
    const read = (name: string) => {
      try {
        return readFileSync(join(this.directory, name), "utf8").split("\n");
      } catch (error) {
        if (errorCode(error) === "ENOENT") return [];
        throw error;
      }
    };
    const errors: string[] = [];
    for (const line of read("trace2")) {
      try {
        const event = JSON.parse(line);
        if (event?.event === "error" && typeof event.fmt === "string")
          errors.push(event.fmt);
      } catch {
        /* A partial line from a killed process carries nothing. */
      }
    }
    // Request and status lines: the curl trace's `=> Send header: GET /path
    // HTTP/2` and `<= Recv header: HTTP/2 403`, or Git LFS's `HTTP: POST
    // <url>` and `HTTP: 403`.
    const [request, response] = this.lfs
      ? [/ trace git-lfs: HTTP: [A-Z]+ \S+$/, / trace git-lfs: HTTP: (\d{3})$/]
      : [
          /=> Send header: [A-Z]+ \S+ HTTP\/[\d.]+$/,
          /<= Recv header: HTTP\/[\d.]+ (\d{3})\b/,
        ];
    // Requests and final answers are counted, since Git LFS transfers
    // concurrently. A 401 challenge is normally followed by an authenticated
    // request; if that one goes unanswered, the failure is in transit.
    let requests = 0;
    let answers = 0;
    let httpStatus: number | undefined;
    for (const line of read(this.lfs ? "lfs" : "curl")) {
      const status = Number(response.exec(line)?.[1]);
      // An informational (1xx) status does not answer the request.
      if (status >= 200) {
        answers++;
        httpStatus = status;
      } else if (request.test(line)) requests++;
    }
    const unanswered = requests > answers;
    return {
      errors,
      unanswered,
      ...(!unanswered && httpStatus && { httpStatus }),
    };
  }

  close(): void {
    rmSync(this.directory, { recursive: true, force: true });
  }
}

/** The failure of a git command that exited non-zero. */
function gitFailure(
  directory: string,
  args: string[],
  result: { status: number | null; stdout: string; stderr: string },
  traces: GitTraces | undefined,
): GitFailure {
  return new GitFailure(
    `git -C ${directory} ${args.join(" ")} failed (${result.status}): ${result.stderr || result.stdout}`,
    directory,
    result.status,
    result.stdout,
    result.stderr,
    traces?.facts(),
  );
}

/**
 * Git's own messages for a transfer that broke in transit (trace2 format
 * strings in the C locale): no connection or response, a failed RPC, or a
 * connection that ended early.
 */
const IN_TRANSIT = new Set([
  "unable to access '%s': %s",
  "RPC failed; %s",
  "the remote end hung up unexpectedly",
  "early EOF",
]);
/**
 * Git's messages when the first exchange with the remote failed. Over SSH,
 * git and ssh give no structure that tells a network failure from a refused
 * key or repository (ssh exits 255 for both, before git records it), so this
 * is treated as transient: a refusal surfaces as an outage, then escalates.
 */
const INITIAL_CONTACT = new Set([
  "Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.",
  "the remote end hung up upon initial contact",
]);

/** Local commands that lock the index or refs, and die when they cannot. */
const LOCKING = new Set([
  "add",
  "rm",
  "mv",
  "commit",
  "reset",
  "checkout",
  "switch",
  "restore",
  "read-tree",
  "update-index",
  "update-ref",
  "symbolic-ref",
  "merge",
  "cherry-pick",
  "revert",
  "rebase",
  "stash",
  "tag",
  "branch",
  "worktree",
  "pack-refs",
  "apply",
]);

/**
 * Remove trace directories (see GitTraces) that this user's processes left
 * when they died before removing them. A live process's directories stay.
 */
export function removeStaleGitTraces(): void {
  const uid = process.getuid?.();
  for (const name of readdirSync(tmpdir())) {
    const owner = new RegExp(`^${TRACE_PREFIX}(\\d+)-(\\d+)-`).exec(name);
    if (!owner) continue;
    const path = join(tmpdir(), name);
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat?.isDirectory() || stat.uid !== uid) continue;
    if (processAlive({ pid: Number(owner[1]), startTime: owner[2]! })) continue;
    rmSync(path, { recursive: true, force: true });
  }
}

/** A lock file another git process holds in `directory`'s repository. */
function heldGitLock(directory: string): string | undefined {
  const result = spawnSync(
    "git",
    [
      "-C",
      directory,
      "rev-parse",
      "--path-format=absolute",
      "--git-dir",
      "--git-common-dir",
    ],
    { env: pinnedGitEnvironment(), encoding: "utf8" },
  );
  if (result.status !== 0) return undefined;
  const [gitDir, commonDir] = result.stdout.trim().split("\n");
  if (!gitDir || !commonDir) return undefined;
  const candidates = [
    join(gitDir, "index.lock"),
    join(gitDir, "HEAD.lock"),
    join(commonDir, "packed-refs.lock"),
  ];
  try {
    for (const name of readdirSync(join(commonDir, "refs"), {
      recursive: true,
    }))
      if (String(name).endsWith(".lock"))
        candidates.push(join(commonDir, "refs", String(name)));
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  return candidates.find((path) => existsSync(path));
}

/** Whether Git LFS runs at all on this host. */
function lfsInstalled(): boolean {
  return (
    spawnSync("git", ["lfs", "version"], {
      env: pinnedGitEnvironment(),
      stdio: "ignore",
    }).status === 0
  );
}

/** One ref's line in `git push --porcelain` output. */
interface PushedRef {
  flag: string;
  summary: string;
  reason?: string;
}

/** `<flag> TAB <from>:<to> TAB <summary> (<reason>)` lines (git-push OUTPUT). */
function pushedRefs(stdout: string): PushedRef[] {
  const refs: PushedRef[] = [];
  for (const line of stdout.split("\n")) {
    const fields = line.split("\t");
    if (fields.length !== 3 || fields[0]!.length !== 1) continue;
    const status = /^(\[[^\]]*\]|\S+)(?: \((.*)\))?$/.exec(fields[2]!);
    if (status)
      refs.push({
        flag: fields[0]!,
        summary: status[1]!,
        ...(status[2] !== undefined && { reason: status[2] }),
      });
  }
  return refs;
}

/**
 * The remote refused a `git push --porcelain` outright: the ref was not
 * updated. `[rejected]` is git's own refusal (a lease or fast-forward check),
 * `[remote rejected]` the remote's (a hook or branch protection).
 */
export function pushRefusal(error: unknown): PushedRef | undefined {
  if (!(error instanceof GitFailure)) return undefined;
  return pushedRefs(error.stdout).find(
    (ref) =>
      ref.flag === "!" &&
      (ref.summary === "[rejected]" || ref.summary === "[remote rejected]"),
  );
}

/**
 * Classify a failed git command (the arguments after `-C <checkout>`) from
 * structure: exit status, the push's porcelain ref status, its traces and the
 * filesystem. Remote transport, credentials and remote refusals are
 * classified; other local failures are defects.
 */
export function gitFault(args: string[], error: unknown): Fault | undefined {
  const subcommand = gitSubcommand(args);
  if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT")
    return {
      kind: "config",
      detail: "git is not installed on the controller host",
      fix: "Install git, then `factory run`",
    };
  if (error instanceof OriginBindingChanged)
    return {
      kind: "config",
      detail: error.message,
      fix: "Point origin's fetch and push URLs (and any insteadOf rewrite) at the configured GitHub repository with its default LFS route, then `factory run`",
    };
  if (error instanceof RepositoryProgramConfigured)
    return {
      kind: "config",
      detail: error.message,
      fix: `Remove ${error.key} from the target checkout's repository configuration (configure a trusted driver or transport setting in your global git configuration instead), then \`factory run\``,
    };
  // A stalled fetch was stopped so it does not hold the repository lock.
  if (error instanceof GitDeadlineExceeded)
    return transient(`git ${subcommand} stalled in transit`, false);
  if (!(error instanceof GitFailure)) return undefined;
  if (subcommand.startsWith("lfs ") && !lfsInstalled())
    return {
      kind: "config",
      detail: "Git LFS is not installed on the controller host",
      fix: "Install Git LFS, then `factory run`",
    };
  if (!GIT_REMOTE.has(subcommand)) {
    // Another git process holds a lock this command needed; it releases it
    // shortly. Git dies (exit 128) when it cannot take a lock. A lock left by
    // a killed process stays, so the detail names it for the operator.
    const lock =
      LOCKING.has(subcommand) && error.status === 128
        ? heldGitLock(error.directory)
        : undefined;
    return lock
      ? transient(`git ${subcommand} found ${lock} held`, false)
      : undefined;
  }
  const push = subcommand === "push" || subcommand === "lfs push";
  const refused = pushedRefs(error.stdout).find((ref) => ref.flag === "!");
  if (refused?.summary === "[remote failure]")
    return transient("git push got no status from the remote", true);
  if (refused?.summary === "[remote rejected]") {
    // GitHub names an oversized file only in its hook's message, which
    // reaches git as remote stderr with no structure; its stable error code
    // is matched, never the prose around it.
    if (/\bGH001\b/.test(error.stderr))
      return {
        kind: "work",
        evidence: {
          detail: `git push refused a file over the size limit: ${error.message}`,
        },
      };
  }
  // Whose head the remote holds is known only at the push site, which
  // checks it with ls-remote (see pushBranch).
  if (pushRefusal(error)) return undefined;
  const { errors, httpStatus, unanswered } = error.trace;
  if (
    unanswered ||
    httpStatus === 408 ||
    httpStatus === 429 ||
    (httpStatus !== undefined && httpStatus >= 500)
  )
    return transient(`git ${subcommand} failed in transit`, push);
  if (httpStatus === 401 || httpStatus === 403 || httpStatus === 404)
    return {
      kind: "config",
      detail: `git ${subcommand} was refused credentials or access (HTTP ${httpStatus})`,
      fix: "Check `gh auth status` and the origin remote's credentials, then `factory run`",
    };
  if (errors.some((format) => IN_TRANSIT.has(format)))
    return transient(`git ${subcommand} failed in transit`, push);
  if (errors.some((format) => INITIAL_CONTACT.has(format)))
    return transient(
      `git ${subcommand} could not reach origin, or origin refused its credentials`,
      false,
    );
  return undefined;
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
 * Factory's fetches write no shared ref (see fetchHead). Controllers of
 * different Objectives share a checkout from separate processes, so the lock
 * holds across processes too (see withRegistryFiles).
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
  const signal = currentProcessSignal();
  assertProcessActive();
  const turn = lock.acquire(mode, signal);
  let held = false;
  try {
    await turn;
    held = true;
    assertProcessActive();
    return await withRegistryFiles(key, mode, signal, run);
  } finally {
    if (held) lock.release(mode);
    if (lock.idle) repositoryLocks.delete(key);
  }
}

/** Whether the process a lock file names is still that exact, live process. */
export function processAlive(owner: {
  pid: number;
  startTime: string;
}): boolean {
  const current = linuxProcessIdentity(owner.pid);
  return current?.startTime === owner.startTime && current.state !== "Z";
}

const guardWait = new Int32Array(new SharedArrayBuffer(4));

/** The identity lock files and guards record: one process life. */
export function ownIdentity(): { pid: number; startTime: string } {
  const identity = linuxProcessIdentity(process.pid);
  if (!identity) throw new Error("Cannot establish process identity");
  return { pid: process.pid, startTime: identity.startTime };
}

function errorCode(error: unknown): string {
  return (error as NodeJS.ErrnoException).code ?? "";
}

/**
 * Take a lock directory's guard: a directory only one process holds, naming
 * its holder inside (`holder`, the identity the lock files carry). A take
 * renames a prepared directory onto the guard's path, which fails while a
 * guard is there, so a guard never exists without its holder. Holders keep
 * it for milliseconds, without awaiting; a live holder still there after a
 * second is refused. A guard whose holder process is gone is reclaimed by
 * renaming it to a tombstone named for that process. The tombstone stays:
 * a contender that saw the same dead holder may still rename the path, and
 * only a non-empty directory in its way stops it from taking a live guard.
 */
export function takeGuard(guard: string): void {
  const prepared = `${guard}.take-${randomUUID()}`;
  mkdirSync(prepared, { mode: 0o700 });
  try {
    writeFileSync(join(prepared, "holder"), JSON.stringify(ownIdentity()), {
      mode: 0o600,
    });
    for (let waits = 0; ; ) {
      try {
        renameSync(prepared, guard);
        return;
      } catch (error) {
        if (!["EEXIST", "ENOTEMPTY"].includes(errorCode(error))) throw error;
      }
      const holder = guardHolder(guard);
      if (!holder) continue;
      if (!processAlive(holder)) {
        try {
          renameSync(guard, `${guard}.dead-${holder.pid}-${holder.startTime}`);
        } catch (error) {
          if (!["ENOENT", "EEXIST", "ENOTEMPTY"].includes(errorCode(error)))
            throw error;
        }
        continue;
      }
      if (++waits >= 100)
        throw new Error(
          `Factory's lock guard ${guard} is held by process ${holder.pid}`,
        );
      Atomics.wait(guardWait, 0, 0, 10);
    }
  } catch (error) {
    rmSync(prepared, { recursive: true, force: true });
    throw error;
  }
}

/** The guard's holder, or undefined once the guard is gone. */
function guardHolder(
  guard: string,
): { pid: number; startTime: string } | undefined {
  try {
    if (readdirSync(guard).includes("holder")) {
      const value = JSON.parse(readFileSync(join(guard, "holder"), "utf8"));
      if (
        Number.isSafeInteger(value?.pid) &&
        typeof value.startTime === "string"
      )
        return value;
    }
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    if (!(error instanceof SyntaxError)) throw error;
  }
  throw new Error(
    `Factory's lock guard ${guard} names no holder process; remove it if no Factory process is running`,
  );
}

/** Let the guard go without a moment where it exists empty. */
export function releaseGuard(guard: string): void {
  const released = `${guard}.released-${randomUUID()}`;
  renameSync(guard, released);
  rmSync(released, { recursive: true, force: true });
}

/** Where a checkout's cross-process registry lock lives, keyed by git common directory. */
function registryLockDirectory(key: string): string {
  return join(
    process.env.XDG_STATE_HOME ??
      join(process.env.HOME ?? "", ".local", "state"),
    "clockgrove-factory",
    "git-locks",
    createHash("sha256").update(key).digest("hex").slice(0, 32),
  );
}

/**
 * The repository lock across processes, with the controller lock's
 * mechanism: files naming their holder's process identity, changed only
 * under a guard, and a file whose process is gone is stale and removed. Each
 * git command publishes `reader-ID`, or `writer` for an exclusive one, in a
 * directory under Factory's state keyed by the git common directory. A
 * published writer holds off new readers and runs once no reader is left.
 */
export async function withRegistryFiles<T>(
  key: string,
  mode: LockMode,
  signal: AbortSignal | undefined,
  run: () => Promise<T>,
): Promise<T> {
  assertProcessActive();
  signal?.throwIfAborted();
  const directory = registryLockDirectory(key);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const id = randomUUID();
  const own = mode === "exclusive" ? "writer" : `reader-${id}`;
  const record = JSON.stringify({ ...ownIdentity(), id });
  const guarded = <R>(body: () => R): R => {
    takeGuard(join(directory, ".guard"));
    try {
      return body();
    } finally {
      releaseGuard(join(directory, ".guard"));
    }
  };
  /** A holder file's live holder; a stale or partial file is removed. */
  const holder = (name: string) => {
    let value: { id: string; pid: number; startTime: string } | undefined;
    try {
      value = JSON.parse(readFileSync(join(directory, name), "utf8"));
    } catch (error) {
      // Absent, or partial from a holder that crashed while publishing. Any
      // other failure must not remove a live holder's record.
      if (errorCode(error) !== "ENOENT" && !(error instanceof SyntaxError))
        throw error;
    }
    if (value && typeof value === "object" && processAlive(value)) return value;
    rmSync(join(directory, name), { force: true });
    return undefined;
  };
  const release = () =>
    guarded(() => {
      if (holder(own)?.id === id) rmSync(join(directory, own));
    });
  try {
    for (;;) {
      assertProcessActive();
      signal?.throwIfAborted();
      const granted = guarded(() => {
        assertProcessActive();
        signal?.throwIfAborted();
        const writer = existsSync(join(directory, "writer"))
          ? holder("writer")
          : undefined;
        if (writer && writer.id !== id) return false;
        if (!writer) writeFileSync(join(directory, own), record);
        if (mode === "shared") return true;
        return !readdirSync(directory).some(
          (name) => name.startsWith("reader-") && holder(name),
        );
      });
      if (granted) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
      signal?.throwIfAborted();
    }
  } catch (error) {
    release();
    throw error;
  }
  try {
    assertProcessActive();
    signal?.throwIfAborted();
    return await run();
  } finally {
    release();
  }
}

/**
 * Await one archive publisher across controllers, separately from Git's
 * registry lock.
 */
export async function withCheckpointPublication<T>(
  publicationGuard: string,
  run: () => Promise<T>,
): Promise<T> {
  assertProcessActive();
  const directory = realpathSync(dirname(publicationGuard));
  const guard = join(directory, basename(publicationGuard));
  return withRepositoryLock(
    `checkpoint-publication:${guard}`,
    "exclusive",
    async () => {
      assertProcessActive();
      return await run();
    },
  );
}

/**
 * Configuration pinned for every git command Factory runs. Workers, and the
 * tools workers and validation commands run, can write the checkout's shared
 * repository configuration, so nothing configured there may run a program
 * inside Factory's git, which has the controller's environment and
 * credentials. Command-line scope overrides the repository's values:
 * - no background maintenance, which would walk the worktree registry unlocked;
 * - no hooks, fsmonitor, signing, signature verification or alternate-refs
 *   command (external diff and textconv: see withoutDiffPrograms);
 * - no `ext::` or `git://` transport, which an insteadOf could rewrite
 *   origin to, and origin's upload-pack and receive-pack fixed;
 * - no credential helper or askpass, except the operator's own for remote
 *   commands (see operatorRemoteSettings).
 * Drivers named by attributes cannot be pinned in advance: see
 * assertNoRepositoryPrograms.
 */
const GIT_CONFIG: [string, string][] = [
  ["maintenance.auto", "false"],
  ["gc.auto", "0"],
  ["core.hooksPath", "/dev/null"],
  ["core.fsmonitor", "false"],
  // Never descend into a submodule: its configuration is not Factory's.
  ["diff.ignoreSubmodules", "all"],
  ["submodule.recurse", "false"],
  ["core.alternateRefsCommand", ""],
  ["commit.gpgSign", "false"],
  ["tag.gpgSign", "false"],
  ["push.gpgSign", "false"],
  ["merge.verifySignatures", "false"],
  ["log.showSignature", "false"],
  ["protocol.ext.allow", "never"],
  ["protocol.git.allow", "never"],
  ["remote.origin.uploadpack", "git-upload-pack"],
  ["remote.origin.receivepack", "git-receive-pack"],
  // An empty helper clears every helper configured before it.
  ["credential.helper", ""],
  ["core.askPass", ""],
];

/**
 * Program-running configuration named by attributes or used by Git LFS. A
 * definition in the repository's configuration (local or worktree scope,
 * with includes) stops Factory's git with a configuration fault instead of
 * running. Operator configuration (global or system scope) is trusted.
 */
const REPOSITORY_PROGRAMS =
  "filter\\..+\\.(clean|smudge|process)|merge\\..+\\.driver|lfs\\.customtransfer\\..+\\.path|lfs\\.extension\\..+\\.(clean|smudge)|remote\\..+\\.vcs";
/**
 * Transport settings a remote command must take only from the operator:
 * proxies, TLS verification and trust, connection resolution and extra
 * headers decide where credentials go. A repository-scope `http.<url>.*`
 * key would outrank any generic pin by URL specificity, so these are refused
 * rather than overridden.
 */
const REPOSITORY_TRANSPORT = "http\\..+|remote\\..+\\.(proxy|proxyauthmethod)";
/** Transfer tuning that a repository may set. */
const HARMLESS_TRANSPORT =
  /^http\.(.+\.)?(postbuffer|lowspeedlimit|lowspeedtime|maxrequests)$/;
/** The filter commands `git lfs install` writes. */
const LFS_FILTER_COMMANDS: Record<string, string[]> = {
  "filter.lfs.clean": ["git-lfs clean -- %f"],
  "filter.lfs.smudge": ["git-lfs smudge -- %f", "git-lfs smudge --skip -- %f"],
  "filter.lfs.process": [
    "git-lfs filter-process",
    "git-lfs filter-process --skip",
  ],
};

/** The repository's configuration would run a program inside Factory's git. */
class RepositoryProgramConfigured extends Error {
  constructor(
    readonly directory: string,
    readonly key: string,
  ) {
    super(
      `Repository configuration for ${directory} defines ${key}; Factory's git takes programs and remote transport settings only from operator (global or system) configuration, apart from Git LFS's own filter`,
    );
  }
}

/**
 * One `git config --show-scope --get-regexp` read as [scope, key, value,
 * origin]. NUL-terminated records ("scope\0key\nvalue\0", with
 * "origin\0" after the scope when requested), so a value containing a
 * newline or tab stays inside its own entry. A key without a value (an
 * implicit boolean true) has value undefined.
 */
function configEntries(
  directory: string,
  env: NodeJS.ProcessEnv,
  pattern: string,
  origins = false,
): [string, string, string | undefined, string | undefined][] {
  // Without the directory there is no repository configuration to read;
  // the command itself reports the missing directory.
  if (!existsSync(directory)) return [];
  const result = spawnSync(
    "git",
    [
      "-C",
      directory,
      "config",
      "--null",
      ...(origins ? ["--show-origin"] : []),
      "--show-scope",
      "--includes",
      "--get-regexp",
      pattern,
    ],
    { env, encoding: "utf8" },
  );
  if (result.error) throw result.error;
  if (result.status === 1) return [];
  if (result.status !== 0)
    throw new Error(
      `git config --get-regexp failed (${result.status}): ${result.stderr}`,
    );
  const fields = result.stdout.split("\0");
  const width = origins ? 3 : 2;
  if (fields.pop() !== "" || fields.length % width)
    throw new Error("git config returned malformed entries");
  const entries: [string, string, string | undefined, string | undefined][] =
    [];
  for (let index = 0; index < fields.length; index += width) {
    const entry = fields[index + width - 1]!;
    const origin = origins ? fields[index + 1] : undefined;
    const newline = entry.indexOf("\n");
    entries.push(
      newline < 0
        ? [fields[index]!, entry, undefined, origin]
        : [
            fields[index]!,
            entry.slice(0, newline),
            entry.slice(newline + 1),
            origin,
          ],
    );
  }
  return entries;
}

const repositoryScope = (scope: string) =>
  scope === "local" || scope === "worktree";

/**
 * Passed repository-program checks, so a later Factory git command in the
 * same repository does not spawn a second `git config` process. Spawning
 * from a large controller costs tens of milliseconds each. An entry holds
 * only a pass, keyed by directory, pattern and the exact environment, and is
 * valid while every file that decides which repository configuration git
 * reads keeps its exact stat identity (see repositoryConfigFiles). Any
 * change, including a same-size rewrite or a replaced `.git`, runs the full
 * check again.
 */
const programChecks = new Map<string, { paths: string[]; identity: string }>();
const PROGRAM_CHECKS = 256;
/** A file modified this recently may change again within its timestamp tick. */
const RACY_CONFIG_MS = 2_000;
/** Configuration whose presence makes a pass uncacheable, or locates the file. */
const CACHE_PROBE =
  "core\\.repositoryformatversion|extensions\\.worktreeconfig|include\\..+|includeif\\..+";
const CACHE_BLOCKERS =
  /^(extensions\.worktreeconfig|include\..+|includeif\..+)$/;

/**
 * The files deciding which repository configuration git reads in a
 * directory that is itself a repository root: a main worktree (`.git`
 * directory), a linked worktree (`.git` file naming its gitdir and
 * commondir) or a bare repository. Anything else (a subdirectory, a symlinked
 * `.git`, an environment-selected gitdir) is not cached.
 */
function repositoryConfigFiles(
  directory: string,
):
  | { gitdir: string; common: string; config: string; paths: string[] }
  | undefined {
  try {
    const dot = join(directory, ".git");
    const stat = lstatSync(dot, { throwIfNoEntry: false });
    let gitdir: string;
    if (stat?.isDirectory()) gitdir = dot;
    else if (stat?.isFile()) {
      const named = /^gitdir: (.+)\n?$/.exec(readFileSync(dot, "utf8"));
      if (!named) return undefined;
      gitdir = resolve(directory, named[1]!);
    } else if (!stat) gitdir = directory;
    else return undefined;
    const commondir = join(gitdir, "commondir");
    const common = existsSync(commondir)
      ? resolve(gitdir, readFileSync(commondir, "utf8").trim())
      : gitdir;
    const config = join(common, "config");
    return {
      gitdir,
      common,
      config,
      // Gitdir validity (HEAD, objects, refs) decides whether discovery stops
      // here; the `.git` entry and commondir decide where it points.
      paths: [
        dot,
        gitdir,
        join(gitdir, "HEAD"),
        commondir,
        common,
        join(common, "objects"),
        join(common, "refs"),
        config,
      ],
    };
  } catch {
    return undefined;
  }
}

/**
 * Exact stat identities: inode and timestamps for files, inode alone for
 * directories (whose timestamps change with every index or ref write), and
 * absence. Undefined when a file changed within RACY_CONFIG_MS, or when any
 * path is a symlink: lstat identifies the link, not its target, so a later
 * change to the target (a config, commondir or HEAD it points at) would stay
 * invisible.
 */
function statIdentity(paths: string[], racy: boolean): string | undefined {
  const now = BigInt(Date.now()) * 1_000_000n;
  const window = BigInt(RACY_CONFIG_MS) * 1_000_000n;
  const identities: string[] = [];
  for (const path of paths) {
    const stat = lstatSync(path, { bigint: true, throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) return undefined;
    if (!stat) identities.push("absent");
    else if (stat.isDirectory())
      identities.push(`d:${stat.dev}:${stat.ino}:${stat.mode}`);
    else {
      if (racy && (now - stat.mtimeNs < window || now - stat.ctimeNs < window))
        return undefined;
      identities.push(
        `f:${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`,
      );
    }
  }
  return identities.join("\0");
}

function sameFile(left: string, right: string): boolean {
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return false;
  }
}

/** Refuse repository-scope programs, and for a remote command its transport. */
function assertNoRepositoryPrograms(
  directory: string,
  env: NodeJS.ProcessEnv,
  remote: boolean,
): void {
  const programs = `${REPOSITORY_PROGRAMS}${remote ? `|${REPOSITORY_TRANSPORT}` : ""}`;
  // An environment-selected repository is not located by directory alone.
  const key =
    env.GIT_DIR === undefined && env.GIT_COMMON_DIR === undefined
      ? createHash("sha256")
          .update(
            JSON.stringify([
              resolve(directory),
              programs,
              Object.entries(env).sort(([a], [b]) => (a < b ? -1 : 1)),
            ]),
          )
          .digest("hex")
      : undefined;
  const cached = key ? programChecks.get(key) : undefined;
  if (cached && statIdentity(cached.paths, false) === cached.identity) {
    programChecks.delete(key!);
    programChecks.set(key!, cached);
    return;
  }
  if (key) programChecks.delete(key);
  // Identities are taken before git reads the configuration, so a change
  // after this point always differs from the cached identity.
  const files = key ? repositoryConfigFiles(directory) : undefined;
  const identity = files && statIdentity(files.paths, true);
  let located = false;
  let cacheable = identity !== undefined;
  for (const [scope, name, value, origin] of configEntries(
    directory,
    env,
    `^(${programs}${cacheable ? `|${CACHE_PROBE}` : ""})$`,
    cacheable,
  )) {
    if (!repositoryScope(scope)) continue;
    // Every repository-scope entry must come from the one predicted file.
    if (
      cacheable &&
      !(
        origin?.startsWith("file:") &&
        sameFile(resolve(directory, origin.slice(5)), files!.config)
      )
    )
      cacheable = false;
    if (CACHE_BLOCKERS.test(name)) {
      cacheable = false;
      continue;
    }
    if (name === "core.repositoryformatversion") {
      located = true;
      continue;
    }
    // Git LFS's own filter: the whole value must be one git-lfs writes.
    if (value !== undefined && LFS_FILTER_COMMANDS[name]?.includes(value))
      continue;
    if (HARMLESS_TRANSPORT.test(name)) continue;
    throw new RepositoryProgramConfigured(directory, name);
  }
  if (!cacheable || !located) return;
  // Confirm git itself located the predicted repository (relative origins
  // name files from its root), and that nothing changed meanwhile.
  const discovered = spawnSync(
    "git",
    [
      "-C",
      directory,
      "rev-parse",
      "--path-format=absolute",
      "--absolute-git-dir",
      "--git-common-dir",
    ],
    { env, encoding: "utf8" },
  );
  const [gitdir, common, extra] =
    discovered.status === 0 && !discovered.error
      ? discovered.stdout.split("\n")
      : [];
  if (
    !gitdir ||
    !common ||
    extra !== "" ||
    !sameFile(gitdir, files!.gitdir) ||
    !sameFile(common, files!.common) ||
    statIdentity(files!.paths, true) !== identity
  )
    return;
  programChecks.set(key!, { paths: files!.paths, identity: identity! });
  if (programChecks.size > PROGRAM_CHECKS)
    programChecks.delete(programChecks.keys().next().value!);
}

/** Tests serve origin from local bare repositories; nothing else sets this. */
const localOriginsForTests = () =>
  process.env.FACTORY_TEST_LOCAL_ORIGINS === "1";

/** The first argument after the subcommand that is not an option. */
function firstOperand(args: string[]): string | undefined {
  return args
    .slice(subcommandIndex(args) + 1)
    .find((arg) => !arg.startsWith("-"));
}

/**
 * An ambient remote command talks to the bound origin: verify that origin's
 * fetch and push URLs (after rewriting) and LFS route still serve the bound
 * repository. A clone, which runs outside any repository, must name a bound
 * repository's URL; only operator configuration can rewrite it.
 */
function assertBoundOrigin(
  directory: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): void {
  const repository = boundRepository(directory);
  if (repository) {
    assertOrigin(directory, repository, env);
    return;
  }
  if (gitSubcommand(args) === "clone") {
    const source = remoteRepository(firstOperand(args) ?? "");
    if (source && isBoundRepository(source)) return;
  }
  if (localOriginsForTests()) return;
  throw new OriginBindingChanged(
    `git ${gitSubcommand(args)} in ${directory} does not use a bound target repository origin`,
  );
}

/**
 * For a remote command, the operator's own credential helpers, askpass and
 * SSH command (global or system scope, or the environment) replace whatever
 * the repository configures. Without an operator SSH command, a stalled SSH
 * transfer is bounded like an HTTP one; these options take precedence over
 * ~/.ssh/config, so set GIT_SSH_COMMAND or a global core.sshCommand to
 * choose others.
 */
function withOperatorRemoteSettings(
  directory: string,
  env: NodeJS.ProcessEnv,
  operator: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  // Discover only the operator's config sources without restoring inherited
  // repository, command-scope or index overrides into the pinned lookup.
  const lookup = { ...env };
  for (const key of [
    "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_SYSTEM",
    "GIT_CONFIG_NOSYSTEM",
  ]) {
    if (operator[key] === undefined) delete lookup[key];
    else lookup[key] = operator[key];
  }
  const entries: [string, string][] = [];
  let sshCommand: string | undefined;
  for (const [scope, key, value = ""] of configEntries(
    directory,
    lookup,
    "^(credential\\..*helper|core\\.askpass|core\\.sshcommand)$",
  )) {
    if (scope !== "global" && scope !== "system") continue;
    if (key === "core.sshcommand") sshCommand = value;
    else if (key === "core.askpass") entries.push(["core.askPass", value]);
    else entries.push([key, value]);
  }
  return {
    ...withGitConfig(env, entries),
    GIT_ASKPASS: operator.GIT_ASKPASS,
    GIT_SSH_COMMAND:
      operator.GIT_SSH_COMMAND ||
      sshCommand ||
      (operator.GIT_SSH
        ? `'${operator.GIT_SSH.replaceAll("'", "'\\''")}'`
        : SSH_KEEPALIVE_COMMAND),
  };
}

/** External diff and textconv drivers are programs from configuration. */
function withoutDiffPrograms(args: string[]): string[] {
  const index = subcommandIndex(args);
  return ["diff", "show", "log"].includes(args[index] ?? "")
    ? [
        ...args.slice(0, index + 1),
        "--no-ext-diff",
        "--no-textconv",
        ...args.slice(index + 1),
      ]
    : args;
}

/** Everything a Factory git command runs with: arguments and environment. */
function factoryGit(
  directory: string,
  args: string[],
  pinned: boolean,
  overrides: NodeJS.ProcessEnv = {},
): { args: string[]; env: NodeJS.ProcessEnv } {
  const operator = { ...process.env };
  let env = {
    ...(pinned ? pinnedGitEnvironment() : ambientGitEnvironment()),
    ...overrides,
  };
  const remote = GIT_REMOTE.has(gitSubcommand(args));
  if (remote) env = withOperatorRemoteSettings(directory, env, operator);
  if (["fetch", "pull"].includes(gitSubcommand(args)))
    env = withGitConfig(env, LOCKED_NETWORK_CONFIG);
  assertNoRepositoryPrograms(directory, env, remote);
  // Ambient remote commands reach origin; pinned ones read Factory's own
  // local repositories by path.
  if (remote && !pinned) {
    if (!localOriginsForTests())
      env = withGitConfig(env, [["protocol.file.allow", "never"]]);
    assertBoundOrigin(directory, args, env);
  }
  // Git's messages and trace2 format strings follow the message locale; pin
  // git's own wording so what Factory reads of them (see gitFault) cannot
  // vary. LC_ALL and LANGUAGE would override LC_MESSAGES.
  const { LANGUAGE: _language, LC_ALL: _all, ...unlocalized } = env;
  return {
    args: ["-C", directory, ...withoutDiffPrograms(args)],
    env: { ...unlocalized, LC_MESSAGES: "C" },
  };
}
/** A stalled transfer must not hold the repository lock indefinitely. */
const LOCKED_NETWORK_CONFIG: [string, string][] = [
  ["http.lowSpeedLimit", "1000"],
  ["http.lowSpeedTime", "60"],
];
/** Deadline for a locked network command (fetch, pull). */
const LOCKED_NETWORK_DEADLINE_MS = 15 * 60_000;
/** The SSH counterpart of the HTTP low-speed bound: 4 unanswered 15 s probes. */
const SSH_KEEPALIVE_COMMAND =
  "ssh -o ServerAliveInterval=15 -o ServerAliveCountMax=4";

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

/**
 * The operator's environment with Factory's pins. Inherited
 * GIT_CONFIG_PARAMETERS (`git -c`) would override them, so it is dropped.
 */
function ambientGitEnvironment(): NodeJS.ProcessEnv {
  const { GIT_CONFIG_PARAMETERS: _, ...env } = process.env;
  return withGitConfig(env, GIT_CONFIG);
}

/** A locked network command outlived LOCKED_NETWORK_DEADLINE_MS. */
class GitDeadlineExceeded extends Error {}

function gitProcess(
  checkout: string,
  args: string[],
  pinned: boolean,
  overrides?: NodeJS.ProcessEnv,
  /** The caller already holds the repository lock (withWorktreeRegistry). */
  locked = false,
): Promise<string> {
  const mode = locked ? undefined : gitLockMode(args);
  const network = ["fetch", "pull"].includes(gitSubcommand(args));
  const run = async () => {
    const deadline = network
      ? AbortSignal.timeout(LOCKED_NETWORK_DEADLINE_MS)
      : undefined;
    let traces: GitTraces | undefined;
    try {
      const command = factoryGit(checkout, args, pinned, overrides);
      traces = GitTraces.open(args);
      const result = await subprocessAsync("git", command.args, {
        env: traces ? traces.env(command.env) : command.env,
        ...(deadline && { signal: deadline }),
      });
      if (result.status !== 0) throw gitFailure(checkout, args, result, traces);
      return result.stdout.trim();
    } catch (error) {
      if (deadline?.aborted && !currentProcessSignal()?.aborted)
        throw new GitDeadlineExceeded(
          `git ${gitSubcommand(args)} exceeded ${LOCKED_NETWORK_DEADLINE_MS / 1000}s`,
          { cause: error },
        );
      throw error;
    } finally {
      traces?.close();
    }
  };
  return classifiedGit(args, () => {
    if (!mode) return run();
    let key: string;
    try {
      key = repositoryKey(
        checkout,
        pinned ? pinnedGitEnvironment() : process.env,
      );
    } catch (error) {
      return Promise.reject(error);
    }
    return withRepositoryLock(key, mode, run);
  });
}

/**
 * Run `body` holding `checkout`'s worktree-registry lock exclusively, so what
 * it reads from the registry still holds when it acts on it: no other
 * command, in this process or another controller's, reads or changes the
 * registry in between. `git` runs a pinned command under that one hold (the
 * locking wrappers would wait for it).
 */
export async function withWorktreeRegistry<T>(
  checkout: string,
  body: (git: (...args: string[]) => Promise<string>) => Promise<T>,
): Promise<T> {
  return withRepositoryLock(
    repositoryKey(checkout, pinnedGitEnvironment()),
    "exclusive",
    () => body((...args) => gitProcess(checkout, args, true, undefined, true)),
  );
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
  return syncGit(checkout, args, false, undefined).toString("utf8").trim();
}

/** Keep inherited Git overrides from redirecting a pinned local tree operation. */
export function pinnedGit(checkout: string, ...args: string[]): string {
  return pinnedGitRaw(checkout, ...args)
    .toString("utf8")
    .trim();
}

/** Preserve exact pinned Git output without trimming or decoding. */
export function pinnedGitRaw(checkout: string, ...args: string[]): Buffer {
  return pinnedGitRawWithin(checkout, undefined, ...args);
}

/** `pinnedGitRaw` killed after `timeoutMs`, which then throws. */
export function pinnedGitRawWithin(
  checkout: string,
  timeoutMs: number | undefined,
  ...args: string[]
): Buffer {
  return syncGit(checkout, args, true, timeoutMs);
}

/**
 * `pinnedGitRaw` with a deadline, optional standard input and environment
 * overrides, such as `check-ignore --stdin`, which refuses literal pathspecs.
 */
export function pinnedGitRawWith(
  checkout: string,
  options: { timeoutMs: number; input?: string; env?: NodeJS.ProcessEnv },
  ...args: string[]
): Buffer {
  return syncGit(
    checkout,
    args,
    true,
    options.timeoutMs,
    options.input,
    options.env,
  );
}

/** `pinnedGitRaw` with standard input, such as a `cat-file --batch` request. */
export function pinnedGitRawInput(
  checkout: string,
  input: string,
  ...args: string[]
): Buffer {
  return syncGit(checkout, args, true, undefined, input);
}

function syncGit(
  checkout: string,
  args: string[],
  pinned: boolean,
  timeoutMs: number | undefined,
  input?: string,
  overrides?: NodeJS.ProcessEnv,
): Buffer {
  assertUnlocked(args);
  return classifiedGit(args, () => {
    const factory = factoryGit(checkout, args, pinned, overrides);
    const traces = GitTraces.open(args);
    try {
      const result = spawnSync("git", factory.args, {
        env: traces ? traces.env(factory.env) : factory.env,
        maxBuffer: Number.MAX_SAFE_INTEGER,
        ...(input !== undefined && { input }),
        ...(timeoutMs !== undefined && {
          timeout: timeoutMs,
          killSignal: "SIGKILL" as const,
        }),
      });
      if (result.error) throw result.error;
      if (result.status !== 0)
        throw gitFailure(
          checkout,
          args,
          {
            status: result.status,
            stdout: result.stdout.toString("utf8"),
            stderr: result.stderr.toString("utf8"),
          },
          traces,
        );
      return result.stdout;
    } finally {
      traces?.close();
    }
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

/** The current npm installation's sole Factory launcher is controller-only.
 * Never grant a private bin directory or remove unrelated tools from PATH.
 */
export function workerToolchainPath(
  path: string | undefined,
): string | undefined {
  if (path === undefined) return undefined;
  const launcher = fileURLToPath(new URL("./cli.js", import.meta.url));
  const bin = resolve(dirname(dirname(launcher)), "..", "..", ".bin");
  try {
    return path
      .split(":")
      .filter((entry) => {
        if (!isAbsolute(entry) || !existsSync(entry) || !existsSync(bin))
          return true;
        if (realpathSync(entry) !== realpathSync(bin)) return true;
        const contents = readdirSync(entry);
        if (contents.length !== 1 || contents[0] !== "factory") return true;
        const candidate = join(entry, "factory");
        return (
          !lstatSync(candidate).isSymbolicLink() ||
          realpathSync(candidate) !== realpathSync(launcher)
        );
      })
      .join(":");
  } catch {
    // Unknown installation identity keeps the original guarded PATH.
    return path;
  }
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
    "XDG_STATE_HOME",
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
  if (env.PATH !== undefined) env.PATH = workerToolchainPath(env.PATH)!;
  return env;
}

/** Validation and its read-only lookup use the supplied PATH, not login profiles. */
export function localValidationShellArguments(command: string): string[] {
  return ["-c", command];
}

export function localValidationEnvironment(
  credentialDirectory: string,
): Record<string, string> {
  const env = sanitizedWorkerEnvironment(credentialDirectory);
  // Validation uses the exact host toolchain declared by the controller.
  if (process.env.PATH !== undefined) env.PATH = process.env.PATH;
  return env;
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

/** A spawned process group leader's recorded identity, for later cessation proof. */
export interface NativeProcessOwner {
  pid: number;
  group: number;
  startTime: string;
  namespace: string;
  uid: number;
  /** The kernel boot the process ran in; absent from earlier receipts. */
  boot?: string;
}
export function isNativeProcessOwner(
  value: unknown,
): value is NativeProcessOwner {
  const owner = value as Partial<NativeProcessOwner> | null;
  return (
    typeof owner === "object" &&
    owner !== null &&
    Number.isSafeInteger(owner.pid) &&
    owner.pid! > 0 &&
    owner.group === owner.pid &&
    Number.isSafeInteger(owner.uid) &&
    typeof owner.startTime === "string" &&
    typeof owner.namespace === "string" &&
    (owner.boot === undefined || typeof owner.boot === "string")
  );
}
let kernelBoot: string | undefined;
/** This kernel boot's identity; it cannot change while this process runs. */
function currentBoot(): string {
  kernelBoot ??= readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  return kernelBoot;
}
/**
 * The identity of `pid`, a just-spawned child, or undefined unless it leads
 * its own group.
 */
export function nativeProcessOwner(
  pid: number,
): NativeProcessOwner | undefined {
  const boot = currentBoot();
  const identity = linuxProcessIdentity(pid);
  if (!identity || identity.group !== pid) return undefined;
  return {
    pid,
    group: identity.group,
    startTime: identity.startTime,
    namespace: readlinkSync("/proc/self/ns/pid"),
    uid: process.getuid!(),
    boot,
  };
}
/**
 * Whether the recorded process may still run. `settled` is a proof that it
 * and its group ceased: a later boot ended every process of an earlier one,
 * whatever its namespace; within the recorded namespace, the leader is gone
 * or its pid now names another process, and no process remains in its group.
 * `active` is only ever the exact recorded process or its group, so a caller
 * never signals a process it cannot identify. Anything else is `unknown`.
 */
export function nativeProcessDisposition(
  owner: NativeProcessOwner | undefined,
): "active" | "settled" | "unknown" {
  if (!isNativeProcessOwner(owner) || owner.uid !== process.getuid?.())
    return "unknown";
  if (owner.boot !== undefined && owner.boot !== currentBoot())
    return "settled";
  if (owner.namespace !== readlinkSync("/proc/self/ns/pid")) return "unknown";
  const current = linuxProcessIdentity(owner.pid);
  if (current?.startTime === owner.startTime) {
    // The recorded process itself still runs; outside its group it is unowned.
    if (current.group !== owner.group) return "unknown";
    return processGroupExists(owner.group) ? "active" : "settled";
  }
  // The leader is gone or its pid is reused. A reused pid's group may be
  // another owner's, so only an empty group proves cessation.
  if (processGroupExists(owner.group)) return current ? "unknown" : "active";
  return "settled";
}

interface OwnedSubprocess {
  pid: number;
  startTime: string;
}
export class UnsettledSubprocessError extends Error {
  override readonly name = "UnsettledSubprocessError";
}
interface ProcessScope {
  unresolved?: boolean;
  signal?: AbortSignal;
  /** Observational metadata for a deadline already armed by the controller. */
  deadlineAt?: string;
  observe?: (process: OwnedSubprocess, settled: boolean) => void;
}
const processCancellation = new AsyncLocalStorage<ProcessScope>();
export function hasUnresolvedSubprocesses(): boolean {
  return processCancellation.getStore()?.unresolved === true;
}
export function currentProcessSignal(): AbortSignal | undefined {
  return processCancellation.getStore()?.signal;
}

/** Check the original armed boundary even before its timer can run. */
export function assertProcessActive(): void {
  const scope = processCancellation.getStore();
  scope?.signal?.throwIfAborted();
  if (
    scope?.signal &&
    scope.deadlineAt &&
    Date.now() >= Date.parse(scope.deadlineAt)
  )
    throw new DOMException(
      "The original process deadline elapsed",
      "AbortError",
    );
}

/** Does not install a timer or prove that a deadline has elapsed. */
export function currentProcessDeadlineAt(): string | undefined {
  return processCancellation.getStore()?.deadlineAt;
}

/** Bind controller subprocesses to the current coordinator cancellation request. */
export function withProcessCancellation<T>(
  signal: AbortSignal | undefined,
  operation: () => Promise<T>,
  observe?: ProcessScope["observe"],
  /** The caller's already armed deadline for this exact cancellation signal. */
  deadlineAt?: string,
): Promise<T> {
  return processCancellation.run({ signal, observe, deadlineAt }, operation);
}

/** How long an exited command's leftover descendants may run before they are stopped. */
const LINGERING_DESCENDANTS_GRACE_MS = 5_000;

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

/** A bubblewrap launch that writes `--json-status-fd` documents to stdio 3. */
export interface BubblewrapLaunch {
  statusFd: 3;
  /**
   * User-mode networking for the sandbox's own network namespace.
   * bubblewrap holds the command on `--block-fd 4` until pasta, run with
   * these arguments against the sandbox's process, has configured it; stdio
   * 5 carries `resolver` for `--ro-bind-data 5`.
   */
  network?: { pasta: string; args: string[]; resolver?: string };
}

/**
 * What bubblewrap reported. Its `child-pid` document comes right after the
 * clone, before any mount; `exit-code` comes only after setup finished and
 * the command was executed. A missing `exit-code` from a bubblewrap that
 * exited by itself is a setup failure, never the command's (#1573).
 */
interface BubblewrapStatus {
  executed: boolean;
  /** Bubblewrap's own error output, bounded. */
  stderr: string;
  /** Every writer closed the status pipe. */
  ended: Promise<void>;
  /** The sandbox's first process, or undefined when none was reported. */
  childPid: Promise<number | undefined>;
}

const BUBBLEWRAP_STATUS_LIMIT = 65_536;

function watchBubblewrap(child: ChildProcess): BubblewrapStatus {
  const stream = child.stdio[3] as Readable | null | undefined;
  let reported: (pid: number | undefined) => void = () => undefined;
  const status: BubblewrapStatus = {
    executed: false,
    stderr: "",
    ended: Promise.resolve(),
    childPid: new Promise((resolve) => {
      reported = resolve;
    }),
  };
  child.stderr?.on("data", (chunk: Buffer) => {
    if (status.stderr.length < 4_096)
      status.stderr += chunk.toString("utf8").slice(0, 4_096);
  });
  if (!stream) {
    reported(undefined);
    return status;
  }
  status.ended = new Promise<void>((resolve) => {
    stream.once("close", resolve);
    stream.once("end", resolve);
    stream.once("error", resolve);
  });
  void status.ended.then(() => reported(undefined));
  let text = "";
  let read = 0;
  stream.on("data", (chunk: Buffer) => {
    read += chunk.length;
    // Only bubblewrap holds the pipe: it is closed in the sandbox.
    if (read > BUBBLEWRAP_STATUS_LIMIT) {
      stream.destroy();
      return;
    }
    text += chunk.toString("utf8");
    // Flat documents, one or more per read, possibly split across reads.
    for (let end = text.indexOf("}"); end >= 0; end = text.indexOf("}")) {
      const document = text.slice(0, end + 1);
      text = text.slice(end + 1);
      try {
        const value = JSON.parse(document) as Record<string, unknown>;
        if (Number.isSafeInteger(value["exit-code"])) status.executed = true;
        if (Number.isSafeInteger(value["child-pid"]))
          reported(value["child-pid"] as number);
      } catch {
        // Not a status document; it reports nothing.
      }
    }
  });
  return status;
}

/** pasta, run for one sandbox, as recorded when it was spawned. */
interface PastaProcess {
  pid: number;
  owner?: NativeProcessOwner;
  exited: () => boolean;
  exit: Promise<void>;
  /** Holds pasta's pid file. */
  directory: string;
}

/** How long pasta may take to configure a sandbox's network namespace. */
const PASTA_SETUP_MS = 10_000;

const networkFault = (detail: string) =>
  new StepFault({
    kind: "config",
    detail: `The command sandbox's network could not be set up, so the command did not run: ${detail}`,
    fix: "Let pasta (passt) configure the sandbox's network namespace on this host (/dev/net/tun usable by Factory's user), or set sandbox.network to \"off\"",
  });

/**
 * Configures the network namespace of a sandbox bubblewrap holds on its
 * block fd: runs pasta against the sandbox's first process, a member of
 * bubblewrap's group, and waits until pasta's pid file says it configured
 * the namespace. `started` receives pasta as soon as it runs, so the caller
 * settles it whatever happens. Resolves true when the command may be
 * released, false when bubblewrap ended first (its own setup failure, which
 * its status reports); throws a configuration fault when pasta could not
 * configure the namespace, so the command must never be released.
 */
async function connectSandbox(
  bwrap: ChildProcess,
  status: BubblewrapStatus,
  network: NonNullable<BubblewrapLaunch["network"]>,
  started: (pasta: PastaProcess) => void,
): Promise<boolean> {
  const ended = () => bwrap.exitCode !== null || bwrap.signalCode !== null;
  const target = await status.childPid;
  if (target === undefined || ended()) return false;
  const held = linuxProcessIdentity(target);
  if (!held || held.group !== bwrap.pid)
    throw networkFault(`process ${target} is not bubblewrap's sandbox`);
  const directory = mkdtempSync(join(tmpdir(), "factory-pasta-"));
  const pidFile = join(directory, "pid");
  const child = spawn(
    network.pasta,
    [...network.args, "--pid", pidFile, String(target)],
    { detached: true, stdio: ["ignore", "ignore", "pipe"], env: {} },
  );
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    if (stderr.length < 4_096) stderr += chunk.toString("utf8");
  });
  let failure: Error | undefined;
  let exited = false;
  const exit = new Promise<void>((resolve) => {
    child.once("exit", () => {
      exited = true;
      resolve();
    });
    child.once("error", (error) => {
      failure = error;
      // A process that never started never exits.
      if (!child.pid) {
        exited = true;
        resolve();
      }
    });
  });
  const pasta: PastaProcess = {
    pid: child.pid ?? 0,
    owner: child.pid ? nativeProcessOwner(child.pid) : undefined,
    exited: () => exited,
    exit,
    directory,
  };
  started(pasta);
  const detail = () =>
    `${network.pasta} ${failure ? failure.message : `exited ${child.exitCode ?? child.signalCode}`}: ${stderr.trim().slice(0, 1_000) || "no detail"}`;
  if (!child.pid) {
    await exit;
    throw networkFault(detail());
  }
  if (!pasta.owner)
    throw networkFault(`${network.pasta} could not be identified`);
  const deadline = Date.now() + PASTA_SETUP_MS;
  for (;;) {
    if (exited) throw networkFault(detail());
    if (ended()) return false;
    let written = "";
    try {
      written = readFileSync(pidFile, "utf8");
    } catch {
      // Not written yet.
    }
    // pasta writes its pid file once the namespace is configured.
    if (written.endsWith("\n")) {
      if (Number(written.trim()) !== child.pid)
        throw networkFault(`${pidFile} names another process`);
      break;
    }
    if (Date.now() >= deadline)
      throw networkFault(
        `${network.pasta} did not configure the namespace within ${PASTA_SETUP_MS / 1_000} seconds`,
      );
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  // The process pasta joined is the one held: alive, and the same, throughout.
  if (linuxProcessIdentity(target)?.startTime !== held.startTime)
    throw networkFault(`the sandbox's process ${target} ended`);
  return true;
}

/**
 * Stops pasta once its sandbox is gone and proves it gone: its own exit,
 * observed as its parent, and no process left in its group, in the PID
 * namespace it was recorded in. False means it may still run.
 */
async function pastaEnds(pasta: PastaProcess): Promise<boolean> {
  const within = (milliseconds: number) => {
    let timer: NodeJS.Timeout | undefined;
    return Promise.race([
      pasta.exit.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(resolve, milliseconds, false);
      }),
    ]).finally(() => clearTimeout(timer));
  };
  if (!pasta.pid) return pasta.exited();
  if (!pasta.exited()) {
    // Unreaped, so its pid still names it.
    try {
      process.kill(-pasta.pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false;
    }
    if (!(await within(1_000))) return false;
  }
  if (!(await groupEnds(pasta.pid, 1_000))) return false;
  return !pasta.owner || nativeProcessDisposition(pasta.owner) === "settled";
}

/** A bidirectional input channel inside the same owned subprocess lifecycle. */
export interface SubprocessInputChannel {
  signal?: AbortSignal;
  closed: Promise<number | null>;
  write(input: string): Promise<void>;
  end(): void;
}

interface InteractiveSubprocessInput {
  run(channel: SubprocessInputChannel): Promise<void>;
  /** Request protocol interruption before bounded process-group cancellation. */
  cancel?(reason: unknown): void;
  /** Part of closure, never extra time to dispatch work. At most one second. */
  cancellationGraceMs?: number;
}

export async function subprocessAsync(
  file: string,
  args: string[],
  options: SpawnOptions & {
    /** Records the child's identity before any input; a throw stops it. */
    spawned?: (owner: NativeProcessOwner) => void;
    /** The command is sandboxedCommand's bubblewrap launch. */
    bubblewrap?: BubblewrapLaunch;
  } = {},
  input?: string | InteractiveSubprocessInput,
  observe?: (stream: "stdout" | "stderr", chunk: Buffer) => void,
  boundary?: (
    observation: Omit<
      import("./capture.js").ModelBoundaryObservation,
      "source" | "elapsedMs"
    >,
  ) => void,
  retention?: { stdout?: boolean; stderr?: boolean },
): Promise<{
  status: number | null;
  stdout: string;
  stderr: string;
  /** Processes the exited command left running that were stopped after the grace period. */
  stoppedLeftovers?: number;
}> {
  const observed = (
    observation: Parameters<NonNullable<typeof boundary>>[0],
  ) => {
    if (!boundary) return;
    try {
      void Promise.resolve(boundary(observation)).catch(() => undefined);
    } catch {
      /* Observation never changes process work or settlement. */
    }
  };
  const scope = processCancellation.getStore();
  let stoppedLeftovers = 0;
  // `options.signal` (such as a deadline) also stops the whole process group.
  const { signal: extra, spawned, bubblewrap, ...spawnOptions } = options;
  if (bubblewrap && spawnOptions.stdio)
    throw new Error("A sandboxed command's stdio is bubblewrap's");
  const signal =
    scope?.signal && extra
      ? AbortSignal.any([scope.signal, extra])
      : (scope?.signal ?? extra);
  signal?.throwIfAborted();
  const interactive = typeof input === "object" ? input : undefined;
  const cancellationGraceMs = interactive?.cancellationGraceMs ?? 0;
  if (
    !Number.isSafeInteger(cancellationGraceMs) ||
    cancellationGraceMs < 0 ||
    cancellationGraceMs > 1_000
  )
    throw new Error(
      "Interactive subprocess cancellation grace must be 0–1000 ms",
    );
  assertProcessActive();
  signal?.throwIfAborted();
  const network = bubblewrap?.network;
  const child = spawn(file, args, {
    ...spawnOptions,
    ...(bubblewrap && {
      stdio: [
        "pipe",
        "pipe",
        "pipe",
        "pipe",
        // The block fd, and the resolver's data.
        ...(network ? (["pipe"] as const) : []),
        ...(network?.resolver !== undefined ? (["pipe"] as const) : []),
      ],
    }),
    detached: true,
  });
  const sandbox = bubblewrap && watchBubblewrap(child);
  // Writing or closing it releases the held command: only once pasta
  // configured its network, or once bubblewrap's group is proven gone.
  const stdio = child.stdio as unknown as (Writable | null | undefined)[];
  const block = network ? stdio[4] : undefined;
  block?.on("error", () => undefined);
  const data = network?.resolver !== undefined ? stdio[5] : undefined;
  data?.on("error", () => undefined);
  data?.end(network?.resolver);
  let error: Error | undefined;
  let inputError: unknown;
  let inputFailed = false;
  // Register exit/close listeners before ownership checks or protocol writes.
  const closed = new Promise<number | null>((resolve) =>
    child.on("close", resolve),
  );
  const exited = new Promise<number | null>((resolve) => {
    child.on("error", (cause) => {
      error = cause;
    });
    child.on("exit", (code) => {
      observed({ event: "process-exit", exitCode: code, status: "observed" });
      resolve(code);
    });
    void closed.then(resolve);
  });
  if (child.pid) observed({ event: "process-start", status: "observed" });
  const identity = child.pid ? linuxProcessIdentity(child.pid) : null;
  const owned =
    child.pid && identity
      ? { pid: child.pid, startTime: identity.startTime }
      : undefined;
  let cancellationError: unknown;
  let aborted = false;
  let cancelTimer: NodeJS.Timeout | undefined;
  const kill = () => {
    if (!child.pid) return;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH")
        cancellationError = error;
    }
  };
  const cancel = () => {
    if (aborted) return;
    aborted = true;
    try {
      interactive?.cancel?.(signal?.reason);
    } catch {
      // An unsupported interruption never prevents process cancellation.
    }
    if (cancellationGraceMs)
      cancelTimer = setTimeout(kill, cancellationGraceMs);
    else kill();
  };
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  const output: Record<"stdout" | "stderr", Buffer[]> = {
    stdout: [],
    stderr: [],
  };
  for (const stream of ["stdout", "stderr"] as const)
    child[stream]?.on("data", (chunk: Buffer) => {
      if (retention?.[stream] !== false) output[stream].push(chunk);
      observe?.(stream, chunk);
    });
  // A child may exit before consuming input; its exit status remains authoritative.
  child.stdin?.on("error", () => {
    observed({ event: "stdin-error", status: "observed" });
    /* Child exit status is authoritative. */
  });
  child.stdin?.on("finish", () =>
    observed({
      event: "stdin-finished",
      ...(typeof input === "string" && {
        observedBytes: Buffer.byteLength(input),
      }),
      status: "observed",
    }),
  );
  let inputTask: Promise<void> | undefined;
  try {
    if (interactive && (!owned || identity?.group !== owned.pid))
      throw new Error(
        "Interactive subprocess ownership could not be established",
      );
    if (owned) scope?.observe?.(owned, false);
    if (spawned) {
      // The child is stopped and settled below: a plain failure, not unknown.
      const owner = owned && nativeProcessOwner(owned.pid);
      if (!owner)
        throw new Error("Subprocess ownership could not be established");
      spawned(owner);
    }
    if (interactive) {
      const channel: SubprocessInputChannel = {
        signal,
        closed,
        write: (text) =>
          new Promise<void>((resolve, reject) => {
            if (
              !child.stdin ||
              child.stdin.destroyed ||
              child.stdin.writableEnded
            )
              return reject(new Error("Owned subprocess input is closed"));
            child.stdin.write(text, (cause) =>
              cause ? reject(cause) : resolve(),
            );
          }),
        end: () => {
          child.stdin?.end();
        },
      };
      inputTask = Promise.resolve()
        .then(() => interactive.run(channel))
        .catch((cause) => {
          inputFailed = true;
          inputError = cause;
          kill();
        })
        .finally(() => child.stdin?.end());
    } else child.stdin?.end(input);
  } catch (cause) {
    inputFailed = true;
    inputError = cause;
    kill();
    child.stdin?.end();
  }
  let pasta: PastaProcess | undefined;
  let networkTask: Promise<void> | undefined;
  if (network && sandbox && !inputFailed) {
    if (!owned) {
      inputFailed = true;
      inputError = networkFault("bubblewrap could not be identified");
      kill();
    } else
      networkTask = connectSandbox(child, sandbox, network, (started) => {
        pasta = started;
        if (started.owner)
          scope?.observe?.(
            { pid: started.owner.pid, startTime: started.owner.startTime },
            false,
          );
      })
        .then((connected) => {
          if (connected) block?.end("1");
        })
        .catch((cause) => {
          // Killed with its group, never released: it never runs offline.
          inputFailed = true;
          inputError = cause;
          kill();
        });
  }
  // `close` may await descendant-held pipes; settlement starts at parent exit.
  const status = await exited;
  signal?.removeEventListener("abort", cancel);
  clearTimeout(cancelTimer);
  if (aborted) kill();
  if (aborted && child.pid) {
    // SIGKILL is asynchronous. Allow the kernel to reap runnable descendants.
    if (cancellationError || !(await groupEnds(child.pid, 1_000))) {
      if (scope) scope.unresolved = true;
      observed({ event: "cessation", status: "unavailable" });
      throw new UnsettledSubprocessError(
        "Owned subprocess cessation could not be verified; outcome unknown",
        { cause: cancellationError },
      );
    }
  } else if (
    owned &&
    !(await groupEnds(owned.pid, LINGERING_DESCENDANTS_GRACE_MS))
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
      observed({ event: "cessation", status: "unavailable" });
      throw new UnsettledSubprocessError(
        "Owned subprocess group remains active; outcome unknown",
        { cause: stopError },
      );
    }
  }
  if (network) {
    // bubblewrap's group is gone, with any command it held: the block fd
    // releases nothing now. pasta goes with the namespace it served.
    await networkTask;
    if (aborted ? child.pid : owned) {
      block?.destroy();
      data?.destroy();
    }
    const served = pasta as PastaProcess | undefined;
    if (served) {
      if (!(await pastaEnds(served))) {
        if (scope) scope.unresolved = true;
        observed({ event: "cessation", status: "unavailable" });
        throw new UnsettledSubprocessError(
          `The sandbox's pasta (pid ${served.pid}) may still run; outcome unknown`,
        );
      }
      if (served.owner)
        scope?.observe?.(
          { pid: served.owner.pid, startTime: served.owner.startTime },
          true,
        );
      rmSync(served.directory, { recursive: true, force: true });
    }
  }
  // The group is gone, and with it every copy of the output pipes it held. A
  // process that left the group can still hold them: stop reading then.
  let timer: NodeJS.Timeout | undefined;
  const drained = await Promise.race([
    closed.then(() => true),
    new Promise<false>((resolve) => {
      timer = setTimeout(resolve, 1_000, false);
    }),
  ]);
  clearTimeout(timer);
  observed({
    event: "pipes-closed",
    status: drained ? "observed" : "incomplete",
  });
  observed({ event: "cessation", status: owned ? "verified" : "unavailable" });
  if (!drained) {
    child.stdout?.destroy();
    child.stderr?.destroy();
  }
  if (owned) scope?.observe?.(owned, true);
  // Interactive clients observe `closed` and reject pending protocol waits.
  // A client cannot postpone process settlement by retaining an input promise.
  if (inputTask) await Promise.race([inputTask, closed]);
  if (aborted)
    throw new Error("Owned subprocess cancelled after verified cessation");
  if (error) throw error;
  if (inputFailed) throw inputError;
  if (sandbox && child.signalCode === null) {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      sandbox.ended,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 1_000);
      }),
    ]);
    clearTimeout(timer);
    // bubblewrap exited by itself and never executed the command: its
    // setup (a mount or namespace) failed. The host's fault, not the
    // command's, whatever its exit status.
    if (!sandbox.executed)
      throw new StepFault({
        kind: "config",
        detail: `The command sandbox could not be set up (bubblewrap exit ${status}), so the command did not run: ${sandbox.stderr.trim().slice(0, 1_000) || "no detail"}`,
        fix: "Keep every sandbox mount source (the PATH's toolchains, sandbox.readOnlyPaths, sandbox.packageStore, the checkout) in place while Factory runs, and let bubblewrap create namespaces on this host",
      });
  }
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

/** Existing pinned Git preparation for bounded controller-owned transports. */
export function pinnedGitCommand(
  directory: string,
  args: string[],
): { args: string[]; env: NodeJS.ProcessEnv } {
  return factoryGit(directory, args, true);
}

/** pinnedGitAsync whose pathspecs may use magic, such as `:(exclude)`. */
export function pinnedGitMagicAsync(
  checkout: string,
  ...args: string[]
): Promise<string> {
  return gitProcess(checkout, args, true, { GIT_LITERAL_PATHSPECS: "0" });
}

/** pinnedGitMagicAsync on a separate index file, never the checkout's own. */
export function pinnedGitIndexAsync(
  checkout: string,
  index: string,
  ...args: string[]
): Promise<string> {
  return gitProcess(checkout, args, true, {
    GIT_LITERAL_PATHSPECS: "0",
    GIT_INDEX_FILE: index,
  });
}
