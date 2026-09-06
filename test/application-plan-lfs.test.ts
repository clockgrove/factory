import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildPlanReport,
  readPlanningRepositoryLayout,
  validatePlanningCheckout,
} from "../src/application/plan.js";
import { assertCleanPlanningFiles } from "../src/application/checkout.js";
import * as pinned from "../src/execution/pinned-compilation-tree.js";
import * as lfs from "../src/repository-profiles/git-lfs.js";
import { readRepositoryFacts } from "../src/repository-profiles/read.js";
import { compileObjective } from "../src/compiler/index.js";
import {
  ManagementOutputError,
  type CompilationCheckpoint,
  type CompilationContext,
  type CompilationResult,
  type ManagementBackend,
} from "../src/management/backend.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const snapshot = { id: "objective", number: 7, title: "Feature", body: "Implement feature", defaultBranch: "main", workItems: [], factoryEvents: [] };
const usage = { inputTokens: 120, outputTokens: 30, cachedInputTokens: 40 };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "factory-plan-lfs-test-"));
  roots.push(root);
  const repository = join(root, "repository"), bin = join(root, "bin");
  await mkdir(repository); await mkdir(bin);
  await symlink("/usr/bin/git", join(bin, "git"));
  const toolMarker = join(root, "tool-must-not-execute");
  await writeFile(join(bin, "git-lfs"), "#!/bin/sh\ntouch '" + toolMarker + "'\nexit 1\n", { mode: 0o755 });
  vi.stubEnv("PATH", bin);
  const git = (...args: string[]) => execFileSync("/usr/bin/git", ["-c", "core.hooksPath=/dev/null", "-C", repository, ...args], {
    encoding: "utf8", timeout: 5_000,
    env: { PATH: "/usr/bin:/bin", HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null" },
  }).trim();
  git("init", "--quiet", "--template=");
  git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
  git("remote", "add", "origin", "https://github.com/o/r.git");
  await writeFile(join(repository, "package.json"), '{"scripts":{"test":"node --test"}}\n');
  await writeFile(join(repository, "sample.test.mjs"), 'import {test} from "node:test";\ntest("sample",()=>{});\n');
  const assets = [];
  for (const [name, version] of [["canonical", "https://git-lfs.github.com/spec/v1"], ["legacy", "https://hawser.github.com/spec/v1"]] as const) {
    const bytes = Buffer.from("Synthetic " + name + " cached content, not a credential.\n");
    const oid = createHash("sha256").update(bytes).digest("hex");
    const path = name + ".bin";
    const pointer = "version " + version + "\noid sha256:" + oid + "\nsize " + bytes.length + "\n";
    await writeFile(join(repository, path), pointer);
    const cache = join(repository, ".git", "lfs", "objects", oid.slice(0, 2), oid.slice(2, 4), oid);
    await mkdir(dirname(cache), { recursive: true }); await writeFile(cache, bytes);
    assets.push({ path, bytes, oid, pointer, cache });
  }
  git("add", "package.json", "sample.test.mjs", ...assets.map((asset) => asset.path));
  // Attributes are installed after raw pointer staging: no clean/smudge executable is needed.
  await writeFile(join(repository, ".gitattributes"), "*.bin filter=lfs diff=lfs merge=lfs -text\n");
  git("add", ".gitattributes"); git("commit", "-qm", "LFS planning baseline");
  const baseSha = git("rev-parse", "HEAD");
  const planning = {
    repositoryPath: repository, validateCheckout: validatePlanningCheckout,
    readRepositoryLayout: (max: number, base?: string) => readPlanningRepositoryLayout(repository, max, base),
  };
  return { root, repository, bin, assets, baseSha, planning, git, toolMarker };
}
async function resultFor(context: CompilationContext): Promise<CompilationResult> {
  const repositoryFacts = await readRepositoryFacts(context.repository, context.repositoryFiles, context.repositoryLfs);
  const objective = compileObjective({
    title: "Feature", baseSha: context.baseSha, repositoryFacts,
    workItems: [{
      id: "feature", title: "Feature", goal: "Implement feature", acceptance: ["Feature works"],
      scope: ["sample.test.mjs"], preconditions: [], outOfScope: [], conventions: [], dependsOn: [],
      baseSha: context.baseSha, validationCommands: ["node --test sample.test.mjs"],
      requirements: { os: ["linux"], architecture: [], tools: ["node"], services: [], networkDestinations: [], permittedSecretNames: [], trust: "trusted_local" },
      artifactContract: "clockgrove.factory/artifact-v1",
    }],
  });
  return { objective, usage };
}
function backend(compile: ManagementBackend["compile"]): ManagementBackend {
  return {
    id: "observed-test-management", compile,
    probe: async () => ({ available: true, authenticated: true }),
    review: async () => { throw new Error("review not expected"); },
  };
}
function plan(f: Awaited<ReturnType<typeof fixture>>, compile: ManagementBackend["compile"]) {
  return buildPlanReport({
    repository: "o/r", request: { objective: 7, compile: true, baseSha: f.baseSha },
    snapshot, planning: { ...f.planning, management: backend(compile) },
  });
}

