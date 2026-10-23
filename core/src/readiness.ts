/**
 * The readiness checklist: what this host, the providers' logins and the
 * target repository need before the service runs an Objective, read with
 * no model call and no change to the target or its settings (the Codex
 * probe writes only its own temporary directories). Setup shows it; a `blocked` check names its
 * fix. Logins are checked by presence: account access, billing and
 * entitlements are first known when a provider is called.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { CoreConfig } from "./config.js";
import type { GitHub } from "./github.js";
import { missingTypes, offeredTypes } from "./github-roles.js";
import { isHostKind, unregisteredKinds } from "./kinds.js";
import { networkToolOfCommand } from "./planning/facts.js";
import { codexSandboxProblem } from "./providers/codex-worker.js";
import { executable, sandboxStatus } from "./sandbox.js";
import { errorMessage } from "./text.js";

export interface ReadinessCheck {
  /** What was checked, such as `sandbox` or `provider codex: worker login`. */
  name: string;
  /** `blocked`: the service would hold on it. `warn`: it runs, but see the detail. */
  status: "ok" | "warn" | "blocked";
  detail: string;
  fix?: string;
}

export interface Readiness {
  /** No check is blocked. */
  ready: boolean;
  checks: ReadinessCheck[];
  validationEnvironment: ValidationEnvironment;
}

/** How validation here differs from hosted CI (docs/VALIDATION-ENVIRONMENT.md). */
export interface ValidationEnvironment {
  network: string;
  sandbox: string;
  /** The dependency install that runs before a checkout's commands. */
  bootstrap: string;
  /** sandbox.environment's names; the values stay in the configuration. */
  environment: string[];
  requiredCommands: string[];
  ciOnlyCommands: string[];
  /** Package scripts that reach a network validation doesn't have and that aren't CI-only. */
  networkScripts: { script: string; tool: string }[];
}

/** Every check, in order: host, providers, repository. */
export async function readiness(
  config: CoreConfig,
  github: GitHub,
  /** Credentials the service will load (`--credential-file`): present for it. */
  bound: readonly string[] = [],
): Promise<Readiness> {
  const scripts = packageScripts(config.checkout);
  const checks = [
    ...hostChecks(config, scripts),
    ...providerChecks(config, bound),
    ...(await repositoryChecks(config, github)),
  ];
  const environment = validationEnvironment(config, scripts);
  if (environment.networkScripts.length)
    checks.push({
      name: "package scripts",
      status: "warn",
      detail: `${environment.networkScripts.map(({ script, tool }) => `${script} runs ${tool}`).join(", ")}: validation has no network, so plans never run them`,
      fix: "If CI runs them, list each as `npm run NAME` (or `pnpm run NAME`) in finalValidation.ciOnlyCommands",
    });
  return {
    ready: !checks.some((check) => check.status === "blocked"),
    checks,
    validationEnvironment: environment,
  };
}

const ok = (name: string, detail: string): ReadinessCheck => ({
  name,
  status: "ok",
  detail,
});

