import { assertDeclaredConditions } from "../adaptive-routing.js";
import {
  assertWorkflowRecipeGraph,
  assertWorkflowRecipeContext,
  type WorkflowRecipeInput,
} from "../workflow-recipes.js";
import {
  assertDiscoveryContextScope,
  assertContextFactsResolved,
  type PlanningContextPacket,
} from "./context.js";
import type {
  ApprovedPlaybookPin,
  PlanningPrerequisites,
  PlanningLocalExecutables,
  PlanningExecutionBounds,
  ExecutionProfileChoices,
  OperatorPlanningDecision,
  WorkGraph,
  PlanCommandAuthorization,
  PlanReviewRequest,
} from "../contracts.js";
import {
  planningSources,
  assertObjectiveCriteria,
  objectiveCriteria,
  commandAuthority,
  validateCitations,
  assertWorkerInputSources,
  validateCommandProvenance,
} from "./sources.js";
import {
  type ControllerCapabilitiesManifest,
  assertInstalledControllerCapabilities,
} from "../controller-capabilities.js";
import type { ResolvedGraphFinding } from "../review-evidence.js";
import type { checkedPlanReview } from "./planning.js";
import {
  assertAnsweredQuestion,
  type PlanningReviewRequest,
  planReviewDigest,
  digest,
  reviewResultDigest,
  planReviewPacket,
} from "./packets.js";
import { assertPreIntegrationCheckSources } from "../delivery/readiness.js";
import { assertKnownCheckNames, workflowCheckNames } from "../check-names.js";
import { validateAndOrderGraph } from "../scheduler.js";
import { assertCoverageSources, coverageObligations } from "../qa.js";
import { assertGraphExpansions } from "../graph-expansion.js";
import { verifySplitGraph } from "./split.js";

export interface PlanCandidate {
  workflowRecipe?: WorkflowRecipeInput;
  contextLookup?: PlanningContextPacket;
  approvedPlaybookPin?: ApprovedPlaybookPin;
  schemaVersion: 3 | 4 | 5 | 6 | 7;
  prerequisites?: PlanningPrerequisites;
  localExecutables?: PlanningLocalExecutables;
  executionBounds?: PlanningExecutionBounds;
  executionProfiles?: ExecutionProfileChoices;
  objective: number;
  baseSha: string;
  bodyDigest: string;
  /** Pinned source identities; their bytes are re-derived from the base and the body. */
  sourceDigests: { path: string; heading?: string; digest: string }[];
  controllerCapabilities: ControllerCapabilitiesManifest;
  controllerCapabilitiesDigest: string;
  graph: WorkGraph;
  graphDigest: string;
  /**
   * A ready child Objective's graph, reviewed with its parent's split rather
   * than by its own graph review. The bytes still verify against the child.
   */
  adoptedFrom?: { objective: number; key: string; reviewDigest: string };
  commands: PlanCommandAuthorization[];
  finalCommands: string[];
  /** The installation's required final-validation commands this plan was reviewed with. */
  requiredFinalCommands?: string[];
  /** The installation's review-artifact selectors this plan was compiled and reviewed with. */
  reviewArtifactSelectors?: PlanReviewRequest["reviewArtifactSelectors"];
  /** Digest of the complete immutable packet supplied to independent review. */
  packetDigest: string;
  /** Digest of the packet digest and immutable independent-review result. */
  reviewDigest: string;
  /** Factory installation configuration bound at preview time. */
  configDigest: string;
  /** Operator answers to the planner's and plan reviews' questions this graph was revised for; reviewed with it. */
  operatorDecisions?: OperatorPlanningDecision[];
  humanDecision?: {
    question: string;
    answer: string;
    actor: string;
    at: string;
    outcome: "accept" | "refuse";
    reason: string;
    reviewDigest: string;
  };
  review: {
    status: "clean" | "needs-human" | "human-accepted" | "refused";
    /**
     * False when Factory's own checks refuse this plan (for example its
     * execution bounds differ from configuration): only a refusal can
     * answer it. Not part of the review digest.
     */
    acceptable?: false;
    revisions: number;
    failure?: { detail: string; question: string };
    findings: (
      | ResolvedGraphFinding
      | { source: string; quote: string; detail: string; question: string }
    )[];
  };
}

