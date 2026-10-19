/**
 * The operating-system sandbox for every command a worker can cause to run
 * on the controller's host: declared validation commands, setup and
 * prerequisite commands and readiness probes. Each command
 * runs under bubblewrap in new user, PID, IPC, UTS, cgroup and network
 * namespaces. It sees the system read-only, the PATH's toolchains read-only,
 * its checkout (writable, its `.git` entry read-only) and the checkout's git
 * metadata read-only, a private HOME and TMPDIR, and nothing else: not the
 * operator's HOME, logins, SSH keys, gh or provider configuration, nor
 * Factory's own configuration, data or state. Network is off; loopback works.
 *
 * Codex workers keep Codex's own sandbox; this one covers what runs outside it.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { StepFault } from "../fault.js";
import { type BubblewrapLaunch, workerToolchainPath } from "../process.js";
import { record, refuseUnknownFields } from "../unknown-fields.js";

export const real = (path: string) =>
  existsSync(path) ? realpathSync(path) : resolve(path);
export const within = (path: string, directory: string) =>
  path === directory ||
  path.startsWith(directory.endsWith(sep) ? directory : directory + sep);

/**
 * A linked worktree's git directories: its own administrative directory
 * (`<common>/worktrees/<name>`) and the checkout's common git directory.
 */
function linkedGit(
  workspace: string,
): { administrative: string; common: string } | undefined {
  try {
    const link = /^gitdir: (.+)$/m.exec(
      readFileSync(join(workspace, ".git"), "utf8"),
    );
    if (!link) return undefined;
    const administrative = resolve(workspace, link[1]!);
    const common = join(administrative, "commondir");
    return {
      administrative,
      common: existsSync(common)
        ? resolve(administrative, readFileSync(common, "utf8").trim())
        : administrative,
    };
  } catch {
    // No `.git`, or a checkout whose `.git` directory the profile keeps read-only.
    return undefined;
  }
}

/**
 * What git reads in a linked worktree, mounted read-only at their real paths
 * so read-only commands (`ls-files`, `status`, `diff`, `log`) work: the
 * worktree's administrative directory (HEAD, index) and, from the common
 * directory, the objects, refs and settings. Not the common directory as a
 * whole: that would show other worktrees' metadata, hooks and reflogs.
 * A `.git` that is not a linked worktree's gets nothing.
 */
export function gitMetadata(workspace: string): string[] {
  const git = linkedGit(workspace);
  if (!git || git.common === git.administrative) return [];
  // Only a real linked worktree's metadata: `<common>/worktrees/<name>`,
  // whose `gitdir` names this checkout's `.git`.
  try {
    if (
      real(dirname(git.administrative)) !==
        real(join(git.common, "worktrees")) ||
      real(readFileSync(join(git.administrative, "gitdir"), "utf8").trim()) !==
        real(join(workspace, ".git"))
    )
      return [];
  } catch {
    return [];
  }
  return [
    git.administrative,
    ...[
      "objects",
      "refs",
      "packed-refs",
      "HEAD",
      "config",
      "info",
      "shallow",
      "reftable",
    ].map((name) => join(git.common, name)),
  ]
    .filter((path) => existsSync(path))
    .map((path) => realpathSync(path));
}

const credentialDirectories = [
  "ssh",
  "aws",
  "docker",
  "kube",
  "gnupg",
  "gh",
  "codex",
  "claude",
  "copilot",
];

const windowsProfile = (directory: string) =>
  /^\/mnt\/[a-z]\/Users\/[^/]+(?=\/|$)/i.exec(directory)?.[0];

/**
 * Whether mounting `directory` would show a sandbox the operator's HOME as a
 * whole, a login (SSH, gh, Codex, Claude, Copilot, cloud), Factory's own
 * configuration, data or state, or the checkout's common git directory.
 */
