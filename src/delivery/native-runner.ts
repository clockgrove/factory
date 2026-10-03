import { assertDeliveryReady, DeliveryReadinessPending } from "./readiness.js";
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
import { attachFault, transient } from "../fault.js";
import { git, gitAsync } from "../process.js";
import { preflightItemEnvironment, runQaItem } from "../qa-execution.js";
import { phaseAdmission } from "../phase-admission.js";
import { itemsConflict, rankPending } from "../scheduler.js";
import type { FactoryState } from "../state.js";
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
  const defaultBranch = await github.defaultBranch();
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
        await phases.reserve(item.id, "delivery");
        work.step = "deliver";
        save();
        const publish = () =>
          delivery.publish({
            item,
            baseSha: itemBase,
            treeSha: work.treeSha!,
            changeRef: work.changeRef!,
            branch: branchFor(item.id),
            lfs: Boolean(work.selectedAssetSet),
            baseBranch: previous
              ? branchFor(unit.items[index - 1]!.id)
              : defaultBranch,
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
        phases.release(item.id);
        work.status = "published";
        delete work.step;
        save();
      };
      const task = repeatInterrupted(work, save, perform).catch(
        async (error: unknown) => {
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
        },
      );
      active.set(item.id, task);
      try {
        await task;
      } finally {
        active.delete(item.id);
      }
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
    const readinessWasWaiting = Boolean(
      state.work[unit.items.at(-1)!.id]?.waitingReason,
    );
    if (args.paused?.() && readinessWasWaiting && !state.stackMerges?.[unit.id])
      return settlePrepared();
    await phases.reserve(unit.items.at(-1)!.id, "delivery");
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
    const observations = await Promise.all(
      layers.map((layer, index) =>
        github.observe({
          number: layer.pullRequest,
          branch: layer.branch,
          headSha: layer.headSha,
          baseBranch: index ? layers[index - 1]!.branch : defaultBranch,
        }),
      ),
    );
    const allMerged = observations.every(
      (observation) => observation.state === "merged",
    );
    if (!pendingMerge && !allMerged) {
      await gitAsync(config.checkout, "fetch", "origin", defaultBranch);
      const observedBefore = git(config.checkout, "rev-parse", "FETCH_HEAD");
      if (observedBefore !== state.work[unit.items[0]!.id]!.baseSha)
        throw new Error(
          `Default branch moved before native unit ${unit.id}; operator direction required`,
        );
      try {
        // Check every layer before choosing a wait: another layer's genuine failure must still stop.
        for (const observation of observations)
          if (
            observation.state !== "open" ||
            observation.checks === "failing" ||
            observation.mergeReadiness === "blocked"
          )
            assertDeliveryReady(observation);
        for (const [index, observation] of observations.entries())
          assertDeliveryReady(
            observation,
            (state.graph.requiredPreIntegrationChecks ?? []).map(
              (check) => check.checkName,
            ),
            layers[index]!.headSha,
          );
      } catch (error) {
        if (!(error instanceof DeliveryReadinessPending)) throw error;
        state.work[unit.items.at(-1)!.id]!.waitingReason = error.message;
        phases.release(unit.items.at(-1)!.id);
        save();
        return settlePrepared();
      }
      delete state.work[unit.items.at(-1)!.id]!.waitingReason;
      for (const [index, observation] of observations.entries())
        state.work[unit.items[index]!.id]!.preIntegrationChecks =
          observation.namedChecks ?? [];
      save();
    }
    let integratedSha: string;
    const mergeOperation = {
      runId: state.runId,
      operation: layers.length === 1 ? "github-merge" : "github-stack-merge",
      metadata: {
        unit: unit.id,
        topPullRequest: layers.at(-1)!.pullRequest,
        headSha: layers.at(-1)!.headSha,
      },
    };
    const topWork = state.work[unit.items.at(-1)!.id]!;
    await args.reconcile?.();
    if (args.cancelled()) throw new Error("Objective cancelled");
    if (args.paused?.() && readinessWasWaiting && !pendingMerge) {
      phases.release(unit.items.at(-1)!.id);
      return settlePrepared();
    }
    // Merging an already merged PR or stack is confirmed by the gateway, so a
    // restart simply asks again.
    if (layers.length === 1) {
      const layer = layers[0]!;
      const merge = () =>
        repeatInterrupted(
          topWork,
          save,
          async () =>
            (
              await github.merge(
                {
                  number: layer.pullRequest,
                  branch: layer.branch,
                  headSha: layer.headSha,
                },
                layer.headSha,
              )
            ).integratedSha,
        );
      integratedSha = args.diagnostics
        ? await args.diagnostics.span(mergeOperation, merge, (headSha) => ({
            integratedSha: headSha,
          }))
        : await merge();
    } else {
      state.stackNumbers ??= {};
      const ensureStack = () =>
        repeatInterrupted(topWork, save, () =>
          github.ensureNativeStack(layers, defaultBranch),
        );
      const stackNumber =
        state.stackNumbers[unit.id] ??
        (args.diagnostics
          ? await args.diagnostics.span(
              {
                runId: state.runId,
                operation: "github-stack",
                metadata: { unit: unit.id, layerCount: layers.length },
              },
              ensureStack,
              (number) => ({ stack: number }),
            )
          : await ensureStack());
      if (
        state.stackNumbers[unit.id] &&
        state.stackNumbers[unit.id] !== stackNumber
      )
        throw new Error(
          "Native stack number changed; operator direction required",
        );
      state.stackNumbers[unit.id] = stackNumber;
      save();
      const pending = pendingMerge;
      if (
        pending &&
        (pending.topPullRequest !== layers.at(-1)!.pullRequest ||
          pending.expectedHeadSha !== layers.at(-1)!.headSha)
      )
        throw new Error(
          "Pending native merge identity changed; operator direction required",
        );
      const mergeStack = () =>
        repeatInterrupted(topWork, save, () =>
          github.mergeNativeStack(layers, defaultBranch, stackNumber, {
            // A repeat resumes the async merge recorded by an earlier call.
            resumeUuid: state.stackMerges?.[unit.id]?.uuid ?? pending?.uuid,
            beforeMerge: () => {
              if (args.cancelled()) throw new Error("Objective cancelled");
              if (args.paused?.() && readinessWasWaiting)
                throw new DeliveryReadinessPending();
            },
            onPending: (uuid) => {
              state.stackMerges ??= {};
              state.stackMerges[unit.id] = {
                topPullRequest: layers.at(-1)!.pullRequest,
                expectedHeadSha: layers.at(-1)!.headSha,
                uuid,
              };
              save();
            },
            cancelled: args.cancelled,
          }),
        );
      try {
        integratedSha = args.diagnostics
          ? await args.diagnostics.span(
              mergeOperation,
              mergeStack,
              (headSha) => ({ integratedSha: headSha }),
            )
          : await mergeStack();
      } catch (error) {
        if (!(error instanceof DeliveryReadinessPending)) throw error;
        topWork.waitingReason = error.message;
        phases.release(unit.items.at(-1)!.id);
        save();
        return settlePrepared();
      }
    }
    await gitAsync(config.checkout, "fetch", "origin", defaultBranch);
    // Other work may have merged since; the unit's merge only needs to be on
    // the default branch.
    try {
      git(
        config.checkout,
        "merge-base",
        "--is-ancestor",
        integratedSha,
        "FETCH_HEAD",
      );
    } catch (cause) {
      // Read-after-merge lag until the step's window passes (#515).
      const message = `Default branch does not contain the merge of native unit ${unit.id} (${integratedSha})`;
      throw attachFault(
        new Error(message, { cause }),
        transient(message, false),
      );
    }
    const observedAfter = integratedSha;
    state.integratedSha = observedAfter;
    for (const item of unit.items) {
      const work = state.work[item.id]!;
      work.status = "done";
      work.integratedSha = observedAfter;
      work.completedAt = new Date().toISOString();
    }
    phases.release(unit.items.at(-1)!.id);
    save();
    for (const item of unit.items)
      await closeWorkItem(state, item.id, github, save, true);
  }
}
