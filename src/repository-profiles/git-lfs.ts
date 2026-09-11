import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, open, realpath, rename, unlink } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { runContainedProcess, sanitizedWorkerEnvironment } from "../runtime/process-group.js";

export interface PinnedLfsAsset {
  path: string;
  oid: string;
  size: number;
  pointerBlobOid: string;
  mode: "100644" | "100755";
}
export interface PinnedLfsFacts {
  baseSha: string;
  assets: PinnedLfsAsset[];
  requiredTools: string[];
  attributes: boolean;
}

export const MAX_LOCAL_LFS_FILE_BYTES = 100 * 1024 * 1024;
export const MAX_LOCAL_LFS_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_LFS_ASSETS = 256;
const versions = new Set([
  "https://git-lfs.github.com/spec/v1",
  "https://hawser.github.com/spec/v1",
]);
const safePath = (path: string) =>
  !!path &&
  !isAbsolute(path) &&
  !path.includes("\\") &&
  !path.includes(":") &&
  !Array.from(path).some(
    (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
  ) &&
  !path
    .split("/")
    .some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git");

/** Recognize canonical pointer bytes, never run a clean/smudge filter. Unsupported
 * extension transforms are a capability boundary, not ordinary source contents. */
export function parseLfsPointer(bytes: Buffer): { oid: string; size: number } | null {
  const text = bytes.toString("utf8");
  if (!/^version https:\/\/(?:git-lfs\.github\.com|hawser\.github\.com)\//.test(text)) return null;
  if (bytes.length >= 1024 || !Buffer.from(text).equals(bytes))
    throw new Error("LFS pointer exceeds its format bound or is not UTF-8");
  const lines = text.split("\n");
  if (
    lines.length !== 4 ||
    !versions.has(lines[0]!.slice("version ".length)) ||
    !/^oid sha256:[0-9a-f]{64}$/.test(lines[1]!) ||
    !/^size (?:0|[1-9][0-9]*)$/.test(lines[2]!) ||
    lines[3] !== ""
  )
    throw new Error("LFS pointer is malformed or uses unsupported extension metadata");
  const size = Number(lines[2]!.slice(5));
  if (!Number.isSafeInteger(size) || size > MAX_LOCAL_LFS_FILE_BYTES)
    throw new Error("LFS asset exceeds the supported 100 MiB per-file boundary");
  return { oid: lines[1]!.slice("oid sha256:".length), size };
}

export function normalizePinnedLfsFacts(input: PinnedLfsFacts): PinnedLfsFacts {
  if (!/^[0-9a-f]{40}$/.test(input.baseSha) || typeof input.attributes !== "boolean")
    throw new Error("invalid pinned LFS repository identity");
  if (!Array.isArray(input.assets) || input.assets.length > MAX_LFS_ASSETS)
    throw new Error("LFS asset inventory exceeds its bound");
  const paths = new Set<string>();
  let size = 0;
  const assets = input.assets
    .map((asset) => {
      if (
        !safePath(asset.path) ||
        paths.has(asset.path) ||
        !/^[0-9a-f]{64}$/.test(asset.oid) ||
        !/^[0-9a-f]{40}$/.test(asset.pointerBlobOid) ||
        !["100644", "100755"].includes(asset.mode) ||
        !Number.isSafeInteger(asset.size) ||
        asset.size < 0 ||
        asset.size > MAX_LOCAL_LFS_FILE_BYTES
      )
        throw new Error("invalid pinned LFS asset facts");
      paths.add(asset.path);
      size += asset.size;
      return {
        path: asset.path,
        oid: asset.oid,
        size: asset.size,
        pointerBlobOid: asset.pointerBlobOid,
        mode: asset.mode,
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
  if (size > MAX_LOCAL_LFS_TOTAL_BYTES)
    throw new Error("LFS assets exceed the supported 256 MiB aggregate boundary");
  const requiredTools = assets.length || input.attributes ? ["git-lfs"] : [];
  if (JSON.stringify(input.requiredTools) !== JSON.stringify(requiredTools))
    throw new Error("LFS tool requirements differ from pinned repository facts");
  return { baseSha: input.baseSha, assets, requiredTools, attributes: input.attributes };
}

function objectEnvironment(): NodeJS.ProcessEnv {
  const env = sanitizedWorkerEnvironment();
  for (const name of Object.keys(env)) if (name.startsWith("GIT_")) delete env[name];
  delete env.NODE_OPTIONS;
  return Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_TERMINAL_PROMPT: "0",
  });
}

const gitOptions = [
  "--no-optional-locks",
  "--no-replace-objects",
  "--literal-pathspecs",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
];
interface PinnedLfsInspectionOptions {
  deadline?: Date;
  now?: () => number;
}

function inspectionTimeout(maximumMs: number, options: PinnedLfsInspectionOptions): number {
  if (!options.deadline) return maximumMs;
  const remainingMs = options.deadline.getTime() - (options.now ?? Date.now)();
  if (!Number.isSafeInteger(remainingMs) || remainingMs <= 0) {
    throw new Error("pinned LFS inspection deadline exhausted");
  }
  return Math.min(maximumMs, remainingMs);
}

async function git(
  repository: string,
  args: string[],
  limit = 2 * 1024 * 1024,
  options: PinnedLfsInspectionOptions = {},
): Promise<string> {
  const result = await runContainedProcess({
    command: "git",
    args: [...gitOptions, ...args],
    cwd: resolve(repository),
    env: objectEnvironment(),
    timeoutMs: inspectionTimeout(30_000, options),
    maxOutputBytes: limit,
  });
  if (result.exitCode !== 0 || result.timedOut || result.stdout.startsWith("[output truncated"))
    throw new Error(
      "pinned LFS Git object read failed or exceeded its bound; no filter or fetch was run",
    );
  return result.stdout;
}

// A fixed host-owned bridge preserves raw bytes across the text-only contained
// process interface. Batch object reads avoid one subprocess per source file.
const batchBridge = `
const {execFileSync} = require('node:child_process');
const {createHash} = require('node:crypto');
try {
  const [options, entries, maximum] = process.argv.slice(1);
  const items = JSON.parse(entries);
  const bytes = execFileSync('git', [...JSON.parse(options), 'cat-file', '--batch'], {
    input: items.map(item => item.oid).join('\\n') + '\\n',
    maxBuffer: Number(maximum), timeout: 25000, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let offset = 0;
  const result = [];
  for (const item of items) {
    const end = bytes.indexOf(10, offset);
    if (end < 0 || bytes.subarray(offset,end).toString() !== item.oid + ' blob ' + item.size) throw Error();
    offset = end + 1;
    const blob = bytes.subarray(offset, offset + item.size);
    if (blob.length !== item.size || createHash('sha1').update('blob ' + blob.length + '\\0').update(blob).digest('hex') !== item.oid) throw Error();
    offset += item.size;
    if (bytes[offset++] !== 10) throw Error();
    result.push([item.oid, blob.toString('base64')]);
  }
  if (offset !== bytes.length) throw Error();
  process.stdout.write(JSON.stringify(result));
} catch { process.exit(2); }
`;

async function readBlobs(
  repository: string,
  entries: Array<{ oid: string; size: number }>,
  options: PinnedLfsInspectionOptions,
): Promise<Map<string, Buffer>> {
  const unique = [...new Map(entries.map((entry) => [entry.oid, entry])).values()];
  if (unique.reduce((sum, entry) => sum + entry.size, 0) > 16 * 1024 * 1024)
    throw new Error("LFS inspection contents exceed aggregate bound");
  const blobs = new Map<string, Buffer>();
  const now = options.now ?? Date.now;
  const deadline = Math.min(
    now() + 120_000,
    options.deadline?.getTime() ?? Number.POSITIVE_INFINITY,
  );
  for (let start = 0; start < unique.length; start += 32) {
    const batch = unique.slice(start, start + 32);
    const maximum = batch.reduce((sum, entry) => sum + entry.size + 128, 0) + 1024;
    const remaining = deadline - now();
    if (remaining <= 0) throw new Error("LFS inspection deadline exhausted");
    const result = await runContainedProcess({
      command: process.execPath,
      args: ["-e", batchBridge, JSON.stringify(gitOptions), JSON.stringify(batch), String(maximum)],
      cwd: resolve(repository),
      env: objectEnvironment(),
      timeoutMs: Math.min(30_000, remaining),
      maxOutputBytes: maximum * 2,
    });
    if (result.exitCode !== 0 || result.timedOut || result.stdout.startsWith("[output truncated"))
      throw new Error("pinned LFS batch object read failed or exceeded its bound");
    const values = JSON.parse(result.stdout) as Array<[string, string]>;
    if (values.length !== batch.length) throw new Error("incomplete pinned LFS batch");
    for (const [index, value] of values.entries()) {
      const expected = batch[index]!;
      const bytes = Buffer.from(value[1], "base64");
      if (
        value[0] !== expected.oid ||
        bytes.length !== expected.size ||
        createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !==
          expected.oid
      )
        throw new Error("pinned LFS batch identity differs");
      blobs.set(expected.oid, bytes);
    }
  }
  return blobs;
}

/** Exact committed objects only. Working-tree attributes, hooks and configured
 * filters cannot redefine either the pinned identity or the LFS pointer bytes. */
export async function inspectPinnedLfs(
  repository: string,
  baseSha: string,
  options: PinnedLfsInspectionOptions = {},
): Promise<PinnedLfsFacts> {
  if (!/^[0-9a-f]{40}$/.test(baseSha)) throw new Error("invalid LFS base SHA");
  if (
    (
      await git(repository, ["rev-parse", "--verify", `${baseSha}^{commit}`], undefined, options)
    ).trim() !== baseSha
  )
    throw new Error("LFS base is not the exact requested commit");
  const records = (
    await git(repository, ["ls-tree", "-r", "-l", "-z", baseSha], undefined, options)
  ).split("\0");
  if (records.pop() !== "" || records.length > 10_000)
    throw new Error("LFS source inventory is incomplete or exceeds its bound");
  const assets: PinnedLfsAsset[] = [];
  let attributes = false;
  const entries: Array<{
    mode: "100644" | "100755";
    oid: string;
    path: string;
    size: number;
    isAttributes: boolean;
  }> = [];
  for (const record of records) {
    const match =
      /^(100644|100755|120000|160000) (blob|commit) ([0-9a-f]{40}) +([0-9]+|-)\t([\s\S]+)$/.exec(
        record,
      );
    if (!match) throw new Error("invalid pinned LFS tree entry");
    const [, mode, kind, oid, byteSize, path] = match;
    if (kind !== "blob" || (mode !== "100644" && mode !== "100755")) continue;
    if (!safePath(path!)) throw new Error("unsafe path in pinned LFS source inventory");
    const size = Number(byteSize);
    const isAttributes = path!.split("/").at(-1) === ".gitattributes";
    if (size >= 1024 && !isAttributes) continue;
    if (isAttributes && size > 256 * 1024)
      throw new Error("pinned LFS attributes exceed byte bound");
    entries.push({ mode, oid: oid!, path: path!, size, isAttributes });
  }
  const blobs = await readBlobs(repository, entries, options);
  for (const entry of entries) {
    const bytes = blobs.get(entry.oid)!;
    if (
      entry.isAttributes &&
      /^\s*[^#\n].*(?:^|\s)filter=lfs(?:\s|$)/m.test(bytes.toString("utf8"))
    )
      attributes = true;
    const pointer = parseLfsPointer(bytes);
    if (pointer)
      assets.push({ path: entry.path, ...pointer, pointerBlobOid: entry.oid, mode: entry.mode });
    if (assets.length > MAX_LFS_ASSETS) throw new Error("LFS asset inventory exceeds its bound");
  }
  return normalizePinnedLfsFacts({
    baseSha,
    assets,
    attributes,
    requiredTools: assets.length || attributes ? ["git-lfs"] : [],
  });
}

async function requireTool(): Promise<void> {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    const candidate = join(directory, "git-lfs");
    try {
      await access(candidate, constants.X_OK);
      const resolved = await realpath(candidate);
      if ((await lstat(resolved)).isFile()) return;
    } catch {
      /* Keep looking; never execute an untrusted repository alias. */
    }
  }
  throw new Error(
    "pinned repository requires git-lfs; install Git LFS on this execution host before starting a model",
  );
}

async function commonDirectory(repository: string): Promise<string> {
  const path = (
    await git(repository, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
  ).trim();
  if (!isAbsolute(path)) throw new Error("LFS common Git directory is not absolute");
  return realpath(path);
}

async function regularPath(root: string, path: string): Promise<string> {
  if (!safePath(path)) throw new Error("unsafe LFS object or destination path");
  let current = root;
  const parts = path.split("/");
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const info = await lstat(current);
    if (
      info.isSymbolicLink() ||
      (index === parts.length - 1 ? !info.isFile() : !info.isDirectory())
    )
      throw new Error(
        "LFS object or destination must use regular files and non-symlink directories",
      );
  }
  return current;
}

async function verifyObject(path: string, asset: PinnedLfsAsset): Promise<void> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size !== asset.size)
      throw new Error("LFS cache object size mismatch");
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(64 * 1024);
    let size = 0;
    while (size <= asset.size) {
      const { bytesRead } = await file.read(
        buffer,
        0,
        Math.min(buffer.length, asset.size + 1 - size),
        size,
      );
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
      size += bytesRead;
    }
    const after = await file.stat();
    if (
      size !== asset.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      hash.digest("hex") !== asset.oid
    )
      throw new Error("LFS cache object digest mismatch or changed while reading");
  } finally {
    await file.close();
  }
}

