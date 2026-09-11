import { AsyncLocalStorage } from "node:async_hooks";
import { createOctokit, withGitHubTransportCallbacks, type GitHubOptions } from "../github.js";
import {
  CircuitBreaker,
  ConcurrencyLimiter,
  ContentCreationPacer,
  GitHubPrimaryAdmissionDeferredError,
  MutationScheduler,
  PlatformUnavailableError,
  classifyRefusal,
  isSecondaryRateLimitRefusal,
  withGitHubRequestPriority,
  type MutationAdmission,
  type MutationClass,
} from "../platform.js";
import type { AttemptStore } from "./attempts.js";
import {
  bindAuthenticatedRunActors,
  type AuthenticatedFactoryEvent,
} from "./authenticated-events.js";
import { deriveDurableCommandState } from "./commands.js";
import {
  leaseRef,
  parseLeaseCommit,
  type GitCommitObject,
  type LeaseState,
  type LeaseStore,
} from "./lease.js";
import { objectiveAuthorityObservation, type ObjectiveAuthorityObservation } from "./authority.js";
import {
  observeMutationFence,
  observeMutationOperation,
  observeMutationQueue,
  type MutationAuthorityClass,
  type MutationOperationObservation,
} from "./mutation-observation.js";
import {
  decodeEventComments,
  deduplicateFactoryEvents,
  latestSupportedRun,
  hasCurrentWriterAuthority,
} from "./receipts.js";
import { classicBranchProtectionRules } from "../publication/branch-policy.js";
import { PROTOCOL_V2 } from "../protocol/limits.js";
import { parseRunPolicy, policyDigest } from "../protocol/policy.js";
import { discoverRecoveryActivation } from "../recovery/discovery.js";
import { activationCancellation } from "./activations.js";
import {
  DISCOVERY_SESSION_LIMITS,
  GitHubDiscoverySession,
  recordPartialDiscoveryRequests,
  type DiscoveryCollection,
  type DiscoveryComment,
  type DiscoveryIssue,
  type DiscoveryControlRef,
  type DiscoverySessionTelemetry,
} from "./discovery-session.js";

const UPDATE_REFS = `
mutation FactoryUpdateRefs(
  $repositoryId: ID!
  $name: GitRefname!
  $beforeOid: GitObjectID!
  $afterOid: GitObjectID!
) {
  updateRefs(input: {
    repositoryId: $repositoryId
    refUpdates: [{
      name: $name
      beforeOid: $beforeOid
      afterOid: $afterOid
      force: false
    }]
  }) { clientMutationId }
}`;

type FactoryOctokit = ReturnType<typeof createOctokit>;

/**
 * Factory's durable comment envelopes already carry their destination issue
 * number. Derive the REST route from that validated payload instead of
 * spending scarce GraphQL points on addComment mutations.
 */
export function factoryCommentIssueNumber(body: string): number {
  const events = decodeEventComments(body);
  if (events.length === 0) throw new Error("Factory comment must contain an event envelope");
  const destinations = new Set(
    events.map((event) =>
      "workItem" in event && typeof event.workItem === "number" ? event.workItem : event.objective,
    ),
  );
  if (destinations.size !== 1) {
    throw new Error("Factory comment event batch must have one destination issue");
  }
  return destinations.values().next().value!;
}

function stripRefs(ref: string): string {
  if (!ref.startsWith("refs/")) throw new Error(`ref must be fully qualified: ${ref}`);
  return ref.slice("refs/".length);
}

function responseDate(response: { headers: Record<string, string | number | undefined> }): Date {
  const value = response.headers.date;
  if (!value) throw new Error("GitHub response did not contain a Date header");
  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.getTime())) throw new Error(`invalid GitHub Date header: ${value}`);
  return parsed;
}

const PRIVATE_REPOSITORY_RULES_UNAVAILABLE_MESSAGE =
  "Upgrade to GitHub Pro or make this repository public to enable this feature.";

function isUnavailablePrivateRepositoryRuleFeature(error: unknown, documentationUrl: string) {
  const response = (
    error as {
      status?: number;
      response?: { data?: { message?: unknown; documentation_url?: unknown } };
    }
  )?.response?.data;
  return (
    (error as { status?: number })?.status === 403 &&
    response?.message === PRIVATE_REPOSITORY_RULES_UNAVAILABLE_MESSAGE &&
    response.documentation_url === documentationUrl
  );
}

export interface GitHubControlStoreOptions extends GitHubOptions {
  circuitBreaker?: CircuitBreaker;
  pacer?: ContentCreationPacer;
  concurrency?: ConcurrencyLimiter;
  mutationScheduler?: MutationAdmission;
  beforeMutation?: (kind: MutationClass, waitedMs: number) => Promise<void>;
  /** Capture the exact Objective generation before entering any request queue. */
  captureMutationFence?: (kind: MutationClass) => (waitedMs: number) => Promise<void>;
  assertMutationIdentity?: (lease: LeaseState) => void;
  mutationScope?: string;
  onMutationOperation?: (observation: MutationOperationObservation) => void;
  /** Injectable process clock for deterministic discovery reconciliation tests. */
  discoveryNow?: () => Date;
}

export interface DurableObjectiveActivation {
  objective: number;
  activatedAt: string;
  requestId: string;
  policy: unknown;
  policyDigest: string;
  baseSha: string;
  requestedBy: string;
  /** Process-local scheduling revision. Never durable authority. */
  discoveryRevision?: number;
  /** Discovery fact only; the Supervisor still verifies the actual durable run. */
  resuming?: boolean;
  recovery?: { requestId: string; planDigest: string; successorRunId: string };
}

const TRUSTED_CONTROL_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

function authenticatedCommentEvents(
  comments: Array<{
    body: string;
    authorLogin: string | null;
    authorAssociation: string | null;
  }>,
  authority?: ObjectiveAuthorityObservation | null,
): AuthenticatedFactoryEvent[] {
  const parsed = comments.flatMap((comment) => {
    if (
      !comment.authorLogin ||
      !TRUSTED_CONTROL_ASSOCIATIONS.has(comment.authorAssociation ?? "")
    ) {
      return [];
    }
    return decodeEventComments(comment.body).map((event) => ({
      event,
      login: comment.authorLogin!,
    }));
  });
  const runActors = bindAuthenticatedRunActors(parsed, authority);
  return parsed.filter(({ event, login }) => {
    if (
      event.kind === "run" &&
      (event.event === "ActivationRequested" ||
        event.event === "ActivationRejected" ||
        event.event === "ActivationCancellationRequested")
    ) {
      return event.requestedBy.toLowerCase() === login.toLowerCase();
    }
    return runActors.get(event.runId)?.toLowerCase() === login.toLowerCase();
  });
}

/** GitHub-backed v2 control store. Every mutation shares v1's pacing controls. */
export class GitHubControlStore implements LeaseStore, AttemptStore {
  readonly #octokit: FactoryOctokit;
  readonly #owner: string;
  readonly #repo: string;
  readonly #breaker: CircuitBreaker;
  readonly #pacer: ContentCreationPacer;
  readonly #concurrency: ConcurrencyLimiter;
  readonly #mutations: MutationAdmission;
  readonly #beforeMutation: (kind: MutationClass, waitedMs: number) => Promise<void>;
  readonly #captureMutationFence: GitHubControlStoreOptions["captureMutationFence"];
  readonly #assertMutationIdentity: GitHubControlStoreOptions["assertMutationIdentity"];
  readonly #mutationScope: string;
  readonly #onMutationOperation: GitHubControlStoreOptions["onMutationOperation"];
  readonly #operationObservations: MutationOperationObservation[] = [];
  readonly #scopedMutationFence = new AsyncLocalStorage<(waitedMs: number) => Promise<void>>();
  readonly #publicationSafetyFence = new AsyncLocalStorage<() => Promise<void>>();
  readonly #transportFenceContext = new AsyncLocalStorage<boolean>();
  readonly #mutationClassContext = new AsyncLocalStorage<MutationClass>();
  #droppedOperationObservations = 0;
  #repositoryId: string | null = null;
  readonly #discovery: GitHubDiscoverySession;
  readonly #discoveryCommitCache = new Map<string, Omit<GitCommitObject, "serverTime">>();

