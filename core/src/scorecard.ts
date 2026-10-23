/**
 * `factory diagnostics --scorecard FILE`: Factory's runs against
 * codex-direct baselines (the same task done directly with `codex exec
 * --json`), for a delivery batch or a comparison. The selection FILE names
 * the packets; Factory packets are read from the run log and the
 * Objective's state, codex-direct packets from the private `codex exec
 * --json` streams the selection names. It reports per packet, per scope
 * and route, and per pair of packets with the same `pairId` (one per
 * route): wall time, time to acceptance, tokens per category, cache
 * effectiveness, cost, model calls, repairs, holds and first-try success.
 *
 * Run-log retention rotates old runs away (log.ts `rotateLogs`): each
 * Factory Objective reports `N of M runs available`, and a missing run makes
 * its counts partial, never silently complete. Read-only: it writes nothing
 * and calls no provider. Every string is redacted on the way out.
 */
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { isAbsolute } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { num, readRun, str } from "./diagnostics.js";
import { displayTime, duration, redactDeep } from "./display.js";
import { type LogEvent, logFiles, rotatedRuns, runOfFile } from "./log.js";
import { acceptedInputs } from "./planning/plan.js";
import { findState } from "./state.js";

/** A selection or Objective the scorecard can't read; `code` is the CLI's refusal. */
export class ScorecardError extends Error {
  constructor(
    readonly code: "usage" | "no_factory_state",
    message: string,
  ) {
    super(message);
  }
}

const fail = (message: string): never => {
  throw new ScorecardError("usage", message);
};

type Outcome = "accepted" | "failed" | "unfinished";
type Route = "factory" | "codex-direct";
const CATEGORIES = ["input", "output", "cached", "reasoning", "total"] as const;
type Category = (typeof CATEGORIES)[number];

/** A sum and how much of it was reported: every call, some, or none. */
export interface Counter {
  known: number | null;
  availability: "available" | "partial" | "unavailable";
}
export type Tokens = Record<Category, Counter>;

/** Cached over input, from the calls that report both; never an average of rates. */
export interface CacheEffectiveness {
  input: number | null;
  cached: number | null;
  uncachedInput: number | null;
  hitRate: number | null;
  pairedCalls: number;
  eligibleCalls: number;
  availability: Counter["availability"];
}

/** Which of an Objective's runs the run log still has. */
export interface RunCoverage {
  available: number;
  total: number;
  /** Runs rotated away (log.ts `rotatedRuns`). */
  rotated: string[];
}

/** A finite selection: reporting input, never execution authority. */
interface Selection {
  schemaVersion: 1;
  window: { startedAt: string; endedAt: string };
  comparison?: {
    planReference?: string;
    practicalImprovementCriterion?: string;
    limitations?: string[];
  };
  packets: Packet[];
}

interface DirectSessionSelection {
  path: string;
  sessionId: string;
  /** `thread.started` appears on resume too; freshness comes from launch evidence. */
  freshThread: true;
  freshThreadReference: string;
  startedAt: string;
  endedAt: string;
  outcome: "completed" | "failed" | "cancelled" | "unfinished";
  role: "setup" | "authoring" | "implementation" | "review" | "recovery";
  cliVersion: string;
  provider: string;
  model: string;
  reasoningEffort: string;
  configDigest: string;
}

interface Packet {
  id: string;
  task: string;
  route: Route;
  pairId?: string;
  scope: "adopter" | "factory-development";
  /** The externally observed whole workflow, human setup and authoring included. */
  workflow?: { startedAt: string; endedAt: string };
  factoryObjectives?: number[];
  codexSessions?: DirectSessionSelection[];
  bindings: {
    sourceDigest: string;
    baseCommit: string;
    resultCommit?: string;
    resultTree?: string;
    acceptanceReference: string;
    environmentReference: string;
  };
  acceptance: { outcome: Outcome; at?: string };
  observations?: Partial<Record<(typeof OBSERVATIONS)[number], number>> & {
    postDeliveryWindowEndedAt?: string;
  };
}

const OBSERVATIONS = [
  "operatorEffortMs",
  "interventions",
  "scopeRedirections",
  "outOfScopeChanges",
  "rework",
  "postDeliveryCorrections",
] as const;
const ROLES = [
  "setup",
  "authoring",
  "implementation",
  "review",
  "recovery",
] as const;

const time = (at: unknown): number => {
  const ms = typeof at === "string" ? Date.parse(at) : Number.NaN;
  return Number.isFinite(ms)
    ? ms
    : fail(`The scorecard needs ISO timestamps; not ${String(at)}`);
};
const present = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");

// --- counters ---------------------------------------------------------------

/** Accumulates calls' token counts per category, and the calls reporting both input and cached. */
class Tally {
  calls = 0;
  private readonly sums = Object.fromEntries(
    CATEGORIES.map((c) => [c, { sum: 0, reported: 0 }]),
  ) as Record<Category, { sum: number; reported: number }>;
  private paired = { calls: 0, input: 0, cached: 0 };

  add(counts: Partial<Record<Category, number | null>>): void {
    this.calls += 1;
    for (const category of CATEGORIES) {
      const value = counts[category];
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      this.sums[category].sum += value;
      this.sums[category].reported += 1;
    }
    const { input, cached } = counts;
    if (typeof input === "number" && typeof cached === "number") {
      this.paired.calls += 1;
      this.paired.input += input;
      this.paired.cached += cached;
    }
  }

