import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Allowances, DEFAULT_ALLOWANCES } from "./allowances.js";
import {
  DEFAULT_RESERVATIONS,
  hostDefaults,
  type Reservations,
} from "./capacity.js";
import {
  absolute,
  type Check,
  directories,
  flag,
  isObject,
  object,
  oneOf,
  optional,
  type Retired,
  section,
  strings,
  text,
  whole,
} from "./checked.js";
import { remoteRepository } from "./git.js";
import { type PlanningContext, planningContext } from "./knowledge/settings.js";
import { CAPTURE_OFF, type CaptureSettings } from "./log.js";
import { stateRoot, within } from "./paths.js";
import { serviceCredential } from "./providers/claude.js";
import {
  type ExecutionProfile,
  executionProfiles,
  type ProviderConfig,
  profileProblems,
  providersConfig,
} from "./providers/config.js";
import { DEFAULT_SESSIONS, type SessionPolicy } from "./providers/session.js";
import {
  loadReviewArtifacts,
  type ReviewArtifactSelector,
} from "./review/artifacts.js";
import { localRootRefusal, real } from "./sandbox.js";
import { DEFAULT_COMMAND_TIMEOUT_SECONDS } from "./validate.js";

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
    /**
     * Each Objective's deadline, counted from its admission and saved then
     * (state.ts `deadline`), so a later change moves no admitted one; at
     * it the Objective is cancelled. Absent: no deadline.
     */
    objectiveDeadlineSeconds?: number;
  };
  /** Named planner and worker pairs (providers/config.ts). */
  providers: Record<string, ProviderConfig>;
  /** The provider new work uses unless `serve --provider` names another. */
  defaultProvider: string;
  planning: {
    /** A curated playbook file in the target, read at the base. */
    playbook: string;
    /** Admits Adaptive workflow Objectives; absent, they are refused. */
    context?: PlanningContext;
  };
  execution: {
    /** Steps of one Objective running at once (independent Work Items run in parallel). */
    concurrency: number;
    /** Worker runs at once across the host. */
    workers: number;
    /** CPU-heavy steps (validation) at once across the host. */
    validations: number;
    /** Planner calls (planning rounds and reviews) at once across the host. */
    planners: number;
    /** MiB the running steps may reserve together (capacity.ts). */
    memoryMiB: number;
    /** MiB a worker run, a validation and a planner call each reserve. */
    reservations: Reservations;
    /**
     * Named providers' workers the planner assigns per Work Item, by id;
     * absent, every item runs on its Objective's provider.
     */
    profiles?: Record<string, ExecutionProfile>;
  };
  /** How much an Objective may do unattended; frozen with it. */
  autonomy: {
    /** What an Objective may spend before Factory asks (allowances.ts). */
    allowances: Allowances;
    /**
     * Operator variables (names in policy.allowedSecretNames) that must be
     * set before planning starts; the check holds while one isn't.
     */
    requiredEnvironment: string[];
  };
  policy: {
    /** Operator variables a worker's shell may see, by name. */
    allowedSecretNames: string[];
    /**
     * The operator's reviewed Secretlint rules, outside the target checkout;
     * absent, Factory's packaged rules apply.
     */
    secretlintConfig?: string;
  };
  /**
   * Every secret value Factory's output is redacted of, derived once here:
   * the allowedSecretNames values and each managed provider's credential.
   */
  secrets: string[];
  validation: {
    /**
     * Each validation command's limit; past it the command failed. A
     * validation step's deadline is its commands times this, plus a margin.
     */
    commandTimeoutSeconds: number;
  };
  finalValidation: {
    /** Commands every Objective's result must pass. */
    requiredCommands: string[];
    /** Commands that need network and run only in CI. */
    ciOnlyCommands: string[];
  };
  delivery: {
    /**
     * `regular` (the default): one PR per Work Item. `native-stack`: each
     * linear chain of the plan (planning/units.ts) is delivered as chained
     * PRs and merged as one GitHub native stack; single-item units stay
     * ordinary PRs.
     */
    kind: "regular" | "native-stack";
  };
  /**
   * Validation outputs captured as review evidence (review/artifacts.ts);
   * empty when the operator names none.
   */
  reviewArtifacts: ReviewArtifactSelector[];
  /** The OS sandbox every worker-caused command runs in (sandbox.ts). */
  sandbox: SandboxConfig;
  media: {
    /**
     * Host directories a "local" source asset may come from, by real path;
     * empty (the default) turns local assets off. A directory that would
     * show workers what the sandbox seals is refused.
     */
    localAssetRoots: string[];
  };
  /**
   * Factory's progress comments on each Objective issue, on by default:
   * the live status comment (progress.ts), a failure's evidence in its
   * question comment, the 24 h reminders, the status note and the
   * cancel comment (github-sync.ts). Question comments always post: they
   * are how a question is answered on GitHub. `includeQuestions` (default
   * true) lists the open questions in the live status comment. Display
   * only: operational, so changing it never holds a started Objective.
   */
  progress: { enabled: boolean; includeQuestions: boolean };
  /**
   * One display-only issue per Work Item (tracking.ts), on by default:
   * a sub-issue of the Objective with blocked-by links that mirror the
   * plan, a card on the Project and a live comment. Each role's issue gets
   * its role label and the native type `issueType` names for it (Feature
   * for the Objective, Task for a Work Item), where the repository offers
   * it. Operational, like `progress`.
   */
  tracking: {
    enabled: boolean;
    issueType: { objective: string; workItem: string };
  };
  /**
   * Model call bodies to capture files (log.ts CaptureSettings); off by
   * default. Operational: never frozen with an Objective.
   */
  capture: CaptureSettings;
  /**
   * Retained conversations (providers/session.ts): planner rounds, review
   * rounds and worker repairs continue the provider's session by id, on
   * by default, each for at most `maxTurns` turns and `maxIdleMinutes`
   * between them. Operational: never frozen with an Objective.
   */
  sessions: SessionPolicy;
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
   * absolute path should lie within `readOnlyPaths`. Never a secret: values
   * are not redacted (a secret goes in policy.allowedSecretNames).
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

