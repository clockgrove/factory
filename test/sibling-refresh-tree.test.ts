import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeArtifact } from "../src/execution/artifacts.js";
import type { WorkerPacket } from "../src/protocol/worker-packet.js";
import type { PublicationStore } from "../src/publication/publisher.js";
import {
  MAX_SIBLING_REFRESH_BLOB_BYTES,
  prepareSiblingRefreshTree,
} from "../src/publication/sibling-refresh-tree.js";
import * as processGroup from "../src/runtime/process-group.js";
import { inspectPatchManifest } from "../src/runtime/artifact-patch.js";
import { createLocalWorktree } from "../src/runtime/local-worktree.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function git(repository: string, args: string[], input?: string | Buffer, extraEnv = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  return execFileSync(
    "git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.attributesFile=/dev/null",
      ...args,
    ],
    {
      cwd: repository,
      input,
      maxBuffer: 32 * 1024 * 1024,
      env: {
        ...env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        ...extraEnv,
      },
    },
  );
}
const text = (repository: string, args: string[]) => git(repository, args).toString("utf8").trim();

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "factory-refresh-tree-test-"));
  roots.push(root);
  const repository = join(root, "repo");
  await mkdir(repository);
  git(repository, ["init", "-q", "-b", "main"]);
  git(repository, ["config", "user.name", "Factory Test"]);
  git(repository, ["config", "user.email", "factory@example.invalid"]);
  await writeFile(join(repository, ".gitattributes"), "value.txt filter=marker diff=marker\n");
  await writeFile(join(repository, "value.txt"), "before\n");
  await writeFile(join(repository, "delete.txt"), "remove me\n");
  await writeFile(join(repository, "binary.dat"), Buffer.from([0, 1, 2, 255]));
  await writeFile(join(repository, "run.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o644 });
  await symlink("value.txt", join(repository, "link"));
  git(repository, ["add", "."]);
  git(repository, ["commit", "-qm", "base"]);
  const baseSha = text(repository, ["rev-parse", "HEAD"]);
  const baseTree = text(repository, ["rev-parse", "HEAD^{tree}"]);
  await writeFile(join(repository, "value.txt"), "after\n");
  await writeFile(join(repository, "binary.dat"), Buffer.from([0, 255, 254, 128, 0, 5]));
  await chmod(join(repository, "run.sh"), 0o755);
  await unlink(join(repository, "delete.txt"));
  await unlink(join(repository, "link"));
  await symlink("../not-a-worktree-read", join(repository, "link"));
  git(repository, ["add", "-A"]);
  const expectedTree = text(repository, ["write-tree"]);
  const patch = git(repository, [
    "diff",
    "--cached",
    "--binary",
    "--no-ext-diff",
    "--no-textconv",
    baseSha,
  ]).toString("utf8");
  const paths = git(repository, ["diff", "--cached", "--name-only", "-z", baseSha])
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  const artifact = normalizeArtifact({ baseSha, patch, changedPaths: paths, outcome: "succeeded" });
  git(repository, ["reset", "--hard", baseSha]);
  const packet: WorkerPacket = {
    goal: "prepare the exact sibling tree",
    acceptanceCriteria: ["exact tree"],
    allowedPaths: paths,
    preconditions: [],
    outOfScope: [],
    conventions: [],
    baseSha,
    validationCommands: [`printf invoked > '${join(root, "validation.marker")}'`],
    requirements: {
      os: ["linux"],
      architecture: [],
      tools: [],
      services: [],
      networkDestinations: [],
      permittedSecretNames: [],
      trust: "isolated",
    },
    artifactContract: "clockgrove.factory/artifact-v1",
  };
  const markers = [
    "post-checkout",
    "smudge",
    "clean",
    "external-diff",
    "textconv",
    "fsmonitor",
    "validation",
  ].map((name) => join(root, `${name}.marker`));
  const hooks = join(root, "hooks");
  await mkdir(hooks);
  const script = async (name: string, body: string) => {
    const path = join(hooks, name);
    await writeFile(
      path,
      `#!/bin/sh\nprintf invoked > '${join(root, `${name}.marker`)}'\n${body}\n`,
      { mode: 0o755 },
    );
    return path;
  };
  await script("post-checkout", "exit 0");
  const smudge = await script("smudge", "cat");
  const clean = await script("clean", "cat");
  const external = await script("external-diff", "exit 0");
  const textconv = await script("textconv", 'cat "$1"');
  const fsmonitor = await script("fsmonitor", "printf 'token\\0'");
  const hostile = () => {
    for (const [key, value] of [
      ["core.hooksPath", hooks],
      ["filter.marker.smudge", smudge],
      ["filter.marker.clean", clean],
      ["diff.external", external],
      ["diff.marker.textconv", textconv],
      ["core.fsmonitor", fsmonitor],
    ])
      git(repository, ["config", key!, value!]);
  };
  let authorized = false;
  const assertCurrent = vi.fn(async () => {
    authorized = true;
  });
  const writes: string[] = [];
  const consumeFence = (kind: string) => {
    expect(authorized, `${kind} must follow a fresh fence`).toBe(true);
    authorized = false;
    writes.push(kind);
  };
  const store: Pick<PublicationStore, "readCommit" | "createBlob" | "createTree"> = {
    readCommit: vi.fn(async (oid) => ({
      oid,
      treeOid: text(repository, ["rev-parse", `${oid}^{tree}`]),
      parentOids: text(repository, ["rev-list", "--parents", "-n", "1", oid]).split(" ").slice(1),
      message: "fixture",
      serverTime: new Date(),
    })),
    createBlob: vi.fn(async (content) => {
      consumeFence("blob");
      return git(repository, ["hash-object", "-w", "--stdin"], content).toString("utf8").trim();
    }),
    createTree: vi.fn(async ({ baseTreeOid, entries }) => {
      consumeFence("tree");
      expect(baseTreeOid).toBe(baseTree);
      const index = join(root, `upload-index-${writes.length}`);
      const env = { GIT_INDEX_FILE: index };
      git(repository, ["read-tree", baseTreeOid], undefined, env);
      for (const entry of entries)
        git(
          repository,
          ["update-index", "-z", "--index-info"],
          `${entry.sha ? `${entry.mode} ${entry.sha}` : `0 ${"0".repeat(40)}`}\t${entry.path}\0`,
          env,
        );
      return git(repository, ["write-tree"], undefined, env).toString("utf8").trim();
    }),
  };
  const clearMarkers = async () => {
    for (const marker of markers) await rm(marker, { force: true });
  };
  const present = async () =>
    Promise.all(
      markers.map(async (marker) => {
        try {
          await readFile(marker);
          return marker;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw error;
        }
      }),
    ).then((values) => values.filter(Boolean));
  return {
    root,
    repository,
    baseSha,
    baseTree,
    expectedTree,
    artifact,
    packet,
    markers,
    hostile,
    clearMarkers,
    present,
    store,
    assertCurrent,
    writes,
  };
}

describe("object-only sibling refresh tree preparation", () => {
  it("refuses symlink source materialization without executing checkout, smudge or clean hooks", async () => {
    const f = await fixture();
    f.hostile();
    await expect(createLocalWorktree(f.repository, f.baseSha)).rejects.toThrow(
      /unsupported path or Git entry mode/,
    );
    expect(await f.present()).toEqual([]);
  });

  it("uploads the exact binary, mode, deletion and symlink tree without executing repository configuration or packet commands", async () => {
    const f = await fixture();
    await writeFile(join(f.repository, "caller.txt"), "staged caller state\n");
    git(f.repository, ["add", "caller.txt"]);
    await writeFile(join(f.repository, "value.txt"), "dirty caller state\n");
    const index = await readFile(join(f.repository, ".git", "index"));
    const head = text(f.repository, ["rev-parse", "HEAD"]);
    const worktrees = git(f.repository, ["worktree", "list", "--porcelain"]);
    f.hostile();
    await f.clearMarkers();
    const tree = await prepareSiblingRefreshTree(f);
    expect(await f.present()).toEqual([]);
    expect(tree).toBe(f.expectedTree);
    expect(await readFile(join(f.repository, ".git", "index"))).toEqual(index);
    expect(text(f.repository, ["rev-parse", "HEAD"])).toBe(head);
    expect(await readFile(join(f.repository, "value.txt"), "utf8")).toBe("dirty caller state\n");
    expect(await readFile(join(f.repository, "caller.txt"), "utf8")).toBe("staged caller state\n");
    expect(git(f.repository, ["worktree", "list", "--porcelain"])).toEqual(worktrees);
    expect(git(f.repository, ["cat-file", "blob", `${tree}:binary.dat`])).toEqual(
      Buffer.from([0, 255, 254, 128, 0, 5]),
    );
    expect(git(f.repository, ["cat-file", "blob", `${tree}:link`]).toString()).toBe(
      "../not-a-worktree-read",
    );
    const entries = text(f.repository, ["ls-tree", "-r", tree]);
    expect(entries).toContain("100755 blob");
    expect(entries).toContain("120000 blob");
    expect(entries).not.toContain("delete.txt");
    expect(entries).not.toContain("caller.txt");
    expect(f.writes.at(-1)).toBe("tree");
  });

  it.each(["packet-base", "scope", "manifest", "digest", "remote-base", "validated-tree"] as const)(
    "rejects %s mismatch before any upload",
    async (kind) => {
      const f = await fixture();
      if (kind === "packet-base") f.packet.baseSha = "f".repeat(40);
      if (kind === "scope") f.packet.allowedPaths = ["not-in-artifact"];
      if (kind === "manifest")
        f.artifact = normalizeArtifact({
          baseSha: f.artifact.baseSha,
          patch: f.artifact.patch,
          outcome: "succeeded",
          changedPaths: ["value.txt"],
          createdAt: new Date(),
        });
      if (kind === "digest") f.artifact.digest = "0".repeat(64);
      if (kind === "remote-base")
        vi.mocked(f.store.readCommit).mockResolvedValue({
          oid: f.baseSha,
          treeOid: "f".repeat(40),
          parentOids: [],
          message: "wrong tree",
          serverTime: new Date(),
        });
      f.hostile();
      await expect(prepareSiblingRefreshTree({
        ...f,
        ...(kind === "validated-tree" ? { expectedOutputTreeSha: "f".repeat(40) } : {}),
      })).rejects.toThrow();
      expect(f.writes).toEqual([]);
      expect(await f.present()).toEqual([]);
    },
  );

  it("rejects forged link-target manifest bytes before uploading the object-only tree", async () => {
    const f = await fixture();
    const patch = join(f.root, "manifest.patch");
    await writeFile(patch, f.artifact.patch);
    const manifest = await inspectPatchManifest(
      f.repository,
      f.baseSha,
      patch,
      f.artifact.changedPaths,
      { allowSymlinkBlobs: true },
    );
    f.artifact = normalizeArtifact({
      baseSha: f.baseSha,
      patch: f.artifact.patch,
      changedPaths: f.artifact.changedPaths,
      outcome: "succeeded",
      fileManifest: {
        ...manifest,
        files: manifest.files.map((file) =>
          file.path === "link" ? { ...file, digest: "f".repeat(64) } : file,
        ),
      },
    });
    await expect(prepareSiblingRefreshTree(f)).rejects.toThrow(/actual Git blob identities/);
    expect(f.writes).toEqual([]);
  });

  it("performs no upload when the current authority check fails", async () => {
    const f = await fixture();
    f.assertCurrent.mockRejectedValue(new Error("lease lost"));
    await expect(prepareSiblingRefreshTree(f)).rejects.toThrow("lease lost");
    expect(f.writes).toEqual([]);
  });

  it("rejects an oversized raw blob size before reading or uploading its content", async () => {
    const f = await fixture();
    const run = processGroup.runContainedProcess;
    const observed = vi
      .spyOn(processGroup, "runContainedProcess")
      .mockImplementation(async (options) => {
        const result = await run(options);
        return options.command === "git" &&
          options.args?.includes("cat-file") &&
          options.args.includes("-s")
          ? { ...result, stdout: `${MAX_SIBLING_REFRESH_BLOB_BYTES + 1}\n` }
          : result;
      });
    await expect(prepareSiblingRefreshTree(f)).rejects.toThrow(/blob.*bound|blob.*exceed/i);
    expect(f.writes).toEqual([]);
    // Only the size response is fault-injected; real preparation still executes.
    // The earlier LFS metadata batch also uses Node, but must not be confused
    // with the fixed raw-upload bridge reading this size-rejected Git blob.
    expect(
      observed.mock.calls.some(
        ([options]) =>
          options.command === process.execPath &&
          options.args?.some((arg) => {
            try {
              const args: unknown = JSON.parse(arg);
              return Array.isArray(args) && args.includes("cat-file") && args.includes("blob");
            } catch {
              return false;
            }
          }),
      ),
    ).toBe(false);
  });

  it("ignores inherited alternate-index and configuration injection without modifying that index", async () => {
    const f = await fixture();
    const alternate = join(f.root, "unrelated-index");
    await writeFile(alternate, "do not touch\n");
    vi.stubEnv("GIT_INDEX_FILE", alternate);
    vi.stubEnv("GIT_CONFIG_COUNT", "1");
    vi.stubEnv("GIT_CONFIG_KEY_0", "core.fsmonitor");
    vi.stubEnv("GIT_CONFIG_VALUE_0", join(f.root, "hooks", "fsmonitor"));
    expect(await prepareSiblingRefreshTree(f)).toBe(f.expectedTree);
    expect(await readFile(alternate, "utf8")).toBe("do not touch\n");
    expect(await f.present()).toEqual([]);
  });

  it.each(["blob", "tree"] as const)("rejects a mismatched uploaded %s identity", async (kind) => {
    const f = await fixture();
    if (kind === "blob") vi.mocked(f.store.createBlob).mockResolvedValueOnce("f".repeat(40));
    else vi.mocked(f.store.createTree).mockResolvedValueOnce("f".repeat(40));
    await expect(prepareSiblingRefreshTree(f)).rejects.toThrow();
    if (kind === "blob") expect(f.store.createTree).not.toHaveBeenCalled();
  });

  it("stops before the next upload when authority is lost after one blob", async () => {
    const f = await fixture();
    f.assertCurrent.mockImplementation(async () => {
      if (f.writes.length > 0) throw new Error("lease lost after blob");
    });
    // The successful first upload remains an immutable object, never authorization
    // to continue constructing the remotely visible delivery tree after fencing.
    vi.mocked(f.store.createBlob).mockImplementation(async (content) => {
      f.writes.push("blob");
      return git(f.repository, ["hash-object", "-w", "--stdin"], content).toString("utf8").trim();
    });
    await expect(prepareSiblingRefreshTree(f)).rejects.toThrow("lease lost after blob");
    expect(f.store.createBlob).toHaveBeenCalledTimes(1);
    expect(f.store.createTree).not.toHaveBeenCalled();
  });

  it("rechecks authority between blob uploads and never repeats an unknown-outcome upload", async () => {
    const f = await fixture();
    vi.mocked(f.store.createBlob).mockRejectedValueOnce(new Error("lost upload response"));
    await expect(prepareSiblingRefreshTree(f)).rejects.toThrow("lost upload response");
    expect(f.store.createBlob).toHaveBeenCalledTimes(1);
    expect(f.store.createTree).not.toHaveBeenCalled();
    expect(f.assertCurrent).toHaveBeenCalled();
  });
});