export function buildPlanCandidate(
  objective: number,
  body: string,
  baseSha: string,
  configDigest: string,
  executionProfiles: ExecutionProfileChoices | undefined,
  sources: ReturnType<typeof planningSources>,
  graph: WorkGraph,
  packet: PlanningReviewRequest,
  review: Awaited<ReturnType<typeof checkedPlanReview>>,
  revisions: number,
): PlanCandidate {
  const findings = review.findings;
  const packetDigest = planReviewDigest(packet);
  const candidateReview: PlanCandidate["review"] = {
    status: findings.length || review.failure ? "needs-human" : "clean",
    revisions,
    findings,
    ...(review.failure ? { failure: review.failure } : {}),
  };
  return {
    ...(packet.operatorDecisions
      ? { operatorDecisions: structuredClone(packet.operatorDecisions) }
      : {}),
    ...(packet.workflowRecipe
      ? { workflowRecipe: structuredClone(packet.workflowRecipe) }
      : {}),
    schemaVersion: packet.workflowRecipe
      ? 7
      : graph.conditions?.length
        ? 6
        : graph.expansions?.length
          ? 5
          : packet.contextLookup ||
              graph.items.some((item) => item.kind === "discovery")
            ? 4
            : 3,
    ...(packet.contextLookup
      ? { contextLookup: structuredClone(packet.contextLookup) }
      : {}),
    ...(packet.approvedPlaybookPin !== undefined
      ? { approvedPlaybookPin: packet.approvedPlaybookPin }
      : {}),
    ...(packet.prerequisites ? { prerequisites: packet.prerequisites } : {}),
    ...(packet.localExecutables
      ? { localExecutables: packet.localExecutables }
      : {}),
    ...(packet.executionBounds
      ? { executionBounds: packet.executionBounds }
      : {}),
    ...(executionProfiles ? { executionProfiles } : {}),
    objective,
    baseSha,
    bodyDigest: digest(body),
    sourceDigests: sources.map(({ path, heading, content }) => ({
      path,
      ...(heading ? { heading } : {}),
      digest: digest(content),
    })),
    controllerCapabilities: packet.controllerCapabilities,
    controllerCapabilitiesDigest: packet.controllerCapabilitiesDigest,
    graph,
    graphDigest: digest(JSON.stringify(graph)),
    commands: packet.commands,
    finalCommands: packet.finalCommands,
    ...(packet.requiredFinalCommands
      ? { requiredFinalCommands: [...packet.requiredFinalCommands] }
      : {}),
    ...(packet.reviewArtifactSelectors
      ? {
          reviewArtifactSelectors: structuredClone(
            packet.reviewArtifactSelectors,
          ),
        }
      : {}),
    packetDigest,
    reviewDigest: reviewResultDigest(packetDigest, candidateReview),
    configDigest,
    review: candidateReview,
  };
}

export function completeAcceptedDecision(
  decision: PlanCandidate["humanDecision"],
): decision is NonNullable<PlanCandidate["humanDecision"]> {
  return Boolean(
    decision?.outcome === "accept" &&
      typeof decision.actor === "string" &&
      decision.actor.trim() &&
      typeof decision.answer === "string" &&
      decision.answer.trim() &&
      typeof decision.reason === "string" &&
      decision.reason.trim() &&
      typeof decision.at === "string" &&
      decision.at.trim(),
  );
}

