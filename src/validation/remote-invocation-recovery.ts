export interface RemoteValidationDispatchPhase {
  noHandleReplacementNotBefore: string;
}

export interface RemoteValidationDispatchState<TDispatch extends RemoteValidationDispatchPhase> {
  dispatch?: TDispatch;
  rebound: boolean;
}

/** Observe-before-replay policy for one deterministic paid validation resource.
 * Provider adapters own exact resource observation; this transaction owns the
 * single durable dispatch/rebound chain and never extends its original clock. */
export async function runRemoteValidationInvocationTransaction<
  TResult,
  TDispatch extends RemoteValidationDispatchPhase,
>(args: {
  validationDeadline: string;
  now(): Promise<Date>;
  observeFinal(): Promise<TResult | null>;
  observeIntent(): Promise<boolean>;
  persistIntent(): Promise<void>;
  observeDispatch(): Promise<RemoteValidationDispatchState<TDispatch>>;
  persistDispatch(): Promise<TDispatch>;
  observeResource(): Promise<TResult | null>;
  persistRebound(dispatch: TDispatch): Promise<void>;
  launch(): Promise<TResult>;
  persistFinal(result: TResult): Promise<TResult>;
}): Promise<TResult> {
  const final = await args.observeFinal();
  if (final) return final;
  if (!(await args.observeIntent())) await args.persistIntent();
  let state = await args.observeDispatch();
  let launchFailure: unknown;
  if (!state.dispatch) {
    if ((await args.now()).getTime() >= Date.parse(args.validationDeadline))
      throw new Error("remote validation invocation deadline is exhausted before dispatch");
    await args.persistDispatch();
    try {
      return await args.persistFinal(await args.launch());
    } catch (error) {
      const recovered = await args.observeResource();
      if (recovered) return args.persistFinal(recovered);
      launchFailure = error;
      state = await args.observeDispatch();
    }
  } else {
    const recovered = await args.observeResource();
    if (recovered) return args.persistFinal(recovered);
    state = await args.observeDispatch();
  }
  if (state.rebound)
    throw new Error("remote validation invocation remains absent after its single durable rebound");
  const now = await args.now();
  if (now.getTime() < Date.parse(state.dispatch!.noHandleReplacementNotBefore))
    throw (
      launchFailure ??
      new Error(
        "remote validation resource is not visible before its durable no-handle fence; replay is refused",
      )
    );
  if (now.getTime() >= Date.parse(args.validationDeadline))
    throw new Error("remote validation invocation deadline is exhausted; replay is refused");
  await args.persistRebound(state.dispatch!);
  try {
    return await args.persistFinal(await args.launch());
  } catch (error) {
    const reboundRecovery = await args.observeResource();
    if (reboundRecovery) return args.persistFinal(reboundRecovery);
    throw error;
  }
}
