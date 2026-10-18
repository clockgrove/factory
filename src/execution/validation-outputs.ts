import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { ownsPath } from "../ownership.js";
import { pinnedGitEnvironment, pinnedGitRaw } from "../process.js";
import { privateStagingPath } from "./local.js";

/**
 * Bounds on the produced files one Validate run returns: enough for actual
 * values a check writes (goldens, snapshots, hashes), never a build tree.
 */
export const maxReturnedOutputFiles = 64;
export const maxReturnedOutputBytes = 8 * 1024 * 1024;
/** Report lines per category; the rest are counted. */
const maxListedPaths = 16;

/** One worker session's copy-back state across its Validate runs. */
export interface ValidationOutputs {
  ownedPaths: readonly string[];
  /** Selected LFS destinations: hydrated by Factory, never produced. */
  excluded: ReadonlySet<string>;
  /** Path to the SHA-256 of the bytes Factory last wrote there. */
  delivered: Map<string, string>;
}

const sha256 = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function safeRelative(path: string): boolean {
  const parts = path.split("/");
  return (
    path.length > 0 &&
    !path.startsWith("/") &&
    parts.every((part) => part !== "" && part !== "." && part !== "..") &&
    !parts.includes(".git") &&
    !privateStagingPath(path)
  );
}

