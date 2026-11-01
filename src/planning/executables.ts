import { execFile } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  realpathSync,
  statSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { satisfies, validRange } from "semver";
import type { SandboxConfig } from "../config.js";
import { within } from "../paths.js";
import type { ObjectiveBlock } from "../shown.js";
import { misePinFix } from "../toolchain.js";
import { BaseFiles } from "./facts.js";
import { packageManagerUpdate } from "./prompts.js";

const run = promisify(execFile);

/**
 * Which host executables the Objective's final commands need, whether they
 * exist on this host, whether a pinned npm/pnpm matches the host version, and
 * whether the host's node satisfies the target's Node pin when a command runs
 * node, npm, npx or pnpm. The planner and plan reviewer get the observations;
 * a missing tool or a version mismatch is a problem the operator fixes on the
 * host. Nothing here runs a target command: the only processes started are
 * `--version` probes of host node/npm/pnpm, in an empty directory with no
 * network. The observations also carry the sandbox's provisioning facts:
 * its read-only mounts and fixed environment, so the planner and reviewer
 * can tell a tool every sandbox gets from a host path its private HOME
 * hides (#2337).
 */

export type ExecutableStatus =
  | "ready"
  | "missing"
  | "unverified"
  | "version-mismatch";

export interface ExecutableObservation {
  /** Index into the final commands. */
  commandIndex: number;
  executable: string;
  status: ExecutableStatus;
  /** The host path it resolves to, when it does. */
  path?: string;
  /** The host version, when it was probed. */
  version?: string;
  detail: string;
}

export interface LocalExecutables {
  base: string;
  /** The PATH validation commands run with. */
  path: string;
  finalCommands: string[];
  /** The npm/pnpm pin the host must match: the Objective's update, else the base pin. */
  packageManager?: string;
  /** The base's Node pin the host's node must satisfy. */
  node?: NodePin;
  observations: ExecutableObservation[];
  /** What every sandboxed command is given beyond the PATH; absent when nothing is configured. */
  sandbox?: SandboxProvisioning;
}

/**
 * The sandbox's `readOnlyPaths`, each with whether it exists on this host,
 * and its `environment` names. A value is shown only when it is an absolute
 * path, with whether it exists and whether an existing read-only path
 * mounts it; other values are never shown.
 */
export interface SandboxProvisioning {
  readOnlyPaths: { path: string; exists: boolean }[];
  environment: {
    name: string;
    path?: string;
    exists?: boolean;
    mounted?: boolean;
  }[];
}

/**
 * The provisioning facts of a sandbox config, or undefined when it mounts
 * and sets nothing. A name in `secretNames` (policy.allowedSecretNames) is
 * left out, whatever its value.
 */
export function sandboxProvisioning(
  sandbox: Pick<SandboxConfig, "readOnlyPaths" | "environment">,
  secretNames: readonly string[] = [],
): SandboxProvisioning | undefined {
  const readOnlyPaths = sandbox.readOnlyPaths.map((path) => ({
    path,
    exists: existsSync(path),
  }));
  const environment = Object.entries(sandbox.environment)
    .filter(([name]) => !secretNames.includes(name))
    .map(([name, value]) =>
      isAbsolute(value)
        ? {
            name,
            path: value,
            exists: existsSync(value),
            mounted: readOnlyPaths.some(
              (root) => root.exists && within(value, root.path),
            ),
          }
        : { name },
    );
  return readOnlyPaths.length || environment.length
    ? { readOnlyPaths, environment }
    : undefined;
}

const VERSION_PROBE_TIMEOUT_MS = 30_000;

/** Final-command entrypoints that run the host's node. */
const NODE_TOOLS = new Set(["node", "npm", "npx", "pnpm"]);

/** A Node version pin and the file it came from. */
export interface NodePin {
  source: string;
  range: string;
}

/**
 * The target's Node pin: the first of `.nvmrc`, `.node-version`,
 * `.tool-versions` (its `nodejs` or `node` line) and package.json
 * `engines.node` that holds an exact version or a semver range. Aliases such
 * as `lts/*` or `system` are not resolved: that file is passed over.
 */
