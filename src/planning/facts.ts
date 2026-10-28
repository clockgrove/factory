import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { parse } from "yaml";
import { gitEnvironment, lfsFiltered } from "../git.js";
import { TransientError } from "../github.js";
import { markdownLines } from "../markdown.js";
import { checkObjective, type SourceRef, validPath } from "../objective.js";
import type { ObjectiveBlock, ShownObjective } from "../shown.js";
import { errorMessage } from "../text.js";
import { skipsDispatchedRuns } from "./dispatch-guard.js";
import { HOST_VALIDATION_NETWORK, HOST_VALIDATION_SANDBOX } from "./rubric.js";
import type {
  CoverageObligation,
  PinnedSource,
  PlanningFacts,
} from "./types.js";

const run = promisify(execFile);

/**
 * The facts the planner is given, read once from the base with plain git:
 * pinned sources, the commands Factory accepts, CI-only commands, check
 * names, fixed scripts and coverage obligations. The plan checks use the
 * same functions, so what the planner is told is what passes.
 */

// ── Base reads ──────────────────────────────────────────────────────────

const GIT_TIMEOUT_MS = 60_000;

interface BaseEntry {
  mode: string;
  type: string;
  sha: string;
}

/**
 * Files of one base commit. A commit is immutable, so successful reads are
 * cached. A path the tree doesn't have is a fact (undefined); a git command
 * that fails is not: it throws a TransientError so the step retries, and
 * the failure is never cached.
 */
export class BaseFiles {
  private readonly blobs = new Map<string, Promise<Buffer>>();
  private tree?: Promise<Map<string, BaseEntry>>;

  constructor(
    readonly checkout: string,
    readonly base: string,
    readonly signal?: AbortSignal,
  ) {}

  /** A regular file's bytes at the base; undefined when it's missing or not a regular file. */
  async blob(path: string): Promise<Buffer | undefined> {
    if (!validPath(path)) return undefined;
    const entry = (await this.entries()).get(path);
    if (
      !entry ||
      entry.type !== "blob" ||
      (entry.mode !== "100644" && entry.mode !== "100755")
    )
      return undefined;
    let read = this.blobs.get(entry.sha);
    if (!read) {
      read = this.git(["cat-file", "blob", entry.sha]);
      this.blobs.set(entry.sha, read);
      read.catch(() => this.blobs.delete(entry.sha));
    }
    return read;
  }

  /** A file's UTF-8 text at the base; undefined when missing or not UTF-8. */
  async text(path: string): Promise<string | undefined> {
    const bytes = await this.blob(path);
    return bytes ? utf8(bytes) : undefined;
  }

  /** Every tracked file path at the base. */
  async paths(): Promise<string[]> {
    return [...(await this.entries()).keys()];
  }