  /** `complete`: no call is missing (no rotated run, a finished stream). */
  tokens(complete: boolean): Tokens {
    return Object.fromEntries(
      CATEGORIES.map((category) => {
        const { sum, reported } = this.sums[category];
        return [
          category,
          {
            known: reported ? sum : null,
            availability: !reported
              ? "unavailable"
              : complete && reported === this.calls
                ? "available"
                : "partial",
          },
        ];
      }),
    ) as Tokens;
  }

  cache(complete: boolean): CacheEffectiveness {
    return cacheOf(this.paired, this.calls, complete);
  }
}

function cacheOf(
  paired: { calls: number; input: number; cached: number },
  eligible: number,
  complete: boolean,
): CacheEffectiveness {
  const some = paired.calls > 0;
  return {
    input: some ? paired.input : null,
    cached: some ? paired.cached : null,
    uncachedInput: some ? paired.input - paired.cached : null,
    hitRate:
      some && paired.input > 0
        ? Math.round((paired.cached / paired.input) * 10_000) / 10_000
        : null,
    pairedCalls: paired.calls,
    eligibleCalls: eligible,
    availability: !some
      ? "unavailable"
      : complete && paired.calls === eligible
        ? "available"
        : "partial",
  };
}

/** Sums of counters: available only when every part is. */
function sumTokens(parts: Tokens[]): Tokens {
  return Object.fromEntries(
    CATEGORIES.map((category) => {
      const counters = parts.map((part) => part[category]);
      const known = counters.filter((counter) => counter.known !== null);
      return [
        category,
        {
          known: known.length
            ? known.reduce((sum, counter) => sum + counter.known!, 0)
            : null,
          availability:
            counters.length &&
            counters.every((counter) => counter.availability === "available")
              ? "available"
              : known.length
                ? "partial"
                : "unavailable",
        },
      ];
    }),
  ) as Tokens;
}

function sumCache(parts: CacheEffectiveness[]): CacheEffectiveness {
  const paired = { calls: 0, input: 0, cached: 0 };
  let eligible = 0;
  for (const part of parts) {
    eligible += part.eligibleCalls;
    paired.calls += part.pairedCalls;
    paired.input += part.input ?? 0;
    paired.cached += part.cached ?? 0;
  }
  return cacheOf(
    paired,
    eligible,
    parts.every((part) => part.availability !== "partial"),
  );
}

/** A sum of nullable values: null when none is known, with whether all were. */
function known(values: (number | null)[]): {
  known: number | null;
  complete: boolean;
} {
  const some = values.filter((value): value is number => value !== null);
  return {
    known: some.length ? some.reduce((sum, value) => sum + value, 0) : null,
    complete: values.every((value) => value !== null),
  };
}

// --- Factory Objectives -----------------------------------------------------

export interface FactoryObjective {
  objective: number;
  outcome: Outcome;
  /** `N of M runs available`: rotated runs leave every count partial. */
  runs: RunCoverage;
  startedAt: string | null;
  endedAt: string | null;
  wallMs: number | null;
  acceptedAt: string | null;
  bindings: {
    admission: string | null;
    observedRuns: string[];
    provider: string | null;
    configDigest: string | null;
    baseCommit: string | null;
    resultCommit: string | null;
    resultTree: string | null;
    providerSessionIds: string[];
  };
  modelCalls: number;
  failedModelCalls: number;
  workerCalls: number;
  modelMs: number;
  tokens: Tokens;
  costUsd: Counter;
  cacheEffectiveness: CacheEffectiveness;
  cacheByRole: Record<string, CacheEffectiveness>;
  cacheByPhase: Record<string, CacheEffectiveness>;
  /** From the state: they survive rotation. */
  repairs: number;
  holds: number;
  /** Asked to answered, summed; elapsed waits, not operator attention. */
  holdWaitMs: number;
  /** Null when not observed, or when a run is missing. */
  firstTryPlanning: boolean | null;
  firstTryDelivery: boolean | null;
}

interface ReadOptions {
  logs: string;
  objectives: string;
  secrets: readonly string[];
}

/** The planning steps: a generation's rounds and its decision. */
const PLANNING = /^(plan|review|decide):\d+:\d+$/;

