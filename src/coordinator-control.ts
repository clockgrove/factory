import { chmodSync, closeSync, existsSync, openSync, rmSync } from "node:fs";
import { createConnection, createServer, type Server } from "node:net";
import { join } from "node:path";
import { stateRoot } from "./config.js";
import {
  currentProcessDeadlineAt,
  currentProcessSignal,
  withProcessCancellation,
} from "./process.js";
import {
  type ControllerLock,
  installationLockPath,
  liveControllerOwner,
  liveObjectiveOwner,
  objectiveLockPath,
  objectiveRoot,
} from "./state-store.js";

export interface ControlRequest {
  objective: number;
  action:
    | "status"
    | "readiness"
    | "pause"
    | "drain"
    | "handoff"
    | "resume"
    | "cancel"
    | "repair"
    | "retry"
    | "rereview"
    | "decide"
    | "select"
    | "propose-amendment"
    | "decline-discovery"
    | "dequeue"
    | "enqueue"
    | "watch"
    | "project-queue";
  input?: Record<string, unknown>;
  /** One finite caller operation; loss of its reply never authorizes replay. */
  command?: { id: string; deadlineAt: number };
}
export interface ControlContext {
  signal: AbortSignal;
  deadlineAt?: number;
  acknowledge(value: unknown): void;
}
/** A queue command whose retained operations completed before its caller's deadline. */
export interface ReturnedQueueCommand {
  commandId: string;
  operations: { id: string; action: string; objective?: number }[];
  /** The journal shows no pending change and an acknowledgment when the deadline surfaced. */
  acknowledged: boolean;
  /** The actual archive journal when the deadline surfaced, never a log. */
  durability: {
    status: string;
    pendingChanges: boolean;
    unsyncedSince?: string;
    attemptedTransportOutcome?: string;
    lastAcknowledged?: { commitSha: string; sequence: number };
    error?: string;
  };
}
export class ControllerCommandIncompleteError extends Error {
  /** Known returned Project effect; the caller still failed before durable acknowledgment. */
  returned?: ReturnedQueueCommand;
  constructor(
    readonly requestId: string | undefined,
    readonly submission: "not-sent" | "unknown",
    readonly deadlineAt: number | undefined,
    cause?: unknown,
  ) {
    super(
      `Controller command ${requestId ?? "unidentified"} is incomplete; submission ${submission}. Inspect retained status before another mutation`,
      { cause },
    );
    this.name = "ControllerCommandIncompleteError";
  }
}
export interface ControllerReadiness {
  protocol: "controller-readiness-v1";
  owner: { pid: number; startTime: string; objective: number; intake: boolean };
}
/** A read-only readiness probe ended before the endpoint was ready. */
export class ControllerReadinessPendingError extends Error {
  constructor(readonly reason: "endpoint-unavailable" | "deadline") {
    super("Controller readiness is not yet established");
    this.name = "ControllerReadinessPendingError";
  }
}
/**
 * One private local transport in the owner's directory: the installation's
 * for the service, the Objective's for a foreground run. Snapshot
 * preconditions, not command replay, settle lost replies.
 */
