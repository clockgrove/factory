import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import { normalizeRepositoryFacts, type RepositoryFacts } from "./index.js";
import { assertNoSecretMaterial, assertWithinBytes } from "../protocol/limits.js";

/** Read facts without executing a repository, installing tools, or following external symlinks. */
export async function readRepositoryFacts(
  checkout: string,
  repositoryFiles: string[],
): Promise<RepositoryFacts> {
  const facts = normalizeRepositoryFacts({ files: repositoryFiles.map((path) => ({ path })) });
  const root = await realpath(checkout);
  const candidates = facts.files.filter(
    ({ path }) =>
      /^(?:package\.json|Cargo\.toml|go\.mod|pyproject\.toml|pytest\.ini|setup\.cfg|GNUmakefile|makefile|Makefile)$/.test(
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
