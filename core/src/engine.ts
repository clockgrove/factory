import { isDeepStrictEqual } from "node:util";
import { crashPoint } from "./crash.js";
import type { RunLog } from "./log.js";
import type { ProviderConfig } from "./providers/config.js";
import {
  type Answer,
  type Hold,
  type ObjectiveState,
  type ObjectiveStatus,
  type Retry,
  saveState,
  TERMINAL,
  type Wait,
} from "./state.js";
import { errorMessage } from "./text.js";

/** What a step reports. Every step ends in exactly one of these. */
export type Outcome =
  | {
      kind: "done";
      result?: unknown;
      /** Facts that outlive repairs, such as the heads already pushed (`state.kept`). */
      keep?: Record<string, unknown>;
    }
  /**
   * Try again. `afterMs: -1` is an error (an escaped exception, a missed
   * deadline, an idle model or an invalid answer): three in a row hold.
   * An attempt the service's death interrupted is never an outcome: it
   * runs again (see `ObjectiveRunner.tick`).
   * Anything else is a wait, classed by `wait` (CORE.md#Waits).
   */
  | {
      kind: "retry";
      reason: string;
      afterMs?: number;
      wait?: Wait;
      keep?: Record<string, unknown>;
    }
  | {
      kind: "hold";
      question: string;
      answers: string[];
      recommended: string;
      /** What the question stops; absent: `item` (see `HoldScope`). */
      scope?: HoldScope;
      keep?: Record<string, unknown>;
    }
  /** The step can't succeed as planned. */
  | { kind: "fail"; reason: string }
  /**
   * The work is wrong (validation, review or CI refused it): clear `clear`
   * from the finished steps and run `target` again with the finding, within
   * the repair budget.
   */
  | {
      kind: "repair";
      finding: string;
      target: string;
      clear: string[];
      keep?: Record<string, unknown>;
    };

/**
 * What a question stops (CORE.md#Holds and answers). `item`: a Work Item
 * step's question stops that item and the items that depend on it; any
 * other step's stops the Objective. `objective`: the cause is the whole
 * Objective's (its issue, the repository, the host, a provider account),
 * so it stops every step, and is asked once.
 */
export type HoldScope = "item" | "objective";

/**
 * Providers `switch` can move to: every other configured one, and the
 * current one when its configured settings changed since they were frozen
 * (a model fixed in the configuration, then the service restarted). The
 * one rule for what a hold offers and what the engine accepts.
 */
export function switchTargets(
  current: ObjectiveState["provider"],
  providers: Readonly<Record<string, ProviderConfig>> | undefined,
): string[] {
  return Object.entries(providers ?? {})
    .filter(
      ([name, settings]) =>
        name !== current?.name ||
        !isDeepStrictEqual(settings, current.settings),
    )
    .map(([name]) => name);
}

/** A question for the operator; the first answer is recommended unless another is named. */
export function hold(
  question: string,
  answers = ["retry", "cancel"],
  recommended = answers[0]!,
): Extract<Outcome, { kind: "hold" }> {
  return { kind: "hold", question, answers, recommended };
}

/** The outcome, with a question in it made the whole Objective's (see `HoldScope`). */
export function objectiveWide<T extends Outcome>(outcome: T): T {
  return outcome.kind === "hold" ? { ...outcome, scope: "objective" } : outcome;
}

/** The Work Item a step belongs to: item steps are keyed `item:<id>:<phase>`. */
export function itemOf(key: string): string | undefined {
  return /^item:([^:]+):/.exec(key)?.[1];
}

export interface StepContext {
  /** A copy: steps read state, the engine writes it. */
  readonly state: ObjectiveState;
  /** The answer to this step's last hold, until the step finishes. */
  readonly answer?: Answer;
  readonly signal: AbortSignal;
  log(event: Record<string, unknown>): void;
}

export interface Step {
  /** Stable for the Objective, such as `plan` or `item:a:work`. */
  readonly key: string;
  readonly deadlineMs: number;
  /** A host-wide limit this step counts against: model-bound workers or CPU-heavy validation. */
  readonly resource?: HostResource;
  run(context: StepContext): Promise<Outcome>;
}

/** What to do next. Both functions are pure functions of the state. */
export interface Workflow {
  steps(state: ObjectiveState): Step[];
  /** The status of a state that isn't holding or terminal. */
  status(state: ObjectiveState): ObjectiveStatus;
  /**
   * The named providers configured, with their settings as an Objective
   * freezes them, for the `switch NAME` answer to a usage limit.
   */
  readonly providers?: Readonly<Record<string, ProviderConfig>>;
  /**
   * The Work Items whose questions also stop `item` although it can run
   * before they settle: the native-stack layers below it. (A dependency's
   * dependents aren't runnable until it merges, so they wait anyway.)
   */
  upstream?(state: ObjectiveState, item: string): readonly string[];
}

