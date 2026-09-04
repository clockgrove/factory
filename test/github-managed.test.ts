import { describe, expect, it } from "vitest";

import {
  GITHUB_COPILOT_MANAGED_PROFILE,
  GitHubManagedAgentBackend,
  OPENAI_CODEX_MANAGED_PROFILE,
  resolveManagedAgentActor,
} from "../src/backends/github-copilot.js";
import { Dispatcher, type GitHubWriter } from "../src/dispatch.js";
import type {
  AttemptContext,
  BackendHandle,
  BackendObservation,
  BackendProbe,
  ExecutionBackend,
  ExecutionBackendCapabilities,
} from "../src/execution/backend.js";
import { BackendRegistry, NoExecutionBackendError } from "../src/execution/registry.js";
import type { NormalizedArtifact } from "../src/execution/artifacts.js";
import type { GitHubReader } from "../src/github.js";
import { DEFAULT_RUN_POLICY, parseRunPolicy } from "../src/protocol/policy.js";
import type { ObjectiveSnapshot } from "../src/types.js";
import { selectManagedRecoveryPull } from "../src/supervisor.js";

const SHA = "a".repeat(40);

function context(deadline = new Date(Date.now() + 60_000)): AttemptContext {
  return {
    repository: "clockgrove/factory",
    objective: 14,
    workItem: 22,
    attempt: 1,
    runId: "run-managed-1",
    directorEpoch: 3,
    policyDigest: "b".repeat(64),
    workspace: "/tmp/factory-managed-test",
    providerBaseRef: "factory/stack-parent",
    deadline,
    packet: {
      goal: "Implement the bounded change",
      acceptanceCriteria: ["tests pass"],
      allowedPaths: ["src/value.ts"],
      preconditions: [],
      outOfScope: [],
      conventions: [],
      baseSha: SHA,
      validationCommands: ["npm test"],
      artifactContract: "clockgrove.factory/artifact-v1",
      requirements: {
        os: [],
        architecture: [],
        tools: [],
        services: [],
        networkDestinations: [],
        permittedSecretNames: [],
        trust: "trusted_local",
      },
    },
  };
}

function snapshot(): ObjectiveSnapshot {
  return {
    id: "I_objective",
    number: 14,
    title: "Managed agents",
    body: "",
    closed: false,
    readAt: new Date(),
    repositoryId: "R_repo",
    defaultBranch: "main",
    workItemLabelId: "L_work_item",
    copilotBotId: "BOT_copilot",
    managedAgentActors: [],
    ciExpectedOnPullRequests: false,
    workItems: [
      {
        id: "I_work_item",
        number: 22,
        title: "Implement the change",
        body: "",
        closed: false,
        assignees: [],
        labels: ["factory:work-item"],
        blockedBy: [],
        linkedPullRequests: [],
        copilotAssignments: [],
      },
    ],
  };
}

class ManagedWriter implements GitHubWriter {
  readonly calls: string[] = [];
  assignFailures = 0;
  removeFailures = 0;

  async assignManagedAgent(args: {
    issueId: string;
    botId: string;
    baseRef: string;
  }): Promise<void> {
    this.calls.push(`assign:${args.issueId}:${args.botId}:${args.baseRef}`);
    if (this.assignFailures > 0) {
      this.assignFailures -= 1;
      throw new Error("ambiguous assignment transport failure");
    }
  }
  async assignCopilot(): Promise<void> {
    throw new Error("generic assignment must not fall back to the Copilot alias");
  }
  async removeManagedAgent(issueId: string, actorId: string): Promise<void> {
    this.calls.push(`remove:${issueId}:${actorId}`);
    if (this.removeFailures > 0) {
      this.removeFailures -= 1;
      throw new Error("temporary unassign failure");
    }
  }
  async clearActors(issueId: string): Promise<void> {
    this.calls.push(`clear:${issueId}`);
  }
  async assignHumanOnly(): Promise<void> {}
  async addComment(): Promise<void> {}
  async closePullRequest(): Promise<void> {}
  async closeIssue(): Promise<void> {}
  async markPullRequestReady(): Promise<void> {}
  async mergePullRequest(): Promise<void> {}
  async updatePullRequestBranch(): Promise<void> {}
  async approveWorkflowRun(): Promise<void> {}
}

