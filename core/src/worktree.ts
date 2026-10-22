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
  realpathSync,
} from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  type GitExit,
  gitEnvironment,
  operatorGit,
  pinnedGitExit,
} from "./git.js";
import { forceRemove } from "./paths.js";

const run = promisify(execFile);
const MINUTE = 60_000;

/**
 * Host Git refused to run: the tree's Git metadata or repository
 * configuration would let it run a program outside the sandbox. `fix` names
 * what the operator does.
 */
export class GitRefusal extends Error {
  constructor(
    readonly detail: string,
    readonly fix: string,
  ) {
    super(`${detail}. ${fix}`);
  }
}

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
  const common = (
    await hostGit(
      checkout,
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { signal },
    )
  )
    .toString("utf8")
    .trim();
  const real = realOrSelf(worktree);
  let names: string[];
  try {
    names = await readdir(join(common, "worktrees"));
  } catch {
    return undefined;
  }
  for (const name of names) {
    const admin = join(common, "worktrees", name);
    try {
      const gitdir = (await readFile(join(admin, "gitdir"), "utf8")).trim();
      if (basename(gitdir) === ".git" && realOrSelf(dirname(gitdir)) === real)
        return realpathSync(admin);
    } catch {
      // Not a complete registration.
    }
  }
  return undefined;
}

/**
 * A detached linked worktree of `checkout` at `commit`, kept when it is
 * already there: a retry or repair continues in it. A directory that isn't
 * a complete worktree (a crash between registration and checkout) is
 * removed and added again. Only the registration holds the repository
 * lock; the files are checked out after. Host Git in the worktree is then
 * refused once its `.git` stops naming the registered admin directory, so
 * a step adds (or keeps) the worktree before any other host Git in it.
 */
export async function addWorktree(
  checkout: string,
  worktree: string,
  commit: string,
  signal?: AbortSignal,
): Promise<"added" | "kept"> {
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
 * Remove a worktree and its private `.shell` and `.validation` directories,
 * then prune the registration. A missing worktree is fine. The files go
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
    [worktree, `${worktree}.shell`, `${worktree}.validation`].map(forceRemove),
  );
  await hostGit(checkout, ["worktree", "prune"], { signal });
}

/**
 * The PATH without Factory's own launcher: a directory whose only entry is
 * a `factory` link to this installation's CLI. Other tools stay.
 */
