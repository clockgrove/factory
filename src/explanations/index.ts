import type {
  AdmissionReasonCode,
  QueuedDecision,
  QueuedReasonCode,
} from "../scheduling/admission.js";
import type { ObservedPrioritySource } from "../scheduling/priority.js";

export const EXPLANATION_CODES = {
  dependencyOpen: "dependency.open",
  capacityGlobal: "capacity.global-exhausted",
  capacityLocal: "capacity.local-exhausted",
  capacityBackend: "capacity.backend-exhausted",
  capacityHostPressure: "capacity.host-pressure",
  capacityCooldown: "capacity.admission-cooldown",
  capacitySampleUnavailable: "capacity.sample-unavailable",
  authorityLeaseUnavailable: "authority.lease-unavailable",
  authorityRunInactive: "authority.run-inactive",
  priorityBurstThreshold: "priority.burst-threshold",
  prioritySourceUnavailable: "priority.source-unavailable",
  priorityObserved: "priority.observed",
  scopePathConflict: "scope.path-conflict",
  scopeExclusiveResourceConflict: "scope.exclusive-resource-conflict",
  scopeNetworkPolicy: "scope.network-outside-policy",
  scopePolicyConstraint: "scope.policy-constraint",
  trustSecretsUnsupported: "trust.task-secrets-unsupported",
  trustIsolationRequired: "trust.isolation-required",
  backendIncompatible: "backend.incompatible",
  backendUnavailable: "backend.unavailable",
  validationUnavailable: "validation.backend-unavailable",
  validationFailed: "validation.failed",
  validationInvalidated: "validation.invalidated",
  economicBudgetExhausted: "economic.budget-exhausted",
  economicBurstDisabled: "economic.burst-disabled",
  economicBurstTriggerPending: "economic.burst-trigger-pending",
  admissionLocal: "admission.local",
  admissionRemoteRequired: "admission.remote-required",
  admissionBurst: "admission.burst",
  executionFailed: "execution.failed",
  executionRunning: "execution.running",
  deliveryPending: "delivery.pending",
  deliveryCompleted: "delivery.completed",
  stateUnstarted: "state.unstarted",
  stateComplete: "state.complete",
} as const;

export type ExplanationCode =
  (typeof EXPLANATION_CODES)[keyof typeof EXPLANATION_CODES];
export type ExplanationCategory =
  | "dependency"
  | "capacity"
  | "authority"
  | "priority"
  | "scope"
  | "trust"
  | "backend"
  | "validation"
  | "economic"
  | "admission"
  | "execution"
  | "delivery"
  | "state";

export interface Explanation {
  code: ExplanationCode;
  category: ExplanationCategory;
  disposition: "blocked" | "queued" | "admitted" | "running" | "failed" | "complete" | "informational";
  summary: string;
  evidence: Record<string, unknown>;
}

type CapacityGateReason =
  | "global-capacity"
  | "local-capacity"
  | "backend-at-capacity"
  | "local-pressure"
  | "local-cooldown"
  | "resource-sample-unavailable";

export type GateEvidence =
  | { gate: "dependency"; openDependencies: readonly number[] }
  | { gate: "capacity"; reason: CapacityGateReason }
  | { gate: "authority"; reason: "lease-unavailable" | "run-inactive" }
  | {
      gate: "priority";
      reason: "burst-threshold" | "source-unavailable" | "observed";
      rank?: number;
      source?: ObservedPrioritySource;
    }
  | {
      gate: "scope";
      reason: "path-conflict" | "exclusive-resource-conflict" | "network-policy" | "policy-constraint";
    }
  | {
      gate: "trust";
      reason: "task-secrets-unsupported" | "isolation-required";
    }
  | { gate: "backend"; reason: "incompatible" | "unavailable" }
  | { gate: "validation"; reason: "unavailable" | "failed" | "invalidated" }
  | {
      gate: "economic";
      reason: "budget-exhausted" | "burst-disabled" | "burst-trigger-pending";
    };

function explanation(
  code: ExplanationCode,
  category: ExplanationCategory,
  disposition: Explanation["disposition"],
  summary: string,
  evidence: Record<string, unknown> = {},
): Explanation {
  return { code, category, disposition, summary, evidence };
}