/** The checkout's root package scripts, empty without a readable package.json. */
function packageScripts(checkout: string): Record<string, unknown> {
  try {
    const { scripts } = JSON.parse(
      readFileSync(join(checkout, "package.json"), "utf8"),
    ) as { scripts?: unknown };
    return scripts && typeof scripts === "object"
      ? (scripts as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** The command's program: its first word that isn't a variable assignment. */
const program = (command: string) =>
  command
    .trim()
    .split(/\s+/)
    .find((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word));

function hostChecks(
  config: CoreConfig,
  scripts: Record<string, unknown>,
): ReadinessCheck[] {
  const checks: ReadinessCheck[] = [];
  const sandbox = sandboxStatus(config.sandbox);
  checks.push(
    sandbox.mode === "bubblewrap"
      ? ok("sandbox", sandbox.detail)
      : {
          name: "sandbox",
          status: sandbox.mode === "unsandboxed" ? "warn" : "blocked",
          detail: sandbox.detail,
          ...(sandbox.fix && { fix: sandbox.fix }),
        },
  );
  if (sandbox.installNetwork?.startsWith("offline"))
    checks.push({
      name: "package-install network",
      status: "warn",
      detail: `sandbox.network is package-install, but installs run ${sandbox.installNetwork}`,
      fix: "Install passt (pasta) so verified installs can reach the registry",
    });
  for (const warning of sandbox.warnings)
    checks.push({
      name: "sandbox.environment",
      status: "warn",
      detail: warning,
    });
  const store = config.sandbox.packageStore;
  if (store && existsSync(store) && !statSync(store).isDirectory())
    checks.push({
      name: "sandbox.packageStore",
      status: "blocked",
      detail: `${store} is not a directory`,
      fix: "Point sandbox.packageStore at a directory of its own, or remove the file",
    });
  else if (store)
    checks.push(
      ok(
        "sandbox.packageStore",
        existsSync(store)
          ? `${store}; only verified installs write it`
          : `${store} is created at the first install`,
      ),
    );
  // The programs Factory runs itself, and those the final commands start.
  const programs = new Map<string, string>([
    ["git", "Factory's Git work"],
    ["node", "Factory and package scripts"],
  ]);
  for (const command of config.finalValidation.requiredCommands) {
    const name = program(command);
    if (name && !name.includes("/") && !programs.has(name))
      programs.set(name, `the final command \`${command}\``);
  }
  const missing = [...programs].filter(([name]) => !executable(name));
  // git-lfs on the PATH may still not be what `git lfs` runs.
  if (!lfsRuns()) missing.push(["git lfs", "media in Git LFS"]);
  checks.push(
    missing.length
      ? {
          name: "PATH",
          status: "blocked",
          detail: `Not on the PATH: ${missing.map(([name, use]) => `${name} (${use})`).join(", ")}`,
          fix: "Install them, or add their directory to the PATH the service runs with",
        }
      : ok("PATH", `Found ${[...programs.keys()].join(", ")} and git lfs`),
  );
  for (const command of config.finalValidation.requiredCommands) {
    const tool = networkToolOfCommand(command, scripts);
    if (tool)
      checks.push({
        name: "finalValidation.requiredCommands",
        status: "warn",
        detail: `\`${command}\` runs ${tool}, which needs a network validation doesn't have`,
        fix: "If it only works in CI, move it to finalValidation.ciOnlyCommands",
      });
  }
  return checks;
}

/** A module the provider imports, resolvable from Factory. */
function installed(name: string): boolean {
  try {
    import.meta.resolve(name);
    return true;
  } catch {
    return false;
  }
}

const SDK: Record<string, string> = {
  codex: "@openai/codex-sdk",
  claude: "@anthropic-ai/claude-agent-sdk",
  copilot: "@github/copilot-sdk",
};

/** The login each kind uses, found by presence alone, or why it is missing. */
function login(
  kind: string,
  bound: readonly string[],
): string | { missing: string; fix: string } {
  const set = (...names: string[]) => names.find((name) => process.env[name]);
  switch (kind) {
    case "codex": {
      const file = join(
        process.env.CODEX_HOME || join(homedir(), ".codex"),
        "auth.json",
      );
      if (existsSync(file)) return `the Codex login in ${file}`;
      const named = set("CODEX_API_KEY", "OPENAI_API_KEY");
      if (named) return `${named} in the environment`;
      return {
        missing: `no Codex login at ${file}, and no CODEX_API_KEY or OPENAI_API_KEY`,
        fix: "Run `codex login` as the user the service runs as",
      };
    }
    case "claude": {
      const file = join(
        process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"),
        ".credentials.json",
      );
      // Only Claude takes a login from the service's credentials.
      const names = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"];
      const named = set(...names);
      if (named) return `${named} in the environment`;
      const credential = names.find((name) => loaded(name, bound));
      if (credential) return `${credential} in the service's credentials`;
      if (existsSync(file)) return `the Claude login in ${file}`;
      return {
        missing: `no Claude login at ${file}, and no CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY`,
        fix: "Run `claude auth login` as the user the service runs as",
      };
    }
    default:
      return set("COPILOT_GITHUB_TOKEN")
        ? "COPILOT_GITHUB_TOKEN in the environment"
        : "the GitHub CLI login";
  }
}

/** A credential systemd loaded for the service, by presence: never read here. */
function loaded(name: string, bound: readonly string[]): boolean {
  if (bound.includes(name)) return true;
  const directory = process.env.CREDENTIALS_DIRECTORY;
  return (
    !!directory && isAbsolute(directory) && existsSync(join(directory, name))
  );
}

function providerChecks(
  config: CoreConfig,
  bound: readonly string[],
): ReadinessCheck[] {
  const checks: ReadinessCheck[] = [];
  for (const [name, provider] of Object.entries(config.providers)) {
    const worker = provider.worker;
    // A host kind is built by the process that registered it (kinds.ts).
    for (const [kind, role] of [
      [provider.planner, "planner"],
      [worker.kind, "worker"],
    ] as const)
      if (isHostKind(kind))
        checks.push(
          unregisteredKinds({ [name]: provider }).some((missing) =>
            missing.endsWith(`(${role})`),
          )
            ? {
                name: `provider ${name}: ${kind} ${role}`,
                status: "blocked",
                detail: `${kind} is a host kind this process hasn't registered`,
                fix: "Serve this installation from the host program that registers it (serveFactory)",
              }
            : ok(
                `provider ${name}: ${kind} ${role}`,
                "registered by this process",
              ),
        );
    const kinds = new Map<string, string>(
      provider.planner in SDK ? [[provider.planner, "planner"]] : [],
    );
    if (worker.kind in SDK)
      kinds.set(
        worker.kind,
        kinds.has(worker.kind) ? "planner and worker" : "worker",
      );
    for (const [kind, role] of kinds) {
      const at = `provider ${name}: ${kind} ${role}`;
      if (!installed(SDK[kind]!)) {
        checks.push({
          name: at,
          status: "blocked",
          detail: `${SDK[kind]} is not installed`,
          fix: `Install Factory with its optional dependencies, or ${SDK[kind]}`,
        });
        continue;
      }
      const found = login(kind, bound);
      checks.push(
        typeof found === "string"
          ? ok(at, `${found}; account access is checked at the first call`)
          : {
              name: at,
              status: "blocked",
              detail: found.missing,
              fix: found.fix,
            },
      );
    }
    // Codex sandboxes its workers' commands itself: try it, as a worker would.
    if (worker.kind === "codex" && installed(SDK.codex!)) {
      const network = worker.network === "host";
      const problem = codexSandboxProblem(
        network,
        config.policy.allowedSecretNames,
      );
      const at = `provider ${name}: codex worker sandbox`;
      checks.push(
        problem
          ? {
              name: at,
              status: "blocked",
              detail: problem,
              fix: "Make Codex's Linux sandbox work on this host (unprivileged user namespaces, as for bubblewrap), then repeat",
            }
          : ok(
              at,
              `a command writes its worktree and is refused outside it (network ${network ? "host" : "off"})`,
            ),
      );
    }
    const credential =
      worker.kind === "openai-agents"
        ? worker.apiKeyEnv
        : worker.kind === "claude-managed-agents"
          ? worker.credentialEnv
          : undefined;
    if (credential) {
      const present = !!process.env[credential] || loaded(credential, bound);
      checks.push(
        present
          ? ok(
              `provider ${name}: ${worker.kind} worker`,
              `${credential} is set`,
            )
          : {
              name: `provider ${name}: ${worker.kind} worker`,
              status: "blocked",
              detail: `${credential} is not in the environment or the service's credentials`,
              fix: `Set ${credential} for the service`,
            },
      );
    }
  }
  return checks;
}

async function repositoryChecks(
  config: CoreConfig,
  github: GitHub,
): Promise<ReadinessCheck[]> {
  const checks: ReadinessCheck[] = [];
  let login: string;
  try {
    login = await github.login();
    await github.checkIdentity();
  } catch (error) {
    return [
      {
        name: "GitHub",
        status: "blocked",
        detail: `Can't read ${config.repository} with the GitHub CLI login: ${errorMessage(error)}`,
        fix: "Run `gh auth login` (with the project scope) as the user the service runs as",
      },
    ];
  }
  try {
    const push = await github.canPush();
    checks.push(
      push === false
        ? {
            name: "GitHub",
            status: "blocked",
            detail: `${login} can't push to ${config.repository}`,
            fix: "Give the login write access to the repository",
          }
        : ok("GitHub", `${login} can push to ${config.repository}`),
    );
    const branch = await github.defaultBranch();
    checks.push(
      (await github.mergeCommitsAllowed(branch))
        ? ok(
            "merge commits",
            `PRs into ${branch} may merge with a merge commit`,
          )
        : {
            name: "merge commits",
            status: "blocked",
            detail: `PRs into ${branch} can't merge with a merge commit, the only way Factory merges`,
            fix: "Allow merge commits in the repository settings, and in any ruleset on the branch",
          },
    );
    const { names, strict } = await github.checksPolicy(branch);
    checks.push(
      names.length
        ? ok("required checks", `${branch} requires ${names.join(", ")}`)
        : {
            name: "required checks",
            status: "warn",
            detail: `${branch} requires no status checks, so a PR merges once Factory's own validation passes`,
            fix: `Require the CI checks on ${branch} in a ruleset`,
          },
    );
    if (config.tracking.enabled) {
      const missing = await offeredTypes(github).then(
        (offered) => missingTypes(config.tracking.issueType, offered),
        (error: unknown) => errorMessage(error),
      );
      checks.push(
        typeof missing === "string"
          ? {
              name: "issue types",
              status: "warn",
              detail: `Can't read ${config.repository}'s issue types: ${missing}`,
              fix: "Factory's issues go without a type until it can; check the GitHub CLI login's access",
            }
          : missing.length
            ? {
                name: "issue types",
                status: "warn",
                detail: `${config.repository} doesn't offer the issue type${missing.length === 1 ? "" : "s"} ${missing.join(", ")}, so Factory's issues go without ${missing.length === 1 ? "it" : "them"}`,
                fix: "Add the type in the organization's issue type settings, or name one the repository offers in tracking.issueType",
              }
            : ok(
                "issue types",
                `Objectives get ${config.tracking.issueType.objective}, Work Items ${config.tracking.issueType.workItem}`,
              ),
      );
    }
    // A recommendation only: Factory never changes repository settings.
    const recommend = `Recommended: turn on "Require branches to be up to date before merging" for ${branch}. Factory updates a PR that falls behind and waits for CI again`;
    if (names.length)
      checks.push(
        strict
          ? ok(
              "branch protection",
              `${branch} requires branches to be up to date`,
            )
          : {
              name: "branch protection",
              status: "warn",
              detail:
                strict === false
                  ? `${branch} doesn't require branches to be up to date, so two PRs that each passed CI can merge into a combination no CI run checked`
                  : `${login} can't read ${branch}'s protection settings, so whether it requires branches to be up to date is unknown`,
              fix: recommend,
            },
      );
  } catch (error) {
    checks.push({
      name: "GitHub",
      status: "blocked",
      detail: `Can't read ${config.repository}'s settings: ${errorMessage(error)}`,
      fix: "Check the GitHub CLI login's access, then repeat",
    });
  }
  return checks;
}

function validationEnvironment(
  config: CoreConfig,
  scripts: Record<string, unknown>,
): ValidationEnvironment {
  const ciOnly = new Set(
    config.finalValidation.ciOnlyCommands.map((command) =>
      command.trim().replace(/\s+/g, " "),
    ),
  );
  const networkScripts = Object.keys(scripts).flatMap((script) => {
    const tool = networkToolOfCommand(`npm run ${script}`, scripts);
    return tool &&
      !["npm", "pnpm"].some((manager) => ciOnly.has(`${manager} run ${script}`))
      ? [{ script, tool }]
      : [];
  });
  const sandbox = sandboxStatus(config.sandbox);
  return {
    network:
      config.sandbox.network === "package-install"
        ? `package-install: only the script-disabled dependency install reaches the network${sandbox.installNetwork ? ` (${sandbox.installNetwork})` : ""}`
        : "off: no command reaches the network",
    sandbox: `${sandbox.mode}: private HOME and /tmp, read-only host, no host credentials or sockets`,
    bootstrap: existsSync(join(config.checkout, "pnpm-lock.yaml"))
      ? "pnpm install --frozen-lockfile --ignore-scripts"
      : "npm ci --ignore-scripts",
    environment: Object.keys(config.sandbox.environment).sort(),
    requiredCommands: config.finalValidation.requiredCommands,
    ciOnlyCommands: config.finalValidation.ciOnlyCommands,
    networkScripts,
  };
}

/** Whether `git lfs` runs. */
function lfsRuns(): boolean {
  try {
    execFileSync("git", ["lfs", "version"], {
      stdio: "ignore",
      timeout: 10_000,
    });
    return true;
  } catch {
    return false;
  }
}
