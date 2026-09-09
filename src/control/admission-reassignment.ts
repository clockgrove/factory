import { createHash } from "node:crypto";
import { assertCompiledObjectiveAdoptsLegacyConstraints } from "../graph.js";
import type { RecoveryReadStore } from "../recovery/assessment.js";
import { isRecoveryAdoptionGraph, recoveryPlanBindingDigest } from "../recovery/plan.js";
import type { RecoveryRuntime } from "../recovery/runtime.js";
import { verifyRecoveryResources } from "../recovery/resources.js";
import {
  buildAdmissionSettlementEvidence,
  hasOriginalAdmissionProducerCompletion,
} from "./admission-settlement.js";
import type { IssueAdmissionEntry, IssueAdmissionLedger } from "./issue-admission.js";
import type { LeaseState, LeaseStore } from "./lease.js";

/** A recovery-chain terminal is written only after the Supervisor drains its
 * execution pool. For an explicitly retained successful artifact, that exact
 * terminal plus the accepted plan proves the old callback cannot resume after
 * issue reassignment; resource absence and accounting remain separate gates. */
function hasAcceptedRetainedArtifactProducerCompletion(
  entry: IssueAdmissionEntry,
  runtime: RecoveryRuntime,
): boolean {
  const item = runtime.planRecord.plan.items.find(
    (candidate) => candidate.workItem === entry.workItem,
  );
  const source = item?.source;
  const history = runtime.planRecord.plan.history.find(
    (candidate) => candidate.runId === entry.runId,
  );
  if (
    item?.action !== "reconcile" ||
    !source?.artifactDigest ||
    source.runId !== entry.runId ||
    source.attempt !== entry.reservation.attempt ||
    !history
  )
    return false;
  const scoped = runtime.events.filter(
    (event) =>
      event.runId === entry.runId &&
      "workItem" in event &&
      event.workItem === entry.workItem &&
      "attempt" in event &&
      event.attempt === entry.reservation.attempt,
  );
  const succeeded = scoped.filter(
    (event) =>
      event.kind === "attempt" &&
      event.event === "AttemptSucceeded" &&
      event.artifactDigest === source.artifactDigest,
  );
  const terminal = runtime.events.find(
    (event) =>
      event.runId === entry.runId &&
      event.sequence === history.terminalSequence &&
      event.event === history.terminalEvent,
  );
  return (
    succeeded.length === 1 &&
    Boolean(terminal) &&
    scoped.every((event) => event.sequence < history.terminalSequence) &&
    !scoped.some(
      (event) =>
        event.kind === "validation" ||
        (event.kind === "capacity" && event.phase === "validation") ||
        (event.kind === "attempt" &&
          [
            "AttemptCollected",
            "AttemptValidated",
            "AttemptPublished",
            "AttemptIntegrated",
            "AttemptFailed",
            "AttemptTimedOut",
            "AttemptCancelled",
            "AttemptDeferred",
          ].includes(event.event)),
    )
  );
}

/** An already verified accepted successor is an explicit reassignment boundary.
 * Re-observe live resources/capacity; a lease takeover alone never settles its predecessor. */
