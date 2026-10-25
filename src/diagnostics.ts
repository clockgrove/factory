/**
 * `factory diagnostics ISSUE`: what an Objective's run(s) did, from the run
 * log alone. The timeline (steps, holds and answers, repairs, waits, model
 * calls, worker activity) with times relative to the run's start; `--logs
 * ITEM` one Work Item's events in detail; `--summary` the totals per role
 * and phase, repairs, holds, the critical path and the slowest steps. Each
 * run file is streamed in chunks, so a large log costs time, not memory.
 * Every event is redacted as it is read. It never writes anything.
 */
import { join } from "node:path";
import { displayTime, duration, redactDeep } from "./display.js";
import { itemOf } from "./engine.js";
import {
  completeLines,
  type LogEvent,
  logFiles,
  parseLines,
  readFrom,
  readRunFile,
  runOfFile,
  sizeOf,
  untilInterrupted,
} from "./log.js";
import { captureFile, readContained } from "./paths.js";
import { oneLine } from "./text.js";

/** Which runs: the latest (default), one by id, or all. */
export type RunChoice =
  | { kind: "latest" }
  | { kind: "run"; id: string }
  | { kind: "all" };

export interface DiagnosticsOptions {
  logs: string;
  issue: number;
  runs: RunChoice;
  /** `--logs ITEM`: only this Work Item's events, in detail. */
  item?: string;
  summary?: boolean;
  follow?: boolean;
  /** With `item`: print each model call's captured request and response, not only its capture file. */
  captures?: boolean;
  json?: boolean;
  secrets: readonly string[];
}

/** One timeline line. `event` is the redacted log event it came from. */
export interface Entry {
  at: string;
  run: string;
  /** Since the run's first event. */
  elapsedMs: number;
  kind:
    | "admitted"
    | "step-start"
    | "step-end"
    | "wait"
    | "repair"
    | "hold"
    | "answer"
    | "request"
    | "diagnosis"
    | "validation"
    | "model"
    | "activity"
    | "cancelled"
    | "transcript"
    | "event";
  step?: string;
  item?: string;
  text: string;
  event: LogEvent;
}

/** Bytes read per chunk; a line longer than the cap is skipped. */
const CHUNK = 1024 * 1024;
const MAX_LINE = 16 * 1024 * 1024;
/** Text cut in timeline lines. */
const TEXT = 200;
/** Steps the summary lists as slowest. */
const SLOWEST = 10;

/** The run files `choice` names, oldest first; [] when the run isn't there. */
export function chosenFiles(
  logs: string,
  issue: number,
  choice: RunChoice,
): string[] {
  const files = logFiles(logs, issue);
  if (choice.kind === "all") return files;
  if (choice.kind === "run")
    return files.filter((file) => runOfFile(file) === choice.id);
  return files.slice(-1);
}

/**
 * Read `file` from byte `from` in chunks, passing each complete event to
 * `visit`; returns the offset after the last complete line, where a follow
 * carries on.
 */
export function streamFile(
  file: string,
  from: number,
  visit: (event: LogEvent) => void,
): number {
  const size = sizeOf(file);
  let position = from;
  let done = from;
  let rest = Buffer.alloc(0);
  let skipping = false;
  while (position < size) {
    const chunk = readFrom(file, position, Math.min(size, position + CHUNK));
    if (!chunk.length) break;
    position += chunk.length;
    let bytes = rest.length ? Buffer.concat([rest, chunk]) : chunk;
    if (skipping) {
      // Inside an overlong line: drop it through its newline.
      const end = bytes.indexOf(10);
      if (end < 0) {
        done += bytes.length;
        rest = Buffer.alloc(0);
        continue;
      }
      done += end + 1;
      bytes = bytes.subarray(end + 1);
      skipping = false;
    }
    const complete = completeLines(bytes);
    for (const event of parseLines(complete.toString("utf8"))) visit(event);
    done += complete.length;
    rest = Buffer.from(bytes.subarray(complete.length));
    if (rest.length > MAX_LINE) {
      done += rest.length;
      rest = Buffer.alloc(0);
      skipping = true;
    }
  }
  return done;
}

/** Stream `file` from `from` like streamFile, each event redacted and marked with its run. */
export function readRun(
  file: string,
  from: number,
  secrets: readonly string[],
  visit: (event: LogEvent) => void,
): number {
  const run = runOfFile(file);
  return streamFile(file, from, (event) => {
    const shown = redactDeep(event, secrets);
    shown.run = run;
    visit(shown);
  });
}

