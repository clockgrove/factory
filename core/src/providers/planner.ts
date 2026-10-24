/**
 * The Planner seam: one structured answer from a model, for planning, plan
 * review, result review, final review, diagnosis and `propose`
 * (proposals.ts). Provider APIs stay in
 * the adapters (codex.ts, claude.ts).
 */
import { accessSync, constants, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import {
  failure,
  type Held,
  type HoldScope,
  hold,
  type Offer,
  type Outcome,
} from "../engine.js";
import type { Wait } from "../state.js";
import {
  type Conversation,
  ResumeOverflow,
  type Session,
  withoutPrevious,
} from "./session.js";
import {
  describeRequest,
  logUsage,
  type PromptFacts,
  plannerRole,
  usageRecord,
} from "./usage.js";

export const PLANNER_PHASES = [
  "plan",
  "graph-review",
  "result-review",
  "objective-review",
  "diagnosis",
  "dream",
  "propose",
] as const;
export type PlannerPhase = (typeof PLANNER_PHASES)[number];
/** The phases called with the reviewer's model, so the ones `reviewEffort` can set. */
export const REVIEW_PHASES = [
  "graph-review",
  "result-review",
  "objective-review",
] as const satisfies readonly PlannerPhase[];
export type ReviewPhase = (typeof REVIEW_PHASES)[number];

export interface PlannerCall {
  role: "planner" | "reviewer";
  phase: PlannerPhase;
  prompt: string;
  /** JSON Schema of the answer. */
  schema: Record<string, unknown>;
  /** A read-only directory the model may read with tools; absent means no tools. */
  readDir?: string;
  /** Absolute paths of PNG files the model sees beside the prompt. */
  images?: string[];
  /** The prompt's parts and sources, from its builder (usage.ts PromptFacts). */
  facts?: PromptFacts;
  signal: AbortSignal;
  log(event: Record<string, unknown>): void;
  /** Called on every provider event: the call is alive. */
  activity?(): void;
  /**
   * The conversation this call may continue (session.ts): `prompt` is
   * still the whole request; a continuing turn sends only its delta.
   * Absent: a fresh call that keeps nothing.
   */
  conversation?: Conversation;
}

export interface PlannerAnswer {
  value: unknown;
  model: string;
  effort: string;
  usage?: { input: number; output: number; cached?: number };
  costUsd?: number;
  turns?: number;
  ms: number;
  /** The call's `model-usage` id, for a `model-refused` event (usage.ts logRefused). */
  callId?: string;
  /** The conversation to keep after this call; absent when none was given or the provider keeps none. */
  session?: Session;
}

export interface Planner {
  answer(call: PlannerCall): Promise<PlannerAnswer>;
}

/**
 * A provider failure the adapter has classified from structured fields
 * (never from message text alone). Anything else that escapes a call is an
 * error the engine retries.
 */
export class PlannerError extends Error {
  /**
   * What a `hold` stops (engine.ts HoldScope). A provider failure that
   * holds is about its login, billing, quota or model, its package or
   * setup, or the host: installation-, account- or provider-wide, so it is
   * the Objective's, asked once for every item (docs/reference/holds.md#Holds and answers).
   * Only a cause that is one Work Item's own (its files, its review images,
   * its session's budget) is `item`.
   */
  readonly scope: HoldScope;
  constructor(
    readonly outcome: "retry" | "hold" | "fail",
    reason: string,
    /**
     * For `retry`: a usage limit and its reset (docs/reference/steps.md#Waits), or an
     * error (an idle model), which holds after three.
     */
    readonly wait?: Wait,
    /** For `hold`: its answers, when not `retry` and `cancel`. */
    readonly offers?: readonly Offer[],
    /** For `hold`: `item` when the cause is the Work Item's own. */
    scope?: HoldScope,
  ) {
    super(reason);
    this.scope = scope ?? (outcome === "hold" ? "objective" : "item");
  }

  /** A hold whose cause is one Work Item's own: it stops that item only. */
  static itemHold(reason: string): PlannerError {
    return new PlannerError("hold", reason, undefined, undefined, "item");
  }

  /** The request is larger than the model's context window (`fail`); a continued conversation then starts fresh (session.ts ResumeOverflow). */
  tooLarge = false;

  static contextOverflow(reason: string): PlannerError {
    const error = new PlannerError("fail", reason);
    error.tooLarge = true;
    return error;
  }
}

/**
 * Run `once`, and when a continued conversation ran out of context
 * (session.ts ResumeOverflow), once more with no session: fresh.
 */
export async function freshOnOverflow<T>(
  call: PlannerCall,
  once: (call: PlannerCall) => Promise<T>,
): Promise<T> {
  try {
    return await once(call);
  } catch (error) {
    if (!(error instanceof ResumeOverflow)) throw error;
    return once({ ...call, conversation: withoutPrevious(call.conversation) });
  }
}

type Retried = Extract<Outcome, { kind: "retry" }>;

/**
 * A classified provider failure as a step's outcome: the one rule every
 * provider's planner and workers share. A hold takes the error's scope;
 * `fail` (a turn too large for the model) is a failure, worded by
 * `tooLarge`: the Work Item's by default.
 */
export function providerOutcome(
  error: PlannerError,
  tooLarge: (message: string) => Held = (message) =>
    failure(`${message}. Narrow the Work Item, then answer retry.`),
): Retried | Held {
  if (error.outcome === "retry")
    return {
      kind: "retry",
      reason: error.message,
      ...(error.wait && { wait: error.wait }),
    };
  if (error.outcome === "fail") return tooLarge(error.message);
  const held = hold(error.message, error.offers);
  return error.scope === "objective" ? { ...held, scope: "objective" } : held;
}

/** One model choice. `serviceTier` is Codex-only: "fast" asks for priority. */
export interface ModelChoice<Effort extends string = string> {
  model: string;
  effort: Effort;
  serviceTier?: "standard" | "fast";
}

/** Planner and reviewer models, with the reviewer's effort per review phase. */
export interface PlannerModels<Effort extends string = string> {
  planner: ModelChoice<Effort>;
  reviewer: ModelChoice<Effort>;
  /** A review phase's effort; an omitted one uses `reviewer.effort`. */
  reviewEffort?: Partial<Record<ReviewPhase, Effort>>;
}

/** The model a call uses: the planner, or the reviewer at its phase's effort. */
export function modelChoice<Effort extends string>(
  models: PlannerModels<Effort>,
  call: Pick<PlannerCall, "role" | "phase">,
): ModelChoice<Effort> {
  if (call.role === "planner") return models.planner;
  const effort = models.reviewEffort?.[call.phase as ReviewPhase];
  return effort ? { ...models.reviewer, effort } : models.reviewer;
}

/** A bounded provider detail for a reason or the log. */
export function detail(text: string): string {
  return text.length > 2000 ? `${text.slice(0, 2000)}…` : text;
}

/**
 * Run one call and log it as its `model-usage` event (usage.ts), with its
 * outcome and duration. The adapter fills the record's tokens, cost and
 * operations, and attaches the bodies for capture.
 */
export async function loggedCall<Effort extends string>(
  provider: string,
  call: PlannerCall,
  choice: ModelChoice<Effort>,
  run: (
    record: Record<string, unknown>,
    live: LiveCall,
  ) => Promise<Omit<PlannerAnswer, "ms">>,
): Promise<PlannerAnswer> {
  const started = Date.now();
  const record = usageRecord({
    role: plannerRole(call.role, call.phase),
    provider,
    model: choice.model,
    effort: choice.effort,
    phase: call.phase,
  });
  const live = new LiveCall(call.log, record, started);
  record.tools = Boolean(call.readDir);
  describeRequest(record, {
    prompt: call.prompt,
    schema: call.schema,
    ...(call.images ? { images: call.images } : {}),
    ...(call.facts ? { facts: call.facts } : {}),
  });
  try {
    const answer = await run(record, live);
    record.outcome = "done";
    return {
      ...answer,
      ms: Date.now() - started,
      callId: record.callId as string,
    };
  } catch (error) {
    record.outcome = error instanceof PlannerError ? error.outcome : "error";
    record.error = detail(String(error));
    throw error;
  } finally {
    live.end();
    record.ms = Date.now() - started;
    logUsage(call.log, record);
  }
}

/** At most one `model-progress` event per running call per this long. */
const LIVE_INTERVAL_MS = 10_000;

/**
 * A planner-seam call while it runs (docs/reference/run-log.md#Live calls):
 * `model-call` when it starts, then what its provider reports live (the
 * tokens in its context at its last model request, with the window when
 * given, and its model turns so far) as `model-progress`, the first report
 * after a quiet interval at once and the rest coalesced. Its `model-usage`
 * ends it. Watch and the live status comment show it.
 */
export class LiveCall {
  private tokens: number | undefined;
  private window: number | undefined;
  private turns = 0;
  private pending = false;
  private lastAt = 0;
  private timer: NodeJS.Timeout | undefined;
  private ended = false;
  private readonly callId: unknown;

  constructor(
    private readonly log: (event: Record<string, unknown>) => void,
    record: Record<string, unknown>,
    private readonly started: number,
    private readonly intervalMs = LIVE_INTERVAL_MS,
  ) {
    this.callId = record.callId;
    log({
      event: "model-call",
      callId: record.callId,
      role: record.role,
      phase: record.phase,
      provider: record.provider,
      model: record.model,
      effort: record.effort,
    });
  }

  /** The tokens in the call's context at its last model request, and the model's window when known. */
  context(tokens: number, window?: number): void {
    if (!(Number.isSafeInteger(tokens) && tokens >= 0)) return;
    this.tokens = tokens;
    if (
      typeof window === "number" &&
      Number.isSafeInteger(window) &&
      window > 0
    )
      this.window = window;
    this.changed();
  }

  /** One more model turn (a response). */
  turn(): void {
    this.turns += 1;
    this.changed();
  }

  /** The call ended: nothing more is written; its `model-usage` follows. */
  end(): void {
    clearTimeout(this.timer);
    this.ended = true;
  }

  private changed(): void {
    if (this.ended) return;
    this.pending = true;
    if (this.timer) return;
    const wait = this.lastAt + this.intervalMs - Date.now();
    if (wait <= 0) this.flush();
    else {
      this.timer = setTimeout(() => this.flush(), wait);
      this.timer.unref();
    }
  }

  private flush(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.pending || this.ended) return;
    this.pending = false;
    this.lastAt = Date.now();
    this.log({
      event: "model-progress",
      callId: this.callId,
      ms: this.lastAt - this.started,
      turns: this.turns,
      ...(this.tokens !== undefined ? { tokens: this.tokens } : {}),
      ...(this.window !== undefined ? { window: this.window } : {}),
    });
  }
}

