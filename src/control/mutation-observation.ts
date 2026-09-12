import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

export interface MutationOperationObservation {
  measurementScope: "process-local-transport-boundary";
  operationId: string;
  operation: string;
  /** Innermost controller phase, when the operation runs inside one. */
  phase?: string;
  authorityClass: MutationAuthorityClass;
  resourceScope: string;
  startedAt: string;
  elapsedMs: number;
  queueWaitMs: number;
  fenceMs: number;
  leaseAssertions: number;
  readRequests: number;
  fenceReadRequests: number;
  mutationRequests: number;
  unclassifiedRequests: number;
  outcome: "succeeded" | "failed";
}

/** Authority needed by a GitHub write, independently of its pacing priority. */
export type MutationAuthorityClass =
  | "immutable-preparation"
  | "objective-publication"
  | "atomic-publication";

interface Context {
  observation: MutationOperationObservation;
  fencing: boolean;
}

const current = new AsyncLocalStorage<Context>();

/** Inclusive of nested phases. Counts and aggregate times are not additive across phases. */
export interface GitHubTransportObservation {
  measurementScope: "process-local-controller-phase";
  phase: string;
  startedAt: string;
  endedAt: string;
  elapsedMs: number;
  /** Summed operation time: concurrent waits/fences can overlap elapsed time. */
  aggregateQueueWaitMs: number;
  aggregateFenceMs: number;
  readRequests: number;
  mutationRequests: number;
  unclassifiedRequests: number;
  outcome: "succeeded" | "failed";
}

interface PhaseContext {
  observation: GitHubTransportObservation;
  parent: PhaseContext | undefined;
}

const transportObservation = new AsyncLocalStorage<PhaseContext>();

/** Parent phases include child work; phase totals must not be added together. */
function observePhases(observe: (observation: GitHubTransportObservation) => void): void {
  for (let phase = transportObservation.getStore(); phase; phase = phase.parent) {
    observe(phase.observation);
  }
}

/** These measurements never supply lease, accounting, or GitHub quota authority. */
export function observeLeaseAssertion(): void {
  const context = current.getStore();
  if (context) context.observation.leaseAssertions++;
}

export function observeControlTransport(mutating: boolean): void {
  const context = current.getStore();
  if (!context) return;
  if (mutating) context.observation.mutationRequests++;
  else {
    context.observation.readRequests++;
    if (context.fencing) context.observation.fenceReadRequests++;
  }
}

/** Count actual fetch attempts, not method wrappers, permits or hidden retries. */
export function observeGitHubTransport(
  input: Parameters<typeof globalThis.fetch>[0],
  init?: RequestInit,
): void {
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (method === "GET" || method === "HEAD") {
    observeControlTransport(false);
    observePhases((observation) => observation.readRequests++);
    return;
  }
  try {
    if (new URL(url).pathname === "/graphql") {
      const query: unknown = JSON.parse(String(init?.body)).query;
      if (typeof query === "string") {
        const normalized = query.replace(/#[^\n]*/g, "").trimStart();
        if (/^(?:query\b|\{)/.test(normalized)) {
          observeControlTransport(false);
          observePhases((observation) => observation.readRequests++);
          return;
        }
        if (/^mutation\b/.test(normalized)) {
          observeControlTransport(true);
          observePhases((observation) => observation.mutationRequests++);
          return;
        }
      }
      const mutation = current.getStore();
      if (mutation) mutation.observation.unclassifiedRequests++;
      observePhases((observation) => observation.unclassifiedRequests++);
      return;
    }
  } catch {
    // Diagnostic parsing cannot invalidate transport or silently guess its kind.
    const mutation = current.getStore();
    if (mutation) mutation.observation.unclassifiedRequests++;
    observePhases((observation) => observation.unclassifiedRequests++);
    return;
  }
  observeControlTransport(true);
  observePhases((observation) => observation.mutationRequests++);
}

/** Process-local request accounting only; never a durable authority or quota grant. */
export async function observeGitHubTransportPhase<T>(
  phase: string,
  report: (observation: GitHubTransportObservation) => void,
  operation: () => Promise<T>,
): Promise<T> {
  const started = performance.now();
  const observation: GitHubTransportObservation = {
    measurementScope: "process-local-controller-phase",
    phase,
    startedAt: new Date().toISOString(),
    endedAt: "",
    elapsedMs: 0,
    aggregateQueueWaitMs: 0,
    aggregateFenceMs: 0,
    readRequests: 0,
    mutationRequests: 0,
    unclassifiedRequests: 0,
    outcome: "failed",
  };
  const context: PhaseContext = { observation, parent: transportObservation.getStore() };
  return transportObservation.run(context, async () => {
    try {
      const result = await operation();
      observation.outcome = "succeeded";
      return result;
    } finally {
      observation.endedAt = new Date().toISOString();
      observation.elapsedMs = performance.now() - started;
      try {
        report(Object.freeze({ ...observation }));
      } catch {
        // Accounting is diagnostic and cannot alter controller safety.
      }
    }
  });
}

export async function observeMutationFence(operation: () => Promise<void>): Promise<void> {
  const context = current.getStore();
  const phase = transportObservation.getStore();
  if (!context && !phase) return operation();
  const previous = context?.fencing;
  const started = performance.now();
  if (context) context.fencing = true;
  try {
    await operation();
  } finally {
    const elapsed = performance.now() - started;
    if (context) {
      context.fencing = previous!;
      context.observation.fenceMs += elapsed;
    }
    observePhases((observation) => (observation.aggregateFenceMs += elapsed));
  }
}

export function observeMutationQueue(waitedMs: number): void {
  const context = current.getStore();
  if (context) context.observation.queueWaitMs += waitedMs;
  observePhases((observation) => (observation.aggregateQueueWaitMs += waitedMs));
}

export async function observeMutationOperation<T>(
  operation: string,
  authorityClass: MutationAuthorityClass,
  resourceScope: string,
  report: (observation: MutationOperationObservation) => void,
  work: () => Promise<T>,
): Promise<T> {
  const started = performance.now();
  const observation: MutationOperationObservation = {
    measurementScope: "process-local-transport-boundary",
    operationId: randomUUID(),
    operation,
    ...(transportObservation.getStore()
      ? { phase: transportObservation.getStore()!.observation.phase }
      : {}),
    authorityClass,
    resourceScope,
    startedAt: new Date().toISOString(),
    elapsedMs: 0,
    queueWaitMs: 0,
    fenceMs: 0,
    leaseAssertions: 0,
    readRequests: 0,
    fenceReadRequests: 0,
    mutationRequests: 0,
    unclassifiedRequests: 0,
    outcome: "failed",
  };
  return current.run({ observation, fencing: false }, async () => {
    try {
      const result = await work();
      observation.outcome = "succeeded";
      return result;
    } finally {
      observation.elapsedMs = performance.now() - started;
      // An optional diagnostic sink cannot invalidate an already-completed write.
      try {
        report(Object.freeze({ ...observation }));
      } catch {
        // Reporting is observational, not part of the durable mutation protocol.
      }
    }
  });
}
