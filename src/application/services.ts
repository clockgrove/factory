import { parseFactoryEvent, type FactoryEvent } from "../protocol/events.js";
import { PROTOCOL_V2 } from "../protocol/limits.js";
import { implicitRestartBlocker } from "../control/recovery.js";
import { DEFAULT_RUN_POLICY, parseRunPolicy, policyDigest } from "../protocol/policy.js";
import {
  deduplicateFactoryEvents,
  encodeEventComment,
  latestSupportedRun,
  nextEventSequence,
} from "../control/receipts.js";
import { buildExplanationReport } from "./explain.js";
import { buildReplayReport } from "./replay.js";
import { buildStatusReport, type FactoryReadSnapshot } from "./status.js";

export const APPLICATION_OPERATIONS = [
  "doctor",
  "plan",
  "status",
  "explain",
  "activate",
  "pause",
  "resume",
  "drain",
  "cloud-pause",
  "retry",
  "priority",
  "replay",
  "cancel",
  "controller-start",
  "controller-stop",
  "controller-restart",
  "controller-status",
  "controller-install",
  "controller-uninstall",
] as const;
export type ApplicationOperation = (typeof APPLICATION_OPERATIONS)[number];

export type ApplicationSnapshot = FactoryReadSnapshot;

export interface ApplicationReader {
  readObjective(number: number): Promise<ApplicationSnapshot>;
}

export interface ApplicationCommandStore {
  addIssueComment(issueNodeId: string, body: string): Promise<void>;
  serverTime(): Promise<Date>;
  getAuthenticatedLogin(): Promise<string>;
}

export interface ControllerLifecycle {
  start(input: ControllerInput): Promise<unknown>;
  stop(input: ControllerInput): Promise<unknown>;
  restart(input: ControllerInput): Promise<unknown>;
  status(input: ControllerInput): Promise<unknown>;
  install(input: ControllerInput): Promise<unknown>;
  uninstall(input: ControllerInput): Promise<unknown>;
}
export interface ControllerInput {
  repository: string;
  checkout: string;
  requestId: string;
}

export interface ControllerLifecycleReceipt {
  operation: "start" | "stop" | "restart" | "status" | "install" | "uninstall";
  repository: string;
  checkout: string;
  requestId: string;
  accepted: false;
  status: "controller-implementation-pending";
}

/**
 * Phase 1's usable lifecycle boundary.  It gives every transport the same
 * deterministic, idempotent response without pretending that the Phase 2
 * repository controller or a system service has been installed.
 */
export class PendingControllerLifecycle implements ControllerLifecycle {
  private receipt(
    operation: ControllerLifecycleReceipt["operation"],
    input: ControllerInput,
  ): Promise<ControllerLifecycleReceipt> {
    return Promise.resolve({
      operation,
      ...input,
      accepted: false,
      status: "controller-implementation-pending",
    });
  }
  start(input: ControllerInput) {
    return this.receipt("start", input);
  }
  stop(input: ControllerInput) {
    return this.receipt("stop", input);
  }
  restart(input: ControllerInput) {
    return this.receipt("restart", input);
  }
  status(input: ControllerInput) {
    return this.receipt("status", input);
  }
  install(input: ControllerInput) {
    return this.receipt("install", input);
  }
  uninstall(input: ControllerInput) {
    return this.receipt("uninstall", input);
  }
}

export interface ServiceContext {
  owner: string;
  repo: string;
  reader: ApplicationReader;
  store?: ApplicationCommandStore;
  controller?: ControllerLifecycle;
  readBaseSha?: (defaultBranch: string) => Promise<string>;
}

export type ReadOperation = "doctor" | "plan" | "status" | "explain" | "replay";
export type CommandOperation =
  | "pause"
  | "resume"
  | "drain"
  | "cloud-pause"
  | "retry"
  | "priority"
  | "cancel";

/** A single, injectable boundary used by transports. Reads can never reach a command store. */
export class FactoryApplicationService {
  constructor(private readonly context: ServiceContext) {}

  async inspect(operation: ReadOperation, objective: number, workItem?: number): Promise<unknown> {
    const snapshot = await this.context.reader.readObjective(objective);
    const repository = `${this.context.owner}/${this.context.repo}`;
    if (operation === "status") {
      return buildStatusReport({ repository, snapshot });
    }
    if (operation === "explain") {
      return buildExplanationReport({ repository, snapshot, ...(workItem ? { workItem } : {}) });
    }
    if (operation === "replay") {
      return buildReplayReport({ repository, snapshot });
    }
    return {
      operation,
      repository,
      objective: snapshot,
      ...(workItem ? { workItem } : {}),
    };
  }

