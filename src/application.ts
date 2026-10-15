import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { assertAgentSessionCapabilities } from "./agent-session.js";
import { ClaudePlanningModel } from "./claude-planning.js";
import { CodexPlanningModel, type PlanCandidate } from "./compiler.js";
import type { FactoryConfig, JsonValue, LocalHarnessConfig } from "./config.js";
import {
  CLAUDE_AGENT_SDK_ADAPTER_IDENTITY,
  factoryConfigDigest,
  GITHUB_COPILOT_SDK_ADAPTER_IDENTITY,
  harnessAdapterIdentity,
  resolveCapacity,
  stateRoot,
  validateConfig,
  validateTarget,
} from "./config.js";
import { LocalContentStore } from "./content/local.js";
import type {
  AgentHarness,
  AgentSessionCapabilities,
  AgentSessionRef,
  AgentSessionRole,
  GitHubGateway,
  PlanningModel,
} from "./contracts.js";
import { NativeStackDelivery } from "./delivery/native-stack.js";
import { RegularDelivery } from "./delivery/regular.js";
import { ClaudeAgentSdkHarness } from "./execution/claude.js";
import {
  ClaudeManagedExecutionDriver,
  validateClaudeManagedConfig,
} from "./execution/claude-managed.js";
import {
  GitHubCopilotSdkHarness,
  requireCopilotRuntime,
} from "./execution/github-copilot.js";
import type { LocalProfileRegistration } from "./execution/local.js";
import { CodexHarness, LocalExecutionDriver } from "./execution/local.js";
import {
  OpenAIManagedExecutionDriver,
  validateOpenAIManagedConfig,
} from "./execution/openai-managed.js";
import { profileBinding } from "./execution-profiles.js";
import { RealGitHubGateway } from "./github.js";
import {
  enqueueIntake,
  ensureProjectObjective,
  type IntakeAuthorization,
  type IntakeStartupOptions,
  intakeControl,
  type QueueCommandAcknowledgment,
  runIntake,
  watchIntake,
} from "./intake.js";
import {
  executionCredential,
  resolveProviderCredential,
} from "./provider-credentials.js";
import {
  withRecoveryCheckpointOperation,
  withRecoveryCheckpointScope,
} from "./recovery-checkpoint.js";
import { buildRecoveryCheckpointClosure } from "./recovery-checkpoint-closure.js";
import {
  type ApplicationServices,
  cancelObjective,
  collectCompletedWorker,
  controlObjective,
  decideObjective,
  decidePlan,
  decideResult,
  declineWorkerDiscovery,
  exportAssetSetsForReview,
  planObjective,
  repairWorkItem,
  rereviewWorkItem,
  retryWorkItem,
  runObjective,
  selectAssetSet,
} from "./runner.js";
import type { ContinuationState, PreparationState } from "./state.js";

/** Bind existing operations to their configured archive without changing lifecycle authority. */
function checkpointOperations(config: FactoryConfig) {
  const input = {
    config,
    buildClosure: () =>
      buildRecoveryCheckpointClosure({
        config,
        scope: config.gitPersistence?.scope ?? "private-history",
      }),
  };
  return {
    local: <T>(task: () => T): T => withRecoveryCheckpointScope(input, task),
    async: <T>(
      task: () => Promise<T>,
      queueControlVerification = false,
    ): Promise<T> =>
      withRecoveryCheckpointOperation(input, task, {
        queueControlVerification,
      }),
  };
}

