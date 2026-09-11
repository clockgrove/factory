import type { DurableObjectiveActivation } from "./github-store.js";

export const DISCOVERY_SESSION_LIMITS = Object.freeze({
  pagesPerProbe: 100,
  objectives: 10_000,
  commentsPerObjective: 10_000,
  totalComments: 100_000,
  commentBytes: 64 * 1024 * 1024,
  controlRefs: 10_000,
  telemetryCycles: 64,
  overlapMs: 1_000,
  backstopIntervalMs: 15 * 60_000,
});

export interface DiscoveryIssue {
  number: number;
  state: "open" | "closed";
  labels: string[];
  title: string;
  body: string;
  pullRequest: boolean;
  updatedAt: string;
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
  kind: "lease" | "recovery-plan";
  objective: number;
  ref: string;
  oid: string;
  serverTime: Date;
}

export interface DiscoveryCollection<T> {
  items: T[];
  requests: number;
  notModified: boolean;
  etag?: string;
  /** For a multi-page collection ordered by immutable creation identity, the
   * first response's server time is the latest watermark known complete. */
  safeThrough?: string;
}

const partialDiscoveryRequests = new WeakMap<object, number>();

/** Retain completed/transported pages when a paginated adapter fails before it
 * can return its collection. The original error identity remains intact so a
 * platform refusal is still classified and delayed by the controller. */
export function recordPartialDiscoveryRequests(error: unknown, requests: number): void {
  if ((typeof error !== "object" && typeof error !== "function") || error === null) return;
  partialDiscoveryRequests.set(error, Math.max(0, Math.floor(requests)));
}

function recordedPartialDiscoveryRequests(error: unknown): number {
  if ((typeof error !== "object" && typeof error !== "function") || error === null) return 0;
  return partialDiscoveryRequests.get(error) ?? 0;
}

export interface DiscoveryClassification {
  activation: Omit<DurableObjectiveActivation, "discoveryRevision"> | null;
  writerBound: boolean;
  authorityOid: string | null;
  recoveryBound: boolean;
}

export interface GitHubDiscoveryPorts {
  authenticate(): Promise<{ login: string; serverTime: Date }>;
  listLabelledIssues(etag?: string): Promise<DiscoveryCollection<DiscoveryIssue>>;
  listIssueDelta(since: string, etag?: string): Promise<DiscoveryCollection<DiscoveryIssue>>;
  listRepositoryComments(
    since: string,
    etag?: string,
  ): Promise<DiscoveryCollection<DiscoveryComment>>;
  listObjectiveComments(
    objective: number,
    etag?: string,
  ): Promise<DiscoveryCollection<DiscoveryComment>>;
  listControlRefs(etag?: string): Promise<DiscoveryCollection<DiscoveryControlRef>>;
  classify(input: {
    login: string;
    issue: DiscoveryIssue;
    comments: DiscoveryComment[];
    revision: number;
    authority?: DiscoveryControlRef | null;
  }): Promise<DiscoveryClassification>;
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
}

export interface DiscoverySessionTelemetry {
  measurementScope: "process-local-discovery-session";
  cycles: DiscoveryCycleTelemetry[];
  droppedCycles: number;
  cachedObjectives: number;
  cachedComments: number;
}

interface CachedObjective {
  issue: DiscoveryIssue;
  comments: Map<string, DiscoveryComment>;
  revision: number;
  writerBound: boolean;
  authorityOid: string | null;
  recoveryBound: boolean;
  recoveryRefsFingerprint: string | null;
  activation: DurableObjectiveActivation | null;
}

interface SessionState {
  login: string;
  objectives: Map<number, CachedObjective>;
  issueWatermark: number;
  commentWatermark: number;
  slowCommentWatermark: number;
  issueDeltaEtag?: string;
  commentDeltaEtag?: string;
  labelledIssuesEtag?: string;
  slowCommentsEtag?: string;
  refsEtag?: string;
  lastBackstopAt: number;
}

interface BootstrapProgress {
  identity: { login: string; serverTime: Date };
  labelled: DiscoveryCollection<DiscoveryIssue>;
  objectives: Map<number, CachedObjective>;
  nextIssue: number;
  comments: number;
  commentBytes: number;
  startedAt: number;
}

