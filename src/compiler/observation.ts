import type {
  ModelInvocationContext,
  ModelInvocationObservation,
} from "../contracts.js";

export function observeModelInvocation(
  invocation: ModelInvocationContext | undefined,
  observation: Omit<
    ModelInvocationObservation,
    | "invocationId"
    | "phase"
    | "ordinal"
    | "providerAttempt"
    | "providerMaxAttempts"
  >,
): void {
  if (!invocation) return;
  const unavailable = () => {
    try {
      process.stderr.write("Factory model diagnostics unavailable\n");
    } catch {
      // Warning sinks are observational too; never expose a private error.
    }
  };
  try {
    void Promise.resolve(
      invocation.observe?.({
        invocationId: invocation.invocationId,
        phase: invocation.phase,
        ordinal: invocation.ordinal,
        ...(invocation.providerAttempt === undefined
          ? {}
          : { providerAttempt: invocation.providerAttempt }),
        ...(invocation.providerMaxAttempts === undefined
          ? {}
          : { providerMaxAttempts: invocation.providerMaxAttempts }),
        ...observation,
      }),
    ).catch(unavailable);
  } catch {
    unavailable();
  }
}

/**
 * Retained evidence that one provider attempt only started and failed, with
 * no provider thread, response or usage. Callers pair it with the absence of a
 * recorded dispatch before treating the attempt as never submitted.
 */
export function failedWithoutProviderEvidence(
  observations: readonly ModelInvocationObservation[],
  invocationId: string,
  providerAttempt: number,
): boolean {
  const [started, failed, ...rest] = observations.filter(
    (observation) =>
      observation.invocationId === invocationId &&
      observation.providerAttempt === providerAttempt,
  );
  return (
    started?.type === "started" &&
    failed?.type === "failed" &&
    rest.length === 0 &&
    !failed.usage &&
    !failed.usageAvailable &&
    failed.providerThreadId === undefined &&
    failed.responseBytes === undefined &&
    failed.responseDigest === undefined
  );
}
