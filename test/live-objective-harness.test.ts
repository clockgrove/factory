import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertCompletion,
  assessCompletion,
  assessQualificationPreflight,
  assertRetryableObjective,
  assertQualificationCompletion,
  boundedPolicy,
  installedBundleIdentity,
  installedIdentity,
  installedPluginPath,
  modelTokenLimit,
  objectiveBody,
} from "../scripts/verify-live-objective.mjs";
import { parseRunPolicy } from "../src/protocol/policy.js";

type HarnessEvent = {
  event: string;
  sequence: number;
  [key: string]: unknown;
};

function evidence() {
  const children = [2, 3, 4].map((number) => ({ number, state: "closed" }));
  const policy = boundedPolicy();
  const reservation = (number: number) => [
    {
      event: "BudgetReserved",
      workItem: number,
      attempt: 1,
      phase: "execution",
      unit: "local_milliseconds",
      amount: 1000,
    },
    {
      event: "CapacityReserved",
      workItem: number,
      attempt: 1,
      phase: "execution",
      backend: "codex-sdk/local-worktree",
    },
    {
      event: "AttemptStarted",
      workItem: number,
      attempt: 1,
      backend: "codex-sdk/local-worktree",
    },
  ];
  const completion = (number: number) => [
    {
      event: "AttemptSucceeded",
      workItem: number,
      attempt: 1,
      backend: "codex-sdk/local-worktree",
    },
    {
      event: "AttemptValidated",
      workItem: number,
      attempt: 1,
      artifactDigest: `artifact-${number}`,
    },
    {
      event: "AttemptPublished",
      workItem: number,
      attempt: 1,
      artifactDigest: `artifact-${number}`,
      headSha: `head-${number}`,
    },
    {
      event: "PublicationRecorded",
      workItem: number,
      attempt: 1,
      headSha: `head-${number}`,
      pullRequest: number + 10,
      mode: "native-stacks",
    },
    {
      event: "AttemptIntegrated",
      workItem: number,
      attempt: 1,
      headSha: `merge-${number}`,
    },
    {
      event: "BudgetReconciled",
      workItem: number,
      attempt: 1,
      phase: "execution",
      unit: "local_milliseconds",
      amount: 500,
    },
    {
      event: "CapacityReconciled",
      workItem: number,
      attempt: 1,
      phase: "execution",
      backend: "codex-sdk/local-worktree",
    },
  ];
  const modelReceipts = Array.from({ length: 7 }, (_, index) => ({
    event: "BudgetReconciled",
    phase: "management",
    unit: "model_tokens",
    amount: 100,
    usageId: `model-call-${index + 1}`,
  }));
  return {
    runResult: { status: "completed", runId: "fixture", objective: 1 },
    status: {
      objective: { number: 1, closed: true },
      summary: {
        runId: "fixture",
        outcome: "completed",
        attempts: { active: 0 },
        economics: {
          usage: {
            model_tokens: { availability: "observed", value: 700 },
            local_milliseconds: { availability: "observed", value: 1500 },
            validation_milliseconds: { availability: "observed", value: 300 },
          },
          budgets: {
            modelTokens: {
              availability: "observed",
              value: { configured: 500_000, committed: 700, remaining: 499_300 },
            },
          },
        },
      },
      run: { state: "completed", runId: "fixture", policyDigest: "policy-digest" },
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
    policy,
    installedArtifact: { inventorySha256: "candidate", bundles: [] },
    finishedInstalledArtifact: { inventorySha256: "candidate", bundles: [] },
    preflight: { harness: { candidateInventorySha256: "candidate" } },
    actor: { id: 42, login: "operator" },
    repository: "clockgrove/factory-conformance",
    events: [
      {
        event: "FactoryRunStarted",
        actor: "operator",
        repository: "clockgrove/factory-conformance",
        policy,
        policyDigest: "policy-digest",
      },
      { runId: "fixture", event: "GraphProjected", graphSize: 3 },
      { event: "DeliverySelected", requested: "stacked-prs", selected: "native-stacks" },
      ...modelReceipts,
      ...reservation(2),
      ...reservation(3),
      ...completion(2),
      ...completion(3),
      ...reservation(4),
      ...completion(4),
      { runId: "fixture", event: "FactoryRunCompleted" },
    ].map(
      (event, sequence) =>
        ({
          runId: "fixture",
          ...event,
          sequence,
          objective: 1,
          receiptUrl: `https://github.com/clockgrove/factory-conformance/issues/1#issuecomment-${sequence}`,
          author: "operator",
          authorId: 42,
        }) as HarnessEvent,
    ),
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
  it("derives the default Linux-home cache path from exactly one enabled receipt", () => {
    const listed = {
      installed: [
        {
          name: "factory",
          installed: true,
          enabled: true,
          version: "2.0.26",
          pluginId: "factory@clockgrove-factory",
          marketplaceName: "clockgrove-factory",
        },
      ],
    };
    const expected = "/home/example/.codex/plugins/cache/clockgrove-factory/factory/2.0.26";
    expect(installedPluginPath({ listed, codexHome: "/home/example/.codex" })).toBe(expected);
    expect(() =>
      installedPluginPath({ listed, codexHome: "/home/example/.codex", requestedRoot: expected }),
    ).not.toThrow();
    expect(() =>
      installedPluginPath({
        listed: { installed: [...listed.installed, ...listed.installed] },
        codexHome: "/home/example/.codex",
      }),
    ).toThrow(/one enabled/);
  });
  it("binds both installed bundles to their inventory", async () => {
    const root = await mkdtemp(join(tmpdir(), "factory-live-installed-"));
    try {
      await mkdir(join(root, "dist"));
      await writeFile(
        join(root, "package.json"),
        JSON.stringify({ name: "@clockgrove/factory", version: "2.0.26" }),
      );
      const bundles = ["factory.js", "mcp-server.js"].map((file) => {
        const bytes = Buffer.from(file);
        return {
          file,
          bytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        };
      });
      await Promise.all(
        bundles.map((bundle) => writeFile(join(root, "dist", bundle.file), bundle.file)),
      );
      await writeFile(
        join(root, "dist", "bundle-inventory.json"),
        JSON.stringify({ protocol: "clockgrove.factory/bundle-inventory-v1", bundles }),
      );
      expect(installedBundleIdentity(root)).toMatchObject({ version: "2.0.26", bundles });
      await writeFile(join(root, "dist", "mcp-server.js"), "tampered");
      expect(() => installedBundleIdentity(root)).toThrow(/mcp-server.js/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("requires an explicit bounded model quota", () => {
    expect(modelTokenLimit("500000")).toBe(500_000);
    for (const value of [undefined, "249999", "500001", "3.5", "tokens"])
      expect(() => modelTokenLimit(value)).toThrow();
  });
  it("blocks stale Factory PRs, automatic review, or insufficient GitHub quota", () => {
    const ready = {
      checkout: { clean: true, headMatchesDefault: true, fixturePathsAbsent: true },
      harness: { sourceTreeClean: true, candidateInventorySha256: "candidate" },
      installedArtifact: { inventorySha256: "candidate" },
      repository: { private: true, archived: false, permissions: { push: true } },
      branch: { protected: false },
      rulesets: [],
      workflows: [],
      openFactoryPulls: [],
      rateLimit: { core: { remaining: 5000 }, graphql: { remaining: 5000 } },
    };
    expect(assessQualificationPreflight(ready)).toMatchObject({
      result: "passed",
      blockers: [],
    });
    expect(
      assessQualificationPreflight({
        ...ready,
        workflows: [
          {
            state: "active",
            path: "dynamic/agents/copilot-pull-request-reviewer",
          },
        ],
        openFactoryPulls: [{ number: 5 }],
        rateLimit: { core: { remaining: 999 }, graphql: { remaining: 5000 } },
      }),
    ).toMatchObject({
      result: "blocked",
      blockers: [
        "automatic-pull-request-review-is-active",
        "prior-factory-pull-requests-remain-open",
        "core-quota-below-1000",
      ],
    });
  });
  it("uses a valid bounded local-only policy", () => {
    for (const mode of ["regular-prs", "stacked-prs"]) {
      const policy = parseRunPolicy(boundedPolicy(mode));
      expect(policy.allowedPaidBackends).toEqual([]);
      expect(policy.economics?.maxModelTokens).toBe(500_000);
      expect(policy.maxParallel).toBe(2);
    }
  });
  it("accepts a complete multi-wave transcript with distinct PR and merge heads", () => {
    expect(() => assertCompletion(evidence())).not.toThrow();
    expect(() => assertQualificationCompletion(evidence())).not.toThrow();
  });
  it("does not pass ordinary-PR fallback, unauthenticated receipts, or serial siblings", () => {
    const fallback = evidence();
    Object.assign(fallback.events.find((event) => event.event === "DeliverySelected")!, {
      selected: "regular-prs",
    });
    expect(() => assertQualificationCompletion(fallback)).toThrow(/native delivery/);
    const unauthenticated = evidence();
    unauthenticated.events.find((event) => event.event === "FactoryRunCompleted")!.authorId = 7;
    expect(() => assertQualificationCompletion(unauthenticated)).toThrow(/authenticated/);
    const serial = evidence();
    const laterStart = serial.events.find(
      (event) => event.event === "AttemptStarted" && event.workItem === 3,
    )!;
    const earlierSuccess = serial.events.find(
      (event) => event.event === "AttemptSucceeded" && event.workItem === 2,
    )!;
    [laterStart.sequence, earlierSuccess.sequence] = [earlierSuccess.sequence, laterStart.sequence];
    expect(() => assertQualificationCompletion(serial)).toThrow(/did not overlap/);
  });
  it("tolerates identical at-least-once comments but rejects a conflicting sequence", () => {
    const duplicated = evidence();
    const start = duplicated.events.find((event) => event.event === "FactoryRunStarted")!;
    duplicated.events.push({
      ...start,
      receiptUrl: `${start.receiptUrl}-duplicate`,
    });
    expect(() => assertQualificationCompletion(duplicated)).not.toThrow();
    duplicated.events.push({
      ...start,
      policyDigest: "different-policy-digest",
      receiptUrl: `${start.receiptUrl}-conflict`,
    });
    expect(() => assertQualificationCompletion(duplicated)).toThrow(/conflicting GitHub receipts/);
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
      Object.assign(
        value.events.find(
          (event) =>
            event.event === "BudgetReconciled" &&
            event.unit === "local_milliseconds" &&
            event.workItem === 2,
        )!,
        { [field]: "different" },
      );
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
