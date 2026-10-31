/**
 * The operating-system sandbox for every command a worker can cause to run
 * on the controller's host: declared validation commands, setup and probe
 * commands, the Claude worker's shell and a worker attempt's services
 * (work/services.ts). Each command runs under
 * bubblewrap in new user, PID, IPC, UTS, cgroup and network namespaces. It
 * sees the system read-only, the PATH's toolchains read-only, its checkout
 * (writable, its `.git` entry read-only) and the checkout's git metadata
 * read-only, a private HOME and TMPDIR, a worker attempt's services
 * directory read-only (work/services.ts), and nothing else: not the
 * operator's HOME, logins, SSH keys, gh or provider configuration, nor
 * Factory's own configuration, data or state. Network is off; loopback
 * works. A verified package install may get outbound network in its own
 * namespace, through pasta, never the host's (package-network.ts decides
 * which install may). Only `sandbox.network: host` shares the host's
 * network namespace, with every command.
 *
 * A setup failure is a configuration fault returned as data, never the
 * command's failure. Every process group started here is tracked, killed
 * on abort or timeout, and killed when the service exits.
 *
 * Codex workers keep Codex's own sandbox; this one covers what runs outside it.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import type * as fs from "node:fs";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import type * as path from "node:path";
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
import type { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { Worker } from "node:worker_threads";
import type { SandboxConfig } from "./config.js";
import { within } from "./paths.js";
import { BoundedText, errorMessage } from "./text.js";
import { workerToolchainPath } from "./worktree.js";

/** `path` by its real path when it exists. */
export const real = (path: string) =>
  existsSync(path) ? realpathSync(path) : resolve(path);

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
    join(config, "factory"),
    join(config, "clockgrove-factory"),
    join(data, "clockgrove-factory"),
    join(data, "factory-copilot-auth"),
    join(state, "factory"),
    join(state, "clockgrove-factory"),
    ...(source.FACTORY_STATE_DIR ? [source.FACTORY_STATE_DIR] : []),
    // A custom configuration may sit beside the target clone. Seal the
    // file; the containment check also refuses any mount that includes it.
    ...(source.FACTORY_CONFIG ? [source.FACTORY_CONFIG] : []),
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
 * Why a directory can't be a `media.localAssetRoots` entry (config load),
 * or undefined when it can: it would show workers what the sandbox seals.
 */
export function localRootRefusal(root: string): string | undefined {
  const path = real(root);
  return privatePaths(process.env, "/", false).exposes(path) ||
    showsHostSockets(path)
    ? `${root} would show workers your HOME, a login, Factory's own files, runtime sockets or the shared temporary directory`
    : undefined;
}

/**
 * Where a "local" source asset is read from: its real path under the real
 * path of one of the operator's `media.localAssetRoots`, split as the root
 * and the path below it, so the copy reaches it without links from there.
 * Refused, with the reason, when no root holds it (no roots means local
 * assets are off) or when it is anything the sandbox seals from workers.
 * Planning's source-asset check and the copy both call this.
 */
