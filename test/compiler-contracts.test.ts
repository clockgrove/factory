import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  COMPILER_PROPOSAL_JSON_SCHEMA,
  COMPILER_REQUEST_JSON_SCHEMA,
  CompilerProposalSchema,
  CompilerRequestSchema,
  type CompilerViolation,
} from "../src/compiler/contracts.js";
import {
  createCompilerValidationReport,
  renderCompilerValidationReport,
} from "../src/compiler/violations.js";
import {
  CompilerRequestValidationError,
  validateCompilerRequest,
} from "../src/compiler/proposal.js";
import { CodexCliManagementBackend, compilerProposalPrompt } from "../src/management/codex-cli.js";
import { readPinnedCompilerFacts } from "../src/repository-profiles/read.js";
import { compilerCapabilitiesForRepository } from "../src/toolchains/compiler-capabilities.js";
import {
  semanticPinnedFacts,
  semanticProposal,
  semanticRequest,
} from "./helpers/semantic-compiler.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const allToolchainDestinations = ["files.pythonhosted.org", "pypi.org", "registry.npmjs.org"];

describe("adapter-owned compiler capabilities", () => {
  it.each([
    {
      name: "npm",
      paths: ["package.json", "package-lock.json", "src/a.ts"],
      adapterId: "node-npm",
      command: "npm run test",
    },
    {
      name: "pnpm",
      paths: ["package.json", "pnpm-lock.yaml", "src/a.ts"],
      adapterId: "node-pnpm",
      command: "pnpm run test",
    },
    {
      name: "Bun",
      paths: ["package.json", "bun.lock", "src/a.ts"],
      adapterId: "javascript-bun",
      command: "bun run test",
    },
    {
      name: "uv",
      paths: ["pyproject.toml", "uv.lock", ".python-version", "pytest.ini", "src/a.py"],
      adapterId: "python-uv",
      command: "uv run --locked --no-sync python -m pytest",
    },
  ])(
    "selects $name authority and formats only its observed recipes",
    ({ paths, adapterId, command }) => {
      const scripts = adapterId === "python-uv" ? {} : { test: "runner-specific source data" };
      const pinned = semanticPinnedFacts({ paths, scripts });
      const selected = compilerCapabilitiesForRepository(pinned, allToolchainDestinations);
      expect(selected.toolchains.find((entry) => entry.adapterId === adapterId)?.state).toBe(
        "observed",
      );
      expect(selected.validationRecipes.map((entry) => entry.command)).toContain(command);
      expect(
        selected.validationRecipes
          .filter((entry) => entry.adapterId !== null)
          .every((entry) => entry.adapterId === adapterId),
      ).toBe(true);
    },
  );

  it.each([
    {
      state: "eligible-deferred",
      paths: ["README.md"],
      allowed: allToolchainDestinations,
      expected: ["eligible-deferred"],
    },
    {
      state: "partial",
      paths: ["package.json"],
      allowed: [],
      expected: ["partial", "policy-blocked"],
    },
    {
      state: "mixed",
      paths: ["package.json", "package-lock.json", "pnpm-lock.yaml"],
      allowed: [],
      expected: ["mixed", "policy-blocked"],
    },
    {
      state: "policy-blocked",
      paths: ["README.md"],
      allowed: [],
      expected: ["policy-blocked"],
    },
    {
      state: "unsupported",
      paths: ["Cargo.toml", "src/lib.rs"],
      allowed: allToolchainDestinations,
      expected: ["unsupported"],
    },
  ])("returns canonical $state repository states", ({ paths, allowed, expected }) => {
    const selected = compilerCapabilitiesForRepository(
      semanticPinnedFacts({ paths, scripts: {} }),
      allowed,
    );
    expect([...new Set(selected.toolchains.map((entry) => entry.state))].sort()).toEqual(
      [...expected].sort(),
    );
    if (expected.includes("unsupported")) expect(selected.validationRecipes).toEqual([]);
  });

  it.each([
    ["Cargo", ["Cargo.toml", "src/lib.rs"]],
    ["Go", ["go.mod", "main.go"]],
    ["ambient Python", ["requirements.txt", "app.py"]],
  ])("keeps %s outside bootstrap authority", (_name, paths) => {
    const selected = compilerCapabilitiesForRepository(
      semanticPinnedFacts({ paths, scripts: {} }),
      allToolchainDestinations,
    );
    expect(selected.validationRecipes).toEqual([]);
    expect(selected.toolchains.every((entry) => entry.state === "unsupported")).toBe(true);
  });

  it("keeps the generic compiler prompt free of adapter implementation prose", () => {
    const prompt = compilerProposalPrompt.toString();
    for (const literal of [
      /\bnpm\b/i,
      /\bpnpm\b/i,
      /\bbun\b/i,
      /\buv\b/i,
      /registry/i,
      /lockfile/i,
      /runtime[- ]pin/i,
    ])
      expect(prompt).not.toMatch(literal);
  });
});

