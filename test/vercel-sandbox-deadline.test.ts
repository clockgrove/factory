import { afterEach, expect, it, vi } from "vitest";

const provider = vi.hoisted(() => ({ create: vi.fn(), get: vi.fn() }));
vi.mock("@vercel/sandbox", () => ({
  Sandbox: { create: provider.create, get: provider.get },
}));

import {
  VercelResourceCleanupError,
  VercelSandboxBackend,
} from "../src/backends/vercel-sandbox.js";
import type {
  AttemptContext,
  IsolatedValidationContext,
  StaleAttemptIdentity,
} from "../src/execution/backend.js";
import * as sandboxCommon from "../src/backends/sandbox-common.js";
import * as lfs from "../src/repository-profiles/git-lfs.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  provider.create.mockReset();
  provider.get.mockReset();
});

function deadlineContext(): AttemptContext {
  return {
    repository: "clockgrove/factory",
    objective: 1,
    workItem: 2,
    attempt: 1,
    runId: "vercel-deadline-run",
    directorEpoch: 1,
    policyDigest: "f".repeat(64),
    workspace: "/tmp/factory-vercel-deadline",
    deadline: new Date(2_000),
    packet: {
      goal: "deadline boundary",
      acceptanceCriteria: [],
      allowedPaths: [],
      preconditions: [],
      outOfScope: [],
      conventions: [],
      baseSha: "a".repeat(40),
      validationCommands: [],
      artifactContract: "clockgrove.factory/artifact-v1",
      requirements: {
        os: [],
        architecture: [],
        tools: [],
        services: [],
        networkDestinations: [],
        permittedSecretNames: [],
        trust: "isolated",
      },
    },
    artifact: {
      protocol: "clockgrove.factory/artifact-v1",
      baseSha: "a".repeat(40),
      patch: "",
      changedPaths: [],
      outcome: "declined",
      reason: "deadline fixture",
      digest: "b".repeat(64),
    },
  } as unknown as AttemptContext;
}

function staleIdentity(
  phase: "execution" | "validation",
  noHandleReplacementNotBefore = new Date(2_000).toISOString(),
): StaleAttemptIdentity {
  const context = deadlineContext();
  return {
    repository: context.repository,
    objective: context.objective,
    workItem: context.workItem,
    attempt: context.attempt,
    runId: context.runId,
    directorEpoch: context.directorEpoch,
    policyDigest: context.policyDigest,
    phase,
    noHandleReplacementNotBefore,
  };
}

it.each([
  [
    "execution",
    (backend: VercelSandboxBackend, context: AttemptContext) => backend.launch(context),
  ],
  [
    "validation",
    (backend: VercelSandboxBackend, context: AttemptContext) =>
      backend.validate(context as IsolatedValidationContext),
  ],
] as const)(
  "rejects an expired %s context before source or provider side effects",
  async (_, run) => {
    const inspect = vi.spyOn(lfs, "inspectPinnedLfs");
    const archive = vi.spyOn(sandboxCommon, "repositoryArchive");
    const backend = new VercelSandboxBackend({ repository: "/tmp/factory-vercel-deadline" });
    const context = { deadline: new Date(Date.now() - 1) } as AttemptContext;

    await expect(run(backend, context)).rejects.toThrow(/deadline exhausted/);
    expect(inspect).not.toHaveBeenCalled();
    expect(archive).not.toHaveBeenCalled();
    expect(provider.create).not.toHaveBeenCalled();
  },
);

it.each([
  [
    "execution",
    (backend: VercelSandboxBackend, context: AttemptContext) => backend.launch(context),
  ],
  [
    "validation",
    (backend: VercelSandboxBackend, context: AttemptContext) =>
      backend.validate(context as IsolatedValidationContext),
  ],
] as const)(
  "rechecks the %s deadline after sandbox preparation and before command dispatch",
  async (_, run) => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    vi.stubEnv("OPENAI_API_KEY", "fixture-model-key");
    vi.spyOn(lfs, "inspectPinnedLfs").mockResolvedValue({ assets: [] } as never);
    vi.spyOn(sandboxCommon, "repositoryArchive").mockResolvedValue(Buffer.alloc(0));
    const runCommand = vi.fn();
    const stop = vi.fn(async () => undefined);
    provider.create.mockResolvedValue({
      name: "deadline-sandbox",
      writeFiles: async () => {
        now = 2_000;
      },
      runCommand,
      stop,
    });
    const backend = new VercelSandboxBackend({ repository: "/tmp/factory-vercel-deadline" });
    const context = deadlineContext();

    await expect(run(backend, context)).rejects.toThrow(/deadline exhausted before .* dispatch/);
    expect(runCommand).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledOnce();
  },
);

