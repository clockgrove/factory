/**
 * `factory setup`: write the installation's configuration from options,
 * check it loads, and check the target it binds. Each option names one
 * configuration key; loadConfig checks the values, so setup never
 * duplicates a rule. Repeating the same command changes nothing. The
 * keys that bind the installation to its target (checkout and the queue's
 * Project fields) are never changed by setup: a different value is a
 * conflict, refused before anything is written.
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import {
  type CapacityRecommendation,
  capacityRecommendation,
  hostCapacity,
} from "./capacity.js";
import { isObject } from "./checked.js";
import { configPath, loadConfig } from "./config.js";
import { originRefusal } from "./git.js";
import {
  appKeyFile,
  appRegistrationLink,
  appSteps,
  factoryGitHub,
  GITHUB_APP_KEY,
  keepAppKey,
  organizationOwner,
  readAppKey,
} from "./github-app.js";
import { lockHeld } from "./lock.js";
import { installationPaths } from "./paths.js";
import { PLANNERS, WORKERS } from "./providers/config.js";
import { defaultModels } from "./providers/selection.js";
import { projectProblems } from "./queue.js";
import { type Readiness, readiness } from "./readiness.js";
import { listObjectives, writeAtomic } from "./state.js";
import {
  boundCredentials,
  credentialFiles,
  hostProblem,
  install,
  type ServiceState,
  serviceState,
  stop,
  uninstall,
  unitHealth,
  unkeptLogins,
} from "./systemd.js";
import { errorMessage } from "./text.js";

/** How an option's value becomes the key's: loadConfig checks the result. */
type Read = "text" | "number" | "list" | "names" | "env";

interface Option {
  /** The key, dotted, from the configuration (or the provider's) root. */
  key: string;
  read: Read;
  /** A key that binds the target: refused when it would change. */
  binding?: true;
}

/** Installation-wide options. `list` and `env` options repeat. */
const CONFIG_OPTIONS: Record<string, Option> = {
  checkout: { key: "checkout", read: "text", binding: true },
  "project-id": { key: "queue.projectId", read: "text", binding: true },
  field: { key: "queue.field", read: "text", binding: true },
  "order-field": { key: "queue.orderField", read: "text", binding: true },
  "poll-seconds": { key: "queue.pollSeconds", read: "number" },
  "max-active": { key: "queue.maxActiveObjectives", read: "number" },
  concurrency: { key: "execution.concurrency", read: "number" },
  workers: { key: "execution.workers", read: "number" },
  validations: { key: "execution.validations", read: "number" },
  planners: { key: "execution.planners", read: "number" },
  "memory-mib": { key: "execution.memoryMiB", read: "number" },
  "worker-mib": { key: "execution.reservations.worker", read: "number" },
  "validation-mib": {
    key: "execution.reservations.validation",
    read: "number",
  },
  "planner-mib": { key: "execution.reservations.planner", read: "number" },
  "planning-revisions": {
    key: "autonomy.allowances.planningRevisions",
    read: "number",
  },
  "implementation-repairs": {
    key: "autonomy.allowances.implementationRepairs",
    read: "number",
  },
  "per-path-repairs": { key: "autonomy.allowances.perPath", read: "number" },
  "result-rereviews": {
    key: "autonomy.allowances.resultRereviews",
    read: "number",
  },
  "objective-tokens": {
    key: "autonomy.spend.perObjective.tokens",
    read: "number",
  },
  "objective-cents": {
    key: "autonomy.spend.perObjective.cents",
    read: "number",
  },
  "day-tokens": { key: "autonomy.spend.perDay.tokens", read: "number" },
  "day-cents": { key: "autonomy.spend.perDay.cents", read: "number" },
  "required-env": { key: "autonomy.requiredEnvironment", read: "list" },
  delivery: { key: "delivery.kind", read: "text" },
  "sandbox-network": { key: "sandbox.network", read: "text" },
  "package-store": { key: "sandbox.packageStore", read: "text" },
  "read-only-path": { key: "sandbox.readOnlyPaths", read: "list" },
  "sandbox-env": { key: "sandbox.environment", read: "env" },
  "required-command": { key: "finalValidation.requiredCommands", read: "list" },
  "ci-only-command": { key: "finalValidation.ciOnlyCommands", read: "list" },
  "allowed-secret": { key: "policy.allowedSecretNames", read: "list" },
  "github-app-id": { key: "github.app.id", read: "number" },
  "github-app-installation": {
    key: "github.app.installationId",
    read: "number",
  },
  operator: { key: "operators", read: "list" },
};

