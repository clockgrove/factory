import { describe, expect, it, vi } from "vitest";

import type { CompiledGraphReadStore } from "../src/control/graphs.js";
import {
  loadReviewCheckpoint,
  reviewCheckpointRef,
  reviewIdentityDigest,
  type ReviewIdentity,
  type ReviewReceipt,
} from "../src/control/reviews.js";

const identity: ReviewIdentity = {
  kind: "rebase",
  runId: "source-run",
  objective: 7,
  workItem: 8,
  attempt: 1,
  artifactDigest: "a".repeat(64),
  baseSha: "b".repeat(40),
  outputTreeSha: "c".repeat(40),
  evidenceDigest: "d".repeat(64),
  headSha: "e".repeat(40),
};

function fixture() {
  const receipt: ReviewReceipt = {
    protocol: "clockgrove.factory/review-checkpoint-v1",
    identityDigest: reviewIdentityDigest(identity),
    identity,
    review: { accepted: true, summary: "Criteria checked.", unmetCriteria: [], risks: [] },
    usage: { inputTokens: 20, outputTokens: 3, cachedInputTokens: 10 },
  };
  const readRef = vi.fn(async (_ref: string): Promise<string | null> => "1".repeat(40));
  const readCommit = vi.fn(async (_oid: string) => ({
    oid: "1".repeat(40),
    treeOid: "2".repeat(40),
    parentOids: [identity.baseSha],
    message: "review fixture",
    serverTime: new Date("2026-09-04T00:00:00Z"),
  }));
  const readTreeEntry = vi.fn(
    async (_tree: string, _path: string): Promise<string | null> => "3".repeat(40),
  );
  const readBlob = vi.fn(async (_oid: string) => Buffer.from(JSON.stringify(receipt)));
  const store: CompiledGraphReadStore = Object.freeze({
    readRef,
    readCommit,
    readTreeEntry,
    readBlob,
  });
  return { receipt, store, readRef, readCommit, readTreeEntry, readBlob };
}

describe("read-only semantic review checkpoint", () => {
  it("loads exact acceptance and reported usage with only four read methods and no lease", async () => {
    const { store, receipt, readRef, readTreeEntry } = fixture();
    expect(Object.isFrozen(store)).toBe(true);
    await expect(loadReviewCheckpoint(store, identity)).resolves.toEqual({
      ref: reviewCheckpointRef(identity),
      commitOid: "1".repeat(40),
      blobOid: "3".repeat(40),
      identityDigest: receipt.identityDigest,
      identity,
      review: receipt.review,
      usage: receipt.usage,
    });
    expect(readRef).toHaveBeenCalledExactlyOnceWith(reviewCheckpointRef(identity));
    expect(readTreeEntry).toHaveBeenCalledExactlyOnceWith(
      "2".repeat(40),
      ".clockgrove-factory/control/semantic-review.json",
    );
  });

  it("returns absence without further reads, but preserves unavailable-read errors", async () => {
    const { store, readRef, readCommit, readBlob } = fixture();
    readRef.mockResolvedValueOnce(null);
    await expect(loadReviewCheckpoint(store, identity)).resolves.toBeNull();
    expect(readCommit).not.toHaveBeenCalled();
    expect(readBlob).not.toHaveBeenCalled();
    const unavailable = new Error("unavailable");
    readRef.mockRejectedValueOnce(unavailable);
    await expect(loadReviewCheckpoint(store, identity)).rejects.toBe(unavailable);
  });

  it.each([
    { runId: "another-run" },
    { objective: 9 },
    { workItem: 10 },
    { attempt: 2 },
    { artifactDigest: "f".repeat(64) },
    { baseSha: "f".repeat(40) },
    { outputTreeSha: "f".repeat(40) },
    { evidenceDigest: "f".repeat(64) },
    { headSha: "f".repeat(40) },
  ])("rejects a checkpoint redirected from another exact input: %j", async (changed) => {
    const { store } = fixture();
    await expect(loadReviewCheckpoint(store, { ...identity, ...changed })).rejects.toThrow(
      "different immutable identity",
    );
  });

  it("preserves rejection and absent usage counters instead of treating existence as acceptance", async () => {
    const { store, receipt } = fixture();
    receipt.review.accepted = false;
    receipt.review.unmetCriteria = ["Required behavior absent."];
    delete receipt.usage.cachedInputTokens;
    const result = await loadReviewCheckpoint(store, identity);
    expect(result?.review.accepted).toBe(false);
    expect(result?.usage).not.toHaveProperty("cachedInputTokens");
  });

  it("validates the requested identity before reading GitHub", async () => {
    const { store, readRef } = fixture();
    await expect(loadReviewCheckpoint(store, { ...identity, kind: "artifact" })).rejects.toThrow();
    expect(readRef).not.toHaveBeenCalled();
  });

  it("rejects a missing blob, oversized receipt, bad digest, and invalid cache counters", async () => {
    const { store, readTreeEntry, readBlob, receipt } = fixture();
    readTreeEntry.mockResolvedValueOnce(null);
    await expect(loadReviewCheckpoint(store, identity)).rejects.toThrow(
      "no semantic review receipt",
    );
    readBlob.mockResolvedValueOnce(Buffer.alloc(64 * 1024 + 1));
    await expect(loadReviewCheckpoint(store, identity)).rejects.toThrow("exceeds 64 KiB");
    receipt.identityDigest = "f".repeat(64);
    await expect(loadReviewCheckpoint(store, identity)).rejects.toThrow(
      "different immutable identity",
    );
    receipt.identityDigest = reviewIdentityDigest(identity);
    receipt.usage.cachedInputTokens = 21;
    await expect(loadReviewCheckpoint(store, identity)).rejects.toThrow(
      "cached input tokens cannot exceed input tokens",
    );
  });
});