/** Stable, provider-neutral explanation for one exact gate. */
export function explainGate(input: GateEvidence): Explanation {
  switch (input.gate) {
    case "dependency":
      return explanation(
        EXPLANATION_CODES.dependencyOpen,
        "dependency",
        "blocked",
        "One or more dependencies are still open.",
        { openDependencies: [...input.openDependencies].sort((a, b) => a - b) },
      );
    case "authority":
      return input.reason === "lease-unavailable"
        ? explanation(
            EXPLANATION_CODES.authorityLeaseUnavailable,
            "authority",
            "queued",
            "The repository Director lease is not current.",
          )
        : explanation(
            EXPLANATION_CODES.authorityRunInactive,
            "authority",
            "blocked",
            "No active Factory run grants execution authority.",
          );
    case "priority":
      if (input.reason === "burst-threshold") {
        return explanation(
          EXPLANATION_CODES.priorityBurstThreshold,
          "priority",
          "queued",
          "The Work Item is outside the run's paid-burst priority threshold.",
          input.rank === undefined ? {} : { rank: input.rank },
        );
      }
      if (input.reason === "source-unavailable") {
        return explanation(
          EXPLANATION_CODES.prioritySourceUnavailable,
          "priority",
          "blocked",
          "The configured priority source is unavailable and policy forbids fallback.",
        );
      }
      return explanation(
        EXPLANATION_CODES.priorityObserved,
        "priority",
        "informational",
        "The ready-order rank was derived from the recorded priority source.",
        {
          ...(input.rank === undefined ? {} : { rank: input.rank }),
          ...(input.source ? { source: input.source } : {}),
        },
      );
    case "scope": {
      const values = {
        "path-conflict": [
          EXPLANATION_CODES.scopePathConflict,
          "An active reservation overlaps this Work Item's path scope.",
        ],
        "exclusive-resource-conflict": [
          EXPLANATION_CODES.scopeExclusiveResourceConflict,
          "An active reservation owns an exclusive resource required by this Work Item.",
        ],
        "network-policy": [
          EXPLANATION_CODES.scopeNetworkPolicy,
          "The Work Item requests a network destination outside the immutable run policy.",
        ],
        "policy-constraint": [
          EXPLANATION_CODES.scopePolicyConstraint,
          "The Work Item exceeds an immutable run-policy scope boundary.",
        ],
      } as const;
      const [code, summary] = values[input.reason];
      return explanation(code, "scope", "blocked", summary);
    }
    case "trust":
      return input.reason === "task-secrets-unsupported"
        ? explanation(
            EXPLANATION_CODES.trustSecretsUnsupported,
            "trust",
            "blocked",
            "Task-specific secret injection is not authorized by this Factory release.",
          )
        : explanation(
            EXPLANATION_CODES.trustIsolationRequired,
            "trust",
            "blocked",
            "The Work Item requires an isolated execution or validation boundary.",
          );
    case "backend":
      return input.reason === "unavailable"
        ? explanation(
            EXPLANATION_CODES.backendUnavailable,
            "backend",
            "queued",
            "A compatible backend is temporarily unavailable.",
          )
        : explanation(
            EXPLANATION_CODES.backendIncompatible,
            "backend",
            "blocked",
            "No configured backend is capability-compatible.",
          );
    case "validation": {
      const values = {
        unavailable: [
          EXPLANATION_CODES.validationUnavailable,
          "queued" as const,
          "The required independent validation backend is unavailable.",
        ],
        failed: [
          EXPLANATION_CODES.validationFailed,
          "failed" as const,
          "Durable validation evidence records a failed result.",
        ],
        invalidated: [
          EXPLANATION_CODES.validationInvalidated,
          "blocked" as const,
          "A dependency head changed after validation, invalidating the recorded evidence.",
        ],
      } as const;
      const [code, disposition, summary] = values[input.reason];
      return explanation(code, "validation", disposition, summary);
    }
    case "economic": {
      const values = {
        "budget-exhausted": [
          EXPLANATION_CODES.economicBudgetExhausted,
          "The enforceable native-unit budget cannot cover this admission.",
        ],
        "burst-disabled": [
          EXPLANATION_CODES.economicBurstDisabled,
          "Paid burst is disabled by the immutable run policy.",
        ],
        "burst-trigger-pending": [
          EXPLANATION_CODES.economicBurstTriggerPending,
          "The configured queue-delay, deadline, or time-saved burst trigger is not yet met.",
        ],
      } as const;
      const [code, summary] = values[input.reason];
      return explanation(code, "economic", "queued", summary);
    }
    case "capacity":
      return explainCapacity(input.reason);
  }
}

