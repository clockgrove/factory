import {
  completeAcceptedDecision,
  type PlanCandidate,
} from "./compiler/candidate.js";
import { reviewResultDigest } from "./compiler/packets.js";
import type { GitHubPlanDecisionReceipt } from "./github-plan-decisions.js";
import type { FactoryState } from "./state.js";
import { isDeepStrictEqual } from "node:util";

/** The verified original plan clarification, not an implementation acceptance. */
export interface AcceptedPlanningDecision {
  graphDigest: string;
  packetDigest: string;
  reviewDigest: string;
  review: Pick<PlanCandidate["review"], "revisions" | "findings" | "failure">;
  decision: NonNullable<PlanCandidate["humanDecision"]>;
}

/** Called only after the ordinary complete plan/source admission verification. */
export function retainAcceptedPlanningDecision(
  plan: PlanCandidate,
): AcceptedPlanningDecision | undefined {
  if (plan.review.status !== "human-accepted") return;
  if (plan.review.acceptable === false || !plan.humanDecision)
    throw new Error(
      "Accepted planning decision lacks an acceptable retained plan",
    );
  const context: AcceptedPlanningDecision = structuredClone({
    graphDigest: plan.graphDigest,
    packetDigest: plan.packetDigest,
    reviewDigest: plan.reviewDigest,
    review: {
      revisions: plan.review.revisions,
      findings: plan.review.findings,
      ...(plan.review.failure ? { failure: plan.review.failure } : {}),
    },
    decision: plan.humanDecision,
  });
  assertAcceptedPlanningDecision(context, plan.graphDigest);
  return context;
}

export function assertAcceptedPlanningDecision(
  value: unknown,
  graphDigest: string,
  githubDecision?: GitHubPlanDecisionReceipt,
): asserts value is AcceptedPlanningDecision | undefined {
  const invalid = (): never => {
    throw new Error(
      "Accepted planning decision differs from its original plan/review",
    );
  };
  if (value === undefined) {
    if (githubDecision) invalid();
    return;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const context = value as AcceptedPlanningDecision;
  if (
    Object.keys(context).length !== 5 ||
    ![context.graphDigest, context.packetDigest, context.reviewDigest].every(
      (digest) => typeof digest === "string" && /^[a-f0-9]{64}$/.test(digest),
    ) ||
    context.graphDigest !== graphDigest ||
    !context.review ||
    typeof context.review !== "object" ||
    Array.isArray(context.review) ||
    Object.keys(context.review).some(
      (key) => !["revisions", "findings", "failure"].includes(key),
    ) ||
    !Number.isSafeInteger(context.review.revisions) ||
    context.review.revisions < 0 ||
    !Array.isArray(context.review.findings) ||
    context.review.findings.some(
      (finding) =>
        !finding ||
        typeof finding !== "object" ||
        Array.isArray(finding) ||
        typeof finding.question !== "string" ||
        typeof finding.detail !== "string",
    ) ||
    (context.review.failure !== undefined &&
      (!context.review.failure ||
        typeof context.review.failure !== "object" ||
        Array.isArray(context.review.failure) ||
        Object.keys(context.review.failure).length !== 2 ||
        typeof context.review.failure.question !== "string" ||
        typeof context.review.failure.detail !== "string")) ||
    !context.decision ||
    typeof context.decision !== "object" ||
    Array.isArray(context.decision) ||
    Object.keys(context.decision).length !== 7 ||
    !completeAcceptedDecision(context.decision) ||
    !Number.isFinite(Date.parse(context.decision.at))
  )
    invalid();
  const question =
    context.review.failure?.question ?? context.review.findings[0]?.question;
  if (
    typeof question !== "string" ||
    !question.trim() ||
    context.decision.question !== question ||
    context.decision.reviewDigest !== context.reviewDigest ||
    reviewResultDigest(context.packetDigest, context.review) !==
      context.reviewDigest
  )
    invalid();
  if (
    githubDecision &&
    (githubDecision.planGraphDigest !== context.graphDigest ||
      githubDecision.questionPacket.reviewDigest !== context.reviewDigest ||
      context.review.failure !== undefined ||
      context.review.findings.length !== 1 ||
      !isDeepStrictEqual(
        githubDecision.questionPacket.finding,
        context.review.findings[0],
      ) ||
      !isDeepStrictEqual(githubDecision.decision, context.decision))
  )
    invalid();
}

/** Supply the actual choice with its original identity; never reconstruct an old answer. */
export function acceptedPlanningDecisionContext(state: FactoryState): object {
  const context = state.acceptedPlanningDecision;
  assertAcceptedPlanningDecision(
    context,
    state.planGraphDigest,
    state.githubPlanDecision,
  );
  if (!context)
    return {
      availability: "unavailable",
      scope:
        "No retained human planning answer is supplied; absence does not prove none was required. Do not infer or invent a required answer.",
    };
  return {
    availability: "available",
    binding: {
      repository: state.repository,
      objective: state.objective,
      runId: state.runId,
      configDigest: state.configDigest,
      objectiveBaseCommitSha: state.baseSha,
      objectiveBodyDigest: state.objectiveBodyDigest,
      originalPlanGraphDigest: context.graphDigest,
      originalReviewPacketDigest: context.packetDigest,
      originalPlanReviewDigest: context.reviewDigest,
    },
    decision: structuredClone(context.decision),
    scope:
      "This retained human answer was verified against the original planning question before graph activation. It proves the recorded planning reply and its original binding, not that the app implements the choice. Resolve only this question within the original Objective and graph; the reply grants no commands, ownership, permissions or implementation acceptance and proves no validation or delivery. Independently assess the exact app result against all original requirements and this actual choice.",
  };
}
