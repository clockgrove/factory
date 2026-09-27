import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { FactoryConfig, JsonValue } from "./config.js";
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
  harness: AgentHarness,
  adapterIdentity: string,
  options: LocalHarnessCompositionOptions = {},
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
  if (config.execution.harness.kind !== "registered")
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

/** The single production composition point for the installed application. */
export function compose(input: FactoryConfig): FactoryApplication {
  const config = cloneAndValidateConfig(input);
  validateTarget(config.repository, config.checkout);
  if (config.execution.kind !== "local")
    throw new Error(
      `Execution mode ${config.execution.kind} is not implemented`,
    );
  if (config.execution.harness.kind === "claude-agent-sdk") {
    if (config.policy.network !== "host")
      throw new Error(
        "Claude Agent SDK requires policy.network host; no fallback is available",
      );
    requireOptionalHarness(
      "@anthropic-ai/claude-agent-sdk",
      CLAUDE_AGENT_SDK_ADAPTER_IDENTITY,
    );
    return composeLocal(
      config,
      new ClaudeAgentSdkHarness(
        join(stateRoot(config.repository), "harness"),
        config.execution.harness,
      ),
      CLAUDE_AGENT_SDK_ADAPTER_IDENTITY,
    );
  }
  if (config.execution.harness.kind === "github-copilot-sdk") {
    requireCopilotRuntime();
    if (config.policy.network !== "host")
      throw new Error(
        "GitHub Copilot SDK requires policy.network host; no fallback is available",
      );
    requireOptionalHarness(
      "@github/copilot-sdk",
      GITHUB_COPILOT_SDK_ADAPTER_IDENTITY,
    );
    return composeLocal(
      config,
      new GitHubCopilotSdkHarness(
        join(stateRoot(config.repository), "harness"),
        config.execution.harness,
      ),
      GITHUB_COPILOT_SDK_ADAPTER_IDENTITY,
    );
  }
  if (config.execution.harness.kind !== "codex-sdk")
    throw new Error(
      `Harness adapter ${config.execution.harness.adapter} is not registered; use composeWithLocalHarness`,
    );
  const root = stateRoot(config.repository);
  const credentials = join(root, "empty-gh-config");
  mkdirSync(credentials, { recursive: true, mode: 0o700 });
  return composeLocal(
    config,
    new CodexHarness(
      credentials,
      config.policy.network,
      config.execution.harness,
      config.policy.allowedSecretNames,
    ),
    "codex-sdk",
  );
}