function dispatcher(writer: GitHubWriter, actorId: string): Dispatcher {
  return new Dispatcher({
    writer,
    repositoryId: "R_repo",
    managedAgentActorId: actorId,
    defaultBranch: "main",
    escalateToId: "U_operator",
  });
}

describe("GitHub managed-agent profiles", () => {
  it("discovers documented Copilot and fails Codex closed without stable actor identity", () => {
    const actors = [
      { id: "BOT_dynamic_1", login: "copilot-swe-agent", type: "Bot" as const },
      { id: "BOT_dynamic_2", login: "openai-code-agent[bot]", type: "Bot" as const },
    ];
    expect(resolveManagedAgentActor(GITHUB_COPILOT_MANAGED_PROFILE, actors).actor).toEqual(
      actors[0],
    );
    expect(resolveManagedAgentActor(OPENAI_CODEX_MANAGED_PROFILE, actors)).toMatchObject({
      actor: null,
      reason: expect.stringContaining("release-blocked"),
    });
  });

  it("fails a profile probe closed when actor discovery is absent or ambiguous", async () => {
    const absent = resolveManagedAgentActor(GITHUB_COPILOT_MANAGED_PROFILE, []);
    expect(absent).toMatchObject({ actor: null, reason: expect.stringContaining("not exposed") });
    const ambiguous = resolveManagedAgentActor(GITHUB_COPILOT_MANAGED_PROFILE, [
      { id: "BOT_1", login: "copilot-swe-agent", type: "Bot" },
      { id: "BOT_2", login: "COPILOT-SWE-AGENT", type: "Bot" },
    ]);
    expect(ambiguous).toMatchObject({
      actor: null,
      reason: expect.stringContaining("ambiguous"),
    });

    const backend = new GitHubManagedAgentBackend({
      reader: { readObjective: async () => snapshot() } as unknown as GitHubReader,
      repository: "/tmp/factory-managed-test",
      profile: GITHUB_COPILOT_MANAGED_PROFILE,
      actorResolution: absent,
    });
    expect(await backend.probe()).toMatchObject({
      available: false,
      authenticated: false,
      reason: expect.stringContaining("not exposed"),
    });
    await expect(backend.launch(context())).rejects.toThrow(/not exposed/);
    await expect(
      backend.reconcileStale({
        repository: "clockgrove/factory",
        objective: 14,
        workItem: 22,
        attempt: 1,
        runId: "run-managed-1",
        directorEpoch: 3,
      }),
    ).rejects.toThrow(/cannot reconcile/);
  });

  it("rejects fuzzy third-party Bot names that resemble a managed provider", () => {
    expect(
      resolveManagedAgentActor(GITHUB_COPILOT_MANAGED_PROFILE, [
        { id: "BOT_unrelated", login: "my-copilot-helper[bot]", type: "Bot" },
      ]),
    ).toMatchObject({ actor: null, reason: expect.stringContaining("not exposed") });
  });

  it("accepts only immutable supported profiles and exact assignable Bot actors", () => {
    expect(Object.isFrozen(GITHUB_COPILOT_MANAGED_PROFILE.actorLogins)).toBe(true);
    expect(Object.isFrozen(OPENAI_CODEX_MANAGED_PROFILE.assigneeLogins)).toBe(true);
    expect(
      resolveManagedAgentActor(GITHUB_COPILOT_MANAGED_PROFILE, [
        {
          id: "U_spoof",
          login: "copilot-swe-agent",
          type: "User",
        } as unknown as { id: string; login: string; type: "Bot" },
      ]),
    ).toMatchObject({ actor: null, reason: expect.stringContaining("not exposed") });
    expect(
      resolveManagedAgentActor(GITHUB_COPILOT_MANAGED_PROFILE, [
        { id: "BOT_alias", login: "copilot-swe-agent[bot]", type: "Bot" },
      ]),
    ).toMatchObject({ actor: null, reason: expect.stringContaining("not exposed") });

    const base = {
      reader: { readObjective: async () => snapshot() } as unknown as GitHubReader,
      repository: "/tmp/factory-managed-test",
      profile: OPENAI_CODEX_MANAGED_PROFILE,
    };
    expect(
      () =>
        new GitHubManagedAgentBackend({
          ...base,
          profile: {
            ...OPENAI_CODEX_MANAGED_PROFILE,
            actorLogins: ["unreviewed-third-party-agent"],
          },
          actorResolution: { actor: null },
        }),
    ).toThrow(/unsupported GitHub-managed agent profile/);
    expect(
      () =>
        new GitHubManagedAgentBackend({
          ...base,
          actorResolution: {
            actor: { id: "BOT_copilot", login: "copilot-swe-agent", type: "Bot" },
          },
        }),
    ).toThrow(/does not match its exact assignable Bot profile/);
  });

  it("keeps the Codex profile unavailable until GitHub exposes a verifiable actor identity", async () => {
    const resolution = resolveManagedAgentActor(OPENAI_CODEX_MANAGED_PROFILE, [
      { id: "BOT_unverified", login: "openai-code-agent", type: "Bot" },
    ]);
    expect(resolution).toMatchObject({
      actor: null,
      reason: expect.stringContaining("no live conformance evidence"),
    });
    const backend = new GitHubManagedAgentBackend({
      reader: { readObjective: async () => snapshot() } as unknown as GitHubReader,
      repository: "/tmp/factory-managed-test",
      profile: OPENAI_CODEX_MANAGED_PROFILE,
      actorResolution: resolution,
    });
    await expect(backend.probe()).resolves.toMatchObject({
      available: false,
      authenticated: false,
      reason: expect.stringContaining("release-blocked"),
    });
  });

  it("uses deterministic fenced identities and the discovered Copilot actor", async () => {
    const actor = { id: "BOT_runtime", login: "copilot-swe-agent", type: "Bot" as const };
    const writer = new ManagedWriter();
    const backend = new GitHubManagedAgentBackend({
      reader: { readObjective: async () => snapshot() } as unknown as GitHubReader,
      dispatcher: dispatcher(writer, actor.id),
      repository: "/tmp/factory-managed-test",
      profile: GITHUB_COPILOT_MANAGED_PROFILE,
      actorResolution: { actor },
    });
    const first = await backend.launch(context());
    await backend.cleanup(first);
    const second = await backend.launch(context());
    expect(first.resourceId).toBe(second.resourceId);
    expect(second.metadata).toMatchObject({
      agentKind: "github-copilot",
      agentActorLogin: actor.login,
      attemptId: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(writer.calls).toEqual([
      "assign:I_work_item:BOT_runtime:factory/stack-parent",
      "remove:I_work_item:BOT_runtime",
      "assign:I_work_item:BOT_runtime:factory/stack-parent",
    ]);
    await backend.cancel(second);
    expect(writer.calls.at(-1)).toBe("remove:I_work_item:BOT_runtime");
    await backend.reconcileStale({
      repository: "clockgrove/factory",
      objective: 14,
      workItem: 22,
      attempt: 1,
      runId: "run-managed-1",
      directorEpoch: 3,
      providerResourceId: second.resourceId,
    });
    expect(writer.calls.slice(-2)).toEqual([
      "remove:I_work_item:BOT_runtime",
      "remove:I_work_item:BOT_runtime",
    ]);
  });

  it("retains the managed handle until paid assignment cleanup is confirmed", async () => {
    const actor = { id: "BOT_runtime", login: "copilot-swe-agent", type: "Bot" as const };
    const writer = new ManagedWriter();
    const backend = new GitHubManagedAgentBackend({
      reader: { readObjective: async () => snapshot() } as unknown as GitHubReader,
      dispatcher: dispatcher(writer, actor.id),
      repository: "/tmp/factory-managed-test",
      profile: GITHUB_COPILOT_MANAGED_PROFILE,
      actorResolution: { actor },
    });
    const handle = await backend.launch(context());
    writer.removeFailures = 1;
    await expect(backend.cleanup(handle)).rejects.toThrow("temporary unassign failure");
    await expect(backend.cleanup(handle)).resolves.toBeUndefined();
    await expect(backend.cleanup(handle)).rejects.toThrow(/unknown managed attempt/);
    expect(writer.calls.filter((call) => call.startsWith("remove:"))).toHaveLength(2);
  });

  it("rejects an elapsed deadline before assigning the paid managed agent", async () => {
    const actor = { id: "BOT_runtime", login: "copilot-swe-agent", type: "Bot" as const };
    const writer = new ManagedWriter();
    const backend = new GitHubManagedAgentBackend({
      reader: { readObjective: async () => snapshot() } as unknown as GitHubReader,
      dispatcher: dispatcher(writer, actor.id),
      repository: "/tmp/factory-managed-test",
      profile: GITHUB_COPILOT_MANAGED_PROFILE,
      actorResolution: { actor },
    });
    await expect(backend.launch(context(new Date(Date.now() - 1)))).rejects.toThrow(/deadline/);
    expect(writer.calls).toEqual([]);
  });

  it("rechecks the deadline immediately before the paid assignment side effect", async () => {
    const actor = { id: "BOT_runtime", login: "copilot-swe-agent", type: "Bot" as const };
    const writer = new ManagedWriter();
    let now = 1_000;
    const backend = new GitHubManagedAgentBackend({
      reader: { readObjective: async () => snapshot() } as unknown as GitHubReader,
      dispatcher: new Dispatcher({
        writer,
        repositoryId: "R_repo",
        managedAgentActorId: actor.id,
        defaultBranch: "main",
        escalateToId: "U_operator",
        beforeMutation: async () => {
          now = 2_000;
        },
      }),
      repository: "/tmp/factory-managed-test",
      profile: GITHUB_COPILOT_MANAGED_PROFILE,
      actorResolution: { actor },
      now: () => now,
    });
    await expect(backend.launch(context(new Date(2_000)))).rejects.toThrow(/deadline/);
    expect(writer.calls).toEqual([]);
  });

  it("rolls back an ambiguous paid assignment and blocks replacement if rollback fails", async () => {
    const actor = { id: "BOT_runtime", login: "copilot-swe-agent", type: "Bot" as const };
    const writer = new ManagedWriter();
    writer.assignFailures = 1;
    const backend = new GitHubManagedAgentBackend({
      reader: { readObjective: async () => snapshot() } as unknown as GitHubReader,
      dispatcher: dispatcher(writer, actor.id),
      repository: "/tmp/factory-managed-test",
      profile: GITHUB_COPILOT_MANAGED_PROFILE,
      actorResolution: { actor },
    });
    await expect(backend.launch(context())).rejects.toThrow(/was rolled back/);
    expect(writer.calls).toEqual([
      "assign:I_work_item:BOT_runtime:factory/stack-parent",
      "remove:I_work_item:BOT_runtime",
    ]);

    writer.assignFailures = 1;
    writer.removeFailures = 1;
    await expect(backend.launch(context())).rejects.toThrow(
      /assignment result was ambiguous.*automated replacement is blocked/,
    );
    expect(writer.calls.slice(-2)).toEqual([
      "assign:I_work_item:BOT_runtime:factory/stack-parent",
      "remove:I_work_item:BOT_runtime",
    ]);
  });

  it("observes the provider pull request and binds its exact head to the handle", async () => {
    const actor = { id: "BOT_runtime", login: "copilot-swe-agent", type: "Bot" as const };
    const current = snapshot();
    current.workItems[0]!.assignees = ["Copilot", "operator"];
    const stalePull = {
      id: "PR_stale",
      number: 50,
      state: "OPEN" as const,
      isDraft: false,
      title: "Earlier attempt",
      body: "Closes #22",
      changedLines: 1,
      changedFiles: 1,
      changedFilePaths: ["src/value.ts"],
      commitSubjects: ["Earlier attempt"],
      checks: "SUCCESS" as const,
      mergeable: "MERGEABLE" as const,
      createdAt: new Date(Date.now() - 60_000),
      headSha: "d".repeat(40),
      headCommittedAt: new Date(Date.now() - 60_000),
      mergedAt: null,
      closedAt: null,
      agentWorkEvents: [],
    };
    current.workItems[0]!.linkedPullRequests = [stalePull];
    const backend = new GitHubManagedAgentBackend({
      reader: { readObjective: async () => current } as unknown as GitHubReader,
      dispatcher: dispatcher(new ManagedWriter(), actor.id),
      repository: "/tmp/factory-managed-test",
      profile: GITHUB_COPILOT_MANAGED_PROFILE,
      actorResolution: { actor },
    });
    const handle = await backend.launch(context());
    expect(await backend.observe(handle)).toMatchObject({ state: "running" });
    await expect(backend.collect(handle)).rejects.toThrow(
      "managed backend produced no collectable pull request",
    );
    current.readAt = new Date();
    current.workItems[0]!.linkedPullRequests = [
      stalePull,
      {
        id: "PR_codex",
        number: 51,
        state: "OPEN",
        isDraft: false,
        title: "Implement the change",
        body: "Closes #22",
        changedLines: 2,
        changedFiles: 1,
        changedFilePaths: ["src/value.ts"],
        commitSubjects: ["Implement the change"],
        checks: "SUCCESS",
        mergeable: "MERGEABLE",
        createdAt: new Date(),
        headSha: "c".repeat(40),
        headCommittedAt: new Date(),
        mergedAt: null,
        closedAt: null,
        agentWorkEvents: [
          { kind: "started", at: new Date(), message: null },
          { kind: "finished", at: new Date(), message: null },
        ],
      },
    ];
    expect(await backend.observe(handle)).toMatchObject({ state: "succeeded" });
    expect(handle.metadata).toMatchObject({
      pullNumber: "51",
      headSha: "c".repeat(40),
    });

    current.workItems[0]!.linkedPullRequests = [stalePull];
    current.workItems[0]!.assignees = ["operator"];
    expect(await backend.observe(handle)).toMatchObject({
      state: "failed",
      reason: "managed attempt is escalated",
    });
  });

  it("rejects a pull request whose identity changes after successful observation", async () => {
    const actor = { id: "BOT_runtime", login: "copilot-swe-agent", type: "Bot" as const };
    const current = snapshot();
    current.workItems[0]!.assignees = ["Copilot"];
    current.workItems[0]!.linkedPullRequests = [
      {
        id: "PR_codex",
        number: 51,
        state: "OPEN",
        isDraft: false,
        title: "Implement the change",
        body: "Closes #22",
        changedLines: 2,
        changedFiles: 1,
        changedFilePaths: ["src/value.ts"],
        commitSubjects: ["Implement the change"],
        checks: "SUCCESS",
        mergeable: "MERGEABLE",
        createdAt: new Date(),
        headSha: "c".repeat(40),
        headCommittedAt: new Date(),
        mergedAt: null,
        closedAt: null,
        agentWorkEvents: [
          { kind: "started", at: new Date(), message: null },
          { kind: "finished", at: new Date(), message: null },
        ],
      },
    ];
    const attributedPulls = current.workItems[0]!.linkedPullRequests;
    current.workItems[0]!.linkedPullRequests = [];
    const gitCalls: string[][] = [];
    const backend = new GitHubManagedAgentBackend({
      reader: { readObjective: async () => current } as unknown as GitHubReader,
      dispatcher: dispatcher(new ManagedWriter(), actor.id),
      repository: "/tmp/factory-managed-test",
      profile: GITHUB_COPILOT_MANAGED_PROFILE,
      actorResolution: { actor },
      runGit: async (_repository, args) => {
        gitCalls.push(args);
        return "";
      },
    });
    const handle = await backend.launch(context());
    current.workItems[0]!.linkedPullRequests = attributedPulls;
    await expect(backend.observe(handle)).resolves.toMatchObject({ state: "succeeded" });
    current.workItems[0]!.linkedPullRequests[0]!.headSha = "e".repeat(40);
    await expect(backend.collect(handle)).rejects.toThrow(/changed after successful observation/);
    expect(gitCalls).toEqual([]);
  });

  it("fetches into an attempt-scoped ref and verifies the exact observed PR head", async () => {
    const actor = { id: "BOT_runtime", login: "copilot-swe-agent", type: "Bot" as const };
    const current = snapshot();
    const observedHead = "c".repeat(40);
    current.workItems[0]!.assignees = ["Copilot"];
    current.workItems[0]!.linkedPullRequests = [
      {
        id: "PR_codex",
        number: 51,
        state: "OPEN",
        isDraft: false,
        title: "Implement the change",
        body: "Closes #22",
        changedLines: 2,
        changedFiles: 1,
        changedFilePaths: ["src/value.ts"],
        commitSubjects: ["Implement the change"],
        checks: "SUCCESS",
        mergeable: "MERGEABLE",
        createdAt: new Date(),
        headSha: observedHead,
        headCommittedAt: new Date(),
        mergedAt: null,
        closedAt: null,
        agentWorkEvents: [
          { kind: "started", at: new Date(), message: null },
          { kind: "finished", at: new Date(), message: null },
        ],
      },
    ];
    const attributedPulls = current.workItems[0]!.linkedPullRequests;
    current.workItems[0]!.linkedPullRequests = [];
    const gitCalls: string[][] = [];
    let fetchedHead = "e".repeat(40);
    const backend = new GitHubManagedAgentBackend({
      reader: { readObjective: async () => current } as unknown as GitHubReader,
      dispatcher: dispatcher(new ManagedWriter(), actor.id),
      repository: "/tmp/factory-managed-test",
      profile: GITHUB_COPILOT_MANAGED_PROFILE,
      actorResolution: { actor },
      runGit: async (_repository, args) => {
        gitCalls.push(args);
        if (args[0] === "rev-parse") return `${fetchedHead}\n`;
        if (args[0] === "diff" && args.includes("--name-only")) return "src/value.ts\0";
        if (args[0] === "diff") return "diff --git a/src/value.ts b/src/value.ts\n";
        return "";
      },
    });
    const handle = await backend.launch(context());
    current.workItems[0]!.linkedPullRequests = attributedPulls;
    await expect(backend.observe(handle)).resolves.toMatchObject({ state: "succeeded" });
    await expect(backend.collect(handle)).rejects.toThrow(/does not match observed head/);
    expect(gitCalls.some((args) => args[0] === "diff")).toBe(false);
    expect(gitCalls.at(-1)?.slice(0, 2)).toEqual(["update-ref", "-d"]);

    gitCalls.length = 0;
    fetchedHead = observedHead;
    await expect(backend.collect(handle)).resolves.toMatchObject({
      outcome: "succeeded",
      changedPaths: ["src/value.ts"],
    });
    const fetch = gitCalls.find((args) => args[0] === "fetch");
    expect(fetch?.at(-1)).toMatch(
      /^\+refs\/pull\/51\/head:refs\/clockgrove-factory\/managed\/[a-f0-9]{64}$/,
    );
    expect(
      gitCalls.filter((args) => args[0] === "diff").every((args) => args.at(-1) === observedHead),
    ).toBe(true);
    expect(gitCalls.at(-1)?.slice(0, 2)).toEqual(["update-ref", "-d"]);
  });

  it("recovers only one post-start PR carrying an authoritative agent event", () => {
    const current = snapshot().workItems[0]!;
    const startedAt = new Date().toISOString();
    const makePull = (number: number, event = true) => ({
      id: `PR_${number}`,
      number,
      state: "OPEN" as const,
      isDraft: false,
      title: "Managed result",
      body: "Closes #22",
      changedLines: 1,
      changedFiles: 1,
      changedFilePaths: ["src/value.ts"],
      commitSubjects: ["Managed result"],
      checks: "SUCCESS" as const,
      mergeable: "MERGEABLE" as const,
      createdAt: new Date(),
      headSha: String(number % 10).repeat(40),
      headCommittedAt: new Date(),
      mergedAt: null,
      closedAt: null,
      agentWorkEvents: event ? [{ kind: "started" as const, at: new Date(), message: null }] : [],
    });
    current.linkedPullRequests = [makePull(51, false), makePull(52)];
    expect(selectManagedRecoveryPull(current.linkedPullRequests, startedAt)?.number).toBe(52);
    current.linkedPullRequests.push(makePull(53));
    expect(() => selectManagedRecoveryPull(current.linkedPullRequests, startedAt)).toThrow(
      /recovery is ambiguous/,
    );
    expect(
      selectManagedRecoveryPull(current.linkedPullRequests, startedAt, "3".repeat(40))?.number,
    ).toBe(53);
  });

  it("fails closed when multiple pull requests appear after managed assignment", async () => {
    const actor = { id: "BOT_runtime", login: "copilot-swe-agent", type: "Bot" as const };
    const current = snapshot();
    current.workItems[0]!.assignees = [actor.login];
    const backend = new GitHubManagedAgentBackend({
      reader: { readObjective: async () => current } as unknown as GitHubReader,
      dispatcher: dispatcher(new ManagedWriter(), actor.id),
      repository: "/tmp/factory-managed-test",
      profile: GITHUB_COPILOT_MANAGED_PROFILE,
      actorResolution: { actor },
    });
    const handle = await backend.launch(context());
    current.workItems[0]!.linkedPullRequests = [51, 52].map((number) => ({
      id: `PR_${number}`,
      number,
      state: "OPEN" as const,
      isDraft: false,
      title: "Concurrent work",
      body: "Closes #22",
      changedLines: 1,
      changedFiles: 1,
      changedFilePaths: ["src/value.ts"],
      commitSubjects: ["Concurrent work"],
      checks: "SUCCESS" as const,
      mergeable: "MERGEABLE" as const,
      createdAt: new Date(),
      headSha: String(number % 10).repeat(40),
      headCommittedAt: new Date(),
      mergedAt: null,
      closedAt: null,
      agentWorkEvents: [{ kind: "started" as const, at: new Date(), message: null }],
    }));
    await expect(backend.observe(handle)).resolves.toMatchObject({
      state: "failed",
      reason: expect.stringContaining("attribution is ambiguous"),
    });
    await backend.cleanup(handle);
  });
});

class StubBackend implements ExecutionBackend {
  constructor(
    readonly capabilities: ExecutionBackendCapabilities,
    readonly available: boolean,
  ) {}
  async probe(): Promise<BackendProbe> {
    return {
      available: this.available,
      authenticated: this.available,
      ...(!this.available ? { reason: "provider unavailable" } : {}),
      measuredAt: new Date().toISOString(),
    };
  }
  async launch(): Promise<BackendHandle> {
    throw new Error("not used");
  }
  async observe(): Promise<BackendObservation> {
    throw new Error("not used");
  }
  async cancel(): Promise<void> {}
  async collect(): Promise<NormalizedArtifact> {
    throw new Error("not used");
  }
  async cleanup(): Promise<void> {}
}

function capabilities(
  id: string,
  isolation: "process" | "managed",
  paid: boolean,
): ExecutionBackendCapabilities {
  return {
    id,
    agentKind: id.split("/")[0]!,
    runtimeKind: isolation === "managed" ? "github-managed" : "local-worktree",
    hostExecution: !paid,
    isolation,
    supportedOs: ["linux"],
    supportedArchitectures: ["x64"],
    supportedTools: [],
    supportedServices: [],
    supportsCancellation: true,
    supportsObservation: true,
    supportsResume: false,
    supportsLocalInference: false,
    requiresPaidRuntime: paid,
    providerManagedPublication: paid,
    requiredCredentials: [],
  };
}

describe("managed-agent routing authority", () => {
  const policy = parseRunPolicy({
    ...DEFAULT_RUN_POLICY,
    backendOrder: ["openai-codex/github-managed", "codex-cli/local-worktree"],
    allowedPaidBackends: ["openai-codex/github-managed"],
    cloudFallback: "explicit",
    maxManagedAgentSessions: 1,
  });

  it.each([GITHUB_COPILOT_MANAGED_PROFILE, OPENAI_CODEX_MANAGED_PROFILE])(
    "requires explicit paid authorization and a nonzero session ceiling for $backendId",
    (profile) => {
      const profilePolicy = parseRunPolicy({
        ...DEFAULT_RUN_POLICY,
        backendOrder: [profile.backendId],
        allowedPaidBackends: [profile.backendId],
        cloudFallback: "explicit",
        maxManagedAgentSessions: 1,
      });
      expect(() =>
        parseRunPolicy({
          ...profilePolicy,
          allowedPaidBackends: [],
        }),
      ).toThrow(/not explicitly allowed/);
      expect(() =>
        parseRunPolicy({
          ...profilePolicy,
          maxManagedAgentSessions: 0,
        }),
      ).toThrow(/zero session budget/);
    },
  );

  it("falls back to an ordinary local backend when the managed profile is unavailable", async () => {
    const registry = new BackendRegistry();
    registry.register(
      new StubBackend(capabilities("openai-codex/github-managed", "managed", true), false),
    );
    const local = new StubBackend(capabilities("codex-cli/local-worktree", "process", false), true);
    registry.register(local);
    expect(
      (
        await registry.select({
          policy,
          requirements: context().packet.requirements,
          budget: { sandboxMinutes: 0, managedAgentSessions: 1 },
        })
      ).backend,
    ).toBe(local);
  });

  it.each([GITHUB_COPILOT_MANAGED_PROFILE, OPENAI_CODEX_MANAGED_PROFILE])(
    "accounts $backendId against the managed-session budget",
    async (profile) => {
      const registry = new BackendRegistry();
      registry.register(new StubBackend(capabilities(profile.backendId, "managed", true), true));
      await expect(
        registry.select({
          policy: parseRunPolicy({
            ...policy,
            backendOrder: [profile.backendId],
            allowedPaidBackends: [profile.backendId],
          }),
          requirements: context().packet.requirements,
          budget: { sandboxMinutes: 0, managedAgentSessions: 0 },
        }),
      ).rejects.toBeInstanceOf(NoExecutionBackendError);
    },
  );
});
