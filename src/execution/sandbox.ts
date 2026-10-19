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
 * A verified package install may get outbound network in its own namespace,
 * through pasta (packageInstallNetwork), never the host's.
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
import { Worker } from "node:worker_threads";
import { StepFault } from "../fault.js";
import { type BubblewrapLaunch, workerToolchainPath } from "../process.js";
import { record, refuseUnknownFields } from "../unknown-fields.js";
import type { DiskUse } from "./disk-use.js";

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
    /**
     * Size of the private /tmp and /dev/shm, each, and the most the private
     * TMPDIR may hold, in MiB (default 1024).
     */
    tmpMiB?: number;
    /** The most the private HOME may hold, in MiB (default 4096). */
    homeMiB?: number;
    /** The most a run's commands may grow their checkout by, in MiB (default 8192). */
    checkoutMiB?: number;
    /** Files and directories that checkout growth, HOME and TMPDIR may hold together (default 1000000). */
    files?: number;
    /**
     * Without private-history gitPersistence checkpoint bounds, the most a
     * worker's candidate may stage, in MiB (default 2048, GitHub's limit for
     * one push) and files (default 100000).
     */
    candidateMiB?: number;
    candidateFiles?: number;
    /** RLIMIT_NPROC: processes the operator's account may have while it runs (default 4096). */
    processes?: number;
  };
}

export const DEFAULT_SANDBOX_LIMITS = {
  tmpMiB: 1024,
  homeMiB: 4096,
  checkoutMiB: 8192,
  files: 1_000_000,
  candidateMiB: 2048,
  candidateFiles: 100_000,
  processes: 4096,
};

