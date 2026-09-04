import { describe, expect, it } from "vitest";
import {
  compileObjective,
  serializeCompilerObjective,
  validateCompiledObjective,
  type CompilerWorkItem,
} from "../src/compiler/index.js";
import {
  CodexCliManagementBackend,
  parseManagementCompilerOutput,
} from "../src/management/codex-cli.js";

const sha = "a".repeat(40);
const base: CompilerWorkItem = {
  id: "code",
  title: "Code",
  goal: "Compile code",
  acceptance: ["Tests pass", "Build output exists"],
  scope: ["src/a.ts", "src/b.ts"],
  preconditions: ["Node exists", "Dependencies are installed"],
  outOfScope: ["UI changes", "Release changes"],
  conventions: ["Use TypeScript", "Keep stages pure"],
  dependsOn: [],
  baseSha: sha,
  validationCommands: ["npm test", "npm run typecheck"],
  requirements: {
    os: ["linux", "darwin"],
    architecture: ["x64", "arm64"],
    tools: ["node", "npm"],
    services: [],
    networkDestinations: [],
    permittedSecretNames: [],
    trust: "trusted_local",
  },
  artifactContract: "clockgrove.factory/artifact-v1",
  context: {
    mustRead: ["src/a.ts"],
    searchSeeds: ["src/a.ts"],
    dependencyEvidence: [],
  },
  changeSurface: { mergeClass: "parallel-safe", exclusiveResources: [] },
  validation: [
    { tier: "mechanical", criteria: ["Tests pass", "Build output exists"] },
  ],
  delivery: { group: "code", relationship: "root" },
  economicReview: {
    conservative: true,
    rationale: "No paid measurement assumed",
    paidMeasurementRequired: false,
  },
};
const facts = {
  files: [
    { path: "src/a.ts" },
    { path: "src/b.ts" },
    { path: "docs/a.md" },
    { path: "package.json" },
  ],
  scripts: { test: "vitest run", typecheck: "tsc --noEmit" },
};

describe("bounded objective compiler", () => {
  it("is byte deterministic across enumeration order", () => {
    const a = compileObjective({
      title: "Ship",
      baseSha: sha,
      repositoryFacts: facts,
      workItems: [
        base,
        { ...base, id: "docs", scope: ["docs/a.md"], dependsOn: [] },
      ],
    });
    const b = compileObjective({
      title: "Ship",
      baseSha: sha,
      repositoryFacts: {
        files: [...facts.files].reverse(),
        scripts: { typecheck: "x", test: "x" },
      },
      workItems: [
        { ...base, id: "docs", scope: ["docs/a.md"], dependsOn: [] },
        {
          ...base,
          acceptance: [...base.acceptance].reverse(),
          scope: [...base.scope].reverse(),
          preconditions: [...base.preconditions].reverse(),
          outOfScope: [...base.outOfScope].reverse(),
          conventions: [...base.conventions].reverse(),
          validationCommands: [...base.validationCommands].reverse(),
          requirements: {
            ...base.requirements,
            os: ["darwin", "linux"],
            architecture: ["arm64", "x64"],
            tools: ["npm", "node"],
          },
        },
      ],
    });
    expect(serializeCompilerObjective(a)).toBe(serializeCompilerObjective(b));
  });
  it("rejects cycles, unobservable criteria, overlap, invented commands, and topology", () => {
    expect(() =>
      validateCompiledObjective({
        title: "x",
        workItems: [{ ...base, dependsOn: ["code"] }],
      }),
    ).toThrow(/itself|cycle/);
    expect(() =>
      validateCompiledObjective({
        title: "x",
        workItems: [{ ...base, acceptance: ["Make it better"] }],
      }),
    ).toThrow(/unobservable/);
    expect(() =>
      validateCompiledObjective({
        title: "x",
        workItems: [{ ...base, acceptance: ["Tests are wonderful"] }],
      }),
    ).toThrow(/unobservable/);
    expect(() =>
      validateCompiledObjective({
        title: "x",
        workItems: [base, { ...base, id: "two" }],
      }),
    ).toThrow(/overlapping unordered/);
    expect(() =>
      validateCompiledObjective({ title: "x", workItems: [base] }, [
        "npm run typecheck",
      ]),
    ).toThrow(/invented/);
    expect(() =>
      validateCompiledObjective({
        title: "x",
        workItems: [
          {
            ...base,
            delivery: { group: "g", relationship: "root", parentWorkItem: "x" },
          },
        ],
      }),
    ).toThrow(/root topology/);
  });
  it("requires every compiler analysis record", () => {
    const incomplete = { ...base };
    delete (incomplete as Partial<CompilerWorkItem>).context;
    expect(() =>
      validateCompiledObjective({
        title: "x",
        workItems: [incomplete as CompilerWorkItem],
      }),
    ).toThrow(/missing compiler analysis/);
  });
  it("rejects malformed and unbounded management output before compilation", () => {
    const raw = { ...base };
    for (const key of [
      "context",
      "changeSurface",
      "validation",
      "delivery",
      "economicReview",
    ] as const)
      delete (raw as Record<string, unknown>)[key];
    expect(() =>
      parseManagementCompilerOutput({
        title: "x",
        workItems: [{ ...raw, unexpected: true }],
      }),
    ).toThrow();
    expect(() =>
      parseManagementCompilerOutput({
        title: "x",
        workItems: Array.from({ length: 101 }, (_, i) => ({
          ...raw,
          id: `item-${i}`,
        })),
      }),
    ).toThrow();
  });
  it("makes the management backend reject malformed provider output before compiling", async () => {
    const backend = new CodexCliManagementBackend({
      runStructured: async () => ({
        value: { title: "x", workItems: [{ id: "bad", unexpected: true }] },
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    });
    await expect(
      backend.compile({
        repository: process.cwd(),
        objective: { number: 1, title: "x", body: "x" },
        defaultBranch: "main",
        baseSha: sha,
        repositoryFiles: ["package.json", "src/a.ts"],
        allowedNetworkDestinations: [],
      }),
    ).rejects.toThrow();
  });
  it("rejects order-sensitive facts and impossible delivery groups", () => {
    const conflicting = {
      files: [
        { path: "src/a.ts", binary: true },
        { path: "./src/a.ts", binary: false },
      ],
      scripts: { test: "vitest" },
    };
    expect(() =>
      compileObjective({
        title: "x",
        baseSha: sha,
        repositoryFacts: conflicting,
        workItems: [base],
      }),
    ).toThrow(/conflicting repository facts/);
    expect(() =>
      compileObjective({
        title: "x",
        baseSha: sha,
        repositoryFacts: {
          ...conflicting,
          files: [...conflicting.files].reverse(),
        },
        workItems: [base],
      }),
    ).toThrow(/conflicting repository facts/);
    expect(() =>
      validateCompiledObjective({
        title: "x",
        workItems: [
          {
            ...base,
            dependsOn: ["parent"],
            delivery: { group: "code", relationship: "root" },
          },
          {
            ...base,
            id: "parent",
            scope: ["src/p.ts"],
            delivery: { group: "parent", relationship: "root" },
          },
        ],
      }),
    ).toThrow(/root topology/);
  });
});
