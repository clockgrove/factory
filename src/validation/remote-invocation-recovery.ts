import type { AttemptReservation } from "../control/attempts.js";
import type { ValidationResourceIdentity } from "../execution/backend.js";
import type { FactoryEvent } from "../protocol/events.js";
import type { ValidationInvocation } from "./repository-capture.js";

export interface RemoteValidationDispatchPhase {
  noHandleReplacementNotBefore: string;
}

export interface RemoteValidationDispatchState<TDispatch extends RemoteValidationDispatchPhase> {
  dispatch?: TDispatch;
  rebound: boolean;
  settled: boolean;
}

export type RemoteValidationSettlementEvidence = "provider-cleanup" | "post-fence-exact-absence";
export type RemoteValidationCleanupObservation = "cleaned" | "absent";

type PreparedEvent = Extract<FactoryEvent, { event: "ValidationInvocationPrepared" }>;
type DispatchEvent = Extract<FactoryEvent, { event: "ValidationInvocationRemoteDispatchStarted" }>;
type ReboundEvent = Extract<FactoryEvent, { event: "ValidationInvocationRemoteRebound" }>;
type SettledEvent = Extract<FactoryEvent, { event: "ValidationInvocationRemoteSettled" }>;
type CapacityEvent = Extract<FactoryEvent, { kind: "capacity" }>;

export interface AuthenticatedRemoteValidationEventChain {
  prepared: PreparedEvent;
  dispatch?: DispatchEvent;
  rebound?: ReboundEvent;
  settled?: SettledEvent;
}

/** Authenticate the complete remote invocation chain against one exact attempt,
 * capacity reservation, deterministic provider request, and current writer. */
