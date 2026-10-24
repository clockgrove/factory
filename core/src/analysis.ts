/**
 * `factory diagnostics ISSUE --captures | --analyze | --gantt`: the
 * captured model calls, the analysis views and a text Gantt chart of an
 * Objective's run(s), from the run log alone (docs/reference/run-log.md#Run log). Every
 * event is redacted as it is read (diagnostics.ts readRun); a capture is
 * read without following links and redacted again. It never writes.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  addUsage,
  chosenFiles,
  count,
  emptyUsage,
  itemOfEvent,
  num,
  phaseOf,
  type RunChoice,
  readCapture,
  readRun,
  str,
  type Usage,
  usageText,
} from "./diagnostics.js";
import { displayTime, duration } from "./display.js";
import { itemOf } from "./engine.js";
import { type LogEvent, runOfFile, sizeOf } from "./log.js";
import { CAPTURE_ID, captureFile } from "./paths.js";

export interface AnalysisRead {
  logs: string;
  issue: number;
  runs: RunChoice;
  json?: boolean;
  secrets: readonly string[];
}

/** Stream the chosen runs' events, oldest run first. */
function readChosen(options: AnalysisRead, visit: (e: LogEvent) => void) {
  const files = chosenFiles(options.logs, options.issue, options.runs);
  for (const file of files) readRun(file, 0, options.secrets, visit);
  return files.map(runOfFile);
}

// --- captures -------------------------------------------------------------

export interface CaptureRow {
  id: string;
  run: string;
  at: string;
  role?: string;
  phase?: string;
  item?: string;
  step?: string;
  provider?: string;
  model?: string;
  /** The file's size; null when it was rotated away. */
  bytes: number | null;
  path: string;
}

/** The model calls the chosen runs captured, from their `model-usage` events. */
export function captureRows(options: AnalysisRead): {
  runs: string[];
  rows: CaptureRow[];
} {
  const rows: CaptureRow[] = [];
  const runs = readChosen(options, (event) => {
    if (event.event !== "model-usage") return;
    const id = str(event.capture);
    const run = String(event.run);
    const file = id ? captureFile(options.issue, run, id) : undefined;
    if (!id || !file) return;
    const path = join(options.logs, file);
    const step = str(event.step);
    const item = itemOfEvent(event);
    rows.push({
      id,
      run,
      at: event.at,
      ...pick(event, ["role", "phase", "provider", "model"]),
      ...(item ? { item } : {}),
      ...(step ? { step } : {}),
      bytes: existsSync(path) ? sizeOf(path) : null,
      path,
    });
  });
  return { runs, rows };
}

function pick(
  event: LogEvent,
  names: readonly string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of names) {
    const value = str(event[name]);
    if (value !== undefined) out[name] = value;
  }
  return out;
}

const size = (bytes: number | null) =>
  bytes === null
    ? "rotated away"
    : bytes < 1024
      ? `${bytes} B`
      : bytes < 1024 * 1024
        ? `${(bytes / 1024).toFixed(1)} KiB`
        : `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

/**
 * `--captures`: list the captured calls; with `id` (`--content ID`), print
 * that one's bodies, from any run. Returns why it can't, for a refusal.
 */
export function captures(
  options: AnalysisRead & { id?: string },
  write: (text: string) => void,
): string | undefined {
  const { runs, rows } = captureRows(
    options.id === undefined ? options : { ...options, runs: { kind: "all" } },
  );
  if (options.id !== undefined) {
    const row = CAPTURE_ID.test(options.id)
      ? rows.find((candidate) => candidate.id === options.id)
      : undefined;
    const file = row && captureFile(options.issue, row.run, row.id);
    const body = file && readCapture(options.logs, file, options.secrets);
    if (!row || !body)
      return `#${options.issue} has no capture ${options.id}: \`factory diagnostics ${options.issue} --captures --all-runs\` lists them; retention removes a run's captures with its log.`;
    if (options.json) {
      write(`${JSON.stringify({ ...row, ...body })}\n`);
      return undefined;
    }
    write(`${rowText(row)}\n`);
    if (body.request !== undefined) write(`request:\n${body.request}\n`);
    if (body.response !== undefined) write(`response:\n${body.response}\n`);
    if (body.truncated) write("(cut to capture.maxBytesPerCall)\n");
    return undefined;
  }
  if (options.json) {
    write(
      `${JSON.stringify({ issue: options.issue, runs, captures: rows })}\n`,
    );
    return undefined;
  }
  if (!rows.length) {
    write(
      `No captured model calls for #${options.issue}${runs.length ? ` in run ${runs.join(", ")}` : ""}: full requests and responses are kept only with capture.enabled (docs/reference/run-log.md#Content capture).\n`,
    );
    return undefined;
  }
  write(
    `Captured model calls for #${options.issue} · ${rows.length} in ${runs.length} run${runs.length === 1 ? "" : "s"} (--content ID prints one)\n`,
  );
  for (const row of rows) write(`  ${rowText(row)}\n`);
  return undefined;
}

function rowText(row: CaptureRow): string {
  return [
    row.id,
    [row.role ?? "?", row.phase].filter(Boolean).join(" "),
    row.item ? `item ${row.item}` : "objective",
    [row.provider, row.model].filter(Boolean).join(" ") || undefined,
    displayTime(row.at),
    size(row.bytes),
    row.path,
  ]
    .filter(Boolean)
    .join(" · ");
}

// --- analyze --------------------------------------------------------------

/** What `--group-by` and `--filter` take: fields of a `model-usage` event. */
export const ANALYSIS_FIELDS = [
  "run",
  "item",
  "phase",
  "role",
  "provider",
  "model",
  "effort",
  "outcome",
  "tokenSource",
  "hedge",
  "reportedModel",
  "stage",
  "sessionMode",
  "currency",
] as const;
export type AnalysisField = (typeof ANALYSIS_FIELDS)[number];
/** The fields a step attempt has too: other filters select model calls only. */
const STEP_FIELDS: readonly AnalysisField[] = ["run", "item", "phase"];

export interface AnalyzeOptions extends AnalysisRead {
  groupBy: AnalysisField[];
  /** FIELD=VALUE; `null` matches a missing value. */
  filters: Partial<Record<AnalysisField, string>>;
}

/** A model call's value for `field`, as a filter compares it; "null" when missing. */
function callField(event: LogEvent, field: AnalysisField): string {
  const step = str(event.step);
  const value =
    field === "item"
      ? itemOfEvent(event)
      : field === "phase"
        ? (str(event.phase) ?? (step ? phaseOf(step) : str(event.role)))
        : field === "hedge"
          ? String(num(event.hedge) ?? 0)
          : event[field];
  return value === undefined || value === null ? "null" : String(value);
}

/** Cache effectiveness: cached over input of the calls that report both. Never an average of rates. */
export interface Cache {
  pairedCalls: number;
  eligibleCalls: number;
  input: number;
  cached: number;
  uncachedInput: number;
  hitRate: number | null;
}

