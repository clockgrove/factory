import { assertIntegrated, laterIntegration } from "./integration.js";
import { deliveryReadiness } from "./readiness.js";
import { workerContext } from "../execution/checkpoint.js";
import { recordWorkFailure, diagnoseWorkRepair } from "../work-repair.js";
import {
  cancelledFault,
  executeItem,
  ItemPaused,
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
  DeliveryResult,
  DeliveryStrategy,
  ExecutionDriver,
  ExecutionResult,
  GitHubGateway,
  NativeStackLayer,
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
import { faultOf } from "../fault.js";
import { earlierHeads } from "../repair-policy.js";
import { currentProcessSignal } from "../process.js";
import { preflightItemEnvironment, runQaItem } from "../qa-execution.js";
import { phaseAdmission } from "../phase-admission.js";
import { itemsConflict, rankPending } from "../scheduler.js";
import type { FactoryState } from "../state.js";
import { type StepContext, step } from "../step.js";
import {
  validateWorkItem,
  workItemReviewEvidence,
  workItemReviewObservations,
} from "../validation.js";
import { linearDeliveryUnits } from "./plan.js";
import { transplantIndependentChange } from "./transplant.js";

export async function runNativeGraph(args: {
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
}): Promise<void> {
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
  const branchFor = (id: string) => `factory/objective-${objective}/${id}`;
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
  /** What a diagnostics span records for one try of a delivery step. */
  interface Span<T> {
    itemId?: string;
    operation: string;
    metadata: Record<string, string | number>;
    summarize: (result: T) => Record<string, string | number>;
  }
  /** Run one delivery step of an item; its span records each try. */
  const itemStep = <T>(
    id: string,
    name: "publish" | "await-ci" | "stack" | "merge",
    fn: (context: StepContext) => Promise<T>,
    span?: Span<T>,
  ): Promise<T> =>
    step(
      state,
      { scope: { item: id }, name },
      (context) =>
        args.diagnostics && span
          ? args.diagnostics.span(
              {
                runId: state.runId,
                ...(span.itemId
                  ? {
                      itemId: span.itemId,
                      attemptId: state.work[span.itemId]!.attempt,
                    }
                  : {}),
                operation: span.operation,
                metadata: span.metadata,
              },
              () => fn(context),
              span.summarize,
            )
          : fn(context),
      { save, signal },
    );
  /** A unit's CI wait, stack and merge steps belong to its top item. */
  const unitStep = <T>(
    unit: (typeof units)[number],
    name: "await-ci" | "stack" | "merge",
    fn: (context: StepContext) => Promise<T>,
    span?: Span<T>,
  ): Promise<T> => itemStep(unit.items.at(-1)!.id, name, fn, span);
  /** Diagnose a failed item's wrong result within its repair allowances. */
  const diagnose = async (item: WorkItem): Promise<void> => {
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
        stopped: () => stopped() || Boolean(args.paused?.()),
      });
    } finally {
      phases.release(item.id);
    }
  };
  const units = linearDeliveryUnits(state.graph);
  let preparationFailure: unknown;
  /** Run the item's worker on `baseSha` and record its collected result. */
  const runWorker = async (
    item: WorkItem,
    baseSha: string,
  ): Promise<ExecutionResult> => {
    const work = state.work[item.id]!;
    if (!work.execution) {
      await phases.reserve(item.id, "validation");
      await preflightItemEnvironment({
        config,
        root,
        state,
        objectiveBody: args.objectiveBody,
        item,
        store: contentStore,
        baseSha,
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
        baseSha,
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
    // The collected result is recorded once, with the handle that held it.
    recordWorkerDiscovery(state, item.id, result.discovery);
    work.changeRef = result.changeRef;
    work.treeSha = result.treeSha;
    delete work.execution;
    save();
    return result;
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
  // Admit independent roots whenever their predecessor units have integrated.
  // Publication stays ordered; a prepared change is replayed and validated
  // again if an earlier unit advanced the integrated head.
  const prepareReadyUnits = async (): Promise<void> => {
    if (args.paused?.() || args.amendmentPending?.()) return;
    if (
      Object.values(state.work).some(
        (work) => work.status === "running" && work.step === "validate",
      )
    )
      return;
    if (
      state.graph.items.some(
        (item) =>
          (item.kind === "qa" || item.kind === "aggregate") &&
          state.work[item.id]?.status === "pending" &&
          item.dependencies.every((id) => state.work[id]?.status === "done"),
      )
    )
      return;
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
    const limit = phases.availableSlots(reported);
    const prepared: typeof units = [];
    const runningUnits = units.filter((unit) =>
      unit.items.some((item) => state.work[item.id]?.status === "running"),
    );
    const ranked = rankPending(state.graph, state.work);
    for (const unit of [...units].sort(
      (a, b) => ranked.indexOf(a.items[0]!) - ranked.indexOf(b.items[0]!),
    )) {
      if (prepared.length >= limit) break;
      if (
        unit.items[0]!.kind === "qa" ||
        phases.reason(unit.items[0]!.id, "coding") ||
        unit.items[0]!.kind === "aggregate" ||
        state.work[unit.items[0]!.id]?.status !== "pending" ||
        !unit.externalDependencies.every(
          (dependency) => state.work[dependency]?.status === "done",
        ) ||
        unit.items[0]!.expectedOutputRoles?.length ||
        [...runningUnits, ...prepared].some((other) =>
          unit.items.some((item) =>
            other.items.some((candidate) => itemsConflict(item, candidate)),
          ),
        )
      )
        continue;
      prepared.push(unit);
    }
    if (prepared.length) {
      await args.reconcile?.();
      if (stopped()) throw cancelledFault();
      if (args.paused?.() || args.amendmentPending?.()) return;
      const tasks = prepared.map(async (unit) => {
        const item = unit.items[0]!;
        const work = state.work[item.id]!;
        work.status = "running";
        work.step = "execute";
        work.baseSha = state.integratedSha ?? state.baseSha;
        work.executionBaseSha = work.baseSha;
        work.integratedShaAtStart = state.integratedSha ?? null;
        work.attempt = randomUUID();
        work.graphRevisionDigest = graphDigest(state.graph);
        work.startedAt = new Date().toISOString();
        save();
        try {
          const result = await runWorker(item, work.baseSha);
          if (result.assets?.length)
            throw new Error(
              `Independent preparation ${item.id} unexpectedly returned AssetSets`,
            );
          work.step = "validate";
          save();
        } catch (error) {
          // Step rule 7: a decision or a configuration fix waits on this
          // item only, cancel stops it quietly; it keeps its place.
          if (staysInPlace(error)) {
            if (error instanceof AuthenticationRequiredError)
              work.authentication = error.authentication;
            if (!work.execution) phases.release(item.id);
            save();
            return;
          }
          work.status = "failed";
          work.error = error instanceof Error ? error.message : String(error);
          if (
            error instanceof AuthenticationRequiredError &&
            work.status === "failed"
          )
            work.authentication = error.authentication;
          else delete work.authentication;
          if (work.step === "execute") await stopWorker(item);
          const isolated = recordWorkFailure(state, item.id, error);
          if (isolated && !stopped()) {
            await diagnose(item);
            return;
          }
          save();
          throw error;
        }
      });
      for (const [index, task] of tasks.entries()) {
        const id = prepared[index]!.id;
        const owned = task
          .catch((error: unknown) => {
            preparationFailure ??= error;
            throw error;
          })
          .finally(() => active.delete(id));
        void owned.catch(() => undefined);
        active.set(id, owned);
      }
    }
  };
  const settlePrepared = async () => {
    await Promise.all(active.values());
    if (preparationFailure) throw preparationFailure;
  };
  const remainingUnits = [...units];
  unitLoop: while (remainingUnits.length) {
    if (preparationFailure) throw preparationFailure;
    await prepareReadyUnits();
    const ranked = rankPending(state.graph, state.work);
    const eligible = remainingUnits.filter(
      (unit) =>
        !unit.items.some((item) =>
          ["failed", "cancelled"].includes(state.work[item.id]!.status),
        ) &&
        (!args.amendmentPending?.() ||
          unit.items.some(
            (item) =>
              state.work[item.id]?.attempt ||
              state.work[item.id]?.status === "done",
          )) &&
        unit.externalDependencies.every(
          (id) => state.work[id]?.status === "done",
        ) &&
        !units.some(
          (other) =>
            other !== unit &&
            other.items.some(
              (item) => state.work[item.id]?.status === "running",
            ) &&
            unit.items.some((item) =>
              other.items.some((candidate) => itemsConflict(item, candidate)),
            ),
        ),
    );
    eligible.sort(
      (a, b) => ranked.indexOf(a.items[0]!) - ranked.indexOf(b.items[0]!),
    );
    const completionReady = eligible.filter(
      (unit) =>
        unit.items.some((item) => {
          const work = state.work[item.id]!;
          return (
            work.status === "published" ||
            (work.status === "running" && work.step !== "execute")
          );
        }) ||
        unit.items[0]!.kind === "qa" ||
        unit.items[0]!.kind === "aggregate",
    );
    const unit = completionReady[0] ?? eligible[0];
    if (!unit) {
      if (
        args.amendmentPending?.() ||
        Object.values(state.work).some((work) => work.status === "failed")
      )
        return settlePrepared();
      throw new Error("No dependency-ready delivery unit");
    }
    if (
      active.has(unit.id) &&
      state.work[unit.items[0]!.id]?.step === "execute"
    ) {
      await Promise.race(active.values());
      continue;
    }
    remainingUnits.splice(remainingUnits.indexOf(unit), 1);
    if (unit.items.every((item) => state.work[item.id]?.status === "done"))
      continue;
    if (
      args.amendmentPending?.() &&
      !unit.items.some((item) => state.work[item.id]?.attempt)
    )
      return settlePrepared();
    try {
      await active.get(unit.id);
    } finally {
      active.delete(unit.id);
    }
    if (preparationFailure) throw preparationFailure;
    if (
      !unit.externalDependencies.every(
        (dependency) => state.work[dependency]?.status === "done",
      )
    ) {
      throw new Error(
        `Delivery unit ${unit.id} started before its dependencies`,
      );
    }
    if (unit.items[0]!.kind === "qa" || unit.items[0]!.kind === "aggregate") {
      const item = unit.items[0]!;
      if (state.work[item.id]?.status === "waiting") return settlePrepared();
      if (state.work[item.id]?.status === "pending") {
        if (args.paused?.()) return settlePrepared();
        await args.reconcile?.();
        if (args.paused?.() || args.amendmentPending?.())
          return settlePrepared();
      }
      if (args.paused?.() && state.work[item.id]?.wait?.kind === "ci")
        return settlePrepared();
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
      if (state.work[item.id]?.status !== "done") return settlePrepared();
      continue;
    }
    for (const [index, item] of unit.items.entries()) {
      if (stopped()) throw cancelledFault();
      const work = state.work[item.id]!;
      if (work.status === "published") continue;
      if (state.work[item.id]?.status === "waiting") return settlePrepared();
      if (work.status !== "pending" && work.status !== "running")
        throw new Error(`Work Item ${item.id} cannot enter native delivery`);
      const previous = index ? state.work[unit.items[index - 1]!.id]! : null;
      const itemBase = previous
        ? previous.changeRef
        : (state.integratedSha ?? state.baseSha);
      if (!itemBase) throw new Error("Native stack predecessor has no commit");
      if (work.status === "running" && work.baseSha !== itemBase && index !== 0)
        throw new Error(`Work Item ${item.id} resumed on a changed base`);
      if (work.status === "pending" && args.paused?.()) return settlePrepared();
      if (work.status === "pending") {
        const available = await driver.availableSlots();
        if (phases.availableSlots(available) <= 0) return settlePrepared();
        await args.reconcile?.();
        if (stopped()) throw cancelledFault();
        if (args.paused?.()) return settlePrepared();
        work.status = "running";
        work.step = "execute";
        work.baseSha = itemBase;
        work.executionBaseSha = itemBase;
        work.integratedShaAtStart = state.integratedSha ?? null;
        work.attempt = randomUUID();
        work.graphRevisionDigest = graphDigest(state.graph);
        work.startedAt = new Date().toISOString();
        save();
      }
      if (
        (work.step !== "execute" &&
          work.step !== "approve-asset" &&
          work.step !== "validate" &&
          work.step !== "deliver") ||
        (work.execution && !work.attempt)
      )
        throw new Error(
          `Work Item ${item.id} has ambiguous active state; operator direction required`,
        );
      // Set when the item stays in place: it waits for the operator, or it
      // was cancelled or paused.
      let waiting = false;
      const perform = async (): Promise<void> => {
        if (work.step === "approve-asset") {
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
        } else if (work.step === "execute") {
          const result = await runWorker(item, itemBase);
          if (result.assets?.length) {
            work.assets = result.assets;
            work.status = "waiting";
            work.step = "approve-asset";
            save();
            return;
          }
          work.step = "validate";
          save();
        }
        // A restart after review resumes at publication, unless the change
        // must be replayed onto a moved base and validated again.
        const reviewed =
          work.step === "deliver" &&
          Boolean(work.validation) &&
          work.baseSha === itemBase;
        if (!reviewed) {
          await phases.reserve(item.id, "validation");
          if (work.baseSha !== itemBase) {
            if (!work.changeRef || !work.baseSha || work.assets?.length)
              throw new Error(
                `Work Item ${item.id} cannot replay its prepared change`,
              );
            const replayed = await transplantIndependentChange(
              config.checkout,
              work.baseSha,
              work.changeRef,
              itemBase,
            );
            work.changeRef = replayed.changeRef;
            work.treeSha = replayed.treeSha;
            work.baseSha = itemBase;
            save();
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
                      metadata: {
                        commandIndex: entry.index,
                        stream: entry.stream,
                      },
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
                  delivery: "native-stack",
                }),
                observations: workItemReviewObservations(
                  state,
                  item,
                  {
                    kind: "native-stack",
                    unitId: unit.id,
                    layerNumber: index + 1,
                    layerCount: unit.items.length,
                    predecessorItemId: unit.items[index - 1]?.id ?? null,
                  },
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
        }
        work.step = "deliver";
        save();
      };
      const publishLayer = async (): Promise<void> => {
        if (work.status !== "running" || work.step !== "deliver") return;
        await phases.reserve(item.id, "delivery");
        // A decision the Objective asks here waits on the Objective.
        await reconcile();
        const published: DeliveryResult = await itemStep(
          item.id,
          "publish",
          async () =>
            delivery.publish({
              item,
              baseSha: itemBase,
              treeSha: work.treeSha!,
              changeRef: work.changeRef!,
              branch: branchFor(item.id),
              lfs: Boolean(work.selectedAssetSet),
              earlierHeads: earlierHeads(work),
              baseBranch: previous
                ? branchFor(unit.items[index - 1]!.id)
                : await github.defaultBranch(),
            }),
          {
            itemId: item.id,
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
        phases.release(item.id);
        work.status = "published";
        delete work.step;
        save();
      };
      const task = perform()
        .then(publishLayer)
        .catch(async (error: unknown) => {
          // The Objective's own fault leaves the item where it is.
          if (objectiveFaults.has(error as object)) {
            if (!work.execution) phases.release(item.id);
            save();
            if (staysInPlace(error)) {
              waiting = true;
              return;
            }
            throw error;
          }
          // Step rule 7: a decision or a configuration fix waits on this
          // item only, cancel or pause stops it quietly; it keeps its place
          // and its worker.
          if (staysInPlace(error)) {
            if (error instanceof AuthenticationRequiredError)
              work.authentication = error.authentication;
            if (!work.execution) phases.release(item.id);
            save();
            waiting = true;
            return;
          }
          if (work.status !== "done" && work.status !== "published") {
            if (work.step === "execute") await stopWorker(item);
            work.status = "failed";
            work.error = error instanceof Error ? error.message : String(error);
            if (error instanceof AuthenticationRequiredError)
              work.authentication = error.authentication;
            else delete work.authentication;
            save();
          }
          // A wrong result is repaired, published or not: the next attempt
          // republishes the same branch with a lease.
          const isolated = recordWorkFailure(state, item.id, error);
          if (isolated && !stopped()) {
            await diagnose(item);
            return;
          }
          if (work.phaseReservation !== "coding") phases.release(item.id);
          save();
          throw error;
        });
      active.set(item.id, task);
      try {
        await task;
      } finally {
        active.delete(item.id);
      }
      if (waiting) return settlePrepared();
      if (
        state.work[item.id]?.status === "pending" ||
        state.work[item.id]?.status === "running"
      ) {
        remainingUnits.push(unit);
        continue unitLoop;
      }
      if (state.work[item.id]?.status === "failed") continue unitLoop;
      if (state.work[item.id]?.status === "waiting") return settlePrepared();
    }
    const top = unit.items.at(-1)!;
    const topWork = state.work[top.id]!;
    /** The owner paused while this unit waits for CI: stop polling. */
    const pausedWhileWaiting = () =>
      Boolean(args.paused?.()) && topWork.wait?.kind === "ci";
    if (pausedWhileWaiting() && !state.stackMerges?.[unit.id])
      return settlePrepared();
    const layers: NativeStackLayer[] = unit.items.map((item) => {
      const work = state.work[item.id]!;
      if (work.status !== "published" || !work.pullRequest || !work.changeRef)
        throw new Error(`Native delivery layer ${item.id} is incomplete`);
      return {
        pullRequest: work.pullRequest,
        branch: branchFor(item.id),
        headSha: work.changeRef,
      };
    });
    const pendingMerge = state.stackMerges?.[unit.id];
    if (
      pendingMerge &&
      (pendingMerge.topPullRequest !== layers.at(-1)!.pullRequest ||
        pendingMerge.expectedHeadSha !== layers.at(-1)!.headSha)
    )
      throw new Error(
        "Pending native merge identity changed; operator direction required",
      );
    let merged: { merge: string; integrated: string };
    // The layer whose published result is wrong, when one is.
    let failedLayer: number | undefined;
    /** Observe every layer; return them when the unit may merge, else wait for CI. */
    const ready = async (context: StepContext) => {
      failedLayer = undefined;
      // If the default branch moved, the layers' checks and mergeability
      // decide; a move is not a fault.
      const defaultBranch = await github.defaultBranch();
      const observations = await Promise.all(
        layers.map((layer, index) =>
          github.observe({
            number: layer.pullRequest,
            branch: layer.branch,
            headSha: layer.headSha,
            earlierHeads: earlierHeads(state.work[unit.items[index]!.id]!),
            baseBranch: index ? layers[index - 1]!.branch : defaultBranch,
          }),
        ),
      );
      context.progress();
      // Strict protection: bring a layer up to date with its base, from
      // exactly the head Factory published; its checks run again.
      const behind = observations.findIndex(
        (observation) => observation.mergeReadiness === "behind",
      );
      if (behind >= 0) {
        const layer = layers[behind]!;
        const work = state.work[unit.items[behind]!.id]!;
        const head = await github.updateBranch(
          {
            number: layer.pullRequest,
            branch: layer.branch,
            headSha: layer.headSha,
            earlierHeads: earlierHeads(work),
          },
          layer.headSha,
        );
        context.progress();
        work.changeRef = head;
        layer.headSha = head;
        save();
        context.pending({
          kind: "ci",
          detail: `PR #${layer.pullRequest} was updated with its base; awaiting its checks`,
        });
      }
      // Every layer is judged before any wait: another layer's failure must
      // still surface, and it is that layer's.
      const pending = observations
        .map((observation, index) => {
          try {
            return deliveryReadiness(
              layers[index]!.pullRequest,
              observation,
              (state.graph.requiredPreIntegrationChecks ?? []).map(
                (check) => check.checkName,
              ),
              layers[index]!.headSha,
            );
          } catch (error) {
            if (faultOf(error).kind === "work") failedLayer = index;
            throw error;
          }
        })
        .find(Boolean);
      if (pending) context.pending({ kind: "ci", detail: pending });
      return observations;
    };
    try {
      // A merge already requested is resumed by the merge step.
      if (!pendingMerge) {
        const observations = await unitStep(
          unit,
          "await-ci",
          async (context) => {
            if (pausedWhileWaiting()) throw new ItemPaused();
            return ready(context);
          },
        );
        for (const [index, observation] of observations.entries())
          state.work[unit.items[index]!.id]!.preIntegrationChecks =
            observation.namedChecks ?? [];
        save();
      }
      // The CI wait holds no phase reservation; the merge does.
      await phases.reserve(top.id, "delivery");
      await args.reconcile?.();
      let stackNumber: number | undefined;
      if (layers.length > 1) {
        stackNumber =
          state.stackNumbers?.[unit.id] ??
          (await unitStep(
            unit,
            "stack",
            async () =>
              github.ensureNativeStack(layers, await github.defaultBranch()),
            {
              operation: "github-stack",
              metadata: { unit: unit.id, layerCount: layers.length },
              summarize: (number) => ({ stack: number }),
            },
          ));
        state.stackNumbers ??= {};
        state.stackNumbers[unit.id] = stackNumber;
        save();
      }
      // Merging an already merged PR or stack is confirmed, so a repeat or
      // a restart simply asks again.
      const merge = () =>
        unitStep(
          unit,
          "merge",
          async (context) => {
            // Readiness can change after await-ci (a conflict, a failed
            // check): judge it again unless a merge is already requested.
            if (!state.stackMerges?.[unit.id]) await ready(context);
            const defaultBranch = await github.defaultBranch();
            const sha =
              stackNumber === undefined
                ? (
                    await github.merge(
                      {
                        number: layers[0]!.pullRequest,
                        branch: layers[0]!.branch,
                        headSha: layers[0]!.headSha,
                        earlierHeads: earlierHeads(topWork),
                      },
                      layers[0]!.headSha,
                    )
                  ).integratedSha
                : await github.mergeNativeStack(
                    layers,
                    defaultBranch,
                    stackNumber,
                    {
                      resumeUuid: state.stackMerges?.[unit.id]?.uuid,
                      onPending: (uuid) => {
                        state.stackMerges ??= {};
                        state.stackMerges[unit.id] = {
                          topPullRequest: layers.at(-1)!.pullRequest,
                          expectedHeadSha: layers.at(-1)!.headSha,
                          uuid,
                        };
                        save();
                      },
                      progress: context.progress,
                      queued: (detail) =>
                        context.pending({ kind: "ci", detail }),
                    },
                  );
            // Other work may have merged since; the unit's merge only needs to
            // be on the default branch.
            await assertIntegrated(
              config.checkout,
              defaultBranch,
              sha,
              `native unit ${unit.id}`,
            );
            return {
              merge: sha,
              integrated: await laterIntegration(
                config.checkout,
                state.integratedSha,
                sha,
              ),
            };
          },
          {
            operation:
              layers.length === 1 ? "github-merge" : "github-stack-merge",
            metadata: {
              unit: unit.id,
              topPullRequest: layers.at(-1)!.pullRequest,
              headSha: layers.at(-1)!.headSha,
            },
            summarize: (result) => ({ integratedSha: result.merge }),
          },
        );
      try {
        merged = await merge();
      } catch (error) {
        // A failed merge request is not resumed: answering the decision
        // requests the merge anew.
        if (
          faultOf(error).kind !== "cancelled" &&
          state.stackMerges?.[unit.id]
        ) {
          delete state.stackMerges[unit.id];
          save();
        }
        throw error;
      }
    } catch (error) {
      // The Objective's own fault leaves the unit where it is.
      if (objectiveFaults.has(error as object)) {
        phases.release(top.id);
        save();
        if (staysInPlace(error)) return settlePrepared();
        throw error;
      }
      // Step rule 7: a decision or a configuration fix waits, cancel or
      // pause stops quietly; the unit keeps its place.
      if (staysInPlace(error)) {
        phases.release(top.id);
        save();
        return settlePrepared();
      }
      // A published layer is wrong (a failed required check, a conflict):
      // that layer's item fails with the evidence and is repaired like any
      // wrong result; independent units continue.
      if (faultOf(error).kind === "work") {
        const failed = unit.items[failedLayer ?? unit.items.length - 1]!;
        const work = state.work[failed.id]!;
        work.status = "failed";
        work.error = error instanceof Error ? error.message : String(error);
        phases.release(top.id);
        const isolated = recordWorkFailure(state, failed.id, error);
        save();
        if (isolated && !stopped()) await diagnose(failed);
        continue;
      }
      throw error;
    }
    state.integratedSha = merged.integrated;
    for (const item of unit.items) {
      const work = state.work[item.id]!;
      work.status = "done";
      work.integratedSha = merged.merge;
      work.completedAt = new Date().toISOString();
    }
    phases.release(top.id);
    save();
    for (const item of unit.items)
      await closeWorkItem(state, item.id, github, save, true);
  }
}
