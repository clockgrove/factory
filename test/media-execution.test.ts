import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { assetDigest, withAssetDigest } from "../src/assets/contracts.js";
import type { GitCommitObject } from "../src/control/lease.js";
import { releaseAllArtifactContent } from "../src/execution/artifact-content.js";
import {
  SHARP_RASTER_MEDIA_CAPABILITY,
  SharpRasterMediaAdapter,
  type MediaProducerAdapter,
} from "../src/media/adapter.js";
import { MediaProductionExecutor, type MediaExecutionHooks } from "../src/media/execution.js";
import { AssetActivationSchema, withMediaDigest } from "../src/media/contracts.js";
import {
  activateWorkerPacket,
  createAssetDecision,
  createMediaInvocation,
} from "../src/media/lifecycle.js";
import {
  LOCAL_PRIVATE_MEDIA_REVIEW_CAPABILITY,
  LocalPrivateMediaReviewer,
  mediaReviewRuleDigest,
  policyMediaReviewRules,
} from "../src/media/review.js";
import {
  createAssetActivation,
  persistAssetActivation,
  persistAssetDecision,
  readAssetActivation,
  readAssetDecisionByAssetSet,
  readMediaDispatchReceiptByInvocation,
} from "../src/media/storage.js";
import type { MediaStore } from "../src/media/storage.js";
import type {
  AssetProductionWorkerPacket,
  RepositoryChangeWorkerPacket,
} from "../src/protocol/worker-packet.js";

