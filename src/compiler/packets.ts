import { finalValidationCommands } from "../config.js";
import { graphItems } from "./split.js";
import { createHash } from "node:crypto";
import {
  assertWorkflowRecipeInput,
  type WorkflowRecipeInput,
} from "../workflow-recipes.js";
import {
  assertPlanningContextPacket,
  type PlanningContextPacket,
} from "./context.js";
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
  type OperatorPlanningDecision,
  type PlanReviewRequest,
  type ReviewedOperatorDecision,
  assertPlanningExecutionBounds,
  assertApprovedPlaybookPin,
} from "../contracts.js";
import {
  installedControllerCapabilities,
  CONTROLLER_CAPABILITIES_DIGEST,
} from "../controller-capabilities.js";
import { workflowCheckNames } from "../check-names.js";
import type { PlanCandidate } from "./candidate.js";
import type { ReviewArtifactSelector } from "../review-artifacts.js";

export function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** An open question's identity: the SHA-256 of its exact text, which status shows and `factory decide --question` names. */
export function questionDigest(question: string): string {
  return digest(question);
}

/** Refuse an answer whose `--question` names another question than the open one. */
export function assertAnsweredQuestion(
  open: string,
  named: string | undefined,
): void {
  if (named !== undefined && named !== questionDigest(open))
    throw new Error(
      "--question names a question that is not the open one; inspect status and answer the open question",
    );
}

/** A plan review packet whose operator answers are all bound to retained drafts. */
export type PlanningReviewRequest = PlanReviewRequest & {
  operatorDecisions?: OperatorPlanningDecision[];
};

export function planReviewPacket<
  D extends ReviewedOperatorDecision = OperatorPlanningDecision,
>(
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
  contextLookup?: PlanningContextPacket,
  workflowRecipe?: WorkflowRecipeInput,
  operatorDecisions?: D[],
  requiredFinalCommands: readonly string[] = [],
  reviewArtifactSelectors: readonly ReviewArtifactSelector[] = [],
): PlanReviewRequest & { operatorDecisions?: D[] } {
  if (workflowRecipe) assertWorkflowRecipeInput(workflowRecipe);
  if (executionBounds) assertPlanningExecutionBounds(executionBounds);
  if (approvedPlaybookPin !== undefined)
    assertApprovedPlaybookPin(approvedPlaybookPin);
  if (contextLookup) assertPlanningContextPacket(contextLookup, sources);
  return {
    ...(operatorDecisions?.length ? { operatorDecisions } : {}),
    ...(workflowRecipe ? { workflowRecipe } : {}),
    ...(contextLookup ? { contextLookup } : {}),
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
    // A split's commands are its ready children's.
    commands: commandAuthorizations(
      graph.split ? { ...graph, items: graphItems(graph) } : graph,
      sources,
      checkout,
    ),
    finalCommands: finalValidationCommands(
      finalObjectiveCommands(objective),
      requiredFinalCommands,
    ),
    ...(requiredFinalCommands.length
      ? { requiredFinalCommands: [...requiredFinalCommands] }
      : {}),
    // Bound so a selector removed after review is refused by name (#1641).
    ...(reviewArtifactSelectors.length
      ? {
          reviewArtifactSelectors: structuredClone([
            ...reviewArtifactSelectors,
          ]),
        }
      : {}),
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
    | "operatorDecisions"
    | "workflowRecipe"
    | "contextLookup"
    | "sources"
    | "prerequisites"
    | "localExecutables"
    | "executionBounds"
    | "amendment"
  >,
) {
  return [
    ...(packet.operatorDecisions?.length
      ? [
          {
            origin: "controller" as const,
            path: "FACTORY_OPERATOR_PLANNING_DECISIONS",
            content: JSON.stringify(packet.operatorDecisions),
          },
        ]
      : []),
    ...(packet.workflowRecipe
      ? [
          {
            origin: "controller" as const,
            path: "FACTORY_PINNED_WORKFLOW_RECIPE",
            content: JSON.stringify(packet.workflowRecipe),
          },
        ]
      : []),
    ...(packet.contextLookup
      ? [
          {
            origin: "controller" as const,
            path: "FACTORY_PLANNING_CONTEXT",
            content: JSON.stringify(packet.contextLookup),
          },
        ]
      : []),
    ...(packet.amendment?.currentImplementationEvidence ?? []).map(
      (source) => ({
        ...source,
        origin: "controller" as const,
      }),
    ),
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