/** Print the diagnostics `options` asks for to `write`; with follow, until interrupted. */
export async function diagnostics(
  options: DiagnosticsOptions,
  write: (text: string) => void,
): Promise<void> {
  const files = chosenFiles(options.logs, options.issue, options.runs);
  const read = (file: string, from: number, visit: (e: LogEvent) => void) =>
    readRun(file, from, options.secrets, visit);
  if (options.summary) {
    const summary = new Summary(options.issue);
    for (const file of files) read(file, 0, (event) => summary.add(event));
    const report = summary.report();
    write(options.json ? `${JSON.stringify(report)}\n` : summaryText(report));
    return;
  }
  const timeline = new Timeline(options.item);
  let lastRun: string | undefined;
  let captured = false;
  const print = (entry: Entry) => {
    const capture =
      options.item === undefined
        ? undefined
        : captureOf(options, entry, Boolean(options.captures));
    if (capture) captured = true;
    // A failed command's whole output, in its attempt file.
    const output =
      options.item !== undefined &&
      entry.kind === "validation" &&
      typeof entry.event.output === "string"
        ? join(options.logs, entry.event.output)
        : undefined;
    if (options.json) {
      write(
        `${JSON.stringify({ ...entry, ...(capture ? { capture } : {}), ...(output ? { outputPath: output } : {}) })}\n`,
      );
      return;
    }
    if (entry.run !== lastRun) {
      lastRun = entry.run;
      const start = new Date(Date.parse(entry.at) - entry.elapsedMs);
      write(`Run ${entry.run} · started ${displayTime(start.toISOString())}\n`);
    }
    const text =
      options.item === undefined
        ? entry.text
        : withDetail(entry.text, entry.event);
    write(`${relative(entry.elapsedMs)}  ${text}\n`);
    if (output) write(`        whole output: ${output}\n`);
    if (!capture) return;
    write(`        capture: ${capture.path}\n`);
    if (capture.request !== undefined)
      write(`        request:\n${capture.request}\n`);
    if (capture.response !== undefined)
      write(`        response:\n${capture.response}\n`);
    if (capture.truncated)
      write(
        `        (cut to capture.maxBytesPerCall${originalText(capture.original)})\n`,
      );
  };
  const captureNote = () => {
    if (options.item !== undefined && !captured && !options.json)
      write(
        `No captured model calls for ${options.item}: full requests and responses are kept only with capture.enabled (docs/reference/run-log.md#Content capture).\n`,
      );
  };
  // `--logs ITEM`: each worker attempt's transcript, after the attempt ends.
  const transcripts = new Map<string, LogEvent>();
  const printTranscript = (entry: Entry, opened: LogEvent) => {
    const file = String(opened.file);
    const read = readRunFile(options.logs, file, options.secrets);
    const records = read ? transcriptRecords(read.text) : [];
    const path = join(options.logs, file);
    if (options.json) {
      write(
        `${JSON.stringify({ ...entry, kind: "transcript", text: `transcript ${String(opened.attemptId)}`, transcript: { file, path, available: Boolean(read), cut: read?.cut ?? false, records } })}\n`,
      );
      return;
    }
    write(
      `        transcript of ${String(opened.attemptId)}: ${read ? `${count(records.length)} records${read.cut ? ", its middle rotated away" : ""}` : "gone (rotated away with its run, or never written)"} · ${path}\n`,
    );
    for (const record of records)
      write(`          ${transcriptLine(record)}\n`);
  };
  const visit = (event: LogEvent) => {
    if (
      options.item !== undefined &&
      event.event === "transcript" &&
      event.item === options.item &&
      typeof event.attemptId === "string"
    )
      transcripts.set(event.attemptId, event);
    for (const entry of timeline.add(event)) {
      print(entry);
      const attempt = str(entry.event.attemptId);
      const opened = attempt ? transcripts.get(attempt) : undefined;
      if (entry.event.event === "outcome" && attempt && opened) {
        transcripts.delete(attempt);
        printTranscript(entry, opened);
      }
    }
  };
  const offsets = new Map<string, number>();
  for (const file of files) offsets.set(file, read(file, 0, visit));
  if (!options.json && !files.length)
    write(`No run log for #${options.issue} yet.\n`);
  if (!options.follow) {
    // Steps still running when the log ends: their activity so far.
    for (const entry of timeline.running()) print(entry);
    // And the transcripts of attempts still running, as far as written.
    for (const opened of transcripts.values())
      printTranscript(
        {
          at: opened.at,
          run: String(opened.run),
          elapsedMs: 0,
          kind: "transcript",
          text: "",
          event: opened,
        },
        opened,
      );
    captureNote();
    return;
  }
  captureNote();
  await untilInterrupted(() => {
    // The latest run, or all: a run that starts meanwhile is followed too.
    if (options.runs.kind !== "run") {
      const newest = [...offsets.keys()].sort().at(-1);
      for (const file of logFiles(options.logs, options.issue))
        if (!offsets.has(file) && (!newest || file > newest))
          offsets.set(file, 0);
    }
    for (const [file, from] of [...offsets].sort())
      offsets.set(file, read(file, from, visit));
  });
}

