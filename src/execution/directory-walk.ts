import {
  closeSync,
  constants,
  mkdirSync,
  openSync,
  realpathSync,
} from "node:fs";

const directoryFlags =
  constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

/** A parent directory held open by descriptor, and the entry to open in it. */
export interface OpenParent {
  fd: number;
  /** `${anchor}/${name}` names the final entry through the held descriptor. */
  anchor: string;
  name: string;
}

/**
 * Open the directory that holds `relative` (a normalized Git-relative path)
 * under `root`, one held descriptor per component, so no link on the way is
 * followed and a parent swapped for a link mid-walk cannot redirect the
 * caller outside `root`. With `create`, missing parents become plain
 * directories. The caller opens the final entry as `${anchor}/${name}` with
 * O_NOFOLLOW and closes `fd`. Linux only: it resolves through /proc/self/fd.
 */
export function openParent(
  root: string,
  relative: string,
  create: boolean,
): OpenParent {
  const parts = relative.split("/");
  const name = parts.pop()!;
  let fd = openSync(realpathSync(root), directoryFlags);
  try {
    for (const part of parts) {
      const next = `/proc/self/fd/${fd}/${part}`;
      let child: number;
      try {
        child = openSync(next, directoryFlags);
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
          child = openSync(next, directoryFlags);
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
