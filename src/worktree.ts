/**
 * Worktrees and host-side Git on trees a worker wrote. Each Work Item gets
 * one linked worktree of the target checkout that survives retries and
 * repairs. Every Git call Factory makes on such a tree runs with pinned
 * configuration, refuses repository-scope program settings, and refuses a
 * worktree whose `.git` no longer names its registered admin directory, so
 * worker-planted config or attributes can't run a program outside the
 * sandbox. Workers and validation get an allow-listed
 * environment with no Git, GitHub or SSH credentials. Before any remote Git
 * command, origin must still name the configured repository: a worker can
 * edit the checkout's `.git/config`.
 */
import { execFile } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  unlinkSync,
} from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  type GitExit,
  GitRefusal,
  gitEnvironment,
  pinnedGitExit,
} from "./git.js";
import { TransientError } from "./github.js";
import { forceRemove } from "./paths.js";
import { errorMessage } from "./text.js";

const run = promisify(execFile);
const MINUTE = 60_000;

/**
 * Program-running configuration named by attributes or used by Git LFS. A
 * repository-scope (local or worktree, with includes) definition refuses
 * the call; the pins can't override a filter or driver a worker names.
 */
const REPOSITORY_PROGRAMS =
  "filter\\..+\\.(clean|smudge|process)|merge\\..+\\.driver|lfs\\.customtransfer\\..+\\.path|lfs\\.extension\\..+\\.(clean|smudge)|remote\\..+\\.vcs";
/** The filter commands `git lfs install` writes. */
const LFS_FILTER_COMMANDS: Record<string, string[]> = {
  "filter.lfs.clean": ["git-lfs clean -- %f"],
  "filter.lfs.smudge": ["git-lfs smudge -- %f", "git-lfs smudge --skip -- %f"],
  "filter.lfs.process": [
    "git-lfs filter-process",
    "git-lfs filter-process --skip",
  ],
};

/** Each Work Item worktree's admin directory as the checkout registered it. */
const adminDirectories = new Map<string, string>();

function realOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * Refuse host Git in a linked worktree (its `.git` a file) unless this
 * process registered it through addWorktree and its `.git` still names that
 * admin directory: a worker could point it at a Git directory it made, with
 * its own filters. An unregistered one means a step skipped addWorktree.
 */
function assertRegisteredGitDir(directory: string): void {
  const file = join(directory, ".git");
  const admin = adminDirectories.get(resolve(directory));
  if (admin === undefined) {
    if (lstatSync(file, { throwIfNoEntry: false })?.isFile())
      throw new GitRefusal(
        `${directory} is a linked worktree this process did not prepare with addWorktree; this is a Factory programming error`,
        "Factory won't run Git in it. Report it; answer retry once Factory is fixed, or cancel",
      );
    return;
  }
  let named: string | undefined;
  try {
    if (lstatSync(file).isFile()) {
      const match = /^gitdir: (.+?)\r?\n?$/.exec(readFileSync(file, "utf8"));
      if (match) named = realpathSync(resolve(directory, match[1]!));
    }
  } catch {
    // Missing or unreadable: refused below.
  }
  if (named !== admin)
    throw new GitRefusal(
      `${file} no longer names the worktree's registered Git directory ${admin}`,
      "Factory won't run Git in it. Cancel the Objective, or remove that worktree directory and answer retry so Factory adds it again",
    );
}

/**
 * Passed program checks per directory, valid while every file that decides
 * the repository configuration Git reads there keeps its exact stat
 * identity: the `.git` entry, the Git and common directories, HEAD (for
 * includeIf.onbranch), the local and worktree config, and every included
 * file. Any change, a same-size rewrite included, checks again.
 */
const programChecks = new Map<string, { paths: string[]; identity: string }>();
const PROGRAM_CHECKS = 256;
/** A file modified this recently may change again within its timestamp tick. */
const RACY_CONFIG_MS = 2_000;
/** Keys that locate the configuration files, read alongside the programs. */
const CONFIG_LOCATORS =
  "core\\.repositoryformatversion|include\\.path|includeif\\..+\\.path";

