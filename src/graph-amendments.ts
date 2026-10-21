import { settleAbandonedPlanningTurn } from "./agent-session.js";
import { Readable } from "node:stream";
import { awaitCheckpointAdmission } from "./recovery-checkpoint.js";
import {
  readPinnedWorkflowRecipe,
  type WorkflowRecipeInput,
} from "./workflow-recipes.js";
import { assertDeclaredConditions } from "./adaptive-routing.js";
import { assertGraphExpansions } from "./graph-expansion.js";
import { workSettled } from "./scheduler.js";
import {
  adaptiveContextEvidence,
  authenticateAdaptiveContextPacket,
  buildAdaptiveContext,
  type AdaptiveContextRole,
} from "./adaptive-context.js";
import {
  amendmentAllowed,
  amendmentsUsedUp,
  archiveAttempt,
  charge,
  chargeRepair,
  consumption,
  failureDigest,
  objectiveEvent,
  type RepairCorrection,
  releaseCharge,
} from "./repair-policy.js";

import { createHash, randomUUID } from "node:crypto";
import { graphProjectionControl } from "./graph-projection-control.js";
import { prerequisitesDigest } from "./native-prerequisite-evidence.js";
import { isDeepStrictEqual } from "node:util";
import {
  intakeRefusal,
  NOT_REPLACEABLE,
  planningRefusal,
  rejectionRefusal,
} from "./amendment-admission.js";
import { refreshBlameDecisions } from "./blame-decision.js";
import {
  generatePlannerStructured,
  withPlannerAdmission,
} from "./compiler/planning.js";
import {
  assertAnsweredQuestion,
  commandAuthority,
  compileObjective,
  finalObjectiveCommands,
  hydrateWorkerInputSources,
  objectiveCriteria,
  operatorPlanningDecisions,
  paidModel,
  planningReviewEvidence,
  planningSources,
  planReviewPacket,
  questionDigest,
  validateCommandProvenance,
  validateGraph,
  validateGraphSources,
} from "./compiler.js";
import {
  ciOnlyCommands,
  requiredFinalCommands,
  type FactoryConfig,
} from "./config.js";
import type {
  GitHubGateway,
  PlanningModel,
  WorkDiscovery,
  WorkGraph,
  ContentStore,
  ContentRef,
  ModelInvocationContext,
  WorkItem,
} from "./contracts.js";
import { linearDeliveryUnits } from "./delivery/plan.js";
import type { DiagnosticEmitter } from "./diagnostics.js";
import {
  executionProfileChoices,
  normalizeExecutionProfiles,
  verifyExecutionProfiles,
} from "./execution-profiles.js";
import {
  attachedFault,
  attachFault,
  cancelledFault,
  decision,
  plannerDecisionOf,
  StepFault,
  transient,
} from "./fault.js";
import { preflightObjective } from "./local-preflight.js";
import { planningPrerequisites } from "./objective-prerequisites.js";
import {
  assertCoverageShape,
  assertCoverageSources,
  coverageObligations,
  sourceObligationId,
} from "./qa.js";
import { amendmentImplementationEvidence } from "./result-evidence.js";
import {
  assertReviewPacketBinding,
  decodeGraphReview,
  reviewPacket,
  reviewPacketRecord,
} from "./review-evidence.js";
import type { FactoryState, WorkState } from "./state.js";
import { refuseUnknownFields } from "./unknown-fields.js";
import { clearRepeats, type StepOptions, step } from "./step.js";

export interface AmendmentProposal extends WorkDiscovery {
  expectedGraphDigest: string;
  actor: string;
  /** Operator supplied candidate; worker discoveries are compiled by the controller. */
  graph?: WorkGraph;
  worker?: { itemId: string; attempt: string };
  /** Explicit disposition of a known generated amendment rejection, never an effect replay. */
  replacement?: { amendmentId: string; correction: RepairCorrection };
}
export interface PendingAmendment {
  id: string;
  proposal: AmendmentProposal;
  /** Last completed phase; a restart repeats the next call. */
  phase: "ready" | "compiled" | "reviewed" | "projected" | "rejected";
  graph?: WorkGraph;
  planningInvocation?: {
    id: string;
    requestDigest?: string;
    adaptiveContextId?: string;
    response?: WorkGraph;
    nativeReturns?: ContentRef[];
  };
  reviewInvocation?: {
    id: string;
    requestDigest: string;
    adaptiveContextId?: string;
    /** Row digests only; the content is re-derived from the review's inputs. */
    packet: import("./review-evidence.js").ReviewPacketRecord;
    response?: Awaited<ReturnType<PlanningModel["reviewGraph"]>>;
    nativeReturns?: ContentRef[];
  };
  reviewRejectedNativeReturns?: ContentRef[];
  reviewRejectedResponses?: Awaited<ReturnType<PlanningModel["reviewGraph"]>>[];
  reviewDigest?: string;
  issueByItemId: Record<string, number>;
  /**
   * Questions the planner asked about this amendment (#1296), oldest first.
   * The last one, while unanswered, holds the amendment at its phase; answers
   * reach the next compilation as operator findings.
   */
  decisions?: {
    question: string;
    answer?: { actor: string; answer: string; reason: string };
    /** The completed compilation that asked, retained as its original. */
    invocation?: PendingAmendment["planningInvocation"];
  }[];
  error?: string;
  /** `decision`: the operator refused it at the planner's question (#1296). */
  rejectionStage?:
    | "decision"
    | "compilation"
    | "validation"
    | "review"
    | "review-findings"
    | "projection";
}
export interface GraphRevision {
  graph: WorkGraph;
  digest: string;
  parentDigest?: string;
  proposal?: AmendmentProposal;
  /** Deterministic derivation from the independently reviewed original envelope. */
  expansion?: import("./runner/expansion.js").GraphExpansionSettlement;
  reviewDigest?: string;
  planningInvocation?: PendingAmendment["planningInvocation"];
  reviewInvocation?: PendingAmendment["reviewInvocation"];
  reviewRejectedNativeReturns?: ContentRef[];
  /** The operator retired one validation command of a Work Item (#1667). */
  retirement?: ValidationRetirement;
  acceptedAt?: string;
}

/**
 * An operator correction: one Work Item validation command no longer runs,
 * for a recorded reason such as "covered by CI". Acceptance is unchanged; a
 * criterion that command proved is judged by the item's review instead.
 */
export interface ValidationRetirement {
  itemId: string;
  command: string;
  reason: string;
  actor: string;
}

/**
 * The graph without the retired command. Coverage proofs keep pointing at the
 * same commands; one the retired command gave becomes its review's judgment.
 * Refuses an unknown item or command, and a readiness probe or preparation.
 */
export function retiredValidationGraph(
  graph: WorkGraph,
  retirement: ValidationRetirement,
): WorkGraph {
  const { itemId, command, reason, actor } = retirement;
  if (![reason, actor].every((text) => typeof text === "string" && text.trim()))
    throw new Error("Retiring a validation command needs a reason and actor");
  // Controller, review and worker actors are all factory-*; only a person retires.
  if (actor.startsWith("factory-"))
    throw new Error("Only the operator can retire a validation command");
  const next = structuredClone(graph);
  const item = next.items.find((entry) => entry.id === itemId);
  if (!item) throw new Error(`Unknown Work Item ${itemId}`);
  const index = item.validation.findIndex((entry) => entry.command === command);
  if (index < 0)
    throw new Error(
      `Work Item ${itemId} has no validation command ${JSON.stringify(command)}; its commands are ${JSON.stringify(item.validation.map((entry) => entry.command))}`,
    );
  if (item.validation.length === 1)
    throw new Error(
      `${command} is Work Item ${itemId}'s last validation command; an item keeps at least one, so cancel or amend it instead`,
    );
  item.validation.splice(index, 1);
  for (const entry of next.coverage ?? []) {
    if (entry.itemId !== itemId) continue;
    if (
      entry.environment.probe === command ||
      entry.environment.prerequisites?.includes(command)
    )
      throw new Error(
        `${command} is Work Item ${itemId}'s readiness probe or preparation; it cannot be retired`,
      );
    const proof = entry.proof;
    if (proof.kind !== "result-command" && proof.kind !== "integrated-command")
      continue;
    if (proof.validationIndex > index) proof.validationIndex--;
    else if (proof.validationIndex === index)
      entry.proof = {
        kind:
          proof.kind === "result-command"
            ? "result-semantic"
            : "integrated-semantic",
      };
  }
  return next;
}

