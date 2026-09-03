import type { RunPolicy } from "../protocol/policy.js";
import type { ExecutionRequirements } from "../protocol/worker-packet.js";
import {
  capabilityMismatch,
  type BackendProbe,
  type ExecutionBackend,
} from "./backend.js";

export interface BudgetRemaining {
  sandboxMinutes: number;
  managedAgentSessions: number;
}

export interface BackendSelection {
  backend: ExecutionBackend;
  probe: BackendProbe;
}

export interface BackendRejection {
  id: string;
  reasons: string[];
}

export class NoExecutionBackendError extends Error {
  readonly rejections: BackendRejection[];

  constructor(rejections: BackendRejection[]) {
    super(
      `no execution backend satisfies policy and requirements: ${rejections
        .map((item) => `${item.id} (${item.reasons.join("; ")})`)
        .join(", ")}`,
    );
    this.name = "NoExecutionBackendError";
    this.rejections = rejections;
  }
}

export class BackendRegistry {
  readonly #backends = new Map<string, ExecutionBackend>();

  register(backend: ExecutionBackend): void {
    const id = backend.capabilities.id;
    if (!/^[A-Za-z0-9._+-]+\/[A-Za-z0-9._+-]+$/.test(id)) {
      throw new Error(`backend id must be an agent/runtime bundle: ${id}`);
    }
    if (this.#backends.has(id)) throw new Error(`duplicate backend ${id}`);
    this.#backends.set(id, backend);
  }

  get(id: string): ExecutionBackend | null {
    return this.#backends.get(id) ?? null;
  }

  list(): ExecutionBackend[] {
    return [...this.#backends.values()];
  }

  async probeAll(): Promise<Array<{ id: string; probe: BackendProbe }>> {
    return Promise.all(
      this.list().map(async (backend) => ({
        id: backend.capabilities.id,
        probe: await backend.probe().catch((error: unknown) => ({
          available: false,
          authenticated: false,
          reason: error instanceof Error ? error.message : String(error),
          measuredAt: new Date().toISOString(),
        })),
      })),
    );
  }

  async select(args: {
    policy: RunPolicy;
    requirements: ExecutionRequirements;
    budget: BudgetRemaining;
    estimatedDurationMs?: number;
  }): Promise<BackendSelection> {
    const rejections: BackendRejection[] = [];
    for (const id of args.policy.backendOrder) {
      const backend = this.#backends.get(id);
      if (!backend) {
        rejections.push({ id, reasons: ["not registered"] });
        continue;
      }
      const reasons = capabilityMismatch(backend.capabilities, args.requirements);
      if (
        backend.capabilities.requiresPaidRuntime &&
        !args.policy.allowedPaidBackends.includes(id)
      ) {
        reasons.push("paid backend not allowed by run policy");
      }
      if (
        (id.includes("daytona") || id.includes("vercel-sandbox")) &&
        args.budget.sandboxMinutes * 60_000 < (args.estimatedDurationMs ?? 1)
      ) {
        reasons.push("insufficient sandbox-minute budget for the bounded attempt");
      }
      if (
        id === "github-copilot/github-managed" &&
        args.budget.managedAgentSessions <= 0
      ) {
        reasons.push("managed-session budget exhausted");
      }
      let probe: BackendProbe | null = null;
      if (reasons.length === 0) {
        probe = await backend.probe().catch((error: unknown) => ({
          available: false,
          authenticated: false,
          reason: error instanceof Error ? error.message : String(error),
          measuredAt: new Date().toISOString(),
        }));
        if (!probe.available) reasons.push(probe.reason ?? "unavailable");
        else if (!probe.authenticated) reasons.push(probe.reason ?? "not authenticated");
      }
      if (reasons.length === 0 && probe) return { backend, probe };
      rejections.push({ id, reasons });
    }
    throw new NoExecutionBackendError(rejections);
  }

  async selectIsolatedValidator(args: {
    policy: RunPolicy;
    requirements: ExecutionRequirements;
    budget: BudgetRemaining;
    estimatedDurationMs: number;
  }): Promise<BackendSelection> {
    const rejections: BackendRejection[] = [];
    for (const id of args.policy.backendOrder) {
      const backend = this.#backends.get(id);
      if (!backend) {
        rejections.push({ id, reasons: ["not registered"] });
        continue;
      }
      const reasons: string[] = [];
      if (!backend.validate || !backend.probeValidation) {
        reasons.push("does not provide independent isolated validation");
      }
      if (!(["container", "microvm", "managed"] as const).includes(
        backend.capabilities.isolation as "container" | "microvm" | "managed",
      )) {
        reasons.push("validation boundary is weaker than a container");
      }
      const validationRequirements = { ...args.requirements, trust: "isolated" as const };
      reasons.push(...capabilityMismatch(backend.capabilities, validationRequirements));
      if (
        backend.capabilities.requiresPaidRuntime &&
        !args.policy.allowedPaidBackends.includes(id)
      ) {
        reasons.push("paid backend not allowed by run policy");
      }
      if (args.budget.sandboxMinutes * 60_000 < args.estimatedDurationMs) {
        reasons.push("insufficient sandbox-minute budget for independent validation");
      }
      let probe: BackendProbe | null = null;
      if (reasons.length === 0) {
        probe = await backend.probeValidation!().catch((error: unknown) => ({
          available: false,
          authenticated: false,
          reason: error instanceof Error ? error.message : String(error),
          measuredAt: new Date().toISOString(),
        }));
        if (!probe.available) reasons.push(probe.reason ?? "unavailable");
        else if (!probe.authenticated) reasons.push(probe.reason ?? "not authenticated");
      }
      if (reasons.length === 0 && probe) return { backend, probe };
      rejections.push({ id, reasons });
    }
    throw new NoExecutionBackendError(rejections);
  }
}
