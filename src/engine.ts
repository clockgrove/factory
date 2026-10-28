import {
  asked,
  askedFor,
  chargeRereview,
  countConflict,
  grantOverrun,
  grantRereviews,
  overrun,
  overrunQuestion,
  rereviewNote,
  rereviewQuestion,
} from "./allowances.js";
import { crashPoint } from "./crash.js";
import { displayTime, duration } from "./display.js";
import {
  callCounts,
  newTransport,
  requestEvents,
  transport,
} from "./github-trace.js";
import type { RunFile, RunLog } from "./log.js";
import { deliveryChange, profilesLacking } from "./planning/plan.js";
import type { FrozenConfig } from "./providers/selection.js";
import { type RequestResult, refused } from "./requests.js";
import {
  amountOf,
  charge,
  type Day,
  type DaySpend,
  dayOf,
  grantSpend,
  reached,
  spendLimits,
  spendQuestion,
} from "./spend.js";
import {
  type Answer,
  type AnsweredVia,
  type AnswerPart,
  answerForm,
  answerList,
  answersOf,
  type Frozen,
  type Hold,
  type HoldCause,
  type HoldClosing,
  type HoldOption,
  keptClosings,
  type ObjectiveState,
  type ObjectiveStatus,
  RESET_KEY,
  type Retry,
  recordClosed,
  saveState,
  TERMINAL,
  type Wait,
} from "./state.js";
import { errorMessage, oneLine } from "./text.js";

/** What a step reports. Every step ends in exactly one of these. */
export type Outcome =
  | {
      kind: "done";
      result?: unknown;
      /** Facts that outlive repairs, such as the heads already pushed (`state.kept`, work/facts.ts); null deletes one. */
      keep?: Record<string, unknown>;
    }
  /**
   * Try again: a wait, classed by `wait` (docs/reference/steps.md#Waits); an `error`
   * (`errored`) counts toward `maxErrors`. `afterMs` sets when it comes
   * back, else the backoff does. `progress`: the step kept what it did
   * (`keep`) and goes on at once (a continuation, such as collecting
   * captured media): not a wait, so it ends any run of retries, and no
   * note or wait clock counts it. An attempt the service's death
   * interrupted is never an outcome: it runs again (see
   * `ObjectiveRunner.tick`).
   */
  | {
      kind: "retry";
      reason: string;
      afterMs?: number;
      progress?: boolean;
      wait?: Wait;
      /** A wait that becomes a question after a while (see `HoldAfter`). */
      holdAfter?: HoldAfter;
      keep?: Record<string, unknown>;
    }
  | {
      kind: "hold";
      question: string;
      /** Exactly one is `recommended` (see `hold`). */
      options: HoldOption[];
      /** What the question stops; absent: `item` (see `HoldScope`). */
      scope?: HoldScope;
      /** Absent: `question` (see `HoldCause`). */
      cause?: HoldCause;
      keep?: Record<string, unknown>;
      /** A repair the question's evidence blames on another Work Item: it counts against no allowance (as a repair's `free`). */
      free?: { target: string; repair: number };
      /** A human gate's question: the step polls on while it is open (`Hold.polls`). */
      polls?: true;
      /**
       * The step's result is its refused result again: its worker made no
       * change after the operator's guidance (#2131). The engine answers
       * `revalidate` itself when the workflow can take it and a result
       * rereview is left, charged as one; else the question is asked.
       */
      rereview?: true;
    }
  /**
   * The whole state is replaced (`factory reset`'s steps, reset.ts): the
   * rebuilt Objective, or, with `withdraw`, the record is withdrawn as if
   * never admitted (service.ts); or a rebuilt plan, accepted, with what
   * merged under it. Only those steps return it.
   */
  | {
      kind: "replace";
      /**
       * The new record, built from the live state at apply time, so what
       * the operator and the sync changed while the step ran (a pause, an
       * applied request, the comment cursor) is kept.
       */
      build: (live: ObjectiveState) => ObjectiveState;
      withdraw?: boolean;
    }
  /**
   * The work is wrong (validation, review or CI refused it): clear `clear`
   * from the finished steps and run `target` again with the finding, within
   * the repair allowances (allowances.ts).
   */
  | {
      kind: "repair";
      finding: string;
      target: string;
      clear: string[];
      /** A mechanical merge conflict: it counts against perPath only (allowances.ts). */
      conflict?: true;
      /**
       * Repair number `repair` of `target` stops counting against the repair
       * allowances (allowances.ts): that item's failure was blamed on the
       * predecessor this outcome repairs. Applying it twice is harmless.
       */
      free?: { target: string; repair: number };
      /** A result rereview (`revalidate`): charged to resultRereviews when the answer landed, so it counts against no repair allowance. */
      rereview?: true;
      keep?: Record<string, unknown>;
    };

/** A question outcome (see `hold`). */
export type Held = Extract<Outcome, { kind: "hold" }>;

/**
 * A wait that becomes a question once it has gone on `ms`: from `since`
 * when given (a push's time), else from when the step's run of retries of
 * this class began. GitHub lagging behind what Factory did, and a check
 * that never registers, are asked about this way.
 */
export interface HoldAfter {
  ms: number;
  question: string;
  /** Absent: `retry` and `cancel`. */
  offers?: readonly Offer[];
  /** Absent: `item` (see `HoldScope`). */
  scope?: HoldScope;
  since?: string;
}

/**
 * What a question stops (docs/reference/holds.md#Holds and answers). `item`: a Work Item
 * step's question stops that item and the items that depend on it; any
 * other step's stops the Objective. `objective`: the cause is the whole
 * Objective's (its issue, the repository, the host, a provider account),
 * so it stops every step, and is asked once.
 */
export type HoldScope = "item" | "objective";

/**
 * The answers whose consequence is the same wherever they are offered,
 * written once. `switch` stands for one option per configured provider,
 * this Objective's own included: the engine expands it when it asks
 * (`ObjectiveRunner.switchOptions`).
 */
const COMMON = {
  retry: { family: "retry", consequence: "Runs the step again." },
  replan: {
    family: "replan",
    consequence:
      "Plans again from the issue as it reads now; after acceptance, the plan and build are dropped first.",
  },
  cancel: {
    family: "cancel",
    consequence: "Ends the Objective at once and closes its PRs and the issue.",
  },
  wait: {
    family: "wait",
    consequence:
      "Keeps waiting until the limit resets, with no question until then.",
  },
  switch: {
    family: "switch",
    consequence:
      "Runs this Objective on another configured provider from now on.",
  },
  adopt: {
    family: "adopt",
    consequence: "Freezes the configuration as it is now and continues.",
  },
  refuse: {
    family: "refuse",
    consequence:
      "Rejects the amendment, so it can be replaced or the plan runs without it.",
  },
  answer: {
    family: "answer",
    consequence:
      "Sends your text to the Work Item's next attempt as the operator's guidance.",
    needsText: true,
  },
  fresh: {
    family: "repair",
    consequence:
      "Discards the Work Item's result and work and starts it again on the current base; counts as a repair.",
  },
  revalidate: {
    family: "accept",
    consequence:
      "Validates and reviews the same result again, without the worker; uses a result rereview.",
  },
} as const satisfies Record<string, Omit<HoldOption, "answer">>;

/** An answer a step offers: a common one by name, or any other written out. */
export type Offer = keyof typeof COMMON | HoldOption;

/**
 * A question for the operator, with the answers it offers. The option
 * marked `recommended`, else the first, is the recommended one.
 */
export function hold(
  question: string,
  offers: readonly Offer[] = ["retry", "cancel"],
): Extract<Outcome, { kind: "hold" }> {
  const options = offers.map((offer) =>
    typeof offer === "string" ? common(offer) : offer,
  );
  return { kind: "hold", question, options: recommend(options) };
}

function common(answer: keyof typeof COMMON): HoldOption {
  return { answer, ...COMMON[answer] };
}

/** The options with exactly one recommended: the one marked, else the first. */
function recommend(options: readonly HoldOption[]): HoldOption[] {
  const chosen = Math.max(
    0,
    options.findIndex((option) => option.recommended),
  );
  return options.map(({ recommended: _, ...option }, index) =>
    index === chosen ? { ...option, recommended: true } : option,
  );
}

/**
 * The step can't succeed as it is: a hold with the cause `failure`, which
 * also offers `replan` where the workflow can plan again.
 */
export function failure(
  question: string,
  offers?: readonly Offer[],
): Extract<Outcome, { kind: "hold" }> {
  return { ...hold(question, offers), cause: "failure" };
}

/** An error: it retries with backoff, and `maxErrors` in a row hold. */
export function errored(reason: string): Extract<Outcome, { kind: "retry" }> {
  return { kind: "retry", reason, wait: { kind: "error" } };
}

