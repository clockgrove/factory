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

/**
 * Runs one Objective's steps. All state changes happen here, synchronously,
 * one at a time, and each is saved before the next begins.
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

  /** True while the Objective takes a slot: not holding and not terminal, or still cleaning up. */
  get active(): boolean {
    if (this.state.status === "holding") return false;
    if (TERMINAL.includes(this.state.status))
      return this.busy || this.workflow.steps(this.state).length > 0;
    return true;
  }

  /** Start every runnable step that isn't running or waiting to retry. */
  tick(): void {
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
      if (controller.signal.aborted && outcome.kind !== "retry") return;
      this.apply(step.key, outcome);
    });
  }

  /**
   * Apply one outcome. `afterMs: -1` marks an escaped error or missed
   * deadline, which counts toward `maxErrors`; other retries count toward
   * `maxRetryMs`.
   */
  apply(key: string, outcome: Outcome): void {
    if (TERMINAL.includes(this.state.status) && outcome.kind !== "done") {
      this.log.write(this.state.issue, {
        step: key,
        event: "ignored",
        outcome: outcome.kind,
      });
      return;
    }
    const state = this.state;
    const now = this.now();
    crashPoint(`engine:${key}:before-apply`);
    switch (outcome.kind) {
      case "done":
        state.done[key] = outcome.result ?? true;
        delete state.retries[key];
        delete state.answers[key];
        if (!TERMINAL.includes(state.status))
          state.status = this.workflow.status(state);
        break;
      case "retry": {
        const previous = state.retries[key];
        const isError = outcome.afterMs === -1;
        const count = (previous?.count ?? 0) + (isError ? 1 : 0);
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
            ? outcome.afterMs
            : Math.min(
                this.limits.baseBackoffMs * 2 ** Math.max(0, count - 1),
                this.limits.maxBackoffMs,
              );
        state.retries[key] = {
          count,
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
    this.save();
    this.log.write(state.issue, {
      step: key,
      event: "outcome",
      outcome: outcome.kind,
      ...("reason" in outcome ? { reason: outcome.reason } : {}),
    });
    crashPoint(`engine:${key}:applied`);
  }

  private hold(
    key: string,
    question: string,
    answers: string[],
    recommended: string,
  ): void {
    const state = this.state;
    const all = answers.includes("cancel") ? answers : [...answers, "cancel"];
    state.hold = {
      id: `${key}@${this.now().toISOString()}`,
      step: key,
      question,
      answers: all,
      recommended: all.includes(recommended) ? recommended : all[0]!,
      askedAt: this.now().toISOString(),
    };
    if (state.status !== "holding") state.resumeStatus = state.status;
    state.status = "holding";
  }

  /** Answer the open hold. Returns an error message when the answer doesn't fit. */
  answer(answer: string, text: string | undefined, by: string): string | null {
    const hold = this.state.hold;
    if (answer === "cancel") {
      this.cancel(by);
      return null;
    }
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
    this.save();
    return null;
  }

  /** Cancel at once: stop running steps and mark the Objective cancelled. Cleanup steps follow. */
  cancel(by: string): void {
    for (const { controller } of this.running.values())
      controller.abort(new Error("cancelled"));
    this.running.clear();
    if (this.state.status !== "cancelled") {
      this.state.status = "cancelled";
      this.state.hold = null;
      delete this.state.resumeStatus;
      this.state.answers.cancel = {
        holdId: "",
        answer: "cancel",
        by,
        at: this.now().toISOString(),
      };
      this.save();
      this.log.write(this.state.issue, { event: "cancelled", by });
    }
  }

  /** Clear retry waits so every step runs again now. */
  retryNow(): void {
    this.state.retries = {};
    if (this.state.hold && this.state.hold.answers.includes("retry")) {
      this.answer("retry", undefined, "operator");
      return;
    }
    this.save();
  }

  /** Save the state as it is now. */
  persist(): void {
    this.save();
  }

  private save(): void {
    this.state.updatedAt = this.now().toISOString();
    saveState(this.dir, this.state);
  }
}
