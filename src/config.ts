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
  section,
  strings,
  text,
  whole,
} from "./checked.js";
import { serviceCredential } from "./credentials.js";
import { remoteRepository } from "./git.js";
import { type PlanningContext, planningContext } from "./knowledge/settings.js";
import { CAPTURE_OFF, type CaptureSettings } from "./log.js";
import { stateRoot, within } from "./paths.js";
import {
  COPILOT_REDACTED,
  copilotConfigured,
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
import type { SpendLimits } from "./spend.js";
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
    /** The planning context, memory and lookups every Objective gets. */
    context: PlanningContext;
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
    /** Model spend per Objective and per day before Factory asks (spend.ts); absent: no limit. */
    spend?: SpendLimits;
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
    /**
     * The repository's formatter, such as `pnpm exec biome check --write .`
     * (#2159). Factory runs it on each Work Item's result in the validation
     * checkout, after the install and before the item's commands, with no
     * network, and commits what it changed on the result as its own change
     * (validate.ts `applyFormatter`), so no model formats by hand. Absent
     * (the default): nothing is formatted. Frozen with an Objective.
     */
    formatCommand?: string;
  };
  /**
   * A Work Item's result review (review/item.ts, #2344): its mutation pass
   * seeds at most `mutants` mutants of the lines the result added to
   * product files (0 turns the pass off) and takes at most
   * `mutationSeconds` of wall time (review/mutants.ts), and the reviewer
   * sees its survivors once it measured `measuredMutants`; the reviewer's
   * `run_command` runs at most `commands` commands in at most
   * `commandSeconds` in all; at most `proofs` suspicions are proved (0:
   * none, so the review refuses nothing), each with at most
   * `proofCommands` commands in at most `proofSeconds`. Operational: a
   * change applies from the next review.
   */
  review: {
    mutants: number;
    mutationSeconds: number;
    measuredMutants: number;
    commandSeconds: number;
    commands: number;
    proofs: number;
    proofCommands: number;
    proofSeconds: number;
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
    /**
     * Off unless set (#2098): the one workflow Factory may run on the
     * default branch, a file in the top level of `.github/workflows` that
     * runs on `workflow_dispatch` and that the operator declares free of
     * side effects (nothing deploys or releases from it, and nothing runs
     * after it). When a PR's failed check last passed on the default
     * branch's head in a run of this workflow a day or more before it
     * failed, Factory dispatches the workflow there and compares the PR's
     * failure with that fresh run (delivery.ts `freshBase`). Without it,
     * Factory runs nothing on the default branch. Frozen with an
     * Objective: it grants Factory authority there.
     */
    baseRerun?: { workflow: string };
  };
  /**
   * Validation outputs captured as review evidence (review/artifacts.ts);
   * empty when the operator names none.
   */
  reviewArtifacts: ReviewArtifactSelector[];
  /** The OS sandbox every worker-caused command runs in (sandbox.ts). */
  sandbox: SandboxConfig;
  /**
   * The host's toolchains mise doesn't pin (#2182). Operational: it
   * operates the host, never decides the work.
   */
  toolchain: {
    /**
     * Directories `setup --background` puts on the service unit's PATH,
     * after the checkout's mise pins and before the setup shell's PATH, so
     * a setup run from a shell without them keeps them.
     */
    path: string[];
    /**
     * Executables validation needs that no command names first (such as
     * `pg_ctl`, which a test suite starts): readiness blocks while one
     * isn't on the PATH the service runs with.
     */
    executables: string[];
  };
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
  /**
   * Factory's GitHub identity. `app` names its GitHub App (github-app.ts):
   * Factory acts as the App's installation on the repository, found by
   * the repository unless `installationId` names it. The App's private
   * key is never here (github-app.ts GITHUB_APP_KEY). `login: true` is the
   * operator's recorded opt-out: Factory acts as the GitHub CLI's login
   * (or FACTORY_GITHUB_TOKEN). One of the two, never both; with neither,
   * readiness blocks and the service refuses to start until the
   * configuration names one (github-app.ts identityUnchosen). `reserve`
   * is the requests of the installation's hourly budget kept for work
   * that can't wait: below it, work that can waits for the reset
   * (github-sync.ts `tick`). Operational.
   */
  github: {
    app?: { id: number; installationId?: number };
    login: boolean;
    reserve: number;
  };
  /**
   * The GitHub logins a hold, an Objective's report and a cancel mention,
   * so GitHub notifies them. Operational.
   */
  operators: string[];
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
   * `host`: every sandboxed command (validation, installs and a Claude
   * worker's shell) shares the host's network namespace, for validation
   * that needs a service on the host such as a database or a browser.
   */
  network: "off" | "package-install" | "host";
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
  /**
   * Throwaway services each worker attempt's shell and each validation run
   * gets, by name (work/services.ts), such as a PostgreSQL tests use;
   * absent: none. Operational, as `toolchain`: they are the host's means to
   * run the commands, so a broken entry is fixed under a running Objective.
   */
  services?: Record<string, SandboxService>;
  limits: SandboxLimits;
}

