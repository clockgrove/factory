import { chmodSync, closeSync, existsSync, openSync, rmSync } from "node:fs";
import { createConnection, createServer, type Server } from "node:net";
import { join } from "node:path";
import { stateRoot } from "./config.js";
import { linuxProcessIdentity } from "./process.js";
import { type ControllerLock, readControllerOwner } from "./state-store.js";

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
const socketPath = (repository: string) =>
  join(stateRoot(repository), "control.sock");

/** One private local transport. Snapshot preconditions, not command replay, settle lost replies. */
export async function serveControl(
  repository: string,
  lock: ControllerLock,
  handle: (request: ControlRequest) => Promise<unknown>,
): Promise<Server> {
  const path = socketPath(repository);
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
  const directory = openSync(stateRoot(repository), "r");
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

export async function requestControl(
  repository: string,
  request: ControlRequest,
): Promise<{ handled: boolean; result?: unknown }> {
  const owner = readControllerOwner(
    join(stateRoot(repository), "controller.lock"),
  );
  if (!owner) return { handled: false };
  const current = linuxProcessIdentity(owner.pid);
  if (current?.startTime !== owner.startTime || current.state === "Z")
    return { handled: false };
  if (owner.objective !== request.objective && !owner.intake)
    throw new Error(`Controller is running Objective #${owner.objective}`);
  return new Promise((resolve, reject) => {
    const directory = openSync(stateRoot(repository), "r");
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
      socket.write(`${JSON.stringify({ ...request, token: owner.token })}\n`),
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