/**
 * The call's images, each an absolute path to a readable PNG file. A
 * missing or unreadable image holds with its path: no provider call can
 * succeed until it is restored.
 */
export function callImages(call: PlannerCall): string[] {
  const images = call.images ?? [];
  for (const image of images) {
    let readable = false;
    try {
      readable =
        isAbsolute(image) &&
        image.toLowerCase().endsWith(".png") &&
        statSync(image).isFile();
      if (readable) accessSync(image, constants.R_OK);
    } catch {
      readable = false;
    }
    if (!readable)
      throw PlannerError.itemHold(
        `Review image ${image} is not a readable absolute PNG file; restore it, then answer retry`,
      );
  }
  return images;
}

export class IdleTimeout extends Error {
  constructor(
    readonly idleMs: number,
    readonly lastEvent: string,
  ) {
    super(
      `No provider events for ${Math.round(idleMs / 1000)} s (last event: ${lastEvent})`,
    );
  }
}

/**
 * Aborts `signal` when the provider is silent for `idleMs`. Every event
 * resets it. While a read tool runs, the bound is `toolIdleMs`; without one
 * a running tool pauses it, since the step deadline still bounds the call.
 * The caller's signal aborts it too.
 */
export class IdleWatchdog {
  private readonly controller = new AbortController();
  private readonly tools = new Set<string>();
  private timer?: NodeJS.Timeout;
  private lastEvent = "start";
  private stopped = false;
  readonly signal: AbortSignal;

