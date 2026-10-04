import {
  allowanceAvailable,
  allowanceKey,
  assertRepairClass,
  charge,
  chargeRepair,
  consumption,
  failureDigest,
  objectiveEvent,
  type RepairCorrection,
} from "./repair-policy.js";
import { preflightObjective } from "./local-preflight.js";
import { planningPrerequisites } from "./objective-prerequisites.js";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  commandAuthority,
  compileObjective,
  paidModel,
  finalObjectiveCommands,
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
import { attachedFault, attachFault, decision, StepFault } from "./fault.js";
import { step, type StepOptions } from "./step.js";
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
  /** Explicit disposition of a known generated amendment rejection, never an effect replay. */
  replacement?: { amendmentId: string; correction: RepairCorrection };
}
export interface PendingAmendment {
  id: string;
  proposal: AmendmentProposal;
  /** Last completed phase; a restart repeats the next call. */
  phase:
    | "ready"
    | "compiled"
    | "reviewed"
    | "projected"
    | "rejected"
    | "backlog";
  graph?: WorkGraph;
  reviewDigest?: string;
  issueByItemId: Record<string, number>;
  error?: string;
  rejectionStage?:
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

/** Validate the immutable succession, never rewrite the initial graph digest. */
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
      ![
        "ready",
        "compiled",
        "reviewed",
        "projected",
        "rejected",
        "backlog",
      ].includes(pending.phase) ||
      pending.proposal.expectedGraphDigest !== graphDigest(state.graph)
    )
      throw new Error("Pending amendment has stale graph identity");
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
  // Each started amendment was charged once, by its own id.
  const started = [
    ...(state.rejectedAmendments ?? []),
    ...(pending && !["ready", "backlog"].includes(pending.phase)
      ? [pending]
      : []),
  ];
  const charged = Object.keys(state.charges ?? {}).filter((event) =>
    event.startsWith(objectiveEvent("amend", "")),
  ).length;
  if (
    started.some((entry) => !state.charges?.[amendmentEvent(entry)]) ||
    (revisions?.length ?? 1) - 1 + started.length > charged
  )
    throw new Error(
      "Known amendment attempts exceed retained planning charges",
    );
}

