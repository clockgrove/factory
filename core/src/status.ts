import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  implementationRepairs,
  perPath,
  resultRereviews,
  type Usage,
} from "./allowances.js";
import type { CapacityRecommendation } from "./capacity.js";
import { displayTime, duration, eventLine, redactDeep } from "./display.js";
import { type CapacityUse, DEADLINE, hold as question } from "./engine.js";
import { type LogEvent, readLog } from "./log.js";
import type { Paths } from "./paths.js";
import { currentPlan } from "./planning/plan.js";
import { planningRevisions } from "./planning/steps.js";
import type { ItemKind, Plan } from "./planning/types.js";
import { RESET, type ResetRecord } from "./reset.js";
import {
  answerForm,
  type Frozen,
  findState,
  type Hold,
  type Loaded,
  listAllObjectives,
  loadQueueControl,
  type ObjectiveState,
  type ObjectiveStatus,
  type QueueControl,
  TERMINAL,
} from "./state.js";
import { mergeOf } from "./work/merged.js";
import { objectiveWorkflow } from "./workflow.js";

/** The list view hides Objectives that finished longer ago than this. */
const RECENT_MS = 24 * 60 * 60 * 1000;

/** One Work Item of the current plan, as the status table shows it. */
export interface ItemRow {
  id: string;
  kind: ItemKind;
  /**
   * Its step now: `<phase> (running|waiting|held)`, else the last phase
   * done (`validated`, `merged`), else `pending`.
   */
  phase: string;
  pr: number | null;
  /** Repairs used across its repair paths. */
  repairs: number;
  /** The id of the open question that stops it. */
  hold: string | null;
}

export interface ObjectiveView {
  issue: number;
  status: ObjectiveStatus | "unreadable";
  /** The headline: the stage it is in, and whether a question stops it. */
  phase: string;
  /** The operator's control of this Objective; `running` when none. */
  mode: "running" | "paused" | "draining";
  /** Open questions, oldest first. */
  holds: Hold[];
  /** The configuration frozen at admission (or by a `switch` or `adopt` answer): its provider, what chose it, and its digest. */
  frozen?: Pick<Frozen, "provider" | "selectedBy" | "digest">;
  /** The current plan's Work Items. */
  items: ItemRow[];
  /** The current plan, in full. */
  plan?: Plan;
  waiting: {
    step: string;
    nextAt: string;
    lastError: string;
    since: string;
    /** A person outside Factory the step waits on, such as an environment approval. */
    gate?: string;
  }[];
  /** Waiting for a slot, or for an earlier Objective that owns overlapping paths. */
  waitsOn: { slot: true } | { paths: number } | null;
  /** Steps started and not finished. */
  running: string[];
  /** Work Items whose validation failed once and passed on its one rerun. */
  flakyRerun: { item: string; command: string }[];
  /**
   * Work Items whose current result is a rereview with the operator's
   * `--review-artifacts`: the configured selectors (numbers from 1; empty
   * for none) it captures instead of all.
   */
  rereviews: { item: string; reviewArtifacts: number[]; by: string }[];
  /**
   * Each autonomy allowance, used and allowed with the operator's grants:
   * across the Objective, and repairs per repair path (target step).
   */
  allowances?: {
    planningRevisions: Usage;
    implementationRepairs: Usage;
    resultRereviews: Usage;
    perPath: Record<string, Usage>;
  };
  /** A reset rebuilding the state from GitHub. */
  reset?: { requestedAt: string; hadState: boolean };
  /**
   * Its absolute deadline, saved at admission, and the seconds left (0
   * once it has passed); shown until it ends. At it, Factory cancels it.
   */
  deadline?: { at: string; leftSeconds: number };
  /** When it reached done or cancelled. */
  endedAt?: string;
  /** Who cancelled it: `deadline` when its deadline did. */
  endedBy?: string;
  /** What happens next, and the command that moves it, if one does. */
  nextAction: { command: string | null; reason: string };
  /** The latest run log event. */
  lastEvent: LogEvent | null;
  error?: string;
}

