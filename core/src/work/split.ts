import {
  hold,
  type Outcome,
  objectiveWide,
  type Step,
  type StepContext,
} from "../engine.js";
import { type IssueSummary, TransientError } from "../github.js";
import {
  ensureRoles,
  OBJECTIVE_LABEL,
  objectiveRole,
} from "../github-roles.js";
import { code, mark, markdownLines, prose } from "../markdown.js";
import { childDigest } from "../planning/facts.js";
import {
  currentPlan,
  SPLIT,
  SPLIT_CHILDREN,
  type SplitRecord,
  splitRecord,
} from "../planning/plan.js";
import type { ChildObjectiveSpec } from "../planning/types.js";
import { QueueDisplay, queueIssue } from "../queue.js";
import { findState, type ObjectiveState, runOf, sinceRun } from "../state.js";
import { type BuildDeps, objectiveEdited } from "./steps.js";

/**
 * A split delivers through child Objectives (CORE.md#Child Objectives).
 * Once the plan that splits is accepted:
 *
 * `build:split` creates one Objective issue per child, in plan order, from
 * the plan's child (its goal, outcomes as Acceptance, its Sources, and
 * every other section of the parent carried over): a sub-issue of the
 * parent with the `factory:objective` label, the parent's priority labels
 * and the Objective type. It links each child as blocked by the siblings
 * it depends on, so each child's predecessors step waits for them
 * (planning/predecessors.ts), queues every child on the Project, and
 * comments on the parent with the children.
 *
 * `build:split:children` then waits, with no question and no slot, until
 * every child is done, keeping each child's status for the parent's status
 * (`CHILD_STATES`); then it comments and closes the parent as completed,
 * which ends `done` with `ended.by: "split"`. A cancelled child holds,
 * naming it: `continue` closes the parent anyway, `retry` looks again
 * (after queuing the child again), or cancel.
 *
 * Every write is found before it is made, so a crash anywhere repeats
 * none: a child by the marker on its body's first line, written by
 * Factory's login and created in this run (from `sinceRun`), among the
 * parent's sub-issues and Factory's `factory:objective` issues; a link by
 * the issue's links; a comment by its marker. A child Factory wrote is
 * trusted as Factory's own: it needs no `approve`, as it carries only the
 * parent's approved text and the accepted plan; it runs on the parent's
 * frozen configuration (service.ts), and a ready child takes the graph
 * planned for it as its first plan round (planning/steps.ts).
 */

/** Each child's status as `build:split:children` last read it, by key: the parent's status shows it. */
export const CHILD_STATES = "split:children";

const MINUTE = 60_000;
/** The parent's sections a child replaces with its own. */
const REPLACED = ["goal", "outcome", "acceptance", "sources"];

/** The first line of a child's body: the structure planning/facts.ts childOf reads. */
export function childMarker(parent: number, key: string): string {
  return `<!-- factory:parent=${parent};child=${key} -->`;
}

/** Each child's issue and last read status, in plan order; empty unless the Objective split. */
export function childRows(
  state: ObjectiveState,
): { key: string; issue: number; status: string }[] {
  const record = splitRecord(state);
  const states = (state.kept[CHILD_STATES] ?? {}) as Record<string, string>;
  return Object.entries(record?.children ?? {}).map(([key, issue]) => ({
    key,
    issue,
    status: states[key] ?? "queued",
  }));
}

/** The steps of a split, once its plan is accepted: create the children, then wait for them. */
export function splitSteps(state: ObjectiveState, deps: BuildDeps): Step[] {
  if (state.done[SPLIT_CHILDREN]) return [];
  return [
    state.done[SPLIT]
      ? {
          key: SPLIT_CHILDREN,
          deadlineMs: 10 * MINUTE,
          run: (context) => children(context, deps),
        }
      : {
          key: SPLIT,
          deadlineMs: 10 * MINUTE,
          run: (context) => split(context, deps),
        },
  ];
}

