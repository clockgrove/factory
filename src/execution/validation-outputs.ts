import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { ownsPath } from "../ownership.js";
import { GitFailure, pinnedGitRawWith } from "../process.js";
import { type OpenParent, openParent } from "./directory-walk.js";
import { privateStagingPath } from "./local.js";

/**
 * Bounds on the produced files one Validate run returns: enough for actual
 * values a check writes (goldens, snapshots, hashes), never a build tree.
 */
export const maxReturnedOutputFiles = 64;
export const maxReturnedOutputBytes = 8 * 1024 * 1024;
/** Report lines per category; the rest are counted. */
const maxListedPaths = 16;
/** Each local Git listing is bounded; a stalled one is reported, not awaited. */
const gitTimeoutMs = 60_000;

/** Which produced files may come back from a worker's Validate runs. */
export interface ValidationOutputs {
  ownedPaths: readonly string[];
  /** Selected LFS destinations: hydrated by Factory, never produced. */
  excluded: ReadonlySet<string>;
}

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
  let output: Buffer;
  try {
    output = pinnedGitRawWith(
      worktree,
      {
        timeoutMs: gitTimeoutMs,
        input: `${paths.join("\0")}\0`,
        // check-ignore takes literal filenames and refuses the literal-pathspec switch.
        env: { GIT_LITERAL_PATHSPECS: "0" },
      },
      "check-ignore",
      "-z",
      "--stdin",
    );
  } catch (error) {
    // Exit 1: none of the paths is ignored.
    if (error instanceof GitFailure && error.status === 1) return new Set();
    throw error;
  }
  return new Set(output.toString("utf8").split("\0").filter(Boolean));
}

/**
 * Write one returned file in the worker's checkout: parents are walked by held
 * descriptor and created as plain directories, never through a link, and the
 * file itself is never a link or special file. Returns whether it replaced an
 * earlier copy, or why it was not written.
 */
function writeReturned(
  worktree: string,
  path: string,
  content: Buffer,
): { existed: boolean } | string {
  let parent: OpenParent;
  try {
    parent = openParent(worktree, path, true);
  } catch {
    return "a parent in your checkout is not a directory";
  }
  try {
    const destination = `${parent.anchor}/${parent.name}`;
    let existed = false;
    try {
      if (!lstatSync(destination).isFile())
        return "not a regular file in your checkout";
      existed = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    let fd: number;
    try {
      // Never through a link; never blocks on a special file.
      fd = openSync(
        destination,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_TRUNC |
          constants.O_NOFOLLOW |
          constants.O_NONBLOCK,
      );
    } catch {
      return "not a regular file in your checkout";
    }
    try {
      if (!fstatSync(fd).isFile()) return "not a regular file in your checkout";
      writeFileSync(fd, content);
    } finally {
      closeSync(fd);
    }
    return { existed };
  } finally {
    closeSync(parent.fd);
  }
}

/** A regular file's bytes, never through a link, within the remaining budget. */
function readProduced(
  root: string,
  path: string,
  budget: number,
): Buffer | string | number {
  const source = join(root, path);
  try {
    if (!inside(root, realpathSync(dirname(source))))
      return "its directory leaves the validation copy";
  } catch (error) {
    return `unreadable in the validation copy (${(error as NodeJS.ErrnoException).code ?? "error"})`;
  }
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
 * the worker's checkout ignores at copy time are copied, so `git add -A`
 * leaves them out of the result unless the ignore rules change. A file this
 * run produced replaces the worker's copy at that path: the worker never
 * authors ignored files, and a continuation or repair starts with the last
 * run's stale ones. Tracked or unignored changes are reported, not copied.
 * The validation copy is only read. Returns the report for the tool result, or
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
  const fields = pinnedGitRawWith(
    validationCopy,
    { timeoutMs: gitTimeoutMs },
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
  let bytes = 0;
  for (const path of candidates) {
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
    const written = writeReturned(worktree, path, content);
    if (typeof written === "string") {
      skipped.push(`- ${path}: ${written}`);
      continue;
    }
    bytes += content.length;
    returned.push(
      `- ${path} (${content.length} bytes${written.existed ? ", replaced the earlier copy" : ""})`,
    );
  }
  const sections = [returned, skipped, omitted, changed, directories];
  if (sections.every((section) => !section.length)) return "";
  const parts = ["Files the commands produced under your owned paths:"];
  if (returned.length)
    parts.push(
      `Returned to your checkout at the same paths (Git ignores them, so they stay out of your result unless the ignore rules change):\n${listed(returned).join("\n")}`,
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
  return parts.join("\n");
}