  doctor(objective: number) {
    return this.inspect("doctor", objective);
  }
  plan(objective: number) {
    return this.inspect("plan", objective);
  }
  status(objective: number) {
    return this.inspect("status", objective);
  }
  explain(objective: number, workItem?: number) {
    return this.inspect("explain", objective, workItem);
  }
  replay(objective: number) {
    return this.inspect("replay", objective);
  }

  async activate(input: {
    objective: number;
    requestId: string;
    baseSha?: string;
    policy?: unknown;
  }): Promise<FactoryEvent> {
    const snapshot = await this.context.reader.readObjective(input.objective);
    const policy = parseRunPolicy(input.policy ?? DEFAULT_RUN_POLICY);
    const baseSha = input.baseSha ?? (await this.requireBaseSha(snapshot.defaultBranch));
    return this.append(snapshot, input.requestId, {
      event: "ActivationRequested",
      repository: `${this.context.owner}/${this.context.repo}`,
      baseSha,
      policy,
      policyDigest: policyDigest(policy),
      controllerProtocolMin: PROTOCOL_V2,
      controllerProtocolMax: PROTOCOL_V2,
    });
  }

  async command(
    operation: CommandOperation,
    input: {
      objective: number;
      requestId: string;
      reason?: string;
      workItem?: number;
      priorityRank?: number;
    },
  ): Promise<FactoryEvent> {
    const snapshot = await this.context.reader.readObjective(input.objective);
    if ((operation === "retry" || operation === "priority") && !input.workItem) {
      throw new Error(`${operation} requires a Work Item number`);
    }
    if (operation === "priority" && input.priorityRank === undefined) {
      throw new Error("priority requires a priority rank");
    }
    const event =
      operation === "pause"
        ? "RunPauseRequested"
        : operation === "resume"
          ? "RunResumeRequested"
          : operation === "drain"
            ? "RunDrainRequested"
            : operation === "cloud-pause"
              ? "CloudPauseRequested"
              : operation === "retry"
                ? "WorkItemRetryRequested"
                : operation === "priority"
                  ? "WorkItemPriorityChanged"
                  : "FactoryRunCancellationRequested";
    // Durable receipts remain replayable after a run becomes terminal or a
    // Work Item leaves the live snapshot. appendLocked still compares every
    // material field before returning the original receipt.
    const existingRequest = this.allEvents(snapshot).find(
      (candidate) => "requestId" in candidate && candidate.requestId === input.requestId,
    );
    const activeRun = latestSupportedRun(snapshot.factoryEvents ?? []);
    if (!activeRun && !existingRequest) {
      throw new Error(`Objective #${snapshot.number} has no active Factory run`);
    }
    if (
      !existingRequest &&
      input.workItem &&
      !snapshot.workItems.some((item) => item.number === input.workItem)
    ) {
      throw new Error(
        `Work Item #${input.workItem} does not belong to Objective #${snapshot.number}`,
      );
    }
    return this.append(snapshot, input.requestId, {
      event,
      runId: existingRequest?.runId ?? activeRun!.runId,
      ...(input.reason ? { reason: input.reason } : {}),
      ...(input.workItem ? { workItem: input.workItem } : {}),
      ...(input.priorityRank !== undefined ? { priorityRank: input.priorityRank } : {}),
      ...(operation === "priority" ? { prioritySource: "operator-command" } : {}),
    });
  }

  controller(
    operation: "start" | "stop" | "restart" | "status" | "install" | "uninstall",
    input: ControllerInput,
  ): Promise<unknown> {
    const lifecycle = this.context.controller;
    if (!lifecycle) throw new Error("controller lifecycle is unavailable on this host");
    const key = `${input.repository.toLowerCase()}:${input.requestId}`;
    const fingerprint = JSON.stringify({
      operation,
      repository: input.repository,
      checkout: input.checkout,
    });
    const prior = FactoryApplicationService.controllerRequests.get(key);
    if (prior) {
      if (prior.fingerprint !== fingerprint)
        throw new Error(
          `idempotency key ${input.requestId} was already used for a different request`,
        );
      return prior.receipt;
    }
    const receipt = lifecycle[operation](input);
    FactoryApplicationService.controllerRequests.set(key, {
      fingerprint,
      receipt,
    });
    receipt.catch(() => {
      if (FactoryApplicationService.controllerRequests.get(key)?.receipt === receipt) {
        FactoryApplicationService.controllerRequests.delete(key);
      }
    });
    return receipt;
  }

