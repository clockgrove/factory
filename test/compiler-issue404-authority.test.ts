import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { managementTerminalOutcome, ManagementOutputError } from "../src/management/backend.js";

import {
  issue404AggregateTokenUsage,
  issue404CanonicalPath,
  issue404InvocationTerminalEvidence,
  issue404LiveAuthority,
  issue404SucceededTransformationFailure,
  issue404TerminalTranscriptEvidence,
  issue404TokenUsageByStage,
  type Issue404DurableRecord,
  type Issue404LiveGitIdentity,
  type Issue404TokenRecord,
  type Issue404TranscriptFile,
  type Issue404TranscriptExpectation,
} from "./helpers/issue404-live-authority.js";

const SHA = "a".repeat(40);
const BASE_SHA = "b".repeat(40);
const REPOSITORY = resolve("/private/factory");
const TRANSCRIPTS = resolve("/private/factory-evidence/issue-404");
const TRANSCRIPT_NOT_BEFORE = Date.parse("2026-09-15T18:00:00.000Z");

it("binds qualification-only omitted-obligation failures to the successful provider receipt", () => {
  const usage = { inputTokens: 12, outputTokens: 3 };
  const error = new ManagementOutputError(new Error("omitted obligation"), usage, {
    protocol: "clockgrove.factory/compiler-proposal",
  });
  const retained = issue404SucceededTransformationFailure(error, usage);
  expect(retained).toBe(error);
  expect(managementTerminalOutcome(retained)).toEqual({ state: "succeeded", usage });
});

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function transcriptExpectation(
  invocationIds: readonly string[],
  overrides: Partial<Issue404TranscriptExpectation> = {},
): Issue404TranscriptExpectation {
  return {
    invocationIds,
    durableRunId: "fresh-run-20260915-case",
    baseSha: BASE_SHA,
    canonicalCwd: "/private/fixture",
    notBeforeMs: TRANSCRIPT_NOT_BEFORE,
    observedAtMs: Date.parse("2026-09-15T18:01:00.000Z"),
    preexistingFiles: new Set(),
    transport: "codex-cli-jsonl",
    profile: null,
    ...overrides,
  };
}

type TranscriptStage = "inventory" | "compile" | "repair" | "judge";

function transcriptRequest(revision: number) {
  const schema = { type: "object", required: ["protocol"] };
  const prompt = `Compile the pinned Factory Objective at base ${BASE_SHA}. Revision ${revision}.`;
  return { schema, prompt };
}

function transcriptProvenance(revision: number) {
  const { schema, prompt } = transcriptRequest(revision);
  return {
    promptDigest: sha256(prompt),
    schemaDigest: sha256(JSON.stringify(schema)),
    baseSha: BASE_SHA,
    model: "gpt-5.6-sol",
    reasoning: "xhigh",
  };
}

function providerResponse(stage: TranscriptStage) {
  if (stage === "inventory") {
    return {
      version: 1,
      obligations: [
        {
          id: "OBL-001",
          kind: "explicit",
          text: "Implement the requested behavior.",
          source: { kind: "objective-body", index: 0 },
        },
      ],
    };
  }
  if (stage === "judge") {
    return {
      protocol: "clockgrove.factory/compiler-verdict",
      verdict: "accept",
      reasons: ["The proposal covers the inventory."],
    };
  }
  return {
    protocol: "clockgrove.factory/compiler-proposal",
    workItems: [
      {
        id: "WI-001",
        title: "Implement the behavior",
        description: "Implement and validate the requested behavior.",
        obligationIds: ["OBL-001"],
        dependencies: [],
      },
    ],
  };
}

function durableValue(stage: TranscriptStage, response: ReturnType<typeof providerResponse>) {
  if (stage === "inventory") {
    const inventory = response as ReturnType<typeof providerResponse> & {
      version: number;
      obligations: unknown[];
    };
    return {
      ...inventory,
      objectiveDigest: "d".repeat(64),
      baseSha: BASE_SHA,
      evidence: [{ path: "README.md", sha256: "e".repeat(64) }],
    };
  }
  if (stage === "compile" || stage === "repair") {
    return {
      request: { revision: stage === "compile" ? 0 : 1 },
      proposal: response,
      report: { status: "valid", violations: [] },
      provenance: { requestDigest: "f".repeat(64) },
    };
  }
  return response;
}

function durablePair(
  invocationId: string,
  revision: number,
  usage: Record<string, number> | null,
  stage: TranscriptStage = revision === 0 ? "compile" : "repair",
): Issue404DurableRecord[] {
  const binding = { runId: "fresh-run-20260915-case", baseSha: BASE_SHA };
  const response = providerResponse(stage);
  const provenance = transcriptProvenance(revision);
  return [
    {
      protocol: "clockgrove.factory/compiler-draft",
      binding,
      kind: "invocation",
      payload: {
        invocationId,
        stage,
        revision,
        startedAt: TRANSCRIPT_NOT_BEFORE + revision * 10_000 + 500,
        expectedProvenance: provenance,
      },
    },
    {
      protocol: "clockgrove.factory/compiler-draft",
      binding,
      kind: "result",
      payload: {
        invocationId,
        stage,
        revision,
        completedAt: TRANSCRIPT_NOT_BEFORE + revision * 10_000 + 5_000,
        usage,
        terminalOutcome: { state: "succeeded", usage },
        provenance,
        value: durableValue(stage, response),
      },
    },
  ];
}

function preProviderTerminalPair(
  invocationId: string,
  overrides: Record<string, unknown> = {},
): Issue404DurableRecord[] {
  const binding = { runId: "fresh-run-20260915-case", baseSha: BASE_SHA };
  return [
    {
      protocol: "clockgrove.factory/compiler-draft",
      binding,
      kind: "invocation",
      payload: {
        invocationId,
        stage: "repair",
        revision: 1,
        startedAt: TRANSCRIPT_NOT_BEFORE + 10_500,
      },
    },
    {
      protocol: "clockgrove.factory/compiler-draft",
      binding,
      kind: "result",
      payload: {
        invocationId,
        stage: "repair",
        revision: 1,
        completedAt: TRANSCRIPT_NOT_BEFORE + 11_000,
        usage: null,
        value: null,
        error: "CompilerDraftStopError: compiler request is unsatisfiable",
        stopReason: "compiler request is unsatisfiable",
        preProviderTerminal: true,
        ...overrides,
      },
    },
  ];
}

