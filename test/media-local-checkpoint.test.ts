import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { assetDigest, withAssetDigest } from "../src/assets/contracts.js";
import type { GitCommitObject } from "../src/control/lease.js";
import {
  SHARP_RASTER_MEDIA_CAPABILITY,
  SharpRasterMediaAdapter,
  type MediaAdapterRuntimeRequest,
} from "../src/media/adapter.js";
import { MediaProductionExecutor, type MediaExecutionAccounting } from "../src/media/execution.js";
import { createMediaInvocation } from "../src/media/lifecycle.js";
import type { MediaStore } from "../src/media/storage.js";
import type { AssetProductionWorkerPacket } from "../src/protocol/worker-packet.js";

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

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
  displayName: "reference.png",
  provenance: {
    kind: "local-file" as const,
    importId: "reference",
    originalName: "reference.png",
  },
  visibility: "private" as const,
  rights: { basis: "user-owned" as const },
  materializationPath: `assets/${REFERENCE_DIGEST}/reference.png`,
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

function memoryStore(): MediaStore {
  const blobs = new Map<string, Buffer>();
  const trees = new Map<string, Map<string, string>>();
  const commits = new Map<string, GitCommitObject>();
  const refs = new Map<string, string>();
  return {
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
      return bytes;
    },
    createBlob: async (bytes) => {
      const oid = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
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
}

function packet(variants: number): AssetProductionWorkerPacket {
  return {
    protocol: "clockgrove.factory/worker-packet",
    goal: "Produce bounded deterministic raster references.",
    acceptanceCriteria: ["Every requested variant is durably checkpointed."],
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
      kind: "asset-production",
      contract: "clockgrove.factory/asset-set",
      producerCapabilityId: SHARP_RASTER_MEDIA_CAPABILITY.id,
      producerCapabilityDigest: assetDigest(SHARP_RASTER_MEDIA_CAPABILITY),
      activationSelection: { minimumCount: 1, maximumCount: variants },
      intent: {
        id: "raster-reference",
        role: "raster-derivative",
        purpose: "implementation-reference",
        necessity: "required",
        obligationIds: ["reference-contract"],
        rationale: "The consumer requires deterministic reference variants.",
        brief: "Create bounded raster derivatives.",
        fulfillment: {
          kind: "produced",
          inputRoleBindings: [
            { roleId: "source", importedAssetIds: ["reference"], inputIntentIds: [] },
          ],
        },
        output: {
          mediaTypes: ["image/png"],
          minimumCount: variants,
          maximumCount: variants,
          profile: {
            kind: "raster",
            minimumWidth: 2,
            maximumWidth: 2,
            minimumHeight: 2,
            maximumHeight: 2,
            alpha: "required",
            animation: "forbidden",
          },
        },
        review: { kind: "human-required" },
        repositoryCapture: null,
        bindings: [
          {
            workItemId: "consumer",
            direction: "input-to",
            criterionIds: ["reference-contract"],
          },
        ],
      },
    },
    generatedAssetRequirements: [],
    mediaUses: [
      {
        source: "imported",
        intentId: "raster-reference",
        role: "raster-derivative",
        inputRoleId: "source",
        brief: "Create bounded raster derivatives.",
        purpose: "implementation-reference",
        necessity: "required",
        obligationIds: ["reference-contract"],
        rationale: "The consumer requires deterministic reference variants.",
        direction: "input-to",
        criterionIds: [],
        descriptorDigests: [REFERENCE_DESCRIPTOR.digest],
        manifestDigest: "3".repeat(64),
      },
    ],
  };
}

async function requestFor(variants: number, deadline = "2099-01-01T00:00:00.000Z") {
  const workerPacket = packet(variants);
  const entry = {
    descriptor: REFERENCE_DESCRIPTOR,
    storage: REFERENCE_STORAGE,
  };
  const invocation = createMediaInvocation({
    repository: "fixture/project",
    objective: 7,
    runId: "run-local-checkpoint",
    workItem: 17,
    attempt: 1,
    packet: workerPacket,
    capability: SHARP_RASTER_MEDIA_CAPABILITY,
    authorityBaseSha: "b".repeat(40),
    inputEntries: [entry],
    deadline,
    policyDigest: "c".repeat(64),
  });
  const root = await mkdtemp(join(tmpdir(), "factory-local-media-"));
  roots.push(root);
  const inputPath = join(root, REFERENCE_DESCRIPTOR.materializationPath);
  await mkdir(join(root, `assets/${REFERENCE_DIGEST}`), { recursive: true });
  await writeFile(inputPath, REFERENCE_PNG, { mode: 0o444 });
  const request: MediaAdapterRuntimeRequest = {
    invocation,
    packet: workerPacket,
    inputRoot: root,
    checkpointRoot: join(root, "checkpoints"),
    inputs: [
      {
        roleId: "source",
        descriptorDigest: REFERENCE_DESCRIPTOR.digest,
        contentDigest: REFERENCE_DIGEST,
        mediaType: "image/png",
        path: inputPath,
      },
    ],
  };
  return { request, root: join(request.checkpointRoot, invocation.digest) };
}

