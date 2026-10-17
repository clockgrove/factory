import { assertSkippedWork, assertWorkRoutingState } from "./runner/routing.js";
import { createHash } from "node:crypto";
import {
  graphDigest,
  amendmentBlocksDispatch,
  assertWorkerDiscoveryDisposition,
} from "./graph-amendments.js";
import { assertCompletedCoverage, objectiveCandidate } from "./qa.js";
import { assertApprovedPlaybookAdmission } from "./contracts.js";
import type { GitHubGateway } from "./contracts.js";
import {
  isExecutionState,
  assertWorkDiscoveryOutput,
  type ContinuationState,
  type FactoryState,
} from "./state.js";
import { attachFault, decision } from "./fault.js";
import { step } from "./step.js";
import {
  type AccountingSeal,
  assertAccountingSeal,
  assertAccountingSealBinding,
  buildAccountingSeal,
} from "./accounting.js";
import {
  deliveredHead,
  deliveryEarlierHeads,
} from "./delivery/branch-update.js";

/** Compact bindings into the existing snapshot, not a second copy of its evidence. */
export interface FinalAcceptance {
  candidateBasis: "pinned-baseline" | "current-graph-integration";
  sealedAt: string;
  graphDigest: string;
  configDigest: string;
  commit: string;
  tree: string;
  evidenceDigest: string;
  usage: {
    availability: "observed" | "unavailable";
    runId: string;
    source: "durable-accounting";
    accounting: AccountingSeal;
  };
  resources: "owned-attempts-settled; controller-processes-stopped; evidence-retained";
}

