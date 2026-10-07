import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  existsSync,
  realpathSync,
  closeSync,
  constants,
  fstatSync,
  openSync,
  opendirSync,
  readSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import {
  captureOwnedRollout,
  type NativeCaptureObserver,
} from "./codex-native-capture.js";
import { workerToolchainPath } from "./process.js";

/**
 * Factory's own Codex configuration for planning and review: no shell, file,
 * web, app, plugin or agent tools, and no project instructions. The prompt is
 * the complete request, so the operator's `config.toml` and `AGENTS.md` have
 * nothing to add and must never shape a plan.
 */
export const CODEX_PLANNING_CONFIG = `web_search = "disabled"
project_doc_max_bytes = 0

[features]
shell_tool = false
unified_exec = false
view_image = false
multi_agent = false
apps = false
plugins = false
browser_use = false
computer_use = false
image_generation = false
code_mode_host = false
skill_search = false
tool_suggest = false
sleep_tool = false
memories = false
hooks = false
`;

/**
 * The same configuration for a result review, which reads the exact candidate
 * tree itself: only the shell is on, inside the read-only, network-less
 * permission profile `createCodexHome` adds. Codex runs shell calls through
 * its code-mode host, so the shell needs that host too.
 */
export const CODEX_TREE_REVIEW_CONFIG = CODEX_PLANNING_CONFIG.replace(
  "shell_tool = false",
  "shell_tool = true",
).replace("code_mode_host = false", "code_mode_host = true");

/** Ambient variables a Factory Codex process keeps; everything else is dropped. */
const ENVIRONMENT = [
  /^PATH$/,
  /^LANG$/,
  /^LC_[A-Z_]+$/,
  /^TZ$/,
  /^(?:HTTPS?|NO|ALL)_PROXY$/i,
  /^NODE_EXTRA_CA_CERTS$/,
  /^SSL_CERT_(?:FILE|DIR)$/,
  /^OPENAI_(?:API_KEY|BASE_URL)$/,
  /^CODEX_API_KEY$/,
];

/** What a Codex shell may do in its working directory and on the network. */
export interface CodexSandbox {
  /** The thread's working directory. */
  directory: string;
  workspace: "read" | "write";
  network: boolean;
}

/** The installed Codex runtime; its Linux sandbox helper re-executes it. */
export function codexRuntimeDirectory(): string {
  const cli = createRequire(
    createRequire(import.meta.url).resolve("@openai/codex/package.json"),
  );
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  return join(
    dirname(cli.resolve(`@openai/codex-linux-${arch}/package.json`)),
    "vendor",
  );
}

const real = (path: string) =>
  existsSync(path) ? realpathSync(path) : resolve(path);
const within = (path: string, directory: string) =>
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
function gitMetadata(workspace: string): string[] {
  const git = linkedGit(workspace);
  if (!git || git.common === git.administrative) return [];
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

/**
 * The directories a worker's shell reads, never writes, so the tools on its
 * PATH run: every PATH directory, and the directory of the real file behind
 * each link in one. A directory named `bin` or `sbin` stands for its install
 * prefix, where a tool keeps its libraries, unless the prefix is hidden,
 * the HOME or Windows profile itself, or a direct child of either. Those
 * directories can contain unrelated private files; mount only bin there.
 *
 * Nothing here may show the operator's HOME as a whole, a login (SSH, gh,
 * Codex, Claude, Copilot), Factory's config or state, or the checkout's git
 * directory. A PATH directory that would is a configuration error; a link
 * that leads into one is left unmounted, so that tool does not run.
 */
function toolchainDirectories(
  source: NodeJS.ProcessEnv,
  workspace: string,
): string[] {
  const home = real(source.HOME || homedir());
  const config = source.XDG_CONFIG_HOME || join(home, ".config");
  const state = source.XDG_STATE_HOME || join(home, ".local", "state");
  const data = source.XDG_DATA_HOME || join(home, ".local", "share");
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
    ...(linked ? [linked.common] : []),
  ].map(real);
  const exposes = (directory: string) => {
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
  };
  const root = (directory: string) => {
    const prefix = dirname(directory);
    if (
      ["bin", "sbin"].includes(basename(directory)) &&
      !basename(prefix).startsWith(".") &&
      dirname(prefix) !== home &&
      dirname(prefix) !== windowsProfile(prefix) &&
      !exposes(prefix)
    )
      return prefix;
    return exposes(directory) ? undefined : directory;
  };
  const roots = new Set<string>();
  for (const entry of (source.PATH ?? "").split(":")) {
    // A relative entry resolves inside the worktree, which is mounted.
    if (!isAbsolute(entry) || !existsSync(entry)) continue;
    const directory = realpathSync(entry);
    if (!statSync(directory).isDirectory() || within(directory, workspace))
      continue;
    const mount = root(directory);
    if (!mount)
      throw new Error(
        `PATH entry ${entry} would show Codex workers your HOME, a login or Factory's own files. Remove it from the PATH Factory runs with, or move its tools to a directory of their own.`,
      );
    // A linked PATH directory is mounted under the name the PATH uses too.
    roots.add(mount).add(resolve(entry));
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      if (!item.isSymbolicLink()) continue;
      const target = real(join(directory, item.name));
      if (!statSync(target, { throwIfNoEntry: false })?.isFile()) continue;
      // A link into a login directory stays unmounted: that tool does not run.
      const linked = root(dirname(target));
      if (linked) roots.add(linked);
    }
  }
  return [...roots].filter(
    (mount) =>
      ![...roots].some((other) => other !== mount && within(mount, other)),
  );
}

