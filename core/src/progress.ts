import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { redactDeep } from "./display.js";
import { type LogEvent, logFiles, readNew } from "./log.js";
import { code, prose } from "./markdown.js";
import { COMMENT_LIMIT, decisions } from "./planning/steps.js";
import { answerForm, type ObjectiveState } from "./state.js";
import type { ObjectiveView } from "./status.js";

/**
 * The live status comment: one per Objective run, on its issue, created
 * once and then edited in place (found by its marker). Its body is the
 * `factory status` model (status.ts statusOf), redacted, plus what the run
 * log adds: model calls so far and each running Work Item's latest
 * `worker-activity` event. github-sync.ts writes it in the background;
 * nothing here can stop a step.
 */

/** At most one edit per Objective this often. */
export const STATUS_EVERY_MS = 60_000;
/**
 * While a step runs, an unchanged comment is still edited this often, so
 * its "N min ago" ages stay true (a stalled worker shows as one).
 */
export const STATUS_REFRESH_MS = 10 * 60_000;

/** What the comment shows, beyond the status model. */
export interface ProgressInput {
  view: Omit<ObjectiveView, "plan">;
  /** Each Work Item's latest `worker-activity` event this run. */
  activity: Record<string, LogEvent>;
  /** Model calls logged this run: planner-seam (planning, review, discovery, Dream) and worker, and the tokens they reported. */
  calls: { planner: number; worker: number; tokens: number };
  /** Answers taken: planning decisions and step answers, oldest first. */
  decisions: {
    question: string;
    answer: string;
    text?: string;
    by: string;
    at: string;
  }[];
  /** When this run was admitted. */
  startedAt?: string;
}

/**
 * What the comment includes. W3-08 adds `progress.includeQuestions`; it
 * sets `questions` here, and only here.
 */
export interface ProgressOptions {
  questions: boolean;
}

/**
 * The run log, read forward per Objective run: only new lines after the
 * first read, and files last written before the run began are skipped, so
 * the cost follows the run, not the Objective's history.
 */
export class RunTally {
  private readonly runs = new Map<
    number,
    {
      run: string;
      offsets: Map<string, number>;
      calls: { planner: number; worker: number; tokens: number };
      activity: Record<string, LogEvent>;
    }
  >();

  constructor(private readonly dir: string) {}

  read(issue: number, run: string): Pick<ProgressInput, "calls" | "activity"> {
    let tally = this.runs.get(issue);
    if (tally?.run !== run) {
      tally = {
        run,
        offsets: new Map(),
        calls: { planner: 0, worker: 0, tokens: 0 },
        activity: {},
      };
      this.runs.set(issue, tally);
    }
    const since = Date.parse(run);
    for (const file of logFiles(this.dir, issue))
      if (!tally.offsets.has(file)) {
        const stat = statSync(file, { throwIfNoEntry: false });
        if (stat && stat.mtimeMs < since) tally.offsets.set(file, stat.size);
      }
    for (const event of readNew(this.dir, issue, tally.offsets)) {
      if (event.at < run) continue;
      // One `model-usage` event per model call (CORE.md#Model usage).
      if (event.event === "model-usage") {
        if (event.role === "worker") tally.calls.worker += 1;
        else tally.calls.planner += 1;
        const total = (event.tokens as { total?: unknown } | null)?.total;
        if (typeof total === "number") tally.calls.tokens += total;
      } else if (
        event.event === "worker-activity" &&
        typeof event.item === "string"
      )
        tally.activity[event.item] = event;
    }
    return { calls: { ...tally.calls }, activity: { ...tally.activity } };
  }

  forget(issue: number): void {
    this.runs.delete(issue);
  }
}

