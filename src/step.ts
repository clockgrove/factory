/**
 * Converting a call site to `step` (recovery v2.2, #515):
 * 1. Wrap one repeatable effect: `await step(state, { scope, name, paid }, async (ctx) => ..., { save, signal })`
 *    with scope `{ item, attempt: work.attempt }` or `"objective"` and a kebab-case name (`publish`, `merge`).
 * 2. The body must be correct when repeated from the top: observe first, create idempotently.
 * 3. Call `ctx.progress()` after each successful poll or sub-call so long waits never look like an outage.
 * 4. In a paid step wrap the model turn or worker run in `ctx.paid(() => ...)`; only its faults count.
 * 5. `step` returns only on success. Branch on `faultOf(error).kind` when it throws:
 *    work: fail the attempt, then repair or retry; decision / config: its `wait` is already saved, leave the
 *    item (or Objective) waiting; defect: stop and report. Transient faults never leave `step`.
 * 6. Delete the site's old repeat loop (repeatInterrupted, retryTransient, interruptions, waitingReason).
 * 7. `factory retry` calls `clearRepeats(state, { item })`; other waits use `setWait` / `clearWait`.
 * 8. Tests inject `{ clock }` (or `setStepClock`) so backoff never sleeps in real time.
 */
import { setTimeout as sleep } from "node:timers/promises";
import {
  decision,
  transient,
  type Fault,
  faultDetail,
  faultOf,
  IDENTITY,
  type RepeatRecord,
  STEP_NAME,
  StepFault,
  type Wait,
} from "./fault.js";
import type { FactoryState, PreparationState } from "./state.js";

/** Snapshots that hold repeat records: Objective steps run in both. */
export type StepState = FactoryState | PreparationState;

/** Whose step this is. Item steps are keyed by attempt, so a retry starts clean. */
export type StepScope = { item: string; attempt: string } | "objective";
/** Where a wait is recorded: on the Work Item or on the Objective. */
export type WaitScope = { item: string } | "objective";

export interface StepSpec {
  scope: StepScope;
  /** Kebab-case step name, such as `publish` or `plan`. */
  name: string;
  /** A model turn or worker run: bounded instead of repeated forever. */
  paid?: boolean;
}

export interface StepContext {
  /** A call inside the step succeeded: the step is not in an outage. */
  progress(): void;
  /** Run the paid call of a paid step; only its faults count toward the bound. */
  paid<T>(call: () => Promise<T>): Promise<T>;
}

/** Time for backoff. Tests inject one so nothing waits in real time. */
export interface StepClock {
  now(): number;
  sleep(milliseconds: number, signal?: AbortSignal): Promise<void>;
}

export interface StepOptions {
  /** Persist the snapshot; called after every change to records or waits. */
  save: () => void;
  /** Aborts a backoff and stops repeating (cancel). */
  signal?: AbortSignal;
  clock?: StepClock;
}

export const FIRST_BACKOFF_MS = 1_000;
export const MAX_BACKOFF_MS = 5 * 60_000;
/** Status reports an outage once a step has failed for this long. */
export const OUTAGE_AFTER_MS = 60_000;
/** After this long a free step asks the operator to retry or cancel, and keeps waiting. */
export const ESCALATE_AFTER_MS = 24 * 60 * 60_000;
/** Paid faults a paid step repeats; the next one is a decision. */
export const PAID_FAULT_LIMIT = 3;
/** Longest single sleep, so distant `retryAt` times stay within timer range. */
const MAX_SLEEP_MS = 60 * 60_000;

const systemClock: StepClock = {
  now: () => Date.now(),
  sleep: (milliseconds, signal) =>
    sleep(milliseconds, undefined, signal ? { signal } : undefined),
};
let defaultClock = systemClock;

/** Replace the clock steps use when none is passed; returns a restore. Tests only. */
export function setStepClock(clock: StepClock): () => void {
  const previous = defaultClock;
  defaultClock = clock;
  return () => {
    defaultClock = previous;
  };
}

/** Delay before the `count`th repeat: 1 s doubling to a 5-minute cap. */
export function backoffDelay(count: number): number {
  return Math.min(
    FIRST_BACKOFF_MS * 2 ** Math.max(0, count - 1),
    MAX_BACKOFF_MS,
  );
}

/** The `state.repeats` key of a step. */
export function repeatKey(scope: StepScope, name: string): string {
  if (!STEP_NAME.test(name)) throw new Error(`Invalid step name ${name}`);
  if (scope === "objective") return `objective/${name}`;
  if (!IDENTITY.test(scope.item) || !IDENTITY.test(scope.attempt))
    throw new Error(`Invalid step scope ${scope.item}/${scope.attempt}`);
  return `${scope.item}/${scope.attempt}/${name}`;
}