it.each([
  [
    "execution",
    (backend: VercelSandboxBackend, context: AttemptContext) => backend.launch(context),
  ],
  [
    "validation",
    (backend: VercelSandboxBackend, context: AttemptContext) =>
      backend.validate(context as IsolatedValidationContext),
  ],
] as const)("prevents Vercel SDK auto-resume after the %s deadline", async (_, run) => {
  vi.stubEnv("OPENAI_API_KEY", "fixture-model-key");
  vi.spyOn(lfs, "inspectPinnedLfs").mockResolvedValue({ assets: [] } as never);
  vi.spyOn(sandboxCommon, "repositoryArchive").mockResolvedValue(Buffer.alloc(0));
  let dispatchController: AbortController | undefined;
  let commandAttempts = 0;
  let resumeAttempts = 0;
  const stop = vi.fn(async () => undefined);
  provider.create.mockResolvedValue({
    name: "deadline-sandbox",
    writeFiles: async () => undefined,
    runCommand: async ({ signal }: { signal?: AbortSignal }) => {
      commandAttempts += 1;
      dispatchController?.abort(new Error("immutable attempt deadline elapsed"));
      if (signal?.aborted) throw signal.reason;
      resumeAttempts += 1;
      commandAttempts += 1;
      throw new Error("Vercel SDK resumed after deadline");
    },
    stop,
  });
  const backend = new VercelSandboxBackend({
    repository: "/tmp/factory-vercel-deadline",
    now: () => 1_000,
    deadlineSignal: (_deadline, failure) => {
      const controller = new AbortController();
      if (/dispatch/.test(failure)) dispatchController = controller;
      return { signal: controller.signal, dispose: () => undefined };
    },
  });

  await expect(run(backend, deadlineContext())).rejects.toThrow(
    /immutable attempt deadline elapsed/,
  );
  expect(commandAttempts).toBe(1);
  expect(resumeAttempts).toBe(0);
  expect(stop).toHaveBeenCalledOnce();
});

it("bounds detached validation command completion before cleanup", async () => {
  vi.spyOn(lfs, "inspectPinnedLfs").mockResolvedValue({ assets: [] } as never);
  vi.spyOn(sandboxCommon, "repositoryArchive").mockResolvedValue(Buffer.alloc(0));
  let completionController: AbortController | undefined;
  const stop = vi.fn(async () => undefined);
  provider.create.mockResolvedValue({
    name: "deadline-sandbox",
    writeFiles: async () => undefined,
    runCommand: async () => ({
      wait: () => {
        completionController?.abort(new Error("immutable Vercel validation deadline elapsed"));
        return new Promise(() => undefined);
      },
    }),
    stop,
  });
  const backend = new VercelSandboxBackend({
    repository: "/tmp/factory-vercel-deadline",
    now: () => 1_000,
    deadlineSignal: (_deadline, failure) => {
      const controller = new AbortController();
      if (/command completion/.test(failure)) completionController = controller;
      return { signal: controller.signal, dispose: () => undefined };
    },
  });

  await expect(backend.validate(deadlineContext() as IsolatedValidationContext)).rejects.toThrow(
    /immutable Vercel validation deadline elapsed/,
  );
  expect(stop).toHaveBeenCalledOnce();
});