/** One `sandbox.services` entry. */
export interface SandboxService {
  /**
   * Starts the service in the foreground (`sh -c`, so `exec` the server):
   * it is stopped when the run (a worker attempt, a validation) ends, and
   * its exit before then is a failure. `$FACTORY_SERVICE_DIR` is its
   * private directory, where it keeps its data and its socket.
   */
  start: string;
  /** Exits zero once the service is ready; run until it does, for at most a minute. */
  ready: string;
  /**
   * Variables the run's commands get, checked as `sandbox.environment`;
   * `${FACTORY_SERVICE_DIR}` in a value is the service's directory.
   */
  environment: Record<string, string>;
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
  /**
   * The installation's shared install store (`<work root>/.packages`, one
   * directory per `installKey`): a key unused for this many days is pruned,
   * and, once the keys hold more than `installStoreMiB` MiB in all, the
   * least recently used until they fit. A key used in the last hour or
   * with an install running is never pruned.
   */
  installStoreDays: number;
  installStoreMiB: number;
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
  installStoreDays: 14,
  installStoreMiB: 20_480,
  processes: 4096,
};

const SANDBOX_LIMIT_MINIMUMS: SandboxLimits = {
  tmpMiB: 16,
  homeMiB: 16,
  checkoutMiB: 16,
  files: 1024,
  candidateMiB: 16,
  candidateFiles: 1024,
  installStoreDays: 1,
  installStoreMiB: 256,
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

const SERVICE_NAME = /^[a-z][a-z0-9-]{0,31}$/;

const serviceSection = object({
  start: text(),
  ready: text(),
  environment: sandboxEnvironment,
});

/** `sandbox.services`: entries by name; absent when there are none. */
const sandboxServices: Check<Record<string, SandboxService> | undefined> = (
  value,
  path,
  problems,
) => {
  if (value === undefined) return undefined;
  if (!isObject(value)) {
    problems.push(`${path} must be an object`);
    return undefined;
  }
  const services: Record<string, SandboxService> = {};
  for (const [name, entry] of Object.entries(value)) {
    if (!SERVICE_NAME.test(name))
      problems.push(`${path} name ${name} must match ${SERVICE_NAME.source}`);
    services[name] = serviceSection(entry, `${path}.${name}`, problems);
  }
  return Object.keys(services).length ? services : undefined;
};

const sandboxSection = object({
  required: flag(true),
  network: oneOf(["off", "package-install", "host"] as const, "off"),
  packageStore: optional<string>((value, path, problems) => {
    if (absolute(value)) return value;
    problems.push(`${path} must be an absolute, normalized directory path`);
    return "";
  }),
  readOnlyPaths: directories,
  environment: sandboxEnvironment,
  services: sandboxServices,
  limits: object(
    Object.fromEntries(
      Object.entries(SANDBOX_LIMIT_MINIMUMS).map(([name, minimum]) => [
        name,
        whole(minimum, DEFAULT_SANDBOX_LIMITS[name as keyof SandboxLimits]),
      ]),
    ) as Record<keyof SandboxLimits, Check<number>>,
  ),
});

/**
 * `toolchain.path`: distinct absolute directories, each one PATH entry (no
 * `:`, which would split it, and no line break, which the unit can't hold).
 */
const toolchainDirectories: Check<string[]> = (value, path, problems) => {
  const entries = directories(value, path, problems);
  if (
    entries.some((entry) => /[:\n\r\0]/.test(entry)) ||
    new Set(entries).size !== entries.length
  )
    problems.push(
      `${path} must be distinct directories, each without a colon or line break`,
    );
  return entries;
};

const EXECUTABLE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._+-]*$/;

/** `toolchain.executables`: distinct executable names, not paths. */
const executableNames: Check<string[]> = (value, path, problems) => {
  const names = strings(value, path, problems);
  if (
    names.some((name) => !EXECUTABLE_NAME.test(name)) ||
    new Set(names).size !== names.length
  )
    problems.push(
      `${path} must be distinct executable names (such as "pg_ctl"), not paths`,
    );
  return names;
};

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
  | "cancelled";

