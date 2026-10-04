import { assertIntegrated, laterIntegration } from "./integration.js";
import { cancelledFault } from "../fault.js";
import { assertCheckSourcesAtIntegration } from "./check-sources.js";
import { deliveryReadiness, unreportedGates } from "./readiness.js";
import { runWorker, stopWorker as stopSharedWorker } from "../item-worker.js";
import { recordWorkFailure, diagnoseWorkRepair } from "../work-repair.js";
import {
  reportCancelled,
  reviewItem,
  staysInPlace,
  validateItem,
} from "../item-steps.js";
import { workspacePackageAdditions } from "../workspace-membership.js";
import { graphDigest } from "../graph-amendments.js";
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
import { faultOf } from "../fault.js";
import { materializeAssetSet, validationLfsMembersForItem } from "../media.js";
import { currentProcessSignal } from "../process.js";
import { runQaItem } from "../qa-execution.js";
import { phaseAdmission } from "../phase-admission.js";
import { readyItems } from "../scheduler.js";
import type { FactoryState } from "../state.js";
import {
  awaitsOperator,
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
  retireDeliveredHead,
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
  /** Settles when the owner is woken (an operator's live control action). */
  woken?: () => Promise<void>;
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
    // The operator answered "PR closed without a merge" with a retry (the
    // answer cleared the wait): the reviewed result gets a new PR on its
    // branch. The closed PR can never merge, so observing it again would
    // only ask the same question.
    if (
      work.status === "published" &&
      work.closedPullRequest !== undefined &&
      work.closedPullRequest === work.pullRequest &&
      !awaitsOperator(work.wait)
    ) {
      retireDeliveredHead(work);
      delete work.pullRequest;
      delete work.closedPullRequest;
      work.status = "running";
      work.step = "deliver";
      save();
    }
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
    // The CI wait is a safe point: a pause, drain or handoff stops here
    // with the wait recorded, and the next run polls CI at once.
    if (args.paused?.()) {
      if (work.wait?.kind !== "ci") {
        setWait(
          state,
          { item: item.id },
          {
            kind: "ci",
            detail: `Awaiting checks on PR #${published.pullRequest}`,
          },
        );
        save();
      }
      throw new StepPaused(repeatKey({ item: item.id }, "await-ci"));
    }
    // The await-ci step records its own wait from its first poll.
    if (work.wait?.kind === "ci" && clearWait(state, { item: item.id })) save();
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
      if (work.branchUpdateFrom)
        await updateBranch(context, work.branchUpdateFrom);
      context.progress();
      const observation = await delivery.observe(published);
      context.progress();
      // A gate that has not reported on this head, and whose job main has
      // renamed, never will. A gate already on the head, or a merged PR,
      // is not asked.
      await assertCheckSourcesAtIntegration({
        graph: state.graph,
        baseSha: state.baseSha,
        objectiveBody: args.objectiveBody,
        checkout: config.checkout,
        gates: unreportedGates(
          observation,
          (state.graph.requiredPreIntegrationChecks ?? []).map(
            (check) => check.checkName,
          ),
          published.headSha,
        ),
        defaultBranch: () => github.defaultBranch(),
      });
      if (observation.mergeReadiness === "behind")
        await updateBranch(context, published.headSha);
      let pending: string | undefined;
      try {
        pending = deliveryReadiness(
          published.pullRequest,
          observation,
          (state.graph.requiredPreIntegrationChecks ?? []).map(
            (check) => check.checkName,
          ),
          published.headSha,
        );
      } catch (error) {
        // Past GitHub's lag a closed PR is a question for the operator;
        // remember which PR, so the retry that answers it starts a new one.
        if (
          observation.state === "closed" &&
          faultOf(error).kind === "decision"
        ) {
          work.closedPullRequest = published.pullRequest;
          save();
        }
        throw error;
      }
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
      // The handle stays as the attempt's actual execution.
      const result = await runWorker({
        state,
        item,
        driver,
        save,
        cancelled: args.cancelled,
        diagnostics: args.diagnostics,
        config,
        root,
        objective,
        objectiveBody: args.objectiveBody,
        store: contentStore,
        phases,
        signal,
        pause: args.pause,
        baseSha: itemBase,
      });
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
        diagnostics: args.diagnostics,
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
    // The review step records its own span per ask.
    const reviewed = await review();
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
  const stopWorker = (item: WorkItem): Promise<void> =>
    stopSharedWorker({
      state,
      item,
      driver,
      save,
      cancelled: args.cancelled,
      diagnostics: args.diagnostics,
    });
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
        // The operator's live `factory retry` clears the wait: the item
        // then resumes in this pass.
        if (awaitsOperator(work.wait)) parked.add(item.id);
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
  /** Items stopped in place for an operator's answer. */
  const parked = new Set<string>();
  const dispatch = (item: WorkItem, itemBase: string): void => {
    const promise = execute(item, itemBase).finally(() =>
      active.delete(item.id),
    );
    void promise.catch(() => undefined);
    active.set(item.id, promise);
  };
  /** Drive a running or published item on from where its state stands. */
  const resume = (item: WorkItem): void => {
    const work = state.work[item.id]!;
    if (work.status === "published") dispatch(item, work.baseSha!);
    else if (work.status !== "running") return;
    else if (item.kind === "qa" || item.kind === "aggregate")
      dispatch(item, state.integratedSha ?? baseSha);
    else if (
      ((work.step === "validate" || work.step === "deliver") &&
        work.baseSha &&
        work.changeRef &&
        work.treeSha) ||
      (work.step === "approve-asset" && work.selectedAssetSet && work.baseSha)
    )
      dispatch(item, work.baseSha!);
    // An execute step resumes with or without a recorded handle: the attempt
    // id was saved before start, and the driver adopts or stops it.
    else if (work.step === "execute" && work.attempt && work.baseSha)
      dispatch(item, work.baseSha);
    else
      throw new Error(
        `Work Item ${item.id} has ambiguous active state at ${work.step ?? "unknown"}; operator direction required`,
      );
  };
  for (const item of graph.items) resume(item);
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
      dispatch(item, itemBase);
    }
    // An item the operator answered while the run is live (`factory
    // retry` cleared its wait) resumes where it stopped.
    if (!stopped() && !args.paused?.() && !args.amendmentPending?.())
      for (const id of parked) {
        if (active.has(id) || awaitsOperator(state.work[id]?.wait)) continue;
        parked.delete(id);
        const item = graph.items.find((entry) => entry.id === id);
        if (item) resume(item);
      }
    if (
      !active.size &&
      graph.items.some((item) => state.work[item.id]?.status === "waiting")
    )
      return true;
    if (!active.size && args.paused?.()) return true;
    if (failure) throw failure;
    if (!active.size) return true;
    await Promise.race([
      ...active.values(),
      phases.changed(),
      ...(args.woken ? [args.woken()] : []),
    ]);
  }
  await Promise.all(active.values());
  if (failure) throw failure;
  return false;
}