/** The effective policy; strict unless the operator's configuration relaxes it. */
export interface CommandSandboxPolicy {
  required: boolean;
  network: "off" | "package-install";
  packageStore?: string;
  readOnlyPaths: string[];
  limits: typeof DEFAULT_SANDBOX_LIMITS;
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
    const minimums = {
      tmpMiB: 16,
      homeMiB: 16,
      checkoutMiB: 16,
      files: 1024,
      candidateMiB: 16,
      candidateFiles: 1024,
      processes: 64,
    };
    refuseUnknownFields(limits, Object.keys(minimums), "sandbox.limits");
    for (const [name, minimum] of Object.entries(minimums)) {
      const value = limits[name];
      if (
        value !== undefined &&
        (!Number.isSafeInteger(value) || (value as number) < minimum)
      )
        throw new Error(
          `sandbox.limits.${name} must be an integer of at least ${minimum}`,
        );
    }
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

/** What a worker's candidate may stage without checkpoint bounds. */
export function sandboxCandidateBounds(policy: CommandSandboxPolicy): {
  maxBytes: number;
  maxFiles: number;
} {
  const limits = { ...DEFAULT_SANDBOX_LIMITS, ...policy.limits };
  return {
    maxBytes: limits.candidateMiB * 1024 ** 2,
    maxFiles: limits.candidateFiles,
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

/**
 * Holds a networked command inside its sandbox until Factory writes `go` to
 * fd 4, once pasta configured the namespace. bubblewrap's own `--block-fd`
 * takes end of file as release, so a Factory that died during the hold
 * would release the command, in a sandbox that outlives it; here end of
 * file, or anything but `go`, runs nothing (exit 125) and the sandbox ends.
 */
const RELEASE_GATE = [
  "/bin/sh",
  "-c",
  'IFS= read -r go <&4; exec 4<&-; [ "$go" = go ] || exit 125; exec "$@"',
  "gate",
];

/**
 * The sandbox's /dev. bubblewrap's `--dev` also mounts a devpts, for which
 * it runs the command in a second user namespace, nested in the one that
 * owns the network namespace: pasta, joining the command's, could not
 * configure that network. So a networked command gets the same devices
 * without pseudo-terminals.
 */
function devices(pseudoTerminals: boolean): string[] {
  if (pseudoTerminals) return ["--dev", "/dev"];
  return [
    "--tmpfs",
    "/dev",
    ...["null", "zero", "full", "random", "urandom", "tty"].flatMap((name) => [
      "--dev-bind",
      `/dev/${name}`,
      `/dev/${name}`,
    ]),
    ...["stdin", "stdout", "stderr"].flatMap((name, fd) => [
      "--symlink",
      `/proc/self/fd/${fd}`,
      `/dev/${name}`,
    ]),
    "--symlink",
    "/proc/self/fd",
    "/dev/fd",
  ];
}

const isFile = (path: string) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/** `name` in each absolute directory of Factory's PATH. */
const onPath = (name: string) =>
  (process.env.PATH ?? "")
    .split(delimiter)
    .filter((entry) => isAbsolute(entry))
    .map((entry) => join(entry, name));

function bubblewrapExecutable(): string | undefined {
  return ["/usr/bin/bwrap", "/usr/local/bin/bwrap", ...onPath("bwrap")].find(
    isFile,
  );
}

export type CommandSandboxAvailability =
  | {
      available: true;
      executable: string;
      version: string;
      /** This bubblewrap can size a tmpfs (`--size`; 0.9 can). */
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

/**
 * Where pasta answers the sandbox's DNS queries: it forwards them to the
 * host's resolver, which may itself listen on the host's loopback.
 */
const PASTA_DNS = "169.254.1.1";

/** Per pasta executable, the arguments that stop its gateway mapping, if any. */
const pastaGateway = new Map<string, string[] | undefined>();

export type PackageInstallNetwork =
  | { available: true; executable: string; args: string[] }
  | { available: false; detail: string };

/**
 * How a verified package install reaches the network: in the sandbox's own
 * network namespace, through pasta (passt) on Factory's PATH, which makes
 * the install's connections from the host. pasta maps its gateway address
 * to the host's loopback, and forwards ports between the namespaces, unless
 * told not to: both are turned off, so the install reaches neither host
 * loopback services nor, in a namespace of its own, abstract sockets. The
 * gateway mapping is `--map-host-loopback none` in newer passt and
 * `--no-map-gw` before, read once per executable from its `--help`.
 * Without a pasta that can turn it off, installs run offline: never in the
 * host's network namespace.
 */
export function packageInstallNetwork(): PackageInstallNetwork {
  if (runsAsRoot())
    return {
      available: false,
      detail: "Factory runs as root, and pasta is not run as root",
    };
  const executable = onPath("pasta").find(isFile);
  if (!executable)
    return {
      available: false,
      detail: "pasta (passt) is not on Factory's PATH",
    };
  if (!pastaGateway.has(executable)) {
    const help = spawnSync(executable, ["--help"], {
      encoding: "utf8",
      timeout: 10_000,
      env: {},
    });
    if (help.error)
      return {
        available: false,
        detail: `${executable} --help could not run: ${help.error.message}`,
      };
    const text = `${help.stdout}${help.stderr}`;
    pastaGateway.set(
      executable,
      /--map-host-loopback\b/.test(text)
        ? ["--map-host-loopback", "none"]
        : /--no-map-gw\b/.test(text)
          ? ["--no-map-gw"]
          : undefined,
    );
  }
  const gateway = pastaGateway.get(executable);
  if (!gateway)
    return {
      available: false,
      detail: `${executable} cannot stop mapping its gateway address to the host's loopback`,
    };
  return {
    available: true,
    executable,
    args: [
      "--config-net",
      "--foreground",
      "--quiet",
      ...gateway,
      // No port forwarding into or out of the namespace.
      ...["-t", "none", "-u", "none", "-T", "none", "-U", "none"],
      "--dns-forward",
      PASTA_DNS,
    ],
  };
}

/** What status and setup show about the sandbox commands run in. */
export function commandSandboxStatus(policy: CommandSandboxPolicy): {
  mode: "bubblewrap" | "unsandboxed" | "unavailable";
  network: CommandSandboxPolicy["network"];
  /** With `package-install`: "isolated (pasta)", or "offline: " and why. */
  installNetwork?: string;
  packageStore?: string;
  detail: string;
  fix?: string;
} {
  const found = commandSandboxAvailability();
  const limits = { ...DEFAULT_SANDBOX_LIMITS, ...policy.limits };
  const install =
    policy.network === "package-install" ? packageInstallNetwork() : undefined;
  const shared = {
    network: policy.network,
    ...(install && {
      installNetwork: install.available
        ? "isolated (pasta)"
        : `offline: ${install.detail}`,
    }),
    ...(policy.packageStore && { packageStore: policy.packageStore }),
  };
  const network = !install
    ? "network off for every command"
    : install.available
      ? `network only for verified package installs, in their own network namespace through ${install.executable}, without host loopback`
      : `network off for every command: verified package installs run offline, because ${install.detail} (install passt to give them the network)`;
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
      detail: `${runsAsRoot() ? `${ROOT_DETAIL}, as sandbox.required false allows; ` : ""}${found.version} at ${found.executable}; ${network}; at most ${limits.processes} processes; private /tmp ${found.tmpfsSize ? `${limits.tmpMiB} MiB` : "unsized (this bubblewrap has no --size)"}; after each command at most ${limits.homeMiB} MiB in HOME, ${limits.tmpMiB} MiB in TMPDIR, ${limits.checkoutMiB} MiB of checkout growth and ${limits.files} files`,
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

/**
 * The checkout's disk use and entries (files, links, directories) when a
 * run's first command started, by the run's private TMPDIR: its growth is
 * measured from there. An entry goes once that TMPDIR is gone.
 */
const checkoutBaselines = new Map<string, DiskUse>();

/**
 * Disk use under `root` (see diskUseSync), measured in a worker thread so
 * the controller's event loop keeps running while a large tree is walked.
 */
function diskUse(root: string, limit: number, skip?: string): Promise<DiskUse> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./disk-use.js", import.meta.url), {
      // The parent's flags (such as --input-type) do not apply to a file.
      execArgv: [],
      workerData: { diskUse: [root, limit, skip] },
    });
    worker.once("message", (message: { use?: DiskUse; error?: string }) =>
      Number.isSafeInteger(message.use?.bytes) &&
      Number.isSafeInteger(message.use?.entries)
        ? resolve(message.use!)
        : reject(new Error(message.error ?? "Disk measurement failed")),
    );
    worker.once("error", reject);
    worker.once("exit", (code) =>
      reject(new Error(`Disk measurement of ${root} ended (${code})`)),
    );
  });
}

