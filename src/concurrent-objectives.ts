import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { objectiveComplete } from "./completion.js";
import {
  type FactoryConfig,
  maxActiveObjectives,
  type ResourcePhase,
  stateRoot,
} from "./config.js";
import { pathsOverlap } from "./ownership.js";
import { releaseGuard, takeGuard } from "./process.js";
import type { ContinuationState, FactoryState } from "./state.js";
import { isExecutionState } from "./state.js";
import {
  liveControllerOwner,
  objectiveLockPath,
  objectiveRoot,
  readScannedContinuation,
} from "./state-store.js";

/*
 * Coordination between Objectives that run at once on one installation, when
 * the operator opts in with `queue.maxActiveObjectives` above 1. Each Objective
 * keeps its own controller and atomic snapshot; these small host-local files
 * only let the controllers see each other:
 *
 * - `execution.json`: the owned paths an Objective was admitted to execute.
 *   Another Objective whose owned paths overlap waits until it ends.
 * - `capacity.json`: the phases its live controller reserves, so the host's
 *   coding, validation, review, CPU and memory ceilings bound all of them.
 *
 * Both are rewritten only under a host guard and read without one. Neither is
 * a checkpoint record: a restored installation starts without them, and its
 * restored Objectives are held for reconciliation anyway.
 */

const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

function writeAtomic(path: string, value: unknown): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
  renameSync(temporary, path);
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function objectiveIds(repository: string): number[] {
  const root = join(stateRoot(repository), "objectives");
  return existsSync(root)
    ? readdirSync(root)
        .filter((name) => /^\d+$/.test(name))
        .map(Number)
        .sort((left, right) => left - right)
    : [];
}

function withHostGuard<T>(repository: string, name: string, task: () => T): T {
  mkdirSync(stateRoot(repository), { recursive: true, mode: 0o700 });
  const guard = join(stateRoot(repository), `${name}.acquire`);
  takeGuard(guard);
  try {
    return task();
  } finally {
    releaseGuard(guard);
  }
}

/** Whether Objectives on this installation coordinate with each other. */
export function concurrentObjectives(config: FactoryConfig): boolean {
  return maxActiveObjectives(config) > 1;
}

interface ExecutionLease {
  schemaVersion: 1;
  objective: number;
  runId: string;
  admittedAt: string;
  ownedPaths: string[];
}

const leasePath = (repository: string, objective: number) =>
  join(objectiveRoot(repository, objective), "execution.json");

function readLease(
  repository: string,
  objective: number,
): ExecutionLease | undefined {
  const value = readJson(leasePath(repository, objective)) as
    | ExecutionLease
    | undefined;
  if (
    !value ||
    value.schemaVersion !== 1 ||
    value.objective !== objective ||
    typeof value.runId !== "string" ||
    !Number.isFinite(Date.parse(value.admittedAt)) ||
    !Array.isArray(value.ownedPaths) ||
    value.ownedPaths.some((path) => typeof path !== "string")
  )
    return undefined;
  return value;
}

/** Every owned path of the Objective's current graph. */
function footprint(state: FactoryState): string[] {
  return [...new Set(state.graph.items.flatMap((item) => item.ownedPaths))];
}

function terminal(state: ContinuationState): boolean {
  return (
    !!state.cancelledAt || (isExecutionState(state) && objectiveComplete(state))
  );
}

/**
 * The admitted footprints of other unfinished Objectives. A lease counts while
 * its Objective's current run is unfinished, whether or not its controller is
 * alive: a stopped Objective's remaining work still owns those paths. An
 * unreadable snapshot counts too; unknown is not finished.
 */
function activeLeases(repository: string, except: number): ExecutionLease[] {
  return objectiveIds(repository).flatMap((objective) => {
    if (objective === except) return [];
    const lease = readLease(repository, objective);
    if (!lease) return [];
    let state: ReturnType<typeof readScannedContinuation>;
    try {
      state = readScannedContinuation(repository, objective);
    } catch {
      return [lease];
    }
    if (state === "history" || !state || state.runId !== lease.runId) return [];
    return terminal(state) ? [] : [lease];
  });
}

/** Two Objectives' overlapping owned paths, as the waiting one names them. */
function overlap(left: string[], right: string[]): string[] {
  return left.filter((path) =>
    right.some((other) => pathsOverlap(path, other)),
  );
}

/** Leases admitted earlier hold later ones; the order is total. */
function earlier(left: ExecutionLease, right: ExecutionLease): boolean {
  const order = Date.parse(left.admittedAt) - Date.parse(right.admittedAt);
  return order < 0 || (order === 0 && left.objective < right.objective);
}

export interface ExecutionConflict {
  objective: number;
  paths: string[];
}

/** The overlap that holds an Objective, as its wait names it. */
export function executionConflictDetail(conflict: ExecutionConflict): string {
  const shown = conflict.paths.slice(0, 5).join(", ");
  const more =
    conflict.paths.length > 5 ? ` and ${conflict.paths.length - 5} more` : "";
  return `Waiting for Objective #${conflict.objective} (overlapping paths: ${shown}${more})`;
}

