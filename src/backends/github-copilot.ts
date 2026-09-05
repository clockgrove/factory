import type { Dispatcher } from "../dispatch.js";
import type {
  AttemptContext,
  BackendHandle,
  BackendObservation,
  BackendProbe,
  ExecutionBackend,
  ExecutionBackendCapabilities,
  StaleAttemptIdentity,
} from "../execution/backend.js";
import { normalizeArtifact, type NormalizedArtifact } from "../execution/artifacts.js";
import { durableAttemptId } from "../execution/session.js";
import type { GitHubReader } from "../github.js";
import { assertNoSecretMaterial } from "../protocol/limits.js";
import { runContainedProcess } from "../runtime/process-group.js";
import {
  attemptCount,
  currentOpenPullRequest,
  derive,
  deriveState,
  type DerivedWorkItem,
} from "../state.js";
import { COPILOT_ASSIGNEE_LOGIN, type ManagedAgentActor } from "../types.js";

interface ManagedAttempt {
  context: AttemptContext;
  issueNodeId: string;
  handle: BackendHandle;
  preexistingPullNumbers: ReadonlySet<number>;
}

export interface GitHubCopilotBackendOptions {
  reader: GitHubReader;
  dispatcher: Dispatcher;
  repository: string;
  copilotAvailable: boolean;
}

export interface GitHubManagedAgentProfile {
  backendId: string;
  agentKind: string;
  displayName: string;
  /** Exact, provider-published Bot logins accepted from the capability response. */
  actorLogins: readonly string[];
  /** Observed issue-assignee aliases used only to interpret lifecycle state. */
  assigneeLogins: readonly string[];
  requiredCapability: string;
  /** Provider identity is unusable until this release-gated evidence exists. */
  actorDiscoveryBlocker?: string;
}

function frozenProfile(profile: GitHubManagedAgentProfile): GitHubManagedAgentProfile {
  return Object.freeze({
    ...profile,
    actorLogins: Object.freeze([...profile.actorLogins]),
    assigneeLogins: Object.freeze([...profile.assigneeLogins]),
  });
}

export const GITHUB_COPILOT_MANAGED_PROFILE = frozenProfile({
  backendId: "github-copilot/github-managed",
  agentKind: "github-copilot",
  displayName: "GitHub Copilot coding agent",
  actorLogins: ["copilot-swe-agent"],
  assigneeLogins: ["Copilot", "copilot-swe-agent"],
  requiredCapability: "github-copilot-coding-agent",
});

export const OPENAI_CODEX_MANAGED_PROFILE = frozenProfile({
  backendId: "openai-codex/github-managed",
  agentKind: "openai-codex",
  displayName: "OpenAI Codex coding agent",
  actorLogins: [],
  assigneeLogins: [],
  requiredCapability: "openai-codex-coding-agent",
  actorDiscoveryBlocker:
    "OpenAI Codex managed-agent discovery is release-blocked: GitHub does not publish a " +
    "stable suggestedActors Bot login or app identity, and no live conformance evidence has " +
    "established one",
});

export const GITHUB_MANAGED_AGENT_PROFILES: readonly GitHubManagedAgentProfile[] = Object.freeze([
  GITHUB_COPILOT_MANAGED_PROFILE,
  OPENAI_CODEX_MANAGED_PROFILE,
]);

const MANAGED_ATTRIBUTION_CLOCK_SKEW_MS = 2 * 60_000;
const TERMINAL_AGENT_TASK_STATES = new Set(["completed", "failed", "timed_out", "cancelled"]);

class ManagedAssignmentDeadlineError extends Error {}

function sameValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function canonicalProfile(profile: GitHubManagedAgentProfile): GitHubManagedAgentProfile {
  const canonical = GITHUB_MANAGED_AGENT_PROFILES.find(
    (candidate) => candidate.backendId === profile.backendId,
  );
  if (
    !canonical ||
    canonical.agentKind !== profile.agentKind ||
    canonical.displayName !== profile.displayName ||
    canonical.requiredCapability !== profile.requiredCapability ||
    canonical.actorDiscoveryBlocker !== profile.actorDiscoveryBlocker ||
    !sameValues(canonical.actorLogins, profile.actorLogins) ||
    !sameValues(canonical.assigneeLogins, profile.assigneeLogins)
  ) {
    throw new Error(`unsupported GitHub-managed agent profile ${profile.backendId}`);
  }
  return canonical;
}

