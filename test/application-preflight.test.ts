import { afterEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { inspectLocalCheckout } from "../src/application/checkout.js";
import {
  buildDoctorReport,
  probeHostToolchain,
  probeHostResources,
  type DoctorChecks,
} from "../src/application/doctor.js";
import {
  buildPlanReport,
  validatePlanningCheckout,
  readPlanningRepositoryLayout,
} from "../src/application/plan.js";
import {
  compiledGraphDigest,
  renderLegacyWorkItemCore,
  renderWorkPacket,
  validateGraph,
  type CompiledObjective,
} from "../src/graph.js";
import { compileObjective } from "../src/compiler/index.js";
import { managedRuntimeRequirements } from "../src/toolchains/authority.js";
import type { ManagementBackend } from "../src/management/backend.js";
import type { CompilationContext, CompilationCheckpoint } from "../src/management/backend.js";

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "factory-preflight-"));
  roots.push(root);
  const git = async (...args: string[]) => (await exec("git", ["-C", root, ...args])).stdout.trim();
  await git("init", "-b", "main");
  await git("config", "user.name", "Fixture");
  await git("config", "user.email", "fixture@example.test");
  await git("remote", "add", "origin", "git@github.com:o/r.git");
  await writeFile(join(root, "README.md"), "```sh\npython3 -m unittest discover\n```\n");
  await writeFile(join(root, "sample.py"), "VALUE = 1\n");
  await git("add", "README.md", "sample.py");
  await git("commit", "-m", "fixture");
  return { root, git, head: await git("rev-parse", "HEAD") };
}
const snapshot = {
  id: "objective",
  number: 7,
  title: "Feature",
  defaultBranch: "main",
  workItems: [],
  factoryEvents: [],
};
function healthyChecks(): DoctorChecks {
  return {
    repositoryFacts: async () => ({
      fullName: "o/r",
      fork: false,
      private: true,
      defaultBranch: "main",
      canPush: true,
    }),
    authenticatedLogin: async () => "operator",
    branchRules: async () => [],
    stackCapability: async () => ({ available: false }),
    managementProbe: async () => ({
      id: "management",
      probe: { available: true, authenticated: true },
    }),
    backendProbes: async () => [
      { id: "codex-sdk/local-worktree", probe: { available: true, authenticated: true } },
    ],
    toolchainProbe: async () => ({
      platform: "linux",
      commands: {
        git: { available: true },
        python3: { available: true },
        python: { available: false },
      },
      validationCommands: ["python3 -m unittest discover"],
    }),
    resourceProbe: async () => ({
      measuredAt: new Date().toISOString(),
      logicalCpu: 8,
      effectiveCpu: 4,
      totalMemoryMb: 8192,
      availableMemoryMb: 6144,
      loadRatio: 0.1,
      memoryUsageRatio: 0.25,
      source: "cgroup-v2",
    }),
  };
}

