/** Qualifier regression tests, never evidence of installed execution. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LARGE_FILE_AUDIO_BYTES,
  assertLargeFileArtifact,
  assertLargeFileFinalTree,
  assertLargeFileRefusal,
  createLargeFileFixture,
  largeFileObjectiveBody,
  largeFilePaths,
  largeFileScenario,
  observeLargeFileTree,
  writeLargeFileOutput,
  type LargeFileFixture,
  type LargeFilePhase,
  type LargeFileRefusalScenario,
} from "../scripts/qualification-large-files.mjs";
import { artifactFromPatchFile } from "../src/runtime/artifact-patch.js";
import { collectLocalArtifact } from "../src/runtime/local-worktree.js";
import { releaseAllArtifactContent } from "../src/execution/artifact-content.js";

const roots: string[] = [];
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
afterEach(async () => {
  await releaseAllArtifactContent();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function parent() {
  const root = mkdtempSync(join(tmpdir(), "factory-large-file-qualifier-test-"));
  roots.push(root);
  return root;
}
function git(repository: string, args: string[], input?: Buffer | string) {
  return execFileSync("/usr/bin/git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "credential.helper=", ...args], {
    cwd: repository, ...(input === undefined ? {} : { input }), maxBuffer: 16 * 1024 * 1024,
    timeout: 30_000,
    env: {
      PATH: "/usr/bin:/bin", HOME: repository, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_NO_LAZY_FETCH: "1", GIT_ATTR_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    },
  });
}
function commitPhase(fixture: LargeFileFixture, phase: LargeFilePhase, baseSha: string) {
  for (const file of fixture.expected.filter((entry) => entry.phase === phase)) {
    const bytes = readFileSync(join(fixture.repository, file.path));
    const oid = git(fixture.repository, ["hash-object", "-w", "--stdin"], bytes).toString().trim();
    git(fixture.repository, ["update-index", "--add", "--cacheinfo", file.mode, oid, file.path]);
  }
  const patch = git(fixture.repository, ["diff", "--cached", "--binary", "--no-ext-diff", "--no-textconv", baseSha]);
  const tree = git(fixture.repository, ["write-tree"]).toString().trim();
  const head = git(fixture.repository, ["commit-tree", tree, "-p", baseSha, "-m", phase]).toString().trim();
  return { head, tree, patch };
}
function fixture() {
  return createLargeFileFixture({ parent: parent(), namespace: "large-files-test-a" });
}

describe("installed large-file qualifier fixture and proof contracts", () => {
  it("prepares canonical/legacy pointer Git blobs and verified local-only LFS objects", () => {
    const prepared = fixture();
    expect(prepared.lfs).toHaveLength(2);
    expect(git(prepared.repository, ["remote"]).toString()).toBe("");
    for (const asset of prepared.lfs) {
      const content = readFileSync(join(prepared.repository, asset.objectPath));
      expect(content.length).toBe(asset.size);
      expect(sha256(content)).toBe(asset.oid);
      const pointer = git(prepared.repository, ["cat-file", "blob", asset.pointerBlobOid]);
      expect(sha256(pointer)).toBe(asset.pointerDigest);
      expect(pointer.toString()).toContain(`oid sha256:${asset.oid}\nsize ${asset.size}\n`);
    }
    expect(readFileSync(join(prepared.repository, prepared.paths.canonical), "utf8")).toContain("https://git-lfs.github.com/spec/v1");
    expect(readFileSync(join(prepared.repository, prepared.paths.legacy), "utf8")).toContain("https://hawser.github.com/spec/v1");
    const observed = observeLargeFileTree({ repository: prepared.repository, treeish: prepared.baseSha, fixture: prepared });
    expect(observed.files).toHaveLength(prepared.baseline.length);
    expect(() => assertLargeFileFinalTree({ fixture: prepared, observation: observed })).toThrow();
    expect(JSON.parse(readFileSync(join(prepared.root, "fixture.json"), "utf8"))).toEqual(prepared);
  });

  it("imports exact existing parent Git objects without checkout hooks or filters", () => {
    const source = fixture();
    const hook = join(source.root, "must-not-execute");
    const hookScript = join(source.repository, ".git", "hooks", "post-checkout");
    writeFileSync(hookScript, `#!/bin/sh\ntouch '${hook}'\n`, { mode: 0o755 });
    git(source.repository, ["config", "filter.lfs.smudge", `touch '${hook}'`]);
    git(source.repository, ["config", "filter.lfs.required", "true"]);
    const prepared = createLargeFileFixture({ parent: parent(), namespace: "large-files-child-a", sourceRepository: source.repository, baseSha: source.baseSha });
    const commit = git(prepared.repository, ["cat-file", "commit", prepared.baseSha]).toString();
    expect(commit).toContain(`parent ${source.baseSha}\n`);
    expect(prepared.sourceTreeSha).toBe(source.baseTreeSha);
    expect(existsSync(hook)).toBe(false);
    expect(readFileSync(join(prepared.repository, source.paths.canonical))).toEqual(readFileSync(join(source.repository, source.paths.canonical)));
  });

  it("rejects unsafe namespace/source modes and does not overwrite an existing namespace", () => {
    const prepared = fixture();
    expect(() => largeFilePaths("../escape")).toThrow();
    expect(() => createLargeFileFixture({ parent: parent(), namespace: prepared.namespace, sourceRepository: prepared.repository })).toThrow();
    expect(() => createLargeFileFixture({ parent: parent(), namespace: prepared.namespace, sourceRepository: prepared.repository, baseSha: prepared.baseSha })).toThrow();
    const linkOid = git(prepared.repository, ["hash-object", "-w", "--stdin"], "target").toString().trim();
    git(prepared.repository, ["update-index", "--add", "--cacheinfo", "120000", linkOid, "unsafe-link"]);
    const tree = git(prepared.repository, ["write-tree"]).toString().trim();
    const head = git(prepared.repository, ["commit-tree", tree, "-p", prepared.baseSha, "-m", "unsafe mode"]).toString().trim();
    expect(() => createLargeFileFixture({ parent: parent(), namespace: "large-files-child-b", sourceRepository: prepared.repository, baseSha: head })).toThrow(/unsupported mode/);
  });

  it("runs the small recipe in three ordered phases and proves exact oversized patch, manifests and final blobs", async () => {
    const prepared = fixture();
    let base = prepared.baseSha;
    for (const phase of ["payload", "metadata", "join"] as const) {
      // This is an offline recipe regression, not a model-worker or installed execution receipt.
      execFileSync(process.execPath, [join(prepared.repository, prepared.recipePath), phase], { cwd: prepared.repository, timeout: 15_000, env: { PATH: "/usr/bin:/bin", HOME: prepared.root } });
      const { head, patch } = commitPhase(prepared, phase, base);
      const patchPath = join(prepared.root, `${phase}.patch`);
      writeFileSync(patchPath, patch, { flag: "wx", mode: 0o600 });
      const artifact = await artifactFromPatchFile({ repository: prepared.repository, patchPath, baseSha: base, changedPaths: prepared.expected.filter((file) => file.phase === phase).map((file) => file.path), outcome: "succeeded" });
      const observation = observeLargeFileTree({ repository: prepared.repository, treeish: head, fixture: prepared, baseSha: base, patch });
      expect(assertLargeFileArtifact({ fixture: prepared, artifact, observation, patch, phase }).oversized).toBe(phase === "payload");
      if (phase === "payload") {
        expect(patch.length).toBeGreaterThan(5 * 1024 * 1024);
        expect(artifact.payload!.chunks.length).toBeGreaterThan(1);
        expect(artifact.fileManifest!.files[0]).toMatchObject({ bytes: LARGE_FILE_AUDIO_BYTES, mediaType: "audio/wav", generated: true });
        const mutations = [
          { ...artifact, digest: "0".repeat(64) },
          { ...artifact, patch: artifact.patch + "text" },
          { ...artifact, changedPaths: [prepared.paths.canonical] },
          { ...artifact, payload: { ...artifact.payload!, chunks: [...artifact.payload!.chunks].reverse() } },
          { ...artifact, fileManifest: { ...artifact.fileManifest!, files: artifact.fileManifest!.files.map((file) => ({ ...file, mode: "100755" })) } },
        ];
        for (const changed of mutations) expect(() => assertLargeFileArtifact({ fixture: prepared, artifact: changed, observation, patch, phase })).toThrow();
        const damaged = Buffer.from(patch); damaged[damaged.length - 20] = damaged[damaged.length - 20]! ^ 1;
        expect(() => assertLargeFileArtifact({ fixture: prepared, artifact, observation, patch: damaged, phase })).toThrow();
        expect(() => observeLargeFileTree({ repository: prepared.repository, treeish: head, fixture: prepared, baseSha: base, patch: Buffer.from("not a Git patch") })).toThrow();
      }
      base = head;
    }
    const observation = observeLargeFileTree({ repository: prepared.repository, treeish: base, fixture: prepared });
    expect(assertLargeFileFinalTree({ fixture: prepared, observation }).lfsPointersPreserved).toBe(true);
    expect(observation.files.find((file) => file.path === prepared.paths.executable)?.mode).toBe("100755");
    const changed = structuredClone(observation);
    changed.files.find((file) => file.path === prepared.paths.canonical)!.digest = "0".repeat(64);
    expect(() => assertLargeFileFinalTree({ fixture: prepared, observation: changed })).toThrow();
  }, 90_000);

  it("refuses fake same-sized manifest metadata when the actual Git bytes or tree differ", () => {
    const prepared = fixture();
    writeLargeFileOutput({ fixture: prepared });
    const bytes = readFileSync(join(prepared.repository, prepared.paths.payload));
    bytes[100] = bytes[100]! ^ 1;
    writeFileSync(join(prepared.repository, prepared.paths.payload), bytes);
    const { head } = commitPhase(prepared, "payload", prepared.baseSha);
    expect(() => observeLargeFileTree({ repository: prepared.repository, treeish: head, fixture: prepared })).toThrow(/actual Git blob/);
  });

  it("does not write through symlink parents, outside its owned fixture, or over existing output", () => {
    const prepared = fixture();
    const elsewhere = parent();
    expect(() => writeLargeFileOutput({ fixture: prepared, checkout: elsewhere })).toThrow(/another checkout/);
    const prefix = join(prepared.repository, prepared.paths.prefix);
    symlinkSync(elsewhere, join(prefix, "generated"));
    expect(() => writeLargeFileOutput({ fixture: prepared })).toThrow(/not a directory/);
    expect(existsSync(join(elsewhere, "qualification-audio.wav"))).toBe(false);
    rmSync(join(prefix, "generated"));
    writeLargeFileOutput({ fixture: prepared });
    expect(() => writeLargeFileOutput({ fixture: prepared })).toThrow();
    chmodSync(prepared.root, 0o755);
    expect(() => writeLargeFileOutput({ fixture: prepared, phase: "metadata" })).toThrow();
  });

  it.each(["scope", "secret", "symlink"] as const)("produces local-only %s refusal bytes with no upload", async (scenario) => {
    const prepared = fixture();
    execFileSync(process.execPath, [join(prepared.repository, prepared.recipePath), scenario], { cwd: prepared.repository, timeout: 15_000, env: { PATH: "/usr/bin:/bin", HOME: prepared.root } });
    let error: unknown;
    try {
      await collectLocalArtifact({ root: prepared.root, path: prepared.repository, repository: prepared.repository, baseSha: prepared.baseSha }, "", [prepared.paths.payload]);
    } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error);
    const reason = (error as Error).message;
    const observation = { scenario, outcome: "refused" as const, stage: "collection" as const, reason, artifactPublished: false };
    expect(assertLargeFileRefusal(observation)).toMatchObject({ refused: true, uploadAbsence: "unavailable" });
    expect(() => assertLargeFileRefusal({ ...observation, contentUploads: 0 })).toThrow(/provenance/);
    expect(reason).not.toContain("Q".repeat(40));
  }, 30_000);

  it.each([
    ["lfs-tool-missing", "pinned repository requires git-lfs; install Git LFS"],
    ["lfs-object-missing", "required LFS object is missing or unsafe in the standard local cache"],
    ["lfs-object-corrupt", "LFS cache object digest mismatch or changed while reading"],
  ] as const)("requires explicit no-model/no-content-upload observation for %s", (scenario, reason) => {
    const observation = { scenario: scenario as LargeFileRefusalScenario, outcome: "refused" as const, stage: "source-preflight" as const, reason, contentUploads: 0, contentUploadEvidence: "instrumented-content-write-count" as const, artifactPublished: false, modelCalls: 0 };
    expect(largeFileScenario(scenario).remoteWritesAllowed).toBe(false);
    expect(assertLargeFileRefusal(observation).refused).toBe(true);
    for (const changed of [
      { ...observation, outcome: "accepted" as const }, { ...observation, reason: "unrelated platform outage" },
      { ...observation, modelCalls: 1 }, { ...observation, contentUploads: 1 }, { ...observation, artifactPublished: true },
    ]) expect(() => assertLargeFileRefusal(changed)).toThrow();
    const incomplete = { scenario, outcome: "refused" as const, stage: "source-preflight" as const, reason, artifactPublished: false };
    expect(() => assertLargeFileRefusal(incomplete)).toThrow();
  });

  it("describes real workers, exact ordered dependencies, unchanged LFS and fixed paths", () => {
    const body = largeFileObjectiveBody("large-files-body-a");
    expect(body).toContain("sole root");
    expect(body).toContain("depends on Payload");
    expect(body).toContain("depends on Payload and Metadata");
    expect(body).toContain("exactly 6291500 bytes");
    expect(body).toContain("Real installed workers");
    expect(body).toContain("Do not fetch/install/upload LFS");
    expect(() => largeFileScenario("unsupported" as LargeFileRefusalScenario)).toThrow();
  });
});