/** The running service's record, from `service.json`. */
export interface ServiceView {
  crashLoop?: { crashes: number; resumeAt: string };
  problem?: string;
  /** The host limiter's slots and memory in use (engine.ts HostLimiter). */
  capacity?: CapacityUse;
  waits: Record<string, { slot: true } | { paths: number }>;
}

/** The whole status: `--json` prints it as it is, the text renders it. */
export interface StatusView {
  service: "running" | "stopped";
  crashLoop?: ServiceView["crashLoop"];
  problem?: string;
  capacity?: CapacityUse;
  queue: QueueControl;
  objectives: ObjectiveView[];
}

/**
 * The status of every Objective, or of `only`, redacted of `secrets`
 * before anything formats it, so no escaped form of a secret slips past.
 */
export function readStatus(
  paths: Paths,
  options: { only?: number; live: boolean; secrets: readonly string[] },
): StatusView {
  const { only, live } = options;
  const service = live ? serviceRecord(paths) : { waits: {} };
  const queue = loadQueueControl(paths.root);
  const objectives: ObjectiveView[] = [];
  for (const issue of listAllObjectives(paths.objectives)) {
    if (only !== undefined && issue !== only) continue;
    let loaded: Loaded | null;
    try {
      loaded = findState(paths.objectives, issue);
    } catch (error) {
      process.stderr.write(`#${issue}: can't read its state now: ${error}\n`);
      continue;
    }
    if (!loaded) continue;
    objectives.push(
      statusOf(loaded, {
        issue,
        live,
        queue,
        waitsOn: service.waits[issue] ?? null,
        lastEvent: readLog(paths.logs, issue, 1).events[0] ?? null,
      }),
    );
  }
  const { waits: _waits, ...record } = service;
  return redactDeep(
    { service: live ? "running" : "stopped", ...record, queue, objectives },
    options.secrets,
  );
}

/** One Objective's status, from its loaded state. */
export function statusOf(
  loaded: Loaded,
  context: {
    issue: number;
    live: boolean;
    queue: QueueControl;
    waitsOn: ObjectiveView["waitsOn"];
    lastEvent: LogEvent | null;
  },
): ObjectiveView {
  const { issue, lastEvent } = context;
  if (loaded.kind === "unreadable")
    return {
      issue,
      status: "unreadable",
      phase: "unreadable",
      mode: "running",
      holds: [
        {
          id: "unreadable",
          step: "state",
          question: `Factory can't read this Objective's state (${loaded.error}).`,
          options: question("", [
            {
              answer: RESET,
              family: "reset",
              consequence:
                "Rebuilds the state from the plan comment and PRs on GitHub.",
            },
            "cancel",
          ]).options,
          cause: "question",
          askedAt: "",
        },
      ],
      items: [],
      waiting: [],
      waitsOn: null,
      running: [],
      flakyRerun: [],
      rereviews: [],
      nextAction: {
        command: `factory reset ${issue}`,
        reason:
          "Its state can't be read: reset rebuilds it from GitHub (or cancel).",
      },
      lastEvent,
      error: loaded.error,
    };
  const { state } = loaded;
  const reset = state.kept?.[RESET] as ResetRecord | undefined;
  const plan = currentPlan(state);
  const view: ObjectiveView = {
    issue,
    status: state.status,
    phase: phaseOf(state),
    mode: state.control?.mode ?? "running",
    holds: state.holds,
    ...(state.frozen
      ? {
          frozen: {
            provider: state.frozen.provider,
            selectedBy: state.frozen.selectedBy,
            digest: state.frozen.digest,
          },
        }
      : {}),
    items: plan ? itemRows(state, plan) : [],
    ...(plan ? { plan } : {}),
    waiting: Object.entries(state.retries).map(([step, retry]) => ({
      step,
      nextAt: retry.nextAt,
      lastError: retry.lastError,
      since: retry.since,
      ...(retry.wait?.kind === "gate" ? { gate: retry.wait.gate } : {}),
    })),
    waitsOn: context.waitsOn,
    running: Object.keys(state.attempts),
    flakyRerun: flakyReruns(state),
    rereviews: rereviews(state),
    allowances: {
      planningRevisions: planningRevisions(state),
      implementationRepairs: implementationRepairs(state),
      resultRereviews: resultRereviews(state),
      perPath: perPath(state),
    },
    ...(reset && !TERMINAL.includes(state.status)
      ? {
          reset: { requestedAt: reset.requestedAt, hadState: reset.hadState },
        }
      : {}),
    ...(state.deadline && !TERMINAL.includes(state.status)
      ? {
          deadline: {
            at: state.deadline,
            leftSeconds: Math.max(
              0,
              Math.floor((Date.parse(state.deadline) - Date.now()) / 1000),
            ),
          },
        }
      : {}),
    ...(state.ended ? { endedAt: state.ended.at } : {}),
    ...(state.ended?.by ? { endedBy: state.ended.by } : {}),
    nextAction: { command: null, reason: "" },
    lastEvent,
  };
  view.nextAction = nextAction(view, context.queue, context.live);
  return view;
}

