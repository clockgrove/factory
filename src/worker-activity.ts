import { existsSync, lstatSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { stateRoot } from "./config.js";
import { privateRecords } from "./diagnostics.js";
import { displayClock } from "./display-time.js";
import { factoryFilesToolName } from "./execution/claude-files.js";
import { factoryValidationToolName } from "./execution/claude-validation.js";
import { ownsPath } from "./ownership.js";
import {
  type AttemptKind,
  attemptKindLabel,
  attemptOrigin,
} from "./repair-policy.js";
import { pinnedGitRawWithin } from "./process.js";
import { type ContinuationState, isExecutionState } from "./state.js";

/** One recorded worker tool call: metadata only. */
interface WorkerToolEvent {
  at: string;
  tool: string;
  target?: string;
}

/** What a worker's progress stream shows about its activity. Telemetry only. */
interface WorkerActivity {
  provider?: string;
  startedAt?: string;
  lastEventAt?: string;
  /**
   * The latest structural progress: an edit of an owned path or a Factory
   * validation call in the stream, or a changed owned file's modification.
   */
  lastProgressAt?: string;
  /** Completed Factory validation runs. */
  validationRuns?: number;
  lastValidationPassAt?: string;
  /** The first failed run since the last pass, while runs keep failing. */
  validationFailingSince?: string;
  /** Failed runs since the last pass. */
  validationFailingRuns?: number;
  /** Model turns (Claude) or started tool steps (Codex). */
  turns: number;
  /** Output tokens so far, when reported. */
  outputTokens?: number;
  /** The latest turn's input context, when reported. */
  contextTokens?: number;
  compactions: number;
  recent: WorkerToolEvent[];
}

/** A Work Item's current state with its worker's activity, when it is running locally. */
export interface ItemActivity {
  id: string;
  status: string;
  step?: string;
  attempt?: string;
  /** The attempt's ordinal and how it started (`attemptOrigin`). */
  attemptNumber?: number;
  attemptKind?: AttemptKind;
  pullRequest?: number;
  activity?: WorkerActivity;
  /** Paths changed in the worker's checkout so far. */
  changes?: string[];
}

const ATTEMPT =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function workerProgressPath(repository: string, attempt: string): string {
  if (!ATTEMPT.test(attempt)) throw new Error("Invalid worker attempt ID");
  return join(stateRoot(repository), "harness", `${attempt}.progress.ndjson`);
}

const CONTROL = /\p{Cc}/u;

/** Claude tools that change a file's content, including Factory's owned-file delete. */
const EDIT_TOOLS = [
  "Edit",
  "MultiEdit",
  "Write",
  "NotebookEdit",
  factoryFilesToolName,
];

/** How long a worker may emit events without progress before it is called out. */
export const PROGRESS_QUIET_MS = 15 * 60_000;

/** How long validation may keep failing before it is called out. */
const VALIDATION_FAILING_MS = 20 * 60_000;

const count = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;

/**
 * Summarize a worker's progress stream, or undefined when it has none. With
 * `owned`, only edits inside those ownership scopes count as progress.
 */
function readWorkerActivity(
  repository: string,
  attempt: string,
  recentLimit = 8,
  owned?: string[],
): WorkerActivity | undefined {
  const path = workerProgressPath(repository, attempt);
  if (!existsSync(path)) return undefined;
  const messages = new Set<string>();
  let steps = 0;
  let outputTokens = 0;
  let sawOutput = false;
  let contextTokens: number | undefined;
  const activity: WorkerActivity = { turns: 0, compactions: 0, recent: [] };
  const remember = (event: WorkerToolEvent) => {
    activity.recent.push(event);
    if (activity.recent.length > recentLimit) activity.recent.shift();
  };
  const edited = (target: unknown) =>
    typeof target === "string" && (!owned || ownsPath(target, owned));
  for (const event of privateRecords(path)) {
    const at = typeof event.at === "string" ? event.at : undefined;
    if (at) {
      activity.startedAt ??= at;
      activity.lastEventAt = at;
    }
    const operation = event.operation;
    if (operation === "worker-usage") {
      const usage = event.workerUsage as { provider?: unknown } | undefined;
      if (typeof usage?.provider === "string")
        activity.provider ??= usage.provider;
    }
    if (operation === "assistant") {
      const id =
        typeof event.providerMessageId === "string"
          ? event.providerMessageId
          : String(event.eventId);
      messages.add(id);
      const usage = event.usage as Record<string, unknown> | undefined;
      if (usage) {
        sawOutput = true;
        outputTokens += count(usage.output_tokens);
        contextTokens =
          count(usage.input_tokens) +
          count(usage.cache_read_input_tokens) +
          count(usage.cache_creation_input_tokens);
      }
    }
    if (operation === "system" && event.subtype === "compact_boundary")
      activity.compactions += 1;
    const validation = event.validation as { passed?: unknown } | undefined;
    if (
      operation === "validation" &&
      typeof validation?.passed === "boolean" &&
      at
    ) {
      activity.lastProgressAt = at;
      activity.validationRuns = (activity.validationRuns ?? 0) + 1;
      if (validation.passed) {
        activity.lastValidationPassAt = at;
        delete activity.validationFailingSince;
        delete activity.validationFailingRuns;
      } else {
        activity.validationFailingSince ??= at;
        activity.validationFailingRuns =
          (activity.validationFailingRuns ?? 0) + 1;
      }
    }
    if (Array.isArray(event.tools) && at)
      for (const tool of event.tools as { tool?: unknown; target?: unknown }[])
        if (typeof tool?.tool === "string") {
          if (
            tool.tool === factoryValidationToolName ||
            (EDIT_TOOLS.includes(tool.tool) && edited(tool.target))
          )
            activity.lastProgressAt = at;
          remember({
            at,
            tool: tool.tool,
            ...(typeof tool.target === "string" && { target: tool.target }),
          });
        }
    if (operation === "item.started" && typeof event.tool === "string" && at) {
      steps += 1;
      remember({
        at,
        tool: event.tool,
        ...(typeof event.target === "string" && { target: event.target }),
      });
    }
    if (
      operation === "item.completed" &&
      event.tool === "edit" &&
      Array.isArray(event.paths) &&
      at
    )
      for (const target of event.paths)
        if (typeof target === "string") {
          if (edited(target)) activity.lastProgressAt = at;
          remember({ at, tool: "edit", target });
        }
    if (operation === "turn.completed") {
      const usage = event.usage as Record<string, unknown> | undefined;
      if (usage) {
        sawOutput = true;
        outputTokens += count(usage.output_tokens);
      }
    }
  }
  activity.turns = messages.size || steps;
  if (sawOutput) activity.outputTokens = outputTokens;
  if (contextTokens !== undefined) activity.contextTokens = contextTokens;
  return activity;
}

/**
 * Paths changed so far in a worker checkout, excluding Factory's private staging,
 * or undefined when unknown. Takes no index lock, so a worker's own `git add` or
 * commit never collides with it, and gives up after 5 seconds.
 */
function worktreeChanges(worktree: string): string[] | undefined {
  try {
    const raw = pinnedGitRawWithin(
      worktree,
      5000,
      "--no-optional-locks",
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ).toString("utf8");
    const entries = raw.split("\0");
    const paths = new Set<string>();
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index]!;
      if (entry.length < 4) continue;
      const code = entry.slice(0, 2);
      const path = entry.slice(3);
      // A rename or copy is followed by its original path.
      if (code.includes("R") || code.includes("C")) index += 1;
      // A control character could break out of the public comment's code span.
      if (
        !CONTROL.test(path) &&
        !path.split("/").some((part) => part.startsWith(".factory-"))
      )
        paths.add(path);
    }
    return [...paths].sort();
  } catch {
    return undefined;
  }
}