/**
 * Records the checkout a run's commands start from, once per run (by its
 * private TMPDIR). Await it before each command; sandboxDiskOverflow
 * measures growth from it.
 */
export async function recordSandboxBaseline(input: {
  checkout: string;
  temporary: string;
}): Promise<void> {
  const temporary = realpathSync(input.temporary);
  for (const run of checkoutBaselines.keys())
    if (!existsSync(run)) checkoutBaselines.delete(run);
  if (checkoutBaselines.has(temporary)) return;
  const checkout = realpathSync(input.checkout);
  const baseline = await diskUse(
    checkout,
    Number.POSITIVE_INFINITY,
    join(checkout, ".git"),
  );
  if (!checkoutBaselines.has(temporary))
    checkoutBaselines.set(temporary, baseline);
}

const mebibytes = (bytes: number) => (bytes / 1024 ** 2).toFixed(1);

/**
 * Whether a sandboxed command left its run over the sandbox's disk budget
 * (`sandbox.limits`): its private HOME and TMPDIR hold at most `homeMiB` and
 * `tmpMiB`, its checkout (without `.git`) grew by at most `checkoutMiB` since
 * the run's first command started (recordSandboxBaseline), and together they
 * add at most `files` entries. Checked after each command, since HOME,
 * TMPDIR and the checkout last the whole run; the answer names what is
 * over, or is undefined.
 */
