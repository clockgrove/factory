/**
 * `factory watch [ISSUE]`: a compact live view of running work, one row
 * per Work Item, from the run log alone (`worker-activity`, step and hold
 * events). It follows the log like `factory log --follow` and never writes
 * state.
 */
import { displayTime, redactDeep } from "./display.js";
import { itemOf } from "./engine.js";
import {
  type LogEvent,
  loggedIssues,
  readLog,
  readNew,
  untilInterrupted,
} from "./log.js";

/** Events read back per Objective to start the view. */
const BACKLOG = 500;
/** Without an issue, Objectives whose log is quiet this long are left out. */
const QUIET_MS = 24 * 60 * 60 * 1000;
/** A terminal redraws at least this often, so ages stay current. */
const REDRAW_MS = 5_000;
/** A running worker without progress this long shows how long. */
const QUIET_PROGRESS_MS = 15 * 60_000;

interface Totals {
  toolsStarted: number;
  toolsFinished: number;
  edits: number;
  commands: number;
  commandsFailed: number;
  turns: number;
  compactions: number;
}

/** One Work Item's line (or the Objective's own steps, item `-`). */
interface Row {
  issue: number;
  item: string;
  /** The step's phase, such as `work` or `review`. */
  phase: string;
  /** `running`, or the last outcome: `done`, `retry`, `hold`, ... */
  state: string;
  reason?: string;
  at: string;
  /** The running step's activity so far, from its `worker-activity` events. */
  totals?: Totals;
  tools?: string[];
  paths?: string[];
  command?: string;
  activityAt?: string;
  /** The worker's last reported context; absent: its provider reported none. */
  context?: { tokens: number; window?: number };
  /** The step's start, or its last edit, finished tool or validation run. */
  progressAt?: string;
  /** The item's first failed validation since it last passed. */
  failingSince?: string;
  /** Planner-seam calls running for it, by call id (`model-call`, `model-progress`). */
  calls?: Record<string, LiveCallRow>;
}

/** A running planner or reviewer call, as watch shows it. */
interface LiveCallRow {
  role: string;
  phase?: string;
  provider?: string;
  model?: string;
  effort?: string;
  startedAt: string;
  tokens?: number;
  window?: number;
  turns: number;
}

export interface WatchOutput {
  write(text: string): void;
  /** A terminal is redrawn in place; anything else gets a line per change. */
  isTTY?: boolean;
}

/** Follow the run log of `issue`, or of every recently active Objective, until interrupted. */
export async function watch(
  logs: string,
  issue: number | undefined,
  secrets: readonly string[],
  out: WatchOutput,
): Promise<void> {
  const rows = new Map<string, Row>();
  const offsets = new Map<number, Map<string, number>>();
  const changed = new Set<string>();
  const apply = (from: number, events: LogEvent[]) => {
    for (const event of events) {
      const key = applyEvent(rows, from, redactDeep(event, secrets));
      if (key) changed.add(key);
    }
  };
  const start = Date.now();
  const discover = () => {
    for (const found of issue === undefined ? loggedIssues(logs) : [issue]) {
      if (offsets.has(found)) continue;
      const { events, ends } = readLog(logs, found, BACKLOG);
      offsets.set(found, ends);
      const last = events.at(-1);
      // Quiet at start: left out, but followed from here on.
      if (issue === undefined && last && start - Date.parse(last.at) > QUIET_MS)
        continue;
      apply(found, events);
    }
  };
  let drawnAt = 0;
  const render = () => {
    if (out.isTTY) {
      if (!changed.size && Date.now() - drawnAt < REDRAW_MS) return;
      drawnAt = Date.now();
      out.write(`\x1b[H\x1b[2J${view([...rows.values()], issue)}`);
    } else
      for (const key of changed) {
        const row = rows.get(key);
        if (row) out.write(`${rowLine(row)}\n`);
      }
    changed.clear();
  };
  discover();
  if (!out.isTTY && !rows.size)
    out.write(
      `No running work in the run log${issue === undefined ? "" : ` of #${issue}`} yet; waiting for it.\n`,
    );
  render();
  await untilInterrupted(() => {
    discover();
    for (const [found, ends] of offsets)
      apply(found, readNew(logs, found, ends));
    render();
  });
}

