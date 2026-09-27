import type { CopilotClient, CopilotSession } from "@github/copilot-sdk";

type StoppableCopilotClient = Pick<CopilotClient, "stop" | "forceStop">;
type CleanableCopilotClient = StoppableCopilotClient &
  Pick<CopilotClient, "deleteSession">;
type DisconnectableCopilotSession = Pick<
  CopilotSession,
  "disconnect" | "sessionId"
>;

async function bounded<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/** Require a confirmed graceful stop; force cleanup before reporting failure. */
export async function stopCopilotClient(
  client: StoppableCopilotClient,
  timeoutMs = 2_000,
): Promise<void> {
  let failure: unknown;
  try {
    const errors = await bounded(
      client.stop(),
      timeoutMs,
      "Copilot client stop timed out",
    );
    if (errors.length)
      failure = new AggregateError(
        errors,
        "Copilot client stop reported cleanup errors",
      );
  } catch (error) {
    failure = error;
  }
  if (!failure) return;
  try {
    await bounded(
      client.forceStop(),
      timeoutMs,
      "Copilot client force stop timed out",
    );
  } catch (forceError) {
    throw new AggregateError(
      [failure, forceError],
      "Copilot client graceful and forced cleanup failed",
    );
  }
  throw failure;
}

/** Bound session RPC cleanup and always continue to bounded client shutdown. */
export async function cleanupCopilotClient(
  client: CleanableCopilotClient,
  session: DisconnectableCopilotSession | undefined,
  timeoutMs = 2_000,
): Promise<void> {
  const failures: unknown[] = [];
  if (session) {
    try {
      await bounded(
        session.disconnect(),
        timeoutMs,
        "Copilot session disconnect timed out",
      );
    } catch (error) {
      failures.push(error);
    }
    try {
      await bounded(
        client.deleteSession(session.sessionId),
        timeoutMs,
        "Copilot session deletion timed out",
      );
    } catch (error) {
      failures.push(error);
    }
  }
  try {
    await stopCopilotClient(client, timeoutMs);
  } catch (error) {
    failures.push(error);
  }
  if (failures.length)
    throw new AggregateError(failures, "Copilot client cleanup failed");
}
