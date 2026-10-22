import { crashPoint } from "./crash.js";
import type { RunLog } from "./log.js";
import {
  type Answer,
  type ObjectiveState,
  type ObjectiveStatus,
  saveState,
  TERMINAL,
} from "./state.js";

/** What a step reports. Every step ends in exactly one of these. */
export type Outcome =
  | { kind: "done"; result?: unknown }
  /** Transient: network, 5xx, rate or usage limit, overload. */
  | { kind: "retry"; reason: string; afterMs?: number }
  | {
      kind: "hold";
      question: string;
      answers: string[];
      recommended: string;
    }
  /** The step can't succeed as planned. */
  | { kind: "fail"; reason: string };

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
  run(context: StepContext): Promise<Outcome>;
}

/** What to do next. Both functions are pure functions of the state. */
export interface Workflow {
  steps(state: ObjectiveState): Step[];
  /** The status of a state that isn't holding or terminal. */
  status(state: ObjectiveState): ObjectiveStatus;
}

export interface EngineLimits {
  /** Escaped errors and missed deadlines in a row before a step holds. */
  maxErrors: number;
  /** How long transient retries may go on before the step holds. */
  maxRetryMs: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
  /** Steps running at once for one Objective. */
  concurrency: number;
}

export const DEFAULT_LIMITS: EngineLimits = {
  maxErrors: 3,
  maxRetryMs: 6 * 60 * 60 * 1000,
  baseBackoffMs: 30_000,
  maxBackoffMs: 15 * 60 * 1000,
  concurrency: 2,
};

export const ERROR_ANSWERS = ["retry", "cancel"];

interface Running {
  token: number;
  controller: AbortController;
}

const INTERRUPTED = "the service stopped during this step";

/**
 * Runs one Objective's steps. All state changes happen here, synchronously,
 * one at a time, and each is saved before the next begins. A step's start is
 * saved too, so a step that never finishes (because the process died) counts
 * as an error after a restart and holds after `maxErrors`.
 */
export class ObjectiveRunner {
  private readonly running = new Map<string, Running>();
  private nextToken = 1;

  constructor(
    public state: ObjectiveState,
    private readonly workflow: Workflow,
    private readonly dir: string,
    private readonly log: RunLog,
    private readonly limits: EngineLimits = DEFAULT_LIMITS,
    private readonly now: () => Date = () => new Date(),
  ) {}

  get busy(): boolean {
    return this.running.size > 0;
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
    const before = structuredClone(this.state);
    try {
      const result = change();
      this.save();
      return result;
    } catch (error) {
      this.state = before;
      throw error;
    }
  }

  /** Start every runnable step that isn't running or waiting to retry. */
  tick(): void {
    // An attempt saved as started but not running here was interrupted:
    // by a restart, or by a save that failed after the step finished.
    for (const key of Object.keys(this.state.attempts))
      if (!this.running.has(key))
        this.apply(key, { kind: "retry", reason: INTERRUPTED, afterMs: -1 });
    if (this.state.status === "holding") return;
    const now = this.now().getTime();
    for (const step of this.workflow.steps(this.state)) {
      if (this.running.size >= this.limits.concurrency) return;
      if (this.running.has(step.key)) continue;
      const retry = this.state.retries[step.key];
      if (retry && Date.parse(retry.nextAt) > now) continue;
      this.start(step);
    }
  }

  private start(step: Step): void {
    this.transact(() => {
      this.state.attempts[step.key] = { startedAt: this.now().toISOString() };
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
      timer = setTimeout(() => {
        controller.abort(new Error("deadline"));
        resolve({ kind: "retry", reason: "deadline", afterMs: -1 });
      }, step.deadlineMs);
    });
    const run = (async () => step.run(context))().catch(
      (error: unknown): Outcome => ({
        kind: "retry",
        reason: `error: ${error instanceof Error ? error.message : String(error)}`,
        afterMs: -1,
      }),
    );
    void Promise.race([run, deadline]).then((outcome) => {
      clearTimeout(timer);
      if (this.running.get(step.key)?.token !== token) return;
      this.running.delete(step.key);
      try {
        this.apply(step.key, outcome);
      } catch (error) {
        // The save failed and the state went back to disk, where the
        // attempt is still open: the next tick retries it as interrupted.
        this.log.write(this.state.issue, {
          step: step.key,
          event: "apply-failed",
          error: String(error),
        });
      }
    });
  }

