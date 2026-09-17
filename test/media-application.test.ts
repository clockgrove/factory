import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { assetDigest, canonicalAssetJson, withAssetDigest } from "../src/assets/contracts.js";
import { FactoryApplicationService, type ApplicationSnapshot } from "../src/application/index.js";
import { attemptRef } from "../src/control/attempts.js";
import { decodeEventComments, encodeEventTrailer } from "../src/control/receipts.js";
import type { GitCommitObject } from "../src/control/lease.js";
import {
  AssetSetSchema,
  MediaProducerCapabilitySchema,
  withMediaDigest,
} from "../src/media/contracts.js";
import { createMediaInvocation } from "../src/media/lifecycle.js";
import type { MediaStore } from "../src/media/storage.js";
import { parseFactoryEvent, type FactoryEvent } from "../src/protocol/events.js";
import { DEFAULT_RUN_POLICY, policyDigest } from "../src/protocol/policy.js";
import type { AssetProductionWorkerPacket } from "../src/protocol/worker-packet.js";

const gitOid = (bytes: Buffer) =>
  createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");

function memoryStore() {
  const blobs = new Map<string, Buffer>();
  const trees = new Map<string, Map<string, string>>();
  const commits = new Map<string, GitCommitObject>();
  const refs = new Map<string, string>();
  let refWrites = 0;
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
      refWrites += 1;
      if (refs.has(ref)) return false;
      refs.set(ref, oid);
      return true;
    },
  };
  return { store, refs, refWrites: () => refWrites };
}

const capability = MediaProducerCapabilitySchema.parse({
  protocol: "clockgrove.factory/media-producer-capability-v1",
  id: "fixture/media-v1",
  adapterVersion: "1",
  inputMediaTypes: [],
  inputRequirement: { minimumCount: 0, maximumCount: 0, semantics: "none" },
  outputMediaTypes: ["image/png"],
  intentKinds: ["layout-reference"],
  purposes: ["implementation-reference"],
  profiles: [
    {
      kind: "raster",
      maximumWidth: 64,
      maximumHeight: 64,
      supportsAlpha: true,
      supportsAnimation: false,
    },
  ],
  models: [],
  qualities: [],
  limits: {
    providerRequests: 0,
    variants: 2,
    generatedBytes: 1_024,
    storageBytes: 1_024,
  },
  network: { destinations: [], thirdPartyEgress: "denied" },
  recovery: {
    observation: true,
    idempotency: true,
    cancellation: true,
    resultCollection: "same-invocation",
  },
  nativeUsageKeys: [],
});

function packet(): AssetProductionWorkerPacket {
  return {
    protocol: "clockgrove.factory/worker-packet",
    goal: "Produce two media variants for human review.",
    acceptanceCriteria: ["Both variants retain their immutable identity."],
    allowedPaths: [],
    preconditions: [],
    outOfScope: [],
    conventions: [],
    baseSha: "b".repeat(40),
    validationCommands: [],
    requirements: {
      os: ["linux"],
      architecture: [],
      tools: [],
      services: [],
      networkDestinations: [],
      permittedSecretNames: [],
      trust: "managed",
    },
    assetInputs: [],
    deliverable: {
      kind: "asset-production",
      contract: "clockgrove.factory/asset-set",
      producerCapabilityId: capability.id,
      producerCapabilityDigest: assetDigest(capability),
      intent: {
        id: "raccoon-world-layout",
        kind: "layout-reference",
        purpose: "implementation-reference",
        necessity: "required",
        obligationIds: ["world-layout"],
        rationale: "A human chooses the exact immutable variant.",
        brief: "Create two distinct Raccoon World layout references.",
        importedAssetIds: [],
        output: {
          mediaTypes: ["image/png"],
          minimumCount: 2,
          maximumCount: 2,
          raster: {
            minimumWidth: 32,
            maximumWidth: 32,
            minimumHeight: 32,
            maximumHeight: 32,
            alpha: "required",
            animation: "forbidden",
          },
        },
        review: { kind: "human-required" },
        bindings: [
          {
            workItemId: "consumer",
            direction: "input-to",
            criterionIds: ["world-layout"],
          },
        ],
      },
    },
  };
}

