import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";

import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ContentTransferStore } from "../src/control/content-transfers.js";
import type { GitCommitObject } from "../src/control/lease.js";
import { releaseAllArtifactContent } from "../src/execution/artifact-content.js";
import { withVerifiedReviewCheckout } from "../src/management/review-checkout.js";
import {
  finalizeLfsArtifact,
  restoreLfsArtifactContent,
  type LfsOutputTransport,
} from "../src/publication/git-lfs-output.js";
import {
  collectLocalArtifact,
  cleanupLocalWorktree,
  createLocalWorktree,
} from "../src/runtime/local-worktree.js";
import type { RepositoryChangeWorkerPacket } from "../src/protocol/worker-packet.js";
import type { RepositoryCaptureRecipe } from "../src/protocol/worker-packet.js";
import { discardValidationResult, validateArtifactClean } from "../src/validation/clean-run.js";
import {
  createValidationInvocation,
  createRepositoryCaptureCollection,
  describeRepositoryCaptureBytes,
  materializeRepositoryCaptureReviewBundle,
  materializeRepositoryCapturesForReview,
  persistRepositoryCaptures,
  RepositoryCaptureEvidenceSchema,
  runValidationInvocationTransaction,
  verifyRepositoryCaptureEvidenceBinding,
  type CollectedRepositoryCapture,
  type ValidationInvocation,
} from "../src/validation/repository-capture.js";
import { createValidationEvidence, verifyValidationEvidence } from "../src/validation/evidence.js";
import {
  executeLocalValidationCommand,
  executeLocalRepositoryCaptures,
  inspectLocalRepositoryCaptureDispatchState,
  localRepositoryCaptureScopeRecoveryAction,
  observeLocalValidationResult,
  persistLocalValidationResult,
} from "../src/validation/local-capture-runtime.js";
import {
  MAX_VALIDATION_INVOCATION_RESULT_BYTES,
  persistValidationInvocation,
  persistValidationInvocationResult,
} from "../src/validation/invocation-storage.js";

