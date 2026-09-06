import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  MAX_ARTIFACT_PATCH_BYTES,
  assertArtifactScope,
  normalizeArtifact,
  payloadPatchMarker,
  verifyArtifact,
  type ArtifactInput,
  type NormalizedArtifact,
} from "../execution/artifacts.js";
import {
  ArtifactFileManifestSchema,
  ArtifactPathSchema,
  MAX_CONTENT_BYTES,
  MAX_CONTENT_FILES,
  MAX_CONTENT_FILE_BYTES,
  cachePayload,
  inspectContentFile,
  sha256,
  type ArtifactFileManifest,
} from "../execution/artifact-content.js";
import { runContainedProcess, sanitizedWorkerEnvironment } from "./process-group.js";
import { inspectPinnedLfs, parseLfsPointer } from "../repository-profiles/git-lfs.js";

const safeGit = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.quotePath=false",
  "-c",
  "core.abbrev=7",
  "-c",
  "color.ui=false",
  "-c",
  "diff.renames=false",
  "-c",
  "diff.algorithm=myers",
  "-c",
  "diff.indentHeuristic=true",
  "-c",
  "diff.context=3",
  "-c",
  "diff.noprefix=false",
  "-c",
  "diff.mnemonicPrefix=false",
];
const gitEnvironment = () => ({
  ...sanitizedWorkerEnvironment(process.env),
  GIT_NO_REPLACE_OBJECTS: "1",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_LITERAL_PATHSPECS: "1",
});