describe("explicit plan pinned LFS preflight", () => {
  it.each([false, true])("hydrates verified assets only in an exact isolated tree (original hydrated: %s)", async (hydrated) => {
    const f = await fixture();
    if (hydrated) for (const asset of f.assets) await writeFile(join(f.repository, asset.path), asset.bytes);
    const index = await readFile(join(f.repository, ".git/index"));
    const config = await readFile(join(f.repository, ".git/config"));
    const compile = vi.fn(async (context: CompilationContext, checkpoint: CompilationCheckpoint) => {
      expect(context.repository).not.toBe(f.repository);
      expect(context.baseSha).toBe(f.baseSha);
      expect(context.repositoryFiles).toEqual([".gitattributes", "canonical.bin", "legacy.bin", "package.json", "sample.test.mjs"]);
      expect(context.repositoryLfs).toMatchObject({ baseSha: f.baseSha, attributes: true, requiredTools: ["git-lfs"] });
      for (const asset of f.assets) {
        expect(await readFile(join(context.repository, asset.path))).toEqual(asset.bytes);
        const pointer = execFileSync("/usr/bin/git", ["-C", context.repository, "show", ":" + asset.path], { encoding: "utf8" });
        expect(pointer).toBe(asset.pointer);
      }
      const result = await resultFor(context);
      expect(result.objective.workItems[0]!.requirements?.tools).toContain("git-lfs");
      await checkpoint(result); return result;
    });
    const report = await buildPlanReport({
      repository: "o/r", request: { objective: 7, compile: true, baseSha: f.baseSha.toUpperCase() }, snapshot,
      planning: { ...f.planning, management: backend(compile), readRepositoryLayout: async () => ({ files: ["invented.ts"], truncated: false }) },
    });
    expect(report.compilation).toMatchObject({ result: "completed", usagePersistence: "response-only" });
    expect(report.usage).toEqual(usage); expect(compile).toHaveBeenCalledTimes(1);
    expect(await readFile(join(f.repository, ".git/index"))).toEqual(index);
    expect(await readFile(join(f.repository, ".git/config"))).toEqual(config);
    for (const asset of f.assets) expect(await readFile(join(f.repository, asset.path))).toEqual(hydrated ? asset.bytes : Buffer.from(asset.pointer));
    await expect(access(compile.mock.calls[0]![0].repository)).rejects.toThrow();
    await expect(access(f.toolMarker)).rejects.toThrow();
  });

  it.each(["tool", "missing-object", "corrupt-object", "changed-source", "symlink", "mode"] as const)("refuses %s before the model and preserves unavailable usage", async (fault) => {
    const f = await fixture(), asset = f.assets[0]!;
    if (fault === "tool") await rm(join(f.bin, "git-lfs"));
    if (fault === "missing-object") await rm(asset.cache);
    if (fault === "corrupt-object") await writeFile(asset.cache, Buffer.alloc(asset.bytes.length, 1));
    if (fault === "changed-source") await writeFile(join(f.repository, asset.path), Buffer.alloc(asset.bytes.length, 2));
    if (fault === "symlink") { await rm(join(f.repository, asset.path)); await symlink(asset.cache, join(f.repository, asset.path)); }
    if (fault === "mode") await chmod(join(f.repository, asset.path), 0o755);
    const compile = vi.fn();
    const report = await plan(f, compile);
    expect(report.compilation).toMatchObject({ result: "failed", usagePersistence: "none" });
    expect(report.usage).toBeNull(); expect(report.graph).toBeNull(); expect(compile).not.toHaveBeenCalled();
    if (fault === "tool") expect(report.diagnostics[0]!.summary).toContain("pinned repository requires git-lfs");
    if (fault === "missing-object") expect(report.diagnostics[0]!.summary).toContain("required LFS object");
    if (fault === "corrupt-object") expect(report.diagnostics[0]!.summary).toContain("LFS cache object digest mismatch");
    await expect(access(f.toolMarker)).rejects.toThrow();
  });

  it("does not accept forged hydrated facts or staged binary replacements as clean pointer state", async () => {
    const f = await fixture();
    const facts = await lfs.assertLocalLfsAvailable(f.repository, f.baseSha);
    for (const asset of f.assets) await writeFile(join(f.repository, asset.path), asset.bytes);
    const forged = structuredClone(facts); forged.assets[0]!.oid = "0".repeat(64);
    await expect(assertCleanPlanningFiles(f.repository, forged)).rejects.toThrow(/actual Git pointer/);
    const oid = execFileSync("/usr/bin/git", ["-C", f.repository, "hash-object", "-w", "--stdin"], { input: f.assets[0]!.bytes, encoding: "utf8" }).trim();
    f.git("update-index", "--cacheinfo", "100644", oid, f.assets[0]!.path);
    await expect(validatePlanningCheckout(f.repository, f.baseSha, "o/r")).rejects.toThrow(/index differs/);
  });

  it("preserves the paid successful result and usage when exact tree cleanup fails", async () => {
    const f = await fixture(), prepare = pinned.materializePinnedCompilationTree;
    vi.spyOn(pinned, "materializePinnedCompilationTree").mockImplementation(async (...args) => {
      const tree = await prepare(...args); roots.push(tree.root);
      return { ...tree, dispose: async () => { throw new Error("synthetic cleanup failure"); } };
    });
    const compile = vi.fn(async (context: CompilationContext, checkpoint: CompilationCheckpoint) => {
      const result = await resultFor(context); await checkpoint(result); return result;
    });
    const report = await plan(f, compile);
    expect(report.compilation.result).toBe("completed");
    expect(report.proposedGraph?.workItems).toHaveLength(1); expect(report.usage).toEqual(usage);
    expect(report.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ status: "warning", summary: expect.stringContaining("compilation tree cleanup needs attention") })]));
    expect(compile).toHaveBeenCalledTimes(1);
  });

  it("preserves known failed-call usage when cleanup also fails", async () => {
    const f = await fixture(), prepare = pinned.materializePinnedCompilationTree;
    vi.spyOn(pinned, "materializePinnedCompilationTree").mockImplementation(async (...args) => {
      const tree = await prepare(...args); roots.push(tree.root);
      return { ...tree, dispose: async () => { throw new Error("cleanup failure"); } };
    });
    const compile = vi.fn(async () => { throw new ManagementOutputError(new Error("invalid management output"), usage); });
    const report = await plan(f, compile);
    expect(report.compilation).toMatchObject({ result: "failed", usagePersistence: "response-only" });
    expect(report.usage).toEqual(usage); expect(compile).toHaveBeenCalledTimes(1);
    expect(report.diagnostics[0]!.summary).toBe("invalid management output");
    expect(report.diagnostics[1]!.status).toBe("warning");
  });

  it("disposes a prepared tree after hydration failure without invoking management", async () => {
    const f = await fixture(), prepare = pinned.materializePinnedCompilationTree;
    let preparedPath = "";
    vi.spyOn(pinned, "materializePinnedCompilationTree").mockImplementation(async (...args) => {
      const tree = await prepare(...args); preparedPath = tree.path; return tree;
    });
    vi.spyOn(lfs, "materializeLocalLfsAssets").mockRejectedValue(new Error("LFS cache object changed during hydration"));
    const compile = vi.fn();
    const report = await plan(f, compile);
    expect(report.compilation.result).toBe("failed"); expect(report.usage).toBeNull();
    expect(compile).not.toHaveBeenCalled(); expect(preparedPath).not.toBe("");
    await expect(access(preparedPath)).rejects.toThrow();
  });

  it("keeps postcompile source checking and its observed usage for later hydrated edits", async () => {
    const f = await fixture();
    const compile = vi.fn(async (context: CompilationContext, checkpoint: CompilationCheckpoint) => {
      const result = await resultFor(context); await checkpoint(result);
      await writeFile(join(f.repository, f.assets[0]!.path), "changed after observed paid result\n");
      return result;
    });
    const report = await plan(f, compile);
    expect(report.compilation.result).toBe("failed"); expect(report.usage).toEqual(usage);
    expect(report.diagnostics[0]!.summary).toContain("tracked changes"); expect(compile).toHaveBeenCalledTimes(1);
  });
});
