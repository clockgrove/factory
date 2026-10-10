/**
 * Converting a call site to `step` (recovery v2.2, #515):
 * 1. Wrap one repeatable effect: `await step(state, { scope, name, paid }, async (ctx) => ..., { save, signal, clock })`
 *    with scope `{ item: id }` or `"objective"` and a kebab-case name (`publish`, `merge`, `plan`).
 * 2. The body is correct when repeated from the top: observe first, create idempotently, confirm.
 * 3. The body classifies its own checks: a bad result throws `work`, a foreign change `decision`, lag or
 *    "not visible yet" a `transient` StepFault. Anything unclassified is a `defect`.
 * 4. `ctx.progress()` after each successful poll or sub-call; `ctx.pending(wait)` for "not yet" (CI, capacity).
 * 5. A paid step wraps its model turn or worker start in `ctx.paid(() => ...)` and reports a worker the driver
 *    confirmed dead with `ctx.paidLost(detail)`; only those faults count toward the bound. An answer it
 *    refuses is recorded with `ctx.invalid(detail)`; the next ask reads `ctx.previousInvalid()`.
 * 6. Never rotate the attempt inside a step. Records are keyed by item, so rotation alone never resets the
 *    paid bound; work and defect end the step and reset it (repair allowances bound those).
 * 7. `step` returns only on success. On a throw, first `StepPaused` (pause, drain or handoff blocked a
 *    new try or paid call): stop quietly; the record stays and the next run resumes the step.
 *    Otherwise branch on `faultOf(error).kind`: `cancelled` stop quietly; `work` fail the attempt, then
 *    repair or retry; `decision` / `config` leave the scope waiting (the wait is saved; `factory retry`
 *    answers it); `defect` stop and report. Transient faults never leave `step`.
 * 8. Pass the run's cancel signal as `signal` and its pause signal as `pause` on every call. The old
 *    repeat loops (repeatInterrupted, retryTransient) are gone; diagnostics spans go inside the body.
 */
/*
 * Worked examples (sketches):
 *
 * execute: a session is attempt + seq, saved before its start. A dead session ends that seq; the next try
 * starts seq + 1 (inside the step: the attempt does not rotate). find() skips ended sessions.
 *   await step(state, { scope: { item: id }, name: "execute", paid: true }, async (ctx) => {
 *     work.session ??= { attempt: work.attempt, seq: 1 }; save();
 *     const session = (await driver.find(work.session)) ?? (await ctx.paid(() => driver.start(input, work.session)));
 *     const seen = await driver.poll(session);
 *     ctx.progress();
 *     if (seen.dead) {                                     // driver confirmed it stopped
 *       work.session = { ...work.session, seq: work.session.seq + 1 }; save();
 *       ctx.paidLost(`worker ${session.id} ended without a result`);   // counts toward the bound
 *     }
 *     if (!seen.done) ctx.pending(undefined, seen.nextPollAt);         // running: poll, no wait
 *     return ctx.paid(() => driver.collect(session));
 *   }, opts);
 *
 * merge: observe, merge, confirm; CI is pending, not a fault.
 *   await step(state, { scope: { item: id }, name: "merge" }, async (ctx) => {
 *     const pr = await github.pullRequest(n);
 *     ctx.progress();
 *     if (pr.merged) return confirm(pr);
 *     if (pr.mergeState === "DIRTY") throw new StepFault({ kind: "work", evidence: { detail: "conflict" } });
 *     if (!pr.requiredChecksPassed) ctx.pending({ kind: "ci", detail: `PR #${n} checks` });
 *     await github.merge(n, { expectedHead: pr.head });
 *     return confirm(await github.pullRequest(n));
 *   }, opts);
 *
 * project: several idempotent creates, saving each identity.
 *   await step(state, { scope: "objective", name: "project" }, async (ctx) => {
 *     const existing = await github.issuesByMarker(objective);
 *     ctx.progress();
 *     for (const item of missing(existing)) {
 *       state.issueByItemId[item.id] = await github.createIssue(item);
 *       save();
 *       ctx.progress();
 *     }
 *   }, opts);
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import * as time from "./clock.js";
import {
  attachedFault,
  decision,
  transient,
  type Fault,
  faultDetail,
  faultOf,
  parseRepeatKey,
  type RepeatRecord,
  StepFault,
  type Wait,
} from "./fault.js";
import type { FactoryState, PreparationState } from "./state.js";

/** Snapshots that hold repeat records: Objective steps run in both. */
export type StepState = FactoryState | PreparationState;

