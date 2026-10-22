import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ciOnlyCommands, type FactoryConfig } from "./config.js";

/**
 * How Factory validation differs from a hosted CI run, in the compact form the
 * planner receives. docs/VALIDATION-ENVIRONMENT.md is the full list; keep the
 * two in step and this under ~800 bytes.
 */
export const VALIDATION_ENVIRONMENT = {
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

/** The planner's note on the validation environment; always present. */
export function validationEnvironmentInstructions(): string {
  return `\n\nValidation environment (differs from hosted CI): ${JSON.stringify(VALIDATION_ENVIRONMENT)}`;
}

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
export function networkToolIn(
  body: string,
  /** A segment the caller knows runs offline (for example the authorized bootstrap or a local bin). */
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

const collapse = (command: string) => command.trim().replace(/\s+/g, " ");

export interface ValidationEnvironmentReport {
  network: string;
  sandbox: string;
  bootstrap: string;
  ciOnlyCommands: { set: boolean; commands: string[] };
  planner: typeof VALIDATION_ENVIRONMENT;
  warnings: string[];
  detail: string;
}

/** The environment facts for an installation, with a warning per script that needs a network and is not CI-only. */
export function validationEnvironmentReport(
  config: FactoryConfig,
): ValidationEnvironmentReport {
  const commands = ciOnlyCommands(config);
  const listed = new Set(commands.map(collapse));
  const warnings: string[] = [];
  const manifest = join(config.checkout, "package.json");
  let scripts: Record<string, unknown> = {};
  if (existsSync(manifest))
    try {
      const parsed = JSON.parse(readFileSync(manifest, "utf8")) as {
        scripts?: Record<string, unknown>;
      };
      scripts =
        parsed.scripts && typeof parsed.scripts === "object"
          ? parsed.scripts
          : {};
    } catch {
      // An unreadable manifest is reported by validation itself.
    }
  for (const [name, body] of Object.entries(scripts)) {
    const tool = typeof body === "string" ? networkToolIn(body) : undefined;
    if (
      tool &&
      !["npm", "pnpm"].some((manager) =>
        listed.has(`${manager} run ${name}`),
      ) &&
      !(name === "test" && listed.has("npm test"))
    )
      warnings.push(
        `package script ${name} runs ${tool}, which needs a network validation does not have; if CI runs it, list \`npm run ${name}\` (or \`pnpm run ${name}\`) in finalValidation.ciOnlyCommands`,
      );
  }
  const network = config.sandbox?.network ?? "off";
  const pnpm = existsSync(join(config.checkout, "pnpm-lock.yaml"));
  return {
    network:
      network === "package-install"
        ? "package-install: only the script-disabled dependency install reaches the network"
        : "off: no command reaches the network",
    sandbox:
      config.sandbox?.required === false
        ? "not required: commands run unsandboxed when bubblewrap is unavailable"
        : "required: bubblewrap",
    bootstrap: pnpm
      ? "pnpm install --frozen-lockfile --ignore-scripts"
      : "npm ci --ignore-scripts",
    ciOnlyCommands: { set: commands.length > 0, commands: [...commands] },
    planner: VALIDATION_ENVIRONMENT,
    warnings,
    detail:
      "How validation differs from hosted CI: docs/VALIDATION-ENVIRONMENT.md",
  };
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
