import {
  chargeRepair,
  consumeAllowance,
  failureDigest,
  type RepairCorrection,
} from "./repair-policy.js";
import { preflightObjective } from "./admission.js";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  compileObjective,
  hydrateWorkerInputSources,
  objectiveCriteria,
  planningSources,
  planningReviewEvidence,
  planReviewPacket,
  validateCommandProvenance,
  validateGraph,
  validateGraphSources,
} from "./compiler.js";
import type { FactoryConfig } from "./config.js";
import type {
  GitHubGateway,
  PlanningModel,
  WorkDiscovery,
  WorkGraph,
  WorkItem,
} from "./contracts.js";
import { CompletedModelInvocationError } from "./contracts.js";
import { linearDeliveryUnits } from "./delivery/plan.js";
import {
  executionProfileChoices,
  normalizeExecutionProfiles,
  verifyExecutionProfiles,
} from "./execution-profiles.js";
import { assertCoverageSources, coverageObligations } from "./qa.js";
import { decodeGraphReview, reviewPacket } from "./review-evidence.js";
import type { DiagnosticEmitter } from "./diagnostics.js";
import type { FactoryState } from "./state.js";

export interface AmendmentProposal extends WorkDiscovery {
  expectedGraphDigest: string;
  actor: string;
  /** Operator supplied candidate; worker discoveries are compiled by the controller. */
  graph?: WorkGraph;
  worker?: { itemId: string; attempt: string };
  /** Explicit disposition of a known compiler rejection, never an effect replay. */
  replacement?: { amendmentId: string; correction: RepairCorrection };
}
export interface PendingAmendment {
  id: string;
  proposal: AmendmentProposal;
  phase:
    | "ready"
    | "compiled"
    | "reviewed"
    | "projected"
    | "compiling"
    | "reviewing"
    | "projecting"
    | "rejected"
    | "backlog";
  graph?: WorkGraph;
  reviewDigest?: string;
  issueByItemId: Record<string, number>;
  projectionPending?: string;
  error?: string;
  rejectionStage?: "compilation" | "validation" | "review" | "projection";
}
export interface GraphRevision {
  graph: WorkGraph;
  digest: string;
  parentDigest?: string;
  proposal?: AmendmentProposal;
  reviewDigest?: string;
  acceptedAt?: string;
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

/** Validate the immutable succession, never rewrite the admitted initial digest. */
export function assertGraphRevisions(state: FactoryState): void {
  for (const rejected of state.rejectedAmendments ?? []) {
    assertDiscovery(rejected.proposal);
    if (
      !rejected.id ||
      rejected.phase !== "rejected" ||
      !rejected.error ||
      rejected.projectionPending ||
      ![
        state.admission?.graphDigest,
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
  const revisions = state.graphRevisions;
  if (revisions) {
    if (
      !revisions.length ||
      !state.admission ||
      revisions[0]!.digest !== state.admission.graphDigest
    )
      throw new Error("Graph revisions do not descend from admitted authority");
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
          !revision.proposal ||
          revision.proposal.expectedGraphDigest !== revision.parentDigest ||
          !/^[a-f0-9]{64}$/.test(revision.reviewDigest ?? "") ||
          !Number.isFinite(Date.parse(revision.acceptedAt ?? "")))
      )
        throw new Error(
          "Graph revision lacks reviewed compare-and-set succession",
        );
    }
    if (revisions.at(-1)!.digest !== graphDigest(state.graph))
      throw new Error("Current graph differs from accepted revision");
  }
  if (state.allowanceConsumption) {
    if (!state.admission)
      throw new Error("Allowance consumption lacks admission");
    for (const key of [
      "planningRevisions",
      "implementationRepairs",
      "resultRereviews",
    ] as const)
      if (
        !Number.isSafeInteger(state.allowanceConsumption[key]) ||
        state.allowanceConsumption[key] < 0 ||
        state.allowanceConsumption[key] >
          state.admission.authority.allowances[key]
      )
        throw new Error("Objective allowance consumption is invalid");
    if (
      (revisions?.length ?? 1) - 1 >
      state.allowanceConsumption.planningRevisions
    )
      throw new Error("Accepted revisions exceed consumed allowance");
  } else if (revisions && revisions.length > 1)
    throw new Error("Graph revisions lost Objective allowance consumption");
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
      ![
        "ready",
        "compiled",
        "reviewed",
        "projected",
        "compiling",
        "reviewing",
        "projecting",
        "rejected",
        "backlog",
      ].includes(pending.phase) ||
      pending.proposal.expectedGraphDigest !== graphDigest(state.graph)
    )
      throw new Error("Pending amendment has stale graph identity");
    if (
      ["compiled", "reviewing", "reviewed", "projecting", "projected"].includes(
        pending.phase,
      ) &&
      !pending.graph
    )
      throw new Error("Pending amendment lacks candidate graph");
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
  const knownPlanningCharges =
    (state.graphRevisions?.length ?? 1) -
    1 +
    (state.rejectedAmendments?.length ?? 0) +
    (pending && !["ready", "backlog"].includes(pending.phase) ? 1 : 0);
  if (
    knownPlanningCharges >
      (state.allowanceConsumption?.planningRevisions ?? 0) ||
    (state.admission?.authority.repairPolicy &&
      knownPlanningCharges >
        (state.repairConsumption?.$planning?.planningRevisions ?? 0))
  )
    throw new Error(
      "Known amendment attempts exceed retained planning consumption",
    );
}