/** `sandbox.environment`: fixed variables, with refused names left out. */
const sandboxEnvironment: Check<Record<string, string>> = (
  value,
  path,
  problems,
) => {
  const environment: Record<string, string> = {};
  if (value === undefined) return environment;
  if (!isObject(value)) {
    problems.push(`${path} must be an object`);
    return environment;
  }
  for (const [name, entry] of Object.entries(value)) {
    if (!SANDBOX_ENVIRONMENT_NAME.test(name))
      problems.push(
        `${path} name ${name} must match ${SANDBOX_ENVIRONMENT_NAME.source}`,
      );
    else if (REFUSED_SANDBOX_ENVIRONMENT_NAME.test(name))
      problems.push(
        `${path} name ${name} is refused: Factory controls it or it could leak or redirect commands`,
      );
    else if (
      typeof entry !== "string" ||
      Buffer.byteLength(entry) > MAX_SANDBOX_ENVIRONMENT_VALUE_BYTES ||
      entry.includes("\0")
    )
      problems.push(
        `${path}.${name} must be a string of at most ${MAX_SANDBOX_ENVIRONMENT_VALUE_BYTES} bytes`,
      );
    else environment[name] = entry;
  }
  return environment;
};

const sandboxSection = object({
  required: flag(true),
  network: oneOf(["off", "package-install"] as const, "off"),
  packageStore: optional<string>((value, path, problems) => {
    if (absolute(value)) return value;
    problems.push(`${path} must be an absolute, normalized directory path`);
    return "";
  }),
  readOnlyPaths: directories,
  environment: sandboxEnvironment,
  limits: object(
    Object.fromEntries(
      Object.entries(SANDBOX_LIMIT_MINIMUMS).map(([name, minimum]) => [
        name,
        whole(minimum, DEFAULT_SANDBOX_LIMITS[name as keyof SandboxLimits]),
      ]),
    ) as Record<keyof SandboxLimits, Check<number>>,
  ),
});

/** `media.localAssetRoots`: directories that show workers nothing sealed. */
const localAssetRoots: Check<string[]> = (value, path, problems) =>
  directories(value, path, problems).filter((root) => {
    const refused = localRootRefusal(root);
    if (refused) problems.push(`${path}: ${refused}`);
    return !refused;
  });

export type QueueOption =
  | "queued"
  | "planning"
  | "building"
  | "holding"
  | "done"
  /** No status shows it any more; kept so configurations that name it load. */
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

