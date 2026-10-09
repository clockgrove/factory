import type { DiagnosticEvent } from "./diagnostics.js";

/**
 * Per-Objective efficiency, derived only from recorded diagnostics events. Stage time is the
 * union of its intervals, so overlapping or repeated intervals count once. Reported event
 * durations are never summed: state-derived events carry the whole Work Item's duration.
 */

export const efficiencyStages = [
  "plan",
  "implement",
  "validate",
  "delivery",
  "final",
  "closure",
] as const;
export type EfficiencyStage = (typeof efficiencyStages)[number];
type Phase = EfficiencyStage | "wait";
type Interval = [start: number, end: number];

type ControllerEvent = Pick<
  DiagnosticEvent,
  "at" | "operation" | "outcome" | "itemId" | "attemptId"
>;

const startsOrObserved = (outcome: string) =>
  outcome === "started" || outcome === "observed";

/** The phase an event begins, "idle" when it ends the current one, undefined when it is neither. */
function transition(event: ControllerEvent): Phase | "idle" | undefined {
  const { operation: op, outcome } = event;
  if (op === "planning" && outcome === "started") return "plan";
  if (op === "planning") return outcome === "observed" ? undefined : "idle";
  if ((op === "harness" || op === "execute") && outcome === "started")
    return "implement";
  if (op === "validate" && startsOrObserved(outcome)) return "validate";
  if (op === "acceptance-review" && outcome === "started") return "validate";
  if (op === "acceptance-review" && outcome !== "observed") return "idle";
  if (["deliver", "published"].includes(op) && startsOrObserved(outcome))
    return "delivery";
  if (
    ["github-publication", "github-merge"].includes(op) &&
    outcome === "started"
  )
    return "delivery";
  if (op === "github-closure" && outcome === "completed") return "idle";
  if (op === "objective-validation" && startsOrObserved(outcome))
    return "final";
  if (op === "objective-acceptance-review" && outcome === "started")
    return "final";
  if (op === "objective-acceptance-review" && outcome !== "observed")
    return "idle";
  if (op === "objective-validation" && outcome === "completed")
    return "closure";
  if (op === "objective-finalization" && outcome === "completed") return "idle";
  // The Objective is waiting for a decision from the operator until it is given.
  if (
    ["acceptance-pending", "objective-acceptance-pending"].includes(op) &&
    (outcome === "waiting" || outcome === "observed")
  )
    return "wait";
  if (
    ["approve-result", "objective-validation"].includes(op) &&
    outcome === "waiting"
  )
    return "wait";
  // A run that stops waiting for a human ends its phase. The wait itself is counted as a
  // human stop, up to the next run start or operator command.
  if (op === "objective-run" && outcome === "waiting") return "idle";
  if (
    [
      "acceptance-decision",
      "objective-acceptance-decision",
      "step-retry",
      "work-retry",
    ].includes(op) &&
    outcome === "completed"
  )
    return "idle";
  // A step that failed ends the phase it was in. Failed provider calls inside a phase do not.
  if (
    outcome === "failed" &&
    [
      "harness",
      "execute",
      "validate",
      "deliver",
      "published",
      "objective-run",
      "objective-validation",
    ].includes(op)
  )
    return "idle";
  return undefined;
}

/** Operations that only an operator command emits: each answers or ends a human wait. */
const operatorCommands = [
  "step-retry",
  "work-retry",
  "acceptance-decision",
  "objective-acceptance-decision",
  "planning-decision",
  "result-rereview-request",
  "media-selection",
  "objective-cancel",
];

/**
 * An event that leaves the Objective or a Work Item waiting for a human: a decision, a
 * criterion to accept, an asset to select, or a Work Item that failed and still needs a repair.
 */
function humanWait(event: ControllerEvent): boolean {
  const { operation: op, outcome } = event;
  if (
    outcome === "waiting" &&
    [
      "objective-run",
      "objective-validation",
      "acceptance-pending",
      "objective-acceptance-pending",
      "approve-result",
      "approve-asset",
    ].includes(op)
  )
    return true;
  if (
    outcome === "observed" &&
    ["acceptance-pending", "objective-acceptance-pending"].includes(op)
  )
    return true;
  // A failure only stays a wait if nothing in its scope runs again before an operator acts.
  return (
    event.itemId !== undefined &&
    outcome === "failed" &&
    transition(event) === "idle"
  );
}