export type HostResource = "worker" | "cpu";

/** This run of the service, shared by its Objectives' runners. */
export interface ServiceRun {
  /** Saved on each attempt this run starts, so a restart knows what was running when it died. */
  readonly id: string;
  /** Step attempts that finished in this run (any outcome). */
  finished: number;
  /** Interrupted attempts wait until then (a crash loop, see `serve`); 0 when they resume at once. */
  resumeAt: number;
}

/**
 * Host-wide caps shared by every Objective in the service: how many worker
 * runs and how many CPU-heavy steps (validation) run at once.
 */
export class HostLimiter {
  private readonly used: Record<HostResource, number> = { worker: 0, cpu: 0 };
  constructor(private caps: Record<HostResource, number>) {}

  configure(caps: Record<HostResource, number>): void {
    this.caps = caps;
  }

  acquire(resource: HostResource): boolean {
    if (this.used[resource] >= this.caps[resource]) return false;
    this.used[resource] += 1;
    return true;
  }

  release(resource: HostResource): void {
    this.used[resource] = Math.max(0, this.used[resource] - 1);
  }

  usage(): Record<HostResource, number> {
    return { ...this.used };
  }
}

/** The service's limiter; `serve` sets its caps from configuration. */
export const hostLimits = new HostLimiter({ worker: 2, cpu: 2 });

export interface EngineLimits {
  /** Escaped errors and missed deadlines in a row before a step holds. */
  maxErrors: number;
  /** Repairs of one target before Factory asks. */
  maxRepairs: number;
  /**
   * How long an unknown transient cause is retried before Factory asks, and
   * the longest reset a limit is waited for without asking.
   */
  maxWaitMs: number;
  /** When a transient wait gets a status note on the issue. */
  noteAfterMs: number;
  /** When a human gate gets a reminder comment; how long `wait` lasts on a limit with no reset time. */
  remindAfterMs: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
  /** Steps running at once for one Objective. */
  concurrency: number;
  /** A cap on every step's deadline (tests shorten it). */
  maxDeadlineMs?: number;
}

const HOUR = 60 * 60 * 1000;

export const DEFAULT_LIMITS: EngineLimits = {
  maxErrors: 3,
  maxRepairs: 6,
  maxWaitMs: 3 * HOUR,
  noteAfterMs: HOUR,
  remindAfterMs: 24 * HOUR,
  baseBackoffMs: 30_000,
  maxBackoffMs: 15 * 60 * 1000,
  concurrency: 2,
};

const ERROR_ANSWERS = ["retry", "cancel"];
/** Answers the engine applies itself, for its own wait questions. */
const WAIT = "wait";
const SWITCH = "switch";

interface Running {
  token: number;
  controller: AbortController;
}

/**
 * Runs one Objective's steps. All state changes happen here, synchronously,
 * one at a time, and each is saved before the next begins. A step's start is
 * saved too, with the service run that started it, so a step that never
 * finished (because the process died) runs again after a restart, and the
 * service can tell which steps were running when it died.
 */
export class ObjectiveRunner {
  private readonly running = new Map<string, Running>();
  private nextToken = 1;
  /** Replaced by a new run of the same Objective: it never saves again. */
  private stopped = false;
  /** Effects outside the state, run only once the change is saved. */
  private afterSave: (() => void)[] = [];

  constructor(
    public state: ObjectiveState,
    private readonly workflow: Workflow,
    private readonly dir: string,
    private readonly log: RunLog,
    private readonly run: ServiceRun,
    private readonly limits: EngineLimits = DEFAULT_LIMITS,
    private readonly now: () => Date = () => new Date(),
  ) {}

  get busy(): boolean {
    return this.running.size > 0;
  }

  /**
   * The open question that stops `key`: the Objective's, or one on the
   * step's Work Item or on a native-stack layer below it (`upstream`).
   * An item's dependents aren't runnable until it merges, so they wait
   * with it too.
   */
  heldBy(key: string): Hold | undefined {
    return this.state.holds.find((hold) => this.stops(hold, key));
  }

  /** Whether an open question stops step `key`. */
  private stops(hold: Hold, key: string): boolean {
    if (hold.item === undefined) return true;
    const item = itemOf(key);
    return (
      item !== undefined &&
      (hold.item === item ||
        (this.workflow.upstream?.(this.state, item) ?? []).includes(hold.item))
    );
  }

