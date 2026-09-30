import Anthropic from "@anthropic-ai/sdk";
import { createReadStream } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import type {
  BetaManagedAgentsSession,
  SessionCreateParams,
} from "@anthropic-ai/sdk/resources/beta/sessions/sessions";
import type {
  BetaManagedAgentsSessionEvent,
  BetaManagedAgentsEventParams,
} from "@anthropic-ai/sdk/resources/beta/sessions/events";

export const CLAUDE_MANAGED_ADAPTER = "@anthropic-ai/sdk@0.129.0";
export const CLAUDE_MANAGED_BETA = "managed-agents-2026-04-01";
export interface ClaudeManagedConfig {
  agentId: string;
  agentVersion: number;
  environmentId: string;
  workspaceId: string;
  credentialEnv: string;
  /** Complete resolved agent snapshot, checked again before each submission. */
  agent: BetaManagedAgentsSession["agent"];
  /** This is a configured expectation, not a provider-issued immutable snapshot. */
  environment: {
    type: "cloud";
    networking: {
      type: "limited";
      allowed_hosts: string[];
      allow_mcp_servers: false;
      allow_package_managers: false;
    };
    packages: Record<string, string[]>;
  };
  /** Explicit operator-authorized list-cost threshold; crossing requests can exceed it. */
  budgetCents?: string;
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function validateClaudeManagedConfig(
  value: unknown,
): ClaudeManagedConfig {
  if (!record(value))
    throw new Error("Claude managed configuration must be an object");
  const allowed = new Set([
    "agentId",
    "agentVersion",
    "environmentId",
    "workspaceId",
    "credentialEnv",
    "agent",
    "environment",
    "budgetCents",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key)))
    throw new Error("Unknown Claude managed configuration field");
  for (const key of [
    "agentId",
    "environmentId",
    "workspaceId",
    "credentialEnv",
  ]) {
    if (typeof value[key] !== "string" || !value[key])
      throw new Error(`Claude managed ${key} is required`);
  }
  if (!/^[A-Z_][A-Z0-9_]*$/.test(String(value.credentialEnv)))
    throw new Error(
      "Claude managed credentialEnv must name an environment variable",
    );
  if (
    !Number.isSafeInteger(value.agentVersion) ||
    Number(value.agentVersion) < 1
  )
    throw new Error("Claude managed agentVersion must be pinned");
  if (
    value.budgetCents !== undefined &&
    (typeof value.budgetCents !== "string" ||
      !/^[1-9][0-9]*$/.test(value.budgetCents))
  )
    throw new Error(
      "Claude managed budgetCents must be a positive integer string",
    );
  const environment = value.environment;
  if (
    !record(environment) ||
    environment.type !== "cloud" ||
    !record(environment.networking) ||
    !record(environment.packages)
  )
    throw new Error(
      "Claude managed environment must be an explicit cloud configuration",
    );
  if (
    Object.keys(environment).some(
      (key) => !["type", "networking", "packages"].includes(key),
    )
  )
    throw new Error("Unknown Claude managed environment configuration");
  const network = environment.networking;
  if (
    network.type !== "limited" ||
    !Array.isArray(network.allowed_hosts) ||
    network.allowed_hosts.length ||
    network.allow_mcp_servers !== false ||
    network.allow_package_managers !== false ||
    Object.keys(network).some(
      (key) =>
        ![
          "type",
          "allowed_hosts",
          "allow_mcp_servers",
          "allow_package_managers",
        ].includes(key),
    )
  )
    throw new Error(
      "Claude managed workers require denied outbound networking",
    );
  if (
    Object.values(environment.packages).some(
      (packages) => !Array.isArray(packages) || packages.length,
    )
  )
    throw new Error(
      "Claude managed workers cannot install environment packages",
    );
  const agent = value.agent;
  if (
    !record(agent) ||
    agent.id !== value.agentId ||
    agent.version !== value.agentVersion ||
    agent.type !== "agent" ||
    !record(agent.model) ||
    typeof agent.model.id !== "string" ||
    !agent.model.id ||
    agent.multiagent !== null ||
    !Array.isArray(agent.mcp_servers) ||
    agent.mcp_servers.length ||
    !Array.isArray(agent.skills) ||
    agent.skills.length ||
    !Array.isArray(agent.tools) ||
    agent.tools.length !== 1
  )
    throw new Error(
      "Claude managed agent must be pinned without MCP, skills or subagents",
    );
  const toolset = agent.tools[0];
  if (
    !record(toolset) ||
    toolset.type !== "agent_toolset_20260401" ||
    !record(toolset.default_config) ||
    toolset.default_config.enabled !== false ||
    !Array.isArray(toolset.configs)
  )
    throw new Error(
      "Claude managed tools must explicitly disable the default toolset",
    );
  const names = new Set<string>();
  for (const tool of toolset.configs) {
    if (
      !record(tool) ||
      typeof tool.name !== "string" ||
      names.has(tool.name) ||
      tool.type !== tool.name ||
      !["bash", "read", "write", "edit", "glob", "grep"].includes(tool.name) ||
      tool.enabled !== true ||
      !record(tool.permission_policy) ||
      tool.permission_policy.type !== "always_allow"
    )
      throw new Error(
        "Claude managed tools must contain only explicitly allowed local file tools",
      );
    names.add(tool.name);
  }
  if (!names.has("bash"))
    throw new Error("Claude managed execution requires the bash tool");
  return structuredClone(value) as unknown as ClaudeManagedConfig;
}