describe("strict semantic compiler contracts", () => {
  const ajv = new Ajv2020({ strict: false, allowUnionTypes: true });
  const jsonProposal = ajv.compile(COMPILER_PROPOSAL_JSON_SCHEMA);
  const jsonRequest = ajv.compile(COMPILER_REQUEST_JSON_SCHEMA);

  it("keeps strict Zod and JSON schemas in parity for valid and invalid boundaries", () => {
    const request = semanticRequest();
    const proposal = semanticProposal(request);
    const invalidProposal = structuredClone(proposal) as Record<string, unknown>;
    (invalidProposal.workItems as Array<Record<string, unknown>>)[0]!.scope = ["../secret"];
    const invalidRequest = structuredClone(request) as Record<string, unknown>;
    invalidRequest.unexpected = true;
    const multiPointer = structuredClone(request);
    multiPointer.validationReport = createCompilerValidationReport("proposal", [
      {
        code: "unknown-dependency",
        itemId: "item-1",
        field: "/workItems/0/dependsOn/0",
        expected: [],
        observed: "missing",
      },
    ]);
    for (const [zod, json, value, accepted] of [
      [CompilerProposalSchema, jsonProposal, proposal, true],
      [CompilerProposalSchema, jsonProposal, invalidProposal, false],
      [CompilerRequestSchema, jsonRequest, request, true],
      [CompilerRequestSchema, jsonRequest, invalidRequest, false],
      [CompilerRequestSchema, jsonRequest, multiPointer, true],
    ] as const) {
      expect(zod.safeParse(value).success).toBe(accepted);
      expect(json(value)).toBe(accepted);
    }
  });

  it("rejects an unsatisfiable request before model dispatch with stable bytes", async () => {
    const request = semanticRequest(
      semanticPinnedFacts({ paths: ["go.mod", "main.go"], scripts: {} }),
      allToolchainDestinations,
    );
    const first = validateCompilerRequest(request);
    const second = validateCompilerRequest(structuredClone(request));
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      phase: "request",
      status: "unsatisfiable",
      violations: [{ code: "unsupported-toolchain", field: "/repository" }],
    });
    const runStructured = vi.fn();
    const backend = new CodexCliManagementBackend({ runStructured });
    await expect(backend.proposePlan(request, async () => {})).rejects.toMatchObject({
      name: CompilerRequestValidationError.name,
      report: first,
    });
    expect(runStructured).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "partial authority",
      paths: ["package.json"],
      expected: [
        "denied-network-destination",
        "no-validation-capability",
        "partial-toolchain-authority",
      ],
    },
    {
      name: "mixed authority",
      paths: ["package.json", "package-lock.json", "pnpm-lock.yaml"],
      expected: [
        "denied-network-destination",
        "mixed-toolchain-authority",
        "no-validation-capability",
      ],
    },
    {
      name: "policy blocked authority",
      paths: ["README.md"],
      expected: ["denied-network-destination", "no-validation-capability"],
    },
  ])("returns exact terminal codes for $name", ({ paths, expected }) => {
    const request = semanticRequest(semanticPinnedFacts({ paths, scripts: {} }), []);
    const report = validateCompilerRequest(request);
    expect(report.status).toBe("unsatisfiable");
    expect([...new Set(report.violations.map((entry) => entry.code))].sort()).toEqual(
      [...expected].sort(),
    );
    const shuffled = structuredClone(request);
    shuffled.repository.toolchains.reverse();
    shuffled.constraints.allowedNetworkDestinations.reverse();
    expect(validateCompilerRequest(shuffled)).toEqual(report);
  });
});

