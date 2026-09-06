import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  CodexAppServerLocalBackend,
  codexAppServerArgs,
  codexAppServerThreadConfig,
} from "../src/backends/codex-app-server.js";
import type { AttemptContext, BackendHandle } from "../src/execution/backend.js";
import { durableAttemptId } from "../src/execution/session.js";
import {
  parseAppServerSessionCheckpoint,
  type AppServerSessionCheckpoint,
  type AppServerSessionStage,
} from "../src/execution/app-server-session.js";
import { workerPacketDigest } from "../src/protocol/worker-packet.js";
import { readLocalResourceHostIdentity } from "../src/recovery/local-resources.js";
import { LocalScopeBatchSchema } from "../src/protocol/local-scope.js";
import {
  AppServerSessionManager,
  appServerSessionRef,
} from "../src/control/app-server-sessions.js";
import type { CompiledGraphStore } from "../src/control/graphs.js";
import type { AttemptReservation } from "../src/control/attempts.js";
import type { GitCommitObject, LeaseManager, LeaseState } from "../src/control/lease.js";
import type {
  AppServerConnection,
  AppServerExit,
  AppServerNotification,
  AppServerRequest,
  AppServerRequestId,
} from "../src/runtime/codex-app-server.js";

interface FakeOptions {
  failResume?: boolean;
  resumeTurns?: unknown[];
  omitInterruptTerminal?: boolean;
  loseTurnResponse?: boolean;
  liveProducer?: boolean;
  presentScope?: boolean;
  version?: string;
}
const storedThreads = new Map<string, Record<string, unknown>>();

class FakeConnection implements AppServerConnection {
  readonly pid = null;
  readonly calls: Array<{ method: string; params: unknown }> = [];
  readonly notifications: Array<{ method: string; params: unknown }> = [];
  readonly responses: Array<{
    id: AppServerRequestId;
    result?: unknown;
    error?: { code: number; message: string };
  }> = [];
  readonly notificationListeners = new Set<(event: AppServerNotification) => void>();
  readonly requestListeners = new Set<(request: AppServerRequest) => void>();
  readonly closed: Promise<AppServerExit>;
  closedByClient = false;
  #resolveClosed!: (exit: AppServerExit) => void;

  constructor(
    readonly name: string,
    readonly options: FakeOptions = {},
  ) {
    this.closed = new Promise((resolve) => {
      this.#resolveClosed = resolve;
    });
  }

  async request<T>(method: string, params?: unknown): Promise<T> {
    this.calls.push({ method, params });
    if (method === "initialize")
      return { userAgent: `codex_cli_rs/${this.options.version ?? "0.153.0"}` } as T;
    if (method === "thread/start") {
      const input = params as { cwd: string; model?: string };
      const thread = {
        id: `thread-${this.name}`,
        sessionId: `session-${this.name}`,
        cwd: input.cwd,
        modelProvider: "openai",
        model: input.model ?? "gpt-5",
        cliVersion: "0.153.0",
        turns: [],
      };
      storedThreads.set(thread.id, thread);
      return { thread, model: thread.model, approvalPolicy: "never" } as T;
    }
    if (method === "turn/start") {
      if (this.options.loseTurnResponse) throw new Error("turn dispatch response unavailable");
      return { turn: { id: `turn-${this.name}`, status: "inProgress", items: [] } } as T;
    }
    if (method === "thread/read") {
      if (this.options.failResume) throw new Error("thread is no longer active");
      const threadId = (params as { threadId: string }).threadId;
      return {
        thread: { ...storedThreads.get(threadId), turns: this.options.resumeTurns ?? [] },
        initialTurnsPage: {
          data: this.options.resumeTurns ?? [],
          nextCursor: null,
          backwardsCursor: null,
        },
      } as T;
    }
    if (method === "turn/interrupt" && !this.options.omitInterruptTerminal) {
      const input = params as { threadId: string; turnId: string };
      this.emit("turn/completed", {
        threadId: input.threadId,
        turn: { id: input.turnId, status: "interrupted", items: [] },
      });
    }
    return {} as T;
  }

  notify(method: string, params?: unknown): void {
    this.notifications.push({ method, params });
  }

  respond(id: AppServerRequestId, result: unknown): void {
    this.responses.push({ id, result });
  }

  respondError(id: AppServerRequestId, code: number, message: string): void {
    this.responses.push({ id, error: { code, message } });
  }