const roots: string[] = [];
afterEach(async () => {
  await releaseAllArtifactContent();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("local repository capture scope rebound recovery", () => {
  const recovery = (args: {
    scopeStatus?: "absent" | "active" | "unknown";
    dispatchState?: "rebound-safe" | "ambiguous" | "complete";
    reboundPersisted?: boolean;
    now?: string;
  }) =>
    localRepositoryCaptureScopeRecoveryAction({
      scopeStatus: args.scopeStatus ?? "absent",
      dispatchState: args.dispatchState ?? "rebound-safe",
      reboundPersisted: args.reboundPersisted ?? true,
      validationDeadline: "2026-09-17T00:10:00.000Z",
      now: new Date(args.now ?? "2026-09-17T00:02:00.000Z"),
    });

  it("resumes the persisted exact rebound after a crash before local launch", () => {
    expect(recovery({})).toBe("resume-rebound");
    expect(recovery({ reboundPersisted: false })).toBe("persist-rebound");
  });

  it("preserves ambiguity, active-scope, and immutable-deadline fences", () => {
    expect(recovery({ dispatchState: "ambiguous" })).toBe("observe-only");
    expect(recovery({ dispatchState: "complete" })).toBe("adopt-only");
    expect(recovery({ scopeStatus: "active" })).toBe("wait");
    expect(() => recovery({ now: "2026-09-17T00:10:00.000Z" })).toThrow(/deadline is exhausted/);
    expect(() => recovery({ scopeStatus: "unknown" })).toThrow(/cannot be observed exactly/);
  });
});

const sha = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};
const oid = (bytes: Buffer) =>
  createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");

async function checkpointMockCommand(env: NodeJS.ProcessEnv, command: string) {
  await checkpointMockStart(env, command);
  const requestDigest = sha(await readFile(env["FACTORY_CAPTURE_REQUEST"]!));
  await writeFile(
    env["FACTORY_CAPTURE_TERMINAL_RECEIPT"]!,
    JSON.stringify({
      protocol: "clockgrove.factory/local-capture-command-terminal",
      commandDigest: sha(command),
      requestDigest,
      exitCode: 0,
      durationMs: 1,
      startedAt: "2026-09-16T00:00:00.000Z",
      completedAt: "2026-09-16T00:00:00.001Z",
      stdout: "",
      stderr: "",
    }),
  );
}

async function checkpointMockStart(env: NodeJS.ProcessEnv, command: string) {
  const receipt = env["FACTORY_CAPTURE_TERMINAL_RECEIPT"]!;
  const request = env["FACTORY_CAPTURE_REQUEST"]!;
  await writeFile(
    join(dirname(receipt), basename(receipt).replace(/^terminal-/, "started-")),
    JSON.stringify({
      protocol: "clockgrove.factory/local-capture-command-started",
      commandDigest: sha(command),
      requestDigest: sha(await readFile(request)),
    }),
  );
}

async function checkpointMockValidation(root: string, invocation: ValidationInvocation) {
  const captureCommands = new Set(
    invocation.repositoryCaptureRecipes.map((recipe) => recipe.captureCommand.command),
  );
  await persistLocalValidationResult({
    stagingRoot: root,
    invocation,
    validation: {
      outputTreeSha: invocation.outputTreeSha,
      commands: invocation.validationCommands
        .filter((command) => !captureCommands.has(command))
        .map((command) => ({ command, exitCode: 0, durationMs: 1 })),
      passed: true,
      startedAt: "2026-09-16T00:00:00.000Z",
      completedAt: "2026-09-16T00:00:01.000Z",
      environmentIdentity: invocation.toolEnvironment.environmentIdentity,
    },
  });
}

async function checkpointValidationCommand(args: {
  wrapperArgs: string[];
  command: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
}) {
  const requestPath = args.wrapperArgs[1]!;
  const terminalPath = args.wrapperArgs[2]!;
  const startedPath = args.wrapperArgs[3]!;
  const commandDigest = args.wrapperArgs[4]!;
  const requestDigest = args.wrapperArgs[5]!;
  expect(commandDigest).toBe(sha(args.command));
  expect(requestDigest).toBe(sha(await readFile(requestPath)));
  await writeFile(
    startedPath,
    JSON.stringify({
      protocol: "clockgrove.factory/local-capture-command-started",
      commandDigest,
      requestDigest,
    }),
  );
  await writeFile(
    terminalPath,
    JSON.stringify({
      protocol: "clockgrove.factory/local-capture-command-terminal",
      commandDigest,
      requestDigest,
      exitCode: args.exitCode ?? 0,
      durationMs: 1,
      startedAt: "2026-09-17T00:00:00.000Z",
      completedAt: "2026-09-17T00:00:00.001Z",
      stdout: args.stdout ?? "",
      stderr: args.stderr ?? "",
    }),
  );
}

function localValidationInvocation(recipe: RepositoryCaptureRecipe, expectedBytes: Buffer) {
  const template = invocationFor({ recipe, expectedBytes });
  const { digest: _digest, ...core } = template;
  return createValidationInvocation({
    ...core,
    validationDeadline: "2099-09-17T00:10:00.000Z",
  });
}

function memoryStore() {
  const blobs = new Map<string, Buffer>();
  const trees = new Map<string, Map<string, string>>();
  const commits = new Map<string, GitCommitObject>();
  const refs = new Map<string, string>();
  const store: ContentTransferStore = {
    readRef: async (ref) => refs.get(ref) ?? null,
    readCommit: async (id) => commits.get(id)!,
    readTreeEntry: async (tree, path) => trees.get(tree)?.get(path) ?? null,
    readBlob: async (id) => {
      const bytes = blobs.get(id);
      if (!bytes) throw new Error("missing content blob");
      return Buffer.from(bytes);
    },
    createBlob: async (bytes) => {
      const id = oid(bytes);
      blobs.set(id, Buffer.from(bytes));
      return id;
    },
    createTree: async ({ entries }) => {
      const id = createHash("sha1").update(JSON.stringify(entries)).digest("hex");
      trees.set(id, new Map(entries.map((entry) => [entry.path, entry.sha])));
      return id;
    },
    createCommit: async ({ treeOid, parentOids, message }) => {
      const id = createHash("sha1")
        .update(JSON.stringify({ treeOid, parentOids, message }))
        .digest("hex");
      commits.set(id, { oid: id, treeOid, parentOids, message, serverTime: new Date() });
      return id;
    },
    createRef: async (ref, id) => {
      if (refs.has(ref)) return false;
      refs.set(ref, id);
      return true;
    },
  };
  return { store, refs };
}

function exactRecipe(args: {
  id?: string;
  roleId?: string;
  mediaType?: string;
  expectedDescriptorDigest: string;
  profile?: RepositoryCaptureRecipe["profile"];
  command?: string;
  deterministicGateId?: string;
}): RepositoryCaptureRecipe {
  const id = args.id ?? "capture-report";
  const commandDigest = sha(`capture-command:${id}`);
  const recipeCore = {
    id,
    mediaUse: { intentId: "intent-result-evidence", direction: "evidence-for" },
    criterionIds: ["criterion-result"],
    scenario: { id: "scenario-fixed", fixture: sha("fixture"), seed: null },
    captureCommand: {
      recipeId: `catalog-${id}`,
      recipeDigest: commandDigest,
      command: args.command ?? "npm run capture",
    },
    outputs: [{ roleId: args.roleId ?? "result", mediaType: args.mediaType ?? "text/plain" }],
    profile: args.profile ?? null,
    comparison: {
      kind: "exact",
      outputRoleId: args.roleId ?? "result",
      expectedDescriptorDigest: args.expectedDescriptorDigest,
      policy: { kind: "exact-bytes" },
    },
  };
  const gate = args.deterministicGateId
    ? (() => {
        const egressPolicy = {
          deterministicGateIds: [args.deterministicGateId],
          review: {
            mode: "denied" as const,
            maxAssets: 0,
            reviewerCapabilityIds: [] as string[],
          },
        };
        const authorityCore = {
          protocol: "clockgrove.factory/repository-capture-gate-authority" as const,
          authorityId: args.deterministicGateId,
          captureCommand: recipeCore.captureCommand,
          comparison: { kind: "exact" as const },
          expectedDescriptorDigest: args.expectedDescriptorDigest,
          expectedMediaType: args.mediaType ?? "text/plain",
          expectedDescriptorClass:
            (args.mediaType ?? "text/plain") === "text/plain"
              ? ("semantic" as const)
              : ("opaque" as const),
          expectedVisibility: "private" as const,
          expectedRightsBasis: "unknown" as const,
          observedVisibility: "private" as const,
          observedRightsBasis: "unknown" as const,
          profileId: recipeCore.profile?.kind ?? null,
          scenario: recipeCore.scenario,
          criterionIds: recipeCore.criterionIds,
          maximumCriteria: 64,
          policyDigest: sha(canonical(egressPolicy)),
        };
        return {
          kind: "deterministic-preauthorized" as const,
          authority: { ...authorityCore, digest: sha(canonical(authorityCore)) },
        };
      })()
    : ({ kind: "human-required" } as const);
  const core = { ...recipeCore, gate };
  return { ...core, digest: sha(canonical(core)) } as RepositoryCaptureRecipe;
}

function invocationFor(args: {
  recipe: RepositoryCaptureRecipe;
  expectedBytes: Buffer;
  visibility?: "private" | "public";
  rights?: { basis: "user-owned" | "unknown" };
}): ValidationInvocation {
  const expectedDescriptorDigest = args.recipe.comparison.expectedDescriptorDigest;
  const expectedStorageReceiptDigest = sha("expected-storage");
  const declaredMediaType = args.recipe.outputs.find(
    ({ roleId }) => roleId === args.recipe.comparison.outputRoleId,
  )!.mediaType;
  return createValidationInvocation({
    protocol: "clockgrove.factory/validation-invocation",
    repository: "Fixture/Repository",
    objective: 418,
    runId: "run-capture",
    workItem: 7,
    attempt: 1,
    attemptAuthority: {
      reservationRef: "refs/clockgrove-factory/attempts/418/7/1",
      reservationOid: "1".repeat(40),
      reservationReceiptDigest: sha("reservation"),
      directorEpoch: 1,
      policyDigest: sha("policy"),
    },
    validationDeadline: "2026-09-16T00:10:00.000Z",
    artifactDigest: sha("artifact"),
    baseSha: "a".repeat(40),
    outputTreeSha: "b".repeat(40),
    validationCommands: ["npm test", args.recipe.captureCommand.command],
    repositoryCaptureRecipes: [args.recipe],
    captureOutputAuthorities: args.recipe.outputs.map(({ roleId }) => ({
      recipeId: args.recipe.id,
      roleId,
      visibility: args.visibility ?? "private",
      rights: args.rights ?? { basis: "unknown" },
    })),
    comparisonAuthorities: [
      {
        recipeId: args.recipe.id,
        expectedDescriptorDigest,
        expectedContentDigest: sha(args.expectedBytes),
        expectedStorageReceiptDigest,
      },
    ],
    mediaInputs: [
      {
        descriptorDigest: expectedDescriptorDigest,
        contentDigest: sha(args.expectedBytes),
        storageReceiptDigest: expectedStorageReceiptDigest,
        activationDigest: sha("activation"),
        displayName: "expected.txt",
        declaredMediaType,
        inspection:
          declaredMediaType === "text/plain"
            ? {
                status: "semantic-valid",
                handlerId: "utf8-text",
                handlerContract: 1,
                mediaType: declaredMediaType,
                metadata: {
                  kind: "text",
                  encoding: "utf-8",
                  lines: args.expectedBytes.toString("utf8").split(/\r\n|\r|\n/).length,
                },
              }
            : {
                status: "opaque",
                handlerId: "opaque-passive",
                handlerContract: 1,
                mediaType: declaredMediaType,
                metadata: {
                  kind: "opaque",
                  reason: "no registered declared-type semantic validator",
                },
              },
        profileIds: args.recipe.profile ? [args.recipe.profile.kind] : [],
        visibility: "private",
        rights: { basis: "unknown" },
      },
    ],
    egressPolicy: {
      deterministicGateIds:
        args.recipe.gate.kind === "deterministic-preauthorized"
          ? [args.recipe.gate.authority.authorityId]
          : [],
      review: { mode: "denied", maxAssets: 0, reviewerCapabilityIds: [] },
    },
    toolEnvironment: {
      backendId: "local-validation",
      backendLocator: null,
      environmentIdentity: "node:test",
      egress: "local",
      toolReceiptDigests: [sha("tool")],
    },
  });
}

function persistCaptureBytes(args: {
  store: ContentTransferStore;
  invocation: ValidationInvocation;
  captures: CollectedRepositoryCapture[];
  expectedBytes?: Buffer;
  assertCurrent(): Promise<void>;
  assertOutputTree(outputTreeSha: string): Promise<void>;
}) {
  return persistRepositoryCaptures({
    store: args.store,
    invocation: args.invocation,
    collection: describeRepositoryCaptureBytes({
      invocation: args.invocation,
      captures: args.captures,
    }),
    downloadCapture: async ({ recipeId, roleId }) => {
      const capture = args.captures.find(
        (candidate) => candidate.recipeId === recipeId && candidate.roleId === roleId,
      );
      if (!capture) throw new Error("test capture download is missing");
      return capture.bytes;
    },
    downloadExpected: async () => args.expectedBytes ?? Buffer.from("expected\n"),
    assertCurrent: args.assertCurrent,
    assertOutputTree: args.assertOutputTree,
  });
}

describe("repository result capture evidence", () => {
  it("stores identical cross-recipe payloads once while retaining every use", async () => {
    const bytes = Buffer.from("shared capture\n");
    const first = exactRecipe({
      id: "first-capture",
      command: "npm run capture:first",
      expectedDescriptorDigest: sha("shared-reference"),
    });
    const second = exactRecipe({
      id: "second-capture",
      command: "npm run capture:second",
      expectedDescriptorDigest: sha("shared-reference"),
    });
    const template = invocationFor({ recipe: first, expectedBytes: bytes });
    const { digest: _templateDigest, ...templateCore } = template;
    const invocation = createValidationInvocation({
      ...templateCore,
      validationCommands: ["npm test", first.captureCommand.command, second.captureCommand.command],
      repositoryCaptureRecipes: [first, second],
      captureOutputAuthorities: [first, second].flatMap((recipe) =>
        recipe.outputs.map(({ roleId }) => ({
          recipeId: recipe.id,
          roleId,
          visibility: "private" as const,
          rights: { basis: "unknown" as const },
        })),
      ),
      comparisonAuthorities: [first, second].map((recipe) => ({
        recipeId: recipe.id,
        expectedDescriptorDigest: recipe.comparison.expectedDescriptorDigest,
        expectedContentDigest: sha(bytes),
        expectedStorageReceiptDigest: sha("expected-storage"),
      })),
    });
    const memory = memoryStore();
    const evidence = await persistCaptureBytes({
      store: memory.store,
      invocation,
      captures: [
        { recipeId: first.id, roleId: "result", path: "first/result.txt", bytes },
        { recipeId: second.id, roleId: "result", path: "second/result.txt", bytes },
      ],
      assertCurrent: async () => undefined,
      assertOutputTree: async () => undefined,
    });
    expect(evidence.manifest.entries).toHaveLength(1);
    expect(evidence.manifest.totalBytes).toBe(bytes.length);
    expect(evidence.uses).toHaveLength(2);
    expect(evidence.uses.map(({ sourcePath }) => sourcePath)).toEqual([
      "first/result.txt",
      "second/result.txt",
    ]);
    expect(new Set(evidence.uses.map(({ descriptorDigest }) => descriptorDigest)).size).toBe(1);
  });

  it("rejects media inspection and profile metadata that differs from recipe authority", () => {
    const recipe = exactRecipe({ expectedDescriptorDigest: sha("bound-reference") });
    const valid = invocationFor({ recipe, expectedBytes: Buffer.from("expected\n") });
    const { digest: _digest, ...core } = valid;
    expect(() =>
      createValidationInvocation({
        ...core,
        mediaInputs: core.mediaInputs.map((input) => ({
          ...input,
          inspection: { ...input.inspection, mediaType: "application/json" },
        })),
      }),
    ).toThrow(/inspection differs/);
    expect(() =>
      createValidationInvocation({
        ...core,
        mediaInputs: core.mediaInputs.map((input) => ({ ...input, profileIds: ["raster"] })),
      }),
    ).toThrow(/profiles differ/);
  });

  it("keeps ordinary source-only validation evidence unchanged", () => {
    const input = {
      protocol: "clockgrove.factory/validation-v1" as const,
      artifactDigest: sha("source-artifact"),
      baseSha: "a".repeat(40),
      outputTreeSha: "b".repeat(40),
      commands: [{ command: "npm test", exitCode: 0, durationMs: 1 }],
      passed: true,
      startedAt: "2026-09-16T00:00:00.000Z",
      completedAt: "2026-09-16T00:00:01.000Z",
    };
    const evidence = createValidationEvidence(input);
    expect(evidence).not.toHaveProperty("validationInvocation");
    expect(evidence).not.toHaveProperty("repositoryCapture");
    expect(evidence.digest).toBe(sha(JSON.stringify(input)));
    expect(() => verifyValidationEvidence(evidence)).not.toThrow();
  });

  it("persists opaque exact bytes without claiming semantic review", async () => {
    const bytes = Buffer.from([0, 255, 1, 254, 2, 253, 3, 252, 4, 251]);
    const expectedDescriptorDigest = sha("opaque-reference-descriptor");
    const recipe = exactRecipe({
      expectedDescriptorDigest,
      mediaType: "application/octet-stream",
      roleId: "opaque-result",
    });
    const invocation = invocationFor({ recipe, expectedBytes: bytes });
    const memory = memoryStore();
    const evidence = await persistCaptureBytes({
      store: memory.store,
      invocation,
      captures: [
        {
          recipeId: recipe.id,
          roleId: "opaque-result",
          path: "dist/result.bin",
          bytes,
        },
      ],
      assertCurrent: async () => undefined,
      assertOutputTree: async (tree) => expect(tree).toBe(invocation.outputTreeSha),
    });
    expect(evidence.manifest.entries[0]).toMatchObject({
      descriptor: {
        artifactDigest: invocation.artifactDigest,
        outputTreeSha: invocation.outputTreeSha,
        content: { digest: sha(bytes), inspection: { status: "opaque" } },
      },
      storage: { identity: { domain: "validation-evidence" } },
    });
    expect(evidence.manifest.mechanicalResults).toMatchObject([{ kind: "exact", passed: true }]);
    expect(() =>
      createValidationEvidence({
        protocol: "clockgrove.factory/validation-v1",
        artifactDigest: invocation.artifactDigest,
        baseSha: invocation.baseSha,
        outputTreeSha: invocation.outputTreeSha,
        commands: invocation.validationCommands.map((command) => ({
          command,
          exitCode: 0,
          durationMs: 1,
        })),
        passed: true,
        startedAt: "2026-09-16T00:00:00.000Z",
        completedAt: "2026-09-16T00:00:01.000Z",
        validationInvocationDigest: invocation.digest,
        repositoryCapture: evidence,
      }),
    ).not.toThrow();
    await expect(
      materializeRepositoryCapturesForReview({
        store: memory.store,
        evidence,
        capability: {
          id: "semantic-reviewer",
          mediaTypes: ["application/octet-stream"],
          profiles: [],
          allowUnprofiled: true,
          visibilities: ["private"],
          rightsBases: ["unknown"],
          semanticHandlers: [{ id: "opaque-passive", contract: 1 }],
          networkDestinations: [],
          maximumAssets: 1,
        },
        policy: {
          mode: "private-assets",
          maxAssets: 1,
          reviewerCapabilityIds: ["semantic-reviewer"],
          allowedNetworkDestinations: [],
        },
        supervisorRoot: join("/tmp", `factory-capture-review-${Date.now()}`),
      }),
    ).rejects.toThrow(/semantic handler/);
  });

  it("validates declared JSON semantically without relying on sniffed MIME", async () => {
    const bytes = Buffer.from('{"status":"ready","count":2}\n');
    const recipe = exactRecipe({
      expectedDescriptorDigest: sha("json-reference-descriptor"),
      mediaType: "application/json",
      roleId: "report",
    });
    const invocation = invocationFor({ recipe, expectedBytes: bytes });
    const evidence = await persistCaptureBytes({
      store: memoryStore().store,
      invocation,
      captures: [{ recipeId: recipe.id, roleId: "report", path: "reports/result", bytes }],
      assertCurrent: async () => undefined,
      assertOutputTree: async () => undefined,
    });
    expect(evidence.manifest.entries[0]!.descriptor.content).toMatchObject({
      declaredMediaType: "application/json",
      inspection: {
        status: "semantic-valid",
        handlerId: "json",
        mediaType: "application/json",
        metadata: { kind: "json", root: "object" },
      },
    });
  });

  it("refuses declared active content before publishing capture storage", async () => {
    const bytes = Buffer.from("<script>location='https://example.invalid'</script>");
    const recipe = exactRecipe({
      expectedDescriptorDigest: sha("active-reference-descriptor"),
      mediaType: "text/html",
      roleId: "report",
    });
    const invocation = invocationFor({ recipe, expectedBytes: bytes });
    const memory = memoryStore();
    await expect(
      persistCaptureBytes({
        store: memory.store,
        invocation,
        captures: [{ recipeId: recipe.id, roleId: "report", path: "reports/result", bytes }],
        assertCurrent: async () => undefined,
        assertOutputTree: async () => undefined,
      }),
    ).rejects.toThrow(/active or executable/);
    expect(memory.refs.size).toBe(0);
  });

  it("recomputes mechanical pass instead of trusting stored booleans", async () => {
    const bytes = Buffer.from("exact\n");
    const recipe = exactRecipe({ expectedDescriptorDigest: sha("exact-reference") });
    const invocation = invocationFor({ recipe, expectedBytes: bytes });
    const evidence = await persistCaptureBytes({
      store: memoryStore().store,
      invocation,
      captures: [{ recipeId: recipe.id, roleId: "result", path: "result.txt", bytes }],
      assertCurrent: async () => undefined,
      assertOutputTree: async () => undefined,
    });
    const { digest: _manifestDigest, ...manifestCore } = evidence.manifest;
    const manifest = {
      ...manifestCore,
      mechanicalResults: manifestCore.mechanicalResults.map((result) => ({
        ...result,
        passed: !result.passed,
      })),
    };
    const signedManifest = { ...manifest, digest: sha(canonical(manifest)) };
    const { digest: _evidenceDigest, ...evidenceCore } = evidence;
    const tamperedCore = { ...evidenceCore, manifest: signedManifest };
    const tampered = { ...tamperedCore, digest: sha(canonical(tamperedCore)) };
    expect(() => verifyRepositoryCaptureEvidenceBinding(tampered, invocation)).toThrow(
      /invocation comparison/,
    );
  });

  it("recovers exact capture bytes after the producer preview is gone and refuses private egress", async () => {
    const bytes = Buffer.from('{"status":"ready"}\n');
    const recipe = exactRecipe({ expectedDescriptorDigest: sha("json-reference") });
    const invocation = invocationFor({ recipe, expectedBytes: bytes });
    const memory = memoryStore();
    const evidence = await persistCaptureBytes({
      store: memory.store,
      invocation,
      captures: [{ recipeId: recipe.id, roleId: "result", path: "reports/result.json", bytes }],
      assertCurrent: async () => undefined,
      assertOutputTree: async () => undefined,
    });
    const capability = {
      id: "text-reviewer",
      mediaTypes: ["text/plain"],
      profiles: [] as "raster"[],
      allowUnprofiled: true,
      visibilities: ["private"] as Array<"private" | "public">,
      rightsBases: ["unknown"] as Array<
        "unknown" | "user-owned" | "licensed" | "permission-granted"
      >,
      semanticHandlers: [{ id: "utf8-text", contract: 1 }],
      networkDestinations: ["review.example.test"],
      maximumAssets: 1,
    };
    const inaccessibleStore = new Proxy(memory.store, {
      get() {
        throw new Error("content channel must not be touched before authorization");
      },
    });
    const blockedRoot = join("/tmp", `factory-capture-blocked-${Date.now()}`);
    await expect(
      materializeRepositoryCapturesForReview({
        store: inaccessibleStore,
        evidence,
        capability,
        policy: {
          mode: "public-assets",
          maxAssets: 1,
          reviewerCapabilityIds: ["text-reviewer"],
          allowedNetworkDestinations: [],
        },
        supervisorRoot: blockedRoot,
      }),
    ).rejects.toThrow(/destination|policy/);
    const root = join("/tmp", `factory-capture-review-${Date.now()}-ok`);
    roots.push(root);
    const materialized = await materializeRepositoryCapturesForReview({
      store: memory.store,
      evidence,
      capability,
      policy: {
        mode: "private-assets",
        maxAssets: 1,
        reviewerCapabilityIds: ["text-reviewer"],
        allowedNetworkDestinations: ["review.example.test"],
      },
      supervisorRoot: root,
    });
    expect(
      await readFile(
        join(
          materialized.root,
          `captures/${evidence.manifest.entries[0]!.descriptor.digest}/payload`,
        ),
      ),
    ).toEqual(bytes);
  });

  it("materializes only human-required evidence and preflights handler contracts before reads", async () => {
    const opaqueBytes = Buffer.from([0, 255, 1, 128]);
    const humanBytes = Buffer.from("review this exact result\n");
    const opaqueRecipe = exactRecipe({
      id: "opaque-mechanical",
      command: "npm run capture:opaque",
      expectedDescriptorDigest: sha("opaque-reference"),
      mediaType: "application/octet-stream",
      roleId: "opaque-result",
      deterministicGateId: "exact-bytes",
    });
    const humanRecipe = exactRecipe({
      id: "human-text",
      command: "npm run capture:text",
      expectedDescriptorDigest: sha("text-reference"),
      mediaType: "text/plain",
      roleId: "text-result",
    });
    const opaqueInvocation = invocationFor({ recipe: opaqueRecipe, expectedBytes: opaqueBytes });
    const humanInvocation = invocationFor({ recipe: humanRecipe, expectedBytes: humanBytes });
    const invocation = createValidationInvocation({
      protocol: "clockgrove.factory/validation-invocation",
      repository: "fixture/repository",
      objective: 418,
      runId: "run-mixed-review",
      workItem: 8,
      attempt: 1,
      attemptAuthority: opaqueInvocation.attemptAuthority,
      validationDeadline: opaqueInvocation.validationDeadline,
      artifactDigest: sha("artifact-mixed-review"),
      baseSha: "a".repeat(40),
      outputTreeSha: "b".repeat(40),
      validationCommands: [
        "npm test",
        opaqueRecipe.captureCommand.command,
        humanRecipe.captureCommand.command,
      ],
      repositoryCaptureRecipes: [opaqueRecipe, humanRecipe],
      captureOutputAuthorities: [
        ...opaqueInvocation.captureOutputAuthorities,
        ...humanInvocation.captureOutputAuthorities,
      ],
      comparisonAuthorities: [
        ...opaqueInvocation.comparisonAuthorities,
        ...humanInvocation.comparisonAuthorities,
      ],
      mediaInputs: [...opaqueInvocation.mediaInputs, ...humanInvocation.mediaInputs],
      egressPolicy: opaqueInvocation.egressPolicy,
      toolEnvironment: humanInvocation.toolEnvironment,
    });
    const memory = memoryStore();
    const evidence = await persistCaptureBytes({
      store: memory.store,
      invocation,
      captures: [
        {
          recipeId: opaqueRecipe.id,
          roleId: "opaque-result",
          path: "captures/result.bin",
          bytes: opaqueBytes,
        },
        {
          recipeId: humanRecipe.id,
          roleId: "text-result",
          path: "captures/result.txt",
          bytes: humanBytes,
        },
      ],
      assertCurrent: async () => undefined,
      assertOutputTree: async () => undefined,
    });
    const root = join("/tmp", `factory-capture-bundle-${Date.now()}`);
    roots.push(root);
    const downloadExpected = vi.fn(async (input: ValidationInvocation["mediaInputs"][number]) => {
      expect(input.descriptorDigest).toBe(humanRecipe.comparison.expectedDescriptorDigest);
      return humanBytes;
    });
    const capability = {
      id: "text-reviewer",
      mediaTypes: ["text/plain"],
      profiles: [] as string[],
      allowUnprofiled: true,
      visibilities: ["private"] as Array<"private" | "public">,
      rightsBases: ["unknown"] as Array<
        "unknown" | "user-owned" | "licensed" | "permission-granted"
      >,
      semanticHandlers: [{ id: "utf8-text", contract: 1 }],
      networkDestinations: [] as string[],
      maximumAssets: 2,
    };
    const policy = {
      mode: "private-assets" as const,
      maxAssets: 2,
      reviewerCapabilityIds: [capability.id],
      allowedNetworkDestinations: [] as string[],
    };
    const bundle = await materializeRepositoryCaptureReviewBundle({
      store: memory.store,
      invocation,
      evidence,
      capability,
      policy,
      supervisorRoot: root,
      downloadExpected,
    });
    expect(downloadExpected).toHaveBeenCalledTimes(1);
    expect(bundle.files).toHaveLength(1);
    expect(bundle.files[0]!.uses.map(({ recipeId }) => recipeId)).toEqual([
      humanRecipe.id,
      humanRecipe.id,
    ]);
    expect(bundle.files.every(({ handlerContract }) => handlerContract === 1)).toBe(true);

    const noRead = new Proxy(memory.store, {
      get() {
        throw new Error("content read occurred before handler preflight");
      },
    });
    const rejectedDownload = vi.fn(async () => humanBytes);
    await expect(
      materializeRepositoryCaptureReviewBundle({
        store: noRead,
        invocation,
        evidence,
        capability: {
          ...capability,
          semanticHandlers: [{ id: "utf8-text", contract: 2 }],
        },
        policy,
        supervisorRoot: join("/tmp", `factory-capture-rejected-${Date.now()}`),
        downloadExpected: rejectedDownload,
      }),
    ).rejects.toThrow(/semantic handler/);
    expect(rejectedDownload).not.toHaveBeenCalled();

    const deterministicOnly = invocationFor({
      recipe: opaqueRecipe,
      expectedBytes: opaqueBytes,
    });
    const deterministicEvidence = await persistCaptureBytes({
      store: memory.store,
      invocation: deterministicOnly,
      captures: [
        {
          recipeId: opaqueRecipe.id,
          roleId: "opaque-result",
          path: "captures/only.bin",
          bytes: opaqueBytes,
        },
      ],
      assertCurrent: async () => undefined,
      assertOutputTree: async () => undefined,
    });
    await expect(
      materializeRepositoryCaptureReviewBundle({
        store: noRead,
        invocation: deterministicOnly,
        evidence: deterministicEvidence,
        capability,
        policy,
        supervisorRoot: join("/tmp", `factory-capture-mechanical-${Date.now()}`),
        downloadExpected: rejectedDownload,
      }),
    ).rejects.toThrow(/no human-required recipes/);
    expect(rejectedDownload).not.toHaveBeenCalled();
  });

  it("validates raster profile dimensions and exact result-tree identity", async () => {
    const png = await sharp({
      create: { width: 4, height: 3, channels: 4, background: "#336699" },
    })
      .png()
      .toBuffer();
    const recipe = exactRecipe({
      expectedDescriptorDigest: sha("raster-reference"),
      mediaType: "image/png",
      roleId: "capture",
      profile: {
        kind: "raster",
        viewport: { width: 800, height: 600 },
        output: { width: 4, height: 3 },
        captureRoleId: "capture",
        diffRoleId: null,
        previewRoleId: null,
        constraints: {
          kind: "raster",
          minimumWidth: 4,
          maximumWidth: 4,
          minimumHeight: 3,
          maximumHeight: 3,
          alpha: "required",
          animation: "forbidden",
        },
      },
    });
    const invocation = invocationFor({ recipe, expectedBytes: png });
    const memory = memoryStore();
    await expect(
      persistCaptureBytes({
        store: memory.store,
        invocation,
        captures: [
          { recipeId: recipe.id, roleId: "capture", path: "captures/frame.png", bytes: png },
        ],
        assertCurrent: async () => undefined,
        assertOutputTree: async () => {
          throw new Error("exact result tree changed");
        },
      }),
    ).rejects.toThrow(/result tree changed/);
    expect(memory.refs.size).toBe(0);
  });

  it("journals the exact invocation before clean validation and captures only the result tree", async () => {
    const repository = await mkdtemp(join(tmpdir(), "factory-repository-capture-clean-"));
    roots.push(repository);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repository });
    execFileSync("git", ["config", "user.name", "Factory Test"], { cwd: repository });
    execFileSync("git", ["config", "user.email", "factory@example.invalid"], {
      cwd: repository,
    });
    await writeFile(join(repository, "value.txt"), "base\n");
    execFileSync("git", ["add", "value.txt"], { cwd: repository });
    execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: repository });
    const baseSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repository,
      encoding: "utf8",
    }).trim();
    const worker = await createLocalWorktree(repository, baseSha);
    await writeFile(join(worker.path, "value.txt"), "changed\n");
    const artifact = await collectLocalArtifact(worker);
    await cleanupLocalWorktree(worker);
    const bytes = Buffer.from("changed\n");
    const recipe = exactRecipe({ expectedDescriptorDigest: sha("clean-reference") });
    const memory = memoryStore();
    const stages: string[] = [];
    const stagingRoot = await mkdtemp(join(tmpdir(), "factory-local-capture-"));
    roots.push(stagingRoot);
    const packet: RepositoryChangeWorkerPacket = {
      protocol: "clockgrove.factory/worker-packet",
      goal: "Change the value.",
      acceptanceCriteria: ["value.txt contains changed"],
      allowedPaths: ["value.txt"],
      preconditions: [],
      outOfScope: [],
      conventions: [],
      baseSha,
      validationCommands: ["grep -qx changed value.txt", recipe.captureCommand.command],
      requirements: {
        os: ["linux"],
        architecture: [],
        tools: ["grep", "npm"],
        services: [],
        networkDestinations: [],
        permittedSecretNames: [],
        trust: "trusted_local",
      },
      deliverable: {
        kind: "repository-change",
        contract: "clockgrove.factory/artifact",
      },
      repositoryCaptureRecipes: [recipe],
    };
    let invocation: ValidationInvocation | undefined;
    const result = await validateArtifactClean({
      repository,
      artifact,
      packet,
      repositoryCaptureRuntime: {
        createInvocation: (identity) => {
          const template = invocationFor({ recipe, expectedBytes: bytes });
          const { digest: _templateDigest, ...templateCore } = template;
          invocation = createValidationInvocation({
            ...templateCore,
            artifactDigest: identity.artifactDigest,
            baseSha: identity.baseSha,
            outputTreeSha: identity.outputTreeSha,
            validationCommands: identity.validationCommands,
          });
          return invocation;
        },
        execute: async ({
          invocation: prepared,
          resultRoot,
          assertOutputTree,
          ordinaryValidationCommands: _ordinaryValidationCommands,
          launchValidation,
        }) => {
          return runValidationInvocationTransaction({
            invocation: prepared,
            observeFinal: async () => null,
            observeIntent: async () => null,
            persistIntent: async () => {
              stages.push("prepared");
            },
            observe: async () => null,
            launch: async () => {
              const validation = await launchValidation();
              expect(validation).toMatchObject({
                passed: true,
                commands: [{ command: "grep -qx changed value.txt", exitCode: 0 }],
              });
              stages.push("collected");
              const retained = await executeLocalRepositoryCaptures({
                stagingRoot,
                invocation: prepared,
                resultTreeRoot: resultRoot,
                environment: {},
                runCommand: async ({ env }) => {
                  const request = JSON.parse(
                    await readFile(env["FACTORY_CAPTURE_REQUEST"]!, "utf8"),
                  );
                  await writeFile(request.recipes[0].outputs[0].path, bytes);
                  await checkpointMockCommand(env, recipe.captureCommand.command);
                  return { exitCode: 0, durationMs: 1, stdout: "", stderr: "" };
                },
                observeCommand: async () => "absent",
                commandDeadline: null,
                allowLaunch: true,
                assertOutputTree,
              });
              const repositoryCapture = await persistRepositoryCaptures({
                store: memory.store,
                invocation: prepared,
                collection: retained.collection,
                downloadCapture: retained.downloadCapture,
                downloadExpected: async () => bytes,
                assertCurrent: async () => undefined,
                assertOutputTree: async () => assertOutputTree(),
              });
              const byCommand = new Map([
                ...validation.commands.map((result) => [result.command, result] as const),
                ...retained.commandResults.map((result) => [result.command, result] as const),
              ]);
              return {
                validation: {
                  ...validation,
                  commands: prepared.validationCommands.map((command) => byCommand.get(command)!),
                },
                repositoryCapture,
              };
            },
            persistFinal: async (result) => result,
          });
        },
      },
    });
    expect(stages).toEqual(["prepared", "collected"]);
    expect(result.evidence.repositoryCapture?.manifest.entries[0]).toMatchObject({
      descriptor: { outputTreeSha: result.evidence.outputTreeSha },
    });
    expect(result.evidence.repositoryCapture?.manifest.mechanicalResults).toMatchObject([
      { passed: true },
    ]);
    expect(() => verifyValidationEvidence(result.evidence)).not.toThrow();
    await discardValidationResult(result);
  });

  it("captures hydrated LFS bytes while preserving the pointer tree and rejects raw mutation", async () => {
    const repository = await mkdtemp(join(tmpdir(), "factory-repository-capture-lfs-"));
    roots.push(repository);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repository });
    execFileSync("git", ["config", "user.name", "Factory Test"], { cwd: repository });
    execFileSync("git", ["config", "user.email", "factory@example.invalid"], {
      cwd: repository,
    });
    await writeFile(join(repository, ".gitattributes"), "*.bin filter=lfs diff=lfs -text\n");
    execFileSync("git", ["add", ".gitattributes"], { cwd: repository });
    execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: repository });
    const baseSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repository,
      encoding: "utf8",
    }).trim();
    const raw = Buffer.from("exact raw LFS result bytes\n");
    const worker = await createLocalWorktree(repository, baseSha);
    await writeFile(join(worker.path, "asset.bin"), raw);
    const collected = await collectLocalArtifact(worker);
    await cleanupLocalWorktree(worker);
    expect(collected.pendingLfsObjects).toHaveLength(1);
    const memory = memoryStore();
    const transport: LfsOutputTransport = {
      preflight: async () => ({
        toolVersion: "git-lfs/3.7.0",
        remoteDigest: sha("fixture-lfs-remote"),
        remoteHost: "github.com",
        endpoint: "https://github.com/fixture/repository.git/info/lfs",
      }),
      upload: async () => "uploaded",
      read: async () => raw,
    };
    const artifact = await finalizeLfsArtifact({
      store: memory.store,
      artifact: collected,
      authority: {
        repository: "fixture/repository",
        objective: 418,
        workItem: 7,
        attempt: 1,
        runId: "run-lfs-capture",
        directorEpoch: 1,
        policyDigest: sha("policy"),
      },
      repositoryPath: repository,
      allowedNetworkDestinations: ["github.com"],
      assertCurrent: async () => undefined,
      transport,
    });
    const recipe = exactRecipe({
      id: "capture-lfs-result",
      command: "npm run capture:lfs",
      expectedDescriptorDigest: sha("lfs-reference"),
    });
    const packet: RepositoryChangeWorkerPacket = {
      protocol: "clockgrove.factory/worker-packet",
      goal: "Validate and capture the exact large-file result.",
      acceptanceCriteria: ["The exact result bytes match the expected result."],
      allowedPaths: ["asset.bin"],
      preconditions: [],
      outOfScope: [],
      conventions: [],
      baseSha,
      validationCommands: [
        "grep -qx 'exact raw LFS result bytes' asset.bin",
        recipe.captureCommand.command,
      ],
      requirements: {
        os: ["linux"],
        architecture: [],
        tools: ["grep", "npm"],
        services: [],
        networkDestinations: [],
        permittedSecretNames: [],
        trust: "trusted_local",
      },
      deliverable: {
        kind: "repository-change",
        contract: "clockgrove.factory/artifact",
      },
      repositoryCaptureRecipes: [recipe],
    };
    let preparedInvocation: ValidationInvocation | undefined;
    const validate = (mutateRaw: boolean) => {
      const stagingRoot = join(repository, `.factory-capture-${mutateRaw ? "mutated" : "exact"}`);
      return validateArtifactClean({
        repository,
        artifact,
        packet,
        repositoryCaptureRuntime: {
          createInvocation: (identity) => {
            const template = invocationFor({ recipe, expectedBytes: raw });
            const { digest: _templateDigest, ...templateCore } = template;
            preparedInvocation = createValidationInvocation({
              ...templateCore,
              artifactDigest: identity.artifactDigest,
              baseSha: identity.baseSha,
              outputTreeSha: identity.outputTreeSha,
              validationCommands: identity.validationCommands,
              egressPolicy: {
                ...templateCore.egressPolicy,
                review: {
                  mode: "private-assets",
                  maxAssets: 2,
                  reviewerCapabilityIds: ["text-reviewer"],
                },
              },
            });
            return preparedInvocation;
          },
          execute: async ({
            invocation,
            resultRoot,
            assertOutputTree,
            ordinaryValidationCommands: _ordinaryValidationCommands,
            launchValidation,
          }) => {
            const validation = await launchValidation();
            const retained = await executeLocalRepositoryCaptures({
              stagingRoot,
              invocation,
              resultTreeRoot: resultRoot,
              environment: {},
              runCommand: async ({ env }) => {
                const observed = await readFile(join(resultRoot, "asset.bin"));
                expect(observed).toEqual(raw);
                const request = JSON.parse(await readFile(env["FACTORY_CAPTURE_REQUEST"]!, "utf8"));
                await writeFile(request.recipes[0].outputs[0].path, observed);
                if (mutateRaw) await writeFile(join(resultRoot, "asset.bin"), "corrupt\n");
                await checkpointMockCommand(env, recipe.captureCommand.command);
                return { exitCode: 0, durationMs: 1, stdout: "", stderr: "" };
              },
              observeCommand: async () => "absent",
              commandDeadline: null,
              allowLaunch: true,
              assertOutputTree,
            });
            const repositoryCapture = await persistRepositoryCaptures({
              store: memory.store,
              invocation,
              collection: retained.collection,
              downloadCapture: retained.downloadCapture,
              downloadExpected: async () => raw,
              assertCurrent: async () => undefined,
              assertOutputTree: async () => assertOutputTree(),
            });
            const byCommand = new Map([
              ...validation.commands.map((result) => [result.command, result] as const),
              ...retained.commandResults.map((result) => [result.command, result] as const),
            ]);
            return {
              validation: {
                ...validation,
                commands: invocation.validationCommands.map((command) => byCommand.get(command)!),
              },
              repositoryCapture,
            };
          },
        },
      });
    };
    const result = await validate(false);
    expect(result.evidence.outputTreeSha).toBe(artifact.fileManifest!.resultTreeSha);
    expect(result.evidence.repositoryCapture?.manifest.entries[0]?.descriptor.content.digest).toBe(
      sha(raw),
    );
    const reviewBundleRoot = await mkdtemp(join(tmpdir(), "factory-lfs-review-bundle-"));
    roots.push(reviewBundleRoot);
    const reviewBundle = await materializeRepositoryCaptureReviewBundle({
      store: memory.store,
      invocation: preparedInvocation!,
      evidence: result.evidence.repositoryCapture!,
      capability: {
        id: "text-reviewer",
        mediaTypes: ["text/plain"],
        profiles: [],
        allowUnprofiled: true,
        visibilities: ["private"],
        rightsBases: ["unknown"],
        semanticHandlers: [{ id: "utf8-text", contract: 1 }],
        networkDestinations: [],
        maximumAssets: 2,
      },
      policy: {
        mode: "private-assets",
        maxAssets: 2,
        reviewerCapabilityIds: ["text-reviewer"],
        allowedNetworkDestinations: [],
      },
      supervisorRoot: reviewBundleRoot,
      downloadExpected: async () => raw,
    });
    await withVerifiedReviewCheckout(
      {
        repository,
        objectiveNumber: 418,
        workItemNumber: 7,
        packet,
        artifact,
        evidence: result.evidence,
        repositoryCaptureBundle: reviewBundle,
        requiresIsolation: false,
      },
      async (reviewRepository, materializedBundle) => {
        expect(await readFile(join(reviewRepository, "asset.bin"))).toEqual(raw);
        expect(
          execFileSync("git", ["write-tree"], {
            cwd: reviewRepository,
            encoding: "utf8",
          }).trim(),
        ).toBe(artifact.fileManifest!.resultTreeSha);
        expect(materializedBundle?.files).toHaveLength(1);
        expect(materializedBundle?.files[0]?.uses).toHaveLength(2);
        expect(
          materializedBundle?.files.every(
            ({ path }) =>
              path.startsWith(join(reviewRepository, ".factory-review-evidence")) &&
              path !== join(reviewRepository, "asset.bin"),
          ),
        ).toBe(true);
        expect(await readFile(materializedBundle!.files[0]!.path)).toEqual(raw);
      },
    );
    await discardValidationResult(result);
    await restoreLfsArtifactContent({ store: memory.store, artifact });
    await expect(validate(true)).rejects.toThrow(/materialized LFS object (?:size|digest) differs/);
  });
});

