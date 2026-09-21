import { z } from "zod";

import type { RunPolicy } from "../protocol/policy.js";
import type { ExecutionRequirements } from "../protocol/worker-packet.js";
import {
  executionTrustMismatch,
  requiredIsolationForTrust,
  type IsolationKind,
} from "./backend.js";
import { assessBackendPolicyCompatibility, type BackendRegistry } from "./registry.js";

const RouteIdSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9._+-]+\/[A-Za-z0-9._+-]+$/);

export const ExecutionRouteCapabilitySchema = z
  .object({
    id: RouteIdSchema,
    runtimeKind: z.string().min(1).max(80).nullable(),
    hostExecution: z.boolean().nullable(),
    isolation: z.enum(["none", "process", "container", "microvm", "managed"]).nullable(),
    unavailableReasons: z
      .array(
        z.enum([
          "not-registered",
          "paid-backend-not-authorized",
          "model-selection-unsupported",
          "backend-policy-incompatible",
        ]),
      )
      .max(4),
  })
  .strict()
  .superRefine((route, context) => {
    const facts = [route.runtimeKind, route.hostExecution, route.isolation];
    const registered = facts.every((value) => value !== null);
    if (!registered && facts.some((value) => value !== null))
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "execution route capability facts are partial",
      });
    if (registered === route.unavailableReasons.includes("not-registered"))
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: registered
          ? "registered route is marked unregistered"
          : "unregistered route is missing its reason",
      });
  });

export const ExecutionRouteCatalogSchema = z
  .object({
    protocol: z.literal("clockgrove.factory/execution-route-capabilities"),
    routes: z.array(ExecutionRouteCapabilitySchema).min(1).max(16),
  })
  .strict();

export type ExecutionRouteCapability = z.infer<typeof ExecutionRouteCapabilitySchema>;
export type ExecutionRouteCatalog = z.infer<typeof ExecutionRouteCatalogSchema>;

/** Stable policy-scoped compiler facts. Probe-mutated capabilities and provider
 * diagnostics remain at runtime admission and never enter model input. */
export function executionRouteCatalog(
  registry: Pick<BackendRegistry, "capabilities" | "get">,
  policy: RunPolicy,
): ExecutionRouteCatalog {
  return ExecutionRouteCatalogSchema.parse({
    protocol: "clockgrove.factory/execution-route-capabilities",
    routes: policy.backendOrder.map((id) => {
      const backend = registry.get(id);
      const capabilities = registry.capabilities(id);
      if (!capabilities)
        return {
          id,
          runtimeKind: null,
          hostExecution: null,
          isolation: null,
          unavailableReasons: ["not-registered"],
        };
      const unavailableReasons: ExecutionRouteCapability["unavailableReasons"] = [];
      if (capabilities.requiresPaidRuntime && !policy.allowedPaidBackends.includes(id))
        unavailableReasons.push("paid-backend-not-authorized");
      if (policy.models && !capabilities.supportsModelSelection)
        unavailableReasons.push("model-selection-unsupported");
      if (
        backend &&
        !assessBackendPolicyCompatibility({
          backend,
          policy,
          requirements: {
            os: [],
            architecture: [],
            tools: [],
            services: [],
            networkDestinations: [],
            permittedSecretNames: [],
            trust: "trusted_local",
          },
          phase: "execution",
        }).compatible
      )
        unavailableReasons.push("backend-policy-incompatible");
      return {
        id,
        runtimeKind: capabilities.runtimeKind,
        hostExecution: capabilities.hostExecution,
        isolation: capabilities.isolation,
        unavailableReasons,
      };
    }),
  });
}

export interface ExecutionTrustRouteObservation {
  id: string;
  runtimeKind: string | null;
  hostExecution: boolean | null;
  isolation: IsolationKind | null;
  compatible: boolean;
  reasons: string[];
}

export function assessExecutionRouteAvailability(catalogInput: ExecutionRouteCatalog) {
  const catalog = ExecutionRouteCatalogSchema.parse(catalogInput);
  const routes: ExecutionTrustRouteObservation[] = catalog.routes.map((route) => ({
    id: route.id,
    runtimeKind: route.runtimeKind,
    hostExecution: route.hostExecution,
    isolation: route.isolation,
    compatible: route.unavailableReasons.length === 0,
    reasons: [...route.unavailableReasons],
  }));
  return {
    protocol: "clockgrove.factory/execution-route-preflight" as const,
    result: routes.some(({ compatible }) => compatible)
      ? ("passed" as const)
      : ("blocked" as const),
    required: null,
    routes,
  };
}

export function assessExecutionTrustRoutes(
  catalogInput: ExecutionRouteCatalog,
  trust: ExecutionRequirements["trust"],
) {
  const catalog = ExecutionRouteCatalogSchema.parse(catalogInput);
  const routes: ExecutionTrustRouteObservation[] = catalog.routes.map((route) => {
    const reasons: string[] = [...route.unavailableReasons];
    if (route.isolation !== null) {
      const mismatch = executionTrustMismatch(route.isolation, trust);
      if (mismatch) reasons.push(mismatch);
    }
    return {
      id: route.id,
      runtimeKind: route.runtimeKind,
      hostExecution: route.hostExecution,
      isolation: route.isolation,
      compatible: reasons.length === 0,
      reasons,
    };
  });
  return {
    protocol: "clockgrove.factory/execution-route-preflight" as const,
    result: routes.some(({ compatible }) => compatible)
      ? ("passed" as const)
      : ("blocked" as const),
    required: { trust, minimumIsolation: requiredIsolationForTrust(trust) },
    routes,
  };
}

export function executionTrustAvailability(catalog: ExecutionRouteCatalog) {
  return Object.fromEntries(
    (["trusted_local", "isolated", "managed"] as const).map((trust) => [
      trust,
      assessExecutionTrustRoutes(catalog, trust)
        .routes.filter(({ compatible }) => compatible)
        .map(({ id }) => id),
    ]),
  ) as Record<ExecutionRequirements["trust"], string[]>;
}
