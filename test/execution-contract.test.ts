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
import {
  assertArtifactScope,
  normalizeArtifact,
  verifyArtifact,
} from "../src/execution/artifacts.js";
import {
  BackendRegistry,
  NoExecutionBackendError,
} from "../src/execution/registry.js";
import { DEFAULT_RUN_POLICY } from "../src/protocol/policy.js";
import type { NormalizedArtifact } from "../src/execution/artifacts.js";

const SHA = "a".repeat(40);

class FakeBackend implements ExecutionBackend {
  constructor(
    readonly capabilities: ExecutionBackendCapabilities,
    private readonly result: BackendProbe = {
      available: true,
      authenticated: true,
      measuredAt: "2026-09-03T00:00:00.000Z",
    },
  ) {}

  async probe(): Promise<BackendProbe> {
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
});

describe("backend registry", () => {
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
    registry.register(
      new FakeBackend(
        capabilities({
          id: "codex-cli/vercel-sandbox",
          runtimeKind: "vercel-sandbox",
          hostExecution: false,
          isolation: "microvm",
          requiresPaidRuntime: true,
        }),
      ),
    );
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
