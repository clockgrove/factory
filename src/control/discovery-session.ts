import type { DurableObjectiveActivation } from "./github-store.js";

export const DISCOVERY_SESSION_LIMITS = Object.freeze({
  pageSize: 100,
  candidatesPerLane: 32,
  summaries: 512,
  summaryBytes: 4 * 1024 * 1024,
  pagesPerProbe: 100,
  commentsPerObjective: 10_000,
  commentBytes: 64 * 1024 * 1024,
  telemetryCycles: 64,
  overlapMs: 2 * 60_000,
  closedLookbackMs: 7 * 24 * 60 * 60_000,
  backstopIntervalMs: 15 * 60_000,
});

/** Enumeration deliberately carries no issue body or comment history. */
export interface DiscoveryIssue {
  number: number;
  state: "open" | "closed";
  objectiveLabel: boolean;
  updatedAt: string;
  comments: number;
}
export interface DiscoveryComment {
  id: string;
  issueNumber: number;
  body: string;
  authorLogin: string | null;
  authorAssociation: string | null;
  updatedAt: string;
}
export interface DiscoveryControlRef {
  kind: "lease";
  objective: number;
  ref: string;
  oid: string;
  serverTime: Date;
}
export interface DiscoveryLocator {
  objective: number;
  ref: string;
  oid: string;
}
export interface DiscoveryCollection<T> {
  items: T[];
  requests: number;
  notModified: boolean;
  etag?: string;
  returnedBytes?: number;
}
export interface DiscoveryPage<T> {
  items: T[];
  cursor: string | null;
  serverTime: string;
  requests: number;
  returnedBytes: number;
}
export interface DiscoveryClassification {
  activation: Omit<DurableObjectiveActivation, "discoveryRevision"> | null;
  writerBound: boolean;
  authorityOid: string | null;
  recoveryBound: boolean;
}
export interface GitHubDiscoveryPorts {
  authenticate(): Promise<{ login: string; serverTime: Date }>;
  listIssues(input: {
    state: "open" | "closed";
    since?: string;
    cursor?: string;
  }): Promise<DiscoveryPage<DiscoveryIssue>>;
  listLocators(cursor?: string): Promise<DiscoveryPage<DiscoveryLocator>>;
  readIssue(objective: number, etag?: string): Promise<DiscoveryCollection<DiscoveryIssue>>;
  listObjectiveComments(
    objective: number,
    etag?: string,
  ): Promise<DiscoveryCollection<DiscoveryComment>>;
  classify(input: {
    login: string;
    issue: DiscoveryIssue;
    comments: DiscoveryComment[];
    revision: number;
  }): Promise<DiscoveryClassification>;
}

const partialDiscoveryRequests = new WeakMap<object, number>();
export function recordPartialDiscoveryRequests(error: unknown, requests: number): void {
  if ((typeof error === "object" && error !== null) || typeof error === "function")
    partialDiscoveryRequests.set(error, Math.max(0, Math.floor(requests)));
}
function partialRequests(error: unknown): number {
  return (typeof error === "object" && error !== null) || typeof error === "function"
    ? (partialDiscoveryRequests.get(error) ?? 0)
    : 0;
}

export interface DiscoveryCycleTelemetry {
  sequence: number;
  mode: "bootstrap" | "delta";
  startedAt: string;
  completedAt: string;
  outcome: "complete" | "failed";
  backstop: boolean;
  probes: {
    authenticatedUser: number;
    issues: number;
    repositoryComments: number;
    objectiveComments: number;
    matchingRefs: number;
    classifications: number;
    notModified: number;
  };
  dirtyObjectives: number;
  returnedActivations: number;
  returnedBytes?: number;
  pendingCandidates?: number;
}
export interface DiscoverySessionTelemetry {
  measurementScope: "process-local-discovery-session";
  cycles: DiscoveryCycleTelemetry[];
  droppedCycles: number;
  cachedObjectives: number;
  cachedComments: number;
  retainedSummaryBytes?: number;
  evictedSummaries?: number;
  incompleteScans?: number;
  objectiveErrors?: { objective: number; reason: string }[];
}
interface Summary {
  issue: DiscoveryIssue;
  activation: DurableObjectiveActivation | null;
  revision: number;
  classifiedAt: number;
  issueEtag?: string;
  commentEtag?: string;
  locatorOid?: string;
  error?: string;
}
interface Scan<T> {
  cursor?: string;
  since?: string;
  full?: boolean;
  startedAt?: number;
  page?: DiscoveryPage<T> | undefined;
  next: number;
}
function time(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed))
    throw new Error("discovery response has invalid server/update time");
  return parsed;
}
function since(value: number): string {
  return new Date(Math.max(0, value - DISCOVERY_SESSION_LIMITS.overlapMs)).toISOString();
}
function signature(issue: DiscoveryIssue): string {
  return `${issue.state}:${issue.objectiveLabel}:${issue.updatedAt}:${issue.comments}`;
}