export async function sandboxDiskOverflow(
  input: Pick<
    SandboxedCommandInput,
    "checkout" | "home" | "temporary" | "policy"
  >,
): Promise<string | undefined> {
  const limits = { ...DEFAULT_SANDBOX_LIMITS, ...input.policy.limits };
  const checkout = realpathSync(input.checkout);
  const temporary = realpathSync(input.temporary);
  const baseline = checkoutBaselines.get(temporary);
  if (!baseline)
    throw new Error("The sandbox measured no checkout before the command");
  const over: string[] = [];
  const measured = (
    root: string,
    limit: number,
    skip?: string,
  ): Promise<DiskUse | undefined> =>
    diskUse(root, limit, skip).catch((error) => {
      over.push(error instanceof Error ? error.message : String(error));
      return undefined;
    });
  const files = limits.files;
  const [grown, home, scratch] = await Promise.all([
    measured(checkout, baseline.entries + files, join(checkout, ".git")),
    measured(realpathSync(input.home), files),
    measured(temporary, files),
  ]);
  if (grown && grown.bytes - baseline.bytes > limits.checkoutMiB * 1024 ** 2)
    over.push(
      `the checkout grew by ${mebibytes(grown.bytes - baseline.bytes)} MiB, more than sandbox.limits.checkoutMiB (${limits.checkoutMiB} MiB)`,
    );
  if (home && home.bytes > limits.homeMiB * 1024 ** 2)
    over.push(
      `HOME holds ${mebibytes(home.bytes)} MiB, more than sandbox.limits.homeMiB (${limits.homeMiB} MiB)`,
    );
  if (scratch && scratch.bytes > limits.tmpMiB * 1024 ** 2)
    over.push(
      `TMPDIR holds ${mebibytes(scratch.bytes)} MiB, more than sandbox.limits.tmpMiB (${limits.tmpMiB} MiB)`,
    );
  const entries =
    grown && home && scratch
      ? Math.max(0, grown.entries - baseline.entries) +
        home.entries +
        scratch.entries
      : 0;
  if (entries > files)
    over.push(
      `checkout growth, HOME and TMPDIR hold more than sandbox.limits.files (${files}) files`,
    );
  return over.length
    ? `the sandbox disk budget is exceeded: ${over.join("; ")}. Remove what the commands wrote there, or raise sandbox.limits in the Factory configuration.`
    : undefined;
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
  /**
   * This command may reach the network (the policy decides which may): in
   * its own network namespace through pasta, or, without pasta, not at all.
   */
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
 * and the kernel kills the rest first. A networked command's launch names
 * pasta: subprocessAsync runs it, recorded, against the held sandbox and
 * releases the command only once it configured the namespace, then proves
 * pasta gone too. Throws a configuration fault when the sandbox cannot run,
 * or when Factory runs as root and sandbox.required is not false.
 */
export function sandboxedCommand(input: SandboxedCommandInput): {
  file: string;
  args: string[];
  env: Record<string, string>;
  sandbox: "bubblewrap" | "none";
  bubblewrap?: BubblewrapLaunch;
  /** Why a networked install runs offline: pasta is unavailable. */
  offline?: string;
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
  // A network grant runs in the sandbox's own namespace through pasta, or
  // offline: never in the host's network namespace.
  const online = input.network ? packageInstallNetwork() : undefined;
  const pasta = online?.available ? online : undefined;
  // An install without the network runs its package manager offline: it
  // installs from the store or fails at once, naming what is missing,
  // instead of waiting on registry lookups that cannot succeed.
  if (input.packageInstall && !pasta) {
    env.npm_config_offline = "true";
    env.pnpm_config_offline = "true";
  }
  // Name resolution through pasta's DNS forwarder, written where the host's
  // /etc/resolv.conf leads (often outside /etc).
  const resolver =
    pasta && existsSync("/etc/resolv.conf")
      ? realpathSync("/etc/resolv.conf")
      : undefined;
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
      ...systemMounts(),
      "--proc",
      "/proc",
      ...devices(!pasta),
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
      ...(resolver ? ["--ro-bind-data", "5", resolver] : []),
      // Mount points' parents live on the sandbox's own root: keep it
      // read-only, so only the mounts named writable take writes.
      "--remount-ro",
      "/",
      "--chdir",
      checkout,
      "--",
      ...(pasta ? RELEASE_GATE : []),
      prlimit,
      // RLIMIT_NPROC counts every process of the user, not this sandbox's.
      `--nproc=${limits.processes}`,
      "--",
      "/bin/sh",
      "-c",
      input.command,
    ],
    env,
    sandbox: "bubblewrap",
    ...(online && !online.available && { offline: online.detail }),
    bubblewrap: {
      statusFd: 3,
      ...(pasta && {
        network: {
          pasta: pasta.executable,
          args: pasta.args,
          ...(resolver && { resolver: `nameserver ${PASTA_DNS}\n` }),
        },
      }),
    },
  };
}
