import { packageManagerUpdate } from "../package-manager-update.js";
import { checkRequiredEnvironment } from "../repair-policy.js";
import { stopRetryCommand } from "../run-outcome.js";
import {
  applyWorkCorrection,
  failedItemOf,
  resumeDiagnoses,
} from "../work-repair.js";
import { workspacePackageAdditions } from "../workspace-membership.js";
import {
  amendmentBlocksDispatch,
  applyPendingAmendment,
} from "../graph-amendments.js";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import {
  assertObjectiveCriteria,
  planningSources,
  validateCommandProvenance,
} from "../compiler.js";
import { closeObjectiveIssue, closeWorkItem } from "../completion.js";
import type { FactoryConfig } from "../config.js";
import { factoryConfigDigest, stateRoot, validateTarget } from "../config.js";
import {
  attachedFault,
  attachFault,
  cancelledFault,
  decision,
  faultDetail,
} from "../fault.js";
import { runNativeGraph } from "../delivery/native-runner.js";
import { runRegularGraph } from "../delivery/regular-runner.js";
import { DiagnosticEmitter, StateDiagnostics } from "../diagnostics.js";
import {
  awaitsOperator,
  clearAllRepeats,
  outageOf,
  StepPaused,
  step,
  type StepContext,
  type StepState,
  waitOf,
} from "../step.js";
import {
  executionProfileChoices,
  verifyExecutionProfiles,
} from "../execution-profiles.js";
import { fetchHead } from "../process.js";
import { objectiveCandidate } from "../qa.js";
import type {
  ContinuationState,
  FactoryState,
  PreparationState,
} from "../state.js";
import { setCoordinatorMode } from "../state.js";
import {
  objectiveRoot,
  readContinuation,
  saveState,
  statePath,
  writePreState,
} from "../state-store.js";
import { AwaitingBeforeState } from "../run-outcome.js";
import { sweepValidationWorktrees } from "../validation.js";
import {
  type ApplicationServices,
  type LocalOwner,
  configuredDiagnosticSecrets,
  canHandoff,
  CoordinatorHandoff,
  cancelRecordedSubprocesses,
  closeCancelledIssues,
} from "./ownership.js";
import { prepareObjective } from "./planning.js";
import {
  projectPreparedObjective,
  activateProjectedObjective,
} from "./projection.js";
import { finalizeObjective } from "./finalization.js";