/**
 * The files deciding which repository configuration Git reads in a
 * repository root: a main worktree (`.git` directory) or a linked one
 * (`.git` file naming its Git directory). Anything else is not cached.
 */
function repositoryConfigFiles(
  directory: string,
): { config: string; worktreeConfig: string; paths: string[] } | undefined {
  try {
    const dot = resolve(directory, ".git");
    const stat = lstatSync(dot, { throwIfNoEntry: false });
    let gitdir: string;
    if (stat?.isDirectory()) gitdir = dot;
    else if (stat?.isFile()) {
      const named = /^gitdir: (.+)\n?$/.exec(readFileSync(dot, "utf8"));
      if (!named) return undefined;
      gitdir = resolve(directory, named[1]!);
    } else return undefined;
    const commondir = join(gitdir, "commondir");
    const common = existsSync(commondir)
      ? resolve(gitdir, readFileSync(commondir, "utf8").trim())
      : gitdir;
    const config = join(common, "config");
    const worktreeConfig = join(gitdir, "config.worktree");
    return {
      config,
      worktreeConfig,
      paths: [
        dot,
        gitdir,
        join(gitdir, "HEAD"),
        commondir,
        common,
        join(common, "objects"),
        join(common, "refs"),
        config,
        worktreeConfig,
      ],
    };
  } catch {
    return undefined;
  }
}

/**
 * Exact stat identities: device, inode, size and timestamps for files,
 * device and inode for directories, and absence. Undefined when a file
 * changed within RACY_CONFIG_MS, or a path is a link (lstat would identify
 * the link, not its target).
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

/** An include path as Git resolves it from the file that names it. */
function includeTarget(origin: string, value: string): string | undefined {
  if (value.startsWith("~/") && process.env.HOME)
    return join(process.env.HOME, value.slice(2));
  if (value.startsWith("~")) return undefined;
  return resolve(dirname(origin), value);
}