function privatePaths(
  source: NodeJS.ProcessEnv,
  workspace: string,
  sealCommonGit = true,
): { home: string; exposes: (directory: string) => boolean } {
  const home = real(source.HOME || homedir());
  const config = source.XDG_CONFIG_HOME || join(home, ".config");
  const state = source.XDG_STATE_HOME || join(home, ".local", "state");
  const data = source.XDG_DATA_HOME || join(home, ".local", "share");
  const linked = linkedGit(workspace);
  const sealed = [
    join(home, ".ssh"),
    join(home, ".claude"),
    join(home, ".copilot"),
    join(home, ".aws"),
    join(home, ".docker"),
    join(home, ".kube"),
    join(home, ".gnupg"),
    ...[config, data].flatMap((root) =>
      credentialDirectories.map((name) => join(root, name)),
    ),
    source.CODEX_HOME || join(home, ".codex"),
    join(config, "clockgrove-factory"),
    join(data, "clockgrove-factory"),
    join(data, "factory-copilot-auth"),
    join(state, "clockgrove-factory"),
    ...(linked && sealCommonGit ? [linked.common] : []),
  ].map(real);
  return {
    home,
    exposes: (directory: string) => {
      const profile = windowsProfile(directory);
      const protectedPaths = profile
        ? credentialDirectories.map((name) => real(join(profile, `.${name}`)))
        : [];
      return (
        within(home, directory) ||
        /^\/mnt(?:\/[a-z](?:\/Users)?)?\/?$/i.test(directory) ||
        (profile !== undefined && within(profile, directory)) ||
        [...sealed, ...protectedPaths].some(
          (path) => within(path, directory) || within(directory, path),
        )
      );
    },
  };
}

/**
 * Whether a read-only mount of `path` could show a sandbox host sockets,
 * which such a mount still lets a process connect to (a user bus, a
 * container daemon, a terminal multiplexer, an SSH agent): it is, holds or
 * lies in a runtime directory, or it is or holds a shared temporary
 * directory or lies in one, where any host process keeps them.
 */
function showsHostSockets(path: string): boolean {
  const runtime = [
    "/run",
    "/var/run",
    "/proc",
    "/sys",
    "/dev",
    ...(process.env.XDG_RUNTIME_DIR ? [process.env.XDG_RUNTIME_DIR] : []),
  ].map(real);
  const temporary = ["/tmp", "/var/tmp", tmpdir()].map(real);
  return (
    runtime.some((root) => within(path, root) || within(root, path)) ||
    temporary.some((root) => within(root, path) || within(path, root))
  );
}

/**
 * The directories a sandboxed shell reads, never writes, so the tools on its
 * PATH run: every PATH directory, and the directory of the real file behind
 * each link in one. A directory named `bin` or `sbin` stands for its install
 * prefix, where a tool keeps its libraries, unless the prefix is hidden,
 * the HOME or Windows profile itself, or a direct child of either. Those
 * directories can contain unrelated private files; mount only bin there.
 *
 * Nothing here may show the operator's HOME as a whole, a login (SSH, gh,
 * Codex, Claude, Copilot), Factory's config or state, the checkout's git
 * directory, or host sockets in a runtime or shared temporary directory. A
 * PATH directory that would is a configuration error; a link that leads into
 * one, or that the operator cannot follow, is left unmounted, so that tool
 * does not run.
 */
