import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { CodexAppServerLocalBackend } from "../src/backends/codex-app-server.js";
import { GitHubControlStore } from "../src/control/github-store.js";
import { IssueAdmissionLedger } from "../src/control/issue-admission.js";
import { unresolvedModelInvocations } from "../src/control/budget.js";
import { decodeEventComments } from "../src/control/receipts.js";
import { PlatformUnavailableError } from "../src/platform.js";
import type {
  AppServerConnection,
  AppServerExit,
  AppServerNotification,
  AppServerRequest,
  AppServerRequestId,
} from "../src/runtime/codex-app-server.js";
import { providerSupervisorFixture } from "./helpers/provider-supervisor.js";

const APP_SERVER = "codex-app-server/local-worktree";
const HOST = "b".repeat(64);

interface RecoveryState {
  thread?: Record<string, unknown>;
  threadReads: number;
  threadStarts: number;
  turnStarts: number;
  interrupts: number;
  connections: RecoveryConnection[];
}

class RecoveryConnection implements AppServerConnection {
  readonly pid = null;
  readonly closed: Promise<AppServerExit>;
  readonly notificationListeners = new Set<(event: AppServerNotification) => void>();
  readonly requestListeners = new Set<(request: AppServerRequest) => void>();
  #resolveClosed!: (exit: AppServerExit) => void;
  closedByClient = false;

  constructor(readonly state: RecoveryState) {
    state.connections.push(this);
    this.closed = new Promise((resolve) => {
      this.#resolveClosed = resolve;
    });
  }

  async request<T>(method: string, params?: unknown): Promise<T> {
    if (method === "initialize") return { userAgent: "codex_cli_rs/0.153.2" } as T;
    if (method === "thread/start") {
      this.state.threadStarts += 1;
      const input = params as { cwd: string; model?: string };
      this.state.thread = {
        id: "thread-recovery",
        sessionId: "session-recovery",
        cwd: input.cwd,
        modelProvider: "openai",
        model: input.model ?? "gpt-5",
        cliVersion: "0.153.2",
        turns: [],
      };
      return {
        thread: this.state.thread,
        model: input.model ?? "gpt-5",
        approvalPolicy: "never",
      } as T;
    }
    if (method === "turn/start") {
      this.state.turnStarts += 1;
      const turn = { id: "turn-recovery", status: "inProgress", items: [] };
      this.state.thread = { ...this.state.thread, turns: [turn] };
      return { turn } as T;
    }
    if (method === "thread/read") {
      this.state.threadReads += 1;
      return {
        thread: this.state.thread,
        initialTurnsPage: {
          data: (this.state.thread?.turns as unknown[]) ?? [],
          nextCursor: null,
          backwardsCursor: null,
        },
      } as T;
    }
    if (method === "turn/interrupt") {
      this.state.interrupts += 1;
      return {} as T;
    }
    return {} as T;
  }

  notify(): void {}
  respond(_id: AppServerRequestId, _result: unknown): void {}
  respondError(_id: AppServerRequestId, _code: number, _message: string): void {}
  onNotification(listener: (event: AppServerNotification) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }
  onRequest(listener: (request: AppServerRequest) => void): () => void {
    this.requestListeners.add(listener);
    return () => this.requestListeners.delete(listener);
  }
  emit(method: string, params: unknown): void {
    for (const listener of this.notificationListeners) listener({ method, params });
  }
  async close(): Promise<void> {
    if (this.closedByClient) return;
    this.closedByClient = true;
    this.#resolveClosed({ exitCode: 0, signal: null, stderr: "" });
  }
}

