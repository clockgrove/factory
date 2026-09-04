import { describe, expect, it } from "vitest";

import type {
  AttemptContext,
  BackendHandle,
  BackendObservation,
  BackendProbe,
  ExecutionBackend,
  ExecutionBackendCapabilities,
  IsolatedValidationContext,
  IsolatedValidationResult,
} from "../src/execution/backend.js";
import { capabilityMismatch } from "../src/execution/backend.js";
import {
  assertArtifactScope,
  boundWorkerLogs,
  normalizeArtifact,
  verifyArtifact,
} from "../src/execution/artifacts.js";
import {
  BackendRegistry,
  NoExecutionBackendError,
} from "../src/execution/registry.js";
import { DEFAULT_RUN_POLICY } from "../src/protocol/policy.js";
import { byteLength, MAX_LOG_BYTES } from "../src/protocol/limits.js";
import type { NormalizedArtifact } from "../src/execution/artifacts.js";

const SHA = "a".repeat(40);

class FakeBackend implements ExecutionBackend {
  probeCalls = 0;
  validationProbeCalls = 0;
  constructor(
    readonly capabilities: ExecutionBackendCapabilities,
    private readonly result: BackendProbe = {
      available: true,
      authenticated: true,
      measuredAt: "2026-09-03T00:00:00.000Z",
    },
  ) {}

  async probe(): Promise<BackendProbe> {
    this.probeCalls += 1;
    return this.result;
  }
  async launch(_context: AttemptContext): Promise<BackendHandle> {
    return {
      backendId: this.capabilities.id,
      resourceId: "fake-1",
      startedAt: "2026-09-03T00:00:00.000Z",
    };
  }
  async observe(_handle: BackendHandle): Promise<BackendObservation> {
    return { state: "succeeded", observedAt: "2026-09-03T00:00:01.000Z" };
  }
  async cancel(_handle: BackendHandle): Promise<void> {}
  async collect(_handle: BackendHandle): Promise<NormalizedArtifact> {
    return normalizeArtifact({
      baseSha: SHA,
      patch: "diff --git a/src/a.ts b/src/a.ts",
      changedPaths: ["src/a.ts"],
      outcome: "succeeded",
    });
  }
  async cleanup(_handle: BackendHandle): Promise<void> {}
  async probeValidation(): Promise<BackendProbe> {
    this.validationProbeCalls += 1;
    return this.result;
  }
  async validate(_context: IsolatedValidationContext): Promise<IsolatedValidationResult> {
    return {
      outputTreeSha: SHA,
      commands: [],
      passed: true,
      startedAt: "2026-09-03T00:00:00.000Z",
      completedAt: "2026-09-03T00:00:01.000Z",
    };
  }
}

function capabilities(
  over: Partial<ExecutionBackendCapabilities> = {},
): ExecutionBackendCapabilities {
  return {
    id: "codex-cli/local-worktree",
    agentKind: "codex-cli",
    runtimeKind: "local-worktree",
    hostExecution: true,
    isolation: "process",
    supportedOs: ["linux"],
    supportedArchitectures: ["x64"],
    supportedTools: ["node", "git"],
    supportedServices: [],
    supportsCancellation: true,
    supportsObservation: true,
    supportsResume: false,
    supportsLocalInference: false,
    requiresPaidRuntime: false,
    providerManagedPublication: false,
    requiredCredentials: ["codex-login"],
    ...over,
  };
}

