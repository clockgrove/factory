import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { attemptDir, captureDir, readContained } from "./paths.js";

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
 * Content capture (docs/reference/run-log.md#Content capture): off by default. Enabled, the
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
  /** Native tool outputs, in order (usage.ts captureToolOutput), and their UTF-8 bytes. */
  tools?: { name: string; output: string }[];
  toolBytes?: number;
}

let toolCapture = false;

/** Whether a run log of this process captures: only then are tool outputs kept for it. */
export const capturingTools = (): boolean => toolCapture;

/**
 * How a run ended, in its `run-end` event: `stopped` (a clean stop, or a
 * one-off run that finished), `handed-off` (a clean stop with the
 * Objective unfinished: the next run carries it on), or `crashed` (the
 * process died; the next start detects it and appends this event to the
 * dead run's files, `endCrashedRun`).
 */
export type RunEnd = "stopped" | "handed-off" | "crashed";

/** One run file's line counters: what `log-health` reports. */
interface FileHealth {
  path: string;
  /** The last sequence number given out: every line gets the next, written or not. */
  seq: number;
  emitted: number;
  /** Failed writes: lines (`lost`) and capture files. */
  failed: number;
  lost: number;
  /** `failed` when the last `log-health` went out. */
  reported: number;
}

/**
 * The run log: one append-only JSON-lines file per Objective per service
 * run, `logs/<issue>/<run id>.jsonl`, and with capture on its bodies under
 * `logs/<issue>/<run id>.captures/`. It records what happened for status,
 * diagnostics and analysis. It never drives progress, and losing it loses
 * no work.
 *
 * Its formal history (docs/reference/run-log.md#Run log): each file starts with a
 * `run-header` (Factory's version and the running build's source digest);
 * every line carries `seq`, consecutive per file from 1, so a missing
 * number is a lost line; a write that fails is counted, and the next line
 * that lands is followed by a `log-health` event (emitted, failed and
 * lost), as is the run's end (`end`), after its `run-end` event.
 */
export class RunLog {
  private readonly files = new Map<number, FileHealth>();
  /** Attempt files given out this run, oldest first, and their bytes on disk. */
  private readonly attempts: RunFile[] = [];
  private readonly attemptNames = new Set<string>();

  constructor(
    private readonly dir: string,
    readonly runId: string,
    private readonly capture: CaptureSettings = CAPTURE_OFF,
    private readonly secrets: readonly string[] = [],
  ) {
    if (capture.enabled) toolCapture = true;
  }

  write(issue: number, event: Record<string, unknown>): void {
    const file = this.file(issue);
    if (!file) return;
    if (file.seq === 0) this.append(file, { event: "run-header", ...build() });
    const body = (event as { [CAPTURE]?: CaptureBody })[CAPTURE];
    const id = body && this.capture.enabled && this.captured(issue, body);
    if (body && this.capture.enabled && !id) file.failed += 1;
    if (!this.append(file, { ...event, ...(id ? { capture: id } : {}) }))
      return;
    if (file.failed > file.reported) this.health(file);
  }

  /**
   * A private file of this run for one attempt, `<issue>/<run id>.attempts/<name>`
   * (docs/reference/run-log.md#Attempt files): `0600` segments in a `0700`
   * directory, redacted line by line, its head kept and its tail rolling,
   * and rotated with the run. A name given out before gets `-2`, `-3`, ...
   * Past the run's budget the oldest closed files go first, each noted with
   * an `attempt-file-dropped` event.
   */
  runFile(issue: number, name: string): RunFile {
    const clean = name.replace(/[^\w.-]/g, "_");
    let unique = clean;
    for (let n = 2; this.attemptNames.has(`${issue}/${unique}`); n++)
      unique = `${clean}-${n}`;
    this.attemptNames.add(`${issue}/${unique}`);
    const file = new RunFile(
      this.dir,
      `${attemptDir(issue, this.runId)}/${unique}`,
      this.secrets,
      () => this.budget(),
    );
    this.attempts.push(file);
    return file;
  }

  /** Over the run's attempt-file budget: remove the oldest closed files until within it. */
  private budget(): void {
    let total = this.attempts.reduce((sum, file) => sum + file.onDisk, 0);
    while (total > ATTEMPT_FILES_PER_RUN) {
      const oldest = this.attempts.findIndex((file) => file.closed);
      if (oldest < 0) return;
      const [file] = this.attempts.splice(oldest, 1);
      total -= file!.onDisk;
      file!.remove();
      this.write(Number(file!.file.split("/")[0]), {
        event: "attempt-file-dropped",
        file: file!.file,
      });
    }
  }