export function workerToolchainPath(
  path: string | undefined,
): string | undefined {
  if (path === undefined) return undefined;
  const launcher = fileURLToPath(new URL("./cli.js", import.meta.url));
  if (!existsSync(launcher)) return path;
  const real = realpathSync(launcher);
  return path
    .split(":")
    .filter((entry) => {
      try {
        if (!isAbsolute(entry) || !existsSync(entry)) return true;
        const contents = readdirSync(entry);
        if (contents.length !== 1 || contents[0] !== "factory") return true;
        const candidate = join(entry, "factory");
        if (!lstatSync(candidate).isSymbolicLink()) return true;
        return realpathSync(candidate) !== real;
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

/** `owner/name` of a supported GitHub clone URL; never credentials or raw URLs. */
function remoteRepository(remote: string): string | undefined {
  const scp =
    /^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/i.exec(
      remote,
    );
  if (scp) return `${scp[1]}/${scp[2]}`.toLowerCase();
  try {
    const url = new URL(remote);
    // A credential in the URL would reach logs; HTTPS credentials come from
    // a credential helper.
    const https =
      url.protocol === "https:" &&
      url.hostname === "github.com" &&
      !url.port &&
      !url.username &&
      !url.password;
    const ssh =
      url.protocol === "ssh:" &&
      url.username === "git" &&
      !url.password &&
      ((url.hostname === "github.com" && (!url.port || url.port === "22")) ||
        (url.hostname === "ssh.github.com" && url.port === "443"));
    if ((!https && !ssh) || url.search || url.hash) return undefined;
    const path = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(
      url.pathname,
    );
    return path ? `${path[1]}/${path[2]}`.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

/** Why origin's fetch or push URLs (after insteadOf) don't name `repository`. */
async function remoteProblem(
  checkout: string,
  repository: string,
  push: boolean,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const direction = push ? "push" : "fetch";
  let output: string;
  try {
    output = (
      await operatorGit(
        checkout,
        ["remote", "get-url", ...(push ? ["--push"] : []), "--all", "origin"],
        { signal },
      )
    ).trim();
  } catch {
    signal?.throwIfAborted();
    return `Cannot resolve origin ${direction} URLs; configure origin for the target GitHub repository`;
  }
  for (const remote of output.split("\n")) {
    const found = remoteRepository(remote);
    if (!found)
      return `Origin ${direction} URL is not a supported GitHub repository URL; use the target repository's HTTPS clone URL without embedded credentials (with a credential helper such as \`gh auth setup-git\`) or its SSH clone URL`;
    if (found !== repository.toLowerCase())
      return `Origin ${direction} repository does not match configured repository ${repository.toLowerCase()}; correct the remote binding before using Factory`;
  }
  return undefined;
}

const LFS_ROUTING_KEYS =
  "^(lfs\\.(url|pushurl|remote\\.(autodetect|searchall)|standalonetransferagent|customtransfer\\..*|transfer\\.enablehrefrewrite)|remote\\.(lfsdefault|lfspushdefault|.+\\.(lfsurl|lfspushurl)))$";

const LFS_ROUTING_PROBLEM =
  "Custom LFS routing is unsupported for target binding; remove LFS URL, alternate-remote, rewrite, or custom-transfer settings and use origin's default GitHub LFS endpoint";

/**
 * Why LFS would not use origin's default route: custom routing can't be
 * proven from clone URLs. Read from the configuration, the working
 * `.lfsconfig`, and the committed one a fresh clone would use.
 */
async function lfsRoutingProblem(
  checkout: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const check = async (source: string[]): Promise<string | undefined> => {
    let output: string;
    try {
      output = await operatorGit(
        checkout,
        [
          "config",
          "--includes",
          ...source,
          "--null",
          "--get-regexp",
          LFS_ROUTING_KEYS,
        ],
        { signal },
      );
    } catch (error) {
      if ((error as { code?: unknown }).code === 1) return undefined;
      signal?.throwIfAborted();
      return "Cannot inspect LFS routing configuration; repair Git/.lfsconfig settings before using Factory";
    }
    for (const entry of output.split("\0").filter(Boolean)) {
      const newline = entry.indexOf("\n");
      const key = (newline < 0 ? entry : entry.slice(0, newline)).toLowerCase();
      const value = newline < 0 ? undefined : entry.slice(newline + 1).trim();
      if (value === "") continue;
      if (
        /^lfs\.(remote\.(autodetect|searchall)|transfer\.enablehrefrewrite)$/.test(
          key,
        ) &&
        value !== undefined &&
        /^(false|no|off|0)$/i.test(value)
      )
        continue;
      if (/^remote\.lfs(push)?default$/.test(key) && value === "origin")
        continue;
      return LFS_ROUTING_PROBLEM;
    }
    return undefined;
  };
  const sources: string[][] = [[]];
  if (existsSync(join(checkout, ".lfsconfig")))
    sources.push(["--file", join(checkout, ".lfsconfig")]);
  for (const blob of [":.lfsconfig", "HEAD:.lfsconfig"]) {
    try {
      await operatorGit(checkout, ["cat-file", "-e", blob], { signal });
      sources.push(["--blob", blob]);
    } catch {
      signal?.throwIfAborted();
      // No such blob.
    }
  }
  for (const source of sources) {
    const problem = await check(source);
    if (problem) return problem;
  }
  return undefined;
}

/**
 * Why `checkout` must not run a remote Git command for `repository`, or
 * undefined: origin's fetch and push URLs, after insteadOf rewriting, must
 * name it, and LFS must use origin's default route. Call it before every
 * fetch, push, ls-remote or LFS transfer; a problem is a hold that names
 * the fix.
 */
export async function originProblem(
  checkout: string,
  repository: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  return (
    (await remoteProblem(checkout, repository, false, signal)) ??
    (await remoteProblem(checkout, repository, true, signal)) ??
    (await lfsRoutingProblem(checkout, signal))
  );
}
