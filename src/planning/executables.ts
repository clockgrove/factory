import { execFile } from "node:child_process";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { ObjectiveBlock } from "../shown.js";
import { BaseFiles } from "./facts.js";
import { packageManagerUpdate } from "./prompts.js";

const run = promisify(execFile);

/**
 * Which host executables the Objective's final commands need, whether they
 * exist on this host, and whether a pinned npm/pnpm matches the host version.
 * The planner and plan reviewer get the observations; a missing tool or a
 * version mismatch is a problem the operator fixes on the host. Nothing here
 * runs a target command: the only processes started are `--version` probes of
 * host npm/pnpm, in an empty directory with no network.
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
  observations: ExecutableObservation[];
}

const VERSION_PROBE_TIMEOUT_MS = 30_000;

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
    detail: `\`${name}\` is not on the validation PATH. Install it on this host or add its directory to the service's PATH; Factory does not install or substitute tools.`,
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

/** The host's `--version` of an npm/pnpm, run in an empty directory with no network. */
async function hostVersion(
  executable: string,
  path: string,
  signal: AbortSignal | undefined,
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
    const version = stdout.trim();
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

/** The package.json packageManager at the base; undefined when absent or unreadable. */
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
  signal?: AbortSignal;
}): Promise<{ observations: LocalExecutables | null; problems: string[] }> {
  const { checkout, base, blocks, finalCommands, signal } = args;
  const problems: string[] = [];

  const update = packageManagerUpdate(blocks);
  const baseline = (await new BaseFiles(checkout, base, signal).packageJson())
    .packageManager;
  if (update !== undefined) {
    const from = exactPin(baseline);
    if (!from || from.manager !== exactPin(update)?.manager)
      problems.push(
        `The Package manager update ${update} needs package.json at the base to pin the same manager exactly (it has ${baseline === undefined ? "no packageManager" : JSON.stringify(baseline)}). Pin ${exactPin(update)?.manager}@X.Y.Z in package.json on the default branch first, or remove the Package manager update section.`,
      );
  }
  const policy = update ?? baseline;
  if (!finalCommands.length) return { observations: null, problems };

  const path = process.env.PATH ?? "/usr/bin:/bin";
  const targetRoot = `${realpath(checkout)}${sep}`;
  const pin = exactPin(policy);
  const observations: ExecutableObservation[] = [];
  const versions = new Map<string, Promise<string | undefined>>();
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
      let probe = versions.get(resolved);
      if (!probe) {
        probe = hostVersion(realpath(resolved), path, signal);
        versions.set(resolved, probe);
      }
      const version = await probe;
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
          detail: `The pinned packageManager ${executable}@${pin.version} does not match ${executable} ${version} on this host (${resolved}). Install ${executable}@${pin.version} on the service's PATH (for example \`corepack enable\` or \`npm install -g ${executable}@${pin.version}\`), or change the pin.`,
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
  }

  return {
    observations: {
      base,
      path,
      finalCommands,
      ...(typeof policy === "string" ? { packageManager: policy } : {}),
      observations,
    },
    problems,
  };
}
