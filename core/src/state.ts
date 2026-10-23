import { createHash } from "node:crypto";
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
import type { FrozenConfig } from "./providers/selection.js";
import type { QueueMode, RefusalCode } from "./requests.js";

/**
 * 6: a hold carries its answers as `options`, each with its family and
 * consequence. 5: a Work Item's refused and replayed result is one
 * `refused` fact, and its diagnosis one `diagnosis` fact (work/facts.ts).
 * 4: a hold has a cause, an error retry is a wait class, cancel and the
 * end are one `ended` record (3: one frozen configuration in place of the
 * frozen provider). Another version is unreadable, with no migration;
 * `factory reset` rebuilds it from GitHub (reset.ts), with no open
 * question.
 */
const STATE_VERSION = 6;

export type ObjectiveStatus =
  | "checking"
  | "planning"
  | "building"
  | "finishing"
  | "holding"
  /** `factory reset`: rebuilding the state from GitHub (reset.ts). */
  | "resetting"
  | "done"
  | "cancelled";

export const TERMINAL: readonly ObjectiveStatus[] = ["done", "cancelled"];

/**
 * Why a question is open: a decision only a person can make, or a step
 * that can't succeed as it is (errors in a row, an allowance spent, a
 * crash loop, a result it can't produce), which also offers `replan`
 * where the workflow can plan again (engine.ts `Workflow.replannable`).
 */
export type HoldCause = "question" | "failure";

/** What kind of choice an answer is: a host groups a long list of options by it. */
export type AnswerFamily =
  | "retry"
  | "replan"
  | "cancel"
  | "wait"
  | "switch"
  | "adopt"
  | "accept"
  | "refuse"
  | "select"
  | "answer"
  | "repair"
  | "reset";

/** One answer a hold offers (CORE.md#Holds and answers). */
export interface HoldOption {
  /** The literal answer token: `/factory <answer>`. */
  answer: string;
  family: AnswerFamily;
  /** What goes after the token, for a parameterized answer (`switch NAME`). */
  arg?: string;
  /** One short sentence: what happens on this answer. */
  consequence: string;
  /** The answer needs text after it: one without is refused, with no change. */
  needsText?: boolean;
  /** Exactly one option per hold. */
  recommended?: boolean;
}

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
  options: HoldOption[];
  cause: HoldCause;
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

/**
 * How an option is written after `/factory`: `switch codex`, `answer
 * <text>`; `bound` (`--question ID`) goes right after the answer.
 */
export function answerForm(option: HoldOption, bound?: string): string {
  return [
    option.answer,
    ...(bound ? [bound] : []),
    ...(option.arg !== undefined ? [option.arg] : []),
    ...(option.needsText ? ["<text>"] : []),
  ].join(" ");
}

/** The answer tokens a hold offers, once each, for a reply that names them. */
export function answersOf(hold: Pick<Hold, "options">): string[] {
  return [...new Set(hold.options.map((option) => option.answer))];
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
  /**
   * An error: an escaped exception, a missed deadline, an idle model or an
   * invalid answer. It shares the unknown cause's budget, and three in a
   * row hold.
   */
  | { kind: "error" }
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
  /** The latest wait's class; absent for unknown transient causes. */
  wait?: Wait;
  /** The operator answered `wait`: no question until then. */
  grantedUntil?: string;
}

/**
 * A question the engine raised about a step (a crash-loop suspect) while
 * another question that stops it was open.
 */
export interface PendingQuestion {
  question: string;
  options: HoldOption[];
  scope?: HoldScope;
  cause?: HoldCause;
}

/**
 * The configuration an Objective runs with, frozen at admission
 * (CORE.md#Frozen configuration): its provider, with that provider's
 * resolved settings, and every other key but the operational ones
 * (providers/selection.ts OPERATIONAL). A `switch` or `adopt` answer freezes it again.
 */
export interface Frozen extends FrozenConfig {
  provider: string;
  /** Why this provider: the configured default, `serve --provider`, or the operator's `switch` answer. */
  selectedBy: "defaultProvider" | "--provider" | "switch";
}

export interface ObjectiveState {
  version: number;
  issue: number;
  /** `holding` while any question is open. */
  status: ObjectiveStatus;
  /** Frozen at admission; absent only without configuration. */
  frozen?: Frozen;
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
  /**
   * Repairs per target step, with the latest findings (newest last).
   * `free`: the repair numbers that count against no allowance (a failure
   * blamed on a predecessor, allowances.ts).
   */
  repairs: Record<
    string,
    { count: number; findings: string[]; free?: number[] }
  >;
  /** Steps that finished, with their saved results. */
  done: Record<string, unknown>;
  /**
   * Steps started and not yet finished, with the service run that started
   * each. One found after a restart was interrupted, and runs again.
   */
  attempts: Record<string, { startedAt: string; run?: string }>;
  /** The service run that last finished a step of this Objective, saved with the step's outcome. */
  finishedRun?: string;
  /**
   * Dequeued while its check or a re-run's cleanup ran: nothing past them
   * starts, and the service withdraws it once no step runs and the re-run's
   * cleanup is done.
   */
  withdrawing?: boolean;
  /** The latest applied requests and their results, so a request is never applied twice. */
  appliedRequests: { id: string; message: string; code?: RefusalCode }[];
  /**
   * The operator's pause or drain (`factory pause|drain N`), until
   * `factory resume N`. Paused: no step starts. Draining: no Work Item
   * starts that hasn't started; started ones carry on.
   */
  control?: { mode: "paused" | "draining"; by: string; at: string };
  /** Per-capability data. Modules own their key. */
  modules: Record<string, unknown>;
  updatedAt: string;
  /** When this run was admitted: with the issue, it names the run. */
  startedAt?: string;
  /**
   * The absolute deadline, saved at admission (`deadlineAt`): at it the
   * engine cancels the Objective, whatever it waits on (engine.ts
   * `expire`). Nothing moves it: not a restart, a reset or a later
   * configuration. Absent: no deadline.
   */
  deadline?: string;
  /** The first save at a terminal status; `by` names who cancelled (`deadline`: the deadline did). */
  ended?: { at: string; by?: string };
}

