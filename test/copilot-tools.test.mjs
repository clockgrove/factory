import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  githubCopilotClientOptions,
  githubCopilotSessionOptions,
} from "../dist/execution/github-copilot-options.js";
import { bindTarget, createTarget } from "./support/integration-fixture.mjs";

const [major, minor] = process.versions.node.split(".").map(Number);
const supported =
  process.platform === "linux" &&
  process.arch === "x64" &&
  (major > 22 || (major === 22 && minor >= 12));

test("Copilot default tools expose the model's native editor and preserve worktree permissions without login or model turns", {
  skip: !supported,
  timeout: 30_000,
}, async (t) => {
  let CopilotClient;
  try {
    ({ CopilotClient } = await import("@github/copilot-sdk"));
  } catch (error) {
    if (
      error.code !== "ERR_MODULE_NOT_FOUND" ||
      !error.message.includes("Cannot find package '@github/copilot-sdk'")
    )
      throw error;
    t.skip("optional Copilot SDK omitted from this installation");
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "factory-copilot-tools-"));
  let client;
  let session;
  try {
    const { checkout } = createTarget(root);
    bindTarget(checkout, "example/copilot-tools");
    const configPath = join(root, "factory.json");
    execFileSync(
      process.execPath,
      [
        resolve(import.meta.dirname, "../dist/cli.js"),
        "setup",
        "--config-only",
        "--repository",
        "example/copilot-tools",
        "--checkout",
        checkout,
        "--concurrency",
        "1",
        "--harness",
        "github-copilot-sdk",
        "--worker-model",
        "gpt-5.6-luna",
        "--copilot-timeout-seconds",
        "30",
        "--config",
        configPath,
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, XDG_STATE_HOME: join(root, "state") },
      },
    );
    const input = {
      request: { worktree: checkout },
      config: JSON.parse(readFileSync(configPath, "utf8")).execution.harness,
    };
    for (const directory of ["home", "gh", "config", "runtime"])
      mkdirSync(join(root, directory));
    // Never inherit provider or controller credentials, profiles or keychains.
    // No send/sendAndWait call is made; only local tool metadata/execution RPCs.
    const environment = {
      PATH: process.env.PATH,
      HOME: join(root, "home"),
      GH_CONFIG_DIR: join(root, "gh"),
      XDG_CONFIG_HOME: join(root, "config"),
      COPILOT_DISABLE_KEYTAR: "1",
      COPILOT_SDK_DEFAULT_CONNECTION: "stdio",
      HTTP_PROXY: "http://127.0.0.1:1",
      HTTPS_PROXY: "http://127.0.0.1:1",
    };
    client = new CopilotClient({
      ...githubCopilotClientOptions(input, environment, join(root, "runtime")),
      useLoggedInUser: false,
    });
    await client.start();
    assert.equal((await client.getAuthStatus()).isAuthenticated, false);
    const options = githubCopilotSessionOptions(input);
    const permissions = [];
    session = await client.createSession({
      ...options,
      onPermissionRequest: (request, invocation) => {
        const decision = options.onPermissionRequest(request, invocation);
        permissions.push({ request, decision });
        return decision;
      },
    });
    await session.rpc.tools.initializeAndValidate();
    const metadata = await session.rpc.tools.getCurrentMetadata();
    assert.deepEqual(metadata.tools.map((tool) => tool.name).sort(), [
      "apply_patch",
      "glob",
      "rg",
      "view",
    ]);
    const patch = (body) =>
      session.rpc.tools.execute({
        name: "apply_patch",
        arguments: `*** Begin Patch\n${body}*** End Patch\n`,
      });
    const proof = join(checkout, "proof.txt");
    assert.equal(
      (await patch(`*** Add File: ${proof}\n+offline proof\n`)).resultType,
      "success",
    );
    assert.equal(readFileSync(proof, "utf8"), "offline proof\n");
    assert.ok(
      permissions.some(
        ({ request, decision }) =>
          request.kind === "write" &&
          request.fileName === proof &&
          decision.kind === "approve-once",
      ),
    );
    const outside = join(root, "outside.txt");
    symlinkSync(root, join(checkout, "escape"));
    for (const path of [outside, join(checkout, "escape", "outside.txt")]) {
      assert.notEqual(
        (await patch(`*** Add File: ${path}\n+must not write\n`)).resultType,
        "success",
      );
      assert.equal(existsSync(outside), false);
    }
    assert.notEqual(
      (
        await patch(
          `*** Update File: ${proof}\n*** Move to: ${outside}\n@@\n-offline proof\n+must not move\n`,
        )
      ).resultType,
      "success",
    );
    assert.equal(existsSync(outside), false);
    assert.equal(readFileSync(proof, "utf8"), "offline proof\n");
    assert.ok(permissions.some(({ decision }) => decision.kind === "reject"));
  } finally {
    try {
      await session?.disconnect();
    } finally {
      if (client) {
        const errors = await client.stop();
        if (errors.length) await client.forceStop();
      }
      rmSync(root, { recursive: true, force: true });
    }
  }
});