  /** Whether open questions stop every step it could start: then it takes no slot. */
  get held(): boolean {
    return (
      this.state.holds.length > 0 &&
      this.workflow.steps(this.state).every((step) => this.heldBy(step.key))
    );
  }

  /** Whether this Objective has steps to run: cleanup after cancel counts. */
  get hasWork(): boolean {
    return this.busy || this.workflow.steps(this.state).length > 0;
  }

  /**
   * Run `change` against the state and save it. If anything throws, the
   * in-memory state goes back to what is on disk, so memory never claims
   * what a save didn't keep.
   */
  transact<T>(change: () => T): T {
    if (this.stopped)
      throw new Error(`#${this.state.issue}'s run was replaced`);
    const before = structuredClone(this.state);
    this.afterSave = [];
    try {
      const result = change();
      this.save();
      const effects = this.afterSave;
      this.afterSave = [];
      for (const effect of effects) effect();
      return result;
    } catch (error) {
      this.state = before;
      this.afterSave = [];
      throw error;
    }
  }

  /**
   * Start every runnable step that isn't running or waiting to retry.
   *
   * An attempt saved as started but not running here was interrupted: by
   * the service's death, or by a save that failed after the step finished.
   * That is never the step's error: it runs again at once, with no backoff,
   * even while a question that stops it is open, unless the service is in a
   * crash loop (`ServiceRun.resumeAt`). An interrupted attempt of a step
   * that is no longer next is dropped. Any other step waits while a
   * question that stops it is open (`heldBy`).
   */
  tick(): void {
    const steps = this.workflow.steps(this.state);
    const stale = Object.keys(this.state.attempts).filter(
      (key) => !this.running.has(key) && !steps.some((s) => s.key === key),
    );
    if (stale.length)
      this.transact(() => {
        for (const key of stale) delete this.state.attempts[key];
      });
    const now = this.now().getTime();
    for (const step of steps) {
      if (this.running.has(step.key)) continue;
      // A question saved while another stopped the step: ask it now.
      const asking = this.state.retries[step.key]?.asking;
      if (asking && !this.state.attempts[step.key]) {
        if (!this.heldBy(step.key))
          this.transact(() => {
            delete this.state.retries[step.key]?.asking;
            this.hold(
              step.key,
              asking.question,
              asking.answers,
              asking.recommended,
            );
          });
        continue;
      }
      if (this.running.size >= this.limits.concurrency) return;
      if (this.state.attempts[step.key]) {
        if (now < this.run.resumeAt) continue;
      } else if (this.heldBy(step.key)) continue;
      else {
        const retry = this.state.retries[step.key];
        if (retry && Date.parse(retry.nextAt) > now) continue;
      }
      if (step.resource && !hostLimits.acquire(step.resource)) continue;
      try {
        this.start(step);
      } catch (error) {
        if (step.resource) hostLimits.release(step.resource);
        throw error;
      }
    }
  }

  private start(step: Step): void {
    this.transact(() => {
      this.state.attempts[step.key] = {
        startedAt: this.now().toISOString(),
        run: this.run.id,
      };
    });
    crashPoint(`engine:${step.key}:started`);
    const token = this.nextToken++;
    const controller = new AbortController();
    this.running.set(step.key, { token, controller });
    const answer = this.state.answers[step.key];
    const context: StepContext = {
      state: structuredClone(this.state),
      ...(answer ? { answer } : {}),
      signal: controller.signal,
      log: (event) =>
        this.log.write(this.state.issue, { step: step.key, ...event }),
    };
    this.log.write(this.state.issue, { step: step.key, event: "start" });
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<Outcome>((resolve) => {
      timer = setTimeout(
        () => {
          controller.abort(new Error("deadline"));
          resolve({ kind: "retry", reason: "deadline", afterMs: -1 });
        },
        Math.min(step.deadlineMs, this.limits.maxDeadlineMs ?? Infinity),
      );
    });
    const run = (async () => step.run(context))().catch(
      (error: unknown): Outcome =>
        // A full disk needs a person; retrying can't free it.
        (error as NodeJS.ErrnoException | null)?.code === "ENOSPC"
          ? objectiveWide(
              hold(
                `The service host's disk is full (${errorMessage(error)}). Free space, then answer retry; or cancel.`,
              ),
            )
          : {
              kind: "retry",
              reason: `error: ${errorMessage(error)}`,
              afterMs: -1,
            },
    );
    void Promise.race([run, deadline]).then((outcome) => {
      clearTimeout(timer);
      // Released once per start, even when cancel already dropped the step.
      if (step.resource) hostLimits.release(step.resource);
      if (this.running.get(step.key)?.token !== token) return;
      this.running.delete(step.key);
      this.run.finished += 1;
      try {
        this.apply(step.key, outcome);
      } catch (error) {
        // The save failed and the state went back to disk, where the
        // attempt is still open: the next tick runs it again.
        this.log.write(this.state.issue, {
          step: step.key,
          event: "apply-failed",
          error: String(error),
        });
      }
    });
  }

