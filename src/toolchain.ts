/**
 * The service's toolchain from the checkout's mise pins. When the
 * configured checkout has a mise configuration and mise is on the PATH,
 * setup asks mise, in that checkout, which version of each tool the
 * checkout pins and where its executables are; `--background` puts those
 * directories first on the unit's PATH, so the service runs exactly what
 * the repository pins. Without either, nothing changes.
 *
 * Factory only reads. It never runs `mise install` or `mise trust`: both
 * are the operator's choice. A mise configuration can run code (templates,
 * `[env]` sources), and mise runs it only for a configuration the operator
 * trusted, so Factory asks mise only in the operator's checkout, never in a
 * worktree a worker writes, and with MISE_YES=0, so mise can't trust a
 * configuration on its own.
 */
import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { executable } from "./sandbox.js";

/** The checkout's files that make mise manage it. */
export const MISE_CONFIGS = [
  "mise.toml",
  ".mise.toml",
  "mise.local.toml",
  ".mise.local.toml",
  ".config/mise.toml",
  ".config/mise/config.toml",
  ".config/mise/conf.d",
  ".mise/config.toml",
  "mise/config.toml",
  ".tool-versions",
];

/** A tool the checkout pins, as mise resolves it. */
export interface MiseTool {
  name: string;
  version: string;
  /** The checkout's file that pins it. */
  source: string;
  /** Its executables' directories, first on the service's PATH; empty when it isn't installed. */
  bins: string[];
}

/** What mise makes of the checkout's pins. */
export type MiseToolchain =
  | {
      status: "resolved";
      /** Installed tools, in mise's order. */
      tools: MiseTool[];
      /** Pinned tools that aren't installed. */
      missing: MiseTool[];
    }
  /** mise refuses `file` until the operator trusts it. */
  | { status: "untrusted"; file: string }
  | { status: "failed"; detail: string };

/** How long one mise call may take. */
const MISE_TIMEOUT_MS = 60_000;

/** The real path, or the path as given when it doesn't resolve. */
function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** Whether mise manages the checkout: it has a mise configuration, and mise is on the PATH. */
export function miseManages(checkout: string): boolean {
  return (
    MISE_CONFIGS.some((name) => existsSync(join(checkout, name))) &&
    !!executable("mise")
  );
}

/**
 * The checkout's pins as mise resolves them, run in the checkout; undefined
 * when mise doesn't manage it. Only tools a file in the checkout pins
 * count: a global or parent directory's pin is the operator's own.
 */
export function miseToolchain(checkout: string): MiseToolchain | undefined {
  const mise = executable("mise");
  if (!mise || !miseManages(checkout)) return undefined;
  const root = real(checkout);
  const ask = (...args: string[]) => {
    const run = spawnSync(mise, args, {
      cwd: root,
      encoding: "utf8",
      timeout: MISE_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
      // MISE_YES=1, or the `yes` setting, would trust a configuration
      // without asking, and run its templates; 0 overrides both.
      env: { ...process.env, PWD: root, MISE_YES: "0", NO_COLOR: "1" },
    });
    const errors = (run.stderr ?? "")
      .split("\n")
      .map((line) => line.replace(/^mise ERROR\s*/, "").trim())
      .filter((line) => line && !/^(Version:|Run with --verbose)/.test(line));
    return {
      out: run.status === 0 ? run.stdout : undefined,
      error:
        errors.join(" ") ||
        run.error?.message ||
        `mise ${args.join(" ")} exited ${run.status ?? run.signal}`,
    };
  };
  const listed = ask("ls", "--current", "--json");
  if (listed.out === undefined) {
    const file = /Config files in (.+?) are not trusted/.exec(
      listed.error,
    )?.[1];
    return file
      ? { status: "untrusted", file }
      : {
          status: "failed",
          detail: `\`mise ls --current --json\` in ${checkout}: ${listed.error}`,
        };
  }
  let entries: [string, unknown][];
  try {
    const parsed: unknown = JSON.parse(listed.out);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("not a JSON object");
    entries = Object.entries(parsed);
  } catch (error) {
    return {
      status: "failed",
      detail: `\`mise ls --current --json\` in ${checkout} printed no tool list: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const tools: MiseTool[] = [];
  const missing: MiseTool[] = [];
  for (const [name, versions] of entries) {
    if (!Array.isArray(versions)) continue;
    for (const entry of versions as {
      version?: unknown;
      installed?: unknown;
      source?: { path?: unknown };
    }[]) {
      const source = entry?.source?.path;
      if (typeof source !== "string" || typeof entry.version !== "string")
        continue;
      const inside = relative(root, real(source));
      if (!inside || inside.startsWith("..") || isAbsolute(inside)) continue;
      // `system` pins the PATH's own tool, which mise doesn't install.
      if (entry.version === "system") continue;
      const tool: MiseTool = {
        name,
        version: entry.version,
        source,
        bins: [],
      };
      if (entry.installed !== true) {
        missing.push(tool);
        continue;
      }
      const bins = ask("bin-paths", `${name}@${entry.version}`);
      if (bins.out === undefined)
        return {
          status: "failed",
          detail: `\`mise bin-paths ${name}@${entry.version}\` in ${checkout}: ${bins.error}`,
        };
      tool.bins = bins.out
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => isAbsolute(line));
      if (tool.bins.length) tools.push(tool);
      else missing.push(tool);
    }
  }
  return { status: "resolved", tools, missing };
}

/** The tools' directories first on `path`, each once. */
export function toolchainPath(
  path: string | undefined,
  tools: readonly MiseTool[],
): string {
  const bins = [...new Set(tools.flatMap((tool) => tool.bins))];
  const rest =
    path === undefined
      ? []
      : path.split(":").filter((entry) => !bins.includes(entry));
  return [...bins, ...rest].join(":");
}

/**
 * The fix for a host tool that doesn't match the checkout's pin, when mise
 * manages the checkout; undefined otherwise.
 */
export function misePinFix(checkout: string): string | undefined {
  return miseManages(checkout)
    ? `mise manages ${checkout}: bring it up to date with the default branch, run \`mise install\` there, then \`factory setup --background\`, so the service runs the new pin`
    : undefined;
}
