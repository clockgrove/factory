import {
  verifyExactHeadValidation,
  type ExactHeadValidationEvidence,
} from "../validation/plan.js";

export const INTEGRATION_LEASE_PROTOCOL =
  "clockgrove.factory/integration-lease-v1" as const;

export type IntegrationLeaseState =
  | "acquired"
  | "pending"
  | "failed"
  | "cancelled"
  | "rolled-back"
  | "completed";

export interface IntegrationLeaseSnapshot {
  state: IntegrationLeaseState;
  attempt: number;
  expectedHeads: Record<string, string>;
  evidence: Record<string, ExactHeadValidationEvidence>;
  asynchronousMergeUuid?: string;
  failureReason?: string;
}

export interface IntegrationJournalEntry {
  idempotencyKey: string;
  command: "pending" | "queued" | "fail" | "retry" | "cancel" | "rollback" | "complete";
  payload: string;
  before: IntegrationLeaseSnapshot;
}

export interface IntegrationLease {
  protocol: typeof INTEGRATION_LEASE_PROTOCOL;
  operationId: string;
  unitId: string;
  repositoryEpoch: number;
  state: IntegrationLeaseState;
  attempt: number;
  expectedHeads: Record<string, string>;
  originalHeads: Record<string, string>;
  evidence: Record<string, ExactHeadValidationEvidence>;
  asynchronousMergeUuid?: string;
  failureReason?: string;
  journal: IntegrationJournalEntry[];
}

export type IntegrationCommand =
  | { kind: "pending"; idempotencyKey: string; uuid: string }
  | { kind: "queued"; idempotencyKey: string }
  | { kind: "fail"; idempotencyKey: string; reason: string }
  | {
      kind: "retry";
      idempotencyKey: string;
      expectedHeads: Record<string, string>;
      evidence: Record<string, ExactHeadValidationEvidence>;
    }
  | { kind: "cancel"; idempotencyKey: string }
  | { kind: "rollback"; idempotencyKey: string }
  | { kind: "complete"; idempotencyKey: string };