function entry(
  index: number,
  authority: { repository: string; objective: number; baseSha: string },
) {
  const bytes = Buffer.from(`variant-${index}`);
  const contentDigest = createHash("sha256").update(bytes).digest("hex");
  const descriptor = withAssetDigest({
    protocol: "clockgrove.factory/asset-descriptor" as const,
    content: {
      protocol: "clockgrove.factory/asset-content" as const,
      digest: contentDigest,
      bytes: bytes.length,
      inspection: {
        status: "semantic-valid" as const,
        handlerId: "fixture-png",
        handlerContract: 1,
        mediaType: "image/png",
        metadata: {
          kind: "raster" as const,
          format: "png" as const,
          width: 32,
          height: 32,
          frames: 1,
          channels: 4,
          hasAlpha: true,
          decodedBytes: 4_096,
        },
      },
    },
    displayName: `variant-${index}.png`,
    provenance: {
      kind: "produced" as const,
      invocationId: "fixture-invocation",
      outputIndex: index - 1,
      provider: null,
      providerRequestId: null,
    },
    visibility: "private" as const,
    rights: { basis: "unknown" as const },
    materializationPath: `assets/${contentDigest}/variant-${index}.png`,
  });
  const storage = withAssetDigest({
    protocol: "clockgrove.factory/asset-storage-receipt" as const,
    authority,
    descriptorDigest: descriptor.digest,
    transferDomain: "produced-asset" as const,
    payload: {
      kind: "content-chunks" as const,
      digest: contentDigest,
      bytes: bytes.length,
      chunks: [{ digest: contentDigest, bytes: bytes.length }],
    },
    transferRef: `refs/fixture/transfer-${index}`,
    transferRequestId: `fixture-transfer-${index}`,
    intentCommit: `${index + 2}`.repeat(40),
    readyCommit: `${index}`.repeat(40),
  });
  return { descriptor, storage };
}

