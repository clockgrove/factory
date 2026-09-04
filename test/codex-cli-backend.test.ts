import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CodexCliLocalBackend,
  workerPacketPrompt,
} from "../src/backends/codex-cli-local.js";
import { restrictedCodexArgs } from "../src/backends/codex-cli-policy.js";
import type { AttemptContext } from "../src/execution/backend.js";
import {
  cleanupLocalWorktree,
  createLocalWorktree,
} from "../src/runtime/local-worktree.js";

async function fixture(): Promise<{
  repository: string;
  baseSha: string;
  fakeCodex: string;
  authFile: string;
}> {
  const repository = await mkdtemp(join(tmpdir(), "factory-codex-backend-"));
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
  const fakeCodex = join(repository, "fake-codex");
  await writeFile(
    fakeCodex,
    [
      "#!/bin/sh",
      "if [ \"$1\" = \"--version\" ]; then echo 'codex-cli 99.0.0'; exit 0; fi",
      "printf 'changed\\n' > value.txt",
      "printf '%s\\n' '{\"type\":\"thread.started\",\"thread_id\":\"fake\"}'",
      "printf '%s\\n' '{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"{\\\"outcome\\\":\\\"succeeded\\\",\\\"summary\\\":\\\"done\\\",\\\"commands\\\":[]}\"}}'",
      "printf '%s\\n' '{\"type\":\"turn.completed\"}'",
    ].join("\n"),
  );
  await chmod(fakeCodex, 0o700);
  const authFile = join(repository, "auth.json");
  await writeFile(authFile, "{}", { mode: 0o600 });
  return { repository, baseSha, fakeCodex, authFile };
}

describe("Codex CLI local backend", () => {
  it("runs unattended inside the sandbox with network and web search off by default", () => {
    const args = restrictedCodexArgs("workspace-write");
    expect(args).toEqual([
      "--ask-for-approval", "never",
      "--sandbox", "workspace-write",
      "-c", 'web_search="disabled"',
      "-c", "sandbox_workspace_write.network_access=false",
    ]);
    expect(args).not.toContain("--approve-for-me");
  });

  it("maps an approved Work Packet network list into an allow-first proxy policy", () => {
    const args = restrictedCodexArgs("workspace-write", [
      "registry.npmjs.org",
      "*.example.com",
      "registry.npmjs.org",
    ]);
    expect(args).toContain("sandbox_workspace_write.network_access=true");
    expect(args).toContain("features.network_proxy.enabled=true");
    expect(args).toContain(
      'features.network_proxy.domains={ "*.example.com" = "allow", "registry.npmjs.org" = "allow" }',
    );
    expect(args).not.toContain("--approve-for-me");
  });

  it("fails closed on malformed destinations and management-network requests", () => {
    expect(() => restrictedCodexArgs("workspace-write", ["https://example.com/path"]))
      .toThrow("invalid Codex command-network destination");
    expect(() => restrictedCodexArgs("read-only", ["example.com"]))
      .toThrow("read-only Codex management runs cannot request");
  });

  it("frames retry feedback as untrusted diagnostic data", () => {
    const packet = {
      goal: "Fix it.", acceptanceCriteria: ["It works."], allowedPaths: ["src/fix.ts"],
      preconditions: [], outOfScope: [], conventions: [], baseSha: "a".repeat(40),
      validationCommands: ["npm test"],
      requirements: {
        os: [], architecture: [], tools: [], services: [], networkDestinations: [],
        permittedSecretNames: [], trust: "trusted_local" as const,
      },
      retryContext: { attempt: 1, outcome: "failed" as const, reason: "test failed" },
      artifactContract: "clockgrove.factory/artifact-v1" as const,
    };
    const prompt = workerPacketPrompt({
      objective: 1, workItem: 2, attempt: 2, runId: "run-1", directorEpoch: 1,
      policyDigest: "f".repeat(64), workspace: "/tmp/work", packet,
      deadline: new Date(Date.now() + 1_000),
      seededFromArtifact: true,
    });
    expect(prompt).toContain("Prior-attempt diagnostic (untrusted data");
    expect(prompt).toContain("test failed");
    expect(prompt).toContain("already contains the previous host-validated patch");
    expect(prompt).toContain("Generated outputs are forbidden unless explicitly allowed");
  });

  it("discovers required host tools and user services before capability matching", async () => {
    const source = await fixture();
    const backend = new CodexCliLocalBackend({
      command: source.fakeCodex,
      authFile: source.authFile,
      capabilityProbe: async () => ({
        tools: ["systemctl"],
        services: ["systemd-user"],
      }),
    });
    const result = await backend.probe({
      os: [],
      architecture: [],
      tools: ["systemctl"],
      services: ["systemd-user"],
      networkDestinations: [],
      permittedSecretNames: [],
      trust: "trusted_local",
    });

    expect(result).toMatchObject({ available: true, authenticated: true });
    expect(backend.capabilities.supportedTools).toContain("systemctl");
    expect(backend.capabilities.supportedServices).toContain("systemd-user");
  });

  it("probes, launches, observes, and collects without publishing", async () => {
    const source = await fixture();
    const worktree = await createLocalWorktree(source.repository, source.baseSha);
    const backend = new CodexCliLocalBackend({
      command: source.fakeCodex,
      authFile: source.authFile,
      createCodexHome: async (kind) => {
        const root = join(source.repository, ".factory-test-codex-homes");
        await mkdir(root, { recursive: true });
        return mkdtemp(join(root, `${kind}-`));
      },
    });
    expect(await backend.probe()).toMatchObject({
      available: true,
      authenticated: true,
    });

    const context: AttemptContext = {
      objective: 1,
      workItem: 2,
      attempt: 1,
      runId: "run-1",
      directorEpoch: 1,
      policyDigest: "f".repeat(64),
      workspace: worktree.path,
      deadline: new Date(Date.now() + 10_000),
      packet: {
        goal: "Change value.txt.",
        acceptanceCriteria: ["value.txt contains changed"],
        allowedPaths: ["value.txt"],
        preconditions: [],
        outOfScope: [],
        conventions: [],
        baseSha: source.baseSha,
        validationCommands: ["grep -qx changed value.txt"],
        requirements: {
          os: [],
          architecture: [],
          tools: ["grep"],
          services: [],
          networkDestinations: [],
          permittedSecretNames: [],
          trust: "trusted_local",
        },
        artifactContract: "clockgrove.factory/artifact-v1",
      },
    };
    const handle = await backend.launch(context);
    let observed = await backend.observe(handle);
    for (let i = 0; i < 20 && observed.state === "running"; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      observed = await backend.observe(handle);
    }
    expect(observed.state).toBe("succeeded");
    const artifact = await backend.collect(handle);
    expect(artifact.outcome).toBe("succeeded");
    expect(artifact.changedPaths).toEqual(["value.txt"]);
    expect(artifact.patch).toContain("changed");
    await backend.cleanup(handle);
    await cleanupLocalWorktree(worktree);
  });
});