export async function nodePin(
  read: (path: string) => Promise<string | undefined>,
): Promise<NodePin | undefined> {
  const firstLine = (text: string | undefined) =>
    text
      ?.split("\n")
      .map((line) => line.replace(/#.*/, "").trim())
      .find(Boolean);
  const toolVersions = (await read(".tool-versions"))
    ?.split("\n")
    .map((line) => line.replace(/#.*/, "").trim().split(/\s+/))
    .find(([tool]) => tool === "nodejs" || tool === "node")?.[1];
  let engines: unknown;
  try {
    engines = (
      JSON.parse((await read("package.json")) ?? "{}") as {
        engines?: { node?: unknown };
      }
    ).engines?.node;
  } catch {
    engines = undefined;
  }
  const candidates: [string, unknown][] = [
    [".nvmrc", firstLine(await read(".nvmrc"))],
    [".node-version", firstLine(await read(".node-version"))],
    [".tool-versions", toolVersions],
    ["package.json engines.node", engines],
  ];
  for (const [source, value] of candidates)
    if (typeof value === "string" && value.trim() && validRange(value.trim()))
      return { source, range: value.trim() };
  return undefined;
}

/** Whether a host node version satisfies the pin. */
export function nodeSatisfies(version: string, pin: NodePin): boolean {
  return satisfies(version, pin.range);
}

const SHELL_KEYWORDS = new Set([
  "if",
  "then",
  "else",
  "elif",
  "fi",
  "for",
  "do",
  "done",
  "while",
  "until",
  "case",
  "esac",
  "in",
]);

/** Commands that run other commands, so the words after them aren't checked. */
const WRAPPERS = new Set([
  "sh",
  "bash",
  "dash",
  "env",
  "eval",
  "exec",
  "command",
  "if",
  "for",
  "while",
  "case",
  "cd",
  "export",
]);

/** POSIX `sh` builtins: always present once `sh` is. */
const BUILTINS = new Set([
  ":",
  ".",
  "[",
  "alias",
  "bg",
  "break",
  "cd",
  "command",
  "continue",
  "echo",
  "eval",
  "exec",
  "exit",
  "export",
  "false",
  "fc",
  "fg",
  "getopts",
  "hash",
  "jobs",
  "kill",
  "printf",
  "pwd",
  "read",
  "readonly",
  "return",
  "set",
  "shift",
  "test",
  "times",
  "trap",
  "true",
  "type",
  "ulimit",
  "umask",
  "unalias",
  "unset",
  "wait",
]);

/**
 * The literal first words of a command's segments. Deliberately not a shell
 * parser: quoting, substitution or redirection makes the command partial,
 * and the planner is told those positions are unverified.
 */
function literalEntrypoints(command: string): {
  names: string[];
  partial: boolean;
} {
  const first = (value: string) =>
    value.trim().match(/^([A-Za-z_][A-Za-z0-9_.+-]*|\[|:)(?:\s|$)/)?.[1];
  const background = /(^|[^&])&([^&]|$)/.test(command);
  const complex = /["'`$\\(){}<>#]/.test(command) || background;
  const segments = complex ? [command] : command.split(/&&|\|\||[;|\n]/);
  const names = segments
    .map(first)
    .filter(
      (name): name is string => name !== undefined && !SHELL_KEYWORDS.has(name),
    );
  const partial =
    names.length !== segments.length ||
    complex ||
    names.some((name) => WRAPPERS.has(name));
  return { names: [...new Set(names)], partial };
}

/** An executable regular file, or undefined. */
function executableFile(path: string): string | undefined {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile() ? path : undefined;
  } catch {
    return undefined;
  }
}

function realpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

type Lookup =
  | { status: "ready"; path?: string }
  | { status: "missing" | "unverified"; detail: string };

/** Resolve a name the way `sh` searches PATH, without running a shell. */
function lookup(name: string, path: string, targetRoot: string): Lookup {
  if (BUILTINS.has(name)) return { status: "ready" };
  for (const directory of path.split(":")) {
    if (!isAbsolute(directory))
      return {
        status: "unverified",
        detail:
          "PATH has a relative entry, so the tool found depends on the validation worktree; make every PATH entry absolute to have it checked.",
      };
    const found = executableFile(resolve(directory, name));
    if (!found) continue;
    if (realpath(found).startsWith(targetRoot) || found.startsWith(targetRoot))
      return {
        status: "unverified",
        detail: `It resolves to ${found} inside the target checkout; target executables are not run or checked.`,
      };
    return { status: "ready", path: found };
  }
  return {
    status: "missing",
    detail: `\`${name}\` is not on the validation PATH. Install it on this host or add its directory to the service's PATH (\`factory setup --toolchain-path DIR\` keeps it there); Factory does not install or substitute tools.`,
  };
}

/** An exact npm/pnpm pin, ignoring a Corepack `+hash` suffix. */
function exactPin(
  value: unknown,
): { manager: "npm" | "pnpm"; version: string } | undefined {
  const match =
    typeof value === "string"
      ? value.match(
          /^(npm|pnpm)@(\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?)(?:\+[A-Za-z0-9.]+)?$/,
        )
      : undefined;
  return match
    ? { manager: match[1] as "npm" | "pnpm", version: match[2]! }
    : undefined;
}

/** The host's `--version` of node, npm or pnpm, run in an empty directory with no network. */
export async function hostVersion(
  executable: string,
  path: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const home = await mkdtemp(join(tmpdir(), "factory-version-"));
  try {
    const { stdout } = await run(executable, ["--version"], {
      cwd: home,
      encoding: "utf8",
      timeout: VERSION_PROBE_TIMEOUT_MS,
      env: {
        PATH: path,
        HOME: home,
        TMPDIR: home,
        COREPACK_ENABLE_NETWORK: "0",
        COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
        NO_UPDATE_NOTIFIER: "1",
        npm_config_update_notifier: "false",
      },
      ...(signal ? { signal } : {}),
    });
    const version = stdout.trim().replace(/^v/, "");
    return /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version)
      ? version
      : undefined;
  } catch {
    if (signal?.aborted) throw signal.reason;
    return undefined;
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

/**
 * Observe the host executables the final commands need. Problems are data:
 * each names the fix. Throws only a TransientError when git can't read the
 * base, or the abort reason.
 */
export async function observeLocalExecutables(args: {
  checkout: string;
  base: string;
  /** The Objective's shown structure: its Package manager update. */
  blocks: readonly ObjectiveBlock[];
  finalCommands: string[];
  /** The sandbox's provisioning facts (sandboxProvisioning). */
  sandbox?: SandboxProvisioning;
  signal?: AbortSignal;
}): Promise<{ observations: LocalExecutables | null; problems: string[] }> {
  const { checkout, base, blocks, finalCommands, sandbox, signal } = args;
  const problems: string[] = [];

  const update = packageManagerUpdate(blocks);
  const files = new BaseFiles(checkout, base, signal);
  const baseline = (await files.packageJson()).packageManager;
  if (update !== undefined) {
    const from = exactPin(baseline);
    if (!from || from.manager !== exactPin(update)?.manager)
      problems.push(
        `The Package manager update ${update} needs package.json at the base to pin the same manager exactly (it has ${baseline === undefined ? "no packageManager" : JSON.stringify(baseline)}). Pin ${exactPin(update)?.manager}@X.Y.Z in package.json on the default branch first, or remove the Package manager update section.`,
      );
  }
  const policy = update ?? baseline;
  const path = process.env.PATH ?? "/usr/bin:/bin";
  if (!finalCommands.length)
    return {
      observations: sandbox
        ? { base, path, finalCommands, observations: [], sandbox }
        : null,
      problems,
    };

  const targetRoot = `${realpath(checkout)}${sep}`;
  const pin = exactPin(policy);
  const node = await nodePin((file) => files.text(file));
  // With mise managing the checkout, a moved pin is installed with mise.
  const mise = misePinFix(checkout);
  const observations: ExecutableObservation[] = [];
  const versions = new Map<string, Promise<string | undefined>>();
  const probe = (resolved: string) => {
    let version = versions.get(resolved);
    if (!version) {
      version = hostVersion(realpath(resolved), path, signal);
      versions.set(resolved, version);
    }
    return version;
  };
  const reported = new Set<string>();

  for (const [commandIndex, command] of finalCommands.entries()) {
    signal?.throwIfAborted();
    const observe = (entry: Omit<ExecutableObservation, "commandIndex">) => {
      observations.push({ commandIndex, ...entry });
      if (
        (entry.status === "missing" || entry.status === "version-mismatch") &&
        !reported.has(`${entry.executable}:${entry.status}`)
      ) {
        reported.add(`${entry.executable}:${entry.status}`);
        problems.push(`Final command \`${command}\`: ${entry.detail}`);
      }
    };
    const { names, partial } = literalEntrypoints(command);
    if (partial)
      observe({
        executable: "(dynamic or nested)",
        status: "unverified",
        detail:
          "Only literal first words are checked; quoting, substitution, redirection and wrapped commands are not.",
      });
    for (const executable of new Set(["sh", ...names])) {
      const found = lookup(executable, path, targetRoot);
      if (found.status !== "ready") {
        observe({ executable, status: found.status, detail: found.detail });
        continue;
      }
      const resolved = found.path;
      if (
        !resolved ||
        (executable !== "npm" && executable !== "pnpm") ||
        policy === undefined
      ) {
        observe({
          executable,
          status: "ready",
          ...(resolved ? { path: resolved } : {}),
          detail: resolved ? `Resolves to ${resolved}.` : "A shell builtin.",
        });
        continue;
      }
      if (!pin) {
        observe({
          executable,
          status: "unverified",
          path: resolved,
          detail: `package.json packageManager ${JSON.stringify(policy)} is not an exact npm or pnpm version, so the host version is not checked.`,
        });
        continue;
      }
      if (pin.manager !== executable) {
        observe({
          executable,
          status: "ready",
          path: resolved,
          detail: `Resolves to ${resolved}.`,
        });
        continue;
      }
      const version = await probe(resolved);
      if (version === undefined)
        observe({
          executable,
          status: "unverified",
          path: resolved,
          detail: `\`${executable} --version\` gave no exact version, so the pin ${executable}@${pin.version} is not checked.`,
        });
      else if (version !== pin.version)
        observe({
          executable,
          status: "version-mismatch",
          path: resolved,
          version,
          detail: `The pinned packageManager ${executable}@${pin.version} does not match ${executable} ${version} on this host (${resolved}). ${mise ? `${mise}; or change the pin.` : `Install ${executable}@${pin.version} on the service's PATH (for example \`corepack enable\` or \`npm install -g ${executable}@${pin.version}\`), or change the pin.`}`,
        });
      else
        observe({
          executable,
          status: "ready",
          path: resolved,
          version,
          detail: `Resolves to ${resolved}, version ${version} matches the pin.`,
        });
    }
    const host = lookup("node", path, targetRoot);
    if (!node || host.status !== "ready" || !host.path) continue;
    if (!names.some((name) => NODE_TOOLS.has(name))) continue;
    const version = await probe(host.path);
    if (version === undefined)
      observe({
        executable: "node",
        status: "unverified",
        path: host.path,
        detail: `\`node --version\` gave no exact version, so the Node pin ${node.range} (${node.source}) is not checked.`,
      });
    else if (!nodeSatisfies(version, node))
      observe({
        executable: "node",
        status: "version-mismatch",
        path: host.path,
        version,
        detail: `The target pins Node ${node.range} (${node.source}), but node on this host is ${version} (${host.path}). ${mise ? `${mise}; or change the pin.` : "Put a matching node first on the service's PATH, or change the pin."}`,
      });
    else
      observe({
        executable: "node",
        status: "ready",
        path: host.path,
        version,
        detail: `Resolves to ${host.path}, version ${version} satisfies the Node pin ${node.range} (${node.source}).`,
      });
  }

  return {
    observations: {
      base,
      path,
      finalCommands,
      ...(typeof policy === "string" ? { packageManager: policy } : {}),
      ...(node ? { node } : {}),
      observations,
      ...(sandbox ? { sandbox } : {}),
    },
    problems,
  };
}
