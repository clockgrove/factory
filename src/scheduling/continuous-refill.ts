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

  start(
    key: Key,
    operation: () => Promise<void>,
    onSettled: () => void = () => {},
  ): void {
    if (this.#active.has(key)) throw new Error("execution is already active");
    const task = Promise.resolve()
      .then(operation)
      .then<ExecutionSettlement<Key>>(() => ({ key }))
      .catch((error: unknown): ExecutionSettlement<Key> => ({ key, error }))
      .finally(() => {
        try {
          onSettled();
        } finally {
          this.#active.delete(key);
        }
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
    if (this.#active.size === 0) return delay(pollMs, signal);
    return Promise.race([...this.#active.values(), delay(pollMs, signal)]);
  }

  async settle(): Promise<ExecutionSettlement<Key>[]> {
    return Promise.all([...this.#active.values()]);
  }
}
