import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { CodexAppServerLocalBackend } from "../src/backends/codex-app-server.js";
import { CodexCliLocalBackend } from "../src/backends/codex-cli-local.js";
import type { AttemptContext, BackendHandle, ExecutionBackend } from "../src/execution/backend.js";
import { durableAttemptId, normalizeExecutionUsage } from "../src/execution/session.js";
import type {
  AppServerConnection,
  AppServerExit,
  AppServerNotification,
  AppServerRequest,
  AppServerRequestId,
} from "../src/runtime/codex-app-server.js";

class ConformanceConnection implements AppServerConnection {
  readonly pid = null;
  readonly closed: Promise<AppServerExit>;
  readonly notificationListeners = new Set<(event: AppServerNotification) => void>();
  readonly requestListeners = new Set<(request: AppServerRequest) => void>();
  #resolveClosed!: (exit: AppServerExit) => void;
  #number = 0;

  constructor(readonly threadId: string) {
    this.closed = new Promise((resolve) => {
      this.#resolveClosed = resolve;
    });
  }

  async request<T>(method: string): Promise<T> {
    if (method === "thread/start") {
      return { thread: { id: this.threadId } } as T;
    }
    if (method === "turn/start") {
      return { turn: { id: `turn-${++this.#number}` } } as T;
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
    for (const listener of this.notificationListeners) {
      listener({ method, params });
    }
  }

  async close(): Promise<void> {
    this.#resolveClosed({ exitCode: 0, signal: null, stderr: "" });
  }
}

interface BackendHarness {
  backend: ExecutionBackend;
  context: AttemptContext;
  complete(handle: BackendHandle): Promise<void>;
}

const cleanupPaths = new Set<string>();

afterAll(async () => {
  await Promise.all([...cleanupPaths].map((path) => rm(path, { recursive: true, force: true })));
});

async function repositoryFixture(name: string): Promise<{
  root: string;
  repository: string;
  baseSha: string;
  authFile: string;
}> {
  const root = await mkdtemp(join(tmpdir(), `factory-${name}-`));
  cleanupPaths.add(root);
  const repository = join(root, "repository");
  await mkdir(repository);
  execFileSync("git", ["init", "-q"], { cwd: repository });
  execFileSync("git", ["config", "user.name", "Factory Test"], {
    cwd: repository,
  });
  execFileSync("git", ["config", "user.email", "factory@example.invalid"], {
    cwd: repository,
  });
  await writeFile(join(repository, "value.txt"), "base\n");
  execFileSync("git", ["add", "value.txt"], { cwd: repository });
  execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: repository });
  const baseSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repository,
    encoding: "utf8",
  }).trim();
  const authFile = join(root, "auth.json");
  await writeFile(authFile, "{}", { mode: 0o600 });
  return { root, repository, baseSha, authFile };
}