/** No credentials are serialized into driver handles or worker resources. */
export class ClaudeManagedClient {
  readonly sdk: Anthropic;
  constructor(
    readonly config: ClaudeManagedConfig,
    options: { apiKey?: string; fetch?: typeof fetch } = {},
  ) {
    const apiKey = options.apiKey ?? process.env[config.credentialEnv];
    if (!apiKey)
      throw new Error(
        `Set ${config.credentialEnv} outside the target repository`,
      );
    this.sdk = new Anthropic({
      apiKey,
      authToken: null,
      baseURL: "https://api.anthropic.com",
      maxRetries: 0,
      ...(options.fetch && { fetch: options.fetch }),
    });
  }
  private get headers() {
    return {
      workspace_id: this.config.workspaceId,
      betas: [CLAUDE_MANAGED_BETA],
    };
  }
  async verifyEnvironment(): Promise<void> {
    const environment = await this.sdk.beta.environments.retrieve(
      this.config.environmentId,
      this.headers,
    );
    if (!isDeepStrictEqual(environment.config, this.config.environment))
      throw new Error("Claude managed environment configuration changed");
  }
  assertSession(session: BetaManagedAgentsSession, identity: string): void {
    if (
      !isDeepStrictEqual(session.agent, this.config.agent) ||
      session.environment_id !== this.config.environmentId ||
      session.vault_ids.length ||
      session.deployment_id ||
      session.metadata.factory_attempt !== identity
    )
      throw new Error(
        "Claude managed session configuration or attempt binding changed",
      );
    const expectedBudget = this.config.budgetCents
      ? {
          type: "limit",
          max_list_cost: { amount: this.config.budgetCents, currency: "USD" },
        }
      : null;
    if (!isDeepStrictEqual(session.budget, expectedBudget))
      throw new Error("Claude managed session budget changed");
    if (session.resources.some((resource) => resource.type !== "file"))
      throw new Error(
        "Claude managed session has undeclared resource authority",
      );
  }
  async upload(path: string) {
    return this.sdk.beta.files.upload({
      file: createReadStream(path),
      ...this.headers,
    });
  }
  async create(
    identity: string,
    resources: NonNullable<SessionCreateParams["resources"]>,
  ) {
    return this.sdk.beta.sessions.create({
      ...this.headers,
      agent: {
        type: "agent",
        id: this.config.agentId,
        version: this.config.agentVersion,
      },
      environment_id: this.config.environmentId,
      metadata: { factory_attempt: identity },
      resources,
      vault_ids: [],
      ...(this.config.budgetCents && {
        budget: {
          type: "limit",
          max_list_cost: { amount: this.config.budgetCents, currency: "USD" },
        },
      }),
    });
  }
  async retrieve(sessionId: string) {
    return this.sdk.beta.sessions.retrieve(sessionId, this.headers);
  }
  async send(sessionId: string, event: BetaManagedAgentsEventParams) {
    return this.sdk.beta.sessions.events.send(sessionId, {
      ...this.headers,
      events: [event],
    });
  }
  async events(sessionId: string): Promise<BetaManagedAgentsSessionEvent[]> {
    const result: BetaManagedAgentsSessionEvent[] = [];
    for await (const event of this.sdk.beta.sessions.events.list(sessionId, {
      ...this.headers,
      order: "asc",
    }))
      result.push(event);
    return result;
  }
  async files(sessionId: string) {
    const result = [];
    for await (const file of this.sdk.beta.files.list({
      ...this.headers,
      scope_id: sessionId,
    }))
      result.push(file);
    return result;
  }
  async download(fileId: string) {
    return this.sdk.beta.files.download(fileId, this.headers);
  }
}