  private async requireBaseSha(defaultBranch: string): Promise<string> {
    if (!this.context.readBaseSha) throw new Error("activation requires a base SHA");
    return this.context.readBaseSha(defaultBranch);
  }

  private allEvents(snapshot: ApplicationSnapshot): FactoryEvent[] {
    return deduplicateFactoryEvents([
      ...(snapshot.factoryEvents ?? []),
      ...snapshot.workItems.flatMap((item) => item.factoryEvents ?? []),
    ]);
  }

  private async append(
    snapshot: ApplicationSnapshot,
    requestId: string,
    fields: Record<string, unknown>,
  ): Promise<FactoryEvent> {
    return this.serialize(snapshot.number, async () => {
      // A request may have waited behind an equivalent request. Reconstruct
      // from GitHub while holding the process-wide repository/objective gate;
      // never decide idempotency from the caller's stale snapshot.
      snapshot = await this.context.reader.readObjective(snapshot.number);
      return this.appendLocked(snapshot, requestId, fields);
    });
  }

  private async appendLocked(
    snapshot: ApplicationSnapshot,
    requestId: string,
    fields: Record<string, unknown>,
  ): Promise<FactoryEvent> {
    const store = this.context.store;
    if (!store) throw new Error("this application service is read-only");
    const existing = this.allEvents(snapshot).find(
      (event) => "requestId" in event && event.requestId === requestId,
    );
    if (existing) {
      const comparableKeys = [
        "event",
        "operation",
        "repository",
        "baseSha",
        "policyDigest",
        "workItem",
        "priorityRank",
        "prioritySource",
        "reason",
      ];
      if (fields.runId !== undefined) comparableKeys.push("runId");
      const conflict = comparableKeys.some(
        (key) => (existing as unknown as Record<string, unknown>)[key] !== fields[key],
      );
      if (conflict)
        throw new Error(`idempotency key ${requestId} was already used for a different request`);
      return existing;
    }
    if (fields.event === "ActivationRequested") {
      const blocker = implicitRestartBlocker(snapshot);
      if (blocker) throw new Error(blocker);
    }
    const actor = await store.getAuthenticatedLogin();
    const activeStart = latestSupportedRun(snapshot.factoryEvents ?? []);
    if (
      new Set([
        "FactoryRunCancellationRequested",
        "RunPauseRequested",
        "RunResumeRequested",
        "RunDrainRequested",
        "CloudPauseRequested",
        "WorkItemRetryRequested",
        "WorkItemPriorityChanged",
      ]).has(String(fields.event))
    ) {
      if (!activeStart || activeStart.runId !== fields.runId) {
        throw new Error(`Objective #${snapshot.number} has no active Factory run`);
      }
      if (
        activeStart.kind === "run" &&
        activeStart.event === "FactoryRunStarted" &&
        activeStart.actor.toLowerCase() !== actor.toLowerCase()
      ) {
        throw new Error(`only activating actor ${activeStart.actor} may control this run`);
      }
      if (
        typeof fields.workItem === "number" &&
        !snapshot.workItems.some((item) => item.number === fields.workItem)
      ) {
        throw new Error(
          `Work Item #${fields.workItem} does not belong to Objective #${snapshot.number}`,
        );
      }
    }
    const now = await store.serverTime();
    const run = [...(snapshot.factoryEvents ?? [])].reverse().find((event) => event.kind === "run");
    const event = parseFactoryEvent({
      protocol: PROTOCOL_V2,
      kind: "run",
      event: fields.event,
      objective: snapshot.number,
      runId: typeof fields.runId === "string" ? fields.runId : (run?.runId ?? requestId),
      sequence: nextEventSequence(this.allEvents(snapshot)),
      at: now.toISOString(),
      requestedBy: actor,
      requestId,
      ...fields,
    });
    await store.addIssueComment(
      snapshot.id,
      encodeEventComment(`Factory accepted ${String(fields.event)} from ${actor}.`, event),
    );
    return event;
  }

  private static readonly queues = new Map<string, Promise<void>>();
  private static readonly controllerRequests = new Map<
    string,
    { fingerprint: string; receipt: Promise<unknown> }
  >();

  private async serialize<T>(objective: number, action: () => Promise<T>): Promise<T> {
    const key = `${this.context.owner.toLowerCase()}/${this.context.repo.toLowerCase()}#${objective}`;
    const previous = FactoryApplicationService.queues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    FactoryApplicationService.queues.set(key, current);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (FactoryApplicationService.queues.get(key) === current)
        FactoryApplicationService.queues.delete(key);
    }
  }
}
