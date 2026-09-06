import { reservationPathsOverlap, type CapacityReservation } from "./capacity-ledger.js";

export interface LocalDemandRequirement {
  cpu: number;
  memoryMb: number;
  cpuCapacity: number;
  memoryCapacityMb: number;
  paths: readonly string[];
  exclusiveResources: readonly string[];
}

/** Equal-share guarantees with work-conserving lending on one local host. */
export class ObjectiveFairness {
  readonly #ready = new Map<number, number | null>();
  readonly #unreconciled = new Set<number>();
  readonly #lastAdmission = new Map<number, number>();
  readonly #listeners = new Set<() => void>();
  readonly #requirements = new Map<number, readonly LocalDemandRequirement[]>();

  register(objective: number, requiresReconciliation = false): void {
    if (!this.#ready.has(objective)) this.#ready.set(objective, null);
    if (requiresReconciliation) this.#unreconciled.add(objective);
  }

  unregister(objective: number): void {
    this.#ready.delete(objective);
    this.#unreconciled.delete(objective);
    this.#lastAdmission.delete(objective);
    this.#requirements.delete(objective);
    this.changed();
  }

  markReconciled(objective: number): void {
    if (this.#unreconciled.delete(objective)) this.changed();
  }

  get reconciled(): boolean { return this.#unreconciled.size === 0; }

  /** Receipt timestamps seed rotation after restart; never a persisted private cursor. */
  noteAdmission(objective: number, at = Date.now()): void {
    if (Number.isFinite(at) && at > (this.#lastAdmission.get(objective) ?? 0)) {
      this.#lastAdmission.set(objective, at);
      this.changed();
    }
  }

  /** First access to a physically scarce pool goes to a waiting Objective with
   * no reservation, in least-recently-served order. Equal-share limits still cap
   * lending once all contenders have service. Impossible work reports zero demand. */
  mayAdmit(objective: number, reservations: readonly CapacityReservation[]): boolean {
    if (!this.reconciled) return false;
    const waiting = [...this.#ready.keys()].filter((number) =>
      this.#ready.get(number) !== 0 && this.#canPlace(number, reservations) &&
      !reservations.some((reservation) => reservation.objective === number && reservation.local));
    waiting.sort((a, b) => (this.#lastAdmission.get(a) ?? 0) - (this.#lastAdmission.get(b) ?? 0) || a - b);
    return waiting.length === 0 || waiting[0] === objective;
  }

  changed(): void { for (const notify of this.#listeners) notify(); }

  waitForChange(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => { clearTimeout(timer); this.#listeners.delete(done); signal?.removeEventListener("abort", done); resolve(); };
      const timer = setTimeout(done, ms);
      this.#listeners.add(done);
      signal?.addEventListener("abort", done, { once: true });
    });
  }

  /** Re-evaluate waiting demand against the live shared ledger at every atomic
   * admission. A stale "nothing fits" flag must not lose the next released CPU,
   * and an eight-CPU waiter must not block a one-CPU job when only seven are free. */
  #canPlace(objective: number, reservations: readonly CapacityReservation[]): boolean {
    const requirements = this.#requirements.get(objective);
    if (!requirements) return true;
    const local = reservations.filter((reservation) => reservation.local);
    const cpu = local.reduce((sum, reservation) => sum + reservation.cpu, 0);
    const memory = local.reduce((sum, reservation) => sum + reservation.memoryMb, 0);
    return requirements.some((request) => request.cpu <= request.cpuCapacity - cpu &&
      request.memoryMb <= request.memoryCapacityMb - memory &&
      !reservations.some((claim) => reservationPathsOverlap(request.paths, claim.paths) ||
        request.exclusiveResources.some((resource) => claim.exclusiveResources.includes(resource))));
  }

  reportDemand(objective: number, readyCount: number, requirements?: readonly LocalDemandRequirement[]): void {
    if (!Number.isInteger(readyCount) || readyCount < 0) {
      throw new Error("ready demand must be a non-negative integer");
    }
    const requirementsChanged = JSON.stringify(this.#requirements.get(objective)) !== JSON.stringify(requirements);
    if (requirements) this.#requirements.set(objective, structuredClone(requirements));
    else this.#requirements.delete(objective);
    if (this.#ready.get(objective) !== readyCount || requirementsChanged) {
      this.#ready.set(objective, readyCount);
      this.changed();
    }
  }

  localMaximum(
    objective: number,
    totalSlots: number,
    reservations: readonly CapacityReservation[],
  ): number {
    if (!Number.isInteger(totalSlots) || totalSlots < 1) {
      throw new Error("local slots must be a positive integer");
    }
    this.register(objective);
    const objectives = [...this.#ready.keys()].sort((a, b) =>
      (this.#lastAdmission.get(a) ?? 0) - (this.#lastAdmission.get(b) ?? 0) || a - b);
    const base = Math.floor(totalSlots / objectives.length);
    const remainder = totalSlots % objectives.length;
    const shares = new Map(
      objectives.map((number, index) => [number, base + (index < remainder ? 1 : 0)]),
    );
    const active = new Map<number, number>();
    for (const reservation of reservations) {
      if (!reservation.local) continue;
      active.set(reservation.objective, (active.get(reservation.objective) ?? 0) + 1);
    }
    let unavailableToObjective = 0;
    for (const other of objectives) {
      if (other === objective) continue;
      const running = active.get(other) ?? 0;
      const share = shares.get(other) ?? 0;
      const reported = this.#ready.get(other);
      const wanted = this.#canPlace(other, reservations) ? (reported ?? share) : 0;
      const guaranteed = Math.min(Math.max(0, share - running), wanted);
      unavailableToObjective += running + guaranteed;
    }
    return Math.max(active.get(objective) ?? 0, totalSlots - unavailableToObjective);
  }
}
