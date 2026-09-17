import { describe, expect, it } from "vitest";

import { CompilerValidationRecipeSchema } from "../src/compiler/contracts.js";
import {
  evaluateBoundRepositoryCaptureCapabilities,
  evaluateRepositoryCaptureCatalog,
} from "../src/validation/repository-capture-catalog.js";
import { validateCompilerRequest } from "../src/compiler/proposal.js";
import { semanticPinnedFacts, semanticRequest } from "./helpers/semantic-compiler.js";

const observedRecipe = CompilerValidationRecipeSchema.parse({
  id: "recipe-capture",
  command: "npm run capture",
  adapterId: "node-npm",
  requiredTools: ["npm"],
  networkDestinations: [],
  capture: null,
});

function catalog(input?: {
  command?: string;
  mediaType?: string;
  raster?: boolean;
  metric?: string;
  maximumDifference?: number;
}) {
  const raster = input?.raster ?? false;
  return {
    captures: [
      {
        command: input?.command ?? observedRecipe.command,
        comparisonOutput: {
          roleId: "capture",
          mediaType: input?.mediaType ?? (raster ? "image/png" : "application/json"),
        },
        auxiliaryOutputs: [],
        profile: raster
          ? {
              kind: "raster" as const,
              viewport: { width: 800, height: 600 },
              output: { width: 800, height: 600 },
              diffOutput: null,
              previewOutput: null,
            }
          : null,
        humanReview: false,
        exactDeterministicGates: [],
        thresholdComparisons: [
          {
            policy: {
              id: "bounded-result",
              metric: input?.metric ?? "byte-difference",
              maximumDifference: input?.maximumDifference ?? 0.1,
            },
            deterministicGates: [],
          },
        ],
      },
    ],
  };
}

describe("repository capture catalog authority", () => {
  it("binds an observed command to an applicable installed comparator", () => {
    const evaluated = evaluateRepositoryCaptureCatalog({
      catalog: catalog(),
      observedRecipes: [observedRecipe],
    });
    expect(evaluated.report).toEqual({
      protocol: "clockgrove.factory/repository-capture-catalog-validation",
      status: "valid",
      diagnostics: [],
      truncated: false,
    });
    expect(evaluated.capabilities).toMatchObject({
      validationRecipes: [
        expect.objectContaining({
          command: "npm run capture",
          capture: expect.objectContaining({
            comparisonOutputRoleId: "capture",
          }),
        }),
      ],
      repositoryComparators: [
        expect.objectContaining({ comparator: { id: "byte-difference", contract: 1 } }),
      ],
    });
    expect(evaluateBoundRepositoryCaptureCapabilities(evaluated.capabilities!).report.status).toBe(
      "valid",
    );
  });

  it("rejects an unobserved capture command without echoing command text", () => {
    const evaluated = evaluateRepositoryCaptureCatalog({
      catalog: catalog({ command: "npm run not-observed" }),
      observedRecipes: [observedRecipe],
    });
    expect(evaluated.capabilities).toBeNull();
    expect(evaluated.report.diagnostics).toEqual([
      expect.objectContaining({
        code: "capture-command-unobserved",
        recipeId: expect.stringMatching(/^recipe-[a-f0-9]{16}$/),
        field: "/captures/0/command",
        expected: { authority: "repository-observed-validation-command" },
        observed: { authority: "unobserved" },
      }),
    ]);
    expect(JSON.stringify(evaluated.report)).not.toContain("not-observed");
  });

  it.each([
    {
      name: "unavailable comparator",
      input: { metric: "missing-difference" },
      code: "comparator-unavailable",
    },
    {
      name: "inapplicable comparator profile",
      input: { metric: "pixel-difference", mediaType: "application/json", raster: false },
      code: "comparator-inapplicable",
    },
    {
      name: "out-of-domain threshold",
      input: { maximumDifference: 1.01 },
      code: "threshold-out-of-domain",
    },
  ])("rejects $name through the shared evaluator", ({ input, code }) => {
    const evaluated = evaluateRepositoryCaptureCatalog({
      catalog: catalog(input),
      observedRecipes: [observedRecipe],
    });
    expect(evaluated.capabilities).toBeNull();
    expect(evaluated.report.diagnostics).toContainEqual(
      expect.objectContaining({ code, recipeId: expect.stringMatching(/^recipe-/) }),
    );
  });

  it("returns bounded structured diagnostics for malformed input", () => {
    const evaluated = evaluateRepositoryCaptureCatalog({
      catalog: { captures: Array.from({ length: 32 }, () => ({ command: 42 })) },
      observedRecipes: [observedRecipe],
    });
    expect(evaluated.report.status).toBe("invalid");
    expect(evaluated.report.diagnostics).toHaveLength(64);
    expect(evaluated.report.truncated).toBe(true);
    expect(evaluated.report.diagnostics[0]).toMatchObject({
      code: "catalog-schema-invalid",
      field: expect.stringMatching(/^\/captures\/0/),
    });
  });

  it("redacts unknown schema keys and values from serialized diagnostics", () => {
    const secretKey = "FACTORY_SECRET_TOKEN_DO_NOT_LEAK";
    const secretValue = "secret-value-do-not-leak";
    const malformed = {
      ...catalog(),
      [secretKey]: secretValue,
      captures: [{ ...catalog().captures[0], [secretKey]: secretValue }],
    };
    const evaluated = evaluateRepositoryCaptureCatalog({
      catalog: malformed,
      observedRecipes: [observedRecipe],
    });
    const serialized = JSON.stringify(evaluated.report);
    expect(evaluated.report.status).toBe("invalid");
    expect(evaluated.report.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "catalog-schema-invalid",
          expected: {
            invariant: "repository-capture-catalog-schema",
            issueClass: "unknown-field",
          },
          observed: expect.objectContaining({
            issueClass: "unknown-field",
            unknownFieldCount: 1,
          }),
        }),
      ]),
    );
    expect(serialized).not.toContain(secretKey);
    expect(serialized).not.toContain(secretValue);
  });

  it("reuses comparator-domain validation for bound compiler request facts", () => {
    const scripts = { test: "vitest run", capture: "node scripts/capture.mjs" };
    const pinned = semanticPinnedFacts({
      paths: [
        "package.json",
        "package-lock.json",
        ".factory/validation-captures.json",
        "scripts/capture.mjs",
        "src/item-1.ts",
      ],
      scripts,
      documents: {
        "package.json": JSON.stringify({ scripts }),
        ".factory/validation-captures.json": JSON.stringify(catalog()),
      },
    });
    const request = semanticRequest(pinned);
    request.repositoryCapture.comparators[0]!.policy.maximumDifference = 2;
    expect(validateCompilerRequest(request).violations).toContainEqual(
      expect.objectContaining({
        code: "schema-invalid",
        field:
          "/repositoryCapture/catalog/captures/0/thresholdComparisons/0/policy/maximumDifference",
        expected: expect.objectContaining({ diagnostic: "threshold-out-of-domain" }),
        observed: 2,
      }),
    );

    request.repositoryCapture.comparators[0]!.policy.maximumDifference = 0.1;
    request.repositoryCapture.comparators[0]!.comparator.contract = 2;
    expect(validateCompilerRequest(request).violations).toContainEqual(
      expect.objectContaining({
        code: "schema-invalid",
        field: "/repositoryCapture/catalog/comparators/bounded-result/comparator",
        expected: expect.objectContaining({ diagnostic: "comparator-identity-mismatch" }),
        observed: { id: "byte-difference", contract: 2 },
      }),
    );
  });
});