/**
 * One provider's options, under providers.NAME. A `<kind>-` option sets
 * that worker kind's settings and is refused for another kind. `names`
 * take a comma-separated list.
 */
const PROVIDER_OPTIONS: Record<string, Option> = {
  "planner-model": { key: "models.planner.model", read: "text" },
  "planner-effort": { key: "models.planner.effort", read: "text" },
  "reviewer-model": { key: "models.reviewer.model", read: "text" },
  "reviewer-effort": { key: "models.reviewer.effort", read: "text" },
  "codex-network": { key: "worker.network", read: "text" },
  "codex-model": { key: "worker.model", read: "text" },
  "codex-effort": { key: "worker.effort", read: "text" },
  "codex-service-tier": { key: "worker.serviceTier", read: "text" },
  "claude-model": { key: "worker.model", read: "text" },
  "claude-effort": { key: "worker.effort", read: "text" },
  "claude-max-turns": { key: "worker.maxTurns", read: "number" },
  "claude-tools": { key: "worker.tools", read: "names" },
  "claude-allowed-tools": { key: "worker.allowedTools", read: "names" },
  "claude-permission-mode": { key: "worker.permissionMode", read: "text" },
  "claude-setting-sources": { key: "worker.settingSources", read: "names" },
  "copilot-model": { key: "worker.model", read: "text" },
  "copilot-effort": { key: "worker.effort", read: "text" },
  "copilot-tools": { key: "worker.tools", read: "names" },
  "copilot-timeout-seconds": { key: "worker.idleSeconds", read: "number" },
};

/** Worker kinds setup can write: the managed ones need settings by hand. */
const SETUP_WORKERS = ["codex", "claude", "copilot"];

/** The settings a managed worker needs, which setup doesn't take. */
const MANAGED_FIELDS: Record<string, string> = {
  "openai-agents": '"model", "effort", "containerSize", "apiKeyEnv"',
  "claude-managed-agents":
    '"agentId", "agentVersion", "environmentId", "workspaceId", "credentialEnv"',
};

/** Setup's options for the command table, by kind (commands/shared.ts `FlagKind`). */
export const SETUP_FLAGS: Record<string, "switch" | "value" | "list"> = {
  "config-only": "switch",
  background: "switch",
  check: "switch",
  stop: "switch",
  uninstall: "switch",
  "credential-file": "list",
  "github-app-key": "value",
  "github-app-link": "switch",
  provider: "value",
  planner: "value",
  worker: "value",
  default: "switch",
  json: "switch",
  ...Object.fromEntries(
    Object.entries({ ...CONFIG_OPTIONS, ...PROVIDER_OPTIONS }).map(
      ([flag, { read }]) => [
        flag,
        read === "list" || read === "env" ? "list" : "value",
      ],
    ),
  ),
};

/** A refusal before anything is written: the command line is wrong. */
export class SetupUsage extends Error {}

export interface SetupReport {
  /**
   * `configured`: saved, it loads, and the target and host are ready.
   * `blocked`: saved and it loads, but the target isn't ready (`problems`
   * names what) or a readiness check is blocked (it names its fix).
   * `refused`: nothing saved (`problems` names why).
   */
  status: "configured" | "blocked" | "refused";
  config: string;
  created: boolean;
  /** The keys this run changed; empty when the command was repeated. */
  changed: string[];
  defaultProvider?: string;
  problems: string[];
  /** The readiness checklist, once the configuration loads (readiness.ts). */
  readiness?: Readiness;
  /** How the configured capacity fits this host (capacity.ts), once it loads. */
  capacity?: CapacityRecommendation;
}

/** Equal as JSON, whatever the order of object keys. */
function same(a: unknown, b: unknown): boolean {
  const sorted = (value: unknown): unknown =>
    isObject(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, sorted(value[key])]),
        )
      : Array.isArray(value)
        ? value.map(sorted)
        : value;
  return JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
}

/** The value at a dotted key, or undefined. */
function get(root: Record<string, unknown>, key: string): unknown {
  let at: unknown = root;
  for (const part of key.split(".")) at = isObject(at) ? at[part] : undefined;
  return at;
}

