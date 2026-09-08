export interface ExecutionSettlement<Key> {
  key: Key;
  error?: unknown;
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

  /** A settled key is no longer active, but its failure is not recovery authority.
   * Keep the outcome queued for final draining as well as synchronous admission fences. */
  throwIfFailed(): void {
    const failure = this.#completed.find((settlement) => settlement.error !== undefined);
    if (failure) throw failure.error;
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

  async settle(): Promise<ExecutionSettlement<Key>[]> {
    await Promise.all([...this.#active.values()]);
    return this.#completed.splice(0);
  }
}