it("uses bounded stderr when the validation diagnostic file is empty", async () => {
  vi.spyOn(lfs, "inspectPinnedLfs").mockResolvedValue({ assets: [] } as never);
  vi.spyOn(sandboxCommon, "repositoryArchive").mockResolvedValue(Buffer.alloc(0));
  const stop = vi.fn(async () => undefined);
  const stderr = vi.fn(async () => "validator stderr fallback");
  provider.create.mockResolvedValue({
    name: "deadline-sandbox",
    writeFiles: async () => undefined,
    runCommand: async () => ({
      wait: async () => ({ exitCode: 1, stderr }),
    }),
    readFileToBuffer: async () => Buffer.alloc(0),
    stop,
  });
  const backend = new VercelSandboxBackend({
    repository: "/tmp/factory-vercel-deadline",
    now: () => 1_000,
    deadlineSignal: () => {
      const controller = new AbortController();
      return { signal: controller.signal, dispose: () => undefined };
    },
  });

  await expect(backend.validate(deadlineContext() as IsolatedValidationContext)).rejects.toThrow(
    /validator stderr fallback/,
  );
  expect(stderr).toHaveBeenCalledOnce();
  expect(stop).toHaveBeenCalledOnce();
});

it("bounds failed execution observation and retains the known terminal exit", async () => {
  vi.stubEnv("OPENAI_API_KEY", "fixture-model-key");
  vi.spyOn(lfs, "inspectPinnedLfs").mockResolvedValue({ assets: [] } as never);
  vi.spyOn(sandboxCommon, "repositoryArchive").mockResolvedValue(Buffer.alloc(0));
  let observationController: AbortController | undefined;
  const stderr = vi.fn(({ signal }: { signal?: AbortSignal } = {}) => {
    expect(signal).toBe(observationController?.signal);
    observationController?.abort(new Error("immutable Vercel observation deadline elapsed"));
    return new Promise<never>(() => undefined);
  });
  const stop = vi.fn(async () => undefined);
  provider.create.mockResolvedValue({
    name: "deadline-sandbox",
    writeFiles: async () => undefined,
    runCommand: async () => ({
      cmdId: "command-1",
      wait: async () => ({ exitCode: 17, stderr }),
      kill: async () => undefined,
    }),
    stop,
  });
  const backend = new VercelSandboxBackend({
    repository: "/tmp/factory-vercel-deadline",
    now: () => 1_000,
    deadlineSignal: (_deadline, failure) => {
      const controller = new AbortController();
      if (/failed-command observation/.test(failure)) observationController = controller;
      return { signal: controller.signal, dispose: () => undefined };
    },
  });

  const handle = await backend.launch(deadlineContext());
  await new Promise((resolve) => setTimeout(resolve, 0));
  await expect(backend.observe(handle)).resolves.toMatchObject({
    state: "failed",
    reason: "sandbox exited 17",
  });
  expect(stderr).toHaveBeenCalledOnce();
  await backend.cleanup(handle);
  expect(stop).toHaveBeenCalledOnce();
});

it("starts bounded Vercel cleanup without waiting for signal-ignoring command termination", async () => {
  vi.stubEnv("OPENAI_API_KEY", "fixture-model-key");
  vi.spyOn(lfs, "inspectPinnedLfs").mockResolvedValue({ assets: [] } as never);
  vi.spyOn(sandboxCommon, "repositoryArchive").mockResolvedValue(Buffer.alloc(0));
  const kill = vi.fn(
    (_signal?: string, _options?: { abortSignal?: AbortSignal }) =>
      new Promise<never>(() => undefined),
  );
  const stop = vi.fn(async () => undefined);
  provider.create.mockResolvedValue({
    name: "deadline-sandbox",
    writeFiles: async () => undefined,
    runCommand: async () => ({
      cmdId: "command-1",
      wait: () => new Promise<never>(() => undefined),
      kill,
    }),
    stop,
  });
  const backend = new VercelSandboxBackend({
    repository: "/tmp/factory-vercel-deadline",
    now: () => 1_000,
    deadlineSignal: () => {
      const controller = new AbortController();
      return { signal: controller.signal, dispose: () => undefined };
    },
  });

  const handle = await backend.launch(deadlineContext());
  await expect(backend.cancel(handle)).resolves.toBeUndefined();
  expect(kill).toHaveBeenCalledOnce();
  expect(kill.mock.calls[0]?.[1]).toEqual({ abortSignal: expect.any(AbortSignal) });
  expect(stop).toHaveBeenCalledOnce();
});