function conflictFor(
  repository: string,
  objective: number,
  paths: string[],
  own: ExecutionLease | undefined,
): ExecutionConflict | undefined {
  for (const lease of activeLeases(repository, objective)) {
    if (own && !earlier(lease, own)) continue;
    const shared = overlap(paths, lease.ownedPaths);
    if (shared.length) return { objective: lease.objective, paths: shared };
  }
  return undefined;
}

/**
 * Admit an Objective's execution, or name the earlier-admitted unfinished
 * Objective whose owned paths overlap its own. Planning runs concurrently;
 * only execution waits. Admission is checked at every execution pass, so a
 * graph amendment that adds an overlap holds the later Objective's next
 * dispatch. Owned paths are the literal, enforced footprint the reviewed graph
 * gives each Work Item, so the comparison is structural.
 */
export function admitExecution(
  config: FactoryConfig,
  state: FactoryState,
): ExecutionConflict | undefined {
  const { repository } = config;
  const objective = state.objective;
  return withHostGuard(repository, "execution-admission", () => {
    const previous = readLease(repository, objective);
    const own = previous?.runId === state.runId ? previous : undefined;
    const paths = footprint(state);
    const conflict = conflictFor(repository, objective, paths, own);
    if (conflict) return conflict;
    if (
      !own ||
      JSON.stringify(own.ownedPaths) !== JSON.stringify(paths) ||
      own.objective !== objective
    )
      writeAtomic(leasePath(repository, objective), {
        schemaVersion: 1,
        objective,
        runId: state.runId,
        admittedAt: own?.admittedAt ?? new Date().toISOString(),
        ownedPaths: paths,
      } satisfies ExecutionLease);
    return undefined;
  });
}

/**
 * The conflict that would hold an Objective already planned, without
 * admitting it: the service passes over it and dispatches the next one.
 */
export function plannedExecutionConflict(
  config: FactoryConfig,
  state: ContinuationState | undefined,
): ExecutionConflict | undefined {
  if (!state || !isExecutionState(state) || terminal(state)) return undefined;
  const previous = readLease(config.repository, state.objective);
  const own = previous?.runId === state.runId ? previous : undefined;
  return conflictFor(config.repository, state.objective, footprint(state), own);
}

/** Drop a finished Objective's lease; stale leases are also ignored. */
export function releaseExecution(config: FactoryConfig, objective: number) {
  rmSync(leasePath(config.repository, objective), { force: true });
}

interface CapacityLedger {
  schemaVersion: 1;
  objective: number;
  ownerTokenDigest: string;
  phases: ResourcePhase[];
}

const PHASES: readonly ResourcePhase[] = [
  "coding",
  "validation",
  "review",
  "delivery",
];

const ledgerPath = (repository: string, objective: number) =>
  join(objectiveRoot(repository, objective), "capacity.json");

/** One Objective controller's view of the installation's shared capacity. */
export interface SharedCapacity {
  /** Phases the other live Objective controllers reserve now. */
  others(): ResourcePhase[];
  /** Check and reserve atomically with every other controller. */
  exclusive<T>(task: () => T): T;
  /** Publish this controller's current reservations. */
  publish(phases: ResourcePhase[]): void;
}

/**
 * The shared capacity of a live controller owning `objective` with the lock
 * `ownerToken`, or undefined when Objectives do not run concurrently. A
 * ledger counts only while its writer still holds that Objective's lock.
 */
export function sharedCapacity(
  config: FactoryConfig,
  objective: number,
  ownerToken: string,
): SharedCapacity | undefined {
  if (!concurrentObjectives(config)) return undefined;
  const { repository } = config;
  const ownerTokenDigest = sha256(ownerToken);
  return {
    others() {
      return objectiveIds(repository).flatMap((id) => {
        if (id === objective) return [];
        let ledger: CapacityLedger | undefined;
        try {
          ledger = readJson(ledgerPath(repository, id)) as
            | CapacityLedger
            | undefined;
        } catch {
          return [];
        }
        if (
          ledger?.schemaVersion !== 1 ||
          ledger.objective !== id ||
          !Array.isArray(ledger.phases)
        )
          return [];
        let owner: ReturnType<typeof liveControllerOwner>;
        try {
          owner = liveControllerOwner(objectiveLockPath(repository, id));
        } catch {
          return [];
        }
        if (!owner || sha256(owner.token) !== ledger.ownerTokenDigest)
          return [];
        return ledger.phases.filter((phase) => PHASES.includes(phase));
      });
    },
    exclusive(task) {
      return withHostGuard(repository, "capacity", task);
    },
    publish(phases) {
      writeAtomic(ledgerPath(repository, objective), {
        schemaVersion: 1,
        objective,
        ownerTokenDigest,
        phases,
      } satisfies CapacityLedger);
    },
  };
}
