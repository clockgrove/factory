import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONTROLLER_FATAL_EXIT_STATUS,
  ControllerFatalError,
  controllerExecutableIdentity,
  controllerFatalDiagnostic,
} from "../src/controller/failure.js";
import {
  observeGitHubTransport,
  observeGitHubTransportPhase,
} from "../src/control/mutation-observation.js";

describe("controller fatal process contract", () => {
  it("assigns stable non-restartable statuses to every bounded fatal code", () => {
    expect(CONTROLLER_FATAL_EXIT_STATUS).toEqual({
      "controller-durable-state-incompatible": 65,
      "controller-internal-invariant": 70,
      "controller-discovery-failure": 72,
      "controller-local-configuration": 78,
      "controller-launcher-failure": 203,
    });
    expect(new Set(Object.values(CONTROLLER_FATAL_EXIT_STATUS)).size).toBe(5);
  });

  it("preserves the private cause but emits only a keyed safe fingerprint", () => {
    const secret = "Bearer private-token in an Objective body";
    const cause = new Error(secret);
    cause.stack = `Error: ${secret}\n    at discover (/factory/repository-controller.js:123:4)`;
    const error = new ControllerFatalError(
      "controller-discovery-failure",
      "controller-invariant-failure",
      cause,
    );
    const executable = `sha256:${"a".repeat(64)}`;
    const first = controllerFatalDiagnostic(error, executable);
    const same = controllerFatalDiagnostic(error, executable);
    const corrected = controllerFatalDiagnostic(error, `sha256:${"b".repeat(64)}`);

    expect(error.cause).toBe(cause);
    expect(first).toMatchObject({
      code: "controller-discovery-failure",
      safeIdentity: "controller-invariant-failure",
      executableIdentity: executable,
      exitStatus: 72,
      failureFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{24}$/),
    });
    expect(same.failureFingerprint).toBe(first.failureFingerprint);
    expect(corrected.failureFingerprint).not.toBe(first.failureFingerprint);
    expect(JSON.stringify(first)).not.toContain(secret);
  });

  it("rejects an arbitrary diagnostic identity rather than exposing it", () => {
    const error = new ControllerFatalError(
      "controller-internal-invariant",
      "Bearer private-token",
      new Error("private"),
    );
    expect(error.safeIdentity).toBe("controller-invariant-failure");
  });

  it("changes exact executable identity when artifact bytes change", async () => {
    const directory = await mkdtemp(join(tmpdir(), "factory-controller-identity-"));
    const artifact = join(directory, "factory.js");
    try {
      await writeFile(artifact, "first");
      const first = await controllerExecutableIdentity(artifact);
      await writeFile(artifact, "second");
      const second = await controllerExecutableIdentity(artifact);
      expect(first).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(second).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(second).not.toBe(first);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("controller cold-start transport accounting", () => {
  it("counts actual read, mutation, and unclassified transports by phase", async () => {
    const reports: unknown[] = [];
    await observeGitHubTransportPhase(
      "repository-lease-acquisition",
      (observation) => reports.push(observation),
      async () => {
        observeGitHubTransport("https://api.github.com/repos/o/r");
        observeGitHubTransport("https://api.github.com/graphql", {
          method: "POST",
          body: JSON.stringify({ query: "query { viewer { login } }" }),
        });
        observeGitHubTransport("https://api.github.com/graphql", {
          method: "POST",
          body: JSON.stringify({ query: "mutation { createRef(input: {}) { clientMutationId } }" }),
        });
        observeGitHubTransport("https://api.github.com/graphql", {
          method: "POST",
          body: "not-json",
        });
      },
    );
    expect(reports).toEqual([
      expect.objectContaining({
        measurementScope: "process-local-controller-phase",
        phase: "repository-lease-acquisition",
        readRequests: 2,
        mutationRequests: 1,
        unclassifiedRequests: 1,
        outcome: "succeeded",
      }),
    ]);
  });
});