/** One tool view (`nativeToolActivity` or `sdkOperations`): never added to the other. */
export interface ToolView {
  calls: number;
  byName: Record<string, number>;
  /** Calls that reported this view (non-null). */
  reportedCalls: number;
  eligibleCalls: number;
  /** Codex calls whose session record was past its read bound (`nativePartial`). */
  partialCalls?: number;
}

/** Native tool calls beyond their names (usage.ts NativeTools), summed over the calls that report them. */
export interface ToolStats {
  reportedCalls: number;
  rounds: number;
  outputs: number;
  failures: number;
  missingOutputs: number;
  ms: number;
}

const CATEGORIES = ["input", "output", "cached", "reasoning", "total"] as const;

export interface CallGroup {
  key: Partial<Record<AnalysisField, string>>;
  usage: Usage;
  /** Per token category, the calls that reported it: a sum covers only these. */
  tokenCalls: Record<(typeof CATEGORIES)[number], number>;
  cache: Cache;
  nativeTools: ToolView;
  sdkOperations: ToolView;
  outcomes: Record<string, number>;
  /** Failed calls by stage (provider, parse, protocol), and answers refused by Factory's checks (semantic). */
  stages: Record<string, number>;
  /** The model as the provider reported it, by calls; `unreported` when it didn't. */
  reportedModels: Record<string, number>;
  /** Calls whose reported model differs from the one asked for. */
  modelMismatches: number;
  hedged: number;
  toolStats: ToolStats;
  /** Request bytes as sent, and per prompt part (`prompt`, `schema`, `images`, and the builder's sections). */
  request: {
    reportedCalls: number;
    bytes: number;
    components: Record<string, number>;
  };
  /** Distinct prompt, schema and source digests: a repeated prompt shows as fewer distinct than calls. */
  digests: { prompts: number; schemas: number; sources: number };
  firstToken: { reportedCalls: number; ms: number; meanMs: number | null };
  /** Calls by session mode (`fresh`, `resumed`), and the highest session turn seen. */
  sessions: Record<string, number>;
  maxSessionTurn: number;
  imageOutputs: { reportedCalls: number; total: number };
  /** Calls with the provider's own usage breakdown (`providerUsage`). */
  providerUsageCalls: number;
  /** Calls by the currency of their cost; `unknown` without a cost. */
  currencies: Record<string, number>;
  efficiency: {
    msPerCall: number | null;
    tokensPerCall: number | null;
    outputTokensPerMinute: number | null;
    costPerCallUsd: number | null;
  };
}

/** One step attempt, from its `start` to its `outcome` (or its run's last event). */
export interface Attempt {
  run: string;
  step: string;
  item?: string;
  phase: string;
  startedAt: string;
  endedAt: string;
  ms: number;
  outcome: string;
  wait?: string;
  reason?: string;
  /** An error retry, or a hold with the cause `failure`. */
  failed?: true;
  /** `<step>#<n>` (engine.ts), and the attempt it continues (a continuation, a repair, an interrupted attempt). */
  id?: string;
  parentId?: string;
}

/** One run's formal history (log.ts RunLog): its header, its sequence, its log health and how it ended. */
export interface RunHistory {
  run: string;
  factoryVersion?: string | null;
  sourceDigest?: string | null;
  /** Lines with a `seq`; `gaps`: numbers missing below the highest (lost lines); `unsequenced`: lines without one. */
  lines: number;
  gaps: number;
  unsequenced: number;
  /** The run's last `log-health` (emitted, failed, lost); absent when no write failed and the run hasn't ended. */
  health?: { emitted: number; failed: number; lost: number };
  /** `stopped`, `handed-off` or `crashed` (`run-end`); absent while it runs, or for a run that died before the next start saw it. */
  end?: string;
}

export interface AnalysisReport {
  issue: number;
  runs: string[];
  from?: string;
  to?: string;
  wallMs: number;
  groupBy: AnalysisField[];
  filters: Partial<Record<AnalysisField, string>>;
  calls: CallGroup;
  groups: CallGroup[];
  /** Per phase: attempts, outcomes, wall time (overlaps once) and summed attempt time. */
  phases: Record<
    string,
    {
      attempts: number;
      outcomes: Record<string, number>;
      wallMs: number;
      attemptMs: number;
    }
  >;
  /** Where the wall time went; each a union, so overlaps count once. */
  time: {
    stepsMs: number;
    retryWaitMs: number;
    holdWaitMs: number;
    modelMs: number;
    validationMs: number;
    /** No step running, waiting or held. */
    idleMs: number;
  };
  retries: {
    waits: number;
    /** By wait class (error, reset, gate); `unclassed` before the log carried it. */
    byWait: Record<string, number>;
    continuations: number;
    waitMs: number;
    /** Retries whose step hadn't started again when the log ends. */
    open: number;
    byStep: Record<string, number>;
  };
  repairs: {
    total: number;
    byItem: Record<string, number>;
    byTarget: Record<string, number>;
  };
  holds: {
    asked: number;
    failures: number;
    answered: number;
    open: number;
    waitMs: number;
    byAnswer: Record<string, number>;
  };
  validation: {
    commands: number;
    failed: number;
    ms: number;
    byStep: Record<string, { commands: number; failed: number }>;
  };
  activity: Record<
    string,
    {
      turns: number;
      toolsStarted: number;
      edits: number;
      commands: number;
      commandsFailed: number;
    }
  >;
  /** The old formal history's checks, on step attempts (start paired with outcome). */
  history: {
    attempts: number;
    failedAttempts: { run: string; step: string; startedAt: string }[];
    hasFailedAttempt: boolean;
    unfinished: number;
    /** An outcome with no start before it in its run. */
    outcomesWithoutStart: number;
    /** A start while the same step's earlier start had no outcome in its run. */
    startsWithoutOutcome: number;
    aborted: number;
    phases: string[];
    lifecycle: {
      run: string;
      at: string;
      event: string;
      step?: string;
      outcome?: string;
    }[];
    completeness: "paired" | "unknown";
    reasons: string[];
    runs: RunHistory[];
    /** Attempts that continue another (`parentAttemptId`). */
    continued: number;
  };
  /** GitHub requests of the run (`github-call`: sync jobs, step attempts, the service's own), summed: counts, never bodies. */
  github: {
    jobs: number;
    runs: number;
    calls: number;
    retries: number;
    rateLimited: number;
    failed: number;
    bytes: number;
    /** Sync job runs' time. */
    ms: number;
    /** The requests' own time. */
    requestMs: number;
    /** Requests traced one by one (`github-request`), by status (or `network`) and failure category. */
    traced: Record<string, number>;
  };
  limitations: string[];
}

const LIFECYCLE = new Set([
  "admitted",
  "cancelled",
  "withdrawn",
  "dequeued",
  "run-dequeued",
  "reset-started",
  "hold",
]);