  /**
   * The run's end: a `run-end` event (`outcome(issue)`) then a
   * `log-health` event in every file this run wrote. Call it once, last.
   */
  end(outcome: (issue: number) => RunEnd): void {
    for (const [issue, file] of this.files) {
      this.append(file, { event: "run-end", outcome: outcome(issue) });
      this.health(file);
    }
  }

  /** One line with the file's next `seq`; false, counted, when it couldn't be written. */
  private append(file: FileHealth, event: Record<string, unknown>): boolean {
    file.seq += 1;
    try {
      appendFileSync(
        file.path,
        `${JSON.stringify({ at: new Date().toISOString(), seq: file.seq, ...event })}\n`,
      );
      file.emitted += 1;
      return true;
    } catch {
      // A full disk or a removed directory must not stop the run: the log only observes.
      file.failed += 1;
      file.lost += 1;
      return false;
    }
  }

  private health(file: FileHealth): void {
    file.reported = file.failed;
    this.append(file, {
      event: "log-health",
      emitted: file.emitted,
      failed: file.failed,
      lost: file.lost,
    });
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
      // Request and response share the bound; tool outputs, when any, take a quarter.
      const share = Math.floor(
        (this.capture.maxBytesPerCall * (body.tools?.length ? 3 : 4)) / 8,
      );
      const request = bounded(redact(body.request, this.secrets), share);
      const response =
        body.response === undefined
          ? undefined
          : bounded(redact(body.response, this.secrets), share);
      let toolBytes = Math.floor(this.capture.maxBytesPerCall / 4);
      let toolsCut = false;
      const tools: { name: string; output: string }[] = [];
      for (const tool of body.tools ?? []) {
        const output = bounded(redact(tool.output, this.secrets), toolBytes);
        tools.push({ name: tool.name, output: output.text });
        toolBytes -= Buffer.byteLength(output.text);
        toolsCut ||= output.cut;
      }
      writeFileSync(
        join(dir, `${id}.json`),
        JSON.stringify({
          id,
          run: this.runId,
          request: request.text,
          ...(response ? { response: response.text } : {}),
          ...(tools.length ? { tools } : {}),
          truncated: request.cut || Boolean(response?.cut) || toolsCut,
        }),
        { mode: 0o600 },
      );
      return id;
    } catch {
      return undefined;
    }
  }

  private file(issue: number): FileHealth | undefined {
    let file = this.files.get(issue);
    if (!file) {
      const dir = join(this.dir, String(issue));
      try {
        mkdirSync(dir, { recursive: true });
      } catch {
        // Tried again with the next line; nothing was numbered yet.
        return undefined;
      }
      file = {
        path: join(dir, `${this.runId}.jsonl`),
        seq: 0,
        emitted: 0,
        failed: 0,
        lost: 0,
        reported: 0,
      };
      this.files.set(issue, file);
    }
    return file;
  }
}

/** What one service run keeps in attempt files, all issues together: the oldest closed go first past it. */
const ATTEMPT_FILES_PER_RUN = 1024 ** 3;
/** An attempt file's head, kept whole. */
const ATTEMPT_HEAD = 8 * 1024 ** 2;
/** Each tail segment past the head; the last two are kept. */
const ATTEMPT_SEGMENT = 4 * 1024 ** 2;
/** A line held for its newline at most this long before it is written anyway. */
const PENDING_LINE = 64 * 1024;

/**
 * One attempt's private file (RunLog.runFile): text appended line by line,
 * each line redacted before it is written. The first ATTEMPT_HEAD bytes
 * stay in segment 0; after it, segments of ATTEMPT_SEGMENT roll and the
 * last two are kept, so the file keeps its start and its end within 16
 * MiB. Segments are `<file>.<n>`; `readRunFile` joins them. A write that
 * fails is counted, never retried: the file only observes.
 */
export class RunFile {
  /** Bytes written, and bytes rotated away from the middle. */
  written = 0;
  dropped = 0;
  failed = 0;
  closed = false;
  private segment = 0;
  private segmentBytes = 0;
  /** Bytes of the segments still on disk. */
  private kept = new Map<number, number>();
  private pending = "";

  constructor(
    private readonly logs: string,
    /** Under the logs directory, without its segment number: what an event names. */
    readonly file: string,
    private readonly secrets: readonly string[],
    private readonly grew: () => void,
  ) {}

  get onDisk(): number {
    let sum = 0;
    for (const bytes of this.kept.values()) sum += bytes;
    return sum;
  }