/** Record an operator retirement as a graph revision; the caller restarts the item. */
export function retireValidationCommand(
  state: FactoryState,
  retirement: ValidationRetirement,
): void {
  if (state.pendingAmendment || state.pendingExpansion)
    throw new Error(
      "Settle the pending graph amendment or expansion before retiring a validation command",
    );
  const graph = retiredValidationGraph(state.graph, retirement);
  assertCoverageShape(graph);
  state.graphRevisions ??= [
    { graph: structuredClone(state.graph), digest: graphDigest(state.graph) },
  ];
  state.graphRevisions.push({
    graph,
    digest: graphDigest(graph),
    parentDigest: graphDigest(state.graph),
    retirement: structuredClone(retirement),
    acceptedAt: new Date().toISOString(),
  });
  state.graph = graph;
}

/** Every retired validation command, in order, for status and receipts. */
export function retiredValidation(
  state: Pick<FactoryState, "graphRevisions">,
): (ValidationRetirement & { at: string })[] {
  return (state.graphRevisions ?? []).flatMap((revision) =>
    revision.retirement
      ? [{ ...revision.retirement, at: revision.acceptedAt! }]
      : [],
  );
}
export type AllowanceConsumption = {
  planningRevisions: number;
  implementationRepairs: number;
  resultRereviews: number;
};
export const graphDigest = (graph: WorkGraph): string =>
  createHash("sha256").update(JSON.stringify(graph)).digest("hex");

/** Compare supported defaults without changing immutable admitted graph bytes. */
function sameItem(
  left: WorkItem | undefined,
  right: WorkItem | undefined,
): boolean {
  const normalized = (item: WorkItem | undefined) =>
    item && {
      ...item,
      kind: item.kind ?? "work",
      children: item.children ?? [],
      priority: item.priority ?? 0,
    };
  return isDeepStrictEqual(normalized(left), normalized(right));
}

export function assertDiscovery(value: WorkDiscovery): void {
  if (
    !value ||
    !["in-scope", "backlog"].includes(value.scope) ||
    typeof value.reason !== "string" ||
    !value.reason.trim()
  )
    throw new Error("Discovery requires explicit scope and reason");
  for (const field of [
    "evidence",
    "ownership",
    "acceptance",
    "dependencies",
  ] as const)
    if (
      !Array.isArray(value[field]) ||
      !value[field].every((text) => typeof text === "string" && text.trim()) ||
      (field !== "dependencies" && !value[field].length)
    )
      throw new Error(`Discovery lacks ${field}`);
}

/** Validate the immutable succession, never rewrite the initial graph digest. */
/** A retirement revision is exactly its parent without the retired command. */
function retirementDerives(
  parent: WorkGraph,
  revision: GraphRevision,
): boolean {
  try {
    return (
      graphDigest(retiredValidationGraph(parent, revision.retirement!)) ===
      revision.digest
    );
  } catch {
    return false;
  }
}

export function assertGraphRevisions(state: FactoryState): void {
  for (const rejected of state.rejectedAmendments ?? []) {
    assertDiscovery(rejected.proposal);
    if (
      !rejected.id ||
      rejected.phase !== "rejected" ||
      !rejected.error ||
      ![
        state.planGraphDigest,
        ...(state.graphRevisions ?? []).map((revision) => revision.digest),
      ].includes(rejected.proposal.expectedGraphDigest)
    )
      throw new Error("Invalid retained amendment rejection");
  }
  for (const proposal of state.backlogDiscoveries ?? []) {
    assertDiscovery(proposal);
    if (proposal.scope !== "backlog")
      throw new Error("Backlog discovery cannot authorize execution");
  }
  for (const amendment of [
    ...(state.pendingAmendment ? [state.pendingAmendment] : []),
    ...(state.rejectedAmendments ?? []),
  ]) {
    for (const [invocation, role] of [
      [amendment.planningInvocation, "compile"],
      [amendment.reviewInvocation, "graph-review"],
    ] as const) {
      if (invocation?.adaptiveContextId === undefined) continue;
      const packet = state.adaptiveContexts?.[invocation.adaptiveContextId];
      if (
        !packet ||
        packet.role !== role ||
        packet.binding.graphDigest !== amendment.proposal.expectedGraphDigest ||
        packet.binding.baseSha !== state.baseSha ||
        packet.binding.itemId !== undefined
      )
        throw new Error("Amendment invocation lost its retained role context");
    }
  }
  for (const original of [
    ...(state.pendingAmendment ? [state.pendingAmendment] : []),
    ...(state.rejectedAmendments ?? []),
    ...(state.graphRevisions ?? []),
  ]) {
    for (const ref of [
      ...(original.planningInvocation?.nativeReturns ?? []),
      ...(original.reviewInvocation?.nativeReturns ?? []),
      ...(original.reviewRejectedNativeReturns ?? []),
      ...amendmentDecisionReturns(original),
    ]) {
      if (
        ![17, 19].includes(state.schemaVersion) ||
        !ref ||
        Object.keys(ref).sort().join() !== "bytes,digest,mediaType" ||
        !/^[a-f0-9]{64}$/.test(ref.digest) ||
        !Number.isSafeInteger(ref.bytes) ||
        ref.bytes < 0 ||
        ref.mediaType !== "application/json"
      )
        throw new Error("Invalid native amendment original reference");
    }
  }
  const revisions = state.graphRevisions;
  if (revisions) {
    if (!revisions.length || revisions[0]!.digest !== state.planGraphDigest)
      throw new Error("Graph revisions do not descend from the accepted plan");
    for (const [index, revision] of revisions.entries()) {
      if (
        revision.digest !== graphDigest(revision.graph) ||
        revision.graph.objective !== state.objective ||
        revision.graph.baseSha !== state.baseSha
      )
        throw new Error("Graph revision identity changed");
      if (
        index &&
        (revision.parentDigest !== revisions[index - 1]!.digest ||
          (revision.retirement
            ? revision.proposal !== undefined ||
              revision.expansion !== undefined ||
              revision.reviewDigest !== undefined ||
              !retirementDerives(revisions[index - 1]!.graph, revision)
            : revision.expansion
              ? revision.proposal !== undefined ||
                revision.reviewDigest !== undefined ||
                revision.expansion.parentGraphDigest !==
                  revision.parentDigest ||
                revision.expansion.graphDigest !== revision.digest ||
                revision.expansion.acceptedAt !== revision.acceptedAt
              : !revision.proposal ||
                revision.proposal.expectedGraphDigest !==
                  revision.parentDigest ||
                !/^[a-f0-9]{64}$/.test(revision.reviewDigest ?? "")) ||
          !Number.isFinite(Date.parse(revision.acceptedAt ?? "")))
      )
        throw new Error(
          "Graph revision lacks reviewed compare-and-set succession",
        );
    }
    if (revisions.at(-1)!.digest !== graphDigest(state.graph))
      throw new Error("Current graph differs from accepted revision");
  } else if (graphDigest(state.graph) !== state.planGraphDigest)
    throw new Error("Current graph differs from the accepted plan");
  for (const [id, work] of Object.entries(state.work)) {
    if (!work.graphRevisionDigest) continue;
    const revision =
      revisions?.find((entry) => entry.digest === work.graphRevisionDigest)
        ?.graph ??
      (graphDigest(state.graph) === work.graphRevisionDigest
        ? state.graph
        : undefined);
    if (
      !revision ||
      !sameItem(
        revision.items.find((item) => item.id === id),
        state.graph.items.find((item) => item.id === id),
      )
    )
      throw new Error("Attempt graph revision binding changed");
  }
  const pending = state.pendingAmendment;
  if (pending) {
    assertDiscovery(pending.proposal);
    if (
      !pending.id ||
      !["ready", "compiled", "reviewed", "projected", "rejected"].includes(
        pending.phase,
      ) ||
      pending.proposal.expectedGraphDigest !== graphDigest(state.graph)
    )
      throw new Error("Pending amendment has stale graph identity");
    if (
      (pending.planningInvocation &&
        (typeof pending.planningInvocation.id !== "string" ||
          !pending.planningInvocation.id)) ||
      (pending.reviewInvocation &&
        (typeof pending.reviewInvocation.id !== "string" ||
          !pending.reviewInvocation.id ||
          !/^[a-f0-9]{64}$/.test(pending.reviewInvocation.requestDigest)))
    )
      throw new Error("Pending amendment has an invalid retained invocation");
    const known = pending.issueByItemId;
    if (
      !known ||
      typeof known !== "object" ||
      Array.isArray(known) ||
      Object.values(known).some((id) => !Number.isSafeInteger(id) || id <= 0) ||
      new Set(Object.values(known)).size !== Object.values(known).length ||
      (pending.graph &&
        Object.keys(known).some(
          (id) => !pending.graph!.items.some((item) => item.id === id),
        )) ||
      (pending.reviewDigest !== undefined &&
        !/^[a-f0-9]{64}$/.test(pending.reviewDigest)) ||
      (pending.rejectionStage !== undefined &&
        ![
          "decision",
          "compilation",
          "validation",
          "review",
          "review-findings",
          "projection",
        ].includes(pending.rejectionStage))
    )
      throw new Error(
        "Pending amendment has invalid projection or review identities",
      );
    if (
      ["compiled", "reviewed", "projected"].includes(pending.phase) &&
      !pending.graph
    )
      throw new Error("Pending amendment lacks candidate graph");
    const decisions = pending.decisions;
    if (
      decisions !== undefined &&
      (!Array.isArray(decisions) ||
        !decisions.length ||
        decisions.some(
          (entry, index) =>
            !entry ||
            typeof entry.question !== "string" ||
            !entry.question.trim() ||
            (entry.answer === undefined
              ? index !== decisions.length - 1
              : ![
                  entry.answer.actor,
                  entry.answer.answer,
                  entry.answer.reason,
                ].every((text) => typeof text === "string" && text.trim())),
        ))
    )
      throw new Error("Pending amendment has invalid operator decisions");
  }
  for (const proposal of [
    ...(state.graphRevisions ?? []).flatMap((revision) =>
      revision.proposal ? [revision.proposal] : [],
    ),
    ...(pending ? [pending.proposal] : []),
    ...(state.rejectedAmendments ?? []).map((entry) => entry.proposal),
  ]) {
    if (!proposal.replacement) continue;
    const rejected = state.rejectedAmendments?.find(
      (entry) => entry.id === proposal.replacement!.amendmentId,
    );
    const correction = proposal.replacement.correction;
    if (
      !rejected ||
      correction.failureDigest !== failureDigest(rejected.error!) ||
      !["planning-output", "planning-evidence", "planning-choice"].includes(
        correction.kind,
      ) ||
      ![correction.actor, correction.diagnosis, correction.correction].every(
        (text) => typeof text === "string" && text.trim(),
      ) ||
      correction.actor !== proposal.actor ||
      proposal.expectedGraphDigest !== rejected.proposal.expectedGraphDigest
    )
      throw new Error(
        "Amendment replacement lost its diagnosed rejection binding",
      );
  }
  // Each started amendment was charged once, by its own id. One the operator
  // refused at its question gave its charge back (#1296).
  const started = [
    ...(state.rejectedAmendments ?? []),
    ...(pending && pending.phase !== "ready" ? [pending] : []),
  ].filter((entry) => entry.rejectionStage !== "decision");
  const charged = Object.keys(state.charges ?? {}).filter((event) =>
    event.startsWith(objectiveEvent("amend", "")),
  ).length;
  if (
    started.some((entry) => !state.charges?.[amendmentEvent(entry)]) ||
    (revisions ?? []).filter((revision) => !!revision.proposal).length +
      started.length >
      charged
  )
    throw new Error(
      "Known amendment attempts exceed retained planning charges",
    );
}

