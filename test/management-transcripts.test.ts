import { execFile } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { build } from "esbuild";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexCliManagementBackend } from "../src/management/codex-cli.js";
import {
  LocalManagementTranscriptRecorder,
  MANAGEMENT_TRANSCRIPT_DIRECTORY_ENV,
  localManagementTranscriptRecorderFromEnvironment,
  type ManagementTranscriptRecorder,
} from "../src/management/transcripts.js";
import { DEFAULT_RUN_POLICY } from "../src/protocol/policy.js";

const roots: string[] = [];
const execFileAsync = promisify(execFile);

async function root() {
  const value = await mkdtemp(join(tmpdir(), "factory-management-transcripts-"));
  roots.push(value);
  return value;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("local management transcripts", () => {
  it("stores the exact observable conversation and usage in private files", async () => {
    const base = await root();
    const directory = join(base, "archive");
    const recorder = new LocalManagementTranscriptRecorder(directory);
    const prompt = "Inspect the exact Objective and return JSON.";
    const schema = { type: "object", properties: { ok: { type: "boolean" } } };
    const first = JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "Checking the repository." },
    });
    const final = JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: '{"ok":true}' },
    });
    const completed = JSON.stringify({
      type: "turn.completed",
      usage: { input_tokens: 100, output_tokens: 20, cached_input_tokens: 60 },
    });
    const stdout = [first, final, completed].join("\n");
    const session = await recorder.begin({
      cwd: base,
      modelInvocationId: "compiler-exact",
      prompt,
      schema,
      profile: "production-profile",
      model: "gpt-test",
      reasoning: "high",
      transport: "codex-cli-jsonl",
    });
    await session.finish({
      state: "succeeded",
      stdout,
      stderr: "",
      exitCode: 0,
      signal: null,
      timedOut: false,
      durationMs: 123,
      parsedResponse: { ok: true },
      usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 60 },
    });

    const files = await readdir(directory);
    expect(files).toHaveLength(1);
    const path = join(directory, files[0]!);
    const record = JSON.parse(await readFile(path, "utf8"));
    expect(record).toMatchObject({
      protocol: "clockgrove.factory/local-management-transcript-v1",
      recordingId: "compiler-exact",
      modelInvocationId: "compiler-exact",
      invocationIdentity: "factory-durable",
      authority: "diagnostic-only",
      request: {
        requestedModel: "gpt-test",
        requestedReasoning: "high",
        requestedProfile: "production-profile",
        selection: {
          profile: { availability: "observed", value: "production-profile" },
          model: { availability: "observed", value: "gpt-test" },
          reasoning: { availability: "observed", value: "high" },
        },
        schema,
      },
      response: {
        state: "succeeded",
        stdout: { availability: "observed", content: stdout, truncatedByFactory: false },
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          cachedInputTokens: 60,
          totalTokens: 120,
          cachedInputIsIncludedInInput: true,
        },
      },
    });
    expect(record.request.messages).toEqual([
      {
        role: "system",
        availability: "unavailable",
        reason: "provider-managed-not-exposed",
      },
      {
        role: "developer",
        availability: "unavailable",
        reason: "provider-managed-not-exposed",
      },
      expect.objectContaining({ role: "user", availability: "observed", content: prompt }),
    ]);
    expect(record.response.messages).toEqual([
      expect.objectContaining({
        role: "assistant",
        content: "Checking the repository.",
        finalStructuredResponse: false,
      }),
      expect.objectContaining({
        role: "assistant",
        content: '{"ok":true}',
        finalStructuredResponse: true,
      }),
    ]);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("is disabled without an explicit absolute directory", () => {
    expect(localManagementTranscriptRecorderFromEnvironment({})).toBeUndefined();
    expect(() =>
      localManagementTranscriptRecorderFromEnvironment({
        FACTORY_MANAGEMENT_TRANSCRIPT_DIR: "relative/archive",
      }),
    ).toThrow("absolute path");
  });

  it("prunes completed records oldest-first within fixed count bounds", async () => {
    const directory = join(await root(), "archive");
    const recorder = new LocalManagementTranscriptRecorder(directory, {
      maxRecordBytes: 16 * 1024,
      maxArchiveBytes: 32 * 1024,
      maxRecords: 2,
    });
    for (const modelInvocationId of ["one", "two", "three"]) {
      const session = await recorder.begin({
        cwd: directory,
        modelInvocationId,
        prompt: modelInvocationId,
        schema: {},
        profile: null,
        model: null,
        reasoning: null,
        transport: "structured-adapter",
      });
      await session.finish({
        state: "succeeded",
        parsedResponse: { modelInvocationId },
        usage: { inputTokens: 1, outputTokens: 1 },
      });
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
    }
    const records = await Promise.all(
      (await readdir(directory)).map(async (name) =>
        JSON.parse(await readFile(join(directory, name), "utf8")),
      ),
    );
    expect(records.map((record) => record.recordingId).sort()).toEqual(["three", "two"]);
  });

  it("prunes only Factory-owned records and serializes concurrent retention", async () => {
    const directory = join(await root(), "archive");
    await mkdir(directory);
    const limits = {
      maxRecordBytes: 16 * 1024,
      maxArchiveBytes: 32 * 1024,
      maxRecords: 2,
    };
    await writeFile(join(directory, "user-settings.json"), '{"keep":true}\n');
    const sessions = await Promise.all(
      ["one", "two", "three", "four"].map((modelInvocationId) =>
        new LocalManagementTranscriptRecorder(directory, limits).begin({
          cwd: directory,
          modelInvocationId,
          prompt: modelInvocationId,
          schema: {},
          profile: null,
          model: null,
          reasoning: null,
          transport: "structured-adapter",
        }),
      ),
    );
    await Promise.all(
      sessions.map((session, index) =>
        session.finish({ state: "succeeded", parsedResponse: { index } }),
      ),
    );
    const names = await readdir(directory);
    expect(names).toContain("user-settings.json");
    expect(JSON.parse(await readFile(join(directory, "user-settings.json"), "utf8"))).toEqual({
      keep: true,
    });
    expect(names.filter((name) => name.startsWith("factory-management-")).length).toBe(2);
  });

  it("enforces retention across independent controller and MCP processes", async () => {
    const base = await root();
    const directory = join(base, "archive");
    const runner = join(base, "transcript-writer.mjs");
    const barrier = join(base, "go");
    const processCount = 16;
    await build({
      stdin: {
        resolveDir: process.cwd(),
        sourcefile: "transcript-writer.ts",
        loader: "ts",
        contents: `
            import { access, writeFile } from "node:fs/promises";
            import { setTimeout as delay } from "node:timers/promises";
            import { LocalManagementTranscriptRecorder } from ${JSON.stringify(
              join(process.cwd(), "src/management/transcripts.ts"),
            )};
            const [directory, id, ready, barrier] = process.argv.slice(2);
            await writeFile(ready, "ready");
            while (true) {
              try { await access(barrier); break; } catch { await delay(5); }
            }
            const recorder = new LocalManagementTranscriptRecorder(directory, {
              maxRecordBytes: 2 * 1024 * 1024,
              maxArchiveBytes: 16 * 1024 * 1024,
              maxRecords: 1,
            });
            const session = await recorder.begin({
              cwd: directory,
              modelInvocationId: id,
              prompt: "x".repeat(128 * 1024),
              schema: {},
              profile: null,
              model: null,
              reasoning: null,
              transport: "structured-adapter",
            });
            await session.finish({
              state: "succeeded",
              parsedResponse: { id, content: "y".repeat(128 * 1024) },
            });
          `,
      },
      outfile: runner,
      bundle: true,
      platform: "node",
      format: "esm",
      logLevel: "silent",
    });
    const ready = Array.from({ length: processCount }, (_, index) => join(base, `ready-${index}`));
    const children = ready.map((readyPath, index) =>
      execFileAsync(process.execPath, [runner, directory, `process-${index}`, readyPath, barrier], {
        cwd: base,
      }),
    );
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      if (
        (
          await Promise.all(
            ready.map((path) =>
              access(path).then(
                () => true,
                () => false,
              ),
            ),
          )
        ).every(Boolean)
      )
        break;
      if (attempt === 999) throw new Error("transcript child processes did not reach barrier");
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    }
    await writeFile(barrier, "go");
    await Promise.all(children);
    const names = await readdir(directory);
    expect(names.filter((name) => name.startsWith("factory-management-")).length).toBe(1);
    expect(names.some((name) => name.endsWith(".tmp"))).toBe(false);
    expect(names).not.toContain(".factory-management-retention.lock");
  }, 30_000);

  it("prunes oldest owned records to the byte bound before replacement", async () => {
    const directory = join(await root(), "archive");
    const limits = {
      maxRecordBytes: 16 * 1024,
      maxArchiveBytes: 18 * 1024,
      maxRecords: 10,
    };
    for (const modelInvocationId of ["one", "two"]) {
      const session = await new LocalManagementTranscriptRecorder(directory, limits).begin({
        cwd: directory,
        modelInvocationId,
        prompt: modelInvocationId,
        schema: {},
        profile: null,
        model: null,
        reasoning: null,
        transport: "structured-adapter",
      });
      await session.finish({
        state: "succeeded",
        parsedResponse: { modelInvocationId, content: "x".repeat(5_000) },
      });
    }
    const names = await readdir(directory);
    const sizes = await Promise.all(names.map((name) => stat(join(directory, name))));
    expect(sizes.reduce((sum, details) => sum + details.size, 0)).toBeLessThanOrEqual(
      limits.maxArchiveBytes,
    );
    expect(names).toHaveLength(1);
    expect(JSON.parse(await readFile(join(directory, names[0]!), "utf8")).recordingId).toBe("two");
  });

  it("rejects a symlink archive root without touching its target", async () => {
    const base = await root();
    const linked = join(base, "linked");
    const sessionDirectory = join(base, "real");
    const setup = new LocalManagementTranscriptRecorder(sessionDirectory);
    const session = await setup.begin({
      cwd: base,
      prompt: "setup",
      schema: {},
      profile: null,
      model: null,
      reasoning: null,
      transport: "structured-adapter",
    });
    await session.finish({ state: "succeeded", parsedResponse: { ok: true } });
    await symlink(sessionDirectory, linked);
    const originalMode = (await stat(sessionDirectory)).mode & 0o777;
    await expect(
      new LocalManagementTranscriptRecorder(linked).begin({
        cwd: base,
        prompt: "must fail",
        schema: {},
        profile: null,
        model: null,
        reasoning: null,
        transport: "structured-adapter",
      }),
    ).rejects.toThrow("not a symlink");
    expect((await stat(sessionDirectory)).mode & 0o777).toBe(originalMode);
  });

  it("does not label progress as a final response when the provider fails", async () => {
    const directory = join(await root(), "archive");
    const recorder = new LocalManagementTranscriptRecorder(directory);
    const session = await recorder.begin({
      cwd: directory,
      prompt: "fail after progress",
      schema: {},
      profile: null,
      model: null,
      reasoning: null,
      transport: "codex-cli-jsonl",
    });
    await session.finish({
      state: "provider-failed",
      stdout: JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "Still working" },
      }),
      exitCode: 7,
    });
    const [name] = await readdir(directory);
    const record = JSON.parse(await readFile(join(directory, name!), "utf8"));
    expect(record.response.messages).toEqual([
      expect.objectContaining({ content: "Still working", finalStructuredResponse: false }),
    ]);
  });

  it("keeps actual failed CLI streams only in the local transcript", async () => {
    const repository = await root();
    const directory = join(repository, "archive");
    const fakeCodex = join(repository, "fake-codex");
    const codexHome = join(repository, "codex-home");
    await writeFile(
      join(repository, "package.json"),
      JSON.stringify({ scripts: { test: "node --test" } }),
    );
    await writeFile(
      fakeCodex,
      [
        "#!/bin/sh",
        'printf \'%s\\n\' \'{"type":"item.completed","item":{"type":"agent_message","text":"private assistant progress"}}\'',
        "printf '%s\\n' 'private repository stderr' >&2",
        "exit 7",
      ].join("\n"),
    );
    await chmod(fakeCodex, 0o700);
    const backend = new CodexCliManagementBackend({
      command: fakeCodex,
      authFile: join(repository, "missing-auth.json"),
      createCodexHome: async () => {
        await mkdir(codexHome);
        return codexHome;
      },
      removeCodexHome: async () => {},
      transcriptRecorder: new LocalManagementTranscriptRecorder(directory),
    });
    let failure: unknown;
    try {
      await backend.compile(
        {
          repository,
          objective: { number: 1, title: "Test", body: "Implement the requested behavior." },
          defaultBranch: "main",
          baseSha: "a".repeat(40),
          repositoryFiles: ["package.json"],
          allowedNetworkDestinations: [],
          runPolicy: DEFAULT_RUN_POLICY,
        },
        async () => {},
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("exited with status 7");
    expect((failure as Error).message).not.toContain("private assistant progress");
    expect((failure as Error).message).not.toContain("private repository stderr");
    const [name] = await readdir(directory);
    const record = JSON.parse(await readFile(join(directory, name!), "utf8"));
    expect(record.response).toMatchObject({
      state: "provider-failed",
      stdout: { content: expect.stringContaining("private assistant progress") },
      stderr: { content: expect.stringContaining("private repository stderr") },
      messages: [
        expect.objectContaining({
          content: "private assistant progress",
          finalStructuredResponse: false,
        }),
      ],
    });
  });

  it("records actual invalid structured CLI output without inventing a final response", async () => {
    const repository = await root();
    const directory = join(repository, "archive");
    const fakeCodex = join(repository, "fake-invalid-codex");
    const codexHome = join(repository, "invalid-codex-home");
    await writeFile(join(repository, "package.json"), JSON.stringify({ scripts: {} }));
    await writeFile(
      fakeCodex,
      [
        "#!/bin/sh",
        'printf \'%s\\n\' \'{"type":"item.completed","item":{"type":"agent_message","text":"not valid structured json"}}\'',
        'printf \'%s\\n\' \'{"type":"turn.completed","usage":{"input_tokens":11,"output_tokens":3,"cached_input_tokens":4}}\'',
      ].join("\n"),
    );
    await chmod(fakeCodex, 0o700);
    const backend = new CodexCliManagementBackend({
      command: fakeCodex,
      authFile: join(repository, "missing-auth.json"),
      createCodexHome: async () => {
        await mkdir(codexHome);
        return codexHome;
      },
      removeCodexHome: async () => {},
      transcriptRecorder: new LocalManagementTranscriptRecorder(directory),
    });
    let failure: unknown;
    try {
      await backend.compile(
        {
          repository,
          objective: { number: 1, title: "Test", body: "Implement the requested behavior." },
          defaultBranch: "main",
          baseSha: "a".repeat(40),
          repositoryFiles: ["package.json"],
          allowedNetworkDestinations: [],
          runPolicy: DEFAULT_RUN_POLICY,
        },
        async () => {},
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("invalid structured JSON");
    expect((failure as Error).message).not.toContain("not valid structured json");
    const [name] = await readdir(directory);
    const record = JSON.parse(await readFile(join(directory, name!), "utf8"));
    expect(record.response).toMatchObject({
      state: "invalid-response",
      parsedResponse: { availability: "unavailable" },
      usage: {
        inputTokens: 11,
        outputTokens: 3,
        cachedInputTokens: 4,
        totalTokens: 14,
      },
      messages: [
        expect.objectContaining({
          content: "not valid structured json",
          finalStructuredResponse: false,
        }),
      ],
    });
  });

  it("performs no transcript filesystem work when backend recording is disabled", async () => {
    const repository = await root();
    const directory = join(repository, "must-not-exist");
    await writeFile(join(repository, "package.json"), JSON.stringify({ scripts: {} }));
    const previous = process.env[MANAGEMENT_TRANSCRIPT_DIRECTORY_ENV];
    process.env[MANAGEMENT_TRANSCRIPT_DIRECTORY_ENV] = directory;
    try {
      const backend = new CodexCliManagementBackend({
        transcriptRecorder: null,
        runStructured: async () => {
          throw new Error("provider primary failure");
        },
      });
      await expect(
        backend.compile(
          {
            repository,
            objective: { number: 1, title: "Test", body: "Implement the requested behavior." },
            defaultBranch: "main",
            baseSha: "a".repeat(40),
            repositoryFiles: ["package.json"],
            allowedNetworkDestinations: [],
            runPolicy: DEFAULT_RUN_POLICY,
          },
          async () => {},
        ),
      ).rejects.toThrow("provider primary failure");
      await expect(access(directory)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (previous === undefined) delete process.env[MANAGEMENT_TRANSCRIPT_DIRECTORY_ENV];
      else process.env[MANAGEMENT_TRANSCRIPT_DIRECTORY_ENV] = previous;
    }
  });

  it("fails open when the real transcript root cannot be created", async () => {
    const repository = await root();
    const blocked = join(repository, "blocked");
    await writeFile(blocked, "regular file");
    await writeFile(join(repository, "package.json"), JSON.stringify({ scripts: {} }));
    const provider = vi.fn(async () => {
      throw new Error("provider primary failure");
    });
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
    const backend = new CodexCliManagementBackend({
      runStructured: provider,
      transcriptRecorder: new LocalManagementTranscriptRecorder(blocked),
    });
    await expect(
      backend.compile(
        {
          repository,
          objective: { number: 1, title: "Test", body: "Implement the requested behavior." },
          defaultBranch: "main",
          baseSha: "a".repeat(40),
          repositoryFiles: ["package.json"],
          allowedNetworkDestinations: [],
          runPolicy: DEFAULT_RUN_POLICY,
        },
        async () => {},
      ),
    ).rejects.toThrow("provider primary failure");
    expect(provider).toHaveBeenCalledOnce();
    expect(diagnostic).toHaveBeenCalledWith(
      expect.stringContaining("[factory-debug] management transcript unavailable:"),
    );
    await expect(access(blocked)).resolves.toBeUndefined();
  });

  it("keeps transcript failures from replacing the provider failure", async () => {
    const repository = await root();
    await writeFile(
      join(repository, "package.json"),
      JSON.stringify({ scripts: { test: "node --test" } }),
    );
    const finish = vi.fn(async () => {
      throw new Error("archive full");
    });
    const transcriptRecorder: ManagementTranscriptRecorder = {
      begin: vi.fn(async () => ({ finish })),
    };
    const provider = vi.fn(async () => {
      throw new Error("provider primary failure");
    });
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
    const backend = new CodexCliManagementBackend({
      runStructured: provider,
      transcriptRecorder,
    });
    await expect(
      backend.compile(
        {
          repository,
          objective: { number: 1, title: "Test", body: "Implement the requested behavior." },
          defaultBranch: "main",
          baseSha: "a".repeat(40),
          repositoryFiles: ["package.json"],
          allowedNetworkDestinations: [],
          runPolicy: DEFAULT_RUN_POLICY,
        },
        async () => {},
      ),
    ).rejects.toThrow("provider primary failure");
    expect(provider).toHaveBeenCalledOnce();
    expect(finish).toHaveBeenCalledOnce();
    expect(diagnostic).toHaveBeenCalledWith(
      "[factory-debug] management transcript unavailable: archive full",
    );
  });
});