  /** Text; complete lines are written, redacted, and the rest waits for its newline or `close`. */
  append(text: string): void {
    if (this.closed) return;
    this.pending += text;
    const end = this.pending.lastIndexOf("\n");
    if (end < 0 && this.pending.length < PENDING_LINE) return;
    const complete = end < 0 ? this.pending : this.pending.slice(0, end + 1);
    this.pending = end < 0 ? "" : this.pending.slice(end + 1);
    this.write(redact(complete, this.secrets));
  }

  /**
   * One JSON line: `{at, ...record}`, each string redacted and cut to 64
   * KiB (`cutStrings`). A record that can't be serialized (a cycle, a
   * BigInt) is counted as a failed write: the caller is never stopped.
   */
  record(record: Record<string, unknown>): void {
    let line: string;
    try {
      line = `${JSON.stringify({ at: new Date().toISOString(), ...(cutStrings(record) as object) })}\n`;
    } catch {
      this.failed += 1;
      return;
    }
    this.append(line);
  }

  /** Write what is pending and stop. */
  close(): void {
    if (this.closed) return;
    if (this.pending) this.write(redact(this.pending, this.secrets));
    this.pending = "";
    this.closed = true;
    this.grew();
  }

  /** Remove every segment: the run's budget dropped this file. */
  remove(): void {
    for (const segment of this.kept.keys())
      rmSync(this.path(segment), { force: true });
    this.kept.clear();
  }

  private path(segment: number): string {
    return join(this.logs, `${this.file}.${segment}`);
  }

  private write(text: string): void {
    if (!text) return;
    let bytes = Buffer.from(text, "utf8");
    const limit = this.segment ? ATTEMPT_SEGMENT : ATTEMPT_HEAD;
    if (this.segmentBytes && this.segmentBytes + bytes.length > limit) {
      this.segment += 1;
      this.segmentBytes = 0;
      // Keep the head and the last two tail segments.
      const old = this.segment - 2;
      if (old >= 1 && this.kept.has(old)) {
        this.dropped += this.kept.get(old)!;
        rmSync(this.path(old), { force: true });
        this.kept.delete(old);
      }
    }
    const room = this.segment ? ATTEMPT_SEGMENT : ATTEMPT_HEAD;
    if (bytes.length > room) {
      this.dropped += bytes.length - room;
      bytes = bytes.subarray(bytes.length - room);
    }
    try {
      mkdirSync(join(this.logs, dirname(this.file)), {
        recursive: true,
        mode: 0o700,
      });
      appendFileSync(this.path(this.segment), bytes, { mode: 0o600 });
      this.segmentBytes += bytes.length;
      this.written += bytes.length;
      this.kept.set(
        this.segment,
        (this.kept.get(this.segment) ?? 0) + bytes.length,
      );
    } catch {
      this.failed += 1;
      return;
    }
    if (this.segmentBytes === bytes.length) this.grew();
  }
}

/** The longest string an attempt-file record keeps: its head and tail, the middle cut. */
const RECORD_STRING = 64 * 1024;

/** `value` with every string over RECORD_STRING cut in the middle. */
function cutStrings(value: unknown): unknown {
  if (typeof value === "string")
    return value.length > RECORD_STRING
      ? `${value.slice(0, RECORD_STRING / 2)}\n[… ${value.length - RECORD_STRING} characters cut …]\n${value.slice(-RECORD_STRING / 2)}`
      : value;
  if (Array.isArray(value)) return value.map(cutStrings);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, cutStrings(entry)]),
    );
  return value;
}

/** The most `readRunFile` reads of one segment: a little over its bound. */
const SEGMENT_READ_MAX = ATTEMPT_HEAD + 1024 * 1024;

/**
 * An attempt file's text (`file` as its event names it, under `logs`):
 * its segments in order, read without following links, with a note where
 * the middle rotated away; redacted again with `secrets`. Undefined when
 * no segment is there (rotated away with its run, or never written).
 */
export function readRunFile(
  logs: string,
  file: string,
  secrets: readonly string[],
): { text: string; cut: boolean } | undefined {
  if (!/^\d+\/[\w.-]+\.attempts\/[\w.-]+$/.test(file)) return undefined;
  const dir = dirname(file);
  const name = basename(file);
  const segments = safeList(join(logs, dir))
    .filter(
      (entry) =>
        entry.startsWith(`${name}.`) &&
        /^\d+$/.test(entry.slice(name.length + 1)),
    )
    .map((entry) => Number(entry.slice(name.length + 1)))
    .sort((a, b) => a - b);
  if (!segments.length) return undefined;
  let text = "";
  let cut = false;
  let previous = -1;
  for (const segment of segments) {
    if (segment > previous + 1) {
      cut = true;
      text += "\n[… the middle rotated away …]\n";
    }
    previous = segment;
    try {
      text += readContained(
        logs,
        `${file}.${segment}`,
        SEGMENT_READ_MAX,
        true,
      ).toString("utf8");
    } catch {
      cut = true;
    }
  }
  return { text: redact(text, secrets), cut };
}

