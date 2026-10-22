import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  mkdirSync,
  openSync,
  realpathSync,
} from "node:fs";
import { chmod, open, readdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

/** Where one installation keeps its files. Nothing here is inside the target. */
export interface Paths {
  readonly root: string;
  readonly objectives: string;
  readonly requests: string;
  readonly logs: string;
  /** Linux abstract socket name: the kernel frees it when the process dies. */
  readonly lockName: string;
}

export function installationPaths(
  repository: string,
  stateRoot = process.env.FACTORY_STATE_DIR ??
    join(homedir(), ".local", "state", "factory"),
): Paths {
  // Lock on the real directory, so two spellings of one path share one lock.
  const named = resolve(
    join(stateRoot, repository.toLowerCase().replace("/", "__")),
  );
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