/** One Objective's latest admission, from its state and the runs since it was admitted. */
export function factoryObjective(
  read: ReadOptions,
  objective: number,
): FactoryObjective {
  const loaded = findState(read.objectives, objective);
  if (!loaded)
    throw new ScorecardError(
      "no_factory_state",
      `Factory has no state for #${objective}.`,
    );
  if (loaded.kind !== "ok")
    throw new ScorecardError(
      "no_factory_state",
      `#${objective}'s state is unreadable: ${loaded.error}`,
    );
  const { state } = loaded;
  const admitted = state.startedAt;
  const since = (at: string) => !admitted || at >= admitted;
  const events: LogEvent[] = [];
  const observed: string[] = [];
  for (const file of logFiles(read.logs, objective)) {
    const before = events.length;
    readRun(file, 0, read.secrets, (event) => {
      if (since(event.at)) events.push(event);
    });
    if (events.length > before) observed.push(runOfFile(file));
  }
  const rotated = rotatedRuns(read.logs, objective)
    .filter((run) => since(run.lastAt))
    .map((run) => run.run);
  const runs = {
    available: observed.length,
    total: observed.length + rotated.length,
    rotated,
  };
  const complete = rotated.length === 0 && observed.length > 0;

  const all = new Tally();
  const byRole = new Map<string, Tally>();
  const byPhase = new Map<string, Tally>();
  const tallyOf = (map: Map<string, Tally>, key: string) => {
    const tally = map.get(key) ?? new Tally();
    map.set(key, tally);
    return tally;
  };
  const sessions = new Set<string>();
  const asked = new Map<string, string>();
  let failedModelCalls = 0;
  let workerCalls = 0;
  let modelMs = 0;
  let cost = 0;
  let costed = 0;
  let holds = 0;
  let holdWaitMs = 0;
  const planRounds = new Set<string>();
  let planningSetback = false;
  let deliverySetback = false;
  for (const event of events) {
    const step = str(event.step) ?? "";
    switch (event.event) {
      case "model-usage": {
        const tokens = (event.tokens ?? {}) as Record<string, unknown>;
        const counts = Object.fromEntries(
          CATEGORIES.map((c) => [c, num(tokens[c]) ?? null]),
        );
        const role = str(event.role) ?? "unknown";
        all.add(counts);
        tallyOf(
          byRole,
          role === "worker" ? "worker" : "plannerAndReviewers",
        ).add(counts);
        tallyOf(byPhase, str(event.phase) ?? role).add(counts);
        if (role === "worker" && !num(event.hedge)) workerCalls += 1;
        modelMs += num(event.ms) ?? 0;
        const usd = num(event.costUsd);
        if (usd !== undefined) {
          cost += usd;
          costed += 1;
        }
        if (["error", "fail"].includes(String(event.outcome))) {
          failedModelCalls += 1;
          if (PLANNING.test(step)) planningSetback = true;
          else deliverySetback = true;
        }
        for (const id of [event.thread, event.session])
          if (present(id)) sessions.add(id);
        break;
      }
      case "start":
        if (/^plan:\d+:\d+$/.test(step)) planRounds.add(step);
        break;
      case "outcome": {
        // A continuation is progress, not a setback.
        const setback = event.outcome !== "done" && event.progress !== true;
        if (!setback) break;
        if (PLANNING.test(step)) planningSetback = true;
        else deliverySetback = true;
        break;
      }
      case "hold": {
        holds += 1;
        const id = str(event.id);
        if (id) asked.set(id, event.at);
        if (PLANNING.test(step)) planningSetback = true;
        else deliverySetback = true;
        break;
      }
      case "request": {
        const request = (event.request ?? {}) as Record<string, unknown>;
        const at = asked.get(str(request.question) ?? "");
        if (request.kind !== "answer" || at === undefined || event.code) break;
        asked.delete(String(request.question));
        holdWaitMs += Math.max(0, time(event.at) - time(at));
        break;
      }
    }
  }

  const outcome: Outcome =
    state.status === "done"
      ? "accepted"
      : state.status === "cancelled"
        ? "failed"
        : "unfinished";
  const final = state.done.final as
    | { commit?: string; tree?: string }
    | undefined;
  let baseCommit: string | null = null;
  try {
    if (state.done.check) baseCommit = acceptedInputs(state).base ?? null;
  } catch {
    // A generation without its inputs: the base stays unknown.
  }
  const startedAt = admitted ?? events[0]?.at ?? null;
  const endedAt = state.ended?.at ?? events.at(-1)?.at ?? null;
  const repairs = Object.values(state.repairs ?? {}).reduce(
    (sum, repair) => sum + repair.count,
    0,
  );
  const cacheMap = (map: Map<string, Tally>) =>
    Object.fromEntries(
      [...map].map(([key, tally]) => [key, tally.cache(complete)]),
    );
  return {
    objective,
    outcome,
    runs,
    startedAt,
    endedAt,
    wallMs: startedAt && endedAt ? time(endedAt) - time(startedAt) : null,
    acceptedAt: outcome === "accepted" ? (state.ended?.at ?? null) : null,
    bindings: {
      admission: admitted ?? null,
      observedRuns: observed,
      provider: state.frozen?.provider ?? null,
      configDigest: state.frozen?.digest ?? null,
      baseCommit,
      resultCommit: final?.commit ?? null,
      resultTree: final?.tree ?? null,
      providerSessionIds: [...sessions],
    },
    modelCalls: all.calls,
    failedModelCalls,
    workerCalls,
    modelMs,
    tokens: all.tokens(complete),
    costUsd: {
      known: costed ? cost : null,
      availability: !costed
        ? "unavailable"
        : complete && costed === all.calls
          ? "available"
          : "partial",
    },
    cacheEffectiveness: all.cache(complete),
    cacheByRole: cacheMap(byRole),
    cacheByPhase: cacheMap(byPhase),
    repairs,
    holds,
    holdWaitMs,
    firstTryPlanning:
      complete && planRounds.size
        ? planRounds.size === 1 && !planningSetback
        : null,
    firstTryDelivery:
      complete && outcome === "accepted" && workerCalls > 0
        ? repairs === 0 && !deliverySetback
        : null,
  };
}

// --- codex-direct sessions --------------------------------------------------

/** The most a `codex exec --json` stream may be. */
const STREAM_MAX = 256 * 1024 * 1024;

