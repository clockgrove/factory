import { describe, expect, it } from "vitest";
import {
  assertCompletion,
  assessCompletion,
  assertRetryableObjective,
  boundedPolicy,
  installedIdentity,
  objectiveBody,
} from "../scripts/verify-live-objective.mjs";
import { parseRunPolicy } from "../src/protocol/policy.js";

function evidence() {
  const children = [2, 3, 4].map((number) => ({ number, state: "closed" }));
  return {
    runResult: { status: "completed", runId: "fixture", objective: 1 },
    status: {
      run: { state: "completed", runId: "fixture" },
      objective: { number: 1, closed: true },
      summary: {
        runId: "fixture",
        outcome: "completed",
        attempts: { active: 0 },
      },
      capacity: { observed: { active: 0 }, activeReservations: [] },
      workItems: children.map(({ number }) => ({
        number,
        state: "done",
        openDependencies: [],
      })),
    },
    objective: { number: 1, state: "closed" },
    children,
    dependencies: [
      { workItem: 2, blockedBy: [] },
      { workItem: 3, blockedBy: [] },
      { workItem: 4, blockedBy: [{ number: 2 }, { number: 3 }] },
    ],
    events: [
      { runId: "fixture", event: "GraphProjected", graphSize: 3 },
      ...children.flatMap(({ number }) => [
        {
          runId: "fixture",
          event: "BudgetReserved",
          workItem: number,
          attempt: 1,
          phase: "execution",
          unit: "local_milliseconds",
          amount: 1000,
        },
        {
          runId: "fixture",
          event: "CapacityReserved",
          workItem: number,
          attempt: 1,
          phase: "execution",
          backend: "codex-sdk/local-worktree",
        },
        {
          runId: "fixture",
          event: "AttemptStarted",
          workItem: number,
          attempt: 1,
          backend: "codex-sdk/local-worktree",
        },
        {
          runId: "fixture",
          event: "AttemptValidated",
          workItem: number,
          attempt: 1,
          artifactDigest: `artifact-${number}`,
        },
        {
          runId: "fixture",
          event: "AttemptPublished",
          workItem: number,
          attempt: 1,
          artifactDigest: `artifact-${number}`,
          headSha: `head-${number}`,
        },
        {
          runId: "fixture",
          event: "PublicationRecorded",
          workItem: number,
          attempt: 1,
          headSha: `head-${number}`,
          pullRequest: number + 10,
        },
        {
          runId: "fixture",
          event: "AttemptIntegrated",
          workItem: number,
          attempt: 1,
          headSha: `merge-${number}`,
        },
        {
          runId: "fixture",
          event: "BudgetReconciled",
          workItem: number,
          attempt: 1,
          phase: "execution",
          unit: "local_milliseconds",
          amount: 500,
        },
        {
          runId: "fixture",
          event: "CapacityReconciled",
          workItem: number,
          attempt: 1,
          phase: "execution",
          backend: "codex-sdk/local-worktree",
        },
      ]),
      { runId: "fixture", event: "FactoryRunCompleted" },
    ].map((event, sequence) => ({ ...event, sequence, objective: 1 })),
    pulls: children.map(({ number }) => ({
      number: number + 10,
      state: "closed",
      merged: true,
      head: { sha: `head-${number}` },
      merge_commit_sha: `merge-${number}`,
    })),
  };
}

