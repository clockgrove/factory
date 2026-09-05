import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FactoryApplicationService } from "../src/application/services.js";
import { CodexCliLocalBackend } from "../src/backends/codex-cli-local.js";
import { CodexSdkLocalBackend } from "../src/backends/codex-sdk-local.js";
import { GitHubControlStore } from "../src/control/github-store.js";
import { LeaseManager } from "../src/control/lease.js";
import { LifecycleRecorder } from "../src/control/events.js";
import { RunManager } from "../src/control/runs.js";
import { decodeEventComments } from "../src/control/receipts.js";
import {
  implicitRestartBlocker,
  inspectImplicitRestart,
  TERMINAL_RECOVERY_REQUIRED,
  type RecoverySnapshot,
} from "../src/control/recovery.js";
import { GitHubReader } from "../src/github.js";
import { CodexCliManagementBackend } from "../src/management/codex-cli.js";
import { parseFactoryEvent } from "../src/protocol/events.js";
import { DEFAULT_RUN_POLICY, policyDigest } from "../src/protocol/policy.js";
import { FactorySupervisor } from "../src/supervisor.js";

function event(fields: Record<string, unknown>) {
  return parseFactoryEvent({
    protocol: "clockgrove.factory/v2",
    objective: 7,
    runId: "prior",
    sequence: 2,
    at: "2026-09-04T00:00:00.000Z",
    ...fields,
  });
}

function started(runId = "prior", sequence = 1) {
  return event({
    kind: "run",
    event: "FactoryRunStarted",
    runId,
    sequence,
    actor: "operator",
    repository: "o/r",
    objectiveAuthor: "operator",
    fork: false,
    baseBranch: "main",
    policy: DEFAULT_RUN_POLICY,
    policyDigest: policyDigest(DEFAULT_RUN_POLICY),
  });
}

function snapshot(): RecoverySnapshot {
  return {
    number: 7,
    workItems: [],
    factoryEvents: [started(), event({ kind: "run", event: "FactoryRunEscalated", sequence: 10 })],
  };
}

const attempt = () =>
  event({
    kind: "attempt",
    event: "AttemptReserved",
    workItem: 8,
    attempt: 1,
    backend: "codex-sdk/local-worktree",
    baseSha: "a".repeat(40),
    directorEpoch: 1,
    policyDigest: policyDigest(DEFAULT_RUN_POLICY),
  });
const graph = () =>
  event({
    kind: "graph",
    event: "GraphCompiled",
    graphDigest: "d".repeat(64),
    graphSize: 1,
    baseSha: "a".repeat(40),
    graphRef: "refs/clockgrove-factory/graphs/objective-7/prior",
    graphBlobSha: "b".repeat(40),
  });

afterEach(() => vi.restoreAllMocks());

