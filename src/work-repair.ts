import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  AuthenticationRequiredError,
  CompletedModelInvocationError,
  Interruption,
} from "./contracts.js";
import { GitHubOutcomeUnknown, GitHubRequestError } from "./github-client.js";
import {
  ProviderTurnIncompleteError,
  ProviderTurnTimeoutError,
} from "./provider-turn.js";
import type { DiagnosticEmitter } from "./diagnostics.js";
import { attachFault, faultOf, transient } from "./fault.js";
import type { PlanningModel, WorkItem } from "./contracts.js";
import {
  installedControllerCapabilities,
  CONTROLLER_CAPABILITIES_DIGEST,
} from "./controller-capabilities.js";
import type { FactoryState, WorkState } from "./state.js";
import {
  archiveAttempt,
  chargeRepair,
  consumption,
  failureDigest,
  itemEvent,
  PAID_ATTEMPTS,
  repairScopes,
  validateCorrection,
  type FailureDisposition,
  type RepairCorrection,
} from "./repair-policy.js";

/**
 * Collection settled the owned worker and removed its unfinished checkout.
 * A failed result is a wrong result (`work`); a worker that stopped without
 * one is `transient` and may have spent a paid run.
 */
export class SettledAttemptFailure extends Error {
  constructor(
    cause: unknown,
    readonly classification: "implementation" | "interruption" = "interruption",
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    attachFault(
      this,
      classification === "implementation"
        ? { kind: "work", evidence: { detail: this.message } }
        : transient(
            `The worker stopped without a result: ${this.message}`,
            true,
          ),
    );
  }
}
const transientCodes = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
  "ENOTFOUND",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);
/**
 * Whether a provider request failed in transit rather than being refused:
 * a network error or timeout, or HTTP 408, 429 or 5xx. Other 4xx responses
 * are real failures; a 404 means the resource is gone.
 */
export function transientRequestFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const { status, statusCode, code } = error as {
    status?: unknown;
    statusCode?: unknown;
    code?: unknown;
  };
  const http = typeof status === "number" ? status : statusCode;
  if (typeof http === "number")
    return http >= 500 || http === 408 || http === 429;
  return (
    error.message === "fetch failed" ||
    /Connection|Timeout/.test(error.name) ||
    (typeof code === "string" && transientCodes.has(code)) ||
    transientRequestFailure(error.cause)
  );
}

/** Consecutive transient failures a polling step absorbs before it is interrupted. */
export const TRANSIENT_RETRY_MS = 120_000;

/**
 * Run a repeatable step, retrying transient provider failures in place with
 * bounded backoff, so a brief outage does not spend a step interruption.
 * After `budgetMs` of consecutive failures the last error is thrown.
 */
export async function retryTransient<T>(
  step: () => Promise<T>,
  transient: (error: unknown) => boolean,
  budgetMs = TRANSIENT_RETRY_MS,
  firstDelayMs = 250,
): Promise<T> {
  const started = Date.now();
  for (let wait = firstDelayMs; ; wait = Math.min(wait * 2, 10_000)) {
    try {
      return await step();
    } catch (error) {
      if (!transient(error) || Date.now() - started + wait > budgetMs)
        throw error;
      await delay(wait);
    }
  }
}

/**
 * End a remote attempt after a failed step. Interruptions, settled failures
 * and authentication requests pass through, and a transient provider failure
 * before the deadline interrupts the step so it reattaches. Anything else,
 * including a passed deadline, stops the remote worker through `settle`.
 */
export async function failAttempt(
  error: unknown,
  options: {
    transient: (error: unknown) => boolean;
    expired: boolean;
    cancelled: boolean;
    settle: (detail: string) => Promise<never>;
  },
): Promise<never> {
  if (
    options.cancelled ||
    error instanceof Interruption ||
    error instanceof SettledAttemptFailure ||
    error instanceof AuthenticationRequiredError
  )
    throw error;
  if (!options.expired && options.transient(error))
    throw new Interruption(error);
  return options.settle(
    options.expired
      ? "Attempt exceeded its configured timeout"
      : error instanceof Error
        ? error.message
        : String(error),
  );
}

/**
 * Whether an error interrupted a step rather than reporting on the work:
 * a worker that ended without a result, a lost or failed provider or GitHub
 * response, or a provider turn that never completed. Repeating is safe.
 */
export function isInterruption(error: unknown): boolean {
  return (
    error instanceof Interruption ||
    (error instanceof SettledAttemptFailure &&
      error.classification === "interruption") ||
    error instanceof GitHubOutcomeUnknown ||
    (error instanceof GitHubRequestError &&
      (error.status >= 500 || error.status === 429)) ||
    error instanceof ProviderTurnTimeoutError ||
    error instanceof ProviderTurnIncompleteError
  );
}