interface DeltaProgress {
  base: SessionState;
  startedAt: number;
  backstop: boolean;
  issues?: DiscoveryCollection<DiscoveryIssue>;
  comments?: DiscoveryCollection<DiscoveryComment>;
  labelled?: DiscoveryCollection<DiscoveryIssue>;
  slowComments?: DiscoveryCollection<DiscoveryComment>;
  refs?: DiscoveryCollection<DiscoveryControlRef>;
  labelledDone: boolean;
  slowCommentsDone: boolean;
  refsDone: boolean;
  objectives?: Map<number, CachedObjective>;
  dirty?: Set<number>;
  hydrate?: number[];
  nextHydration: number;
  classify?: number[];
  nextClassification: number;
  commentsCount: number;
  commentBytes: number;
  leaseRefsByObjective?: Map<number, DiscoveryControlRef>;
  recoveryRefsByObjective?: Map<number, string>;
}

function timestamp(value: string, label: string): number {
  const parsed = new Date(value).getTime();
  if (!Number.isFinite(parsed)) throw new Error(`${label} has an invalid updated_at timestamp`);
  return parsed;
}

function since(watermark: number): string {
  return new Date(Math.max(0, watermark - DISCOVERY_SESSION_LIMITS.overlapMs)).toISOString();
}

function maxWatermark<T>(
  previous: number,
  values: T[],
  updatedAt: (value: T) => string,
  label: string,
): number {
  return values.reduce(
    (maximum, value) => Math.max(maximum, timestamp(updatedAt(value), label)),
    previous,
  );
}

function collectionWatermark<T>(
  previous: number,
  collection: DiscoveryCollection<T>,
  updatedAt: (value: T) => string,
  label: string,
): number {
  return collection.safeThrough
    ? Math.max(previous, timestamp(collection.safeThrough, `${label} collection watermark`))
    : maxWatermark(previous, collection.items, updatedAt, label);
}

function sameIssue(left: DiscoveryIssue, right: DiscoveryIssue): boolean {
  return (
    left.state === right.state &&
    left.title === right.title &&
    left.body === right.body &&
    left.pullRequest === right.pullRequest &&
    left.updatedAt === right.updatedAt &&
    left.labels.length === right.labels.length &&
    left.labels.every((label, index) => label === right.labels[index])
  );
}

function sameIssueCollection(
  left: DiscoveryCollection<DiscoveryIssue>,
  right: DiscoveryCollection<DiscoveryIssue>,
): boolean {
  if (left.items.length !== right.items.length) return false;
  const rightByNumber = new Map(right.items.map((issue) => [issue.number, issue]));
  return left.items.every((issue) => {
    const candidate = rightByNumber.get(issue.number);
    return candidate !== undefined && sameIssue(issue, candidate);
  });
}

function sameComment(left: DiscoveryComment, right: DiscoveryComment): boolean {
  return (
    left.issueNumber === right.issueNumber &&
    left.body === right.body &&
    left.authorLogin === right.authorLogin &&
    left.authorAssociation === right.authorAssociation &&
    left.updatedAt === right.updatedAt
  );
}

function isObjective(issue: DiscoveryIssue): boolean {
  return (
    !issue.pullRequest && issue.labels.some((label) => label.toLowerCase() === "factory:objective")
  );
}

function recoveryRefFingerprints(refs: DiscoveryControlRef[]): Map<number, string> {
  const grouped = new Map<number, string[]>();
  for (const ref of refs) {
    if (ref.kind !== "recovery-plan") continue;
    const values = grouped.get(ref.objective) ?? [];
    values.push(`${ref.ref}:${ref.oid}`);
    grouped.set(ref.objective, values);
  }
  return new Map([...grouped].map(([objective, values]) => [objective, values.sort().join("\n")]));
}

function emptyProbes(): DiscoveryCycleTelemetry["probes"] {
  return {
    authenticatedUser: 0,
    issues: 0,
    repositoryComments: 0,
    objectiveComments: 0,
    matchingRefs: 0,
    classifications: 0,
    notModified: 0,
  };
}

