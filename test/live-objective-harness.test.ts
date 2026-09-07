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
  assertRecordedQualificationPolicy,
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
import { parseRunPolicy } from "../src/protocol/policy.js";
import { assertSchedulingCompletion } from "../scripts/verify-local-scheduling.mjs";
import {
  assertRegularCompletion,
  assessRegularCompletion,
  regularQualification,
  main as regularMain,
  observeRegularCommits,
} from "../scripts/verify-regular-objective.mjs";
import {
  assertNativeFallbackCapability,
  assertNativeFallbackCompletion,
  assessNativeFallbackCompletion,
  nativeFallbackQualification,
  observeNativeFallbackCapability,
  main as fallbackMain,
} from "../scripts/verify-native-fallback-objective.mjs";
import { assertNativeMergeProof } from "../scripts/qualification-sibling-refresh-proof.mjs";
import { completeSiblingQualificationFixture } from "./helpers/sibling-qualification-evidence.mjs";

type HarnessEvent = {
  event: string;
  sequence: number;
  [key: string]: unknown;
};

describe("qualification token intent compatibility", () => {
  it("opts new scenarios into observed stopping without rewriting historical evidence", () => {
    const current = parseRunPolicy(boundedPolicy());
    expect(current.economics?.modelTokenBudgetMode).toBe("observed-stop");
    const legacy = structuredClone(current);
    delete legacy.economics!.modelTokenBudgetMode;
    const before = JSON.stringify(legacy);
    expect(() => assertRecordedQualificationPolicy(current, current)).not.toThrow();
    expect(() => assertRecordedQualificationPolicy(legacy, current)).not.toThrow();
    expect(JSON.stringify(legacy)).toBe(before);
    expect(current.economics?.modelTokenBudgetMode).toBe("observed-stop");
    const hard = structuredClone(current);
    hard.economics!.modelTokenBudgetMode = "hard";
    expect(() => assertRecordedQualificationPolicy(hard, current)).toThrow();
    legacy.maxParallel += 1;
    expect(() => assertRecordedQualificationPolicy(legacy, current)).toThrow();
  });
});

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
      headSha: String(number).repeat(40),
    },
    {
      event: "PublicationRecorded",
      workItem: number,
      attempt: 1,
      headSha: String(number).repeat(40),
      pullRequest: number + 10,
      mode: "native-stacks",
    },
    {
      event: "AttemptIntegrated",
      workItem: number,
      attempt: 1,
      headSha: String(number + 3).repeat(40),
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
      node_id: `PR_${number + 10}`,
      base: { repo: { node_id: "R_fixture", full_name: "example/factory-qualification" } },
      number: number + 10,
      state: "closed",
      merged: true,
      head: { sha: String(number).repeat(40) },
    })),
    mergeProofs: children.map(({ number }) => ({
      runId: "fixture",
      objective: 1,
      workItem: number,
      attempt: 1,
      pullRequest: number + 10,
      pullRequestNodeId: `PR_${number + 10}`,
      repository: "example/factory-qualification",
      repositoryNodeId: "R_fixture",
      headSha: String(number).repeat(40),
      mergeSha: String(number + 3).repeat(40),
    })),
  };
}