const DEFAULT_OPTIONS: Record<QueueOption, string> = {
  queued: "Queued",
  planning: "Planning",
  building: "Building",
  holding: "Needs you",
  done: "Done",
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
 * The values of the operator variables workers may see, and, from the
 * environment or the service's credentials, of each managed provider's
 * credential (apiKeyEnv, credentialEnv) and, with Copilot configured, of
 * its secrets and endpoint (COPILOT_REDACTED). Only `names` reach a
 * worker's environment; all of them are redacted from output.
 */
function secretValues(
  names: readonly string[],
  providers: Record<string, ProviderConfig>,
): string[] {
  const credentials = [
    ...Object.values(providers).flatMap(({ worker }) =>
      worker.kind === "openai-agents"
        ? [worker.apiKeyEnv]
        : worker.kind === "claude-managed-agents"
          ? [worker.credentialEnv]
          : [],
    ),
    ...(copilotConfigured(providers) ? COPILOT_REDACTED : []),
  ];
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

const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Names a worker never receives (worktree.ts), so requiring one checks nothing. */
const WITHHELD_NAME = /^(GH|GITHUB|GIT|SSH)_/i;

/** `autonomy.requiredEnvironment`: distinct variable names a worker can get. */
/** A spend limit: whole tokens, whole cents of list cost, or both. */
const limit = object({ tokens: optional(whole(1)), cents: optional(whole(1)) });

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

/** A GitHub user's login: letters, digits and single hyphens inside, at most 39. */
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

/** `operators`: distinct GitHub logins, empty by default. */
const logins: Check<string[]> = (value, path, problems) => {
  const names = strings(value, path, problems);
  if (
    names.some((name) => !LOGIN.test(name)) ||
    new Set(names.map((name) => name.toLowerCase())).size !== names.length
  )
    problems.push(
      `${path} must be distinct GitHub logins (letters, digits and hyphens, without the @)`,
    );
  return names;
};

/** A workflow file name in the top level of `.github/workflows`. */
const WORKFLOW_FILE = /^[A-Za-z0-9_][A-Za-z0-9._-]*\.ya?ml$/;

/**
 * `delivery.baseRerun.workflow`: a workflow's file name, as GitHub's
 * workflow dispatch takes it (`quality.yml`), not a path.
 */
const workflowFile: Check<string> = (value, path, problems) => {
  if (typeof value === "string" && WORKFLOW_FILE.test(value)) return value;
  problems.push(
    `${path} must be a workflow's file name in .github/workflows, such as "quality.yml"`,
  );
  return "";
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
      queue: object({
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
      }),
      providers: (value) => value,
      defaultProvider: (value) => value,
      planning: object({
        playbook: text(".factory/playbook.md"),
        context: planningContext,
      }),
      execution: object({
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
      }),
      autonomy: object({
        allowances: object(
          Object.fromEntries(
            Object.entries(DEFAULT_ALLOWANCES).map(([name, fallback]) => [
              name,
              whole(0, fallback),
            ]),
          ) as Record<keyof Allowances, Check<number>>,
        ),
        spend: optional(
          object({ perObjective: optional(limit), perDay: optional(limit) }),
        ),
        requiredEnvironment: environmentNames,
      }),
      policy: object({
        allowedSecretNames: strings,
        secretlintConfig: optional(secretlintConfig),
      }),
      validation: object({
        commandTimeoutSeconds: whole(1, DEFAULT_COMMAND_TIMEOUT_SECONDS),
        formatCommand: optional(text()),
      }),
      review: object({
        mutants: whole(0, 20, 1000),
        mutationSeconds: whole(0, 90, 24 * 60 * 60),
        measuredMutants: whole(0, 10, 1000),
        commandSeconds: whole(0, 60, 24 * 60 * 60),
        commands: whole(0, 20, 1000),
        proofs: whole(0, 10, 1000),
        proofCommands: whole(0, 8, 1000),
        proofSeconds: whole(0, 120, 24 * 60 * 60),
      }),
      finalValidation: object({
        requiredCommands: strings,
        ciOnlyCommands: strings,
      }),
      delivery: object({
        kind: oneOf(["regular", "native-stack"] as const, "regular"),
        baseRerun: optional(object({ workflow: workflowFile })),
      }),
      reviewArtifacts: (value, _path, found) =>
        loadReviewArtifacts(value, found),
      sandbox: sandboxSection,
      toolchain: object({
        path: toolchainDirectories,
        executables: executableNames,
      }),
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
      capture: object({
        enabled: flag(CAPTURE_OFF.enabled),
        maxBytesPerCall: whole(
          1024,
          CAPTURE_OFF.maxBytesPerCall,
          256 * 1024 * 1024,
        ),
      }),
      sessions: object({
        enabled: flag(DEFAULT_SESSIONS.enabled),
        maxTurns: whole(1, DEFAULT_SESSIONS.maxTurns, 100),
        maxIdleMinutes: whole(1, DEFAULT_SESSIONS.maxIdleMinutes, 24 * 60),
      }),
      github: object({
        app: optional(
          object({ id: whole(1), installationId: optional(whole(1)) }),
        ),
        login: flag(false),
        reserve: whole(0, 100),
      }),
      operators: logins,
    },
    problems,
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
  if (config.github.app && config.github.login)
    problems.push(
      "github.app and github.login are both set: Factory acts as its GitHub App or, by the operator's choice, as the GitHub CLI's login; remove one",
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
