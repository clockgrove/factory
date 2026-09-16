import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  materializePinnedCompilationTree,
  sealPinnedCompilationTreeProof,
} from "../src/execution/pinned-compilation-tree.js";
import { pinFixtureRepository } from "./helpers/compiler-proposal.js";
import {
  assertIssue404CanonicalFixture,
  type Issue404FixtureFile,
} from "./helpers/issue404-live-authority.js";

describe("issue #404 qualification fixture", () => {
  it("compares a real pinned tree with case-sensitive canonical manifest ordering", async () => {
    const repository = await mkdtemp(join(tmpdir(), "factory-issue404-fixture-"));
    const files: Issue404FixtureFile[] = [
      { path: "package.json", content: '{"private":true}\n' },
      { path: "package-lock.json", content: '{"lockfileVersion":3}\n' },
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
    } finally {
      await tree.dispose();
      await rm(repository, { recursive: true, force: true });
    }
  });
});
