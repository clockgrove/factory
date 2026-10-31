/**
 * What this installation's past Work Items cost (#2286): a short summary
 * the planner and plan review are given, so the size guidance and its cost
 * check ("could one worker get this green in a handful of validation
 * cycles?") rest on measured items, not judgment alone. Code supplies the
 * facts: each completed item's acceptance entries and owned paths from its
 * Objective's plan, and its time, tokens, validation runs and repairs from
 * the run log (item-telemetry.ts). The model decides what they mean.
 *
 * Bounded (AGENTS.md rule 6): only the newest {@link OBJECTIVES} done
 * Objectives are read, each once per process, and the text is a median, two
 * buckets and at most {@link LISTED} items, whatever the history holds.
 * Names, titles and paths are never included, only counts.
 */
import { statSync } from "node:fs";
import { duration } from "../display.js";
import {
  ItemTelemetries,
  type ItemTelemetry,
  shortCount,
  shortTokens,
  wallMs,
} from "../item-telemetry.js";
import { logFiles, streamFile } from "../log.js";
import { findState, listAllObjectives, type ObjectiveState } from "../state.js";
import { acceptedPlan } from "./plan.js";
import { WORK_ITEM_ENTRY_SIGNAL } from "./rubric.js";

/** Done Objectives read, newest issue number first. */
const OBJECTIVES = 10;
/** States opened at most, so a history of unfinished Objectives costs no more. */
const OPENED = 30;
/** Items below this many make no summary: a median of a few is noise. */
const MIN_ITEMS = 5;
/** The longest items listed. */
const LISTED = 5;
/** An item at least this many times the median wall time is listed. */
const FAR_LONGER = 2;

/** One completed Work Item: its plan shape and its measured cost. */
export interface PastItem {
  acceptance: number;
  paths: number;
  telemetry: ItemTelemetry;
}

/** A done Objective's items are fixed, so its rows are read once per process (its run id is in the key). */
const rows = new Map<string, PastItem[]>();

/** The completed work items of the newest done Objectives in the state directory `objectives`, measured from the run logs in `logs`. */
export function pastItems(objectives: string, logs: string): PastItem[] {
  const found: PastItem[] = [];
  let done = 0;
  const issues = listAllObjectives(objectives).reverse().slice(0, OPENED);
  for (const issue of issues) {
    if (done >= OBJECTIVES) break;
    const loaded = findState(objectives, issue);
    if (loaded?.kind !== "ok" || loaded.state.status !== "done") continue;
    done += 1;
    const { state } = loaded;
    const run = state.startedAt ?? "";
    const key = `${logs}\0${issue}\0${run}`;
    let items = rows.get(key);
    if (!items) {
      items = itemsOf(state, logs, run);
      // Few Objectives are ever read at once; a long-running service forgets the rest.
      if (rows.size >= OBJECTIVES * 4) rows.clear();
      rows.set(key, items);
    }
    found.push(...items);
  }
  return found;
}

function itemsOf(state: ObjectiveState, logs: string, run: string): PastItem[] {
  const plan = acceptedPlan(state);
  if (!plan) return [];
  const telemetry = new ItemTelemetries();
  // Only this run's events and the files written since, as the PR body reads
  // them (progress.ts RunTally).
  const since = Date.parse(run);
  for (const file of logFiles(logs, state.issue)) {
    const stat = statSync(file, { throwIfNoEntry: false });
    if (stat && !(stat.mtimeMs < since))
      streamFile(file, 0, (event) => {
        if (event.at >= run) telemetry.add(event);
      });
  }
  const measured = telemetry.liveItems();
  return plan.items.flatMap((item) => {
    const cost = measured[item.id];
    // A work item whose result review accepted it: a QA item, or one that
    // never got that far, says nothing about the cost of a result.
    return (item.kind ?? "work") === "work" && cost?.reviews.accepted
      ? [
          {
            acceptance: item.acceptance.length,
            paths: item.ownedPaths.length,
            telemetry: cost,
          },
        ]
      : [];
  });
}

/** The middle of `values`, rounded to a whole number: counts are shown whole. */
function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return Math.round(
    sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2,
  );
}

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;
const entries = (n: number) =>
  plural(n, "acceptance entry", "acceptance entries");

const runsOf = (item: ItemTelemetry) =>
  Object.values(item.validation).reduce((sum, row) => sum + row.runs, 0);

/** One item as a clause: its entries, paths, time, tokens, validation runs and repairs. */
function describe(item: PastItem): string {
  const { telemetry } = item;
  return [
    entries(item.acceptance),
    plural(item.paths, "owned path"),
    `${duration(wallMs(telemetry))} wall time`,
    `${shortTokens(telemetry)} tokens`,
    plural(runsOf(telemetry), "validation run"),
    plural(telemetry.repairs.length, "repair"),
  ].join(", ");
}

/** The median of a group: its time, validation runs and repairs. */
function group(label: string, items: readonly PastItem[]): string {
  return `${label}: ${plural(items.length, "item")}, median ${duration(
    median(items.map((item) => wallMs(item.telemetry))),
  )}, ${plural(median(items.map((item) => runsOf(item.telemetry))), "validation run")}, ${plural(
    median(items.map((item) => item.telemetry.repairs.length)),
    "repair",
  )}`;
}

/** The summary the planner and plan review are given; empty when too few items were measured. */
export function itemCostSummary(items: readonly PastItem[]): string {
  if (items.length < MIN_ITEMS) return "";
  const walls = items.map((item) => wallMs(item.telemetry));
  const typical = median(walls);
  const reported = items.filter((item) => item.telemetry.tokens.total.calls);
  const tokens = reported.length
    ? `, ${shortCount(median(reported.map((item) => item.telemetry.tokens.total.sum)))} tokens`
    : "";
  const within = items.filter(
    (item) => item.acceptance <= WORK_ITEM_ENTRY_SIGNAL,
  );
  const above = items.filter(
    (item) => item.acceptance > WORK_ITEM_ENTRY_SIGNAL,
  );
  const longest = items
    .filter((item) => wallMs(item.telemetry) >= FAR_LONGER * typical)
    .sort((a, b) => wallMs(b.telemetry) - wallMs(a.telemetry))
    .slice(0, LISTED);
  return [
    `Measured cost of ${items.length} Work Items this installation completed (in its newest done Objectives; wall time runs from an item's first step to its last event). Facts about past items, not limits or targets.`,
    `Median: ${entries(median(items.map((item) => item.acceptance)))}, ${plural(median(items.map((item) => item.paths)), "owned path")}, ${duration(typical)} wall time${tokens}, ${plural(median(items.map((item) => runsOf(item.telemetry))), "validation run")}, ${plural(median(items.map((item) => item.telemetry.repairs.length)), "repair")}.`,
    ...(within.length && above.length
      ? [
          `${group(`Up to ${WORK_ITEM_ENTRY_SIGNAL} acceptance entries`, within)}.`,
          `${group(`More than ${WORK_ITEM_ENTRY_SIGNAL}`, above)}.`,
        ]
      : []),
    ...(longest.length
      ? [
          `Items that took at least ${FAR_LONGER} times the median wall time, longest first:`,
          ...longest.map((item) => `- ${describe(item)}`),
        ]
      : []),
  ].join("\n");
}