/** The stage the Objective is in, and whether a question stops it. */
function phaseOf(state: ObjectiveState): string {
  if (TERMINAL.includes(state.status) || state.status === "resetting")
    return state.status;
  const stage = objectiveWorkflow().status(state);
  const open = state.holds.length;
  return open
    ? `${stage}, ${open === 1 ? "a question" : `${open} questions`} open`
    : stage;
}

/** What each phase reads as once it is done. */
const DONE_AS: Record<string, string> = {
  work: "worked",
  select: "selected",
  validate: "validated",
  review: "reviewed",
  publish: "published",
  ci: "checked",
  merge: "merged",
};

/** The Work Item table: each item's step, PR, repairs and question. */
function itemRows(state: ObjectiveState, plan: Plan): ItemRow[] {
  const phase = (key: string) => key.split(":")[2] ?? key;
  return plan.items.map((item) => {
    const own = (key: string) => key.startsWith(`item:${item.id}:`);
    const hold = state.holds.find((open) => open.item === item.id);
    const running = Object.keys(state.attempts).find(own);
    const waiting = Object.keys(state.retries).find(own);
    const done = Object.keys(state.done).filter(own);
    const published = state.done[`item:${item.id}:publish`] as
      | { pr?: number }
      | undefined;
    return {
      id: item.id,
      kind: item.kind ?? "work",
      phase: mergeOf(state, item.id)
        ? (
            state.done[`item:${item.id}:merge`] as
              | { settled?: string }
              | undefined
          )?.settled === "skipped"
          ? "skipped"
          : "merged"
        : running
          ? `${phase(running)} (running)`
          : hold
            ? `${phase(hold.step)} (held)`
            : waiting
              ? `${phase(waiting)} (waiting)`
              : done.length
                ? (DONE_AS[phase(done.at(-1)!)] ?? phase(done.at(-1)!))
                : "pending",
      pr: published?.pr ?? null,
      repairs: Object.entries(state.repairs ?? {})
        .filter(([key]) => own(key))
        .reduce((sum, [, repair]) => sum + repair.count, 0),
      hold: hold?.id ?? null,
    };
  });
}

/** Validation reruns that passed: the rerun's tree is the validated tree. */
function flakyReruns(state: ObjectiveState): ObjectiveView["flakyRerun"] {
  const reruns: ObjectiveView["flakyRerun"] = [];
  for (const [key, value] of Object.entries(state.kept ?? {})) {
    const item = /^item:(.+):flaky$/.exec(key)?.[1];
    const rerun = value as { tree?: string; command?: string } | null;
    const validated = state.done[`item:${item}:validate`] as
      | { tree?: string }
      | undefined;
    if (item && rerun?.command && rerun.tree && validated?.tree === rerun.tree)
      reruns.push({ item, command: rerun.command });
  }
  return reruns;
}