/** Reject a stale or modified preview before activating its exact graph. */
export function verifyPlanCandidate(
  candidate: PlanCandidate,
  objective: number,
  body: string,
  baseSha: string,
  checkout: string,
  configDigest: string,
  allowPending = false,
  configuredConcurrency?: number,
): void {
  if (candidate.workflowRecipe) {
    assertWorkflowRecipeContext(
      candidate.contextLookup,
      candidate.workflowRecipe,
    );
    if (!candidate.contextLookup)
      throw new Error("Pinned recipes require admitted adaptive context");
    assertWorkflowRecipeGraph(candidate.graph, candidate.workflowRecipe);
    if (
      candidate.workflowRecipe.pin.origin.kind === "repository" &&
      candidate.workflowRecipe.pin.origin.baseSha !== baseSha
    )
      throw new Error("Recipe origin differs from candidate base");
  }
  assertObjectiveCriteria(body);
  assertDiscoveryContextScope(candidate.graph, candidate.contextLookup);
  assertDeclaredConditions(candidate.graph);
  assertGraphExpansions(candidate.graph, {
    executionProfiles: candidate.executionProfiles,
  });
  assertInstalledControllerCapabilities(
    candidate.controllerCapabilities,
    candidate.controllerCapabilitiesDigest,
  );
  if (
    candidate.executionBounds &&
    configuredConcurrency !== undefined &&
    candidate.executionBounds.configuredConcurrency !== configuredConcurrency
  )
    throw new Error(
      "Planning execution bounds differ from current configuration",
    );
  const expectedSources = planningSources(body, baseSha, checkout);
  if (candidate.contextLookup)
    assertContextFactsResolved(candidate.contextLookup, expectedSources);
  const expectedPacket = planReviewPacket(
    body,
    baseSha,
    expectedSources,
    candidate.graph,
    checkout,
    candidate.executionProfiles,
    candidate.prerequisites,
    candidate.localExecutables,
    candidate.executionBounds,
    candidate.approvedPlaybookPin,
    candidate.contextLookup,
    candidate.workflowRecipe,
    candidate.operatorDecisions,
    candidate.requiredFinalCommands,
    candidate.reviewArtifactSelectors,
  );
  if (
    (candidate.prerequisites &&
      (candidate.prerequisites.objective !== objective ||
        candidate.prerequisites.baseSha !== baseSha)) ||
    (candidate.localExecutables &&
      (candidate.localExecutables.provenance !==
        "controller-local-validation-executable-preflight" ||
        candidate.localExecutables.baseSha !== baseSha ||
        JSON.stringify(candidate.localExecutables.finalCommands) !==
          JSON.stringify(expectedPacket.finalCommands))) ||
    candidate.schemaVersion !==
      (candidate.workflowRecipe
        ? 7
        : candidate.graph.conditions?.length
          ? 6
          : candidate.graph.expansions?.length
            ? 5
            : candidate.contextLookup ||
                candidate.graph.items.some((item) => item.kind === "discovery")
              ? 4
              : 3) ||
    candidate.objective !== objective ||
    candidate.baseSha !== baseSha ||
    candidate.bodyDigest !== digest(body) ||
    candidate.configDigest !== configDigest ||
    JSON.stringify(candidate.controllerCapabilities) !==
      JSON.stringify(expectedPacket.controllerCapabilities) ||
    candidate.controllerCapabilitiesDigest !==
      expectedPacket.controllerCapabilitiesDigest ||
    candidate.graphDigest !== digest(JSON.stringify(candidate.graph)) ||
    JSON.stringify(candidate.commands) !==
      JSON.stringify(expectedPacket.commands) ||
    JSON.stringify(candidate.finalCommands) !==
      JSON.stringify(expectedPacket.finalCommands) ||
    candidate.packetDigest !== planReviewDigest(expectedPacket) ||
    candidate.reviewDigest !==
      reviewResultDigest(candidate.packetDigest, candidate.review) ||
    JSON.stringify(candidate.sourceDigests) !==
      JSON.stringify(
        expectedSources.map(({ path, heading, content }) => ({
          path,
          ...(heading ? { heading } : {}),
          digest: digest(content),
        })),
      )
  )
    throw new Error(
      "Plan candidate differs from the current Objective, base, or source packet; run plan again",
    );
  if (
    !allowPending &&
    !(
      (candidate.review.status === "clean" &&
        !candidate.review.findings.length &&
        !candidate.review.failure) ||
      (candidate.review.status === "human-accepted" &&
        Boolean(candidate.review.findings.length || candidate.review.failure) &&
        completeAcceptedDecision(candidate.humanDecision) &&
        candidate.humanDecision.reviewDigest === candidate.reviewDigest &&
        candidate.humanDecision.question ===
          (candidate.review.failure?.question ??
            candidate.review.findings[0]?.question))
    )
  )
    throw new Error("Plan needs a specific human source decision before run");
  if (
    !allowPending &&
    candidate.commands.some((command) => command.hostExecution !== "authorized")
  )
    throw new Error(
      "Plan contains a command without established host execution authority",
    );
  assertPreIntegrationCheckSources(candidate.graph, expectedSources);
  assertKnownCheckNames(candidate.graph, workflowCheckNames(checkout, baseSha));
  if (candidate.graph.split) {
    verifySplitGraph(candidate.graph, objective, body, baseSha, checkout);
    return;
  }
  verifyReviewedGraph(
    candidate.graph,
    objective,
    baseSha,
    expectedSources,
    body,
    candidate.finalCommands,
    checkout,
  );
}

