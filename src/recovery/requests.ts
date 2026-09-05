import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { FactoryReadSnapshot } from "../application/status.js";
import type { CompiledGraphStore } from "../control/graphs.js";
import { LeaseManager, type LeaseStore } from "../control/lease.js";
import {
  deduplicateFactoryEvents,
  encodeEventComment,
  nextEventSequence,
} from "../control/receipts.js";
import { parseFactoryEvent, type FactoryEvent } from "../protocol/events.js";
import { PROTOCOL_V2, safeId, sha256Digest } from "../protocol/limits.js";
import type { RecoveryReadStore } from "./assessment.js";
import { recoveryEventDigest } from "./identity.js";
import { loadRecoveryPlan, RecoveryPlanManager, type RecoveryPlanRecord } from "./plan.js";
import { buildRecoveryProposal, type RecoveryProposalResult } from "./proposal.js";

const amount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const RecoveryProposalInputSchema = z
  .object({
    objective: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    requestId: safeId,
    allowanceIncrement: z
      .object({
        modelTokens: amount,
        sandboxMinutes: amount,
        managedSessions: amount,
        implementationAttemptsPerItem: amount,
      })
      .strict()
      .optional(),
    unknownUsageAcknowledgementDigest: sha256Digest.nullable().optional(),
  })
  .strict();
export const RecoveryRequestInputSchema = RecoveryProposalInputSchema.extend({
  planDigest: sha256Digest,
}).strict();
export type RecoveryProposalInput = z.infer<typeof RecoveryProposalInputSchema>;
export type RecoveryRequestInput = z.infer<typeof RecoveryRequestInputSchema>;
type Request = Extract<FactoryEvent, { event: "RecoveryRequested" }>;

export interface RecoveryRequestPorts {
  repository: string;
  /** This must be a complete GitHubReader-authenticated inspection, not raw issue JSON. */
  readSnapshot(
    objective: number,
  ): Promise<{ snapshot: FactoryReadSnapshot; historyComplete: boolean }>;
  readStore: RecoveryReadStore;
  store: CompiledGraphStore &
    LeaseStore & {
      getAuthenticatedLogin(): Promise<string>;
      addIssueComment(issueNodeId: string, body: string): Promise<void>;
    };
}

export function recoverySuccessorRunId(
  repository: string,
  objective: number,
  requestId: string,
): string {
  return `recovery-${createHash("sha256")
    .update(JSON.stringify([repository.toLowerCase(), objective, requestId]))
    .digest("hex")}`;
}

function eventsOf(snapshot: FactoryReadSnapshot): FactoryEvent[] {
  return deduplicateFactoryEvents(
    [
      ...(snapshot.factoryEvents ?? []),
      ...snapshot.workItems.flatMap((item) => item.factoryEvents ?? []),
    ].map(parseFactoryEvent),
  );
}

/** Explicit plan approval only. No execution, cancellation, allowance inference, or terminal revival. */
export class RecoveryRequestService {
  constructor(private readonly ports: RecoveryRequestPorts) {}

  async propose(raw: RecoveryProposalInput): Promise<RecoveryProposalResult> {
    const input = RecoveryProposalInputSchema.parse(raw);
    const observed = await this.ports.readSnapshot(input.objective);
    return this.proposal(input, observed);
  }

  private proposal(
    input: RecoveryProposalInput,
    observed: Awaited<ReturnType<RecoveryRequestPorts["readSnapshot"]>>,
  ) {
    if (observed.snapshot.number !== input.objective)
      throw new Error("Recovery Objective identity changed");
    return buildRecoveryProposal({
      repository: this.ports.repository,
      ...observed,
      store: this.ports.readStore,
      requestId: input.requestId,
      successorRunId: recoverySuccessorRunId(
        this.ports.repository,
        input.objective,
        input.requestId,
      ),
      ...(input.allowanceIncrement ? { allowanceIncrement: input.allowanceIncrement } : {}),
      ...(input.unknownUsageAcknowledgementDigest !== undefined
        ? { unknownUsageAcknowledgementDigest: input.unknownUsageAcknowledgementDigest }
        : {}),
    });
  }

  private async existing(
    input: RecoveryRequestInput,
    snapshot: FactoryReadSnapshot,
    actor: string,
  ): Promise<Request | null> {
    const existing = eventsOf(snapshot).find(
      (event) => "requestId" in event && event.requestId === input.requestId,
    );
    if (!existing) return null;
    if (
      existing.event !== "RecoveryRequested" ||
      existing.planDigest !== input.planDigest ||
      existing.requestedBy.toLowerCase() !== actor.toLowerCase()
    )
      throw new Error("Recovery request ID already names different authority");
    const record = await loadRecoveryPlan(this.ports.readStore, input.objective, input.planDigest);
    if (!record) throw new Error("Accepted recovery plan is unavailable");
    this.assertBinding(input, record, snapshot, actor, existing);
    return existing;
  }

