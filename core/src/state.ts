import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { crashPoint } from "./crash.js";
import type { HoldScope } from "./engine.js";
import type { ProviderConfig } from "./providers/config.js";

/**
 * 2: open questions are a list (`holds`), saved ones a map (`asking`).
 * Another version is unreadable, with no migration; `factory reset`
 * (#1775) must rebuild `holds`.
 */
const STATE_VERSION = 2;

export type ObjectiveStatus =
  | "checking"
  | "planning"
  | "building"
  | "finishing"
  | "holding"
  | "done"
  | "failed"
  | "cancelled";

export const TERMINAL: readonly ObjectiveStatus[] = [
  "done",
  "failed",
  "cancelled",
];

/** A question only a person can answer. Every answer it lists works. */
export interface Hold {
  id: string;
  /** The step that asked; it runs again with the answer. */
  step: string;
  /**
   * The Work Item it stops (a Work Item step's question about that item):
   * that item waits, and the items that depend on it. Absent: the whole
   * Objective waits (CORE.md#Holds and answers).
   */
  item?: string;
  question: string;
  answers: string[];
  recommended: string;
  askedAt: string;
  /**
   * When its issue comment last changed to what it shows now, by GitHub's
   * clock (the comment's created_at or updated_at): an answer that names
   * no question is compared with this, never with a host time.
   */
  shownAt?: string;
  /** The comment shows the short form `/factory <answer>` (it was the one open question). */
  shortForm?: boolean;
}

export interface Answer {
  holdId: string;
  /** The question this answers, as it was asked. */
  question?: string;
  answer: string;
  text?: string;
  by: string;
  at: string;
}

/**
 * Why a retry waits (CORE.md#Waits). Absent: an unknown transient cause,
 * such as the network, a GitHub or provider outage, or CI still running.
 */
export type Wait =
  /** A limit that resets at `at` (unknown when absent), from `provider` when a model provider set it. */
  | { kind: "reset"; at?: string; provider?: string }
  /** A person outside Factory: an environment approval, a required review. */
  | { kind: "gate"; gate: string };

export interface Retry {
  /** Consecutive escaped errors and missed deadlines; any other outcome resets it. */
  count: number;
  /** Retries in this run of one wait class (`Wait`, or an unknown cause); sets the backoff. */
  attempts: number;
  /** When this run of one wait class began (wall clock, so a restart doesn't reset it). */
  since: string;
  nextAt: string;
  lastError: string;
  /** The reason this run of retries began with. */
  cause?: string;
  /** The latest wait's class; absent for errors and unknown transient causes. */
  wait?: Wait;
  /** The operator answered `wait`: no question until then. */
  grantedUntil?: string;
}

/**
 * A question the engine raised about a step (a repair over budget, a
 * crash-loop suspect) while another question that stops it was open.
 */
export interface PendingQuestion {
  question: string;
  answers: string[];
  recommended: string;
  scope?: HoldScope;
}

/** The provider an Objective was admitted with, kept for its whole run. */
export interface FrozenProvider {
  name: string;
  /** Why: the configured default, `serve --provider`, or the operator's `switch` answer to a usage limit. */
  selectedBy: "defaultProvider" | "--provider" | "switch";
  /** The provider's planner, models and worker as they were at admission. */
  settings: ProviderConfig;
}

export interface ObjectiveState {
  version: number;
  issue: number;
  /** `holding` while any question is open. */
  status: ObjectiveStatus;
  /** Frozen at admission; absent only for a record that never ran. */
  provider?: FrozenProvider;
  /** Open questions, oldest first: at most one for the Objective and one per Work Item. */
  holds: Hold[];
  /**
   * The latest GitHub time at which any question's comment was shown
   * (posted or edited), closed questions included. An answer that names no
   * question applies only to a question shown after every other one, so it
   * can't land on a question its author didn't read (engine.ts `answer`).
   */
  lastShownAt?: string;
  /** The latest answer per step, read by the step when it runs again. */
  answers: Record<string, Answer>;
  retries: Record<string, Retry>;
  /**
   * Questions saved per step, asked as soon as no open question stops the
   * step, before it runs. Kept apart from `retries`, so no change to a
   * retry drops one; cleared when asked, or when a repair clears the step.
   */
  asking: Record<string, PendingQuestion>;
  /** Facts steps keep across repairs (Outcome `keep`), by key. */
  kept: Record<string, unknown>;
  /** Repairs per target step, with the latest findings (newest last). */
  repairs: Record<string, { count: number; findings: string[] }>;
  /** Steps that finished, with their saved results. */
  done: Record<string, unknown>;
  /**
   * Steps started and not yet finished, with the service run that started
   * each. One found after a restart was interrupted, and runs again.
   */
  attempts: Record<string, { startedAt: string; run?: string }>;
  /** The service run that last finished a step of this Objective, saved with the step's outcome. */
  finishedRun?: string;
  /** The latest applied requests and their results, so a request is never applied twice. */
  appliedRequests: { id: string; message: string }[];
  /** Per-capability data. Modules own their key. */
  modules: Record<string, unknown>;
  updatedAt: string;
  /** When this run was admitted: with the issue, it names the run. */
  startedAt?: string;
  /** The first save at a terminal status. */
  endedAt?: string;
}