async function fixture(options: { maxAttemptsPerItem?: number } = {}) {
  const memory = memoryStore();
  const authority = { repository: "fixture/project", objective: 7, baseSha: "b".repeat(40) };
  const runPolicy = {
    ...DEFAULT_RUN_POLICY,
    maxAttemptsPerItem: options.maxAttemptsPerItem ?? DEFAULT_RUN_POLICY.maxAttemptsPerItem,
  };
  const exactPacket = packet();
  const invocation = createMediaInvocation({
    repository: authority.repository,
    objective: authority.objective,
    runId: "run-media",
    workItem: 17,
    attempt: 1,
    packet: exactPacket,
    capability,
    inputEntries: [],
    authorityBaseSha: authority.baseSha,
    deadline: "2099-01-01T00:00:00.000Z",
    policyDigest: policyDigest(runPolicy),
    outputVisibility: "private",
    outputRights: { basis: "unknown" },
  });
  const started = parseFactoryEvent({
    protocol: "clockgrove.factory/v2",
    kind: "run",
    event: "FactoryRunStarted",
    objective: 7,
    runId: invocation.runId,
    sequence: 1,
    at: "2026-01-01T00:00:00.000Z",
    actor: "reviewer",
    repository: authority.repository,
    objectiveAuthor: "reviewer",
    fork: false,
    baseBranch: "main",
    baseSha: authority.baseSha,
    policy: runPolicy,
    policyDigest: policyDigest(runPolicy),
  });
  const reserved = parseFactoryEvent({
    protocol: "clockgrove.factory/v2",
    kind: "attempt",
    event: "AttemptReserved",
    objective: 7,
    runId: invocation.runId,
    sequence: 2,
    at: "2026-01-01T00:01:00.000Z",
    workItem: 17,
    attempt: 1,
    backend: capability.id,
    baseSha: authority.baseSha,
    directorEpoch: 1,
    policyDigest: policyDigest(runPolicy),
    mediaInvocation: invocation,
  });
  const emptyTree = await memory.store.createTree({ entries: [] });
  const reservationOid = await memory.store.createCommit({
    treeOid: emptyTree,
    parentOids: [authority.baseSha],
    message: `Factory attempt reservation\n\n${encodeEventTrailer(reserved)}`,
  });
  await memory.store.createRef(attemptRef(7, 17, 1), reservationOid);

  const variants = [entry(1, authority), entry(2, authority)].sort((left, right) =>
    left.descriptor.digest.localeCompare(right.descriptor.digest),
  );
  const assetSet = AssetSetSchema.parse(
    withMediaDigest({
      protocol: "clockgrove.factory/asset-set-v1" as const,
      authority,
      runId: invocation.runId,
      workItem: 17,
      attempt: 1,
      intentId: invocation.intentId,
      intentDigest: invocation.intentDigest,
      invocationDigest: invocation.digest,
      dispatchReceiptDigest: "d".repeat(64),
      providerResponseId: null,
      productionReceiptDigest: "e".repeat(64),
      storageManifestDigest: "f".repeat(64),
      variants,
      usage: [],
      totalGeneratedBytes: variants.reduce(
        (total, variant) => total + variant.descriptor.content.bytes,
        0,
      ),
      totalStorageBytes: variants.reduce(
        (total, variant) => total + variant.descriptor.content.bytes,
        0,
      ),
    }),
  );
  const bytes = Buffer.from(canonicalAssetJson(assetSet));
  const blob = await memory.store.createBlob(bytes);
  const tree = await memory.store.createTree({
    entries: [{ path: "asset-set.json", mode: "100644", type: "blob", sha: blob }],
  });
  const assetSetCommit = await memory.store.createCommit({
    treeOid: tree,
    parentOids: variants.map(({ storage }) => storage.readyCommit).sort(),
    message: `Factory immutable media asset-sets\n\nFactory-Media-Digest: ${assetSet.digest}`,
  });
  const scope = assetDigest({ authority, runId: invocation.runId });
  await memory.store.createRef(
    `refs/clockgrove-factory/media/${scope}/asset-sets/${assetSet.digest}`,
    assetSetCommit,
  );
  const ready = parseFactoryEvent({
    protocol: "clockgrove.factory/v2",
    kind: "media",
    event: "AssetSetReady",
    objective: 7,
    runId: invocation.runId,
    sequence: 3,
    at: "2026-01-01T00:02:00.000Z",
    workItem: 17,
    attempt: 1,
    reservationOid,
    invocationDigest: invocation.digest,
    assetSetDigest: assetSet.digest,
    assetSetCommitOid: assetSetCommit,
  });
  const current: ApplicationSnapshot = {
    id: "objective-node",
    number: 7,
    title: "Raccoon World",
    defaultBranch: "main",
    workItems: [{ id: "producer-node", number: 17, factoryEvents: [] }],
    factoryEvents: [started, reserved, ready],
  };
  let login = "reviewer";
  let failNextComment = false;
  let failCommentEvent: FactoryEvent["event"] | null = null;
  const comments: FactoryEvent[] = [];
  const serviceForRestart = () =>
    new FactoryApplicationService({
      owner: "fixture",
      repo: "project",
      reader: { readObjective: async () => structuredClone(current) },
      assetStore: memory.store,
      store: {
        getAuthenticatedLogin: async () => login,
        serverTime: async () => new Date("2026-01-01T00:03:00.000Z"),
        addIssueComment: async (_issue, body) => {
          const decoded = decodeEventComments(body);
          if (
            failNextComment ||
            (failCommentEvent !== null && decoded.some(({ event }) => event === failCommentEvent))
          ) {
            failNextComment = false;
            failCommentEvent = null;
            throw new Error("simulated publication interruption");
          }
          comments.push(...decoded);
          current.factoryEvents!.push(...decoded);
        },
      },
    });
  const service = serviceForRestart();
  return {
    service,
    serviceForRestart,
    current,
    assetSet,
    comments,
    refWrites: memory.refWrites,
    setLogin: (value: string) => {
      login = value;
    },
    failNextComment: () => {
      failNextComment = true;
    },
    failCommentEvent: (event: FactoryEvent["event"]) => {
      failCommentEvent = event;
    },
  };
}

