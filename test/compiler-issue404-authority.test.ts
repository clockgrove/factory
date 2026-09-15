import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  issue404LiveAuthority,
  type Issue404LiveGitIdentity,
} from "./helpers/issue404-live-authority.js";

const SHA = "a".repeat(40);
const REPOSITORY = resolve("/private/factory");
const TRANSCRIPTS = resolve("/private/factory-evidence/issue-404");

function environment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    FACTORY_LIVE_OBJECTIVE: "1",
    FACTORY_LIVE_COMPILER_ISSUE404: "1",
    FACTORY_LIVE_COMPILER_ISSUE404_PAID_ACK: "consume-paid-compiler-evaluation",
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
    expect(issue404LiveAuthority(environment(), REPOSITORY, inspect)).toEqual({
      candidateSha: SHA,
      transcriptDirectory: TRANSCRIPTS,
    });
    expect(inspect).toHaveBeenCalledExactlyOnceWith(SHA);
  });

  it.each([
    ["objective opt-in", { FACTORY_LIVE_OBJECTIVE: "0" }, "FACTORY_LIVE_OBJECTIVE=1"],
    ["case opt-in", { FACTORY_LIVE_COMPILER_ISSUE404: "0" }, "FACTORY_LIVE_COMPILER_ISSUE404=1"],
    ["paid acknowledgement", { FACTORY_LIVE_COMPILER_ISSUE404_PAID_ACK: "yes" }, "PAID_ACK"],
    ["exact SHA syntax", { ISSUE404_CANDIDATE_SHA: "main" }, "40-character commit SHA"],
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
      issue404LiveAuthority(environment(overrides), REPOSITORY, () => identity()),
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
    expect(() => issue404LiveAuthority(environment(), REPOSITORY, () => observed)).toThrow(message);
  });
});