export function toolchainDirectories(
  source: NodeJS.ProcessEnv,
  workspace: string,
  audience: string,
): string[] {
  const { home, exposes } = privatePaths(source, workspace);
  const hidden = (directory: string) =>
    exposes(directory) || showsHostSockets(directory);
  const root = (directory: string) => {
    const prefix = dirname(directory);
    if (
      ["bin", "sbin"].includes(basename(directory)) &&
      !basename(prefix).startsWith(".") &&
      dirname(prefix) !== home &&
      dirname(prefix) !== windowsProfile(prefix) &&
      !hidden(prefix)
    )
      return prefix;
    return hidden(directory) ? undefined : directory;
  };
  const refused = `would show ${audience} your HOME, a login, Factory's own files, runtime sockets or the shared temporary directory`;
  const roots = new Set<string>();
  for (const entry of (source.PATH ?? "").split(":")) {
    // A relative entry resolves inside the worktree, which is mounted.
    if (!isAbsolute(entry) || !existsSync(entry)) continue;
    const directory = realpathSync(entry);
    if (!statSync(directory).isDirectory() || within(directory, workspace))
      continue;
    const mount = root(directory);
    // A linked PATH directory is mounted under the name the PATH uses too.
    const named = resolve(entry);
    if (!mount || hidden(named))
      throw new Error(
        `PATH entry ${entry} ${refused}. Remove it from the PATH Factory runs with, or move its tools to a directory of their own.`,
      );
    roots.add(mount).add(named);
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      if (!item.isSymbolicLink()) continue;
      let target: string;
      try {
        target = realpathSync(join(directory, item.name));
        if (!statSync(target).isFile()) continue;
      } catch {
        // A link the operator cannot follow names no tool that could run.
        continue;
      }
      // A link into a login directory stays unmounted: that tool does not run.
      const linked = root(dirname(target));
      if (linked) roots.add(linked);
    }
  }
  // Factory runs its own Node in the sandbox (the readiness probe and local
  // worker helpers), so mount it like a PATH directory even when the PATH
  // Factory was started with omits it, as an installed launcher does (#1269).
  const runtime = real(dirname(process.execPath));
  if (!within(runtime, workspace)) {
    const mount = root(runtime);
    if (!mount)
      throw new Error(
        `Factory's Node runtime at ${runtime} ${refused}. Install Node in a directory of its own.`,
      );
    roots.add(mount);
  }
  return [...roots].filter(
    (mount) =>
      ![...roots].some((other) => other !== mount && within(mount, other)),
  );
}

/** The operator's `sandbox` configuration; every field is optional. */
export interface CommandSandboxConfig {
  /**
   * Refuse to run commands when bubblewrap is unavailable (the default).
   * `false` runs them unsandboxed on such a host instead: an explicit
   * operator choice, shown by status and setup.
   */
  required?: boolean;
  /**
   * `off` (the default): no command reaches the network. `package-install`:
   * only Factory's exact script-disabled dependency installs
   * (`pnpm install --frozen-lockfile --ignore-scripts`, `npm ci
   * --ignore-scripts`) reach it, to fetch packages a cold store lacks.
   */
  network?: "off" | "package-install";
  /**
   * A directory of its own for package-manager caches, shared writable by
   * sandboxed commands: the pnpm store and metadata cache and the npm cache.
   * A warm store lets installs run without the network.
   */
  packageStore?: string;
  /** Further host directories commands may read, such as a toolchain outside the PATH. */
  readOnlyPaths?: string[];
  /** Resource limits for each command; omitted fields use the defaults. */
  limits?: {
    /** Size of the private /tmp and /dev/shm, each, in MiB (default 1024). */
    tmpMiB?: number;
    /** RLIMIT_NPROC: processes the operator's account may have while it runs (default 4096). */
    processes?: number;
  };
}

export const DEFAULT_SANDBOX_LIMITS = { tmpMiB: 1024, processes: 4096 };

/** The effective policy; strict unless the operator's configuration relaxes it. */
export interface CommandSandboxPolicy {
  required: boolean;
  network: "off" | "package-install";
  packageStore?: string;
  readOnlyPaths: string[];
  limits: { tmpMiB: number; processes: number };
  /**
   * Set only by a caller that checked these commands' package inputs
   * (assertPinnedNpmScripts) on this exact tree; without it no install gets
   * network or a writable store.
   */
  packageInputsVerified?: true;
  /**
   * The Objective's accepted base. A verified install reaches the network only
   * when its lockfiles and package-manager configuration are byte-identical
   * to this commit's: a candidate's lockfile could otherwise name tarball
   * URLs that carry the repository's contents anywhere.
   */
  packageInputsBase?: string;
}

export const STRICT_COMMAND_SANDBOX: CommandSandboxPolicy = {
  required: true,
  network: "off",
  readOnlyPaths: [],
  limits: DEFAULT_SANDBOX_LIMITS,
};