  /** The root package.json object; empty when there is none or it isn't a JSON object. */
  async packageJson(): Promise<Record<string, unknown>> {
    const text = await this.text("package.json");
    if (text === undefined) return {};
    try {
      const parsed: unknown = JSON.parse(text);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }

  /** Root package.json scripts; empty when there are none. */
  async scripts(): Promise<Record<string, unknown>> {
    const { scripts } = await this.packageJson();
    return scripts && typeof scripts === "object"
      ? (scripts as Record<string, unknown>)
      : {};
  }

  /**
   * The paths the base's attributes route through Git LFS (`filter=lfs`).
   * `git check-attr --cached` reads them from a scratch index of the base
   * tree, so the checkout's own index and files play no part.
   */
  async lfsRouted(paths: readonly string[]): Promise<Set<string>> {
    if (!paths.length) return new Set();
    const scratch = await mkdtemp(join(tmpdir(), "factory-attributes-"));
    try {
      const index = { GIT_INDEX_FILE: join(scratch, "index") };
      await this.git(["read-tree", this.base], { env: index });
      return lfsFiltered(
        await this.git(
          ["check-attr", "--cached", "-z", "filter", "--", ...paths],
          { env: index },
        ),
      );
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }

  /** The base tree, read once; a failed read is retried on the next call. */
  private entries(): Promise<Map<string, BaseEntry>> {
    if (!this.tree) {
      const read = this.git(["ls-tree", "-rz", "--full-tree", this.base]).then(
        (out) => {
          const entries = new Map<string, BaseEntry>();
          for (const record of out.toString("utf8").split("\0")) {
            const tab = record.indexOf("\t");
            if (tab < 0) continue;
            const [mode, type, sha] = record.slice(0, tab).split(" ");
            entries.set(record.slice(tab + 1), {
              mode: mode!,
              type: type!,
              sha: sha!,
            });
          }
          return entries;
        },
      );
      this.tree = read;
      read.catch(() => {
        if (this.tree === read) this.tree = undefined;
      });
    }
    return this.tree;
  }

  /**
   * The default branch's name, as origin's HEAD names it (every fetch sets
   * it from the remote's HEAD); undefined when the checkout has none.
   */
  async defaultBranch(): Promise<string | undefined> {
    // --quiet: exit 1, silently, when origin/HEAD is missing or not symbolic.
    const name = (
      await this.git(
        ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
        { absentExit: 1 },
      )
    )
      .toString("utf8")
      .trim();
    return name.startsWith("origin/")
      ? name.slice("origin/".length)
      : undefined;
  }

  /** A git command's output; `absentExit` is the exit that means "none" and reads as no output. */
  private async git(
    args: string[],
    {
      env = {},
      absentExit,
    }: { env?: Record<string, string>; absentExit?: number } = {},
  ): Promise<Buffer> {
    try {
      const { stdout } = await run("git", ["-C", this.checkout, ...args], {
        encoding: "buffer",
        env: { ...gitEnvironment(), ...env },
        maxBuffer: 64 * 1024 * 1024,
        timeout: GIT_TIMEOUT_MS,
        ...(this.signal ? { signal: this.signal } : {}),
      });
      return stdout;
    } catch (error) {
      if (this.signal?.aborted) throw this.signal.reason;
      if (
        absentExit !== undefined &&
        (error as { code?: unknown }).code === absentExit
      )
        return Buffer.alloc(0);
      throw new TransientError(
        `git ${args[0]} at base ${this.base.slice(0, 12)} in ${this.checkout}: ${errorMessage(error)}`,
      );
    }
  }
}

function utf8(bytes: Buffer): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

// ── Objective ───────────────────────────────────────────────────────────

/** The Objective body as a pinned source. */
function objectiveSource(shown: ShownObjective): PinnedSource {
  return { path: "OBJECTIVE", content: shown.body };
}

/**
 * The plan's final commands: the installation's required commands, the
 * only commands Factory itself declares. The Objective's criteria, a
 * command among them, are the planner's to prove.
 */
export function finalCommands(required: readonly string[] = []): string[] {
  return [...new Set(required.map((command) => command.trim()))].filter(
    Boolean,
  );
}

/** Every Objective Acceptance criterion is one obligation, keyed by its index. */
function coverageObligations(
  blocks: readonly ObjectiveBlock[],
): CoverageObligation[] {
  return checkObjective(blocks).objective.acceptance.map(({ text }) => ({
    source: { path: "OBJECTIVE", text },
  }));
}

/**
 * One exact heading's section of a markdown file; undefined unless it
 * occurs once. An exact match wins; otherwise `*` and `_` count as one
 * emphasis marker (shown text writes emphasis with `_`), so `#Step _y_`
 * finds the heading `Step *y*`.
 */
export function sectionText(text: string, heading: string): string | undefined {
  const lines = markdownLines(text);
  const find = (same: (a: string) => boolean) =>
    lines.flatMap((line, index) =>
      line.heading !== undefined && same(line.heading.text)
        ? [{ index, level: line.heading.level }]
        : [],
    );
  // Exact first; the marker-folded match only when nothing matches exactly.
  const marked = (value: string) => value.replaceAll("*", "_");
  const exact = find((text) => text === heading);
  const matches = exact.length
    ? exact
    : find((text) => marked(text) === marked(heading));
  if (matches.length !== 1) return undefined;
  const { index, level } = matches[0]!;
  const end = lines.findIndex(
    (line, at) =>
      at > index && line.heading !== undefined && line.heading.level <= level,
  );
  return lines
    .slice(index, end < 0 ? undefined : end)
    .map((line) => line.text)
    .join("\n");
}

/**
 * The Objective, then AGENTS.md and README.md when the base has them, then
 * each pinned Source (whole file or one exact heading). A source that can't
 * be read is a problem that says how to fix the Sources entry.
 */
export async function planningSources(
  objective: ShownObjective,
  files: BaseFiles,
): Promise<{ sources: PinnedSource[]; problems: string[] }> {
  const sources: PinnedSource[] = [objectiveSource(objective)];
  const pinned = checkObjective(objective.blocks).objective.sources;
  const problems: string[] = [];
  const defaults: SourceRef[] = [];
  for (const path of ["AGENTS.md", "README.md"])
    if (await files.blob(path)) defaults.push({ path });
  const seen = new Set<string>();
  for (const ref of [...defaults, ...pinned]) {
    const identity = `${ref.path}#${ref.heading ?? ""}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    const entry = JSON.stringify(
      ref.heading === undefined ? ref.path : `${ref.path}#${ref.heading}`,
    );
    const fix = `Each Sources bullet is "- path" or "- path#Exact Heading" naming a tracked UTF-8 file at the base; put prose and links under Context.`;
    const bytes = await files.blob(ref.path);
    const text = bytes && utf8(bytes);
    if (text === undefined) {
      problems.push(
        `Sources entry ${entry}: ${bytes ? "isn't UTF-8 text" : "is missing"} at base ${files.base.slice(0, 12)}. ${fix}`,
      );
      continue;
    }
    const content = ref.heading ? sectionText(text, ref.heading) : text;
    if (content === undefined) {
      problems.push(
        `Sources entry ${entry}: ${ref.path} doesn't have exactly one heading named ${ref.heading}; select one exact heading. ${fix}`,
      );
      continue;
    }
    // A default is context unless the Objective also pins it.
    const isDefault =
      defaults.some((d) => d.path === ref.path && !ref.heading) &&
      !pinned.some((pin) => pin.path === ref.path && !pin.heading);
    sources.push({
      ...ref,
      content,
      ...(isDefault ? { context: true as const } : {}),
    });
  }
  return { sources, problems };
}

// ── Command shapes ──────────────────────────────────────────────────────

export const PINNED_PNPM_BOOTSTRAP =
  "pnpm install --frozen-lockfile --ignore-scripts";
export const PINNED_NPM_BOOTSTRAP = "npm ci --ignore-scripts";

/**
 * Factory's own lockfile resolution for each bootstrap (validate.ts): run
 * as the bootstrap's install runs, never as a validation command, when a
 * candidate's dependency change left its lockfile out of date. It writes
 * only the lockfile and runs no scripts.
 */
export const LOCKFILE_RESOLUTION = {
  pnpm: {
    command:
      "pnpm install --lockfile-only --no-frozen-lockfile --ignore-scripts",
    lockfile: "pnpm-lock.yaml",
  },
  npm: {
    command:
      "npm install --package-lock-only --ignore-scripts --no-audit --no-fund",
    lockfile: "package-lock.json",
  },
} as const;

/** Exact script-disabled root installs; this classification grants no authority. */
export function packageBootstrap(command: string): "npm" | "pnpm" | undefined {
  if (command.trim() === PINNED_NPM_BOOTSTRAP) return "npm";
  if (command.trim() === PINNED_PNPM_BOOTSTRAP) return "pnpm";
  return undefined;
}

/**
 * A version-only invocation may be followed by a shell
 * assertion. Every package-manager token must belong to that exact probe.
 */
export function packageManagerVersionProbe(command: string): boolean {
  if (!/\b(?:npm|pnpm)\b/.test(command)) return false;
  const withoutProbes = command.replace(
    /\b(?:npm|pnpm) --version(?=\s*(?:[;&|)\n]|$))/g,
    "",
  );
  return !/\b(?:npm|pnpm)\b/.test(withoutProbes);
}