/** The failure event an amendment is charged under: one plan revision per amendment. */
const amendmentEvent = (pending: PendingAmendment): string =>
  objectiveEvent("amend", pending.id);

/** New pending graph semantics are capability-versioned before review or projection. */
function admitAdvancedAmendmentFormat(
  state: FactoryState,
  graph: WorkGraph,
): void {
  if (!graph.conditions?.length && !graph.expansions?.length) return;
  if (!state.planningRecovery?.contextLookup || state.schemaVersion === 7)
    throw new Error(
      "Adaptive graph changes require the original admitted planning context",
    );
  assertDeclaredConditions(graph);
  assertGraphExpansions(graph);
  if (
    (graph.conditions?.length || state.schemaVersion === 9) &&
    state.schemaVersion !== 15 &&
    ![17, 19].includes(state.schemaVersion)
  )
    state.schemaVersion = 13;
}

export function submitAmendment(
  state: FactoryState,
  proposal: AmendmentProposal,
): PendingAmendment | (Omit<PendingAmendment, "phase"> & { phase: "backlog" }) {
  if (state.pendingExpansion)
    throw new Error(
      "A deterministic expansion already owns the next graph transition; preserve its exact projection before proposing an amendment",
    );
  const intake = intakeRefusal(state);
  if (intake) throw new Error(intake.message);
  assertDiscovery(proposal);
  if (
    !proposal.actor?.trim() ||
    proposal.expectedGraphDigest !== graphDigest(state.graph)
  )
    throw new Error(
      "Amendment actor or compare-and-set graph identity is invalid",
    );
  if (proposal.scope === "backlog") {
    if (proposal.replacement)
      throw new Error("A rejected amendment replacement must remain in scope");
    state.backlogDiscoveries ??= [];
    state.backlogDiscoveries.push(structuredClone(proposal));
    return {
      id: randomUUID(),
      proposal: structuredClone(proposal),
      phase: "backlog",
      issueByItemId: {},
    };
  }
  const rejected = proposal.replacement
    ? validateAmendmentReplacement(state, proposal)
    : undefined;
  if (state.pendingAmendment && !rejected)
    throw new Error("An amendment already awaits disposition");
  // Refuse up front: the run charges a planning revision when it starts the
  // amendment, and a pending one that cannot be charged fails every run.
  if (!rejected && !amendmentAllowed(state))
    throw new Error(amendmentsUsedUp(state.objective));
  if (proposal.worker) {
    const work = state.work[proposal.worker.itemId];
    if (!work || work.attempt !== proposal.worker.attempt)
      throw new Error("Discovery has stale worker attempt identity");
  }
  if (proposal.graph) admitAdvancedAmendmentFormat(state, proposal.graph);
  if (rejected) {
    state.rejectedAmendments ??= [];
    state.rejectedAmendments.push(structuredClone(rejected));
    // Only this exact known rejection may be cleared; all other state is retained.
    if (state.error === rejected.error) {
      delete state.error;
      delete state.errorItem;
    }
  }
  state.pendingAmendment = {
    id: randomUUID(),
    proposal: structuredClone(proposal),
    phase: "ready",
    issueByItemId: { ...state.issueByItemId },
  };
  refreshBlameDecisions(state, graphDigest(state.graph));
  // Discovery invalidates finalization even when a review is already in flight.
  delete state.finalValidation;
  delete state.finalAcceptancePending;
  delete state.finalAcceptanceDecisions;
  return state.pendingAmendment;
}