describe("terminal-run recovery admission", () => {
  it.each([
    "execution",
    "controller-execution",
    "reservation",
    "active",
    "closed",
    "resumed-escalated",
    "resumed-cancelled",
    "resumed-completed",
    "resumed-missing-start",
    "resumed-policy",
    "resumed-actor",
    "resumed-base",
    "resumed-activation",
    "resumed-time",
    "resumed-run-id",
    "resumed-objective-id",
    "resumed-repository-id",
    "resumed-author",
    "resumed-branch",
  ])("releases the acquired lease when %s appears after preflight", async (change) => {
    const repository = await mkdtemp(join(tmpdir(), "factory-recovery-race-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: repository });
      execFileSync("git", ["remote", "add", "origin", "https://github.com/o/r.git"], {
        cwd: repository,
      });
      const before = {
        ...snapshot(),
        id: "objective-node",
        repositoryId: "repo-node",
        title: "Objective",
        body: "Objective",
        authorLogin: "operator",
        closed: false,
        readAt: new Date(),
        defaultBranch: "main",
        workItems: [],
        workItemLabelId: null,
        copilotBotId: null,
        ciExpectedOnPullRequests: false as const,
      };
      if (change.startsWith("resumed-")) before.factoryEvents = [started()];
      const after = structuredClone(before);
      if (change === "execution" || change === "controller-execution")
        after.factoryEvents!.push(attempt());
      if (change === "active") after.factoryEvents!.push(started("new-active", 11));
      if (change === "closed") after.closed = true;
      const terminal = {
        "resumed-escalated": "FactoryRunEscalated",
        "resumed-cancelled": "FactoryRunCancelled",
        "resumed-completed": "FactoryRunCompleted",
      }[change];
      if (terminal)
        after.factoryEvents!.push(event({ kind: "run", event: terminal, sequence: 10 }));
      if (change === "resumed-missing-start") after.factoryEvents = [];
      const updatedPolicy = { ...DEFAULT_RUN_POLICY, maxAttemptsPerItem: 2 };
      const changedStart: Record<string, unknown> | undefined = {
        "resumed-policy": { policy: updatedPolicy, policyDigest: policyDigest(updatedPolicy) },
        "resumed-actor": { actor: "other-operator" },
        "resumed-base": { baseSha: "b".repeat(40) },
        "resumed-activation": { activationRequestId: "other-activation" },
        "resumed-time": { at: "2026-09-04T00:01:00.000Z" },
        "resumed-run-id": { runId: "other-run" },
      }[change];
      if (changedStart) after.factoryEvents = [event({ ...started(), ...changedStart })];
      if (change === "resumed-objective-id") after.id = "other-objective";
      if (change === "resumed-repository-id") after.repositoryId = "other-repository";
      if (change === "resumed-author") after.authorLogin = "other-author";
      if (change === "resumed-branch") after.defaultBranch = "other-branch";
      const read = vi
        .spyOn(GitHubReader.prototype, "readObjective")
        .mockResolvedValueOnce(before)
        .mockResolvedValue(after);
      vi.spyOn(GitHubControlStore.prototype, "getRepositoryFacts").mockResolvedValue({
        fullName: "o/r",
        fork: false,
        private: true,
        defaultBranch: "main",
        canPush: true,
      });
      vi.spyOn(GitHubControlStore.prototype, "getAuthenticatedLogin").mockResolvedValue("operator");
      vi.spyOn(GitHubControlStore.prototype, "readRepositoryPermission").mockResolvedValue("write");
      const refs = vi.spyOn(GitHubControlStore.prototype, "listRefs").mockResolvedValue([]);
      if (change === "reservation")
        refs
          .mockResolvedValueOnce([])
          .mockResolvedValue([{ ref: "reservation", oid: "b".repeat(40) }]);
      vi.spyOn(GitHubControlStore.prototype, "readBranchRules").mockResolvedValue([]);
      vi.spyOn(GitHubControlStore.prototype, "getBranchHead").mockResolvedValue({
        oid: "a".repeat(40),
        treeOid: "b".repeat(40),
        parentOids: [],
        message: "base",
        serverTime: new Date(),
      });
      const probe = vi
        .spyOn(CodexCliManagementBackend.prototype, "probe")
        .mockResolvedValue({ available: true, authenticated: true });
      vi.spyOn(LeaseManager.prototype, "read").mockResolvedValue(null);
      const acquire = vi
        .spyOn(LeaseManager.prototype, "acquire")
        .mockImplementation(async (identity, base, sequence) => ({
          ...identity,
          ref: "refs/clockgrove-factory/leases/objective-7",
          oid: "c".repeat(40),
          treeOid: base.treeOid,
          epoch: 2,
          sequence: sequence ?? 1,
          expiresAt: new Date(Date.now() + 60_000),
        }));
      const release = vi
        .spyOn(LeaseManager.prototype, "release")
        .mockImplementation(async (lease) => lease);
      const start = vi
        .spyOn(RunManager.prototype, "start")
        .mockRejectedValue(new Error("unexpected run start"));
      const compile = vi
        .spyOn(CodexCliManagementBackend.prototype, "compile")
        .mockRejectedValue(new Error("unexpected compilation"));
      const review = vi
        .spyOn(CodexCliManagementBackend.prototype, "review")
        .mockRejectedValue(new Error("unexpected review"));
      const budget = vi
        .spyOn(LifecycleRecorder.prototype, "budget")
        .mockRejectedValue(new Error("unexpected budget write"));
      const sdkLaunch = vi
        .spyOn(CodexSdkLocalBackend.prototype, "launch")
        .mockRejectedValue(new Error("unexpected SDK worker launch"));
      const sdkProbe = vi
        .spyOn(CodexSdkLocalBackend.prototype, "probe")
        .mockRejectedValue(new Error("unexpected SDK worker probe"));
      const cliProbe = vi
        .spyOn(CodexCliLocalBackend.prototype, "probe")
        .mockRejectedValue(new Error("unexpected CLI worker probe"));
      const cliLaunch = vi
        .spyOn(CodexCliLocalBackend.prototype, "launch")
        .mockRejectedValue(new Error("unexpected CLI worker launch"));
      const write = vi
        .spyOn(GitHubControlStore.prototype, "addIssueComment")
        .mockRejectedValue(new Error("unexpected comment"));
      if (change === "controller-execution") {
        write.mockResolvedValue(undefined);
        vi.spyOn(GitHubControlStore.prototype, "serverTime").mockResolvedValue(
          new Date("2026-09-04T01:00:00.000Z"),
        );
      }
      const run = new FactorySupervisor({
        token: "test-token",
        owner: "o",
        repo: "r",
        objective: 7,
        repository,
        policy: DEFAULT_RUN_POLICY,
        ...(change === "controller-execution"
          ? { activation: { requestId: "race-activation", baseSha: "a".repeat(40) } }
          : {}),
      }).run();
      if (change === "active" || change === "closed" || change.startsWith("resumed-")) {
        await expect(run).rejects.toThrow("Objective run changed during startup");
      } else {
        await expect(run).resolves.toMatchObject({
          status: "escalated",
          runId: "not-started",
          reason: TERMINAL_RECOVERY_REQUIRED,
        });
      }
      expect(read).toHaveBeenCalledTimes(2);
      expect(probe).toHaveBeenCalledOnce();
      expect(acquire).toHaveBeenCalledOnce();
      expect(release).toHaveBeenCalledOnce();
      expect(release.mock.calls[0]![0].runId).toBe(acquire.mock.calls[0]![0].runId);
      expect(read.mock.invocationCallOrder[1]).toBeGreaterThan(
        acquire.mock.invocationCallOrder[0]!,
      );
      expect(probe.mock.invocationCallOrder[0]).toBeLessThan(acquire.mock.invocationCallOrder[0]!);
      expect(start).not.toHaveBeenCalled();
      expect(compile).not.toHaveBeenCalled();
      expect(review).not.toHaveBeenCalled();
      expect(budget).not.toHaveBeenCalled();
      expect(sdkLaunch).not.toHaveBeenCalled();
      expect(cliLaunch).not.toHaveBeenCalled();
      expect(sdkProbe).not.toHaveBeenCalled();
      expect(cliProbe).not.toHaveBeenCalled();
      if (change === "controller-execution") {
        expect(write).toHaveBeenCalledOnce();
        expect(decodeEventComments(write.mock.calls[0]![1])).toEqual([
          expect.objectContaining({
            event: "ActivationRejected",
            activationRequestId: "race-activation",
            reason: TERMINAL_RECOVERY_REQUIRED,
          }),
        ]);
        expect(write.mock.invocationCallOrder[0]).toBeLessThan(
          release.mock.invocationCallOrder[0]!,
        );
      } else expect(write).not.toHaveBeenCalled();
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });

  it.each(["FactoryRunEscalated", "FactoryRunCancelled", "FactoryRunCompleted"])(
    "rejects a new run after %s without erasing earlier execution",
    async (terminal) => {
      const current = snapshot();
      current.factoryEvents = [
        started(),
        attempt(),
        event({ kind: "run", event: terminal, sequence: 10 }),
        started("later", 11),
        event({ kind: "run", event: "FactoryRunEscalated", runId: "later", sequence: 12 }),
      ];
      const refs = vi.fn(async () => []);
      expect(await inspectImplicitRestart(current, refs)).toBe(TERMINAL_RECOVERY_REQUIRED);
      expect(refs).not.toHaveBeenCalled();
    },
  );

  it.each(["objective", "child"])("finds execution evidence on the %s", (location) => {
    const current = snapshot();
    if (location === "objective") current.factoryEvents!.push(attempt());
    else current.workItems.push({ number: 8, factoryEvents: [attempt()] });
    expect(implicitRestartBlocker(current)).toBe(TERMINAL_RECOVERY_REQUIRED);
  });

  it.each([
    {
      kind: "capacity",
      event: "CapacityReserved",
      workItem: 8,
      attempt: 1,
      phase: "execution",
      backend: "codex-sdk/local-worktree",
      requestedCpu: 1,
      requestedMemoryMb: 512,
      directorEpoch: 1,
      policyDigest: policyDigest(DEFAULT_RUN_POLICY),
    },
    {
      kind: "capacity",
      event: "CapacityReconciled",
      workItem: 8,
      attempt: 1,
      phase: "validation",
      backend: "codex-sdk/local-worktree",
      requestedCpu: 1,
      requestedMemoryMb: 512,
      directorEpoch: 1,
      policyDigest: policyDigest(DEFAULT_RUN_POLICY),
    },
    {
      kind: "validation",
      event: "ValidationRecorded",
      workItem: 8,
      attempt: 1,
      baseSha: "a".repeat(40),
      outputTreeSha: "b".repeat(40),
      passed: false,
      evidenceDigest: "c".repeat(64),
    },
    {
      kind: "publication",
      event: "PublicationRecorded",
      workItem: 8,
      attempt: 1,
      unitId: "delivery/a",
      itemId: "a",
      mode: "regular-prs",
      position: 0,
      branch: "factory/a",
      baseBranch: "main",
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      pullRequest: 9,
      capabilityVersion: "test",
      validationDigest: "c".repeat(64),
      exactHeadValidationDigest: "d".repeat(64),
    },
  ])("rejects durable $event without an Attempt comment", (fields) => {
    const current = snapshot();
    current.factoryEvents!.push(event(fields));
    expect(implicitRestartBlocker(current)).toBe(TERMINAL_RECOVERY_REQUIRED);
  });

  it.each([
    "AttemptReserved",
    "AttemptStarted",
    "AttemptProgressed",
    "AttemptSucceeded",
    "AttemptFailed",
    "AttemptTimedOut",
    "AttemptCancelled",
    "AttemptDeferred",
    "AttemptCollected",
    "AttemptPublished",
    "AttemptValidated",
    "AttemptIntegrated",
  ])("retains %s as execution history", (name) => {
    const current = snapshot();
    current.factoryEvents!.push(event({ ...attempt(), event: name }));
    expect(implicitRestartBlocker(current)).toBe(TERMINAL_RECOVERY_REQUIRED);
  });

  it.each([
    { phase: "execution", amount: 0 },
    { phase: "validation", amount: 10 },
    { phase: "management", amount: 0, workItem: 8 },
  ])("does not mistake reconciled usage for absent execution: %j", (fields) => {
    const current = snapshot();
    current.factoryEvents!.push(
      event({ kind: "budget", event: "BudgetReconciled", unit: "model_tokens", ...fields }),
    );
    expect(implicitRestartBlocker(current)).toBe(TERMINAL_RECOVERY_REQUIRED);
  });

  it.each([
    { closed: true },
    { linkedPullRequests: [{ state: "CLOSED" }] },
    { linkedPullRequests: [{ state: "MERGED" }] },
    { copilotAssignments: [new Date()] },
  ])("protects Work Item history even without receipts: %j", (fields) => {
    const current = snapshot();
    current.workItems.push({ number: 8, ...fields });
    expect(implicitRestartBlocker(current)).toBe(TERMINAL_RECOVERY_REQUIRED);
  });

  it("finds a reservation with no comment, even for a removed child", async () => {
    const current = snapshot();
    const refs = vi.fn(async () => [
      { ref: "refs/clockgrove-factory/attempts/objective-7/work-item-8/attempt-1" },
    ]);
    expect(await inspectImplicitRestart(current, refs)).toBe(TERMINAL_RECOVERY_REQUIRED);
    expect(refs).toHaveBeenCalledExactlyOnceWith("refs/clockgrove-factory/attempts/objective-7/");
  });

  it("rejects surviving reservation refs when all start and execution comments are missing", async () => {
    const current = snapshot();
    current.factoryEvents = [];
    const refs = vi.fn(async () => [
      { ref: "refs/clockgrove-factory/attempts/objective-7/work-item-8/attempt-1" },
    ]);
    expect(await inspectImplicitRestart(current, refs)).toBe(TERMINAL_RECOVERY_REQUIRED);
    expect(refs).toHaveBeenCalledExactlyOnceWith("refs/clockgrove-factory/attempts/objective-7/");
  });

  it.each([
    { linkedPullRequests: [{ state: "OPEN" }] },
    { linkedPullRequests: [{ state: "CLOSED" }] },
    { linkedPullRequests: [{ state: "MERGED" }] },
    { closed: true },
    { copilotAssignments: [new Date("2026-09-04T00:00:00.000Z")] },
  ])("protects surviving child evidence without a start receipt: %j", async (fields) => {
    const current = snapshot();
    current.factoryEvents = [];
    current.workItems.push({ number: 8, ...fields });
    const refs = vi.fn(async () => []);
    expect(await inspectImplicitRestart(current, refs)).toBe(TERMINAL_RECOVERY_REQUIRED);
    expect(refs).not.toHaveBeenCalled();
  });

  it("propagates an unavailable reservation read rather than starting blind", async () => {
    await expect(
      inspectImplicitRestart(snapshot(), async () => {
        throw new Error("offline");
      }),
    ).rejects.toThrow("offline");
  });

  it("preserves graph-only and failed-compilation retries", async () => {
    const current = snapshot();
    current.factoryEvents!.push(
      graph(),
      event({
        kind: "budget",
        event: "BudgetReconciled",
        phase: "management",
        unit: "model_tokens",
        amount: 30,
        usageId: "failed-compile-base",
      }),
    );
    current.workItems.push({ number: 8 });
    const refs = vi.fn(async () => []);
    expect(await inspectImplicitRestart(current, refs)).toBeNull();
    expect(refs).toHaveBeenCalledOnce();
  });

  it.each(["fresh", "active", "closed"])("leaves %s handling unchanged", async (state) => {
    const current = snapshot();
    if (state === "fresh") current.factoryEvents = [];
    if (state === "active") current.factoryEvents = [started(), attempt()];
    if (state === "closed") {
      current.closed = true;
      current.factoryEvents!.push(attempt());
    }
    const refs = vi.fn(async () => []);
    expect(await inspectImplicitRestart(current, refs)).toBeNull();
    if (state === "fresh")
      expect(refs).toHaveBeenCalledExactlyOnceWith("refs/clockgrove-factory/attempts/objective-7/");
    else expect(refs).not.toHaveBeenCalled();
  });

  it("rechecks activation under the command lock before writing", async () => {
    const current = {
      ...snapshot(),
      id: "objective-node",
      title: "Objective",
      defaultBranch: "main",
      workItems: [],
    };
    let reads = 0;
    const write = vi.fn(async () => {});
    const service = new FactoryApplicationService({
      owner: "o",
      repo: "r",
      reader: {
        readObjective: async () => {
          if (++reads === 2) current.factoryEvents!.push(attempt());
          return structuredClone(current);
        },
      },
      store: {
        addIssueComment: write,
        ensureObjectiveLabel: async () => {},
        serverTime: async () => new Date(),
        getAuthenticatedLogin: async () => "operator",
      },
    });
    await expect(
      service.activate({ objective: 7, requestId: "restart", baseSha: "a".repeat(40) }),
    ).rejects.toThrow(TERMINAL_RECOVERY_REQUIRED);
    expect(reads).toBe(2);
    expect(write).not.toHaveBeenCalled();
  });

  it("replays an identical activation after execution without granting new authority", async () => {
    const prior = event({
      kind: "run",
      event: "ActivationRequested",
      sequence: 0,
      runId: "activation",
      requestId: "activation",
      requestedBy: "operator",
      repository: "o/r",
      baseSha: "a".repeat(40),
      policy: DEFAULT_RUN_POLICY,
      policyDigest: policyDigest(DEFAULT_RUN_POLICY),
      controllerProtocolMin: "clockgrove.factory/v2",
      controllerProtocolMax: "clockgrove.factory/v2",
    });
    const current = {
      ...snapshot(),
      id: "objective-node",
      title: "Objective",
      defaultBranch: "main",
      workItems: [],
    };
    current.factoryEvents!.push(prior, attempt());
    const write = vi.fn(async () => {});
    const actor = vi.fn(async () => "operator");
    const service = new FactoryApplicationService({
      owner: "o",
      repo: "r",
      reader: { readObjective: async () => structuredClone(current) },
      store: {
        addIssueComment: write,
        ensureObjectiveLabel: async () => {},
        serverTime: async () => new Date(),
        getAuthenticatedLogin: actor,
      },
    });
    await expect(
      service.activate({ objective: 7, requestId: "activation", baseSha: "a".repeat(40) }),
    ).resolves.toEqual(prior);
    await expect(
      service.activate({ objective: 7, requestId: "activation", baseSha: "b".repeat(40) }),
    ).rejects.toThrow(/idempotency key/);
    await expect(
      service.activate({ objective: 7, requestId: "new-activation", baseSha: "a".repeat(40) }),
    ).rejects.toThrow(TERMINAL_RECOVERY_REQUIRED);
    expect(write).not.toHaveBeenCalled();
    expect(actor).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "rejects startup before lease, run, or management calls (controller=%s)",
    async (controller) => {
      const repository = await mkdtemp(join(tmpdir(), "factory-terminal-recovery-"));
      try {
        execFileSync("git", ["init", "-q"], { cwd: repository });
        execFileSync("git", ["remote", "add", "origin", "https://github.com/o/r.git"], {
          cwd: repository,
        });
        const current = {
          ...snapshot(),
          id: "objective-node",
          repositoryId: "repo-node",
          title: "Objective",
          body: "Objective",
          authorLogin: "operator",
          closed: false,
          readAt: new Date(),
          defaultBranch: "main",
          workItems: [],
          workItemLabelId: null,
          copilotBotId: null,
          ciExpectedOnPullRequests: false as const,
        };
        vi.spyOn(GitHubReader.prototype, "readObjective").mockResolvedValue(current);
        vi.spyOn(GitHubControlStore.prototype, "getRepositoryFacts").mockResolvedValue({
          fullName: "o/r",
          fork: false,
          private: true,
          defaultBranch: "main",
          canPush: true,
        });
        vi.spyOn(GitHubControlStore.prototype, "getAuthenticatedLogin").mockResolvedValue(
          "operator",
        );
        vi.spyOn(GitHubControlStore.prototype, "readRepositoryPermission").mockResolvedValue(
          "write",
        );
        vi.spyOn(GitHubControlStore.prototype, "listRefs").mockResolvedValue([
          { ref: "reservation", oid: "b".repeat(40) },
        ]);
        const lease = vi.spyOn(LeaseManager.prototype, "acquire");
        const start = vi.spyOn(RunManager.prototype, "start");
        const probe = vi.spyOn(CodexCliManagementBackend.prototype, "probe");
        vi.spyOn(GitHubControlStore.prototype, "serverTime").mockResolvedValue(
          new Date("2026-09-04T01:00:00.000Z"),
        );
        const write = vi
          .spyOn(GitHubControlStore.prototype, "addIssueComment")
          .mockImplementation(async (_id, body) => {
            current.factoryEvents!.push(...decodeEventComments(body));
          });
        const options = {
          token: "test-token",
          owner: "o",
          repo: "r",
          objective: 7,
          repository,
          policy: DEFAULT_RUN_POLICY,
          ...(controller
            ? { activation: { requestId: "successor", baseSha: "a".repeat(40) } }
            : {}),
        };
        const result = await new FactorySupervisor(options).run();
        expect(result).toMatchObject({
          status: "escalated",
          runId: "not-started",
          reason: TERMINAL_RECOVERY_REQUIRED,
        });
        if (controller) {
          await expect(new FactorySupervisor(options).run()).resolves.toEqual(result);
          expect(write).toHaveBeenCalledOnce();
          expect(decodeEventComments(write.mock.calls[0]![1])).toEqual([
            expect.objectContaining({
              event: "ActivationRejected",
              runId: "successor",
              activationRequestId: "successor",
              reason: TERMINAL_RECOVERY_REQUIRED,
              requestedBy: "operator",
            }),
          ]);
        } else expect(write).not.toHaveBeenCalled();
        expect(lease).not.toHaveBeenCalled();
        expect(start).not.toHaveBeenCalled();
        expect(probe).not.toHaveBeenCalled();
      } finally {
        await rm(repository, { recursive: true, force: true });
      }
    },
  );
});
