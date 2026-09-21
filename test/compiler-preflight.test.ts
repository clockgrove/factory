import { describe, expect, it } from "vitest";
import { assessPinnedCompilerPreflight } from "../src/application/compiler-preflight.js";
import type { PinnedRepositoryFacts } from "../src/repository-profiles/index.js";

const allRegistries = ["registry.npmjs.org", "pypi.org", "files.pythonhosted.org"];
const execution = {
  routes: {
    protocol: "clockgrove.factory/execution-route-capabilities" as const,
    routes: [
      {
        id: "fixture/process",
        runtimeKind: "fixture",
        hostExecution: true,
        isolation: "process" as const,
        unavailableReasons: [],
      },
    ],
  },
};

const assess = (facts: PinnedRepositoryFacts, destinations: readonly string[]) =>
  assessPinnedCompilerPreflight(facts, destinations, execution);

function pinned(
  paths: string[],
  {
    scripts = {},
    documents = {},
  }: { scripts?: Record<string, string>; documents?: Record<string, string> } = {},
): PinnedRepositoryFacts {
  return {
    baseSha: "a".repeat(40),
    digest: "b".repeat(64),
    manifests: paths.filter((path) => /(?:package|lock|pyproject|python-version)/.test(path)),
    relevantPaths: [...paths].sort(),
    repository: {
      files: paths.map((path) => ({ path })),
      scripts,
      documents,
    },
  };
}

describe("compiler qualification preflight", () => {
  it("blocks an unreachable trust requirement independently of repository validity", () => {
    const facts = pinned(["README.md"]);
    const report = assessPinnedCompilerPreflight(facts, allRegistries, {
      ...execution,
      trust: "isolated",
    });
    expect(report).toMatchObject({
      result: "blocked",
      validation: { status: "valid" },
      execution: {
        result: "blocked",
        required: { trust: "isolated", minimumIsolation: "container" },
        routes: [
          expect.objectContaining({
            id: "fixture/process",
            compatible: false,
            reasons: ["requires container-or-stronger isolation"],
          }),
        ],
      },
    });
  });

  it.each([
    {
      name: "npm",
      adapter: "node-npm",
      facts: pinned(["package.json", "package-lock.json", "test/a.test.js"], {
        scripts: { test: "node --test" },
        documents: { "package.json": '{"scripts":{"test":"node --test"}}' },
      }),
    },
    {
      name: "pnpm",
      adapter: "node-pnpm",
      facts: pinned(["package.json", "pnpm-lock.yaml", "test/a.test.js"], {
        scripts: { test: "node --test" },
        documents: { "package.json": '{"scripts":{"test":"node --test"}}' },
      }),
    },
    {
      name: "Bun",
      adapter: "javascript-bun",
      facts: pinned(["package.json", "bun.lock", "test/a.test.js"], {
        scripts: { test: "bun test" },
        documents: { "package.json": '{"scripts":{"test":"bun test"}}' },
      }),
    },
    {
      name: "uv",
      adapter: "python-uv",
      facts: pinned(["pyproject.toml", "uv.lock", ".python-version", "test_a.py"], {
        documents: {
          "pyproject.toml": "[project]\nrequires-python='>=3.12'\n[tool.pytest.ini_options]\n",
          ".python-version": "3.12\n",
          "uv.lock": "version = 1\n",
        },
      }),
    },
  ])("accepts complete $name authority through $adapter", ({ adapter, facts }) => {
    const report = assess(facts, allRegistries);
    expect(report.result).toBe("passed");
    expect(report.validation).toMatchObject({ status: "valid", violations: [] });
    expect(report.toolchains).toContainEqual(
      expect.objectContaining({
        adapterId: adapter,
        state: "observed",
        missingAuthorityPaths: [],
        validationRecipeCount: 1,
      }),
    );
  });

  it("rejects npm's manifest-without-lock fixture as partial authority", () => {
    const report = assess(
      pinned(["package.json", "test/a.test.js"], {
        scripts: { test: "node --test" },
        documents: { "package.json": '{"scripts":{"test":"node --test"}}' },
      }),
      allRegistries,
    );
    expect(report.result).toBe("blocked");
    expect(report.validation.violations.map(({ code }) => code)).toContain(
      "partial-toolchain-authority",
    );
    expect(report.toolchains).toContainEqual(
      expect.objectContaining({
        adapterId: "node-npm",
        state: "partial",
        presentAuthorityPaths: ["package.json"],
        missingAuthorityPaths: ["package-lock.json"],
      }),
    );
  });

  it("rejects mixed JavaScript package authority", () => {
    const report = assess(
      pinned(["package.json", "package-lock.json", "pnpm-lock.yaml"], {
        scripts: { test: "node --test" },
        documents: { "package.json": '{"scripts":{"test":"node --test"}}' },
      }),
      allRegistries,
    );
    expect(report.result).toBe("blocked");
    expect(report.validation.violations.map(({ code }) => code)).toContain(
      "mixed-toolchain-authority",
    );
    expect(report.toolchains.filter(({ state }) => state === "mixed").length).toBeGreaterThan(1);
  });

  it("preserves eligible-deferred greenfield authority", () => {
    const report = assess(pinned(["README.md"]), allRegistries);
    expect(report.result).toBe("passed");
    expect(report.validation.status).toBe("valid");
    expect(report.validationRecipeCount).toBe(0);
    expect(report.eligibleDeferredAdapters).toEqual(
      expect.arrayContaining(["node-npm", "node-pnpm", "javascript-bun", "python-uv"]),
    );
  });

  it("keeps an unsupported existing manager eligible for a supported deferred bootstrap", () => {
    const report = assess(pinned(["Cargo.toml", "Cargo.lock", "src/lib.rs"]), allRegistries);
    expect(report.result).toBe("passed");
    expect(report.validationRecipeCount).toBe(0);
    expect(report.toolchains).toContainEqual(
      expect.objectContaining({ adapterId: "rust-cargo", state: "unsupported" }),
    );
    expect(report.eligibleDeferredAdapters.length).toBeGreaterThan(0);
  });

  it("distinguishes policy-blocked and unsupported states when no validation authority exists", () => {
    const policyBlocked = assess(pinned(["README.md"]), []);
    expect(policyBlocked.result).toBe("blocked");
    expect(policyBlocked.toolchains.every(({ state }) => state === "policy-blocked")).toBe(true);
    expect(policyBlocked.validation.violations.map(({ code }) => code)).toEqual(
      expect.arrayContaining(["denied-network-destination", "no-validation-capability"]),
    );

    const unsupported = assess(
      pinned(["package.json", "package-lock.json", "src/example.py"], {
        documents: { "package.json": "{}" },
      }),
      allRegistries,
    );
    expect(unsupported.result).toBe("blocked");
    expect(unsupported.toolchains).toContainEqual(
      expect.objectContaining({ adapterId: "python-uv", state: "unsupported" }),
    );
    expect(unsupported.validation.violations.map(({ code }) => code)).toContain(
      "no-validation-capability",
    );
  });
});