function validateAmendmentReplacement(
  state: FactoryState,
  proposal: AmendmentProposal,
): PendingAmendment {
  const replacement = proposal.replacement!;
  const correction = replacement.correction;
  const unreplaceable = proposal.graph
    ? NOT_REPLACEABLE
    : rejectionRefusal(state, replacement.amendmentId);
  if (unreplaceable) throw new Error(unreplaceable.message);
  const rejected = state.pendingAmendment!;
  const error = rejected.error!;
  const discovery = (value: AmendmentProposal) => ({
    scope: value.scope,
    reason: value.reason,
    evidence: value.evidence,
    ownership: value.ownership,
    acceptance: value.acceptance,
    dependencies: value.dependencies,
    worker: value.worker,
  });
  if (!isDeepStrictEqual(discovery(proposal), discovery(rejected.proposal)))
    throw new Error("Replacement cannot change the rejected discovery scope");
  if (
    !correction ||
    correction.failureDigest !== failureDigest(error) ||
    !["planning-output", "planning-evidence", "planning-choice"].includes(
      correction.kind,
    ) ||
    ![correction.actor, correction.diagnosis, correction.correction].every(
      (text) => typeof text === "string" && text.trim(),
    ) ||
    correction.actor !== proposal.actor ||
    (rejected.proposal.replacement?.correction.failureDigest ===
      correction.failureDigest &&
      rejected.proposal.replacement.correction.correction ===
        correction.correction) ||
    state.rejectedAmendments?.some(
      (entry) =>
        entry.error === error &&
        entry.proposal.replacement?.correction.correction ===
          correction.correction,
    )
  )
    throw new Error(
      "Replacement requires a new diagnosis bound to the rejection",
    );
  // The replacement is charged when it starts; it must fit now.
  const refusal = planningRefusal(state, correction.kind);
  if (refusal) throw new Error(refusal.message);
  return rejected;
}

export function recordWorkerDiscovery(
  state: FactoryState,
  itemId: string,
  discovery: WorkDiscovery | undefined,
): void {
  if (!discovery) return;
  assertDiscovery(discovery);
  const work = state.work[itemId]!;
  if (!work.attempt) throw new Error("Worker discovery lacks an attempt");
  work.discovery = { ...structuredClone(discovery), attempt: work.attempt };
}

/** An operator declines the proposal, not the implementation or its acceptance. */
export interface WorkerDiscoveryDecision {
  runId: string;
  item: string;
  attempt: string;
  resultCommitSha: string;
  resultTreeSha: string;
  graphDigest: string;
  discoveryDigest: string;
  actor: string;
  reason: string;
}
export interface WorkerDiscoveryDecline extends WorkerDiscoveryDecision {
  repository: string;
  objective: number;
  configDigest: string;
  declinedAt: string;
}

export const workerDiscoveryDigest = (
  discovery: NonNullable<WorkState["discovery"]>,
) => createHash("sha256").update(JSON.stringify(discovery)).digest("hex");

/** Authenticate the original decision after restart, replay or graph succession. */
export function assertWorkerDiscoveryDisposition(
  state: FactoryState,
  itemId: string,
  work: WorkState,
): void {
  if (
    work.discoveryDisposition !== undefined &&
    !["proposed", "accepted", "declined"].includes(work.discoveryDisposition)
  )
    throw new Error("Invalid worker discovery disposition");
  const declined = work.discoveryDecline;
  if ((work.discoveryDisposition === "declined") !== (declined !== undefined))
    throw new Error("Worker discovery decline lost its decision");
  if (!declined) return;
  refuseUnknownFields(
    declined as unknown as Record<string, unknown>,
    [
      "runId",
      "item",
      "attempt",
      "resultCommitSha",
      "resultTreeSha",
      "graphDigest",
      "discoveryDigest",
      "actor",
      "reason",
      "repository",
      "objective",
      "configDigest",
      "declinedAt",
    ],
    "worker discovery decline",
  );
  const discovery = work.discovery;
  if (!discovery || discovery.scope !== "in-scope")
    throw new Error("Worker discovery decline lacks its original proposal");
  assertDiscovery(discovery);
  if (
    declined.repository !== state.repository ||
    declined.objective !== state.objective ||
    declined.runId !== state.runId ||
    declined.configDigest !== state.configDigest ||
    declined.item !== itemId ||
    declined.attempt !== work.attempt ||
    discovery.attempt !== work.attempt ||
    declined.discoveryDigest !== workerDiscoveryDigest(discovery) ||
    !/^[a-f0-9]{40}$/.test(declined.resultCommitSha) ||
    !/^[a-f0-9]{40}$/.test(declined.resultTreeSha) ||
    ![
      graphDigest(state.graph),
      state.planGraphDigest,
      ...(state.graphRevisions ?? []).map((revision) => revision.digest),
    ].includes(declined.graphDigest) ||
    typeof declined.actor !== "string" ||
    !declined.actor.trim() ||
    typeof declined.reason !== "string" ||
    !declined.reason.trim() ||
    typeof declined.declinedAt !== "string" ||
    !Number.isFinite(Date.parse(declined.declinedAt))
  )
    throw new Error(
      "Worker discovery decline differs from its retained binding",
    );
}

/** Selection is from settled result evidence in the existing snapshot, not another work queue. */
export function selectWorkerAmendment(state: FactoryState): void {
  if (state.pendingAmendment) return;
  for (const [itemId, work] of Object.entries(state.work)) {
    if (
      !work.discovery ||
      work.discovery.scope === "backlog" ||
      work.discoveryDisposition
    )
      continue;
    submitAmendment(state, {
      ...work.discovery,
      actor: `worker:${itemId}`,
      expectedGraphDigest: graphDigest(state.graph),
      worker: { itemId, attempt: work.discovery.attempt },
    });
    work.discoveryDisposition = "proposed";
    return;
  }
}

/**
 * The Work Item whose failed, unpublished attempt proposed this amendment. Its
 * result is gone and it is attempted again, so the amendment may widen its
 * ownership: the worker saw paths the plan could not (#819, #827).
 */
function reattemptedItem(
  state: FactoryState,
  proposal: AmendmentProposal,
): string | undefined {
  const id = proposal.worker?.itemId ?? "";
  const work = state.work[id];
  const item = state.graph.items.find((entry) => entry.id === id);
  return work?.status === "failed" &&
    work.attempt === proposal.worker?.attempt &&
    work.recovery?.failure?.event &&
    !work.pullRequest &&
    (item?.kind ?? "work") === "work"
    ? id
    : undefined;
}

export function amendmentBlocksDispatch(state: FactoryState): boolean {
  return (
    !!state.pendingAmendment ||
    Object.values(state.work).some(
      (work) =>
        work.discovery?.scope === "in-scope" && !work.discoveryDisposition,
    )
  );
}

