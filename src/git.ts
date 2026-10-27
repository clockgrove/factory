import { execFile, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { GitHubError, TransientError } from "./github.js";
import { errorMessage } from "./text.js";

const run = promisify(execFile);
const MINUTE = 60_000;

/**
 * Configuration pinned for every Factory Git call, as GIT_CONFIG_* entries:
 * they outrank the repository's own configuration, so worker-planted config
 * or attributes can't run a program outside the sandbox.
 */
const PINNED: [string, string][] = [
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
 * Git without the operator's configuration: no system or global
 * configuration, no system attributes, no replace objects, no lazy fetch,
 * LFS skip-smudge, literal pathspecs, and the pins above. PATH keeps only
 * absolute entries: Git runs in a tree a worker wrote, so a relative or
 * empty entry would find its helpers (git-lfs, git-<command>) there.
 */
export function gitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env))
    if (key.startsWith("GIT_")) delete env[key];
  if (env.PATH !== undefined)
    env.PATH = env.PATH.split(":")
      .filter((entry) => entry.startsWith("/"))
      .join(":");
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
    GIT_CONFIG_COUNT: String(PINNED.length),
  });
  PINNED.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return env;
}

/** A URL with a password, or an http(s) URL with any user part (a token). */
const URL_CREDENTIAL =
  /^(?:https?:\/\/[^/@\s]+@|[a-z][a-z\d+.-]*:\/\/[^/@:\s]*:[^/@\s]*@)/i;

/**
 * The checkout's own Git configuration entries (local and worktree) that
 * carry a credential: `http.*extraheader` (an Authorization header, as CI
 * checkouts write), a `credential.*helper` that runs inline shell (`!…`),
 * `credential.*username` or `password`, a `remote.*.url` or `pushurl` with
 * one in it, and a `url.*` rewrite whose base has one. Sandboxed commands
 * read that configuration (sandbox.ts gitMetadata), so readiness refuses a
 * checkout that has any. Names only, never values; undefined when Git
 * can't read it. Worktree configuration exists only with
 * `extensions.worktreeConfig` on; without it Git refuses `--worktree` once
 * the repository has a linked worktree (as every Objective's Work Items
 * add), so that pass is skipped.
 */
export function checkoutCredentialEntries(
  checkout: string,
): string[] | undefined {
  const git = (...args: string[]) =>
    spawnSync("git", ["-C", checkout, "config", ...args], {
      env: gitEnvironment(),
      encoding: "utf8",
      timeout: 30_000,
    });
  // Exit 1 is an unset key; anything else unexpected is a failed read.
  const extension = git(
    "--local",
    "--get",
    "--type=bool",
    "extensions.worktreeConfig",
  );
  if (extension.status !== 0 && extension.status !== 1) return undefined;
  const scopes = ["--local"];
  if (extension.status === 0 && extension.stdout.trim() === "true")
    scopes.push("--worktree");
  const found = new Set<string>();
  for (const scope of scopes) {
    const read = git(scope, "--includes", "--null", "--list");
    if (read.status !== 0) return undefined;
    for (const entry of read.stdout.split("\0")) {
      const split = entry.indexOf("\n");
      const name = split < 0 ? entry : entry.slice(0, split);
      const value = split < 0 ? "" : entry.slice(split + 1);
      const key = name.toLowerCase();
      if (
        /^http\..*extraheader$/.test(key) ||
        (/^credential\.(?:.*\.)?helper$/.test(key) &&
          value.trimStart().startsWith("!")) ||
        /^credential\.(?:.*\.)?(?:username|password)$/.test(key) ||
        (/^remote\..*\.(?:url|pushurl)$/.test(key) &&
          URL_CREDENTIAL.test(value)) ||
        (key.startsWith("url.") && URL_CREDENTIAL.test(name.slice(4)))
      )
        found.add(name);
    }
  }
  return [...found];
}

export interface GitExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: Buffer;
  /** At most the first 4 KiB, trimmed. */
  stderr: string;
}

/** How long a Git sent SIGTERM (timeout or abort) has to clean up its lock files before SIGKILL. */
const TERM_GRACE_MS = 2_000;
/**
 * How long, once Git has exited, its process group may live on (a child
 * it left) before SIGKILL, and its output may stay open (a helper outside
 * the group still holding the pipe).
 */
