import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

import { MAX_LOG_BYTES } from "../protocol/limits.js";
import {
  PARENT_DEATH_WATCHDOG,
  sanitizedWorkerEnvironment,
} from "./process-group.js";

export type AppServerRequestId = number | string;

export interface AppServerNotification {
  method: string;
  params?: unknown;
}

export interface AppServerRequest extends AppServerNotification {
  id: AppServerRequestId;
}

export interface AppServerExit {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
}

export interface AppServerConnection {
  readonly pid: number | null;
  readonly closed: Promise<AppServerExit>;
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
  notify(method: string, params?: unknown): void;
  respond(id: AppServerRequestId, result: unknown): void;
  respondError(id: AppServerRequestId, code: number, message: string): void;
  onNotification(listener: (event: AppServerNotification) => void): () => void;
  onRequest(listener: (request: AppServerRequest) => void): () => void;
  close(): Promise<void>;
}

export interface AppServerOptions {
  command?: string;
  args?: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  permittedSecretNames?: string[];
  attemptIdentity?: string;
  requestTimeoutMs?: number;
  cancellationGraceMs?: number;
  maxStderrBytes?: number;
}

interface JsonRpcMessage {
  id?: AppServerRequestId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

function appendBounded(current: string, chunk: Buffer, limit: number): string {
  const next = current + chunk.toString("utf8");
  if (Buffer.byteLength(next, "utf8") <= limit) return next;
  const bytes = Buffer.from(next, "utf8");
  const tail = Math.max(0, limit - 80);
  return `[output truncated to ${limit} bytes]\n${bytes.subarray(bytes.length - tail).toString("utf8")}`;
}

function terminate(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null)
    return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    // The process exited between the state check and signal delivery.
  }
}

function jsonRpcKey(id: AppServerRequestId): string {
  return `${typeof id}:${String(id)}`;
}

/**
 * Start one supervised App Server process. Factory deliberately uses one
 * process per attempt so forced cancellation can never stop a sibling worker.
 */
export function startCodexAppServer(
  options: AppServerOptions,
): AppServerConnection {
  const environment = sanitizedWorkerEnvironment(
    options.env,
    options.permittedSecretNames,
  );
  if (options.attemptIdentity) {
    environment.FACTORY_ATTEMPT_ID = options.attemptIdentity;
  }

  const executable = options.command ?? "codex";
  const executableArgs = options.args ?? ["app-server", "--stdio"];
  const command = process.platform === "win32" ? executable : "/bin/sh";
  const args =
    process.platform === "win32"
      ? executableArgs
      : [
          "-c",
          PARENT_DEATH_WATCHDOG,
          "factory-app-server-watchdog",
          String(process.pid),
          executable,
          ...executableArgs,
        ];
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: environment,
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdin = child.stdin;
  const stdout = child.stdout;
  if (!stdin || !stdout) {
    child.kill("SIGKILL");
    throw new Error("Codex App Server stdio is unavailable");
  }

  let stderr = "";
  let nextId = 0;
  let exited = false;
  let closePromise: Promise<void> | null = null;
  const pending = new Map<string, PendingRequest>();
  const notificationListeners = new Set<
    (event: AppServerNotification) => void
  >();
  const requestListeners = new Set<(request: AppServerRequest) => void>();
  const lines = createInterface({ input: stdout });

  let resolveClosed!: (exit: AppServerExit) => void;
  const closed = new Promise<AppServerExit>((resolve) => {
    resolveClosed = resolve;
  });

  const write = (message: JsonRpcMessage): void => {
    if (exited || stdin.destroyed || !stdin.writable) {
      throw new Error("Codex App Server is not writable");
    }
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  };

  const failPending = (reason: string): void => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error(reason));
    }
    pending.clear();
  };

  const settleExit = (
    exitCode: number | null,
    signal: NodeJS.Signals | null,
    error?: Error,
  ): void => {
    if (exited) return;
    exited = true;
    lines.close();
    const detail = error?.message || stderr.trim();
    failPending(
      detail ? `Codex App Server exited: ${detail}` : "Codex App Server exited",
    );
    resolveClosed({ exitCode, signal, stderr });
  };

  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = appendBounded(
      stderr,
      chunk,
      options.maxStderrBytes ?? MAX_LOG_BYTES,
    );
  });
  child.once("error", (error) => settleExit(null, null, error));
  child.once("exit", (exitCode, signal) => settleExit(exitCode, signal));
  stdin.on("error", (error) =>
    failPending(`Codex App Server stdin failed: ${error.message}`),
  );

  lines.on("line", (line) => {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      return;
    }
    if (message.method && message.id !== undefined) {
      const request = {
        id: message.id,
        method: message.method,
        ...(message.params === undefined ? {} : { params: message.params }),
      };
      if (requestListeners.size === 0) {
        try {
          write({
            id: message.id,
            error: {
              code: -32601,
              message: "Factory does not support this server request",
            },
          });
        } catch {
          // Process exit will settle all client requests.
        }
        return;
      }
      for (const listener of requestListeners) listener(request);
      return;
    }
    if (message.id !== undefined) {
      const request = pending.get(jsonRpcKey(message.id));
      if (!request) return;
      pending.delete(jsonRpcKey(message.id));
      clearTimeout(request.timer);
      if (message.error) {
        request.reject(
          new Error(
            `Codex App Server request failed${message.error.code === undefined ? "" : ` (${message.error.code})`}: ${message.error.message ?? "unknown error"}`,
          ),
        );
      } else {
        request.resolve(message.result);
      }
      return;
    }
    if (message.method) {
      const notification = {
        method: message.method,
        ...(message.params === undefined ? {} : { params: message.params }),
      };
      for (const listener of notificationListeners) listener(notification);
    }
  });

  return {
    pid: child.pid ?? null,
    closed,
    request<T>(method: string, params?: unknown): Promise<T> {
      const id = ++nextId;
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(jsonRpcKey(id));
          reject(new Error(`Codex App Server request timed out: ${method}`));
        }, options.requestTimeoutMs ?? 30_000);
        pending.set(jsonRpcKey(id), {
          resolve: resolve as (value: unknown) => void,
          reject,
          timer,
        });
        try {
          write({ id, method, ...(params === undefined ? {} : { params }) });
        } catch (error) {
          pending.delete(jsonRpcKey(id));
          clearTimeout(timer);
          reject(error);
        }
      });
    },
    notify(method: string, params?: unknown): void {
      write({ method, ...(params === undefined ? {} : { params }) });
    },
    respond(id: AppServerRequestId, result: unknown): void {
      write({ id, result });
    },
    respondError(id: AppServerRequestId, code: number, message: string): void {
      write({ id, error: { code, message } });
    },
    onNotification(listener): () => void {
      notificationListeners.add(listener);
      return () => notificationListeners.delete(listener);
    },
    onRequest(listener): () => void {
      requestListeners.add(listener);
      return () => requestListeners.delete(listener);
    },
    async close(): Promise<void> {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        if (exited) return;
        terminate(child, "SIGTERM");
        const grace = options.cancellationGraceMs ?? 2_000;
        const stopped = await Promise.race([
          closed.then(() => true),
          new Promise<false>((resolve) =>
            setTimeout(() => resolve(false), grace),
          ),
        ]);
        if (!stopped) {
          terminate(child, "SIGKILL");
          await closed;
        }
      })();
      return closePromise;
    },
  };
}
