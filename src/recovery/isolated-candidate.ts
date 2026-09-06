import { validationInvocationOwnership } from "../backends/validation-invocation.js";
import { mergeCandidateIdentityDigest, type MergeCandidateCheckpointRecord, type MergeCandidateIdentity } from "../control/merge-candidates.js";
import type { FactoryEvent } from "../protocol/events.js";
import { policyDigest } from "../protocol/policy.js";

function requireProof(value: unknown): asserts value {
  if (!value) throw new Error("isolated candidate resource or accounting proof unavailable");
}

/** A pending remote reservation remains a liability, not proof of any completed work. */
export function assertIsolatedCandidateReservation(input: {
  repository: string;
  sourceRunId: string;
  identity: MergeCandidateIdentity;
  reservation: Extract<FactoryEvent, { kind: "capacity" }>;
  events: readonly FactoryEvent[];
}): void {
  const { identity, reservation } = input;
  const metadata = reservation.isolatedValidation;
  requireProof(metadata && reservation.phase === "validation" && !reservation.localScopeBatch &&
    reservation.runId === identity.runId && reservation.objective === identity.objective &&
    reservation.workItem === identity.workItem && reservation.attempt === identity.attempt &&
    reservation.sourceRunId === input.sourceRunId && input.sourceRunId !== identity.runId &&
    reservation.targetBaseSha === identity.targetBaseSha &&
    reservation.backend === `factory/integration-sandbox-${mergeCandidateIdentityDigest(identity)}` &&
    Date.parse(metadata.noHandleReplacementNotBefore) === Date.parse(metadata.deadline) + 60_000 &&
    (reservation.event !== "CapacityReserved" || Date.parse(metadata.deadline) > Date.parse(reservation.at)));
  const starts = input.events.filter((event) => event.event === "FactoryRunStarted" &&
    event.runId === identity.runId && event.objective === identity.objective);
  const start = starts[0];
  requireProof(starts.length === 1 && start?.event === "FactoryRunStarted" &&
    start.repository.toLowerCase() === input.repository.toLowerCase() &&
    start.policyDigest === reservation.policyDigest && policyDigest(start.policy) === start.policyDigest &&
    start.policy.allowedPaidBackends.includes("codex-cli/daytona") && start.policy.maxSandboxMinutes > 0 &&
    Date.parse(metadata.deadline) <= Date.parse(start.at) + start.policy.objectiveTimeoutMinutes * 60_000);
  requireProof(metadata.invocationOwnershipDigest === validationInvocationOwnership({
    repository: input.repository, objective: identity.objective, workItem: identity.workItem,
    attempt: identity.attempt, runId: identity.runId, directorEpoch: reservation.directorEpoch,
    policyDigest: reservation.policyDigest, phase: "validation",
    validationInvocation: { kind: "integration-candidate", identityDigest: mergeCandidateIdentityDigest(identity),
      artifactDigest: metadata.artifactDigest, baseSha: identity.targetBaseSha },
  }));
}

/**
 * Additional evidence for an independently loaded immutable candidate. Events
 * must be the caller's complete authenticated history, never provider self-report.
 * This does not observe current resource absence or grant admission authority.
 */
