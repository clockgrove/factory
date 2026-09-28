import { profileBinding } from "./execution-profiles.js";
import type { LocalProfileRegistration } from "./execution/local.js";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { FactoryConfig, JsonValue, LocalHarnessConfig } from "./config.js";
import {
  CLAUDE_AGENT_SDK_ADAPTER_IDENTITY,
  GITHUB_COPILOT_SDK_ADAPTER_IDENTITY,
  stateRoot,
  validateConfig,
  validateTarget,
} from "./config.js";
import { CodexPlanningModel, type PlanCandidate } from "./compiler.js";
import { LocalContentStore } from "./content/local.js";
import { NativeStackDelivery } from "./delivery/native-stack.js";
import { RegularDelivery } from "./delivery/regular.js";
import { ClaudeAgentSdkHarness } from "./execution/claude.js";
import {
  GitHubCopilotSdkHarness,
  requireCopilotRuntime,
} from "./execution/github-copilot.js";
import { CodexHarness, LocalExecutionDriver } from "./execution/local.js";
import { RealGitHubGateway } from "./github.js";
import type {
  AgentHarness,
  GitHubGateway,
  PlanningModel,
} from "./contracts.js";
import type { FactoryState } from "./state.js";
import {
  cancelObjective,
  decideResult,
  decidePlan,
  exportAssetSetForReview,
  planObjective,
  retryWorkItem,
  rereviewWorkItem,
  runObjective,
  selectAssetSet,
  type ApplicationServices,
} from "./runner.js";

export interface FactoryApplication {
  planObjective(objective: number): Promise<PlanCandidate>;
  decidePlan(
    objective: number,
    candidate: PlanCandidate,
    input: {
      actor: string;
      outcome: "accept" | "refuse";
      answer: string;
      reason: string;
    },
  ): Promise<PlanCandidate>;
  runObjective(
    objective: number,
    acceptedPlan?: PlanCandidate,
  ): Promise<FactoryState>;
  cancelObjective(objective: number): Promise<"requested" | "cancelled">;
  retryWorkItem(objective: number, itemId: string): void;
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
  /** Optional narrow contract stubs for credential-free conformance tests. */
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
    planObjective: (objective) => planObjective(config, objective, services),
    decidePlan: (objective, candidate, input) =>
      decidePlan(config, objective, services, candidate, input),
    runObjective: (objective, acceptedPlan) =>
      runObjective(config, objective, services, acceptedPlan),
    cancelObjective: (objective) =>
      cancelObjective(config, objective, services.driver),
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

/** Planning composition never constructs a driver, content store, or run state. */
export function composePlanning(
  config: FactoryConfig,
): Pick<FactoryApplication, "planObjective" | "decidePlan"> {
  validateTarget(config.repository, config.checkout);
  const services = {
    planningModel: new CodexPlanningModel(
      config.checkout,
      config.planning.planner,
      config.planning.reviewer,
    ),
    github: new RealGitHubGateway(
      config.repository,
      new NativeStackDelivery(config.repository),
    ),
  };
  return {
    planObjective: (objective) => planObjective(config, objective, services),
    decidePlan: (objective, candidate, input) =>
      decidePlan(config, objective, services, candidate, input),
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
    config.execution.concurrency,
    contentStore,
    adapterIdentity,
    profiles,
  );
  return createApplication(config, {
    planningModel:
      options.planningModel ??
      new CodexPlanningModel(
        config.checkout,
        config.planning.planner,
        config.planning.reviewer,
      ),
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
export function compose(input: FactoryConfig): FactoryApplication {
  const config = cloneAndValidateConfig(input);
  if (config.execution.kind !== "local")
    throw new Error(
      `Execution mode ${config.execution.kind} is not implemented`,
    );
  if (config.execution.profiles) return composeWithLocalProfiles(config);
  const harness = config.execution.harness!;
  return composeLocal(
    config,
    builtInHarness(config, harness),
    harness.kind === "codex-sdk" ? harness.kind : harness.adapter,
  );
}