/** A directory's package.json name, or undefined. */
function packageName(directory: string): string | undefined {
  try {
    const { name } = JSON.parse(
      readFileSync(join(directory, "package.json"), "utf8"),
    ) as { name?: unknown };
    return typeof name === "string" ? name : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Why Factory must not run on this target, or undefined: Factory never
 * runs on its own repository, by name or by a checkout whose package is
 * Factory, since its work would change the code that runs it. Factory's
 * name and repository come from its own package.json. Checked when the
 * configuration loads (setup, serve) and when an Objective is checked.
 */
export function ownRepositoryProblem(
  repository: string,
  checkout: string,
): string | undefined {
  let own: { name?: string; repository?: { url?: string } | string } = {};
  let directory = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    try {
      own = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
      break;
    } catch {
      if (dirname(directory) === directory)
        return "Factory can't read its own package.json to tell itself from the target; reinstall Factory";
      directory = dirname(directory);
    }
  }
  const url =
    typeof own.repository === "string" ? own.repository : own.repository?.url;
  const ownRepository = url && remoteRepository(url.replace(/^git\+/, ""));
  if (ownRepository && repository.toLowerCase() === ownRepository)
    return `${repository} is Factory's own repository, and Factory never runs on the code that runs it; name another target repository`;
  if (!own.name || !checkout) return undefined;
  // The checkout, and the top of the clone it lies in.
  const places = [checkout];
  try {
    places.push(
      execFileSync("git", ["-C", checkout, "rev-parse", "--show-toplevel"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 10_000,
      }).trim(),
    );
  } catch {
    // Not in a Git repository: the checkout alone.
  }
  if (places.some((place) => place && packageName(place) === own.name))
    return `The checkout ${checkout} is in a Factory checkout (its package is ${own.name}), and Factory never runs on the code that runs it; point checkout at a clone of the target repository`;
  return undefined;
}

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

/** Shorter values would redact ordinary text. */
const MIN_SECRET_LENGTH = 4;

/**
 * The values of the operator variables workers may see, and of each managed
 * provider's credential (apiKeyEnv, credentialEnv) from the environment or
 * the service's credentials. Only `names` reach a worker's environment;
 * all of them are redacted from output.
 */
function secretValues(
  names: readonly string[],
  providers: Record<string, ProviderConfig>,
): string[] {
  const credentials = Object.values(providers).flatMap(({ worker }) =>
    worker.kind === "openai-agents"
      ? [worker.apiKeyEnv]
      : worker.kind === "claude-managed-agents"
        ? [worker.credentialEnv]
        : [],
  );
  const values = new Set<string>();
  for (const name of names) values.add(process.env[name] ?? "");
  for (const name of credentials) {
    let value = process.env[name];
    try {
      value ??= serviceCredential(name);
    } catch {
      // An unreadable credential can't be used, so it can't be written.
    }
    values.add(value ?? "");
  }
  return [...values].filter((value) => value.length >= MIN_SECRET_LENGTH);
}

/** What replaced each key an earlier Factory configuration used. */
const PROVIDERS_HINT = "name the planner and worker under providers.<name>";
const RETIRED: Record<string, Retired> = {
  "": {
    schemaVersion: "the configuration has no schema version; remove it",
    gitPersistence: "removed: Factory keeps no remote state history",
    nativeBoundaryTelemetry:
      "removed: Codex native telemetry is always read into each call's model-usage event",
    planningContext: "moved to planning.context",
    githubManagement:
      "removed: Factory always writes queue.field and progress comments",
    scheduling: "host limits are execution.workers and execution.validations",
  },
  queue: {
    project:
      "use queue.projectId, queue.field, queue.orderField and queue.options",
    orderFieldId: "queue.orderField names the order field",
    metadataFieldId: "removed: Factory keeps no metadata field",
    controlItemId: "removed: Factory has no control card",
    factoryManagedFields:
      "removed: Factory manages queue.field and queue.orderField",
  },
  planning: {
    provider: PROVIDERS_HINT,
    models: PROVIDERS_HINT,
    revisions: "moved to autonomy.allowances.planningRevisions",
    adaptiveGraph: "the adaptive graph is not part of Factory; remove the key",
    discoveryLimits: "discovery items are not part of Factory; remove the key",
    maxExpansionChildren:
      "the adaptive graph is not part of Factory; remove the key",
  },
  execution: {
    repairs:
      "replaced by autonomy.allowances.perPath (repairs of one Work Item) and autonomy.allowances.implementationRepairs (the Objective's)",
    workerProvider: PROVIDERS_HINT,
    codexNetwork: "use providers.<name>.worker.network",
    claudeWorker: PROVIDERS_HINT,
    kind: PROVIDERS_HINT,
    harness: PROVIDERS_HINT,
    defaultProfile:
      "removed: a Work Item without a profile runs on its Objective's provider",
  },
  policy: {
    network: "use providers.<name>.worker.network for a Codex worker",
  },
  autonomy: {
    repairClasses:
      "replaced: every failure holds with its cause, and your answer decides",
    repairPolicy: "per-path repairs are autonomy.allowances.perPath",
  },
};

const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Names a worker never receives (worktree.ts), so requiring one checks nothing. */
const WITHHELD_NAME = /^(GH|GITHUB|GIT|SSH)_/i;

/** `autonomy.requiredEnvironment`: distinct variable names a worker can get. */
const environmentNames: Check<string[]> = (value, path, problems) => {
  const names = strings(value, path, problems);
  if (
    names.some((name) => !ENVIRONMENT_NAME.test(name)) ||
    new Set(names).size !== names.length
  )
    problems.push(
      `${path} must be distinct variable names matching ${ENVIRONMENT_NAME.source}`,
    );
  for (const name of names.filter((each) => WITHHELD_NAME.test(each)))
    problems.push(
      `${path} names ${name}, which workers never receive (GH_, GITHUB_, GIT_ and SSH_ variables are withheld)`,
    );
  return names;
};

/**
 * `policy.secretlintConfig`: an absolute regular file, not a link, outside
 * the target checkout. Collection reads it.
 */
const secretlintConfig: Check<string> = (value, path, problems) => {
  if (absolute(value) && lstatSync(value, { throwIfNoEntry: false })?.isFile())
    return value;
  problems.push(`${path} must be an absolute path of a regular file`);
  return "";
};

/**
 * Load and check the configuration: every section through checked.ts, so
 * an unknown key is refused by name. Throws one message naming every
 * problem.
 */
export function loadConfig(repository: string): CoreConfig {
  const path = configPath(repository);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Can't read ${path}: ${String(error)}`);
  }
  const problems: string[] = [];
  const host = hostDefaults();
  const checked = section(
    raw,
    "",
    {
      repository: text(repository),
      checkout: text(),
      queue: object(
        {
          projectId: text(),
          field: text("Factory"),
          orderField: text("Factory order"),
          options: object(
            Object.fromEntries(
              Object.entries(DEFAULT_OPTIONS).map(([name, option]) => [
                name,
                text(option),
              ]),
            ) as Record<QueueOption, Check<string>>,
          ),
          pollSeconds: whole(5, 30),
          maxActiveObjectives: whole(1, 3),
          objectiveDeadlineSeconds: optional(whole(60)),
        },
        RETIRED.queue,
      ),
      providers: (value) => value,
      defaultProvider: (value) => value,
      planning: object(
        {
          playbook: text(".factory/playbook.md"),
          context: optional(planningContext),
        },
        RETIRED.planning,
      ),
      execution: object(
        {
          concurrency: whole(1, 8),
          workers: whole(1, host.workers),
          validations: whole(1, host.validations),
          planners: optional(whole(1)),
          memoryMiB: whole(256, host.budgetMiB),
          reservations: object(
            Object.fromEntries(
              Object.entries(DEFAULT_RESERVATIONS).map(([name, fallback]) => [
                name,
                whole(0, fallback),
              ]),
            ) as Record<keyof Reservations, Check<number>>,
          ),
          profiles: executionProfiles,
        },
        RETIRED.execution,
      ),
      autonomy: object(
        {
          allowances: object(
            Object.fromEntries(
              Object.entries(DEFAULT_ALLOWANCES).map(([name, fallback]) => [
                name,
                whole(0, fallback),
              ]),
            ) as Record<keyof Allowances, Check<number>>,
          ),
          requiredEnvironment: environmentNames,
        },
        RETIRED.autonomy,
      ),
      policy: object(
        {
          allowedSecretNames: strings,
          secretlintConfig: optional(secretlintConfig),
        },
        RETIRED.policy,
      ),
      validation: object({
        commandTimeoutSeconds: whole(1, DEFAULT_COMMAND_TIMEOUT_SECONDS),
      }),
      finalValidation: object({
        requiredCommands: strings,
        ciOnlyCommands: strings,
      }),
      delivery: object({
        kind: oneOf(["regular", "native-stack"] as const, "regular"),
      }),
      reviewArtifacts: (value, _path, found) =>
        loadReviewArtifacts(value, found),
      sandbox: sandboxSection,
      media: object({ localAssetRoots }),
      progress: object({
        enabled: flag(true),
        includeQuestions: flag(true),
      }),
      tracking: object({
        enabled: flag(true),
        issueType: object({
          objective: text("Feature"),
          workItem: text("Task"),
        }),
      }),
      capture: object(
        {
          enabled: flag(CAPTURE_OFF.enabled),
          maxBytesPerCall: whole(
            1024,
            CAPTURE_OFF.maxBytesPerCall,
            256 * 1024 * 1024,
          ),
        },
        {
          maxBytesPerInvocation: "renamed capture.maxBytesPerCall",
          retainInRecovery: "removed: Factory keeps no recovery archive",
        },
      ),
      sessions: object({
        enabled: flag(DEFAULT_SESSIONS.enabled),
        maxTurns: whole(1, DEFAULT_SESSIONS.maxTurns, 100),
        maxIdleMinutes: whole(1, DEFAULT_SESSIONS.maxIdleMinutes, 24 * 60),
      }),
    },
    problems,
    RETIRED[""],
  );
  const { providers, defaultProvider } = providersConfig(
    isObject(raw) ? raw : {},
    problems,
  );
  const execution = {
    ...checked.execution,
    reservations: { ...checked.execution.reservations },
    // Two planner calls per worker: each Work Item is reviewed beside its work.
    planners: checked.execution.planners ?? 2 * checked.execution.workers,
  };
  // A default reservation fits a small budget; one the operator set must.
  const given =
    isObject(raw) && isObject(raw.execution)
      ? raw.execution.reservations
      : undefined;
  for (const [name, mib] of Object.entries(execution.reservations))
    if (mib <= execution.memoryMiB) continue;
    else if (isObject(given) && given[name] !== undefined)
      problems.push(
        `execution.reservations.${name} ${mib} is more than execution.memoryMiB ${execution.memoryMiB}, so that step could never start`,
      );
    else
      execution.reservations[name as keyof Reservations] = execution.memoryMiB;
  const config: CoreConfig = {
    ...checked,
    execution,
    providers,
    defaultProvider,
    secrets: secretValues(checked.policy.allowedSecretNames, providers),
  };
  profileProblems(
    config.execution.profiles,
    providers,
    config.secrets,
    problems,
  );
  if (config.repository !== repository)
    problems.push(
      `repository is ${config.repository}, but the command named ${repository}`,
    );
  // The target's files never hold Factory's configuration, state or rules,
  // and a worker's worktree (under the state directory) never holds the rules.
  const state = stateRoot();
  const rules = config.policy.secretlintConfig;
  // Both the given path and its real path: a path through a link the
  // target commits passes a real-path check, and each read follows it again.
  for (const [name, inside, root, where] of [
    ["The configuration file", path, config.checkout, "the target checkout"],
    ["The state directory", state, config.checkout, "the target checkout"],
    ["policy.secretlintConfig", rules, config.checkout, "the target checkout"],
    ["policy.secretlintConfig", rules, state, "the state directory"],
  ] as const)
    if (
      inside &&
      root &&
      [resolve(inside), real(inside)].some((candidate) =>
        [resolve(root), real(root)].some((base) => within(candidate, base)),
      )
    )
      problems.push(`${name} ${inside} must be outside ${where} ${root}`);
  // A required variable a worker may not see would be checked for nothing.
  for (const name of config.autonomy.requiredEnvironment)
    if (!config.policy.allowedSecretNames.includes(name))
      problems.push(
        `autonomy.requiredEnvironment names ${name}, which policy.allowedSecretNames doesn't allow`,
      );
  const own = ownRepositoryProblem(config.repository, config.checkout);
  if (own) problems.push(own);
  if (process.env.FACTORY_SECRETLINT_CONFIG !== undefined)
    problems.push(
      "FACTORY_SECRETLINT_CONFIG is no longer read: set policy.secretlintConfig",
    );
  if (problems.length) throw new Error(`${path}: ${problems.join("; ")}`);
  return config;
}
