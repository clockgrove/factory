import type { FactoryEvent } from "../protocol/events.js";
import { unreconciledBudgetReservations } from "./budget.js";
import { unreconciledCapacityReservations } from "../scheduling/capacity-ledger.js";
import { deduplicateFactoryEvents } from "./receipts.js";
import type { IssueAdmissionEntry, IssueAdmissionEvidence } from "./issue-admission.js";

export interface AdmissionCleanupProof {
  reservationOid: string;
  resourceIdentity: string;
  producerStopped: true;
  resourcesReleased: true;
  evidenceOid: string;
}
export interface AdmissionCapacityProof {
  reservationOid: string;
  capacityReservationId: string;
  released: true;
}
export interface AdmissionNonExecutionProof {
  reservationOid: string;
  evidenceOid: string;
  dispatchPrevented: true;
}
const terminal = new Set([
  "AttemptFailed",
  "AttemptTimedOut",
  "AttemptCancelled",
  "AttemptDeferred",
  "AttemptIntegrated",
  "AttemptSucceeded",
]);

/**
 * Validate accounting and original attempt bindings before the issue arbiter
 * releases a liability. Events must already be authenticated by the caller.
 * Positive cleanup/capacity evidence comes from exact provider/resource recovery;
 * this function never converts process absence, lease expiry, or terminal events
 * into producer shutdown. Missing native or model usage stays unknown.
 */
export function buildAdmissionSettlementEvidence(args: {
  entry: IssueAdmissionEntry;
  events: readonly FactoryEvent[];
  cleanup: AdmissionCleanupProof;
  capacity: AdmissionCapacityProof;
  definitiveNonExecution?: AdmissionNonExecutionProof;
  modelUsageExpected?: boolean;
}): IssueAdmissionEvidence {
  const { entry, cleanup, capacity } = args;
  if (
    cleanup.reservationOid !== entry.reservation.oid ||
    cleanup.resourceIdentity !== entry.resourceIdentity ||
    cleanup.producerStopped !== true ||
    cleanup.resourcesReleased !== true ||
    !/^[a-f0-9]{40}$/.test(cleanup.evidenceOid) ||
    capacity.reservationOid !== entry.reservation.oid ||
    capacity.capacityReservationId !== entry.capacityReservationId ||
    capacity.released !== true
  )
    throw new Error("admission settlement requires exact positive cleanup and capacity evidence");
  const scoped = deduplicateFactoryEvents([...args.events]).filter(
    (event) =>
      event.objective === entry.objective &&
      event.runId === entry.runId &&
      "workItem" in event &&
      event.workItem === entry.workItem &&
      "attempt" in event &&
      event.attempt === entry.reservation.attempt,
  );
  const reservations = scoped.filter(
    (event) => event.kind === "attempt" && event.event === "AttemptReserved",
  );
  if (
    !reservations.length ||
    reservations.some(
      (event) =>
        event.kind !== "attempt" ||
        event.backend !== entry.reservation.backend ||
        event.baseSha !== entry.reservation.baseSha ||
        event.directorEpoch !== entry.directorEpoch ||
        event.policyDigest !== entry.policyDigest,
    )
  )
    throw new Error("admission settlement has no exact original reservation receipt");
  const nonExecution = args.definitiveNonExecution;
  if (
    nonExecution &&
    (entry.dispatchPossible ||
      entry.imported ||
      nonExecution.reservationOid !== entry.reservation.oid ||
      nonExecution.dispatchPrevented !== true ||
      !/^[a-f0-9]{40}$/.test(nonExecution.evidenceOid) ||
      scoped.some(
        (event) =>
          event.kind === "attempt" &&
          ![
            "AttemptReserved",
            "AttemptDeferred",
            "AttemptCancelled",
            "AttemptFailed",
            "AttemptTimedOut",
          ].includes(event.event),
      ))
  )
    throw new Error("definitive non-execution proof does not bind a never-dispatched admission");
  if (
    !nonExecution &&
    !scoped.some(
      (event) =>
        event.kind === "attempt" &&
        terminal.has(event.event) &&
        event.backend === entry.reservation.backend &&
        event.baseSha === entry.reservation.baseSha &&
        event.directorEpoch === entry.directorEpoch &&
        event.policyDigest === entry.policyDigest,
    )
  )
    throw new Error("admission settlement requires an exact terminal execution outcome");
  // A legacy receipt can omit these optional budget fields. A contradictory
  // supplied generation/policy is never silently dropped from accounting.
  if (
    scoped.some(
      (event) =>
        (event.kind === "budget" || event.kind === "capacity") &&
        ((event.directorEpoch !== undefined && event.directorEpoch !== entry.directorEpoch) ||
          (event.policyDigest !== undefined && event.policyDigest !== entry.policyDigest)),
    )
  )
    throw new Error("admission accounting contradicts original epoch or policy");
  if (unreconciledBudgetReservations(scoped).length)
    throw new Error("admission budget or model usage remains unknown");
  if (unreconciledCapacityReservations(scoped).length)
    throw new Error("admission capacity remains reserved");
  if (
    !nonExecution &&
    !scoped.some(
      (event) =>
        event.kind === "budget" &&
        event.event === "BudgetReserved" &&
        event.phase === "execution" &&
        ["local_milliseconds", "sandbox_milliseconds", "managed_sessions"].includes(event.unit),
    )
  )
    throw new Error("admission has no native execution budget evidence; missing usage is unknown");
  if (
    !nonExecution &&
    args.modelUsageExpected &&
    !scoped.some(
      (event) =>
        event.kind === "budget" &&
        event.event === "BudgetReconciled" &&
        event.phase === "execution" &&
        event.unit === "model_tokens" &&
        event.directorEpoch === entry.directorEpoch &&
        event.policyDigest === entry.policyDigest,
    )
  )
    throw new Error("admission has no exact actual worker model usage");
  return {
    reservationOid: entry.reservation.oid,
    resourceIdentity: entry.resourceIdentity,
    capacityReservationId: entry.capacityReservationId,
    budgetReservationId: entry.budgetReservationId,
    producerStopped: true,
    resourcesReleased: true,
    capacityReleased: true,
    accountingSettled: true,
    evidenceOid: cleanup.evidenceOid,
  };
}

/**
 * Recognize completion of the supported Supervisor's finite, single-launch
 * execution path. These original-writer receipts are emitted after that path
 * stops producing work; this is not a generic assertion that terminal state
 * proves resource cleanup. The caller must still reconcile exact resources,
 * capacity, and accounting. Succeeded is deliberately insufficient because the
 * original path may still launch validation. Successor-written terminal events,
 * process absence, and lease expiry cannot prove the original producer ended.
 */
export function hasOriginalAdmissionProducerCompletion(
  entry: IssueAdmissionEntry,
  authenticatedEvents: readonly FactoryEvent[],
): boolean {
  return deduplicateFactoryEvents([...authenticatedEvents]).some(
    (event) =>
      event.kind === "attempt" &&
      ["AttemptFailed", "AttemptCancelled", "AttemptTimedOut", "AttemptIntegrated"].includes(
        event.event,
      ) &&
      event.objective === entry.objective &&
      event.runId === entry.runId &&
      event.workItem === entry.workItem &&
      event.attempt === entry.reservation.attempt &&
      event.backend === entry.reservation.backend &&
      event.baseSha === entry.reservation.baseSha &&
      event.policyDigest === entry.policyDigest &&
      event.directorEpoch === entry.directorEpoch &&
      event.recoveryEpoch === undefined &&
      (event.writerEpoch === undefined || event.writerEpoch === entry.directorEpoch),
  );
}
