import { AuthenticationRequiredError, Interruption } from "../contracts.js";
import {
  attachedFault,
  type Fault,
  requestFault,
  transient,
} from "../fault.js";
import {
  ProviderTurnIncompleteError,
  ProviderTurnTimeoutError,
} from "../provider-turn.js";
import { SettledAttemptFailure } from "../work-repair.js";

/** Methods whose effect may have happened when their response was lost. */
const EFFECTS = new Set([
  "start",
  "cancel",
  "create",
  "prepareRepository",
  "upload",
  "execute",
  "destroy",
]);

const CREDENTIAL_FIX =
  "Set the named credential in the controller environment, then `factory run`";

/**
 * Classify an error leaving an execution driver or sandbox provider method.
 * A worker is dead only once the driver has settled it (SettledAttemptFailure),
 * so that, and a lost response to an effect, may have spent a paid run.
 */
export function executionFault(
  error: unknown,
  method: string,
): Fault | undefined {
  const detail = error instanceof Error ? error.message : String(error);
  if (error instanceof AuthenticationRequiredError)
    return {
      kind: "config",
      detail,
      fix: `Run \`${error.authentication.command}\` in the developer environment, then \`factory run\``,
    };
  if (error instanceof SettledAttemptFailure)
    return error.classification === "implementation"
      ? { kind: "work", evidence: { detail } }
      : transient(`The worker stopped without a result: ${detail}`, true);
  if (
    error instanceof ProviderTurnTimeoutError ||
    error instanceof ProviderTurnIncompleteError
  )
    return transient(detail, true);
  const outcomeUnknown = EFFECTS.has(method);
  if (error instanceof Interruption)
    return (
      attachedFault(error.cause) ??
      requestFault(error.cause, { outcomeUnknown, fix: CREDENTIAL_FIX }) ??
      transient(detail, outcomeUnknown)
    );
  if (
    /requires controller credential|^Set [A-Z_][A-Z0-9_]* outside the target repository|controller API key is unavailable/.test(
      detail,
    )
  )
    return { kind: "config", detail, fix: CREDENTIAL_FIX };
  return requestFault(error, { outcomeUnknown, fix: CREDENTIAL_FIX });
}

/** Daytona SDK errors by class name, then the shared execution rules. */
export function daytonaFault(
  error: unknown,
  method: string,
): Fault | undefined {
  const name = error instanceof Error ? error.name : "";
  const detail = error instanceof Error ? error.message : String(error);
  if (
    (error as { code?: unknown } | undefined)?.code ===
    "DAYTONA_SDK_UNAVAILABLE"
  )
    return {
      kind: "config",
      detail,
      fix: "Do what the message says on the controller host, then `factory run`",
    };
  // The provider removed the sandbox: its processes are gone with it.
  if (
    name === "DaytonaSpotEvictedError" ||
    name === "DaytonaQueueTimeoutError" ||
    (name === "DaytonaNotFoundError" && method !== "find")
  )
    return transient(`Daytona sandbox is gone: ${detail}`, true);
  return executionFault(error, method);
}