export async function runObjectivePass(
  config: FactoryConfig,
  objective: number,
  services: ApplicationServices,
  owner: LocalOwner,
): Promise<ContinuationState> {
  validateTarget(config.repository, config.checkout);
  if (
    config.execution.kind !== "local" &&
    config.execution.kind !== "managed-agent"
  )
    throw new Error("Execution mode is not implemented");
  const root = stateRoot(config.repository);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const path = statePath(config.repository, objective);
  const diagnostics = new DiagnosticEmitter(
    config.repository,
    objective,
    configuredDiagnosticSecrets(config),
    config.capture,
    factoryConfigDigest(config),
  );
  let stateDiagnostics: StateDiagnostics | undefined;
  const save = (state: FactoryState) => {
    owner.snapshot = state;
    if (state.coordinator) {
      const phases = [
        ...new Set(
          Object.values(state.work)
            .filter((work) => work.status === "running")
            .map((work) => work.step ?? "active"),
        ),
      ];
      const phase = phases.join(",") || "waiting";
      if (state.coordinator.phase !== phase) {
        state.coordinator.phase = phase;
        state.coordinator.phaseStartedAt = new Date().toISOString();
      }
    }
    saveState(path, state);
    try {
      stateDiagnostics?.observe();
    } catch (error) {
      process.stderr.write(
        `Factory diagnostics unavailable: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  };
  owner.save = save;
  const active = new Map<string, Promise<void>>();
  const {
    driver,
    github,
    delivery,
    contentStore,
    planningModel,
    reportRunStatus,
  } = services;
  let stateForSignal: FactoryState | undefined;
  const cancellationRequested = () => Boolean(owner.snapshot?.cancelRequested);
  // Cancel stops every step. Pause, drain and handoff stop an Objective step
  // waiting between tries only at a safe point (no running item depends on
  // it); a drain that must still drive running items keeps them going.
  const objectiveSignal = () => owner.abort.signal;
  const objectivePause = () =>
    owner.snapshot && !canHandoff(owner.snapshot)
      ? undefined
      : owner.pause.signal;
  /** Stop a pass the operator cancelled: a `cancelled` fault, never a failure. */
  const stopIfCancelled = () => {
    if (cancellationRequested())
      throw cancelledFault("Objective cancellation requested");
  };
  try {
    diagnostics.emit({ operation: "objective-run", outcome: "started" });
    // A record of an earlier run's wait is stale once this run starts; its
    // steps write theirs again.
    writePreState(config.repository, objective, {});
    // Before the Objective has state its first reads repeat in memory: there
    // is nothing to save yet.
    const unsaved: Pick<PreparationState, "repeats" | "wait"> = {};
    /** Run one Objective step (see src/step.ts) on `state`'s records. */
    const objectiveStep = <T>(
      state: ContinuationState | undefined,
      name: string,
      fn: (context: StepContext) => Promise<T>,
      paid = false,
      /** False inside item runners, which keep driving their items. */
      pausable = true,
    ): Promise<T> =>
      step(
        state ?? (unsaved as StepState),
        { scope: "objective", name, paid },
        fn,
        {
          save: () => {
            if (state?.schemaVersion === 7) save(state);
            else if (state) saveState(path, state);
            else {
              // No state file yet: keep the records beside it for status, and
              // report an outage to the run's output.
              writePreState(config.repository, objective, unsaved);
              const outage = outageOf(unsaved as StepState, "objective");
              if (outage)
                reportRunStatus?.(
                  `Factory: ${outage.step} failing since ${outage.since} (${outage.tries} tries): ${faultDetail(outage.last)}`,
                );
            }
          },
          signal: objectiveSignal(),
          pause: pausable ? objectivePause() : undefined,
        },
      );
    const observeObjective = (state = owner.snapshot) =>
      objectiveStep(state, "observe", () => github.objective(objective));
    /**
     * The Objective issue changed outside Factory since planning: the
     * operator's decision, whether the run or a resume sees it first.
     */
    const changedOutside = (
      issue: { state?: string; body: string },
      state: FactoryState,
    ): Error | undefined => {
      const changed =
        issue.state === "closed" && !state.finalValidation?.passed
          ? "The Objective issue was closed"
          : state.objectiveBodyDigest &&
              createHash("sha256").update(issue.body).digest("hex") !==
                state.objectiveBodyDigest
            ? "The Objective issue body changed"
            : undefined;
      return changed
        ? attachFault(
            new Error(`${changed}; operator direction required`),
            decision(
              `${changed} outside Factory. Restore it, then factory retry --objective ${objective}; or factory cancel --objective ${objective}`,
            ),
          )
        : undefined;
    };
    const issue = await observeObjective();
    assertObjectiveCriteria(issue.body);
    const installationConfigDigest = factoryConfigDigest(config);
    const continuation = readContinuation(config.repository, objective);
    owner.snapshot = continuation;
    checkRequiredEnvironment(config, continuation?.autonomy);
    if (owner.handoff && continuation?.coordinator) {
      setCoordinatorMode(continuation, "draining");
      saveState(path, continuation);
    }
    let preparation =
      continuation?.schemaVersion === 8 ? continuation : undefined;
    let state = continuation?.schemaVersion === 7 ? continuation : undefined;
    if (issue.state === "closed" && !state)
      throw new Error(
        "Objective issue is confirmed closed; operator direction required",
      );
    if (state) {
      // Subprocesses recorded by an interrupted controller (for example a
      // validation command) are ours: stop any survivor and clear the
      // records, then repeat the step they belonged to.
      if (state.coordinator?.processes?.length) {
        await cancelRecordedSubprocesses(state);
        saveState(path, state);
      }
      if (
        state.schemaVersion !== 7 ||
        state.repository !== config.repository ||
        state.configDigest !== installationConfigDigest
      ) {
        throw new Error(
          // Cancel is refused once acceptance is sealed; the restored run reconciles.
          `Existing Objective state does not match this Factory installation; restore the configuration it started with${state.finalAcceptance ? ", then run it again" : `, or run \`factory cancel --objective ${objective}\``}`,
        );
      }
      if (state.error)
        throw new Error(
          `Objective stopped: ${state.error}. Fix the cause, then run \`${stopRetryCommand(state)}\``,
        );
      if (
        !state.objectiveBodyDigest &&
        (workspacePackageAdditions(issue.body).length ||
          packageManagerUpdate(issue.body))
      )
        throw new Error(
          "Package update authority requires a digest-bound Objective; create a new plan",
        );
      // A decision, as when delivery observes the change: the observe
      // step saves the question, and `factory retry` asks it again.
      const changed = changedOutside(issue, state);
      if (changed)
        await objectiveStep(state, "observe", async () => {
          throw changed;
        });
      stateDiagnostics = new StateDiagnostics(
        diagnostics,
        state,
        config.delivery.kind,
        state.capacity.concurrency,
      );
      const saveCurrent = () => save(state!);
      for (const item of state.graph.items)
        if (state.work[item.id]?.status === "done")
          await closeWorkItem(
            state,
            item.id,
            github,
            saveCurrent,
            config.delivery.kind === "native-stack",
            objectiveSignal(),
            objectivePause(),
          );
      if (state.finalValidation?.passed) {
        reportRunStatus?.(
          "Factory: resuming the existing run from atomic state",
        );
        if (!state.finalAcceptance && state.objectiveClosure !== "complete") {
          // A remote read: transient faults repeat with backoff.
          const head = await objectiveStep(state, "final-head", async () =>
            fetchHead(config.checkout, await github.defaultBranch()),
          );
          if (head !== objectiveCandidate(state)?.commitSha)
            throw new Error(
              "Default branch changed before historical final acceptance could be sealed",
            );
        }
        await closeObjectiveIssue(
          state,
          issue.body,
          github,
          saveCurrent,
          objectiveSignal(),
          objectivePause(),
        );
        return state;
      }
      if (state.cancelRequested || state.cancelledAt)
        throw new Error(
          "Objective was cancelled; use explicit retry or operator direction",
        );
      reportRunStatus?.("Factory: resuming the existing run from atomic state");
    } else {
      const prepared = await prepareObjective({
        config,
        objective,
        issue,
        path,
        diagnostics,
        planningModel,
        github,
        owner,
        installationConfigDigest,
        preparation,
        objectiveStep,
        cancellationRequested,
        reportRunStatus,
      });
      if ("schemaVersion" in prepared) return prepared;
      preparation = prepared.preparation;
      const { plan } = prepared;
      const projected = await projectPreparedObjective({
        config,
        objective,
        issue,
        root,
        path,
        diagnostics,
        driver,
        github,
        owner,
        preparation,
        plan,
        objectiveStep,
        cancellationRequested,
        stopIfCancelled,
      });
      state = activateProjectedObjective({
        config,
        objective,
        issue,
        installationConfigDigest,
        preparation,
        plan,
        projected,
      });
      stateDiagnostics = new StateDiagnostics(
        diagnostics,
        state,
        config.delivery.kind,
        state.capacity.concurrency,
      );
    }
    state.coordinator ??= {
      mode: "running",
      phase: "active",
      phaseStartedAt: new Date().toISOString(),
    };
    state.coordinator.observedAt = new Date().toISOString();
    await applyPendingAmendment({
      state,
      config,
      body: issue.body,
      model: planningModel,
      github,
      save: () => save(state),
      cancelled: cancellationRequested,
      signal: objectiveSignal(),
      pause: objectivePause(),
      diagnostics,
    });
    if (state.coordinator.mode === "running" && !cancellationRequested()) {
      for (const [id, work] of Object.entries(state.work)) {
        if (
          work.status === "failed" &&
          work.recovery?.phase === "ready" &&
          work.recovery.correction
        ) {
          applyWorkCorrection(state, id, work.recovery.correction);
          save(state);
        }
      }
      const current = state;
      await resumeDiagnoses({
        state: current,
        model: planningModel,
        diagnostics,
        sources: planningSources(issue.body, current.baseSha, config.checkout),
        checkout: config.checkout,
        save: () => save(current),
        stopped: () =>
          cancellationRequested() || current.coordinator?.mode !== "running",
        signal: objectiveSignal(),
        pause: objectivePause(),
      });
    }
    const graph = state.graph;
    verifyExecutionProfiles(graph, executionProfileChoices(config));
    await diagnostics.span(
      { runId: state.runId, operation: "execution-driver-preflight" },
      async () => {
        await driver.preflight?.(graph);
      },
    );
    // This controller owns the Objective: none of its validations runs yet.
    // Validation trees live in the Objective's directory, so another
    // Objective's controller keeps its own.
    const objectiveDirectory = objectiveRoot(config.repository, objective);
    await sweepValidationWorktrees(config.checkout, objectiveDirectory, root);
    validateCommandProvenance(
      graph,
      planningSources(issue.body, state.baseSha, config.checkout),
      config.checkout,
    );
    stateForSignal = state;
    save(state);
    /** Delivery re-observes the Objective: a foreign edit or closure is a decision. */
    // Items deliver concurrently; they share one observation in flight.
    let observing: Promise<void> | undefined;
    const reconcile = async () => {
      observing ??= observeUnchanged().finally(() => {
        observing = undefined;
      });
      await observing;
      stopIfCancelled();
    };
    const observeUnchanged = async () => {
      await objectiveStep(
        state,
        "observe",
        async () => {
          const changed = changedOutside(
            await github.objective(objective),
            state,
          );
          if (changed) throw changed;
        },
        false,
        false,
      );
      state.coordinator!.observedAt = new Date().toISOString();
      save(state);
    };
    if (config.delivery.kind === "native-stack") {
      await runNativeGraph({
        config,
        objective,
        objectiveBody: issue.body,
        root: objectiveDirectory,
        state,
        driver,
        delivery,
        contentStore,
        github,
        planningModel,
        save: () => save(state),
        active,
        reconcile,
        cancelled: cancellationRequested,
        signal: owner.abort.signal,
        // Read at each step: resume replaces the controller.
        get pause() {
          return owner.pause.signal;
        },
        paused: () => state.coordinator?.mode !== "running",
        amendmentPending: () => amendmentBlocksDispatch(state),
        diagnostics,
      });
      if (graph.items.some((item) => state.work[item.id]?.status === "waiting"))
        return state;
    } else {
      const awaitingSelection = await runRegularGraph({
        config,
        objective,
        objectiveBody: issue.body,
        root: objectiveDirectory,
        state,
        driver,
        delivery,
        contentStore,
        github,
        planningModel,
        save: () => save(state),
        active,
        reconcile,
        cancelled: cancellationRequested,
        signal: owner.abort.signal,
        // Read at each step: resume replaces the controller.
        get pause() {
          return owner.pause.signal;
        },
        paused: () => state.coordinator?.mode !== "running",
        amendmentPending: () => amendmentBlocksDispatch(state),
        woken: owner.woken,
        diagnostics,
      });
      if (awaitingSelection) return state;
    }
    return await finalizeObjective({
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
    });
  } catch (error) {
    if (error instanceof CoordinatorHandoff) throw error;
    // A step stopped by pause, drain or handoff while waiting between tries
    // (or a try cut off by a handoff) is not a fault: its record stays and
    // the next run resumes it.
    const paused =
      error instanceof StepPaused ||
      (attachedFault(error)?.kind === "cancelled" &&
        !!owner.handoff &&
        !cancellationRequested());
    // A handoff releases ownership at a safe point, also before the first
    // snapshot exists; the step repeats on restart.
    if (
      owner.handoff &&
      (owner.snapshot
        ? canHandoff(owner.snapshot)
        : paused && !cancellationRequested())
    ) {
      if (owner.snapshot?.coordinator) {
        setCoordinatorMode(owner.snapshot, "draining");
        saveState(path, owner.snapshot);
      }
      throw new CoordinatorHandoff();
    }
    if (error instanceof StepPaused && owner.snapshot) {
      await Promise.allSettled(active.values());
      saveState(path, owner.snapshot);
      // Paused planning: the owner serves control until resume.
      if (owner.snapshot.schemaVersion === 8) throw error;
      return owner.snapshot;
    }
    const current = owner.snapshot;
    // Before any state exists nothing can hold the wait, and `factory retry`
    // has no record to clear: the operator fixes it and runs the Objective again.
    if (!current && !cancellationRequested()) {
      const early = attachedFault(error);
      if (early?.kind === "decision" || early?.kind === "config") {
        diagnostics.emit({
          operation: "objective-run",
          outcome: "waiting",
          detail: error instanceof Error ? error.message : String(error),
        });
        throw new AwaitingBeforeState(
          objective,
          early.kind === "decision" ? early.question : early.detail,
          early.kind === "config" ? early.fix : undefined,
        );
      }
    }
    // A decision or a prerequisite to fix: the scope waits for the operator
    // and nothing fails, no worker stops (step.ts rule 7). A handoff stops
    // the pass; the next controller repeats the step.
    const fault = attachedFault(error);
    const handedOff =
      fault?.kind === "cancelled" &&
      !!owner.handoff &&
      !cancellationRequested();
    const waiting =
      !!current &&
      !cancellationRequested() &&
      (fault?.kind === "decision" || fault?.kind === "config" || handedOff);
    diagnostics.emit({
      runId: stateForSignal?.runId,
      operation: "objective-run",
      outcome: waiting ? "waiting" : "failed",
      detail: error instanceof Error ? error.message : String(error),
    });
    if (waiting && current) {
      // Other items run on to their own stopping points.
      await Promise.allSettled(active.values());
      // A question raised outside a step still names its answer.
      if (
        (fault.kind === "decision" || fault.kind === "config") &&
        !awaitsOperator(waitOf(current, "objective")) &&
        !(
          current.schemaVersion === 7 &&
          Object.values(current.work).some((work) => awaitsOperator(work.wait))
        )
      )
        current.wait =
          fault.kind === "decision"
            ? {
                kind: "decision",
                detail: fault.question,
                step: "objective/coordinator",
              }
            : {
                kind: "prerequisite",
                detail: fault.detail,
                fix: fault.fix,
                step: "objective/coordinator",
              };
      saveState(path, current);
      return current;
    }
    if (current?.schemaVersion === 7 && current.finalAcceptance) {
      // A rejected resume cannot turn immutable accepted evidence into a failed run.
      current.coordinator!.waitReason = `Sealed acceptance preserved: ${error instanceof Error ? error.message : String(error)}`;
      saveState(path, current);
      throw error;
    }
    // A failure stops only its own item (its runner stops its worker); only
    // cancel stops other items' workers. Other items run on to their own
    // stopping points.
    if (!cancellationRequested()) await Promise.allSettled(active.values());
    if (current) {
      if (cancellationRequested()) {
        await owner.cancellation;
        await Promise.allSettled(active.values());
        if (active.size === 0)
          await closeCancelledIssues(current, github, () =>
            saveState(path, current),
          );
        if (!current.coordinator?.cancelError && active.size === 0) {
          current.cancelledAt = new Date().toISOString();
          clearAllRepeats(current);
          if (current.schemaVersion === 7)
            for (const work of Object.values(current.work))
              if (work.status !== "done" && work.status !== "published")
                work.status = "cancelled";
        }
      } else if (current.schemaVersion === 8) {
        // Preparation resumes by repeating its step; record why it paused.
        current.coordinator.waitReason =
          error instanceof Error ? error.message : String(error);
      } else {
        // A run refused for an earlier stop keeps that stop's error; it must
        // not wrap the same cause again on every run.
        if (current.error === undefined) {
          current.error =
            error instanceof Error ? error.message : String(error);
          const item = failedItemOf(error);
          if (item !== undefined) current.errorItem = item;
        }
      }
      if (current.schemaVersion === 7) save(current);
      else saveState(path, current);
    }
    throw error;
  }
}