async function regularEvidence(profile = "local-default", fallback = false) {
  const policy = parseRunPolicy(boundedPolicy(fallback ? "stacked-prs" : "regular-prs"));
  if (fallback) policy.delivery!.onUnavailable = "regular-prs";
  if (profile === "codex-cli") policy.backendOrder = ["codex-cli/local-worktree"];
  const f = await completeSiblingQualificationFixture({
    policy,
    repository: "example/factory-qualification",
    ...(profile === "fallback-cli" ? { backend: "codex-cli/local-worktree" } : {}),
  });
  const generated = f.evidence as ReturnType<typeof evidence> & {
    base: string;
    nativeMergeEvidence: unknown[];
    nativeScopeObservations: unknown[];
    nativeScopeFinalHostIdentity: string;
    nativeDefaultBranch: string;
    runRequest: {
      tool: string;
      arguments: {
        owner: string;
        repo: string;
        objectiveNumber: number;
        untilTerminal: boolean;
        policy: typeof policy;
      };
    };
  };
  const shas = new Set(
    generated.events
      .filter((event) => ["PublicationRecorded", "AttemptIntegrated"].includes(event.event))
      .map((event) => String(event.headSha)),
  );
  return {
    ...generated,
    regularBackendProfile: profile === "fallback-cli" ? "local-default" : profile,
    scope: "installed-local-explicit-regular-objective",
    policy,
    regularCommits: [...shas].map((sha) => {
      const commit = f.commits.get(sha)!;
      return { sha, treeSha: commit.treeOid, parents: commit.parentOids };
    }),
    preflight: { ...generated.preflight, base: generated.base },
  };
}

function fallbackTransport(status = 404, override: Record<string, unknown> = {}) {
  const repository = "example/factory-qualification";
  return vi.fn(async (route: string, parameters: Record<string, unknown>) => {
    const stacks = route.endsWith("/stacks");
    const response = {
      status: stacks ? status : 200,
      url: `https://api.github.com/repos/${repository}${route.endsWith("/pulls") ? "/pulls" : stacks ? "/stacks" : ""}`,
      headers: {
        "x-github-api-version-selected": "2026-03-10",
        "x-github-request-id": "ABC:123",
        "x-ratelimit-remaining": "2000",
        date: "Sun, 06 Sep 2026 00:00:00 GMT",
      },
      data: stacks
        ? status === 404
          ? { message: "Not Found" }
          : []
        : route.endsWith("/pulls")
          ? []
          : {
              id: 99,
              node_id: "R_fixture",
              full_name: repository,
              private: true,
              archived: false,
              permissions: { push: true },
            },
      ...(stacks ? override : {}),
    };
    if (stacks && override.headers)
      response.headers = {
        "x-github-api-version-selected": "2026-03-10",
        "x-github-request-id": "ABC:123",
        "x-ratelimit-remaining": "2000",
        date: "Sun, 06 Sep 2026 00:00:00 GMT",
        ...(override.headers as object),
      };
    expect((parameters.request as { signal: AbortSignal }).signal).toBeInstanceOf(AbortSignal);
    if (stacks && status >= 400) throw Object.assign(new Error("REST response"), { response });
    return response;
  });
}

async function fallbackEvidence() {
  const value = await regularEvidence("local-default", true);
  value.scope = "installed-local-native-unavailable-regular-fallback";
  const capability = await observeNativeFallbackCapability({
    repository: value.repository,
    actor: value.actor,
    request: fallbackTransport(),
  });
  Object.assign(value.preflight.harness, { sourceTreeClean: true });
  Object.assign(value.preflight, { scenario: capability });
  return { ...value, nativeFallbackCapability: capability };
}

