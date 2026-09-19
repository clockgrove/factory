import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

import { candidateCommands } from "../scripts/verify-candidate.mjs";
import {
  buildPrTestPlan,
  criticalContractTests,
  deepScenarioTests,
  parsePrArguments,
  prImpactRules,
  prWorkerCount,
  selectPrChecks,
} from "../scripts/verify-pr.mjs";
import {
  assertExpectedCommit,
  createVerificationReceipt,
  sourceIdentity,
  writeVerificationReceipt,
} from "../scripts/verification-receipt.mjs";

describe("proportional quality gates", () => {
  it("selects one explicit merge base and rejects ambiguous CLI input", () => {
    expect(parsePrArguments([], { FACTORY_TEST_BASE: "base-sha" })).toEqual({
      base: "base-sha",
    });
    expect(parsePrArguments(["--base", "main"], {})).toEqual({ base: "main" });
    expect(() => parsePrArguments(["--base"], {})).toThrow("requires a Git revision");
    expect(() => parsePrArguments(["--unknown", "main"], {})).toThrow("unknown test:pr argument");
  });

  it("limits changed-file checks while selecting affected runtime inputs", () => {
    expect(
      selectPrChecks([
        "README.md",
        "src/platform.ts",
        "test/platform.test.ts",
        "scripts/example.mjs",
        "package-lock.json",
        "dist/factory.js",
      ]),
    ).toEqual({
      changed: [
        "README.md",
        "dist/factory.js",
        "package-lock.json",
        "scripts/example.mjs",
        "src/platform.ts",
        "test/platform.test.ts",
      ],
      biome: ["scripts/example.mjs", "src/platform.ts", "test/platform.test.ts"],
      directTests: ["test/platform.test.ts"],
      mappedTests: [
        "test/manifest-consistency.test.ts",
        "test/package-documentation.test.ts",
        "test/package-install.test.ts",
      ],
      relatedInputs: ["scripts/example.mjs", "src/platform.ts"],
      code: true,
    });
    expect(selectPrChecks(["README.md", "docs/CONFORMANCE.md"]).code).toBe(false);
  });

  it("routes package, schema, and workflow surfaces to their direct contracts", () => {
    expect(selectPrChecks(["package.json", "package-lock.json"]).mappedTests).toEqual([
      "test/manifest-consistency.test.ts",
      "test/package-documentation.test.ts",
      "test/package-install.test.ts",
    ]);
    expect(selectPrChecks(["schemas/compiler-request.schema.json"]).mappedTests).toEqual([
      "test/provider-structured-output-schema.test.ts",
      "test/worker-packet-schema-parity.test.ts",
    ]);
    expect(selectPrChecks([".github/workflows/quality.yml"]).mappedTests).toEqual([
      "test/quality-gates.test.ts",
    ]);
    expect(selectPrChecks(["skills/director/SKILL.md"]).code).toBe(true);
  });

  it("maps shared test support explicitly and fails closed for an unknown helper", () => {
    expect(selectPrChecks(["test/helpers/provider-supervisor.ts"])).toMatchObject({
      directTests: [],
      relatedInputs: [],
      mappedTests: [
        "test/provider-supervisor-lifecycle.test.ts",
        "test/provider-supervisor-qualification.test.ts",
      ],
    });
    expect(() => selectPrChecks(["test/helpers/unmapped-fixture.ts"])).toThrow(
      "test-support impact is unmapped",
    );
    expect(selectPrChecks(["src/supervisor.ts"])).toMatchObject({
      relatedInputs: ["src/supervisor.ts"],
      mappedTests: [
        "test/regular-pipeline-supervisor.test.ts",
        "test/supervisor-commands.test.ts",
        "test/supervisor-preflight.test.ts",
        "test/supervisor-result-receipts.test.ts",
      ],
    });
    expect(prImpactRules.some(({ path }) => path === "src/supervisor.ts")).toBe(true);
  });

  it("runs directly changed deep scenarios while deferring dependency-only deep matrices", () => {
    const selection = selectPrChecks(["src/platform.ts", "test/successor-supervisor.test.ts"]);
    const plan = buildPrTestPlan(selection, [
      "test/platform.test.ts",
      "test/supervisor-late-completion.test.ts",
      "test/successor-supervisor.test.ts",
    ]);
    expect(plan).toEqual({
      selectedTests: ["test/platform.test.ts", "test/successor-supervisor.test.ts"],
      deferredDeepTests: ["test/supervisor-late-completion.test.ts"],
    });
    expect(deepScenarioTests).toContain("test/successor-supervisor.test.ts");

    const mapped = selectPrChecks(["test/helpers/provider-supervisor.ts"]);
    expect(buildPrTestPlan(mapped, []).selectedTests).toEqual([
      "test/provider-supervisor-lifecycle.test.ts",
      "test/provider-supervisor-qualification.test.ts",
    ]);
  });

  it("keeps every explicit impact target and deep scenario attached to a real test", () => {
    const paths = [...deepScenarioTests, ...prImpactRules.flatMap(({ tests }) => tests)];
    for (const path of paths) {
      expect(existsSync(new URL(`../${path}`, import.meta.url)), path).toBe(true);
    }
    expect(new Set(deepScenarioTests).size).toBe(deepScenarioTests.length);
  });

  it("uses up to four actual CPUs for PR test files", () => {
    expect(prWorkerCount(1)).toBe(1);
    expect(prWorkerCount(2)).toBe(2);
    expect(prWorkerCount(4)).toBe(4);
    expect(prWorkerCount(32)).toBe(4);
    expect(() => prWorkerCount(0)).toThrow("positive integer");

    const config = readFileSync(new URL("../vitest.config.ts", import.meta.url), "utf8");
    expect(config).toContain('from "node:os"');
    expect(config).toContain("maxWorkers: Math.min(4, availableParallelism())");
  });

  it("never promotes a pull request to the complete deterministic suite", () => {
    const source = readFileSync(new URL("../scripts/verify-pr.mjs", import.meta.url), "utf8");
    expect(source).not.toContain('run("npm", ["test"]');
  });

  it("reports phase timing, worker count, and deep deferrals", () => {
    const source = readFileSync(new URL("../scripts/verify-pr.mjs", import.meta.url), "utf8");
    expect(source).toContain("available parallelism");
    expect(source).toContain("Vitest workers");
    expect(source).toContain("deep scenarios deferred to test:main");
    expect(source).toContain("GITHUB_STEP_SUMMARY");
  });

  it("keeps the critical suite small and anchored in core contracts", () => {
    expect(criticalContractTests).toHaveLength(8);
    expect(criticalContractTests).toEqual(
      expect.arrayContaining([
        "test/compiler-pipeline.test.ts",
        "test/admission-settlement.test.ts",
        "test/integration-admission.test.ts",
        "test/mutation-fencing.test.ts",
      ]),
    );
    for (const path of criticalContractTests) {
      expect(existsSync(new URL(`../${path}`, import.meta.url))).toBe(true);
    }
  });

  it("runs the candidate suite once under coverage before package and audit gates", () => {
    const rendered = candidateCommands.map(([command, args]) => [command, ...args].join(" "));
    expect(rendered[0]).toContain("scripts/verify-release-preflight.mjs");
    expect(rendered.filter((command) => command.includes("test:coverage"))).toHaveLength(1);
    expect(rendered).toEqual(
      expect.arrayContaining([
        "npm run verify:dist",
        "npm run verify:package",
        "npm run verify:npm",
        "npm audit",
      ]),
    );
    expect(rendered).not.toContain("npm test");
  });

  it("binds receipts to the exact expected source commit", () => {
    const identity = { commit: "a".repeat(40), tree: "b".repeat(40), clean: true, status: "" };
    expect(() => assertExpectedCommit(identity, identity.commit)).not.toThrow();
    expect(() => assertExpectedCommit(identity, "c".repeat(40))).toThrow("differs from expected");
  });

  it("writes a clean exact-commit receipt and rejects later source changes", async () => {
    const root = mkdtempSync("/tmp/factory-quality-receipt-");
    const destination = `${root}-receipt.json`;
    try {
      mkdirSync(`${root}/dist`);
      writeFileSync(
        `${root}/package.json`,
        JSON.stringify({ name: "@clockgrove/factory", version: "1.0.0" }),
      );
      writeFileSync(`${root}/package-lock.json`, "{}\n");
      for (const path of ["factory.js", "mcp-server.js", "bundle-inventory.json"])
        writeFileSync(`${root}/dist/${path}`, `${path}\n`);
      execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
      execFileSync("git", ["config", "user.name", "Factory Test"], { cwd: root });
      execFileSync("git", ["config", "user.email", "factory@example.invalid"], { cwd: root });
      execFileSync("git", ["add", "."], { cwd: root });
      execFileSync("git", ["commit", "-qm", "fixture"], { cwd: root });
      const identity = await sourceIdentity(root);
      const receipt = await createVerificationReceipt({
        gate: "test:main",
        command: "npm run test:main",
        startedAt: "2026-09-18T00:00:00.000Z",
        completedAt: "2026-09-18T00:01:00.000Z",
        cwd: root,
        expectedCommit: identity.commit,
      });
      expect(receipt).toMatchObject({
        kind: "factory-exact-commit-verification",
        gate: "test:main",
        status: "passed",
        commit: identity.commit,
        tree: identity.tree,
      });
      expect(receipt.subjects as unknown[]).toHaveLength(5);
      await writeVerificationReceipt(receipt, destination);
      expect(statSync(destination).mode & 0o777).toBe(0o600);

      writeFileSync(`${root}/README.md`, "changed\n");
      await expect(
        createVerificationReceipt({
          gate: "test:main",
          command: "npm run test:main",
          startedAt: "2026-09-18T00:00:00.000Z",
          cwd: root,
        }),
      ).rejects.toThrow("clean working tree");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(destination, { force: true });
    }
  });

  it("defines PR and main CI as separate exact-purpose jobs", () => {
    const source = readFileSync(
      new URL("../.github/workflows/quality.yml", import.meta.url),
      "utf8",
    );
    const workflow = YAML.parse(source);
    expect(workflow.on).toEqual({ pull_request: null, push: { branches: ["main"] } });
    expect(source).toContain("npm run test:pr");
    expect(source).toContain("npm run test:main");
    expect(source).toContain('--expected-commit "$GITHUB_SHA"');
    expect(source).toContain("actions/upload-artifact@v7");
  });

  it("exposes the three stage commands without the old monolithic alias", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { scripts: Record<string, string> };
    expect(manifest.scripts["test:pr"]).toBe("node scripts/verify-pr.mjs");
    expect(manifest.scripts["test:main"]).toContain("npm test");
    expect(manifest.scripts["verify:candidate"]).toBe("node scripts/verify-candidate.mjs");
    expect(manifest.scripts["verify:release"]).toBeUndefined();
  });
});
