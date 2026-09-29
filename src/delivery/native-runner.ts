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
import { git, gitAsync } from "../process.js";
import { itemsConflict } from "../scheduler.js";
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
  const branchFor = (id: string) => `factory/objective-${objective}/${id}`;
  const defaultBranch = await github.defaultBranch();
  const units = linearDeliveryUnits(state.graph);
  for (const [id, work] of Object.entries(state.work))
    if (
      work.pendingEffect &&
      !(
        work.pendingEffect === "merge" &&
        units.some(
          (unit) =>
            unit.items.at(-1)?.id === id &&
            state.stackMerges?.[unit.id]?.expectedHeadSha === work.changeRef,
        )
      )
    )
      throw new Error(
        `Work Item ${id} submitted ${work.pendingEffect} has unknown outcome; operator direction required`,
      );
  // Admit independent roots whenever their predecessor units have integrated.
  // Publication stays ordered; a prepared change is replayed and validated
  // again if an earlier unit advanced the integrated head.
  const prepareReadyUnits = async (): Promise<void> => {
    if (args.paused?.()) return;
    const reported = await driver.availableSlots();
    const limit = Math.min(
      config.execution.concurrency,
      reported === "unknown" ? config.execution.concurrency : reported,
    );
    const prepared: typeof units = [];
    const runningUnits = units.filter((unit) =>
      unit.items.some((item) => state.work[item.id]?.status === "running"),
    );
    for (const unit of units) {
      if (prepared.length >= limit) break;
      if (
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
    if (prepared.length > 1) {
      await args.reconcile?.();
      if (args.cancelled()) throw new Error("Objective cancelled");
      if (args.paused?.()) return;
      const tasks = prepared.map(async (unit) => {
        const item = unit.items[0]!;
        const work = state.work[item.id]!;
        work.status = "running";
        work.step = "execute";
        work.baseSha = state.integratedSha ?? state.baseSha;
        work.executionBaseSha = work.baseSha;
        work.integratedShaAtStart = state.integratedSha ?? null;
        work.attempt = randomUUID();
        work.startedAt = new Date().toISOString();
        save();
        try {
          const handle = await driver.start({
            captureContext: { objective, runId: state.runId },
            item,
            baseSha: work.baseSha!,
            attemptId: work.attempt,
            objectiveBody: args.objectiveBody,
            selectedAssets: selectedInputsForItem(state, item),
          });
          work.execution = handle;
          save();
          if (args.cancelled()) {
            await driver.cancel(handle);
            throw new Error("Objective cancelled");
          }
          const result = await driver.collect(handle);
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
        } catch (error) {
          work.status = "failed";
          work.error = error instanceof Error ? error.message : String(error);
          if (
            error instanceof AuthenticationRequiredError &&
            work.status === "failed"
          )
            work.authentication = error.authentication;
          else delete work.authentication;
          save();
          throw error;
        }
      });
      for (const [index, task] of tasks.entries())
        active.set(prepared[index]!.id, task);
      try {
        await Promise.all(tasks);
      } catch (error) {
        await Promise.all(
          prepared.map(async (unit) => {
            const handle = state.work[unit.id]?.execution;
            if (handle) await driver.cancel(handle).catch(() => undefined);
          }),
        );
        await Promise.allSettled(tasks);
        throw error;
      } finally {
        for (const unit of prepared) active.delete(unit.id);
      }
    }
  };
  for (const unit of units) {
    if (unit.items.every((item) => state.work[item.id]?.status === "done"))
      continue;
    await prepareReadyUnits();
    if (
      !unit.externalDependencies.every(
        (dependency) => state.work[dependency]?.status === "done",
      )
    ) {
      throw new Error(
        `Delivery unit ${unit.id} started before its dependencies`,
      );
    }
    for (const [index, item] of unit.items.entries()) {
      if (args.cancelled()) throw new Error("Objective cancelled");
      const work = state.work[item.id]!;
      if (work.status === "published") continue;
      if (state.work[item.id]?.status === "waiting") return;
      if (work.status !== "pending" && work.status !== "running")
        throw new Error(`Work Item ${item.id} cannot enter native delivery`);
      const previous = index ? state.work[unit.items[index - 1]!.id]! : null;
      const itemBase = previous
        ? previous.changeRef
        : (state.integratedSha ?? state.baseSha);
      if (!itemBase) throw new Error("Native stack predecessor has no commit");
      if (work.status === "running" && work.baseSha !== itemBase && index !== 0)
        throw new Error(`Work Item ${item.id} resumed on a changed base`);
      if (work.status === "pending" && args.paused?.()) return;
      if (work.status === "pending") {
        await args.reconcile?.();
        if (args.cancelled()) throw new Error("Objective cancelled");
        if (args.paused?.()) return;
        work.status = "running";
        work.step = "execute";
        work.baseSha = itemBase;
        work.executionBaseSha = itemBase;
        work.integratedShaAtStart = state.integratedSha ?? null;
        work.attempt = randomUUID();
        work.startedAt = new Date().toISOString();
        save();
      }
      if (
        (work.step !== "execute" &&
          work.step !== "approve-asset" &&
          work.step !== "validate") ||
        (work.execution && !work.attempt)
      )
        throw new Error(
          `Work Item ${item.id} has ambiguous active state; operator direction required`,
        );
      const perform = async (): Promise<void> => {
        if (work.step === "approve-asset") {
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
          const handle: ExecutionHandle =
            work.execution ??
            (await driver.start({
              captureContext: { objective, runId: state.runId },
              item,
              baseSha: itemBase,
              attemptId: work.attempt,
              objectiveBody: args.objectiveBody,
              selectedAssets: selectedInputsForItem(state, item),
            }));
          if (!work.execution) {
            work.execution = handle;
            save();
          }
          if (args.cancelled()) {
            await driver.cancel(handle);
            throw new Error("Objective cancelled");
          }
          const result = await driver.collect(handle);
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
        );
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
              state.additionalSources,
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
        work.pendingEffect = "review";
        save();
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
        delete work.pendingEffect;
        delete work.acceptancePending;
        if (args.cancelled()) throw new Error("Objective cancelled");
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
        work.pendingEffect = "publication";
        save();
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
        delete work.pendingEffect;
        work.status = "published";
        delete work.step;
        save();
      };
      const task = perform().catch((error: unknown) => {
        if (error instanceof AcceptanceDecisionRequired) {
          delete work.pendingEffect;
          work.status = "waiting";
          work.step = "approve-result";
          work.acceptancePending = error.pending;
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
        throw error;
      });
      active.set(item.id, task);
      try {
        await task;
      } finally {
        active.delete(item.id);
      }
      if (state.work[item.id]?.status === "waiting") return;
    }
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
      layers.map((layer) =>
        github.observe({
          number: layer.pullRequest,
          branch: layer.branch,
          headSha: layer.headSha,
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
      for (const [index, observation] of observations.entries())
        if (observation.state !== "open" || observation.checks !== "passing")
          throw new Error(
            `Native PR #${layers[index]!.pullRequest} is not ready to merge`,
          );
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
    if (layers.length === 1) {
      topWork.pendingEffect = "merge";
      save();
      const layer = layers[0]!;
      const merge = async () =>
        (
          await github.merge(
            {
              number: layer.pullRequest,
              branch: layer.branch,
              headSha: layer.headSha,
            },
            layer.headSha,
          )
        ).integratedSha;
      integratedSha = args.diagnostics
        ? await args.diagnostics.span(mergeOperation, merge, (headSha) => ({
            integratedSha: headSha,
          }))
        : await merge();
    } else {
      state.stackNumbers ??= {};
      const ensureStack = async () => {
        topWork.pendingEffect = "publication";
        save();
        const number = await github.ensureNativeStack(layers, defaultBranch);
        delete topWork.pendingEffect;
        return number;
      };
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
      topWork.pendingEffect = "merge";
      save();
      const mergeStack = () =>
        github.mergeNativeStack(layers, defaultBranch, stackNumber, {
          resumeUuid: pending?.uuid,
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
        });
      integratedSha = args.diagnostics
        ? await args.diagnostics.span(
            mergeOperation,
            mergeStack,
            (headSha) => ({ integratedSha: headSha }),
          )
        : await mergeStack();
    }
    await gitAsync(config.checkout, "fetch", "origin", defaultBranch);
    const observedAfter = git(config.checkout, "rev-parse", "FETCH_HEAD");
    if (observedAfter !== integratedSha)
      throw new Error(
        `Default branch changed after native unit ${unit.id}; expected ${integratedSha}, observed ${observedAfter}`,
      );
    state.integratedSha = observedAfter;
    for (const item of unit.items) {
      const work = state.work[item.id]!;
      delete work.pendingEffect;
      work.status = "done";
      work.integratedSha = observedAfter;
      work.completedAt = new Date().toISOString();
    }
    save();
    for (const item of unit.items)
      await closeWorkItem(state, item.id, github, save, true);
  }
}
