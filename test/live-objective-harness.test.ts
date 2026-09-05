import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
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
  objectiveBodyFor,
  qualificationNamespace,
  qualificationNamespaceMarker,
  qualificationPaths,
  waitForCreatedObjectiveNamespace,
} from "../scripts/verify-live-objective.mjs";
import { parseRunPolicy, policyDigest } from "../src/protocol/policy.js";
import { bindValidationToPublishedHead } from "../src/validation/plan.js";
import {
  assertRegularCompletion,
  assessRegularCompletion,
  regularQualification,
  main as regularMain,
  observeRegularCommits,
} from "../scripts/verify-regular-objective.mjs";

type HarnessEvent = {
  event: string;
  sequence: number;
  [key: string]: unknown;
};

describe("created Objective namespace visibility", () => {
  const namespace = "visibility-qualification";
  const createdIssue = { number: 17, id: 1700, body: qualificationNamespaceMarker(namespace) };
  const input = () => ({ namespace, createdIssue, wait: vi.fn(async () => {}) });

  it("accepts an immediately visible exact identity without waiting", async () => {
    const list = vi.fn().mockResolvedValue([createdIssue]);
    const options = input();
    await waitForCreatedObjectiveNamespace({ ...options, list });
    expect(list).toHaveBeenCalledTimes(1);
    expect(options.wait).not.toHaveBeenCalled();
  });

  it("retries empty reads until the exact created issue is visible, with reads only", async () => {
    const list = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([createdIssue]);
    const options = input();
    await waitForCreatedObjectiveNamespace({ ...options, list });
    expect(list.mock.calls).toEqual([
      ["GET /repos/{owner}/{repo}/issues", { state: "all" }, 1000],
      ["GET /repos/{owner}/{repo}/issues", { state: "all" }, 1000],
    ]);
    expect(options.wait.mock.calls).toEqual([[1000]]);
  });

  it.each([
    [createdIssue, { ...createdIssue, number: 18, id: 1800 }],
    [{ ...createdIssue, number: 18 }],
    [{ ...createdIssue, id: 1800 }],
  ])("rejects duplicate or wrong issue identity without another read", async (...issues) => {
    const list = vi.fn().mockResolvedValue(issues);
    const options = input();
    await expect(waitForCreatedObjectiveNamespace({ ...options, list })).rejects.toThrow();
    expect(list).toHaveBeenCalledTimes(1);
    expect(options.wait).not.toHaveBeenCalled();
  });

  it("fails after five empty reads with bounded backoff and no creation", async () => {
    const list = vi.fn().mockResolvedValue([]);
    const options = input();
    await expect(waitForCreatedObjectiveNamespace({ ...options, list })).rejects.toThrow(
      /not visible/,
    );
    expect(list).toHaveBeenCalledTimes(5);
    expect(options.wait.mock.calls).toEqual([[1000], [2000], [4000], [8000]]);
    expect(list.mock.calls.every(([route]) => route.startsWith("GET "))).toBe(true);
  });

  it("stops at a conflicting observation after an initially empty read", async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([createdIssue, { ...createdIssue, number: 18, id: 1800 }])
      .mockResolvedValue([createdIssue]);
    const options = input();
    await expect(waitForCreatedObjectiveNamespace({ ...options, list })).rejects.toThrow(
      /not uniquely bound/,
    );
    expect(list).toHaveBeenCalledTimes(2);
    expect(options.wait.mock.calls).toEqual([[1000]]);
  });

  it.each([null, {}, [{ number: 17 }]])(
    "rejects unknown list shape without retry",
    async (response) => {
      const list = vi.fn().mockResolvedValue(response);
      const options = input();
      await expect(waitForCreatedObjectiveNamespace({ ...options, list })).rejects.toThrow();
      expect(list).toHaveBeenCalledTimes(1);
      expect(options.wait).not.toHaveBeenCalled();
    },
  );

  it("propagates lookup failure without retry or writes", async () => {
    const failure = new Error("GitHub lookup unavailable");
    const list = vi.fn().mockRejectedValue(failure);
    const options = input();
    await expect(waitForCreatedObjectiveNamespace({ ...options, list })).rejects.toBe(failure);
    expect(list).toHaveBeenCalledTimes(1);
    expect(options.wait).not.toHaveBeenCalled();
  });
});

