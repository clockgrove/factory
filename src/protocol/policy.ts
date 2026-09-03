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

const countMap = (value: Record<string, unknown>, context: z.RefinementCtx): void => {
  if (Object.keys(value).length > 64) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "at most 64 entries are allowed" });
  }
};

export const PriorityPolicySchema = z
  .object({
    source: z.enum(["subissue-order", "issue-field-then-subissue-order"]),
    issueFieldId: boundedText(200).optional(),
    optionRanks: z.record(safeId, z.number().int().min(0).max(1_000)).superRefine(countMap).optional(),
    unsetRank: z.number().int().min(0).max(1_000),
    onUnavailable: z.enum(["fallback-to-subissue-order", "escalate"]),
  })
  .strict()
  .superRefine((value, context) => {
    const usesField = value.source === "issue-field-then-subissue-order";
    if (usesField && !value.issueFieldId) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["issueFieldId"], message: "is required for issue-field priority" });
    }
    if (usesField && (!value.optionRanks || Object.keys(value.optionRanks).length === 0)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["optionRanks"], message: "must map at least one stable option ID" });
    }
    if (!usesField && (value.issueFieldId || value.optionRanks)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "subissue-order priority cannot configure an issue field" });
    }
  });

export const LocalCapacityPolicySchema = z
  .object({
    maxWorkers: z.number().int().min(1).max(32),
    defaultCpu: z.number().positive().max(256),
    defaultMemoryMb: z.number().int().positive().max(1_048_576),
    reserveCpu: z.number().min(0).max(256),
    reserveMemoryMb: z.number().int().min(0).max(1_048_576),
    minimumFreeMemoryMb: z.number().int().min(0).max(1_048_576),
    maxLoadRatio: z.number().positive().max(1),
    maxMemoryUsageRatio: z.number().positive().max(1),
    sampleIntervalSeconds: z.number().int().min(1).max(60),
    admissionCooldownSeconds: z.number().int().min(0).max(300),
  })
  .strict();

export const CapacityPolicySchema = z
  .object({
    mode: z.enum(["fixed", "adaptive-local"]),
    local: LocalCapacityPolicySchema.optional(),
    backendMaxParallel: z.record(safeId, z.number().int().min(1).max(32)).superRefine(countMap).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.mode === "adaptive-local" && !value.local) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["local"], message: "is required for adaptive-local capacity" });
    }
  });

export const BurstPolicySchema = z
  .object({
    mode: z.enum(["never", "saturation", "queue-delay", "deadline", "queue-or-deadline"]),
    backendOrder: z.array(safeId).max(16),
    maxCloudParallel: z.number().int().min(1).max(32),
    queueDelaySeconds: z.number().int().min(0).max(86_400),
    deadlineReserveMinutes: z.number().int().min(0).max(30 * 24 * 60),
    maxPriorityRank: z.number().int().min(0).max(1_000),
  })
  .strict();

export const DeliveryPolicySchema = z
  .object({
    mode: z.enum(["regular-prs", "stacked-prs"]),
    onUnavailable: z.enum(["regular-prs", "escalate"]),
    merge: z.enum(["bottom-up", "atomic-stack"]),
  })
  .strict();

const ModelProfileSchema = z
  .object({
    model: boundedText(160),
    reasoning: boundedText(80),
  })
  .strict();

export const ModelsPolicySchema = z
  .object({
    mode: z.enum(["single-profile", "task-class"]),
    profiles: z.record(safeId, ModelProfileSchema).superRefine(countMap),
    phaseProfiles: z
      .object({
        compile: safeId,
        implement: safeId,
        review: safeId,
        recover: safeId,
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    for (const [phase, profile] of Object.entries(value.phaseProfiles)) {
      if (!value.profiles[profile]) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["phaseProfiles", phase], message: `references unknown profile ${profile}` });
      }
    }
  });

export const EconomicsPolicySchema = z
  .object({
    maxModelTokens: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    maxSandboxMinutes: z.number().int().min(0).max(100_000),
    maxManagedSessions: z.number().int().min(0).max(10_000),
    minCloudTimeSavedMinutes: z.number().int().min(0).max(30 * 24 * 60),
  })
  .strict();

export const ControllerPolicySchema = z
  .object({
    scope: z.literal("repository"),
    maxActiveObjectives: z.number().int().min(1).max(32),
    maxLocalWorkers: z.number().int().min(1).max(32),
    maxPaidWorkers: z.number().int().min(0).max(32),
    pollIntervalSeconds: z.number().int().min(1).max(300),
  })
  .strict();

