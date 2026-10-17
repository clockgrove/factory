import { randomUUID } from "node:crypto";
import { type FactoryConfig, githubProgressSettings } from "./config.js";
import type { GitHubGateway } from "./contracts.js";
import {
  continuationStatusDocument,
  redactDiagnosticDetail,
} from "./diagnostics.js";
import { projectLiveStatus } from "./github-live-status.js";
import {
  type GitHubProgressDecision,
  renderObjectiveNotification,
  renderWorkItemNotification,
  type WorkItemFacts,
} from "./github-progress.js";
import {
  type GitHubProgressProjection,
  PROGRESS_ITEM_ID,
  progressDigest,
} from "./github-progress-state.js";
import {
  awaitCheckpointAdmission,
  isCheckpointAdmissionFailure,
  withRecoveryCheckpointScope,
} from "./recovery-checkpoint.js";
import { buildRecoveryCheckpointClosure } from "./recovery-checkpoint-closure.js";
import { attemptOrigin } from "./repair-policy.js";
import type { ContinuationState } from "./state.js";
import { isExecutionState, isPreparationState } from "./state.js";
import {
  assertRestoredContinuationReady,
  continuationConfigurationMatches,
  readContinuation,
} from "./state-store.js";
import { outageOf } from "./step.js";

type Args = {
  config: FactoryConfig;
  objective: number;
  github: GitHubGateway;
  current: () => ContinuationState | undefined;
  save: () => void;
  /** Exact current owner observation, not inferred from the existence of a snapshot. */
  active: boolean;
  secrets: string[];
};

/** One notification stream: the Objective's own issue, or a Work Item's. */
interface ProgressTarget {
  label: string;
  objective: number;
  runId: string;
  item?: { id: string; issue: number };
  read: (state: ContinuationState) => GitHubProgressProjection | undefined;
  ensure: (state: ContinuationState) => GitHubProgressProjection;
  /** What the notification announces; timestamps never take part. */
  presentationDigest: string;
  /** Whether the current state needs a new comment; edits do not notify. */
  notify: boolean;
  render: (snapshotId: string, observedAt: string) => string;
}