const LINGER_MS = 1_000;
/** Standard output pinnedGitExit collects; more ends Git and rejects. */
const MAX_STDOUT_BYTES = 256 * 1024 * 1024;

/** pinnedGitExit's process groups not yet gone; the service's exit kills them. */
const gitGroups = new Set<number>();
process.once("exit", () => {
  for (const group of gitGroups) signalGroup(group, "SIGKILL");
});

/** Signal a whole process group; false when none of it is left. */
function signalGroup(group: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-group, signal);
    return true;
  } catch {
    return false;
  }
}

/**
 * Wait until no process of `group` is left: a Git's own children (`git
 * worktree add` runs `git reset --hard`) can hold its locks after it
 * exits. What lingers past LINGER_MS gets SIGKILL.
 */
async function reap(group: number): Promise<void> {
  for (const kill of [true, false]) {
    const end = Date.now() + LINGER_MS;
    while (signalGroup(group, 0) && Date.now() < end)
      await new Promise((resolve) => setTimeout(resolve, 20));
    if (!signalGroup(group, 0)) return;
    if (kill) signalGroup(group, "SIGKILL");
  }
}

/**
 * Run Git in `directory` with `env` (gitEnvironment by default) and report
 * how it exited. No timeout unless `timeoutMs` is given. Git leads a
 * process group of its own. A timeout or an abort sends the group SIGTERM,
 * so Git and its children remove their lock files, and SIGKILL after a
 * short grace; an abort rejects with the signal's reason. It settles only
 * once the whole group is gone, waiting a bounded time for the output to
 * close, so no child of it still holds a lock; standard output past 256
 * MiB ends Git and rejects.
 */
export function pinnedGitExit(
  directory: string,
  args: string[],
  options: {
    input?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
    /** Standard output to this file descriptor, or dropped, instead of returned. */
    stdout?: number | "ignore";
  } = {},
): Promise<GitExit> {
  return new Promise((done, failed) => {
    const { signal } = options;
    if (signal?.aborted) {
      failed(signal.reason);
      return;
    }
    const child = spawn("git", ["-C", directory, ...args], {
      env: options.env ?? gitEnvironment(),
      stdio: ["pipe", options.stdout ?? "pipe", "pipe"],
      detached: true,
    });
    const group = child.pid;
    if (group !== undefined) gitGroups.add(group);
    const out: Buffer[] = [];
    let size = 0;
    let err = "";
    let refused: unknown;
    let killTimer: NodeJS.Timeout | undefined;
    let closeTimer: NodeJS.Timeout | undefined;
    const stop = () => {
      if (group === undefined || killTimer) return;
      signalGroup(group, "SIGTERM");
      killTimer = setTimeout(
        () => signalGroup(group, "SIGKILL"),
        TERM_GRACE_MS,
      );
    };
    const onAbort = () => {
      refused ??= signal?.reason;
      stop();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const timeout =
      options.timeoutMs !== undefined
        ? setTimeout(stop, options.timeoutMs)
        : undefined;
    child.stdout?.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_STDOUT_BYTES) {
        refused ??= new Error(
          `git ${args[0]} in ${directory} wrote more than ${MAX_STDOUT_BYTES} bytes`,
        );
        out.length = 0;
        stop();
        return;
      }
      if (refused === undefined) out.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (err.length < 4096) err += chunk.toString("utf8");
    });
    let exit:
      | { code: number | null; signal: NodeJS.Signals | null }
      | undefined;
    let closed = false;
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(killTimer);
      clearTimeout(closeTimer);
      if (group !== undefined) gitGroups.delete(group);
      signal?.removeEventListener("abort", onAbort);
      child.stdout?.destroy();
      child.stderr?.destroy();
      if (refused !== undefined || !exit) failed(refused);
      else
        done({
          code: exit.code,
          signal: exit.signal,
          stdout: Buffer.concat(out),
          stderr: err.trim(),
        });
    };
    child.on("error", (error) => {
      refused ??= error;
      if (child.exitCode === null && child.signalCode === null) stop();
      if (group === undefined) settle();
    });
    child.on("close", () => {
      closed = true;
      if (exit) settle();
    });
    child.on("exit", (code, exitSignal) => {
      void reap(group!).then(() => {
        exit = { code, signal: exitSignal };
        if (closed) settle();
        else closeTimer = setTimeout(settle, LINGER_MS);
      });
    });
    child.stdin?.on("error", () => {
      // git may exit before reading stdin; its exit code reports the failure.
    });
    child.stdin?.end(options.input ?? "");
  });
}