/** The outcome, with a question in it made the whole Objective's (see `HoldScope`). */
export function objectiveWide<T extends Outcome>(outcome: T): T {
  return outcome.kind === "hold" ? { ...outcome, scope: "objective" } : outcome;
}

/** The Work Item a step belongs to: item steps are keyed `item:<id>:<phase>`. */
/** The step that cleans up after cancel (work/finish.ts `cancelCleanupStep`). */
export const CANCEL_CLEANUP = "cancel:cleanup";

/** Failures in a row (over at least `maxWaitMs`) after which cleanup after the end settles, leaving what it couldn't do. */
export const MAX_CLEANUP_FAILURES = 5;

/**
 * A `neverAsks` step's result once it settled without finishing: the last
 * failure, which names what was left (PRs, branches, files).
 */
export interface Left {
  left: string;
  failures: number;
}

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
  /**
   * A private file of this attempt beside the run log, such as a worker's
   * transcript or a failed command's whole output (log.ts RunLog.runFile).
   * Its event names it by `file`.
   */
  runFile(kind: string): RunFile;
  /**
   * Facts to keep with whatever outcome this attempt ends in, an error
   * included (`state.kept`, as an outcome's `keep`, which wins on a
   * clash), such as a retained conversation's session (providers/session.ts).
   */
  keep(facts: Record<string, unknown>): void;
}

export interface Step {
  /** Stable for the Objective, such as `plan` or `item:a:work`. */
  readonly key: string;
  readonly deadlineMs: number;
  /** A host-wide limit this step counts against (see `HostResource`). */
  readonly resource?: HostResource;
  /**
   * Cleanup after the end (cancel's): it never asks. Any outcome but
   * `done` retries in the background with the usual backoff, until
   * MAX_CLEANUP_FAILURES over at least `maxWaitMs`; then it is done with
   * what it left (`Left`).
   */
  readonly neverAsks?: true;
  /**
   * The answer that gets past a model call too large for the model
   * (`Workflow.outcomeOf`): `replan` by default; `refuse` for a step whose
   * input the operator can reject instead, which its errors-in-a-row
   * question offers too.
   */
  readonly redo?: "replan" | "refuse";
  run(context: StepContext): Promise<Outcome>;
}

/** What to do next. Every function is a pure function of its input. */
export interface Workflow {
  steps(state: ObjectiveState): Step[];
  /** The status of a state that isn't holding or terminal. */
  status(state: ObjectiveState): ObjectiveStatus;
  /**
   * An error that escaped `step` as its outcome: the one map from
   * failures (GitHub's, a provider's, Git's, the host's) to waits and
   * holds (docs/reference/steps.md#Waits). Absent, or undefined: an error (`errored`).
   */
  outcomeOf?(error: unknown, step: Step): Outcome | undefined;
  /** The service read this state from disk (a restart): what it made just before may still lag on GitHub. */
  resumed?(state: ObjectiveState): void;
  /**
   * Whether `replan` can answer a question of step `key`: the engine then
   * offers it on the step's failures, and applies `replan` itself.
   */
  replannable?(state: ObjectiveState, key: string): boolean;
  /**
   * The operator answered `replan` (`answer`) to step `key`'s question:
   * what happens instead of running the step. A `repair` here is a new
   * start, not a fix: the cleared steps' repair history goes with them,
   * and it counts against no budget.
   */
  replan?(state: ObjectiveState, key: string, answer: Answer): Outcome;
  /**
   * Whether `fresh` can answer a question of Work Item step `key`: the
   * engine then offers it on that item's questions, and applies it itself.
   */
  freshable?(state: ObjectiveState, key: string): boolean;
  /**
   * The operator answered `fresh` to step `key`'s question: a repair that
   * discards the item's result and work, counted against the allowances
   * like any repair.
   */
  fresh?(state: ObjectiveState, key: string, answer: Answer): Outcome;
  /**
   * Whether `revalidate` (a result rereview) can answer a question of Work
   * Item step `key`: the item has a refused result to check again. The
   * engine then offers it, charges it to resultRereviews when it lands,
   * and runs the step without asking about repair allowances.
   */
  revalidatable?(state: ObjectiveState, key: string): boolean;
  /**
   * The answers step `key`'s repair-allowance question offers beside
   * `more`, with a note for its question: `accept` answers to the refusal
   * driving the repairs.
   */
  overrunOffers?(
    state: ObjectiveState,
    key: string,
  ): { note: string; options: HoldOption[] } | undefined;
  /**
   * Whether step `key` takes `answer` without a repair (an `accept` it
   * hasn't recorded): it then runs once past a spent repair allowance.
   */
  unspent?(state: ObjectiveState, key: string, answer: Answer): boolean;
  /**
   * Whether step `key` runs once past a spent repair allowance to diagnose
   * its pending repair first: a diagnosis that blames another Work Item
   * spends no repair, so it is decided before `more` is asked. The step
   * then saves its diagnosis and goes on (`progress`), and the allowance
   * question follows.
   */
  diagnoseFirst?(state: ObjectiveState, key: string): boolean;
  /**
   * The configuration as an Objective freezes it now, per configured
   * provider, for the `switch NAME` and `adopt` answers.
   */
  readonly freezable?: Readonly<Record<string, FrozenConfig>>;
  /**
   * The Work Items whose questions also stop `item` although it can run
   * before they settle: the native-stack layers below it. (A dependency's
   * dependents aren't runnable until it merges, so they wait anyway.)
   */
  upstream?(state: ObjectiveState, item: string): readonly string[];
}

/**
 * What a step uses that the host caps across every Objective: model-bound
 * `worker` runs, CPU-heavy validation (`cpu`), `planner` calls (planning
 * rounds and reviews), and the `github` reads and shared-checkout fetch of
 * a newly queued Objective's check or re-run cleanup, which run before it
 * has a slot: a burst of queued issues waits its turn, in queue order,
 * instead of fanning out.
 */
export type HostResource = "worker" | "cpu" | "planner" | "github";

/** The limiter's settings (config.ts `execution`): slots, and memory each step reserves. */
export interface HostCapacity {
  caps: Record<HostResource, number>;
  /** MiB a step of each resource reserves while it runs. */
  reserveMiB: Record<HostResource, number>;
  /** MiB every running step may reserve together. */
  budgetMiB: number;
}

/** What the limiter holds now: `service.json` keeps it for `status --capacity`. */
export interface CapacityUse extends HostCapacity {
  used: Record<HostResource, number>;
  reservedMiB: number;
}

/** This run of the service, shared by its Objectives' runners. */
export interface ServiceRun {
  /** Saved on each attempt this run starts, so a restart knows what was running when it died. */
  readonly id: string;
  /** Step attempts that finished in this run (any outcome). */
  finished: number;
  /** Interrupted attempts wait until then (a crash loop, see `serve`); 0 when they resume at once. */
  resumeAt: number;
  /** Steps across the service the last death made suspects (`ObjectiveRunner.interrupted`). */
  suspects?: number;
  /** The installation's model spend today (spend.ts); absent, only the Objective's own is counted. */
  spend?: DaySpend;
}

/** Deaths in a row an attempt runs at, other steps finishing between, before its step holds. */
const SUSPECT_CRASHES = 3;

/**
 * Host-wide caps shared by every Objective in the service: a step takes a
 * slot of its resource and reserves its memory, and starts only when both
 * fit. Memory is what a host runs out of first (CPU only slows), so a
 * full host makes the next step wait instead of the kernel killing one.
 * Planner calls take only the memory the free worker and validation slots
 * don't need.
 */
export class HostLimiter {
  private readonly used: Record<HostResource, number> = {
    worker: 0,
    cpu: 0,
    planner: 0,
    github: 0,
  };
  private reservedMiB = 0;
  constructor(private capacity: HostCapacity) {}

  configure(capacity: HostCapacity): void {
    this.capacity = capacity;
  }

  acquire(resource: HostResource): boolean {
    const { caps, reserveMiB, budgetMiB } = this.capacity;
    if (this.used[resource] >= caps[resource]) return false;
    // A planner call leaves room for every free worker and validation slot,
    // so memory never holds those below their caps.
    const room =
      resource === "planner"
        ? (["worker", "cpu"] as const).reduce(
            (sum, each) =>
              sum +
              Math.max(0, caps[each] - this.used[each]) * reserveMiB[each],
            0,
          )
        : 0;
    if (this.reservedMiB + reserveMiB[resource] + room > budgetMiB)
      return false;
    this.used[resource] += 1;
    this.reservedMiB += reserveMiB[resource];
    return true;
  }

  release(resource: HostResource): void {
    if (this.used[resource] === 0) return;
    this.used[resource] -= 1;
    this.reservedMiB = Math.max(
      0,
      this.reservedMiB - this.capacity.reserveMiB[resource],
    );
  }

