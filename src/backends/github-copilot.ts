import { arch } from "node:os";

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
import type { GitHubReader } from "../github.js";
import {
  attemptCount,
  currentOpenPullRequest,
  derive,
  deriveState,
  type DerivedWorkItem,
} from "../state.js";
import { runContainedProcess } from "../runtime/process-group.js";

interface ManagedAttempt {
  context: AttemptContext;
  issueNodeId: string;
  handle: BackendHandle;
}

export interface GitHubCopilotBackendOptions {
  reader: GitHubReader;
  dispatcher: Dispatcher;
  repository: string;
  copilotAvailable: boolean;
}

function asLegacy(item: DerivedWorkItem, now: Date): DerivedWorkItem {
  const { factoryEvents: _events, state: _state, attempts: _attempts, doneWithoutMergedPullRequest: _closed, ...snapshot } = item;
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

/** Explicit, paid v1 compatibility adapter. It is never registered implicitly. */
export class GitHubCopilotBackend implements ExecutionBackend {
  readonly capabilities: ExecutionBackendCapabilities = {
    id: "github-copilot/github-managed",
    agentKind: "github-copilot",
    runtimeKind: "github-managed",
    hostExecution: false,
    isolation: "managed",
    supportedOs: ["linux"],
    supportedArchitectures: [arch(), "x64", "arm64"],
    supportedTools: ["git", "node", "npm", "npx", "bash", "sh", "grep", "python", "python3"],
    supportedServices: [],
    supportsCancellation: true,
    supportsObservation: true,
    supportsResume: false,
    supportsLocalInference: false,
    requiresPaidRuntime: true,
    providerManagedPublication: true,
    requiredCredentials: ["github-token", "github-copilot-coding-agent"],
  };

  readonly #options: GitHubCopilotBackendOptions;
  readonly #attempts = new Map<string, ManagedAttempt>();

  constructor(options: GitHubCopilotBackendOptions) {
    this.#options = options;
  }

  async probe(): Promise<BackendProbe> {
    return {
      available: this.#options.copilotAvailable,
      authenticated: this.#options.copilotAvailable,
      ...(!this.#options.copilotAvailable
        ? { reason: "GitHub Copilot coding agent is not assignable in this repository" }
        : {}),
      measuredAt: new Date().toISOString(),
    };
  }

  async launch(context: AttemptContext): Promise<BackendHandle> {
    const objective = derive(await this.#options.reader.readObjective(context.objective));
    const item = objective.items.find((candidate) => candidate.number === context.workItem);
    if (!item) throw new Error(`Work Item #${context.workItem} no longer exists`);
    await this.#options.dispatcher.start(item);
    const handle: BackendHandle = {
      backendId: this.capabilities.id,
      resourceId: `github-issue-${context.workItem}-attempt-${context.attempt}`,
      startedAt: new Date().toISOString(),
      metadata: { issueNodeId: item.id },
    };
    this.#attempts.set(handle.resourceId, { context, issueNodeId: item.id, handle });
    return handle;
  }

  async observe(handle: BackendHandle): Promise<BackendObservation> {
    const attempt = this.#require(handle);
    const objective = derive(
      await this.#options.reader.readObjective(attempt.context.objective),
    );
    const rawItem = objective.items.find(
      (candidate) => candidate.number === attempt.context.workItem,
    );
    if (!rawItem) return { state: "unknown", observedAt: new Date().toISOString(), reason: "Work Item disappeared" };
    const item = asLegacy(rawItem, objective.readAt);
    const pull = currentOpenPullRequest(item);
    if (pull) {
      handle.metadata = {
        ...(handle.metadata ?? {}),
        pullNumber: String(pull.number),
        headSha: pull.headSha,
      };
    }
    if (item.state === "for_review") {
      return { state: "succeeded", observedAt: new Date().toISOString() };
    }
    if (item.state === "failed" || item.state === "escalated") {
      return { state: "failed", observedAt: new Date().toISOString(), reason: `managed attempt is ${item.state}` };
    }
    if (item.state === "done") {
      return { state: "succeeded", observedAt: new Date().toISOString(), progress: "already integrated" };
    }
    return { state: "running", observedAt: new Date().toISOString() };
  }

  async cancel(handle: BackendHandle): Promise<void> {
    const attempt = this.#require(handle);
    const objective = derive(
      await this.#options.reader.readObjective(attempt.context.objective),
    );
    const item = objective.items.find(
      (candidate) => candidate.number === attempt.context.workItem,
    );
    if (item) await this.#options.dispatcher.cancel(item);
  }

  async collect(handle: BackendHandle): Promise<NormalizedArtifact> {
    const attempt = this.#require(handle);
    const objective = derive(
      await this.#options.reader.readObjective(attempt.context.objective),
    );
    const item = objective.items.find(
      (candidate) => candidate.number === attempt.context.workItem,
    );
    const pull = item ? currentOpenPullRequest(item) : null;
    if (!pull || !pull.headSha) throw new Error("managed backend produced no collectable pull request");
    handle.metadata = {
      ...(handle.metadata ?? {}),
      pullNumber: String(pull.number),
      headSha: pull.headSha,
    };
    await git(this.#options.repository, [
      "fetch",
      "--no-tags",
      "--no-write-fetch-head",
      "origin",
      `refs/pull/${pull.number}/head`,
    ]);
    const patch = await git(this.#options.repository, [
      "diff",
      "--binary",
      "--no-ext-diff",
      attempt.context.packet.baseSha,
      pull.headSha,
    ]);
    const paths = (
      await git(this.#options.repository, [
        "diff",
        "--name-only",
        "-z",
        attempt.context.packet.baseSha,
        pull.headSha,
      ])
    )
      .split("\0")
      .filter(Boolean);
    return normalizeArtifact({
      baseSha: attempt.context.packet.baseSha,
      patch,
      changedPaths: paths,
      logs: `Collected from GitHub pull request #${pull.number} at ${pull.headSha}.`,
      outcome: patch.trim() ? "succeeded" : "declined",
      ...(patch.trim() ? {} : { reason: "managed pull request contains no changes" }),
    });
  }

  async cleanup(handle: BackendHandle): Promise<void> {
    this.#attempts.delete(handle.resourceId);
  }

  async reconcileStale(identity: StaleAttemptIdentity): Promise<void> {
    const objective = derive(await this.#options.reader.readObjective(identity.objective));
    const item = objective.items.find((candidate) => candidate.number === identity.workItem);
    if (item) await this.#options.dispatcher.cancel(item);
  }

  #require(handle: BackendHandle): ManagedAttempt {
    if (handle.backendId !== this.capabilities.id) {
      throw new Error(`handle belongs to ${handle.backendId}, not ${this.capabilities.id}`);
    }
    const attempt = this.#attempts.get(handle.resourceId);
    if (!attempt) throw new Error(`unknown managed attempt ${handle.resourceId}`);
    return attempt;
  }
}