export function assertIsolatedCandidateProof(input: {
  repository: string;
  sourceRunId: string;
  candidate: MergeCandidateCheckpointRecord;
  events: readonly FactoryEvent[];
  beforeSequence?: number;
  /** Checkpoint/capacity/native receipt writes are separate durable boundaries. */
  requireAccounting?: boolean;
}): void {
  const { candidate } = input;
  const identity = candidate.identity;
  const digest = mergeCandidateIdentityDigest(identity);
  const events = input.events.filter((event) => event.runId === identity.runId &&
    event.objective === identity.objective &&
    (input.beforeSequence === undefined || event.sequence < input.beforeSequence));
  const capacity = events.filter((event) => event.kind === "capacity" &&
    event.workItem === identity.workItem && event.attempt === identity.attempt &&
    event.backend === `factory/integration-sandbox-${digest}`);
  if (!candidate.isolatedResource && !capacity.length) return;
  const resource = candidate.isolatedResource;
  const reserves = capacity.filter((event) => event.event === "CapacityReserved");
  const reserved = reserves[0];
  requireProof(resource && reserves.length === 1 && reserved?.kind === "capacity" &&
    !reserved.localScopeBatch && resource.backend === "codex-cli/daytona");
  const adopted = input.sourceRunId !== identity.runId;
  requireProof(adopted ? reserved.sourceRunId === input.sourceRunId &&
    reserved.targetBaseSha === identity.targetBaseSha : !reserved.sourceRunId);
  const starts = events.filter((event) => event.event === "FactoryRunStarted");
  const start = starts[0];
  requireProof(starts.length === 1 && start?.event === "FactoryRunStarted" &&
    start.repository.toLowerCase() === input.repository.toLowerCase() &&
    start.policyDigest === reserved.policyDigest && policyDigest(start.policy) === start.policyDigest &&
    start.policy.allowedPaidBackends.includes("codex-cli/daytona") && start.policy.maxSandboxMinutes > 0);
  const ownership = validationInvocationOwnership({
    repository: input.repository,
    objective: identity.objective,
    workItem: identity.workItem,
    attempt: identity.attempt,
    runId: identity.runId,
    directorEpoch: reserved.directorEpoch,
    policyDigest: reserved.policyDigest,
    phase: "validation",
    validationInvocation: { kind: "integration-candidate", identityDigest: digest,
      artifactDigest: candidate.validation.artifactDigest, baseSha: identity.targetBaseSha },
  });
  requireProof(resource.invocationOwnershipDigest === ownership &&
    Number.isSafeInteger(resource.sandboxMilliseconds) && resource.sandboxMilliseconds >= 0 &&
    Date.parse(resource.completedAt) - Date.parse(resource.startedAt) === resource.sandboxMilliseconds);
  if (adopted) {
    assertIsolatedCandidateReservation({ ...input, identity, reservation: reserved });
    const metadata = reserved.isolatedValidation;
    requireProof(metadata && metadata.backend === resource.backend &&
      metadata.artifactDigest === candidate.validation.artifactDigest &&
      metadata.invocationOwnershipDigest === ownership);
  } else {
    // The original same-run protocol uses the original reservation's ownership
    // tuple. Do not retrospectively invent successor metadata for that receipt.
    const attempts = events.filter((event) => event.event === "AttemptReserved" &&
      event.workItem === identity.workItem && event.attempt === identity.attempt);
    requireProof(attempts.length === 1 && attempts[0]?.event === "AttemptReserved" &&
      attempts[0].directorEpoch === reserved.directorEpoch &&
      attempts[0].policyDigest === reserved.policyDigest);
  }
  const reconciled = capacity.filter((event) => event.event === "CapacityReconciled");
  requireProof(reconciled.length <= 1 && reconciled.every((event) => event.kind === "capacity" &&
    event.sequence > reserved.sequence && event.sourceRunId === reserved.sourceRunId &&
    event.targetBaseSha === reserved.targetBaseSha && event.policyDigest === reserved.policyDigest &&
    event.directorEpoch === reserved.directorEpoch && event.requestedCpu === reserved.requestedCpu &&
    event.requestedMemoryMb === reserved.requestedMemoryMb && !event.localScopeBatch &&
    (!adopted || JSON.stringify(event.isolatedValidation) === JSON.stringify(reserved.isolatedValidation))));
  const budget = events.filter((event) => event.kind === "budget" &&
    event.workItem === identity.workItem && event.attempt === (adopted ? undefined : identity.attempt) &&
    event.phase === "validation" && event.unit === "sandbox_milliseconds" &&
    event.usageId === `integration-validation-${digest}`);
  const allocations = budget.filter((event) => event.event === "BudgetReserved");
  const allocation = allocations[0];
  requireProof(allocations.length === 1 && allocation?.kind === "budget" &&
    allocation.sequence > reserved.sequence && allocation.amount > 0 &&
    allocation.amount <= start.policy.maxSandboxMinutes * 60_000 &&
    (allocation.policyDigest === undefined || allocation.policyDigest === reserved.policyDigest) &&
    (allocation.directorEpoch === undefined || allocation.directorEpoch === reserved.directorEpoch));
  if (adopted)
    // The writer derives this upper deadline from the capacity's captured server
    // timestamp before either append. Later HTTP Date headers are not a clock
    // authority for that earlier admission and may have different precision.
    requireProof(Date.parse(reserved.isolatedValidation!.deadline) - Date.parse(reserved.at) <= allocation.amount);
  const usage = budget.filter((event) => event.event === "BudgetReconciled");
  requireProof(usage.every((event) => event.kind === "budget" && event.sequence > allocation.sequence &&
    event.amount === resource.sandboxMilliseconds &&
    (event.policyDigest === undefined || event.policyDigest === reserved.policyDigest) &&
    (event.directorEpoch === undefined || event.directorEpoch === reserved.directorEpoch)));
  if (input.requireAccounting !== false) requireProof(reconciled.length === 1 && usage.length > 0);
}
