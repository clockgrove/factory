import type { FactoryEvent } from "../protocol/events.js";
import { deduplicateFactoryEvents } from "../control/receipts.js";
import { isManagedAgentBackendId, isSandboxBackendId } from "../protocol/policy.js";

export type CapacityPhase = "execution" | "validation";
export type AdmissionClass = "local" | "remote-required" | "burst";

export interface CapacityReservation {
  key: string;
  objective: number;
  workItem: number;
  attempt: number;
  phase: CapacityPhase;
  backendId: string;
  admissionClass: AdmissionClass;
  local: boolean;
  cpu: number;
  memoryMb: number;
  paidUnits: number;
  paths: readonly string[];
  exclusiveResources: readonly string[];
}

export interface CapacityLimits {
  /** Repository-wide ceilings. */
  maxParallel: number;
  maxLocalParallel: number;
  maxCloudParallel: number;
  backendMaxParallel: Readonly<Record<string, number>>;
  cpuCapacity: number;
  memoryCapacityMb: number;
  maxPaidUnits: number;
  /** Immutable per-run ceilings, evaluated only against this Objective. */
  objectiveMaxParallel?: { objective: number; max: number };
  objectiveLocalMax?: { objective: number; max: number };
  objectiveCloudMax?: { objective: number; max: number };
  objectiveBackendMaxParallel?: {
    objective: number;
    limits: Readonly<Record<string, number>>;
  };
}

export interface CapacitySnapshot {
  generation: number;
  reservations: readonly CapacityReservation[];
  active: number;
  local: number;
  cloud: number;
  cpu: number;
  memoryMb: number;
  paidUnits: number;
  byBackend: Readonly<Record<string, number>>;
}

export type CapacityRejectionCode =
  | "stale-generation"
  | "duplicate-reservation"
  | "global-capacity"
  | "local-capacity"
  | "cloud-capacity"
  | "backend-capacity"
  | "cpu-capacity"
  | "memory-capacity"
  | "paid-capacity"
  | "path-conflict"
  | "exclusive-resource-conflict";

export type CapacityReservationResult =
  | { reserved: true; reservation: CapacityReservation; generation: number }
  | { reserved: false; code: CapacityRejectionCode; generation: number };

export function capacityReservationKey(input: {
  objective: number;
  workItem: number;
  attempt: number;
  phase: CapacityPhase;
  backendId: string;
}): string {
  return `${input.objective}:${input.workItem}:${input.attempt}:${input.phase}:${input.backendId}`;
}

function normalizedPath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

export function reservationPathsOverlap(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.some((a) =>
    right.some((b) => {
      const x = normalizedPath(a);
      const y = normalizedPath(b);
      return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
    }),
  );
}

function intersects(left: readonly string[], right: readonly string[]): boolean {
  const values = new Set(left);
  return right.some((value) => values.has(value));
}

function assertReservation(reservation: CapacityReservation): void {
  if (
    !Number.isInteger(reservation.objective) ||
    reservation.objective <= 0 ||
    !Number.isInteger(reservation.workItem) ||
    reservation.workItem <= 0 ||
    !Number.isInteger(reservation.attempt) ||
    reservation.attempt <= 0
  ) {
    throw new Error("capacity reservation identity must use positive integers");
  }
  if (
    ![reservation.cpu, reservation.memoryMb, reservation.paidUnits].every(
      (value) => Number.isFinite(value) && value >= 0,
    )
  ) {
    throw new Error("capacity reservation resources must be finite and non-negative");
  }
}

function tally(
  reservations: Iterable<CapacityReservation>,
): Omit<CapacitySnapshot, "generation" | "reservations"> {
  let active = 0;
  let local = 0;
  let cloud = 0;
  let cpu = 0;
  let memoryMb = 0;
  let paidUnits = 0;
  const byBackend: Record<string, number> = {};
  for (const reservation of reservations) {
    active += 1;
    if (reservation.local) {
      local += 1;
      cpu += reservation.cpu;
      memoryMb += reservation.memoryMb;
    } else {
      cloud += 1;
    }
    paidUnits += reservation.paidUnits;
    byBackend[reservation.backendId] = (byBackend[reservation.backendId] ?? 0) + 1;
  }
  return { active, local, cloud, cpu, memoryMb, paidUnits, byBackend };
}

