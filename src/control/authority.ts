import { createHash } from "node:crypto";

import type { FactoryEvent } from "../protocol/events.js";
import type { LeaseState } from "./lease.js";

/** Current Director identity attached to a newly authored durable receipt. */
export interface WriterAuthority {
  writerOperationId: string;
  writerHolder: string;
  writerEpoch: number;
  writerPolicyDigest: string;
}

/** One bounded observation of the authoritative Objective lease ref. */
export interface ObjectiveAuthorityObservation {
  objective: number;
  runId: string;
  holder: string;
  epoch: number;
  policyDigest: string;
  sequence: number;
  oid: string;
  expiresAt: Date;
  observedAt: Date;
}

interface WriterIdentity {
  objective: number;
  runId: string;
  holder: string;
  epoch: number;
  policyDigest: string;
}

function writerOperationId(identity: WriterIdentity, sequence: number): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        identity.objective,
        identity.runId,
        identity.holder,
        identity.epoch,
        identity.policyDigest,
        sequence,
      ]),
    )
    .digest("hex");
}

function hasRecomputableWriterAuthority(event: FactoryEvent): boolean {
  const writer = completeWriterAuthority(event);
  return Boolean(
    writer &&
      writer.writerOperationId ===
        writerOperationId(
          {
            objective: event.objective,
            runId: event.runId,
            holder: writer.writerHolder,
            epoch: writer.writerEpoch,
            policyDigest: writer.writerPolicyDigest,
          },
          event.sequence,
        ),
  );
}

export function writerAuthority(lease: LeaseState, sequence: number): WriterAuthority {
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new Error("writer operation sequence must be a non-negative safe integer");
  }
  return {
    writerOperationId: writerOperationId(lease, sequence),
    writerHolder: lease.holder,
    writerEpoch: lease.epoch,
    writerPolicyDigest: lease.policyDigest,
  };
}

/** Require a complete writer envelope produced by the exact currently observed
 * Objective writer, including its deterministic operation identity. */
export function hasExactWriterAuthority(
  event: FactoryEvent,
  authority: ObjectiveAuthorityObservation,
): boolean {
  const writer = completeWriterAuthority(event);
  return Boolean(
    writer &&
      event.objective === authority.objective &&
      event.runId === authority.runId &&
      writer.writerHolder === authority.holder &&
      writer.writerEpoch === authority.epoch &&
      writer.writerPolicyDigest === authority.policyDigest &&
      writer.writerOperationId === writerOperationId(authority, event.sequence),
  );
}

/** Authenticate a durable receipt written by the current Objective writer or
 * any earlier writer generation. A historical generation keeps its own holder;
 * the currently observed epoch must use the current holder exactly. */
export function hasHistoricalWriterAuthority(
  event: FactoryEvent,
  authority: ObjectiveAuthorityObservation,
): boolean {
  const writer = completeWriterAuthority(event);
  return Boolean(
    writer &&
      event.objective === authority.objective &&
      event.runId === authority.runId &&
      writer.writerPolicyDigest === authority.policyDigest &&
      writer.writerEpoch <= authority.epoch &&
      (writer.writerEpoch < authority.epoch || writer.writerHolder === authority.holder) &&
      hasRecomputableWriterAuthority(event),
  );
}

export function objectiveAuthorityObservation(
  lease: LeaseState,
  observedAt: Date,
): ObjectiveAuthorityObservation {
  return {
    objective: lease.objective,
    runId: lease.runId,
    holder: lease.holder,
    epoch: lease.epoch,
    policyDigest: lease.policyDigest,
    sequence: lease.sequence,
    oid: lease.oid,
    expiresAt: new Date(lease.expiresAt),
    observedAt: new Date(observedAt),
  };
}

export function completeWriterAuthority(event: FactoryEvent): WriterAuthority | null {
  return typeof event.writerOperationId === "string" &&
    typeof event.writerHolder === "string" &&
    typeof event.writerEpoch === "number" &&
    typeof event.writerPolicyDigest === "string"
    ? {
        writerOperationId: event.writerOperationId,
        writerHolder: event.writerHolder,
        writerEpoch: event.writerEpoch,
        writerPolicyDigest: event.writerPolicyDigest,
      }
    : null;
}