describe("Supervisor App Server terminal recovery", () => {
  it("settles response-lost cold recovery once with conservative native usage", async () => {
    const homes = await mkdtemp(join(tmpdir(), "factory-app-supervisor-recovery-"));
    const state: RecoveryState = {
      threadReads: 0,
      threadStarts: 0,
      turnStarts: 0,
      interrupts: 0,
      connections: [],
    };
    let launches = 0;
    const adapter = new CodexAppServerLocalBackend({
      authFile: join(homes, "missing-auth"),
      cancellationWaitMs: 5,
      readHostIdentity: async () => HOST,
      resolveCodexHome: (identity) =>
        join(homes, `${identity.runId}-${identity.workItem}-${identity.attempt}`),
      connect: () => new RecoveryConnection(state),
      scopeReadPort: {
        hostIdentity: async () => HOST,
        now: () => new Date(),
        read: async () => {
          throw Object.assign(new Error("fixture scope is absent"), { code: "ENOENT" });
        },
        show: async (unit) =>
          `Id=${unit}\nLoadState=not-found\nActiveState=inactive\nSubState=dead\nControlGroup=\nJob=0\n`,
      },
    });
    const f = await providerSupervisorFixture("daytona-burst", {
      localOnly: true,
      dependencyChain: true,
      maxAttemptsPerItem: 1,
      localBackendId: APP_SERVER,
      configureLocalBackend: (base) => ({
        ...base,
        capabilities: adapter.capabilities,
        launch: async (context) => {
          launches += 1;
          return adapter.launch(context);
        },
        waitForTerminal: adapter.waitForTerminal.bind(adapter),
        observe: adapter.observe.bind(adapter),
        collect: adapter.collect.bind(adapter),
        cancel: adapter.cancel.bind(adapter),
        cleanup: adapter.cleanup.bind(adapter),
        resume: adapter.resume.bind(adapter),
        reconcileStale: adapter.reconcileStale.bind(adapter),
      }),
    });
    const write = vi.mocked(GitHubControlStore.prototype.addIssueComment).getMockImplementation();
    if (!write) throw new Error("fixture receipt transport missing");
    let controllerTransportDown = false;
    let loseTerminalResponse = true;
    vi.mocked(GitHubControlStore.prototype.addIssueComment).mockImplementation(
      async (node, body) => {
        const events = decodeEventComments(body);
        if (events.some((event) => event.event === "AttemptStarted")) {
          controllerTransportDown = true;
        }
        if (controllerTransportDown) {
          throw new PlatformUnavailableError(
            { kind: "server_error", retryAfterMs: 1 },
            new Error("simulated controller loss before AttemptStarted persistence"),
          );
        }
        if (
          loseTerminalResponse &&
          events.some(
            (event) =>
              event.kind === "attempt" && event.event === "AttemptFailed" && event.workItem === 8,
          )
        ) {
          await write(node, body);
          loseTerminalResponse = false;
          throw new PlatformUnavailableError(
            { kind: "server_error", retryAfterMs: 1 },
            new Error("simulated lost accepted terminal response"),
          );
        }
        await write(node, body);
      },
    );

    try {
      await f.run().catch((error) => error);
      expect(launches).toBe(1);
      expect(f.events().some((event) => event.event === "AttemptStarted")).toBe(false);
      expect([...f.refs.keys()].filter((ref) => ref.includes("/sessions/"))).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/\/prepared$/),
          expect.stringMatching(/\/turn$/),
        ]),
      );

      controllerTransportDown = false;
      await f.run().catch((error) => error);
      expect(state.threadReads).toBe(1);
      expect(state.interrupts).toBe(1);
      expect(
        f.events().filter((event) => event.kind === "attempt" && event.event === "AttemptFailed"),
      ).toHaveLength(1);
      const nativeSettlement = f
        .events()
        .filter(
          (event) =>
            event.kind === "budget" &&
            event.event === "BudgetReconciled" &&
            event.phase === "execution" &&
            event.unit === "local_milliseconds" &&
            event.workItem === 8 &&
            event.attempt === 1,
        );
      expect(nativeSettlement).toEqual([
        expect.objectContaining({
          amount: expect.any(Number),
          usageEvidence: "conservative-reservation",
          reason: expect.stringContaining("AttemptStarted"),
        }),
      ]);
      expect(nativeSettlement[0]!.amount).toBeGreaterThan(0);

      await f.run();
      expect(state.threadReads).toBe(1);
      expect(state.interrupts).toBe(1);
      expect(launches).toBe(1);
      expect(
        f.events().filter((event) => event.kind === "attempt" && event.event === "AttemptFailed"),
      ).toHaveLength(1);
      expect(
        f
          .events()
          .filter(
            (event) =>
              event.kind === "budget" &&
              event.event === "BudgetReconciled" &&
              event.phase === "execution" &&
              event.unit === "local_milliseconds" &&
              event.workItem === 8,
          ),
      ).toHaveLength(1);
      expect(unresolvedModelInvocations(f.events())).toHaveLength(1);
      expect(f.resources.size).toBe(0);
      const ledger = new IssueAdmissionLedger(
        new GitHubControlStore({
          token: "fixture-only",
          owner: "fixture",
          repo: "provider-qualification",
        }),
      );
      const settled = await ledger.read(8);
      expect(settled?.history.at(-1)).toMatchObject({
        disposition: "released",
        evidence: {
          resourcesReleased: true,
          capacityReleased: true,
          accountingSettled: false,
          unknownModelUsageRetained: true,
        },
      });
      const historyLength = settled!.history.length;

      await f.run();
      expect(launches).toBe(1);
      expect(state.threadReads).toBe(1);
      expect(unresolvedModelInvocations(f.events())).toHaveLength(1);
      expect((await ledger.read(8))?.history).toHaveLength(historyLength);
    } finally {
      await f.dispose();
      await rm(homes, { recursive: true, force: true });
    }
  }, 30_000);

  it("continues one durable successful terminal after an accepted response is lost", async () => {
    const homes = await mkdtemp(join(tmpdir(), "factory-app-supervisor-success-"));
    const state: RecoveryState = {
      threadReads: 0,
      threadStarts: 0,
      turnStarts: 0,
      interrupts: 0,
      connections: [],
    };
    let launches = 0;
    const adapter = new CodexAppServerLocalBackend({
      authFile: join(homes, "missing-auth"),
      cancellationWaitMs: 5,
      readHostIdentity: async () => HOST,
      resolveCodexHome: (identity) =>
        join(homes, `${identity.runId}-${identity.workItem}-${identity.attempt}`),
      connect: () => new RecoveryConnection(state),
      scopeReadPort: {
        hostIdentity: async () => HOST,
        now: () => new Date(),
        read: async () => {
          throw Object.assign(new Error("fixture scope is absent"), { code: "ENOENT" });
        },
        show: async (unit) =>
          `Id=${unit}\nLoadState=not-found\nActiveState=inactive\nSubState=dead\nControlGroup=\nJob=0\n`,
      },
    });
    const f = await providerSupervisorFixture("daytona-burst", {
      localOnly: true,
      dependencyChain: true,
      maxAttemptsPerItem: 1,
      localBackendId: APP_SERVER,
      configureLocalBackend: (base) => ({
        ...base,
        capabilities: adapter.capabilities,
        launch: async (context) => {
          launches += 1;
          const handle = await adapter.launch(context);
          const connection = state.connections.at(-1)!;
          const filename =
            context.workItem === 8 ? "a.txt" : context.workItem === 9 ? "b.txt" : "join.txt";
          await writeFile(join(context.workspace, filename), `${filename.slice(0, -4)}\n`);
          const tokens = {
            inputTokens: 10,
            outputTokens: 2,
            cachedInputTokens: 3,
            cacheWriteInputTokens: 0,
            reasoningOutputTokens: 0,
            totalTokens: 12,
          };
          const item = {
            type: "agentMessage",
            id: `message-${context.workItem}`,
            text: JSON.stringify({
              outcome: "succeeded",
              summary: `completed ${filename}`,
              commands: [],
              findings: [],
            }),
          };
          const turn = {
            id: handle.metadata!.turnId,
            status: "completed",
            items: [item],
            error: null,
          };
          connection.emit("rawResponse/completed", {
            threadId: handle.resourceId,
            turnId: handle.metadata!.turnId,
            responseId: `response-${context.workItem}`,
            usage: tokens,
          });
          connection.emit("thread/tokenUsage/updated", {
            threadId: handle.resourceId,
            turnId: handle.metadata!.turnId,
            tokenUsage: { total: tokens, last: tokens },
          });
          connection.emit("item/completed", {
            threadId: handle.resourceId,
            turnId: handle.metadata!.turnId,
            item,
          });
          state.thread = { ...state.thread, turns: [turn] };
          connection.emit("turn/completed", { threadId: handle.resourceId, turn });
          return handle;
        },
        waitForTerminal: adapter.waitForTerminal.bind(adapter),
        observe: adapter.observe.bind(adapter),
        collect: adapter.collect.bind(adapter),
        cancel: adapter.cancel.bind(adapter),
        cleanup: adapter.cleanup.bind(adapter),
        resume: adapter.resume.bind(adapter),
        reconcileStale: adapter.reconcileStale.bind(adapter),
      }),
    });
    const write = vi.mocked(GitHubControlStore.prototype.addIssueComment).getMockImplementation();
    if (!write) throw new Error("fixture receipt transport missing");
    const lostResponse = new PlatformUnavailableError(
      { kind: "server_error", retryAfterMs: 1 },
      new Error("simulated lost accepted AttemptStarted response"),
    );
    let loseStartedResponse = true;
    vi.mocked(GitHubControlStore.prototype.addIssueComment).mockImplementation(
      async (node, body) => {
        const events = decodeEventComments(body);
        if (
          loseStartedResponse &&
          events.some(
            (event) =>
              event.kind === "attempt" && event.event === "AttemptStarted" && event.workItem === 8,
          )
        ) {
          await write(node, body);
          loseStartedResponse = false;
          throw lostResponse;
        }
        await write(node, body);
      },
    );

    try {
      await expect(f.run()).rejects.toBe(lostResponse);
      expect(launches).toBe(1);
      expect(
        f
          .events()
          .filter(
            (event) =>
              event.kind === "attempt" && event.event === "AttemptStarted" && event.workItem === 8,
          ),
      ).toHaveLength(1);
      expect([...f.refs.keys()]).toEqual(
        expect.arrayContaining([expect.stringMatching(/\/sessions\/.*\/terminal$/)]),
      );

      await expect(f.run()).resolves.toMatchObject({ status: "completed" });
      expect(launches).toBe(3);
      expect(state.threadStarts).toBe(3);
      expect(state.turnStarts).toBe(3);
      expect(state.threadReads).toBe(1);
      expect(state.interrupts).toBe(0);
      for (const event of [
        "AttemptSucceeded",
        "AttemptCollected",
        "ValidationRecorded",
        "AttemptIntegrated",
      ])
        expect(
          f.events().filter((candidate) => candidate.event === event && candidate.workItem === 8),
        ).toHaveLength(1);
      const exactModel = f
        .events()
        .filter(
          (event) =>
            event.kind === "budget" &&
            event.event === "BudgetReconciled" &&
            event.phase === "execution" &&
            event.unit === "model_tokens" &&
            event.workItem === 8 &&
            event.attempt === 1,
        );
      expect(exactModel).toHaveLength(1);
      expect(exactModel[0]).toMatchObject({ amount: 12 });
      expect(exactModel[0]).not.toHaveProperty("usageEvidence");
      expect(
        f
          .events()
          .filter(
            (event) =>
              event.kind === "budget" &&
              event.event === "BudgetReconciled" &&
              event.phase === "execution" &&
              event.unit === "local_milliseconds" &&
              event.workItem === 8 &&
              event.attempt === 1,
          ),
      ).toHaveLength(1);
      expect(
        f
          .events()
          .filter((event) => event.kind === "capacity" && event.workItem === 8)
          .map((event) => event.event),
      ).toEqual(["CapacityReserved", "CapacityReconciled"]);
      expect(unresolvedModelInvocations(f.events())).toEqual([]);
      expect(f.resources.size).toBe(0);
    } finally {
      await f.dispose();
      await rm(homes, { recursive: true, force: true });
    }
  }, 30_000);
});