/** Whose step this is: a Work Item (across attempts) or the Objective. */
export type StepScope = { item: string } | "objective";

/** Observational only: never persisted or consulted by repeat/recovery. */
export interface StepAttemptObservation {
  operationAttemptId: string;
  parentOperationAttemptId?: string;
  scope: string;
  phase: string;
  runId?: string;
  itemId?: string;
  attemptId?: string;
  outcome: "started" | "completed" | "pending-poll" | "failed" | "paused";
  terminal: boolean;
  faultClass?: string;
  detail?: string;
}

const observationScope = new AsyncLocalStorage<{
  observe: (event: StepAttemptObservation) => void;
  parentOperationAttemptId?: string;
}>();

// Nested provider retries are new effects inside the same step, not new
// steps or paid fault allowances. Carry the owner's existing admission and
// cancellation controls without interrupting a running call on pause.
const admissionScope = new AsyncLocalStorage<{
  check: () => void;
  signal?: AbortSignal;
  deadlineAt: () => string | undefined;
}>();

export function assertStepAdmission(): void {
  admissionScope.getStore()?.check();
}

export function stepCancellationSignal(): AbortSignal | undefined {
  return admissionScope.getStore()?.signal;
}

/** The existing authoritative Objective ceiling, including preparation and fresh-only adapters. */
export function stepDeadlineAt(): string | undefined {
  return admissionScope.getStore()?.deadlineAt();
}

export function withStepObserver<T>(
  observe: (event: StepAttemptObservation) => void,
  task: () => T,
): T {
  return observationScope.run({ observe }, task);
}

export function currentObservedOperationAttemptId(): string | undefined {
  return observationScope.getStore()?.parentOperationAttemptId;
}

export function withObservedOperation<T>(id: string, task: () => T): T {
  const inherited = observationScope.getStore();
  return inherited
    ? observationScope.run({ ...inherited, parentOperationAttemptId: id }, task)
    : task();
}

function observeAttempt(event: StepAttemptObservation): void {
  try {
    observationScope.getStore()?.observe(event);
  } catch {
    // Observer failure must never affect operational continuation.
  }
}

export interface StepSpec {
  scope: StepScope;
  /** Kebab-case step name, such as `publish` or `plan`. */
  name: string;
  /** A model turn or worker run: bounded instead of repeated forever. */
  paid?: boolean;
}

/** A "not yet" a step can report; it never counts as a fault. */
export interface PendingWait {
  kind: "ci" | "capacity" | "dependency" | "prerequisite";
  detail: string;
}

export interface StepContext {
  /** A call inside the step succeeded: any run of faults is over. */
  progress(): void;
  /** Run the paid call of a paid step; only its faults count toward the bound. */
  paid<T>(call: () => Promise<T>): Promise<T>;
  /**
   * Not yet: end this try, show `wait` (none for healthy running work), and
   * run the body again at `retryAt` (default `PENDING_POLL_MS`). The wait
   * shows the last known state: faults keep it, `progress()` clears it.
   * Never catch what it throws.
   */
  pending(wait: PendingWait | undefined, retryAt?: string): never;
  /**
   * A paid step's effect was lost after it started (a dead worker the
   * driver confirmed stopped): counts toward the paid bound and repeats.
   */
  paidLost(detail: string): never;
  /**
   * Why the last answer of this paid step was invalid, if it was. Saved in
   * the step's record, so the ask after a restart still carries it; the
   * record ends with the step.
   */
  previousInvalid(): string | undefined;
  /** Record why an answer was invalid; the next ask carries it. */
  invalid(detail: string): void;
}

/** Time for backoff. Tests inject one so nothing waits in real time. */
export interface StepClock {
  now(): number;
  sleep(milliseconds: number, signal?: AbortSignal): Promise<void>;
}

export interface StepOptions {
  /** Persist the snapshot; called after every change to records or waits. */
  save: () => void;
  /** Cancel: ends a backoff or try with a `cancelled` fault. */
  signal?: AbortSignal;
  /**
   * Pause, drain or handoff: blocks a new try or paid call with `StepPaused`
   * (not a fault). Nothing is charged or failed; the record stays, so the
   * next run resumes the step where it waited. A running try is not cut off.
   */
  pause?: AbortSignal;
  clock?: StepClock;
}