export interface FactoryApplication {
  enqueueIntake(
    objectives: number[],
    options?: { expectedBodyDigests?: Record<string, string> },
  ): Promise<QueueCommandAcknowledgment>;
  intakeControl(
    action: Parameters<typeof intakeControl>[1],
    objective?: Parameters<typeof intakeControl>[2],
  ): Promise<unknown>;
  watchIntake(): Promise<QueueCommandAcknowledgment>;
  ensureProjectObjective(
    objective: number,
    provenance?: Parameters<typeof ensureProjectObjective>[3],
  ): Promise<unknown>;
  runIntake(options?: IntakeStartupOptions): Promise<IntakeAuthorization>;
  proposeAmendment(
    objective: number,
    proposal: import("./graph-amendments.js").AmendmentProposal,
  ): Promise<unknown>;
  planObjective(objective: number): Promise<PlanCandidate>;
  decidePlan(
    objective: number,
    input: {
      actor: string;
      outcome: "accept" | "refuse";
      answer: string;
      reason: string;
    },
  ): Promise<PreparationState>;
  /** Decide the saved plan or a pending result criterion, whichever the Objective's state holds. */
  decide(
    objective: number,
    input: import("./runner.js").DecisionInput,
  ): Promise<"plan-accepted" | "plan-refused" | "result" | "result-open">;
  runObjective(
    objective: number,
    options?: { deadlineAt?: string },
  ): Promise<ContinuationState>;
  cancelObjective(objective: number): Promise<"requested" | "cancelled">;
  collectCompletedWorker(
    objective: number,
    input: Parameters<typeof collectCompletedWorker>[2],
  ): Promise<void>;
  /** Answer a step's decision or config fix, else retry a failed Work Item. */
  retryWorkItem(objective: number, itemId?: string): "step" | "attempt";
  repairWorkItem(
    objective: number,
    input: Parameters<typeof repairWorkItem>[2],
  ): void;
  rereviewWorkItem(
    objective: number,
    input: Parameters<typeof rereviewWorkItem>[2],
  ): void;
  declineWorkerDiscovery(
    objective: number,
    input: Parameters<typeof declineWorkerDiscovery>[2],
  ): void;
  decideResult(
    objective: number,
    input: {
      item?: string;
      actor: string;
      outcome: "accept" | "refuse";
      reason: string;
    },
  ): void;
  selectAssetSet(
    objective: number,
    itemId: string,
    setId: string,
    decision?: {
      actor?: string;
      downstreamItems?: string[];
    },
  ): Promise<void>;
  /** Write each candidate AssetSet of a waiting Work Item under `output`; returns their ids. */
  exportAssetSetsForReview(
    objective: number,
    itemId: string,
    output: string,
  ): Promise<string[]>;
}

export interface LocalHarnessRegistration<
  Configuration extends { [key: string]: JsonValue } = {
    [key: string]: JsonValue;
  },
> {
  /** Stable name/version bound to configuration and active Objective state. */
  identity: string;
  /** Exact adapter-owned configuration used to construct `harness`. */
  config: Configuration;
  harness: AgentHarness;
}

export interface LocalHarnessCompositionOptions {
  /** Optional narrow contract stubs, e.g. for credential-free tests or planning evals. */
  planningModel?: PlanningModel;
  github?: GitHubGateway;
}

const resolvePackage = createRequire(import.meta.url).resolve;

function requireOptionalHarness(packageName: string, identity: string): void {
  try {
    resolvePackage(packageName);
  } catch (cause) {
    throw new Error(
      `Harness adapter ${identity} is not installed; install optional dependency ${packageName}`,
      { cause },
    );
  }
}

function assertSessionComposition(
  adapter: {
    readonly sessionCapabilities?: AgentSessionCapabilities;
    releaseSession?(session: AgentSessionRef): Promise<void>;
  },
  name: string,
  allowedRoles: readonly AgentSessionRole[],
): void {
  if ("sessionContinuation" in adapter)
    throw new Error(
      `${name} uses the removed sessionContinuation declaration; declare sessionCapabilities.resumeRoles instead`,
    );
  if (adapter.sessionCapabilities === undefined) return;
  assertAgentSessionCapabilities(adapter.sessionCapabilities);
  if (
    adapter.sessionCapabilities.resumeRoles.some(
      (role) => !allowedRoles.includes(role),
    )
  )
    throw new Error(`${name} declares a session role outside its contract`);
  if (adapter.sessionCapabilities.resumeRoles.length && !adapter.releaseSession)
    throw new Error(`${name} declares session resume without releaseSession`);
}

function composedPlanningModel(model: PlanningModel): PlanningModel {
  assertSessionComposition(model, "Planning model", [
    "planning",
    "result-review",
    "objective-review",
  ]);
  return model;
}