/** A model call's capture file, and with `bodies` its redacted request and response; undefined when the call has none. */
function captureOf(
  options: DiagnosticsOptions,
  entry: Entry,
  bodies: boolean,
):
  | {
      path: string;
      request?: string;
      response?: string;
      truncated?: boolean;
      original?: Record<string, unknown>;
    }
  | undefined {
  const id = entry.event.capture;
  const file =
    entry.kind === "model" && typeof id === "string"
      ? captureFile(options.issue, entry.run, id)
      : undefined;
  if (!file) return undefined;
  const path = join(options.logs, file);
  if (!bodies) return { path };
  const body = readCapture(options.logs, file, options.secrets);
  return body ? { path, ...body } : { path };
}

/** A transcript's records: its complete JSON lines, a torn or cut one skipped. */
function transcriptRecords(text: string): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      records.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // Cut where the middle rotated away.
    }
  }
  return records;
}

/** One transcript record as a line: what the worker did, or the provider's event as it came. */
function transcriptLine(record: Record<string, unknown>): string {
  const at =
    typeof record.at === "string"
      ? displayTime(record.at).slice(11)
      : "--:--:--";
  const activity = record.activity as Record<string, unknown> | undefined;
  if (!activity) return `${at} output ${JSON.stringify(record.output)}`;
  switch (activity.kind) {
    case "tool":
      return `${at} tool ${String(activity.tool)} ${String(activity.phase)}${typeof activity.target === "string" ? `: ${oneLine(activity.target, 2_000)}` : ""}`;
    case "edit":
      return `${at} edit ${String(activity.path)}`;
    case "command":
      return `${at} $ ${oneLine(String(activity.command), 2_000)}`;
    case "command-failed":
      return `${at} command failed`;
    case "context":
      return `${at} context ${String(activity.tokens)} tokens${typeof activity.window === "number" ? ` of ${activity.window}` : ""}`;
    default:
      return `${at} ${String(activity.kind)}`;
  }
}

/** `; the request was 12,345 bytes (sha256 ab12…), the response …`: a cut capture's originals. */
export function originalText(original?: Record<string, unknown>): string {
  const part = (name: string) => {
    const body = original?.[name] as
      | { bytes?: unknown; sha256?: unknown }
      | undefined;
    return typeof body?.bytes === "number" && typeof body.sha256 === "string"
      ? `the ${name} was ${count(body.bytes)} bytes (sha256 ${body.sha256.slice(0, 12)}…)`
      : undefined;
  };
  const parts = [part("request"), part("response")].filter(Boolean);
  return parts.length ? `; ${parts.join(", ")}` : "";
}

/** The most a capture file is read: 2 × the 256 MiB maxBytesPerCall cap, with JSON escapes. */
const CAPTURE_READ_MAX = 768 * 1024 * 1024;

/**
 * A capture file's bodies (`file` under `logs`, from paths.ts captureFile),
 * read without following links; undefined when it was rotated away or
 * can't be read. Stored redacted and cut to capture.maxBytesPerCall, and
 * redacted again here with today's secrets.
 */