  constructor(
    private readonly idleMs: number,
    parent: AbortSignal,
    private readonly toolIdleMs?: number,
  ) {
    this.signal = AbortSignal.any([parent, this.controller.signal]);
    this.arm(0);
  }

  /** `quietMs` is silence the provider announced, such as a retry backoff. */
  progress(
    event: string,
    tool?: { id: string; active: boolean },
    quietMs = 0,
  ): void {
    // Events can still arrive while a stopped call cleans up.
    if (this.signal.aborted || this.stopped) return;
    this.lastEvent = event;
    if (tool?.active) this.tools.add(tool.id);
    else if (tool) this.tools.delete(tool.id);
    this.arm(quietMs > 0 ? quietMs : 0);
  }

  /** The idle timeout, when that is what aborted the call. */
  get expired(): IdleTimeout | undefined {
    const reason: unknown = this.controller.signal.reason;
    return reason instanceof IdleTimeout ? reason : undefined;
  }

  /** Settle `operation`, or reject as soon as the call is aborted. */
  async race<T>(operation: Promise<T>): Promise<T> {
    let onAbort: () => void = () => undefined;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(this.signal.reason);
      if (this.signal.aborted) onAbort();
      else this.signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await Promise.race([operation, aborted]);
    } finally {
      this.signal.removeEventListener("abort", onAbort);
    }
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private arm(quietMs: number): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    const bound = this.tools.size ? this.toolIdleMs : this.idleMs;
    if (bound === undefined) return;
    this.timer = setTimeout(
      () =>
        this.controller.abort(new IdleTimeout(bound + quietMs, this.lastEvent)),
      bound + quietMs,
    );
  }
}

