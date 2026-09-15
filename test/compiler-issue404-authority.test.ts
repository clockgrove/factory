import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  issue404AggregateTokenUsage,
  issue404LiveAuthority,
  issue404TerminalTranscriptEvidence,
  issue404TokenUsageByStage,
  type Issue404LiveGitIdentity,
  type Issue404TokenRecord,
} from "./helpers/issue404-live-authority.js";

const SHA = "a".repeat(40);
const REPOSITORY = resolve("/private/factory");
const TRANSCRIPTS = resolve("/private/factory-evidence/issue-404");

function environment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    FACTORY_LIVE_OBJECTIVE: "1",
    FACTORY_LIVE_COMPILER_ISSUE404: "1",
    FACTORY_LIVE_COMPILER_ISSUE404_PAID_ACK: "consume-paid-compiler-evaluation",
    FACTORY_LIVE_COMPILER_ISSUE404_RUN_ID: "fresh-run-20260915",
    ISSUE404_CANDIDATE_SHA: SHA,
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
    expect(issue404LiveAuthority(environment(), REPOSITORY, inspect, assertWritable)).toEqual({
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
    ["exact SHA syntax", { ISSUE404_CANDIDATE_SHA: "main" }, "40-character commit SHA"],
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
      ),
    ).toThrow("archive is read-only");
  });

  it("requires one terminal transcript for every live invocation identity", () => {
    const records = [
      { file: "one.json", modelInvocationId: "call-1", responseState: "succeeded" },
      { file: "two.json", modelInvocationId: "call-2", responseState: "invalid-response" },
    ];
    expect(issue404TerminalTranscriptEvidence(records, ["call-1", "call-2"])).toEqual(records);
    expect(
      issue404TerminalTranscriptEvidence(
        [...records, { ...records[0]!, file: "duplicate.json" }],
        ["call-1", "call-2"],
      ),
    ).toBeNull();
    expect(
      issue404TerminalTranscriptEvidence(
        [{ ...records[0]!, responseState: "pending" }, records[1]!],
        ["call-1", "call-2"],
      ),
    ).toBeNull();
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
});