  onNotification(listener: (event: AppServerNotification) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  onRequest(listener: (request: AppServerRequest) => void): () => void {
    this.requestListeners.add(listener);
    return () => this.requestListeners.delete(listener);
  }

  emit(method: string, params: unknown): void {
    for (const listener of this.notificationListeners) {
      listener({ method, params });
    }
  }

  requestFromServer(id: AppServerRequestId, method: string, params: unknown): void {
    for (const listener of this.requestListeners) {
      listener({ id, method, params });
    }
  }

  async close(): Promise<void> {
    if (this.closedByClient) return;
    this.closedByClient = true;
    this.#resolveClosed({ exitCode: 0, signal: null, stderr: "" });
  }
}

const temporaryPaths = new Set<string>();
const suiteRoot = join(tmpdir(), `factory-app-server-${process.pid}-${Date.now()}`);
temporaryPaths.add(suiteRoot);

afterAll(async () => {
  await Promise.all([...temporaryPaths].map((path) => rm(path, { recursive: true, force: true })));
});

async function context(
  number: number,
  networkDestinations: string[] = [],
): Promise<AttemptContext> {
  const workspace = await mkdtemp(join(tmpdir(), `factory-app-${number}-`));
  temporaryPaths.add(workspace);
  execFileSync("git", ["init", "-q"], { cwd: workspace });
  execFileSync("git", ["config", "user.name", "Factory Test"], {
    cwd: workspace,
  });
  execFileSync("git", ["config", "user.email", "factory@example.invalid"], {
    cwd: workspace,
  });
  await writeFile(join(workspace, "value.txt"), "base\n");
  execFileSync("git", ["add", "value.txt"], { cwd: workspace });
  execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: workspace });
  const baseSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: workspace,
    encoding: "utf8",
  }).trim();
  const value: AttemptContext = {
    repository: "clockgrove/factory",
    objective: 1,
    workItem: number,
    attempt: 1,
    runId: `run-${number}`,
    directorEpoch: 7,
    policyDigest: "f".repeat(64),
    workspace,
    deadline: new Date(Date.now() + 10_000),
    packet: {
      goal: "change value",
      acceptanceCriteria: ["changed"],
      allowedPaths: ["value.txt"],
      preconditions: [],
      outOfScope: [],
      conventions: [],
      baseSha,
      validationCommands: ["node --version"],
      artifactContract: "clockgrove.factory/artifact-v1",
      requirements: {
        os: [],
        architecture: [],
        tools: [],
        services: [],
        networkDestinations,
        permittedSecretNames: [],
        trust: "trusted_local",
      },
    },
  };
  const checkpoints = new Map<AppServerSessionStage, AppServerSessionCheckpoint>();
  value.sessionJournal = {
    async assertCurrent() {},
    async load(stage) {
      return structuredClone(checkpoints.get(stage) ?? null);
    },
    async persist(checkpoint) {
      const parsed = parseAppServerSessionCheckpoint(checkpoint);
      const prior = checkpoints.get(parsed.stage);
      if (prior && JSON.stringify(prior) !== JSON.stringify(parsed))
        throw new Error("immutable session changed");
      checkpoints.set(parsed.stage, structuredClone(parsed));
    },
  };
  const stat = await readFile("/proc/self/stat", "utf8");
  value.localExecutionScope = {
    assertCurrent: async () => {},
    batch: LocalScopeBatchSchema.parse({
      identity: {
        protocol: "clockgrove.factory/local-scope-v1",
        repository: value.repository,
        runId: value.runId,
        objective: value.objective,
        workItem: value.workItem,
        attempt: value.attempt,
        directorEpoch: value.directorEpoch,
        policyDigest: value.policyDigest,
        phase: "execution",
        commandIndex: 0,
        invocationDigest: workerPacketDigest(value.packet),
        hostIdentity: await readLocalResourceHostIdentity(),
      },
      commandCount: 1,
      producerPid: process.pid,
      producerStartTicks: stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/)[19],
      deadline: value.deadline.toISOString(),
    }),
  };
  return value;
}

function factory(
  root: string,
  connections: Map<string, FakeConnection>,
  options: FakeOptions = {},
): CodexAppServerLocalBackend {
  return new CodexAppServerLocalBackend({
    authFile: join(root, "missing-factory-auth"),
    cancellationWaitMs: 5,
    scopeReadPort: {
      hostIdentity: readLocalResourceHostIdentity,
      now: () => new Date(),
      async read(path) {
        if (options.liveProducer) return readFile(path, "utf8");
        throw Object.assign(new Error("absent"), { code: "ENOENT" });
      },
      async show(unit) {
        return options.presentScope
          ? `Id=${unit}\nLoadState=loaded\nActiveState=active\nSubState=running\nControlGroup=/owned\nJob=0\n`
          : `Id=${unit}\nLoadState=not-found\nActiveState=inactive\nSubState=dead\nControlGroup=\nJob=0\n`;
      },
    },
    resolveCodexHome: (identity) => join(root, durableAttemptId(identity)),
    connect: (home) => {
      const found = connections.get(home);
      if (found) return found;
      const connection = new FakeConnection(String(connections.size + 1), options);
      connections.set(home, connection);
      return connection;
    },
  });
}