/**
 * A Codex permission profile: shell commands see only the platform paths
 * Codex calls `:minimal`, the Codex runtime, the working directory (its
 * `.git` entry read-only) and, when they may write, the private HOME and
 * TMPDIR plus, read-only, the PATH's toolchains and the worktree's own git
 * metadata. Nothing else is mounted: not the operator's HOME, logins, SSH
 * keys or gh config, Factory's state, nor the rest of the checkout's git
 * directory.
 */
function permissionProfile(
  sandbox: CodexSandbox,
  source: NodeJS.ProcessEnv,
  home: string,
  temporary: string,
): string {
  const path = (value: string) => JSON.stringify(value);
  const grants = [
    `":minimal" = "read"`,
    `${path(codexRuntimeDirectory())} = "read"`,
    ...(sandbox.workspace === "write"
      ? [
          ...[
            ...toolchainDirectories(source, real(sandbox.directory)),
            ...gitMetadata(real(sandbox.directory)),
          ].map((directory) => `${path(directory)} = "read"`),
          `${path(home)} = "write"`,
          `${path(temporary)} = "write"`,
        ]
      : []),
  ];
  // Name resolution: /etc/resolv.conf often links outside `:minimal`
  // (systemd-resolved under /run, WSL under /mnt/wsl).
  if (sandbox.network && existsSync("/etc/resolv.conf"))
    grants.push(`${path(realpathSync("/etc/resolv.conf"))} = "read"`);
  return `[permissions.factory.filesystem]
${grants.join("\n")}

[permissions.factory.filesystem.":workspace_roots"]
"." = "${sandbox.workspace}"
".git" = "read"

[permissions.factory.network]
enabled = ${sandbox.network}
`;
}

export interface CodexHome {
  /** Environment for the Codex process; it replaces `process.env`. */
  env: Record<string, string>;
  /** Bounded native event metadata only; no payloads or cessation proof. */
  nativeMetadata(threadId?: string): unknown;
  /** Read only this owned thread's bounded history after native process settlement. */
  nativeCapture(
    threadId: string | undefined,
    observe: NativeCaptureObserver,
  ): void;
  /** Removes the scratch home. */
  dispose(): void;
}

