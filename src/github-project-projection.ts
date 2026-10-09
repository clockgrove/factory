import { randomUUID } from "node:crypto";
import type { FactoryConfig } from "./config.js";
import { factoryConfigDigest } from "./config.js";
import type { GitHubGateway } from "./contracts.js";
import { objectiveComplete } from "./completion.js";
import type { ProjectPhase } from "./github-project-state.js";
import type { ContinuationState } from "./state.js";
import { readContinuation } from "./state-store.js";
import { gitHubTransportOf } from "./github-client.js";

/** Derived presentation only; a Project card never grants lifecycle authority. */
export function projectPhase(state: ContinuationState): ProjectPhase {
  if (state.schemaVersion === 7 && objectiveComplete(state)) return "accepted";
  if (state.cancelRequested || state.cancelledAt || state.error)
    return "stopped";
  if (state.schemaVersion === 8) {
    if (state.plan?.review.status === "needs-human") return "needs-human";
    return state.coordinator.mode === "running" ? "planning" : "stopped";
  }
  if (
    state.finalAcceptancePending ||
    Object.values(state.work).some((work) => work.acceptancePending) ||
    state.pendingAmendment?.phase === "rejected"
  )
    return "needs-human";
  if (state.coordinator?.mode !== "running") return "stopped";
  if (
    state.finalAcceptance ||
    state.coordinator?.phase.includes("review") ||
    Object.values(state.work).some(
      (work) => work.status === "running" && work.step === "approve-result",
    )
  )
    return "review";
  return "running";
}

/** Same controlled checkpoint and atomic continuation as other projections. */
export async function projectGitHubProjectStatus(args: {
  config: FactoryConfig;
  objective: number;
  github: GitHubGateway;
  current: () => ContinuationState | undefined;
  save: () => void;
}): Promise<void> {
  const config = args.config.githubManagement?.projectStatus;
  if (!config) return;
  const retained = readContinuation(args.config.repository, args.objective);
  if (!retained) return;
  const live = () => {
    const state = args.current();
    if (
      !state ||
      state.runId !== retained.runId ||
      state.configDigest !== retained.configDigest ||
      factoryConfigDigest(args.config) !== retained.configDigest
    )
      throw new Error("Project projection snapshot or configuration changed");
    return state;
  };
  const phase = projectPhase(retained);
  const optionId = config.options[phase];
  const previous = retained.githubProjectStatus?.requests.at(-1);
  const pending =
    previous && !previous.response && !previous.notSent ? previous : undefined;
  // One exact later read is useful evidence. Further reads cannot settle the
  // original effect, so retain its timestamp and fence without polling forever.
  if (pending?.laterObservation) return;
  // Known completed writes coalesce time-only changes; unknown writes read only.
  const satisfaction = retained.githubProjectStatus?.observed;
  if (
    !pending &&
    (previous?.response?.optionId === optionId ||
      (satisfaction?.projectId === config.projectId &&
        satisfaction.fieldId === config.fieldId &&
        satisfaction.optionId === optionId))
  )
    return;
  const requestId = pending?.requestId ?? randomUUID();
  try {
    if (!args.github.projectStatus)
      throw new Error("GitHub Project status projection is unavailable");
    const important = ["accepted", "needs-human", "stopped"].includes(phase);
    if (
      !pending &&
      (retained.githubProjectStatus?.requests.length ?? 0) >=
        (important ? 64 : 62)
    ) {
      const state = live();
      state.githubProjectStatus ??= { requests: [] };
      state.githubProjectStatus.failure = "history-exhausted";
      args.save();
      return;
    }
    const observed = await args.github.projectStatus({
      objective: args.objective,
      runId: retained.runId,
      configDigest: retained.configDigest,
      config,
      phase,
      optionId,
      requestId,
      pending,
      beforeWrite: (intent) => {
        const state = live();
        // Revalidate phase after awaited reads; do not publish a stale checkpoint.
        if (projectPhase(state) !== phase)
          throw new Error("Project lifecycle changed before update");
        state.githubProjectStatus ??= { requests: [] };
        const last = state.githubProjectStatus.requests.at(-1);
        if (
          (last && !last.response && !last.notSent) ||
          state.githubProjectStatus.requests.length >= (important ? 64 : 62)
        )
          throw new Error("Project status update is held by retained history");
        state.githubProjectStatus.requests.push(intent);
        delete state.githubProjectStatus.observed;
        args.save();
      },
    });
    const state = live();
    const intent = state.githubProjectStatus?.requests.at(-1);
    if (observed.kind === "unchanged") {
      // Read-only satisfaction requires no fabricated mutation receipt.
      state.githubProjectStatus ??= { requests: [] };
      state.githubProjectStatus.observed = {
        projectId: config.projectId,
        fieldId: config.fieldId,
        itemId: observed.itemId,
        phase,
        optionId,
        observedAt: observed.observedAt,
      };
      delete state.githubProjectStatus.failure;
      args.save();
      return;
    }
    if (
      !intent ||
      intent.requestId !== requestId ||
      intent.itemId !== observed.itemId ||
      intent.response
    )
      throw new Error(
        "Project observation differs from retained update intent",
      );
    if (observed.kind === "unknown-read") {
      intent.laterObservation = {
        optionId: observed.optionId,
        observedAt: observed.observedAt,
      };
      state.githubProjectStatus!.failure = "update-unknown";
    } else {
      if (intent.optionId !== observed.optionId)
        throw new Error("Project update option differs");
      intent.response = {
        itemId: observed.itemId,
        optionId: observed.optionId,
        observedAt: observed.observedAt,
      };
      delete state.githubProjectStatus!.failure;
    }
    args.save();
  } catch (error) {
    const state = live();
    state.githubProjectStatus ??= { requests: [] };
    const last = state.githubProjectStatus.requests.at(-1);
    const transport = gitHubTransportOf(error);
    if (
      last &&
      last.requestId === requestId &&
      !last.response &&
      !last.notSent &&
      !pending &&
      transport?.operation === "mutation" &&
      transport.dispatch === "not-sent" &&
      transport.outcome !== "completed"
    )
      last.notSent = {
        operation: "mutation",
        dispatch: "not-sent",
        outcome: transport.outcome,
        category: transport.category,
      };
    state.githubProjectStatus.failure =
      last && !last.response && !last.notSent
        ? "update-unknown"
        : "projection-unavailable";
    args.save();
    process.stderr.write(
      `Factory Project status for Objective #${args.objective}: ${state.githubProjectStatus.failure}; inspect Factory status.\n`,
    );
  }
}
