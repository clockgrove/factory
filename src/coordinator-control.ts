import { chmodSync, closeSync, existsSync, openSync, rmSync } from "node:fs";
import { createConnection, createServer, type Server } from "node:net";
import { join } from "node:path";
import { stateRoot } from "./config.js";
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
    | "dequeue"
    | "enqueue"
    | "watch";
  input?: Record<string, unknown>;
}
/**
 * One private local transport in the owner's directory: the installation's
 * for the service, the Objective's for a foreground run. Snapshot
 * preconditions, not command replay, settle lost replies.
 */
export async function serveControl(
  repository: string,
  lock: ControllerLock,
  handle: (request: ControlRequest) => Promise<unknown>,
  objective?: number,
): Promise<Server> {
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
        try {
          const request = JSON.parse(body.slice(0, body.indexOf("\n")));
          if (request.token !== lock.token)
            throw new Error("Controller owner changed");
          const result = await handle(request);
          socket.end(`${JSON.stringify({ result })}\n`);
        } catch (error) {
          socket.end(
            `${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`,
          );
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
): Promise<{ handled: boolean; result?: unknown }> {
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
  return new Promise((resolve, reject) => {
    const directory = openSync(directoryPath, "r");
    const socket = createConnection(`/proc/self/fd/${directory}/control.sock`);
    let directoryOpen = true;
    const closeDirectory = () => {
      if (directoryOpen) {
        directoryOpen = false;
        closeSync(directory);
      }
    };
    socket.once("connect", closeDirectory);
    socket.once("error", closeDirectory);
    let body = "";
    socket.setEncoding("utf8");
    socket.on("connect", () =>
      socket.write(`${JSON.stringify({ ...request, token })}\n`),
    );
    socket.on("data", (part) => {
      body += part;
    });
    socket.on("error", reject);
    socket.on("end", () => {
      try {
        const reply = JSON.parse(body);
        if (reply.error) throw new Error(reply.error);
        resolve({ handled: true, result: reply.result });
      } catch (error) {
        reject(error);
      }
    });
  });
}
