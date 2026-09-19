import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { ControllerFatalError, controllerExecutableIdentity } from "../src/controller/failure.js";
import { ControllerGenerationRetirement } from "../src/controller/retirement.js";

const runController = vi.hoisted(() => vi.fn());
const observeManagedGeneration = vi.hoisted(() => vi.fn());
vi.mock("../src/controller/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/controller/index.js")>()),
  runGitHubRepositoryController: runController,
}));
vi.mock("../src/controller/managed-generation.js", () => ({
  observeManagedControllerGeneration: observeManagedGeneration,
}));

import { main } from "../src/cli.js";

let stderr: ReturnType<typeof vi.spyOn>;
let previousToken: string | undefined;

beforeEach(() => {
  previousToken = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = "test-only";
  process.exitCode = undefined;
  runController.mockReset();
  observeManagedGeneration.mockReset();
  stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  if (previousToken === undefined) delete process.env.GITHUB_TOKEN;
  else process.env.GITHUB_TOKEN = previousToken;
  process.exitCode = undefined;
  stderr.mockRestore();
});

function stderrText(): string {
  return stderr.mock.calls.map((call: unknown[]) => String(call[0])).join("");
}

it("fuses changed installed bytes before any controller or GitHub work", async () => {
  await main([
    "controller",
    "run",
    "owner/repo",
    "--repo",
    "/tmp",
    "--executable-identity",
    `sha256:${"0".repeat(64)}`,
  ]);
  const log = stderrText();
  expect(runController).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(203);
  expect(log).toContain(
    "fatal code=controller-launcher-failure identity=controller-artifact-identity-mismatch",
  );
  expect(log).toContain("fingerprint=sha256:");
  expect(observeManagedGeneration).not.toHaveBeenCalled();
});

it("refuses an installed launch whose exact managed-service generation is unproved", async () => {
  const identity = await controllerExecutableIdentity(
    fileURLToPath(new URL("../src/cli.ts", import.meta.url)),
  );
  expect(identity).not.toBeNull();
  observeManagedGeneration.mockResolvedValueOnce(null);

  await main([
    "controller",
    "run",
    "owner/repo",
    "--repo",
    "/tmp",
    "--executable-identity",
    identity!,
  ]);

  expect(runController).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(78);
  expect(stderrText()).toContain(
    "fatal code=controller-local-configuration identity=managed-controller-generation-unavailable",
  );
});

it("passes the authenticated installed generation to repository election", async () => {
  const identity = await controllerExecutableIdentity(
    fileURLToPath(new URL("../src/cli.ts", import.meta.url)),
  );
  expect(identity).not.toBeNull();
  const owner = {
    kind: "managed-service" as const,
    hostIdentity: "a".repeat(64),
    configDigest: "b".repeat(64),
    executableIdentity: identity!,
    unit: "clockgrove-factory-d0fc20d770ef78d6.service",
    invocationId: "c".repeat(32),
  };
  observeManagedGeneration.mockResolvedValueOnce(owner);
  runController.mockResolvedValueOnce(undefined);

  await main([
    "controller",
    "run",
    "owner/repo",
    "--repo",
    "/tmp",
    "--executable-identity",
    identity!,
  ]);

  expect(observeManagedGeneration).toHaveBeenCalledWith({
    expectedUnit: expect.stringMatching(/^clockgrove-factory-[a-f0-9]{16}\.service$/),
    expectedFragmentPath: expect.stringMatching(
      /\/\.config\/systemd\/user\/clockgrove-factory-[a-f0-9]{16}\.service$/,
    ),
    executableIdentity: identity,
  });
  expect(runController).toHaveBeenCalledWith(
    expect.objectContaining({ repositoryLeaseOwner: owner }),
  );
  expect(process.exitCode).toBeUndefined();
});

it("prints only the bounded fatal contract and retains the non-restartable status", async () => {
  const secret = "Bearer private-token and private Objective body";
  const cause = new Error(secret);
  runController.mockRejectedValueOnce(
    new ControllerFatalError("controller-discovery-failure", "controller-invariant-failure", cause),
  );
  await main(["controller", "run", "owner/repo", "--repo", "/tmp"]);
  const log = stderrText();
  expect(process.exitCode).toBe(72);
  expect(log).toContain("fatal code=controller-discovery-failure");
  expect(log).toContain("identity=controller-invariant-failure");
  expect(log).not.toContain(secret);
  expect(log).not.toContain("Error:");
  expect(runController).toHaveBeenCalledWith(
    expect.objectContaining({ repositoryLeaseOwner: { kind: "process" } }),
  );
});

it("keeps deliberate generation retirement restartable and redacted", async () => {
  runController.mockRejectedValueOnce(new ControllerGenerationRetirement());
  await main(["controller", "run", "owner/repo", "--repo", "/tmp"]);
  const log = stderrText();
  expect(process.exitCode).toBe(1);
  expect(log).toContain("retryable code=controller-generation-retirement");
  expect(log).not.toContain("ControllerGenerationRetirement");
});