function sameLogin(left: string, right: string): boolean {
  const normalize = (login: string) =>
    login
      .replace(/\[bot\]$/i, "")
      .trim()
      .toLowerCase();
  return normalize(left) === normalize(right);
}

function sameActorLogin(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

export interface ManagedAgentActorResolution {
  actor: ManagedAgentActor | null;
  reason?: string;
}

/** Resolve an opaque actor ID only from GitHub's bounded capability response. */
export function resolveManagedAgentActor(
  profile: GitHubManagedAgentProfile,
  actors: readonly ManagedAgentActor[],
): ManagedAgentActorResolution {
  profile = canonicalProfile(profile);
  if (profile.actorDiscoveryBlocker) {
    return { actor: null, reason: profile.actorDiscoveryBlocker };
  }
  const matches = actors.filter(
    (actor) =>
      actor.type === "Bot" &&
      actor.id.trim() !== "" &&
      actor.login.trim() !== "" &&
      profile.actorLogins.some((login) => sameActorLogin(actor.login, login)),
  );
  if (matches.length === 1) return { actor: matches[0]! };
  if (matches.length > 1) {
    return {
      actor: null,
      reason: `${profile.displayName} actor discovery was ambiguous (${matches
        .map((actor) => actor.login)
        .sort()
        .join(", ")})`,
    };
  }
  return {
    actor: null,
    reason: `${profile.displayName} is not exposed as an assignable repository actor`,
  };
}

export interface GitHubManagedAgentBackendOptions {
  reader: GitHubReader;
  dispatcher?: Dispatcher;
  repository: string;
  profile: GitHubManagedAgentProfile;
  actorResolution: ManagedAgentActorResolution;
  /** Deterministic clock seam; production callers use the wall clock. */
  now?: () => number;
  /** Deterministic git seam; production callers use the contained process runner. */
  runGit?: (repository: string, args: string[]) => Promise<string>;
}

function safeDiagnostic(value: unknown, label: string): string {
  const diagnostic = (value instanceof Error ? value.message : String(value)).slice(0, 8_000);
  try {
    assertNoSecretMaterial(diagnostic, label);
    return diagnostic;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function asLegacy(item: DerivedWorkItem, now: Date): DerivedWorkItem {
  const {
    factoryEvents: _events,
    state: _state,
    attempts: _attempts,
    doneWithoutMergedPullRequest: _closed,
    ...snapshot
  } = item;
  const state = deriveState(snapshot, now);
  return {
    ...snapshot,
    state,
    attempts: attemptCount(snapshot),
    doneWithoutMergedPullRequest:
      state === "done" &&
      !snapshot.linkedPullRequests.some((pullRequest) => pullRequest.state === "MERGED"),
  };
}

async function git(repository: string, args: string[]): Promise<string> {
  const result = await runContainedProcess({
    command: "git",
    args,
    cwd: repository,
    env: process.env,
    timeoutMs: 120_000,
    maxOutputBytes: 6 * 1024 * 1024,
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

/** Explicit paid GitHub-managed agent selected only by immutable run policy. */
export class GitHubManagedAgentBackend implements ExecutionBackend {
  readonly capabilities: ExecutionBackendCapabilities;

  readonly #options: GitHubManagedAgentBackendOptions;
  readonly #attempts = new Map<string, ManagedAttempt>();
  readonly #now: () => number;
  readonly #runGit: (repository: string, args: string[]) => Promise<string>;

  constructor(options: GitHubManagedAgentBackendOptions) {
    const profile = canonicalProfile(options.profile);
    const actor = options.actorResolution.actor;
    if (
      actor &&
      (profile.actorDiscoveryBlocker !== undefined ||
        actor.type !== "Bot" ||
        actor.id.trim() === "" ||
        !profile.actorLogins.some((login) => sameActorLogin(actor.login, login)))
    ) {
      throw new Error(
        `${profile.displayName} actor resolution does not match its exact assignable Bot profile`,
      );
    }
    this.#options = {
      ...options,
      profile,
      actorResolution: {
        ...options.actorResolution,
        ...(actor ? { actor: Object.freeze({ ...actor }) } : { actor: null }),
      },
    };
    this.#now = options.now ?? Date.now;
    this.#runGit = options.runGit ?? git;
    this.capabilities = {
      id: profile.backendId,
      supportTier: "supported",
      agentKind: profile.agentKind,
      runtimeKind: "github-managed",
      hostExecution: false,
      isolation: "managed",
      supportedOs: ["linux"],
      // GitHub assignment does not pin or report the managed runner's arch.
      supportedArchitectures: [],
      supportedTools: ["git", "node", "npm", "npx", "bash", "sh", "grep", "python", "python3"],
      supportedServices: [],
      // GitHub documents only a human Stop session UI, not an Agent Tasks
      // cancellation endpoint. `cancel()` below requests unassignment and then
      // reconciles; it deliberately fails while the exact session stays active.
      supportsCancellation: false,
      supportsObservation: true,
      supportsResume: false,
      supportsLocalInference: false,
      requiresPaidRuntime: true,
      providerManagedPublication: true,
      requiredCredentials: ["github-user-token", profile.requiredCapability],
    };
  }

  async probe(): Promise<BackendProbe> {
    const { actor, reason } = this.#options.actorResolution;
    if (actor !== null && this.#options.dispatcher !== undefined) {
      try {
        await this.#options.reader.probeCopilotAgentTasks();
      } catch (error) {
        return {
          available: false,
          authenticated: false,
          reason:
            `${this.#options.profile.displayName} requires the documented Agent Tasks read ` +
            `permission for session reconciliation: ${safeDiagnostic(error, "Agent Tasks probe")}`,
          measuredAt: new Date().toISOString(),
        };
      }
    }
    return {
      available: actor !== null && this.#options.dispatcher !== undefined,
      authenticated: actor !== null && this.#options.dispatcher !== undefined,
      ...(actor === null || !this.#options.dispatcher
        ? { reason: reason ?? `${this.#options.profile.displayName} dispatcher is unavailable` }
        : {}),
      measuredAt: new Date().toISOString(),
    };
  }

  async launch(context: AttemptContext): Promise<BackendHandle> {
    if (this.#now() >= context.deadline.getTime()) {
      throw new ManagedAssignmentDeadlineError(
        `${this.#options.profile.displayName} deadline elapsed before managed-agent assignment`,
      );
    }
    const actor = this.#options.actorResolution.actor;
    const dispatcher = this.#options.dispatcher;
    if (!actor || !dispatcher) {
      throw new Error(
        this.#options.actorResolution.reason ??
          `${this.#options.profile.displayName} is unavailable`,
      );
    }
    const objective = derive(await this.#options.reader.readObjective(context.objective));
    const item = objective.items.find((candidate) => candidate.number === context.workItem);
    if (!item) throw new Error(`Work Item #${context.workItem} no longer exists`);
    const preexistingPullNumbers = new Set(
      item.linkedPullRequests.map((pullRequest) => pullRequest.number),
    );
    // The capability read above can take long enough to consume the whole Work
    // Item window. Fence at the final instruction before the paid mutation.
    if (this.#now() >= context.deadline.getTime()) {
      throw new Error(
        `${this.#options.profile.displayName} deadline elapsed before managed-agent assignment`,
      );
    }
    try {
      await dispatcher.start(item, context.providerBaseRef, () => {
        if (this.#now() >= context.deadline.getTime()) {
          throw new ManagedAssignmentDeadlineError(
            `${this.#options.profile.displayName} deadline elapsed before managed-agent assignment`,
          );
        }
      });
    } catch (assignmentError) {
      if (assignmentError instanceof ManagedAssignmentDeadlineError) throw assignmentError;
      // A network error does not prove whether GitHub accepted the mutation.
      // Removing this exact discovered Bot is the only safe ambiguity repair.
      try {
        await dispatcher.unassign(item.id);
      } catch (cleanupError) {
        throw new Error(
          `${this.#options.profile.displayName} assignment result was ambiguous and unassignment ` +
            `could not be confirmed; automated replacement is blocked. Assignment error: ` +
            `${safeDiagnostic(assignmentError, "managed assignment failure")}. Cleanup error: ` +
            `${safeDiagnostic(cleanupError, "managed assignment cleanup failure")}`,
        );
      }
      throw new Error(
        `${this.#options.profile.displayName} assignment was not confirmed and was rolled back: ` +
          safeDiagnostic(assignmentError, "managed assignment failure"),
      );
    }
    const attemptId = durableAttemptId(context);
    const handle: BackendHandle = {
      backendId: this.capabilities.id,
      resourceId: `github-managed-${attemptId}`,
      startedAt: new Date(this.#now()).toISOString(),
      metadata: {
        issueNodeId: item.id,
        agentKind: this.#options.profile.agentKind,
        agentActorLogin: actor.login,
        attemptId,
      },
    };
    this.#attempts.set(handle.resourceId, {
      context,
      issueNodeId: item.id,
      handle,
      preexistingPullNumbers,
    });
    return handle;
  }

  async observe(handle: BackendHandle): Promise<BackendObservation> {
    const attempt = this.#require(handle);
    const objective = derive(await this.#options.reader.readObjective(attempt.context.objective));
    const rawItem = objective.items.find(
      (candidate) => candidate.number === attempt.context.workItem,
    );
    if (!rawItem)
      return {
        state: "unknown",
        observedAt: new Date().toISOString(),
        reason: "Work Item disappeared",
      };
    if (this.#now() >= attempt.context.deadline.getTime()) {
      return {
        state: "failed",
        observedAt: new Date().toISOString(),
        reason: `${this.#options.profile.displayName} exceeded the Work Item deadline`,
      };
    }
    let attemptItem: DerivedWorkItem;
    try {
      attemptItem = this.#attemptItem(attempt, rawItem);
    } catch (error) {
      return {
        state: "failed",
        observedAt: new Date().toISOString(),
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    const item = asLegacy(attemptItem, objective.readAt);
    const pull = currentOpenPullRequest(item);
    if (item.state === "for_review") {
      if (!pull?.headSha) {
        return {
          state: "failed",
          observedAt: new Date().toISOString(),
          reason: "managed provider reported review state without an attributable pull request",
        };
      }
      try {
        const task = await this.#observeExactTask(attempt, pull.number);
        if (!task) {
          return {
            state: "running",
            observedAt: new Date().toISOString(),
            progress: "pull request is attributed; exact Agent Task binding is not yet visible",
          };
        }
        this.#assertTaskIdentity(attempt.handle.metadata?.providerTaskId, task.taskId);
        attempt.handle.metadata = {
          ...attempt.handle.metadata,
          providerTaskId: task.taskId,
          providerSessionIds: JSON.stringify(task.sessionIds),
        };
        if (task.activeSessionIds.length > 0 || !TERMINAL_AGENT_TASK_STATES.has(task.taskState)) {
          return {
            state: "running",
            observedAt: task.observedAt,
            progress: `exact Agent Task ${task.taskId} remains ${task.taskState}`,
          };
        }
        if (task.taskState !== "completed") {
          return {
            state: task.taskState === "cancelled" ? "cancelled" : "failed",
            observedAt: task.observedAt,
            reason: `exact Agent Task ${task.taskId} ended ${task.taskState}`,
          };
        }
        // A running task may legitimately push another head. Collection authority
        // is established only after its exact task and all sessions are terminal.
        this.#bindPull(attempt, pull.number, pull.headSha);
        return { state: "succeeded", observedAt: task.observedAt };
      } catch (error) {
        return {
          state: "unknown",
          observedAt: new Date().toISOString(),
          reason: safeDiagnostic(error, "managed session observation"),
        };
      }
    }
    if (item.state === "failed" || item.state === "escalated") {
      return {
        state: "failed",
        observedAt: new Date().toISOString(),
        reason: `managed attempt is ${item.state}`,
      };
    }
    if (item.state === "done") {
      return {
        state: "unknown",
        observedAt: new Date().toISOString(),
        reason:
          "Work Item is closed or integrated; this does not prove exact managed task completion " +
          "or provide an open pull request for collection. Reconcile the exact session before replacement.",
      };
    }
    return { state: "running", observedAt: new Date().toISOString() };
  }

  async cancel(handle: BackendHandle): Promise<void> {
    const attempt = this.#require(handle);
    // GitHub issue linkage does not carry Factory's attempt identity. A pull
    // request appearing after launch might belong to a replacement or another
    // actor, so cancellation removes only this exact managed actor and leaves
    // ambiguous pull requests visible for host-side validation or cleanup.
    await this.#options.dispatcher!.unassign(attempt.issueNodeId);
    await this.#confirmAttemptTerminal(attempt);
  }

  async collect(handle: BackendHandle): Promise<NormalizedArtifact> {
    const attempt = this.#require(handle);
    const objective = derive(await this.#options.reader.readObjective(attempt.context.objective));
    const item = objective.items.find((candidate) => candidate.number === attempt.context.workItem);
    const pull = item ? currentOpenPullRequest(this.#attemptItem(attempt, item)) : null;
    if (!pull?.headSha) {
      throw new Error("managed backend produced no collectable pull request");
    }
    this.#assertBoundPull(attempt, pull.number, pull.headSha);
    const localRef = `refs/clockgrove-factory/managed/${durableAttemptId(attempt.context)}`;
    let artifact: NormalizedArtifact;
    try {
      await this.#runGit(this.#options.repository, [
        "fetch",
        "--no-tags",
        "--no-write-fetch-head",
        "origin",
        `+refs/pull/${pull.number}/head:${localRef}`,
      ]);
      const fetchedHead = (
        await this.#runGit(this.#options.repository, ["rev-parse", `${localRef}^{commit}`])
      ).trim();
      if (!/^[0-9a-f]{40}$/i.test(fetchedHead) || fetchedHead !== pull.headSha) {
        throw new Error(
          `managed pull request #${pull.number} fetched head ${fetchedHead || "<missing>"} ` +
            `does not match observed head ${pull.headSha}`,
        );
      }
      const patch = await this.#runGit(this.#options.repository, [
        "diff",
        "--binary",
        "--no-ext-diff",
        attempt.context.packet.baseSha,
        fetchedHead,
      ]);
      const paths = (
        await this.#runGit(this.#options.repository, [
          "diff",
          "--name-only",
          "-z",
          attempt.context.packet.baseSha,
          fetchedHead,
        ])
      )
        .split("\0")
        .filter(Boolean);
      artifact = normalizeArtifact({
        baseSha: attempt.context.packet.baseSha,
        patch,
        changedPaths: paths,
        logs: `Collected from GitHub pull request #${pull.number} at ${fetchedHead}.`,
        outcome: patch.trim() ? "succeeded" : "declined",
        ...(patch.trim() ? {} : { reason: "managed pull request contains no changes" }),
      });
    } catch (error) {
      await this.#cleanupCollectionRef(localRef, error);
      throw error;
    }
    await this.#cleanupCollectionRef(localRef);
    return artifact;
  }

  async cleanup(handle: BackendHandle): Promise<void> {
    const attempt = this.#require(handle);
    // Preserve the handle until unassignment succeeds so Supervisor can retry
    // cleanup and cannot launch a replacement against an active assignment.
    await this.#options.dispatcher?.unassign(attempt.issueNodeId);
    await this.#confirmAttemptTerminal(attempt);
    this.#attempts.delete(handle.resourceId);
  }

  async reconcileStale(identity: StaleAttemptIdentity): Promise<void> {
    if (!this.#options.dispatcher) {
      throw new Error(
        `cannot reconcile ${this.#options.profile.displayName}: assignable actor is unavailable`,
      );
    }
    const objective = derive(await this.#options.reader.readObjective(identity.objective));
    const item = objective.items.find((candidate) => candidate.number === identity.workItem);
    if (!item) {
      throw new Error("cannot prove managed session termination: Work Item disappeared");
    }
    await this.#options.dispatcher.unassign(item.id);
    const startedAt = item.factoryEvents?.find(
      (event) =>
        event.kind === "attempt" &&
        event.event === "AttemptStarted" &&
        event.runId === identity.runId &&
        event.workItem === identity.workItem &&
        event.attempt === identity.attempt &&
        event.backend === this.capabilities.id,
    )?.at;
    if (!startedAt) {
      throw new Error(
        `cannot prove ${this.#options.profile.displayName} session termination: ` +
          "the exact AttemptStarted timestamp is unavailable",
      );
    }
    const pulls = this.#attributedPulls(item.linkedPullRequests, startedAt, new Set());
    if (pulls.length !== 1) {
      throw new Error(
        `cannot prove ${this.#options.profile.displayName} session termination: ` +
          `${pulls.length === 0 ? "no" : "multiple"} exact post-launch pull-request bindings exist; ` +
          "use GitHub's Agent session view to stop the session before replacement",
      );
    }
    await this.#confirmTaskTerminal(pulls[0]!.number, startedAt);
  }

  #require(handle: BackendHandle): ManagedAttempt {
    if (handle.backendId !== this.capabilities.id) {
      throw new Error(`handle belongs to ${handle.backendId}, not ${this.capabilities.id}`);
    }
    const attempt = this.#attempts.get(handle.resourceId);
    if (!attempt) throw new Error(`unknown managed attempt ${handle.resourceId}`);
    return attempt;
  }

  #bindPull(attempt: ManagedAttempt, pullNumber: number, headSha: string): void {
    const metadata = attempt.handle.metadata ?? {};
    if (
      (metadata.pullNumber !== undefined && metadata.pullNumber !== String(pullNumber)) ||
      (metadata.headSha !== undefined && metadata.headSha !== headSha)
    ) {
      throw new Error("managed pull request identity changed after successful observation");
    }
    attempt.handle.metadata = {
      ...metadata,
      pullNumber: String(pullNumber),
      headSha,
    };
  }

  #assertBoundPull(attempt: ManagedAttempt, pullNumber: number, headSha: string): void {
    if (
      attempt.handle.metadata?.pullNumber !== String(pullNumber) ||
      attempt.handle.metadata?.headSha !== headSha
    ) {
      throw new Error(
        "managed pull request changed after successful observation; refusing uncorrelated collection",
      );
    }
  }

  async #observeExactTask(attempt: ManagedAttempt, pullNumber: number) {
    return this.#options.reader.readCopilotAgentTaskForPull(
      pullNumber,
      new Date(
        new Date(attempt.handle.startedAt).getTime() - MANAGED_ATTRIBUTION_CLOCK_SKEW_MS,
      ).toISOString(),
    );
  }

  async #confirmAttemptTerminal(attempt: ManagedAttempt): Promise<void> {
    const objective = derive(await this.#options.reader.readObjective(attempt.context.objective));
    const item = objective.items.find((candidate) => candidate.number === attempt.context.workItem);
    if (!item) {
      throw new Error("cannot prove managed session termination: Work Item disappeared");
    }
    const pulls = this.#attributedPulls(
      item.linkedPullRequests,
      attempt.handle.startedAt,
      attempt.preexistingPullNumbers,
    );
    if (pulls.length !== 1) {
      throw new Error(
        `cannot prove ${this.#options.profile.displayName} session termination: ` +
          `${pulls.length === 0 ? "no" : "multiple"} exact post-launch pull-request bindings exist; ` +
          "unassignment is not cancellation—use GitHub's Agent session view to stop the session",
      );
    }
    await this.#confirmTaskTerminal(
      pulls[0]!.number,
      attempt.handle.startedAt,
      attempt.handle.metadata?.providerTaskId,
    );
  }

  #assertTaskIdentity(expectedTaskId: string | undefined, taskId: string): void {
    if (expectedTaskId !== undefined && expectedTaskId !== taskId) {
      throw new Error("managed task identity changed after exact task observation");
    }
  }

  async #confirmTaskTerminal(
    pullNumber: number,
    startedAt: string,
    expectedTaskId?: string,
  ): Promise<void> {
    const task = await this.#options.reader.readCopilotAgentTaskForPull(
      pullNumber,
      new Date(new Date(startedAt).getTime() - MANAGED_ATTRIBUTION_CLOCK_SKEW_MS).toISOString(),
    );
    if (!task) {
      throw new Error(
        "cannot prove managed session termination: no Agent Task matches the exact pull request",
      );
    }
    this.#assertTaskIdentity(expectedTaskId, task.taskId);
    if (task.activeSessionIds.length > 0 || !TERMINAL_AGENT_TASK_STATES.has(task.taskState)) {
      throw new Error(
        `managed Agent Task ${task.taskId} remains ${task.taskState}; ` +
          "unassignment is not cancellation—stop the exact session in GitHub before replacement",
      );
    }
  }

  #attributedPulls(
    pulls: DerivedWorkItem["linkedPullRequests"],
    startedAt: string,
    preexisting: ReadonlySet<number>,
  ): DerivedWorkItem["linkedPullRequests"] {
    const earliest = new Date(startedAt).getTime() - MANAGED_ATTRIBUTION_CLOCK_SKEW_MS;
    if (!Number.isFinite(earliest)) return [];
    return pulls.filter(
      (pull) =>
        !preexisting.has(pull.number) &&
        pull.createdAt.getTime() >= earliest &&
        pull.agentWorkEvents.some((event) => event.at.getTime() >= earliest),
    );
  }

  async #cleanupCollectionRef(localRef: string, priorFailure?: unknown): Promise<void> {
    try {
      await this.#runGit(this.#options.repository, ["update-ref", "-d", localRef]);
    } catch (cleanupError) {
      throw new Error(
        `${priorFailure ? `${safeDiagnostic(priorFailure, "managed collection failure")}; ` : ""}` +
          `managed collection ref cleanup failed: ` +
          safeDiagnostic(cleanupError, "managed collection ref cleanup failure"),
      );
    }
  }

  #attemptItem(attempt: ManagedAttempt, item: DerivedWorkItem): DerivedWorkItem {
    const actorLogin = this.#options.actorResolution.actor?.login;
    const isManagedAssignee = (login: string) =>
      (actorLogin !== undefined && sameLogin(login, actorLogin)) ||
      this.#options.profile.assigneeLogins.some((alias) => sameLogin(login, alias));
    const managedAgentAssigned = item.assignees.some(isManagedAssignee);
    const otherAssignees = item.assignees.filter((login) => !isManagedAssignee(login));
    const linkedPullRequests = item.linkedPullRequests.filter(
      (pullRequest) => !attempt.preexistingPullNumbers.has(pullRequest.number),
    );
    if (linkedPullRequests.length > 1) {
      throw new Error(
        `${this.#options.profile.displayName} attempt attribution is ambiguous: ` +
          `${linkedPullRequests.length} pull requests were linked after assignment`,
      );
    }
    const attributedPullRequests = this.#attributedPulls(
      linkedPullRequests,
      attempt.handle.startedAt,
      new Set(),
    );
    return {
      ...item,
      // The v1 state machine names GitHub's Copilot-facing assignee identity.
      // Codex is exposed as `Codex`, so adapt only the managed identity while
      // preserving a human-only takeover as durable escalation evidence. An
      // empty assignee read immediately after a successful mutation is treated
      // as propagation lag and remains bounded by the attempt deadline.
      assignees:
        managedAgentAssigned || item.assignees.length === 0
          ? [COPILOT_ASSIGNEE_LOGIN, ...otherAssignees]
          : otherAssignees,
      copilotAssignments: [new Date(attempt.handle.startedAt)],
      // New issue linkage alone is not attempt identity: humans and other bots
      // can link PRs concurrently. Require GitHub's authoritative coding-agent
      // lifecycle event on the one post-assignment PR before collection.
      linkedPullRequests: attributedPullRequests,
    };
  }
}

/** Legacy constructor retained for v1 integrations and downstream imports. */
export class GitHubCopilotBackend extends GitHubManagedAgentBackend {
  constructor(options: GitHubCopilotBackendOptions) {
    super({
      reader: options.reader,
      dispatcher: options.dispatcher,
      repository: options.repository,
      profile: GITHUB_COPILOT_MANAGED_PROFILE,
      actorResolution: options.copilotAvailable
        ? {
            actor: {
              id: "legacy-copilot-actor",
              login: "copilot-swe-agent",
              type: "Bot",
            },
          }
        : {
            actor: null,
            reason: "GitHub Copilot coding agent is not assignable in this repository",
          },
    });
  }
}
