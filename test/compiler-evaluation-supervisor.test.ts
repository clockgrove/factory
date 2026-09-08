import { describe, expect, it, vi } from "vitest";
import { providerSupervisorFixture } from "./helpers/provider-supervisor.js";
import { CompiledGraphManager } from "../src/control/graphs.js";
import { GitHubControlStore } from "../src/control/github-store.js";
import { PlatformUnavailableError } from "../src/platform.js";
import { compileObjective } from "../src/compiler/index.js";
import { readRepositoryFacts } from "../src/repository-profiles/index.js";
import { readCompilerObligationEvidence } from "../src/management/codex-cli.js";
import {
  COMPILER_JUDGE_DIMENSIONS,
  compilerEvalDigest,
  type CompilerJudgeVerdict,
  type ObligationInventory,
} from "../src/evaluation/compiler-eval.js";
import { compiledGraphDigest } from "../src/graph.js";

const usage = { inputTokens: 20, outputTokens: 10, cachedInputTokens: 4 };
type Fixture = Awaited<ReturnType<typeof providerSupervisorFixture>>;
function freshObjective(f: Fixture) {
  for (const ref of [...f.refs.keys()])
    if (ref.includes("/graphs/") || ref.includes("/graph-projections/")) f.refs.delete(ref);
  f.snapshot.factoryEvents = f.snapshot.factoryEvents!.filter((event) => event.kind !== "graph");
  f.snapshot.workItems = [];
  f.snapshot.body = "Create answer.txt containing the required answer.";
}
function configureCompiler(f: Fixture, decision: "accept" | "repair" = "accept") {
  const calls: string[] = [];
  f.management.extractObligations = async (context, checkpoint) => {
    calls.push("inventory");
    const inventory: ObligationInventory = {
      version: 1,
      objectiveDigest: compilerEvalDigest(context.objective),
      baseSha: context.baseSha,
      evidence: await readCompilerObligationEvidence(context),
      obligations: [
        {
          id: "answer",
          text: "Create answer.txt containing the required answer.",
          kind: "explicit",
          evidenceIds: ["objective"],
          acceptanceEvidence: "Inspect answer.txt",
        },
      ],
    };
    const result = { inventory, usage };
    await checkpoint(result);
    return result;
  };
  f.management.compile = async (context, checkpoint) => {
    calls.push("compile");
    const criterion = "answer.txt contains the required answer";
    const objective = compileObjective({
      title: context.objective.title,
      baseSha: context.baseSha,
      runPolicy: context.runPolicy,
      repositoryFacts: await readRepositoryFacts(
        context.repository,
        context.repositoryFiles,
        context.repositoryLfs,
      ),
      workItems: [
        {
          id: "answer",
          title: "Create answer",
          goal: "Create answer.txt",
          acceptance: [criterion],
          scope: ["answer.txt"],
          preconditions: [],
          outOfScope: [],
          conventions: [],
          dependsOn: [],
          baseSha: context.baseSha,
          validationCommands: ["npm test"],
          criterionRisks: [{ criterion, risk: "ordinary" }],
          validation: [
            {
              tier: "semantic",
              evidenceCommands: [],
              criteria: [criterion],
              rationale: "Inspect the required answer in the candidate artifact",
            },
          ],
          requirements: {
            os: ["linux"],
            architecture: [],
            tools: ["node"],
            services: [],
            networkDestinations: [],
            permittedSecretNames: [],
            trust: "trusted_local",
          },
          artifactContract: "clockgrove.factory/artifact-v1",
        },
      ],
    });
    const result = { objective, usage };
    await checkpoint(result);
    return result;
  };
  f.management.judgePlan = async (context, checkpoint) => {
    calls.push("judge");
    const verdict: CompilerJudgeVerdict = {
      version: 1,
      rubricVersion: 1,
      draftDigest: compiledGraphDigest(context.objective),
      inventoryDigest: compilerEvalDigest(context.inventory),
      coverage: [
        {
          obligationId: "answer",
          status: decision === "accept" ? "covered" : "missing",
          itemIds: decision === "accept" ? ["answer"] : [],
          acceptanceBindings:
            decision === "accept"
              ? [{ itemId: "answer", criterion: "answer.txt contains the required answer" }]
              : [],
          evidenceIds: ["objective"],
          reason: "Fixture coverage assessment",
        },
      ],
      items: [
        {
          itemId: "answer",
          granularity: "cohesive",
          reason: "Single deliverable",
          evidenceIds: ["objective"],
        },
      ],
      dimensions: COMPILER_JUDGE_DIMENSIONS.map((dimension) => ({
        dimension,
        status: "assessed",
        reason: "Fixture evidence",
        evidenceIds: ["objective"],
      })),
      dependencies: [],
      findings:
        decision === "accept"
          ? []
          : [
              {
                id: "missing",
                dimension: "coverage",
                severity: "blocking",
                confidence: 1,
                obligationIds: ["answer"],
                itemIds: ["answer"],
                evidenceIds: ["objective"],
                rootCause: "Required answer is missing",
                correction: "Preserve required answer",
                uncertainty: "",
              },
            ],
      uncertainty: [],
      decision,
    };
    const result = { verdict, usage };
    await checkpoint(result);
    return result;
  };
  f.management.repairPlan = async () => {
    calls.push("repair");
    throw new Error("unexpected repair in bounded report fixture");
  };
  return calls;
}
function assertNoProjection(f: Fixture) {
  expect(f.events().filter((event) => event.kind === "graph")).toEqual([]);
  expect(f.snapshot.workItems).toEqual([]);
  expect(f.activity.filter((entry) => entry.operation === "launch")).toEqual([]);
  expect(f.snapshot.closed).toBe(false);
}

