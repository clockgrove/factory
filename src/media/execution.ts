import { ObjectiveAssetAuthoritySchema, assetDigest } from "../assets/contracts.js";
import type { MediaProducerAdapter, MediaAdapterHandle } from "./adapter.js";
import {
  MediaDispatchReceiptSchema,
  MediaInvocationSchema,
  type AssetSet,
  type MediaDispatchReceipt,
  type MediaInvocation,
} from "./contracts.js";
import {
  recoverRetainedMediaCollection,
  removeRetainedMediaCollection,
  retainMediaCollection,
} from "./retention.js";
import {
  createMediaDispatchReceipt,
  persistAssetSet,
  persistMediaDispatchReceipt,
  readMediaDispatchReceiptByInvocation,
  type MediaStore,
} from "./storage.js";

export interface MediaExecutionAccounting {
  providerRequests: number;
  variants: number | null;
  generatedBytes: number | null;
  storageBytes: number | null;
  native: Array<{ unit: string; amount: number | null }>;
}

export interface MediaExecutionHooks {
  /** This is the durable prepared -> dispatching CAS. Returning means a launch
   * may have happened; callers must never invoke runPrepared again. */
  markDispatching(invocation: MediaInvocation): Promise<void>;
  recordDispatch(receipt: MediaDispatchReceipt, commitOid: string): Promise<void>;
  recordTerminalFailure(args: {
    invocation: MediaInvocation;
    state: "failed" | "cancelled" | "unknown";
    reason: string;
    accounting: MediaExecutionAccounting;
  }): Promise<void>;
  recordAssetSet(assetSet: AssetSet, commitOid: string): Promise<void>;
  recordUsageSettled(
    invocation: MediaInvocation,
    accounting: MediaExecutionAccounting,
  ): Promise<void>;
  recordCleanupFailure(invocation: MediaInvocation, reason: string): Promise<void>;
  recordCleanupCompleted(invocation: MediaInvocation): Promise<void>;
}

export type MediaExecutionResult =
  | { state: "running"; dispatchReceipt: MediaDispatchReceipt }
  | {
      state: "failed" | "cancelled";
      dispatchReceipt: MediaDispatchReceipt;
      cleanupPending: boolean;
    }
  | { state: "unknown"; dispatchReceipt: MediaDispatchReceipt | null }
  | {
      state: "for-review";
      dispatchReceipt: MediaDispatchReceipt;
      assetSet: AssetSet;
      cleanupPending: boolean;
    };

function exactUsage(
  adapter: MediaProducerAdapter,
  usage: Array<{ unit: string; amount: number | null }>,
) {
  const declared = [...adapter.capability.nativeUsageKeys].sort();
  const observed = [...usage].sort((left, right) => left.unit.localeCompare(right.unit));
  if (
    new Set(observed.map(({ unit }) => unit)).size !== observed.length ||
    JSON.stringify(observed.map(({ unit }) => unit)) !== JSON.stringify(declared)
  )
    throw new Error("media adapter usage differs from its declared native units");
  return observed;
}

const unavailableAccounting = (adapter: MediaProducerAdapter): MediaExecutionAccounting => ({
  providerRequests: 1,
  variants: null,
  generatedBytes: null,
  storageBytes: null,
  native: adapter.capability.nativeUsageKeys.map((unit) => ({ unit, amount: null })),
});

/** Executes one already-reserved invocation. Nothing before markDispatching can
 * launch a provider request; nothing after it retries launch. */
export class MediaProductionExecutor {
  constructor(
    private readonly options: {
      store: MediaStore;
      retentionRoot: string;
      adapter: MediaProducerAdapter;
      hooks: MediaExecutionHooks;
      assertCurrent(): Promise<void>;
    },
  ) {}