function emptyGroup(key: CallGroup["key"]): CallGroup {
  const tools = (): ToolView => ({
    calls: 0,
    byName: {},
    reportedCalls: 0,
    eligibleCalls: 0,
  });
  return {
    key,
    usage: emptyUsage(),
    tokenCalls: { input: 0, output: 0, cached: 0, reasoning: 0, total: 0 },
    cache: {
      pairedCalls: 0,
      eligibleCalls: 0,
      input: 0,
      cached: 0,
      uncachedInput: 0,
      hitRate: null,
    },
    nativeTools: { ...tools(), partialCalls: 0 },
    sdkOperations: tools(),
    outcomes: {},
    stages: {},
    reportedModels: {},
    modelMismatches: 0,
    hedged: 0,
    toolStats: {
      reportedCalls: 0,
      rounds: 0,
      outputs: 0,
      failures: 0,
      missingOutputs: 0,
      ms: 0,
    },
    request: { reportedCalls: 0, bytes: 0, components: {} },
    digests: { prompts: 0, schemas: 0, sources: 0 },
    firstToken: { reportedCalls: 0, ms: 0, meanMs: null },
    sessions: {},
    maxSessionTurn: 0,
    imageOutputs: { reportedCalls: 0, total: 0 },
    providerUsageCalls: 0,
    currencies: {},
    efficiency: {
      msPerCall: null,
      tokensPerCall: null,
      outputTokensPerMinute: null,
      costPerCallUsd: null,
    },
  };
}

/** Running sums the efficiency figures need, and the digests seen, beside the group. */
interface Rates {
  output: number;
  outputMs: number;
  totalCalls: number;
  digests: { prompts: Set<string>; schemas: Set<string>; sources: Set<string> };
}

const emptyRates = (): Rates => ({
  output: 0,
  outputMs: 0,
  totalCalls: 0,
  digests: { prompts: new Set(), schemas: new Set(), sources: new Set() },
});

function addTools(view: ToolView, value: unknown): void {
  view.eligibleCalls += 1;
  const tally = value as { total?: unknown; byName?: unknown } | null;
  if (!tally || typeof tally !== "object") return;
  view.reportedCalls += 1;
  view.calls += num(tally.total) ?? 0;
  if (tally.byName && typeof tally.byName === "object")
    for (const [name, n] of Object.entries(tally.byName))
      view.byName[name] = (view.byName[name] ?? 0) + (num(n) ?? 0);
}

function addCall(group: CallGroup, rates: Rates, event: LogEvent): void {
  addUsage(group.usage, event);
  const tokens = (event.tokens ?? {}) as Record<string, unknown>;
  const input = num(tokens.input);
  const cached = num(tokens.cached);
  const output = num(tokens.output);
  const ms = num(event.ms);
  for (const category of CATEGORIES)
    if (num(tokens[category]) !== undefined) group.tokenCalls[category] += 1;
  group.cache.eligibleCalls += 1;
  if (input !== undefined && cached !== undefined) {
    group.cache.pairedCalls += 1;
    group.cache.input += input;
    group.cache.cached += cached;
    group.cache.uncachedInput += Math.max(0, input - cached);
  }
  if (num(tokens.total) !== undefined) rates.totalCalls += 1;
  if (output !== undefined && ms !== undefined && ms > 0) {
    rates.output += output;
    rates.outputMs += ms;
  }
  addTools(group.nativeTools, event.nativeToolActivity);
  if (event.nativePartial === true)
    group.nativeTools.partialCalls = (group.nativeTools.partialCalls ?? 0) + 1;
  addTools(group.sdkOperations, event.sdkOperations);
  const outcome = str(event.outcome) ?? "unknown";
  group.outcomes[outcome] = (group.outcomes[outcome] ?? 0) + 1;
  const stage = str(event.stage);
  if (stage) bump(group.stages, stage);
  const reported = str(event.reportedModel);
  bump(group.reportedModels, reported ?? "unreported");
  if (reported && str(event.model) && reported !== event.model)
    group.modelMismatches += 1;
  if (num(event.hedge)) group.hedged += 1;
  const tools = event.nativeTools as Record<string, unknown> | undefined;
  if (tools && typeof tools === "object") {
    const t = group.toolStats;
    t.reportedCalls += 1;
    t.rounds += num(tools.rounds) ?? 0;
    t.outputs += num(tools.outputs) ?? 0;
    t.failures += num(tools.failures) ?? 0;
    t.missingOutputs += num(tools.missingOutputs) ?? 0;
    t.ms += num(tools.ms) ?? 0;
  }
  const bytes = num(event.requestBytes);
  if (bytes !== undefined) {
    group.request.reportedCalls += 1;
    group.request.bytes += bytes;
    const parts = (event.promptComponents ?? {}) as Record<string, unknown>;
    for (const [part, value] of Object.entries(parts))
      if (typeof value === "number")
        bump(group.request.components, part, value);
      else if (value && typeof value === "object")
        for (const [section, n] of Object.entries(value))
          if (typeof n === "number")
            bump(group.request.components, `${part}.${section}`, n);
  }
  for (const [field, kind] of [
    ["promptDigest", "prompts"],
    ["schemaDigest", "schemas"],
    ["sourceDigest", "sources"],
  ] as const) {
    const digest = str(event[field]);
    if (digest) rates.digests[kind].add(digest);
  }
  const ttft = num(event.timeToFirstTokenMs);
  if (ttft !== undefined) {
    group.firstToken.reportedCalls += 1;
    group.firstToken.ms += ttft;
  }
  const mode = str(event.sessionMode);
  if (mode) bump(group.sessions, mode);
  group.maxSessionTurn = Math.max(
    group.maxSessionTurn,
    num(event.sessionTurn) ?? 0,
  );
  const images = num(event.imageOutputs);
  if (images !== undefined) {
    group.imageOutputs.reportedCalls += 1;
    group.imageOutputs.total += images;
  }
  if (event.providerUsage && typeof event.providerUsage === "object")
    group.providerUsageCalls += 1;
  bump(group.currencies, str(event.currency) ?? "unknown");
}

function settle(group: CallGroup, rates: Rates): CallGroup {
  const { cache, usage, efficiency } = group;
  group.digests = {
    prompts: rates.digests.prompts.size,
    schemas: rates.digests.schemas.size,
    sources: rates.digests.sources.size,
  };
  group.firstToken.meanMs = group.firstToken.reportedCalls
    ? Math.round(group.firstToken.ms / group.firstToken.reportedCalls)
    : null;
  cache.hitRate =
    cache.input > 0
      ? Math.round((cache.cached / cache.input) * 10_000) / 10_000
      : null;
  efficiency.msPerCall = usage.calls
    ? Math.round(usage.ms / usage.calls)
    : null;
  efficiency.tokensPerCall = rates.totalCalls
    ? Math.round(usage.tokens.total / rates.totalCalls)
    : null;
  efficiency.outputTokensPerMinute = rates.outputMs
    ? Math.round((rates.output / rates.outputMs) * 60_000)
    : null;
  const costed = usage.calls - usage.costUnknown;
  efficiency.costPerCallUsd =
    usage.costUsd === null || !costed
      ? null
      : Math.round((usage.costUsd / costed) * 10_000) / 10_000;
  return group;
}

