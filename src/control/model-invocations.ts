import { AsyncLocalStorage } from "node:async_hooks";

/** Process ownership is intentionally ephemeral: a restart makes every pending dispatch unknown. */
export class ModelInvocationScopes {
  readonly active = new Set<string>();
  readonly #scope = new AsyncLocalStorage<Set<string>>();
  #admissionTail: Promise<void> = Promise.resolve();

  /** Serialize the short durable admission decision, never the model's lifetime. */
  async admit<T>(operation: () => Promise<T>): Promise<T> {
    const prior = this.#admissionTail;
    let release!: () => void;
    this.#admissionTail = new Promise<void>((resolve) => { release = resolve; });
    await prior;
    try { return await operation(); }
    finally { release(); }
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const owned = new Set<string>();
    return this.#scope.run(owned, async () => {
      try {
        return await operation();
      } finally {
        for (const key of owned) this.active.delete(key);
      }
    });
  }

  claim(key: string): void {
    const owned = this.#scope.getStore();
    if (!owned) throw new Error("model dispatch requires an owned operation scope");
    if (this.active.has(key)) throw new Error("model invocation is already active");
    owned.add(key);
    this.active.add(key);
  }
}