function transcriptFile(
  invocationId: string,
  revision: number,
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number | null } | null,
  stage: TranscriptStage = revision === 0 ? "compile" : "repair",
) {
  const startedAt = new Date(TRANSCRIPT_NOT_BEFORE + revision * 10_000 + 1_000).toISOString();
  const completedAt = new Date(TRANSCRIPT_NOT_BEFORE + revision * 10_000 + 4_000).toISOString();
  const { schema, prompt } = transcriptRequest(revision);
  const parsedResponse = providerResponse(stage);
  const responseText = JSON.stringify(parsedResponse);
  const completionUsage =
    usage === null
      ? null
      : {
          input_tokens: usage.inputTokens,
          output_tokens: usage.outputTokens,
          ...(usage.cachedInputTokens === null
            ? {}
            : { cached_input_tokens: usage.cachedInputTokens }),
        };
  const stdout = [
    JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: responseText },
    }),
    JSON.stringify({ type: "turn.completed", usage: completionUsage }),
    "",
  ].join("\n");
  const stderr = "";
  return {
    file: `factory-management-${startedAt.replaceAll(":", "-")}-${sha256(invocationId).slice(0, 16)}.json`,
    record: {
      protocol: "clockgrove.factory/local-management-transcript-v1",
      recordingId: invocationId,
      modelInvocationId: invocationId,
      invocationIdentity: "factory-durable",
      authority: "diagnostic-only",
      startedAt,
      completedAt,
      request: {
        cwd: "/private/fixture",
        transport: "codex-cli-jsonl",
        requestedProfile: null,
        requestedModel: "gpt-5.6-sol",
        requestedReasoning: "xhigh",
        selection: {
          profile: { availability: "unavailable", reason: "no-profile-requested" },
          model: { availability: "observed", value: "gpt-5.6-sol" },
          reasoning: { availability: "observed", value: "xhigh" },
        },
        schema,
        schemaSha256: sha256(JSON.stringify(schema)),
        messages: [
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
          { role: "user", availability: "observed", content: prompt, sha256: sha256(prompt) },
        ],
      },
      response: {
        state: "succeeded",
        availability: "observed",
        messages: [
          {
            role: "assistant",
            availability: "observed",
            content: responseText,
            finalStructuredResponse: true,
          },
        ],
        stdout: {
          availability: "observed",
          content: stdout,
          sha256: sha256(stdout),
          truncatedByFactory: false,
        },
        stderr: {
          availability: "observed",
          content: stderr,
          sha256: sha256(stderr),
          truncatedByFactory: false,
        },
        parsedResponse: { availability: "observed", value: parsedResponse },
        process: { exitCode: 0, signal: null, timedOut: false, durationMs: 3_000 },
        usage:
          usage === null
            ? null
            : {
                ...usage,
                totalTokens: usage.inputTokens + usage.outputTokens,
                cachedInputIsIncludedInInput: true,
              },
      },
    },
  } satisfies Issue404TranscriptFile;
}

type FailedTranscriptState = "provider-failed" | "invalid-response";
interface MutableTranscriptStream {
  availability: string;
  content?: string;
  sha256?: string;
  truncatedByFactory?: boolean;
  reason?: string;
}
interface MutableTranscriptResponse {
  state: string;
  availability: string;
  messages: unknown[];
  stdout: MutableTranscriptStream;
  stderr: MutableTranscriptStream;
  parsedResponse: unknown;
  process: {
    exitCode: number | null;
    signal: string | null;
    timedOut: boolean;
    durationMs: number;
  };
  usage: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number | null;
    totalTokens: number;
    cachedInputIsIncludedInInput: boolean;
  } | null;
  error?: string;
}
interface MutableTranscriptFile {
  file: string;
  record: Record<string, unknown> & { response: MutableTranscriptResponse };
}
function failedTranscript(
  invocationId: string,
  state: FailedTranscriptState,
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number | null } | null,
  mode: "schema-400" | "completed-failure" | "invalid-json" | "transport-unavailable",
) {
  const candidate = structuredClone(
    transcriptFile(invocationId, 0, usage, "compile"),
  ) as unknown as MutableTranscriptFile;
  const response = candidate.record.response;
  const error =
    mode === "schema-400"
      ? "management backend failed: Codex CLI exited with status 1; inspect the local management transcript when enabled"
      : mode === "transport-unavailable"
        ? "management transport failed before streams became available"
        : state === "provider-failed"
          ? "GitHub Copilot additional usage limit reached"
          : usage
            ? "management backend returned invalid structured JSON"
            : "management backend stream ended without turn.completed";
  let stdout: string | undefined;
  if (mode === "schema-400") {
    const providerMessage = JSON.stringify(
      {
        type: "error",
        error: {
          type: "invalid_request_error",
          code: "invalid_json_schema",
          message:
            "Invalid schema for response_format 'codex_output_schema': In context=('properties', 'protocol'), schema must have a 'type' key.",
          param: "text.format.schema",
        },
        status: 400,
      },
      null,
      2,
    );
    stdout = [
      JSON.stringify({ type: "thread.started", thread_id: "thread-r3" }),
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({ type: "error", message: providerMessage }),
      JSON.stringify({ type: "turn.failed", error: { message: providerMessage } }),
      "",
    ].join("\n");
  } else if (mode === "completed-failure") {
    const providerMessage =
      "You've reached your additional usage limit for your plan. Go to https://github.com/settings/copilot/features for more details.";
    stdout = [
      JSON.stringify({
        type: "turn.completed",
        usage: {
          input_tokens: usage!.inputTokens,
          output_tokens: usage!.outputTokens,
          ...(usage!.cachedInputTokens === null
            ? {}
            : { cached_input_tokens: usage!.cachedInputTokens }),
        },
      }),
      JSON.stringify({ type: "turn.failed", error: { message: providerMessage } }),
      "",
    ].join("\n");
  } else if (mode === "invalid-json") {
    stdout = [
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "not-json" } }),
      ...(usage
        ? [
            JSON.stringify({
              type: "turn.completed",
              usage: {
                input_tokens: usage.inputTokens,
                output_tokens: usage.outputTokens,
                ...(usage.cachedInputTokens === null
                  ? {}
                  : { cached_input_tokens: usage.cachedInputTokens }),
              },
            }),
          ]
        : []),
      "",
    ].join("\n");
  }
  response.state = state;
  response.error = error;
  response.messages =
    mode === "invalid-json"
      ? [
          {
            role: "assistant",
            availability: "observed",
            content: "not-json",
            finalStructuredResponse: false,
          },
        ]
      : [];
  response.parsedResponse = {
    availability: "unavailable",
    reason: "no-valid-structured-response",
  };
  response.process = {
    exitCode:
      state === "invalid-response"
        ? 0
        : mode === "completed-failure"
          ? 0
          : mode === "schema-400"
            ? 1
            : null,
    signal: null,
    timedOut: false,
    durationMs: 3_000,
  };
  response.usage = usage
    ? {
        ...usage,
        totalTokens: usage.inputTokens + usage.outputTokens,
        cachedInputIsIncludedInInput: true,
      }
    : null;
  if (stdout === undefined) {
    response.availability = "unavailable";
    response.stdout = { availability: "unavailable", reason: "stdout-not-exposed-by-transport" };
    response.stderr = { availability: "unavailable", reason: "stderr-not-exposed-by-transport" };
  } else {
    response.availability = "observed";
    response.stdout = {
      availability: "observed",
      content: stdout,
      sha256: sha256(stdout),
      truncatedByFactory: false,
    };
    response.stderr = {
      availability: "observed",
      content: "",
      sha256: sha256(""),
      truncatedByFactory: false,
    };
  }
  return candidate;
}