/** The rereviews whose review artifacts the operator chose (work/facts.ts `rereview`). */
function rereviews(state: ObjectiveState): ObjectiveView["rereviews"] {
  const chosen: ObjectiveView["rereviews"] = [];
  for (const [key, value] of Object.entries(state.kept ?? {})) {
    const item = /^item:(.+):rereview$/.exec(key)?.[1];
    const rereview = value as { reviewArtifacts?: number[]; by?: string };
    if (item && rereview?.reviewArtifacts)
      chosen.push({
        item,
        reviewArtifacts: rereview.reviewArtifacts,
        by: rereview.by ?? "",
      });
  }
  return chosen;
}

/** The one thing that moves the Objective on, or what it waits for. */
function nextAction(
  row: ObjectiveView,
  queue: QueueControl,
  live: boolean,
): ObjectiveView["nextAction"] {
  const issue = row.issue;
  // The question that stops the most: the Objective's, else the oldest.
  const hold =
    row.holds.find((open) => open.item === undefined) ?? row.holds[0];
  const recommended = hold?.options.find((option) => option.recommended);
  if (hold && recommended)
    return {
      command: `factory answer ${issue} ${recommended.answer}${recommended.arg !== undefined ? ` ${recommended.arg}` : ""} --question ${hold.id}${recommended.needsText ? ' --text "<text>"' : ""}`,
      reason: `The recommended answer to ${hold.item ? `Work Item ${hold.item}'s` : "the"} question: ${recommended.consequence} Others: ${hold.options
        .filter((option) => option !== recommended)
        .map((option) => answerForm(option))
        .join(", ")}.`,
    };
  if (TERMINAL.includes(row.status as ObjectiveStatus)) {
    const how = `It has ${row.status}${row.endedBy === DEADLINE ? " at its deadline" : ""}`;
    return row.running.length || row.waiting.length
      ? { command: null, reason: `${how}; Factory is cleaning up.` }
      : { command: null, reason: `${how}.` };
  }
  if (row.reset && !live)
    return {
      command: "factory serve",
      reason:
        "The reset waits for the service (start it with its systemd unit).",
    };
  if (row.reset)
    return {
      command: null,
      reason: "Factory is rebuilding its state from GitHub.",
    };
  if (row.mode !== "running")
    return {
      command: `factory resume ${issue}`,
      reason: `The operator ${row.mode === "paused" ? "paused it: no step starts" : "drained it: no new Work Item starts"} until resume.`,
    };
  if (queue.mode === "paused")
    return {
      command: "factory queue resume",
      reason: "The queue is paused: no step starts until resume.",
    };
  if (!live)
    return {
      command: "factory serve",
      reason: "The service isn't running (start it with its systemd unit).",
    };
  const gate = row.waiting.find((wait) => wait.gate);
  if (gate)
    return {
      command: null,
      reason: `Waiting on ${gate.gate}; Factory carries on by itself once that is done.`,
    };
  if (row.running.length)
    return { command: null, reason: `Running ${row.running.join(", ")}.` };
  if (row.waiting.length) {
    const first = [...row.waiting].sort((a, b) =>
      a.nextAt.localeCompare(b.nextAt),
    )[0]!;
    return {
      command: `factory retry ${issue}`,
      reason: `${first.step} retries by itself at ${displayTime(first.nextAt)}; retry runs it now.`,
    };
  }
  if (row.waitsOn)
    return {
      command: null,
      reason:
        "slot" in row.waitsOn
          ? "Waiting on a free slot."
          : `Waiting on Objective #${row.waitsOn.paths}, which owns overlapping paths.`,
    };
  return {
    command: null,
    reason: `The next ${row.status} step starts shortly.`,
  };
}

/**
 * The running service's record, from `service.json`: its crash loop (the
 * deaths in a row before this start, and when it resumes interrupted
 * steps; shown until the run has lived 10 min past that time), a problem
 * that pauses its GitHub effects, and the Objectives waiting for a slot or
 * on another's paths.
 */
