import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { compileObjective, type CompilerWorkItemInput } from "../src/compiler/index.js";
import { CodexCliManagementBackend } from "../src/management/codex-cli.js";
import { DEFAULT_RUN_POLICY, type RunPolicy } from "../src/protocol/policy.js";
import {
  assessCompilerCorpusResult,
  compilePreparedCorpusCase,
  parseCompilerCorpus,
  prepareCompilerCorpusCase,
  type CompilerCriterionBindings,
  type PreparedCompilerCase,
} from "../src/evaluation/compiler-corpus.js";
import {
  assessToolSelection,
  parseToolSelectionCorpus,
} from "../src/evaluation/tool-selection-corpus.js";

const corpusRoot = fileURLToPath(new URL("./fixtures/evaluation", import.meta.url));
const sha = "a".repeat(40);
const corpusRunPolicy: RunPolicy = {
  ...DEFAULT_RUN_POLICY,
  workItemTimeoutMinutes: 5,
  capacity: {
    ...DEFAULT_RUN_POLICY.capacity!,
    local: {
      ...DEFAULT_RUN_POLICY.capacity!.local!,
      defaultCpu: 1,
      defaultMemoryMb: 1_024,
    },
  },
};
const prepared: PreparedCompilerCase[] = [];
const execute = promisify(execFile);
const require = createRequire(import.meta.url);
afterEach(async () => {
  await Promise.all(prepared.splice(0).map((fixture) => fixture.dispose()));
});
async function fixture(id: string) {
  const value = await prepareCompilerCorpusCase(corpusRoot, id);
  prepared.push(value);
  return value;
}
const compilerManifest = async () =>
  JSON.parse(await readFile(join(corpusRoot, "compiler.json"), "utf8"));
const toolManifest = async () =>
  JSON.parse(await readFile(join(corpusRoot, "tool-selection.json"), "utf8"));
function item(
  value: PreparedCompilerCase,
  id: string,
  scope: string[],
  dependsOn: string[] = [],
): CompilerWorkItemInput {
  const criteria = value.entry.criteria;
  const tiers = ["mechanical", "semantic", "visual", "deterministic-simulation"] as const;
  return {
    id,
    title: `Implement ${id}`,
    goal: value.entry.objective,
    acceptance: criteria.map((criterion) => criterion.text),
    scope,
    dependsOn,
    preconditions: [],
    outOfScope: [],
    conventions: [],
    baseSha: sha,
    validationCommands: value.commands,
    criterionRisks: criteria.map((criterion) => ({ criterion: criterion.text, risk: "ordinary" })),
    validation: tiers.flatMap((tier) => {
      const routed = criteria.filter((criterion) => criterion.tiers.includes(tier));
      if (!routed.length) return [];
      return [
        {
          tier,
          criteria: routed.map((criterion) => criterion.text),
          rationale: `The corpus manifest explicitly assigns these criteria to ${tier} validation.`,
          evidenceCommands:
            tier === "semantic"
              ? []
              : [...new Set(routed.flatMap((criterion) => criterion.commands))],
        },
      ];
    }),
    requirements: {
      os: ["linux"],
      architecture: ["x64"],
      tools: ["node", "npm"],
      services: [],
      networkDestinations: [],
      permittedSecretNames: [],
      trust: "trusted_local",
      cpu: 1,
      memoryMb: 512,
      timeoutMinutes: 5,
      estimatedDurationMinutes: 5,
    },
    artifactContract: "clockgrove.factory/artifact-v1",
  };
}
function combined(value: PreparedCompilerCase) {
  return compileObjective({
    title: value.entry.title,
    baseSha: sha,
    repositoryFacts: value.facts,
    runPolicy: corpusRunPolicy,
    workItems: [
      item(
        value,
        "capability",
        value.inventory.map((file) => file.path),
      ),
    ],
  });
}
function bindings(value: PreparedCompilerCase): CompilerCriterionBindings {
  const acceptance = value.entry.criteria.map((criterion) => criterion.text).sort();
  return value.entry.criteria.map((criterion) => ({
    criterionId: criterion.id,
    acceptance: [{ workItemId: "capability", index: acceptance.indexOf(criterion.text) }],
    rationale:
      "Unit fixture binds this exact acceptance statement; no model quality or semantic result is claimed.",
  }));
}