type Interval = [number, number];

/** The length of the union of `intervals`: overlaps count once. */
function unionMs(intervals: Interval[]): number {
  const sorted = intervals
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0]);
  let total = 0;
  let end = -Infinity;
  for (const [a, b] of sorted) {
    if (b <= end) continue;
    total += b - Math.max(a, end);
    end = b;
  }
  return total;
}

const bump = (map: Record<string, number>, key: string, by = 1): void => {
  map[key] = (map[key] ?? 0) + by;
};

/** Folds events into the analysis; it keeps one record per call group, attempt and hold. */
class Analysis {
  private readonly calls: { group: CallGroup; rates: Rates };
  private readonly groups = new Map<
    string,
    { group: CallGroup; rates: Rates }
  >();
  private readonly attempts: Attempt[] = [];
  private readonly open = new Map<string, LogEvent>();
  /** A step's last retry outcome, until its next start. */
  private readonly retrying = new Map<string, number>();
  private readonly retryWaits: Interval[] = [];
  private readonly holds = new Map<
    string,
    { at: number; answered?: number; answer?: string }
  >();
  private readonly models: Interval[] = [];
  private readonly validations: Interval[] = [];
  private readonly lastAt = new Map<string, string>();
  private readonly runOrder: string[] = [];
  private readonly lifecycle = new Map<
    string,
    AnalysisReport["history"]["lifecycle"][number]
  >();
  /** Steps whose `hold` (cause failure) came before their outcome. */
  private readonly failing = new Set<string>();
  /** Per run: its formal history, and the sequence numbers seen. */
  private readonly runHistory = new Map<
    string,
    { history: RunHistory; seqs: Set<number>; maxSeq: number }
  >();
  /** Each model call's groups, by `callId`, for the semantic refusals that name it. */
  private readonly callGroups = new Map<string, CallGroup[]>();
  private readonly githubJobs = new Set<string>();
  private readonly github: AnalysisReport["github"] = {
    jobs: 0,
    runs: 0,
    calls: 0,
    retries: 0,
    rateLimited: 0,
    failed: 0,
    bytes: 0,
    ms: 0,
    requestMs: 0,
    traced: {},
  };
  private from?: string;
  private to?: string;
  private outcomesWithoutStart = 0;
  private startsWithoutOutcome = 0;
  private aborted = 0;
  private readonly retries: AnalysisReport["retries"] = {
    waits: 0,
    byWait: {},
    continuations: 0,
    waitMs: 0,
    open: 0,
    byStep: {},
  };
  private readonly repairs: AnalysisReport["repairs"] = {
    total: 0,
    byItem: {},
    byTarget: {},
  };
  private readonly holdCounts = { asked: 0, failures: 0 };
  private readonly validation: AnalysisReport["validation"] = {
    commands: 0,
    failed: 0,
    ms: 0,
    byStep: {},
  };
  private readonly activity: AnalysisReport["activity"] = {};

  constructor(private readonly options: AnalyzeOptions) {
    this.calls = {
      group: emptyGroup({}),
      rates: emptyRates(),
    };
  }

  /** A step-level event passes the run, item and phase filters. */
  private stepPasses(event: LogEvent): boolean {
    for (const field of STEP_FIELDS) {
      const expected = this.options.filters[field];
      if (expected === undefined) continue;
      const step = str(event.step);
      const value =
        field === "run"
          ? String(event.run)
          : field === "item"
            ? (itemOfEvent(event) ?? "null")
            : step
              ? phaseOf(step)
              : "null";
      if (value !== expected) return false;
    }
    return true;
  }

  add(event: LogEvent): void {
    const run = String(event.run);
    if (!this.lastAt.has(run)) this.runOrder.push(run);
    this.lastAt.set(run, event.at);
    this.from ??= event.at;
    this.to = event.at;
    const at = Date.parse(event.at);
    const step = str(event.step);
    this.formal(run, event);
    if (LIFECYCLE.has(String(event.event)) || event.event === "outcome")
      this.lifecycle.set(run, {
        run,
        at: event.at,
        event: String(event.event),
        ...(step ? { step } : {}),
        ...(str(event.outcome) ? { outcome: String(event.outcome) } : {}),
      });
    if (event.event === "model-usage") {
      this.call(event, at);
      return;
    }
    // A refused answer (the semantic stage) counts on its call's groups.
    if (event.stage === "semantic") {
      for (const group of this.callGroups.get(str(event.callId) ?? "") ?? [])
        bump(group.stages, "semantic");
      return;
    }
    if (!this.stepPasses(event)) return;
    switch (event.event) {
      case "start": {
        if (!step) break;
        const key = `${run} ${step}`;
        if (this.open.has(key)) this.startsWithoutOutcome += 1;
        this.open.set(key, event);
        const since = this.retrying.get(step);
        if (since !== undefined) {
          this.retrying.delete(step);
          this.retryWaits.push([since, at]);
          this.retries.waitMs += Math.max(0, at - since);
        }
        break;
      }
      case "outcome": {
        if (!step) break;
        const key = `${run} ${step}`;
        const start = this.open.get(key);
        this.open.delete(key);
        if (!start) this.outcomesWithoutStart += 1;
        const outcome = String(event.outcome ?? "ended");
        if (start) this.attempt(start, event.at, outcome, event);
        if (start && outcome === "hold" && this.failing.delete(key))
          this.attempts.at(-1)!.failed = true;
        if (outcome === "retry") {
          if (event.progress === true) this.retries.continuations += 1;
          else {
            this.retries.waits += 1;
            bump(this.retries.byWait, str(event.wait) ?? "unclassed");
            bump(this.retries.byStep, phaseOf(step));
            this.retrying.set(step, at);
          }
        }
        if (outcome === "repair") {
          const target = str(event.target) ?? step;
          this.repairs.total += 1;
          bump(this.repairs.byItem, itemOf(target) ?? "objective");
          bump(this.repairs.byTarget, phaseOf(target));
        }
        break;
      }
      case "hold": {
        this.holdCounts.asked += 1;
        if (event.cause === "failure" && step) {
          this.holdCounts.failures += 1;
          // Logged when the hold is saved, just before the step's outcome.
          this.failing.add(`${run} ${step}`);
        }
        const id = str(event.id);
        if (id && !this.holds.has(id)) this.holds.set(id, { at });
        break;
      }
      case "request": {
        const request = (event.request ?? {}) as Record<string, unknown>;
        const hold = this.holds.get(str(request.question) ?? "");
        if (request.kind !== "answer" || !hold || event.code || hold.answered)
          break;
        hold.answered = at;
        hold.answer = String(request.answer);
        break;
      }
      case "validation-result": {
        const ms = num(event.durationMs) ?? 0;
        this.validation.commands += 1;
        this.validation.ms += ms;
        const failed = !event.passed;
        if (failed) this.validation.failed += 1;
        const key = step ? phaseOf(step) : "objective";
        const name = `${itemOfEvent(event) ?? "objective"} ${key}`;
        this.validation.byStep[name] ??= { commands: 0, failed: 0 };
        const row = this.validation.byStep[name];
        row.commands += 1;
        if (failed) row.failed += 1;
        this.validations.push([at - ms, at]);
        break;
      }
      case "worker-activity": {
        const item = itemOfEvent(event) ?? "objective";
        this.activity[item] ??= {
          turns: 0,
          toolsStarted: 0,
          edits: 0,
          commands: 0,
          commandsFailed: 0,
        };
        const row = this.activity[item];
        const counts = (event.counts ?? {}) as Record<string, unknown>;
        for (const name of Object.keys(row) as (keyof typeof row)[])
          row[name] += num(counts[name]) ?? 0;
        break;
      }
      case "aborted":
        this.aborted += Array.isArray(event.steps) ? event.steps.length : 1;
        break;
      case "github-request":
        bump(
          this.github.traced,
          event.unnoted
            ? "untraced"
            : `${String(event.status ?? "network")}${event.category ? ` ${String(event.category)}` : ""}`,
          num(event.unnoted) ?? 1,
        );
        break;
      case "github-call": {
        this.githubJobs.add(String(event.job));
        const g = this.github;
        for (const field of [
          "runs",
          "calls",
          "retries",
          "rateLimited",
          "failed",
          "bytes",
          "ms",
          "requestMs",
        ] as const)
          g[field] += num(event[field]) ?? 0;
        break;
      }
    }
  }

