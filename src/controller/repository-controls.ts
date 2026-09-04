import type { LeaseManager, LeaseState } from "../control/lease.js";

export type MutationBoundary = "admission" | "publication" | "integration";

export interface RepositoryAdmission {
  objective: number;
  workItem: number;
  cpu?: number;
  memoryMb?: number;
  paidUnits?: number;
  paths?: readonly string[];
  lease: LeaseState;
}

/** Process-local view of repository-wide resources. Durable ownership is
 * always re-derived by the controller before calling reserve(). */
export class RepositoryControls {
  readonly #active = new Map<number, RepositoryAdmission>();
  readonly #integrating = new Set<number>();
  #paidUnits = 0;
  #cpu = 0;
  #memoryMb = 0;

  constructor(
    readonly capacity: number,
    readonly paidBudget: number,
    private readonly leases: LeaseManager,
    readonly cpuCapacity = Number.POSITIVE_INFINITY,
    readonly memoryCapacityMb = Number.POSITIVE_INFINITY,
  ) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error("capacity must be positive");
    if (!Number.isFinite(paidBudget) || paidBudget < 0)
      throw new Error("paid budget must be non-negative");
  }

  async fence(lease: LeaseState, boundary: MutationBoundary): Promise<void> {
    await this.leases.assertGeneration(lease, boundary);
  }

  reserve(admission: RepositoryAdmission): (() => void) | null {
    if (admission.lease.objective !== admission.objective)
      throw new Error("admission lease Objective mismatch");
    if (this.#active.has(admission.workItem)) return null;
    if (this.#active.size >= this.capacity) return null;
    const paid = admission.paidUnits ?? 0;
    const cpu = admission.cpu ?? 0;
    const memory = admission.memoryMb ?? 0;
    if (![paid, cpu, memory].every((value) => Number.isFinite(value) && value >= 0)) {
      throw new Error("admission resources must be finite and non-negative");
    }
    if (this.#paidUnits + paid > this.paidBudget) return null;
    if (this.#cpu + cpu > this.cpuCapacity || this.#memoryMb + memory > this.memoryCapacityMb)
      return null;
    const wanted = admission.paths ?? [];
    for (const current of this.#active.values()) {
      if (pathsOverlap(wanted, current.paths ?? [])) return null;
    }
    this.#active.set(admission.workItem, admission);
    this.#paidUnits += paid;
    this.#cpu += cpu;
    this.#memoryMb += memory;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (this.#active.delete(admission.workItem)) {
        this.#paidUnits -= paid;
        this.#cpu -= cpu;
        this.#memoryMb -= memory;
      }
    };
  }

  async admit(admission: RepositoryAdmission): Promise<(() => void) | null> {
    await this.fence(admission.lease, "admission");
    return this.reserve(admission);
  }

  async publication<T>(lease: LeaseState, operation: () => Promise<T>): Promise<T> {
    await this.fence(lease, "publication");
    return operation();
  }

  async integrate<T>(workItem: number, lease: LeaseState, operation: () => Promise<T>): Promise<T> {
    await this.fence(lease, "integration");
    if (this.#integrating.size > 0 && !this.#integrating.has(workItem)) {
      throw new Error("another repository integration is in progress");
    }
    if (this.#integrating.has(workItem))
      throw new Error(`Work Item #${workItem} is already integrating`);
    this.#integrating.add(workItem);
    try {
      return await operation();
    } finally {
      this.#integrating.delete(workItem);
    }
  }

  get activeWorkItems(): readonly number[] {
    return [...this.#active.keys()];
  }
  get paidUnits(): number {
    return this.#paidUnits;
  }
}

function normalize(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

export function pathsOverlap(left: readonly string[], right: readonly string[]): boolean {
  return left.some((a) =>
    right.some((b) => {
      const x = normalize(a);
      const y = normalize(b);
      return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
    }),
  );
}
