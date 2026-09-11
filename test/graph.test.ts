import { describe, expect, it, vi } from "vitest";

import {
  addScopeSerializationEdges,
  assertCompiledObjectiveAdoptsLegacyConstraints,
  compiledGraphDigest,
  GraphApplier,
  legacyGraphConstraintsDigest,
  parseGraphItemMetadata,
  parseLegacyGraphConstraints,
  parseLegacyGraphConstraintsSnapshot,
  renderLegacyWorkItemCore,
  renderWorkPacket,
  validateGraph,
  type CompiledObjective,
  type CompiledWorkItem,
  type CreatedWorkItem,
  type GraphWriter,
} from "../src/graph.js";
import { CircuitBreaker, PlatformUnavailableError } from "../src/platform.js";
import { advancingMutationScheduler } from "./helpers/mutation-scheduler.js";

const NOW = new Date("2026-01-01T00:00:00Z");

function workItem(over: Partial<CompiledWorkItem> = {}): CompiledWorkItem {
  return {
    id: "slugify",
    title: "Add slugify",
    goal: "Add a pure slugify(input: string): string helper.",
    acceptance: ["slugify('Hello World') === 'hello-world'"],
    scope: ["src/slugify.ts", "test/slugify.test.ts"],
    preconditions: [],
    outOfScope: [],
    conventions: [],
    dependsOn: [],
    ...over,
  };
}

function objective(workItems: CompiledWorkItem[]): CompiledObjective {
  return { title: "Add three pure functions", deferredCapabilityAdapters: [], workItems };
}

function existingItem(
  graph: CompiledObjective,
  index: number,
  number: number,
  blockedByNumbers: number[] = [],
) {
  const item = graph.workItems[index]!;
  const graphDigest = compiledGraphDigest(graph);
  return {
    compilerId: item.id,
    graphDigest,
    graphSize: graph.workItems.length,
    index,
    dependsOn: item.dependsOn,
    id: `I_${number}`,
    number,
    title: item.title,
    body: renderWorkPacket(item, {
      protocol: "clockgrove.factory/graph-v1" as const,
      id: item.id,
      graphDigest,
      graphSize: graph.workItems.length,
      index,
      dependsOn: item.dependsOn,
      deferredCapabilityAdapters: graph.deferredCapabilityAdapters,
    }),
    blockedByNumbers,
  };
}

/** Records every call made to it, and can be configured to reject on a given method. */
class FakeGraphWriter implements GraphWriter {
  calls: string[] = [];
  bodies: string[] = [];
  #nextNumber = 100;
  failing: Partial<Record<keyof GraphWriter, unknown>>;

  constructor(failing: Partial<Record<keyof GraphWriter, unknown>> = {}) {
    this.failing = failing;
  }

  async createWorkItemIssue(args: {
    repositoryId: string;
    parentIssueId: string;
    title: string;
    body: string;
    labelIds?: string[];
  }): Promise<CreatedWorkItem> {
    this.calls.push(`createWorkItemIssue:${args.parentIssueId}:${args.title}`);
    this.bodies.push(args.body);
    if (this.failing.createWorkItemIssue) throw this.failing.createWorkItemIssue;
    const number = this.#nextNumber++;
    return { id: `I_${number}`, number };
  }

  async addBlockedBy(issueId: string, blockingIssueId: string): Promise<void> {
    this.calls.push(`addBlockedBy:${issueId}:${blockingIssueId}`);
    if (this.failing.addBlockedBy) throw this.failing.addBlockedBy;
  }

  async updateWorkItemIssue(args: { issueId: string; body: string }): Promise<void> {
    this.calls.push(`updateWorkItemIssue:${args.issueId}`);
    this.bodies.push(args.body);
    if (this.failing.updateWorkItemIssue) throw this.failing.updateWorkItemIssue;
  }
}

/** Shape `classifyRefusal` (platform.ts) recognizes as a secondary rate limit. */
function rateLimitError(): unknown {
  return {
    status: 403,
    message: "API rate limit exceeded for user ID 1.",
    response: { headers: { "x-ratelimit-remaining": "5000" } },
  };
}

