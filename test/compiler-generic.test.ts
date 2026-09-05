import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compileObjective,
  assessDecomposition,
  ExclusiveResourcesSchema,
  type CompilerWorkItemInput,
} from "../src/compiler/index.js";
import {
  readRepositoryFacts,
  discoverValidationCommands,
  isGroundedValidationCommand,
  type RepositoryFacts,
} from "../src/repository-profiles/index.js";
import { CodexCliManagementBackend } from "../src/management/codex-cli.js";
import { validateGraph, workerPacketFromCompiled } from "../src/graph.js";
import { validationPlanFromPacket } from "../src/validation/plan.js";

const paths: string[] = [];
afterEach(async () => {
  await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function repository(documents: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "factory-generic-compiler-"));
  paths.push(root);
  await Promise.all(
    Object.entries(documents).map(([name, contents]) => writeFile(join(root, name), contents)),
  );
  return root;
}
const sha = "a".repeat(40);
function item(id: string, options: Partial<CompilerWorkItemInput> = {}): CompilerWorkItemInput {
  return {
    id,
    title: id,
    goal: `Implement ${id}`,
    acceptance: [`${id} returns the expected value`],
    scope: [`src/${id}.ts`],
    dependsOn: [],
    preconditions: [],
    outOfScope: [],
    conventions: [],
    baseSha: sha,
    validationCommands: ["npm test"],
    requirements: {
      os: ["linux"],
      architecture: ["x64"],
      tools: ["npm"],
      services: [],
      networkDestinations: [],
      permittedSecretNames: [],
      trust: "trusted_local",
      estimatedDurationMinutes: 10,
    },
    artifactContract: "clockgrove.factory/artifact-v1",
    ...options,
  };
}
const facts: RepositoryFacts = {
  files: [
    { path: "package.json" },
    { path: "src/a.ts" },
    { path: "src/b.ts" },
    { path: "src/c.ts" },
  ],
  scripts: { test: "node --test" },
};
const compile = (workItems: CompilerWorkItemInput[]) =>
  compileObjective({ title: "Generic", baseSha: sha, repositoryFacts: facts, workItems });

