import { createHash } from "node:crypto";

import { summarizeRun, type RunSummary } from "../economics/index.js";
import { queuedReasonCode } from "../explanations/index.js";
import { latestRunReceipts } from "../control/receipts.js";
import {
  replayAdmissions,
  type AdmissionReplayResult,
  type PinnedAdmissionSnapshot,
} from "../replay/index.js";
import {
  snapshotEvents,
  type FactoryReadSnapshot,
} from "./status.js";

export type ReplayedSchedulingDecision =
  | {
      sequence: number;
      at: string;
      workItem: number;
      decision: "admitted";
      attempt: number;
      backendId: string;
      admissionClass: "local" | "remote-required" | "burst" | "unavailable";
      reasonCode: string;
      priorityRank?: number;
      subIssuePosition?: number;
      capacity?: {
        measuredAt: string;
        effectiveCpu: number;
        availableMemoryMb: number;
        loadRatio: number;
        memoryUsageRatio: number;
      };
    }
  | {
      sequence: number;
      at: string;
      workItem: number;
      decision: "queued";
      reasonCode: string;
      priorityRank: number;
      subIssuePosition: number;
    };

export interface FactoryReplayReport {
  operation: "replay";
  repository: string;
  objective: number;
  writeFree: true;
  run:
    | { availability: "unavailable"; reason: string }
    | {
        availability: "observed";
        runId: string;
        receiptDigest: string;
        decisions: ReplayedSchedulingDecision[];
        summary: RunSummary;
      };
  simulations: AdmissionReplayResult[];
  schedulerSimulation:
    | { availability: "observed"; snapshotCount: number; allReproduced: boolean }
    | {
        availability: "unavailable";
        reason: string;
      };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

/**
 * Purely reconstruct the durable decision timeline and, when supplied, rerun
 * exact pinned admission snapshots. No branch, issue, session, or provider
 * mutation is reachable from this module.
 */
export function buildReplayReport(input: {
  repository: string;
  snapshot: FactoryReadSnapshot;
  pinnedAdmissionSnapshots?: readonly PinnedAdmissionSnapshot[];
}): FactoryReplayReport {
  const events = snapshotEvents(input.snapshot);
  const run = latestRunReceipts(events);
  const simulations = (input.pinnedAdmissionSnapshots ?? []).map(replayAdmissions);
  if (!run) {
    return {
      operation: "replay",
      repository: input.repository,
      objective: input.snapshot.number,
      writeFree: true,
      run: {
        availability: "unavailable",
        reason: "no FactoryRunStarted receipt is available",
      },
      simulations,
      schedulerSimulation:
        simulations.length > 0
          ? {
              availability: "observed",
              snapshotCount: simulations.length,
              allReproduced: simulations.every((result) => result.reproduced),
            }
          : {
              availability: "unavailable",
              reason: "no pinned admission snapshot was supplied; durable receipts are reconstructed but not misrepresented as scheduler recomputation",
            },
    };
  }
  const decisions: ReplayedSchedulingDecision[] = [];
  for (const event of run.events) {
    if (event.kind === "scheduling") {
      const code = event.reasonCode ?? queuedReasonCode(event.reason);
      decisions.push({
        sequence: event.sequence,
        at: event.at,
        workItem: event.workItem,
        decision: "queued",
        reasonCode: code ?? "unavailable",
        priorityRank: event.observedPriorityRank,
        subIssuePosition: event.observedSubIssuePosition,
      });
      continue;
    }
    if (event.kind !== "attempt" || event.event !== "AttemptReserved") continue;
    const completeCapacity =
      event.capacityMeasuredAt !== undefined &&
      event.effectiveCpu !== undefined &&
      event.availableMemoryMb !== undefined &&
      event.loadRatio !== undefined &&
      event.memoryUsageRatio !== undefined;
    decisions.push({
      sequence: event.sequence,
      at: event.at,
      workItem: event.workItem,
      decision: "admitted",
      attempt: event.attempt,
      backendId: event.backend,
      admissionClass: event.admissionClass ?? "unavailable",
      reasonCode: event.admissionReason ?? "unavailable",
      ...(event.priorityRank === undefined
        ? {}
        : { priorityRank: event.priorityRank }),
      ...(event.subIssuePosition === undefined
        ? {}
        : { subIssuePosition: event.subIssuePosition }),
      ...(completeCapacity
        ? {
            capacity: {
              measuredAt: event.capacityMeasuredAt!,
              effectiveCpu: event.effectiveCpu!,
              availableMemoryMb: event.availableMemoryMb!,
              loadRatio: event.loadRatio!,
              memoryUsageRatio: event.memoryUsageRatio!,
            },
          }
        : {}),
    });
  }
  const summary = summarizeRun(events, run.start.policy);
  if (!summary) throw new Error("run receipt selection lost its summary");
  return {
    operation: "replay",
    repository: input.repository,
    objective: input.snapshot.number,
    writeFree: true,
    run: {
      availability: "observed",
      runId: run.runId,
      receiptDigest: digest(decisions),
      decisions,
      summary,
    },
    simulations,
    schedulerSimulation:
      simulations.length > 0
        ? {
            availability: "observed",
            snapshotCount: simulations.length,
            allReproduced: simulations.every((result) => result.reproduced),
          }
        : {
            availability: "unavailable",
            reason: "no pinned admission snapshot was supplied; durable receipts are reconstructed but not misrepresented as scheduler recomputation",
          },
  };
}
