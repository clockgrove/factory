import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { CompiledGraphStore } from "../src/control/graphs.js";
import { LeaseManager, type GitCommitObject, type LeaseStore } from "../src/control/lease.js";
import type { CompiledObjective } from "../src/graph.js";
import {
  CompilerDraftManager,
  canonicalDraftJson,
  draftDigest,
  loadCompilerDrafts,
  type CompilerDraftBinding,
  type CompilerDraftRecord,
} from "../src/control/compiler-drafts.js";
import {
  runCompilerDraftLoop,
  CompilerDraftStopError,
  repairableInvalidClaimsEvidence,
  type CompilerDraftCallbacks,
  type ValidatedCompilerDraft,
} from "../src/evaluation/compiler-draft-loop.js";
import { proposalFromCompiledFixture } from "./helpers/compiler-proposal.js";
import {
  createCompilerValidationReport,
  emptyCompilerValidationReport,
} from "../src/compiler/violations.js";
import { compiledGraphDigest } from "../src/graph.js";
import { compilerEvalDigest } from "../src/evaluation/compiler-eval.js";
import { compilerJudgeCandidateFromCompiled } from "../src/compiler/judge-context.js";
import { ManagementOutputError, type ManagementUsage } from "../src/management/backend.js";
import { CompilerInvariantError } from "../src/compiler/invariant-error.js";
import { classifyGitHubCopilotQuota } from "../src/providers/github-copilot-quota.js";
import { ProviderQuotaError } from "../src/providers/quota.js";
const BASE_SHA = "a".repeat(40);
const BASE_TREE = "b".repeat(40);

function repairableInventoryFailure(
  usage: ManagementUsage,
  proposal = { version: 1, obligations: [] },
) {
  return Object.assign(
    new ManagementOutputError(new Error("unknown obligation citation"), usage, proposal),
    { repairableInvalidClaims: repairableInvalidClaimsEvidence(proposal) },
  );
}

class MemoryGraphStore implements LeaseStore, CompiledGraphStore {
  now = new Date("2026-09-03T00:00:00.000Z");
  refs = new Map<string, string>();
  commits = new Map<string, GitCommitObject>();
  blobs = new Map<string, Buffer>();
  trees = new Map<string, Map<string, string>>();
  next = 1;

  constructor() {
    this.commits.set(BASE_SHA, {
      oid: BASE_SHA,
      treeOid: BASE_TREE,
      parentOids: [],
      message: "base",
      serverTime: this.now,
    });
    this.trees.set(BASE_TREE, new Map());
  }

  #oid(): string {
    return (this.next++).toString(16).padStart(40, "0");
  }

  async readRef(ref: string): Promise<string | null> {
    return this.refs.get(ref) ?? null;
  }

  async readCommit(oid: string): Promise<GitCommitObject> {
    const commit = this.commits.get(oid);
    if (!commit) throw new Error(`missing commit ${oid}`);
    return commit;
  }

  async createCommit(args: {
    treeOid: string;
    parentOids: string[];
    message: string;
  }): Promise<string> {
    const oid = this.#oid();
    this.commits.set(oid, {
      oid,
      treeOid: args.treeOid,
      parentOids: args.parentOids,
      message: args.message,
      serverTime: this.now,
    });
    return oid;
  }

  async createRef(ref: string, oid: string): Promise<boolean> {
    if (this.refs.has(ref)) return false;
    this.refs.set(ref, oid);
    return true;
  }

  async compareAndSwapRef(args: {
    ref: string;
    beforeOid: string;
    afterOid: string;
  }): Promise<boolean> {
    if (this.refs.get(args.ref) !== args.beforeOid) return false;
    this.refs.set(args.ref, args.afterOid);
    return true;
  }

  async serverTime(): Promise<Date> {
    return this.now;
  }

  async createBlob(content: Buffer): Promise<string> {
    const oid = createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
    this.blobs.set(oid, Buffer.from(content));
    return oid;
  }

  async readBlob(oid: string): Promise<Buffer> {
    const blob = this.blobs.get(oid);
    if (!blob) throw new Error(`missing blob ${oid}`);
    return Buffer.from(blob);
  }

  async createTree(args: {
    baseTreeOid?: string;
    entries: Array<{
      path: string;
      mode: "100644" | "100755" | "120000";
      type: "blob";
      sha: string | null;
    }>;
  }): Promise<string> {
    const tree = new Map(args.baseTreeOid ? (this.trees.get(args.baseTreeOid) ?? []) : []);
    for (const entry of args.entries) {
      if (entry.sha) tree.set(entry.path, entry.sha);
      else tree.delete(entry.path);
    }
    const oid = this.#oid();
    this.trees.set(oid, tree);
    return oid;
  }

  async readTreeEntry(treeOid: string, path: string): Promise<string | null> {
    return this.trees.get(treeOid)?.get(path) ?? null;
  }
}

function objective(goal = "Implement the feature."): CompiledObjective {
  return {
    deferredCapabilityAdapters: [],
    title: "Ship feature",
    workItems: [
      {
        id: "feature",
        title: "Implement feature",
        goal,
        acceptance: ["The feature is tested."],
        scope: ["src/feature.ts"],
        preconditions: [],
        outOfScope: [],
        conventions: [],
        dependsOn: [],
        baseSha: BASE_SHA,
        validationCommands: ["npm test"],
        requirements: {
          os: [],
          architecture: [],
          tools: [],
          services: [],
          networkDestinations: [],
          permittedSecretNames: [],
          trust: "trusted_local",
        },
        artifactContract: "clockgrove.factory/artifact",
      },
    ],
  };
}

function validatedObjective(graph: CompiledObjective): ValidatedCompilerDraft {
  const proposal = proposalFromCompiledFixture(
    {
      protocol: "clockgrove.factory/compiler-request",
      revision: 0,
      objective: {
        number: 42,
        title: graph.title,
        body: "Ship feature",
        digest: "d".repeat(64),
      },
      baseSha: BASE_SHA,
      inventory: {
        version: 1,
        objectiveDigest: "d".repeat(64),
        baseSha: BASE_SHA,
        evidence: [
          { id: "objective", kind: "objective", identity: "fixture", excerpt: "Ship feature" },
        ],
        obligations: [
          {
            id: "feature",
            text: "Ship feature",
            kind: "explicit",
            evidenceIds: ["objective"],
            acceptanceEvidence: "The feature is tested.",
          },
        ],
      },
      inventorySource: "independent-extraction",
      repository: {
        manifests: ["package.json"],
        requiredTools: [],
        validationRecipes: [
          {
            id: "npm-test",
            command: "npm test",
            adapterId: "npm",
            requiredTools: ["node", "npm"],
            networkDestinations: [],
          },
        ],
        toolchains: [],
        validationSurfaces: {
          deterministicSimulation: { count: 0, digest: compilerEvalDigest([]), sample: [] },
          visual: { count: 0, digest: compilerEvalDigest([]), sample: [] },
          python: { count: 0, digest: compilerEvalDigest([]), sample: [] },
          rust: { count: 0, digest: compilerEvalDigest([]), sample: [] },
          go: { count: 0, digest: compilerEvalDigest([]), sample: [] },
        },
        pathCount: 1,
      },
      constraints: {
        maxWorkItems: 100,
        planningWorkItemThreshold: 100,
        planningCriticalPathMinutes: 43_200,
        planningAggregateWorkMinutes: 432_000,
        maxDependenciesPerItem: 50,
        allowedNetworkDestinations: [],
        workItemTimeoutMinutes: 30,
      },
      previousProposal: null,
      validationReport: emptyCompilerValidationReport(),
      semanticFindings: [],
      challenges: [],
    },
    graph,
  );
  const graphDigest = compiledGraphDigest(graph);
  return {
    proposal,
    objective: graph,
    projectionTrace: {
      protocol: "clockgrove.factory/compiler-projection",
      requestDigest: "d".repeat(64),
      proposalDigest: draftDigest(proposal),
      graphDigest,
      addedEdges: [],
      adapterBindings: [],
      riskElevations: { count: 0, digest: compilerEvalDigest([]) },
    },
    report: emptyCompilerValidationReport(),
    requestDigest: "d".repeat(64),
  };
}