function validateAmendment(
  state: FactoryState,
  graph: WorkGraph,
  config: FactoryConfig,
  body: string,
): void {
  const pending = state.pendingAmendment!;
  if (
    (graph.conditions?.length || graph.expansions?.length) &&
    !state.planningRecovery?.contextLookup
  )
    throw new Error(
      "Reviewed adaptive graph changes require the original admitted planning context",
    );
  for (const id of Object.keys(state.conditionFacts ?? {})) {
    if (
      !isDeepStrictEqual(
        state.graph.conditions?.find((entry) => entry.id === id),
        graph.conditions?.find((entry) => entry.id === id),
      )
    )
      throw new Error(
        "An amendment cannot rewrite retained condition facts; add a reviewed successor condition",
      );
  }
  for (const settled of state.expansionHistory ?? []) {
    const previous = state.graph.expansions?.find(
      (entry) => entry.id === settled.envelopeId,
    );
    const next = graph.expansions?.find(
      (entry) => entry.id === settled.envelopeId,
    );
    if (!previous || !next || !isDeepStrictEqual(previous, next))
      throw new Error(
        "An amendment cannot rewrite a settled expansion envelope; add a separately reviewed successor envelope",
      );
  }
  if (pending.proposal.expectedGraphDigest !== graphDigest(state.graph))
    throw new Error("Stale amendment candidate");
  const sources = planningSources(body, state.baseSha, config.checkout);
  validateGraph(
    graph,
    state.objective,
    state.baseSha,
    new Set(sources.map((source) => source.path)),
    state.graph,
  );
  validateCommandProvenance(graph, sources, config.checkout);
  validateGraphSources(graph, sources, config.checkout, body, state.baseSha);
  verifyExecutionProfiles(graph, executionProfileChoices(config));
  assertCoverageSources(
    graph,
    sources,
    coverageObligations(body, objectiveCriteria(body)),
    finalObjectiveCommands(body),
    commandAuthority(body),
  );
  if (!graph.coverage)
    throw new Error("Amendment requires retained acceptance coverage");
  for (const old of state.graph.items) {
    const next = graph.items.find((item) => item.id === old.id);
    if (!next)
      throw new Error("Amendments cannot remove stable Work Item identities");
    const changed = !sameItem(next, old);
    if (
      state.work[old.id]?.routing &&
      !isDeepStrictEqual(next.condition, old.condition)
    )
      throw new Error("An amendment cannot change a settled branch binding");
    const work = state.work[old.id]!;
    // Only the attempt that is run again changes: its ownership widens, and
    // its acceptance, brief and non-goals state the behaviour it now owns.
    const widened =
      old.id === reattemptedItem(state, pending.proposal) &&
      sameItem(
        {
          ...next,
          ownedPaths: old.ownedPaths,
          acceptance: old.acceptance,
          brief: old.brief,
          nonGoals: old.nonGoals,
        },
        old,
      ) &&
      old.ownedPaths.every((path) => next.ownedPaths.includes(path));
    // Review judges a result only against these fields, so an operator
    // answer that widens the reattempted item without them leaves the
    // approved change unreviewable (#1610).
    if (
      widened &&
      pending.decisions?.some((entry) => entry.answer) &&
      !isDeepStrictEqual(
        [...next.ownedPaths].sort(),
        [...old.ownedPaths].sort(),
      ) &&
      isDeepStrictEqual(next.acceptance, old.acceptance) &&
      next.brief === old.brief &&
      isDeepStrictEqual(next.nonGoals, old.nonGoals)
    )
      throw new Error(
        `Work Item ${old.id} changes its owned paths after an operator answer but not its acceptance, brief or non-goals; state the behaviour the answer approved`,
      );
    if (
      changed &&
      !widened &&
      (work.status !== "pending" ||
        work.attempt ||
        work.execution ||
        work.pullRequest)
    )
      throw new Error(
        `Started/completed Work Item ${old.id} is immutable; add explicit successor or revalidation work`,
      );
  }
  for (const entry of state.graph.coverage ?? []) {
    const next = graph.coverage.find(
      (candidate) => candidate.criterionId === entry.criterionId,
    );
    if (
      !next ||
      !isDeepStrictEqual(next.source, entry.source) ||
      next.statement !== entry.statement
    )
      throw new Error(
        "Amendment deletes or changes source acceptance coverage",
      );
  }
  // An excluded source exit item stays accounted for: still excluded, or now covered.
  for (const exclusion of state.graph.sourceExclusions ?? [])
    if (
      ![...(graph.sourceExclusions ?? []), ...graph.coverage].some(
        (entry) =>
          entry.source.lines !== undefined &&
          sourceObligationId({ ...entry.source, lines: entry.source.lines }) ===
            sourceObligationId(exclusion.source),
      )
    )
      throw new Error("Amendment drops an excluded source obligation");
  if (config.delivery.kind === "native-stack") {
    const nextUnits = linearDeliveryUnits(graph);
    for (const unit of linearDeliveryUnits(state.graph)) {
      if (
        !unit.items.some(
          (item) =>
            state.work[item.id]?.attempt || state.work[item.id]?.pullRequest,
        )
      )
        continue;
      const next = nextUnits.find((candidate) => candidate.id === unit.id);
      if (
        !next ||
        JSON.stringify(next.items.map((item) => item.id)) !==
          JSON.stringify(unit.items.map((item) => item.id))
      )
        throw new Error(
          "Amendment repartitions a started native delivery unit",
        );
    }
  }
}

/** The pending amendment's result was refused; the operator submits a replacement. */
export class AmendmentRejection extends Error {
  override readonly name = "AmendmentRejection";
}

/** The rejected amendment's wait for the operator's replacement. */
function rejectionWait(pending: PendingAmendment): Error {
  return attachFault(
    new AmendmentRejection(pending.error ?? "Amendment rejected"),
    {
      kind: "work",
      evidence: { detail: pending.error || "Amendment rejected" },
    },
  );
}

/** Native originals the planner's question-asking compilations retained. */
function amendmentDecisionReturns(original: object): ContentRef[] {
  const decisions =
    "decisions" in original
      ? (original as PendingAmendment).decisions
      : undefined;
  return (decisions ?? []).flatMap(
    (entry) => entry.invocation?.nativeReturns ?? [],
  );
}

/** The operator's question about the pending amendment and how to answer it. */
function amendmentQuestion(state: FactoryState, question: string): string {
  return `${question} Answer with factory decide --objective ${state.objective} --outcome accept --answer "..." --question ${questionDigest(question)} --reason "...", or refuse the amendment with --outcome refuse --reason "...".`;
}

/**
 * `factory decide` for the pending amendment's open question (#1296). Accept
 * records the answer, and the next run compiles the amendment with it; refuse
 * rejects the amendment and gives back its planning revision, so a corrected
 * replacement stays possible. The caller holds the mutation lock and saves.
 */
export function decideAmendment(
  state: FactoryState,
  input: {
    actor: string;
    outcome: "accept" | "refuse";
    answer?: string;
    question?: string;
    reason: string;
  },
): void {
  const pending = state.pendingAmendment;
  const open = pending?.decisions?.at(-1);
  if (!pending || pending.phase === "rejected" || !open || open.answer)
    throw new Error("No amendment decision is pending");
  if (!input.actor.trim() || !input.reason.trim())
    throw new Error("An amendment decision needs actor and reason");
  if (input.outcome === "accept") {
    if (!input.answer?.trim())
      throw new Error("Accepting an amendment decision requires --answer");
    assertAnsweredQuestion(open.question, input.question);
    open.answer = {
      actor: input.actor,
      answer: input.answer,
      reason: input.reason,
    };
  } else {
    pending.phase = "rejected";
    pending.rejectionStage = "decision";
    pending.error = `The operator refused the amendment: ${input.reason}`;
    // The operator refused it, so nothing it was charged for is consumed.
    const event = amendmentEvent(pending);
    for (const key of state.charges?.[event]?.allowances ?? [])
      releaseCharge(state, event, key);
    if (state.coordinator) {
      state.coordinator.mode = "paused";
      state.coordinator.waitReason = pending.error;
    }
    refreshBlameDecisions(state, graphDigest(state.graph));
  }
  clearRepeats(state, "objective");
}

/**
 * Advance the pending amendment as the Objective's `amend` step: its compile
 * and review are paid calls, and a call that ended without a completed
 * answer repeats from the last completed phase.
 */