/** A private file's complete JSON records: 0600, owned, not a link, newline-terminated. */
function* privateRecords(path: string): Generator<Record<string, unknown>> {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    return fail(`Can't open the codex-direct stream ${path}: ${error}`);
  }
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      (stat.mode & 0o077) !== 0 ||
      stat.uid !== process.getuid?.() ||
      stat.size > STREAM_MAX
    )
      fail(
        `The codex-direct stream ${path} must be your own private (0600) regular file of at most 256 MiB`,
      );
    const buffer = Buffer.alloc(64 * 1024);
    const decoder = new StringDecoder("utf8");
    let pending = "";
    for (;;) {
      const bytes = readSync(fd, buffer, 0, buffer.length, null);
      if (bytes === 0) break;
      pending += decoder.write(buffer.subarray(0, bytes));
      let start = 0;
      for (let end = pending.indexOf("\n"); end >= 0; ) {
        const line = pending.slice(start, end);
        if (line.trim())
          try {
            yield JSON.parse(line) as Record<string, unknown>;
          } catch {
            fail(
              `The codex-direct stream ${path} has a record that isn't JSON`,
            );
          }
        start = end + 1;
        end = pending.indexOf("\n", start);
      }
      pending = pending.slice(start);
    }
    if ((pending + decoder.end()).trim())
      fail(`The codex-direct stream ${path} ends in an unterminated record`);
  } finally {
    closeSync(fd);
  }
}

/**
 * Codex's usage counts, the way the old scorecard read them: all-zero
 * usage (none arrived) is unknown, and so is a zero cached or reasoning
 * count, which Codex fills in when the detail is missing.
 */
function codexCounts(usage: unknown): Partial<Record<Category, number>> {
  if (!usage || typeof usage !== "object") return {};
  const u = usage as Record<string, unknown>;
  const counts: Partial<Record<Category, number>> = {};
  const set = (category: Category, value: unknown) => {
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
      counts[category] = value;
  };
  set("input", u.input_tokens);
  set("cached", u.cached_input_tokens);
  set("output", u.output_tokens);
  set("reasoning", u.reasoning_output_tokens);
  if (!Object.values(counts).some((value) => value > 0)) return {};
  if (counts.cached === 0) delete counts.cached;
  if (counts.reasoning === 0) delete counts.reasoning;
  if (counts.input !== undefined && counts.output !== undefined)
    counts.total = counts.input + counts.output;
  return counts;
}

export interface DirectSession
  extends Omit<DirectSessionSelection, "path" | "freshThread"> {
  observationDigest: string;
  turns: { completed: number; failed: number; unfinished: number };
  usageScope: "thread-cumulative";
  tokens: Tokens;
  cacheEffectiveness: CacheEffectiveness;
  wallMs: number;
}

/** A fresh `codex exec --json` stream: the latest `turn.completed` usage is the thread's total, counted once. */
function directSession(session: DirectSessionSelection): DirectSession {
  if (!isAbsolute(session.path))
    fail(`A codex-direct stream path must be absolute; not ${session.path}`);
  if (session.freshThread !== true || !present(session.freshThreadReference))
    fail(
      `Session ${session.sessionId} needs freshThread: true and a freshThreadReference: resumed or unknown starting counters can't be counted`,
    );
  const hash = createHash("sha256");
  const threads = new Set<unknown>();
  let starts = 0;
  let open = false;
  let completed = 0;
  let failed = 0;
  let last: "completed" | "failed" | undefined;
  let usage: Partial<Record<Category, number>> = {};
  for (const row of privateRecords(session.path)) {
    // A digest of the complete records; no message or tool output is kept.
    hash.update(`${JSON.stringify(row)}\n`);
    if (row.type === "thread.started") {
      starts += 1;
      threads.add(row.thread_id);
    }
    if (row.type === "turn.started") {
      if (open)
        fail(`Session ${session.sessionId} starts a turn before one ended`);
      open = true;
    }
    if (row.type !== "turn.completed" && row.type !== "turn.failed") continue;
    if (!open)
      fail(`Session ${session.sessionId} ends a turn it never started`);
    open = false;
    if (row.type === "turn.completed") {
      completed += 1;
      last = "completed";
      // Thread-cumulative: the latest snapshot replaces, never adds.
      usage = codexCounts(row.usage);
    } else {
      failed += 1;
      last = "failed";
    }
  }
  if (starts !== 1 || threads.size !== 1 || !threads.has(session.sessionId))
    fail(
      `The stream ${session.path} is not one fresh thread ${session.sessionId}`,
    );
  if (session.outcome === "completed" && (open || failed || !completed))
    fail(
      `Session ${session.sessionId} is selected as completed, but its stream has no clean successful end`,
    );
  const incomplete =
    open ||
    last !== "completed" ||
    ["unfinished", "cancelled"].includes(session.outcome);
  const tally = new Tally();
  tally.add(usage);
  const { path: _path, freshThread: _fresh, ...rest } = session;
  return {
    ...rest,
    observationDigest: hash.digest("hex"),
    turns: { completed, failed, unfinished: open ? 1 : 0 },
    usageScope: "thread-cumulative",
    tokens: tally.tokens(!incomplete),
    cacheEffectiveness: tally.cache(!incomplete),
    wallMs: time(session.endedAt) - time(session.startedAt),
  };
}

// --- the scorecard ----------------------------------------------------------

export interface Delta {
  factory: number;
  direct: number;
  absolute: number;
  percent: number | null;
}