/** Set a dotted key, creating the objects on the way. */
function put(root: Record<string, unknown>, key: string, value: unknown): void {
  const parts = key.split(".");
  const last = parts.pop()!;
  let at = root;
  for (const part of parts) {
    if (!isObject(at[part])) at[part] = {};
    at = at[part] as Record<string, unknown>;
  }
  at[last] = value;
}

/** A whole number as a number; anything else as given, for loadConfig to name. */
const number = (value: string) => (/^\d+$/.test(value) ? Number(value) : value);

function optionValue(read: Read, given: string[]): unknown {
  const last = given[given.length - 1]!;
  switch (read) {
    case "text":
      return last;
    case "number":
      return number(last);
    case "list":
      return given;
    case "names":
      return last
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean);
    case "env": {
      const environment: Record<string, string> = {};
      for (const entry of given) {
        const at = entry.indexOf("=");
        if (at < 1)
          throw new SetupUsage(
            `--sandbox-env takes NAME=VALUE; ${JSON.stringify(entry)} has no name`,
          );
        environment[entry.slice(0, at)] = entry.slice(at + 1);
      }
      return environment;
    }
  }
}

/**
 * Write the configuration the options name, check it loads (restoring the
 * file when it doesn't), then check the checkout's origin and the queue's
 * Project fields. `values` holds each option given, every value of a
 * repeated one in order.
 */
export async function setup(
  repository: string,
  values: Record<string, string[]>,
  /**
   * For `--background`: the credentials the service will load, by name.
   * The checks then run as the service will, with them and without the
   * logins its unit doesn't keep from this shell.
   */
  service?: readonly string[],
): Promise<SetupReport> {
  const path = configPath(repository);
  const created = !existsSync(path);
  // The App's key is read and checked before anything is written.
  const keyFile = values["github-app-key"]?.at(-1);
  let key: string | undefined;
  if (keyFile !== undefined)
    try {
      key = readAppKey(keyFile);
    } catch (error) {
      throw new SetupUsage(errorMessage(error));
    }
  let original = "";
  let raw: Record<string, unknown> = { repository };
  if (!created) {
    try {
      original = readFileSync(path, "utf8");
      const parsed: unknown = JSON.parse(original);
      if (!isObject(parsed)) throw new Error("it is not a JSON object");
      raw = parsed;
    } catch (error) {
      return refused(path, false, `Can't read ${path}: ${errorMessage(error)}`);
    }
  } else
    for (const flag of ["checkout", "project-id"])
      if (!values[flag])
        throw new SetupUsage(
          `${path} doesn't exist yet: give --checkout PATH and --project-id PVT_... to create it`,
        );
  const changed: string[] = [];
  const set = (key: string, value: unknown, root = raw, prefix = "") => {
    if (same(get(root, key), value)) return;
    put(root, key, value);
    changed.push(prefix + key);
  };
  // A binding compares with the value in effect, its default included;
  // a file that doesn't load has no value in effect to keep.
  let effective: Record<string, unknown> = raw;
  if (!created)
    try {
      effective = { ...loadConfig(repository) };
    } catch (error) {
      const bindings = Object.keys(CONFIG_OPTIONS).filter(
        (flag) => CONFIG_OPTIONS[flag]!.binding && values[flag],
      );
      if (bindings.length)
        return refused(
          path,
          false,
          `--${bindings.join(", --")} can't be checked against a configuration that doesn't load; fix it first: ${errorMessage(error)}`,
        );
    }
  const app = get(raw, "github.app.id");
  const conflicts: string[] = [];
  for (const [flag, option] of Object.entries(CONFIG_OPTIONS)) {
    const given = values[flag];
    if (!given) continue;
    const value = optionValue(option.read, given);
    const current = get(option.binding ? effective : raw, option.key);
    if (
      option.binding &&
      !created &&
      current !== undefined &&
      current !== value
    )
      conflicts.push(
        `--${flag} ${value} conflicts with ${option.key} ${JSON.stringify(current)}: setup never moves an installation to another target; edit ${path} by hand once no Objective is running`,
      );
    else set(option.key, value);
  }
  if (conflicts.length) return refused(path, created, ...conflicts);
  // A running Objective finds its own comments, issues and PRs by
  // Factory's login: as another, it would make them again.
  const running = listObjectives(installationPaths(repository).objectives);
  if (get(raw, "github.app.id") !== app && running.length)
    return refused(
      path,
      created,
      `--github-app-id changes who Factory acts as on GitHub, and ${running.map((issue) => `#${issue}`).join(", ")} still ${running.length === 1 ? "has" : "have"} state: each finds its own comments, issues and PRs by Factory's login. Drain the queue (factory queue drain), wait until no Objective runs, then repeat`,
    );
  if (key !== undefined && get(raw, "github.app.id") === undefined)
    return refused(
      path,
      created,
      "--github-app-key is the private key of the App github.app.id names: give --github-app-id too",
    );
  providerOptions(raw, values, path, set);
  if (!created && !changed.length) {
    const problems = loads(repository);
    if (problems) return refused(path, false, problems);
  } else {
    const save = (body: string) => {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeAtomic(path, body);
    };
    save(`${JSON.stringify(raw, null, 2)}\n`);
    const problems = loads(repository);
    if (problems) {
      if (created) rmSync(path, { force: true });
      else save(original);
      return refused(path, created, problems);
    }
  }
  const config = loadConfig(repository);
  if (key !== undefined && keepAppKey(installationPaths(repository).root, key))
    changed.push(GITHUB_APP_KEY);
  const problems: string[] = [];
  if (!existsSync(config.checkout))
    problems.push(
      `The checkout ${config.checkout} doesn't exist: clone ${repository} there`,
    );
  else {
    const refusal = await originRefusal(config.checkout, repository);
    if (refusal) problems.push(refusal.message);
  }
  if (service)
    for (const name of unkeptLogins(config)) delete process.env[name];
  const github = factoryGitHub(config);
  try {
    problems.push(...(await projectProblems(github, config)));
  } catch (error) {
    problems.push(`Can't read the queue's Project: ${errorMessage(error)}`);
  }
  const ready = await readiness(config, github, service);
  return {
    status: problems.length || !ready.ready ? "blocked" : "configured",
    config: path,
    created,
    changed,
    defaultProvider: config.defaultProvider,
    problems,
    readiness: ready,
    capacity: capacityRecommendation(
      hostCapacity(config.execution, config.queue.maxActiveObjectives),
    ),
  };
}