describe("representative executable corpus integrity, not compiler/model quality", () => {
  it.each([
    "typed-cart",
    "generated-catalog",
    "binary-module",
    "seeded-simulation",
    "visual-status",
  ])(
    "discovers, executes and structurally consumes %s",
    async (id) => {
      const value = await fixture(id);
      expect(value.fixtureDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(value.commands).toContain(value.entry.baseline.command);
      // Offline fixture execution only, after integration. Tooling comes from this repository's install.
      const { stdout } = await execute("npm", ["--silent", "test"], {
        cwd: value.repository,
        env: {
          ...process.env,
          PATH: `${dirname(require.resolve("typescript/bin/tsc"))}:${process.env.PATH ?? ""}`,
        },
        timeout: 30_000,
        maxBuffer: 64 * 1024,
      });
      expect(stdout).toBe(value.entry.baseline.stdout);
      const result = assessCompilerCorpusResult(value, combined(value), bindings(value), sha);
      expect(result).toMatchObject({
        level: "compiler-corpus-structural",
        semanticReviewRequired: true,
        installedExecutionProven: false,
        economicBenefitMeasured: false,
      });
      if (id === "binary-module") {
        expect(value.profile.binaryAssets).toBe(true);
        expect(await readFile(join(value.repository, "assets/answer.wasm"))).toEqual(
          Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]),
        );
        expect(value.sourceDigest).not.toBe(value.fixtureDigest);
      }
      if (id === "generated-catalog") expect(value.profile.generatedOutput).toBe(true);
      if (id === "seeded-simulation") expect(value.profile.deterministicSimulation).toBe(true);
      if (id === "visual-status") expect(value.profile.visualValidation).toBe(true);
    },
    30_000,
  );

  it("accepts both combined and criterion-bound split decompositions", async () => {
    const value = await fixture("typed-cart");
    expect(
      assessCompilerCorpusResult(value, combined(value), bindings(value), sha).criteria,
    ).toHaveLength(2);
    const graph = compileObjective({
      title: value.entry.title,
      baseSha: sha,
      repositoryFacts: value.facts,
      runPolicy: corpusRunPolicy,
      workItems: [
        item(value, "discount", ["src/cart.ts"]),
        item(value, "regression", ["check.mjs", "tsconfig.json"], ["discount"]),
      ],
    });
    const split = value.entry.criteria.map((criterion) => ({
      criterionId: criterion.id,
      acceptance: [
        {
          workItemId: criterion.id,
          index: graph.workItems
            .find((entry) => entry.id === criterion.id)!
            .acceptance.indexOf(criterion.text),
        },
      ],
      rationale: "The split item owns the criterion paths and references its concrete acceptance.",
    }));
    expect(assessCompilerCorpusResult(value, graph, split, sha).criteria).toEqual([
      "discount",
      "regression",
    ]);
    graph.workItems.find((entry) => entry.id === "regression")!.dependsOn = [];
    graph.workItems.find((entry) => entry.id === "regression")!.delivery = {
      relationship: "root",
      group: "regression",
    };
    expect(() => assessCompilerCorpusResult(value, graph, split, sha)).toThrow(/prerequisite/);
  });

  it("feeds the human Objective and real facts through the existing management adapter", async () => {
    const value = await fixture("generated-catalog");
    let observedPrompt = "";
    let checkpoints = 0;
    const backend = new CodexCliManagementBackend({
      runStructured: async (cwd, _schema, prompt) => {
        expect(cwd).toBe(value.repository);
        observedPrompt = prompt;
        // Injected provider result checks wiring only; this is not an actual compiler evaluation.
        return {
          value: {
            title: value.entry.title,
            workItems: [
              item(
                value,
                "capability",
                value.inventory.map((file) => file.path),
              ),
            ],
          },
          usage: { inputTokens: 0, outputTokens: 0 },
        };
      },
    });
    const result = await compilePreparedCorpusCase(
      value,
      {
        objectiveNumber: 17,
        baseSha: sha,
        defaultBranch: "main",
        allowedNetworkDestinations: [],
        runPolicy: corpusRunPolicy,
      },
      backend,
      async () => {
        checkpoints++;
      },
    );
    expect(observedPrompt).toContain(value.entry.objective);
    expect(observedPrompt).toContain("generated/status.mjs");
    expect(observedPrompt).toContain("npm run generate");
    expect(checkpoints).toBe(1);
    expect(
      assessCompilerCorpusResult(value, result.objective, bindings(value), sha)
        .installedExecutionProven,
    ).toBe(false);
    await writeFile(join(value.repository, "data/status.json"), "{}\n");
    await expect(
      compilePreparedCorpusCase(
        value,
        {
          objectiveNumber: 17,
          baseSha: sha,
          defaultBranch: "main",
          allowedNetworkDestinations: [],
          runPolicy: corpusRunPolicy,
        },
        backend,
        async () => {},
      ),
    ).rejects.toThrow(/changed before compilation/);
    expect(checkpoints).toBe(1);
  });

  it("rejects malformed or contradictory manifests", async () => {
    const manifest = await compilerManifest();
    const invalid = structuredClone(manifest);
    invalid.cases[0].criteria[0].after = [invalid.cases[0].criteria[1].id];
    expect(() => parseCompilerCorpus(invalid)).toThrow(/cyclic/);
    invalid.cases[0].criteria[0].after = ["absent"];
    expect(() => parseCompilerCorpus(invalid)).toThrow(/unknown/);
    invalid.cases[0].criteria[0].after = [];
    invalid.cases[0].criteria[0].paths = ["../escape"];
    expect(() => parseCompilerCorpus(invalid)).toThrow();
    manifest.cases[1].id = manifest.cases[0].id;
    expect(() => parseCompilerCorpus(manifest)).toThrow(/distinct/);
  });

  it("binds deterministic byte identities and rejects symlink or oversized fixture inputs", async () => {
    const first = await fixture("binary-module");
    const second = await fixture("binary-module");
    expect(first.fixtureDigest).toBe(second.fixtureDigest);
    expect(first.manifestDigest).toBe(second.manifestDigest);
    expect(first.repository).not.toBe(second.repository);
    const copy = await mkdtemp(join(tmpdir(), "factory-malformed-corpus-"));
    try {
      await cp(corpusRoot, copy, { recursive: true });
      const unexpected = join(copy, "binary-module", "unexpected.txt");
      await symlink(join(copy, "compiler.json"), unexpected);
      await expect(prepareCompilerCorpusCase(copy, "binary-module")).rejects.toThrow(/symlink/);
      await rm(unexpected);
      await writeFile(unexpected, Buffer.alloc(256 * 1024 + 1));
      await expect(prepareCompilerCorpusCase(copy, "binary-module")).rejects.toThrow(/limits/);
    } finally {
      await rm(copy, { recursive: true, force: true });
    }
  });

  it("rejects invented commands, unbound criteria, wrong identity, absent ownership and unsafe requirements", async () => {
    const value = await fixture("binary-module");
    const graph = combined(value);
    expect(() =>
      assessCompilerCorpusResult(value, graph, bindings(value).slice(0, 1), sha),
    ).toThrow(/every criterion/);
    expect(() => assessCompilerCorpusResult(value, graph, bindings(value), "b".repeat(40))).toThrow(
      /identity/,
    );
    const invalidCommand = structuredClone(graph);
    invalidCommand.workItems[0]!.validationCommands = ["npm run imaginary"];
    expect(() => assessCompilerCorpusResult(value, invalidCommand, bindings(value), sha)).toThrow(
      /validation design references ungrounded command/,
    );
    const noAsset = structuredClone(graph);
    noAsset.workItems[0]!.scope = ["scripts/module.mjs"];
    expect(() => assessCompilerCorpusResult(value, noAsset, bindings(value), sha)).toThrow(
      /uncovered/,
    );
    const noResource = structuredClone(graph);
    noResource.workItems[0]!.changeSurface = {
      mergeClass: "parallel-safe",
      exclusiveResources: [],
    };
    expect(() => assessCompilerCorpusResult(value, noResource, bindings(value), sha)).toThrow(
      /ownership/,
    );
    const unsafe = structuredClone(graph);
    unsafe.workItems[0]!.requirements.networkDestinations = ["api.example.com"];
    expect(() => assessCompilerCorpusResult(value, unsafe, bindings(value), sha)).toThrow(
      /offline fixture/,
    );
    unsafe.workItems[0]!.requirements.networkDestinations = [];
    unsafe.workItems[0]!.requirements.cpu = 3;
    expect(() => assessCompilerCorpusResult(value, unsafe, bindings(value), sha)).toThrow(
      /resource requirement/,
    );
    const missingReference = bindings(value);
    missingReference[0]!.acceptance[0]!.index = 63;
    expect(() => assessCompilerCorpusResult(value, graph, missingReference, sha)).toThrow(
      /acceptance reference/,
    );
  });
});