/** Runs one `git cat-file` with `input` on standard input; its output. */
export type CatFile = (args: string[], input: string) => Promise<Buffer>;

/**
 * The exact bytes of these blobs, in order, from one `cat-file --batch`.
 * Each header must be `<oid> blob <size>`: a missing object, or one that is
 * not a blob, throws instead of misreading every object after it.
 */
export async function readBlobs(
  catFile: CatFile,
  oids: readonly string[],
): Promise<Buffer[]> {
  if (!oids.length) return [];
  const output = await catFile(
    ["cat-file", "--batch"],
    oids.map((oid) => `${oid}\n`).join(""),
  );
  let offset = 0;
  return oids.map((oid) => {
    const newline = output.indexOf(10, offset);
    const header = output
      .subarray(offset, newline < 0 ? undefined : newline)
      .toString("utf8");
    const [named, type, size] = header.split(" ");
    const bytes = Number(size);
    const end = newline + 1 + bytes;
    if (
      newline < 0 ||
      named !== oid ||
      type !== "blob" ||
      !Number.isSafeInteger(bytes) ||
      end > output.length
    )
      throw new Error(`git cat-file returned "${header}" for ${oid}`);
    offset = end + 1;
    return output.subarray(newline + 1, end);
  });
}

/**
 * The sizes of these objects that are blobs, by object id, from one
 * `cat-file --batch-check`; a missing object or a non-blob has no entry.
 */
export async function blobSizes(
  catFile: CatFile,
  oids: readonly string[],
): Promise<Map<string, number>> {
  const sizes = new Map<string, number>();
  if (!oids.length) return sizes;
  const output = await catFile(
    ["cat-file", "--batch-check"],
    oids.map((oid) => `${oid}\n`).join(""),
  );
  for (const line of output.toString("utf8").split("\n")) {
    const [oid, type, size] = line.split(" ");
    if (oid && type === "blob" && Number.isSafeInteger(Number(size)))
      sizes.set(oid, Number(size));
  }
  return sizes;
}

/** The lowercase hex SHA-256 of `bytes`. */
export function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const LFS_POINTER_HEADER = "version https://git-lfs.github.com/spec/v1\n";
/** Git LFS reads blobs up to this size as possible pointers. */
export const LFS_POINTER_MAX_BYTES = 1024;

/** A Git LFS pointer's object id (sha256) and size, or undefined. */
export function lfsPointer(
  bytes: Buffer,
): { oid: string; size: number } | undefined {
  if (bytes.length > LFS_POINTER_MAX_BYTES) return undefined;
  const body = bytes.toString("utf8");
  if (!body.startsWith(LFS_POINTER_HEADER)) return undefined;
  const oid = /^oid sha256:([0-9a-f]{64})$/m.exec(body)?.[1];
  const size = /^size (\d+)$/m.exec(body)?.[1];
  return oid && size ? { oid, size: Number(size) } : undefined;
}

/** The paths `git check-attr -z filter` reports as `filter=lfs`. */
export function lfsFiltered(output: Buffer): Set<string> {
  const fields = output.toString("utf8").split("\0");
  const paths = new Set<string>();
  for (let index = 0; index + 2 < fields.length; index += 3)
    if (fields[index + 2] === "lfs") paths.add(fields[index]!);
  return paths;
}

/**
 * Git with the operator's configuration, which holds credentials and
 * insteadOf rewrites: never prompting, with C messages. Returns standard
 * output; a non-zero exit rejects with execFile's error (code, stdout).
 */
