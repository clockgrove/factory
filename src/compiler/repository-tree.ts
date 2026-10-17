import { execFileSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { pinnedGit, pinnedGitEnvironment } from "../process.js";

/**
 * The planner and graph reviewer read the repository at the exact base
 * commit. Factory exports its tracked regular files into a private read-only
 * directory (no Git metadata, no untracked or ignored files, no network) and
 * renders a compact path map for orientation. Both are pure functions of the
 * base commit, so a recovered request renders the same bytes.
 */
export const REPOSITORY_DIRECTORY = "repository";

/** Larger blobs stay listed in the map but are not exported. */
const MAX_FILE_BYTES = 1_048_576;
/** Total exported bytes; later paths past the bound stay listed only. */
const MAX_TREE_BYTES = 67_108_864;
/** Rendered map bound; the remainder is counted, not listed. */
const MAX_MAP_BYTES = 49_152;

interface TreeEntry {
  path: string;
  mode: string;
  type: string;
  sha: string;
  size: number;
  exported: boolean;
  note?: string;
}

function treeEntries(checkout: string, baseSha: string): TreeEntry[] {
  if (!/^[a-f0-9]{40,64}$/.test(baseSha))
    throw new Error("Repository tree requires an exact base commit");
  let total = 0;
  return execFileSync(
    "git",
    ["-C", checkout, "ls-tree", "-rzl", "--full-tree", baseSha],
    {
      env: pinnedGitEnvironment(),
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    },
  )
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf("\t");
      const [mode, type, sha, size] = line.slice(0, tab).trim().split(/\s+/);
      const entry: TreeEntry = {
        path: line.slice(tab + 1),
        mode: mode!,
        type: type!,
        sha: sha!,
        size: type === "blob" ? Number(size) : 0,
        exported: false,
      };
      if (type === "commit") entry.note = "submodule, not exported";
      else if (mode === "120000") entry.note = "symlink, not exported";
      else if (entry.size > MAX_FILE_BYTES)
        entry.note = "over 1 MiB, not exported";
      else if (total + entry.size > MAX_TREE_BYTES)
        entry.note = "past the 64 MiB export bound, not exported";
      else {
        entry.exported = true;
        total += entry.size;
      }
      return entry;
    });
}

/** Deterministic orientation text: every tracked path with its byte size, bounded. */
export function repositoryMap(checkout: string, baseSha: string): string {
  const entries = treeEntries(checkout, baseSha);
  const treeSha = pinnedGit(checkout, "rev-parse", `${baseSha}^{tree}`);
  const exported = entries.filter((entry) => entry.exported);
  const header = `Repository map at base ${baseSha} (tree ${treeSha}): ${entries.length} tracked entries, ${entries.reduce((sum, entry) => sum + entry.size, 0)} bytes; ${exported.length} files (${exported.reduce((sum, entry) => sum + entry.size, 0)} bytes) are exported for reading. One line per path: path, tab, bytes, then a note when the file is not exported.\n`;
  const lines: string[] = [];
  let bytes = Buffer.byteLength(header) + 256;
  for (const entry of entries) {
    const line = `${entry.path}\t${entry.size}${entry.note ? `\t${entry.note}` : ""}\n`;
    bytes += Buffer.byteLength(line);
    if (bytes > MAX_MAP_BYTES) break;
    lines.push(line);
  }
  const omitted = entries.length - lines.length;
  return `${header}${lines.join("")}${omitted ? `... ${omitted} more paths are not listed (map bound ${MAX_MAP_BYTES} bytes); find them with your read tools.\n` : ""}`;
}

/**
 * Write the exported files of the base tree under `parent/repository`.
 * An existing directory is the same immutable export and is kept.
 */
export function writeRepositoryTree(
  checkout: string,
  baseSha: string,
  parent: string,
): void {
  const root = join(resolve(parent), REPOSITORY_DIRECTORY);
  const existing = lstatSync(root, { throwIfNoEntry: false });
  if (existing) {
    if (!existing.isDirectory() || existing.isSymbolicLink())
      throw new Error("Repository read directory is not an owned directory");
    return;
  }
  const files = treeEntries(checkout, baseSha).filter(
    (entry) => entry.exported,
  );
  const output = files.length
    ? execFileSync("git", ["-C", checkout, "cat-file", "--batch"], {
        env: pinnedGitEnvironment(),
        input: files.map((entry) => `${entry.sha}\n`).join(""),
        maxBuffer:
          files.reduce((sum, entry) => sum + entry.size, 0) +
          files.length * 128 +
          65_536,
        stdio: ["pipe", "pipe", "pipe"],
      })
    : Buffer.alloc(0);
  // Write into a private staging name, then publish the complete tree once.
  const staging = `${root}.partial`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { mode: 0o700 });
  let offset = 0;
  for (const entry of files) {
    const newline = output.indexOf(10, offset);
    const header = output.subarray(offset, newline).toString("utf8");
    if (header !== `${entry.sha} blob ${entry.size}`)
      throw new Error("Repository export differs from the base tree");
    const body = output.subarray(newline + 1, newline + 1 + entry.size);
    offset = newline + 1 + entry.size + 1;
    const path = resolve(staging, entry.path);
    if (!path.startsWith(`${staging}${sep}`))
      throw new Error("Repository path escapes its read directory");
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, body, { flag: "wx", mode: 0o444 });
  }
  renameSync(staging, root);
}