describe("Supervisor compiler evaluation activation boundary", () => {
  it.each(["accept", "repair"] as const)(
    "report-only %s writes evaluation evidence without activating work",
    async (decision) => {
      const f = await providerSupervisorFixture("daytona-burst", {
        localOnly: true,
        compilerEvaluation: { mode: "report-only" },
      });
      try {
        freshObjective(f);
        const calls = configureCompiler(f, decision);
        const result = await f.run();
        expect(result.reason).toMatch(/report-only/i);
        expect(calls).toEqual(["inventory", "compile", "judge"]);
        assertNoProjection(f);
        expect([...f.refs.keys()].some((ref) => ref.includes("/graphs/"))).toBe(false);
        expect([...f.refs.keys()].some((ref) => ref.includes("/compiler-drafts/"))).toBe(true);
        const charges = f
          .events()
          .filter(
            (event) =>
              event.kind === "budget" &&
              event.event === "BudgetReconciled" &&
              event.unit === "model_tokens",
          );
        expect(charges).toHaveLength(3);
        expect(charges.every((event) => event.kind === "budget" && event.amount === 30)).toBe(true);
      } finally {
        await f.dispose();
      }
    },
    30_000,
  );

  it("report-only refuses inherited activated graphs without executing their workers", async () => {
    const f = await providerSupervisorFixture("daytona-burst", {
      localOnly: true,
      compilerEvaluation: { mode: "report-only" },
    });
    try {
      const refs = [...f.refs];
      const calls = configureCompiler(f);
      const result = await f.run();
      expect(result.reason).toMatch(/report-only/i);
      expect(calls).toEqual([]);
      expect(f.activity.filter((entry) => entry.operation === "launch")).toEqual([]);
      expect([...f.refs]).toEqual(refs);
      expect(f.snapshot.closed).toBe(false);
    } finally {
      await f.dispose();
    }
  }, 30_000);

  it("fences a changed Objective when resuming after accepted graph persistence", async () => {
    let blockProjection = false;
    const f = await providerSupervisorFixture("daytona-burst", {
      localOnly: true,
      compilerEvaluation: { mode: "auto-repair" },
      repositoryFence: async () => {
        if (blockProjection)
          throw new PlatformUnavailableError(
            { kind: "server_error", retryAfterMs: 1 },
            new Error("fixture pauses before graph projection"),
          );
      },
    });
    try {
      freshObjective(f);
      const calls = configureCompiler(f);
      const addComment = vi
        .mocked(GitHubControlStore.prototype.addIssueComment)
        .getMockImplementation()!;
      vi.mocked(GitHubControlStore.prototype.addIssueComment).mockImplementation(
        async (node, body) => {
          if (blockProjection)
            throw new PlatformUnavailableError(
              { kind: "server_error", retryAfterMs: 1 },
              new Error("fixture pauses before graph receipt"),
            );
          return addComment(node, body);
        },
      );
      const persist = CompiledGraphManager.prototype.persist;
      vi.spyOn(CompiledGraphManager.prototype, "persist").mockImplementation(async function (
        this: CompiledGraphManager,
        ...args
      ) {
        const result = await persist.apply(this, args);
        blockProjection = true;
        return result;
      });
      await expect(f.run()).rejects.toBeInstanceOf(PlatformUnavailableError);
      expect(calls).toEqual(["inventory", "compile", "judge"]);
      expect([...f.refs.keys()].some((ref) => ref.includes("/graphs/"))).toBe(true);
      assertNoProjection(f);
      blockProjection = false;
      f.snapshot.body += " Also retain compatibility with old answers.";
      const second = await f.run();
      expect(second.status).not.toBe("completed");
      expect(second.reason).toMatch(/changed|binding|inputs/i);
      expect(calls).toEqual(["inventory", "compile", "judge"]);
      assertNoProjection(f);
      expect(vi.mocked(GitHubControlStore.prototype.closeIssue)).not.toHaveBeenCalled();
    } finally {
      await f.dispose();
    }
  }, 30_000);
});
