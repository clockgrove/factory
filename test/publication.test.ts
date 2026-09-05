import { execFileSync } from "node:child_process";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { GitCommitObject } from "../src/control/lease.js";
import {
  collectLocalArtifact,
  cleanupLocalWorktree,
  createLocalWorktree,
} from "../src/runtime/local-worktree.js";
import type { PublicationStore } from "../src/publication/publisher.js";
import { integrationReadiness, publishValidated } from "../src/publication/publisher.js";
import { discardValidationResult, validateArtifactClean } from "../src/validation/clean-run.js";
import { bindValidationToPublishedHead } from "../src/validation/plan.js";
import { createValidationEvidence } from "../src/validation/evidence.js";
import { bindMergeCandidateValidation } from "../src/publication/merge-candidate.js";
import type { WorkerPacket } from "../src/protocol/worker-packet.js";

function git(repository: string, args: string[], input?: Buffer | string): string {
  return execFileSync("git", args, {
    cwd: repository,
    encoding: "utf8",
    ...(input === undefined ? {} : { input }),
  }).trim();
}

function exactHeadValidation(headSha: string) {
  return bindValidationToPublishedHead({
    validation: {
      passed: true,
      digest: "a".repeat(64),
      baseSha: "b".repeat(40),
      outputTreeSha: "d".repeat(40),
    },
    publishedHeadSha: headSha,
    publishedTreeSha: "d".repeat(40),
    publishedBaseSha: "b".repeat(40),
  });
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
  return {
    repository,
    base: {
      oid,
      treeOid,
      parentOids: [],
      message: "base",
      serverTime: new Date(),
    } satisfies GitCommitObject,
  };
}

class GitObjectStore implements PublicationStore {
  refs = new Map<string, string>();
  pull: {
    number: number;
    htmlUrl: string;
    state: string;
    merged: boolean;
    headSha: string;
  } | null = null;
  checks = { pending: [] as string[], failed: [] as string[] };
  mergeable: boolean | null = true;
  mergeableState = "clean";
  baseRef = "main";
  mergeTree = "d".repeat(40);
  mergeParents = ["b".repeat(40)];
  loseCreatePullResponse = false;
  loseCreateRefResponse = false;

  constructor(
    readonly repository: string,
    readonly baseSha: string,
  ) {}

  async readRef(ref: string): Promise<string | null> {
    return this.refs.get(ref) ?? null;
  }
  async readCommit(oid: string): Promise<GitCommitObject> {
    if (oid === "f".repeat(40)) {
      return {
        oid,
        treeOid: this.mergeTree,
        parentOids: this.mergeParents,
        message: "squash",
        serverTime: new Date(),
      };
    }
    return {
      oid,
      treeOid: git(this.repository, ["rev-parse", `${oid}^{tree}`]),
      parentOids: git(this.repository, ["rev-list", "--parents", "-n", "1", oid])
        .split(" ")
        .slice(1),
      message: git(this.repository, ["show", "-s", "--format=%B", oid]),
      serverTime: new Date(),
    };
  }