/**
 * The owner paused (or is draining or handing off) before a new try or paid
 * call. Not a fault: the caller stops quietly and leaves the scope
 * as it is.
 */
export class StepPaused extends Error {
  constructor(readonly step: string) {
    super(`Step ${step} paused`);
    this.name = "StepPaused";
  }
}

export const FIRST_BACKOFF_MS = 1_000;
export const MAX_BACKOFF_MS = 5 * 60_000;
export const PENDING_POLL_MS = 30_000;
/** Status reports an outage once a run of faults will have lasted this long. */
export const OUTAGE_AFTER_MS = 60_000;
/** After this much running time a run of faults offers the operator cancel. */
export const ESCALATE_AFTER_MS = 24 * 60 * 60_000;
/** Paid faults a paid step repeats; the next one is a decision. */
export const PAID_FAULT_LIMIT = 3;

const systemClock: StepClock = { now: time.now, sleep: time.sleep };

/** Delay before the `count`th repeat: 1 s doubling to a 5-minute cap. */
export function backoffDelay(count: number): number {
  return Math.min(
    FIRST_BACKOFF_MS * 2 ** Math.max(0, count - 1),
    MAX_BACKOFF_MS,
  );
}

/** The `state.repeats` key of a step: `item/<id>/<name>` or `objective/<name>`. */
export function repeatKey(scope: StepScope, name: string): string {
  const key =
    scope === "objective" ? `objective/${name}` : `item/${scope.item}/${name}`;
  if (!parseRepeatKey(key)) throw new Error(`Invalid step ${key}`);
  return key;
}

function inScope(key: string, scope: StepScope): boolean {
  const parsed = parseRepeatKey(key);
  return (
    !!parsed &&
    (scope === "objective"
      ? parsed.item === undefined
      : parsed.item === scope.item)
  );
}

function waitHolder(state: StepState, scope: StepScope): { wait?: Wait } {
  if (scope === "objective") return state;
  const work = "work" in state ? state.work[scope.item] : undefined;
  if (!work) throw new Error(`Work Item ${scope.item} has no state`);
  return work;
}

export function waitOf(state: StepState, scope: StepScope): Wait | undefined {
  return waitHolder(state, scope).wait;
}

/** A step's wait that only the operator clears: a decision or a config fix. */
export function awaitsOperator(wait: Wait | undefined): boolean {
  return (
    !!wait?.step &&
    (wait.kind === "decision" || (wait.kind === "prerequisite" && !!wait.fix))
  );
}

/**
 * Set a caller's wait (CI, capacity, ...). Refused (false) while a step's
 * decision or config fix is unanswered. The caller saves.
 */
export function setWait(
  state: StepState,
  scope: StepScope,
  wait: { kind: Wait["kind"]; detail: string },
): boolean {
  const holder = waitHolder(state, scope);
  if (awaitsOperator(holder.wait)) return false;
  holder.wait = { kind: wait.kind, detail: wait.detail };
  return true;
}

/** Clear a caller's wait; a step's own wait is the step's to clear. */
export function clearWait(state: StepState, scope: StepScope): boolean {
  const holder = waitHolder(state, scope);
  if (!holder.wait || holder.wait.step) return false;
  delete holder.wait;
  return true;
}

/**
 * The operator's retry: delete every repeat record of the scope (an item
 * runs one step at a time, so that is the waiting step) and the wait its
 * steps wrote, so the steps start fresh. A decision blocks only the step
 * that asked it. Returns whether anything was cleared; the caller saves.
 */
export function clearRepeats(state: StepState, scope: StepScope): boolean {
  let cleared = false;
  const holder = waitHolder(state, scope);
  if (holder.wait?.step && inScope(holder.wait.step, scope)) {
    delete holder.wait;
    cleared = true;
  }
  const repeats = state.repeats;
  if (!repeats) return cleared;
  for (const key of Object.keys(repeats))
    if (inScope(key, scope)) {
      delete repeats[key];
      cleared = true;
    }
  if (!Object.keys(repeats).length) delete state.repeats;
  return cleared;
}

/**
 * Cancellation completed: no step resumes, so every repeat record and every
 * step-owned wait goes. The caller saves.
 */
export function clearAllRepeats(state: StepState): void {
  clearRepeats(state, "objective");
  if ("work" in state)
    for (const item of Object.keys(state.work)) clearRepeats(state, { item });
  delete state.repeats;
}

