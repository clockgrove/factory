import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ObjectiveAssetManifestSchema,
  withAssetDigest,
  type ObjectiveAssetManifest,
} from "../src/assets/contracts.js";
import * as assetStorage from "../src/assets/storage.js";
import { cachePayloadBytes, releaseAllArtifactContent } from "../src/execution/artifact-content.js";
import type { CompiledObjective } from "../src/graph.js";
import * as scopeResources from "../src/recovery/scope-resources.js";
import * as localScopes from "../src/runtime/local-scope.js";
import { runContainedProcess } from "../src/runtime/process-group.js";
import { provisionToolchain } from "../src/runtime/toolchain-store.js";
import { sha256Bytes } from "../src/runtime/toolchain-bundle.js";
import { TOOLCHAIN_AUTHORITY_ADAPTERS } from "../src/toolchains/authority.js";
import { compilerEvalDigest } from "../src/evaluation/compiler-eval.js";
import { providerSupervisorFixture } from "./helpers/provider-supervisor.js";

const sha = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const npmRuntime = TOOLCHAIN_AUTHORITY_ADAPTERS.find(({ id }) => id === "node-npm")!
  .runtimeRequirement!;

async function provisionNpmFixture(): Promise<void> {
  const assets = await mkdtemp(join(tmpdir(), "factory-rebound-npm-assets-"));
  try {
    const prefix = "node-v24.8.0-linux-x64";
    const nodePath = `${prefix}/bin/node`;
    const npmPath = `${prefix}/lib/node_modules/npm/bin/npm-cli.js`;
    const tree = join(assets, "tree");
    await mkdir(join(tree, prefix, "bin"), { recursive: true });
    await mkdir(join(tree, prefix, "lib/node_modules/npm/bin"), { recursive: true });
    await writeFile(
      join(tree, nodePath),
      `#!/bin/sh\ncase "$1" in\n  --version) printf 'v24.8.0\\n' ;;\n  */npm-cli.js) if [ "$2" = "--version" ]; then printf '11.6.0\\n'; fi ;;\n  *) exec ${process.execPath} "$@" ;;\nesac\n`,
      { mode: 0o700 },
    );
    await writeFile(join(tree, npmPath), "fixture npm cli");
    const archivePath = join(assets, `${prefix}.tar.xz`);
    execFileSync("tar", ["-cJf", archivePath, "-C", tree, prefix]);
    const archive = await readFile(archivePath);
    const identity = {
      version: "24.8.0",
      tag: "v24.8.0",
      publishedAt: "2026-09-10T00:00:00.000Z",
      name: `${prefix}.tar.xz`,
      url: `https://nodejs.org/dist/v24.8.0/${prefix}.tar.xz`,
      sha256: sha256Bytes(archive),
      archive: "tar.xz" as const,
      executablePath: nodePath,
      npmVersion: "11.6.0",
      lts: "Krypton",
    };
    await provisionToolchain("npm", {
      source: {
        listReleases: async () => [],
        downloadAsset: async () => Buffer.alloc(0),
        resolveLatestNodeDistribution: async () => identity,
        downloadNodeDistribution: async () => archive,
      },
    });
  } finally {
    await rm(assets, { recursive: true, force: true });
  }
}