  /**
   * Apply one outcome and save. `afterMs: -1` marks an escaped error, missed
   * deadline or interrupted attempt, which counts toward `maxErrors`; other
   * retries count toward `maxRetryMs`. Throws only if the save fails, after
   * putting the state back as it is on disk.
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
    switch (outcome.kind) {
      case "done":
        state.done[key] = outcome.result ?? true;
        delete state.retries[key];
        delete state.answers[key];
        if (TERMINAL.includes(state.status)) break;
        // Another step's question may be open: keep holding, and resume
        // to the status this step's progress gives.
        if (state.status === "holding")
          state.resumeStatus = this.workflow.status(state);
        else state.status = this.workflow.status(state);
        break;
      case "retry": {
        const previous = state.retries[key];
        const isError = outcome.afterMs === -1;
        const count = (previous?.count ?? 0) + (isError ? 1 : 0);
        const attempts = (previous?.attempts ?? 0) + 1;
        const since = previous?.since ?? now.toISOString();
        const exhausted = isError
          ? count >= this.limits.maxErrors
          : now.getTime() - Date.parse(since) >= this.limits.maxRetryMs;
        if (exhausted) {
          this.hold(
            key,
            `Step ${key} keeps failing (${outcome.reason}).`,
            ERROR_ANSWERS,
            "retry",
          );
          break;
        }
        const backoff =
          outcome.afterMs !== undefined && outcome.afterMs >= 0
            ? Math.min(outcome.afterMs, this.limits.maxRetryMs)
            : Math.min(
                this.limits.baseBackoffMs * 2 ** (attempts - 1),
                this.limits.maxBackoffMs,
              );
        state.retries[key] = {
          count,
          attempts,
          since,
          nextAt: new Date(now.getTime() + backoff).toISOString(),
          lastError: outcome.reason,
        };
        break;
      }
      case "hold":
        this.hold(key, outcome.question, outcome.answers, outcome.recommended);
        break;
      case "fail":
        this.hold(
          key,
          `Step ${key} failed: ${outcome.reason}`,
          ERROR_ANSWERS,
          "retry",
        );
        break;
    }
  }

  /**
   * Open a question. One question is open at a time: a second step that
   * asks while another question is open runs again after the answer, and
   * asks then.
   */
  private hold(
    key: string,
    question: string,
    answers: string[],
    recommended: string,
  ): void {
    const state = this.state;
    const now = this.now().toISOString();
    if (state.hold && state.hold.step !== key) {
      state.retries[key] = {
        count: state.retries[key]?.count ?? 0,
        attempts: state.retries[key]?.attempts ?? 0,
        since: state.retries[key]?.since ?? now,
        nextAt: now,
        lastError: "waiting for the open question",
      };
      return;
    }
    const all = answers.includes("cancel") ? answers : [...answers, "cancel"];
    state.hold = {
      id: `${key}@${now}`,
      step: key,
      question,
      answers: all,
      recommended: all.includes(recommended) ? recommended : all[0]!,
      askedAt: now,
    };
    if (state.status !== "holding") state.resumeStatus = state.status;
    state.status = "holding";
  }

  /**
   * Answer the open question. Returns null when applied, or the reason it
   * doesn't fit. The caller saves (see `transact`).
   */
  answer(answer: string, text: string | undefined, by: string): string | null {
    if (answer === "cancel") return this.cancel(by);
    const hold = this.state.hold;
    if (!hold) return `#${this.state.issue} has no open question.`;
    if (!hold.answers.includes(answer))
      return `"${answer}" isn't an answer to this question. Answers: ${hold.answers.join(", ")}.`;
    this.state.answers[hold.step] = {
      holdId: hold.id,
      answer,
      ...(text ? { text } : {}),
      by,
      at: this.now().toISOString(),
    };
    delete this.state.retries[hold.step];
    this.state.hold = null;
    this.state.status =
      this.state.resumeStatus ?? this.workflow.status(this.state);
    delete this.state.resumeStatus;
    return null;
  }

  /**
   * Cancel at once: stop running steps and mark the Objective cancelled.
   * Cleanup steps follow. A finished Objective stays as it is.
   */
  cancel(by: string): string | null {
    const status = this.state.status;
    if (status === "done" || status === "failed")
      return `#${this.state.issue} has already finished (${status}).`;
    for (const { controller } of this.running.values())
      controller.abort(new Error("cancelled"));
    this.running.clear();
    if (status === "cancelled") return null;
    this.state.status = "cancelled";
    this.state.hold = null;
    this.state.attempts = {};
    delete this.state.resumeStatus;
    this.state.answers.cancel = {
      holdId: "",
      answer: "cancel",
      by,
      at: this.now().toISOString(),
    };
    this.log.write(this.state.issue, { event: "cancelled", by });
    return null;
  }

  /** Run waiting steps now, or answer `retry` to an open question that offers it. */
  retryNow(by: string): string | null {
    const hold = this.state.hold;
    if (hold) {
      if (!hold.answers.includes("retry"))
        return `#${this.state.issue}'s open question has no retry answer. Answers: ${hold.answers.join(", ")}.`;
      return this.answer("retry", undefined, by);
    }
    for (const retry of Object.values(this.state.retries))
      retry.nextAt = this.now().toISOString();
    return null;
  }

  private save(): void {
    this.state.updatedAt = this.now().toISOString();
    saveState(this.dir, this.state);
  }
}
