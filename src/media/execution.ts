import { setTimeout as delay } from "node:timers/promises";

import { ObjectiveAssetAuthoritySchema, assetDigest } from "../assets/contracts.js";
import type {
  MediaAdapterHandle,
  MediaAdapterCollection,
  MediaAdapterRuntimeRequest,
  MediaProducerAdapter,
} from "./adapter.js";
import {
  AssetSetSchema,
  MediaDispatchReceiptSchema,
  MediaInvocationSchema,
  type AssetSet,
  type MediaDispatchReceipt,
  type MediaInvocation,
} from "./contracts.js";
import {
  MediaCollectionValidationError,
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

export type MediaExecutionPhase =
  | "prepared"
  | "dispatch"
  | "dispatch-receipt"
  | "observe"
  | "collect"
  | "retain"
  | "store"
  | "account"
  | "cleanup";

export class MediaExecutionPhaseError extends Error {
  constructor(
    readonly phase: MediaExecutionPhase,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "MediaExecutionPhaseError";
  }
}

export interface MediaExecutionAccounting {
  providerRequests: number | null;
  variants: number | null;
  generatedBytes: number | null;
  storageBytes: number | null;
  native: Array<{ unit: string; amount: number | null }>;
}

export interface MediaExecutionHooks {
  markDispatching(invocation: MediaInvocation): Promise<void>;
  recordDispatch(receipt: MediaDispatchReceipt, commitOid: string): Promise<void>;
  recordTerminalFailure(args: {
    invocation: MediaInvocation;
    phase: MediaExecutionPhase;
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
      dispatchReceipt: MediaDispatchReceipt | null;
      cleanupPending: boolean;
      definitiveNonExecution: boolean;
    }
  | {
      state: "unknown";
      phase: MediaExecutionPhase;
      dispatchReceipt: MediaDispatchReceipt | null;
    }
  | {
      state: "for-review";
      dispatchReceipt: MediaDispatchReceipt;
      assetSet: AssetSet;
      cleanupPending: boolean;
    };

function exactUsage(
  invocation: MediaInvocation,
  usage: Array<{ unit: string; amount: number | null }>,
) {
  const declared = invocation.usageReservation.nativeUnits;
  const observed = [...usage].sort((left, right) => left.unit.localeCompare(right.unit));
  if (
    new Set(observed.map(({ unit }) => unit)).size !== observed.length ||
    JSON.stringify(observed.map(({ unit }) => unit)) !== JSON.stringify(declared)
  )
    throw new MediaCollectionValidationError(
      "media adapter usage differs from its reserved native units",
    );
  return observed;
}

const unavailableAccounting = (invocation: MediaInvocation): MediaExecutionAccounting => ({
  providerRequests: invocation.usageReservation.providerRequests === 0 ? 0 : null,
  variants: null,
  generatedBytes: null,
  storageBytes: null,
  native: invocation.usageReservation.nativeUnits.map((unit) => ({ unit, amount: null })),
});

const zeroAccounting = (invocation: MediaInvocation): MediaExecutionAccounting => ({
  providerRequests: 0,
  variants: 0,
  generatedBytes: 0,
  storageBytes: 0,
  native: invocation.usageReservation.nativeUnits.map((unit) => ({ unit, amount: 0 })),
});

const boundedReason = (value: unknown) => String(value).slice(0, 8_000);

function verifyRequest(adapter: MediaProducerAdapter, request: MediaAdapterRuntimeRequest) {
  const invocation = MediaInvocationSchema.parse(request.invocation);
  if (
    invocation.adapterId !== adapter.capability.id ||
    invocation.capabilityDigest !== assetDigest(adapter.capability)
  )
    throw new Error("reserved invocation differs from the selected media adapter");
  return { ...request, invocation };
}

export class MediaProductionExecutor {
  constructor(
    private readonly options: {
      store: MediaStore;
      retentionRoot: string;
      adapter: MediaProducerAdapter;
      hooks: MediaExecutionHooks;
      assertCurrent(): Promise<void>;
      observationWindowMs?: number;
    },
  ) {}

  async runPrepared(args: {
    authority: unknown;
    request: MediaAdapterRuntimeRequest;
    reservationOid: string;
    signal?: AbortSignal;
  }): Promise<MediaExecutionResult> {
    const authority = ObjectiveAssetAuthoritySchema.parse(args.authority);
    const request = verifyRequest(this.options.adapter, args.request);
    const invocation = request.invocation;
    if (authority.baseSha !== invocation.authorityBaseSha)
      throw new Error("media invocation authority differs from the immutable run base");
    const preDispatchState = args.signal?.aborted
      ? { state: "cancelled" as const, reason: "media invocation aborted before dispatch" }
      : Date.parse(invocation.deadline) <= Date.now()
        ? {
            state: "cancelled" as const,
            reason: "media invocation deadline expired before dispatch",
          }
        : null;
    if (preDispatchState) {
      await this.options.hooks.recordTerminalFailure({
        invocation,
        phase: "prepared",
        ...preDispatchState,
        accounting: zeroAccounting(invocation),
      });
      return {
        state: preDispatchState.state,
        dispatchReceipt: null,
        cleanupPending: false,
        definitiveNonExecution: true,
      };
    }
    const probe = await this.options.adapter.probe();
    if (!probe.available || !probe.authenticated) {
      await this.options.hooks.recordTerminalFailure({
        invocation,
        phase: "prepared",
        state: "failed",
        reason: boundedReason(
          `media adapter refused before dispatch: ${probe.reason ?? "unavailable"}`,
        ),
        accounting: zeroAccounting(invocation),
      });
      return {
        state: "failed",
        dispatchReceipt: null,
        cleanupPending: false,
        definitiveNonExecution: true,
      };
    }
    const immediatePreDispatchState = args.signal?.aborted
      ? { state: "cancelled" as const, reason: "media invocation aborted before dispatch" }
      : Date.parse(invocation.deadline) <= Date.now()
        ? {
            state: "cancelled" as const,
            reason: "media invocation deadline expired before dispatch",
          }
        : null;
    if (immediatePreDispatchState) {
      await this.options.hooks.recordTerminalFailure({
        invocation,
        phase: "prepared",
        ...immediatePreDispatchState,
        accounting: zeroAccounting(invocation),
      });
      return {
        state: immediatePreDispatchState.state,
        dispatchReceipt: null,
        cleanupPending: false,
        definitiveNonExecution: true,
      };
    }
    await this.options.hooks.markDispatching(invocation);
    let handle: MediaAdapterHandle;
    try {
      handle = await this.options.adapter.dispatch(request);
    } catch (error) {
      const ambiguous = invocation.usageReservation.providerRequests > 0;
      if (ambiguous) {
        await this.options.hooks.recordTerminalFailure({
          invocation,
          phase: "dispatch",
          state: "unknown",
          reason: boundedReason(
            `media dispatch may have crossed its provider boundary: ${String(error)}`,
          ),
          accounting: unavailableAccounting(invocation),
        });
        return { state: "unknown", phase: "dispatch", dispatchReceipt: null };
      }
      throw new MediaExecutionPhaseError(
        "dispatch",
        "local media dispatch failed after its durable marker; exact checkpoint recovery is required",
        { cause: error },
      );
    }
    const receipt = createMediaDispatchReceipt(invocation, handle);
    let persisted: Awaited<ReturnType<typeof persistMediaDispatchReceipt>>;
    try {
      persisted = await persistMediaDispatchReceipt({
        store: this.options.store,
        authority,
        runId: invocation.runId,
        receipt,
        parentOids: [args.reservationOid],
        assertCurrent: this.options.assertCurrent,
      });
      await this.options.hooks.recordDispatch(receipt, persisted.commit);
    } catch (error) {
      throw new MediaExecutionPhaseError(
        "dispatch-receipt",
        "media dispatch succeeded but its exact receipt publication is incomplete",
        { cause: error },
      );
    }
    return this.resume({
      authority,
      request,
      reservationOid: args.reservationOid,
      receipt,
      ...(args.signal ? { signal: args.signal } : {}),
    });
  }

  async resumeDispatched(args: {
    authority: unknown;
    request: MediaAdapterRuntimeRequest;
    reservationOid: string;
    signal?: AbortSignal;
  }): Promise<MediaExecutionResult> {
    const authority = ObjectiveAssetAuthoritySchema.parse(args.authority);
    const request = verifyRequest(this.options.adapter, args.request);
    const invocation = request.invocation;
    let persisted: Awaited<ReturnType<typeof readMediaDispatchReceiptByInvocation>>;
    try {
      persisted = await readMediaDispatchReceiptByInvocation({
        store: this.options.store,
        authority,
        runId: invocation.runId,
        invocationDigest: invocation.digest,
      });
    } catch (error) {
      throw new MediaExecutionPhaseError(
        "dispatch-receipt",
        "media dispatch receipt is incomplete or invalid",
        { cause: error },
      );
    }
    if (persisted) {
      await this.options.hooks.recordDispatch(persisted.receipt, persisted.commit);
      return this.resume({
        authority,
        request,
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
        phase: "dispatch-receipt",
        state: "unknown",
        reason: "media dispatch was possible but its exact handle is unavailable",
        accounting: unavailableAccounting(invocation),
      });
      return { state: "unknown", phase: "dispatch-receipt", dispatchReceipt: null };
    }
    let handle: MediaAdapterHandle | null;
    try {
      handle = await this.options.adapter.recoverHandle(request);
    } catch (error) {
      throw new MediaExecutionPhaseError(
        "dispatch-receipt",
        "exact media dispatch handle recovery failed",
        { cause: error },
      );
    }
    if (!handle) {
      await this.options.hooks.recordTerminalFailure({
        invocation,
        phase: "dispatch-receipt",
        state: "unknown",
        reason: "media adapter could not identify the exact dispatched invocation",
        accounting: unavailableAccounting(invocation),
      });
      return { state: "unknown", phase: "dispatch-receipt", dispatchReceipt: null };
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
      request,
      reservationOid: args.reservationOid,
      receipt,
      ...(args.signal ? { signal: args.signal } : {}),
    });
  }

  async resumeStoredAssetSet(args: {
    authority: unknown;
    request: MediaAdapterRuntimeRequest;
    reservationOid: string;
    assetSet: AssetSet;
    assetSetCommitOid: string;
  }): Promise<MediaExecutionResult> {
    const authority = ObjectiveAssetAuthoritySchema.parse(args.authority);
    const request = verifyRequest(this.options.adapter, args.request);
    const invocation = request.invocation;
    const assetSet = AssetSetSchema.parse(args.assetSet);
    if (
      authority.baseSha !== invocation.authorityBaseSha ||
      assetSet.runId !== invocation.runId ||
      assetSet.workItem !== invocation.workItem ||
      assetSet.attempt !== invocation.attempt ||
      assetSet.intentId !== invocation.intentId ||
      assetSet.intentDigest !== invocation.intentDigest ||
      assetSet.invocationDigest !== invocation.digest
    )
      throw new Error("durable media Asset Set differs from its reserved invocation");
    const persisted = await readMediaDispatchReceiptByInvocation({
      store: this.options.store,
      authority,
      runId: invocation.runId,
      invocationDigest: invocation.digest,
    });
    if (!persisted || persisted.receipt.digest !== assetSet.dispatchReceiptDigest)
      throw new MediaExecutionPhaseError(
        "dispatch-receipt",
        "durable media Asset Set lacks its exact dispatch receipt",
      );
    await this.options.hooks.recordDispatch(persisted.receipt, persisted.commit);
    await this.options.hooks.recordAssetSet(assetSet, args.assetSetCommitOid);
    await this.options.hooks.recordUsageSettled(invocation, {
      providerRequests: invocation.usageReservation.providerRequests,
      variants: assetSet.variants.length,
      generatedBytes: assetSet.totalGeneratedBytes,
      storageBytes: assetSet.totalStorageBytes,
      native: exactUsage(invocation, assetSet.usage),
    });
    const cleanupPending = !(await this.cleanup(request, {
      invocationId: persisted.receipt.invocationId,
      providerRequestId: persisted.receipt.providerRequestId,
      dispatchedAt: persisted.receipt.dispatchedAt,
    }));
    return {
      state: "for-review",
      dispatchReceipt: persisted.receipt,
      assetSet,
      cleanupPending,
    };
  }

  async resume(args: {
    authority: unknown;
    request: MediaAdapterRuntimeRequest;
    reservationOid: string;
    receipt: MediaDispatchReceipt;
    signal?: AbortSignal;
  }): Promise<MediaExecutionResult> {
    const authority = ObjectiveAssetAuthoritySchema.parse(args.authority);
    const request = verifyRequest(this.options.adapter, args.request);
    const invocation = request.invocation;
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
    let collection: MediaAdapterCollection | null;
    try {
      collection = await recoverRetainedMediaCollection({
        root: this.options.retentionRoot,
        invocation,
      });
    } catch (error) {
      throw new MediaExecutionPhaseError("retain", "retained media recovery failed", {
        cause: error,
      });
    }
    if (!collection) {
      const observedUntil = Date.now() + (this.options.observationWindowMs ?? 10_000);
      let observation;
      for (;;) {
        const cancellation = args.signal?.aborted || Date.parse(invocation.deadline) <= Date.now();
        try {
          if (cancellation) {
            if (!this.options.adapter.capability.recovery.cancellation) {
              await this.options.hooks.recordTerminalFailure({
                invocation,
                phase: "observe",
                state: "unknown",
                reason: "media invocation reached cancellation without exact adapter support",
                accounting: unavailableAccounting(invocation),
              });
              return { state: "unknown", phase: "observe", dispatchReceipt: receipt };
            }
            await this.options.adapter.cancel(request, handle);
          }
          observation = await this.options.adapter.observe(request, handle);
        } catch (error) {
          throw new MediaExecutionPhaseError("observe", "exact media observation failed", {
            cause: error,
          });
        }
        if (observation.state !== "running") break;
        if (Date.now() >= observedUntil) return { state: "running", dispatchReceipt: receipt };
        await delay(Math.min(250, Math.max(1, observedUntil - Date.now())));
      }
      if (observation.state === "unknown") {
        await this.options.hooks.recordTerminalFailure({
          invocation,
          phase: "observe",
          state: "unknown",
          reason: boundedReason(
            observation.reason ?? "exact media invocation outcome is unavailable",
          ),
          accounting: unavailableAccounting(invocation),
        });
        return { state: "unknown", phase: "observe", dispatchReceipt: receipt };
      }
      if (observation.state === "failed" || observation.state === "cancelled") {
        const accounting = {
          providerRequests: invocation.usageReservation.providerRequests,
          variants: 0,
          generatedBytes: 0,
          storageBytes: 0,
          native: exactUsage(invocation, observation.usage),
        };
        await this.options.hooks.recordTerminalFailure({
          invocation,
          phase: "observe",
          state: observation.state,
          reason: boundedReason(observation.reason ?? `media invocation ${observation.state}`),
          accounting,
        });
        const cleanupPending = !(await this.cleanup(request, handle));
        return {
          state: observation.state,
          dispatchReceipt: receipt,
          cleanupPending,
          definitiveNonExecution: false,
        };
      }
      try {
        collection = await this.options.adapter.collect(request, handle);
      } catch (error) {
        throw new MediaExecutionPhaseError("collect", "exact media collection failed", {
          cause: error,
        });
      }
      let native: Array<{ unit: string; amount: number | null }> =
        invocation.usageReservation.nativeUnits.map((unit) => ({ unit, amount: null }));
      try {
        native = exactUsage(invocation, collection.usage);
        await retainMediaCollection({
          root: this.options.retentionRoot,
          invocation,
          collection,
        });
      } catch (error) {
        if (!(error instanceof MediaCollectionValidationError))
          throw new MediaExecutionPhaseError("retain", "media retention is incomplete", {
            cause: error,
          });
        const generatedBytes = collection.variants.reduce(
          (total, variant) => total + variant.bytes.length,
          0,
        );
        await this.options.hooks.recordTerminalFailure({
          invocation,
          phase: "retain",
          state: "failed",
          reason: boundedReason(error.message),
          accounting: {
            providerRequests: invocation.usageReservation.providerRequests,
            variants: collection.variants.length,
            generatedBytes,
            storageBytes: 0,
            native,
          },
        });
        const cleanupPending = !(await this.cleanup(request, handle));
        return {
          state: "failed",
          dispatchReceipt: receipt,
          cleanupPending,
          definitiveNonExecution: false,
        };
      }
    } else {
      exactUsage(invocation, collection.usage);
    }
    let stored: Awaited<ReturnType<typeof persistAssetSet>>;
    try {
      stored = await persistAssetSet({
        store: this.options.store,
        authority,
        invocation,
        dispatchReceipt: receipt,
        collection,
        assertCurrent: this.options.assertCurrent,
      });
      await this.options.hooks.recordAssetSet(stored.assetSet, stored.commit);
    } catch (error) {
      throw new MediaExecutionPhaseError("store", "media Asset Set storage is incomplete", {
        cause: error,
      });
    }
    try {
      await this.options.hooks.recordUsageSettled(invocation, {
        providerRequests: invocation.usageReservation.providerRequests,
        variants: stored.assetSet.variants.length,
        generatedBytes: stored.assetSet.totalGeneratedBytes,
        storageBytes: stored.assetSet.totalStorageBytes,
        native: stored.assetSet.usage,
      });
    } catch (error) {
      throw new MediaExecutionPhaseError("account", "media accounting publication is incomplete", {
        cause: error,
      });
    }
    const cleanupPending = !(await this.cleanup(request, handle));
    return {
      state: "for-review",
      dispatchReceipt: receipt,
      assetSet: stored.assetSet,
      cleanupPending,
    };
  }

  private async cleanup(
    request: MediaAdapterRuntimeRequest,
    handle: MediaAdapterHandle,
  ): Promise<boolean> {
    const invocation = request.invocation;
    try {
      await this.options.adapter.cleanup(request, handle);
      await removeRetainedMediaCollection(this.options.retentionRoot, invocation.digest);
      await this.options.hooks.recordCleanupCompleted(invocation);
      return true;
    } catch (error) {
      await this.options.hooks.recordCleanupFailure(
        invocation,
        boundedReason(`cleanup phase retained its resource fence: ${String(error)}`),
      );
      return false;
    }
  }
}
