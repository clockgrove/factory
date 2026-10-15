import { randomUUID } from "node:crypto";
import { objectiveComplete } from "./completion.js";
import { type FactoryConfig, githubProjectStatusSettings } from "./config.js";
import type { GitHubGateway } from "./contracts.js";
import { gitHubTransportOf } from "./github-client.js";
import type {
  GitHubProjectStatusConfig,
  GitHubProjectStatusProjection,
  ProjectPhase,
} from "./github-project-state.js";
import {
  awaitCheckpointAdmission,
  isCheckpointAdmissionFailure,
  withRecoveryCheckpointScope,
} from "./recovery-checkpoint.js";
import { buildRecoveryCheckpointClosure } from "./recovery-checkpoint-closure.js";
import type { ContinuationState } from "./state.js";
import { isExecutionState, isPreparationState } from "./state.js";
import {
  assertRestoredContinuationReady,
  continuationConfigurationMatches,
  readContinuation,
} from "./state-store.js";
import { awaitsOperator } from "./step.js";

/** Derived presentation only; a Project card never grants lifecycle authority. */
export function projectPhase(state: ContinuationState): ProjectPhase {
  if (isExecutionState(state) && objectiveComplete(state)) return "accepted";
  if (state.cancelRequested || state.cancelledAt || state.error)
    return "stopped";
  if (isPreparationState(state)) {
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

/** A started Work Item's card phase; a pending or skipped item keeps its card as it is. */
export function workItemProjectPhase(
  state: ContinuationState,
  id: string,
): ProjectPhase | undefined {
  if (!isExecutionState(state)) return undefined;
  const work = state.work[id];
  if (!work || work.status === "pending" || work.status === "skipped")
    return undefined;
  if (work.status === "done") return "accepted";
  if (
    work.status === "failed" ||
    work.status === "cancelled" ||
    state.cancelRequested ||
    state.cancelledAt
  )
    return "stopped";
  if (
    work.status === "waiting" ||
    work.acceptancePending ||
    awaitsOperator(work.wait)
  )
    return "needs-human";
  if (state.coordinator?.mode !== "running") return "stopped";
  if (
    work.status === "running" &&
    (work.step === "approve-result" || work.step === "approve-asset")
  )
    return "review";
  return "running";
}

type Args = {
  config: FactoryConfig;
  objective: number;
  github: GitHubGateway;
  current: () => ContinuationState | undefined;
  save: () => void;
};

/** One card: the Objective's own, or a Work Item's on its issue. */
interface CardTarget {
  label: string;
  issue?: number;
  phase: (state: ContinuationState) => ProjectPhase | undefined;
  read: (state: ContinuationState) => GitHubProjectStatusProjection | undefined;
  ensure: (state: ContinuationState) => GitHubProjectStatusProjection;
}

/** The default Project's discovered binding, read once per process; a gap is remembered too. */
const discovered = new Map<string, GitHubProjectStatusConfig | null>();

/** Same controlled checkpoint and atomic continuation as other projections. */
async function projectGitHubProjectStatusUnscoped(args: Args): Promise<void> {
  const settings = githubProjectStatusSettings(args.config);
  if (!settings || !projectStatusOffered(args.config, args.github)) return;
  const retained = readContinuation(args.config.repository, args.objective);
  if (!retained) return;
  assertRestoredContinuationReady(retained, args.config);
  const live = () => {
    const state = args.current();
    if (
      !state ||
      state.runId !== retained.runId ||
      state.configDigest !== retained.configDigest ||
      !continuationConfigurationMatches(retained, args.config)
    )
      throw new Error("Project projection snapshot or configuration changed");
    return state;
  };
  let config: GitHubProjectStatusConfig;
  if (settings.kind === "explicit") config = settings.config;
  else {
    const key = `${settings.repository}|${settings.projectId}`;
    if (!discovered.has(key)) {
      try {
        discovered.set(
          key,
          (await args.github.discoverProjectStatus!(settings)) ?? null,
        );
      } catch (error) {
        if (isCheckpointAdmissionFailure(error)) throw error;
        const state = live();
        state.githubProjectStatus ??= { requests: [] };
        if (state.githubProjectStatus.failure !== "projection-unavailable") {
          state.githubProjectStatus.failure = "projection-unavailable";
          args.save();
          await awaitCheckpointAdmission(args.config.repository, "settled");
        }
        return;
      }
    }
    const binding = discovered.get(key);
    if (!binding) {
      // Reported once; comments continue without Project status.
      if (
        retained.githubProjectStatus?.failure !== "status-field-unavailable"
      ) {
        const state = live();
        state.githubProjectStatus ??= { requests: [] };
        state.githubProjectStatus.failure = "status-field-unavailable";
        args.save();
        await awaitCheckpointAdmission(args.config.repository, "settled");
        process.stderr.write(
          `Factory Project status for Objective #${args.objective}: the queue Project has no Status field with the default options; posting comments only.\n`,
        );
      }
      return;
    }
    config = binding;
  }
  await projectCard(args, config, retained, live, {
    label: `Objective #${args.objective}`,
    phase: projectPhase,
    read: (state) => state.githubProjectStatus,
    ensure: (state) => {
      state.githubProjectStatus ??= { requests: [] };
      return state.githubProjectStatus;
    },
  });
  if (!isExecutionState(retained)) return;
  for (const [id, issue] of Object.entries(retained.issueByItemId)) {
    const recorded = retained.workItemTracking?.[id]?.issue;
    // A graph revision that rebinds the item to another issue ends its tracking.
    if (recorded !== undefined && recorded !== issue) continue;
    await projectCard(args, config, retained, live, {
      label: `Work Item ${id}`,
      issue,
      phase: (state) => workItemProjectPhase(state, id),
      read: (state) =>
        isExecutionState(state)
          ? state.workItemTracking?.[id]?.projectStatus
          : undefined,
      ensure: (state) => {
        if (!isExecutionState(state))
          throw new Error("Work Item tracking requires an executing Objective");
        state.workItemTracking ??= {};
        state.workItemTracking[id] ??= { issue };
        const entry = state.workItemTracking[id];
        entry.projectStatus ??= { requests: [] };
        return entry.projectStatus;
      },
    });
  }
}

/**
 * Cards whose read failed with no write outstanding, by phase, for this process. The
 * projection runs every 30 seconds for every Work Item; a card that is missing or
 * unreadable is read again only when its phase changes or the controller restarts, so
 * presentation never spends the GitHub request budget delivery and the queue need.
 */
const failedCards = new Map<string, string>();

async function projectCard(
  args: Args,
  config: GitHubProjectStatusConfig,
  retained: ContinuationState,
  live: () => ContinuationState,
  target: CardTarget,
): Promise<void> {
  const phase = target.phase(retained);
  if (!phase) return;
  const optionId = config.options[phase];
  const projection = target.read(retained);
  const previous = projection?.requests.at(-1);
  const pending =
    previous && !previous.response && !previous.notSent ? previous : undefined;
  const failedKey = `${args.config.repository}#${args.objective}:${retained.runId}:${target.label}`;
  if (!pending && failedCards.get(failedKey) === phase) return;
  failedCards.delete(failedKey);
  // One exact later read is useful evidence. Further reads cannot settle the
  // original effect, so retain its timestamp and fence without polling forever.
  if (pending?.laterObservation) return;
  // Known completed writes coalesce time-only changes; unknown writes read only.
  const satisfaction = projection?.observed;
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
      (projection?.requests.length ?? 0) >= (important ? 64 : 62)
    ) {
      target.ensure(live()).failure = "history-exhausted";
      args.save();
      return;
    }
    const observed = await args.github.projectStatus({
      objective: args.objective,
      ...(target.issue !== undefined && { issue: target.issue }),
      runId: retained.runId,
      configDigest: retained.configDigest,
      config,
      phase,
      optionId,
      requestId,
      pending,
      beforeWrite: async (intent) => {
        const state = live();
        // Revalidate phase after awaited reads; do not publish a stale checkpoint.
        if (target.phase(state) !== phase)
          throw new Error("Project lifecycle changed before update");
        const current = target.ensure(state);
        const last = current.requests.at(-1);
        if (
          (last && !last.response && !last.notSent) ||
          current.requests.length >= (important ? 64 : 62)
        )
          throw new Error("Project status update is held by retained history");
        current.requests.push(intent);
        delete current.observed;
        args.save();
        try {
          await awaitCheckpointAdmission(
            args.config.repository,
            "before-effect",
          );
        } catch (error) {
          // The mutation follows this call, so nothing was sent: drop the
          // intent instead of leaving it to read as an unknown update.
          const latest = target.read(live());
          if (latest?.requests.at(-1)?.requestId === intent.requestId) {
            latest.requests.pop();
            args.save();
          }
          throw error;
        }
      },
    });
    const state = live();
    if (observed.kind === "unchanged") {
      // Read-only satisfaction requires no fabricated mutation receipt.
      const current = target.ensure(state);
      current.observed = {
        projectId: config.projectId,
        fieldId: config.fieldId,
        itemId: observed.itemId,
        phase,
        optionId,
        observedAt: observed.observedAt,
      };
      delete current.failure;
      args.save();
      return;
    }
    const current = target.read(state);
    const intent = current?.requests.at(-1);
    if (
      !current ||
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
      current.failure = "update-unknown";
    } else {
      if (intent.optionId !== observed.optionId)
        throw new Error("Project update option differs");
      intent.response = {
        itemId: observed.itemId,
        optionId: observed.optionId,
        observedAt: observed.observedAt,
      };
      delete current.failure;
    }
    args.save();
    // The exact original response must be durable before dependent work proceeds.
    await awaitCheckpointAdmission(args.config.repository, "explicit");
  } catch (error) {
    if (isCheckpointAdmissionFailure(error)) throw error;
    const state = live();
    const existed = target.read(state) !== undefined;
    const current = target.ensure(state);
    const last = current.requests.at(-1);
    const transport = gitHubTransportOf(error);
    let notSent = false;
    if (
      last &&
      last.requestId === requestId &&
      !last.response &&
      !last.notSent &&
      !pending &&
      transport?.operation === "mutation" &&
      transport.dispatch === "not-sent" &&
      transport.outcome !== "completed"
    ) {
      last.notSent = {
        operation: "mutation",
        dispatch: "not-sent",
        outcome: transport.outcome,
        category: transport.category,
      };
      notSent = true;
    }
    const failure =
      last && !last.response && !last.notSent
        ? "update-unknown"
        : "projection-unavailable";
    if (failure === "projection-unavailable" && !pending)
      failedCards.set(failedKey, phase);
    // A repeated read failure (for example, an issue with no card) is recorded once.
    if (existed && !notSent && current.failure === failure) return;
    current.failure = failure;
    args.save();
    await awaitCheckpointAdmission(args.config.repository, "settled");
    process.stderr.write(
      `Factory Project status for ${target.label}: ${current.failure}; inspect Factory status.\n`,
    );
  }
}

/** Direct callers use the same admitted repository scope as owned controllers. */
/**
 * Whether this run projects Project status: explicitly configured, or by default from the
 * queue Project where the gateway can read and update it.
 */
export function projectStatusOffered(
  config: FactoryConfig,
  github: GitHubGateway,
): boolean {
  const settings = githubProjectStatusSettings(config);
  return (
    !!settings &&
    (settings.kind === "explicit" ||
      (!!github.projectStatus && !!github.discoverProjectStatus))
  );
}

export function projectGitHubProjectStatus(args: Args): Promise<void> {
  if (!projectStatusOffered(args.config, args.github)) return Promise.resolve();
  return withRecoveryCheckpointScope(
    {
      config: args.config,
      buildClosure: () =>
        buildRecoveryCheckpointClosure({ config: args.config }),
    },
    async () => {
      await projectGitHubProjectStatusUnscoped(args);
      await awaitCheckpointAdmission(args.config.repository, "settled");
    },
  );
}