/** The script forms {@link packageScriptInvocation} accepts, for messages. */
export const PACKAGE_SCRIPT_FORMS =
  "`npm test`, `pnpm test`, `pnpm check`, `npm run NAME` or `pnpm run NAME`, with no other arguments";

/** Supported root script forms; shell wrappers and package-manager flags are ambiguous. */
export function packageScriptInvocation(
  check: string,
): { manager: "npm" | "pnpm"; name: string } | undefined {
  const match = check
    .trim()
    .match(/^(npm|pnpm) (?:(run) )?([A-Za-z0-9][A-Za-z0-9:_-]*)$/);
  if (!match) return undefined;
  const manager = match[1] as "npm" | "pnpm";
  const name = match[3]!;
  if (manager === "npm" && !match[2] && name !== "test") return undefined;
  if (manager === "pnpm" && !match[2] && !["check", "test"].includes(name))
    return undefined;
  return { manager, name };
}

/**
 * A command that runs npm or pnpm and is none of {@link PACKAGE_SCRIPT_FORMS},
 * the script-disabled bootstrap or a version probe: validation can't keep
 * its script fixed and refuses it, so the plan check refuses it first.
 */
export function unpinnablePackageCommand(command: string): boolean {
  return (
    /\b(?:npm|pnpm)\b/.test(command) &&
    !packageBootstrap(command) &&
    !packageManagerVersionProbe(command) &&
    !packageScriptInvocation(command)
  );
}

export function normalizedCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

/** A command's identity for the CI-only list: every form of a root script is one command. */
export function ciOnlyKey(command: string): string {
  const normalized = normalizedCommand(command);
  const invocation = packageScriptInvocation(normalized);
  return invocation ? `script:${invocation.name}` : normalized;
}

/** The most commands a request or refusal lists; the rest are a count. */
const MAX_LISTED_COMMANDS = 20;

/** A bounded, exact list of commands for a request or refusal. */
export function listCommands(commands: readonly string[]): string {
  const shown = commands.slice(0, MAX_LISTED_COMMANDS).map((c) => `\`${c}\``);
  const more = commands.length - shown.length;
  return shown.length
    ? `${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""}`
    : "none declared";
}

// ── Network ─────────────────────────────────────────────────────────────

/**
 * How Factory validation differs from a hosted CI run, in the compact form the
 * planner receives. Keep this under ~1 KB.
 */
const VALIDATION_ENVIRONMENT = {
  // sandbox.network package-install; host and off replace it below.
  network:
    "none except the exact script-disabled package install, which runs first",
  refs: "remote-tracking branches may be stale; a Work Item's validation compares with $FACTORY_BASE_SHA, the commit its change was built on; integrated, QA and final commands run on the shared default branch, which holds other Objectives' merges, so they prove behaviour, never a diff: Factory enforces each item's owned paths",
  commit:
    "the uncommitted result: commands check working-tree files, never HEAD, the index or a commit of the result; a base-relative check compares the working tree with $FACTORY_BASE_SHA",
  ci: "no hosted CI jobs, logs or secrets",
  tests:
    "HOME and TMPDIR are private and empty, with no host credentials or user config",
  sandbox: "read-only host, private HOME and /tmp, no host sockets",
  lfs: "every Git LFS file holds its real bytes before any command runs, in Work Item, QA, integrated and final validation alike; Factory fetches missing objects outside the sandbox, so commands read content, never pointers, and need not reach a network for it",
  ifNeeded:
    "leave out any command needing more, and ask through decisionRequired",
} as const;

/** Validation's network under `sandbox.network: off`, as the planner and the graph reviewer read it. */
const OFF_VALIDATION_NETWORK =
  "none, the exact script-disabled package install included: it runs first, offline, from the package store";

/**
 * How a dependency change gets its lockfile: the planner's and the graph
 * reviewer's `lockfile` entry. Factory resolves one itself unless
 * `sandbox.network` is off (validate.ts).
 */
function lockfileNote(resolves: boolean): string {
  return resolves
    ? "a worker edits package.json dependencies and pnpm-workspace.yaml overrides/catalogs only, never the lockfile, and no one supplies one: when the install refuses the lockfile as out of date, Factory resolves it itself (pnpm install --lockfile-only or npm install --package-lock-only, scripts off, under the repository's registry and release-age policy) and commits it on the item's result; a requested version the registry has never published goes back to the worker to fix, while one the release-age policy or the registry refuses holds for the operator; other workspace settings, such as build approvals, stay the operator's"
    : "no worker or validation command can resolve a new lockfile, and with sandbox.network off neither can Factory: a change to package.json dependencies whose lockfile is out of date holds for the operator";
}