  async createBlob(content: Buffer): Promise<string> {
    return git(this.repository, ["hash-object", "-w", "--stdin"], content);
  }
  async createTree(args: {
    baseTreeOid: string;
    entries: Array<{
      path: string;
      mode: "100644" | "100755" | "120000";
      type: "blob";
      sha: string | null;
    }>;
  }): Promise<string> {
    const index = join(this.repository, ".git", `factory-index-${Date.now()}-${Math.random()}`);
    const env = { ...process.env, GIT_INDEX_FILE: index };
    try {
      execFileSync("git", ["read-tree", args.baseTreeOid], { cwd: this.repository, env });
      for (const entry of args.entries) {
        if (entry.sha) {
          execFileSync(
            "git",
            ["update-index", "--add", "--cacheinfo", entry.mode, entry.sha, entry.path],
            { cwd: this.repository, env },
          );
        } else {
          execFileSync("git", ["update-index", "--force-remove", "--", entry.path], {
            cwd: this.repository,
            env,
          });
        }
      }
      return execFileSync("git", ["write-tree"], {
        cwd: this.repository,
        env,
        encoding: "utf8",
      }).trim();
    } finally {
      await unlink(index).catch(() => {});
    }
  }
  async createCommit(args: {
    treeOid: string;
    parentOids: string[];
    message: string;
  }): Promise<string> {
    return git(
      this.repository,
      [
        "commit-tree",
        args.treeOid,
        ...args.parentOids.flatMap((parent) => ["-p", parent]),
        "-F",
        "-",
      ],
      args.message,
    );
  }
  async createRef(ref: string, oid: string): Promise<boolean> {
    const present = this.refs.get(ref);
    if (present) return present === oid;
    this.refs.set(ref, oid);
    if (this.loseCreateRefResponse) throw new Error("connection reset after ref create");
    return true;
  }
  async findPullRequestForBranch(): Promise<typeof this.pull> {
    return this.pull;
  }
  async createPullRequest(args: {
    head: string;
  }): Promise<{ number: number; htmlUrl: string; headSha: string }> {
    const headSha = this.refs.get(`refs/heads/${args.head}`)!;
    this.pull = {
      number: 7,
      htmlUrl: "https://example.invalid/pull/7",
      state: "open",
      merged: false,
      headSha,
    };
    if (this.loseCreatePullResponse) throw new Error("connection reset after write");
    return this.pull;
  }
  async readPullRequest(): Promise<{
    state: string;
    merged: boolean;
    mergeable: boolean | null;
    mergeableState: string;
    draft: boolean;
    headSha: string;
    baseSha: string;
    baseRef: string;
    mergeCommitSha: string | null;
  }> {
    return {
      state: this.pull?.state ?? "open",
      merged: this.pull?.merged ?? false,
      mergeable: this.mergeable,
      mergeableState: this.mergeableState,
      draft: false,
      headSha: this.pull!.headSha,
      baseSha: this.baseSha,
      baseRef: this.baseRef,
      mergeCommitSha: this.pull?.merged ? "f".repeat(40) : null,
    };
  }
  async readChecks(): Promise<{ pending: string[]; failed: string[] }> {
    return this.checks;
  }
  async mergePullRequest(): Promise<string> {
    return "f".repeat(40);
  }
  async closeIssue(): Promise<void> {}
  async closePullRequest(): Promise<void> {}
}