  usage(): CapacityUse {
    return {
      ...this.capacity,
      used: { ...this.used },
      reservedMiB: this.reservedMiB,
    };
  }
}

/** The service's limiter; `serve` sets it from configuration. */
export const hostLimits = new HostLimiter({
  caps: { worker: 2, cpu: 2, planner: 4, github: 2 },
  reserveMiB: { worker: 0, cpu: 0, planner: 0, github: 0 },
  budgetMiB: Number.MAX_SAFE_INTEGER,
});

export interface EngineLimits {
  /** Escaped errors and missed deadlines in a row before a step holds. */
  maxErrors: number;
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
/** Who cancelled an Objective at its deadline (`ended.by`). */
export const DEADLINE = "deadline";

export const DEFAULT_LIMITS: EngineLimits = {
  maxErrors: 3,
  maxWaitMs: 3 * HOUR,
  noteAfterMs: HOUR,
  remindAfterMs: 24 * HOUR,
  baseBackoffMs: 30_000,
  maxBackoffMs: 15 * 60 * 1000,
  concurrency: 2,
};

/** Answers the engine applies itself. */
const WAIT = "wait";
const SWITCH = "switch";
const ADOPT = "adopt";
/** Grants as much again of each repair allowance the step overran (allowances.ts). */
const MORE = "more";
/** A refused result checked again, unchanged: charged to resultRereviews. */
const REVALIDATE = "revalidate";
/**
 * The configuration digest the open `adopt` question names (`state.kept`,
 * set by the question's step): `adopt` freezes only that one.
 */
export const ADOPTS = "config:adopts";
export const REPLAN = "replan";
export const FRESH = "fresh";
/** The most bytes an answer's text carries, however it came (a GitHub comment's limit). */
export const MAX_ANSWER_TEXT = 65_536;

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
  /** Every started attempt until it ends, aborted ones too (see `stop`). */
  private readonly inFlight = new Set<Promise<unknown>>();
  private nextToken = 1;
  /** Replaced by a new run of the same Objective: it never saves again. */
  private stopped = false;
  /**
   * The replaced runs' steps haven't stopped yet (`after`): no step that
   * isn't cleanup after cancel starts, so nothing reads GitHub while an
   * effect of theirs may still land.
   */
  waiting = false;
  /** When the replaced runs' steps have ended (`after`); `stop` passes it on. */
  private pending?: Promise<void>;
  /** Effects outside the state, run only once the change is saved. */
  private afterSave: (() => void)[] = [];
  /** The service's wait (`waitOn`): since when, and the steps it stops. */
  private imposed?: { since: number; stops: (key: string) => boolean };

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
   * with it too. A human gate's question doesn't stop its own step, which
   * polls on (`Hold.polls`).
   */
  heldBy(key: string): Hold | undefined {
    return this.state.holds.find(
      (hold) => !(hold.polls && hold.step === key) && this.stops(hold, key),
    );
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

  /** Terminal, with nothing left to run. */
  get settled(): boolean {
    return settled(this.state, this.workflow, this.busy);
  }

  /**
   * Start no step until `stopped` (a replaced run's `stop`) resolves,
   * except cleanup after cancel: a cancel never waits.
   */
  after(stopped: Promise<void>): void {
    this.waiting = true;
    this.pending = stopped;
    void stopped.then(() => {
      if (this.pending === stopped) this.waiting = false;
    });
  }

  /**
   * Run `change` against the state and save it. If the change or the save
   * throws, the in-memory state goes back to what is on disk, so memory
   * never claims what a save didn't keep. Effects after the save run once
   * it is saved; one that throws is logged.
   */
  transact<T>(change: () => T): T {
    if (this.stopped)
      throw new Error(`#${this.state.issue}'s run was replaced`);
    const before = structuredClone(this.state);
    this.afterSave = [];
    let result: T;
    try {
      result = change();
      this.save();
    } catch (error) {
      this.state = before;
      this.afterSave = [];
      throw error;
    }
    // Saved: the change stands whatever an effect after it does, so a
    // failed effect is logged, never thrown as if nothing changed.
    const effects = this.afterSave;
    this.afterSave = [];
    for (const effect of effects)
      try {
        effect();
      } catch (error) {
        this.log.write(this.state.issue, {
          event: "after-save-failed",
          error: String(error),
        });
      }
    return result;
  }

  /**
   * Start every runnable step that isn't running or waiting to retry.
   *
   * An attempt saved as started but not running here was interrupted: by
   * the service's death, or by a save that failed after the step finished.
   * That is never the step's error: it runs again at once, with no backoff,
   * even while a question that stops it is open, unless the service is in a
   * crash loop (`ServiceRun.resumeAt`), or the service died under it again
   * and again (`interrupted`): then it asks, as soon as no question stops
   * it. An interrupted attempt of a step that is no longer next is
   * dropped. Any other step waits while a question that stops it is open
   * (`heldBy`).
   */
  tick(allow: (key: string) => boolean = () => true): void {
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
      const interrupted = this.state.attempts[step.key]?.interrupted ?? 0;
      if (interrupted >= SUSPECT_CRASHES && !step.neverAsks) {
        if (!this.heldBy(step.key)) this.suspect(step.key, interrupted);
        continue;
      }
      if (this.running.size >= this.limits.concurrency) return;
      if (this.waiting && !step.neverAsks) return;
      // An operator's pause or drain (service.ts `allowed`) starts nothing
      // new; an interrupted attempt still resumes.
      if (!this.state.attempts[step.key] && !allow(step.key)) continue;
      if (this.state.attempts[step.key]) {
        if (now < this.run.resumeAt) continue;
      } else if (this.heldBy(step.key)) continue;
      else {
        const retry = this.state.retries[step.key];
        if (retry && Date.parse(retry.nextAt) > now) continue;
      }
      // `replan` is the workflow's where it can plan again, never the
      // step's: the plan changes, so the steps do too.
      const answer = this.state.answers[step.key];
      if (
        answer?.answer === REPLAN &&
        this.workflow.replan &&
        this.workflow.replannable?.(this.state, step.key)
      ) {
        this.apply(
          step.key,
          this.workflow.replan(structuredClone(this.state), step.key, answer),
          true,
        );
        crashPoint(`engine:${step.key}:replan-applied`);
        return;
      }
      // So is `fresh`: it clears the item's steps. Applied with the answer
      // in one save, so the answer (its hold id) takes effect once.
      if (
        answer?.answer === FRESH &&
        this.workflow.fresh &&
        this.workflow.freshable?.(this.state, step.key)
      ) {
        this.apply(
          step.key,
          this.workflow.fresh(structuredClone(this.state), step.key, answer),
        );
        return;
      }
      // A repair past an allowance asks before it runs (allowances.ts):
      // `more` grants as much again. Past the Objective's, every step waits.
      // An interrupted attempt passed this check when it started, a
      // `revalidate` is no repair (it was charged to resultRereviews), and
      // neither is an `accept` the step hasn't recorded yet.
      const over =
        this.state.attempts[step.key] ||
        answer?.answer === REVALIDATE ||
        (answer && this.workflow.unspent?.(this.state, step.key, answer))
          ? []
          : overrun(this.state, step.key);
      if (over.length && !this.workflow.diagnoseFirst?.(this.state, step.key)) {
        const offers = this.workflow.overrunOffers?.(this.state, step.key);
        this.transact(() => {
          this.hold(step.key, {
            ...failure(
              `${overrunQuestion(this.state, step.key, over)}${offers?.note ?? ""}`,
              [
                {
                  answer: MORE,
                  family: "retry",
                  consequence:
                    "Allows as much again of each spent allowance, and the repair runs.",
                },
                ...(this.workflow.revalidatable?.(this.state, step.key)
                  ? [common(REVALIDATE)]
                  : []),
                ...(offers?.options ?? []),
                "cancel",
              ],
            ),
            ...(over.includes("implementationRepairs")
              ? { scope: "objective" as const }
              : {}),
          });
          const question = this.state.holds.at(-1);
          if (question?.step === step.key)
            asked(this.state, question.id, "repairs");
        });
        continue;
      }
      // A model step past the spend ceiling asks before it starts
      // (spend.ts): `more` grants as much again. Calls running finish.
      const day =
        (step.resource === "planner" || step.resource === "worker") &&
        !this.state.attempts[step.key] &&
        Object.keys(spendLimits(this.state)).length
          ? this.today()
          : undefined;
      if (day && reached(this.state, day).length) {
        this.transact(() => {
          this.hold(step.key, {
            ...hold(spendQuestion(this.state, day), [
              {
                answer: MORE,
                family: "retry",
                consequence:
                  "Allows as much again of each spend limit reached, and model calls go on.",
              },
              "cancel",
            ]),
            scope: "objective",
          });
          const question = this.state.holds.at(-1);
          if (question?.step === step.key)
            asked(this.state, question.id, "spend");
        });
        continue;
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

  /** The installation's spend today; nothing without its ledger. */
  private today(): Day {
    return (
      this.run.spend?.today() ?? {
        day: dayOf(this.now()),
        tokens: 0,
        cents: 0,
      }
    );
  }

  /**
   * Charge a model call to the Objective and the day (spend.ts). A charge
   * that can't be saved is logged; the call's own event already is.
   */
  private charge(event: Record<string, unknown>): void {
    const amount = amountOf(event);
    if (!amount.tokens && !amount.cents) return;
    try {
      this.run.spend?.charge(amount);
      if (!this.stopped) this.transact(() => charge(this.state, amount));
    } catch (error) {
      this.log.write(this.state.issue, {
        event: "spend-unsaved",
        error: String(error),
      });
    }
  }

  private start(step: Step): void {
    let attemptId = "";
    let parent: string | undefined;
    this.transact(() => {
      this.state.stepRuns ??= {};
      const runs = this.state.stepRuns;
      const n = (runs[step.key]?.n ?? 0) + 1;
      attemptId = `${step.key}#${n}`;
      // An interrupted attempt is the one this reruns, and keeps its count.
      const interrupted = this.state.attempts[step.key]?.interrupted;
      parent = this.state.attempts[step.key]?.id ?? runs[step.key]?.parent;
      runs[step.key] = { n };
      this.state.attempts[step.key] = {
        startedAt: this.now().toISOString(),
        run: this.run.id,
        id: attemptId,
        ...(interrupted ? { interrupted } : {}),
      };
    });
    crashPoint(`engine:${step.key}:started`);
    const token = this.nextToken++;
    const controller = new AbortController();
    this.running.set(step.key, { token, controller });
    const answer = this.state.answers[step.key];
    let kept: Record<string, unknown> | undefined;
    const context: StepContext = {
      state: structuredClone(this.state),
      ...(answer ? { answer } : {}),
      signal: controller.signal,
      log: (event) => {
        this.log.write(this.state.issue, {
          step: step.key,
          attemptId,
          ...event,
        });
        if (event.event === "model-usage") this.charge(event);
      },
      runFile: (kind) =>
        this.log.runFile(this.state.issue, `${attemptId}.${kind}`),
      keep: (facts) => {
        kept = { ...kept, ...facts };
      },
    };
    this.log.write(this.state.issue, {
      step: step.key,
      event: "start",
      attemptId,
      ...(parent ? { parentAttemptId: parent } : {}),
    });
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<Outcome>((resolve) => {
      timer = setTimeout(
        () => {
          controller.abort(new Error("deadline"));
          resolve(errored("deadline"));
        },
        Math.min(step.deadlineMs, this.limits.maxDeadlineMs ?? Infinity),
      );
    });
    // Every GitHub request of the attempt is traced, logged when it settles.
    const github = newTransport(true);
    const settled = transport.run(github, async () => step.run(context));
    void settled.then(
      () => this.traced(step.key, attemptId, github),
      () => this.traced(step.key, attemptId, github),
    );
    const run = settled.catch(
      (error: unknown): Outcome =>
        this.workflow.outcomeOf?.(error, step) ??
        errored(`error: ${errorMessage(error)}`),
    );
    const ended = Promise.race([run, deadline]);
    this.inFlight.add(ended);
    void ended.then((outcome) => {
      this.inFlight.delete(ended);
      clearTimeout(timer);
      // Released once per start, even when cancel already dropped the step.
      if (step.resource) hostLimits.release(step.resource);
      if (this.running.get(step.key)?.token !== token) return;
      this.running.delete(step.key);
      this.run.finished += 1;
      try {
        this.apply(
          step.key,
          kept && outcome.kind !== "replace"
            ? { ...outcome, keep: { ...kept, ...outcome.keep } }
            : outcome,
        );
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

  /** A settled attempt's GitHub requests: one `github-request` each, then their `github-call` counts. */
  private traced(
    key: string,
    attemptId: string,
    github: ReturnType<typeof newTransport>,
  ): void {
    if (!github.calls) return;
    const issue = this.state.issue;
    for (const event of requestEvents(key, github))
      this.log.write(issue, { step: key, attemptId, ...event });
    this.log.write(issue, {
      step: key,
      attemptId,
      event: "github-call",
      job: key,
      runs: 1,
      ...callCounts(github),
    });
  }

  /**
   * Apply one outcome and save; `replan`: the workflow's answer to an
   * operator's `replan` (`Workflow.replan`). Throws only if the save
   * fails, after putting the state back as it is on disk.
   */
  apply(key: string, outcome: Outcome, replan = false): void {
    const step = this.workflow.steps(this.state).find((s) => s.key === key);
    const attemptId = this.state.attempts[key]?.id;
    const attempt = attemptId ? { attemptId } : {};
    if (TERMINAL.includes(this.state.status) && !step) {
      // A step from before cancel: drop its outcome and its open attempt.
      this.log.write(this.state.issue, {
        step: key,
        event: "ignored",
        outcome: outcome.kind,
        ...attempt,
      });
      if (this.state.attempts[key])
        this.transact(() => {
          delete this.state.attempts[key];
        });
      return;
    }
    crashPoint(`engine:${key}:before-apply`);
    this.transact(() => {
      this.applyChange(key, outcome, replan, step?.neverAsks === true);
      // The attempt a continuation's, or a repair target's, next one continues.
      const next =
        outcome.kind === "repair"
          ? outcome.target
          : outcome.kind === "retry" && outcome.progress
            ? key
            : undefined;
      const runs = this.state.stepRuns;
      if (attemptId && next && runs)
        runs[next] = { n: runs[next]?.n ?? 0, parent: attemptId };
    });
    this.log.write(this.state.issue, {
      step: key,
      event: "outcome",
      ...attempt,
      outcome: outcome.kind,
      ...("reason" in outcome ? { reason: outcome.reason } : {}),
      // A retry's wait class, or a continuation: what analysis splits waits by.
      ...(outcome.kind === "retry" && outcome.wait
        ? { wait: outcome.wait.kind }
        : {}),
      ...(outcome.kind === "retry" && outcome.progress
        ? { progress: true }
        : {}),
      ...(outcome.kind === "repair"
        ? { target: outcome.target, finding: oneLine(outcome.finding, 300) }
        : {}),
    });
    crashPoint(`engine:${key}:applied`);
  }

  private applyChange(
    key: string,
    outcome: Outcome,
    replan: boolean,
    neverAsks: boolean,
  ): void {
    if (outcome.kind === "replace") {
      // The rebuilt record stands whole; the steps of the one it replaces
      // are gone with it.
      this.abortRunning(Object.keys(this.state.attempts));
      this.state = outcome.build(structuredClone(this.state));
      this.state.finishedRun = this.run.id;
      if (outcome.withdraw) this.state.withdrawing = true;
      return;
    }
    const state = this.state;
    const now = this.now();
    delete state.attempts[key];
    // A human gate's question closes by itself once its step no longer
    // waits on a human gate: the gate cleared (the step finished or went
    // on), or something else came. A question in its place supersedes it
    // (`next` is set once `hold` asks it, below); anything else moved on.
    const polled = (
      outcome.kind === "retry" && outcome.wait?.kind === "gate"
        ? []
        : state.holds.filter((open) => open.polls && open.step === key)
    ).map((open) => open.id);
    for (const id of polled)
      this.close(state.holds.find((open) => open.id === id)!, {
        how:
          outcome.kind === "done" ||
          (outcome.kind === "retry" && outcome.progress)
            ? "gate-cleared"
            : outcome.kind === "hold" && !neverAsks
              ? "superseded"
              : "moved-on",
      });
    // Saved with the outcome, so a death right after still counts as progress.
    state.finishedRun = this.run.id;
    if ("keep" in outcome && outcome.keep) {
      // null forgets a fact: readers see it as absent, never as null.
      state.kept ??= {};
      for (const [fact, value] of Object.entries(outcome.keep))
        if (value === null) delete state.kept[fact];
        else state.kept[fact] = value;
    }
    if (neverAsks && outcome.kind !== "done") {
      // Cleanup after the end never asks and never blocks: it retries in
      // the background with the usual backoff (until a rate limit's reset,
      // when one says), and settles only after MAX_CLEANUP_FAILURES and
      // `maxWaitMs` since its first failure, recording what it left
      // (`Left`), so the Objective settles and can be queued again. A
      // short outage or a rate limit never settles it.
      const previous = state.retries[key];
      const attempts = (previous?.attempts ?? 0) + 1;
      const since = previous?.since ?? now.toISOString();
      const backoff = Math.min(
        this.limits.baseBackoffMs * 2 ** (attempts - 1),
        this.limits.maxBackoffMs,
      );
      const resetAt =
        outcome.kind === "retry" && outcome.wait?.kind === "reset"
          ? Date.parse(outcome.wait.at ?? "")
          : Number.NaN;
      const lastError =
        "reason" in outcome
          ? outcome.reason
          : "question" in outcome
            ? outcome.question
            : outcome.finding;
      if (
        attempts >= MAX_CLEANUP_FAILURES &&
        now.getTime() - Date.parse(since) >= this.limits.maxWaitMs
      ) {
        const left: Left = { left: lastError, failures: attempts };
        state.done[key] = left;
        delete state.retries[key];
        this.log.write(state.issue, {
          step: key,
          event: "cleanup-left",
          failures: attempts,
          left: lastError,
        });
        return;
      }
      state.retries[key] = {
        count: (previous?.count ?? 0) + 1,
        attempts,
        since,
        nextAt: new Date(
          Math.max(
            now.getTime() + backoff,
            Number.isFinite(resetAt) ? resetAt : 0,
          ),
        ).toISOString(),
        lastError,
        ...(outcome.kind === "retry" && outcome.wait
          ? { wait: outcome.wait }
          : {}),
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
        if (outcome.progress) delete state.retries[key];
        else this.retry(key, outcome);
        break;
      case "hold":
        if (!(outcome.rereview && this.rereview(key, outcome.question)))
          if (this.hold(key, outcome))
            // Free only when this question was recorded: one another hold
            // stops is asked again, and frees it then.
            markFree(state, outcome.free);
        this.supersede(polled, key);
        break;
      case "repair": {
        delete state.retries[key];
        // The answer that led here is spent: the step never acts on it again.
        delete state.answers[key];
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
          this.close(moot, { how: replan ? "replanned" : "cleared" });
        state.repairs ??= {};
        // A replan starts again: the cleared steps' history goes, and
        // nothing counts against an allowance (`check` included).
        if (replan) {
          for (const cleared of [key, ...outcome.clear])
            delete state.repairs[cleared];
          break;
        }
        if (outcome.rereview) break;
        // Counted against the allowances: past one, the target asks
        // before it runs again (`tick`).
        const repair = state.repairs[outcome.target] ?? {
          count: 0,
          findings: [],
        };
        repair.count += 1;
        repair.findings = [...repair.findings, outcome.finding].slice(-10);
        repair.from = key;
        // Last in key order: the latest repair (status).
        delete state.repairs[outcome.target];
        state.repairs[outcome.target] = repair;
        if (outcome.conflict) countConflict(state, outcome.target);
        markFree(state, outcome.free);
        break;
      }
    }
    this.settle();
  }

  /**
   * A question whose step's worker made no change after the operator's
   * guidance (`rereview`): `revalidate` is answered for it, as the
   * operator's would be, when the workflow takes it there and a result
   * rereview is left, charged here against the live state like an
   * operator's (`answer`). True when answered; else the question is asked,
   * offering `revalidate` where it is taken, so past the allowance its
   * `more` asks as an operator's `revalidate` would.
   */
  private rereview(key: string, question: string): boolean {
    const state = this.state;
    if (!this.workflow.revalidatable?.(state, key)) return false;
    if (!chargeRereview(state)) return false;
    const at = this.now().toISOString();
    state.answers[key] = {
      holdId: `${key}@${at}`,
      question,
      answer: REVALIDATE,
      by: "factory",
      channel: "factory",
      at,
    };
    delete state.retries[key];
    this.afterSave.push(() =>
      this.log.write(state.issue, {
        step: key,
        event: "rereview-kept",
        question: oneLine(question, 300),
      }),
    );
    return true;
  }

  /**
   * A retry: an error counts toward `maxErrors`; a wait is classed by its
   * cause (docs/reference/steps.md#Waits). The error count covers one run of consecutive
   * errors: any other outcome ends it. `since`, `cause`, the backoff and a
   * granted `wait` cover one run of one class (a reset, a gate, or an
   * unknown cause, which errors share): a new class starts them again, so
   * a long gate never spends the transient budget. Times are wall-clock
   * times saved in the state, so a restart doesn't reset a budget and a
   * suspended host doesn't spend it twice: the question comes only after
   * the step ran again and still had to wait. A `holdAfter` asks its own
   * question once its time has passed, whatever the class.
   */
  private retry(
    key: string,
    outcome: Extract<Outcome, { kind: "retry" }>,
  ): void {
    const state = this.state;
    const now = this.now().getTime();
    const wait = outcome.wait;
    const isError = wait?.kind === "error";
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
      outcome.afterMs !== undefined ? now + outcome.afterMs : now + backoff;
    let question: Extract<Outcome, { kind: "hold" }> | undefined;
    const after = outcome.holdAfter;
    // An answer to the step since then (`retry`) starts the clock again,
    // so the step gets the whole time again before it asks.
    const answered = Date.parse(state.answers[key]?.at ?? "");
    const from = Math.max(
      Date.parse(after?.since ?? since),
      Number.isFinite(answered) ? answered : -Infinity,
    );
    if (after && now - from >= after.ms)
      question = {
        ...hold(after.question, after.offers),
        ...(after.scope ? { scope: after.scope } : {}),
      };
    else if (isError) {
      if (count >= this.limits.maxErrors)
        // A step whose input the operator can reject (`Step.redo`
        // `refuse`, an amendment's) offers that way past too.
        question = failure(
          `Step ${key} keeps failing (${outcome.reason}).`,
          this.workflow.steps(state).find((step) => step.key === key)?.redo ===
            "refuse"
            ? ["refuse", "retry", "cancel"]
            : undefined,
        );
    } else if (wait?.kind === "reset") {
      const at = wait.at ? Date.parse(wait.at) : Number.NaN;
      // A reset already past (clock skew) still backs off: never a hot loop.
      if (Number.isFinite(at)) nextAt = Math.max(at, now + backoff);
      if (!granted && !(at - now <= this.limits.maxWaitMs)) {
        // The limit is this provider's: switching to it again can't help.
        // A limit on a provider the Objective doesn't run on (an execution
        // profile's) stays whatever it switches to: only waiting helps.
        const own = this.state.frozen?.config.provider as
          | { planner?: unknown; worker?: { kind?: unknown } }
          | undefined;
        const elsewhere =
          wait.provider !== undefined &&
          own !== undefined &&
          wait.provider !== own.planner &&
          wait.provider !== own.worker?.kind;
        question = {
          ...hold(
            `${outcome.reason}\n\nThe limit resets ${Number.isFinite(at) ? `at ${displayTime(new Date(at).toISOString())}` : "at a time it didn't say"}, more than ${hours(this.limits.maxWaitMs)} away. \`${WAIT}\` keeps waiting until it resets, or cancel.`,
            ["wait", ...(elsewhere ? [] : this.switchOptions(false)), "cancel"],
          ),
          // A limit is the account's, not the step's: one question for all.
          scope: "objective",
        };
      }
    } else if (wait?.kind === "gate") {
      // A human gate (an approval, a required review) isn't Factory's to
      // time out: the display shows it, a reminder follows after
      // `remindAfterMs`, and as long again after that it asks, so the
      // wait shows as needing a person. The step polls on meanwhile, and
      // the question closes once the gate clears (`Hold.polls`). Another
      // Objective's gate (a predecessor) never asks.
      const waited = now - Date.parse(since);
      const asking = state.holds.some(
        (open) => open.polls && open.step === key,
      );
      if (
        wait.human &&
        !granted &&
        !asking &&
        waited >= 2 * this.limits.remindAfterMs
      )
        question = {
          ...hold(
            `Step ${key} has been waiting on ${wait.gate} since ${since}, for more than ${hours(waited)}. Factory carries on by itself once that is done.\n\n\`${WAIT}\` keeps waiting for another ${hours(this.limits.remindAfterMs)}, then asks again; or cancel.`,
            [
              {
                answer: WAIT,
                family: "wait",
                consequence: `Keeps waiting for another ${hours(this.limits.remindAfterMs)}, then asks again.`,
              },
              "cancel",
            ],
          ),
          polls: true,
        };
    } else if (!granted && now - Date.parse(since) >= this.limits.maxWaitMs)
      question = hold(
        `Step ${key} has been retrying since ${since}, for more than ${hours(this.limits.maxWaitMs)}. It began with: ${(previous?.cause ?? outcome.reason).slice(0, 500)}\n\nLast error: ${outcome.reason.slice(0, 500)}\n\n\`${WAIT}\` keeps retrying for another ${hours(this.limits.maxWaitMs)}; \`retry\` tries again now; or cancel.`,
        [
          {
            answer: WAIT,
            family: "wait",
            consequence: `Keeps retrying for another ${hours(this.limits.maxWaitMs)}.`,
          },
          {
            answer: "retry",
            family: "retry",
            consequence: "Tries the step again now.",
          },
          "cancel",
        ],
      );
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
    if (question) this.hold(key, question);
  }

  /**
   * The service died while the attempts of run `run` ran (`serve`): each
   * counts the death, after the first only when the run finished a step
   * (`progressed`), so the count is the deaths in a row the attempt ran at
   * with other steps finishing between. At SUSPECT_CRASHES its step asks
   * before it runs again (`tick`); cleanup after the end never asks: the
   * crash loop's delay covers it. Returns the attempts that reached it.
   */
  interrupted(run: string, progressed: boolean): number {
    const hit = Object.values(this.state.attempts).filter(
      (attempt) => attempt.run === run,
    );
    if (!hit.length) return 0;
    this.transact(() => {
      for (const attempt of hit)
        attempt.interrupted = progressed ? (attempt.interrupted ?? 0) + 1 : 1;
    });
    return hit.filter(
      (attempt) => (attempt.interrupted ?? 0) >= SUSPECT_CRASHES,
    ).length;
  }

  /** Hold the step the service kept dying under (`interrupted`), with `retry` and `cancel`. */
  private suspect(key: string, deaths: number): void {
    const others = (this.run.suspects ?? 1) - 1;
    this.transact(() => {
      delete this.state.attempts[key];
      this.hold(
        key,
        failure(
          `The service died ${deaths} times in a row while step ${key} ran, and other steps finished in between, so this step may be what stops it (for example, by running the host out of memory).${others > 0 ? ` ${others} other step${others > 1 ? "s" : ""} ran at every one of those deaths too, and each holds with a question like this one.` : ""} \`retry\` runs it again; or cancel.`,
        ),
      );
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
  stop(): Promise<void> {
    this.stopped = true;
    this.abort([...this.running.keys()], "replaced");
    // Each ends by its deadline at the latest; so do the steps of the runs
    // this one replaced, which a run that replaces it waits for too.
    return Promise.allSettled([
      ...this.inFlight,
      this.pending ?? Promise.resolve(),
    ]).then(() => undefined);
  }

  /**
   * Open a question, on the step's Work Item, or on the Objective (any
   * other step's, or one `scope` makes the Objective's). One question is
   * open per scope. A step that asks while a question covering its scope
   * is open (the Objective's, or its item's) can't run until that one is
   * answered, and then must not wait longer to ask: its retry comes due at
   * once, so it runs again right after the answer and asks then (an
   * Objective-wide cause the answer fixed asks nothing). A failure offers
   * `replan` where the workflow can plan again.
   */
  private hold(
    key: string,
    asked: Omit<Extract<Outcome, { kind: "hold" }>, "kind" | "keep">,
  ): boolean {
    const state = this.state;
    const now = this.now().toISOString();
    const { question, scope } = asked;
    const cause = asked.cause ?? "question";
    const item = scope === "objective" ? undefined : itemOf(key);
    const open = state.holds.find(
      (hold) =>
        hold.item === undefined || (item !== undefined && hold.item === item),
    );
    if (open && open.step !== key) {
      const retry = state.retries[key];
      if (retry) retry.nextAt = now;
      return false;
    }
    // A bare `switch` is one option per configured provider; cancel always
    // works, and a failure offers replan where the workflow can plan again.
    let switchRecommended = false;
    const options = asked.options.flatMap((option) => {
      if (option.answer !== SWITCH || option.arg !== undefined) return [option];
      switchRecommended ||= option.recommended === true;
      return this.switchOptions(true);
    });
    if (!options.some((option) => option.answer === "cancel"))
      options.push(common("cancel"));
    if (
      cause === "failure" &&
      !options.some((option) => option.answer === REPLAN) &&
      this.workflow.replannable?.(state, key)
    )
      options.splice(
        options.findIndex((option) => option.answer === "cancel"),
        0,
        common(REPLAN),
      );
    // A Work Item's question offers a fresh start where the workflow can
    // give one; not an allowance's question, whose way past is `more`.
    if (
      item !== undefined &&
      !options.some(
        (option) => option.answer === FRESH || option.answer === MORE,
      ) &&
      this.workflow.freshable?.(state, key)
    )
      options.splice(
        options.findIndex((option) => option.answer === "cancel"),
        0,
        common(FRESH),
      );
    // So does a result rereview, where the item has a refused result.
    if (
      item !== undefined &&
      !options.some(
        (option) => option.answer === REVALIDATE || option.answer === MORE,
      ) &&
      this.workflow.revalidatable?.(state, key)
    )
      options.splice(
        options.findIndex((option) => option.answer === "cancel"),
        0,
        common(REVALIDATE),
      );
    // Its text is the engine's too, written where it is offered, so a
    // question never names `revalidate` without taking it (#2120).
    const rereview =
      options.some((option) => option.answer === REVALIDATE) &&
      this.workflow.revalidatable?.(state, key) === true;
    // A recommended `switch` with several targets recommends this
    // Objective's own provider (re-freeze), else the next other answer:
    // never an arbitrary provider.
    const switching = options.filter((option) => option.answer === SWITCH);
    const chosen = !switchRecommended
      ? undefined
      : switching.length === 1
        ? switching[0]
        : (switching.find((option) => option.arg === state.frozen?.provider) ??
          options.find((option) => option.answer !== SWITCH));
    // The question names the switch answers from the options themselves,
    // so the two can't disagree.
    const named = switching.map(
      (option) => `\`${answerForm(option)}\`: ${option.consequence}`,
    );
    const id = `${key}@${now}`;
    // The step's earlier question, asked again: its comment says so.
    if (open)
      recordClosed(state, open, { how: "superseded", at: now, next: id });
    // Logged once saved, so the log never shows a question the state lost.
    this.afterSave.push(() =>
      this.log.write(state.issue, {
        step: key,
        event: "hold",
        id,
        cause,
        question: oneLine(question, 300),
      }),
    );
    state.holds = [
      ...state.holds.filter((hold) => hold !== open),
      {
        id,
        step: key,
        ...(item !== undefined ? { item } : {}),
        question: [
          question,
          ...(rereview ? [rereviewNote(state)] : []),
          ...(named.length ? [named.join(" ")] : []),
          ...deadlineNote(state.deadline, this.now()),
        ].join("\n\n"),
        options: recommend(
          options.map((option) =>
            option === chosen ? { ...option, recommended: true } : option,
          ),
        ),
        cause,
        askedAt: now,
        ...(asked.polls ? { polls: true as const } : {}),
      },
    ];
    state.status = "holding";
    return true;
  }

  /**
   * Question `id`'s issue comment now shows it, since `at` by GitHub's
   * clock, in the short form or naming its id (github-sync `ask`), at
   * `url`. A question closed meanwhile was still shown: it counts for
   * `lastShownAt`.
   */
  shown(id: string, at: string, shortForm: boolean, url?: string): void {
    const hold = this.state.holds.find((open) => open.id === id);
    if (hold) {
      hold.shownAt = at;
      if (shortForm) hold.shortForm = true;
      else delete hold.shortForm;
      if (url) hold.url = url;
    }
    // Closed meanwhile: its closing links the comment too.
    const closed = this.state.closedHolds?.find((entry) => entry.id === id);
    if (closed && url) closed.url = url;
    if (!(Date.parse(this.state.lastShownAt ?? "") >= Date.parse(at)))
      this.state.lastShownAt = at;
  }

  /**
   * Closed question `id`'s comment shows its closing (github-sync
   * `closings`), had none to edit, or was given up on: its question and
   * options, kept for that edit, go, and the shown ones past CLOSED_KEPT
   * with them (`keptClosings`).
   */
  closingShown(id: string): void {
    const closed = this.state.closedHolds?.find((entry) => entry.id === id);
    if (!closed) return;
    closed.shown = true;
    delete closed.question;
    delete closed.options;
    this.state.closedHolds = keptClosings(this.state.closedHolds!);
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
    /** The option's argument (`switch NAME`), passed apart from the text. */
    arg?: string,
    /** How it came and on whose behalf (`AnsweredVia`); absent: the CLI. */
    via: AnsweredVia = { channel: "cli" },
  ): RequestResult | null {
    if (answer === "cancel") return this.cancel(by, via);
    const finished = this.finishedRefusal();
    if (finished) return finished;
    const issue = this.state.issue;
    const holds = this.state.holds;
    if (!holds.length)
      return question === undefined
        ? refused("no_open_question", `#${issue} has no open question.`)
        : refused(
            "stale_question",
            `#${issue}'s question ${question} was already answered, and no question is open now.`,
          );
    if (question === undefined) {
      const why = unboundRefusal(holds, this.state.lastShownAt, writtenAt);
      if (why)
        return refused(
          "question_required",
          `That answer names no question, and ${why}, so it wasn't applied. ${openQuestions(issue, holds)}`,
        );
    }
    const hold =
      question === undefined
        ? holds[0]!
        : holds.find((open) => open.id === question);
    if (!hold)
      return refused(
        "stale_question",
        `#${issue}'s question ${question} isn't open, so that answer wasn't applied. ${openQuestions(issue, holds)}`,
      );
    const offered = hold.options.filter((option) => option.answer === answer);
    if (!offered.length)
      return refused(
        "invalid_answer",
        `"${answer}" isn't an answer to question ${hold.id}. Answers: ${answersOf(hold).join(", ")}.`,
      );
    // An answer with an argument names its option: the CLI passes it apart
    // from the text; a comment writes it first (`/factory switch NAME`).
    let note = text;
    let option = offered[0]!;
    if (offered.some((one) => one.arg !== undefined)) {
      const first = text?.trim().split(/\s+/)[0];
      const named =
        arg !== undefined
          ? offered.find((one) => one.arg === arg)
          : (offered.find((one) => one.arg === first) ??
            (offered.length === 1 ? offered[0] : undefined));
      if (!named)
        return refused(
          "invalid_answer",
          `Name one: ${offered.map((one) => `\`${answerForm(one)}\``).join(", ")}.`,
        );
      option = named;
      if (arg === undefined && first !== undefined && named.arg === first)
        note = text?.trim().slice(first.length).trim() || undefined;
    }
    if (text !== undefined && Buffer.byteLength(text) > MAX_ANSWER_TEXT)
      return refused(
        "invalid_answer",
        `That answer's text is ${Buffer.byteLength(text)} bytes; an answer's text is at most ${MAX_ANSWER_TEXT}.`,
      );
    if (option.needsText && !note?.trim())
      return refused(
        "invalid_answer",
        `\`${answer}\` needs text after it, for example \`/factory ${answer} <your text>\`.`,
      );
    // An answer that gives several of the hold's answers at once: all it
    // covers, with its text, or the list its text is, checked here so a
    // list that doesn't fit is refused before the question closes.
    let parts: AnswerPart[] | undefined;
    if (option.covers)
      parts = option.covers.map((covered) => ({
        answer,
        arg: covered,
        ...(note ? { text: note } : {}),
      }));
    else if (option.list) {
      const listed = answerList(note ?? "", hold.options);
      if (typeof listed === "string")
        return refused(
          "invalid_answer",
          `${listed} So that answer wasn't applied.`,
        );
      parts = listed;
    }
    let frozen: Frozen | undefined;
    if (answer === SWITCH) {
      const provider = option.arg!;
      const live = this.workflow.freezable?.[provider];
      if (!live)
        return refused(
          "invalid_answer",
          `Provider ${provider} isn't configured now, so there is nothing to switch to. Answers: ${hold.options.map((one) => answerForm(one)).join(", ")}.`,
        );
      // Its items would fail on a configuration without their profiles.
      const lacking = profilesLacking(this.state, live.config);
      if (lacking.length)
        return refused(
          "invalid_answer",
          `Provider ${provider}'s configuration doesn't name execution profile${lacking.length === 1 ? "" : "s"} ${lacking.join(", ")}, which this Objective's plan runs on, so switching to it would fail. Answers: ${hold.options.map((one) => answerForm(one)).join(", ")}.`,
        );
      frozen = { ...structuredClone(live), provider, selectedBy: "switch" };
    } else if (answer === ADOPT) {
      const current = this.state.frozen;
      const live = current && this.workflow.freezable?.[current.provider];
      if (!current || !live)
        return refused(
          "invalid_answer",
          `This Objective's provider "${current?.provider}" isn't configured, so there is nothing to adopt. Answers: ${answersOf(hold).join(", ")}.`,
        );
      if (live.digest !== this.state.kept[ADOPTS]) {
        // The configuration changed again after the question named it:
        // its step asks again, naming the changes as they are now.
        this.close(hold, { how: "asked-again" });
        delete this.state.kept[ADOPTS];
        this.settle();
        return refused(
          "stale_question",
          `#${issue}'s configuration changed again after question ${hold.id} named it, so adopt wasn't applied; the question is asked again with the current changes.`,
        );
      }
      frozen = { ...current, ...structuredClone(live) };
    }
    const delivery = frozen && deliveryChange(this.state, frozen.config);
    if (delivery)
      return refused(
        "invalid_answer",
        `\`${answerForm(option)}\` would deliver this Objective with delivery.kind "${delivery.now}", but its plan is split for "${delivery.was}". To deliver it with "${delivery.now}", cancel it and queue it again. Answers: ${answersOf(hold).join(", ")}.`,
      );
    // `more` to an allowance question is the engine's; any other is the step's.
    const granting =
      answer === MORE ? askedFor(this.state, hold.id) : undefined;
    const given = granting === "rereviews" ? REVALIDATE : answer;
    const retry = this.state.retries[hold.step];
    const who = {
      by,
      ...(via.as ? { as: via.as } : {}),
      channel: via.channel,
    };
    this.close(hold, {
      how: "answered",
      answer,
      ...(option.arg !== undefined ? { arg: option.arg } : {}),
      ...(note ? { text: note } : {}),
      ...(parts ? { parts } : {}),
      ...who,
      ...(via.comment ? { comment: via.comment } : {}),
    });
    if (answer === WAIT && retry) {
      // A limit is the account's: waiting for it is every step's answer.
      for (const other of Object.values(this.state.retries))
        if (other === retry || sameLimit(retry, other)) this.grant(other);
    } else {
      if (frozen) {
        // The Objective runs on this configuration for the rest of its
        // run; after a switch, every step waiting on a provider's limit
        // runs now, on the new provider.
        this.state.frozen = frozen;
        delete this.state.kept[ADOPTS];
        if (answer === SWITCH)
          for (const [key, other] of Object.entries(this.state.retries))
            if (other.wait?.kind === "reset" && other.wait.provider)
              delete this.state.retries[key];
      } else if (granting === "repairs") grantOverrun(this.state, hold.step);
      else if (granting === "spend") grantSpend(this.state, this.today());
      else {
        // A rereview's `more` grants and revalidates. Each `revalidate` is
        // charged here, against the live state, so two at once can't both
        // pass the allowance; past it, the step asks instead.
        if (granting === "rereviews") grantRereviews(this.state);
        if (given === REVALIDATE && !chargeRereview(this.state)) {
          this.hold(
            hold.step,
            failure(rereviewQuestion(this.state, hold.step), [
              {
                answer: MORE,
                family: "retry",
                consequence:
                  "Allows as much again of result rereviews, and checks this result again.",
              },
              "cancel",
            ]),
          );
          const question = this.state.holds.at(-1);
          if (question?.step === hold.step)
            asked(this.state, question.id, "rereviews");
          delete this.state.retries[hold.step];
          this.settle();
          return null;
        }
        this.state.answers[hold.step] = {
          holdId: hold.id,
          question: hold.question,
          answer: given,
          ...(option.arg !== undefined ? { arg: option.arg } : {}),
          ...(note ? { text: note } : {}),
          ...(parts ? { parts } : {}),
          ...who,
          at: this.now().toISOString(),
        };
      }
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
   * now, or until another open question that stops it too was asked, or
   * the service's wait (`waitOn`) began, if earlier (that one's end pauses
   * the rest). Only steps the question stopped pause: an item's question
   * leaves other items' clocks running, and a step with an open attempt
   * was running, not stopped. Budgets and the status note count only time
   * a step could run.
   * A human gate's `since` stays: its reminder (github-sync note) is keyed
   * to the original start, so moving it would post the reminder again,
   * and its question is timed from it (a granted `wait` puts it off).
   */
  private close(hold: Hold, closing: Omit<HoldClosing, "at">): void {
    this.state.holds = this.state.holds.filter((open) => open !== hold);
    recordClosed(this.state, hold, {
      ...closing,
      at: this.now().toISOString(),
    });
    this.pause(
      Date.parse(hold.askedAt),
      (key) => key !== hold.step && this.stops(hold, key),
    );
  }

  /**
   * Human gate questions `ids` of step `key`, closed as `superseded` when
   * the step asked instead (`applyChange`): each names the question asked
   * in its place, or, when none was (another open question stops the step,
   * or the engine answered it itself), says the step moved on.
   */
  private supersede(ids: string[], key: string): void {
    const asked = this.state.holds.find((open) => open.step === key);
    for (const id of ids) {
      const closed = this.state.closedHolds?.find((entry) => entry.id === id);
      if (closed?.closed.how !== "superseded") continue;
      if (asked) closed.closed.next = asked.id;
      else closed.closed.how = "moved-on";
    }
  }

  /**
   * The service imposes a wait (service.ts: another Objective's owned
   * paths) on the steps `stops` names, from the first call until `waited`.
   * It is timed in memory, so a restart counts the wait before it.
   */
  waitOn(stops: (key: string) => boolean): void {
    this.imposed ??= { since: this.now().getTime(), stops };
  }

  /**
   * The service's wait has ended: the steps it stopped pause their wait
   * clocks for it, as a closed question's do.
   */
  waited(): void {
    const imposed = this.imposed;
    if (!imposed) return;
    this.imposed = undefined;
    this.transact(() => this.pause(imposed.since, imposed.stops));
  }

  /** Whether an open question or the service's wait stops step `key`. */
  blocked(key: string): boolean {
    return this.heldBy(key) !== undefined || !!this.imposed?.stops(key);
  }

  /**
   * Pause the wait clocks of the `stopped` steps (but a human gate's, and
   * one with an open attempt) from `from`, or when each was due if later,
   * until now, or until an open question or the service's wait that stops
   * it too began, if earlier.
   */
  private pause(from: number, stopped: (key: string) => boolean): void {
    const now = this.now().getTime();
    for (const [key, retry] of Object.entries(this.state.retries)) {
      if (retry.wait?.kind === "gate" || this.state.attempts[key]) continue;
      if (!stopped(key)) continue;
      const until = Math.min(
        now,
        ...this.state.holds
          .filter((open) => this.stops(open, key))
          .map((open) => Date.parse(open.askedAt)),
        ...(this.imposed?.stops(key) ? [this.imposed.since] : []),
      );
      const paused = until - Math.max(from, Date.parse(retry.nextAt));
      if (!(paused > 0)) continue;
      const later = (at: string) =>
        new Date(Date.parse(at) + paused).toISOString();
      retry.since = later(retry.since);
      if (retry.grantedUntil) retry.grantedUntil = later(retry.grantedUntil);
    }
  }

  /**
   * One `switch` option per configured provider; with `own`, this
   * Objective's provider too, which re-freezes it to its configuration as
   * it is now (a model fixed, then the service restarted).
   */
  private switchOptions(own: boolean): HoldOption[] {
    const current = this.state.frozen?.provider;
    return Object.keys(this.workflow.freezable ?? {})
      .filter((name) => own || name !== current)
      .map((name) => ({
        answer: SWITCH,
        family: "switch",
        arg: name,
        consequence:
          name === current
            ? `Re-freezes provider ${name} to its current configuration.`
            : `Runs this Objective on provider ${name} from now on.`,
      }));
  }

  /**
   * `wait`: keep waiting without asking, until a known reset (and the
   * usual budget after it), for `remindAfterMs` (a day) on a limit with no
   * reset time or on a human gate, or for another `maxWaitMs` on a
   * transient cause.
   */
  private grant(retry: Retry): void {
    const now = this.now().getTime();
    const reset = retry.wait?.kind === "reset";
    const daily = reset || retry.wait?.kind === "gate";
    const at =
      reset && retry.wait?.kind === "reset" && retry.wait.at
        ? Math.max(Date.parse(retry.wait.at), now)
        : Number.NaN;
    retry.grantedUntil = new Date(
      Number.isFinite(at)
        ? at + this.limits.maxWaitMs
        : now + (daily ? this.limits.remindAfterMs : this.limits.maxWaitMs),
    ).toISOString();
    retry.nextAt = new Date(Number.isFinite(at) ? at : now).toISOString();
  }

  /**
   * Cancel at the Objective's deadline (`state.deadline`), through the
   * normal cancel, so cleanup runs. The deadline is absolute: an open
   * question, a pause, a human gate or a wait for a slot doesn't stop it,
   * so the service calls this every tick for every Objective, and a
   * restart past it cancels at once. A reset's rebuild finishes first, and
   * a withdrawal goes as if never admitted. Returns whether it cancelled.
   */
  expire(): boolean {
    const { deadline, status, withdrawing } = this.state;
    if (
      deadline === undefined ||
      withdrawing ||
      status === "resetting" ||
      TERMINAL.includes(status) ||
      this.now().getTime() < Date.parse(deadline)
    )
      return false;
    crashPoint("engine:deadline:before-cancel");
    this.transact(() => this.cancel(DEADLINE));
    crashPoint("engine:deadline:cancelled");
    return true;
  }

  /**
   * Cancel at once: stop running steps and mark the Objective cancelled.
   * Cleanup steps follow. A finished Objective stays as it is.
   */
  cancel(by: string, via?: AnsweredVia): RequestResult | null {
    if (this.state.status === "cancelled") return null;
    const finished = this.finishedRefusal();
    if (finished) return finished;
    this.state.status = "cancelled";
    // Each open question closes with the Objective: its comment says who
    // cancelled. A reset that hasn't landed keeps the old state's open
    // questions aside (reset.ts `closedByReset` closes them when it lands,
    // which a cancel replaces): they close here too.
    const resetting = this.state.kept?.[RESET_KEY] as
      | { old?: Pick<ObjectiveState, "holds"> }
      | undefined;
    for (const open of [...this.state.holds, ...(resetting?.old?.holds ?? [])])
      recordClosed(this.state, open, {
        how: "cancelled",
        at: this.now().toISOString(),
        by,
        ...(via?.as ? { as: via.as } : {}),
        ...(via ? { channel: via.channel } : {}),
        ...(via?.comment ? { comment: via.comment } : {}),
      });
    this.state.holds = [];
    this.state.attempts = {};
    this.state.retries = {};
    this.state.ended = { at: this.now().toISOString(), by };
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
  retryNow(
    by: string,
    question?: string,
    via?: AnsweredVia,
  ): RequestResult | null {
    const finished = this.finishedRefusal();
    if (finished) return finished;
    const issue = this.state.issue;
    const holds = this.state.holds;
    if (question !== undefined) {
      const hold = holds.find((open) => open.id === question);
      if (hold && !answersOf(hold).includes("retry"))
        return refused(
          "invalid_answer",
          `#${issue}'s question ${hold.id} has no retry answer. Answers: ${answersOf(hold).join(", ")}.`,
        );
      return this.answer(
        "retry",
        undefined,
        by,
        undefined,
        question,
        undefined,
        via,
      );
    }
    if (holds.some((hold) => hold.item === undefined))
      return refused(
        "question_required",
        `#${issue} has an open question that stops every step, so retry must name it. ${openQuestions(issue, holds)}`,
      );
    const waiting = Object.entries(this.state.retries).filter(
      ([key]) => !this.heldBy(key),
    );
    if (holds.length && !waiting.length)
      return refused(
        "question_required",
        `#${issue}'s waiting steps all wait on an open question, so retry must name it. ${openQuestions(issue, holds)}`,
      );
    for (const [, retry] of waiting) retry.nextAt = this.now().toISOString();
    return null;
  }

  /** The refusal for a finished Objective: only re-queuing runs it again. */
  private finishedRefusal(): RequestResult | null {
    const status = this.state.status;
    return status === "done"
      ? refused(
          "objective_finished",
          `#${this.state.issue} has already finished (${status}).`,
        )
      : null;
  }

  private save(): void {
    this.state.updatedAt = this.now().toISOString();
    if (TERMINAL.includes(this.state.status) && !this.state.ended)
      this.state.ended = { at: this.state.updatedAt };
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
    ? `Open questions: ${holds.map((hold) => `${hold.id} (${answersOf(hold).join(", ")})`).join("; ")}. Name one: \`factory answer ${issue} <answer> --question <id>\`, or comment \`/factory <answer> --question <id>\`.`
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
  return !wait || wait.kind === "error" ? "unknown" : wait.kind;
}

/**
 * Terminal, with nothing left to run: cleanup after cancel is done and no
 * step runs (`busy`; on disk, an open attempt).
 */
export function settled(
  state: ObjectiveState,
  workflow: Workflow,
  busy = Object.keys(state.attempts).length > 0,
): boolean {
  return (
    TERMINAL.includes(state.status) &&
    !busy &&
    workflow.steps(state).length === 0
  );
}

/** A question asked within the last hour before the deadline says so. */
function deadlineNote(deadline: string | undefined, now: Date): string[] {
  const left = Date.parse(deadline ?? "") - now.getTime();
  return left >= 0 && left <= HOUR
    ? [
        `This Objective's deadline is ${displayTime(deadline!)}, ${duration(left)} from now: Factory cancels it then, answered or not.`,
      ]
    : [];
}

function hours(ms: number): string {
  const h = ms / (60 * 60 * 1000);
  return h >= 1 ? `${Number(h.toFixed(1))} h` : `${Math.round(ms / 1000)} s`;
}

/** Repair `free.repair` of `free.target` counts against no allowance (allowances.ts `charged`). */
function markFree(
  state: ObjectiveState,
  free: { target: string; repair: number } | undefined,
): void {
  const blamed = free ? state.repairs?.[free.target] : undefined;
  if (free && blamed && !blamed.free?.includes(free.repair))
    blamed.free = [...(blamed.free ?? []), free.repair];
}