  /**
   * Apply one outcome and save. `afterMs: -1` marks an escaped error or a
   * missed deadline, which counts toward `maxErrors`; other retries are
   * waits (see `retry`). Throws only if the save fails, after putting the
   * state back as it is on disk.
   */
  apply(key: string, outcome: Outcome): void {
    const terminal = TERMINAL.includes(this.state.status);
    if (
      terminal &&
      !this.workflow.steps(this.state).some((s) => s.key === key)
    ) {
      // A step from before cancel: drop its outcome and its open attempt.
      this.log.write(this.state.issue, {
        step: key,
        event: "ignored",
        outcome: outcome.kind,
      });
      if (this.state.attempts[key])
        this.transact(() => {
          delete this.state.attempts[key];
        });
      return;
    }
    crashPoint(`engine:${key}:before-apply`);
    this.transact(() => this.applyChange(key, outcome));
    this.log.write(this.state.issue, {
      step: key,
      event: "outcome",
      outcome: outcome.kind,
      ...("reason" in outcome ? { reason: outcome.reason } : {}),
    });
    crashPoint(`engine:${key}:applied`);
  }

  private applyChange(key: string, outcome: Outcome): void {
    const state = this.state;
    const now = this.now();
    delete state.attempts[key];
    // Saved with the outcome, so a death right after still counts as progress.
    state.finishedRun = this.run.id;
    if ("keep" in outcome && outcome.keep) {
      // null forgets a fact: readers see it as absent, never as null.
      state.kept ??= {};
      for (const [fact, value] of Object.entries(outcome.keep))
        if (value === null) delete state.kept[fact];
        else state.kept[fact] = value;
    }
    if (TERMINAL.includes(state.status) && outcome.kind !== "done") {
      // Cleanup after the end never asks and never blocks: it retries in
      // the background with the usual backoff.
      const previous = state.retries[key];
      const attempts = (previous?.attempts ?? 0) + 1;
      const backoff = Math.min(
        this.limits.baseBackoffMs * 2 ** (attempts - 1),
        this.limits.maxBackoffMs,
      );
      state.retries[key] = {
        count: (previous?.count ?? 0) + 1,
        attempts,
        since: previous?.since ?? now.toISOString(),
        nextAt: new Date(now.getTime() + backoff).toISOString(),
        lastError:
          "reason" in outcome
            ? outcome.reason
            : "question" in outcome
              ? outcome.question
              : outcome.finding,
      };
      return;
    }
    switch (outcome.kind) {
      case "done":
        state.done[key] = outcome.result ?? true;
        delete state.retries[key];
        delete state.answers[key];
        break;
      case "retry":
        this.retry(key, outcome);
        break;
      case "hold":
        this.hold(
          key,
          outcome.question,
          outcome.answers,
          outcome.recommended,
          outcome.scope,
        );
        break;
      case "fail":
        this.hold(
          key,
          `Step ${key} failed: ${outcome.reason}`,
          ERROR_ANSWERS,
          "retry",
        );
        break;
      case "repair": {
        delete state.retries[key];
        for (const cleared of outcome.clear) {
          delete state.done[cleared];
          delete state.answers[cleared];
          delete state.attempts[cleared];
          if (cleared !== outcome.target) delete state.retries[cleared];
        }
        this.abortRunning(outcome.clear);
        // A question about work the repair cleared is moot.
        for (const moot of state.holds.filter((hold) =>
          outcome.clear.includes(hold.step),
        ))
          this.close(moot);
        state.repairs ??= {};
        const repair = state.repairs[outcome.target] ?? {
          count: 0,
          findings: [],
        };
        repair.count += 1;
        repair.findings = [...repair.findings, outcome.finding].slice(-10);
        state.repairs[outcome.target] = repair;
        // Over budget: ask, on the step that would repair. Each `retry` allows one more.
        if (
          repair.count > this.limits.maxRepairs &&
          state.answers[outcome.target]?.answer !== "retry"
        )
          this.hold(
            outcome.target,
            `${outcome.target} has been repaired ${repair.count - 1} times and still fails:\n\n${outcome.finding}\n\n\`retry\` allows one more repair.`,
            ERROR_ANSWERS,
            "retry",
            undefined,
            true,
          );
        break;
      }
    }
    this.settle();
  }

