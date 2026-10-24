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
import { basename, dirname, join } from "node:path";
import { isObject } from "./checked.js";
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
  /**
   * `factory propose-amendment N --file F`: the file's JSON, checked by
   * the service where it enters (planning/amendments.ts `proposeAmendment`).
   */
  | { kind: "propose-amendment"; issue: number; proposal: unknown }
  /** `factory decline-discovery N --item ITEM --reason R` (planning/amendments.ts `declineDiscovery`). */
  | { kind: "decline-discovery"; issue: number; item: string; reason: string }
  /** Queue-wide control (issue 0); it survives restarts. */
  | { kind: "queue"; issue: 0; mode: QueueMode }
  | RunRequest
  | DreamRequest;

/**
 * `factory run N`: queue issue N now, through its Project card, so the
 * normal queue admission admits it, with this provider (frozen as
 * selectedBy "--provider") and this absolute deadline in place of the
 * defaults. It stays pending until its Objective is admitted; one already
 * running answers at once, with no second admission.
 */
export type RunRequest = {
  kind: "run";
  issue: number;
  provider?: string;
  /** Absolute (ISO): the CLI resolves a duration when it writes the request. */
  deadline?: string;
};

/** A `factory dream` write to the knowledge store (knowledge/dream.ts), installation-wide (issue 0). */
export type DreamRequest = { kind: "dream"; issue: 0; write: DreamWrite };

/** The queue's mode: `paused` admits and starts nothing; `draining` admits nothing new. */
export type QueueMode = "running" | "paused" | "draining";

/**
 * Stable refusal codes. Tools decide on the code, never the message. The
 * CLI prints `{"kind":"lifecycle-refusal","code":"..."}` on stderr before
 * the message. Kept in alphabetical order, so codes added at once don't
 * collide.
 */
export type RefusalCode =
  /** `propose-amendment` or `decline-discovery` wasn't taken: the message names each problem and what would pass. */
  | "amendment_refused"
  /** `run` names a finished Objective whose last step (cancel's cleanup, or a done run's ending step) hasn't settled yet: run it again once it has, or `factory reset N`. */
  | "cleanup_running"
  /** `run --deadline` passed before the Objective was admitted: run again with a new deadline. */
  | "deadline_passed"
  /** The knowledge store refused a `dream` write: the message says why (a changed or decided draft, an unreadable store). */
  | "dream_refused"
  /** `export-captures` can't build or send the export: the message says why (a changed export, an endpoint or headers it refuses, no model calls). */
  | "export_refused"
  /** The answer isn't one the question offers, or `switch` names no usable provider. */
  | "invalid_answer"
  /** The request file can't be taken: it doesn't parse, or isn't a request (the message says why); it moved to `requests/rejected/`. */
  | "invalid_request"
  /** `run` names a closed issue Factory never ran: reopen it first. */
  | "issue_closed"
  /** The command needs this repository's configuration. */
  | "no_configuration"
  /** Factory has no state for this Objective (and, for a reset, GitHub has no plan comment or card). */
  | "no_factory_state"
  /** The Objective has no open question. */
  | "no_open_question"
  /** GitHub has no such issue in this repository. */
  | "no_such_issue"
  /** The Objective has finished (done or failed); only re-queuing runs it again. */
  | "objective_finished"
  /** A reset found a plan comment whose data isn't Factory's own, or doesn't parse. */
  | "plan_unreadable"
  /** `propose` refused a draft or its approval: the message says why (a changed draft, failed Objective checks, an approval running). */
  | "proposal_refused"
  /** An open question stops the steps, so the command must name it with `--question`. */
  | "question_required"
  /** The queue is paused or draining, so nothing new is admitted (a `run`, or a reset of an Objective Factory has no state for). */
  | "queue_not_running"
  /** Applying the request failed (the message has the error): nothing changed; run the command again. */
  | "request_failed"
  /** A reset of this Objective is already rebuilding it. */
  | "reset_in_progress"
  /** The command writes what only the running service writes (the knowledge store): start `factory serve`. */
  | "service_not_running"
  /** The answer names a question that is no longer open: it changed, or it was answered. */
  | "stale_question"
  /** The Objective's state can't be read: answer reset or cancel. */
  | "state_unreadable"
  /** A later cancel replaced this request before it applied. */
  | "superseded"
  /** `run --provider` names a provider the running service's configuration lacks. */
  | "unknown_provider"
  /** Command line misuse: an unknown command, option or value. */
  | "usage";

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
  /** A GitHub login (`source: "github"`), else the host user who ran the CLI. */
  by: string;
  /** `github`: written for a `/factory` comment, so `by` is its author's login. Absent: the CLI. */
  source?: "github";
  request: Request;
}

