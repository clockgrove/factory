import type { FactoryEvent } from "../protocol/events.js";
import { createHash } from "node:crypto";
import { ManagementOutputError, ReviewCheckoutCleanupError } from "../management/backend.js";
import { preserveProviderQuotaError, ProviderQuotaError } from "../providers/quota.js";

import type { z } from "zod";

import type {
  ManagementUsage,
  ReviewCheckpoint,
  ReviewResult,
  SemanticReview,
} from "../management/backend.js";
import { ReviewIdentitySchema, ReviewReceiptSchema } from "../protocol/result-checkpoints.js";
import { gitBlobOid, type CompiledGraphReadStore, type CompiledGraphStore } from "./graphs.js";
import type { LeaseManager, LeaseState } from "./lease.js";

import {
  canonicalResult,
  persistResultCheckpoint,
  readResultCheckpoint,
  resultReadStore,
  readResultSelection,
  resultReceiptLocator,
  type CommentResultLocator,
  type ResultTransition,
  type ResultReceipt,
} from "./result-receipts.js";

const REVIEW_PATH = ".clockgrove-factory/control/semantic-review.json";

export type ReviewIdentity = z.infer<typeof ReviewIdentitySchema>;
export type ReviewReceipt = z.infer<typeof ReviewReceiptSchema>;

export type ReviewCheckpointRecord = (
  | {
      ref: string;
      commitOid: string;
      blobOid: string;
      locator?: undefined;
      resultReceipt?: undefined;
      resultEvents?: undefined;
    }
  | {
      locator: CommentResultLocator;
      resultReceipt: ResultReceipt;
      resultEvents: FactoryEvent[];
      ref?: undefined;
      commitOid?: undefined;
      blobOid?: undefined;
    }
) & {
  identityDigest: string;
  identity: ReviewIdentity;
  review: SemanticReview;
  usage: ManagementUsage;
};

export type ReviewFaultPoint =
  | "after-model-result"
  | "after-checkpoint"
  | "after-budget-reconciled"
  | "after-outcome-receipt";

