import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import { normalizeRepositoryFacts, type RepositoryFacts } from "./index.js";
import { assertNoSecretMaterial, assertWithinBytes } from "../protocol/limits.js";
import type { PinnedLfsFacts } from "./git-lfs.js";
import { runContainedProcess, sanitizedWorkerEnvironment } from "../runtime/process-group.js";
import { pinnedGitEnvironment } from "../runtime/pinned-git-environment.js";
import { createHash } from "node:crypto";

export interface PinnedRepositoryFacts {
  baseSha: string;
  repository: RepositoryFacts;
  manifests: string[];
  relevantPaths: string[];
  digest: string;
}

const compilerDocument = (path: string) =>
  /^(?:package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|bun\.lock|bun\.lockb|bunfig\.toml|Cargo\.toml|Cargo\.lock|go\.mod|go\.sum|pyproject\.toml|uv\.lock|\.python-version|pytest\.ini|setup\.cfg|GNUmakefile|makefile|Makefile|\.factory\/execution-requirements\.json)$/.test(
    path,
  ) || /^(?:README|CONTRIBUTING|AGENTS)(?:\.md)?$/i.test(path);

const manifestPath = (path: string) =>
  /(?:^|\/)(?:package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|bun\.lock|bun\.lockb|bunfig\.toml|Cargo\.toml|Cargo\.lock|go\.mod|go\.sum|pyproject\.toml|uv\.lock|\.python-version)$/.test(
    path,
  );

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

async function pinnedGit(
  repository: string,
  args: string[],
  maximumBytes: number,
): Promise<string> {
  const result = await runContainedProcess({
    command: "git",
    args: [
      "--no-optional-locks",
      "--no-replace-objects",
      "--literal-pathspecs",
      "-c",
      "core.hooksPath=/dev/null",
      ...args,
    ],
    cwd: repository,
    env: pinnedGitEnvironment(sanitizedWorkerEnvironment(process.env, [])),
    timeoutMs: 30_000,
    maxOutputBytes: maximumBytes,
  });
  if (result.exitCode !== 0 || result.timedOut || result.stdout.startsWith("[output truncated"))
    throw new Error("pinned compiler Git object read failed or exceeded its bound");
  return result.stdout;
}

/** Read compiler authority only from immutable Git objects. No filter, hook,
 * working-tree byte, lazy fetch, or implicit LFS fetch participates. */
export async function readPinnedCompilerFacts(
  repository: string,
  baseSha: string,
  repositoryFiles: string[],
  lfs?: PinnedLfsFacts,
): Promise<PinnedRepositoryFacts> {
  if (!/^[0-9a-f]{40}$/.test(baseSha)) throw new Error("invalid pinned compiler base");
  if (lfs && lfs.baseSha !== baseSha)
    throw new Error("pinned compiler LFS facts use a different base");
  const identity = (
    await pinnedGit(repository, ["rev-parse", "--verify", `${baseSha}^{commit}`], 1_024)
  ).trim();
  if (identity !== baseSha) throw new Error("compiler base is not the exact requested commit");
  const seed = normalizeRepositoryFacts({
    files: repositoryFiles.map((path) => ({ path })),
    ...(lfs ? { lfs } : {}),
  });
  const candidates = seed.files.filter(({ path }) => compilerDocument(path)).slice(0, 64);
  const documents: Record<string, string> = {};
  for (const { path } of candidates) {
    const text = await pinnedGit(repository, ["show", `${baseSha}:${path}`], 256 * 1024 + 1);
    if (Buffer.byteLength(text) > 256 * 1024)
      throw new Error(`pinned compiler document exceeds byte bound: ${path}`);
    documents[path] = text;
  }
  let scripts: Record<string, string> = {};
  if (documents["package.json"] !== undefined) {
    let manifest: unknown;
    try {
      manifest = JSON.parse(documents["package.json"]);
    } catch {
      throw new Error("pinned package.json is invalid JSON; validation recipes are unavailable");
    }
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest))
      throw new Error("pinned package.json contains invalid script facts");
    const value = (manifest as { scripts?: unknown }).scripts;
    if (value !== undefined) {
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.values(value).some((entry) => typeof entry !== "string")
      )
        throw new Error("pinned package.json contains invalid script facts");
      scripts = value as Record<string, string>;
    }
    assertWithinBytes(scripts, 32 * 1024, "pinned compilation package scripts");
  }
  const facts = normalizeRepositoryFacts({ ...seed, scripts, documents });
  assertNoSecretMaterial(facts, "pinned repository compilation facts");
  const manifests = facts.files
    .map(({ path }) => path)
    .filter(manifestPath)
    .sort();
  const relevantPaths = facts.files.map(({ path }) => path).sort();
  const unsigned = { baseSha, repository: facts, manifests, relevantPaths };
  return {
    ...unsigned,
    digest: createHash("sha256").update(canonical(unsigned)).digest("hex"),
  };
}

/** Read facts without executing a repository, installing tools, or following external symlinks. */
export async function readRepositoryFacts(
  checkout: string,
  repositoryFiles: string[],
  lfs?: PinnedLfsFacts,
): Promise<RepositoryFacts> {
  const facts = normalizeRepositoryFacts({
    files: repositoryFiles.map((path) => ({ path })),
    ...(lfs === undefined ? {} : { lfs }),
  });
  const root = await realpath(checkout);
  const candidates = facts.files.filter(
    ({ path }) =>
      /^(?:package\.json|Cargo\.toml|go\.mod|pyproject\.toml|pytest\.ini|setup\.cfg|GNUmakefile|makefile|Makefile|\.factory\/execution-requirements\.json)$/.test(
        path,
      ) || /^(?:README|CONTRIBUTING|AGENTS)(?:\.md)?$/i.test(path),
  );
  const documents: Record<string, string> = {};
  for (const { path } of candidates) {
    const source = join(root, path);
    const resolved = await realpath(source).catch(() => {
      throw new Error(`observed ${path} is unreadable; validation recipes are unavailable`);
    });
    if (!resolved.startsWith(root + sep))
      throw new Error(`repository document escapes checkout: ${path}`);
    const file = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!(await file.stat()).isFile()) throw new Error(`${path} must be a regular file`);
      const bytes = Buffer.alloc(256 * 1024 + 1);
      let size = 0;
      while (size < bytes.length) {
        const { bytesRead } = await file.read(bytes, size, bytes.length - size, size);
        if (!bytesRead) break;
        size += bytesRead;
      }
      if (size === bytes.length)
        throw new Error(`${path} exceeds the compilation facts byte bound`);
      documents[path] = bytes.subarray(0, size).toString("utf8");
    } finally {
      await file.close();
    }
  }
  let scripts: Record<string, string> = {};
  if (documents["package.json"] !== undefined) {
    let manifest: unknown;
    try {
      manifest = JSON.parse(documents["package.json"]);
    } catch {
      throw new Error("package.json is invalid JSON; validation recipes are unavailable");
    }
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest))
      throw new Error("package.json contains invalid script facts");
    const value = (manifest as { scripts?: unknown }).scripts;
    if (value !== undefined) {
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.values(value).some((entry) => typeof entry !== "string")
      )
        throw new Error("package.json contains invalid script facts; refusing compilation");
      scripts = value as Record<string, string>;
    }
    assertWithinBytes(scripts, 32 * 1024, "compilation package scripts");
  }
  const result = normalizeRepositoryFacts({ ...facts, scripts, documents });
  assertNoSecretMaterial(result, "repository compilation facts");
  return result;
}
