import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parse } from "yaml";
import { gitEnvironment } from "../git.js";
import { TransientError } from "../github.js";
import { markdownLines } from "../markdown.js";
import {
  checkObjective,
  objectiveText,
  type SourceRef,
  validPath,
} from "../objective.js";
import type { ObjectiveBlock, ShownObjective } from "../shown.js";
import { errorMessage } from "../text.js";
import type {
  CoverageObligation,
  PinnedSource,
  PlanningFacts,
  ValidationCommand,
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
   * The default branch's name, as origin's HEAD names it (every fetch of
   * the default head sets it); undefined when the checkout has none.
   */
  async defaultBranch(): Promise<string | undefined> {
    try {
      const name = (
        await this.git([
          "symbolic-ref",
          "--quiet",
          "--short",
          "refs/remotes/origin/HEAD",
        ])
      )
        .toString("utf8")
        .trim();
      return name.startsWith("origin/")
        ? name.slice("origin/".length)
        : undefined;
    } catch (error) {
      if (this.signal?.aborted) throw error;
      return undefined;
    }
  }

  private async git(args: string[]): Promise<Buffer> {
    try {
      const { stdout } = await run("git", ["-C", this.checkout, ...args], {
        encoding: "buffer",
        env: gitEnvironment(),
        maxBuffer: 64 * 1024 * 1024,
        timeout: GIT_TIMEOUT_MS,
        ...(this.signal ? { signal: this.signal } : {}),
      });
      return stdout;
    } catch (error) {
      if (this.signal?.aborted) throw this.signal.reason;
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

/**
 * A Factory-created child Objective carries its parent's model-written goal.
 * Read from the raw issue body by the marker's exact pattern, as structure;
 * the marker is never planning text.
 */
export function childIdentity(raw: string): boolean {
  return /^<!-- factory:parent=[1-9][0-9]*;child=[a-z][a-z0-9-]{0,63} -->\r?\n/.test(
    raw,
  );
}

/**
 * The Objective body as a pinned source. A split child's body carries the
 * model-written goal, so it isn't operator-authored.
 */
function objectiveSource(shown: ShownObjective, child: boolean): PinnedSource {
  return {
    path: "OBJECTIVE",
    content: shown.body,
    shown: {
      lines: objectiveText(shown.blocks).split("\n"),
      spans: shown.spans,
    },
    ...(!child && { operatorAuthored: true as const }),
  };
}

/**
 * Commands the integrated result must pass: the Acceptance list items that
 * are exactly one code element. Any other criterion is a fact for review.
 */
function finalObjectiveCommands(blocks: readonly ObjectiveBlock[]): string[] {
  return checkObjective(blocks).objective.acceptance.flatMap((criterion) =>
    criterion.command ? [criterion.command] : [],
  );
}

/**
 * An Objective's final commands: its own Acceptance commands, then each
 * installation-required command it doesn't already run. Planning, plan
 * review and final validation all use this one list.
 */
export function finalCommands(
  blocks: readonly ObjectiveBlock[],
  required: readonly string[] = [],
): string[] {
  const own = finalObjectiveCommands(blocks);
  return [...own, ...required.filter((command) => !own.includes(command))];
}

/** Every Objective Acceptance criterion is one obligation, keyed by its index. */
function coverageObligations(
  blocks: readonly ObjectiveBlock[],
): CoverageObligation[] {
  return checkObjective(blocks).objective.acceptance.map(
    ({ text, command }) => ({
      source: { path: "OBJECTIVE", text, ...(command ? { command } : {}) },
    }),
  );
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
  child = false,
): Promise<{ sources: PinnedSource[]; problems: string[] }> {
  const sources: PinnedSource[] = [objectiveSource(objective, child)];
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

/** Exact script-disabled root installs; this classification grants no authority. */
export function packageBootstrap(command: string): "npm" | "pnpm" | undefined {
  if (command.trim() === PINNED_NPM_BOOTSTRAP) return "npm";
  if (command.trim() === PINNED_PNPM_BOOTSTRAP) return "pnpm";
  return undefined;
}

/**
 * A version-only invocation may be followed by a source-declared shell
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
const PACKAGE_SCRIPT_FORMS =
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

export function normalizedCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

/** A command's identity for the CI-only list: every form of a root script is one command. */
export function ciOnlyKey(command: string): string {
  const normalized = normalizedCommand(command);
  const invocation = packageScriptInvocation(normalized);
  return invocation ? `script:${invocation.name}` : normalized;
}

/** A leading executable word, no assignment, braces or statement separators. */
const COMMAND_SHAPE = /^[a-z][\w.-]*(?: [^{}$;|&<>]*)?$/;

/**
 * Inline code spans outside fenced code: the Objective's shown code
 * elements, a repository file's backticked spans.
 */
function inlineSpans(
  source: Pick<PinnedSource, "content" | "shown">,
): string[] {
  if (source.shown) return source.shown.spans.map((span) => span.trim());
  return markdownLines(source.content).flatMap(({ text, fenced }) =>
    fenced ? [] : [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]!.trim()),
  );
}

function inlineCommand(source: PinnedSource, command: string): boolean {
  if (!COMMAND_SHAPE.test(command) && !packageManagerVersionProbe(command))
    return false;
  return inlineSpans(source).includes(command);
}

function exactLine(lines: readonly string[], command: string): boolean {
  // Only a command-shaped line is authority; doc code never is.
  if (!COMMAND_SHAPE.test(command) && !packageManagerVersionProbe(command))
    return false;
  return lines.some((line) => {
    const text = line
      .trim()
      .replace(/^[-*]\s+/, "")
      .trim();
    return text === command || text === `\`${command}\``;
  });
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
 * planner receives. Keep this under ~800 bytes.
 */
const VALIDATION_ENVIRONMENT = {
  network:
    "none except the exact script-disabled package install, which runs first",
  refs: "remote-tracking branches may be stale; compare with $FACTORY_BASE_SHA",
  ci: "no hosted CI jobs, logs or secrets",
  tests:
    "HOME and TMPDIR are private and empty, with no host credentials or user config",
  sandbox: "read-only host, private HOME and /tmp, no host sockets",
  ifNeeded:
    "leave out any command needing more, and ask through decisionRequired",
} as const;

/** Tools that reach a network, by the first word of a shell command. */
const NETWORK_TOOLS = new Set([
  "curl",
  "wget",
  "npx",
  "pnpx",
  "bunx",
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
  docker: new Set(["pull", "push", "build"]),
  go: new Set(["get", "install"]),
};

/** The network tool a script body invokes, from its command words; never prose. */
function networkToolIn(
  body: string,
  /** A segment known to run offline (the authorized bootstrap or a local bin). */
  skip?: (segment: string) => boolean,
): string | undefined {
  for (const segment of body.split(/&&|\|\||[;|\n&(){}`]|\$\(/)) {
    const words = segment
      .trim()
      .split(/\s+/)
      .filter((word) => word && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word));
    const tool = words[0]?.replace(/^.*\//, "");
    if (!tool || skip?.(segment.trim())) continue;
    if (NETWORK_TOOLS.has(tool)) return tool;
    const subcommand = words.slice(1).find((word) => !word.startsWith("-"));
    if (subcommand && NETWORK_SUBCOMMANDS[tool]?.has(subcommand))
      return `${tool} ${subcommand}`;
  }
  return undefined;
}

/**
 * Segments that run offline: the authorized package bootstrap (the one
 * command granted a network) and npx/pnpx/bunx, which run a local bin.
 */
function offlineSegment(segment: string): boolean {
  if (packageBootstrap(segment) !== undefined) return true;
  const first = segment
    .split(/\s+/)
    .find((word) => word && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word));
  return first !== undefined && /^(?:npx|pnpx|bunx)$/.test(first);
}

/** The network tool a validation command reaches, directly or through root package scripts (to a fixed depth). */
export function networkToolOfCommand(
  command: string,
  scripts: Record<string, unknown>,
  depth = 0,
): string | undefined {
  const direct = networkToolIn(command, offlineSegment);
  if (direct) return direct;
  const invocation = packageScriptInvocation(command);
  const body = invocation ? scripts[invocation.name] : undefined;
  if (typeof body !== "string" || depth > 3) return undefined;
  const own = networkToolIn(body, offlineSegment);
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

// ── Command authority ───────────────────────────────────────────────────

/**
 * The command-authority rule. A validation command is authorized when it is:
 * a supported root package-script form whose script exists at the base
 * (base-observed), or an exact command-shaped line in the pinned source it
 * names (source-declared). In the operator-written Objective body an inline
 * backticked span also counts. Fenced code never counts. Commands an
 * operator answer authorized (`operator`) always pass.
 */
async function authorizedCommand(
  check: ValidationCommand,
  files: BaseFiles,
  sources: readonly PinnedSource[],
  operator: readonly string[] = [],
): Promise<boolean> {
  if (!check.command.trim()) return false;
  if (
    operator.map(normalizedCommand).includes(normalizedCommand(check.command))
  )
    return true;
  if (!check.source) return false;
  const packageCommand = /\b(?:npm|pnpm)\b/.test(check.command);
  const bootstrap = packageBootstrap(check.command) !== undefined;
  const invocation =
    packageCommand && !bootstrap
      ? packageScriptInvocation(check.command)
      : undefined;
  if (packageCommand) {
    if (bootstrap) {
      if (check.provenance !== "source-declared") return false;
    } else if (!packageManagerVersionProbe(check.command)) {
      if (!invocation) return false;
      if (
        check.provenance === "base-observed" &&
        typeof (await files.scripts())[invocation.name] !== "string"
      )
        return false;
    }
  }
  if (check.provenance === "source-declared")
    return sources.some(
      (source) =>
        source.path === check.source &&
        (exactLine(
          source.shown?.lines ?? source.content.split("\n"),
          check.command,
        ) ||
          // An operator-authored Objective body may declare a backticked
          // command in its prose. Repository docs and split-child bodies
          // (which carry a model-written goal) keep the own-line rule.
          (source.operatorAuthored === true &&
            inlineCommand(source, check.command))),
    );
  if (
    check.provenance !== "base-observed" ||
    !/^[A-Za-z0-9_./-]+$/.test(check.source) ||
    check.source.split("/").includes("..")
  )
    return false;
  const content = await files.text(check.source);
  if (content === undefined) return false;
  if (exactLine(content.split("\n"), check.command)) return true;
  return check.source === "package.json" && Boolean(invocation);
}

/**
 * The validation commands the command-authority check accepts at the base:
 * operator-authorized commands, root package scripts in the supported forms
 * (test and check first), then inline source-declared commands in the
 * pinned sources. CI-only and network commands are left out because
 * validation refuses those.
 */
async function authorizedCommands(
  sources: readonly PinnedSource[],
  files: BaseFiles,
  ciOnlyCommands: readonly string[] = [],
  operator: readonly string[] = [],
): Promise<string[]> {
  const ciOnly = new Set(ciOnlyCommands.map(ciOnlyKey));
  const scripts = await files.scripts();
  const accepted = new Set<string>();
  const usable = (command: string) =>
    !ciOnly.has(ciOnlyKey(command)) && !networkToolOfCommand(command, scripts);
  for (const command of operator)
    if (command.trim() && !ciOnly.has(ciOnlyKey(command)))
      accepted.add(normalizedCommand(command));
  const names = Object.keys(scripts).sort(
    (a, b) =>
      Number(b === "test" || b === "check") -
      Number(a === "test" || a === "check"),
  );
  for (const name of names) {
    const forms =
      name === "test"
        ? ["npm test", "pnpm test", "npm run test", "pnpm run test"]
        : [
            ...(name === "check" ? ["pnpm check"] : []),
            `npm run ${name}`,
            `pnpm run ${name}`,
          ];
    // A CI-only script is CI-only in every form.
    if (forms.some((form) => ciOnly.has(ciOnlyKey(form)))) continue;
    for (const form of forms)
      if (
        usable(form) &&
        (await authorizedCommand(
          {
            command: form,
            provenance: "base-observed",
            source: "package.json",
          },
          files,
          sources,
        ))
      ) {
        accepted.add(form);
        break;
      }
  }
  // Only inline command spans: never fenced code, prose or code fragments.
  for (const source of sources)
    for (const command of new Set(inlineSpans(source)))
      if (
        COMMAND_SHAPE.test(command) &&
        usable(command) &&
        (await authorizedCommand(
          { command, provenance: "source-declared", source: source.path },
          files,
          sources,
        ))
      )
        accepted.add(command);
  return [...accepted];
}

/**
 * Whether a plan's validation command is authorized: one the request listed
 * (this covers operator-authorized commands), or one the full rule accepts.
 */
export async function commandAuthorized(
  facts: PlanningFacts,
  check: ValidationCommand,
  files: BaseFiles,
): Promise<boolean> {
  return (
    facts.authorizedCommands.includes(normalizedCommand(check.command)) ||
    authorizedCommand(check, files, facts.sources)
  );
}

// ── Planner instructions ────────────────────────────────────────────────

/** The planner's note on the validation environment; always present. */
function validationEnvironmentInstructions(): string {
  return `\n\nValidation environment (differs from hosted CI): ${JSON.stringify(VALIDATION_ENVIRONMENT)}`;
}

/** The planner's note on the installation's CI-only commands, after the environment note. */
function ciOnlyInstructions(ciOnlyCommands: readonly string[]): string {
  return (
    validationEnvironmentInstructions() +
    (ciOnlyCommands.length
      ? `\n\nThese commands need network and run only in CI; validation runs offline, so never use one as a validation command: ${JSON.stringify(ciOnlyCommands)}. When a criterion can only be proved by one of them, leave it out and ask through decisionRequired.`
      : "")
  );
}

/** The planner's note of the exact validation commands Factory accepts. */
function authorizedCommandInstructions(
  commands: readonly string[],
  scopes: ReadonlyMap<string, string> = new Map(),
): string {
  const scoped = commands.flatMap((command) =>
    scopes.has(command) ? [`\`${command}\` (${scopes.get(command)})`] : [],
  );
  return `\n\nAuthorized validation commands (use one of these; other forms may be refused): ${listCommands(commands)}.${scoped.length ? `\nThese check only one directory; select one only for an item that owns a path in it: ${scoped.join(", ")}.` : ""}`;
}

/** The CI-only and authorized-command notes for the planner request, in that order. */
export async function commandInstructions(
  facts: PlanningFacts,
  checkout: string,
  signal?: AbortSignal,
): Promise<string> {
  const scripts = await new BaseFiles(checkout, facts.base, signal).scripts();
  return (
    ciOnlyInstructions(facts.ciOnlyCommands) +
    authorizedCommandInstructions(
      facts.authorizedCommands,
      scopedCommands(facts.authorizedCommands, scripts),
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
 * The package scripts the final commands run, as the base's root
 * package.json defines them. Validation keeps these bodies fixed, so the
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

/** The check-run names of the base's workflows whose `on` passes `triggered`. */
async function checkNamesOf(
  files: BaseFiles,
  triggered: (on: unknown) => boolean,
): Promise<string[]> {
  const paths = (await files.paths()).filter((path) =>
    new RegExp(`^${WORKFLOWS}/[^/]+\\.ya?ml$`).test(path),
  );
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
  const names = new Set<string>();
  for (const path of paths) {
    const workflow = parsed.get(path);
    if (!triggered((workflow as { on?: unknown } | null)?.on)) continue;
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
  }
  return [...names].sort();
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
/** The declaring source of installation-required final commands. */
const REQUIRED_COMMANDS_SOURCE =
  "installation finalValidation.requiredCommands";

export interface FactsArgs {
  objective: number;
  /** The Objective as shown: its structure and the planner text. */
  shown: ShownObjective;
  /** The Objective is a Factory-created split child (childIdentity). */
  child?: boolean;
  base: string;
  checkout: string;
  /** The installation's required final commands; their scripts stay fixed. */
  requiredCommands?: readonly string[];
  /** The installation's CI-only commands: never a validation command. */
  ciOnlyCommands?: readonly string[];
  /** Exact commands an operator answer authorized; treated as authorized. */
  extraCommands?: readonly string[];
  /** The approved playbook text. */
  playbook?: string;
  /** The operator's media.localAssetRoots. */
  localAssetRoots?: readonly string[];
  signal?: AbortSignal;
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
  const { sources, problems } = await planningSources(
    args.shown,
    files,
    args.child,
  );
  if (problems.length) return { problems };
  const ciOnlyCommands = [...(args.ciOnlyCommands ?? [])];
  const facts: PlanningFacts = {
    objective: args.objective,
    body: args.shown.body,
    blocks: args.shown.blocks,
    base: args.base,
    sources,
    authorizedCommands: await authorizedCommands(
      sources,
      files,
      ciOnlyCommands,
      args.extraCommands,
    ),
    ciOnlyCommands,
    checkNames: await workflowCheckNames(files),
    integratedCheckNames: await pushCheckNames(
      files,
      await files.defaultBranch(),
    ),
    fixedScripts: await fixedScripts(
      finalCommands(args.shown.blocks, args.requiredCommands),
      files,
    ),
    coverageObligations: coverageObligations(args.shown.blocks),
    playbook: args.playbook ?? "",
    localAssetRoots: args.localAssetRoots ?? [],
  };
  return { facts };
}

/**
 * The Objective's command and source problems at queue time; each says how
 * to fix it. Empty means planning can start: every pinned Source reads as
 * UTF-8 at the base, every Acceptance command has authority there, the
 * Objective declares the commands it names, and the installation's required
 * and CI-only commands fit it.
 */
export async function objectiveCommandProblems(
  shown: ShownObjective,
  base: string,
  checkout: string,
  options: {
    requiredCommands?: readonly string[];
    ciOnlyCommands?: readonly string[];
    signal?: AbortSignal;
    /** The Objective is a Factory-created split child (childIdentity). */
    child?: boolean;
  } = {},
): Promise<string[]> {
  const child = options.child === true;
  const files = new BaseFiles(checkout, base, options.signal);
  const { sources, problems } = await planningSources(shown, files, child);
  const finals = finalObjectiveCommands(shown.blocks);
  const ciOnly = new Set((options.ciOnlyCommands ?? []).map(ciOnlyKey));
  let authorized: string[] | undefined;
  const list = async () => {
    authorized ??= await authorizedCommands(
      sources,
      files,
      options.ciOnlyCommands,
    );
    return listCommands(authorized);
  };

  for (const command of finals) {
    if (ciOnly.has(ciOnlyKey(command)))
      problems.push(
        `Acceptance command ${command} is CI-only in the installation's finalValidation.ciOnlyCommands: it needs network, and final validation runs offline. Leave it to CI and remove it from the Objective's Acceptance commands, or remove it from ciOnlyCommands if it runs offline.`,
      );
    else if (
      !(await authorizedCommand(
        { command, provenance: "source-declared", source: "OBJECTIVE" },
        files,
        sources,
      ))
    )
      problems.push(
        `Acceptance command has no executable authority at the accepted base: ${command}. Use one of the authorized commands: ${await list()}, or remove it from Acceptance.`,
      );
  }

  // A Factory-created child carries its parent's prose; the parent was checked.
  if (!finals.length && !child) {
    const named: string[] = [];
    for (const span of new Set(shown.spans.map((span) => span.trim()))) {
      if (!span) continue;
      const declared =
        (await authorizedCommand(
          {
            command: span,
            provenance: "base-observed",
            source: "package.json",
          },
          files,
          sources,
        )) ||
        (
          await Promise.all(
            sources
              .filter((source) => source.path !== "OBJECTIVE")
              .map((source) =>
                authorizedCommand(
                  {
                    command: span,
                    provenance: "source-declared",
                    source: source.path,
                  },
                  files,
                  sources,
                ),
              ),
          )
        ).some(Boolean);
      if (declared) named.push(span);
    }
    if (named.length)
      problems.push(
        `Objective names ${named.map((command) => `\`${command}\``).join(", ")} but declares no final command. Final commands are only Acceptance bullets that are exactly one backticked command; planning cannot add them. Make each command the integrated result must pass an Acceptance bullet with exactly one backticked command, for example:\n${named.map((command) => `- \`${command}\``).join("\n")}\nIf the Objective needs no final command, remove the backticks from those mentions (a command named in prose stays usable by the plan, but is not a final command).`,
      );
  }

  const required = options.requiredCommands ?? [];
  const requiredSources: PinnedSource[] = [
    objectiveSource(shown, child),
    { path: REQUIRED_COMMANDS_SOURCE, content: required.join("\n") },
  ];
  for (const command of required)
    if (
      !(await authorizedCommand(
        {
          command,
          provenance: "source-declared",
          source: REQUIRED_COMMANDS_SOURCE,
        },
        files,
        requiredSources,
      ))
    )
      problems.push(
        `Required final-validation command has no executable authority at the accepted base: ${command}. Package scripts must use ${PACKAGE_SCRIPT_FORMS}, with fixed script bodies, hooks and configuration; correct or remove it in the installation's finalValidation.requiredCommands. Authorized commands: ${listCommands(await authorizedCommands(requiredSources, files))}.`,
      );
  return problems;
}
