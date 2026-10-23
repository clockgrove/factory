import { randomUUID } from "node:crypto";
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
import type { DreamWrite } from "./knowledge/dream.js";

/**
 * Operator requests: the CLI writes one file per request, and the service
 * applies it, records its id in the Objective's state, and then deletes the
 * file. A request found again after a crash is recognised by its id and
 * only deleted.
 */
export type Request =
  | {
      kind: "answer";
      issue: number;
      answer: string;
      /** The option's argument (`switch NAME`), apart from the text. */
      arg?: string;
      text?: string;
      /** When the answer was written (a comment's time): it only answers a question already asked then. */
      writtenAt?: string;
      /** The id of the question this answers (`hold.id`); absent: see `ObjectiveRunner.answer`. */
      question?: string;
    }
  | { kind: "cancel"; issue: number }
  | { kind: "retry"; issue: number; question?: string }
  /** Rebuild the Objective's state from GitHub (`factory reset`). */
  | { kind: "reset"; issue: number }
  /** Per-Objective control; it survives restarts. */
  | { kind: "pause" | "drain" | "resume"; issue: number }
  /** Queue-wide control (issue 0); it survives restarts. */
  | { kind: "queue"; issue: 0; mode: QueueMode }
  | DreamRequest;

/** A `factory dream` write to the knowledge store (knowledge/dream.ts), installation-wide (issue 0). */
export type DreamRequest = { kind: "dream"; issue: 0; write: DreamWrite };

/** The queue's mode: `paused` admits and starts nothing; `draining` admits nothing new. */
export type QueueMode = "running" | "paused" | "draining";

/**
 * Stable refusal codes. Tools decide on the code, never the message. The
 * CLI prints `{"kind":"lifecycle-refusal","code":"..."}` on stderr before
 * the message.
 */
export type RefusalCode =
  /** Command line misuse: an unknown command, option or value. */
  | "usage"
  /** Factory has no state for this Objective (and, for a reset, GitHub has no plan comment or card). */
  | "no_factory_state"
  /** The Objective has finished (done or failed); only re-queuing runs it again. */
  | "objective_finished"
  /** The Objective has no open question. */
  | "no_open_question"
  /** The answer names a question that is no longer open: it changed, or it was answered. */
  | "stale_question"
  /** An open question stops the steps, so the command must name it with `--question`. */
  | "question_required"
  /** The answer isn't one the question offers, or `switch` names no usable provider. */
  | "invalid_answer"
  /** The Objective's state can't be read: answer reset or cancel. */
  | "state_unreadable"
  /** The command needs this repository's configuration. */
  | "no_configuration"
  /** GitHub has no such issue in this repository. */
  | "no_such_issue"
  /** A reset found a plan comment whose data isn't Factory's own, or doesn't parse. */
  | "plan_unreadable"
  /** A later cancel replaced this request before it applied. */
  | "superseded"
  /** A reset of this Objective is already rebuilding it. */
  | "reset_in_progress"
  /** The queue is paused or draining, so nothing new is admitted (a reset of an Objective Factory has no state for). */
  | "queue_not_running"
  /** The command writes what only the running service writes (the knowledge store): start `factory serve`. */
  | "service_not_running"
  /** The knowledge store refused a `dream` write: the message says why (a changed or decided draft, an unreadable store). */
  | "dream_refused";

/** A request's result: applied (no code), or refused with a stable code. */
export interface RequestResult {
  message: string;
  code?: RefusalCode;
  /** What an applied `dream` write reports. */
  detail?: Record<string, unknown>;
}

export const refused = (code: RefusalCode, message: string): RequestResult => ({
  code,
  message,
});

/** `cancel`, or the answer `cancel`: it works at any time. */
export function isCancel(request: Request): boolean {
  return (
    request.kind === "cancel" ||
    (request.kind === "answer" && request.answer === "cancel")
  );
}

export interface StoredRequest {
  id: string;
  at: string;
  by: string;
  request: Request;
}

export function writeRequest(
  dir: string,
  request: Request,
  by: string,
  /** A fixed id makes writing the same request twice harmless. */
  fixedId?: string,
): string {
  mkdirSync(dir, { recursive: true });
  const at = new Date().toISOString();
  const id =
    fixedId ?? `${at.replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const stored: StoredRequest = { id, at, by, request };
  const temporary = join(dir, `.${id}.tmp`);
  const fd = openSync(temporary, "w", 0o600);
  try {
    writeSync(fd, JSON.stringify(stored));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, join(dir, `${id}.json`));
  return id;
}

/** Pending requests, oldest first. Unreadable files are returned for deletion. */
export function pendingRequests(
  dir: string,
): { file: string; stored: StoredRequest | null }[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith(".json") && !name.startsWith("."))
    .sort()
    .map((name) => {
      const file = join(dir, name);
      try {
        return {
          file,
          stored: JSON.parse(readFileSync(file, "utf8")) as StoredRequest,
        };
      } catch {
        return { file, stored: null };
      }
    });
}

export function removeRequest(file: string): void {
  rmSync(file, { force: true });
}
