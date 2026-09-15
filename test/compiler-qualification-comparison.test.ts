import { describe, expect, it } from "vitest";
import {
  compareCompilerQualificationPair,
  compilerQualificationScenarioDigest,
} from "../scripts/qualification-compiler-comparison.mjs";

function arm(commit: string, inputTokens: number, promptBytes = 400) {
  const model = "gpt-5.6-sol";
  const reasoning = "xhigh";
  const scenarioSpec = {
    protocol: "clockgrove.factory/compiler-qualification-scenario-v1",
    fixture: {
      baseSha: "f".repeat(40),
      files: [
        {
          path: "package.json",
          mode: "100644",
          bytes: 84,
          sha256: "1".repeat(64),
        },
      ],
    },
    objective: {
      number: 4041,
      title: "Add deterministic slug normalization",
      body: "Implement the exact slug behavior and tests.",
    },
    allowedNetworkDestinations: [] as string[],
    runPolicy: {
      allowedNetworkDestinations: [],
      workItemTimeoutMinutes: 20,
      compilerEvaluation: { mode: "auto-repair", maxRepairs: 2 },
    },
    modelSelection: { profile: "issue404-qualification", model, reasoning },
    responseTransformations: [] as Array<{
      stage: "compile" | "repair";
      revision: number;
      kind: "omit-obligation";
      obligationId: string;
    }>,
  };
  return {
    candidateSha: commit.repeat(40),
    model,
    reasoning,
    cases: [
      {
        name: "valid-first",
        sourceBaseSha: scenarioSpec.fixture.baseSha,
        scenarioSpec,
        scenarioDigest: compilerQualificationScenarioDigest(scenarioSpec),
        status: "accepted",
        transcripts: [
          {
            stage: "compile",
            revision: 0,
            modelInvocationId: `compiler-${commit}-compile`,
            promptBytes,
            provenance: {
              promptDigest: "2".repeat(64),
              schemaDigest: "3".repeat(64),
              baseSha: scenarioSpec.fixture.baseSha,
              model,
              reasoning,
            },
          },
          {
            stage: "judge",
            revision: 0,
            modelInvocationId: `compiler-${commit}-judge`,
            promptBytes: 200,
            provenance: {
              promptDigest: "4".repeat(64),
              schemaDigest: "5".repeat(64),
              baseSha: scenarioSpec.fixture.baseSha,
              model,
              reasoning,
            },
          },
        ],
        tokenUsageByStage: [
          {
            stage: "compile",
            revision: 0,
            tokens: {
              availability: "observed",
              inputTokens,
              outputTokens: 20,
              cachedInputTokens: 10,
              cachedInputAvailability: "observed",
            },
          },
          {
            stage: "judge",
            revision: 0,
            tokens: {
              availability: "observed",
              inputTokens: 80,
              outputTokens: 10,
              cachedInputTokens: 5,
              cachedInputAvailability: "observed",
            },
          },
        ],
      },
    ],
  };
}

