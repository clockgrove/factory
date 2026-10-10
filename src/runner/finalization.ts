import { randomUUID } from "node:crypto";
import { agentSessionContinuation } from "../agent-session.js";
import { reviewObjectiveKnowledge } from "../objective-knowledge.js";
import { join } from "node:path";
import {
  finalObjectiveCommands,
  objectiveCriteria,
  planningSources,
} from "../compiler.js";
import { closeObjectiveIssue, sealFinalAcceptance } from "../completion.js";
import type { FactoryConfig } from "../config.js";
import type {
  ContentStore,
  GitHubGateway,
  PlanningModel,
} from "../contracts.js";
import type { DiagnosticEmitter } from "../diagnostics.js";
import { attachFault, decision } from "../fault.js";
import { amendmentBlocksDispatch, graphDigest } from "../graph-amendments.js";
import { finalValidationLfsMembers, verifyHydratedAssets } from "../media.js";
import { packageManagerUpdate } from "../package-manager-update.js";
import { fetchHead, git } from "../process.js";
import {
  assertCompletedCoverage,
  objectiveCandidate,
  objectivePreparationCommands,
} from "../qa.js";
import type { FactoryState } from "../state.js";
import { awaitsOperator } from "../step.js";
import {
  assertPinnedNpmScripts,
  objectiveReviewEvidence,
  reviewAcceptance,
  validateTree,
} from "../validation.js";
import { workspacePackageAdditions } from "../workspace-membership.js";
import type { ObjectiveStep } from "./ownership.js";

