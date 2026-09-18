import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CodexCliManagementBackend,
  compilerObligationEvidence,
} from "../src/management/codex-cli.js";
import { compileEvaluatedDraft } from "../src/management/draft-compilation.js";
import { compiledGraphDigest, parsePersistedCompiledObjective } from "../src/graph.js";
import {
  COMPILER_JUDGE_DIMENSIONS,
  compilerEvalDigest,
  type CompilerJudgeVerdict,
  type ObligationInventory,
} from "../src/evaluation/compiler-eval.js";
import {
  managementTerminalOutcome,
  ManagementCleanupError,
  ManagementFailureCleanupError,
  EMPTY_REPOSITORY_CAPTURE_PLANNING,
  type CompilationContext,
} from "../src/management/backend.js";
import { DEFAULT_RUN_POLICY, policyDigest } from "../src/protocol/policy.js";
import type {
  CompilerDraftBinding,
  CompilerDraftManager,
  CompilerDraftRecord,
} from "../src/control/compiler-drafts.js";
import type { LeaseState } from "../src/control/lease.js";
import { ProviderQuotaError } from "../src/providers/quota.js";
import { pinFixtureRepository, proposalFromCompiledFixture } from "./helpers/compiler-proposal.js";
import {
  semanticPinnedFacts,
  semanticProjectionContext,
  semanticProposal,
  semanticRequest,
} from "./helpers/semantic-compiler.js";
import { createCompilerValidationReport } from "../src/compiler/violations.js";
import type { CompilerAssetManifestView } from "../src/assets/media-intent.js";
import {
  materializePinnedCompilationTree,
  sealPinnedCompilationTreeProof,
} from "../src/execution/pinned-compilation-tree.js";
const mocks = vi.hoisted(() => ({ resolve: vi.fn(), run: vi.fn(), environment: vi.fn() }));
vi.mock("../src/runtime/codex-command.js", () => ({ resolveCodexCommand: mocks.resolve }));
vi.mock("../src/runtime/process-group.js", async (original) => {
  const actual = await original<typeof import("../src/runtime/process-group.js")>();
  return {
    ...actual,
    runContainedProcess: (args: Parameters<typeof actual.runContainedProcess>[0]) =>
      args.command === "git" ? actual.runContainedProcess(args) : mocks.run(args),
  };
});
vi.mock("../src/runtime/codex-home.js", async (original) => ({
  ...(await original<typeof import("../src/runtime/codex-home.js")>()),
  isolateCodexEnvironment: mocks.environment,
}));
const directories: string[] = [];
const disposePinnedTrees: Array<() => Promise<void>> = [];
beforeEach(() => {
  mocks.resolve.mockReset().mockResolvedValue({ command: "fixture-codex", args: [] });
  mocks.run.mockReset();
  mocks.environment.mockReset().mockImplementation((env: Record<string, string>) => env);
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(disposePinnedTrees.splice(0).map((dispose) => dispose()));
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "compiler-admission-"));
  directories.push(directory);
  const golden = JSON.parse(
    await readFile(new URL("./fixtures/compiler/golden-objective.json", import.meta.url), "utf8"),
  );
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({ scripts: golden.repositoryFacts.scripts }),
  );
  await writeFile(
    join(directory, "package-lock.json"),
    JSON.stringify({ name: "compiler-admission-fixture", lockfileVersion: 3, packages: {} }),
  );
  const baseSha = pinFixtureRepository(directory);
  const tree = await materializePinnedCompilationTree(directory, baseSha);
  disposePinnedTrees.push(tree.dispose);
  await sealPinnedCompilationTreeProof(tree.proof);
  const context: CompilationContext = {
    repository: tree.path,
    objective: { number: 42, title: golden.title, body: "Implement core behavior and tests" },
    baseSha,
    defaultBranch: "main",
    repositoryFiles: tree.files,
    pinnedCompilationTree: tree.proof,
    allowedNetworkDestinations: [],
    runPolicy: {
      ...DEFAULT_RUN_POLICY,
      allowedNetworkDestinations: [],
      compilerEvaluation: { mode: "report-only" },
    },
    repositoryCapturePlanning: EMPTY_REPOSITORY_CAPTURE_PLANNING,
  };
  context.repositoryEvidence = compilerObligationEvidence(context);
  const graph = parsePersistedCompiledObjective({
    title: golden.title,
    workItems: golden.workItems.map((item: { acceptance: string[] }) => ({
      ...item,
      criterionRisks: item.acceptance.map((criterion) => ({ criterion, risk: "ordinary" })),
    })),
  });
  const request = semanticRequest();
  const proposal = proposalFromCompiledFixture(request, graph);
  const projectionTrace = {
    protocol: "clockgrove.factory/compiler-projection" as const,
    requestDigest: compilerEvalDigest(request),
    proposalDigest: compilerEvalDigest(proposal),
    graphDigest: compiledGraphDigest(graph),
    addedEdges: [],
    adapterBindings: [],
    mediaIntents: [],
    riskElevations: { count: 0, digest: compilerEvalDigest([]) },
  };
  const inventory: ObligationInventory = {
    version: 1,
    objectiveDigest: compilerEvalDigest(context.objective),
    baseSha: context.baseSha,
    evidence: context.repositoryEvidence,
    obligations: [
      {
        id: "core",
        text: context.objective.body,
        kind: "explicit",
        evidenceIds: ["objective"],
        acceptanceEvidence: "Behavior tested",
      },
    ],
  };
  const verdict: CompilerJudgeVerdict = {
    version: 1,
    rubricVersion: 1,
    draftDigest: compiledGraphDigest(graph),
    inventoryDigest: compilerEvalDigest(inventory),
    coverage: [
      {
        obligationId: "core",
        status: "covered",
        itemIds: [graph.workItems[0]!.id],
        acceptanceBindings: [{ itemId: graph.workItems[0]!.id, criterionId: "criterion-1" }],
        evidenceIds: ["objective"],
        reason: "Tests establish behavior",
      },
    ],
    items: graph.workItems.map((item) => ({
      itemId: item.id,
      granularity: "cohesive",
      reason: "Cohesive",
      evidenceIds: ["objective"],
    })),
    dimensions: COMPILER_JUDGE_DIMENSIONS.map((dimension) => ({
      dimension,
      status: "assessed",
      reason: "Reviewed",
      evidenceIds: ["objective"],
    })),
    dependencies: graph.workItems.map((item) => ({
      itemId: item.id,
      dependsOn: item.dependsOn,
      reason: "Producer output",
      evidenceIds: ["objective"],
    })),
    findings: [],
    inferenceCorrections: [],
    uncertainty: [],
    decision: "accept",
  };
  const binding: CompilerDraftBinding = {
    repository: "owner/repo",
    objective: 42,
    runId: "admission",
    policyDigest: policyDigest(context.runPolicy),
    baseSha: context.baseSha,
    inputDigest: inventory.objectiveDigest,
  };
  const records: CompilerDraftRecord[] = [];
  const manager = {
    load: async () => structuredClone(records),
    append: async (
      _lease: LeaseState,
      _binding: CompilerDraftBinding,
      sequence: number,
      kind: CompilerDraftRecord["kind"],
      payload: Record<string, unknown>,
    ) => {
      if (sequence !== records.length) throw new Error("append fence");
      const record: CompilerDraftRecord = {
        protocol: "clockgrove.factory/compiler-draft",
        binding,
        sequence,
        kind,
        payload: structuredClone(payload),
      };
      records.push(record);
      return structuredClone(record);
    },
  } as unknown as CompilerDraftManager;
  return {
    context,
    graph,
    request,
    proposal,
    projectionTrace,
    inventory,
    verdict,
    binding,
    records,
    manager,
    directory,
  };
}
async function home() {
  const path = await mkdtemp(join(tmpdir(), "compiler-prepared-home-"));
  directories.push(path);
  return path;
}
const usage = { inputTokens: 4, outputTokens: 2 };
describe("compiler dispatch admission", () => {
  it("passes supported compiler media separately while the prompt contains only opaque facts", async () => {
    const f = await fixture();
    const imagePath = join(f.directory, "compiler-reference.png");
    await writeFile(imagePath, "verified-image-fixture");
    const manifestDigest = "b".repeat(64);
    const policy = {
      ...f.context.runPolicy,
      compilerMediaEgress: {
        mode: "private-assets" as const,
        maxAssets: 1,
        deterministicReviewRuleIds: [],
      },
    };
    const pinnedFacts = semanticPinnedFacts({
      baseSha: f.context.baseSha,
      paths: f.context.repositoryFiles,
    });
    const request = semanticRequest(pinnedFacts);
    const assetManifest: CompilerAssetManifestView = {
      digest: manifestDigest,
      assets: [
        {
          id: "reference-image",
          mediaType: "image/png",
          bytes: 22,
          inspection: {
            kind: "raster",
            width: 16,
            height: 16,
            frames: 1,
            alpha: false,
          },
          visibility: "private",
          descriptorClass: "semantic",
          inspectionHandler: { id: "sharp-raster", contract: 1 },
          rightsBasis: "unknown",
        },
      ],
    };
    request.media = {
      assetManifest,
      assetEgress: {
        mode: "private-assets",
        policyDigest: compilerEvalDigest(policy.compilerMediaEgress),
      },
      producerCapabilities: [],
      reviewRules: [],
    };
    const input = {
      manifestDigest,
      descriptorDigest: "c".repeat(64),
      contentDigest: "d".repeat(64),
      storageReceiptDigest: "e".repeat(64),
      path: `assets/${"c".repeat(64)}/reference.png`,
      purpose: "compiler-import" as const,
    };
    const assetEgress = {
      mode: "private-assets" as const,
      policyDigest: compilerEvalDigest(policy.compilerMediaEgress),
    };
    const mediaPlanning = {
      assetManifest,
      mediaInputs: [{ assetId: "reference-image", mediaType: "image/png", path: imagePath }],
      assetBindings: [{ assetId: "reference-image", input }],
      assetEgress,
      producerCapabilities: [],
      reviewRules: [],
    };
    const proposal = semanticProposal(request);
    mocks.run.mockImplementation(async (args: { args: string[]; stdin: { text: string } }) => {
      expect(args.args).toContain("--image");
      expect(args.args).toContain(imagePath);
      expect(args.stdin.text).not.toContain(imagePath);
      expect(args.stdin.text).toContain('"id":"reference-image"');
      return {
        exitCode: 0,
        stderr: "",
        stdout: [
          JSON.stringify({
            type: "item.completed",
            item: { type: "agent_message", text: JSON.stringify(proposal) },
          }),
          JSON.stringify({
            type: "turn.completed",
            usage: { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens },
          }),
        ].join("\n"),
      };
    });
    const backend = new CodexCliManagementBackend({
      createCodexHome: home,
      authFile: join(f.directory, "no-auth"),
    });

    await expect(
      backend.proposePlan(
        request,
        async () => {},
        { pinnedFacts, runPolicy: policy, mediaPlanning },
        undefined,
        {
          ...f.context,
          objective: request.objective,
          runPolicy: policy,
          mediaPlanning,
        },
      ),
    ).resolves.toMatchObject({
      provenance: {
        assetManifestDigest: manifestDigest,
        mediaEgressDigest: request.media.assetEgress.policyDigest,
      },
    });
    expect(mocks.run).toHaveBeenCalledOnce();

    const unsupportedPlanning = {
      ...mediaPlanning,
      mediaInputs: [{ assetId: "reference-image", mediaType: "audio/wav", path: imagePath }],
    };
    await expect(
      backend.proposePlan(
        request,
        async () => {},
        { pinnedFacts, runPolicy: policy, mediaPlanning: unsupportedPlanning },
        undefined,
        {
          ...f.context,
          objective: request.objective,
          runPolicy: policy,
          mediaPlanning: unsupportedPlanning,
        },
      ),
    ).rejects.toThrow("Codex CLI does not support compiler media input types: audio/wav");
    expect(mocks.run).toHaveBeenCalledOnce();
  });

  it("checkpoints exact media authority provenance before advancing the evaluated draft", async () => {
    const f = await fixture();
    const manifestDigest = "b".repeat(64);
    const mediaEgress = {
      mode: "private-assets" as const,
      maxAssets: 1,
      deterministicReviewRuleIds: [],
    };
    f.context.runPolicy = {
      ...f.context.runPolicy,
      compilerMediaEgress: mediaEgress,
    };
    f.context.mediaPlanning = {
      assetManifest: {
        digest: manifestDigest,
        assets: [
          {
            id: "reference-image",
            mediaType: "image/png",
            bytes: 22,
            inspection: { kind: "raster", width: 16, height: 16, frames: 1, alpha: false },
            visibility: "private",
            descriptorClass: "semantic",
            inspectionHandler: { id: "sharp-raster", contract: 1 },
            rightsBasis: "unknown",
          },
        ],
      },
      mediaInputs: [],
      assetBindings: [
        {
          assetId: "reference-image",
          input: {
            manifestDigest,
            descriptorDigest: "c".repeat(64),
            contentDigest: "d".repeat(64),
            storageReceiptDigest: "e".repeat(64),
            path: `assets/${"c".repeat(64)}/reference.png`,
            purpose: "compiler-import",
          },
        },
      ],
      assetEgress: {
        mode: "private-assets",
        policyDigest: compilerEvalDigest(mediaEgress),
      },
      producerCapabilities: [],
      reviewRules: [],
    };
    f.binding.policyDigest = policyDigest(f.context.runPolicy);
    f.proposal.workItems[0]!.obligationIds = ["core"];
    const backend = new CodexCliManagementBackend({
      createCodexHome: home,
      authFile: join(f.directory, "no-auth"),
    });
    mocks.run.mockImplementation(async () => ({
      exitCode: 0,
      stderr: "",
      stdout: [
        JSON.stringify({
          type: "item.completed",
          item: {
            type: "agent_message",
            text: JSON.stringify(
              mocks.run.mock.calls.length === 1
                ? { version: f.inventory.version, obligations: f.inventory.obligations }
                : f.proposal,
            ),
          },
        }),
        JSON.stringify({
          type: "turn.completed",
          usage: { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens },
        }),
      ].join("\n"),
    }));

    await expect(
      compileEvaluatedDraft({
        ...f,
        backend,
        lease: {} as LeaseState,
        deadlineAt: Date.now() + 60_000,
        assertInputs: async () => {
          if (mocks.run.mock.calls.length >= 2) throw new Error("stop after media proposal");
        },
        admit: async () => {},
        recordUsage: async () => {},
        validate: async () => {},
      }),
    ).rejects.toThrow("stop after media proposal");
    expect(f.records.filter((record) => record.kind === "result")).toHaveLength(2);
    expect(f.records.find((record) => record.kind === "validation")).toBeDefined();
    for (const result of f.records.filter((record) => record.kind === "result"))
      expect(result.payload.provenance).toMatchObject({
        assetManifestDigest: manifestDigest,
        mediaEgressDigest: compilerEvalDigest(mediaEgress),
      });
  });

  it("removes every qualification authority value from the model subprocess environment", async () => {
    const f = await fixture();
    const authorityEnvironment = {
      FACTORY_LIVE_OBJECTIVE: "1",
      FACTORY_LIVE_COMPILER_ISSUE404: "1",
      FACTORY_LIVE_COMPILER_ISSUE404_PAID_ACK: "consume-paid-compiler-evaluation",
      FACTORY_LIVE_COMPILER_ISSUE404_RUN_ID: "qualification-environment",
      FACTORY_ISSUE404_CANDIDATE_SHA: "9".repeat(40),
      FACTORY_MANAGEMENT_TRANSCRIPT_DIR: "/private/factory-evidence/issue-404",
    };
    for (const [name, value] of Object.entries(authorityEnvironment)) vi.stubEnv(name, value);
    const backend = new CodexCliManagementBackend({
      createCodexHome: home,
      authFile: join(f.directory, "no-auth"),
      transcriptRecorder: null,
    });
    mocks.run.mockImplementation(async (args: { env: NodeJS.ProcessEnv }) => {
      for (const name of Object.keys(authorityEnvironment)) expect(args.env[name]).toBeUndefined();
      const subprocessValues = Object.values(args.env);
      for (const value of [
        authorityEnvironment.FACTORY_LIVE_COMPILER_ISSUE404_PAID_ACK,
        authorityEnvironment.FACTORY_LIVE_COMPILER_ISSUE404_RUN_ID,
        authorityEnvironment.FACTORY_ISSUE404_CANDIDATE_SHA,
        authorityEnvironment.FACTORY_MANAGEMENT_TRANSCRIPT_DIR,
      ])
        expect(subprocessValues).not.toContain(value);
      return {
        exitCode: 0,
        stderr: "",
        stdout: [
          JSON.stringify({
            type: "item.completed",
            item: {
              type: "agent_message",
              text: JSON.stringify({
                version: f.inventory.version,
                obligations: f.inventory.obligations,
              }),
            },
          }),
          JSON.stringify({
            type: "turn.completed",
            usage: { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens },
          }),
        ].join("\n"),
      };
    });

    await expect(backend.extractObligations(f.context, async () => {})).resolves.toMatchObject({
      inventory: f.inventory,
      usage,
    });
    expect(mocks.run).toHaveBeenCalledOnce();
  });

  it("rejects a mutable compiler cwd before an external model can inspect it", async () => {
    const f = await fixture();
    await writeFile(join(f.directory, "transient-secret.txt"), "must remain invisible\n");
    const backend = new CodexCliManagementBackend({ authFile: join(f.directory, "no-auth") });
    const { pinnedCompilationTree: _proof, ...mutableContext } = f.context;
    Object.assign(mutableContext, {
      repository: f.directory,
    });

    await expect(backend.extractObligations(mutableContext, async () => {})).rejects.toThrow(
      "active exact-base compilation tree",
    );
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("fails management readiness when its durable isolated home is unavailable", async () => {
    const f = await fixture();
    const authFile = join(f.directory, "auth.json");
    await writeFile(authFile, "{}");
    const failure = Object.assign(new Error("read-only file system"), { code: "EROFS" });
    const createCodexHome = vi.fn(async () => {
      throw failure;
    });
    mocks.run.mockResolvedValue({ exitCode: 0, stdout: "codex-cli 99.0.0", stderr: "" });

    await expect(
      new CodexCliManagementBackend({ authFile, createCodexHome }).probe(),
    ).resolves.toEqual({
      available: false,
      authenticated: true,
      reason: "isolated Codex home unavailable: read-only file system",
    });
    expect(createCodexHome).toHaveBeenCalledExactlyOnceWith("management");
  });

  it("removes the disposable isolated home after a successful management probe", async () => {
    const f = await fixture();
    const authFile = join(f.directory, "auth.json");
    await writeFile(authFile, "{}");
    const probeHome = await mkdtemp(join(tmpdir(), "management-probe-home-"));
    directories.push(probeHome);
    const createCodexHome = vi.fn(async () => probeHome);
    mocks.run.mockResolvedValue({ exitCode: 0, stdout: "codex-cli 99.0.0", stderr: "" });

    await expect(
      new CodexCliManagementBackend({ authFile, createCodexHome }).probe(),
    ).resolves.toEqual({ available: true, authenticated: true });
    expect(createCodexHome).toHaveBeenCalledExactlyOnceWith("management");
    await expect(access(probeHome)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["inventory", "compile", "judge", "repair"] as const)(
    "does not admit %s before isolated CLI home preparation succeeds",
    async (stage) => {
      const f = await fixture();
      const error = new Error("isolated home unavailable");
      const before = vi.fn(async () => {});
      const backend = new CodexCliManagementBackend({
        createCodexHome: async () => {
          throw error;
        },
        authFile: join(f.directory, "no-auth"),
      });
      const call =
        stage === "inventory"
          ? () => backend.extractObligations(f.context, async () => {}, before)
          : stage === "compile"
            ? () =>
                backend.proposePlan(
                  f.request,
                  async () => {},
                  semanticProjectionContext(undefined, f.context.runPolicy),
                  before,
                  f.context,
                )
            : stage === "judge"
              ? () =>
                  backend.judgePlan(
                    {
                      compilation: f.context,
                      inventory: f.inventory,
                      proposal: f.proposal,
                      projectionTrace: f.projectionTrace,
                      graphDigest: f.projectionTrace.graphDigest,
                    },
                    async () => {},
                    before,
                  )
              : () =>
                  backend.proposePlan(
                    {
                      ...f.request,
                      revision: 1,
                      previousProposal: f.proposal,
                      validationReport: createCompilerValidationReport("proposal", [
                        {
                          code: "unmapped-obligation",
                          itemId: null,
                          field: "/workItems",
                          expected: "explicit-contract",
                          observed: null,
                        },
                      ]),
                    },
                    async () => {},
                    semanticProjectionContext(undefined, f.context.runPolicy),
                    before,
                    f.context,
                  );
      await expect(call()).rejects.toBe(error);
      expect(before).not.toHaveBeenCalled();
      expect(mocks.run).not.toHaveBeenCalled();
    },
  );
  it.each(["home", "command", "environment"] as const)(
    "retains no invocation or model budget admission after known %s preparation failure",
    async (stage) => {
      const f = await fixture();
      const failure = new Error(`${stage} preparation failed`);
      if (stage === "command") mocks.resolve.mockRejectedValue(failure);
      if (stage === "environment")
        mocks.environment.mockImplementation(() => {
          throw failure;
        });
      const backend = new CodexCliManagementBackend({
        createCodexHome:
          stage === "home"
            ? async () => {
                throw failure;
              }
            : home,
        authFile: join(f.directory, "no-auth"),
      });
      const admit = vi.fn(async () => {});
      const recordUsage = vi.fn(async () => {});
      await expect(
        compileEvaluatedDraft({
          ...f,
          backend,
          lease: {} as LeaseState,
          deadlineAt: Date.now() + 60_000,
          assertInputs: async () => {},
          admit,
          recordUsage,
          validate: async () => {},
        }),
      ).rejects.toThrow(failure.message);
      expect(admit).not.toHaveBeenCalled();
      expect(recordUsage).not.toHaveBeenCalled();
      expect(mocks.run).not.toHaveBeenCalled();
      expect(f.records.map((record) => record.kind)).toEqual(["started", "source-evidence"]);
    },
  );
  it("keeps post-dispatch transport outcomes unknown and never repeats them on restart", async () => {
    const f = await fixture();
    const backend = new CodexCliManagementBackend({
      createCodexHome: home,
      authFile: join(f.directory, "no-auth"),
    });
    mocks.run.mockRejectedValue(new Error("provider transport ended without terminal counters"));
    const admit = vi.fn(async () => {});
    const args = {
      ...f,
      backend,
      lease: {} as LeaseState,
      deadlineAt: Date.now() + 60_000,
      assertInputs: async () => {},
      admit,
      recordUsage: vi.fn(async () => {}),
      validate: async () => {},
    };
    await expect(compileEvaluatedDraft(args)).resolves.toMatchObject({
      status: "stopped",
      reason: "accounting-unavailable",
    });
    expect(admit).toHaveBeenCalledOnce();
    expect(f.records.find((record) => record.kind === "result")?.payload.usage).toBeNull();
    await expect(compileEvaluatedDraft(args)).resolves.toMatchObject({
      status: "stopped",
      reason: "accounting-unavailable",
    });
    expect(mocks.run).toHaveBeenCalledOnce();
    expect(admit).toHaveBeenCalledOnce();
  });
  it("surfaces and replays a bounded durable timeout diagnostic when usage is unknown", async () => {
    const f = await fixture();
    const privateProgress = "private provider progress must stay out of durable diagnostics";
    const backend = new CodexCliManagementBackend({
      createCodexHome: home,
      authFile: join(f.directory, "no-auth"),
    });
    mocks.run.mockResolvedValue({
      exitCode: null,
      signal: null,
      timedOut: true,
      durationMs: 590_901,
      stdout: [
        JSON.stringify({ type: "turn.started" }),
        JSON.stringify({ type: "diagnostic", message: privateProgress }),
      ].join("\n"),
      stderr: "private stderr",
    });
    const recordUsage = vi.fn(async () => {});
    const args = {
      ...f,
      backend,
      lease: {} as LeaseState,
      deadlineAt: Date.now() + 600_000,
      assertInputs: async () => {},
      admit: vi.fn(async () => {}),
      recordUsage,
      validate: async () => {},
    };

    const first = await compileEvaluatedDraft(args);
    const invocationId = String(
      f.records.find((record) => record.kind === "invocation")?.payload.invocationId,
    );
    const message = `compiler timeout: stage=inventory; evaluation timeout=600000ms; observed duration=590901ms; invocation=${invocationId}; usage: unknown`;
    expect(message.length).toBeLessThan(400);
    expect(first).toMatchObject({ status: "stopped", reason: message });
    expect(f.records.find((record) => record.kind === "result")?.payload).toMatchObject({
      invocationId,
      stage: "inventory",
      usage: null,
      error: message,
      terminalOutcome: {
        state: "provider-failed",
        usage: null,
        process: { timedOut: true, durationMs: 590_901 },
      },
      timeoutDiagnostic: {
        kind: "compiler-timeout",
        stage: "inventory",
        evaluationTimeoutMs: 600_000,
        observedDurationMs: 590_901,
        invocationId,
        usage: "unknown",
      },
    });
    expect(JSON.stringify(f.records)).not.toContain(privateProgress);
    expect(JSON.stringify(f.records)).not.toContain("private stderr");
    expect(recordUsage).not.toHaveBeenCalled();

    await expect(compileEvaluatedDraft(args)).resolves.toMatchObject({
      status: "stopped",
      reason: message,
    });
    expect(mocks.run).toHaveBeenCalledOnce();
    expect(args.admit).toHaveBeenCalledOnce();
    expect(recordUsage).not.toHaveBeenCalled();
  });
  it("maps the internal compile stage to proposal in the public timeout diagnostic", async () => {
    const f = await fixture();
    const backend = new CodexCliManagementBackend({
      createCodexHome: home,
      authFile: join(f.directory, "no-auth"),
    });
    mocks.run.mockImplementation(async () => {
      if (mocks.run.mock.calls.length === 1) {
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          durationMs: 100,
          stdout: [
            JSON.stringify({
              type: "item.completed",
              item: {
                type: "agent_message",
                text: JSON.stringify({
                  version: f.inventory.version,
                  obligations: f.inventory.obligations,
                }),
              },
            }),
            JSON.stringify({
              type: "turn.completed",
              usage: { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens },
            }),
          ].join("\n"),
          stderr: "",
        };
      }
      return {
        exitCode: null,
        signal: null,
        timedOut: true,
        durationMs: 580_000,
        stdout: JSON.stringify({ type: "turn.started" }),
        stderr: "",
      };
    });
    const args = {
      ...f,
      backend,
      lease: {} as LeaseState,
      deadlineAt: Date.now() + 600_000,
      assertInputs: async () => {},
      admit: vi.fn(async () => {}),
      recordUsage: vi.fn(async () => {}),
      validate: async () => {},
    };

    const result = await compileEvaluatedDraft(args);
    const timedOut = f.records.find(
      (record) => record.kind === "result" && record.payload.stage === "compile",
    )!;
    const invocationId = String(timedOut.payload.invocationId);
    const message = `compiler timeout: stage=proposal; evaluation timeout=600000ms; observed duration=580000ms; invocation=${invocationId}; usage: unknown`;
    expect(result).toMatchObject({ status: "stopped", reason: message });
    expect(timedOut.payload).toMatchObject({
      stage: "compile",
      error: message,
      timeoutDiagnostic: {
        kind: "compiler-timeout",
        stage: "proposal",
        evaluationTimeoutMs: 600_000,
        observedDurationMs: 580_000,
        invocationId,
        usage: "unknown",
      },
    });
    expect(mocks.run).toHaveBeenCalledTimes(2);
    expect(args.admit).toHaveBeenCalledTimes(2);
  });
  it("retains timeout diagnostics when the timed-out stream also reports provider quota", async () => {
    const f = await fixture();
    const backend = new CodexCliManagementBackend({
      createCodexHome: home,
      authFile: join(f.directory, "no-auth"),
    });
    mocks.run.mockResolvedValue({
      exitCode: null,
      signal: null,
      timedOut: true,
      durationMs: 575_000,
      stdout: JSON.stringify({
        type: "error",
        message: "You've reached your additional usage limit for your plan.",
      }),
      stderr: "",
    });
    const recordUsage = vi.fn(async () => {});
    const args = {
      ...f,
      backend,
      lease: {} as LeaseState,
      deadlineAt: Date.now() + 600_000,
      assertInputs: async () => {},
      admit: vi.fn(async () => {}),
      recordUsage,
      validate: async () => {},
    };

    const first = await compileEvaluatedDraft(args).catch((error) => error);
    const result = f.records.find((record) => record.kind === "result")!;
    const invocationId = String(result.payload.invocationId);
    const message = `compiler timeout: stage=inventory; evaluation timeout=600000ms; observed duration=575000ms; invocation=${invocationId}; usage: unknown`;
    expect(first).toBeInstanceOf(ProviderQuotaError);
    expect(first.message).toBe(message);
    expect(result.payload).toMatchObject({
      error: message,
      usage: null,
      providerQuota: {
        reasonCode: "provider-quota-exhausted",
        provider: "github-copilot",
      },
      terminalOutcome: {
        state: "provider-failed",
        usage: null,
        process: { timedOut: true, durationMs: 575_000 },
      },
      timeoutDiagnostic: {
        kind: "compiler-timeout",
        stage: "inventory",
        evaluationTimeoutMs: 600_000,
        observedDurationMs: 575_000,
        invocationId,
        usage: "unknown",
      },
    });
    expect(recordUsage).not.toHaveBeenCalled();

    const replay = await compileEvaluatedDraft(args).catch((error) => error);
    expect(replay).toBeInstanceOf(ProviderQuotaError);
    expect(replay.message).toBe(message);
    expect(mocks.run).toHaveBeenCalledOnce();
    expect(args.admit).toHaveBeenCalledOnce();
    expect(recordUsage).not.toHaveBeenCalled();
  });
  it("reconciles one exact completion receipt from a timed-out compiler invocation once", async () => {
    const f = await fixture();
    const exactUsage = { inputTokens: 41, outputTokens: 5, cachedInputTokens: 20 };
    const backend = new CodexCliManagementBackend({
      createCodexHome: home,
      authFile: join(f.directory, "no-auth"),
    });
    mocks.run.mockResolvedValue({
      exitCode: null,
      signal: null,
      timedOut: true,
      durationMs: 599_000,
      stdout: [
        JSON.stringify({ type: "turn.started" }),
        JSON.stringify({
          type: "turn.completed",
          usage: {
            input_tokens: exactUsage.inputTokens,
            output_tokens: exactUsage.outputTokens,
            cached_input_tokens: exactUsage.cachedInputTokens,
          },
        }),
      ].join("\n"),
      stderr: "",
    });
    const reconciled = new Map<string, unknown>();
    let accountingWrites = 0;
    const recordUsage = vi.fn(async (invocationId: string, _stage: string, observed: unknown) => {
      const prior = reconciled.get(invocationId);
      if (prior) expect(prior).toEqual(observed);
      else {
        reconciled.set(invocationId, observed);
        accountingWrites += 1;
      }
    });
    const args = {
      ...f,
      backend,
      lease: {} as LeaseState,
      deadlineAt: Date.now() + 600_000,
      assertInputs: async () => {},
      admit: vi.fn(async () => {}),
      recordUsage,
      validate: async () => {},
    };

    const first = await compileEvaluatedDraft(args);
    const result = f.records.find((record) => record.kind === "result")!;
    const invocationId = String(result.payload.invocationId);
    const message = `compiler timeout: stage=inventory; evaluation timeout=600000ms; observed duration=599000ms; invocation=${invocationId}; usage: exact`;
    expect(first).toMatchObject({ status: "stopped", reason: `invalid-inventory: ${message}` });
    expect(result.payload).toMatchObject({
      usage: exactUsage,
      error: message,
      terminalOutcome: {
        state: "provider-failed",
        usage: exactUsage,
        process: { timedOut: true, durationMs: 599_000 },
      },
      timeoutDiagnostic: {
        kind: "compiler-timeout",
        stage: "inventory",
        evaluationTimeoutMs: 600_000,
        observedDurationMs: 599_000,
        invocationId,
        usage: "exact",
      },
    });
    expect(recordUsage).toHaveBeenCalledExactlyOnceWith(invocationId, "inventory", exactUsage);
    expect(accountingWrites).toBe(1);

    await expect(compileEvaluatedDraft(args)).resolves.toMatchObject({
      status: "stopped",
      reason: `invalid-inventory: ${message}`,
    });
    expect(mocks.run).toHaveBeenCalledOnce();
    expect(args.admit).toHaveBeenCalledOnce();
    expect(recordUsage).toHaveBeenCalledTimes(2);
    expect(reconciled).toEqual(new Map([[invocationId, exactUsage]]));
    expect(accountingWrites).toBe(1);

    (result.payload.terminalOutcome as { state: string }).state = "succeeded";
    await expect(compileEvaluatedDraft(args)).rejects.toThrow(
      "compiler timeout diagnostic differs from terminal evidence",
    );
    expect(mocks.run).toHaveBeenCalledOnce();
    expect(recordUsage).toHaveBeenCalledTimes(2);
  });
  it.each([
    ["string", "primitive process rejection"],
    ["null", null],
  ] as const)(
    "normalizes and durably closes a %s process-launch rejection",
    async (_name, rejection) => {
      const f = await fixture();
      const backend = new CodexCliManagementBackend({
        createCodexHome: home,
        authFile: join(f.directory, "no-auth"),
      });
      mocks.run.mockRejectedValue(rejection);

      const direct = await backend
        .extractObligations(f.context, async () => {})
        .catch((error) => error);
      expect(direct).toBeInstanceOf(Error);
      expect(direct).toMatchObject({
        message: String(rejection),
        cause: rejection,
        provenance: { baseSha: f.context.baseSha },
      });
      expect(managementTerminalOutcome(direct)).toEqual({
        state: "provider-failed",
        usage: null,
      });

      const admit = vi.fn(async () => {});
      const args = {
        ...f,
        backend,
        lease: {} as LeaseState,
        deadlineAt: Date.now() + 60_000,
        assertInputs: async () => {},
        admit,
        recordUsage: vi.fn(async () => {}),
        validate: async () => {},
      };
      await expect(compileEvaluatedDraft(args)).resolves.toMatchObject({
        status: "stopped",
        reason: "accounting-unavailable",
      });
      expect(f.records.find((record) => record.kind === "result")?.payload).toMatchObject({
        error: String(rejection),
        usage: null,
        terminalOutcome: { state: "provider-failed", usage: null },
        provenance: { baseSha: f.context.baseSha },
      });
      const dispatched = mocks.run.mock.calls.length;
      await expect(compileEvaluatedDraft(args)).resolves.toMatchObject({
        status: "stopped",
        reason: "accounting-unavailable",
      });
      expect(mocks.run).toHaveBeenCalledTimes(dispatched);
      expect(admit).toHaveBeenCalledOnce();
    },
  );
  it("durably closes a reserved invocation when admission proves no provider dispatch", async () => {
    const f = await fixture();
    const backend = new CodexCliManagementBackend({
      createCodexHome: home,
      authFile: join(f.directory, "no-auth"),
    });
    const admissionFailure = new Error("budget reservation was withdrawn");
    const admit = vi.fn(async () => {
      throw admissionFailure;
    });
    const abandonNotInvoked = vi.fn(async () => {});
    const recordUsage = vi.fn(async () => {});
    const args = {
      ...f,
      backend,
      lease: {} as LeaseState,
      deadlineAt: Date.now() + 60_000,
      assertInputs: async () => {},
      admit,
      abandonNotInvoked,
      recordUsage,
      validate: async () => {},
    };

    await expect(compileEvaluatedDraft(args)).resolves.toMatchObject({
      status: "stopped",
      reason: "compiler admission rejected before provider dispatch",
    });
    const invocation = f.records.find((record) => record.kind === "invocation")!;
    expect(abandonNotInvoked).toHaveBeenCalledExactlyOnceWith(
      invocation.payload.invocationId,
      admissionFailure.message,
    );
    expect(f.records.find((record) => record.kind === "result")?.payload).toMatchObject({
      invocationId: invocation.payload.invocationId,
      usage: null,
      value: null,
      preProviderTerminal: true,
      stopReason: "compiler admission rejected before provider dispatch",
    });
    expect(mocks.run).not.toHaveBeenCalled();
    expect(recordUsage).not.toHaveBeenCalled();

    await expect(compileEvaluatedDraft(args)).resolves.toMatchObject({
      status: "stopped",
      reason: "compiler admission rejected before provider dispatch",
    });
    expect(admit).toHaveBeenCalledOnce();
    expect(abandonNotInvoked).toHaveBeenCalledOnce();
    expect(mocks.run).not.toHaveBeenCalled();
  });
  it.each([0, 1])(
    "preserves a structured quota failure when isolated-home cleanup fails after exit %i",
    async (exitCode) => {
      const f = await fixture();
      const cleanupFailure = new Error("isolated home cleanup failed");
      let refusalCheckpointed = false;
      const backend = new CodexCliManagementBackend({
        createCodexHome: home,
        removeCodexHome: async () => {
          expect(refusalCheckpointed).toBe(false);
          throw cleanupFailure;
        },
        authFile: join(f.directory, "no-auth"),
      });
      const providerMessage =
        "You've reached your additional usage limit for your plan. Go to https://github.com/settings/copilot/features for more details.";
      mocks.run.mockResolvedValue({
        exitCode,
        stderr: "",
        stdout: [
          JSON.stringify({ type: "turn.failed", error: { message: providerMessage } }),
          JSON.stringify({
            type: "turn.completed",
            usage: { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens },
          }),
        ].join("\n"),
      });
      let observed: unknown;
      try {
        await backend.proposePlan(
          f.request,
          async () => {},
          semanticProjectionContext(undefined, f.context.runPolicy),
          async () => ({
            modelInvocationId: "compile-fixture",
            checkpointProviderRefusal: async (error) => {
              expect(error).toMatchObject({
                invocationId: "compile-fixture",
                usage,
                cleanupDiagnostic: cleanupFailure.message,
                cause: cleanupFailure,
              });
              refusalCheckpointed = true;
            },
          }),
          f.context,
        );
      } catch (error) {
        observed = error;
      }
      expect(observed).toBeInstanceOf(ProviderQuotaError);
      expect(observed).toMatchObject({
        gate: {
          reasonCode: "provider-quota-exhausted",
          provider: "github-copilot",
        },
        usage,
        invocationId: "compile-fixture",
        cause: cleanupFailure,
        cleanupDiagnostic: cleanupFailure.message,
      });
      expect(refusalCheckpointed).toBe(true);
    },
  );
  it("retains exact paid output and provenance when isolated-home cleanup fails", async () => {
    const f = await fixture();
    const cleanupFailure = new Error("isolated home cleanup failed");
    const backend = new CodexCliManagementBackend({
      createCodexHome: home,
      removeCodexHome: async () => {
        throw cleanupFailure;
      },
      authFile: join(f.directory, "no-auth"),
    });
    mocks.run.mockResolvedValue({
      exitCode: 0,
      stderr: "",
      stdout: [
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: JSON.stringify(f.proposal) },
        }),
        JSON.stringify({
          type: "turn.completed",
          usage: { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens },
        }),
      ].join("\n"),
    });
    const checkpoint = vi.fn(async () => {});
    let observed: unknown;
    try {
      await backend.proposePlan(
        f.request,
        checkpoint,
        semanticProjectionContext(undefined, f.context.runPolicy),
        async () => {},
        f.context,
      );
    } catch (error) {
      observed = error;
    }
    expect(observed).toBeInstanceOf(ManagementCleanupError);
    expect(observed).toMatchObject({
      usage,
      proposal: f.proposal,
      provenance: {
        baseSha: f.request.baseSha,
        promptDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        schemaDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    expect((observed as Error).cause).toBe(cleanupFailure);
    expect(managementTerminalOutcome(observed)).toEqual({ state: "succeeded", usage });
    expect(checkpoint).not.toHaveBeenCalled();
  });
  it.each([
    {
      name: "provider failure with exact usage",
      state: "provider-failed" as const,
      cleanup: "primitive cleanup rejection",
      exitCode: 1,
      response: "partial-provider-response",
      stdout: [
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "partial-provider-response" },
        }),
        JSON.stringify({
          type: "turn.completed",
          usage: { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens },
        }),
        JSON.stringify({ type: "turn.failed", error: { message: "provider request failed" } }),
      ].join("\n"),
    },
    {
      name: "invalid response with exact usage",
      state: "invalid-response" as const,
      cleanup: null,
      exitCode: 0,
      response: "not-json",
      stdout: [
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "not-json" },
        }),
        JSON.stringify({
          type: "turn.completed",
          usage: { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens },
        }),
      ].join("\n"),
    },
  ])("preserves provider and primitive cleanup causes for $name", async (testCase) => {
    const f = await fixture();
    const finish = vi.fn(async () => {});
    const backend = new CodexCliManagementBackend({
      createCodexHome: home,
      removeCodexHome: async () => {
        throw testCase.cleanup;
      },
      authFile: join(f.directory, "no-auth"),
      transcriptRecorder: { begin: async () => ({ finish }) },
    });
    mocks.run.mockResolvedValue({
      exitCode: testCase.exitCode,
      signal: null,
      timedOut: false,
      durationMs: 25,
      stderr: "",
      stdout: testCase.stdout,
    });

    const observed = await backend
      .proposePlan(
        f.request,
        async () => {},
        semanticProjectionContext(undefined, f.context.runPolicy),
        async () => ({
          modelInvocationId: "cleanup-dual-cause",
          checkpointProviderRefusal: async () => {},
        }),
        f.context,
      )
      .catch((error) => error);
    expect(observed).toBeInstanceOf(ManagementFailureCleanupError);
    expect(observed).toMatchObject({
      usage,
      cleanupError: { message: String(testCase.cleanup), cause: testCase.cleanup },
      cleanupDiagnostic: String(testCase.cleanup),
      provenance: { baseSha: f.request.baseSha },
      responseBytes: Buffer.byteLength(testCase.response, "utf8"),
      responseBytesSource: "provider-final-response",
    });
    expect(observed.cause).toBeInstanceOf(AggregateError);
    expect((observed.cause as AggregateError).errors).toEqual([
      observed.primaryError,
      observed.cleanupError,
    ]);
    expect(managementTerminalOutcome(observed)).toEqual({
      state: testCase.state,
      usage,
    });
    await vi.waitFor(() => expect(finish).toHaveBeenCalledOnce());
    expect(finish).toHaveBeenCalledWith(
      expect.objectContaining({
        state: testCase.state,
        usage,
        error: observed.providerDiagnostic,
      }),
    );
    expect(observed.message).toBe(observed.providerDiagnostic);
    expect(observed.providerDiagnostic).not.toBe(observed.cleanupDiagnostic);
  });

  it.each([
    ["string", "primitive cleanup rejection"],
    ["null", null],
  ] as const)(
    "durably separates a %s cleanup rejection from an unknown-usage provider failure",
    async (_name, cleanupRejection) => {
      const f = await fixture();
      const backend = new CodexCliManagementBackend({
        createCodexHome: home,
        removeCodexHome: async () => {
          throw cleanupRejection;
        },
        authFile: join(f.directory, "no-auth"),
      });
      mocks.run.mockRejectedValue(new Error("provider transport unavailable"));
      const admit = vi.fn(async () => {});
      const args = {
        ...f,
        backend,
        lease: {} as LeaseState,
        deadlineAt: Date.now() + 60_000,
        assertInputs: async () => {},
        admit,
        recordUsage: vi.fn(async () => {}),
        validate: async () => {},
      };

      await expect(compileEvaluatedDraft(args)).resolves.toMatchObject({
        status: "stopped",
        reason: "accounting-unavailable",
      });
      expect(f.records.find((record) => record.kind === "result")?.payload).toMatchObject({
        error: "provider transport unavailable",
        cleanupDiagnostic: String(cleanupRejection),
        usage: null,
        terminalOutcome: { state: "provider-failed", usage: null },
      });
      const dispatched = mocks.run.mock.calls.length;
      await expect(compileEvaluatedDraft(args)).resolves.toMatchObject({
        status: "stopped",
        reason: "accounting-unavailable",
      });
      expect(mocks.run).toHaveBeenCalledTimes(dispatched);
      expect(admit).toHaveBeenCalledOnce();
    },
  );
  it.each([0, 1])(
    "preserves a structured quota failure when its durable checkpoint fails after exit %i",
    async (exitCode) => {
      const f = await fixture();
      const checkpointFailure = new Error("provider gate checkpoint unavailable");
      const backend = new CodexCliManagementBackend({
        createCodexHome: home,
        authFile: join(f.directory, "no-auth"),
      });
      const providerMessage =
        "You've reached your additional usage limit for your plan. Go to https://github.com/settings/copilot/features for more details.";
      mocks.run.mockResolvedValue({
        exitCode,
        stderr: "",
        stdout: [
          JSON.stringify({ type: "turn.failed", error: { message: providerMessage } }),
          JSON.stringify({
            type: "turn.completed",
            usage: { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens },
          }),
        ].join("\n"),
      });
      let observed: unknown;
      try {
        await backend.proposePlan(
          f.request,
          async () => {},
          semanticProjectionContext(undefined, f.context.runPolicy),
          async () => ({
            modelInvocationId: "compile-checkpoint-failure",
            checkpointProviderRefusal: async () => {
              throw checkpointFailure;
            },
          }),
          f.context,
        );
      } catch (error) {
        observed = error;
      }
      expect(observed).toBeInstanceOf(ProviderQuotaError);
      expect(observed).toMatchObject({
        gate: { reasonCode: "provider-quota-exhausted", provider: "github-copilot" },
        usage,
        invocationId: "compile-checkpoint-failure",
        cause: checkpointFailure,
      });
    },
  );
  it("rechecks cancellation after all local preparation and before durable invocation or provider admission", async () => {
    const f = await fixture();
    const cancellation = new Error("activation withdrawn during local preparation");
    const backend = new CodexCliManagementBackend({
      createCodexHome: home,
      authFile: join(f.directory, "no-auth"),
    });
    const admit = vi.fn(async () => {});
    const assertInputs = vi.fn(async () => {
      expect(mocks.resolve).toHaveBeenCalledOnce();
      expect(mocks.environment).toHaveBeenCalledOnce();
      throw cancellation;
    });
    await expect(
      compileEvaluatedDraft({
        ...f,
        backend,
        lease: {} as LeaseState,
        deadlineAt: Date.now() + 60_000,
        assertInputs,
        admit,
        recordUsage: async () => {},
        validate: async () => {},
      }),
    ).rejects.toBe(cancellation);
    expect(admit).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
    expect(f.records.map((record) => record.kind)).toEqual(["started", "source-evidence"]);
  });
  it("reserves only at actual dispatch and applies the remaining deadline to the process timeout", async () => {
    const f = await fixture();
    f.context.objective.body = `Implement core behavior\n${"bounded context ".repeat(12_000)}`;
    f.context.repositoryEvidence = compilerObligationEvidence(f.context);
    f.inventory.objectiveDigest = compilerEvalDigest(f.context.objective);
    f.inventory.evidence = f.context.repositoryEvidence;
    f.binding.inputDigest = f.inventory.objectiveDigest;
    let clock = Date.now();
    const start = clock;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    let preparedHome = "";
    const backend = new CodexCliManagementBackend({
      createCodexHome: async () => {
        clock += 2000;
        preparedHome = await home();
        return preparedHome;
      },
      authFile: join(f.directory, "no-auth"),
    });
    const admit = vi.fn(async () => {
      await access(join(preparedHome, "output.schema.json"));
      expect(mocks.environment).toHaveBeenCalled();
      expect(f.records.at(-1)?.kind).toBe("invocation");
    });
    mocks.run.mockImplementation(
      async (args: {
        args: string[];
        stdin: { text: string; maxBytes: number };
        timeoutMs: number;
      }) => {
        expect(admit).toHaveBeenCalled();
        expect(args.timeoutMs).toBe(8000);
        expect(args.args.at(-1)).toBe("-");
        expect(args.args).not.toContain(args.stdin.text);
        expect(args.stdin.maxBytes).toBe(1024 * 1024);
        expect(args.stdin.text).toContain("bounded context");
        expect(Buffer.byteLength(args.stdin.text, "utf8")).toBeGreaterThan(128 * 1024);
        return {
          exitCode: 0,
          stderr: "",
          stdout: [
            JSON.stringify({
              type: "item.completed",
              item: {
                type: "agent_message",
                text: JSON.stringify({
                  version: f.inventory.version,
                  obligations: f.inventory.obligations,
                }),
              },
            }),
            JSON.stringify({
              type: "turn.completed",
              usage: { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens },
            }),
          ].join("\n"),
        };
      },
    );
    // Stop after the first known provider call: cancellation at the next phase must not launch again.
    const args = {
      ...f,
      backend,
      lease: {} as LeaseState,
      deadlineAt: start + 10_000,
      assertInputs: async () => {
        if (mocks.run.mock.calls.length) throw new Error("stop after extraction");
      },
      admit,
      recordUsage: vi.fn(async () => {}),
      validate: async () => {},
    };
    await expect(compileEvaluatedDraft(args)).rejects.toThrow("stop after extraction");
    expect(mocks.run).toHaveBeenCalledOnce();
    expect(admit).toHaveBeenCalledOnce();
    expect(f.records.filter((record) => record.kind === "invocation")).toHaveLength(1);
    expect(f.records.filter((record) => record.kind === "result")).toHaveLength(1);
  });
});