export type ControllerPolicy = z.infer<typeof ControllerPolicySchema>;

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
    priority: PriorityPolicySchema.optional(),
    capacity: CapacityPolicySchema.optional(),
    burst: BurstPolicySchema.optional(),
    delivery: DeliveryPolicySchema.optional(),
    models: ModelsPolicySchema.optional(),
    economics: EconomicsPolicySchema.optional(),
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

export interface EffectiveSchedulingPolicy {
  priority: z.infer<typeof PriorityPolicySchema>;
  capacity: Omit<z.infer<typeof CapacityPolicySchema>, "local" | "backendMaxParallel"> & {
    local: z.infer<typeof LocalCapacityPolicySchema>;
    backendMaxParallel: Record<string, number>;
  };
  burst: z.infer<typeof BurstPolicySchema>;
}

export function normalizeSchedulingPolicy(policy: RunPolicy): EffectiveSchedulingPolicy {
  const local = policy.capacity?.local ?? {
    maxWorkers: policy.maxParallel,
    defaultCpu: 1,
    defaultMemoryMb: 2_048,
    reserveCpu: 0.5,
    reserveMemoryMb: 1_024,
    minimumFreeMemoryMb: 1_024,
    maxLoadRatio: 0.9,
    maxMemoryUsageRatio: 0.85,
    sampleIntervalSeconds: 5,
    admissionCooldownSeconds: 10,
  };
  return {
    priority: policy.priority ?? {
      source: "subissue-order",
      unsetRank: 100,
      onUnavailable: "fallback-to-subissue-order",
    },
    capacity: {
      mode: policy.capacity?.mode ?? "fixed",
      local,
      backendMaxParallel: Object.fromEntries(
        policy.backendOrder.map((id) => [
          id,
          policy.capacity?.backendMaxParallel?.[id] ?? policy.maxParallel,
        ]),
      ),
    },
    burst: policy.burst ?? {
      mode: "never",
      backendOrder: [],
      maxCloudParallel: 1,
      queueDelaySeconds: 120,
      deadlineReserveMinutes: 60,
      maxPriorityRank: 1_000,
    },
  };
}

export function parseControllerPolicy(input: unknown): ControllerPolicy {
  return ControllerPolicySchema.parse(input);
}

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
  for (const id of Object.keys(policy.capacity?.backendMaxParallel ?? {})) {
    if (!policy.backendOrder.includes(id)) {
      throw new Error(`capacity backend ${id} is absent from backendOrder`);
    }
  }
  if (policy.capacity?.local && policy.capacity.local.maxWorkers > policy.maxParallel) {
    throw new Error("capacity.local.maxWorkers cannot exceed maxParallel");
  }
  if (policy.burst) {
    if (policy.burst.deadlineReserveMinutes > policy.objectiveTimeoutMinutes) {
      throw new Error("burst deadline reserve cannot exceed Objective timeout");
    }
    for (const id of policy.burst.backendOrder) {
      if (!policy.backendOrder.includes(id)) {
        throw new Error(`burst backend ${id} is absent from backendOrder`);
      }
      if (!allowed.has(id)) {
        throw new Error(`burst backend ${id} is not explicitly allowed`);
      }
      if (!(id.includes("daytona") || id.includes("vercel-sandbox") || id === "github-copilot/github-managed")) {
        throw new Error(`burst backend ${id} is not a paid backend`);
      }
    }
    if (policy.burst.mode !== "never") {
      if (policy.cloudFallback !== "explicit") {
        throw new Error("enabled burst requires cloudFallback=explicit");
      }
      if (policy.burst.backendOrder.length === 0) {
        throw new Error("enabled burst requires at least one backend");
      }
      const needsSandbox = policy.burst.backendOrder.some((id) => id.includes("daytona") || id.includes("vercel-sandbox"));
      const needsManaged = policy.burst.backendOrder.includes("github-copilot/github-managed");
      if (needsSandbox && policy.maxSandboxMinutes === 0) {
        throw new Error("enabled sandbox burst requires a nonzero sandbox-minute budget");
      }
      if (needsManaged && policy.maxManagedAgentSessions === 0) {
        throw new Error("enabled managed burst requires a nonzero session budget");
      }
    }
  }
  if (policy.economics) {
    if (policy.economics.maxSandboxMinutes !== policy.maxSandboxMinutes) {
      throw new Error("economics.maxSandboxMinutes must equal the legacy sandbox budget");
    }
    if (policy.economics.maxManagedSessions !== policy.maxManagedAgentSessions) {
      throw new Error("economics.maxManagedSessions must equal the legacy managed-session budget");
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