describe("validation invocation no-replay transaction", () => {
  it("stores the maximum 512-output compact evidence envelope below the durable ceiling", async () => {
    const recipes = Array.from({ length: 32 }, (_, recipeIndex) => {
      const base = exactRecipe({
        id: `recipe-${recipeIndex}`,
        roleId: "role-0",
        expectedDescriptorDigest: sha(`expected-${recipeIndex}`),
      });
      const { digest: _digest, ...core } = base;
      const expanded = {
        ...core,
        captureCommand: {
          ...core.captureCommand,
          command: `npm run capture:${recipeIndex}`,
        },
        outputs: Array.from({ length: 16 }, (_, outputIndex) => ({
          roleId: `role-${outputIndex}`,
          mediaType: "application/octet-stream",
        })),
        comparison: { ...core.comparison, outputRoleId: "role-0" },
      };
      return { ...expanded, digest: sha(canonical(expanded)) } as RepositoryCaptureRecipe;
    });
    const captures = recipes.flatMap((recipe, recipeIndex) =>
      recipe.outputs.map((output, outputIndex) => ({
        recipeId: recipe.id,
        roleId: output.roleId,
        path: `captures/${recipeIndex}/${outputIndex}`,
        bytes: Buffer.from([0, 255, recipeIndex, outputIndex, 128]),
      })),
    );
    const invocation = createValidationInvocation({
      protocol: "clockgrove.factory/validation-invocation",
      repository: "fixture/repository",
      objective: 418,
      runId: "run-ceiling",
      workItem: 9,
      attempt: 1,
      attemptAuthority: {
        reservationRef: "refs/clockgrove-factory/attempts/418/9/1",
        reservationOid: "2".repeat(40),
        reservationReceiptDigest: sha("ceiling-reservation"),
        directorEpoch: 1,
        policyDigest: sha("policy"),
      },
      validationDeadline: "2026-09-16T00:10:00.000Z",
      artifactDigest: sha("artifact-ceiling"),
      baseSha: "a".repeat(40),
      outputTreeSha: "b".repeat(40),
      validationCommands: ["npm test", ...recipes.map((recipe) => recipe.captureCommand.command)],
      repositoryCaptureRecipes: recipes,
      captureOutputAuthorities: recipes.flatMap((recipe) =>
        recipe.outputs.map(({ roleId }) => ({
          recipeId: recipe.id,
          roleId,
          visibility: "private" as const,
          rights: { basis: "unknown" as const },
        })),
      ),
      comparisonAuthorities: recipes.map((recipe, recipeIndex) => ({
        recipeId: recipe.id,
        expectedDescriptorDigest: recipe.comparison.expectedDescriptorDigest,
        expectedContentDigest: sha(`expected-content-${recipeIndex}`),
        expectedStorageReceiptDigest: sha(`expected-storage-${recipeIndex}`),
      })),
      mediaInputs: recipes.map((recipe, recipeIndex) => ({
        descriptorDigest: recipe.comparison.expectedDescriptorDigest,
        contentDigest: sha(`expected-content-${recipeIndex}`),
        storageReceiptDigest: sha(`expected-storage-${recipeIndex}`),
        activationDigest: sha(`activation-${recipeIndex}`),
        displayName: `expected-${recipeIndex}.bin`,
        declaredMediaType: "application/octet-stream",
        inspection: {
          status: "opaque",
          handlerId: "opaque-passive",
          handlerContract: 1,
          mediaType: "application/octet-stream",
          metadata: {
            kind: "opaque",
            reason: "no registered declared-type semantic validator",
          },
        },
        profileIds: [],
        visibility: "private" as const,
        rights: { basis: "unknown" as const },
      })),
      egressPolicy: {
        deterministicGateIds: [],
        review: { mode: "denied", maxAssets: 0, reviewerCapabilityIds: [] },
      },
      toolEnvironment: {
        backendId: "local-validation",
        backendLocator: null,
        environmentIdentity: "fixture:ceiling",
        egress: "local",
        toolReceiptDigests: [sha("tool")],
      },
    });
    const memory = memoryStore();
    await persistValidationInvocation({
      store: memory.store,
      invocation,
      assertCurrent: async () => undefined,
    });
    const collection = createRepositoryCaptureCollection({
      invocation,
      files: captures.map(({ recipeId, roleId, path, bytes }) => ({
        recipeId,
        roleId,
        path,
        mediaType: "application/octet-stream",
        bytes: bytes.length,
        digest: sha(bytes),
      })),
    });
    const entries = captures.map(({ bytes }, index) => {
      const contentDigest = sha(bytes);
      const descriptorCore = {
        protocol: "clockgrove.factory/evidence-capture-descriptor" as const,
        validationInvocationDigest: invocation.digest,
        artifactDigest: invocation.artifactDigest,
        baseSha: invocation.baseSha,
        outputTreeSha: invocation.outputTreeSha,
        content: {
          protocol: "clockgrove.factory/evidence-capture-content" as const,
          digest: contentDigest,
          bytes: bytes.length,
          declaredMediaType: "application/octet-stream",
          inspection: {
            status: "opaque" as const,
            handlerId: "opaque-passive",
            handlerContract: 1,
            mediaType: "application/octet-stream",
            metadata: {
              kind: "opaque" as const,
              reason: "no registered declared-type semantic validator",
            },
          },
        },
        visibility: "private" as const,
        rights: { basis: "unknown" as const },
      };
      const descriptor = { ...descriptorCore, digest: sha(canonical(descriptorCore)) };
      const identity = {
        domain: "validation-evidence" as const,
        repository: invocation.repository,
        objective: invocation.objective,
        baseSha: invocation.baseSha,
        requestId: `capture-r${Math.floor(index / 16)}-o${index % 16}`,
        subjectDigest: contentDigest,
      };
      const storageCore = {
        protocol: "clockgrove.factory/evidence-capture-storage-receipt" as const,
        descriptorDigest: descriptor.digest,
        identity,
        payloadDigest: contentDigest,
        payloadBytes: bytes.length,
        transferRef: `refs/clockgrove-factory/test/${index}`,
        intentCommit: oid(Buffer.from(`intent-${index}`)),
        readyCommit: oid(Buffer.from(`ready-${index}`)),
      };
      return { descriptor, storage: { ...storageCore, digest: sha(canonical(storageCore)) } };
    });
    const mechanicalResults = recipes.map((recipe, recipeIndex) => {
      const authority = invocation.comparisonAuthorities[recipeIndex]!;
      const subject = entries[recipeIndex * 16]!.descriptor.content.digest;
      return {
        kind: "exact" as const,
        recipeId: recipe.id,
        outputRoleId: recipe.comparison.outputRoleId,
        expectedDescriptorDigest: authority.expectedDescriptorDigest,
        expectedContentDigest: authority.expectedContentDigest,
        expectedStorageReceiptDigest: authority.expectedStorageReceiptDigest,
        observedContentDigest: subject,
        passed: subject === authority.expectedContentDigest,
      };
    });
    const manifestCore = {
      protocol: "clockgrove.factory/evidence-capture-manifest" as const,
      validationInvocationDigest: invocation.digest,
      entries,
      mechanicalResults,
      totalBytes: captures.reduce((sum, { bytes }) => sum + bytes.length, 0),
    };
    const manifest = { ...manifestCore, digest: sha(canonical(manifestCore)) };
    const evidenceCore = {
      protocol: "clockgrove.factory/repository-capture-evidence" as const,
      validationInvocationDigest: invocation.digest,
      collection,
      manifest,
      uses: recipes.flatMap((recipe) =>
        recipe.outputs.map((output) => ({
          descriptorDigest: entries.find(
            ({ descriptor }) =>
              descriptor.content.digest ===
              sha(
                captures.find(
                  (capture) => capture.recipeId === recipe.id && capture.roleId === output.roleId,
                )!.bytes,
              ),
          )!.descriptor.digest,
          recipeId: recipe.id,
          recipeDigest: recipe.digest,
          mediaUse: recipe.mediaUse,
          criterionIds: recipe.criterionIds,
          scenarioId: recipe.scenario.id,
          outputRole: output.roleId,
          sourcePath: captures.find(
            (capture) => capture.recipeId === recipe.id && capture.roleId === output.roleId,
          )!.path,
          profile: recipe.profile,
        })),
      ),
    };
    const repositoryCapture = RepositoryCaptureEvidenceSchema.parse({
      ...evidenceCore,
      digest: sha(canonical(evidenceCore)),
    });
    expect(repositoryCapture.uses).toHaveLength(512);
    const stored = await persistValidationInvocationResult({
      store: memory.store,
      invocation,
      validation: {
        outputTreeSha: invocation.outputTreeSha,
        commands: invocation.validationCommands.map((command) => ({
          command,
          exitCode: 0,
          durationMs: 1,
        })),
        passed: true,
        startedAt: "2026-09-16T00:00:00.000Z",
        completedAt: "2026-09-16T00:00:01.000Z",
        environmentIdentity: invocation.toolEnvironment.environmentIdentity,
      },
      repositoryCapture,
      assertCurrent: async () => undefined,
    });
    const encodedBytes = Buffer.byteLength(canonical(stored.result));
    expect(encodedBytes).toBeGreaterThan(1024 * 1024);
    expect(encodedBytes).toBeLessThan(MAX_VALIDATION_INVOCATION_RESULT_BYTES);
    expect(stored.commit).toMatch(/^[a-f0-9]{40}$/);
  });

  it("persists a fresh intent before launching and finalizing", async () => {
    const bytes = Buffer.from("reference\n");
    const recipe = exactRecipe({ expectedDescriptorDigest: sha("descriptor") });
    const invocation = invocationFor({ recipe, expectedBytes: bytes });
    const stages: string[] = [];
    await expect(
      runValidationInvocationTransaction({
        invocation,
        observeFinal: async () => null,
        observeIntent: async () => null,
        persistIntent: async () => {
          stages.push("intent");
        },
        observe: async () => null,
        launch: async () => {
          stages.push("launch");
          return "result";
        },
        persistFinal: async (result) => {
          stages.push("final");
          return result;
        },
      }),
    ).resolves.toBe("result");
    expect(stages).toEqual(["intent", "launch", "final"]);
  });

  it("observes the prepared invocation before launch on restart", async () => {
    const bytes = Buffer.from("reference\n");
    const recipe = exactRecipe({ expectedDescriptorDigest: sha("descriptor") });
    const invocation = invocationFor({ recipe, expectedBytes: bytes });
    const launch = vi.fn(async () => "launched");
    const persistFinal = vi.fn(async (result: string) => result);
    await expect(
      runValidationInvocationTransaction({
        invocation,
        observeFinal: async () => null,
        observeIntent: async () => invocation,
        persistIntent: async () => {
          throw new Error("intent already exists");
        },
        observe: async () => "observed",
        launch,
        persistFinal,
      }),
    ).resolves.toBe("observed");
    expect(launch).not.toHaveBeenCalled();
    expect(persistFinal).toHaveBeenCalledWith("observed");
  });

  it("refuses to replay an unobservable prepared invocation", async () => {
    const bytes = Buffer.from("reference\n");
    const recipe = exactRecipe({ expectedDescriptorDigest: sha("descriptor") });
    const invocation = invocationFor({ recipe, expectedBytes: bytes });
    const launch = vi.fn(async () => "launched");
    await expect(
      runValidationInvocationTransaction({
        invocation,
        observeFinal: async () => null,
        observeIntent: async () => invocation,
        persistIntent: async () => undefined,
        observe: async () => null,
        launch,
        persistFinal: async (result) => result,
      }),
    ).rejects.toThrow(/replay is refused/);
    expect(launch).not.toHaveBeenCalled();
  });
});