class CountingSharpAdapter extends SharpRasterMediaAdapter {
  readonly generated: number[] = [];
  readonly #primed = new Map<
    number,
    Awaited<ReturnType<SharpRasterMediaAdapter["collect"]>>["variants"][number]
  >();

  async prime(request: MediaAdapterRuntimeRequest, index: number) {
    this.#primed.set(index, await super.generateVariant(request, index));
  }

  protected override async generateVariant(request: MediaAdapterRuntimeRequest, index: number) {
    this.generated.push(index);
    return this.#primed.get(index) ?? super.generateVariant(request, index);
  }
}

describe("local media checkpoint recovery", () => {
  it("skips a completed variant and never overwrites its immutable bytes", async () => {
    const { request, root } = await requestFor(2);
    const first = new CountingSharpAdapter();
    const handle = await first.dispatch(request);
    const bytes = await readFile(join(root, "variant-1.bin"));
    await rm(join(root, "variant-2.bin"));
    await rm(join(root, "variant-2.json"));
    await rm(join(root, "ready.json"));

    const recovery = new CountingSharpAdapter();
    await expect(recovery.recoverHandle(request)).resolves.toEqual(handle);
    expect(recovery.generated).toEqual([1]);
    expect(await readFile(join(root, "variant-1.bin"))).toEqual(bytes);
    await expect(recovery.collect(request, handle)).resolves.toMatchObject({ variants: [{}, {}] });
  });

  it("repairs a torn prepared publication for the same immutable invocation", async () => {
    const { request, root } = await requestFor(1);
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "prepared.json"), '{"protocol":');
    const adapter = new CountingSharpAdapter();
    const handle = await adapter.recoverHandle(request);
    expect(handle).toMatchObject({ invocationId: request.invocation.invocationId });
    await expect(readFile(join(root, "prepared.json"), "utf8")).resolves.toContain(
      request.invocation.digest,
    );
    await expect(adapter.collect(request, handle!)).resolves.toMatchObject({ variants: [{}] });
  });

  it("stops before the next bounded unit and reports exact partial usage after abort", async () => {
    const { request, root } = await requestFor(3);
    let reads = 0;
    const signal = {
      get aborted() {
        reads += 1;
        return reads >= 3;
      },
    } as AbortSignal;
    const adapter = new CountingSharpAdapter();
    const handle = await adapter.dispatch(request, { signal });
    expect(adapter.generated).toEqual([0]);
    await expect(readFile(join(root, "variant-2.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(adapter.observe(request, handle)).resolves.toMatchObject({
      state: "cancelled",
      output: { variants: 1, generatedBytes: expect.any(Number), storageBytes: 0 },
      usage: [
        { unit: "generated_bytes", amount: expect.any(Number) },
        { unit: "output_count", amount: 1 },
      ],
    });
  });

  it("persists exact partial cancellation accounting through the execution boundary", async () => {
    const { request } = await requestFor(3);
    let reads = 0;
    const signal = {
      get aborted() {
        reads += 1;
        return reads >= 5;
      },
    } as AbortSignal;
    let recorded: MediaExecutionAccounting | null = null;
    const retentionRoot = await mkdtemp(join(tmpdir(), "factory-local-retention-"));
    roots.push(retentionRoot);
    const result = await new MediaProductionExecutor({
      store: memoryStore(),
      retentionRoot,
      adapter: new CountingSharpAdapter(),
      assertCurrent: async () => {},
      hooks: {
        markDispatching: async () => {},
        recordDispatch: async () => {},
        recordTerminalFailure: async ({ accounting }) => {
          recorded = accounting;
        },
        recordAssetSet: async () => {},
        recordUsageSettled: async () => {},
        recordCleanupFailure: async () => {},
        recordCleanupCompleted: async () => {},
      },
    }).runPrepared({
      authority: { repository: "fixture/project", objective: 7, baseSha: "b".repeat(40) },
      request,
      reservationOid: "a".repeat(40),
      signal,
    });
    expect(result).toMatchObject({ state: "cancelled", cleanupPending: false });
    expect(recorded).toMatchObject({
      providerRequests: 0,
      variants: 1,
      generatedBytes: expect.any(Number),
      storageBytes: 0,
      native: [
        { unit: "generated_bytes", amount: expect.any(Number) },
        { unit: "output_count", amount: 1 },
      ],
    });
    expect(recorded!.generatedBytes).toBe(recorded!.native[0]!.amount);
  });

  it("stops remaining bounded units when the immutable deadline expires", async () => {
    const deadline = Date.parse("2099-01-01T00:00:00.000Z");
    const { request, root } = await requestFor(3, new Date(deadline).toISOString());
    const adapter = new CountingSharpAdapter();
    await adapter.prime(request, 0);
    let reads = 0;
    vi.spyOn(Date, "now").mockImplementation(() => {
      reads += 1;
      return reads < 3 ? deadline - 1 : deadline;
    });

    const handle = await adapter.dispatch(request);
    expect(adapter.generated).toEqual([0]);
    await expect(readFile(join(root, "variant-2.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(adapter.observe(request, handle)).resolves.toMatchObject({
      state: "cancelled",
      output: { variants: 1, generatedBytes: expect.any(Number), storageBytes: 0 },
    });
  });
});
