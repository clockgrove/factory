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
