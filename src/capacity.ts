/**
 * Host capacity: how many steps run at once across the service, and the
 * memory each reserves (engine.ts HostLimiter). The defaults are sized
 * from the host. A reservation is a step's typical peak, measured on a
 * 24-thread, 46 GiB host against a TypeScript monorepo: a full
 * `pnpm run test` peaked at 6.8 GiB of process-tree memory on about 3
 * cores, a full `check` at 3.9 GiB; a package's tests at 0.5 to 1.5 GiB;
 * an agent process at 0.4 to 0.7 GiB. A worker reserves its agent and
 * the targeted commands it runs; a validation, the mix of targeted item
 * validations and a full final one.
 */
import { availableParallelism, totalmem } from "node:os";
import type { HostCapacity, HostResource } from "./engine.js";

/** MiB kept for the system and the service itself. */
const SYSTEM_MIB = 4096;

/**
 * A planner call reserves nothing by default: steps at once are bounded by
 * maxActiveObjectives times execution.concurrency (24 by default), so
 * beside 12 workers and 6 validations at most 6 planner calls run, about
 * 3.3 GiB, within the budget's spare and the system's 4 GiB. A planner
 * reservation the operator sets only takes memory no free worker or
 * validation slot needs (engine.ts HostLimiter).
 */
export const DEFAULT_RESERVATIONS = {
  worker: 1536,
  validation: 3584,
  planner: 0,
} as const;

export type Reservations = Record<keyof typeof DEFAULT_RESERVATIONS, number>;

/** The host's CPUs and memory, and the defaults sized from them. */
export function hostDefaults(): {
  cpus: number;
  memoryMiB: number;
  workers: number;
  validations: number;
  budgetMiB: number;
} {
  const cpus = availableParallelism();
  const memoryMiB = Math.floor(totalmem() / 2 ** 20);
  return {
    cpus,
    memoryMiB,
    // A worker mostly waits on its model; a validation keeps about 3-4
    // cores busy, so validations take a quarter of the CPUs.
    workers: Math.max(2, Math.floor(cpus / 2)),
    validations: Math.max(2, Math.floor(cpus / 4)),
    budgetMiB: Math.max(1024, memoryMiB - SYSTEM_MIB),
  };
}

/** The configuration's execution section as the limiter applies it. */
export function hostCapacity(
  execution: {
    workers: number;
    validations: number;
    planners: number;
    proofs: number;
    memoryMiB: number;
    reservations: Reservations;
  },
  maxActiveObjectives: number,
): HostCapacity {
  const { reservations } = execution;
  return {
    caps: {
      worker: execution.workers,
      cpu: execution.validations,
      planner: execution.planners,
      proof: execution.proofs,
      github: maxActiveObjectives,
    },
    reserveMiB: {
      worker: reservations.worker,
      cpu: reservations.validation,
      planner: reservations.planner,
      // A proof is a planner call with a few short commands.
      proof: reservations.planner,
      github: 0,
    } satisfies Record<HostResource, number>,
    budgetMiB: execution.memoryMiB,
  };
}

export interface CapacityRecommendation {
  host: { cpus: number; memoryMiB: number };
  /** The host-sized defaults. */
  defaults: { workers: number; validations: number; memoryMiB: number };
  configured: HostCapacity;
  /** MiB that every worker and validation slot in use at once would reserve. */
  fullLoadMiB: number;
  /** What to change, if anything; empty when the configuration fits the host. */
  advice: string[];
}

/**
 * How the configured capacity compares with the host: reported by setup
 * and `status --capacity`, never applied. Raising a limit past the host
 * defaults is the operator's call; it costs memory, and model use.
 */
export function capacityRecommendation(
  configured: HostCapacity,
): CapacityRecommendation {
  const host = hostDefaults();
  const { caps, reserveMiB, budgetMiB } = configured;
  const fullLoadMiB =
    caps.worker * reserveMiB.worker + caps.cpu * reserveMiB.cpu;
  const advice: string[] = [];
  if (budgetMiB > host.budgetMiB)
    advice.push(
      `execution.memoryMiB ${budgetMiB} is more than this host can give (${host.budgetMiB} MiB of ${host.memoryMiB}); lower it, or the kernel may kill a step`,
    );
  if (fullLoadMiB > budgetMiB) {
    const fit = reserveMiB.cpu
      ? Math.floor(
          (budgetMiB - caps.worker * reserveMiB.worker) / reserveMiB.cpu,
        )
      : caps.cpu;
    advice.push(
      `${caps.worker} workers and ${caps.cpu} validations reserve ${fullLoadMiB} MiB together, more than execution.memoryMiB ${budgetMiB}, so at full load some wait for memory; ${fit >= 1 ? `${fit} validations fit beside ${caps.worker} workers` : "lower execution.workers"}`,
    );
  }
  // A validation keeps about 3 cores busy (measured above).
  if (caps.cpu * 3 > host.cpus)
    advice.push(
      `${caps.cpu} validations at about 3 cores each want more than ${host.cpus} CPUs, so each runs slower and nearer its deadline; ${host.validations} fit`,
    );
  return {
    host: { cpus: host.cpus, memoryMiB: host.memoryMiB },
    defaults: {
      workers: host.workers,
      validations: host.validations,
      memoryMiB: host.budgetMiB,
    },
    configured,
    fullLoadMiB,
    advice,
  };
}
