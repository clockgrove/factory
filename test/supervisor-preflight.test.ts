import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { PlatformUnavailableError } from "../src/platform.js";
import type { CompiledGraphProjectionBinding } from "../src/control/graphs.js";
import { parseFactoryEvent } from "../src/protocol/events.js";
import { DEFAULT_RUN_POLICY } from "../src/protocol/policy.js";
import {
  compiledGraphDigest,
  renderWorkPacket,
  type CompiledObjective,
  type ExistingGraphWorkItem,
} from "../src/graph.js";
import {
  assertAuthenticatedGraphProjection,
  assertGraphQlAdmissionHeadroom,
  assertSnapshotMatchesCompiledGraph,
  type CompiledGraphSnapshot,
  graphQlAdmissionReserve,
  pendingGraphQlGraphMutations,
  runWithExternalAdmissionBoundary,
  verifyLocalRepository,
} from "../src/supervisor.js";

function immutableGraph(): CompiledObjective {
  const requirements = {
    os: ["linux"],
    architecture: ["x64"],
    tools: ["npm"],
    services: [],
    networkDestinations: [],
    permittedSecretNames: [],
    trust: "trusted_local" as const,
  };
  return {
    title: "Immutable Objective",
    workItems: [
      {
        id: "a",
        title: "Implement A",
        goal: "Implement A",
        acceptance: ["Tests pass"],
        scope: ["src/a.ts"],
        preconditions: [],
        outOfScope: [],
        conventions: [],
        dependsOn: [],
        baseSha: "a".repeat(40),
        validationCommands: ["npm test"],
        requirements,
        artifactContract: "clockgrove.factory/artifact-v1",
      },
      {
        id: "b",
        title: "Implement B",
        goal: "Implement B",
        acceptance: ["Tests pass"],
        scope: ["src/b.ts"],
        preconditions: [],
        outOfScope: [],
        conventions: [],
        dependsOn: ["a"],
        baseSha: "a".repeat(40),
        validationCommands: ["npm test"],
        requirements,
        artifactContract: "clockgrove.factory/artifact-v1",
      },
    ],
  };
}

function immutableSnapshot(graph = immutableGraph()): CompiledGraphSnapshot {
  const digest = compiledGraphDigest(graph);
  return {
    workItems: graph.workItems.map((item, index) => {
      const metadata = {
        protocol: "clockgrove.factory/graph-v1" as const,
        id: item.id,
        graphDigest: digest,
        graphSize: graph.workItems.length,
        index,
        dependsOn: item.dependsOn,
      };
      return {
        id: `issue-node-${21 + index}`,
        number: 21 + index,
        title: item.title,
        body: renderWorkPacket(item, metadata),
        blockedBy: item.dependsOn.map((id) => ({
          number: 21 + graph.workItems.findIndex((candidate) => candidate.id === id),
        })),
      };
    }),
  };
}

function immutableProjection(snapshot = immutableSnapshot()): CompiledGraphProjectionBinding[] {
  return snapshot.workItems.map((item, index) => ({
    compilerId: immutableGraph().workItems[index]!.id,
    issueNodeId: item.id,
    issueNumber: item.number,
  }));
}

describe("Supervisor repository preflight", () => {
  it("accepts exact GitHub remotes and rejects lookalike hosts", async () => {
    const repository = await mkdtemp(join(tmpdir(), "factory-supervisor-preflight-"));
    execFileSync("git", ["init", "-q"], { cwd: repository });
    execFileSync(
      "git",
      ["remote", "add", "origin", "https://evilgithub.com/clockgrove/factory.git"],
      { cwd: repository },
    );
    await expect(verifyLocalRepository(repository, "clockgrove", "factory")).rejects.toThrow(
      /does not match/,
    );
    execFileSync("git", ["remote", "set-url", "origin", "git@github.com:clockgrove/factory.git"], {
      cwd: repository,
    });
    await expect(
      verifyLocalRepository(repository, "clockgrove", "factory"),
    ).resolves.toBeUndefined();
    await rm(repository, { recursive: true, force: true });
  });
});