/** Interruptions repeated per Work Item attempt before it stops as failed. */
export const MAX_INTERRUPTIONS = 2;

/**
 * Run one Work Item step, repeating it after an interruption. A worker that
 * ended without a result gets a fresh attempt from the same base. After
 * MAX_INTERRUPTIONS the error propagates and the item fails with evidence.
 */
export async function repeatInterrupted<T>(
  work: WorkState,
  save: () => void,
  step: () => Promise<T>,
  backoffMs = 1_000,
): Promise<T> {
  for (;;) {
    try {
      const result = await step();
      delete work.interruptions;
      return result;
    } catch (error) {
      if (
        !isInterruption(error) ||
        (work.interruptions ?? 0) >= MAX_INTERRUPTIONS
      )
        throw error;
      work.interruptions = (work.interruptions ?? 0) + 1;
      work.waitingReason = `Interrupted (${work.interruptions}/${MAX_INTERRUPTIONS}), repeating: ${error instanceof Error ? error.message : String(error)}`;
      if (error instanceof SettledAttemptFailure) {
        delete work.execution;
        work.attempt = randomUUID();
        work.step = "execute";
      }
      save();
      await delay(backoffMs * work.interruptions);
    }
  }
}

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
      fix: "Restore the controller's validation environment, then revalidate the same candidate with a validation-environment correction (`factory repair`)",
    });
  }
}

const retryCommand = (state: FactoryState, id: string): string =>
  `factory retry --objective ${state.objective} --item ${id}`;

/**
 * Record a failed attempt. Only a contained wrong result (a `work` fault)
 * gets a failure event, so only it is diagnosed and charged.
 */