describe("agent tool-selection corpus contract, not a model pass", () => {
  it("consumes all direct, indirect and negative cases against production tool metadata", async () => {
    const corpus = parseToolSelectionCorpus(await toolManifest());
    expect(corpus.cases).toHaveLength(12);
    for (const entry of corpus.cases) {
      const calls = entry.allowedCalls.flatMap((call) =>
        Array.from({ length: call.min }, () => ({ tool: call.tool, arguments: call.arguments })),
      );
      const result = assessToolSelection(entry, {
        disposition: entry.disposition,
        calls,
        response: "Unit observation only; actual response meaning is separately reviewed.",
      });
      expect(result).toMatchObject({
        accepted: true,
        modelSelectionProven: false,
        installedExecutionProven: false,
        semanticResponseReviewRequired: true,
      });
    }
  });

  it("permits identical bounded retry, rejects changed Objective/request/policy identity", async () => {
    const entry = parseToolSelectionCorpus(await toolManifest()).cases.find(
      (value) => value.id === "direct-identical-retry",
    )!;
    const original = entry.allowedCalls[0]!;
    const call = { tool: original.tool, arguments: original.arguments };
    const observe = (calls: unknown[]) =>
      assessToolSelection(entry, { disposition: "act", calls, response: "Retry requested." });
    expect(observe([call, call]).accepted).toBe(true);
    expect(observe([call, call, call]).accepted).toBe(false);
    expect(
      observe([{ ...call, arguments: { ...call.arguments, requestId: "new-id" } }]).accepted,
    ).toBe(false);
    expect(
      observe([call, { ...call, arguments: { ...call.arguments, objectiveNumber: 18 } }]).problems,
    ).toContain("request identity reused for a different mutation");
    expect(
      observe([{ ...call, arguments: { ...call.arguments, policy: { cloudSlots: 1 } } }]).accepted,
    ).toBe(false);
  });

  it("rejects paid compilation during inspection and mutations during clarification/refusal", async () => {
    const corpus = parseToolSelectionCorpus(await toolManifest());
    const plan = corpus.cases.find((entry) => entry.id === "direct-plan-inspection")!;
    const expected = plan.allowedCalls[0]!;
    const observation = (compile: boolean) => ({
      disposition: "act",
      calls: [{ tool: expected.tool, arguments: { ...expected.arguments, compile } }],
      response: "Plan inspected.",
    });
    expect(assessToolSelection(plan, observation(false)).accepted).toBe(true);
    expect(assessToolSelection(plan, observation(true)).accepted).toBe(false);
    for (const entry of corpus.cases.filter((value) => value.disposition !== "act")) {
      expect(
        assessToolSelection(entry, {
          disposition: entry.disposition,
          calls: [
            {
              tool: "factory_cancel",
              arguments: {
                owner: "example",
                repo: "corpus",
                objectiveNumber: 17,
                requestId: "invented",
              },
            },
          ],
          response: "I cancelled it.",
        }).accepted,
      ).toBe(false);
    }
  });

  it("rejects contradictory tool corpus authority and unknown tools", async () => {
    const corpus = await toolManifest();
    corpus.cases[0].allowedCalls[0].tool = "factory_activate";
    expect(() => parseToolSelectionCorpus(corpus)).toThrow(/inspection/);
    corpus.cases[0].allowedCalls[0].tool = "factory_not_real";
    expect(() => parseToolSelectionCorpus(corpus)).toThrow(/unknown tool/);
    corpus.cases[0].allowedCalls[0].tool = "factory_status";
    corpus.cases[0].disposition = "refuse";
    expect(() => parseToolSelectionCorpus(corpus)).toThrow(/cannot authorize/);
  });
});
