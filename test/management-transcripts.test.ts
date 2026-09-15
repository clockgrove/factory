import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexCliManagementBackend } from "../src/management/codex-cli.js";
import {
  LocalManagementTranscriptRecorder,
  localManagementTranscriptRecorderFromEnvironment,
  type ManagementTranscriptRecorder,
} from "../src/management/transcripts.js";
import { DEFAULT_RUN_POLICY } from "../src/protocol/policy.js";

const roots: string[] = [];

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
