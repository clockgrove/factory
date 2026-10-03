import { workspacePackageAdditions } from "./workspace-membership.js";
import { graphDigest } from "./graph-amendments.js";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { planningSources } from "./compiler.js";
import { closeWorkItem } from "./completion.js";
import type { FactoryConfig } from "./config.js";
import type {
  ContentStore,
  GitHubGateway,
  PlanningModel,
  WorkItem,
} from "./contracts.js";
import { CompletedModelInvocationError } from "./contracts.js";
import { repeatInterrupted } from "./work-repair.js";
import type { DiagnosticEmitter } from "./diagnostics.js";
import { validationLfsMembersForItem } from "./media.js";
import type { PhaseAdmission } from "./phase-admission.js";
import { gitAsync } from "./process.js";
import { itemCoverage, objectiveCandidate } from "./qa.js";
import type { FactoryState } from "./state.js";
import {
  AcceptanceDecisionRequired,
  reviewAcceptance,
  validateWorkItem,
  workItemReviewEvidence,
  workItemReviewObservations,
} from "./validation.js";

/** Run only source-authorized readiness probes before spending a worker call. */
export async function preflightItemEnvironment(args: {
  config: FactoryConfig;
  root: string;
  state: FactoryState;
  item: WorkItem;
  baseSha: string;
  objectiveBody?: string;
  store?: ContentStore;
}): Promise<void> {
  const entries = itemCoverage(args.state.graph, args.item.id);
  const probes = new Set(
    entries.map((entry) => entry.environment.probe).filter(Boolean),
  );
  if (!probes.size) return;
  for (const entry of entries) {
    const preparedBy = entry.environment.preparedBy;
    if (preparedBy && args.state.work[preparedBy]?.status !== "done")
      throw new Error("Required environment preparation is not complete");
  }
  const commands = args.item.validation.filter((check) =>
    probes.has(check.command),
  );
  await validateWorkItem(
    args.config.checkout,
    join(args.root, "environment-preflight"),
    { ...args.item, validation: commands },
    args.baseSha,
    await gitAsync(args.config.checkout, "rev-parse", `${args.baseSha}^{tree}`),
    args.state.baseSha,
    undefined,
    undefined,
    args.baseSha,
    validationLfsMembersForItem(
      args.state,
      args.item,
      args.config.checkout,
      args.baseSha,
    ),
    args.store,
    workspacePackageAdditions(args.objectiveBody ?? ""),
  );
}

