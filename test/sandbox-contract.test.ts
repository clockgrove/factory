import { describe, expect, it } from "vitest";

import {
  MAX_ISOLATED_VALIDATION_RESULT_BYTES,
  SANDBOX_CODEX_PACKAGE,
  parseIsolatedValidationResult,
  sandboxBootstrapFiles,
  sandboxResourceName,
  sandboxValidationFiles,
} from "../src/backends/sandbox-common.js";
import { normalizeArtifact } from "../src/execution/artifacts.js";
import type { AttemptContext, IsolatedValidationContext } from "../src/execution/backend.js";
import { assertIsolatedValidationMatchesPlan } from "../src/validation/clean-run.js";

const SHA = "a".repeat(40);

function context(): AttemptContext {
  return {
    repository: "clockgrove/factory",
    objective: 1,
    workItem: 2,
    attempt: 3,
    runId: "run-123",
    directorEpoch: 1,
    policyDigest: "b".repeat(64),
    workspace: "/not-shared",
    deadline: new Date("2026-09-03T01:00:00.000Z"),
    packet: {
      goal: "change one file",
      acceptanceCriteria: ["done"],
      allowedPaths: ["src/"],
      preconditions: [],
      outOfScope: [],
      conventions: [],
      baseSha: SHA,
      validationCommands: ["npm test"],
      requirements: {
        os: ["linux"],
        architecture: ["x64"],
        tools: ["git", "node"],
        services: [],
        networkDestinations: [],
        permittedSecretNames: [],
        trust: "isolated",
      },
      artifactContract: "clockgrove.factory/artifact-v1",
    },
  };
}

describe("sandbox bootstrap contracts", () => {
  it("derives distinct deterministic execution and validation resource names", () => {
    const execution = sandboxResourceName(context());
    const validation = sandboxResourceName(context(), "validation");
    expect(execution).toBe("factory-o1-w2-a3-run-123");
    expect(validation).toBe("factory-o1-w2-a3-run-123-validate");
    expect(
      sandboxResourceName({
        repository: "clockgrove/factory",
        objective: 1,
        workItem: 2,
        attempt: 3,
        runId: "run-123",
        directorEpoch: 1,
        phase: "validation",
      }),
    ).toBe(validation);
  });

  it("deeply validates and bounds isolated validation results", () => {
    const valid = {
      outputTreeSha: SHA,
      commands: [{ command: "npm test", exitCode: 0, durationMs: 12 }],
      passed: true,
      startedAt: "2026-09-03T00:00:00.000Z",
      completedAt: "2026-09-03T00:00:00.012Z",
    };
    expect(parseIsolatedValidationResult(Buffer.from(JSON.stringify(valid)))).toEqual(valid);
    expect(() =>
      parseIsolatedValidationResult(
        Buffer.from(
          JSON.stringify({ ...valid, commands: [{ ...valid.commands[0], exitCode: "0" }] }),
        ),
      ),
    ).toThrow(/malformed result/);
    expect(() =>
      parseIsolatedValidationResult(Buffer.alloc(MAX_ISOLATED_VALIDATION_RESULT_BYTES + 1, 0x20)),
    ).toThrow(/maximum size/);
  });

  it("rejects a provider claim that failed commands passed validation", () => {
    expect(() =>
      assertIsolatedValidationMatchesPlan(
        {
          outputTreeSha: SHA,
          commands: [{ command: "npm test", exitCode: 1, durationMs: 12 }],
          passed: true,
          startedAt: "2026-09-03T00:00:00.000Z",
          completedAt: "2026-09-03T00:00:00.012Z",
        },
        ["npm test"],
      ),
    ).toThrow(/failed command evidence as passing/);
  });

  it("pins the worker CLI and never embeds host credentials", () => {
    const rendered = sandboxBootstrapFiles(context(), Buffer.from("archive"))
      .map((file) => file.content.toString("utf8"))
      .join("\n");
    expect(rendered).toContain(SANDBOX_CODEX_PACKAGE);
    expect(rendered).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(rendered).toContain('web_search="disabled"');
    expect(rendered).toContain("git add --intent-to-add --all");
    expect(rendered).not.toContain("--approve-for-me");
    expect(rendered).not.toContain("ghp_");
    expect(rendered).not.toContain("GITHUB_TOKEN");
  });

  it("builds a validator without a model or GitHub credential", () => {
    const base = context();
    const validation: IsolatedValidationContext = {
      ...base,
      artifact: normalizeArtifact({
        baseSha: SHA,
        patch: "diff --git a/src/a.ts b/src/a.ts\n",
        changedPaths: ["src/a.ts"],
        outcome: "succeeded",
      }),
    };
    const rendered = sandboxValidationFiles(validation, Buffer.from("archive"))
      .map((file) => file.content.toString("utf8"))
      .join("\n");
    expect(rendered).toContain("npm ci --no-audit --no-fund");
    expect(rendered).toContain("package-lock.json");
    expect(rendered).toContain("npm test");
    expect(rendered).not.toContain("OPENAI_API_KEY");
    expect(rendered).not.toContain("GITHUB_TOKEN");
    expect(rendered).not.toContain("@openai/codex");
  });
});
