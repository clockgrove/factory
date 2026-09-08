import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompiledGraphManager, type CompiledGraphStore } from "../src/control/graphs.js";
import { LeaseManager, type GitCommitObject, type LeaseStore } from "../src/control/lease.js";
import { CompilerDraftManager } from "../src/control/compiler-drafts.js";
import { compileEvaluatedDraft } from "../src/management/draft-compilation.js";
import {
  CodexCliManagementBackend,
  compilerObligationEvidence,
} from "../src/management/codex-cli.js";
import type { CompilationContext } from "../src/management/backend.js";
import { DEFAULT_RUN_POLICY, policyDigest } from "../src/protocol/policy.js";
import {
  COMPILER_JUDGE_DIMENSIONS,
  compilerEvalDigest,
  type CompilerJudgeVerdict,
  type ObligationInventory,
} from "../src/evaluation/compiler-eval.js";
import type { CompiledObjective } from "../src/graph.js";
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

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
function proposal(repaired = false) {
  const criterion = repaired
    ? "Feature handles positive and negative values."
    : "Feature handles positive values.";
  return {
    title: "Test",
    workItems: [
      {
        id: "feature",
        title: "Implement feature",
        goal: "Implement feature",
        acceptance: [criterion],
        criterionRisks: [{ criterion, risk: "ordinary" }],
        scope: ["src/feature.ts"],
        preconditions: [],
        outOfScope: [],
        conventions: [],
        dependsOn: [],
        baseSha: BASE_SHA,
        validationCommands: ["npm test"],
        validation: [
          {
            tier: "semantic",
            criteria: [criterion],
            rationale: "Review changed behavior",
            evidenceCommands: [],
          },
        ],
        requirements: {
          os: ["linux"],
          architecture: ["x64"],
          cpu: 1,
          memoryMb: 2048,
          diskMb: 1024,
          timeoutMinutes: 30,
          estimatedDurationMinutes: 10,
          tools: ["node", "npm"],
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
async function setup(
  options: {
    malformedRepair?: boolean;
    rejectAll?: boolean;
    missingAccounting?: boolean;
    reportOnly?: boolean;
    abstain?: boolean;
  } = {},
) {
  const repository = await mkdtemp(join(tmpdir(), "factory-draft-integration-"));
  temporary.push(repository);
  await writeFile(
    join(repository, "package.json"),
    JSON.stringify({ scripts: { test: "node --test" } }),
  );
  const context: CompilationContext = {
    repository,
    objective: { number: 42, title: "Test", body: "Implement positive and negative values." },
    defaultBranch: "main",
    baseSha: BASE_SHA,
    repositoryFiles: ["package.json", "src/feature.ts"],
    allowedNetworkDestinations: [],
    runPolicy: {
      ...DEFAULT_RUN_POLICY,
      compilerEvaluation: { mode: options.reportOnly ? "report-only" : "auto-repair" },
    },
  };
  context.repositoryEvidence = compilerObligationEvidence(context);
  const inventory: ObligationInventory = {
    version: 1,
    objectiveDigest: compilerEvalDigest(context.objective),
    baseSha: BASE_SHA,
    evidence: context.repositoryEvidence,
    obligations: [
      {
        id: "values",
        text: context.objective.body,
        kind: "explicit",
        evidenceIds: ["objective"],
        acceptanceEvidence: "Both positive and negative cases are verified",
      },
    ],
  };
  const stages: string[] = [];
  const prompts: string[] = [];
  let repairs = 0;
  const runStructured = vi.fn(async (_cwd: string, _schema: unknown, prompt: string) => {
    prompts.push(prompt);
    const usage = { inputTokens: 11, outputTokens: 3, cachedInputTokens: 4 };
    if (prompt.includes("independent obligation extractor")) {
      stages.push("inventory");
      expect(prompt).not.toContain('"workItems"');
      return { value: inventory, usage };
    }
    if (prompt.includes("independent compiler judge")) {
      stages.push("judge");
      const source = JSON.parse(prompt.split("\n\n").at(-1)!) as {
        graph: CompiledObjective;
        draftDigest: string;
        inventoryDigest: string;
      };
      const accept = repairs > 0 && !options.rejectAll;
      const verdict: CompilerJudgeVerdict = {
        version: 1,
        rubricVersion: 1,
        draftDigest: source.draftDigest,
        inventoryDigest: source.inventoryDigest,
        coverage: [
          {
            obligationId: "values",
            status: accept ? "covered" : "partial",
            itemIds: ["feature"],
            acceptanceBindings: [
              { itemId: "feature", criterion: source.graph.workItems[0]!.acceptance[0]! },
            ],
            evidenceIds: ["objective"],
            reason: accept ? "Both cases specified" : "Negative case missing",
          },
        ],
        items: [
          {
            itemId: "feature",
            granularity: "cohesive",
            reason: "One behavior",
            evidenceIds: ["objective"],
          },
        ],
        dimensions: COMPILER_JUDGE_DIMENSIONS.map((dimension) => ({
          dimension,
          status: "assessed",
          reason: "Reviewed pinned evidence",
          evidenceIds: ["objective"],
        })),
        dependencies: [],
        findings: accept
          ? []
          : [
              {
                id: "missing-negative",
                severity: "blocking",
                dimension: "coverage",
                obligationIds: ["values"],
                itemIds: ["feature"],
                evidenceIds: ["objective"],
                rootCause: "Negative values missing",
                correction: "Include negative behavior",
                confidence: 0.95,
                uncertainty: "",
              },
            ],
        uncertainty: [],
        decision: options.abstain ? "abstain" : accept ? "accept" : "repair",
      };
      return { value: verdict, usage };
    }
    if (prompt.includes("Repair the draft")) {
      stages.push("repair");
      repairs++;
      if (options.malformedRepair) return { value: { malformed: "preserve this proposal" }, usage };
      return {
        value: {
          objective: proposal(true),
          summary: {
            changeSummary: "Cover negative behavior",
            lineage: [{ itemId: "feature", previousItemIds: ["feature"] }],
            findingDispositions: [
              {
                findingId: "missing-negative",
                disposition: "addressed",
                reason: "Added behavior",
                evidenceIds: ["objective"],
              },
            ],
          },
        },
        usage,
      };
    }
    stages.push("compile");
    if (options.missingAccounting) throw new Error("transport outcome unknown");
    return { value: proposal(), usage };
  });
  const backend = new CodexCliManagementBackend({ runStructured });
  const store = new MemoryGraphStore();
  const leases = new LeaseManager({ store });
  const pd = policyDigest(context.runPolicy);
  const lease = await leases.acquire(
    { objective: 42, runId: "integrated", holder: "director", policyDigest: pd },
    await store.readCommit(BASE_SHA),
  );
  const manager = new CompilerDraftManager(store, leases);
  const accounting = new Map<string, unknown>();
  const admit = vi.fn(async (_invocationId: string) => {});
  const args = {
    context,
    backend,
    manager,
    lease,
    binding: {
      repository: "owner/repo",
      objective: 42,
      runId: lease.runId,
      policyDigest: pd,
      baseSha: BASE_SHA,
      inputDigest: compilerEvalDigest(context.objective),
    },
    admit,
    recordUsage: vi.fn(async (id: string, _stage: string, usage: unknown) => {
      const prior = accounting.get(id);
      if (prior) expect(prior).toEqual(usage);
      accounting.set(id, usage);
    }),
    assertInputs: vi.fn(async () => {}),
    validate: vi.fn(async () => {}),
    deadlineAt: Date.now() + 600000,
  };
  return { args, stages, prompts, runStructured, accounting, store, leases };
}
describe("production compiler draft adapter", () => {
  it("extracts obligations first, grounds every revision, accounts phases and commits only accepted selection", async () => {
    const f = await setup();
    const graphs = new CompiledGraphManager(f.store, f.leases);
    const result = await compileEvaluatedDraft(f.args);
    expect(
      result.status,
      JSON.stringify(result.records.filter((r) => r.payload.error || r.kind === "validation")),
    ).toBe("accepted");
    expect(f.stages).toEqual(["inventory", "compile", "judge", "repair", "judge"]);
    expect(f.args.validate).toHaveBeenCalledTimes(2);
    expect(f.accounting.size).toBe(5);
    expect(f.args.admit.mock.calls).toHaveLength(5);
    expect(new Set(f.args.admit.mock.calls.map((call) => call[0])).size).toBe(5);
    expect(await graphs.load(42, f.args.lease.runId)).toBeNull();
    if (result.status !== "accepted") throw new Error("accepted graph required");
    expect(result.records.at(-1)?.kind).toBe("selection");
    const args = {
      lease: f.args.lease,
      base: await f.store.readCommit(BASE_SHA),
      objective: result.graph,
    };
    const saved = await graphs.persist(args);
    expect((await graphs.persist(args)).commitOid).toBe(saved.commitOid);
    const invocationCount = f.runStructured.mock.calls.length;
    expect((await compileEvaluatedDraft(f.args)).status).toBe("accepted");
    expect(f.runStructured).toHaveBeenCalledTimes(invocationCount);
    expect(f.accounting.size).toBe(5);
    expect(
      result.records.filter((r) => r.kind === "result" && r.payload.stage === "compile")[0]?.payload
        .value,
    ).toMatchObject({ provenance: { rawProposal: proposal(), baseSha: BASE_SHA } });
  });
  it("never produces accepted projection authority for report-only rejected plans", async () => {
    const f = await setup({ reportOnly: true });
    const result = await compileEvaluatedDraft(f.args);
    expect(result.status).toBe("stopped");
    expect(f.stages).toEqual(["inventory", "compile", "judge"]);
    expect(result.records.some((r) => r.kind === "selection")).toBe(false);
    expect(
      await new CompiledGraphManager(f.store, f.leases).load(42, f.args.lease.runId),
    ).toBeNull();
  });
  it("retains malformed repair proposal and observed usage through bounded retries", async () => {
    const f = await setup({ malformedRepair: true });
    const result = await compileEvaluatedDraft(f.args);
    expect(result.status).toBe("stopped");
    expect(f.stages.filter((stage) => stage === "repair")).toHaveLength(2);
    expect(f.accounting.size).toBe(5);
    expect(
      result.records.filter((r) => r.kind === "result" && r.payload.stage === "repair"),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          payload: expect.objectContaining({
            proposal: { malformed: "preserve this proposal" },
            usage: { inputTokens: 11, outputTokens: 3, cachedInputTokens: 4 },
          }),
        }),
      ]),
    );
  });
  it("stops material ambiguity at the first judge without speculative repair", async () => {
    const f = await setup({ abstain: true });
    const result = await compileEvaluatedDraft(f.args);
    expect(result).toMatchObject({
      status: "stopped",
      reason: "judge cannot resolve material ambiguity",
    });
    expect(f.stages).toEqual(["inventory", "compile", "judge"]);
  });
  it("does not replay provider work with unknown terminal accounting", async () => {
    const f = await setup({ missingAccounting: true });
    const result = await compileEvaluatedDraft(f.args);
    expect(result).toMatchObject({ status: "stopped", reason: "accounting-unavailable" });
    expect(f.stages).toEqual(["inventory", "compile"]);
    const count = f.runStructured.mock.calls.length;
    expect((await compileEvaluatedDraft(f.args)).status).toBe("stopped");
    expect(f.runStructured).toHaveBeenCalledTimes(count);
  });
});