export function inspectRemoteValidationEventChain(args: {
  events: readonly FactoryEvent[];
  reservation: AttemptReservation;
  invocation: ValidationInvocation;
  capacity: CapacityEvent;
  resourceIdentity: ValidationResourceIdentity;
  isWriterAuthorized(event: FactoryEvent): boolean;
}): AuthenticatedRemoteValidationEventChain {
  const inAttempt = (event: FactoryEvent) =>
    event.kind === "validation-invocation" &&
    event.runId === args.reservation.runId &&
    event.workItem === args.reservation.workItem &&
    event.attempt === args.reservation.attempt;
  const candidates = args.events.filter(
    (event) =>
      inAttempt(event) &&
      [
        "ValidationInvocationPrepared",
        "ValidationInvocationRemoteDispatchStarted",
        "ValidationInvocationRemoteRebound",
        "ValidationInvocationRemoteSettled",
      ].includes(event.event),
  );
  if (
    !args.isWriterAuthorized(args.capacity) ||
    candidates.some((event) => !args.isWriterAuthorized(event))
  )
    throw new Error("remote validation invocation contains unauthenticated writer authority");
  if (
    args.capacity.event !== "CapacityReserved" ||
    args.capacity.runId !== args.reservation.runId ||
    args.capacity.workItem !== args.reservation.workItem ||
    args.capacity.attempt !== args.reservation.attempt ||
    args.capacity.phase !== "validation" ||
    args.capacity.backend !== args.invocation.toolEnvironment.backendId ||
    args.capacity.directorEpoch !== args.reservation.directorEpoch ||
    args.capacity.policyDigest !== args.reservation.policyDigest
  )
    throw new Error("remote validation invocation differs from its exact capacity reservation");

  const preparedEvents = candidates.filter(
    (event): event is PreparedEvent => event.event === "ValidationInvocationPrepared",
  );
  const dispatches = candidates.filter(
    (event): event is DispatchEvent => event.event === "ValidationInvocationRemoteDispatchStarted",
  );
  const rebounds = candidates.filter(
    (event): event is ReboundEvent => event.event === "ValidationInvocationRemoteRebound",
  );
  const settlements = candidates.filter(
    (event): event is SettledEvent => event.event === "ValidationInvocationRemoteSettled",
  );
  if (
    preparedEvents.length !== 1 ||
    dispatches.length > 1 ||
    rebounds.length > 1 ||
    settlements.length > 1
  )
    throw new Error("remote validation invocation has conflicting durable phases");
  const prepared = preparedEvents[0]!;
  const preparedAuthority = args.invocation.attemptAuthority;
  if (
    prepared.invocationDigest !== args.invocation.digest ||
    prepared.artifactDigest !== args.invocation.artifactDigest ||
    prepared.baseSha !== args.invocation.baseSha ||
    prepared.outputTreeSha !== args.invocation.outputTreeSha ||
    prepared.backend !== args.invocation.toolEnvironment.backendId ||
    prepared.backendLocator !== args.invocation.toolEnvironment.backendLocator ||
    prepared.reservationRef !== preparedAuthority.reservationRef ||
    prepared.reservationOid !== preparedAuthority.reservationOid ||
    prepared.reservationReceiptDigest !== preparedAuthority.reservationReceiptDigest ||
    prepared.attemptDirectorEpoch !== preparedAuthority.directorEpoch ||
    prepared.attemptPolicyDigest !== preparedAuthority.policyDigest ||
    prepared.validationDeadline !== args.invocation.validationDeadline ||
    prepared.capacityReservationSequence !== args.capacity.sequence ||
    prepared.sequence <= args.capacity.sequence
  )
    throw new Error("remote validation prepared event differs from immutable authority");

  const dispatch = dispatches[0];
  const rebound = rebounds[0];
  const settled = settlements[0];
  const matchesRemoteAuthority = (event: DispatchEvent | ReboundEvent | SettledEvent) =>
    event.reservationOid === args.reservation.oid &&
    event.artifactDigest === args.invocation.artifactDigest &&
    event.invocationDigest === args.invocation.digest &&
    event.backend === args.invocation.toolEnvironment.backendId &&
    event.resourceName === args.resourceIdentity.resourceName &&
    event.requestIdentityDigest === args.resourceIdentity.requestIdentityDigest &&
    event.validationDeadline === args.invocation.validationDeadline &&
    event.capacityReservationSequence === args.capacity.sequence;
  if (dispatch && (!matchesRemoteAuthority(dispatch) || dispatch.sequence <= prepared.sequence))
    throw new Error("remote validation dispatch differs from immutable authority");
  if (
    rebound &&
    (!dispatch ||
      !matchesRemoteAuthority(rebound) ||
      rebound.originalDispatchSequence !== dispatch.sequence ||
      rebound.noHandleReplacementNotBefore !== dispatch.noHandleReplacementNotBefore ||
      rebound.sequence <= dispatch.sequence)
  )
    throw new Error("remote validation rebound has an invalid dispatch chain");
  if (
    settled &&
    (!dispatch ||
      !matchesRemoteAuthority(settled) ||
      settled.originalDispatchSequence !== dispatch.sequence ||
      settled.noHandleReplacementNotBefore !== dispatch.noHandleReplacementNotBefore ||
      settled.reboundSequence !== (rebound?.sequence ?? null) ||
      settled.sequence <= (rebound?.sequence ?? dispatch.sequence))
  )
    throw new Error("remote validation settlement has an invalid cleanup chain");
  const writerChain = [args.capacity, prepared, dispatch, rebound, settled].filter(
    (event) => event !== undefined,
  );
  for (let index = 1; index < writerChain.length; index += 1) {
    const previous = writerChain[index - 1]!;
    const current = writerChain[index]!;
    if (
      current.sequence <= previous.sequence ||
      current.writerEpoch! < previous.writerEpoch! ||
      (current.writerEpoch === previous.writerEpoch &&
        current.writerHolder !== previous.writerHolder)
    )
      throw new Error("remote validation writer generation chain regressed or changed holder");
  }
  if (
    prepared.writerEpoch !== args.capacity.writerEpoch ||
    prepared.writerHolder !== args.capacity.writerHolder ||
    prepared.writerPolicyDigest !== args.capacity.writerPolicyDigest
  )
    throw new Error("remote validation preparation differs from its capacity writer");
  return {
    prepared,
    ...(dispatch ? { dispatch } : {}),
    ...(rebound ? { rebound } : {}),
    ...(settled ? { settled } : {}),
  };
}

/** Observe-before-replay policy for one deterministic paid validation resource.
 * Provider adapters own exact resource observation; this transaction owns the
 * single durable dispatch/rebound/settlement chain and never extends its clock. */
export async function runRemoteValidationInvocationTransaction<
  TResult,
  TDispatch extends RemoteValidationDispatchPhase,