function evidence() {
  const children = [2, 3, 4].map((number) => ({ number, state: "closed" }));
  const policy = boundedPolicy();
  const namespace = "fixture-qualification";
  const fixturePaths = qualificationPaths(namespace);
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
    objective: { number: 1, state: "closed", body: objectiveBodyFor(namespace) },
    children,
    dependencies: [
      { workItem: 2, blockedBy: [] },
      { workItem: 3, blockedBy: [] },
      { workItem: 4, blockedBy: [{ number: 2 }, { number: 3 }] },
    ],
    policy,
    qualificationNamespace: namespace,
    fixturePaths,
    installedArtifact: { inventorySha256: "candidate", bundles: [] },
    finishedInstalledArtifact: { inventorySha256: "candidate", bundles: [] },
    preflight: {
      qualificationNamespace: namespace,
      namespaceIssues: [],
      harness: { candidateInventorySha256: "candidate" },
    },
    actor: { id: 42, login: "operator" },
    repository: "example/factory-qualification",
    events: [
      {
        event: "FactoryRunStarted",
        actor: "operator",
        repository: "example/factory-qualification",
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
          receiptUrl: `https://github.com/example/factory-qualification/issues/1#issuecomment-${sequence}`,
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

function regularEvidence() {
  const fixture = evidence();
  const policy = parseRunPolicy(boundedPolicy("regular-prs"));
  const digest = policyDigest(policy);
  const base = "a".repeat(40);
  const graphDigest = "b".repeat(64);
  const regularCommits: { sha: string; treeSha: string; parents: string[] }[] = [];
  const runStart = fixture.events.find((event) => event.event === "FactoryRunStarted")!;
  Object.assign(runStart, { policy, policyDigest: digest });
  const prefix = [
    runStart,
    { event: "GraphCompiled", baseSha: base, graphDigest },
    fixture.events.find((event) => event.event === "GraphProjected")!,
    { event: "DeliverySelected", requested: "regular-prs", selected: "regular-prs" },
    {
      event: "BudgetReconciled",
      unit: "model_tokens",
      phase: "management",
      usageId: `compile-${graphDigest}`,
      amount: 100,
    },
  ];
  let previous = base;
  const pipeline = [2, 3, 4].flatMap((number) => {
    const head = String(number).repeat(40);
    const merge = String(number + 3).repeat(40);
    const tree = (number + 6).toString(16).repeat(40);
    const validation = {
      passed: true,
      digest: String(number).repeat(64),
      baseSha: previous,
      outputTreeSha: tree,
    };
    const exact = bindValidationToPublishedHead({
      validation,
      publishedHeadSha: head,
      publishedTreeSha: tree,
      publishedBaseSha: previous,
    });
    regularCommits.push(
      { sha: head, treeSha: tree, parents: [previous] },
      { sha: merge, treeSha: tree, parents: [previous] },
    );
    Object.assign(fixture.pulls.find((pull) => pull.number === number + 10)!, {
      head: { sha: head },
      merge_commit_sha: merge,
    });
    const records = fixture.events.filter((event) => event.workItem === number);
    const started = records.find((event) => event.event === "AttemptStarted")!;
    const published = records.find((event) => event.event === "AttemptPublished")!;
    const publication = records.find((event) => event.event === "PublicationRecorded")!;
    Object.assign(published, { headSha: head });
    Object.assign(publication, {
      kind: "publication",
      mode: "regular-prs",
      position: 0,
      headSha: head,
      baseSha: previous,
      validationDigest: validation.digest,
      exactHeadValidationDigest: exact.digest,
    });
    records.find((event) => event.event === "AttemptIntegrated")!.headSha = merge;
    records.splice(records.indexOf(started), 0, {
      event: "AttemptReserved",
      workItem: number,
      attempt: 1,
      sequence: 0,
    });
    records.splice(
      records.indexOf(publication),
      0,
      {
        event: "ValidationRecorded",
        kind: "validation",
        workItem: number,
        attempt: 1,
        passed: true,
        baseSha: previous,
        outputTreeSha: tree,
        evidenceDigest: validation.digest,
        sequence: 0,
      },
      {
        event: "BudgetReconciled",
        unit: "model_tokens",
        phase: "execution",
        workItem: number,
        attempt: 1,
        usageId: `worker-${number}-1`,
        amount: 100,
        sequence: 0,
      },
      {
        event: "BudgetReconciled",
        unit: "model_tokens",
        phase: "management",
        workItem: number,
        attempt: 1,
        usageId: `review-${String(number).repeat(64)}`,
        amount: 100,
        sequence: 0,
      },
    );
    previous = merge;
    return records;
  });
  return {
    ...fixture,
    scope: "installed-local-explicit-regular-objective",
    base,
    policy,
    regularCommits,
    preflight: { ...fixture.preflight, base },
    runRequest: {
      tool: "factory_run",
      arguments: {
        owner: "example",
        repo: "factory-qualification",
        objectiveNumber: 1,
        repository: "/home/example/fixture",
        untilTerminal: true,
        policy,
      },
    },
    status: { ...fixture.status, run: { ...fixture.status.run, policyDigest: digest } },
    events: [...prefix, ...pipeline, { event: "FactoryRunCompleted" }].map(
      (event, index) =>
        ({
          ...event,
          runId: "fixture",
          objective: 1,
          sequence: index + 1,
          policyDigest: digest,
          at: new Date(index * 1000).toISOString(),
          author: "operator",
          authorId: 42,
          receiptUrl: `https://github.com/example/factory-qualification/issues/1#issuecomment-${index}`,
        }) as HarnessEvent,
    ),
  };
}

describe("explicit installed regular qualification", () => {
  it("is inert without its own opt-in and refuses implicit selection overrides", async () => {
    const run = vi.fn();
    await regularMain({}, run);
    expect(run).not.toHaveBeenCalled();
    const env = {
      FACTORY_LIVE_REGULAR_OBJECTIVE: "1",
      FACTORY_LIVE_OBJECTIVE: "1",
      FACTORY_LIVE_OBJECTIVE_MAX_MODEL_TOKENS: "500000",
    };
    expect(() =>
      regularQualification({ ...env, FACTORY_LIVE_OBJECTIVE_DELIVERY: "stacked-prs" }),
    ).toThrow();
    expect(() =>
      regularQualification({ ...env, FACTORY_LIVE_OBJECTIVE_MAX_MODEL_TOKENS: "500001" }),
    ).toThrow();
    await regularMain(env, run);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]![0].policy).toEqual(boundedPolicy("regular-prs"));
  });
  it("passes only explicit serialized regular delivery and leaves native gate unchanged", () => {
    const value = regularEvidence();
    expect(() => assertRegularCompletion(value)).not.toThrow();
    expect(assessRegularCompletion(value).result).toBe("passed");
    expect(() => assertQualificationCompletion(value)).toThrow(/native delivery/);
    expect(() => assertRegularCompletion(evidence())).toThrow();
  });
  it.each(["AttemptReserved", "AttemptStarted"])(
    "rejects next %s after worker success but before prior integration",
    (kind) => {
      const value = regularEvidence();
      const next = value.events.find((event) => event.workItem === 3 && event.event === kind)!;
      next.sequence =
        value.events.find((event) => event.workItem === 2 && event.event === "AttemptSucceeded")!
          .sequence + 0.5;
      // Keep integral production sequences while placing the new admission in the gap.
      for (const event of value.events) event.sequence *= 2;
      expect(() => assertRegularCompletion(value)).toThrow(/before previous pipeline integrated/);
    },
  );
  it.each(["mode", "stackNumber", "parentItemId"])(
    "rejects hidden publication topology %s",
    (field) => {
      const value = regularEvidence();
      value.events.find((event) => event.event === "PublicationRecorded")![field] =
        field === "mode" ? "native-stacks" : field === "stackNumber" ? 90 : "parent";
      expect(() => assertRegularCompletion(value)).toThrow();
    },
  );
  it.each(["treeSha", "parents", "sha"])("rejects changed exact commit %s", (field) => {
    const value = regularEvidence();
    Object.assign(value.regularCommits[0]!, {
      [field]: field === "parents" ? ["e".repeat(40)] : "e".repeat(40),
    });
    expect(() => assertRegularCompletion(value)).toThrow();
  });
  it.each(["exactHeadValidationDigest", "validationDigest", "baseSha"])(
    "rejects transplanted publication %s",
    (field) => {
      const value = regularEvidence();
      value.events.find((event) => event.event === "PublicationRecorded")![field] = "f".repeat(
        field === "baseSha" ? 40 : 64,
      );
      expect(() => assertRegularCompletion(value)).toThrow();
    },
  );
  it("rejects requested policy drift, unauthenticated closure and missing worker usage", () => {
    const policy = regularEvidence();
    policy.runRequest.arguments.objectiveNumber = 99;
    expect(() => assertRegularCompletion(policy)).toThrow(/request Objective/);
    const unauth = regularEvidence();
    unauth.events.at(-1)!.authorId = 99;
    expect(() => assertRegularCompletion(unauth)).toThrow(/authenticated/);
    const missing = regularEvidence();
    missing.events = missing.events.filter((event) => event.usageId !== "worker-2-1");
    expect(assessRegularCompletion(missing).result).toBe("incomplete");
  });
  it("accepts legitimate partial-order collision but rejects same-identity contradictions", () => {
    const value = regularEvidence();
    const budget = value.events.find((event) => event.event === "BudgetReconciled")!;
    value.events.push({
      ...budget,
      kind: "run",
      event: "RunPauseRequested",
      requestId: "pause",
      requestedBy: "operator",
      repository: value.repository,
    });
    expect(() => assertRegularCompletion(value)).not.toThrow();
    value.events.push({ ...budget, amount: 101 });
    expect(() => assertRegularCompletion(value)).toThrow(/conflicting/);
  });
  it("performs only bounded exact commit reads and rejects transplanted read results", async () => {
    const value = regularEvidence();
    const original = structuredClone(value.regularCommits);
    const request = vi.fn(async (_route: string, args: Record<string, string>) => {
      const commit = original.find((commit) => commit.sha === args.commit_sha)!;
      return {
        data: {
          sha: commit.sha,
          tree: { sha: commit.treeSha },
          parents: commit.parents.map((sha) => ({ sha })),
        },
      };
    });
    await observeRegularCommits({ evidence: value, request });
    expect(request).toHaveBeenCalledTimes(6);
    expect(request.mock.calls.every(([route]) => route.startsWith("GET "))).toBe(true);
    expect(() => assertRegularCompletion(value)).not.toThrow();
    await expect(
      observeRegularCommits({ evidence: value, request: async () => ({ data: { sha: "other" } }) }),
    ).rejects.toThrow(/another identity/);
  });
});

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
  it("creates one bounded namespace and applies it to every fixture path and marker", () => {
    const generated = qualificationNamespace(
      undefined,
      () => "12345678-1234-1234-1234-123456789abc",
    );
    expect(generated).toBe("q-12345678-1234-1234-1234-123456789abc");
    const namespace = qualificationNamespace("local-20260905-a");
    const paths = qualificationPaths(namespace);
    expect(paths.files).toHaveLength(6);
    expect(paths.files.every((path) => path.includes(`/${namespace}/`))).toBe(true);
    const body = objectiveBodyFor(namespace);
    expect(body).toContain(qualificationNamespaceMarker(namespace));
    expect(paths.files.every((path) => body.includes(path))).toBe(true);
    for (const invalid of ["short", "UPPERCASE-NAMESPACE", "bad/path-name", "ends-with-"])
      expect(() => qualificationNamespace(invalid)).toThrow(/namespace/);
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
      namespaceIssues: [],
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
        namespaceIssues: [{ number: 13 }],
        openFactoryPulls: [{ number: 5 }],
        rateLimit: { core: { remaining: 999 }, graphql: { remaining: 5000 } },
      }),
    ).toMatchObject({
      result: "blocked",
      blockers: [
        "qualification-namespace-already-exists",
        "prior-factory-pull-requests-remain-open",
        "core-quota-below-1000",
      ],
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
      }),
    ).toMatchObject({ result: "passed", blockers: [] });
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