export function writeRequest(
  dir: string,
  request: Request,
  by: string,
  /** A fixed id makes writing the same request twice harmless. */
  fixedId?: string,
  source?: StoredRequest["source"],
): string {
  mkdirSync(dir, { recursive: true });
  const at = new Date().toISOString();
  const id =
    fixedId ?? `${at.replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const stored: StoredRequest = {
    id,
    at,
    by,
    ...(source ? { source } : {}),
    request,
  };
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

/**
 * A pending request file: its id (the file's name), and either the
 * request it holds or why it can't be taken (`problem`): it doesn't parse,
 * or its shape isn't a request's. Checked here, where requests enter, so
 * the service trusts every `stored` it gets (stability rule 7).
 */
export type Pending =
  | { file: string; id: string; stored: StoredRequest; problem?: undefined }
  | { file: string; id: string; stored?: undefined; problem: string };

/** Pending requests, oldest first. A file that can't be read now (EIO, EACCES) is left for the next tick. */
export function pendingRequests(dir: string): Pending[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith(".json") && !name.startsWith("."))
    .sort()
    .flatMap((name): Pending[] => {
      const file = join(dir, name);
      const id = name.slice(0, -".json".length);
      let text: string;
      try {
        text = readFileSync(file, "utf8");
      } catch {
        return [];
      }
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch (error) {
        return [{ file, id, problem: `it doesn't parse: ${String(error)}` }];
      }
      const problem = requestProblem(value, id);
      return [
        problem
          ? { file, id, problem }
          : { file, id, stored: value as StoredRequest },
      ];
    });
}

const optionalText = (value: unknown): boolean =>
  value === undefined || typeof value === "string";

/** Every field a request kind reads, with its check. */
const FIELDS: Record<
  Request["kind"],
  Record<string, (value: unknown) => boolean>
> = {
  answer: {
    answer: (value) => typeof value === "string",
    arg: optionalText,
    text: optionalText,
    writtenAt: optionalText,
    question: optionalText,
    reviewArtifacts: (value) =>
      value === undefined ||
      (Array.isArray(value) && value.every((one) => typeof one === "string")),
  },
  cancel: {},
  retry: { question: optionalText },
  reset: {},
  pause: {},
  drain: {},
  resume: {},
  "propose-amendment": {},
  "decline-discovery": {
    item: (value) => typeof value === "string",
    reason: (value) => typeof value === "string",
  },
  queue: {
    mode: (value) =>
      ["running", "paused", "draining"].includes(value as string),
  },
  run: {
    provider: optionalText,
    deadline: (value) =>
      value === undefined ||
      (typeof value === "string" && Number.isFinite(Date.parse(value))),
  },
  dream: {
    write: (value) =>
      isObject(value) &&
      ["call", "end", "record", "decide"].includes(value.op as string),
  },
};

/** Why `value`, read from file `id`, isn't a stored request; undefined when it is one. */
function requestProblem(value: unknown, id: string): string | undefined {
  if (!isObject(value)) return "it isn't an object";
  if (value.id !== id) return `its id isn't its file name (${id})`;
  for (const key of ["at", "by"])
    if (typeof value[key] !== "string") return `its ${key} isn't text`;
  if (value.source !== undefined && value.source !== "github")
    return "its source isn't github";
  const request = value.request;
  if (!isObject(request)) return "its request isn't an object";
  const kind = request.kind as Request["kind"];
  const fields = Object.hasOwn(FIELDS, kind) ? FIELDS[kind] : undefined;
  if (!fields) return `its kind ${JSON.stringify(kind)} isn't a request`;
  const installationWide = kind === "queue" || kind === "dream";
  if (
    installationWide
      ? request.issue !== 0
      : !(Number.isSafeInteger(request.issue) && (request.issue as number) > 0)
  )
    return `its issue ${JSON.stringify(request.issue)} isn't ${installationWide ? "0" : "an issue number"}`;
  for (const [key, check] of Object.entries(fields))
    if (!check(request[key])) return `its ${key} isn't valid for ${kind}`;
  return undefined;
}

/**
 * Move a request that can't be taken to `rejected/`, beside the pending
 * ones, so it is never read again and stays for the operator to look at.
 */
export function rejectRequest(file: string): void {
  const rejected = join(dirname(file), "rejected");
  mkdirSync(rejected, { recursive: true });
  renameSync(file, join(rejected, basename(file)));
}

export function removeRequest(file: string): void {
  rmSync(file, { force: true });
}