/**
 * Verify already reviewed bytes, including historical aggregate acceptance.
 * New compilation and amendments enforce controller derivation before review.
 */
export function verifyReviewedGraph(
  graph: WorkGraph,
  objective: number,
  baseSha: string,
  sources: ReturnType<typeof planningSources>,
  body: string,
  finalCommands: string[],
  checkout: string,
): void {
  validateAndOrderGraph(
    graph,
    objective,
    baseSha,
    new Set(sources.map((source) => source.path)),
  );
  assertCoverageSources(
    graph,
    sources,
    coverageObligations(body, objectiveCriteria(body)),
    finalCommands,
    commandAuthority(body),
  );
  validateCitations(graph, sources, checkout);
  assertWorkerInputSources(graph, sources, checkout);
  validateCommandProvenance(graph, sources, checkout);
}

/** Bind a specific human fallback to the exact reviewed plan packet. */
export async function resolvePlan(
  candidate: PlanCandidate,
  objective: number,
  body: string,
  baseSha: string,
  checkout: string,
  input: {
    actor: string;
    outcome: "accept" | "refuse";
    answer: string;
    reason: string;
    question?: string;
  },
  configDigest: string,
): Promise<PlanCandidate> {
  verifyPlanCandidate(
    candidate,
    objective,
    body,
    baseSha,
    checkout,
    configDigest,
    true,
  );
  if (
    candidate.review.status !== "needs-human" ||
    (!candidate.review.findings.length && !candidate.review.failure)
  )
    throw new Error("This plan has no unresolved specific human question");
  if (
    !input.actor.trim() ||
    !input.reason.trim() ||
    (input.outcome === "accept" && !input.answer.trim())
  )
    throw new Error(
      "A human decision needs actor, reason, and a specific answer when accepted",
    );
  const question =
    candidate.review.failure?.question ??
    candidate.review.findings[0]!.question;
  assertAnsweredQuestion(question, input.question);
  const decision = {
    question,
    answer: input.answer,
    actor: input.actor,
    at: new Date().toISOString(),
    outcome: input.outcome,
    reason: input.reason,
    reviewDigest: candidate.reviewDigest,
  };
  return {
    ...candidate,
    humanDecision: decision,
    review: {
      ...candidate.review,
      status: input.outcome === "accept" ? "human-accepted" : "refused",
    },
  };
}
