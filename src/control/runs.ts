import { randomUUID } from "node:crypto";

import { type FactoryEvent, parseFactoryEvent } from "../protocol/events.js";
import { PROTOCOL_V2 } from "../protocol/limits.js";
import { parseRunPolicy, policyDigest, type RunPolicy } from "../protocol/policy.js";
import { encodeEventComment, latestSupportedRun, nextEventSequence } from "./receipts.js";

export interface RunEventStore {
  addIssueComment(issueNodeId: string, body: string): Promise<void>;
  serverTime(): Promise<Date>;
}

export interface RunState {
  objective: number;
  runId: string;
  sequence: number;
  actor: string;
  policy: RunPolicy;
  policyDigest: string;
  startedAt: Date;
  activationRequestId?: string;
  baseSha?: string;
  repository?: string;
  baseBranch?: string;
  fork?: boolean;
}

export class RunManager {
  constructor(private readonly store: RunEventStore) {}

  resume(events: FactoryEvent[]): RunState | null {
    const active = latestSupportedRun(events);
    if (!active || active.kind !== "run" || active.event !== "FactoryRunStarted") {
      return null;
    }
    if (active.recoveryRequestId) {
      throw new Error(
        "Successor execution requires the fenced adoption transaction and shared evidence resolver; it is not available yet",
      );
    }
    const policy = parseRunPolicy(active.policy);
    const digest = policyDigest(policy);
    if (digest !== active.policyDigest) throw new Error("run policy digest mismatch");
    return {
      objective: active.objective,
      runId: active.runId,
      sequence: Math.max(
        ...events.filter((event) => event.runId === active.runId).map((event) => event.sequence),
      ),
      actor: active.actor,
      policy,
      policyDigest: digest,
      startedAt: new Date(active.at),
      ...(active.activationRequestId ? { activationRequestId: active.activationRequestId } : {}),
      ...(active.baseSha ? { baseSha: active.baseSha } : {}),
      repository: active.repository,
      baseBranch: active.baseBranch,
      fork: active.fork,
    };
  }

  async start(args: {
    objective: number;
    objectiveNodeId: string;
    repository: string;
    objectiveAuthor: string;
    actor: string;
    fork: boolean;
    baseBranch: string;
    policy: unknown;
    existingEvents?: FactoryEvent[];
    runId?: string;
    sequence?: number;
    activationRequestId?: string;
    baseSha?: string;
  }): Promise<RunState> {
    const resumed = this.resume(args.existingEvents ?? []);
    if (resumed) return resumed;
    const policy = parseRunPolicy(args.policy);
    const digest = policyDigest(policy);
    const now = await this.store.serverTime();
    const sequence =
      args.sequence ??
      Math.max(0, ...(args.existingEvents ?? []).map((event) => event.sequence)) + 1;
    if (sequence <= Math.max(0, ...(args.existingEvents ?? []).map((event) => event.sequence))) {
      throw new Error("run sequence must advance the Objective event log");
    }
    const event = parseFactoryEvent({
      protocol: PROTOCOL_V2,
      kind: "run",
      event: "FactoryRunStarted",
      objective: args.objective,
      runId: args.runId ?? randomUUID(),
      sequence,
      at: now.toISOString(),
      actor: args.actor,
      repository: args.repository,
      objectiveAuthor: args.objectiveAuthor,
      fork: args.fork,
      baseBranch: args.baseBranch,
      policy,
      policyDigest: digest,
      ...(args.activationRequestId ? { activationRequestId: args.activationRequestId } : {}),
      ...(args.baseSha ? { baseSha: args.baseSha } : {}),
    });
    if (event.kind !== "run" || event.event !== "FactoryRunStarted") {
      throw new Error("internal error creating run start event");
    }
    await this.store.addIssueComment(
      args.objectiveNodeId,
      encodeEventComment(`Factory started run \`${event.runId}\` with local-first policy.`, event),
    );
    return {
      objective: event.objective,
      runId: event.runId,
      sequence: event.sequence,
      actor: event.actor,
      policy,
      policyDigest: digest,
      startedAt: now,
      ...(event.activationRequestId ? { activationRequestId: event.activationRequestId } : {}),
      ...(event.baseSha ? { baseSha: event.baseSha } : {}),
      repository: event.repository,
      baseBranch: event.baseBranch,
      fork: event.fork,
    };
  }

  async terminal(args: {
    run: RunState;
    objectiveNodeId: string;
    event: "FactoryRunCompleted" | "FactoryRunCancelled" | "FactoryRunEscalated";
    reason?: string;
    existingEvents?: FactoryEvent[];
    sequence?: number;
  }): Promise<FactoryEvent> {
    const now = await this.store.serverTime();
    const event = parseFactoryEvent({
      protocol: PROTOCOL_V2,
      kind: "run",
      event: args.event,
      objective: args.run.objective,
      runId: args.run.runId,
      sequence:
        args.sequence ??
        Math.max(args.run.sequence + 1, nextEventSequence(args.existingEvents ?? [])),
      at: now.toISOString(),
      ...(args.reason ? { reason: args.reason } : {}),
    });
    await this.store.addIssueComment(
      args.objectiveNodeId,
      encodeEventComment(
        args.event === "FactoryRunCompleted"
          ? "Factory completed the Objective."
          : `Factory stopped: ${args.reason ?? args.event}.`,
        event,
      ),
    );
    return event;
  }

  async requestCancellation(args: {
    run: RunState;
    objectiveNodeId: string;
    actor: string;
    sequence: number;
    reason?: string;
  }): Promise<FactoryEvent> {
    if (args.actor.toLowerCase() !== args.run.actor.toLowerCase()) {
      throw new Error(`only activating actor ${args.run.actor} may cancel this run`);
    }
    const now = await this.store.serverTime();
    const event = parseFactoryEvent({
      protocol: PROTOCOL_V2,
      kind: "run",
      event: "FactoryRunCancellationRequested",
      objective: args.run.objective,
      runId: args.run.runId,
      sequence: Math.max(args.sequence, now.getTime()),
      at: now.toISOString(),
      requestedBy: args.actor,
      requestId: randomUUID(),
      ...(args.reason ? { reason: args.reason } : {}),
    });
    await this.store.addIssueComment(
      args.objectiveNodeId,
      encodeEventComment(`Factory cancellation requested by ${args.actor}.`, event),
    );
    return event;
  }
}
