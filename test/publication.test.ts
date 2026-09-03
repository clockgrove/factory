import { execFileSync } from "node:child_process";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { GitCommitObject } from "../src/control/lease.js";
import { collectLocalArtifact, cleanupLocalWorktree, createLocalWorktree } from "../src/runtime/local-worktree.js";
import type { PublicationStore } from "../src/publication/publisher.js";
import { integrationReadiness, publishValidated } from "../src/publication/publisher.js";
import { discardValidationResult, validateArtifactClean } from "../src/validation/clean-run.js";
import type { WorkerPacket } from "../src/protocol/worker-packet.js";

function git(repository: string, args: string[], input?: Buffer | string): string {
  return execFileSync("git", args, {
    cwd: repository,
    encoding: "utf8",
    ...(input === undefined ? {} : { input }),
  }).trim();
}

async function fixture() {
  const repository = await mkdtemp(join(tmpdir(), "factory-publication-"));
  git(repository, ["init", "-q", "-b", "main"]);
  git(repository, ["config", "user.name", "Factory Test"]);
  git(repository, ["config", "user.email", "factory@example.invalid"]);
  await writeFile(join(repository, "value.txt"), "base\n");
  git(repository, ["add", "value.txt"]);
  git(repository, ["commit", "-q", "-m", "base"]);
  const oid = git(repository, ["rev-parse", "HEAD"]);
  const treeOid = git(repository, ["rev-parse", "HEAD^{tree}"]);
  return { repository, base: { oid, treeOid, parentOids: [], message: "base", serverTime: new Date() } satisfies GitCommitObject };
}

class GitObjectStore implements PublicationStore {
  refs = new Map<string, string>();
  pull: { number: number; htmlUrl: string; state: string; merged: boolean; headSha: string } | null = null;
  checks = { pending: [] as string[], failed: [] as string[] };
  mergeable: boolean | null = true;
  mergeableState = "clean";
  loseCreatePullResponse = false;

  constructor(readonly repository: string, readonly baseSha: string) {}

  async createBlob(content: Buffer): Promise<string> {
    return git(this.repository, ["hash-object", "-w", "--stdin"], content);
  }
  async createTree(args: { baseTreeOid: string; entries: Array<{ path: string; mode: "100644" | "100755" | "120000"; type: "blob"; sha: string | null }> }): Promise<string> {
    const index = join(this.repository, ".git", `factory-index-${Date.now()}-${Math.random()}`);
    const env = { ...process.env, GIT_INDEX_FILE: index };
    try {
      execFileSync("git", ["read-tree", args.baseTreeOid], { cwd: this.repository, env });
      for (const entry of args.entries) {
        if (entry.sha) {
          execFileSync("git", ["update-index", "--add", "--cacheinfo", entry.mode, entry.sha, entry.path], { cwd: this.repository, env });
        } else {
          execFileSync("git", ["update-index", "--force-remove", "--", entry.path], { cwd: this.repository, env });
        }
      }
      return execFileSync("git", ["write-tree"], { cwd: this.repository, env, encoding: "utf8" }).trim();
    } finally {
      await unlink(index).catch(() => {});
    }
  }
  async createCommit(args: { treeOid: string; parentOids: string[]; message: string }): Promise<string> {
    return git(this.repository, ["commit-tree", args.treeOid, ...args.parentOids.flatMap((parent) => ["-p", parent]), "-F", "-"], args.message);
  }
  async createRef(ref: string, oid: string): Promise<boolean> {
    const present = this.refs.get(ref);
    if (present) return present === oid;
    this.refs.set(ref, oid);
    return true;
  }
  async findPullRequestForBranch(): Promise<typeof this.pull> { return this.pull; }
  async createPullRequest(args: { head: string }): Promise<{ number: number; htmlUrl: string; headSha: string }> {
    const headSha = this.refs.get(`refs/heads/${args.head}`)!;
    this.pull = { number: 7, htmlUrl: "https://example.invalid/pull/7", state: "open", merged: false, headSha };
    if (this.loseCreatePullResponse) throw new Error("connection reset after write");
    return this.pull;
  }
  async readPullRequest(): Promise<{ state: string; merged: boolean; mergeable: boolean | null; mergeableState: string; draft: boolean; headSha: string; baseSha: string }> {
    return { state: this.pull?.state ?? "open", merged: this.pull?.merged ?? false, mergeable: this.mergeable, mergeableState: this.mergeableState, draft: false, headSha: this.pull!.headSha, baseSha: this.baseSha };
  }
  async readChecks(): Promise<{ pending: string[]; failed: string[] }> { return this.checks; }
  async mergePullRequest(): Promise<string> { return "f".repeat(40); }
  async closeIssue(): Promise<void> {}
  async closePullRequest(): Promise<void> {}
}

