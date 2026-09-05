import { describe, expect, it } from "vitest";

import { FactoryApplicationService, type ApplicationSnapshot } from "../src/application/index.js";
import { decodeEventComments } from "../src/control/receipts.js";
import { parseFactoryEvent } from "../src/protocol/events.js";
import { DEFAULT_RUN_POLICY, policyDigest } from "../src/protocol/policy.js";
import { compileObjective } from "../src/compiler/index.js";
import { compiledGraphDigest, renderWorkPacket, type CompiledObjective } from "../src/graph.js";
import type {
  CompilationContext,
  CompilationResult,
  ManagementBackend,
  ReviewContext,
  ReviewResult,
} from "../src/management/backend.js";

const snapshot = (): ApplicationSnapshot => ({
  id: "objective-node",
  number: 7,
  title: "Objective",
  defaultBranch: "main",
  workItems: [],
  factoryEvents: [],
});

function proposedGraph(): CompiledObjective {
  return compileObjective({
    title: "Objective",
    baseSha: "a".repeat(40),
    repositoryFacts: {
      files: [{ path: "package.json" }, { path: "src/feature.ts" }],
      scripts: { test: "vitest run" },
    },
    workItems: [
      {
        id: "feature",
        title: "Implement feature",
        goal: "Deliver observable behavior",
        acceptance: ["The feature has a regression test"],
        scope: ["src/feature.ts"],
        preconditions: [],
        outOfScope: ["Publishing"],
        conventions: ["Use TypeScript"],
        dependsOn: [],
        baseSha: "a".repeat(40),
        validationCommands: ["npm test"],
        requirements: {
          os: ["linux"],
          architecture: ["x64"],
          tools: ["node", "npm"],
          services: [],
          networkDestinations: [],
          permittedSecretNames: [],
          trust: "trusted_local",
        },
        artifactContract: "clockgrove.factory/artifact-v1",
      },
    ],
  });
}

class PlanningBackend implements ManagementBackend {
  readonly id = "test-management";
  compileCalls = 0;
  lastContext: CompilationContext | null = null;
  constructor(private readonly graph: CompiledObjective) {}
  async probe() {
    return { available: true, authenticated: true };
  }
  async compile(
    context: CompilationContext,
    checkpoint: (result: CompilationResult) => Promise<void>,
  ): Promise<CompilationResult> {
    this.compileCalls += 1;
    this.lastContext = context;
    const result = { objective: this.graph, usage: { inputTokens: 120, outputTokens: 30 } };
    await checkpoint(result);
    return result;
  }
  async review(_context: ReviewContext): Promise<ReviewResult> {
    throw new Error("review is outside this test");
  }
}