describe("canonical compiler validation reports", () => {
  const violation = (overrides: Partial<CompilerViolation> = {}): CompilerViolation => ({
    code: "unknown-dependency",
    itemId: "item-1",
    field: "/workItems/0/dependsOn",
    expected: ["item-1"],
    observed: "missing",
    ...overrides,
  });

  it("sorts, deduplicates, classifies, and renders solely from the closed registry", () => {
    const report = createCompilerValidationReport("proposal", [
      violation({ itemId: "item-z" }),
      violation(),
      violation(),
    ]);
    expect(report.status).toBe("repairable");
    expect(report.violations.map((entry) => entry.itemId)).toEqual(["item-1", "item-z"]);
    expect(renderCompilerValidationReport(report)).toContain(
      "unknown-dependency [item-1] /workItems/0/dependsOn",
    );
    expect(JSON.stringify(report)).not.toContain("message");
    expect(JSON.stringify(report)).not.toContain("invariant");
  });

  it("bounds individual values, violation count, and complete report bytes", () => {
    const report = createCompilerValidationReport(
      "proposal",
      Array.from({ length: 140 }, (_, index) =>
        violation({
          itemId: `item-${String(index).padStart(3, "0")}`,
          field: `/workItems/${index}/dependsOn`,
          observed: "x".repeat(3_000) + index,
        }),
      ),
    );
    expect(report.violations).toHaveLength(128);
    expect(report.violations.at(-1)).toMatchObject({
      code: "report-truncated",
      observed: { totalViolations: 140 },
    });
    expect(Buffer.byteLength(JSON.stringify(report))).toBeLessThanOrEqual(64 * 1024);
    expect(report.violations[0]!.observed).toMatchObject({ bounded: true, bytes: 3_003 });
  });

  it("refuses suspected secret material instead of persisting it", () => {
    expect(() =>
      createCompilerValidationReport("proposal", [
        violation({ observed: `ghp_${"s".repeat(40)}` }),
      ]),
    ).toThrow(/secret|token/i);
  });
});

describe("pinned compiler facts", () => {
  it("reads immutable manifest bytes and canonicalizes input order despite checkout disagreement", async () => {
    const root = await mkdtemp(join(tmpdir(), "factory-pinned-compiler-"));
    roots.push(root);
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Factory Test"], { cwd: root });
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ scripts: { test: "node --test" } }),
    );
    await writeFile(join(root, "package-lock.json"), "{}\n");
    await writeFile(join(root, "README.md"), "Pinned\n");
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "-qm", "fixture"], { cwd: root });
    const baseSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { test: "false" } }));
    const first = await readPinnedCompilerFacts(root, baseSha, [
      "README.md",
      "package-lock.json",
      "package.json",
    ]);
    const second = await readPinnedCompilerFacts(root, baseSha, [
      "package.json",
      "README.md",
      "package-lock.json",
      "package.json",
    ]);
    expect(first).toEqual(second);
    expect(first.repository.scripts).toEqual({ test: "node --test" });
    expect(await readFile(join(root, "package.json"), "utf8")).toContain("false");
  });
});
