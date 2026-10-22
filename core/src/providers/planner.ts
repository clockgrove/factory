/**
 * The Planner seam: one structured answer from a model, for planning, plan
 * review, result review, final review and diagnosis. Provider APIs stay in
 * the adapters (codex.ts, claude.ts).
 */
import { accessSync, constants, statSync } from "node:fs";
import { isAbsolute } from "node:path";

export type PlannerPhase =
  | "plan"
  | "graph-review"
  | "result-review"
  | "objective-review"
  | "diagnosis";

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
  signal: AbortSignal;
  log(event: Record<string, unknown>): void;
}

export interface PlannerAnswer {
  value: unknown;
  model: string;
  effort: string;
  usage?: { input: number; output: number; cached?: number };
  costUsd?: number;
  turns?: number;
  ms: number;
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
  constructor(
    readonly outcome: "retry" | "hold" | "fail",
    reason: string,
    /** For `retry`: when the provider said to come back. */
    readonly afterMs?: number,
  ) {
    super(reason);
  }
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
  /** An omitted phase uses `reviewer.effort`. */
  reviewEffort?: Partial<Record<PlannerPhase, Effort>>;
}

/** The model a call uses: the planner, or the reviewer at its phase's effort. */
export function modelChoice<Effort extends string>(
  models: PlannerModels<Effort>,
  call: Pick<PlannerCall, "role" | "phase">,
): ModelChoice<Effort> {
  if (call.role === "planner") return models.planner;
  const effort = models.reviewEffort?.[call.phase];
  return effort ? { ...models.reviewer, effort } : models.reviewer;
}

/** A bounded provider detail for a reason or the log. */
export function detail(text: string): string {
  return text.length > 2000 ? `${text.slice(0, 2000)}…` : text;
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
      throw new PlannerError(
        "hold",
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
    if (this.signal.aborted) return;
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