function waitHolder(state: StepState, scope: WaitScope): { wait?: Wait } {
  if (scope === "objective") return state;
  const work = "work" in state ? state.work[scope.item] : undefined;
  if (!work) throw new Error(`Work Item ${scope.item} has no state`);
  return work;
}

export function waitOf(state: StepState, scope: WaitScope): Wait | undefined {
  return waitHolder(state, scope).wait;
}

export function setWait(state: StepState, scope: WaitScope, wait: Wait): void {
  waitHolder(state, scope).wait = { ...wait };
}

const sameWait = (a: Wait | undefined, b: Wait | undefined): boolean =>
  !!a && !!b && a.kind === b.kind && a.detail === b.detail && a.fix === b.fix;

/**
 * Clear the scope's wait, or only `expected` when given. Returns whether a
 * wait was cleared; the caller saves.
 */
export function clearWait(
  state: StepState,
  scope: WaitScope,
  expected?: Wait,
): boolean {
  const holder = waitHolder(state, scope);
  if (!holder.wait || (expected && !sameWait(holder.wait, expected)))
    return false;
  delete holder.wait;
  return true;
}

/**
 * Delete the scope's repeat records (every attempt of an item, or every
 * Objective step) and the waits steps wrote for them. Used by `factory
 * retry`. Returns whether any record existed; the caller saves.
 */
export function clearRepeats(state: StepState, scope: WaitScope): boolean {
  const repeats = state.repeats;
  if (!repeats) return false;
  let cleared = false;
  for (const [key, record] of Object.entries(repeats)) {
    const parts = key.split("/");
    if (
      scope === "objective"
        ? parts.length === 2 && parts[0] === "objective"
        : parts.length === 3 && parts[0] === scope.item
    ) {
      clearStepWait(state, scope, parts.at(-1)!, record);
      delete repeats[key];
      cleared = true;
    }
  }
  if (!Object.keys(repeats).length) delete state.repeats;
  return cleared;
}

/** A step failing right now, for status. */
export interface Outage {
  step: string;
  since: string;
  /** Transient faults since `since`. */
  tries: number;
  last: Fault;
}

/**
 * The longest-running failing step of an item's attempt or of the Objective,
 * or undefined when none is failing.
 */
export function outageOf(
  state: StepState,
  scope: StepScope,
): Outage | undefined {
  let found: Outage | undefined;
  for (const [key, record] of Object.entries(state.repeats ?? {})) {
    const parts = key.split("/");
    const step =
      scope === "objective"
        ? parts.length === 2 && parts[0] === "objective"
          ? parts[1]
          : undefined
        : parts.length === 3 &&
            parts[0] === scope.item &&
            parts[1] === scope.attempt
          ? parts[2]
          : undefined;
    if (!step || record.count < 1) continue;
    if (!found || Date.parse(record.since) < Date.parse(found.since))
      found = {
        step,
        since: record.since,
        tries: record.count,
        last: record.last,
      };
  }
  return found;
}

/**
 * The waits a step writes, each derived from its record alone, so the step
 * recognises (and clears) its own wait after a restart.
 */
const outageWait = (name: string, record: RepeatRecord): Wait => ({
  kind: "outage",
  detail: `${name}: ${faultDetail(record.last)}`,
});
const escalationWait = (name: string, record: RepeatRecord): Wait => ({
  kind: "decision",
  detail: `${name} has failed since ${record.since}; retry or cancel?`,
});
const paidBoundWait = (name: string, record: RepeatRecord): Wait => ({
  kind: "decision",
  detail: `${name} failed ${record.paid} times with an unknown outcome; retry or cancel?`,
});

/** Clear the wait a step wrote for `record`, if it is still the scope's wait. */
function clearStepWait(
  state: StepState,
  scope: WaitScope,
  name: string,
  record: RepeatRecord | undefined,
): boolean {
  return (
    !!record &&
    [outageWait, escalationWait, paidBoundWait].some((wait) =>
      clearWait(state, scope, wait(name, record)),
    )
  );
}

const iso = (time: number) => new Date(time).toISOString();
/** Persisted waits and records need non-empty text. */
const text = (value: string, fallback: string) =>
  value.trim() ? value : fallback;

/** Whether this error, or one it wraps, left a `ctx.paid` call. */
function fromPaidCall(error: unknown, paidErrors: WeakSet<object>): boolean {
  for (
    let current: unknown = error, depth = 0;
    current !== null && typeof current === "object" && depth < 8;
    current = (current as { cause?: unknown }).cause, depth++
  )
    if (paidErrors.has(current)) return true;
  return false;
}

