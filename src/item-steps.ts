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
  AgentSessionContinuation,
  AgentSessionRef,
} from "./contracts.js";
import type { DiagnosticEmitter } from "./diagnostics.js";
import { isDeepStrictEqual } from "node:util";
import { workerContext } from "./execution/checkpoint.js";
import { cancelledFault, faultOf } from "./fault.js";
import { repeatKey, StepPaused, step } from "./step.js";
import type { FactoryState } from "./state.js";
import { agentSessionContinuation } from "./agent-session.js";
import { reviewObjectiveKnowledge } from "./objective-knowledge.js";
import {
  type ReviewOutcome,
  reviewAcceptance,
  type ValidationEvidence,
} from "./validation.js";

interface ItemStep {
  state: FactoryState;
  item: WorkItem;
  save: () => void;
  /** The Objective run's cancel signal (one per run). */
  signal?: AbortSignal;
  /** The owner's pause, drain or handoff signal. */
  pause?: AbortSignal;
}

const scopeOf = ({ item }: ItemStep) => ({ item: item.id });

/**
 * Step rule 7 for a Work Item: whether a step's throw leaves the item where
 * it is. `decision` and `config` wait for the operator (the step saved the
 * wait; `factory retry` or the fix answers it), `cancelled` and a pause stop
 * quietly. The item is not failed and its worker is not stopped. `work` and
 * `defect` return false: the attempt fails.
 */
export function staysInPlace(error: unknown): boolean {
  // Pause is not a fault: the step's record and wait stay for the next run.
  if (error instanceof StepPaused) return true;
  const { kind } = faultOf(error);
  return kind === "decision" || kind === "config" || kind === "cancelled";
}

/**
 * The operator cancelled the item's step: its diagnostics end with a
 * terminal event (the attempt did not complete). Pause and operator waits
 * emit nothing; the step resumes or waits.
 */
export function reportCancelled(
  error: unknown,
  state: FactoryState,
  itemId: string,
  diagnostics?: DiagnosticEmitter,
): void {
  if (error instanceof StepPaused) return;
  const fault = faultOf(error);
  if (fault.kind !== "cancelled") return;
  const work = state.work[itemId]!;
  diagnostics?.emit({
    runId: state.runId,
    itemId,
    attemptId: work.attempt,
    operation: work.step ?? work.status,
    outcome: "failed",
    detail: fault.detail,
  });
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
    session?: AgentSessionContinuation;
  },
): Promise<ExecutionResult> {
  const { state, item, driver, save } = args;
  const work = state.work[item.id]!;
  const context = () => ({
    ...workerContext(work, save, args.cancelled, args.diagnostics, {
      runId: state.runId,
      itemId: item.id,
    }),
    ...(args.session ? { checkpointSession: args.session.checkpoint } : {}),
  });
  const ownsSession = (
    ref: AgentSessionRef | undefined,
    executionIdentity: string,
  ): ref is AgentSessionRef =>
    Boolean(
      ref &&
        ref.identity === args.session?.identity &&
        ref.executionIdentity === executionIdentity &&
        isDeepStrictEqual(ref.scope, args.session?.scope) &&
        ref.scope.role === "implementation" &&
        ref.scope.itemId === item.id,
    );
  const settleSession = (executionIdentity: string): void => {
    const retained = args.session?.retained;
    if (
      retained?.status === "in-flight" &&
      ownsSession(retained, executionIdentity)
    )
      args.session!.checkpoint({ ...retained, status: "unavailable" });
  };
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
        const original = {
          provider: handle.provider,
          identity: handle.identity,
        };
        handle = await driver.find(handle, context());
        ctx.progress();
        if (!handle) {
          args.diagnostics?.emit({
            runId: state.runId,
            itemId: item.id,
            attemptId: work.attempt,
            operation: "worker-lost",
            outcome: "failed",
            formalFailure: true,
            metadata: {
              provider: original.provider,
              workerIdentity: original.identity,
              workerOrdinal: work.worker ?? 0,
              confirmedStopped: true,
            },
          });
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
          const ownsReplacedSession = ownsSession(
            args.session?.retained,
            replaced.identity,
          );
          await driver.cancel(structuredClone(replaced), {
            cancelled: args.cancelled,
            checkpoint: () => undefined,
            ...(ownsReplacedSession
              ? { checkpointSession: args.session!.checkpoint }
              : {}),
          });
          ctx.progress();
          if (ownsReplacedSession) settleSession(replaced.identity);
        }
        const unrecorded = args.session?.retained;
        if (unrecorded?.status === "in-flight") {
          const identity = workerIdentity(work);
          if (!ownsSession(unrecorded, identity))
            throw new Error(
              "Unrecorded worker session lacks this exact execution identity",
            );
          // The original paid start remains charged by its step. Only the
          // driver's supported cessation proof admits a fresh conversation;
          // a lost handle alone proves neither completion nor stopped work.
          await driver.cancelUnrecorded(identity, context());
          ctx.progress();
          settleSession(identity);
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
    { save, signal: args.signal, pause: args.pause },
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
    { save: args.save, signal: args.signal, pause: args.pause },
  );
}

/**
 * Independent review of the exact result: a paid step. A lost answer is
 * asked again; an invalid one is asked again once with its validation
 * error (kept in the step's record, so a restart still sends it), and an
 * answer still invalid becomes the operator's decision on that criterion
 * (`factory decide`), within the paid bound. Each ask is one
 * `acceptance-review` span.
 */
export function reviewItem(
  args: ItemStep & {
    cancelled?: () => boolean;
    diagnostics?: DiagnosticEmitter;
    review: (retry: {
      previousInvalid?: string;
      onInvalid: (detail: string) => void;
    }) => Parameters<typeof reviewAcceptance>[0];
  },
): Promise<ReviewOutcome> {
  const work = args.state.work[args.item.id]!;
  return step(
    args.state,
    { scope: scopeOf(args), name: "review", paid: true },
    (ctx) => {
      if (stopped(args)) throw cancelledFault();
      const previousInvalid = ctx.previousInvalid();
      const ask = () =>
        ctx.paid(() => {
          const request = args.review({
            ...(previousInvalid ? { previousInvalid } : {}),
            onInvalid: (detail) => ctx.invalid(detail),
          });
          return reviewAcceptance({
            ...request,
            evidenceSources: [
              ...(request.evidenceSources ?? []),
              ...reviewObjectiveKnowledge(
                args.state,
                args.item.id,
                request.checkout,
                request.commit,
              ),
            ],
            session: agentSessionContinuation(
              args.state,
              "result-review",
              args.item.id,
              args.save,
            ),
          });
        });
      return args.diagnostics
        ? args.diagnostics.span(
            {
              runId: args.state.runId,
              itemId: args.item.id,
              attemptId: work.attempt,
              operation: "acceptance-review",
              metadata: { treeSha: work.treeSha! },
            },
            ask,
            (outcome) => ({
              criteria: outcome.evidence?.criteria?.length ?? 0,
            }),
          )
        : ask();
    },
    { save: args.save, signal: args.signal, pause: args.pause },
  );
}