/** Refuse repository-scope configuration that would run a program. */
async function assertNoRepositoryPrograms(
  directory: string,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<void> {
  // Without the directory there is no configuration; the command reports it.
  if (!existsSync(directory)) return;
  const key = resolve(directory);
  const cached = programChecks.get(key);
  if (cached && statIdentity(cached.paths, false) === cached.identity) return;
  programChecks.delete(key);
  // Taken before Git reads the configuration, so a later change differs.
  const files = repositoryConfigFiles(directory);
  const before = files && statIdentity(files.paths, true);
  let output: string;
  try {
    output = (
      await run(
        "git",
        [
          "-C",
          directory,
          "config",
          "--null",
          "--show-origin",
          "--show-scope",
          "--includes",
          "--get-regexp",
          `^(${REPOSITORY_PROGRAMS}|${CONFIG_LOCATORS})$`,
        ],
        { env, encoding: "utf8", timeout: MINUTE, signal },
      )
    ).stdout;
  } catch (error) {
    if ((error as { code?: unknown }).code !== 1) throw error;
    output = "";
  }
  const fields = output.split("\0");
  fields.pop();
  let cacheable = before !== undefined;
  let located = false;
  const read = new Set<string>();
  for (let index = 0; index + 2 < fields.length; index += 3) {
    const scope = fields[index]!;
    if (scope !== "local" && scope !== "worktree") continue;
    const origin = fields[index + 1]!;
    const entry = fields[index + 2]!;
    const newline = entry.indexOf("\n");
    const name = newline < 0 ? entry : entry.slice(0, newline);
    const value = newline < 0 ? undefined : entry.slice(newline + 1);
    const source = origin.startsWith("file:")
      ? resolve(directory, origin.slice(5))
      : undefined;
    if (source === undefined) cacheable = false;
    else read.add(source);
    if (name === "core.repositoryformatversion") {
      if (source === files?.config) located = true;
      continue;
    }
    if (/^(include\.path|includeif\..+\.path)$/.test(name)) {
      const target =
        source && value !== undefined
          ? includeTarget(source, value)
          : undefined;
      if (target === undefined) cacheable = false;
      else read.add(target);
      continue;
    }
    // Git LFS's own filter: the whole value must be one git-lfs writes.
    if (value !== undefined && LFS_FILTER_COMMANDS[name]?.includes(value))
      continue;
    throw new GitRefusal(
      `Repository configuration for ${directory} defines ${name}; Factory's Git reads no global or system configuration and takes no program from the repository's, apart from Git LFS's own filter`,
      `Remove ${name} from the target checkout's local configuration (git config --local --unset ${name}, or the [include]d file that sets it), then answer retry`,
    );
  }
  if (!cacheable || !located || !files) return;
  const paths = [
    ...files.paths,
    ...[...read].filter((path) => !files.paths.includes(path)),
  ];
  const identity = statIdentity(paths, true);
  if (identity === undefined || statIdentity(files.paths, true) !== before)
    return;
  programChecks.set(key, { paths, identity });
  if (programChecks.size > PROGRAM_CHECKS)
    programChecks.delete(programChecks.keys().next().value!);
}

export interface HostGitOptions {
  input?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Pathspec magic back on (exclusions, check-ignore's filenames); every other pin stays. */
  magic?: true;
  /** A separate index file instead of the worktree's own. */
  index?: string;
  /** Standard output to this file descriptor, or dropped, instead of returned. */
  stdout?: number | "ignore";
}

/**
 * Run pinned host Git in `directory` and report how it exited. A
 * registered worktree must still name its admin directory, and no
 * repository-scope filter, merge driver, LFS transfer or remote helper may
 * be configured: either throws a GitRefusal.
 */
export async function hostGitExit(
  directory: string,
  args: string[],
  options: HostGitOptions = {},
): Promise<GitExit> {
  const env = gitEnvironment();
  assertRegisteredGitDir(directory);
  await assertNoRepositoryPrograms(directory, env, options.signal);
  if (options.magic) delete env.GIT_LITERAL_PATHSPECS;
  if (options.index) env.GIT_INDEX_FILE = options.index;
  return pinnedGitExit(directory, args, {
    env,
    timeoutMs: options.timeoutMs ?? 5 * MINUTE,
    input: options.input,
    signal: options.signal,
    stdout: options.stdout,
  });
}

/**
 * hostGitExit's standard output; a non-zero exit throws with Git's error
 * output.
 */
export async function hostGit(
  directory: string,
  args: string[],
  options: HostGitOptions = {},
): Promise<Buffer> {
  const result = await hostGitExit(directory, args, options);
  if (result.code === 0) return result.stdout;
  throw new Error(
    `git ${args.join(" ")} in ${directory} ${result.code === null ? `ended by ${result.signal}` : `exited ${result.code}`}: ${result.stderr}`,
  );
}

/**
 * The files that differ from HEAD in `worktree`, untracked ones included
 * (whatever wrote them: an edit tool or a shell command), read without
 * taking Git's optional index lock, so a worker's own Git never waits on it.
 */
export async function changedFiles(
  worktree: string,
  signal: AbortSignal,
): Promise<string[]> {
  const listing = await hostGit(
    worktree,
    [
      "--no-optional-locks",
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--no-renames",
    ],
    { signal, timeoutMs: 30_000 },
  );
  return listing
    .toString("utf8")
    .split("\0")
    .filter((entry) => entry.length > 3)
    .map((entry) => entry.slice(3));
}

/**
 * `git merge-base --is-ancestor`: exit 0 is yes, exit 1 is no, and anything
 * else (a missing object, a killed Git) is a TransientError to retry.
 */
export async function isAncestor(
  directory: string,
  older: string,
  newer: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const args = ["merge-base", "--is-ancestor", older, newer];
  let result: GitExit;
  try {
    result = await hostGitExit(directory, args, { signal, timeoutMs: MINUTE });
  } catch (error) {
    if (signal?.aborted || error instanceof GitRefusal) throw error;
    throw new TransientError(`git ${args.join(" ")}: ${errorMessage(error)}`);
  }
  if (result.code === 0) return true;
  if (result.code === 1) return false;
  throw new TransientError(
    `git ${args.join(" ")} ${result.code === null ? `ended by ${result.signal}` : `exited ${result.code}`}: ${result.stderr.slice(0, 2000)}`,
  );
}

/**
 * Whether the tree of `commit`, or else the index, holds a submodule
 * gitlink: host Git behind one would enter a repository a worker wrote.
 */
export async function hasGitlink(
  directory: string,
  options: { commit?: string; index?: string; signal?: AbortSignal } = {},
): Promise<boolean> {
  const listing = await hostGit(
    directory,
    options.commit
      ? ["ls-tree", "-r", "-z", "--full-tree", options.commit]
      : ["ls-files", "--stage", "-z"],
    options,
  );
  return listing
    .toString("utf8")
    .split("\0")
    .some((entry) => entry.startsWith("160000 "));
}

/** A Work Item's worktree: `<workDir>/<issue>/<item>`. */
export function worktreePath(
  workDir: string,
  issue: number,
  item: string,
): string {
  return join(workDir, String(issue), item);
}

/**
 * The install's package store kept beside a Work Item's `worktree` across
 * its validations (validate.ts `installStore`, #2169): the worker's
 * Validate, the validate step and a QA item's validate step all keep it
 * here, so each reuses what the others fetched.
 */
export function installStorePath(worktree: string): string {
  return `${worktree}.packages`;
}

/**
 * The install stores the whole installation shares (validate.ts
 * `sharedInstallStore`, shared-install-store.ts; #2280, #2353): beside the
 * Objectives' work directories (`workDir` is any one of them, `<work
 * root>/<issue>`), under a name no issue number can take. Not removed with
 * an Objective's work files; old keys are pruned by last use.
 */
export function sharedInstallStorePath(workDir: string): string {
  return join(dirname(workDir), ".packages");
}

/** `checkout`'s Git directory and common Git directory, absolute. */
async function gitDirectories(
  checkout: string,
  signal?: AbortSignal,
): Promise<{ gitDir: string; common: string }> {
  const [gitDir, common] = (
    await hostGit(
      checkout,
      ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"],
      { signal },
    )
  )
    .toString("utf8")
    .trim()
    .split("\n");
  return { gitDir: gitDir!, common: common! };
}

/**
 * The linked worktrees registered under `common`: each admin directory
 * with the worktree its `gitdir` names (resolved), or undefined for an
 * incomplete registration.
 */
async function registrations(
  common: string,
): Promise<{ admin: string; worktree: string | undefined }[]> {
  let names: string[];
  try {
    names = await readdir(join(common, "worktrees"));
  } catch {
    return [];
  }
  return Promise.all(
    names.map(async (name) => {
      const admin = join(common, "worktrees", name);
      try {
        const gitdir = (await readFile(join(admin, "gitdir"), "utf8")).trim();
        if (basename(gitdir) === ".git")
          return { admin, worktree: realOrSelf(dirname(gitdir)) };
      } catch {
        // Not a complete registration.
      }
      return { admin, worktree: undefined };
    }),
  );
}

/**
 * The admin directory `checkout` registered for `worktree`: the entry under
 * its common directory's `worktrees/` whose `gitdir` names `worktree/.git`
 * (Git writes the real path, so both sides are compared resolved).
 * Read from the checkout, which a worker can't write.
 */
async function registeredAdmin(
  checkout: string,
  worktree: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const real = realOrSelf(worktree);
  for (const entry of await registrations(
    (await gitDirectories(checkout, signal)).common,
  ))
    if (entry.worktree === real) return realOrSelf(entry.admin);
  return undefined;
}

/**
 * A lock older than this is a dead Git's: every Factory Git that takes a
 * lock runs under a 5 min timeout and a short SIGTERM grace.
 */
const STALE_LOCK_MS = 10 * 60_000;
/** Young locks already logged as kept, so each is logged once while it lasts. */
const keptLocks = new Set<string>();

/**
 * Remove the lock files a killed Git left in `checkout`'s repository, which
 * no later Git removes, so a retry can run. In the common directory:
 * `packed-refs.lock`, `shallow.lock`, `config.lock`, reftable's
 * `tables.list.lock` and every `*.lock` under `refs/`; the checkout's own
 * `index.lock` and `HEAD.lock`; with `worktree`, its `index.lock` and
 * `HEAD.lock`. Also the `locked` marker an interrupted `worktree add`
 * leaves, on `worktree`'s registration and on any registration that never
 * got its `gitdir` (Factory never locks a worktree; the operator's locked
 * worktrees are complete and stay locked). A lock goes only when it is
 * older than STALE_LOCK_MS, checked again just before it is removed, so a
 * live Git's lock is never taken, whoever started it. Each removal, and
 * each younger lock kept, is logged once. Every path comes from the
 * checkout's Git directory, which a worker can't write. Call it before
 * reusing a worktree and before ref changes in the checkout.
 */
export async function clearStaleLocks(
  checkout: string,
  options: {
    worktree?: string;
    signal?: AbortSignal;
    log?: (event: Record<string, unknown>) => void;
  } = {},
): Promise<void> {
  const { gitDir, common } = await gitDirectories(checkout, options.signal);
  const candidates = [
    ...["packed-refs.lock", "shallow.lock", "config.lock"].map((name) =>
      join(common, name),
    ),
    join(common, "reftable", "tables.list.lock"),
    join(gitDir, "index.lock"),
    join(gitDir, "HEAD.lock"),
  ];
  try {
    for (const name of await readdir(join(common, "refs"), {
      recursive: true,
    }))
      if (name.endsWith(".lock")) candidates.push(join(common, "refs", name));
  } catch {
    // No refs directory.
  }
  const real = options.worktree && realOrSelf(options.worktree);
  for (const entry of await registrations(common)) {
    if (entry.worktree === undefined)
      candidates.push(join(entry.admin, "locked"));
    else if (entry.worktree === real)
      candidates.push(
        ...["index.lock", "HEAD.lock", "locked"].map((name) =>
          join(entry.admin, name),
        ),
      );
  }
  for (const path of candidates) {
    // Checked right before the removal: no await in between.
    const found = lstatSync(path, { throwIfNoEntry: false });
    if (!found) {
      keptLocks.delete(path);
      continue;
    }
    const ageMs = Math.round(Date.now() - found.mtimeMs);
    if (ageMs <= STALE_LOCK_MS) {
      if (!keptLocks.has(path))
        options.log?.({ event: "git-lock-kept", path, ageMs });
      keptLocks.add(path);
      continue;
    }
    try {
      unlinkSync(path);
      options.log?.({ event: "git-lock-removed", path, ageMs });
    } catch {
      // Gone meanwhile.
    }
    keptLocks.delete(path);
  }
}

/**
 * A detached linked worktree of `checkout` at `commit`, kept when it is
 * already there: a retry or repair continues in it. A directory that isn't
 * a complete worktree (a crash between registration and checkout) is
 * removed and added again. Only the registration holds the repository
 * lock; the files are checked out after. Host Git in the worktree is then
 * refused once its `.git` stops naming the registered admin directory, so
 * a step adds (or keeps) the worktree before any other host Git in it.
 * Stale locks go first (clearStaleLocks, logged to `log`).
 */
export async function addWorktree(
  checkout: string,
  worktree: string,
  commit: string,
  signal?: AbortSignal,
  log?: (event: Record<string, unknown>) => void,
): Promise<"added" | "kept"> {
  await clearStaleLocks(checkout, {
    worktree,
    ...(signal && { signal }),
    ...(log && { log }),
  });
  const kept = await registeredAdmin(checkout, worktree, signal);
  if (kept !== undefined) {
    adminDirectories.set(resolve(worktree), kept);
    if (await completeWorktree(worktree, signal)) return "kept";
  }
  await removeWorktree(checkout, worktree, signal);
  await hostGit(
    checkout,
    ["worktree", "add", "--no-checkout", "--detach", worktree, commit],
    { signal },
  );
  const admin = await registeredAdmin(checkout, worktree, signal);
  if (admin === undefined)
    throw new Error(
      `git worktree add registered no admin directory for ${worktree}`,
    );
  adminDirectories.set(resolve(worktree), admin);
  await hostGit(worktree, ["reset", "--quiet", "--hard", commit], { signal });
  return "added";
}

/**
 * Bring `worktree`, a linked worktree kept between validations, to `commit`
 * as a fresh checkout of it has it, apart from the files Git ignores
 * (#2352): HEAD and the index at `commit`, every tracked file as committed
 * there (one it deletes is gone) and no untracked file Git doesn't ignore.
 * Untracked files go first too: checkout falls back to a `.gitattributes`
 * in the worktree, so one a command left would change how tracked files
 * are written. Host Git here is pinned as everywhere (`hostGitExit`): the
 * `.git` must still name the registered admin directory, and no program
 * the repository configures runs. False when it can't be: an incomplete worktree, Git failing or refusing
 * (a command rewrote its `.git`), or a status still not clean. The caller
 * then makes it fresh.
 */
export async function refreshWorktree(
  worktree: string,
  commit: string,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    if (!(await completeWorktree(worktree, signal))) return false;
    await hostGit(worktree, ["clean", "-ffdq"], { signal });
    await hostGit(worktree, ["reset", "--quiet", "--hard", commit], { signal });
    await hostGit(worktree, ["clean", "-ffdq"], { signal });
    const status = await hostGit(
      worktree,
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      { signal },
    );
    return status.length === 0;
  } catch {
    signal?.throwIfAborted();
    return false;
  }
}

/**
 * A linked worktree with HEAD and an index: `worktree add --no-checkout`
 * writes no index, so its absence means the checkout never finished. A
 * refusal (a changed `.git` or a planted program) is not an incomplete
 * worktree: it propagates.
 */
async function completeWorktree(
  worktree: string,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!lstatSync(join(worktree, ".git"), { throwIfNoEntry: false })?.isFile())
    return false;
  try {
    await hostGit(worktree, ["rev-parse", "--verify", "--quiet", "HEAD"], {
      signal,
    });
    const index = (
      await hostGit(
        worktree,
        ["rev-parse", "--path-format=absolute", "--git-path", "index"],
        { signal },
      )
    )
      .toString("utf8")
      .trim();
    return existsSync(index);
  } catch (error) {
    if (error instanceof GitRefusal) throw error;
    signal?.throwIfAborted();
    return false;
  }
}

