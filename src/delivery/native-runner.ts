import { assertIntegrated, laterIntegration } from "./integration.js";
import { deliveryReadiness } from "./readiness.js";
import { workerContext } from "../execution/checkpoint.js";
import {
  recordWorkFailure,
  diagnoseWorkRepair,
  prepareEvidenceRecovery,
  repeatInterrupted,
} from "../work-repair.js";
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
  ExecutionHandle,
  GitHubGateway,
  NativeStackLayer,
  PlanningModel,
} from "../contracts.js";
import { AuthenticationRequiredError } from "../contracts.js";
import type { DiagnosticEmitter } from "../diagnostics.js";
import {
  materializeAssetSet,
  selectedInputsForItem,
  validationLfsMembersForItem,
} from "../media.js";
import { faultOf, StepFault } from "../fault.js";
import { earlierHeads } from "../repair-policy.js";
import { currentProcessSignal } from "../process.js";
import { preflightItemEnvironment, runQaItem } from "../qa-execution.js";
import { phaseAdmission } from "../phase-admission.js";
import { itemsConflict, rankPending } from "../scheduler.js";
import type { FactoryState } from "../state.js";
import { type StepContext, step } from "../step.js";
import {
  AcceptanceDecisionRequired,
  reviewAcceptance,
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
      { save, signal: currentProcessSignal() },
    );
  /** A unit's CI wait, stack and merge steps belong to its top item. */
  const unitStep = <T>(
    unit: (typeof units)[number],
    name: "await-ci" | "stack" | "merge",
    fn: (context: StepContext) => Promise<T>,
    span?: Span<T>,
  ): Promise<T> => itemStep(unit.items.at(-1)!.id, name, fn, span);
  /**
   * A delivery step that stopped without failing the attempt: it waits for
   * the operator (a decision or a configuration fix; `factory retry` or the
   * next run repeats it), or it was cancelled, or the owner paused while it
   * waited for CI. The item keeps its place.
   */
  const stopped = (error: unknown): boolean => {
    const { kind } = faultOf(error);
    return ["decision", "config", "cancelled"].includes(kind);
  };
  const units = linearDeliveryUnits(state.graph);
  let preparationFailure: unknown;
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
      if (args.cancelled()) throw new Error("Objective cancelled");
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
          // A worker that ends without a result is started again (bounded);
          // an interrupted step reattaches to its recorded attempt.
          await repeatInterrupted(work, save, async () => {
            if (!work.execution) {
              await phases.reserve(item.id, "validation");
              await preflightItemEnvironment({
                config,
                root,
                state,
                objectiveBody: args.objectiveBody,
                item,
                store: contentStore,
                baseSha: work.baseSha!,
              });
            }
            // A reattached worker keeps the coding slot it holds while it runs remotely.
            if (work.phaseReservation !== "coding")
              await phases.reserve(item.id, "coding");
            const handle: ExecutionHandle =
              (work.execution ? structuredClone(work.execution) : undefined) ??
              (await driver.start(
                {
                  captureContext: { objective, runId: state.runId },
                  item: work.recovery?.correction
                    ? {
                        ...item,
                        brief: `${item.brief}\nDiagnosed repair: ${work.recovery.correction.diagnosis}\nRequired correction: ${work.recovery.correction.correction}`,
                      }
                    : item,
                  baseSha: work.baseSha!,
                  attemptId: work.attempt,
                  objectiveBody: args.objectiveBody,
                  selectedAssets: selectedInputsForItem(state, item),
                },
                workerContext(work, save, args.cancelled, args.diagnostics, {
                  runId: state.runId,
                  itemId: item.id,
                }),
              ));
            work.execution = structuredClone(handle);
            save();
            if (args.cancelled()) {
              await driver.cancel(
                handle,
                workerContext(work, save, args.cancelled, args.diagnostics, {
                  runId: state.runId,
                  itemId: item.id,
                }),
              );
              throw new Error("Objective cancelled");
            }
            const result = await driver.collect(
              handle,
              workerContext(work, save, args.cancelled, args.diagnostics, {
                runId: state.runId,
                itemId: item.id,
              }),
            );
            phases.release(item.id);
            recordWorkerDiscovery(state, item.id, result.discovery);
            save();
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
            if (result.assets?.length)
              throw new Error(
                `Independent preparation ${item.id} unexpectedly returned AssetSets`,
              );
            work.changeRef = result.changeRef;
            work.treeSha = result.treeSha;
            delete work.execution;
            work.step = "validate";
            save();
          });
        } catch (error) {
          work.status = "failed";
          work.error = error instanceof Error ? error.message : String(error);
          if (
            error instanceof AuthenticationRequiredError &&
            work.status === "failed"
          )
            work.authentication = error.authentication;
          else delete work.authentication;
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
                stopped: () => args.cancelled() || Boolean(args.paused?.()),
              });
            } finally {
              phases.release(item.id);
            }
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
        Object.values(state.work).some(
          (work) =>
            work.status === "failed" &&
            work.recovery?.failure?.classification !== "uncertain",
        )
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
      if (args.paused?.() && state.work[item.id]?.waitingReason)
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
      if (args.cancelled()) throw new Error("Objective cancelled");
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
        if (args.cancelled()) throw new Error("Objective cancelled");
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
      // Set when a delivery step waits for the operator.
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
          const handle: ExecutionHandle =
            (work.execution ? structuredClone(work.execution) : undefined) ??
            (await driver.start(
              {
                captureContext: { objective, runId: state.runId },
                item: work.recovery?.correction
                  ? {
                      ...item,
                      brief: `${item.brief}\nDiagnosed repair: ${work.recovery.correction.diagnosis}\nRequired correction: ${work.recovery.correction.correction}`,
                    }
                  : item,
                baseSha: itemBase,
                attemptId: work.attempt,
                objectiveBody: args.objectiveBody,
                selectedAssets: selectedInputsForItem(state, item),
              },
              workerContext(work, save, args.cancelled, args.diagnostics, {
                runId: state.runId,
                itemId: item.id,
              }),
            ));
          if (!work.execution) {
            work.execution = structuredClone(handle);
            save();
          }
          if (args.cancelled()) {
            await driver.cancel(
              handle,
              workerContext(work, save, args.cancelled, args.diagnostics, {
                runId: state.runId,
                itemId: item.id,
              }),
            );
            throw new Error("Objective cancelled");
          }
          const result = await driver.collect(
            handle,
            workerContext(work, save, args.cancelled, args.diagnostics, {
              runId: state.runId,
              itemId: item.id,
            }),
          );
          phases.release(item.id);
          recordWorkerDiscovery(state, item.id, result.discovery);
          save();
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
          work.changeRef = result.changeRef;
          work.treeSha = result.treeSha;
          delete work.execution;
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
          work.validation = await validateWorkItem(
            config.checkout,
            join(root, "validation"),
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
          );
          await phases.reserve(item.id, "review");
          const reviewResult = () =>
            reviewAcceptance({
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
            });
          work.validation = args.diagnostics
            ? await args.diagnostics.span(
                {
                  runId: state.runId,
                  itemId: item.id,
                  attemptId: work.attempt,
                  operation: "acceptance-review",
                  metadata: { treeSha: work.treeSha! },
                },
                reviewResult,
                (result) => ({ criteria: result.criteria?.length ?? 0 }),
                (error) =>
                  error instanceof AcceptanceDecisionRequired
                    ? "waiting"
                    : "failed",
              )
            : await reviewResult();
          delete work.acceptancePending;
          if (args.cancelled()) throw new Error("Objective cancelled");
        }
        work.step = "deliver";
        save();
      };
      // Publication repeats itself: it runs outside the interruption repeat.
      const publishLayer = async (): Promise<void> => {
        if (work.status !== "running" || work.step !== "deliver") return;
        await phases.reserve(item.id, "delivery");
        let published: DeliveryResult;
        try {
          // A decision the Objective asks here waits on the Objective.
          await args.reconcile?.();
          published = await itemStep(
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
        } catch (error) {
          if (!stopped(error)) throw error;
          waiting = true;
          phases.release(item.id);
          save();
          return;
        }
        work.pullRequest = published.pullRequest;
        phases.release(item.id);
        work.status = "published";
        delete work.step;
        save();
      };
      const task = repeatInterrupted(work, save, perform)
        .then(publishLayer)
        .catch(async (error: unknown) => {
          if (error instanceof AcceptanceDecisionRequired) {
            phases.release(item.id);
            work.status = "waiting";
            work.step = "approve-result";
            work.acceptancePending = error.pending;
            if (!args.cancelled() && !args.paused?.())
              prepareEvidenceRecovery(state, item.id);
            save();
            return;
          }
          if (work.status !== "done" && work.status !== "published") {
            work.status = "failed";
            work.error = error instanceof Error ? error.message : String(error);
            if (
              error instanceof AuthenticationRequiredError &&
              work.status === "failed"
            )
              work.authentication = error.authentication;
            else delete work.authentication;
            save();
          }
          const isolated = recordWorkFailure(state, item.id, error);
          if (
            isolated &&
            !unit.items.some((entry) => state.work[entry.id]?.pullRequest) &&
            !args.cancelled()
          ) {
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
                stopped: () => args.cancelled() || Boolean(args.paused?.()),
              });
            } finally {
              phases.release(item.id);
            }
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
            if (pausedWhileWaiting())
              throw new StepFault({ kind: "cancelled", detail: "paused" });
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
      if (stopped(error)) {
        phases.release(top.id);
        save();
        return settlePrepared();
      }
      // A published layer is wrong (a failed check, a conflict): that
      // layer's item fails with the evidence; independent units continue.
      if (faultOf(error).kind === "work") {
        const failed = unit.items[failedLayer ?? unit.items.length - 1]!;
        const work = state.work[failed.id]!;
        work.status = "failed";
        work.error = error instanceof Error ? error.message : String(error);
        recordWorkFailure(state, failed.id, error);
        phases.release(top.id);
        save();
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
