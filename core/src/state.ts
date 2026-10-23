import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { crashPoint } from "./crash.js";

const STATE_VERSION = 1;

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
  question: string;
  answers: string[];
  recommended: string;
  askedAt: string;
}

export interface Answer {
  holdId: string;
  answer: string;
  text?: string;
  by: string;
  at: string;
}

export interface Retry {
  /** Consecutive escaped errors, missed deadlines and interrupted attempts. */
  count: number;
  /** Retries of any kind in this run of retries; sets the backoff. */
  attempts: number;
  /** When this run of retries began. */
  since: string;
  nextAt: string;
  lastError: string;
}

/** The provider an Objective was admitted with, kept for its whole run. */
export interface FrozenProvider {
  name: string;
  /** Why: the configured default, or `serve --provider`. */
  selectedBy: "defaultProvider" | "--provider";
}

export interface ObjectiveState {
  version: number;
  issue: number;
  status: ObjectiveStatus;
  /** Frozen at admission; absent only for a record that never ran. */
  provider?: FrozenProvider;
  /** The status to return to when a hold is answered. */
  resumeStatus?: ObjectiveStatus;
  hold: Hold | null;
  /** The latest answer per step, read by the step when it runs again. */
  answers: Record<string, Answer>;
  retries: Record<string, Retry>;
  /** Facts steps keep across repairs (Outcome `keep`), by key. */
  kept: Record<string, unknown>;
  /** Repairs per target step, with the latest findings (newest last). */
  repairs: Record<string, { count: number; findings: string[] }>;
  /** Steps that finished, with their saved results. */
  done: Record<string, unknown>;
  /** Steps started and not yet finished. One found after a restart was interrupted. */
  attempts: Record<string, { startedAt: string }>;
  /** The latest applied requests and their results, so a request is never applied twice. */
  appliedRequests: { id: string; message: string }[];
  /** Per-capability data. Modules own their key. */
  modules: Record<string, unknown>;
  updatedAt: string;
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
    hold: null,
    answers: {},
    retries: {},
    repairs: {},
    kept: {},
    done: {},
    attempts: {},
    appliedRequests: [],
    modules: {},
    updatedAt: now.toISOString(),
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
  const dirFd = openSync(dir, "r");
  try {
    fsyncSync(dirFd);
  } finally {
    closeSync(dirFd);
  }
  crashPoint("state:saved");
}

export type Loaded =
  | { kind: "ok"; state: ObjectiveState }
  | { kind: "unreadable"; issue: number; error: string };

export function loadState(dir: string, issue: number): Loaded | null {
  let text: string;
  try {
    text = readFileSync(statePath(dir, issue), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return { kind: "unreadable", issue, error: String(error) };
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
