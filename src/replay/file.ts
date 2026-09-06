import { constants } from "node:fs";
import { open } from "node:fs/promises";

import {
  MAX_SUPPLIED_REPLAY_BYTES,
  parseSuppliedReplaySnapshots,
  SUPPLIED_REPLAY_ERROR,
} from "./supplied.js";

/** Read only an explicitly named regular file, with an allocation and read ceiling. */
export async function readSuppliedReplayFile(path: string, objective: number) {
  try {
    if (!path || path.length > 4096) throw new Error(SUPPLIED_REPLAY_ERROR);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_SUPPLIED_REPLAY_BYTES) {
        throw new Error(SUPPLIED_REPLAY_ERROR);
      }
      const bytes = Buffer.alloc(MAX_SUPPLIED_REPLAY_BYTES + 1);
      let total = 0;
      while (total < bytes.length) {
        const { bytesRead } = await handle.read(bytes, total, bytes.length - total, total);
        if (bytesRead === 0) break;
        total += bytesRead;
      }
      if (total > MAX_SUPPLIED_REPLAY_BYTES) throw new Error(SUPPLIED_REPLAY_ERROR);
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, total));
      return parseSuppliedReplaySnapshots(JSON.parse(text), objective);
    } finally {
      await handle.close();
    }
  } catch {
    throw new Error(SUPPLIED_REPLAY_ERROR);
  }
}