function validatedFixedObjective(graph: CompiledObjective): ValidatedCompilerDraft {
  const proposal = compilerJudgeCandidateFromCompiled(graph);
  const requestDigest = draftDigest({ fixedGraph: compiledGraphDigest(graph) });
  return {
    proposal,
    objective: graph,
    projectionTrace: {
      protocol: "clockgrove.factory/compiler-projection",
      requestDigest,
      proposalDigest: compilerEvalDigest(proposal),
      graphDigest: compiledGraphDigest(graph),
      addedEdges: [],
      adapterBindings: [],
      riskElevations: { count: 0, digest: compilerEvalDigest([]) },
    },
    report: emptyCompilerValidationReport(),
    requestDigest,
  };
}

async function setup() {
  const store = new MemoryGraphStore();
  const leases = new LeaseManager({ store });
  const binding: CompilerDraftBinding = {
    repository: "owner/repo",
    objective: 42,
    runId: "draft-run",
    policyDigest: "p".repeat(64),
    baseSha: BASE_SHA,
    inputDigest: "d".repeat(64),
  };
  const lease = await leases.acquire(
    { objective: 42, runId: binding.runId, policyDigest: binding.policyDigest, holder: "director" },
    await store.readCommit(BASE_SHA),
  );
  const manager = new CompilerDraftManager(store, leases);
  const callbacks: CompilerDraftCallbacks = {
    invoke: vi.fn(async (request, checkpoint) => {
      const result = {
        value:
          request.stage === "inventory"
            ? { obligations: ["a"] }
            : request.stage === "judge"
              ? { accepted: request.revision === 1 }
              : objective(`revision ${request.revision}`),
        usage: { inputTokens: 2, outputTokens: 1 },
      };
      await checkpoint(result);
      return result;
    }),
    recordUsage: vi.fn(async () => {}),
    validateInventory: (value) => value,
    validate: (value) => {
      if (!value || typeof value !== "object" || !("workItems" in value))
        throw new Error("malformed graph");
      return validatedObjective(value as CompiledObjective);
    },
    accept: (value) => (value as { accepted: boolean }).accepted,
  };
  return { store, leases, manager, lease, binding, callbacks };
}
describe("compiler draft durable repair", () => {
  it("leaves exact provider quota usage attached for the Supervisor's atomic gate batch", async () => {
    const args = await setup();
    const gate = classifyGitHubCopilotQuota("You have exceeded your monthly quota")!;
    let observed: ProviderQuotaError | undefined;
    args.callbacks.invoke = async (request, _checkpoint, _reserve, checkpointProviderRefusal) => {
      const error = new ProviderQuotaError(gate, {
        invocationId: request.invocationId,
        usage: { inputTokens: 2, outputTokens: 1 },
      });
      await checkpointProviderRefusal!(error);
      throw error;
    };

    try {
      await runCompilerDraftLoop(args);
    } catch (error) {
      if (error instanceof ProviderQuotaError) observed = error;
      else throw error;
    }

    expect(observed).toMatchObject({
      invocationId: expect.any(String),
      usage: { inputTokens: 2, outputTokens: 1 },
    });
    expect(args.callbacks.recordUsage).not.toHaveBeenCalled();
    expect(
      (await args.manager.load(args.binding)).find((record) => record.kind === "result")?.payload,
    ).toMatchObject({
      invocationId: observed!.invocationId,
      usage: { inputTokens: 2, outputTokens: 1 },
      providerQuota: gate,
    });

    const replayInvoke = vi.fn(args.callbacks.invoke);
    args.callbacks.invoke = replayInvoke;
    let recovered: ProviderQuotaError | undefined;
    try {
      await runCompilerDraftLoop(args);
    } catch (error) {
      if (error instanceof ProviderQuotaError) recovered = error;
      else throw error;
    }
    expect(replayInvoke).not.toHaveBeenCalled();
    expect(recovered).not.toBe(observed);
    expect(recovered).toMatchObject({
      gate,
      invocationId: observed!.invocationId,
      usage: { inputTokens: 2, outputTokens: 1 },
    });
    expect(args.callbacks.recordUsage).not.toHaveBeenCalled();
  });

  it("reconstructs unknown provider quota metadata without replay or invented usage", async () => {
    const args = await setup();
    const gate = classifyGitHubCopilotQuota("You have exceeded your monthly quota")!;
    args.callbacks.invoke = async (request) => {
      throw new ProviderQuotaError(gate, { invocationId: request.invocationId });
    };

    await expect(runCompilerDraftLoop(args)).rejects.toMatchObject({
      gate,
      invocationId: expect.any(String),
      usage: undefined,
    });
    const replayInvoke = vi.fn(args.callbacks.invoke);
    args.callbacks.invoke = replayInvoke;
    await expect(runCompilerDraftLoop(args)).rejects.toMatchObject({
      gate,
      invocationId: expect.any(String),
      usage: undefined,
    });
    expect(replayInvoke).not.toHaveBeenCalled();
    expect(args.callbacks.recordUsage).not.toHaveBeenCalled();
  });

  it("uses valid canonical JSON and binds read-only evidence to one run", async () => {
    expect(JSON.parse(canonicalDraftJson({ z: [1, null], a: { b: true } }))).toEqual({
      z: [1, null],
      a: { b: true },
    });
    const args = await setup();
    const outcome = await runCompilerDraftLoop(args);
    expect(outcome.status).toBe("accepted");
    expect(outcome.records.filter((r) => r.kind === "selection")).toHaveLength(1);
    expect(await loadCompilerDrafts(args.store, 42, args.binding.runId)).toEqual(outcome.records);
    await expect(
      args.manager.load({ ...args.binding, inputDigest: "e".repeat(64) }),
    ).rejects.toThrow("inputs changed");
  });
  it("reuses terminal checkpoints and rechecks exact acceptance without paid replay", async () => {
    const args = await setup();
    const first = await runCompilerDraftLoop(args);
    const calls = vi.mocked(args.callbacks.invoke).mock.calls.length;
    expect((await runCompilerDraftLoop(args)).status).toBe("accepted");
    expect(vi.mocked(args.callbacks.invoke)).toHaveBeenCalledTimes(calls);
    expect(first.records.filter((r) => r.kind === "result")).toHaveLength(5);
    args.callbacks.accept = () => false;
    await expect(runCompilerDraftLoop(args)).rejects.toThrow("acceptance no longer validates");
  });
  it("never repeats an uncertain admitted invocation after restart", async () => {
    const args = await setup();
    await args.manager.append(args.lease, args.binding, 0, "started", {
      limits: {
        maxRepairs: 2,
        maxInvocations: 7,
        maxObservedTokens: Number.MAX_SAFE_INTEGER,
        deadlineMs: 600000,
      },
      startedAt: Date.now(),
      sourceEvidenceDigest: draftDigest(null),
      fixedGraphDigest: null,
      adapterMode: "local",
    });
    // A crash after admission but before the terminal checkpoint is not evidence of no usage.
    const invoke = args.callbacks.invoke;
    args.callbacks.invoke = async () => {
      throw new Error("transport unknown");
    };
    const result = await runCompilerDraftLoop(args);
    expect(result).toMatchObject({ status: "stopped", reason: "accounting-unavailable" });
    args.callbacks.invoke = invoke;
    expect((await runCompilerDraftLoop(args)).status).toBe("stopped");
    expect(invoke).not.toHaveBeenCalled();
  });
  it("refuses a reservation without a terminal checkpoint on restart", async () => {
    const args = await setup();
    await args.manager.append(args.lease, args.binding, 0, "started", {
      limits: {
        maxRepairs: 2,
        maxInvocations: 7,
        maxObservedTokens: Number.MAX_SAFE_INTEGER,
        deadlineMs: 600000,
      },
      startedAt: Date.now(),
      sourceEvidenceDigest: draftDigest(null),
      fixedGraphDigest: null,
      adapterMode: "local",
    });
    const invocationId = `compiler-${draftDigest({ binding: args.binding, stage: "inventory", revision: 0 })}`;
    await args.manager.append(args.lease, args.binding, 1, "invocation", {
      startedAt: Date.now(),
      invocationId,
      stage: "inventory",
      revision: 0,
      inputDigest: draftDigest({
        inventory: null,
        previous: null,
        projection: null,
        failure: null,
      }),
    });
    expect(await runCompilerDraftLoop(args)).toMatchObject({
      status: "stopped",
      reason: "uncertain-invocation-accounting",
    });
    expect(args.callbacks.invoke).not.toHaveBeenCalled();
  });
  it("refuses a second caller's identical invocation reservation", async () => {
    const args = await setup();
    await args.manager.append(args.lease, args.binding, 0, "started", {});
    await args.manager.append(args.lease, args.binding, 1, "invocation", { invocationId: "one" });
    await expect(
      args.manager.append(args.lease, args.binding, 1, "invocation", { invocationId: "one" }),
    ).rejects.toThrow("already reserved");
  });
  it("consumes malformed repairs and preserves failures through exhaustion", async () => {
    const args = await setup();
    args.callbacks.invoke = vi.fn(async (request) => ({
      value:
        request.stage === "inventory"
          ? {}
          : request.stage === "compile"
            ? objective()
            : request.stage === "judge"
              ? { accepted: false }
              : null,
      usage: { inputTokens: 2, outputTokens: 1 },
    }));
    const result = await runCompilerDraftLoop(args);
    expect(result).toMatchObject({ status: "stopped", reason: "repair-limit-unresolved" });
    expect(
      result.records.filter((r) => r.kind === "invocation" && r.payload.stage === "repair"),
    ).toHaveLength(2);
    expect(
      result.records.filter((r) => r.kind === "validation" && r.payload.valid === false),
    ).toHaveLength(2);
  });
  it("repairs from the latest schema-valid proposal after its mechanical validation fails", async () => {
    const args = await setup();
    const initialGraph = objective("initial proposal");
    const initialProposal = validatedObjective(initialGraph).proposal;
    if (initialProposal.protocol !== "clockgrove.factory/compiler-proposal")
      throw new Error("fixture proposal protocol differs");
    const mechanicallyInvalid = structuredClone(initialProposal);
    mechanicallyInvalid.workItems[0]!.title = "Latest mechanically invalid proposal";
    const mechanicalReport = createCompilerValidationReport("proposal", [
      {
        code: "unknown-dependency",
        itemId: mechanicallyInvalid.workItems[0]!.id,
        field: "/workItems/0/dependsOn",
        expected: [],
        observed: "missing",
      },
    ]);
    const secondRepair = vi.fn();
    args.callbacks.invoke = vi.fn(async (request) => {
      const usage = { inputTokens: 2, outputTokens: 1 };
      if (request.stage === "inventory") return { value: { obligations: ["a"] }, usage };
      if (request.stage === "compile") return { value: initialGraph, usage };
      if (request.stage === "judge") return { value: { accepted: request.revision === 2 }, usage };
      if (request.revision === 1) {
        expect(request.previous).toEqual(initialProposal);
        return { value: { proposal: mechanicallyInvalid }, usage };
      }
      secondRepair(request);
      expect(request.previous).toEqual(mechanicallyInvalid);
      expect(request.failure).toEqual({
        error: "mechanical projection violation",
        proposal: mechanicallyInvalid,
        validationReport: mechanicalReport,
      });
      return { value: objective("second repair"), usage };
    });
    args.callbacks.validate = (value, revision) => {
      if (revision === 1)
        throw Object.assign(new Error("mechanical projection violation"), {
          proposal: mechanicallyInvalid,
          validationReport: mechanicalReport,
        });
      return validatedObjective(value as CompiledObjective);
    };
    args.callbacks.accept = (value) => (value as { accepted: boolean }).accepted;

    expect(await runCompilerDraftLoop(args)).toMatchObject({ status: "accepted", revision: 2 });
    expect(secondRepair).toHaveBeenCalledOnce();
  });
  it("retains an invalid planning proposal as exact repair and replay evidence", async () => {
    const args = await setup();
    const planningProposal = {
      protocol: "clockgrove.factory/compiler-proposal" as const,
      kind: "clarification" as const,
      requirements: [
        {
          id: "target",
          question: "TBD",
          reason: "placeholder",
          obligationIds: ["a"],
        },
      ],
      triggers: [
        {
          code: "independent-milestones" as const,
          source: "obligation-inventory" as const,
          availability: "observed" as const,
          observed: "TBD",
          threshold: null,
          obligationIds: ["a"],
          explanation: "placeholder",
        },
      ],
    };
    const report = createCompilerValidationReport("proposal", [
      {
        code: "invalid-clarification",
        itemId: null,
        field: "/requirements/0",
        expected: "a concrete clarification",
        observed: planningProposal.requirements[0]!.question,
      },
    ]);
    const invoke = vi.fn(async (request: Parameters<CompilerDraftCallbacks["invoke"]>[0]) => {
      const usage = { inputTokens: 2, outputTokens: 1 };
      if (request.stage === "inventory") return { value: { obligations: ["a"] }, usage };
      if (request.stage === "compile") return { value: { proposal: planningProposal }, usage };
      expect(request.stage).toBe("repair");
      expect(request.previous).toEqual(planningProposal);
      return { value: { proposal: planningProposal }, usage };
    });
    args.callbacks.invoke = invoke;
    args.callbacks.validate = (_value, revision) => {
      if (revision === 0)
        throw Object.assign(new Error("clarification is not concrete"), {
          proposal: planningProposal,
          validationReport: report,
        });
      throw new CompilerDraftStopError("planning-repair-observed");
    };

    expect(await runCompilerDraftLoop(args)).toMatchObject({
      status: "stopped",
      reason: "planning-repair-observed",
    });
    expect(invoke.mock.calls.filter(([request]) => request.stage === "repair")).toHaveLength(1);
    const callCount = invoke.mock.calls.length;
    expect(await runCompilerDraftLoop(args)).toMatchObject({
      status: "stopped",
      reason: "planning-repair-observed",
    });
    expect(invoke).toHaveBeenCalledTimes(callCount);
  });
  it("terminates a Factory projection invariant without persisting failure or buying repair", async () => {
    const args = await setup();
    const invariant = new CompilerInvariantError("economic projection assertion");
    args.callbacks.validate = vi.fn(() => {
      throw invariant;
    });

    await expect(runCompilerDraftLoop(args)).rejects.toBe(invariant);
    expect(args.callbacks.recordUsage).toHaveBeenCalledTimes(2);
    await expect(runCompilerDraftLoop(args)).rejects.toBe(invariant);

    const invocations = (await args.manager.load(args.binding)).filter(
      (record) => record.kind === "invocation",
    );
    expect(invocations.map((record) => record.payload.stage)).toEqual(["inventory", "compile"]);
    expect(args.callbacks.invoke).toHaveBeenCalledTimes(2);
    expect(args.callbacks.recordUsage).toHaveBeenCalledTimes(4);
    expect(args.callbacks.validate).toHaveBeenCalledTimes(2);
    expect(
      (await args.manager.load(args.binding)).some((record) => record.kind === "validation"),
    ).toBe(false);
  });
  it("repairs a known-accounted invalid inventory and replays its valid successor", async () => {
    const args = await setup();
    const invoke = vi.fn(async (request: Parameters<CompilerDraftCallbacks["invoke"]>[0]) => {
      const usage = { inputTokens: 2, outputTokens: 1 };
      if (request.stage === "inventory" && request.revision === 0)
        throw repairableInventoryFailure(usage);
      return {
        value:
          request.stage === "inventory"
            ? { obligations: ["grounded"] }
            : request.stage === "judge"
              ? { accepted: request.revision === 1 }
              : objective(`revision ${request.revision}`),
        usage,
      };
    });
    args.callbacks.invoke = invoke;

    const result = await runCompilerDraftLoop(args);
    expect(result.status).toBe("accepted");
    expect(
      invoke.mock.calls
        .map(([request]) => request)
        .filter((request) => request.stage === "inventory")
        .map((request) => ({ revision: request.revision, failure: request.failure })),
    ).toEqual([
      { revision: 0, failure: null },
      {
        revision: 1,
        failure: {
          error: "unknown obligation citation",
          proposal: { version: 1, obligations: [] },
        },
      },
    ]);
    expect(result.records.filter((record) => record.kind === "invocation")).toHaveLength(6);
    expect(args.callbacks.recordUsage).toHaveBeenCalledTimes(6);

    const calls = invoke.mock.calls.length;
    expect((await runCompilerDraftLoop(args)).status).toBe("accepted");
    expect(invoke).toHaveBeenCalledTimes(calls);
  });

  it("shares repair capacity between inventory regeneration and graph correction", async () => {
    const args = await setup();
    args.callbacks.invoke = vi.fn(async (request) => {
      const usage = { inputTokens: 2, outputTokens: 1 };
      if (request.stage === "inventory" && request.revision === 0)
        throw repairableInventoryFailure(usage);
      return {
        value:
          request.stage === "inventory"
            ? {}
            : request.stage === "judge"
              ? { accepted: false }
              : objective(`revision ${request.revision}`),
        usage,
      };
    });

    const result = await runCompilerDraftLoop(args);
    expect(result).toMatchObject({ status: "stopped", reason: "repair-limit-unresolved" });
    expect(
      result.records.filter(
        (record) => record.kind === "invocation" && record.payload.stage === "inventory",
      ),
    ).toHaveLength(2);
    expect(
      result.records.filter(
        (record) => record.kind === "invocation" && record.payload.stage === "repair",
      ),
    ).toHaveLength(1);
  });

  it.each([
    { maxRepairs: 0, attempts: 1 },
    { maxRepairs: 2, attempts: 3 },
  ])("stops invalid inventory after its shared repair allowance %#", async (limits) => {
    const args = await setup();
    args.callbacks.invoke = vi.fn(async (request) => {
      if (request.stage !== "inventory") throw new Error("unexpected graph invocation");
      throw repairableInventoryFailure({ inputTokens: 2, outputTokens: 1 });
    });

    const result = await runCompilerDraftLoop({
      ...args,
      limits: { maxRepairs: limits.maxRepairs },
    });
    expect(result).toMatchObject({
      status: "stopped",
      reason: "invalid-inventory: unknown obligation citation",
    });
    expect(args.callbacks.invoke).toHaveBeenCalledTimes(limits.attempts);
    expect(args.callbacks.recordUsage).toHaveBeenCalledTimes(limits.attempts);
  });

  it("resumes at the next inventory revision after a completed failed result", async () => {
    const args = await setup();
    const limits = {
      maxRepairs: 2,
      maxInvocations: 7,
      maxObservedTokens: Number.MAX_SAFE_INTEGER,
      deadlineMs: 600_000,
    };
    await args.manager.append(args.lease, args.binding, 0, "started", {
      limits,
      startedAt: Date.now(),
      sourceEvidenceDigest: draftDigest(null),
      fixedGraphDigest: null,
      adapterMode: "local",
    });
    const invocationId = `compiler-${draftDigest({
      binding: args.binding,
      stage: "inventory",
      revision: 0,
    })}`;
    const startedAt = Date.now();
    const inputDigest = draftDigest({
      inventory: null,
      previous: null,
      projection: null,
      failure: null,
    });
    const expectedProvenance = {
      promptDigest: inputDigest,
      schemaDigest: draftDigest({
        protocol: "clockgrove.factory/local-draft-callback",
        stage: "inventory",
      }),
      baseSha: args.binding.baseSha,
      model: null,
      reasoning: null,
    };
    await args.manager.append(args.lease, args.binding, 1, "invocation", {
      startedAt,
      invocationId,
      stage: "inventory",
      revision: 0,
      inputDigest,
      expectedProvenance,
    });
    await args.manager.append(args.lease, args.binding, 2, "result", {
      invocationId,
      stage: "inventory",
      revision: 0,
      value: null,
      usage: { inputTokens: 2, outputTokens: 1 },
      error: "unknown obligation citation",
      proposal: { version: 1, obligations: [] },
      repairableInvalidClaims: repairableInvalidClaimsEvidence({ version: 1, obligations: [] }),
      completedAt: startedAt,
      observedMilliseconds: 0,
      provenance: expectedProvenance,
    });
    const invoke = vi.mocked(args.callbacks.invoke);

    expect((await runCompilerDraftLoop(args)).status).toBe("accepted");
    expect(
      invoke.mock.calls
        .map(([request]) => request)
        .filter((request) => request.stage === "inventory")
        .map((request) => request.revision),
    ).toEqual([1]);
    expect(args.callbacks.recordUsage).toHaveBeenCalledWith(
      invocationId,
      "inventory",
      expect.objectContaining({ inputTokens: 2, outputTokens: 1 }),
    );
  });
  it.each([
    { limits: { maxRepairs: 2, maxInvocations: 1 }, reason: "invocation-limit" },
    { limits: { maxRepairs: 2, maxObservedTokens: 3 }, reason: "observed-token-limit" },
  ])("checks $reason before dispatching an inventory retry", async ({ limits, reason }) => {
    const args = await setup();
    args.callbacks.invoke = vi.fn(async () => {
      throw repairableInventoryFailure({ inputTokens: 2, outputTokens: 1 });
    });

    expect(await runCompilerDraftLoop({ ...args, limits })).toMatchObject({
      status: "stopped",
      reason,
    });
    expect(args.callbacks.invoke).toHaveBeenCalledOnce();
    expect(args.callbacks.recordUsage).toHaveBeenCalledOnce();
  });

  it("checks the durable deadline before dispatching an inventory retry", async () => {
    const args = await setup();
    let now = 0;
    args.callbacks.invoke = vi.fn(async () => {
      throw repairableInventoryFailure({ inputTokens: 2, outputTokens: 1 });
    });

    expect(
      await runCompilerDraftLoop({
        ...args,
        startedAt: 0,
        now: () => (now += 100),
        limits: { maxRepairs: 2, deadlineMs: 250 },
      }),
    ).toMatchObject({ status: "stopped", reason: "deadline-exhausted" });
    expect(args.callbacks.invoke).toHaveBeenCalledOnce();
  });
  it("does not retry a known-accounted management process failure, including restart", async () => {
    const args = await setup();
    const proposal = { version: 1, obligations: [] };
    const invoke = vi.fn(async () => {
      throw new ManagementOutputError(
        new Error("Codex CLI process exited unsuccessfully"),
        { inputTokens: 2, outputTokens: 1 },
        proposal,
      );
    });
    args.callbacks.invoke = invoke;

    expect(await runCompilerDraftLoop(args)).toMatchObject({
      status: "stopped",
      reason: "invalid-inventory: Codex CLI process exited unsuccessfully",
    });
    expect(invoke).toHaveBeenCalledOnce();
    expect(args.callbacks.recordUsage).toHaveBeenCalledOnce();
    expect(
      (await args.manager.load(args.binding)).find((record) => record.kind === "result")?.payload,
    ).not.toHaveProperty("repairableInvalidClaims");

    const replayInvoke = vi.fn(async () => {
      throw new Error("restart must not dispatch");
    });
    args.callbacks.invoke = replayInvoke;
    expect(await runCompilerDraftLoop(args)).toMatchObject({
      status: "stopped",
      reason: "invalid-inventory: Codex CLI process exited unsuccessfully",
    });
    expect(replayInvoke).not.toHaveBeenCalled();
  });
  it("detects unchanged graph cycles and enforces observed usage and deadline", async () => {
    const args = await setup();
    args.callbacks.invoke = vi.fn(async (request) => ({
      value:
        request.stage === "inventory"
          ? {}
          : request.stage === "judge"
            ? { accepted: false }
            : objective(),
      usage: { inputTokens: 2, outputTokens: 1 },
    }));
    expect(await runCompilerDraftLoop(args)).toMatchObject({
      status: "stopped",
      reason: "draft-cycle",
    });
    const limited = await setup();
    expect(
      await runCompilerDraftLoop({ ...limited, limits: { maxObservedTokens: 0 } }),
    ).toMatchObject({ status: "stopped", reason: "observed-token-limit" });
    expect(limited.callbacks.invoke).not.toHaveBeenCalled();
    const expired = await setup();
    let now = 0;
    expect(
      await runCompilerDraftLoop({ ...expired, now: () => now++, limits: { deadlineMs: 1 } }),
    ).toMatchObject({ status: "stopped", reason: "deadline-exhausted" });
  });
  it("retains checkpoint despite a later provider return failure", async () => {
    const args = await setup();
    const delegate = args.callbacks.invoke;
    args.callbacks.invoke = async (request, checkpoint) => {
      await delegate(request, checkpoint);
      throw new Error("after terminal");
    };
    expect((await runCompilerDraftLoop(args)).status).toBe("accepted");
  });
  it.each(["compile", "judge"])(
    "stops on %s accounting persistence failure and resumes known output",
    async (stage) => {
      const args = await setup();
      const recordUsage = args.callbacks.recordUsage;
      args.callbacks.recordUsage = async (id, phase, usage) => {
        if (phase === stage) throw new Error("ledger unavailable");
        await recordUsage(id, phase, usage);
      };
      await expect(runCompilerDraftLoop(args)).rejects.toThrow("accounting reconciliation failed");
      const records = await args.manager.load(args.binding);
      expect(records.at(-1)).toMatchObject({
        kind: "accounting-failure",
        payload: { stage, error: "ledger unavailable" },
      });
      const completed = records.filter((r) => r.kind === "result");
      expect(completed.at(-1)?.payload.stage).toBe(stage);
      expect(records.some((r) => r.kind === "selection")).toBe(false);
      const failure = records.at(-1)!;
      const failedJournal = structuredClone(records);
      const callsAfterFirstFailure = vi.mocked(args.callbacks.invoke).mock.calls.length;

      await expect(runCompilerDraftLoop(args)).rejects.toThrow("accounting reconciliation failed");
      expect(await args.manager.load(args.binding)).toEqual(failedJournal);
      expect(vi.mocked(args.callbacks.invoke)).toHaveBeenCalledTimes(callsAfterFirstFailure);

      args.callbacks.recordUsage = recordUsage;
      const resumed = await runCompilerDraftLoop(args);
      expect(resumed.status).toBe("accepted");
      expect(
        resumed.records.filter(
          (record) =>
            record.kind === "accounting-failure" &&
            record.payload.invocationId === failure.payload.invocationId &&
            record.payload.stage === stage,
        ),
      ).toHaveLength(1);
      expect(resumed.records).toContainEqual(
        expect.objectContaining({
          kind: "accounting-reconciled",
          payload: expect.objectContaining({
            invocationId: failure.payload.invocationId,
            stage,
            failureSequence: failure.sequence,
          }),
        }),
      );
      expect(
        vi
          .mocked(args.callbacks.invoke)
          .mock.calls.filter(([request]) => request.stage === stage && request.revision === 0),
      ).toHaveLength(1);
    },
  );
  it("rejects contradictory output after a terminal checkpoint", async () => {
    const args = await setup();
    const delegate = args.callbacks.invoke;
    args.callbacks.invoke = async (request, checkpoint) => {
      const result = await delegate(request, checkpoint);
      return { ...result, value: { contradictory: true } };
    };
    expect(await runCompilerDraftLoop(args)).toMatchObject({
      status: "stopped",
      reason: "conflicting-terminal-output",
    });
    expect((await args.manager.load(args.binding)).some((r) => r.kind === "selection")).toBe(false);
  });
  it("stops on explicit judge abstention without consuming a repair", async () => {
    const args = await setup();
    args.callbacks.accept = () => {
      throw new CompilerDraftStopError("material-ambiguity");
    };
    expect(await runCompilerDraftLoop(args)).toMatchObject({
      status: "stopped",
      reason: "material-ambiguity",
    });
    expect(
      vi.mocked(args.callbacks.invoke).mock.calls.some(([request]) => request.stage === "repair"),
    ).toBe(false);
  });
  it("detects unchanged rooted findings despite cosmetic finding identifiers", async () => {
    const args = await setup();
    const invoke = args.callbacks.invoke;
    args.callbacks.invoke = async (request, checkpoint) =>
      request.stage === "judge"
        ? {
            value: {
              accepted: false,
              findings: [
                {
                  id: `finding-${request.revision}`,
                  severity: "blocking",
                  dimension: "coverage",
                  obligationIds: ["a"],
                  itemIds: ["feature"],
                  evidenceIds: ["objective"],
                },
              ],
            },
            usage: { inputTokens: 2, outputTokens: 1 },
          }
        : invoke(request, checkpoint);
    expect(await runCompilerDraftLoop(args)).toMatchObject({
      status: "stopped",
      reason: "unchanged-blockers",
    });
    expect(
      vi.mocked(invoke).mock.calls.filter(([request]) => request.stage === "repair"),
    ).toHaveLength(1);
  });
  it("judges a fixed historical graph after inventory without fabricated compilation usage", async () => {
    const args = await setup();
    const graph = objective();
    const calls: string[] = [];
    args.callbacks.invoke = vi.fn(async (request) => {
      calls.push(request.stage);
      return {
        value: request.stage === "inventory" ? { obligations: ["a"] } : { accepted: true },
        usage: { inputTokens: 2, outputTokens: 1 },
      };
    });
    args.callbacks.validate = (value) =>
      validatedFixedObjective((value as { fixedGraph: CompiledObjective }).fixedGraph);
    const fixed = {
      ...args,
      fixedGraph: graph,
      sourceEvidence: { objective: "Original request", sources: ["pinned source"] },
      limits: { maxRepairs: 0 },
    };
    const result = await runCompilerDraftLoop(fixed);
    expect(result.status).toBe("accepted");
    expect(calls).toEqual(["inventory", "judge"]);
    expect(result.records.slice(0, 3).map((record) => record.kind)).toEqual([
      "started",
      "source-evidence",
      "fixed-graph",
    ]);
    expect(result.records[0]?.payload).toMatchObject({
      fixedGraphDigest: compiledGraphDigest(graph),
      sourceEvidenceDigest: draftDigest(fixed.sourceEvidence),
    });
    expect(result.records[1]?.payload).toMatchObject({ sourceEvidence: fixed.sourceEvidence });
    expect(result.records[2]?.payload).toMatchObject({ fixedGraph: graph });
    expect(result.records.filter((item) => item.kind === "result")).toHaveLength(2);
    expect((await runCompilerDraftLoop(fixed)).status).toBe("accepted");
    expect(calls).toEqual(["inventory", "judge"]);
    await expect(
      runCompilerDraftLoop({ ...fixed, fixedGraph: objective("changed") }),
    ).rejects.toThrow("policy changed");
    await expect(
      runCompilerDraftLoop({ ...fixed, sourceEvidence: { objective: "changed" } }),
    ).rejects.toThrow("policy changed");
    await expect(runCompilerDraftLoop({ ...fixed, limits: { maxRepairs: 1 } })).rejects.toThrow(
      "zero repairs",
    );
  });
  it("journals maximum fixed-graph and source evidence in separate restart-safe records", async () => {
    const args = await setup();
    const seed = objective().workItems[0]!;
    const graph: CompiledObjective = {
      ...objective(),
      workItems: Array.from({ length: 100 }, (_, index) => ({
        ...structuredClone(seed),
        id: `item-${index + 1}`,
        title: `Item ${index + 1}`,
        goal: `${index}:` + "g".repeat(3_990),
        scope: [`src/item-${index + 1}.ts`],
        preconditions: Array.from(
          { length: 6 },
          (_, condition) => `${index}:${condition}:` + "p".repeat(1_985),
        ),
      })),
    };
    const sourceEvidence = {
      objective: { number: 404, title: "T", body: "b".repeat(370_000) },
      evidence: Array.from({ length: 127 }, (_, index) => ({
        id: `e-${index}`,
        kind: index < 94 ? "objective" : "repository",
        identity: `identity-${index}`,
        excerpt: "e".repeat(3_990),
      })),
      modelSelection: null,
    };
    args.callbacks.invoke = vi.fn(async (request) => ({
      value: request.stage === "inventory" ? { obligations: ["a"] } : { accepted: true },
      usage: { inputTokens: 2, outputTokens: 1 },
    }));
    args.callbacks.validate = (value) =>
      validatedFixedObjective((value as { fixedGraph: CompiledObjective }).fixedGraph);
    const fixed = {
      ...args,
      fixedGraph: graph,
      sourceEvidence,
      limits: { maxRepairs: 0 },
    };
    const result = await runCompilerDraftLoop(fixed);
    expect(result.status).toBe("accepted");
    const started = result.records.find((record) => record.kind === "started")!;
    const source = result.records.find((record) => record.kind === "source-evidence")!;
    const persistedGraph = result.records.find((record) => record.kind === "fixed-graph")!;
    expect(Buffer.byteLength(canonicalDraftJson(started))).toBeLessThan(2 * 1024 * 1024);
    expect(Buffer.byteLength(canonicalDraftJson(source))).toBeLessThan(2 * 1024 * 1024);
    expect(Buffer.byteLength(canonicalDraftJson(persistedGraph))).toBeGreaterThan(1_500_000);
    expect(
      Buffer.byteLength(
        canonicalDraftJson({
          ...started,
          payload: { ...started.payload, fixedGraph: graph, sourceEvidence },
        }),
      ),
    ).toBeGreaterThan(2 * 1024 * 1024);
    expect((await runCompilerDraftLoop(fixed)).status).toBe("accepted");
    await expect(
      runCompilerDraftLoop({ ...fixed, sourceEvidence: { ...sourceEvidence, modelSelection: {} } }),
    ).rejects.toThrow("policy changed");
  });
  it("reconciles known usage before stopping contradictory checkpoints", async () => {
    const args = await setup();
    const delegate = args.callbacks.invoke;
    args.callbacks.invoke = async (request, checkpoint) => {
      const result = await delegate(request, checkpoint);
      return { ...result, value: { contradictory: true } };
    };
    expect(await runCompilerDraftLoop(args)).toMatchObject({
      status: "stopped",
      reason: "conflicting-terminal-output",
    });
    expect(args.callbacks.recordUsage).toHaveBeenCalledTimes(1);
    expect(vi.mocked(args.callbacks.recordUsage).mock.calls[0]?.[2]).toEqual({
      inputTokens: 2,
      outputTokens: 1,
    });
  });
  it("remembers contradictory output when accounting reconciliation also fails", async () => {
    const args = await setup();
    const delegate = args.callbacks.invoke;
    const account = args.callbacks.recordUsage;
    args.callbacks.invoke = async (request, checkpoint) => {
      const result = await delegate(request, checkpoint);
      return { ...result, value: { contradictory: true } };
    };
    args.callbacks.recordUsage = async () => {
      throw new Error("ledger unavailable");
    };
    await expect(runCompilerDraftLoop(args)).rejects.toThrow("accounting reconciliation failed");
    args.callbacks.recordUsage = account;
    expect(await runCompilerDraftLoop(args)).toMatchObject({
      status: "stopped",
      reason: "conflicting-terminal-output",
    });
    expect(vi.mocked(delegate)).toHaveBeenCalledTimes(1);
  });
  it("never reconciles disputed usage after a crash following the durable conflict marker", async () => {
    const args = await setup();
    const delegate = args.callbacks.invoke;
    args.callbacks.invoke = async (request, checkpoint) => {
      const result = await delegate(request, checkpoint);
      return { ...result, usage: { inputTokens: 900, outputTokens: 800 } };
    };
    const append = args.manager.append.bind(args.manager);
    const crash = vi.spyOn(args.manager, "append").mockImplementation(async (...params) => {
      if (params[3] === "stopped") throw new Error("process unavailable");
      const record = await append(...params);
      if (params[3] === "terminal-conflict") throw new Error("crash after durable conflict");
      return record;
    });
    await expect(runCompilerDraftLoop(args)).rejects.toThrow("process unavailable");
    expect((await args.manager.load(args.binding)).some((r) => r.kind === "stopped")).toBe(false);
    expect(
      (await args.manager.load(args.binding)).some((r) => r.kind === "terminal-conflict"),
    ).toBe(true);
    expect(args.callbacks.recordUsage).not.toHaveBeenCalled();
    crash.mockRestore();
    expect(await runCompilerDraftLoop(args)).toMatchObject({
      status: "stopped",
      reason: "conflicting-terminal-accounting",
    });
    expect(args.callbacks.recordUsage).not.toHaveBeenCalled();
    expect(vi.mocked(delegate)).toHaveBeenCalledTimes(1);
  });
  it("refuses secrets before Git blob creation and sanitizes diagnostic evidence", async () => {
    const args = await setup();
    const fakeSecret = `ghp_${"x".repeat(30)}`;
    const blobs = vi.spyOn(args.store, "createBlob");
    await expect(
      args.manager.append(args.lease, args.binding, 0, "started", { secret: fakeSecret }),
    ).rejects.toThrow("suspected GitHub token");
    expect(blobs).not.toHaveBeenCalled();
    args.callbacks.invoke = async () => {
      throw Object.assign(new Error(`provider failed ${fakeSecret}`), {
        usage: { inputTokens: 2, outputTokens: 1 },
        proposal: { secret: fakeSecret },
      });
    };
    const result = await runCompilerDraftLoop(args);
    expect(result.status).toBe("stopped");
    expect(JSON.stringify(result.records)).not.toContain(fakeSecret);
    expect(result.records.find((item) => item.kind === "result")?.payload).toMatchObject({
      error: "diagnostic withheld: suspected secret material",
      proposalUnavailable: "unsafe or oversized proposal",
      usage: { inputTokens: 2, outputTokens: 1 },
    });
  });
  it("records local invocation intervals once, including rejected output", async () => {
    const args = await setup();
    let time = 100;
    args.callbacks.invoke = async (request) => {
      time += 25;
      if (request.stage === "compile")
        throw Object.assign(new Error("invalid result"), {
          usage: { inputTokens: 2, outputTokens: 1 },
        });
      return { value: { obligations: ["a"] }, usage: { inputTokens: 2, outputTokens: 1 } };
    };
    const result = await runCompilerDraftLoop({
      ...args,
      now: () => time++,
      limits: { maxRepairs: 0 },
    });
    for (const record of result.records.filter((item) => item.kind === "result")) {
      const reserved = result.records.find(
        (item) =>
          item.kind === "invocation" && item.payload.invocationId === record.payload.invocationId,
      )!;
      expect(record.payload.completedAt).toBeTypeOf("number");
      expect(record.payload.observedMilliseconds).toBe(
        Number(record.payload.completedAt) - Number(reserved.payload.startedAt),
      );
      expect(Number(record.payload.observedMilliseconds)).toBeGreaterThanOrEqual(25);
    }
    expect(result.records.filter((item) => item.kind === "result")).toHaveLength(2);
    expect(
      (await runCompilerDraftLoop({ ...args, now: () => 999, limits: { maxRepairs: 0 } })).records,
    ).toEqual(result.records);
  });
  it("includes source gathering in the durable deadline and never refreshes start on replay", async () => {
    const args = await setup();
    const options = { ...args, startedAt: 100, now: () => 300, limits: { deadlineMs: 100 } };
    const result = await runCompilerDraftLoop(options);
    expect(result).toMatchObject({ status: "stopped", reason: "deadline-exhausted" });
    expect(args.callbacks.invoke).not.toHaveBeenCalled();
    expect(result.records[0]?.payload.startedAt).toBe(100);
    expect(
      (await runCompilerDraftLoop({ ...options, startedAt: 299 })).records[0]?.payload.startedAt,
    ).toBe(100);
    const invalid = await setup();
    await expect(runCompilerDraftLoop({ ...invalid, startedAt: -1 })).rejects.toThrow();
    expect(invalid.callbacks.invoke).not.toHaveBeenCalled();
    await expect(
      runCompilerDraftLoop({ ...invalid, now: () => Number.POSITIVE_INFINITY }),
    ).rejects.toThrow();
  });
  it("fences conflicting records and writes after selection", async () => {
    const args = await setup();
    const result = await runCompilerDraftLoop(args);
    await expect(
      args.manager.append(args.lease, args.binding, 0, "started", { other: true }),
    ).rejects.toThrow("conflicting immutable");
    await expect(
      args.manager.append(args.lease, args.binding, result.records.length, "validation", {}),
    ).rejects.toThrow("append is fenced");
    await expect(
      args.manager.append(
        { ...args.lease, runId: "other" },
        args.binding,
        result.records.length,
        "validation",
        {},
      ),
    ).rejects.toThrow();
  });

  it.each([
    { name: "foreign result", linkedJudge: false },
    { name: "linked judge-first result", linkedJudge: true },
  ])("rejects a forged $name before usage replay", async ({ linkedJudge }) => {
    const args = await setup();
    const limits = {
      maxRepairs: 2,
      maxInvocations: 7,
      maxObservedTokens: Number.MAX_SAFE_INTEGER,
      deadlineMs: 600_000,
    };
    const startedAt = 100;
    const records: Array<Record<string, unknown>> = [
      {
        protocol: "clockgrove.factory/compiler-draft",
        binding: args.binding,
        sequence: 0,
        kind: "started",
        payload: {
          limits,
          startedAt,
          sourceEvidenceDigest: draftDigest(null),
          fixedGraphDigest: null,
          adapterMode: "local",
        },
      },
    ];
    const invocationId = linkedJudge
      ? `compiler-${draftDigest({ binding: args.binding, stage: "judge", revision: 2 })}`
      : "foreign";
    const provenance = {
      promptDigest: "1".repeat(64),
      schemaDigest: "2".repeat(64),
      baseSha: args.binding.baseSha,
      model: "fixture-model",
      reasoning: "low",
    };
    if (linkedJudge)
      records.push({
        protocol: "clockgrove.factory/compiler-draft",
        binding: args.binding,
        sequence: 1,
        kind: "invocation",
        payload: {
          invocationId,
          stage: "judge",
          revision: 2,
          inputDigest: "3".repeat(64),
          expectedProvenance: provenance,
          startedAt,
        },
      });
    records.push({
      protocol: "clockgrove.factory/compiler-draft",
      binding: args.binding,
      sequence: records.length,
      kind: "result",
      payload: {
        invocationId,
        stage: "judge",
        revision: 2,
        value: { accepted: true },
        usage: { inputTokens: 123, outputTokens: 45 },
        provenance,
        completedAt: startedAt,
        observedMilliseconds: 0,
      },
    });
    const recordUsage = vi.fn(async () => {});

    await expect(
      runCompilerDraftLoop({
        binding: args.binding,
        lease: args.lease,
        manager: {
          load: async () => structuredClone(records),
          append: async () => {
            throw new Error("must not append");
          },
        } as unknown as CompilerDraftManager,
        callbacks: { ...args.callbacks, recordUsage },
      }),
    ).rejects.toThrow(linkedJudge ? /precedes inventory/ : /binding mismatch/);
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it("rejects a provider-entered result without reserved provenance before usage replay", async () => {
    const args = await setup();
    const limits = {
      maxRepairs: 2,
      maxInvocations: 7,
      maxObservedTokens: Number.MAX_SAFE_INTEGER,
      deadlineMs: 600_000,
    };
    const invocationId = `compiler-${draftDigest({
      binding: args.binding,
      stage: "inventory",
      revision: 0,
    })}`;
    const startedAt = 100;
    const records = [
      {
        protocol: "clockgrove.factory/compiler-draft" as const,
        binding: args.binding,
        sequence: 0,
        kind: "started" as const,
        payload: {
          limits,
          startedAt,
          sourceEvidenceDigest: draftDigest(null),
          fixedGraphDigest: null,
          adapterMode: "local",
        },
      },
      {
        protocol: "clockgrove.factory/compiler-draft" as const,
        binding: args.binding,
        sequence: 1,
        kind: "invocation" as const,
        payload: {
          invocationId,
          stage: "inventory",
          revision: 0,
          inputDigest: draftDigest({
            inventory: null,
            previous: null,
            projection: null,
            failure: null,
          }),
          startedAt,
        },
      },
      {
        protocol: "clockgrove.factory/compiler-draft" as const,
        binding: args.binding,
        sequence: 2,
        kind: "result" as const,
        payload: {
          invocationId,
          stage: "inventory",
          revision: 0,
          value: { obligations: [] },
          usage: { inputTokens: 7, outputTokens: 3 },
          completedAt: startedAt,
          observedMilliseconds: 0,
        },
      },
    ];
    const recordUsage = vi.fn(async () => {});

    await expect(
      runCompilerDraftLoop({
        binding: args.binding,
        lease: args.lease,
        manager: {
          load: async () => structuredClone(records),
          append: async () => {
            throw new Error("must not append");
          },
        } as unknown as CompilerDraftManager,
        callbacks: { ...args.callbacks, recordUsage },
      }),
    ).rejects.toThrow(/provenance differs/);
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "missing reserved request digest",
      intent: {},
      value: {},
      proposalDigest: "3".repeat(64),
      error: /reserved request binding/,
      claimLocalDigest: false,
    },
    {
      name: "forged local callback mode",
      intent: {},
      value: {},
      proposalDigest: "3".repeat(64),
      error: /reserved request binding/,
      claimLocalDigest: true,
    },
    {
      name: "missing persisted request provenance",
      intent: { compilerRequestDigest: "4".repeat(64) },
      value: {},
      proposalDigest: "3".repeat(64),
      error: /request binding differs/,
      claimLocalDigest: false,
    },
    {
      name: "forged validation proposal digest",
      intent: { compilerRequestDigest: "4".repeat(64) },
      value: {
        request: { revision: 0 },
        proposal: { protocol: "clockgrove.factory/compiler-proposal" },
        provenance: { requestDigest: "4".repeat(64) },
      },
      proposalDigest: "3".repeat(64),
      error: /validation proposal binding differs/,
      claimLocalDigest: false,
    },
  ])("rejects provider journal with $name before replay effects", async (fixture) => {
    const args = await setup();
    const limits = {
      maxRepairs: 2,
      maxInvocations: 7,
      maxObservedTokens: Number.MAX_SAFE_INTEGER,
      deadlineMs: 600_000,
    };
    const provenance = {
      promptDigest: "1".repeat(64),
      schemaDigest: "2".repeat(64),
      baseSha: args.binding.baseSha,
      model: "fixture-model",
      reasoning: "low",
    };
    const inventory = { obligations: ["a"] };
    const compileProvenance = fixture.claimLocalDigest
      ? {
          ...provenance,
          schemaDigest: draftDigest({
            protocol: "clockgrove.factory/local-draft-callback",
            stage: "compile",
          }),
        }
      : provenance;
    const requestDigest =
      fixture.name === "forged validation proposal digest"
        ? draftDigest((fixture.value as { request: unknown }).request)
        : "4".repeat(64);
    const compileIntent = {
      ...fixture.intent,
      ...(fixture.name === "forged validation proposal digest"
        ? { compilerRequestDigest: requestDigest }
        : {}),
    };
    const compileValue = structuredClone(fixture.value);
    if (fixture.name === "forged validation proposal digest") {
      (compileValue as { provenance: { requestDigest: string } }).provenance.requestDigest =
        requestDigest;
      (compileValue as { proposal: unknown }).proposal = validatedObjective(objective()).proposal;
    }
    const invocationId = (stage: string, revision: number) =>
      `compiler-${draftDigest({ binding: args.binding, stage, revision })}`;
    const records: CompilerDraftRecord[] = [
      {
        protocol: "clockgrove.factory/compiler-draft",
        binding: args.binding,
        sequence: 0,
        kind: "started",
        payload: {
          limits,
          startedAt: 100,
          sourceEvidenceDigest: draftDigest(null),
          fixedGraphDigest: null,
          adapterMode: "provider",
        },
      },
      {
        protocol: "clockgrove.factory/compiler-draft",
        binding: args.binding,
        sequence: 1,
        kind: "invocation",
        payload: {
          invocationId: invocationId("inventory", 0),
          stage: "inventory",
          revision: 0,
          inputDigest: draftDigest({
            inventory: null,
            previous: null,
            projection: null,
            failure: null,
          }),
          expectedProvenance: provenance,
          startedAt: 100,
        },
      },
      {
        protocol: "clockgrove.factory/compiler-draft",
        binding: args.binding,
        sequence: 2,
        kind: "result",
        payload: {
          invocationId: invocationId("inventory", 0),
          stage: "inventory",
          revision: 0,
          value: inventory,
          usage: { inputTokens: 7, outputTokens: 3 },
          terminalOutcome: {
            state: "succeeded",
            usage: { inputTokens: 7, outputTokens: 3 },
          },
          provenance,
          completedAt: 100,
          observedMilliseconds: 0,
        },
      },
      {
        protocol: "clockgrove.factory/compiler-draft",
        binding: args.binding,
        sequence: 3,
        kind: "invocation",
        payload: {
          invocationId: invocationId("compile", 0),
          stage: "compile",
          revision: 0,
          inputDigest: draftDigest({
            inventory,
            previous: null,
            projection: null,
            failure: null,
          }),
          expectedProvenance: compileProvenance,
          startedAt: 100,
          ...compileIntent,
        },
      },
      {
        protocol: "clockgrove.factory/compiler-draft",
        binding: args.binding,
        sequence: 4,
        kind: "result",
        payload: {
          invocationId: invocationId("compile", 0),
          stage: "compile",
          revision: 0,
          value: compileValue,
          usage: { inputTokens: 11, outputTokens: 5 },
          terminalOutcome: {
            state: "succeeded",
            usage: { inputTokens: 11, outputTokens: 5 },
          },
          provenance: compileProvenance,
          completedAt: 100,
          observedMilliseconds: 0,
        },
      },
      {
        protocol: "clockgrove.factory/compiler-draft",
        binding: args.binding,
        sequence: 5,
        kind: "validation",
        payload: {
          revision: 0,
          valid: true,
          graphDigest: "5".repeat(64),
          proposalDigest: fixture.proposalDigest,
          requestDigest,
          traceDigest: draftDigest({
            proposalDigest: fixture.proposalDigest,
            requestDigest,
            graphDigest: "5".repeat(64),
          }),
          projectionTrace: {
            proposalDigest: fixture.proposalDigest,
            requestDigest,
            graphDigest: "5".repeat(64),
          },
          resultDigest: draftDigest(compileValue),
        },
      },
    ];
    const recordUsage = vi.fn(async () => {});
    const validate = vi.fn(args.callbacks.validate);
    await expect(
      runCompilerDraftLoop({
        binding: args.binding,
        lease: args.lease,
        manager: {
          load: async () => structuredClone(records),
          append: async () => {
            throw new Error("must not append");
          },
        } as unknown as CompilerDraftManager,
        callbacks: {
          ...args.callbacks,
          reserveAtDispatch: true,
          recordUsage,
          validate,
        },
      }),
    ).rejects.toThrow(fixture.error);
    expect(recordUsage).not.toHaveBeenCalled();
    expect(validate).not.toHaveBeenCalled();
  });

  it.each(["selection-review-evidence", "unresolved-accounting"] as const)(
    "rejects terminal journal with %s before replay effects",
    async (fault) => {
      const args = await setup();
      const first = await runCompilerDraftLoop(args);
      const records = structuredClone(first.records);
      const selectionIndex = records.findIndex((record) => record.kind === "selection");
      if (selectionIndex < 0) throw new Error("fixture selection missing");
      if (fault === "selection-review-evidence") {
        records[selectionIndex]!.payload.reviewEvidence = [{ forged: true }];
      } else {
        const result = records.find(
          (record) => record.kind === "result" && record.payload.usage !== null,
        )!;
        records.splice(selectionIndex, 0, {
          protocol: "clockgrove.factory/compiler-draft",
          binding: args.binding,
          sequence: selectionIndex,
          kind: "accounting-failure",
          payload: {
            invocationId: result.payload.invocationId,
            stage: result.payload.stage,
            error: "accounting unavailable",
          },
        });
        for (let index = selectionIndex + 1; index < records.length; index++)
          records[index]!.sequence = index;
      }
      const recordUsage = vi.fn(async () => {});
      const validate = vi.fn(args.callbacks.validate);
      await expect(
        runCompilerDraftLoop({
          ...args,
          manager: {
            load: async () => structuredClone(records),
            append: async () => {
              throw new Error("must not append");
            },
          } as unknown as CompilerDraftManager,
          callbacks: { ...args.callbacks, recordUsage, validate },
        }),
      ).rejects.toThrow(
        fault === "selection-review-evidence"
          ? /selection durable bindings differ/
          : /unresolved accounting failure/,
      );
      expect(recordUsage).not.toHaveBeenCalled();
      expect(validate).not.toHaveBeenCalled();
    },
  );

  it("rejects an invocation tail while prior usage reconciliation is unresolved", async () => {
    const args = await setup();
    const first = await runCompilerDraftLoop(args);
    const records = structuredClone(first.records);
    const resultIndex = records.findIndex(
      (record) => record.kind === "result" && record.payload.stage === "inventory",
    );
    const result = records[resultIndex]!;
    const nextInvocationIndex = records.findIndex(
      (record, index) => index > resultIndex && record.kind === "invocation",
    );
    if (result.kind !== "result" || nextInvocationIndex < 0)
      throw new Error("fixture accounting boundary missing");
    records.splice(nextInvocationIndex, 0, {
      protocol: "clockgrove.factory/compiler-draft",
      binding: args.binding,
      sequence: nextInvocationIndex,
      kind: "accounting-failure",
      payload: {
        invocationId: result.payload.invocationId,
        stage: result.payload.stage,
        error: "accounting unavailable",
      },
    });
    for (let index = nextInvocationIndex + 1; index < records.length; index++)
      records[index]!.sequence = index;
    const append = vi.fn(async () => {
      throw new Error("must not append");
    });
    const recordUsage = vi.fn(async () => {});
    const validate = vi.fn(args.callbacks.validate);

    await expect(
      runCompilerDraftLoop({
        ...args,
        manager: {
          load: async () => structuredClone(records),
          append,
        } as unknown as CompilerDraftManager,
        callbacks: { ...args.callbacks, recordUsage, validate },
      }),
    ).rejects.toThrow(/unresolved accounting failure before progression/);
    expect(append).not.toHaveBeenCalled();
    expect(recordUsage).not.toHaveBeenCalled();
    expect(validate).not.toHaveBeenCalled();
  });
});
