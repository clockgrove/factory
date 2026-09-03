import { createHash } from "node:crypto";

import { z } from "zod";

import { boundedText, safeId } from "./limits.js";
import {
  NetworkDestinationSchema,
  type ExecutionRequirements,
} from "./worker-packet.js";

export const CloudFallbackSchema = z.enum(["never", "explicit"]);
export const TrustPolicySchema = z.enum([
  "explicitly_activated_repo",
  "sandbox_untrusted",
]);

export const RunPolicySchema = z
  .object({
    backendOrder: z.array(safeId).min(1).max(16),
    maxParallel: z.number().int().min(1).max(32),
    workItemTimeoutMinutes: z.number().int().min(1).max(24 * 60),
    objectiveTimeoutMinutes: z.number().int().min(1).max(30 * 24 * 60),
    maxAttemptsPerItem: z.number().int().min(1).max(10),
    allowedPaidBackends: z.array(safeId).max(16),
    cloudFallback: CloudFallbackSchema,
    maxSandboxMinutes: z.number().int().min(0).max(100_000),
    maxManagedAgentSessions: z.number().int().min(0).max(10_000),
    trust: TrustPolicySchema,
    managementBackend: safeId,
    modelProfile: boundedText(160).optional(),
    allowedNetworkDestinations: z.array(NetworkDestinationSchema).max(64),
  })
  .passthrough();

export type RunPolicy = z.infer<typeof RunPolicySchema>;

export const DEFAULT_RUN_POLICY: RunPolicy = Object.freeze({
  backendOrder: ["codex-cli/local-worktree"],
  maxParallel: 2,
  workItemTimeoutMinutes: 30,
  objectiveTimeoutMinutes: 720,
  maxAttemptsPerItem: 3,
  allowedPaidBackends: [],
  cloudFallback: "never",
  maxSandboxMinutes: 0,
  maxManagedAgentSessions: 0,
  trust: "explicitly_activated_repo",
  managementBackend: "codex-cli/local",
  allowedNetworkDestinations: [
    "registry.npmjs.org",
    "*.npmjs.org",
    "api.openai.com",
  ],
});

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function parseRunPolicy(input: unknown): RunPolicy {
  const policy = RunPolicySchema.parse(input);
  const allowed = new Set(policy.allowedPaidBackends);
  if (policy.cloudFallback === "never" && allowed.size > 0) {
    throw new Error("paid backends require cloudFallback=explicit");
  }
  if (policy.maxSandboxMinutes === 0) {
    const selectedSandbox = policy.backendOrder.some(
      (id) => id.includes("daytona") || id.includes("vercel-sandbox"),
    );
    if (selectedSandbox) {
      throw new Error("sandbox backend selected with zero sandbox-minute budget");
    }
  }
  if (
    policy.maxManagedAgentSessions === 0 &&
    policy.backendOrder.includes("github-copilot/github-managed")
  ) {
    throw new Error("GitHub managed backend selected with zero session budget");
  }
  for (const id of policy.backendOrder) {
    const paid =
      id.includes("daytona") ||
      id.includes("vercel-sandbox") ||
      id === "github-copilot/github-managed";
    if (paid && !allowed.has(id)) {
      throw new Error(`paid backend ${id} is not explicitly allowed`);
    }
  }
  return policy;
}

export function policyDigest(policy: RunPolicy): string {
  return createHash("sha256").update(canonical(policy)).digest("hex");
}

export function destinationAllowedByPolicy(
  destination: string,
  allowed: string[],
): boolean {
  const candidate = destination.toLowerCase();
  return allowed.some((entry) => {
    const rule = entry.toLowerCase();
    if (!rule.startsWith("*.")) return candidate === rule;
    const suffix = rule.slice(1);
    return candidate.endsWith(suffix) && candidate.length > suffix.length;
  });
}

export function assertRequirementsWithinPolicy(
  requirements: ExecutionRequirements,
  policy: RunPolicy,
  subject = "Work Item",
): void {
  const forbiddenDestinations = requirements.networkDestinations.filter(
    (destination) =>
      !destinationAllowedByPolicy(destination, policy.allowedNetworkDestinations),
  );
  if (forbiddenDestinations.length > 0) {
    throw new Error(
      `${subject} requests network destinations outside run policy: ${forbiddenDestinations.join(", ")}`,
    );
  }
  if (requirements.permittedSecretNames.length > 0) {
    throw new Error(
      `${subject} requests unsupported task secrets: ${requirements.permittedSecretNames.join(", ")}`,
    );
  }
}
