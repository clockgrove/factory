import { randomUUID } from "node:crypto";
import type { FactoryConfig } from "./config.js";
import { factoryConfigDigest } from "./config.js";
import type { GitHubGateway } from "./contracts.js";
import {
  continuationStatusDocument,
  redactDiagnosticDetail,
} from "./diagnostics.js";
import {
  renderGitHubProgress,
  type GitHubProgressDecision,
} from "./github-progress.js";
import { progressDigest } from "./github-progress-state.js";
import { planDecisionTemplate } from "./github-plan-decisions.js";
import type { ContinuationState } from "./state.js";
import { readContinuation } from "./state-store.js";

/** Controlled checkpoint projection; no diagnostics are used as recovery input. */
export async function projectGitHubProgress(args: {
  config: FactoryConfig;
  objective: number;
  github: GitHubGateway;
  current: () => ContinuationState | undefined;
  save: () => void;
  /** Exact current owner observation, not inferred from the existence of a snapshot. */
  active: boolean;
  secrets: string[];
}): Promise<void> {
  const { config, objective, github, current, save } = args;
  if (!config.githubManagement?.progress) return;
  const retained = readContinuation(config.repository, objective);
  if (!retained) return;
  const live = () => {
    const state = current();
    if (
      !state ||
      state.runId !== retained.runId ||
      state.configDigest !== retained.configDigest ||
      factoryConfigDigest(config) !== retained.configDigest
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
    factoryConfigDigest(config),
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
  if (config.githubManagement.progress.includeQuestions) {
    if (
      retained.schemaVersion === 8 &&
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
    } else if (retained.schemaVersion === 7) {
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
          : [])
          decisions.push({
            question: redactDiagnosticDetail(pending.question, args.secrets),
            recommendation:
              "Assess the named criterion against its exact retained evidence using the supported local decision path.",
            consequences:
              "Accepting answers this pending human-owned criterion; other criteria and independent validation remain required. Refusal retains the failed outcome.",
            binding: `Objective ${objective}; run ${retained.runId}; item ${group.id}; criterion digest ${progressDigest(pending.criterion)}; tree ${pending.treeSha}`,
          });
    }
  }
  const blockers: string[] = [];
  if (
    snapshot.phase === "needs-decision" ||
    snapshot.phase === "needs-plan-decision"
  )
    blockers.push(
      config.githubManagement.progress.includeQuestions
        ? "A human-owned choice needs attention."
        : "A human-owned choice needs attention. Question disclosure is disabled; inspect local Factory status.",
    );
  if (snapshot.phase === "failed")
    blockers.push(
      "The retained run is stopped; inspect the supported recovery path before continuing.",
    );
  if (retained.coordinator?.cancelError)
    blockers.push("Owned-resource cancellation remains unresolved.");
  if (retained.coordinator?.mode === "paused")
    blockers.push("The coordinator is paused.");
  if (retained.coordinator?.mode === "draining")
    blockers.push("The coordinator is draining owned work.");
  const template =
    retained.schemaVersion === 8 && github.planDecisionComments
      ? planDecisionTemplate(config, retained)
      : undefined;
  const next =
    snapshot.phase === "complete"
      ? "The Objective is accepted and closed. Inspect linked delivery evidence."
      : snapshot.phase === "cancelled"
        ? "This run is cancelled; preserve its retained history."
        : snapshot.phase === "needs-decision" ||
            snapshot.phase === "needs-plan-decision"
          ? template
            ? "Copy the filled decision template below into a comment on this Objective, replacing only answer and reason."
            : "Handle the listed questions through the supported local Factory decision path."
          : snapshot.phase === "failed"
            ? "Inspect local Factory status for the exact supported recovery or prerequisite."
            : retained.coordinator?.mode !== "running"
              ? "Wait for the operator's supported resume or drain disposition."
              : "Factory will continue the admitted work within its recorded limits.";
  const presentation = { view, next, blockers, decisions };
  // Only public presentation fields affect coalescing; private detail changes are irrelevant.
  const presentationDigest = progressDigest(
    JSON.stringify({
      phase: snapshot.phase,
      state: snapshot.state,
      work:
        "work" in view
          ? (view.work ?? []).map(({ id, status, step, pullRequest }) => ({
              id,
              status,
              step,
              pullRequest,
            }))
          : [],
      coordinator: retained.coordinator?.mode,
      next,
      blockers,
      decisions,
      template,
    }),
  );
  let flushCurrent = false;
  try {
    const progress = live().githubProgress;
    const previous = progress?.requests.at(-1);
    const pending = previous && !previous.comment ? previous : undefined;
    // No heartbeat refreshes: timestamps never participate in semantic deduplication.
    if (!pending && previous?.presentationDigest === presentationDigest) return;
    const important = [
      "complete",
      "cancelled",
      "needs-decision",
      "needs-plan-decision",
    ].includes(snapshot.phase);
    if (!pending && (progress?.requests.length ?? 0) >= (important ? 64 : 62)) {
      const state = live();
      state.githubProgress ??= { requests: [] };
      state.githubProgress.failure = "history-exhausted";
      save();
      return;
    }
    const observedAt = pending?.observedAt ?? new Date().toISOString();
    const snapshotId = pending?.snapshotId ?? randomUUID();
    const body =
      pending?.body ??
      renderGitHubProgress({
        repository: config.repository,
        runId: retained.runId,
        snapshotId,
        configDigest: retained.configDigest,
        observedAt,
        preparedAt: observedAt,
        view: presentation.view,
        nextAction: next,
        blockers,
        decisions,
        ...(template ? { planDecisionTemplate: template } : {}),
      });
    if (!github.progressComment)
      throw new Error("GitHub progress projection is unavailable");
    const observed = await github.progressComment({
      objective,
      runId: retained.runId,
      snapshotId,
      body,
      pending,
      beforeWrite: (actorId) => {
        const state = live();
        state.githubProgress ??= { requests: [] };
        const last = state.githubProgress.requests.at(-1);
        if (last && !last.comment)
          throw new Error("Another progress publication remains pending");
        if (state.githubProgress.requests.length >= (important ? 64 : 62))
          throw new Error("GitHub progress history is exhausted");
        state.githubProgress.requests.push({
          snapshotId,
          body,
          bodyDigest: progressDigest(body),
          actorId,
          observedAt,
          presentationDigest,
        });
        save();
      },
    });
    const state = live();
    const intent = state.githubProgress?.requests.at(-1);
    if (
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
    delete state.githubProgress!.failure;
    save();
    // A reconciled older snapshot may precede this checkpoint (including final
    // closure). Publish the current meaningful change once after settlement.
    flushCurrent = Boolean(
      pending && pending.presentationDigest !== presentationDigest,
    );
  } catch {
    const state = live();
    state.githubProgress ??= { requests: [] };
    const last = state.githubProgress.requests.at(-1);
    state.githubProgress.failure =
      last && !last.comment ? "publication-unknown" : "projection-unavailable";
    save();
    process.stderr.write(
      `Factory GitHub progress for Objective #${objective}: ${state.githubProgress.failure}; inspect Factory status.\n`,
    );
  }
  // Keep a fresh snapshot read outside the persistence catch: a corrupt or
  // unreadable continuation must never be repaired from a remembered owner.
  if (flushCurrent) await projectGitHubProgress(args);
}
