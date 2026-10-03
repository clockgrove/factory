import { createHash } from "node:crypto";
import { graphDigest, amendmentBlocksDispatch } from "./graph-amendments.js";
import { assertCompletedCoverage, objectiveCandidate } from "./qa.js";
import type { GitHubGateway } from "./contracts.js";
import type { FactoryState } from "./state.js";

/** Compact bindings into the existing snapshot, not a second copy of its evidence. */
export interface FinalAcceptance {
  /** Historical delivered seals predate this field; new seals always bind it. */
  candidateBasis?: "pinned-baseline" | "current-graph-integration";
  sealedAt: string;
  graphDigest: string;
  configDigest: string;
  commit: string;
  tree: string;
  evidenceDigest: string;
  usage: { availability: "unavailable"; runId: string; source: "diagnostics" };
  resources: "owned-attempts-settled; controller-processes-stopped; evidence-retained";
}

function evidenceDigest(state: FactoryState): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        objectiveBodyDigest: state.objectiveBodyDigest,
        admissionDigest: state.admission?.digest,
        finalValidation: state.finalValidation,
        decisions: state.finalAcceptanceDecisions,
        work: state.graph.items.map(({ id }) => ({
          id,
          evidence: state.work[id],
        })),
      }),
    )
    .digest("hex");
}

export function assertTerminalEligibility(state: FactoryState): void {
  if (state.permanentAbandonment)
    throw new Error(
      "Objective was permanently abandoned; acceptance is forbidden",
    );
  const candidate = objectiveCandidate(state);
  if (
    !state.finalValidation?.passed ||
    !candidate ||
    state.cancelRequested ||
    state.cancelledAt ||
    state.error ||
    state.finalAcceptancePending ||
    amendmentBlocksDispatch(state) ||
    state.coordinator?.cancelError ||
    state.coordinator?.processes?.length ||
    state.coordinator?.phase === "objective-review-submitted"
  )
    throw new Error("Objective terminal eligibility is unresolved");
  for (const work of Object.values(state.work)) {
    if (
      work.status === "running" ||
      work.pendingEffect ||
      (work.discovery?.scope === "in-scope" &&
        work.discoveryDisposition !== "accepted")
    )
      throw new Error(
        "Owned attempt, submitted effect or discovery remains unresolved",
      );
  }
  for (const item of state.graph.items) {
    const work = state.work[item.id];
    if (
      work?.status !== "done" ||
      work.githubClosure !== "complete" ||
      !work.validation ||
      work.validation.treeSha !== work.treeSha ||
      !work.changeRef ||
      !work.treeSha ||
      work.acceptancePending
    )
      throw new Error(
        `Required Work Item ${item.id} is not accepted and closed`,
      );
  }
  for (const [validation, decisions] of [
    [state.finalValidation, state.finalAcceptanceDecisions],
    ...state.graph.items.map(
      ({ id }) =>
        [
          state.work[id]!.validation,
          state.work[id]!.acceptanceDecisions,
        ] as const,
    ),
  ] as const) {
    if (
      !validation ||
      validation.commands.some(
        (command) => !command.passed || command.treeSha !== validation.treeSha,
      )
    )
      throw new Error(
        "Acceptance has missing or failed exact-tree command evidence",
      );
    for (const criterion of validation.criteria ?? [])
      if (
        criterion.verdict === "human-accept" &&
        !decisions?.some(
          (decision) =>
            decision.criterion === criterion.criterion &&
            decision.treeSha === validation.treeSha &&
            decision.outcome === "accept",
        )
      )
        throw new Error("Human-owned acceptance lacks an exact-tree decision");
  }
  assertCompletedCoverage(state);
}

export function assertFinalAcceptance(state: FactoryState): void {
  const seal = state.finalAcceptance;
  if (!seal) return; // Historical snapshots remain readable without invented evidence.
  assertTerminalEligibility(state);
  const candidate = objectiveCandidate(state)!;
  if (
    !Number.isFinite(Date.parse(seal.sealedAt)) ||
    seal.graphDigest !== graphDigest(state.graph) ||
    seal.configDigest !== state.configDigest ||
    (seal.candidateBasis !== undefined &&
      seal.candidateBasis !== candidate.basis) ||
    (candidate.basis === "pinned-baseline" &&
      seal.candidateBasis !== candidate.basis) ||
    seal.commit !== candidate.commitSha ||
    seal.tree !== state.finalValidation?.treeSha ||
    seal.evidenceDigest !== evidenceDigest(state) ||
    seal.usage?.availability !== "unavailable" ||
    seal.usage.runId !== state.runId ||
    seal.usage.source !== "diagnostics" ||
    seal.resources !==
      "owned-attempts-settled; controller-processes-stopped; evidence-retained"
  )
    throw new Error(
      "Final acceptance binding differs from its sealed candidate or evidence",
    );
}