export function assertCommandSandboxConfig(value: unknown): void {
  const sandbox = record(value, "sandbox");
  refuseUnknownFields(
    sandbox,
    ["required", "network", "packageStore", "readOnlyPaths", "limits"],
    "sandbox",
  );
  if (sandbox.limits !== undefined) {
    const limits = record(sandbox.limits, "sandbox.limits");
    refuseUnknownFields(limits, ["tmpMiB", "processes"], "sandbox.limits");
    const integer = (value: unknown, minimum: number) =>
      value === undefined ||
      (Number.isSafeInteger(value) && (value as number) >= minimum);
    if (!integer(limits.tmpMiB, 16))
      throw new Error(
        "sandbox.limits.tmpMiB must be an integer of at least 16",
      );
    if (!integer(limits.processes, 64))
      throw new Error(
        "sandbox.limits.processes must be an integer of at least 64",
      );
  }
  if (sandbox.required !== undefined && typeof sandbox.required !== "boolean")
    throw new Error("sandbox.required must be a boolean");
  if (
    sandbox.network !== undefined &&
    sandbox.network !== "off" &&
    sandbox.network !== "package-install"
  )
    throw new Error('sandbox.network must be "off" or "package-install"');
  const absolute = (path: unknown) =>
    typeof path === "string" &&
    isAbsolute(path) &&
    resolve(path) === path &&
    path !== "/";
  if (sandbox.packageStore !== undefined && !absolute(sandbox.packageStore))
    throw new Error(
      "sandbox.packageStore must be an absolute, normalized directory path",
    );
  if (
    sandbox.readOnlyPaths !== undefined &&
    (!Array.isArray(sandbox.readOnlyPaths) ||
      !sandbox.readOnlyPaths.every(absolute))
  )
    throw new Error(
      "sandbox.readOnlyPaths must be absolute, normalized directory paths",
    );
}

export function commandSandboxPolicy(config?: {
  sandbox?: CommandSandboxConfig;
}): CommandSandboxPolicy {
  const sandbox = config?.sandbox ?? {};
  return {
    required: sandbox.required ?? true,
    network: sandbox.network ?? "off",
    ...(sandbox.packageStore && { packageStore: sandbox.packageStore }),
    readOnlyPaths: [...(sandbox.readOnlyPaths ?? [])],
    limits: { ...DEFAULT_SANDBOX_LIMITS, ...sandbox.limits },
  };
}

/** System directories every sandbox reads; the rest of `/` is not mounted. */
const SYSTEM_DIRECTORIES = [
  "/usr",
  "/bin",
  "/sbin",
  "/lib",
  "/lib32",
  "/lib64",
  "/libx32",
  "/etc",
];

/** Arguments that mount the system: real directories read-only, merged-/usr links as links. */
function systemMounts(): string[] {
  const args: string[] = [];
  for (const path of SYSTEM_DIRECTORIES) {
    const entry = lstatSync(path, { throwIfNoEntry: false });
    if (!entry) continue;
    if (entry.isSymbolicLink())
      args.push("--symlink", readlinkSync(path), path);
    else if (entry.isDirectory()) args.push("--ro-bind", path, path);
  }
  return args;
}

/** Namespaces and lifetime: the sandbox ends with the process that spawned bubblewrap. */
const ISOLATION = ["--unshare-all", "--die-with-parent", "--cap-drop", "ALL"];