function refused(
  path: string,
  created: boolean,
  ...problems: string[]
): SetupReport {
  return { status: "refused", config: path, created, changed: [], problems };
}

/** loadConfig's problems, or undefined when the configuration loads. */
function loads(repository: string): string | undefined {
  try {
    loadConfig(repository);
    return undefined;
  } catch (error) {
    return errorMessage(error);
  }
}

/**
 * `--provider NAME` and its options: add the provider or change its
 * planner, worker and their settings. The first provider, or `--default`,
 * becomes defaultProvider. A provider's model choices belong to its
 * planner kind, and a worker's settings to its kind, so changing a kind
 * drops them.
 */
function providerOptions(
  raw: Record<string, unknown>,
  values: Record<string, string[]>,
  path: string,
  set: (
    key: string,
    value: unknown,
    root?: Record<string, unknown>,
    prefix?: string,
  ) => void,
): void {
  const name = values.provider?.at(-1);
  const given = Object.keys(PROVIDER_OPTIONS).filter((flag) => values[flag]);
  for (const flag of ["planner", "worker", "default"])
    if (values[flag]) given.push(flag);
  if (!name) {
    if (given.length)
      throw new SetupUsage(
        `--${given[0]} sets one provider: name it with --provider NAME`,
      );
    return;
  }
  const planner = values.planner?.at(-1);
  const worker = values.worker?.at(-1);
  if (planner && !(PLANNERS as readonly string[]).includes(planner))
    throw new SetupUsage(`--planner is one of ${PLANNERS.join(", ")}`);
  if (worker && !SETUP_WORKERS.includes(worker))
    throw new SetupUsage(
      (WORKERS as readonly string[]).includes(worker)
        ? `a ${worker} worker needs settings setup doesn't take: write providers.${name}.worker = { "kind": "${worker}", ${MANAGED_FIELDS[worker]} } in ${path} by hand`
        : `--worker is one of ${SETUP_WORKERS.join(", ")}`,
    );
  // Without providers the configuration has one: codex, the default.
  if (!isObject(raw.providers))
    raw.providers = { codex: { planner: "codex", worker: { kind: "codex" } } };
  const providers = raw.providers as Record<string, unknown>;
  // Keep the effective default (the first provider) unless --default moves it.
  if (raw.defaultProvider === undefined)
    set("defaultProvider", Object.keys(providers)[0] ?? name);
  const prefix = `providers.${name}.`;
  if (!isObject(providers[name])) providers[name] = {};
  const provider = providers[name] as Record<string, unknown>;
  const kind = planner ?? (provider.planner as string | undefined) ?? "codex";
  // An absent planner is codex, as loadConfig reads it.
  if ((provider.planner ?? "codex") !== kind)
    set("models", undefined, provider, prefix);
  set("planner", kind, provider, prefix);
  const current = isObject(provider.worker)
    ? (provider.worker.kind as string)
    : undefined;
  const workerKind = worker ?? current ?? kind;
  if (workerKind !== current)
    set("worker", { kind: workerKind }, provider, prefix);
  // A model choice names both model and effort: one given alone keeps the
  // other from the choice in effect, the planner kind's default if none.
  for (const role of ["planner", "reviewer"] as const) {
    const model = values[`${role}-model`]?.at(-1);
    const effort = values[`${role}-effort`]?.at(-1);
    if (model === undefined && effort === undefined) continue;
    const choice = get(provider, `models.${role}`);
    set(
      `models.${role}`,
      {
        ...(isObject(choice) ? choice : defaultModels(kind)[role]),
        ...(model !== undefined && { model }),
        ...(effort !== undefined && { effort }),
      },
      provider,
      prefix,
    );
  }
  for (const flag of Object.keys(PROVIDER_OPTIONS)) {
    const value = values[flag];
    const option = PROVIDER_OPTIONS[flag]!;
    if (!value || option.key.startsWith("models.")) continue;
    const owner = flag.split("-")[0]!;
    if (SETUP_WORKERS.includes(owner) && owner !== workerKind)
      throw new SetupUsage(
        `--${flag} sets a ${owner} worker, and providers.${name}'s worker is ${workerKind}; add --worker ${owner} to change it`,
      );
    set(option.key, optionValue(option.read, value), provider, prefix);
  }
  if (values.default) set("defaultProvider", name);
}