function nativeMetadata(
  home: string,
  threadId?: string,
  observe?: NativeCaptureObserver,
  identity?: { dev: number; ino: number },
): unknown {
  const unavailable = { source: "codex-rollout", status: "unavailable" };
  if (!threadId || !/^[0-9a-f-]{36}$/.test(threadId)) return unavailable;
  let remaining = 128;
  let selectedThread = threadId;
  let selectedParent: string | undefined;
  let selectedDepth = 0;
  const budget = { remainingBytes: 8 * 1024 * 1024, remainingEvents: 4094 };
  const children: {
    id: string;
    parent: string;
    depth: number;
    model?: string;
    reasoningEffort?: string;
  }[] = [];
  const seen = new Set([threadId]);
  const visit = (directory: string, depth: number): unknown => {
    if (--remaining < 0) return undefined;
    const fd = openSync(
      directory,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY,
    );
    try {
      // Hold each directory open while reading its children: a substituted
      // symlink cannot redirect the scan outside this owned native home.
      const anchor = `/proc/self/fd/${fd}`;
      if (fstatSync(fd).uid !== process.getuid?.()) return undefined;
      const entries = opendirSync(anchor);
      try {
        for (
          let entry = entries.readSync();
          entry;
          entry = entries.readSync()
        ) {
          if (--remaining < 0) break;
          const path = join(anchor, entry.name);
          if (entry.isFile() && entry.name.endsWith(`-${selectedThread}.jsonl`))
            return readRollout(path);
          if (entry.isDirectory() && depth > 0) {
            const found = visit(path, depth - 1);
            if (found !== undefined) return found;
          }
        }
      } finally {
        entries.closeSync();
      }
      return undefined;
    } finally {
      closeSync(fd);
    }
  };
  const readRollout = (path: string): unknown => {
    const fd = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.nlink !== 1)
        return unavailable;
      if (observe) {
        const coverage = captureOwnedRollout(fd, selectedThread, observe, {
          parentThreadId: selectedParent,
          rootThreadId: threadId,
          budget,
          child: (child) => {
            if (!seen.has(child.id)) {
              seen.add(child.id);
              children.push({
                ...child,
                parent: selectedThread,
                depth: selectedDepth + 1,
              });
            }
          },
        });
        return { source: "codex-rollout", status: "observed", coverage };
      }
      const head = Buffer.alloc(Math.min(stat.size, 256 * 1024));
      const headBytes = readSync(fd, head, 0, head.length, 0);
      const firstLine = head
        .subarray(0, headBytes)
        .toString("utf8")
        .split("\n")[0]!;
      const session = JSON.parse(firstLine);
      if (session.type !== "session_meta" || session.payload?.id !== threadId)
        return unavailable;
      const offset = Math.max(0, stat.size - 64 * 1024);
      const tail = Buffer.alloc(stat.size - offset);
      const tailBytes = readSync(fd, tail, 0, tail.length, offset);
      const lines = tail.subarray(0, tailBytes).toString("utf8").split("\n");
      if (offset) lines.shift();
      const events: unknown[] = [];
      for (const line of lines.slice(-256)) {
        try {
          const item = JSON.parse(line);
          const kind = (value: unknown) =>
            typeof value === "string" && /^[a-z_]{1,64}$/.test(value)
              ? value
              : undefined;
          events.push({
            at:
              typeof item.timestamp === "string" &&
              /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(item.timestamp)
                ? item.timestamp
                : undefined,
            type: kind(item.type),
            event: kind(item.payload?.type),
          });
        } catch {
          /* Partial or oversized native records are not reconstructed. */
        }
      }
      return {
        source: "codex-rollout",
        status: "partial",
        bytes: stat.size,
        readAt: new Date().toISOString(),
        events,
        processCessation: "unavailable",
        networkStream: "unavailable",
      };
    } finally {
      closeSync(fd);
    }
  };
  let rootFd: number | undefined;
  try {
    rootFd = openSync(
      home,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY,
    );
    const root = fstatSync(rootFd);
    if (
      root.uid !== process.getuid?.() ||
      (root.mode & 0o077) !== 0 ||
      (identity && (root.dev !== identity.dev || root.ino !== identity.ino))
    )
      return unavailable;
    const sessions = join(`/proc/self/fd/${rootFd}`, "sessions");
    const result = visit(sessions, 3) ?? unavailable;
    if (observe)
      for (let index = 0; index < children.length && index < 16; index++) {
        const child = children[index]!;
        selectedThread = child.id;
        selectedParent = child.parent;
        selectedDepth = child.depth;
        let status: "available" | "partial" | "unavailable" = "unavailable";
        try {
          if (
            child.depth <= 4 &&
            remaining > 0 &&
            budget.remainingBytes > 0 &&
            budget.remainingEvents > 0
          ) {
            const childResult = visit(sessions, 3) as
              | { status?: string; coverage?: "available" | "partial" }
              | undefined;
            if (childResult?.status === "observed")
              status = childResult.coverage ?? "partial";
          }
        } catch {
          /* Missing or unauthenticated descendant data never blocks provider work. */
        }
        observe({
          kind: "interaction",
          providerEvent: "codex.native-descendant-coverage",
          providerSessionId: child.parent,
          coverage: "boundary",
          nativeDescendant: {
            parentSessionId: child.parent,
            childSessionId: child.id,
            relation:
              status !== "unavailable"
                ? "authenticated-owned-home"
                : "observed-spawn",
            status: "unknown",
            recordedAt: null,
            ...(child.model ? { model: child.model } : {}),
            ...(child.reasoningEffort
              ? { reasoningEffort: child.reasoningEffort }
              : {}),
            history: status,
            resourceCessation: "unavailable",
            parentUsageIncludesChild: "unknown",
          },
        });
      }
    return result;
  } catch {
    return unavailable;
  } finally {
    if (rootFd !== undefined) closeSync(rootFd);
  }
}

