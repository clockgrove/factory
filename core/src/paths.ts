import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  read,
  readSync,
  realpathSync,
} from "node:fs";
import { chmod, open, readdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { errorMessage } from "./text.js";

/** Where one installation keeps its files. Nothing here is inside the target. */
export interface Paths {
  readonly root: string;
  readonly objectives: string;
  readonly requests: string;
  readonly logs: string;
  /** Linux abstract socket name: the kernel frees it when the process dies. */
  readonly lockName: string;
}

/** Where every installation's state lives: FACTORY_STATE_DIR, or under home. */
export function stateRoot(): string {
  return (
    process.env.FACTORY_STATE_DIR ??
    join(homedir(), ".local", "state", "factory")
  );
}

/** OWNER/NAME as GitHub allows it: never a path that leaves the state root. */
export function validRepository(repository: string): boolean {
  const match = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/.exec(repository);
  return !!match && match[2] !== "." && match[2] !== "..";
}

/** The installation's directory, created by neither this nor a reader. */
export function installationDir(repository: string): string {
  if (!validRepository(repository))
    throw new Error(
      `${JSON.stringify(repository)} is not a repository: give OWNER/NAME`,
    );
  return resolve(
    join(stateRoot(), repository.toLowerCase().replace("/", "__")),
  );
}

export function installationPaths(repository: string): Paths {
  // Lock on the real directory, so two spellings of one path share one lock.
  const named = installationDir(repository);
  mkdirSync(named, { recursive: true, mode: 0o700 });
  const root = realpathSync(named);
  const id = createHash("sha256").update(root).digest("hex").slice(0, 24);
  return {
    root,
    objectives: join(root, "objectives"),
    requests: join(root, "requests"),
    logs: join(root, "logs"),
    lockName: `\0factory-${id}`,
  };
}

/** A capture id: what `RunLog` names a capture file by (a UUID). */
export const CAPTURE_ID = /^[\w-]{1,128}$/;

/** A run's capture directory under the logs directory: `<issue>/<run id>.captures` (docs/reference/run-log.md#Content capture). */
export function captureDir(issue: number, run: string): string {
  return `${issue}/${run}.captures`;
}

/** A capture file under the logs directory, or undefined when `id` isn't a capture id. */
export function captureFile(
  issue: number,
  run: string,
  id: string,
): string | undefined {
  return CAPTURE_ID.test(id)
    ? `${captureDir(issue, run)}/${id}.json`
    : undefined;
}

/** `path` is `directory` or below it, compared after resolving both. */
export function within(path: string, directory: string): boolean {
  const root = resolve(directory);
  const candidate = resolve(path);
  return (
    candidate === root ||
    candidate.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)
  );
}

const DIRECTORY_FLAGS =
  constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

/**
 * The directory holding `relative` under `root`, opened one held descriptor
 * per component, so no link on the way is followed and a parent swapped for
 * a link mid-walk can't redirect outside `root`. With `create`, missing
 * parents become plain directories. Open `${anchor}/${name}` with
 * O_NOFOLLOW, then close `fd`. Linux only (/proc/self/fd).
 */