describe("generic repository command grounding", () => {
  it.each([
    [
      { "Cargo.toml": '[package]\nname = "sample"\nversion = "0.1.0"' },
      ["cargo check", "cargo test"],
      "cargo",
    ],
    [
      { "go.mod": "module example.test/sample\n\ngo 1.24" },
      ["go test ./...", "go vet ./..."],
      "go",
    ],
    [
      { "pyproject.toml": '[tool.pytest.ini_options]\ntestpaths = ["tests"]' },
      ["python -m pytest", "python3 -m pytest"],
      "python",
    ],
    [
      { "README.md": "```sh\npython3 -m unittest discover\n```" },
      ["python3 -m unittest discover"],
      "python3",
    ],
    [{ Makefile: "check-all:\n\tchecker\n" }, ["make check-all"], "make"],
    [
      { "package.json": JSON.stringify({ scripts: { "quality:ci": "custom-checker" } }) },
      ["npm run quality:ci"],
      "npm",
    ],
  ] as Array<[Record<string, string>, string[], string]>)(
    "compiles observed toolchain %j through packet validation",
    async (documents, expected, runner) => {
      const root = await repository(documents);
      const observed = await readRepositoryFacts(root, Object.keys(documents));
      expect(discoverValidationCommands(observed)).toEqual(expected);
      const workItem = item("a", {
        validationCommands: [expected[0]!],
        requirements: { ...item("a").requirements, tools: [runner] },
      });
      const backend = new CodexCliManagementBackend({
        runStructured: async (_cwd, _schema, prompt) => {
          expect(prompt).toContain(expected[0]!);
          return {
            value: { title: "Generic", workItems: [workItem] },
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        },
      });
      const result = await backend.compile(
        {
          repository: root,
          repositoryFiles: Object.keys(documents),
          objective: { number: 1, title: "Generic", body: "Implement a" },
          defaultBranch: "main",
          baseSha: sha,
          allowedNetworkDestinations: [],
        },
        async () => {},
      );
      validateGraph(result.objective);
      expect(
        validationPlanFromPacket(workerPacketFromCompiled(result.objective.workItems[0]!)).commands,
      ).toEqual([expected[0]!]);
    },
  );
  it("accepts an observed script and rejects injection, eval, downloads and invented recipes", () => {
    const observed = {
      files: [{ path: "README.md" }, { path: "verify.py" }],
      documents: {
        "README.md":
          "```sh\npython3 verify.py\npython3 -c exploit\nsh verify.py\nnpx checker\npython3 verify.py && cargo publish\n```",
      },
    };
    expect(discoverValidationCommands(observed)).toEqual(["python3 verify.py"]);
    for (const command of [
      "python3 missing.py",
      "cargo test",
      "npm test",
      "python3 verify.py --new-flag",
      "python3 ../verify.py",
    ])
      expect(isGroundedValidationCommand(command, observed, [])).toBe(false);
    expect(() =>
      discoverValidationCommands({ files: [], documents: { "README.md": "`cargo test`" } }),
    ).toThrow(/unobserved/);
  });
  it("does not evaluate Make expansions or admit script-name shell syntax", () => {
    const observed = {
      files: [{ path: "Makefile" }],
      scripts: { "check;evil": "checker", "--eval": "checker" },
      documents: { Makefile: "$(shell bad):\n%.o: %.c\ncheck-all verify: input\n\tbad-target:\n" },
    };
    expect(discoverValidationCommands(observed)).toEqual(["make check-all", "make verify"]);
  });
  it("does not offer deployment, installation, destructive, or persistent entry points as validation", () => {
    const observed = {
      files: [{ path: "Makefile" }],
      scripts: {
        "quality:ci": "checker",
        "test:release": "release-contract-tests",
        "release:publish": "publisher",
        "deploy-production": "deployer",
        dev: "development-server",
        start: "server",
        "watch:tests": "watcher",
        install: "installer",
        destroy: "destroyer",
      },
      documents: {
        Makefile: "verify: input\nrelease: input\ninstall: input\nclean: input\nserve: input\n",
      },
    };
    expect(discoverValidationCommands(observed)).toEqual([
      "npm run quality:ci",
      "npm run test:release",
      "make verify",
    ]);
  });
  it("refuses symlinked and oversized facts without reading external content", async () => {
    const external = await repository({ secret: "external content" });
    const root = await repository({});
    await symlink(join(external, "secret"), join(root, "README.md"));
    await expect(readRepositoryFacts(root, ["README.md"])).rejects.toThrow(/escapes checkout/);
    await expect(readRepositoryFacts(root, ["../secret"])).rejects.toThrow(
      /invalid repository path/,
    );
    const large = await repository({ "README.md": "x".repeat(256 * 1024 + 1) });
    await expect(readRepositoryFacts(large, ["README.md"])).rejects.toThrow(/byte bound/);
  });
});

describe("exclusive compiler resource claims", () => {
  it("serializes shared singleton users across disjoint paths and carries claims into packets", () => {
    const graph = compile([
      item("a", { exclusiveResources: ["gpu:0"] }),
      item("b", { exclusiveResources: ["gpu:0"] }),
      item("c"),
    ]);
    validateGraph(graph);
    expect(graph.workItems[1]!.dependsOn).toEqual(["a"]);
    expect(graph.workItems[2]!.dependsOn).toEqual([]);
    expect(workerPacketFromCompiled(graph.workItems[0]!).changeSurface).toEqual({
      mergeClass: "exclusive",
      exclusiveResources: ["gpu:0"],
    });
    expect(graph.workItems[0]).not.toHaveProperty("exclusiveResources");
  });
  it("preserves existing reverse dependency ordering without cycles", () => {
    const graph = compile([
      item("a", { dependsOn: ["b"], exclusiveResources: ["cache:build"] }),
      item("b", { exclusiveResources: ["cache:build"] }),
    ]);
    expect(graph.workItems[0]!.dependsOn).toEqual(["b"]);
    expect(graph.workItems[1]!.dependsOn).toEqual([]);
  });
  it.each(["GPU:0", "../gpu", "gpu/../0", "gpu//0", "gpu\nignore", "gpu;run", "", "a".repeat(161)])(
    "rejects malformed resource %j",
    (resource) => {
      expect(() => ExclusiveResourcesSchema.parse([resource])).toThrow();
      expect(() => compile([item("a", { exclusiveResources: [resource] })])).toThrow();
    },
  );
});

describe("conservative decomposition assessment", () => {
  it("computes configured critical path and repetition while preserving independent work", () => {
    const graph = compile([
      item("a"),
      item("b", { requirements: { ...item("b").requirements, estimatedDurationMinutes: 20 } }),
      item("c", { dependsOn: ["a", "b"] }),
    ]);
    const assessment = assessDecomposition(graph.workItems);
    expect(assessment).toMatchObject({
      dependencyWaveWidth: 2,
      configuredWorkMinutes: 40,
      configuredCriticalPathMinutes: 30,
      idealConcurrencyTimeSavedMinutes: 10,
      contextPathReads: 6,
      uniqueContextPaths: 4,
      repeatedContextPathReads: 2,
      redundantItemPairs: [],
    });
    expect(graph.workItems[0]!.economicReview.rationale).toContain("40/30/10");
    expect(assessment.unknowns.join(" ")).toContain("do not authorize paid execution");
  });
  it("rejects exact duplicate deliverables with bounded corrective feedback", () => {
    expect(() => compile([item("a"), { ...item("a"), id: "duplicate" }])).toThrow(
      /uneconomic duplicate deliverables.*Combine duplicate/,
    );
  });
  it("reports repeated context and serial costs without rejecting distinct deliverables", () => {
    const graph = compile([item("a", { scope: ["src/"] }), item("b", { scope: ["src/"] })]);
    const assessment = assessDecomposition(graph.workItems);
    expect(assessment.feedback.join(" ")).toContain("Narrow manifests or combine");
    expect(assessment.feedback.join(" ")).toContain("without concurrency benefit");
    expect(assessment.idealConcurrencyTimeSavedMinutes).toBe(0);
  });
  it("keeps contracts with different preconditions distinct", () => {
    const graph = compile([
      item("a"),
      { ...item("a"), id: "second", preconditions: ["Run against the migrated schema"] },
    ]);
    expect(assessDecomposition(graph.workItems).redundantItemPairs).toEqual([]);
  });
  it("keeps missing duration unknown and rejects invalid graph inputs", () => {
    const missing = item("a");
    delete missing.requirements.estimatedDurationMinutes;
    const graph = compile([missing]);
    expect(assessDecomposition(graph.workItems)).toMatchObject({
      configuredWorkMinutes: null,
      configuredCriticalPathMinutes: null,
      idealConcurrencyTimeSavedMinutes: null,
    });
    expect(() => assessDecomposition([{ ...graph.workItems[0]!, dependsOn: ["missing"] }])).toThrow(
      /incomplete/,
    );
  });
});
