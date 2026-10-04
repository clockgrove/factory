/**
 * The Work Item steps both delivery runners share (recovery v2.3, #515):
 * execute, validate and review, and how a runner reads a step's throw.
 * Each step is repeatable from the top; see the guide at the top of
 * src/step.ts.
 */
import type {
  ExecutionDriver,
  ExecutionRequest,
  ExecutionResult,
  WorkItem,
} from "./contracts.js";
import type { DiagnosticEmitter } from "./diagnostics.js";
import { workerContext } from "./execution/checkpoint.js";
import { faultOf, StepFault } from "./fault.js";
import { repeatKey, step } from "./step.js";
import type { FactoryState } from "./state.js";
import {
  type ReviewOutcome,
  reviewOutcome,
  type ValidationEvidence,
} from "./validation.js";

interface ItemStep {
  state: FactoryState;
  item: WorkItem;
  save: () => void;
  /** The Objective run's cancel signal (one per run). */
  signal?: AbortSignal;
}

const scopeOf = ({ item }: ItemStep) => ({ item: item.id });

/** The operator cancelled: the `cancelled` fault, never an unclassified error. */
export function cancelledFault(detail = "Objective cancelled"): StepFault {
  return new StepFault({ kind: "cancelled", detail });
}

/**
 * The owner paused while an item waited (for CI): stop at this safe point.
 * Pause is not cancel and not a fault: nothing is charged or failed, and
 * the next run resumes the step.
 */
export class ItemPaused extends Error {
  constructor() {
    super("paused");
    this.name = "ItemPaused";
  }
}

/**
 * Step rule 7 for a Work Item: whether a step's throw leaves the item where
 * it is. `decision` and `config` wait for the operator (the step saved the
 * wait; `factory retry` or the fix answers it), `cancelled` and a pause stop
 * quietly. The item is not failed and its worker is not stopped. `work` and
 * `defect` return false: the attempt fails.
 */
export function staysInPlace(error: unknown): boolean {
  if (error instanceof ItemPaused) return true;
  const { kind } = faultOf(error);
  return kind === "decision" || kind === "config" || kind === "cancelled";
}

const stopped = (args: { signal?: AbortSignal; cancelled?: () => boolean }) =>
  Boolean(args.signal?.aborted || args.cancelled?.());

/**
 * Run the item's worker to a collected result. The attempt id is saved
 * before `start`; a repeat adopts the recorded worker through the driver
 * (`find`). Only `start` is paid: collecting is a long wait, so a restart
 * during it never counts. A recorded worker the driver confirmed stopped
 * without a result is one lost paid effect; the repeat starts the attempt's
 * next worker under a new identity. The attempt never changes in the step.
 */
export async function executeItem(
  args: ItemStep & {
    driver: ExecutionDriver;
    request: (attemptId: string) => ExecutionRequest;
    cancelled: () => boolean;
    diagnostics?: DiagnosticEmitter;
  },
): Promise<ExecutionResult> {
  const { state, item, driver, save } = args;
  const work = state.work[item.id]!;
  const context = () =>
    workerContext(work, save, args.cancelled, args.diagnostics, {
      runId: state.runId,
      itemId: item.id,
    });
  // A start cut off by a crash is counted once by `step` on entry; the
  // worker it may have left is that same lost effect, not a second one.
  let crashedStart = Boolean(
    state.repeats?.[repeatKey(scopeOf(args), "execute")]?.inFlight,
  );
  return step(
    state,
    { scope: scopeOf(args), name: "execute", paid: true },
    async (ctx) => {
      // Drivers mutate the handle they hold, then checkpoint it: they get a
      // copy of the recorded one.
      const recorded = () =>
        work.execution ? structuredClone(work.execution) : undefined;
      let handle = recorded();
      if (handle) {
        handle = await driver.find(handle, context());
        ctx.progress();
        if (!handle) {
          // The driver confirmed the recorded worker stopped without a
          // result: the next worker gets the next identity, saved first.
          work.worker = (work.worker ?? 0) + 1;
          delete work.execution;
          save();
          const counted = !crashedStart;
          crashedStart = false;
          if (counted)
            ctx.paidLost(`Worker of ${item.id} ended without a result`);
        }
      }
      crashedStart = false;
      if (!handle) {
        // A retried attempt starts only once the driver confirmed the worker
        // of the attempt it replaces stopped (cancel is idempotent).
        const replaced = work.recovery?.history?.at(-1)?.work.execution;
        if (!work.worker && replaced) {
          await driver.cancel(structuredClone(replaced), {
            cancelled: args.cancelled,
            checkpoint: () => undefined,
          });
          ctx.progress();
        }
        if (stopped(args)) throw cancelledFault();
        handle = await ctx.paid(() =>
          driver.start(args.request(workerIdentity(work)), context()),
        );
        // Drivers checkpoint before start returns; record it otherwise.
        if (!work.execution) {
          work.execution = structuredClone(handle);
          save();
        }
      }
      const current = recorded() ?? handle;
      if (stopped(args)) {
        await driver.cancel(current, context());
        throw cancelledFault();
      }
      const result = await driver.collect(current, context());
      ctx.progress();
      return result;
    },
    { save, signal: args.signal },
  );
}

/** The driver's identity for the attempt's current worker. */
export function workerIdentity(work: FactoryState["work"][string]): string {
  return work.worker ? `${work.attempt}-${work.worker}` : work.attempt!;
}

/** Validate the exact result; a stale validation worktree is replaced. */
export function validateItem(
  args: ItemStep & { validate: () => Promise<ValidationEvidence> },
): Promise<ValidationEvidence> {
  return step(
    args.state,
    { scope: scopeOf(args), name: "validate" },
    () => args.validate(),
    { save: args.save, signal: args.signal },
  );
}

/**
 * Independent review of the exact result: a paid step. A lost answer is
 * asked again; an invalid one is asked again once with its validation
 * error, and an answer still invalid becomes the operator's decision on
 * that criterion (`factory decide-result`), within the paid bound.
 */
export function reviewItem(
  args: ItemStep & {
    cancelled?: () => boolean;
    review: (retry: {
      previousInvalid?: string;
      onInvalid: (detail: string) => void;
    }) => Parameters<typeof reviewOutcome>[0];
  },
): Promise<ReviewOutcome> {
  let previousInvalid: string | undefined;
  return step(
    args.state,
    { scope: scopeOf(args), name: "review", paid: true },
    (ctx) => {
      if (stopped(args)) throw cancelledFault();
      return ctx.paid(() =>
        reviewOutcome(
          args.review({
            ...(previousInvalid ? { previousInvalid } : {}),
            onInvalid: (detail) => {
              previousInvalid = detail;
            },
          }),
        ),
      );
    },
    { save: args.save, signal: args.signal },
  );
}
