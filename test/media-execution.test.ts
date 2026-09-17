import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
import { createMediaInvocation } from "../src/media/lifecycle.js";
import { createAssetDecision } from "../src/media/lifecycle.js";
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
import type { AssetProductionWorkerPacket } from "../src/protocol/worker-packet.js";

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
      intent: {
        id: "hero-reference",
        kind: "layout-reference" as const,
        purpose: "implementation-reference" as const,
        necessity: "required" as const,
        obligationIds: ["visual-contract"],
        rationale: "The implementation consumes this exact reference.",
        brief: "Produce a deterministic two-pixel visual reference.",
        importedAssetIds: ["composition"],
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
  } satisfies AssetProductionWorkerPacket;
}

function invocation(
  packetInput = packet(),
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
    outputVisibility: "private",
    outputRights: { basis: "unknown" },
  });
}

async function requestFor(exact: ReturnType<typeof invocation>) {
  const root = await mkdtemp(join(tmpdir(), "factory-media-input-"));
  roots.push(root);
  const path = join(root, REFERENCE_DESCRIPTOR.materializationPath);
  await mkdir(join(root, `assets/${REFERENCE_DIGEST}`), { recursive: true });
  await writeFile(path, REFERENCE_PNG, { mode: 0o444 });
  const runtimePacket = packet(exact.capabilityDigest);
  runtimePacket.deliverable.producerCapabilityId = exact.adapterId;
  return {
    invocation: exact,
    packet: runtimePacket,
    inputRoot: root,
    inputs: [
      {
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
    await expect(
      executor.resumeDispatched({
        authority: { repository: "fixture/project", objective: 7, baseSha: "b".repeat(40) },
        request: await requestFor(invocation()),
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
      recoverHandle: (value) => base.recoverHandle(value),
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
      inputMediaTypes: [] as string[],
      inputRequirement: {
        minimumCount: 0,
        maximumCount: 0,
        semantics: "none" as const,
      },
      outputMediaTypes: ["audio/wav"],
      intentKinds: ["sound-reference" as const],
      profiles: [{ kind: "binary" as const }],
    };
    const binaryPacket = structuredClone(
      packet(assetDigest(binaryCapability)),
    ) as unknown as AssetProductionWorkerPacket;
    binaryPacket.deliverable.producerCapabilityId = binaryCapability.id;
    binaryPacket.assetInputs = [];
    binaryPacket.deliverable.intent.kind = "sound-reference";
    binaryPacket.deliverable.intent.importedAssetIds = [];
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
      outputVisibility: "private",
      outputRights: { basis: "unknown" },
    });
    expect(exact.profile).toEqual({ kind: "binary" });
    expect(exact.outputMediaType).toBe("audio/wav");
    expect(exact.profile).not.toHaveProperty("width");
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
      },
    ]);
    const memory = memoryStore();
    const recorded = hooks();
    const exact = invocation();
    const result = await new MediaProductionExecutor({
      store: memory.store,
      retentionRoot: await retentionRoot(),
      adapter: new SharpRasterMediaAdapter(),
      hooks: recorded.hooks,
      assertCurrent: async () => {},
    }).runPrepared({
      authority: { repository: "fixture/project", objective: 7, baseSha: "b".repeat(40) },
      request: await requestFor(exact),
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
      selectedDescriptorDigests: result.assetSet.variants.map(
        ({ descriptor }) => descriptor.digest,
      ),
    });
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
  });
});