describe("FactoryApplicationService", () => {
  it("persists one activation and returns its original receipt for concurrent duplicates", async () => {
    const current = snapshot();
    const comments: string[] = [];
    const service = new FactoryApplicationService({
      owner: "o",
      repo: "r",
      reader: { readObjective: async () => structuredClone(current) },
      store: {
        getAuthenticatedLogin: async () => "actor",
        serverTime: async () => new Date("2026-01-01T00:00:00.000Z"),
        addIssueComment: async (_id, body) => {
          comments.push(body);
          current.factoryEvents = [...(current.factoryEvents ?? []), ...decodeEventComments(body)];
        },
      },
    });
    const input = {
      objective: 7,
      requestId: "offline-activation",
      baseSha: "a".repeat(40),
    };
    const [first, duplicate] = await Promise.all([
      service.activate(input),
      service.activate(input),
    ]);
    expect(comments).toHaveLength(1);
    expect(duplicate).toEqual(first);
  });

  it.each(["doctor", "plan", "status", "explain", "replay"] as const)(
    "%s cannot mutate GitHub",
    async (operation) => {
      let writes = 0;
      const service = new FactoryApplicationService({
        owner: "o",
        repo: "r",
        reader: { readObjective: async () => snapshot() },
        store: {
          getAuthenticatedLogin: async () => "actor",
          serverTime: async () => new Date(),
          addIssueComment: async () => {
            writes += 1;
          },
        },
      });
      await service.inspect(operation, 7);
      expect(writes).toBe(0);
    },
  );

  it("returns useful secret-safe doctor diagnostics without control-plane writes", async () => {
    let writes = 0;
    const service = new FactoryApplicationService({
      owner: "o",
      repo: "r",
      reader: { readObjective: async () => snapshot() },
      store: {
        getAuthenticatedLogin: async () => "actor",
        serverTime: async () => new Date(),
        addIssueComment: async () => {
          writes += 1;
        },
      },
      diagnostics: {
        repositoryFacts: async () => ({
          fullName: "o/r",
          fork: false,
          private: true,
          defaultBranch: "main",
          canPush: true,
        }),
        authenticatedLogin: async () => "actor",
        branchRules: async () => [
          { type: "required_status_checks", parameters: { required_status_checks: [] } },
        ],
        stackCapability: async () => ({ available: false, observed: true }),
        managementProbe: async () => ({
          id: "management",
          probe: { available: true, authenticated: true },
        }),
        backendProbes: async () => [
          {
            id: "codex-cli/local-worktree",
            probe: { available: true, authenticated: true },
          },
        ],
        toolchainProbe: async () => ({ node: "v22", git: "2.50" }),
        resourceProbe: async () => ({ cpuCount: 8, freeMemoryMb: 4096 }),
        controller: {
          status: async () => ({ installed: true, active: true }),
          start: async () => ({}),
          stop: async () => ({}),
          restart: async () => ({}),
          install: async () => ({}),
          uninstall: async () => ({}),
        },
      },
    });

    const report = await service.doctor(7, "/repo");
    expect(report.activationAuthorized).toBe(false);
    expect(report.diagnostics.map((diagnostic) => diagnostic.area)).toEqual(
      expect.arrayContaining([
        "repository",
        "authentication",
        "toolchain",
        "controller",
        "management",
        "backends",
        "branch-rules",
        "stacks",
        "resources",
      ]),
    );
    expect(
      report.diagnostics.find((diagnostic) => diagnostic.area === "branch-rules")?.summary,
    ).toContain("1 supported");
    expect(writes).toBe(0);
  });

  it("reports normal doctor failures without leaking credential-shaped text", async () => {
    const service = new FactoryApplicationService({
      owner: "o",
      repo: "r",
      reader: { readObjective: async () => snapshot() },
      diagnostics: {
        authenticatedLogin: async () => {
          throw new Error(`bad token ghp_${"x".repeat(30)}`);
        },
      },
    });
    const report = await service.doctor(7);
    const auth = report.diagnostics.find((diagnostic) => diagnostic.area === "authentication");
    expect(auth).toMatchObject({ status: "fail" });
    expect(auth?.summary).toContain("[REDACTED]");
    expect(JSON.stringify(report)).not.toContain("ghp_");
  });

  it("inspects an existing graph without invoking management or writing GitHub", async () => {
    const graph = proposedGraph();
    const digest = compiledGraphDigest(graph);
    const current = snapshot();
    current.workItems = graph.workItems.map((item, index) => ({
      number: 8 + index,
      title: item.title,
      body: renderWorkPacket(item, {
        protocol: "clockgrove.factory/graph-v1",
        id: item.id,
        graphDigest: digest,
        graphSize: graph.workItems.length,
        index,
        dependsOn: item.dependsOn,
      }),
    }));
    const backend = new PlanningBackend(graph);
    let writes = 0;
    const service = new FactoryApplicationService({
      owner: "o",
      repo: "r",
      reader: { readObjective: async () => current },
      store: {
        getAuthenticatedLogin: async () => "actor",
        serverTime: async () => new Date(),
        addIssueComment: async () => {
          writes += 1;
        },
      },
      planning: { management: backend },
    });
    const report = await service.plan({ objective: 7 });
    expect(report).toMatchObject({
      mode: "existing-graph-inspection",
      activationAuthorized: false,
      compilation: { requested: false, result: "not-requested", usagePersistence: "none" },
      usage: null,
      graph: { digest, workItemCount: 1 },
    });
    expect(backend.compileCalls).toBe(0);
    expect(writes).toBe(0);
  });

  it("compiles only on explicit request and returns observed management usage without writes", async () => {
    const graph = proposedGraph();
    const backend = new PlanningBackend(graph);
    let writes = 0;
    const service = new FactoryApplicationService({
      owner: "o",
      repo: "r",
      reader: { readObjective: async () => ({ ...snapshot(), body: "Build the feature" }) },
      store: {
        getAuthenticatedLogin: async () => "actor",
        serverTime: async () => new Date(),
        addIssueComment: async () => {
          writes += 1;
        },
      },
      planning: {
        management: backend,
        repositoryPath: "/repo",
        validateCheckout: async (path, baseSha) => {
          expect(path).toBe("/repo");
          expect(baseSha).toBe("a".repeat(40));
        },
        readRepositoryLayout: async () => ({
          files: ["package.json", "src/feature.ts"],
          totalFiles: 2,
          truncated: false,
        }),
        readBaseSha: async () => "a".repeat(40),
      },
    });
    const report = await service.plan({ objective: 7, compile: true });
    expect(report).toMatchObject({
      mode: "compilation",
      activationAuthorized: false,
      compilation: { requested: true, result: "completed", usagePersistence: "response-only" },
      usage: { inputTokens: 120, outputTokens: 30 },
      graph: { workItemCount: 1 },
      proposedGraph: { title: "Objective" },
    });
    expect(backend.compileCalls).toBe(1);
    expect(backend.lastContext?.repository).toBe("/repo");
    expect(writes).toBe(0);
  });

  it("fails plan compilation diagnostically before a model call when repository evidence is incomplete", async () => {
    const backend = new PlanningBackend(proposedGraph());
    const service = new FactoryApplicationService({
      owner: "o",
      repo: "r",
      reader: { readObjective: async () => snapshot() },
      planning: {
        management: backend,
        repositoryPath: "/repo",
        readRepositoryLayout: async () => ({
          files: ["package.json"],
          truncated: true,
          totalFiles: 8_000,
        }),
      },
    });
    const report = await service.plan({ objective: 7, compile: true });
    expect(report).toMatchObject({
      mode: "compilation",
      activationAuthorized: false,
      compilation: { requested: true, result: "failed", usagePersistence: "none" },
      graph: null,
      usage: null,
      diagnostics: [{ status: "fail" }],
    });
    expect(report.diagnostics[0]?.summary).toContain("incomplete");
    expect(backend.compileCalls).toBe(0);
  });

  it("deduplicates controller lifecycle requests and returns the first receipt", async () => {
    let calls = 0;
    const receipt = { accepted: true };
    const service = new FactoryApplicationService({
      owner: "o",
      repo: "r",
      reader: { readObjective: async () => snapshot() },
      controller: {
        start: async () => {
          calls += 1;
          return receipt;
        },
        stop: async () => receipt,
        restart: async () => receipt,
        status: async () => receipt,
        install: async () => receipt,
        uninstall: async () => receipt,
      },
    });
    const input = {
      repository: "o/r",
      checkout: "/checkout",
      requestId: "controller-1",
    };
    expect(await service.controller("start", input)).toBe(receipt);
    expect(await service.controller("start", input)).toBe(receipt);
    expect(calls).toBe(1);
  });

  it.each(["pause", "resume", "drain", "cloud-pause", "retry", "priority"] as const)(
    "returns the original durable receipt for duplicate %s requests",
    async (operation) => {
      const current = snapshot();
      current.workItems = [{ number: 8 }];
      current.factoryEvents = [
        parseFactoryEvent({
          protocol: "clockgrove.factory/v2",
          kind: "run",
          event: "FactoryRunStarted",
          objective: 7,
          runId: "run-1",
          sequence: 1,
          at: "2026-01-01T00:00:00.000Z",
          actor: "actor",
          repository: "o/r",
          objectiveAuthor: "actor",
          fork: false,
          baseBranch: "main",
          policy: DEFAULT_RUN_POLICY,
          policyDigest: policyDigest(DEFAULT_RUN_POLICY),
        }),
      ];
      let writes = 0;
      const service = new FactoryApplicationService({
        owner: "o",
        repo: "r",
        reader: { readObjective: async () => structuredClone(current) },
        store: {
          getAuthenticatedLogin: async () => "actor",
          serverTime: async () => new Date("2026-01-01T00:00:00.000Z"),
          addIssueComment: async (_id, body) => {
            writes += 1;
            current.factoryEvents = [
              ...(current.factoryEvents ?? []),
              ...decodeEventComments(body),
            ];
          },
        },
      });
      const input = {
        objective: 7,
        requestId: `duplicate-${operation}`,
        ...(operation === "retry" || operation === "priority" ? { workItem: 8 } : {}),
        ...(operation === "priority" ? { priorityRank: 3 } : {}),
      };
      const first = await service.command(operation, input);
      const duplicate = await service.command(operation, input);
      expect(duplicate).toEqual(first);
      expect(writes).toBe(1);
    },
  );

  it("rejects commands outside the active run actor and Work Item scope", async () => {
    const current = snapshot();
    current.workItems = [{ number: 8 }];
    current.factoryEvents = [
      parseFactoryEvent({
        protocol: "clockgrove.factory/v2",
        kind: "run",
        event: "FactoryRunStarted",
        objective: 7,
        runId: "run-1",
        sequence: 1,
        at: "2026-01-01T00:00:00.000Z",
        actor: "actor",
        repository: "o/r",
        objectiveAuthor: "actor",
        fork: false,
        baseBranch: "main",
        policy: DEFAULT_RUN_POLICY,
        policyDigest: policyDigest(DEFAULT_RUN_POLICY),
      }),
    ];
    let login = "intruder";
    let writes = 0;
    const service = new FactoryApplicationService({
      owner: "o",
      repo: "r",
      reader: { readObjective: async () => structuredClone(current) },
      store: {
        getAuthenticatedLogin: async () => login,
        serverTime: async () => new Date("2026-01-01T00:01:00.000Z"),
        addIssueComment: async () => {
          writes += 1;
        },
      },
    });
    await expect(service.command("pause", { objective: 7, requestId: "intruder" })).rejects.toThrow(
      /only activating actor/,
    );
    login = "actor";
    await expect(
      service.command("retry", {
        objective: 7,
        requestId: "wrong-item",
        workItem: 99,
      }),
    ).rejects.toThrow(/does not belong/);
    expect(writes).toBe(0);
  });

  it("returns the original durable cancellation receipt", async () => {
    const current = snapshot();
    current.factoryEvents = [
      parseFactoryEvent({
        protocol: "clockgrove.factory/v2",
        kind: "run",
        event: "FactoryRunStarted",
        objective: 7,
        runId: "run-1",
        sequence: 1,
        at: "2026-01-01T00:00:00.000Z",
        actor: "actor",
        repository: "o/r",
        objectiveAuthor: "actor",
        fork: false,
        baseBranch: "main",
        policy: DEFAULT_RUN_POLICY,
        policyDigest: policyDigest(DEFAULT_RUN_POLICY),
      }),
    ];
    let writes = 0;
    const service = new FactoryApplicationService({
      owner: "o",
      repo: "r",
      reader: { readObjective: async () => structuredClone(current) },
      store: {
        getAuthenticatedLogin: async () => "actor",
        serverTime: async () => new Date("2026-01-01T00:01:00.000Z"),
        addIssueComment: async (_id, body) => {
          writes += 1;
          current.factoryEvents!.push(...decodeEventComments(body));
        },
      },
    });
    const input = { objective: 7, requestId: "duplicate-cancel" };
    const first = await service.command("cancel", input);
    current.factoryEvents!.push(
      parseFactoryEvent({
        protocol: "clockgrove.factory/v2",
        kind: "run",
        event: "FactoryRunCancelled",
        objective: 7,
        runId: "run-1",
        sequence: 3,
        at: "2026-01-01T00:02:00.000Z",
        reason: "operator cancellation",
      }),
      parseFactoryEvent({
        protocol: "clockgrove.factory/v2",
        kind: "run",
        event: "FactoryRunStarted",
        objective: 7,
        runId: "run-2",
        sequence: 4,
        at: "2026-01-01T00:03:00.000Z",
        actor: "actor",
        repository: "o/r",
        objectiveAuthor: "actor",
        fork: false,
        baseBranch: "main",
        policy: DEFAULT_RUN_POLICY,
        policyDigest: policyDigest(DEFAULT_RUN_POLICY),
      }),
    );
    expect(await service.command("cancel", input)).toEqual(first);
    expect(writes).toBe(1);
  });

  it("rejects new commands when the latest run is terminal", async () => {
    const current = snapshot();
    current.factoryEvents = [
      parseFactoryEvent({
        protocol: "clockgrove.factory/v2",
        kind: "run",
        event: "FactoryRunStarted",
        objective: 7,
        runId: "run-1",
        sequence: 1,
        at: "2026-01-01T00:00:00.000Z",
        actor: "actor",
        repository: "o/r",
        objectiveAuthor: "actor",
        fork: false,
        baseBranch: "main",
        policy: DEFAULT_RUN_POLICY,
        policyDigest: policyDigest(DEFAULT_RUN_POLICY),
      }),
      parseFactoryEvent({
        protocol: "clockgrove.factory/v2",
        kind: "run",
        event: "FactoryRunCompleted",
        objective: 7,
        runId: "run-1",
        sequence: 2,
        at: "2026-01-01T00:01:00.000Z",
      }),
    ];
    let writes = 0;
    const service = new FactoryApplicationService({
      owner: "o",
      repo: "r",
      reader: { readObjective: async () => structuredClone(current) },
      store: {
        getAuthenticatedLogin: async () => "actor",
        serverTime: async () => new Date(),
        addIssueComment: async () => {
          writes += 1;
        },
      },
    });

    await expect(
      service.command("cancel", { objective: 7, requestId: "late-cancel" }),
    ).rejects.toThrow("no active Factory run");
    await expect(
      service.command("pause", { objective: 7, requestId: "late-pause" }),
    ).rejects.toThrow("no active Factory run");
    expect(writes).toBe(0);
  });
});