export function recordWorkFailure(
  state: FactoryState,
  id: string,
  error: unknown,
): boolean {
  const work = state.work[id]!;
  const detail = error instanceof Error ? error.message : String(error);
  const fault = faultOf(error);
  const isolated =
    !work.pullRequest &&
    !state.coordinator?.cancelError &&
    (fault.kind === "work" ||
      error instanceof SettledAttemptFailure ||
      error instanceof CandidateEnvironmentFailure);
  const prior = work.recovery?.failure;
  const event =
    isolated && fault.kind === "work"
      ? itemEvent(
          id,
          work.step ?? "execute",
          work.recovery?.history?.length ?? 0,
        )
      : undefined;
  const failure: FailureDisposition = {
    digest: failureDigest(detail),
    ...(event && { event }),
    // Recording the same event again keeps its paid diagnoses.
    ...(event && prior?.event === event && prior.diagnoses
      ? { diagnoses: prior.diagnoses }
      : {}),
    detail,
    at: new Date().toISOString(),
    classification: event
      ? "implementation"
      : isolated
        ? error instanceof CandidateEnvironmentFailure
          ? "validation-environment"
          : "interruption"
        : isInterruption(error)
          ? "interruption"
          : "uncertain",
    continuation:
      error instanceof CandidateEnvironmentFailure
        ? "exact-candidate-revalidation"
        : isolated
          ? "new-attempt-from-accepted-base"
          : "operator-decision",
    unfinishedEdits:
      error instanceof SettledAttemptFailure ? "removed" : "unavailable",
    decision: event
      ? `Supply a concrete diagnosis and correction (\`factory repair\`), enable implementation repair in the configured autonomy, or start a new attempt with \`${retryCommand(state, id)}\``
      : fault.kind === "config"
        ? fault.fix
        : isolated
          ? `The worker stopped without a result after repeated attempts; start a new attempt with \`${retryCommand(state, id)}\``
          : isInterruption(error)
            ? "Interrupted repeatedly; check the provider, network or GitHub status, then run again"
            : "Resolve external outcome or ownership before another attempt",
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
    work.pullRequest ||
    work.integratedSha ||
    state.cancelRequested ||
    state.cancelledAt ||
    state.coordinator?.cancelError ||
    state.coordinator?.processes?.length
  )
    throw new Error(
      "Repair cannot cross an unsettled, published or cancelled boundary",
    );
  validateCorrection(work, correction);
  if (work.recovery?.failure?.classification === "uncertain")
    throw new Error("Unknown outcome cannot be repaired automatically");

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
      !["review-evidence", "validation-environment"].includes(
        correction.kind,
      ) ||
      !work.changeRef ||
      !work.treeSha ||
      !work.baseSha ||
      !["waiting", "failed"].includes(work.status)
    )
      throw new Error(
        "Exact candidate is unavailable; only a diagnosed new attempt is supported",
      );
    if (
      correction.kind === "review-evidence" &&
      !work.acceptancePending?.reviewRejection
    )
      throw new Error(
        "Semantic review requires its own decision; evidence recovery cannot waive it",
      );
    if (
      correction.kind === "validation-environment" &&
      (work.status !== "failed" ||
        work.step !== "validate" ||
        !["implementation", "validation-environment"].includes(
          work.recovery!.failure!.classification,
        ))
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
}): Promise<boolean> {
  const { state, item, save } = args;
  const work = state.work[item.id]!;
  const failure = work.recovery?.failure;
  // Only a wrong result has a failure event; anything else is repeated or
  // fixed, never diagnosed against an allowance.
  if (!failure?.event || work.status !== "failed" || args.stopped())
    return false;
  const retry = retryCommand(state, item.id);
  if (work.recovery?.phase === "ready" && work.recovery.correction) {
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
  if ((failure.diagnoses ?? 0) >= PAID_ATTEMPTS)
    return stop(
      `The diagnosis did not answer ${PAID_ATTEMPTS} times; supply a correction (\`factory repair\`) or start a new attempt with \`${retry}\``,
    );
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
  failure.diagnoses = (failure.diagnoses ?? 0) + 1;
  work.recovery!.phase = "diagnosing";
  save();
  let response;
  try {
    response = await args.model.generateStructured<{
      diagnosis: string;
      correction: string;
      decision: string;
    }>({
      purpose: "diagnosis",
      objective: `Diagnose this failed Work Item using its original evidence. Return a concrete correction within the unchanged acceptance, ownership, commands and configured authority. Do not propose weaker validation, provider changes, new permissions or repeating an unchanged failure. If evidence cannot establish a correction, return operator. Prior unfinished edits are unavailable; a repair starts from the accepted base.\n${JSON.stringify({ item, failure, prior: work.recovery?.history?.map((entry) => ({ failure: entry.failure, correction: entry.correction })), treeSha: work.treeSha, changeRef: work.changeRef })}`,
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
  } catch (error) {
    if (error instanceof CompletedModelInvocationError)
      return stop(error.message);
    // An unanswered diagnosis stays under way; the next run asks again
    // (see resumeDiagnoses). A configuration fault was not paid for.
    const fault = faultOf(error);
    if (fault.kind !== "transient" && fault.kind !== "config") throw error;
    if (fault.kind === "config") failure.diagnoses--;
    failure.decision =
      fault.kind === "config"
        ? fault.fix
        : `The diagnosis did not answer (${failure.diagnoses}/${PAID_ATTEMPTS}); run the Objective again to ask again`;
    save();
    return false;
  }
  work.recovery!.phase = "stopped";
  if (response.decision !== "repair") {
    failure.decision =
      response.diagnosis || "Failure requires an operator decision";
    save();
    return false;
  }
  const correction: RepairCorrection = {
    kind: "implementation",
    failureDigest: failure.digest,
    event: failure.event,
    diagnosis: response.diagnosis,
    correction: response.correction,
    actor: "factory-controller",
  };
  try {
    validateCorrection(work, correction);
  } catch (error) {
    failure.decision = error instanceof Error ? error.message : String(error);
    save();
    return false;
  }
  work.recovery!.correction = correction;
  work.recovery!.phase = "ready";
  save();
  if (args.stopped()) return false;
  applyWorkCorrection(state, item.id, correction);
  save();
  return true;
}

/** A transport-only review rejection has a precise controller-owned correction. */
export function prepareEvidenceRecovery(
  state: FactoryState,
  id: string,
): boolean {
  const work = state.work[id]!;
  const rejection = work.acceptancePending?.reviewRejection;
  if (!rejection) return false;
  const detail = JSON.stringify(work.acceptancePending);
  // A completed review answer whose evidence was refused is corrected like a
  // wrong result: one charge per refused review.
  const event = itemEvent(
    id,
    work.step ?? "approve-result",
    work.recovery?.history?.length ?? 0,
  );
  work.recovery = {
    scopes: repairScopes(state, id),
    ...(work.recovery?.history && { history: work.recovery.history }),
    failure: {
      digest: failureDigest(detail),
      event,
      classification: "review-evidence",
      detail,
      at: new Date().toISOString(),
      continuation: "exact-result-review",
      unfinishedEdits: "unavailable",
      decision:
        "Repeat independent review using the supplied source IDs and response schema",
    },
    phase: "stopped",
  };
  if (rejection.reason === "source-truncated") return false;
  try {
    applyWorkCorrection(state, id, {
      kind: "review-evidence",
      failureDigest: work.recovery.failure!.digest,
      actor: "factory-controller",
      diagnosis: `Review transport rejected ${rejection.field}: ${rejection.reason}`,
      correction:
        "Revalidate the preserved exact candidate and rerun independent review against a fresh complete evidence packet; use only supplied source IDs and the required response schema.",
    });
    return true;
  } catch (error) {
    work.recovery.failure!.decision =
      `${error instanceof Error ? error.message : String(error)}; decide the result with \`factory decide-result\` or ask for \`factory rereview\``;
    return false;
  }
}

/**
 * Ask again any diagnosis a restart or an unanswered call left under way.
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
