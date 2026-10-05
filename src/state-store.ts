import { assertRepairLedger } from "./repair-policy.js";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { stateRoot, validateCapacity } from "./config.js";
import {
  linuxProcessIdentity,
  processAlive,
  releaseGuard,
  takeGuard,
} from "./process.js";
import {
  assertRepeats,
  assertWait,
  type RepeatRecord,
  type Wait,
} from "./fault.js";
import { assertPlanningExecutionBounds } from "./contracts.js";
import {
  assertCoordinator,
  type ContinuationState,
  type FactoryState,
  type PreparationState,
  parseFactoryState,
} from "./state.js";

/** An Objective's private directory: its snapshot, owner and validation trees. */
export function objectiveRoot(repository: string, objective: number): string {
  return join(stateRoot(repository), "objectives", String(objective));
}

export function statePath(repository: string, objective: number): string {
  return join(objectiveRoot(repository, objective), "state.json");
}

/**
 * What an Objective's steps recorded before its state file exists: the run's
 * repeat records and the wait, so `factory status` can report an outage or a
 * question that has no state to live in. The state file replaces it.
 */
export interface PreState {
  repeats?: Record<string, RepeatRecord>;
  wait?: Wait;
}

export function preStatePath(repository: string, objective: number): string {
  return join(dirname(statePath(repository, objective)), "pre-state.json");
}

