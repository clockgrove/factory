import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import type { Daytona } from "@daytona/sdk";
import { afterAll, describe, expect, it, vi } from "vitest";

import {
  DAYTONA_DEFAULT_IMAGE,
  DAYTONA_MAX_VALIDATION_RESULT_BYTES,
  DaytonaBackend,
  DaytonaResourceCleanupError,
} from "../src/backends/daytona.js";
import { MAX_ARTIFACT_PATCH_BYTES, normalizeArtifact } from "../src/execution/artifacts.js";
import type { AttemptContext } from "../src/execution/backend.js";
import { MAX_LOG_BYTES } from "../src/protocol/limits.js";

const temporaryPaths = new Set<string>();
const MAX_CHANGED_PATHS_BYTES = 10_000 * 501;

afterAll(async () => {
  await Promise.all([...temporaryPaths].map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(): Promise<{ repository: string; context: AttemptContext }> {
  const repository = await mkdtemp(join(tmpdir(), "factory-daytona-"));
  temporaryPaths.add(repository);
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
  return {
    repository,
    context: {
      repository: "clockgrove/factory",
      objective: 14,
      workItem: 22,
      attempt: 1,
      runId: "release-run",
      directorEpoch: 3,
      policyDigest: "f".repeat(64),
      workspace: repository,
      deadline: new Date(Date.now() + 120_000),
      packet: {
        goal: "Change value.txt.",
        acceptanceCriteria: ["value.txt contains changed"],
        allowedPaths: ["value.txt"],
        preconditions: [],
        outOfScope: [],
        conventions: [],
        baseSha,
        validationCommands: ["grep -qx changed value.txt"],
        requirements: {
          os: ["linux"],
          architecture: [],
          tools: ["git", "node"],
          services: [],
          networkDestinations: [],
          permittedSecretNames: [],
          trust: "isolated",
          cpu: 2,
          memoryMb: 2048,
          diskMb: 4096,
        },
        artifactContract: "clockgrove.factory/artifact-v1",
      },
      policyNetworkDestinations: ["registry.npmjs.org", "*.npmjs.org", "api.openai.com"],
    },
  };
}

interface FakeCreate {
  params: Record<string, unknown>;
  options: Record<string, unknown>;
}

interface FakeSecret {
  id: string;
  name: string;
  description?: string;
  placeholder: string;
  hosts: string[];
  createdAt: string;
  updatedAt: string;
}

function scopedModelSecret(overrides: Partial<FakeSecret> = {}): FakeSecret {
  return {
    id: "secret-1",
    name: "factory-openai",
    placeholder: "dtn_secret_secret-1",
    hosts: ["api.openai.com"],
    createdAt: "2026-09-04T00:00:00.000Z",
    updatedAt: "2026-09-04T00:00:00.000Z",
    ...overrides,
  };
}

function fakeProvider() {
  const creates: FakeCreate[] = [];
  const deleted: string[] = [];
  const deleteAttempts: string[] = [];
  const lookedUp: string[] = [];
  const metadataReads: string[] = [];
  const streamed: string[] = [];
  const resources = new Map<string, ReturnType<typeof sandbox>>();
  const deleteFailures = new Map<string, number>();
  const visibilityMisses = new Map<string, number>();
  const reportedSizes = new Map<string, number>();
  const streamOverrides = new Map<string, Buffer>();
  const secretLookups: Array<{ name?: string; cursor?: string; limit?: number }> = [];
  let secrets = [scopedModelSecret()];
  let serial = 0;
  let uploadFailure: Error | undefined;
  let createFailureAfterAllocation: Error | undefined;
  let lookupFailure: Error | undefined;
  let workerFailure: Error | undefined;
  let workerExitCode = 0;
  let workerResult = "ok";
  let workerStdout = "worker complete\n";

  function sandbox(id: string, name = id, labels: Record<string, string> = {}) {
    const files = new Map<string, Buffer>();
    const value = {
      id,
      name,
      labels,
      fs: {
        createFolder: async () => undefined,
        uploadFiles: async (uploads: Array<{ source: Buffer; destination: string }>) => {
          if (uploadFailure) {
            const error = uploadFailure;
            uploadFailure = undefined;
            throw error;
          }
          for (const upload of uploads) files.set(upload.destination, Buffer.from(upload.source));
        },
        downloadFile: async (path: string) => {
          const value = files.get(path);
          if (!value) throw new Error(`missing fake Daytona file ${path}`);
          return value;
        },
        getFileDetails: async (path: string) => {
          metadataReads.push(path);
          const file = files.get(path) ?? streamOverrides.get(path);
          if (!file) throw new Error(`missing fake Daytona file ${path}`);
          return {
            group: "factory",
            isDir: false,
            modTime: "",
            mode: "600",
            modifiedAt: "2026-09-04T00:00:00.000Z",
            name: path.split("/").at(-1) ?? path,
            owner: "factory",
            path,
            permissions: "600",
            size: reportedSizes.get(path) ?? file.byteLength,
          };
        },
        downloadFileStream: async (
          path: string,
          options?: { onProgress?: (progress: { bytesReceived: number }) => void },
        ) => {
          streamed.push(path);
          const file = streamOverrides.get(path) ?? files.get(path);
          if (!file) throw new Error(`missing fake Daytona file ${path}`);
          options?.onProgress?.({ bytesReceived: file.byteLength });
          return Readable.from([file]);
        },
      },
      process: {
        executeCommand: async (command: string) => {
          if (command === "bash factory/run.sh") {
            if (workerFailure) {
              const error = workerFailure;
              workerFailure = undefined;
              throw error;
            }
            files.set(
              "factory/artifact.patch",
              Buffer.from(
                "diff --git a/value.txt b/value.txt\n" +
                  "--- a/value.txt\n" +
                  "+++ b/value.txt\n" +
                  "@@ -1 +1 @@\n" +
                  "-base\n" +
                  "+changed\n",
              ),
            );
            files.set("factory/changed-paths", Buffer.from("value.txt\0"));
            files.set("factory/exit-code", Buffer.from("0"));
            files.set("factory/worker.stdout", Buffer.from(workerStdout));
            files.set("factory/worker.stderr", Buffer.alloc(0));
          } else if (command === "node factory/validate.mjs") {
            files.set(
              "factory/validation-result.json",
              Buffer.from(
                JSON.stringify({
                  outputTreeSha: "d".repeat(40),
                  commands: [
                    {
                      command: "grep -qx changed value.txt",
                      exitCode: 0,
                      durationMs: 3,
                    },
                  ],
                  passed: true,
                  startedAt: "2026-09-04T00:00:00.000Z",
                  completedAt: "2026-09-04T00:00:01.000Z",
                }),
              ),
            );
          }
          return { exitCode: workerExitCode, result: workerResult };
        },
      },
      getWorkDir: async () => "/workspace",
      delete: async () => {
        deleteAttempts.push(id);
        const failures = deleteFailures.get(id) ?? 0;
        if (failures > 0) {
          deleteFailures.set(id, failures - 1);
          throw new Error(`provider refused deletion of ${id}`);
        }
        deleted.push(id);
        resources.delete(id);
        resources.delete(name);
      },
    };
    resources.set(id, value);
    resources.set(name, value);
    return value;
  }

  const stale = sandbox("stale-sandbox");
  const client = {
    secret: {
      list: async (query: { name?: string; cursor?: string; limit?: number } = {}) => {
        secretLookups.push(query);
        const items = query.name
          ? secrets.filter((secret) => secret.name.includes(query.name!))
          : secrets;
        return { items, total: items.length, nextCursor: null };
      },
    },
    create: async (params: Record<string, unknown>, options: Record<string, unknown>) => {
      creates.push({ params, options });
      serial += 1;
      const created = sandbox(
        `sandbox-${serial}`,
        String(params.name),
        params.labels as Record<string, string>,
      );
      if (createFailureAfterAllocation) {
        const error = createFailureAfterAllocation;
        createFailureAfterAllocation = undefined;
        throw error;
      }
      return created;
    },
    get: async (name: string) => {
      lookedUp.push(name);
      if (lookupFailure) throw lookupFailure;
      const misses = visibilityMisses.get(name) ?? 0;
      if (misses > 0) {
        visibilityMisses.set(name, misses - 1);
        throw Object.assign(new Error("404 not found"), { statusCode: 404 });
      }
      return resources.get(name) ?? stale;
    },
  };

  return {
    creates,
    deleted,
    deleteAttempts,
    lookedUp,
    metadataReads,
    streamed,
    secretLookups,
    setSecrets: (next: FakeSecret[]) => {
      secrets = next;
    },
    failNextDelete: (id: string, count = 1) => deleteFailures.set(id, count),
    failNextUpload: (error = new Error("upload failed")) => {
      uploadFailure = error;
    },
    failNextCreateAfterAllocation: (error = new Error("create timed out")) => {
      createFailureAfterAllocation = error;
    },
    failLookup: (error = new Error("provider lookup unavailable")) => {
      lookupFailure = error;
    },
    clearLookupFailure: () => {
      lookupFailure = undefined;
    },
    failWorker: (error: Error) => {
      workerFailure = error;
    },
    setWorkerResult: (exitCode: number, result: string) => {
      workerExitCode = exitCode;
      workerResult = result;
    },
    setWorkerStdout: (stdout: string) => {
      workerStdout = stdout;
    },
    delayVisibility: (name: string, misses: number) => {
      visibilityMisses.set(name, misses);
    },
    reportSize: (path: string, bytes: number) => {
      reportedSizes.set(path, bytes);
    },
    clearReportedSizes: () => {
      reportedSizes.clear();
    },
    overrideStream: (path: string, content: Buffer) => {
      streamOverrides.set(path, content);
    },
    client: client as unknown as Daytona,
  };
}

describe("Daytona supported provider contract", () => {
  it.each(["integration-candidate", "native-stack-rebase"] as const)(
    "isolates repeated %s validations and binds cleanup to exact ownership",
    async (kind) => {
      const source = await fixture();
      const provider = fakeProvider();
      const backend = new DaytonaBackend({
        repository: source.repository,
        createClient: () => provider.client,
        credentialAvailable: () => true,
      });
      const artifact = normalizeArtifact({
        baseSha: source.context.packet.baseSha,
        patch: "",
        changedPaths: [],
        outcome: "declined",
        reason: "candidate identity fixture",
      });
      for (const value of ["a", "b"]) {
        await backend.validate({
          ...source.context,
          artifact,
          validationInvocation: {
            kind,
            identityDigest: value.repeat(64),
            artifactDigest: artifact.digest,
            baseSha: artifact.baseSha,
          },
        });
      }
      expect(provider.creates).toHaveLength(2);
      expect(provider.creates[0]!.params.name).not.toBe(provider.creates[1]!.params.name);
      expect(provider.creates[0]!.params.labels).toMatchObject({
        invocationOwner: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      expect(provider.deleted).toEqual(["sandbox-1", "sandbox-2"]);
      await expect(
        backend.reconcileStale({
          repository: source.context.repository,
          objective: source.context.objective,
          workItem: source.context.workItem,
          attempt: source.context.attempt,
          runId: source.context.runId,
          directorEpoch: source.context.directorEpoch,
          policyDigest: source.context.policyDigest,
          phase: "validation",
          validationInvocation: {
            kind,
            identityDigest: "a".repeat(64),
            artifactDigest: artifact.digest,
            baseSha: artifact.baseSha,
          },
        }),
      ).rejects.toThrow(/ownership mismatch/);
      expect(provider.deleted).toEqual(["sandbox-1", "sandbox-2"]);
    },
  );
  it.each(["integration-candidate", "native-stack-rebase"] as const)(
    "rejects tampered %s artifact binding before any create or lookup",
    async (kind) => {
      const source = await fixture();
      const provider = fakeProvider();
      const backend = new DaytonaBackend({
        repository: source.repository,
        createClient: () => provider.client,
        credentialAvailable: () => true,
      });
      const artifact = normalizeArtifact({
        baseSha: source.context.packet.baseSha,
        patch: "",
        changedPaths: [],
        outcome: "declined",
        reason: "candidate identity fixture",
      });
      await expect(
        backend.validate({
          ...source.context,
          artifact,
          validationInvocation: {
            kind,
            identityDigest: "a".repeat(64),
            artifactDigest: "b".repeat(64),
            baseSha: artifact.baseSha,
          },
        }),
      ).rejects.toThrow(/exact artifact and base/);
      expect(provider.creates).toEqual([]);
      expect(provider.lookedUp).toEqual([]);
    },
  );
  it("keeps a mismatching create response explicitly cleanup-unknown without deleting an unowned resource", async () => {
    const source = await fixture();
    const provider = fakeProvider();
    const create = provider.client.create.bind(provider.client);
    vi.spyOn(provider.client, "create").mockImplementation(async (params, options) => {
      const sandbox = await create(params, options);
      sandbox.labels.invocationOwner = "f".repeat(64);
      return sandbox;
    });
    const backend = new DaytonaBackend({
      repository: source.repository,
      createClient: () => provider.client,
      credentialAvailable: () => true,
    });
    const artifact = normalizeArtifact({
      baseSha: source.context.packet.baseSha,
      patch: "",
      changedPaths: [],
      outcome: "declined",
      reason: "candidate ownership fixture",
    });
    await expect(
      backend.validate({
        ...source.context,
        artifact,
        validationInvocation: {
          kind: "integration-candidate",
          identityDigest: "a".repeat(64),
          artifactDigest: artifact.digest,
          baseSha: artifact.baseSha,
        },
      }),
    ).rejects.toBeInstanceOf(DaytonaResourceCleanupError);
    expect(provider.creates).toHaveLength(1);
    expect(provider.deleted).toEqual([]);
  });
  it("rejects mutable image tags and accepts only digest-pinned environments", async () => {
    const source = await fixture();
    expect(
      () =>
        new DaytonaBackend({
          repository: source.repository,
          image: "node:22-bookworm",
        }),
    ).toThrow(/immutable registry reference pinned with @sha256/);
    expect(
      () =>
        new DaytonaBackend({
          repository: source.repository,
          image: `registry.example.invalid/factory@sha256:${"a".repeat(64)}`,
        }),
    ).not.toThrow();
  });

  it("rejects elapsed execution and validation deadlines before any provider work", async () => {
    const source = await fixture();
    const provider = fakeProvider();
    const now = Date.now();
    const backend = new DaytonaBackend({
      repository: source.repository,
      daytonaSecretName: "factory-openai",
      createClient: () => provider.client,
      now: () => now,
    });
    const expired = { ...source.context, deadline: new Date(now) };

    await expect(backend.launch(expired)).rejects.toThrow(/execution deadline/);
    await expect(
      backend.validate!({
        ...expired,
        artifact: normalizeArtifact({
          baseSha: source.context.packet.baseSha,
          patch: "",
          changedPaths: [],
          outcome: "declined",
          reason: "deadline fixture",
        }),
      }),
    ).rejects.toThrow(/validation deadline/);
    expect(provider.secretLookups).toEqual([]);
    expect(provider.creates).toEqual([]);
  });

  it("executes an offline task with backend egress from policy, validates, and cleans up", async () => {
    const source = await fixture();
    const provider = fakeProvider();
    const backend = new DaytonaBackend({
      repository: source.repository,
      daytonaSecretName: "factory-openai",
      credentialAvailable: () => true,
      createClient: () => provider.client,
    });

    await expect(backend.probe()).resolves.toMatchObject({
      available: true,
      authenticated: true,
    });
    await expect(backend.probeValidation()).resolves.toMatchObject({
      available: true,
      authenticated: true,
    });
    expect(backend.capabilities.supportedArchitectures).toEqual([]);
    expect(source.context.packet.requirements.networkDestinations).toEqual([]);

    const handle = await backend.launch(source.context);
    expect(handle.metadata?.environmentIdentity).toBe(DAYTONA_DEFAULT_IMAGE);
    let observation = await backend.observe(handle);
    for (let poll = 0; poll < 20 && observation.state === "running"; poll += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
      observation = await backend.observe(handle);
    }
    expect(observation.state).toBe("succeeded");

    expect(provider.creates).toHaveLength(1);
    const executionCall = provider.creates[0]!;
    const execution = executionCall.params;
    expect(execution).toMatchObject({
      name: "factory-o14-w22-a1-release-run",
      image: DAYTONA_DEFAULT_IMAGE,
      ephemeral: true,
      autoDeleteInterval: 0,
      labels: {
        factory: "v2",
        objective: "14",
        workItem: "22",
        attempt: "1",
      },
      secrets: { OPENAI_API_KEY: "factory-openai" },
      envVars: { FACTORY_SUPERVISED: "1" },
      resources: { cpu: 2, memory: 2, disk: 4 },
    });
    expect(execution.domainAllowList).toBe("registry.npmjs.org,*.npmjs.org,api.openai.com");
    expect(JSON.stringify(execution)).not.toContain("GITHUB_TOKEN");
    expect(executionCall.options).toEqual({ timeout: 120 });
    expect(provider.secretLookups).toEqual([
      { name: "factory-openai", limit: 200 },
      { name: "factory-openai", limit: 200 },
    ]);
    expect(JSON.stringify(execution)).not.toContain("dtn_secret_secret-1");

    const artifact = await backend.collect(handle);
    expect(artifact).toMatchObject({
      outcome: "succeeded",
      changedPaths: ["value.txt"],
    });
    expect(artifact.patch).toContain("+changed");
    await backend.cleanup(handle);
    expect(provider.deleted).toContain("sandbox-1");

    const validation = await backend.validate!({
      ...source.context,
      artifact: normalizeArtifact({
        baseSha: source.context.packet.baseSha,
        patch: artifact.patch,
        changedPaths: artifact.changedPaths,
        outcome: "succeeded",
      }),
    });
    expect(validation).toMatchObject({
      passed: true,
      outputTreeSha: "d".repeat(40),
      environmentIdentity: DAYTONA_DEFAULT_IMAGE,
    });
    expect(provider.creates).toHaveLength(2);
    const validator = provider.creates[1]!.params;
    expect(validator).toMatchObject({
      image: DAYTONA_DEFAULT_IMAGE,
      ephemeral: true,
      autoDeleteInterval: 0,
      labels: { factory: "v2", phase: "validation" },
    });
    expect(validator).not.toHaveProperty("secrets");
    expect(provider.deleted).toContain("sandbox-2");
  });

  it("rejects oversized remote artifact files from metadata before starting any download", async () => {
    const source = await fixture();
    const provider = fakeProvider();
    const backend = new DaytonaBackend({
      repository: source.repository,
      daytonaSecretName: "factory-openai",
      createClient: () => provider.client,
    });
    const handle = await backend.launch(source.context);
    await new Promise((resolve) => setTimeout(resolve, 1));

    const oversized = [
      ["factory/artifact.patch", MAX_ARTIFACT_PATCH_BYTES, "Daytona artifact patch"],
      ["factory/changed-paths", MAX_CHANGED_PATHS_BYTES, "Daytona changed-path manifest"],
      ["factory/worker.stdout", MAX_LOG_BYTES, "Daytona worker stdout"],
      ["factory/worker.stderr", MAX_LOG_BYTES, "Daytona worker stderr"],
    ] as const;
    for (const [path, limit, label] of oversized) {
      provider.reportSize(path, limit + 1);
      await expect(backend.collect(handle)).rejects.toThrow(
        `${label} is ${limit + 1} bytes; maximum is ${limit}`,
      );
      provider.clearReportedSizes();
    }
    expect(provider.metadataReads).toHaveLength(oversized.length * 5);
    expect(provider.streamed).toEqual([]);
    await backend.cleanup(handle);
  });

  it("bounds validation results and diagnostics before host materialization", async () => {
    const source = await fixture();
    const validationContext = {
      ...source.context,
      artifact: normalizeArtifact({
        baseSha: source.context.packet.baseSha,
        patch: "",
        changedPaths: [],
        outcome: "declined" as const,
        reason: "validation bound fixture",
      }),
    };

    const oversizedResultProvider = fakeProvider();
    oversizedResultProvider.reportSize(
      "factory/validation-result.json",
      DAYTONA_MAX_VALIDATION_RESULT_BYTES + 1,
    );
    const oversizedResultBackend = new DaytonaBackend({
      repository: source.repository,
      daytonaSecretName: "factory-openai",
      credentialAvailable: () => true,
      createClient: () => oversizedResultProvider.client,
    });
    await expect(oversizedResultBackend.validate!(validationContext)).rejects.toThrow(
      `maximum is ${DAYTONA_MAX_VALIDATION_RESULT_BYTES}`,
    );
    expect(oversizedResultProvider.streamed).not.toContain("factory/validation-result.json");
    expect(oversizedResultProvider.deleted).toContain("sandbox-1");

    const oversizedErrorProvider = fakeProvider();
    oversizedErrorProvider.setWorkerResult(1, "validator failed");
    oversizedErrorProvider.overrideStream(
      "factory/validation-error.txt",
      Buffer.from("bounded fixture"),
    );
    oversizedErrorProvider.reportSize("factory/validation-error.txt", MAX_LOG_BYTES + 1);
    const oversizedErrorBackend = new DaytonaBackend({
      repository: source.repository,
      daytonaSecretName: "factory-openai",
      credentialAvailable: () => true,
      createClient: () => oversizedErrorProvider.client,
    });
    await expect(oversizedErrorBackend.validate!(validationContext)).rejects.toThrow(
      `maximum is ${MAX_LOG_BYTES}`,
    );
    expect(oversizedErrorProvider.streamed).not.toContain("factory/validation-error.txt");
    expect(oversizedErrorProvider.deleted).toContain("sandbox-1");
  });

  it("rejects bounded but malformed isolated validation results", async () => {
    const source = await fixture();
    const provider = fakeProvider();
    const malformed = Buffer.from(
      JSON.stringify({
        outputTreeSha: "d".repeat(40),
        commands: Array.from({ length: 129 }, () => ({
          command: "true",
          exitCode: 0,
          durationMs: 1,
        })),
        passed: true,
        startedAt: "2026-09-04T00:00:00.000Z",
        completedAt: "2026-09-04T00:00:01.000Z",
      }),
    );
    provider.overrideStream("factory/validation-result.json", malformed);
    provider.reportSize("factory/validation-result.json", malformed.byteLength);
    const backend = new DaytonaBackend({
      repository: source.repository,
      daytonaSecretName: "factory-openai",
      credentialAvailable: () => true,
      createClient: () => provider.client,
    });
    await expect(
      backend.validate!({
        ...source.context,
        artifact: normalizeArtifact({
          baseSha: source.context.packet.baseSha,
          patch: "",
          changedPaths: [],
          outcome: "declined",
          reason: "malformed result fixture",
        }),
      }),
    ).rejects.toThrow("isolated validator returned a malformed result");
    expect(provider.deleted).toContain("sandbox-1");
  });

  it("aborts a remote artifact stream that grows after bounded metadata inspection", async () => {
    const source = await fixture();
    const provider = fakeProvider();
    const backend = new DaytonaBackend({
      repository: source.repository,
      daytonaSecretName: "factory-openai",
      createClient: () => provider.client,
    });
    const handle = await backend.launch(source.context);
    await new Promise((resolve) => setTimeout(resolve, 1));
    provider.overrideStream("factory/worker.stdout", Buffer.alloc(MAX_LOG_BYTES + 1, "x"));

    await expect(backend.collect(handle)).rejects.toThrow(
      `Daytona worker stdout exceeded ${MAX_LOG_BYTES} bytes while downloading`,
    );
    expect(provider.streamed).toContain("factory/worker.stdout");
    await backend.cleanup(handle);
  });

  it("rejects missing bootstrap or model egress authority before provider creation", async () => {
    const source = await fixture();
    const provider = fakeProvider();
    const backend = new DaytonaBackend({
      repository: source.repository,
      daytonaSecretName: "factory-openai",
      credentialAvailable: () => true,
      createClient: () => provider.client,
    });
    const denied = {
      ...source.context,
      policyNetworkDestinations: ["registry.npmjs.org", "*.npmjs.org"],
    };

    await expect(backend.launch(denied)).rejects.toThrow(
      "infrastructure is outside immutable Run Policy egress authority: api.openai.com",
    );
    const taskDenied = {
      ...source.context,
      packet: {
        ...source.context.packet,
        requirements: {
          ...source.context.packet.requirements,
          networkDestinations: ["example.invalid"],
        },
      },
    };
    await expect(backend.launch(taskDenied)).rejects.toThrow(
      "task egress is outside immutable Run Policy authority: example.invalid",
    );
    expect(provider.creates).toHaveLength(0);
  });

  it("fails closed before create when model Secret metadata is unsafe or ambiguous", async () => {
    const source = await fixture();
    const unsafeMetadata: Array<[string, FakeSecret[]]> = [
      ["unrestricted", [scopedModelSecret({ hosts: [] })]],
      ["wrong host", [scopedModelSecret({ hosts: ["example.com"] })]],
      ["wildcard host", [scopedModelSecret({ hosts: ["*.openai.com"] })]],
      ["additional host", [scopedModelSecret({ hosts: ["api.openai.com", "example.com"] })]],
      ["missing placeholder", [scopedModelSecret({ placeholder: "" })]],
      ["missing exact name", [scopedModelSecret({ name: "factory-openai-backup" })]],
      [
        "ambiguous exact name",
        [scopedModelSecret(), scopedModelSecret({ id: "secret-2", placeholder: "dtn_secret_2" })],
      ],
    ];

    for (const [label, secrets] of unsafeMetadata) {
      const provider = fakeProvider();
      provider.setSecrets(secrets);
      const backend = new DaytonaBackend({
        repository: source.repository,
        daytonaSecretName: "factory-openai",
        credentialAvailable: () => true,
        createClient: () => provider.client,
      });

      const probe = await backend.probe();
      expect(probe, label).toMatchObject({ available: true, authenticated: false });
      await expect(backend.launch(source.context), label).rejects.toThrow(
        label === "missing placeholder"
          ? "expected opaque dtn_secret_ placeholder metadata"
          : label === "missing exact name" || label === "ambiguous exact name"
            ? "must uniquely name one Daytona organization Secret"
            : 'must set hosts to exactly ["api.openai.com"]',
      );
      expect(provider.creates, label).toHaveLength(0);
    }

    const suspectedSecret = `sk-${"x".repeat(32)}`;
    const provider = fakeProvider();
    provider.setSecrets([]);
    const misconfigured = new DaytonaBackend({
      repository: source.repository,
      daytonaSecretName: suspectedSecret,
      credentialAvailable: () => true,
      createClient: () => provider.client,
    });
    const failure = await misconfigured.launch(source.context).catch((error: unknown) => error);
    expect(String(failure)).toContain(
      "FACTORY_DAYTONA_MODEL_SECRET must uniquely name one Daytona organization Secret",
    );
    expect(String(failure)).not.toContain(suspectedSecret);
    expect(provider.creates).toHaveLength(0);
  });

  it("retains a failed launch resource until rollback deletion is confirmed", async () => {
    const source = await fixture();
    const provider = fakeProvider();
    provider.failNextUpload(new Error("bootstrap upload failed"));
    provider.failNextDelete("sandbox-1");
    const backend = new DaytonaBackend({
      repository: source.repository,
      daytonaSecretName: "factory-openai",
      credentialAvailable: () => true,
      createClient: () => provider.client,
    });

    const failure = await backend.launch(source.context).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DaytonaResourceCleanupError);
    expect(failure).toMatchObject({
      resourceId: "sandbox-1",
      resourceName: "factory-o14-w22-a1-release-run",
      operation: "launch rollback",
    });
    expect(String(failure)).toContain("may still be billable");
    expect(String(failure)).toContain("bootstrap upload failed");
    expect(provider.deleteAttempts).toEqual(["sandbox-1"]);

    await backend.reconcileStale!({
      repository: source.context.repository,
      objective: 14,
      workItem: 22,
      attempt: 1,
      runId: "release-run",
      directorEpoch: 3,
    });
    expect(provider.deleteAttempts).toEqual(["sandbox-1", "sandbox-1"]);
    expect(provider.deleted).toContain("sandbox-1");
  });

  it("reconciles allocation after an ambiguous create failure and reports a failed rollback", async () => {
    const source = await fixture();
    const provider = fakeProvider();
    const resourceName = "factory-o14-w22-a1-release-run";
    provider.failNextCreateAfterAllocation(new Error("create request timed out"));
    provider.delayVisibility(resourceName, 2);
    provider.failNextDelete("sandbox-1");
    const delays: number[] = [];
    const backend = new DaytonaBackend({
      repository: source.repository,
      daytonaSecretName: "factory-openai",
      credentialAvailable: () => true,
      createClient: () => provider.client,
      createVisibilityAttempts: 4,
      createVisibilityDelayMs: 7,
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
      },
    });

    await expect(backend.launch(source.context)).rejects.toMatchObject({
      name: "DaytonaResourceCleanupError",
      resourceId: "sandbox-1",
      operation: "ambiguous create rollback",
    });
    expect(provider.lookedUp).toEqual([resourceName, resourceName, resourceName]);
    expect(delays).toEqual([7, 7]);

    await backend.reconcileStale!({
      repository: source.context.repository,
      objective: 14,
      workItem: 22,
      attempt: 1,
      runId: "release-run",
      directorEpoch: 3,
    });
    expect(provider.deleted).toContain("sandbox-1");
  });

  it("fails with TTL-bounded leak evidence when delayed create visibility is exhausted", async () => {
    const source = await fixture();
    const provider = fakeProvider();
    const resourceName = "factory-o14-w22-a1-release-run";
    provider.failNextCreateAfterAllocation(new Error("create request timed out"));
    provider.delayVisibility(resourceName, 4);
    const backend = new DaytonaBackend({
      repository: source.repository,
      daytonaSecretName: "factory-openai",
      createClient: () => provider.client,
      createVisibilityAttempts: 3,
      createVisibilityDelayMs: 0,
      sleep: async () => undefined,
    });

    const failure = await backend.launch(source.context).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      name: "DaytonaResourceCleanupError",
      resourceName,
      operation: "ambiguous create visibility timeout",
      ttlMinutes: expect.any(Number),
    });
    expect(String(failure)).toContain("provider TTL as its final cleanup bound");
    expect(provider.lookedUp).toEqual([resourceName, resourceName, resourceName]);

    await backend.reconcileStale!({
      repository: source.context.repository,
      objective: 14,
      workItem: 22,
      attempt: 1,
      runId: "release-run",
      directorEpoch: 3,
    });
    expect(provider.deleted).toContain("sandbox-1");
    expect(provider.lookedUp).toEqual([
      resourceName,
      resourceName,
      resourceName,
      resourceName,
      resourceName,
    ]);
  });

  it("does not certify replacement after pre-handle create ambiguity while TTL is active", async () => {
    const source = await fixture();
    const provider = fakeProvider();
    const resourceName = "factory-o14-w22-a1-release-run";
    let now = Date.now();
    provider.failNextCreateAfterAllocation(new Error("create request timed out"));
    provider.delayVisibility(resourceName, 20);
    const backend = new DaytonaBackend({
      repository: source.repository,
      daytonaSecretName: "factory-openai",
      createClient: () => provider.client,
      createVisibilityAttempts: 2,
      createVisibilityDelayMs: 0,
      sleep: async () => undefined,
      now: () => now,
    });
    const identity = {
      repository: source.context.repository,
      objective: 14,
      workItem: 22,
      attempt: 1,
      runId: "release-run",
      directorEpoch: 3,
      phase: "execution" as const,
    };

    await expect(backend.launch(source.context)).rejects.toMatchObject({
      name: "DaytonaResourceCleanupError",
      operation: "ambiguous create visibility timeout",
    });
    const blocked = await backend.reconcileStale!(identity).catch((error: unknown) => error);
    expect(blocked).toMatchObject({
      name: "DaytonaResourceCleanupError",
      operation: "ambiguous create remains inside provider TTL",
    });
    expect(String(blocked)).toContain("replacement is unsafe until");
    expect(provider.deleted).not.toContain("sandbox-1");
    expect(provider.lookedUp).toEqual([resourceName, resourceName, resourceName, resourceName]);

    now += 3 * 60_000;
    await expect(backend.reconcileStale!(identity)).resolves.toBeUndefined();
    expect(provider.lookedUp).toHaveLength(6);
  });

  it("preserves the durable no-handle fence across a fresh backend restart", async () => {
    const source = await fixture();
    const provider = fakeProvider();
    const resourceName = "factory-o14-w22-a1-release-run";
    const now = Date.now();
    provider.failNextCreateAfterAllocation(new Error("create request timed out"));
    provider.delayVisibility(resourceName, 10);
    const beforeCrash = new DaytonaBackend({
      repository: source.repository,
      daytonaSecretName: "factory-openai",
      createClient: () => provider.client,
      createVisibilityAttempts: 2,
      createVisibilityDelayMs: 0,
      sleep: async () => undefined,
      now: () => now,
    });
    await expect(beforeCrash.launch(source.context)).rejects.toMatchObject({
      name: "DaytonaResourceCleanupError",
      operation: "ambiguous create visibility timeout",
    });

    const afterCrash = new DaytonaBackend({
      repository: source.repository,
      daytonaSecretName: "factory-openai",
      createClient: () => provider.client,
      createVisibilityAttempts: 2,
      createVisibilityDelayMs: 0,
      sleep: async () => undefined,
      now: () => now,
    });
    const identity = {
      repository: source.context.repository,
      objective: 14,
      workItem: 22,
      attempt: 1,
      runId: "release-run",
      directorEpoch: 3,
      phase: "execution" as const,
      noHandleReplacementNotBefore: new Date(now + 3 * 60_000).toISOString(),
    };
    await expect(afterCrash.reconcileStale!(identity)).rejects.toMatchObject({
      name: "DaytonaResourceCleanupError",
      operation: "durable no-handle replacement fence remains active",
    });
    expect(provider.deleted).not.toContain("sandbox-1");

    provider.delayVisibility(resourceName, 0);
    await expect(afterCrash.reconcileStale!(identity)).resolves.toBeUndefined();
    expect(provider.deleted).toContain("sandbox-1");
  });

  it("keeps handles retryable after cleanup or cancellation deletion failures", async () => {
    const source = await fixture();
    const provider = fakeProvider();
    const backend = new DaytonaBackend({
      repository: source.repository,
      daytonaSecretName: "factory-openai",
      credentialAvailable: () => true,
      createClient: () => provider.client,
    });

    const cleanupHandle = await backend.launch(source.context);
    provider.failNextDelete(cleanupHandle.resourceId);
    await expect(backend.cleanup(cleanupHandle)).rejects.toMatchObject({
      name: "DaytonaResourceCleanupError",
      operation: "final cleanup",
    });
    await expect(backend.collect(cleanupHandle)).resolves.toMatchObject({
      outcome: "succeeded",
    });
    await expect(backend.cleanup(cleanupHandle)).resolves.toBeUndefined();
    await expect(backend.cleanup(cleanupHandle)).resolves.toBeUndefined();

    const cancelHandle = await backend.launch({ ...source.context, attempt: 2 });
    provider.failNextDelete(cancelHandle.resourceId);
    await expect(backend.cancel(cancelHandle)).rejects.toMatchObject({
      name: "DaytonaResourceCleanupError",
      operation: "cancellation",
    });
    await expect(backend.cancel(cancelHandle)).resolves.toBeUndefined();
    await expect(backend.cleanup(cancelHandle)).resolves.toBeUndefined();
  });

  it("tracks a validator when deletion fails so stale reconciliation can remove it", async () => {
    const source = await fixture();
    const provider = fakeProvider();
    provider.failNextDelete("sandbox-1");
    const backend = new DaytonaBackend({
      repository: source.repository,
      daytonaSecretName: "factory-openai",
      credentialAvailable: () => true,
      createClient: () => provider.client,
    });
    const artifact = normalizeArtifact({
      baseSha: source.context.packet.baseSha,
      patch:
        "diff --git a/value.txt b/value.txt\n--- a/value.txt\n+++ b/value.txt\n@@ -1 +1 @@\n-base\n+changed\n",
      changedPaths: ["value.txt"],
      outcome: "succeeded",
    });

    await expect(backend.validate!({ ...source.context, artifact })).rejects.toMatchObject({
      name: "DaytonaResourceCleanupError",
      resourceId: "sandbox-1",
      operation: "validation cleanup",
    });
    await backend.reconcileStale!({
      repository: source.context.repository,
      objective: 14,
      workItem: 22,
      attempt: 1,
      runId: "release-run",
      directorEpoch: 3,
      phase: "validation",
    });
    expect(provider.deleted).toContain("sandbox-1");
  });

  it("replaces secret-bearing worker failures with safe diagnostics before observation", async () => {
    const source = await fixture();
    const secret = `sk-${"x".repeat(30)}`;

    const thrownProvider = fakeProvider();
    thrownProvider.failWorker(new Error(`provider echoed ${secret}`));
    const thrownBackend = new DaytonaBackend({
      repository: source.repository,
      daytonaSecretName: "factory-openai",
      createClient: () => thrownProvider.client,
    });
    const thrownHandle = await thrownBackend.launch(source.context);
    await new Promise((resolve) => setTimeout(resolve, 1));
    const thrownObservation = await thrownBackend.observe(thrownHandle);
    expect(thrownObservation).toMatchObject({ state: "failed" });
    expect(thrownObservation.reason).toContain("suspected OpenAI API key");
    expect(thrownObservation.reason).not.toContain(secret);
    await thrownBackend.cleanup(thrownHandle);

    const outputProvider = fakeProvider();
    outputProvider.setWorkerResult(1, `command failed with ${secret}`);
    const outputBackend = new DaytonaBackend({
      repository: source.repository,
      daytonaSecretName: "factory-openai",
      createClient: () => outputProvider.client,
    });
    const outputHandle = await outputBackend.launch({ ...source.context, attempt: 2 });
    await new Promise((resolve) => setTimeout(resolve, 1));
    const outputObservation = await outputBackend.observe(outputHandle);
    expect(outputObservation).toMatchObject({ state: "failed" });
    expect(outputObservation.reason).toContain("suspected OpenAI API key");
    expect(outputObservation.reason).not.toContain(secret);
    await outputBackend.cleanup(outputHandle);

    const logProvider = fakeProvider();
    logProvider.setWorkerStdout(`worker printed ${secret}`);
    const logBackend = new DaytonaBackend({
      repository: source.repository,
      daytonaSecretName: "factory-openai",
      createClient: () => logProvider.client,
    });
    const logHandle = await logBackend.launch({ ...source.context, attempt: 3 });
    await new Promise((resolve) => setTimeout(resolve, 1));
    await expect(logBackend.collect(logHandle)).rejects.toThrow(
      "worker logs contains suspected OpenAI API key",
    );
    await logBackend.cleanup(logHandle);
  });

  it("reconciles deterministic stale resources before replacement", async () => {
    const source = await fixture();
    const provider = fakeProvider();
    const backend = new DaytonaBackend({
      repository: source.repository,
      daytonaSecretName: "factory-openai",
      credentialAvailable: () => true,
      createClient: () => provider.client,
    });
    const staleIdentity = {
      repository: source.context.repository,
      objective: 14,
      workItem: 22,
      attempt: 1,
      runId: "release-run",
      directorEpoch: 3,
    };
    provider.failNextDelete("stale-sandbox");
    await expect(backend.reconcileStale!(staleIdentity)).rejects.toMatchObject({
      name: "DaytonaResourceCleanupError",
      resourceId: "stale-sandbox",
      operation: "stale-attempt reconciliation",
    });
    await backend.reconcileStale!(staleIdentity);
    expect(provider.lookedUp).toEqual(["factory-o14-w22-a1-release-run"]);
    expect(provider.deleted).toContain("stale-sandbox");
  });

  it("fails its probe closed when provider credentials are absent", async () => {
    const source = await fixture();
    const provider = fakeProvider();
    const backend = new DaytonaBackend({
      repository: source.repository,
      credentialAvailable: () => false,
      createClient: () => provider.client,
    });
    await expect(backend.probe()).resolves.toMatchObject({
      available: false,
      authenticated: false,
      reason: "Daytona authentication is not available",
    });
    expect(provider.creates).toHaveLength(0);
  });
});