describe("read-only checkout preflight", () => {
  it("reports valid existing Work Items as bounded same-issue adoption input", async () => {
    const f = await fixture();
    const report = await buildDoctorReport({
      repository: "o/r",
      objective: 7,
      checkout: f.root,
      readObjective: async () => ({
        ...snapshot,
        workItems: [
          {
            id: "I_8",
            number: 8,
            title: "Existing reviewed item",
            body: renderLegacyWorkItemCore({
              goal: "Implement the reviewed behavior",
              acceptance: ["The behavior is observable"],
              scope: ["sample.py"],
              preconditions: [],
              outOfScope: [],
              conventions: [],
            }),
            blockedBy: [],
          },
        ],
      }),
      checks: healthyChecks(),
    });

    expect(report.overall).toBe("ready");
    expect(report.diagnostics.find((entry) => entry.area === "graph")).toMatchObject({
      status: "pass",
      summary: expect.stringContaining("same issues"),
      details: {
        classification: "legacy-adoptable",
        workItemCount: 1,
        hasGraphReceipt: false,
        legacyConstraintDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    });
  });

  it("reports malformed existing Work Items as an activation-blocking graph diagnostic", async () => {
    const f = await fixture();
    const report = await buildDoctorReport({
      repository: "o/r",
      objective: 7,
      checkout: f.root,
      readObjective: async () => ({
        ...snapshot,
        workItems: [
          {
            id: "I_8",
            number: 8,
            title: "Malformed item",
            body: "not a bounded legacy Work Item",
            blockedBy: [],
          },
        ],
      }),
      checks: healthyChecks(),
    });

    expect(report.overall).toBe("attention-required");
    expect(report.diagnostics.find((entry) => entry.area === "graph")).toMatchObject({
      status: "fail",
      summary: expect.stringContaining("six ordered legacy sections"),
    });
  });

  it.each([false, true])(
    "checks the same checkout again after compilation (concurrent edit: %s)",
    async (changed) => {
      const f = await fixture();
      const compile = vi.fn(
        async (context: CompilationContext, checkpoint: CompilationCheckpoint) => {
          expect(context.repositoryFiles).toEqual(["README.md", "sample.py"]);
          const objective = compileObjective({
            title: "Feature",
            baseSha: context.baseSha,
            repositoryFacts: { files: [], scripts: { test: "test" } },
            workItems: [
              {
                id: "feature",
                title: "Feature",
                goal: "Implement feature",
                acceptance: ["Feature returns a value"],
                scope: ["sample.py"],
                preconditions: [],
                outOfScope: [],
                conventions: [],
                dependsOn: [],
                baseSha: context.baseSha,
                validationCommands: ["npm test"],
                requirements: {
                  os: ["linux"],
                  architecture: [],
                  tools: ["npm"],
                  services: [],
                  networkDestinations: [],
                  permittedSecretNames: [],
                  trust: "trusted_local",
                },
                artifactContract: "clockgrove.factory/artifact-v1",
              },
            ],
          });
          const result = { objective, usage: { inputTokens: 10, outputTokens: 5 } };
          await checkpoint(result);
          if (changed) await writeFile(join(f.root, "sample.py"), "VALUE = 2\n");
          return result;
        },
      );
      const report = await buildPlanReport({
        repository: "o/r",
        request: { objective: 7, compile: true, baseSha: f.head },
        snapshot,
        planning: {
          repositoryPath: f.root,
          management: { id: "test", compile } as unknown as ManagementBackend,
          validateCheckout: validatePlanningCheckout,
          readRepositoryLayout: (max, base) => readPlanningRepositoryLayout(f.root, max, base),
        },
      });
      expect(report.compilation.result).toBe(changed ? "failed" : "completed");
      expect(report.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
      expect(report.activationAuthorized).toBe(false);
      expect(compile).toHaveBeenCalledTimes(1);
    },
  );
  it("proves origin/root/base and leaves Git index and configuration unchanged", async () => {
    const f = await fixture();
    const index = await readFile(join(f.root, ".git/index"));
    const config = await readFile(join(f.root, ".git/config"));
    expect(await inspectLocalCheckout(f.root, "o/r")).toMatchObject({
      head: f.head,
      repository: "o/r",
      files: ["README.md", "sample.py"],
    });
    await validatePlanningCheckout(f.root, f.head, "o/r");
    expect(await readPlanningRepositoryLayout(f.root, 5000, f.head)).toMatchObject({
      files: ["README.md", "sample.py"],
      truncated: false,
    });
    expect(await readFile(join(f.root, ".git/index"))).toEqual(index);
    expect(await readFile(join(f.root, ".git/config"))).toEqual(config);
    await expect(validatePlanningCheckout(f.root, "b".repeat(40), "o/r")).rejects.toThrow(
      /selected base/,
    );
    await f.git("remote", "set-url", "origin", "https://github.com/other/repo.git");
    await expect(validatePlanningCheckout(f.root, f.head, "o/r")).rejects.toThrow(/origin/);
  });
  it.each(["tracked", "staged", "untracked"])(
    "rejects %s changes without invoking a compiler",
    async (kind) => {
      const f = await fixture();
      await writeFile(join(f.root, kind === "untracked" ? "extra.py" : "sample.py"), "VALUE = 2\n");
      if (kind === "staged") await f.git("add", "sample.py");
      const compile = vi.fn();
      const report = await buildPlanReport({
        repository: "o/r",
        request: { objective: 7, compile: true, baseSha: f.head },
        snapshot,
        planning: {
          repositoryPath: f.root,
          management: { id: "test", compile } as unknown as ManagementBackend,
          validateCheckout: validatePlanningCheckout,
          readRepositoryLayout: (max, base) => readPlanningRepositoryLayout(f.root, max, base),
        },
      });
      expect(report.compilation.result).toBe("failed");
      expect(compile).not.toHaveBeenCalled();
    },
  );
  it("does not execute configured fsmonitor or clean filters during inspection", async () => {
    const f = await fixture();
    await writeFile(join(f.root, ".gitattributes"), "sample.py filter=trap\n");
    await f.git("add", ".gitattributes");
    await f.git("commit", "-m", "attributes");
    await f.git("config", "filter.trap.clean", "touch filter-ran");
    await f.git("config", "core.fsmonitor", "touch monitor-ran");
    await validatePlanningCheckout(f.root, await f.git("rev-parse", "HEAD"), "o/r");
    await expect(access(join(f.root, "filter-ran"))).rejects.toThrow();
    await expect(access(join(f.root, "monitor-ran"))).rejects.toThrow();
  });
  it("discovers Python validation tools without universal npm or systemctl requirements", async () => {
    const f = await fixture();
    const toolchain = await probeHostToolchain(f.root);
    expect(toolchain.validationCommands).toEqual(["python3 -m unittest discover"]);
    expect(Object.keys(toolchain.commands).sort()).toEqual(["git", "python3"]);
    expect(await probeHostResources()).toMatchObject({
      effectiveCpu: expect.any(Number),
      availableMemoryMb: expect.any(Number),
      source: expect.stringMatching(/^(host|cgroup-v[12])$/),
    });
  });
  it("does not report ready for a mismatched checkout, missing resource data, or insufficient cgroup headroom", async () => {
    const f = await fixture();
    const report = (checks: DoctorChecks) =>
      buildDoctorReport({
        repository: "o/r",
        objective: 7,
        checkout: f.root,
        readObjective: async () => snapshot,
        checks,
      });
    expect((await report(healthyChecks())).overall).toBe("ready");
    const forked = await report({
      ...healthyChecks(),
      repositoryFacts: async () => ({ ...(await healthyChecks().repositoryFacts!()), fork: true }),
    });
    expect(forked.overall).toBe("attention-required");
    const staleController = await report({
      ...healthyChecks(),
      controller: {
        status: async () => ({
          installed: true,
          enabled: true,
          active: true,
          launcherCurrent: false,
          healthy: false,
          reasonCode: "controller-launcher-stale",
          action: "run the idempotent controller install operation to refresh the launcher",
        }),
      } as unknown as NonNullable<DoctorChecks["controller"]>,
    });
    expect(staleController.diagnostics.find((entry) => entry.area === "controller")).toMatchObject({
      status: "warning",
      summary: expect.stringContaining("controller-launcher-stale"),
    });
    for (const resourceProbe of [
      async () => ({}),
      async () => ({ ...((await healthyChecks().resourceProbe!()) as object), effectiveCpu: 0.5 }),
      async () => ({
        ...((await healthyChecks().resourceProbe!()) as object),
        measuredAt: "2000-01-01T00:00:00Z",
      }),
    ]) {
      const failed = await report({ ...healthyChecks(), resourceProbe });
      expect(failed.overall).toBe("attention-required");
      expect(failed.diagnostics.find((entry) => entry.area === "resources")?.status).not.toBe(
        "pass",
      );
    }
    await f.git("remote", "set-url", "origin", "https://github.com/other/repo");
    const wrong = await report(healthyChecks());
    expect(wrong.diagnostics.find((entry) => entry.area === "repository")?.status).toBe("fail");
    expect(wrong.overall).toBe("attention-required");
  });
  it("labels editable issue digest claims unverified and never executes management while inspecting", async () => {
    const graph = compileObjective({
      title: "Feature",
      baseSha: "a".repeat(40),
      repositoryFacts: { files: [], scripts: { test: "test" } },
      workItems: [
        {
          id: "feature",
          title: "Feature",
          goal: "Implement feature",
          acceptance: ["Feature returns a value"],
          scope: ["src/a.ts"],
          preconditions: [],
          outOfScope: [],
          conventions: [],
          dependsOn: [],
          baseSha: "a".repeat(40),
          validationCommands: ["npm test"],
          requirements: {
            os: ["linux"],
            architecture: [],
            tools: ["npm"],
            services: [],
            networkDestinations: [],
            permittedSecretNames: [],
            trust: "trusted_local",
          },
          artifactContract: "clockgrove.factory/artifact-v1",
        },
      ],
    });
    const claimed = "b".repeat(64);
    const body = renderWorkPacket(graph.workItems[0]!, {
      protocol: "clockgrove.factory/graph-v1",
      id: "feature",
      graphDigest: claimed,
      graphSize: 1,
      index: 0,
      dependsOn: [],
    });
    const compile = vi.fn();
    const report = await buildPlanReport({
      repository: "o/r",
      request: { objective: 7 },
      snapshot: { ...snapshot, workItems: [{ number: 8, title: "Feature", body }] },
      planning: { management: { compile } as unknown as ManagementBackend },
    });
    expect(report.graph).toMatchObject({ claimedDigest: claimed, durableGraphVerified: false });
    expect(report.graph!.digest).not.toBe(claimed);
    expect(compiledGraphDigest(graph)).not.toBe(claimed);
    expect(report.diagnostics[0]!.status).toBe("warning");
    expect(compile).not.toHaveBeenCalled();
  });

  it("reconstructs every authenticated issue packet field for a current pnpm provider graph", async () => {
    const baseSha = "a".repeat(40);
    const runtime = managedRuntimeRequirements(["pnpm test"])[0]!;
    const common = {
      preconditions: [] as string[],
      outOfScope: [] as string[],
      conventions: ["Keep the change bounded."],
      baseSha,
      requirements: {
        os: ["linux"],
        architecture: [],
        tools: ["node", "pnpm"],
        services: [],
        networkDestinations: ["registry.npmjs.org"],
        permittedSecretNames: [],
        trust: "trusted_local" as const,
      },
      artifactContract: "clockgrove.factory/artifact-v1" as const,
      context: {
        mustRead: ["package.json"],
        searchSeeds: ["pnpm"],
        dependencyEvidence: [],
      },
      changeSurface: { mergeClass: "parallel-safe" as const, exclusiveResources: [] },
      managedRuntimes: [runtime],
    };
    const graph: CompiledObjective = {
      title: "Current pnpm graph",
      workItems: [
        {
          ...common,
          id: "provider",
          title: "Provide validation",
          goal: "Provide the pinned validation authority.",
          acceptance: ["The test authority is integrated."],
          criterionRisks: [{ criterion: "The test authority is integrated.", risk: "recovery" }],
          validation: [
            {
              tier: "mechanical",
              criteria: ["The test authority is integrated."],
              evidenceCommands: ["pnpm test"],
            },
          ],
          scope: ["package.json", "pnpm-lock.yaml"],
          dependsOn: [],
          validationCommands: ["pnpm test"],
          repositoryCapabilities: {
            provides: [
              {
                adapter: "node-pnpm",
                generation: "node-pnpm/provider",
                authorityPaths: ["package.json", "pnpm-lock.yaml"],
                operations: [{ kind: "package-script", key: "test" }],
                runtime,
              },
            ],
            requires: [
              {
                adapter: "node-pnpm",
                generation: "node-pnpm/provider",
                providerWorkItem: "provider",
                authorityPaths: ["package.json", "pnpm-lock.yaml"],
                operation: { kind: "package-script", key: "test" },
                activation: "artifact",
                runtime,
              },
            ],
          },
        },
        {
          ...common,
          id: "consumer",
          title: "Consume validation",
          goal: "Use the integrated validation authority.",
          acceptance: ["The check runs on the integrated base."],
          criterionRisks: [
            { criterion: "The check runs on the integrated base.", risk: "ordinary" },
          ],
          validation: [
            {
              tier: "semantic",
              criteria: ["The check runs on the integrated base."],
              evidenceCommands: ["pnpm check"],
            },
          ],
          scope: ["src/consumer.ts"],
          changeSurface: { mergeClass: "parallel-safe", exclusiveResources: [] },
          dependsOn: ["provider"],
          validationCommands: ["pnpm check"],
          repositoryCapabilities: {
            provides: [],
            requires: [
              {
                adapter: "node-pnpm",
                generation: "node-pnpm/provider",
                providerWorkItem: "provider",
                authorityPaths: ["package.json", "pnpm-lock.yaml"],
                operation: { kind: "package-script", key: "check" },
                activation: "integrated-base",
                runtime,
              },
            ],
          },
        },
      ],
    };
    graph.workItems[0]!.repositoryCapabilities!.provides[0]!.operations.push({
      kind: "package-script",
      key: "check",
    });
    validateGraph(graph);
    const digest = compiledGraphDigest(graph);
    const workItems = graph.workItems.map((item, index) => ({
      number: 8 + index,
      title: item.title,
      body: renderWorkPacket(item, {
        protocol: "clockgrove.factory/graph-v1" as const,
        id: item.id,
        graphDigest: digest,
        graphSize: graph.workItems.length,
        index,
        dependsOn: item.dependsOn,
      }),
    }));
    const report = await buildPlanReport({
      repository: "o/r",
      request: { objective: 7 },
      snapshot: { ...snapshot, title: graph.title, workItems },
    });
    expect(report.graph).toMatchObject({
      digest,
      claimedDigest: digest,
      workItemCount: 2,
    });
    expect(report.diagnostics[0]!.status).toBe("warning");
  });
});