/** Tools that reach a network, by the first word of a shell command. */
const NETWORK_TOOLS = new Set([
  "curl",
  "wget",
  "gh",
  "pip",
  "pip3",
  "cargo-audit",
]);
/** Tools that reach a network only for some subcommands. */
const NETWORK_SUBCOMMANDS: Record<string, ReadonlySet<string>> = {
  tofu: new Set(["init", "plan", "apply", "get"]),
  terraform: new Set(["init", "plan", "apply", "get"]),
  npm: new Set(["audit", "install", "i", "ci", "publish", "view", "outdated"]),
  pnpm: new Set(["audit", "install", "i", "dlx", "fetch", "publish", "view"]),
  yarn: new Set(["audit", "install", "dlx", "npm"]),
  git: new Set(["fetch", "clone", "pull", "push", "ls-remote"]),
  docker: new Set(["pull", "push"]),
  go: new Set(["get", "install"]),
};

/**
 * The network tool a script body invokes, from its command words; never
 * prose. The authorized package bootstrap, the one command granted a
 * network, is not one.
 */
function networkToolIn(body: string): string | undefined {
  for (const segment of body.split(/&&|\|\||[;|\n&(){}`]|\$\(/)) {
    const words = segment
      .trim()
      .split(/\s+/)
      .filter((word) => word && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word));
    const tool = words[0]?.replace(/^.*\//, "");
    if (!tool || packageBootstrap(segment.trim()) !== undefined) continue;
    if (NETWORK_TOOLS.has(tool)) return tool;
    const subcommand = words.slice(1).find((word) => !word.startsWith("-"));
    if (subcommand && NETWORK_SUBCOMMANDS[tool]?.has(subcommand))
      return `${tool} ${subcommand}`;
  }
  return undefined;
}

/** The network tool a validation command reaches, directly or through root package scripts (to a fixed depth). */
export function networkToolOfCommand(
  command: string,
  scripts: Record<string, unknown>,
  depth = 0,
): string | undefined {
  const direct = networkToolIn(command);
  if (direct) return direct;
  const invocation = packageScriptInvocation(command);
  const body = invocation ? scripts[invocation.name] : undefined;
  if (typeof body !== "string" || depth > 3) return undefined;
  const own = networkToolIn(body);
  if (own) return own;
  for (const segment of body.split(/&&|\|\||[;|\n&]/))
    if (packageScriptInvocation(segment.trim())) {
      const nested = networkToolOfCommand(segment.trim(), scripts, depth + 1);
      if (nested) return nested;
    }
  return undefined;
}

// ── Scoped commands ─────────────────────────────────────────────────────

/**
 * The directory a root script works in: its body starts with `cd DIR &&` and
 * never changes directory again, or is one command naming DIR after --prefix,
 * --dir or -C. Any other shape is not derivable.
 */
function scriptScope(body: string): string | undefined {
  const dir = "(?:\\.\\/)?(\\w[\\w.-]*(?:\\/\\w[\\w.-]*)*)\\/?";
  const cd = body.match(new RegExp(`^\\s*cd\\s+${dir}\\s*&&(.*)$`, "s"));
  if (cd) return /\bcd\b/.test(cd[2]!) ? undefined : `${cd[1]}/`;
  if (/&&|\|\||[;|\n&]/.test(body)) return undefined;
  const flag = body.match(
    new RegExp(`\\s(?:--prefix|--dir|-C)[ =]${dir}(?:\\s|$)`),
  );
  return flag ? `${flag[1]}/` : undefined;
}

/** The directory a package-script command checks, when its script body names one. */
export function commandScope(
  command: string,
  scripts: Record<string, unknown>,
): string | undefined {
  const name = packageScriptInvocation(command)?.name;
  const body = name ? scripts[name] : undefined;
  return typeof body === "string" ? scriptScope(body) : undefined;
}

/** Each command that checks only one directory, with that directory. */
function scopedCommands(
  commands: readonly string[],
  scripts: Record<string, unknown>,
): Map<string, string> {
  const scoped = new Map<string, string>();
  for (const command of commands) {
    const scope = commandScope(command, scripts);
    if (scope) scoped.set(command, scope);
  }
  return scoped;
}

/**
 * The base `command` compares with, as it names it: `$FACTORY_BASE_SHA`, or
 * a SHA (7 to 40 hex digits) that `base` starts with. A command that names
 * one is base-relative: it checks the change built on that base, so it
 * holds for its own Work Item's tree, never for the shared default branch.
 */
export function namedBase(command: string, base: string): string | undefined {
  return /\bFACTORY_BASE_SHA\b/.test(command)
    ? "$FACTORY_BASE_SHA"
    : command
        .match(/\b[0-9a-f]{7,40}\b/gi)
        ?.find((token) => base.startsWith(token.toLowerCase()));
}

// ── Package commands ────────────────────────────────────────────────────

/**
 * The root package scripts at the base in the forms validation runs (test
 * and check first), less CI-only and network ones: facts for the planner.
 * A command the plan writes without npm or pnpm runs as written.
 */
async function packageCommands(
  files: BaseFiles,
  ciOnlyCommands: readonly string[] = [],
): Promise<string[]> {
  const ciOnly = new Set(ciOnlyCommands.map(ciOnlyKey));
  const scripts = await files.scripts();
  const names = Object.keys(scripts).sort(
    (a, b) =>
      Number(b === "test" || b === "check") -
      Number(a === "test" || a === "check"),
  );
  const commands: string[] = [];
  for (const name of names) {
    if (typeof scripts[name] !== "string") continue;
    const form = name === "test" ? "npm test" : `npm run ${name}`;
    // A CI-only script is CI-only in every form.
    const forms =
      name === "test"
        ? ["npm test", "pnpm test", "npm run test", "pnpm run test"]
        : [
            `npm run ${name}`,
            `pnpm run ${name}`,
            ...(name === "check" ? ["pnpm check"] : []),
          ];
    if (forms.some((f) => ciOnly.has(ciOnlyKey(f)))) continue;
    if (networkToolOfCommand(form, scripts)) continue;
    commands.push(form);
  }
  return commands;
}

// ── Planner instructions ────────────────────────────────────────────────

/**
 * The validation environment the planner and the graph reviewer are given:
 * with `lockfileResolution`, Factory resolves an out-of-date lockfile itself.
 * `lockfileResolution` is set exactly when `sandbox.network` isn't off
 * (steps.ts `planningFacts`), so without it or `hostNetwork` the network is
 * off and even the install runs offline (validate.ts).
 */
export function validationEnvironmentNote(
  hostNetwork: boolean,
  lockfileResolution: boolean,
): string {
  const environment = {
    ...VALIDATION_ENVIRONMENT,
    ...(hostNetwork
      ? { network: HOST_VALIDATION_NETWORK, sandbox: HOST_VALIDATION_SANDBOX }
      : lockfileResolution
        ? {}
        : { network: OFF_VALIDATION_NETWORK }),
    lockfile: lockfileNote(lockfileResolution),
  };
  return `Validation environment (differs from hosted CI): ${JSON.stringify(environment)}`;
}

/**
 * The planner's note on the installation's CI-only commands, after the
 * environment note. Under host, validation is not offline, so the note gives
 * only the operator's rule: these run in CI alone.
 */
function ciOnlyInstructions(
  ciOnlyCommands: readonly string[],
  hostNetwork: boolean,
  lockfileResolution: boolean,
): string {
  return (
    `\n\n${validationEnvironmentNote(hostNetwork, lockfileResolution)}` +
    (ciOnlyCommands.length
      ? `\n\n${hostNetwork ? "The installation runs these commands only in CI" : "These commands need network and run only in CI; validation runs offline"}, so never use one as a validation command: ${JSON.stringify(ciOnlyCommands)}. When a criterion can only be proved by one of them, leave it out and ask through decisionRequired.`
      : "")
  );
}

/** The planner's note of the root package scripts at the base. */
function packageCommandInstructions(
  commands: readonly string[],
  scopes: ReadonlyMap<string, string> = new Map(),
): string {
  const scoped = commands.flatMap((command) =>
    scopes.has(command) ? [`\`${command}\` (${scopes.get(command)})`] : [],
  );
  return `\n\nRoot package scripts at the base (pnpm forms work too): ${commands.length ? listCommands(commands) : "none"}. Write each validation command yourself. Besides the script-disabled install, one that runs npm or pnpm must be exactly ${PACKAGE_SCRIPT_FORMS} (no \`--\`, no flags), since validation keeps that script fixed; a command without npm or pnpm runs as written.${scoped.length ? `\nThese check only one directory; use one only for a work item that owns a path in it: ${scoped.join(", ")}.` : ""}`;
}

/** The CI-only and package-script notes for the planner request, in that order. */
export async function commandInstructions(
  facts: PlanningFacts,
  checkout: string,
  signal?: AbortSignal,
): Promise<string> {
  const scripts = await new BaseFiles(checkout, facts.base, signal).scripts();
  return (
    ciOnlyInstructions(
      facts.ciOnlyCommands,
      facts.hostNetwork === true,
      facts.lockfileResolution === true,
    ) +
    packageCommandInstructions(
      facts.packageCommands,
      scopedCommands(facts.packageCommands, scripts),
    )
  );
}

// ── Fixed scripts ───────────────────────────────────────────────────────

/** Names of the package scripts (and their pre/post hooks) validation keeps identical to the base. */
function fixedPackageScripts(commands: readonly string[]): string[] {
  const names = new Set<string>();
  for (const command of commands) {
    if (
      !/\b(?:npm|pnpm)\b/.test(command) ||
      packageBootstrap(command) ||
      packageManagerVersionProbe(command)
    )
      continue;
    const invocation = packageScriptInvocation(command);
    if (invocation)
      for (const name of [
        invocation.name,
        `pre${invocation.name}`,
        `post${invocation.name}`,
      ])
        names.add(name);
  }
  return [...names];
}

/**
 * The package scripts `commands` run, as the base's root package.json
 * defines them. Validation keeps these bodies fixed, so the
 * planner needs them to own the files a new check has to extend (#819).
 */
export async function fixedScripts(
  commands: readonly string[],
  files: BaseFiles,
): Promise<{ name: string; body: string }[]> {
  const names = fixedPackageScripts(commands);
  if (!names.length) return [];
  const scripts = await files.scripts();
  return names.flatMap((name) =>
    typeof scripts[name] === "string"
      ? [{ name, body: scripts[name] as string }]
      : [],
  );
}

// ── CI check names ──────────────────────────────────────────────────────

const WORKFLOWS = ".github/workflows";
const MAX_MATRIX_NAMES = 256;
const PULL_REQUEST_EVENTS = [
  "pull_request",
  "pull_request_target",
  "merge_group",
];

type Job = { name?: unknown; uses?: unknown; strategy?: { matrix?: unknown } };

/** Event names from the string, list or map form of `on`. */
function events(on: unknown): string[] {
  if (typeof on === "string") return [on];
  if (Array.isArray(on))
    return on.filter((event): event is string => typeof event === "string");
  if (on && typeof on === "object") return Object.keys(on);
  return [];
}

/**
 * Value lists of each combination of a matrix whose axes are all plain
 * scalar lists, in axis order. Undefined for a matrix Factory can't expand
 * from structure alone: an expression, include or exclude, or object values.
 */
function matrixValues(matrix: unknown): string[][] | undefined {
  if (!matrix || typeof matrix !== "object" || Array.isArray(matrix)) return;
  const axes = Object.entries(matrix);
  if (
    !axes.length ||
    axes.some(
      ([key, values]) =>
        key === "include" ||
        key === "exclude" ||
        !Array.isArray(values) ||
        !values.length ||
        values.some(
          (value) =>
            !["string", "number", "boolean"].includes(typeof value) ||
            String(value).includes("${{"),
        ),
    ) ||
    axes.reduce(
      (count, [, values]) => count * (values as unknown[]).length,
      1,
    ) > MAX_MATRIX_NAMES
  )
    return;
  return axes.reduce<string[][]>(
    (combinations, [, values]) =>
      combinations.flatMap((combination) =>
        (values as unknown[]).map((value) => [...combination, String(value)]),
      ),
    [[]],
  );
}

/** Check-run names one job reports: its name (or id), or "name (a, b)" per matrix combination. */
function jobNames(id: string, job: Job): string[] {
  const name = typeof job.name === "string" ? job.name : id;
  if (name.includes("${{")) return [];
  if (job.strategy?.matrix === undefined) return [name];
  return (matrixValues(job.strategy.matrix) ?? []).map(
    (values) => `${name} (${values.join(", ")})`,
  );
}

function jobsOf(workflow: unknown): [string, Job][] {
  const jobs = (workflow as { jobs?: unknown } | null)?.jobs;
  if (!jobs || typeof jobs !== "object" || Array.isArray(jobs)) return [];
  return Object.entries(jobs).map(([id, job]) => [id, (job ?? {}) as Job]);
}

/**
 * Whether a workflow's `on` runs it on a push to `branch`: a bare push
 * event, or a push whose branch filters select it (GitHub's filter
 * patterns, `!` excluding, the last match deciding). A push filtered only
 * by tags never runs for a branch; with no known branch, only an
 * unfiltered push counts.
 */
function pushesTo(on: unknown, branch: string | undefined): boolean {
  if (!events(on).includes("push")) return false;
  const push =
    on && typeof on === "object" && !Array.isArray(on)
      ? (on as Record<string, unknown>).push
      : undefined;
  if (!push || typeof push !== "object") return true;
  const filter = push as Record<string, unknown>;
  const list = (key: string) =>
    Array.isArray(filter[key])
      ? (filter[key] as unknown[]).filter(
          (pattern): pattern is string => typeof pattern === "string",
        )
      : undefined;
  const branches = list("branches");
  const ignored = list("branches-ignore");
  if (!branches && !ignored) return !list("tags") && !list("tags-ignore");
  if (branch === undefined) return false;
  const matches = (pattern: string) =>
    new RegExp(
      `^${pattern
        .replace(/[.^${}()|\\]/g, "\\$&")
        .replace(/\*\*|\*/g, (star) => (star === "**" ? ".*" : "[^/]*"))}$`,
    ).test(branch);
  if (ignored) return !ignored.some(matches);
  let selected = false;
  for (const pattern of branches!)
    if (pattern.startsWith("!")) {
      if (matches(pattern.slice(1))) selected = false;
    } else if (matches(pattern)) selected = true;
  return selected;
}

/**
 * The check-run names GitHub reports on a pull request for the Actions
 * workflows at the base, read from their YAML structure. Only workflows in
 * the top level of .github/workflows triggered by pull_request,
 * pull_request_target or merge_group count. A job reports its name (or id),
 * a matrix job "name (a, b)" per combination, and a job that calls a local
 * reusable workflow "caller / callee" per called job. A workflow that can't
 * be read or parsed reports nothing.
 */
export function workflowCheckNames(files: BaseFiles): Promise<string[]> {
  return checkNamesOf(files, (on) =>
    events(on).some((event) => PULL_REQUEST_EVENTS.includes(event)),
  );
}

/**
 * The check-run names GitHub reports on a commit pushed to the default
 * branch `branch`: the jobs of workflows that `on: push` runs there. These
 * are the only names an integrated-ci proof can observe on the
 * default-branch head.
 */
export function pushCheckNames(
  files: BaseFiles,
  branch: string | undefined,
): Promise<string[]> {
  return checkNamesOf(files, (on) => pushesTo(on, branch));
}

/**
 * What the base says of the operator's delivery.baseRerun workflow
 * `workflow` (a file name in .github/workflows), for readiness: why GitHub
 * would refuse to dispatch it (missing, unparsable, no `workflow_dispatch`,
 * or an input it requires with no default), the check-run names it
 * reports, and the workflows that run after it (`on: workflow_run` naming
 * its name), which a dispatch of it starts too, and the workflows that run
 * after those in turn: `followers`, or `guarded` when every job of one
 * skips every run that a dispatch started (dispatch-guard.ts
 * `skipsDispatchedRuns`).
 */
export async function baseRerunWorkflow(
  files: BaseFiles,
  workflow: string,
): Promise<{
  problem?: string;
  checks: string[];
  followers: string[];
  guarded: string[];
}> {
  const path = `${WORKFLOWS}/${workflow}`;
  const none = { checks: [], followers: [], guarded: [] };
  const text = await files.text(path);
  if (text === undefined) return { problem: `there is no ${path}`, ...none };
  let parsed: unknown;
  try {
    parsed = parse(text);
  } catch {
    return { problem: `${path} can't be parsed`, ...none };
  }
  const on = (parsed as { on?: unknown } | null)?.on;
  if (!events(on).includes("workflow_dispatch"))
    return {
      problem: `${path} doesn't run on workflow_dispatch`,
      ...none,
    };
  const dispatch =
    on && typeof on === "object" && !Array.isArray(on)
      ? (on as Record<string, unknown>).workflow_dispatch
      : undefined;
  const inputs =
    dispatch && typeof dispatch === "object" && !Array.isArray(dispatch)
      ? (dispatch as { inputs?: unknown }).inputs
      : undefined;
  const required =
    inputs && typeof inputs === "object" && !Array.isArray(inputs)
      ? Object.entries(inputs as Record<string, unknown>)
          .filter(
            ([, input]) =>
              (input as { required?: unknown } | null)?.required === true &&
              (input as { default?: unknown }).default === undefined,
          )
          .map(([name]) => name)
      : [];
  if (required.length)
    return {
      problem: `${path} requires the input${required.length === 1 ? "" : "s"} ${required.join(", ")} with no default, and Factory dispatches it with none`,
      ...none,
    };
  const others = new Map<string, unknown>();
  for (const other of await workflowPaths(files)) {
    if (other === path) continue;
    try {
      others.set(other, parse((await files.text(other)) ?? ""));
    } catch {
      continue;
    }
  }
  // GitHub names a workflow without `name` by its path.
  const nameOf = (file: string, workflow: unknown) => {
    const value = (workflow as { name?: unknown } | null)?.name;
    return typeof value === "string" ? value : file;
  };
  const name = nameOf(path, parsed);
  // A dispatch starts each follower (`workflow_dispatch` the event of the
  // run it follows), and each completed run of a follower, even one whose
  // every job was skipped, starts that one's followers in turn (the event
  // then `workflow_run`). A workflow that runs for any of them is a
  // follower; one skipped for every one of them is guarded.
  const runs = new Set<string>();
  const skipped = new Set<string>();
  const queue = [{ file: path, name, event: "workflow_dispatch" }];
  const seen = new Set<string>();
  for (let at = queue.shift(); at; at = queue.shift()) {
    for (const [other, follower] of others) {
      const after = (follower as { on?: unknown } | null)?.on;
      const run =
        after && typeof after === "object" && !Array.isArray(after)
          ? (after as Record<string, unknown>).workflow_run
          : undefined;
      const followed =
        run && typeof run === "object" && !Array.isArray(run)
          ? (run as { workflows?: unknown }).workflows
          : undefined;
      if (
        !(Array.isArray(followed) ? followed : [followed]).some(
          (entry) => entry === at.name || entry === at.file,
        )
      )
        continue;
      const key = `${other}\n${at.event}`;
      if (seen.has(key)) continue;
      seen.add(key);
      (skipsDispatchedRuns(follower, at.event) ? skipped : runs).add(other);
      queue.push({
        file: other,
        name: nameOf(other, follower),
        event: "workflow_run",
      });
    }
  }
  return {
    checks: await checkNamesOf(files, () => true, path),
    followers: [...others.keys()].filter((other) => runs.has(other)),
    guarded: [...others.keys()].filter(
      (other) => skipped.has(other) && !runs.has(other),
    ),
  };
}

/** The workflow files in the top level of the base's .github/workflows. */
async function workflowPaths(files: BaseFiles): Promise<string[]> {
  return (await files.paths()).filter((path) =>
    new RegExp(`^${WORKFLOWS}/[^/]+\\.ya?ml$`).test(path),
  );
}

/**
 * The check-run names each workflow file at the commit reports, whatever
 * triggers it, keyed by its path (".github/workflows/quality.yml", as a
 * workflow run's `path` names it). Every job counts, a job with `needs:`
 * too: GitHub creates its check run only once the jobs it needs end, so a
 * run of the workflow under way may report it later (delivery.ts
 * `reportingRuns`, #2157).
 */
export function workflowFileCheckNames(
  files: BaseFiles,
): Promise<Map<string, string[]>> {
  return checkNamesByFile(files, () => true);
}

/**
 * The check-run names of the base's workflows whose `on` passes
 * `triggered`, or of workflow file `only` alone.
 */
async function checkNamesOf(
  files: BaseFiles,
  triggered: (on: unknown) => boolean,
  only?: string,
): Promise<string[]> {
  const names = new Set<string>();
  for (const listed of (
    await checkNamesByFile(files, triggered, only)
  ).values())
    for (const name of listed) names.add(name);
  return [...names].sort();
}

/** `checkNamesOf`, per workflow file that reports any. */
async function checkNamesByFile(
  files: BaseFiles,
  triggered: (on: unknown) => boolean,
  only?: string,
): Promise<Map<string, string[]>> {
  const paths = await workflowPaths(files);
  const parsed = new Map<string, unknown>();
  for (const path of paths) {
    // A git failure throws (the step retries); only a parse failure is skipped.
    const text = (await files.text(path)) ?? "";
    try {
      parsed.set(path, parse(text));
    } catch {
      // GitHub can't run a workflow it can't parse; it reports no checks.
    }
  }
  const byFile = new Map<string, string[]>();
  for (const path of paths) {
    if (only !== undefined && path !== only) continue;
    const workflow = parsed.get(path);
    if (!triggered((workflow as { on?: unknown } | null)?.on)) continue;
    const names = new Set<string>();
    for (const [id, job] of jobsOf(workflow)) {
      if (job.uses === undefined) {
        for (const name of jobNames(id, job)) names.add(name);
        continue;
      }
      const called =
        typeof job.uses === "string" &&
        job.uses.match(/^\.\/(\.github\/workflows\/[^/@]+\.ya?ml)$/)?.[1];
      if (
        !called ||
        job.strategy?.matrix !== undefined ||
        !paths.includes(called)
      )
        continue;
      const caller = typeof job.name === "string" ? job.name : id;
      if (caller.includes("${{")) continue;
      for (const [calleeId, callee] of jobsOf(parsed.get(called)))
        if (callee.uses === undefined)
          for (const name of jobNames(calleeId, callee))
            names.add(`${caller} / ${name}`);
    }
    if (names.size) byFile.set(path, [...names].sort());
  }
  return byFile;
}

/** The names in `names` that no known source defines. */
export function unknownCheckNames(names: string[], known: string[]): string[] {
  const defined = new Set(known);
  return [...new Set(names)].filter((name) => !defined.has(name));
}

/** The refusal for a CI check name that isn't a job in the base workflows. */
export function unknownCheckMessage(name: string, known: string[]): string {
  return `CI check ${JSON.stringify(name)} is not a job in the base's GitHub workflows; use one of those exact names: ${JSON.stringify(known.slice(0, 20))}${known.length > 20 ? ` and ${known.length - 20} more` : ""}`;
}

// ── Entry points ────────────────────────────────────────────────────────
export interface FactsArgs {
  objective: number;
  /** The Objective as shown: its structure and the planner text. */
  shown: ShownObjective;
  base: string;
  checkout: string;
  /** The installation's required final commands; their scripts stay fixed. */
  requiredCommands?: readonly string[];
  /** The installation's CI-only commands: never a validation command. */
  ciOnlyCommands?: readonly string[];
  /** `sandbox.network: host`: validation reaches the host's network. */
  hostNetwork?: boolean;
  /** `sandbox.network` isn't off: Factory resolves an out-of-date lockfile itself. */
  lockfileResolution?: boolean;
  /** The approved playbook text. */
  playbook?: string;
  /** The operator's media.localAssetRoots. */
  localAssetRoots?: readonly string[];
  signal?: AbortSignal;
}

/** The most base Git LFS rules the planner is shown. */
const MAX_LFS_RULES = 50;

/**
 * The base's `.gitattributes` lines that route paths through Git LFS, each
 * as `file: line`: what the media plan check's routing reads.
 */
async function lfsRules(files: BaseFiles): Promise<string[]> {
  const rules: string[] = [];
  for (const path of await files.paths())
    if (path === ".gitattributes" || path.endsWith("/.gitattributes"))
      for (const line of ((await files.text(path)) ?? "").split("\n"))
        if (line.trim().split(/\s+/).slice(1).includes("filter=lfs"))
          rules.push(`${path}: ${line.trim()}`);
  return rules.slice(0, MAX_LFS_RULES);
}

/**
 * Everything the planner is given, computed once from the base. The check
 * step has already run {@link objectiveCommandProblems} on this body and
 * base, so Sources that don't resolve here are returned as `problems`:
 * only an Objective edit fixes them, so the step holds with `replan` and
 * `cancel` (a `retry` would re-read the same body). A git read failure
 * throws a TransientError, which the step retries.
 */
export async function buildFacts(
  args: FactsArgs,
): Promise<{ facts: PlanningFacts } | { problems: string[] }> {
  const files = new BaseFiles(args.checkout, args.base, args.signal);
  const { sources, problems } = await planningSources(args.shown, files);
  if (problems.length) return { problems };
  const ciOnlyCommands = [...(args.ciOnlyCommands ?? [])];
  const facts: PlanningFacts = {
    objective: args.objective,
    body: args.shown.body,
    blocks: args.shown.blocks,
    base: args.base,
    sources,
    packageCommands: await packageCommands(files, ciOnlyCommands),
    ciOnlyCommands,
    ...(args.hostNetwork ? { hostNetwork: true as const } : {}),
    ...(args.lockfileResolution ? { lockfileResolution: true as const } : {}),
    checkNames: await workflowCheckNames(files),
    integratedCheckNames: await pushCheckNames(
      files,
      await files.defaultBranch(),
    ),
    // Every existing root script a validation command runs keeps its base
    // body, so the planner sees each one it may run.
    fixedScripts: await fixedScripts(
      [
        ...finalCommands(args.requiredCommands),
        ...(await packageCommands(files)),
      ],
      files,
    ),
    coverageObligations: coverageObligations(args.shown.blocks),
    playbook: args.playbook ?? "",
    localAssetRoots: args.localAssetRoots ?? [],
    lfsRules: await lfsRules(files),
  };
  return { facts };
}

/**
 * The Objective's source and command problems at queue time; each says how
 * to fix it. Empty means planning can start: every pinned Source reads as
 * UTF-8 at the base, and each installation-required command that runs a
 * package script uses a supported form, so its script stays fixed.
 */
export async function objectiveCommandProblems(
  shown: ShownObjective,
  base: string,
  checkout: string,
  options: {
    requiredCommands?: readonly string[];
    signal?: AbortSignal;
  } = {},
): Promise<string[]> {
  const files = new BaseFiles(checkout, base, options.signal);
  const { problems } = await planningSources(shown, files);
  for (const command of finalCommands(options.requiredCommands))
    if (unpinnablePackageCommand(command))
      problems.push(
        `Required final-validation command ${command} runs npm or pnpm outside ${PACKAGE_SCRIPT_FORMS}, so its script can't be kept fixed; correct it in the installation's finalValidation.requiredCommands.`,
      );
  return problems;
}
