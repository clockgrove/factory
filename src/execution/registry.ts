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

export interface BackendCandidate {
  id: string;
  registered: boolean;
  backend: ExecutionBackend | null;
  capabilities: ExecutionBackend["capabilities"] | null;
  probe: BackendProbe | null;
  costClass: "local" | "sandbox" | "managed";
  local: boolean;
  paid: boolean;
  permanentReasons: string[];
  transientReasons: string[];
}

function backendCostClass(id: string): BackendCandidate["costClass"] {
  return id === "github-copilot/github-managed"
    ? "managed"
    : id.includes("daytona") || id.includes("vercel-sandbox")
      ? "sandbox"
      : "local";
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
  readonly #probeCache = new Map<
    string,
    { probe: BackendProbe; expiresAt: number }
  >();

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

  async evaluate(args: {
    policy: RunPolicy;
    requirements: ExecutionRequirements;
    nowMs?: number;
    probeTtlMs?: number;
  }): Promise<BackendCandidate[]> {
    const nowMs = args.nowMs ?? Date.now();
    const ttl = args.probeTtlMs ?? 30_000;
    const requirementKey = JSON.stringify(args.requirements);
    const candidates: BackendCandidate[] = [];
    for (const id of args.policy.backendOrder) {
      const backend = this.#backends.get(id) ?? null;
      const costClass = backendCostClass(id);
      const permanentReasons: string[] = [];
      const transientReasons: string[] = [];
      if (!backend) {
        permanentReasons.push("not registered");
        candidates.push({
          id,
          registered: false,
          backend: null,
          capabilities: null,
          probe: null,
          costClass,
          local: false,
          paid: costClass !== "local",
          permanentReasons,
          transientReasons,
        });
        continue;
      }
      if (
        backend.capabilities.requiresPaidRuntime &&
        !args.policy.allowedPaidBackends.includes(id)
      ) {
        permanentReasons.push("paid backend not allowed by run policy");
      }
      let probe: BackendProbe | null = null;
      if (permanentReasons.length === 0) {
        const key = `${id}\n${requirementKey}`;
        const cached = this.#probeCache.get(key);
        if (cached && nowMs < cached.expiresAt) {
          probe = cached.probe;
        } else {
          probe = await backend.probe(args.requirements).catch((error: unknown) => ({
            available: false,
            authenticated: false,
            reason: error instanceof Error ? error.message : String(error),
            measuredAt: new Date(nowMs).toISOString(),
          }));
          this.#probeCache.set(key, { probe, expiresAt: nowMs + ttl });
        }
        if (!probe.available) transientReasons.push(probe.reason ?? "unavailable");
        else if (!probe.authenticated) {
          transientReasons.push(probe.reason ?? "not authenticated");
        } else {
          permanentReasons.push(
            ...capabilityMismatch(backend.capabilities, args.requirements),
          );
        }
      }
      candidates.push({
        id,
        registered: true,
        backend,
        capabilities: backend.capabilities,
        probe,
        costClass,
        local:
          backend.capabilities.hostExecution &&
          !backend.capabilities.requiresPaidRuntime,
        paid: backend.capabilities.requiresPaidRuntime,
        permanentReasons,
        transientReasons,
      });
    }
    return candidates;
  }

  async evaluateIsolatedValidators(args: {
    policy: RunPolicy;
    requirements: ExecutionRequirements;
    nowMs?: number;
    probeTtlMs?: number;
  }): Promise<BackendCandidate[]> {
    const nowMs = args.nowMs ?? Date.now();
    const ttl = args.probeTtlMs ?? 30_000;
    const validationRequirements = {
      ...args.requirements,
      trust: "isolated" as const,
    };
    const requirementKey = JSON.stringify(validationRequirements);
    const candidates: BackendCandidate[] = [];
    for (const id of args.policy.backendOrder) {
      const backend = this.#backends.get(id) ?? null;
      const costClass = backendCostClass(id);
      const permanentReasons: string[] = [];
      const transientReasons: string[] = [];
      if (!backend) {
        candidates.push({
          id,
          registered: false,
          backend: null,
          capabilities: null,
          probe: null,
          costClass,
          local: false,
          paid: costClass !== "local",
          permanentReasons: ["not registered"],
          transientReasons,
        });
        continue;
      }
      if (!backend.validate || !backend.probeValidation) {
        permanentReasons.push("does not provide independent isolated validation");
      }
      if (!(["container", "microvm", "managed"] as const).includes(
        backend.capabilities.isolation as "container" | "microvm" | "managed",
      )) {
        permanentReasons.push("validation boundary is weaker than a container");
      }
      permanentReasons.push(
        ...capabilityMismatch(backend.capabilities, validationRequirements),
      );
      if (
        backend.capabilities.requiresPaidRuntime &&
        !args.policy.allowedPaidBackends.includes(id)
      ) {
        permanentReasons.push("paid backend not allowed by run policy");
      }
      if (costClass === "managed") {
        permanentReasons.push("managed-session backends cannot host validation");
      }
      let probe: BackendProbe | null = null;
      if (permanentReasons.length === 0) {
        const key = `validation\n${id}\n${requirementKey}`;
        const cached = this.#probeCache.get(key);
        if (cached && nowMs < cached.expiresAt) {
          probe = cached.probe;
        } else {
          probe = await backend.probeValidation!().catch((error: unknown) => ({
            available: false,
            authenticated: false,
            reason: error instanceof Error ? error.message : String(error),
            measuredAt: new Date(nowMs).toISOString(),
          }));
          this.#probeCache.set(key, { probe, expiresAt: nowMs + ttl });
        }
        if (!probe.available) transientReasons.push(probe.reason ?? "unavailable");
        else if (!probe.authenticated) {
          transientReasons.push(probe.reason ?? "not authenticated");
        }
      }
      candidates.push({
        id,
        registered: true,
        backend,
        capabilities: backend.capabilities,
        probe,
        costClass,
        local:
          backend.capabilities.hostExecution &&
          !backend.capabilities.requiresPaidRuntime,
        paid: backend.capabilities.requiresPaidRuntime,
        permanentReasons,
        transientReasons,
      });
    }
    return candidates;
  }

  async select(args: {
    policy: RunPolicy;
    requirements: ExecutionRequirements;
    budget: BudgetRemaining;
    estimatedDurationMs?: number;
  }): Promise<BackendSelection> {
    const rejections: BackendRejection[] = [];
    for (const candidate of await this.evaluate({
      policy: args.policy,
      requirements: args.requirements,
    })) {
      const { id, backend, probe } = candidate;
      const reasons = [...candidate.permanentReasons, ...candidate.transientReasons];
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
      if (reasons.length === 0 && backend && probe) return { backend, probe };
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
    for (const candidate of await this.evaluateIsolatedValidators({
      policy: args.policy,
      requirements: args.requirements,
    })) {
      const { id, backend, probe } = candidate;
      const reasons = [
        ...candidate.permanentReasons,
        ...candidate.transientReasons,
      ];
      if (
        candidate.costClass === "sandbox" &&
        args.budget.sandboxMinutes * 60_000 < args.estimatedDurationMs
      ) {
        reasons.push("insufficient sandbox-minute budget for independent validation");
      }
      if (reasons.length === 0 && backend && probe) return { backend, probe };
      rejections.push({ id, reasons });
    }
    throw new NoExecutionBackendError(rejections);
  }
}