export async function serveControl(
  repository: string,
  lock: ControllerLock,
  handle: (
    request: ControlRequest,
    context: ControlContext,
  ) => Promise<unknown>,
  objective?: number,
): Promise<Server> {
  const inheritedSignal = currentProcessSignal();
  const inheritedDeadline = inheritedSignal
    ? currentProcessDeadlineAt()
    : undefined;
  const directoryPath = objective
    ? objectiveRoot(repository, objective)
    : stateRoot(repository);
  const path = join(directoryPath, "control.sock");
  if (existsSync(path)) rmSync(path);
  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    let body = "";
    socket.on("data", (part) => {
      body += part;
      if (!body.includes("\n")) return;
      socket.removeAllListeners("data");
      void (async () => {
        const cancellation = new AbortController();
        const signal = inheritedSignal
          ? AbortSignal.any([inheritedSignal, cancellation.signal])
          : cancellation.signal;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let completed = false;
        let admittedRequest: ControlRequest | undefined;
        const disconnected = () => {
          if (!completed)
            cancellation.abort(
              new Error(
                "Controller command caller disconnected; outcome remains unknown",
              ),
            );
        };
        socket.once("close", disconnected);
        try {
          const request = JSON.parse(body.slice(0, body.indexOf("\n")));
          admittedRequest = request;
          if (request.token !== lock.token)
            throw new Error("Controller owner changed");
          const owner = liveControllerOwner(
            objective
              ? objectiveLockPath(repository, objective)
              : installationLockPath(repository),
          );
          if (
            !owner ||
            owner.token !== lock.token ||
            owner.pid !== process.pid ||
            (!owner.intake && request.objective !== owner.objective)
          )
            throw new Error("Controller command owner changed");
          if (
            request.command &&
            (typeof request.command?.id !== "string" ||
              !/^[a-f0-9-]{36}$/.test(request.command?.id) ||
              !Number.isFinite(request.command.deadlineAt) ||
              Object.keys(request.command).some(
                (key) => !["id", "deadlineAt"].includes(key),
              ))
          )
            throw new Error("Invalid finite controller command binding");
          const deadlines = [
            request.command?.deadlineAt,
            inheritedDeadline ? Date.parse(inheritedDeadline) : undefined,
          ].filter((value): value is number => value !== undefined);
          const deadlineAt = deadlines.length
            ? Math.min(...deadlines)
            : undefined;
          signal.throwIfAborted();
          if (deadlineAt !== undefined) {
            if (deadlineAt <= Date.now())
              throw new ControllerCommandIncompleteError(
                request.command?.id,
                "not-sent",
                deadlineAt,
              );
            timer = setTimeout(
              () =>
                cancellation.abort(
                  new ControllerCommandIncompleteError(
                    request.command?.id,
                    "unknown",
                    deadlineAt,
                  ),
                ),
              Math.max(1, deadlineAt - Date.now()),
            );
          }
          const context: ControlContext = {
            signal,
            deadlineAt,
            acknowledge(value) {
              signal.throwIfAborted();
              if (deadlineAt !== undefined && Date.now() >= deadlineAt)
                throw new ControllerCommandIncompleteError(
                  request.command?.id,
                  "unknown",
                  deadlineAt,
                );
              socket.write(
                `${JSON.stringify({ acknowledgment: value, requestId: request.command?.id, owner: { pid: owner.pid, startTime: owner.startTime } })}\n`,
              );
            },
          };
          let result: unknown;
          if (request.action === "readiness") {
            const owner = liveControllerOwner(
              objective
                ? objectiveLockPath(repository, objective)
                : installationLockPath(repository),
            );
            if (
              !owner ||
              owner.token !== lock.token ||
              owner.pid !== process.pid ||
              (!owner.intake && request.objective !== owner.objective)
            )
              throw new Error("Controller readiness owner changed");
            result = {
              protocol: "controller-readiness-v1",
              owner: {
                pid: owner.pid,
                startTime: owner.startTime,
                objective: owner.objective,
                intake: owner.intake === true,
              },
            } satisfies ControllerReadiness;
          } else
            result = await withProcessCancellation(
              signal,
              () => handle(request, context),
              undefined,
              deadlineAt === undefined
                ? undefined
                : new Date(deadlineAt).toISOString(),
            );
          signal.throwIfAborted();
          if (deadlineAt !== undefined && Date.now() >= deadlineAt)
            throw new ControllerCommandIncompleteError(
              request.command?.id,
              "unknown",
              deadlineAt,
            );
          completed = true;
          socket.end(
            `${JSON.stringify({ result, requestId: request.command?.id, owner: { pid: owner.pid, startTime: owner.startTime } })}\n`,
          );
        } catch (error) {
          socket.end(
            `${JSON.stringify({ error: error instanceof Error ? error.message : String(error), ...(admittedRequest?.command && (signal.aborted || Date.now() >= admittedRequest.command.deadlineAt) ? { incomplete: { requestId: admittedRequest.command.id, deadlineAt: admittedRequest.command.deadlineAt, submission: "unknown" } } : {}) })}\n`,
          );
        } finally {
          if (timer) clearTimeout(timer);
          socket.off("close", disconnected);
        }
      })();
    });
    socket.on("error", () => undefined);
  });
  const directory = openSync(directoryPath, "r");
  let directoryOpen = true;
  const closeDirectory = () => {
    if (directoryOpen) {
      directoryOpen = false;
      closeSync(directory);
    }
  };
  // libuv retains this literal pathname and unlinks it when the native listener
  // closes. Keep its directory descriptor bound until that unlink has finished.
  server.once("close", closeDirectory);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(`/proc/self/fd/${directory}/control.sock`, () => {
        try {
          chmodSync(path, 0o600);
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
  } catch (error) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDirectory();
    throw error;
  }
  return server;
}

