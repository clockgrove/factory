import { createHash } from "node:crypto";
import { objectiveComplete } from "./completion.js";
import type { WorkGraph } from "./contracts.js";
import { markdownLines } from "./markdown.js";
import {
  type ContinuationState,
  isExecutionState,
  isPreparationState,
  type PreparationState,
} from "./state.js";
import { readContinuation } from "./state-store.js";

/**
 * A reviewed plan can split its Objective into child Objectives instead of
 * returning one Work Item graph. Each child is a normal Objective issue: it
 * runs through the queue, its own plan, delivery and final acceptance. The
 * parent creates and enqueues the children, waits, and closes when every
 * child is accepted and closed.
 */
export interface ChildObjectiveSpec {
  /** Stable key within the split: lowercase letters, digits and hyphens. */
  key: string;
  title: string;
  /** One paragraph: what this child changes and what it leaves to others. */
  goal: string;
  /** Observable outcomes; they become the child's Acceptance bullets. */
  outcomes: string[];
  /** The parent's sources this child needs, as Sources selectors. */
  sources: { path: string; heading?: string }[];
  /** Keys of sibling children whose merged code this child builds on. */
  dependsOn: string[];
  /**
   * The Work Item graph compiled in the parent's pass, only for a child with
   * no dependencies. A stub (dependencies) has none: it compiles later,
   * against the main branch that holds its dependencies' code.
   */
  graph?: WorkGraph;
}

/** The reviewed split and its GitHub projection, owned by the parent's continuation. */
export interface ObjectiveSplit {
  /** The parent plan review that accepted this split. */
  reviewDigest: string;
  children: ChildObjectiveSpec[];
  /** Child issue number by key, recorded as each issue is created or found. */
  issues: Record<string, number>;
  /** Set once every child issue is in the queue. */
  enqueuedAt?: string;
  /** The child dispositions the parent's status last showed. */
  shown?: Record<string, ChildDisposition>;
  /** Set once the parent issue is closed after every child closed. */
  closedAt?: string;
}

export type ChildDisposition =
  | "queued"
  | "waiting-for-dependencies"
  | "running"
  | "needs-decision"
  | "accepted"
  | "cancelled";

const KEY = /^[a-z][a-z0-9-]{0,63}$/;
const MAX_CHILDREN = 16;

export function childMarker(parent: number, key: string): string {
  return `<!-- factory:parent=${parent};child=${key} -->`;
}

export function splitDigest(children: ChildObjectiveSpec[]): string {
  return createHash("sha256").update(JSON.stringify(children)).digest("hex");
}

/** Shape, identity and dependency checks; semantics belong to the planner and review. */
export function assertChildObjectives(children: ChildObjectiveSpec[]): void {
  if (!Array.isArray(children) || !children.length)
    throw new Error("A split needs at least one child Objective");
  if (children.length > MAX_CHILDREN)
    throw new Error(`A split has at most ${MAX_CHILDREN} child Objectives`);
  const keys = new Set<string>();
  for (const child of children) {
    if (!KEY.test(child.key) || keys.has(child.key))
      throw new Error(
        `Child Objective key is invalid or repeated: ${child.key}`,
      );
    keys.add(child.key);
    if (!child.title?.trim() || child.title.includes("\n"))
      throw new Error(`Child Objective ${child.key} needs a one-line title`);
    if (!child.goal?.trim())
      throw new Error(`Child Objective ${child.key} needs a goal`);
    if (
      !child.outcomes.length ||
      child.outcomes.some(
        (outcome) => !outcome.trim() || outcome.includes("\n"),
      )
    )
      throw new Error(
        `Child Objective ${child.key} needs single-line observable outcomes`,
      );
    for (const source of child.sources)
      if (
        !source.path ||
        /[`\n#]/.test(source.path) ||
        (source.heading !== undefined &&
          (!source.heading.trim() || /[`\n]/.test(source.heading)))
      )
        throw new Error(`Child Objective ${child.key} has an invalid source`);
    if (child.dependsOn.length && child.graph)
      throw new Error(
        `Child Objective ${child.key} depends on siblings; it compiles after they merge`,
      );
  }
  for (const child of children)
    for (const dependency of child.dependsOn)
      if (!keys.has(dependency) || dependency === child.key)
        throw new Error(
          `Child Objective ${child.key} depends on an unknown sibling: ${dependency}`,
        );
  // Children are created in this order, so a dependency always exists first.
  const done = new Set<string>();
  for (const child of children) {
    if (child.dependsOn.some((dependency) => !done.has(dependency)))
      throw new Error(
        "Child Objectives must be listed after the siblings they depend on",
      );
    done.add(child.key);
  }
  if (!children.some((child) => !child.dependsOn.length))
    throw new Error("A split needs a child Objective with no dependencies");
}

/** Top-level `##` sections of a body, in order, with their raw text. */
function sections(body: string): { heading: string; text: string }[] {
  const lines = body.split("\n");
  const marks = markdownLines(body);
  const result: { heading: string; text: string[] }[] = [];
  for (const [index, line] of lines.entries()) {
    const heading = marks[index]?.heading;
    if (heading?.level === 2)
      result.push({ heading: heading.text, text: [line] });
    else result.at(-1)?.text.push(line);
  }
  return result.map(({ heading, text }) => ({
    heading,
    text: text.join("\n").trimEnd(),
  }));
}

const REPLACED = ["outcome", "acceptance", "sources"];

/**
 * The child's issue body: its own Outcome, Acceptance and Sources, with every
 * other parent section (Constraints and declarations such as a package
 * manager update) carried over unchanged, so the child plans under the same
 * authority as its parent.
 */