/** The latest modification of a changed owned file, or undefined. */
function lastChangeAt(
  worktree: string,
  changes: string[],
  owned: string[] | undefined,
): string | undefined {
  let latest = 0;
  for (const path of changes) {
    if (owned && !ownsPath(path, owned)) continue;
    try {
      latest = Math.max(latest, lstatSync(join(worktree, path)).mtimeMs);
    } catch {
      // A deleted path has no modification time.
    }
  }
  return latest ? new Date(latest).toISOString() : undefined;
}

/** Each Work Item's state, with worker activity and checkout changes while it executes locally. */
export function itemActivities(
  repository: string,
  state: ContinuationState,
): ItemActivity[] {
  if (!isExecutionState(state)) return [];
  const worktrees = resolve(stateRoot(repository), "worktrees") + sep;
  return Object.entries(state.work).map(([id, work]) => {
    const origin = attemptOrigin(work);
    const item: ItemActivity = {
      id,
      status: work.status,
      ...(work.step && { step: work.step }),
      ...(work.attempt && { attempt: work.attempt }),
      ...(origin && { attemptNumber: origin.number, attemptKind: origin.kind }),
      ...(work.pullRequest && { pullRequest: work.pullRequest }),
    };
    if (
      work.status !== "running" ||
      !work.attempt ||
      !ATTEMPT.test(work.attempt)
    )
      return item;
    const owned = state.graph.items.find(
      (entry) => entry.id === id,
    )?.ownedPaths;
    try {
      const activity = readWorkerActivity(repository, work.attempt, 8, owned);
      if (activity) item.activity = activity;
    } catch {
      // Telemetry only: an unreadable stream leaves activity unknown.
    }
    const data = work.execution?.data as { worktree?: unknown } | undefined;
    if (
      work.step === "execute" &&
      typeof data?.worktree === "string" &&
      resolve(data.worktree).startsWith(worktrees)
    ) {
      const changes = worktreeChanges(data.worktree);
      if (changes) item.changes = changes;
      // Shell edits leave no tool target: a changed owned file's mtime shows them.
      const changedAt = changes && lastChangeAt(data.worktree, changes, owned);
      if (
        item.activity &&
        changedAt &&
        changedAt > (item.activity.lastProgressAt ?? "")
      )
        item.activity.lastProgressAt = changedAt;
    }
    return item;
  });
}