  /** The run's header, sequence, log health and end (log.ts RunLog), before any filter. */
  private formal(run: string, event: LogEvent): void {
    let entry = this.runHistory.get(run);
    if (!entry) {
      entry = {
        history: { run, lines: 0, gaps: 0, unsequenced: 0 },
        seqs: new Set(),
        maxSeq: 0,
      };
      this.runHistory.set(run, entry);
    }
    const { history } = entry;
    const seq = num(event.seq);
    if (seq === undefined) history.unsequenced += 1;
    else {
      history.lines += 1;
      entry.seqs.add(seq);
      entry.maxSeq = Math.max(entry.maxSeq, seq);
    }
    if (event.event === "run-header") {
      history.factoryVersion = str(event.factoryVersion) ?? null;
      history.sourceDigest = str(event.sourceDigest) ?? null;
    }
    if (event.event === "log-health")
      history.health = {
        emitted: num(event.emitted) ?? 0,
        failed: num(event.failed) ?? 0,
        lost: num(event.lost) ?? 0,
      };
    if (event.event === "run-end") history.end = str(event.outcome);
  }

  private call(event: LogEvent, at: number): void {
    const { filters, groupBy } = this.options;
    for (const [field, expected] of Object.entries(filters))
      if (callField(event, field as AnalysisField) !== expected) return;
    addCall(this.calls.group, this.calls.rates, event);
    const key = Object.fromEntries(
      groupBy.map((field) => [field, callField(event, field)]),
    );
    const id = JSON.stringify(key);
    let entry = this.groups.get(id);
    if (!entry) {
      entry = {
        group: emptyGroup(key),
        rates: emptyRates(),
      };
      this.groups.set(id, entry);
    }
    addCall(entry.group, entry.rates, event);
    const callId = str(event.callId);
    if (callId) this.callGroups.set(callId, [this.calls.group, entry.group]);
    const ms = num(event.ms) ?? 0;
    this.models.push([at - ms, at]);
  }

  private attempt(
    start: LogEvent,
    endedAt: string,
    outcome: string,
    end?: LogEvent,
  ): void {
    const step = String(start.step);
    const item = itemOf(step);
    const wait = str(end?.wait);
    const reason = str(end?.reason);
    const id = str(start.attemptId);
    const parentId = str(start.parentAttemptId);
    const error =
      outcome === "retry" &&
      (wait === "error" ||
        (!wait && (reason?.startsWith("error") || reason === "deadline")));
    this.attempts.push({
      run: String(start.run),
      step,
      ...(item ? { item } : {}),
      phase: phaseOf(step),
      startedAt: start.at,
      endedAt,
      ms: Math.max(0, Date.parse(endedAt) - Date.parse(start.at)),
      outcome,
      ...(wait ? { wait } : {}),
      ...(reason ? { reason } : {}),
      ...(error ? { failed: true as const } : {}),
      ...(id ? { id } : {}),
      ...(parentId ? { parentId } : {}),
    });
  }

  report(): AnalysisReport {
    for (const start of this.open.values())
      this.attempt(start, this.lastAt.get(String(start.run))!, "unfinished");
    this.open.clear();
    const end = this.to ? Date.parse(this.to) : 0;
    const begin = this.from ? Date.parse(this.from) : 0;
    this.retries.open = this.retrying.size;
    for (const since of this.retrying.values())
      this.retryWaits.push([since, end]);
    const holdIntervals: Interval[] = [];
    let holdWaitMs = 0;
    const byAnswer: Record<string, number> = {};
    let answered = 0;
    for (const hold of this.holds.values()) {
      if (hold.answered === undefined) {
        holdIntervals.push([hold.at, end]);
        continue;
      }
      answered += 1;
      holdWaitMs += hold.answered - hold.at;
      holdIntervals.push([hold.at, hold.answered]);
      bump(byAnswer, hold.answer ?? "?");
    }
    const phases: AnalysisReport["phases"] = {};
    const byPhase = new Map<string, Interval[]>();
    const stepIntervals: Interval[] = [];
    for (const attempt of this.attempts) {
      phases[attempt.phase] ??= {
        attempts: 0,
        outcomes: {},
        wallMs: 0,
        attemptMs: 0,
      };
      const row = phases[attempt.phase]!;
      row.attempts += 1;
      row.attemptMs += attempt.ms;
      bump(row.outcomes, attempt.outcome);
      const interval: Interval = [
        Date.parse(attempt.startedAt),
        Date.parse(attempt.endedAt),
      ];
      stepIntervals.push(interval);
      byPhase.set(attempt.phase, [
        ...(byPhase.get(attempt.phase) ?? []),
        interval,
      ]);
    }
    for (const [phase, intervals] of byPhase)
      phases[phase]!.wallMs = unionMs(intervals);
    const busy = unionMs([
      ...stepIntervals,
      ...this.retryWaits,
      ...holdIntervals,
    ]);
    const failed = this.attempts.filter((a) => a.failed);
    const reasons: string[] = [];
    if (this.outcomesWithoutStart) reasons.push("outcome-without-start");
    if (this.startsWithoutOutcome) reasons.push("start-without-outcome");
    if (this.attempts.some((a) => a.outcome === "unfinished"))
      reasons.push("unfinished-attempt");
    if (!this.attempts.length) reasons.push("no-attempts-observed");
    const runs = [...this.runHistory.values()].map(
      ({ history, seqs, maxSeq }) => ({ ...history, gaps: maxSeq - seqs.size }),
    );
    if (runs.some((r) => r.gaps)) reasons.push("sequence-gap");
    if (runs.some((r) => r.health?.lost)) reasons.push("lost-lines");
    if (runs.some((r) => r.unsequenced)) reasons.push("unsequenced-lines");
    return {
      issue: this.options.issue,
      runs: this.runOrder,
      ...(this.from ? { from: this.from, to: this.to } : {}),
      wallMs: end - begin,
      groupBy: this.options.groupBy,
      filters: this.options.filters,
      calls: settle(this.calls.group, this.calls.rates),
      groups: [...this.groups.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([, { group, rates }]) => settle(group, rates)),
      phases,
      time: {
        stepsMs: unionMs(stepIntervals),
        retryWaitMs: unionMs(this.retryWaits),
        holdWaitMs: unionMs(holdIntervals),
        modelMs: unionMs(this.models),
        validationMs: unionMs(this.validations),
        idleMs: Math.max(0, end - begin - busy),
      },
      retries: this.retries,
      repairs: this.repairs,
      holds: {
        ...this.holdCounts,
        answered,
        open: this.holds.size - answered,
        waitMs: holdWaitMs,
        byAnswer,
      },
      validation: this.validation,
      activity: this.activity,
      history: {
        attempts: this.attempts.length,
        failedAttempts: failed.map(({ run, step, startedAt }) => ({
          run,
          step,
          startedAt,
        })),
        hasFailedAttempt: failed.length > 0,
        unfinished: this.attempts.filter((a) => a.outcome === "unfinished")
          .length,
        outcomesWithoutStart: this.outcomesWithoutStart,
        startsWithoutOutcome: this.startsWithoutOutcome,
        aborted: this.aborted,
        phases: [...byPhase.keys()],
        lifecycle: this.runOrder.flatMap((run) => {
          const last = this.lifecycle.get(run);
          return last ? [last] : [];
        }),
        completeness: reasons.length ? "unknown" : "paired",
        reasons,
        runs,
        continued: this.attempts.filter((a) => a.parentId).length,
      },
      github: { ...this.github, jobs: this.githubJobs.size },
      limitations: LIMITATIONS,
    };
  }
}

