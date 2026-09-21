import { describe, expect, it } from "vitest";

import type {
  AttemptContext,
  BackendHandle,
  BackendObservation,
  BackendProbe,
  ExecutionBackend,
  ExecutionBackendCapabilities,
} from "../src/execution/backend.js";
import type { NormalizedArtifact } from "../src/execution/artifacts.js";
import { BackendRegistry } from "../src/execution/registry.js";
import {
  assessExecutionTrustRoutes,
  executionRouteCatalog,
  type ExecutionRouteCatalog,
} from "../src/execution/route-capabilities.js";
import { DEFAULT_RUN_POLICY, type RunPolicy } from "../src/protocol/policy.js";
import { DaytonaBackend } from "../src/backends/daytona.js";
import {
  GITHUB_COPILOT_MANAGED_PROFILE,
  githubManagedAgentBackendCapabilities,
} from "../src/backends/github-copilot.js";

class RouteFixtureBackend implements ExecutionBackend {
  constructor(readonly capabilities: ExecutionBackendCapabilities) {}

  async probe(): Promise<BackendProbe> {
    return {
      available: true,
      authenticated: true,
      measuredAt: "2026-09-20T00:00:00.000Z",
    };
  }

  async launch(_context: AttemptContext): Promise<BackendHandle> {
    throw new Error("route catalog tests do not launch backends");
  }

  async observe(_handle: BackendHandle): Promise<BackendObservation> {
    throw new Error("route catalog tests do not observe backends");
  }

  async cancel(_handle: BackendHandle): Promise<void> {}

  async collect(_handle: BackendHandle): Promise<NormalizedArtifact> {
    throw new Error("route catalog tests do not collect artifacts");
  }

  async cleanup(_handle: BackendHandle): Promise<void> {}
}

function capabilities(
  id: string,
  overrides: Partial<ExecutionBackendCapabilities> = {},
): ExecutionBackendCapabilities {
  return {
    id,
    agentKind: "fixture-agent",
    runtimeKind: "fixture-runtime",
    hostExecution: true,
    isolation: "process",
    supportedOs: ["linux"],
    supportedArchitectures: ["x64"],
    supportedTools: [],
    supportedServices: [],
    supportsCancellation: true,
    supportsObservation: true,
    supportsResume: false,
    supportsLocalInference: false,
    supportsModelSelection: true,
    requiresPaidRuntime: false,
    providerManagedPublication: false,
    requiredCredentials: [],
    ...overrides,
  };
}

function trustCatalog(): ExecutionRouteCatalog {
  return {
    protocol: "clockgrove.factory/execution-route-capabilities",
    routes: [
      {
        id: "fixture/process",
        runtimeKind: "process",
        hostExecution: true,
        isolation: "process",
        unavailableReasons: [],
      },
      {
        id: "fixture/container",
        runtimeKind: "container",
        hostExecution: false,
        isolation: "container",
        unavailableReasons: [],
      },
      {
        id: "fixture/managed",
        runtimeKind: "managed",
        hostExecution: false,
        isolation: "managed",
        unavailableReasons: [],
      },
    ],
  };
}

describe("compiler execution route capabilities", () => {
  it("derives only policy-authorized routes in exact policy order", () => {
    const registry = new BackendRegistry();
    registry.register(new RouteFixtureBackend(capabilities("fixture/local")));
    registry.register(
      new RouteFixtureBackend(
        capabilities("fixture/paid", {
          hostExecution: false,
          isolation: "container",
          requiresPaidRuntime: true,
        }),
      ),
    );
    registry.register(new RouteFixtureBackend(capabilities("fixture/unlisted")));
    const policy: RunPolicy = {
      ...DEFAULT_RUN_POLICY,
      backendOrder: ["fixture/missing", "fixture/paid", "fixture/local"],
      allowedPaidBackends: [],
    };

    expect(executionRouteCatalog(registry, policy)).toEqual({
      protocol: "clockgrove.factory/execution-route-capabilities",
      routes: [
        {
          id: "fixture/missing",
          runtimeKind: null,
          hostExecution: null,
          isolation: null,
          unavailableReasons: ["not-registered"],
        },
        {
          id: "fixture/paid",
          runtimeKind: "fixture-runtime",
          hostExecution: false,
          isolation: "container",
          unavailableReasons: ["paid-backend-not-authorized"],
        },
        {
          id: "fixture/local",
          runtimeKind: "fixture-runtime",
          hostExecution: true,
          isolation: "process",
          unavailableReasons: [],
        },
      ],
    });
  });

  it.each([
    ["trusted_local", "none", [true, true, true]],
    ["isolated", "container", [false, true, true]],
    ["managed", "managed", [false, false, true]],
  ] as const)(
    "matches %s trust against process, container, and managed routes",
    (trust, minimumIsolation, compatible) => {
      const assessment = assessExecutionTrustRoutes(trustCatalog(), trust);

      expect(assessment.result).toBe("passed");
      expect(assessment.required).toEqual({ trust, minimumIsolation });
      expect(assessment.routes.map((route) => route.compatible)).toEqual(compatible);
      expect(assessment.routes[0]!.reasons).toEqual(
        trust === "isolated"
          ? ["requires container-or-stronger isolation"]
          : trust === "managed"
            ? ["requires a managed runtime"]
            : [],
      );
      expect(assessment.routes[1]!.reasons).toEqual(
        trust === "managed" ? ["requires a managed runtime"] : [],
      );
    },
  );

  it("uses the scheduler's policy matcher for static route availability", async () => {
    const registry = new BackendRegistry();
    registry.register(new DaytonaBackend({ repository: "/tmp/factory-daytona-route-fixture" }));
    const policy: RunPolicy = {
      ...DEFAULT_RUN_POLICY,
      backendOrder: ["codex-cli/daytona"],
      allowedPaidBackends: ["codex-cli/daytona"],
      allowedNetworkDestinations: [],
    };

    expect(executionRouteCatalog(registry, policy).routes).toEqual([
      expect.objectContaining({
        id: "codex-cli/daytona",
        unavailableReasons: ["backend-policy-incompatible"],
      }),
    ]);
    const [candidate] = await registry.evaluate({
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
    });
    expect(candidate).toMatchObject({
      id: "codex-cli/daytona",
      probe: null,
      permanentReasons: [expect.stringContaining("Run Policy egress authority")],
    });
  });

  it("describes a runtime-managed route without provider calls", () => {
    const registry = new BackendRegistry();
    const managed = githubManagedAgentBackendCapabilities(GITHUB_COPILOT_MANAGED_PROFILE);
    registry.describe(managed);
    registry.register(
      new RouteFixtureBackend(
        capabilities("codex-cli/daytona", {
          hostExecution: false,
          isolation: "container",
          requiresPaidRuntime: true,
        }),
      ),
    );
    const policy: RunPolicy = {
      ...DEFAULT_RUN_POLICY,
      backendOrder: [managed.id, "codex-cli/daytona"],
      allowedPaidBackends: [managed.id, "codex-cli/daytona"],
    };

    expect(registry.get(managed.id)).toBeNull();
    expect(
      assessExecutionTrustRoutes(executionRouteCatalog(registry, policy), "managed").routes.map(
        ({ id, compatible }) => ({ id, compatible }),
      ),
    ).toEqual([
      { id: managed.id, compatible: true },
      { id: "codex-cli/daytona", compatible: false },
    ]);
  });
});
