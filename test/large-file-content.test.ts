import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ArtifactFileManifestSchema,
  ArtifactPayloadSchema,
  cachePayload,
  copyBoundedContent,
  inspectContentFile,
  materializePayload,
  releaseAllArtifactContent,
  retainArtifactContent,
  sha256,
  verifyMaterializedFiles,
} from "../src/execution/artifact-content.js";
import {
  artifactFromGitRange,
  artifactFromPatchFile,
  streamGitFile,
} from "../src/runtime/artifact-patch.js";
import {
  materializeArtifactPatch,
  normalizeArtifact,
  verifyArtifact,
} from "../src/execution/artifacts.js";
import { repositoryArchiveFile, sourceContentUploads } from "../src/backends/source-content.js";
import {
  cleanupLocalWorktree,
  collectLocalArtifact,
  createLocalWorktree,
} from "../src/runtime/local-worktree.js";

const roots: string[] = [];
afterEach(async () => {
  await releaseAllArtifactContent();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const repository = await mkdtemp(join(tmpdir(), "factory-content-test-"));
  roots.push(repository);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repository, encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  await writeFile(join(repository, "original.txt"), "original\n");
  git("add", ".");
  git("commit", "-qm", "base");
  return { repository, git, base: git("rev-parse", "HEAD") };
}

describe("bounded content-addressed artifacts", () => {
  it("copies exact bounded bytes through a no-follow file descriptor without overwriting", async () => {
    const f = await fixture();
    const source = join(f.repository, "source.bin"),
      destination = join(f.repository, "copied.bin");
    const bytes = Buffer.from([0, 255, 128, 1]);
    await writeFile(source, bytes);
    await copyBoundedContent(source, destination, bytes.length);
    expect(await readFile(destination)).toEqual(bytes);
    await expect(copyBoundedContent(source, destination, bytes.length)).rejects.toMatchObject({
      code: "EEXIST",
    });
    await expect(
      copyBoundedContent(source, join(f.repository, "too-large"), bytes.length - 1),
    ).rejects.toThrow(/byte limit/);
    const link = join(f.repository, "source-link");
    await symlink(source, link);
    await expect(copyBoundedContent(link, join(f.repository, "from-link"))).rejects.toMatchObject({
      code: "ELOOP",
    });
  });
  it("collects and reassembles a genuine patch above the inline ceiling with a tree-bound manifest", async () => {
    const f = await fixture();
    await mkdir(join(f.repository, "generated"));
    const bytes = Buffer.from("representative generated row\n".repeat(230_000));
    await writeFile(join(f.repository, "generated", "rows.txt"), bytes);
    f.git("add", "--intent-to-add", ".");
    const patch = join(f.repository, "captured.patch");
    await streamGitFile(
      f.repository,
      ["diff", "--binary", f.base, "--", "generated/rows.txt"],
      patch,
    );
    const artifact = await artifactFromPatchFile({
      repository: f.repository,
      patchPath: patch,
      baseSha: f.base,
      changedPaths: ["generated/rows.txt"],
      outcome: "succeeded",
    });
    expect(artifact.payload!.bytes).toBeGreaterThan(5 * 1024 * 1024);
    expect(artifact.patch.length).toBeLessThan(256);
    expect(artifact.fileManifest!.files[0]).toMatchObject({
      path: "generated/rows.txt",
      bytes: bytes.length,
      digest: sha256(bytes),
      generated: true,
      mediaType: "unknown",
    });
    const reassembled = join(f.repository, "reassembled.patch");
    await materializeArtifactPatch(artifact, reassembled);
    expect(await readFile(reassembled)).toEqual(await readFile(patch));
    expect(() => verifyArtifact({ ...artifact, patch: artifact.patch + "changed" })).toThrow();
    await expect(
      artifactFromPatchFile({
        repository: f.repository,
        patchPath: patch,
        baseSha: f.base,
        changedPaths: ["wrong.txt"],
        outcome: "succeeded",
      }),
    ).rejects.toThrow("paths differ");
    f.git("add", "generated/rows.txt");
    f.git("commit", "-qm", "published exact source");
    const range = {
      repository: f.repository,
      sourceBaseSha: f.base,
      baseSha: f.base,
      headSha: f.git("rev-parse", "HEAD"),
      changedPaths: ["generated/rows.txt"],
    };
    const candidate = await artifactFromGitRange(range);
    await releaseAllArtifactContent();
    const reconstructed = await artifactFromGitRange({
      ...range,
      authenticatedLegacyDigest: candidate.digest,
    });
    expect(reconstructed.digest).toBe(candidate.digest);
    await materializeArtifactPatch(reconstructed, join(f.repository, "recovered-candidate.patch"));
  }, 120_000);

  it("binds media signatures, executable mode, generated files and canonical deletions to actual blobs", async () => {
    const f = await fixture();
    await rm(join(f.repository, "original.txt"));
    const wasm = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
    await writeFile(join(f.repository, "module.wasm"), wasm);
    await chmod(join(f.repository, "module.wasm"), 0o755);
    f.git("add", "--intent-to-add", ".");
    const patch = join(f.repository, "binary.patch");
    await streamGitFile(
      f.repository,
      ["diff", "--binary", f.base, "--", "original.txt", "module.wasm"],
      patch,
    );
    const artifact = await artifactFromPatchFile({
      repository: f.repository,
      patchPath: patch,
      baseSha: f.base,
      changedPaths: ["original.txt", "module.wasm"],
      outcome: "succeeded",
    });
    expect(artifact.fileManifest!.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "module.wasm",
          mode: "100755",
          mediaType: "application/wasm",
          digest: sha256(wasm),
        }),
        expect.objectContaining({
          path: "original.txt",
          action: "delete",
          bytes: 0,
          digest: sha256(Buffer.alloc(0)),
        }),
      ]),
    );
    await verifyMaterializedFiles(f.repository, artifact.fileManifest!);
    await chmod(join(f.repository, "module.wasm"), 0o644);
    await expect(verifyMaterializedFiles(f.repository, artifact.fileManifest!)).rejects.toThrow(
      "identity mismatch",
    );
    expect(() =>
      ArtifactFileManifestSchema.parse({
        ...artifact.fileManifest,
        files: [{ ...artifact.fileManifest!.files[0], path: "../escape" }],
      }),
    ).toThrow();
  });

  it("rejects secret bytes, unsafe file kinds and corrupt payload metadata", async () => {
    const f = await fixture();
    const path = join(f.repository, "secret.bin");
    await writeFile(path, Buffer.from("x".repeat(65530) + "ghp_" + "A".repeat(36)));
    await expect(inspectContentFile(path)).rejects.toThrow();
    await symlink(path, join(f.repository, "link"));
    await expect(inspectContentFile(join(f.repository, "link"))).rejects.toThrow();
    expect(() =>
      ArtifactPayloadSchema.parse({
        kind: "git-patch-chunks-v1",
        digest: "a".repeat(64),
        bytes: 9,
        chunks: [{ digest: "b".repeat(64), bytes: 8 }],
      }),
    ).toThrow();
  });

  it("preserves shared bytes until every attempt lease is released", async () => {
    const f = await fixture();
    const source = join(f.repository, "payload");
    await writeFile(source, "owned bytes");
    const payload = await cachePayload(source);
    const releaseA = retainArtifactContent(payload),
      releaseB = retainArtifactContent(payload);
    await releaseA();
    await materializePayload(payload, join(f.repository, "copy"));
    await expect(releaseAllArtifactContent()).rejects.toThrow("active");
    await releaseB();
    await releaseB();
    await expect(materializePayload(payload, join(f.repository, "missing"))).rejects.toThrow(
      "unavailable",
    );
  });

  it("refuses new LFS pointer uploads and retains legacy inline digest compatibility", async () => {
    const f = await fixture();
    await writeFile(
      join(f.repository, "new.dat"),
      `version https://git-lfs.github.com/spec/v1\noid sha256:${"a".repeat(64)}\nsize 12\n`,
    );
    f.git("add", "--intent-to-add", "new.dat");
    const patch = join(f.repository, "lfs.patch");
    await streamGitFile(f.repository, ["diff", "--binary", f.base, "--", "new.dat"], patch);
    await expect(
      artifactFromPatchFile({
        repository: f.repository,
        patchPath: patch,
        baseSha: f.base,
        changedPaths: ["new.dat"],
        outcome: "succeeded",
      }),
    ).rejects.toThrow("new LFS pointer");
    const legacy = normalizeArtifact({
      baseSha: f.base,
      patch: "",
      changedPaths: [],
      outcome: "declined",
      reason: "no changes",
    });
    expect(verifyArtifact(legacy).digest).toBe(legacy.digest);
    expect(legacy).not.toHaveProperty("payload");
  });

  it("streams an exact source archive above 64 MiB using a local SDK upload path and remote digest guard", async () => {
    const f = await fixture();
    await writeFile(join(f.repository, "large.bin"), Buffer.alloc(65 * 1024 * 1024, 7));
    f.git("add", "large.bin");
    f.git("commit", "-qm", "large source");
    const archive = await repositoryArchiveFile(f.repository, f.git("rev-parse", "HEAD"));
    try {
      expect(archive.bytes).toBeGreaterThan(64 * 1024 * 1024);
      expect(archive.bytes).toBeLessThanOrEqual(256 * 1024 * 1024);
      const uploads = sourceContentUploads(
        [
          { path: "factory/source.tar", content: Buffer.alloc(0) },
          {
            path: "factory/run.sh",
            content: Buffer.from(
              'factory_root="$PWD/factory"\ntar -xf "$factory_root/source.tar"\ngit commit -qm factory-base\n',
            ),
          },
        ],
        archive,
      );
      expect(uploads[0]).toEqual({ source: archive.path, destination: archive.remotePath });
      const script = uploads
        .find((file) => file.destination === "factory/run.sh")!
        .source.toString();
      expect(script).toContain("sha256sum --check --status");
      expect(script).toContain(archive.digest);
      expect(script).toContain(archive.baseTreeSha);
      expect(script.indexOf("sha256sum")).toBeLessThan(script.indexOf("tar -xf"));
    } finally {
      await archive.dispose();
    }
  }, 120_000);

  it("keeps hydrated unchanged LFS bytes out of collection and the applied index tree", async () => {
    const f = await fixture();
    const bytes = Buffer.from("existing authorized binary asset"),
      digest = sha256(bytes);
    const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${digest}\nsize ${bytes.length}\n`;
    await writeFile(join(f.repository, "asset.dat"), pointer);
    f.git("add", "asset.dat");
    f.git("commit", "-qm", "existing pointer");
    const base = f.git("rev-parse", "HEAD");
    const objectDirectory = join(
      f.repository,
      ".git",
      "lfs",
      "objects",
      digest.slice(0, 2),
      digest.slice(2, 4),
    );
    await mkdir(objectDirectory, { recursive: true });
    await writeFile(join(objectDirectory, digest), bytes);
    const tools = join(f.repository, "fixture-tools");
    await mkdir(tools);
    await writeFile(join(tools, "git-lfs"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const priorPath = process.env.PATH;
    process.env.PATH = `${tools}:${priorPath ?? ""}`;
    try {
      const worker = await createLocalWorktree(f.repository, base);
      try {
        expect(await readFile(join(worker.path, "asset.dat"))).toEqual(bytes);
        await writeFile(join(worker.path, "original.txt"), "changed\n");
        const artifact = await collectLocalArtifact(worker, "", ["original.txt"]);
        expect(artifact.changedPaths).toEqual(["original.txt"]);
        const clean = await createLocalWorktree(f.repository, base);
        try {
          const patch = join(clean.root, "apply.patch");
          await materializeArtifactPatch(artifact, patch);
          execFileSync("git", ["apply", "--index", "--binary", patch], { cwd: clean.path });
          const tree = execFileSync("git", ["write-tree"], {
            cwd: clean.path,
            encoding: "utf8",
          }).trim();
          expect(
            execFileSync("git", ["show", `${tree}:asset.dat`], {
              cwd: clean.path,
              encoding: "utf8",
            }),
          ).toBe(pointer);
        } finally {
          await cleanupLocalWorktree(clean);
        }
        await writeFile(join(worker.path, "asset.dat"), "changed binary asset");
        await expect(
          collectLocalArtifact(worker, "", ["original.txt", "asset.dat"]),
        ).rejects.toThrow("changed LFS asset");
      } finally {
        await cleanupLocalWorktree(worker);
      }
    } finally {
      if (priorPath === undefined) delete process.env.PATH;
      else process.env.PATH = priorPath;
    }
  });
});