function captureGraph(baseSha: string, payload: Awaited<ReturnType<typeof cachePayloadBytes>>) {
  const expectedBytes = Buffer.from("capture\n");
  const content = {
    protocol: "clockgrove.factory/asset-content" as const,
    digest: sha(expectedBytes),
    bytes: expectedBytes.length,
    inspection: {
      status: "semantic-valid" as const,
      handlerId: "utf8-text",
      handlerContract: 1,
      mediaType: "text/plain",
      metadata: { kind: "text" as const, encoding: "utf-8" as const, lines: 2 },
    },
  };
  const descriptor = withAssetDigest({
    protocol: "clockgrove.factory/asset-descriptor" as const,
    content,
    displayName: "expected.txt",
    provenance: {
      kind: "local-file" as const,
      importId: "expected-capture",
      originalName: "expected.txt",
    },
    visibility: "private" as const,
    rights: { basis: "user-owned" as const },
    materializationPath: `assets/${content.digest}/expected.txt`,
  });
  const authority = {
    repository: "fixture/provider-qualification",
    objective: 7,
    baseSha,
  };
  const storage = withAssetDigest({
    protocol: "clockgrove.factory/asset-storage-receipt" as const,
    authority,
    descriptorDigest: descriptor.digest,
    transferDomain: "objective-asset" as const,
    payload,
    transferRef: "refs/clockgrove-factory/content/fixture",
    transferRequestId: "expected-capture-transfer",
    intentCommit: "1".repeat(40),
    readyCommit: "2".repeat(40),
  });
  const manifest = ObjectiveAssetManifestSchema.parse(
    withAssetDigest({
      protocol: "clockgrove.factory/objective-asset-manifest" as const,
      authority,
      revision: 1,
      requestId: "expected-capture-manifest",
      assets: [{ descriptor, storage }],
      totalBytes: expectedBytes.length,
    }),
  );
  const captureCommand = "npm run check";
  const recipeCore = {
    id: "capture-result",
    mediaUse: { intentId: "result-evidence", direction: "evidence-for" as const },
    criterionIds: ["validated"],
    criteria: ["capture.txt has the expected text"],
    scenario: { id: "fixture", fixture: "capture.txt", seed: null },
    captureCommand: {
      recipeId: "recipe-capture",
      recipeDigest: sha("recipe-capture"),
      command: captureCommand,
    },
    outputs: [{ roleId: "capture", mediaType: "text/plain" }],
    profile: null,
    comparison: {
      kind: "exact" as const,
      outputRoleId: "capture",
      expectedDescriptorDigest: descriptor.digest,
      policy: { kind: "exact-bytes" as const },
    },
    gate: { kind: "human-required" as const },
  };
  const graph: CompiledObjective = {
    title: "Local validation rebound recovery",
    deferredCapabilityAdapters: ["node-npm"],
    workItems: [
      {
        id: "capture",
        title: "Capture the result",
        goal: "Create capture.txt containing capture",
        acceptance: ["capture.txt has the expected text"],
        scope: ["capture.txt", "package.json", "package-lock.json", "test/"],
        preconditions: [],
        outOfScope: [],
        conventions: [],
        dependsOn: [],
        baseSha,
        validationCommands: ["npm run test", captureCommand],
        requirements: {
          os: ["linux"],
          architecture: [],
          tools: ["node", "npm"],
          services: [],
          networkDestinations: ["registry.npmjs.org"],
          permittedSecretNames: [],
          trust: "trusted_local",
          estimatedDurationMinutes: 1,
        },
        deliverable: {
          kind: "repository-change",
          contract: "clockgrove.factory/artifact",
        },
        delivery: { group: "capture", relationship: "root" },
        managedRuntimes: [npmRuntime],
        repositoryCapabilities: {
          provides: [
            {
              adapter: "node-npm",
              generation: "node-npm/capture",
              authorityPaths: ["package.json", "package-lock.json"],
              operations: [
                { kind: "package-script", key: "1:.:check" },
                { kind: "package-script", key: "1:.:test" },
              ],
              runtime: npmRuntime,
            },
          ],
          requires: [
            {
              adapter: "node-npm",
              generation: "node-npm/capture",
              providerWorkItem: "capture",
              authorityPaths: ["package.json", "package-lock.json"],
              operation: { kind: "package-script", key: "1:.:check" },
              activation: "artifact",
              runtime: npmRuntime,
            },
            {
              adapter: "node-npm",
              generation: "node-npm/capture",
              providerWorkItem: "capture",
              authorityPaths: ["package.json", "package-lock.json"],
              operation: { kind: "package-script", key: "1:.:test" },
              activation: "artifact",
              runtime: npmRuntime,
            },
          ],
        },
        assetInputs: [
          {
            manifestDigest: manifest.digest,
            descriptorDigest: descriptor.digest,
            contentDigest: content.digest,
            storageReceiptDigest: storage.digest,
            path: descriptor.materializationPath,
          },
        ],
        mediaUses: [
          {
            source: "imported",
            intentId: "result-evidence",
            role: "acceptance-capture",
            inputRoleId: null,
            brief: "Capture one exact repository result.",
            purpose: "acceptance-evidence",
            necessity: "required",
            obligationIds: ["validated"],
            rationale: "The criterion requires exact bytes.",
            direction: "evidence-for",
            criterionIds: ["validated"],
            descriptorDigests: [descriptor.digest],
            manifestDigest: manifest.digest,
          },
        ],
        repositoryCaptureRecipes: [{ ...recipeCore, digest: compilerEvalDigest(recipeCore) }],
      },
    ],
  };
  return { expectedBytes, graph, manifest, captureCommand };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await releaseAllArtifactContent();
});

