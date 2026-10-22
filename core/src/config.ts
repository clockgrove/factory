import { readFileSync } from "node:fs";
import { availableParallelism, homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/** The installation's configuration, checked once when it's loaded. */
export interface CoreConfig {
  repository: string;
  /** A clone of the target, owned by Factory. */
  checkout: string;
  queue: {
    /** GitHub Project node id (PVT_...). */
    projectId: string;
    /** Single-select field Factory reads for "queued" and writes for progress. */
    field: string;
    /** Number field that orders the queue; ties go to the lower issue number. */
    orderField: string;
    /** Option names for each status. "queued" is what the operator sets. */
    options: Record<QueueOption, string>;
    pollSeconds: number;
    /** Objectives that may run at once; building waits on overlapping owned paths. */
    maxActiveObjectives: number;
  };
  planning: {
    /** The provider that plans and reviews. */
    provider: "codex" | "claude";
    /** Optional model choices; each adapter has defaults. */
    models?: Record<string, unknown>;
    /** Revision rounds before Factory asks; `more` grants two more. */
    revisions: number;
    /** A curated playbook file in the target, read at the base. */
    playbook: string;
  };
  execution: {
    /** Steps of one Objective running at once (independent Work Items run in parallel). */
    concurrency: number;
    /** Worker runs at once across the host. */
    workers: number;
    /** CPU-heavy steps (validation) at once across the host. */
    validations: number;
    /** Repairs of one Work Item before Factory asks. */
    repairs: number;
    /** The worker provider; defaults to the planning provider. */
    workerProvider: "codex" | "claude";
    /** The Codex worker shell's network. */
    codexNetwork: "off" | "host";
    /** Claude worker settings (model, effort, maxTurns, tools, allowedTools, permissionMode). */
    claudeWorker: Record<string, unknown>;
  };
  policy: {
    /** Operator variables a worker's shell may see, by name. */
    allowedSecretNames: string[];
  };
  finalValidation: {
    /** Commands every Objective's result must pass. */
    requiredCommands: string[];
    /** Commands that need network and run only in CI. */
    ciOnlyCommands: string[];
  };
  /** The OS sandbox every worker-caused command runs in (sandbox.ts). */
  sandbox: SandboxConfig;
}

/** The operator's `sandbox` section, with defaults filled in. */
export interface SandboxConfig {
  /**
   * Refuse to run commands when bubblewrap is unavailable (the default).
   * `false` runs them unsandboxed on a host without bubblewrap: an explicit
   * operator choice, shown by status and setup.
   */
  required: boolean;
  /**
   * `off` (the default): no command reaches the network. `package-install`:
   * only Factory's exact script-disabled dependency installs
   * (`pnpm install --frozen-lockfile --ignore-scripts`, `npm ci
   * --ignore-scripts`) reach it, to fetch packages a cold store lacks.
   */
  network: "off" | "package-install";
  /**
   * A directory of its own for package-manager caches, shared by sandboxed
   * commands: the pnpm store and metadata cache and the npm cache. Only a
   * verified install writes it. A warm store lets installs run offline.
   */
  packageStore?: string;
  /** Further host directories commands may read, such as a toolchain outside the PATH. */
  readOnlyPaths: string[];
  /**
   * Fixed environment variables for every sandboxed command, such as the
   * variable that locates a pre-provisioned tool directory. Names Factory
   * controls or that could leak or redirect are refused. A value that is an
   * absolute path should lie within `readOnlyPaths`.
   */
  environment: Record<string, string>;
  limits: SandboxLimits;
}

export interface SandboxLimits {
  /** Size of the private /tmp and /dev/shm, each, and the most TMPDIR may hold, in MiB. */
  tmpMiB: number;
  /** The most the private HOME may hold, in MiB. */
  homeMiB: number;
  /** The most a run's commands may grow their checkout by, in MiB. */
  checkoutMiB: number;
  /** Files and directories that checkout growth, HOME and TMPDIR may hold together. */
  files: number;
  /** The most a worker's candidate may stage, in MiB (GitHub's limit for one push). */
  candidateMiB: number;
  candidateFiles: number;
  /** RLIMIT_NPROC: processes the operator's account may have while a command runs. */
  processes: number;
}

const DEFAULT_SANDBOX_LIMITS: SandboxLimits = {
  tmpMiB: 1024,
  homeMiB: 4096,
  checkoutMiB: 8192,
  files: 1_000_000,
  candidateMiB: 2048,
  candidateFiles: 100_000,
  processes: 4096,
};

const SANDBOX_LIMIT_MINIMUMS: SandboxLimits = {
  tmpMiB: 16,
  homeMiB: 16,
  checkoutMiB: 16,
  files: 1024,
  candidateMiB: 16,
  candidateFiles: 1024,
  processes: 64,
};

const SANDBOX_ENVIRONMENT_NAME = /^[A-Z][A-Z0-9_]*$/;
const MAX_SANDBOX_ENVIRONMENT_VALUE_BYTES = 4096;
const REFUSED_SANDBOX_ENVIRONMENT_NAME =
  /^(PATH|HOME|TMPDIR|TMP|TEMP|SHELL|USER|LOGNAME|NODE_OPTIONS|GIT_.*|GH_.*|GITHUB_.*|LD_.*|NPM_CONFIG_.*|PNPM_.*|COREPACK_.*|YARN_.*|.*_PROXY|NODE_.*|BASH_ENV|ENV|DYLD_.*|PYTHON.*|PERL5.*|SSL_.*|CURL_.*)$|TOKEN|SECRET|PASSWORD|CREDENTIAL|KEY/;

/** The `sandbox` section checked, with defaults; problems are appended. */
function sandboxConfig(value: unknown, problems: string[]): SandboxConfig {
  const config: SandboxConfig = {
    required: true,
    network: "off",
    readOnlyPaths: [],
    environment: {},
    limits: { ...DEFAULT_SANDBOX_LIMITS },
  };
  if (value === undefined) return config;
  const object = (entry: unknown, name: string) => {
    if (entry && typeof entry === "object" && !Array.isArray(entry))
      return entry as Record<string, unknown>;
    problems.push(`${name} must be an object`);
    return undefined;
  };
  const sandbox = object(value, "sandbox");
  if (!sandbox) return config;
  const known = (
    entry: Record<string, unknown>,
    names: string[],
    name: string,
  ) => {
    for (const key of Object.keys(entry))
      if (!names.includes(key))
        problems.push(`${name}.${key} is not a setting`);
  };
  known(
    sandbox,
    [
      "required",
      "network",
      "packageStore",
      "readOnlyPaths",
      "environment",
      "limits",
    ],
    "sandbox",
  );
  if (sandbox.required !== undefined) {
    if (typeof sandbox.required === "boolean")
      config.required = sandbox.required;
    else problems.push("sandbox.required must be a boolean");
  }
  if (sandbox.network !== undefined) {
    if (sandbox.network === "off" || sandbox.network === "package-install")
      config.network = sandbox.network;
    else problems.push('sandbox.network must be "off" or "package-install"');
  }
  const absolute = (path: unknown): path is string =>
    typeof path === "string" &&
    isAbsolute(path) &&
    resolve(path) === path &&
    path !== "/";
  if (sandbox.packageStore !== undefined) {
    if (absolute(sandbox.packageStore))
      config.packageStore = sandbox.packageStore;
    else
      problems.push(
        "sandbox.packageStore must be an absolute, normalized directory path",
      );
  }
  if (sandbox.readOnlyPaths !== undefined) {
    if (
      Array.isArray(sandbox.readOnlyPaths) &&
      sandbox.readOnlyPaths.every(absolute)
    )
      config.readOnlyPaths = [...sandbox.readOnlyPaths];
    else
      problems.push(
        "sandbox.readOnlyPaths must be absolute, normalized directory paths",
      );
  }
  const environment =
    sandbox.environment === undefined
      ? undefined
      : object(sandbox.environment, "sandbox.environment");
  for (const [name, entry] of Object.entries(environment ?? {})) {
    if (!SANDBOX_ENVIRONMENT_NAME.test(name))
      problems.push(
        `sandbox.environment name ${name} must match ${SANDBOX_ENVIRONMENT_NAME.source}`,
      );
    else if (REFUSED_SANDBOX_ENVIRONMENT_NAME.test(name))
      problems.push(
        `sandbox.environment name ${name} is refused: Factory controls it or it could leak or redirect commands`,
      );
    else if (
      typeof entry !== "string" ||
      Buffer.byteLength(entry) > MAX_SANDBOX_ENVIRONMENT_VALUE_BYTES ||
      entry.includes("\0")
    )
      problems.push(
        `sandbox.environment.${name} must be a string of at most ${MAX_SANDBOX_ENVIRONMENT_VALUE_BYTES} bytes`,
      );
    else config.environment[name] = entry;
  }
  const limits =
    sandbox.limits === undefined
      ? undefined
      : object(sandbox.limits, "sandbox.limits");
  if (limits) {
    known(limits, Object.keys(SANDBOX_LIMIT_MINIMUMS), "sandbox.limits");
    for (const [name, minimum] of Object.entries(SANDBOX_LIMIT_MINIMUMS)) {
      const entry = limits[name];
      if (entry === undefined) continue;
      if (
        typeof entry === "number" &&
        Number.isSafeInteger(entry) &&
        entry >= minimum
      )
        config.limits[name as keyof SandboxLimits] = entry;
      else
        problems.push(
          `sandbox.limits.${name} must be an integer of at least ${minimum}`,
        );
    }
  }
  return config;
}

export type QueueOption =
  | "queued"
  | "planning"
  | "building"
  | "holding"
  | "done"
  | "failed"
  | "cancelled";

const DEFAULT_OPTIONS: Record<QueueOption, string> = {
  queued: "Queued",
  planning: "Planning",
  building: "Building",
  holding: "Needs you",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

export function configPath(repository: string): string {
  return (
    process.env.FACTORY_CONFIG ??
    join(
      homedir(),
      ".config",
      "factory",
      `${repository.replace("/", "__")}.json`,
    )
  );
}

/** Load and check the configuration. Throws one message naming every problem. */
export function loadConfig(repository: string): CoreConfig {
  const path = configPath(repository);
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Can't read ${path}: ${String(error)}`);
  }
  const problems: string[] = [];
  const text = (value: unknown, name: string): string => {
    if (typeof value === "string" && value.trim()) return value;
    problems.push(`${name} must be a non-empty string`);
    return "";
  };
  const queue = (raw.queue ?? {}) as Record<string, unknown>;
  const options = {
    ...DEFAULT_OPTIONS,
    ...((queue.options ?? {}) as Partial<Record<QueueOption, string>>),
  };
  const config = {
    repository: text(raw.repository, "repository"),
    checkout: text(raw.checkout, "checkout"),
    queue: {
      projectId: text(queue.projectId, "queue.projectId"),
      field:
        queue.field === undefined
          ? "Factory"
          : text(queue.field, "queue.field"),
      orderField:
        queue.orderField === undefined
          ? "Factory order"
          : text(queue.orderField, "queue.orderField"),
      options,
      pollSeconds:
        typeof queue.pollSeconds === "number" && queue.pollSeconds >= 5
          ? queue.pollSeconds
          : 30,
    },
  } as CoreConfig;
  const planning = (raw.planning ?? {}) as Record<string, unknown>;
  const provider = planning.provider ?? "codex";
  if (provider !== "codex" && provider !== "claude")
    problems.push('planning.provider must be "codex" or "claude"');
  const final = (raw.finalValidation ?? {}) as Record<string, unknown>;
  const list = (value: unknown, name: string): string[] => {
    if (value === undefined) return [];
    if (Array.isArray(value) && value.every((v) => typeof v === "string"))
      return value as string[];
    problems.push(`${name} must be a list of strings`);
    return [];
  };
  config.planning = {
    provider: provider === "claude" ? "claude" : "codex",
    ...(planning.models && typeof planning.models === "object"
      ? { models: planning.models as Record<string, unknown> }
      : {}),
    revisions:
      typeof planning.revisions === "number" && planning.revisions >= 0
        ? planning.revisions
        : 4,
    playbook:
      typeof planning.playbook === "string"
        ? planning.playbook
        : ".factory/playbook.md",
  };
  const execution = (raw.execution ?? {}) as Record<string, unknown>;
  const count = (value: unknown, name: string, fallback: number): number => {
    if (value === undefined) return fallback;
    if (typeof value === "number" && Number.isInteger(value) && value >= 1)
      return value;
    problems.push(`${name} must be a whole number of at least 1`);
    return fallback;
  };
  const cpus = availableParallelism();
  config.queue.maxActiveObjectives = count(
    queue.maxActiveObjectives,
    "queue.maxActiveObjectives",
    3,
  );
  config.execution = {
    concurrency: count(execution.concurrency, "execution.concurrency", 8),
    workers: count(
      execution.workers,
      "execution.workers",
      Math.max(2, Math.floor(cpus / 2)),
    ),
    validations: count(
      execution.validations,
      "execution.validations",
      Math.max(2, Math.floor(cpus / 4)),
    ),
    repairs: count(execution.repairs, "execution.repairs", 6),
    workerProvider:
      execution.workerProvider === "claude" ||
      execution.workerProvider === "codex"
        ? execution.workerProvider
        : config.planning.provider,
    codexNetwork: execution.codexNetwork === "host" ? "host" : "off",
    claudeWorker:
      execution.claudeWorker && typeof execution.claudeWorker === "object"
        ? (execution.claudeWorker as Record<string, unknown>)
        : {},
  };
  const policy = (raw.policy ?? {}) as Record<string, unknown>;
  config.policy = {
    allowedSecretNames: list(
      policy.allowedSecretNames,
      "policy.allowedSecretNames",
    ),
  };
  config.finalValidation = {
    requiredCommands: list(
      final.requiredCommands,
      "finalValidation.requiredCommands",
    ),
    ciOnlyCommands: list(
      final.ciOnlyCommands,
      "finalValidation.ciOnlyCommands",
    ),
  };
  config.sandbox = sandboxConfig(raw.sandbox, problems);
  if (config.repository && config.repository !== repository)
    problems.push(
      `repository is ${config.repository}, but the command named ${repository}`,
    );
  if (problems.length) throw new Error(`${path}: ${problems.join("; ")}`);
  return config;
}