describe("validateGraph", () => {
  it("accepts a graph of independent Work Items", () => {
    expect(() =>
      validateGraph(
        objective([
          workItem({ id: "a", scope: ["src/a.ts"] }),
          workItem({ id: "b", scope: ["src/b.ts"] }),
        ]),
      ),
    ).not.toThrow();
  });

  it("accepts a resolvable dependency edge", () => {
    expect(() =>
      validateGraph(objective([workItem({ id: "a" }), workItem({ id: "b", dependsOn: ["a"] })])),
    ).not.toThrow();
  });

  it("rejects overlapping scopes that could run in the same wave", () => {
    expect(() =>
      validateGraph(
        objective([
          workItem({ id: "a", scope: ["src/"] }),
          workItem({ id: "b", scope: ["src/slugify.ts"] }),
        ]),
      ),
    ).toThrow(/overlapping scopes/i);
  });

  it("accepts overlapping scopes when a transitive dependency serializes them", () => {
    expect(() =>
      validateGraph(
        objective([
          workItem({ id: "a", scope: ["src/"] }),
          workItem({ id: "middle", scope: ["test/middle.ts"], dependsOn: ["a"] }),
          workItem({ id: "b", scope: ["src/slugify.ts"], dependsOn: ["middle"] }),
        ]),
      ),
    ).not.toThrow();
  });

  it("rejects duplicate ids", () => {
    expect(() => validateGraph(objective([workItem({ id: "a" }), workItem({ id: "a" })]))).toThrow(
      /duplicate/i,
    );
  });

  it("rejects an unresolvable dependsOn", () => {
    expect(() => validateGraph(objective([workItem({ id: "a", dependsOn: ["ghost"] })]))).toThrow(
      /unknown id/i,
    );
  });

  it("rejects self-dependency", () => {
    expect(() => validateGraph(objective([workItem({ id: "a", dependsOn: ["a"] })]))).toThrow(
      /itself/i,
    );
  });

  it("rejects a dependency cycle", () => {
    expect(() =>
      validateGraph(
        objective([
          workItem({ id: "a", dependsOn: ["b"] }),
          workItem({ id: "b", dependsOn: ["a"] }),
        ]),
      ),
    ).toThrow(/cycle/i);
  });
});

describe("addScopeSerializationEdges", () => {
  it("orders otherwise-independent overlapping work without mutating compiler output", () => {
    const compiled = objective([
      workItem({ id: "a", scope: ["src/"] }),
      workItem({ id: "b", scope: ["src/slugify.ts"] }),
      workItem({ id: "c", scope: ["docs/readme.md"] }),
    ]);
    const normalized = addScopeSerializationEdges(compiled);

    expect(normalized.workItems[1]?.dependsOn).toEqual(["a"]);
    expect(normalized.workItems[2]?.dependsOn).toEqual([]);
    expect(compiled.workItems[1]?.dependsOn).toEqual([]);
    expect(() => validateGraph(normalized)).not.toThrow();
  });

  it("preserves an existing dependency path in either direction", () => {
    const normalized = addScopeSerializationEdges(
      objective([
        workItem({ id: "a", scope: ["src/"], dependsOn: ["b"] }),
        workItem({ id: "b", scope: ["src/slugify.ts"] }),
      ]),
    );

    expect(normalized.workItems[0]?.dependsOn).toEqual(["b"]);
    expect(normalized.workItems[1]?.dependsOn).toEqual([]);
    expect(() => validateGraph(normalized)).not.toThrow();
  });
});

