import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withVerifiedReviewCheckout } from "../src/management/review-checkout.js";
import { CodexCliManagementBackend } from "../src/management/codex-cli.js";
import { cleanupLocalWorktree, collectLocalArtifact, createLocalWorktree } from "../src/runtime/local-worktree.js";
import { createValidationEvidence } from "../src/validation/evidence.js";
import type { WorkerPacket } from "../src/protocol/worker-packet.js";

const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const repository = await mkdtemp(join(tmpdir(), "factory-review-checkout-test-"));
  roots.push(repository);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repository, encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  await writeFile(join(repository, "clamp.js"), "export const clamp = 'original';\n");
  git("add", "."); git("commit", "-qm", "base");
  const baseSha = git("rev-parse", "HEAD");
  const worker = await createLocalWorktree(repository, baseSha);
  let artifact;
  try {
    await writeFile(join(worker.path, "slugify.js"), "export const slugify = text => text.toLowerCase();\n");
    artifact = await collectLocalArtifact(worker, "", ["slugify.js"]);
  } finally { await cleanupLocalWorktree(worker); }
  const packet: WorkerPacket = {
    baseSha, goal: "Add slugify", acceptanceCriteria: ["named slugify export lowercases text"],
    allowedPaths: ["slugify.js"], preconditions: [], outOfScope: [], conventions: [],
    validationCommands: ["node --test"], artifactContract: "clockgrove.factory/artifact-v1",
    requirements: { os: ["linux"], architecture: [], tools: ["node"], services: [], networkDestinations: [], permittedSecretNames: [], trust: "trusted_local" },
  };
  // Exact completed validation fixture: the materializer must consume this
  // immutable proof, never rerun its command or invent another completion.
  const evidence = createValidationEvidence({
    protocol: "clockgrove.factory/validation-v1", artifactDigest: artifact.digest,
    baseSha, outputTreeSha: artifact.fileManifest!.resultTreeSha,
    commands: [{ command: "node --test", exitCode: 0, durationMs: 12 }], passed: true,
    startedAt: "2026-09-07T07:05:00.000Z", completedAt: "2026-09-07T07:05:01.000Z",
  });
  await writeFile(join(repository, "clamp.js"), "controller-only dirty clamp\n");
  await writeFile(join(repository, "untracked-controller.txt"), "never review this\n");
  return { repository, packet, artifact, evidence, objectiveNumber: 110, workItemNumber: 113, requiresIsolation: false };
}

describe("exact semantic review materialization", () => {
  it("gives the real management adapter candidate files rather than the dirty controller checkout", async () => {
    const input = await fixture();
    const original = JSON.stringify(input);
    let path = "";
    const runStructured = vi.fn(async (cwd: string) => {
      path = cwd;
      expect(cwd).not.toBe(input.repository);
      expect(await readFile(join(cwd, "slugify.js"), "utf8")).toContain("export const slugify");
      expect(await readFile(join(cwd, "clamp.js"), "utf8")).toContain("original");
      await expect(stat(join(cwd, "untracked-controller.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(execFileSync("git", ["write-tree"], { cwd, encoding: "utf8" }).trim()).toBe(input.evidence.outputTreeSha);
      return { value: { accepted: true, summary: "exact candidate inspected", unmetCriteria: [], risks: [] }, usage: { inputTokens: 4, outputTokens: 2 } };
    });
    const backend = new CodexCliManagementBackend({ runStructured });
    const checkpoint = vi.fn(async () => {});
    await withVerifiedReviewCheckout(input, (repository) => backend.review({ ...input, repository }, checkpoint));
    expect(runStructured).toHaveBeenCalledTimes(1);
    expect(checkpoint).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(input)).toBe(original);
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(input.repository, "clamp.js"), "utf8")).toBe("controller-only dirty clamp\n");
    await expect(stat(join(input.repository, "slugify.js"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["tree", "artifact", "base", "failed", "isolation", "packet-isolation"])("refuses %s mismatch before review dispatch", async (kind) => {
    const input = await fixture();
    const { digest: _digest, ...evidence } = input.evidence;
    void _digest;
    if (kind === "tree") evidence.outputTreeSha = "a".repeat(40);
    if (kind === "artifact") evidence.artifactDigest = "b".repeat(64);
    if (kind === "base") evidence.baseSha = "c".repeat(40);
    if (kind === "failed") evidence.passed = false;
    if (kind === "isolation") input.requiresIsolation = true;
    if (kind === "packet-isolation") input.packet.requirements.trust = "isolated";
    input.evidence = createValidationEvidence(evidence);
    const review = vi.fn(async () => {});
    await expect(withVerifiedReviewCheckout(input, review)).rejects.toThrow();
    expect(review).not.toHaveBeenCalled();
  });

  it("does not let inherited Git redirection touch an outside index or checkout", async () => {
    const input = await fixture();
    const beforeIndex = await readFile(join(input.repository, ".git", "index"));
    vi.stubEnv("GIT_DIR", join(input.repository, ".git"));
    vi.stubEnv("GIT_WORK_TREE", input.repository);
    vi.stubEnv("GIT_INDEX_FILE", join(input.repository, ".git", "index"));
    vi.stubEnv("GIT_OBJECT_DIRECTORY", join(input.repository, ".git", "objects"));
    vi.stubEnv("GIT_CONFIG_COUNT", "1");
    vi.stubEnv("GIT_CONFIG_KEY_0", "core.worktree");
    vi.stubEnv("GIT_CONFIG_VALUE_0", input.repository);
    const review = vi.fn(async (repository: string) => {
      expect(repository).not.toBe(input.repository);
      expect(await readFile(join(repository, "slugify.js"), "utf8")).toContain("export const slugify");
    });
    await withVerifiedReviewCheckout(input, review);
    expect(review).toHaveBeenCalledTimes(1);
    expect(await readFile(join(input.repository, ".git", "index"))).toEqual(beforeIndex);
    expect(await readFile(join(input.repository, "clamp.js"), "utf8")).toBe("controller-only dirty clamp\n");
    await expect(stat(join(input.repository, "slugify.js"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses unavailable original objects rather than falling back to controller files", async () => {
    const input = await fixture();
    await rm(join(input.repository, ".git"), { recursive: true });
    const review = vi.fn(async () => {});
    await expect(withVerifiedReviewCheckout(input, review)).rejects.toThrow();
    expect(review).not.toHaveBeenCalled();
  });

  it("cleans its exact private materialization when the review fails", async () => {
    const input = await fixture();
    let path = "";
    const failure = Error("review unavailable");
    await expect(withVerifiedReviewCheckout(input, async (repository) => {
      path = repository;
      throw failure;
    })).rejects.toBe(failure);
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