export function applyPendingAmendment(
  args: Parameters<typeof advanceAmendment>[0] &
    Pick<StepOptions, "signal" | "pause" | "clock">,
): Promise<boolean> {
  const { signal, pause, clock, ...rest } = args;
  return step(
    args.state,
    { scope: "objective", name: "amend", paid: true },
    async (context) => {
      selectWorkerAmendment(args.state);
      if (!args.state.pendingAmendment) return false;
      // An unanswered planner question holds the amendment: asking again
      // needs no planner admission, charge or model call (#1296).
      const open = args.state.pendingAmendment.decisions?.at(-1);
      if (
        open &&
        !open.answer &&
        args.state.pendingAmendment.phase !== "rejected"
      )
        throw new StepFault(
          decision(amendmentQuestion(args.state, open.question)),
        );
      // A rejected amendment still waits for the operator's replacement: a
      // blind rerun names that wait again instead of failing the run.
      if (args.state.pendingAmendment.phase === "rejected")
        throw rejectionWait(args.state.pendingAmendment);
      let workflowRecipe: WorkflowRecipeInput | undefined;
      if (args.state.workflowRecipePin) {
        try {
          if (!args.contentStore)
            throw new Error(
              "Recipe amendment requires the admitted ContentStore",
            );
          workflowRecipe = await readPinnedWorkflowRecipe(
            args.state.workflowRecipePin,
            args.contentStore,
          );
        } catch (error) {
          throw new StepFault(
            decision(
              "Pinned recipe content is unavailable; restore the exact retained recipe before amendment planning",
            ),
            { cause: error },
          );
        }
      }
      const paid = paidModel(args.model, context);
      return withPlannerAdmission(
        args.state,
        () =>
          args.cancelled() ||
          Boolean(
            args.state.coordinator && args.state.coordinator.mode !== "running",
          ),
        async () => {
          // A Work Item diagnosis that stopped without an outcome no longer
          // holds the planner conversation this amendment needs.
          await settleAbandonedPlanningTurn(args.state, args.model, args.save);
          return advanceAmendment({
            ...rest,
            workflowRecipe,
            model: {
              ...paid,
              // An answer that does not decode is a lost answer, not a refusal:
              // it is decoded inside the paid call, so the step asks again and
              // then the operator. Only findings that decode refuse.
              reviewGraph: (request) =>
                context.paid(async () => {
                  const response = await args.model.reviewGraph(request);
                  if (args.state.pendingAmendment?.reviewInvocation) {
                    args.state.pendingAmendment.reviewInvocation.response =
                      structuredClone(response);
                    args.save();
                  }
                  try {
                    if (request.reviewPacket)
                      decodeGraphReview(
                        response,
                        request.reviewPacket,
                        request.graph.items.map((item) => item.id),
                      );
                  } catch (error) {
                    const pending = args.state.pendingAmendment;
                    if (pending) {
                      pending.reviewRejectedResponses ??= [];
                      pending.reviewRejectedResponses.push(
                        structuredClone(response),
                      );
                      pending.reviewRejectedNativeReturns ??= [];
                      pending.reviewRejectedNativeReturns.push(
                        ...(pending.reviewInvocation?.nativeReturns ?? []),
                      );
                      delete pending.reviewInvocation;
                      args.save();
                    }
                    throw new StepFault(
                      transient(
                        `Model output was invalid: ${error instanceof Error ? error.message : String(error)}`,
                        true,
                      ),
                    );
                  }
                  return response;
                }),
            },
          });
        },
      );
    },
    { save: args.save, signal, pause, clock },
  );
}

function amendmentNativeHooks(
  args: { state: FactoryState; contentStore?: ContentStore; save: () => void },
  owner: { id: string; nativeReturns?: ContentRef[] },
  phase: ModelInvocationContext["phase"],
): Pick<
  ModelInvocationContext,
  "beforeProviderAttempt" | "retainNativeReturn"