export function createApplication(
  config: FactoryConfig,
  services: ApplicationServices,
): FactoryApplication {
  composedPlanningModel(services.planningModel);
  assertSessionComposition(services.driver, "Execution driver", [
    "implementation",
  ]);
  if (config.gitPersistence?.scope === "private-history") {
    if (
      services.planningModel.providerAttemptAdmission !==
        "controller-checkpoint-v1" ||
      services.driver.effectAdmission !== "controller-checkpoint-v1" ||
      services.github.effectAdmission !== "controller-checkpoint-v1" ||
      services.delivery.effectAdmission !== "controller-checkpoint-v1"
    )
      throw new Error(
        "Git-backed continuation requires planning, execution, GitHub and delivery adapters that enforce checkpoint admission",
      );
  }
  const checkpoint = checkpointOperations(config);
  return {
    enqueueIntake: (objectives, options) =>
      enqueueIntake(config, services.github, objectives, options),
    intakeControl: (action, objective) =>
      intakeControl(config, action, objective, services.github),
    watchIntake: () => watchIntake(config, services.github),
    ensureProjectObjective: (objective, provenance) =>
      ensureProjectObjective(config, services.github, objective, provenance),
    runIntake: (options) =>
      checkpoint.async(() => runIntake(config, services, options), true),
    planObjective: (objective) => {
      if (config.gitPersistence?.scope === "private-history")
        return Promise.reject(
          new Error(
            "Use runObjective for Git-backed planning; transient plan previews have no continuation journal",
          ),
        );
      return checkpoint.async(() => planObjective(config, objective, services));
    },
    decidePlan: (objective, input) =>
      checkpoint.async(() => decidePlan(config, objective, services, input)),
    decide: (objective, input) =>
      checkpoint.async(() =>
        decideObjective(config, objective, services, input),
      ),
    proposeAmendment: (objective, proposal) =>
      checkpoint.async(() =>
        controlObjective(config, {
          objective,
          action: "propose-amendment",
          input: proposal as unknown as Record<string, unknown>,
        }),
      ),
    runObjective: (objective, options) =>
      checkpoint.async(() =>
        runObjective(config, objective, services, options),
      ),
    cancelObjective: (objective) =>
      checkpoint.async(() =>
        cancelObjective(
          config,
          objective,
          services.driver,
          services.github,
          services.planningModel,
        ),
      ),
    collectCompletedWorker: (objective, input) =>
      checkpoint.async(() =>
        collectCompletedWorker(config, objective, input, services.driver),
      ),
    repairWorkItem: (objective, input) =>
      checkpoint.local(() => repairWorkItem(config, objective, input)),
    retryWorkItem: (objective, itemId) =>
      checkpoint.local(() => retryWorkItem(config, objective, itemId)),
    rereviewWorkItem: (objective, input) =>
      checkpoint.local(() => rereviewWorkItem(config, objective, input)),
    declineWorkerDiscovery: (objective, input) =>
      checkpoint.local(() => declineWorkerDiscovery(config, objective, input)),
    decideResult: (objective, input) =>
      checkpoint.local(() => decideResult(config, objective, input)),
    selectAssetSet: (objective, itemId, setId, decision) =>
      checkpoint.async(() =>
        selectAssetSet(
          config,
          objective,
          itemId,
          setId,
          services.contentStore,
          decision,
        ),
      ),
    exportAssetSetsForReview: (objective, itemId, output) =>
      exportAssetSetsForReview(
        config,
        objective,
        itemId,
        output,
        services.contentStore,
      ),
  };
}

/** Model-free intake binding does not construct a provider driver or require its credential. */
export function composeIntake(
  config: FactoryConfig,
): Pick<
  FactoryApplication,
  "enqueueIntake" | "intakeControl" | "watchIntake" | "ensureProjectObjective"
> {
  validateTarget(config.repository, config.checkout);
  const github = new RealGitHubGateway(
    config.repository,
    new NativeStackDelivery(config.repository),
  );
  return {
    enqueueIntake: (objectives, options) =>
      enqueueIntake(config, github, objectives, options),
    intakeControl: (action, objective) =>
      intakeControl(config, action, objective, github),
    watchIntake: () => watchIntake(config, github),
    ensureProjectObjective: (objective, provenance) =>
      ensureProjectObjective(config, github, objective, provenance),
  };
}

