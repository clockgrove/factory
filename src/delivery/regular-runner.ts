import { assertDeliveryReady } from "./readiness.js";
import { DeliveryReadinessPending } from "./readiness.js";
import { workerContext } from "../execution/checkpoint.js";
import {
  recordWorkFailure,
  diagnoseWorkRepair,
  repeatInterrupted,
} from "../work-repair.js";
import {
  executeItem,
  operatorWait,
  reviewItem,
  validateItem,
} from "../item-steps.js";
import { workspacePackageAdditions } from "../workspace-membership.js";
import { graphDigest, recordWorkerDiscovery } from "../graph-amendments.js";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { planningSources } from "../compiler.js";
import { closeWorkItem } from "../completion.js";
import type { FactoryConfig } from "../config.js";
import type {
  ContentStore,
  DeliveryStrategy,
  DeliveryResult,
  ExecutionDriver,
  GitHubGateway,
  PlanningModel,
  WorkItem,
} from "../contracts.js";
import { AuthenticationRequiredError } from "../contracts.js";
import type { DiagnosticEmitter } from "../diagnostics.js";
import {
  materializeAssetSet,
  selectedInputsForItem,
  validationLfsMembersForItem,
} from "../media.js";
import { attachFault, transient } from "../fault.js";
import { earlierHeads } from "../repair-policy.js";
import { fetchHead, git } from "../process.js";
import { preflightItemEnvironment, runQaItem } from "../qa-execution.js";
import { phaseAdmission } from "../phase-admission.js";
import { readyItems } from "../scheduler.js";
import type { FactoryState } from "../state.js";
import {
  validateWorkItem,
  workItemReviewEvidence,
  workItemReviewObservations,
} from "../validation.js";