it("reports cancellation cleanup uncertainty without waiting for command termination", async () => {
  vi.stubEnv("OPENAI_API_KEY", "fixture-model-key");
  vi.spyOn(lfs, "inspectPinnedLfs").mockResolvedValue({ assets: [] } as never);
  vi.spyOn(sandboxCommon, "repositoryArchive").mockResolvedValue(Buffer.alloc(0));
  const kill = vi.fn(
    (_signal?: string, _options?: { abortSignal?: AbortSignal }) =>
      new Promise<never>(() => undefined),
  );
  const stop = vi.fn(async () => {
    throw new Error("provider stop unavailable");
  });
  provider.create.mockResolvedValue({
    name: "deadline-sandbox",
    writeFiles: async () => undefined,
    runCommand: async () => ({
      cmdId: "command-1",
      wait: () => new Promise<never>(() => undefined),
      kill,
    }),
    stop,
  });
  const backend = new VercelSandboxBackend({
    repository: "/tmp/factory-vercel-deadline",
    now: () => 1_000,
    deadlineSignal: () => {
      const controller = new AbortController();
      return { signal: controller.signal, dispose: () => undefined };
    },
  });

  const handle = await backend.launch(deadlineContext());
  await expect(backend.cancel(handle)).rejects.toMatchObject({
    name: "VercelResourceCleanupError",
    operation: "cancellation",
  });
  expect(kill).toHaveBeenCalledOnce();
  expect(stop).toHaveBeenCalledOnce();
});

it("surfaces uncertain validation cleanup after a post-preparation expiry", async () => {
  let now = 1_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  vi.spyOn(lfs, "inspectPinnedLfs").mockResolvedValue({ assets: [] } as never);
  vi.spyOn(sandboxCommon, "repositoryArchive").mockResolvedValue(Buffer.alloc(0));
  const runCommand = vi.fn();
  const stop = vi.fn(async () => {
    throw new Error("provider stop unavailable");
  });
  provider.create.mockResolvedValue({
    name: "deadline-sandbox",
    writeFiles: async () => {
      now = 2_000;
    },
    runCommand,
    stop,
  });
  const backend = new VercelSandboxBackend({ repository: "/tmp/factory-vercel-deadline" });

  const failure = await backend
    .validate(deadlineContext() as IsolatedValidationContext)
    .catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(VercelResourceCleanupError);
  expect(String(failure)).toMatch(/deadline exhausted before .* dispatch/);
  expect(String(failure)).toMatch(/may still be billable/);
  expect(runCommand).not.toHaveBeenCalled();
  expect(stop).toHaveBeenCalledOnce();
});

it.each(["execution", "validation"] as const)(
  "recovers an ambiguously created %s sandbox after initial 404 propagation lag",
  async (phase) => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    vi.stubEnv("OPENAI_API_KEY", "fixture-model-key");
    vi.spyOn(lfs, "inspectPinnedLfs").mockResolvedValue({ assets: [] } as never);
    vi.spyOn(sandboxCommon, "repositoryArchive").mockResolvedValue(Buffer.alloc(0));
    provider.create.mockRejectedValue(new Error("create response lost after allocation"));
    const stop = vi.fn(async () => undefined);
    provider.get
      .mockRejectedValueOnce(Object.assign(new Error("404 not found"), { status: 404 }))
      .mockResolvedValueOnce({
        name:
          phase === "validation"
            ? "factory-o1-w2-a1-vercel-deadline-run-validate"
            : "factory-o1-w2-a1-vercel-deadline-run",
        stop,
      });
    const backend = new VercelSandboxBackend({
      repository: "/tmp/factory-vercel-deadline",
      now: () => 1_000,
      sleep: async () => undefined,
      createVisibilityAttempts: 2,
      createVisibilityDelayMs: 0,
    });
    const context = deadlineContext();
    const operation =
      phase === "execution"
        ? backend.launch(context)
        : backend.validate(context as IsolatedValidationContext);

    await expect(operation).rejects.toBeInstanceOf(VercelResourceCleanupError);
    await expect(backend.reconcileStale(staleIdentity(phase))).resolves.toBeUndefined();
    expect(provider.get).toHaveBeenCalledTimes(2);
    expect(stop).toHaveBeenCalledOnce();
  },
);