/** Fold one event into the rows; the key of the row it changed, if any. */
function applyEvent(
  rows: Map<string, Row>,
  issue: number,
  event: LogEvent,
): string | undefined {
  const step = typeof event.step === "string" ? event.step : undefined;
  const item =
    (typeof event.item === "string" ? event.item : undefined) ??
    (step ? itemOf(step) : undefined) ??
    "-";
  const key = `${issue}:${item}`;
  const row = rows.get(key) ?? {
    issue,
    item,
    phase: "",
    state: "",
    at: event.at,
  };
  switch (event.event) {
    case "start":
      if (!step) return undefined;
      // A new step: its activity starts again; failing validation stays.
      rows.set(key, {
        issue,
        item,
        phase: phaseOf(step),
        state: "running",
        at: event.at,
        progressAt: event.at,
        ...(row.failingSince ? { failingSince: row.failingSince } : {}),
      });
      return key;
    case "outcome":
      if (!step) return undefined;
      row.phase = phaseOf(step);
      // A call its step outlived (cancelled, past its deadline) ran no more.
      delete row.calls;
      row.state = String(event.outcome ?? "ended");
      row.at = event.at;
      if (typeof event.reason === "string") row.reason = event.reason;
      else delete row.reason;
      if (phaseOf(step) === "validate" && event.outcome === "done")
        delete row.failingSince;
      break;
    // Validation: Factory's validate step and a worker's own Validate.
    case "validation-result":
    case "worker-validate":
      row.progressAt = event.at;
      if (event.passed === false) row.failingSince ??= event.at;
      // One command passing isn't the run passing; a whole Validate is.
      else if (event.event === "worker-validate" && event.passed === true)
        delete row.failingSince;
      if (!row.phase && step) row.phase = phaseOf(step);
      row.state ||= "running";
      break;
    case "worker-activity": {
      const counts = (event.counts ?? {}) as Partial<Totals>;
      const totals = row.totals ?? {
        toolsStarted: 0,
        toolsFinished: 0,
        edits: 0,
        commands: 0,
        commandsFailed: 0,
        turns: 0,
        compactions: 0,
      };
      for (const name of Object.keys(totals) as (keyof Totals)[])
        totals[name] += Number(counts[name] ?? 0);
      row.totals = totals;
      if (Array.isArray(event.tools) && event.tools.length)
        row.tools = event.tools.map(String);
      if (Array.isArray(event.paths) && event.paths.length)
        row.paths = event.paths.map(String);
      if (typeof event.command === "string") row.command = event.command;
      const context = event.context as Row["context"] | undefined;
      if (typeof context?.tokens === "number")
        row.context = {
          tokens: context.tokens,
          ...(typeof context.window === "number"
            ? { window: context.window }
            : {}),
        };
      if (counts.edits || counts.toolsFinished) row.progressAt = event.at;
      row.activityAt = event.at;
      if (!row.phase && step) row.phase = phaseOf(step);
      if (!row.state) row.state = "running";
      break;
    }
    // A planner or reviewer call: shown while it runs, until its model-usage.
    case "model-call": {
      if (typeof event.callId !== "string") return undefined;
      row.calls = {
        ...row.calls,
        [event.callId]: {
          role: String(event.role ?? "model"),
          ...(typeof event.phase === "string" ? { phase: event.phase } : {}),
          ...(typeof event.provider === "string"
            ? { provider: event.provider }
            : {}),
          ...(typeof event.model === "string" ? { model: event.model } : {}),
          ...(typeof event.effort === "string" ? { effort: event.effort } : {}),
          startedAt: event.at,
          turns: 0,
        },
      };
      if (!row.phase && step) row.phase = phaseOf(step);
      row.state ||= "running";
      break;
    }
    case "model-progress": {
      const call =
        typeof event.callId === "string"
          ? row.calls?.[event.callId]
          : undefined;
      if (!call) return undefined;
      if (typeof event.tokens === "number") call.tokens = event.tokens;
      if (typeof event.window === "number") call.window = event.window;
      if (typeof event.turns === "number") call.turns = event.turns;
      break;
    }
    case "model-usage":
      if (typeof event.callId !== "string" || !row.calls?.[event.callId])
        return undefined;
      delete row.calls[event.callId];
      break;
    case "cancelled":
      row.phase ||= "objective";
      row.state = "cancelled";
      row.at = event.at;
      break;
    default:
      return undefined;
  }
  rows.set(key, row);
  return key;
}

