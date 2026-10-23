import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { captureDir } from "./paths.js";

/**
 * A new run id: the start time, then the process id. Ids sort by start
 * time, contain no dot, and name a run's log file and capture directory.
 */
export function newRunId(at = new Date()): string {
  return `${at.toISOString().replace(/[:.]/g, "-")}-${process.pid}`;
}

/** The run a run-log file or capture directory belongs to: its name up to the first dot. */
export const runOfFile = (path: string): string =>
  basename(path).split(".")[0]!;

/**
 * Content capture (CORE.md#Content capture): off by default. Enabled, the
 * request and response bodies of each model call go to their own file,
 * redacted and cut to `maxBytesPerCall`, and the run log references it.
 */
export interface CaptureSettings {
  enabled: boolean;
  maxBytesPerCall: number;
}

export const CAPTURE_OFF: CaptureSettings = {
  enabled: false,
  maxBytesPerCall: 8 * 1024 * 1024,
};

/**
 * The key a model-usage event carries its bodies under. A symbol is never
 * serialized, so a body can't reach the run log; it survives the spreads
 * that add a step or hedge on the way to `RunLog.write`.
 */
export const CAPTURE = Symbol("capture");

export interface CaptureBody {
  request: string;
  response?: string;
}

/**
 * The run log: one append-only JSON-lines file per Objective per service
 * run, `logs/<issue>/<run id>.jsonl`, and with capture on its bodies under
 * `logs/<issue>/<run id>.captures/`. It records what happened for status,
 * diagnostics and analysis. It never drives progress, and losing it loses
 * no work.
 */
export class RunLog {
  private readonly files = new Map<number, string>();

  constructor(
    private readonly dir: string,
    readonly runId: string,
    private readonly capture: CaptureSettings = CAPTURE_OFF,
    private readonly secrets: readonly string[] = [],
  ) {}

  write(issue: number, event: Record<string, unknown>): void {
    try {
      const body = (event as { [CAPTURE]?: CaptureBody })[CAPTURE];
      const id = body && this.capture.enabled && this.captured(issue, body);
      appendFileSync(
        this.file(issue),
        `${JSON.stringify({ at: new Date().toISOString(), ...event, ...(id ? { capture: id } : {}) })}\n`,
      );
    } catch {
      // A full disk or a removed directory must not stop the run: the log only observes.
    }
  }