async function cachedObject(common: string, asset: PinnedLfsAsset): Promise<string> {
  try {
    return await regularPath(
      common,
      `lfs/objects/${asset.oid.slice(0, 2)}/${asset.oid.slice(2, 4)}/${asset.oid}`,
    );
  } catch (cause) {
    throw new Error(
      `required LFS object ${asset.oid} is missing or unsafe in the standard local cache; fetch it with your repository's authorized LFS credentials before starting Factory (custom storage is not resolved automatically)`,
      { cause },
    );
  }
}

export async function assertLocalLfsAvailable(
  repository: string,
  baseSha: string,
): Promise<PinnedLfsFacts> {
  const facts = await inspectPinnedLfs(repository, baseSha);
  if (!facts.requiredTools.length) return facts;
  await requireTool();
  const common = await commonDirectory(repository);
  for (const asset of facts.assets) await verifyObject(await cachedObject(common, asset), asset);
  return facts;
}

/** Caller owns a pinned materialization. Hydrate verified local bytes only and
 * leave its pointer index intact. No network, hooks, filters, or config writes.
 * This is a trusted-host workspace boundary, not a hostile same-user FS sandbox. */
export async function materializeLocalLfsAssets(
  repository: string,
  destination: string,
  baseSha: string,
): Promise<PinnedLfsFacts> {
  const facts = await assertLocalLfsAvailable(repository, baseSha);
  if (!facts.assets.length) return facts;
  const common = await commonDirectory(repository);
  const root = await realpath(destination);
  if (root === (await realpath(repository)))
    throw new Error("LFS hydration requires a separate owned source materialization");
  for (const asset of facts.assets) {
    const target = await regularPath(root, asset.path);
    const pointer = await open(
      target,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const before = await pointer.stat();
    try {
      if (!before.isFile() || before.size >= 1024)
        throw new Error("LFS destination is no longer the pinned pointer");
      const buffer = Buffer.alloc(1024);
      let size = 0;
      while (size < buffer.length) {
        const { bytesRead } = await pointer.read(buffer, size, buffer.length - size, size);
        if (!bytesRead) break;
        size += bytesRead;
      }
      if (size !== before.size || size >= 1024)
        throw new Error("LFS destination changed during bounded pointer read");
      const bytes = buffer.subarray(0, size);
      const oid = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
      if (oid !== asset.pointerBlobOid)
        throw new Error("LFS destination differs from the pinned pointer");
    } finally {
      await pointer.close();
    }
    const source = await open(
      await cachedObject(common, asset),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const temporary = join(dirname(target), `.factory-lfs-${randomUUID()}`);
    let created = false;
    try {
      const output = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      created = true;
      try {
        const hash = createHash("sha256");
        const buffer = Buffer.alloc(64 * 1024);
        let size = 0;
        if (!(await source.stat()).isFile()) throw new Error("LFS cache object is not regular");
        while (size <= asset.size) {
          const { bytesRead } = await source.read(
            buffer,
            0,
            Math.min(buffer.length, asset.size + 1 - size),
            size,
          );
          if (!bytesRead) break;
          hash.update(buffer.subarray(0, bytesRead));
          let offset = 0;
          while (offset < bytesRead) {
            const { bytesWritten } = await output.write(
              buffer,
              offset,
              bytesRead - offset,
              size + offset,
            );
            if (!bytesWritten) throw new Error("LFS hydration write made no progress");
            offset += bytesWritten;
          }
          size += bytesRead;
        }
        if (size !== asset.size || hash.digest("hex") !== asset.oid)
          throw new Error("LFS object changed during hydration");
        await output.chmod(asset.mode === "100755" ? 0o755 : 0o644);
        await output.sync();
      } finally {
        await output.close();
      }
      const current = await lstat(target);
      if (
        !current.isFile() ||
        current.dev !== before.dev ||
        current.ino !== before.ino ||
        current.size !== before.size ||
        current.mtimeMs !== before.mtimeMs ||
        current.ctimeMs !== before.ctimeMs
      )
        throw new Error("LFS destination changed during hydration");
      await rename(temporary, target);
      created = false;
    } finally {
      await source.close();
      if (created) await unlink(temporary);
    }
  }
  return facts;
}