/** A short age such as `42s`, `7m` or `3h`. */
export function shortAge(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 120) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 120 ? `${minutes}m` : `${Math.round(minutes / 60)}h`;
}

/** A token count such as `950`, `42k` or `1.2M`. */
export const formatTokens = (value: number): string =>
  value >= 1_000_000
    ? `${(value / 1_000_000).toFixed(1)}M`
    : value >= 1000
      ? `${Math.round(value / 1000)}k`
      : String(value);

/** One line of worker liveness and effort, or undefined without activity. */
export function activityLine(
  activity: WorkerActivity | undefined,
  now: number,
  staleMs: number,
): string | undefined {
  if (!activity?.lastEventAt) return undefined;
  const age = now - Date.parse(activity.lastEventAt);
  const quiet = progressQuietMs(activity, now);
  return [
    `last worker activity ${shortAge(age)} ago${age > staleMs ? " (stale)" : ""}`,
    // Events still flow, yet no owned file changed and nothing was validated.
    ...(age <= staleMs && quiet !== undefined && quiet > PROGRESS_QUIET_MS
      ? [`no progress for ${shortAge(quiet)}`]
      : []),
    ...validationLine(activity, now),
    `${activity.turns} turns`,
    ...(activity.contextTokens !== undefined
      ? [`context ${formatTokens(activity.contextTokens)}`]
      : []),
    ...(activity.compactions
      ? [
          `${activity.compactions} compaction${activity.compactions === 1 ? "" : "s"}`,
        ]
      : []),
  ].join(" · ");
}

/** Validation failing past its threshold, with the last pass's age. */
function validationLine(activity: WorkerActivity, now: number): string[] {
  if (!activity.validationFailingSince) return [];
  const failing = now - Date.parse(activity.validationFailingSince);
  if (!(failing > VALIDATION_FAILING_MS)) return [];
  const runs = activity.validationFailingRuns ?? 0;
  return [
    `validation failing for ${shortAge(failing)} (${runs} run${runs === 1 ? "" : "s"})`,
    activity.lastValidationPassAt
      ? `last passing validation ${shortAge(now - Date.parse(activity.lastValidationPassAt))} ago`
      : "no passing validation yet",
  ];
}

/** Providers whose progress stream names edited files. */
const REPORTS_EDITS = ["claude", "codex"];

/**
 * How long the worker has gone without progress in this attempt, from its
 * start when it has made none, or undefined when nothing could show it.
 */
export function progressQuietMs(
  activity: WorkerActivity,
  now: number,
): number | undefined {
  if (
    activity.lastProgressAt === undefined &&
    !REPORTS_EDITS.includes(activity.provider ?? "")
  )
    return undefined;
  const since = Math.max(
    Date.parse(activity.lastProgressAt ?? "") || 0,
    Date.parse(activity.startedAt ?? "") || 0,
  );
  return since ? now - since : undefined;
}