describe("actual native-unavailability regular fallback", () => {
  const env = {
    FACTORY_LIVE_NATIVE_FALLBACK_OBJECTIVE: "1",
    FACTORY_LIVE_OBJECTIVE_PREFLIGHT: "1",
    FACTORY_LIVE_OBJECTIVE_MAX_MODEL_TOKENS: "250000",
  };
  const identity = {
    repository: "example/factory-qualification",
    actor: { id: 42, login: "operator" },
  };
  it("is a no-op without its own opt-in and rejects conflicting original selections", async () => {
    const run = vi.fn();
    await fallbackMain({}, run);
    expect(run).not.toHaveBeenCalled();
    for (const conflict of [
      { FACTORY_LIVE_OBJECTIVE_DELIVERY: "regular-prs" },
      { FACTORY_LIVE_REGULAR_OBJECTIVE: "1" },
      { FACTORY_LIVE_REGULAR_BACKEND: "codex-cli" },
      { FACTORY_LIVE_NATIVE_REFRESH_OBJECTIVE: "1" },
    ])
      expect(() => nativeFallbackQualification({ ...env, ...conflict })).toThrow();
    const qualification = nativeFallbackQualification(env)!;
    expect(qualification.policy).toEqual({
      ...(boundedPolicy("stacked-prs", 250000) as object),
      delivery: { mode: "stacked-prs", onUnavailable: "regular-prs", merge: "bottom-up" },
    });
  });
  it("accepts only real 404 bracketed by accessible same-repository and PR reads", async () => {
    const request = fallbackTransport();
    const proof = await observeNativeFallbackCapability({ ...identity, request });
    expect(proof.result).toBe("passed");
    expect(() => assertNativeFallbackCapability(proof, identity)).not.toThrow();
    expect(request.mock.calls.map(([route]) => route)).toEqual([
      "GET /repos/{owner}/{repo}",
      "GET /repos/{owner}/{repo}/pulls",
      "GET /repos/{owner}/{repo}/stacks",
      "GET /repos/{owner}/{repo}",
    ]);
    expect(() =>
      assertNativeFallbackCapability(proof, { ...identity, actor: { id: 43, login: "operator" } }),
    ).toThrow();
  });
  it.each([200, 401, 403, 422, 429, 500])(
    "does not turn HTTP %s into unsupported capability",
    async (status) => {
      const request = fallbackTransport(status);
      const proof = await observeNativeFallbackCapability({ ...identity, request });
      expect(proof.result).toBe("blocked");
      expect(request.mock.calls.filter(([route]) => route.endsWith("/stacks"))).toHaveLength(1);
    },
  );
  it.each([
    { headers: { "x-ratelimit-remaining": "0" } },
    { headers: { "retry-after": "60" } },
    { headers: { "x-github-sso": "required" } },
    { url: "https://api.github.com/repos/other/repository/stacks" },
    { data: { message: "Bad credentials" } },
  ])("rejects misleading 404 response provenance %j", async (override) => {
    const proof = await observeNativeFallbackCapability({
      ...identity,
      request: fallbackTransport(404, override),
    });
    expect(proof.result).toBe("blocked");
  });
  it("does not fabricate unsupported evidence from missing permissions or transport failure", async () => {
    const unreachable = vi.fn(async () => {
      throw new Error("transport unavailable");
    });
    expect(
      (await observeNativeFallbackCapability({ ...identity, request: unreachable })).result,
    ).toBe("blocked");
    expect(unreachable).toHaveBeenCalledTimes(1);
    const real = fallbackTransport();
    const denied = vi.fn(async (route: string, parameters: Record<string, unknown>) => {
      if (route.endsWith("/pulls"))
        throw Object.assign(new Error("denied"), { response: { status: 404 } });
      return real(route, parameters);
    });
    expect((await observeNativeFallbackCapability({ ...identity, request: denied })).result).toBe(
      "blocked",
    );
    expect(denied.mock.calls.some(([route]) => route.endsWith("/stacks"))).toBe(false);
  });
  it("reobserves before creation and denies capability changes without a write or retry", async () => {
    const preflight = await observeNativeFallbackCapability({
      ...identity,
      request: fallbackTransport(),
    });
    const qualification = nativeFallbackQualification(env)!;
    const hook = qualification.beforeRun as (input: Record<string, unknown>) => Promise<void>;
    const request = fallbackTransport(200);
    const save = vi.fn();
    await expect(
      hook({ evidence: { ...identity, preflight: { scenario: preflight } }, request, save }),
    ).rejects.toThrow();
    expect(save).toHaveBeenCalledTimes(1);
    expect(request.mock.calls.every(([route]) => route.startsWith("GET "))).toBe(true);
  });
  it("rejects repository replacement around an otherwise valid unsupported response", async () => {
    const original = fallbackTransport();
    let repositoryReads = 0;
    const request = vi.fn(async (route: string, parameters: Record<string, unknown>) => {
      const response = await original(route, parameters);
      if (route === "GET /repos/{owner}/{repo}" && ++repositoryReads === 2)
        return { ...response, data: { ...(response.data as object), id: 100 } };
      return response;
    });
    const proof = await observeNativeFallbackCapability({ ...identity, request });
    expect(proof.result).toBe("blocked");
    expect(request).toHaveBeenCalledTimes(4);
  });
  it("reuses complete regular-pipeline, exact artifact, accounting and all-scope proofs without rewriting receipts", async () => {
    const value = await fallbackEvidence();
    expect(() => assertNativeFallbackCompletion(value)).not.toThrow();
    expect(assessNativeFallbackCompletion(value).result).toBe("passed");
    expect(() => assertRegularCompletion(value)).toThrow();
    expect(() => assertQualificationCompletion(value)).toThrow();
  });
  it("preserves non-fallback escalation rather than upgrading terminal history to a pass", async () => {
    const value = await fallbackEvidence();
    value.status.run.state = "escalated";
    value.events.find((event) => event.event === "FactoryRunCompleted")!.event =
      "FactoryRunEscalated";
    expect(assessNativeFallbackCompletion(value).result).toBe("failed");
  });
  it.each([
    "reason",
    "version",
    "requested",
    "selected",
    "authorization",
    "accounting",
    "scope",
    "missing-overlap",
    "merge",
  ])("rejects false fallback proof: %s", async (mutation) => {
    const value = await fallbackEvidence();
    const selected = value.events.find((event) => event.event === "DeliverySelected")!;
    if (mutation === "reason")
      selected.reason = "GitHub denied stack capability inspection for this repository";
    if (mutation === "version") selected.capabilityVersion = "2022-11-28";
    if (mutation === "requested") selected.requested = "regular-prs";
    if (mutation === "selected") selected.selected = "native-stacks";
    if (mutation === "authorization") value.policy.delivery!.onUnavailable = "escalate";
    if (mutation === "accounting")
      value.events = value.events.filter(
        (event) => event.phase !== "execution" || event.unit !== "model_tokens",
      );
    if (mutation === "scope")
      delete (value as unknown as Record<string, unknown>).nativeScopeObservations;
    if (mutation === "missing-overlap")
      value.events.find(
        (event) => event.workItem === 3 && event.event === "AttemptStarted",
      )!.sequence =
        Number(
          value.events.find((event) => event.workItem === 2 && event.event === "AttemptSucceeded")!
            .sequence,
        ) + 1;
    if (mutation === "merge") value.mergeProofs.pop();
    expect(() => assertNativeFallbackCompletion(value)).toThrow();
    expect(assessNativeFallbackCompletion(value).result).toBe("incomplete");
  });
});