  async runPrepared(args: {
    authority: unknown;
    invocation: MediaInvocation;
    reservationOid: string;
    signal?: AbortSignal;
  }): Promise<MediaExecutionResult> {
    const authority = ObjectiveAssetAuthoritySchema.parse(args.authority);
    const invocation = MediaInvocationSchema.parse(args.invocation);
    if (
      invocation.adapterId !== this.options.adapter.capability.id ||
      invocation.capabilityDigest !== assetDigest(this.options.adapter.capability)
    )
      throw new Error("reserved invocation differs from the selected media adapter");
    const probe = await this.options.adapter.probe();
    if (!probe.available || !probe.authenticated)
      throw new Error(`media adapter refused before dispatch: ${probe.reason ?? "unavailable"}`);
    await this.options.hooks.markDispatching(invocation);
    // From this boundary onward, any thrown error is an ambiguous dispatched
    // invocation unless an exact handle/terminal record was durably written.
    try {
      const handle = await this.options.adapter.dispatch(invocation);
      const receipt = createMediaDispatchReceipt(invocation, handle);
      const persisted = await persistMediaDispatchReceipt({
        store: this.options.store,
        authority,
        runId: invocation.runId,
        receipt,
        parentOids: [args.reservationOid],
        assertCurrent: this.options.assertCurrent,
      });
      await this.options.hooks.recordDispatch(receipt, persisted.commit);
      return this.resume({
        authority,
        invocation,
        reservationOid: args.reservationOid,
        receipt,
        ...(args.signal ? { signal: args.signal } : {}),
      });
    } catch (error) {
      await this.options.hooks.recordTerminalFailure({
        invocation,
        state: "unknown",
        reason: `media dispatch may have crossed its provider boundary: ${String(error)}`,
        accounting: unavailableAccounting(this.options.adapter),
      });
      return { state: "unknown", dispatchReceipt: null };
    }
  }

  /** Resume an invocation after its durable dispatch marker. This method may
   * reconstruct an observable handle, but it never calls adapter.dispatch. */
  async resumeDispatched(args: {
    authority: unknown;
    invocation: MediaInvocation;
    reservationOid: string;
    signal?: AbortSignal;
  }): Promise<MediaExecutionResult> {
    const authority = ObjectiveAssetAuthoritySchema.parse(args.authority);
    const invocation = MediaInvocationSchema.parse(args.invocation);
    const persisted = await readMediaDispatchReceiptByInvocation({
      store: this.options.store,
      authority,
      runId: invocation.runId,
      invocationDigest: invocation.digest,
    });
    if (persisted) {
      await this.options.hooks.recordDispatch(persisted.receipt, persisted.commit);
      return this.resume({
        authority,
        invocation,
        reservationOid: args.reservationOid,
        receipt: persisted.receipt,
        ...(args.signal ? { signal: args.signal } : {}),
      });
    }
    if (
      !this.options.adapter.capability.recovery.observation ||
      !this.options.adapter.recoverHandle
    ) {
      await this.options.hooks.recordTerminalFailure({
        invocation,
        state: "unknown",
        reason: "media dispatch was possible but its exact handle is unavailable",
        accounting: unavailableAccounting(this.options.adapter),
      });
      return { state: "unknown", dispatchReceipt: null };
    }
    let handle: MediaAdapterHandle | null;
    try {
      handle = await this.options.adapter.recoverHandle(invocation);
    } catch (error) {
      await this.options.hooks.recordTerminalFailure({
        invocation,
        state: "unknown",
        reason: `media dispatch handle recovery failed: ${String(error)}`,
        accounting: unavailableAccounting(this.options.adapter),
      });
      return { state: "unknown", dispatchReceipt: null };
    }
    if (!handle) {
      await this.options.hooks.recordTerminalFailure({
        invocation,
        state: "unknown",
        reason: "media adapter could not identify the exact dispatched invocation",
        accounting: unavailableAccounting(this.options.adapter),
      });
      return { state: "unknown", dispatchReceipt: null };
    }
    const receipt = createMediaDispatchReceipt(invocation, handle);
    const stored = await persistMediaDispatchReceipt({
      store: this.options.store,
      authority,
      runId: invocation.runId,
      receipt,
      parentOids: [args.reservationOid],
      assertCurrent: this.options.assertCurrent,
    });
    await this.options.hooks.recordDispatch(receipt, stored.commit);
    return this.resume({
      authority,
      invocation,
      reservationOid: args.reservationOid,
      receipt,
      ...(args.signal ? { signal: args.signal } : {}),
    });
  }