/** Merge overlapping or touching intervals. */
export function unionIntervals(intervals: Interval[]): Interval[] {
  const merged: Interval[] = [];
  for (const [start, end] of [...intervals].sort((a, b) => a[0] - b[0])) {
    const last = merged.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

const length = (intervals: Interval[]) =>
  unionIntervals(intervals).reduce((sum, [start, end]) => sum + end - start, 0);

export interface RoleUsage {
  inputTokens: number | null;
  cachedInputTokens: number | null;
  /** Ratio within selected invocation counter pairs; not all role input. */
  cachedShare: number | null;
  cacheRatioInputTokens: number | null;
  outputTokens: number | null;
  reasoningOutputTokens: number | null;
  models: string[];
  coverage: Record<string, string>;
}

interface UsageSummaryLike {
  workerUsage: {
    tokenTotals: Partial<Record<string, number>>;
    cacheReadRatio: { value: number; denominatorInputTokens: number } | null;
    coverage?: { byCategory: Record<string, string> };
  };
  modelUsage: {
    tokenTotals: Partial<Record<string, number>>;
    cacheReadRatio: { value: number; denominatorInputTokens: number } | null;
    coverage?: { byCategory: Record<string, string> };
  };
  objective: { invocationCount: number; failedCount: number };
}

function roleUsage(
  aggregate: UsageSummaryLike["workerUsage"],
  models: Set<string>,
): RoleUsage {
  const total = (key: string) => aggregate.tokenTotals[key] ?? null;
  return {
    inputTokens: total("inputTokens"),
    cachedInputTokens: total("cachedInputTokens"),
    cachedShare: aggregate.cacheReadRatio?.value ?? null,
    cacheRatioInputTokens:
      aggregate.cacheReadRatio?.denominatorInputTokens ?? null,
    outputTokens: total("outputTokens"),
    reasoningOutputTokens: total("reasoningOutputTokens"),
    models: [...models].sort(),
    coverage: aggregate.coverage?.byCategory ?? {},
  };
}

const modelLabel = (model: unknown, effort: unknown) =>
  typeof model === "string" && model
    ? typeof effort === "string" && effort
      ? `${model} (${effort})`
      : model
    : undefined;

/**
 * `controller` is the diagnostics file's events, `usage` its usage-summary events and
 * `summary` their `summarizeDiagnosticUsage` result. `now` bounds a phase that never ended.
 */
export function summarizeEfficiency(
  controller: ControllerEvent[],
  usage: Record<string, unknown>[],
  summary: UsageSummaryLike & {
    workerUsage: { byInvocation: Record<string, Record<string, unknown>> };
  },
  now: number,
) {
  const events = controller
    .map((event, index) => ({ event, index, time: Date.parse(event.at) }))
    .filter((entry) => Number.isFinite(entry.time))
    .sort((a, b) => a.time - b.time || a.index - b.index);

  const firstStart = events.find(
    (entry) =>
      entry.event.operation === "objective-run" &&
      entry.event.outcome === "started",
  );
  const startedAt = (firstStart ?? events[0])?.time;
  const finished = events.find(
    (entry) =>
      entry.event.operation === "objective-finalization" &&
      entry.event.outcome === "completed",
  );
  // A cancelled Objective ends at its cancellation, unless a later run started it again.
  const cancelled = events
    .filter(
      (entry) =>
        entry.event.operation === "objective-cancel" &&
        entry.event.outcome === "completed",
    )
    .at(-1);
  const cancelledAt =
    cancelled &&
    !events.some(
      (entry) =>
        entry.index !== cancelled.index &&
        entry.time >= cancelled.time &&
        entry.event.operation === "objective-run" &&
        entry.event.outcome === "started",
    )
      ? cancelled.time
      : undefined;
  const endedAt = finished?.time ?? cancelledAt ?? now;

  const spans: { phase: Phase; interval: Interval }[] = [];
  // One open phase per scope: a Work Item, or the Objective itself.
  const open = new Map<string, { phase: Phase; since: number }>();
  for (const { event, time } of events) {
    const next = transition(event);
    if (next === undefined) continue;
    const scope = event.itemId ?? "";
    const current = open.get(scope);
    if (current && next === current.phase) continue;
    if (current) {
      spans.push({ phase: current.phase, interval: [current.since, time] });
      open.delete(scope);
    }
    if (next !== "idle") open.set(scope, { phase: next, since: time });
  }
  for (const current of open.values())
    spans.push({ phase: current.phase, interval: [current.since, endedAt] });

  // Human stops: from the event that leaves a scope waiting for a human until the next run
  // start or operator command. A run records no end, so the wait is read from where the next
  // one begins; the operator's time is whatever passes before they act.
  let humanStops = 0;
  const waiting = new Map<string, number>();
  for (const { event, time } of events) {
    const scope = event.itemId ?? "";
    const runStart =
      event.operation === "objective-run" && event.outcome === "started";
    if (runStart || operatorCommands.includes(event.operation)) {
      let released = false;
      for (const [waitingScope, since] of waiting) {
        if (!runStart && event.itemId && waitingScope && waitingScope !== scope)
          continue;
        spans.push({ phase: "wait", interval: [since, time] });
        waiting.delete(waitingScope);
        released = true;
      }
      if (released) humanStops++;
    } else if (humanWait(event)) {
      if (!waiting.has(scope)) waiting.set(scope, time);
    } else {
      const next = transition(event);
      if (next !== undefined && next !== "idle" && next !== "wait")
        waiting.delete(scope);
    }
  }
  if (!finished && waiting.size > 0) {
    for (const since of waiting.values())
      spans.push({ phase: "wait", interval: [since, endedAt] });
    humanStops++;
  }
  const clip = (interval: Interval): Interval[] => {
    const start = Math.max(interval[0], startedAt ?? interval[0]);
    const end = Math.min(interval[1], endedAt);
    return end > start ? [[start, end]] : [];
  };
  const intervals = (phase: Phase) =>
    spans
      .filter((span) => span.phase === phase)
      .flatMap((s) => clip(s.interval));

  const stageMs = Object.fromEntries(
    efficiencyStages.map((stage) => [stage, length(intervals(stage))]),
  ) as Record<EfficiencyStage, number>;
  const operatorWaitMs = length(intervals("wait"));
  const wallMs = startedAt === undefined ? 0 : Math.max(0, endedAt - startedAt);
  const accountedMs = length(spans.flatMap((span) => clip(span.interval)));

  const attemptIds = new Set<string>();
  const failedAttemptIds = new Set<string>();
  for (const event of [...controller, ...(usage as ControllerEvent[])]) {
    if (
      typeof event.attemptId !== "string" ||
      ["model-invocation", "model-capture"].includes(event.operation)
    )
      continue;
    attemptIds.add(event.attemptId);
    const workerType = (event as { workerUsage?: { type?: unknown } })
      .workerUsage?.type;
    if (event.outcome === "failed" || workerType === "failed")
      failedAttemptIds.add(event.attemptId);
  }
  const count = (operation: string, outcome: string) =>
    controller.filter(
      (event) => event.operation === operation && event.outcome === outcome,
    ).length;

  const plannerModels = new Set<string>();
  for (const event of usage) {
    if (event.operation !== "model-invocation") continue;
    const metadata = event.metadata as Record<string, unknown> | undefined;
    const label = modelLabel(metadata?.model, metadata?.reasoningEffort);
    if (label) plannerModels.add(label);
  }
  const workerModels = new Set<string>();
  for (const invocation of Object.values(summary.workerUsage.byInvocation)) {
    const label = modelLabel(invocation.model, invocation.reasoningEffort);
    if (label) workerModels.add(label);
  }

  return {
    schemaVersion: 1 as const,
    startedAt:
      startedAt === undefined ? null : new Date(startedAt).toISOString(),
    endedAt: startedAt === undefined ? null : new Date(endedAt).toISOString(),
    finished: finished !== undefined,
    cancelled: cancelledAt !== undefined,
    wallMs,
    stageMs,
    operatorWaitMs,
    /** Times a run stopped for a human (decision, repair or criterion) and later resumed. */
    humanStops,
    /** Wall time in no stage and no wait: restarts, scheduling and publication gaps. */
    unattributedMs: Math.max(0, wallMs - accountedMs),
    attempts: {
      worker: attemptIds.size,
      failedWorker: failedAttemptIds.size,
      retries: count("work-retry", "completed"),
      operatorRetries: count("step-retry", "completed"),
      planningRuns: count("planning", "started"),
      failedPlanningRuns: count("planning", "failed"),
      modelCalls: summary.objective.invocationCount,
      failedModelCalls: summary.objective.failedCount,
    },
    tokens: {
      worker: roleUsage(summary.workerUsage, workerModels),
      plannerAndReviewers: roleUsage(summary.modelUsage, plannerModels),
    },
  };
}

export type EfficiencyReport = ReturnType<typeof summarizeEfficiency>;

export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60)
    return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

function formatTokens(value: number | null): string {
  if (value === null) return "unknown";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

const stageLabels: Record<EfficiencyStage, string> = {
  plan: "Plan (compile, graph review)",
  implement: "Implement (worker)",
  validate: "Validate + result review",
  delivery: "Delivery (PR, CI, merge)",
  final: "Final validation + review",
  closure: "Closure",
};

/** One screen of plain text; unknown stays unknown, never zero. */
export function renderEfficiency(report: EfficiencyReport): string {
  const lines = [
    `Total wall time: ${formatDuration(report.wallMs)}${report.finished ? "" : report.cancelled ? " (cancelled)" : " (still running)"}`,
    ...(report.startedAt
      ? [`  from ${report.startedAt} to ${report.endedAt}`]
      : []),
    "",
    "Time per stage (union of intervals; parallel work counts once):",
  ];
  for (const stage of efficiencyStages)
    lines.push(
      `  ${stageLabels[stage].padEnd(32)} ${formatDuration(report.stageMs[stage])}`,
    );
  lines.push(
    `  ${"Waiting on the operator".padEnd(32)} ${formatDuration(report.operatorWaitMs)}`,
    `  ${"Other (restarts, gaps)".padEnd(32)} ${formatDuration(report.unattributedMs)}`,
  );
  const a = report.attempts;
  lines.push(
    "",
    `Human stops: ${report.humanStops}`,
    `Worker attempts: ${a.worker} (${a.failedWorker} failed); repairs and retries: ${a.retries} (+${a.operatorRetries} operator step retries)`,
    `Planning runs: ${a.planningRuns} (${a.failedPlanningRuns} failed); planner and reviewer model calls: ${a.modelCalls} (${a.failedModelCalls} failed)`,
    "",
    "Tokens (input, of which cached, output, reasoning):",
  );
  for (const [label, role] of [
    ["Worker", report.tokens.worker],
    ["Planner and reviewers", report.tokens.plannerAndReviewers],
  ] as const) {
    const cached =
      role.cachedShare === null
        ? ""
        : ` (${Math.round(role.cachedShare * 100)}% of ${formatTokens(role.cacheRatioInputTokens)} paired invocation input; response category coverage not established here)`;
    lines.push(
      `  ${label.padEnd(22)} in ${formatTokens(role.inputTokens)}, cached ${formatTokens(role.cachedInputTokens)}${cached}, out ${formatTokens(role.outputTokens)}, reasoning ${formatTokens(role.reasoningOutputTokens)}`,
      `  ${"".padEnd(22)} accounting: input ${role.coverage.inputTokens ?? "unavailable"}, cached ${role.coverage.cachedInputTokens ?? "unavailable"}, output ${role.coverage.outputTokens ?? "unavailable"}, reasoning ${role.coverage.reasoningOutputTokens ?? "unavailable"}`,
      `  ${"".padEnd(22)} models: ${role.models.join(", ") || "unknown"}`,
    );
  }
  return `${lines.join("\n")}\n`;
}
