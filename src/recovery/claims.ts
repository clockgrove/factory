import { z } from "zod";

import type { CompiledGraphReadStore, CompiledGraphStore } from "../control/graphs.js";
import type { LeaseManager, LeaseState } from "../control/lease.js";
import { type FactoryEvent, parseFactoryEvent } from "../protocol/events.js";
import { assertNoSecretMaterial } from "../protocol/limits.js";
import type { RecoveryClaimObservation } from "./chain.js";
import { recoveryClaimRef, recoveryEventDigest } from "./identity.js";
import {
  loadRecoveryPlan,
  parseRecoveryPlan,
  recoveryPlanDigest,
  recoveryPlanRef,
  type RecoveryPlan,
  type RecoveryPlanRecord,
} from "./plan.js";

export const RECOVERY_CLAIM_PROTOCOL = "clockgrove.factory/recovery-claim-v1" as const;
export const MAX_RECOVERY_CLAIM_BYTES = 16 * 1024;
const CLAIM_PATH = ".clockgrove-factory/control/recovery-claim.json";
const identifier = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9._:/+-]+$/);
const sha = z.string().regex(/^[0-9a-f]{40}$/);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const positive = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const transactionSchema = z
  .object({
    at: z.string().datetime({ offset: true }),
    startSequence: positive.max(Number.MAX_SAFE_INTEGER - 2),
    evidenceDigest: digest,
    accountingDigest: digest,
    resourceEvidenceDigest: digest,
  })
  .strict();
export type RecoveryClaimTransaction = z.infer<typeof transactionSchema>;
const claimSchema = z
  .object({
    protocol: z.literal(RECOVERY_CLAIM_PROTOCOL),
    repository: z
      .string()
      .max(200)
      .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    repositoryId: identifier,
    objective: positive,
    objectiveNodeId: identifier,
    requestId: identifier,
    requestDigest: digest,
    requestSequence: positive,
    planDigest: digest,
    planRef: z.string().max(512),
    planCommitOid: sha,
    planBlobOid: sha,
    predecessorRunId: identifier,
    predecessorTerminalDigest: digest,
    successorRunId: identifier,
    expectedBaseSha: sha,
    policyDigest: digest,
    transaction: transactionSchema,
  })
  .strict();

/** A pending immutable claim is evidence to reconcile, never permission to launch. */
export type RecoveryClaim = z.infer<typeof claimSchema>;
export interface RecoveryClaimRecord extends RecoveryClaim, RecoveryClaimObservation {
  blobOid: string;
}
/** Must originate from a complete reader-authenticated snapshot, not a supplied event body. */
export type AuthenticatedRecoveryRequest = Extract<FactoryEvent, { event: "RecoveryRequested" }>;

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

