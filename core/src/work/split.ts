import {
  hold,
  type Outcome,
  objectiveWide,
  type Step,
  type StepContext,
} from "../engine.js";
import { type IssueSummary, sameLogin, TransientError } from "../github.js";
import {
  ensureRoles,
  OBJECTIVE_LABEL,
  objectiveRole,
} from "../github-roles.js";
import { code, mark, markdownLines, prose } from "../markdown.js";
import { childDigest, childOf } from "../planning/facts.js";
import {
  currentPlan,
  SPLIT,
  SPLIT_CHILDREN,
  SPLIT_QUEUE,
  type SplitRecord,
  splitRecord,
} from "../planning/plan.js";
import type { ChildObjectiveSpec } from "../planning/types.js";
import { cardOption, QueueDisplay, queueIssue } from "../queue.js";
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
/** Children the operator's `continue` went on without, by key, and the answer that did. */
const DROPPED = "split:dropped";

const MINUTE = 60_000;
/** The parent's sections a child replaces with its own. */
const REPLACED = ["goal", "outcome", "acceptance", "sources"];
/** A child status the split can't wait out: only the operator can (`continue`, `retry`, cancel). */
const ENDED = new Set([
  "cancelled",
  "closed",
  "missing",
  "not queued",
  "unreadable",
]);

/** The first line of a child's body: the structure planning/facts.ts childOf reads. */
export function childMarker(parent: number, key: string): string {
  return `<!-- factory:parent=${parent};child=${key} -->`;
}

interface Dropped {
  keys: string[];
  /** The `continue` answers applied, by their time. */
  answers: string[];
}

function droppedOf(state: ObjectiveState): Dropped {
  return (
    (state.kept[DROPPED] as Dropped | undefined) ?? {
      keys: [],
      answers: [],
    }
  );
}

/** Each child's issue and last read status, in plan order; empty unless the Objective split. */
export function childRows(
  state: ObjectiveState,
): { key: string; issue: number; status: string }[] {
  const record = splitRecord(state);
  const states = (state.kept[CHILD_STATES] ?? {}) as Record<string, string>;
  const dropped = new Set(droppedOf(state).keys);
  return Object.entries(record?.children ?? {}).map(([key, issue]) => ({
    key,
    issue,
    status: `${states[key] ?? (state.done[SPLIT_QUEUE] ? "queued" : "created")}${dropped.has(key) ? " (gone on without)" : ""}`,
  }));
}

/**
 * The steps of a split, once its plan is accepted: create the children
 * (their record is saved before any is queued, so an admission can find
 * its parent), queue them, then wait for them.
 */
export function splitSteps(state: ObjectiveState, deps: BuildDeps): Step[] {
  if (state.done[SPLIT_CHILDREN]) return [];
  const step = (
    key: string,
    run: (context: StepContext, deps: BuildDeps) => Promise<Outcome>,
  ): Step => ({ key, deadlineMs: 10 * MINUTE, run: (c) => run(c, deps) });
  return [
    !state.done[SPLIT]
      ? step(SPLIT, split)
      : !state.done[SPLIT_QUEUE]
        ? step(SPLIT_QUEUE, queue)
        : step(SPLIT_CHILDREN, children),
  ];
}

/**
 * Whether only the wait for the children is left: the Objective's own
 * deadline doesn't cancel it then, as the children run on their own.
 */
export function waitingOnChildren(state: ObjectiveState): boolean {
  return Boolean(state.done[SPLIT_QUEUE]) && !state.done[SPLIT_CHILDREN];
}

/** A question whose only answers go on with the children that exist: never a replan, which would orphan them. */
function childrenHold(
  question: string,
  go?: string,
): Extract<Outcome, { kind: "hold" }> {
  return objectiveWide(
    hold(question, [
      ...(go
        ? [
            {
              answer: "continue",
              family: "accept" as const,
              consequence: go,
            },
          ]
        : []),
      "retry",
      "cancel",
    ]),
  );
}

