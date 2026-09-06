import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { sanitizedWorkerEnvironment } from "../runtime/process-group.js";

const execute = promisify(execFile);
const MAX_FILES = 5000;
const MAX_BLOB_BYTES = 100 * 1024 * 1024;
const MAX_TREE_BYTES = 256 * 1024 * 1024;
const options = ["--no-optional-locks", "--no-replace-objects", "-c", "core.hooksPath=/dev/null",
  "-c", "core.fsmonitor=false", "-c", "gc.auto=0", "-c", "maintenance.auto=false", "-c", "credential.helper="];

/** Materialize raw exact Git blobs, never checkout hooks, filters, package commands or
 * repository executables. The separate clean Git config gives read-only management an
 * exact index/HEAD without inheriting source repository settings or credentials. */
export async function materializePinnedCompilationTree(repository: string, baseSha: string,
  input: { purpose?: "compilation" | "worktree" } = {}) {
  if (!/^[a-f0-9]{40}$/.test(baseSha)) throw new Error("invalid compilation base SHA");
  const deadline = Date.now() + 120_000;
  const env = sanitizedWorkerEnvironment(process.env);
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1", GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0", GIT_LFS_SKIP_SMUDGE: "1" });
  const git = async (cwd: string, args: string[], maxBuffer = 4 * 1024 * 1024, input?: string) => {
    const timeout = deadline - Date.now();
    if (timeout <= 0) throw new Error("pinned compilation preparation deadline exceeded");
    try {
      const pending = execute("git", [...options, ...args], { cwd, env, encoding: "buffer", maxBuffer, timeout });
      if (input !== undefined) pending.child.stdin?.end(input);
      const result = await pending;
      return result.stdout;
    } catch {
      throw new Error("pinned compilation Git object read failed");
    }
  };
  if ((await git(repository, ["rev-parse", "--verify", `${baseSha}^{commit}`])).toString("utf8").trim() !== baseSha)
    throw new Error("compilation base did not resolve exactly");
  const listing = await git(repository, ["ls-tree", "-r", "-l", "-z", "--full-tree", baseSha]);
  const entries = new TextDecoder("utf-8", { fatal: true }).decode(listing).split("\0").filter(Boolean);
  if (entries.length > MAX_FILES) throw new Error("pinned compilation tree exceeds 5000 files");
  let bytes = 0;
  const objectsToRead = entries.map((entry) => {
    const match = /^(100644|100755) blob ([a-f0-9]{40}) +([0-9]+)\t(.+)$/.exec(entry);
    if (!match) throw new Error("pinned compilation tree contains an unsupported path or Git entry mode");
    const mode = match[1]!, oid = match[2]!, rawSize = match[3]!, path = match[4]!;
    if (path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git") || /[\u0000-\u001f\u007f]/.test(path))
      throw new Error("pinned compilation tree path is unsafe");
    const size = Number(rawSize);
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_BLOB_BYTES || bytes + size > MAX_TREE_BYTES)
      throw new Error("pinned compilation tree exceeds raw blob or aggregate byte limits");
    bytes += size;
    return { mode, oid, size, path };
  });
  // A single bounded batch reads exactly the listed objects; no lazy fetch,
  // filter conversion or process-per-file overhead is permitted.
  const batch = objectsToRead.length ? await git(repository, ["cat-file", "--batch"],
    MAX_TREE_BYTES + MAX_FILES * 128, objectsToRead.map(({ oid }) => `${oid}\n`).join("")) : Buffer.alloc(0);
  const root = await mkdtemp(join(tmpdir(), input.purpose === "worktree" ? "clockgrove-factory-worktree-" : "factory-compilation-tree-"));
  const checkout = input.purpose === "worktree" ? join(root, "worktree") : root;
  try {
    if (checkout !== root) await mkdir(checkout);
    const files: string[] = [];
    let cursor = 0;
    for (const { mode, oid, size, path } of objectsToRead) {
      if (Date.now() >= deadline) throw new Error("pinned compilation preparation deadline exceeded");
      const target = resolve(checkout, path);
      if (!target.startsWith(checkout + sep)) throw new Error("pinned compilation path escaped its owned directory");
      const headerEnd = batch.indexOf(10, cursor);
      if (headerEnd < cursor || headerEnd - cursor > 128 ||
        batch.subarray(cursor, headerEnd).toString("ascii") !== `${oid} blob ${size}`)
        throw new Error("pinned compilation batch object identity differs");
      cursor = headerEnd + 1;
      if (cursor + size >= batch.length || batch[cursor + size] !== 10)
        throw new Error("pinned compilation blob size changed");
      const blob = batch.subarray(cursor, cursor + size);
      cursor += size + 1;
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, blob, { flag: "wx", mode: mode === "100755" ? 0o700 : 0o600 });
      files.push(path);
    }
    if (cursor !== batch.length) throw new Error("pinned compilation batch contains unrequested bytes");
    await git(checkout, ["init", "--quiet", "--template="]);
    const objects = resolve(repository, (await git(repository, ["rev-parse", "--git-path", "objects"])).toString("utf8").trim());
    if (/[\r\n]/.test(objects)) throw new Error("unsafe compilation object-store path");
    await writeFile(join(checkout, ".git", "objects", "info", "alternates"), `${objects}\n`, { flag: "wx", mode: 0o600 });
    await git(checkout, ["read-tree", baseSha]);
    // read-tree does not populate worktree stat data. Refresh in this new
    // hook/filter-free configuration before hydration so immediate --index
    // application recognizes the exact raw files without a prior `git status`.
    await git(checkout, ["update-index", "--refresh"]);
    await git(checkout, ["update-ref", "--no-deref", "HEAD", baseSha]);
    return { path: checkout, root, files: files.sort(), baseSha, dispose: () => rm(root, { recursive: true, force: true }) };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