/** Validate the selection, read every packet, and compare. Throws ScorecardError. */
export function scorecard(read: ReadOptions, selection: Selection) {
  if (
    selection?.schemaVersion !== 1 ||
    !Array.isArray(selection.packets) ||
    !selection.packets.length
  )
    fail(
      "The scorecard selection needs schemaVersion 1 and a nonempty packets list",
    );
  const start = time(selection.window?.startedAt);
  const end = time(selection.window?.endedAt);
  if (end <= start) fail("The scorecard window must have a positive duration");
  const seen = new Set<string>();
  const claim = (key: string) => {
    if (seen.has(key)) fail(`The selection names ${key} twice`);
    seen.add(key);
  };
  const inside = (first: string, last: string, what: string) => {
    if (time(first) < start || time(last) > end || time(last) < time(first))
      fail(`${what} is not whole inside the scorecard window`);
  };

  const packets = selection.packets.map((packet) => {
    if (!packet || typeof packet !== "object")
      fail("Each scorecard packet must be an object");
    if (
      ![
        packet.id,
        packet.task,
        packet.bindings?.sourceDigest,
        packet.bindings?.baseCommit,
        packet.bindings?.acceptanceReference,
        packet.bindings?.environmentReference,
      ].every(present) ||
      !["factory", "codex-direct"].includes(packet.route) ||
      !["adopter", "factory-development"].includes(packet.scope) ||
      !["accepted", "failed", "unfinished"].includes(packet.acceptance?.outcome)
    )
      fail(
        `Packet ${packet?.id ?? "?"} needs id, task, route, scope, acceptance.outcome and bindings (sourceDigest, baseCommit, acceptanceReference, environmentReference)`,
      );
    claim(`packet ${packet.id}`);
    const observations = packet.observations ?? {};
    for (const [key, value] of Object.entries(observations)) {
      if (key === "postDeliveryWindowEndedAt") time(value);
      else if (!OBSERVATIONS.includes(key as (typeof OBSERVATIONS)[number]))
        fail(`Packet ${packet.id}: unknown observation ${key}`);
      else if (!Number.isSafeInteger(value) || Number(value) < 0)
        fail(`Packet ${packet.id}: ${key} must be a whole number`);
    }
    if (
      observations.postDeliveryCorrections !== undefined &&
      !observations.postDeliveryWindowEndedAt
    )
      fail(
        `Packet ${packet.id}: postDeliveryCorrections needs postDeliveryWindowEndedAt`,
      );
    if (
      packet.route === "factory"
        ? !packet.factoryObjectives?.length || packet.codexSessions?.length
        : !packet.codexSessions?.length || packet.factoryObjectives?.length
    )
      fail(
        `Packet ${packet.id}: a factory packet selects factoryObjectives, a codex-direct packet codexSessions`,
      );

    const factory = (packet.factoryObjectives ?? []).map((objective) => {
      if (!Number.isSafeInteger(objective) || objective <= 0)
        fail(`Packet ${packet.id}: ${objective} is not an issue number`);
      claim(`Objective #${objective}`);
      const report = factoryObjective(read, objective);
      if (report.startedAt && report.endedAt)
        inside(report.startedAt, report.endedAt, `#${objective}'s run`);
      if (
        report.bindings.baseCommit &&
        report.bindings.baseCommit !== packet.bindings.baseCommit
      )
        fail(
          `Packet ${packet.id}: #${objective} ran on base ${report.bindings.baseCommit}, not the bound ${packet.bindings.baseCommit}`,
        );
      return report;
    });
    const direct = (packet.codexSessions ?? []).map((session) => {
      if (!session || typeof session !== "object")
        fail(`Packet ${packet.id}: each codex session must be an object`);
      if (
        ![
          session.sessionId,
          session.cliVersion,
          session.provider,
          session.model,
          session.reasoningEffort,
          session.configDigest,
        ].every(present) ||
        !["completed", "failed", "cancelled", "unfinished"].includes(
          session.outcome,
        ) ||
        !ROLES.includes(session.role)
      )
        fail(
          `Packet ${packet.id}: each codex session needs sessionId, cliVersion, provider, model, reasoningEffort, configDigest, outcome and role`,
        );
      if ("nativeCapturePath" in session)
        fail(
          `Packet ${packet.id}: nativeCapturePath is not read any more; the old capture metadata format is gone`,
        );
      claim(`codex stream ${session.path}`);
      claim(`codex thread ${session.sessionId}`);
      inside(
        session.startedAt,
        session.endedAt,
        `Session ${session.sessionId}`,
      );
      const observed = directSession(session);
      claim(`codex receipt ${observed.observationDigest}`);
      return observed;
    });

    const accepted = factory.filter((report) => report.outcome === "accepted");
    if (accepted.length > 1)
      fail(`Packet ${packet.id} has more than one accepted Objective`);
    const outcome: Outcome =
      packet.route === "factory"
        ? accepted.length
          ? "accepted"
          : factory.every((report) => report.outcome === "failed")
            ? "failed"
            : "unfinished"
        : packet.acceptance.outcome;
    if (outcome !== packet.acceptance.outcome)
      fail(
        `Packet ${packet.id} says ${packet.acceptance.outcome}, but Factory's state says ${outcome}`,
      );
    const result = accepted[0];
    if (
      result &&
      ((packet.bindings.resultCommit &&
        packet.bindings.resultCommit !== result.bindings.resultCommit) ||
        (packet.bindings.resultTree &&
          packet.bindings.resultTree !== result.bindings.resultTree))
    )
      fail(`Packet ${packet.id}: Factory's result differs from its bindings`);
    const acceptedAt =
      outcome === "accepted"
        ? (result?.acceptedAt ?? packet.acceptance.at ?? null)
        : null;
    const resultCommit =
      result?.bindings.resultCommit ?? packet.bindings.resultCommit ?? null;
    const resultTree =
      result?.bindings.resultTree ?? packet.bindings.resultTree ?? null;
    if (outcome === "accepted" && (!acceptedAt || !resultCommit || !resultTree))
      fail(
        `Packet ${packet.id} is accepted, so it needs acceptance.at and bindings.resultCommit and resultTree`,
      );
    if (acceptedAt)
      inside(selection.window.startedAt, acceptedAt, "Acceptance");
    const times = [
      ...factory.flatMap((report) =>
        report.startedAt && report.endedAt
          ? [report.startedAt, report.endedAt]
          : [],
      ),
      ...direct.flatMap((session) => [session.startedAt, session.endedAt]),
    ].sort((a, b) => time(a) - time(b));
    const first = times[0] ?? null;
    const last = times.at(-1) ?? null;
    if (acceptedAt && first && time(acceptedAt) < time(first))
      fail(`Packet ${packet.id} is accepted before its work started`);
    if (packet.workflow) {
      const { startedAt, endedAt } = packet.workflow;
      inside(startedAt, endedAt, `Packet ${packet.id}'s workflow`);
      if (
        (first && time(startedAt) > time(first)) ||
        (last && time(endedAt) < time(last)) ||
        (acceptedAt &&
          (time(startedAt) > time(acceptedAt) ||
            time(endedAt) < time(acceptedAt)))
      )
        fail(
          `Packet ${packet.id}: the workflow bounds must contain every selected run, session and the acceptance`,
        );
    }
    if (
      observations.postDeliveryWindowEndedAt &&
      (!acceptedAt ||
        time(observations.postDeliveryWindowEndedAt) < time(acceptedAt))
    )
      fail(
        `Packet ${packet.id}: the post-delivery window must end after acceptance`,
      );
    const runs = {
      available: factory.reduce(
        (sum, report) => sum + report.runs.available,
        0,
      ),
      total: factory.reduce((sum, report) => sum + report.runs.total, 0),
    };
    return {
      id: packet.id,
      task: packet.task,
      route: packet.route,
      scope: packet.scope,
      pairId: packet.pairId ?? null,
      outcome,
      acceptanceProvenance:
        packet.route === "factory"
          ? "Factory's Objective state"
          : "external substantive assessment",
      bindings: { ...packet.bindings, resultCommit, resultTree },
      acceptedAt,
      capturedStartedAt: first,
      capturedEndedAt: last,
      capturedWallMs: first && last ? time(last) - time(first) : null,
      workflow: packet.workflow ?? null,
      /** Only externally observed whole-workflow bounds give total time. */
      wallMs: packet.workflow
        ? time(packet.workflow.endedAt) - time(packet.workflow.startedAt)
        : null,
      timeToAcceptedMs:
        acceptedAt && packet.workflow
          ? time(acceptedAt) - time(packet.workflow.startedAt)
          : null,
      runs: packet.route === "factory" ? runs : null,
      filings: packet.route === "factory" ? factory.length : null,
      refiles: packet.route === "factory" ? factory.length - 1 : null,
      implementationAttempts:
        packet.route === "factory"
          ? factory.reduce((sum, report) => sum + report.workerCalls, 0)
          : direct.filter((session) => session.role === "implementation")
              .length,
      repairs:
        packet.route === "factory"
          ? factory.reduce((sum, report) => sum + report.repairs, 0)
          : null,
      firstTryPlanning:
        packet.route === "factory" &&
        factory.every((report) => report.firstTryPlanning !== null)
          ? factory.length === 1 && factory[0]!.firstTryPlanning
          : null,
      firstTryDelivery:
        packet.route === "factory" && outcome === "accepted"
          ? factory.length === 1
            ? factory[0]!.firstTryDelivery
            : factory.every((report) => report.runs.rotated.length === 0)
              ? false
              : null
          : null,
      holds: factory.length
        ? factory.reduce((sum, report) => sum + report.holds, 0)
        : null,
      holdWaitMs: factory.length
        ? factory.reduce((sum, report) => sum + report.holdWaitMs, 0)
        : null,
      observations: Object.fromEntries(
        [...OBSERVATIONS, "postDeliveryWindowEndedAt" as const].map((key) => [
          key,
          observations[key] ?? null,
        ]),
      ) as Record<(typeof OBSERVATIONS)[number], number | null> & {
        postDeliveryWindowEndedAt: string | null;
      },
      tokens: sumTokens([
        ...factory.map((report) => report.tokens),
        ...direct.map((session) => session.tokens),
      ]),
      costUsd:
        packet.route === "factory"
          ? known(factory.map((report) => report.costUsd.known))
          : { known: null, complete: false },
      cacheEffectiveness: sumCache([
        ...factory.map((report) => report.cacheEffectiveness),
        ...direct.map((session) => session.cacheEffectiveness),
      ]),
      cacheByRole: Object.fromEntries(
        [
          ...new Set([
            ...factory.flatMap((report) => Object.keys(report.cacheByRole)),
            ...direct.map((session) => session.role),
          ]),
        ].map((role) => [
          role,
          sumCache([
            ...factory.flatMap((report) =>
              report.cacheByRole[role] ? [report.cacheByRole[role]] : [],
            ),
            ...direct
              .filter((session) => session.role === role)
              .map((session) => session.cacheEffectiveness),
          ]),
        ]),
      ),
      factory,
      direct,
    };
  });

  const factorySessions = new Set(
    packets.flatMap((packet) =>
      packet.factory.flatMap((report) => report.bindings.providerSessionIds),
    ),
  );
  for (const packet of packets)
    for (const session of packet.direct)
      if (factorySessions.has(session.sessionId))
        fail(
          `Session ${session.sessionId} is one of Factory's own calls in this selection`,
        );

  const hours = (end - start) / 3_600_000;
  const batches = (["adopter", "factory-development"] as const).flatMap(
    (scope) =>
      (["factory", "codex-direct"] as const).flatMap((route) => {
        const selected = packets.filter(
          (packet) => packet.scope === scope && packet.route === route,
        );
        if (!selected.length) return [];
        const accepted = selected.filter(
          (packet) => packet.outcome === "accepted",
        ).length;
        const tokens = sumTokens(selected.map((packet) => packet.tokens));
        const tried = (key: "firstTryPlanning" | "firstTryDelivery") => ({
          passed: selected.filter((packet) => packet[key] === true).length,
          observed: selected.filter((packet) => packet[key] !== null).length,
        });
        return [
          {
            scope,
            route,
            packets: selected.length,
            accepted,
            failed: selected.filter((packet) => packet.outcome === "failed")
              .length,
            unfinished: selected.filter(
              (packet) => packet.outcome === "unfinished",
            ).length,
            runs:
              route === "factory"
                ? {
                    available: selected.reduce(
                      (sum, packet) => sum + (packet.runs?.available ?? 0),
                      0,
                    ),
                    total: selected.reduce(
                      (sum, packet) => sum + (packet.runs?.total ?? 0),
                      0,
                    ),
                  }
                : null,
            acceptedPerWindowHour: accepted / hours,
            windowElapsedMs: end - start,
            summedPacketWallMs: known(selected.map((packet) => packet.wallMs)),
            summedHoldWaitMs: known(
              selected.map((packet) => packet.holdWaitMs),
            ),
            operatorEffortMs: known(
              selected.map((packet) => packet.observations.operatorEffortMs),
            ),
            repairs: known(selected.map((packet) => packet.repairs)),
            firstTryPlanning: tried("firstTryPlanning"),
            firstTryDelivery: tried("firstTryDelivery"),
            abandonedAttemptTokens: sumTokens(
              selected.flatMap((packet) => [
                ...packet.factory
                  .filter((report) => report.outcome === "failed")
                  .map((report) => report.tokens),
                ...packet.direct
                  .filter((session) =>
                    ["failed", "cancelled"].includes(session.outcome),
                  )
                  .map((session) => session.tokens),
              ]),
            ),
            tokens,
            costUsd: known(selected.map((packet) => packet.costUsd.known)),
            cacheEffectiveness: sumCache(
              selected.map((packet) => packet.cacheEffectiveness),
            ),
            tokensPerAcceptedPacket: Object.fromEntries(
              CATEGORIES.map((category) => [
                category,
                {
                  known:
                    accepted && tokens[category].known !== null
                      ? tokens[category].known! / accepted
                      : null,
                  availability: tokens[category].availability,
                },
              ]),
            ),
          },
        ];
      }),
  );

  const delta = (left: number | null, right: number | null): Delta | null =>
    left === null || right === null
      ? null
      : {
          factory: left,
          direct: right,
          absolute: left - right,
          percent:
            right === 0
              ? null
              : Math.round(((left - right) / right) * 10_000) / 100,
        };
  const pairs = [
    ...new Set(packets.flatMap((packet) => packet.pairId ?? [])),
  ].map((id) => {
    const selected = packets.filter((packet) => packet.pairId === id);
    const factory = selected.find((packet) => packet.route === "factory");
    const direct = selected.find((packet) => packet.route === "codex-direct");
    const reasons: string[] = [];
    if (
      !selection.comparison?.planReference ||
      !selection.comparison.practicalImprovementCriterion
    )
      reasons.push("no precommitted comparison plan and practical criterion");
    if (selected.length !== 2 || !factory || !direct)
      reasons.push("a pair needs one packet from each route");
    if (factory && direct) {
      if ([factory, direct].some((packet) => packet.outcome !== "accepted"))
        reasons.push("both routes must pass substantive acceptance");
      if (
        factory.task !== direct.task ||
        factory.scope !== direct.scope ||
        factory.bindings.sourceDigest !== direct.bindings.sourceDigest ||
        factory.bindings.baseCommit !== direct.bindings.baseCommit ||
        factory.bindings.environmentReference !==
          direct.bindings.environmentReference
      )
        reasons.push("task, source, base or environment assessment differs");
      if (factory.runs && factory.runs.available < factory.runs.total)
        reasons.push(
          `Factory's run log has ${factory.runs.available} of ${factory.runs.total} runs`,
        );
    }
    return {
      id,
      comparable: reasons.length === 0,
      reasons,
      deltas:
        reasons.length || !factory || !direct
          ? null
          : {
              timeToAcceptedMs: delta(
                factory.timeToAcceptedMs,
                direct.timeToAcceptedMs,
              ),
              capturedWallMs: delta(
                factory.capturedWallMs,
                direct.capturedWallMs,
              ),
              operatorEffortMs: delta(
                factory.observations.operatorEffortMs,
                direct.observations.operatorEffortMs,
              ),
              implementationAttempts: delta(
                factory.implementationAttempts,
                direct.implementationAttempts,
              ),
              tokens: Object.fromEntries(
                CATEGORIES.map((category) => [
                  category,
                  factory.tokens[category].availability === "available" &&
                  direct.tokens[category].availability === "available"
                    ? delta(
                        factory.tokens[category].known,
                        direct.tokens[category].known,
                      )
                    : null,
                ]),
              ),
            },
    };
  });

  const runs = {
    available: packets.reduce((sum, p) => sum + (p.runs?.available ?? 0), 0),
    total: packets.reduce((sum, p) => sum + (p.runs?.total ?? 0), 0),
  };
  return redactDeep(
    {
      schemaVersion: 1 as const,
      selectionDigest: digest(JSON.stringify(selection)),
      window: selection.window,
      comparison: selection.comparison ?? null,
      /** Factory runs the run log still has, of all the selected Objectives' runs. */
      runs,
      packets,
      batches,
      pairs,
      limitations: [
        "Selected observations only: the selection must include every failed or cancelled attempt and the setup, authoring, review and recovery work around it.",
        "Total time and time to acceptance need externally observed workflow bounds; captured timing alone omits uncaptured human work.",
        "Hold waits are elapsed time, not operator attention; effort, redirections and corrections come only from external observations.",
        "Cached input is part of input and reasoning part of output; categories are never added into a cost.",
        "Cache hit rates weight cached over input of the calls that report both; partial coverage describes those calls only, not billed cost.",
        "Summed packet times overlap when packets ran in parallel; the window's elapsed time is reported apart.",
        "Codex zero cached or reasoning counts can be filled in upstream, so a direct session's zero stays unknown.",
        "Run-log retention rotates old runs away: an Objective with fewer runs available than it had reports partial counts and no first-try verdict, and its pair is not comparable.",
        "No verdict from a small sample or incomplete dimensions: apply the predeclared criterion to independently assessed evidence.",
      ],
    },
    read.secrets,
  );
}