function observedFailedTranscript(input: {
  invocationId: string;
  state: FailedTranscriptState;
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number | null } | null;
  stdout: string;
  error: string;
  process: MutableTranscriptResponse["process"];
  assistant?: string[];
}) {
  const candidate = failedTranscript(
    input.invocationId,
    input.state,
    input.usage,
    "transport-unavailable",
  );
  const response = candidate.record.response;
  response.availability = "observed";
  response.stdout = {
    availability: "observed",
    content: input.stdout,
    sha256: sha256(input.stdout),
    truncatedByFactory: false,
  };
  response.stderr = {
    availability: "observed",
    content: "",
    sha256: sha256(""),
    truncatedByFactory: false,
  };
  response.error = input.error;
  response.process = input.process;
  response.messages = (input.assistant ?? []).map((content) => ({
    role: "assistant",
    availability: "observed",
    content,
    finalStructuredResponse: false,
  }));
  return candidate;
}

function failedDurablePair(
  invocationId: string,
  state: FailedTranscriptState,
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens?: number } | null,
  error = `${state} fixture`,
  process?: { timedOut: boolean; durationMs: number },
) {
  const records = durablePair(invocationId, 0, usage);
  const result = records[1]!;
  result.payload.value = null;
  result.payload.error = error;
  result.payload.terminalOutcome = { state, usage, ...(process ? { process } : {}) };
  return records;
}

function environment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    FACTORY_LIVE_OBJECTIVE: "1",
    FACTORY_LIVE_COMPILER_ISSUE404: "1",
    FACTORY_LIVE_COMPILER_ISSUE404_PAID_ACK: "consume-paid-compiler-evaluation",
    FACTORY_LIVE_COMPILER_ISSUE404_RUN_ID: "fresh-run-20260915",
    FACTORY_ISSUE404_CANDIDATE_SHA: SHA,
    FACTORY_MANAGEMENT_TRANSCRIPT_DIR: TRANSCRIPTS,
    ...overrides,
  };
}

function identity(overrides: Partial<Issue404LiveGitIdentity> = {}): Issue404LiveGitIdentity {
  return {
    candidateCommitSha: SHA,
    headSha: SHA,
    worktreeStatus: "",
    ...overrides,
  };
}