describe("Supervisor GraphQL admission", () => {
  it("reserves a floor for normal waves and scales for long worker timeouts", () => {
    expect(graphQlAdmissionReserve(7, 30, 2)).toBe(100);
    expect(graphQlAdmissionReserve(7, 240, 1)).toBe(100);
    expect(graphQlAdmissionReserve(7, 30, 2, 300)).toBe(359);
    expect(() => graphQlAdmissionReserve(0, 30, 1)).toThrow(/positive integer/);
  });

  it("reserves only graph writes that the immutable graph still needs", () => {
    const graph = {
      title: "test",
      workItems: [
        { id: "a", dependsOn: [] },
        { id: "b", dependsOn: ["a"] },
      ],
    } as unknown as CompiledObjective;
    const issue = (compilerId: string, number: number, blockedByNumbers: number[]) =>
      ({
        compilerId,
        number,
        blockedByNumbers,
      }) as ExistingGraphWorkItem;

    expect(pendingGraphQlGraphMutations(graph, [])).toBe(3);
    expect(pendingGraphQlGraphMutations(graph, [issue("a", 22, [])])).toBe(2);
    expect(pendingGraphQlGraphMutations(graph, [issue("a", 22, []), issue("b", 23, [])])).toBe(1);
    expect(pendingGraphQlGraphMutations(graph, [issue("a", 22, []), issue("b", 23, [22])])).toBe(0);
  });

  it("pauses before admission when the control-plane reserve is unavailable", () => {
    const notices: string[] = [];
    const rateLimit = {
      cost: 7,
      limit: 5_000,
      remaining: 99,
      resetAt: new Date(Date.now() + 60_000),
    };
    expect(() =>
      assertGraphQlAdmissionHeadroom(rateLimit, DEFAULT_RUN_POLICY, 2, (message) =>
        notices.push(message),
      ),
    ).toThrow(PlatformUnavailableError);
    expect(notices).toEqual([expect.stringContaining("99 points remain")]);
  });

  it("admits a wave at the computed reserve and tolerates older snapshots", () => {
    expect(() =>
      assertGraphQlAdmissionHeadroom(
        {
          cost: 7,
          limit: 5_000,
          remaining: 100,
          resetAt: new Date(Date.now() + 60_000),
        },
        DEFAULT_RUN_POLICY,
        2,
      ),
    ).not.toThrow();
    expect(() => assertGraphQlAdmissionHeadroom(undefined, DEFAULT_RUN_POLICY, 2)).not.toThrow();
  });
});

describe("Supervisor external admission generation fence", () => {
  it.each(["compile", "review", "worker launch", "isolated validation"])(
    "does not invoke %s after a successor owns the repository",
    async () => {
      const objectiveFence = vi.fn(async () => {});
      const providerCall = vi.fn(async () => "spent");
      await expect(
        runWithExternalAdmissionBoundary(
          async () => {
            throw new Error("successor repository controller is active");
          },
          objectiveFence,
          providerCall,
        ),
      ).rejects.toThrow(/successor repository controller/);
      expect(objectiveFence).not.toHaveBeenCalled();
      expect(providerCall).not.toHaveBeenCalled();
    },
  );

  it("does not invoke a provider after the Objective lease generation changes", async () => {
    const repositoryFence = vi.fn(async () => {});
    const providerCall = vi.fn(async () => "spent");
    await expect(
      runWithExternalAdmissionBoundary(
        repositoryFence,
        async () => {
          throw new Error("stale Objective lease generation");
        },
        providerCall,
      ),
    ).rejects.toThrow(/stale Objective lease generation/);
    expect(repositoryFence).toHaveBeenCalledOnce();
    expect(providerCall).not.toHaveBeenCalled();
  });
});

