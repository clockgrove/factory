import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompiledGraphManager, type CompiledGraphStore } from "../src/control/graphs.js";
import { LeaseManager, type GitCommitObject, type LeaseStore } from "../src/control/lease.js";
import { CompilerDraftManager, draftDigest } from "../src/control/compiler-drafts.js";
import {
  assertCompilerDraftSelection,
  compileEvaluatedDraft,
} from "../src/management/draft-compilation.js";
import {
  CodexCliManagementBackend,
  compilerObligationEvidence,
} from "../src/management/codex-cli.js";
import {
  EMPTY_REPOSITORY_CAPTURE_PLANNING,
  type CompilationContext,
} from "../src/management/backend.js";
import { DEFAULT_RUN_POLICY, policyDigest } from "../src/protocol/policy.js";
import {
  COMPILER_JUDGE_DIMENSIONS,
  compilerEvalDigest,
  type CompilerJudgeVerdict,
  type ObligationInventory,
} from "../src/evaluation/compiler-eval.js";
import type { CompilerRequest } from "../src/compiler/contracts.js";
import { CompilerInvariantError } from "../src/compiler/invariant-error.js";
import { validatePersistedCompilerDraftJournal } from "../src/evaluation/compiler-draft-loop.js";
import { pinFixtureRepository } from "./helpers/compiler-proposal.js";
const BASE_SHA = "a".repeat(40);
const BASE_TREE = "b".repeat(40);

class MemoryGraphStore implements LeaseStore, CompiledGraphStore {
  now = new Date("2026-09-03T00:00:00.000Z");
  refs = new Map<string, string>();
  commits = new Map<string, GitCommitObject>();
  blobs = new Map<string, Buffer>();
  trees = new Map<string, Map<string, string>>();
  next = 1;