/**
 * A scratch CODEX_HOME, HOME and TMPDIR for one Codex thread. It holds
 * Factory's config and a link to the operator's login (`auth.json`, linked
 * so a token refresh reaches the operator), and nothing else: not the
 * operator's `config.toml`, `AGENTS.md`, skills, profiles or MCP servers.
 * With a `sandbox`, the config also confines every shell command to it.
 * `keep` names further variables to pass through, such as declared secrets.
 */
export function createCodexHome(options: {
  /** A harness-owned path, removed only after its process group is settled. */
  root?: string;
  source?: NodeJS.ProcessEnv;
  config: string;
  sandbox?: CodexSandbox;
  keep?: readonly string[];
}): CodexHome {
  const ambient = options.source ?? process.env;
  const source: NodeJS.ProcessEnv = {
    ...ambient,
    PATH: workerToolchainPath(ambient.PATH),
  };
  const root = options.root ?? mkdtempSync(join(tmpdir(), "factory-codex-"));
  if (options.root) mkdirSync(root, { mode: 0o700 });
  try {
    const home = join(root, "home");
    const codexHome = join(root, "codex-home");
    const temporary = join(root, "tmp");
    for (const directory of [home, codexHome, temporary])
      mkdirSync(directory, { mode: 0o700 });
    const codexIdentity = statSync(codexHome);
    writeFileSync(
      join(codexHome, "config.toml"),
      options.sandbox
        ? `default_permissions = "factory"\n${options.config}\n${permissionProfile(options.sandbox, source, home, temporary)}`
        : options.config,
    );
    const login = join(
      source.CODEX_HOME || join(source.HOME || homedir(), ".codex"),
      "auth.json",
    );
    if (existsSync(login)) symlinkSync(login, join(codexHome, "auth.json"));
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(source))
      if (
        value !== undefined &&
        (ENVIRONMENT.some((pattern) => pattern.test(name)) ||
          options.keep?.includes(name))
      )
        env[name] = value;
    env.HOME = home;
    env.CODEX_HOME = codexHome;
    env.TMPDIR = temporary;
    // Git metadata is read-only in the sandbox: `git status` must not try to
    // refresh the index.
    if (options.sandbox) env.GIT_OPTIONAL_LOCKS = "0";
    return {
      env,
      nativeMetadata: (threadId) =>
        nativeMetadata(codexHome, threadId, undefined, codexIdentity),
      nativeCapture: (threadId, observe) => {
        const safely: NativeCaptureObserver = (event, content) => {
          try {
            observe(event, content);
          } catch {
            /* Capture is observational and cannot affect provider outcomes. */
          }
        };
        const result = nativeMetadata(
          codexHome,
          threadId,
          safely,
          codexIdentity,
        ) as {
          status: string;
        };
        if (result.status === "unavailable")
          safely({
            kind: "interaction",
            providerEvent: "codex.native-rollout-coverage",
            providerSessionId: threadId,
            coverage: "boundary",
            nativeRollout: {
              cliVersion: null,
              status: "unavailable",
              readBytes: null,
              totalBytes: null,
              observedCompletedResponses: null,
              duplicateResponseRecords: null,
              conflictingResponseRecords: null,
              inheritedHistory: null,
              childHistory: null,
              completeRequestCount: "unavailable",
              fullProviderWireAndUpstreamDetails: "unavailable",
              endpointCompleteness: "unavailable",
            },
          });
      },
      dispose: () => rmSync(root, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}