>(args: {
  validationDeadline: string;
  now(): Promise<Date>;
  observeResult(): Promise<TResult | null>;
  observeIntent(): Promise<boolean>;
  persistIntent(): Promise<void>;
  observeDispatch(): Promise<RemoteValidationDispatchState<TDispatch>>;
  persistDispatch(): Promise<TDispatch>;
  observeResource(): Promise<TResult | null>;
  cleanupResource(): Promise<RemoteValidationCleanupObservation>;
  terminalDeadlineFailure(): Promise<TResult>;
  persistRebound(dispatch: TDispatch): Promise<void>;
  persistSettlement(
    dispatch: TDispatch,
    evidence: RemoteValidationSettlementEvidence,
  ): Promise<void>;
  launch(): Promise<TResult>;
  persistResult(result: TResult): Promise<TResult>;
}): Promise<TResult> {
  let durableResult = await args.observeResult();
  if (!(await args.observeIntent())) await args.persistIntent();
  let state = await args.observeDispatch();
  if (state.settled) {
    if (!durableResult || !state.dispatch)
      throw new Error("remote validation settlement lacks its exact durable result or dispatch");
    return durableResult;
  }
  if (durableResult && !state.dispatch)
    throw new Error("remote validation result lacks its durable dispatch authority");

  const settle = async (
    dispatch: TDispatch,
    evidence: RemoteValidationSettlementEvidence,
    result: TResult,
  ) => {
    const persisted = await args.persistResult(result);
    await args.persistSettlement(dispatch, evidence);
    return persisted;
  };
  const settleDurable = async (
    dispatch: TDispatch,
    evidence: RemoteValidationSettlementEvidence,
    result: TResult,
  ) => {
    await args.persistSettlement(dispatch, evidence);
    return result;
  };
  const afterFence = async (dispatch: TDispatch) =>
    (await args.now()).getTime() >= Date.parse(dispatch.noHandleReplacementNotBefore);
  const cleanupDurableResult = async (dispatch: TDispatch, result: TResult) => {
    if (!(await afterFence(dispatch)))
      throw new Error(
        "remote validation result is durable but its resource is unsettled before the no-handle fence",
      );
    const cleanup = await args.cleanupResource();
    return settleDurable(
      dispatch,
      cleanup === "cleaned" ? "provider-cleanup" : "post-fence-exact-absence",
      result,
    );
  };
  const expireAfterCleanup = async (dispatch: TDispatch) => {
    const cleanup = await args.cleanupResource();
    return settle(
      dispatch,
      cleanup === "cleaned" ? "provider-cleanup" : "post-fence-exact-absence",
      await args.terminalDeadlineFailure(),
    );
  };

  if (durableResult) {
    return cleanupDurableResult(state.dispatch!, durableResult);
  }

  let launchFailure: unknown;
  if (!state.dispatch) {
    if ((await args.now()).getTime() >= Date.parse(args.validationDeadline))
      throw new Error("remote validation invocation deadline is exhausted before dispatch");
    const dispatch = await args.persistDispatch();
    try {
      return await settle(dispatch, "provider-cleanup", await args.launch());
    } catch (error) {
      launchFailure = error;
      durableResult = await args.observeResult();
      state = await args.observeDispatch();
      if (state.settled && durableResult) return durableResult;
      if (durableResult) return cleanupDurableResult(state.dispatch!, durableResult);
    }
  }
  if (!(await afterFence(state.dispatch!)))
    throw (
      launchFailure ??
      new Error(
        "remote validation resource observation cannot begin before its durable no-handle fence",
      )
    );
  if ((await args.now()).getTime() >= Date.parse(args.validationDeadline))
    return expireAfterCleanup(state.dispatch!);

  const recovered = await args.observeResource();
  if (recovered) return settle(state.dispatch!, "provider-cleanup", recovered);
  durableResult = await args.observeResult();
  state = await args.observeDispatch();
  if (state.settled && durableResult) return durableResult;
  if (durableResult) return cleanupDurableResult(state.dispatch!, durableResult);
  if (state.rebound)
    throw new Error("remote validation invocation remains absent after its single durable rebound");
  if ((await args.now()).getTime() >= Date.parse(args.validationDeadline))
    return expireAfterCleanup(state.dispatch!);
  await args.persistRebound(state.dispatch!);
  try {
    return await settle(state.dispatch!, "provider-cleanup", await args.launch());
  } catch (error) {
    durableResult = await args.observeResult();
    if (durableResult) return cleanupDurableResult(state.dispatch!, durableResult);
    if ((await args.now()).getTime() >= Date.parse(args.validationDeadline))
      return expireAfterCleanup(state.dispatch!);
    const reboundRecovery = await args.observeResource();
    if (reboundRecovery) return settle(state.dispatch!, "provider-cleanup", reboundRecovery);
    throw error;
  }
}