  /** Recovery entry point. It observes or collects only this exact durable
   * invocation and never invokes adapter.dispatch. */
  async resume(args: {
    authority: unknown;
    invocation: MediaInvocation;
    reservationOid: string;
    receipt: MediaDispatchReceipt;
    signal?: AbortSignal;
  }): Promise<MediaExecutionResult> {
    const authority = ObjectiveAssetAuthoritySchema.parse(args.authority);
    const invocation = MediaInvocationSchema.parse(args.invocation);
    const receipt = MediaDispatchReceiptSchema.parse(args.receipt);
    if (
      receipt.invocationDigest !== invocation.digest ||
      receipt.invocationId !== invocation.invocationId
    )
      throw new Error("durable media dispatch receipt differs from the reserved invocation");
    const handle: MediaAdapterHandle = {
      invocationId: receipt.invocationId,
      providerRequestId: receipt.providerRequestId,
      dispatchedAt: receipt.dispatchedAt,
    };
    let collection = await recoverRetainedMediaCollection({
      root: this.options.retentionRoot,
      invocation,
    });
    if (!collection) {
      let observation;
      if (args.signal?.aborted || Date.parse(invocation.deadline) <= Date.now()) {
        if (!this.options.adapter.capability.recovery.cancellation) {
          await this.options.hooks.recordTerminalFailure({
            invocation,
            state: "unknown",
            reason: "media invocation reached cancellation without exact adapter support",
            accounting: unavailableAccounting(this.options.adapter),
          });
          return { state: "unknown", dispatchReceipt: receipt };
        }
        try {
          await this.options.adapter.cancel(invocation, handle);
          observation = await this.options.adapter.observe(invocation, handle);
        } catch (error) {
          await this.options.hooks.recordTerminalFailure({
            invocation,
            state: "unknown",
            reason: `media cancellation outcome is unavailable: ${String(error)}`,
            accounting: unavailableAccounting(this.options.adapter),
          });
          return { state: "unknown", dispatchReceipt: receipt };
        }
      } else {
        observation = await this.options.adapter.observe(invocation, handle);
      }
      if (observation.state === "running") return { state: "running", dispatchReceipt: receipt };
      if (observation.state === "unknown") {
        await this.options.hooks.recordTerminalFailure({
          invocation,
          state: "unknown",
          reason: observation.reason ?? "exact media invocation outcome is unavailable",
          accounting: unavailableAccounting(this.options.adapter),
        });
        return { state: "unknown", dispatchReceipt: receipt };
      }
      if (observation.state === "failed" || observation.state === "cancelled") {
        const native = exactUsage(this.options.adapter, observation.usage);
        await this.options.hooks.recordTerminalFailure({
          invocation,
          state: observation.state,
          reason: observation.reason ?? `media invocation ${observation.state}`,
          accounting: {
            providerRequests: 1,
            variants: null,
            generatedBytes: null,
            storageBytes: null,
            native,
          },
        });
        const cleanupPending = !(await this.cleanup(invocation, handle));
        return { state: observation.state, dispatchReceipt: receipt, cleanupPending };
      }
      try {
        collection = await this.options.adapter.collect(invocation, handle);
        exactUsage(this.options.adapter, collection.usage);
        await retainMediaCollection({
          root: this.options.retentionRoot,
          invocation,
          collection,
        });
      } catch (error) {
        await this.options.hooks.recordTerminalFailure({
          invocation,
          state: "unknown",
          reason: `successful media result could not be retained: ${String(error)}`,
          accounting: unavailableAccounting(this.options.adapter),
        });
        return { state: "unknown", dispatchReceipt: receipt };
      }
    } else {
      exactUsage(this.options.adapter, collection.usage);
    }
    const stored = await persistAssetSet({
      store: this.options.store,
      authority,
      invocation,
      dispatchReceipt: receipt,
      collection,
      assertCurrent: this.options.assertCurrent,
    });
    await this.options.hooks.recordAssetSet(stored.assetSet, stored.commit);
    await this.options.hooks.recordUsageSettled(invocation, {
      providerRequests: 1,
      variants: stored.assetSet.variants.length,
      generatedBytes: stored.assetSet.totalGeneratedBytes,
      storageBytes: stored.assetSet.totalStorageBytes,
      native: stored.assetSet.usage,
    });
    const cleanupPending = !(await this.cleanup(invocation, handle));
    if (!cleanupPending)
      await removeRetainedMediaCollection(this.options.retentionRoot, invocation.digest);
    return {
      state: "for-review",
      dispatchReceipt: receipt,
      assetSet: stored.assetSet,
      cleanupPending,
    };
  }

  private async cleanup(invocation: MediaInvocation, handle: MediaAdapterHandle): Promise<boolean> {
    try {
      await this.options.adapter.cleanup(invocation, handle);
      await this.options.hooks.recordCleanupCompleted(invocation);
      return true;
    } catch (error) {
      await this.options.hooks.recordCleanupFailure(invocation, String(error));
      return false;
    }
  }
}
