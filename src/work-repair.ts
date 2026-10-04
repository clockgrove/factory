import { randomUUID } from "node:crypto";
import type { DiagnosticEmitter } from "./diagnostics.js";
import { attachFault, faultOf, StepFault, transient } from "./fault.js";
import { type StepClock, StepPaused, step } from "./step.js";
import type { PlanningModel, WorkItem } from "./contracts.js";
import {
  installedControllerCapabilities,
  CONTROLLER_CAPABILITIES_DIGEST,
} from "./controller-capabilities.js";
import type { FactoryState } from "./state.js";
import {
  archiveAttempt,
  chargeRepair,
  consumption,
  failureDigest,
  itemEvent,
  repairScopes,
  validateCorrection,
  type FailureClass,
  type FailureDisposition,
  type RepairCorrection,
} from "./repair-policy.js";

/** The exact collected candidate exists, but settled local validation failed: a wrong result. */
export class CandidateValidationFailure extends Error {
  constructor(detail: string) {
    super(detail);
    attachFault(this, { kind: "work", evidence: { detail } });
  }
}
/** The controller could not prepare validation; the candidate was never judged. */
export class CandidateEnvironmentFailure extends Error {
  constructor(detail: string) {
    super(detail);
    attachFault(this, {
      kind: "config",
      detail,
      fix: "Restore the controller's validation environment; `factory retry` then validates the same candidate again",
    });
  }
}

const retryCommand = (state: FactoryState, id: string): string =>
  `factory retry --objective ${state.objective} --item ${id}`;

/**
 * Record a failed attempt. Only a contained wrong result (a `work` fault)
 * gets a failure event, so only it is diagnosed and charged. Decisions and
 * config faults normally wait instead (step rule 7); they are recorded here
 * only when a caller ends the attempt on them.
 */