const LIMITATIONS = [
  "Times overlap: each time figure is a union, so concurrent steps, calls and waits count once; never add them up.",
  "A count a provider doesn't report is unknown, not 0: tokens and cost sum only the calls that report them, and each figure says how many did. Cached input and reasoning output are parts of input and output, never extra tokens.",
  "Cost is the provider's list cost when it reports one (Claude, Claude managed), not a bill; subscription use is unknown.",
  "nativeToolActivity (model-visible tool calls) and sdkOperations (the SDK's own items) are two views of the same work and are never added; one tool call can run many commands.",
  "Sequence numbers count per run file: a gap is a line lost to a failed write (log-health counts them too); a run with no run-end is still running, or died and no later start has seen it yet.",
  "A refused answer (stage semantic) is a call that succeeded and that Factory's checks then refused; it counts beside the call's outcome, not instead of it.",
  "Filters on role, provider, model, effort, outcome, tokenSource and hedge select model calls only; run, item and phase also select steps.",
];

/** The analysis views over the chosen runs. */
function analysisReport(options: AnalyzeOptions): AnalysisReport {
  const analysis = new Analysis(options);
  readChosen(options, (event) => analysis.add(event));
  return analysis.report();
}

/** `--analyze`: the analysis views over the chosen runs. */
export function analyze(
  options: AnalyzeOptions,
  write: (text: string) => void,
): void {
  const report = analysisReport(options);
  write(options.json ? `${JSON.stringify(report)}\n` : analysisText(report));
}

function tally(map: Record<string, number>): string {
  const entries = Object.entries(map).sort((a, b) => b[1] - a[1]);
  return entries.length
    ? entries.map(([name, n]) => `${name} ${count(n)}`).join(", ")
    : "none";
}

function toolText(view: ToolView): string {
  if (!view.reportedCalls) return `unreported (0/${view.eligibleCalls} calls)`;
  const top = Object.entries(view.byName)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([name, n]) => `${name} ${n}`)
    .join(", ");
  return `${count(view.calls)} (${top || "none"}) · ${view.reportedCalls}/${view.eligibleCalls} calls reported${view.partialCalls ? ` · ${view.partialCalls} partial` : ""}`;
}

function groupText(group: CallGroup, indent: string): string[] {
  const { cache, efficiency: e } = group;
  const partial = CATEGORIES.filter(
    (category) => group.tokenCalls[category] < group.usage.calls,
  );
  return [
    `${indent}${usageText(group.usage)}`,
    ...(partial.length
      ? [
          `${indent}token counts reported by: ${partial.map((category) => `${category} ${group.tokenCalls[category]}/${group.usage.calls} calls`).join(", ")}`,
        ]
      : []),
    `${indent}cache: ${cache.hitRate === null ? "unknown" : `${(cache.hitRate * 100).toFixed(1)}% of input`} (${count(cache.cached)} of ${count(cache.input)} in ${cache.pairedCalls}/${cache.eligibleCalls} calls; ${count(cache.uncachedInput)} uncached)`,
    `${indent}outcomes: ${tally(group.outcomes)}${group.hedged ? ` · ${group.hedged} hedged` : ""}${Object.keys(group.stages).length ? ` · failed or refused at: ${tally(group.stages)}` : ""}`,
    `${indent}reported models: ${tally(group.reportedModels)}${group.modelMismatches ? ` · ${group.modelMismatches} differ from the model asked for` : ""}`,
    `${indent}native tools: ${toolText(group.nativeTools)}`,
    ...(group.toolStats.reportedCalls
      ? [
          `${indent}native tool calls: ${group.toolStats.rounds} rounds · ${group.toolStats.outputs} outputs · ${group.toolStats.failures} failed · ${group.toolStats.missingOutputs} unanswered · ${duration(group.toolStats.ms)} · ${group.toolStats.reportedCalls}/${group.usage.calls} calls reported`,
        ]
      : []),
    ...(group.request.reportedCalls
      ? [
          `${indent}requests: ${size(group.request.bytes)} in ${group.request.reportedCalls}/${group.usage.calls} calls (${Object.entries(
            group.request.components,
          )
            .sort((a, b) => b[1] - a[1])
            .slice(0, 8)
            .map(([part, n]) => `${part} ${size(n)}`)
            .join(
              ", ",
            )}) · distinct prompts ${group.digests.prompts}, schemas ${group.digests.schemas}, sources ${group.digests.sources}`,
        ]
      : []),
    `${indent}sessions: ${tally(group.sessions)}${group.maxSessionTurn > 1 ? ` · up to turn ${group.maxSessionTurn}` : ""}${group.firstToken.meanMs === null ? "" : ` · first token after ${duration(group.firstToken.meanMs)} on average (${group.firstToken.reportedCalls} calls)`}${group.imageOutputs.total ? ` · ${group.imageOutputs.total} images out` : ""} · provider usage in ${group.providerUsageCalls}/${group.usage.calls} calls · cost currency: ${tally(group.currencies)}`,
    `${indent}SDK operations: ${toolText(group.sdkOperations)}`,
    `${indent}efficiency: ${
      [
        e.msPerCall === null ? undefined : `${duration(e.msPerCall)} per call`,
        e.tokensPerCall === null
          ? undefined
          : `${count(e.tokensPerCall)} tokens per call`,
        e.outputTokensPerMinute === null
          ? undefined
          : `${count(e.outputTokensPerMinute)} output tokens per minute`,
        e.costPerCallUsd === null
          ? undefined
          : `$${e.costPerCallUsd.toFixed(4)} per call`,
      ]
        .filter(Boolean)
        .join(" · ") || "no calls"
    }`,
  ];
}