/**
 * Atomic process-local ledger whose durable baseline is reconstructed from
 * GitHub receipts. The generation prevents a plan from committing against a
 * capacity snapshot that changed after it was produced.
 */
export class CapacityLedger {
  #generation = 0;
  readonly #reservations = new Map<string, CapacityReservation>();
  readonly #pending = new Set<string>();
  readonly #durableByObjective = new Map<number, Set<string>>();

  snapshot(): CapacitySnapshot {
    const reservations = [...this.#reservations.values()].sort((a, b) =>
      a.key.localeCompare(b.key),
    );
    return {
      generation: this.#generation,
      reservations,
      ...tally(reservations),
    };
  }

  /** Replace durable observations while retaining commits not visible yet. */
  reconcile(generation: number, durable: readonly CapacityReservation[]): CapacitySnapshot {
    if (!Number.isSafeInteger(generation) || generation <= this.#generation) {
      throw new Error(
        `capacity generation ${generation} is stale; current generation is ${this.#generation}`,
      );
    }
    const next = new Map<string, CapacityReservation>();
    for (const reservation of durable) {
      assertReservation(reservation);
      const expected = capacityReservationKey(reservation);
      if (reservation.key !== expected) throw new Error(`invalid capacity key ${reservation.key}`);
      if (next.has(reservation.key)) continue;
      next.set(reservation.key, Object.freeze({ ...reservation }));
    }
    for (const key of this.#pending) {
      const reservation = this.#reservations.get(key);
      if (reservation && !next.has(key)) next.set(key, reservation);
    }
    this.#reservations.clear();
    this.#durableByObjective.clear();
    for (const [key, reservation] of next) this.#reservations.set(key, reservation);
    for (const reservation of durable) {
      const keys = this.#durableByObjective.get(reservation.objective) ?? new Set<string>();
      keys.add(reservation.key);
      this.#durableByObjective.set(reservation.objective, keys);
    }
    this.#generation = generation;
    return this.snapshot();
  }

  /** Merge one Objective's fresh GitHub reconstruction into the repository view. */
  reconcileObjective(objective: number, durable: readonly CapacityReservation[]): CapacitySnapshot {
    const prior = this.#durableByObjective.get(objective) ?? new Set<string>();
    const observed = new Set<string>();
    let changed = this.#generation === 0;
    for (const reservation of durable) {
      if (reservation.objective !== objective) {
        throw new Error("durable capacity Objective mismatch");
      }
      assertReservation(reservation);
      if (reservation.key !== capacityReservationKey(reservation)) {
        throw new Error(`invalid capacity key ${reservation.key}`);
      }
      observed.add(reservation.key);
      const existing = this.#reservations.get(reservation.key);
      if (!existing || JSON.stringify(existing) !== JSON.stringify(reservation)) {
        changed = true;
        this.#reservations.set(reservation.key, Object.freeze({ ...reservation }));
      }
    }
    for (const key of prior) {
      if (!observed.has(key) && !this.#pending.has(key)) {
        changed = this.#reservations.delete(key) || changed;
      }
    }
    this.#durableByObjective.set(objective, observed);
    if (changed) this.#generation += 1;
    return this.snapshot();
  }

