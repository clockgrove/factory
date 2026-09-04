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

  async waitForChange(
    pollMs: number,
    signal?: AbortSignal,
  ): Promise<ExecutionSettlement<Key> | null> {
    const completed = this.#completed.shift();
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