/** The analysis for people. */
function analysisText(report: AnalysisReport): string {
  const lines = [
    `Diagnostics analysis #${report.issue} · ${report.runs.length} run${report.runs.length === 1 ? "" : "s"}${report.from ? ` · ${displayTime(report.from)} to ${displayTime(report.to!)} (${duration(report.wallMs)})` : ""}`,
  ];
  if (!report.runs.length) return `${lines[0]}\nNo run log yet.\n`;
  const filters = Object.entries(report.filters);
  if (filters.length)
    lines.push(`Filters: ${filters.map(([k, v]) => `${k}=${v}`).join(", ")}`);
  const section = (title: string, rows: string[]) => {
    lines.push("", title, ...(rows.length ? rows : ["  none"]));
  };
  const t = report.time;
  section("Time (unions; overlaps count once):", [
    `  steps running ${duration(t.stepsMs)} · retry waits ${duration(t.retryWaitMs)} · held for an answer ${duration(t.holdWaitMs)} · idle ${duration(t.idleMs)}`,
    `  model calls ${duration(t.modelMs)} · validation commands ${duration(t.validationMs)}`,
  ]);
  section("Model calls, all:", groupText(report.calls, "  "));
  section(
    `By ${report.groupBy.join(", ")}:`,
    report.groups.flatMap((group) => [
      `  ${Object.entries(group.key)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ")}:`,
      ...groupText(group, "    "),
    ]),
  );
  section(
    "Steps by phase (wall time counts overlaps once):",
    Object.entries(report.phases).map(
      ([phase, row]) =>
        `  ${phase}: ${row.attempts} attempts (${tally(row.outcomes)}) · ${duration(row.wallMs)} wall · ${duration(row.attemptMs)} summed`,
    ),
  );
  const r = report.retries;
  section("Retries and waits:", [
    `  ${r.waits} waits (${tally(r.byWait)}) for ${duration(r.waitMs)}${r.open ? ` · ${r.open} still waiting` : ""} · ${r.continuations} continuations`,
    ...(r.waits ? [`  by step: ${tally(r.byStep)}`] : []),
  ]);
  section("Repairs:", [
    `  ${report.repairs.total} · by item: ${tally(report.repairs.byItem)} · of: ${tally(report.repairs.byTarget)}`,
  ]);
  const h = report.holds;
  section("Holds:", [
    `  ${h.asked} asked (${h.failures} failures) · ${h.answered} answered after ${duration(h.waitMs)} in all (${tally(h.byAnswer)}) · ${h.open} open`,
  ]);
  const v = report.validation;
  section("Validation commands:", [
    `  ${v.commands} run, ${v.failed} failed, ${duration(v.ms)} in all`,
    ...Object.entries(v.byStep).map(
      ([step, row]) => `  ${step}: ${row.commands} run, ${row.failed} failed`,
    ),
  ]);
  section(
    "Worker activity:",
    Object.entries(report.activity).map(
      ([item, a]) =>
        `  ${item}: ${a.turns} turns · ${a.toolsStarted} tools · ${a.edits} edits · ${a.commands} commands (${a.commandsFailed} failed)`,
    ),
  );
  const hi = report.history;
  section("History (step attempts, start paired with outcome):", [
    `  ${hi.attempts} attempts · ${hi.failedAttempts.length} failed · ${hi.unfinished} unfinished · ${hi.aborted} aborted · ${hi.completeness}${hi.reasons.length ? ` (${hi.reasons.join(", ")})` : ""}`,
    ...(hi.continued ? [`  ${hi.continued} attempts continue another`] : []),
    ...hi.lifecycle.map(
      (last) =>
        `  run ${last.run} last: ${last.event}${last.outcome ? ` ${last.outcome}` : ""} at ${displayTime(last.at)}`,
    ),
    ...hi.runs.map(
      (r) =>
        `  run ${r.run}: ${r.end ?? "no run-end"} · Factory ${r.factoryVersion ?? "unknown"}${r.sourceDigest ? ` (${r.sourceDigest.slice(0, 12)})` : ""} · ${r.lines} lines, ${r.gaps} missing${r.unsequenced ? `, ${r.unsequenced} unsequenced` : ""}${r.health ? ` · log health: ${r.health.emitted} written, ${r.health.failed} failed writes, ${r.health.lost} lost` : ""}`,
    ),
  ]);
  const g = report.github;
  section("GitHub requests (sync jobs, steps and the service):", [
    `  ${count(g.calls)} requests in ${g.runs} runs (${g.jobs} jobs and steps) · ${g.retries} retries · ${g.rateLimited} rate-limited · ${g.failed} failed · ${size(g.bytes)} · ${duration(g.requestMs)} in requests`,
    ...(Object.keys(g.traced).length
      ? [`  traced requests by status and failure: ${tally(g.traced)}`]
      : []),
  ]);
  lines.push("", ...report.limitations.map((line) => `Note: ${line}`));
  return `${lines.join("\n")}\n`;
}

// --- gantt ----------------------------------------------------------------

/** One bar: a step attempt, a wait before its next attempt, a hold, a model call or a validation command. */
export interface Bar {
  lane: string;
  item?: string;
  phase: string;
  kind: "step" | "wait" | "hold" | "model" | "validation";
  label: string;
  run: string;
  start: string;
  end: string;
  ms: number;
  outcome?: string;
}

/** Cells of the text chart. */
const WIDTH = 64;
const STEP_MARK: Record<string, string> = {
  done: "#",
  repair: "r",
  replace: "R",
  retry: "~",
  error: "x",
  hold: "?",
  unfinished: ">",
};
const KIND_MARK: Record<Bar["kind"], string> = {
  step: "#",
  wait: ".",
  hold: "!",
  model: "m",
  validation: "v",
};