describe("media application commands", () => {
  it("approves an exact multi-variant selection and replays it after run termination", async () => {
    const test = await fixture();
    const selectedDescriptorDigests = test.assetSet.variants.map(
      ({ descriptor }) => descriptor.digest,
    );
    const input = {
      objective: 7,
      requestId: "raccoon-review",
      assetSetDigest: test.assetSet.digest,
      kind: "approved" as const,
      selectedDescriptorDigests,
    };
    const first = await test.service.assetDecision(input);
    expect(first).toMatchObject({
      operation: "asset-approve",
      decision: { kind: "approved", selectedDescriptorDigests },
      requestJournal: { digest: expect.stringMatching(/^[a-f0-9]{64}$/) },
      activation: { selectedDescriptorDigests },
    });
    expect(test.comments.map(({ event }) => event)).toEqual([
      "AssetDecisionRecorded",
      "AssetActivated",
    ]);
    const writes = test.refWrites();
    test.current.factoryEvents!.push(
      parseFactoryEvent({
        protocol: "clockgrove.factory/v2",
        kind: "run",
        event: "FactoryRunCompleted",
        objective: 7,
        runId: "run-media",
        sequence: 6,
        at: "2026-01-01T00:04:00.000Z",
      }),
    );
    expect(await test.serviceForRestart().assetDecision(input)).toEqual(first);
    expect(test.refWrites()).toBe(writes);
    expect(test.comments).toHaveLength(2);
    expect(first.activation).toBeDefined();
    const firstActivation = first.activation!;
    await expect(
      test.service.assetDecision({ ...input, requestId: "changed-request" }),
    ).rejects.toThrow(/immutable review decision/);
    await expect(
      test.service.assetDecision({
        ...input,
        selectedDescriptorDigests: selectedDescriptorDigests.slice(0, 1),
      }),
    ).rejects.toThrow(/immutable review decision|idempotency key/);
    expect(test.refWrites()).toBe(writes);

    const status = await test.service.assetStatus({
      objective: 7,
      assetSetDigest: test.assetSet.digest,
    });
    expect(status.review).toMatchObject({
      state: "approved",
      decision: { digest: first.decision.digest, ref: first.decision.ref },
      activation: { digest: firstActivation.digest, ref: firstActivation.ref },
    });
    test.current.factoryEvents = test.current.factoryEvents!.map((event) =>
      event.kind === "media" && event.event === "AssetDecisionRecorded"
        ? parseFactoryEvent({ ...event, decisionDigest: "0".repeat(64) })
        : event,
    );
    await expect(
      test.service.assetStatus({ objective: 7, assetSetDigest: test.assetSet.digest }),
    ).rejects.toThrow(/decision differs from its durable record/);
  });

  it("repairs interrupted decision publication from the exact durable records", async () => {
    const test = await fixture();
    const input = {
      objective: 7,
      requestId: "repair-review",
      assetSetDigest: test.assetSet.digest,
      kind: "approved" as const,
      selectedDescriptorDigests: [test.assetSet.variants[0]!.descriptor.digest],
    };
    test.failNextComment();
    await expect(test.service.assetDecision(input)).rejects.toThrow(/publication interruption/);
    const writes = test.refWrites();
    expect(test.comments).toHaveLength(0);
    const repaired = await test.serviceForRestart().assetDecision(input);
    expect(repaired.operation).toBe("asset-approve");
    expect(test.refWrites()).toBe(writes);
    expect(test.comments.map(({ event }) => event)).toEqual([
      "AssetDecisionRecorded",
      "AssetActivated",
    ]);
  });

  it("repairs the canonical revision retry after a restart without another user command", async () => {
    const test = await fixture();
    const input = {
      objective: 7,
      requestId: "repair-revision",
      assetSetDigest: test.assetSet.digest,
      kind: "revision-requested" as const,
      reason: "Retain the layout and increase foreground contrast.",
    };
    test.failCommentEvent("WorkItemRetryRequested");
    await expect(test.service.assetDecision(input)).rejects.toThrow(/publication interruption/);
    expect(test.comments.map(({ event }) => event)).toEqual(["AssetDecisionRecorded"]);
    const writes = test.refWrites();
    const repaired = await test.serviceForRestart().assetDecision(input);
    expect(repaired).toMatchObject({
      operation: "asset-revise",
      retry: { workItem: 17, priorDecisionDigest: repaired.decision.digest },
    });
    expect(test.refWrites()).toBe(writes);
    expect(test.comments.map(({ event }) => event)).toEqual([
      "AssetDecisionRecorded",
      "WorkItemRetryRequested",
    ]);
  });

  it("refuses to journal a revision after the bounded attempt allowance is exhausted", async () => {
    const test = await fixture({ maxAttemptsPerItem: 1 });
    const writes = test.refWrites();
    await expect(
      test.service.assetDecision({
        objective: 7,
        requestId: "exhausted-revision",
        assetSetDigest: test.assetSet.digest,
        kind: "revision-requested",
        reason: "Generate one more bounded variant.",
      }),
    ).rejects.toThrow(/maximum attempts/);
    expect(test.refWrites()).toBe(writes);
    expect(test.comments).toHaveLength(0);
  });

  it("validates authority and the complete decision shape before durable writes", async () => {
    const test = await fixture();
    const baseline = test.refWrites();
    await expect(
      test.service.assetDecision({
        objective: 7,
        requestId: "too-long",
        assetSetDigest: test.assetSet.digest,
        kind: "revision-requested",
        reason: "x".repeat(8_001),
      }),
    ).rejects.toThrow();
    await expect(
      test.service.assetDecision({
        objective: 7,
        requestId: "approve-reason",
        assetSetDigest: test.assetSet.digest,
        kind: "approved",
        selectedDescriptorDigests: [test.assetSet.variants[0]!.descriptor.digest],
        reason: "not part of approval",
      } as never),
    ).rejects.toThrow();
    test.setLogin("intruder");
    await expect(
      test.service.assetDecision({
        objective: 7,
        requestId: "unauthorized",
        assetSetDigest: test.assetSet.digest,
        kind: "rejected",
        reason: "The variant does not meet the brief.",
      }),
    ).rejects.toThrow(/activating actor/);
    expect(test.refWrites()).toBe(baseline);
  });

  it.each([
    ["rejected", "asset-reject", "The selected direction is unsafe."],
    ["revision-requested", "asset-revise", "Increase contrast and retain the exact layout."],
  ] as const)(
    "records %s with bounded feedback and no selection",
    async (kind, operation, reason) => {
      const test = await fixture();
      const result = await test.service.assetDecision({
        objective: 7,
        requestId: `review-${kind}`,
        assetSetDigest: test.assetSet.digest,
        kind,
        reason,
      });
      expect(result).toMatchObject({ operation, decision: { kind, reason } });
      expect(result).not.toHaveProperty("activation");
      if (kind === "revision-requested") {
        expect(result).toMatchObject({
          retry: {
            workItem: 17,
            priorAssetSetDigest: test.assetSet.digest,
            priorDecisionDigest: result.decision.digest,
          },
        });
        expect(test.comments.map(({ event }) => event)).toEqual([
          "AssetDecisionRecorded",
          "WorkItemRetryRequested",
        ]);
      }
      const status = await test.service.assetStatus({
        objective: 7,
        assetSetDigest: test.assetSet.digest,
      });
      expect(status.review).toMatchObject({
        state: kind,
        decision: { kind, reason },
        activation: null,
      });
      if (kind === "revision-requested")
        expect(status.review.decision).toMatchObject({ retry: { published: true, workItem: 17 } });
    },
  );
});