/** Controlled checkpoint projection; no diagnostics are used as recovery input. */
async function projectGitHubProgressUnscoped(args: Args): Promise<void> {
  const { config, objective, github, current } = args;
  const settings = githubProgressSettings(config);
  if (!settings || !progressOffered(config, github)) return;
  const retained = readContinuation(config.repository, objective);
  if (!retained) return;
  assertRestoredContinuationReady(retained, args.config);
  const live = () => {
    const state = current();
    if (
      !state ||
      state.runId !== retained.runId ||
      state.configDigest !== retained.configDigest ||
      !continuationConfigurationMatches(retained, config)
    )
      throw new Error("GitHub progress snapshot or configuration changed");
    return state;
  };
  // Read the full validated persisted snapshot, never a partial event or diagnostic.
  const snapshot = continuationStatusDocument(
    retained,
    config.repository,
    objective,
    config.delivery.kind,
    args.secrets,
    retained.capacity.concurrency,
    args.active,
    undefined,
    retained.configDigest,
  );
  const view = {
    ...snapshot,
    ...(snapshot.state !== "preparing" && snapshot.state !== "not-started"
      ? {
          work: snapshot.work.filter(
            (item) => retained.issueByItemId[item.id] !== undefined,
          ),
        }
      : {}),
  };
  const decisions: GitHubProgressDecision[] = [];
  /** Each Work Item's own pending criteria, for its issue. */
  const itemDecisions: Record<string, GitHubProgressDecision[]> = {};
  if (settings.includeQuestions) {
    if (
      isPreparationState(retained) &&
      retained.plan?.review.status === "needs-human"
    ) {
      const questions = [
        ...(retained.plan.review.failure
          ? [retained.plan.review.failure.question]
          : []),
        ...retained.plan.review.findings.map((finding) => finding.question),
      ];
      for (const question of questions)
        decisions.push({
          question: redactDiagnosticDetail(question, args.secrets),
          recommendation:
            "Choose an answer supported by the approved Objective and its pinned sources; no automatic choice is implied.",
          consequences:
            "A supported local decision records your answer for this plan. Normal validation and independent acceptance still apply. Refusal uses the local supported path.",
          binding: `Objective ${objective}; run ${retained.runId}; plan ${retained.plan.reviewDigest}; question ${progressDigest(question)}`,
        });
    } else if (isExecutionState(retained)) {
      const groups = [
        ...Object.entries(retained.work).map(([id, work]) => ({
          id,
          pending: work.acceptancePending,
        })),
        { id: "final Objective", pending: retained.finalAcceptancePending },
      ];
      for (const group of groups)
        for (const pending of group.pending
          ? [group.pending, ...(group.pending.more ?? [])]
          : []) {
          const decision = {
            question: redactDiagnosticDetail(pending.question, args.secrets),
            recommendation:
              "Assess the named criterion against its exact retained evidence using the supported local decision path.",
            consequences:
              "Accepting answers this pending human-owned criterion; other criteria and independent validation remain required. Refusal retains the failed outcome.",
            binding: `Objective ${objective}; run ${retained.runId}; item ${group.id}; criterion digest ${progressDigest(pending.criterion)}; tree ${pending.treeSha}`,
          };
          decisions.push(decision);
          itemDecisions[group.id] = [
            ...(itemDecisions[group.id] ?? []),
            decision,
          ];
        }
    }
  }
  const blockers: string[] = [];
  if (
    snapshot.phase === "needs-decision" ||
    snapshot.phase === "needs-plan-decision"
  )
    blockers.push(
      settings.includeQuestions
        ? "A human-owned choice needs attention."
        : "A human-owned choice needs attention. Question disclosure is disabled; inspect local Factory status.",
    );
  if (snapshot.phase === "failed")
    blockers.push(
      "The retained run is stopped; inspect the supported recovery path before continuing.",
    );
  if (retained.coordinator?.cancelError)
    blockers.push("Owned-resource cancellation remains unresolved.");
  // A finished Objective's last control mode blocks nothing (#1429).
  const finished = ["complete", "cancelled"].includes(snapshot.phase);
  if (!finished && retained.coordinator?.mode === "paused")
    blockers.push("The coordinator is paused.");
  if (!finished && retained.coordinator?.mode === "draining")
    blockers.push("The coordinator is draining owned work.");
  const command = publicCommand(
    snapshot,
    settings.includeQuestions,
    args.secrets,
  );
  const split =
    snapshot.state === "preparing" && snapshot.split?.enqueuedAt
      ? snapshot.split
      : undefined;
  const next = split
    ? split.closedAt
      ? "Every child Objective is accepted; this Objective is closed."
      : snapshot.phase === "needs-decision"
        ? "A child Objective was cancelled; inspect local Factory status for the supported way to end this Objective."
        : "Factory runs each child Objective through the queue, after the children it builds on are accepted, and closes this Objective when every child is accepted."
    : snapshot.phase === "complete"
      ? "The Objective is accepted and closed. Inspect linked delivery evidence."
      : snapshot.phase === "cancelled"
        ? "This run is cancelled; preserve its retained history."
        : snapshot.phase === "needs-decision" ||
            snapshot.phase === "needs-plan-decision"
          ? "Handle the listed questions through the supported local Factory decision path."
          : snapshot.phase === "failed"
            ? "Inspect local Factory status for the exact supported recovery or prerequisite."
            : retained.coordinator?.mode !== "running"
              ? "Wait for the operator's supported resume or drain disposition."
              : "Factory will continue the admitted work within its recorded limits.";
  const status = {
    repository: config.repository,
    view,
    nextAction: next,
    ...(command ? { command } : {}),
    blockers,
    decisions,
  };
  const details = {
    runId: retained.runId,
    configDigest: retained.configDigest,
    decisions,
  };
  // A new comment only for what needs a phone notification; edits do not notify.
  // A split notifies once, naming the children that now carry the work.
  const notify =
    split !== undefined ||
    [
      "complete",
      "cancelled",
      "failed",
      "needs-decision",
      "needs-plan-decision",
    ].includes(snapshot.phase);
  const flushCurrent = await publishProgress(args, live, {
    label: `Objective #${objective}`,
    objective,
    runId: retained.runId,
    read: (state) => state.githubProgress,
    ensure: (state) => {
      state.githubProgress ??= { requests: [] };
      return state.githubProgress;
    },
    // A new question, answer path or outcome notifies again; nothing else does.
    presentationDigest: progressDigest(
      JSON.stringify({
        phase: snapshot.phase,
        decisions,
        ...(split ? { split: split.children.map((child) => child.issue) } : {}),
      }),
    ),
    notify,
    render: (snapshotId, observedAt) =>
      renderObjectiveNotification({
        ...status,
        ...details,
        snapshotId,
        observedAt,
      }),
  });
  // Keep a fresh snapshot read outside the persistence catch: a corrupt or
  // unreadable continuation must never be repaired from a remembered owner.
  if (flushCurrent) return projectGitHubProgressUnscoped(args);
  const items: Record<
    string,
    WorkItemFacts & { decisions: GitHubProgressDecision[] }
  > = {};
  if (isExecutionState(retained))
    for (const [id, issue] of Object.entries(retained.issueByItemId)) {
      const facts = workItemFacts(retained, id);
      if (!facts) continue;
      items[id] = { ...facts, decisions: itemDecisions[id] ?? [] };
      await projectWorkItemProgress(args, retained, live, id, issue, items[id]);
    }
  await projectLiveStatus(
    args,
    retained,
    live,
    snapshot.phase,
    snapshot.state === "preparing" ? snapshot.planningStep : undefined,
    {
      status,
      details,
      // Public presentation only; a change edits the comment at once.
      digest: progressDigest(
        JSON.stringify({
          next,
          command,
          blockers,
          decisions,
          coordinator: retained.coordinator?.mode,
          runActive: args.active,
          ...(split ? { children: split.children } : {}),
        }),
      ),
      items,
    },
  );
}