describe("compiler paired qualification comparison", () => {
  it("binds exact SHAs and identical scenarios while reporting exact per-stage deltas", () => {
    const result = compareCompilerQualificationPair(arm("a", 100), arm("b", 90, 380));
    expect(result).toMatchObject({
      status: "measured",
      baselineSha: "a".repeat(40),
      candidateSha: "b".repeat(40),
      model: "gpt-5.6-sol",
      reasoning: "xhigh",
      scenarios: [
        {
          stageComparisons: expect.arrayContaining([
            expect.objectContaining({
              baseline: expect.objectContaining({
                modelInvocationId: "compiler-a-compile",
                provenance: expect.objectContaining({ baseSha: "f".repeat(40) }),
              }),
              candidate: expect.objectContaining({
                modelInvocationId: "compiler-b-compile",
                provenance: expect.objectContaining({ baseSha: "f".repeat(40) }),
              }),
            }),
          ]),
          baseline: { totals: { promptBytes: 600, inputTokens: 180 } },
          candidate: { totals: { promptBytes: 580, inputTokens: 170 } },
          delta: { promptBytes: -20, inputTokens: -10 },
        },
      ],
    });
  });

  it("reports the absent baseline without inventing token values", () => {
    expect(compareCompilerQualificationPair(null, arm("b", 90))).toMatchObject({
      status: "unavailable",
      baseline: null,
      reason: "no authoritative exact-token baseline artifact was supplied",
    });
  });

  it.each([
    [
      "model-visible path",
      (spec: ReturnType<typeof arm>["cases"][number]["scenarioSpec"]) => {
        spec.fixture.files[0]!.path = "package-renamed.json";
      },
    ],
    [
      "model-visible mode",
      (spec: ReturnType<typeof arm>["cases"][number]["scenarioSpec"]) => {
        spec.fixture.files[0]!.mode = "100755";
      },
    ],
    [
      "model-visible content",
      (spec: ReturnType<typeof arm>["cases"][number]["scenarioSpec"]) => {
        spec.fixture.files[0]!.sha256 = "9".repeat(64);
      },
    ],
    [
      "Objective number",
      (spec: ReturnType<typeof arm>["cases"][number]["scenarioSpec"]) => {
        spec.objective.number += 1;
      },
    ],
    [
      "Objective text",
      (spec: ReturnType<typeof arm>["cases"][number]["scenarioSpec"]) => {
        spec.objective.body += " Changed.";
      },
    ],
    [
      "allowed network",
      (spec: ReturnType<typeof arm>["cases"][number]["scenarioSpec"]) => {
        spec.allowedNetworkDestinations.push("api.example.test");
      },
    ],
    [
      "run policy",
      (spec: ReturnType<typeof arm>["cases"][number]["scenarioSpec"]) => {
        spec.runPolicy.workItemTimeoutMinutes += 1;
      },
    ],
    [
      "model profile",
      (spec: ReturnType<typeof arm>["cases"][number]["scenarioSpec"]) => {
        spec.modelSelection.profile = "different-profile";
      },
    ],
    [
      "fault transformation",
      (spec: ReturnType<typeof arm>["cases"][number]["scenarioSpec"]) => {
        spec.responseTransformations.push({
          stage: "compile",
          revision: 0,
          kind: "omit-obligation",
          obligationId: "explicit-contract",
        });
      },
    ],
  ])("rejects an independently changed %s", (_label, mutate) => {
    const baseline = arm("a", 100);
    const changed = arm("b", 90);
    mutate(changed.cases[0]!.scenarioSpec);
    changed.cases[0]!.scenarioDigest = compilerQualificationScenarioDigest(
      changed.cases[0]!.scenarioSpec,
    );
    expect(() => compareCompilerQualificationPair(baseline, changed)).toThrow(
      "paired scenarios differ",
    );
  });

  it("requires both exact-SHA arms to share the same canonical fixture base", () => {
    const baseline = arm("a", 100);
    const changed = arm("b", 90);
    const nextBase = "e".repeat(40);
    changed.cases[0]!.scenarioSpec.fixture.baseSha = nextBase;
    changed.cases[0]!.sourceBaseSha = nextBase;
    for (const transcript of changed.cases[0]!.transcripts)
      transcript.provenance.baseSha = nextBase;
    changed.cases[0]!.scenarioDigest = compilerQualificationScenarioDigest(
      changed.cases[0]!.scenarioSpec,
    );
    expect(() => compareCompilerQualificationPair(baseline, changed)).toThrow(
      "paired scenarios differ",
    );
  });

  it("rejects authority metadata in the model-visible fixture", () => {
    const candidate = arm("b", 90);
    candidate.cases[0]!.scenarioSpec.fixture.files[0]!.path =
      ".factory-issue404-qualification.json";
    candidate.cases[0]!.scenarioDigest = compilerQualificationScenarioDigest(
      candidate.cases[0]!.scenarioSpec,
    );
    expect(() => compareCompilerQualificationPair(null, candidate)).toThrow(
      "authority marker entered fixture",
    );
  });

  it("rejects a stale scenario digest and incomplete exact token evidence", () => {
    const baseline = arm("a", 100);
    const stale = arm("b", 90);
    stale.cases[0]!.scenarioSpec.objective.body += " Changed.";
    expect(() => compareCompilerQualificationPair(baseline, stale)).toThrow(
      "scenario digest differs from its full spec",
    );
    const missing = arm("b", 90);
    missing.cases[0]!.tokenUsageByStage[0]!.tokens.cachedInputAvailability = "unknown";
    expect(() => compareCompilerQualificationPair(baseline, missing)).toThrow(
      "cached token usage unavailable",
    );
  });
});