describe("Supervisor immutable compiled-graph snapshot fence", () => {
  it("returns execution packets only after the exact GitHub projection matches", () => {
    const packets = assertSnapshotMatchesCompiledGraph(immutableGraph(), immutableSnapshot());
    expect([...packets.keys()]).toEqual([21, 22]);
    expect(packets.get(22)?.goal).toBe("Implement B");
  });

  it("rejects a post-apply body mutation before a backend can launch", () => {
    const graph = immutableGraph();
    const snapshot = immutableSnapshot(graph);
    snapshot.workItems[0]!.body = snapshot.workItems[0]!.body!.replace(
      "Implement A",
      "Widen authority",
    );
    const launch = vi.fn();
    const reconcile = () => {
      assertSnapshotMatchesCompiledGraph(graph, snapshot);
      launch();
    };
    expect(reconcile).toThrow(/body was modified/);
    expect(launch).not.toHaveBeenCalled();
  });

  it("rejects a removed sub-issue before completion can be derived", () => {
    const graph = immutableGraph();
    const snapshot = immutableSnapshot(graph);
    snapshot.workItems.pop();
    expect(() => assertSnapshotMatchesCompiledGraph(graph, snapshot)).toThrow(
      /Work Item count 1 differs from immutable graph count 2/,
    );
  });

  it("re-fences the final completion snapshot before closing the Objective", () => {
    const graph = immutableGraph();
    assertSnapshotMatchesCompiledGraph(graph, immutableSnapshot(graph));
    const finalSnapshot = immutableSnapshot(graph);
    finalSnapshot.workItems.pop();
    const closeObjective = vi.fn();
    const complete = () => {
      assertSnapshotMatchesCompiledGraph(graph, finalSnapshot);
      closeObjective();
    };
    expect(complete).toThrow(/Work Item count 1 differs from immutable graph count 2/);
    expect(closeObjective).not.toHaveBeenCalled();
  });

  it("rejects a semantically exact graph moved between GitHub issues after restart", () => {
    const graph = immutableGraph();
    const original = immutableSnapshot(graph);
    const projection = immutableProjection(original);
    const [a, b] = original.workItems;
    const swapped: CompiledGraphSnapshot = {
      workItems: [
        { ...b!, id: a!.id, number: a!.number, blockedBy: [{ number: b!.number }] },
        { ...a!, id: b!.id, number: b!.number, blockedBy: [] },
      ],
    };
    expect(() => assertSnapshotMatchesCompiledGraph(graph, swapped)).not.toThrow();
    expect(() => assertSnapshotMatchesCompiledGraph(graph, swapped, projection)).toThrow(
      /moved from its immutable GitHub issue binding/,
    );
  });

  it("rejects an attacker-precreated projection ref even when edited sub-issues match it", () => {
    const graph = immutableGraph();
    const original = immutableSnapshot(graph);
    const [a, b] = original.workItems;
    const swapped: CompiledGraphSnapshot = {
      workItems: [
        { ...b!, id: a!.id, number: a!.number, blockedBy: [{ number: b!.number }] },
        { ...a!, id: b!.id, number: b!.number, blockedBy: [] },
      ],
    };
    const attackerProjection = [
      { compilerId: "a", issueNodeId: b!.id, issueNumber: b!.number },
      { compilerId: "b", issueNodeId: a!.id, issueNumber: a!.number },
    ];
    expect(() =>
      assertSnapshotMatchesCompiledGraph(graph, swapped, attackerProjection),
    ).not.toThrow();
    const launch = vi.fn();
    const resume = () => {
      assertAuthenticatedGraphProjection([], 7, "run-7", {
        ref: "refs/clockgrove-factory/graph-projections/objective-7/run-attacker",
        blobOid: "b".repeat(40),
        graphDigest: compiledGraphDigest(graph),
        graphSize: graph.workItems.length,
      });
      launch();
    };
    expect(resume).toThrow(/no authenticated Objective receipt/);
    expect(launch).not.toHaveBeenCalled();
  });

  it("requires exactly one matching authenticated projection receipt", () => {
    const graphDigest = compiledGraphDigest(immutableGraph());
    const expected = {
      ref: "refs/clockgrove-factory/graph-projections/objective-7/run-controller",
      blobOid: "b".repeat(40),
      graphDigest,
      graphSize: 2,
    };
    const receipt = parseFactoryEvent({
      protocol: "clockgrove.factory/v2",
      kind: "graph",
      event: "GraphProjected",
      objective: 7,
      runId: "run-7",
      sequence: 9,
      at: "2026-09-04T00:00:00.000Z",
      graphDigest,
      graphSize: 2,
      projectionRef: expected.ref,
      projectionBlobSha: expected.blobOid,
    });
    expect(() => assertAuthenticatedGraphProjection([receipt], 7, "run-7", expected)).not.toThrow();
    expect(() =>
      assertAuthenticatedGraphProjection(
        [receipt, parseFactoryEvent({ ...receipt, sequence: 10 })],
        7,
        "run-7",
        expected,
      ),
    ).toThrow(/multiple authenticated Objective receipts/);
    expect(() =>
      assertAuthenticatedGraphProjection(
        [parseFactoryEvent({ ...receipt, projectionBlobSha: "c".repeat(40) })],
        7,
        "run-7",
        expected,
      ),
    ).toThrow(/differs from its immutable ref/);
  });

  it.each([
    {
      label: "removed",
      mutate: (snapshot: CompiledGraphSnapshot) => {
        snapshot.workItems[1]!.blockedBy = [];
      },
    },
    {
      label: "extra",
      mutate: (snapshot: CompiledGraphSnapshot) => {
        snapshot.workItems[0]!.blockedBy = [{ number: 999 }];
      },
    },
  ])("rejects $label blocker edges before scheduling", ({ mutate }) => {
    const graph = immutableGraph();
    const snapshot = immutableSnapshot(graph);
    mutate(snapshot);
    const launch = vi.fn();
    const reconcile = () => {
      assertSnapshotMatchesCompiledGraph(graph, snapshot);
      launch();
    };
    expect(reconcile).toThrow(/blocker edges were modified/);
    expect(launch).not.toHaveBeenCalled();
  });
});