export function sealFinalAcceptance(state: FactoryState): void {
  assertTerminalEligibility(state);
  if (state.finalAcceptance) {
    assertFinalAcceptance(state);
    return;
  }
  state.finalAcceptance = {
    candidateBasis: objectiveCandidate(state)!.basis,
    sealedAt: new Date().toISOString(),
    graphDigest: graphDigest(state.graph),
    configDigest: state.configDigest,
    commit: objectiveCandidate(state)!.commitSha,
    tree: state.finalValidation!.treeSha,
    evidenceDigest: evidenceDigest(state),
    // Diagnostic accounting is observational; no complete total is invented here.
    usage: {
      availability: "unavailable",
      runId: state.runId,
      source: "diagnostics",
    },
    resources:
      "owned-attempts-settled; controller-processes-stopped; evidence-retained",
  };
}

export function objectiveComplete(state: FactoryState): boolean {
  if (!state.finalValidation?.passed || state.objectiveClosure !== "complete")
    return false;
  try {
    assertTerminalEligibility(state);
    assertFinalAcceptance(state);
    return true;
  } catch {
    return false;
  }
}

export class GitHubClosureFailure extends Error {}

export async function closeWorkItem(
  state: FactoryState,
  itemId: string,
  github: GitHubGateway,
  save: () => void,
  native: boolean,
): Promise<void> {
  const work = state.work[itemId]!;
  if (work.githubClosure === "complete") return;
  if (
    state.graph.items.find((item) => item.id === itemId)?.kind === "qa" ||
    state.graph.items.find((item) => item.id === itemId)?.kind === "aggregate"
  ) {
    if (
      work.status !== "done" ||
      !work.changeRef ||
      !work.treeSha ||
      !work.validation ||
      work.validation.treeSha !== work.treeSha ||
      !state.issueByItemId[itemId] ||
      work.pullRequest ||
      work.execution
    )
      throw new Error(`Completed QA ${itemId} lacks read-only proof identity`);
    work.githubClosure = "pending";
    save();
    try {
      await github.closeIssue(
        state.issueByItemId[itemId]!,
        `QA completed at commit ${work.changeRef}; validated tree ${work.treeSha}.`,
        { workItem: { objective: state.objective, id: itemId } },
      );
      work.githubClosure = "complete";
      delete work.error;
      delete state.githubClosureError;
      save();
      return;
    } catch (error) {
      state.githubClosureError = `QA ${itemId}: ${error instanceof Error ? error.message : String(error)}`;
      save();
      throw new GitHubClosureFailure(state.githubClosureError);
    }
  }
  if (
    work.status !== "done" ||
    !work.pullRequest ||
    !work.changeRef ||
    !work.treeSha ||
    !state.issueByItemId[itemId]
  )
    throw new Error(`Completed Work Item ${itemId} lacks delivery identity`);
  try {
    const observed = await github.observe({
      number: work.pullRequest,
      branch: `factory/objective-${state.objective}/${itemId}`,
      headSha: work.changeRef,
    });
    if (observed.state !== "merged")
      throw new Error(
        `PR #${work.pullRequest} is not merged; operator direction required`,
      );
    work.githubClosure = "pending";
    save();
    const comment = native
      ? `Completed by native delivery PR #${work.pullRequest}; integrated at ${work.integratedSha ?? state.integratedSha}.`
      : `Completed by PR #${work.pullRequest}; validated tree ${work.treeSha}.`;
    await github.closeIssue(state.issueByItemId[itemId]!, comment, {
      workItem: { objective: state.objective, id: itemId },
    });
    work.githubClosure = "complete";
    delete work.error;
    delete state.githubClosureError;
    save();
  } catch (error) {
    state.githubClosureError = `Work Item ${itemId}: ${error instanceof Error ? error.message : String(error)}`;
    save();
    throw new GitHubClosureFailure(state.githubClosureError);
  }
}

export async function closeObjectiveIssue(
  state: FactoryState,
  body: string,
  github: GitHubGateway,
  save: () => void,
): Promise<void> {
  if (state.objectiveClosure === "complete") return;
  sealFinalAcceptance(state);
  try {
    state.objectiveClosure = "pending";
    save();
    await github.closeIssue(
      state.objective,
      `Factory completed ${state.graph.items.length} Work Items; final validation passed at ${objectiveCandidate(state)!.commitSha} (${objectiveCandidate(state)!.basis}).`,
      { body },
    );
    state.objectiveClosure = "complete";
    delete state.githubClosureError;
    save();
  } catch (error) {
    state.githubClosureError = `Objective #${state.objective}: ${error instanceof Error ? error.message : String(error)}`;
    save();
    throw new GitHubClosureFailure(state.githubClosureError);
  }
}
