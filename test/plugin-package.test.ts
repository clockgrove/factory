import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  assertNoPackagedWorkflows,
  packagedPaths,
  stagePluginPackage,
} from "../scripts/plugin-package.mjs";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("packaged workflow boundary", () => {
  const temporaryRoots: string[] = [];

  afterEach(() => {
    for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("allows repository CI while excluding it from the staged plugin package", () => {
    expect(existsSync(join(sourceRoot, ".github/workflows/quality.yml"))).toBe(true);
    const root = mkdtempSync(join(tmpdir(), "factory-plugin-package-"));
    temporaryRoots.push(root);
    const stagedRoot = join(root, "staged");

    const paths = stagePluginPackage(sourceRoot, stagedRoot);

    expect(paths).toContain(".github/plugin/marketplace.json");
    expect(paths.some((path) => path.startsWith(".github/workflows"))).toBe(false);
    expect(existsSync(join(stagedRoot, ".github/workflows"))).toBe(false);
  });

  it("rejects a workflow present in packaged content", () => {
    const root = mkdtempSync(join(tmpdir(), "factory-plugin-package-"));
    temporaryRoots.push(root);
    const workflow = join(root, ".github/workflows/quality.yml");
    mkdirSync(dirname(workflow), { recursive: true });
    writeFileSync(workflow, "name: forbidden\n");

    expect(() => assertNoPackagedWorkflows(packagedPaths(root), "fixture package")).toThrow(
      "fixture package includes Factory GitHub Actions workflows: .github/workflows, .github/workflows/quality.yml",
    );
  });

  it("selectively archives and extracts the authoritative marketplace surface", () => {
    const root = mkdtempSync(join(tmpdir(), "factory-plugin-archive-"));
    temporaryRoots.push(root);
    const archive = join(root, "plugin.tar");
    const snapshot = join(root, "snapshot");
    mkdirSync(snapshot);
    const commit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: sourceRoot,
      encoding: "utf8",
    }).trim();

    execFileSync(process.execPath, [
      join(sourceRoot, "scripts/plugin-package.mjs"),
      "archive",
      "--source",
      sourceRoot,
      "--commit",
      commit,
      "--output",
      archive,
    ]);
    execFileSync("tar", ["-xf", archive, "-C", snapshot]);
    const paths = packagedPaths(snapshot);

    expect(paths).toContain(".github/plugin/marketplace.json");
    expect(paths.some((path) => path.startsWith(".github/workflows"))).toBe(false);
    expect(() => assertNoPackagedWorkflows(paths, "archive snapshot")).not.toThrow();
  });

  it.each([
    "/.github/workflows/quality.yml",
    "../.github/workflows/quality.yml",
    ".github/../.github/workflows/quality.yml",
    ".github//workflows/quality.yml",
    "C:/repo/.github/workflows/quality.yml",
    ".github\\workflows\\quality.yml",
  ])("rejects a noncanonical package path %j", (path) => {
    expect(() => assertNoPackagedWorkflows([path], "fixture package")).toThrow(
      "package path is not canonical and relative",
    );
  });
});
