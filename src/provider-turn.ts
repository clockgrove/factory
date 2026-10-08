export const DEFAULT_PROVIDER_TURN_IDLE_TIMEOUT_MS = 15 * 60 * 1_000;

/** Native event surfaces may omit ongoing reasoning; higher effort gets a finite quiet window. */
export function modelResponseTimeoutMs(reasoningEffort?: string): number {
  return (
    (["high", "xhigh", "max", "ultra", "persistent"].includes(
      reasoningEffort ?? "",
    )
      ? 5
      : 2) *
    60 *
    1_000
  );
}

export class ProviderTurnTimeoutError extends Error {
  constructor(
    timeoutMs: number,
    readonly waitingFor:
      | "model-response"
      | "active-tool"
      | "provider-turn" = "provider-turn",
    readonly lastOperation = "provider-start",
    readonly inactivityMs = timeoutMs,
  ) {
    super(
      `No provider events were observed for ${inactivityMs} ms (waiting for ${waitingFor}; last observed operation: ${lastOperation}; timeout ${timeoutMs} ms)`,
    );
    this.name = "ProviderTurnTimeoutError";
  }
}

export class ProviderTurnIncompleteError extends Error {
  constructor() {
    super("Provider stream ended without turn.completed");
    this.name = "ProviderTurnIncompleteError";
  }
}

export class ProviderTurnGuard {
  private readonly controller = new AbortController();
  private timer: NodeJS.Timeout | undefined;
  private ended = false;
  private timeoutError: ProviderTurnTimeoutError | undefined;
  private readonly activeTools = new Set<string>();
  private lastOperation = "provider-start";
  private lastProgressAt = Date.now();
  private readonly timeoutWaiters = new Set<
    (error: ProviderTurnTimeoutError) => void
  >();

  constructor(
    private readonly idleTimeoutMs: number,
    private readonly toolIdleTimeoutMs?: number,
  ) {
    if (
      [idleTimeoutMs, toolIdleTimeoutMs ?? idleTimeoutMs].some(
        (timeout) => !Number.isSafeInteger(timeout) || timeout <= 0,
      )
    )
      throw new Error("Provider turn idle timeout must be a positive integer");
    this.reset();
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  progress(operation?: string, tool?: { id: string; active: boolean }): void {
    if (this.ended || this.controller.signal.aborted) return;
    if (operation) this.lastOperation = operation;
    if (tool) {
      if (tool.active) this.activeTools.add(tool.id);
      else this.activeTools.delete(tool.id);
    }
    this.lastProgressAt = Date.now();
    if (this.timer) clearTimeout(this.timer);
    this.reset();
  }

  async race<T>(operation: Promise<T>): Promise<T> {
    let unsubscribe: () => void = () => undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      this.timeoutWaiters.add(reject);
      unsubscribe = () => this.timeoutWaiters.delete(reject);
      if (this.timeoutError) reject(this.timeoutError);
    });
    try {
      return await Promise.race([operation, timeout]);
    } catch (error) {
      throw this.timeoutError ?? error;
    } finally {
      unsubscribe();
    }
  }

  finish(): void {
    this.ended = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private reset(): void {
    // Progress reschedules the shared deadline without detaching active waits.
    // Settled waits remove their subscription instead of retaining payloads.
    const waitingFor =
      this.toolIdleTimeoutMs === undefined
        ? "provider-turn"
        : this.activeTools.size
          ? "active-tool"
          : "model-response";
    const timeoutMs = this.activeTools.size
      ? (this.toolIdleTimeoutMs ?? this.idleTimeoutMs)
      : this.idleTimeoutMs;
    this.timer = setTimeout(() => {
      this.timeoutError = new ProviderTurnTimeoutError(
        timeoutMs,
        waitingFor,
        this.lastOperation,
        Date.now() - this.lastProgressAt,
      );
      this.controller.abort(this.timeoutError);
      for (const reject of this.timeoutWaiters) reject(this.timeoutError);
      this.timeoutWaiters.clear();
    }, timeoutMs);
  }
}

export function requireCompletedProviderTurn(completed: boolean): void {
  if (!completed) throw new ProviderTurnIncompleteError();
}

export async function closeProviderEventStream(
  events: AsyncIterator<unknown>,
  turn: ProviderTurnGuard,
  wait: boolean,
): Promise<void> {
  let closing: Promise<unknown>;
  try {
    closing = Promise.resolve(events.return?.());
  } catch (error) {
    if (wait) throw error;
    return;
  }
  if (wait) {
    await turn.race(closing);
    return;
  }
  void closing.catch(() => undefined);
}
