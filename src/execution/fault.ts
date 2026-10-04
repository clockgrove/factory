import Anthropic from "@anthropic-ai/sdk";
import { AuthenticationRequiredError } from "../contracts.js";
import { type Fault, requestFault, StepFault, transient } from "../fault.js";
import {
  ProviderTurnIncompleteError,
  ProviderTurnTimeoutError,
} from "../provider-turn.js";

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

/** A controller credential the driver needs is not set: `config`. */
export function missingCredential(detail: string): StepFault {
  return new StepFault({ kind: "config", detail, fix: CREDENTIAL_FIX });
}

/**
 * Classify an error leaving an execution driver or sandbox provider method.
 * A StepFault the driver built carries its own classification; a lost
 * response to an effect may have spent a paid run.
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
  if (
    error instanceof ProviderTurnTimeoutError ||
    error instanceof ProviderTurnIncompleteError
  )
    return transient(detail, true);
  return providerRequestFault(error, EFFECTS.has(method));
}

/**
 * A failed provider request: the shared HTTP and network rules, plus the
 * Anthropic SDK's connection errors (including its timeout subclass), which
 * carry no status and no network code.
 */
export function providerRequestFault(
  error: unknown,
  outcomeUnknown: boolean,
): Fault | undefined {
  if (error instanceof Anthropic.APIConnectionError)
    return transient(error.message, outcomeUnknown);
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
