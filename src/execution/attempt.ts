/**
 * How execution drivers end an attempt (recovery v2.3, #515). These replace
 * Interruption, SettledAttemptFailure, retryTransient and failAttempt: a
 * driver throws the raw error and its classifier attaches the fault, or it
 * throws a StepFault it built from structure.
 */
import { AuthenticationRequiredError } from "../contracts.js";
import { attachedFault, StepFault, transient } from "../fault.js";
import { providerRequestFault } from "./fault.js";

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** The operator cancelled while the driver worked: the step stops quietly. */
export function cancelledFault(detail: string): StepFault {
  return new StepFault({ kind: "cancelled", detail });
}

/**
 * A provider request that failed in transit: network, an SDK connection
 * error, 408, 429 or 5xx.
 */
export function transportFailure(error: unknown): boolean {
  return providerRequestFault(error, false)?.kind === "transient";
}

/**
 * The attempt ended and the driver confirmed nothing of it runs.
 * - A worker that stopped without a result is `transient`, not counted
 *   here: the next `find` returns undefined, and the execute step reports
 *   the lost run once with `ctx.paidLost`.
 * - A worker that failed with a result is `work`.
 */
export function stoppedFault(
  detail: string,
  interrupted: boolean,
  cause?: unknown,
): StepFault {
  return new StepFault(
    interrupted
      ? transient(`The worker stopped without a result: ${detail}`, false)
      : { kind: "work", evidence: { detail } },
    { cause },
  );
}

/**
 * End a remote attempt after a failed call.
 * - Cancel wins: a `cancelled` fault.
 * - A fault the driver or an adapter already classified (other than a
 *   transport failure) passes through, as does a login request.
 * - A transport failure before the deadline passes through: the step
 *   repeats and the driver reattaches to the recorded phase.
 * - Anything else, including a passed deadline, stops the remote worker
 *   through `settle`.
 */
export async function endAttempt(
  error: unknown,
  options: {
    expired: boolean;
    cancelled: boolean;
    settle: (detail: string) => Promise<never>;
  },
): Promise<never> {
  if (options.cancelled) {
    if (error instanceof StepFault && error.fault.kind === "cancelled")
      throw error;
    throw new StepFault(
      { kind: "cancelled", detail: message(error) },
      { cause: error },
    );
  }
  if (
    error instanceof StepFault ||
    error instanceof AuthenticationRequiredError
  )
    throw error;
  const fault = attachedFault(error);
  if (fault && fault.kind !== "transient") throw error;
  if (!options.expired && transportFailure(error)) throw error;
  return options.settle(
    options.expired
      ? "Attempt exceeded its configured timeout"
      : message(error),
  );
}