async function operatorGit(
  checkout: string,
  args: string[],
  options: {
    signal?: AbortSignal;
    timeoutMs?: number;
    /** Added to this one call's environment (`tokenEnvironment`). */
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<string> {
  const { LANGUAGE: _language, LC_ALL: _all, ...env } = process.env;
  // No gc or maintenance that would outlive the call in the background.
  const { stdout } = await run(
    "git",
    [
      "-C",
      checkout,
      "-c",
      "gc.auto=0",
      "-c",
      "maintenance.auto=false",
      ...args,
    ],
    {
      env: {
        ...env,
        GIT_TERMINAL_PROMPT: "0",
        LC_MESSAGES: "C",
        ...options.env,
      },
      encoding: "utf8",
      timeout: options.timeoutMs ?? MINUTE,
      maxBuffer: 16 * 1024 * 1024,
      ...(options.signal ? { signal: options.signal } : {}),
    },
  );
  return stdout;
}

/**
 * Git refused to run: the tree's Git metadata or repository configuration
 * would let it run a program outside the sandbox, or origin no longer names
 * the target (`remoteGit`). `fix` names what the operator does.
 */
export class GitRefusal extends Error {
  constructor(
    readonly detail: string,
    readonly fix: string,
  ) {
    super(`${detail}. ${fix}`);
  }
}

/** `owner/name` of a supported GitHub clone URL; never credentials or raw URLs. */
export function remoteRepository(remote: string): string | undefined {
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
 * the fix. `remoteGit` checks it; delivery also holds on it before a merge.
 */
async function originProblem(
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

/** `originProblem` as a GitRefusal that names the fix, or undefined. */
export async function originRefusal(
  checkout: string,
  repository: string,
  signal?: AbortSignal,
): Promise<GitRefusal | undefined> {
  const problem = await originProblem(checkout, repository, signal);
  return problem
    ? new GitRefusal(
        problem,
        `Point origin's fetch and push URLs (and any insteadOf rewrite) at ${repository} with its default LFS route, then answer retry; or cancel`,
      )
    : undefined;
}

/**
 * Git that reaches origin (fetch, push, ls-remote, LFS transfer), with the
 * operator's configuration and credentials (a GitHub App's token instead,
 * `remoteToken`), once `originProblem` finds
 * origin still bound to `repository`; otherwise a GitRefusal that names
 * the fix, so the step holds instead of reaching the wrong place. Every
 * remote Git call goes through here.
 */
export async function remoteGit(
  checkout: string,
  repository: string,
  args: string[],
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<string> {
  const run = await originBound(checkout, repository, options.signal);
  return run(args, options.timeoutMs);
}

/**
 * The origin check of `remoteGit` on its own: throws its GitRefusal, else
 * returns a runner for the remote call that follows at once. A caller that
 * catches the call's failures binds before its `try`, so no catch can
 * turn the refusal into a retry.
 */
export async function originBound(
  checkout: string,
  repository: string,
  signal?: AbortSignal,
): Promise<(args: string[], timeoutMs?: number) => Promise<string>> {
  const refusal = await originRefusal(checkout, repository, signal);
  if (refusal) throw refusal;
  // A GitHub App's token is read here too, so its refusal escapes as well.
  const token = remoteTokens.get(repository.toLowerCase());
  const env = token ? tokenEnvironment(await token()) : undefined;
  return (args, timeoutMs = 5 * MINUTE) =>
    operatorGit(checkout, ["-c", "protocol.file.allow=never", ...args], {
      ...(signal ? { signal } : {}),
      timeoutMs,
      ...(env ? { env } : {}),
    });
}

/**
 * Per repository, the token its remote Git calls authenticate with in
 * place of the operator's Git credentials: a GitHub App's installation
 * token (github-app.ts `factoryGitHub`), read for each call.
 */
const remoteTokens = new Map<string, () => Promise<string>>();

/** Authenticate `repository`'s remote Git calls with `token` (`remoteTokens`). */
export function remoteToken(
  repository: string,
  token: () => Promise<string>,
): void {
  remoteTokens.set(repository.toLowerCase(), token);
}

/**
 * Configuration for one Git call, as GIT_CONFIG_* entries after any the
 * environment has (they outrank every file), that sends `token` to
 * github.com as an installation token's basic authorization: the
 * operator's credential helpers and extra headers for github.com are
 * cleared first, so a refused token never falls back to them. Nothing is
 * written to a configuration file, and only that call's environment has
 * it: never a worker's or a sandboxed command's (worktree.ts
 * `workerEnvironment`). An SSH origin doesn't use it.
 */
export function tokenEnvironment(token: string): NodeJS.ProcessEnv {
  const first = Number(process.env.GIT_CONFIG_COUNT) || 0;
  const header = Buffer.from(`x-access-token:${token}`).toString("base64");
  const entries: [string, string][] = [
    ["credential.https://github.com.helper", ""],
    ["http.https://github.com/.extraheader", ""],
    ["http.https://github.com/.extraheader", `AUTHORIZATION: basic ${header}`],
  ];
  const env: NodeJS.ProcessEnv = {
    GIT_CONFIG_COUNT: String(first + entries.length),
  };
  entries.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${first + index}`] = key;
    env[`GIT_CONFIG_VALUE_${first + index}`] = value;
  });
  return env;
}

/** Whether origin's push URL (after insteadOf) isn't https: Git then pushes with the host's SSH login. */
export async function pushesOverSsh(checkout: string): Promise<boolean> {
  const url = await operatorGit(checkout, [
    "remote",
    "get-url",
    "--push",
    "origin",
  ]);
  return !url.trim().startsWith("https://");
}

/**
 * The URL of `other`, another GitHub repository, reached like origin:
 * origin's fetch URL (after insteadOf) with `other`'s owner and name, so
 * the operator's GitHub credentials serve it. Use it with `remoteGit`,
 * which checks origin first.
 */
export async function siblingUrl(
  checkout: string,
  other: string,
): Promise<string> {
  const origin = (
    await operatorGit(checkout, ["remote", "get-url", "origin"])
  ).trim();
  const scp = /^git@github\.com:/i.exec(origin)?.[0];
  let url: string;
  if (scp) url = `${scp}${other}.git`;
  else {
    const parsed = new URL(origin);
    parsed.pathname = `/${other}.git`;
    url = parsed.href;
  }
  if (remoteRepository(url) !== other.toLowerCase())
    throw new Error(`Can't reach ${other} the way origin is reached`);
  return url;
}

/**
 * Fetch the target and return its default branch head, through
 * `remoteGit`: origin must still name `repository`.
 *
 * Fetches in one checkout run one at a time: concurrent fetches fail
 * against each other whenever the default branch moves ("incorrect old
 * value"), so every caller would lose but one. A caller joins the fetch
 * that starts after the running one ends, shared by everyone who asked
 * meanwhile, so the head it gets is never from a fetch that began before
 * it asked. `signal` ends the caller's wait, not the shared fetch.
 */
export async function defaultHead(
  checkout: string,
  repository: string,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  const head = sharedFetch(checkout, repository);
  return await new Promise<string>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    head
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

/** Per checkout: the fetch running, and the one queued after it. */
const flights = new Map<
  string,
  { running: Promise<string>; next?: Promise<string> }
>();

/** The next fetch of `checkout` to start: now, or once the running one ends. */
function sharedFetch(checkout: string, repository: string): Promise<string> {
  const flight = flights.get(checkout);
  if (!flight) return fetchHead(checkout, repository);
  if (!flight.next) {
    const start = () => fetchHead(checkout, repository);
    flight.next = flight.running.then(start, start);
  }
  return flight.next;
}

function fetchHead(checkout: string, repository: string): Promise<string> {
  const running = fetchOnce(checkout, repository);
  const flight: { running: Promise<string>; next?: Promise<string> } = {
    running,
  };
  flights.set(checkout, flight);
  // A queued fetch takes the checkout over when it starts.
  const end = () => {
    if (!flight.next && flights.get(checkout) === flight)
      flights.delete(checkout);
  };
  running.then(end, end);
  return running;
}

async function fetchOnce(
  checkout: string,
  repository: string,
): Promise<string> {
  try {
    await remoteGit(checkout, repository, [
      "fetch",
      "--quiet",
      "--prune",
      "origin",
    ]);
    await remoteGit(checkout, repository, [
      "remote",
      "set-head",
      "origin",
      "--auto",
    ]);
    return (
      await operatorGit(checkout, [
        "rev-parse",
        "--verify",
        "refs/remotes/origin/HEAD^{commit}",
      ])
    ).trim();
  } catch (error) {
    // The origin check's refusal, or a GitHub App's (its key, its installation).
    if (error instanceof GitRefusal || error instanceof GitHubError)
      throw error;
    throw new TransientError(
      `git fetch in ${checkout}: ${errorMessage(error)}`,
    );
  }
}

/**
 * The shortest whole secret value a push is refused for. Redaction
 * (config.ts MIN_SECRET_LENGTH) goes lower: hiding a short value from a
 * comment is harmless, but refusing every file that contains one isn't.
 */
const MIN_REFUSED_SECRET = 8;

/** The shortest piece of a multi-line secret a push is refused for. */
const MIN_REFUSED_PIECE = 16;

/** A PEM armor line, the same in every key. */
const PEM_ARMOR = /^-----(?:BEGIN|END) [A-Z0-9 ]+-----$/;

/**
 * Whether a piece of a multi-line secret looks like key material: mixed
 * case and digits (base64), or long hex, with high entropy. JSON keys,
 * well-known URLs and other lowercase words don't qualify.
 */
function keyMaterial(piece: string): boolean {
  if (piece.length < MIN_REFUSED_PIECE || PEM_ARMOR.test(piece)) return false;
  const mixed = /[a-z]/.test(piece) && /[A-Z]/.test(piece) && /\d/.test(piece);
  if (!mixed && !/^[0-9a-fA-F]{32,}$/.test(piece)) return false;
  const counts = new Map<string, number>();
  for (const c of piece) counts.set(c, (counts.get(c) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values())
    bits -= (n / piece.length) * Math.log2(n / piece.length);
  return bits >= 3.5;
}

/**
 * The byte strings a push is refused for, as written and base64: each
 * whole secret value, and the pieces of a multi-line one (a PEM key, a
 * service-account JSON) that are key material, so a fixture holding PEM
 * armor or a common JSON line isn't refused.
 */
function secretNeedles(secrets: readonly string[]): {
  exact: Buffer[];
  encoded: Buffer[];
} {
  const values = new Set<string>();
  for (const secret of secrets) {
    if (secret.length >= MIN_REFUSED_SECRET) values.add(secret);
    if (!/[\r\n]/.test(secret)) continue;
    for (const line of secret.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (keyMaterial(trimmed)) values.add(trimmed);
      for (const token of trimmed.split(/[\s"',:;{}[\]=]+/))
        if (keyMaterial(token)) values.add(token);
    }
  }
  const exact: Buffer[] = [];
  const encoded = new Set<string>();
  for (const value of values) {
    const bytes = Buffer.from(value);
    exact.push(bytes);
    // At each byte alignment: only the characters the value alone decides.
    for (const shift of [0, 1, 2]) {
      const text = Buffer.concat([Buffer.alloc(shift), bytes]).toString(
        "base64",
      );
      const whole = Math.floor((shift + bytes.length) / 3) * 4;
      const core = text.slice([0, 2, 3][shift], whole);
      if (core.length < 8) continue;
      encoded.add(core);
      encoded.add(core.replace(/\+/g, "-").replace(/\//g, "_"));
    }
  }
  return { exact, encoded: [...encoded].map((text) => Buffer.from(text)) };
}

/** Finds any needle in a stream of chunks, keeping only a needle's length of tail. */
class StreamSearch {
  private tail: Buffer = Buffer.alloc(0);
  private readonly keep: number;
  found = false;
  constructor(private readonly needles: readonly Buffer[]) {
    this.keep = Math.max(0, ...needles.map((needle) => needle.length - 1));
  }
  feed(chunk: Buffer): void {
    if (this.found || !this.needles.length) return;
    const text = Buffer.concat([this.tail, chunk]);
    this.found = this.needles.some((needle) => text.includes(needle));
    this.tail = text.subarray(Math.max(0, text.length - this.keep));
  }
}

/**
 * A search of one stream of bytes for the values of `secrets`
 * (config.secrets, secretNeedles): as written, or
 * base64 (standard or URL-safe, at any alignment, line breaks ignored).
 * Memory stays bounded by the longest needle, whatever the stream's size.
 */
export function secretSearch(secrets: readonly string[]): () => {
  feed(chunk: Buffer): void;
  readonly found: boolean;
} {
  const { exact, encoded } = secretNeedles(secrets);
  return () => {
    const raw = new StreamSearch(exact);
    const flat = new StreamSearch(encoded);
    return {
      feed(chunk: Buffer) {
        raw.feed(chunk);
        flat.feed(
          Buffer.from(
            chunk.toString("latin1").replace(/[\r\n]/g, ""),
            "latin1",
          ),
        );
      },
      get found() {
        return raw.found || flat.found;
      },
    };
  };
}

/**
 * The paths whose content `commit` adds or changes against `base` that
 * hold a value of `secrets` (secretSearch). Blobs stream through one
 * `cat-file --batch`. Throws when Git fails.
 */
export async function pathsHoldingSecrets(
  directory: string,
  base: string,
  commit: string,
  secrets: readonly string[],
  signal?: AbortSignal,
): Promise<string[]> {
  if (!secrets.length) return [];
  const diff = await pinnedGitExit(
    directory,
    [
      "diff-tree",
      "-r",
      "-z",
      "--no-renames",
      "--no-commit-id",
      "--diff-filter=ACMT",
      base,
      commit,
    ],
    signal ? { signal } : {},
  );
  if (diff.code !== 0)
    throw new Error(`git diff-tree ${base} ${commit}: ${diff.stderr}`);
  const fields = diff.stdout.toString("utf8").split("\0");
  const paths = new Map<string, string[]>();
  for (let at = 0; at + 1 < fields.length; at += 2) {
    const [, mode, , oid] = fields[at]!.split(" ");
    if (!oid || mode === "160000") continue;
    paths.set(oid, [...(paths.get(oid) ?? []), fields[at + 1]!]);
  }
  const oids = [...paths.keys()];
  if (!oids.length) return [];
  const search = secretSearch(secrets);
  const holding: string[] = [];
  await new Promise<void>((done, failed) => {
    const child = spawn("git", ["-C", directory, "cat-file", "--batch"], {
      env: gitEnvironment(),
      stdio: ["pipe", "pipe", "ignore"],
      ...(signal ? { signal } : {}),
    });
    let index = 0;
    let pending: Buffer = Buffer.alloc(0);
    let remaining = -1; // -1: reading a header; 0: the newline after the content.
    let blob = search();
    let broken: Error | undefined;
    child.stdout.on("data", (chunk: Buffer) => {
      let buffer: Buffer = pending.length
        ? Buffer.concat([pending, chunk])
        : chunk;
      pending = Buffer.alloc(0);
      while (buffer.length && !broken) {
        if (remaining < 0) {
          const newline = buffer.indexOf(10);
          if (newline < 0) {
            pending = buffer;
            return;
          }
          const header = buffer.subarray(0, newline).toString("utf8");
          const [named, type, size] = header.split(" ");
          if (named !== oids[index] || type !== "blob" || !size) {
            broken = new Error(`git cat-file returned "${header}"`);
            child.kill();
            return;
          }
          remaining = Number(size);
          blob = search();
          buffer = buffer.subarray(newline + 1);
          continue;
        }
        if (remaining > 0) {
          const part = buffer.subarray(0, remaining);
          blob.feed(part);
          remaining -= part.length;
          buffer = buffer.subarray(part.length);
          continue;
        }
        // The newline that ends the content.
        buffer = buffer.subarray(1);
        if (blob.found) holding.push(...paths.get(oids[index]!)!);
        index += 1;
        remaining = -1;
      }
    });
    child.on("error", failed);
    child.on("close", (code) => {
      if (broken) failed(broken);
      else if (code !== 0 || index !== oids.length)
        failed(new Error(`git cat-file --batch exited ${code}`));
      else done();
    });
    child.stdin.on("error", () => {
      // git may exit before reading stdin; its exit code reports the failure.
    });
    child.stdin.end(oids.map((oid) => `${oid}\n`).join(""));
  });
  return holding.sort();
}