async function split(context: StepContext, deps: BuildDeps): Promise<Outcome> {
  const { state, signal, log } = context;
  const { github, config } = deps;
  const parent = state.issue;
  const children = currentPlan(state)!.split!.children;
  const since = sinceRun(state);
  const marker = mark(parent, "split", runOf(state));
  const closing = await github.markedComment(parent, marker, since, signal);
  // Before the first child, the parent must still read as accepted.
  if (!closing) {
    const changed = await objectiveEdited(context, deps);
    if (changed) return changed;
  }
  const raw = (await github.issue(parent, signal)).body ?? "";
  const roles = await ensureRoles(github, config.tracking.issueType);
  const { priority } = await objectiveRole(
    github,
    parent,
    roles.types.objective,
    signal,
  );
  const inRun = (issue: IssueSummary) =>
    !since || Date.parse(issue.created_at ?? "") >= Date.parse(since);
  const subIssues = await github.subIssues(parent, signal);
  const found = [
    ...subIssues,
    ...(await github.issuesByLabel(OBJECTIVE_LABEL, since, signal)),
  ].filter(inRun);
  const made = new Map<string, IssueSummary>();
  const bodies: Record<string, string> = {};
  for (const child of children) {
    const issue = await github.ensureIssue(
      found,
      childMarker(parent, child.key),
      {
        title: child.title,
        body: childBody(parent, raw, child),
        labels: [OBJECTIVE_LABEL, ...priority],
      },
      "split:create",
      signal,
    );
    made.set(child.key, issue);
    bodies[child.key] = childDigest(issue.title, issue.body ?? "");
    const role = await objectiveRole(
      github,
      issue.number,
      roles.types.objective,
      signal,
    );
    if (role.typeRefused)
      log({
        event: "issue-type-missing",
        role: "objective",
        issue: issue.number,
        status: role.typeRefused.status,
      });
    await github.ensureSubIssue(
      parent,
      issue,
      subIssues,
      "split:sub-issue",
      signal,
    );
  }
  const owned = new Set([...made.values()].map((issue) => issue.number));
  for (const child of children)
    await github.ensureBlockedBy(
      made.get(child.key)!.number,
      child.dependsOn.map((key) => made.get(key)!),
      owned,
      "split:blocked-by",
      signal,
    );
  // A card someone moved since this run began (a child already running
  // shows its own progress) is left as it is.
  const display = new QueueDisplay(github, config);
  const queuedSince = since ?? new Date().toISOString();
  for (const [key, issue] of made) {
    const queued = await queueIssue(
      github,
      config,
      display,
      issue.number,
      false,
      { at: queuedSince },
      signal,
    );
    if (queued === "no_such_issue")
      throw new TransientError(
        `The Project can't see child Objective #${issue.number} yet`,
      );
    if (queued !== "queued")
      log({ event: "split-child-unqueued", key, issue: issue.number, queued });
  }
  const number = (key: string) => `#${made.get(key)!.number}`;
  const lines = children.map(
    (child) =>
      `- ${number(child.key)} ${code(child.key)} ${prose(child.title)}${child.dependsOn.length ? ` (after ${child.dependsOn.map(number).join(", ")})` : ""}`,
  );
  await github.ensureComment(
    parent,
    marker,
    `${marker}\n**Factory split this Objective into ${children.length} child Objective${children.length === 1 ? "" : "s"}** from its accepted plan, and queued them:\n\n${lines.join("\n")}\n\nEach child runs as its own Objective, after the children it builds on are done; Factory created them, so they need no approval. This issue closes once every child is done.`,
    "split:comment",
    signal,
    since,
  );
  const result: SplitRecord = {
    children: Object.fromEntries(
      [...made].map(([key, issue]) => [key, issue.number]),
    ),
    bodies,
  };
  return { kind: "done", result };
}

