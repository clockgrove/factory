import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { DaytonaBackend } from "../src/backends/daytona.js";
import type { AttemptContext, BackendHandle } from "../src/execution/backend.js";

const LIVE = process.env.FACTORY_LIVE_DAYTONA === "1";
const MAX_MINUTES = Number(process.env.FACTORY_LIVE_DAYTONA_MAX_MINUTES ?? "10");
const temporaryPaths = new Set<string>();

afterAll(async () => {
  await Promise.all([...temporaryPaths].map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(): Promise<{ repository: string; context: AttemptContext }> {
  const repository = await mkdtemp(join(tmpdir(), "factory-daytona-live-"));
  temporaryPaths.add(repository);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repository });
  execFileSync("git", ["config", "user.name", "Factory Conformance"], {
    cwd: repository,
  });
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
  const runId = `live-${Date.now()}`;
  return {
    repository,
    context: {
      repository: "clockgrove/factory",
      objective: 1,
      workItem: 1,
      attempt: 1,
      runId,
      directorEpoch: 1,
      policyDigest: "f".repeat(64),
      workspace: repository,
      deadline: new Date(Date.now() + MAX_MINUTES * 60_000),
      packet: {
        goal: "Replace the only line in value.txt with exactly: changed",
        acceptanceCriteria: ["value.txt contains exactly one line: changed"],
        allowedPaths: ["value.txt"],
        preconditions: ["value.txt exists and contains base"],
        outOfScope: ["all other files"],
        conventions: ["preserve a trailing newline"],
        baseSha,
        validationCommands: ["grep -qx changed value.txt"],
        requirements: {
          os: ["linux"],
          architecture: [],
          tools: ["git", "node", "npm", "npx", "bash"],
          services: [],
          networkDestinations: [],
          permittedSecretNames: [],
          trust: "isolated",
          timeoutMinutes: MAX_MINUTES,
          cpu: 2,
          memoryMb: 4096,
          diskMb: 8192,
        },
        artifactContract: "clockgrove.factory/artifact-v1",
      },
      policyNetworkDestinations: ["registry.npmjs.org", "*.npmjs.org", "api.openai.com"],
    },
  };
}

async function waitForTerminal(backend: DaytonaBackend, handle: BackendHandle, deadline: Date) {
  while (Date.now() < deadline.getTime()) {
    const observation = await backend.observe(handle);
    if (!["starting", "running", "unknown"].includes(observation.state)) {
      return observation;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  await backend.cancel(handle);
  throw new Error("live Daytona worker exceeded its hard conformance deadline");
}

describe.skipIf(!LIVE)("live Daytona release gate", () => {
  it(
    "runs a real isolated worker, validates in a second sandbox, and leaves no resource behind",
    async () => {
      if (!Number.isFinite(MAX_MINUTES) || MAX_MINUTES < 1 || MAX_MINUTES > 10) {
        throw new Error("FACTORY_LIVE_DAYTONA_MAX_MINUTES must be between 1 and 10");
      }
      if (!process.env.DAYTONA_API_KEY) {
        throw new Error("DAYTONA_API_KEY is required for the live release gate");
      }
      if (!process.env.FACTORY_DAYTONA_MODEL_SECRET) {
        throw new Error(
          "FACTORY_DAYTONA_MODEL_SECRET must name an existing Daytona organization Secret",
        );
      }

      const source = await fixture();
      const backend = new DaytonaBackend({ repository: source.repository });
      const probe = await backend.probe();
      expect(probe).toMatchObject({ available: true, authenticated: true });

      let handle: BackendHandle | undefined;
      try {
        handle = await backend.launch(source.context);
        const observation = await waitForTerminal(backend, handle, source.context.deadline);
        expect(observation.state, observation.reason).toBe("succeeded");
        const artifact = await backend.collect(handle);
        expect(artifact).toMatchObject({
          outcome: "succeeded",
          changedPaths: ["value.txt"],
        });
        expect(artifact.patch).toContain("+changed");
        expect(artifact.patch).not.toContain("GITHUB_TOKEN");

        const validation = await backend.validate!({
          ...source.context,
          artifact,
        });
        expect(validation.passed, validation.failureReason).toBe(true);
        expect(validation.commands).toContainEqual(
          expect.objectContaining({
            command: "grep -qx changed value.txt",
            exitCode: 0,
          }),
        );
      } finally {
        if (handle) await backend.cleanup(handle);
      }

      await expect(
        backend.reconcileStale!({
          repository: source.context.repository,
          objective: source.context.objective,
          workItem: source.context.workItem,
          attempt: source.context.attempt,
          runId: source.context.runId,
          directorEpoch: source.context.directorEpoch,
        }),
      ).resolves.toBeUndefined();
    },
    11 * 60_000,
  );
});