/** Which paths the worker's checkout ignores now; tracked paths never are. */
function ignoredInWorktree(
  worktree: string,
  paths: readonly string[],
): Set<string> {
  if (!paths.length) return new Set();
  const env = pinnedGitEnvironment();
  // check-ignore accepts literal filenames, not pathspecs; that switch is unsupported.
  delete env.GIT_LITERAL_PATHSPECS;
  const result = spawnSync(
    "git",
    ["-C", worktree, "check-ignore", "-z", "--stdin"],
    { env, input: `${paths.join("\0")}\0`, maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.error) throw result.error;
  if (result.status === 1) return new Set();
  if (result.status !== 0)
    throw new Error("Cannot verify which produced files the checkout ignores");
  return new Set(result.stdout.toString("utf8").split("\0").filter(Boolean));
}

/** Create missing parents as plain directories; refuse links and files on the way. */
function plainParent(worktree: string, path: string): boolean {
  let current = worktree;
  for (const part of dirname(path).split("/")) {
    if (part === ".") break;
    current = join(current, part);
    try {
      const entry = lstatSync(current);
      if (!entry.isDirectory() || entry.isSymbolicLink()) return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
      mkdirSync(current);
    }
  }
  return true;
}

/** A regular file's bytes, never through a link, within the remaining budget. */
function readProduced(
  root: string,
  path: string,
  budget: number,
): Buffer | "not a regular file" | number {
  const source = join(root, path);
  if (!inside(root, realpathSync(dirname(source)))) return "not a regular file";
  let fd: number;
  try {
    fd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return "not a regular file";
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return "not a regular file";
    if (stat.size > budget) return stat.size;
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

function listed(lines: string[]): string[] {
  return lines.length <= maxListedPaths
    ? lines
    : [
        ...lines.slice(0, maxListedPaths),
        `- and ${lines.length - maxListedPaths} more`,
      ];
}

/**
 * After a Validate run settles, return the files its commands produced under
 * the Work Item's owned paths from the validation copy to the worker's
 * checkout, which the worker otherwise cannot read. Only regular files that
 * the worker's checkout ignores are copied, so a copy never enters the
 * result tree; a file there is created, or refreshed only while it still
 * holds bytes Factory wrote, so the worker's own edits are never
 * overwritten. Tracked or unignored changes are reported, not copied. The
 * validation copy is only read. Returns the report for the tool result, or
 * "" when the commands produced nothing under owned paths. Never throws: a
 * failure is reported and leaves the validation result unchanged.
 */
export function returnProducedFiles(
  validationCopy: string,
  worktree: string,
  outputs: ValidationOutputs,
): string {
  try {
    return copyProduced(validationCopy, worktree, outputs);
  } catch (error) {
    return `Files the commands produced under your owned paths could not be returned: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function copyProduced(
  validationCopy: string,
  worktree: string,
  outputs: ValidationOutputs,
): string {
  const scopes = [...outputs.ownedPaths];
  if (!scopes.length) return "";
  // Pinned Git pathspecs are literal. `matching` lists an ignored directory
  // (a dependency tree or build cache) as one entry, never its contents.
  const fields = pinnedGitRaw(
    validationCopy,
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--ignored=matching",
    "--",
    ...scopes,
  )
    .toString("utf8")
    .split("\0");
  const candidates: string[] = [];
  const directories: string[] = [];
  const changed: string[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]!;
    if (!field) continue;
    const code = field.slice(0, 2);
    const path = field.slice(3);
    if (code[0] === "R" || code[0] === "C") index += 1;
    const plain = path.endsWith("/") ? path.slice(0, -1) : path;
    if (
      !safeRelative(plain) ||
      !ownsPath(path, scopes) ||
      outputs.excluded.has(plain)
    )
      continue;
    if (code !== "!!") changed.push(path);
    else if (path.endsWith("/")) directories.push(path);
    else candidates.push(path);
  }
  const ignored = ignoredInWorktree(worktree, candidates);
  const root = realpathSync(validationCopy);
  const returned: string[] = [];
  const skipped: string[] = [];
  const omitted: string[] = [];
  const produced = new Set<string>();
  let bytes = 0;
  for (const path of candidates) {
    produced.add(path);
    if (!ignored.has(path)) {
      changed.push(path);
      continue;
    }
    if (returned.length >= maxReturnedOutputFiles) {
      omitted.push(`- ${path}`);
      continue;
    }
    const content = readProduced(root, path, maxReturnedOutputBytes - bytes);
    if (typeof content === "string") {
      skipped.push(`- ${path}: ${content}`);
      continue;
    }
    if (typeof content === "number") {
      omitted.push(`- ${path} (${content} bytes)`);
      continue;
    }
    const digest = sha256(content);
    const destination = join(worktree, path);
    if (!plainParent(worktree, path)) {
      skipped.push(`- ${path}: a parent in your checkout is not a directory`);
      continue;
    }
    let current: ReturnType<typeof lstatSync> | undefined;
    try {
      current = lstatSync(destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (!current) {
      // Exclusive create: a file the worker wrote meanwhile is never replaced.
      try {
        writeFileSync(destination, content, { flag: "wx" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        skipped.push(`- ${path}: your checkout has this file; kept yours`);
        continue;
      }
    } else if (
      current.isFile() &&
      !current.isSymbolicLink() &&
      outputs.delivered.has(path) &&
      sha256(readFileSync(destination)) === outputs.delivered.get(path)
    ) {
      // Still exactly what an earlier run returned: refresh it.
      const fd = openSync(
        destination,
        constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW,
      );
      try {
        writeFileSync(fd, content);
      } finally {
        closeSync(fd);
      }
    } else {
      skipped.push(
        `- ${path}: your checkout has a different version of this file; kept yours`,
      );
      continue;
    }
    outputs.delivered.set(path, digest);
    bytes += content.length;
    returned.push(`- ${path} (${content.length} bytes)`);
  }
  // An earlier copy this run did not produce stays until the worker changes it.
  const stale = [...outputs.delivered].flatMap(([path, digest]) => {
    if (produced.has(path)) return [];
    try {
      const entry = lstatSync(join(worktree, path));
      if (
        entry.isFile() &&
        !entry.isSymbolicLink() &&
        sha256(readFileSync(join(worktree, path))) === digest
      )
        return [`- ${path}`];
    } catch {
      // Gone: nothing stale remains.
    }
    outputs.delivered.delete(path);
    return [];
  });
  const sections = [returned, skipped, omitted, changed, directories, stale];
  if (sections.every((section) => !section.length)) return "";
  const parts = ["Files the commands produced under your owned paths:"];
  if (returned.length)
    parts.push(
      `Returned to your checkout at the same paths (ignored by Git, so never part of your result):\n${listed(returned).join("\n")}`,
    );
  if (skipped.length)
    parts.push(`Not returned:\n${listed(skipped).join("\n")}`);
  if (omitted.length)
    parts.push(
      `Not returned, over the bound of ${maxReturnedOutputFiles} files and ${maxReturnedOutputBytes / (1024 * 1024)} MiB per run:\n${listed(omitted).join("\n")}`,
    );
  if (changed.length)
    parts.push(
      `Changed in the validation copy only, not returned because Git tracks them or does not ignore them, so a copy would change your result:\n${listed(changed.map((path) => `- ${path}`)).join("\n")}`,
    );
  if (directories.length)
    parts.push(
      `Ignored directories, contents not returned:\n${listed(directories.map((path) => `- ${path}`)).join("\n")}`,
    );
  if (stale.length)
    parts.push(
      `Returned by an earlier run and not produced by this one, so possibly stale:\n${listed(stale).join("\n")}`,
    );
  return parts.join("\n");
}
