import { createHash } from "node:crypto";
import {
  type PlanningSource,
  commandAuthorizations,
  finalObjectiveCommands,
} from "./sources.js";
import {
  type WorkGraph,
  type ExecutionProfileChoices,
  type PlanningPrerequisites,
  type PlanningLocalExecutables,
  type PlanningExecutionBounds,
  type ApprovedPlaybookPin,
  type PlanReviewRequest,
  assertPlanningExecutionBounds,
  assertApprovedPlaybookPin,
} from "../contracts.js";
import {
  installedControllerCapabilities,
  CONTROLLER_CAPABILITIES_DIGEST,
} from "../controller-capabilities.js";
import { workflowCheckNames } from "../check-names.js";
import type { PlanCandidate } from "./candidate.js";

export function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function planReviewPacket(
  objective: string,
  baseSha: string,
  sources: PlanningSource[],
  graph: WorkGraph,
  checkout: string,
  executionProfiles?: ExecutionProfileChoices,
  prerequisites?: PlanningPrerequisites,
  localExecutables?: PlanningLocalExecutables,
  executionBounds?: PlanningExecutionBounds,
  approvedPlaybookPin?: ApprovedPlaybookPin,
): PlanReviewRequest {
  if (executionBounds) assertPlanningExecutionBounds(executionBounds);
  if (approvedPlaybookPin !== undefined)
    assertApprovedPlaybookPin(approvedPlaybookPin);
  return {
    ...(approvedPlaybookPin !== undefined ? { approvedPlaybookPin } : {}),
    ...(prerequisites ? { prerequisites } : {}),
    ...(localExecutables ? { localExecutables } : {}),
    ...(executionBounds ? { executionBounds } : {}),
    objective,
    baseSha,
    sources,
    controllerCapabilities: installedControllerCapabilities(),
    controllerCapabilitiesDigest: CONTROLLER_CAPABILITIES_DIGEST,
    graph,
    ...(executionProfiles ? { executionProfiles } : {}),
    commands: commandAuthorizations(graph, sources, checkout),
    finalCommands: finalObjectiveCommands(objective),
    checkNames: workflowCheckNames(checkout, baseSha),
  };
}

export function planReviewDigest(packet: PlanReviewRequest): string {
  return digest(JSON.stringify(packet));
}

export function reviewResultDigest(
  packetDigest: string,
  review: Pick<PlanCandidate["review"], "revisions" | "findings" | "failure">,
): string {
  return digest(
    JSON.stringify({
      packetDigest,
      revisions: review.revisions,
      findings: review.findings,
      ...(review.failure ? { failure: review.failure } : {}),
    }),
  );
}

export function planningReviewEvidence(
  packet: Pick<
    PlanReviewRequest,
    "sources" | "prerequisites" | "localExecutables" | "executionBounds"
  >,
) {
  return [
    ...packet.sources.map((source) => ({
      ...source,
      origin: "source" as const,
    })),
    ...(packet.executionBounds
      ? [
          {
            origin: "controller" as const,
            path: "FACTORY_EXECUTION_BOUNDS",
            content: JSON.stringify(packet.executionBounds),
          },
        ]
      : []),
    ...(packet.prerequisites
      ? [
          {
            origin: "controller" as const,
            path: "FACTORY_NATIVE_OBJECTIVE_PREREQUISITES",
            content: JSON.stringify(packet.prerequisites),
          },
        ]
      : []),
    ...(packet.localExecutables
      ? [
          {
            origin: "controller" as const,
            path: "FACTORY_LOCAL_EXECUTABLE_OBSERVATIONS",
            content: JSON.stringify(packet.localExecutables),
          },
        ]
      : []),
  ];
}