/** Recent tool calls such as `Read a.ts · Edit b.ts · Bash pnpm`. */
function recentLine(activity: WorkerActivity | undefined): string | undefined {
  if (!activity?.recent.length) return undefined;
  return activity.recent
    .map((event) =>
      event.target ? `${event.tool} ${event.target}` : event.tool,
    )
    .join(" · ");
}

/** Changed paths such as `3: a.ts, b.ts, c.ts`, at most eight named. */
export function changesLine(changes: string[] | undefined): string | undefined {
  const limit = 8;
  if (!changes) return undefined;
  if (!changes.length) return "none yet";
  const named = changes.slice(0, limit).join(", ");
  return `${changes.length}: ${named}${changes.length > limit ? `, +${changes.length - limit} more` : ""}`;
}

/** A Work Item's headline: state, step, attempt and pull request. */
function itemHeadline(item: ItemActivity): string {
  return [
    `${item.id} · ${item.status}${item.step ? ` (${item.step})` : ""}`,
    ...(item.attempt
      ? [
          `attempt ${item.attemptNumber ? `${item.attemptNumber} (${item.attempt.slice(0, 8)})` : item.attempt.slice(0, 8)}`,
        ]
      : []),
    ...(item.attemptNumber && item.attemptNumber > 1 && item.attemptKind
      ? [attemptKindLabel(item.attemptKind)!]
      : []),
    ...(item.pullRequest ? [`PR #${item.pullRequest}`] : []),
  ].join(" · ");
}

/** The `factory watch` screen: the status headline and in-flight detail, then each Work Item's lines. */
export function renderWatch(
  headline: string[],
  items: ItemActivity[],
  now: number,
  staleMs: number,
): string[] {
  const lines = [...headline];
  for (const item of items) {
    lines.push("", itemHeadline(item));
    const activity = activityLine(item.activity, now, staleMs);
    if (activity) lines.push(`  ${activity}`);
    const changes = changesLine(item.changes);
    if (changes) lines.push(`  files changed ${changes}`);
    const recent = recentLine(item.activity);
    if (recent) lines.push(`  recent: ${recent}`);
  }
  return lines;
}

/** A Claude worker's progress stream as readable lines. */
export function renderWorkerProgress(
  repository: string,
  attempt: string,
): string[] {
  const path = workerProgressPath(repository, attempt);
  if (!existsSync(path)) return [];
  const lines: string[] = [];
  for (const event of privateRecords(path)) {
    const at =
      typeof event.at === "string" ? displayClock(event.at) : "--:--:--";
    if (Array.isArray(event.tools))
      lines.push(
        `${at} ${(event.tools as { tool?: unknown; target?: unknown }[])
          .map((tool) =>
            typeof tool.target === "string"
              ? `${tool.tool} ${tool.target}`
              : String(tool.tool),
          )
          .join(" · ")}`,
      );
    else if (
      event.operation === "system" &&
      event.subtype === "compact_boundary"
    )
      lines.push(`${at} context compacted`);
    else if (event.operation === "system" && event.subtype === "init")
      lines.push(`${at} session started`);
    else if (
      event.operation === "result" &&
      event.subtype === "error_max_turns"
    )
      lines.push(
        `${at} reached the turn limit${typeof event.turns === "number" ? ` after ${event.turns} turns` : ""}`,
      );
    else if (event.operation === "result")
      lines.push(
        `${at} finished${event.success === false ? " (unsuccessful)" : ""}${typeof event.turns === "number" ? ` after ${event.turns} turns` : ""}`,
      );
    else if (event.operation === "rate_limit_event")
      lines.push(`${at} rate limit notice`);
    else if (event.operation === "validation") {
      const run = event.validation as Record<string, unknown> | undefined;
      if (typeof run?.passed === "boolean")
        lines.push(
          `${at} validation ${run.passed ? "passed" : "failed"} (${count(run.ran)}/${count(run.commands)} commands ran, ${count(run.failed)} failed${run.handoffPassed === false ? ", handoff rejected" : ""})`,
        );
    }
  }
  return lines;
}

/** Whether an attempt's progress stream belongs to a Claude worker. */
export function claudeWorker(repository: string, attempt: string): boolean {
  try {
    return readWorkerActivity(repository, attempt, 0)?.provider === "claude";
  } catch {
    return false;
  }
}