/**
 * The configured PlanningModel; it authenticates with the operator's provider login.
 * Proposals and dreams are standalone calls outside any Objective run, so they pass
 * `retainedSessions: false` and get no controller-owned session storage.
 */
export function composePlanningModel(
  config: FactoryConfig,
  { retainedSessions = true }: { retainedSessions?: boolean } = {},
): PlanningModel {
  const redactionValues = config.policy.allowedSecretNames.flatMap((name) =>
    process.env[name] ? [process.env[name]!] : [],
  );
  if (config.planning.kind === "claude-agent-sdk")
    return composedPlanningModel(
      new ClaudePlanningModel(config.planning, {
        redactionValues,
        ...(retainedSessions
          ? {
              sessionRoot: join(
                stateRoot(config.repository),
                "claude-planning-sessions",
              ),
            }
          : {}),
      }),
    );
  return composedPlanningModel(
    new CodexPlanningModel(
      config.checkout,
      config.planning.planner,
      config.planning.reviewer,
      undefined,
      {
        redactionValues,
        transport: config.planning.codex?.transport ?? "exec",
        sourceArtifacts: config.planning.codex?.sourceArtifacts,
        ...(retainedSessions
          ? {
              sessionRoot: join(
                stateRoot(config.repository),
                "review-sessions",
              ),
            }
          : {}),
      },
    ),
  );
}

/** Planning composition constructs retained input storage but no execution driver. */
export function composePlanning(
  config: FactoryConfig,
  options: LocalHarnessCompositionOptions = {},
): Pick<FactoryApplication, "planObjective" | "decidePlan" | "decide"> {
  validateTarget(config.repository, config.checkout);
  const services = {
    contentStore: new LocalContentStore(
      join(stateRoot(config.repository), "content"),
    ),
    planningModel: composedPlanningModel(
      options.planningModel ?? composePlanningModel(config),
    ),
    github:
      options.github ??
      new RealGitHubGateway(
        config.repository,
        new NativeStackDelivery(config.repository),
      ),
  };
  if (
    config.gitPersistence?.scope === "private-history" &&
    services.planningModel.providerAttemptAdmission !==
      "controller-checkpoint-v1"
  )
    throw new Error("Git-backed planning requires checkpoint admission");
  const checkpoint = checkpointOperations(config);
  return {
    planObjective: (objective) => {
      if (config.gitPersistence?.scope === "private-history")
        return Promise.reject(
          new Error(
            "Use runObjective for Git-backed planning; transient plan previews have no continuation journal",
          ),
        );
      return checkpoint.async(() => planObjective(config, objective, services));
    },
    decidePlan: (objective, input) =>
      checkpoint.async(() => decidePlan(config, objective, services, input)),
    decide: (objective, input) =>
      checkpoint.async(() =>
        decideObjective(config, objective, services, input),
      ),
  };
}

function cloneAndValidateConfig(config: FactoryConfig): FactoryConfig {
  return validateConfig(JSON.parse(JSON.stringify(config)) as unknown);
}

function normalizedJson(
  value: unknown,
  name: string,
  seen = new Set<unknown>(),
): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return value;
    throw new Error(`${name} must be JSON-safe`);
  }
  if (typeof value !== "object" || seen.has(value))
    throw new Error(`${name} must be JSON-safe`);
  seen.add(value);
  try {
    if (Array.isArray(value))
      return value.map((entry, index) =>
        normalizedJson(entry, `${name}[${index}]`, seen),
      );
    if (
      (Object.getPrototypeOf(value) !== Object.prototype &&
        Object.getPrototypeOf(value) !== null) ||
      Object.getOwnPropertySymbols(value).length
    )
      throw new Error(`${name} must contain only JSON objects`);
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [
          key,
          normalizedJson(
            (value as Record<string, unknown>)[key],
            `${name}.${key}`,
            seen,
          ),
        ]),
    );
  } finally {
    seen.delete(value);
  }
}

