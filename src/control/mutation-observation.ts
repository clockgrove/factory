import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

export interface MutationOperationObservation {
  measurementScope: "process-local-transport-boundary";
  operationId: string;
  operation: string;
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

export interface GitHubTransportObservation {
  measurementScope: "process-local-controller-phase";
  phase: string;
  startedAt: string;
  readRequests: number;
  mutationRequests: number;
  unclassifiedRequests: number;
  outcome: "succeeded" | "failed";
}

const transportObservation = new AsyncLocalStorage<GitHubTransportObservation>();

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
    const observation = transportObservation.getStore();
    if (observation) observation.readRequests++;
    return;
  }
  try {
    if (new URL(url).pathname === "/graphql") {
      const query: unknown = JSON.parse(String(init?.body)).query;
      if (typeof query === "string") {
        const normalized = query.replace(/#[^\n]*/g, "").trimStart();
        if (/^(?:query\b|\{)/.test(normalized)) {
          observeControlTransport(false);
          const observation = transportObservation.getStore();
          if (observation) observation.readRequests++;
          return;
        }
        if (/^mutation\b/.test(normalized)) {
          observeControlTransport(true);
          const observation = transportObservation.getStore();
          if (observation) observation.mutationRequests++;
          return;
        }
      }
      const mutation = current.getStore();
      if (mutation) mutation.observation.unclassifiedRequests++;
      const observation = transportObservation.getStore();
      if (observation) observation.unclassifiedRequests++;
      return;
    }
  } catch {
    // Diagnostic parsing cannot invalidate transport or silently guess its kind.
    const mutation = current.getStore();
    if (mutation) mutation.observation.unclassifiedRequests++;
    const observation = transportObservation.getStore();
    if (observation) observation.unclassifiedRequests++;
    return;
  }
  observeControlTransport(true);
  const observation = transportObservation.getStore();
  if (observation) observation.mutationRequests++;
}

/** Process-local request accounting only; never a durable authority or quota grant. */
export async function observeGitHubTransportPhase<T>(
  phase: string,
  report: (observation: GitHubTransportObservation) => void,
  operation: () => Promise<T>,
): Promise<T> {
  const observation: GitHubTransportObservation = {
    measurementScope: "process-local-controller-phase",
    phase,
    startedAt: new Date().toISOString(),
    readRequests: 0,
    mutationRequests: 0,
    unclassifiedRequests: 0,
    outcome: "failed",
  };
  return transportObservation.run(observation, async () => {
    try {
      const result = await operation();
      observation.outcome = "succeeded";
      return result;
    } finally {
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
  if (!context) return operation();
  const previous = context.fencing;
  const started = performance.now();
  context.fencing = true;
  try {
    await operation();
  } finally {
    context.fencing = previous;
    context.observation.fenceMs += performance.now() - started;
  }
}

export function observeMutationQueue(waitedMs: number): void {
  const context = current.getStore();
  if (context) context.observation.queueWaitMs += waitedMs;
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