export function newObjective(
  issue: number,
  now: Date,
  provider?: FrozenProvider,
): ObjectiveState {
  return {
    version: STATE_VERSION,
    issue,
    status: "checking",
    ...(provider ? { provider } : {}),
    holds: [],
    answers: {},
    retries: {},
    asking: {},
    repairs: {},
    kept: {},
    done: {},
    attempts: {},
    appliedRequests: [],
    modules: {},
    updatedAt: now.toISOString(),
    startedAt: now.toISOString(),
  };
}

function statePath(dir: string, issue: number): string {
  return join(dir, `${issue}.json`);
}

/**
 * Write the whole file: temporary file, fsync, rename, fsync the directory.
 * A crash at any point leaves the old file or the new one, never a mix.
 */
export function saveState(dir: string, state: ObjectiveState): void {
  mkdirSync(dir, { recursive: true });
  const path = statePath(dir, state.issue);
  const temporary = `${path}.${process.pid}.tmp`;
  const fd = openSync(temporary, "w", 0o600);
  try {
    writeSync(fd, `${JSON.stringify(state, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  crashPoint("state:before-rename");
  renameSync(temporary, path);
  syncDirectory(dir);
  crashPoint("state:saved");
}

/** Remove the Objective's state: it was dequeued before it started. */
export function removeState(dir: string, issue: number): void {
  rmSync(statePath(dir, issue), { force: true });
  syncDirectory(dir);
}

/**
 * Settled Objectives' files, under the state directory: the service never
 * reads them at startup (rule 6: cost follows active work, never history);
 * findState reads one when a request, a re-queue or status names it.
 */
const FINISHED = "finished";

/**
 * Move a settled Objective's file into finished/, once its cleanup, its
 * final sync and its settled observation are done. A later save (a request
 * to the finished Objective) writes the active file again, and it moves
 * again. Nothing to move is not an error.
 */
export function finishState(dir: string, issue: number): void {
  const finished = join(dir, FINISHED);
  mkdirSync(finished, { recursive: true });
  try {
    renameSync(statePath(dir, issue), statePath(finished, issue));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  syncDirectory(finished);
  syncDirectory(dir);
}

/** The Objective's active state, else its finished one; null when it has neither. */
export function findState(dir: string, issue: number): Loaded | null {
  return loadState(dir, issue) ?? loadState(join(dir, FINISHED), issue);
}

/** Every issue with an active or a finished state file. */
export function listAllObjectives(dir: string): number[] {
  return [
    ...new Set([
      ...listObjectives(dir),
      ...listObjectives(join(dir, FINISHED)),
    ]),
  ].sort((a, b) => a - b);
}

function syncDirectory(dir: string): void {
  const dirFd = openSync(dir, "r");
  try {
    fsyncSync(dirFd);
  } finally {
    closeSync(dirFd);
  }
}

export type Loaded =
  | { kind: "ok"; state: ObjectiveState }
  | { kind: "unreadable"; issue: number; error: string };

/**
 * The Objective's state; null when it has none. Only a file that doesn't
 * parse, or has another version, is unreadable; a read that fails (EMFILE,
 * EIO) throws, and the caller tries again later.
 */
export function loadState(dir: string, issue: number): Loaded | null {
  let text: string;
  try {
    text = readFileSync(statePath(dir, issue), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const state = JSON.parse(text) as ObjectiveState;
    if (state.version !== STATE_VERSION)
      return {
        kind: "unreadable",
        issue,
        error: `state version ${state.version}, expected ${STATE_VERSION}`,
      };
    return { kind: "ok", state };
  } catch (error) {
    return { kind: "unreadable", issue, error: String(error) };
  }
}

/** Issue numbers with a state file. Leftover temporary files are ignored. */
export function listObjectives(dir: string): number[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .map((name) => /^(\d+)\.json$/.exec(name)?.[1])
    .filter((n): n is string => n !== undefined)
    .map(Number)
    .sort((a, b) => a - b);
}