function attemptContext(
  fixture: { repository: string; baseSha: string },
  number: number,
): AttemptContext {
  return {
    repository: "clockgrove/factory",
    objective: 1,
    workItem: number,
    attempt: 1,
    runId: `conformance-${number}`,
    directorEpoch: 2,
    policyDigest: "e".repeat(64),
    workspace: fixture.repository,
    deadline: new Date(Date.now() + 10_000),
    packet: {
      goal: "change value.txt",
      acceptanceCriteria: ["value.txt changed"],
      allowedPaths: ["value.txt"],
      preconditions: [],
      outOfScope: [],
      conventions: [],
      baseSha: fixture.baseSha,
      validationCommands: ["grep -qx changed value.txt"],
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

async function cliHarness(): Promise<BackendHarness> {
  const fixture = await repositoryFixture("conformance-cli");
  const command = join(fixture.root, "codex-stub.sh");
  await writeFile(
    command,
    [
      "#!/bin/sh",
      'if [ "$1" = "--version" ]; then echo \'codex-cli 99\'; exit 0; fi',
      "printf 'changed\\n' > value.txt",
      'printf \'%s\\n\' \'{"type":"thread.started","thread_id":"cli-thread"}\'',
      'printf \'%s\\n\' \'{"type":"item.completed","item":{"type":"agent_message","text":"{\\"outcome\\":\\"succeeded\\",\\"summary\\":\\"done\\",\\"commands\\":[]}"}}\'',
      'printf \'%s\\n\' \'{"type":"turn.completed","usage":{"input_tokens":9,"completion_tokens":4,"cached_prompt_tokens":2}}\'',
    ].join("\n"),
  );
  await chmod(command, 0o700);
  const homes = join(fixture.root, "homes");
  const backend = new CodexCliLocalBackend({
    command,
    authFile: fixture.authFile,
    createCodexHome: async (kind) => {
      await mkdir(homes, { recursive: true });
      return mkdtemp(join(homes, `${kind}-`));
    },
  });
  return {
    backend,
    context: attemptContext(fixture, 1),
    async complete(): Promise<void> {},
  };
}

async function appServerHarness(): Promise<BackendHarness> {
  const fixture = await repositoryFixture("conformance-app");
  const homes = join(fixture.root, "homes");
  const connections = new Map<string, ConformanceConnection>();
  let sequence = 0;
  const backend = new CodexAppServerLocalBackend({
    authFile: fixture.authFile,
    cancellationWaitMs: 5,
    createProbeCodexHome: async () => {
      await mkdir(homes, { recursive: true });
      return mkdtemp(join(homes, "probe-"));
    },
    resolveCodexHome: (identity) => join(homes, durableAttemptId(identity)),
    connect: (home) => {
      const connection = new ConformanceConnection(`app-thread-${++sequence}`);
      connections.set(home, connection);
      return connection;
    },
  });
  const context = attemptContext(fixture, 2);
  return {
    backend,
    context,
    async complete(handle): Promise<void> {
      await writeFile(join(context.workspace, "value.txt"), "changed\n");
      const connection = connections.get(handle.metadata!.codexHome!)!;
      const item = {
        type: "agentMessage",
        id: "final",
        text: JSON.stringify({
          outcome: "succeeded",
          summary: "done",
          commands: [],
        }),
      };
      connection.emit("thread/tokenUsage/updated", {
        threadId: handle.resourceId,
        turnId: handle.metadata!.turnId,
        tokenUsage: {
          total: {},
          last: { inputTokens: 9, outputTokens: 4, cachedInputTokens: 2 },
        },
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
    },
  };
}

async function assertLocalBackendContract(harness: BackendHarness): Promise<void> {
  const { backend, context } = harness;
  expect(backend.capabilities).toMatchObject({
    runtimeKind: "local-worktree",
    hostExecution: true,
    isolation: "process",
    supportsCancellation: true,
    supportsObservation: true,
    providerManagedPublication: false,
  });
  expect(await backend.probe()).toMatchObject({
    available: true,
    authenticated: true,
  });
  const handle = await backend.launch(context);
  await harness.complete(handle);
  let observation = await backend.observe(handle);
  for (let check = 0; check < 100 && observation.state === "running"; check += 1) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    observation = await backend.observe(handle);
  }
  expect(observation).toMatchObject({
    state: "succeeded",
    usage: { inputTokens: 9, outputTokens: 4, cachedInputTokens: 2 },
  });
  const artifact = await backend.collect(handle);
  expect(artifact).toMatchObject({
    baseSha: context.packet.baseSha,
    changedPaths: ["value.txt"],
    outcome: "succeeded",
  });
  expect(artifact.patch).toContain("changed");
  await backend.cleanup(handle);
}

describe("local Codex backend conformance", () => {
  it.each([
    ["App Server", appServerHarness],
    ["CLI fallback", cliHarness],
  ])("passes the same worker/artifact lifecycle for %s", async (_name, createHarness) => {
    await assertLocalBackendContract(await createHarness());
  });

  it("normalizes representative adapter usage into one conservative public shape", () => {
    const appServer = normalizeExecutionUsage({
      inputTokens: 8,
      outputTokens: 3,
      cachedInputTokens: 2,
    });
    const cli = normalizeExecutionUsage({
      input_tokens: 8,
      completion_tokens: 3,
      cached_prompt_tokens: 2,
    });
    expect(appServer).toEqual(cli);
    expect(normalizeExecutionUsage({})).toEqual({
      inputTokens: null,
      outputTokens: null,
      cachedInputTokens: null,
    });
    expect(
      normalizeExecutionUsage({
        input_tokens: -1,
        output_tokens: Number.NaN,
      }),
    ).toEqual({
      inputTokens: null,
      outputTokens: null,
      cachedInputTokens: null,
    });
  });
});
