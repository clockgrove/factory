import { describe, expect, it } from "vitest";

import {
  SANDBOX_CODEX_PACKAGE,
  sandboxBootstrapFiles,
  sandboxValidationFiles,
} from "../src/backends/sandbox-common.js";
import { normalizeArtifact } from "../src/execution/artifacts.js";
import type { AttemptContext, IsolatedValidationContext } from "../src/execution/backend.js";

const SHA = "a".repeat(40);

function context(): AttemptContext {
  return {
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
        os: ["linux"], architecture: ["x64"], tools: ["git", "node"],
        services: [], networkDestinations: [], permittedSecretNames: [], trust: "isolated",
      },
      artifactContract: "clockgrove.factory/artifact-v1",
    },
  };
}

describe("sandbox bootstrap contracts", () => {
  it("pins the worker CLI and never embeds host credentials", () => {
    const rendered = sandboxBootstrapFiles(context(), Buffer.from("archive"))
      .map((file) => file.content.toString("utf8"))
      .join("\n");
    expect(rendered).toContain(SANDBOX_CODEX_PACKAGE);
    expect(rendered).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(rendered).toContain('web_search="disabled"');
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
