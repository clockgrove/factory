/**
 * Measuring what a sandboxed run wrote, off the event loop: sandbox.ts runs
 * this module in a worker thread, whose synchronous walk is several times
 * faster than an asynchronous one and leaves the controller responsive.
 */
import { type Dir, lstatSync, opendirSync } from "node:fs";
import { join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";

export interface DiskUse {
  bytes: number;
  entries: number;
}

/**
 * What a file takes on disk, by lstat: its apparent size, which Git hashes
 * and a sparse file claims, or its allocated blocks, which preallocation
 * (`fallocate --keep-size`) takes beyond that size, whichever is larger.
 */
export const diskBytes = (entry: { size: number; blocks: number }) =>
  Math.max(entry.size, entry.blocks * 512);

/**
 * Disk bytes and entries under `root`, never following a link and skipping
 * `skip`; it stops once more than `limit` entries are counted. A directory
 * it cannot read is refused, since what it holds cannot be counted.
 */
export function diskUseSync(
  root: string,
  limit: number,
  skip?: string,
): DiskUse {
  const use = { bytes: 0, entries: 0 };
  const pending = [root];
  while (pending.length && use.entries <= limit) {
    const directory = pending.pop()!;
    const unreadable = () =>
      new Error(`${directory} cannot be read to measure its disk use`);
    let entries: Dir;
    try {
      entries = opendirSync(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw unreadable();
    }
    // Read one entry at a time, so a huge directory stops at the limit.
    try {
      for (;;) {
        let name: string | undefined;
        try {
          name = entries.readSync()?.name;
        } catch {
          throw unreadable();
        }
        if (name === undefined) break;
        const path = join(directory, name);
        if (path === skip) continue;
        let entry: ReturnType<typeof lstatSync>;
        try {
          entry = lstatSync(path, { throwIfNoEntry: false });
        } catch {
          throw unreadable();
        }
        if (!entry) continue;
        use.entries += 1;
        use.bytes += diskBytes(entry);
        if (use.entries > limit) return use;
        if (entry.isDirectory()) pending.push(path);
      }
    } finally {
      entries.closeSync();
    }
  }
  return use;
}

const request = (workerData as { diskUse?: Parameters<typeof diskUseSync> })
  ?.diskUse;
if (parentPort && request)
  try {
    parentPort.postMessage({ use: diskUseSync(...request) });
  } catch (error) {
    parentPort.postMessage({
      error: error instanceof Error ? error.message : String(error),
    });
  }
