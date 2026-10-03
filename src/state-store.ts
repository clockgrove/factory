import { assertRepairLedger } from "./repair-policy.js";
import { validateAuthority } from "./admission.js";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { stateRoot } from "./config.js";
import { linuxProcessIdentity } from "./process.js";
import {
  assertCoordinator,
  assertPermanentAbandonmentBinding,
  type ContinuationState,
  type FactoryState,
  type PreparationState,
  parseFactoryState,
} from "./state.js";

export function statePath(repository: string, objective: number): string {
  return join(
    stateRoot(repository),
    "objectives",
    String(objective),
    "state.json",
  );
}

export function saveState(path: string, state: ContinuationState): void {
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

export function readContinuation(
  repository: string,
  objective: number,
): ContinuationState | undefined {
  const path = statePath(repository, objective);
  if (!existsSync(path)) return undefined;
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (value.schemaVersion !== 5) return readState(repository, objective);
  if (
    value.kind !== "preparing" ||
    value.repository !== repository ||
    value.objective !== objective ||
    typeof value.runId !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.configDigest) ||
    !/^[a-f0-9]{40}$/.test(value.baseSha) ||
    !/^[a-f0-9]{64}$/.test(value.objectiveBodyDigest) ||
    !value.coordinator ||
    !["running", "paused", "draining"].includes(value.coordinator.mode) ||
    typeof value.coordinator.phase !== "string" ||
    !Number.isFinite(Date.parse(value.coordinator.phaseStartedAt)) ||
    !value.issueByItemId ||
    typeof value.issueByItemId !== "object" ||
    Array.isArray(value.issueByItemId) ||
    Object.values(value.issueByItemId).some(
      (id) => !Number.isSafeInteger(id) || Number(id) <= 0,
    ) ||
    new Set(Object.values(value.issueByItemId)).size !==
      Object.keys(value.issueByItemId).length ||
    Object.values(value.issueByItemId).includes(objective) ||
    (!value.plan && Object.keys(value.issueByItemId).length !== 0) ||
    (value.plan &&
      Object.keys(value.issueByItemId).some(
        (id) =>
          !value.plan.graph?.items?.some(
            (item: { id: string }) => item.id === id,
          ),
      ))
  )
    throw new Error(
      "Invalid preparation snapshot; operator direction required",
    );
  if (
    value.sourcePacketDigest !== undefined &&
    !/^[a-f0-9]{64}$/.test(value.sourcePacketDigest)
  )
    throw new Error("Invalid preparation source packet binding");
  assertCoordinator(value.coordinator);
  assertPermanentAbandonmentBinding(value);
  if (value.authority) validateAuthority(value.authority);
  assertRepairLedger(value);
  return value as PreparationState;
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
  intake?: boolean;
  pid: number;
  startTime: string;
  objective: number;
  token: string;
}

export function readControllerOwner(path: string): ControllerOwner | undefined {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return undefined;
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
  // Serialize stale-owner replacement as well as creation. A crashed guard is
  // refused explicitly; never remove a contender's newly acquired lock.
  const guard = `${path}.acquire`;
  mkdirSync(guard, { mode: 0o700 });
  try {
    const previous = readControllerOwner(path);
    if (previous) {
      const current = linuxProcessIdentity(previous.pid);
      if (current?.startTime === previous.startTime && current.state !== "Z")
        throw new Error("A Factory controller already owns this installation");
      rmSync(path);
    }
    const identity = linuxProcessIdentity(process.pid);
    if (!identity)
      throw new Error("Cannot establish controller process identity");
    const token = randomUUID();
    const temporary = `${path}.${randomUUID()}.tmp`;
    const fd = openSync(temporary, "wx", 0o600);
    try {
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
      // Publish a complete identity atomically without replacing another owner.
      // Readers do not take the acquisition guard and must never see this write.
      linkSync(temporary, path);
      return { fd, token };
    } catch (error) {
      closeSync(fd);
      throw error;
    } finally {
      rmSync(temporary, { force: true });
    }
  } finally {
    rmdirSync(guard);
  }
}

/** Retarget the same installation lease without permitting another owner between Objectives. */
export function retargetControllerLock(
  path: string,
  lock: ControllerLock,
  objective: number,
): void {
  const current = readControllerOwner(path);
  const identity = linuxProcessIdentity(process.pid);
  if (
    !current ||
    current.token !== lock.token ||
    current.pid !== process.pid ||
    current.startTime !== identity?.startTime
  )
    throw new Error("Installation owner changed before Objective selection");
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify({ ...current, objective, intake: true }));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
}

export function releaseControllerLock(
  path: string,
  lock: ControllerLock,
): void {
  closeSync(lock.fd);
  const current = readControllerOwner(path);
  if (current?.token === lock.token) rmSync(path);
}