describe("issue #404 live compiler authority", () => {
  it("accepts only explicit paid authority bound to a clean exact commit", () => {
    const inspect = vi.fn(() => identity());
    const assertWritable = vi.fn();
    expect(
      issue404LiveAuthority(environment(), REPOSITORY, inspect, assertWritable, resolve),
    ).toEqual({
      candidateSha: SHA,
      runId: "fresh-run-20260915",
      transcriptDirectory: TRANSCRIPTS,
    });
    expect(inspect).toHaveBeenCalledExactlyOnceWith(SHA);
    expect(assertWritable).toHaveBeenCalledExactlyOnceWith(TRANSCRIPTS);
  });

  it.each([
    ["objective opt-in", { FACTORY_LIVE_OBJECTIVE: "0" }, "FACTORY_LIVE_OBJECTIVE=1"],
    ["case opt-in", { FACTORY_LIVE_COMPILER_ISSUE404: "0" }, "FACTORY_LIVE_COMPILER_ISSUE404=1"],
    ["paid acknowledgement", { FACTORY_LIVE_COMPILER_ISSUE404_PAID_ACK: "yes" }, "PAID_ACK"],
    ["exact SHA syntax", { FACTORY_ISSUE404_CANDIDATE_SHA: "main" }, "40-character commit SHA"],
    [
      "fresh run ID",
      { FACTORY_LIVE_COMPILER_ISSUE404_RUN_ID: "Prior_Run" },
      "fresh lowercase safe ID",
    ],
    [
      "absolute transcripts",
      { FACTORY_MANAGEMENT_TRANSCRIPT_DIR: "evidence" },
      "absolute private local path",
    ],
    [
      "private transcripts",
      { FACTORY_MANAGEMENT_TRANSCRIPT_DIR: resolve(REPOSITORY, "evidence") },
      "outside the Git repository",
    ],
  ])("rejects missing %s authority before a live call", (_label, overrides, message) => {
    expect(() =>
      issue404LiveAuthority(
        environment(overrides),
        REPOSITORY,
        () => identity(),
        () => {},
        resolve,
      ),
    ).toThrow(message);
  });

  it.each([
    [
      "missing commit",
      identity({ candidateCommitSha: "b".repeat(40) }),
      "resolve to that exact commit",
    ],
    ["different HEAD", identity({ headSha: "b".repeat(40) }), "exactly equal git HEAD"],
    [
      "dirty worktree",
      identity({ worktreeStatus: " M src/compiler/contracts.ts" }),
      "must be clean",
    ],
  ])("rejects a %s candidate before a live call", (_label, observed, message) => {
    expect(() =>
      issue404LiveAuthority(
        environment(),
        REPOSITORY,
        () => observed,
        () => {},
        resolve,
      ),
    ).toThrow(message);
  });

  it("rejects an unwritable transcript archive during preflight", () => {
    expect(() =>
      issue404LiveAuthority(
        environment(),
        REPOSITORY,
        () => identity(),
        () => {
          throw new Error("archive is read-only");
        },
        resolve,
      ),
    ).toThrow("archive is read-only");
  });

  it("rejects a lexical outside path whose existing ancestor resolves into the repository", () => {
    const root = mkdtempSync(join(tmpdir(), "factory-issue404-authority-"));
    try {
      const repository = join(root, "repository");
      const hidden = join(repository, ".hidden");
      const outside = join(root, "outside");
      mkdirSync(hidden, { recursive: true });
      mkdirSync(outside, { recursive: true });
      symlinkSync(hidden, join(outside, "link"));
      const transcriptDirectory = join(outside, "link", "transcripts");
      const assertWritable = vi.fn();
      expect(() =>
        issue404LiveAuthority(
          environment({ FACTORY_MANAGEMENT_TRANSCRIPT_DIR: transcriptDirectory }),
          repository,
          () => identity(),
          assertWritable,
          issue404CanonicalPath,
        ),
      ).toThrow("must remain outside the Git repository");
      expect(assertWritable).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rechecks the created transcript directory's canonical destination", () => {
    const assertWritable = vi.fn();
    let transcriptInspections = 0;
    expect(() =>
      issue404LiveAuthority(
        environment(),
        REPOSITORY,
        () => identity(),
        assertWritable,
        (path) => {
          if (path === REPOSITORY) return REPOSITORY;
          transcriptInspections += 1;
          return transcriptInspections === 1 ? TRANSCRIPTS : resolve(REPOSITORY, ".hidden");
        },
      ),
    ).toThrow("must remain outside the Git repository");
    expect(assertWritable).toHaveBeenCalledExactlyOnceWith(TRANSCRIPTS);
  });

  it("accepts complete new recorder records bound to durable invocation results", () => {
    const first = "compiler-first";
    const second = "compiler-second";
    const transcripts = [
      transcriptFile(first, 0, { inputTokens: 10, outputTokens: 2, cachedInputTokens: 4 }),
      transcriptFile(second, 1, { inputTokens: 7, outputTokens: 3, cachedInputTokens: null }),
    ];
    const durable = [
      ...durablePair(first, 0, { inputTokens: 10, outputTokens: 2, cachedInputTokens: 4 }),
      ...durablePair(second, 1, { inputTokens: 7, outputTokens: 3 }),
    ];
    expect(
      issue404TerminalTranscriptEvidence(
        transcripts,
        durable,
        transcriptExpectation([first, second]),
      ),
    ).toEqual([
      expect.objectContaining({
        file: transcripts[0]!.file,
        modelInvocationId: first,
        state: "succeeded",
        stage: "compile",
        revision: 0,
        responseSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        stdoutSha256: transcripts[0]!.record.response.stdout.sha256,
        stderrSha256: transcripts[0]!.record.response.stderr.sha256,
      }),
      expect.objectContaining({
        file: transcripts[1]!.file,
        modelInvocationId: second,
        state: "succeeded",
        stage: "repair",
        revision: 1,
        responseSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        stdoutSha256: transcripts[1]!.record.response.stdout.sha256,
        stderrSha256: transcripts[1]!.record.response.stderr.sha256,
      }),
    ]);
  });

  it("requires transcripts only for provider-dispatched terminals and retains local stop evidence", () => {
    const providerInvocationId = "compiler-provider-terminal";
    const localInvocationId = "compiler-local-terminal";
    const usage = { inputTokens: 10, outputTokens: 2, cachedInputTokens: 4 };
    const records = [
      ...durablePair(providerInvocationId, 0, usage),
      ...preProviderTerminalPair(localInvocationId),
    ];
    const terminalEvidence = issue404InvocationTerminalEvidence(records);

    expect(terminalEvidence).toEqual({
      providerInvocationIds: [providerInvocationId],
      preProviderTerminals: [
        {
          invocationId: localInvocationId,
          stage: "repair",
          revision: 1,
          error: "CompilerDraftStopError: compiler request is unsatisfiable",
          stopReason: "compiler request is unsatisfiable",
        },
      ],
    });
    expect(
      issue404TerminalTranscriptEvidence(
        [transcriptFile(providerInvocationId, 0, usage)],
        records,
        transcriptExpectation(terminalEvidence.providerInvocationIds),
      ),
    ).toEqual([
      expect.objectContaining({
        modelInvocationId: providerInvocationId,
        stage: "compile",
        revision: 0,
      }),
    ]);
  });

  it("rejects incomplete or forged local pre-provider terminal evidence", () => {
    const valid = preProviderTerminalPair("compiler-local-terminal");
    const mutations = [
      (records: Issue404DurableRecord[]) => {
        records[1]!.payload.usage = { inputTokens: 0, outputTokens: 0 };
      },
      (records: Issue404DurableRecord[]) => {
        delete records[1]!.payload.stopReason;
      },
      (records: Issue404DurableRecord[]) => {
        records[1]!.payload.terminalOutcome = { state: "succeeded", usage: null };
      },
    ];
    for (const mutate of mutations) {
      const records = structuredClone(valid);
      mutate(records);
      expect(() => issue404InvocationTerminalEvidence(records)).toThrow(
        "invalid pre-provider terminal evidence",
      );
    }
    expect(() => issue404InvocationTerminalEvidence(valid.slice(0, 1))).toThrow(
      "lacks one durable terminal result",
    );
  });

  it("ignores interleaved non-JSON diagnostics in a successful production stream", () => {
    const invocationId = "compiler-success-interleaved-diagnostics";
    const usage = { inputTokens: 10, outputTokens: 2, cachedInputTokens: 4 };
    const transcript = transcriptFile(invocationId, 0, usage) as unknown as MutableTranscriptFile;
    const stream = transcript.record.response.stdout;
    if (typeof stream.content !== "string") throw new Error("fixture stdout missing");
    stream.content = [
      "diagnostic before",
      "{malformed diagnostic",
      stream.content,
      "diagnostic after",
    ].join("\n");
    stream.sha256 = sha256(stream.content);

    expect(
      issue404TerminalTranscriptEvidence(
        [transcript],
        durablePair(invocationId, 0, usage),
        transcriptExpectation([invocationId]),
      ),
    ).toEqual([expect.objectContaining({ state: "succeeded", usage: expect.any(Object) })]);
  });

  it.each([
    {
      name: "provider schema 400 with nonzero exit and unavailable usage",
      state: "provider-failed" as const,
      mode: "schema-400" as const,
      usage: null,
    },
    {
      name: "provider failure after completion with exact usage and exit zero",
      state: "provider-failed" as const,
      mode: "completed-failure" as const,
      usage: { inputTokens: 29, outputTokens: 3, cachedInputTokens: 14 },
    },
    {
      name: "invalid response with exact usage",
      state: "invalid-response" as const,
      mode: "invalid-json" as const,
      usage: { inputTokens: 31, outputTokens: 4, cachedInputTokens: null },
    },
    {
      name: "invalid response with unavailable usage",
      state: "invalid-response" as const,
      mode: "invalid-json" as const,
      usage: null,
    },
    {
      name: "transport failure with unavailable streams and usage",
      state: "provider-failed" as const,
      mode: "transport-unavailable" as const,
      usage: null,
    },
  ])("authenticates terminal $name", ({ state, mode, usage }) => {
    const invocationId = `compiler-terminal-${mode}-${usage ? "usage" : "unknown"}`;
    const transcript = failedTranscript(invocationId, state, usage, mode);
    const transcriptRecord = transcript.record;
    const durableUsage = usage
      ? {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          ...(usage.cachedInputTokens === null
            ? {}
            : { cachedInputTokens: usage.cachedInputTokens }),
        }
      : null;
    const durable = failedDurablePair(
      invocationId,
      state,
      durableUsage,
      transcriptRecord.response.error!,
    );
    expect(
      issue404TerminalTranscriptEvidence(
        [transcript],
        durable,
        transcriptExpectation([invocationId]),
      ),
    ).toEqual([
      expect.objectContaining({
        state,
        responseSha256: null,
        errorSha256: sha256(transcriptRecord.response.error!),
        stdoutSha256:
          mode === "transport-unavailable" ? null : transcriptRecord.response.stdout.sha256,
        stdoutUnavailableReason:
          mode === "transport-unavailable" ? "stdout-not-exposed-by-transport" : null,
        process: transcriptRecord.response.process,
        usage: usage
          ? expect.objectContaining({
              availability: "observed",
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
            })
          : { availability: "unknown" },
      }),
    ]);
  });

  it("accepts only the exact production transport-unavailable terminal grammar", () => {
    const invocationId = "compiler-terminal-transport-exact";
    const good = failedTranscript(invocationId, "provider-failed", null, "transport-unavailable");
    const error = good.record.response.error!;
    const unknownDurable = failedDurablePair(invocationId, "provider-failed", null, error);
    const evidence = (transcript: MutableTranscriptFile, durable = unknownDurable) =>
      issue404TerminalTranscriptEvidence(
        [transcript],
        durable,
        transcriptExpectation([invocationId]),
      );
    expect(evidence(good)).toEqual([
      expect.objectContaining({
        state: "provider-failed",
        stdoutUnavailableReason: "stdout-not-exposed-by-transport",
        stderrUnavailableReason: "stderr-not-exposed-by-transport",
        process: { exitCode: null, signal: null, timedOut: false, durationMs: 3_000 },
        usage: { availability: "unknown" },
      }),
    ]);

    const observedStream = {
      availability: "observed",
      content: "",
      sha256: sha256(""),
      truncatedByFactory: false,
    };
    const changed = (change: (response: MutableTranscriptResponse) => void) => {
      const transcript = structuredClone(good);
      change(transcript.record.response);
      return { transcript, durable: unknownDurable };
    };
    const exactUsage = { inputTokens: 2, outputTokens: 1, cachedInputTokens: null };
    const nonNullUsage = changed((response) => {
      response.usage = {
        ...exactUsage,
        totalTokens: 3,
        cachedInputIsIncludedInInput: true,
      };
    });
    nonNullUsage.durable = failedDurablePair(
      invocationId,
      "provider-failed",
      { inputTokens: 2, outputTokens: 1 },
      error,
    );
    const cases = [
      changed((response) => (response.process.exitCode = -1)),
      changed((response) => (response.process.exitCode = 0)),
      changed((response) => (response.process.signal = "SIGTERM")),
      changed((response) => (response.process.timedOut = true)),
      changed((response) => (response.availability = "observed")),
      changed((response) => (response.stdout = observedStream)),
      changed((response) => (response.stderr = observedStream)),
      changed(
        (response) =>
          (response.stdout = { availability: "unavailable", reason: "arbitrary-stdout-reason" }),
      ),
      changed(
        (response) =>
          (response.stderr = { availability: "unavailable", reason: "arbitrary-stderr-reason" }),
      ),
      nonNullUsage,
      changed((response) =>
        response.messages.push({
          role: "assistant",
          availability: "observed",
          content: "forged message",
          finalStructuredResponse: false,
        }),
      ),
    ];
    for (const testCase of cases)
      expect(evidence(testCase.transcript, testCase.durable)).toBeNull();
  });

  it("rejects terminal state, process, stream, error, usage, and completion tampering", () => {
    const invocationId = "compiler-terminal-tamper";
    const usage = { inputTokens: 29, outputTokens: 3, cachedInputTokens: 14 };
    const good = failedTranscript(invocationId, "provider-failed", usage, "completed-failure");
    const response = good.record.response;
    const durable = failedDurablePair(invocationId, "provider-failed", usage, response.error!);
    const altered = (change: (record: MutableTranscriptFile["record"]) => void) => {
      const candidate = structuredClone(good);
      change(candidate.record);
      return candidate;
    };
    const cases = [
      altered((record) => (record.response.state = "invalid-response")),
      altered((record) => (record.response.process.durationMs = -1)),
      altered((record) => (record.response.stdout.sha256 = "0".repeat(64))),
      altered((record) => (record.response.error = "different error")),
      altered((record) => {
        if (!record.response.usage) throw new Error("fixture usage missing");
        record.response.usage.inputTokens += 1;
      }),
      altered((record) => (record.response.usage = null)),
      altered((record) => {
        const content = record.response.stdout.content;
        if (typeof content !== "string") throw new Error("fixture stdout missing");
        const lines = content.trimEnd().split("\n");
        lines.splice(-1, 1);
        record.response.stdout.content = `${lines.join("\n")}\n`;
        record.response.stdout.sha256 = sha256(record.response.stdout.content);
      }),
    ];
    const wrongOutcome = structuredClone(durable);
    wrongOutcome[1]!.payload.terminalOutcome = {
      state: "invalid-response",
      usage,
    };
    for (const transcript of cases)
      expect(
        issue404TerminalTranscriptEvidence(
          [transcript],
          durable,
          transcriptExpectation([invocationId]),
        ),
      ).toBeNull();
    expect(
      issue404TerminalTranscriptEvidence(
        [good],
        wrongOutcome,
        transcriptExpectation([invocationId]),
      ),
    ).toBeNull();
  });

  it.each([
    {
      name: "progress-only nonzero exit",
      state: "provider-failed" as const,
      usage: null,
      error:
        "management backend failed: Codex CLI exited with status 1; inspect the local management transcript when enabled",
      stdout: [
        "provider diagnostic",
        JSON.stringify({ type: "turn.started" }),
        "{broken-json",
      ].join("\n"),
      process: { exitCode: 1, signal: null, timedOut: false, durationMs: 30 },
    },
    {
      name: "error-only quota at exit zero",
      state: "provider-failed" as const,
      usage: null,
      error: "GitHub Copilot additional usage limit reached",
      stdout: JSON.stringify({
        type: "error",
        message:
          "You've reached your additional usage limit for your plan. Go to https://github.com/settings/copilot/features for more details.",
      }),
      process: { exitCode: 0, signal: null, timedOut: false, durationMs: 31 },
    },
    {
      name: "error-only quota at nonzero exit",
      state: "provider-failed" as const,
      usage: null,
      error: "GitHub Copilot monthly quota exceeded",
      stdout: JSON.stringify({
        type: "error",
        message: "You have exceeded your monthly quota. Upgrade your plan.",
      }),
      process: { exitCode: 1, signal: null, timedOut: false, durationMs: 32 },
    },
    {
      name: "turn.failed quota at exit zero",
      state: "provider-failed" as const,
      usage: null,
      error: "GitHub Copilot monthly quota exceeded",
      stdout: JSON.stringify({
        type: "turn.failed",
        error: { message: "You have exceeded your monthly quota. Upgrade your plan." },
      }),
      process: { exitCode: 0, signal: null, timedOut: false, durationMs: 33 },
    },
    {
      name: "signal-terminated progress stream",
      state: "provider-failed" as const,
      usage: null,
      error:
        "management backend failed: Codex CLI exited with status unknown after signal SIGTERM; inspect the local management transcript when enabled",
      stdout: JSON.stringify({ type: "thread.started", thread_id: "signal-thread" }),
      process: { exitCode: null, signal: "SIGTERM", timedOut: false, durationMs: 34 },
    },
    {
      name: "timed-out progress stream",
      state: "provider-failed" as const,
      usage: null,
      error:
        "management backend failed: Codex CLI exited with status unknown after timeout; inspect the local management transcript when enabled",
      stdout: JSON.stringify({ type: "turn.started" }),
      process: { exitCode: null, signal: null, timedOut: true, durationMs: 35 },
    },
    {
      name: "invalid response with interleaved diagnostics and exact usage",
      state: "invalid-response" as const,
      usage: { inputTokens: 41, outputTokens: 5, cachedInputTokens: 20 },
      error: "management backend returned invalid structured JSON",
      stdout: [
        "codex diagnostic before events",
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "not-json" },
        }),
        "{malformed diagnostic",
        JSON.stringify({
          type: "turn.completed",
          usage: { input_tokens: 41, output_tokens: 5, cached_input_tokens: 20 },
        }),
        "codex diagnostic after events",
      ].join("\n"),
      assistant: ["not-json"],
      process: { exitCode: 0, signal: null, timedOut: false, durationMs: 36 },
    },
    {
      name: "failure assistant remains non-final",
      state: "provider-failed" as const,
      usage: null,
      error:
        "management backend failed: Codex CLI exited with status 1; inspect the local management transcript when enabled",
      stdout: [
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "progress only" },
        }),
        JSON.stringify({ type: "turn.started" }),
      ].join("\n"),
      assistant: ["progress only"],
      process: { exitCode: 1, signal: null, timedOut: false, durationMs: 37 },
    },
  ])("authenticates production-equivalent $name terminal grammar", (testCase) => {
    const invocationId = `terminal-grammar-${testCase.name.replaceAll(" ", "-")}`;
    const transcript = observedFailedTranscript({ ...testCase, invocationId });
    const durableUsage = testCase.usage
      ? {
          inputTokens: testCase.usage.inputTokens,
          outputTokens: testCase.usage.outputTokens,
          ...(testCase.usage.cachedInputTokens === null
            ? {}
            : { cachedInputTokens: testCase.usage.cachedInputTokens }),
        }
      : null;
    const durable = failedDurablePair(
      invocationId,
      testCase.state,
      durableUsage,
      testCase.error,
      testCase.process.timedOut
        ? { timedOut: true, durationMs: testCase.process.durationMs }
        : undefined,
    );
    expect(
      issue404TerminalTranscriptEvidence(
        [transcript],
        durable,
        transcriptExpectation([invocationId]),
      ),
    ).toEqual([
      expect.objectContaining({
        state: testCase.state,
        responseSha256: null,
        errorSha256: sha256(testCase.error),
        process: testCase.process,
      }),
    ]);
  });

  it.each([
    {
      name: "invalid cached counter and extra provider fields",
      usage: { inputTokens: 44, outputTokens: 6, cachedInputTokens: null },
      stdout: JSON.stringify({
        type: "turn.completed",
        provider_extension: "retained",
        usage: {
          input_tokens: 44,
          output_tokens: 6,
          cached_input_tokens: 45,
          provider_total_tokens: 50,
        },
      }),
    },
    {
      name: "malformed unique completion",
      usage: null,
      stdout: JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 44, cached_input_tokens: 10 },
      }),
    },
    {
      name: "ambiguous duplicate completions",
      usage: null,
      stdout: [
        JSON.stringify({
          type: "turn.completed",
          usage: { input_tokens: 44, output_tokens: 6 },
        }),
        JSON.stringify({
          type: "turn.completed",
          usage: { input_tokens: 45, output_tokens: 7 },
        }),
      ].join("\n"),
    },
  ])("uses production normalized token evidence for $name", (testCase) => {
    const invocationId = `terminal-usage-${testCase.name.replaceAll(" ", "-")}`;
    const error =
      "management backend failed: Codex CLI exited with status 1; inspect the local management transcript when enabled";
    const transcript = observedFailedTranscript({
      invocationId,
      state: "provider-failed",
      usage: testCase.usage,
      stdout: testCase.stdout,
      error,
      process: { exitCode: 1, signal: null, timedOut: false, durationMs: 40 },
    });
    const durableUsage = testCase.usage
      ? { inputTokens: testCase.usage.inputTokens, outputTokens: testCase.usage.outputTokens }
      : null;
    expect(
      issue404TerminalTranscriptEvidence(
        [transcript],
        failedDurablePair(invocationId, "provider-failed", durableUsage, error),
        transcriptExpectation([invocationId]),
      ),
    ).toEqual([expect.objectContaining({ state: "provider-failed" })]);
  });

  it("rejects a raw completion tamper that changes normalized cached-token evidence", () => {
    const invocationId = "terminal-usage-normalization-tamper";
    const error =
      "management backend failed: Codex CLI exited with status 1; inspect the local management transcript when enabled";
    const usage = { inputTokens: 44, outputTokens: 6, cachedInputTokens: null };
    const transcript = observedFailedTranscript({
      invocationId,
      state: "provider-failed",
      usage,
      error,
      stdout: JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 44, output_tokens: 6, cached_input_tokens: 45 },
      }),
      process: { exitCode: 1, signal: null, timedOut: false, durationMs: 41 },
    });
    const durable = failedDurablePair(
      invocationId,
      "provider-failed",
      { inputTokens: 44, outputTokens: 6 },
      error,
    );
    const stream = transcript.record.response.stdout;
    if (typeof stream.content !== "string") throw new Error("fixture stdout missing");
    stream.content = stream.content.replace('"cached_input_tokens":45', '"cached_input_tokens":0');
    stream.sha256 = sha256(stream.content);
    expect(
      issue404TerminalTranscriptEvidence(
        [transcript],
        durable,
        transcriptExpectation([invocationId]),
      ),
    ).toBeNull();
  });

  it("rejects a final assistant completion flag on a provider failure", () => {
    const invocationId = "terminal-failure-final-flag";
    const error =
      "management backend failed: Codex CLI exited with status 1; inspect the local management transcript when enabled";
    const transcript = observedFailedTranscript({
      invocationId,
      state: "provider-failed",
      usage: null,
      error,
      stdout: JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "progress only" },
      }),
      assistant: ["progress only"],
      process: { exitCode: 1, signal: null, timedOut: false, durationMs: 38 },
    });
    (
      transcript.record.response.messages[0] as { finalStructuredResponse: boolean }
    ).finalStructuredResponse = true;
    expect(
      issue404TerminalTranscriptEvidence(
        [transcript],
        failedDurablePair(invocationId, "provider-failed", null, error),
        transcriptExpectation([invocationId]),
      ),
    ).toBeNull();
  });

  it.each([
    ["inventory", 0],
    ["compile", 0],
    ["repair", 1],
    ["judge", 0],
  ] satisfies Array<[TranscriptStage, number]>)(
    "binds the %s provider response to its durable result",
    (stage, revision) => {
      const invocationId = `compiler-stage-${stage}`;
      const usage = { inputTokens: 10, outputTokens: 2 };
      const transcript = transcriptFile(
        invocationId,
        revision,
        { ...usage, cachedInputTokens: null },
        stage,
      );
      expect(
        issue404TerminalTranscriptEvidence(
          [transcript],
          durablePair(invocationId, revision, usage, stage),
          transcriptExpectation([invocationId]),
        ),
      ).toEqual([
        expect.objectContaining({
          modelInvocationId: invocationId,
          stage,
          revision,
          responseSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        }),
      ]);
    },
  );

  it.each([
    ["inventory", 0],
    ["compile", 0],
    ["repair", 1],
    ["judge", 0],
  ] satisfies Array<[TranscriptStage, number]>)(
    "rejects unrelated self-consistent prompt and schema evidence for %s",
    (stage, revision) => {
      const invocationId = `compiler-${stage}`;
      const usage = { inputTokens: 10, outputTokens: 2 };
      const good = transcriptFile(
        invocationId,
        revision,
        {
          ...usage,
          cachedInputTokens: null,
        },
        stage,
      );
      const durable = durablePair(invocationId, revision, usage, stage);
      const unrelatedPrompt = structuredClone(good);
      const prompt = `Ignore the Objective and return unrelated output. Marker ${BASE_SHA}`;
      unrelatedPrompt.record.request.messages[2]!.content = prompt;
      unrelatedPrompt.record.request.messages[2]!.sha256 = sha256(prompt);
      const unrelatedSchema = structuredClone(good);
      const schema = { type: "array", items: { type: "integer" } };
      (unrelatedSchema.record.request as { schema: unknown }).schema = schema;
      unrelatedSchema.record.request.schemaSha256 = sha256(JSON.stringify(schema));
      for (const transcript of [unrelatedPrompt, unrelatedSchema]) {
        expect(
          issue404TerminalTranscriptEvidence(
            [transcript],
            durable,
            transcriptExpectation([invocationId]),
          ),
          `${stage} accepted unrelated transcript request evidence`,
        ).toBeNull();
      }
    },
  );

  it("rejects spoofed, stale, duplicate, or mismatched transcript evidence", () => {
    const invocationId = "compiler-adversarial";
    const good = transcriptFile(invocationId, 0, {
      inputTokens: 10,
      outputTokens: 2,
      cachedInputTokens: null,
    });
    const durable = durablePair(invocationId, 0, { inputTokens: 10, outputTokens: 2 });
    const expectation = transcriptExpectation([invocationId]);
    const altered = (change: (record: (typeof good)["record"]) => void) => {
      const candidate = structuredClone(good);
      change(candidate.record);
      return candidate;
    };
    const substitutedResponse = altered((record) => {
      const parsedResponse = {
        protocol: "clockgrove.factory/compiler-proposal",
        workItems: [
          {
            id: "WI-SUBSTITUTED",
            title: "Substituted response",
            description: "This response was not retained durably.",
            obligationIds: ["OBL-001"],
            dependencies: [],
          },
        ],
      };
      const content = JSON.stringify(parsedResponse);
      const usage = record.response.usage!;
      const stdout = [
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: content },
        }),
        JSON.stringify({
          type: "turn.completed",
          usage: { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens },
        }),
        "",
      ].join("\n");
      record.response.messages[0]!.content = content;
      (record.response.parsedResponse as { availability: "observed"; value: unknown }).value =
        parsedResponse;
      record.response.stdout.content = stdout;
      record.response.stdout.sha256 = sha256(stdout);
    });
    const cases = [
      {
        label: "the former three-field spoof",
        transcripts: [
          {
            file: good.file,
            record: { modelInvocationId: invocationId, response: { state: "succeeded" } },
          },
        ],
        expected: expectation,
        records: durable,
      },
      {
        label: "wrong protocol",
        transcripts: [altered((record) => (record.protocol = "local-transcript-v0"))],
        expected: expectation,
        records: durable,
      },
      {
        label: "nondiagnostic authority",
        transcripts: [altered((record) => (record.authority = "authoritative"))],
        expected: expectation,
        records: durable,
      },
      {
        label: "non-durable identity",
        transcripts: [altered((record) => (record.invocationIdentity = "local-only"))],
        expected: expectation,
        records: durable,
      },
      {
        label: "mismatched recording ID",
        transcripts: [altered((record) => (record.recordingId = "other"))],
        expected: expectation,
        records: durable,
      },
      {
        label: "wrong filename identity",
        transcripts: [
          { ...good, file: `factory-management-other-${sha256(invocationId).slice(0, 16)}.json` },
        ],
        expected: expectation,
        records: durable,
      },
      {
        label: "noncanonical timestamp",
        transcripts: [altered((record) => (record.startedAt = "2026-09-15 18:00:01Z"))],
        expected: expectation,
        records: durable,
      },
      {
        label: "wrong requested profile",
        transcripts: [
          altered((record) => {
            (record.request as { requestedProfile: string | null }).requestedProfile =
              "unexpected-profile";
            (record.request.selection as { profile: unknown }).profile = {
              availability: "observed",
              value: "unexpected-profile",
            };
          }),
        ],
        expected: expectation,
        records: durable,
      },
      {
        label: "self-consistent wrong cwd",
        transcripts: [altered((record) => (record.request.cwd = "/private/other-fixture"))],
        expected: expectation,
        records: durable,
      },
      {
        label: "wrong transport",
        transcripts: [altered((record) => (record.request.transport = "structured-adapter"))],
        expected: expectation,
        records: durable,
      },
      {
        label: "wrong requested model",
        transcripts: [altered((record) => (record.request.requestedModel = "other-model"))],
        expected: expectation,
        records: durable,
      },
      {
        label: "wrong requested reasoning",
        transcripts: [
          altered((record) => {
            record.request.requestedReasoning = "high";
            record.request.selection.reasoning.value = "high";
          }),
        ],
        expected: expectation,
        records: durable,
      },
      {
        label: "nonterminal response",
        transcripts: [altered((record) => (record.response.state = "pending"))],
        expected: expectation,
        records: durable,
      },
      {
        label: "substituted response and parsed response",
        transcripts: [substitutedResponse],
        expected: expectation,
        records: durable,
      },
      {
        label: "invalid stdout digest",
        transcripts: [altered((record) => (record.response.stdout.sha256 = "0".repeat(64)))],
        expected: expectation,
        records: durable,
      },
      {
        label: "spoofed prompt digest",
        transcripts: [altered((record) => (record.request.messages[2]!.sha256 = "0".repeat(64)))],
        expected: expectation,
        records: durable,
      },
      {
        label: "spoofed schema digest",
        transcripts: [altered((record) => (record.request.schemaSha256 = "0".repeat(64)))],
        expected: expectation,
        records: durable,
      },
      {
        label: "wrong pinned base prompt",
        transcripts: [
          altered((record) => {
            const prompt = `Compile another base ${"c".repeat(40)}.`;
            record.request.messages[2]!.content = prompt;
            record.request.messages[2]!.sha256 = sha256(prompt);
          }),
        ],
        expected: expectation,
        records: durable,
      },
      {
        label: "forbidden authority metadata in prompt",
        transcripts: [good],
        expected: transcriptExpectation([invocationId], {
          forbiddenPromptFragments: [BASE_SHA],
        }),
        records: durable,
      },
      {
        label: "missing durable request provenance",
        transcripts: [good],
        expected: expectation,
        records: durable.map((record) => {
          const candidate = structuredClone(record);
          if (candidate.kind === "invocation") delete candidate.payload.expectedProvenance;
          return candidate;
        }),
      },
      {
        label: "mismatched durable prompt provenance",
        transcripts: [good],
        expected: expectation,
        records: durable.map((record) => {
          const candidate = structuredClone(record);
          if (candidate.kind === "result") {
            const provenance = candidate.payload.provenance as { promptDigest: string };
            provenance.promptDigest = "0".repeat(64);
          }
          return candidate;
        }),
      },
      {
        label: "mismatched usage",
        transcripts: [altered((record) => (record.response.usage!.inputTokens = 11))],
        expected: expectation,
        records: durable,
      },
      {
        label: "invented cached usage",
        transcripts: [altered((record) => (record.response.usage!.cachedInputTokens = 0))],
        expected: expectation,
        records: durable,
      },
      {
        label: "duplicate invocation transcript",
        transcripts: [good, structuredClone(good)],
        expected: expectation,
        records: durable,
      },
      {
        label: "preexisting transcript",
        transcripts: [good],
        expected: transcriptExpectation([invocationId], {
          preexistingFiles: new Set([good.file]),
        }),
        records: durable,
      },
      {
        label: "wrong durable run binding",
        transcripts: [good],
        expected: transcriptExpectation([invocationId], { durableRunId: "another-run" }),
        records: durable,
      },
    ];
    for (const testCase of cases) {
      expect(
        issue404TerminalTranscriptEvidence(
          testCase.transcripts,
          testCase.records,
          testCase.expected,
        ),
        testCase.label,
      ).toBeNull();
    }
  });

  it("binds the documented omitted-obligation transformation without retaining raw output", () => {
    const invocationId = "compiler-omitted-obligation";
    const usage = { inputTokens: 10, outputTokens: 2 };
    const transcript = transcriptFile(invocationId, 0, {
      ...usage,
      cachedInputTokens: null,
    });
    const durable = durablePair(invocationId, 0, usage);
    const result = durable.find((record) => record.kind === "result")!;
    const raw = structuredClone(transcript.record.response.parsedResponse.value) as {
      workItems: Array<{ obligationIds: string[] }>;
    };
    const retained = structuredClone(raw);
    for (const item of retained.workItems)
      item.obligationIds = item.obligationIds.filter((id) => id !== "OBL-001");
    result.payload.value = null;
    result.payload.error = "mechanical validation rejected the proposal";
    result.payload.proposal = retained;
    result.payload.validationReport = {
      status: "repairable",
      violations: [
        {
          code: "unmapped-obligation",
          expected: "OBL-001",
          observed: null,
        },
      ],
    };

    expect(
      issue404TerminalTranscriptEvidence(
        [transcript],
        durable,
        transcriptExpectation([invocationId]),
      ),
    ).toBeNull();
    const qualified = issue404TerminalTranscriptEvidence(
      [transcript],
      durable,
      transcriptExpectation([invocationId], {
        responseTransformations: [
          {
            stage: "compile",
            revision: 0,
            kind: "omit-obligation",
            obligationId: "OBL-001",
          },
        ],
      }),
    );
    expect(qualified).toEqual([
      expect.objectContaining({
        modelInvocationId: invocationId,
        stage: "compile",
        revision: 0,
        responseSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    ]);
    expect(JSON.stringify(qualified)).not.toContain("clockgrove.factory/compiler-proposal");
  });

  it("distinguishes observed cached tokens from unavailable counters", () => {
    const records: Issue404TokenRecord[] = [
      {
        kind: "result",
        payload: {
          stage: "compile",
          revision: 0,
          usage: { inputTokens: 10, outputTokens: 2, cachedInputTokens: 4 },
        },
      },
      {
        kind: "result",
        payload: {
          stage: "judge",
          revision: 0,
          usage: { inputTokens: 7, outputTokens: 3 },
        },
      },
    ];
    expect(issue404TokenUsageByStage(records)).toEqual([
      expect.objectContaining({
        tokens: expect.objectContaining({
          cachedInputTokens: 4,
          cachedInputAvailability: "observed",
        }),
      }),
      expect.objectContaining({
        tokens: expect.objectContaining({
          cachedInputTokens: null,
          cachedInputAvailability: "unknown",
        }),
      }),
    ]);
    expect(issue404AggregateTokenUsage(records)).toMatchObject({
      availability: "observed",
      inputTokens: 17,
      outputTokens: 5,
      observedInputTokens: 17,
      observedOutputTokens: 5,
      cachedInputTokens: null,
      cachedInputAvailability: "unknown",
      totalTokens: 22,
    });

    records.push({ kind: "result", payload: { stage: "repair", revision: 1, usage: null } });
    expect(issue404AggregateTokenUsage(records)).toMatchObject({
      availability: "partial",
      inputTokens: null,
      outputTokens: null,
      observedInputTokens: 17,
      observedOutputTokens: 5,
      cachedInputTokens: null,
      cachedInputAvailability: "unknown",
      totalTokens: null,
    });
  });

  it("excludes proven local terminals from exact provider token accounting", () => {
    const records = [
      ...durablePair(
        "compiler-provider-compile",
        0,
        { inputTokens: 10, outputTokens: 2, cachedInputTokens: 4 },
        "compile",
      ),
      ...durablePair(
        "compiler-provider-judge",
        0,
        { inputTokens: 7, outputTokens: 3, cachedInputTokens: 2 },
        "judge",
      ),
      ...preProviderTerminalPair("compiler-local-repair"),
    ];
    expect(issue404InvocationTerminalEvidence(records).preProviderTerminals).toEqual([
      expect.objectContaining({
        invocationId: "compiler-local-repair",
        stopReason: "compiler request is unsatisfiable",
      }),
    ]);
    expect(issue404TokenUsageByStage(records)).toEqual([
      {
        stage: "compile",
        revision: 0,
        tokens: {
          availability: "observed",
          inputTokens: 10,
          outputTokens: 2,
          cachedInputTokens: 4,
          cachedInputAvailability: "observed",
          cachedInputIsIncludedInInput: true,
          totalTokens: 12,
        },
      },
      {
        stage: "judge",
        revision: 0,
        tokens: {
          availability: "observed",
          inputTokens: 7,
          outputTokens: 3,
          cachedInputTokens: 2,
          cachedInputAvailability: "observed",
          cachedInputIsIncludedInInput: true,
          totalTokens: 10,
        },
      },
    ]);
    expect(issue404AggregateTokenUsage(records)).toEqual({
      availability: "observed",
      inputTokens: 17,
      outputTokens: 5,
      observedInputTokens: 17,
      observedOutputTokens: 5,
      cachedInputTokens: 6,
      cachedInputAvailability: "observed",
      totalTokens: 22,
    });
  });
});
