import {
  EXPLANATION_CODES,
  explainAdmission,
  explainGate,
  explainQueuedDecision,
  queuedReasonCode,
  type Explanation,
} from "../explanations/index.js";
import { latestRunReceipts } from "../control/receipts.js";
import { buildStatusReport, snapshotEvents, type FactoryReadSnapshot } from "./status.js";

export interface FactoryExplanationReport {
  operation: "explain";
  repository: string;
  objective: number;
  workItem?: number;
  explanations: Array<Explanation & { workItem?: number }>;
}

function stateExplanation(state: string): Explanation {
  if (state === "done") {
    return {
      code: EXPLANATION_CODES.stateComplete,
      category: "state",
      disposition: "complete",
      summary: "GitHub evidence records this Work Item as complete.",
      evidence: {},
    };
  }
  if (state === "for_review" || state === "validating") {
    return {
      code: EXPLANATION_CODES.deliveryPending,
      category: "delivery",
      disposition: "running",
      summary: "Implementation evidence exists and delivery or validation is still pending.",
      evidence: { state },
    };
  }
  if (state === "failed" || state === "inconsistent") {
    return {
      code: EXPLANATION_CODES.executionFailed,
      category: "execution",
      disposition: "failed",
      summary: "Durable attempt or repository evidence records an unsuccessful execution state.",
      evidence: { state },
    };
  }
  if (["reserved", "in_flight", "dispatched"].includes(state)) {
    return {
      code: EXPLANATION_CODES.executionRunning,
      category: "execution",
      disposition: "running",
      summary: "A durable reservation or execution signal records active work.",
      evidence: { state },
    };
  }
  return {
    code: EXPLANATION_CODES.stateUnstarted,
    category: "state",
    disposition: "informational",
    summary: "The Work Item has not been admitted.",
    evidence: { state },
  };
}

export function buildExplanationReport(input: {
  repository: string;
  snapshot: FactoryReadSnapshot;
  workItem?: number;
}): FactoryExplanationReport {
  const events = snapshotEvents(input.snapshot);
  const run = latestRunReceipts(events);
  const status = buildStatusReport({
    repository: input.repository,
    snapshot: input.snapshot,
  });
  const selected = input.workItem
    ? status.workItems.filter((item) => item.number === input.workItem)
    : status.workItems;
  if (input.workItem && selected.length === 0) {
    throw new Error(
      `Work Item #${input.workItem} not found on Objective #${input.snapshot.number}`,
    );
  }
  const explanations: Array<Explanation & { workItem?: number }> = [];
  if (!run) {
    explanations.push(explainGate({ gate: "authority", reason: "run-inactive" }));
  }
  for (const item of selected) {
    if (item.openDependencies.length > 0) {
      explanations.push({
        ...explainGate({
          gate: "dependency",
          openDependencies: item.openDependencies,
        }),
        workItem: item.number,
      });
      continue;
    }
    const source = input.snapshot.workItems.find((candidate) => candidate.number === item.number)!;
    const itemEvents = (source.factoryEvents ?? [])
      .filter((event) => !run || event.runId === run.runId)
      .sort((left, right) => left.sequence - right.sequence);
    const invalidated = [...itemEvents]
      .reverse()
      .find((event) => event.kind === "publication" && event.event === "ValidationInvalidated");
    if (invalidated) {
      explanations.push({
        ...explainGate({ gate: "validation", reason: "invalidated" }),
        workItem: item.number,
      });
      continue;
    }
    const validation = [...itemEvents].reverse().find((event) => event.kind === "validation");
    if (validation?.kind === "validation" && !validation.passed) {
      explanations.push({
        ...explainGate({ gate: "validation", reason: "failed" }),
        workItem: item.number,
      });
      continue;
    }
    const latestAdmission = [...itemEvents]
      .reverse()
      .find((event) => event.kind === "attempt" && event.event === "AttemptReserved");
    const queue = [...itemEvents]
      .reverse()
      .find(
        (event) =>
          event.kind === "scheduling" &&
          (!latestAdmission || event.sequence > latestAdmission.sequence),
      );
    if (queue?.kind === "scheduling") {
      const code = queue.reasonCode ?? queuedReasonCode(queue.reason);
      if (code) {
        explanations.push({
          ...explainQueuedDecision({
            code,
            reason: queue.reason,
            observedPriorityRank: queue.observedPriorityRank,
            ...(queue.gate ? { gate: queue.gate } : {}),
          }),
          workItem: item.number,
        });
        continue;
      }
    }
    if (latestAdmission?.kind === "attempt" && latestAdmission.admissionReason !== undefined) {
      explanations.push({
        ...explainAdmission(latestAdmission.admissionReason),
        workItem: item.number,
        evidence: {
          attempt: latestAdmission.attempt,
          backendId: latestAdmission.backend,
          admissionClass: latestAdmission.admissionClass,
          admissionReason: latestAdmission.admissionReason,
        },
      });
      if (item.priority) {
        explanations.push({
          ...explainGate({
            gate: "priority",
            reason: "observed",
            rank: item.priority.rank,
            source: item.priority.source,
          }),
          workItem: item.number,
        });
      }
      continue;
    }
    explanations.push({ ...stateExplanation(item.state), workItem: item.number });
  }
  return {
    operation: "explain",
    repository: input.repository,
    objective: input.snapshot.number,
    ...(input.workItem ? { workItem: input.workItem } : {}),
    explanations,
  };
}