it("bounds signal-ignoring Vercel stop confirmation and retains cleanup uncertainty", async () => {
  let stopController: AbortController | undefined;
  const stop = vi.fn(({ signal }: { signal?: AbortSignal } = {}) => {
    expect(signal).toBe(stopController?.signal);
    stopController?.abort(new Error("Vercel cleanup operation bound elapsed"));
    return new Promise<never>(() => undefined);
  });
  provider.get.mockResolvedValue({ name: "deadline-sandbox", stop });
  const backend = new VercelSandboxBackend({
    repository: "/tmp/factory-vercel-deadline",
    now: () => 1_000,
    cleanupTimeoutMs: 120_000,
    deadlineSignal: (_deadline, failure) => {
      const controller = new AbortController();
      if (/stop confirmation/.test(failure)) stopController = controller;
      return { signal: controller.signal, dispose: () => undefined };
    },
  });

  await expect(backend.reconcileStale(staleIdentity("execution"))).rejects.toMatchObject({
    name: "VercelResourceCleanupError",
    operation: "stale-resource reconciliation",
    cause: "Vercel cleanup operation bound elapsed",
  });
  expect(stop).toHaveBeenCalledOnce();
});

it.each(["execution", "validation"] as const)(
  "bounds a signal-ignoring Vercel %s stale-resource lookup with cleanup authority",
  async (phase) => {
    let lookupController: AbortController | undefined;
    provider.get.mockImplementation(() => {
      lookupController?.abort(new Error("Vercel cleanup lookup bound elapsed"));
      return new Promise<never>(() => undefined);
    });
    const lookupDeadlines: number[] = [];
    const backend = new VercelSandboxBackend({
      repository: "/tmp/factory-vercel-deadline",
      now: () => 1_000,
      cleanupTimeoutMs: 120_000,
      deadlineSignal: (deadline, failure) => {
        const controller = new AbortController();
        if (/visibility lookup/.test(failure)) {
          lookupController = controller;
          lookupDeadlines.push(deadline.getTime());
        }
        return { signal: controller.signal, dispose: () => undefined };
      },
    });

    await expect(backend.reconcileStale(staleIdentity(phase))).rejects.toMatchObject({
      name: "VercelResourceCleanupError",
      operation: "stale-resource lookup",
      cause: "Vercel cleanup lookup bound elapsed",
    });
    expect(lookupDeadlines).toEqual([121_000]);
    expect(provider.get).toHaveBeenCalledOnce();
  },
);

it.each(["execution", "validation"] as const)(
  "retains the %s no-handle fence through bounded 404s until a post-fence absence check",
  async (phase) => {
    let now = 1_000;
    provider.get.mockRejectedValue(Object.assign(new Error("404 not found"), { status: 404 }));
    const backend = new VercelSandboxBackend({
      repository: "/tmp/factory-vercel-deadline",
      now: () => now,
      sleep: async () => undefined,
      createVisibilityAttempts: 1,
      createVisibilityDelayMs: 0,
    });
    const identity = staleIdentity(phase);

    await expect(backend.reconcileStale(identity)).rejects.toMatchObject({
      name: "VercelResourceCleanupError",
      operation: "durable no-handle replacement fence",
    });
    now = 2_000;
    await expect(backend.reconcileStale(identity)).resolves.toBeUndefined();
    expect(provider.get).toHaveBeenCalledTimes(2);
  },
);