function evidenceDigest(state: FactoryState): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        objectiveBodyDigest: state.objectiveBodyDigest,
        ...(state.approvedPlaybookAdmission
          ? {
              approvedPlaybookAdmission: state.approvedPlaybookAdmission,
              approvedPlaybookPin: state.approvedPlaybookPin,
            }
          : {}),
        ...(state.prerequisites
          ? {
              nativePrerequisites: {
                digest: state.prerequisitesDigest,
                facts: state.prerequisites,
              },
            }
          : {}),
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
  assertApprovedPlaybookAdmission(
    state.approvedPlaybookPin,
    state.approvedPlaybookAdmission,
    state.configDigest,
    state.planGraphDigest,
    Object.hasOwn(state, "approvedPlaybookPin"),
  );
  assertWorkRoutingState(state);
  const candidate = objectiveCandidate(state);
  if (
    !state.finalValidation?.passed ||
    !candidate ||
    state.cancelRequested ||
    state.cancelledAt ||
    state.error ||
    state.finalAcceptancePending ||
    amendmentBlocksDispatch(state) ||
    // An unsealed Objective needs every controller subprocess stopped. After
    // the seal, recorded processes (a crash between comment and close) are
    // orphan-cleanup bookkeeping, not evidence: the restart closes it.
    (!state.finalAcceptance &&
      (state.coordinator?.cancelError || state.coordinator?.processes?.length))
  )
    throw new Error("Objective terminal eligibility is unresolved");
  for (const [id, work] of Object.entries(state.work)) {
    assertWorkerDiscoveryDisposition(state, id, work);
    if (
      work.status === "running" ||
      (work.discovery?.scope === "in-scope" &&
        work.discoveryDisposition !== "accepted" &&
        work.discoveryDisposition !== "declined")
    )
      throw new Error(
        "Owned attempt, submitted effect or discovery remains unresolved",
      );
  }
  for (const item of state.graph.items) {
    const work = state.work[item.id];
    if (work?.status === "skipped") {
      assertSkippedWork(state, item.id);
      if (work.githubClosure !== "complete")
        throw new Error(`Skipped Work Item ${item.id} is not closed`);
      continue;
    }
    if (item.kind === "discovery") {
      assertWorkDiscoveryOutput(state, item.id, work!);
      if (
        work?.status !== "done" ||
        work.githubClosure !== "complete" ||
        work.execution ||
        !work.discoveryOutput ||
        work.discoveryOutput.status !== "complete"
      )
        throw new Error(
          `Required discovery Work Item ${item.id} is not complete and closed`,
        );
      continue;
    }
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
    ...state.graph.items
      .filter(
        (item) =>
          item.kind !== "discovery" &&
          state.work[item.id]?.status !== "skipped",
      )
      .map(
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

/** Charge identities come from the retained execution attempts, not observations. */
function chargedWorkAttemptIds(state: FactoryState): string[] {
  return [
    ...new Set(
      Object.values(state.work).flatMap((work) =>
        [
          work,
          ...(work.recovery?.history ?? []).map((entry) => entry.work),
        ].flatMap((attempt) => (attempt.attempt ? [attempt.attempt] : [])),
      ),
    ),
  ].sort();
}

export function assertFinalAcceptance(
  state: FactoryState,
  options: { verifyAccountingBodies?: boolean } = {},
): void {
  const seal = state.finalAcceptance;
  if (!seal) return; // Not sealed yet: there is no final acceptance to verify.
  assertTerminalEligibility(state);
  const candidate = objectiveCandidate(state)!;
  if (
    !Number.isFinite(Date.parse(seal.sealedAt)) ||
    seal.graphDigest !== graphDigest(state.graph) ||
    seal.configDigest !== state.configDigest ||
    seal.candidateBasis !== candidate.basis ||
    seal.commit !== candidate.commitSha ||
    seal.tree !== state.finalValidation?.treeSha ||
    seal.evidenceDigest !== evidenceDigest(state) ||
    seal.usage?.runId !== state.runId ||
    seal.resources !==
      "owned-attempts-settled; controller-processes-stopped; evidence-retained"
  )
    throw new Error(
      "Final acceptance binding differs from its sealed candidate or evidence",
    );
  if (seal.usage.source !== "durable-accounting")
    throw new Error("Final accounting source is invalid");
  assertAccountingSealBinding(
    state.repository,
    state.objective,
    state.runId,
    seal.usage.accounting,
  );
  if (
    JSON.stringify(seal.usage.accounting.chargedWorkAttempts) !==
    JSON.stringify(chargedWorkAttemptIds(state))
  )
    throw new Error("Final accounting omits retained charged attempts");
  if (
    seal.usage.availability !==
    (seal.usage.accounting.records.length ? "observed" : "unavailable")
  )
    throw new Error("Final accounting availability differs from its originals");
  if (options.verifyAccountingBodies !== false)
    assertAccountingSeal(
      state.repository,
      state.objective,
      state.runId,
      seal.usage.accounting,
    );
}

export function sealFinalAcceptance(state: FactoryState): void {
  assertTerminalEligibility(state);
  if (state.finalAcceptance) {
    assertFinalAcceptance(state);
    return;
  }
  const accounting = buildAccountingSeal(
    state.repository,
    state.objective,
    state.runId,
    chargedWorkAttemptIds(state),
  );
  assertAccountingSeal(
    state.repository,
    state.objective,
    state.runId,
    accounting,
  );
  state.finalAcceptance = {
    candidateBasis: objectiveCandidate(state)!.basis,
    sealedAt: new Date().toISOString(),
    graphDigest: graphDigest(state.graph),
    configDigest: state.configDigest,
    commit: objectiveCandidate(state)!.commitSha,
    tree: state.finalValidation!.treeSha,
    evidenceDigest: evidenceDigest(state),
    // Observed categories and missing coverage remain separate from acceptance.
    usage: {
      availability: accounting.records.length ? "observed" : "unavailable",
      runId: state.runId,
      source: "durable-accounting",
      accounting,
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

/**
 * Close a delivered Work Item's issue. The completion comment carries a
 * marker the gateway checks before posting, and the close is idempotent, so
 * the step repeats it from the top after a lost response.
 */
export async function closeWorkItem(
  state: FactoryState,
  itemId: string,
  github: GitHubGateway,
  save: () => void,
  native: boolean,
  signal?: AbortSignal,
  pause?: AbortSignal,
): Promise<void> {
  const work = state.work[itemId]!;
  if (work.githubClosure === "complete") return;
  const kind = state.graph.items.find((item) => item.id === itemId)?.kind;
  const discovery = kind === "discovery";
  const skipped = work.status === "skipped";
  if (skipped) {
    assertWorkRoutingState(state);
    assertSkippedWork(state, itemId);
    if (!state.issueByItemId[itemId])
      throw new Error("Skipped branch lacks its projected issue identity");
  }
  const readOnly =
    skipped || discovery || kind === "qa" || kind === "aggregate";
  if (discovery) {
    assertWorkDiscoveryOutput(state, itemId, work);
    if (
      work.status !== "done" ||
      !work.discoveryOutput ||
      work.discoveryOutput.status !== "complete" ||
      !state.issueByItemId[itemId] ||
      work.pullRequest ||
      work.execution
    )
      throw new Error(
        `Completed discovery ${itemId} lacks complete immutable output`,
      );
  }
  if (readOnly && !discovery && !skipped) {
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
  } else if (
    !discovery &&
    !skipped &&
    (work.status !== "done" ||
      !work.pullRequest ||
      !work.changeRef ||
      !work.treeSha ||
      !state.issueByItemId[itemId])
  )
    throw new Error(`Completed Work Item ${itemId} lacks delivery identity`);
  const comment = skipped
    ? `Branch skipped by declared condition ${work.routing!.conditionId}; authenticated condition packet ${state.conditionFacts![work.routing!.conditionId]!.resultDigest} did not select this branch (predicate=${state.conditionFacts![work.routing!.conditionId]!.inputPacket.value}, required=${work.routing!.when}). No implementation result was accepted for this Work Item.`
    : discovery
      ? `Discovery completed at source commit ${work.discoveryOutput!.source.commitSha}; retained ${work.discoveryOutput!.selectedEntries} observed entries as immutable output ${work.discoveryOutput!.body.digest}.`
      : readOnly
        ? `QA completed at commit ${work.changeRef}; validated tree ${work.treeSha}.`
        : native
          ? `Completed by native delivery PR #${work.pullRequest}; integrated at ${work.integratedSha ?? state.integratedSha}.`
          : `Completed by PR #${work.pullRequest}; validated tree ${work.treeSha}.`;
  await step(
    state,
    { scope: { item: itemId }, name: "close" },
    async () => {
      if (!readOnly) {
        const observed = await github.observe({
          number: work.pullRequest!,
          branch: `factory/objective-${state.objective}/${itemId}`,
          headSha: deliveredHead(work)!,
          earlierHeads: deliveryEarlierHeads(work),
        });
        if (observed.state !== "merged")
          throw attachFault(
            new Error(`PR #${work.pullRequest} is not merged`),
            decision(
              `PR #${work.pullRequest} is no longer merged. Inspect it, then factory retry --objective ${state.objective} --item ${itemId}; or factory cancel --objective ${state.objective}`,
            ),
          );
      }
      if (work.githubClosure !== "pending") {
        work.githubClosure = "pending";
        save();
      }
      await github.closeIssue(state.issueByItemId[itemId]!, comment, {
        workItem: { objective: state.objective, id: itemId },
        ...(skipped ? { reason: "not_planned" as const } : {}),
        ...(state.issueAuthor ? { author: state.issueAuthor } : {}),
      });
    },
    { save, signal, pause },
  );
  work.githubClosure = "complete";
  delete work.error;
  save();
}

/**
 * A cancelled Objective leaves no Work Item to do: close every Work Item issue
 * that did not complete as not planned. Repeats like closeWorkItem: the
 * gateway keys the closure to the issue's identity and posts its comment once.
 */
export async function closeCancelledWorkItems(
  state: ContinuationState,
  github: GitHubGateway,
): Promise<void> {
  for (const [itemId, number] of Object.entries(state.issueByItemId)) {
    if (
      isExecutionState(state) &&
      ["done", "skipped"].includes(state.work[itemId]?.status ?? "")
    )
      continue;
    await github.closeIssue(
      number,
      `Objective #${state.objective} was cancelled; this Work Item will not be done.`,
      {
        workItem: { objective: state.objective, id: itemId },
        reason: "not_planned",
        ...(state.issueAuthor ? { author: state.issueAuthor } : {}),
      },
    );
  }
}

/** Close the Objective issue once final acceptance is sealed; repeats like closeWorkItem. */
export async function closeObjectiveIssue(
  state: FactoryState,
  body: string,
  github: GitHubGateway,
  save: () => void,
  signal?: AbortSignal,
  pause?: AbortSignal,
): Promise<void> {
  if (state.objectiveClosure === "complete") return;
  sealFinalAcceptance(state);
  if (state.objectiveClosure !== "pending") {
    state.objectiveClosure = "pending";
    save();
  }
  const candidate = objectiveCandidate(state)!;
  await step(
    state,
    { scope: "objective", name: "close" },
    () =>
      github.closeIssue(
        state.objective,
        `Factory completed ${state.graph.items.filter((item) => state.work[item.id]?.status === "done").length} Work Items${state.graph.items.some((item) => state.work[item.id]?.status === "skipped") ? ` and skipped ${state.graph.items.filter((item) => state.work[item.id]?.status === "skipped").length} branches by authenticated declared conditions` : ""}; final validation passed at ${candidate.commitSha} (${candidate.basis}).`,
        { body, ...(state.issueAuthor ? { author: state.issueAuthor } : {}) },
      ),
    { save, signal, pause },
  );
  state.objectiveClosure = "complete";
  save();
}
