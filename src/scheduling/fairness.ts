import type { CapacityReservation } from "./capacity-ledger.js";

/** Equal-share guarantees with work-conserving lending on one local host. */
export class ObjectiveFairness {
  readonly #ready = new Map<number, number | null>();

  register(objective: number): void {
    if (!this.#ready.has(objective)) this.#ready.set(objective, null);
  }

  unregister(objective: number): void {
    this.#ready.delete(objective);
  }

  reportDemand(objective: number, readyCount: number): void {
    if (!Number.isInteger(readyCount) || readyCount < 0) {
      throw new Error("ready demand must be a non-negative integer");
    }
    this.#ready.set(objective, readyCount);
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
    const objectives = [...this.#ready.keys()].sort((a, b) => a - b);
    const base = Math.floor(totalSlots / objectives.length);
    const remainder = totalSlots % objectives.length;
    const shares = new Map(
      objectives.map((number, index) => [
        number,
        base + (index < remainder ? 1 : 0),
      ]),
    );
    const active = new Map<number, number>();
    for (const reservation of reservations) {
      if (!reservation.local) continue;
      active.set(
        reservation.objective,
        (active.get(reservation.objective) ?? 0) + 1,
      );
    }
    let unavailableToObjective = 0;
    for (const other of objectives) {
      if (other === objective) continue;
      const running = active.get(other) ?? 0;
      const share = shares.get(other) ?? 0;
      const reported = this.#ready.get(other);
      const wanted = reported ?? share;
      const guaranteed = Math.min(Math.max(0, share - running), wanted);
      unavailableToObjective += running + guaranteed;
    }
    return Math.max(
      active.get(objective) ?? 0,
      totalSlots - unavailableToObjective,
    );
  }
}