function explainCapacity(reason: CapacityGateReason): Explanation {
  if (reason === "global-capacity") {
    return explanation(
      EXPLANATION_CODES.capacityGlobal,
      "capacity",
      "queued",
      "The effective repository or Objective concurrency ceiling is full.",
    );
  }
  if (reason === "local-capacity") {
    return explanation(
      EXPLANATION_CODES.capacityLocal,
      "capacity",
      "queued",
      "No safe local CPU, memory, or worker slot currently fits this Work Item.",
    );
  }
  if (reason === "backend-at-capacity") {
    return explanation(
      EXPLANATION_CODES.capacityBackend,
      "capacity",
      "queued",
      "The selected execution or validation backend is at its effective ceiling.",
    );
  }
  if (reason === "local-pressure") {
    return explanation(
      EXPLANATION_CODES.capacityHostPressure,
      "capacity",
      "queued",
      "Observed host load or memory pressure blocks new local admission.",
    );
  }
  if (reason === "local-cooldown") {
    return explanation(
      EXPLANATION_CODES.capacityCooldown,
      "capacity",
      "queued",
      "Local admission is in its pressure cooldown window.",
    );
  }
  return explanation(
    EXPLANATION_CODES.capacitySampleUnavailable,
    "capacity",
    "queued",
    "No valid host resource sample is available for adaptive admission.",
  );
}

/** Convert the scheduler's stable queue decision into an exact user-facing gate. */
export function explainQueuedDecision(
  decision: Pick<QueuedDecision, "code" | "reason" | "observedPriorityRank"> &
    Partial<Pick<QueuedDecision, "gate">>,
): Explanation {
  if (decision.gate === "validation") {
    return explainGate({ gate: "validation", reason: "unavailable" });
  }
  switch (decision.code) {
    case "lease-unavailable":
      return explainGate({ gate: "authority", reason: "lease-unavailable" });
    case "global-capacity":
    case "local-capacity":
    case "backend-at-capacity":
    case "local-pressure":
    case "local-cooldown":
    case "resource-sample-unavailable":
      return explainGate({ gate: "capacity", reason: decision.code });
    case "path-conflict":
    case "exclusive-resource-conflict":
      return explainGate({ gate: "scope", reason: decision.code });
    case "backend-incompatible":
    case "backend-unavailable":
      if (decision.reason.toLowerCase().includes("validation")) {
        return explainGate({ gate: "validation", reason: "unavailable" });
      }
      return explainGate({
        gate: "backend",
        reason: decision.code === "backend-unavailable" ? "unavailable" : "incompatible",
      });
    case "budget-exhausted":
    case "burst-disabled":
    case "burst-trigger-pending":
      return explainGate({ gate: "economic", reason: decision.code });
    case "burst-priority":
      return explainGate({
        gate: "priority",
        reason: "burst-threshold",
        rank: decision.observedPriorityRank,
      });
    case "policy-constraint": {
      const normalized = decision.reason.toLowerCase();
      if (normalized.includes("network destination")) {
        return explainGate({ gate: "scope", reason: "network-policy" });
      }
      if (normalized.includes("secret")) {
        return explainGate({ gate: "trust", reason: "task-secrets-unsupported" });
      }
      return explainGate({ gate: "scope", reason: "policy-constraint" });
    }
  }
}

export function explainAdmission(reason: AdmissionReasonCode): Explanation {
  if (reason === "local-capacity") {
    return explanation(
      EXPLANATION_CODES.admissionLocal,
      "admission",
      "admitted",
      "The Work Item fit the measured local capacity and policy boundaries.",
      { admissionReason: reason },
    );
  }
  if (reason === "capability-required") {
    return explanation(
      EXPLANATION_CODES.admissionRemoteRequired,
      "admission",
      "admitted",
      "Local execution was incompatible, so an explicitly authorized remote backend was required.",
      { admissionReason: reason },
    );
  }
  return explanation(
    EXPLANATION_CODES.admissionBurst,
    "admission",
    "admitted",
    "Local work used explicitly authorized paid burst after its configured trigger passed.",
    { admissionReason: reason },
  );
}

/** Parse only known durable prefixes; never surface the provider's raw reason text. */
export function queuedReasonCode(reason: string): QueuedReasonCode | null {
  const prefix = reason.split(":", 1)[0];
  const codes: readonly QueuedReasonCode[] = [
    "lease-unavailable",
    "policy-constraint",
    "backend-incompatible",
    "backend-unavailable",
    "backend-at-capacity",
    "global-capacity",
    "local-capacity",
    "local-pressure",
    "local-cooldown",
    "resource-sample-unavailable",
    "budget-exhausted",
    "burst-disabled",
    "burst-trigger-pending",
    "burst-priority",
    "path-conflict",
    "exclusive-resource-conflict",
  ];
  return codes.find((code) => code === prefix) ?? null;
}