/** When to hedge: after this much silence (any provider event resets it), or this long in all. */
export interface HedgePolicy {
  /** Silence before hedging, by role. Reviews answer with ~10 s between events. */
  silenceMs: Record<PlannerCall["role"], number>;
  /** For a provider that reports no events during a call: hedge after this long. */
  wallMs: number;
}

const DEFAULT_HEDGE: HedgePolicy = {
  silenceMs: { reviewer: 45_000, planner: 120_000 },
  wallMs: 180_000,
};

/**
 * A planner whose stalled calls are hedged. Codex's Responses stream
 * sometimes stops mid-answer (about 3% of review calls in a measured run):
 * the model has started its final message, the terminal event never comes,
 * and the call would wait out a 5-minute idle limit. When the first call
 * goes silent past the policy, an identical second call starts; the first
 * answer wins and the other is aborted. Healthy calls never trigger it.
 */
export class HedgedPlanner implements Planner {
  constructor(
    private readonly inner: Planner,
    private readonly policy: HedgePolicy = DEFAULT_HEDGE,
  ) {}

  answer(call: PlannerCall): Promise<PlannerAnswer> {
    const controllers = [new AbortController(), new AbortController()];
    const started = Date.now();
    let lastEvent = started;
    let sawEvent = false;
    return new Promise((resolve, reject) => {
      let settled = false;
      let running = 0;
      let hedged = false;
      let failure: unknown;
      const attempts: Promise<unknown>[] = [];
      const finish = (settle: () => void) => {
        if (settled) return;
        settled = true;
        clearInterval(timer);
        for (const controller of controllers)
          controller.abort(new Error("hedged"));
        // The first call's conversation directory is its own until it has
        // stopped: the step's next call must not open it before then.
        if (call.conversation) void Promise.allSettled(attempts).then(settle);
        else settle();
      };
      const start = (n: number) => {
        running += 1;
        const attempt = this.inner
          .answer({
            ...call,
            // The hedge never shares the first call's conversation: it
            // starts fresh and keeps none.
            ...(n ? { conversation: undefined } : {}),
            signal: AbortSignal.any([call.signal, controllers[n]!.signal]),
            log: (event) => call.log({ ...event, ...(n ? { hedge: n } : {}) }),
            activity: () => {
              call.activity?.();
              if (n === 0) {
                lastEvent = Date.now();
                sawEvent = true;
              }
            },
          })
          .then(
            (answer) => finish(() => resolve(answer)),
            (error: unknown) => {
              running -= 1;
              failure ??= error;
              // A failure ends the call unless the other attempt is running.
              if (running === 0) finish(() => reject(failure));
            },
          );
        attempts.push(attempt);
      };
      call.signal.addEventListener(
        "abort",
        () => finish(() => reject(call.signal.reason)),
        { once: true },
      );
      start(0);
      const timer = setInterval(() => {
        if (settled || hedged) return;
        const now = Date.now();
        const silent = now - lastEvent;
        const stalled = sawEvent
          ? silent >= this.policy.silenceMs[call.role]
          : now - started >= this.policy.wallMs;
        if (!stalled) return;
        hedged = true;
        call.log({
          event: "planner-hedge",
          silentMs: silent,
          afterMs: now - started,
        });
        start(1);
      }, 5_000);
    });
  }
}