describe("legacy Work Item constraints", () => {
  const body = (over: { goal?: string; scope?: string[] } = {}) =>
    [
      `## Goal\n\n${over.goal ?? "Preserve the existing outcome."}`,
      "## Acceptance\n\n- Existing acceptance remains exact.",
      `## Scope\n\n${(over.scope ?? ["src/a.ts"]).map((value) => `- ${value}`).join("\n")}`,
      "## Preconditions\n\n- The parent Objective remains open.",
      "## Out of scope\n\n- Do not widen authority.",
      "## Conventions\n\n- Fail closed.",
    ].join("\n\n");

  it("binds ordered legacy core fields and native dependency topology", () => {
    const constraints = parseLegacyGraphConstraints({
      objectiveTitle: "Existing Objective",
      workItems: [
        { id: "I_8", number: 8, title: "First", body: body(), blockedByNumbers: [] },
        {
          id: "I_9",
          number: 9,
          title: "Second",
          body: body({ scope: ["src/b.ts"] }),
          blockedByNumbers: [8],
        },
      ],
    });
    const compiled: CompiledObjective = {
      title: constraints.objectiveTitle,
      workItems: constraints.workItems.map((item) => ({
        id: item.compilerId,
        title: item.title,
        goal: item.goal,
        acceptance: item.acceptance,
        scope: item.scope,
        preconditions: item.preconditions,
        outOfScope: item.outOfScope,
        conventions: item.conventions,
        dependsOn: item.blockedByNumbers.map((number) => `adopted-${number}`),
      })),
    };

    expect(() =>
      assertCompiledObjectiveAdoptsLegacyConstraints(compiled, constraints),
    ).not.toThrow();
    expect(legacyGraphConstraintsDigest(constraints)).toMatch(/^[0-9a-f]{64}$/);
    compiled.workItems[1]!.acceptance = ["Weakened acceptance"];
    expect(() => assertCompiledObjectiveAdoptsLegacyConstraints(compiled, constraints)).toThrow(
      /changed legacy Work Item #9/,
    );
  });

  it("rejects partial Factory metadata, extra sections, and foreign blockers", () => {
    const input = {
      objectiveTitle: "Existing Objective",
      workItems: [{ id: "I_8", number: 8, title: "First", body: body(), blockedByNumbers: [] }],
    };
    expect(() =>
      parseLegacyGraphConstraints({
        ...input,
        workItems: [{ ...input.workItems[0]!, body: `${body()}\n\n## Surprise\n\nNo.` }],
      }),
    ).toThrow(/six ordered legacy sections/);
    expect(() =>
      parseLegacyGraphConstraints({
        ...input,
        workItems: [
          {
            ...input.workItems[0]!,
            body: `${body()}\n\n<!-- clockgrove-factory:graph-item malformed -->`,
          },
        ],
      }),
    ).toThrow(/Factory metadata/);
    expect(() =>
      parseLegacyGraphConstraints({
        ...input,
        workItems: [{ ...input.workItems[0]!, blockedByNumbers: [99] }],
      }),
    ).toThrow(/outside its Work Items/);
  });

  it("reconstructs one constraint digest from mixed raw and upgraded bodies", () => {
    const constraints = parseLegacyGraphConstraints({
      objectiveTitle: "Existing Objective",
      workItems: [
        { id: "I_8", number: 8, title: "First", body: body(), blockedByNumbers: [] },
        {
          id: "I_9",
          number: 9,
          title: "Second",
          body: body({ scope: ["src/b.ts"] }),
          blockedByNumbers: [8],
        },
      ],
    });
    const compiled: CompiledObjective = {
      title: constraints.objectiveTitle,
      workItems: constraints.workItems.map((item) => ({
        id: item.compilerId,
        title: item.title,
        goal: item.goal,
        acceptance: item.acceptance,
        scope: item.scope,
        preconditions: item.preconditions,
        outOfScope: item.outOfScope,
        conventions: item.conventions,
        dependsOn: item.blockedByNumbers.map((number) => `adopted-${number}`),
        baseSha: "a".repeat(40),
        validationCommands: ["npm test"],
        requirements: {
          os: [],
          architecture: [],
          tools: ["node"],
          services: [],
          networkDestinations: [],
          permittedSecretNames: [],
          trust: "trusted_local",
        },
        artifactContract: "clockgrove.factory/artifact-v1",
      })),
    };
    const digest = compiledGraphDigest(compiled);
    const mixed = parseLegacyGraphConstraintsSnapshot({
      objectiveTitle: constraints.objectiveTitle,
      workItems: constraints.workItems.map((item, index) => ({
        id: item.issueNodeId,
        number: item.issueNumber,
        title: item.title,
        body:
          index === 0
            ? renderWorkPacket(compiled.workItems[index]!, {
                protocol: "clockgrove.factory/graph-v1",
                id: item.compilerId,
                graphDigest: digest,
                graphSize: compiled.workItems.length,
                index,
                dependsOn: compiled.workItems[index]!.dependsOn,
              })
            : renderLegacyWorkItemCore(item),
        blockedByNumbers: item.blockedByNumbers,
      })),
    });

    expect(legacyGraphConstraintsDigest(mixed)).toBe(legacyGraphConstraintsDigest(constraints));
  });
});