/**
 * Remove a worktree and its private `.shell`, `.validation` and `.packages`
 * (validation's kept package store) directories, then prune the
 * registration. A missing worktree is fine. The files go
 * first, so a worktree Git refuses to remove still frees its space.
 */
export async function removeWorktree(
  checkout: string,
  worktree: string,
  signal?: AbortSignal,
): Promise<void> {
  adminDirectories.delete(resolve(worktree));
  try {
    await Promise.all(
      (await readdir(worktree))
        .filter((name) => name !== ".git")
        .map((name) => forceRemove(join(worktree, name))),
    );
  } catch {
    // Missing, or not a directory: removed below.
  }
  try {
    await hostGit(checkout, ["worktree", "remove", "--force", worktree], {
      signal,
    });
  } catch (error) {
    if (error instanceof GitRefusal) throw error;
    signal?.throwIfAborted();
    // Not registered, or Git refused: the directory goes regardless.
  }
  await Promise.all(
    [
      worktree,
      `${worktree}.shell`,
      `${worktree}.validation`,
      installStorePath(worktree),
    ].map(forceRemove),
  );
  await hostGit(checkout, ["worktree", "prune"], { signal });
}

/** The package name of a CLI at `<package>/dist/cli.js`, or undefined. */
function cliPackage(cli: string): string | undefined {
  if (basename(cli) !== "cli.js" || basename(dirname(cli)) !== "dist")
    return undefined;
  const pkg = JSON.parse(
    readFileSync(join(dirname(dirname(cli)), "package.json"), "utf8"),
  ) as { name?: unknown };
  return typeof pkg.name === "string" ? pkg.name : undefined;
}