/** `item:a:work` is `work`; an Objective step is its key. */
function phaseOf(step: string): string {
  return itemOf(step) ? step.split(":").slice(2).join(":") : step;
}

/** The whole view, for a terminal. */
function view(rows: Row[], issue: number | undefined): string {
  const header = `Factory watch${issue === undefined ? "" : ` #${issue}`} · ${displayTime(new Date().toISOString())} · Ctrl-C to stop\n\n`;
  if (!rows.length) return `${header}No running work in the run log yet.\n`;
  return (
    header +
    rows
      .sort((a, b) => a.issue - b.issue || a.item.localeCompare(b.item))
      .map((row) => `${rowLine(row)}\n`)
      .join("")
  );
}

/**
 * One row: `#54 a work running for 2m · 4 turns · 9 tools (Edit, Bash) · 3
 * edits (src/a.ts) · $ npm test · context 84K/272K (31%) · 1 compaction ·
 * no progress for 3m · validation failing for 9m · active 12s ago`.
 */
function rowLine(row: Row, now = Date.now()): string {
  const since =
    row.state === "running"
      ? `for ${age(now, row.at)}`
      : `${age(now, row.at)} ago`;
  const parts = [
    `#${row.issue} ${row.item} ${row.phase} ${row.state} ${since}${row.reason ? `: ${row.reason}` : ""}`,
  ];
  const totals = row.totals;
  if (totals) {
    if (totals.turns) parts.push(`${totals.turns} turns`);
    if (totals.toolsStarted)
      parts.push(
        `${totals.toolsStarted} tools${row.tools ? ` (${row.tools.join(", ")})` : ""}`,
      );
    if (totals.edits)
      parts.push(
        `${totals.edits} edits${row.paths ? ` (${row.paths.join(", ")})` : ""}`,
      );
    if (row.command) parts.push(`$ ${row.command}`);
    if (totals.commandsFailed)
      parts.push(`${totals.commandsFailed} failed commands`);
    // A provider that never reports its context is unknown, never zero.
    if (row.context) {
      const { tokens, window } = row.context;
      parts.push(
        `context ${kilo(tokens)}${window ? `/${kilo(window)} (${Math.round((tokens / window) * 100)}%)` : ""}`,
      );
      if (totals.compactions)
        parts.push(
          `${totals.compactions} compaction${totals.compactions === 1 ? "" : "s"}`,
        );
    } else parts.push("context and compactions unknown");
  }
  if (row.state === "running" && totals) {
    const quiet = now - Date.parse(row.progressAt ?? row.at);
    if (quiet >= QUIET_PROGRESS_MS)
      parts.push(`no progress for ${age(now, row.progressAt ?? row.at)}`);
  }
  if (row.failingSince)
    parts.push(`validation failing for ${age(now, row.failingSince)}`);
  if (totals && row.activityAt)
    parts.push(`active ${age(now, row.activityAt)} ago`);
  for (const call of Object.values(row.calls ?? {}))
    parts.push(liveCallText(call, now));
  return parts.join(" · ");
}

/** `reviewer result-review codex gpt-6.1-sol high for 2m, 3 turns, context 84K/272K`. */
function liveCallText(call: LiveCallRow, now: number): string {
  const name = [call.role, call.phase, call.provider, call.model, call.effort]
    .filter(Boolean)
    .join(" ");
  const context =
    call.tokens === undefined
      ? "context unknown"
      : `context ${kilo(call.tokens)}${call.window ? `/${kilo(call.window)}` : ""}`;
  return `${name} for ${age(now, call.startedAt)}, ${call.turns} turn${call.turns === 1 ? "" : "s"}, ${context}`;
}

/** A token count: `840`, `84K`, `1.2M`. */
function kilo(tokens: number): string {
  if (tokens < 1_000) return String(tokens);
  if (tokens < 1_000_000) return `${Math.round(tokens / 1_000)}K`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

/** A short duration since `at`: `12s`, `4m`, `2h`. */
function age(now: number, at: string): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(at)) / 1000));
  if (seconds < 120) return `${seconds}s`;
  if (seconds < 7200) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
}
