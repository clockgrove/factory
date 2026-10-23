import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";

/**
 * The run log: one append-only JSON-lines file per Objective per service
 * start. It records what happened for status, diagnostics and analysis. It
 * never drives progress, and losing it loses no work.
 */
export class RunLog {
  private readonly files = new Map<number, string>();

  constructor(
    private readonly dir: string,
    private readonly runId: string,
  ) {}

  write(issue: number, event: Record<string, unknown>): void {
    try {
      appendFileSync(
        this.file(issue),
        `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`,
      );
    } catch {
      // A full disk or a removed directory must not stop the run: the log only observes.
    }
  }

  private file(issue: number): string {
    let path = this.files.get(issue);
    if (!path) {
      const dir = join(this.dir, String(issue));
      mkdirSync(dir, { recursive: true });
      path = join(dir, `${this.runId}.jsonl`);
      this.files.set(issue, path);
    }
    return path;
  }
}

/** One run log event: when, and what (step, event, outcome, ...). */
export type LogEvent = { at: string } & Record<string, unknown>;

/** The run log files of one Objective, oldest run first. */
export function logFiles(dir: string, issue: number): string[] {
  const issueDir = join(dir, String(issue));
  return safeList(issueDir)
    .filter((name) => name.endsWith(".jsonl"))
    .sort()
    .map((name) => join(issueDir, name));
}

/**
 * The Objective's last `tail` events across its run logs, in time order,
 * and the byte offset each file was read to (the end of its last complete
 * line), so a follow carries on exactly there. Only the end of each file
 * is read, so the cost doesn't grow with history.
 */
export function readLog(
  dir: string,
  issue: number,
  tail: number,
): { events: LogEvent[]; ends: Map<string, number> } {
  const events: LogEvent[] = [];
  const ends = new Map<string, number>();
  const bytes = Math.max(64 * 1024, tail * 2048);
  for (const file of logFiles(dir, issue)) {
    const size = sizeOf(file);
    const start = Math.max(0, size - bytes);
    const complete = completeLines(readFrom(file, start, size));
    ends.set(file, start + complete.length);
    events.push(...parseLines(complete.toString("utf8"), start > 0));
  }
  return {
    events: events.sort((a, b) => a.at.localeCompare(b.at)).slice(-tail),
    ends,
  };
}

/**
 * The new complete lines of the Objective's run files since `offsets` (a
 * file not in it from its start), in time order; `offsets` moves past
 * them. A follow calls it with the offsets `readLog` returned.
 */
export function readNew(
  dir: string,
  issue: number,
  offsets: Map<string, number>,
): LogEvent[] {
  const fresh: LogEvent[] = [];
  for (const file of logFiles(dir, issue)) {
    const from = offsets.get(file) ?? 0;
    const complete = completeLines(readFrom(file, from, sizeOf(file)));
    if (!complete.length) continue;
    offsets.set(file, from + complete.length);
    fresh.push(...parseLines(complete.toString("utf8")));
  }
  return fresh.sort((a, b) => a.at.localeCompare(b.at));
}

/**
 * Call `poll` every `everyMs` until SIGINT or SIGTERM, or until it returns
 * a result (anything but undefined): a follow's loop. Returns that result,
 * undefined when interrupted.
 */
export async function untilInterrupted<T>(
  poll: () => T | undefined | Promise<T | undefined>,
  everyMs = 500,
): Promise<T | undefined> {
  let stop = false;
  const stopping = () => {
    stop = true;
  };
  process.once("SIGINT", stopping);
  process.once("SIGTERM", stopping);
  try {
    while (!stop) {
      await new Promise((resolve) => setTimeout(resolve, everyMs));
      if (stop) break;
      const result = await poll();
      if (result !== undefined) return result;
    }
    return undefined;
  } finally {
    process.off("SIGINT", stopping);
    process.off("SIGTERM", stopping);
  }
}

/** The issues with a run log directory, in number order (0, the service's, excluded). */
export function loggedIssues(dir: string): number[] {
  return safeList(dir)
    .map(Number)
    .filter((issue) => Number.isInteger(issue) && issue > 0)
    .sort((a, b) => a - b);
}

/** The bytes up to and including the last newline: the complete lines. */
export function completeLines(bytes: Buffer): Buffer {
  return bytes.subarray(0, bytes.lastIndexOf(10) + 1);
}

/** The bytes of `file` from `start` to `end`; empty when it can't be read. */
export function readFrom(file: string, start: number, end: number): Buffer {
  if (end <= start) return Buffer.alloc(0);
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const buffer = Buffer.alloc(end - start);
    const read = readSync(fd, buffer, 0, buffer.length, start);
    return buffer.subarray(0, read);
  } catch {
    return Buffer.alloc(0);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Complete JSON lines as events; with `partialFirst`, the first line was cut and is dropped. */
export function parseLines(text: string, partialFirst = false): LogEvent[] {
  const lines = text.split("\n");
  if (partialFirst) lines.shift();
  const events: LogEvent[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as LogEvent;
      if (typeof event.at === "string") events.push(event);
    } catch {
      // A line still being written, or a torn one: skipped.
    }
  }
  return events;
}

export interface Retention {
  runsPerObjective: number;
  totalBytes: number;
}

const DEFAULT_RETENTION: Retention = {
  runsPerObjective: 20,
  totalBytes: 2 * 1024 ** 3,
};

/**
 * Keep the newest runs per Objective, then the newest runs overall within
 * the byte cap. Run ids sort by start time, so name order is age order.
 */
export function rotateLogs(dir: string, retention = DEFAULT_RETENTION): void {
  const runs: { path: string; name: string; bytes: number }[] = [];
  for (const issue of safeList(dir)) {
    const issueDir = join(dir, issue);
    const names = safeList(issueDir).sort();
    const excess = names.length - retention.runsPerObjective;
    names.forEach((name, i) => {
      const path = join(issueDir, name);
      if (i < excess) rmSync(path, { recursive: true, force: true });
      else runs.push({ path, name, bytes: sizeOf(path) });
    });
  }
  runs.sort((a, b) => (a.name < b.name ? 1 : -1));
  let total = 0;
  for (const run of runs) {
    total += run.bytes;
    if (total > retention.totalBytes)
      rmSync(run.path, { recursive: true, force: true });
  }
}

function safeList(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

export function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** Tokens, bearer headers and the named secret values, line by line, as [REDACTED]. */
export function redact(value: string, secrets: readonly string[] = []): string {
  let result = value
    .replace(
      /\b(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}\b/g,
      "[REDACTED]",
    )
    .replace(/(Authorization:\s*Bearer\s+)\S+/gi, "$1[REDACTED]");
  for (const secret of secrets)
    for (const line of secret.split(/\r?\n/))
      if (line.length) result = result.split(line).join("[REDACTED]");
  return result;
}
