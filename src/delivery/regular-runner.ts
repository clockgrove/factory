import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { planningSources } from "../compiler.js";
import { closeWorkItem } from "../completion.js";
import type { FactoryConfig } from "../config.js";
import type {
  ContentStore,
  DeliveryStrategy,
  ExecutionDriver,
  GitHubGateway,
  PlanningModel,
  WorkItem,
} from "../contracts.js";
import {
  AuthenticationRequiredError,
  CompletedModelInvocationError,
} from "../contracts.js";
import type { DiagnosticEmitter } from "../diagnostics.js";
import {
  materializeAssetSet,
  selectedInputsForItem,
  validationLfsMembersForItem,
} from "../media.js";
import { git, gitAsync } from "../process.js";
import { preflightItemEnvironment, runQaItem } from "../qa-execution.js";
import { readyItems } from "../scheduler.js";
import type { FactoryState } from "../state.js";
import {
  AcceptanceDecisionRequired,
  reviewAcceptance,
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
  const graph = state.graph;
  const baseSha = state.baseSha;
  // Refuse the whole restart before any resumable peer can perform work.
  for (const item of graph.items) {
    const work = state.work[item.id]!;
    if (work.pendingEffect)
      throw new Error(
        `Work Item ${item.id} submitted ${work.pendingEffect} has unknown outcome; operator direction required`,
      );
    if (work.status === "running" && work.step === "deliver") {
      throw new Error(
        `Work Item ${item.id} has ambiguous active state at deliver; operator direction required; interrupted regular delivery cannot be resumed automatically. Preserve the original snapshot and exact remote branch/PR evidence; do not retry, edit state, or use a result decision to bypass this refusal`,
      );
    }
  }
  let mergeTail: Promise<void> = Promise.resolve();
  const execute = async (
    item: WorkItem,
    itemBase: string,
    existingHandle?: NonNullable<FactoryState["work"][string]["execution"]>,
  ): Promise<void> => {
    const work = state.work[item.id]!;
    try {
      if (item.kind === "qa") {
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
        });
        return;
      }
      if (!existingHandle && work.step === "execute")
        await preflightItemEnvironment({
          config,
          root,
          state,
          item,
          store: contentStore,
          baseSha: itemBase,
        });
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
      } else if (work.step !== "validate") {
        const handle =
          existingHandle ??
          (await driver.start({
            captureContext: { objective, runId: state.runId },
            item,
            baseSha: itemBase,
            attemptId: work.attempt,
            objectiveBody: args.objectiveBody,
            selectedAssets: selectedInputsForItem(state, item),
          }));
        if (!existingHandle) {
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
        if (result.assets?.length) {
          work.assets = result.assets;
          work.status = "waiting";
          work.step = "approve-asset";
          save();
          return;
        }
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
      const branch = `factory/objective-${objective}/${item.id}`;
      const publish = () =>
        delivery.publish({
          item,
          baseSha: itemBase,
          treeSha: work.treeSha!,
          changeRef: work.changeRef!,
          branch,
          lfs: Boolean(work.selectedAssetSet),
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
      save();
      const integrate = mergeTail.then(async () => {
        const merge = async () => {
          if (args.cancelled()) throw new Error("Objective cancelled");
          await args.reconcile?.();
          work.pendingEffect = "merge";
          save();
          const merged = await delivery.merge(published);
          delete work.pendingEffect;
          await gitAsync(
            config.checkout,
            "fetch",
            "origin",
            await github.defaultBranch(),
          );
          const observedHead = git(config.checkout, "rev-parse", "FETCH_HEAD");
          if (observedHead !== merged.integratedSha) {
            throw new Error(
              `Default branch moved after PR #${published.pullRequest} merged; expected ${merged.integratedSha}, observed ${observedHead}`,
            );
          }
          return observedHead;
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
        save();
      });
      mergeTail = integrate.then(
        () => undefined,
        () => undefined,
      );
      await integrate;
      await closeWorkItem(state, item.id, github, save, false);
    } catch (error) {
      if (error instanceof CompletedModelInvocationError)
        delete work.pendingEffect;
      if (error instanceof AcceptanceDecisionRequired) {
        delete work.pendingEffect;
        work.status = "waiting";
        work.step = "approve-result";
        work.acceptancePending = error.pending;
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
      save();
      throw error;
    }
  };
  for (const item of graph.items) {
    const work = state.work[item.id]!;
    if (work.status !== "running") continue;
    if (item.kind === "qa") {
      const promise = execute(item, state.integratedSha ?? baseSha).finally(
        () => active.delete(item.id),
      );
      void promise.catch(() => undefined);
      active.set(item.id, promise);
      continue;
    }
    if (
      work.step === "validate" &&
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
    if (work.step !== "execute" || !work.execution || !work.baseSha) {
      throw new Error(
        `Work Item ${item.id} has ambiguous active state at ${work.step ?? "unknown"}; operator direction required`,
      );
    }
    const promise = execute(item, work.baseSha, work.execution).finally(() => {
      active.delete(item.id);
    });
    void promise.catch(() => undefined);
    active.set(item.id, promise);
  }
  while (graph.items.some((item) => state.work[item.id]?.status !== "done")) {
    if (args.cancelled()) throw new Error("Objective cancelled");
    const reported = await driver.availableSlots();
    const available =
      reported === "unknown" ? config.execution.concurrency : reported;
    const slots = config.execution.concurrency - active.size;
    let workerSlots = available;
    const ready = args.paused?.()
      ? []
      : readyItems(graph, state.work, new Set(active.keys()), slots).filter(
          (item) => item.kind === "qa" || workerSlots-- > 0,
        );
    if (ready.length) await args.reconcile?.();
    for (const item of ready) {
      if (args.cancelled()) throw new Error("Objective cancelled");
      if (args.paused?.()) break;
      const work = state.work[item.id]!;
      work.status = "running";
      work.step = "execute";
      work.attempt = randomUUID();
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
    if (!active.size) return true;
    await Promise.race(active.values());
  }
  return false;
}
