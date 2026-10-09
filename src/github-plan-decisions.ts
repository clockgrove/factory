import type { FactoryConfig } from "./config.js";
import { factoryConfigDigest } from "./config.js";
import type { PlanCandidate } from "./compiler.js";
import { progressDigest } from "./github-progress-state.js";
import type { PreparationState } from "./state.js";
import { projectionStarted } from "./state.js";

export interface GitHubDecisionComment {
  id: number;
  nodeId: string;
  actorId: number;
  login: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  lastEditedAt: null;
  editor: null;
  includesCreatedEdit: false;
}

export interface PlanDecisionEnvelope {
  factoryDecision: 1;
  repository: string;
  objective: number;
  runId: string;
  configDigest: string;
  planReviewDigest: string;
  questionDigest: string;
  outcome: "accept";
  answer: string;
  reason: string;
}

export interface GitHubPlanDecisionReceipt extends GitHubDecisionComment {
  observedAt: string;
  bodyDigest: string;
  envelope: PlanDecisionEnvelope;
  planGraphDigest: string;
  questionPacket: {
    reviewDigest: string;
    finding: PlanCandidate["review"]["findings"][number];
  };
  decision: NonNullable<PlanCandidate["humanDecision"]>;
}

export function planQuestionDigest(plan: PlanCandidate): string {
  return progressDigest(
    JSON.stringify({
      reviewDigest: plan.reviewDigest,
      finding: plan.review.findings[0],
    }),
  );
}

export function phonePlanEligible(
  config: FactoryConfig,
  state: PreparationState,
): boolean {
  const plan = state.plan;
  return (
    !!config.githubManagement?.decisions &&
    config.githubManagement.progress?.includeQuestions === true &&
    state.configDigest === factoryConfigDigest(config) &&
    state.coordinator.mode === "running" &&
    Number.isFinite(Date.parse(state.coordinator.deadlineAt ?? "")) &&
    Date.parse(state.coordinator.deadlineAt!) > Date.now() &&
    !state.githubPlanDecision &&
    !state.error &&
    !state.wait &&
    !state.cancelRequested &&
    !state.cancelledAt &&
    !state.coordinator.cancelError &&
    !state.coordinator.processes?.length &&
    !projectionStarted(state) &&
    !!plan &&
    plan.review.status === "needs-human" &&
    plan.review.acceptable !== false &&
    !plan.review.failure &&
    plan.review.findings.length === 1 &&
    !!plan.review.findings[0]?.question.trim() &&
    !(
      state.githubProgress?.requests.at(-1) &&
      !state.githubProgress.requests.at(-1)?.comment
    ) &&
    !(
      state.githubProjectStatus?.requests.at(-1) &&
      !state.githubProjectStatus.requests.at(-1)?.response &&
      !state.githubProjectStatus.requests.at(-1)?.notSent
    ) &&
    !Object.values(state.repeats ?? {}).some(
      (repeat) =>
        repeat.inFlight ||
        (repeat.faults?.last.kind === "transient" &&
          repeat.faults.last.outcomeUnknown),
    )
  );
}

export function planDecisionTemplate(
  config: FactoryConfig,
  state: PreparationState,
): PlanDecisionEnvelope | undefined {
  if (!phonePlanEligible(config, state) || !state.plan) return;
  return {
    factoryDecision: 1,
    repository: state.repository,
    objective: state.objective,
    runId: state.runId,
    configDigest: state.configDigest,
    planReviewDigest: state.plan.reviewDigest,
    questionDigest: planQuestionDigest(state.plan),
    outcome: "accept",
    answer: "YOUR SPECIFIC ANSWER",
    reason: "WHY THIS SATISFIES THE OBJECTIVE",
  };
}

export function parsePlanDecision(
  body: string,
): PlanDecisionEnvelope | undefined {
  if (Buffer.byteLength(body) > 8_192) return;
  const trimmed = body.trim();
  const text =
    trimmed.startsWith("```json\n") && trimmed.endsWith("\n```")
      ? trimmed.slice(8, -4)
      : trimmed;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const row = value as Record<string, unknown>;
  const fields = [
    "factoryDecision",
    "repository",
    "objective",
    "runId",
    "configDigest",
    "planReviewDigest",
    "questionDigest",
    "outcome",
    "answer",
    "reason",
  ];
  if (
    Object.keys(row).length !== fields.length ||
    fields.some((key) => !Object.hasOwn(row, key)) ||
    row.factoryDecision !== 1 ||
    row.outcome !== "accept" ||
    !Number.isSafeInteger(row.objective) ||
    Number(row.objective) <= 0
  )
    return;
  if (
    [
      "repository",
      "runId",
      "configDigest",
      "planReviewDigest",
      "questionDigest",
      "answer",
      "reason",
    ].some(
      (key) => typeof row[key] !== "string" || !(row[key] as string).trim(),
    )
  )
    return;
  if (
    ["configDigest", "planReviewDigest", "questionDigest"].some(
      (key) => !/^[a-f0-9]{64}$/.test(row[key] as string),
    ) ||
    ["answer", "reason"].some(
      (key) => Buffer.byteLength(row[key] as string) > 2_000,
    ) ||
    row.answer === "YOUR SPECIFIC ANSWER" ||
    row.reason === "WHY THIS SATISFIES THE OBJECTIVE"
  )
    return;
  return row as unknown as PlanDecisionEnvelope;
}

