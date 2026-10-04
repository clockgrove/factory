import { assertIntegrated, laterIntegration } from "./integration.js";
import { deliveryReadiness } from "./readiness.js";
import { workerContext } from "../execution/checkpoint.js";
import { recordWorkFailure, diagnoseWorkRepair } from "../work-repair.js";
import {
  cancelledFault,
  executeItem,
  reportCancelled,
  reviewItem,
  staysInPlace,
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
import { currentProcessSignal } from "../process.js";
import { preflightItemEnvironment, runQaItem } from "../qa-execution.js";
import { phaseAdmission } from "../phase-admission.js";
import { readyItems } from "../scheduler.js";
import type { FactoryState } from "../state.js";
import {
  clearWait,
  repeatKey,
  setWait,
  type StepContext,
  StepPaused,
  step,
} from "../step.js";
import {
  deliveredHead,
  deliveryEarlierHeads,
  updateBehindBranch,
} from "./branch-update.js";
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
  /** The Objective run's cancel signal, passed to every step. */
  signal?: AbortSignal;
  /** The owner's pause, drain or handoff signal, passed to every step. */
  pause?: AbortSignal;
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
  const signal = args.signal ?? currentProcessSignal();
  /** The operator cancelled the Objective. */
  const stopped = () => Boolean(signal?.aborted || args.cancelled());
  /** Faults the Objective's re-observation raised: the Objective's, not an item's. */
  const objectiveFaults = new WeakSet<object>();
  const reconcile = async (): Promise<void> => {
    try {
      await args.reconcile?.();
    } catch (error) {
      if (error !== null && typeof error === "object")
        objectiveFaults.add(error);
      throw error;
    }
  };
  /**
   * Cancel the run: items stop at their own safe points first, so each
   * one's state and diagnostics settle before the run reports the cancel.
   */
  const cancelRun = async (): Promise<Error> => {
    await Promise.allSettled(active.values());
    return cancelledFault();
  };
  /** What a diagnostics span records for one try of a delivery step. */
  interface Span<T> {
    operation: string;
    metadata: Record<string, string | number>;
    summarize: (result: T) => Record<string, string | number>;
  }
  /** Run one delivery step of an item; its span records each try. */
  const deliveryStep = <T>(
    item: WorkItem,
    name: "publish" | "await-ci" | "merge",
    fn: (context: StepContext) => Promise<T>,
    span?: Span<T>,
    pause = args.pause,
  ): Promise<T> =>
    step(
      state,
      { scope: { item: item.id }, name },
      (context) =>
        args.diagnostics && span
          ? args.diagnostics.span(
              {
                runId: state.runId,
                itemId: item.id,
                attemptId: state.work[item.id]!.attempt,
                operation: span.operation,
                metadata: span.metadata,
              },
              () => fn(context),
              span.summarize,
            )
          : fn(context),
      { save, signal, pause },
    );
  /** The owner paused while this item waits for CI: stop polling. */
  const pausedWhileWaiting = (item: WorkItem): boolean =>
    Boolean(args.paused?.()) && state.work[item.id]!.wait?.kind === "ci";
  /**
   * The pause signal of one item's CI wait: the owner's, and aborted here
   * when a poll finds the owner paused, so the wait ends with `StepPaused`
   * and keeps its record and wait.
   */
  const ciPause = () => {
    const local = new AbortController();
    return {
      abort: () => local.abort(),
      signal: args.pause
        ? AbortSignal.any([args.pause, local.signal])
        : local.signal,
    };
  };
  /**
   * Publish a reviewed item, wait for its CI, merge it. Every effect is
   * observed before it is made, so a restart at any point runs the steps
   * again: publish (unless published), await-ci, merge.
   */
  const deliver = async (item: WorkItem, itemBase: string): Promise<void> => {
    const work = state.work[item.id]!;
    const branch = `factory/objective-${objective}/${item.id}`;
    if (work.status !== "published") {
      await phases.reserve(item.id, "delivery");
      work.step = "deliver";
      save();
      await reconcile();
      const published = await deliveryStep(
        item,
        "publish",
        () =>
          delivery.publish({
            item,
            baseSha: itemBase,
            treeSha: work.treeSha!,
            changeRef: work.changeRef!,
            branch,
            lfs: Boolean(work.selectedAssetSet),
            earlierHeads: deliveryEarlierHeads(work),
          }),
        {
          operation: "github-publication",
          metadata: {
            baseSha: itemBase,
            treeSha: work.treeSha!,
            headSha: work.changeRef!,
          },
          summarize: (result) => ({ pullRequest: result.pullRequest }),
        },
      );
      work.pullRequest = published.pullRequest;
      work.status = "published";
      delete work.step;
      save();
    }
    // The CI wait holds no phase reservation; the merge does.
    phases.release(item.id);
    const published: DeliveryResult = {
      branch,
      pullRequest: work.pullRequest!,
      headSha: deliveredHead(work)!,
      earlierHeads: deliveryEarlierHeads(work),
    };
    if (pausedWhileWaiting(item))
      throw new StepPaused(repeatKey({ item: item.id }, "await-ci"));
    await reconcile();
    /**
     * Strict protection: GitHub updates the branch with its base from
     * exactly `from`. The new head is the delivered head; its checks run
     * again.
     */
    const updateBranch = async (
      context: StepContext,
      from: string,
    ): Promise<never> => {
      const head = await updateBehindBranch({
        github,
        work,
        save,
        identity: { number: published.pullRequest, branch },
        from,
      });
      context.progress();
      published.headSha = head;
      published.earlierHeads = deliveryEarlierHeads(work);
      return context.pending({
        kind: "ci",
        detail: `Awaiting checks on PR #${published.pullRequest} after GitHub updated it with its base`,
      });
    };
    /** Observe the PR; return it when it may merge, else wait for CI. */
    const ready = async (context: StepContext) => {
      // An update already requested is finished before the PR is read: its
      // head is GitHub's merge, not a foreign change.
      if (work.branchUpdate) await updateBranch(context, work.branchUpdate);
      const observation = await delivery.observe(published);
      context.progress();
      if (observation.mergeReadiness === "behind")
        await updateBranch(context, published.headSha);
      const pending = deliveryReadiness(
        published.pullRequest,
        observation,
        (state.graph.requiredPreIntegrationChecks ?? []).map(
          (check) => check.checkName,
        ),
        published.headSha,
      );
      if (pending) context.pending({ kind: "ci", detail: pending });
      return observation;
    };
    const pause = ciPause();
    const observation = await deliveryStep(
      item,
      "await-ci",
      async (context) => {
        // Paused while waiting: keep the wait; the step stops before its
        // next poll.
        if (pausedWhileWaiting(item)) {
          pause.abort();
          context.pending({ kind: "ci", detail: work.wait!.detail });
        }
        return ready(context);
      },
      undefined,
      pause.signal,
    );
    work.preIntegrationChecks = observation.namedChecks ?? [];
    save();
    await phases.reserve(item.id, "delivery");
    // Merges run one at a time, so each sees the last one's result.
    const merged = mergeTail.then(() =>
      deliveryStep(
        item,
        "merge",
        async (context) => {
          // Readiness can change after await-ci (a conflict, a failed
          // check): judge it again before the merge is sent.
          await ready(context);
          const merged = await delivery.merge(published);
          context.progress();
          await assertIntegrated(
            config.checkout,
            await github.defaultBranch(),
            merged.integratedSha,
            `PR #${published.pullRequest}`,
          );
          return {
            merge: merged.integratedSha,
            integrated: await laterIntegration(
              config.checkout,
              state.integratedSha,
              merged.integratedSha,
            ),
          };
        },
        {
          operation: "github-merge",
          metadata: {
            pullRequest: published.pullRequest,
            headSha: published.headSha,
          },
          summarize: (result) => ({ integratedSha: result.merge }),
        },
      ),
    );
    mergeTail = merged.then(
      () => undefined,
      () => undefined,
    );
    const result = await merged;
    state.integratedSha = result.integrated;
    work.integratedSha = result.merge;
    work.status = "done";
    work.completedAt = new Date().toISOString();
    delete work.step;
    save();
    // The delivery slot frees only once closure is durable, so the scheduler
    // never starts dependent work while this item's issue is closing.
    try {
      await closeWorkItem(
        state,
        item.id,
        github,
        save,
        false,
        signal,
        args.pause,
      );
    } finally {
      phases.release(item.id);
    }
  };
  const runStep = async (item: WorkItem, itemBase: string): Promise<void> => {
    const work = state.work[item.id]!;
    if (work.status === "published") {
      await deliver(item, itemBase);
      return;
    }
    if (item.kind === "qa" || item.kind === "aggregate") {
      if (args.paused?.() && work.wait?.kind === "ci") return;
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
        signal,
        pause: args.pause,
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
        signal,
        pause: args.pause,
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
      if (stopped()) throw cancelledFault();
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
      signal,
      pause: args.pause,
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
        signal,
        pause: args.pause,
        cancelled: args.cancelled,
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
    if (stopped()) throw cancelledFault();
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
      // Left recorded: the next attempt starts only once the driver
      // confirmed it stopped.
    }
  };
  const execute = async (item: WorkItem, itemBase: string): Promise<void> => {
    const work = state.work[item.id]!;
    try {
      await runStep(item, itemBase);
    } catch (error) {
      // The Objective's own fault leaves the item where it is; the Objective
      // answers it.
      if (objectiveFaults.has(error as object)) {
        if (!work.execution) phases.release(item.id);
        save();
        if (staysInPlace(error)) return;
        failure ??= error;
        throw error;
      }
      // Step rule 7: a decision or a configuration fix waits on this item
      // only, and cancel or pause stops it quietly. The item keeps its
      // place, its worker keeps running, and the run goes on.
      if (staysInPlace(error)) {
        if (error instanceof AuthenticationRequiredError)
          work.authentication = error.authentication;
        if (!work.execution) phases.release(item.id);
        save();
        reportCancelled(error, state, item.id, args.diagnostics);
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
      // A wrong result is repaired, published or not: the next attempt
      // republishes the same branch with a lease.
      const isolated = recordWorkFailure(state, item.id, error);
      if (isolated && !stopped()) {
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
            signal,
            pause: args.pause,
            stopped: () =>
              stopped() ||
              Boolean(args.paused?.()) ||
              Boolean(args.amendmentPending?.()),
          });
        } finally {
          phases.release(item.id);
        }
        return;
      }
      save();
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
    if (stopped()) throw await cancelRun();
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
              setWait(
                state,
                { item: item.id },
                {
                  kind: "capacity",
                  detail: blocked,
                },
              );
              return false;
            }
            clearWait(state, { item: item.id });
            if (item.kind !== "qa" && item.kind !== "aggregate") workerSlots--;
            return true;
          });
    if (ready.length) await args.reconcile?.();
    for (const item of ready) {
      if (stopped()) throw await cancelRun();
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
