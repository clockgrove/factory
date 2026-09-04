import { describe, expect, it, vi } from "vitest";
import { ManagementOutputError } from "../src/management/backend.js";

import {
  runDurableReviewTransaction,
  type ReviewCheckpointRecord,
  type ReviewFaultPoint,
} from "../src/control/reviews.js";
import type { ReviewCheckpoint, ReviewResult } from "../src/management/backend.js";

const result: ReviewResult = {
  review: {
    accepted: true,
    summary: "All criteria are satisfied.",
    unmetCriteria: [],
    risks: [],
  },
  usage: { inputTokens: 13, outputTokens: 17 },
};

function checkpoint(kind: "artifact" | "rebase" = "artifact"): ReviewCheckpointRecord {
  const identityDigest = (kind === "artifact" ? "a" : "b").repeat(64);
  return {
    ref: `refs/clockgrove-factory/reviews/${identityDigest}`,
    commitOid: "c".repeat(40),
    blobOid: "d".repeat(40),
    identityDigest,
    identity: {
      kind,
      runId: "run-review",
      objective: 1,
      workItem: 2,
      attempt: 1,
      artifactDigest: "e".repeat(64),
      baseSha: "f".repeat(40),
      outputTreeSha: "1".repeat(40),
      evidenceDigest: "2".repeat(64),
      ...(kind === "rebase" ? { headSha: "3".repeat(40) } : {}),
    },
    ...result,
  };
}

describe("durable semantic review transaction", () => {
  it("accounts malformed paid review output without publishing an outcome", async () => {
    const recordFailureUsage = vi.fn();
    const recordOutcome = vi.fn();
    const recordUsage = vi.fn();
    const error = new ManagementOutputError(new Error("invalid review"), result.usage);
    await expect(
      runDurableReviewTransaction({
        existing: null,
        invoke: async () => {
          throw error;
        },
        persist: async () => checkpoint(),
        recover: async () => null,
        recordUsage,
        recordFailureUsage,
        recordOutcome,
      }),
    ).rejects.toBe(error);
    expect(recordFailureUsage).toHaveBeenCalledExactlyOnceWith(result.usage);
    expect(recordOutcome).not.toHaveBeenCalled();
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it("does not count a rejected call again when its immutable review checkpoint exists", async () => {
    const recordFailureUsage = vi.fn();
    const recordUsage = vi.fn();
    await runDurableReviewTransaction({
      existing: null,
      invoke: async () => {
        throw new ManagementOutputError(new Error("lost return"), result.usage);
      },
      persist: async () => checkpoint(),
      recover: async () => checkpoint(),
      recordUsage,
      recordFailureUsage,
      recordOutcome: async () => {},
    });
    expect(recordUsage).toHaveBeenCalledTimes(1);
    expect(recordFailureUsage).not.toHaveBeenCalled();
  });

  it.each<ReviewFaultPoint>([
    "after-model-result",
    "after-checkpoint",
    "after-budget-reconciled",
    "after-outcome-receipt",
  ])("restarts %s with one model invocation and one logical projection", async (point) => {
    let durable: ReviewCheckpointRecord | null = null;
    let invocations = 0;
    let armed = true;
    const usage = new Map<string, number>();
    const outcomes = new Set<string>();
    const invoke = async (save: ReviewCheckpoint) => {
      invocations += 1;
      await save(result);
      return result;
    };
    const run = () =>
      runDurableReviewTransaction({
        existing: durable,
        invoke,
        persist: async () => {
          durable = checkpoint();
          return durable;
        },
        recover: async () => durable,
        recordUsage: async (record) => {
          usage.set(`review-${record.identityDigest}`, 30);
        },
        recordOutcome: async (record) => {
          outcomes.add(`AttemptValidated:${record.identity.artifactDigest}`);
        },
        fault: async (observed) => {
          if (armed && observed === point) {
            armed = false;
            throw new Error(`fault ${point}`);
          }
        },
      });

    await expect(run()).rejects.toThrow(`fault ${point}`);
    await expect(run()).resolves.toMatchObject({ review: { accepted: true } });
    expect(invocations).toBe(1);
    expect([...usage.values()].reduce((sum, value) => sum + value, 0)).toBe(30);
    expect(usage.size).toBe(1);
    expect(outcomes.size).toBe(1);
  });

  it("keeps artifact and rebase usage identities distinct so their costs sum", async () => {
    const usage = new Map<string, number>();
    for (const kind of ["artifact", "rebase"] as const) {
      const saved = checkpoint(kind);
      await runDurableReviewTransaction({
        existing: saved,
        persist: async () => saved,
        recover: async () => saved,
        recordUsage: async (record) => {
          const prefix = record.identity.kind === "rebase" ? "rebase-review" : "review";
          usage.set(`${prefix}-${record.identityDigest}`, 30);
        },
        recordOutcome: async () => {},
      });
    }
    expect(usage.size).toBe(2);
    expect([...usage.values()].reduce((sum, value) => sum + value, 0)).toBe(60);
  });

  it("fills a partial rebase receipt set on restart without another review", async () => {
    let durable: ReviewCheckpointRecord | null = null;
    let invocations = 0;
    let interruptProjection = true;
    const receipts = new Set<string>();
    const expected = [
      "ValidationRecorded",
      "AttemptValidated",
      "AttemptPublished",
      "PublicationRecorded",
    ];
    const run = () =>
      runDurableReviewTransaction({
        existing: durable,
        invoke: async (save) => {
          invocations += 1;
          await save(result);
          return result;
        },
        persist: async () => {
          durable = checkpoint("rebase");
          return durable;
        },
        recover: async () => durable,
        recordUsage: async () => {},
        recordOutcome: async () => {
          for (const receipt of expected) {
            receipts.add(receipt);
            if (interruptProjection && receipt === "AttemptValidated") {
              interruptProjection = false;
              throw new Error("lost response after AttemptValidated");
            }
          }
        },
      });

    await expect(run()).rejects.toThrow("lost response after AttemptValidated");
    await expect(run()).resolves.toMatchObject({ identity: { kind: "rebase" } });
    expect(invocations).toBe(1);
    expect([...receipts]).toEqual(expected);
  });
});