describe("renderWorkPacket", () => {
  it("renders only non-empty sections, in §8 order", () => {
    const body = renderWorkPacket(
      workItem({
        goal: "Add slugify.",
        acceptance: ["criterion one"],
        scope: ["src/slugify.ts"],
        preconditions: [],
        outOfScope: ["No unicode normalization."],
        conventions: [],
      }),
    );

    expect(body).toContain("## Goal");
    expect(body).toContain("Add slugify.");
    expect(body).toContain("## Acceptance");
    expect(body).toContain("- criterion one");
    expect(body).toContain("## Scope");
    expect(body).not.toContain("## Preconditions");
    expect(body).toContain("## Out of scope");
    expect(body).not.toContain("## Conventions");

    // §8 order: Goal, Acceptance, Scope, Preconditions, Out of scope, Conventions.
    expect(body.indexOf("## Goal")).toBeLessThan(body.indexOf("## Acceptance"));
    expect(body.indexOf("## Acceptance")).toBeLessThan(body.indexOf("## Scope"));
    expect(body.indexOf("## Scope")).toBeLessThan(body.indexOf("## Out of scope"));
  });
});

describe("GraphApplier.apply", () => {
  it("projects an exact authenticated historical graph without rewriting its omission", async () => {
    const historical = objective([workItem({ id: "a" })]);
    delete historical.deferredCapabilityAdapters;
    const writer = new FakeGraphWriter();
    const applier = new GraphApplier({ writer, mutationScheduler: advancingMutationScheduler() });

    await expect(applier.apply(historical, ctx)).rejects.toThrow(
      /lacks deferred capability adapter disposition/,
    );
    await expect(
      applier.apply(historical, { ...ctx, allowAuthenticatedLegacyOmissions: true }),
    ).resolves.toEqual(new Map([["a", { id: "I_100", number: 100 }]]));
    expect(parseGraphItemMetadata(writer.bodies[0]!)).not.toHaveProperty(
      "deferredCapabilityAdapters",
    );
  });

  const ctx = { repositoryId: "R_1", objectiveIssueId: "I_OBJ" };

  it("creates every Work Item as a sub-issue of the Objective", async () => {
    const writer = new FakeGraphWriter();
    const applier = new GraphApplier({ writer, mutationScheduler: advancingMutationScheduler() });

    const created = await applier.apply(
      objective([
        workItem({ id: "a", title: "Add slugify", scope: ["src/slugify.ts"] }),
        workItem({ id: "b", title: "Add truncate", scope: ["src/truncate.ts"] }),
      ]),
      ctx,
    );

    expect(writer.calls).toEqual([
      "createWorkItemIssue:I_OBJ:Add slugify",
      "createWorkItemIssue:I_OBJ:Add truncate",
    ]);
    expect(created.get("a")?.number).toBe(100);
    expect(created.get("b")?.number).toBe(101);
  });

  it("wires dependsOn edges via addBlockedBy after every issue exists", async () => {
    const writer = new FakeGraphWriter();
    const applier = new GraphApplier({ writer, mutationScheduler: advancingMutationScheduler() });

    const created = await applier.apply(
      objective([workItem({ id: "a" }), workItem({ id: "b", dependsOn: ["a"] })]),
      ctx,
    );

    const a = created.get("a")!;
    const b = created.get("b")!;
    expect(writer.calls).toEqual([
      "createWorkItemIssue:I_OBJ:Add slugify",
      "createWorkItemIssue:I_OBJ:Add slugify",
      `addBlockedBy:${b.id}:${a.id}`,
    ]);
  });

  it("repairs a partial graph without duplicating issues or dependency edges", async () => {
    const writer = new FakeGraphWriter();
    const applier = new GraphApplier({ writer, mutationScheduler: advancingMutationScheduler() });
    const graph = objective([workItem({ id: "a" }), workItem({ id: "b", dependsOn: ["a"] })]);
    const digest = compiledGraphDigest(graph);
    const created = await applier.apply(graph, {
      ...ctx,
      existingWorkItems: [existingItem(graph, 0, 90)],
    });
    expect(writer.calls).toEqual([
      "createWorkItemIssue:I_OBJ:Add slugify",
      `addBlockedBy:${created.get("b")!.id}:I_90`,
    ]);
    const metadata = parseGraphItemMetadata(writer.bodies[0]!);
    expect(metadata).toMatchObject({ id: "b", graphDigest: digest, graphSize: 2, index: 1 });

    const noWrites = new FakeGraphWriter();
    await new GraphApplier({
      writer: noWrites,
      mutationScheduler: advancingMutationScheduler(),
    }).apply(graph, {
      ...ctx,
      existingWorkItems: [existingItem(graph, 0, 90), existingItem(graph, 1, 91, [90])],
    });
    expect(noWrites.calls).toEqual([]);
  });

  it("adopts existing Work Items by updating bodies without creating issues or edges", async () => {
    const legacy = parseLegacyGraphConstraints({
      objectiveTitle: "Existing Objective",
      workItems: [
        {
          id: "I_8",
          number: 8,
          title: "First",
          body: [
            "## Goal\n\nFirst goal.",
            "## Acceptance\n\n- First passes.",
            "## Scope\n\n- src/a.ts",
            "## Preconditions\n\n",
            "## Out of scope\n\n- No extras.",
            "## Conventions\n\n- Stay exact.",
          ].join("\n\n"),
          blockedByNumbers: [],
        },
        {
          id: "I_9",
          number: 9,
          title: "Second",
          body: [
            "## Goal\n\nSecond goal.",
            "## Acceptance\n\n- Second passes.",
            "## Scope\n\n- src/b.ts",
            "## Preconditions\n\n- First is complete.",
            "## Out of scope\n\n- No extras.",
            "## Conventions\n\n- Stay exact.",
          ].join("\n\n"),
          blockedByNumbers: [8],
        },
      ],
    });
    const graph: CompiledObjective = {
      title: legacy.objectiveTitle,
      workItems: legacy.workItems.map((item) => ({
        id: item.compilerId,
        title: item.title,
        goal: item.goal,
        acceptance: item.acceptance,
        scope: item.scope,
        preconditions: item.preconditions,
        outOfScope: item.outOfScope,
        conventions: item.conventions,
        dependsOn: item.blockedByNumbers.map((number) => `adopted-${number}`),
      })),
    };
    const writer = new FakeGraphWriter();
    const applied = await new GraphApplier({
      writer,
      mutationScheduler: advancingMutationScheduler(),
    }).apply(graph, { ...ctx, legacyGraphConstraints: legacy });

    expect(writer.calls).toEqual(["updateWorkItemIssue:I_8", "updateWorkItemIssue:I_9"]);
    expect(applied.get("adopted-8")).toEqual({ id: "I_8", number: 8 });
    expect(parseGraphItemMetadata(writer.bodies[1]!)).toMatchObject({
      id: "adopted-9",
      dependsOn: ["adopted-8"],
    });

    const firstMetadata = parseGraphItemMetadata(writer.bodies[0]!);
    const replayWriter = new FakeGraphWriter();
    const replayed = await new GraphApplier({
      writer: replayWriter,
      mutationScheduler: advancingMutationScheduler(),
    }).apply(graph, {
      ...ctx,
      legacyGraphConstraints: legacy,
      existingWorkItems: [
        {
          id: "I_8",
          number: 8,
          title: "First",
          body: writer.bodies[0]!,
          compilerId: firstMetadata.id,
          graphDigest: firstMetadata.graphDigest,
          graphSize: firstMetadata.graphSize,
          index: firstMetadata.index,
          dependsOn: firstMetadata.dependsOn,
          blockedByNumbers: [],
        },
      ],
    });
    expect(replayWriter.calls).toEqual(["updateWorkItemIssue:I_9"]);
    expect(replayed.get("adopted-8")).toEqual({ id: "I_8", number: 8 });
  });

  it("rejects changed native topology before an adoption write", async () => {
    const legacy = parseLegacyGraphConstraints({
      objectiveTitle: "Existing Objective",
      workItems: [
        {
          id: "I_8",
          number: 8,
          title: "First",
          body: "## Goal\n\nFirst.\n\n## Acceptance\n\n- Pass.\n\n## Scope\n\n- src/a.ts\n\n## Preconditions\n\n\n## Out of scope\n\n\n## Conventions\n\n",
          blockedByNumbers: [],
        },
      ],
    });
    const graph = objective([
      workItem({
        id: "adopted-8",
        title: "First",
        goal: "First.",
        acceptance: ["Pass."],
        scope: ["src/a.ts"],
      }),
    ]);
    graph.title = legacy.objectiveTitle;
    const writer = new FakeGraphWriter();
    legacy.workItems[0]!.blockedByNumbers = [9];
    await expect(
      new GraphApplier({ writer, mutationScheduler: advancingMutationScheduler() }).apply(graph, {
        ...ctx,
        legacyGraphConstraints: legacy,
      }),
    ).rejects.toThrow();
    expect(writer.calls).toEqual([]);
  });

  it("rejects a modified partial Work Item before making another write", async () => {
    const graph = objective([
      workItem({ id: "a", scope: ["src/a.ts"] }),
      workItem({ id: "b", scope: ["src/b.ts"] }),
    ]);
    const changed = { ...existingItem(graph, 0, 90), title: "Edited by hand" };
    const writer = new FakeGraphWriter();
    await expect(
      new GraphApplier({ writer, mutationScheduler: advancingMutationScheduler() }).apply(graph, {
        ...ctx,
        existingWorkItems: [changed],
      }),
    ).rejects.toThrow(/differs from the durable graph/i);
    expect(writer.calls).toEqual([]);
  });

  it("applies the optional Work Item label to every created issue", async () => {
    const writer = new FakeGraphWriter();
    const applier = new GraphApplier({ writer, mutationScheduler: advancingMutationScheduler() });
    let seenLabelIds: string[] | undefined;
    const originalCreate = writer.createWorkItemIssue.bind(writer);
    writer.createWorkItemIssue = async (args) => {
      seenLabelIds = args.labelIds;
      return originalCreate(args);
    };

    await applier.apply(objective([workItem({ id: "a" })]), {
      ...ctx,
      workItemLabelId: "LA_work_item",
    });

    expect(seenLabelIds).toEqual(["LA_work_item"]);
  });

  it("rejects an invalid graph before making any write", async () => {
    const writer = new FakeGraphWriter();
    const applier = new GraphApplier({ writer, mutationScheduler: advancingMutationScheduler() });

    await expect(
      applier.apply(objective([workItem({ id: "a", dependsOn: ["ghost"] })]), ctx),
    ).rejects.toThrow(/unknown id/i);
    expect(writer.calls).toEqual([]);
  });

  it("wraps a secondary-rate-limit refusal in PlatformUnavailableError", async () => {
    const writer = new FakeGraphWriter({ createWorkItemIssue: rateLimitError() });
    const applier = new GraphApplier({ writer, mutationScheduler: advancingMutationScheduler() });

    await expect(applier.apply(objective([workItem({ id: "a" })]), ctx)).rejects.toBeInstanceOf(
      PlatformUnavailableError,
    );
  });

  it("reports exhausted() once the circuit trips maxOpens times", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    const writer = new FakeGraphWriter({ createWorkItemIssue: rateLimitError() });
    const breaker = new CircuitBreaker({
      openAfterConsecutiveRefusals: 1,
      baseCooldownMs: 1_000,
      maxCooldownMs: 1_000,
      maxOpens: 1,
    });
    const applier = new GraphApplier({
      writer,
      circuitBreaker: breaker,
      mutationScheduler: advancingMutationScheduler(),
    });

    await expect(applier.apply(objective([workItem({ id: "a" })]), ctx)).rejects.toBeInstanceOf(
      PlatformUnavailableError,
    );

    expect(applier.exhausted()).toBe(true);
    vi.useRealTimers();
  });
});
