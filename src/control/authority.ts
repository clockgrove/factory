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

export function writerAuthority(lease: LeaseState, sequence: number): WriterAuthority {
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new Error("writer operation sequence must be a non-negative safe integer");
  }
  const writerOperationId = createHash("sha256")
    .update(
      JSON.stringify([
        lease.objective,
        lease.runId,
        lease.holder,
        lease.epoch,
        lease.policyDigest,
        sequence,
      ]),
    )
    .digest("hex");
  return {
    writerOperationId,
    writerHolder: lease.holder,
    writerEpoch: lease.epoch,
    writerPolicyDigest: lease.policyDigest,
  };
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
