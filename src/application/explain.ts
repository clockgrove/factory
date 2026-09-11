import {
  EXPLANATION_CODES,
  explainAdmission,
  explainGate,
  explainQueuedDecision,
  queuedReasonCode,
  type Explanation,
} from "../explanations/index.js";
import { latestRunReceipts, terminalRunEvidence } from "../control/receipts.js";
import { buildStatusReport, snapshotEvents, type FactoryReadSnapshot } from "./status.js";
import { latestProviderQuotaGate } from "../control/provider-gates.js";

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
  const run = latestRunReceipts(events, input.snapshot.objectiveAuthority);
  const providerGate = run ? latestProviderQuotaGate(run.events, run.runId) : undefined;
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
    const inactive = explainGate({ gate: "authority", reason: "run-inactive" });
    explanations.push(
      status.activation?.state === "rejected"
        ? {
            code: EXPLANATION_CODES.authorityActivationRejected,
            category: "authority",
            disposition: "failed",
            summary:
              status.activation.rejectionReason ??
              "The activation was rejected before a Factory run started.",
            gate: "activation",
            requiredAction:
              "No Factory work is active; stop recurring monitoring. Correct the recorded preflight reason, then submit a new explicitly authorized activation request.",
            evidence: {
              activationRequestId: status.activation.requestId,
              ...(status.activation.rejectedAt ? { rejectedAt: status.activation.rejectedAt } : {}),
              ...(status.activation.rejectionReason
                ? { reason: status.activation.rejectionReason }
                : {}),
              factoryWorkActive: false,
              monitoring: "stop",
            },
          }
        : status.activation?.state === "withdrawn"
          ? {
              ...inactive,
              summary: `Activation ${status.activation.requestId} was withdrawn by request ${status.activation.cancellationRequestId}; no Factory run started.`,
            }
          : inactive,
    );
  }
  if (providerGate?.kind === "provider" && run?.terminal?.event !== "FactoryRunCancelled") {
    const terminal = Boolean(run?.terminal);
    explanations.push({
      code: EXPLANATION_CODES.providerQuotaExhausted,
      category: "provider",
      disposition: "blocked",
      summary: providerGate.providerMessage,
      gate: "provider",
      requiredAction: terminal
        ? `No Factory work is active; stop recurring monitoring. Restore quota for provider "${providerGate.provider}"${providerGate.actionUrl ? ` at ${providerGate.actionUrl}` : ""}, then explicitly request recovery through factory_recovery_plan.`
        : `New model work is blocked, but admitted work and resources may still be reconciling. Continue recurring monitoring until the run has a terminal receipt; do not retry this invocation. Quota for provider "${providerGate.provider}" must be restored before explicit recovery.`,
      evidence: {
        reasonCode: providerGate.reasonCode,
        provider: providerGate.provider,
        phase: providerGate.phase,
        backend: providerGate.backend,
        modelInvocationId: providerGate.modelInvocationId,
        observedAt: providerGate.at,
        accounting: providerGate.accounting,
        ...(providerGate.actionUrl ? { actionUrl: providerGate.actionUrl } : {}),
        ...(providerGate.workItem !== undefined ? { workItem: providerGate.workItem } : {}),
        ...(providerGate.attempt !== undefined ? { attempt: providerGate.attempt } : {}),
        factoryWorkActive: !terminal,
        monitoring: terminal ? "stop" : "continue",
      },
    });
  }
  if (!providerGate && run?.terminal?.event === "FactoryRunEscalated") {
    const terminal = terminalRunEvidence(run.terminal);
    const recoverySuccessor = Boolean(run.start.predecessorRunId);
    explanations.push({
      code: recoverySuccessor
        ? EXPLANATION_CODES.recoverySuccessorEscalated
        : EXPLANATION_CODES.executionRunEscalated,
      category: recoverySuccessor ? "recovery" : "execution",
      disposition: "failed",
      summary: terminal.reason ?? "The selected Factory run ended in terminal escalation.",
      gate: recoverySuccessor ? "recovery-successor" : "execution",
      requiredAction: recoverySuccessor
        ? "No Factory work is active; stop recurring monitoring. Resolve the recorded terminal reason, then use factory_recovery_plan before proposing another explicitly authorized successor."
        : "No Factory work is active; stop recurring monitoring. Resolve the recorded terminal reason before requesting an explicitly authorized recovery successor.",
      evidence: {
        runId: terminal.runId,
        terminalSequence: terminal.sequence,
        terminalAt: terminal.at,
        terminalEvent: terminal.event,
        ...(terminal.reason !== undefined ? { reason: terminal.reason } : {}),
        ...(terminal.reasonDigest ? { reasonDigest: terminal.reasonDigest } : {}),
        ...(run.start.predecessorRunId ? { predecessorRunId: run.start.predecessorRunId } : {}),
        ...(run.start.recoveryRequestId ? { recoveryRequestId: run.start.recoveryRequestId } : {}),
        ...(run.start.recoveryPlanDigest
          ? { recoveryPlanDigest: run.start.recoveryPlanDigest }
          : {}),
        factoryWorkActive: false,
        monitoring: "stop",
      },
    });
  }
  if (!run?.terminal && status.operatorAction.code === "run-paused") {
    explanations.push({
      code: EXPLANATION_CODES.authorityRunPaused,
      category: "authority",
      disposition: "blocked",
      summary: status.operatorAction.summary,
      requiredAction: status.operatorAction.requiredAction,
      evidence: { ...status.operatorAction.evidence, monitoring: "stop" },
    });
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