function serviceRecord(paths: Paths): ServiceView {
  try {
    const record = JSON.parse(
      readFileSync(join(paths.root, "service.json"), "utf8"),
    ) as {
      starts?: string[];
      resumeAt?: string;
      problem?: string;
      capacity?: CapacityUse;
      waits?: ServiceView["waits"];
    };
    return {
      ...(record.resumeAt &&
      Date.now() <= Date.parse(record.resumeAt) + 10 * 60 * 1000
        ? {
            crashLoop: {
              crashes: (record.starts?.length ?? 1) - 1,
              resumeAt: record.resumeAt,
            },
          }
        : {}),
      ...(typeof record.problem === "string"
        ? { problem: record.problem }
        : {}),
      ...(record.capacity ? { capacity: record.capacity } : {}),
      waits: record.waits ?? {},
    };
  } catch {
    return { waits: {} };
  }
}

/**
 * The text status. The list view (`list`: no issue named) hides
 * Objectives that finished more than 24 h ago unless `all`.
 */
export function statusText(
  view: StatusView,
  options: { list: boolean; all: boolean },
): string {
  const lines = [`Service: ${view.service}`];
  if (view.problem)
    lines.push(`  Problem: ${view.problem}. GitHub effects are paused.`);
  const loop = view.crashLoop;
  if (loop)
    lines.push(
      `  Crash loop: the service restarted after ${loop.crashes} deaths in a row; interrupted steps ${Date.parse(loop.resumeAt) > Date.now() ? "resume" : "resumed"} at ${displayTime(loop.resumeAt)}.`,
    );
  const { queue } = view;
  if (queue.mode !== "running")
    lines.push(
      `Queue: ${queue.mode}${queue.at ? ` since ${displayTime(queue.at)}` : ""}${queue.by ? ` (by ${queue.by})` : ""}; factory queue resume undoes it`,
    );
  const old = (row: ObjectiveView) =>
    row.endedAt !== undefined &&
    Date.now() - Date.parse(row.endedAt) > RECENT_MS;
  const shown =
    options.list && !options.all
      ? view.objectives.filter((row) => !old(row))
      : view.objectives;
  if (view.objectives.length === 0) lines.push("No Objectives.");
  for (const row of shown) lines.push(...objectiveText(row));
  const hidden = view.objectives.length - shown.length;
  if (hidden)
    lines.push(
      `${hidden} Objective${hidden === 1 ? "" : "s"} finished more than 24 h ago; factory status --all shows ${hidden === 1 ? "it" : "them"}.`,
    );
  return `${lines.join("\n")}\n`;
}

function objectiveText(row: ObjectiveView): string[] {
  const lines = [
    `#${row.issue}: ${row.phase}${row.mode !== "running" ? ` (${row.mode})` : ""}`,
    row.nextAction.command
      ? `  Next: ${row.nextAction.command}\n    ${row.nextAction.reason}`
      : `  Next: ${row.nextAction.reason}`,
  ];
  if (row.deadline)
    lines.push(
      `  Deadline: ${displayTime(row.deadline.at)} (${row.deadline.leftSeconds ? `${duration(row.deadline.leftSeconds * 1000)} left` : "passed: Factory cancels it"})`,
    );
  if (row.items.length) lines.push("  Work Items:", ...itemTable(row.items));
  if (row.frozen)
    lines.push(
      `  Provider: ${row.frozen.provider} (selectedBy: ${row.frozen.selectedBy}); configuration ${row.frozen.digest.slice(0, 12)}`,
    );
  if (row.allowances) {
    const { perPath: paths, ...objective } = row.allowances;
    const used = ({ used, allowed }: Usage) => `${used}/${allowed}`;
    const each = Object.entries(paths).map(
      ([path, usage]) => `${path} ${used(usage)}`,
    );
    lines.push(
      `  Allowances: planning revisions ${used(objective.planningRevisions)}, implementation repairs ${used(objective.implementationRepairs)}, result rereviews ${used(objective.resultRereviews)}${each.length ? `; repairs per path: ${each.join(", ")}` : ""}`,
    );
  }
  for (const hold of row.holds)
    lines.push(
      `  Question ${hold.id}${hold.item ? ` (Work Item ${hold.item})` : ""}: ${hold.question}`,
      ...hold.options.map(
        (option) =>
          `    ${answerForm(option)}${option.recommended ? " (recommended)" : ""}: ${option.consequence}`,
      ),
      `  Answer with: factory answer ${row.issue} <answer> --question ${hold.id}`,
    );
  if (row.reset)
    lines.push(
      `  Resetting since ${displayTime(row.reset.requestedAt)}: rebuilding the state from GitHub`,
    );
  for (const step of row.running) lines.push(`  Running: ${step}`);
  for (const wait of row.waiting)
    lines.push(
      wait.gate
        ? `  Waiting on ${wait.gate} (${wait.step}, since ${displayTime(wait.since)})`
        : `  Waiting: ${wait.step} retries at ${displayTime(wait.nextAt)} (${wait.lastError})`,
    );
  if (row.waitsOn)
    lines.push(
      "slot" in row.waitsOn
        ? "  Waiting on a free slot (queue.maxActiveObjectives)"
        : `  Waiting on Objective #${row.waitsOn.paths} (overlapping owned paths)`,
    );
  for (const flaky of row.flakyRerun)
    lines.push(
      `  Possibly flaky: ${flaky.item}: \`${flaky.command}\` failed once; its rerun passed`,
    );
  for (const rereview of row.rereviews)
    lines.push(
      `  Rereview: ${rereview.item} captures ${rereview.reviewArtifacts.length ? `review artifacts ${rereview.reviewArtifacts.join(", ")} of the configured selectors` : "no review artifacts"} (--review-artifacts, by ${rereview.by})`,
    );
  if (row.lastEvent) lines.push(`  Last: ${eventLine(row.lastEvent)}`);
  return lines;
}