export function childIssueBody(
  parent: number,
  parentBody: string,
  child: ChildObjectiveSpec,
): string {
  const carried = sections(parentBody).filter(
    ({ heading }) => !REPLACED.includes(heading.toLowerCase()),
  );
  return [
    childMarker(parent, child.key),
    `Part of #${parent}. Factory created this child Objective from its reviewed plan.`,
    "",
    "## Outcome",
    "",
    child.goal.trim(),
    "",
    "## Acceptance",
    "",
    ...child.outcomes.map((outcome) => `- ${outcome.trim()}`),
    "",
    ...(child.sources.length
      ? [
          "## Sources",
          "",
          ...child.sources.map(
            ({ path, heading }) =>
              `- \`${path}${heading !== undefined ? `#${heading}` : ""}\``,
          ),
          "",
        ]
      : []),
    ...carried.flatMap(({ text }) => [text, ""]),
  ]
    .join("\n")
    .trimEnd()
    .concat("\n");
}

/** The parent and key of a child Objective issue body, if it is one. */
export function childIdentity(
  body: string,
): { parent: number; key: string } | undefined {
  const match = body.match(
    /^<!-- factory:parent=([1-9][0-9]*);child=([a-z][a-z0-9-]{0,63}) -->\n/,
  );
  if (!match) return undefined;
  const parent = Number(match[1]);
  return Number.isSafeInteger(parent) ? { parent, key: match[2]! } : undefined;
}

/** A parent whose children are created and enqueued: its own run is over. */
export function splitSettled(
  state: ContinuationState | undefined,
): state is PreparationState & { split: ObjectiveSplit } {
  return isPreparationState(state) && state.split?.enqueuedAt !== undefined;
}

/** Each child's current disposition, read from its own continuation only. */
export function childDispositions(
  repository: string,
  split: ObjectiveSplit,
): Record<string, ChildDisposition> {
  const result: Record<string, ChildDisposition> = {};
  for (const child of split.children) {
    const number = split.issues[child.key];
    const state =
      number === undefined ? undefined : readContinuation(repository, number);
    result[child.key] = !state
      ? child.dependsOn.some((key) => result[key] !== "accepted")
        ? "waiting-for-dependencies"
        : "queued"
      : state.cancelledAt
        ? "cancelled"
        : isExecutionState(state) && objectiveComplete(state)
          ? "accepted"
          : awaitsDecision(state)
            ? "needs-decision"
            : "running";
  }
  return result;
}

function awaitsDecision(state: ContinuationState): boolean {
  if (isPreparationState(state))
    return state.coordinator.phase === "waiting" || !!state.error;
  return (
    !!state.error ||
    !!state.finalAcceptancePending ||
    Object.values(state.work).some((work) => work.acceptancePending)
  );
}

/**
 * Dependencies on a split parent mean its children: the parent never has one
 * accepted tree of its own. Settled parents expand to their children in issue
 * order; anything else is returned unchanged.
 */
export function expandSplitPredecessors(
  repository: string,
  objectives: number[],
): number[] {
  const result = new Set<number>();
  const visit = (objective: number, depth: number) => {
    const state = readContinuation(repository, objective);
    if (depth < 8 && splitSettled(state))
      for (const child of state.split.children)
        visit(state.split.issues[child.key]!, depth + 1);
    else result.add(objective);
  };
  for (const objective of objectives) visit(objective, 0);
  return [...result].sort((left, right) => left - right);
}

/** Validates the retained record against the parent's reviewed plan. */
export function assertObjectiveSplitRecord(state: PreparationState): void {
  const split = state.split;
  if (split === undefined) return;
  if (
    !split ||
    typeof split !== "object" ||
    !state.plan?.split ||
    split.reviewDigest !== state.plan.reviewDigest ||
    !["clean", "human-accepted"].includes(state.plan.review.status) ||
    JSON.stringify(split.children) !== JSON.stringify(state.plan.split)
  )
    throw new Error("Objective split differs from its reviewed plan");
  assertChildObjectives(split.children);
  const keys = new Set(split.children.map((child) => child.key));
  const numbers = Object.entries(split.issues ?? {});
  if (
    !split.issues ||
    typeof split.issues !== "object" ||
    numbers.some(
      ([key, number]) =>
        !keys.has(key) ||
        !Number.isSafeInteger(number) ||
        number <= 0 ||
        number === state.objective,
    ) ||
    new Set(numbers.map(([, number]) => number)).size !== numbers.length ||
    Object.keys(state.issueByItemId).length
  )
    throw new Error("Invalid child Objective issue record");
  for (const time of [split.enqueuedAt, split.closedAt])
    if (time !== undefined && !Number.isFinite(Date.parse(time)))
      throw new Error("Invalid child Objective time");
  if (split.enqueuedAt !== undefined && numbers.length !== keys.size)
    throw new Error("Enqueued children lack their issues");
  if (split.closedAt !== undefined && split.enqueuedAt === undefined)
    throw new Error("A split closes only after its children are enqueued");
  const dispositions: string[] = [
    "queued",
    "waiting-for-dependencies",
    "running",
    "needs-decision",
    "accepted",
    "cancelled",
  ];
  if (
    split.shown !== undefined &&
    (typeof split.shown !== "object" ||
      Object.entries(split.shown).some(
        ([key, value]) => !keys.has(key) || !dispositions.includes(value),
      ))
  )
    throw new Error("Invalid child Objective disposition record");
}
