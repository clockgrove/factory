import type {
  ApprovedPlaybookPin,
  PlanningPrerequisites,
  PlanningLocalExecutables,
  PlanningExecutionBounds,
  ExecutionProfileChoices,
  WorkGraph,
  PlanCommandAuthorization,
  PlanReviewRequest,
} from "../contracts.js";
import {
  type PlanningSource,
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
  planReviewDigest,
  digest,
  reviewResultDigest,
  planReviewPacket,
} from "./packets.js";
import { assertPreIntegrationCheckSources } from "../delivery/readiness.js";
import { assertKnownCheckNames, workflowCheckNames } from "../check-names.js";
import { validateAndOrderGraph } from "../scheduler.js";
import { assertCoverageSources, coverageObligations } from "../qa.js";

export interface PlanCandidate {
  approvedPlaybookPin?: ApprovedPlaybookPin;
  schemaVersion: 3;
  prerequisites?: PlanningPrerequisites;
  localExecutables?: PlanningLocalExecutables;
  executionBounds?: PlanningExecutionBounds;
  executionProfiles?: ExecutionProfileChoices;
  objective: number;
  baseSha: string;
  bodyDigest: string;
  sources: PlanningSource[];
  sourceDigests: { path: string; heading?: string; digest: string }[];
  controllerCapabilities: ControllerCapabilitiesManifest;
  controllerCapabilitiesDigest: string;
  graph: WorkGraph;
  graphDigest: string;
  commands: PlanCommandAuthorization[];
  finalCommands: string[];
  /** Digest of the complete immutable packet supplied to independent review. */
  packetDigest: string;
  /** Digest of the packet digest and immutable independent-review result. */
  reviewDigest: string;
  /** Factory installation configuration bound at preview time. */
  configDigest: string;
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
  packet: PlanReviewRequest,
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
    schemaVersion: 3,
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
    sources,
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
  configDigest = digest("unbound-test-configuration"),
  allowPending = false,
  configuredConcurrency?: number,
): void {
  assertObjectiveCriteria(body);
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
    candidate.schemaVersion !== 3 ||
    candidate.objective !== objective ||
    candidate.baseSha !== baseSha ||
    candidate.bodyDigest !== digest(body) ||
    candidate.configDigest !== configDigest ||
    JSON.stringify(candidate.controllerCapabilities) !==
      JSON.stringify(expectedPacket.controllerCapabilities) ||
    candidate.controllerCapabilitiesDigest !==
      expectedPacket.controllerCapabilitiesDigest ||
    JSON.stringify(candidate.sources) !== JSON.stringify(expectedSources) ||
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
  assertPreIntegrationCheckSources(candidate.graph, candidate.sources);
  assertKnownCheckNames(candidate.graph, workflowCheckNames(checkout, baseSha));
  // Verify already reviewed bytes, including historical aggregate acceptance.
  // New compilation and amendments enforce controller derivation before review.
  validateAndOrderGraph(
    candidate.graph,
    objective,
    baseSha,
    new Set(candidate.sourceDigests.map((source) => source.path)),
  );
  assertCoverageSources(
    candidate.graph,
    candidate.sources,
    coverageObligations(body, objectiveCriteria(body)),
    candidate.finalCommands,
    commandAuthority(body),
  );
  validateCitations(candidate.graph, candidate.sources);
  assertWorkerInputSources(candidate.graph, candidate.sources);
  validateCommandProvenance(candidate.graph, candidate.sources, checkout);
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
  },
  configDigest = digest("unbound-test-configuration"),
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
  const decision = {
    question:
      candidate.review.failure?.question ??
      candidate.review.findings[0]!.question,
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
