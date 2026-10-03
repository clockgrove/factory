import { DaytonaSandboxProvider } from "./execution/daytona.js";
import {
  executionCredential,
  resolveProviderCredential,
} from "./provider-credentials.js";
import {
  ClaudeManagedExecutionDriver,
  validateClaudeManagedConfig,
} from "./execution/claude-managed.js";
import { SandboxExecutionDriver } from "./execution/sandbox.js";
import type { SandboxProvider } from "./contracts.js";
import {
  OpenAIManagedExecutionDriver,
  validateOpenAIManagedConfig,
} from "./execution/openai-managed.js";
import {
  enqueueIntake,
  runIntake,
  type IntakeAuthorization,
} from "./intake.js";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { ClaudePlanningModel } from "./claude-planning.js";
import { CodexPlanningModel, type PlanCandidate } from "./compiler.js";
import type { FactoryConfig, JsonValue, LocalHarnessConfig } from "./config.js";
import {
  CLAUDE_AGENT_SDK_ADAPTER_IDENTITY,
  factoryConfigDigest,
  resolveCapacity,
  GITHUB_COPILOT_SDK_ADAPTER_IDENTITY,
  stateRoot,
  validateConfig,
  validateTarget,
} from "./config.js";
import { LocalContentStore } from "./content/local.js";
import type {
  AgentHarness,
  GitHubGateway,
  PlanningModel,
} from "./contracts.js";
import { NativeStackDelivery } from "./delivery/native-stack.js";
import { RegularDelivery } from "./delivery/regular.js";
import { ClaudeAgentSdkHarness } from "./execution/claude.js";
import {
  GitHubCopilotSdkHarness,
  requireCopilotRuntime,
} from "./execution/github-copilot.js";
import type { LocalProfileRegistration } from "./execution/local.js";
import { CodexHarness, LocalExecutionDriver } from "./execution/local.js";
import { profileBinding } from "./execution-profiles.js";
import { RealGitHubGateway } from "./github.js";
import {
  type ApplicationServices,
  cancelObjective,
  controlObjective,
  decidePlan,
  decideResult,
  exportAssetSetForReview,
  planObjective,
  rereviewWorkItem,
  retryWorkItem,
  repairWorkItem,
  runObjective,
  selectAssetSet,
} from "./runner.js";
import type { ContinuationState, PreparationState } from "./state.js";