> {
  if (![17, 19].includes(args.state.schemaVersion)) return {};
  return {
    beforeProviderAttempt: () =>
      awaitCheckpointAdmission(args.state.repository, "before-effect"),
    retainNativeReturn: async (receipt) => {
      if (
        !args.contentStore ||
        ![
          args.state.pendingAmendment?.planningInvocation,
          args.state.pendingAmendment?.reviewInvocation,
        ].includes(owner)
      )
        throw new Error(
          "Native amendment return lacks its current owned content store",
        );
      const bytes = Buffer.from(
        JSON.stringify({
          schemaVersion: 1,
          invocationId: owner.id,
          phase,
          ...receipt,
        }),
      );
      const ref = await args.contentStore.put(
        Readable.toWeb(Readable.from([bytes])) as ReadableStream<Uint8Array>,
        { mediaType: "application/json" },
      );
      owner.nativeReturns ??= [];
      owner.nativeReturns.push(ref);
      args.save();
      // Retained locally; the next pre-effect checkpoint carries it.
      await awaitCheckpointAdmission(args.state.repository, "settled");
      return "admission-complete";
    },
  };
}
/** One compile, review and projection pass from the last completed phase. */
async function advanceAmendment(args: {
  state: FactoryState;
  config: FactoryConfig;
  body: string;
  model: PlanningModel;
  contentStore?: ContentStore;
  workflowRecipe?: WorkflowRecipeInput;
  github: GitHubGateway;
  save: () => void;
  cancelled: () => boolean;
  diagnostics?: DiagnosticEmitter;
}): Promise<boolean> {
  const { state, config, save } = args;
  const pending = state.pendingAmendment;
  if (!pending) return false;

  if (
    Object.values(state.work).some(
      (work) => work.status === "running" || work.status === "published",
    ) ||
    state.coordinator?.processes?.length
  )
    return false;
  if (pending.phase === "rejected") throw rejectionWait(pending);
  if (!["ready", "compiled", "reviewed", "projected"].includes(pending.phase))
    throw new Error(
      `Amendment ${pending.phase} cannot be replayed; inspect preserved evidence`,
    );
  const stopped = () =>
    state.coordinator && state.coordinator.mode !== "running";
  if (stopped()) return false;
  state.graphRevisions ??= [
    { graph: structuredClone(state.graph), digest: graphDigest(state.graph) },
  ];
  let compilationResponseObserved = false;
  let calling: "compile" | "review" | "projection" | undefined;
  let stage: NonNullable<PendingAmendment["rejectionStage"]> = "compilation";
  /** The operator cancelled: stop quietly at this safe point. */
  const stopIfCancelled = () => {
    if (args.cancelled()) throw cancelledFault();
  };
  /** The amendment's result is refused: a `work` fault. */
  const refused = (error: Error) =>
    attachFault(error, { kind: "work", evidence: { detail: error.message } });
  const checkAmendment = () => {
    try {
      validateAmendment(state, pending.graph!, config, args.body);
    } catch (error) {
      throw error instanceof Error ? refused(error) : error;
    }
  };
  const selectContext = async (
    role: AdaptiveContextRole,
    required: object,
    retainedId?: string,
  ) => {
    if (!state.planningRecovery?.contextLookup && retainedId === undefined)
      return undefined;
    if (!args.contentStore)
      throw new Error(
        "Adaptive amendment role context requires the admitted ContentStore",
      );
    if (retainedId !== undefined) {
      const packet = state.adaptiveContexts?.[retainedId];
      if (
        !packet ||
        packet.role !== role ||
        packet.binding.graphDigest !== graphDigest(state.graph) ||
        packet.binding.baseSha !== state.baseSha
      )
        throw new Error(
          "Retained amendment role context differs from the current admitted scope",
        );
      const payload = await authenticateAdaptiveContextPacket(
        args.contentStore,
        packet,
      );
      return {
        packet,
        payload,
        evidence: adaptiveContextEvidence(packet, payload),
      };
    }
    return buildAdaptiveContext({
      state,
      role,
      baseSha: state.baseSha,
      checkout: config.checkout,
      store: args.contentStore,
      config,
      sources: planningSources(args.body, state.baseSha, config.checkout),
      required,
      save,
    });
  };
  try {
    stopIfCancelled();
    const choices = executionProfileChoices(config);
    const localExecutables = preflightObjective(
      config,
      args.body,
      state.baseSha,
    );
    const sources = planningSources(args.body, state.baseSha, config.checkout);
    /**
     * Observe the predecessor evidence. A gateway fault keeps its kind; a
     * missing, unaccepted or changed predecessor is the operator's decision,
     * and the amendment waits at its phase (step rule 7).
     */
    const observePrerequisites = async () => {
      try {
        return await planningPrerequisites(
          config,
          args.github,
          state.objective,
          state.baseSha,
        );
      } catch (error) {
        if (attachedFault(error)) throw error;
        throw new StepFault(
          decision(
            `Amendment predecessor evidence is unavailable: ${error instanceof Error ? error.message : String(error)}. Restore it, then factory retry --objective ${state.objective}; or factory cancel --objective ${state.objective}`,
          ),
          { cause: error },
        );
      }
    };
    const prerequisites = await observePrerequisites();
    const verifyPrerequisites = async () => {
      // Reobserve the original sources against the immutable admission facts
      // and their activation digest; never change them during an amendment.
      const current = await observePrerequisites();
      const observed = current ? prerequisitesDigest(current) : undefined;
      if (
        observed !== state.prerequisitesDigest ||
        (state.prerequisites !== undefined &&
          !isDeepStrictEqual(current, state.prerequisites)) ||
        !isDeepStrictEqual(current, prerequisites)
      )
        // The predecessor's evidence changed: the operator decides, and the
        // amendment waits at its phase (step rule 7); nothing is refused.
        throw new StepFault(
          decision(
            `Amendment native prerequisites differ from those the plan was made with. Restore the predecessor evidence, then factory retry --objective ${state.objective}; or factory cancel --objective ${state.objective}`,
          ),
        );
    };
    await verifyPrerequisites();
    // Charged by the amendment's id, so a repeat after a restart is free.
    // Only after the predecessor evidence holds: a predecessor decision
    // leaves the amendment at its phase with no charge and no model call.
    if (pending.proposal.replacement)
      chargeRepair(
        state,
        amendmentEvent(pending),
        pending.proposal.replacement.correction.kind,
        ["$planning"],
      );
    else
      charge(state, amendmentEvent(pending), "planningRevisions", [
        "$planning",
      ]);
    const ordinal = consumption(state).planningRevisions;
    if (pending.phase === "ready") {
      if (pending.proposal.graph) {
        pending.graph = structuredClone(pending.proposal.graph);
        for (const item of pending.graph.items) delete item.executionBinding;
        hydrateWorkerInputSources(
          pending.graph,
          planningSources(args.body, state.baseSha, config.checkout),
          config.checkout,
        );
        normalizeExecutionProfiles(pending.graph, choices);
      } else {
        calling = "compile";
        const recovering = pending.planningInvocation !== undefined;
        pending.planningInvocation ??= { id: randomUUID() };
        save();
        pending.graph = await compileObjective(
          state.objective,
          args.body,
          state.baseSha,
          config.checkout,
          {
            ...(args.model.sessionCapabilities
              ? { sessionCapabilities: args.model.sessionCapabilities }
              : {}),
            ...(args.model.releaseSession
              ? { releaseSession: args.model.releaseSession.bind(args.model) }
              : {}),
            ...(args.model.reconcileSession
              ? {
                  reconcileSession: args.model.reconcileSession.bind(
                    args.model,
                  ),
                }
              : {}),
            ...(args.model.decodeSessionResponse
              ? {
                  decodeSessionResponse: args.model.decodeSessionResponse.bind(
                    args.model,
                  ),
                }
              : {}),
            approvedPlaybook: args.model.approvedPlaybook,
            approvedPlaybookPin: args.model.approvedPlaybookPin,
            generateStructured: async (request) => {
              const selected = await selectContext(
                "compile",
                {
                  sources: request.sources,
                  proposal: pending.proposal,
                  compileContext: request.compileContext,
                },
                pending.planningInvocation!.adaptiveContextId,
              );
              if (selected) {
                pending.planningInvocation!.adaptiveContextId =
                  selected.packet.id;
                request = {
                  ...request,
                  adaptiveContext: selected.packet,
                  compileContext: {
                    ...request.compileContext!,
                    currentImplementationEvidence: [
                      ...(request.compileContext
                        ?.currentImplementationEvidence ?? []),
                      selected.evidence,
                    ],
                  },
                };
              }
              const requestDigest = createHash("sha256")
                .update(JSON.stringify(request))
                .digest("hex");
              if (
                recovering &&
                pending.planningInvocation!.requestDigest !== requestDigest
              )
                throw new StepFault(
                  decision(
                    "The retained amendment compilation request changed; preserve the submitted owner before any continuation",
                  ),
                );
              pending.planningInvocation!.requestDigest = requestDigest;
              save();
              const response =
                pending.planningInvocation!.response ??
                (await generatePlannerStructured(
                  args.model,
                  state,
                  save,
                  request,
                  recovering,
                ));
              pending.planningInvocation!.response = structuredClone(
                response as WorkGraph,
              );
              save();
              compilationResponseObserved = true;
              return response as never;
            },
            reviewGraph: (request) => args.model.reviewGraph(request),
          },
          [],
          (pending.decisions ?? []).map((entry) => ({
            source: "operator" as const,
            question: entry.question,
            detail: `${entry.answer!.answer} (${entry.answer!.reason})`,
          })),
          {
            ...amendmentNativeHooks(
              args,
              pending.planningInvocation,
              "compile",
            ),
            invocationId: pending.planningInvocation.id,
            phase: "compile",
            ordinal,
            observe: args.diagnostics?.modelObserver({
              scopeId: pending.id,
              runId: state.runId,
            }),
          },
          choices,
          {
            currentGraph: state.graph,
            discovery: pending.proposal,
            immutableItemIds: Object.keys(state.work).filter(
              (id) =>
                state.work[id]!.status !== "pending" || state.work[id]!.attempt,
            ),
            reattemptItemId: reattemptedItem(state, pending.proposal),
            currentImplementationEvidence: amendmentImplementationEvidence({
              state,
              proposal: pending.proposal,
              checkout: config.checkout,
            }),
          },
          prerequisites,
          localExecutables,
          { configuredConcurrency: state.capacity.concurrency },
          undefined,
          undefined,
          state.planningRecovery?.contextLookup?.packet,
          args.workflowRecipe,
          undefined,
          requiredFinalCommands(config),
          ciOnlyCommands(config),
        );
      }
      admitAdvancedAmendmentFormat(state, pending.graph!);
      calling = undefined;
      pending.phase = "compiled";
      save();
    }
    stopIfCancelled();
    if (stopped()) return false;
    stage = "validation";
    checkAmendment();
    stopIfCancelled();
    if (pending.phase === "compiled") {
      stage = "review";
      await verifyPrerequisites();
      // The operator's answers this Objective's planning and this amendment
      // recorded are reviewed with it, as in plan review, so they are not
      // asked again.
      const operatorDecisions = [
        ...(operatorPlanningDecisions(state.planningRecovery) ?? []),
        ...(pending.decisions ?? []).flatMap((entry) =>
          entry.answer ? [{ question: entry.question, ...entry.answer }] : [],
        ),
      ];
      const packet = planReviewPacket(
        args.body,
        state.baseSha,
        sources,
        pending.graph!,
        config.checkout,
        choices,
        prerequisites,
        localExecutables,
        { configuredConcurrency: state.capacity.concurrency },
        state.approvedPlaybookPin,
        state.planningRecovery?.contextLookup?.packet,
        args.workflowRecipe,
        operatorDecisions,
        requiredFinalCommands(config),
      );
      packet.amendment = {
        currentImplementationEvidence: amendmentImplementationEvidence({
          state,
          proposal: pending.proposal,
          checkout: config.checkout,
        }),
        previousGraph: state.graph,
        proposal: pending.proposal,
        work: Object.fromEntries(
          Object.entries(state.work).map(([id, work]) => [
            id,
            {
              status: work.status,
              attempt: work.attempt,
              treeSha: work.treeSha,
              changeRef: work.changeRef,
              pullRequest: work.pullRequest,
              integratedSha: work.integratedSha,
            },
          ]),
        ),
      };
      const selected = await selectContext(
        "graph-review",
        {
          sources: packet.sources,
          amendment: packet.amendment,
          graph: packet.graph,
        },
        pending.reviewInvocation?.adaptiveContextId,
      );
      if (selected) {
        packet.adaptiveContext = selected.packet;
        packet.amendment.currentImplementationEvidence = [
          ...(packet.amendment.currentImplementationEvidence ?? []),
          selected.evidence,
        ];
      }
      const requestDigest = createHash("sha256")
        .update(JSON.stringify(packet))
        .digest("hex");
      if (
        pending.reviewInvocation &&
        pending.reviewInvocation.requestDigest !== requestDigest
      )
        throw new StepFault(
          decision(
            "Amendment review inputs changed after submission; preserve the exact submitted review",
          ),
        );
      const inputs = planningReviewEvidence(packet);
      const evidence = assertReviewPacketBinding(
        pending.reviewInvocation?.packet ?? reviewPacket([], inputs),
        [],
        inputs,
      );
      calling = "review";
      if (
        pending.reviewInvocation &&
        pending.reviewInvocation.response === undefined
      )
        throw new StepFault(
          decision(
            "Amendment independent review remains submitted without an authenticated response; no automatic replay is allowed",
          ),
        );
      pending.reviewInvocation ??= {
        id: randomUUID(),
        requestDigest,
        ...(selected ? { adaptiveContextId: selected.packet.id } : {}),
        packet: reviewPacketRecord(evidence),
      };
      save();
      const response =
        pending.reviewInvocation.response ??
        (await args.model.reviewGraph({
          ...packet,
          reviewPacket: evidence,
          invocation: {
            ...amendmentNativeHooks(
              args,
              pending.reviewInvocation,
              "graph-review",
            ),
            invocationId: pending.reviewInvocation.id,
            phase: "graph-review",
            ordinal,
            observe: args.diagnostics?.modelObserver({
              scopeId: pending.id,
              runId: state.runId,
            }),
          },
        }));
      pending.reviewInvocation.response = structuredClone(response);
      save();
      calling = undefined;
      // The answer decoded inside the paid call (applyPendingAmendment).
      const findings = decodeGraphReview(
        response,
        evidence,
        pending.graph!.items.map((item) => item.id),
      );
      if (findings.length) {
        // Only a complete packet-bound decoded finding permits diagnosed correction.
        stage = "review-findings";
        throw refused(
          new Error(
            `Independent amendment review rejected: ${JSON.stringify(findings)}`,
          ),
        );
      }
      pending.reviewDigest = createHash("sha256")
        .update(JSON.stringify({ packet, findings }))
        .digest("hex");
      pending.phase = "reviewed";
      save();
    }
    stopIfCancelled();
    if (stopped()) return false;
    checkAmendment();
    stopIfCancelled();
    if (pending.phase === "reviewed") {
      await verifyPrerequisites();
      stage = "projection";
      calling = "projection";
      if (
        (state.schemaVersion === 11 ||
          state.schemaVersion === 13 ||
          state.schemaVersion === 15 ||
          [17, 19].includes(state.schemaVersion) ||
          pending.graph!.conditions?.length ||
          pending.graph!.expansions?.length) &&
        args.github.projectionMutationAdmission !== "controller-checkpoint-v1"
      )
        throw attachFault(
          new Error(
            "GitHub adapter cannot checkpoint expanded amendment projection",
          ),
          decision(
            "Use an adapter that retains exact expanded graph projection requests",
          ),
        );
      // Projection finds existing issues by marker, so repeating it is safe.
      const projected = await args.github.projectGraph({
        graph: pending.graph!,
        ...(state.schemaVersion === 11 ||
        state.schemaVersion === 13 ||
        state.schemaVersion === 15 ||
        [17, 19].includes(state.schemaVersion) ||
        pending.graph!.conditions?.length ||
        pending.graph!.expansions?.length
          ? {
              expansionControl: graphProjectionControl(
                state,
                pending.graph!,
                save,
              ),
            }
          : {}),
        previousGraph: state.graph,
        objectiveIssue: state.objective,
        knownIssues: pending.issueByItemId,
        author: state.issueAuthor,
        authored: (login) => {
          state.issueAuthor = login;
          save();
        },
        completedItems: Object.keys(state.work).filter((id) =>
          workSettled(state.work[id]),
        ),
        beforeCreate: () => {
          stopIfCancelled();
        },
        projected: (id, issue) => {
          pending.issueByItemId[id] = issue;
          save();
        },
      });
      calling = undefined;
      pending.issueByItemId = projected.issueByItemId;
      pending.phase = "projected";
      save();
    }
    stopIfCancelled();
    if (stopped()) return false;
    checkAmendment();
    await verifyPrerequisites();
    const proposalReceipt = structuredClone(pending.proposal);
    delete proposalReceipt.graph;
    state.graphRevisions.push({
      graph: structuredClone(pending.graph!),
      digest: graphDigest(pending.graph!),
      parentDigest: graphDigest(state.graph),
      proposal: proposalReceipt,
      reviewDigest: pending.reviewDigest!,
      ...(pending.planningInvocation && {
        planningInvocation: structuredClone(pending.planningInvocation),
      }),
      ...(pending.reviewInvocation && {
        reviewInvocation: structuredClone(pending.reviewInvocation),
      }),
      ...(pending.reviewRejectedNativeReturns && {
        reviewRejectedNativeReturns: structuredClone(
          pending.reviewRejectedNativeReturns,
        ),
      }),
      acceptedAt: new Date().toISOString(),
    });
    const reattempt = reattemptedItem(state, pending.proposal);
    const widened =
      reattempt !== undefined &&
      !sameItem(
        state.graph.items.find((item) => item.id === reattempt),
        pending.graph!.items.find((item) => item.id === reattempt),
      );
    state.graph = pending.graph!;
    if ([17, 19].includes(state.schemaVersion)) {
      /* Keep the checkpoint reader fence. */
    } else if (state.workflowRecipePin) state.schemaVersion = 15;
    else if (
      state.graph.conditions?.length ||
      state.conditionFacts ||
      state.workflowReflection ||
      state.schemaVersion === 13 ||
      state.schemaVersion === 15
    )
      state.schemaVersion = 13;
    else if (state.graph.expansions?.length) state.schemaVersion = 11;
    state.issueByItemId = pending.issueByItemId;
    for (const item of state.graph.items)
      state.work[item.id] ??= { status: "pending" };
    if (pending.proposal.worker)
      state.work[pending.proposal.worker.itemId]!.discoveryDisposition =
        "accepted";
    if (widened) {
      // The plan was wrong, not the implementation: the item starts a new
      // attempt under its wider ownership, and no repair is spent on it.
      const work = state.work[reattempt]!;
      releaseCharge(state, work.recovery!.failure!.event!);
      clearRepeats(state, { item: reattempt });
      state.work[reattempt] = {
        status: "pending",
        recovery: { ...archiveAttempt(work), phase: "stopped" },
      };
    }
    delete state.pendingAmendment;
    delete state.error;
    delete state.errorItem;
    refreshBlameDecisions(state, graphDigest(state.graph));
    save();
    return true;
  } catch (error) {
    // Only a refused result (a `work` fault) or an answered model output
    // rejects the amendment. Anything else leaves it at its last completed
    // phase: the step repeats a transient fault, waits on a decision or a
    // configuration fix, and stops on cancellation or a defect.
    // A compiled graph that fails Factory's checks is an answered,
    // refused result even before it carries a fault.
    // The planner asked the operator (#1296): the amendment waits at its
    // compilation for the answer, with no rejection and no new charge.
    const asked = plannerDecisionOf(error);
    if (asked && !pending.proposal.graph) {
      pending.decisions = [
        ...(pending.decisions ?? []),
        {
          question: asked.question,
          ...(pending.planningInvocation && {
            invocation: structuredClone(pending.planningInvocation),
          }),
        },
      ];
      delete pending.planningInvocation;
      delete pending.graph;
      pending.phase = "ready";
      save();
      throw new StepFault(decision(amendmentQuestion(state, asked.question)), {
        cause: error,
      });
    }
    const fault = attachedFault(error);
    const refusedResult =
      fault?.kind === "work" ||
      (!fault && calling === "compile" && compilationResponseObserved) ||
      // An operator-supplied graph cannot take an answer: it is refused.
      !!asked;
    if (!refusedResult) throw error;
    pending.rejectionStage = stage;
    pending.phase = "rejected";
    pending.error = error instanceof Error ? error.message : String(error);
    if (state.coordinator) {
      state.coordinator.mode = "paused";
      state.coordinator.waitReason = pending.error;
    }
    // After the pause: whether a replacement fits depends on it.
    refreshBlameDecisions(state, graphDigest(state.graph));
    save();
    // The amendment's result is refused, whatever the call reported.
    throw attachFault(new AmendmentRejection(pending.error, { cause: error }), {
      kind: "work",
      evidence: { detail: pending.error || "Amendment rejected" },
    });
  }
}