async function split(context: StepContext, deps: BuildDeps): Promise<Outcome> {
  const { state, signal, log } = context;
  const { github, config } = deps;
  const parent = state.issue;
  const children = currentPlan(state)!.split!.children;
  const since = sinceRun(state);
  // Before the first child, the parent must still read as accepted.
  const changed = await objectiveEdited(context, deps);
  if (changed) return changed;
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
  // An earlier run's children still open: a second set would run beside them.
  const self = await github.login(signal);
  const earlier = subIssues.filter(
    (issue) =>
      !inRun(issue) &&
      issue.state === "open" &&
      childOf(issue.body ?? "")?.parent === parent &&
      issue.user !== null &&
      sameLogin(issue.user.login, self),
  );
  if (earlier.length)
    return childrenHold(
      `An earlier run of this Objective created child Objective${earlier.length === 1 ? "" : "s"} ${earlier.map((issue) => `#${issue.number}`).join(", ")}, still open. This run would create a second set beside ${earlier.length === 1 ? "it" : "them"}: close ${earlier.length === 1 ? "it" : "them"} (or let ${earlier.length === 1 ? "it" : "them"} finish and close), then answer retry; or cancel.`,
    );
  const found = [
    ...subIssues,
    ...(await github.issuesByLabel(OBJECTIVE_LABEL, since, signal)),
  ].filter(inRun);
  const made = new Map<string, IssueSummary>();
  const bodies: Record<string, string> = {};
  for (const child of children) {
    const marker = childMarker(parent, child.key);
    const body = childBody(parent, raw, child);
    const digest = childDigest(child.title, body);
    // A child this run made for another plan (a crash, then a new plan)
    // is never reused for this one.
    const existing = await github.markedIssue(found, marker, signal);
    if (existing && childDigest(existing.title, existing.body ?? "") !== digest)
      return childrenHold(
        `Issue #${existing.number} is child Objective ${code(child.key)} as Factory created it for an earlier plan or text of this Objective, and it doesn't match the plan accepted now. Close it, then answer retry; or cancel.`,
      );
    const issue = await github.ensureIssue(
      found,
      marker,
      {
        title: child.title,
        body,
        labels: [OBJECTIVE_LABEL, ...priority],
      },
      "split:create",
      signal,
    );
    made.set(child.key, issue);
    bodies[child.key] = digest;
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
  const result: SplitRecord = {
    children: Object.fromEntries(
      [...made].map(([key, issue]) => [key, issue.number]),
    ),
    bodies,
  };
  return { kind: "done", result };
}

/** Queue every child, then list them on the parent. */
async function queue(context: StepContext, deps: BuildDeps): Promise<Outcome> {
  const { state, signal, log } = context;
  const { github, config } = deps;
  const record = splitRecord(state)!;
  const children = currentPlan(state)!.split!.children;
  const since = sinceRun(state);
  // A card someone moved since this run began (a child already running
  // shows its own progress) is left as it is; the wait finds a child that
  // never runs.
  const display = new QueueDisplay(github, config);
  const queuedSince = since ?? new Date().toISOString();
  for (const [key, issue] of Object.entries(record.children)) {
    const queued = await queueIssue(
      github,
      config,
      display,
      issue,
      false,
      { at: queuedSince },
      signal,
    );
    if (queued === "no_such_issue")
      throw new TransientError(
        `The Project can't see child Objective #${issue} yet`,
      );
    if (queued !== "queued")
      log({ event: "split-child-unqueued", key, issue, queued });
  }
  const number = (key: string) => `#${record.children[key]}`;
  const lines = children.map(
    (child) =>
      `- ${number(child.key)} ${code(child.key)} ${prose(child.title)}${child.dependsOn.length ? ` (after ${child.dependsOn.map(number).join(", ")})` : ""}`,
  );
  const marker = mark(state.issue, "split", runOf(state));
  await github.ensureComment(
    state.issue,
    marker,
    `${marker}\n**Factory split this Objective into ${children.length} child Objective${children.length === 1 ? "" : "s"}** from its accepted plan, and queued them:\n\n${lines.join("\n")}\n\nEach child runs as its own Objective, after the children it builds on are done; Factory created them, so they need no approval. This issue closes once every child is done.`,
    "split:comment",
    signal,
    since,
  );
  return { kind: "done" };
}

/**
 * A child's status: its Objective's, else, before it is admitted, what
 * its issue and card say: `closed`, `missing` (deleted or transferred) or
 * `not queued` never run; otherwise `queued`.
 */
async function childStatus(
  deps: BuildDeps,
  issue: number,
  signal: AbortSignal,
): Promise<string> {
  const stateOf = () => {
    const found = findState(deps.objectives, issue);
    return !found
      ? undefined
      : found.kind === "ok"
        ? found.state.status
        : "unreadable";
  };
  const known = stateOf();
  if (known) return known;
  const card = await cardOption(deps.github, deps.config, issue, signal);
  // Admitted meanwhile: its own status counts.
  const admitted = stateOf();
  if (admitted) return admitted;
  if (!card) return "missing";
  if (!card.open) return "closed";
  return card.option === deps.config.queue.options.queued
    ? "queued"
    : "not queued";
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
  for (const [key, issue] of Object.entries(record.children))
    states[key] = await childStatus(deps, issue, signal);
  const ref = (key: string) => `#${record.children[key]} ${code(key)}`;
  let dropped = droppedOf(state);
  const ended = Object.keys(states).filter(
    (key) => ENDED.has(states[key]!) && !dropped.keys.includes(key),
  );
  // `continue` goes on without the children that can't finish now; once.
  if (
    answer?.answer === "continue" &&
    !dropped.answers.includes(answer.at) &&
    ended.length
  ) {
    dropped = {
      keys: [...dropped.keys, ...ended],
      answers: [...dropped.answers, answer.at],
    };
    return {
      kind: "retry",
      reason: `Going on without ${ended.map(ref).join(", ")}.`,
      progress: true,
      keep: { [CHILD_STATES]: states, [DROPPED]: dropped },
    };
  }
  const keep = { [CHILD_STATES]: states };
  if (ended.length)
    return {
      ...childrenHold(
        `Child Objective${ended.length === 1 ? "" : "s"} ${ended.map((key) => `${ref(key)} (${states[key]})`).join(", ")} of this split won't run to done as ${ended.length === 1 ? "it stands" : "they stand"}, so ${ended.length === 1 ? "its" : "their"} part of this Objective won't be delivered. \`continue\` goes on without ${ended.length === 1 ? "it" : "them"} and closes this Objective once the other children are done; \`retry\` looks again once you have reopened or queued ${ended.length === 1 ? "it" : "them"} again; or cancel.`,
        `Goes on without ${ended.length === 1 ? "it" : "them"}: this Objective closes once its other children are done.`,
      ),
      keep,
    };
  const open = Object.keys(states).filter(
    (key) => states[key] !== "done" && !dropped.keys.includes(key),
  );
  if (open.length) {
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
  // The parent closes as accepted only while it still reads as accepted.
  if (!(await github.markedComment(state.issue, marker, since, signal))) {
    const changed = await objectiveEdited(context, deps);
    // Its children run from the accepted plan: no replan here.
    if (changed?.kind === "hold")
      return {
        ...childrenHold(
          `Objective #${state.issue} was edited or closed after its plan was accepted, and its children delivered that plan. \`continue\` (once it is open) accepts the text as it is now and closes it as done; or cancel.`,
          "Accepts the Objective as it reads now and closes it as done by its children.",
        ),
        keep,
      };
    if (changed) return changed;
  }
  const lines = Object.keys(states).map(
    (key) =>
      `- ${ref(key)}: ${prose(states[key]!)}${dropped.keys.includes(key) ? " (gone on without it)" : ""}`,
  );
  await github.ensureComment(
    state.issue,
    marker,
    `${marker}\n**${dropped.keys.length ? "Every child Objective still running is done" : "Every child Objective is done"}**; its children delivered this Objective:\n\n${lines.join("\n")}`,
    "split:done-comment",
    signal,
    since,
  );
  await github.closeIssue(state.issue, "completed", "split:close", signal);
  return {
    kind: "done",
    result: { states, ...(dropped.keys.length ? { dropped } : {}) },
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