const roots: string[] = [];
afterEach(async () => {
  await releaseAllArtifactContent();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const gitOid = (bytes: Buffer) =>
  createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");

const REFERENCE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWPgUbL4D8IMMAYALGgFlcy8lt0AAAAASUVORK5CYII=",
  "base64",
);
const REFERENCE_DIGEST = createHash("sha256").update(REFERENCE_PNG).digest("hex");
const REFERENCE_DESCRIPTOR = withAssetDigest({
  protocol: "clockgrove.factory/asset-descriptor" as const,
  content: {
    protocol: "clockgrove.factory/asset-content" as const,
    digest: REFERENCE_DIGEST,
    bytes: REFERENCE_PNG.length,
    inspection: {
      status: "semantic-valid" as const,
      handlerId: "sharp-raster",
      handlerContract: 1,
      mediaType: "image/png",
      metadata: {
        kind: "raster" as const,
        format: "png" as const,
        width: 2,
        height: 2,
        frames: 1,
        channels: 4,
        hasAlpha: true,
        decodedBytes: 16,
      },
    },
  },
  displayName: "composition.png",
  provenance: {
    kind: "local-file" as const,
    importId: "composition",
    originalName: "composition.png",
  },
  visibility: "private" as const,
  rights: { basis: "user-owned" as const },
  materializationPath: `assets/${REFERENCE_DIGEST}/composition.png`,
});
const REFERENCE_STORAGE = withAssetDigest({
  protocol: "clockgrove.factory/asset-storage-receipt" as const,
  authority: { repository: "fixture/project", objective: 7, baseSha: "b".repeat(40) },
  descriptorDigest: REFERENCE_DESCRIPTOR.digest,
  transferDomain: "objective-asset" as const,
  payload: {
    kind: "content-chunks" as const,
    digest: REFERENCE_DIGEST,
    bytes: REFERENCE_PNG.length,
    chunks: [{ digest: REFERENCE_DIGEST, bytes: REFERENCE_PNG.length }],
  },
  transferRef: "refs/clockgrove-factory/artifact-transfers/reference",
  transferRequestId: "reference",
  intentCommit: "1".repeat(40),
  readyCommit: "2".repeat(40),
});
const REFERENCE_ENTRY = { descriptor: REFERENCE_DESCRIPTOR, storage: REFERENCE_STORAGE };

function memoryStore() {
  const blobs = new Map<string, Buffer>();
  const trees = new Map<string, Map<string, string>>();
  const commits = new Map<string, GitCommitObject>();
  const refs = new Map<string, string>();
  const store: MediaStore = {
    readRef: async (ref) => refs.get(ref) ?? null,
    readCommit: async (oid) => {
      const commit = commits.get(oid);
      if (!commit) throw new Error(`missing commit ${oid}`);
      return commit;
    },
    readTreeEntry: async (tree, path) => trees.get(tree)?.get(path) ?? null,
    readBlob: async (oid) => {
      const bytes = blobs.get(oid);
      if (!bytes) throw new Error(`missing blob ${oid}`);
      return Buffer.from(bytes);
    },
    createBlob: async (bytes) => {
      const oid = gitOid(bytes);
      blobs.set(oid, Buffer.from(bytes));
      return oid;
    },
    createTree: async ({ entries }) => {
      const oid = createHash("sha1").update(JSON.stringify(entries)).digest("hex");
      trees.set(oid, new Map(entries.map((entry) => [entry.path, entry.sha])));
      return oid;
    },
    createCommit: async ({ treeOid, parentOids, message }) => {
      const oid = createHash("sha1")
        .update(JSON.stringify({ treeOid, parentOids, message }))
        .digest("hex");
      commits.set(oid, { oid, treeOid, parentOids, message, serverTime: new Date(0) });
      return oid;
    },
    createRef: async (ref, oid) => {
      if (refs.has(ref)) return false;
      refs.set(ref, oid);
      return true;
    },
  };
  return { store, refs };
}

function packet(capabilityDigest = assetDigest(SHARP_RASTER_MEDIA_CAPABILITY)) {
  return {
    protocol: "clockgrove.factory/worker-packet" as const,
    goal: "Produce the bounded visual reference.",
    acceptanceCriteria: ["The immutable PNG has the exact requested profile."],
    allowedPaths: [] as [],
    preconditions: [],
    outOfScope: [],
    conventions: [],
    baseSha: "b".repeat(40),
    validationCommands: [] as [],
    requirements: {
      os: ["linux"],
      architecture: [],
      tools: [],
      services: [],
      networkDestinations: [],
      permittedSecretNames: [],
      trust: "managed" as const,
    },
    assetInputs: [
      {
        manifestDigest: "3".repeat(64),
        descriptorDigest: REFERENCE_DESCRIPTOR.digest,
        contentDigest: REFERENCE_DIGEST,
        storageReceiptDigest: REFERENCE_STORAGE.digest,
        path: REFERENCE_DESCRIPTOR.materializationPath,
      },
    ],
    deliverable: {
      kind: "asset-production" as const,
      contract: "clockgrove.factory/asset-set" as const,
      producerCapabilityId: SHARP_RASTER_MEDIA_CAPABILITY.id,
      producerCapabilityDigest: capabilityDigest,
      activationSelection: { minimumCount: 1, maximumCount: 1 },
      intent: {
        id: "hero-reference",
        role: "raster-derivative" as const,
        purpose: "implementation-reference" as const,
        necessity: "required" as const,
        obligationIds: ["visual-contract"],
        rationale: "The implementation consumes this exact reference.",
        brief: "Produce a deterministic two-pixel visual reference.",
        fulfillment: {
          kind: "produced" as const,
          inputRoleBindings: [
            { roleId: "source", importedAssetIds: ["composition"], inputIntentIds: [] },
          ],
        },
        output: {
          mediaTypes: ["image/png" as const],
          minimumCount: 1,
          maximumCount: 1,
          raster: {
            minimumWidth: 2,
            maximumWidth: 2,
            minimumHeight: 2,
            maximumHeight: 2,
            alpha: "required" as const,
            animation: "forbidden" as const,
          },
        },
        review: { kind: "human-required" as const },
        bindings: [
          {
            workItemId: "consumer",
            direction: "input-to" as const,
            criterionIds: ["visual-contract"],
          },
        ],
      },
    },
    generatedAssetRequirements: [],
    mediaUses: [
      {
        source: "imported",
        intentId: "hero-reference",
        role: "raster-derivative",
        inputRoleId: "source",
        brief: "Produce a deterministic two-pixel visual reference.",
        purpose: "implementation-reference",
        necessity: "required",
        obligationIds: ["visual-contract"],
        rationale: "The implementation consumes this exact reference.",
        direction: "input-to",
        criterionIds: [],
        descriptorDigests: [REFERENCE_DESCRIPTOR.digest],
        manifestDigest: "3".repeat(64),
      },
    ],
  } satisfies AssetProductionWorkerPacket;
}

function invocation(
  packetInput: AssetProductionWorkerPacket = packet(),
  deadline = "2099-01-01T00:00:00.000Z",
  capability = SHARP_RASTER_MEDIA_CAPABILITY,
) {
  return createMediaInvocation({
    repository: "fixture/project",
    objective: 7,
    runId: "run-media",
    workItem: 17,
    attempt: 1,
    packet: packetInput,
    capability,
    authorityBaseSha: "b".repeat(40),
    inputEntries: [REFERENCE_ENTRY],
    deadline,
    policyDigest: "c".repeat(64),
  });
}

async function requestFor(
  exact: ReturnType<typeof invocation>,
  packetInput: AssetProductionWorkerPacket = packet(exact.capabilityDigest),
) {
  const root = await mkdtemp(join(tmpdir(), "factory-media-input-"));
  roots.push(root);
  const path = join(root, REFERENCE_DESCRIPTOR.materializationPath);
  await mkdir(join(root, `assets/${REFERENCE_DIGEST}`), { recursive: true });
  await writeFile(path, REFERENCE_PNG, { mode: 0o444 });
  const runtimePacket = structuredClone(packetInput);
  runtimePacket.deliverable.producerCapabilityId = exact.adapterId;
  return {
    invocation: exact,
    packet: runtimePacket,
    inputRoot: root,
    checkpointRoot: join(root, "dispatch-checkpoints"),
    inputs: [
      {
        roleId: "source",
        descriptorDigest: REFERENCE_DESCRIPTOR.digest,
        contentDigest: REFERENCE_DIGEST,
        mediaType: "image/png",
        path,
      },
    ],
  };
}

function hooks() {
  const calls = {
    dispatching: 0,
    dispatches: 0,
    failures: [] as Array<{ state: string; accounting: unknown }>,
    sets: [] as string[],
    accounting: [] as unknown[],
    cleanupCompleted: 0,
    cleanupFailed: 0,
  };
  const value: MediaExecutionHooks = {
    markDispatching: async () => {
      calls.dispatching += 1;
    },
    recordDispatch: async () => {
      calls.dispatches += 1;
    },
    recordTerminalFailure: async ({ state, accounting }) => {
      calls.failures.push({ state, accounting });
    },
    recordAssetSet: async (set) => {
      calls.sets.push(set.digest);
    },
    recordUsageSettled: async (_invocation, accounting) => {
      calls.accounting.push(accounting);
    },
    recordCleanupFailure: async () => {
      calls.cleanupFailed += 1;
    },
    recordCleanupCompleted: async () => {
      calls.cleanupCompleted += 1;
    },
  };
  return { calls, hooks: value };
}

async function retentionRoot() {
  const root = await mkdtemp(join(tmpdir(), "factory-media-test-"));
  roots.push(root);
  return root;
}

describe("media production execution", () => {
  it("retains, transfers, accounts, and publishes every verified variant before review", async () => {
    const memory = memoryStore();
    const recorded = hooks();
    const executor = new MediaProductionExecutor({
      store: memory.store,
      retentionRoot: await retentionRoot(),
      adapter: new SharpRasterMediaAdapter(),
      hooks: recorded.hooks,
      assertCurrent: async () => {},
    });
    const exact = invocation();
    const result = await executor.runPrepared({
      authority: { repository: "fixture/project", objective: 7, baseSha: "b".repeat(40) },
      request: await requestFor(exact),
      reservationOid: "a".repeat(40),
    });
    expect(result).toMatchObject({ state: "for-review", cleanupPending: false });
    expect(recorded.calls).toMatchObject({
      dispatching: 1,
      dispatches: 1,
      cleanupCompleted: 1,
      cleanupFailed: 0,
    });
    expect(recorded.calls.sets).toHaveLength(1);
    expect(recorded.calls.accounting).toEqual([
      expect.objectContaining({
        providerRequests: 0,
        variants: 1,
        native: [
          { unit: "generated_bytes", amount: expect.any(Number) },
          { unit: "output_count", amount: 1 },
        ],
      }),
    ]);
    expect(
      await readMediaDispatchReceiptByInvocation({
        store: memory.store,
        authority: { repository: "fixture/project", objective: 7, baseSha: "b".repeat(40) },
        runId: exact.runId,
        invocationDigest: exact.digest,
      }),
    ).toMatchObject({ receipt: { invocationDigest: exact.digest } });
  });

  it("recovers the same local invocation after its prepared checkpoint", async () => {
    const adapter = new SharpRasterMediaAdapter();
    const exact = invocation();
    const request = await requestFor(exact);
    const directory = join(request.checkpointRoot, exact.digest);
    await mkdir(directory, { recursive: true });
    const handle = {
      invocationId: exact.invocationId,
      providerRequestId: null,
      dispatchedAt: "2026-01-01T00:00:00.000Z",
    };
    await writeFile(
      join(directory, "prepared.json"),
      JSON.stringify({
        protocol: "clockgrove.factory/local-media-prepared-v1",
        invocationDigest: exact.digest,
        handle,
      }),
    );
    await expect(adapter.recoverHandle(request)).resolves.toEqual(handle);
    await expect(adapter.collect(request, handle)).resolves.toMatchObject({
      variants: [expect.objectContaining({ bytes: expect.any(Buffer) })],
    });
  });

  it("keeps completed local variant bytes while finishing a partial checkpoint", async () => {
    const adapter = new SharpRasterMediaAdapter();
    const twoVariantPacket = structuredClone(packet()) as AssetProductionWorkerPacket;
    twoVariantPacket.deliverable.intent.output.minimumCount = 2;
    twoVariantPacket.deliverable.intent.output.maximumCount = 2;
    const exact = invocation(twoVariantPacket);
    const source = await requestFor(exact, twoVariantPacket);
    const handle = await adapter.dispatch(source);
    const sourceDirectory = join(source.checkpointRoot, exact.digest);
    const firstBytes = await readFile(join(sourceDirectory, "variant-1.bin"));
    const target = await requestFor(exact, twoVariantPacket);
    const targetDirectory = join(target.checkpointRoot, exact.digest);
    await mkdir(targetDirectory, { recursive: true });
    await writeFile(
      join(targetDirectory, "prepared.json"),
      JSON.stringify({
        protocol: "clockgrove.factory/local-media-prepared-v1",
        invocationDigest: exact.digest,
        handle,
      }),
    );
    await writeFile(join(targetDirectory, "variant-1.bin"), firstBytes);
    await expect(adapter.recoverHandle(target)).resolves.toEqual(handle);
    expect(await readFile(join(targetDirectory, "variant-1.bin"))).toEqual(firstBytes);
    await expect(adapter.collect(target, handle)).resolves.toMatchObject({
      variants: [{}, {}],
    });
  });

  it("keeps unavailable native usage nullable after invalid adapter accounting", async () => {
    const base = new SharpRasterMediaAdapter();
    const adapter: MediaProducerAdapter = {
      capability: base.capability,
      probe: () => base.probe(),
      dispatch: (value) => base.dispatch(value),
      recoverHandle: (value) => base.recoverHandle(value),
      observe: (value, handle) => base.observe(value, handle),
      collect: async (value, handle) => ({
        ...(await base.collect(value, handle)),
        usage: [{ unit: "output_count", amount: 1 }],
      }),
      cancel: (value, handle) => base.cancel(value, handle),
      cleanup: (value, handle) => base.cleanup(value, handle),
    };
    const recorded = hooks();
    const result = await new MediaProductionExecutor({
      store: memoryStore().store,
      retentionRoot: await retentionRoot(),
      adapter,
      hooks: recorded.hooks,
      assertCurrent: async () => {},
    }).runPrepared({
      authority: { repository: "fixture/project", objective: 7, baseSha: "b".repeat(40) },
      request: await requestFor(invocation()),
      reservationOid: "a".repeat(40),
    });
    expect(result).toMatchObject({ state: "failed" });
    expect(recorded.calls.failures).toEqual([
      expect.objectContaining({
        accounting: expect.objectContaining({
          native: [
            { unit: "generated_bytes", amount: null },
            { unit: "output_count", amount: null },
          ],
        }),
      }),
    ]);
  });

  it("honors a raster profile that forbids alpha", async () => {
    const forbidden = structuredClone(packet()) as AssetProductionWorkerPacket;
    if (!forbidden.deliverable.intent.output.raster) throw new Error("expected raster intent");
    forbidden.deliverable.intent.output.raster.alpha = "forbidden";
    const exact = invocation(forbidden);
    const result = await new MediaProductionExecutor({
      store: memoryStore().store,
      retentionRoot: await retentionRoot(),
      adapter: new SharpRasterMediaAdapter(),
      hooks: hooks().hooks,
      assertCurrent: async () => {},
    }).runPrepared({
      authority: { repository: "fixture/project", objective: 7, baseSha: "b".repeat(40) },
      request: await requestFor(exact, forbidden),
      reservationOid: "a".repeat(40),
    });
    expect(result.state).toBe("for-review");
    if (result.state !== "for-review") throw new Error("expected reviewable result");
    expect(result.assetSet.variants[0]!.descriptor.content.inspection.metadata).toMatchObject({
      kind: "raster",
      hasAlpha: false,
    });
  });

  it("refuses before the dispatch marker without launching", async () => {
    const memory = memoryStore();
    const recorded = hooks();
    let launches = 0;
    const base = new SharpRasterMediaAdapter();
    const adapter: MediaProducerAdapter = {
      ...base,
      capability: base.capability,
      probe: async () => ({ available: false, authenticated: false, reason: "offline" }),
      dispatch: async (value) => {
        launches += 1;
        return base.dispatch(value);
      },
      observe: (value, handle) => base.observe(value, handle),
      collect: (value, handle) => base.collect(value, handle),
      cancel: (value, handle) => base.cancel(value, handle),
      cleanup: (value, handle) => base.cleanup(value, handle),
    };
    const executor = new MediaProductionExecutor({
      store: memory.store,
      retentionRoot: await retentionRoot(),
      adapter,
      hooks: recorded.hooks,
      assertCurrent: async () => {},
    });
    await expect(
      executor.runPrepared({
        authority: { repository: "fixture/project", objective: 7, baseSha: "b".repeat(40) },
        request: await requestFor(invocation()),
        reservationOid: "a".repeat(40),
      }),
    ).resolves.toMatchObject({ state: "failed", definitiveNonExecution: true });
    expect(launches).toBe(0);
    expect(recorded.calls.dispatching).toBe(0);
  });

  it("records unknown after a possible dispatch and never launches during recovery", async () => {
    const memory = memoryStore();
    const paidCapability = {
      ...SHARP_RASTER_MEDIA_CAPABILITY,
      id: "fixture/remote-raster-v1",
      limits: { ...SHARP_RASTER_MEDIA_CAPABILITY.limits, providerRequests: 1 },
    };
    const paidPacket = packet(assetDigest(paidCapability));
    paidPacket.deliverable.producerCapabilityId = paidCapability.id;
    const exact = invocation(paidPacket, "2099-01-01T00:00:00.000Z", paidCapability);
    let launches = 0;
    const adapter: MediaProducerAdapter = {
      capability: paidCapability,
      probe: async () => ({ available: true, authenticated: true }),
      dispatch: async () => {
        launches += 1;
        throw new Error("lost acknowledgement");
      },
      observe: async () => {
        throw new Error("must not observe without an exact handle");
      },
      collect: async () => {
        throw new Error("must not collect without an exact handle");
      },
      cancel: async () => {},
      cleanup: async () => {},
    };
    const first = hooks();
    const executor = new MediaProductionExecutor({
      store: memory.store,
      retentionRoot: await retentionRoot(),
      adapter,
      hooks: first.hooks,
      assertCurrent: async () => {},
    });
    await expect(
      executor.runPrepared({
        authority: { repository: "fixture/project", objective: 7, baseSha: "b".repeat(40) },
        request: await requestFor(exact),
        reservationOid: "a".repeat(40),
      }),
    ).resolves.toMatchObject({ state: "unknown", dispatchReceipt: null });
    expect(launches).toBe(1);
    const recovered = hooks();
    const recovery = new MediaProductionExecutor({
      store: memory.store,
      retentionRoot: await retentionRoot(),
      adapter,
      hooks: recovered.hooks,
      assertCurrent: async () => {},
    });
    await expect(
      recovery.resumeDispatched({
        authority: { repository: "fixture/project", objective: 7, baseSha: "b".repeat(40) },
        request: await requestFor(exact),
        reservationOid: "a".repeat(40),
      }),
    ).resolves.toMatchObject({ state: "unknown", dispatchReceipt: null });
    expect(launches).toBe(1);
    expect(recovered.calls.failures).toEqual([
      expect.objectContaining({
        state: "unknown",
        accounting: expect.objectContaining({
          providerRequests: null,
          variants: null,
          generatedBytes: null,
          storageBytes: null,
        }),
      }),
    ]);
  });

  it("recovers the deterministic local invocation by identity without redispatch", async () => {
    const memory = memoryStore();
    const recorded = hooks();
    const base = new SharpRasterMediaAdapter();
    let launches = 0;
    const adapter: MediaProducerAdapter = {
      capability: base.capability,
      probe: () => base.probe(),
      dispatch: async (value) => {
        launches += 1;
        return base.dispatch(value);
      },
      recoverHandle: (value) => base.recoverHandle(value),
      observe: (value, handle) => base.observe(value, handle),
      collect: (value, handle) => base.collect(value, handle),
      cancel: (value, handle) => base.cancel(value, handle),
      cleanup: (value, handle) => base.cleanup(value, handle),
    };
    const executor = new MediaProductionExecutor({
      store: memory.store,
      retentionRoot: await retentionRoot(),
      adapter,
      hooks: recorded.hooks,
      assertCurrent: async () => {},
    });
    const exact = invocation();
    const prepared = await requestFor(exact);
    await base.dispatch(prepared);
    await expect(
      executor.resumeDispatched({
        authority: { repository: "fixture/project", objective: 7, baseSha: "b".repeat(40) },
        request: prepared,
        reservationOid: "a".repeat(40),
      }),
    ).resolves.toMatchObject({ state: "for-review", cleanupPending: false });
    expect(launches).toBe(0);
    expect(recorded.calls.dispatches).toBe(1);
  });

  it("cancels, observes, and cleans up the same exact invocation at its deadline", async () => {
    const memory = memoryStore();
    const recorded = hooks();
    const base = new SharpRasterMediaAdapter();
    let cancellations = 0;
    const adapter: MediaProducerAdapter = {
      capability: base.capability,
      probe: () => base.probe(),
      dispatch: (value) => base.dispatch(value),
      recoverHandle: async (value) => ({
        invocationId: value.invocation.invocationId,
        providerRequestId: null,
        dispatchedAt: "2025-12-31T23:59:59.000Z",
      }),
      observe: async () => ({
        state: "cancelled",
        observedAt: new Date().toISOString(),
        providerResponseId: null,
        usage: [
          { unit: "output_count", amount: 0 },
          { unit: "generated_bytes", amount: 0 },
        ],
      }),
      collect: (value, handle) => base.collect(value, handle),
      cancel: async () => {
        cancellations += 1;
      },
      cleanup: (value, handle) => base.cleanup(value, handle),
    };
    const result = await new MediaProductionExecutor({
      store: memory.store,
      retentionRoot: await retentionRoot(),
      adapter,
      hooks: recorded.hooks,
      assertCurrent: async () => {},
    }).resumeDispatched({
      authority: { repository: "fixture/project", objective: 7, baseSha: "b".repeat(40) },
      request: await requestFor(invocation(packet(), "2026-01-01T00:00:00.000Z")),
      reservationOid: "a".repeat(40),
    });
    expect(result).toMatchObject({ state: "cancelled", cleanupPending: false });
    expect(cancellations).toBe(1);
    expect(recorded.calls.cleanupCompleted).toBe(1);
  });

  it("rejects a changed producer capability and keeps non-raster profiles media-agnostic", () => {
    expect(() => invocation(packet("d".repeat(64)))).toThrow(/capability changed/);
    const binaryCapability = {
      ...SHARP_RASTER_MEDIA_CAPABILITY,
      id: "fixture/local-audio-v1",
      inputRoles: [] as never[],
      outputMediaTypes: ["audio/wav"],
      intentRoles: ["sound-reference" as const],
      profiles: [{ kind: "binary" as const }],
    };
    const binaryPacket = structuredClone(
      packet(assetDigest(binaryCapability)),
    ) as unknown as AssetProductionWorkerPacket;
    binaryPacket.deliverable.producerCapabilityId = binaryCapability.id;
    binaryPacket.assetInputs = [];
    binaryPacket.deliverable.intent.role = "sound-reference";
    binaryPacket.deliverable.intent.fulfillment = {
      kind: "produced",
      inputRoleBindings: [],
    };
    binaryPacket.mediaUses = [];
    binaryPacket.deliverable.intent.output = {
      mediaTypes: ["audio/wav"],
      minimumCount: 1,
      maximumCount: 1,
      raster: null,
    };
    const exact = createMediaInvocation({
      repository: "fixture/project",
      objective: 7,
      runId: "run-media",
      workItem: 17,
      attempt: 1,
      packet: binaryPacket,
      capability: binaryCapability,
      authorityBaseSha: "b".repeat(40),
      inputEntries: [],
      deadline: "2099-01-01T00:00:00.000Z",
      policyDigest: "c".repeat(64),
    });
    expect(exact.profile).toEqual({ kind: "binary" });
    expect(exact.outputMediaType).toBe("audio/wav");
    expect(exact.profile).not.toHaveProperty("width");
    const svgCapability = {
      ...binaryCapability,
      id: "fixture/local-vector-v1",
      outputMediaTypes: ["image/svg+xml"],
      intentRoles: ["vector-reference"],
    };
    const svgPacket = structuredClone(
      packet(assetDigest(svgCapability)),
    ) as unknown as AssetProductionWorkerPacket;
    svgPacket.deliverable.producerCapabilityId = svgCapability.id;
    svgPacket.assetInputs = [];
    svgPacket.mediaUses = [];
    svgPacket.deliverable.intent.role = "vector-reference";
    svgPacket.deliverable.intent.fulfillment = { kind: "produced", inputRoleBindings: [] };
    svgPacket.deliverable.intent.output = {
      mediaTypes: ["image/svg+xml"],
      minimumCount: 1,
      maximumCount: 1,
      raster: null,
    };
    expect(
      createMediaInvocation({
        repository: "fixture/project",
        objective: 7,
        runId: "run-media",
        workItem: 17,
        attempt: 1,
        packet: svgPacket,
        capability: svgCapability,
        authorityBaseSha: "b".repeat(40),
        inputEntries: [],
        deadline: "2099-01-01T00:00:00.000Z",
        policyDigest: "c".repeat(64),
      }),
    ).toMatchObject({ profile: { kind: "binary" }, outputMediaType: "image/svg+xml" });
  });

  it("chooses an exact raster profile inside a compiler-valid open interval", () => {
    const compiledPacket = structuredClone(packet()) as AssetProductionWorkerPacket;
    compiledPacket.deliverable.intent.output.raster = {
      minimumWidth: 2_048,
      maximumWidth: null,
      minimumHeight: 2_048,
      maximumHeight: null,
      alpha: "allowed",
      animation: "forbidden",
    };

    expect(invocation(compiledPacket).profile).toEqual({
      kind: "raster",
      width: 2_048,
      height: 2_048,
      alpha: false,
      animation: false,
    });
  });

  it("refuses product production without authenticated output rights", () => {
    const productPacket = structuredClone(packet()) as AssetProductionWorkerPacket;
    productPacket.deliverable.intent.purpose = "product-asset";
    expect(() => invocation(productPacket)).toThrow(/does not apply/);
  });

  it("advertises only registered authorized review rules and uses the canonical decision", async () => {
    expect(
      policyMediaReviewRules({
        compilerMediaEgress: {
          deterministicReviewRuleIds: [
            "unregistered-rule",
            LOCAL_PRIVATE_MEDIA_REVIEW_CAPABILITY.id,
          ],
        },
      }),
    ).toEqual([
      {
        id: LOCAL_PRIVATE_MEDIA_REVIEW_CAPABILITY.id,
        kind: "deterministic-preauthorized",
        producerCapabilityIds: LOCAL_PRIVATE_MEDIA_REVIEW_CAPABILITY.producerCapabilityIds,
        roles: LOCAL_PRIVATE_MEDIA_REVIEW_CAPABILITY.applicableRoles,
        purposes: LOCAL_PRIVATE_MEDIA_REVIEW_CAPABILITY.applicablePurposes,
        mediaTypes: LOCAL_PRIVATE_MEDIA_REVIEW_CAPABILITY.applicableMediaTypes,
        profiles: LOCAL_PRIVATE_MEDIA_REVIEW_CAPABILITY.profiles,
        outputVisibilities: LOCAL_PRIVATE_MEDIA_REVIEW_CAPABILITY.outputVisibilities,
        rightsBases: LOCAL_PRIVATE_MEDIA_REVIEW_CAPABILITY.rightsBases,
        selectionStrategy: LOCAL_PRIVATE_MEDIA_REVIEW_CAPABILITY.selectionStrategy,
      },
    ]);
    const memory = memoryStore();
    const recorded = hooks();
    const reviewPacket = structuredClone(packet()) as AssetProductionWorkerPacket;
    reviewPacket.deliverable.intent.output.minimumCount = 4;
    reviewPacket.deliverable.intent.output.maximumCount = 4;
    const exact = invocation(reviewPacket);
    const result = await new MediaProductionExecutor({
      store: memory.store,
      retentionRoot: await retentionRoot(),
      adapter: new SharpRasterMediaAdapter(),
      hooks: recorded.hooks,
      assertCurrent: async () => {},
    }).runPrepared({
      authority: { repository: "fixture/project", objective: 7, baseSha: "b".repeat(40) },
      request: await requestFor(exact, reviewPacket),
      reservationOid: "a".repeat(40),
    });
    expect(result.state).toBe("for-review");
    if (result.state !== "for-review") throw new Error("expected reviewable asset set");
    const reviewer = new LocalPrivateMediaReviewer();
    const reviewed = reviewer.review(exact, result.assetSet);
    const decision = createAssetDecision({
      kind: reviewed.kind,
      requestId: "deterministic-review",
      requestedBy: `rule:${reviewer.capability.id}`,
      assetSet: result.assetSet,
      producerReservationOid: "a".repeat(40),
      selectedDescriptorDigests: reviewed.selectedDescriptorDigests,
      rule: { id: reviewer.capability.id, digest: mediaReviewRuleDigest(reviewer) },
    });
    expect(decision).toMatchObject({
      kind: "approved",
      ruleId: reviewer.capability.id,
      ruleDigest: assetDigest(reviewer.capability),
      selectedDescriptorDigests: [result.assetSet.variants[0]!.descriptor.digest],
    });
    expect(result.assetSet.variants).toHaveLength(4);
    expect(result.assetSet.activationSelection).toEqual({ minimumCount: 1, maximumCount: 1 });
  });

  it("indexes one immutable decision per request and Asset Set before activation", async () => {
    const memory = memoryStore();
    const exact = invocation();
    const result = await new MediaProductionExecutor({
      store: memory.store,
      retentionRoot: await retentionRoot(),
      adapter: new SharpRasterMediaAdapter(),
      hooks: hooks().hooks,
      assertCurrent: async () => {},
    }).runPrepared({
      authority: { repository: "fixture/project", objective: 7, baseSha: "b".repeat(40) },
      request: await requestFor(exact),
      reservationOid: "a".repeat(40),
    });
    if (result.state !== "for-review") throw new Error("expected reviewable asset set");
    const authority = { repository: "fixture/project", objective: 7, baseSha: "b".repeat(40) };
    const decision = createAssetDecision({
      kind: "approved",
      requestId: "human-approval",
      requestedBy: "fixture-actor",
      assetSet: result.assetSet,
      producerReservationOid: "a".repeat(40),
      selectedDescriptorDigests: result.assetSet.variants.map(
        ({ descriptor }) => descriptor.digest,
      ),
    });
    const first = await persistAssetDecision({
      store: memory.store,
      authority,
      decision,
      parentOids: [],
      assertCurrent: async () => {},
    });
    const repeated = await persistAssetDecision({
      store: memory.store,
      authority,
      decision,
      parentOids: [],
      assertCurrent: async () => {},
    });
    expect(repeated.commit).toBe(first.commit);
    expect(
      await readAssetDecisionByAssetSet({
        store: memory.store,
        authority,
        runId: exact.runId,
        assetSetDigest: result.assetSet.digest,
      }),
    ).toMatchObject({ decision: { digest: decision.digest } });
    const conflict = createAssetDecision({
      kind: "rejected",
      requestId: decision.requestId,
      requestedBy: "fixture-actor",
      assetSet: result.assetSet,
      producerReservationOid: "a".repeat(40),
      reasonDigest: "e".repeat(64),
    });
    await expect(
      persistAssetDecision({
        store: memory.store,
        authority,
        decision: conflict,
        parentOids: [],
        assertCurrent: async () => {},
      }),
    ).rejects.toThrow(/conflicted/);
    const activation = createAssetActivation({
      assetSet: result.assetSet,
      decision,
      producerReservationOid: "a".repeat(40),
    });
    const stored = await persistAssetActivation({
      store: memory.store,
      authority,
      activation,
      parentOids: [first.commit, ...activation.selected.map(({ storage }) => storage.readyCommit)],
      assertCurrent: async () => {},
    });
    expect(
      await readAssetActivation({
        store: memory.store,
        authority,
        runId: exact.runId,
        digest: activation.digest,
      }),
    ).toMatchObject({
      record: {
        digest: activation.digest,
        selected: [
          expect.objectContaining({
            descriptor: expect.objectContaining({ digest: decision.selectedDescriptorDigests[0] }),
            storage: expect.objectContaining({ readyCommit: expect.any(String) }),
          }),
        ],
      },
      commit: stored.commit,
    });

    // The shared Supervisor fixture constructs repository-only graphs and its backend mocks assume
    // every graph item emits a patch. FactorySupervisor also owns the concrete media registry and
    // authenticated asset stores rather than accepting fixture injection. Expanding that harness
    // would recreate the scheduler and Git authority machinery. Exercise the exact boundary the
    // scheduler calls instead: a real retained Asset Set, decision, and activation become the
    // immutable repository packet/bundle reserved before ordinary backend admission.
    const repositorySource: RepositoryChangeWorkerPacket = {
      protocol: "clockgrove.factory/worker-packet",
      goal: "Consume the exact approved media input.",
      acceptanceCriteria: ["The repository consumer receives the approved descriptor."],
      allowedPaths: ["src/"],
      preconditions: [],
      outOfScope: [],
      conventions: [],
      baseSha: exact.authorityBaseSha,
      validationCommands: ["node --test"],
      requirements: {
        os: ["linux"],
        architecture: [],
        tools: ["node"],
        services: [],
        networkDestinations: [],
        permittedSecretNames: [],
        trust: "trusted_local",
      },
      assetInputs: [],
      deliverable: {
        kind: "repository-change",
        contract: "clockgrove.factory/artifact",
      },
      generatedAssetRequirements: [
        {
          intentId: activation.intentId,
          producerWorkItemId: "asset-producer",
          role: "raster-derivative",
          purpose: "implementation-reference",
          necessity: "required",
          obligationIds: ["visual-contract"],
          brief: "Use the approved immutable media input.",
          rationale: "The repository implementation is grounded in the reviewed bytes.",
          direction: "input-to",
          criterionIds: ["approved-media"],
          inputRoleId: null,
        },
      ],
      mediaUses: [],
    };
    const consumer = activateWorkerPacket({
      sourcePacket: repositorySource,
      consumerWorkItemId: "repository-consumer",
      activations: [activation],
      producerIssueNumbers: { "asset-producer": exact.workItem },
    });
    expect(consumer.packet.assetInputs).toEqual([
      {
        manifestDigest: activation.storageManifestDigest,
        descriptorDigest: activation.selected[0]!.descriptor.digest,
        contentDigest: activation.selected[0]!.descriptor.content.digest,
        storageReceiptDigest: activation.selected[0]!.storage.digest,
        path: activation.selected[0]!.descriptor.materializationPath,
      },
    ]);
    expect(consumer.packet.mediaUses).toEqual([
      expect.objectContaining({
        source: "activated",
        activationDigest: activation.digest,
        descriptorDigests: [activation.selected[0]!.descriptor.digest],
      }),
    ]);
    expect(consumer.bundle).toMatchObject({
      consumerWorkItemId: "repository-consumer",
      activations: [{ digest: activation.digest }],
    });
  });

  it("rejects an approval outside the compiled activation-selection interval", async () => {
    const memory = memoryStore();
    const twoVariantPacket: AssetProductionWorkerPacket = structuredClone(packet());
    twoVariantPacket.deliverable.intent.output.minimumCount = 2;
    twoVariantPacket.deliverable.intent.output.maximumCount = 2;
    twoVariantPacket.deliverable.activationSelection = { minimumCount: 2, maximumCount: 2 };
    const exact = invocation(twoVariantPacket);
    const result = await new MediaProductionExecutor({
      store: memory.store,
      retentionRoot: await retentionRoot(),
      adapter: new SharpRasterMediaAdapter(),
      hooks: hooks().hooks,
      assertCurrent: async () => {},
    }).runPrepared({
      authority: { repository: "fixture/project", objective: 7, baseSha: "b".repeat(40) },
      request: await requestFor(exact, twoVariantPacket),
      reservationOid: "a".repeat(40),
    });
    if (result.state !== "for-review") throw new Error("expected reviewable asset set");
    expect(result.assetSet.activationSelection).toEqual({ minimumCount: 2, maximumCount: 2 });
    expect(() =>
      createAssetDecision({
        kind: "approved",
        requestId: "undersized-approval",
        requestedBy: "fixture-actor",
        assetSet: result.assetSet,
        producerReservationOid: "a".repeat(40),
        selectedDescriptorDigests: [result.assetSet.variants[0]!.descriptor.digest],
      }),
    ).toThrow(/compiled activation interval/);
    expect(
      createAssetDecision({
        kind: "approved",
        requestId: "bounded-approval",
        requestedBy: "fixture-actor",
        assetSet: result.assetSet,
        producerReservationOid: "a".repeat(40),
        selectedDescriptorDigests: result.assetSet.variants.map(
          ({ descriptor }) => descriptor.digest,
        ),
      }).selectedDescriptorDigests,
    ).toHaveLength(2);
  });

  it("deduplicates activated transport bytes while preserving two producer input roles", async () => {
    const memory = memoryStore();
    const exact = invocation();
    const result = await new MediaProductionExecutor({
      store: memory.store,
      retentionRoot: await retentionRoot(),
      adapter: new SharpRasterMediaAdapter(),
      hooks: hooks().hooks,
      assertCurrent: async () => {},
    }).runPrepared({
      authority: { repository: "fixture/project", objective: 7, baseSha: "b".repeat(40) },
      request: await requestFor(exact),
      reservationOid: "a".repeat(40),
    });
    if (result.state !== "for-review") throw new Error("expected reviewable asset set");
    const decision = createAssetDecision({
      kind: "approved",
      requestId: "two-role-approval",
      requestedBy: "fixture-actor",
      assetSet: result.assetSet,
      producerReservationOid: "a".repeat(40),
      selectedDescriptorDigests: [result.assetSet.variants[0]!.descriptor.digest],
    });
    const activation = createAssetActivation({
      assetSet: result.assetSet,
      decision,
      producerReservationOid: "a".repeat(40),
    });
    const twoRoleCapability = {
      ...SHARP_RASTER_MEDIA_CAPABILITY,
      id: "fixture/two-role-raster-derivative-v1",
      inputRoles: [
        {
          id: "source",
          mediaTypes: ["image/png" as const],
          minimumCount: 1,
          maximumCount: 1,
          semantics: "directional-reference",
        },
        {
          id: "style",
          mediaTypes: ["image/png" as const],
          minimumCount: 1,
          maximumCount: 1,
          semantics: "directional-reference",
        },
      ],
    };
    const source: AssetProductionWorkerPacket = structuredClone(
      packet(assetDigest(twoRoleCapability)),
    );
    source.assetInputs = [];
    source.mediaUses = [];
    source.deliverable.producerCapabilityId = twoRoleCapability.id;
    source.deliverable.intent.id = "derived-output";
    source.deliverable.intent.fulfillment = {
      kind: "produced",
      inputRoleBindings: [
        { roleId: "source", importedAssetIds: [], inputIntentIds: [activation.intentId] },
        { roleId: "style", importedAssetIds: [], inputIntentIds: [activation.intentId] },
      ],
    };
    const requirement = {
      intentId: activation.intentId,
      producerWorkItemId: "media-producer",
      role: "raster-derivative",
      purpose: "implementation-reference" as const,
      necessity: "required" as const,
      obligationIds: ["visual-contract"],
      brief: "Use the exact approved upstream rendition.",
      rationale: "One immutable descriptor intentionally satisfies two semantic roles.",
      direction: "input-to" as const,
      criterionIds: [] as string[],
    };
    source.generatedAssetRequirements = [
      { ...requirement, inputRoleId: "source" },
      { ...requirement, inputRoleId: "style" },
    ];
    const activated = activateWorkerPacket({
      sourcePacket: source,
      consumerWorkItemId: "derived-producer",
      activations: [activation],
      producerIssueNumbers: { "media-producer": 17 },
    });
    expect(activated.packet.assetInputs).toHaveLength(1);
    expect(activated.packet.mediaUses).toMatchObject([
      { inputRoleId: "source", descriptorDigests: [activation.selected[0]!.descriptor.digest] },
      { inputRoleId: "style", descriptorDigests: [activation.selected[0]!.descriptor.digest] },
    ]);
    expect(activated.bundle?.activations).toHaveLength(1);

    const chained = createMediaInvocation({
      repository: "fixture/project",
      objective: 7,
      runId: exact.runId,
      workItem: 18,
      attempt: 1,
      packet: activated.packet,
      capability: twoRoleCapability,
      inputEntries: activation.selected,
      authorityBaseSha: "b".repeat(40),
      deadline: "2099-01-01T00:00:00.000Z",
      policyDigest: "c".repeat(64),
    });
    expect(chained.inputAssets).toMatchObject([
      { roleId: "source", descriptorDigest: activation.selected[0]!.descriptor.digest },
      { roleId: "style", descriptorDigest: activation.selected[0]!.descriptor.digest },
    ]);
  });

  it("preserves sixty-four semantic uses while deduplicating thirty-two transport inputs", () => {
    const hash = (value: string) => createHash("sha256").update(value).digest("hex");
    const importedInputs = Array.from({ length: 16 }, (_, index) => ({
      manifestDigest: hash(`import-manifest-${index}`),
      descriptorDigest: hash(`import-descriptor-${index}`),
      contentDigest: hash(`import-content-${index}`),
      storageReceiptDigest: hash(`import-storage-${index}`),
      path: `assets/${hash(`import-content-${index}`)}/import-${index}.bin`,
    }));
    const importedUses = importedInputs.flatMap((input, index) =>
      ["direction", "style"].map((inputRoleId) => ({
        source: "imported" as const,
        intentId: `import-${index}`,
        role: "opaque-reference",
        inputRoleId,
        brief: `Use imported input ${index} as ${inputRoleId}.`,
        purpose: "implementation-reference" as const,
        necessity: "required" as const,
        obligationIds: [`import-obligation-${index}`],
        rationale: "The same immutable bytes retain two distinct semantic uses.",
        direction: "input-to" as const,
        criterionIds: [] as string[],
        descriptorDigests: [input.descriptorDigest],
        manifestDigest: input.manifestDigest,
      })),
    );
    const activations = Array.from({ length: 16 }, (_, index) => {
      const contentDigest = hash(`activated-content-${index}`);
      const descriptor = withAssetDigest({
        protocol: "clockgrove.factory/asset-descriptor" as const,
        content: {
          protocol: "clockgrove.factory/asset-content" as const,
          digest: contentDigest,
          bytes: 1,
          inspection: {
            status: "opaque" as const,
            handlerId: "fixture-opaque",
            handlerContract: 1,
            mediaType: "application/octet-stream",
            metadata: { kind: "opaque" as const, reason: "Scale fixture bytes." },
          },
        },
        displayName: `activated-${index}.bin`,
        provenance: {
          kind: "produced" as const,
          invocationId: `scale-invocation-${index}`,
          outputIndex: 0,
          provider: null,
          providerRequestId: null,
        },
        visibility: "private" as const,
        rights: { basis: "unknown" as const },
        materializationPath: `assets/${contentDigest}/activated-${index}.bin`,
      });
      const storage = withAssetDigest({
        protocol: "clockgrove.factory/asset-storage-receipt" as const,
        authority: { repository: "fixture/project", objective: 7, baseSha: "b".repeat(40) },
        descriptorDigest: descriptor.digest,
        transferDomain: "produced-asset" as const,
        payload: {
          kind: "content-chunks" as const,
          digest: contentDigest,
          bytes: 1,
          chunks: [{ digest: contentDigest, bytes: 1 }],
        },
        transferRef: `refs/clockgrove-factory/artifact-transfers/scale-${index}`,
        transferRequestId: `scale-${index}`,
        intentCommit: hash(`intent-${index}`).slice(0, 40),
        readyCommit: hash(`ready-${index}`).slice(0, 40),
      });
      return AssetActivationSchema.parse(
        withMediaDigest({
          protocol: "clockgrove.factory/asset-activation-v1" as const,
          runId: "scale-run",
          intentId: `produced-${index}`,
          intentDigest: hash(`intent-digest-${index}`),
          producerWorkItem: 100 + index,
          producerAttempt: 1,
          producerReservationOid: hash(`reservation-${index}`).slice(0, 40),
          assetSetDigest: hash(`asset-set-${index}`),
          storageManifestDigest: hash(`storage-manifest-${index}`),
          decisionDigest: hash(`decision-${index}`),
          selected: [{ descriptor, storage }],
        }),
      );
    });
    const requirements = activations.flatMap((activation, index) =>
      ["source", "style"].map((inputRoleId) => ({
        intentId: activation.intentId,
        producerWorkItemId: `producer-${index}`,
        role: "opaque-product-part",
        purpose: "implementation-reference" as const,
        necessity: "required" as const,
        obligationIds: [`produced-obligation-${index}`],
        brief: `Use produced part ${index} as ${inputRoleId}.`,
        rationale: "Each role must survive independent of byte transport deduplication.",
        direction: "input-to" as const,
        criterionIds: [] as string[],
        inputRoleId,
      })),
    );
    const source: AssetProductionWorkerPacket = {
      ...structuredClone(packet()),
      assetInputs: importedInputs,
      mediaUses: importedUses,
      generatedAssetRequirements: requirements,
    };
    const activated = activateWorkerPacket({
      sourcePacket: source,
      consumerWorkItemId: "scale-join",
      activations,
      producerIssueNumbers: Object.fromEntries(
        activations.map((activation, index) => [`producer-${index}`, activation.producerWorkItem]),
      ),
    });
    expect(activated.packet.assetInputs ?? []).toHaveLength(32);
    expect(
      new Set((activated.packet.assetInputs ?? []).map(({ descriptorDigest }) => descriptorDigest))
        .size,
    ).toBe(32);
    expect(activated.packet.mediaUses ?? []).toHaveLength(64);
    expect(
      (activated.packet.mediaUses ?? []).filter(({ source }) => source === "activated"),
    ).toHaveLength(32);
    expect(activated.bundle?.activations).toHaveLength(16);
  });
});
