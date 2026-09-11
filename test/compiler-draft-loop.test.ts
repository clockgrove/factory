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
} from "../src/control/compiler-drafts.js";
import {
  runCompilerDraftLoop,
  CompilerDraftStopError,
  type CompilerDraftCallbacks,
} from "../src/evaluation/compiler-draft-loop.js";
import { classifyGitHubCopilotQuota } from "../src/providers/github-copilot-quota.js";
import { ProviderQuotaError } from "../src/providers/quota.js";
const BASE_SHA = "a".repeat(40);
const BASE_TREE = "b".repeat(40);

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
        artifactContract: "clockgrove.factory/artifact-v1",
      },
    ],
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
      return value as CompiledObjective;
    },
    accept: (value) => (value as { accepted: boolean }).accepted,
  };
  return { store, leases, manager, lease, binding, callbacks };
}
describe("compiler draft durable repair", () => {
  it("marks exact provider quota usage as recorded before propagating the gate", async () => {
    const args = await setup();
    const gate = classifyGitHubCopilotQuota("You have exceeded your monthly quota")!;
    let observed: ProviderQuotaError | undefined;
    args.callbacks.invoke = async (request) => {
      throw new ProviderQuotaError(gate, {
        invocationId: request.invocationId,
        usage: { inputTokens: 2, outputTokens: 1 },
      });
    };

    try {
      await runCompilerDraftLoop(args);
    } catch (error) {
      if (error instanceof ProviderQuotaError) observed = error;
      else throw error;
    }

    expect(observed).toMatchObject({ usageRecorded: true });
    expect(args.callbacks.recordUsage).toHaveBeenCalledExactlyOnceWith(
      observed!.invocationId,
      "inventory",
      observed!.usage,
    );
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
    });
    const invocationId = `compiler-${draftDigest({ binding: args.binding, stage: "inventory", revision: 0 })}`;
    await args.manager.append(args.lease, args.binding, 1, "invocation", {
      invocationId,
      stage: "inventory",
      revision: 0,
      inputDigest: draftDigest({ inventory: null, previous: null, failure: null }),
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
      args.callbacks.recordUsage = recordUsage;
      expect((await runCompilerDraftLoop(args)).status).toBe("accepted");
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
    args.callbacks.validate = (value) => (value as { objective: CompiledObjective }).objective;
    const fixed = {
      ...args,
      fixedGraph: graph,
      sourceEvidence: { objective: "Original request", sources: ["pinned source"] },
      limits: { maxRepairs: 0 },
    };
    const result = await runCompilerDraftLoop(fixed);
    expect(result.status).toBe("accepted");
    expect(calls).toEqual(["inventory", "judge"]);
    expect(result.records[0]?.payload).toMatchObject({
      fixedGraph: graph,
      sourceEvidence: fixed.sourceEvidence,
    });
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
});