/**
 * The exact next command status names, while a human is needed. A criterion
 * argument is question text: without question disclosure it stays local.
 */
function publicCommand(
  snapshot: { phase: string; nextAction: { command: string } | null },
  includeQuestions: boolean,
  secrets: string[],
): string | undefined {
  if (
    !snapshot.nextAction ||
    !["needs-decision", "needs-plan-decision", "failed"].includes(
      snapshot.phase,
    )
  )
    return;
  let command = snapshot.nextAction.command;
  const criterion = command.indexOf(" --criterion ");
  if (criterion >= 0 && !includeQuestions) {
    // The criterion itself may contain " --outcome "; the real one is last.
    const rest = command.lastIndexOf(" --outcome ");
    command = `${command.slice(0, criterion)} --criterion "…"${rest >= 0 ? command.slice(rest) : ""}`;
  }
  command = redactDiagnosticDetail(command, secrets);
  return /[`\r\n]/.test(command) || Buffer.byteLength(command) > 1_000
    ? undefined
    : command;
}

/** A started Work Item's public facts, from structured state only. */
function workItemFacts(
  retained: ContinuationState,
  id: string,
): WorkItemFacts | undefined {
  if (!isExecutionState(retained) || !PROGRESS_ITEM_ID.test(id)) return;
  const work = retained.work[id];
  // An item that has not started has nothing to report yet.
  if (!work || work.status === "pending" || work.status === "skipped") return;
  const outage = outageOf(retained, { item: id });
  const origin = attemptOrigin(work);
  return {
    status: work.status,
    ...(work.step && { step: work.step }),
    ...(work.attempt && { attempt: work.attempt }),
    ...(origin && { attemptNumber: origin.number, attemptKind: origin.kind }),
    ...(work.pullRequest && { pullRequest: work.pullRequest }),
    ...(outage && {
      outage: {
        step: outage.step,
        ...(outage.retryAt && { retryAt: outage.retryAt }),
      },
    }),
    ...(work.recovery?.failure && {
      failure: work.recovery.failure.classification,
    }),
    // A pause, drain or restart concerns only items still in progress.
    ...(!["done", "failed", "cancelled"].includes(work.status) && {
      coordinator: retained.coordinator?.mode,
    }),
  };
}

/** A Work Item's notification comment on its own issue: it failed or waits for a decision. */
async function projectWorkItemProgress(
  args: Args,
  retained: ContinuationState,
  live: () => ContinuationState,
  id: string,
  issue: number,
  facts: WorkItemFacts & { decisions: GitHubProgressDecision[] },
): Promise<void> {
  const recorded = isExecutionState(retained)
    ? retained.workItemTracking?.[id]?.issue
    : undefined;
  // A graph revision that rebinds the item to another issue ends its tracking.
  if (recorded !== undefined && recorded !== issue) return;
  const flushCurrent = await publishProgress(args, live, {
    label: `Work Item ${id}`,
    objective: args.objective,
    runId: retained.runId,
    item: { id, issue },
    read: (state) =>
      isExecutionState(state)
        ? state.workItemTracking?.[id]?.progress
        : undefined,
    ensure: (state) => {
      if (!isExecutionState(state))
        throw new Error("Work Item tracking requires an executing Objective");
      state.workItemTracking ??= {};
      state.workItemTracking[id] ??= { issue };
      const entry = state.workItemTracking[id];
      entry.progress ??= { requests: [] };
      return entry.progress;
    },
    // A later attempt's failure or a new question notifies again.
    presentationDigest: progressDigest(
      JSON.stringify({
        status: facts.status,
        attempt: facts.attempt,
        failure: facts.failure,
        decisions: facts.decisions,
      }),
    ),
    notify: facts.status === "failed" || facts.status === "waiting",
    render: (snapshotId, observedAt) =>
      renderWorkItemNotification({
        repository: args.config.repository,
        objective: args.objective,
        item: { id, issue },
        runId: retained.runId,
        snapshotId,
        configDigest: retained.configDigest,
        observedAt,
        ...facts,
      }),
  });
  if (flushCurrent) {
    const fresh = readContinuation(args.config.repository, args.objective);
    const current = fresh && workItemFacts(fresh, id);
    if (fresh && current)
      await projectWorkItemProgress(args, fresh, live, id, issue, {
        ...current,
        decisions: facts.decisions,
      });
  }
}

/**
 * Comment streams whose publication failed with no intent outstanding, by presentation, for
 * this process. The projection runs every 30 seconds for every Work Item; a refused or
 * unavailable comment is tried again only when its presentation changes or the controller
 * restarts, so presentation never spends the GitHub request budget delivery needs.
 */
const failedComments = new Map<string, string>();

/**
 * Publish the target's current presentation once: an unresolved earlier intent is
 * reconciled read-only first, an unchanged presentation is skipped, and the bounded
 * history holds later writes. Returns whether a newer presentation must follow a
 * reconciled one.
 */
async function publishProgress(
  args: Args,
  live: () => ContinuationState,
  target: ProgressTarget,
): Promise<boolean> {
  const { config, github, save } = args;
  const failedKey = `${config.repository}#${target.objective}:${target.runId}:${target.label}`;
  let pending: GitHubProgressProjection["requests"][number] | undefined;
  try {
    const progress = target.read(live());
    const previous = progress?.requests.at(-1);
    pending = previous && !previous.comment ? previous : undefined;
    // An unresolved earlier intent is always reconciled; otherwise only a
    // notification-worthy state posts.
    if (!pending && !target.notify) return false;
    if (!pending && failedComments.get(failedKey) === target.presentationDigest)
      return false;
    failedComments.delete(failedKey);
    // No heartbeat refreshes: timestamps never participate in semantic deduplication.
    if (!pending && previous?.presentationDigest === target.presentationDigest)
      return false;
    const bound = 64;
    if (!pending && (progress?.requests.length ?? 0) >= bound) {
      const current = target.ensure(live());
      if (current.failure !== "history-exhausted") {
        current.failure = "history-exhausted";
        save();
      }
      return false;
    }
    const observedAt = pending?.observedAt ?? new Date().toISOString();
    const snapshotId = pending?.snapshotId ?? randomUUID();
    const body = pending?.body ?? target.render(snapshotId, observedAt);
    if (!github.progressComment)
      throw new Error("GitHub progress projection is unavailable");
    const observed = await github.progressComment({
      objective: target.objective,
      ...(target.item && { item: target.item }),
      runId: target.runId,
      snapshotId,
      body,
      pending,
      beforeWrite: async (actorId) => {
        const current = target.ensure(live());
        const last = current.requests.at(-1);
        if (last && !last.comment)
          throw new Error("Another progress publication remains pending");
        if (current.requests.length >= bound)
          throw new Error("GitHub progress history is exhausted");
        current.requests.push({
          snapshotId,
          body,
          bodyDigest: progressDigest(body),
          actorId,
          observedAt,
          presentationDigest: target.presentationDigest,
        });
        try {
          save();
        } catch (error) {
          // A refused save leaves nothing retained: drop the intent so the
          // live state stays valid for every later save.
          current.requests.pop();
          throw error;
        }
        try {
          await awaitCheckpointAdmission(config.repository, "before-effect");
        } catch (error) {
          // The POST follows this call, so nothing was sent: drop the intent
          // instead of leaving it to read as an unknown publication.
          const latest = target.read(live());
          if (latest?.requests.at(-1)?.snapshotId === snapshotId) {
            latest.requests.pop();
            save();
          }
          throw error;
        }
      },
    });
    const current = target.read(live());
    const intent = current?.requests.at(-1);
    if (
      !current ||
      !intent ||
      intent.snapshotId !== snapshotId ||
      intent.actorId !== observed.actorId ||
      intent.bodyDigest !== observed.bodyDigest ||
      intent.comment
    )
      throw new Error(
        "GitHub progress observation differs from retained intent",
      );
    intent.comment = observed;
    delete current.failure;
    // A successor comment's own pre-effect checkpoint publishes this response
    // with its intent, so the successor never precedes this durable receipt.
    save();
    // A reconciled older snapshot may precede the current presentation
    // (including final closure). Publish that meaningful change once next.
    return Boolean(
      pending &&
        target.notify &&
        pending.presentationDigest !== target.presentationDigest,
    );
  } catch (error) {
    if (isCheckpointAdmissionFailure(error)) throw error;
    const state = live();
    const existed = target.read(state) !== undefined;
    const current = target.ensure(state);
    const last = current.requests.at(-1);
    const failure =
      last && !last.comment ? "publication-unknown" : "projection-unavailable";
    if (failure === "projection-unavailable" && !pending)
      failedComments.set(failedKey, target.presentationDigest);
    // A repeated failure (for example, an issue GitHub refuses) is recorded once.
    if (existed && current.failure === failure) return false;
    current.failure = failure;
    save();
    await awaitCheckpointAdmission(config.repository, "settled");
    process.stderr.write(
      `Factory GitHub progress for ${target.label}: ${failure}; inspect Factory status.\n`,
    );
    return false;
  }
}

/**
 * Whether this run projects progress: explicitly configured, or on by default where the
 * gateway can post comments.
 */
export function progressOffered(
  config: FactoryConfig,
  github: GitHubGateway,
): boolean {
  const settings = githubProgressSettings(config);
  return !!settings && (settings.explicit || !!github.progressComment);
}

/** Direct callers use the same admitted repository scope as owned controllers. */
export function projectGitHubProgress(args: Args): Promise<void> {
  if (!progressOffered(args.config, args.github)) return Promise.resolve();
  return withRecoveryCheckpointScope(
    {
      config: args.config,
      buildClosure: () =>
        buildRecoveryCheckpointClosure({ config: args.config }),
    },
    async () => {
      await projectGitHubProgressUnscoped(args);
      await awaitCheckpointAdmission(args.config.repository, "settled");
    },
  );
}
