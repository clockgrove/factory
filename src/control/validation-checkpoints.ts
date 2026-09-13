import type { FactoryEvent } from "../protocol/events.js";
import { createHash } from "node:crypto";

import type { z } from "zod";

import {
  ValidationIdentitySchema,
  ValidationCheckpointSchema,
} from "../protocol/result-checkpoints.js";
import { verifyValidationEvidence, type ValidationEvidence } from "../validation/evidence.js";
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

const CHECKPOINT_PATH = ".clockgrove-factory/control/validation.json";
const MAX_CHECKPOINT_BYTES = 512 * 1024;

export type ValidationIdentity = z.infer<typeof ValidationIdentitySchema>;

export type ValidationCheckpointRecord = (
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
  identity: ValidationIdentity;
  writerEpoch: number;
  evidence: ValidationEvidence;
};

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

export function validationIdentityDigest(input: ValidationIdentity): string {
  return createHash("sha256")
    .update(canonical(ValidationIdentitySchema.parse(input)))
    .digest("hex");
}

export function validationCheckpointRef(input: ValidationIdentity): string {
  const identity = ValidationIdentitySchema.parse(input);
  return (
    `refs/clockgrove-factory/validations/objective-${identity.objective}/` +
    `work-item-${identity.workItem}/attempt-${identity.attempt}/` +
    `validation-${validationIdentityDigest(identity)}`
  );
}

function assertBinding(
  identity: ValidationIdentity,
  evidence: ValidationEvidence,
  writerEpoch: number,
): void {
  verifyValidationEvidence(evidence);
  if (
    evidence.artifactDigest !== identity.artifactDigest ||
    evidence.baseSha !== identity.baseSha ||
    writerEpoch < identity.directorEpoch
  ) {
    throw new Error("validation checkpoint differs from its immutable attempt identity");
  }
}

function sameCheckpoint(record: ValidationCheckpointRecord, evidence: ValidationEvidence): boolean {
  return canonical(record.evidence) === canonical(evidence);
}

