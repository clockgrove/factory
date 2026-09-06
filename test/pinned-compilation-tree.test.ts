import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { materializePinnedCompilationTree } from "../src/execution/pinned-compilation-tree.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const dispose of cleanup.splice(0).reverse()) await dispose(); });
async function fixture() {
  const repository = await mkdtemp(join(tmpdir(), "factory-pinned-test-"));
  cleanup.push(() => rm(repository, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repository, encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  await writeFile(join(repository, "input.txt"), "original\n");
  git("add", "."); git("commit", "-qm", "original");
  return { repository, git, base: git("rev-parse", "HEAD") };
}

describe("hook/filter-free exact compilation trees", () => {
  it("strips inherited Git configuration injection and materializes a mixed-size batch", async () => {
    const f = await fixture();
    await Promise.all(Array.from({ length: 64 }, (_, index) => writeFile(join(f.repository, `batch-${index}.txt`), "x".repeat(index))));
    f.git("add", "."); f.git("commit", "-qm", "batch");
    const base = f.git("rev-parse", "HEAD");
    vi.stubEnv("GIT_DIR", "/does-not-exist");
    vi.stubEnv("GIT_CONFIG_PARAMETERS", "invalid inherited configuration");
    vi.stubEnv("GIT_CONFIG_COUNT", "1");
    vi.stubEnv("GIT_CONFIG_KEY_0", "core.repositoryformatversion");
    vi.stubEnv("GIT_CONFIG_VALUE_0", "9999");
    vi.stubEnv("GIT_NO_LAZY_FETCH", "0");
    const pinned = await materializePinnedCompilationTree(f.repository, base);
    cleanup.push(pinned.dispose);
    expect(pinned.files).toHaveLength(65);
    expect(await readFile(join(pinned.path, "batch-0.txt"), "utf8")).toBe("");
    expect(await readFile(join(pinned.path, "batch-63.txt"), "utf8")).toBe("x".repeat(63));
  });
  it("pins files, index and HEAD independently of dirty or advancing shared trunk", async () => {
    const f = await fixture();
    await writeFile(join(f.repository, "input.txt"), "next\n");
    f.git("commit", "-qam", "next");
    const next = f.git("rev-parse", "HEAD");
    await writeFile(join(f.repository, "input.txt"), "uncommitted\n");
    await writeFile(join(f.repository, "untracked.txt"), "not a compiler fact\n");
    const [a, b] = await Promise.all([
      materializePinnedCompilationTree(f.repository, f.base),
      materializePinnedCompilationTree(f.repository, next),
    ]);
    cleanup.push(a.dispose, b.dispose);
    expect(a.path).not.toBe(b.path);
    expect(a.files).toEqual(["input.txt"]);
    expect(await readFile(join(a.path, "input.txt"), "utf8")).toBe("original\n");
    expect(await readFile(join(b.path, "input.txt"), "utf8")).toBe("next\n");
    expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: a.path, encoding: "utf8" }).trim()).toBe(f.base);
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: a.path, encoding: "utf8" }).trim()).toBe("");
    expect(await readFile(join(f.repository, "input.txt"), "utf8")).toBe("uncommitted\n");
  });

  it("does not run source hooks or smudge filters and preserves binary bytes", async () => {
    const f = await fixture();
    const bytes = Buffer.from([0, 255, 10, 13, 128]);
    await writeFile(join(f.repository, "asset.bin"), bytes);
    await writeFile(join(f.repository, ".gitattributes"), "*.bin filter=unsafe\n");
    f.git("add", "."); f.git("commit", "-qm", "binary");
    f.git("config", "filter.unsafe.smudge", "sh -c 'touch FILTER_RAN; exit 1'");
    f.git("config", "filter.unsafe.required", "true");
    await writeFile(join(f.repository, ".git", "hooks", "post-checkout"), "#!/bin/sh\ntouch HOOK_RAN\nexit 1\n", { mode: 0o700 });
    const pinned = await materializePinnedCompilationTree(f.repository, f.git("rev-parse", "HEAD"));
    cleanup.push(pinned.dispose);
    expect(await readFile(join(pinned.path, "asset.bin"))).toEqual(bytes);
    await expect(stat(join(f.repository, "HOOK_RAN"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(pinned.path, "FILTER_RAN"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(pinned.path, ".git", "hooks", "post-checkout"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects escaping symlink entries without materializing or executing them", async () => {
    const f = await fixture();
    await symlink("/etc/passwd", join(f.repository, "escape"));
    f.git("add", "."); f.git("commit", "-qm", "unsafe entry");
    await expect(materializePinnedCompilationTree(f.repository, f.git("rev-parse", "HEAD")))
      .rejects.toThrow("unsupported path or Git entry mode");
  });

  it("returns an exact owned worker root and cleanup never removes the source repository", async () => {
    const f = await fixture();
    const pinned = await materializePinnedCompilationTree(f.repository, f.base, { purpose: "worktree" });
    cleanup.push(pinned.dispose);
    expect(pinned.root).toContain("clockgrove-factory-worktree-");
    expect(pinned.path).toBe(join(pinned.root, "worktree"));
    await pinned.dispose();
    await expect(stat(pinned.root)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(f.repository, "input.txt"), "utf8")).toBe("original\n");
  });
});