/** A proof node uses ordinary WorkState and validation, never a fabricated worker or PR. */
export async function runQaItem(args: {
  config: FactoryConfig;
  root: string;
  state: FactoryState;
  item: WorkItem;
  github: GitHubGateway;
  model: PlanningModel;
  objectiveBody: string;
  store: ContentStore;
  save: () => void;
  cancelled: () => boolean;
  paused?: () => boolean;
  diagnostics?: DiagnosticEmitter;
  phases?: PhaseAdmission;
}): Promise<void> {
  const { state, item, save } = args;
  const work = state.work[item.id]!;
  const readinessWasWaiting = Boolean(work.waitingReason);
  const retainPausedWait = (): boolean => {
    if (!readinessWasWaiting || !args.paused?.()) return false;
    work.waitingReason ??= "Awaiting exact named CI before continuing QA";
    args.phases?.release(item.id);
    save();
    return true;
  };
  try {
    // A lost review or GitHub response repeats the QA step (bounded).
    await repeatInterrupted(work, save, async () => {
      const candidate = objectiveCandidate(state);
      if (
        (item.kind !== "qa" && item.kind !== "aggregate") ||
        !item.dependencies.every(
          (id) =>
            state.work[id]?.status === "done" &&
            (state.work[id]?.integratedSha ||
              (candidate?.basis === "pinned-baseline" &&
                state.work[id]?.changeRef === candidate.commitSha)),
        )
      )
        throw new Error("QA cannot run before actual dependency integration");
      if (!candidate) throw new Error("QA has no integrated candidate");
      if (args.cancelled()) throw new Error("Objective cancelled");
      const commit = candidate.commitSha;
      if (candidate.basis === "pinned-baseline") {
        await gitAsync(
          args.config.checkout,
          "fetch",
          "origin",
          await args.github.defaultBranch(),
        );
        if (
          (await gitAsync(args.config.checkout, "rev-parse", "FETCH_HEAD")) !==
          commit
        )
          throw new Error("Default branch changed before pinned-baseline QA");
      }
      if (work.waitingReason && work.changeRef !== commit)
        throw new Error("QA candidate changed while awaiting exact named CI");
      work.status = "running";
      work.step = "validate";
      work.attempt ??= randomUUID();
      work.graphRevisionDigest ??= graphDigest(state.graph);
      work.startedAt ??= new Date().toISOString();
      work.baseSha = commit;
      work.executionBaseSha = commit;
      work.changeRef = commit;
      work.treeSha = await gitAsync(
        args.config.checkout,
        "rev-parse",
        `${commit}^{tree}`,
      );
      save();
      work.qaChecks = [];
      for (const entry of itemCoverage(state.graph, item.id).filter(
        (entry) =>
          entry.proof.kind === "integrated-ci" ||
          entry.proof.kind === "published-ci",
      )) {
        const proof = entry.proof;
        if (proof.kind !== "integrated-ci" && proof.kind !== "published-ci")
          continue;
        const target =
          proof.kind === "published-ci" ? state.work[proof.targetItem] : work;
        if (
          !target?.changeRef ||
          (proof.kind === "published-ci" && !target.pullRequest)
        )
          throw new Error("Required CI candidate has not been published");
        if (!args.github.namedCheck)
          throw new Error("Authenticated named CI observation is unavailable");
        const check = await args.github.namedCheck(
          target.changeRef,
          proof.checkName,
        );
        if (
          !check ||
          (check.status !== "completed" &&
            check.name === proof.checkName &&
            check.headSha === target.changeRef &&
            Number.isSafeInteger(check.id) &&
            check.id > 0)
        ) {
          work.waitingReason = `Awaiting named CI check ${proof.checkName} at ${target.changeRef}`;
          args.phases?.release(item.id);
          save();
          return;
        }
        if (
          check.name !== proof.checkName ||
          check.headSha !== target.changeRef ||
          !Number.isSafeInteger(check.id) ||
          check.id <= 0 ||
          check.status !== "completed" ||
          check.conclusion !== "success"
        )
          throw new Error(
            `Required named CI check ${proof.checkName} is stale, invalid, or failing at ${target.changeRef}`,
          );
        if (retainPausedWait()) return;
        work.qaChecks.push(check);
        save();
      }
      await args.phases?.reserve(item.id, "validation");
      if (retainPausedWait()) return;
      await preflightItemEnvironment({ ...args, baseSha: commit });
      if (retainPausedWait()) return;
      work.validation = await validateWorkItem(
        args.config.checkout,
        join(args.root, "validation"),
        item,
        commit,
        work.treeSha,
        state.baseSha,
        undefined,
        undefined,
        commit,
        validationLfsMembersForItem(state, item, args.config.checkout, commit),
        args.store,
        workspacePackageAdditions(args.objectiveBody),
      );
      if (args.cancelled()) throw new Error("Objective cancelled");
      if (retainPausedWait()) return;
      await args.phases?.reserve(item.id, "review");
      if (retainPausedWait()) return;
      delete work.waitingReason;
      work.validation = await reviewAcceptance({
        model: args.model,
        invocation: {
          invocationId: randomUUID(),
          phase: "result-review",
          ordinal: 0,
          observe: args.diagnostics?.modelObserver({
            scopeId: work.attempt!,
            runId: state.runId,
            itemId: item.id,
            attemptId: work.attempt,
          }),
        },
        checkout: args.config.checkout,
        baseSha: state.baseSha,
        commit,
        evidence: work.validation,
        criteria: item.acceptance,
        sources: planningSources(
          args.objectiveBody,
          state.baseSha,
          args.config.checkout,
        ),
        decisions: work.acceptanceDecisions,
        observations: workItemReviewObservations(state, item, {
          kind: "read-only-proof",
        }),
        evidenceSources: [
          ...workItemReviewEvidence({
            state,
            item,
            checkout: args.config.checkout,
            delivery: args.config.delivery.kind,
          }),
          {
            path: "Authenticated named CI checks",
            content: JSON.stringify(work.qaChecks),
          },
        ],
      });
      if (args.cancelled()) throw new Error("Objective cancelled");
      delete work.acceptancePending;
      if (candidate.basis === "current-graph-integration")
        work.integratedSha = commit;
      work.status = "done";
      work.completedAt = new Date().toISOString();
      delete work.step;
      save();
      args.phases?.release(item.id);
      await closeWorkItem(state, item.id, args.github, save, false);
    });
  } catch (error) {
    if (error instanceof AcceptanceDecisionRequired) {
      args.phases?.release(item.id);
      work.status = "waiting";
      work.step = "approve-result";
      work.acceptancePending = error.pending;
      save();
      return;
    }
    args.phases?.release(item.id);
    if (work.status !== "done") work.status = "failed";
    work.error = error instanceof Error ? error.message : String(error);
    save();
    throw error;
  }
}