/** Disposable, bounded hints. Each lane streams pages; no lifetime history is
 * accumulated and an incomplete scan never proves absence or advances time.
 * Every emitted hint still requires the Supervisor's fresh authenticated reads. */
export class GitHubDiscoverySession {
  readonly #ports: GitHubDiscoveryPorts;
  readonly #now: () => Date;
  #login?: string;
  #serverOffset = 0;
  #openWatermark = 0;
  #closedWatermark = 0;
  #lastOpenBackstop = Number.NEGATIVE_INFINITY;
  #open: Scan<DiscoveryIssue> | undefined;
  #closed: Scan<DiscoveryIssue> | undefined;
  #locators: Scan<DiscoveryLocator> | undefined;
  readonly #summaries = new Map<number, Summary>();
  #summaryBytes = 0;
  #evicted = 0;
  #sequence = 0;
  #revision = 0;
  #cycles: DiscoveryCycleTelemetry[] = [];
  #droppedCycles = 0;

  constructor(ports: GitHubDiscoveryPorts, now: () => Date = () => new Date()) {
    this.#ports = ports;
    this.#now = now;
  }

  async discover(knownObjectives: readonly number[] = []): Promise<DurableObjectiveActivation[]> {
    const startedAt = this.#now();
    const cycle: DiscoveryCycleTelemetry = {
      sequence: ++this.#sequence,
      mode: this.#login ? "delta" : "bootstrap",
      startedAt: startedAt.toISOString(),
      completedAt: startedAt.toISOString(),
      outcome: "complete",
      backstop: false,
      probes: {
        authenticatedUser: 0,
        issues: 0,
        repositoryComments: 0,
        objectiveComments: 0,
        matchingRefs: 0,
        classifications: 0,
        notModified: 0,
      },
      dirtyObjectives: 0,
      returnedActivations: 0,
      returnedBytes: 0,
    };
    const touched = new Set<number>();
    try {
      if (!this.#login) {
        try {
          const identity = await this.#ports.authenticate();
          cycle.probes.authenticatedUser++;
          this.#login = identity.login.toLowerCase();
          this.#serverOffset = identity.serverTime.getTime() - startedAt.getTime();
          if (!Number.isFinite(this.#serverOffset))
            throw new Error("invalid authentication server time");
        } catch (error) {
          cycle.probes.authenticatedUser += partialRequests(error);
          throw error;
        }
      }
      const now = this.#now().getTime() + this.#serverOffset;
      this.#open ??=
        now - this.#lastOpenBackstop >= DISCOVERY_SESSION_LIMITS.backstopIntervalMs
          ? { full: true, next: 0 }
          : { since: since(this.#openWatermark), next: 0 };
      this.#closed ??= {
        since: since(
          Math.max(this.#closedWatermark, now - DISCOVERY_SESSION_LIMITS.closedLookbackMs),
        ),
        next: 0,
      };
      this.#locators ??= { next: 0 };
      cycle.backstop = this.#open.full === true;
      // Exact known work is independent of filtered pagination or label edits.
      for (const objective of new Set([
        ...knownObjectives,
        ...[...this.#summaries.values()]
          .filter((summary) => summary.activation)
          .map((summary) => summary.issue.number),
      ]))
        await this.#target(objective, cycle, touched);
      await this.#issueLane("open", this.#open, cycle, touched);
      await this.#issueLane("closed", this.#closed, cycle, touched);
      await this.#locatorLane(this.#locators, cycle, touched);
      const activations = [...this.#summaries.values()].flatMap((summary) =>
        summary.activation ? [summary.activation] : [],
      );
      cycle.returnedActivations = activations.length;
      return activations;
    } catch (error) {
      cycle.outcome = "failed";
      throw error;
    } finally {
      cycle.completedAt = this.#now().toISOString();
      cycle.pendingCandidates = this.#pending();
      this.#cycles.push(cycle);
      if (this.#cycles.length > DISCOVERY_SESSION_LIMITS.telemetryCycles) {
        this.#cycles.shift();
        this.#droppedCycles++;
      }
    }
  }

  async #probe<T extends { requests: number; returnedBytes?: number }>(
    cycle: DiscoveryCycleTelemetry,
    kind: "issues" | "objectiveComments" | "matchingRefs",
    read: () => Promise<T>,
  ): Promise<T> {
    try {
      const result = await read();
      cycle.probes[kind] += result.requests;
      cycle.returnedBytes! += result.returnedBytes ?? 0;
      if ("notModified" in result && result.notModified) cycle.probes.notModified++;
      return result;
    } catch (error) {
      cycle.probes[kind] += partialRequests(error);
      throw error;
    }
  }

  async #issueLane(
    state: "open" | "closed",
    scan: Scan<DiscoveryIssue>,
    cycle: DiscoveryCycleTelemetry,
    touched: Set<number>,
  ): Promise<void> {
    if (!scan.page) {
      const page = await this.#probe(cycle, "issues", () =>
        this.#ports.listIssues({
          state,
          ...(scan.since ? { since: scan.since } : {}),
          ...(scan.cursor ? { cursor: scan.cursor } : {}),
        }),
      );
      this.#validatePage(page, scan.cursor);
      scan.page = page;
      scan.startedAt ??= time(page.serverTime);
    }
    for (
      let count = 0;
      scan.next < scan.page.items.length && count < DISCOVERY_SESSION_LIMITS.candidatesPerLane;
      count++, scan.next++
    ) {
      const issue = scan.page.items[scan.next]!;
      if (touched.has(issue.number)) continue;
      await this.#consider(issue, cycle, touched);
    }
    if (scan.next < scan.page.items.length) return;
    const cursor = scan.page.cursor;
    scan.page = undefined;
    scan.next = 0;
    if (cursor) {
      scan.cursor = cursor;
      return;
    }
    // Only complete relevant traversals advance a watermark. The initial server
    // time (not the newest row) protects edits entering an already-read page.
    if (state === "open") {
      this.#openWatermark = Math.max(this.#openWatermark, scan.startedAt!);
      if (scan.full) this.#lastOpenBackstop = scan.startedAt!;
      this.#open = undefined;
    } else {
      this.#closedWatermark = Math.max(this.#closedWatermark, scan.startedAt!);
      this.#closed = undefined;
    }
  }