export function openParent(
  root: string,
  relative: string,
  create: boolean,
): { fd: number; anchor: string; name: string } {
  const parts = relative.split("/");
  const name = parts.pop() ?? "";
  let fd = openSync(realpathSync(root), DIRECTORY_FLAGS);
  try {
    for (const part of parts) {
      const next = `/proc/self/fd/${fd}/${part}`;
      let child: number;
      try {
        child = openSync(next, DIRECTORY_FLAGS);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" && !create)
          throw new Error(`${relative} does not exist`);
        if (code !== "ENOENT")
          throw new Error(
            `${relative} is not reached through real directories`,
          );
        try {
          mkdirSync(next);
        } catch (made) {
          if ((made as NodeJS.ErrnoException).code !== "EEXIST") throw made;
        }
        try {
          child = openSync(next, DIRECTORY_FLAGS);
        } catch {
          throw new Error(
            `${relative} is not reached through real directories`,
          );
        }
      }
      closeSync(fd);
      fd = child;
    }
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  return { fd, anchor: `/proc/self/fd/${fd}`, name };
}

/**
 * `rm -rf path`, also when a worker or a command left a directory without
 * owner permissions (chmod 000): on EACCES or EPERM every directory below
 * `path` is given u+rwx, opened without following links, and the removal
 * runs once more. A missing path is fine.
 */
export async function forceRemove(path: string): Promise<void> {
  try {
    await rm(path, { recursive: true, force: true });
    return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EACCES" && code !== "EPERM") throw error;
  }
  await grantOwner(path);
  await rm(path, { recursive: true, force: true });
}

/** Linux O_PATH: a handle on the inode itself, needing no permission on it. */
const O_PATH = 0o10000000;

/**
 * u+rwx on `path` and every directory below it; links and files are left
 * alone. Each directory is pinned by an O_PATH|O_NOFOLLOW descriptor and
 * changed through it, so a link swapped in is never followed.
 */
async function grantOwner(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(
      path,
      O_PATH | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
  } catch {
    return; // Not a directory (or a link to one): nothing to open up.
  }
  try {
    const pinned = `/proc/self/fd/${handle.fd}`;
    const { mode } = await stat(pinned);
    await chmod(pinned, (mode & 0o7777) | 0o700);
    for (const entry of await readdir(pinned, { withFileTypes: true }))
      if (entry.isDirectory()) await grantOwner(join(pinned, entry.name));
  } finally {
    await handle.close();
  }
}

/**
 * A file Factory refuses to read: missing, reached through a link, not a
 * regular file, over its byte bound, or changed while read. The message
 * names the path and, for size, the bound.
 */
export class ContainedError extends Error {}

/**
 * The regular file `relative` (`/`-separated) under `root`, opened
 * read-only: every directory on the way through openParent, the file with
 * O_NOFOLLOW, and the opened file must be the one lstat saw (same device
 * and inode). Returns its descriptor, which the caller closes, and size.
 */
function openContained(
  root: string,
  relative: string,
  maximum: number,
  allowEmpty: boolean,
): { fd: number; size: number } {
  if (
    relative.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new ContainedError(
      `${relative} is not a relative path inside its root`,
    );
  let parent: ReturnType<typeof openParent>;
  try {
    parent = openParent(root, relative, false);
  } catch (error) {
    throw new ContainedError(errorMessage(error));
  }
  try {
    const target = `${parent.anchor}/${parent.name}`;
    const seen = lstatSync(target, { throwIfNoEntry: false });
    if (!seen) throw new ContainedError(`${relative} does not exist`);
    if (!seen.isFile())
      throw new ContainedError(
        `${relative} is not a regular file reached without links`,
      );
    let fd: number;
    try {
      fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      throw new ContainedError(
        `${relative} could not be opened: ${errorMessage(error)}`,
      );
    }
    const opened = fstatSync(fd);
    const problem =
      !opened.isFile() || opened.dev !== seen.dev || opened.ino !== seen.ino
        ? `${relative} changed while it was opened`
        : opened.size > maximum
          ? `${relative} has ${opened.size} bytes, above its bound of ${maximum}`
          : opened.size === 0 && !allowEmpty
            ? `${relative} is empty`
            : undefined;
    if (problem) {
      closeSync(fd);
      throw new ContainedError(problem);
    }
    return { fd, size: opened.size };
  } finally {
    closeSync(parent.fd);
  }
}

/**
 * The bytes of the regular file `relative` under `root`, reached without
 * links (openContained), within `maximum` bytes and unchanged while read.
 */
export function readContained(
  root: string,
  relative: string,
  maximum: number,
  allowEmpty = false,
): Buffer {
  const { fd, size } = openContained(root, relative, maximum, allowEmpty);
  try {
    const bytes = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const count = readSync(fd, bytes, offset, size - offset, offset);
      if (!count) break;
      offset += count;
    }
    if (offset !== size || readSync(fd, Buffer.alloc(1), 0, 1, offset) !== 0)
      throw new ContainedError(`${relative} changed while it was read`);
    return bytes;
  } finally {
    closeSync(fd);
  }
}

const readAt = promisify(read);
const COPY_CHUNK = 1024 * 1024;

/**
 * Copy the regular file `relative` under `root`, reached without links
 * (openContained) and within `maximum` bytes, to the new file `to` (mode
 * 0600, never through a link), or with `replace` over the existing regular
 * file `to`. Returns the sha256 and size of exactly the bytes copied. A
 * failure removes a new `to`.
 */
export async function copyContained(
  root: string,
  relative: string,
  to: string,
  maximum: number,
  replace = false,
): Promise<{ sha256: string; bytes: number }> {
  const { fd, size } = openContained(root, relative, maximum, true);
  try {
    const output = await open(
      to,
      constants.O_WRONLY |
        constants.O_NOFOLLOW |
        (replace ? constants.O_TRUNC : constants.O_CREAT | constants.O_EXCL),
      0o600,
    );
    let copied = false;
    try {
      const hash = createHash("sha256");
      const buffer = Buffer.alloc(Math.min(COPY_CHUNK, Math.max(size, 1)));
      let offset = 0;
      for (;;) {
        const { bytesRead } = await readAt(
          fd,
          buffer,
          0,
          buffer.length,
          offset,
        );
        if (!bytesRead) break;
        offset += bytesRead;
        if (offset > size) break;
        const chunk = buffer.subarray(0, bytesRead);
        hash.update(chunk);
        await output.write(chunk);
      }
      if (offset !== size)
        throw new ContainedError(`${relative} changed while it was read`);
      copied = true;
      return { sha256: hash.digest("hex"), bytes: size };
    } finally {
      await output.close();
      if (!copied && !replace) await rm(to, { force: true });
    }
  } finally {
    closeSync(fd);
  }
}