/** The answers the run has taken: planning decisions, then step answers not among them. */
export function decisionsOf(state: ObjectiveState): ProgressInput["decisions"] {
  const taken: ProgressInput["decisions"] = [...decisions(state)];
  const seen = new Set(taken.map((d) => `${d.at}\n${d.answer}`));
  for (const answer of Object.values(state.answers))
    if (!seen.has(`${answer.at}\n${answer.answer}`))
      taken.push({
        question: answer.question ?? "",
        answer: answer.answer,
        ...(answer.text ? { text: answer.text } : {}),
        by: answer.by,
        at: answer.at,
      });
  return taken.sort((a, b) => a.at.localeCompare(b.at));
}

/** Work Items, questions and decisions the comment lists; past these, it names the rest. */
const LISTED = { items: 50, holds: 20, decisions: 20 };
/** A worker that reported within this is active; else quiet. */
const QUIET_MS = 5 * 60_000;
/** The body's limit, below the plan comment's (planning/steps.ts COMMENT_LIMIT). */
const MAX_BODY = COMMENT_LIMIT - 1_000;

/**
 * The comment body and the hash of its stable part: everything but the
 * volatile details (ages, the edit time, each worker's last report and
 * counts; a worker shows only active or quiet there). An edit is due
 * when the hash changes.
 */
export function statusComment(
  marker: string,
  input: ProgressInput,
  secrets: readonly string[],
  options: ProgressOptions,
  now: number,
): { body: string; hash: string } {
  const shown = redactDeep(input, secrets);
  const stable = render(shown, options, now, false);
  return {
    body: `${marker}\n${render(shown, options, now, true)}`,
    hash: createHash("sha256").update(stable).digest("hex"),
  };
}