  async #locatorLane(
    scan: Scan<DiscoveryLocator>,
    cycle: DiscoveryCycleTelemetry,
    touched: Set<number>,
  ): Promise<void> {
    if (!scan.page) {
      const page = await this.#probe(cycle, "matchingRefs", () =>
        this.#ports.listLocators(scan.cursor),
      );
      this.#validatePage(page, scan.cursor);
      scan.page = page;
    }
    for (
      let count = 0;
      scan.next < scan.page.items.length && count < DISCOVERY_SESSION_LIMITS.candidatesPerLane;
      count++, scan.next++
    ) {
      const locator = scan.page.items[scan.next]!;
      // Different immutable scope names can share one Objective; hydrate at most
      // once per cycle. A later sweep still sees any concurrently created scope.
      if (!touched.has(locator.objective))
        await this.#target(locator.objective, cycle, touched, locator.oid);
    }
    if (scan.next < scan.page.items.length) return;
    const cursor = scan.page.cursor;
    scan.page = undefined;
    scan.next = 0;
    if (cursor) scan.cursor = cursor;
    else this.#locators = undefined;
  }

  #validatePage<T>(page: DiscoveryPage<T>, previous?: string): void {
    time(page.serverTime);
    if (
      page.items.length > DISCOVERY_SESSION_LIMITS.pageSize ||
      (page.cursor !== null && (!page.cursor || page.cursor === previous))
    )
      throw new Error("invalid bounded discovery page/cursor");
  }

  async #target(
    objective: number,
    cycle: DiscoveryCycleTelemetry,
    touched: Set<number>,
    locatorOid?: string,
  ): Promise<void> {
    const prior = this.#summaries.get(objective);
    try {
      const response = await this.#probe(cycle, "issues", () =>
        this.#ports.readIssue(objective, prior?.issueEtag),
      );
      const issue = response.notModified ? prior?.issue : response.items[0];
      if (!issue)
        throw new Error(`exact Objective #${objective} is unavailable; absence is unproven`);
      await this.#consider(issue, cycle, touched, { issueEtag: response.etag, locatorOid });
    } catch (error) {
      if (this.#platformError(error)) throw error;
      touched.add(objective);
      this.#retain(objective, {
        issue: prior?.issue ?? {
          number: objective,
          state: "closed",
          objectiveLabel: false,
          updatedAt: this.#now().toISOString(),
          comments: 0,
        },
        activation: null,
        revision: ++this.#revision,
        classifiedAt: this.#now().getTime() + this.#serverOffset,
        error:
          error instanceof Error
            ? error.message.slice(0, 1000)
            : "exact Objective unavailable; obligations retained",
      });
    }
  }

  async #consider(
    issue: DiscoveryIssue,
    cycle: DiscoveryCycleTelemetry,
    touched: Set<number>,
    exact?: { issueEtag?: string | undefined; locatorOid?: string | undefined },
  ): Promise<void> {
    touched.add(issue.number);
    const prior = this.#summaries.get(issue.number);
    const now = this.#now().getTime() + this.#serverOffset;
    const unchanged =
      prior &&
      signature(prior.issue) === signature(issue) &&
      (!exact?.locatorOid || prior.locatorOid === exact.locatorOid);
    if (unchanged && now - prior.classifiedAt < DISCOVERY_SESSION_LIMITS.backstopIntervalMs) {
      this.#retain(issue.number, {
        ...prior,
        ...(exact?.issueEtag ? { issueEtag: exact.issueEtag } : {}),
      });
      return;
    }
    const summary: Summary = {
      issue,
      activation: null,
      revision: ++this.#revision,
      classifiedAt: now,
      ...(exact?.issueEtag ? { issueEtag: exact.issueEtag } : {}),
      ...(exact?.locatorOid ? { locatorOid: exact.locatorOid } : {}),
    };
    try {
      // A removed label is still reconciled when exact admitted/acknowledged work
      // locates it. Filter membership itself grants no authority.
      const comments =
        issue.comments === 0
          ? { items: [], requests: 0, notModified: false }
          : await this.#probe(cycle, "objectiveComments", () =>
              this.#ports.listObjectiveComments(issue.number),
            );
      if (comments.notModified)
        throw new Error("history-free classification cannot accept 304 comments");
      if (
        comments.items.length > DISCOVERY_SESSION_LIMITS.commentsPerObjective ||
        comments.items.reduce((bytes, comment) => bytes + Buffer.byteLength(comment.body), 0) >
          DISCOVERY_SESSION_LIMITS.commentBytes
      )
        throw new Error(`Objective #${issue.number} exceeds its transient history bound`);
      const classified = await this.#ports.classify({
        login: this.#login!,
        issue,
        comments: comments.items,
        revision: summary.revision,
      });
      cycle.probes.classifications++;
      cycle.dirtyObjectives++;
      summary.activation = classified.activation
        ? { ...classified.activation, discoveryRevision: summary.revision }
        : null;
      if (!summary.activation && exact?.locatorOid)
        summary.error =
          "Outstanding discovery locator has no runnable activation; inspect the exact Objective's resource/accounting disposition. Terminal work is not restarted.";
    } catch (error) {
      // Platform waits preserve the lane cursor. Durable per-Objective errors are
      // isolated diagnostics; they must not stop independent repository work.
      if (this.#platformError(error)) throw error;
      summary.error =
        error instanceof Error ? error.message.slice(0, 1000) : "Objective classification failed";
    }
    this.#retain(issue.number, summary);
  }

  #platformError(error: unknown): boolean {
    return (
      error instanceof Error &&
      (error.name === "PlatformUnavailableError" ||
        error.name.includes("Quota") ||
        error.name.includes("Abort"))
    );
  }

  #retain(objective: number, summary: Summary): void {
    this.#summaries.delete(objective);
    if (summary.issue.state === "open" || summary.activation || summary.error)
      this.#summaries.set(objective, summary);
    this.#summaryBytes = [...this.#summaries.values()].reduce(
      (total, value) => total + Buffer.byteLength(JSON.stringify(value)),
      0,
    );
    while (
      this.#summaries.size > DISCOVERY_SESSION_LIMITS.summaries ||
      this.#summaryBytes > DISCOVERY_SESSION_LIMITS.summaryBytes
    ) {
      const oldest = this.#summaries.keys().next().value!;
      this.#summaryBytes -= Buffer.byteLength(JSON.stringify(this.#summaries.get(oldest)));
      this.#summaries.delete(oldest);
      this.#evicted++;
    }
    // Eviction removes only disposable scheduling hints. Open scans and durable
    // exact locators remain the discovery source; no liability is discharged.
  }

  #pending(): number {
    return [this.#open, this.#closed, this.#locators].reduce(
      (total, scan) => total + (scan?.page ? scan.page.items.length - scan.next : 0),
      0,
    );
  }
  telemetry(): DiscoverySessionTelemetry {
    return {
      measurementScope: "process-local-discovery-session",
      cycles: this.#cycles.map((cycle) => ({ ...cycle, probes: { ...cycle.probes } })),
      droppedCycles: this.#droppedCycles,
      cachedObjectives: this.#summaries.size,
      cachedComments: 0,
      retainedSummaryBytes: this.#summaryBytes,
      evictedSummaries: this.#evicted,
      incompleteScans: [this.#open, this.#closed, this.#locators].filter(Boolean).length,
      objectiveErrors: [...this.#summaries]
        .flatMap(([objective, summary]) =>
          summary.error ? [{ objective, reason: summary.error }] : [],
        )
        .slice(-64),
    };
  }
}
