import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  assertCompilerProjectionAuthority,
  prepareCompilerRequest,
} from "../src/compiler/proposal.js";
import { compilerEvalDigest } from "../src/evaluation/compiler-eval.js";
import {
  materializePinnedCompilationTree,
  sealPinnedCompilationTreeProof,
} from "../src/execution/pinned-compilation-tree.js";
import { CodexCliManagementBackend } from "../src/management/codex-cli.js";
import { pinFixtureRepository } from "./helpers/compiler-proposal.js";
import {
  assertIssue404CanonicalFixture,
  issue404QualificationCompilationContext,
  type Issue404FixtureFile,
} from "./helpers/issue404-live-authority.js";

describe("issue #404 qualification fixture", () => {
  it("compares a real pinned tree with case-sensitive canonical manifest ordering", async () => {
    const repository = await mkdtemp(join(tmpdir(), "factory-issue404-fixture-"));
    const files: Issue404FixtureFile[] = [
      {
        path: "package.json",
        content:
          '{"name":"issue404-fixture","private":true,"type":"module","scripts":{"test":"node --test"}}\n',
      },
      {
        path: "package-lock.json",
        content: '{"name":"issue404-fixture","lockfileVersion":3,"packages":{}}\n',
      },
      { path: "README.md", content: "uppercase readme\n" },
      { path: "readme.md", content: "lowercase readme\n" },
      { path: "src/input.ts", content: "export const input = true;\n" },
    ];
    await mkdir(join(repository, "src"));
    await Promise.all(files.map((file) => writeFile(join(repository, file.path), file.content)));
    const baseSha = pinFixtureRepository(repository, {
      commitDate: "2000-01-01T00:00:00.000Z",
    });
    const tree = await materializePinnedCompilationTree(repository, baseSha);
    try {
      const manifest = await assertIssue404CanonicalFixture({
        tree,
        baseSha,
        files,
        forbiddenPaths: [".factory-issue404-qualification.json"],
      });
      expect(manifest.map((entry) => entry.path)).toEqual(tree.files);
      expect(tree.files).toEqual([
        "README.md",
        "package-lock.json",
        "package.json",
        "readme.md",
        "src/input.ts",
      ]);
      await sealPinnedCompilationTreeProof(tree.proof);
      const context = issue404QualificationCompilationContext({
        repository: tree.path,
        objective: { number: 4041, title: "Qualification", body: "Implement the fixture." },
        baseSha,
        repositoryFiles: tree.files,
        pinnedCompilationTree: tree.proof,
      });
      const objectiveDigest = compilerEvalDigest(context.objective);
      const prepared = await prepareCompilerRequest({
        context,
        inventory: {
          version: 1,
          objectiveDigest,
          baseSha,
          evidence: [
            {
              id: "objective",
              kind: "objective",
              identity: objectiveDigest,
              excerpt: context.objective.body,
            },
          ],
          obligations: [
            {
              id: "fixture",
              text: "Implement the fixture.",
              kind: "explicit",
              evidenceIds: ["objective"],
              acceptanceEvidence: "The fixture behavior is tested.",
            },
          ],
        },
      });
      expect(() =>
        assertCompilerProjectionAuthority(prepared.request, {
          pinnedFacts: prepared.pinnedFacts,
          runPolicy: context.runPolicy,
        }),
      ).not.toThrow();

      const providerBoundary = vi.fn(async () => {
        throw new Error("provider boundary reached");
      });
      const divergent = {
        ...context,
        allowedNetworkDestinations: ["registry.npmjs.org"],
      };
      await expect(
        new CodexCliManagementBackend({ runStructured: providerBoundary }).proposePlan(
          prepared.request,
          async () => {},
          { pinnedFacts: prepared.pinnedFacts, runPolicy: context.runPolicy },
          undefined,
          divergent,
        ),
      ).rejects.toThrow("compilation context network authority differs from run policy");
      expect(providerBoundary).not.toHaveBeenCalled();
    } finally {
      await tree.dispose();
      await rm(repository, { recursive: true, force: true });
    }
  });
});