export function hasPendingAmendmentEffect(state: FactoryState): boolean {
  return (
    !!state.pendingAmendment &&
    (["compiling", "reviewing", "projecting"].includes(
      state.pendingAmendment.phase,
    ) ||
      !!state.pendingAmendment.projectionPending)
  );
}

export function submitAmendment(
  state: FactoryState,
  proposal: AmendmentProposal,
): PendingAmendment {
  if (state.objectiveClosure === "complete")
    throw new Error("Completed Objective discoveries require successor work");
  if (state.finalAcceptance || state.objectiveClosure === "pending")
    throw new Error(
      "Objective closure is busy or awaiting reconciliation; amendment intake is fenced",
    );
  assertDiscovery(proposal);
  if (
    !proposal.actor?.trim() ||
    proposal.expectedGraphDigest !== graphDigest(state.graph)
  )
    throw new Error(
      "Amendment actor or compare-and-set graph identity is invalid",
    );
  if (
    !state.admission ||
    state.cancelRequested ||
    state.cancelledAt ||
    state.finalValidation?.passed
  )
    throw new Error("Amendment requires a nonterminal admitted Objective");
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
  if (proposal.worker) {
    const work = state.work[proposal.worker.itemId];
    if (!work || work.attempt !== proposal.worker.attempt)
      throw new Error("Discovery has stale worker attempt identity");
  }
  if (rejected) {
    state.rejectedAmendments ??= [];
    state.rejectedAmendments.push(structuredClone(rejected));
    // Only this exact known rejection may be cleared; all other state is retained.
    if (state.error === rejected.error) delete state.error;
  }
  state.pendingAmendment = {
    id: randomUUID(),
    proposal: structuredClone(proposal),
    phase: "ready",
    issueByItemId: { ...state.issueByItemId },
  };
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
  const rejected = state.pendingAmendment;
  const replacement = proposal.replacement!;
  const correction = replacement.correction;
  if (
    !rejected ||
    rejected.id !== replacement.amendmentId ||
    rejected.phase !== "rejected" ||
    !rejected.error ||
    rejected.proposal.graph ||
    proposal.graph ||
    rejected.projectionPending ||
    rejected.reviewDigest ||
    (rejected.rejectionStage !== undefined
      ? !["compilation", "validation"].includes(rejected.rejectionStage)
      : !!rejected.graph) ||
    !isDeepStrictEqual(rejected.issueByItemId, state.issueByItemId)
  )
    throw new Error(
      "Replacement requires a known unprojected compiler rejection",
    );
  if (
    state.coordinator?.mode !== "paused" ||
    state.coordinator.cancelError ||
    state.coordinator.processes?.length ||
    state.coordinator.phase === "objective-review-submitted" ||
    (state.error !== undefined && state.error !== rejected.error) ||
    Object.values(state.work).some(
      (work) =>
        work.status === "running" ||
        work.status === "published" ||
        work.pendingEffect ||
        (work.execution && work.status !== "done" && work.step === "execute") ||
        work.recovery?.failure?.classification === "uncertain",
    )
  )
    throw new Error("Amendment replacement requires paused, settled ownership");
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
    correction.failureDigest !== failureDigest(rejected.error) ||
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
        entry.error === rejected.error &&
        entry.proposal.replacement?.correction.correction ===
          correction.correction,
    )
  )
    throw new Error(
      "Replacement requires a new diagnosis bound to the rejection",
    );
  // Check availability without charging or mutating the authoritative ledger.
  chargeRepair(
    {
      admission: state.admission,
      allowanceConsumption: structuredClone(state.allowanceConsumption),
      repairConsumption: structuredClone(state.repairConsumption),
    },
    correction.kind,
    ["$planning"],
  );
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

