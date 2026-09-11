import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export const CONTROLLER_FATAL_EXIT_STATUS = Object.freeze({
  "controller-durable-state-incompatible": 65,
  "controller-internal-invariant": 70,
  "controller-discovery-failure": 72,
  "controller-local-configuration": 78,
  "controller-launcher-failure": 203,
} as const);

export type ControllerFatalDiagnosticCode = keyof typeof CONTROLLER_FATAL_EXIT_STATUS;

const CONTROLLER_FATAL_ACTION: Record<ControllerFatalDiagnosticCode, string> = {
  "controller-discovery-failure":
    "correct GitHub access or discovery state, then explicitly restart the repository controller",
  "controller-durable-state-incompatible":
    "upgrade Factory or repair the incompatible durable Factory state, then explicitly restart the repository controller",
  "controller-local-configuration":
    "correct the repository controller configuration, then explicitly restart it",
  "controller-launcher-failure":
    "run the idempotent controller install operation to refresh the launcher, then explicitly restart it",
  "controller-internal-invariant":
    "upgrade Factory or report the safe failure fingerprint, then explicitly restart the repository controller",
};

export class ControllerFatalError extends Error {
  readonly code: ControllerFatalDiagnosticCode;
  readonly safeIdentity: string;
  override readonly cause: unknown;

  constructor(code: ControllerFatalDiagnosticCode, safeIdentity: string, cause: unknown) {
    super(`Factory repository controller stopped with ${code}`, { cause });
    this.name = "ControllerFatalError";
    this.code = code;
    this.safeIdentity = boundedSafeIdentity(safeIdentity);
    this.cause = cause;
  }
}

export interface ControllerFatalDiagnostic {
  code: ControllerFatalDiagnosticCode;
  safeIdentity: string;
  failureFingerprint: string;
  executableIdentity: string;
  exitStatus: number;
  action: string;
}

export function controllerFatalAction(code: ControllerFatalDiagnosticCode): string {
  return CONTROLLER_FATAL_ACTION[code];
}

export function controllerFatalDiagnostic(
  error: ControllerFatalError,
  executableIdentity: string,
): ControllerFatalDiagnostic {
  const identity = validExecutableIdentity(executableIdentity)
    ? executableIdentity
    : "sha256:unavailable";
  const input = [identity, error.code, error.safeIdentity, causalShape(error.cause)].join("\0");
  return {
    code: error.code,
    safeIdentity: error.safeIdentity,
    failureFingerprint: `sha256:${createHash("sha256").update(input).digest("hex").slice(0, 24)}`,
    executableIdentity: identity,
    exitStatus: CONTROLLER_FATAL_EXIT_STATUS[error.code],
    action: controllerFatalAction(error.code),
  };
}

/** Content identity of the installed Factory artifact, not its mutable path. */
export async function controllerExecutableIdentity(path: string): Promise<string | null> {
  try {
    return `sha256:${createHash("sha256")
      .update(await readFile(path))
      .digest("hex")}`;
  } catch {
    return null;
  }
}

export function isDurableStateCompatibilityError(error: unknown): boolean {
  let current: unknown = error;
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 6 && current && !seen.has(current); depth++) {
    seen.add(current);
    if (current instanceof SyntaxError || errorName(current) === "ZodError") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export function validExecutableIdentity(value: string): boolean {
  return /^sha256:[a-f0-9]{64}$/.test(value);
}

function boundedSafeIdentity(value: string): string {
  return /^[a-z0-9][a-z0-9-]*(?:[=:;][a-zA-Z0-9,.;=_ -]+)?$/.test(value) && value.length <= 160
    ? value
    : "controller-invariant-failure";
}

/** Hash-only causal differentiation: raw messages, headers, bodies and paths are never emitted. */
function causalShape(error: unknown): string {
  const shape: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current && !seen.has(current); depth++) {
    seen.add(current);
    if (current instanceof Error) {
      shape.push(errorName(current));
      // The first stack line contains the message. Remaining frames are used only
      // as hash input and are never logged or returned to a service caller.
      shape.push(...(current.stack?.split("\n").slice(1, 9) ?? []));
      current = current.cause;
      continue;
    }
    if (typeof current === "object") {
      const record = current as Record<string, unknown>;
      shape.push(
        `object:${Object.keys(record).sort().join(",")}:status=${typeof record.status === "number" ? record.status : "none"}`,
      );
      current = record.cause;
      continue;
    }
    shape.push(typeof current);
    break;
  }
  return shape.join("\n");
}

function errorName(error: unknown): string {
  const name = (error as { name?: unknown })?.name;
  return typeof name === "string" && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(name)
    ? name
    : "UnknownError";
}
