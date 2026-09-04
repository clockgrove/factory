import { execFileSync } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  CodexAppServerLocalBackend,
  codexAppServerArgs,
  codexAppServerThreadConfig,
} from "../src/backends/codex-app-server.js";
import type {
  AttemptContext,
  BackendHandle,
} from "../src/execution/backend.js";
import { durableAttemptId } from "../src/execution/session.js";
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
}

class FakeConnection implements AppServerConnection {
  readonly pid = null;
  readonly calls: Array<{ method: string; params: unknown }> = [];
  readonly notifications: Array<{ method: string; params: unknown }> = [];
  readonly responses: Array<{
    id: AppServerRequestId;
    result?: unknown;
    error?: { code: number; message: string };
  }> = [];
  readonly notificationListeners = new Set<
    (event: AppServerNotification) => void
  >();
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
    if (method === "thread/start") {
      return { thread: { id: `thread-${this.name}` } } as T;
    }
    if (method === "turn/start") {
      return { turn: { id: `turn-${this.name}` } } as T;
    }
    if (method === "thread/resume") {
      if (this.options.failResume)
        throw new Error("thread is no longer active");
      const threadId = (params as { threadId: string }).threadId;
      return {
        thread: { id: threadId, turns: this.options.resumeTurns ?? [] },
        initialTurnsPage: {
          data: this.options.resumeTurns ?? [],
          nextCursor: null,
          backwardsCursor: null,
        },
      } as T;
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

  requestFromServer(
    id: AppServerRequestId,
    method: string,
    params: unknown,
  ): void {
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
const suiteRoot = join(
  tmpdir(),
  `factory-app-server-${process.pid}-${Date.now()}`,
);
temporaryPaths.add(suiteRoot);

afterAll(async () => {
  await Promise.all(
    [...temporaryPaths].map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
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
  return {
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
      validationCommands: [],
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
}

function factory(
  root: string,
  connections: Map<string, FakeConnection>,
  options: FakeOptions = {},
): CodexAppServerLocalBackend {
  return new CodexAppServerLocalBackend({
    authFile: join(root, "missing-factory-auth"),
    cancellationWaitMs: 5,
    resolveCodexHome: (identity) => join(root, durableAttemptId(identity)),
    connect: (home) => {
      const found = connections.get(home);
      if (found) return found;
      const connection = new FakeConnection(
        String(connections.size + 1),
        options,
      );
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
  it("performs the negotiated handshake and applies the CLI-equivalent security boundary", async () => {
    const root = join(suiteRoot, "boundary");
    const connections = new Map<string, FakeConnection>();
    const backend = factory(root, connections);
    const ctx = await context(1, ["registry.npmjs.org", "*.example.com"]);
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
    const thread = connection.calls.find(
      (call) => call.method === "thread/start",
    );
    expect(thread?.params).toMatchObject({
      cwd: ctx.workspace,
      runtimeWorkspaceRoots: [ctx.workspace],
      approvalPolicy: "never",
      sandbox: "workspace-write",
      ephemeral: false,
      developerInstructions: expect.stringMatching(
        /Use tabs for fixtures[\s\S]+Factory execution boundary/,
      ),
      config: {
        web_search: "disabled",
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
    expect(() =>
      codexAppServerThreadConfig(["https://example.com/path"]),
    ).toThrow("invalid Codex command-network destination");
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
    const [aa, ab] = await Promise.all([
      backend.collect(ha),
      backend.collect(hb),
    ]);
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
      status: "inProgress",
      items: [],
      error: null,
    };
    const resumedConnections = new Map<string, FakeConnection>();
    const second = factory(root, resumedConnections, { resumeTurns: [turn] });
    const resumed = await second.resume(ctx, structuredClone(handle));
    expect(await second.observe(resumed)).toMatchObject({ state: "running" });
    const connection = resumedConnections.get(resumed.metadata!.codexHome!)!;
    expect(
      connection.calls.filter((call) => call.method === "thread/resume"),
    ).toHaveLength(1);
    expect(
      connection.calls.some((call) => call.method === "thread/start"),
    ).toBe(false);
    expect(connection.calls.some((call) => call.method === "turn/start")).toBe(
      false,
    );

    await writeFile(join(ctx.workspace, "value.txt"), "resumed\n");
    finish(connection, resumed, { outcome: "succeeded", summary: "resumed" });
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
    expect(
      connection.calls.filter((call) => call.method === "turn/interrupt"),
    ).toHaveLength(1);
    expect(connection.closedByClient).toBe(true);
    expect(await backend.observe(handle)).toMatchObject({ state: "cancelled" });
    expect(handle.metadata).toMatchObject({
      attemptId: durableAttemptId(ctx),
      terminalState: "cancelled",
      terminalReason: expect.stringContaining("cancelled"),
    });
    await backend.cleanup(handle);
  });

  it("responds to unattended approvals immediately and cannot leave the attempt hanging", async () => {
    const root = join(suiteRoot, "approval");
    const connections = new Map<string, FakeConnection>();
    const backend = factory(root, connections);
    const ctx = await context(6);
    const handle = await backend.launch(ctx);
    const connection = connections.get(handle.metadata!.codexHome!)!;
    connection.requestFromServer(
      "approval-1",
      "item/commandExecution/requestApproval",
      { threadId: handle.resourceId, turnId: handle.metadata!.turnId },
    );
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
      inputTokens: 12,
      outputTokens: 4,
      cachedInputTokens: 3,
    });
    finish(connection, handle, { outcome: "failed", summary: "done" });
    await backend.cleanup(handle);
  });

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
          "  if (message.method === 'initialize') send({id:message.id,result:{userAgent:'stub'}});",
          "  else if (message.method === 'thread/start') send({id:message.id,result:{thread:{id:'thread-stale'}}});",
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
        objective: ctx.objective,
        workItem: ctx.workItem,
        attempt: ctx.attempt,
        runId: ctx.runId,
        directorEpoch: ctx.directorEpoch,
        providerResourceId: handle.resourceId,
      });

      await expect(access(home)).rejects.toThrow();
      for (let check = 0; check < 100; check += 1) {
        try {
          process.kill(pid, 0);
          await new Promise((resolveWait) => setTimeout(resolveWait, 10));
        } catch {
          break;
        }
      }
      expect(() => process.kill(pid, 0)).toThrow();
      await waitForState(original, handle, "failed");
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
        "  if (message.method === 'initialize') send({id: message.id, result: {userAgent:'stub'}});",
        "  else if (message.method === 'thread/start') send({id: message.id, result: {thread:{id:'thread-real'}}});",
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
      resolveCodexHome: (identity) =>
        join(root, `home-${durableAttemptId(identity)}`),
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
