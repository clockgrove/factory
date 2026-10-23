import type { RunLog } from "./log.js";
import { errorMessage } from "./text.js";

/** Capped exponential backoff: `baseMs` after the first failure, doubling, up to `maxMs`. */
export function backoffMs(
  failures: number,
  baseMs: number,
  maxMs: number,
): number {
  return Math.min(baseMs * 2 ** (Math.max(failures, 1) - 1), maxMs);
}

export interface JobTiming {
  baseMs: number;
  maxMs: number;
  deadlineMs: number;
}

export interface JobOptions {
  /** Wait a backoff after a failure (default); false runs it again on the next call. */
  backoff?: boolean;
  /** After a success. */
  done?: () => void;
  /** After a failure, before its backoff starts. */
  failed?: (error: unknown) => Promise<void> | void;
}

interface Running {
  issue: number;
  controller: AbortController;
}

/**
 * Background work beside the service loop, keyed (a key names one job of
 * one Objective; issue 0 is the installation's own). At most one run of a
 * key is in flight, and a key whose run failed waits a capped backoff of
 * its own, so one Objective's failing job never spends what the others
 * need. Each run gets a signal that aborts at its deadline; a run past
 * its deadline counts as failed and leaves its key at once, whether or not
 * it heeds the signal, so a hung call never holds a key. `forget` aborts
 * and drops an Objective's (or one key's) running and backing-off jobs. A
 * run that left its key (deadline or forget) changes nothing when it ends.
 */
export class Jobs {
  private readonly running = new Map<string, Running>();
  private readonly waits = new Map<
    string,
    { issue: number; failures: number; nextAt: number }
  >();

  constructor(
    private readonly log: RunLog,
    /** The log event a failure writes. */
    private readonly event: string,
    private readonly timing: JobTiming,
    private readonly now: () => number = () => Date.now(),
    /** More log fields for a failure. */
    private readonly describe: (
      error: unknown,
    ) => Record<string, unknown> = () => ({}),
  ) {}

  /** Start `job` under `key` unless that key is running or backing off. */
  run(
    issue: number,
    key: string,
    job: (signal: AbortSignal) => Promise<void>,
    options: JobOptions = {},
  ): void {
    if (this.running.has(key)) return;
    const wait = this.waits.get(key);
    if (wait && this.now() < wait.nextAt) return;
    const entry: Running = { issue, controller: new AbortController() };
    const { signal } = entry.controller;
    this.running.set(key, entry);
    const timer = setTimeout(
      () =>
        entry.controller.abort(
          new Error(`deadline: ${key} ran past ${this.timing.deadlineMs} ms`),
        ),
      this.timing.deadlineMs,
    );
    timer.unref();
    const deadline = new Promise<never>((_, reject) =>
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      }),
    );
    let work: Promise<void>;
    try {
      work = job(signal);
    } catch (error) {
      work = Promise.reject(error);
    }
    const current = () => this.running.get(key) === entry;
    Promise.race([work, deadline])
      .then(
        () => {
          if (!current()) return;
          this.waits.delete(key);
          options.done?.();
        },
        async (error: unknown) => {
          if (!current()) return;
          // The backoff starts, and the key frees (a deadline frees it now).
          const failures = (this.waits.get(key)?.failures ?? 0) + 1;
          const nextAt =
            options.backoff === false
              ? undefined
              : this.now() +
                backoffMs(failures, this.timing.baseMs, this.timing.maxMs);
          if (nextAt !== undefined)
            this.waits.set(key, { issue, failures, nextAt });
          this.running.delete(key);
          await options.failed?.(error);
          this.log.write(issue, {
            event: this.event,
            job: key,
            failures,
            error: errorMessage(error),
            ...(nextAt !== undefined
              ? { retryAt: new Date(nextAt).toISOString() }
              : {}),
            ...this.describe(error),
          });
        },
      )
      .finally(() => {
        clearTimeout(timer);
        if (current()) this.running.delete(key);
      });
  }

  /** Whether a run of `key` is in flight. */
  active(key: string): boolean {
    return this.running.has(key);
  }

  /** Whether `key` is in flight or backing off after a failure. */
  pending(key: string): boolean {
    return this.running.has(key) || this.waits.has(key);
  }

  /** Whether any job of Objective `issue` is in flight. */
  busy(issue: number): boolean {
    return [...this.running.values()].some((entry) => entry.issue === issue);
  }

  /**
   * Abort and drop an Objective's jobs (`issue`), or one key's; their
   * backoffs go too. A running job `spare` names finishes instead.
   */
  forget(
    owner: number | string,
    spare: (key: string) => boolean = () => false,
  ): void {
    const mine = (key: string, issue: number) =>
      typeof owner === "number" ? issue === owner : key === owner;
    for (const [key, entry] of this.running)
      if (mine(key, entry.issue) && !spare(key)) {
        this.running.delete(key);
        entry.controller.abort(new Error(`forgotten: ${key}`));
      }
    for (const [key, wait] of this.waits)
      if (mine(key, wait.issue)) this.waits.delete(key);
  }
}