export interface FactoryApplication {
  enqueueIntake(
    objectives: number[],
    options?: import("./intake.js").IntakeOptions,
  ): Promise<IntakeAuthorization>;
  runIntake(): Promise<IntakeAuthorization>;
  proposeAmendment(
    objective: number,
    proposal: import("./graph-amendments.js").AmendmentProposal,
  ): Promise<unknown>;
  planObjective(objective: number): Promise<PlanCandidate>;
  decidePlan(
    objective: number,
    input: {
      plan?: string;
      actor: string;
      outcome: "accept" | "refuse";
      answer: string;
      reason: string;
    },
  ): Promise<PreparationState>;
  runObjective(
    objective: number,
    options?: { deadlineAt?: string },
  ): Promise<ContinuationState>;
  cancelObjective(objective: number): Promise<"requested" | "cancelled">;
  retryWorkItem(objective: number, itemId: string): void;
  repairWorkItem(
    objective: number,
    input: Parameters<typeof repairWorkItem>[2],
  ): void;
  rereviewWorkItem(
    objective: number,
    input: { item: string; treeSha: string; actor: string; reason: string },
  ): void;
  decideResult(
    objective: number,
    input: {
      item?: string;
      treeSha: string;
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
      reason?: string;
      downstreamItems?: string[];
    },
  ): Promise<void>;
  exportAssetSetForReview(
    objective: number,
    itemId: string,
    setId: string,
    output: string,
  ): Promise<void>;
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

export function createApplication(
  config: FactoryConfig,
  services: ApplicationServices,
): FactoryApplication {
  return {
    enqueueIntake: (objectives, options) =>
      enqueueIntake(config, services.github, objectives, options),
    runIntake: () => runIntake(config, services),
    planObjective: (objective) => planObjective(config, objective, services),
    decidePlan: (objective, input) =>
      decidePlan(config, objective, services, input),
    proposeAmendment: (objective, proposal) =>
      controlObjective(config, {
        objective,
        action: "propose-amendment",
        input: proposal as unknown as Record<string, unknown>,
      }),
    runObjective: (objective, options) =>
      runObjective(config, objective, services, options),
    cancelObjective: (objective) =>
      cancelObjective(config, objective, services.driver),
    repairWorkItem: (objective, input) =>
      repairWorkItem(config, objective, input),
    retryWorkItem: (objective, itemId) =>
      retryWorkItem(config, objective, itemId),
    rereviewWorkItem: (objective, input) =>
      rereviewWorkItem(config, objective, input),
    decideResult: (objective, input) => decideResult(config, objective, input),
    selectAssetSet: (objective, itemId, setId, decision) =>
      selectAssetSet(
        config,
        objective,
        itemId,
        setId,
        services.contentStore,
        decision,
      ),
    exportAssetSetForReview: (objective, itemId, setId, output) =>
      exportAssetSetForReview(
        config,
        objective,
        itemId,
        setId,
        output,
        services.contentStore,
      ),
  };
}

/** Model-free intake binding does not construct a provider driver or require its credential. */
export function composeIntake(
  config: FactoryConfig,
): Pick<FactoryApplication, "enqueueIntake"> {
  validateTarget(config.repository, config.checkout);
  const github = new RealGitHubGateway(
    config.repository,
    new NativeStackDelivery(config.repository),
  );
  return {
    enqueueIntake: (objectives, options) =>
      enqueueIntake(config, github, objectives, options),
  };
}

/** The configured PlanningModel; it authenticates with the operator's provider login. */
export function composePlanningModel(config: FactoryConfig): PlanningModel {
  const redactionValues = config.policy.allowedSecretNames.flatMap((name) =>
    process.env[name] ? [process.env[name]!] : [],
  );
  if (config.planning.kind === "claude-agent-sdk")
    return new ClaudePlanningModel(config.planning, { redactionValues });
  return new CodexPlanningModel(
    config.checkout,
    config.planning.planner,
    config.planning.reviewer,
    undefined,
    { redactionValues },
  );
}

/** Planning composition never constructs a driver, content store, or run state. */
export function composePlanning(
  config: FactoryConfig,
  options: LocalHarnessCompositionOptions = {},
): Pick<FactoryApplication, "planObjective" | "decidePlan"> {
  validateTarget(config.repository, config.checkout);
  const services = {
    planningModel: options.planningModel ?? composePlanningModel(config),
    github:
      options.github ??
      new RealGitHubGateway(
        config.repository,
        new NativeStackDelivery(config.repository),
      ),
  };
  return {
    planObjective: (objective) => planObjective(config, objective, services),
    decidePlan: (objective, input) =>
      decidePlan(config, objective, services, input),
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
  return createApplication(config, {
    planningModel: options.planningModel ?? composePlanningModel(config),
    driver,
    github,
    delivery: new RegularDelivery(config.checkout, github),
    contentStore,
    reportRunStatus: (message) => console.error(message),
  });
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
  return composeLocal(config, undefined, "profiles", options, profiles);
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
  const config = cloneAndValidateConfig(input);
  const planningModel = composePlanningModel(config);
  const executionKey = () =>
    resolveProviderCredential(
      config,
      executionCredential(config)!,
      serviceCredentials,
    );
  if (
    config.execution.kind === "sandbox" &&
    config.execution.provider === "daytona"
  )
    return composeWithSandbox(
      config,
      {
        identity: "daytona",
        provider: new DaytonaSandboxProvider(
          config.execution.config,
          executionKey(),
        ),
      },
      { planningModel },
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
    return createApplication(config, {
      planningModel,
      driver,
      github,
      delivery: new RegularDelivery(config.checkout, github),
      contentStore,
      reportRunStatus: (message) => console.error(message),
    });
  }
  if (config.execution.kind !== "local")
    throw new Error(
      `Execution mode ${config.execution.kind} is not implemented`,
    );
  if (config.execution.profiles)
    return composeWithLocalProfiles(config, {}, { planningModel });
  const harness = config.execution.harness!;
  return composeLocal(
    config,
    builtInHarness(config, harness),
    harness.kind === "codex-sdk" ? harness.kind : harness.adapter,
    { planningModel },
  );
}

/** Provider infrastructure stays in the controller; the configured harness is constructed only by the installed sandbox entrypoint. */
export function composeWithSandbox(
  input: FactoryConfig,
  registration: { identity: string; provider: SandboxProvider },
  options: LocalHarnessCompositionOptions = {},
): FactoryApplication {
  const config = cloneAndValidateConfig(input);
  if (config.execution.kind !== "sandbox")
    throw new Error("Sandbox execution configuration required");
  if (config.execution.provider !== registration.identity)
    throw new Error("Sandbox provider registration mismatch");
  const root = stateRoot(config.repository);
  const contentStore = new LocalContentStore(join(root, "content"));
  const github =
    options.github ??
    new RealGitHubGateway(
      config.repository,
      new NativeStackDelivery(config.repository),
    );
  return createApplication(config, {
    planningModel: options.planningModel ?? composePlanningModel(config),
    driver: new SandboxExecutionDriver({
      repository: config.repository,
      checkout: config.checkout,
      workRoot: join(root, "sandboxes"),
      contentStore,
      providerIdentity: registration.identity,
      provider: registration.provider,
      harness: {
        identity: config.execution.harness.adapter,
        config: config.execution.harness.config,
      },
      argv: config.execution.argv,
      concurrency: resolveCapacity(config).concurrency,
    }),
    github,
    delivery: new RegularDelivery(config.checkout, github),
    contentStore,
    reportRunStatus: (message) => console.error(message),
  });
}
