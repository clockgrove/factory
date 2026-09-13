import type { MutationWaitReasons } from "../platform.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
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
  /** Factory mutation admission only; excludes client hooks and HTTP. */
  queueWaitMs: number;
  clientPreTransportMs: number;
  fetchResponseMs: number;
  quotaWaitMs: number;
  waitReasonMs: MutationWaitReasons;
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

const current = new AsyncLocalStorage<Context | undefined>();

/** Inclusive of nested phases. Counts and aggregate times are not additive across phases. */
export interface GitHubTransportObservation {
  measurementScope: "process-local-controller-phase";
  phase: string;
  startedAt: string;
  endedAt: string;
  elapsedMs: number;
  /** Summed operation time: concurrent waits/fences can overlap elapsed time. */
  /** Factory mutation admission only; excludes client hooks and HTTP. */
  aggregateQueueWaitMs: number;
  aggregateClientPreTransportMs: number;
  aggregateFetchResponseMs: number;
  aggregateQuotaWaitMs: number;
  quotaWaitReasonMs: Partial<Record<"primary" | "local-window" | "server", number>>;
  aggregateFenceMs: number;
  mutationWaitReasonMs: MutationWaitReasons;
  requestsByRoute: Partial<Record<GitHubRouteFamily, number>>;
  readRequests: number;
  mutationRequests: number;
  unclassifiedRequests: number;
  outcome: "succeeded" | "failed";
}

interface PhaseContext {
  observation: GitHubTransportObservation;
  parent: PhaseContext | undefined;
}

const transportObservation = new AsyncLocalStorage<PhaseContext | undefined>();

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

export type GitHubRouteFamily =
  | "graphql"
  | "capacity-ref"
  | "lease-ref"
  | "other-ref"
  | "git-commit"
  | "git-tree"
  | "git-blob"
  | "issue-comments"
  | "issues"
  | "pulls"
  | "checks"
  | "repository"
  | "other";

/** Fixed labels only: never retain repository names, identifiers or query text. */
function routeFamily(url: string): GitHubRouteFamily {
  let path: string;
  try {
    path = decodeURIComponent(new URL(url).pathname);
  } catch {
    return "other";
  }
  if (path === "/graphql") return "graphql";
  if (/\/git\/(?:ref|refs)\//.test(path)) {
    if (path.includes("clockgrove-factory/coordination/capacity")) return "capacity-ref";
    if (path.includes("clockgrove-factory/leases/")) return "lease-ref";
    return "other-ref";
  }
  if (/\/git\/commits(?:\/|$)/.test(path)) return "git-commit";
  if (/\/git\/trees(?:\/|$)/.test(path)) return "git-tree";
  if (/\/git\/blobs(?:\/|$)/.test(path)) return "git-blob";
  if (/\/issues(?:\/[^/]+)?\/comments(?:\/|$)/.test(path)) return "issue-comments";
  if (/\/issues(?:\/|$)/.test(path)) return "issues";
  if (/\/pulls(?:\/|$)/.test(path)) return "pulls";
  if (/\/(?:check-runs|check-suites|statuses|status)(?:\/|$)/.test(path)) return "checks";
  if (/^\/repos\/[^/]+\/[^/]+\/?$/.test(path)) return "repository";
  return "other";
}