describe("FactorySupervisor local validation rebound recovery", () => {
  it("restarts through one rebound and delayed predecessors cannot duplicate dispatch or accounting", async () => {
    await provisionNpmFixture();
    const payload = await cachePayloadBytes(Buffer.from("capture\n"));
    let assets: ReturnType<typeof captureGraph> | undefined;
    let releasePrepared!: () => void;
    let releaseRebound!: () => void;
    let releaseRecovered!: () => void;
    let preparedReached!: () => void;
    let reboundReached!: () => void;
    let recoveredReached!: () => void;
    const preparedHold = new Promise<void>((resolve) => {
      releasePrepared = resolve;
    });
    const reboundHold = new Promise<void>((resolve) => {
      releaseRebound = resolve;
    });
    const recoveredHold = new Promise<void>((resolve) => {
      releaseRecovered = resolve;
    });
    const preparedObserved = new Promise<void>((resolve) => {
      preparedReached = resolve;
    });
    const reboundObserved = new Promise<void>((resolve) => {
      reboundReached = resolve;
    });
    const recoveredObserved = new Promise<void>((resolve) => {
      recoveredReached = resolve;
    });
    let holdPrepared = true;
    let holdRebound = true;
    let holdRecovered = true;
    const f = await providerSupervisorFixture("daytona-burst", {
      localOnly: true,
      includeObjectiveAuthority: true,
      enforceCurrentLease: true,
      capabilityAdmission: "valid",
      capabilityAdapter: "npm",
      graphFactory: (baseSha) => (assets = captureGraph(baseSha, payload)).graph,
      afterComment: async (events) => {
        if (
          holdPrepared &&
          events.some((event) => event.event === "ValidationInvocationPrepared")
        ) {
          holdPrepared = false;
          preparedReached();
          await preparedHold;
        } else if (
          holdRebound &&
          events.some((event) => event.event === "ValidationInvocationScopeRebound")
        ) {
          holdRebound = false;
          reboundReached();
          await reboundHold;
        } else if (
          holdRecovered &&
          events.some(
            (event) =>
              event.kind === "capacity" &&
              event.event === "CapacityReconciled" &&
              event.phase === "validation",
          )
        ) {
          holdRecovered = false;
          recoveredReached();
          await recoveredHold;
        }
      },
    });
    if (!assets) throw new Error("capture graph fixture was not constructed");
    vi.spyOn(assetStorage, "readObjectiveAssetManifest").mockResolvedValue(
      assets.manifest as ObjectiveAssetManifest,
    );
    vi.spyOn(assetStorage, "recoverObjectiveAsset").mockResolvedValue({
      entry: assets.manifest.assets[0]!,
      payload,
    });
    const producerIds = ["a".repeat(32), "b".repeat(32), "c".repeat(32)];
    vi.spyOn(localScopes, "discoverLocalScopeHost").mockImplementation(async () => ({
      hostIdentity: "d".repeat(64),
      producerPid: process.pid,
      producerStartTicks: "456",
      producerUnit: "factory-fixture.service",
      producerInvocationId: producerIds.shift() ?? "c".repeat(32),
    }));
    const observedProducers: string[] = [];
    vi.spyOn(scopeResources, "observeLocalScopeBatch").mockImplementation(async (batch) => {
      observedProducers.push(batch.identity.producerInvocationId ?? "missing");
      return {
        status: "absent",
        reason: "original-producer-and-scopes-absent",
        identityDigest: sha("absent"),
        evidenceDigest: sha("absent-evidence"),
        observedAt: new Date().toISOString(),
      };
    });
    vi.spyOn(localScopes, "observeLocalScope").mockResolvedValue({
      status: "absent",
      reason: "scope-missing",
      identityDigest: sha("command-scope"),
      evidenceDigest: sha("command-scope-absent"),
      observedAt: new Date().toISOString(),
      unit: "factory-fixture-command.scope",
    });
    const commandDispatches: string[] = [];
    vi.spyOn(localScopes, "runScopedLocalProcess").mockImplementation(
      async (_identity, options) => {
        const wrapperArgs = options.args ?? [];
        if (wrapperArgs[1]) {
          const request = JSON.parse(await readFile(wrapperArgs[1], "utf8"));
          commandDispatches.push(request.plannedCommand ?? request.command.command);
          if (request.recipes)
            await writeFile(request.recipes[0].outputs[0].path, assets!.expectedBytes);
        }
        return runContainedProcess(options);
      },
    );
    let first: ReturnType<typeof f.run> | undefined;
    let second: ReturnType<typeof f.run> | undefined;
    let third: ReturnType<typeof f.run> | undefined;
    const reach = (signal: Promise<void>, stage: string) =>
      Promise.race([
        signal,
        new Promise<never>((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(
                  `${stage} was not reached: ${f
                    .events()
                    .map(
                      (event) =>
                        `${event.event}${"reason" in event ? `:${event.reason ?? ""}` : ""}`,
                    )
                    .join(" -> ")}; refs=${JSON.stringify(
                    [...f.refs.entries()].filter(([ref]) => ref.includes("validation-invocations")),
                  )}`,
                ),
              ),
            5_000,
          ),
        ),
      ]);
    try {
      first = f.run();
      await reach(preparedObserved, "prepared hold");
      second = f.run();
      await reach(reboundObserved, "rebound hold");
      third = f.run();
      await reach(recoveredObserved, "recovered capacity hold");
      expect(commandDispatches.filter((command) => command === assets!.captureCommand)).toEqual([
        assets.captureCommand,
      ]);
      expect(
        f.events().filter((event) => event.event === "ValidationInvocationScopeRebound"),
      ).toHaveLength(1);
      expect(observedProducers).toEqual(expect.arrayContaining(["a".repeat(32), "b".repeat(32)]));
      const accountingSequences = f
        .events()
        .filter((event) => event.kind === "budget")
        .map(({ sequence }) => sequence);
      releasePrepared();
      releaseRebound();
      const delayedPredecessors = await Promise.allSettled([first, second]);
      expect(delayedPredecessors).toHaveLength(2);
      expect(
        f
          .events()
          .filter((event) => event.kind === "capacity" && event.phase === "validation")
          .map(({ event }) => event),
      ).toEqual(["CapacityReserved", "CapacityReconciled"]);
      expect(
        f
          .events()
          .filter((event) => event.kind === "budget")
          .map(({ sequence }) => sequence),
      ).toEqual(accountingSequences);
      expect(f.events().filter((event) => event.event === "ValidationRecorded")).toHaveLength(1);
      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
      releasePrepared();
      releaseRebound();
      releaseRecovered();
      await Promise.allSettled([first, second, third].filter((run) => run !== undefined));
      await f.dispose();
    }
  }, 30_000);
});
