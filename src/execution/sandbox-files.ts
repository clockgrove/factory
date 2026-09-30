import { createHash } from "node:crypto";
import {
  createReadStream,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { create, extract, list } from "tar";
import type {
  ContentStore,
  ExecutionRequest,
  SandboxRepositoryInput,
  HarnessRequest,
} from "../contracts.js";
import { importSourceAssets } from "../media.js";
import { pinnedGit, pinnedGitRaw } from "../process.js";
import { prepareManagedBase } from "./managed-base.js";

export const sandboxDigest = (bytes: Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");
export interface SandboxFile {
  path: string;
  mode: "100644" | "100755";
  digest: string;
  bytes: number;
}
export function sandboxPath(path: string): void {
  if (
    !path ||
    path.includes("\\") ||
    path
      .split("/")
      .some((p) => !p || p === "." || p === ".." || p.toLowerCase() === ".git")
  )
    throw new Error("Unsafe sandbox file path");
}
/** Export ordinary versioned/unignored bytes and controller staging, never repository authority. */
export async function sandboxFiles(worktree: string): Promise<SandboxFile[]> {
  const paths = new Set(
    pinnedGitRaw(worktree, "ls-files", "-co", "--exclude-standard", "-z")
      .toString()
      .split("\0")
      .filter(Boolean),
  );
  function visit(path: string): void {
    const stat = lstatSync(join(worktree, path), { throwIfNoEntry: false });
    if (!stat) return;
    if (stat.isDirectory())
      for (const child of readdirSync(join(worktree, path)))
        visit(`${path}/${child}`);
    else paths.add(path);
  }
  for (const path of [
    ".factory-inputs",
    ".factory-media",
    ".factory-assets.json",
    ".factory-discovery.json",
  ])
    visit(path);
  const files: SandboxFile[] = [];
  for (const path of [...paths].sort()) {
    sandboxPath(path);
    const parts = path.split("/");
    for (let index = 1; index < parts.length; index++) {
      const parent = lstatSync(join(worktree, ...parts.slice(0, index)), {
        throwIfNoEntry: false,
      });
      if (!parent) throw new Error(`Missing sandbox parent ${path}`);
      if (!parent.isDirectory() || parent.isSymbolicLink())
        throw new Error(`Unsupported sandbox result parent ${path}`);
    }
    const stat = lstatSync(join(worktree, path), { throwIfNoEntry: false });
    if (!stat) continue;
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error(`Unsupported sandbox result entry ${path}`);
    files.push({
      path,
      mode: stat.mode & 0o111 ? "100755" : "100644",
      ...(await sandboxFileDigest(join(worktree, path))),
    });
  }
  return files;
}

export async function sandboxFileDigest(
  path: string,
): Promise<{ digest: string; bytes: number }> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  return { digest: hash.digest("hex"), bytes };
}

/** Binary bytes remain files, not a repository-sized JSON string. */
export async function exportSandboxFiles(
  worktree: string,
  archive: string,
): Promise<SandboxFile[]> {
  const files = await sandboxFiles(worktree);
  if (files.length)
    await create(
      {
        file: archive,
        cwd: worktree,
        portable: true,
        noMtime: true,
        noDirRecurse: true,
      },
      files.map((file) => file.path),
    );
  else writeFileSync(archive, Buffer.alloc(1024), { mode: 0o600 });
  return files;
}

/** Validate the entire manifest before writing any provider-controlled path. */
export async function importSandboxFiles(
  worktree: string,
  files: SandboxFile[],
  archive: string,
  staging: string,
): Promise<void> {
  if (!Array.isArray(files)) throw new Error("Sandbox result has no files");
  const names = new Set<string>();
  for (const file of files) {
    sandboxPath(file.path);
    if (
      names.has(file.path) ||
      !["100644", "100755"].includes(file.mode) ||
      !/^[a-f0-9]{64}$/.test(file.digest) ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0
    )
      throw new Error("Invalid sandbox file manifest");
    names.add(file.path);
  }
  for (const path of names)
    for (const other of names)
      if (path !== other && path.startsWith(other + "/"))
        throw new Error("Conflicting sandbox file paths");
  const entries = new Set<string>();
  await list({
    file: archive,
    strict: true,
    onReadEntry(entry) {
      sandboxPath(entry.path);
      if (
        entry.type !== "File" ||
        !names.has(entry.path) ||
        entries.has(entry.path)
      )
        throw new Error("Unsafe sandbox result archive");
      entries.add(entry.path);
    },
  });
  if (entries.size !== names.size)
    throw new Error("Incomplete sandbox result archive");
  mkdirSync(staging, { recursive: false, mode: 0o700 });
  await extract({ file: archive, cwd: staging, strict: true });
  for (const file of files) {
    const actual = await sandboxFileDigest(join(staging, file.path));
    if (actual.bytes !== file.bytes || actual.digest !== file.digest)
      throw new Error("Sandbox file digest mismatch");
  }
  for (const path of readdirSync(worktree))
    if (path !== ".git")
      rmSync(join(worktree, path), { recursive: true, force: true });
  for (const file of files) {
    const path = join(worktree, file.path);
    mkdirSync(dirname(path), { recursive: true });
    copyFileSync(join(staging, file.path), path);
    const { chmodSync } = await import("node:fs");
    chmodSync(path, file.mode === "100755" ? 0o755 : 0o644);
  }
}

export async function prepareSandboxInputs(
  checkout: string,
  repo: string,
  request: ExecutionRequest,
  store: ContentStore,
  lfsSources: { path: string; localPath: string }[] = [],
): Promise<{
  request: ExecutionRequest;
  harness: Omit<HarnessRequest, "worktree">;
}> {
  await prepareManagedBase(checkout, repo, request.baseSha);
  for (const source of lfsSources)
    copyFileSync(source.localPath, join(repo, source.path));
  const sourceAssets = await importSourceAssets(
    store,
    repo,
    request.item,
    request.objectiveBody,
  );
  let privateIndex = 0;
  const sources = [];
  for (const source of sourceAssets) {
    let path =
      source.binding.kind !== "local" &&
      source.binding.kind !== "github-attachment"
        ? source.binding.path
        : undefined;
    if (
      source.binding.kind === "local" ||
      source.binding.kind === "github-attachment"
    ) {
      path = `.factory-inputs/source-${privateIndex++}`;
      mkdirSync(dirname(join(repo, path)), { recursive: true });
      await store.materialize(source.ref, join(repo, path));
    }
    const lfsIndex = lfsSources.findIndex(
      (entry) =>
        entry.path === source.binding.path &&
        source.binding.kind !== "local" &&
        source.binding.kind !== "github-attachment",
    );
    if (lfsIndex >= 0) {
      path = `.factory-inputs/lfs-${lfsIndex}`;
      mkdirSync(dirname(join(repo, path)), { recursive: true });
      await store.materialize(source.ref, join(repo, path));
    }
    sources.push({ ...source, ...(path ? { path } : {}) });
  }
  const selected = [];
  for (const [index, asset] of (request.selectedAssets ?? []).entries()) {
    const path = `.factory-inputs/selected-${index}`;
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    await store.verify(asset.ref);
    await store.materialize(asset.ref, join(repo, path));
    selected.push({ ...asset, path });
  }
  if (pinnedGit(repo, "rev-parse", "HEAD") !== request.baseSha)
    throw new Error("Sandbox base mismatch");
  return {
    request: { ...request, sourceAssets },
    harness: {
      item: request.item,
      attemptId: request.attemptId,
      sourceAssets: sources,
      selectedAssets: selected,
    },
  };
}

/** Derive required raw object identities from exact Git pointers, never from mutable remote metadata. */
export function sandboxRepositoryInput(
  checkout: string,
  repository: string,
  request: ExecutionRequest,
): SandboxRepositoryInput {
  if (
    pinnedGit(checkout, "rev-parse", `${request.baseSha}^{commit}`) !==
    request.baseSha
  )
    throw new Error("Sandbox base does not resolve exactly");
  const lfsSources: SandboxRepositoryInput["lfsSources"] = [];
  for (const source of request.item.sourceAssets ?? []) {
    if (source.kind === "local" || source.kind === "github-attachment")
      continue;
    sandboxPath(source.path);
    // Canonical pointers are small; ordinary large binary sources must not become JS strings.
    const object = `${request.baseSha}:${source.path}`;
    if (Number(pinnedGit(checkout, "cat-file", "-s", object)) > 200) continue;
    const raw = pinnedGitRaw(checkout, "show", object);
    const pointer =
      /^version https:\/\/git-lfs.github.com\/spec\/v1\noid sha256:([a-f0-9]{64})\nsize ([0-9]+)\n$/.exec(
        raw.toString(),
      );
    if (pointer && !Number.isSafeInteger(Number(pointer[2])))
      throw new Error("Invalid sandbox LFS size");
    if (pointer && !lfsSources.some((entry) => entry.path === source.path))
      lfsSources.push({
        path: source.path,
        digest: pointer[1]!,
        bytes: Number(pointer[2]),
      });
    else if (
      !pointer &&
      raw.toString().startsWith("version https://git-lfs.github.com/spec/")
    )
      throw new Error("Unsupported sandbox LFS pointer");
  }
  return {
    repository,
    baseSha: request.baseSha,
    treeSha: pinnedGit(checkout, "rev-parse", `${request.baseSha}^{tree}`),
    lfsSources,
  };
}