  /**
   * One call's bodies as `<id>.json`, 0600 in a 0700 directory: each body
   * redacted, then cut so the file stays within the bound. Its id, or
   * undefined when it couldn't be written.
   */
  private captured(issue: number, body: CaptureBody): string | undefined {
    try {
      const dir = join(this.dir, captureDir(issue, this.runId));
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const id = randomUUID();
      const half = Math.floor(this.capture.maxBytesPerCall / 2);
      const request = bounded(redact(body.request, this.secrets), half);
      const response =
        body.response === undefined
          ? undefined
          : bounded(redact(body.response, this.secrets), half);
      writeFileSync(
        join(dir, `${id}.json`),
        JSON.stringify({
          id,
          run: this.runId,
          request: request.text,
          ...(response ? { response: response.text } : {}),
          truncated: request.cut || Boolean(response?.cut),
        }),
        { mode: 0o600 },
      );
      return id;
    } catch {
      return undefined;
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

/** `text` within `bytes` of UTF-8, cut at a character boundary. */
function bounded(text: string, bytes: number): { text: string; cut: boolean } {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= bytes) return { text, cut: false };
  // A cut inside a character decodes to U+FFFD; drop it.
  return {
    text: buffer
      .subarray(0, bytes)
      .toString("utf8")
      .replace(/\uFFFD$/, ""),
    cut: true,
  };
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
    events.push(
      ...ofRun(file, parseLines(complete.toString("utf8"), start > 0)),
    );
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
    fresh.push(...ofRun(file, parseLines(complete.toString("utf8"))));
  }
  return fresh.sort((a, b) => a.at.localeCompare(b.at));
}

/** Each event marked with the run whose file it was read from. */
function ofRun(file: string, events: LogEvent[]): LogEvent[] {
  const run = runOfFile(file);
  for (const event of events) event.run ??= run;
  return events;
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

/** A run whose files changed this recently may still be written: rotation keeps it. */
const LIVE_MS = 10 * 60 * 1000;

/**
 * Keep the newest runs per Objective, then the newest runs overall within
 * the byte cap. A run is its log file and its capture directory, removed
 * together. Run ids sort by start time, so id order is age order. The
 * `active` run (the caller's own) and any run changed in the last 10
 * minutes (a `factory dream` call still running) are never removed; they
 * still count toward both bounds. Each removed run is first recorded in
 * its Objective's `rotated` file, so a reader can say how many runs it
 * no longer has (`rotatedRuns`).
 */
export function rotateLogs(
  dir: string,
  active?: string,
  retention = DEFAULT_RETENTION,
): void {
  const now = Date.now();
  const kept = (id: string, paths: string[]) =>
    id === active ||
    paths.some((path) => {
      try {
        return now - statSync(path).mtimeMs < LIVE_MS;
      } catch {
        return false;
      }
    });
  const runs: {
    paths: string[];
    id: string;
    bytes: number;
    issueDir: string;
  }[] = [];
  for (const issue of safeList(dir)) {
    const issueDir = join(dir, issue);
    const byRun = new Map<string, string[]>();
    for (const name of safeList(issueDir)) {
      if (name === ROTATED) continue;
      const id = runOfFile(name);
      byRun.set(id, [...(byRun.get(id) ?? []), join(issueDir, name)]);
    }
    const ids = [...byRun.keys()].sort();
    const excess = ids.length - retention.runsPerObjective;
    ids.forEach((id, i) => {
      const paths = byRun.get(id)!;
      if (i < excess && !kept(id, paths)) remove(issueDir, id, paths);
      else runs.push({ paths, id, bytes: paths.reduce(addSize, 0), issueDir });
    });
  }
  runs.sort((a, b) => (a.id < b.id ? 1 : -1));
  let total = 0;
  for (const run of runs) {
    total += run.bytes;
    if (total > retention.totalBytes && !kept(run.id, run.paths))
      remove(run.issueDir, run.id, run.paths);
  }
}

/** An Objective's record of the runs rotation removed: one JSON line each. */
const ROTATED = "rotated";

/** A run rotation removed: its id, and when its files were last written. */
export interface RotatedRun {
  run: string;
  lastAt: string;
}

/** Record the run in its Objective's `rotated` file, then remove its files. */
function remove(issueDir: string, run: string, paths: string[]): void {
  let last = 0;
  for (const path of paths)
    try {
      last = Math.max(last, statSync(path).mtimeMs);
    } catch {
      // Gone meanwhile.
    }
  const record: RotatedRun = { run, lastAt: new Date(last).toISOString() };
  try {
    appendFileSync(join(issueDir, ROTATED), `${JSON.stringify(record)}\n`);
  } catch {
    // Like a run-log line: losing the record must not stop housekeeping.
  }
  for (const path of paths) rmSync(path, { recursive: true, force: true });
}

/** The runs rotation removed from the Objective's run log, each once; a run still there is not one. */
export function rotatedRuns(dir: string, issue: number): RotatedRun[] {
  const issueDir = join(dir, String(issue));
  const present = new Set(logFiles(dir, issue).map(runOfFile));
  const file = join(issueDir, ROTATED);
  const found = new Map<string, RotatedRun>();
  const text = readFrom(file, 0, sizeOf(file)).toString("utf8");
  for (const line of text.split("\n")) {
    try {
      const { run, lastAt } = JSON.parse(line) as RotatedRun;
      if (typeof run === "string" && typeof lastAt === "string")
        if (!present.has(run)) found.set(run, { run, lastAt });
    } catch {
      // A torn line: skipped.
    }
  }
  return [...found.values()].sort((a, b) => a.run.localeCompare(b.run));
}

/** A file's size, or a capture directory's files' sizes. */
function addSize(sum: number, path: string): number {
  const own = sizeOf(path);
  try {
    if (statSync(path).isDirectory())
      return safeList(path).reduce(
        (inner, name) => inner + sizeOf(join(path, name)),
        sum,
      );
  } catch {
    // Gone meanwhile: counts nothing.
  }
  return sum + own;
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