/** Record the pre-state steps' records; none left removes the file. */
export function writePreState(
  repository: string,
  objective: number,
  record: PreState,
): void {
  const path = preStatePath(repository, objective);
  const repeats = Object.keys(record.repeats ?? {}).length
    ? record.repeats
    : undefined;
  if (!repeats && !record.wait) {
    rmSync(path, { force: true });
    return;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(
      fd,
      `${JSON.stringify({ repeats, wait: record.wait }, null, 2)}\n`,
    );
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
}

/** The pre-state record, if one exists and is valid; status never fails on it. */
export function readPreState(
  repository: string,
  objective: number,
): PreState | undefined {
  try {
    const value = JSON.parse(
      readFileSync(preStatePath(repository, objective), "utf8"),
    );
    assertRepeats(value.repeats, "repeats");
    assertWait(value.wait, "wait");
    return { repeats: value.repeats, wait: value.wait };
  } catch {
    return undefined;
  }
}

/**
 * Write a snapshot atomically. It is validated exactly as a load validates
 * it first, so no write can persist state a later run would refuse.
 */
export function saveState(path: string, state: ContinuationState): void {
  const text = `${JSON.stringify(state, null, 2)}\n`;
  try {
    parseContinuation(JSON.parse(text), state.repository, state.objective);
  } catch (error) {
    throw new Error(
      `Refusing to save invalid Factory state: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, text);
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

const currentVersion = (value: unknown): boolean => {
  const version = (value as { schemaVersion?: unknown } | null)?.schemaVersion;
  return version === 7 || version === 8;
};

/** Every Objective (or preparation) directory whose snapshot an earlier version wrote. */
function earlierVersionDirectories(repository: string): string[] {
  const root = join(stateRoot(repository), "objectives");
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((name) => /^\d+$/.test(name))
    .sort((left, right) => Number(left) - Number(right))
    .map((name) => join(root, name))
    .filter((directory) => {
      const path = join(directory, "state.json");
      if (!existsSync(path)) return false;
      try {
        return !currentVersion(JSON.parse(readFileSync(path, "utf8")));
      } catch {
        return false;
      }
    });
}

/** Pre-release: state from an earlier Factory version is never migrated. */
function assertCurrentVersion(
  repository: string,
  path: string,
  value: unknown,
): void {
  if (currentVersion(value)) return;
  const found = earlierVersionDirectories(repository);
  refuseEarlierVersion(found.length ? found : [dirname(path)]);
}

/** A new Objective does not start beside state an earlier version wrote. */
export function assertNoEarlierVersion(repository: string): void {
  const found = earlierVersionDirectories(repository);
  if (found.length) refuseEarlierVersion(found);
}

function refuseEarlierVersion(directories: string[]): never {
  throw new Error(
    `State from an earlier Factory version: ${directories.join(", ")}. v0.2.0 starts fresh: run \`factory supervisor uninstall\` (add \`--config PATH\` unless it is the default configuration), then \`rm -r ${directories.map((directory) => (/^[\w@%+=:,./-]+$/.test(directory) ? directory : `'${directory.replaceAll("'", "'\\''")}'`)).join(" ")}\` (this leaves worktrees and open PRs from that state in place), or finish them with the old version first`,
  );
}

export function readContinuation(
  repository: string,
  objective: number,
): ContinuationState | undefined {
  const path = statePath(repository, objective);
  if (!existsSync(path)) return undefined;
  const value = JSON.parse(readFileSync(path, "utf8"));
  assertCurrentVersion(repository, path, value);
  if (value.schemaVersion !== 8) return readState(repository, objective);
  return parsePreparation(value, repository, objective);
}

/** Validate a current-version snapshot of either kind. */
function parseContinuation(
  value: ContinuationState,
  repository: string,
  objective: number,
): ContinuationState {
  return value.schemaVersion === 8
    ? parsePreparation(value, repository, objective)
    : parseExecution(value, repository, objective);
}

function parsePreparation(
  value: PreparationState,
  repository: string,
  objective: number,
): PreparationState {
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
          !value.plan?.graph?.items?.some(
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
  if (
    value.changedSincePlanning !== undefined &&
    value.changedSincePlanning !== true
  )
    throw new Error("Invalid preparation change flag");
  if (
    value.issueAuthor !== undefined &&
    (typeof value.issueAuthor !== "string" || !value.issueAuthor)
  )
    throw new Error("Invalid preparation issue author");
  if (
    value.plan?.review?.acceptable !== undefined &&
    (value.plan.review.acceptable !== false ||
      value.plan.review.status !== "needs-human")
  )
    throw new Error("Invalid preparation plan acceptability");
  // Factory derives execution bounds from configuration; an authored shape it
  // never writes is refused when parsed, not judged as a plan.
  if (value.plan?.executionBounds !== undefined)
    assertPlanningExecutionBounds(value.plan.executionBounds);
  assertCoordinator(value.coordinator);
  validateCapacity(value.capacity);
  assertRepairLedger(value);
  assertRepeats(value.repeats, "repeats");
  assertWait(value.wait, "wait");
  return value as PreparationState;
}

export function readState(
  repository: string,
  objective: number,
): FactoryState | undefined {
  const path = statePath(repository, objective);
  if (!existsSync(path)) return undefined;
  const value = JSON.parse(readFileSync(path, "utf8"));
  assertCurrentVersion(repository, path, value);
  try {
    return parseExecution(value, repository, objective);
  } catch (error) {
    throw new Error(
      `Invalid Factory state at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function parseExecution(
  value: unknown,
  repository: string,
  objective: number,
): FactoryState {
  const state = parseFactoryState(value, repository, objective);
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

/** The installation's owner: the background service, or a queue command for a moment. */
export function installationLockPath(repository: string): string {
  return join(stateRoot(repository), "controller.lock");
}

/** One Objective's owner: a foreground run, or a command changing that Objective. */
export function objectiveLockPath(
  repository: string,
  objective: number,
): string {
  return join(objectiveRoot(repository, objective), "controller.lock");
}

/** The recorded owner, while that exact process is alive. */
export function liveControllerOwner(path: string): ControllerOwner | undefined {
  const owner = readControllerOwner(path);
  return owner && processAlive(owner) ? owner : undefined;
}

/** A live owner of any one Objective. */
export function liveObjectiveOwner(
  repository: string,
): ControllerOwner | undefined {
  const root = join(stateRoot(repository), "objectives");
  if (!existsSync(root)) return undefined;
  for (const name of readdirSync(root)) {
    if (!/^\d+$/.test(name)) continue;
    const owner = liveControllerOwner(
      objectiveLockPath(repository, Number(name)),
    );
    if (owner) return owner;
  }
  return undefined;
}

/**
 * Own the installation: refused while any Objective has a live owner. Both
 * kinds of owner are taken under the installation's guard, so neither can
 * start beside the other.
 */
export function acquireInstallationLock(
  repository: string,
  objective = 0,
): ControllerLock {
  return acquireControllerLock(installationLockPath(repository), objective, {
    conflict: () => {
      const owner = liveObjectiveOwner(repository);
      return owner && `Objective #${owner.objective}`;
    },
  });
}

/**
 * Own one Objective: refused while the installation has a live owner (the
 * service answers for every Objective). Owners of different Objectives run
 * side by side.
 */
export function acquireObjectiveLock(
  repository: string,
  objective: number,
): ControllerLock {
  mkdirSync(objectiveRoot(repository, objective), {
    recursive: true,
    mode: 0o700,
  });
  const installation = installationLockPath(repository);
  return acquireControllerLock(
    objectiveLockPath(repository, objective),
    objective,
    {
      guard: `${installation}.acquire`,
      owned: `Objective #${objective}`,
      conflict: () =>
        liveControllerOwner(installation) ? "this installation" : undefined,
    },
  );
}

export function acquireControllerLock(
  path: string,
  objective: number,
  /** What `path` owns, and what another live owner that excludes it owns. */
  scope: {
    guard?: string;
    owned?: string;
    conflict?: () => string | undefined;
  } = {},
): ControllerLock {
  // Serialize stale-owner replacement as well as creation (a crashed holder's
  // guard is reclaimed by takeGuard); never remove a contender's newly
  // acquired lock.
  const guard = scope.guard ?? `${path}.acquire`;
  takeGuard(guard);
  try {
    const owned = liveControllerOwner(path)
      ? (scope.owned ?? "this installation")
      : scope.conflict?.();
    if (owned) throw new Error(`A Factory controller already owns ${owned}`);
    rmSync(path, { force: true });
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
    releaseGuard(guard);
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