function render(
  input: ProgressInput,
  options: ProgressOptions,
  now: number,
  full: boolean,
): string {
  const { view } = input;
  const more = (left: number, what: string) =>
    left > 0
      ? [
          `- +${left} more ${what}; ${code(`factory status ${view.issue}`)} shows them all.`,
        ]
      : [];
  const when = (iso: string) =>
    full ? `${code(iso)} (${ago(iso, now)})` : code(iso);
  const lines = [
    "### Factory status",
    "",
    `**Phase:** ${prose(view.phase)}${view.mode !== "running" ? ` (${view.mode})` : ""}`,
    `**Next:** ${text(view.nextAction.reason)}${view.nextAction.command ? ` ${code(view.nextAction.command)}` : ""}`,
  ];
  if (view.items.length)
    lines.push(
      "",
      "| Work Item | Kind | Phase | PR | Repairs | Question |",
      "| --- | --- | --- | --- | --- | --- |",
      ...view.items
        .slice(0, LISTED.items)
        .map(
          (item) =>
            `| ${cell(code(item.id))} | ${item.kind} | ${cell(prose(item.phase))} | ${item.pr === null ? "-" : `#${item.pr}`} | ${item.repairs} | ${item.hold ? cell(code(item.hold)) : "-"} |`,
        ),
      ...(view.items.length > LISTED.items
        ? ["", ...more(view.items.length - LISTED.items, "Work Items")]
        : []),
    );
  const running = view.items.filter(
    (item) => input.activity[item.id] && item.phase.endsWith("(running)"),
  );
  if (running.length) {
    lines.push("", "**Workers**");
    for (const item of running.slice(0, LISTED.items)) {
      const event = input.activity[item.id]!;
      const quiet = now - Date.parse(event.at) >= QUIET_MS;
      const state = quiet ? "quiet for 5 min or more" : "active";
      if (!full) {
        lines.push(`- ${code(item.id)}: ${state}`);
        continue;
      }
      const counts = (event.counts ?? {}) as Record<string, number>;
      const tools = Array.isArray(event.tools) ? event.tools.join(", ") : "";
      lines.push(
        `- ${code(item.id)}: ${state}; last reported ${when(event.at)}; since its report before: turns ${counts.turns ?? 0}, edits ${counts.edits ?? 0}, commands ${counts.commands ?? 0}${tools ? `; tools ${text(tools)}` : ""}${typeof event.command === "string" ? `; ran ${code(event.command)}` : ""}`,
      );
    }
  }
  for (const wait of view.waiting)
    lines.push(
      "",
      wait.gate
        ? `**Waiting on** ${text(wait.gate)} since ${when(wait.since)}.`
        : `**Waiting:** ${code(wait.step)} retries at ${code(wait.nextAt)}, since ${when(wait.since)}.`,
    );
  if (view.holds.length && options.questions) {
    lines.push("", "**Open questions**");
    for (const hold of view.holds.slice(0, LISTED.holds))
      lines.push(
        `- ${code(hold.id)}${hold.item ? ` (Work Item ${code(hold.item)})` : ""}, asked ${when(hold.askedAt)}: ${text(hold.question)}`,
        ...hold.options.map(
          (option) =>
            `  - ${code(`/factory ${answerForm(option, `--question ${hold.id}`)}`)}${option.recommended ? " (recommended)" : ""}: ${text(option.consequence)}`,
        ),
      );
    lines.push(...more(view.holds.length - LISTED.holds, "questions"));
  } else if (view.holds.length)
    lines.push(
      "",
      `**Open questions:** ${view.holds.length}; ${code(`factory status ${view.issue}`)} shows them.`,
    );
  if (input.decisions.length) {
    const newest = input.decisions.slice(-LISTED.decisions);
    lines.push(
      "",
      "**Decisions taken**",
      ...more(input.decisions.length - newest.length, "earlier decisions"),
    );
    for (const decision of newest)
      lines.push(
        `- ${decision.question ? `${text(decision.question)} ` : ""}→ ${code(decision.answer)}${decision.text ? `: ${text(decision.text)}` : ""}, by ${prose(decision.by)} at ${when(decision.at)}`,
      );
  }
  const calls = input.calls.planner + input.calls.worker;
  const details = [
    "",
    "<details><summary>Run details</summary>",
    "",
    ...(input.startedAt ? [`- Admitted: ${when(input.startedAt)}`] : []),
    ...(view.frozen
      ? [
          `- Provider: ${prose(view.frozen.provider)} (selected by ${view.frozen.selectedBy})`,
          `- Frozen configuration: ${code(view.frozen.digest)}`,
        ]
      : []),
    `- Model calls so far: ${calls ? `${calls} (planner ${input.calls.planner}, worker ${input.calls.worker})${input.calls.tokens ? `, ${input.calls.tokens} tokens reported` : ""}` : "none logged"}`,
    ...(view.endedAt ? [`- Ended: ${when(view.endedAt)}`] : []),
    "",
    "</details>",
    ...(full
      ? [
          "",
          `<sub>Updated ${code(new Date(now).toISOString())}. Factory edits this comment in place; it posts a new comment only when it needs you.</sub>`,
        ]
      : []),
  ];
  // Whole lines up to the limit, then where the rest is, then the details.
  const room = MAX_BODY - details.join("\n").length - 200;
  let size = 0;
  const kept: string[] = [];
  for (const line of lines) {
    size += line.length + 1;
    if (size > room) {
      kept.push(
        "",
        `The rest is cut to fit a comment; ${code(`factory status ${view.issue}`)} shows it all.`,
      );
      break;
    }
    kept.push(line);
  }
  return [...kept, ...details].join("\n");
}

/** "N min ago", by the edit's clock. */
function ago(iso: string, now: number): string {
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms)) return "unknown";
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "under a minute ago";
  if (minutes < 120) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.floor(hours / 24)} d ago`;
}

/** Untrusted text as prose on one line, cut to 500 characters. */
function text(value: string): string {
  const line = value.replace(/\s+/g, " ").trim();
  return prose(line.length > 500 ? `${line.slice(0, 499)}…` : line);
}

/** A table cell: no column breaks. */
function cell(value: string): string {
  return value.replace(/\|/g, "\\|");
}
