import { collectedLocalWorkerSessionSettled } from "./execution/checkpoint.js";
import { isDeepStrictEqual } from "node:util";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { LocalContentStore } from "./content/local.js";
import type { ContentRef } from "./contracts.js";
import { decodeAccountingRecord } from "./accounting.js";
import {
  pinnedGit,
  pinnedGitCommand,
  pinnedGitEnvironment,
} from "./process.js";
import {
  adoptRecoveryCheckpointBaseline,
  readVerifiedRecoveryCheckpoint,
  recoveryCheckpointClosureDigest,
  withRecoveryCheckpointScope,
} from "./recovery-checkpoint.js";
import { assertGraphProjectionIntents } from "./graph-projection-control.js";
import { assertObjectiveSplitRecord } from "./objective-split.js";
import { assertPlanningLookupRecord } from "./compiler/context.js";
import {
  assertRepositoryMemoryBindings,
  retainStateMemory,
} from "./repository-memory.js";
import { createHash, randomUUID } from "node:crypto";
import { markCheckpointDirty } from "./recovery-checkpoint.js";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readdirSync,
  realpathSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep, relative } from "node:path";
import { assertAgentSessions } from "./agent-session.js";
import {
  stateRoot,
  validateCapacity,
  factoryConfigDigest,
  factoryAuthorityDigest,
  type FactoryConfig,
} from "./config.js";
import {
  ARCHIVED_EVIDENCE,
  recordRetirement,
  terminalContinuation,
} from "./checkpoint-retention.js";
import {
  assertApprovedPlaybookPin,
  assertPlanningExecutionBounds,
} from "./contracts.js";
import {
  assertRepeats,
  assertWait,
  type RepeatRecord,
  type Wait,
} from "./fault.js";
import {
  assertGitHubProgressProjection,
  assertLiveStatusRecord,
} from "./github-progress-state.js";
import { assertGitHubProjectStatusProjection } from "./github-project-state.js";
import {
  linuxProcessIdentity,
  processAlive,
  releaseGuard,
  takeGuard,
} from "./process.js";
import { assertRepairLedger } from "./repair-policy.js";
import {
  assertCoordinator,
  assertStateWorkflowRecipe,
  isPreparationState,
  isExecutionState,
  type ContinuationState,
  type FactoryState,
  type PreparationState,
  parseFactoryState,
  assertContinuationRestoration,
  type ContinuationRestoration,
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

function preStatePath(repository: string, objective: number): string {
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
    markCheckpointDirty(repository, { path, kind: "pre-state" });
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
  const directory = openSync(dirname(path), "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
  markCheckpointDirty(repository, { path, kind: "pre-state" });
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
export function saveState(
  path: string,
  state: ContinuationState,
  options?: { observeMemory?: boolean },
): void {
  let text = `${JSON.stringify(state, null, 2)}\n`;
  try {
    parseContinuation(JSON.parse(text), state.repository, state.objective);
  } catch (error) {
    throw new Error(
      `Refusing to save invalid Factory state: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  // Memory observes validated state. Availability never changes lifecycle evidence.
  try {
    const observed =
      options?.observeMemory === false
        ? []
        : retainStateMemory(state, stateRoot(state.repository));
    assertRepositoryMemoryBindings(observed);
    const merged = [...(state.memoryBindings ?? [])];
    const ids = new Set(merged.map((binding) => binding.id));
    for (const binding of observed) {
      if (ids.has(binding.id)) continue;
      ids.add(binding.id);
      merged.push(binding);
    }
    if (merged.length) {
      const retained = { ...state, memoryBindings: merged };
      const retainedText = `${JSON.stringify(retained, null, 2)}\n`;
      parseContinuation(
        JSON.parse(retainedText),
        state.repository,
        state.objective,
      );
      state.memoryBindings = merged;
      text = retainedText;
    }
  } catch {
    process.stderr.write("Factory repository memory unavailable\n");
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
  markCheckpointDirty(state.repository, { path, kind: "continuation" });
}

const currentVersion = (value: unknown): boolean => {
  const state = value as ContinuationState | null;
  return isPreparationState(state) || isExecutionState(state);
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
    `State from an unsupported Factory version: ${directories.join(", ")}. Preserve the original state and owned resources; use the compatible Factory version and supported lifecycle recovery before starting another run`,
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
  if (!isPreparationState(value))
    return parseExecutionAtPath(value, repository, objective, path);
  return parsePreparation(value, repository, objective);
}

/**
 * The Objective, and Work Item, a GitHub issue number names in this
 * installation's own state; GitHub is not read. An Objective's issue number is
 * its own; a Work Item's is in its Objective's `issueByItemId`.
 */
export function resolveIssue(
  repository: string,
  issue: number,
): { objective: number; item?: string } {
  if (existsSync(statePath(repository, issue))) return { objective: issue };
  const root = join(stateRoot(repository), "objectives");
  const unreadable: number[] = [];
  for (const name of existsSync(root) ? readdirSync(root) : []) {
    if (!/^[1-9][0-9]*$/.test(name)) continue;
    let state: ContinuationState | undefined;
    try {
      state = readContinuation(repository, Number(name));
    } catch {
      unreadable.push(Number(name));
      continue;
    }
    const item = Object.entries(state?.issueByItemId ?? {}).find(
      ([, number]) => number === issue,
    )?.[0];
    if (item) return { objective: Number(name), item };
  }
  throw new Error(
    `Issue #${issue} is not an Objective or Work Item with state in this installation${unreadable.length ? `; Objective state ${unreadable.map((n) => `#${n}`).join(", ")} could not be read` : ""}. A queued Objective that has not started: factory status --objective ${issue}`,
  );
}

/** Validate a current-version snapshot of either kind. */
function parseContinuation(
  value: ContinuationState,
  repository: string,
  objective: number,
): ContinuationState {
  return isPreparationState(value)
    ? parsePreparation(value, repository, objective)
    : parseExecution(value, repository, objective);
}

/** Authenticate historical bytes without importing their paths as live ownership. */
export function parsePortableContinuation(
  value: unknown,
  repository: string,
  objective: number,
): ContinuationState {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Portable continuation must be an original snapshot");
  const state = value as ContinuationState;
  return isPreparationState(state)
    ? parsePreparation(state, repository, objective)
    : parseFactoryState(value, repository, objective);
}

function parsePreparation(
  value: PreparationState,
  repository: string,
  objective: number,
): PreparationState {
  assertContinuationRestoration(value);
  if (value.memoryBindings !== undefined)
    assertRepositoryMemoryBindings(value.memoryBindings);
  const lookup = value.planningRecovery?.contextLookup;
  if (lookup !== undefined) {
    if (
      value.schemaVersion !== 10 &&
      value.schemaVersion !== 12 &&
      value.schemaVersion !== 14 &&
      value.schemaVersion !== 16 &&
      ![18, 20].includes(value.schemaVersion)
    )
      throw new Error(
        "Adaptive context requires preparation schema version 10",
      );
    assertPlanningLookupRecord(lookup);
  }
  if (value.plan) {
    const conditional = !!value.plan.graph.conditions?.length;
    const expanded = !!value.plan.graph.expansions?.length;
    const adaptive =
      value.plan.contextLookup !== undefined ||
      value.plan.graph.items.some((item) => item.kind === "discovery");
    if (
      (value.workflowRecipePin
        ? value.plan.schemaVersion !== 7
        : conditional
          ? value.plan.schemaVersion !== 6
          : expanded
            ? value.plan.schemaVersion !== 5
            : adaptive !== (value.plan.schemaVersion === 4)) ||
      (value.schemaVersion === 8 && adaptive) ||
      (value.schemaVersion === 10 && value.plan.schemaVersion !== 4) ||
      (value.schemaVersion === 12 && value.plan.schemaVersion !== 5) ||
      (value.schemaVersion === 14 && value.plan.schemaVersion !== 6) ||
      (value.schemaVersion === 16 && value.plan.schemaVersion !== 7) ||
      (conditional &&
        value.schemaVersion !== 14 &&
        value.schemaVersion !== 16 &&
        ![18, 20].includes(value.schemaVersion)) ||
      (expanded &&
        value.schemaVersion !== 12 &&
        value.schemaVersion !== 14 &&
        value.schemaVersion !== 16 &&
        ![18, 20].includes(value.schemaVersion))
    )
      throw new Error(
        "Preparation plan schema differs from adaptive semantics",
      );
    if (
      value.plan.contextLookup !== undefined &&
      (lookup === undefined ||
        JSON.stringify(value.plan.contextLookup) !==
          JSON.stringify(lookup.packet))
    )
      throw new Error(
        "Preparation plan context differs from retained lookup evidence",
      );
  }
  assertGraphProjectionIntents(value);
  assertObjectiveSplitRecord(value);
  assertGitHubProgressProjection(value.githubProgress, value);
  assertLiveStatusRecord(value.githubLiveStatus);
  assertGitHubProjectStatusProjection(value.githubProjectStatus, value);
  if (
    (value.schemaVersion !== 8 &&
      value.schemaVersion !== 10 &&
      value.schemaVersion !== 12 &&
      value.schemaVersion !== 14 &&
      value.schemaVersion !== 16 &&
      ![18, 20].includes(value.schemaVersion)) ||
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
  assertApprovedPlaybookPin(value.approvedPlaybookPin);
  if (
    value.plan &&
    JSON.stringify(value.plan.approvedPlaybookPin) !==
      JSON.stringify(value.approvedPlaybookPin)
  )
    throw new Error("Preparation plan advisory selection differs");
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
  assertStateWorkflowRecipe(value);
  assertCoordinator(value.coordinator);
  assertAgentSessions(value);
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
  return parseExecutionAtPath(value, repository, objective, path);
}

function parseExecutionAtPath(
  value: unknown,
  repository: string,
  objective: number,
  path: string,
): FactoryState {
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
      (!state.restoration &&
        !resolve(active.worktree).startsWith(
          `${join(root, "worktrees")}${sep}`,
        ))
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

interface ControllerOwner {
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

/** The installation lock this process holds while it decides a stopped Objective. */
let installationMutation: ControllerLock | undefined;

/**
 * Run `task` as the live installation owner deciding one of its stopped
 * Objectives (#1290): within it, that owner's own lock does not exclude the
 * Objective's lock, so the service applies the decision itself.
 */
export async function asInstallationOwner<T>(
  lock: ControllerLock,
  task: () => Promise<T>,
): Promise<T> {
  if (installationMutation)
    throw new Error("Another installation-owner decision is in progress");
  installationMutation = lock;
  try {
    return await task();
  } finally {
    installationMutation = undefined;
  }
}

/**
 * Own one Objective: refused while the installation has a live owner (the
 * service answers for every Objective), except that owner itself deciding
 * a stopped Objective. Owners of different Objectives run side by side.
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
      conflict: () => {
        const owner = liveControllerOwner(installation);
        const self =
          owner?.pid === process.pid &&
          owner.token === installationMutation?.token;
        return owner && !self ? "this installation" : undefined;
      },
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

/** An explicit rebind verifies the frozen configuration; no digest is rewritten. */
export function continuationConfigurationMatches(
  state: ContinuationState,
  config: FactoryConfig,
): boolean {
  if (state.repository !== config.repository) return false;
  const receipt = state.restoration;
  if (!receipt) return state.configDigest === factoryConfigDigest(config);
  try {
    assertContinuationRestoration(state);
    return (
      receipt.original.configDigest === receipt.source.configDigest &&
      receipt.source.authorityDigest === factoryAuthorityDigest(config) &&
      receipt.installation.authorityDigest === factoryAuthorityDigest(config) &&
      receipt.installation.configDigest === factoryConfigDigest(config) &&
      receipt.installation.checkout === config.checkout &&
      receipt.installation.stateRoot === stateRoot(config.repository) &&
      factoryConfigDigest({ ...config, checkout: receipt.source.checkout }) ===
        state.configDigest
    );
  } catch {
    return false;
  }
}
export function assertRestoredContinuationReady(
  state: ContinuationState,
  config: FactoryConfig,
): void {
  if (!state.restoration) return;
  if (
    state.restoration.status !== "reconciled" ||
    !continuationConfigurationMatches(state, config)
  )
    throw new Error(
      "Restored continuation requires supported inspection and ownership reconciliation; foreign process absence does not establish cessation",
    );
}

/**
 * Foreign resources remain fenced by retained authority, never destination PID absence.
 * The source-host operator may authenticate an exact collected worker receipt;
 * restoration never permits that exception to the portable ownership proof.
 */
export function restoredContinuationOwnershipHold(
  state: ContinuationState,
  sourceHostCollectedWorkers = false,
  collectingLocalItem?: string,
): string | undefined {
  return continuationOwnershipHold(
    state,
    false,
    false,
    sourceHostCollectedWorkers,
    collectingLocalItem,
  );
}

/** Outcome uncertainty remains historical after permanent cancellation and positive scope disposal. */
export function cancelledContinuationResourceHold(
  state: ContinuationState,
): string | undefined {
  if (
    !state.cancelRequested ||
    !state.cancelledAt ||
    state.coordinator?.cancelError ||
    (isExecutionState(state) && state.finalAcceptance)
  )
    return "Cancellation is not permanently terminal and unaccepted";
  assertAgentSessions(state);
  const sessions = [
    ...Object.values(state.agentSessions ?? {}),
    ...(state.agentSessionHistory ?? []),
  ];
  if (
    sessions.some(
      (ref) =>
        ref.status !== "released" ||
        (ref.currentTurn && ref.currentTurn.resources !== "settled"),
    )
  )
    return "Cancellation requires positive disposal of every native scope";
  const diagnoses = isExecutionState(state)
    ? Object.values(state.work).flatMap((work) => [
        work.recovery?.diagnosisInvocation,
        ...(work.recovery?.history ?? []).map(
          (entry) => entry.diagnosisInvocation,
        ),
      ])
    : [];
  if (
    diagnoses.some(
      (invocation) =>
        invocation?.submitted && invocation.response === undefined,
    ) &&
    !sessions.some(
      (ref) =>
        ref.scope.role === "planning" &&
        ref.scope.repository === state.repository &&
        ref.scope.objective === state.objective &&
        ref.scope.runId === state.runId &&
        ref.scope.configDigest === state.configDigest &&
        ref.currentTurn?.resources === "settled",
    )
  )
    return "Unresolved diagnosis has no disposed same-run planning scope";
  if (
    isExecutionState(state) &&
    Object.values(state.work).some(
      (work) =>
        work.status === "running" ||
        (work.status === "published" &&
          (!work.pullRequest || !work.changeRef || !work.treeSha)),
    )
  )
    return "Cancellation retains active or unresolved Work Item ownership";
  return continuationOwnershipHold(
    state,
    true,
    Boolean(state.planningRecovery?.cancelledResources),
  );
}

function continuationOwnershipHold(
  state: ContinuationState,
  cancelledDiagnosis = false,
  cancelledPlanning = false,
  sourceHostCollectedWorkers = false,
  collectingLocalItem?: string,
): string | undefined {
  // Only the explicit stopped source-host collector supplies this scope,
  // after authenticating its completed original. Every other current and
  // historical resource follows the unchanged ownership walk.
  const collecting =
    sourceHostCollectedWorkers &&
    !state.restoration &&
    isExecutionState(state) &&
    collectingLocalItem
      ? state.work[collectingLocalItem]
      : undefined;
  const collectingExecution =
    collecting?.execution?.provider === "local"
      ? collecting.execution
      : undefined;
  const collectingRequest = (
    collectingExecution?.data as
      | { request?: import("./contracts.js").ExecutionRequest }
      | undefined
  )?.request;
  if (Object.values(state.repeats ?? {}).some((record) => record.inFlight))
    return "Retained paid call has no recorded settlement";
  if (state.coordinator?.processes?.length)
    return "Recorded controller subprocess ownership requires source-host reconciliation";
  for (const ref of [
    ...Object.values(state.agentSessions ?? {}),
    ...(state.agentSessionHistory ?? []),
  ]) {
    if (
      collectingExecution &&
      collectingRequest?.session &&
      Object.values(state.agentSessions ?? {}).includes(ref) &&
      ref.currentTurn === undefined &&
      ref.scope.role === "implementation" &&
      ref.executionIdentity === collectingExecution.identity &&
      ref.identity === collectingRequest.session.identity &&
      isDeepStrictEqual(ref.scope, collectingRequest.session.scope)
    )
      continue;
    if (
      ref.status === "in-flight" ||
      (ref.status === "ready" &&
        !(
          sourceHostCollectedWorkers &&
          !state.restoration &&
          isExecutionState(state) &&
          ref.scope.role === "implementation" &&
          collectedLocalWorkerSessionSettled(
            state.work[ref.scope.itemId]?.execution,
            ref,
          )
        ) &&
        (!ref.currentTurn?.terminal ||
          ref.currentTurn.resources !== "settled")) ||
      (ref.currentTurn && ref.currentTurn.resources !== "settled")
    )
      return "Foreign native session ownership is not portable or authoritatively settled";
  }
  const planning = state.planningRecovery;
  if (
    !cancelledPlanning &&
    planning?.phase === "submitted" &&
    planning.response === undefined &&
    !planning.invocations?.some(
      (entry) => entry.id === planning.invocation?.id && entry.resultDigest,
    )
  )
    return "Submitted planning invocation has no authenticated settlement";
  if (isPreparationState(state)) return undefined;
  if (
    !cancelledDiagnosis &&
    Object.values(state.work).some((work) =>
      work.recovery?.history?.some(
        (entry) =>
          entry.diagnosisInvocation?.submitted &&
          entry.diagnosisInvocation.response === undefined,
      ),
    )
  )
    return "Historical submitted diagnosis has no authenticated settlement";
  for (const work of Object.values(state.work).flatMap((work) => [
    work,
    ...(work.recovery?.history ?? []).map((entry) => entry.work),
  ])) {
    if (work.execution) {
      if (
        !["local", "openai-agents", "claude-managed-agents"].includes(
          work.execution.provider,
        )
      )
        return "Foreign execution adapter has no supported portable settlement contract";
      const data = work.execution.data as Record<string, unknown> | undefined;
      if (
        work !== collecting &&
        !data?.result &&
        !data?.rejectedCollection &&
        data?.stopped === undefined
      )
        return "Foreign execution ownership lacks an authenticated terminal collection or cessation receipt";
    }
    const recovery = (work as import("./state.js").WorkState).recovery;
    if (
      !cancelledDiagnosis &&
      recovery?.diagnosisInvocation?.submitted &&
      recovery.diagnosisInvocation.response === undefined
    )
      return "Submitted work diagnosis invocation has no authenticated settlement";
    if ((work.status === "running" && !work.execution) || work.branchUpdateFrom)
      return "Work retains an unresolved execution or delivery effect";
  }
  for (const amendment of [
    state.pendingAmendment,
    ...(state.rejectedAmendments ?? []),
  ]) {
    if (
      (amendment?.planningInvocation &&
        amendment.planningInvocation.response === undefined) ||
      (amendment?.reviewInvocation &&
        amendment.reviewInvocation.response === undefined)
    )
      return "Submitted amendment invocation has no authenticated settlement";
  }
  if (
    Object.values(state.stackNumbers ?? {}).some(
      (value) => typeof value !== "number" && value.disposition !== "observed",
    ) ||
    Object.values(state.stackMerges ?? {}).some((value) => !value.uuid)
  )
    return "Native publication or merge submission remains unresolved";
  if (
    Object.values(state.publicationIntents ?? {})
      .flat()
      .some(
        (intent) =>
          intent.effects?.some((effect) => effect.disposition === "intent") ||
          (!intent.observation &&
            intent.submission === "possibly-submitted" &&
            !intent.admissionBlockedAt),
      )
  )
    return "Publication submission remains unresolved";
  if (
    !state.cancelledAt &&
    Object.values(state.graphProjectionIntents ?? {}).some((intent) =>
      intent.effects.some(
        (effect) => !effect.observation && effect.admission !== "blocked",
      ),
    )
  )
    return "Graph projection submission remains unresolved";
  return undefined;
}

/** Install verified typed originals; no adapter, provider, queue or process is activated. */
export async function restoreRecoveryCheckpoint(args: {
  config: FactoryConfig;
  checkpoint?: string;
}): Promise<{
  checkpoint: string;
  payloadDigest: string;
  disposition: "inspection" | "reconciliation-required";
  objectives: {
    objective: number;
    runId: string;
    disposition: "held";
    reason: string;
  }[];
  memoryRecords: number;
  learningRecords: number;
  catalog: "ready" | "unavailable";
  pendingSync: boolean;
}> {
  const { config } = args;
  const { installExactMemoryLearning } = await import(
    "./repository-memory-transfer.js"
  );
  const { parseQueueRecord, authenticateQueueOwnerReferences } = await import(
    "./project-queue-state.js"
  );
  const assertProjectQueueWriteReceipt: typeof import("./github-project-queue.js").assertProjectQueueWriteReceipt =
    (await import("./github-project-queue.js")).assertProjectQueueWriteReceipt;
  const { proposalPersistenceReferences } = await import("./proposals.js");
  const { verifyContinuationReferenceClosure } = await import(
    "./recovery-checkpoint-closure.js"
  );
  const privateRoot = stateRoot(config.repository);
  mkdirSync(privateRoot, { recursive: true, mode: 0o700 });
  if (
    !lstatSync(privateRoot).isDirectory() ||
    realpathSync(privateRoot) !== resolve(privateRoot)
  )
    throw new Error(
      "Recovery installation root must be a real private directory",
    );
  const lock = acquireInstallationLock(config.repository);
  let staging: string | undefined;
  try {
    const checkpoint = await readVerifiedRecoveryCheckpoint(
      config,
      args.checkpoint,
    );
    const source = checkpoint.manifest.authority;
    if (source && source.authorityDigest !== factoryAuthorityDigest(config))
      throw new Error(
        "Recovery checkpoint semantic authority differs from the current configuration",
      );
    const bytes = new Map<string, Buffer>();
    const key = (ref: ContentRef) =>
      JSON.stringify([ref.digest, ref.bytes, ref.mediaType]);
    for (const ref of [
      ...checkpoint.manifest.files.map((file) => file.ref),
      ...checkpoint.manifest.contentRefs,
    ])
      if (!bytes.has(key(ref)))
        bytes.set(
          key(ref),
          Buffer.from(await checkpoint.readVerifiedBlob(ref)),
        );
    const readBytes = async (ref: ContentRef) => {
      const data = bytes.get(key(ref));
      if (!data)
        throw new Error(
          "Required original reference is absent from the verified checkpoint closure",
        );
      return data;
    };
    const replicaFiles: typeof checkpoint.manifest.files = [];
    const originals: {
      state: ContinuationState;
      ref: ContentRef;
      /** The evidence commit of a retired terminal Objective. */
      retired: string | undefined;
    }[] = [];
    const gitObjects = new Map<string, { sha: string; kind: string }>();
    for (const file of checkpoint.manifest.files) {
      if (file.kind === "continuation") {
        const match = /^objectives\/([1-9][0-9]*)\/state\.json$/.exec(
          file.path,
        );
        if (!match)
          throw new Error(
            "Recovery continuation path is outside its exact Objective identity",
          );
        const state = parsePortableContinuation(
          JSON.parse((await readBytes(file.ref)).toString("utf8")),
          config.repository,
          Number(match[1]),
        );
        // A retired terminal Objective keeps only its snapshot; its evidence
        // is in the archive history at the recorded commit (#1307).
        const archived = terminalContinuation(state)
          ? checkpoint.manifest.gaps.find(
              (gap) =>
                gap.path === file.path &&
                gap.availability === ARCHIVED_EVIDENCE &&
                gap.required === false &&
                typeof gap.evidenceCommit === "string",
            )
          : undefined;
        const retired = archived?.evidenceCommit;
        if (!retired) {
          const closure = await verifyContinuationReferenceClosure(
            state,
            { readBytes },
            config.gitPersistence,
          );
          if (closure.gaps.some((gap) => gap.required !== false))
            throw new Error(
              "Recovery continuation has an unresolved required original",
            );
          for (const object of closure.gitObjects)
            gitObjects.set(`${object.kind}:${object.sha}`, object);
        }
        const current = readContinuation(config.repository, state.objective);
        if (
          current &&
          (!current.restoration ||
            current.restoration.status !== "held" ||
            current.restoration.original.snapshot.digest !== file.ref.digest ||
            current.restoration.checkpoint.payloadDigest !==
              checkpoint.payloadDigest)
        )
          throw new Error(
            "Recovery would replace an existing or changed continuation; inspection requires its original installation",
          );
        if (current) {
          const { restoration: _currentReceipt, ...currentFields } = current;
          const { restoration: _sourceReceipt, ...sourceFields } = state;
          currentFields.schemaVersion = state.schemaVersion;
          if (!isDeepStrictEqual(currentFields, sourceFields))
            throw new Error(
              "Restored continuation changed after installation; preserve its exact local history",
            );
        }
        originals.push({ state, ref: file.ref, retired });
      } else if (file.path.startsWith("accounting/")) {
        decodeAccountingRecord(
          config.repository,
          file.path,
          await readBytes(file.ref),
        );
        replicaFiles.push(file);
      } else if (
        file.kind === "historical" &&
        /^project-queue-history\/[a-f0-9-]{36}\.json$/.test(file.path)
      ) {
        const record = parseQueueRecord(
          await readBytes(file.ref),
          config.repository,
          file.path.split("/")[1]!.slice(0, -5),
        );
        if (record.kind === "project-queue-operation")
          for (const effect of record.effects) {
            if (effect.original)
              assertProjectQueueWriteReceipt({
                ...effect.receipt,
                original: JSON.parse(
                  (await readBytes(effect.original)).toString("utf8"),
                ),
              });
            if (effect.rejectedOriginal)
              await readBytes(effect.rejectedOriginal);
          }
        else await authenticateQueueOwnerReferences(record, readBytes);
        replicaFiles.push(file);
      } else if (
        file.kind === "historical" &&
        /^proposals\/[a-f0-9-]{36}\.json$/.test(file.path)
      ) {
        const description = proposalPersistenceReferences(
          await readBytes(file.ref),
          config.repository,
          file.path.split("/")[1]!.slice(0, -5),
          (ref) => {
            const data = bytes.get(key(ref));
            if (!data)
              throw new Error(
                "Required proposal original is absent from the verified closure",
              );
            return data;
          },
        );
        gitObjects.set(`commit:${description.baseSha}`, {
          sha: description.baseSha,
          kind: "commit",
        });
        replicaFiles.push(file);
      } else if (file.kind === "pre-state") {
        const value = JSON.parse((await readBytes(file.ref)).toString("utf8"));
        assertRepeats(value.repeats, "repeats");
        assertWait(value.wait, "wait");
        if (!/^objectives\/[1-9][0-9]*\/pre-state\.json$/.test(file.path))
          throw new Error(
            "Recovery pre-state path is outside its Objective identity",
          );
        replicaFiles.push(file);
      }
    }
    for (const object of checkpoint.manifest.gitObjects ?? [])
      gitObjects.set(`commit:${object.commitSha}`, {
        sha: object.commitSha,
        kind: "commit",
      });
    // Authenticate the entire pack in an isolated Git object database before installing any live record.
    const packs = checkpoint.manifest.files.filter(
      (file) => file.kind === "git-pack",
    );
    if (gitObjects.size && !packs.length)
      throw new Error("Recovery source Git objects have no retained pack");
    if (packs.length) {
      staging = mkdtempSync(join(tmpdir(), "factory-restore-"));
      execFileSync("git", ["init", "--bare", staging], {
        env: pinnedGitEnvironment(),
        stdio: "pipe",
      });
      for (const file of packs) {
        const command = pinnedGitCommand(staging, ["index-pack", "--stdin"]);
        execFileSync("git", command.args, {
          env: command.env,
          input: await readBytes(file.ref),
          timeout: config.gitPersistence?.timeoutMs,
          stdio: ["pipe", "pipe", "pipe"],
        });
      }
      for (const object of gitObjects.values())
        if (pinnedGit(staging, "cat-file", "-t", object.sha) !== object.kind)
          throw new Error("Recovery source Git object has the wrong type");
      pinnedGit(config.checkout, "rev-parse", "--git-dir");
    }
    // Refuse mutable path conflicts before canonical replicas or operational snapshots are installed.
    for (const file of replicaFiles) {
      assertRecoveryReplicaPath(
        join(stateRoot(config.repository), file.path),
        stateRoot(config.repository),
      );
      const path = join(stateRoot(config.repository), file.path);
      if (
        existsSync(path) &&
        (!lstatSync(path).isFile() ||
          !readFileSync(path).equals(await readBytes(file.ref)))
      )
        throw new Error(
          "Recovery immutable accounting path conflicts with an existing original",
        );
    }
    const root = stateRoot(config.repository);
    for (const entry of originals)
      assertRecoveryReplicaPath(
        statePath(config.repository, entry.state.objective),
        root,
      );
    const store = new LocalContentStore(join(root, "content"));
    for (const ref of [
      ...checkpoint.manifest.files.map((file) => file.ref),
      ...checkpoint.manifest.contentRefs,
    ])
      store.putBytes(await readBytes(ref), { mediaType: ref.mediaType });
    const archive = store.putBytes(checkpoint.manifestBytes, {
      mediaType: "application/json",
    });
    if (archive.digest !== checkpoint.payloadDigest)
      throw new Error(
        "Restoration archive fingerprint differs from its verified payload",
      );
    for (const file of packs) {
      const command = pinnedGitCommand(config.checkout, [
        "index-pack",
        "--stdin",
      ]);
      execFileSync("git", command.args, {
        env: command.env,
        input: await readBytes(file.ref),
        timeout: config.gitPersistence?.timeoutMs,
        stdio: ["pipe", "pipe", "pipe"],
      });
    }
    const memory = await installExactMemoryLearning({
      repository: config.repository,
      root,
      access: {
        repository: config.repository,
        visibility: ["private", "repository"],
      },
      files: checkpoint.manifest.files,
      contentRefs: [
        ...checkpoint.manifest.contentRefs,
        ...checkpoint.manifest.files.map((file) => file.ref),
      ],
      readVerifiedBlob: readBytes,
    });
    for (const file of replicaFiles) {
      const path = join(root, file.path);
      if (!existsSync(path)) {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        const temporary = `${path}.${randomUUID()}.tmp`;
        const fd = openSync(temporary, "wx", 0o600);
        try {
          writeFileSync(fd, await readBytes(file.ref));
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        try {
          linkSync(temporary, path);
        } finally {
          rmSync(temporary, { force: true });
        }
      }
    }
    const objectives: {
      objective: number;
      runId: string;
      disposition: "held";
      reason: string;
    }[] = [];
    for (const { state, ref, retired } of originals) {
      // Continuations travel only in private-history, whose manifest always
      // carries its publisher authority.
      const authority = source!;
      const previous = readContinuation(
        config.repository,
        state.objective,
      )?.restoration;
      const receipt: ContinuationRestoration = {
        schemaVersion: 1,
        checkpoint: {
          commitSha: checkpoint.commitSha,
          payloadDigest: checkpoint.payloadDigest,
        },
        archive,
        original: {
          snapshot: ref,
          configDigest: state.configDigest,
          schemaVersion: state.schemaVersion,
        },
        source:
          state.restoration &&
          state.restoration.installation.configDigest ===
            authority.configDigest &&
          state.restoration.installation.checkout ===
            authority.hostLayout.checkout &&
          state.restoration.installation.authorityDigest ===
            authority.authorityDigest &&
          state.restoration.source.authorityDigest ===
            authority.authorityDigest &&
          factoryConfigDigest({
            ...config,
            checkout: authority.hostLayout.checkout,
          }) === authority.configDigest
            ? structuredClone(state.restoration.source)
            : {
                authorityDigest: authority.authorityDigest,
                configDigest: authority.configDigest,
                ...authority.hostLayout,
              },
        installation: {
          identity: previous?.installation.identity ?? randomUUID(),
          configDigest: factoryConfigDigest(config),
          authorityDigest: factoryAuthorityDigest(config),
          checkout: config.checkout,
          stateRoot: root,
        },
        status: "held",
        reason:
          "Verified originals installed for inspection; foreign ownership and frozen configuration require explicit reconciliation",
      };
      state.schemaVersion = isPreparationState(state) ? 20 : 19;
      state.restoration = receipt;
      if (!continuationConfigurationMatches(state, config))
        receipt.reason =
          "Historical snapshot configuration cannot be authenticated by this checkpoint's publisher authority; inspection only";
      assertRecoveryReplicaPath(
        statePath(config.repository, state.objective),
        root,
      );
      saveState(statePath(config.repository, state.objective), state, {
        observeMemory: false,
      });
      // Its evidence stays in the archive history; this installation keeps
      // only the snapshot, as the source did (#1307).
      if (retired)
        recordRetirement(
          config.repository,
          state.objective,
          readFileSync(statePath(config.repository, state.objective)),
          retired,
          [],
        );
      objectives.push({
        objective: state.objective,
        runId: state.runId,
        disposition: "held",
        reason: receipt.reason,
      });
    }
    let adopted = false;
    if (source && checkpoint.commitSha === checkpoint.remoteTip) {
      await adoptRecoveryCheckpointBaseline(config, {
        checkpoint,
        installedClosureDigest: recoveryCheckpointClosureDigest(
          checkpoint.manifest,
        ),
        lock,
      });
      adopted = true;
    }
    return {
      checkpoint: checkpoint.commitSha,
      payloadDigest: checkpoint.payloadDigest,
      disposition: adopted ? "reconciliation-required" : "inspection",
      objectives,
      ...memory,
      pendingSync: adopted,
    };
  } finally {
    if (staging) rmSync(staging, { recursive: true, force: true });
    releaseControllerLock(installationLockPath(config.repository), lock);
  }
}

/** Explicitly release only a verified idle continuation from its inspection fence. */
export async function reconcileRestoredContinuation(args: {
  config: FactoryConfig;
  objective: number;
}): Promise<{ objective: number; runId: string; status: "reconciled" }> {
  const { config, objective } = args;
  const { verifyContinuationReferenceClosure, buildRecoveryCheckpointClosure } =
    await import("./recovery-checkpoint-closure.js");
  const lock = acquireInstallationLock(config.repository, objective);
  try {
    const state = readContinuation(config.repository, objective);
    if (!state?.restoration)
      throw new Error("Objective has no supported restored continuation");
    if (
      state.cancelledAt ||
      (!isPreparationState(state) && state.finalAcceptance)
    )
      throw new Error(
        "Terminal or cancelled restored Objectives remain terminal inspection records",
      );
    if (!continuationConfigurationMatches(state, config))
      throw new Error(
        "Frozen original configuration authority cannot be rebound to this installation",
      );
    const store = new LocalContentStore(
      join(stateRoot(config.repository), "content"),
    );
    const original = parsePortableContinuation(
      JSON.parse(
        store.readBytes(state.restoration.original.snapshot).toString("utf8"),
      ),
      config.repository,
      objective,
    );
    if (
      original.runId !== state.runId ||
      original.configDigest !== state.configDigest ||
      createHash("sha256")
        .update(store.readBytes(state.restoration.archive))
        .digest("hex") !== state.restoration.checkpoint.payloadDigest
    )
      throw new Error(
        "Restored original identity or archive changed before reconciliation",
      );
    const hold = restoredContinuationOwnershipHold(state);
    if (hold) throw new Error(`Restored continuation remains held: ${hold}`);
    const closure = await verifyContinuationReferenceClosure(
      state,
      store,
      config.gitPersistence,
    );
    if (closure.gaps.some((gap) => gap.required !== false))
      throw new Error(
        "Restored continuation has an unresolved required original",
      );
    for (const object of closure.gitObjects)
      if (
        pinnedGit(config.checkout, "cat-file", "-t", object.sha) !== object.kind
      )
        throw new Error(
          "Restored source Git object is unavailable or has the wrong type",
        );
    for (const [key, ref] of Object.entries(state.agentSessions ?? {})) {
      if (ref.status !== "ready") continue;
      state.agentSessionHistory ??= [];
      state.agentSessionHistory.push(structuredClone(ref));
      state.agentSessions![key] = { ...ref, status: "unavailable" };
    }
    state.restoration.status = "reconciled";
    state.restoration.reason =
      "Exact source configuration and retained terminal ownership receipts authenticated; new local execution remains within original allowances";
    await withRecoveryCheckpointScope(
      {
        config,
        buildClosure: () => buildRecoveryCheckpointClosure({ config }),
      },
      async () =>
        saveState(statePath(config.repository, objective), state, {
          observeMemory: false,
        }),
    );
    return { objective, runId: state.runId, status: "reconciled" };
  } finally {
    releaseControllerLock(installationLockPath(config.repository), lock);
  }
}

/** Held foreign owners also fence a fresh Objective using this installation's limits. */
export function assertRestoredInstallationDispatchReady(
  config: FactoryConfig,
): void {
  const root = join(stateRoot(config.repository), "objectives");
  if (!existsSync(root)) return;
  for (const name of readdirSync(root).filter((name) =>
    /^[1-9][0-9]*$/.test(name),
  )) {
    const state = readContinuation(config.repository, Number(name));
    if (!state?.restoration || state.restoration.status !== "held") continue;
    const hold = restoredContinuationOwnershipHold(state);
    if (hold)
      throw new Error(
        `Restored installation retains unsettled foreign ownership: ${hold}`,
      );
  }
}

function assertRecoveryReplicaPath(path: string, root: string): void {
  const scope = relative(resolve(root), resolve(path));
  if (
    !scope ||
    scope.startsWith(`..${sep}`) ||
    scope === ".." ||
    resolve(root) !== realpathSync(root)
  )
    throw new Error("Recovery replica resolves outside its private root");
  let current = root;
  for (const part of scope.split(sep).slice(0, -1)) {
    current = join(current, part);
    if (
      existsSync(current) &&
      (!lstatSync(current).isDirectory() || lstatSync(current).isSymbolicLink())
    )
      throw new Error("Recovery replica parent is not a private directory");
  }
  if (
    existsSync(path) &&
    (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())
  )
    throw new Error("Recovery replica is not a regular original file");
}