/**
 * Run one repeatable effect. Transient faults repeat with a persisted
 * backoff (until `retryAt` when the fault names one); a restart resumes from
 * the saved record. Success deletes the record. See the top of this file.
 */
export async function step<T>(
  state: StepState,
  spec: StepSpec,
  fn: (context: StepContext) => Promise<T>,
  options: StepOptions,
): Promise<T> {
  const { scope, name } = spec;
  const key = repeatKey(scope, name);
  waitHolder(state, scope);
  const clock = options.clock ?? defaultClock;
  const { save, signal } = options;
  const record = (): RepeatRecord | undefined => state.repeats?.[key];
  const write = (next: RepeatRecord | undefined) => {
    if (next) {
      state.repeats ??= {};
      state.repeats[key] = next;
    } else if (state.repeats) {
      delete state.repeats[key];
      if (!Object.keys(state.repeats).length) delete state.repeats;
    }
  };
  const clearOwnWait = (current: RepeatRecord | undefined) =>
    clearStepWait(state, scope, name, current);

  for (;;) {
    signal?.throwIfAborted();
    const pending = record();
    if (pending) {
      const remaining = Date.parse(pending.nextAt) - clock.now();
      if (remaining > 0) {
        await clock.sleep(Math.min(remaining, MAX_SLEEP_MS), signal);
        continue;
      }
    }

    /**
     * End the current run of transient faults: the service answered. Only
     * the paid count survives. Returns whether anything changed.
     */
    const endRun = (): boolean => {
      const current = record();
      if (!current || current.count === 0) return false;
      clearOwnWait(current);
      write(
        current.paid
          ? { ...current, since: iso(clock.now()), count: 0 }
          : undefined,
      );
      return true;
    };
    let done = false;
    const paidErrors = new WeakSet<object>();
    const progress = () => {
      if (!done && endRun()) save();
    };
    const context: StepContext = {
      progress,
      paid: async (call) => {
        if (!spec.paid)
          throw new Error(`Step ${name} is not paid but made a paid call`);
        try {
          const result = await call();
          progress();
          return result;
        } catch (error) {
          if (error !== null && typeof error === "object")
            paidErrors.add(error);
          throw error;
        }
      },
    };

    try {
      const result = await fn(context);
      done = true;
      const current = record();
      if (current) {
        clearOwnWait(current);
        write(undefined);
        save();
      }
      return result;
    } catch (error) {
      done = true;
      if (signal?.aborted) throw error;
      const fault = faultOf(error);
      if (fault.kind !== "transient") {
        // work: the caller repairs or retries; defect: the caller stops.
        let changed = endRun();
        if (fault.kind === "decision" || fault.kind === "config") {
          setWait(
            state,
            scope,
            fault.kind === "decision"
              ? { kind: "decision", detail: text(fault.question, "decision") }
              : {
                  kind: "prerequisite",
                  detail: text(fault.detail, "configuration"),
                  fix: text(fault.fix, "see the error"),
                },
          );
          changed = true;
        }
        if (changed) save();
        throw error;
      }

      const current = record();
      const now = clock.now();
      const fresh = !current || current.count === 0;
      const counted =
        spec.paid === true &&
        fault.outcomeUnknown &&
        !fault.retryAt &&
        fromPaidCall(error, paidErrors);
      const paid = (current?.paid ?? 0) + (counted ? 1 : 0);
      const count = fresh ? 1 : current.count + 1;
      const retryAt = fault.retryAt ? Date.parse(fault.retryAt) : Number.NaN;
      const next: RepeatRecord = {
        since: fresh ? iso(now) : current.since,
        count,
        // A copy in the exact persisted shape, whatever the adapter attached.
        last: transient(
          text(fault.detail, "transient fault"),
          fault.outcomeUnknown === true,
          Number.isFinite(retryAt) ? iso(retryAt) : undefined,
        ),
        nextAt: iso(retryAt > now ? retryAt : now + backoffDelay(count)),
        ...(paid ? { paid } : {}),
      };
      clearOwnWait(current);
      write(next);
      if (paid > PAID_FAULT_LIMIT) {
        const wait = paidBoundWait(name, next);
        setWait(state, scope, wait);
        save();
        throw new StepFault(decision(wait.detail, faultDetail(fault)), {
          cause: error,
        });
      }
      const failing = now - Date.parse(next.since);
      if (failing >= ESCALATE_AFTER_MS)
        setWait(state, scope, escalationWait(name, next));
      else if (failing >= OUTAGE_AFTER_MS)
        setWait(state, scope, outageWait(name, next));
      save();
    }
  }
}
