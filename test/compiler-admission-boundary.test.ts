import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CodexCliManagementBackend,
  compilerObligationEvidence,
} from "../src/management/codex-cli.js";
import { compileEvaluatedDraft } from "../src/management/draft-compilation.js";
import { compiledGraphDigest } from "../src/graph.js";
import {
  COMPILER_JUDGE_DIMENSIONS,
  compilerEvalDigest,
  type CompilerJudgeVerdict,
  type ObligationInventory,
} from "../src/evaluation/compiler-eval.js";
import type { CompilationContext } from "../src/management/backend.js";
import { DEFAULT_RUN_POLICY, policyDigest } from "../src/protocol/policy.js";
import type {
  CompilerDraftBinding,
  CompilerDraftManager,
  CompilerDraftRecord,
} from "../src/control/compiler-drafts.js";
import type { LeaseState } from "../src/control/lease.js";
const mocks = vi.hoisted(() => ({ resolve: vi.fn(), run: vi.fn(), environment: vi.fn() }));
vi.mock("../src/runtime/codex-command.js", () => ({ resolveCodexCommand: mocks.resolve }));
vi.mock("../src/runtime/process-group.js", async (original) => ({
  ...(await original<typeof import("../src/runtime/process-group.js")>()),
  runContainedProcess: mocks.run,
}));
vi.mock("../src/runtime/codex-home.js", async (original) => ({
  ...(await original<typeof import("../src/runtime/codex-home.js")>()),
  isolateCodexEnvironment: mocks.environment,
}));
const directories: string[] = [];
beforeEach(() => {
  mocks.resolve.mockReset().mockResolvedValue({ command: "fixture-codex", args: [] });
  mocks.run.mockReset();
  mocks.environment.mockReset().mockImplementation((env: Record<string, string>) => env);
});
afterEach(async () => {
  vi.restoreAllMocks();
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
  const context: CompilationContext = {
    repository: directory,
    objective: { number: 42, title: golden.title, body: "Implement core behavior and tests" },
    baseSha: golden.baseSha,
    defaultBranch: "main",
    repositoryFiles: golden.repositoryFacts.files.map((file: { path: string }) => file.path),
    allowedNetworkDestinations: [],
    runPolicy: { ...DEFAULT_RUN_POLICY, compilerEvaluation: { mode: "report-only" } },
  };
  context.repositoryEvidence = compilerObligationEvidence(context);
  const proposal = {
    title: golden.title,
    workItems: golden.workItems.map((item: { acceptance: string[] }) => ({
      ...item,
      criterionRisks: item.acceptance.map((criterion) => ({ criterion, risk: "ordinary" })),
    })),
  };
  const graph = (
    await new CodexCliManagementBackend({
      runStructured: async () => ({ value: proposal, usage: { inputTokens: 1, outputTokens: 1 } }),
    }).compile(context, async () => {})
  ).objective;
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
        acceptanceBindings: [
          { itemId: graph.workItems[0]!.id, criterion: graph.workItems[0]!.acceptance[0]! },
        ],
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
    dependencies: graph.workItems.flatMap((item) =>
      item.dependsOn.map((dependsOn) => ({
        itemId: item.id,
        dependsOn,
        reason: "Producer output",
        evidenceIds: ["objective"],
      })),
    ),
    findings: [],
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
        protocol: "clockgrove.factory/compiler-draft-v1",
        binding,
        sequence,
        kind,
        payload: structuredClone(payload),
      };
      records.push(record);
      return structuredClone(record);
    },
  } as unknown as CompilerDraftManager;
  return { context, graph, inventory, verdict, binding, records, manager, directory };
}
async function home() {
  const path = await mkdtemp(join(tmpdir(), "compiler-prepared-home-"));
  directories.push(path);
  return path;
}
const usage = { inputTokens: 4, outputTokens: 2 };
describe("compiler dispatch admission", () => {
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
            ? () => backend.compile(f.context, async () => {}, before)
            : stage === "judge"
              ? () =>
                  backend.judgePlan(
                    { compilation: f.context, inventory: f.inventory, objective: f.graph },
                    async () => {},
                    before,
                  )
              : () =>
                  backend.repairPlan(
                    {
                      compilation: f.context,
                      inventory: f.inventory,
                      objective: f.graph,
                      verdict: f.verdict,
                      revision: 1,
                    },
                    async () => {},
                    before,
                  );
      await expect(call()).rejects.toBe(error);
      expect(before).not.toHaveBeenCalled();
      expect(mocks.run).not.toHaveBeenCalled();
    },
  );
  it.each(["prompt", "home", "command", "environment"] as const)(
    "retains no invocation or model budget admission after known %s preparation failure",
    async (stage) => {
      const f = await fixture();
      const failure = new Error(`${stage} preparation failed`);
      if (stage === "command") mocks.resolve.mockRejectedValue(failure);
      if (stage === "environment")
        mocks.environment.mockImplementation(() => {
          throw failure;
        });
      if (stage === "prompt") f.context.objective.body = "x".repeat(600_000);
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
      ).rejects.toThrow(stage === "prompt" ? /exceeds|bytes/ : failure.message);
      expect(admit).not.toHaveBeenCalled();
      expect(recordUsage).not.toHaveBeenCalled();
      expect(mocks.run).not.toHaveBeenCalled();
      expect(f.records.map((record) => record.kind)).toEqual(["started"]);
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
    expect(f.records.map((record) => record.kind)).toEqual(["started"]);
  });
  it("reserves only at actual dispatch and applies the remaining deadline to the process timeout", async () => {
    const f = await fixture();
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
    mocks.run.mockImplementation(async (args: { timeoutMs: number }) => {
      expect(admit).toHaveBeenCalled();
      expect(args.timeoutMs).toBe(8000);
      return {
        exitCode: 0,
        stderr: "",
        stdout: [
          JSON.stringify({
            type: "item.completed",
            item: { type: "agent_message", text: JSON.stringify(f.inventory) },
          }),
          JSON.stringify({
            type: "turn.completed",
            usage: { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens },
          }),
        ].join("\n"),
      };
    });
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
