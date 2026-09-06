import { execFileSync } from "node:child_process";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ArtifactFileManifestSchema,
  sha256,
  verifyMaterializedFiles,
} from "../src/execution/artifact-content.js";
import { normalizeArtifact } from "../src/execution/artifacts.js";
import { inspectPatchManifest } from "../src/runtime/artifact-patch.js";
import {
  cleanupLocalWorktree,
  createLocalWorktree,
  seedLocalWorktree,
} from "../src/runtime/local-worktree.js";
import * as processGroup from "../src/runtime/process-group.js";
import { validateArtifactClean } from "../src/validation/clean-run.js";
import type { WorkerPacket } from "../src/protocol/worker-packet.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture(target = "%PDF-1.7/../../../outside") {
  const repository = await mkdtemp(join(tmpdir(), "factory-symlink-manifest-test-"));
  roots.push(repository);
  const git = (args: string[], input?: string) =>
    execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
      cwd: repository,
      input,
      encoding: "utf8",
    });
  git(["init", "-q"]);
  git(["config", "user.name", "Fixture"]);
  git(["config", "user.email", "fixture@example.invalid"]);
  await writeFile(join(repository, "value.txt"), "original\n");
  git(["add", "value.txt"]);
  git(["commit", "-qm", "base"]);
  const baseSha = git(["rev-parse", "HEAD"]).trim();
  const oid = git(["hash-object", "-w", "--stdin"], target).trim();
  // Create only a Git index entry: not even the fixture creates a symlink.
  git(["update-index", "--add", "--cacheinfo", `120000,${oid},link`]);
  const patch = git(["diff", "--cached", "--binary", baseSha]);
  git(["read-tree", baseSha]);
  const patchPath = join(repository, "patch");
  await writeFile(patchPath, patch);
  const manifest = () =>
    inspectPatchManifest(repository, baseSha, patchPath, ["link"], { allowSymlinkBlobs: true });
  return { repository, baseSha, patchPath, patch, target, manifest };
}

describe("Git-object-only symlink artifact boundary", () => {
  it("hashes target bytes with mode120000 and unknown media, without following or creating a link", async () => {
    const f = await fixture();
    const manifest = await f.manifest();
    expect(manifest.files).toMatchObject([
      {
        path: "link",
        mode: "120000",
        mediaType: "unknown",
        bytes: Buffer.byteLength(f.target),
        digest: sha256(f.target),
      },
    ]);
    await expect(lstat(join(f.repository, "link"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      inspectPatchManifest(f.repository, f.baseSha, f.patchPath, ["link"]),
    ).rejects.toThrow(/Git-object-only/);
    await expect(verifyMaterializedFiles(f.repository, manifest)).rejects.toThrow(
      /Git-object-only/,
    );
    const artifact = normalizeArtifact({
      baseSha: f.baseSha,
      patch: f.patch,
      changedPaths: ["link"],
      outcome: "succeeded",
      fileManifest: manifest,
    });
    const ajv = new Ajv({ strict: false });
    addFormats(ajv);
    const validate = ajv.compile(
      JSON.parse(
        await readFile(new URL("../schemas/artifact.schema.json", import.meta.url), "utf8"),
      ),
    );
    expect(validate(artifact)).toBe(true);
    const wrong = {
      ...manifest,
      files: manifest.files.map((file) => ({ ...file, mediaType: "application/pdf" })),
    };
    expect(() => ArtifactFileManifestSchema.parse(wrong)).toThrow(/regular-file media/);
    expect(validate({ ...artifact, fileManifest: wrong })).toBe(false);
  });

  it("secret-scans raw link targets before returning an object-only manifest", async () => {
    const f = await fixture(`../prefixghp_${"A".repeat(36)}`);
    await expect(f.manifest()).rejects.toThrow(/credential|token/);
  });

  for (const spoofed of [false, true]) {
    it(`refuses ${spoofed ? "producer-disguised" : "legacy unmanifested"} symlink patches before filesystem apply`, async () => {
      const f = await fixture();
      const manifest = await f.manifest();
      const artifact = normalizeArtifact({
        baseSha: f.baseSha,
        patch: f.patch,
        changedPaths: ["link"],
        outcome: "succeeded",
        ...(spoofed
          ? {
              fileManifest: {
                ...manifest,
                files: manifest.files.map((file) => ({ ...file, mode: "100644" as const })),
              },
            }
          : {}),
      });
      const packet: WorkerPacket = {
        goal: "validate exact output",
        acceptanceCriteria: ["output matches"],
        allowedPaths: ["link"],
        preconditions: [],
        outOfScope: [],
        conventions: [],
        baseSha: f.baseSha,
        validationCommands: ["grep -qx original value.txt"],
        requirements: {
          os: ["linux"],
          architecture: [],
          tools: ["grep"],
          services: [],
          networkDestinations: [],
          permittedSecretNames: [],
          trust: "trusted_local",
        },
        artifactContract: "clockgrove.factory/artifact-v1",
      };
      const commands = vi.spyOn(processGroup, "runContainedProcess");
      await expect(
        validateArtifactClean({ repository: f.repository, artifact, packet }),
      ).rejects.toThrow(/Git-object-only/);
      const worker = await createLocalWorktree(f.repository, f.baseSha);
      try {
        await expect(seedLocalWorktree(worker, artifact)).rejects.toThrow(/Git-object-only/);
        await expect(lstat(join(worker.path, "link"))).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await cleanupLocalWorktree(worker);
      }
      expect(
        commands.mock.calls.some(
          ([options]) => options.command === "git" && options.args?.includes("--cached"),
        ),
      ).toBe(true);
      expect(
        commands.mock.calls.some(
          ([options]) =>
            options.command === "git" &&
            options.args?.includes("apply") &&
            !options.args.includes("--cached"),
        ),
      ).toBe(false);
      expect(
        commands.mock.calls.some(
          ([options]) => options.command !== "git" && options.command !== process.execPath,
        ),
      ).toBe(false);
    });
  }
});