/** Where the setup skill's launcher links: Factory's CLI in an npm prefix. */
const LAUNCHED_CLI = "/node_modules/@clockgrove/factory/dist/cli.js";
const VERSION_DIRECTORY = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * The target of the setup skill's launcher in `directory` when that target
 * is gone (its version directory was deleted), or undefined. Only the
 * launcher's own layout counts: `directory` is a `bin` holding only a
 * `factory` link to an absolute `PREFIX${LAUNCHED_CLI}`, where PREFIX is
 * `bin`'s parent (an installer `--prefix`) or a version directory beside
 * `bin` in a `clockgrove-factory` data root. Any other link that resolves to
 * nothing is not Factory's to judge.
 */
export function danglingLauncher(directory: string): string | undefined {
  try {
    if (!isAbsolute(directory) || basename(directory) !== "bin")
      return undefined;
    const contents = readdirSync(directory);
    if (contents.length !== 1 || contents[0] !== "factory") return undefined;
    const link = join(directory, "factory");
    if (!lstatSync(link).isSymbolicLink() || existsSync(link)) return undefined;
    const target = readlinkSync(link);
    if (!isAbsolute(target) || !target.endsWith(LAUNCHED_CLI)) return undefined;
    const prefix = target.slice(0, -LAUNCHED_CLI.length);
    const parent = realpathSync(dirname(directory));
    const launched =
      prefix === parent ||
      (dirname(prefix) === parent &&
        basename(parent) === "clockgrove-factory" &&
        VERSION_DIRECTORY.test(basename(prefix)));
    return launched ? target : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The PATH without Factory's launchers: a directory whose only entry is a
 * `factory` link to this installation's CLI or to another version of
 * Factory's. The setup skill's launcher directory moves to each new version
 * while a service of the one before still runs. Its launcher is left out
 * even when the version it links to was deleted (`danglingLauncher`), since
 * it runs nothing and its directory is one workers never see. Other tools
 * stay.
 */
export function workerToolchainPath(
  path: string | undefined,
): string | undefined {
  if (path === undefined) return undefined;
  const launcher = fileURLToPath(new URL("./cli.js", import.meta.url));
  if (!existsSync(launcher)) return path;
  const real = realpathSync(launcher);
  let name: string | undefined;
  try {
    name = cliPackage(real);
  } catch {
    // No readable package.json: only this installation's launcher is known.
  }
  return path
    .split(":")
    .filter((entry) => {
      if (danglingLauncher(entry)) return false;
      try {
        if (!isAbsolute(entry) || !existsSync(entry)) return true;
        const contents = readdirSync(entry);
        if (contents.length !== 1 || contents[0] !== "factory") return true;
        const candidate = join(entry, "factory");
        if (!lstatSync(candidate).isSymbolicLink()) return true;
        const target = realpathSync(candidate);
        return target !== real && (!name || cliPackage(target) !== name);
      } catch {
        // An entry Factory can't read is left as the operator set it.
        return true;
      }
    })
    .join(":");
}

const ENVIRONMENT_NAMES = new Set([
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

/**
 * The environment a worker gets: an allow-list of ambient variables, plus
 * the operator's `allowedSecretNames` (never a GitHub, Git or SSH one). gh
 * reads an empty `credentialDirectory`, Git has no credential helper and
 * never prompts, and Factory's launcher is off the PATH.
 */
export function workerEnvironment(
  credentialDirectory: string,
  allowedSecretNames: readonly string[] = [],
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    const declared =
      allowedSecretNames.includes(key) &&
      !/^(GH_|GITHUB_|GIT_|SSH_)/i.test(key);
    if (
      value &&
      (ENVIRONMENT_NAMES.has(key) || /^LC_[A-Z_]+$/.test(key) || declared)
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

/**
 * The environment validation commands start from: a worker's, with no
 * declared secrets, on the controller's own PATH (the sandbox still drops
 * Factory's launcher from it).
 */
export function validationEnvironment(
  credentialDirectory: string,
): Record<string, string> {
  const env = workerEnvironment(credentialDirectory);
  if (process.env.PATH !== undefined) env.PATH = process.env.PATH;
  return env;
}
