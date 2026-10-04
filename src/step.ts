/**
 * Converting a call site to `step` (recovery v2.2, #515):
 * 1. Wrap one repeatable effect: `await step(state, { scope, name, paid }, async (ctx) => ..., { save, signal, clock })`
 *    with scope `{ item: id }` or `"objective"` and a kebab-case name (`publish`, `merge`, `plan`).
 * 2. The body is correct when repeated from the top: observe first, create idempotently, confirm.
 * 3. The body classifies its own checks: a bad result throws `work`, a foreign change `decision`, lag or
 *    "not visible yet" a `transient` StepFault. Anything unclassified is a `defect`.
 * 4. `ctx.progress()` after each successful poll or sub-call; `ctx.pending(wait)` for "not yet" (CI, capacity).
 * 5. A paid step wraps its model turn or worker run in `ctx.paid(() => ...)`; only those faults count.
 * 6. Never rotate the attempt inside a step. Records are keyed by item, so rotation cannot reset the bound.
 * 7. `step` returns only on success. On a throw, branch on `faultOf(error).kind`: `cancelled` stop quietly;
 *    `work` fail the attempt, then repair or retry; `decision` / `config` leave the scope waiting (the wait
 *    is saved; `factory retry` answers it); `defect` stop and report. Transient faults never leave `step`.
 * 8. Delete the site's old repeat loop (repeatInterrupted, retryTransient, ...); spans go inside the body.
 */
/*
 * Worked examples (sketches):
 *
 * execute: paid start and collect, progress per poll.
 *   await step(state, { scope: { item: id }, name: "execute", paid: true }, async (ctx) => {
 *     const session = (await driver.find(work.attempt)) ?? (await ctx.paid(() => driver.start(input)));
 *     const seen = await driver.poll(session);
 *     ctx.progress();
 *     if (!seen.done) ctx.pending({ kind: "capacity", detail: "worker running" }, seen.nextPollAt);
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
import { setTimeout as sleep } from "node:timers/promises";
import {
  attachedFault,
  decision,
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
   * Not yet: end this try, show `wait`, and run the body again at `retryAt`
   * (default `PENDING_POLL_MS`, at most `MAX_BACKOFF_MS`). Never catch it.
   */
  pending(wait: PendingWait, retryAt?: string): never;
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
  clock?: StepClock;
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

const MAX_TIMER_MS = 2_147_483_647;
const systemClock: StepClock = {
  now: () => Date.now(),
  sleep: (milliseconds, signal) =>
    sleep(
      Math.min(milliseconds, MAX_TIMER_MS),
      undefined,
      signal ? { signal } : undefined,
    ),
};

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
 * The operator's retry: delete the scope's repeat records and the wait its
 * steps wrote, so the steps start fresh. Returns whether anything was
 * cleared; the caller saves.
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
  now = Date.now(),
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
    readonly wait: PendingWait,
    readonly retryAt: string | undefined,
  ) {
    super(`pending: ${wait.detail}`);
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
  { save, signal, clock = systemClock }: StepOptions,
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
  /** Write this step's wait, or clear it. Never replaces another step's unanswered wait. */
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
    write({ ...entry, inFlight: undefined, paid: (entry.paid ?? 0) + 1 });
    save();
  }
  // The next run retries after a config fix.
  if (owned() && holder.wait!.kind === "prerequisite" && holder.wait!.fix) {
    own();
    save();
  }
  // A decision waits for the operator's answer, which clears it.
  const paidSoFar = record().paid ?? 0;
  if (paidSoFar > PAID_FAULT_LIMIT) {
    if (!owned()) {
      own({ kind: "decision", detail: paidBound(name, paidSoFar) });
      save();
    }
    throw new StepFault(decision(paidBound(name, paidSoFar)));
  }
  if (owned() && holder.wait!.kind === "decision")
    throw new StepFault(decision(holder.wait!.detail));

  // Running time of the current run of faults; downtime is never counted.
  let activeFrom = clock.now();
  for (;;) {
    if (signal?.aborted) throw cancelled();
    const next = record();
    if (next.nextAt) {
      const now = clock.now();
      const last = next.faults?.last;
      const retryAt =
        last?.kind === "transient" && last.retryAt
          ? Date.parse(last.retryAt)
          : 0;
      // Never longer than the delay the step chose, so a clock that jumps
      // backwards cannot stall it.
      const longest = next.faults
        ? Math.max(backoffDelay(next.faults.count), retryAt - now)
        : MAX_BACKOFF_MS;
      const delay = Math.min(Date.parse(next.nextAt) - now, longest);
      if (delay > 0)
        await clock.sleep(delay, signal).catch((error: unknown) => {
          throw signal?.aborted ? cancelled() : error;
        });
      if (signal?.aborted) throw cancelled();
    }

    let done = false;
    const paidFaults = new WeakSet<Fault>();
    /** The service answered: the run of faults is over; the paid count stays. */
    const endFaults = () =>
      write({ ...record(), faults: undefined, nextAt: undefined });
    const progress = () => {
      if (done || !record().faults) return;
      endFaults();
      save();
    };
    const paid = async <R>(call: () => Promise<R>): Promise<R> => {
      if (!spec.paid)
        throw new Error(`Step ${name} is not paid but made a paid call`);
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
    const pending = (wait: PendingWait, retryAt?: string): never => {
      throw new StepPending(wait, retryAt);
    };

    try {
      const result = await fn({ progress, paid, pending });
      done = true;
      if (state.repeats?.[key] || owned()) {
        write({});
        own();
        save();
      }
      return result;
    } catch (error) {
      done = true;
      if (error instanceof StepPending) {
        const now = clock.now();
        const at = error.retryAt ? Date.parse(error.retryAt) : Number.NaN;
        write({
          ...record(),
          faults: undefined,
          nextAt: iso(at > now ? at : now + PENDING_POLL_MS),
        });
        own({ kind: error.wait.kind, detail: error.wait.detail });
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
