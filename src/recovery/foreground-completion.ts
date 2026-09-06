import { createHash } from "node:crypto";
import { attemptRef } from "../control/attempts.js";
import { loadCompiledGraph, loadCompiledGraphProjection } from "../control/graphs.js";
import { assertAuthenticatedGraphProjection } from "../control/graph-evidence.js";
import { decodeEventTrailer, deduplicateFactoryEvents } from "../control/receipts.js";
import { durableAttemptId } from "../execution/session.js";
import { workerPacketFromCompiled } from "../graph.js";
import { parseFactoryEvent, type FactoryEvent } from "../protocol/events.js";
import { LocalScopeBatchSchema, type LocalScopeBatch } from "../protocol/local-scope.js";
import { policyDigest } from "../protocol/policy.js";
import { parseWorkerPacket, workerPacketDigest } from "../protocol/worker-packet.js";
import { validationPlanFromPacket } from "../validation/plan.js";
import type { RecoveryReadStore } from "./assessment.js";
import { recoveryEventDigest, recoverySourceEventsDigest } from "./identity.js";
import { parseRecoveryPlan, type RecoveryPlan } from "./plan.js";

export interface ForegroundCompletionInput {
  batch: LocalScopeBatch;
  plan: RecoveryPlan;
  /** Complete actor-authenticated history, as required by recovery resource verification. */
  events: readonly FactoryEvent[];
  store: RecoveryReadStore;
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function requireProof(value: unknown): asserts value {
  if (!value) throw new Error("completed foreground invocation evidence unavailable");
}
function one<T>(values: T[]): T {
  requireProof(values.length === 1);
  return values[0]!;
}

/** A receipt-bound proof of finite launcher-loop closure, NOT physical absence,
 * command-output reconstruction, validation authority or permission to spend.
 * Only the original ordinary local execution/validation path is supported. */
export async function deriveForegroundCompletion(
  input: ForegroundCompletionInput,
): Promise<string> {
  const plan = parseRecoveryPlan(input.plan);
  const batch = LocalScopeBatchSchema.parse(input.batch);
  requireProof(!batch.identity.producerUnit && input.events.length <= 10_000);
  const events = deduplicateFactoryEvents(input.events.map(parseFactoryEvent));
  requireProof(events.every((event) => event.objective === plan.objective));
  const runs = new Set(plan.history.map((entry) => entry.runId));
  requireProof(
    recoverySourceEventsDigest({
      objective: plan.objective,
      runIds: [...runs],
      events,
      maxSequence: plan.sourceEventMaxSequence,
    }) === plan.sourceEventsDigest,
  );
  const history = events.filter((event) => runs.has(event.runId) && event.kind !== "recovery");
  for (const entry of plan.history) {
    const start = one(
      history.filter((event) => event.event === "FactoryRunStarted" && event.runId === entry.runId),
    );
    const terminal = one(
      history.filter(
        (event) =>
          event.runId === entry.runId &&
          ["FactoryRunCompleted", "FactoryRunEscalated", "FactoryRunCancelled"].includes(
            event.event,
          ),
      ),
    );
    requireProof(
      start.event === "FactoryRunStarted" &&
        start.repository.toLowerCase() === plan.repository.toLowerCase() &&
        policyDigest(start.policy) === entry.policyDigest &&
        start.policyDigest === entry.policyDigest &&
        recoveryEventDigest(start) === entry.startDigest &&
        recoveryEventDigest(terminal) === entry.terminalDigest &&
        terminal.event === entry.terminalEvent &&
        terminal.sequence === entry.terminalSequence &&
        history
          .filter((event) => event.runId === entry.runId)
          .every(
            (event) =>
              event.sequence >= start.sequence &&
              event.sequence <= terminal.sequence &&
              event.sequence <= plan.sourceEventMaxSequence,
          ),
    );
  }
  const identity = batch.identity;
  requireProof(
    identity.repository === plan.repository.toLowerCase() &&
      identity.objective === plan.objective &&
      runs.has(identity.runId),
  );
  const item = one(plan.items.filter((item) => item.workItem === identity.workItem));
  const source = item.source;
  requireProof(
    source &&
      source.runId === identity.runId &&
      source.attempt === identity.attempt &&
      source.validation &&
      source.artifactDigest,
  );
  const group = history.filter(
    (event) =>
      event.runId === identity.runId &&
      "workItem" in event &&
      event.workItem === identity.workItem &&
      "attempt" in event &&
      event.attempt === identity.attempt,
  );
  const attempts = group.filter((event) => event.kind === "attempt");
  const reserved = one(attempts.filter((event) => event.event === "AttemptReserved"));
  requireProof(
    reserved.kind === "attempt" &&
      reserved.localScopeBatch &&
      !reserved.recoveryEpoch &&
      reserved.attempt === 1 &&
      ["codex-sdk/local-worktree", "codex-cli/local-worktree"].includes(reserved.backend) &&
      reserved.directorEpoch === identity.directorEpoch &&
      reserved.policyDigest === identity.policyDigest &&
      source.reservationReceiptDigest === recoveryEventDigest(reserved),
  );
  requireProof(
    attempts.every(
      (event) =>
        event.kind === "attempt" &&
        event.backend === reserved.backend &&
        event.baseSha === reserved.baseSha &&
        event.directorEpoch === reserved.directorEpoch &&
        event.policyDigest === reserved.policyDigest &&
        !event.recoveryEpoch &&
        !["AttemptFailed", "AttemptCancelled", "AttemptTimedOut", "AttemptDeferred"].includes(
          event.event,
        ),
    ),
  );
  const ref = attemptRef(plan.objective, reserved.workItem, reserved.attempt);
  requireProof(ref === source.reservationRef);
  const oid = await input.store.readRef(ref);
  requireProof(oid === source.reservationCommitOid);
  const commit = await input.store.readCommit(oid!);
  const trailer = decodeEventTrailer(commit.message);
  requireProof(
    commit.oid === oid &&
      trailer &&
      recoveryEventDigest(trailer) === recoveryEventDigest(reserved) &&
      commit.parentOids.length === 1 &&
      commit.parentOids[0] === reserved.baseSha &&
      (await input.store.readCommit(reserved.baseSha)).treeOid === commit.treeOid,
  );
  const started = one(attempts.filter((event) => event.event === "AttemptStarted"));
  const succeeded = one(attempts.filter((event) => event.event === "AttemptSucceeded"));
  const collected = one(attempts.filter((event) => event.event === "AttemptCollected"));
  requireProof(
    started.kind === "attempt" &&
      succeeded.kind === "attempt" &&
      collected.kind === "attempt" &&
      started.resourceHostIdentity === reserved.localScopeBatch.identity.hostIdentity &&
      succeeded.artifactDigest === source.artifactDigest &&
      collected.artifactDigest === source.artifactDigest &&
      reserved.sequence < started.sequence &&
      started.sequence < succeeded.sequence &&
      succeeded.sequence < collected.sequence,
  );
  if (reserved.backend === "codex-sdk/local-worktree")
    requireProof(
      started.providerResourceId ===
        `sdk-${durableAttemptId({ repository: plan.repository, ...reserved }).slice(0, 24)}`,
    );
  else
    requireProof(
      /^local-[1-9][0-9]*$/.test(started.providerResourceId ?? "") &&
        Number.isSafeInteger(Number(started.providerResourceId!.slice(6))),
    );
  requireProof(
    attempts.every(
      (event) =>
        (!event.providerResourceId || event.providerResourceId === started.providerResourceId) &&
        (!event.artifactDigest || event.artifactDigest === source.artifactDigest),
    ),
  );
  const budgets = group.filter((event) => event.kind === "budget");
  requireProof(
    budgets.every(
      (event) =>
        (!("directorEpoch" in event) || event.directorEpoch === reserved.directorEpoch) &&
        (!("policyDigest" in event) || event.policyDigest === reserved.policyDigest) &&
        !("recoveryEpoch" in event) &&
        !("sourceRunId" in event),
    ),
  );
  const nativeReserved = one(
    budgets.filter(
      (event) =>
        event.event === "BudgetReserved" &&
        event.unit === "local_milliseconds" &&
        event.phase === "execution",
    ),
  );
  const nativeCompleted = one(
    budgets.filter(
      (event) =>
        event.event === "BudgetReconciled" &&
        event.unit === "local_milliseconds" &&
        event.phase === "execution",
    ),
  );
  const model = one(
    budgets.filter(
      (event) =>
        event.event === "BudgetReconciled" &&
        event.unit === "model_tokens" &&
        event.phase === "execution",
    ),
  );
  requireProof(
    nativeReserved.sequence > reserved.sequence &&
      nativeReserved.sequence < started.sequence &&
      nativeCompleted.sequence > succeeded.sequence &&
      nativeCompleted.sequence < collected.sequence &&
      model.kind === "budget" &&
      model.usageId === `worker-${reserved.workItem}-${reserved.attempt}` &&
      model.amount === succeeded.reportedModelTokens &&
      model.sequence > started.sequence &&
      model.sequence < succeeded.sequence &&
      !nativeReserved.usageId &&
      !nativeCompleted.usageId,
  );

  const capacities = group.filter((event) => event.kind === "capacity");
  const capacity = one(capacities.filter((event) => event.event === "CapacityReserved"));
  const release = one(capacities.filter((event) => event.event === "CapacityReconciled"));
  const validation = one(group.filter((event) => event.kind === "validation"));
  const validationUsage = one(
    budgets.filter((event) => event.event === "BudgetReconciled" && event.phase === "validation"),
  );
  requireProof(
    budgets.filter((event) => event.phase === "execution" || event.phase === "validation")
      .length === 4,
  );
  requireProof(
    capacity.kind === "capacity" &&
      release.kind === "capacity" &&
      validation.kind === "validation" &&
      validationUsage.kind === "budget" &&
      capacity.backend === "factory/local-validation" &&
      capacity.phase === "validation" &&
      capacity.localScopeBatch &&
      !capacity.sourceRunId &&
      !capacity.recoveryEpoch &&
      !release.sourceRunId &&
      !release.recoveryEpoch &&
      capacity.directorEpoch === reserved.directorEpoch &&
      capacity.policyDigest === reserved.policyDigest &&
      release.backend === capacity.backend &&
      release.phase === capacity.phase &&
      release.directorEpoch === capacity.directorEpoch &&
      release.policyDigest === capacity.policyDigest &&
      release.requestedCpu === capacity.requestedCpu &&
      release.requestedMemoryMb === capacity.requestedMemoryMb &&
      capacity.localScopeBatch.identity.invocationDigest === source.artifactDigest &&
      capacity.sequence > nativeCompleted.sequence &&
      capacity.sequence < collected.sequence &&
      collected.sequence < validation.sequence &&
      validation.sequence < release.sequence &&
      release.sequence < validationUsage.sequence &&
      validationUsage.unit === "validation_milliseconds" &&
      !validationUsage.usageId &&
      validation.passed &&
      validation.baseSha === reserved.baseSha &&
      recoveryEventDigest(validation) === source.validation.receiptDigest &&
      validation.evidenceDigest === source.validation.evidenceDigest &&
      validation.outputTreeSha === source.validation.outputTreeSha,
  );
  // No other source invocation (including adopted/rebase/candidate validation)
  // can hide outside this original attempt's receipt group.
  requireProof(
    events.filter(
      (event) =>
        runs.has(event.runId) &&
        event.kind === "capacity" &&
        event.sourceRunId === reserved.runId &&
        event.workItem === reserved.workItem &&
        event.attempt === reserved.attempt,
    ).length === 0,
  );

  requireProof(plan.graph.sourceRunId === reserved.runId);
  const graph = await loadCompiledGraph(input.store, plan.objective, reserved.runId);
  requireProof(
    graph &&
      graph.ref === plan.graph.ref &&
      graph.commitOid === plan.graph.commitOid &&
      graph.blobOid === plan.graph.blobOid &&
      graph.graphDigest === plan.graph.digest,
  );
  const graphEvent = one(
    history.filter((event) => event.event === "GraphCompiled" && event.runId === reserved.runId),
  );
  requireProof(
    graphEvent.event === "GraphCompiled" &&
      graphEvent.graphRef === graph.ref &&
      graphEvent.graphBlobSha === graph.blobOid &&
      graphEvent.graphDigest === graph.graphDigest &&
      graphEvent.graphSize === graph.graphSize &&
      graphEvent.sequence < reserved.sequence,
  );
  const projection = await loadCompiledGraphProjection(
    input.store,
    plan.objective,
    reserved.runId,
    graph,
  );
  requireProof(
    projection &&
      projection.ref === plan.graph.projection.ref &&
      projection.commitOid === plan.graph.projection.commitOid &&
      projection.blobOid === plan.graph.projection.blobOid,
  );
  assertAuthenticatedGraphProjection(history, plan.objective, reserved.runId, projection);
  requireProof(
    projection.bindings.some(
      (binding) =>
        binding.compilerId === item.compilerId &&
        binding.issueNumber === item.workItem &&
        binding.issueNodeId === item.issueNodeId,
    ),
  );
  const compiled = one(graph.objective.workItems.filter((work) => work.id === item.compilerId));
  const packet = parseWorkerPacket({
    ...workerPacketFromCompiled(compiled),
    baseSha: reserved.baseSha,
  });
  requireProof(
    packet.requirements.trust === "trusted_local" &&
      reserved.localScopeBatch.identity.invocationDigest === workerPacketDigest(packet),
  );
  const validationPlan = validationPlanFromPacket(packet);
  requireProof(
    validationPlan.isolation === "local" &&
      capacity.localScopeBatch.commandCount === validationPlan.commands.length + 1,
  );
  // All slots, including the optional setup slot, are covered physically. A
  // passed original receipt follows the awaited serial loop and its cleanup;
  // it does not provide a transcript or prove that optional setup executed.
  const originalBatches = [reserved.localScopeBatch, capacity.localScopeBatch];
  for (const original of originalBatches) {
    requireProof(
      original.identity.repository === identity.repository &&
        original.identity.runId === identity.runId &&
        original.identity.workItem === identity.workItem &&
        original.identity.attempt === identity.attempt &&
        original.identity.directorEpoch === identity.directorEpoch &&
        original.identity.policyDigest === identity.policyDigest,
    );
  }
  requireProof(originalBatches.filter((original) => hash(original) === hash(batch)).length === 1);
  return hash({
    protocol: "clockgrove.factory/completed-foreground-witness-v1",
    batch,
    sourceEventsDigest: plan.sourceEventsDigest,
    reservationOid: oid,
    graphCommitOid: graph.commitOid,
    projectionCommitOid: projection.commitOid,
    commands: validationPlan.commands,
    optionalSetup: "reserved-not-inferred",
    receipts: group.map(recoveryEventDigest).sort(),
  });
}