describe("host-owned publication", () => {
  function candidateFixture() {
    const source = exactHeadValidation("c".repeat(40));
    const validation = createValidationEvidence({
      protocol: "clockgrove.factory/validation-v1",
      artifactDigest: "a".repeat(64),
      baseSha: "a".repeat(40),
      outputTreeSha: "e".repeat(40),
      commands: [{ command: "npm test", exitCode: 0, durationMs: 1 }],
      passed: true,
      startedAt: "2026-09-05T00:00:00Z",
      completedAt: "2026-09-05T00:00:01Z",
    });
    const candidate = bindMergeCandidateValidation({ source, validation });
    const pull = {
      branch: "factory/x",
      commitSha: source.publishedHeadSha,
      number: 7,
      htmlUrl: "",
      exactHeadValidation: source,
    };
    const current = {
      state: "open",
      merged: false,
      mergeable: true,
      mergeableState: "clean",
      draft: false,
      headSha: source.publishedHeadSha,
      baseSha: candidate.targetBaseSha,
      baseRef: "main",
      mergeCommitSha: "f".repeat(40) as string | null,
    };
    const checks = { failed: [] as string[], pending: [] as string[], observed: ["test"] };
    const commit = {
      oid: "f".repeat(40),
      treeOid: candidate.candidateOutputTreeSha,
      parentOids: [candidate.targetBaseSha],
      message: "merge",
      serverTime: new Date(),
    };
    const reads = {
      readPullRequest: vi.fn(async () => current),
      readChecks: vi.fn(async () => checks),
      readCommit: vi.fn(async () => commit),
    };
    // Only read methods participate in integration readiness; any unexpected write is absent.
    const store = reads as unknown as PublicationStore;
    const options = { mergeCandidateValidation: candidate, ciExpected: true };
    const ready = () => integrationReadiness(store, pull, candidate.targetBaseSha, "main", options);
    return { source, candidate, pull, current, checks, commit, reads, store, options, ready };
  }

  it("accepts a separately validated advanced-base candidate without relabeling the original head", async () => {
    const f = candidateFixture();
    const source = structuredClone(f.source);
    await expect(f.ready()).resolves.toEqual({
      state: "ready",
      headSha: f.source.publishedHeadSha,
    });
    await expect(
      integrationReadiness(f.store, f.pull, undefined, "main", f.options),
    ).resolves.toMatchObject({ state: "ready" });
    expect(f.source).toEqual(source);
    expect(f.candidate.candidateOutputTreeSha).not.toBe(f.source.outputTreeSha);
    await expect(
      integrationReadiness(f.store, f.pull, f.source.baseSha, "main"),
    ).resolves.toMatchObject({
      state: "failed",
      reason: expect.stringContaining("base branch advanced"),
    });
  });

  it.each(["base", "head", "base-ref", "failed-check", "pending-check", "conflict", "draft"])(
    "retains the %s guard with candidate evidence",
    async (kind) => {
      const f = candidateFixture();
      if (kind === "base") f.current.baseSha = "9".repeat(40);
      if (kind === "head") f.current.headSha = "9".repeat(40);
      if (kind === "base-ref") f.current.baseRef = "other";
      if (kind === "failed-check") f.checks.failed = ["test"];
      if (kind === "pending-check") f.checks.pending = ["test"];
      if (kind === "conflict") f.current.mergeable = false;
      if (kind === "draft") f.current.draft = true;
      await expect(f.ready()).resolves.toMatchObject({
        state: kind === "pending-check" ? "wait" : "failed",
      });
    },
  );

  it("checks the candidate base even when no separate expected base was supplied", async () => {
    const f = candidateFixture();
    f.current.baseSha = f.source.baseSha;
    await expect(
      integrationReadiness(f.store, f.pull, undefined, "main", f.options),
    ).resolves.toMatchObject({
      state: "failed",
      reason: expect.stringContaining("base branch advanced"),
    });
  });

  it("rejects mismatched candidate evidence before reading mutable GitHub state", async () => {
    const f = candidateFixture();
    await expect(
      integrationReadiness(f.store, f.pull, f.source.baseSha, "main", f.options),
    ).rejects.toThrow("expected base");
    await expect(
      integrationReadiness(f.store, f.pull, undefined, "main", {
        ...f.options,
        mergeCandidateValidation: {
          ...f.candidate,
          candidateOutputTreeSha: f.source.outputTreeSha,
        },
      }),
    ).rejects.toThrow("digest mismatch");
    const otherSource = bindValidationToPublishedHead({
      validation: {
        passed: true,
        digest: "f".repeat(64),
        baseSha: f.source.baseSha,
        outputTreeSha: f.source.outputTreeSha,
      },
      publishedBaseSha: f.source.baseSha,
      publishedTreeSha: f.source.outputTreeSha,
      publishedHeadSha: f.source.publishedHeadSha,
    });
    await expect(
      integrationReadiness(
        f.store,
        { ...f.pull, exactHeadValidation: otherSource },
        undefined,
        "main",
        f.options,
      ),
    ).rejects.toThrow("original published head");
    expect(f.reads.readPullRequest).not.toHaveBeenCalled();
  });

  it("recovers a merged candidate from its actual target parent and candidate tree, not current trunk", async () => {
    const f = candidateFixture();
    f.current.merged = true;
    f.current.state = "closed";
    f.current.baseSha = "9".repeat(40);
    await expect(f.ready()).resolves.toEqual({ state: "integrated", headSha: f.commit.oid });
    expect(f.reads.readChecks).not.toHaveBeenCalled();
    await expect(
      integrationReadiness(f.store, f.pull, f.candidate.targetBaseSha, "main"),
    ).resolves.toMatchObject({
      state: "failed",
      reason: expect.stringContaining("irreversible merge"),
    });
  });

  it.each(["source-tree", "source-base", "two-parents", "changed-head", "missing-merge"])(
    "rejects incorrect merged candidate %s",
    async (kind) => {
      const f = candidateFixture();
      f.current.merged = true;
      f.current.state = "closed";
      if (kind === "source-tree") f.commit.treeOid = f.source.outputTreeSha;
      if (kind === "source-base") f.commit.parentOids = [f.source.baseSha];
      if (kind === "two-parents") f.commit.parentOids.push(f.source.publishedHeadSha);
      if (kind === "changed-head") f.current.headSha = "9".repeat(40);
      if (kind === "missing-merge") f.current.mergeCommitSha = null;
      await expect(f.ready()).resolves.toMatchObject({ state: "failed" });
    },
  );

  function deliveryFixture() {
    const f = candidateFixture();
    const delivery = {
      ...f.commit,
      oid: "8".repeat(40),
      parentOids: [f.candidate.targetBaseSha],
      message: "native stack rewrite",
    };
    f.current.headSha = delivery.oid;
    f.reads.readCommit.mockImplementation(async (oid?: string) =>
      oid === delivery.oid ? delivery : f.commit,
    );
    const options = { ...f.options, mergeCandidateDeliveryHeadSha: delivery.oid };
    const ready = () =>
      integrationReadiness(f.store, f.pull, f.candidate.targetBaseSha, "main", options);
    return { ...f, delivery, options, ready };
  }

  it("uses the proven native delivery head for checks and mutation without changing source evidence", async () => {
    const f = deliveryFixture();
    const original = structuredClone(f.pull);
    await expect(f.ready()).resolves.toEqual({ state: "ready", headSha: f.delivery.oid });
    expect(f.reads.readCommit).toHaveBeenCalledWith(f.delivery.oid);
    expect(f.reads.readChecks).toHaveBeenCalledWith(f.delivery.oid);
    expect(f.pull).toEqual(original);
    await expect(
      integrationReadiness(f.store, f.pull, f.candidate.targetBaseSha, "main", {
        mergeCandidateValidation: f.candidate,
      }),
    ).resolves.toMatchObject({ state: "failed", reason: expect.stringContaining("head changed") });
  });

  it("does not accept a delivery head as candidate authority", async () => {
    const f = deliveryFixture();
    await expect(
      integrationReadiness(f.store, f.pull, undefined, "main", {
        mergeCandidateDeliveryHeadSha: f.delivery.oid,
      }),
    ).rejects.toThrow("requires candidate validation");
    await expect(
      integrationReadiness(f.store, f.pull, undefined, "main", {
        ...f.options,
        mergeCandidateDeliveryHeadSha: "",
      }),
    ).rejects.toThrow();
    await expect(
      integrationReadiness(f.store, f.pull, undefined, "main", {
        ...f.options,
        mergeCandidateValidation: { ...f.candidate, sourceHeadSha: f.delivery.oid },
      }),
    ).rejects.toThrow("digest mismatch");
    expect(f.reads.readPullRequest).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "requires the rewritten head proof even when merged=%s",
    async (merged) => {
      for (const defect of ["identity", "tree", "parent", "two-parents", "no-parent", "head"]) {
        const f = deliveryFixture();
        f.current.merged = merged;
        if (merged) f.current.state = "closed";
        if (defect === "identity") f.delivery.oid = "7".repeat(40);
        if (defect === "tree") f.delivery.treeOid = f.source.outputTreeSha;
        if (defect === "parent") f.delivery.parentOids = [f.source.baseSha];
        if (defect === "two-parents") f.delivery.parentOids.push(f.source.publishedHeadSha);
        if (defect === "no-parent") f.delivery.parentOids = [];
        if (defect === "head") f.current.headSha = f.source.publishedHeadSha;
        await expect(f.ready(), defect).resolves.toMatchObject({ state: "failed" });
        expect(f.reads.readChecks).not.toHaveBeenCalled();
      }
    },
  );

  it("recovers a merged rewritten head only with the separate candidate squash proof", async () => {
    const f = deliveryFixture();
    f.current.merged = true;
    f.current.state = "closed";
    f.current.baseSha = "9".repeat(40);
    await expect(f.ready()).resolves.toEqual({ state: "integrated", headSha: f.commit.oid });
    expect(f.reads.readCommit).toHaveBeenCalledWith(f.delivery.oid);
    expect(f.reads.readCommit).toHaveBeenCalledWith(f.commit.oid);
    f.commit.treeOid = f.source.outputTreeSha;
    await expect(f.ready()).resolves.toMatchObject({
      state: "failed",
      reason: expect.stringContaining("irreversible merge"),
    });
    expect(f.reads.readChecks).not.toHaveBeenCalled();
  });

  it.each(["base", "base-ref", "failed-check", "pending-check", "conflict", "draft"])(
    "retains the %s guard for a proven native delivery head",
    async (kind) => {
      const f = deliveryFixture();
      if (kind === "base") f.current.baseSha = "9".repeat(40);
      if (kind === "base-ref") f.current.baseRef = "other";
      if (kind === "failed-check") f.checks.failed = ["test"];
      if (kind === "pending-check") f.checks.pending = ["test"];
      if (kind === "conflict") f.current.mergeable = false;
      if (kind === "draft") f.current.draft = true;
      await expect(f.ready()).resolves.toMatchObject({
        state: kind === "pending-check" ? "wait" : "failed",
      });
    },
  );

  it("uploads exactly the independently validated tree and is idempotent", async () => {
    const { repository, base } = await fixture();
    const packet: WorkerPacket = {
      goal: "change value",
      acceptanceCriteria: ["value changed"],
      allowedPaths: ["value.txt"],
      preconditions: [],
      outOfScope: [],
      conventions: [],
      baseSha: base.oid,
      validationCommands: ["grep -qx changed value.txt"],
      requirements: {
        os: ["linux"],
        architecture: [],
        tools: ["git", "grep"],
        services: [],
        networkDestinations: [],
        permittedSecretNames: [],
        trust: "trusted_local",
      },
      artifactContract: "clockgrove.factory/artifact-v1",
    };
    const worker = await createLocalWorktree(repository, base.oid);
    await writeFile(join(worker.path, "value.txt"), "changed\n");
    const artifact = await collectLocalArtifact(worker);
    await cleanupLocalWorktree(worker);
    const validation = await validateArtifactClean({ repository, artifact, packet });
    const store = new GitObjectStore(repository, base.oid);
    const args = {
      store,
      assertLease: async () => {},
      base,
      validation,
      artifact,
      objective: 1,
      workItem: 2,
      attempt: 1,
      title: "Change value",
      baseBranch: "main",
    };
    const first = await publishValidated(args);
    const second = await publishValidated(args);
    expect(second).toEqual(first);
    expect(git(repository, ["rev-parse", `${first.commitSha}^{tree}`])).toBe(
      validation.evidence.outputTreeSha,
    );
    await discardValidationResult(validation);
    await rm(repository, { recursive: true, force: true });
  });

  it("waits, fails, and becomes ready from current GitHub evidence", async () => {
    const { repository, base } = await fixture();
    const store = new GitObjectStore(repository, base.oid);
    store.pull = { number: 7, htmlUrl: "", state: "open", merged: false, headSha: "c".repeat(40) };
    const pull = {
      branch: "factory/x",
      commitSha: "c".repeat(40),
      number: 7,
      htmlUrl: "",
      exactHeadValidation: exactHeadValidation("c".repeat(40)),
    };
    store.checks.pending = ["test"];
    await expect(integrationReadiness(store, pull)).resolves.toMatchObject({ state: "wait" });
    store.checks.pending = [];
    store.mergeableState = "behind";
    await expect(integrationReadiness(store, pull)).resolves.toMatchObject({ state: "failed" });
    store.mergeableState = "clean";
    await expect(integrationReadiness(store, pull)).resolves.toEqual({
      state: "ready",
      headSha: pull.commitSha,
    });
    await expect(integrationReadiness(store, pull, "d".repeat(40))).resolves.toMatchObject({
      state: "failed",
      reason: expect.stringContaining("base branch advanced"),
    });
    store.baseRef = "release";
    await expect(integrationReadiness(store, pull, base.oid, "main")).resolves.toEqual({
      state: "failed",
      reason: "pull request targets release, expected main",
    });
    store.baseRef = "main";
    store.pull = { ...store.pull, merged: true, state: "closed", headSha: "e".repeat(40) };
    await expect(integrationReadiness(store, pull)).resolves.toEqual({
      state: "failed",
      reason: "pull request head changed after validation",
    });
    store.pull = { ...store.pull, headSha: pull.commitSha };
    store.baseRef = "release";
    await expect(integrationReadiness(store, pull, "b".repeat(40), "main")).resolves.toEqual({
      state: "failed",
      reason: "pull request targets release, expected main",
    });
    store.baseRef = "main";
    await expect(integrationReadiness(store, pull, "b".repeat(40), "main")).resolves.toEqual({
      state: "integrated",
      headSha: "f".repeat(40),
    });
    store.mergeParents = ["9".repeat(40)];
    await expect(integrationReadiness(store, pull, "b".repeat(40), "main")).resolves.toMatchObject({
      state: "failed",
      reason: expect.stringContaining("irreversible merge could not be proven"),
    });
    await rm(repository, { recursive: true, force: true });
  });

  it("recovers a pull request whose create response was lost", async () => {
    const { repository, base } = await fixture();
    const packet: WorkerPacket = {
      goal: "change value",
      acceptanceCriteria: ["value changed"],
      allowedPaths: ["value.txt"],
      preconditions: [],
      outOfScope: [],
      conventions: [],
      baseSha: base.oid,
      validationCommands: ["grep -qx changed value.txt"],
      requirements: {
        os: ["linux"],
        architecture: [],
        tools: ["git", "grep"],
        services: [],
        networkDestinations: [],
        permittedSecretNames: [],
        trust: "trusted_local",
      },
      artifactContract: "clockgrove.factory/artifact-v1",
    };
    const worker = await createLocalWorktree(repository, base.oid);
    await writeFile(join(worker.path, "value.txt"), "changed\n");
    const artifact = await collectLocalArtifact(worker);
    await cleanupLocalWorktree(worker);
    const validation = await validateArtifactClean({ repository, artifact, packet });
    const store = new GitObjectStore(repository, base.oid);
    store.loseCreatePullResponse = true;
    await expect(
      publishValidated({
        store,
        assertLease: async () => {},
        base,
        validation,
        artifact,
        objective: 1,
        workItem: 2,
        attempt: 1,
        title: "Change value",
        baseBranch: "main",
      }),
    ).resolves.toMatchObject({ number: 7 });
    await discardValidationResult(validation);
    await rm(repository, { recursive: true, force: true });
  });

  it("recovers a publication branch whose create response was lost", async () => {
    const { repository, base } = await fixture();
    const packet: WorkerPacket = {
      goal: "change value",
      acceptanceCriteria: ["value changed"],
      allowedPaths: ["value.txt"],
      preconditions: [],
      outOfScope: [],
      conventions: [],
      baseSha: base.oid,
      validationCommands: ["grep -qx changed value.txt"],
      requirements: {
        os: ["linux"],
        architecture: [],
        tools: ["git", "grep"],
        services: [],
        networkDestinations: [],
        permittedSecretNames: [],
        trust: "trusted_local",
      },
      artifactContract: "clockgrove.factory/artifact-v1",
    };
    const worker = await createLocalWorktree(repository, base.oid);
    await writeFile(join(worker.path, "value.txt"), "changed\n");
    const artifact = await collectLocalArtifact(worker);
    await cleanupLocalWorktree(worker);
    const validation = await validateArtifactClean({ repository, artifact, packet });
    const store = new GitObjectStore(repository, base.oid);
    store.loseCreateRefResponse = true;
    await expect(
      publishValidated({
        store,
        assertLease: async () => {},
        base,
        validation,
        artifact,
        objective: 1,
        workItem: 2,
        attempt: 1,
        title: "Change value",
        baseBranch: "main",
      }),
    ).resolves.toMatchObject({ number: 7 });
    await discardValidationResult(validation);
    await rm(repository, { recursive: true, force: true });
  });
});