function composeLocal(
  config: FactoryConfig,
  harness: AgentHarness | undefined,
  adapterIdentity: string,
  options: LocalHarnessCompositionOptions = {},
  profiles?: ReadonlyMap<string, LocalProfileRegistration>,
): FactoryApplication {
  return createApplication(
    config,
    localServices(config, harness, adapterIdentity, options, profiles),
  );
}

function localServices(
  config: FactoryConfig,
  harness: AgentHarness | undefined,
  adapterIdentity: string,
  options: LocalHarnessCompositionOptions = {},
  profiles?: ReadonlyMap<string, LocalProfileRegistration>,
): ApplicationServices {
  const root = stateRoot(config.repository);
  const contentStore = new LocalContentStore(join(root, "content"));
  const github =
    options.github ??
    new RealGitHubGateway(
      config.repository,
      new NativeStackDelivery(config.repository),
    );
  const driver = new LocalExecutionDriver(
    config.checkout,
    join(root, "worktrees"),
    harness,
    resolveCapacity(config).concurrency,
    contentStore,
    adapterIdentity,
    profiles,
    {
      repository: config.repository,
      policy: config.capture,
      configDigest: factoryConfigDigest(config),
    },
  );
  return {
    planningModel: options.planningModel ?? composePlanningModel(config),
    driver,
    github,
    delivery: new RegularDelivery(config.checkout, github),
    contentStore,
    reportRunStatus: (message) => console.error(message),
  };
}

/**
 * Compose Factory's production local driver, validation, delivery and content
 * services around one installed non-Codex harness registration.
 */
export function composeWithLocalHarness(
  input: FactoryConfig,
  registration: LocalHarnessRegistration,
  options: LocalHarnessCompositionOptions = {},
): FactoryApplication {
  const config = cloneAndValidateConfig(input);
  validateTarget(config.repository, config.checkout);
  if (config.execution.kind !== "local")
    throw new Error(
      `Execution mode ${config.execution.kind} is not implemented`,
    );
  if (config.execution.harness?.kind !== "registered")
    throw new Error(
      "composeWithLocalHarness requires execution.harness.kind registered",
    );
  if (registration.identity !== config.execution.harness.adapter)
    throw new Error(
      `Configured harness adapter ${config.execution.harness.adapter} does not match registration ${registration.identity}`,
    );
  if (
    JSON.stringify(
      normalizedJson(registration.config, "Registered harness configuration"),
    ) !==
    JSON.stringify(
      normalizedJson(
        config.execution.harness.config,
        "Configured harness configuration",
      ),
    )
  )
    throw new Error(
      `Registered harness configuration does not match adapter ${registration.identity}`,
    );
  return composeLocal(
    config,
    registration.harness,
    registration.identity,
    options,
  );
}

/** Profile-keyed registration permits distinct settings for the same adapter. */
export function composeWithLocalProfiles(
  input: FactoryConfig,
  registrations: Record<string, LocalHarnessRegistration> = {},
  options: LocalHarnessCompositionOptions = {},
): FactoryApplication {
  const config = cloneAndValidateConfig(input);
  return composeLocal(
    config,
    undefined,
    "profiles",
    options,
    localProfiles(config, registrations),
  );
}

function localProfiles(
  config: FactoryConfig,
  registrations: Record<string, LocalHarnessRegistration>,
): Map<string, LocalProfileRegistration> {
  if (config.execution.kind !== "local" || !config.execution.profiles)
    throw new Error("Local execution profiles are required");
  const profiles = new Map<string, LocalProfileRegistration>();
  for (const [id, profile] of Object.entries(config.execution.profiles)) {
    profiles.set(id, {
      binding: profileBinding(id, profile, config.policy),
      environment: profile.environment,
      createHarness: () => {
        if (profile.harness.kind !== "registered")
          return builtInHarness(
            config,
            profile.harness,
            Boolean(profile.environment?.mcp),
          );
        const registration = registrations[id];
        if (
          !registration ||
          registration.identity !== profile.harness.adapter ||
          JSON.stringify(
            normalizedJson(
              registration.config,
              "Registered harness configuration",
            ),
          ) !==
            JSON.stringify(
              normalizedJson(
                profile.harness.config,
                "Configured harness configuration",
              ),
            )
        )
          throw new Error(
            `Assigned execution profile ${id} is unavailable or changed; no fallback is available`,
          );
        return registration.harness;
      },
    });
  }
  return profiles;
}