/** The Work Item table, its columns padded to the widest cell. */
function itemTable(items: ItemRow[]): string[] {
  const rows = [
    ["ID", "KIND", "PHASE", "PR", "REPAIRS", "HOLD"],
    ...items.map((item) => [
      item.id,
      item.kind,
      item.phase,
      item.pr === null ? "-" : `#${item.pr}`,
      String(item.repairs),
      item.hold ?? "-",
    ]),
  ];
  const widths = rows[0]!.map((_, column) =>
    Math.max(...rows.map((row) => row[column]!.length)),
  );
  return rows.map(
    (row) =>
      `    ${row
        .map((cell, column) => cell.padEnd(widths[column]!))
        .join("  ")
        .trimEnd()}`,
  );
}

/**
 * `status --capacity`: the host limiter's slots and memory in use, and how
 * the configured capacity fits the host (capacity.ts).
 */
export function capacityText(
  live: boolean,
  use: CapacityUse | undefined,
  recommendation: CapacityRecommendation | undefined,
): string {
  let line = live
    ? "In use: not recorded yet; a service from before this release records it once restarted."
    : "In use: the service isn't running.";
  if (use) {
    const { caps, used, reserveMiB } = use;
    line = `In use: ${used.worker}/${caps.worker} workers, ${used.cpu}/${caps.cpu} validations, ${used.planner}/${caps.planner} planner calls, ${used.github}/${caps.github} queue checks; ${use.reservedMiB}/${use.budgetMiB} MiB reserved (worker ${reserveMiB.worker}, validation ${reserveMiB.cpu}, planner ${reserveMiB.planner} MiB each).`;
  }
  return `${line}\n${recommendation ? recommendationText(recommendation) : ""}`;
}

/** How the configured capacity fits the host; setup prints it too. */
export function recommendationText({
  host,
  defaults,
  fullLoadMiB,
  advice,
}: CapacityRecommendation): string {
  return `${[
    `Host: ${host.cpus} CPUs, ${host.memoryMiB} MiB; its defaults are ${defaults.workers} workers, ${defaults.validations} validations and ${defaults.memoryMiB} MiB to reserve. Every worker and validation at once reserves ${fullLoadMiB} MiB.`,
    ...(advice.length
      ? advice.map((line) => `  Recommended: ${line}`)
      : ["  The configured capacity fits this host."]),
  ].join("\n")}\n`;
}
