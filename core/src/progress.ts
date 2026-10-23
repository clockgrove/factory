import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { redactDeep } from "./display.js";
import { type LogEvent, logFiles, readNew } from "./log.js";
import { decisions } from "./planning/steps.js";
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
  /** Model calls logged this run. */
  calls: { planner: number; worker: number };
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
      calls: { planner: number; worker: number };
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
        calls: { planner: 0, worker: 0 },
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
      if (event.event === "planner-call") tally.calls.planner += 1;
      else if (event.event === "worker-call") tally.calls.worker += 1;
      else if (
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

/**
 * The comment body and the hash of its stable part (everything but the
 * ages and the edit time): an edit is due when the hash changes.
 */
export function statusComment(
  marker: string,
  input: ProgressInput,
  secrets: readonly string[],
  options: ProgressOptions,
  now: number,
): { body: string; hash: string } {
  const shown = redactDeep(input, secrets);
  const stable = render(shown, options);
  return {
    body: `${marker}\n${render(shown, options, now)}`,
    hash: createHash("sha256").update(stable).digest("hex"),
  };
}

function render(
  input: ProgressInput,
  options: ProgressOptions,
  now?: number,
): string {
  const { view } = input;
  const when = (iso: string) =>
    now === undefined ? `\`${iso}\`` : `\`${iso}\` (${ago(iso, now)})`;
  const lines = [
    "### Factory status",
    "",
    `**Phase:** ${view.phase}${view.mode !== "running" ? ` (${view.mode})` : ""}`,
    `**Next:** ${oneLine(view.nextAction.reason)}${view.nextAction.command ? ` \`${view.nextAction.command}\`` : ""}`,
  ];
  if (view.items.length)
    lines.push(
      "",
      "| Work Item | Kind | Phase | PR | Repairs | Question |",
      "| --- | --- | --- | --- | --- | --- |",
      ...view.items.map(
        (item) =>
          `| \`${cell(item.id)}\` | ${item.kind} | ${cell(item.phase)} | ${item.pr === null ? "-" : `#${item.pr}`} | ${item.repairs} | ${item.hold ? `\`${cell(item.hold)}\`` : "-"} |`,
      ),
    );
  const running = view.items.filter(
    (item) => input.activity[item.id] && item.phase.endsWith("(running)"),
  );
  if (running.length) {
    lines.push("", "**Workers**");
    for (const item of running) {
      const event = input.activity[item.id]!;
      const counts = (event.counts ?? {}) as Record<string, number>;
      const tools = Array.isArray(event.tools) ? event.tools.join(", ") : "";
      lines.push(
        `- \`${item.id}\`: last reported ${when(event.at)}; since its report before: turns ${counts.turns ?? 0}, edits ${counts.edits ?? 0}, commands ${counts.commands ?? 0}${tools ? `; tools ${oneLine(tools)}` : ""}${typeof event.command === "string" ? `; ran \`${oneLine(event.command)}\`` : ""}`,
      );
    }
  }
  for (const wait of view.waiting)
    lines.push(
      "",
      wait.gate
        ? `**Waiting on** ${oneLine(wait.gate)} since ${when(wait.since)}.`
        : `**Waiting:** \`${wait.step}\` retries at \`${wait.nextAt}\`, since ${when(wait.since)}.`,
    );
  if (view.holds.length && options.questions) {
    lines.push("", "**Open questions**");
    for (const hold of view.holds)
      lines.push(
        `- \`${hold.id}\`${hold.item ? ` (Work Item \`${hold.item}\`)` : ""}, asked ${when(hold.askedAt)}: ${oneLine(hold.question)}`,
        ...hold.options.map(
          (option) =>
            `  - \`/factory ${answerForm(option, `--question ${hold.id}`)}\`${option.recommended ? " (recommended)" : ""}: ${oneLine(option.consequence)}`,
        ),
      );
  } else if (view.holds.length)
    lines.push(
      "",
      `**Open questions:** ${view.holds.length}; \`factory status ${view.issue}\` shows them.`,
    );
  if (input.decisions.length) {
    lines.push("", "**Decisions taken**");
    for (const decision of input.decisions)
      lines.push(
        `- ${decision.question ? `${oneLine(decision.question)} ` : ""}→ \`${decision.answer}\`${decision.text ? `: ${oneLine(decision.text)}` : ""}, by ${decision.by} at ${when(decision.at)}`,
      );
  }
  const calls = input.calls.planner + input.calls.worker;
  lines.push(
    "",
    "<details><summary>Run details</summary>",
    "",
    ...(input.startedAt ? [`- Admitted: ${when(input.startedAt)}`] : []),
    ...(view.frozen
      ? [
          `- Provider: ${view.frozen.provider} (selected by ${view.frozen.selectedBy})`,
          `- Frozen configuration: \`${view.frozen.digest}\``,
        ]
      : []),
    `- Model calls so far: ${calls ? `${calls} (planner ${input.calls.planner}, worker ${input.calls.worker})` : "none logged"}`,
    ...(view.endedAt ? [`- Ended: ${when(view.endedAt)}`] : []),
    "",
    "</details>",
  );
  if (now !== undefined)
    lines.push(
      "",
      `<sub>Updated \`${new Date(now).toISOString()}\`. Factory edits this comment in place; it posts a new comment only when it needs you.</sub>`,
    );
  return lines.join("\n");
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

/** Text on one line, cut to 500 characters. */
function oneLine(value: string): string {
  const line = value.replace(/\s+/g, " ").trim();
  return line.length > 500 ? `${line.slice(0, 499)}…` : line;
}

/** A table cell: one line, no column breaks. */
function cell(value: string): string {
  return oneLine(value).replace(/\|/g, "\\|");
}