/** Collects the bars from the chosen runs. */
function bars(options: AnalysisRead): { runs: string[]; bars: Bar[] } {
  const out: Bar[] = [];
  const open = new Map<string, LogEvent>();
  const retrying = new Map<string, { at: string; run: string }>();
  const holds = new Map<string, LogEvent>();
  const lastAt = new Map<string, string>();
  const laneOf = (step: string | undefined, item?: string) => {
    const phase = step ? phaseOf(step) : "objective";
    return { lane: `${item ?? "objective"} ${phase}`, phase };
  };
  const push = (
    kind: Bar["kind"],
    step: string | undefined,
    item: string | undefined,
    run: string,
    start: string,
    end: string,
    label: string,
    outcome?: string,
  ) => {
    const { lane, phase } = laneOf(step, item);
    out.push({
      lane,
      ...(item ? { item } : {}),
      phase,
      kind,
      label,
      run,
      start,
      end,
      ms: Math.max(0, Date.parse(end) - Date.parse(start)),
      ...(outcome ? { outcome } : {}),
    });
  };
  const runs = readChosen(options, (event) => {
    const run = String(event.run);
    lastAt.set(run, event.at);
    const step = str(event.step);
    const item = itemOfEvent(event);
    const key = `${run} ${step}`;
    switch (event.event) {
      case "start": {
        if (!step) break;
        open.set(key, event);
        const since = retrying.get(step);
        if (since) {
          retrying.delete(step);
          push(
            "wait",
            step,
            item,
            since.run,
            since.at,
            event.at,
            `${step} waits`,
          );
        }
        break;
      }
      case "outcome": {
        const start = step ? open.get(key) : undefined;
        if (!step || !start) break;
        open.delete(key);
        const outcome = String(event.outcome ?? "ended");
        // An error retry draws as an error; a wait as a retry.
        const shown =
          outcome === "retry" && event.wait === "error" ? "error" : outcome;
        push("step", step, item, run, start.at, event.at, step, shown);
        if (outcome === "retry" && event.progress !== true)
          retrying.set(step, { at: event.at, run });
        break;
      }
      case "hold": {
        const id = str(event.id);
        if (id) holds.set(id, event);
        break;
      }
      case "request": {
        const request = (event.request ?? {}) as Record<string, unknown>;
        const id = str(request.question) ?? "";
        const hold = holds.get(id);
        if (request.kind !== "answer" || !hold || event.code) break;
        holds.delete(id);
        const held = str(hold.step);
        push(
          "hold",
          held,
          held ? itemOf(held) : undefined,
          String(hold.run),
          hold.at,
          event.at,
          `${held ?? "objective"} held: ${String(request.answer)}`,
        );
        break;
      }
      case "model-usage": {
        const ms = num(event.ms) ?? 0;
        const end = Date.parse(event.at);
        push(
          "model",
          step,
          item,
          run,
          new Date(end - ms).toISOString(),
          event.at,
          [
            str(event.role),
            str(event.phase),
            str(event.provider),
            str(event.model),
          ]
            .filter(Boolean)
            .join(" "),
          str(event.outcome),
        );
        break;
      }
      case "validation-result": {
        const ms = num(event.durationMs) ?? 0;
        const end = Date.parse(event.at);
        push(
          "validation",
          step,
          item,
          run,
          new Date(end - ms).toISOString(),
          event.at,
          String(event.command ?? "command").slice(0, 80),
          event.passed ? "passed" : "failed",
        );
        break;
      }
    }
  });
  // Still running, waiting or held when the log ends: to the run's last event.
  for (const start of open.values()) {
    const step = String(start.step);
    const run = String(start.run);
    push(
      "step",
      step,
      itemOf(step),
      run,
      start.at,
      lastAt.get(run)!,
      step,
      "unfinished",
    );
  }
  for (const [step, since] of retrying)
    push(
      "wait",
      step,
      itemOf(step),
      since.run,
      since.at,
      lastAt.get(since.run)!,
      `${step} waits`,
    );
  for (const hold of holds.values()) {
    const held = str(hold.step);
    const run = String(hold.run);
    push(
      "hold",
      held,
      held ? itemOf(held) : undefined,
      run,
      hold.at,
      lastAt.get(run)!,
      `${held ?? "objective"} held: open`,
    );
  }
  return { runs, bars: out };
}

/** `--gantt`: lanes per Work Item and phase over time; `--json` gives each bar's start and end. */
export function gantt(
  options: AnalysisRead,
  write: (text: string) => void,
): void {
  const { runs, bars: all } = bars(options);
  all.sort((a, b) => a.start.localeCompare(b.start));
  if (options.json) {
    write(`${JSON.stringify({ issue: options.issue, runs, bars: all })}\n`);
    return;
  }
  if (!all.length) {
    write(`No steps in the run log of #${options.issue} yet.\n`);
    return;
  }
  const begin = Math.min(...all.map((bar) => Date.parse(bar.start)));
  const end = Math.max(...all.map((bar) => Date.parse(bar.end)));
  const span = Math.max(1, end - begin);
  const cell = (at: number) =>
    Math.min(WIDTH - 1, Math.floor(((at - begin) / span) * WIDTH));
  // Lanes in order of their first bar, the Objective's steps first (a stable sort).
  const lanes = [...new Set(all.map((bar) => bar.lane))].sort(
    (a, b) =>
      Number(b.startsWith("objective ")) - Number(a.startsWith("objective ")),
  );
  const label = Math.min(28, Math.max(...lanes.map((lane) => lane.length)) + 2);
  const lines = [
    `Gantt #${options.issue} · ${runs.length} run${runs.length === 1 ? "" : "s"} · ${displayTime(new Date(begin).toISOString())} to ${displayTime(new Date(end).toISOString())} (${duration(span)}, ${duration(span / WIDTH)} per column)`,
    `${"".padEnd(label + 2)}|${`+0 s${"".padEnd(WIDTH / 2 - 4)}+${duration(span / 2)}`.padEnd(WIDTH)}| +${duration(span)}`,
  ];
  const row = (title: string, rowBars: Bar[]) => {
    const cells = Array.from({ length: WIDTH }, () => " ");
    for (const bar of rowBars) {
      const mark =
        bar.kind === "step"
          ? (STEP_MARK[bar.outcome ?? ""] ?? "#")
          : KIND_MARK[bar.kind];
      const from = cell(Date.parse(bar.start));
      const to = Math.max(from, cell(Date.parse(bar.end)));
      for (let i = from; i <= to; i++)
        // A step's own mark wins over a wait drawn under it.
        if (cells[i] === " " || cells[i] === ".") cells[i] = mark;
    }
    const name = title.length > label ? `${title.slice(0, label - 1)}…` : title;
    lines.push(`  ${name.padEnd(label)}|${cells.join("")}|`);
  };
  for (const lane of lanes) {
    const own = all.filter((bar) => bar.lane === lane);
    row(
      lane,
      own.filter((bar) => ["step", "wait", "hold"].includes(bar.kind)),
    );
    const models = own.filter((bar) => bar.kind === "model");
    if (models.length) row("  model calls", models);
    const commands = own.filter((bar) => bar.kind === "validation");
    if (commands.length) row("  validation", commands);
  }
  lines.push(
    "",
    "# done · r repair · R replace · ~ retry · x error · ? hold · > unfinished · . waiting to retry · ! held for an answer · m model call · v validation command",
  );
  write(`${lines.join("\n")}\n`);
}
