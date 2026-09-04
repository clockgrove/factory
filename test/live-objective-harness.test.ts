import { describe, expect, it } from "vitest";
import {
  assertCompletion,
  assertRetryableObjective,
  boundedPolicy,
  installedIdentity,
  objectiveBody,
} from "../scripts/verify-live-objective.mjs";
import { parseRunPolicy } from "../src/protocol/policy.js";

function evidence() {
  const children = [2, 3, 4].map((number) => ({ number, state: "closed" }));
  return {
    status: { run: { state: "completed", runId: "fixture" } },
    objective: { state: "closed" },
    children,
    dependencies: [{ workItem: 4, blockedBy: [2, 3] }],
    events: [
      { runId: "fixture", event: "GraphProjected" },
      { runId: "fixture", event: "FactoryRunCompleted" },
      ...children.flatMap(({ number }) => [
        {
          runId: "fixture",
          event: "AttemptStarted",
          workItem: number,
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
      ]),
    ],
    pulls: children.map(({ number }) => ({
      number: number + 10,
      merged: true,
      merge_commit_sha: `merge-${number}`,
    })),
  };
}

describe("installed live Objective harness evidence boundary", () => {
  it("permits only an acknowledged same-actor failure before graph creation", () => {
    const value = {
      issue: { number: 1, state: "open", body: objectiveBody, user: { id: 42 } },
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
      installedIdentity({ ...input, pluginRoot: input.pluginRoot.replace("personal", "other") }),
    ).toThrow(/exact cache path/);
    expect(() =>
      installedIdentity({ ...input, manifest: { name: "factory", version: "2.0.26+unrelated" } }),
    ).toThrow(/cachebuster/);
    expect(() =>
      installedIdentity({ ...input, portable: { name: "factory", version: "2.0.27" } }),
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
    expect(() => assertCompletion(value)).toThrow(/join/);
  });
  it("rejects a cloud attempt even with successful closure", () => {
    const value = evidence();
    Object.assign(value.events.find((event) => event.event === "AttemptStarted")!, {
      backend: "codex-cli/daytona",
    });
    expect(() => assertCompletion(value)).toThrow(/nonlocal/);
  });
});
