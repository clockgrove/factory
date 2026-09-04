import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import {
  buildContextManifest,
  discoverValidationCommands,
  isGroundedValidationCommand,
  normalizeRepositoryFacts,
  profileRepository,
  type ExecutionProfile,
  type RepositoryFacts,
} from "../src/repository-profiles/index.js";
describe("repository profiles", () => {
  it("grounds concrete Node test selection in an observed validation recipe and repository scope", () => {
    const facts = { files: [{ path: "test/smoke.js" }], scripts: { test: "node --test" } };
    expect(discoverValidationCommands(facts)).toEqual(["npm test", "node --test"]);
    for (const command of [
      "npm test",
      "node --test",
      "node --test test/smoke.js",
      "node --test test/new.js",
      "node --test test/smoke.js test/new.js",
    ])
      expect(isGroundedValidationCommand(command, facts, ["test/new.js"])).toBe(true);
    expect(isGroundedValidationCommand("node --test test/new.mjs", facts, ["test/"])).toBe(true);
    for (const command of [
      "node --test test/unplanned.js",
      "node --test ../escape.js",
      "node --test /tmp/outside.js",
      "node --test test/../outside.js",
      "node --test test/*.js",
      "node --test --import evil.js",
      "node --test test/new.js && npm install evil",
      "node --test test/new.js\nnode evil.js",
      "node --eval process.exit(0)",
      "npm install",
      "npx vitest",
      "sh test/new.js",
    ])
      expect(isGroundedValidationCommand(command, facts, ["test/new.js"])).toBe(false);
    expect(
      isGroundedValidationCommand(
        "node --test test/new.js",
        { ...facts, scripts: { test: "vitest" } },
        ["test/new.js"],
      ),
    ).toBe(false);
    const targeted = { ...facts, scripts: { test: "node --test test/smoke.js" } };
    expect(discoverValidationCommands(targeted)).toEqual(["npm test", "node --test test/smoke.js"]);
    expect(isGroundedValidationCommand("node --test test/new.js", targeted, ["test/new.js"])).toBe(
      false,
    );
    for (const recipe of [
      "node --test && npm install",
      "node --test /tmp/external.js",
      "node --eval '1'",
      "node --test test/missing.js",
    ])
      expect(discoverValidationCommands({ ...facts, scripts: { test: recipe } })).toEqual([
        "npm test",
      ]);
  });
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
