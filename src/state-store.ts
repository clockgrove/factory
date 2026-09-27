import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { stateRoot } from "./config.js";
import { linuxProcessIdentity } from "./process.js";
import { parseFactoryState, type FactoryState } from "./state.js";

export function statePath(repository: string, objective: number): string {
  return join(
    stateRoot(repository),
    "objectives",
    String(objective),
    "state.json",
  );
}

export function saveState(path: string, state: FactoryState): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(state, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
  const directory = openSync(dirname(path), "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

export function readState(
  repository: string,
  objective: number,
): FactoryState | undefined {
  const path = statePath(repository, objective);
  if (!existsSync(path)) return undefined;
  try {
    const state = parseFactoryState(
      JSON.parse(readFileSync(path, "utf8")),
      repository,
      objective,
    );
    const root = resolve(stateRoot(repository));
    for (const [id, work] of Object.entries(state.work)) {
      if (!work.execution) continue;
      if (work.execution.provider !== "local") continue;
      const active = work.execution.data as {
        worktree?: unknown;
      };
      if (
        typeof active.worktree !== "string" ||
        !resolve(active.worktree).startsWith(`${join(root, "worktrees")}${sep}`)
      )
        throw new Error(
          `Work Item ${id} attempt worktree is outside Factory state`,
        );
    }
    return state;
  } catch (error) {
    throw new Error(
      `Invalid Factory state at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export interface ControllerLock {
  fd: number;
  token: string;
}

export interface ControllerOwner {
  pid: number;
  startTime: string;
  objective: number;
  token: string;
}

export function readControllerOwner(path: string): ControllerOwner | undefined {
  if (!existsSync(path)) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(
      "Controller lock is unreadable; operator direction required",
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Controller lock is invalid; operator direction required");
  const owner = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(owner.pid) ||
    Number(owner.pid) <= 0 ||
    typeof owner.startTime !== "string" ||
    !Number.isSafeInteger(owner.objective) ||
    typeof owner.token !== "string"
  )
    throw new Error(
      "Controller lock identity is invalid; operator direction required",
    );
  return owner as unknown as ControllerOwner;
}

export function acquireControllerLock(
  path: string,
  objective: number,
): ControllerLock {
  const previous = readControllerOwner(path);
  if (previous) {
    const current = linuxProcessIdentity(previous.pid);
    if (current?.startTime === previous.startTime && current.state !== "Z")
      throw new Error("A Factory controller already owns this installation");
    rmSync(path);
  }
  const fd = openSync(path, "wx", 0o600);
  const identity = linuxProcessIdentity(process.pid);
  if (!identity) {
    closeSync(fd);
    rmSync(path, { force: true });
    throw new Error("Cannot establish controller process identity");
  }
  const token = randomUUID();
  writeFileSync(
    fd,
    JSON.stringify({
      pid: process.pid,
      startTime: identity.startTime,
      token,
      objective,
    }),
  );
  fsyncSync(fd);
  return { fd, token };
}

export function releaseControllerLock(
  path: string,
  lock: ControllerLock,
): void {
  closeSync(lock.fd);
  const current = readControllerOwner(path);
  if (current?.token === lock.token) rmSync(path);
}
