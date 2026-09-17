import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { GitCommitObject } from "../src/control/lease.js";
import {
  artifactRecoveryCopyAvailable,
  persistArtifactTransfer,
} from "../src/control/artifact-transfers.js";
import { releaseAllArtifactContent, sha256 } from "../src/execution/artifact-content.js";
import {
  canonicalLfsPointer,
  lfsObjectReceiptDigest,
  normalizeArtifact,
} from "../src/execution/artifacts.js";
import {
  finalizeLfsArtifact,
  reconstructNativeLfsArtifact,
  resolvedGitLfsEndpoint,
  restoreLfsArtifactContent,
  assertLfsReceiptRemoteIdentity,
  type LfsObjectStore,
  type LfsOutputTransport,
} from "../src/publication/git-lfs-output.js";
import { artifactFromPatchFile, type CollectedArtifact } from "../src/runtime/artifact-patch.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await releaseAllArtifactContent();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const gitOid = (bytes: Buffer) =>
  createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");

interface TestLfsObjectStore extends LfsObjectStore {
  deleteRefForTest(ref: string): boolean;
}

function memoryStore(): TestLfsObjectStore {
  const blobs = new Map<string, Buffer>();
  const trees = new Map<string, Map<string, string>>();
  const commits = new Map<string, GitCommitObject>();
  const refs = new Map<string, string>();
  return {
    readRef: async (ref) => refs.get(ref) ?? null,
    readCommit: async (oid) => {
      const commit = commits.get(oid);
      if (!commit) throw new Error("missing commit");
      return commit;
    },
    readTreeEntry: async (tree, path) => trees.get(tree)?.get(path) ?? null,
    readBlob: async (oid) => {
      const value = blobs.get(oid);
      if (!value) throw new Error("missing blob");
      return value;
    },
    createBlob: async (bytes) => {
      const oid = gitOid(bytes);
      blobs.set(oid, Buffer.from(bytes));
      return oid;
    },
    createTree: async ({ entries }) => {
      const oid = createHash("sha1").update(JSON.stringify(entries)).digest("hex");
      const resolved = entries.map((entry) => {
        const withContent = entry as typeof entry & { content?: string };
        if (withContent.content === undefined) return [entry.path, entry.sha] as const;
        const bytes = Buffer.from(withContent.content);
        const blobOid = gitOid(bytes);
        blobs.set(blobOid, bytes);
        return [entry.path, blobOid] as const;
      });
      trees.set(oid, new Map(resolved));
      return oid;
    },
    createCommit: async ({ treeOid, parentOids, message }) => {
      const oid = createHash("sha1")
        .update(JSON.stringify({ treeOid, parentOids, message }))
        .digest("hex");
      commits.set(oid, { oid, treeOid, parentOids, message, serverTime: new Date(0) });
      return oid;
    },
    createRef: async (ref, oid) => {
      if (refs.has(ref)) return false;
      refs.set(ref, oid);
      return true;
    },
    deleteRefForTest: (ref: string) => refs.delete(ref),
  };
}

async function fixture(configured = true) {
  const repository = await mkdtemp(join(tmpdir(), "factory-lfs-output-test-"));
  roots.push(repository);
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: repository,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_AUTHOR_NAME: "Fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.invalid",
        GIT_COMMITTER_NAME: "Fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      },
    }).trim();
  git("init", "-q");
  git("config", "filter.lfs.clean", "cat");
  git("config", "filter.lfs.smudge", "cat");
  git("config", "filter.lfs.required", "false");
  if (configured)
    await writeFile(join(repository, ".gitattributes"), "*.bin filter=lfs diff=lfs -text\n");
  await writeFile(join(repository, "ordinary.txt"), "base\n");
  git("add", ".");
  git("commit", "-qm", "base");
  const baseSha = git("rev-parse", "HEAD");
  return { repository, git, baseSha };
}

async function collectRaw(
  value: Awaited<ReturnType<typeof fixture>>,
  path: string,
  bytes: Buffer,
): Promise<CollectedArtifact> {
  await writeFile(join(value.repository, path), bytes);
  value.git("add", "--intent-to-add", "--", path);
  const patch = join(value.repository, "worker.patch");
  const patchBytes = execFileSync(
    "git",
    ["diff", "--binary", "--no-ext-diff", value.baseSha, "--", path],
    {
      cwd: value.repository,
    },
  );
  await writeFile(patch, patchBytes);
  return artifactFromPatchFile({
    repository: value.repository,
    patchPath: patch,
    outputRoot: value.repository,
    baseSha: value.baseSha,
    changedPaths: [path],
    outcome: "succeeded",
  });
}