describe("local validation and capture staging", () => {
  const ordinaryCommandExecution = {
    executable: "/bin/sh",
    args: ["-c", "npm test"],
    cwd: ".",
    timeoutMs: 60_000,
  };

  const executeOrdinaryCommand = (args: {
    stagingRoot: string;
    invocation: ValidationInvocation;
    runCommand: Parameters<typeof executeLocalValidationCommand>[0]["runCommand"];
    observeCommand?: Parameters<typeof executeLocalValidationCommand>[0]["observeCommand"];
    allowLaunch?: boolean;
  }) =>
    executeLocalValidationCommand({
      stagingRoot: args.stagingRoot,
      invocation: args.invocation,
      commandIndex: 0,
      plannedCommand: "npm test",
      execution: ordinaryCommandExecution,
      cwd: args.stagingRoot,
      environment: {},
      runCommand: args.runCommand,
      observeCommand: args.observeCommand ?? (async () => "absent"),
      commandDeadline: args.invocation.validationDeadline,
      allowLaunch: args.allowLaunch ?? true,
    });

  it("retries an ordinary command only when the durable dispatch receipt is absent", async () => {
    const bytes = Buffer.from("ordinary-safe-retry\n");
    const recipe = exactRecipe({ expectedDescriptorDigest: sha("descriptor") });
    const invocation = localValidationInvocation(recipe, bytes);
    const root = await mkdtemp(join(tmpdir(), "factory-local-validation-safe-retry-"));
    roots.push(root);
    const command = vi
      .fn()
      .mockRejectedValueOnce(new Error("scope refused before wrapper start"))
      .mockImplementationOnce(async ({ args }: { args: string[] }) => {
        await checkpointValidationCommand({ wrapperArgs: args, command: "npm test" });
        return { exitCode: 0, durationMs: 1, stdout: "", stderr: "" };
      });

    await expect(
      executeOrdinaryCommand({ stagingRoot: root, invocation, runCommand: command }),
    ).rejects.toThrow(/before wrapper start/);
    await expect(
      inspectLocalRepositoryCaptureDispatchState({ stagingRoot: root, invocation }),
    ).resolves.toBe("rebound-safe");
    await expect(
      executeOrdinaryCommand({ stagingRoot: root, invocation, runCommand: command }),
    ).resolves.toMatchObject({ command: "npm test", exitCode: 0 });
    expect(command).toHaveBeenCalledTimes(2);
  });

  it("adopts an ordinary command terminal after response loss without relaunching", async () => {
    const bytes = Buffer.from("ordinary-terminal-adoption\n");
    const recipe = exactRecipe({ expectedDescriptorDigest: sha("descriptor") });
    const invocation = localValidationInvocation(recipe, bytes);
    const root = await mkdtemp(join(tmpdir(), "factory-local-validation-terminal-"));
    roots.push(root);
    const command = vi.fn(async ({ args }: { args: string[] }) => {
      await checkpointValidationCommand({
        wrapperArgs: args,
        command: "npm test",
        stdout: "passed\n",
      });
      throw new Error("controller lost the wrapper response");
    });

    await expect(
      executeOrdinaryCommand({ stagingRoot: root, invocation, runCommand: command }),
    ).rejects.toThrow(/lost the wrapper response/);
    const adopted = await executeOrdinaryCommand({
      stagingRoot: root,
      invocation,
      runCommand: command,
      allowLaunch: false,
    });
    expect(adopted).toMatchObject({ command: "npm test", exitCode: 0, stdout: "passed\n" });
    expect(command).toHaveBeenCalledTimes(1);
  });

  it("fails closed after an ordinary command start without terminal evidence", async () => {
    const bytes = Buffer.from("ordinary-ambiguous\n");
    const recipe = exactRecipe({ expectedDescriptorDigest: sha("descriptor") });
    const invocation = localValidationInvocation(recipe, bytes);
    const root = await mkdtemp(join(tmpdir(), "factory-local-validation-ambiguous-"));
    roots.push(root);
    const command = vi.fn(async ({ args }: { args: string[] }) => {
      const requestPath = args[1]!;
      await writeFile(
        args[3]!,
        JSON.stringify({
          protocol: "clockgrove.factory/local-capture-command-started",
          commandDigest: args[4]!,
          requestDigest: sha(await readFile(requestPath)),
        }),
      );
      throw new Error("controller crashed after dispatch");
    });

    await expect(
      executeOrdinaryCommand({ stagingRoot: root, invocation, runCommand: command }),
    ).rejects.toThrow(/crashed after dispatch/);
    await expect(
      inspectLocalRepositoryCaptureDispatchState({ stagingRoot: root, invocation }),
    ).resolves.toBe("ambiguous");
    await expect(
      executeOrdinaryCommand({
        stagingRoot: root,
        invocation,
        runCommand: command,
        allowLaunch: false,
      }),
    ).rejects.toThrow(/dispatch-authorized/);
    expect(command).toHaveBeenCalledTimes(1);
  });

  it("refuses an ordinary command whose immutable invocation deadline expired", async () => {
    const bytes = Buffer.from("ordinary-deadline\n");
    const recipe = exactRecipe({ expectedDescriptorDigest: sha("descriptor") });
    const template = localValidationInvocation(recipe, bytes);
    const { digest: _digest, ...core } = template;
    const invocation = createValidationInvocation({
      ...core,
      validationDeadline: "2000-01-01T00:00:00.000Z",
    });
    const root = await mkdtemp(join(tmpdir(), "factory-local-validation-deadline-"));
    roots.push(root);
    const command = vi.fn();

    await expect(
      executeOrdinaryCommand({ stagingRoot: root, invocation, runCommand: command }),
    ).rejects.toThrow(/deadline is exhausted before dispatch/);
    expect(command).not.toHaveBeenCalled();
  });

  it("keeps observation-only recovery non-dispatching when no start exists", async () => {
    const bytes = Buffer.from("ordinary-observe-only\n");
    const recipe = exactRecipe({ expectedDescriptorDigest: sha("descriptor") });
    const invocation = localValidationInvocation(recipe, bytes);
    const root = await mkdtemp(join(tmpdir(), "factory-local-validation-observe-only-"));
    roots.push(root);
    const command = vi.fn();

    await expect(
      executeOrdinaryCommand({
        stagingRoot: root,
        invocation,
        runCommand: command,
        allowLaunch: false,
      }),
    ).rejects.toThrow(/launch is forbidden during observation-only recovery/);
    expect(command).not.toHaveBeenCalled();
  });

  it("resumes a prepared transaction by adopting the ordinary terminal exactly once", async () => {
    const bytes = Buffer.from("ordinary-transaction-adoption\n");
    const recipe = exactRecipe({ expectedDescriptorDigest: sha("descriptor") });
    const invocation = localValidationInvocation(recipe, bytes);
    const root = await mkdtemp(join(tmpdir(), "factory-local-validation-transaction-"));
    roots.push(root);
    const command = vi.fn(async ({ args }: { args: string[] }) => {
      await checkpointValidationCommand({ wrapperArgs: args, command: "npm test" });
      throw new Error("controller crashed before validation checkpoint");
    });
    const resume = async () =>
      executeOrdinaryCommand({
        stagingRoot: root,
        invocation,
        runCommand: command,
        allowLaunch: false,
      });
    const persistFinal = vi.fn(async (result) => result);
    const transaction = () =>
      runValidationInvocationTransaction({
        invocation,
        observeFinal: async () => null,
        observeIntent: async () => invocation,
        persistIntent: async () => {
          throw new Error("intent already exists");
        },
        observe: async () => null,
        launch: async () => {
          throw new Error("initial launch may not run during recovery");
        },
        resume,
        persistFinal,
      });

    await expect(
      executeOrdinaryCommand({ stagingRoot: root, invocation, runCommand: command }),
    ).rejects.toThrow(/crashed before validation checkpoint/);
    await expect(transaction()).resolves.toMatchObject({ command: "npm test", exitCode: 0 });
    expect(command).toHaveBeenCalledTimes(1);
    expect(persistFinal).toHaveBeenCalledTimes(1);
  });

  it("observes a durable validation result and completed capture without replay", async () => {
    const bytes = Buffer.from("captured\n");
    const recipe = exactRecipe({ expectedDescriptorDigest: sha("descriptor") });
    const invocation = invocationFor({ recipe, expectedBytes: bytes });
    const root = await mkdtemp(join(tmpdir(), "factory-local-validation-capture-"));
    roots.push(root);
    const command = vi.fn(async ({ env }: { env: NodeJS.ProcessEnv }) => {
      const request = JSON.parse(await readFile(env["FACTORY_CAPTURE_REQUEST"]!, "utf8"));
      await checkpointMockStart(env, recipe.captureCommand.command);
      await writeFile(request.recipes[0].outputs[0].path, bytes);
      await checkpointMockCommand(env, recipe.captureCommand.command);
      return { exitCode: 0, durationMs: 1, stdout: "", stderr: "" };
    });
    const validation = {
      outputTreeSha: invocation.outputTreeSha,
      commands: [{ command: "npm test", exitCode: 0, durationMs: 1 }],
      passed: true,
      startedAt: "2026-09-16T00:00:00.000Z",
      completedAt: "2026-09-16T00:00:01.000Z",
      environmentIdentity: invocation.toolEnvironment.environmentIdentity,
    };
    await persistLocalValidationResult({ stagingRoot: root, invocation, validation });
    await expect(observeLocalValidationResult({ stagingRoot: root, invocation })).resolves.toEqual(
      validation,
    );
    const first = await executeLocalRepositoryCaptures({
      stagingRoot: root,
      invocation,
      resultTreeRoot: root,
      environment: {},
      runCommand: command,
      observeCommand: async () => "absent",
      commandDeadline: null,
      allowLaunch: true,
      assertOutputTree: async () => undefined,
    });
    expect(await first.downloadCapture(first.collection.files[0]!)).toEqual(bytes);
    const second = await executeLocalRepositoryCaptures({
      stagingRoot: root,
      invocation,
      resultTreeRoot: root,
      environment: {},
      runCommand: command,
      observeCommand: async () => "absent",
      commandDeadline: null,
      allowLaunch: true,
      assertOutputTree: async () => undefined,
    });
    expect(second.collection).toEqual(first.collection);
    expect(command).toHaveBeenCalledTimes(1);
  });

  it("refuses to replay a capture command after ambiguous partial output", async () => {
    const bytes = Buffer.from("partial\n");
    const recipe = exactRecipe({ expectedDescriptorDigest: sha("descriptor") });
    const invocation = invocationFor({ recipe, expectedBytes: bytes });
    const root = await mkdtemp(join(tmpdir(), "factory-local-partial-capture-"));
    roots.push(root);
    await checkpointMockValidation(root, invocation);
    const command = vi.fn(async ({ env }: { env: NodeJS.ProcessEnv }) => {
      const request = JSON.parse(await readFile(env["FACTORY_CAPTURE_REQUEST"]!, "utf8"));
      await checkpointMockStart(env, recipe.captureCommand.command);
      await writeFile(request.recipes[0].outputs[0].path, bytes);
      throw new Error("simulated crash after capture output");
    });
    const execute = () =>
      executeLocalRepositoryCaptures({
        stagingRoot: root,
        invocation,
        resultTreeRoot: root,
        environment: {},
        runCommand: command,
        observeCommand: async () => "absent",
        commandDeadline: null,
        allowLaunch: true,
        assertOutputTree: async () => undefined,
      });
    await expect(execute()).rejects.toThrow(/simulated crash/);
    await expect(
      inspectLocalRepositoryCaptureDispatchState({ stagingRoot: root, invocation }),
    ).resolves.toBe("ambiguous");
    await expect(execute()).rejects.toThrow(/dispatch-authorized/);
    expect(command).toHaveBeenCalledTimes(1);
  });

  it("retries the same invocation when scoped launch failed before the wrapper dispatch receipt", async () => {
    const bytes = Buffer.from("capture-after-safe-retry\n");
    const recipe = exactRecipe({ expectedDescriptorDigest: sha("descriptor") });
    const invocation = invocationFor({ recipe, expectedBytes: bytes });
    const root = await mkdtemp(join(tmpdir(), "factory-local-before-scope-launch-"));
    roots.push(root);
    await checkpointMockValidation(root, invocation);
    const command = vi
      .fn()
      .mockRejectedValueOnce(new Error("scope launch refused before wrapper start"))
      .mockImplementationOnce(async ({ env }: { env: NodeJS.ProcessEnv }) => {
        const request = JSON.parse(await readFile(env["FACTORY_CAPTURE_REQUEST"]!, "utf8"));
        await writeFile(request.recipes[0].outputs[0].path, bytes);
        await checkpointMockCommand(env, recipe.captureCommand.command);
        return { exitCode: 0, durationMs: 1, stdout: "", stderr: "" };
      });
    const execute = () =>
      executeLocalRepositoryCaptures({
        stagingRoot: root,
        invocation,
        resultTreeRoot: root,
        environment: {},
        runCommand: command,
        observeCommand: async () => "absent",
        commandDeadline: null,
        allowLaunch: true,
        assertOutputTree: async () => undefined,
      });
    await expect(execute()).rejects.toThrow(/scope launch refused/);
    await expect(
      inspectLocalRepositoryCaptureDispatchState({ stagingRoot: root, invocation }),
    ).resolves.toBe("rebound-safe");
    await expect(execute()).resolves.toMatchObject({
      collection: { files: [{ bytes: bytes.length }] },
    });
    expect(command).toHaveBeenCalledTimes(2);
  });

  it("observes an active exact scope until its terminal receipt is durable", async () => {
    const bytes = Buffer.from("active-scope-capture\n");
    const recipe = exactRecipe({ expectedDescriptorDigest: sha("descriptor") });
    const invocation = invocationFor({ recipe, expectedBytes: bytes });
    const root = await mkdtemp(join(tmpdir(), "factory-local-active-scope-"));
    roots.push(root);
    await checkpointMockValidation(root, invocation);
    let retainedEnv: NodeJS.ProcessEnv | undefined;
    const command = vi.fn(async ({ env }: { env: NodeJS.ProcessEnv }) => {
      retainedEnv = env;
      const request = JSON.parse(await readFile(env["FACTORY_CAPTURE_REQUEST"]!, "utf8"));
      await checkpointMockStart(env, recipe.captureCommand.command);
      await writeFile(request.recipes[0].outputs[0].path, bytes);
      throw new Error("controller restarted while exact scope remained active");
    });
    const first = () =>
      executeLocalRepositoryCaptures({
        stagingRoot: root,
        invocation,
        resultTreeRoot: root,
        environment: {},
        runCommand: command,
        observeCommand: async () => "absent",
        commandDeadline: null,
        allowLaunch: true,
        assertOutputTree: async () => undefined,
      });
    await expect(first()).rejects.toThrow(/scope remained active/);
    let observations = 0;
    const recovered = await executeLocalRepositoryCaptures({
      stagingRoot: root,
      invocation,
      resultTreeRoot: root,
      environment: {},
      runCommand: command,
      observeCommand: async () => {
        observations += 1;
        if (observations === 2)
          await checkpointMockCommand(retainedEnv!, recipe.captureCommand.command);
        return "active";
      },
      commandDeadline: new Date(Date.now() + 5_000).toISOString(),
      allowLaunch: true,
      assertOutputTree: async () => undefined,
    });
    expect(await recovered.downloadCapture(recovered.collection.files[0]!)).toEqual(bytes);
    expect(command).toHaveBeenCalledTimes(1);
  });

  it("adopts a durable terminal receipt after a crash before the recipe checkpoint", async () => {
    const bytes = Buffer.from("captured-before-controller-crash\n");
    const recipe = exactRecipe({ expectedDescriptorDigest: sha("descriptor") });
    const invocation = invocationFor({ recipe, expectedBytes: bytes });
    const root = await mkdtemp(join(tmpdir(), "factory-local-terminal-adoption-"));
    roots.push(root);
    await checkpointMockValidation(root, invocation);
    const command = vi.fn(async ({ env }: { env: NodeJS.ProcessEnv }) => {
      const request = JSON.parse(await readFile(env["FACTORY_CAPTURE_REQUEST"]!, "utf8"));
      await writeFile(request.recipes[0].outputs[0].path, bytes);
      await checkpointMockCommand(env, recipe.captureCommand.command);
      throw new Error("simulated controller crash after terminal receipt");
    });
    const execute = () =>
      executeLocalRepositoryCaptures({
        stagingRoot: root,
        invocation,
        resultTreeRoot: root,
        environment: {},
        runCommand: command,
        observeCommand: async () => "absent",
        commandDeadline: null,
        allowLaunch: true,
        assertOutputTree: async () => undefined,
      });
    await expect(execute()).rejects.toThrow(/simulated controller crash/);
    await expect(
      inspectLocalRepositoryCaptureDispatchState({ stagingRoot: root, invocation }),
    ).resolves.toBe("complete");
    const recovered = await execute();
    expect(await recovered.downloadCapture(recovered.collection.files[0]!)).toEqual(bytes);
    expect(command).toHaveBeenCalledTimes(1);
  });

  it("keeps expected bytes outside the local repository command and recomputes the threshold", async () => {
    const expectedBytes = Buffer.from("controller-only-expected\n");
    const observedBytes = Buffer.from("repository-controlled-observed\n");
    const exact = exactRecipe({
      id: "threshold-capture",
      command: "npm run capture:threshold",
      expectedDescriptorDigest: sha("descriptor"),
    });
    const { digest: _digest, ...core } = exact;
    const thresholdCore = {
      ...core,
      comparison: {
        kind: "threshold" as const,
        outputRoleId: "result",
        expectedDescriptorDigest: sha("descriptor"),
        policy: {
          kind: "bounded-difference" as const,
          metric: "byte-difference",
          maximumDifference: 0,
        },
        comparator: { id: "byte-difference", contract: 1 },
      },
    };
    const recipe = {
      ...thresholdCore,
      digest: sha(canonical(thresholdCore)),
    } as RepositoryCaptureRecipe;
    const invocation = invocationFor({ recipe, expectedBytes });
    const root = await mkdtemp(join(tmpdir(), "factory-local-between-actions-"));
    roots.push(root);
    await checkpointMockValidation(root, invocation);
    const command = vi.fn(async ({ env }: { env: NodeJS.ProcessEnv }) => {
      const requestBytes = await readFile(env["FACTORY_CAPTURE_REQUEST"]!);
      expect(requestBytes.includes(expectedBytes)).toBe(false);
      expect(Object.keys(env).some((name) => name.includes("EXPECTED"))).toBe(false);
      const request = JSON.parse(requestBytes.toString("utf8"));
      await writeFile(request.recipes[0].outputs[0].path, observedBytes);
      await checkpointMockCommand(env, recipe.captureCommand.command);
      return { exitCode: 0, durationMs: 1, stdout: "0", stderr: "" };
    });
    const retained = await executeLocalRepositoryCaptures({
      stagingRoot: root,
      invocation,
      resultTreeRoot: root,
      environment: {},
      runCommand: command,
      observeCommand: async () => "absent",
      commandDeadline: null,
      allowLaunch: true,
      assertOutputTree: async () => undefined,
    });
    const evidence = await persistRepositoryCaptures({
      store: memoryStore().store,
      invocation,
      collection: retained.collection,
      downloadCapture: retained.downloadCapture,
      downloadExpected: async () => expectedBytes,
      assertCurrent: async () => undefined,
      assertOutputTree: async () => undefined,
    });
    expect(command).toHaveBeenCalledTimes(1);
    expect(evidence.manifest.mechanicalResults).toEqual([
      expect.objectContaining({
        kind: "threshold",
        observedDifference: expect.any(Number),
        passed: false,
      }),
    ]);
  });
});
