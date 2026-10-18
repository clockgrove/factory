import { chmodSync, closeSync, existsSync, openSync, rmSync } from "node:fs";
import { createConnection, createServer, type Server } from "node:net";
import { join } from "node:path";
import { type QueueControlBinding, stateRoot } from "./config.js";
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
  liveObjectiveOwners,
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
    | "project-queue"
    /** Upgrade drain: the service dispatches nothing new; active runs finish. */
    | "finish";
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
            (!owner.intake &&
              request.objective !== owner.objective &&
              !forwardedQueueCommand(request))
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
 * A foreground `factory run` owns only its Objective. Queue commands reach it
 * (see requestForegroundQueueControl); other installation commands wait for it.
 */
export class ForegroundControllerError extends Error {
  constructor(readonly objective: number) {
    super(
      // Objective 0 is a queue command holding the installation for a moment.
      objective === 0
        ? "A factory queue command is running; run this again in a moment"
        : `Controller is running Objective #${objective} in the foreground; \`factory status --objective ${objective}\` shows it, and this command works once it ends`,
    );
  }
}

/**
 * A Project queue command a foreground Objective owner executes for the
 * installation: with no service, the live foreground owners are the
 * installation's controllers, so one of them owns the change and its durable
 * acknowledgment, as the service would.
 */
function forwardedQueueCommand(request: ControlRequest): boolean {
  return request.objective === 0 && request.action === "project-queue";
}

/**
 * Send a Project queue command to the lowest-numbered live foreground owner
 * whose identity names the command's queue `binding`: any provider's run of
 * the same installation queue. The owner authenticates the binding again.
 * `handled: false` means nothing was sent: no foreground owner remains, or the
 * service now owns the installation, so the caller resolves its owner again.
 */
export async function requestForegroundQueueControl(
  repository: string,
  request: ControlRequest,
  options: {
    deadlineAt: number;
    onAcknowledgment?: (value: unknown) => void;
    binding: QueueControlBinding;
  },
): Promise<{ handled: boolean; result?: unknown }> {
  if (!forwardedQueueCommand(request) || !request.command)
    throw new Error("Only a bounded Project queue command reaches a run");
  const waitUntil = Date.now() + ENDPOINT_WAIT_MS;
  for (;;) {
    if (
      !Number.isFinite(options.deadlineAt) ||
      options.deadlineAt <= Date.now()
    )
      throw new ControllerCommandIncompleteError(
        request.command.id,
        "not-sent",
        options.deadlineAt,
      );
    if (liveControllerOwner(installationLockPath(repository)))
      return { handled: false };
    const owners = liveObjectiveOwners(repository);
    if (!owners.length) return { handled: false };
    const owner = owners.find(
      (entry) =>
        entry.queue?.authorityDigest === options.binding.authorityDigest &&
        entry.queue.configDigest === options.binding.configDigest,
    );
    if (!owner) {
      const named = (entries: typeof owners) =>
        entries.map((entry) => `Objective #${entry.objective}`).join(", ");
      const unbound = owners.filter((entry) => !entry.queue);
      const other = owners.filter((entry) => entry.queue);
      throw new Error(
        [
          ...(other.length
            ? [
                `${named(other)} run${other.length === 1 ? "s" : ""} with other shared settings than this command (such as the Project, autonomy or queue settings); run this once one of them ends`,
              ]
            : []),
          ...(unbound.length
            ? [
                `${named(unbound)} ${unbound.length === 1 ? "does" : "do"} not execute queue commands (started by an older release or not a foreground run); restart it or wait for it to end`,
              ]
            : []),
        ].join("; ") +
          ". No foreground run can execute this queue command; nothing was sent",
      );
    }
    currentProcessSignal()?.throwIfAborted();
    const reply = await sendControl(
      objectiveRoot(repository, owner.objective),
      owner,
      request,
      options,
    );
    if (reply) return reply;
    if (Date.now() >= waitUntil)
      throw new ControllerCommandIncompleteError(
        request.command.id,
        "not-sent",
        options.deadlineAt,
        new Error(
          `Controller pid ${owner.pid} still owns Objective #${owner.objective} without a control endpoint; run this again once it serves control or exits`,
        ),
      );
    await new Promise((resolve) => setTimeout(resolve, 100));
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
  // A starting or exiting owner holds its record without an endpoint (#1486).
  // Nothing was sent, so wait briefly and resolve the owner again: the owned
  // path opens only once no live owner remains.
  const waitUntil = Date.now() + ENDPOINT_WAIT_MS;
  for (;;) {
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
    currentProcessSignal()?.throwIfAborted();
    const reply = await sendControl(directoryPath, owner, request, options);
    if (reply) return reply;
    if (options && Date.now() >= options.deadlineAt)
      throw new ControllerCommandIncompleteError(
        request.command?.id,
        "not-sent",
        options.deadlineAt,
      );
    if (Date.now() >= waitUntil) {
      const error = new Error(
        `Controller pid ${owner.pid} still owns ${owner.intake || !owner.objective ? "this installation" : `Objective #${owner.objective}`} without a control endpoint; run this again once it exits`,
      );
      throw request.command
        ? new ControllerCommandIncompleteError(
            request.command.id,
            "not-sent",
            options?.deadlineAt,
            error,
          )
        : error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** How long a command waits for a live owner's missing endpoint. */
const ENDPOINT_WAIT_MS = 30_000;

/** One connection to `owner`; undefined when its endpoint is absent and nothing was sent. */
function sendControl(
  directoryPath: string,
  expectedOwner: NonNullable<ReturnType<typeof liveControllerOwner>>,
  request: ControlRequest,
  options?: { deadlineAt: number; onAcknowledgment?: (value: unknown) => void },
): Promise<{ handled: true; result?: unknown } | undefined> {
  const token = expectedOwner.token;
  const signal = currentProcessSignal();
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
    const finish = (error?: unknown, result?: unknown, absent = false) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      closeDirectory();
      socket.destroy();
      if (error) reject(error);
      else resolve(absent ? undefined : { handled: true, result });
    };
    const incomplete = () =>
      new ControllerCommandIncompleteError(
        request.command?.id,
        submitted ? "unknown" : "not-sent",
        options?.deadlineAt,
      );
    // The deadline ends a probe the same way whether its timer or a late
    // connection observes it first.
    const expired = () =>
      request.action === "readiness"
        ? new ControllerReadinessPendingError("deadline")
        : incomplete();
    const abort = () => finish(incomplete());
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    if (options)
      timer = setTimeout(
        () => finish(expired()),
        Math.max(0, options.deadlineAt - Date.now()),
      );
    socket.once("connect", closeDirectory);
    socket.once("error", closeDirectory);
    let body = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      if (settled || signal?.aborted) return finish(incomplete());
      if (options && Date.now() >= options.deadlineAt) return finish(expired());
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
    socket.on("error", (error: NodeJS.ErrnoException) => {
      const absent = ["ENOENT", "ECONNREFUSED"].includes(error.code ?? "");
      if (absent && !submitted && request.action !== "readiness")
        return finish(undefined, undefined, true);
      finish(
        request.action === "readiness" && absent
          ? new ControllerReadinessPendingError("endpoint-unavailable")
          : request.command
            ? incomplete()
            : error,
      );
    });
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