/**
 * A foreground `factory run` owns only its Objective, and the queue waits for it. The message
 * names the command that does work meanwhile.
 */
export class ForegroundControllerError extends Error {
  constructor(readonly objective: number) {
    super(
      // Objective 0 is a queue command holding the installation for a moment.
      objective === 0
        ? "A factory queue command is running; run this again in a moment"
        : `Controller is running Objective #${objective} in the foreground; \`factory status --objective ${objective}\` shows it, and queue commands work once it ends`,
    );
  }
}

export async function requestControl(
  repository: string,
  request: ControlRequest,
  options?: { deadlineAt: number; onAcknowledgment?: (value: unknown) => void },
): Promise<{ handled: boolean; result?: unknown }> {
  if (
    options &&
    (!Number.isFinite(options.deadlineAt) || options.deadlineAt <= Date.now())
  ) {
    if (request.action === "readiness")
      throw new ControllerReadinessPendingError("deadline");
    throw new ControllerCommandIncompleteError(
      request.command?.id,
      "not-sent",
      options.deadlineAt,
    );
  }
  if (request.action === "readiness") {
    if (!options || !Number.isFinite(options.deadlineAt))
      throw new Error("Controller readiness requires an absolute deadline");
    if (options.deadlineAt <= Date.now())
      throw new ControllerReadinessPendingError("deadline");
  }
  // The service answers for every Objective; otherwise an Objective's own owner does.
  let owner = liveControllerOwner(installationLockPath(repository));
  let directoryPath = stateRoot(repository);
  if (owner) {
    if (owner.objective !== request.objective && !owner.intake)
      throw new ForegroundControllerError(owner.objective);
  } else if (request.objective) {
    owner = liveControllerOwner(
      objectiveLockPath(repository, request.objective),
    );
    directoryPath = objectiveRoot(repository, request.objective);
  } else {
    const foreground = liveObjectiveOwner(repository);
    if (foreground) throw new ForegroundControllerError(foreground.objective);
  }
  if (!owner) return { handled: false };
  const token = owner.token;
  const expectedOwner = owner;
  const signal = currentProcessSignal();
  signal?.throwIfAborted();
  const ownerPath = join(directoryPath, "controller.lock");
  return new Promise((resolve, reject) => {
    const directory = openSync(directoryPath, "r");
    let socket: ReturnType<typeof createConnection>;
    try {
      socket = createConnection(`/proc/self/fd/${directory}/control.sock`);
    } catch (error) {
      closeSync(directory);
      reject(error);
      return;
    }
    let directoryOpen = true;
    const closeDirectory = () => {
      if (directoryOpen) {
        directoryOpen = false;
        closeSync(directory);
      }
    };
    let settled = false;
    let submitted = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: unknown, result?: unknown) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      closeDirectory();
      socket.destroy();
      if (error) reject(error);
      else resolve({ handled: true, result });
    };
    const incomplete = () =>
      new ControllerCommandIncompleteError(
        request.command?.id,
        submitted ? "unknown" : "not-sent",
        options?.deadlineAt,
      );
    const abort = () => finish(incomplete());
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    if (options)
      timer = setTimeout(
        () =>
          finish(
            request.action === "readiness"
              ? new ControllerReadinessPendingError("deadline")
              : incomplete(),
          ),
        Math.max(0, options.deadlineAt - Date.now()),
      );
    socket.once("connect", closeDirectory);
    socket.once("error", closeDirectory);
    let body = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      if (
        settled ||
        signal?.aborted ||
        (options && Date.now() >= options.deadlineAt)
      )
        return finish(incomplete());
      submitted = true;
      socket.write(`${JSON.stringify({ ...request, token })}\n`);
    });
    const authenticateReply = (reply: {
      owner?: { pid: number; startTime: string };
      requestId?: string;
    }) => {
      const current = liveControllerOwner(ownerPath);
      if (
        !current ||
        current.token !== token ||
        current.pid !== expectedOwner.pid ||
        current.startTime !== expectedOwner.startTime ||
        reply.owner?.pid !== current.pid ||
        reply.owner?.startTime !== current.startTime ||
        reply.requestId !== request.command?.id
      )
        throw new Error(
          "Controller response changed its live owner or command binding",
        );
    };
    let terminalReply:
      | {
          result?: unknown;
          error?: string;
          incomplete?: {
            requestId: string;
            deadlineAt: number;
            submission: string;
          };
          owner?: { pid: number; startTime: string };
          requestId?: string;
        }
      | undefined;
    socket.on("data", (part) => {
      body += part;
      try {
        while (body.includes("\n")) {
          const newline = body.indexOf("\n");
          const frame = JSON.parse(body.slice(0, newline));
          body = body.slice(newline + 1);
          if (terminalReply)
            throw new Error("Controller returned multiple terminal replies");
          if ("acknowledgment" in frame) {
            authenticateReply(frame);
            options?.onAcknowledgment?.(frame.acknowledgment);
          } else terminalReply = frame;
        }
      } catch (error) {
        finish(error);
      }
    });
    socket.on("error", (error: NodeJS.ErrnoException) =>
      finish(
        request.action === "readiness" &&
          ["ENOENT", "ECONNREFUSED"].includes(error.code ?? "")
          ? new ControllerReadinessPendingError("endpoint-unavailable")
          : request.command
            ? incomplete()
            : error,
      ),
    );
    socket.on("end", () => {
      try {
        const reply = terminalReply;
        if (!reply || body.trim()) throw incomplete();
        if (reply.incomplete) {
          if (
            reply.incomplete.requestId !== request.command?.id ||
            reply.incomplete.deadlineAt !== request.command?.deadlineAt ||
            reply.incomplete.submission !== "unknown"
          )
            throw new Error(
              "Controller incomplete receipt changed its command binding",
            );
          throw incomplete();
        }
        if (reply.error) throw new Error(reply.error);
        authenticateReply(reply);
        if (request.action === "readiness") {
          const current = liveControllerOwner(ownerPath);
          const ready = reply.result as ControllerReadiness | undefined;
          if (
            !current ||
            current.token !== token ||
            current.pid !== expectedOwner.pid ||
            current.startTime !== expectedOwner.startTime ||
            ready?.protocol !== "controller-readiness-v1" ||
            ready.owner?.pid !== current.pid ||
            ready.owner.startTime !== current.startTime ||
            ready.owner.intake !== (current.intake === true) ||
            ready.owner.objective !== current.objective ||
            !Number.isSafeInteger(ready.owner.objective) ||
            ready.owner.objective < 0 ||
            Object.keys(ready).some(
              (key) => !["protocol", "owner"].includes(key),
            ) ||
            Object.keys(ready.owner).some(
              (key) =>
                !["pid", "startTime", "objective", "intake"].includes(key),
            )
          )
            throw new Error(
              "Controller readiness response changed its live owner",
            );
        }
        finish(undefined, reply.result);
      } catch (error) {
        finish(error);
      }
    });
    socket.on("close", () => {
      if (!settled) finish(incomplete());
    });
  });
}