/** A step of the scope in a run of transient faults, for status. */
export interface Outage {
  step: string;
  since: string;
  tries: number;
  last: Fault;
  /** The run has lasted 24 hours of running time. */
  escalated: boolean;
}

/**
 * The scope's oldest run of faults that will have lasted a minute by its
 * next try (so a distant `retryAt` shows at once), else undefined.
 */
export function outageOf(
  state: StepState,
  scope: StepScope,
  now = time.now(),
): Outage | undefined {
  let found: Outage | undefined;
  for (const [key, record] of Object.entries(state.repeats ?? {})) {
    const faults = record.faults;
    if (!faults || !inScope(key, scope)) continue;
    const since = Date.parse(faults.since);
    const nextTry = Math.max(now, Date.parse(record.nextAt ?? faults.since));
    if (nextTry - since < OUTAGE_AFTER_MS) continue;
    if (!found || since < Date.parse(found.since))
      found = {
        step: parseRepeatKey(key)!.step,
        since: faults.since,
        tries: faults.count,
        last: faults.last,
        escalated: faults.activeMs >= ESCALATE_AFTER_MS,
      };
  }
  return found;
}

const iso = (time: number) => new Date(time).toISOString();

const paidBound = (name: string, paid: number) =>
  `${name} failed ${paid} times with an unknown outcome; retry or cancel?`;

/** The body's "not yet", caught by `step`; never a fault. */
class StepPending extends Error {
  constructor(
    readonly wait: PendingWait | undefined,
    readonly retryAt: string | undefined,
  ) {
    super(`pending: ${wait?.detail ?? "running"}`);
    this.name = "StepPending";
  }
}

/** Steps running now, per snapshot: one key never runs twice at once. */
const running = new WeakMap<object, Set<string>>();

/**
 * Run one repeatable effect. Transient faults repeat with a persisted
 * backoff; a restart resumes from the saved record. See the top of this file.
 */
export async function step<T>(
  state: StepState,
  spec: StepSpec,
  fn: (context: StepContext) => Promise<T>,
  options: StepOptions,
): Promise<T> {
  const key = repeatKey(spec.scope, spec.name);
  const holder = waitHolder(state, spec.scope);
  const active = running.get(state) ?? new Set<string>();
  if (active.has(key)) throw new Error(`Step ${key} is already running`);
  active.add(key);
  running.set(state, active);
  try {
    return await repeat(state, spec, key, holder, fn, options);
  } finally {
    active.delete(key);
  }
}