/** Count actual fetch attempts, not method wrappers, permits or hidden retries. */
export function observeGitHubTransport(
  input: Parameters<typeof globalThis.fetch>[0],
  init?: RequestInit,
): void {
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const route = routeFamily(url);
  observePhases((observation) => {
    observation.requestsByRoute[route] = (observation.requestsByRoute[route] ?? 0) + 1;
  });
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

/** One record per attempted HTTP transport; scopes and nested phases are not summed. */
export interface GitHubTransportAttempt {
  measurementScope: "process-local-http-attempt";
  operation: string;
  phase: string;
  route: GitHubRouteFamily;
  kind: "read" | "write" | "unclassified";
  reason: "fence" | "operation" | "outside-operation";
  objectIdentity: string;
  /** Fetch invocation to response headers/error; excludes body consumption. */
  fetchResponseMs: number;
  requestBytes?: number;
  responseBytes?: number;
  status?: number;
  outcome: "response" | "transport-error";
}

const traceOperations = new Set([
  "createCommit",
  "createRef",
  "compareAndSwapRef",
  "addIssueComment",
  "createDiscoveryLabel",
  "labelObjective",
  "deleteExactDiscoveryRef",
  "createBlob",
  "createTree",
  "createPullRequest",
  "mergePullRequest",
  "closePullRequest",
  "closeIssue",
  "assignIssue",
  "dispatch-write",
  "graph-write",
  "normal-mutation",
  "lease-mutation",
  "cleanup-mutation",
]);
const tracePhases = new Set([
  "objective",
  "compilation",
  "validation",
  "review",
  "integration",
  "activation-discovery",
  "repository-facts",
  "default-branch-head",
  "repository-lease-acquisition",
  "shared-capacity",
]);

function tracePhase(phase: string | undefined): string {
  if (phase === undefined) return "outside-phase";
  if (/^work-item-\d+$/.test(phase)) return "work-item";
  return tracePhases.has(phase) ? phase : "other-phase";
}

const attemptTrace = new AsyncLocalStorage<
  ((attempt: GitHubTransportAttempt) => void) | undefined
>();

/** The caller owns bounded retention; no bodies, credentials or raw URLs leave this boundary. */
export function observeGitHubTransportTrace<T>(
  report: (attempt: GitHubTransportAttempt) => void,
  work: () => Promise<T>,
): Promise<T> {
  return attemptTrace.run(report, work);
}

/** Carry only diagnostic context across Octokit's scheduler, which can resume
 * under another async resource. Authority/quota contexts are deliberately excluded. */
export function captureGitHubTransportObservation(): (<T>(work: () => T) => T) | undefined {
  const operation = current.getStore();
  const phase = transportObservation.getStore();
  const trace = attemptTrace.getStore();
  if (!operation && !phase && !trace) return undefined;
  return (work) =>
    current.run(operation, () =>
      transportObservation.run(phase, () => attemptTrace.run(trace, work)),
    );
}

/** Called after admission, immediately before fetch. Returns an observation-only completion hook. */
export function beginGitHubTransportAttempt(
  input: Parameters<typeof globalThis.fetch>[0],
  init?: RequestInit,
): (response?: Response) => void {
  observeGitHubTransport(input, init);
  const report = attemptTrace.getStore();
  const started = performance.now();
  const context = current.getStore();
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const route = routeFamily(url);
  let kind: GitHubTransportAttempt["kind"] =
    method === "GET" || method === "HEAD" ? "read" : "write";
  if (route === "graphql" && kind === "write") {
    kind = "unclassified";
    try {
      const query: unknown = JSON.parse(String(init?.body)).query;
      if (typeof query === "string") {
        const normalized = query.replace(/#[^\n]*/g, "").trimStart();
        if (/^(?:query\b|\{)/.test(normalized)) kind = "read";
        else if (/^mutation\b/.test(normalized)) kind = "write";
      }
    } catch {
      // Unknown bodies remain unknown; never read a stream for diagnostics.
    }
  }
  const body = init?.body;
  const requestBytes =
    typeof body === "string"
      ? Buffer.byteLength(body)
      : body instanceof ArrayBuffer
        ? body.byteLength
        : ArrayBuffer.isView(body)
          ? body.byteLength
          : body === undefined || body === null
            ? input instanceof Request
              ? undefined
              : 0
            : undefined;
  const attempt = {
    measurementScope: "process-local-http-attempt" as const,
    operation: !context
      ? "outside-operation"
      : traceOperations.has(context.observation.operation)
        ? context.observation.operation
        : "other-operation",
    phase: tracePhase(transportObservation.getStore()?.observation.phase),
    route,
    kind,
    reason: context?.fencing
      ? ("fence" as const)
      : context
        ? ("operation" as const)
        : ("outside-operation" as const),
    objectIdentity: createHash("sha256").update(url).digest("hex"),
    ...(requestBytes === undefined ? {} : { requestBytes }),
  };
  let completed = false;
  return (response) => {
    if (completed) return;
    completed = true;
    const fetchResponseMs = performance.now() - started;
    if (context) context.observation.fetchResponseMs += fetchResponseMs;
    observePhases((observation) => (observation.aggregateFetchResponseMs += fetchResponseMs));
    const length = response?.headers.get("content-length");
    const responseBytes = length && /^\d+$/.test(length) ? Number(length) : undefined;
    try {
      report?.(
        Object.freeze({
          ...attempt,
          fetchResponseMs,
          ...(response ? { status: response.status } : {}),
          ...(responseBytes !== undefined && Number.isSafeInteger(responseBytes)
            ? { responseBytes }
            : {}),
          outcome: response ? "response" : "transport-error",
        }),
      );
    } catch {
      // A rejected diagnostic sink cannot change a completed remote effect.
    }
  };
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
    aggregateClientPreTransportMs: 0,
    aggregateFetchResponseMs: 0,
    aggregateQuotaWaitMs: 0,
    quotaWaitReasonMs: {},
    aggregateFenceMs: 0,
    mutationWaitReasonMs: {},
    requestsByRoute: {},
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

export function observeMutationQueue(waitedMs: number, reasons: MutationWaitReasons = {}): void {
  const context = current.getStore();
  if (context) context.observation.queueWaitMs += waitedMs;
  observePhases((observation) => (observation.aggregateQueueWaitMs += waitedMs));
  for (const key of [
    "mutation-spacing",
    "rolling-minute",
    "rolling-hour",
    "admission-contention",
  ] as const) {
    const ms = reasons[key];
    if (ms === undefined) continue;
    if (context)
      context.observation.waitReasonMs[key] = (context.observation.waitReasonMs[key] ?? 0) + ms;
    observePhases((observation) => {
      observation.mutationWaitReasonMs[key] = (observation.mutationWaitReasonMs[key] ?? 0) + ms;
    });
  }
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
    clientPreTransportMs: 0,
    fetchResponseMs: 0,
    quotaWaitMs: 0,
    waitReasonMs: {},
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

export function observeReactiveQuotaWait(wait: {
  reason: "primary" | "local-window" | "server";
  waitedMs: number;
}): void {
  const context = current.getStore();
  if (context) context.observation.quotaWaitMs += wait.waitedMs;
  observePhases((observation) => {
    observation.aggregateQuotaWaitMs += wait.waitedMs;
    observation.quotaWaitReasonMs[wait.reason] =
      (observation.quotaWaitReasonMs[wait.reason] ?? 0) + wait.waitedMs;
  });
}

/** After client admission to fetch entry: serialization/hooks, not proven queue time.
 * Excludes outer Factory waits/fences; those can contain nested requests. */
export function observeGitHubClientDispatch(elapsedMs: number): void {
  const context = current.getStore();
  if (context) context.observation.clientPreTransportMs += elapsedMs;
  observePhases((observation) => (observation.aggregateClientPreTransportMs += elapsedMs));
}