describe("shared versioned REST merge evidence", () => {
  it("default and regular qualification accept field-absent REST only with exact separate proofs", async () => {
    const native = evidence();
    const regular = await regularEvidence();
    for (const value of [native, regular]) {
      expect(value.pulls.every((pull) => !("merge_commit_sha" in pull))).toBe(true);
      expect(() =>
        assertCompletion(
          value,
          undefined,
          value === regular
            ? (proof, input) => assertNativeMergeProof(regular, proof, input)
            : undefined,
        ),
      ).not.toThrow();
      value.mergeProofs.pop();
      expect(() => assertCompletion(value)).toThrow(/merge commit proof coverage/);
    }
  });
  it("regular and scheduling qualification reject cross-run stored proof before accepting delivery", async () => {
    const value = await regularEvidence();
    value.mergeProofs[0]!.runId = "other";
    expect(() => assertRegularCompletion(value)).toThrow(/merge commit proof missing/);
    expect(() => assertSchedulingCompletion(value)).toThrow(/merge commit proof missing/);
  });
});

describe("explicit installed regular qualification", () => {
  it("selects only explicit CLI without changing default authority or model settings", async () => {
    const env = {
      FACTORY_LIVE_REGULAR_OBJECTIVE: "1",
      FACTORY_LIVE_OBJECTIVE: "1",
      FACTORY_LIVE_OBJECTIVE_MAX_MODEL_TOKENS: "500000",
    };
    const selected = regularQualification({ ...env, FACTORY_LIVE_REGULAR_BACKEND: "codex-cli" })!;
    expect(selected.policy).toEqual({
      ...(boundedPolicy("regular-prs") as object),
      backendOrder: ["codex-cli/local-worktree"],
    });
    expect(regularQualification(env)!.policy).toEqual(boundedPolicy("regular-prs"));
    for (const profile of ["codex-sdk", "unknown", "codex-cli/daytona", ""])
      expect(() => regularQualification({ ...env, FACTORY_LIVE_REGULAR_BACKEND: profile })).toThrow(
        /route/,
      );
    const captured: Record<string, unknown> = {};
    await (selected.beforeRun as (input: { evidence: Record<string, unknown> }) => Promise<void>)({
      evidence: captured,
    });
    expect(captured.regularBackendProfile).toBe("codex-cli");
  });
  it("requires CLI for every attempt under explicit CLI policy", async () => {
    const value = await regularEvidence("codex-cli");
    expect(() => assertRegularCompletion(value)).not.toThrow();
    for (const start of value.events.filter((event) => event.event === "AttemptStarted")) {
      const changed = structuredClone(value);
      changed.events.find(
        (event) => event.sequence === start.sequence && event.workItem === start.workItem,
      )!.backend = "codex-sdk/local-worktree";
      expect(() => assertRegularCompletion(changed)).toThrow(/backend selection/);
    }
    const relabelled = await regularEvidence();
    relabelled.regularBackendProfile = "codex-cli";
    expect(() => assertRegularCompletion(relabelled)).toThrow();
    const wrongDefault = await regularEvidence("codex-cli");
    wrongDefault.regularBackendProfile = "local-default";
    expect(() => assertRegularCompletion(wrongDefault)).toThrow(/policy changed/);
  });
  it("retains default SDK-first fallback authority without pretending SDK-only selection", async () => {
    const value = await regularEvidence("fallback-cli");
    expect(() => assertRegularCompletion(value)).not.toThrow();
    expect(value.policy.backendOrder).toEqual([
      "codex-sdk/local-worktree",
      "codex-cli/local-worktree",
    ]);
    expect(() =>
      assertQualificationCompletion(evidence(), "stacked-prs", ["codex-cli/local-worktree"]),
    ).toThrow(/unsupported qualification backend route/);
    expect(() =>
      assertQualificationCompletion(value, "regular-prs", ["codex-cli/daytona"]),
    ).toThrow(/unsupported qualification backend route/);
  });
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
  it("passes only genuinely concurrent regular delivery with exact candidate proof and leaves native API gate unchanged", async () => {
    const value = await regularEvidence();
    expect(() => assertRegularCompletion(value)).not.toThrow();
    expect(assessRegularCompletion(value).result).toBe("passed");
    expect(() =>
      assertQualificationCompletion(value, "stacked-prs", undefined, (proof, input) =>
        assertNativeMergeProof(value, proof, input),
      ),
    ).toThrow(/native delivery/);
    expect(() => assertRegularCompletion(evidence())).toThrow();
  });
  it("settles production model dispatch markers by invocation identity, not equal usage IDs", async () => {
    const value = await regularEvidence();
    const actual = value.events.find(
      (event) =>
        event.event === "BudgetReconciled" &&
        event.unit === "model_tokens" &&
        event.workItem === 2 &&
        event.phase === "management",
    )!;
    const modelInvocationId = "review-linked-invocation";
    actual.kind = "budget";
    actual.modelInvocationId = modelInvocationId;
    const marker: HarnessEvent = {
      ...actual,
      event: "BudgetReserved",
      amount: 0,
      usageId: `invocation-${modelInvocationId}`,
      sequence: actual.sequence - 1,
    };
    value.events.push(marker);
    expect(() => assertRegularCompletion(value)).not.toThrow();

    marker.sequence = actual.sequence + 1;
    expect(() => assertRegularCompletion(value)).toThrow(/model usage precedes dispatch intent/);
    marker.sequence = actual.sequence - 1;
    marker.policyDigest = "f".repeat(64);
    expect(() => assertRegularCompletion(value)).toThrow(/dispatch binding/);
  });
  it("does not let a non-model reservation evade settlement by carrying an invocation ID", async () => {
    const value = await regularEvidence();
    const attempt = value.events.find(
      (event) => event.event === "AttemptStarted" && event.workItem === 2,
    )!;
    const reservation: HarnessEvent = {
      ...attempt,
      kind: "budget",
      event: "BudgetReserved",
      sequence: attempt.sequence - 1,
      phase: "execution",
      unit: "local_milliseconds",
      amount: 1_000,
      modelInvocationId: "invalid-native-unit-marker",
      usageId: "unsettled-native-unit",
    };
    value.events.push(reservation);
    expect(() => assertRegularCompletion(value)).toThrow(/unreconciled BudgetReserved/);
  });
  it.each(["AttemptReserved", "AttemptStarted"])(
    "rejects delayed %s that contradicts its immutable reservation or loses root overlap",
    async (kind) => {
      const value = await regularEvidence();
      const next = value.events.find((event) => event.workItem === 3 && event.event === kind)!;
      next.sequence =
        value.events.find((event) => event.workItem === 2 && event.event === "AttemptSucceeded")!
          .sequence + 1;
      expect(() => assertRegularCompletion(value)).toThrow();
    },
  );
  it.each(["mode", "stackNumber", "parentItemId"])(
    "rejects hidden publication topology %s",
    async (field) => {
      const value = await regularEvidence();
      value.events.find((event) => event.event === "PublicationRecorded")![field] =
        field === "mode" ? "native-stacks" : field === "stackNumber" ? 90 : "parent";
      expect(() => assertRegularCompletion(value)).toThrow();
    },
  );
  it.each(["treeSha", "parents", "sha"])("rejects changed exact commit %s", async (field) => {
    const value = await regularEvidence();
    Object.assign(value.regularCommits[0]!, {
      [field]: field === "parents" ? ["e".repeat(40)] : "e".repeat(40),
    });
    expect(() => assertRegularCompletion(value)).toThrow();
  });
  it("rejects a native linkage receipt hidden beside an otherwise regular publication", async () => {
    const value = await regularEvidence();
    const publication = value.events.find((event) => event.event === "PublicationRecorded")!;
    value.events.push({
      ...publication,
      event: "StackLinked",
      sequence: publication.sequence + 1,
      stackNumber: 90,
    });
    expect(() => assertRegularCompletion(value)).toThrow(
      /regular publication has native stack linkage/,
    );
  });
  it.each(["exactHeadValidationDigest", "validationDigest", "baseSha"])(
    "rejects transplanted publication %s",
    async (field) => {
      const value = await regularEvidence();
      value.events.find((event) => event.event === "PublicationRecorded")![field] = "f".repeat(
        field === "baseSha" ? 40 : 64,
      );
      expect(() => assertRegularCompletion(value)).toThrow();
    },
  );
  it("rejects requested policy drift, unauthenticated closure and missing worker usage", async () => {
    const policy = await regularEvidence();
    policy.runRequest.arguments.objectiveNumber = 99;
    expect(() => assertRegularCompletion(policy)).toThrow(/request Objective/);
    const unauth = await regularEvidence();
    unauth.events.at(-1)!.authorId = 99;
    expect(() => assertRegularCompletion(unauth)).toThrow(/foreign receipt actor/);
    const missing = await regularEvidence();
    missing.events = missing.events.filter((event) => event.usageId !== "worker-2-1");
    expect(assessRegularCompletion(missing).result).toBe("incomplete");
  });
  it("accepts legitimate partial-order collision but rejects same-identity contradictions", async () => {
    const value = await regularEvidence();
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
    const value = await regularEvidence();
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
    value.mergeProofs[0]!.mergeSha = "other";
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