function requireClaim(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Invalid recovery claim: ${message}`);
}

function parseClaim(input: unknown): RecoveryClaim {
  const payload = claimSchema.parse(input);
  requireClaim(payload.predecessorRunId !== payload.successorRunId, "successor must be distinct");
  requireClaim(
    payload.transaction.startSequence > payload.requestSequence,
    "transaction must follow authenticated request",
  );
  requireClaim(
    payload.planRef === recoveryPlanRef(payload.objective, payload.planDigest),
    "plan reference scope mismatch",
  );
  const encoded = canonical(payload);
  requireClaim(
    Buffer.byteLength(encoded, "utf8") <= MAX_RECOVERY_CLAIM_BYTES,
    "document exceeds 16 KiB",
  );
  assertNoSecretMaterial(encoded, "recovery claim");
  return payload;
}

function assertPlanBinding(claim: RecoveryClaim, record: RecoveryPlanRecord): void {
  const plan = record.plan;
  requireClaim(
    claim.repository === plan.repository &&
      claim.repositoryId === plan.repositoryId &&
      claim.objective === plan.objective &&
      claim.objectiveNodeId === plan.objectiveNodeId &&
      claim.requestId === plan.requestId &&
      claim.planDigest === record.digest &&
      claim.planRef === record.ref &&
      claim.planCommitOid === record.commitOid &&
      claim.planBlobOid === record.blobOid &&
      claim.predecessorRunId === plan.predecessor.runId &&
      claim.predecessorTerminalDigest === plan.predecessor.terminalDigest &&
      claim.successorRunId === plan.successorRunId &&
      claim.expectedBaseSha === plan.expectedBaseSha &&
      claim.policyDigest === plan.policyDigest &&
      claim.requestSequence > plan.sourceEventMaxSequence,
    "immutable plan binding mismatch",
  );
}

function payloadFor(
  plan: RecoveryPlan,
  record: RecoveryPlanRecord,
  request: AuthenticatedRecoveryRequest,
  transaction: RecoveryClaimTransaction,
): RecoveryClaim {
  const parsed = parseFactoryEvent(request);
  requireClaim(parsed.event === "RecoveryRequested", "authenticated recovery request is required");
  requireClaim(
    parsed.objective === plan.objective &&
      parsed.repository.toLowerCase() === plan.repository.toLowerCase() &&
      parsed.requestId === plan.requestId &&
      parsed.runId === plan.predecessor.runId &&
      parsed.predecessorRunId === plan.predecessor.runId &&
      parsed.predecessorTerminalDigest === plan.predecessor.terminalDigest &&
      parsed.successorRunId === plan.successorRunId &&
      parsed.planDigest === record.digest &&
      parsed.policyDigest === plan.policyDigest &&
      parsed.baseSha === plan.expectedBaseSha &&
      parsed.sequence > plan.sourceEventMaxSequence,
    "authenticated request does not acknowledge this exact plan",
  );
  return parseClaim({
    protocol: RECOVERY_CLAIM_PROTOCOL,
    repository: plan.repository,
    repositoryId: plan.repositoryId,
    objective: plan.objective,
    objectiveNodeId: plan.objectiveNodeId,
    requestId: plan.requestId,
    requestDigest: recoveryEventDigest(parsed),
    requestSequence: parsed.sequence,
    planDigest: record.digest,
    planRef: record.ref,
    planCommitOid: record.commitOid,
    planBlobOid: record.blobOid,
    predecessorRunId: plan.predecessor.runId,
    predecessorTerminalDigest: plan.predecessor.terminalDigest,
    successorRunId: plan.successorRunId,
    expectedBaseSha: plan.expectedBaseSha,
    policyDigest: plan.policyDigest,
    transaction,
  });
}

export async function loadRecoveryClaim(
  store: CompiledGraphReadStore,
  objective: number,
  predecessorRunId: string,
): Promise<RecoveryClaimRecord | null> {
  const ref = recoveryClaimRef(objective, predecessorRunId);
  const oid = await store.readRef(ref);
  if (!oid) return null;
  const commit = await store.readCommit(oid);
  requireClaim(commit.oid === oid, "stored commit identity mismatch");
  const blobOid = await store.readTreeEntry(commit.treeOid, CLAIM_PATH);
  requireClaim(blobOid, "stored claim blob is missing");
  const bytes = await store.readBlob(blobOid);
  requireClaim(bytes.byteLength <= MAX_RECOVERY_CLAIM_BYTES, "stored document exceeds 16 KiB");
  const payload = parseClaim(JSON.parse(bytes.toString("utf8")));
  requireClaim(
    payload.objective === objective && payload.predecessorRunId === predecessorRunId,
    "stored claim scope mismatch",
  );
  requireClaim(
    bytes.toString("utf8") === canonical(payload),
    "stored claim is not canonically encoded",
  );
  requireClaim(
    commit.parentOids.length === 1 && commit.parentOids[0] === payload.planCommitOid,
    "stored claim parent does not bind immutable plan",
  );
  const plan = await loadRecoveryPlan(store, objective, payload.planDigest);
  requireClaim(plan, "claimed immutable plan is unavailable");
  assertPlanBinding(payload, plan);
  return { ...payload, ref, oid, blobOid };
}

function assertSameClaim(record: RecoveryClaimRecord, expected: RecoveryClaim): void {
  // Strip observation fields only; the strict parser rejects every unexpected payload field.
  const { ref: _ref, oid: _oid, blobOid: _blobOid, ...payload } = record;
  requireClaim(
    canonical(payload) === canonical(expected),
    "predecessor already claimed by another exact request or plan",
  );
}

/** Rechecks an independently loaded claim against the exact reader-authenticated acknowledgement. */
export function assertRecoveryClaimBinding(args: {
  claim: RecoveryClaimRecord;
  planRecord: RecoveryPlanRecord;
  authenticatedRequest: AuthenticatedRecoveryRequest;
}): void {
  const plan = parseRecoveryPlan(args.planRecord.plan);
  requireClaim(
    args.planRecord.digest === recoveryPlanDigest(plan) &&
      args.planRecord.ref === recoveryPlanRef(plan.objective, args.planRecord.digest),
    "plan record identity mismatch",
  );
  sha.parse(args.planRecord.commitOid);
  sha.parse(args.planRecord.blobOid);
  requireClaim(
    args.claim.ref === recoveryClaimRef(plan.objective, plan.predecessor.runId),
    "claim reference identity mismatch",
  );
  sha.parse(args.claim.oid);
  sha.parse(args.claim.blobOid);
  const expected = payloadFor(
    plan,
    args.planRecord,
    args.authenticatedRequest,
    args.claim.transaction,
  );
  assertSameClaim(args.claim, expected);
}

/** Atomically records one pending successor claim. It does not consume authority or start a run. */
export class RecoveryClaimManager {
  constructor(
    private readonly store: CompiledGraphStore,
    private readonly leases: Pick<LeaseManager, "assertCurrent">,
  ) {}

  load(objective: number, predecessorRunId: string): Promise<RecoveryClaimRecord | null> {
    return loadRecoveryClaim(this.store, objective, predecessorRunId);
  }

  async claim(args: {
    lease: LeaseState;
    planRecord: RecoveryPlanRecord;
    authenticatedRequest: AuthenticatedRecoveryRequest;
    transaction: RecoveryClaimTransaction;
  }): Promise<RecoveryClaimRecord> {
    const plan = parseRecoveryPlan(args.planRecord.plan);
    requireClaim(
      args.lease.objective === plan.objective &&
        args.lease.runId === plan.successorRunId &&
        args.lease.policyDigest === plan.policyDigest,
      "successor lease scope mismatch",
    );
    requireClaim(
      args.planRecord.digest === recoveryPlanDigest(plan),
      "supplied plan digest mismatch",
    );
    await this.leases.assertCurrent(args.lease);
    const stored = await loadRecoveryPlan(this.store, plan.objective, args.planRecord.digest);
    requireClaim(
      stored && canonical(stored) === canonical(args.planRecord),
      "supplied plan record differs from immutable storage",
    );
    const payload = payloadFor(plan, stored, args.authenticatedRequest, args.transaction);
    const existing = await this.load(plan.objective, plan.predecessor.runId);
    if (existing) {
      assertSameClaim(existing, payload);
      return existing;
    }
    await this.leases.assertCurrent(args.lease);
    const blobOid = await this.store.createBlob(Buffer.from(canonical(payload), "utf8"));
    await this.leases.assertCurrent(args.lease);
    const treeOid = await this.store.createTree({
      entries: [{ path: CLAIM_PATH, mode: "100644", type: "blob", sha: blobOid }],
    });
    await this.leases.assertCurrent(args.lease);
    const oid = await this.store.createCommit({
      treeOid,
      parentOids: [stored.commitOid],
      message: `Factory pending recovery claim for Objective #${plan.objective}\n\nFactory-Recovery-Plan: ${stored.digest}`,
    });
    const ref = recoveryClaimRef(plan.objective, plan.predecessor.runId);
    await this.leases.assertCurrent(args.lease);
    try {
      await this.store.createRef(ref, oid);
    } catch (error) {
      const observed = await this.load(plan.objective, plan.predecessor.runId);
      if (!observed) throw error;
      assertSameClaim(observed, payload);
      return observed;
    }
    const observed = await this.load(plan.objective, plan.predecessor.runId);
    requireClaim(observed, "claim ref creation was not observed");
    assertSameClaim(observed, payload);
    return observed;
  }
}