function builtInHarness(
  config: FactoryConfig,
  harness: LocalHarnessConfig,
  worktreeMcp = false,
): AgentHarness {
  if (harness.kind === "claude-agent-sdk") {
    requireOptionalHarness(
      "@anthropic-ai/claude-agent-sdk",
      CLAUDE_AGENT_SDK_ADAPTER_IDENTITY,
    );
    if (worktreeMcp) requireOptionalHarness("zod", "factory-worktree-read@1");
    return new ClaudeAgentSdkHarness(
      join(stateRoot(config.repository), "harness"),
      harness,
    );
  }
  if (harness.kind === "github-copilot-sdk") {
    requireCopilotRuntime();
    requireOptionalHarness(
      "@github/copilot-sdk",
      GITHUB_COPILOT_SDK_ADAPTER_IDENTITY,
    );
    return new GitHubCopilotSdkHarness(
      join(stateRoot(config.repository), "harness"),
      harness,
    );
  }
  if (harness.kind !== "codex-sdk")
    throw new Error(
      `Harness adapter ${harness.adapter} is not registered; use composeWithLocalHarness or composeWithLocalProfiles`,
    );
  const credentials = join(stateRoot(config.repository), "empty-gh-config");
  mkdirSync(credentials, { recursive: true, mode: 0o700 });
  return new CodexHarness(
    credentials,
    config.policy.network,
    harness,
    config.policy.allowedSecretNames,
  );
}

/** The single production composition point for the installed application. */
export function compose(
  input: FactoryConfig,
  /** Credential names a supervised service loaded through systemd. */
  serviceCredentials?: string[],
): FactoryApplication {
  const { config, services } = composeServices(input, serviceCredentials);
  const application = createApplication(config, services);
  return {
    ...application,
    // The service continues a started Objective on the provider it froze.
    runIntake: (options) =>
      application.runIntake({
        ...options,
        servicesFor: (selected) =>
          composeServices(selected, serviceCredentials).services,
      }),
  };
}

/** The production services for one resolved provider configuration. */
function composeServices(
  input: FactoryConfig,
  serviceCredentials?: string[],
): { config: FactoryConfig; services: ApplicationServices } {
  const config = cloneAndValidateConfig(input);
  const planningModel = composePlanningModel(config);
  const executionKey = () =>
    resolveProviderCredential(
      config,
      executionCredential(config)!,
      serviceCredentials,
    );
  if (config.execution.kind === "managed-agent") {
    const apiKey = executionKey();
    const root = stateRoot(config.repository);
    const contentStore = new LocalContentStore(join(root, "content"));
    const github = new RealGitHubGateway(
      config.repository,
      new NativeStackDelivery(config.repository),
    );
    const managed = {
      checkout: config.checkout,
      workRoot: join(root, "managed"),
      contentStore,
    };
    const driver =
      config.execution.provider === "claude-managed-agents"
        ? new ClaudeManagedExecutionDriver({
            ...managed,
            apiKey,
            config: validateClaudeManagedConfig(config.execution.config),
          })
        : new OpenAIManagedExecutionDriver({
            ...managed,
            apiKey,
            config: validateOpenAIManagedConfig(config.execution.config),
          });
    return {
      config,
      services: {
        planningModel,
        driver,
        github,
        delivery: new RegularDelivery(config.checkout, github),
        contentStore,
        reportRunStatus: (message) => console.error(message),
      },
    };
  }
  if (config.execution.profiles)
    return {
      config,
      services: localServices(
        config,
        undefined,
        "profiles",
        { planningModel },
        localProfiles(config, {}),
      ),
    };
  const harness = config.execution.harness!;
  return {
    config,
    services: localServices(
      config,
      builtInHarness(config, harness),
      harnessAdapterIdentity(harness),
      { planningModel },
    ),
  };
}