describe("normalized artifacts", () => {
  it("binds the digest to the base, paths, and patch", () => {
    const artifact = normalizeArtifact({
      baseSha: SHA,
      patch: "diff --git a/src/a.ts b/src/a.ts",
      changedPaths: ["src/a.ts"],
      outcome: "succeeded",
    });
    expect(verifyArtifact(artifact)).toEqual(artifact);
    expect(() => verifyArtifact({ ...artifact, patch: `${artifact.patch}\nchanged` })).toThrow(
      /digest/,
    );
  });

  it("rejects path traversal and out-of-scope paths", () => {
    expect(() =>
      normalizeArtifact({
        baseSha: SHA,
        patch: "x",
        changedPaths: ["../outside"],
        outcome: "succeeded",
      }),
    ).toThrow(/traverse/);
    const artifact = normalizeArtifact({
      baseSha: SHA,
      patch: "x",
      changedPaths: ["src/a.ts", "package-lock.json"],
      outcome: "succeeded",
    });
    expect(() => assertArtifactScope(artifact, ["src/"])).toThrow(/package-lock/);
  });

  it("rejects credentials in returned logs", () => {
    expect(() =>
      normalizeArtifact({
        baseSha: SHA,
        patch: "x",
        changedPaths: ["src/a.ts"],
        logs: `authorization: bearer ghp_${"x".repeat(40)}`,
        outcome: "failed",
      }),
    ).toThrow(/suspected GitHub token|authorization header/);
  });

  it("bounds oversized Unicode logs by persisted bytes and retains their tail", () => {
    const tail = "final diagnostic line";
    const logs = `${"progress \"line\"\n".repeat(10_000)}${"🎮".repeat(10_000)}${tail}`;
    const bounded = boundWorkerLogs(logs);
    const artifact = normalizeArtifact({
      baseSha: SHA,
      patch: "x",
      changedPaths: ["src/a.ts"],
      logs,
      outcome: "succeeded",
    });

    expect(bounded).toMatch(/^\[Factory truncated worker logs/);
    expect(bounded.endsWith(tail)).toBe(true);
    expect(byteLength(bounded)).toBeLessThanOrEqual(MAX_LOG_BYTES);
    expect(artifact.logs).toBe(bounded);
    expect(verifyArtifact(artifact)).toEqual(artifact);
  });

  it("scans discarded log output for credentials before truncation", () => {
    const logs =
      `authorization: bearer ghp_${"x".repeat(40)}\n` +
      "later output\n".repeat(10_000);
    expect(() =>
      normalizeArtifact({
        baseSha: SHA,
        patch: "x",
        changedPaths: ["src/a.ts"],
        logs,
        outcome: "failed",
      }),
    ).toThrow(/suspected GitHub token|authorization header/);
  });
});

describe("backend registry", () => {
  it("evaluates every backend and expires the side-effect-free probe cache", async () => {
    const registry = new BackendRegistry();
    const backend = new FakeBackend(capabilities());
    registry.register(backend);
    const requirements = {
      os: ["linux"], architecture: ["x64"], tools: ["git"], services: [],
      networkDestinations: [], permittedSecretNames: [], trust: "trusted_local" as const,
    };
    const first = await registry.evaluate({
      policy: DEFAULT_RUN_POLICY,
      requirements,
      nowMs: 1_000,
      probeTtlMs: 30_000,
    });
    const cached = await registry.evaluate({
      policy: DEFAULT_RUN_POLICY,
      requirements,
      nowMs: 30_999,
      probeTtlMs: 30_000,
    });
    await registry.evaluate({
      policy: DEFAULT_RUN_POLICY,
      requirements,
      nowMs: 31_000,
      probeTtlMs: 30_000,
    });
    expect(first[0]).toMatchObject({
      id: "codex-cli/local-worktree",
      local: true,
      paid: false,
      permanentReasons: [],
      transientReasons: [],
    });
    expect(cached[0]!.probe).toBe(first[0]!.probe);
    expect(backend.probeCalls).toBe(2);
  });

  it("matches common operating-system and architecture aliases", () => {
    expect(capabilityMismatch(capabilities(), {
      os: ["gnu/linux"],
      architecture: ["x86_64"],
      tools: [], services: [], networkDestinations: [], permittedSecretNames: [],
      trust: "trusted_local",
    })).toEqual([]);
  });

  it("rejects arbitrary agent/runtime identifiers", () => {
    const registry = new BackendRegistry();
    expect(() =>
      registry.register(new FakeBackend(capabilities({ id: "local" }))),
    ).toThrow(/bundle/);
  });

  it("selects the first available capability-compatible backend", async () => {
    const registry = new BackendRegistry();
    registry.register(
      new FakeBackend(capabilities(), {
        available: false,
        authenticated: false,
        reason: "Codex missing",
        measuredAt: "2026-09-03T00:00:00.000Z",
      }),
    );
    registry.register(
      new FakeBackend(
        capabilities({
          id: "codex-native/local-worktree",
          agentKind: "codex-native",
        }),
      ),
    );
    const selected = await registry.select({
      policy: {
        ...DEFAULT_RUN_POLICY,
        backendOrder: [
          "codex-cli/local-worktree",
          "codex-native/local-worktree",
        ],
      },
      requirements: {
        os: ["linux"],
        architecture: ["x64"],
        tools: ["git"],
        services: [],
        networkDestinations: [],
        permittedSecretNames: [],
        trust: "trusted_local",
      },
      budget: { sandboxMinutes: 0, managedAgentSessions: 0 },
    });
    expect(selected.backend.capabilities.id).toBe("codex-native/local-worktree");
  });

  it("lets a backend discover requested capabilities before matching", async () => {
    class DiscoveringBackend extends FakeBackend {
      override async probe(
        requirements?: Parameters<ExecutionBackend["probe"]>[0],
      ): Promise<BackendProbe> {
        if (requirements?.tools.includes("systemctl")) {
          this.capabilities.supportedTools.push("systemctl");
        }
        return super.probe();
      }
    }
    const registry = new BackendRegistry();
    registry.register(new DiscoveringBackend(capabilities()));
    const selected = await registry.select({
      policy: DEFAULT_RUN_POLICY,
      requirements: {
        os: [], architecture: [], tools: ["systemctl"], services: [],
        networkDestinations: [], permittedSecretNames: [], trust: "trusted_local",
      },
      budget: { sandboxMinutes: 0, managedAgentSessions: 0 },
    });

    expect(selected.backend.capabilities.supportedTools).toContain("systemctl");
  });

  it("fails before launch when only an unapproved paid backend fits", async () => {
    const registry = new BackendRegistry();
    registry.register(
      new FakeBackend(
        capabilities({
          id: "codex-cli/daytona",
          runtimeKind: "daytona",
          hostExecution: false,
          isolation: "container",
          requiresPaidRuntime: true,
        }),
      ),
    );
    await expect(
      registry.select({
        policy: {
          ...DEFAULT_RUN_POLICY,
          backendOrder: ["codex-cli/daytona"],
        },
        requirements: {
          os: [],
          architecture: [],
          tools: [],
          services: [],
          networkDestinations: [],
          permittedSecretNames: [],
          trust: "isolated",
        },
        budget: { sandboxMinutes: 60, managedAgentSessions: 0 },
      }),
    ).rejects.toBeInstanceOf(NoExecutionBackendError);
  });

  it("selects a separately budgeted isolated validator", async () => {
    const registry = new BackendRegistry();
    const validator = new FakeBackend(
        capabilities({
          id: "codex-cli/vercel-sandbox",
          runtimeKind: "vercel-sandbox",
          hostExecution: false,
          isolation: "microvm",
          requiresPaidRuntime: true,
        }),
      );
    registry.register(validator);
    const policy = {
      ...DEFAULT_RUN_POLICY,
      backendOrder: ["codex-cli/vercel-sandbox"],
      allowedPaidBackends: ["codex-cli/vercel-sandbox"],
      cloudFallback: "explicit" as const,
      maxSandboxMinutes: 60,
    };
    const selected = await registry.selectIsolatedValidator({
      policy,
      requirements: {
        os: ["linux"], architecture: ["x64"], tools: ["git"], services: [],
        networkDestinations: [], permittedSecretNames: [], trust: "managed",
      },
      budget: { sandboxMinutes: 30, managedAgentSessions: 0 },
      estimatedDurationMs: 10 * 60_000,
    });
    expect(selected.backend.capabilities.id).toBe("codex-cli/vercel-sandbox");
    const validationRequirements = {
      os: ["linux"], architecture: ["x64"], tools: ["git"], services: [],
      networkDestinations: [], permittedSecretNames: [], trust: "managed" as const,
    };
    await registry.evaluateIsolatedValidators({
      policy,
      requirements: validationRequirements,
      nowMs: 1_000,
    });
    await registry.evaluateIsolatedValidators({
      policy,
      requirements: validationRequirements,
      nowMs: 20_000,
    });
    expect(validator.validationProbeCalls).toBe(1);
    await expect(
      registry.selectIsolatedValidator({
        policy,
        requirements: {
          os: ["linux"], architecture: [], tools: [], services: [],
          networkDestinations: [], permittedSecretNames: [], trust: "isolated",
        },
        budget: { sandboxMinutes: 5, managedAgentSessions: 0 },
        estimatedDurationMs: 10 * 60_000,
      }),
    ).rejects.toThrow(/insufficient sandbox-minute budget/);
  });
});