/**
 * At a start that found the last run dead: append `run-end` (`crashed`)
 * to that run's files of `issues` (and the service's, 0) that exist,
 * numbered after their last line, which a torn last line doesn't swallow;
 * a file that already has one is left alone.
 * Only the given issues are looked at: the Objectives this start loaded.
 */
export function endCrashedRun(
  dir: string,
  runId: string,
  issues: Iterable<number>,
  detectedBy: string,
): void {
  for (const issue of new Set([0, ...issues])) {
    const path = join(dir, String(issue), `${runId}.jsonl`);
    try {
      if (!existsSync(path)) continue;
      const size = sizeOf(path);
      const tail = readFrom(path, Math.max(0, size - 64 * 1024), size);
      const lines = parseLines(completeLines(tail).toString("utf8"), true);
      // Ended already (a start that died after writing this): once only.
      if (lines.some((line) => line.event === "run-end")) continue;
      const last = lines.at(-1);
      const seq = typeof last?.seq === "number" ? last.seq + 1 : undefined;
      appendFileSync(
        path,
        `${tail.length && tail[tail.length - 1] !== 10 ? "\n" : ""}${JSON.stringify(
          {
            at: new Date().toISOString(),
            ...(seq ? { seq } : {}),
            event: "run-end",
            outcome: "crashed" satisfies RunEnd,
            detectedBy,
          },
        )}\n`,
      );
    } catch {
      // The log only observes.
    }
  }
}

interface Build {
  factoryVersion: string | null;
  sourceDigest: string | null;
}
let built: Build | undefined;

/**
 * The running build, once per process: Factory's version (the nearest
 * package.json above this module) and a sha256 over the build's own
 * JavaScript files (paths and bytes, in path order).
 */
function build(): Build {
  if (built) return built;
  const root = dirname(fileURLToPath(import.meta.url));
  let factoryVersion: string | null = null;
  for (let dir = root; ; dir = dirname(dir)) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      factoryVersion = typeof pkg.version === "string" ? pkg.version : null;
      break;
    } catch {
      if (dirname(dir) === dir) break;
    }
  }
  let sourceDigest: string | null = null;
  try {
    const hash = createHash("sha256");
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true })
        .flatMap((entry) =>
          entry.isDirectory()
            ? walk(join(dir, entry.name))
            : entry.name.endsWith(".js")
              ? [join(dir, entry.name)]
              : [],
        )
        .sort();
    for (const file of walk(root))
      hash
        .update(`${relative(root, file)}\0`)
        .update(readFileSync(file))
        .update("\0");
    sourceDigest = hash.digest("hex");
  } catch {
    // Unreadable: the header says so with null.
  }
  built = { factoryVersion, sourceDigest };
  return built;
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
 * Call `poll` every `everyMs` until SIGINT, SIGTERM or `signal`, or until
 * it returns a result (anything but undefined): a follow's loop. Returns
 * that result, undefined when interrupted. `started` runs once the signals
 * are caught: what tells a person (or a script) that Ctrl-C now stops the
 * follow goes there, so a signal sent on seeing it never meets Node's
 * default exit.
 */
export async function untilInterrupted<T>(
  poll: () => T | undefined | Promise<T | undefined>,
  signal?: AbortSignal,
  everyMs = 500,
  started?: () => void,
): Promise<T | undefined> {
  let stop = signal?.aborted ?? false;
  const stopping = () => {
    stop = true;
  };
  process.once("SIGINT", stopping);
  process.once("SIGTERM", stopping);
  signal?.addEventListener("abort", stopping, { once: true });
  try {
    started?.();
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
    signal?.removeEventListener("abort", stopping);
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
 * the byte cap. A run is its log file, its capture directory and its
 * attempt directory, removed together. Run ids sort by start time, so id order is age order. The
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

/** Tokens, JWTs, bearer headers and the named secret values, line by line, as [REDACTED]. */
export function redact(value: string, secrets: readonly string[] = []): string {
  let result = value
    .replace(
      /\b(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}\b/g,
      "[REDACTED]",
    )
    .replace(
      /\beyJ[A-Za-z0-9_-]{4,}\.eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g,
      "[REDACTED]",
    )
    .replace(/(Authorization:\s*Bearer\s+)\S+/gi, "$1[REDACTED]");
  for (const secret of secrets)
    for (const line of secret.split(/\r?\n/))
      if (line.length) result = result.split(line).join("[REDACTED]");
  return result;
}
