import { createHash } from "node:crypto";
import { ManagementOutputError } from "../management/backend.js";

import { z } from "zod";

import type {
  ManagementUsage,
  ReviewCheckpoint,
  ReviewResult,
  SemanticReview,
} from "../management/backend.js";
import { gitSha, sha256Digest } from "../protocol/limits.js";
import type { CompiledGraphStore } from "./graphs.js";
import type { LeaseManager, LeaseState } from "./lease.js";

const REVIEW_PATH = ".clockgrove-factory/control/semantic-review.json";

const ReviewIdentitySchema = z
  .object({
    kind: z.enum(["artifact", "rebase"]),
    runId: z.string().min(1).max(200),
    objective: z.number().int().positive(),
    workItem: z.number().int().positive(),
    attempt: z.number().int().positive(),
    artifactDigest: sha256Digest,
    baseSha: gitSha,
    outputTreeSha: gitSha,
    evidenceDigest: sha256Digest,
    headSha: gitSha.optional(),
  })
  .strict()
  .superRefine((value, issue) => {
    if ((value.kind === "rebase") !== Boolean(value.headSha)) {
      issue.addIssue({
        code: "custom",
        path: ["headSha"],
        message: "headSha is required only for rebased semantic reviews",
      });
    }
  });

const SemanticReviewSchema = z
  .object({
    accepted: z.boolean(),
    summary: z.string().min(1).max(8_000),
    unmetCriteria: z.array(z.string().max(2_000)).max(64),
    risks: z.array(z.string().max(2_000)).max(64),
  })
  .strict();

const UsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
  })
  .strict();

const ReviewReceiptSchema = z
  .object({
    protocol: z.literal("clockgrove.factory/review-checkpoint-v1"),
    identityDigest: sha256Digest,
    identity: ReviewIdentitySchema,
    review: SemanticReviewSchema,
    usage: UsageSchema,
  })
  .strict();

export type ReviewIdentity = z.infer<typeof ReviewIdentitySchema>;
export type ReviewReceipt = z.infer<typeof ReviewReceiptSchema>;

export interface ReviewCheckpointRecord {
  ref: string;
  commitOid: string;
  blobOid: string;
  identityDigest: string;
  identity: ReviewIdentity;
  review: SemanticReview;
  usage: ManagementUsage;
}

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

export class ReviewCheckpointManager {
  constructor(
    private readonly store: CompiledGraphStore,
    private readonly leases: LeaseManager,
  ) {}

  async load(identityInput: ReviewIdentity): Promise<ReviewCheckpointRecord | null> {
    const identity = ReviewIdentitySchema.parse(identityInput);
    const identityDigest = reviewIdentityDigest(identity);
    const ref = reviewCheckpointRef(identity);
    const commitOid = await this.store.readRef(ref);
    if (!commitOid) return null;
    const commit = await this.store.readCommit(commitOid);
    const blobOid = await this.store.readTreeEntry(commit.treeOid, REVIEW_PATH);
    if (!blobOid) throw new Error(`${ref} has no semantic review receipt`);
    const bytes = await this.store.readBlob(blobOid);
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

  async persist(args: {
    lease: LeaseState;
    identity: ReviewIdentity;
    result: ReviewResult;
  }): Promise<ReviewCheckpointRecord> {
    await this.leases.assertCurrent(args.lease);
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
    const existing = await this.load(identity);
    if (existing) {
      if (!sameResult(existing, receipt)) {
        throw new Error("semantic input already has a different immutable review result");
      }
      return existing;
    }
    const bytes = Buffer.from(canonical(receipt), "utf8");
    const blobOid = await this.store.createBlob(bytes);
    const treeOid = await this.store.createTree({
      entries: [{ path: REVIEW_PATH, mode: "100644", type: "blob", sha: blobOid }],
    });
    const commitOid = await this.store.createCommit({
      treeOid,
      parentOids: [identity.baseSha],
      message:
        `Factory semantic review for Work Item #${identity.workItem}\n\n` +
        `Factory-Review-Identity: ${identityDigest}`,
    });
    await this.leases.assertCurrent(args.lease);
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