/** Selection is from settled result evidence in the existing snapshot, not another work queue. */
export function selectWorkerAmendment(state: FactoryState): void {
  if (state.pendingAmendment || !state.admission) return;
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

export function amendmentBlocksDispatch(state: FactoryState): boolean {
  return (
    (!!state.pendingAmendment && state.pendingAmendment.phase !== "backlog") ||
    (!!state.admission &&
      Object.values(state.work).some(
        (work) =>
          work.discovery?.scope === "in-scope" && !work.discoveryDisposition,
      ))
  );
}

export function validateAmendment(
  state: FactoryState,
  graph: WorkGraph,
  config: FactoryConfig,
  body: string,
): void {
  const pending = state.pendingAmendment!;
  if (pending.proposal.expectedGraphDigest !== graphDigest(state.graph))
    throw new Error("Stale amendment candidate");
  const sources = planningSources(
    body,
    state.baseSha,
    config.checkout,
    state.additionalSources,
  );
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
  );
  if (!graph.coverage)
    throw new Error("Amendment requires retained acceptance coverage");
  for (const old of state.graph.items) {
    const next = graph.items.find((item) => item.id === old.id);
    if (!next)
      throw new Error("Amendments cannot remove stable Work Item identities");
    const changed = !sameItem(next, old);
    const work = state.work[old.id]!;
    if (
      changed &&
      (work.status !== "pending" ||
        work.attempt ||
        work.execution ||
        work.pullRequest ||
        work.pendingEffect)
    )
      throw new Error(
        `Started/completed Work Item ${old.id} is immutable; add explicit successor or revalidation work`,
      );
    if (
      old.acceptance.some((criterion) => !next.acceptance.includes(criterion))
    )
      throw new Error(
        "Amendments cannot delete accepted Work Item obligations",
      );
  }
  for (const entry of state.graph.coverage ?? []) {
    const next = graph.coverage.find(
      (candidate) => candidate.criterionId === entry.criterionId,
    );
    if (!next || !isDeepStrictEqual(next.source, entry.source))
      throw new Error(
        "Amendment deletes or changes source acceptance coverage",
      );
  }
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

/** One bounded compilation/review at a settled boundary. Unknown external effects remain fenced. */
export async function applyPendingAmendment(args: {
  state: FactoryState;
  config: FactoryConfig;
  body: string;
  model: PlanningModel;
  github: GitHubGateway;
  save: () => void;
  cancelled: () => boolean;
  diagnostics?: DiagnosticEmitter;
}): Promise<boolean> {
  const { state, config, save } = args;
  selectWorkerAmendment(state);
  const pending = state.pendingAmendment;
  if (!pending || pending.phase === "backlog") return false;
  if (
    Object.values(state.work).some(
      (work) =>
        work.status === "running" ||
        work.status === "published" ||
        work.pendingEffect,
    ) ||
    state.coordinator?.processes?.length
  )
    return false;
  if (!["ready", "compiled", "reviewed", "projected"].includes(pending.phase))
    throw new Error(
      `Amendment ${pending.phase} cannot be replayed; inspect preserved evidence`,
    );
  const stopped = () =>
    state.coordinator && state.coordinator.mode !== "running";
  if (stopped()) return false;
  state.allowanceConsumption ??= {
    planningRevisions: 0,
    implementationRepairs: 0,
    resultRereviews: 0,
  };
  const consumption = state.allowanceConsumption;
  if (pending.phase === "ready") {
    if (pending.proposal.replacement)
      chargeRepair(state, pending.proposal.replacement.correction.kind, [
        "$planning",
      ]);
    else consumeAllowance(state, "planningRevisions", ["$planning"]);
  }
  state.graphRevisions ??= [
    { graph: structuredClone(state.graph), digest: graphDigest(state.graph) },
  ];
  let compilationResponseObserved = false;
  let stage: NonNullable<PendingAmendment["rejectionStage"]> = "compilation";
  try {
    if (args.cancelled()) throw new Error("Objective cancelled");
    const choices = executionProfileChoices(config);
    const localExecutables = preflightObjective(
      config,
      args.body,
      state.baseSha,
    );
    if (pending.phase === "ready") {
      if (pending.proposal.graph) {
        pending.graph = structuredClone(pending.proposal.graph);
        for (const item of pending.graph.items) delete item.executionBinding;
        hydrateWorkerInputSources(
          pending.graph,
          planningSources(
            args.body,
            state.baseSha,
            config.checkout,
            state.additionalSources,
          ),
        );
        normalizeExecutionProfiles(pending.graph, choices);
      } else {
        pending.phase = "compiling";
        save();
        pending.graph = await compileObjective(
          state.objective,
          args.body,
          state.baseSha,
          config.checkout,
          {
            generateStructured: async (request) => {
              const response = await args.model.generateStructured(request);
              compilationResponseObserved = true;
              return response;
            },
            reviewGraph: (request) => args.model.reviewGraph(request),
          },
          [],
          [],
          {
            invocationId: randomUUID(),
            phase: "compile",
            ordinal: consumption.planningRevisions,
            observe: args.diagnostics?.modelObserver({
              scopeId: pending.id,
              runId: state.runId,
            }),
          },
          choices,
          state.additionalSources,
          {
            currentGraph: state.graph,
            discovery: pending.proposal,
            immutableItemIds: Object.keys(state.work).filter(
              (id) =>
                state.work[id]!.status !== "pending" || state.work[id]!.attempt,
            ),
          },
          undefined,
          localExecutables,
        );
      }
      pending.phase = "compiled";
      save();
    }
    if (args.cancelled()) throw new Error("Objective cancelled");
    if (stopped()) return false;
    stage = "validation";
    validateAmendment(state, pending.graph!, config, args.body);
    if (args.cancelled()) throw new Error("Objective cancelled");
    if (pending.phase === "compiled") {
      stage = "review";
      const sources = planningSources(
        args.body,
        state.baseSha,
        config.checkout,
        state.additionalSources,
      );
      const packet = planReviewPacket(
        args.body,
        state.baseSha,
        sources,
        pending.graph!,
        config.checkout,
        choices,
        undefined,
        localExecutables,
      );
      packet.amendment = {
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
      const evidence = reviewPacket([], planningReviewEvidence(packet));
      pending.phase = "reviewing";
      save();
      const response = await args.model.reviewGraph({
        ...packet,
        reviewPacket: evidence,
        invocation: {
          invocationId: randomUUID(),
          phase: "graph-review",
          ordinal: consumption.planningRevisions,
          observe: args.diagnostics?.modelObserver({
            scopeId: pending.id,
            runId: state.runId,
          }),
        },
      });
      pending.phase = "compiled";
      const findings = decodeGraphReview(response, evidence);
      if (findings.length)
        throw new Error(
          `Independent amendment review rejected: ${JSON.stringify(findings)}`,
        );
      pending.reviewDigest = createHash("sha256")
        .update(JSON.stringify({ packet, findings }))
        .digest("hex");
      pending.phase = "reviewed";
      save();
    }
    if (args.cancelled()) throw new Error("Objective cancelled");
    if (stopped()) return false;
    validateAmendment(state, pending.graph!, config, args.body);
    if (args.cancelled()) throw new Error("Objective cancelled");
    if (pending.phase === "reviewed") {
      stage = "projection";
      pending.phase = "projecting";
      save();
      const projected = await args.github.projectGraph({
        graph: pending.graph!,
        previousGraph: state.graph,
        objectiveIssue: state.objective,
        knownIssues: pending.issueByItemId,
        completedItems: Object.keys(state.work).filter(
          (id) => state.work[id]!.status === "done",
        ),
        beforeCreate: (id) => {
          if (args.cancelled()) throw new Error("Objective cancelled");
          pending.projectionPending = id;
          save();
        },
        projected: (id, issue) => {
          pending.issueByItemId[id] = issue;
          if (pending.projectionPending === id)
            delete pending.projectionPending;
          save();
        },
      });
      pending.issueByItemId = projected.issueByItemId;
      pending.phase = "projected";
      save();
    }
    if (args.cancelled()) throw new Error("Objective cancelled");
    if (stopped()) return false;
    validateAmendment(state, pending.graph!, config, args.body);
    const proposalReceipt = structuredClone(pending.proposal);
    delete proposalReceipt.graph;
    state.graphRevisions.push({
      graph: structuredClone(pending.graph!),
      digest: graphDigest(pending.graph!),
      parentDigest: graphDigest(state.graph),
      proposal: proposalReceipt,
      reviewDigest: pending.reviewDigest!,
      acceptedAt: new Date().toISOString(),
    });
    state.graph = pending.graph!;
    state.issueByItemId = pending.issueByItemId;
    for (const item of state.graph.items)
      state.work[item.id] ??= { status: "pending" };
    if (pending.proposal.worker)
      state.work[pending.proposal.worker.itemId]!.discoveryDisposition =
        "accepted";
    delete state.pendingAmendment;
    delete state.error;
    save();
    return true;
  } catch (error) {
    if (
      !["compiling", "reviewing", "projecting"].includes(pending.phase) ||
      error instanceof CompletedModelInvocationError ||
      (pending.phase === "compiling" && compilationResponseObserved)
    ) {
      pending.rejectionStage = stage;
      pending.phase = "rejected";
    }
    pending.error = error instanceof Error ? error.message : String(error);
    if (state.coordinator) {
      state.coordinator.mode = "paused";
      state.coordinator.waitReason = pending.error;
    }
    save();
    throw error;
  }
}