function bubblewrapExecutable(): string | undefined {
  const candidates = [
    "/usr/bin/bwrap",
    "/usr/local/bin/bwrap",
    ...(process.env.PATH ?? "")
      .split(delimiter)
      .filter((entry) => isAbsolute(entry))
      .map((entry) => join(entry, "bwrap")),
  ];
  return candidates.find((candidate) => {
    try {
      return statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
}

export type CommandSandboxAvailability =
  | {
      available: true;
      executable: string;
      version: string;
      /** This bubblewrap can size a tmpfs (`--size`, 0.10 and later). */
      tmpfsSize: boolean;
    }
  | { available: false; installed: boolean; detail: string };

let availability: CommandSandboxAvailability | undefined;

let failure: { at: number; result: CommandSandboxAvailability } | undefined;
/** How long a failed probe answers before bubblewrap is probed again. */
const FAILURE_RETRY_MS = 30_000;

/**
 * Whether bubblewrap starts a sandbox on this host, probed with the same
 * namespaces and system mounts every command gets. Success is kept for the
 * process. A failure answers for 30 seconds and is then probed again, so a
 * transient one never turns the sandbox off and a broken host is not
 * re-probed on every call.
 */
export function commandSandboxAvailability(): CommandSandboxAvailability {
  if (availability) return availability;
  if (failure && Date.now() - failure.at < FAILURE_RETRY_MS)
    return failure.result;
  const probed = probeCommandSandbox();
  if (probed.available) availability = probed;
  else failure = { at: Date.now(), result: probed };
  return probed;
}

function probeCommandSandbox(): CommandSandboxAvailability {
  const executable = bubblewrapExecutable();
  if (!executable)
    return {
      available: false,
      installed: false,
      detail: "bubblewrap (bwrap) is not installed",
    };
  const version = spawnSync(executable, ["--version"], {
    encoding: "utf8",
    timeout: 10_000,
  });
  const probe = spawnSync(
    executable,
    [
      ...ISOLATION,
      ...systemMounts(),
      "--proc",
      "/proc",
      "--dev",
      "/dev",
      "--tmpfs",
      "/tmp",
      "--",
      "/bin/sh",
      "-c",
      "exit 0",
    ],
    { encoding: "utf8", timeout: 10_000, env: {} },
  );
  if (probe.status === 0) {
    const help = spawnSync(executable, ["--help"], {
      encoding: "utf8",
      timeout: 10_000,
    });
    return {
      available: true,
      executable,
      version: version.stdout.trim() || "unknown",
      tmpfsSize: /^\s*--size\b/m.test(`${help.stdout}${help.stderr}`),
    };
  }
  return {
    available: false,
    installed: true,
    detail: `bubblewrap could not start a sandbox (${probe.error?.message ?? `exit ${probe.status ?? probe.signal}`}): ${(probe.stderr ?? "").trim().slice(0, 500)}`,
  };
}

/**
 * Under a root controller bubblewrap's user namespace maps to the host's
 * root, which owns root-only files (`/etc/shadow`, SSH host keys): dropped
 * capabilities and `--uid` do not change that. Commands cannot run as another
 * user instead, since the checkout, HOME and TMPDIR they write are root's.
 */
const runsAsRoot = () => process.geteuid?.() === 0;

const ROOT_DETAIL =
  "Factory runs as root, so sandboxed commands would read root-only host files such as /etc/shadow and SSH host keys";

const ROOT_FIX =
  "Run Factory as an unprivileged user. Only if commands may read root-only host files, set sandbox.required to false in the Factory configuration.";

const UNAVAILABLE_FIX =
  "Install bubblewrap (`bwrap`) and allow unprivileged user namespaces on this host. Only if commands must run unsandboxed here, set sandbox.required to false in the Factory configuration.";

/** What status and setup show about the sandbox commands run in. */
export function commandSandboxStatus(policy: CommandSandboxPolicy): {
  mode: "bubblewrap" | "unsandboxed" | "unavailable";
  network: CommandSandboxPolicy["network"];
  packageStore?: string;
  detail: string;
  fix?: string;
} {
  const found = commandSandboxAvailability();
  const shared = {
    network: policy.network,
    ...(policy.packageStore && { packageStore: policy.packageStore }),
  };
  if (found.available && runsAsRoot() && policy.required)
    return {
      mode: "unavailable",
      ...shared,
      detail: `${ROOT_DETAIL}; Factory refuses to run worker-caused commands`,
      fix: ROOT_FIX,
    };
  if (found.available)
    return {
      mode: "bubblewrap",
      ...shared,
      detail: `${runsAsRoot() ? `${ROOT_DETAIL}, as sandbox.required false allows; ` : ""}${found.version} at ${found.executable}; network ${policy.network === "off" ? "off for every command" : "only for verified package installs"}; at most ${policy.limits?.processes ?? DEFAULT_SANDBOX_LIMITS.processes} processes; private /tmp ${found.tmpfsSize ? `${policy.limits?.tmpMiB ?? DEFAULT_SANDBOX_LIMITS.tmpMiB} MiB` : "unsized (this bubblewrap has no --size)"}`,
    };
  if (!policy.required && !found.installed)
    return {
      mode: "unsandboxed",
      ...shared,
      detail: `${found.detail}; sandbox.required is false, so worker-caused commands run unsandboxed with the operator's file access`,
    };
  return {
    mode: "unavailable",
    ...shared,
    detail: `${found.detail}; Factory refuses to run worker-caused commands`,
    fix: found.installed
      ? "Make bubblewrap able to start a sandbox on this host (unprivileged user namespaces); sandbox.required false applies only where bubblewrap is not installed."
      : UNAVAILABLE_FIX,
  };
}

const configFault = (detail: string, fix: string) =>
  new StepFault({ kind: "config", detail, fix });

/** One command to run, and what it may write. */
export interface SandboxedCommandInput {
  command: string;
  /** Mounted writable at its own path; its `.git` entry stays read-only. */
  checkout: string;
  /** The private TMPDIR, writable at its own path. */
  temporary: string;
  /** The private HOME, writable at its own path. */
  home: string;
  /** The command's environment before sandboxing; HOME and host paths are replaced. */
  env: Record<string, string>;
  /** This command may reach the network (the policy decides which may). */
  network: boolean;
  /**
   * A verified dependency install: the package store is writable and
   * package-manager hooks are forced off. Every other command reads it only.
   */
  packageInstall: boolean;
  policy: CommandSandboxPolicy;
}

/** Variables that name host directories the sandbox does not mount. */
const HOST_DIRECTORY_VARIABLES = [
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
  "XDG_RUNTIME_DIR",
  "CODEX_HOME",
  "CODEX_SQLITE_HOME",
  "GH_CONFIG_DIR",
];

/**
 * The process to spawn for `command`: `sh -c` inside bubblewrap, or plain
 * `sh -c` only when the operator set `sandbox.required` false and bubblewrap
 * is not installed. Run it with subprocessAsync, passing `bubblewrap`: that
 * reads bubblewrap's status, so a setup failure is a configuration fault,
 * never the command's failure, and makes bubblewrap the leader of its own
 * session and process group, without a controlling terminal, which it stops
 * and proves gone. A process that leaves the group inside the sandbox
 * still ends with it: when the command exits, the PID namespace's init exits
 * and the kernel kills the rest first. Throws a configuration fault when the
 * sandbox cannot run, or when Factory runs as root and sandbox.required is
 * not false.
 */
export function sandboxedCommand(input: SandboxedCommandInput): {
  file: string;
  args: string[];
  env: Record<string, string>;
  sandbox: "bubblewrap" | "none";
  bubblewrap?: BubblewrapLaunch;
} {
  const found = commandSandboxAvailability();
  if (!found.available) {
    // Unsandboxed only by explicit choice and only without bubblewrap: an
    // installed one that fails is a fault, never a reason to run bare.
    if (input.policy.required || found.installed)
      throw configFault(
        `The command sandbox is unavailable: ${found.detail}. Factory refuses to run worker-caused commands without it.`,
        UNAVAILABLE_FIX,
      );
    return {
      file: "sh",
      args: ["-c", input.command],
      env: input.env,
      sandbox: "none",
    };
  }
  if (runsAsRoot() && input.policy.required)
    throw configFault(
      `${ROOT_DETAIL}. Factory refuses to run worker-caused commands as root.`,
      ROOT_FIX,
    );
  const checkout = realpathSync(input.checkout);
  const temporary = realpathSync(input.temporary);
  const home = realpathSync(input.home);
  // Exposure is judged against the operator's real HOME and Factory's paths.
  const { exposes } = privatePaths(process.env, checkout);
  const unsafe = (path: string, field: string) => {
    if (exposes(path) || showsHostSockets(path))
      throw configFault(
        `${field} ${path} would show sandboxed commands your HOME, a login, Factory's own files, runtime sockets or the shared temporary directory`,
        `Point ${field} at a directory of its own, outside /tmp and the runtime directories`,
      );
  };
  // Factory's own launcher stays off the PATH, as for workers.
  const path = workerToolchainPath(input.env.PATH);
  let toolchains: string[];
  try {
    toolchains = toolchainDirectories(
      { ...process.env, PATH: path },
      checkout,
      "sandboxed commands",
    );
  } catch (error) {
    throw configFault(
      error instanceof Error ? error.message : String(error),
      "Run Factory with a PATH whose directories hold only tools",
    );
  }
  const readOnly = input.policy.readOnlyPaths.map((path) => {
    if (!existsSync(path))
      throw configFault(
        `sandbox.readOnlyPaths entry ${path} does not exist`,
        "Create it or remove it from sandbox.readOnlyPaths",
      );
    const resolved = realpathSync(path);
    unsafe(resolved, "sandbox.readOnlyPaths entry");
    return resolved;
  });
  const env: Record<string, string> = { ...input.env };
  for (const name of HOST_DIRECTORY_VARIABLES) delete env[name];
  env.HOME = home;
  if (path !== undefined) env.PATH = path;
  const writable = [checkout, temporary, home];
  let readOnlyStore: string | undefined;
  if (input.policy.packageStore) {
    // Not in a shared temporary directory, nor in any directory others can
    // write, where another user could create or replace it first (installs
    // write it): checked through its nearest existing ancestor's real path
    // before it is created.
    let existing = input.policy.packageStore;
    while (!existsSync(existing)) existing = dirname(existing);
    const planned = join(
      realpathSync(existing),
      relative(existing, input.policy.packageStore),
    );
    unsafe(planned, "sandbox.packageStore");
    for (let parent = dirname(planned); ; parent = dirname(parent)) {
      const entry = statSync(parent, { throwIfNoEntry: false });
      if (entry && (entry.mode & 0o022) !== 0 && (entry.mode & 0o1000) === 0)
        throw configFault(
          `sandbox.packageStore ${planned} lies in ${parent}, which others can write`,
          "Point sandbox.packageStore at a directory whose parents only you (or root) can write",
        );
      if (parent === dirname(parent)) break;
    }
    mkdirSync(input.policy.packageStore, { recursive: true, mode: 0o700 });
    const store = realpathSync(input.policy.packageStore);
    unsafe(store, "sandbox.packageStore");
    const owner = statSync(store);
    if (owner.uid !== process.getuid?.() || (owner.mode & 0o022) !== 0)
      throw configFault(
        `sandbox.packageStore ${store} is not owned by Factory's user or is group- or world-writable`,
        "Point sandbox.packageStore at a directory you own that only you can write (chmod go-w)",
      );
    if (
      [checkout, temporary, home].some(
        (path) => within(store, path) || within(path, store),
      ) ||
      existsSync(join(store, ".git"))
    )
      throw configFault(
        `sandbox.packageStore ${store} overlaps a checkout or the command's private directories`,
        "Point sandbox.packageStore at a directory of its own, outside every checkout",
      );
    // pnpm 11+ reads pnpm_config_*; its SQLite store index needs writes, so
    // only a verified install writes it and every other command reads it.
    if (input.packageInstall) writable.push(store);
    else readOnlyStore = store;
    env.pnpm_config_store_dir = join(store, "pnpm-store");
    env.pnpm_config_cache_dir = join(store, "pnpm-cache");
    env.npm_config_cache = join(store, "npm");
  }
  if (input.packageInstall) {
    // An install runs no package-manager hooks, whatever the checkout says.
    env.npm_config_ignore_scripts = "true";
    env.pnpm_config_ignore_scripts = "true";
    env.pnpm_config_ignore_pnpmfile = "true";
    // Nor does it fetch and run another pnpm version.
    env.pnpm_config_manage_package_manager_versions = "false";
  }
  const system = SYSTEM_DIRECTORIES.filter((path) => existsSync(path)).map(
    (path) => real(path),
  );
  const mounts = new Map<string, "ro" | "rw">();
  // Git metadata is the checkout's own, never a login or Factory's files.
  const { exposes: exposesBesidesGit } = privatePaths(
    process.env,
    checkout,
    false,
  );
  const metadata = gitMetadata(checkout).filter(
    (path) => !exposesBesidesGit(path),
  );
  for (const path of [
    ...toolchains,
    ...readOnly,
    ...metadata,
    ...(readOnlyStore ? [readOnlyStore] : []),
  ])
    if (!system.some((root) => within(path, root))) mounts.set(path, "ro");
  for (const path of writable) mounts.set(path, "rw");
  // The checkout's `.git` stays read-only, so no command repoints it.
  const git = join(checkout, ".git");
  if (existsSync(git)) mounts.set(git, "ro");
  const network: string[] = [];
  if (input.network) {
    network.push("--share-net");
    // Name resolution: /etc/resolv.conf often links outside /etc.
    if (existsSync("/etc/resolv.conf")) {
      const resolver = realpathSync("/etc/resolv.conf");
      if (!system.some((root) => within(resolver, root)))
        mounts.set(resolver, "ro");
    }
  }
  // Process limit: RLIMIT_NPROC, set by util-linux prlimit inside the sandbox.
  const prlimit = ["/usr/bin/prlimit", "/bin/prlimit"].find((path) =>
    existsSync(path),
  );
  if (!prlimit)
    throw configFault(
      "prlimit (util-linux) is not installed; the command sandbox cannot limit processes",
      "Install util-linux's prlimit on this host",
    );
  // A policy recorded before limits existed gets the defaults.
  const limits = { ...DEFAULT_SANDBOX_LIMITS, ...input.policy.limits };
  const tmpBytes = String(limits.tmpMiB * 1024 * 1024);
  const sized = (path: string) => [
    ...(found.tmpfsSize ? ["--size", tmpBytes] : []),
    "--tmpfs",
    path,
  ];
  // Parents before children, so a nested mount lands inside its parent.
  const ordered = [...mounts.entries()].sort(
    ([a], [b]) =>
      a.split(sep).length - b.split(sep).length || a.localeCompare(b),
  );
  return {
    file: found.executable,
    args: [
      // The init's pid once cloned, and the exit code only once setup
      // finished and the command was executed.
      "--json-status-fd",
      "3",
      ...ISOLATION,
      ...network,
      ...systemMounts(),
      "--proc",
      "/proc",
      "--dev",
      "/dev",
      ...sized("/dev/shm"),
      ...sized("/tmp"),
      // Each mount binds the source resolved now, so a link changed after the
      // checks above cannot redirect it into host sockets.
      ...ordered.flatMap(([path, access]) => {
        const source = realpathSync(path);
        if (source !== path && showsHostSockets(source))
          throw configFault(
            `${path} now leads to ${source}, which would show sandboxed commands runtime sockets or the shared temporary directory`,
            "Keep the PATH's links pointing at toolchain directories while Factory runs",
          );
        return [access === "rw" ? "--bind" : "--ro-bind", source, path];
      }),
      // Mount points' parents live on the sandbox's own root: keep it
      // read-only, so only the mounts named writable take writes.
      "--remount-ro",
      "/",
      "--chdir",
      checkout,
      "--",
      prlimit,
      `--nproc=${limits.processes}`,
      "--",
      "/bin/sh",
      "-c",
      input.command,
    ],
    env,
    sandbox: "bubblewrap",
    bubblewrap: { statusFd: 3 },
  };
}