  /**
   * A retry: an error counts toward `maxErrors`; a wait is classed by its
   * cause (CORE.md#Waits). The error count covers one run of consecutive
   * errors: any other outcome ends it. `since`, `cause`, the backoff and a
   * granted `wait` cover one run of one class (a reset, a gate, or an
   * unknown cause, which errors share): a new class starts them again, so
   * a long gate never spends the transient budget. Times are wall-clock
   * times saved in the state, so a restart doesn't reset a budget and a
   * suspended host doesn't spend it twice: the question comes only after
   * the step ran again and still had to wait.
   */
  private retry(
    key: string,
    outcome: Extract<Outcome, { kind: "retry" }>,
  ): void {
    const state = this.state;
    const now = this.now().getTime();
    const wait = outcome.wait;
    const isError = outcome.afterMs === -1;
    const before = state.retries[key];
    // The run of retries this one continues, if it is of the same class.
    const previous =
      before && waitClass(before.wait) === waitClass(wait) ? before : undefined;
    const attempts = (previous?.attempts ?? 0) + 1;
    const since = previous?.since ?? new Date(now).toISOString();
    const count = isError ? (previous?.count ?? 0) + 1 : 0;
    const backoff = Math.min(
      this.limits.baseBackoffMs * 2 ** (attempts - 1),
      this.limits.maxBackoffMs,
    );
    const granted =
      previous?.grantedUntil !== undefined &&
      now < Date.parse(previous.grantedUntil);
    let nextAt =
      outcome.afterMs !== undefined && outcome.afterMs >= 0
        ? now + outcome.afterMs
        : now + backoff;
    let question:
      | { text: string; answers: string[]; scope?: HoldScope }
      | undefined;
    if (isError) {
      if (count >= this.limits.maxErrors)
        question = {
          text: `Step ${key} keeps failing (${outcome.reason}).`,
          answers: ERROR_ANSWERS,
        };
    } else if (wait?.kind === "reset") {
      const at = wait.at ? Date.parse(wait.at) : Number.NaN;
      // A reset already past (clock skew) still backs off: never a hot loop.
      if (Number.isFinite(at)) nextAt = Math.max(at, now + backoff);
      if (!granted && !(at - now <= this.limits.maxWaitMs)) {
        const others = this.otherProviders();
        const named = others.map((name) => `\`${name}\``).join(", ");
        question = {
          text: `${outcome.reason}\n\nThe limit resets ${Number.isFinite(at) ? `at ${new Date(at).toISOString()}` : "at a time it didn't say"}, more than ${hours(this.limits.maxWaitMs)} away. \`${WAIT}\` keeps waiting until it resets${others.length === 1 ? `; \`${SWITCH}\` runs this Objective on provider ${named} instead` : others.length ? `; \`${SWITCH} NAME\` runs this Objective on another configured provider: ${named}` : ""}; or cancel.`,
          answers: [WAIT, ...(others.length ? [SWITCH] : []), "cancel"],
          // A limit is the account's, not the step's: one question for all.
          scope: "objective",
        };
      }
    } else if (
      wait?.kind !== "gate" &&
      !granted &&
      now - Date.parse(since) >= this.limits.maxWaitMs
    )
      // A human gate (an approval, a required review) is never timed out:
      // the display shows it and a reminder follows a day later.
      question = {
        text: `Step ${key} has been retrying since ${since}, for more than ${hours(this.limits.maxWaitMs)}. It began with: ${(previous?.cause ?? outcome.reason).slice(0, 500)}\n\nLast error: ${outcome.reason.slice(0, 500)}\n\n\`${WAIT}\` keeps retrying for another ${hours(this.limits.maxWaitMs)}; \`retry\` tries again now; or cancel.`,
        answers: [WAIT, "retry", "cancel"],
      };
    const record: Retry = {
      count,
      attempts,
      since,
      nextAt: new Date(nextAt).toISOString(),
      lastError: outcome.reason,
      cause: previous?.cause ?? outcome.reason,
      ...(wait ? { wait } : {}),
      ...(granted ? { grantedUntil: previous.grantedUntil } : {}),
    };
    state.retries[key] = record;
    if (question)
      this.hold(
        key,
        question.text,
        question.answers,
        question.answers[0]!,
        question.scope,
      );
  }

  /**
   * The service died while this interrupted step ran, again and again, and
   * other steps finished in between (see `serve`): ask before running it
   * again. Cleanup after the end never asks: the crash loop's delay covers it.
   */
  suspect(key: string, question: string): void {
    if (
      TERMINAL.includes(this.state.status) ||
      this.running.has(key) ||
      !this.state.attempts[key]
    )
      return;
    this.transact(() => {
      delete this.state.attempts[key];
      this.hold(key, question, ERROR_ANSWERS, "retry", undefined, true);
    });
    this.log.write(this.state.issue, { step: key, event: "suspect" });
  }

  /** Stop running steps now; their late outcomes are dropped by the token check in `start`. */
  private abort(keys: readonly string[], reason: string): void {
    const stopped = keys.filter((key) => this.running.has(key));
    for (const key of stopped) {
      this.running.get(key)?.controller.abort(new Error(reason));
      this.running.delete(key);
    }
    if (stopped.length)
      this.log.write(this.state.issue, {
        event: "aborted",
        steps: stopped,
        reason,
      });
  }

  /**
   * Stop the running steps among `keys` once the change is saved, as cancel
   * does: the work they build on was cleared, so their late outcomes would
   * write back stale results.
   */
  private abortRunning(keys: readonly string[]): void {
    this.afterSave.push(() => this.abort(keys, "cleared"));
  }

  /**
   * This run is replaced by a new one for the same Objective (the operator
   * queued a finished Objective again): abort its steps, and never save
   * again, so only the new run writes the Objective's file.
   */
  stop(): void {
    this.stopped = true;
    this.abort([...this.running.keys()], "replaced");
  }

  /**
   * Open a question, on the step's Work Item, or on the Objective (any
   * other step's, or one `scope` makes the Objective's). One question is
   * open per scope. A step that asks while a question covering its scope
   * is open (the Objective's, or its item's) can't run until that one is
   * answered, and then must not wait longer to ask: its retry comes due at
   * once, so it runs again right after the answer and asks then (an
   * Objective-wide cause the answer fixed asks nothing). A question that
   * running the step again wouldn't ask (`saved`: a repair over budget, a
   * crash-loop suspect) is saved on its retry instead, and asked before
   * the step runs (`tick`).
   */
  private hold(
    key: string,
    question: string,
    answers: string[],
    recommended: string,
    scope?: HoldScope,
    saved = false,
  ): void {
    const state = this.state;
    const now = this.now().toISOString();
    const item = scope === "objective" ? undefined : itemOf(key);
    const open = state.holds.find(
      (hold) =>
        hold.item === undefined || (item !== undefined && hold.item === item),
    );
    if (open && open.step !== key) {
      const retry = state.retries[key];
      if (saved)
        state.retries[key] = {
          ...(retry ?? {
            count: 0,
            attempts: 0,
            since: now,
            lastError: question,
          }),
          nextAt: now,
          asking: { question, answers, recommended },
        };
      else if (retry) retry.nextAt = now;
      return;
    }
    const all = answers.includes("cancel") ? answers : [...answers, "cancel"];
    state.holds = [
      ...state.holds.filter((hold) => hold !== open),
      {
        id: `${key}@${now}`,
        step: key,
        ...(item !== undefined ? { item } : {}),
        question,
        answers: all,
        recommended: all.includes(recommended) ? recommended : all[0]!,
        askedAt: now,
      },
    ];
    state.status = "holding";
  }

  /**
   * Question `id`'s issue comment now shows it, since `at` by GitHub's
   * clock, in the short form or naming its id (github-sync `ask`). A
   * question closed meanwhile was still shown: it counts for `lastShownAt`.
   */
  shown(id: string, at: string, shortForm: boolean): void {
    const hold = this.state.holds.find((open) => open.id === id);
    if (hold) {
      hold.shownAt = at;
      if (shortForm) hold.shortForm = true;
      else delete hold.shortForm;
    }
    if (!(Date.parse(this.state.lastShownAt ?? "") >= Date.parse(at)))
      this.state.lastShownAt = at;
  }

  /**
   * Answer the open question `question` names (a hold id): the id names
   * one asking, so nothing else is checked. An answer that names none (a
   * `/factory <answer>` comment) applies only when exactly one question is
   * open, its comment showed the short form before the answer was written,
   * and no other question's comment was shown after it. All three times
   * are GitHub's, so a skewed host clock can't land an answer on a question
   * its author didn't read. Returns null when applied, or the reason it
   * doesn't fit. The caller saves (see `transact`).
   */
  answer(
    answer: string,
    text: string | undefined,
    by: string,
    writtenAt?: string,
    question?: string,
  ): string | null {
    if (answer === "cancel") return this.cancel(by);
    const issue = this.state.issue;
    const holds = this.state.holds;
    if (!holds.length)
      return question === undefined
        ? `#${issue} has no open question.`
        : `#${issue}'s question ${question} was already answered, and no question is open now.`;
    if (question === undefined) {
      const why = unboundRefusal(holds, this.state.lastShownAt, writtenAt);
      if (why)
        return `That answer names no question, and ${why}, so it wasn't applied. ${openQuestions(issue, holds)}`;
    }
    const hold =
      question === undefined
        ? holds[0]!
        : holds.find((open) => open.id === question);
    if (!hold)
      return `#${issue}'s question ${question} isn't open, so that answer wasn't applied. ${openQuestions(issue, holds)}`;
    if (!hold.answers.includes(answer))
      return `"${answer}" isn't an answer to question ${hold.id}. Answers: ${hold.answers.join(", ")}.`;
    let provider: string | undefined;
    if (answer === SWITCH) {
      const others = this.otherProviders();
      provider =
        text?.trim().split(/\s+/)[0] ||
        (others.length === 1 ? others[0] : undefined);
      if (
        !provider ||
        !this.workflow.providers?.[provider] ||
        !others.includes(provider)
      )
        return others.length
          ? `Name the provider to switch to: \`${SWITCH} NAME\`, one of ${others.join(", ")}.`
          : "No other provider is configured, and this one's settings are unchanged, so there is nothing to switch to.";
    }
    const retry = this.state.retries[hold.step];
    this.close(hold);
    if (answer === WAIT && retry) {
      // A limit is the account's: waiting for it is every step's answer.
      for (const other of Object.values(this.state.retries))
        if (other === retry || sameLimit(retry, other)) this.grant(other);
    } else {
      if (provider) {
        // The Objective's frozen provider changes for the rest of its run,
        // and every step waiting on a provider's limit runs now, on it.
        this.state.provider = {
          name: provider,
          selectedBy: "switch",
          settings: structuredClone(this.workflow.providers![provider]!),
        };
        for (const [key, other] of Object.entries(this.state.retries))
          if (other.wait?.kind === "reset" && other.wait.provider)
            delete this.state.retries[key];
      } else
        this.state.answers[hold.step] = {
          holdId: hold.id,
          question: hold.question,
          answer,
          ...(text ? { text } : {}),
          by,
          at: this.now().toISOString(),
        };
      delete this.state.retries[hold.step];
    }
    this.settle();
    return null;
  }

  /** `holding` while any question is open; else the status progress gives. */
  private settle(): void {
    if (TERMINAL.includes(this.state.status)) return;
    this.state.status = this.state.holds.length
      ? "holding"
      : this.workflow.status(this.state);
  }

  /**
   * Close a question (answered, or moot after a repair). Its time is not
   * the time of the steps it stopped: a step can't run while a question
   * that stops it is open, so its wait clocks (`since`, a granted wait)
   * pause from when it was due, or the question was asked if later, until
   * now, or until another open question that stops it too was asked, if
   * earlier (that one's close pauses the rest). Only steps the question
   * stopped pause: an item's question leaves other items' clocks running.
   * Budgets and the status note count only time a step could run.
   * A human gate's `since` stays: it is never timed out, and its reminder
   * (github-sync note) is keyed to the original start, so moving it would
   * post the reminder again.
   */
  private close(hold: Hold): void {
    const now = this.now().getTime();
    const rest = this.state.holds.filter((open) => open !== hold);
    for (const [key, retry] of Object.entries(this.state.retries)) {
      if (key === hold.step || retry.wait?.kind === "gate") continue;
      if (!this.stops(hold, key)) continue;
      const until = Math.min(
        now,
        ...rest
          .filter((open) => this.stops(open, key))
          .map((open) => Date.parse(open.askedAt)),
      );
      const paused =
        until - Math.max(Date.parse(hold.askedAt), Date.parse(retry.nextAt));
      if (!(paused > 0)) continue;
      const later = (at: string) =>
        new Date(Date.parse(at) + paused).toISOString();
      retry.since = later(retry.since);
      if (retry.grantedUntil) retry.grantedUntil = later(retry.grantedUntil);
    }
    this.state.holds = rest;
  }

  private otherProviders(): string[] {
    return switchTargets(this.state.provider, this.workflow.providers);
  }

  /**
   * `wait`: keep waiting without asking, until a known reset (and the
   * usual budget after it), for a day on a limit with no reset time, or for
   * another `maxWaitMs` on a transient cause.
   */
  private grant(retry: Retry): void {
    const now = this.now().getTime();
    const reset = retry.wait?.kind === "reset";
    const at =
      reset && retry.wait?.kind === "reset" && retry.wait.at
        ? Math.max(Date.parse(retry.wait.at), now)
        : Number.NaN;
    retry.grantedUntil = new Date(
      Number.isFinite(at)
        ? at + this.limits.maxWaitMs
        : now + (reset ? this.limits.remindAfterMs : this.limits.maxWaitMs),
    ).toISOString();
    retry.nextAt = new Date(Number.isFinite(at) ? at : now).toISOString();
  }

  /**
   * Cancel at once: stop running steps and mark the Objective cancelled.
   * Cleanup steps follow. A finished Objective stays as it is.
   */
  cancel(by: string): string | null {
    const status = this.state.status;
    if (status === "done" || status === "failed")
      return `#${this.state.issue} has already finished (${status}).`;
    if (status === "cancelled") return null;
    this.state.status = "cancelled";
    this.state.holds = [];
    this.state.attempts = {};
    this.state.retries = {};
    this.state.answers.cancel = {
      holdId: "",
      answer: "cancel",
      by,
      at: this.now().toISOString(),
    };
    // Stop running steps only once the cancel is saved.
    this.afterSave.push(() => {
      this.abort([...this.running.keys()], "cancelled");
      this.log.write(this.state.issue, { event: "cancelled", by });
    });
    return null;
  }

  /**
   * Answer `retry` to the open question `question` names; or, naming none,
   * run the waiting steps no open question stops now. A bare retry never
   * answers a question: while one stops every step, it is refused.
   */
  retryNow(by: string, question?: string): string | null {
    const issue = this.state.issue;
    const holds = this.state.holds;
    if (question !== undefined) {
      const hold = holds.find((open) => open.id === question);
      if (hold && !hold.answers.includes("retry"))
        return `#${issue}'s question ${hold.id} has no retry answer. Answers: ${hold.answers.join(", ")}.`;
      return this.answer("retry", undefined, by, undefined, question);
    }
    if (holds.some((hold) => hold.item === undefined))
      return `#${issue} has an open question that stops every step, so retry must name it. ${openQuestions(issue, holds)}`;
    const waiting = Object.entries(this.state.retries).filter(
      ([key]) => !this.heldBy(key),
    );
    if (holds.length && !waiting.length)
      return `#${issue}'s waiting steps all wait on an open question, so retry must name it. ${openQuestions(issue, holds)}`;
    for (const [, retry] of waiting) retry.nextAt = this.now().toISOString();
    return null;
  }

  private save(): void {
    this.state.updatedAt = this.now().toISOString();
    if (TERMINAL.includes(this.state.status))
      this.state.endedAt ??= this.state.updatedAt;
    saveState(this.dir, this.state);
  }
}

/**
 * Why an answer that names no question, written at `writtenAt` (GitHub's
 * time), can't tell which question its author read; undefined when it can.
 */
function unboundRefusal(
  holds: readonly Hold[],
  lastShownAt: string | undefined,
  writtenAt: string | undefined,
): string | undefined {
  if (holds.length > 1) return "more than one question is open";
  const [hold] = holds;
  if (!hold?.shortForm || hold.shownAt === undefined)
    return "the open question's comment doesn't show the short form";
  if (!(Date.parse(hold.shownAt) < Date.parse(writtenAt ?? "")))
    return "it was written before the open question was shown";
  if (lastShownAt !== hold.shownAt)
    return "another question was shown after the open one";
  return undefined;
}

function openQuestions(issue: number, holds: readonly Hold[]): string {
  return holds.length
    ? `Open questions: ${holds.map((hold) => `${hold.id} (${hold.answers.join(", ")})`).join("; ")}. Name one: \`factory answer ${issue} <answer> --question <id>\`, or comment \`/factory <answer> --question <id>\`.`
    : "No question is open now.";
}

/** Whether two retries wait on the same limit: a limit is its account's, not one step's. */
function sameLimit(a: Retry, b: Retry): boolean {
  return (
    a.wait?.kind === "reset" &&
    b.wait?.kind === "reset" &&
    a.wait.provider === b.wait.provider
  );
}

/** A retry's class: a reset, a gate, or an unknown cause (errors included). */
function waitClass(wait: Wait | undefined): string {
  return wait?.kind ?? "unknown";
}

function hours(ms: number): string {
  const h = ms / (60 * 60 * 1000);
  return h >= 1 ? `${Number(h.toFixed(1))} h` : `${Math.round(ms / 1000)} s`;
}