  constructor(baseSha = BASE_SHA) {
    this.commits.set(baseSha, {
      oid: baseSha,
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
function proposal(request: CompilerRequest, repaired = false) {
  const criterion = repaired
    ? "Feature handles positive and negative values."
    : "Feature handles positive values.";
  const recipe = request.repository.validationRecipes[0]!;
  return {
    protocol: "clockgrove.factory/compiler-proposal" as const,
    kind: "work-items" as const,
    mediaIntents: [],
    workItems: [
      {
        id: "feature",
        title: "Implement feature",
        goal: "Implement feature",
        obligationIds: ["values"],
        criteria: [
          {
            id: "values-work",
            text: criterion,
            risk: "ordinary" as const,
            validation: [
              {
                tier: "mechanical" as const,
                evidence: [{ kind: "observed" as const, recipeId: recipe.id }],
              },
            ],
          },
        ],
        scope: ["src/feature.ts"],
        preconditions: [],
        outOfScope: [],
        conventions: [],
        dependsOn: [],
        exclusiveResources: [],
        executionIntent: {
          estimatedDurationMinutes: 10,
          additionalTools: [],
          services: [],
          additionalNetworkDestinations: [],
          trust: "isolated",
        },
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
    advisoryOnlyRepair?: boolean;
    invalidInventoryOnce?: boolean;
    unsafeInventory?: boolean;
    mechanicallyInvalidFirst?: boolean;
    schemaInvalidFirst?: boolean;
    acceptFirst?: boolean;
    invalidAcceptUnknownFirst?: boolean;
    primitiveCompileFailure?: "string" | "null";
    frozenCompileFailure?: "error" | "object";
  } = {},
) {
  const repository = await mkdtemp(join(tmpdir(), "factory-draft-integration-"));
  temporary.push(repository);
  await writeFile(
    join(repository, "package.json"),
    JSON.stringify({ scripts: { test: "node --test" } }),
  );
  await writeFile(
    join(repository, "package-lock.json"),
    JSON.stringify({ name: "draft-integration-fixture", lockfileVersion: 3, packages: {} }),
  );
  const baseSha = pinFixtureRepository(repository);
  const context: CompilationContext = {
    repository,
    objective: { number: 42, title: "Test", body: "Implement positive and negative values." },
    defaultBranch: "main",
    baseSha,
    repositoryFiles: ["package-lock.json", "package.json", "src/feature.ts"],
    allowedNetworkDestinations: [],
    runPolicy: {
      ...DEFAULT_RUN_POLICY,
      allowedNetworkDestinations: [],
      compilerEvaluation: { mode: options.reportOnly ? "report-only" : "auto-repair" },
    },
    repositoryCapturePlanning: EMPTY_REPOSITORY_CAPTURE_PLANNING,
  };
  context.repositoryEvidence = compilerObligationEvidence(context);
  const inventory: ObligationInventory = {
    version: 1,
    objectiveDigest: compilerEvalDigest(context.objective),
    baseSha,
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
  const claims = { version: 1 as const, obligations: inventory.obligations };
  const stages: string[] = [];
  const prompts: string[] = [];
  let repairs = 0;
  let inventories = 0;
  const runStructured = vi.fn(async (_cwd: string, _schema: unknown, prompt: string) => {
    prompts.push(prompt);
    const usage = { inputTokens: 11, outputTokens: 3, cachedInputTokens: 4 };
    if (prompt.includes("independent obligation extractor")) {
      stages.push("inventory");
      expect(prompt).not.toContain('"workItems"');
      inventories += 1;
      if (options.unsafeInventory)
        return {
          value: {
            ...claims,
            obligations: [
              {
                ...claims.obligations[0],
                acceptanceEvidence: `unsafe ghp_${"a".repeat(24)}`,
              },
            ],
          },
          usage,
        };
      if (options.invalidInventoryOnce && inventories === 1)
        return {
          value: {
            ...claims,
            obligations: [{ ...claims.obligations[0], evidenceIds: ["foreign"] }],
          },
          usage,
        };
      return { value: claims, usage };
    }
    if (prompt.includes("independent compiler judge")) {
      stages.push("judge");
      const source = JSON.parse(prompt.split("\n\n").at(-1)!) as {
        proposal: { workItems: Array<{ id: string; criteria: Array<{ id: string }> }> };
        draftDigest: string;
        inventoryDigest: string;
      };
      const accept =
        (options.acceptFirst === true ||
          options.invalidAcceptUnknownFirst === true ||
          repairs > 0) &&
        !options.rejectAll;
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
              { itemId: "feature", criterionId: source.proposal.workItems[0]!.criteria[0]!.id },
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
        dependencies: [
          {
            itemId: "feature",
            dependsOn: [],
            reason: "No prerequisite items",
            evidenceIds: ["objective"],
          },
        ],
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
        inferenceCorrections: [],
        uncertainty: [],
        decision: options.abstain ? "abstain" : accept ? "accept" : "repair",
      };
      if (options.advisoryOnlyRepair) {
        verdict.coverage[0]!.status = "covered";
        verdict.findings[0]!.severity = "advisory";
        verdict.findings[0]!.rootCause = "Prefer a shorter item title";
        verdict.findings[0]!.correction = "Shorten the title";
        verdict.decision = "repair";
      }
      if (options.invalidAcceptUnknownFirst && repairs === 0) {
        expect(prompt).toContain("If any dimension remains unknown, choose repair or abstain");
        const dimension = verdict.dimensions.find(
          (entry) => entry.dimension === "assumption-grounding",
        )!;
        dimension.status = "unknown";
        dimension.reason = "The existing proposal leaves its assumptions unclear.";
      }
      return { value: verdict, usage };
    }
    if (prompt.includes("This is a repair")) {
      stages.push("repair");
      repairs++;
      if (options.malformedRepair) return { value: { malformed: "preserve this proposal" }, usage };
      const request = JSON.parse(prompt.split("\n\n").at(-1)!) as CompilerRequest;
      return { value: proposal(request, true), usage };
    }
    stages.push("compile");
    if (options.frozenCompileFailure)
      throw Object.freeze(
        options.frozenCompileFailure === "error"
          ? new Error("frozen provider failure")
          : { message: "frozen provider failure" },
      );
    if (options.primitiveCompileFailure)
      throw options.primitiveCompileFailure === "string" ? "primitive provider failure" : null;
    if (options.missingAccounting) throw new Error("transport outcome unknown");
    const request = JSON.parse(prompt.split("\n\n").at(-1)!) as CompilerRequest;
    if (options.schemaInvalidFirst) return { value: { unexpected: true }, usage };
    const initial = proposal(request);
    if (options.mechanicallyInvalidFirst) initial.workItems[0]!.obligationIds = [];
    return { value: initial, usage };
  });
  const backend = new CodexCliManagementBackend({ runStructured });
  const store = new MemoryGraphStore(baseSha);
  const leases = new LeaseManager({ store });
  const pd = policyDigest(context.runPolicy);
  const lease = await leases.acquire(
    { objective: 42, runId: "integrated", holder: "director", policyDigest: pd },
    await store.readCommit(baseSha),
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
      baseSha,
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
  it("terminates a schema-valid proposal on a Factory economics invariant without repair spend", async () => {
    const f = await setup({ acceptFirst: true });
    f.args.context.economicEvidence = vi.fn(async () => ({
      objective: 42,
      policy: null,
    })) as never;

    const first = await compileEvaluatedDraft(f.args).catch((error) => error);
    expect(first).toBeInstanceOf(CompilerInvariantError);
    expect(first.message).toContain("compiler projection invariant failed");
    expect(f.stages).toEqual(["inventory", "compile"]);
    expect(f.accounting.size).toBe(2);
    expect(f.args.admit).toHaveBeenCalledTimes(2);

    await expect(compileEvaluatedDraft(f.args)).rejects.toBeInstanceOf(CompilerInvariantError);
    expect(f.stages).toEqual(["inventory", "compile"]);
    expect(f.accounting.size).toBe(2);
    expect(f.args.admit).toHaveBeenCalledTimes(2);
  });

  it("repairs a known-accounted mechanically invalid initial production proposal", async () => {
    const f = await setup({ mechanicallyInvalidFirst: true });
    const result = await compileEvaluatedDraft(f.args);
    expect(result.status).toBe("accepted");
    expect(f.stages).toEqual(["inventory", "compile", "repair", "judge"]);
    expect(f.accounting.size).toBe(4);
    expect(
      result.records.find(
        (record) => record.kind === "result" && record.payload.stage === "compile",
      ),
    ).toMatchObject({
      payload: {
        validationReport: {
          phase: "proposal",
          status: "repairable",
          violations: [expect.objectContaining({ code: "unmapped-obligation" })],
        },
      },
    });
  });

  it("repairs known-accounted schema-invalid output with the same proposal schema", async () => {
    const f = await setup({ schemaInvalidFirst: true });
    const result = await compileEvaluatedDraft(f.args);
    expect(result.status).toBe("accepted");
    expect(f.stages).toEqual(["inventory", "compile", "repair", "judge"]);
    const repairRequest = JSON.parse(f.prompts[2]!.split("\n\n").at(-1)!) as CompilerRequest;
    expect(repairRequest).toMatchObject({
      revision: 1,
      previousProposal: null,
      validationReport: {
        status: "repairable",
        violations: expect.arrayContaining([expect.objectContaining({ code: "schema-invalid" })]),
      },
    });
  });

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
      base: await f.store.readCommit(f.args.context.baseSha),
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
    ).toMatchObject({
      request: { protocol: "clockgrove.factory/compiler-request", revision: 0 },
      proposal: { protocol: "clockgrove.factory/compiler-proposal" },
      provenance: { baseSha: f.args.context.baseSha },
    });
    const firstJudgeSource = JSON.parse(
      f.prompts
        .find((prompt) => prompt.includes("independent compiler judge"))!
        .split("\n\n")
        .at(-1)!,
    ) as { projectionTrace: { requestDigest: string; proposalDigest: string } };
    expect(firstJudgeSource.projectionTrace.requestDigest).not.toBe("0".repeat(64));
    expect(firstJudgeSource.projectionTrace.proposalDigest).toMatch(/^[a-f0-9]{64}$/);

    const tampered = structuredClone(result.records);
    const acceptedProposal = tampered.find(
      (record) =>
        record.kind === "result" &&
        (record.payload.stage === "compile" || record.payload.stage === "repair") &&
        record.payload.revision === result.revision &&
        !record.payload.error,
    )!;
    const persisted = acceptedProposal.payload.value as { request: { revision: number } };
    persisted.request.revision += 1;
    expect(() => assertCompilerDraftSelection(tampered, result.graph)).toThrow(
      "request digest differs",
    );

    const changedReservation = structuredClone(result.records);
    const acceptedResult = changedReservation.find(
      (record) =>
        record.kind === "result" &&
        (record.payload.stage === "compile" || record.payload.stage === "repair") &&
        record.payload.revision === result.revision &&
        !record.payload.error,
    )!;
    const acceptedInvocation = changedReservation.find(
      (record) =>
        record.kind === "invocation" &&
        record.payload.invocationId === acceptedResult.payload.invocationId,
    )!;
    acceptedInvocation.payload.compilerRequestDigest = "f".repeat(64);
    expect(() => assertCompilerDraftSelection(changedReservation, result.graph)).toThrow(
      "reserved request binding",
    );
  });

  it("repairs a schema-valid accept verdict with an unknown dimension and replays without spend", async () => {
    const f = await setup({ invalidAcceptUnknownFirst: true });
    const result = await compileEvaluatedDraft(f.args);
    expect(result).toMatchObject({ status: "accepted", revision: 1 });
    expect(f.stages).toEqual(["inventory", "compile", "judge", "repair", "judge"]);
    const rawJudge = result.records.find(
      (record) =>
        record.kind === "result" &&
        record.payload.stage === "judge" &&
        record.payload.revision === 0,
    );
    expect(rawJudge).toMatchObject({
      payload: {
        usage: { inputTokens: 11, outputTokens: 3, cachedInputTokens: 4 },
        terminalOutcome: {
          state: "succeeded",
          usage: { inputTokens: 11, outputTokens: 3, cachedInputTokens: 4 },
        },
        provenance: expect.objectContaining({ baseSha: f.args.context.baseSha }),
        proposal: {
          decision: "accept",
          dimensions: expect.arrayContaining([
            expect.objectContaining({ dimension: "assumption-grounding", status: "unknown" }),
          ]),
        },
      },
    });
    const repairPrompt = f.prompts.find((prompt) => prompt.includes("This is a repair"))!;
    const repairRequest = JSON.parse(repairPrompt.split("\n\n").at(-1)!) as CompilerRequest;
    expect(repairRequest.semanticFindings).toEqual([
      expect.objectContaining({
        id: "invalid-acceptance",
        dimension: "assumption-grounding",
        severity: "blocking",
        obligationIds: [],
        itemIds: ["feature"],
        evidenceIds: ["objective"],
      }),
    ]);
    expect(() => validatePersistedCompilerDraftJournal(result.records)).not.toThrow();
    const calls = f.runStructured.mock.calls.length;
    await expect(compileEvaluatedDraft(f.args)).resolves.toMatchObject({
      status: "accepted",
      revision: 1,
    });
    expect(f.runStructured).toHaveBeenCalledTimes(calls);
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
  it("binds every provider result to its durable terminal outcome", async () => {
    const f = await setup({ acceptFirst: true });
    const result = await compileEvaluatedDraft(f.args);
    expect(result.status).toBe("accepted");
    expect(() => validatePersistedCompilerDraftJournal(result.records)).not.toThrow();
    const providerResults = result.records.filter((record) => record.kind === "result");
    expect(providerResults.length).toBeGreaterThan(0);
    for (const mutation of ["missing", "state", "usage"] as const) {
      const malformed = structuredClone(result.records);
      const terminal = malformed.find((record) => record.kind === "result")!;
      if (mutation === "missing") delete terminal.payload.terminalOutcome;
      else if (mutation === "state")
        terminal.payload.terminalOutcome = {
          state: "provider-failed",
          usage: terminal.payload.usage,
        };
      else
        terminal.payload.terminalOutcome = {
          state: "succeeded",
          usage: { inputTokens: 999, outputTokens: 0 },
        };
      expect(() => validatePersistedCompilerDraftJournal(malformed), mutation).toThrow(
        "provider terminal outcome differs",
      );
    }
  });
  it("judges a fixed graph whose derived resource is outside the semantic resource ID domain", async () => {
    const source = await setup({ acceptFirst: true });
    const compiled = await compileEvaluatedDraft(source.args);
    expect(compiled.status).toBe("accepted");
    if (compiled.status !== "accepted") throw new Error("accepted graph required");
    const f = await setup({ reportOnly: true, acceptFirst: true });
    const fixedGraph = structuredClone(compiled.graph);
    for (const item of fixedGraph.workItems) item.baseSha = f.args.context.baseSha;
    fixedGraph.workItems[0]!.changeSurface = {
      mergeClass: "large-binary",
      exclusiveResources: ["Assets/Image.PNG"],
    };

    const result = await compileEvaluatedDraft({ ...f.args, fixedGraph });

    expect(result).toMatchObject({ status: "accepted", revision: 0 });
    expect(f.stages).toEqual(["inventory", "judge"]);
  });
  it("retains malformed repair proposal and observed usage through bounded retries", async () => {
    const f = await setup({ malformedRepair: true });
    const result = await compileEvaluatedDraft(f.args);
    expect(result).toMatchObject({
      status: "stopped",
      reason: "compiler repair repeated the unchanged invalid proposal",
    });
    expect(f.stages.filter((stage) => stage === "repair")).toHaveLength(2);
    expect(f.accounting.size).toBe(5);
    expect(
      result.records.filter((r) => r.kind === "result" && r.payload.stage === "repair"),
    ).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          proposal: { malformed: "preserve this proposal" },
          usage: { inputTokens: 11, outputTokens: 3, cachedInputTokens: 4 },
        }),
      }),
      expect.objectContaining({
        payload: expect.objectContaining({
          proposal: { malformed: "preserve this proposal" },
          usage: { inputTokens: 11, outputTokens: 3, cachedInputTokens: 4 },
        }),
      }),
    ]);
  });
  it("repairs an invalid canonical evidence ID before compiling and shares accounting", async () => {
    const f = await setup({ invalidInventoryOnce: true });
    const result = await compileEvaluatedDraft(f.args);

    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") throw new Error("accepted graph required");
    expect(() => assertCompilerDraftSelection(result.records, result.graph)).not.toThrow();
    expect(f.stages).toEqual(["inventory", "inventory", "compile", "judge", "repair", "judge"]);
    expect(f.accounting.size).toBe(6);
    expect(f.args.admit).toHaveBeenCalledTimes(6);
    expect(f.prompts[1]).toContain("priorInventoryFailure");
    expect(f.prompts[1]).toContain('"code":"schema-invalid"');
    const rejected = result.records.find(
      (record) =>
        record.kind === "result" &&
        record.payload.stage === "inventory" &&
        record.payload.revision === 0,
    );
    expect(rejected?.payload).toMatchObject({
      error: "unknown obligation citation",
      usage: { inputTokens: 11, outputTokens: 3, cachedInputTokens: 4 },
      repairableInvalidClaims: {
        kind: "deterministic-obligation-claims-validation-v1",
        proposalDigest: draftDigest(rejected?.payload.proposal),
      },
      proposal: {
        version: 1,
        obligations: [expect.objectContaining({ evidenceIds: ["foreign"] })],
      },
    });
    expect((await compileEvaluatedDraft(f.args)).status).toBe("accepted");
    expect(f.runStructured).toHaveBeenCalledTimes(6);

    const ambiguous = structuredClone(result.records);
    const firstInventory = ambiguous.find(
      (record) => record.kind === "result" && record.payload.stage === "inventory",
    )!;
    const validInventory = ambiguous.find(
      (record) =>
        record.kind === "result" && record.payload.stage === "inventory" && !record.payload.error,
    )!;
    delete firstInventory.payload.error;
    firstInventory.payload.value = validInventory.payload.value;
    expect(() => assertCompilerDraftSelection(ambiguous, result.graph)).toThrow(
      "no unambiguous accepted assessment",
    );
  });
  it("keeps report-only invalid inventory single-shot", async () => {
    const f = await setup({ invalidInventoryOnce: true, reportOnly: true });
    const result = await compileEvaluatedDraft(f.args);

    expect(result).toMatchObject({
      status: "stopped",
      reason: "invalid-inventory: unknown obligation citation",
    });
    expect(f.stages).toEqual(["inventory"]);
    expect(f.accounting.size).toBe(1);
  });
  it("does not retry unsafe inventory output even with known usage", async () => {
    const f = await setup({ unsafeInventory: true });
    const result = await compileEvaluatedDraft(f.args);

    expect(result).toMatchObject({
      status: "stopped",
      reason: "obligation claims output contains suspected GitHub token",
    });
    expect(f.stages).toEqual(["inventory"]);
    expect(f.accounting.size).toBe(1);
    expect(result.records.find((record) => record.kind === "result")?.payload).toMatchObject({
      usage: { inputTokens: 11, outputTokens: 3, cachedInputTokens: 4 },
      stopReason: "obligation claims output contains suspected GitHub token",
    });
  });
  it("rechecks frozen inputs before an inventory retry without reserving another call", async () => {
    const f = await setup({ invalidInventoryOnce: true });
    f.args.assertInputs
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("Objective changed during inventory repair"));

    await expect(compileEvaluatedDraft(f.args)).rejects.toThrow(
      "Objective changed during inventory repair",
    );
    expect(f.stages).toEqual(["inventory"]);
    expect(f.args.admit).toHaveBeenCalledOnce();
    expect(
      (await f.args.manager.load(f.args.binding)).filter((record) => record.kind === "invocation"),
    ).toHaveLength(1);
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
  it("stops advisory-only repair from the production judge before another provider call, including restart", async () => {
    const f = await setup({ advisoryOnlyRepair: true });
    const result = await compileEvaluatedDraft(f.args);
    expect(result).toMatchObject({
      status: "stopped",
      reason: "judge repair has no unresolved coverage or material finding",
    });
    expect(f.stages).toEqual(["inventory", "compile", "judge"]);
    expect(f.args.admit).toHaveBeenCalledTimes(3);
    expect(f.accounting.size).toBe(3);
    expect(result.records.some((r) => r.kind === "selection")).toBe(false);
    expect(
      await new CompiledGraphManager(f.store, f.leases).load(42, f.args.lease.runId),
    ).toBeNull();
    expect(await compileEvaluatedDraft(f.args)).toMatchObject({
      status: "stopped",
      reason: "judge repair has no unresolved coverage or material finding",
    });
    expect(f.runStructured).toHaveBeenCalledTimes(3);
  });
  it("replays the durable no-material-repair stop after a crash before the stopped record", async () => {
    const f = await setup({ advisoryOnlyRepair: true });
    const append = f.args.manager.append.bind(f.args.manager);
    const fault = vi.spyOn(f.args.manager, "append").mockImplementation(async (...args) => {
      if (args[3] === "stopped") throw new Error("process unavailable before stopped record");
      const saved = await append(...args);
      if (args[3] === "result" && args[4].stage === "judge")
        throw new Error("crash after durable judge result");
      return saved;
    });
    await expect(compileEvaluatedDraft(f.args)).rejects.toThrow();
    fault.mockRestore();
    expect((await f.args.manager.load(f.args.binding)).some((r) => r.kind === "stopped")).toBe(
      false,
    );
    expect(await compileEvaluatedDraft(f.args)).toMatchObject({
      status: "stopped",
      reason: "judge repair has no unresolved coverage or material finding",
    });
    expect(f.stages).toEqual(["inventory", "compile", "judge"]);
    expect(f.accounting.size).toBe(3);
    expect(f.args.admit).toHaveBeenCalledTimes(3);
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
  it.each([
    ["string", "primitive provider failure"],
    ["null", "null"],
  ] as const)(
    "durably closes a structured %s rejection without provider replay",
    async (kind, diagnostic) => {
      const f = await setup({ primitiveCompileFailure: kind });
      const result = await compileEvaluatedDraft(f.args);
      expect(result).toMatchObject({ status: "stopped", reason: "accounting-unavailable" });
      expect(f.stages).toEqual(["inventory", "compile"]);
      const failed = result.records.find(
        (record) =>
          record.kind === "result" &&
          record.payload.stage === "compile" &&
          record.payload.error !== undefined,
      );
      expect(failed?.payload).toMatchObject({
        error: diagnostic,
        usage: null,
        terminalOutcome: { state: "provider-failed", usage: null },
        provenance: {
          baseSha: f.args.context.baseSha,
          promptDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
          schemaDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      });
      const invocationCount = f.runStructured.mock.calls.length;
      expect(await compileEvaluatedDraft(f.args)).toMatchObject({
        status: "stopped",
        reason: "accounting-unavailable",
      });
      expect(f.runStructured).toHaveBeenCalledTimes(invocationCount);

      const forged = structuredClone(result.records);
      const forgedResult = forged.find(
        (record) => record.kind === "result" && record.payload.stage === "compile",
      )!;
      forgedResult.payload.terminalOutcome = { state: "succeeded", usage: null };
      expect(() => validatePersistedCompilerDraftJournal(forged)).toThrow(
        "successful provider terminal outcome requires exact usage",
      );
    },
  );
  it.each(["error", "object"] as const)(
    "durably closes a frozen structured %s without replay",
    async (kind) => {
      const f = await setup({ frozenCompileFailure: kind });
      const result = await compileEvaluatedDraft(f.args);
      expect(result).toMatchObject({ status: "stopped", reason: "accounting-unavailable" });
      expect(f.stages).toEqual(["inventory", "compile"]);
      expect(
        result.records.find(
          (record) => record.kind === "result" && record.payload.stage === "compile",
        )?.payload,
      ).toMatchObject({
        error: "frozen provider failure",
        usage: null,
        terminalOutcome: { state: "provider-failed", usage: null },
        provenance: {
          baseSha: f.args.context.baseSha,
          promptDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
          schemaDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      });
      const invocationCount = f.runStructured.mock.calls.length;
      expect(await compileEvaluatedDraft(f.args)).toMatchObject({
        status: "stopped",
        reason: "accounting-unavailable",
      });
      expect(f.runStructured).toHaveBeenCalledTimes(invocationCount);
    },
  );
});
