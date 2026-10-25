/**
 * Codex's standard error, for a failed call's error message. The launcher
 * appends it to a file in the call's Codex home (codex.ts codexStderr), so
 * the SDK, which would otherwise carry it in its error, has none. This
 * reads the end of what came after the call began, once the call has
 * stopped. It only observes: the outcome comes from structured facts
 * (codex.ts codexFailure).
 */
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { errorMessage } from "../text.js";

/** The most of a call's standard error kept for its error message: its end. */
const TAIL_MAX = 16 * 1024;

/** A call's standard error file, read from where the call began. */
export class CodexStderr {
  private readonly from: number;

  constructor(readonly file: string) {
    this.from = sizeOf(file);
  }

  /** The non-blank lines written since the call began, their last TAIL_MAX bytes; empty when none. */
  tail(): string {
    const size = sizeOf(this.file);
    const start = Math.max(this.from, size - TAIL_MAX);
    if (size <= start) return "";
    let fd: number | undefined;
    try {
      fd = openSync(this.file, "r");
      const buffer = Buffer.alloc(size - start);
      const read = readSync(fd, buffer, 0, buffer.length, start);
      return buffer
        .subarray(0, read)
        .toString("utf8")
        .split("\n")
        .filter((line) => line.trim())
        .join("\n");
    } catch {
      return "";
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
}

/** A failed codex run's error message, with its standard error's tail when there is one. */
export function withStderr(error: unknown, stderr: CodexStderr): string {
  const tail = stderr.tail();
  return tail ? `${errorMessage(error)}\n${tail}` : errorMessage(error);
}

function sizeOf(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}
