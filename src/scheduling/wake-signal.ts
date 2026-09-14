/** Disposable local observation cursor. A wake carries no authority or queued work. */
export class WakeSignal {
  #revision = 0;
  readonly #listeners = new Set<() => void>();

  get revision(): number {
    return this.#revision;
  }

  changed(): void {
    this.#revision++;
    for (const listener of this.#listeners) listener();
  }

  waitForChange(
    ms: number,
    signal?: AbortSignal,
    observedRevision = this.#revision,
  ): Promise<void> {
    if (signal?.aborted || observedRevision !== this.#revision || ms <= 0) return Promise.resolve();
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
}
