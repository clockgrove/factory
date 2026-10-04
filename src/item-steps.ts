/**
 * The Work Item steps both delivery runners share (recovery v2.2, #515):
 * execute, validate and review. Each is repeatable from the top; see the
 * guide at the top of src/step.ts.
 */
import type {
  ExecutionDriver,
  ExecutionRequest,
  ExecutionResult,
  WorkItem,
} from "./contracts.js";
import type { DiagnosticEmitter } from "./diagnostics.js";
import { workerContext } from "./execution/checkpoint.js";
import { faultOf } from "./fault.js";
import { step } from "./step.js";
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
}

const scopeOf = ({ item }: ItemStep) => ({ item: item.id });

/**
 * Run the item's worker to a collected result. The attempt id is saved
 * before `start`; a repeat adopts the recorded attempt through the driver
 * (`find`), and the driver keeps a collected result until the runner records
 * it. A dead worker is a paid transient fault; once the driver confirms it
 * stopped without a result, the repeat starts the attempt's next worker
 * under a new identity. The attempt itself never changes inside the step.
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
  return step(
    state,
    { scope: scopeOf(args), name: "execute", paid: true },
    async (ctx) => {
      // Drivers mutate the handle they hold, then checkpoint it: they get a
      // copy of the recorded one.
      const recorded = () =>
        work.execution ? structuredClone(work.execution) : undefined;
      let handle = recorded();
      if (handle) handle = await driver.find(handle, context());
      if (handle) ctx.progress();
      else {
        // A retried attempt starts only once the driver confirmed the worker
        // of the attempt it replaces stopped (cancel is idempotent).
        const replaced = work.recovery?.history?.at(-1)?.work.execution;
        if (!work.execution && !work.worker && replaced) {
          await driver.cancel(structuredClone(replaced), {
            cancelled: args.cancelled,
            checkpoint: () => undefined,
          });
          ctx.progress();
        }
        // The recorded worker stopped without a result (the driver confirmed
        // it): the next worker of this attempt gets the next identity, saved
        // before it starts.
        if (work.execution) {
          work.worker = (work.worker ?? 0) + 1;
          delete work.execution;
          save();
        }
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
      if (args.cancelled()) {
        await driver.cancel(current, context());
        throw new Error("Objective cancelled");
      }
      return ctx.paid(() => driver.collect(current, context()));
    },
    { save },
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
    { save: args.save },
  );
}

/**
 * Independent review of the exact result: a paid step. A lost answer is
 * asked again; an invalid one is asked again with its validation error,
 * until the paid bound makes it a decision.
 */
export function reviewItem(
  args: ItemStep & {
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
    (ctx) =>
      ctx.paid(() =>
        reviewOutcome(
          args.review({
            ...(previousInvalid ? { previousInvalid } : {}),
            onInvalid: (detail) => {
              previousInvalid = detail;
            },
          }),
        ),
      ),
    { save: args.save },
  );
}

/**
 * A fault that waits for the operator (a decision, a configuration fix)
 * rather than stopping the Objective: only its item waits.
 */
export function operatorWait(error: unknown): boolean {
  const kind = faultOf(error).kind;
  return kind === "decision" || kind === "config";
}