  constructor(options: GitHubControlStoreOptions) {
    this.#octokit = createOctokit(options);
    this.#owner = options.owner;
    this.#repo = options.repo;
    this.#breaker = options.circuitBreaker ?? new CircuitBreaker();
    this.#pacer = options.pacer ?? new ContentCreationPacer();
    this.#concurrency = options.concurrency ?? new ConcurrencyLimiter();
    this.#mutations =
      options.mutationScheduler ??
      new MutationScheduler({
        pacer: this.#pacer,
        ...(options.onThrottle ? { onThrottle: options.onThrottle } : {}),
      });
    this.#beforeMutation = options.beforeMutation ?? (async () => {});
    this.#captureMutationFence = options.captureMutationFence;
    this.#assertMutationIdentity = options.assertMutationIdentity;
    this.#mutationScope = options.mutationScope ?? "unscoped-control-store";
    this.#onMutationOperation = options.onMutationOperation;
    this.#discovery = new GitHubDiscoverySession(
      {
        authenticate: () => this.#authenticateDiscovery(),
        listLabelledIssues: (etag) => this.#listDiscoveryIssues("labelled", undefined, etag),
        listIssueDelta: (since, etag) => this.#listDiscoveryIssues("delta", since, etag),
        listRepositoryComments: (since, etag) => this.#listRepositoryDiscoveryComments(since, etag),
        listObjectiveComments: (objective) => this.#listObjectiveDiscoveryComments(objective),
        listControlRefs: (etag) => this.#listDiscoveryControlRefs(etag),
        classify: (input) => this.#classifyDiscoveryObjective(input),
      },
      options.discoveryNow,
    );
  }

  discoveryTelemetry(): DiscoverySessionTelemetry {
    return this.#discovery.telemetry();
  }

  get objectivePublicationFenceAtDispatch(): boolean {
    return Boolean(this.#captureMutationFence && this.#assertMutationIdentity);
  }

  assertMutationIdentity(lease: LeaseState): void {
    if (!this.#assertMutationIdentity)
      throw new Error("Objective mutation identity is unavailable");
    this.#assertMutationIdentity(lease);
  }

  /** Short shared-resource transactions retain their own Objective binding even
   * when different sessions use one coordinator store concurrently. */
  withMutationFence<T>(
    fence: (waitedMs: number) => Promise<void>,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.#scopedMutationFence.run(fence, operation);
  }

  /** Bind an explicit semantic class across prerequisite reads and writes.
   * Outer request priority wins, so a lease assertion inside a normal write
   * fence cannot borrow protected capacity. */
  withMutationClass<T>(kind: MutationClass, operation: () => Promise<T>): Promise<T> {
    if (this.#mutationClassContext.getStore()) return operation();
    return this.#mutationClassContext.run(kind, () =>
      withGitHubRequestPriority(
        kind === "normal" ? "normal" : "protected",
        operation,
        kind === "normal" ? undefined : 1,
      ),
    );
  }

  /** Compose mutable publication policy with the transport's authoritative
   * lease fence, after queue admission and immediately before dispatch. */
  withPublicationSafetyFence<T>(
    fence: () => Promise<void>,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.#publicationSafetyFence.run(fence, operation);
  }

  mutationOperationTelemetry() {
    return {
      measurementScope: "process-local-transport-boundary" as const,
      records: this.#operationObservations.map((record) => ({ ...record })),
      droppedRecords: this.#droppedOperationObservations,
    };
  }

  recordMutationOperation = (observation: MutationOperationObservation): void => {
    if (this.#operationObservations.length === 256) {
      this.#operationObservations.shift();
      this.#droppedOperationObservations++;
    }
    this.#operationObservations.push(Object.freeze({ ...observation }));
    this.#onMutationOperation?.(observation);
  };

  /** Public-preview routes still pass through Factory's shared safety controls. */
  async stackRequest(
    route: string,
    parameters: Record<string, unknown>,
    mutating = false,
  ): Promise<{ status: number; data: unknown }> {
    const request = this.#octokit.request as unknown as (
      route: string,
      parameters: Record<string, unknown>,
    ) => Promise<{ status: number; data: unknown }>;
    return this.#call(
      () => request.call(this.#octokit, route, parameters),
      mutating,
      "normal",
      route,
    );
  }

  async #call<T>(
    operation: () => Promise<T>,
    mutating = false,
    mutationClass: MutationClass = "normal",
    operationName = `${mutationClass}-mutation`,
    authorityClass: MutationAuthorityClass = "objective-publication",
  ): Promise<T> {
    const effectiveMutationClass = this.#mutationClassContext.getStore() ?? mutationClass;
    const dispatch = () => {
      if (mutating && this.#transportFenceContext.getStore())
        throw new Error("mutation dispatch is forbidden inside a transport fence");
      // This callback runs synchronously inside the observation, before any
      // queue await. Even a rejected capture is therefore measured.
      const authoritative = mutating && authorityClass !== "immutable-preparation";
      const scopedFence = authoritative ? this.#scopedMutationFence.getStore() : undefined;
      // Shared transactions bind an immutable owner; do not capture or recheck
      // a second, configured Objective generation for the same operation.
      const fence =
        scopedFence ??
        (authoritative ? this.#captureMutationFence?.(effectiveMutationClass) : undefined);
      const publicationSafetyFence = authoritative
        ? this.#publicationSafetyFence.getStore()
        : undefined;
      return this.#dispatch(
        operation,
        mutating,
        effectiveMutationClass,
        fence,
        publicationSafetyFence,
      );
    };
    if (!mutating) return dispatch();
    return observeMutationOperation(
      operationName,
      authorityClass,
      this.#mutationScope,
      this.recordMutationOperation,
      dispatch,
    );
  }

  async #dispatch<T>(
    operation: () => Promise<T>,
    mutating: boolean,
    mutationClass: MutationClass,
    capturedFence?: (waitedMs: number) => Promise<void>,
    publicationSafetyFence?: () => Promise<void>,
  ): Promise<T> {
    if (this.#breaker.isOpen()) {
      throw new PlatformUnavailableError(
        { kind: "rate_limit", retryAfterMs: this.#breaker.waitMs() },
        new Error("Factory GitHub circuit is open"),
      );
    }
    const mutationPermit = mutating ? await this.#mutations.acquire(mutationClass) : undefined;
    // A transport-fence policy may make sequential reads through this store.
    // They reuse the outer request slot; nested mutation is rejected in #call.
    const release = this.#transportFenceContext.getStore()
      ? () => {}
      : await this.#concurrency.acquire();
    let attempted = false;
    try {
      if (this.#breaker.isOpen()) {
        throw new PlatformUnavailableError(
          { kind: "rate_limit", retryAfterMs: this.#breaker.waitMs() },
          new Error("Factory GitHub circuit opened while the request was queued"),
        );
      }
      if (mutationPermit) {
        observeMutationQueue(mutationPermit.waitedMs);
        await withGitHubRequestPriority(
          mutationClass === "normal" ? "normal" : "protected",
          () =>
            this.#transportFenceContext.run(true, () =>
              observeMutationFence(async () => {
                if (capturedFence) await capturedFence(mutationPermit.waitedMs);
                await this.#beforeMutation(mutationClass, mutationPermit.waitedMs);
                await publicationSafetyFence?.();
              }),
            ),
          mutationClass === "normal" ? undefined : 1,
        );
      }
      if (this.#breaker.isOpen()) {
        throw new PlatformUnavailableError(
          { kind: "rate_limit", retryAfterMs: this.#breaker.waitMs() },
          new Error("Factory GitHub circuit opened during the mutation fence"),
        );
      }
      mutationPermit?.assertDispatchAllowed?.();
      const invoke = () =>
        mutating
          ? withGitHubRequestPriority(
              mutationClass === "normal" ? "normal" : "protected",
              operation,
              mutationClass === "normal" ? undefined : 1,
            )
          : operation();
      const result = await withGitHubTransportCallbacks(
        {
          onTransported: () => {
            attempted = true;
            mutationPermit?.recordTransported?.();
          },
        },
        invoke,
      );
      if (attempted) {
        mutationPermit?.recordSuccess?.();
        this.#breaker.recordSuccess();
      }
      return result;
    } catch (error) {
      if (!attempted) throw error;
      if (error instanceof GitHubPrimaryAdmissionDeferredError) throw error;
      const refusal =
        error instanceof PlatformUnavailableError ? error.refusal : classifyRefusal(error);
      if (refusal.kind !== "not_refusal") {
        mutationPermit?.recordRefusal?.(isSecondaryRateLimitRefusal(error));
        this.#breaker.recordRefusal(refusal);
        throw new PlatformUnavailableError(refusal, error);
      }
      throw error;
    } finally {
      release();
      mutationPermit?.release();
    }
  }

  async readRef(ref: string): Promise<string | null> {
    try {
      const response = await this.#call(() =>
        this.#octokit.request("GET /repos/{owner}/{repo}/git/ref/{ref}", {
          owner: this.#owner,
          repo: this.#repo,
          ref: stripRefs(ref),
        }),
      );
      return response.data.object.sha;
    } catch (error) {
      if ((error as { status?: number }).status === 404) return null;
      throw error;
    }
  }

  async readRefWithServerTime(ref: string): Promise<{ oid: string | null; serverTime: Date }> {
    try {
      const response = await this.#call(() =>
        this.#octokit.request("GET /repos/{owner}/{repo}/git/ref/{ref}", {
          owner: this.#owner,
          repo: this.#repo,
          ref: stripRefs(ref),
        }),
      );
      return {
        oid: response.data.object.sha,
        serverTime: responseDate(response),
      };
    } catch (error) {
      if ((error as { status?: number }).status === 404) {
        return { oid: null, serverTime: new Date() };
      }
      throw error;
    }
  }

  async listRefs(prefix: string): Promise<Array<{ ref: string; oid: string }>> {
    const response = await this.#call(() =>
      this.#octokit.request("GET /repos/{owner}/{repo}/git/matching-refs/{ref}", {
        owner: this.#owner,
        repo: this.#repo,
        ref: stripRefs(prefix),
      }),
    );
    return response.data.map((item) => ({
      ref: item.ref,
      oid: item.object.sha,
    }));
  }

  async readCommit(oid: string): Promise<GitCommitObject> {
    const response = await this.#call(() =>
      this.#octokit.request("GET /repos/{owner}/{repo}/git/commits/{commit_sha}", {
        owner: this.#owner,
        repo: this.#repo,
        commit_sha: oid,
      }),
    );
    const committedAt = response.data.committer?.date
      ? new Date(response.data.committer.date)
      : undefined;
    if (committedAt && Number.isNaN(committedAt.getTime()))
      throw new Error("GitHub commit has an invalid committer time");
    return {
      oid: response.data.sha,
      treeOid: response.data.tree.sha,
      parentOids: response.data.parents.map((parent) => parent.sha),
      message: response.data.message,
      ...(committedAt ? { committedAt } : {}),
      serverTime: responseDate(response),
    };
  }

  async createCommit(args: {
    treeOid: string;
    parentOids: string[];
    message: string;
  }): Promise<string> {
    const response = await this.#call(
      () =>
        this.#octokit.request("POST /repos/{owner}/{repo}/git/commits", {
          owner: this.#owner,
          repo: this.#repo,
          message: args.message,
          tree: args.treeOid,
          parents: args.parentOids,
        }),
      true,
      "normal",
      "createCommit",
      "immutable-preparation",
    );
    return response.data.sha;
  }

  async createRef(ref: string, oid: string): Promise<boolean> {
    try {
      await this.#call(
        () =>
          this.#octokit.request("POST /repos/{owner}/{repo}/git/refs", {
            owner: this.#owner,
            repo: this.#repo,
            ref,
            sha: oid,
          }),
        true,
        "normal",
        "createRef",
        "atomic-publication",
      );
      return true;
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status !== 409 && status !== 422) throw error;
      return (await this.readRef(ref)) === oid;
    }
  }

  async compareAndSwapRef(args: {
    ref: string;
    beforeOid: string;
    afterOid: string;
  }): Promise<boolean> {
    const repositoryId = await this.#getRepositoryId();
    try {
      await this.#call(
        () =>
          this.#octokit.graphql(UPDATE_REFS, {
            repositoryId,
            name: args.ref,
            beforeOid: args.beforeOid,
            afterOid: args.afterOid,
          }),
        true,
        "normal",
        "compareAndSwapRef",
        "atomic-publication",
      );
      return true;
    } catch (error) {
      // GitHub's stale-beforeOid response is currently a generic GraphQL
      // execution error. Re-read: our unique child OID proves success even if
      // the response was lost; every other value proves we lost the fence.
      const current = await this.readRef(args.ref);
      if (current === args.afterOid) return true;
      if (current !== args.beforeOid) return false;
      throw error;
    }
  }

  async addIssueComment(
    _issueNodeId: string,
    body: string,
    mutationClass: MutationClass = "normal",
  ): Promise<void> {
    const issueNumber = factoryCommentIssueNumber(body);
    await this.#call(
      () =>
        this.#octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
          owner: this.#owner,
          repo: this.#repo,
          issue_number: issueNumber,
          body,
        }),
      true,
      mutationClass,
      "addIssueComment",
    );
  }

  async serverTime(mutationClass: MutationClass = "normal"): Promise<Date> {
    const response = await this.withMutationClass(mutationClass, () =>
      this.#call(() =>
        this.#octokit.request("GET /repos/{owner}/{repo}", {
          owner: this.#owner,
          repo: this.#repo,
        }),
      ),
    );
    return responseDate(response);
  }

  async getAuthenticatedLogin(): Promise<string> {
    const response = await this.#call(() => this.#octokit.request("GET /user"));
    return response.data.login;
  }

  /** The label is a discovery index, never execution authority. Add it only
   * after an authenticated activation or recovery request exists, including exact replay. */
  async ensureObjectiveLabel(objective: number): Promise<void> {
    const name = "factory:objective";
    const issue = await this.#call(() =>
      this.#octokit.request("GET /repos/{owner}/{repo}/issues/{issue_number}", {
        owner: this.#owner,
        repo: this.#repo,
        issue_number: objective,
      }),
    );
    if (
      issue.data.labels.some(
        (label) => (typeof label === "string" ? label : label.name)?.toLowerCase() === name,
      )
    )
      return;
    const readLabel = () =>
      this.#call(() =>
        this.#octokit.request("GET /repos/{owner}/{repo}/labels/{name}", {
          owner: this.#owner,
          repo: this.#repo,
          name,
        }),
      );
    try {
      await readLabel();
    } catch (error) {
      if ((error as { status?: number }).status !== 404) throw error;
      try {
        await this.#call(
          () =>
            this.#octokit.request("POST /repos/{owner}/{repo}/labels", {
              owner: this.#owner,
              repo: this.#repo,
              name,
              color: "6f42c1",
              description:
                "Factory Objective discovery; execution requires an authorized activation",
            }),
          true,
          "normal",
          "createDiscoveryLabel",
        );
      } catch (createError) {
        if ((createError as { status?: number }).status !== 422) throw createError;
        // Another activation may have created the same structural label.
        // A fresh successful read, not the conflict alone, proves existence.
        await readLabel();
      }
    }
    await this.#call(
      () =>
        this.#octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/labels", {
          owner: this.#owner,
          repo: this.#repo,
          issue_number: objective,
          labels: [name],
        }),
      true,
      "normal",
      "labelObjective",
    );
  }

  /** Bootstrap once from complete authenticated history, then consume bounded
   * conditional deltas. The session is a scheduling index, never authority. */
  async discoverObjectiveActivations(): Promise<DurableObjectiveActivation[]> {
    return this.#discovery.discover();
  }

  async #authenticateDiscovery(): Promise<{ login: string; serverTime: Date }> {
    let transported = false;
    let response;
    try {
      response = await withGitHubTransportCallbacks(
        { onTransported: () => (transported = true) },
        () =>
          withGitHubRequestPriority("normal", () =>
            this.#call(() => this.#octokit.request("GET /user")),
          ),
      );
      return { login: response.data.login, serverTime: responseDate(response) };
    } catch (error) {
      recordPartialDiscoveryRequests(error, transported ? 1 : 0);
      throw error;
    }
  }

  async #listDiscoveryIssues(
    mode: "labelled" | "delta",
    since: string | undefined,
    etag: string | undefined,
  ): Promise<DiscoveryCollection<DiscoveryIssue>> {
    const byNumber = new Map<number, DiscoveryIssue>();
    let requests = 0;
    let nextEtag: string | undefined;
    let firstResponseAt: string | undefined;
    for (let page = 1; page <= DISCOVERY_SESSION_LIMITS.pagesPerProbe; page++) {
      let response;
      let transported = false;
      try {
        response = await withGitHubTransportCallbacks(
          { onTransported: () => (transported = true) },
          () =>
            withGitHubRequestPriority("normal", () =>
              this.#call(() =>
                this.#octokit.request("GET /repos/{owner}/{repo}/issues", {
                  owner: this.#owner,
                  repo: this.#repo,
                  state: "all",
                  // `since` still filters by updated_at. Immutable creation
                  // order prevents an edit from moving a previously scanned
                  // row across the next page offset.
                  sort: "created",
                  direction: "asc",
                  per_page: 100,
                  page,
                  ...(mode === "labelled" ? { labels: "factory:objective" } : { since: since! }),
                  ...(page === 1 && etag ? { headers: { "if-none-match": etag } } : {}),
                }),
              ),
            ),
        );
      } catch (error) {
        if (page === 1 && this.#status(error) === 304) {
          return { items: [], requests: 1, notModified: true, ...(etag ? { etag } : {}) };
        }
        recordPartialDiscoveryRequests(error, requests + (transported ? 1 : 0));
        throw error;
      }
      requests++;
      try {
        nextEtag ??= this.#etag(response.headers);
        const observedAt = responseDate(response).toISOString();
        firstResponseAt ??= observedAt;
        for (const raw of response.data) {
          if (!Number.isInteger(raw.number) || raw.number <= 0)
            throw new Error("GitHub issue discovery returned an invalid issue number");
          if (raw.state !== "open" && raw.state !== "closed")
            throw new Error(`Objective #${raw.number} returned an invalid issue state`);
          const labels = raw.labels
            .map((label) => (typeof label === "string" ? label : label.name))
            .filter((label): label is string => typeof label === "string")
            .sort((left, right) => left.localeCompare(right));
          if (mode === "labelled" && labels.length === 0) labels.push("factory:objective");
          byNumber.set(raw.number, {
            number: raw.number,
            state: raw.state,
            labels,
            title: raw.title,
            body: raw.body ?? "",
            pullRequest: "pull_request" in raw,
            updatedAt: raw.updated_at ?? observedAt,
          });
        }
        if (!this.#hasNext(response.headers))
          return {
            items: [...byNumber.values()],
            requests,
            notModified: false,
            ...(requests === 1 && response.data.length < 100 && nextEtag ? { etag: nextEtag } : {}),
            ...(requests > 1 && firstResponseAt ? { safeThrough: firstResponseAt } : {}),
          };
      } catch (error) {
        recordPartialDiscoveryRequests(error, requests);
        throw error;
      }
    }
    const error = new Error("repository issue discovery exceeds its page limit");
    recordPartialDiscoveryRequests(error, requests);
    throw error;
  }

  async #listRepositoryDiscoveryComments(
    since: string,
    etag?: string,
  ): Promise<DiscoveryCollection<DiscoveryComment>> {
    return this.#listDiscoveryComments({ since, ...(etag ? { etag } : {}) });
  }

  async #listObjectiveDiscoveryComments(
    objective: number,
  ): Promise<DiscoveryCollection<DiscoveryComment>> {
    return this.#listDiscoveryComments({ objective });
  }

  async #listDiscoveryComments(input: {
    objective?: number;
    since?: string;
    etag?: string;
  }): Promise<DiscoveryCollection<DiscoveryComment>> {
    const byId = new Map<string, DiscoveryComment>();
    let requests = 0;
    let nextEtag: string | undefined;
    let firstResponseAt: string | undefined;
    for (let page = 1; page <= DISCOVERY_SESSION_LIMITS.pagesPerProbe; page++) {
      let response;
      let transported = false;
      try {
        response = await withGitHubTransportCallbacks(
          { onTransported: () => (transported = true) },
          () =>
            withGitHubRequestPriority("normal", () =>
              this.#call(() =>
                input.objective === undefined
                  ? this.#octokit.request("GET /repos/{owner}/{repo}/issues/comments", {
                      owner: this.#owner,
                      repo: this.#repo,
                      // The delta predicate remains updated_at-based, while
                      // immutable creation order prevents edits from moving
                      // rows across live page offsets.
                      sort: "created",
                      direction: "asc",
                      since: input.since!,
                      per_page: 100,
                      page,
                      ...(page === 1 && input.etag
                        ? { headers: { "if-none-match": input.etag } }
                        : {}),
                    })
                  : this.#octokit.request(
                      "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
                      {
                        owner: this.#owner,
                        repo: this.#repo,
                        issue_number: input.objective,
                        per_page: 100,
                        page,
                      },
                    ),
              ),
            ),
        );
      } catch (error) {
        if (page === 1 && input.etag && this.#status(error) === 304) {
          return { items: [], requests: 1, notModified: true, etag: input.etag };
        }
        recordPartialDiscoveryRequests(error, requests + (transported ? 1 : 0));
        throw error;
      }
      requests++;
      try {
        nextEtag ??= this.#etag(response.headers);
        const observedAt = responseDate(response).toISOString();
        firstResponseAt ??= observedAt;
        for (const raw of response.data) {
          const id = String(raw.id);
          if (!/^\d+$/.test(id)) throw new Error("GitHub comment discovery returned an invalid ID");
          const issueNumber = input.objective ?? this.#commentIssueNumber(raw.issue_url);
          byId.set(id, {
            id,
            issueNumber,
            body: raw.body ?? "",
            authorLogin: raw.user?.login ?? null,
            authorAssociation: raw.author_association ?? null,
            updatedAt: raw.updated_at ?? raw.created_at ?? observedAt,
          });
        }
        if (!this.#hasNext(response.headers))
          return {
            items: [...byId.values()],
            requests,
            notModified: false,
            ...(requests === 1 && response.data.length < 100 && nextEtag ? { etag: nextEtag } : {}),
            ...(input.objective === undefined && requests > 1 && firstResponseAt
              ? { safeThrough: firstResponseAt }
              : {}),
          };
      } catch (error) {
        recordPartialDiscoveryRequests(error, requests);
        throw error;
      }
    }
    const error = new Error(
      input.objective === undefined
        ? "repository comment delta exceeds its page limit"
        : `Objective #${input.objective} exceeds the controller comment limit`,
    );
    recordPartialDiscoveryRequests(error, requests);
    throw error;
  }

  async #listDiscoveryControlRefs(
    etag?: string,
  ): Promise<DiscoveryCollection<DiscoveryControlRef>> {
    let response;
    let transported = false;
    try {
      response = await withGitHubTransportCallbacks(
        { onTransported: () => (transported = true) },
        () =>
          withGitHubRequestPriority("normal", () =>
            this.#call(() =>
              this.#octokit.request("GET /repos/{owner}/{repo}/git/matching-refs/{ref}", {
                owner: this.#owner,
                repo: this.#repo,
                ref: "clockgrove-factory/",
                ...(etag ? { headers: { "if-none-match": etag } } : {}),
              }),
            ),
          ),
      );
    } catch (error) {
      if (etag && this.#status(error) === 304)
        return { items: [], requests: 1, notModified: true, etag };
      recordPartialDiscoveryRequests(error, transported ? 1 : 0);
      throw error;
    }
    try {
      if (response.data.length > DISCOVERY_SESSION_LIMITS.controlRefs)
        throw new Error("repository control-ref discovery exceeds its record limit");
      const serverTime = responseDate(response);
      const items: DiscoveryControlRef[] = [];
      const seen = new Map<string, string>();
      for (const raw of response.data) {
        const lease = /^refs\/clockgrove-factory\/leases\/objective-(\d+)$/.exec(raw.ref);
        const recovery =
          /^refs\/clockgrove-factory\/recovery-plans\/objective-(\d+)\/plan-[a-f0-9]{64}$/.exec(
            raw.ref,
          );
        const match = lease ?? recovery;
        if (!match) continue;
        const objective = Number(match[1]);
        if (!Number.isInteger(objective) || objective <= 0)
          throw new Error("GitHub control-ref discovery returned an invalid ref");
        const prior = seen.get(raw.ref);
        if (prior && prior !== raw.object.sha)
          throw new Error(`GitHub returned conflicting values for control ref ${raw.ref}`);
        if (prior) continue;
        seen.set(raw.ref, raw.object.sha);
        items.push({
          kind: lease ? "lease" : "recovery-plan",
          objective,
          ref: raw.ref,
          oid: raw.object.sha,
          serverTime,
        });
      }
      const responseEtag = this.#etag(response.headers);
      return {
        items,
        requests: 1,
        notModified: false,
        ...(responseEtag ? { etag: responseEtag } : {}),
      };
    } catch (error) {
      recordPartialDiscoveryRequests(error, transported ? 1 : 0);
      throw error;
    }
  }

  async #classifyDiscoveryObjective(input: {
    login: string;
    issue: DiscoveryIssue;
    comments: DiscoveryComment[];
    revision: number;
    authority?: DiscoveryControlRef | null;
  }): Promise<{
    activation: Omit<DurableObjectiveActivation, "discoveryRevision"> | null;
    writerBound: boolean;
    authorityOid: string | null;
    recoveryBound: boolean;
  }> {
    const controllerLogin = input.login.toLowerCase();
    const commentsForAuthentication = input.comments.map((comment) => ({
      body: comment.body,
      authorLogin: comment.authorLogin,
      authorAssociation: comment.authorAssociation,
    }));
    const writerBound = commentsForAuthentication.some(
      (comment) =>
        comment.authorLogin?.toLowerCase() === controllerLogin &&
        TRUSTED_CONTROL_ASSOCIATIONS.has(comment.authorAssociation ?? "") &&
        decodeEventComments(comment.body).some(
          (event) =>
            event.writerEpoch !== undefined ||
            event.writerOperationId !== undefined ||
            event.writerHolder !== undefined ||
            event.writerPolicyDigest !== undefined,
        ),
    );
    let authority: ObjectiveAuthorityObservation | undefined;
    let authorityOid: string | null = null;
    if (writerBound) {
      const ref =
        input.authority === undefined
          ? await this.#readDiscoveryLeaseRef(input.issue.number)
          : input.authority;
      if (!ref)
        throw new Error(
          `Objective #${input.issue.number} has writer-bound receipts but no authoritative lease ref`,
        );
      authorityOid = ref.oid;
      const lease = parseLeaseCommit(await this.#readDiscoveryCommit(ref.oid, ref.serverTime));
      if (lease.objective !== input.issue.number)
        throw new Error(`Objective #${input.issue.number} authority ref names another Objective`);
      authority = objectiveAuthorityObservation(lease, ref.serverTime);
    }
    const authenticated = deduplicateFactoryEvents(
      authenticatedCommentEvents(commentsForAuthentication, authority)
        .filter(({ login }) => login.toLowerCase() === controllerLogin)
        .map(({ event }) => event),
    ).map((event) => ({ event, login: controllerLogin }));
    const events = authenticated.map(({ event }) => event);
    const recoveryBound = events.some((event) => event.event === "RecoveryRequested");
    const recovery = await discoverRecoveryActivation({
      repository: `${this.#owner}/${this.#repo}`,
      objective: input.issue.number,
      actor: controllerLogin,
      closed: input.issue.state === "closed",
      events,
      ...(authority === undefined ? {} : { authority }),
      store: this,
    });
    if (recovery) {
      const active = latestSupportedRun(events, authority);
      return {
        activation: {
          ...recovery,
          ...(active?.event === "FactoryRunStarted" &&
          active.runId === recovery.recovery?.successorRunId
            ? { resuming: true }
            : {}),
        },
        writerBound,
        authorityOid,
        recoveryBound,
      };
    }
    const activationsByRequest = new Map<string, string>();
    for (const { event, login } of authenticated) {
      if (
        event.kind !== "run" ||
        event.event !== "ActivationRequested" ||
        event.objective !== input.issue.number
      )
        continue;
      const policy = parseRunPolicy(event.policy);
      if (
        event.repository.toLowerCase() !== `${this.#owner}/${this.#repo}`.toLowerCase() ||
        event.runId !== event.requestId ||
        event.requestedBy.toLowerCase() !== login.toLowerCase() ||
        event.policyDigest !== policyDigest(policy) ||
        event.controllerProtocolMin !== PROTOCOL_V2 ||
        event.controllerProtocolMax !== PROTOCOL_V2
      )
        throw new Error(
          `Objective #${input.issue.number} has an invalid authenticated activation receipt`,
        );
      const encoded = JSON.stringify(event);
      const prior = activationsByRequest.get(event.requestId);
      if (prior && prior !== encoded)
        throw new Error(
          `Objective #${input.issue.number} has conflicting activations for request ${event.requestId}`,
        );
      activationsByRequest.set(event.requestId, encoded);
    }
    let activationIndex = -1;
    for (let index = events.length - 1; index >= 0; index--) {
      const event = events[index]!;
      if (
        event.kind === "run" &&
        event.event === "ActivationRequested" &&
        event.objective === input.issue.number
      ) {
        activationIndex = index;
        break;
      }
    }
    const activationEntry = activationIndex < 0 ? undefined : authenticated[activationIndex];
    const activation = activationEntry?.event;
    const activationRequest =
      activation?.kind === "run" && activation.event === "ActivationRequested"
        ? activation
        : undefined;
    const terminalAfterActivation =
      activationIndex >= 0 &&
      activationRequest !== undefined &&
      events
        .slice(activationIndex + 1)
        .some(
          (event) =>
            event.kind === "run" &&
            event.objective === input.issue.number &&
            event.event !== "FactoryRunStarted" &&
            hasCurrentWriterAuthority(event, events, authority) &&
            events.some(
              (candidate) =>
                candidate.kind === "run" &&
                candidate.event === "FactoryRunStarted" &&
                candidate.runId === event.runId &&
                candidate.activationRequestId === activationRequest.requestId &&
                candidate.actor.toLowerCase() === activationRequest.requestedBy.toLowerCase() &&
                candidate.policyDigest === activationRequest.policyDigest &&
                candidate.baseSha === activationRequest.baseSha,
            ) &&
            ["FactoryRunCompleted", "FactoryRunCancelled", "FactoryRunEscalated"].includes(
              event.event,
            ),
        );
    const rejectionAfterActivation =
      activationIndex >= 0 &&
      activationRequest !== undefined &&
      events
        .slice(activationIndex + 1)
        .some(
          (event) =>
            event.kind === "run" &&
            event.event === "ActivationRejected" &&
            event.objective === input.issue.number &&
            event.runId === activationRequest.runId &&
            event.activationRequestId === activationRequest.requestId &&
            event.requestedBy.toLowerCase() === activationRequest.requestedBy.toLowerCase() &&
            event.baseSha === activationRequest.baseSha &&
            event.policyDigest === activationRequest.policyDigest,
        );
    const activeRun = latestSupportedRun(events, authority);
    const currentRun =
      activeRun?.kind === "run" &&
      activeRun.event === "FactoryRunStarted" &&
      activeRun.activationRequestId === activationRequest?.requestId
        ? activeRun
        : null;
    const commandState = currentRun
      ? deriveDurableCommandState({
          events,
          objective: input.issue.number,
          runId: currentRun.runId,
          runActor: currentRun.actor,
          runStartSequence: currentRun.sequence,
        })
      : null;
    const gateAcknowledged = Boolean(
      currentRun &&
        commandState?.admissionGate &&
        events.some(
          (event) =>
            event.kind === "run" &&
            event.runId === currentRun.runId &&
            hasCurrentWriterAuthority(event, events, authority) &&
            event.event ===
              (commandState.admissionGate!.kind === "drain"
                ? "RunDrainCompleted"
                : "RunPauseAcknowledged") &&
            event.commandRequestId === commandState.admissionGate!.requestId,
        ),
    );
    const operationallyStopped = Boolean(commandState?.admissionsPaused && gateAcknowledged);
    const withdrawal = activationRequest && activationCancellation(events, activationRequest);
    const discovered =
      activationRequest &&
      !terminalAfterActivation &&
      !rejectionAfterActivation &&
      (currentRun || !withdrawal) &&
      (input.issue.state === "closed" || !operationallyStopped || withdrawal)
        ? {
            objective: input.issue.number,
            activatedAt: activationRequest.at,
            requestId: activationRequest.requestId,
            policy: activationRequest.policy,
            policyDigest: activationRequest.policyDigest,
            baseSha: activationRequest.baseSha,
            requestedBy: activationEntry!.login,
            ...(currentRun ? { resuming: true } : {}),
          }
        : null;
    return { activation: discovered, writerBound, authorityOid, recoveryBound };
  }

  async #readDiscoveryLeaseRef(objective: number): Promise<DiscoveryControlRef | null> {
    try {
      const response = await withGitHubRequestPriority("normal", () =>
        this.#call(() =>
          this.#octokit.request("GET /repos/{owner}/{repo}/git/ref/{ref}", {
            owner: this.#owner,
            repo: this.#repo,
            ref: stripRefs(leaseRef(objective)),
          }),
        ),
      );
      return {
        kind: "lease",
        objective,
        ref: leaseRef(objective),
        oid: response.data.object.sha,
        serverTime: responseDate(response),
      };
    } catch (error) {
      if (this.#status(error) === 404) return null;
      throw error;
    }
  }

  async #readDiscoveryCommit(oid: string, serverTime: Date): Promise<GitCommitObject> {
    const cached = this.#discoveryCommitCache.get(oid);
    if (cached) return { ...cached, serverTime };
    const commit = await withGitHubRequestPriority("normal", () => this.readCommit(oid));
    const { serverTime: _observedAt, ...content } = commit;
    if (this.#discoveryCommitCache.size === 256)
      this.#discoveryCommitCache.delete(this.#discoveryCommitCache.keys().next().value!);
    this.#discoveryCommitCache.set(oid, content);
    return { ...content, serverTime };
  }

  #commentIssueNumber(issueUrl: unknown): number {
    if (typeof issueUrl !== "string")
      throw new Error("repository comment delta omitted its issue URL");
    const url = new URL(issueUrl);
    const match = /^\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)$/.exec(url.pathname);
    if (
      url.hostname.toLowerCase() !== "api.github.com" ||
      match?.[1]?.toLowerCase() !== this.#owner.toLowerCase() ||
      match?.[2]?.toLowerCase() !== this.#repo.toLowerCase()
    )
      throw new Error("repository comment delta returned another repository's issue URL");
    const number = Number(match[3]);
    if (!Number.isInteger(number) || number <= 0)
      throw new Error("repository comment delta returned an invalid issue URL");
    return number;
  }

  #etag(headers: Record<string, string | number | undefined>): string | undefined {
    const entry = Object.entries(headers).find(([name]) => name.toLowerCase() === "etag");
    return entry?.[1] === undefined ? undefined : String(entry[1]);
  }

  #hasNext(headers: Record<string, string | number | undefined>): boolean {
    const link = Object.entries(headers).find(([name]) => name.toLowerCase() === "link")?.[1];
    return typeof link === "string" && /<[^>]+>;\s*rel="next"/.test(link);
  }

  #status(error: unknown): number | undefined {
    return (
      (error as { status?: number; response?: { status?: number } }).status ??
      (error as { response?: { status?: number } }).response?.status
    );
  }

  async readRepositoryPermission(login: string): Promise<string> {
    const response = await this.#call(() =>
      this.#octokit.request("GET /repos/{owner}/{repo}/collaborators/{username}/permission", {
        owner: this.#owner,
        repo: this.#repo,
        username: login,
      }),
    );
    return response.data.permission;
  }

  async getRepositoryFacts(): Promise<{
    fullName: string;
    fork: boolean;
    private: boolean;
    defaultBranch: string;
    canPush: boolean;
  }> {
    const response = await this.#call(() =>
      this.#octokit.request("GET /repos/{owner}/{repo}", {
        owner: this.#owner,
        repo: this.#repo,
      }),
    );
    return {
      fullName: response.data.full_name,
      fork: response.data.fork,
      private: response.data.private,
      defaultBranch: response.data.default_branch,
      canPush: response.data.permissions?.push === true,
    };
  }

  async readBranchRules(branch: string): Promise<Array<{ type: string; parameters?: unknown }>> {
    const rules: Array<{ type: string; parameters?: unknown }> = [];
    try {
      for (let page = 1; page <= 10; page += 1) {
        const response = await this.#call(() =>
          this.#octokit.request("GET /repos/{owner}/{repo}/rules/branches/{branch}", {
            owner: this.#owner,
            repo: this.#repo,
            branch,
            per_page: 100,
            page,
          }),
        );
        rules.push(
          ...response.data.map((rule) => {
            const record = rule as { type: string; parameters?: unknown };
            return {
              type: record.type,
              ...(record.parameters === undefined ? {} : { parameters: record.parameters }),
            };
          }),
        );
        if (response.data.length < 100) break;
        if (page === 10) {
          throw new Error("branch rule result exceeds Factory's 1000-rule snapshot limit");
        }
      }
    } catch (error) {
      if (
        (error as { status?: number }).status !== 404 &&
        !isUnavailablePrivateRepositoryRuleFeature(
          error,
          "https://docs.github.com/rest/repos/rules#get-rules-for-a-branch",
        )
      )
        throw error;
    }

    // GitHub rulesets and classic branch protection are separate APIs. A
    // repository may use either or both, so omitting this read could bypass a
    // classic review/check requirement until the merge request fails.
    try {
      const response = await this.#call(() =>
        this.#octokit.request("GET /repos/{owner}/{repo}/branches/{branch}/protection", {
          owner: this.#owner,
          repo: this.#repo,
          branch,
        }),
      );
      rules.push(...classicBranchProtectionRules(response.data));
    } catch (error) {
      if (
        (error as { status?: number }).status !== 404 &&
        !isUnavailablePrivateRepositoryRuleFeature(
          error,
          "https://docs.github.com/rest/branches/branch-protection#get-branch-protection",
        )
      )
        throw error;
    }
    return rules;
  }

  async getBranchHead(branch: string): Promise<GitCommitObject> {
    const oid = await this.readRef(`refs/heads/${branch}`);
    if (!oid) throw new Error(`branch ${branch} does not exist`);
    return this.readCommit(oid);
  }

  async createBlob(content: Buffer): Promise<string> {
    const response = await this.#call(
      () =>
        this.#octokit.request("POST /repos/{owner}/{repo}/git/blobs", {
          owner: this.#owner,
          repo: this.#repo,
          content: content.toString("base64"),
          encoding: "base64",
        }),
      true,
      "normal",
      "createBlob",
      "immutable-preparation",
    );
    return response.data.sha;
  }

  async readBlob(oid: string): Promise<Buffer> {
    const response = await this.#call(() =>
      this.#octokit.request("GET /repos/{owner}/{repo}/git/blobs/{file_sha}", {
        owner: this.#owner,
        repo: this.#repo,
        file_sha: oid,
      }),
    );
    if (response.data.encoding !== "base64") {
      throw new Error(`unsupported GitHub blob encoding ${response.data.encoding}`);
    }
    return Buffer.from(response.data.content.replace(/\s/g, ""), "base64");
  }

  async createTree(args: {
    baseTreeOid?: string;
    entries: Array<{
      path: string;
      mode: "100644" | "100755" | "120000";
      type: "blob";
      sha: string | null;
    }>;
  }): Promise<string> {
    const response = await this.#call(
      () =>
        this.#octokit.request("POST /repos/{owner}/{repo}/git/trees", {
          owner: this.#owner,
          repo: this.#repo,
          ...(args.baseTreeOid ? { base_tree: args.baseTreeOid } : {}),
          tree: args.entries,
        }),
      true,
      "normal",
      "createTree",
      "immutable-preparation",
    );
    return response.data.sha;
  }

  async readTreeEntry(treeOid: string, path: string): Promise<string | null> {
    const response = await this.#call(() =>
      this.#octokit.request("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", {
        owner: this.#owner,
        repo: this.#repo,
        tree_sha: treeOid,
        recursive: "1",
      }),
    );
    if (response.data.truncated) {
      throw new Error("GitHub truncated the compiled graph control tree");
    }
    const entry = response.data.tree.find((candidate) => candidate.path === path);
    if (!entry) return null;
    if (entry.type !== "blob" || !entry.sha) {
      throw new Error(`compiled graph tree entry ${path} is not a blob`);
    }
    return entry.sha;
  }

  /** Read one Git tree directory without recursively materializing an ever-growing tree. */
  async readTreeDirectory(
    treeOid: string,
    path: string,
  ): Promise<Array<{ name: string; type: "blob" | "tree"; sha: string }> | null> {
    const segments = path.split("/").filter(Boolean);
    let current = treeOid;
    for (const segment of segments) {
      const response = await this.#call(() =>
        this.#octokit.request("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", {
          owner: this.#owner,
          repo: this.#repo,
          tree_sha: current,
        }),
      );
      if (response.data.truncated) throw new Error(`Git tree directory ${path} was truncated`);
      const entry = response.data.tree.find((candidate) => candidate.path === segment);
      if (!entry) return null;
      if (entry.type !== "tree" || !entry.sha)
        throw new Error(`Git tree path ${path} crosses non-directory entry ${segment}`);
      current = entry.sha;
    }
    const response = await this.#call(() =>
      this.#octokit.request("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", {
        owner: this.#owner,
        repo: this.#repo,
        tree_sha: current,
      }),
    );
    if (response.data.truncated) throw new Error(`Git tree directory ${path} was truncated`);
    return response.data.tree.map((entry) => {
      if ((entry.type !== "blob" && entry.type !== "tree") || !entry.path || !entry.sha)
        throw new Error(`Git tree directory ${path} contains an unsupported entry`);
      return { name: entry.path, type: entry.type, sha: entry.sha };
    });
  }

  async findPullRequestForBranch(branch: string): Promise<{
    number: number;
    htmlUrl: string;
    state: string;
    merged: boolean;
    headSha: string;
  } | null> {
    const response = await this.#call(() =>
      this.#octokit.request("GET /repos/{owner}/{repo}/pulls", {
        owner: this.#owner,
        repo: this.#repo,
        state: "all",
        head: `${this.#owner}:${branch}`,
        per_page: 10,
      }),
    );
    const pull = response.data[0];
    return pull
      ? {
          number: pull.number,
          htmlUrl: pull.html_url,
          state: pull.state,
          merged: Boolean(pull.merged_at),
          headSha: pull.head.sha,
        }
      : null;
  }

  async createPullRequest(args: {
    title: string;
    body: string;
    head: string;
    base: string;
  }): Promise<{ number: number; htmlUrl: string; headSha: string }> {
    const response = await this.#call(
      () =>
        this.#octokit.request("POST /repos/{owner}/{repo}/pulls", {
          owner: this.#owner,
          repo: this.#repo,
          title: args.title,
          body: args.body,
          head: args.head,
          base: args.base,
        }),
      true,
      "normal",
      "createPullRequest",
    );
    return {
      number: response.data.number,
      htmlUrl: response.data.html_url,
      headSha: response.data.head.sha,
    };
  }

  /** Bounded discovery only: callers must authenticate each Objective's durable
   * run, graph, publication and exact merge proof before trusting these hints. */
  async readCommitObjectiveCandidates(sha: string): Promise<number[]> {
    if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("invalid integration commit identity");
    const pulls = await this.#call(() =>
      this.#octokit.request("GET /repos/{owner}/{repo}/commits/{commit_sha}/pulls", {
        owner: this.#owner,
        repo: this.#repo,
        commit_sha: sha,
        per_page: 100,
      }),
    );
    if (pulls.data.length >= 100)
      throw new Error("commit association exceeds bounded integration discovery");
    const candidates = new Set<number>();
    for (const pull of pulls.data) {
      const match =
        /^factory\/objective-([1-9][0-9]*)\/work-item-[1-9][0-9]*\/attempt-[1-9][0-9]*$/.exec(
          pull.head.ref,
        );
      if (match) candidates.add(Number(match[1]));
    }
    if (pulls.data.length) {
      const result = await this.#call(() =>
        this.#octokit.graphql<{
          nodes: ({
            closingIssuesReferences: {
              nodes: { parent: { number: number } | null }[];
              pageInfo: { hasNextPage: boolean };
            };
          } | null)[];
        }>(
          `query IntegrationObjectiveHints($ids: [ID!]!) {
        nodes(ids: $ids) { ... on PullRequest { closingIssuesReferences(first: 100) {
          nodes { parent { number } } pageInfo { hasNextPage }
        } } }
      }`,
          { ids: pulls.data.map((pull) => pull.node_id) },
        ),
      );
      for (const node of result.nodes) {
        if (!node?.closingIssuesReferences) continue;
        if (node.closingIssuesReferences.pageInfo.hasNextPage)
          throw new Error("commit closing-issue association exceeds bounded integration discovery");
        for (const issue of node.closingIssuesReferences.nodes)
          if (issue.parent) candidates.add(issue.parent.number);
      }
    }
    return [...candidates]
      .filter((number) => Number.isSafeInteger(number) && number > 0)
      .sort((a, b) => a - b);
  }

  async readPullRequest(number: number): Promise<{
    number?: number;
    nodeId?: string;
    baseRepository?: string;
    headRepository?: string | null;
    headRef?: string;
    state: string;
    merged: boolean;
    mergeable: boolean | null;
    mergeableState: string;
    draft: boolean;
    headSha: string;
    baseSha: string;
    baseRef: string;
    mergeCommitSha: string | null;
    createdAt: Date;
  }> {
    const response = await this.#call(() =>
      this.#octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
        owner: this.#owner,
        repo: this.#repo,
        pull_number: number,
      }),
    );
    return {
      number: response.data.number,
      nodeId: response.data.node_id,
      baseRepository: response.data.base.repo.full_name,
      headRepository: response.data.head.repo?.full_name ?? null,
      headRef: response.data.head.ref,
      state: response.data.state,
      merged: response.data.merged,
      mergeable: response.data.mergeable,
      mergeableState: response.data.mergeable_state,
      draft: response.data.draft ?? false,
      headSha: response.data.head.sha,
      baseSha: response.data.base.sha,
      baseRef: response.data.base.ref,
      mergeCommitSha: response.data.merge_commit_sha,
      createdAt: new Date(response.data.created_at),
    };
  }

  async readChecks(sha: string): Promise<{
    pending: string[];
    failed: string[];
    observed: string[];
    observedChecks: Array<{ context: string; integrationId: number | null }>;
  }> {
    const [checks, statuses] = await Promise.all([
      (async () => {
        const result: Array<{
          name: string;
          status: string;
          conclusion: string | null;
          appId: number | null;
        }> = [];
        for (let page = 1; page <= 30; page += 1) {
          const response = await this.#call(() =>
            this.#octokit.request("GET /repos/{owner}/{repo}/commits/{ref}/check-runs", {
              owner: this.#owner,
              repo: this.#repo,
              ref: sha,
              per_page: 100,
              page,
              filter: "latest",
            }),
          );
          result.push(
            ...response.data.check_runs.map((check) => ({
              name: check.name,
              status: check.status,
              conclusion: check.conclusion,
              appId: check.app?.id ?? null,
            })),
          );
          if (result.length >= response.data.total_count) return result;
          if (response.data.check_runs.length < 100) {
            throw new Error("GitHub check-run history is incomplete; retry the snapshot");
          }
        }
        throw new Error("check-run result exceeds GitHub's 3000-item snapshot limit");
      })(),
      (async () => {
        const result: Array<{ context: string; state: string }> = [];
        for (let page = 1; page <= 30; page += 1) {
          const response = await this.#call(() =>
            this.#octokit.request("GET /repos/{owner}/{repo}/commits/{ref}/statuses", {
              owner: this.#owner,
              repo: this.#repo,
              ref: sha,
              per_page: 100,
              page,
            }),
          );
          result.push(...response.data);
          if (response.data.length < 100) return result;
        }
        throw new Error("commit-status result exceeds Factory's 3000-item snapshot limit");
      })(),
    ]);
    const pending: string[] = [];
    const failed: string[] = [];
    const observed: string[] = [];
    const observedChecks: Array<{
      context: string;
      integrationId: number | null;
    }> = [];
    for (const check of checks) {
      observed.push(check.name);
      observedChecks.push({ context: check.name, integrationId: check.appId });
      if (check.status !== "completed") pending.push(check.name);
      else if (!new Set(["success", "neutral", "skipped"]).has(check.conclusion ?? "")) {
        failed.push(check.name);
      }
    }
    const latestStatuses = new Map<string, { context: string; state: string }>();
    // GitHub returns commit statuses newest first. Only the newest result for
    // a context participates in the combined status; an older failed retry
    // must not override a newer success.
    for (const status of statuses) {
      if (!latestStatuses.has(status.context)) latestStatuses.set(status.context, status);
    }
    for (const status of latestStatuses.values()) {
      observed.push(status.context);
      observedChecks.push({ context: status.context, integrationId: null });
      if (status.state === "pending") pending.push(status.context);
      else if (status.state !== "success") failed.push(status.context);
    }
    return {
      pending: [...new Set(pending)],
      failed: [...new Set(failed)],
      observed: [...new Set(observed)],
      observedChecks: observedChecks.filter(
        (check, index, all) =>
          all.findIndex(
            (candidate) =>
              candidate.context === check.context &&
              candidate.integrationId === check.integrationId,
          ) === index,
      ),
    };
  }

  async mergePullRequest(args: {
    number: number;
    headSha: string;
    commitTitle: string;
  }): Promise<string> {
    let response;
    try {
      response = await this.#call(
        () =>
          this.#octokit.request("PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge", {
            owner: this.#owner,
            repo: this.#repo,
            pull_number: args.number,
            sha: args.headSha,
            merge_method: "squash",
            commit_title: args.commitTitle,
          }),
        true,
        "normal",
        "mergePullRequest",
      );
    } catch (error) {
      const current = await this.#call(() =>
        this.#octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
          owner: this.#owner,
          repo: this.#repo,
          pull_number: args.number,
        }),
      );
      if (current.data.merged && current.data.merge_commit_sha) {
        return current.data.merge_commit_sha;
      }
      throw error;
    }
    if (!response.data.merged || !response.data.sha) {
      throw new Error(response.data.message || `pull request #${args.number} was not merged`);
    }
    return response.data.sha;
  }

  async closePullRequest(number: number): Promise<void> {
    await this.#call(
      () =>
        this.#octokit.request("PATCH /repos/{owner}/{repo}/pulls/{pull_number}", {
          owner: this.#owner,
          repo: this.#repo,
          pull_number: number,
          state: "closed",
        }),
      true,
      "cleanup",
      "closePullRequest",
    );
  }

  async closeIssue(number: number): Promise<void> {
    await this.#call(
      () =>
        this.#octokit.request("PATCH /repos/{owner}/{repo}/issues/{issue_number}", {
          owner: this.#owner,
          repo: this.#repo,
          issue_number: number,
          state: "closed",
          state_reason: "completed",
        }),
      true,
      "cleanup",
      "closeIssue",
    );
  }

  async assignIssue(number: number, login: string): Promise<void> {
    await this.#call(
      () =>
        this.#octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/assignees", {
          owner: this.#owner,
          repo: this.#repo,
          issue_number: number,
          assignees: [login],
        }),
      true,
      "normal",
      "assignIssue",
    );
  }

  async #getRepositoryId(): Promise<string> {
    if (this.#repositoryId) return this.#repositoryId;
    const data = await this.#call(() =>
      this.#octokit.graphql<{ repository: { id: string } }>(
        "query FactoryRepositoryId($owner: String!, $repo: String!) { repository(owner: $owner, name: $repo) { id } }",
        { owner: this.#owner, repo: this.#repo },
      ),
    );
    this.#repositoryId = data.repository.id;
    return this.#repositoryId;
  }
}