  tryReserve(
    expectedGeneration: number,
    input: CapacityReservation,
    limits: CapacityLimits,
  ): CapacityReservationResult {
    if (expectedGeneration !== this.#generation) {
      return { reserved: false, code: "stale-generation", generation: this.#generation };
    }
    assertReservation(input);
    if (input.key !== capacityReservationKey(input)) {
      throw new Error(`invalid capacity key ${input.key}`);
    }
    if (this.#reservations.has(input.key)) {
      return {
        reserved: false,
        code: "duplicate-reservation",
        generation: this.#generation,
      };
    }
    const current = this.snapshot();
    const objectiveReservations = current.reservations.filter(
      (reservation) => reservation.objective === input.objective,
    );
    const reject = (code: CapacityRejectionCode): CapacityReservationResult => ({
      reserved: false,
      code,
      generation: this.#generation,
    });
    if (current.active + 1 > limits.maxParallel) return reject("global-capacity");
    if (
      limits.objectiveMaxParallel?.objective === input.objective &&
      objectiveReservations.length + 1 > limits.objectiveMaxParallel.max
    ) {
      return reject("global-capacity");
    }
    if (input.local && current.local + 1 > limits.maxLocalParallel) {
      return reject("local-capacity");
    }
    if (
      input.local &&
      limits.objectiveLocalMax?.objective === input.objective &&
      objectiveReservations.filter((reservation) => reservation.local).length + 1 >
        limits.objectiveLocalMax.max
    ) {
      return reject("local-capacity");
    }
    if (!input.local && current.cloud + 1 > limits.maxCloudParallel) {
      return reject("cloud-capacity");
    }
    if (
      !input.local &&
      limits.objectiveCloudMax?.objective === input.objective &&
      objectiveReservations.filter((reservation) => !reservation.local).length + 1 >
        limits.objectiveCloudMax.max
    ) {
      return reject("cloud-capacity");
    }
    if (
      (current.byBackend[input.backendId] ?? 0) + 1 >
      (limits.backendMaxParallel[input.backendId] ?? limits.maxParallel)
    ) {
      return reject("backend-capacity");
    }
    if (
      limits.objectiveBackendMaxParallel?.objective === input.objective &&
      objectiveReservations.filter((reservation) => reservation.backendId === input.backendId)
        .length +
        1 >
        (limits.objectiveBackendMaxParallel.limits[input.backendId] ??
          limits.objectiveMaxParallel?.max ??
          limits.maxParallel)
    ) {
      return reject("backend-capacity");
    }
    if (input.local && current.cpu + input.cpu > limits.cpuCapacity) {
      return reject("cpu-capacity");
    }
    if (input.local && current.memoryMb + input.memoryMb > limits.memoryCapacityMb) {
      return reject("memory-capacity");
    }
    if (current.paidUnits + input.paidUnits > limits.maxPaidUnits) {
      return reject("paid-capacity");
    }
    for (const reservation of current.reservations) {
      if (reservationPathsOverlap(input.paths, reservation.paths)) {
        return reject("path-conflict");
      }
      if (intersects(input.exclusiveResources, reservation.exclusiveResources)) {
        return reject("exclusive-resource-conflict");
      }
    }
    const reservation = Object.freeze({ ...input });
    this.#reservations.set(input.key, reservation);
    this.#pending.add(input.key);
    this.#generation += 1;
    return { reserved: true, reservation, generation: this.#generation };
  }

  /** Atomically hand capacity from one phase to the next without a free gap. */
  transition(
    expectedGeneration: number,
    fromKey: string,
    next: CapacityReservation,
    limits: CapacityLimits,
  ): CapacityReservationResult {
    if (expectedGeneration !== this.#generation) {
      return { reserved: false, code: "stale-generation", generation: this.#generation };
    }
    const prior = this.#reservations.get(fromKey);
    if (!prior) {
      return {
        reserved: false,
        code: "duplicate-reservation",
        generation: this.#generation,
      };
    }
    const wasPending = this.#pending.delete(fromKey);
    this.#reservations.delete(fromKey);
    const result = this.tryReserve(expectedGeneration, next, limits);
    if (!result.reserved) {
      this.#reservations.set(fromKey, prior);
      if (wasPending) this.#pending.add(fromKey);
      return result;
    }
    for (const keys of this.#durableByObjective.values()) keys.delete(fromKey);
    return result;
  }

  /** Exactly-once from the caller's perspective; duplicate release is false. */
  release(key: string): boolean {
    this.#pending.delete(key);
    const removed = this.#reservations.delete(key);
    for (const keys of this.#durableByObjective.values()) keys.delete(key);
    if (removed) this.#generation += 1;
    return removed;
  }
}

export interface DurableCapacityInput {
  objective: number;
  workItem: number;
  events: readonly FactoryEvent[];
  defaultCpu: number;
  defaultMemoryMb: number;
  paths?: readonly string[];
  exclusiveResources?: readonly string[];
  isLocalBackend?: (backendId: string) => boolean;
}

export type CapacityReceipt = Extract<FactoryEvent, { kind: "capacity" }>;

function capacityReceiptKey(event: CapacityReceipt): string {
  return [event.objective, event.workItem, event.attempt, event.phase, event.backend].join(":");
}

/**
 * Return capacity reservations without a later matching reconciliation.
 * Processing receipts in durable sequence order also makes a repeated reserve
 * after a reconciliation a new, visible obligation rather than hiding it.
 */
export function unreconciledCapacityReservations(
  input: readonly FactoryEvent[],
): CapacityReceipt[] {
  const live = new Map<string, CapacityReceipt>();
  const events = deduplicateFactoryEvents([...input]).sort(
    (left, right) => left.sequence - right.sequence,
  );
  for (const event of events) {
    if (event.kind !== "capacity") continue;
    const key = capacityReceiptKey(event);
    if (event.event === "CapacityReserved") live.set(key, event);
    else live.delete(key);
  }
  return [...live.values()].sort((left, right) => left.sequence - right.sequence);
}

const executionTerminal = new Set([
  "AttemptFailed",
  "AttemptTimedOut",
  "AttemptCancelled",
  "AttemptDeferred",
  "AttemptIntegrated",
]);

/** Rebuild all live execution and validation capacity from durable receipts. */
export function deriveCapacityReservations(
  inputs: readonly DurableCapacityInput[],
): CapacityReservation[] {
  const result = new Map<string, CapacityReservation>();
  for (const input of inputs) {
    const events = deduplicateFactoryEvents([...input.events]).sort(
      (left, right) => left.sequence - right.sequence,
    );
    const attempts = new Map<number, Extract<FactoryEvent, { kind: "attempt" }>[]>();
    for (const event of events) {
      if (event.kind !== "attempt" || event.workItem !== input.workItem) continue;
      const values = attempts.get(event.attempt) ?? [];
      values.push(event);
      attempts.set(event.attempt, values);
    }
    for (const [attempt, values] of attempts) {
      const reserved = values.find((event) => event.event === "AttemptReserved");
      if (!reserved || values.some((event) => executionTerminal.has(event.event))) continue;
      // The validation reservation is written only after worker cleanup and
      // the atomic in-memory phase transition. It therefore proves execution
      // capacity ended even if the Director crashed before AttemptCollected.
      const transitionedToValidation = events.some(
        (event) =>
          event.kind === "capacity" &&
          event.event === "CapacityReserved" &&
          event.phase === "validation" &&
          event.workItem === input.workItem &&
          event.attempt === attempt,
      );
      if (transitionedToValidation) continue;
      const local =
        reserved.admissionClass === "local" ||
        (reserved.admissionClass === undefined &&
          (input.isLocalBackend?.(reserved.backend) ??
            (!isSandboxBackendId(reserved.backend) && !isManagedAgentBackendId(reserved.backend))));
      const reservation: CapacityReservation = {
        key: capacityReservationKey({
          objective: input.objective,
          workItem: input.workItem,
          attempt,
          phase: "execution",
          backendId: reserved.backend,
        }),
        objective: input.objective,
        workItem: input.workItem,
        attempt,
        phase: "execution",
        backendId: reserved.backend,
        admissionClass: reserved.admissionClass ?? (local ? "local" : "remote-required"),
        local,
        cpu: reserved.requestedCpu ?? input.defaultCpu,
        memoryMb: reserved.requestedMemoryMb ?? input.defaultMemoryMb,
        paidUnits: local ? 0 : 1,
        paths: input.paths ?? [],
        exclusiveResources: input.exclusiveResources ?? [],
      };
      result.set(reservation.key, reservation);
    }

    for (const reserved of unreconciledCapacityReservations(events).filter(
      (event) => event.workItem === input.workItem && event.phase === "validation",
    )) {
      const attemptEvents = attempts.get(reserved.attempt) ?? [];
      const terminalAttempt = attemptEvents.some((event) => executionTerminal.has(event.event));
      const validationFinished = events.some(
        (event) =>
          event.kind === "validation" &&
          event.workItem === input.workItem &&
          event.attempt === reserved.attempt,
      );
      if (terminalAttempt || validationFinished) continue;
      const local = input.isLocalBackend?.(reserved.backend) ?? false;
      const reservation: CapacityReservation = {
        key: capacityReservationKey({
          objective: input.objective,
          workItem: input.workItem,
          attempt: reserved.attempt,
          phase: "validation",
          backendId: reserved.backend,
        }),
        objective: input.objective,
        workItem: input.workItem,
        attempt: reserved.attempt,
        phase: "validation",
        backendId: reserved.backend,
        admissionClass: local ? "local" : "remote-required",
        local,
        cpu: reserved.requestedCpu,
        memoryMb: reserved.requestedMemoryMb,
        paidUnits: local ? 0 : 1,
        paths: input.paths ?? [],
        exclusiveResources: input.exclusiveResources ?? [],
      };
      result.set(reservation.key, reservation);
    }
  }
  return [...result.values()].sort((a, b) => a.key.localeCompare(b.key));
}
