import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ControllerFatalError } from "../src/controller/failure.js";
import { ControllerGenerationRetirement } from "../src/controller/retirement.js";

const runController = vi.hoisted(() => vi.fn());
vi.mock("../src/controller/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/controller/index.js")>()),
  runGitHubRepositoryController: runController,
}));

import { main } from "../src/cli.js";

let stderr: ReturnType<typeof vi.spyOn>;
let previousToken: string | undefined;

beforeEach(() => {
  previousToken = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = "test-only";
  process.exitCode = undefined;
  runController.mockReset();
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
});

it("keeps deliberate generation retirement restartable and redacted", async () => {
  runController.mockRejectedValueOnce(new ControllerGenerationRetirement());
  await main(["controller", "run", "owner/repo", "--repo", "/tmp"]);
  const log = stderrText();
  expect(process.exitCode).toBe(1);
  expect(log).toContain("retryable code=controller-generation-retirement");
  expect(log).not.toContain("ControllerGenerationRetirement");
});
