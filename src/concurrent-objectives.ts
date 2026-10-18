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
  /**
   * The Objective this admitted one waits for, because an amendment added
   * paths that Objective owns. A waiting later Objective never holds an
   * earlier one's added paths, so two amendments cannot wait on each other.
   */
  waitingFor?: number;
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
    value.ownedPaths.some((path) => typeof path !== "string") ||
    (value.waitingFor !== undefined && !Number.isSafeInteger(value.waitingFor))
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
 * Which other Objectives' runs are unfinished, by run identity, read from
 * their snapshots outside the guard (snapshots can be large). An unreadable
 * snapshot is unfinished: unknown is not finished.
 */
function unfinishedRuns(
  repository: string,
  except: number,
): Map<number, string | true | false> {
  const runs = new Map<number, string | true | false>();
  for (const objective of objectiveIds(repository)) {
    if (objective === except || !readLease(repository, objective)) continue;
    try {
      const state = readScannedContinuation(repository, objective);
      runs.set(
        objective,
        state === "history" || !state || terminal(state) ? false : state.runId,
      );
    } catch {
      runs.set(objective, true);
    }
  }
  return runs;
}

/**
 * The admitted footprints of other unfinished Objectives. A lease counts while
 * its Objective's current run is unfinished, whether or not its controller is
 * alive: a stopped Objective's remaining work still owns those paths. Leases
 * are read again here, so one written since `runs` was read counts too.
 */
function activeLeases(
  repository: string,
  except: number,
  runs: Map<number, string | true | false>,
): ExecutionLease[] {
  return objectiveIds(repository).flatMap((objective) => {
    if (objective === except) return [];
    const lease = readLease(repository, objective);
    if (!lease) return [];
    const run = runs.get(objective);
    return run === undefined || run === true || run === lease.runId
      ? [lease]
      : [];
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
  runs = unfinishedRuns(repository, objective),
): ExecutionConflict | undefined {
  // Paths an amendment added since admission yield to every active lease,
  // later ones included, unless that later Objective itself waits (for its
  // own amendment): the earlier one then wins. Admitted paths yield only to
  // earlier leases.
  const added = own
    ? paths.filter((path) => !own.ownedPaths.includes(path))
    : paths;
  for (const lease of activeLeases(repository, objective, runs)) {
    const checked =
      !own || earlier(lease, own)
        ? paths
        : lease.waitingFor === undefined
          ? added
          : [];
    const shared = overlap(checked, lease.ownedPaths);
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
  const runs = unfinishedRuns(repository, objective);
  // The guarded step reads only the small lease files.
  return withHostGuard(repository, "execution-admission", () => {
    const previous = readLease(repository, objective);
    const own = previous?.runId === state.runId ? previous : undefined;
    const paths = footprint(state);
    const conflict = conflictFor(repository, objective, paths, own, runs);
    if (conflict) {
      // An admitted Objective records whom it waits for; its admitted paths
      // stay held meanwhile.
      if (own && own.waitingFor !== conflict.objective)
        writeAtomic(leasePath(repository, objective), {
          ...own,
          waitingFor: conflict.objective,
        } satisfies ExecutionLease);
      return conflict;
    }
    if (
      !own ||
      JSON.stringify(own.ownedPaths) !== JSON.stringify(paths) ||
      own.waitingFor !== undefined
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
  /** Phases this controller waits to reserve, with when each was asked. */
  pending?: { phase: ResourcePhase; requestedAt: number }[];
}

const PHASES: readonly ResourcePhase[] = [
  "coding",
  "validation",
  "review",
  "delivery",
];

const ledgerPath = (repository: string, objective: number) =>
  join(objectiveRoot(repository, objective), "capacity.json");

/** A phase request waiting for a slot; the oldest across controllers goes first. */
export interface PendingPhase {
  phase: ResourcePhase;
  requestedAt: number;
  objective: number;
}

/** Whether `left` was asked before `right`; the order is total. */
export function askedFirst(left: PendingPhase, right: PendingPhase): boolean {
  return (
    left.requestedAt < right.requestedAt ||
    (left.requestedAt === right.requestedAt && left.objective < right.objective)
  );
}

/** One Objective controller's view of the installation's shared capacity. */
export interface SharedCapacity {
  readonly objective: number;
  /** What the other live Objective controllers reserve and wait for now. */
  others(): { reserved: ResourcePhase[]; pending: PendingPhase[] };
  /** Check and reserve atomically with every other controller. */
  exclusive<T>(task: () => T): T;
  /** Publish this controller's current reservations and waiting requests. */
  publish(
    phases: ResourcePhase[],
    pending: { phase: ResourcePhase; requestedAt: number }[],
  ): void;
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
    objective,
    others() {
      const reserved: ResourcePhase[] = [];
      const pending: PendingPhase[] = [];
      for (const id of objectiveIds(repository)) {
        if (id === objective) continue;
        let ledger: CapacityLedger | undefined;
        let owner: ReturnType<typeof liveControllerOwner>;
        try {
          ledger = readJson(ledgerPath(repository, id)) as
            | CapacityLedger
            | undefined;
          owner = liveControllerOwner(objectiveLockPath(repository, id));
        } catch {
          continue;
        }
        if (
          ledger?.schemaVersion !== 1 ||
          ledger.objective !== id ||
          !Array.isArray(ledger.phases) ||
          !owner ||
          sha256(owner.token) !== ledger.ownerTokenDigest
        )
          continue;
        reserved.push(
          ...ledger.phases.filter((phase) => PHASES.includes(phase)),
        );
        for (const request of Array.isArray(ledger.pending)
          ? ledger.pending
          : [])
          if (
            PHASES.includes(request?.phase) &&
            Number.isFinite(request.requestedAt)
          )
            pending.push({ ...request, objective: id });
      }
      return { reserved, pending };
    },
    exclusive(task) {
      return withHostGuard(repository, "capacity", task);
    },
    publish(phases, pending) {
      writeAtomic(ledgerPath(repository, objective), {
        schemaVersion: 1,
        objective,
        ownerTokenDigest,
        phases,
        pending,
      } satisfies CapacityLedger);
    },
  };
}
