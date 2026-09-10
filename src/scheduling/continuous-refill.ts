export interface ExecutionSettlement<Key> {
  key: Key;
  error?: unknown;
}

/** A process-local settlement claimed by the Supervisor's single consumer.
 * The wrapper preserves which child failed while preventing the final drain
 * from interpreting the same outcome as a second, independent failure. */
export class ClaimedExecutionFailure<Key> extends Error {
  readonly settlement: ExecutionSettlement<Key>;

  constructor(settlement: ExecutionSettlement<Key>) {
    const cause = settlement.error;
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "ClaimedExecutionFailure";
    this.settlement = settlement;
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener("abort", aborted);
      resolve(null);
    }
    function aborted() {
      clearTimeout(timer);
      reject(new Error("Factory run cancelled"));
    }
    if (signal?.aborted) aborted();
    else signal?.addEventListener("abort", aborted, { once: true });
  });
}

/** Captures every outcome while letting the scheduler refill after any one settles. */
export class ContinuousExecutionPool<Key> {
  readonly #active = new Map<Key, Promise<ExecutionSettlement<Key>>>();
  readonly #completed: ExecutionSettlement<Key>[] = [];
  readonly #listeners = new Set<() => void>();
  #revision = 0;

  /** Process-local completion cursor; settlements remain queued until consumed. */
  get revision(): number {
    return this.#revision;
  }

  start(key: Key, operation: () => Promise<void>, onSettled: () => void = () => {}): void {
    if (this.#active.has(key)) throw new Error("execution is already active");
    const task = Promise.resolve()
      .then(operation)
      .then<ExecutionSettlement<Key>>(() => ({ key }))
      .catch((error: unknown): ExecutionSettlement<Key> => ({ key, error }))
      .then((settlement) => {
        let completed = settlement;
        try {
          onSettled();
        } catch (error) {
          if (!completed.error) completed = { key, error };
        } finally {
          this.#active.delete(key);
          this.#completed.push(completed);
          this.#revision++;
          for (const notify of this.#listeners) notify();
        }
        return completed;
      });
    this.#active.set(key, task);
  }

  has(key: Key): boolean {
    return this.#active.has(key);
  }

  get size(): number {
    return this.#active.size;
  }

  keys(): Key[] {
    return [...this.#active.keys()];
  }

  takeCompleted(): ExecutionSettlement<Key> | null {
    return this.#completed.shift() ?? null;
  }

  /** Non-consuming completion notification with a cursor to close listener-registration races. */
  waitForCompletion(
    ms: number,
    signal?: AbortSignal,
    observedRevision = this.#revision,
  ): Promise<void> {
    if (signal?.aborted || observedRevision !== this.#revision) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.#listeners.delete(done);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.#listeners.add(done);
      signal?.addEventListener("abort", done, { once: true });
    });
  }

  /** Atomically claim the next child failure before an admission/recovery fence.
   * Claimed process state is never recovery authority; durable receipts still
   * control restarts. Any later, independent settlement remains for drain. */
  throwNextFailure(): void {
    const index = this.#completed.findIndex((settlement) => settlement.error !== undefined);
    if (index < 0) return;
    throw new ClaimedExecutionFailure(this.#completed.splice(index, 1)[0]!);
  }

  async waitForChange(
    pollMs: number,
    signal?: AbortSignal,
  ): Promise<ExecutionSettlement<Key> | null> {
    const completed = this.takeCompleted();
    if (completed) return completed;
    if (this.#active.size === 0) return delay(pollMs, signal);
    const settlement = await Promise.race([...this.#active.values(), delay(pollMs, signal)]);
    if (settlement === null) return null;
    const index = this.#completed.indexOf(settlement);
    if (index >= 0) this.#completed.splice(index, 1);
    return settlement;
  }

  /** Wait for physical child settlement without consuming any outcome. */
  async waitForIdle(): Promise<void> {
    await Promise.all([...this.#active.values()]);
  }

  async settle(): Promise<ExecutionSettlement<Key>[]> {
    await this.waitForIdle();
    return this.#completed.splice(0);
  }
}