/** Child stdout is backpressured to an owned file and hard byte ceiling, never a giant string. */
export async function streamGitFile(
  repository: string,
  args: string[],
  destination: string,
  limit = MAX_CONTENT_BYTES,
): Promise<void> {
  return streamCommandFile("git", [...safeGit, ...args], repository, destination, limit);
}
export async function streamCommandFile(
  command: string,
  args: string[],
  repository: string,
  destination: string,
  limit = MAX_CONTENT_BYTES,
): Promise<void> {
  const child = spawn(command, args, {
    cwd: repository,
    env: gitEnvironment(),
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let diagnostic = "";
  child.stderr.on("data", (chunk: Buffer) => {
    diagnostic = (diagnostic + chunk.toString("utf8")).slice(-8192);
  });
  const stop = () => {
    try {
      if (child.pid) process.kill(-child.pid, "SIGKILL");
    } catch {}
  };
  const timer = setTimeout(stop, 120_000);
  const completed = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`bounded Git content command failed (${code}): ${diagnostic}`)),
    );
  });
  // Attach immediately so a spawn failure cannot become an unhandled rejection during pipeline setup.
  const outcome = completed.then(
    () => null,
    (error: unknown) => error,
  );
  let bytes = 0;
  try {
    await pipeline(
      child.stdout,
      new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.length;
          callback(
            bytes > limit ? new Error("Git content stream exceeds byte ceiling") : null,
            chunk,
          );
        },
      }),
      createWriteStream(destination, { flags: "wx", mode: 0o600 }),
    );
    const error = await outcome;
    if (error) throw error;
  } catch (error) {
    stop();
    await outcome;
    await rm(destination, { force: true });
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function indexGit(repository: string, index: string, args: string[]): Promise<string> {
  const result = await runContainedProcess({
    command: "git",
    args: [...safeGit, ...args],
    cwd: repository,
    env: { ...gitEnvironment(), GIT_INDEX_FILE: index },
    timeoutMs: 120_000,
    maxOutputBytes: 6 * 1024 * 1024,
  });
  if (result.exitCode !== 0)
    throw new Error(`artifact index operation failed: ${result.stderr || result.stdout}`);
  return result.stdout.trimEnd();
}

/** Applies in a private index only; hashes actual Git blobs before any upload or executable validation. */
export async function inspectPatchManifest(
  repository: string,
  baseSha: string,
  patchPath: string,
  changedPaths: string[],
): Promise<ArtifactFileManifest> {
  if (!/^[a-f0-9]{40}$/i.test(baseSha)) throw new Error("invalid artifact base SHA");
  if (changedPaths.length > MAX_CONTENT_FILES || new Set(changedPaths).size !== changedPaths.length)
    throw new Error("artifact path count/identity exceeds bound");
  changedPaths.forEach((path) => ArtifactPathSchema.parse(path));
  const lfs = await inspectPinnedLfs(repository, baseSha);
  if (lfs.assets.some((asset) => changedPaths.includes(asset.path)))
    throw new Error(
      "changed LFS assets require an explicitly supported authenticated LFS upload capability",
    );
  const root = await mkdtemp(join(tmpdir(), "factory-artifact-index-"));
  const index = join(root, "index");
  try {
    await indexGit(repository, index, ["read-tree", baseSha]);
    const baseTreeSha = await indexGit(repository, index, ["write-tree"]);
    await indexGit(repository, index, [
      "apply",
      "--cached",
      "--binary",
      "--whitespace=error-all",
      patchPath,
    ]);
    const resultTreeSha = await indexGit(repository, index, ["write-tree"]);
    const actualPaths = (
      await indexGit(repository, index, ["diff", "--cached", "--name-only", "-z", baseSha])
    )
      .split("\0")
      .filter(Boolean)
      .sort();
    if (JSON.stringify(actualPaths) !== JSON.stringify([...changedPaths].sort()))
      throw new Error("artifact patch paths differ from supplied manifest");
    const listing = await indexGit(repository, index, ["ls-tree", "-r", "-l", "-z", resultTreeSha]);
    const objects = new Map<string, { mode: "100644" | "100755"; oid: string; bytes: number }>();
    for (const line of listing.split("\0").filter(Boolean)) {
      const match = /^(\d{6}) blob ([a-f0-9]{40})\s+(\d+)\t([\s\S]+)$/.exec(line);
      if (!match) continue;
      if (!changedPaths.includes(match[4]!)) continue;
      if (match[1] !== "100644" && match[1] !== "100755")
        throw new Error("artifact contains unsupported Git mode");
      const bytes = Number(match[3]);
      if (!Number.isSafeInteger(bytes) || bytes > MAX_CONTENT_FILE_BYTES)
        throw new Error("artifact Git blob exceeds file byte ceiling");
      objects.set(match[4]!, { mode: match[1], oid: match[2]!, bytes });
    }
    if ([...objects.values()].reduce((sum, object) => sum + object.bytes, 0) > MAX_CONTENT_BYTES)
      throw new Error("artifact exceeds total file byte ceiling");
    const files: ArtifactFileManifest["files"] = [];
    for (const [position, path] of [...changedPaths].sort().entries()) {
      const object = objects.get(path);
      if (!object) {
        // Absence, not an unrecognized mode, is the only valid deletion.
        const remaining = await indexGit(repository, index, [
          "ls-tree",
          "-z",
          resultTreeSha,
          "--",
          path,
        ]);
        if (remaining) throw new Error("unsupported artifact tree entry is not a deletion");
        files.push({
          path,
          action: "delete",
          bytes: 0,
          digest: sha256(Buffer.alloc(0)),
          mode: "100644",
          mediaType: "unknown",
          generated: /(^|\/)(generated|dist|build)\//.test(path),
        });
        continue;
      }
      const content = join(root, `blob-${position}`);
      await streamGitFile(
        repository,
        ["cat-file", "blob", object.oid],
        content,
        MAX_CONTENT_FILE_BYTES,
      );
      await chmod(content, object.mode === "100755" ? 0o700 : 0o600);
      const observed = await inspectContentFile(content);
      if (observed.bytes < 1024 && parseLfsPointer(await readFile(content)))
        throw new Error(
          "new LFS pointer assets require an explicitly supported authenticated LFS upload capability",
        );
      if (observed.bytes !== object.bytes)
        throw new Error("artifact blob size changed during collection");
      files.push({
        path,
        action: "write",
        ...observed,
        generated: /(^|\/)(generated|dist|build)\//.test(path),
      });
      await rm(content);
    }
    return ArtifactFileManifestSchema.parse({ version: 1, baseTreeSha, resultTreeSha, files });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Trusted local/remote collection both use this host-side content/manifest boundary. */
export async function artifactFromPatchFile(
  args: Omit<ArtifactInput, "patch" | "payload" | "fileManifest"> & {
    repository: string;
    patchPath: string;
  },
): Promise<NormalizedArtifact> {
  const patchIdentity = await inspectContentFile(args.patchPath, MAX_CONTENT_BYTES);
  const fileManifest = await inspectPatchManifest(
    args.repository,
    args.baseSha,
    args.patchPath,
    args.changedPaths,
  );
  const payload =
    patchIdentity.bytes > MAX_ARTIFACT_PATCH_BYTES ? await cachePayload(args.patchPath) : undefined;
  const patch = payload ? payloadPatchMarker(payload) : await readFile(args.patchPath, "utf8");
  return normalizeArtifact({
    baseSha: args.baseSha,
    changedPaths: args.changedPaths,
    patch,
    payload,
    fileManifest,
    ...(args.commands ? { commands: args.commands } : {}),
    ...(args.logs === undefined ? {} : { logs: args.logs }),
    outcome: args.outcome,
    ...(args.reason ? { reason: args.reason } : {}),
    ...(args.createdAt ? { createdAt: args.createdAt } : {}),
  });
}

export async function artifactFromGitRange(args: {
  repository: string;
  sourceBaseSha: string;
  headSha: string;
  baseSha: string;
  changedPaths: string[];
  emptyReason?: string;
  authenticatedLegacyDigest?: string | undefined;
}): Promise<NormalizedArtifact> {
  if (
    ![args.sourceBaseSha, args.headSha, args.baseSha].every((value) =>
      /^[a-f0-9]{40}$/i.test(value),
    )
  )
    throw new Error("artifact Git range must use exact SHAs");
  if (!args.changedPaths.length)
    return normalizeArtifact({
      baseSha: args.baseSha,
      patch: "",
      changedPaths: [],
      outcome: "declined",
      reason: args.emptyReason ?? "artifact Git range has no changes",
    });
  const root = await mkdtemp(join(tmpdir(), "factory-range-patch-"));
  try {
    const patchPath = join(root, "artifact.patch");
    await streamGitFile(
      args.repository,
      ["diff", "--binary", "--no-ext-diff", "--no-textconv", args.sourceBaseSha, args.headSha],
      patchPath,
    );
    const artifact = await artifactFromPatchFile({
      repository: args.repository,
      baseSha: args.baseSha,
      patchPath,
      changedPaths: args.changedPaths,
      outcome: "succeeded",
    });
    if (args.authenticatedLegacyDigest && !artifact.payload) {
      const legacy = normalizeArtifact({
        baseSha: artifact.baseSha,
        patch: artifact.patch,
        changedPaths: artifact.changedPaths,
        outcome: artifact.outcome,
      });
      if (legacy.digest === args.authenticatedLegacyDigest) return legacy;
    }
    return artifact;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Upgrade newly collected inline provider data before durable transfer; old stored receipt identities are not rewritten. */
export async function bindArtifactManifest(
  repository: string,
  artifact: NormalizedArtifact,
  allowedPaths?: string[],
): Promise<NormalizedArtifact> {
  verifyArtifact(artifact);
  if (allowedPaths) assertArtifactScope(artifact, allowedPaths);
  if (artifact.fileManifest || !artifact.patch.trim()) return artifact;
  const root = await mkdtemp(join(tmpdir(), "factory-inline-manifest-"));
  try {
    const path = join(root, "artifact.patch");
    const { materializeArtifactPatch } = await import("../execution/artifacts.js");
    await materializeArtifactPatch(artifact, path);
    return await artifactFromPatchFile({
      repository,
      patchPath: path,
      baseSha: artifact.baseSha,
      changedPaths: artifact.changedPaths,
      outcome: artifact.outcome,
      logs: artifact.logs,
      commands: artifact.commands,
      createdAt: new Date(artifact.createdAt),
      ...(artifact.reason ? { reason: artifact.reason } : {}),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
