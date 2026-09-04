import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import {
  buildContextManifest,
  normalizeRepositoryFacts,
  profileRepository,
  type ExecutionProfile,
  type RepositoryFacts,
} from "../src/repository-profiles/index.js";
describe("repository profiles", () => {
  const cases: Array<[string, RepositoryFacts, Partial<ExecutionProfile>]> = [
    [
      "typescript",
      {
        files: [{ path: "src/a.ts" }, { path: "package.json" }],
        scripts: { test: "vitest" },
      },
      { languages: ["typescript"], validationCommands: ["npm test"] },
    ],
    [
      "generated",
      { files: [{ path: "generated/a.js", generated: true }] },
      { generatedOutput: true },
    ],
    ["binary", { files: [{ path: "assets/a.wasm", binary: true }] }, { binaryAssets: true }],
    [
      "simulation",
      { files: [{ path: "test/deterministic-simulation.ts" }] },
      { deterministicSimulation: true },
    ],
    ["visual", { files: [{ path: "test/visual-snapshot.ts" }] }, { visualValidation: true }],
  ];
  for (const [name, facts, expected] of cases)
    it(`normalizes bounded ${name} evidence`, () => {
      expect(profileRepository(facts)).toMatchObject(expected);
      expect(
        buildContextManifest(facts, [facts.files[0]!.path]).mustRead.length,
      ).toBeLessThanOrEqual(64);
      expect(
        normalizeRepositoryFacts({
          ...facts,
          files: [...facts.files].reverse(),
        }),
      ).toEqual(normalizeRepositoryFacts(facts));
    });
  it("profiles every checked-in repository fixture with a bounded manifest", async () => {
    const fixtures = JSON.parse(
      await readFile(
        new URL("./fixtures/compiler/repository-profiles.json", import.meta.url),
        "utf8",
      ),
    ) as Array<{
      name: string;
      facts: RepositoryFacts;
      expected: Partial<ExecutionProfile>;
    }>;
    expect(fixtures.map((f) => f.name)).toEqual([
      "typescript",
      "generated-output",
      "binary",
      "deterministic-simulation",
      "visual-validation",
    ]);
    for (const fixture of fixtures) {
      expect(profileRepository(fixture.facts)).toMatchObject(fixture.expected);
      const manifest = buildContextManifest(
        fixture.facts,
        fixture.facts.files.map((file) => file.path),
      );
      expect(manifest.mustRead.length).toBeLessThanOrEqual(64);
      expect(manifest.searchSeeds.length).toBeLessThanOrEqual(64);
    }
  });
});
