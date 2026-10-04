import Anthropic from "@anthropic-ai/sdk";
import type { BetaCloudConfig } from "@anthropic-ai/sdk/resources/beta/environments/environments";
import { createReadStream } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { transportFailure } from "./attempt.js";
import { missingCredential } from "./fault.js";
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
  environment: BetaCloudConfig;
  /** Explicit operator-authorized list-cost threshold; crossing requests can exceed it. */
  budgetCents?: string;
  timeoutSeconds?: number;
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
    "timeoutSeconds",
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
  if (
    value.timeoutSeconds !== undefined &&
    (!Number.isSafeInteger(value.timeoutSeconds) ||
      Number(value.timeoutSeconds) <= 0)
  )
    throw new Error("Claude managed timeoutSeconds must be positive");
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
    Object.entries(environment.packages).some(([key, packages]) =>
      key === "type"
        ? packages !== "packages"
        : !["apt", "cargo", "gem", "go", "npm", "pip"].includes(key) ||
          !Array.isArray(packages) ||
          packages.length,
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

/** The provider no longer has the session or file the request named. */
export function claudeGone(error: unknown): boolean {
  return (
    error instanceof Anthropic.NotFoundError ||
    (error as { status?: unknown } | null | undefined)?.status === 404
  );
}

/** A request that failed in transit; the SDK's connection errors carry no status. */
export function claudeTransient(error: unknown): boolean {
  return (
    error instanceof Anthropic.APIConnectionError || transportFailure(error)
  );
}

function requestOptions(timeout?: number) {
  return timeout === undefined
    ? {}
    : { timeout, signal: AbortSignal.timeout(timeout) };
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
      throw missingCredential(
        `Set ${config.credentialEnv} outside the target repository`,
      );
    this.sdk = new Anthropic({
      apiKey,
      authToken: null,
      baseURL: "https://api.anthropic.com",
      maxRetries: 0,
      timeout: (config.timeoutSeconds ?? 900) * 1000,
      ...(options.fetch && { fetch: options.fetch }),
    });
  }
  private get headers() {
    return {
      workspace_id: this.config.workspaceId,
      betas: [CLAUDE_MANAGED_BETA],
    };
  }
  async verifyEnvironment(timeout?: number): Promise<void> {
    const environment = await this.sdk.beta.environments.retrieve(
      this.config.environmentId,
      this.headers,
      requestOptions(timeout),
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
  async upload(path: string, timeout?: number) {
    return this.sdk.beta.files.upload(
      {
        file: createReadStream(path),
        ...this.headers,
      },
      requestOptions(timeout),
    );
  }
  async create(
    identity: string,
    resources: NonNullable<SessionCreateParams["resources"]>,
    timeout?: number,
  ) {
    return this.sdk.beta.sessions.create(
      {
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
      },
      requestOptions(timeout),
    );
  }
  async retrieve(sessionId: string, timeout?: number) {
    return this.sdk.beta.sessions.retrieve(
      sessionId,
      this.headers,
      requestOptions(timeout),
    );
  }
  async send(
    sessionId: string,
    event: BetaManagedAgentsEventParams,
    timeout?: number,
  ) {
    return this.sdk.beta.sessions.events.send(
      sessionId,
      {
        ...this.headers,
        events: [event],
      },
      requestOptions(timeout),
    );
  }
  async events(
    sessionId: string,
    timeout?: number,
  ): Promise<BetaManagedAgentsSessionEvent[]> {
    const result: BetaManagedAgentsSessionEvent[] = [];
    for await (const event of this.sdk.beta.sessions.events.list(
      sessionId,
      {
        ...this.headers,
        order: "asc",
      },
      requestOptions(timeout),
    ))
      result.push(event);
    return result;
  }
  async files(sessionId: string, timeout?: number) {
    const result = [];
    for await (const file of this.sdk.beta.files.list(
      {
        ...this.headers,
        scope_id: sessionId,
      },
      requestOptions(timeout),
    ))
      result.push(file);
    return result;
  }
  async download(fileId: string, timeout?: number) {
    return this.sdk.beta.files.download(
      fileId,
      this.headers,
      requestOptions(timeout),
    );
  }
  /** Sessions carrying this attempt's tag, so a lost create response can be resolved. */
  async findSessions(
    identity: string,
    createdAfter: string,
    timeout?: number,
  ): Promise<BetaManagedAgentsSession[]> {
    const result: BetaManagedAgentsSession[] = [];
    for await (const session of this.sdk.beta.sessions.list(
      {
        ...this.headers,
        agent_id: this.config.agentId,
        "created_at[gte]": createdAfter,
      },
      requestOptions(timeout),
    ))
      if (session.metadata?.factory_attempt === identity) result.push(session);
    return result;
  }
  /** The session, or undefined once it no longer exists. */
  async present(
    sessionId: string,
    timeout?: number,
  ): Promise<BetaManagedAgentsSession | undefined> {
    try {
      return await this.retrieve(sessionId, timeout);
    } catch (error) {
      if (error instanceof Anthropic.NotFoundError) return undefined;
      throw error;
    }
  }
  /** Deleting an already deleted session is a no-op, so deletion can repeat. */
  async deleteSession(sessionId: string, timeout?: number): Promise<void> {
    try {
      await this.sdk.beta.sessions.delete(
        sessionId,
        this.headers,
        requestOptions(timeout),
      );
    } catch (error) {
      if (!(error instanceof Anthropic.NotFoundError)) throw error;
    }
  }
  /** Deleting an already deleted file is a no-op, so deletion can repeat. */
  async deleteFile(fileId: string, timeout?: number): Promise<void> {
    try {
      await this.sdk.beta.files.delete(
        fileId,
        this.headers,
        requestOptions(timeout),
      );
    } catch (error) {
      if (!(error instanceof Anthropic.NotFoundError)) throw error;
    }
  }
  async fileAbsent(fileId: string, timeout?: number): Promise<boolean> {
    try {
      await this.sdk.beta.files.retrieveMetadata(
        fileId,
        this.headers,
        requestOptions(timeout),
      );
      return false;
    } catch (error) {
      if (error instanceof Anthropic.NotFoundError) return true;
      throw error;
    }
  }
}