describe("installed live Objective harness evidence boundary", () => {
  it("permits only an acknowledged same-actor failure before graph creation", () => {
    const value = {
      issue: {
        number: 1,
        state: "open",
        body: objectiveBody,
        user: { id: 42 },
      },
      actorId: 42,
      status: {
        objective: { number: 1 },
        run: { runId: "old", state: "escalated" },
        workItems: [],
        summary: { attempts: { total: 0 } },
      },
      children: [],
      events: [{ runId: "old", event: "FactoryRunEscalated" }],
      runId: "old",
    };
    expect(() => assertRetryableObjective(value)).not.toThrow();
    for (const change of [
      { actorId: 43 },
      { runId: "different" },
      { children: [{}] },
      { issue: { ...value.issue, body: "different" } },
      { issue: { ...value.issue, state: "closed" } },
      { status: { ...value.status, run: { runId: "old", state: "running" } } },
      { status: { ...value.status, summary: { attempts: { total: 1 } } } },
      { events: [...value.events, { runId: "old", event: "GraphCompiled" }] },
    ])
      expect(() => assertRetryableObjective({ ...value, ...change })).toThrow();
  });
  it("binds the documented Codex cachebuster to the canonical package and exact installed marketplace", () => {
    const input = {
      manifest: { name: "factory", version: "2.0.26+codex.20260904205148" },
      portable: { name: "factory", version: "2.0.26" },
      packageManifest: { name: "@clockgrove/factory", version: "2.0.26" },
      listed: {
        installed: [
          {
            name: "factory",
            installed: true,
            enabled: true,
            version: "2.0.26",
            pluginId: "factory@personal",
            marketplaceName: "personal",
          },
        ],
      },
      pluginRoot: "/home/example/.codex/plugins/cache/personal/factory/2.0.26",
      codexHome: "/home/example/.codex",
    };
    expect(installedIdentity(input).version).toBe("2.0.26");
    expect(() =>
      installedIdentity({
        ...input,
        pluginRoot: input.pluginRoot.replace("personal", "other"),
      }),
    ).toThrow(/exact cache path/);
    expect(() =>
      installedIdentity({
        ...input,
        manifest: { name: "factory", version: "2.0.26+unrelated" },
      }),
    ).toThrow(/cachebuster/);
    expect(() =>
      installedIdentity({
        ...input,
        portable: { name: "factory", version: "2.0.27" },
      }),
    ).toThrow(/versions differ/);
  });
  it("uses a valid bounded local-only policy", () => {
    for (const mode of ["regular-prs", "stacked-prs"]) {
      const policy = parseRunPolicy(boundedPolicy(mode));
      expect(policy.allowedPaidBackends).toEqual([]);
      expect(policy.economics?.maxModelTokens).toBe(150_000);
      expect(policy.maxParallel).toBe(2);
    }
  });
  it("accepts a complete multi-wave transcript with distinct PR and merge heads", () => {
    expect(() => assertCompletion(evidence())).not.toThrow();
  });
  it.each(["AttemptValidated", "AttemptIntegrated", "GraphProjected"])(
    "rejects missing %s evidence",
    (event) => {
      const value = evidence();
      value.events = value.events.filter((candidate) => candidate.event !== event);
      expect(() => assertCompletion(value)).toThrow();
    },
  );
  it("rejects validation of a different artifact", () => {
    const value = evidence();
    Object.assign(value.events.find((event) => event.event === "AttemptValidated")!, {
      artifactDigest: "other",
    });
    expect(() => assertCompletion(value)).toThrow(/validation/);
  });
  it("rejects a different GitHub merge commit", () => {
    const value = evidence();
    value.pulls[0]!.merge_commit_sha = "other";
    expect(() => assertCompletion(value)).toThrow(/merge commit/);
  });
  it("rejects closed issues without the two-parent dependency wave", () => {
    const value = evidence();
    value.dependencies = [];
    expect(() => assertCompletion(value)).toThrow(/dependency observation/);
  });
  it("rejects a cloud attempt even with successful closure", () => {
    const value = evidence();
    Object.assign(value.events.find((event) => event.event === "AttemptStarted")!, {
      backend: "codex-cli/daytona",
    });
    expect(() => assertCompletion(value)).toThrow(/nonlocal/);
  });
  it("distinguishes passed, partial, and terminal failed observations without mutating input", () => {
    const value = evidence();
    const original = structuredClone(value);
    expect(assessCompletion(value).result).toBe("passed");
    expect(value).toEqual(original);
    value.status.run.state = "active";
    expect(assessCompletion(value).result).toBe("incomplete");
    value.status.run.state = "escalated";
    expect(assessCompletion(value).result).toBe("failed");
    expect(assessCompletion({}).result).toBe("incomplete");
  });
  it("rejects a different or unspecified executed run even if its latest run completed", () => {
    const value = evidence();
    value.runResult.runId = "previous";
    expect(() => assertCompletion(value)).toThrow(/another run/);
    value.runResult.runId = "";
    expect(() => assertCompletion(value)).toThrow(/explicit executed run/);
  });
  it("rejects active attempts and capacity even with closed issues", () => {
    const value = evidence();
    value.status.summary.attempts.active = 1;
    expect(() => assertCompletion(value)).toThrow(/active attempts/);
    value.status.summary.attempts.active = 0;
    value.status.capacity.observed.active = 1;
    expect(() => assertCompletion(value)).toThrow(/active capacity/);
  });
  it.each(["BudgetReconciled", "CapacityReconciled"])("rejects missing %s", (name) => {
    const value = evidence();
    value.events = value.events.filter((event) => event.event !== name);
    expect(() => assertCompletion(value)).toThrow(/unreconciled/);
  });
  it.each(["runId", "phase", "attempt", "workItem", "unit", "usageId"])(
    "does not let a mismatched %s receipt settle a budget reservation",
    (field) => {
      const value = evidence();
      Object.assign(value.events.find((event) => event.event === "BudgetReconciled")!, {
        [field]: "different",
      });
      expect(() => assertCompletion(value)).toThrow(/unreconciled/);
    },
  );
  it("rejects a dangling attempt despite a settled status summary", () => {
    const value = evidence();
    value.events.push({
      runId: "fixture",
      objective: 1,
      sequence: 100,
      event: "AttemptStarted",
      workItem: 2,
      attempt: 2,
      backend: "codex-sdk/local-worktree",
    });
    expect(() => assertCompletion(value)).toThrow(/terminal reconciliation/);
  });
  it("requires join execution after both parents integrate, not merely join edges", () => {
    const value = evidence();
    value.events.find(
      (event) => event.event === "AttemptStarted" && "workItem" in event && event.workItem === 4,
    )!.sequence = 1;
    expect(() => assertCompletion(value)).toThrow(/join started before/);
  });
  it("permits native-stack linear execution before merge while still checking multi-parent joins", () => {
    const value = evidence();
    value.dependencies[1]!.blockedBy = [{ number: 2 }];
    value.events.find(
      (event) => event.event === "AttemptStarted" && "workItem" in event && event.workItem === 3,
    )!.sequence = 2;
    expect(() => assertCompletion(value)).not.toThrow();
  });
  it("bounds evidence input and diagnostic output", () => {
    const value = evidence();
    value.dependencies[2]!.blockedBy = Array.from({ length: 101 }, () => ({ number: 2 }));
    expect(() => assertCompletion(value)).toThrow(/unbounded/);
    const excessive = evidence();
    excessive.events = Array.from({ length: 50_001 }, () => excessive.events[0]!);
    expect(() => assertCompletion(excessive)).toThrow(/unbounded/);
    expect(assessCompletion(excessive).reason!.length).toBeLessThanOrEqual(2000);
  });
  it("rejects repeated parent edges that imitate a multi-parent join", () => {
    const value = evidence();
    value.dependencies[2]!.blockedBy = [{ number: 2 }, { number: 2 }];
    expect(() => assertCompletion(value)).toThrow(/duplicate dependency/);
  });
  it("rejects a substituted published head despite the same merge commit", () => {
    const value = evidence();
    value.pulls[0]!.head.sha = "changed-head";
    expect(() => assertCompletion(value)).toThrow(/merge commit/);
  });
  it("rejects truncated graph and missing cleanup observations", () => {
    const value = evidence();
    value.children.pop();
    expect(assessCompletion(value).result).toBe("incomplete");
    const missing = evidence();
    Reflect.deleteProperty(missing.status, "capacity");
    expect(() => assertCompletion(missing)).toThrow(/active capacity/);
  });
  it("ignores failed predecessor events but rejects conflicting current-run terminal evidence", () => {
    const value = evidence();
    value.events.push({
      runId: "old",
      event: "FactoryRunEscalated",
      objective: 1,
      sequence: 100,
    });
    expect(() => assertCompletion(value)).not.toThrow();
    value.events.push({
      runId: "fixture",
      event: "FactoryRunEscalated",
      objective: 1,
      sequence: 101,
    });
    expect(() => assertCompletion(value)).toThrow(/conflicting terminal/);
  });
});