function transport(
  bytes: Buffer,
  options: {
    failPreflight?: "config" | "auth";
    corruptRead?: boolean;
    missingRead?: boolean;
  } = {},
) {
  const upload = vi.fn(async () => "uploaded" as const);
  const read = vi.fn(async () => {
    if (options.missingRead) throw new Error("remote LFS object missing");
    return options.corruptRead ? Buffer.from("corrupt") : bytes;
  });
  const value: LfsOutputTransport = {
    preflight: vi.fn(async () => {
      if (options.failPreflight)
        throw new Error(
          options.failPreflight === "config"
            ? "Git LFS origin configuration unavailable"
            : "Git LFS credentials unavailable",
        );
      return {
        toolVersion: "git-lfs/3.7.0",
        remoteDigest: "9".repeat(64),
        remoteHost: "github.com",
        endpoint: "https://github.com/fixture/project.git/info/lfs",
      };
    }),
    upload,
    read,
  };
  return { value, upload, read };
}

const authority = {
  repository: "fixture/project",
  objective: 1,
  workItem: 418,
  attempt: 1,
  runId: "fixture-run",
  directorEpoch: 1,
  policyDigest: "8".repeat(64),
};

describe("preconfigured Git LFS output normalization", () => {
  it("leaves ordinary Git output byte-for-byte on the established artifact path", async () => {
    const value = await fixture(false);
    const collected = await collectRaw(value, "ordinary.bin", Buffer.from("opaque ordinary bytes"));
    expect(collected.pendingLfsObjects).toBeUndefined();
    const finalized = await finalizeLfsArtifact({
      store: memoryStore(),
      artifact: collected,
      authority,
      repositoryPath: value.repository,
      allowedNetworkDestinations: ["github.com"],
      assertCurrent: async () => {},
    });
    expect(finalized).toEqual(collected);
    expect(finalized.lfsObjects).toBeUndefined();
  });

  it("uploads raw configured output and binds the exact canonical pointer tree", async () => {
    const value = await fixture();
    const bytes = Buffer.from([0, 255, 1, 2, 3, 128]);
    const collected = await collectRaw(value, "asset.bin", bytes);
    expect(collected.pendingLfsObjects).toHaveLength(1);
    const fake = transport(bytes);
    const finalized = await finalizeLfsArtifact({
      store: memoryStore(),
      artifact: collected,
      authority,
      repositoryPath: value.repository,
      allowedNetworkDestinations: ["github.com"],
      assertCurrent: async () => {},
      transport: fake.value,
    });
    const receipt = finalized.lfsObjects![0]!;
    expect(receipt).toMatchObject({ path: "asset.bin", oid: sha256(bytes), size: bytes.length });
    expect(receipt.rawTransfer.identity.domain).toBe("worker-artifact");
    expect(fake.upload).toHaveBeenCalledTimes(1);
    expect(fake.read).toHaveBeenCalledTimes(1);
    expect(fake.upload).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: "https://github.com/fixture/project.git/info/lfs" }),
    );
    expect(fake.read).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: "https://github.com/fixture/project.git/info/lfs" }),
    );
    expect(() =>
      assertLfsReceiptRemoteIdentity(finalized, {
        toolVersion: receipt.toolVersion,
        remoteDigest: receipt.remoteDigest,
      }),
    ).not.toThrow();
    expect(() =>
      assertLfsReceiptRemoteIdentity(finalized, {
        toolVersion: receipt.toolVersion,
        remoteDigest: "7".repeat(64),
      }),
    ).toThrow(/remote identity changed/);
    const pointer = canonicalLfsPointer(receipt.oid, receipt.size);
    expect(finalized.fileManifest!.files[0]).toMatchObject({
      path: "asset.bin",
      bytes: pointer.length,
      digest: sha256(pointer),
    });
    expect(value.git("show", `${finalized.fileManifest!.resultTreeSha}:asset.bin`)).toBe(
      pointer.toString("utf8").trim(),
    );
  });

  it("reconstructs a native Git range from authenticated raw bytes and issues target-base receipts", async () => {
    const value = await fixture();
    const bytes = Buffer.from("authenticated native reconstruction");
    const store = memoryStore();
    const source = await finalizeLfsArtifact({
      store,
      artifact: await collectRaw(value, "asset.bin", bytes),
      authority,
      repositoryPath: value.repository,
      allowedNetworkDestinations: ["github.com"],
      assertCurrent: async () => {},
      transport: transport(bytes).value,
    });
    await writeFile(
      join(value.repository, "asset.bin"),
      canonicalLfsPointer(sha256(bytes), bytes.length),
    );
    value.git("add", "asset.bin");
    value.git("commit", "-qm", "source pointer");
    const sourceHeadSha = value.git("rev-parse", "HEAD");
    value.git("checkout", "-qb", "target", value.baseSha);
    await writeFile(join(value.repository, "target.txt"), "advanced target\n");
    value.git("add", "target.txt");
    value.git("commit", "-qm", "advance target");
    const targetBaseSha = value.git("rev-parse", "HEAD");
    const loadSourceArtifact = vi.fn(async () => source);
    const targetTransport = transport(bytes);
    const successorAuthority = {
      ...authority,
      runId: "successor-run",
      directorEpoch: 2,
      policyDigest: "7".repeat(64),
    };
    const target = await reconstructNativeLfsArtifact({
      store,
      authority: successorAuthority,
      repositoryPath: value.repository,
      allowedNetworkDestinations: ["github.com"],
      assertCurrent: async () => {},
      loadSourceArtifact,
      range: {
        sourceBaseSha: value.baseSha,
        headSha: sourceHeadSha,
        baseSha: targetBaseSha,
        changedPaths: ["asset.bin"],
      },
      transport: targetTransport.value,
    });
    expect(loadSourceArtifact).toHaveBeenCalledTimes(1);
    expect(target.baseSha).toBe(targetBaseSha);
    expect(target.lfsObjects![0]!.rawTransfer.identity.baseSha).toBe(targetBaseSha);
    expect(target.lfsObjects![0]!.assignmentDigest).not.toBe(
      source.lfsObjects![0]!.assignmentDigest,
    );
    expect(target.lfsObjects![0]!.receiptRef).not.toBe(source.lfsObjects![0]!.receiptRef);
    expect(target.lfsObjects![0]!.digest).not.toBe(source.lfsObjects![0]!.digest);
    await expect(restoreLfsArtifactContent({ store, artifact: target })).resolves.toBeUndefined();
    const predecessorTarget = await reconstructNativeLfsArtifact({
      store,
      authority,
      repositoryPath: value.repository,
      allowedNetworkDestinations: ["github.com"],
      assertCurrent: async () => {},
      loadSourceArtifact: async () => source,
      range: {
        sourceBaseSha: value.baseSha,
        headSha: sourceHeadSha,
        baseSha: targetBaseSha,
        changedPaths: ["asset.bin"],
      },
      transport: transport(bytes).value,
    });
    expect(target.lfsObjects![0]!.receiptRef).not.toBe(
      predecessorTarget.lfsObjects![0]!.receiptRef,
    );
    expect(target.lfsObjects![0]!.rawTransfer.identity.requestId).not.toBe(
      predecessorTarget.lfsObjects![0]!.rawTransfer.identity.requestId,
    );

    const assertCurrent = vi.fn(async () => {
      throw new Error("attempt reservation changed");
    });
    const staleSource = vi.fn(async () => source);
    const staleTransport = transport(bytes);
    await expect(
      reconstructNativeLfsArtifact({
        store,
        authority: successorAuthority,
        repositoryPath: value.repository,
        allowedNetworkDestinations: ["github.com"],
        assertCurrent,
        loadSourceArtifact: staleSource,
        range: {
          sourceBaseSha: value.baseSha,
          headSha: sourceHeadSha,
          baseSha: targetBaseSha,
          changedPaths: ["asset.bin"],
        },
        transport: staleTransport.value,
      }),
    ).rejects.toThrow(/reservation changed/);
    expect(assertCurrent).toHaveBeenCalledTimes(1);
    expect(staleSource).not.toHaveBeenCalled();
    expect(staleTransport.value.preflight).not.toHaveBeenCalled();

    value.git("checkout", "-qb", "mismatched-source", value.baseSha);
    await writeFile(
      join(value.repository, "asset.bin"),
      canonicalLfsPointer("b".repeat(64), bytes.length),
    );
    value.git("add", "asset.bin");
    value.git("commit", "-qm", "mismatched source pointer");
    const mismatchTransport = transport(bytes);
    await expect(
      reconstructNativeLfsArtifact({
        store,
        authority: successorAuthority,
        repositoryPath: value.repository,
        allowedNetworkDestinations: ["github.com"],
        assertCurrent: async () => {},
        loadSourceArtifact: async () => source,
        range: {
          sourceBaseSha: value.baseSha,
          headSha: value.git("rev-parse", "HEAD"),
          baseSha: targetBaseSha,
          changedPaths: ["asset.bin"],
        },
        transport: mismatchTransport.value,
      }),
    ).rejects.toThrow(/pointer differs from its authenticated raw object receipt/);
    expect(mismatchTransport.value.preflight).not.toHaveBeenCalled();
  });

  it("accepts only the effective LFS endpoint for the authenticated repository", () => {
    expect(
      resolvedGitLfsEndpoint({
        environment:
          "Endpoint=https://github.com/fixture/project.git/info/lfs (auth=basic)\n" +
          "Endpoint (origin)=https://github.com/fixture/project.git/info/lfs (auth=basic)\n",
        expectedHost: "github.com",
        expectedRepository: "fixture/project",
      }),
    ).toBe("https://github.com/fixture/project.git/info/lfs");
    for (const endpoint of [
      "https://objects.example.test/fixture/project.git/info/lfs",
      "https://github.com/fixture/other.git/info/lfs",
      "https://token@github.com/fixture/project.git/info/lfs",
      "http://github.com/fixture/project.git/info/lfs",
      "https://github.com/fixture/project.git/info/lfs?redirect=objects.example.test",
    ])
      expect(() =>
        resolvedGitLfsEndpoint({
          environment: `Endpoint (origin)=${endpoint} (auth=basic)\n`,
          expectedHost: "github.com",
          expectedRepository: "fixture/project",
        }),
      ).toThrow(/endpoint/);
  });

  it("fails missing config/auth and missing or corrupt independent reads before a receipt exists", async () => {
    for (const failure of ["config", "auth", "missing", "corrupt"] as const) {
      const value = await fixture();
      const bytes = Buffer.from(`raw-${failure}`);
      const collected = await collectRaw(value, "asset.bin", bytes);
      const fake = transport(bytes, {
        ...(failure === "config" || failure === "auth" ? { failPreflight: failure } : {}),
        missingRead: failure === "missing",
        corruptRead: failure === "corrupt",
      });
      await expect(
        finalizeLfsArtifact({
          store: memoryStore(),
          artifact: collected,
          authority,
          repositoryPath: value.repository,
          allowedNetworkDestinations: ["github.com"],
          assertCurrent: async () => {},
          transport: fake.value,
        }),
      ).rejects.toThrow(
        failure === "config" || failure === "auth"
          ? failure === "config"
            ? /configuration/
            : /credentials/
          : failure === "missing"
            ? /missing/
            : /downloaded LFS object/,
      );
    }
  });

  it("rejects an LFS endpoint outside immutable run-policy egress before upload or read", async () => {
    const value = await fixture();
    const bytes = Buffer.from("policy-bound raw object");
    const collected = await collectRaw(value, "asset.bin", bytes);
    const fake = transport(bytes);
    await expect(
      finalizeLfsArtifact({
        store: memoryStore(),
        artifact: collected,
        authority,
        repositoryPath: value.repository,
        allowedNetworkDestinations: [],
        assertCurrent: async () => {},
        transport: fake.value,
      }),
    ).rejects.toThrow(/run-policy egress authority/);
    expect(fake.upload).not.toHaveBeenCalled();
    expect(fake.read).not.toHaveBeenCalled();
  });

  it("requires fresh attempt authority before every durable raw transfer mutation", async () => {
    const value = await fixture();
    const bytes = Buffer.from("lease-bound raw object");
    const collected = await collectRaw(value, "asset.bin", bytes);
    const fake = transport(bytes);
    const assertCurrent = vi.fn(async () => {
      throw new Error("attempt reservation changed");
    });
    await expect(
      finalizeLfsArtifact({
        store: memoryStore(),
        artifact: collected,
        authority,
        repositoryPath: value.repository,
        allowedNetworkDestinations: ["github.com"],
        assertCurrent,
        transport: fake.value,
      }),
    ).rejects.toThrow(/reservation changed/);
    expect(assertCurrent).toHaveBeenCalledTimes(1);
    expect(fake.value.preflight).not.toHaveBeenCalled();
    expect(fake.upload).not.toHaveBeenCalled();
  });

  it("observes the durable upload receipt on replay and restores raw transfer bytes", async () => {
    const value = await fixture();
    const bytes = Buffer.from("restart-safe raw object");
    const collected = await collectRaw(value, "asset.bin", bytes);
    const store = memoryStore();
    const fake = transport(bytes);
    const first = await finalizeLfsArtifact({
      store,
      artifact: collected,
      authority,
      repositoryPath: value.repository,
      allowedNetworkDestinations: ["github.com"],
      assertCurrent: async () => {},
      transport: fake.value,
    });
    const second = await finalizeLfsArtifact({
      store,
      artifact: collected,
      authority,
      repositoryPath: value.repository,
      allowedNetworkDestinations: ["github.com"],
      assertCurrent: async () => {},
      transport: fake.value,
    });
    expect(second.digest).toBe(first.digest);
    expect(fake.upload).toHaveBeenCalledTimes(1);
    expect(fake.read).toHaveBeenCalledTimes(1);
    await expect(restoreLfsArtifactContent({ store, artifact: second })).resolves.toBeUndefined();
    store.deleteRefForTest(second.lfsObjects![0]!.receiptRef);
    await expect(restoreLfsArtifactContent({ store, artifact: second })).rejects.toThrow(
      /durable LFS upload receipt/,
    );
  });

  it("keeps the source until every raw LFS content transfer is independently recoverable", async () => {
    const value = await fixture();
    const bytes = Buffer.from("raw recovery boundary");
    const collected = await collectRaw(value, "asset.bin", bytes);
    const store = memoryStore();
    const finalized = await finalizeLfsArtifact({
      store,
      artifact: collected,
      authority,
      repositoryPath: value.repository,
      allowedNetworkDestinations: ["github.com"],
      assertCurrent: async () => {},
      transport: transport(bytes).value,
    });
    const identity = {
      repository: authority.repository,
      objective: authority.objective,
      workItem: authority.workItem,
      attempt: authority.attempt,
      runId: authority.runId,
      directorEpoch: authority.directorEpoch,
      policyDigest: authority.policyDigest,
      baseSha: finalized.baseSha,
    };
    await persistArtifactTransfer({
      store,
      identity,
      artifact: finalized,
      allowedPaths: finalized.changedPaths,
      assertCurrent: async () => {},
    });
    await expect(
      artifactRecoveryCopyAvailable({
        store,
        identity,
        artifactDigest: finalized.digest,
      }),
    ).resolves.toBe(true);
    store.deleteRefForTest(`${finalized.lfsObjects![0]!.rawTransfer.ref}/ready`);
    await expect(
      artifactRecoveryCopyAvailable({
        store,
        identity,
        artifactDigest: finalized.digest,
      }),
    ).resolves.toBe(false);
  });

  it("recomputes pinned assignment and raw transfer identity bindings", async () => {
    const value = await fixture();
    const bytes = Buffer.from("bound receipt raw object");
    const collected = await collectRaw(value, "asset.bin", bytes);
    const finalized = await finalizeLfsArtifact({
      store: memoryStore(),
      artifact: collected,
      authority,
      repositoryPath: value.repository,
      allowedNetworkDestinations: ["github.com"],
      assertCurrent: async () => {},
      transport: transport(bytes).value,
    });
    for (const forged of [
      { assignmentDigest: "0".repeat(64) },
      { rawTransfer: { ...finalized.lfsObjects![0]!.rawTransfer, ref: "refs/forged" } },
    ]) {
      const { digest: _receiptDigest, ...original } = finalized.lfsObjects![0]!;
      const core = { ...original, ...forged };
      const receipt = { ...core, digest: lfsObjectReceiptDigest(core) };
      expect(() =>
        normalizeArtifact({
          baseSha: finalized.baseSha,
          patch: finalized.patch,
          ...(finalized.payload ? { payload: finalized.payload } : {}),
          ...(finalized.fileManifest ? { fileManifest: finalized.fileManifest } : {}),
          lfsObjects: [receipt],
          changedPaths: finalized.changedPaths,
          commands: finalized.commands,
          logs: finalized.logs,
          outcome: finalized.outcome,
          ...(finalized.reason ? { reason: finalized.reason } : {}),
          ...(finalized.findings ? { findings: finalized.findings } : {}),
          createdAt: new Date(finalized.createdAt),
        }),
      ).toThrow(/LFS receipt/);
    }
  });

  it("refuses pointer-only configured output before any upload", async () => {
    const value = await fixture();
    const pointer = canonicalLfsPointer("a".repeat(64), 12);
    await expect(collectRaw(value, "asset.bin", pointer)).rejects.toThrow(/pointer-only/);
  });
});