export function matchesPlanDecision(
  config: FactoryConfig,
  state: PreparationState,
  comment: GitHubDecisionComment,
): PlanDecisionEnvelope | undefined {
  if (
    !phonePlanEligible(config, state) ||
    !state.plan ||
    !config.githubManagement?.decisions?.actorIds.includes(comment.actorId)
  )
    return;
  const input = parsePlanDecision(comment.body);
  if (
    !input ||
    input.repository !== state.repository ||
    input.objective !== state.objective ||
    input.runId !== state.runId ||
    input.configDigest !== state.configDigest ||
    input.planReviewDigest !== state.plan.reviewDigest ||
    input.questionDigest !== planQuestionDigest(state.plan)
  )
    return;
  return input;
}

export function assertGitHubPlanDecision(
  value: unknown,
  context: {
    repository: string;
    objective: number;
    runId: string;
    configDigest: string;
    plan?: PlanCandidate;
    planGraphDigest?: string;
  },
): void {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid GitHub plan decision receipt");
  const receipt = value as GitHubPlanDecisionReceipt;
  const fields = [
    "id",
    "nodeId",
    "actorId",
    "login",
    "body",
    "createdAt",
    "updatedAt",
    "lastEditedAt",
    "editor",
    "includesCreatedEdit",
    "observedAt",
    "bodyDigest",
    "envelope",
    "planGraphDigest",
    "questionPacket",
    "decision",
  ];
  if (
    Object.keys(receipt).length !== fields.length ||
    fields.some((key) => !Object.hasOwn(receipt, key))
  )
    throw new Error("Invalid GitHub plan decision receipt fields");
  const envelope = parsePlanDecision(receipt.body);
  if (
    !envelope ||
    JSON.stringify(envelope) !== JSON.stringify(receipt.envelope) ||
    envelope.repository !== context.repository ||
    envelope.objective !== context.objective ||
    envelope.runId !== context.runId ||
    envelope.configDigest !== context.configDigest ||
    !Number.isSafeInteger(receipt.id) ||
    receipt.id <= 0 ||
    !Number.isSafeInteger(receipt.actorId) ||
    receipt.actorId <= 0 ||
    typeof receipt.nodeId !== "string" ||
    !receipt.nodeId ||
    typeof receipt.login !== "string" ||
    !receipt.login ||
    receipt.login.endsWith("[bot]") ||
    [receipt.createdAt, receipt.updatedAt, receipt.observedAt].some(
      (at) => typeof at !== "string" || !Number.isFinite(Date.parse(at)),
    ) ||
    receipt.lastEditedAt !== null ||
    receipt.editor !== null ||
    receipt.includesCreatedEdit !== false ||
    receipt.createdAt !== receipt.updatedAt ||
    receipt.bodyDigest !== progressDigest(receipt.body)
  )
    throw new Error(
      "GitHub plan decision receipt lacks exact authenticated binding",
    );
  const packet = receipt.questionPacket;
  const decision = receipt.decision;
  if (
    !packet ||
    !packet.finding ||
    Object.keys(packet).length !== 2 ||
    packet.reviewDigest !== envelope.planReviewDigest ||
    progressDigest(JSON.stringify(packet)) !== envelope.questionDigest ||
    !/^[a-f0-9]{64}$/.test(receipt.planGraphDigest) ||
    !decision ||
    Object.keys(decision).length !== 7 ||
    decision.question !== packet.finding.question ||
    decision.reviewDigest !== envelope.planReviewDigest ||
    decision.answer !== envelope.answer ||
    decision.reason !== envelope.reason ||
    decision.outcome !== "accept" ||
    decision.actor !== `github:user:${receipt.actorId} (${receipt.login})` ||
    decision.at !== receipt.observedAt
  )
    throw new Error(
      "GitHub plan decision lacks retained plan/question provenance",
    );
  if (
    context.plan &&
    (context.plan.review.status !== "human-accepted" ||
      context.plan.review.acceptable === false ||
      context.plan.review.failure ||
      context.plan.review.findings.length !== 1 ||
      context.plan.reviewDigest !== envelope.planReviewDigest ||
      context.plan.graphDigest !== receipt.planGraphDigest ||
      planQuestionDigest(context.plan) !== envelope.questionDigest ||
      JSON.stringify(context.plan.humanDecision) !== JSON.stringify(decision))
  )
    throw new Error(
      "GitHub plan decision differs from the accepted retained plan",
    );
  if (!context.plan && context.planGraphDigest !== receipt.planGraphDigest)
    throw new Error(
      "GitHub plan decision differs from the activated plan graph",
    );
}