/**
 * Process-local scheduling index. Every process bootstraps from complete
 * authenticated GitHub history. Warm state is committed only after every page
 * and classification succeeds; it is never mutation authority.
 */
export class GitHubDiscoverySession {
  readonly #ports: GitHubDiscoveryPorts;
  readonly #now: () => Date;
  #state: SessionState | undefined;
  #bootstrapProgress: BootstrapProgress | undefined;
  #deltaProgress: DeltaProgress | undefined;
  #cycles: DiscoveryCycleTelemetry[] = [];
  #droppedCycles = 0;
  #sequence = 0;

  constructor(ports: GitHubDiscoveryPorts, now: () => Date = () => new Date()) {
    this.#ports = ports;
    this.#now = now;
  }

  async discover(): Promise<DurableObjectiveActivation[]> {
    const startedAt = this.#now();
    const probes = emptyProbes();
    const mode = this.#state ? "delta" : "bootstrap";
    try {
      const result =
        mode === "delta"
          ? await this.#delta(startedAt, probes)
          : await this.#bootstrap(startedAt, probes);
      this.#recordCycle({
        sequence: ++this.#sequence,
        mode,
        startedAt: startedAt.toISOString(),
        completedAt: this.#now().toISOString(),
        outcome: "complete",
        backstop: result.backstop,
        probes,
        dirtyObjectives: result.dirtyObjectives,
        returnedActivations: result.activations.length,
      });
      return result.activations;
    } catch (error) {
      const deltaProgress = mode === "delta" ? this.#deltaProgress : undefined;
      this.#recordCycle({
        sequence: ++this.#sequence,
        mode,
        startedAt: startedAt.toISOString(),
        completedAt: this.#now().toISOString(),
        outcome: "failed",
        backstop: deltaProgress?.backstop ?? false,
        probes,
        dirtyObjectives: deltaProgress?.dirty?.size ?? 0,
        returnedActivations: 0,
      });
      throw error;
    }
  }

  telemetry(): DiscoverySessionTelemetry {
    const objectives =
      this.#deltaProgress?.objectives ??
      this.#state?.objectives ??
      this.#bootstrapProgress?.objectives ??
      new Map();
    return {
      measurementScope: "process-local-discovery-session",
      cycles: this.#cycles.map((cycle) => ({ ...cycle, probes: { ...cycle.probes } })),
      droppedCycles: this.#droppedCycles,
      cachedObjectives: objectives.size,
      cachedComments: [...objectives.values()].reduce(
        (total, objective) => total + objective.comments.size,
        0,
      ),
    };
  }

  async #bootstrap(
    startedAt: Date,
    probes: DiscoveryCycleTelemetry["probes"],
  ): Promise<{
    activations: DurableObjectiveActivation[];
    dirtyObjectives: number;
    backstop: boolean;
  }> {
    let progress = this.#bootstrapProgress;
    if (!progress) {
      let identity: { login: string; serverTime: Date };
      try {
        identity = await this.#ports.authenticate();
        probes.authenticatedUser++;
      } catch (error) {
        probes.authenticatedUser += recordedPartialDiscoveryRequests(error);
        throw error;
      }
      let labelled = await this.#collection(probes, "issues", () =>
        this.#ports.listLabelledIssues(),
      );
      if (labelled.notModified) throw new Error("cold discovery cannot accept a 304 issue index");
      if (labelled.requests > 1) {
        let stable = false;
        // A label removal can change live page membership even in immutable
        // creation order. Cold start has no prior delta cache to protect a
        // skipped row, so require two consecutive equal complete scans.
        for (let verification = 0; verification < 2; verification++) {
          const observed = await this.#collection(probes, "issues", () =>
            this.#ports.listLabelledIssues(),
          );
          if (observed.notModified)
            throw new Error("cold multi-page discovery cannot accept a 304 issue index");
          if (sameIssueCollection(labelled, observed)) {
            labelled = observed;
            stable = true;
            break;
          }
          labelled = observed;
        }
        if (!stable)
          throw new Error("cold Objective label index changed during bounded pagination");
      }
      if (labelled.items.filter(isObjective).length > DISCOVERY_SESSION_LIMITS.objectives)
        throw new Error("repository exceeds the controller's 10000-Objective discovery limit");
      progress = {
        identity,
        labelled,
        objectives: new Map(),
        nextIssue: 0,
        comments: 0,
        commentBytes: 0,
        startedAt: startedAt.getTime(),
      };
      this.#bootstrapProgress = progress;
    }
    for (; progress.nextIssue < progress.labelled.items.length; progress.nextIssue++) {
      const issue = progress.labelled.items[progress.nextIssue]!;
      if (!isObjective(issue)) continue;
      const hydrated = await this.#collection(probes, "objectiveComments", () =>
        this.#ports.listObjectiveComments(issue.number),
      );
      if (hydrated.notModified)
        throw new Error(`cold Objective #${issue.number} hydration cannot accept 304`);
      const comments = new Map(hydrated.items.map((comment) => [comment.id, comment]));
      if (comments.size > DISCOVERY_SESSION_LIMITS.commentsPerObjective)
        throw new Error(`Objective #${issue.number} exceeds the controller comment limit`);
      const commentBytes = [...comments.values()].reduce(
        (total, comment) => total + Buffer.byteLength(comment.body),
        0,
      );
      if (
        progress.comments + comments.size > DISCOVERY_SESSION_LIMITS.totalComments ||
        progress.commentBytes + commentBytes > DISCOVERY_SESSION_LIMITS.commentBytes
      )
        throw new Error("repository exceeds the controller's aggregate comment discovery limit");
      const objective: CachedObjective = {
        issue,
        comments,
        revision: 1,
        writerBound: false,
        authorityOid: null,
        recoveryBound: false,
        recoveryRefsFingerprint: null,
        activation: null,
      };
      const classified = await this.#ports.classify({
        login: progress.identity.login,
        issue: objective.issue,
        comments: [...objective.comments.values()],
        revision: objective.revision,
      });
      probes.classifications++;
      objective.writerBound = classified.writerBound;
      objective.authorityOid = classified.authorityOid;
      objective.recoveryBound = classified.recoveryBound;
      objective.activation = classified.activation
        ? { ...classified.activation, discoveryRevision: objective.revision }
        : null;
      progress.objectives.set(issue.number, objective);
      progress.comments += comments.size;
      progress.commentBytes += commentBytes;
    }
    const watermark = progress.identity.serverTime.getTime();
    if (!Number.isFinite(watermark)) throw new Error("authentication returned invalid server time");
    this.#state = {
      login: progress.identity.login.toLowerCase(),
      objectives: progress.objectives,
      issueWatermark: watermark,
      commentWatermark: watermark,
      slowCommentWatermark: watermark,
      ...(progress.labelled.etag ? { labelledIssuesEtag: progress.labelled.etag } : {}),
      lastBackstopAt: progress.startedAt,
    };
    this.#bootstrapProgress = undefined;
    return {
      activations: this.#activations(progress.objectives),
      dirtyObjectives: progress.objectives.size,
      backstop: false,
    };
  }

  async #delta(
    startedAt: Date,
    probes: DiscoveryCycleTelemetry["probes"],
  ): Promise<{
    activations: DurableObjectiveActivation[];
    dirtyObjectives: number;
    backstop: boolean;
  }> {
    let progress = this.#deltaProgress;
    if (!progress) {
      const base = this.#state!;
      const backstop =
        startedAt.getTime() - base.lastBackstopAt >= DISCOVERY_SESSION_LIMITS.backstopIntervalMs;
      progress = {
        base,
        startedAt: startedAt.getTime(),
        backstop,
        labelledDone: !backstop,
        slowCommentsDone: !backstop,
        refsDone: !backstop,
        nextHydration: 0,
        nextClassification: 0,
        commentsCount: 0,
        commentBytes: 0,
      };
      this.#deltaProgress = progress;
    }
    const current = progress.base;
    progress.issues ??= await this.#collection(probes, "issues", () =>
      this.#ports.listIssueDelta(since(current.issueWatermark), current.issueDeltaEtag),
    );
    progress.comments ??= await this.#collection(probes, "repositoryComments", () =>
      this.#ports.listRepositoryComments(since(current.commentWatermark), current.commentDeltaEtag),
    );
    if (!progress.labelledDone) {
      progress.labelled = await this.#collection(probes, "issues", () =>
        this.#ports.listLabelledIssues(current.labelledIssuesEtag),
      );
      progress.labelledDone = true;
    }
    if (!progress.slowCommentsDone) {
      progress.slowComments = await this.#collection(probes, "repositoryComments", () =>
        this.#ports.listRepositoryComments(
          since(current.slowCommentWatermark),
          current.slowCommentsEtag,
        ),
      );
      progress.slowCommentsDone = true;
    }
    if (!progress.refsDone) {
      progress.refs = await this.#collection(probes, "matchingRefs", () =>
        this.#ports.listControlRefs(current.refsEtag),
      );
      progress.refsDone = true;
    }
    if (!progress.objectives) this.#prepareDelta(progress);
    const objectives = progress.objectives!;
    const dirty = progress.dirty!;
    const hydrate = progress.hydrate!;
    for (; progress.nextHydration < hydrate.length; progress.nextHydration++) {
      const number = hydrate[progress.nextHydration]!;
      const hydrated = await this.#collection(probes, "objectiveComments", () =>
        this.#ports.listObjectiveComments(number),
      );
      if (hydrated.notModified)
        throw new Error(`new Objective #${number} hydration cannot accept 304`);
      const hydratedComments = new Map(hydrated.items.map((comment) => [comment.id, comment]));
      if (hydratedComments.size > DISCOVERY_SESSION_LIMITS.commentsPerObjective)
        throw new Error(`Objective #${number} exceeds the controller comment limit`);
      const hydratedBytes = [...hydratedComments.values()].reduce(
        (total, comment) => total + Buffer.byteLength(comment.body),
        0,
      );
      if (
        progress.commentsCount + hydratedComments.size > DISCOVERY_SESSION_LIMITS.totalComments ||
        progress.commentBytes + hydratedBytes > DISCOVERY_SESSION_LIMITS.commentBytes
      )
        throw new Error("repository exceeds the controller's aggregate comment discovery limit");
      objectives.get(number)!.comments = hydratedComments;
      progress.commentsCount += hydratedComments.size;
      progress.commentBytes += hydratedBytes;
    }
    for (; progress.nextClassification < progress.classify!.length; progress.nextClassification++) {
      const number = progress.classify![progress.nextClassification]!;
      const objective = objectives.get(number);
      if (!objective) continue;
      const classified = await this.#ports.classify({
        login: current.login,
        issue: objective.issue,
        comments: [...objective.comments.values()],
        revision: objective.revision,
        ...(progress.leaseRefsByObjective
          ? { authority: progress.leaseRefsByObjective.get(number) ?? null }
          : {}),
      });
      probes.classifications++;
      objective.writerBound = classified.writerBound;
      objective.authorityOid = classified.authorityOid;
      objective.recoveryBound = classified.recoveryBound;
      objective.recoveryRefsFingerprint = classified.recoveryBound
        ? (progress.recoveryRefsByObjective?.get(number) ?? objective.recoveryRefsFingerprint)
        : null;
      objective.activation = classified.activation
        ? { ...classified.activation, discoveryRevision: objective.revision }
        : null;
    }

    const issues = progress.issues;
    const comments = progress.comments;
    const labelled = progress.labelled;
    const slowComments = progress.slowComments;
    const refs = progress.refs;
    const backstop = progress.backstop;

    const nextIssueWatermark = issues.notModified
      ? current.issueWatermark
      : collectionWatermark(current.issueWatermark, issues, (issue) => issue.updatedAt, "issue");
    const nextCommentWatermark = comments.notModified
      ? current.commentWatermark
      : collectionWatermark(
          current.commentWatermark,
          comments,
          (comment) => comment.updatedAt,
          "comment",
        );
    const nextSlowCommentWatermark =
      slowComments && !slowComments.notModified
        ? collectionWatermark(
            current.slowCommentWatermark,
            slowComments,
            (comment) => comment.updatedAt,
            "comment",
          )
        : current.slowCommentWatermark;
    const next: SessionState = {
      ...current,
      objectives,
      issueWatermark: nextIssueWatermark,
      commentWatermark: nextCommentWatermark,
      slowCommentWatermark: nextSlowCommentWatermark,
      ...(labelled?.etag ? { labelledIssuesEtag: labelled.etag } : {}),
      ...(refs?.etag ? { refsEtag: refs.etag } : {}),
      lastBackstopAt: backstop ? progress.startedAt : current.lastBackstopAt,
    };
    // A validator belongs to the exact URL, including its `since` query. If
    // the watermark moved, make the next query unconditional once before
    // retaining a validator for that new URL.
    if (nextIssueWatermark === current.issueWatermark && issues.etag)
      next.issueDeltaEtag = issues.etag;
    else delete next.issueDeltaEtag;
    if (nextCommentWatermark === current.commentWatermark && comments.etag)
      next.commentDeltaEtag = comments.etag;
    else delete next.commentDeltaEtag;
    if (
      slowComments &&
      nextSlowCommentWatermark === current.slowCommentWatermark &&
      slowComments.etag
    )
      next.slowCommentsEtag = slowComments.etag;
    else if (slowComments) delete next.slowCommentsEtag;
    this.#state = next;
    this.#deltaProgress = undefined;
    return {
      activations: this.#activations(objectives),
      dirtyObjectives: dirty.size,
      backstop,
    };
  }

  #prepareDelta(progress: DeltaProgress): void {
    const current = progress.base;
    const issues = progress.issues!;
    const comments = progress.comments!;
    const labelled = progress.labelled;
    const slowComments = progress.slowComments;
    const refs = progress.refs;
    const objectives = new Map<number, CachedObjective>();
    for (const [number, objective] of current.objectives) {
      objectives.set(number, {
        ...objective,
        issue: { ...objective.issue, labels: [...objective.issue.labels] },
        comments: new Map(objective.comments),
        activation: objective.activation ? { ...objective.activation } : null,
      });
    }
    const dirty = new Set<number>();
    const hydrate = new Set<number>();
    const applyIssue = (issue: DiscoveryIssue) => {
      const prior = objectives.get(issue.number);
      if (!isObjective(issue)) {
        if (prior) objectives.delete(issue.number);
        return;
      }
      if (!prior) {
        objectives.set(issue.number, {
          issue,
          comments: new Map(),
          revision: 1,
          writerBound: false,
          authorityOid: null,
          recoveryBound: false,
          recoveryRefsFingerprint: null,
          activation: null,
        });
        hydrate.add(issue.number);
        dirty.add(issue.number);
      } else if (!sameIssue(prior.issue, issue)) {
        prior.issue = issue;
        dirty.add(issue.number);
      }
    };
    if (!issues.notModified) for (const issue of issues.items) applyIssue(issue);
    if (labelled && !labelled.notModified) {
      // The change delta is the removal authority. A live page-number label
      // scan is additive only, so a concurrent label removal cannot shift an
      // unchanged Objective across a page boundary and transiently erase it.
      for (const issue of labelled.items) applyIssue(issue);
    }
    // Reject objective growth before spending even one hydration request.
    if (objectives.size > DISCOVERY_SESSION_LIMITS.objectives)
      throw new Error("repository exceeds the controller's 10000-Objective discovery limit");
    const applyComment = (comment: DiscoveryComment) => {
      const objective = objectives.get(comment.issueNumber);
      if (!objective || hydrate.has(comment.issueNumber)) return;
      const prior = objective.comments.get(comment.id);
      if (!prior || !sameComment(prior, comment)) {
        objective.comments.set(comment.id, comment);
        dirty.add(comment.issueNumber);
      }
    };
    if (!comments.notModified) for (const comment of comments.items) applyComment(comment);
    if (slowComments && !slowComments.notModified)
      for (const comment of slowComments.items) applyComment(comment);

    const leaseRefsByObjective =
      refs && !refs.notModified
        ? new Map(
            refs.items.filter((ref) => ref.kind === "lease").map((ref) => [ref.objective, ref]),
          )
        : undefined;
    const recoveryRefsByObjective =
      refs && !refs.notModified ? recoveryRefFingerprints(refs.items) : undefined;
    if (leaseRefsByObjective && recoveryRefsByObjective) {
      for (const [number, objective] of objectives) {
        if (
          objective.writerBound &&
          (leaseRefsByObjective.get(number)?.oid ?? null) !== objective.authorityOid
        )
          dirty.add(number);
        if (
          objective.recoveryBound &&
          (recoveryRefsByObjective.get(number) ?? "") !== objective.recoveryRefsFingerprint
        )
          dirty.add(number);
      }
    }
    this.#assertBounds(objectives);
    for (const number of dirty) {
      const objective = objectives.get(number);
      if (objective && current.objectives.has(number)) objective.revision++;
    }
    progress.objectives = objectives;
    progress.dirty = dirty;
    progress.hydrate = [...hydrate].sort((left, right) => left - right);
    progress.classify = [...dirty].sort((left, right) => left - right);
    progress.commentsCount = [...objectives.values()].reduce(
      (total, objective) => total + objective.comments.size,
      0,
    );
    progress.commentBytes = [...objectives.values()].reduce(
      (total, objective) =>
        total +
        [...objective.comments.values()].reduce(
          (objectiveTotal, comment) => objectiveTotal + Buffer.byteLength(comment.body),
          0,
        ),
      0,
    );
    if (leaseRefsByObjective) progress.leaseRefsByObjective = leaseRefsByObjective;
    if (recoveryRefsByObjective) progress.recoveryRefsByObjective = recoveryRefsByObjective;
  }

  async #collection<
    K extends keyof Pick<
      DiscoveryCycleTelemetry["probes"],
      "issues" | "repositoryComments" | "objectiveComments" | "matchingRefs"
    >,
    T,
  >(
    probes: DiscoveryCycleTelemetry["probes"],
    key: K,
    operation: () => Promise<DiscoveryCollection<T>>,
  ): Promise<DiscoveryCollection<T>> {
    try {
      const result = await operation();
      probes[key] += result.requests;
      if (result.notModified) probes.notModified++;
      return result;
    } catch (error) {
      probes[key] += recordedPartialDiscoveryRequests(error);
      throw error;
    }
  }

  #activations(objectives: Map<number, CachedObjective>): DurableObjectiveActivation[] {
    return [...objectives.values()]
      .map((objective) => objective.activation)
      .filter((activation): activation is DurableObjectiveActivation => activation !== null);
  }

  #assertBounds(objectives: Map<number, CachedObjective>): void {
    if (objectives.size > DISCOVERY_SESSION_LIMITS.objectives)
      throw new Error("repository exceeds the controller's 10000-Objective discovery limit");
    let comments = 0;
    let bytes = 0;
    for (const objective of objectives.values()) {
      if (objective.comments.size > DISCOVERY_SESSION_LIMITS.commentsPerObjective) {
        throw new Error(
          `Objective #${objective.issue.number} exceeds the controller comment limit`,
        );
      }
      comments += objective.comments.size;
      for (const comment of objective.comments.values()) bytes += Buffer.byteLength(comment.body);
    }
    if (comments > DISCOVERY_SESSION_LIMITS.totalComments)
      throw new Error("repository exceeds the controller's total comment discovery limit");
    if (bytes > DISCOVERY_SESSION_LIMITS.commentBytes)
      throw new Error("repository exceeds the controller's comment byte discovery limit");
  }

  #recordCycle(cycle: DiscoveryCycleTelemetry): void {
    if (this.#cycles.length === DISCOVERY_SESSION_LIMITS.telemetryCycles) {
      this.#cycles.shift();
      this.#droppedCycles++;
    }
    this.#cycles.push(Object.freeze({ ...cycle, probes: Object.freeze({ ...cycle.probes }) }));
  }
}