describe("host-owned publication", () => {
  it("uploads exactly the independently validated tree and is idempotent", async () => {
    const { repository, base } = await fixture();
    const packet: WorkerPacket = {
      goal: "change value", acceptanceCriteria: ["value changed"], allowedPaths: ["value.txt"],
      preconditions: [], outOfScope: [], conventions: [], baseSha: base.oid,
      validationCommands: ["grep -qx changed value.txt"],
      requirements: { os: ["linux"], architecture: [], tools: ["git", "grep"], services: [], networkDestinations: [], permittedSecretNames: [], trust: "trusted_local" },
      artifactContract: "clockgrove.factory/artifact-v1",
    };
    const worker = await createLocalWorktree(repository, base.oid);
    await writeFile(join(worker.path, "value.txt"), "changed\n");
    const artifact = await collectLocalArtifact(worker);
    await cleanupLocalWorktree(worker);
    const validation = await validateArtifactClean({ repository, artifact, packet });
    const store = new GitObjectStore(repository, base.oid);
    const args = {
      store, assertLease: async () => {}, base, validation, artifact,
      objective: 1, workItem: 2, attempt: 1, title: "Change value", baseBranch: "main",
    };
    const first = await publishValidated(args);
    const second = await publishValidated(args);
    expect(second).toEqual(first);
    expect(git(repository, ["rev-parse", `${first.commitSha}^{tree}`])).toBe(validation.evidence.outputTreeSha);
    await discardValidationResult(validation);
    await rm(repository, { recursive: true, force: true });
  });

  it("waits, fails, and becomes ready from current GitHub evidence", async () => {
    const { repository, base } = await fixture();
    const store = new GitObjectStore(repository, base.oid);
    store.pull = { number: 7, htmlUrl: "", state: "open", merged: false, headSha: "c".repeat(40) };
    const pull = { branch: "factory/x", commitSha: "c".repeat(40), number: 7, htmlUrl: "" };
    store.checks.pending = ["test"];
    await expect(integrationReadiness(store, pull)).resolves.toMatchObject({ state: "wait" });
    store.checks.pending = [];
    store.mergeableState = "behind";
    await expect(integrationReadiness(store, pull)).resolves.toMatchObject({ state: "failed" });
    store.mergeableState = "clean";
    await expect(integrationReadiness(store, pull)).resolves.toEqual({ state: "ready", headSha: pull.commitSha });
    await expect(integrationReadiness(store, pull, "d".repeat(40))).resolves.toMatchObject({
      state: "failed",
      reason: expect.stringContaining("base branch advanced"),
    });
    store.pull = { ...store.pull, merged: true, state: "closed", headSha: "e".repeat(40) };
    await expect(integrationReadiness(store, pull)).resolves.toEqual({
      state: "failed",
      reason: "pull request head changed after validation",
    });
    await rm(repository, { recursive: true, force: true });
  });

  it("recovers a pull request whose create response was lost", async () => {
    const { repository, base } = await fixture();
    const packet: WorkerPacket = {
      goal: "change value", acceptanceCriteria: ["value changed"], allowedPaths: ["value.txt"],
      preconditions: [], outOfScope: [], conventions: [], baseSha: base.oid,
      validationCommands: ["grep -qx changed value.txt"],
      requirements: { os: ["linux"], architecture: [], tools: ["git", "grep"], services: [], networkDestinations: [], permittedSecretNames: [], trust: "trusted_local" },
      artifactContract: "clockgrove.factory/artifact-v1",
    };
    const worker = await createLocalWorktree(repository, base.oid);
    await writeFile(join(worker.path, "value.txt"), "changed\n");
    const artifact = await collectLocalArtifact(worker);
    await cleanupLocalWorktree(worker);
    const validation = await validateArtifactClean({ repository, artifact, packet });
    const store = new GitObjectStore(repository, base.oid);
    store.loseCreatePullResponse = true;
    await expect(publishValidated({
      store, assertLease: async () => {}, base, validation, artifact,
      objective: 1, workItem: 2, attempt: 1, title: "Change value", baseBranch: "main",
    })).resolves.toMatchObject({ number: 7 });
    await discardValidationResult(validation);
    await rm(repository, { recursive: true, force: true });
  });
});
