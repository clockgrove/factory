import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type {
  ContentStore,
  ExecutionRequest,
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
  content: string;
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
export function sandboxFiles(worktree: string): SandboxFile[] {
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
  return [...paths].sort().flatMap((path) => {
    sandboxPath(path);
    const stat = lstatSync(join(worktree, path), { throwIfNoEntry: false });
    if (!stat) return [];
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error(`Unsupported sandbox result entry ${path}`);
    const bytes = readFileSync(join(worktree, path));
    return [
      {
        path,
        mode: stat.mode & 0o111 ? ("100755" as const) : ("100644" as const),
        digest: sandboxDigest(bytes),
        bytes: bytes.length,
        content: bytes.toString("base64"),
      },
    ];
  });
}
/** Validate the entire manifest before writing any provider-controlled path. */
export function importSandboxFiles(
  worktree: string,
  files: SandboxFile[],
): void {
  if (!Array.isArray(files)) throw new Error("Sandbox result has no files");
  const names = new Set<string>();
  for (const file of files) {
    sandboxPath(file.path);
    if (
      names.has(file.path) ||
      !["100644", "100755"].includes(file.mode) ||
      typeof file.content !== "string"
    )
      throw new Error("Invalid sandbox file manifest");
    const bytes = Buffer.from(file.content, "base64");
    if (
      bytes.toString("base64") !== file.content ||
      bytes.length !== file.bytes ||
      sandboxDigest(bytes) !== file.digest
    )
      throw new Error("Sandbox file digest mismatch");
    names.add(file.path);
  }
  for (const path of names)
    for (const other of names)
      if (path !== other && path.startsWith(other + "/"))
        throw new Error("Conflicting sandbox file paths");
  for (const path of readdirSync(worktree))
    if (path !== ".git")
      rmSync(join(worktree, path), { recursive: true, force: true });
  for (const file of files) {
    const path = join(worktree, file.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, Buffer.from(file.content, "base64"), {
      mode: file.mode === "100755" ? 0o755 : 0o644,
      flag: "wx",
    });
  }
}

export async function prepareSandboxInputs(
  checkout: string,
  repo: string,
  request: ExecutionRequest,
  store: ContentStore,
): Promise<{
  request: ExecutionRequest;
  harness: Omit<HarnessRequest, "worktree">;
}> {
  await prepareManagedBase(checkout, repo, request.baseSha);
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