async function reconcile(args: {
  store: RecoveryReadStore & LeaseStore;
  ledger: IssueAdmissionLedger;
  runtime: RecoveryRuntime;
  lease: LeaseState;
  workItem: number;
  workItemNodeId: string;
  assertCurrent: () => Promise<void>;
  assertCapacityReleased: (entry: IssueAdmissionEntry) => Promise<void>;
  modelUsageExpected: (entry: IssueAdmissionEntry) => boolean;
}): Promise<{ authorityReceiptOid: string } | undefined> {
  const { runtime, lease, store } = args;
  const ledger = await args.ledger.read(args.workItem);
  if (
    !ledger ||
    ledger.history.every(
      (entry) => entry.runId === lease.runId && entry.objective === lease.objective,
    )
  )
    return undefined;
  const plan = runtime.planRecord.plan;
  if (
    runtime.status !== "verified" ||
    !runtime.adoptionVerified ||
    runtime.controllingRun.runId !== lease.runId ||
    runtime.controllingRun.objective !== lease.objective ||
    runtime.controllingRun.policyDigest !== lease.policyDigest ||
    plan.successorRunId !== lease.runId ||
    plan.objective !== lease.objective ||
    plan.policyDigest !== lease.policyDigest ||
    runtime.claim.successorRunId !== lease.runId ||
    runtime.claim.objective !== lease.objective ||
    runtime.claim.policyDigest !== lease.policyDigest ||
    runtime.claim.planCommitOid !== runtime.planRecord.commitOid ||
    runtime.claim.planDigest !== runtime.planRecord.digest ||
    runtime.controllingRun.recoveryPlanDigest !== runtime.planRecord.digest ||
    runtime.controllingRun.recoveryRequestId !== runtime.claim.requestId
  )
    throw Error("issue reassignment requires the exact accepted successor runtime");
  if (
    ledger.workItemNodeId !== args.workItemNodeId ||
    runtime.projection.bindings.filter(
      (binding) =>
        binding.issueNumber === args.workItem && binding.issueNodeId === args.workItemNodeId,
    ).length !== 1 ||
    plan.items.filter(
      (item) => item.workItem === args.workItem && item.issueNodeId === args.workItemNodeId,
    ).length !== 1 ||
    runtime.graph.ref !== plan.graph.ref ||
    runtime.projection.ref !== plan.graph.projection.ref ||
    recoveryPlanBindingDigest(
      runtime.projection.bindings.map((binding) => ({
        compilerId: binding.compilerId,
        issueNodeId: binding.issueNodeId,
        workItem: binding.issueNumber,
      })),
    ) !== plan.graph.projection.bindingDigest
  )
    throw Error("issue reassignment graph projection changed");
  if (isRecoveryAdoptionGraph(plan.graph)) {
    assertCompiledObjectiveAdoptsLegacyConstraints(runtime.graph.objective, plan.graph.constraints);
  } else if (
    runtime.graph.commitOid !== plan.graph.commitOid ||
    runtime.graph.blobOid !== plan.graph.blobOid ||
    runtime.graph.graphDigest !== plan.graph.digest ||
    runtime.projection.commitOid !== plan.graph.projection.commitOid ||
    runtime.projection.blobOid !== plan.graph.projection.blobOid
  ) {
    throw Error("issue reassignment persisted graph identity changed");
  }
  const accounting = runtime.historicalAccounting;
  if (
    accounting.unknownModelUsageCount ||
    accounting.unknownModelUsage.length ||
    accounting.unreconciledReservationCount ||
    accounting.unreconciledReservations.length ||
    // Historical ceilings can differ only because this exact successor policy
    // was separately approved and authenticated above. This diagnostic does not
    // erase usage or authorize any other incomplete accounting evidence.
    accounting.blockerCount !== accounting.blockers.length ||
    accounting.blockers.some((blocker) => blocker.code !== "historical-policy-difference") ||
    accounting.unreconciledReservationsTruncated ||
    accounting.diagnosticsTruncated ||
    accounting.attemptCountsTruncated ||
    runtime.currentUnknownModelUsageCount ||
    runtime.currentUnknownModelUsage.length ||
    runtime.currentUnknownManagementInvocations.length
  )
    throw Error("issue reassignment accounting remains unknown or incomplete");
  await args.assertCurrent();
  if (
    (await store.readRef(runtime.claim.ref)) !== runtime.claim.oid ||
    (await store.readRef(runtime.planRecord.ref)) !== runtime.planRecord.commitOid
  )
    throw Error("accepted issue reassignment authority changed");
  const old = ledger.history.filter((entry) => entry.runId !== lease.runId);
  for (const entry of old) {
    if (
      entry.objective !== lease.objective ||
      !runtime.sourceRunIds.includes(entry.runId) ||
      !plan.history.some(
        (origin) => origin.runId === entry.runId && origin.policyDigest === entry.policyDigest,
      ) ||
      entry.graphCommitOid !== runtime.graph.commitOid ||
      entry.graphDigest !== runtime.graph.graphDigest ||
      entry.projectionCommitOid !== runtime.projection.commitOid
    )
      throw Error("issue reassignment cannot borrow an unrelated source graph or run");
  }
  const occupied = old.filter((entry) => entry.disposition !== "released");
  if (!occupied.length) return { authorityReceiptOid: runtime.claim.oid };
  const resources = await verifyRecoveryResources({
    planRecord: runtime.planRecord,
    events: runtime.events,
    store,
  });
  if (resources.status !== "verified" || !resources.evidenceDigest || resources.blockers.length)
    throw Error("issue reassignment requires positive current predecessor resource proof");
  for (const entry of occupied) {
    // Current resource absence does not prove that an old callback cannot produce again.
    if (
      !hasOriginalAdmissionProducerCompletion(entry, runtime.events) &&
      !hasAcceptedRetainedArtifactProducerCompletion(entry, runtime)
    )
      throw Error("issue reassignment has no original producer completion proof");
    await args.assertCapacityReleased(entry);
    // Validate all accounting before writing settlement evidence or releasing any entry.
    buildAdmissionSettlementEvidence({
      entry,
      events: runtime.events,
      cleanup: {
        reservationOid: entry.reservation.oid,
        resourceIdentity: entry.resourceIdentity,
        producerStopped: true,
        resourcesReleased: true,
        evidenceOid: runtime.claim.oid,
      },
      capacity: {
        reservationOid: entry.reservation.oid,
        capacityReservationId: entry.capacityReservationId,
        released: true,
      },
      modelUsageExpected: args.modelUsageExpected(entry),
    });
  }
  const claimCommit = await store.readCommit(runtime.claim.oid);
  if (claimCommit.oid !== runtime.claim.oid) throw Error("accepted successor claim OID changed");
  for (const entry of occupied) {
    await args.assertCurrent();
    await args.assertCapacityReleased(entry);
    const evidenceOid = await store.createCommit({
      treeOid: claimCommit.treeOid,
      parentOids: [runtime.claim.oid, runtime.planRecord.commitOid, entry.reservation.oid],
      message: `Factory accepted successor admission settlement\n\nFactory-Admission-Successor: ${Buffer.from(
        JSON.stringify({
          workItem: args.workItem,
          reservationOid: entry.reservation.oid,
          sourceRunId: entry.runId,
          successorRunId: lease.runId,
          authorityReceiptOid: runtime.claim.oid,
          resourceEvidenceDigest: resources.evidenceDigest,
          accountingEvidenceDigest: createHash("sha256")
            .update(
              JSON.stringify(
                runtime.events.filter(
                  (event) =>
                    event.runId === entry.runId &&
                    "workItem" in event &&
                    event.workItem === entry.workItem &&
                    "attempt" in event &&
                    event.attempt === entry.reservation.attempt,
                ),
              ),
            )
            .digest("hex"),
          capacityReservationId: entry.capacityReservationId,
          resourceIdentity: entry.resourceIdentity,
          budgetReservationId: entry.budgetReservationId,
        }),
      ).toString("base64url")}`,
    });
    const evidence = buildAdmissionSettlementEvidence({
      entry,
      events: runtime.events,
      cleanup: {
        reservationOid: entry.reservation.oid,
        resourceIdentity: entry.resourceIdentity,
        producerStopped: true,
        resourcesReleased: true,
        evidenceOid,
      },
      capacity: {
        reservationOid: entry.reservation.oid,
        capacityReservationId: entry.capacityReservationId,
        released: true,
      },
      modelUsageExpected: args.modelUsageExpected(entry),
    });
    await args.ledger.transitionForSuccessor({
      workItem: args.workItem,
      reservationOid: entry.reservation.oid,
      assertCurrent: args.assertCurrent,
      evidence,
      authority: {
        objective: lease.objective,
        runId: lease.runId,
        directorEpoch: lease.epoch,
        writerHolder: lease.holder,
        policyDigest: lease.policyDigest,
        graphDigest: runtime.graph.graphDigest,
        graphCommitOid: runtime.graph.commitOid,
        projectionCommitOid: runtime.projection.commitOid,
        authorityReceiptOid: runtime.claim.oid,
      },
    });
  }
  return { authorityReceiptOid: runtime.claim.oid };
}

export async function reconcileAdmissionForSuccessor(
  args: Parameters<typeof reconcile>[0],
): ReturnType<typeof reconcile> {
  return args.store.withMutationFence
    ? args.store.withMutationFence(args.assertCurrent, () => reconcile(args))
    : reconcile(args);
}