export type Scorecard = ReturnType<typeof scorecard>;

// --- text -------------------------------------------------------------------

const percent = (rate: number | null) =>
  rate === null ? "unknown" : `${(rate * 100).toFixed(1)}%`;
const counter = (c: { known: number | null }) =>
  c.known === null ? "unknown" : c.known.toLocaleString("en-US");

function cacheLine(label: string, cache: CacheEffectiveness): string {
  return `  ${label}: ${percent(cache.hitRate)} cached of input (${counter({ known: cache.cached })}/${counter({ known: cache.input })}; ${cache.pairedCalls}/${cache.eligibleCalls} calls, ${cache.availability})`;
}

const runsText = (runs: { available: number; total: number }) =>
  `${runs.available} of ${runs.total} runs available${runs.available < runs.total ? ` (${runs.total - runs.available} rotated away by run-log retention; counts are partial)` : ""}`;

/** The scorecard for people; `--json` has every binding, role, phase and pair delta. */
export function scorecardText(report: Scorecard): string {
  const lines = [
    `Scorecard ${displayTime(report.window.startedAt)} to ${displayTime(report.window.endedAt)}`,
  ];
  if (report.runs.total) lines.push(`Factory: ${runsText(report.runs)}`);
  for (const batch of report.batches) {
    lines.push(
      "",
      `${batch.scope} / ${batch.route}: ${batch.accepted} accepted, ${batch.failed} failed, ${batch.unfinished} unfinished (${batch.packets} packets)${batch.runs ? ` · ${runsText(batch.runs)}` : ""}`,
    );
    for (const category of CATEGORIES)
      lines.push(
        `  ${category} tokens: ${counter(batch.tokens[category])} (${batch.tokens[category].availability})`,
      );
    if (batch.route === "factory")
      lines.push(
        `  cost: ${batch.costUsd.known === null ? "unknown" : `$${batch.costUsd.known.toFixed(2)}${batch.costUsd.complete ? "" : " (partial)"}`} · repairs: ${counter(batch.repairs)} · first-try planning ${batch.firstTryPlanning.passed}/${batch.firstTryPlanning.observed}, delivery ${batch.firstTryDelivery.passed}/${batch.firstTryDelivery.observed}`,
      );
    lines.push(cacheLine("cache", batch.cacheEffectiveness));
  }
  lines.push("");
  for (const packet of report.packets) {
    lines.push(
      `${packet.id} (${packet.route}): ${packet.outcome}; time to acceptance ${packet.timeToAcceptedMs === null ? "unavailable" : duration(packet.timeToAcceptedMs)}; captured ${packet.capturedWallMs === null ? "unavailable" : duration(packet.capturedWallMs)}; operator effort ${packet.observations.operatorEffortMs === null ? "unavailable" : duration(packet.observations.operatorEffortMs)}`,
    );
    for (const report of packet.factory)
      lines.push(
        `  #${report.objective}: ${report.outcome} · ${runsText(report.runs)} · ${report.modelCalls} model calls · ${report.repairs} repairs · ${report.holds} holds`,
      );
  }
  for (const pair of report.pairs) {
    lines.push(
      "",
      `Pair ${pair.id}: ${pair.comparable ? "comparable" : `not comparable: ${pair.reasons.join("; ")}`}`,
    );
    if (!pair.deltas) continue;
    const show = (label: string, d: Delta | null, ms = false) =>
      lines.push(
        `  ${label}: ${d === null ? "unavailable" : `Factory ${ms ? duration(d.factory) : counter({ known: d.factory })} vs direct ${ms ? duration(d.direct) : counter({ known: d.direct })} (${d.percent === null ? "n/a" : `${d.percent > 0 ? "+" : ""}${d.percent}%`})`}`,
      );
    show("time to acceptance", pair.deltas.timeToAcceptedMs, true);
    show("captured wall time", pair.deltas.capturedWallMs, true);
    show("operator effort", pair.deltas.operatorEffortMs, true);
    show("implementation attempts", pair.deltas.implementationAttempts);
    for (const category of CATEGORIES)
      show(`${category} tokens`, pair.deltas.tokens[category] ?? null);
  }
  lines.push(
    "",
    "The selection and its external observations need independent assessment; unknown counts stay unknown. --json has the bindings, roles, phases and per-metric pair deltas.",
  );
  return `${lines.join("\n")}\n`;
}