  private assertBinding(
    input: RecoveryRequestInput,
    record: RecoveryPlanRecord,
    snapshot: FactoryReadSnapshot,
    actor: string,
    request?: Request,
  ): void {
    const plan = record.plan;
    const increments = input.allowanceIncrement ?? {
      modelTokens: 0,
      sandboxMinutes: 0,
      managedSessions: 0,
      implementationAttemptsPerItem: 0,
    };
    const start = eventsOf(snapshot).find(
      (event) => event.event === "FactoryRunStarted" && event.runId === plan.predecessor.runId,
    );
    const terminal = eventsOf(snapshot).find(
      (event) => recoveryEventDigest(event) === plan.predecessor.terminalDigest,
    );
    if (
      record.digest !== input.planDigest ||
      plan.requestId !== input.requestId ||
      plan.objective !== input.objective ||
      snapshot.number !== input.objective ||
      plan.objectiveNodeId !== snapshot.id ||
      plan.repositoryId !== snapshot.repositoryId ||
      plan.repository.toLowerCase() !== this.ports.repository.toLowerCase() ||
      plan.successorRunId !==
        recoverySuccessorRunId(this.ports.repository, input.objective, input.requestId) ||
      plan.unknownUsageAcknowledgementDigest !==
        (input.unknownUsageAcknowledgementDigest ?? null) ||
      Object.entries(increments).some(
        ([key, value]) => plan.allowance.increment[key as keyof typeof increments] !== value,
      ) ||
      start?.event !== "FactoryRunStarted" ||
      recoveryEventDigest(start) !== plan.predecessor.startDigest ||
      start.actor.toLowerCase() !== actor.toLowerCase() ||
      !terminal ||
      terminal.runId !== plan.predecessor.runId ||
      (request &&
        (request.objective !== plan.objective ||
          request.repository.toLowerCase() !== plan.repository.toLowerCase() ||
          request.predecessorRunId !== plan.predecessor.runId ||
          request.predecessorTerminalDigest !== plan.predecessor.terminalDigest ||
          request.successorRunId !== plan.successorRunId ||
          request.policyDigest !== plan.policyDigest ||
          request.baseSha !== plan.expectedBaseSha))
    )
      throw new Error("Recovery plan, actor, or explicit allowance binding changed");
  }

  async request(raw: RecoveryRequestInput): Promise<Request> {
    const input = RecoveryRequestInputSchema.parse(raw);
    const actor = await this.ports.store.getAuthenticatedLogin();
    let observed = await this.ports.readSnapshot(input.objective);
    if (!observed.historyComplete)
      throw new Error("Recovery requires complete authenticated history");
    const prior = await this.existing(input, observed.snapshot, actor);
    if (prior) return prior; // Retry observes accepted authority, not a newly compiled plan.
    const proposed = await this.proposal(input, observed);
    if (
      !proposed.plan ||
      proposed.planDigest !== input.planDigest ||
      proposed.status !== "proposed"
    )
      throw new Error(
        "Recovery proposal changed or is blocked; inspect and acknowledge its exact new digest",
      );
    const plan = proposed.plan;
    // Check actor before even writing a proposal lease.
    this.assertBinding(
      input,
      { plan, digest: input.planDigest, ref: "", commitOid: "", blobOid: "" },
      observed.snapshot,
      actor,
    );
    const leases = new LeaseManager({ store: this.ports.store });
    const lease = await leases.acquire(
      {
        objective: input.objective,
        runId: plan.successorRunId,
        holder: `recovery-request-${randomUUID()}`,
        policyDigest: plan.policyDigest,
      },
      await this.ports.store.readCommit(plan.expectedBaseSha),
    );
    try {
      observed = await this.ports.readSnapshot(input.objective);
      if (!observed.historyComplete)
        throw new Error("Recovery requires complete authenticated history");
      const replay = await this.existing(input, observed.snapshot, actor);
      if (replay) return replay;
      const refreshed = await this.proposal(input, observed);
      if (
        !refreshed.plan ||
        refreshed.status !== "proposed" ||
        refreshed.planDigest !== input.planDigest
      )
        throw new Error(
          "Recovery proposal changed while acquiring authority; new acknowledgement required",
        );
      const record = await new RecoveryPlanManager(this.ports.store, leases).persist({
        lease,
        plan: refreshed.plan,
      });
      this.assertBinding(input, record, observed.snapshot, actor);
      await leases.assertCurrent(lease);
      const event = parseFactoryEvent({
        protocol: PROTOCOL_V2,
        kind: "recovery",
        event: "RecoveryRequested",
        objective: input.objective,
        runId: plan.predecessor.runId,
        sequence: nextEventSequence(eventsOf(observed.snapshot)),
        at: (await this.ports.store.serverTime()).toISOString(),
        requestedBy: actor,
        requestId: input.requestId,
        repository: plan.repository,
        planDigest: record.digest,
        predecessorRunId: plan.predecessor.runId,
        predecessorTerminalDigest: plan.predecessor.terminalDigest,
        successorRunId: plan.successorRunId,
        policyDigest: plan.policyDigest,
        baseSha: plan.expectedBaseSha,
      });
      if (event.event !== "RecoveryRequested")
        throw new Error("Recovery request envelope mismatch");
      await leases.assertCurrent(lease);
      try {
        await this.ports.store.addIssueComment(
          plan.objectiveNodeId,
          encodeEventComment(
            "Factory accepted an explicitly acknowledged successor recovery plan. Adoption and execution remain independently gated.",
            event,
          ),
        );
      } catch {
        const after = await this.ports.readSnapshot(input.objective);
        if (after.historyComplete) {
          const replay = await this.existing(input, after.snapshot, actor);
          if (replay) return replay;
        }
        throw new Error(
          "Recovery request write is unresolved; retry the same request ID and plan digest",
        );
      }
      return event;
    } finally {
      // Failure to release cannot revoke a committed request or justify overwriting the lease.
      // Another controller must wait for its observed expiry or release before adoption.
      await leases.release(lease).catch(() => undefined);
    }
  }
}