function snapshot(lease: IntegrationLease): IntegrationLeaseSnapshot {
  return {
    state: lease.state,
    attempt: lease.attempt,
    expectedHeads: { ...lease.expectedHeads },
    evidence: { ...lease.evidence },
    ...(lease.asynchronousMergeUuid
      ? { asynchronousMergeUuid: lease.asynchronousMergeUuid }
      : {}),
    ...(lease.failureReason ? { failureReason: lease.failureReason } : {}),
  };
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

function assertHeadMap(
  expected: Record<string, string>,
  evidence: Record<string, ExactHeadValidationEvidence>,
): void {
  const keys = Object.keys(expected).sort();
  if (
    keys.length === 0 ||
    JSON.stringify(keys) !== JSON.stringify(Object.keys(evidence).sort())
  ) {
    throw new Error("integration lease heads and validation evidence differ");
  }
  for (const key of keys) {
    if (!/^[0-9a-f]{40}$/i.test(expected[key]!)) {
      throw new Error(`integration lease head for ${key} is invalid`);
    }
    verifyExactHeadValidation(evidence[key]!, expected[key]!);
  }
}

export function acquireIntegrationLease(args: {
  operationId: string;
  unitId: string;
  repositoryEpoch: number;
  expectedHeads: Record<string, string>;
  evidence: Record<string, ExactHeadValidationEvidence>;
  existing?: IntegrationLease;
}): IntegrationLease {
  assertHeadMap(args.expectedHeads, args.evidence);
  if (args.existing) {
    const same =
      args.existing.operationId === args.operationId &&
      args.existing.unitId === args.unitId &&
      args.existing.repositoryEpoch === args.repositoryEpoch &&
      JSON.stringify(args.existing.expectedHeads) === JSON.stringify(args.expectedHeads);
    if (!same) throw new Error("an incompatible integration lease already exists");
    assertHeadMap(args.existing.expectedHeads, args.existing.evidence);
    return args.existing;
  }
  if (!args.operationId || !args.unitId || args.repositoryEpoch < 1) {
    throw new Error("integration lease identity is invalid");
  }
  return {
    protocol: INTEGRATION_LEASE_PROTOCOL,
    operationId: args.operationId,
    unitId: args.unitId,
    repositoryEpoch: args.repositoryEpoch,
    state: "acquired",
    attempt: 1,
    expectedHeads: { ...args.expectedHeads },
    originalHeads: { ...args.expectedHeads },
    evidence: { ...args.evidence },
    journal: [],
  };
}

/** Reject any integration attempt whose live PR heads differ from its fence. */
export function assertIntegrationHeads(
  lease: IntegrationLease,
  observedHeads: Record<string, string>,
): void {
  assertHeadMap(lease.expectedHeads, lease.evidence);
  const expected = Object.entries(lease.expectedHeads).sort(([a], [b]) => a.localeCompare(b));
  const observed = Object.entries(observedHeads).sort(([a], [b]) => a.localeCompare(b));
  if (JSON.stringify(expected) !== JSON.stringify(observed)) {
    throw new Error("integration lease rejected stale or incomplete pull request heads");
  }
}

/**
 * Pure, journaled transition. Replaying an idempotency key is a no-op; the
 * immediately most-recent command can be undone to its exact prior snapshot.
 */
export function applyIntegrationCommand(
  lease: IntegrationLease,
  command: IntegrationCommand,
): IntegrationLease {
  const payload = canonical(command);
  const replay = lease.journal.find(
    (entry) => entry.idempotencyKey === command.idempotencyKey,
  );
  if (replay) {
    if (replay.command !== command.kind || replay.payload !== payload) {
      throw new Error("integration idempotency key was reused with different input");
    }
    return lease;
  }
  if (!command.idempotencyKey) throw new Error("integration command needs an idempotency key");
  if (lease.journal.length >= 64) throw new Error("integration command journal is full");
  const next: IntegrationLease = {
    ...lease,
    expectedHeads: { ...lease.expectedHeads },
    evidence: { ...lease.evidence },
    journal: [
      ...lease.journal,
      {
        idempotencyKey: command.idempotencyKey,
        command: command.kind,
        payload,
        before: snapshot(lease),
      },
    ],
  };
  if (command.kind === "pending") {
    if (lease.state !== "acquired") throw new Error(`cannot enqueue integration from ${lease.state}`);
    next.state = "pending";
    next.asynchronousMergeUuid = command.uuid;
    delete next.failureReason;
  } else if (command.kind === "queued") {
    if (lease.state !== "acquired") throw new Error(`cannot queue integration from ${lease.state}`);
    next.state = "pending";
    delete next.asynchronousMergeUuid;
    delete next.failureReason;
  } else if (command.kind === "fail") {
    if (!new Set<IntegrationLeaseState>(["acquired", "pending"]).has(lease.state)) {
      throw new Error(`cannot fail integration from ${lease.state}`);
    }
    next.state = "failed";
    next.failureReason = command.reason;
    delete next.asynchronousMergeUuid;
  } else if (command.kind === "retry") {
    if (!new Set<IntegrationLeaseState>(["failed", "cancelled", "rolled-back"]).has(lease.state)) {
      throw new Error(`cannot retry integration from ${lease.state}`);
    }
    assertHeadMap(command.expectedHeads, command.evidence);
    next.state = "acquired";
    next.attempt += 1;
    next.expectedHeads = { ...command.expectedHeads };
    next.evidence = { ...command.evidence };
    delete next.failureReason;
    delete next.asynchronousMergeUuid;
  } else if (command.kind === "cancel") {
    if (lease.state === "completed") throw new Error("cannot cancel completed integration");
    next.state = "cancelled";
    delete next.asynchronousMergeUuid;
  } else if (command.kind === "rollback") {
    if (!new Set<IntegrationLeaseState>(["failed", "cancelled"]).has(lease.state)) {
      throw new Error(`cannot roll back integration from ${lease.state}`);
    }
    next.state = "rolled-back";
    next.expectedHeads = { ...lease.originalHeads };
    delete next.asynchronousMergeUuid;
    delete next.failureReason;
  } else {
    if (!new Set<IntegrationLeaseState>(["acquired", "pending"]).has(lease.state)) {
      throw new Error(`cannot complete integration from ${lease.state}`);
    }
    next.state = "completed";
    delete next.asynchronousMergeUuid;
    delete next.failureReason;
  }
  return next;
}

export function undoIntegrationCommand(
  lease: IntegrationLease,
  idempotencyKey: string,
): IntegrationLease {
  const entry = lease.journal.at(-1);
  if (!entry || entry.idempotencyKey !== idempotencyKey) return lease;
  const restored: IntegrationLease = {
    ...lease,
    ...entry.before,
    expectedHeads: { ...entry.before.expectedHeads },
    evidence: { ...entry.before.evidence },
    journal: lease.journal.slice(0, -1),
  };
  if (!entry.before.asynchronousMergeUuid) delete restored.asynchronousMergeUuid;
  if (!entry.before.failureReason) delete restored.failureReason;
  return restored;
}
