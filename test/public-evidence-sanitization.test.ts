import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const directory = new URL("../docs/release-evidence/", import.meta.url);
const read = (name: string) => JSON.parse(readFileSync(new URL(name, directory), "utf8"));

describe("public qualification evidence", () => {
  it("does not expose private run/receipt identities or personal home directories", () => {
    for (const name of readdirSync(directory).filter((entry) => entry.endsWith(".json"))) {
      const text = readFileSync(new URL(name, directory), "utf8");
      const record = JSON.parse(text);
      for (const key of [
        "objectiveUrl",
        "runId",
        "retryOfRunId",
        "terminalReceipt",
        "deliveryReceipt",
      ]) {
        expect(
          record,
          `${name}: public evidence must use private-record digests`,
        ).not.toHaveProperty(key);
      }
      for (const match of text.matchAll(/\/(?:home|Users)\/([^/"\\\s]+)/g)) {
        expect(match[1], `${name}: home paths must be explicitly generic`).toBe("USER");
      }
      for (const match of text.matchAll(/https:\/\/github\.com\/([^/"\s]+\/[^/"\s]+)\/issues\//g)) {
        expect(match[1], `${name}: fixture issue identities belong in private evidence`).toBe(
          "clockgrove/factory",
        );
      }
    }
  });

  it("preserves original failure and accounting semantics after removing identifying fields", () => {
    const records = [
      ["local-objective-failure-2026-09-04.json", "unavailable", undefined],
      ["local-objective-stream-failure-2026-09-04.json", "observed", 29407],
      ["local-objective-command-failure-2026-09-04.json", "observed", 15125],
    ] as const;
    for (const [name, availability, tokens] of records) {
      const record = read(name);
      expect(record.outcome).toBe("failed");
      expect(record.terminalState).toBe("escalated");
      expect(record.releaseGatesClosed).toEqual([]);
      expect(record.testedCommit).toMatch(/^[a-f0-9]{40}$/);
      expect(record.mcpBundleSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(record.privateEvidence.originalRecordSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(record.modelUsage.availability).toBe(availability);
      expect(record.modelUsage.tokens).toBe(tokens);
    }
    const command = read("local-objective-command-failure-2026-09-04.json");
    const stream = read("local-objective-stream-failure-2026-09-04.json");
    expect(readFileSync(new URL(command.priorFailureRecord, directory), "utf8")).toBeTruthy();
    expect(readFileSync(new URL(stream.priorFailureRecord, directory), "utf8")).toBeTruthy();
  });

  it("identifies normalized commands without changing the original candidate outcome", () => {
    for (const [name, status, exitCode] of [
      ["final-suite-original-failure-2026-09-05.json", "failed", 2],
      ["integrated-completion-suite-2026-09-05.json", "passed", 0],
    ] as const) {
      const record = read(name);
      expect(record.command).toContain("CODEX_HOME=/home/USER/.codex");
      expect(record.commandNormalization).toContain("not a byte-for-byte command transcript");
      expect(record.originalRecordSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(record.candidateCommit).toMatch(/^[a-f0-9]{40}$/);
      expect(record.status).toBe(status);
      expect(record.exitCode).toBe(exitCode);
    }
  });
});