/**
 * The deadline of a run admitted at `at`: the admitting request's own
 * absolute time when it names one, else `seconds` (the configuration's
 * `queue.objectiveDeadlineSeconds`) later; none without either.
 */
export function deadlineAt(
  at: Date,
  seconds: number | undefined,
  requested?: string,
): string | undefined {
  if (requested !== undefined) return new Date(requested).toISOString();
  return seconds === undefined
    ? undefined
    : new Date(at.getTime() + seconds * 1000).toISOString();
}

export function newObjective(
  issue: number,
  now: Date,
  frozen?: Frozen,
): ObjectiveState {
  return {
    version: STATE_VERSION,
    issue,
    status: "checking",
    ...(frozen ? { frozen } : {}),
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

/**
 * A run's identity: its admission time (with the issue, it names the run).
 * Every artifact Factory relies on across runs is bound to it: memory
 * records and pins, the report comment. A record from before runs had one
 * reads as `unknown`.
 */
export function runOf(state: ObjectiveState): string {
  return state.startedAt ?? "unknown";
}

/** The most this host's clock is taken to differ from GitHub's: host times read against GitHub's go back this far. */
export const CLOCK_SKEW_MS = 10 * 60_000;

/** Where a GitHub read of this run's own comments starts: its admission (a host time), less the skew. */
export function sinceRun(state: ObjectiveState): string | undefined {
  const at = Date.parse(state.startedAt ?? "");
  return Number.isFinite(at)
    ? new Date(at - CLOCK_SKEW_MS).toISOString()
    : undefined;
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
  writeWhole(dir, statePath(dir, state.issue), state, "state");
}

function writeWhole(
  dir: string,
  path: string,
  state: ObjectiveState,
  point?: string,
): void {
  const temporary = `${path}.${process.pid}.tmp`;
  const fd = openSync(temporary, "w", 0o600);
  try {
    writeSync(fd, `${JSON.stringify(state, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (point) crashPoint(`${point}:before-rename`);
  renameSync(temporary, path);
  syncDirectory(dir);
  if (point) crashPoint(`${point}:saved`);
}

/** The queue-wide mode (`factory queue pause|drain|resume`), saved in the installation root. */
export interface QueueControl {
  mode: QueueMode;
  by?: string;
  at?: string;
}

const QUEUE_FILE = "queue.json";

/** The saved queue mode; running when none was saved or the file can't be read. */
export function loadQueueControl(root: string): QueueControl {
  try {
    const saved = JSON.parse(
      readFileSync(join(root, QUEUE_FILE), "utf8"),
    ) as QueueControl;
    if (["running", "paused", "draining"].includes(saved.mode)) return saved;
  } catch {
    // Never saved.
  }
  return { mode: "running" };
}

/** Save the queue mode whole: temporary file, fsync, rename. */
export function saveQueueControl(root: string, control: QueueControl): void {
  const path = join(root, QUEUE_FILE);
  const temporary = `${path}.${process.pid}.tmp`;
  const fd = openSync(temporary, "w", 0o600);
  try {
    writeSync(fd, `${JSON.stringify(control)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
  syncDirectory(root);
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

const OBSERVATION = ".observe.json";

/**
 * A run's settled observation that hasn't landed (service.ts `late`): the
 * state it observes, saved beside the finished states until it lands, so
 * a restart retries it. Returns the file, to remove once it lands.
 */
export function saveObservation(dir: string, state: ObjectiveState): string {
  const finished = join(dir, FINISHED);
  mkdirSync(finished, { recursive: true });
  const run = runOf(state).replace(/[^\w.-]/g, "-");
  const path = join(finished, `${state.issue}@${run}${OBSERVATION}`);
  writeWhole(finished, path, state);
  return path;
}

/**
 * The settled observations still to land. Only these files are read, never
 * the finished states; one that doesn't parse comes with its `error`, and
 * leftover temporary files are removed.
 */
export function listObservations(
  dir: string,
): { path: string; state?: ObjectiveState; error?: string }[] {
  const finished = join(dir, FINISHED);
  let names: string[];
  try {
    names = readdirSync(finished);
  } catch {
    return [];
  }
  const found: { path: string; state?: ObjectiveState; error?: string }[] = [];
  for (const name of names) {
    const path = join(finished, name);
    if (name.includes(`${OBSERVATION}.`) && name.endsWith(".tmp"))
      rmSync(path, { force: true });
    if (!name.endsWith(OBSERVATION)) continue;
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue; // read again at the next start
    }
    try {
      found.push({ path, state: JSON.parse(text) });
    } catch (error) {
      found.push({ path, error: String(error) });
    }
  }
  return found;
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
  | {
      kind: "unreadable";
      issue: number;
      error: string;
      /** The file's digest: one incident of unreadable state, until the file changes. */
      incident: string;
    };

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
        incident: digest(text),
      };
    return { kind: "ok", state };
  } catch (error) {
    return {
      kind: "unreadable",
      issue,
      error: String(error),
      incident: digest(text),
    };
  }
}

const digest = (text: string): string =>
  createHash("sha256").update(text).digest("hex").slice(0, 16);

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