export async function runRegularGraph(args: {
  config: FactoryConfig;
  objective: number;
  objectiveBody: string;
  root: string;
  state: FactoryState;
  driver: ExecutionDriver;
  delivery: DeliveryStrategy;
  contentStore: ContentStore;
  github: GitHubGateway;
  planningModel: PlanningModel;
  save: () => void;
  active: Map<string, Promise<void>>;
  cancelled: () => boolean;
  paused?: () => boolean;
  amendmentPending?: () => boolean;
  reconcile?: () => Promise<void>;
  diagnostics?: DiagnosticEmitter;
}): Promise<boolean> {
  const {
    config,
    objective,
    root,
    state,
    driver,
    delivery,
    contentStore,
    github,
    save,
    active,
  } = args;
  const phases = phaseAdmission(state, save, args.cancelled);
  const graph = state.graph;
  const baseSha = state.baseSha;
  let failure: unknown;
  let mergeTail: Promise<void> = Promise.resolve();
  const integratePublished = async (
    item: WorkItem,
    published: DeliveryResult,
  ): Promise<void> => {
    const work = state.work[item.id]!;
    const readinessWasWaiting = Boolean(work.waitingReason);
    if (args.paused?.() && readinessWasWaiting) return;
    await phases.reserve(item.id, "delivery");
    const integrate = mergeTail.then(async () => {
      const merge = async () => {
        if (args.cancelled()) throw new Error("Objective cancelled");
        await args.reconcile?.();
        const merged = await delivery.merge(published, (observation) => {
          assertDeliveryReady(
            observation,
            (state.graph.requiredPreIntegrationChecks ?? []).map(
              (check) => check.checkName,
            ),
            published.headSha,
          );
          if (args.cancelled()) throw new Error("Objective cancelled");
          if (args.paused?.() && readinessWasWaiting)
            throw new DeliveryReadinessPending();
          work.preIntegrationChecks = observation.namedChecks ?? [];
          delete work.waitingReason;
          save();
        });
        const defaultHead = await fetchHead(
          config.checkout,
          await github.defaultBranch(),
        );
        // Other work may have merged since; the merge commit only needs to
        // be part of the default branch.
        try {
          git(
            config.checkout,
            "merge-base",
            "--is-ancestor",
            merged.integratedSha,
            defaultHead,
          );
        } catch (cause) {
          // Read-after-merge lag until the step's window passes (#515).
          const message = `Default branch does not contain the merge of PR #${published.pullRequest} (${merged.integratedSha})`;
          throw attachFault(
            new Error(message, { cause }),
            transient(message, false),
          );
        }
        return merged.integratedSha;
      };
      const observedHead = args.diagnostics
        ? await args.diagnostics.span(
            {
              runId: state.runId,
              itemId: item.id,
              attemptId: work.attempt,
              operation: "github-merge",
              metadata: {
                pullRequest: published.pullRequest,
                headSha: work.changeRef!,
              },
            },
            merge,
            (headSha) => ({ integratedSha: headSha }),
          )
        : await merge();
      state.integratedSha = observedHead;
      work.integratedSha = observedHead;
      work.status = "done";
      work.completedAt = new Date().toISOString();
      delete work.step;
      delete work.waitingReason;
      save();
    });
    mergeTail = integrate.then(
      () => undefined,
      () => undefined,
    );
    await integrate;
    // The delivery slot frees only once closure is durable, so the scheduler
    // never starts dependent work while this item's issue is closing.
    try {
      await closeWorkItem(state, item.id, github, save, false);
    } finally {
      phases.release(item.id);
    }
  };
  // Publication finds an existing open PR for the deterministic branch
  // before creating one, so a restart at "deliver" simply runs this again.
  const deliverReviewed = async (
    item: WorkItem,
    itemBase: string,
  ): Promise<void> => {
    const work = state.work[item.id]!;
    await phases.reserve(item.id, "delivery");
    work.step = "deliver";
    save();
    const branch = `factory/objective-${objective}/${item.id}`;
    const publish = () =>
      delivery.publish({
        item,
        baseSha: itemBase,
        treeSha: work.treeSha!,
        changeRef: work.changeRef!,
        branch,
        lfs: Boolean(work.selectedAssetSet),
        earlierHeads: earlierHeads(work),
      });
    await args.reconcile?.();
    const published = args.diagnostics
      ? await args.diagnostics.span(
          {
            runId: state.runId,
            itemId: item.id,
            attemptId: work.attempt,
            operation: "github-publication",
            metadata: {
              baseSha: itemBase,
              treeSha: work.treeSha!,
              headSha: work.changeRef!,
            },
          },
          publish,
          (result) => ({ pullRequest: result.pullRequest }),
        )
      : await publish();
    work.pullRequest = published.pullRequest;
    work.status = "published";
    delete work.step;
    save();
    await integratePublished(item, published);
  };
  // Publication and merge still repeat interruptions (bounded) until the
  // delivery steps move to `step`.
  const deliver = (item: WorkItem, itemBase: string): Promise<void> => {
    const work = state.work[item.id]!;
    return repeatInterrupted(work, save, () =>
      work.status === "published"
        ? integratePublished(item, {
            branch: `factory/objective-${objective}/${item.id}`,
            pullRequest: work.pullRequest!,
            headSha: work.changeRef!,
          })
        : deliverReviewed(item, itemBase),
    );
  };
  const runStep = async (item: WorkItem, itemBase: string): Promise<void> => {
    const work = state.work[item.id]!;
    if (work.status === "published") {
      await deliver(item, itemBase);
      return;
    }
    if (item.kind === "qa" || item.kind === "aggregate") {
      if (args.paused?.() && work.waitingReason) return;
      await runQaItem({
        config,
        root,
        state,
        item,
        github,
        model: args.planningModel,
        diagnostics: args.diagnostics,
        objectiveBody: args.objectiveBody,
        store: contentStore,
        save,
        cancelled: args.cancelled,
        paused: args.paused,
        phases,
      });
      return;
    }
    if (work.step === "deliver" && work.validation) {
      await deliver(item, itemBase);
      return;
    }
    if (work.step === "execute") {
      if (!work.execution) {
        await phases.reserve(item.id, "validation");
        await preflightItemEnvironment({
          config,
          root,
          state,
          objectiveBody: args.objectiveBody,
          item,
          store: contentStore,
          baseSha: itemBase,
        });
      }
      // A reattached worker keeps the coding slot it holds while it runs remotely.
      if (work.phaseReservation !== "coding")
        await phases.reserve(item.id, "coding");
      const result = await executeItem({
        state,
        item,
        driver,
        save,
        cancelled: args.cancelled,
        diagnostics: args.diagnostics,
        request: (attemptId) => ({
          captureContext: { objective, runId: state.runId },
          item: work.recovery?.correction
            ? {
                ...item,
                brief: `${item.brief}\nDiagnosed repair: ${work.recovery.correction.diagnosis}\nRequired correction: ${work.recovery.correction.correction}`,
              }
            : item,
          baseSha: itemBase,
          attemptId,
          objectiveBody: args.objectiveBody,
          selectedAssets: selectedInputsForItem(state, item),
        }),
      });
      phases.release(item.id);
      if (result.collection)
        args.diagnostics?.emit({
          runId: state.runId,
          itemId: item.id,
          attemptId: work.attempt,
          operation: "collection-ignored-links",
          outcome: "completed",
          metadata: {
            observation: "original-worktree-scan",
            acceptedIgnoredLinkCount:
              result.collection.acceptedIgnoredLinks.length,
            treeSha: result.treeSha,
            headSha: result.changeRef,
          },
          detail: JSON.stringify(result.collection),
        });
      if (args.cancelled()) throw new Error("Objective cancelled");
      // Recorded once; the handle stays as the attempt's actual execution.
      recordWorkerDiscovery(state, item.id, result.discovery);
      work.changeRef = result.changeRef;
      work.treeSha = result.treeSha;
      if (result.assets?.length) {
        work.assets = result.assets;
        work.status = "waiting";
        work.step = "approve-asset";
        save();
        return;
      }
    } else if (work.step === "approve-asset") {
      await phases.reserve(item.id, "validation");
      const selected = work.assets?.find(
        (set) => set.id === work.selectedAssetSet,
      );
      if (!selected || !work.changeRef)
        throw new Error("Selected AssetSet or captured change is missing");
      const materialize = () =>
        materializeAssetSet({
          checkout: config.checkout,
          workRoot: join(root, "asset-materialization"),
          baseCommit: work.changeRef!,
          item,
          set: selected,
          store: contentStore,
        });
      const applied = args.diagnostics
        ? await args.diagnostics.span(
            {
              runId: state.runId,
              itemId: item.id,
              attemptId: work.attempt,
              operation: "media-materialization",
              metadata: { setId: selected.id },
            },
            materialize,
            (result) => ({
              treeSha: result.treeSha,
              headSha: result.changeRef,
            }),
          )
        : await materialize();
      work.changeRef = applied.changeRef;
      work.treeSha = applied.treeSha;
    }
    await phases.reserve(item.id, "validation");
    work.step = "validate";
    save();
    work.validation = await validateItem({
      state,
      item,
      save,
      validate: () =>
        validateWorkItem(
          config.checkout,
          join(root, "validation", item.id),
          item,
          work.changeRef!,
          work.treeSha!,
          state.baseSha,
          (entry) =>
            args.diagnostics?.emit({
              runId: state.runId,
              itemId: item.id,
              attemptId: work.attempt,
              operation: "validation-command",
              outcome: entry.passed ? "completed" : "failed",
              durationMs: entry.durationMs,
              metadata: {
                commandIndex: entry.index,
                exitCode: entry.exitCode,
                treeSha: work.treeSha!,
              },
              detail: entry.output,
            }),
          (entry) =>
            args.diagnostics?.emitStream(
              {
                runId: state.runId,
                itemId: item.id,
                attemptId: work.attempt,
                operation: "validation-output",
                outcome: "observed",
                metadata: { commandIndex: entry.index, stream: entry.stream },
              },
              entry.output,
              entry.final,
            ),
          itemBase,
          validationLfsMembersForItem(
            state,
            item,
            config.checkout,
            work.changeRef!,
          ),
          args.contentStore,
          workspacePackageAdditions(args.objectiveBody),
        ),
    });
    await phases.reserve(item.id, "review");
    const review = () =>
      reviewItem({
        state,
        item,
        save,
        review: (retry) => ({
          ...retry,
          model: args.planningModel,
          checkout: config.checkout,
          baseSha: itemBase,
          commit: work.changeRef!,
          evidence: work.validation!,
          criteria: item.acceptance,
          sources: planningSources(
            args.objectiveBody,
            state.baseSha,
            config.checkout,
          ),
          decisions: work.acceptanceDecisions,
          evidenceSources: workItemReviewEvidence({
            state,
            item,
            checkout: config.checkout,
            delivery: "regular",
          }),
          observations: workItemReviewObservations(
            state,
            item,
            { kind: "regular" },
            work.assets?.find((set) => set.id === work.selectedAssetSet),
          ),
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
        }),
      });
    const reviewed = args.diagnostics
      ? await args.diagnostics.span(
          {
            runId: state.runId,
            itemId: item.id,
            attemptId: work.attempt,
            operation: "acceptance-review",
            metadata: { treeSha: work.treeSha! },
          },
          review,
          (outcome) => ({
            criteria: outcome.evidence?.criteria?.length ?? 0,
          }),
        )
      : await review();
    if (reviewed.pending) {
      phases.release(item.id);
      work.status = "waiting";
      work.step = "approve-result";
      work.acceptancePending = reviewed.pending;
      save();
      return;
    }
    work.validation = reviewed.evidence;
    delete work.acceptancePending;
    if (args.cancelled()) throw new Error("Objective cancelled");
    await deliver(item, itemBase);
  };
  /** Stop the item's own worker after its attempt failed, so a retry never runs beside it. */
  const stopWorker = async (item: WorkItem): Promise<void> => {
    const work = state.work[item.id]!;
    if (!work.execution) return;
    try {
      await driver.cancel(
        structuredClone(work.execution),
        workerContext(work, save, args.cancelled, args.diagnostics, {
          runId: state.runId,
          itemId: item.id,
        }),
      );
      delete work.execution;
    } catch {
      // Left recorded: retry refuses until the worker is confirmed stopped.
    }
  };
  const execute = async (item: WorkItem, itemBase: string): Promise<void> => {
    const work = state.work[item.id]!;
    try {
      await runStep(item, itemBase);
    } catch (error) {
      if (error instanceof DeliveryReadinessPending) {
        work.waitingReason = error.message;
        phases.release(item.id);
        save();
        return;
      }
      if (work.status !== "done") work.status = "failed";
      work.error = error instanceof Error ? error.message : String(error);
      if (
        error instanceof AuthenticationRequiredError &&
        work.status === "failed"
      )
        work.authentication = error.authentication;
      else delete work.authentication;
      if (work.status === "failed" && work.step === "execute")
        await stopWorker(item);
      if (work.phaseReservation !== "coding") phases.release(item.id);
      const isolated = recordWorkFailure(state, item.id, error);
      if (isolated && !args.cancelled()) {
        phases.release(item.id);
        save();
        await phases.reserve(item.id, "review");
        try {
          await diagnoseWorkRepair({
            state,
            item,
            model: args.planningModel,
            diagnostics: args.diagnostics,
            sources: planningSources(
              args.objectiveBody,
              state.baseSha,
              config.checkout,
            ),
            save,
            stopped: () =>
              args.cancelled() ||
              Boolean(args.paused?.()) ||
              Boolean(args.amendmentPending?.()),
          });
        } finally {
          phases.release(item.id);
        }
        return;
      }
      save();
      // A decision or a configuration fix waits on this item only: the run
      // goes on, and `factory retry` or the fix continues it.
      if (operatorWait(error)) return;
      failure ??= error;
      throw error;
    }
  };
  for (const item of graph.items) {
    const work = state.work[item.id]!;
    if (work.status === "published") {
      const promise = execute(item, work.baseSha!).finally(() =>
        active.delete(item.id),
      );
      void promise.catch(() => undefined);
      active.set(item.id, promise);
      continue;
    }
    if (work.status !== "running") continue;
    if (item.kind === "qa" || item.kind === "aggregate") {
      const promise = execute(item, state.integratedSha ?? baseSha).finally(
        () => active.delete(item.id),
      );
      void promise.catch(() => undefined);
      active.set(item.id, promise);
      continue;
    }
    if (
      (work.step === "validate" || work.step === "deliver") &&
      work.baseSha &&
      work.changeRef &&
      work.treeSha
    ) {
      const promise = execute(item, work.baseSha).finally(() =>
        active.delete(item.id),
      );
      void promise.catch(() => undefined);
      active.set(item.id, promise);
      continue;
    }
    if (
      work.step === "approve-asset" &&
      work.selectedAssetSet &&
      work.baseSha
    ) {
      const promise = execute(item, work.baseSha).finally(() =>
        active.delete(item.id),
      );
      void promise.catch(() => undefined);
      active.set(item.id, promise);
      continue;
    }
    // An execute step resumes with or without a recorded handle: the attempt
    // id was saved before start, and the driver adopts or stops it.
    if (work.step !== "execute" || !work.attempt || !work.baseSha) {
      throw new Error(
        `Work Item ${item.id} has ambiguous active state at ${work.step ?? "unknown"}; operator direction required`,
      );
    }
    const promise = execute(item, work.baseSha).finally(() => {
      active.delete(item.id);
    });
    void promise.catch(() => undefined);
    active.set(item.id, promise);
  }
  while (graph.items.some((item) => state.work[item.id]?.status !== "done")) {
    if (failure) throw failure;
    if (args.cancelled()) throw new Error("Objective cancelled");
    const reported = await driver.availableSlots();
    args.diagnostics?.emit({
      runId: state.runId,
      operation: "scheduling-capacity",
      outcome: "observed",
      metadata: {
        driverAvailableSlots: reported,
        operatorCeiling: state.capacity.concurrency,
        codingReservations: phases.codingCount(),
      },
    });
    const slots = graph.items.length;
    let workerSlots = phases.availableSlots(reported);
    const ready =
      args.paused?.() || args.amendmentPending?.()
        ? []
        : readyItems(
            graph,
            state.work,
            new Set([
              ...active.keys(),
              ...graph.items
                .filter((item) =>
                  ["waiting", "published"].includes(
                    state.work[item.id]!.status,
                  ),
                )
                .map((item) => item.id),
            ]),
            slots,
          ).filter((item) => {
            const blocked =
              item.kind === "qa" || item.kind === "aggregate"
                ? undefined
                : (phases.reason(item.id, "coding") ??
                  (workerSlots <= 0
                    ? reported === "unknown"
                      ? "operator coding ceiling; provider capacity unknown"
                      : "driver or operator coding capacity"
                    : undefined));
            if (blocked) {
              state.work[item.id]!.waitingReason = blocked;
              return false;
            }
            delete state.work[item.id]!.waitingReason;
            if (item.kind !== "qa" && item.kind !== "aggregate") workerSlots--;
            return true;
          });
    if (ready.length) await args.reconcile?.();
    for (const item of ready) {
      if (args.cancelled()) throw new Error("Objective cancelled");
      if (args.paused?.() || args.amendmentPending?.()) break;
      const work = state.work[item.id]!;
      work.status = "running";
      work.step = "execute";
      work.attempt = randomUUID();
      work.graphRevisionDigest = graphDigest(state.graph);
      work.startedAt = new Date().toISOString();
      const itemBase = state.integratedSha ?? baseSha;
      work.baseSha = itemBase;
      work.executionBaseSha = itemBase;
      work.integratedShaAtStart = state.integratedSha ?? null;
      save();
      const promise = execute(item, itemBase).finally(() => {
        active.delete(item.id);
      });
      void promise.catch(() => undefined);
      active.set(item.id, promise);
    }
    if (
      !active.size &&
      graph.items.some((item) => state.work[item.id]?.status === "waiting")
    )
      return true;
    if (!active.size && args.paused?.()) return true;
    if (failure) throw failure;
    if (!active.size) return true;
    await Promise.race([...active.values(), phases.changed()]);
  }
  await Promise.all(active.values());
  if (failure) throw failure;
  return false;
}