async function repeat<T>(
  state: StepState,
  spec: StepSpec,
  key: string,
  holder: { wait?: Wait },
  fn: (context: StepContext) => Promise<T>,
  { save, signal, pause, clock = systemClock }: StepOptions,
): Promise<T> {
  const { name } = spec;
  const record = (): RepeatRecord => state.repeats?.[key] ?? {};
  /** Replace the record; fields set to undefined are dropped, an empty record deleted. */
  const write = (next: RepeatRecord) => {
    const kept = Object.fromEntries(
      Object.entries(next).filter(([, value]) => value !== undefined),
    );
    if (Object.keys(kept).length) {
      state.repeats ??= {};
      state.repeats[key] = kept;
    } else if (state.repeats) {
      delete state.repeats[key];
      if (!Object.keys(state.repeats).length) delete state.repeats;
    }
  };
  const owned = () => holder.wait?.step === key;
  /**
   * Write this step's wait, or clear it. Never replaces another step's
   * unanswered wait: status then shows the first question, and this step's
   * own question shows after `factory retry` answers the first.
   */
  const own = (wait?: Omit<Wait, "step">) => {
    if (!wait) {
      if (owned()) delete holder.wait;
    } else if (owned() || !awaitsOperator(holder.wait))
      holder.wait = { ...wait, step: key };
  };
  const cancelled = (): StepFault =>
    new StepFault(
      {
        kind: "cancelled",
        detail:
          (signal?.reason instanceof Error && signal.reason.message) ||
          "cancelled",
      },
      { cause: signal?.reason },
    );

  // A paid call cut off by a crash counts as one paid fault.
  const entry = record();
  if (entry.inFlight) {
    const operationAttemptId = randomUUID();
    const context = {
      operationAttemptId,
      parentOperationAttemptId:
        observationScope.getStore()?.parentOperationAttemptId,
      scope: key,
      phase: name,
      runId: state.runId,
      ...(spec.scope === "objective" ? {} : { itemId: spec.scope.item }),
    };
    observeAttempt({ ...context, outcome: "started", terminal: false });
    observeAttempt({
      ...context,
      outcome: "failed",
      terminal: true,
      faultClass: "interrupted-paid-call",
      detail: "A previously submitted paid call has no recorded settlement",
    });
    write({ ...entry, inFlight: undefined, paid: (entry.paid ?? 0) + 1 });
    save();
  }
  // The next run retries after a config fix.
  if (owned() && holder.wait!.kind === "prerequisite" && holder.wait!.fix) {
    own();
    save();
  }
  // An unanswered decision (asked, or the paid bound) holds until
  // `factory retry` clears the record; the body is not called.
  const paidSoFar = record().paid ?? 0;
  const asked =
    record().asked ??
    (paidSoFar > PAID_FAULT_LIMIT ? paidBound(name, paidSoFar) : undefined);
  if (asked) {
    if (!owned() || holder.wait!.detail !== asked) {
      own({ kind: "decision", detail: asked });
      save();
    }
    throw new StepFault(decision(asked));
  }

  // Either signal ends a wait: cancel with a fault, pause without one.
  const waitSignal =
    signal && pause ? AbortSignal.any([signal, pause]) : (signal ?? pause);
  const stopWaiting = (): void => {
    if (signal?.aborted) throw cancelled();
    if (pause?.aborted) throw new StepPaused(key);
  };

  // Running time of the current run of faults; downtime is never counted.
  let activeFrom = clock.now();
  for (;;) {
    stopWaiting();
    const next = record();
    if (next.nextAt && next.scheduledAt) {
      // Never longer than the delay chosen when it was scheduled, so a
      // clock that jumps backwards cannot stall the step.
      const chosen = Date.parse(next.nextAt) - Date.parse(next.scheduledAt);
      const delay = Math.min(Date.parse(next.nextAt) - clock.now(), chosen);
      if (delay > 0) {
        // A wait between tries is a safe point: pause stops here.
        stopWaiting();
        await clock.sleep(delay, waitSignal).catch((error: unknown) => {
          stopWaiting();
          throw error;
        });
      }
      stopWaiting();
    }

    const operationAttemptId = randomUUID();
    const observation = {
      operationAttemptId,
      parentOperationAttemptId:
        observationScope.getStore()?.parentOperationAttemptId,
      scope: key,
      phase: name,
      runId: state.runId,
      ...(spec.scope === "objective"
        ? {}
        : {
            itemId: spec.scope.item,
            attemptId:
              "work" in state
                ? state.work[spec.scope.item]?.attempt
                : undefined,
          }),
    };
    observeAttempt({ ...observation, outcome: "started", terminal: false });
    let done = false;
    const paidFaults = new WeakSet<Fault>();
    /** The service answered: the run of faults is over; the paid count stays. */
    const endFaults = () =>
      write({
        ...record(),
        faults: undefined,
        nextAt: undefined,
        scheduledAt: undefined,
      });
    const progress = () => {
      if (done) return;
      // A successful observation replaces the last known "not yet".
      const stale = owned() && !awaitsOperator(holder.wait);
      if (!record().faults && !stale) return;
      endFaults();
      if (stale) own();
      save();
    };
    const paid = async <R>(call: () => Promise<R>): Promise<R> => {
      stopWaiting();
      if (!spec.paid)
        throw new Error(`Step ${name} is not paid but made a paid call`);
      // One paid call at a time, so one marker settles exactly one call.
      if (record().inFlight)
        throw new Error(`Step ${name} made a paid call while one is running`);
      write({ ...record(), inFlight: true });
      save();
      let result: R;
      try {
        result = await call();
      } catch (error) {
        write({ ...record(), inFlight: undefined });
        save();
        const fault = attachedFault(error);
        if (fault) paidFaults.add(fault);
        throw error;
      }
      write({ ...record(), inFlight: undefined });
      save();
      progress();
      return result;
    };
    const pending = (
      wait: PendingWait | undefined,
      retryAt?: string,
    ): never => {
      throw new StepPending(wait, retryAt);
    };
    const paidLost = (detail: string): never => {
      if (!spec.paid)
        throw new Error(`Step ${name} is not paid but lost a paid effect`);
      const lost = new StepFault(transient(detail, true));
      observeAttempt({
        ...observation,
        outcome: "failed",
        terminal: false,
        faultClass: "lost-worker",
        detail,
      });
      paidFaults.add(lost.fault);
      throw lost;
    };

    const previousInvalid = () => record().invalid;
    const invalid = (detail: string) => {
      if (!spec.paid)
        throw new Error(`Step ${name} is not paid but had an invalid answer`);
      observeAttempt({
        ...observation,
        outcome: "failed",
        terminal: false,
        faultClass: "invalid-answer",
        detail,
      });
      write({ ...record(), invalid: detail });
      save();
    };

    try {
      const invoke = () =>
        admissionScope.run(
          {
            check: stopWaiting,
            signal,
            deadlineAt: () => state.coordinator?.deadlineAt,
          },
          () =>
            fn({
              progress,
              paid,
              pending,
              paidLost,
              previousInvalid,
              invalid,
            }),
        );
      const inherited = observationScope.getStore();
      const result = await (inherited
        ? observationScope.run(
            { ...inherited, parentOperationAttemptId: operationAttemptId },
            invoke,
          )
        : invoke());
      done = true;
      if (state.repeats?.[key] || owned()) {
        write({});
        own();
        save();
      }
      observeAttempt({ ...observation, outcome: "completed", terminal: true });
      return result;
    } catch (error) {
      done = true;
      observeAttempt({
        ...observation,
        outcome:
          error instanceof StepPending
            ? "pending-poll"
            : error instanceof StepPaused ||
                ["decision", "config", "cancelled"].includes(
                  faultOf(error).kind,
                )
              ? "paused"
              : "failed",
        terminal: true,
        ...(error instanceof StepPending || error instanceof StepPaused
          ? {}
          : {
              faultClass: faultOf(error).kind,
              detail: error instanceof Error ? error.message : String(error),
            }),
      });
      if (error instanceof StepPaused) {
        if (signal?.aborted) throw cancelled();
        throw error;
      }
      if (error instanceof StepPending) {
        const now = clock.now();
        const at = error.retryAt ? Date.parse(error.retryAt) : Number.NaN;
        write({
          ...record(),
          faults: undefined,
          nextAt: iso(at > now ? at : now + PENDING_POLL_MS),
          scheduledAt: iso(now),
        });
        if (error.wait)
          own({ kind: error.wait.kind, detail: error.wait.detail });
        else if (!awaitsOperator(holder.wait)) own();
        save();
        continue;
      }
      if (signal?.aborted) throw cancelled();
      const fault = faultOf(error);
      if (fault.kind === "cancelled") throw error;
      if (fault.kind === "work" || fault.kind === "defect") {
        // The step is over; the caller repairs, retries or reports.
        if (state.repeats?.[key] || owned()) {
          write({});
          own();
          save();
        }
        throw error;
      }
      if (fault.kind === "decision" || fault.kind === "config") {
        endFaults();
        // The record holds the question, so it blocks re-entry even when
        // another step's unanswered wait keeps this one from showing.
        if (fault.kind === "decision")
          write({ ...record(), asked: fault.question });
        own(
          fault.kind === "decision"
            ? { kind: "decision", detail: fault.question }
            : { kind: "prerequisite", detail: fault.detail, fix: fault.fix },
        );
        save();
        throw error;
      }

      const now = clock.now();
      const current = record();
      const run = current.faults;
      const counted =
        spec.paid === true &&
        fault.outcomeUnknown &&
        !fault.retryAt &&
        paidFaults.has(fault);
      const paidCount = (current.paid ?? 0) + (counted ? 1 : 0);
      const count = (run?.count ?? 0) + 1;
      const retryAt = fault.retryAt ? Date.parse(fault.retryAt) : Number.NaN;
      write({
        ...current,
        nextAt: iso(retryAt > now ? retryAt : now + backoffDelay(count)),
        scheduledAt: iso(now),
        faults: {
          since: run?.since ?? iso(now),
          count,
          last: fault,
          activeMs: run ? run.activeMs + (now - activeFrom) : 0,
        },
        paid: paidCount || undefined,
      });
      activeFrom = now;
      if (paidCount > PAID_FAULT_LIMIT) {
        const question = paidBound(name, paidCount);
        own({ kind: "decision", detail: question });
        save();
        throw new StepFault(decision(question, faultDetail(fault)), {
          cause: error,
        });
      }
      save();
    }
  }
}