export async function loadValidationCheckpoint(
  store: CompiledGraphReadStore,
  identityInput: ValidationIdentity,
): Promise<ValidationCheckpointRecord | null> {
  const identity = ValidationIdentitySchema.parse(identityInput);
  const identityDigest = validationIdentityDigest(identity);
  const receiptStore = resultReadStore(store);
  if (receiptStore) {
    const selected = await readResultSelection(receiptStore, {
      objective: identity.objective,
      runId: identity.runId,
      workItem: identity.workItem,
      kind: "validation",
      identityDigest,
    });
    if (selected.protocol) {
      let winner: ValidationCheckpointRecord | null = null;
      for (const record of selected.receipts) {
        const receipt = ValidationCheckpointSchema.parse(
          await readResultCheckpoint(store, record, identity.baseSha, MAX_CHECKPOINT_BYTES),
        );
        if (
          receipt.identityDigest !== identityDigest ||
          canonicalResult(receipt.identity) !== canonicalResult(identity)
        ) {
          throw new Error("validation result has a different immutable identity");
        }
        assertBinding(identity, receipt.evidence, receipt.writerEpoch);
        if (
          receipt.writerEpoch !== record.receipt.writerEpoch ||
          identity.policyDigest !== record.receipt.writerPolicyDigest
        )
          throw new Error("validation writer binding differs");
        const candidate: ValidationCheckpointRecord = {
          locator: resultReceiptLocator(record),
          resultReceipt: record.receipt,
          resultEvents: record.events,
          identityDigest,
          identity,
          writerEpoch: receipt.writerEpoch,
          evidence: receipt.evidence,
        };
        if (winner && canonicalResult(winner.evidence) !== canonicalResult(candidate.evidence)) {
          throw new Error("conflicting authenticated validation checkpoints");
        }

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
  const ref = validationCheckpointRef(identity);
  const commitOid = await store.readRef(ref);
  if (!commitOid) return null;
  const commit = await (store.readCommitContent?.(commitOid) ?? store.readCommit(commitOid));
  if (
    commit.oid !== commitOid ||
    commit.parentOids.length !== 1 ||
    commit.parentOids[0] !== identity.baseSha
  ) {
    throw new Error("validation checkpoint commit differs from its immutable base");
  }
  const blobOid = await store.readTreeEntry(commit.treeOid, CHECKPOINT_PATH);
  if (!blobOid) throw new Error(`${ref} has no validation checkpoint`);
  const bytes = await store.readBlob(blobOid);
  if (bytes.byteLength > MAX_CHECKPOINT_BYTES) {
    throw new Error("persisted validation checkpoint exceeds 512 KiB");
  }
  const receipt = ValidationCheckpointSchema.parse(JSON.parse(bytes.toString("utf8")));
  if (
    receipt.identityDigest !== identityDigest ||
    canonical(receipt.identity) !== canonical(identity)
  ) {
    throw new Error("validation checkpoint has a different immutable identity");
  }
  assertBinding(identity, receipt.evidence, receipt.writerEpoch);
  return {
    ref,
    commitOid,
    blobOid,
    identityDigest,
    identity,
    writerEpoch: receipt.writerEpoch,
    evidence: receipt.evidence,
  };
}

export class ValidationCheckpointManager {
  constructor(
    private readonly store: CompiledGraphStore,
    private readonly leases: LeaseManager,
  ) {}

  load(identity: ValidationIdentity): Promise<ValidationCheckpointRecord | null> {
    return loadValidationCheckpoint(this.store, identity);
  }

  async persist(args: {
    lease: LeaseState;
    identity: ValidationIdentity;
    evidence: ValidationEvidence;
    transition?: undefined;
  }): Promise<Extract<ValidationCheckpointRecord, { ref: string }>>;
  async persist(args: {
    lease: LeaseState;
    identity: ValidationIdentity;
    evidence: ValidationEvidence;
    transition: ResultTransition;
  }): Promise<ValidationCheckpointRecord>;
  async persist(args: {
    lease: LeaseState;
    identity: ValidationIdentity;
    evidence: ValidationEvidence;
    transition?: ResultTransition | undefined;
  }): Promise<ValidationCheckpointRecord> {
    await this.leases.assertMutationAuthorized(args.lease);
    const identity = ValidationIdentitySchema.parse(args.identity);
    if (
      identity.objective !== args.lease.objective ||
      identity.runId !== args.lease.runId ||
      identity.policyDigest !== args.lease.policyDigest ||
      identity.directorEpoch > args.lease.epoch
    ) {
      throw new Error("validation checkpoint identity is fenced from the current lease");
    }
    assertBinding(identity, args.evidence, args.lease.epoch);
    if (args.transition) {
      const identityDigest = validationIdentityDigest(identity);
      const receipt = ValidationCheckpointSchema.parse({
        protocol: "clockgrove.factory/validation-checkpoint-v1",
        identityDigest,
        identity,
        writerEpoch: args.lease.epoch,
        evidence: args.evidence,
      });
      const record = await persistResultCheckpoint({
        store: this.store,
        leases: this.leases,
        lease: args.lease,
        scope: {
          objective: identity.objective,
          runId: identity.runId,
          workItem: identity.workItem,
          kind: "validation",
          identityDigest,
        },
        transition: args.transition,
        checkpoint: receipt,
        baseSha: identity.baseSha,
        maxBytes: MAX_CHECKPOINT_BYTES,
      });
      return {
        locator: resultReceiptLocator(record),
        resultReceipt: record.receipt,
        resultEvents: record.events,
        identityDigest,
        identity,
        writerEpoch: record.receipt.writerEpoch,
        evidence: args.evidence,
      };
    }
    const selection = await resultReadStore(this.store)?.readResultReceipts({
      objective: identity.objective,
      runId: identity.runId,
      workItem: identity.workItem,
      kind: "validation",
      identityDigest: validationIdentityDigest(identity),
    });
    if (selection?.protocol)
      throw new Error("transition receipt run requires explicit result transition");
    const existing = await this.load(identity);
    if (existing) {
      if (!sameCheckpoint(existing, args.evidence)) {
        throw new Error("attempt already has a different immutable validation checkpoint");
      }
      return existing;
    }
    const identityDigest = validationIdentityDigest(identity);
    const receipt = ValidationCheckpointSchema.parse({
      protocol: "clockgrove.factory/validation-checkpoint-v1",
      identityDigest,
      identity,
      writerEpoch: args.lease.epoch,
      evidence: args.evidence,
    });
    const bytes = Buffer.from(canonical(receipt), "utf8");
    if (bytes.byteLength > MAX_CHECKPOINT_BYTES) {
      throw new Error("validation checkpoint exceeds 512 KiB");
    }
    const blobOid = gitBlobOid(bytes);
    const treeOid = await this.store.createTree({
      entries: [
        { path: CHECKPOINT_PATH, mode: "100644", type: "blob", content: bytes.toString("utf8") },
      ],
    });
    const commitOid = await this.store.createCommit({
      treeOid,
      parentOids: [identity.baseSha],
      message:
        `Factory validation for Work Item #${identity.workItem}\n\n` +
        `Factory-Validation-Identity: ${identityDigest}`,
    });
    await this.leases.assertMutationAuthorized(args.lease);
    const ref = validationCheckpointRef(identity);
    try {
      const won = await this.store.createRef(ref, commitOid);
      if (won) {
        return {
          ref,
          commitOid,
          blobOid,
          identityDigest,
          identity,
          writerEpoch: args.lease.epoch,
          evidence: args.evidence,
        };
      }
    } catch (error) {
      const winner = await this.load(identity);
      if (winner && sameCheckpoint(winner, args.evidence)) return winner;
      throw error;
    }
    const winner = await this.load(identity);
    if (!winner || !sameCheckpoint(winner, args.evidence)) {
      throw new Error("another writer persisted a divergent validation checkpoint");
    }
    return winner;
  }
}