export function readCapture(
  logs: string,
  file: string,
  secrets: readonly string[],
):
  | {
      request?: string;
      response?: string;
      truncated?: true;
      /** The bodies' sizes and digests before redaction and the cut. */
      original?: Record<string, unknown>;
    }
  | undefined {
  try {
    const body = redactDeep(
      JSON.parse(
        readContained(logs, file, CAPTURE_READ_MAX, true).toString("utf8"),
      ) as Record<string, unknown>,
      secrets,
    );
    return {
      ...(typeof body.request === "string" ? { request: body.request } : {}),
      ...(typeof body.response === "string" ? { response: body.response } : {}),
      ...(body.truncated === true ? { truncated: true as const } : {}),
      ...(body.original && typeof body.original === "object"
        ? { original: body.original as Record<string, unknown> }
        : {}),
    };
  } catch {
    return undefined;
  }
}

/** `+4:05`, `+1:02:03`: a time since the run's start. */
export function relative(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = String(seconds % 60).padStart(2, "0");
  return h
    ? `+${h}:${String(m).padStart(2, "0")}:${s}`
    : `+${String(m).padStart(2, "0")}:${s}`;
}

export const str = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;
export const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;
export const count = (n: number) => n.toLocaleString("en-US");

/** `item:a:work` is `work`; an Objective step is its key. */
export function phaseOf(step: string): string {
  return itemOf(step) ? step.split(":").slice(2).join(":") : step;
}

/** The Work Item an event is about: its own, its step's, or an answer's question's. */
export function itemOfEvent(event: LogEvent): string | undefined {
  const step = str(event.step);
  const request = event.request as Record<string, unknown> | undefined;
  const question = str(request?.question);
  return (
    str(event.item) ??
    (step ? itemOf(step) : undefined) ??
    (question ? itemOf(question) : undefined)
  );
}

