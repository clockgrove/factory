import { createHash } from "node:crypto";

import type {
  AttemptContext,
  BackendHandle,
  ExecutionUsage,
} from "./backend.js";

export interface DurableSessionIdentity {
  attemptId: string;
  backendId: string;
  resourceId: string;
  threadId: string;
  workspace: string;
  baseSha: string;
  runId: string;
  objective: number;
  workItem: number;
  attempt: number;
  directorEpoch: number;
  startedAt: string;
}

export type SessionRecovery =
  | { outcome: "resumed"; handle: BackendHandle }
  | { outcome: "reconciled"; reason: string };

export function durableAttemptId(
  context: Pick<
    AttemptContext,
    "runId" | "objective" | "workItem" | "attempt" | "directorEpoch"
  >,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        context.runId,
        context.objective,
        context.workItem,
        context.attempt,
        context.directorEpoch,
      ]),
    )
    .digest("hex");
}

export function assertSessionIdentity(
  context: AttemptContext,
  session: DurableSessionIdentity,
): void {
  if (
    session.attemptId !== durableAttemptId(context) ||
    session.runId !== context.runId ||
    session.objective !== context.objective ||
    session.workItem !== context.workItem ||
    session.attempt !== context.attempt ||
    session.directorEpoch !== context.directorEpoch ||
    session.workspace !== context.workspace ||
    session.baseSha !== context.packet.baseSha
  )
    throw new Error(
      "durable session identity does not match the fenced attempt",
    );
}

function counter(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null;
}

export function normalizeExecutionUsage(value: unknown): ExecutionUsage {
  const usage =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  return {
    inputTokens: counter(
      usage.inputTokens ?? usage.input_tokens ?? usage.prompt_tokens,
    ),
    outputTokens: counter(
      usage.outputTokens ?? usage.output_tokens ?? usage.completion_tokens,
    ),
    cachedInputTokens: counter(
      usage.cachedInputTokens ??
        usage.cached_input_tokens ??
        usage.cached_prompt_tokens,
    ),
  };
}

/** Resume-or-stop is deliberately one operation so callers cannot launch a duplicate in between. */
export async function recoverDurableSession(
  context: AttemptContext,
  session: DurableSessionIdentity,
  operations: {
    resume(session: DurableSessionIdentity): Promise<BackendHandle>;
    reconcile(session: DurableSessionIdentity): Promise<void>;
  },
): Promise<SessionRecovery> {
  assertSessionIdentity(context, session);
  try {
    return { outcome: "resumed", handle: await operations.resume(session) };
  } catch (error) {
    await operations.reconcile(session);
    return {
      outcome: "reconciled",
      reason: `durable thread could not be resumed and was stopped safely: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}