/** The failure event an amendment is charged under: one plan revision per amendment. */
const amendmentEvent = (pending: PendingAmendment): string =>
  objectiveEvent("amend", pending.id);

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
    state.cancelRequested ||
    state.cancelledAt ||
    state.finalValidation?.passed
  )
    throw new Error("Amendment requires a nonterminal Objective");
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
    (rejected.rejectionStage !== undefined
      ? ![
          "compilation",
          "validation",
          "review-findings",
          "projection",
        ].includes(rejected.rejectionStage)
      : !!rejected.graph) ||
    (rejected.rejectionStage === "review-findings" && !rejected.graph) ||
    // A projection rejection follows a passed review: graph and digest.
    (rejected.rejectionStage === "projection" &&
      (!rejected.graph || rejected.reviewDigest === undefined)) ||
    // A rejection after review may have projected issues; the replacement
    // finds them again by marker.
    (rejected.rejectionStage !== "projection" &&
      (rejected.reviewDigest !== undefined ||
        !isDeepStrictEqual(rejected.issueByItemId, state.issueByItemId)))
  )
    throw new Error(
      "Replacement requires a known generated amendment rejection",
    );
  if (
    state.coordinator?.mode !== "paused" ||
    state.coordinator.cancelError ||
    state.coordinator.processes?.length ||
    (state.error !== undefined && state.error !== rejected.error) ||
    Object.values(state.work).some(
      (work) =>
        work.status === "running" ||
        work.status === "published" ||
        (work.execution && work.status !== "done" && work.step === "execute"),
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
  // The replacement is charged when it starts; it must fit now.
  assertRepairClass(state, correction.kind);
  if (
    !allowanceAvailable(
      state,
      objectiveEvent("amend", "replacement"),
      allowanceKey(correction.kind),
      ["$planning"],
    )
  )
    throw new Error("Objective planningRevisions allowance exhausted");
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

export function amendmentBlocksDispatch(state: FactoryState): boolean {
  return (
    (!!state.pendingAmendment && state.pendingAmendment.phase !== "backlog") ||
    Object.values(state.work).some(
      (work) =>
        work.discovery?.scope === "in-scope" && !work.discoveryDisposition,
    )
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
    commandAuthority(graph, sources, body, state.baseSha, config.checkout),
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
    (context) =>
      advanceAmendment({ ...rest, model: paidModel(args.model, context) }),
    { save: args.save, signal, pause, clock },
  );
}

/** One compile, review and projection pass from the last completed phase. */
async function advanceAmendment(args: {
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
      (work) => work.status === "running" || work.status === "published",
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
  state.graphRevisions ??= [
    { graph: structuredClone(state.graph), digest: graphDigest(state.graph) },
  ];
  let compilationResponseObserved = false;
  let calling: "compile" | "review" | "projection" | undefined;
  let stage: NonNullable<PendingAmendment["rejectionStage"]> = "compilation";
  /** The operator cancelled: stop quietly at this safe point. */
  const stopIfCancelled = () => {
    if (args.cancelled())
      throw new StepFault({ kind: "cancelled", detail: "Objective cancelled" });
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
     * and the amendment waits at its phase (contract 2).
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
      // Reobserve the original sources; retain only the activation digest,
      // never a duplicate predecessor projection.
      const current = await observePrerequisites();
      const observed = current
        ? createHash("sha256").update(JSON.stringify(current)).digest("hex")
        : undefined;
      if (
        observed !== state.prerequisitesDigest ||
        !isDeepStrictEqual(current, prerequisites)
      )
        // The predecessor's evidence changed: the operator decides, and the
        // amendment waits at its phase (contract 2); nothing is refused.
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
        );
        normalizeExecutionProfiles(pending.graph, choices);
      } else {
        calling = "compile";
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
          },
          prerequisites,
          localExecutables,
          { configuredConcurrency: state.capacity.concurrency },
        );
      }
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
      calling = "review";
      const response = await args.model.reviewGraph({
        ...packet,
        reviewPacket: evidence,
        invocation: {
          invocationId: randomUUID(),
          phase: "graph-review",
          ordinal,
          observe: args.diagnostics?.modelObserver({
            scopeId: pending.id,
            runId: state.runId,
          }),
        },
      });
      calling = undefined;
      // An answer that does not decode refuses the amendment like findings.
      let findings: ReturnType<typeof decodeGraphReview>;
      try {
        findings = decodeGraphReview(response, evidence);
      } catch (error) {
        throw error instanceof Error ? refused(error) : error;
      }
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
      // Projection finds existing issues by marker, so repeating it is safe.
      const projected = await args.github.projectGraph({
        graph: pending.graph!,
        previousGraph: state.graph,
        objectiveIssue: state.objective,
        knownIssues: pending.issueByItemId,
        author: state.issueAuthor,
        authored: (login) => {
          state.issueAuthor = login;
          save();
        },
        completedItems: Object.keys(state.work).filter(
          (id) => state.work[id]!.status === "done",
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
    // Only a refused result (a `work` fault) or an answered model output
    // rejects the amendment. Anything else leaves it at its last completed
    // phase: the step repeats a transient fault, waits on a decision or a
    // configuration fix, and stops on cancellation or a defect.
    // A compiled graph that fails Factory's checks is an answered,
    // refused result even before it carries a fault.
    const fault = attachedFault(error);
    const refusedResult =
      fault?.kind === "work" ||
      (!fault && calling === "compile" && compilationResponseObserved);
    if (!refusedResult) throw error;
    pending.rejectionStage = stage;
    pending.phase = "rejected";
    pending.error = error instanceof Error ? error.message : String(error);
    if (state.coordinator) {
      state.coordinator.mode = "paused";
      state.coordinator.waitReason = pending.error;
    }
    save();
    // The amendment's result is refused, whatever the call reported.
    throw attachFault(new Error(pending.error, { cause: error }), {
      kind: "work",
      evidence: { detail: pending.error || "Amendment rejected" },
    });
  }
}