/** A model call in a few words: `worker codex gpt-6 high · finished · 81 s · 996,791 tokens (936,192 cached) · $0.12`. */
function modelText(event: LogEvent): string {
  const tokens = event.tokens as Record<string, number | null> | null;
  const total = tokens?.total;
  const cached = tokens?.cached;
  const cost = num(event.costUsd);
  const ms = num(event.ms);
  return [
    [
      "model",
      str(event.role) ?? "?",
      str(event.phase),
      str(event.provider),
      str(event.model),
      str(event.effort),
      event.hedge ? "(hedge)" : undefined,
    ]
      .filter(Boolean)
      .join(" "),
    str(event.outcome),
    ms === undefined ? undefined : duration(ms),
    typeof total === "number"
      ? `${count(total)} tokens${typeof cached === "number" && cached ? ` (${count(cached)} cached)` : ""}`
      : "tokens unknown",
    cost === undefined ? undefined : `$${cost.toFixed(2)}`,
    str(event.error) ? oneLine(String(event.error), TEXT) : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The counts a `worker-activity` event carries (work/worker.ts ActivityLog), each since the event before. */
export interface ActivityCounts {
  turns: number;
  toolsStarted: number;
  toolsFinished: number;
  edits: number;
  commands: number;
  commandsFailed: number;
  compactions: number;
}

/** One `worker-activity` event's counts added to `into` (fresh zeros when absent); a count it lacks adds 0. */
export function foldActivity(
  event: LogEvent,
  into?: ActivityCounts,
): ActivityCounts {
  const totals = into ?? {
    turns: 0,
    toolsStarted: 0,
    toolsFinished: 0,
    edits: 0,
    commands: 0,
    commandsFailed: 0,
    compactions: 0,
  };
  const counts = (event.counts ?? {}) as Record<string, unknown>;
  for (const name of Object.keys(totals) as (keyof ActivityCounts)[])
    totals[name] += num(counts[name]) ?? 0;
  return totals;
}

interface Activity {
  counts: ActivityCounts;
  tools: Set<string>;
  paths: Set<string>;
  command?: string;
}

function activityText(item: string, activity: Activity): string {
  const counts = activity.counts;
  const parts = [`activity ${item}: ${counts.turns} turns`];
  if (counts.toolsStarted)
    parts.push(
      `${counts.toolsStarted} tools${activity.tools.size ? ` (${[...activity.tools].slice(0, 8).join(", ")})` : ""}`,
    );
  if (counts.edits)
    parts.push(
      `${counts.edits} edits${activity.paths.size ? ` (${[...activity.paths].slice(0, 8).join(", ")})` : ""}`,
    );
  if (counts.commands) parts.push(`${counts.commands} commands`);
  if (counts.commandsFailed) parts.push(`${counts.commandsFailed} failed`);
  if (activity.command) parts.push(`last $ ${activity.command}`);
  return parts.join(" · ");
}

/**
 * Turns log events into timeline entries. Without an item it keeps the
 * events a timeline needs and folds worker activity into one summary per
 * step; with one, it keeps every event of that item, each in detail.
 */
class Timeline {
  private readonly starts = new Map<string, string>();
  private readonly runStart = new Map<string, number>();
  private readonly holds = new Map<string, string>();
  /** Each running step's activity so far, and its latest event. */
  private readonly activity = new Map<
    string,
    { activity: Activity; event: LogEvent }
  >();

  constructor(private readonly item?: string) {}

  /** The activity of steps still running: printed when the log ends before them. */
  running(): Entry[] {
    return [...this.activity.values()].map(({ activity, event }) =>
      this.entry(
        event,
        "activity",
        `${activityText(itemOfEvent(event) ?? "-", activity)} · still running`,
      ),
    );
  }

  private entry(event: LogEvent, kind: Entry["kind"], text: string): Entry {
    const run = String(event.run);
    const step = str(event.step);
    const item = itemOfEvent(event);
    return {
      at: event.at,
      run,
      elapsedMs: Date.parse(event.at) - this.runStart.get(run)!,
      kind,
      ...(step ? { step } : {}),
      ...(item ? { item } : {}),
      text,
      event,
    };
  }

  add(event: LogEvent): Entry[] {
    const run = String(event.run);
    if (!this.runStart.has(run)) this.runStart.set(run, Date.parse(event.at));
    const item = itemOfEvent(event);
    if (this.item !== undefined && item !== this.item) return [];
    const step = str(event.step);
    const entry = (kind: Entry["kind"], text: string) =>
      this.entry(event, kind, text);
    const since = (key: string) => {
      const start = step ? this.starts.get(`${run} ${key}`) : undefined;
      return start ? duration(Date.parse(event.at) - Date.parse(start)) : "?";
    };
    switch (event.event) {
      case "admitted":
        return [
          entry(
            "admitted",
            `admitted${event.again ? " again" : ""}${event.provider ? ` on ${String(event.provider)}` : ""}`,
          ),
        ];
      case "start":
        if (!step) return [];
        this.starts.set(`${run} ${step}`, event.at);
        return [entry("step-start", `${step} started`)];
      case "outcome": {
        if (!step) return [];
        const outcome = String(event.outcome ?? "ended");
        const reason = str(event.reason);
        const took = since(step);
        this.starts.delete(`${run} ${step}`);
        const done: Entry[] = [];
        const running = this.activity.get(`${run} ${step}`);
        if (running) {
          this.activity.delete(`${run} ${step}`);
          done.push(
            entry("activity", activityText(item ?? "-", running.activity)),
          );
        }
        if (outcome === "retry" && event.progress)
          done.push(entry("step-end", `${step} continues after ${took}`));
        else if (outcome === "retry")
          done.push(
            entry(
              "wait",
              `${step} waits after ${took}${reason ? `: ${oneLine(reason, TEXT)}` : ""}`,
            ),
          );
        else if (outcome === "repair")
          done.push(
            entry(
              "repair",
              `${step} repair${event.target ? ` of ${String(event.target)}` : ""} after ${took}${event.finding ? `: ${oneLine(String(event.finding), TEXT)}` : ""}`,
            ),
          );
        else
          done.push(
            entry(
              "step-end",
              `${step} ${outcome} after ${took}${reason ? `: ${oneLine(reason, TEXT)}` : ""}`,
            ),
          );
        return done;
      }
      case "hold": {
        const id = str(event.id);
        if (id) this.holds.set(id, event.at);
        return [
          entry(
            "hold",
            `${step ?? "objective"} asks${event.cause === "failure" ? " (failure)" : ""}: ${oneLine(String(event.question ?? ""), TEXT)}`,
          ),
        ];
      }
      case "request": {
        const request = (event.request ?? {}) as Record<string, unknown>;
        const by = str(event.by) ?? str(request.by);
        const code = str(event.code);
        if (request.kind === "answer") {
          const question = str(request.question);
          const asked = question ? this.holds.get(question) : undefined;
          return [
            entry(
              "answer",
              `answer ${String(request.answer)}${request.arg ? ` ${String(request.arg)}` : ""}${by ? ` by ${by}` : ""}${code ? ` refused (${code})` : asked ? ` after ${duration(Date.parse(event.at) - Date.parse(asked))}` : ""}${question ? ` to ${question}` : ""}`,
            ),
          ];
        }
        return [
          entry(
            "request",
            `${String(request.kind ?? "request")}${by ? ` by ${by}` : ""}${code ? ` refused (${code})` : ""}`,
          ),
        ];
      }
      case "media-auto-selected":
        return [
          entry(
            "answer",
            `${step ?? "select"} selected set ${String(event.set)} without asking: the only candidate${Array.isArray(event.bound) && event.bound.length ? `, bound to ${event.bound.join(", ")}` : ""}`,
          ),
        ];
      case "diagnosis":
        return [
          entry(
            "diagnosis",
            `diagnosis: ${String(event.decision)}${event.path ? ` ${String(event.path)}` : ""}${event.predecessor ? ` blames ${String(event.predecessor)}` : ""}`,
          ),
        ];
      case "validation-result": {
        const ms = num(event.durationMs);
        return [
          entry(
            "validation",
            `validation ${event.passed ? "passed" : `failed (exit ${String(event.exitCode)})`}${ms === undefined ? "" : ` in ${duration(ms)}`}: ${oneLine(String(event.command ?? ""), TEXT)}`,
          ),
        ];
      }
      case "model-usage":
        return [entry("model", modelText(event))];
      case "worker-activity": {
        if (this.item !== undefined)
          return [entry("activity", activityText(item ?? "-", fold(event)))];
        if (!step) return [];
        const key = `${run} ${step}`;
        this.activity.set(key, {
          activity: fold(event, this.activity.get(key)?.activity),
          event,
        });
        return [];
      }
      case "cancelled":
        return [
          entry(
            "cancelled",
            `cancelled${event.by ? ` by ${String(event.by)}` : ""}`,
          ),
        ];
      default:
        return this.item === undefined
          ? []
          : [entry("event", String(event.event ?? "event"))];
    }
  }
}

/** One `worker-activity` event added to a step's activity. */
function fold(event: LogEvent, into?: Activity): Activity {
  const activity = into ?? {
    counts: foldActivity(event),
    tools: new Set<string>(),
    paths: new Set<string>(),
  };
  if (into) foldActivity(event, into.counts);
  if (Array.isArray(event.tools))
    for (const tool of event.tools) activity.tools.add(String(tool));
  if (Array.isArray(event.paths))
    for (const path of event.paths) activity.paths.add(String(path));
  if (typeof event.command === "string") activity.command = event.command;
  return activity;
}

/** `--logs ITEM`: the line, then the event's other fields. */
function withDetail(text: string, event: LogEvent): string {
  const { at: _at, run: _run, step: _step, event: _kind, ...rest } = event;
  return Object.keys(rest).length ? `${text} ${JSON.stringify(rest)}` : text;
}

/** Model calls, their tokens, cost and time, summed. Unknown counts are counted, not taken as 0. */
export interface Usage {
  calls: number;
  ms: number;
  tokens: {
    input: number;
    output: number;
    cached: number;
    cacheWrite: number;
    reasoning: number;
    total: number;
  };
  /** Calls that reported no total. */
  tokensUnknown: number;
  /** Null when no call reported a cost. */
  costUsd: number | null;
  costUnknown: number;
}

/** One step attempt: started, and ended (or not, by the end of its run). */
export interface StepSpan {
  step: string;
  run: string;
  startedAt: string;
  endedAt: string;
  ms: number;
  /** The outcome, or `unfinished` when its run's log ends first. */
  outcome: string;
}

export interface HoldSpan {
  id: string;
  step?: string;
  item?: string;
  cause?: string;
  askedAt: string;
  answeredAt?: string;
  answer?: string;
  by?: string;
  /** Asked to answered; absent while it is open (or was closed without an answer). */
  waitMs?: number;
}

export interface SummaryReport {
  issue: number;
  runs: string[];
  from?: string;
  to?: string;
  wallMs: number;
  roles: Record<string, Usage>;
  phases: Record<string, Usage & { steps: number; stepMs: number }>;
  repairs: Record<string, number>;
  holds: HoldSpan[];
  holdWaitMs: number;
  /** Walking back from the step that ended last, each time to the step that ended last before it started. */
  criticalPath: StepSpan[];
  criticalPathMs: number;
  slowest: StepSpan[];
}

export const emptyUsage = (): Usage => ({
  calls: 0,
  ms: 0,
  tokens: {
    input: 0,
    output: 0,
    cached: 0,
    cacheWrite: 0,
    reasoning: 0,
    total: 0,
  },
  tokensUnknown: 0,
  costUsd: null,
  costUnknown: 0,
});

/** Folds events into the summary; it keeps one record per step attempt and hold, never the events. */
class Summary {
  private readonly runs: string[] = [];
  private from?: string;
  private to?: string;
  private readonly roles: SummaryReport["roles"] = {};
  private readonly phases: SummaryReport["phases"] = {};
  private readonly repairs: Record<string, number> = {};
  private readonly holds = new Map<string, HoldSpan>();
  private readonly open = new Map<string, LogEvent>();
  private readonly spans: StepSpan[] = [];
  /** The last event of each run: where its unfinished steps stop. */
  private readonly lastAt = new Map<string, string>();

  constructor(private readonly issue: number) {}

  add(event: LogEvent): void {
    const run = String(event.run);
    if (!this.lastAt.has(run)) this.runs.push(run);
    this.lastAt.set(run, event.at);
    this.from ??= event.at;
    this.to = event.at;
    const step = str(event.step);
    switch (event.event) {
      case "start":
        if (step) this.open.set(`${run} ${step}`, event);
        break;
      case "outcome": {
        if (!step) break;
        const start = this.open.get(`${run} ${step}`);
        this.open.delete(`${run} ${step}`);
        if (start) this.span(step, run, start.at, event.at, event.outcome);
        if (event.outcome === "repair") {
          const target = str(event.target) ?? step;
          const item = itemOf(target) ?? "objective";
          this.repairs[item] = (this.repairs[item] ?? 0) + 1;
        }
        break;
      }
      case "model-usage": {
        const role = str(event.role) ?? "unknown";
        const phase = str(event.phase) ?? (step ? phaseOf(step) : role);
        this.roles[role] ??= emptyUsage();
        addUsage(this.roles[role], event);
        addUsage(this.phase(phase), event);
        break;
      }
      case "hold": {
        const id = str(event.id);
        if (!id) break;
        const item = step ? itemOf(step) : undefined;
        this.holds.set(id, {
          id,
          ...(step ? { step } : {}),
          ...(item ? { item } : {}),
          ...(str(event.cause) ? { cause: String(event.cause) } : {}),
          askedAt: event.at,
        });
        break;
      }
      case "request": {
        const request = (event.request ?? {}) as Record<string, unknown>;
        const hold = this.holds.get(str(request.question) ?? "");
        if (request.kind !== "answer" || !hold || event.code) break;
        if (hold.answeredAt) break;
        hold.answeredAt = event.at;
        hold.answer = String(request.answer);
        const by = str(event.by);
        if (by) hold.by = by;
        hold.waitMs = Date.parse(event.at) - Date.parse(hold.askedAt);
        break;
      }
    }
  }

  private phase(name: string) {
    const phase = this.phases[name] ?? { ...emptyUsage(), steps: 0, stepMs: 0 };
    this.phases[name] = phase;
    return phase;
  }

  private span(
    step: string,
    run: string,
    startedAt: string,
    endedAt: string,
    outcome: unknown,
  ): void {
    const ms = Math.max(0, Date.parse(endedAt) - Date.parse(startedAt));
    this.spans.push({
      step,
      run,
      startedAt,
      endedAt,
      ms,
      outcome: String(outcome),
    });
    const phase = this.phase(phaseOf(step));
    phase.steps += 1;
    phase.stepMs += ms;
  }

  report(): SummaryReport {
    // A step whose run's log ends before its outcome: unfinished at that end.
    for (const [key, start] of this.open) {
      const run = key.slice(0, key.indexOf(" "));
      const step = String(start.step);
      this.span(step, run, start.at, this.lastAt.get(run)!, "unfinished");
    }
    this.open.clear();
    const holds = [...this.holds.values()];
    const path = criticalPath(this.spans);
    return {
      issue: this.issue,
      runs: this.runs,
      ...(this.from ? { from: this.from, to: this.to } : {}),
      wallMs:
        this.from && this.to ? Date.parse(this.to) - Date.parse(this.from) : 0,
      roles: this.roles,
      phases: this.phases,
      repairs: this.repairs,
      holds,
      holdWaitMs: holds.reduce((sum, hold) => sum + (hold.waitMs ?? 0), 0),
      criticalPath: path,
      criticalPathMs: path.reduce((sum, span) => sum + span.ms, 0),
      slowest: [...this.spans].sort((a, b) => b.ms - a.ms).slice(0, SLOWEST),
    };
  }
}

export function addUsage(usage: Usage, event: LogEvent): void {
  usage.calls += 1;
  usage.ms += num(event.ms) ?? 0;
  const tokens = (event.tokens ?? {}) as Record<string, unknown>;
  for (const name of Object.keys(usage.tokens) as (keyof Usage["tokens"])[])
    usage.tokens[name] += num(tokens[name]) ?? 0;
  if (num(tokens.total) === undefined) usage.tokensUnknown += 1;
  const cost = num(event.costUsd);
  if (cost === undefined) usage.costUnknown += 1;
  else usage.costUsd = (usage.costUsd ?? 0) + cost;
}

/**
 * The observed critical path. The log has no dependency edges, so it walks
 * back from the step that ended last, each time to the step that ended
 * last at or before the current one started.
 */
function criticalPath(spans: StepSpan[]): StepSpan[] {
  const byEnd = [...spans].sort((a, b) => a.endedAt.localeCompare(b.endedAt));
  const path: StepSpan[] = [];
  let current = byEnd.at(-1);
  let index = byEnd.length - 1;
  while (current) {
    path.unshift(current);
    const startedAt = current.startedAt;
    while (index >= 0 && byEnd[index]!.endedAt > startedAt) index--;
    current = index >= 0 ? byEnd[index] : undefined;
    index--;
  }
  return path;
}

export function usageText(usage: Usage): string {
  const t = usage.tokens;
  return [
    `${usage.calls} calls`,
    `${count(t.total)} tokens (in ${count(t.input)}, cached ${count(t.cached)}, cache writes ${count(t.cacheWrite)}, out ${count(t.output)}, reasoning ${count(t.reasoning)})${usage.tokensUnknown ? `, ${usage.tokensUnknown} calls unreported` : ""}`,
    usage.costUsd === null
      ? "cost unknown"
      : `$${usage.costUsd.toFixed(2)}${usage.costUnknown ? ` (+${usage.costUnknown} calls unknown)` : ""}`,
    `model time ${duration(usage.ms)}`,
  ].join(" · ");
}

function spanText(span: StepSpan): string {
  return `${span.step} ${span.outcome} · ${duration(span.ms)} · started ${displayTime(span.startedAt)}`;
}

/** The summary for people. */
export function summaryText(report: SummaryReport): string {
  const lines = [
    `Diagnostics summary #${report.issue} · ${report.runs.length} run${report.runs.length === 1 ? "" : "s"}${report.from ? ` · ${displayTime(report.from)} to ${displayTime(report.to!)} (${duration(report.wallMs)})` : ""}`,
  ];
  if (!report.runs.length) return `${lines[0]}\nNo run log yet.\n`;
  const section = (title: string, rows: string[]) => {
    lines.push("", title, ...(rows.length ? rows : ["  none"]));
  };
  section(
    "By role:",
    Object.entries(report.roles).map(
      ([role, usage]) => `  ${role}: ${usageText(usage)}`,
    ),
  );
  section(
    "By phase:",
    Object.entries(report.phases).map(
      ([phase, usage]) =>
        `  ${phase}: ${usage.steps} steps, ${duration(usage.stepMs)} wall${usage.calls ? ` · ${usageText(usage)}` : ""}`,
    ),
  );
  section(
    "Repairs:",
    Object.entries(report.repairs).map(([item, n]) => `  ${item}: ${n}`),
  );
  section(
    `Holds (answered after ${duration(report.holdWaitMs)} in all):`,
    report.holds.map(
      (hold) =>
        `  ${hold.step ?? "objective"}${hold.cause === "failure" ? " (failure)" : ""} asked ${displayTime(hold.askedAt)} · ${hold.answeredAt ? `${hold.answer} by ${hold.by ?? "?"} after ${duration(hold.waitMs ?? 0)}` : "no answer logged"}`,
    ),
  );
  section(
    `Critical path (${duration(report.criticalPathMs)} of steps; walking back from the last step to end):`,
    report.criticalPath.map((span) => `  ${spanText(span)}`),
  );
  section(
    "Slowest steps:",
    report.slowest.map((span) => `  ${spanText(span)}`),
  );
  return `${lines.join("\n")}\n`;
}