/** Setup's service modes; without one, setup writes and checks the configuration only. */
export const SERVICE_MODES = [
  "background",
  "check",
  "stop",
  "uninstall",
] as const;
export type ServiceMode = (typeof SERVICE_MODES)[number];

export interface ServiceReport {
  mode: ServiceMode;
  /**
   * `running`: the unit is active and the service holds its lock.
   * `starting`: started, and not serving yet. `blocked`: nothing started
   * (`problems` names why). `stopped`, `removed`; or for `--check`, the
   * unit's state.
   */
  status: string;
  service?: ServiceState;
  /** `--background`'s configuration step. */
  setup?: SetupReport;
  problems: string[];
  /** Not blockers: lingering off, a service still starting. */
  warnings: string[];
}

/** How long `--background` waits for the service to take its lock. */
const START_WAIT_MS = 30_000;

/**
 * `--background`: setup as without it, then, once the configuration and
 * target are ready, install and start the systemd user service and wait
 * for it to serve. `--check`, `--stop` and `--uninstall` act on the
 * service alone.
 */
export async function serviceSetup(
  repository: string,
  mode: ServiceMode,
  values: Record<string, string[]>,
): Promise<ServiceReport> {
  const others = Object.keys(values).filter(
    (flag) => flag !== mode && flag !== "json" && flag !== "repo",
  );
  if (mode !== "background" && others.length)
    throw new SetupUsage(
      `--${mode} takes no other option; drop --${others.join(", --")}`,
    );
  if (others.includes("config-only"))
    throw new SetupUsage("give --config-only or --background, not both");
  const paths = installationPaths(repository);
  const report: ServiceReport = {
    mode,
    status: "blocked",
    problems: [],
    warnings: [],
  };
  const serving = () => lockHeld(paths.lockName);
  if (mode === "check") {
    const service = serviceState(repository, paths, await serving());
    return {
      ...report,
      status: !service.installed
        ? "not-installed"
        : service.active === "active" && service.serving
          ? "running"
          : service.active,
      service,
      warnings: lingerWarning(service),
    };
  }
  if (mode === "stop" || mode === "uninstall") {
    const problem = hostProblem();
    if (problem) return { ...report, problems: [problem] };
    if (mode === "stop") stop(paths);
    else uninstall(paths);
    return {
      ...report,
      status: mode === "stop" ? "stopped" : "removed",
      service: serviceState(repository, paths, await serving()),
    };
  }
  const { "credential-file": given, ...rest } = values;
  // The App's key is setup's copy, the one readiness checks.
  if (given?.some((binding) => binding.startsWith(`${GITHUB_APP_KEY}=`)))
    throw new SetupUsage(
      `--credential-file takes no ${GITHUB_APP_KEY}: give the App's key with --github-app-key PATH, and the service loads setup's copy`,
    );
  // Given bindings replace the unit's; otherwise its own are checked again.
  const bindings =
    given ??
    boundCredentials(paths)
      .filter(({ name }) => name !== GITHUB_APP_KEY)
      .map(({ name, file }) => `${name}=${file}`);
  report.setup = await setup(
    repository,
    rest,
    bindings.map((binding) => binding.slice(0, binding.indexOf("="))),
  );
  if (report.setup.status !== "configured")
    return {
      ...report,
      problems: [
        "The service wasn't started: setup is not configured (see setup)",
      ],
    };
  const host = hostProblem();
  if (host) return { ...report, problems: [host] };
  try {
    const config = loadConfig(repository);
    // The App's key setup keeps is the service's credential too, and goes
    // with the App.
    const copy = appKeyFile(paths.root);
    const credentials = credentialFiles(
      bindings,
      config,
      config.github.app && existsSync(copy) ? copy : undefined,
    );
    const before = serviceState(repository, paths, await serving());
    if (before.serving && before.active !== "active")
      return {
        ...report,
        service: before,
        problems: [
          "A `factory serve` for this installation already runs outside the background service; stop it, then repeat",
        ],
      };
    // The service reads its configuration and credentials once, at start.
    install(
      repository,
      paths,
      credentials,
      report.setup.changed.length > 0 || given !== undefined,
    );
  } catch (error) {
    return { ...report, problems: [errorMessage(error)] };
  }
  const deadline = Date.now() + START_WAIT_MS;
  let health = unitHealth(paths);
  while (!(await serving()) && Date.now() < deadline) {
    health = unitHealth(paths);
    // A restart since this start means the service died.
    if (health.active === "failed" || health.restarts > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const service = serviceState(repository, paths, await serving());
  if (!service.serving && (health.active === "failed" || health.restarts > 0))
    return {
      ...report,
      service,
      problems: [
        `The service exited after it started (unit ${health.active}, ${health.restarts} restarts); read journalctl --user -u ${service.unit}, fix the cause, then repeat`,
      ],
    };
  const warnings = lingerWarning(service);
  if (!service.serving)
    warnings.push(
      `The service hasn't started serving yet (unit ${service.active}); check with factory setup --check, and read journalctl --user -u ${service.unit}`,
    );
  return {
    ...report,
    status: service.serving ? "running" : "starting",
    service,
    warnings,
  };
}

/**
 * `--github-app-link`: the link that registers Factory's GitHub App for
 * the repository's owner with every permission it needs, and what to do
 * next.
 */
export async function appLink(
  repository: string,
): Promise<{ link: string; next: string }> {
  const owner = repository.split("/")[0]!;
  const organization = await organizationOwner(
    owner,
    process.env.FACTORY_GITHUB_API,
  );
  return {
    link: appRegistrationLink(owner, organization),
    next: appSteps(organization),
  };
}

function lingerWarning(service: ServiceState): string[] {
  return [
    ...(service.installed && service.linger === "no"
      ? [
          "Lingering is off, so the service stops when you log out; `loginctl enable-linger` keeps it running",
        ]
      : []),
    ...(service.missingNode
      ? [
          `The unit's node ${service.missingNode} is missing; repeat factory setup --background from a shell whose node runs Factory to update and restart it`,
        ]
      : service.installed && !service.current
        ? [
            "The unit runs another Factory than this one (an upgrade?); repeat factory setup --background to update and restart it",
          ]
        : []),
  ];
}