export function localAssetPlace(
  path: string,
  roots: readonly string[],
): { root: string; relative: string } | { refused: string } {
  if (!isAbsolute(path)) return { refused: `${path} is not an absolute path` };
  if (!roots.length)
    return {
      refused:
        "local source assets are off: media.localAssetRoots in the Factory configuration names no directory",
    };
  const file = real(path);
  if (
    privatePaths(process.env, "/", false).exposes(file) ||
    showsHostSockets(file)
  )
    return {
      refused: `${path} is in a login directory, Factory's own files, runtime sockets or the shared temporary directory, which workers never see`,
    };
  for (const entry of roots) {
    const root = real(entry);
    if (within(file, root) && file !== root)
      return { root, relative: relative(root, file) };
  }
  return {
    refused: `${path} is not under a directory media.localAssetRoots names (${roots.join(", ")})`,
  };
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
 * PATH directory that would is a configuration error (thrown); a link that
 * leads into one, or that the operator cannot follow, is left unmounted, so
 * that tool does not run.
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
  // Factory's own Node runs in the sandbox (local worker helpers), so mount
  // it like a PATH directory even when the PATH Factory was started with
  // omits it, as an installed launcher does.
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

/** What a worker's candidate may stage: `sandbox.limits.candidate*`. */
export function candidateBounds(config: SandboxConfig): {
  maxBytes: number;
  maxFiles: number;
} {
  return {
    maxBytes: config.limits.candidateMiB * 1024 ** 2,
    maxFiles: config.limits.candidateFiles,
  };
}

/** Absolute-path environment values that no `sandbox.readOnlyPaths` entry covers. */
function uncoveredEnvironment(config: SandboxConfig): string[] {
  return Object.entries(config.environment)
    .filter(
      ([, value]) =>
        isAbsolute(value) &&
        !config.readOnlyPaths.some(
          (root) => value === root || value.startsWith(`${root}/`),
        ),
    )
    .map(([name]) => name);
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

/** The executable `name` resolves to on the PATH, or undefined. */
export const executable = (name: string) => onPath(name).find(isFile);

function bubblewrapExecutable(): string | undefined {
  return ["/usr/bin/bwrap", "/usr/local/bin/bwrap", ...onPath("bwrap")].find(
    isFile,
  );
}

export type SandboxAvailability =
  | {
      available: true;
      executable: string;
      version: string;
      /** This bubblewrap can size a tmpfs (`--size`; 0.9 can). */
      tmpfsSize: boolean;
    }
  | { available: false; installed: boolean; detail: string };

let availability: SandboxAvailability | undefined;

let failure: { at: number; result: SandboxAvailability } | undefined;
/** How long a failed probe answers before bubblewrap is probed again. */
const FAILURE_RETRY_MS = 30_000;

/**
 * Whether bubblewrap starts a sandbox on this host, probed with the same
 * namespaces and system mounts every command gets. Success is kept for the
 * process. A failure answers for 30 seconds and is then probed again, so a
 * transient one never turns the sandbox off and a broken host is not
 * re-probed on every call.
 */
export function sandboxAvailable(): SandboxAvailability {
  if (availability) return availability;
  if (failure && Date.now() - failure.at < FAILURE_RETRY_MS)
    return failure.result;
  const probed = probeSandbox();
  if (probed.available) availability = probed;
  else failure = { at: Date.now(), result: probed };
  return probed;
}

function probeSandbox(): SandboxAvailability {
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
  const start = (size: string[]) =>
    spawnSync(
      executable,
      [
        ...ISOLATION,
        ...systemMounts(),
        "--proc",
        "/proc",
        "--dev",
        "/dev",
        ...size,
        "--tmpfs",
        "/tmp",
        "--",
        "/bin/sh",
        "-c",
        "exit 0",
      ],
      { encoding: "utf8", timeout: 10_000, env: {} },
    );
  // A bubblewrap that can't size a tmpfs (before 0.9) refuses `--size`:
  // the probe runs again without it.
  const sized = start(["--size", "1048576"]);
  const probe = sized.status === 0 ? sized : start([]);
  if (probe.status === 0)
    return {
      available: true,
      executable,
      version: version.stdout.trim() || "unknown",
      tmpfsSize: probe === sized,
    };
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
export const runsAsRoot = () => process.geteuid?.() === 0;

const ROOT_DETAIL =
  "Factory runs as root, so sandboxed commands would read root-only host files such as /etc/shadow and SSH host keys";

const ROOT_FIX =
  "Run Factory as an unprivileged user. Only if commands may read root-only host files, set sandbox.required to false in the Factory configuration.";

const ROOT_REFUSED = `${ROOT_DETAIL}. Factory refuses to run worker-caused commands as root.`;

/** The question when a worker would run commands under a root controller. */
export const ROOT_REFUSAL = `${ROOT_REFUSED} ${ROOT_FIX} Then answer retry.`;

const UNAVAILABLE_FIX =
  "Install bubblewrap (`bwrap`) and allow unprivileged user namespaces on this host. Only if commands must run unsandboxed here, set sandbox.required to false in the Factory configuration.";

const BROKEN_FIX =
  "Make bubblewrap able to start a sandbox on this host (unprivileged user namespaces); sandbox.required false applies only where bubblewrap is not installed.";

/**
 * Where pasta answers the sandbox's DNS queries: it forwards them to the
 * host's resolver, which may itself listen on the host's loopback.
 */
const PASTA_DNS = "169.254.1.1";

/** Per pasta executable, the arguments that stop its gateway mapping, if any. */
const pastaGateway = new Map<string, string[] | undefined>();

type InstallNetwork =
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
function installNetwork(): InstallNetwork {
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
export function sandboxStatus(config: SandboxConfig): {
  mode: "bubblewrap" | "unsandboxed" | "unavailable";
  network: SandboxConfig["network"];
  /** With `package-install`: "isolated (pasta)", or "offline: " and why. */
  installNetwork?: string;
  packageStore?: string;
  detail: string;
  fix?: string;
  warnings: string[];
} {
  const found = sandboxAvailable();
  const limits = config.limits;
  const install =
    config.network === "package-install" ? installNetwork() : undefined;
  const shared = {
    network: config.network,
    ...(install && {
      installNetwork: install.available
        ? "isolated (pasta)"
        : `offline: ${install.detail}`,
    }),
    ...(config.packageStore && { packageStore: config.packageStore }),
    warnings: uncoveredEnvironment(config).map(
      (name) =>
        `sandbox.environment.${name} is an absolute path that no sandbox.readOnlyPaths entry covers, so commands cannot read it`,
    ),
  };
  const network =
    config.network === "host"
      ? "every command shares the host's network: its loopback services, its local network, the internet and abstract Unix sockets"
      : !install
        ? "network off for every command"
        : install.available
          ? `network only for verified package installs, in their own network namespace through ${install.executable}, without host loopback`
          : `network off for every command: verified package installs run offline, because ${install.detail} (install passt to give them the network)`;
  if (found.available && runsAsRoot() && config.required)
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
  if (!config.required && !found.installed)
    return {
      mode: "unsandboxed",
      ...shared,
      detail: `${found.detail}; sandbox.required is false, so worker-caused commands run unsandboxed with the operator's file access`,
    };
  return {
    mode: "unavailable",
    ...shared,
    detail: `${found.detail}; Factory refuses to run worker-caused commands`,
    fix: found.installed ? BROKEN_FIX : UNAVAILABLE_FIX,
  };
}

// ---------------------------------------------------------------------------
// Disk budget

interface DiskUse {
  bytes: number;
  entries: number;
}

/**
 * Disk bytes and entries under `root`, never following a link and skipping
 * `skip`; it stops once more than `limit` entries are counted. A directory
 * it cannot read is refused, since what it holds cannot be counted. A file
 * counts its apparent size, which Git hashes and a sparse file claims, or
 * its allocated blocks, which preallocation takes beyond that size,
 * whichever is larger.
 *
 * It runs in a worker thread from its own source, so it names its modules
 * as parameters and declares no inner functions.
 */
function diskUseSync(
  nodeFs: typeof fs,
  nodePath: typeof path,
  root: string,
  limit: number,
  skip: string | undefined,
): DiskUse {
  const use = { bytes: 0, entries: 0 };
  const pending = [root];
  while (pending.length && use.entries <= limit) {
    const directory = pending.pop()!;
    const unreadable = `${directory} cannot be read to measure its disk use`;
    let entries: fs.Dir;
    try {
      entries = nodeFs.opendirSync(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new Error(unreadable);
    }
    // Read one entry at a time, so a huge directory stops at the limit.
    try {
      for (;;) {
        let name: string | undefined;
        try {
          name = entries.readSync()?.name;
        } catch {
          throw new Error(unreadable);
        }
        if (name === undefined) break;
        const child = nodePath.join(directory, name);
        if (child === skip) continue;
        let entry: fs.Stats | undefined;
        try {
          entry = nodeFs.lstatSync(child, { throwIfNoEntry: false });
        } catch {
          throw new Error(unreadable);
        }
        if (!entry) continue;
        use.entries += 1;
        use.bytes += Math.max(entry.size, entry.blocks * 512);
        if (use.entries > limit) return use;
        if (entry.isDirectory()) pending.push(child);
      }
    } finally {
      entries.closeSync();
    }
  }
  return use;
}

const DISK_USE_WORKER = `
const { parentPort, workerData } = require("node:worker_threads");
try {
  const measure = ${diskUseSync.toString()};
  parentPort.postMessage({
    use: measure(require("node:fs"), require("node:path"), ...workerData),
  });
} catch (error) {
  parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) });
}
`;

/**
 * Disk use under `root`, measured in a worker thread so the service's event
 * loop keeps running while a large tree is walked. An abort stops the walk
 * and rejects with the signal's reason.
 */
function diskUse(
  root: string,
  limit: number,
  skip?: string,
  signal?: AbortSignal,
): Promise<DiskUse> {
  return new Promise((done, failed) => {
    signal?.throwIfAborted();
    const worker = new Worker(DISK_USE_WORKER, {
      eval: true,
      execArgv: [],
      workerData: [root, limit, skip],
    });
    const onAbort = () => {
      failed(signal?.reason);
      void worker.terminate();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    worker.once("exit", () => signal?.removeEventListener("abort", onAbort));
    worker.once("message", (message: { use?: DiskUse; error?: string }) =>
      Number.isSafeInteger(message.use?.bytes) &&
      Number.isSafeInteger(message.use?.entries)
        ? done(message.use!)
        : failed(new Error(message.error ?? "Disk measurement failed")),
    );
    worker.once("error", failed);
    worker.once("exit", (code) =>
      failed(new Error(`Disk measurement of ${root} ended (${code})`)),
    );
  });
}

/**
 * The checkout's disk use when a run's first command started, by the run's
 * private TMPDIR: its growth is measured from there. An entry goes once
 * that TMPDIR is gone.
 */
const checkoutBaselines = new Map<string, DiskUse>();

/** Record the checkout a run's commands start from, once per run. */
async function recordBaseline(
  checkout: string,
  temporary: string,
  signal: AbortSignal,
): Promise<void> {
  for (const run of checkoutBaselines.keys())
    if (!existsSync(run)) checkoutBaselines.delete(run);
  if (checkoutBaselines.has(temporary)) return;
  const baseline = await diskUse(
    checkout,
    Number.POSITIVE_INFINITY,
    join(checkout, ".git"),
    signal,
  );
  if (!checkoutBaselines.has(temporary))
    checkoutBaselines.set(temporary, baseline);
}

const mebibytes = (bytes: number) => (bytes / 1024 ** 2).toFixed(1);

/**
 * Whether a command left its run over the sandbox's disk budget
 * (`sandbox.limits`): its private HOME and TMPDIR hold at most `homeMiB` and
 * `tmpMiB`, its checkout (without `.git`) grew by at most `checkoutMiB` since
 * the run's first command started, and together they add at most `files`
 * entries. Checked after each command, since HOME, TMPDIR and the checkout
 * last the whole run; the answer names what is over, or is undefined.
 * An install's kept package store (`installStore`, #2169), which takes the
 * place of its HOME's caches, counts with that HOME: the store an install
 * writes is held to what the install could have written to HOME.
 */
async function diskOverflow(
  checkout: string,
  home: string,
  temporary: string,
  config: SandboxConfig,
  store?: string,
): Promise<string | undefined> {
  const limits = config.limits;
  // Dropped only when the run's TMPDIR went missing; measuring from zero or
  // from now would misjudge the growth.
  const baseline = checkoutBaselines.get(temporary);
  if (!baseline)
    return "the sandbox disk budget could not be checked: the run's starting checkout size was dropped because its TMPDIR was removed while the run lasted. Keep $TMPDIR in place, then run the command again.";
  const over: string[] = [];
  const measured = (
    root: string,
    limit: number,
    skip?: string,
  ): Promise<DiskUse | undefined> =>
    diskUse(root, limit, skip).catch((error) => {
      over.push(errorMessage(error));
      return undefined;
    });
  const files = limits.files;
  const [grown, homeOnly, storeUse, scratch] = await Promise.all([
    measured(checkout, baseline.entries + files, join(checkout, ".git")),
    measured(home, files),
    store
      ? measured(store, files)
      : Promise.resolve<DiskUse>({ bytes: 0, entries: 0 }),
    measured(temporary, files),
  ]);
  const homeUse =
    homeOnly && storeUse
      ? {
          bytes: homeOnly.bytes + storeUse.bytes,
          entries: homeOnly.entries + storeUse.entries,
        }
      : undefined;
  if (grown && grown.bytes - baseline.bytes > limits.checkoutMiB * 1024 ** 2)
    over.push(
      `the checkout grew by ${mebibytes(grown.bytes - baseline.bytes)} MiB, more than sandbox.limits.checkoutMiB (${limits.checkoutMiB} MiB)`,
    );
  if (homeUse && homeUse.bytes > limits.homeMiB * 1024 ** 2)
    over.push(
      `${store ? "HOME and the install's package store hold" : "HOME holds"} ${mebibytes(homeUse.bytes)} MiB, more than sandbox.limits.homeMiB (${limits.homeMiB} MiB)`,
    );
  if (scratch && scratch.bytes > limits.tmpMiB * 1024 ** 2)
    over.push(
      `TMPDIR holds ${mebibytes(scratch.bytes)} MiB, more than sandbox.limits.tmpMiB (${limits.tmpMiB} MiB)`,
    );
  const entries =
    grown && homeUse && scratch
      ? Math.max(0, grown.entries - baseline.entries) +
        homeUse.entries +
        scratch.entries
      : 0;
  if (entries > files)
    over.push(
      `checkout growth, HOME${store ? ", the install's package store" : ""} and TMPDIR hold more than sandbox.limits.files (${files}) files`,
    );
  return over.length
    ? `the sandbox disk budget is exceeded: ${over.join("; ")}. Remove what the commands wrote there, or raise sandbox.limits in the Factory configuration.`
    : undefined;
}

// ---------------------------------------------------------------------------
// Process groups

/**
 * Every process group started for a worker and not yet ended: bubblewrap
 * (or the unsandboxed shell), pasta and Codex workers each lead their own.
 * A service that exits kills them all; systemd's control-group kill covers
 * a SIGKILL.
 */
export const processGroups = new Set<number>();

/** Kill one process group; one already gone is fine. */
export function killGroup(group: number): void {
  try {
    process.kill(-group, "SIGKILL");
  } catch {
    // ESRCH: already gone.
  }
}

/**
 * Kill every worker process still running: sandboxed commands, pasta and
 * Codex workers with their commands. The service calls it on shutdown;
 * process exit does too.
 */
function killWorkerProcesses(): void {
  for (const group of processGroups) killGroup(group);
}

process.once("exit", killWorkerProcesses);

/** Quote one shell word. */
const shellWord = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;

/** A namespacedLauncher's exit when the host refuses its namespace: the program never ran. */
const NAMESPACE_REFUSED = 125;

/** The file a namespacedLauncher with `pidFile` creates when the host refused its namespace. */
const refusedMarker = (pidFile: string) => `${pidFile}.refused`;

/** Whether the last run of the namespacedLauncher with `pidFile` found its namespace refused. */
export function namespaceRefused(pidFile: string): boolean {
  return existsSync(refusedMarker(pidFile));
}

/**
 * Write an executable launcher at `path` that runs `program` (with the
 * launcher's arguments) as the leader of a new process group, as the init
 * of a PID namespace of its own (`unshare --user --map-current-user --pid
 * --fork --kill-child --mount-proc`). Its process id, the group's, goes to
 * `pidFile` first. It tries the namespace with `true` before the program:
 * a host that refuses it leaves the marker namespaceRefused reads (each
 * run clears it first), reads its standard input to the end, so the
 * caller's write of the prompt can't fail with EPIPE, and exits
 * NAMESPACE_REFUSED. Killing the group, or the
 * program ending, ends the namespace, and the kernel then kills every
 * process left in it, however its commands regrouped or detached: an abort
 * can't leave a command running. The launcher ignores SIGTERM;
 * LaunchedGroup kills it. `stderr` appends the probe's and the program's
 * standard error to that file. Throws when util-linux's `setsid` or
 * `unshare` is missing.
 */
export function namespacedLauncher(
  path: string,
  program: string,
  pidFile: string,
  stderr?: string,
): void {
  const find = (name: string) =>
    [`/usr/bin/${name}`, `/bin/${name}`].find((candidate) =>
      existsSync(candidate),
    );
  const setsid = find("setsid");
  const unshare = find("unshare");
  if (!setsid || !unshare)
    throw new Error(
      "setsid and unshare (util-linux) are needed to stop a Codex process and every command it started; install util-linux",
    );
  // Private like every telemetry file, whatever the umask.
  if (stderr) writeFileSync(stderr, "", { mode: 0o600, flag: "a" });
  const namespace = `${unshare} --user --map-current-user --pid --fork --kill-child --mount-proc`;
  const errors = stderr ? ` 2>>${shellWord(stderr)}` : "";
  const refused = shellWord(refusedMarker(pidFile));
  writeFileSync(
    path,
    `#!/bin/sh\necho $$ > ${shellWord(pidFile)}\nrm -f ${refused}\n${namespace} true${errors} || { : > ${refused}; cat > /dev/null; exit ${NAMESPACE_REFUSED}; }\nexec ${setsid} ${namespace} ${shellWord(program)} "$@"${errors}\n`,
    { mode: 0o700, flag: "wx" },
  );
}

/**
 * The process group a namespacedLauncher records, in processGroups from
 * when it appears until `end`, so a service exit kills it even before the
 * caller sees it start. `signal` aborting kills it; so does `end`, which
 * ends whatever the run left behind.
 */
export class LaunchedGroup {
  private group: number | undefined;
  private readonly polling: NodeJS.Timeout;

  constructor(
    private readonly pidFile: string,
    private readonly signal: AbortSignal,
  ) {
    this.polling = setInterval(() => {
      if (this.track() !== undefined) clearInterval(this.polling);
    }, 100);
    this.polling.unref();
    signal.addEventListener("abort", this.kill, { once: true });
  }

  /** The group, once the launcher has written it. */
  track(): number | undefined {
    if (this.group !== undefined) return this.group;
    try {
      const pid = Number(readFileSync(this.pidFile, "utf8").trim());
      if (Number.isSafeInteger(pid) && pid > 1) {
        this.group = pid;
        processGroups.add(pid);
      }
    } catch {
      // Not started yet.
    }
    return this.group;
  }

  readonly kill = (): void => {
    const group = this.track();
    if (group !== undefined) killGroup(group);
  };

  end(): void {
    clearInterval(this.polling);
    this.signal.removeEventListener("abort", this.kill);
    this.kill();
    if (this.group !== undefined) processGroups.delete(this.group);
  }
}

/** Process group and start time of `pid`, from /proc. */
function processStat(
  pid: number,
): { group: number; startTime: string } | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return { group: Number(fields[2]), startTime: fields[19] ?? "" };
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Running a command

/** A host problem that kept the command from running; never the command's failure. */
export interface SandboxFault {
  kind: "fault";
  detail: string;
  fix: string;
}

export type SandboxRun =
  | {
      kind: "ran";
      /** null when a signal ended it, such as the timeout. */
      exitCode: number | null;
      stdout: string;
      stderr: string;
      /** Each stream whose middle was dropped (see `outputLimit`). */
      truncated: { stdout: boolean; stderr: boolean };
      timedOut: boolean;
      /** Over `sandbox.limits` afterwards: a failure whatever the exit code. */
      diskOverflow?: string;
      /** Why an install that asked for the network ran offline. */
      offline?: string;
      sandboxed: boolean;
    }
  | SandboxFault;

export interface SandboxOptions {
  /** The checkout: mounted writable and the working directory; its `.git` entry stays read-only. */
  cwd: string;
  /** The private HOME, writable. One per run (a validation sequence, a worker attempt). */
  home: string;
  /**
   * The private TMPDIR, writable; also TMP and TEMP. The disk budget measures
   * checkout growth from the first command run with it.
   */
  temporary: string;
  /** The command's environment before sandboxing (worktree.ts); HOME and host paths are replaced. */
  env: Record<string, string>;
  config: SandboxConfig;
  /**
   * A verified dependency install (package-network.ts said its inputs may
   * use the network): the package store is writable and package-manager
   * hooks are forced off.
   */
  packageInstall?: boolean;
  /**
   * Only with `packageInstall` and without `sandbox.packageStore`: the
   * package store and caches' root Factory keeps for this install across
   * one item's validations (validate.ts `installStore`), writable to it in
   * place of the private HOME's. No other command mounts it. The disk
   * budget counts it with HOME (`sandbox.limits.homeMiB`, `files`).
   */
  installStore?: string;
  /**
   * The install may reach the network: in its own network namespace through
   * pasta, or, without pasta, not at all. Only with `packageInstall`.
   */
  network?: boolean;
  /** Further host directories to mount read-only. */
  readOnly?: string[];
  /**
   * A worker attempt's services directory (work/services.ts), Factory's
   * own under the host's temporary directory, mounted read-only: the
   * command connects to the sockets in it and writes nothing there.
   */
  services?: string;
  /**
   * Regular files in the checkout, relative to `cwd`, mounted read-only
   * over it: no command can write, replace or remove them (hydrated Git
   * LFS files that are hard links to the operator's LFS store).
   */
  readOnlyFiles?: readonly string[];
  signal: AbortSignal;
  timeoutMs: number;
  /** Each decoded chunk as it arrives. */
  onOutput?(stream: "stdout" | "stderr", text: string): void;
  /** Characters kept of each stream, head and tail (default 1 MiB). */
  outputLimit?: number;
}

const fault = (detail: string, fix: string): SandboxFault => ({
  kind: "fault",
  detail,
  fix,
});

/** Thrown inside launch preparation; becomes a SandboxFault. */
class Refusal extends Error {
  constructor(
    readonly detail: string,
    readonly fix: string,
  ) {
    super(detail);
  }
}

/**
 * Throws a Refusal for a path a sandbox mount would expose: the operator's
 * real HOME, a login, Factory's own paths, runtime sockets or a shared
 * temporary directory.
 */
function exposureCheck(
  checkout: string,
): (path: string, field: string) => void {
  const { exposes } = privatePaths(process.env, checkout);
  return (path, field) => {
    if (exposes(path) || showsHostSockets(path))
      throw new Refusal(
        `${field} ${path} would show sandboxed commands your HOME, a login, Factory's own files, runtime sockets or the shared temporary directory`,
        `Point ${field} at a directory of its own, outside /tmp and the runtime directories`,
      );
  };
}

/**
 * sandbox.readOnlyPaths entries as the real paths a sandbox may mount
 * read-only. Throws a Refusal for a missing or exposing one. The Codex
 * Worker grants the same paths (codex-worker.ts).
 */
export function readOnlyMounts(
  entries: readonly string[],
  checkout: string,
  unsafe = exposureCheck(checkout),
): string[] {
  return entries.map((entry) => {
    if (!existsSync(entry))
      throw new Refusal(
        `read-only path ${entry} does not exist`,
        "Create it or remove it from sandbox.readOnlyPaths",
      );
    const resolved = realpathSync(entry);
    unsafe(resolved, "read-only path");
    return resolved;
  });
}

/**
 * Package-manager store and cache directories under `root`: the pnpm store
 * and metadata cache and the npm cache. Set explicitly, since pnpm otherwise
 * puts its store at the root of the project's mount when that differs from
 * HOME's, which in a sandbox is the checkout itself.
 */
export function packageCacheEnvironment(root: string): Record<string, string> {
  return {
    pnpm_config_store_dir: join(root, "pnpm-store"),
    pnpm_config_cache_dir: join(root, "pnpm-cache"),
    npm_config_cache: join(root, "npm"),
  };
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

interface Launch {
  file: string;
  args: string[];
  env: Record<string, string>;
  sandboxed: boolean;
  /** pasta's executable, arguments and the resolver bound at fd 5. */
  network?: { pasta: string; args: string[]; resolver?: string };
  offline?: string;
}

/**
 * The process to spawn for `command`: `sh -c` inside bubblewrap, or plain
 * `sh -c` only when the operator set `sandbox.required` false and bubblewrap
 * is not installed. Throws a Refusal when the sandbox cannot run, or when
 * Factory runs as root and sandbox.required is not false.
 */
function launch(
  command: string,
  options: SandboxOptions,
  checkout: string,
  temporary: string,
  home: string,
): Launch {
  const config = options.config;
  const found = sandboxAvailable();
  const base: Record<string, string> = {
    ...options.env,
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
  };
  if (!found.available) {
    // Unsandboxed only by explicit choice and only without bubblewrap: an
    // installed one that fails is a fault, never a reason to run bare.
    if (config.required || found.installed)
      throw new Refusal(
        `The command sandbox is unavailable: ${found.detail}. Factory refuses to run worker-caused commands without it.`,
        found.installed ? BROKEN_FIX : UNAVAILABLE_FIX,
      );
    return {
      file: "/bin/sh",
      args: ["-c", command],
      env: { ...base, HOME: home },
      sandboxed: false,
    };
  }
  if (runsAsRoot() && config.required)
    throw new Refusal(ROOT_REFUSED, ROOT_FIX);
  const unsafe = exposureCheck(checkout);
  // Factory's own launcher stays off the PATH, as for workers.
  const path = workerToolchainPath(base.PATH);
  let toolchains: string[];
  try {
    toolchains = toolchainDirectories(
      { ...process.env, PATH: path },
      checkout,
      "sandboxed commands",
    );
  } catch (error) {
    throw new Refusal(
      errorMessage(error),
      "Run Factory with a PATH whose directories hold only tools",
    );
  }
  const readOnly = readOnlyMounts(
    [...config.readOnlyPaths, ...(options.readOnly ?? [])],
    checkout,
    unsafe,
  );
  const services = options.services && realpathSync(options.services);
  if (
    services &&
    [checkout, temporary, home].some(
      (path) => within(services, path) || within(path, services),
    )
  )
    throw new Refusal(
      `the services directory ${services} overlaps the checkout or the command's private directories`,
      "Report it: Factory makes the services directory apart from both",
    );
  const env: Record<string, string> = { ...base };
  // Configured values come first, so Factory's own variables win; the
  // networked install never receives them.
  if (!options.packageInstall) Object.assign(env, config.environment, base);
  for (const name of HOST_DIRECTORY_VARIABLES) delete env[name];
  env.HOME = home;
  if (path !== undefined) env.PATH = path;
  // Without a packageStore, package caches live in the private HOME, never
  // in the checkout.
  Object.assign(env, packageCacheEnvironment(join(home, ".cache")));
  const writable = [checkout, temporary, home];
  // Factory's kept store for the exact install: beside the checkout, never
  // in it, and its own mount, so pnpm copies packages into node_modules (a
  // hard link can't cross mounts) and no later command can write the
  // store's files through them.
  if (options.packageInstall && options.installStore && !config.packageStore) {
    const store = realpathSync(options.installStore);
    if (
      [checkout, temporary, home].some(
        (path) => within(store, path) || within(path, store),
      )
    )
      throw new Refusal(
        `the install's package store ${store} overlaps the checkout or the command's private directories`,
        "Report it: Factory keeps the store beside the validation checkout",
      );
    writable.push(store);
    Object.assign(env, packageCacheEnvironment(store));
  }
  let readOnlyStore: string | undefined;
  if (config.packageStore) {
    // Not in a shared temporary directory, nor in any directory others can
    // write, where another user could create or replace it first (installs
    // write it): checked through its nearest existing ancestor's real path
    // before it is created.
    let existing = config.packageStore;
    while (!existsSync(existing)) existing = dirname(existing);
    const planned = join(
      realpathSync(existing),
      relative(existing, config.packageStore),
    );
    unsafe(planned, "sandbox.packageStore");
    for (let parent = dirname(planned); ; parent = dirname(parent)) {
      const entry = statSync(parent, { throwIfNoEntry: false });
      if (entry && (entry.mode & 0o022) !== 0 && (entry.mode & 0o1000) === 0)
        throw new Refusal(
          `sandbox.packageStore ${planned} lies in ${parent}, which others can write`,
          "Point sandbox.packageStore at a directory whose parents only you (or root) can write",
        );
      if (parent === dirname(parent)) break;
    }
    mkdirSync(config.packageStore, { recursive: true, mode: 0o700 });
    const store = realpathSync(config.packageStore);
    unsafe(store, "sandbox.packageStore");
    const owner = statSync(store);
    if (owner.uid !== process.getuid?.() || (owner.mode & 0o022) !== 0)
      throw new Refusal(
        `sandbox.packageStore ${store} is not owned by Factory's user or is group- or world-writable`,
        "Point sandbox.packageStore at a directory you own that only you can write (chmod go-w)",
      );
    if (
      [checkout, temporary, home].some(
        (path) => within(store, path) || within(path, store),
      ) ||
      existsSync(join(store, ".git"))
    )
      throw new Refusal(
        `sandbox.packageStore ${store} overlaps a checkout or the command's private directories`,
        "Point sandbox.packageStore at a directory of its own, outside every checkout",
      );
    // pnpm 11+ reads pnpm_config_*; its SQLite store index needs writes, so
    // only a verified install writes it and every other command reads it.
    if (options.packageInstall) writable.push(store);
    else readOnlyStore = store;
    Object.assign(env, packageCacheEnvironment(store));
  }
  if (options.packageInstall) {
    // An install runs no package-manager hooks, whatever the checkout says.
    env.npm_config_ignore_scripts = "true";
    env.pnpm_config_ignore_scripts = "true";
    env.pnpm_config_ignore_pnpmfile = "true";
    // Nor does it fetch and run another pnpm version.
    env.pnpm_config_manage_package_manager_versions = "false";
  }
  // systemMounts already provides both the real directories and aliases
  // such as /bin -> usr/bin. Binding a PATH entry over an alias would make
  // bubblewrap refuse the symlink destination.
  const system = SYSTEM_DIRECTORIES.filter((path) => existsSync(path)).flatMap(
    (path) => [path, real(path)],
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
    ...(services ? [services] : []),
  ])
    if (!system.some((root) => within(path, root))) mounts.set(path, "ro");
  for (const path of writable) mounts.set(path, "rw");
  // The checkout's `.git` stays read-only, so no command repoints it.
  const git = join(checkout, ".git");
  if (existsSync(git)) mounts.set(git, "ro");
  for (const file of options.readOnlyFiles ?? []) {
    const path = join(checkout, file);
    // Reached without links: an earlier command could have swapped a
    // parent directory for a link to a host file.
    if (
      !within(path, checkout) ||
      path === checkout ||
      !lstatSync(path, { throwIfNoEntry: false })?.isFile() ||
      realpathSync(path) !== path
    )
      throw new Refusal(
        `read-only file ${file} is not a regular file in the checkout`,
        "Validate again: Factory restores the checkout's Git LFS files afresh",
      );
    mounts.set(path, "ro");
  }
  // The operator's opt-in: every command shares the host's network
  // namespace. Otherwise a network grant runs in the sandbox's own
  // namespace through pasta, or offline.
  const host = config.network === "host";
  const online =
    options.network && options.packageInstall ? installNetwork() : undefined;
  const pasta = online?.available ? online : undefined;
  // An install without the network runs its package manager offline: it
  // installs from the store or fails at once, naming what is missing,
  // instead of waiting on registry lookups that cannot succeed.
  if (options.packageInstall && !pasta && !host) {
    env.npm_config_offline = "true";
    env.pnpm_config_offline = "true";
  }
  // Where the host's /etc/resolv.conf leads (often outside /etc): pasta's
  // DNS forwarder is written there, and the host's file is mounted there.
  const resolver =
    (pasta || host) && existsSync("/etc/resolv.conf")
      ? realpathSync("/etc/resolv.conf")
      : undefined;
  // Process limit: RLIMIT_NPROC, set by util-linux prlimit inside the sandbox.
  const prlimit = ["/usr/bin/prlimit", "/bin/prlimit"].find((path) =>
    existsSync(path),
  );
  if (!prlimit)
    throw new Refusal(
      "prlimit (util-linux) is not installed; the command sandbox cannot limit processes",
      "Install util-linux's prlimit on this host",
    );
  const limits = config.limits;
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
      ...(host ? ["--share-net"] : []),
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
          throw new Refusal(
            `${path} now leads to ${source}, which would show sandboxed commands runtime sockets or the shared temporary directory`,
            "Keep the PATH's links pointing at toolchain directories while Factory runs",
          );
        return [access === "rw" ? "--bind" : "--ro-bind", source, path];
      }),
      ...(resolver
        ? pasta
          ? ["--ro-bind-data", "5", resolver]
          : ["--ro-bind", resolver, resolver]
        : []),
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
      command,
    ],
    env,
    sandboxed: true,
    ...(online && !online.available && { offline: online.detail }),
    ...(pasta && {
      network: {
        pasta: pasta.executable,
        args: pasta.args,
        ...(resolver && { resolver: `nameserver ${PASTA_DNS}\n` }),
      },
    }),
  };
}

/**
 * What bubblewrap reported on fd 3. Its `child-pid` document comes right
 * after the clone, before any mount; `exit-code` comes only after setup
 * finished and the command was executed. A missing `exit-code` from a
 * bubblewrap that exited by itself is a setup failure, never the command's.
 */
interface BubblewrapStatus {
  executed: boolean;
  ended: Promise<void>;
  childPid: Promise<number | undefined>;
}

const BUBBLEWRAP_STATUS_LIMIT = 65_536;

function watchBubblewrap(child: ChildProcess): BubblewrapStatus {
  const stream = child.stdio[3] as Readable | null | undefined;
  let reported: (pid: number | undefined) => void = () => undefined;
  const status: BubblewrapStatus = {
    executed: false,
    ended: Promise.resolve(),
    childPid: new Promise((resolve) => {
      reported = resolve;
    }),
  };
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

/** How long pasta may take to configure a sandbox's network namespace. */
const PASTA_SETUP_MS = 10_000;

const NETWORK_FIX =
  "Let pasta (passt) configure the sandbox's network namespace on this host (/dev/net/tun usable by Factory's user), or set sandbox.network to \"off\"";

const networkRefusal = (detail: string) =>
  new Refusal(
    `The command sandbox's network could not be set up, so the command did not run: ${detail}`,
    NETWORK_FIX,
  );

/**
 * Configures the network namespace of a sandbox whose command waits for its
 * release on fd 4: runs pasta against the sandbox's first process, a member
 * of bubblewrap's group, and waits until pasta's pid file says it
 * configured the namespace. Resolves the running pasta when the command may
 * be released, undefined when bubblewrap ended first (its own setup
 * failure, which its status reports); throws a Refusal when pasta could not
 * configure the namespace, so the command must never be released.
 */
async function connectSandbox(
  bwrap: ChildProcess,
  status: BubblewrapStatus,
  network: NonNullable<Launch["network"]>,
  started: (pasta: ChildProcess, directory: string) => void,
): Promise<boolean> {
  const ended = () => bwrap.exitCode !== null || bwrap.signalCode !== null;
  const target = await status.childPid;
  if (target === undefined || ended()) return false;
  const held = processStat(target);
  if (!held || held.group !== bwrap.pid)
    throw networkRefusal(`process ${target} is not bubblewrap's sandbox`);
  const directory = mkdtempSync(join(tmpdir(), "factory-pasta-"));
  const pidFile = join(directory, "pid");
  const child = spawn(
    network.pasta,
    [...network.args, "--pid", pidFile, String(target)],
    { detached: true, stdio: ["ignore", "ignore", "pipe"], env: {} },
  );
  started(child, directory);
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    if (stderr.length < 4_096) stderr += chunk.toString("utf8");
  });
  let failure: Error | undefined;
  child.once("error", (error) => {
    failure = error;
  });
  const exited = () =>
    failure !== undefined ||
    child.exitCode !== null ||
    child.signalCode !== null;
  const detail = () =>
    `${network.pasta} ${failure ? failure.message : `exited ${child.exitCode ?? child.signalCode}`}: ${stderr.trim().slice(0, 1_000) || "no detail"}`;
  const deadline = Date.now() + PASTA_SETUP_MS;
  for (;;) {
    if (exited()) throw networkRefusal(detail());
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
        throw networkRefusal(`${pidFile} names another process`);
      break;
    }
    if (Date.now() >= deadline)
      throw networkRefusal(
        `${network.pasta} did not configure the namespace within ${PASTA_SETUP_MS / 1_000} seconds`,
      );
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  // The process pasta joined is the one held: alive, and the same, throughout.
  if (processStat(target)?.startTime !== held.startTime)
    throw networkRefusal(`the sandbox's process ${target} ended`);
  return true;
}

/**
 * Run `command` with `sh -c` in the sandbox. Resolves `ran` with the exit
 * code and output, or `fault` when the host kept it from running (the
 * sandbox is unavailable, a mount source is unsafe, pasta failed): a fault
 * is a hold that names the fix, never the command's failure. A timeout
 * kills the command's process group and resolves `ran` with `timedOut`. An
 * abort kills it and rejects with the signal's reason.
 */
export async function runSandboxed(
  command: string,
  options: SandboxOptions,
): Promise<SandboxRun> {
  options.signal.throwIfAborted();
  let checkout: string;
  let temporary: string;
  let home: string;
  let prepared: Launch;
  try {
    checkout = realpathSync(options.cwd);
    temporary = realpathSync(options.temporary);
    home = realpathSync(options.home);
    prepared = launch(command, options, checkout, temporary, home);
  } catch (error) {
    if (error instanceof Refusal) return fault(error.detail, error.fix);
    return fault(
      `The command sandbox could not be prepared: ${errorMessage(error)}`,
      "Keep the checkout, its private HOME and TMPDIR, sandbox.packageStore and sandbox.readOnlyPaths in place while Factory runs",
    );
  }
  try {
    await recordBaseline(checkout, temporary, options.signal);
  } catch (error) {
    if (options.signal.aborted) throw options.signal.reason;
    return fault(
      `The checkout's disk use could not be measured: ${errorMessage(error)}`,
      "Make every directory in the checkout readable by Factory's user",
    );
  }
  const network = prepared.network;
  options.signal.throwIfAborted();
  const child = spawn(prepared.file, prepared.args, {
    cwd: checkout,
    env: prepared.env,
    detached: true,
    stdio: prepared.sandboxed
      ? [
          "ignore",
          "pipe",
          "pipe",
          "pipe",
          // The release, and the resolver's data.
          ...(network ? (["pipe"] as const) : []),
          ...(network?.resolver !== undefined ? (["pipe"] as const) : []),
        ]
      : ["ignore", "pipe", "pipe"],
  });
  const group = child.pid;
  if (group) processGroups.add(group);
  let spawnError: Error | undefined;
  child.on("error", (error) => {
    spawnError = error;
  });
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.once("error", () => resolve());
  });
  const closed = new Promise<void>((resolve) => child.once("close", resolve));
  const status = prepared.sandboxed ? watchBubblewrap(child) : undefined;
  const bubblewrapError = { text: "" };
  const limit = options.outputLimit ?? 1024 ** 2;
  const half = Math.floor(limit / 2);
  const output = {
    stdout: new BoundedText(half, half),
    stderr: new BoundedText(half, half),
  };
  for (const stream of ["stdout", "stderr"] as const) {
    const decoder = new StringDecoder("utf8");
    child[stream]?.on("data", (chunk: Buffer) => {
      const text = decoder.write(chunk);
      if (stream === "stderr" && bubblewrapError.text.length < 4_096)
        bubblewrapError.text += text;
      output[stream].add(text);
      if (text) options.onOutput?.(stream, text);
    });
    child[stream]?.on("end", () => {
      const text = decoder.end();
      output[stream].add(text);
      if (text) options.onOutput?.(stream, text);
    });
  }
  let killed: "timeout" | "abort" | undefined;
  const stop = (why: "timeout" | "abort") => {
    if (killed) return;
    killed = why;
    if (group && child.exitCode === null && child.signalCode === null)
      killGroup(group);
  };
  const timer = setTimeout(() => stop("timeout"), options.timeoutMs);
  const onAbort = () => stop("abort");
  options.signal.addEventListener("abort", onAbort, { once: true });
  // `go` on fd 4 releases the held command, only once pasta configured its
  // network; closing it runs nothing.
  const stdio = child.stdio as unknown as (Writable | null | undefined)[];
  const gate = network ? stdio[4] : undefined;
  gate?.on("error", () => undefined);
  const data = network?.resolver !== undefined ? stdio[5] : undefined;
  data?.on("error", () => undefined);
  data?.end(network?.resolver);
  let pasta: { child: ChildProcess; directory: string } | undefined;
  let refused: Refusal | undefined;
  let released = false;
  const connecting =
    network && status && group
      ? connectSandbox(child, status, network, (started, directory) => {
          pasta = { child: started, directory };
          if (started.pid) processGroups.add(started.pid);
        })
          .then((connected) => {
            if (!connected) return;
            released = true;
            gate?.end("go\n");
          })
          .catch((error) => {
            // Killed with its group, never released: it never runs offline.
            refused =
              error instanceof Refusal
                ? error
                : networkRefusal(errorMessage(error));
            if (group) killGroup(group);
          })
      : undefined;
  await exited;
  clearTimeout(timer);
  options.signal.removeEventListener("abort", onAbort);
  // Whatever the command left in its group goes with it. Inside bubblewrap,
  // the PID namespace already ended them.
  if (group) {
    killGroup(group);
    processGroups.delete(group);
  }
  await connecting;
  gate?.destroy();
  data?.destroy();
  const served = pasta as
    | { child: ChildProcess; directory: string }
    | undefined;
  if (served) {
    const pid = served.child.pid;
    if (pid) {
      killGroup(pid);
      processGroups.delete(pid);
    }
    rmSync(served.directory, { recursive: true, force: true });
  }
  // A process that left the group can still hold the pipes: stop reading.
  let drain: NodeJS.Timeout | undefined;
  await Promise.race([
    closed,
    new Promise<void>((resolve) => {
      drain = setTimeout(resolve, 1_000);
    }),
  ]);
  clearTimeout(drain);
  child.stdout?.destroy();
  child.stderr?.destroy();
  if (killed === "abort") throw options.signal.reason;
  if (spawnError)
    return fault(
      `${prepared.file} could not start: ${spawnError.message}`,
      prepared.sandboxed ? BROKEN_FIX : "Make /bin/sh available on this host",
    );
  if (refused) return fault(refused.detail, refused.fix);
  if (status && !killed) {
    let wait: NodeJS.Timeout | undefined;
    await Promise.race([
      status.ended,
      new Promise<void>((resolve) => {
        wait = setTimeout(resolve, 1_000);
      }),
    ]);
    clearTimeout(wait);
    // bubblewrap exited by itself and never executed the command: its setup
    // (a mount or namespace) failed. The host's fault, not the command's.
    if (!status.executed)
      return fault(
        `The command sandbox could not be set up (bubblewrap exit ${child.exitCode ?? child.signalCode}), so the command did not run: ${bubblewrapError.text.trim().slice(0, 1_000) || "no detail"}`,
        "Keep every sandbox mount source (the PATH's toolchains, sandbox.readOnlyPaths, sandbox.packageStore, the checkout) in place while Factory runs, and let bubblewrap create namespaces on this host",
      );
    // A networked command never released ran nothing (its gate exits 125).
    if (network && !released)
      return fault(
        `The command sandbox's network could not be set up, so the command did not run: it was never released (bubblewrap exit ${child.exitCode})`,
        NETWORK_FIX,
      );
  }
  const overflow = await diskOverflow(
    checkout,
    home,
    temporary,
    options.config,
    // The kept store, when launch mounted it in place of HOME's caches.
    prepared.sandboxed && options.packageInstall && !options.config.packageStore
      ? options.installStore
      : undefined,
  );
  return {
    kind: "ran",
    exitCode: child.exitCode,
    stdout: output.stdout.toString(),
    stderr: output.stderr.toString(),
    truncated: {
      stdout: output.stdout.truncated,
      stderr: output.stderr.truncated,
    },
    timedOut: killed === "timeout",
    ...(overflow && { diskOverflow: overflow }),
    ...(prepared.offline && { offline: prepared.offline }),
    sandboxed: prepared.sandboxed,
  };
}