/** Heads others push during final validation that Factory follows before asking. */
const FOLLOWED_HEAD_LIMIT = 3;
/** Execution initializes the coordinator before entering final validation. */
export async function finalizeObjective(args: {
  config: FactoryConfig;
  objective: number;
  issue: { body: string };
  state: FactoryState;
  graph: FactoryState["graph"];
  objectiveDirectory: string;
  root: string;
  diagnostics: DiagnosticEmitter;
  github: GitHubGateway;
  planningModel: PlanningModel;
  contentStore: ContentStore;
  save: (state: FactoryState) => void;
  objectiveStep: ObjectiveStep;
  stopIfCancelled: () => void;
  cancellationRequested: () => boolean;
  objectiveSignal: () => AbortSignal;
  objectivePause: () => AbortSignal | undefined;
}): Promise<FactoryState> {
  const {
    config,
    objective,
    issue,
    state,
    graph,
    objectiveDirectory,
    root,
    diagnostics,
    github,
    planningModel,
    contentStore,
    save,
    objectiveStep,
    stopIfCancelled,
    cancellationRequested,
    objectiveSignal,
    objectivePause,
  } = args;
  // A done item whose close step waits (a question, a fix, or a closure
  // still pending) holds final validation; the next run repeats the close.
  const closeWaits = (id: string): boolean => {
    const work = state.work[id];
    return (
      awaitsOperator(work?.wait) ||
      (work?.githubClosure !== "complete" && work?.wait !== undefined)
    );
  };
  if (
    state.coordinator!.mode !== "running" ||
    amendmentBlocksDispatch(state) ||
    graph.items.some(
      (item) => state.work[item.id]?.status !== "done" || closeWaits(item.id),
    )
  )
    return state;
  stopIfCancelled();
  /**
   * Fetch the default branch. Commits others pushed on top of the
   * integrated Objective move the final candidate to that head, which is
   * validated again; that is not a fault. Returns whether it moved.
   */
  const followDefaultBranch = () =>
    objectiveStep(state, "final-head", async (context) => {
      const head = await fetchHead(
        config.checkout,
        await github.defaultBranch(),
      );
      context.progress();
      const candidate = objectiveCandidate(state)!;
      if (head === candidate.commitSha) return false;
      const integrated = state.integratedSha;
      let contained = false;
      if (candidate.basis === "current-graph-integration" && integrated)
        try {
          git(config.checkout, "merge-base", "--is-ancestor", integrated, head);
          contained = true;
        } catch {
          contained = false;
        }
      if (!contained) {
        const detail =
          candidate.basis === "pinned-baseline"
            ? `The default branch moved to ${head} from the pinned baseline ${candidate.commitSha}`
            : `The default branch ${head} no longer contains the integrated Objective ${integrated}`;
        throw attachFault(
          new Error(detail),
          decision(
            `${detail}. Only cancelling resolves this: factory cancel --objective ${objective}`,
          ),
        );
      }
      // Commits others pushed on top: follow them, bounded, apart from
      // the integration Factory made.
      const followed =
        state.finalHead?.integratedSha === integrated
          ? state.finalHead
          : undefined;
      const heads = (followed?.heads ?? []).filter((entry) => entry !== head);
      if (head === integrated) delete state.finalHead;
      else {
        // A pending question is answered once the step runs again.
        if (
          !followed?.asked &&
          (followed?.heads.length ?? 0) >= FOLLOWED_HEAD_LIMIT
        ) {
          state.finalHead = { ...followed!, asked: head };
          save(state);
          throw attachFault(
            new Error(`The default branch keeps moving; now at ${head}`),
            decision(
              `The default branch keeps moving: ${followed!.heads.length} pushes by others during final validation, now at ${head}. Validate at ${head} now with factory retry --objective ${objective}, or wait and retry later.`,
            ),
          );
        }
        state.finalHead = {
          integratedSha: integrated!,
          heads: [...heads, head],
        };
      }
      save(state);
      return true;
    });
  await followDefaultBranch();
  for (;;) {
    const finalGraphDigest = graphDigest(state.graph);
    const candidateCommitSha = objectiveCandidate(state)!.commitSha;
    const finalTree = git(
      config.checkout,
      "rev-parse",
      `${candidateCommitSha}^{tree}`,
    );
    assertCompletedCoverage(state);
    const finalValidationStarted = Date.now();
    diagnostics.emit({
      runId: state.runId,
      operation: "objective-validation",
      outcome: "started",
      metadata: {
        candidateCommitSha,
        candidateBasis: objectiveCandidate(state)!.basis,
        ...(state.integratedSha ? { integratedSha: state.integratedSha } : {}),
        treeSha: finalTree,
      },
    });
    const finalCommands =
      state.objectiveCommands ?? finalObjectiveCommands(issue.body);
    const declaredPreparation = objectivePreparationCommands(graph);
    // Only an exact current-phase prefix executes the full declared sequence
    // before later acceptance. Historical/other-checkout success never dedupes.
    const preparationCommands = declaredPreparation.every(
      (command, index) => finalCommands[index] === command,
    )
      ? []
      : declaredPreparation;
    assertPinnedNpmScripts(
      config.checkout,
      state.baseSha,
      candidateCommitSha,
      preparationCommands,
      {
        sourceDeclared: graph.items.flatMap((item) =>
          item.validation
            .filter((check) => check.provenance === "source-declared")
            .map((check) => check.command),
        ),
        workspacePackageAdditions: workspacePackageAdditions(issue.body),
        packageManagerUpdate: packageManagerUpdate(issue.body),
      },
    );
    assertPinnedNpmScripts(
      config.checkout,
      state.baseSha,
      candidateCommitSha,
      state.objectiveCommands ?? finalObjectiveCommands(issue.body),
      {
        sourceDeclared:
          state.objectiveCommands ?? finalObjectiveCommands(issue.body),
        workspacePackageAdditions: workspacePackageAdditions(issue.body),
        packageManagerUpdate: packageManagerUpdate(issue.body),
        requirePackageManagerUpdate: true,
      },
    );
    // Validation and fresh-clone hydration read the remote: one step,
    // repeatable from the top (a fresh worktree and clone per try), so a
    // transient fault repeats with backoff instead of stopping the Objective.
    const { commandEvidence, hydrationReceipt } = await objectiveStep(
      state,
      "final-validate",
      async () => {
        const commandEvidence = await validateTree(
          config.checkout,
          join(objectiveDirectory, "final-validation"),
          candidateCommitSha,
          finalTree,
          state.objectiveCommands ?? finalObjectiveCommands(issue.body),
          (entry) =>
            diagnostics.emit({
              runId: state.runId,
              operation: "objective-validation-command",
              outcome: entry.passed ? "completed" : "failed",
              ...(!entry.passed && { formalFailure: true as const }),
              durationMs: entry.durationMs,
              metadata: {
                commandIndex: entry.index,
                exitCode: entry.exitCode,
              },
              detail: entry.output,
            }),
          (entry) =>
            diagnostics.emitStream(
              {
                runId: state.runId,
                operation: "objective-validation-output",
                outcome: "observed",
                metadata: { commandIndex: entry.index, stream: entry.stream },
              },
              entry.output,
              entry.final,
            ),
          finalValidationLfsMembers(state),
          contentStore,
          state.baseSha,
          true,
          {
            commands: preparationCommands,
            observe: (entry) =>
              diagnostics.emit({
                runId: state.runId,
                operation: "environment-preparation-command",
                outcome: entry.passed ? "completed" : "failed",
                ...(!entry.passed && { formalFailure: true as const }),
                durationMs: entry.durationMs,
                metadata: {
                  scope: "final-fresh-checkout",
                  treeSha: finalTree,
                  commandIndex: entry.index,
                  command: preparationCommands[entry.index]!,
                  exitCode: entry.exitCode,
                },
                detail: entry.output,
              }),
            observeOutput: (entry) =>
              diagnostics.emitStream(
                {
                  runId: state.runId,
                  operation: "environment-preparation-output",
                  outcome: "observed",
                  metadata: {
                    scope: "final-fresh-checkout",
                    commandIndex: entry.index,
                    stream: entry.stream,
                  },
                },
                entry.output,
                entry.final,
              ),
          },
        );
        const selectedAssets = graph.items.flatMap((item) => {
          const work = state.work[item.id];
          const set = work?.assets?.find(
            (candidate) => candidate.id === work.selectedAssetSet,
          );
          return set ? [{ itemId: item.id, set }] : [];
        });
        const hydrationReceipt = selectedAssets.length
          ? await diagnostics.span(
              {
                runId: state.runId,
                operation: "media-hydration-verification",
                metadata: {
                  integratedSha: state.integratedSha!,
                  treeSha: finalTree,
                },
              },
              async () =>
                verifyHydratedAssets({
                  checkout: config.checkout,
                  workRoot: join(root, "hydration"),
                  integratedSha: candidateCommitSha,
                  selections: selectedAssets,
                }),
              (receipt) => ({ members: receipt?.members.length ?? 0 }),
            )
          : undefined;
        return { commandEvidence, hydrationReceipt };
      },
    );
    const acceptanceEvidence = hydrationReceipt
      ? { ...commandEvidence, hydrationReceipt }
      : commandEvidence;
    const objectiveEvidence = objectiveReviewEvidence({
      state,
      checkout: config.checkout,
      candidateCommitSha,
      candidateTreeSha: finalTree,
    });
    // A paid step, like item review: the call and the decoding of its
    // answer count toward the bound together, so a lost answer and an
    // invalid one are both asked again (the invalid one with its
    // validation error) until the bound makes it a decision. A criterion
    // the operator must judge comes back as the pending final acceptance.
    const reviewFinal = () =>
      objectiveStep(
        state,
        "final-review",
        (context) => {
          const previousInvalid = context.previousInvalid();
          return context.paid(() =>
            reviewAcceptance({
              beforeSubmit: stopIfCancelled,
              model: planningModel,
              reviewPhase: "objective-review",
              session: agentSessionContinuation(
                state,
                "objective-review",
                undefined,
                () => save(state),
              ),
              checkout: config.checkout,
              baseSha: state.baseSha,
              commit: candidateCommitSha,
              evidence: acceptanceEvidence,
              criteria: objectiveCriteria(issue.body),
              sources: planningSources(
                issue.body,
                state.baseSha,
                config.checkout,
              ),
              evidenceSources: [
                ...objectiveEvidence.evidence,
                ...reviewObjectiveKnowledge(
                  state,
                  undefined,
                  config.checkout,
                  candidateCommitSha,
                ),
                ...(hydrationReceipt
                  ? [
                      {
                        path: "Controller hydration receipt",
                        content: JSON.stringify(hydrationReceipt),
                      },
                    ]
                  : []),
              ],
              decisions: state.finalAcceptanceDecisions,
              observations: objectiveEvidence.observations,
              invocation: {
                invocationId: randomUUID(),
                phase: "objective-review",
                ordinal: 0,
                observe: diagnostics.modelObserver({
                  scopeId: state.runId,
                  runId: state.runId,
                }),
              },
              ...(previousInvalid ? { previousInvalid } : {}),
              onInvalid: (detail) => context.invalid(detail),
            }),
          );
        },
        true,
      );
    const reviewed = await diagnostics.span(
      {
        runId: state.runId,
        operation: "objective-acceptance-review",
        metadata: {
          treeSha: finalTree,
          candidateCommitSha,
          candidateBasis: objectiveCandidate(state)!.basis,
          ...(state.integratedSha
            ? { integratedSha: state.integratedSha }
            : {}),
        },
      },
      reviewFinal,
      (outcome) => ({ criteria: outcome.evidence?.criteria?.length ?? 0 }),
    );
    if (reviewed.pending) {
      state.coordinator!.phase = "waiting";
      state.finalAcceptancePending = reviewed.pending;
      save(state);
      diagnostics.emit({
        runId: state.runId,
        operation: "objective-validation",
        outcome: "waiting",
        durationMs: Date.now() - finalValidationStarted,
        metadata: { treeSha: finalTree },
        detail: JSON.stringify({
          question: reviewed.pending.question,
          detail: reviewed.pending.detail,
          reviewFinding: reviewed.pending.reviewFinding ?? null,
        }),
      });
      return state;
    }
    const finalEvidence = reviewed.evidence;
    stopIfCancelled();
    delete state.finalAcceptancePending;
    if (
      state.coordinator!.mode !== "running" ||
      amendmentBlocksDispatch(state) ||
      graphDigest(state.graph) !== finalGraphDigest ||
      objectiveCandidate(state)?.commitSha !== candidateCommitSha
    ) {
      save(state);
      return state;
    }
    // The default branch moved during final validation: validate its head.
    if (await followDefaultBranch()) continue;
    // No await between this CAS, the immutable seal and pending closure persistence.
    if (
      cancellationRequested() ||
      state.coordinator!.mode !== "running" ||
      amendmentBlocksDispatch(state) ||
      graphDigest(state.graph) !== finalGraphDigest ||
      objectiveCandidate(state)?.commitSha !== candidateCommitSha
    ) {
      save(state);
      return state;
    }
    state.finalValidation = { ...finalEvidence, passed: true };
    sealFinalAcceptance(state);
    diagnostics.emit({
      runId: state.runId,
      operation: "objective-validation",
      outcome: "completed",
      durationMs: Date.now() - finalValidationStarted,
      metadata: {
        treeSha: finalTree,
        candidateCommitSha,
        candidateBasis: objectiveCandidate(state)!.basis,
        ...(state.integratedSha ? { integratedSha: state.integratedSha } : {}),
      },
    });
    save(state);
    await closeObjectiveIssue(
      state,
      issue.body,
      github,
      () => save(state),
      objectiveSignal(),
      objectivePause(),
    );
    return state;
  }
}