it.each([
  [
    "execution",
    (backend: VercelSandboxBackend, context: AttemptContext) => backend.launch(context),
  ],
  [
    "validation",
    (backend: VercelSandboxBackend, context: AttemptContext) =>
      backend.validate(context as IsolatedValidationContext),
  ],
] as const)("bounds stalled Vercel %s LFS inspection by the immutable deadline", async (_, run) => {
  vi.stubEnv("OPENAI_API_KEY", "fixture-model-key");
  let inspectionDeadlineController: AbortController | undefined;
  vi.spyOn(lfs, "inspectPinnedLfs").mockImplementation(async () => {
    inspectionDeadlineController?.abort(new Error("immutable Vercel LFS deadline elapsed"));
    return new Promise<never>(() => undefined);
  });
  const archive = vi.spyOn(sandboxCommon, "repositoryArchive");
  const backend = new VercelSandboxBackend({
    repository: "/tmp/factory-vercel-deadline",
    now: () => 1_000,
    deadlineSignal: (_deadline, failure) => {
      const controller = new AbortController();
      if (/LFS inspection/.test(failure)) inspectionDeadlineController = controller;
      return { signal: controller.signal, dispose: () => undefined };
    },
  });

  await expect(run(backend, deadlineContext())).rejects.toThrow(
    "immutable Vercel LFS deadline elapsed",
  );
  expect(archive).not.toHaveBeenCalled();
  expect(provider.create).not.toHaveBeenCalled();
});

it.each([
  [
    "execution",
    (backend: VercelSandboxBackend, context: AttemptContext) => backend.launch(context),
  ],
  [
    "validation",
    (backend: VercelSandboxBackend, context: AttemptContext) =>
      backend.validate(context as IsolatedValidationContext),
  ],
] as const)(
  "bounds stalled Vercel %s archive preparation by the immutable deadline",
  async (_, run) => {
    vi.stubEnv("OPENAI_API_KEY", "fixture-model-key");
    vi.spyOn(lfs, "inspectPinnedLfs").mockResolvedValue({ assets: [] } as never);
    let archiveDeadlineController: AbortController | undefined;
    vi.spyOn(sandboxCommon, "repositoryArchive").mockImplementation(
      async (_repository, _baseSha, options) => {
        expect(options).toMatchObject({ deadline: new Date(2_000) });
        expect(options?.signal).toBe(archiveDeadlineController?.signal);
        archiveDeadlineController?.abort(new Error("immutable Vercel archive deadline elapsed"));
        return new Promise<never>(() => undefined);
      },
    );
    const backend = new VercelSandboxBackend({
      repository: "/tmp/factory-vercel-deadline",
      now: () => 1_000,
      deadlineSignal: (_deadline, failure) => {
        const controller = new AbortController();
        if (/archive preparation/.test(failure)) archiveDeadlineController = controller;
        return { signal: controller.signal, dispose: () => undefined };
      },
    });

    await expect(run(backend, deadlineContext())).rejects.toThrow(
      "immutable Vercel archive deadline elapsed",
    );
    expect(provider.create).not.toHaveBeenCalled();
  },
);

it.each([
  [
    "execution",
    (backend: VercelSandboxBackend, context: AttemptContext) => backend.launch(context),
  ],
  [
    "validation",
    (backend: VercelSandboxBackend, context: AttemptContext) =>
      backend.validate(context as IsolatedValidationContext),
  ],
] as const)(
  "rechecks the %s deadline after archive preparation and before create",
  async (_, run) => {
    let now = 1_000;
    vi.stubEnv("OPENAI_API_KEY", "fixture-model-key");
    vi.spyOn(lfs, "inspectPinnedLfs").mockResolvedValue({ assets: [] } as never);
    vi.spyOn(sandboxCommon, "repositoryArchive").mockImplementation(async () => {
      now = 2_000;
      return Buffer.alloc(0);
    });
    const backend = new VercelSandboxBackend({
      repository: "/tmp/factory-vercel-deadline",
      now: () => now,
    });
    const context = {
      deadline: new Date(2_000),
      packet: {
        baseSha: "a".repeat(40),
        requirements: { networkDestinations: [] },
      },
      artifact: {},
    } as unknown as AttemptContext;

    await expect(run(backend, context)).rejects.toThrow(/deadline exhausted/);
    expect(provider.create).not.toHaveBeenCalled();
  },
);