/** Replays every fallible projection after the immutable paid-result checkpoint. */
export async function runDurableReviewTransaction(args: {
  existing: ReviewCheckpointRecord | null;
  invoke?: (checkpoint: ReviewCheckpoint) => Promise<ReviewResult>;
  persist: (result: ReviewResult) => Promise<ReviewCheckpointRecord>;
  recover: () => Promise<ReviewCheckpointRecord | null>;
  recordUsage: (record: ReviewCheckpointRecord) => Promise<void>;
  recordFailureUsage?: (usage: ManagementUsage) => Promise<void>;
  recordProviderGate?: (error: ProviderQuotaError) => Promise<void>;
  recordOutcome: (record: ReviewCheckpointRecord) => Promise<void>;
  fault?: (point: ReviewFaultPoint) => Promise<void> | void;
}): Promise<ReviewCheckpointRecord> {
  let record = args.existing;
  if (!record) {
    if (!args.invoke) throw new Error("no semantic review checkpoint or invocation is available");
    try {
      await args.invoke(async (result) => {
        record = await args.persist(result);
      });
      if (!record) {
        throw new Error(
          "management backend returned without durably checkpointing its semantic review",
        );
      }
    } catch (error) {
      record = await args.recover();
      if (!record) {
        if (error instanceof ManagementOutputError) await args.recordFailureUsage?.(error.usage);
        if (error instanceof ProviderQuotaError) {
          try {
            await args.recordProviderGate?.(error);
          } catch (cause) {
            throw preserveProviderQuotaError(
              error,
              cause,
              "provider-refusal adapter and semantic-review transaction checkpoints both failed",
            );
          }
        }
        if (error instanceof ReviewCheckoutCleanupError && error.usage)
          await args.recordFailureUsage?.(error.usage);
        throw error;
      }
      if (error instanceof ReviewCheckoutCleanupError) {
        await args.recordUsage(record);
        throw error;
      }
    }
    await args.fault?.("after-model-result");
  }
  await args.fault?.("after-checkpoint");
  await args.recordUsage(record);
  await args.fault?.("after-budget-reconciled");
  await args.recordOutcome(record);
  await args.fault?.("after-outcome-receipt");
  return record;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function reviewIdentityDigest(input: ReviewIdentity): string {
  const identity = ReviewIdentitySchema.parse(input);
  return createHash("sha256").update(canonical(identity)).digest("hex");
}

export function reviewCheckpointRef(input: ReviewIdentity): string {
  const identity = ReviewIdentitySchema.parse(input);
  return (
    `refs/clockgrove-factory/reviews/objective-${identity.objective}/` +
    `work-item-${identity.workItem}/attempt-${identity.attempt}/` +
    `${identity.kind}-${reviewIdentityDigest(identity)}`
  );
}

function sameResult(left: ReviewCheckpointRecord, right: ReviewReceipt): boolean {
  return (
    left.identityDigest === right.identityDigest &&
    canonical(left.review) === canonical(right.review) &&
    canonical(left.usage) === canonical(right.usage)
  );
}

export async function loadReviewCheckpoint(
  store: CompiledGraphReadStore,
  identityInput: ReviewIdentity,
): Promise<ReviewCheckpointRecord | null> {
  const identity = ReviewIdentitySchema.parse(identityInput);
  const identityDigest = reviewIdentityDigest(identity);
  const receiptStore = resultReadStore(store);
  if (receiptStore) {
    const selected = await readResultSelection(receiptStore, {
      objective: identity.objective,
      runId: identity.runId,
      workItem: identity.workItem,
      kind: "review",
      identityDigest,
    });
    if (selected.protocol) {
      let winner: ReviewCheckpointRecord | null = null;
      for (const record of selected.receipts) {
        const receipt = ReviewReceiptSchema.parse(
          await readResultCheckpoint(store, record, identity.baseSha, 64 * 1024),
        );
        if (
          receipt.identityDigest !== identityDigest ||
          canonicalResult(receipt.identity) !== canonicalResult(identity)
        ) {
          throw new Error("review result has a different immutable identity");
        }

        const candidate: ReviewCheckpointRecord = {
          locator: resultReceiptLocator(record),
          resultReceipt: record.receipt,
          resultEvents: record.events,
          identityDigest,
          identity,
          review: receipt.review,
          usage: receipt.usage,
        };
        if (winner && canonicalResult(winner.review) !== canonicalResult(candidate.review)) {
          throw new Error("conflicting authenticated review checkpoints");
        }
        if (winner && canonicalResult(winner.usage) !== canonicalResult(candidate.usage))
          throw new Error("conflicting authenticated review usage");
        if (
          winner?.locator &&
          candidate.locator &&
          winner.locator.receiptDigest !== candidate.locator.receiptDigest
        )
          throw new Error("conflicting authenticated result receipt identities");
        winner ??= candidate;
      }
      return winner;
    }
  }
  const ref = reviewCheckpointRef(identity);
  const commitOid = await store.readRef(ref);
  if (!commitOid) return null;
  const commit = await (store.readCommitContent?.(commitOid) ?? store.readCommit(commitOid));
  const blobOid = await store.readTreeEntry(commit.treeOid, REVIEW_PATH);
  if (!blobOid) throw new Error(`${ref} has no semantic review receipt`);
  const bytes = await store.readBlob(blobOid);
  if (bytes.byteLength > 64 * 1024) {
    throw new Error("persisted semantic review receipt exceeds 64 KiB");
  }
  const receipt = ReviewReceiptSchema.parse(JSON.parse(bytes.toString("utf8")));
  if (
    receipt.identityDigest !== identityDigest ||
    canonical(receipt.identity) !== canonical(identity)
  ) {
    throw new Error("semantic review checkpoint has a different immutable identity");
  }
  return {
    ref,
    commitOid,
    blobOid,
    identityDigest,
    identity,
    review: receipt.review,
    usage: receipt.usage,
  };
}

export class ReviewCheckpointManager {
  constructor(
    private readonly store: CompiledGraphStore,
    private readonly leases: LeaseManager,
  ) {}

  async load(identityInput: ReviewIdentity): Promise<ReviewCheckpointRecord | null> {
    return loadReviewCheckpoint(this.store, identityInput);
  }

  async persist(args: {
    lease: LeaseState;
    identity: ReviewIdentity;
    result: ReviewResult;
    transition?: undefined;
  }): Promise<Extract<ReviewCheckpointRecord, { ref: string }>>;
  async persist(args: {
    lease: LeaseState;
    identity: ReviewIdentity;
    result: ReviewResult;
    transition: ResultTransition;
  }): Promise<ReviewCheckpointRecord>;
  async persist(args: {
    lease: LeaseState;
    identity: ReviewIdentity;
    result: ReviewResult;
    transition?: ResultTransition | undefined;
  }): Promise<ReviewCheckpointRecord> {
    await this.leases.assertMutationAuthorized(args.lease);
    const identity = ReviewIdentitySchema.parse(args.identity);
    if (identity.objective !== args.lease.objective || identity.runId !== args.lease.runId) {
      throw new Error("semantic review identity is fenced from the current lease");
    }
    const identityDigest = reviewIdentityDigest(identity);
    const receipt = ReviewReceiptSchema.parse({
      protocol: "clockgrove.factory/review-checkpoint-v1",
      identityDigest,
      identity,
      review: args.result.review,
      usage: args.result.usage,
    });
    if (args.transition) {
      const record = await persistResultCheckpoint({
        store: this.store,
        leases: this.leases,
        lease: args.lease,
        scope: {
          objective: identity.objective,
          runId: identity.runId,
          workItem: identity.workItem,
          kind: "review",
          identityDigest,
        },
        transition: args.transition,
        checkpoint: receipt,
        baseSha: identity.baseSha,
        maxBytes: 64 * 1024,
      });
      return {
        locator: resultReceiptLocator(record),
        resultReceipt: record.receipt,
        resultEvents: record.events,
        identityDigest,
        identity,
        review: receipt.review,
        usage: receipt.usage,
      };
    }
    const selection = await resultReadStore(this.store)?.readResultReceipts({
      objective: identity.objective,
      runId: identity.runId,
      workItem: identity.workItem,
      kind: "review",
      identityDigest: identityDigest,
    });
    if (selection?.protocol)
      throw new Error("transition receipt run requires explicit result transition");
    const existing = await this.load(identity);
    if (existing) {
      if (!sameResult(existing, receipt)) {
        throw new Error("semantic input already has a different immutable review result");
      }
      return existing;
    }
    const bytes = Buffer.from(canonical(receipt), "utf8");
    const blobOid = gitBlobOid(bytes);
    const treeOid = await this.store.createTree({
      entries: [
        { path: REVIEW_PATH, mode: "100644", type: "blob", content: bytes.toString("utf8") },
      ],
    });
    const commitOid = await this.store.createCommit({
      treeOid,
      parentOids: [identity.baseSha],
      message:
        `Factory semantic review for Work Item #${identity.workItem}\n\n` +
        `Factory-Review-Identity: ${identityDigest}`,
    });
    await this.leases.assertMutationAuthorized(args.lease);
    const ref = reviewCheckpointRef(identity);
    let won: boolean;
    try {
      won = await this.store.createRef(ref, commitOid);
    } catch (error) {
      const winner = await this.load(identity);
      if (winner && sameResult(winner, receipt)) return winner;
      throw error;
    }
    if (!won) {
      const winner = await this.load(identity);
      if (!winner || !sameResult(winner, receipt)) {
        throw new Error("another writer persisted a divergent semantic review result");
      }
      return winner;
    }
    return {
      ref,
      commitOid,
      blobOid,
      identityDigest,
      identity,
      review: receipt.review,
      usage: receipt.usage,
    };
  }
}

export type ReviewCheckpointLocation = {
  identityDigest: string;
} & (
  | { ref: string; commitOid: string; blobOid: string; locator?: undefined }
  | { locator: CommentResultLocator; ref?: undefined; commitOid?: undefined; blobOid?: undefined }
);

export function reviewCheckpointLocation(record: ReviewCheckpointRecord): ReviewCheckpointLocation {
  return record.locator
    ? { locator: record.locator, identityDigest: record.identityDigest }
    : {
        ref: record.ref,
        commitOid: record.commitOid,
        blobOid: record.blobOid,
        identityDigest: record.identityDigest,
      };
}

export function sameReviewCheckpointLocation(
  left: ReviewCheckpointLocation | null | undefined,
  right: ReviewCheckpointLocation,
): boolean {
  return Boolean(
    left &&
      canonicalResult(reviewCheckpointLocation(left as ReviewCheckpointRecord)) ===
        canonicalResult(reviewCheckpointLocation(right as ReviewCheckpointRecord)),
  );
}

export async function assertReviewCheckpointBase(
  store: Pick<CompiledGraphReadStore, "readCommit" | "readCommitContent">,
  record: ReviewCheckpointRecord,
  baseSha: string,
): Promise<void> {
  if (record.identity.baseSha !== baseSha) throw new Error("review checkpoint base differs");
  if (record.locator) return; // The actor-authenticated comment binds the complete immutable identity.
  const commit = await (store.readCommitContent?.(record.commitOid) ??
    store.readCommit(record.commitOid));
  if (commit.parentOids.length !== 1 || commit.parentOids[0] !== baseSha)
    throw new Error("review commit base differs");
}