export function recordWorkFailure(
  state: FactoryState,
  id: string,
  error: unknown,
): boolean {
  const work = state.work[id]!;
  const detail = error instanceof Error ? error.message : String(error);
  const fault = faultOf(error);
  const environment = error instanceof CandidateEnvironmentFailure;
  // A published result that fails (a failed check, a conflict) is repaired
  // by a new attempt that republishes the branch with a lease.
  const isolated =
    !work.integratedSha &&
    !state.coordinator?.cancelError &&
    (fault.kind === "work" || environment);
  const event =
    isolated && fault.kind === "work"
      ? itemEvent(
          id,
          work.step ?? "execute",
          work.recovery?.history?.length ?? 0,
        )
      : undefined;
  const retry = `\`${retryCommand(state, id)}\``;
  const classification: FailureClass = event
    ? "implementation"
    : environment
      ? "validation-environment"
      : fault.kind === "work"
        ? "decision"
        : fault.kind;
  const decisions: Record<FailureClass, string> = {
    implementation: `Supply a concrete diagnosis and correction (\`factory repair\`), enable implementation repair in the configured autonomy, or start a new attempt with ${retry}`,
    "validation-environment": fault.kind === "config" ? fault.fix : detail,
    "planning-output": detail,
    "planning-evidence": detail,
    "planning-choice": detail,
    decision:
      fault.kind === "decision"
        ? `${fault.question} Answer with ${retry}, or cancel`
        : `The result failed after it was integrated or while the Objective was cancelling; inspect it, then ${retry} or cancel`,
    config: `${fault.kind === "config" ? fault.fix : detail}; then ${retry}`,
    transient: `Interrupted outside a repeatable step; check the provider, network or GitHub status, then ${retry}`,
    defect: `Factory hit a defect; report it with \`factory logs\`, then start a new attempt with ${retry}`,
    cancelled: "Cancelled by the operator",
  };
  const failure: FailureDisposition = {
    digest: failureDigest(detail),
    ...(event && { event }),
    detail,
    at: new Date().toISOString(),
    classification,
    continuation: environment
      ? "exact-candidate-revalidation"
      : isolated
        ? "new-attempt-from-accepted-base"
        : "operator-decision",
    // A work fault at execute ends the attempt only after the driver
    // disposed of the worker's workspace (attempt.ts endAttempt).
    unfinishedEdits:
      fault.kind === "work" && (work.step ?? "execute") === "execute"
        ? "removed"
        : "unavailable",
    decision: decisions[classification],
  };
  // A new failure starts a fresh record: an earlier correction belongs to
  // the attempt it corrected, which the history keeps.
  work.recovery = {
    scopes: repairScopes(state, id),
    ...(work.recovery?.history && { history: work.recovery.history }),
    failure,
    phase: "stopped",
  };
  return isolated;
}
export function applyWorkCorrection(
  state: FactoryState,
  id: string,
  correction: RepairCorrection,
): void {
  const work = state.work[id];
  if (
    !work ||
    work.integratedSha ||
    state.cancelRequested ||
    state.cancelledAt ||
    state.coordinator?.cancelError ||
    state.coordinator?.processes?.length
  )
    throw new Error(
      "Repair cannot cross an unsettled, integrated or cancelled boundary",
    );
  validateCorrection(work, correction);
  // Only a wrong result is corrected; anything else is retried or answered.
  if (
    !["implementation", "validation-environment"].includes(
      work.recovery!.failure!.classification,
    )
  )
    throw new Error(
      `Only a wrong result can be repaired; use \`${retryCommand(state, id)}\``,
    );

  // The correction is bound to the event of the failure it corrects, and
  // archived with that failure and the attempt it ended.
  const { event: _unbound, ...admitted } = correction;
  const event = work.recovery?.failure?.event;
  const bound = { ...admitted, ...(event && { event }) };
  const recovery = archiveAttempt({
    ...work,
    recovery: { ...work.recovery, correction: bound },
  });
  recovery.correction = bound;
  recovery.phase = "ready";
  if (correction.kind === "implementation") {
    // A wrong result at delivery (the remote refused its content) published
    // nothing; any other failure there may have.
    if (
      work.status !== "failed" ||
      (work.step === "deliver" && !work.recovery?.failure?.event)
    )
      throw new Error(
        "Implementation repair needs an unpublished failed attempt",
      );
    chargeRepair(
      state,
      work.recovery!.failure!.event,
      correction.kind,
      repairScopes(state, id),
    );
    state.work[id] = { status: "pending", recovery };
  } else {
    if (
      correction.kind !== "validation-environment" ||
      !work.changeRef ||
      !work.treeSha ||
      !work.baseSha ||
      !["waiting", "failed"].includes(work.status)
    )
      throw new Error(
        "Exact candidate is unavailable; only a diagnosed new attempt is supported",
      );
    if (
      work.status !== "failed" ||
      work.step !== "validate" ||
      !["implementation", "validation-environment"].includes(
        work.recovery!.failure!.classification,
      )
    )
      throw new Error(
        "Environment revalidation requires a failed collected-result validation, not a semantic review decision",
      );
    chargeRepair(
      state,
      work.recovery!.failure!.event,
      correction.kind,
      repairScopes(state, id),
    );
    work.recovery = recovery;
    work.status = "running";
    work.step = "validate";
    delete work.error;
    delete work.acceptancePending;
  }
}
const diagnosisSchema = {
  type: "object",
  additionalProperties: false,
  required: ["diagnosis", "correction", "decision"],
  properties: {
    diagnosis: { type: "string" },
    correction: { type: "string" },
    decision: { type: "string", enum: ["repair", "operator"] },
  },
};
export async function diagnoseWorkRepair(args: {
  state: FactoryState;
  item: WorkItem;
  model: PlanningModel;
  save: () => void;
  stopped: () => boolean;
  diagnostics?: DiagnosticEmitter;
  sources?: { path: string; content: string; heading?: string }[];
  /** The run's cancel signal: ends the diagnose step's wait or try. */
  signal?: AbortSignal;
  /** The run's pause signal: ends the diagnose step's wait; it resumes later. */
  pause?: AbortSignal;
  /** Backoff time for the diagnose step; tests inject one. */
  clock?: StepClock;
}): Promise<boolean> {
  const { state, item, save } = args;
  const work = state.work[item.id]!;
  const failure = work.recovery?.failure;
  // Only a wrong result has a failure event; anything else is repeated or
  // fixed, never diagnosed against an allowance. A cancelled run diagnoses
  // nothing.
  if (!failure?.event || work.status !== "failed" || args.signal?.aborted)
    return false;
  const retry = retryCommand(state, item.id);
  if (work.recovery?.phase === "ready" && work.recovery.correction) {
    // The next pass applies a ready correction once the run goes on.
    if (args.stopped()) return false;
    applyWorkCorrection(state, item.id, work.recovery.correction);
    save();
    return true;
  }
  const stop = (decision: string): false => {
    work.recovery!.phase = "stopped";
    failure.decision = decision;
    save();
    return false;
  };
  // The charge is keyed by the failure event, so a diagnosis repeated after
  // a restart or a lost response is not charged again.
  try {
    chargeRepair(
      state,
      failure.event,
      "implementation",
      repairScopes(state, item.id),
    );
  } catch (error) {
    return stop(
      `${error instanceof Error ? error.message : String(error)}; start a new attempt with \`${retry}\``,
    );
  }
  work.recovery!.phase = "diagnosing";
  save();
  // Paused, or an amendment pending: the diagnosis is due, not dropped. The
  // phase is "diagnosing", so resumeDiagnoses asks it once the run goes on
  // (pause is not cancel; its event is already charged).
  if (args.stopped()) return false;
  // A paid step: a lost answer is asked again, an invalid one again with
  // its validation error, until the paid bound makes it a decision.
  let answer: RepairCorrection | string;
  try {
    answer = await step(
      state,
      { scope: { item: item.id }, name: "diagnose", paid: true },
      (context) => {
        // The last answer's error, kept in the step's record across a restart.
        const rejected = context.previousInvalid();
        return context.paid(async () => {
          const response = await args.model.generateStructured<{
            diagnosis: string;
            correction: string;
            decision: string;
          }>({
            purpose: "diagnosis",
            objective: `Diagnose this failed Work Item using its original evidence. Return a concrete correction within the unchanged acceptance, ownership, commands and configured authority. Do not propose weaker validation, provider changes, new permissions or repeating an unchanged failure. If evidence cannot establish a correction, return operator. Prior unfinished edits are unavailable; a repair starts from the accepted base.${rejected ? `\nYour previous answer was rejected: ${rejected}. Answer again.` : ""}\n${JSON.stringify({ item, failure, prior: work.recovery?.history?.map((entry) => ({ failure: entry.failure, correction: entry.correction })), treeSha: work.treeSha, changeRef: work.changeRef })}`,
            baseSha: work.executionBaseSha ?? state.baseSha,
            sources: args.sources ?? [],
            controllerCapabilities: installedControllerCapabilities(),
            controllerCapabilitiesDigest: CONTROLLER_CAPABILITIES_DIGEST,
            schema: diagnosisSchema,
            invocation: {
              invocationId: randomUUID(),
              phase: "diagnosis",
              ordinal: consumption(state).implementationRepairs,
              observe: args.diagnostics?.modelObserver({
                scopeId: work.attempt!,
                runId: state.runId,
                itemId: item.id,
                attemptId: work.attempt,
              }),
            },
          });
          if (response.decision !== "repair")
            return (
              response.diagnosis || "Failure requires an operator decision"
            );
          const proposed: RepairCorrection = {
            kind: "implementation",
            failureDigest: failure.digest,
            event: failure.event,
            diagnosis: response.diagnosis,
            correction: response.correction,
            actor: "factory-controller",
          };
          try {
            validateCorrection(work, proposed);
          } catch (error) {
            const detail =
              error instanceof Error ? error.message : String(error);
            context.invalid(detail);
            throw new StepFault(
              transient(`Diagnosis was invalid: ${detail}`, true),
            );
          }
          return proposed;
        });
      },
      {
        save,
        ...(args.signal && { signal: args.signal }),
        ...(args.pause && { pause: args.pause }),
        ...(args.clock && { clock: args.clock }),
      },
    );
  } catch (error) {
    // Paused or cancelled: stop quietly. The phase stays "diagnosing", so
    // the next run asks again (its event is already charged).
    if (error instanceof StepPaused) return false;
    // A decision (the paid bound, a refusal) or a configuration fix stops
    // the diagnosis for the operator; anything else is a defect.
    const fault = faultOf(error);
    if (fault.kind === "cancelled") return false;
    if (fault.kind === "decision")
      return stop(
        `${fault.question} Supply a correction (\`factory repair\`) or start a new attempt with \`${retry}\``,
      );
    if (fault.kind === "config") return stop(fault.fix);
    throw error;
  }
  if (typeof answer === "string") return stop(answer);
  const correction = answer;
  work.recovery!.correction = correction;
  work.recovery!.phase = "ready";
  save();
  if (args.stopped()) return false;
  applyWorkCorrection(state, item.id, correction);
  save();
  return true;
}

/**
 * Ask again any diagnosis a restart left under way.
 * Its event is already charged, so asking again is free.
 */
export async function resumeDiagnoses(
  args: Omit<Parameters<typeof diagnoseWorkRepair>[0], "item">,
): Promise<void> {
  for (const item of args.state.graph.items) {
    const work = args.state.work[item.id];
    if (work?.status === "failed" && work.recovery?.phase === "diagnosing")
      await diagnoseWorkRepair({ ...args, item });
  }
}