function finish(
  connection: FakeConnection,
  handle: BackendHandle,
  final: { outcome: "succeeded" | "failed" | "declined"; summary: string },
): void {
  const workerFinal = { ...final, commands: [] };
  const tokens = {
    inputTokens: 10,
    outputTokens: 2,
    cachedInputTokens: 3,
    cacheWriteInputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 12,
  };
  connection.emit("rawResponse/completed", {
    threadId: handle.resourceId,
    turnId: handle.metadata!.turnId,
    responseId: "response-1",
    usage: tokens,
  });
  connection.emit("thread/tokenUsage/updated", {
    threadId: handle.resourceId,
    turnId: handle.metadata!.turnId,
    tokenUsage: { total: tokens, last: tokens },
  });
  const item = {
    type: "agentMessage",
    id: "message-1",
    text: JSON.stringify(workerFinal),
  };
  connection.emit("item/completed", {
    threadId: handle.resourceId,
    turnId: handle.metadata!.turnId,
    item,
  });
  connection.emit("turn/completed", {
    threadId: handle.resourceId,
    turn: {
      id: handle.metadata!.turnId,
      status: "completed",
      items: [item],
      error: null,
    },
  });
}

async function waitForState(
  backend: CodexAppServerLocalBackend,
  handle: BackendHandle,
  state: string,
): Promise<void> {
  for (let check = 0; check < 100; check += 1) {
    if ((await backend.observe(handle)).state === state) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  expect((await backend.observe(handle)).state).toBe(state);
}

describe("Codex App Server local backend", () => {
  it("advertises supported durable local execution without promoting the default route", () => {
    expect(new CodexAppServerLocalBackend().capabilities.supportedOs).toEqual(["linux"]);
    expect(new CodexAppServerLocalBackend().capabilities.supportTier).toBe("supported");
  });

  it("performs the negotiated handshake and applies the CLI-equivalent security boundary", async () => {
    const root = join(suiteRoot, "boundary");
    const connections = new Map<string, FakeConnection>();
    const backend = factory(root, connections);
    const ctx = await context(1, ["registry.npmjs.org", "*.example.com"]);
    ctx.modelSelection = {
      profile: "frontier",
      model: "gpt-5",
      reasoning: "high",
    };
    await writeFile(join(ctx.workspace, "AGENTS.md"), "Use tabs for fixtures.\n");
    const handle = await backend.launch(ctx);
    const connection = connections.get(handle.metadata!.codexHome!)!;

    expect(connection.calls[0]).toMatchObject({
      method: "initialize",
      params: {
        clientInfo: {
          name: "clockgrove-factory",
          title: "Clockgrove Factory",
          version: "2",
        },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
        },
      },
    });
    expect(connection.notifications).toContainEqual({
      method: "initialized",
      params: undefined,
    });
    const thread = connection.calls.find((call) => call.method === "thread/start");
    expect(thread?.params).toMatchObject({
      cwd: ctx.workspace,
      runtimeWorkspaceRoots: [ctx.workspace],
      approvalPolicy: "never",
      sandbox: "workspace-write",
      ephemeral: false,
      model: "gpt-5",
      developerInstructions: expect.stringMatching(
        /Use tabs for fixtures[\s\S]+Factory execution boundary/,
      ),
      config: {
        web_search: "disabled",
        model_reasoning_effort: "high",
        sandbox_workspace_write: { network_access: true },
        features: {
          network_proxy: {
            enabled: true,
            domains: {
              "*.example.com": "allow",
              "registry.npmjs.org": "allow",
            },
          },
        },
        projects: {
          [ctx.workspace]: { trust_level: "untrusted" },
        },
      },
    });
    const turn = connection.calls.find((call) => call.method === "turn/start");
    expect(turn?.params).toMatchObject({
      threadId: handle.resourceId,
      input: [{ type: "text", text_elements: [] }],
      outputSchema: { type: "object" },
    });
    expect(codexAppServerThreadConfig([])).toEqual({
      web_search: "disabled",
      sandbox_workspace_write: { network_access: false },
    });
    expect(() => codexAppServerThreadConfig(["https://example.com/path"])).toThrow(
      "invalid Codex command-network destination",
    );
    expect(codexAppServerArgs("/tmp/factory-codex", "local")).toEqual([
      "-c",
      'sqlite_home="/tmp/factory-codex"',
      "--profile",
      "local",
      "app-server",
      "--stdio",
    ]);

    await backend.cancel(handle);
    await backend.cleanup(handle);
  });

  it("isolates concurrent thread identities, homes, progress, worktrees, and artifacts", async () => {
    const root = join(suiteRoot, "concurrent");
    const connections = new Map<string, FakeConnection>();
    const backend = factory(root, connections);
    const [a, b] = await Promise.all([context(2), context(3)]);
    const [ha, hb] = await Promise.all([backend.launch(a), backend.launch(b)]);
    expect(ha.resourceId).not.toBe(hb.resourceId);
    expect(ha.metadata?.codexHome).not.toBe(hb.metadata?.codexHome);
    expect(ha.metadata?.workspace).toBe(a.workspace);
    expect(hb.metadata?.workspace).toBe(b.workspace);
    const ca = connections.get(ha.metadata!.codexHome!)!;
    const cb = connections.get(hb.metadata!.codexHome!)!;
    ca.emit("turn/progress", {
      threadId: ha.resourceId,
      turnId: ha.metadata!.turnId,
      message: "alpha",
    });
    cb.emit("turn/progress", {
      threadId: hb.resourceId,
      turnId: hb.metadata!.turnId,
      message: "beta",
    });
    expect((await backend.observe(ha)).progress).toBe("alpha");
    expect((await backend.observe(hb)).progress).toBe("beta");
    await Promise.all([
      writeFile(join(a.workspace, "value.txt"), "alpha\n"),
      writeFile(join(b.workspace, "value.txt"), "beta\n"),
    ]);
    finish(ca, ha, { outcome: "succeeded", summary: "alpha done" });
    finish(cb, hb, { outcome: "succeeded", summary: "beta done" });
    const [aa, ab] = await Promise.all([backend.collect(ha), backend.collect(hb)]);
    expect(aa.patch).toContain("alpha");
    expect(ab.patch).toContain("beta");
    await Promise.all([backend.cleanup(ha), backend.cleanup(hb)]);
  });

  it("resumes the fenced durable turn after an adapter restart without launching duplicate work", async () => {
    const root = join(suiteRoot, "resume");
    const firstConnections = new Map<string, FakeConnection>();
    const first = factory(root, firstConnections);
    const ctx = await context(4);
    const handle = await first.launch(ctx);

    const turn = {
      id: handle.metadata!.turnId,
      status: "completed",
      items: [
        {
          type: "agentMessage",
          text: JSON.stringify({ outcome: "succeeded", summary: "resumed", commands: [] }),
        },
      ],
      error: null,
    };
    await writeFile(join(ctx.workspace, "value.txt"), "resumed\n");
    finish(firstConnections.get(handle.metadata!.codexHome!)!, handle, {
      outcome: "succeeded",
      summary: "resumed",
    });
    await first.observe(handle);
    await first.cleanup(handle);
    const resumedConnections = new Map<string, FakeConnection>();
    // The same parent controller can stay alive after this exact invocation drains.
    const second = factory(root, resumedConnections, { resumeTurns: [turn], liveProducer: true });
    const resumed = await second.resume(ctx, structuredClone(handle));
    expect(await second.observe(resumed)).toMatchObject({
      state: "succeeded",
      usage: { inputTokens: 10, outputTokens: 2, cachedInputTokens: 3 },
    });
    const connection = resumedConnections.get(resumed.metadata!.codexHome!)!;
    expect(connection.calls.filter((call) => call.method === "thread/read")).toHaveLength(1);
    expect(connection.calls.some((call) => call.method === "thread/resume")).toBe(false);
    expect(connection.calls.some((call) => call.method === "thread/start")).toBe(false);
    expect(connection.calls.some((call) => call.method === "turn/start")).toBe(false);

    expect((await second.observe(resumed)).state).toBe("succeeded");
    expect((await second.collect(resumed)).patch).toContain("resumed");
    await second.cleanup(resumed);
  });

  it("terminates only the owned session and records a durable cancellation", async () => {
    const root = join(suiteRoot, "cancel");
    const connections = new Map<string, FakeConnection>();
    const backend = factory(root, connections);
    const ctx = await context(5);
    const handle = await backend.launch(ctx);
    const connection = connections.get(handle.metadata!.codexHome!)!;
    await backend.cancel(handle);
    expect(connection.calls.filter((call) => call.method === "turn/interrupt")).toHaveLength(1);
    expect(connection.closedByClient).toBe(true);
    expect(await backend.observe(handle)).toMatchObject({ state: "cancelled" });
    expect(handle.metadata).toMatchObject({
      attemptId: durableAttemptId(ctx),
      terminalState: "cancelled",
      terminalReason: expect.stringContaining("cancelled"),
    });
    await backend.cleanup(handle);
  });

  it("does not invent terminal cancellation or usage from a successful interrupt request", async () => {
    const root = join(suiteRoot, "interrupt-unknown"),
      connections = new Map<string, FakeConnection>();
    const backend = factory(root, connections, { omitInterruptTerminal: true });
    const ctx = await context(101),
      handle = await backend.launch(ctx);
    await backend.cancel(handle);
    expect(await backend.observe(handle)).toMatchObject({
      state: "unknown",
      usage: { inputTokens: null, outputTokens: null },
    });
    expect(await ctx.sessionJournal!.load("terminal")).toBeNull();
    expect(
      connections
        .get(handle.metadata!.codexHome!)!
        .calls.filter((call) => call.method === "turn/interrupt"),
    ).toHaveLength(1);
    await backend.cleanup(handle);
    await expect(access(handle.metadata!.codexHome!)).resolves.toBeUndefined();
  });

  it("retains a lost turn-start intent and never automatically sends a second turn", async () => {
    const root = join(suiteRoot, "lost-dispatch"),
      connections = new Map<string, FakeConnection>();
    const backend = factory(root, connections, { loseTurnResponse: true });
    const ctx = await context(102);
    await expect(backend.launch(ctx)).rejects.toThrow("dispatch response");
    expect(await ctx.sessionJournal!.load("prepared")).not.toBeNull();
    expect(await ctx.sessionJournal!.load("turn")).toBeNull();
    await expect(backend.launch(ctx)).rejects.toThrow("durable intent");
    expect(
      [...connections.values()]
        .flatMap((connection) => connection.calls)
        .filter((call) => call.method === "turn/start"),
    ).toHaveLength(1);
    expect([...connections.values()].every((connection) => connection.closedByClient)).toBe(true);
  });

  it("refuses unsupported versions and missing journals before any model turn", async () => {
    const root = join(suiteRoot, "unsupported"),
      connections = new Map<string, FakeConnection>();
    const backend = factory(root, connections, { version: "0.152.0" });
    const ctx = await context(103);
    await expect(backend.launch(ctx)).rejects.toThrow(/0\.153\.0|protocol|version/i);
    expect(
      [...connections.values()]
        .flatMap((connection) => connection.calls)
        .some((call) => call.method === "turn/start"),
    ).toBe(false);
    const { sessionJournal: _journal, ...withoutJournal } = ctx;
    await expect(backend.launch(withoutJournal)).rejects.toThrow("journal");
  });

  it("does not treat an absent scope as permission to recover an ambiguous live producer", async () => {
    const root = join(suiteRoot, "ambiguous-producer"),
      firstConnections = new Map<string, FakeConnection>();
    const first = factory(root, firstConnections, { omitInterruptTerminal: true });
    const ctx = await context(104),
      handle = await first.launch(ctx);
    await first.cancel(handle);
    await first.cleanup(handle);
    const connections = new Map<string, FakeConnection>();
    const recovered = factory(root, connections, { liveProducer: true });
    await expect(recovered.resume(ctx, handle)).rejects.toThrow("not independently absent");
    expect(connections.size).toBe(0);
  });

  it("requires exact resource absence even when immutable terminal usage exists", async () => {
    const root = join(suiteRoot, "terminal-live-scope"),
      firstConnections = new Map<string, FakeConnection>();
    const first = factory(root, firstConnections);
    const ctx = await context(105),
      handle = await first.launch(ctx);
    finish(firstConnections.get(handle.metadata!.codexHome!)!, handle, {
      outcome: "succeeded",
      summary: "done",
    });
    await first.observe(handle);
    await first.cleanup(handle);
    const connections = new Map<string, FakeConnection>();
    await expect(
      factory(root, connections, { presentScope: true }).resume(ctx, handle),
    ).rejects.toThrow("not independently absent");
    expect(connections.size).toBe(0);
  });

  it("refuses cold same-thread repair before a new model invocation instead of dropping accounting", async () => {
    const root = join(suiteRoot, "cold-repair"),
      connections = new Map<string, FakeConnection>();
    const first = factory(root, connections),
      ctx = await context(107),
      handle = await first.launch(ctx);
    finish(connections.get(handle.metadata!.codexHome!)!, handle, {
      outcome: "succeeded",
      summary: "first",
    });
    await first.observe(handle);
    await first.cleanup(handle);
    const terminal = (await ctx.sessionJournal!.load("terminal"))!;
    const next: AttemptContext = {
      ...ctx,
      attempt: 2,
      sessionJournal: {
        ...ctx.sessionJournal!,
        previous: terminal,
        async load() {
          return null;
        },
      },
      localExecutionScope: {
        ...ctx.localExecutionScope!,
        batch: {
          ...ctx.localExecutionScope!.batch,
          identity: { ...ctx.localExecutionScope!.batch.identity, attempt: 2 },
        },
      },
    };
    const nextConnections = new Map<string, FakeConnection>();
    await expect(factory(root, nextConnections).launch(next)).rejects.toThrow(
      "cold same-thread repair is unavailable",
    );
    expect(nextConnections.size).toBe(0);
  });

  it("rejects transplanted terminal turn identity without recollection or dispatch", async () => {
    const root = join(suiteRoot, "wrong-terminal"),
      connections = new Map<string, FakeConnection>();
    const first = factory(root, connections),
      ctx = await context(108),
      handle = await first.launch(ctx);
    finish(connections.get(handle.metadata!.codexHome!)!, handle, {
      outcome: "succeeded",
      summary: "original",
    });
    await first.observe(handle);
    await first.cleanup(handle);
    const nextConnections = new Map<string, FakeConnection>();
    await expect(
      factory(root, nextConnections, {
        resumeTurns: [{ id: "wrong-turn", status: "completed", items: [] }],
      }).resume(ctx, handle),
    ).rejects.toThrow("immutable dispatch");
    expect(
      [...nextConnections.values()]
        .flatMap((connection) => connection.calls)
        .map((call) => call.method),
    ).toEqual(["initialize", "thread/read"]);
    expect([...nextConnections.values()].every((connection) => connection.closedByClient)).toBe(
      true,
    );
  });

  it("persists exact immutable session stages with fencing, response-loss repair and no rebinding", async () => {
    const connections = new Map<string, FakeConnection>(),
      backend = factory(join(suiteRoot, "journal"), connections);
    const ctx = await context(106),
      handle = await backend.launch(ctx);
    finish(connections.get(handle.metadata!.codexHome!)!, handle, {
      outcome: "succeeded",
      summary: "journal",
    });
    await backend.observe(handle);
    await backend.cleanup(handle);
    const prepared = (await ctx.sessionJournal!.load("prepared"))!,
      turn = (await ctx.sessionJournal!.load("turn"))!,
      terminal = (await ctx.sessionJournal!.load("terminal"))!;
    const refs = new Map<string, string>(),
      blobs = new Map<string, Buffer>(),
      trees = new Map<string, Map<string, string>>(),
      commits = new Map<string, GitCommitObject>();
    let writes = 0,
      loseRefResponse = false,
      current = true,
      fenced = false;
    const beforeWrite = () => {
      expect(fenced).toBe(true);
      fenced = false;
      writes++;
    };
    const objectId = (kind: string, bytes: Buffer) =>
      createHash("sha1").update(`${kind} ${bytes.length}\0`).update(bytes).digest("hex");
    const store: CompiledGraphStore = {
      async readRef(ref) {
        return refs.get(ref) ?? null;
      },
      async readCommit(oid) {
        const value = commits.get(oid);
        if (!value) throw new Error("missing commit");
        return structuredClone(value);
      },
      async readBlob(oid) {
        const value = blobs.get(oid);
        if (!value) throw new Error("missing blob");
        return Buffer.from(value);
      },
      async readTreeEntry(tree, path) {
        return trees.get(tree)?.get(path) ?? null;
      },
      async createBlob(bytes) {
        beforeWrite();
        const oid = objectId("blob", bytes);
        blobs.set(oid, Buffer.from(bytes));
        return oid;
      },
      async createTree(args) {
        beforeWrite();
        const oid = objectId("tree", Buffer.from(JSON.stringify(args)));
        trees.set(
          oid,
          new Map(
            args.entries.filter((entry) => entry.sha).map((entry) => [entry.path, entry.sha!]),
          ),
        );
        return oid;
      },
      async createCommit(args) {
        beforeWrite();
        const oid = objectId("commit", Buffer.from(JSON.stringify(args)));
        commits.set(oid, { ...args, oid, serverTime: new Date() });
        return oid;
      },
      async createRef(ref, oid) {
        beforeWrite();
        if (refs.has(ref)) return false;
        refs.set(ref, oid);
        if (loseRefResponse) {
          loseRefResponse = false;
          throw new Error("lost ref response");
        }
        return true;
      },
    };
    const leases = {
      async assertCurrent() {
        if (!current) throw new Error("lease lost");
        fenced = true;
      },
    } as unknown as LeaseManager;
    const manager = new AppServerSessionManager(store, leases);
    const reservation: AttemptReservation = {
      ref: "refs/attempt",
      oid: "a".repeat(40),
      objective: ctx.objective,
      workItem: ctx.workItem,
      attempt: ctx.attempt,
      backend: handle.backendId,
      baseSha: ctx.packet.baseSha,
      runId: ctx.runId,
      directorEpoch: ctx.directorEpoch,
      policyDigest: ctx.policyDigest,
      sequence: 2,
      createdAt: new Date(),
      localScopeBatch: ctx.localExecutionScope!.batch,
    };
    const lease: LeaseState = {
      ref: "refs/lease",
      oid: "b".repeat(40),
      treeOid: "c".repeat(40),
      objective: ctx.objective,
      runId: ctx.runId,
      holder: "controller",
      policyDigest: ctx.policyDigest,
      epoch: ctx.directorEpoch + 1,
      sequence: 3,
      expiresAt: ctx.deadline,
    };
    const persist = (checkpoint: AppServerSessionCheckpoint) =>
      manager.persist({ repository: ctx.repository, reservation, lease, checkpoint });
    await expect(persist(terminal)).rejects.toThrow("prepared");
    expect(writes).toBe(0);
    loseRefResponse = true;
    await persist(prepared);
    await persist(turn);
    await persist(terminal);
    expect(await manager.load(ctx.repository, reservation, "terminal")).toEqual(terminal);
    const beforeReplay = writes;
    await persist(terminal);
    expect(writes).toBe(beforeReplay);
    await expect(persist({ ...terminal, turnId: "other-turn" })).rejects.toThrow("conflicting");
    await expect(
      manager.load(ctx.repository, { ...reservation, policyDigest: "0".repeat(64) }, "terminal"),
    ).rejects.toThrow("reservation");
    const turnRef = appServerSessionRef(ctx.repository, reservation, "turn"),
      turnOid = refs.get(turnRef)!;
    refs.delete(turnRef);
    await expect(manager.load(ctx.repository, reservation, "terminal")).rejects.toThrow("dispatch");
    refs.set(turnRef, turnOid);
    current = false;
    await expect(persist(terminal)).rejects.toThrow("lease lost");
    expect(writes).toBe(beforeReplay);
    const terminalOid = refs.get(appServerSessionRef(ctx.repository, reservation, "terminal"))!;
    const terminalTree = commits.get(terminalOid)!.treeOid,
      blob = [...trees.get(terminalTree)!.values()][0]!;
    blobs.set(blob, Buffer.from("{}"));
    await expect(manager.load(ctx.repository, reservation, "terminal")).rejects.toThrow(
      "blob is invalid",
    );
  });

  it("responds to unattended approvals immediately and cannot leave the attempt hanging", async () => {
    const root = join(suiteRoot, "approval");
    const connections = new Map<string, FakeConnection>();
    const backend = factory(root, connections);
    const ctx = await context(6);
    const handle = await backend.launch(ctx);
    const connection = connections.get(handle.metadata!.codexHome!)!;
    connection.requestFromServer("approval-1", "item/commandExecution/requestApproval", {
      threadId: handle.resourceId,
      turnId: handle.metadata!.turnId,
    });
    expect(connection.responses).toContainEqual({
      id: "approval-1",
      result: { decision: "decline" },
    });
    await waitForState(backend, handle, "failed");
    expect(await backend.observe(handle)).toMatchObject({
      state: "failed",
      reason: expect.stringContaining("request was denied"),
    });
    expect(connection.closedByClient).toBe(true);
    await backend.cleanup(handle);
  });

  it("normalizes the App Server token-usage notification conservatively", async () => {
    const root = join(suiteRoot, "usage");
    const connections = new Map<string, FakeConnection>();
    const backend = factory(root, connections);
    const ctx = await context(7);
    const handle = await backend.launch(ctx);
    const connection = connections.get(handle.metadata!.codexHome!)!;
    connection.emit("thread/tokenUsage/updated", {
      threadId: handle.resourceId,
      turnId: handle.metadata!.turnId,
      tokenUsage: {
        total: {},
        last: { inputTokens: 12.9, outputTokens: 4, cachedInputTokens: 3 },
        modelContextWindow: 128_000,
      },
    });
    expect((await backend.observe(handle)).usage).toEqual({
      inputTokens: null,
      outputTokens: null,
      cachedInputTokens: null,
    });
    finish(connection, handle, { outcome: "failed", summary: "done" });
    await backend.cleanup(handle);
  });

  it.skipIf(process.platform !== "linux")(
    "refuses stale marker-only cleanup without an exact reserved scope and leaves both repositories untouched",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "factory-app-repo-scope-"));
      const attemptA = {
        repository: "clockgrove/repo-a",
        objective: 1,
        workItem: 2,
        attempt: 1,
        runId: "same-run",
        directorEpoch: 7,
      };
      const attemptB = { ...attemptA, repository: "clockgrove/repo-b" };
      let workerA: ChildProcess | undefined;
      let workerB: ChildProcess | undefined;
      try {
        workerA = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
          detached: true,
          env: { ...process.env, FACTORY_ATTEMPT_ID: durableAttemptId(attemptA) },
          stdio: "ignore",
        });
        workerB = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
          detached: true,
          env: { ...process.env, FACTORY_ATTEMPT_ID: durableAttemptId(attemptB) },
          stdio: "ignore",
        });
        if (!workerA.pid || !workerB.pid) {
          throw new Error("repository-scoped App Server fixtures did not start");
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 50));
        const backend = new CodexAppServerLocalBackend({
          resolveCodexHome: (identity) => join(root, `home-${durableAttemptId(identity)}`),
        });
        await expect(backend.reconcileStale(attemptA)).rejects.toThrow("exact durable scope");
        expect(() => process.kill(-workerA!.pid!, 0)).not.toThrow();
        expect(() => process.kill(-workerB!.pid!, 0)).not.toThrow();
      } finally {
        for (const worker of [workerA, workerB]) {
          if (!worker?.pid) continue;
          try {
            process.kill(-worker.pid, "SIGKILL");
          } catch {
            // A process group already fenced by the test is absent.
          }
        }
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform !== "linux")(
    "reconciles a stale process by durable attempt identity without launching duplicate work",
    async () => {
      const root = join(suiteRoot, "stale-process");
      await mkdir(root, { recursive: true });
      const stub = join(root, "app-server.cjs");
      await writeFile(
        stub,
        [
          "const readline = require('node:readline');",
          "const send = (value) => process.stdout.write(JSON.stringify({jsonrpc:'2.0', ...value}) + '\\n');",
          "readline.createInterface({input: process.stdin}).on('line', (line) => {",
          "  const message = JSON.parse(line);",
          "  if (message.method === 'initialize') send({id:message.id,result:{userAgent:'codex_cli_rs/0.153.0'}});",
          "  else if (message.method === 'thread/start') send({id:message.id,result:{approvalPolicy:'never',model:'gpt-5',thread:{id:'thread-stale',sessionId:'session-stale',cwd:message.params.cwd,model:'gpt-5',modelProvider:'openai',cliVersion:'0.153.0',turns:[]}}});",
          "  else if (message.method === 'turn/start') send({id:message.id,result:{turn:{id:'turn-stale',status:'inProgress',items:[]}}});",
          "});",
        ].join("\n"),
      );
      const options = {
        command: process.execPath,
        args: [stub],
        cancellationWaitMs: 50,
        authFile: join(root, "missing-auth"),
        resolveCodexHome: (identity: {
          repository: string;
          runId: string;
          objective: number;
          workItem: number;
          attempt: number;
          directorEpoch: number;
        }) => join(root, `home-${durableAttemptId(identity)}`),
      };
      const original = new CodexAppServerLocalBackend(options);
      const ctx = await context(9);
      const handle = await original.launch(ctx);
      const home = handle.metadata!.codexHome!;
      const pid = Number(handle.metadata!.pid);
      expect(pid).toBeGreaterThan(1);

      const replacement = new CodexAppServerLocalBackend(options);
      await replacement.reconcileStale({
        repository: ctx.repository,
        objective: ctx.objective,
        workItem: ctx.workItem,
        attempt: ctx.attempt,
        runId: ctx.runId,
        directorEpoch: ctx.directorEpoch,
        providerResourceId: handle.resourceId,
        localScopeBatch: ctx.localExecutionScope!.batch,
        policyDigest: ctx.policyDigest,
      });

      await expect(access(home)).resolves.toBeUndefined();
      for (let check = 0; check < 100; check += 1) {
        try {
          process.kill(pid, 0);
          await new Promise((resolveWait) => setTimeout(resolveWait, 10));
        } catch {
          break;
        }
      }
      expect(() => process.kill(pid, 0)).toThrow();
      await waitForState(original, handle, "unknown");
      await original.cleanup(handle);
    },
  );

  it("completes the real JSON-RPC approval round trip without blocking", async () => {
    const root = join(suiteRoot, "json-rpc");
    await mkdir(root, { recursive: true });
    const approvalRecord = join(root, "approval-response.json");
    const stub = join(root, "app-server.cjs");
    await writeFile(
      stub,
      [
        "const fs = require('node:fs');",
        "const readline = require('node:readline');",
        `const record = ${JSON.stringify(approvalRecord)};`,
        "const send = (value) => process.stdout.write(JSON.stringify({jsonrpc:'2.0', ...value}) + '\\n');",
        "const lines = readline.createInterface({input: process.stdin});",
        "lines.on('line', (line) => {",
        "  const message = JSON.parse(line);",
        "  if (message.method === 'initialize') send({id: message.id, result: {userAgent:'codex_cli_rs/0.153.0'}});",
        "  else if (message.method === 'thread/start') send({id: message.id, result: {approvalPolicy:'never',model:'gpt-5',thread:{id:'thread-real',sessionId:'session-real',cwd:message.params.cwd,model:'gpt-5',modelProvider:'openai',cliVersion:'0.153.0',turns:[]}}});",
        "  else if (message.method === 'turn/start') {",
        "    send({id: message.id, result: {turn:{id:'turn-real', status:'inProgress', items:[]}}});",
        "    send({id:'approval-real', method:'item/commandExecution/requestApproval', params:{threadId:'thread-real', turnId:'turn-real'}});",
        "  } else if (message.id === 'approval-real') fs.writeFileSync(record, JSON.stringify(message.result));",
        "  else if (message.method === 'turn/interrupt') {",
        "    send({id: message.id, result: {}});",
        "    send({method:'turn/completed', params:{threadId:'thread-real', turn:{id:'turn-real', status:'interrupted', items:[], error:null}}});",
        "  }",
        "});",
      ].join("\n"),
    );
    const backend = new CodexAppServerLocalBackend({
      command: process.execPath,
      args: [stub],
      cancellationWaitMs: 100,
      authFile: join(root, "missing-auth"),
      resolveCodexHome: (identity) => join(root, `home-${durableAttemptId(identity)}`),
    });
    const ctx = await context(8);
    const handle = await backend.launch(ctx);
    await waitForState(backend, handle, "failed");
    expect(JSON.parse(await readFile(approvalRecord, "utf8"))).toEqual({
      decision: "decline",
    });
    expect(await backend.observe(handle)).toMatchObject({
      state: "failed",
      reason: expect.stringContaining("request was denied"),
    });
    await backend.cleanup(handle);
  });
});