/** Wait for every child to be done; then close the parent. */
async function children(
  context: StepContext,
  deps: BuildDeps,
): Promise<Outcome> {
  const { state, signal, answer } = context;
  const { github } = deps;
  const record = splitRecord(state)!;
  const states: Record<string, string> = {};
  for (const [key, issue] of Object.entries(record.children)) {
    const found = findState(deps.objectives, issue);
    states[key] = !found
      ? "queued"
      : found.kind === "ok"
        ? found.state.status
        : "unreadable";
  }
  const keep = { [CHILD_STATES]: states };
  const ref = (key: string) => `#${record.children[key]} ${code(key)}`;
  const anyway = answer?.answer === "continue";
  const cancelled = Object.keys(states).filter(
    (key) => states[key] === "cancelled",
  );
  if (cancelled.length && !anyway)
    return {
      ...objectiveWide(
        hold(
          `Child Objective${cancelled.length === 1 ? "" : "s"} ${cancelled.map(ref).join(", ")} of this split ${cancelled.length === 1 ? "was" : "were"} cancelled, so ${cancelled.length === 1 ? "its" : "their"} part of this Objective won't be delivered. \`continue\` closes this Objective anyway; \`retry\` looks again once you have queued ${cancelled.length === 1 ? "it" : "them"} again; or cancel.`,
          [
            {
              answer: "continue",
              family: "accept",
              consequence:
                "Closes this Objective as done by its split, without the cancelled children.",
            },
            "retry",
            "cancel",
          ],
        ),
      ),
      keep,
    };
  const open = Object.keys(states).filter((key) => states[key] !== "done");
  if (open.length && !anyway) {
    const on = open.map((key) => `#${record.children[key]} (${states[key]})`);
    // Like a predecessor wait: no question, no slot, no deadline.
    return {
      kind: "retry",
      reason: `Waiting on child Objective${open.length === 1 ? "" : "s"} ${on.join(", ")}`,
      wait: {
        kind: "gate",
        gate: `child Objective${open.length === 1 ? "" : "s"} ${on.join(", ")}`,
      },
      keep,
    };
  }
  const since = sinceRun(state);
  const marker = mark(state.issue, "split-done", runOf(state));
  const lines = Object.keys(states).map(
    (key) => `- ${ref(key)}: ${prose(states[key]!)}`,
  );
  await github.ensureComment(
    state.issue,
    marker,
    `${marker}\n**${anyway ? "Factory closes this Objective as you answered" : "Every child Objective is done"}**; its children delivered it:\n\n${lines.join("\n")}`,
    "split:done-comment",
    signal,
    since,
  );
  await github.closeIssue(state.issue, "completed", "split:close", signal);
  return {
    kind: "done",
    result: anyway ? { states, continued: answer!.by } : { states },
    keep,
  };
}

/**
 * A child's issue body: its marker, its own Goal, Acceptance and Sources,
 * then every other section of the parent's body (Context, Constraints,
 * Non-goals, declarations such as a package manager update) unchanged, so
 * the child plans under the same authority as its parent. The goal is
 * model text: it is written as prose. Each outcome is one of the parent's
 * own Acceptance criteria (checks.ts splitFindings), written the same way,
 * code spans kept, so a command criterion stays one.
 */
function childBody(
  parent: number,
  parentBody: string,
  child: ChildObjectiveSpec,
): string {
  return [
    childMarker(parent, child.key),
    `Part of #${parent}. Factory created this child Objective from its accepted plan.`,
    "",
    "## Goal",
    "",
    text(child.goal.trim()),
    "",
    "## Acceptance",
    "",
    ...child.outcomes.map((outcome) => `- ${text(outcome.trim())}`),
    "",
    ...(child.sources.length
      ? [
          "## Sources",
          "",
          ...child.sources.map(
            ({ path, heading }) =>
              `- ${code(heading === undefined ? path : `${path}#${heading}`)}`,
          ),
          "",
        ]
      : []),
    carriedSections(parentBody),
  ]
    .join("\n")
    .trimEnd()
    .concat("\n");
}

/** Markdown text outside its code spans as prose; the spans as they are. */
function text(value: string): string {
  return value
    .split(/(`+[^`]*?`+)/)
    .map((part, index) => (index % 2 ? part : prose(part)))
    .join("");
}

/**
 * The parent's body without the sections a child replaces. A section is a
 * level-2 or level-3 heading (issue forms render fields as `###`) and
 * everything up to the next heading at its level or above; text before the
 * first section is the parent's own preamble and is left out. Kept
 * headings become level 2, so none nests inside the child's Sources.
 */
function carriedSections(body: string): string {
  let dropping: number | undefined;
  let started = false;
  const kept: string[] = [];
  for (const line of markdownLines(body)) {
    const heading = line.fenced ? undefined : line.heading;
    const section = heading && [2, 3].includes(heading.level);
    if (section) {
      started = true;
      if (dropping === undefined || heading.level <= dropping)
        dropping = REPLACED.includes(heading.text.toLowerCase())
          ? heading.level
          : undefined;
    }
    if (started && dropping === undefined)
      kept.push(section ? `## ${heading.text}` : line.text);
  }
  return kept.join("\n").trim();
}
