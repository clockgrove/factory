/** Credential-free qualification driver. Runs the real Supervisor, Git object
 * stores, scheduler, validation, review checkpoints and publication decisions.
 * GitHub transport and execution resources are simulations, never live evidence. */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import {
  FactorySupervisor,
  createRepositorySupervisorResources,
  type SupervisorOptions,
} from "../../src/supervisor.js";
import { GitHubReader } from "../../src/github.js";
import { GitHubControlStore } from "../../src/control/github-store.js";
import { CompiledGraphManager, type CompiledGraphStore } from "../../src/control/graphs.js";
import { LeaseManager, type GitCommitObject, type LeaseState } from "../../src/control/lease.js";
import { IssueAdmissionLedger } from "../../src/control/issue-admission.js";
import { decodeEventComments } from "../../src/control/receipts.js";
import {
  DEFAULT_RUN_POLICY,
  parseRunPolicy,
  policyDigest,
  type RunPolicy,
} from "../../src/protocol/policy.js";
import { parseFactoryEvent } from "../../src/protocol/events.js";
import { renderWorkPacket, type CompiledObjective } from "../../src/graph.js";
import { BackendRegistry } from "../../src/execution/registry.js";
import { normalizeArtifact } from "../../src/execution/artifacts.js";
import type {
  AttemptContext,
  BackendHandle,
  ExecutionBackend,
  ExecutionBackendCapabilities,
} from "../../src/execution/backend.js";
import type { ManagementBackend } from "../../src/management/backend.js";
import { validateArtifactClean, discardValidationResult } from "../../src/validation/clean-run.js";
import type { ObjectiveSnapshot, LinkedPullRequest } from "../../src/types.js";
import { GitHubStacks } from "../../src/publication/github-stacks.js";
import { PlatformUnavailableError } from "../../src/platform.js";
import { TOOLCHAIN_AUTHORITY_ADAPTERS } from "../../src/toolchains/authority.js";
import * as artifactTransfers from "../../src/control/artifact-transfers.js";
import { pnpmBootstrapLock } from "./pnpm-bootstrap.js";

export const LOCAL = "codex-sdk/local-worktree";
export const DAYTONA = "codex-cli/daytona";
export const COPILOT = "github-copilot/github-managed";
export const CODEX = "openai-codex/github-managed";
export type ProviderScenario = "daytona-burst" | "copilot-objective" | "codex-objective";
const pendingFixtureRetirements = new Set<object>();
const PNPM_RUNTIME_REQUIREMENT = TOOLCHAIN_AUTHORITY_ADAPTERS.find(({ id }) => id === "node-pnpm")!
  .runtimeRequirement!;
const BUN_RUNTIME_REQUIREMENT = TOOLCHAIN_AUTHORITY_ADAPTERS.find(
  ({ id }) => id === "javascript-bun",
)!.runtimeRequirement!;
const UV_RUNTIME_REQUIREMENT = TOOLCHAIN_AUTHORITY_ADAPTERS.find(({ id }) => id === "python-uv")!
  .runtimeRequirement!;
export interface ProviderFaults {
  compilerEvaluation?: RunPolicy["compilerEvaluation"];
  repositoryFence?: () => Promise<void>;
  configureLocalBackend?: (backend: ExecutionBackend) => ExecutionBackend;
  controllerActivation?: boolean;
  afterIntegration?: () => void;
  waitForSiblingLaunchBeforeIntegration?: boolean;
  holdSiblingDispatchUntilIntegrationFailure?: boolean;
  localOnly?: boolean;
  maxAttemptsPerItem?: number;
  noModelTokenBudget?: boolean;
  dependencyChain?: boolean;
  adaptiveLocal?: boolean;
  localMaxParallel?: 2;
  loseIntegrationReceipt?: "before" | "after";
  unavailable?: boolean;
  validationFailure?: boolean;
  cleanupFailure?: boolean;
  changedManagedHead?: boolean;
  localFinishesFirst?: boolean;
  candidateValidationFailure?: boolean;
  candidateCleanupFailure?: boolean;
  externalAdvance?: boolean;
  loseCandidateCheckpointResponse?: boolean;
  candidateReviewRejects?: boolean;
  sandboxUntrusted?: boolean;
  nativeStack?: boolean;
  nativeRebaseConflict?: boolean;
  nativeHeadChangeAfterValidation?: boolean;
  nativeAfterParentMerge?: () => void;
  nativeDuringRebaseValidation?: () => void;
  nativeRebaseReviewRejects?: boolean;
  nativeRebaseBudgetExhaustion?: boolean;
  greenfieldBootstrap?: boolean;
  greenfieldLifecycle?: boolean;
  pnpmUnavailable?: boolean;
  capabilityAdmission?: "valid" | "unsafe";
  capabilityAdapter?: "bun" | "uv";
  capabilityProviderLineageMismatch?: boolean;
  capabilityProviderLineageMismatchAfterReservation?: boolean;
  capabilityProviderReservationCommentMismatch?: boolean;
  capabilitySourceRefRace?: boolean;
  capabilitySourceRefRaceAfterReservation?: boolean;
  workflowArtifact?: "safe" | "unsafe";
  workflowPublicationCrash?: boolean;
  capabilityConsumerPublicationCrash?: boolean;
  workflowLiveBaseUnsafe?: boolean | "create" | "push";
  afterWorkflowCandidatePreparedSnapshot?: () => Promise<void>;
}

export async function providerSupervisorFixture(
  scenario: ProviderScenario,
  faults: ProviderFaults = {},
) {
  if (pendingFixtureRetirements.size > 0)
    throw new Error("previous provider Supervisor fixture retirement is still pending");
  vi.stubGlobal("fetch", async (input: unknown) => {
    return new Response(
      JSON.stringify({ message: `fixture forbids live transport: ${String(input)}` }),
      { status: 401, headers: { "content-type": "application/json" } },
    );
  });
  const repository = await mkdtemp(join(tmpdir(), "factory-provider-supervisor-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: repository,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  const rawGit = (args: string[], input?: string | Buffer) =>
    execFileSync("git", args, {
      cwd: repository,
      ...(input === undefined ? {} : { input }),
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Factory Fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("remote", "add", "origin", "https://github.com/fixture/provider-qualification.git");
  await writeFile(join(repository, "README.md"), "Disposable provider qualification fixture\n");
  if (faults.capabilityAdmission) {
    await mkdir(join(repository, "test"));
    await writeFile(join(repository, "test/check.js"), "// exact-base capability fixture\n");
    if (faults.capabilityAdapter === "uv") {
      await writeFile(
        join(repository, "pyproject.toml"),
        `[project]
name = "capability-admission-fixture"
requires-python = "==3.14.7"
dependencies = []

[tool.uv]
required-version = "==0.12.12"
package = false

[dependency-groups]
dev = ["pytest==8.4.2"]
`,
      );
      await writeFile(join(repository, ".python-version"), "3.14.7\n");
      await writeFile(
        join(repository, "uv.lock"),
        `version = 1
requires-python = "==3.14.7"

[[package]]
name = "pytest"
version = "8.4.2"
source = { registry = "https://pypi.org/simple" }
wheels = [
  { url = "https://files.pythonhosted.org/pytest.whl", hash = "sha256:${"a".repeat(64)}" },
]
`,
      );
    } else {
      await writeFile(
        join(repository, "package.json"),
        JSON.stringify({
          name: "capability-admission-fixture",
          version: "1.0.0",
          private: true,
          packageManager: faults.capabilityAdapter === "bun" ? "bun@1.3.10" : "pnpm@10.34.5",
          scripts:
            faults.capabilityAdapter === "bun"
              ? { test: "bun test", check: "bun test" }
              : {
                  test: "node --test test/check.js",
                  check: "node --test test/check.js",
                },
        }),
      );
      await writeFile(
        join(repository, faults.capabilityAdapter === "bun" ? "bun.lock" : "pnpm-lock.yaml"),
        faults.capabilityAdapter === "bun"
          ? `${JSON.stringify({
              lockfileVersion: 1,
              configVersion: 1,
              workspaces: { "": { name: "capability-admission-fixture" } },
              packages: {},
            })}\n`
          : "lockfileVersion: '9.0'\nimporters:\n  .: {}\n",
      );
    }
  }
  if (faults.compilerEvaluation)
    await writeFile(
      join(repository, "package.json"),
      JSON.stringify({ scripts: { test: "node --test" } }),
    );
  git("add", ".");
  git("commit", "-qm", "base");
  const baseSha = git("rev-parse", "HEAD");
  const managed = scenario !== "daytona-burst";
  const provider =
    scenario === "copilot-objective" ? COPILOT : scenario === "codex-objective" ? CODEX : DAYTONA;
  const policy = parseRunPolicy({
    ...DEFAULT_RUN_POLICY,
    ...(faults.compilerEvaluation ? { compilerEvaluation: faults.compilerEvaluation } : {}),
    ...(faults.sandboxUntrusted ? { trust: "sandbox_untrusted" } : {}),
    backendOrder: faults.localOnly ? [LOCAL] : managed ? [provider, DAYTONA] : [LOCAL, DAYTONA],
    maxParallel: faults.localOnly ? (faults.localMaxParallel ?? 1) : managed ? 1 : 2,
    maxAttemptsPerItem: faults.maxAttemptsPerItem ?? 1,
    workItemTimeoutMinutes: 2,
    objectiveTimeoutMinutes: 20,
    allowedNetworkDestinations:
      faults.capabilityAdapter === "uv"
        ? [...DEFAULT_RUN_POLICY.allowedNetworkDestinations, "pypi.org", "files.pythonhosted.org"]
        : DEFAULT_RUN_POLICY.allowedNetworkDestinations,
    allowedPaidBackends: faults.localOnly ? [] : managed ? [provider, DAYTONA] : [DAYTONA],
    cloudFallback: faults.localOnly ? "never" : "explicit",
    maxSandboxMinutes: 30,
    maxManagedAgentSessions: managed ? 3 : 0,
    ...(faults.noModelTokenBudget
      ? {}
      : {
          economics: {
            maxModelTokens: 10_000,
            modelTokenBudgetMode: "observed-stop",
            maxSandboxMinutes: 30,
            maxManagedSessions: managed ? 3 : 0,
            minCloudTimeSavedMinutes: 0,
          },
        }),
    capacity: {
      ...DEFAULT_RUN_POLICY.capacity,
      mode: faults.adaptiveLocal ? "adaptive-local" : "fixed",
      local: {
        ...DEFAULT_RUN_POLICY.capacity!.local,
        maxWorkers: faults.localOnly ? (faults.localMaxParallel ?? 1) : 1,
      },
    },
    burst: {
      ...DEFAULT_RUN_POLICY.burst,
      mode: faults.localOnly ? "never" : "saturation",
      backendOrder: faults.localOnly ? [] : [provider],
      maxCloudParallel: 2,
      queueDelaySeconds: 0,
      deadlineReserveMinutes: 1,
    },
    delivery: {
      mode: managed || faults.localOnly ? "regular-prs" : "stacked-prs",
      onUnavailable: "escalate",
      merge: "bottom-up",
    },
  });
  const pd = policyDigest(policy);
  const refs = new Map<string, string>();
  let workflowPublicationCrash = Boolean(faults.workflowPublicationCrash);
  let workflowCandidatePrepared = false;
  let workflowLiveBaseMutated = false;
  let capabilityProviderIntegrated = false;
  let capabilityConsumerReserved = false;
  let capabilitySourceRefReads = 0;
  let releaseSiblingLaunch!: () => void;
  const siblingLaunch = new Promise<void>((resolve) => {
    releaseSiblingLaunch = resolve;
  });
  const readCommit = async (oid: string): Promise<GitCommitObject> => {
    // One fresh immutable read, not three subprocesses per ledger observation.
    // Split only the metadata delimiters so the full message stays unchanged.
    const output = rawGit(["show", "-s", "--format=%T%x00%P%x00%B", oid]);
    const treeEnd = output.indexOf("\0");
    const parentsEnd = output.indexOf("\0", treeEnd + 1);
    if (treeEnd < 0 || parentsEnd < 0) throw new Error("malformed fixture Git commit");
    return {
      oid,
      treeOid: output.slice(0, treeEnd),
      parentOids: output
        .slice(treeEnd + 1, parentsEnd)
        .split(" ")
        .filter(Boolean),
      message: output.slice(parentsEnd + 1),
      serverTime: new Date(),
    };
  };
  const storage: CompiledGraphStore = {
    readRef: async (ref) => {
      let current = refs.get(ref) ?? (ref === "refs/heads/main" ? git("rev-parse", "main") : null);
      if (
        current &&
        ref === "refs/heads/main" &&
        faults.workflowLiveBaseUnsafe &&
        workflowCandidatePrepared &&
        !workflowLiveBaseMutated
      ) {
        workflowLiveBaseMutated = true;
        await mkdir(join(repository, ".github/workflows"), { recursive: true });
        const liveTrigger =
          faults.workflowLiveBaseUnsafe === "create"
            ? "create:"
            : faults.workflowLiveBaseUnsafe === "push"
              ? "push:"
              : "pull_request_target:";
        await writeFile(
          join(repository, ".github/workflows/ci.yml"),
          `name: Base CI\non:\n  ${liveTrigger}\npermissions:\n  contents: read\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: true\n`,
        );
        git("add", ".github/workflows/ci.yml");
        git("commit", "-qm", "simulate unsafe live workflow");
        current = git("rev-parse", "main");
      }
      if (
        current &&
        ref === "refs/heads/main" &&
        faults.capabilitySourceRefRace &&
        capabilityProviderIntegrated &&
        ++capabilitySourceRefReads === 2
      ) {
        const advanced = rawGit(
          ["commit-tree", git("rev-parse", `${current}^{tree}`), "-p", current],
          "simulated protected ref advance",
        ).trim();
        refs.set(ref, advanced);
      }
      return current;
    },
    readCommit,
    readBlob: async (oid) => Buffer.from(rawGit(["cat-file", "blob", oid])),
    readTreeEntry: async (oid, path) => git("ls-tree", oid, "--", path).split(/\s+/)[2] ?? null,
    createBlob: async (bytes) => {
      if (bytes.toString("utf8").startsWith("name: CI\non:\n")) {
        workflowCandidatePrepared = true;
      }
      if (workflowPublicationCrash && bytes.toString("utf8").startsWith("name: CI\non:\n")) {
        workflowPublicationCrash = false;
        throw new PlatformUnavailableError(
          { kind: "server_error", retryAfterMs: 1 },
          new Error("simulated publication transport outage before ref creation"),
        );
      }
      if (faults.capabilityConsumerPublicationCrash && bytes.toString("utf8") === "consumer\n") {
        faults.capabilityConsumerPublicationCrash = false;
        throw new PlatformUnavailableError(
          { kind: "server_error", retryAfterMs: 1 },
          new Error("simulated consumer publication transport outage before ref creation"),
        );
      }
      return rawGit(["hash-object", "-w", "--stdin"], bytes).trim();
    },
    createTree: async ({ baseTreeOid, entries }) => {
      const index = join(repository, "fixture-tree-index");
      const indexed = (args: string[]) =>
        execFileSync("git", args, {
          cwd: repository,
          env: { ...process.env, GIT_INDEX_FILE: index },
          encoding: "utf8",
        }).trim();
      indexed(baseTreeOid ? ["read-tree", baseTreeOid] : ["read-tree", "--empty"]);
      for (const entry of entries)
        indexed(
          entry.sha
            ? ["update-index", "--add", "--cacheinfo", `${entry.mode},${entry.sha},${entry.path}`]
            : ["update-index", "--force-remove", entry.path],
        );
      const oid = indexed(["write-tree"]);
      await rm(index, { force: true });
      return oid;
    },
    createCommit: async (input) =>
      rawGit(
        ["commit-tree", input.treeOid, ...input.parentOids.flatMap((oid) => ["-p", oid])],
        input.message,
      ).trim(),
    createRef: async (ref, oid) => {
      if (refs.has(ref)) return false;
      refs.set(ref, oid);
      if (faults.loseCandidateCheckpointResponse && ref.includes("/merge-candidates/")) {
        faults.loseCandidateCheckpointResponse = false;
        throw new Error("simulated checkpoint response loss after durable commit");
      }
      return true;
    },
  };
  const lease: LeaseState = {
    objective: 7,
    // Separate fixtures share the host user manager but are distinct durable runs.
    // A fixed ID can collide even when temporary checkout paths differ.
    runId: `provider-fixture-${randomUUID()}`,
    holder: "operator",
    policyDigest: pd,
    ref: "lease",
    oid: baseSha,
    treeOid: git("rev-parse", "HEAD^{tree}"),
    epoch: 1,
    sequence: 100,
    expiresAt: new Date(Date.now() + 600_000),
  };
  const bootstrapPaths = [
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "turbo.json",
    "packages/example/package.json",
  ];
  const ordinaryGraph: CompiledObjective = {
    title: "Provider multi-wave qualification",
    workItems: ["a", "b", "join"].map((id, index) => ({
      id,
      title: `Implement ${id}`,
      goal: `Create ${id}.txt containing ${id}`,
      acceptance: [`${id}.txt has the expected text`],
      scope: [`${id}.txt`],
      preconditions: [],
      outOfScope: [],
      conventions: [],
      dependsOn:
        index === 2
          ? ["a", "b"]
          : (faults.nativeStack || faults.dependencyChain) && index === 1
            ? ["a"]
            : [],
      baseSha,
      validationCommands: ["node --test"],
      requirements: {
        os: ["linux"],
        architecture: [],
        tools: ["node"],
        services: [],
        networkDestinations: [],
        permittedSecretNames: [],
        trust: managed
          ? "managed"
          : faults.nativeStack && index === 1
            ? "isolated"
            : "trusted_local",
        estimatedDurationMinutes: 1,
      },
      artifactContract: "clockgrove.factory/artifact-v1",
      delivery:
        faults.nativeStack && index === 1
          ? { group: "a", relationship: "continue-stack", parentWorkItem: "a" }
          : { group: id, relationship: index === 2 ? "join-after-merge" : "root" },
    })),
  };
  const capabilityAdapter =
    faults.capabilityAdapter === "bun"
      ? "javascript-bun"
      : faults.capabilityAdapter === "uv"
        ? "python-uv"
        : "node-pnpm";
  const capabilityRuntime =
    faults.capabilityAdapter === "bun"
      ? BUN_RUNTIME_REQUIREMENT
      : faults.capabilityAdapter === "uv"
        ? UV_RUNTIME_REQUIREMENT
        : PNPM_RUNTIME_REQUIREMENT;
  const capabilityAuthorityPaths =
    faults.capabilityAdapter === "uv"
      ? ["pyproject.toml", "uv.lock", ".python-version"]
      : ["package.json", faults.capabilityAdapter === "bun" ? "bun.lock" : "pnpm-lock.yaml"];
  const capabilityRunner = faults.capabilityAdapter ?? "pnpm";
  const capabilityTestCommand =
    faults.capabilityAdapter === "bun"
      ? "bun run test"
      : faults.capabilityAdapter === "uv"
        ? "uv run --locked --no-sync python -m pytest"
        : "pnpm test";
  const capabilityCheckCommand =
    faults.capabilityAdapter === "bun"
      ? "bun run check"
      : faults.capabilityAdapter === "uv"
        ? "uv run --locked --no-sync python -m pytest"
        : "pnpm check";
  const capabilityOperations =
    faults.capabilityAdapter === "uv"
      ? [{ kind: "python-test" as const, key: "." }]
      : [
          { kind: "package-script" as const, key: "check" },
          { kind: "package-script" as const, key: "test" },
        ];
  const capabilityGraph: CompiledObjective = {
    title: "Exact-base capability admission qualification",
    workItems: [
      {
        ...ordinaryGraph.workItems[0]!,
        id: "provider",
        title: "Integrate provider ancestry",
        goal: "Create provider.txt containing provider",
        acceptance: ["provider.txt has the expected text"],
        scope: ["provider.txt", ...capabilityAuthorityPaths, "test/"],
        validationCommands: [capabilityTestCommand],
        requirements: {
          ...ordinaryGraph.workItems[0]!.requirements!,
          tools: ["node", capabilityRunner],
          networkDestinations:
            faults.capabilityAdapter === "uv"
              ? ["pypi.org", "files.pythonhosted.org"]
              : ["registry.npmjs.org"],
        },
        managedRuntimes: [capabilityRuntime],
        dependsOn: [],
        delivery: { group: "provider", relationship: "root" },
        repositoryCapabilities: {
          provides: [
            {
              adapter: capabilityAdapter,
              generation: `${capabilityAdapter}/provider`,
              authorityPaths: capabilityAuthorityPaths,
              operations: capabilityOperations,
              runtime: capabilityRuntime,
            },
          ],
          requires: [
            {
              adapter: capabilityAdapter,
              generation: `${capabilityAdapter}/provider`,
              providerWorkItem: "provider",
              authorityPaths: capabilityAuthorityPaths,
              operation:
                faults.capabilityAdapter === "uv"
                  ? { kind: "python-test", key: "." }
                  : { kind: "package-script", key: "test" },
              activation: "artifact",
              runtime: capabilityRuntime,
            },
          ],
        },
      },
      {
        ...ordinaryGraph.workItems[1]!,
        id: "consumer",
        title: "Consume provider check",
        goal: "Create consumer.txt containing consumer",
        acceptance: ["consumer.txt has the expected text"],
        scope: ["consumer.txt"],
        validationCommands: [capabilityCheckCommand],
        requirements: {
          ...ordinaryGraph.workItems[1]!.requirements!,
          tools: ["node", capabilityRunner],
          networkDestinations:
            faults.capabilityAdapter === "uv"
              ? ["pypi.org", "files.pythonhosted.org"]
              : ["registry.npmjs.org"],
        },
        managedRuntimes: [capabilityRuntime],
        dependsOn: ["provider"],
        delivery: { group: "consumer", relationship: "sibling" },
        repositoryCapabilities: {
          provides: [],
          requires: [
            {
              adapter: capabilityAdapter,
              generation: `${capabilityAdapter}/provider`,
              providerWorkItem: "provider",
              authorityPaths: capabilityAuthorityPaths,
              operation:
                faults.capabilityAdapter === "uv"
                  ? { kind: "python-test", key: "." }
                  : { kind: "package-script", key: "check" },
              activation: "integrated-base",
              runtime: capabilityRuntime,
            },
          ],
        },
      },
      {
        ...ordinaryGraph.workItems[2]!,
        id: "independent",
        title: "Implement independent",
        goal: "Create independent.txt containing independent",
        acceptance: ["independent.txt has the expected text"],
        scope: ["independent.txt"],
        validationCommands: ["node --test"],
        dependsOn: faults.dependencyChain ? ["consumer"] : [],
        delivery: { group: "independent", relationship: "root" },
      },
    ],
  };
  const workflowGraph: CompiledObjective = {
    ...ordinaryGraph,
    title: "Workflow publication-boundary qualification",
    workItems: ordinaryGraph.workItems.map((item, index) =>
      index === 0
        ? {
            ...item,
            title: "Add bounded CI workflow",
            goal: "Add a bounded CI workflow",
            acceptance: ["The workflow validates the repository after protected-branch merge"],
            scope: [".github/workflows/ci.yml"],
          }
        : item,
    ),
  };
  const greenfieldRoot: CompiledObjective["workItems"][number] = {
    id: "bootstrap",
    title: "Bootstrap workspace",
    goal: "Create a pinned workspace and deterministic check",
    acceptance: ["the introduced workspace check passes"],
    scope: ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "turbo.json", "packages/"],
    preconditions: [],
    outOfScope: [],
    conventions: [],
    dependsOn: [],
    baseSha,
    validationCommands: ["pnpm check"],
    requirements: {
      os: ["linux"],
      architecture: [],
      tools: ["node", "pnpm"],
      services: [],
      networkDestinations: ["registry.npmjs.org"],
      permittedSecretNames: [],
      trust: "trusted_local",
      estimatedDurationMinutes: 1,
    },
    artifactContract: "clockgrove.factory/artifact-v1",
    managedRuntimes: [PNPM_RUNTIME_REQUIREMENT],
    delivery: { group: "bootstrap", relationship: "root" },
    ...(faults.greenfieldLifecycle
      ? {
          repositoryCapabilities: {
            provides: [
              {
                adapter: "node-pnpm",
                generation: "node-pnpm/bootstrap",
                authorityPaths: ["package.json", "pnpm-lock.yaml"],
                operations: [{ kind: "package-script", key: "check" }],
                runtime: PNPM_RUNTIME_REQUIREMENT,
              },
            ],
            requires: [
              {
                adapter: "node-pnpm",
                generation: "node-pnpm/bootstrap",
                providerWorkItem: "bootstrap",
                authorityPaths: ["package.json", "pnpm-lock.yaml"],
                operation: { kind: "package-script", key: "check" },
                activation: "artifact" as const,
                runtime: PNPM_RUNTIME_REQUIREMENT,
              },
            ],
          },
        }
      : {}),
  };
  const graph: CompiledObjective =
    faults.greenfieldBootstrap || faults.greenfieldLifecycle
      ? {
          title: "Greenfield bootstrap qualification",
          workItems: [
            greenfieldRoot,
            ...(faults.greenfieldLifecycle
              ? [
                  {
                    ...ordinaryGraph.workItems[1]!,
                    id: "consumer",
                    title: "Use integrated workspace check",
                    goal: "Create consumer.txt containing consumer",
                    acceptance: ["consumer.txt has the expected text"],
                    scope: ["consumer.txt"],
                    dependsOn: ["bootstrap"],
                    validationCommands: ["pnpm check"],
                    requirements: {
                      ...ordinaryGraph.workItems[1]!.requirements!,
                      tools: ["node", "pnpm"],
                      networkDestinations: ["registry.npmjs.org"],
                    },
                    delivery: { group: "consumer", relationship: "sibling" as const },
                    managedRuntimes: [PNPM_RUNTIME_REQUIREMENT],
                    repositoryCapabilities: {
                      provides: [],
                      requires: [
                        {
                          adapter: "node-pnpm",
                          generation: "node-pnpm/bootstrap",
                          providerWorkItem: "bootstrap",
                          authorityPaths: ["package.json", "pnpm-lock.yaml"],
                          operation: { kind: "package-script", key: "check" },
                          activation: "integrated-base" as const,
                          runtime: PNPM_RUNTIME_REQUIREMENT,
                        },
                      ],
                    },
                  },
                ]
              : []),
          ],
        }
      : faults.capabilityAdmission
        ? capabilityGraph
        : faults.workflowArtifact
          ? workflowGraph
          : ordinaryGraph;
  const leases = {
    assertCurrent: async () => undefined,
    assertMutationAuthorized: async () => undefined,
  } as unknown as LeaseManager;
  const graphManager = new CompiledGraphManager(storage, leases);
  const graphRecord = await graphManager.persist({
    lease,
    base: await readCommit(baseSha),
    objective: graph,
  });
  const projection = await graphManager.persistProjection({
    lease,
    graph: graphRecord,
    bindings: graph.workItems.map((item, index) => ({
      compilerId: item.id,
      issueNodeId: `I_${index + 8}`,
      issueNumber: index + 8,
    })),
  });
  let sequence = 1;
  const event = (fields: Record<string, unknown>) =>
    parseFactoryEvent({
      protocol: "clockgrove.factory/v2",
      objective: 7,
      runId: lease.runId,
      sequence: sequence++,
      at: new Date().toISOString(),
      ...fields,
    });
  const snapshot: ObjectiveSnapshot = {
    readAt: new Date(),
    workItemLabelId: "L_work_item",
    id: "I_7",
    number: 7,
    title: graph.title,
    body: "Disposable fixture",
    authorLogin: "operator",
    closed: false,
    repositoryId: "R_fixture",
    defaultBranch: "main",
    copilotBotId: null,
    ciExpectedOnPullRequests: false,
    factoryEvents: [
      event({
        kind: "run",
        event: "FactoryRunStarted",
        actor: "operator",
        repository: "fixture/provider-qualification",
        objectiveAuthor: "operator",
        fork: false,
        baseBranch: "main",
        baseSha,
        ...(faults.controllerActivation ? { activationRequestId: "fixture-activation" } : {}),
        policy,
        policyDigest: pd,
      }),
      event({
        kind: "delivery",
        event: "DeliverySelected",
        requested: managed || faults.localOnly ? "regular-prs" : "stacked-prs",
        selected: managed || faults.localOnly ? "regular-prs" : "native-stacks",
        capabilityVersion: "2026-03-10",
        reason: "Simulated transport capability",
      }),
      event({
        kind: "graph",
        event: "GraphCompiled",
        graphDigest: graphRecord.graphDigest,
        graphSize: graph.workItems.length,
        baseSha,
        graphRef: graphRecord.ref,
        graphBlobSha: graphRecord.blobOid,
      }),
      event({
        kind: "graph",
        event: "GraphProjected",
        graphDigest: graphRecord.graphDigest,
        graphSize: graph.workItems.length,
        projectionRef: projection.ref,
        projectionBlobSha: projection.blobOid,
      }),
    ],
    workItems: graph.workItems.map((item, index) => ({
      id: `I_${index + 8}`,
      number: index + 8,
      title: item.title,
      body: renderWorkPacket(item, {
        protocol: "clockgrove.factory/graph-v1",
        id: item.id,
        graphDigest: graphRecord.graphDigest,
        graphSize: graph.workItems.length,
        index,
        dependsOn: item.dependsOn,
      }),
      closed: false,
      assignees: [],
      labels: [],
      blockedBy: item.dependsOn.map((id) => ({
        number: 8 + graph.workItems.findIndex((item) => item.id === id),
        closed: false,
      })),
      linkedPullRequests: [],
      copilotAssignments: [],
      factoryEvents: [],
    })),
  };
  const events = () =>
    [...snapshot.factoryEvents!, ...snapshot.workItems.flatMap((item) => item.factoryEvents!)].sort(
      (a, b) => a.sequence - b.sequence,
    );
  for (const name of Object.keys(storage) as Array<keyof CompiledGraphStore>)
    vi.spyOn(GitHubControlStore.prototype, name).mockImplementation(storage[name] as never);
  // Transport methods are fixture-owned below, so preserve the production
  // ordering contract explicitly: policy runs after dispatch admission and
  // immediately before the mocked visible effect.
  vi.spyOn(GitHubControlStore.prototype, "withPublicationSafetyFence").mockImplementation(
    async (fence, operation) => {
      await fence();
      return operation();
    },
  );
  vi.spyOn(GitHubControlStore.prototype, "listRefs").mockImplementation(async (prefix) =>
    [...refs].filter(([ref]) => ref.startsWith(prefix)).map(([ref, oid]) => ({ ref, oid })),
  );
  vi.spyOn(GitHubControlStore.prototype, "serverTime").mockImplementation(async () => new Date());
  vi.spyOn(GitHubControlStore.prototype, "getRepositoryFacts").mockResolvedValue({
    fullName: "fixture/provider-qualification",
    fork: false,
    private: true,
    defaultBranch: "main",
    canPush: true,
  });
  vi.spyOn(GitHubControlStore.prototype, "getAuthenticatedLogin").mockResolvedValue("operator");
  vi.spyOn(GitHubControlStore.prototype, "readRepositoryPermission").mockResolvedValue("write");
  vi.spyOn(GitHubControlStore.prototype, "readBranchRules").mockResolvedValue([]);
  // This fixture owns one Objective; external commits have no authenticated
  // co-owned peer provenance. Do not fall through to the blocked live transport.
  vi.spyOn(GitHubControlStore.prototype, "readCommitObjectiveCandidates").mockResolvedValue([]);
  vi.spyOn(GitHubControlStore.prototype, "readChecks").mockResolvedValue({
    pending: [],
    failed: [],
    observed: [],
    observedChecks: [],
  });
  vi.spyOn(GitHubControlStore.prototype, "getBranchHead").mockImplementation(async (branch) =>
    readCommit(refs.get(`refs/heads/${branch}`) ?? git("rev-parse", branch)),
  );
  let receiptTransportUnavailable = false;
  let releaseSiblingDispatchWaiting!: () => void;
  const siblingDispatchWaiting = new Promise<void>((resolve) => {
    releaseSiblingDispatchWaiting = resolve;
  });
  let releaseIntegrationFailure!: (error: PlatformUnavailableError) => void;
  const integrationFailure = new Promise<PlatformUnavailableError>((resolve) => {
    releaseIntegrationFailure = resolve;
  });
  let releaseSiblingDispatchFailureObserved!: () => void;
  const siblingDispatchFailureObserved = new Promise<void>((resolve) => {
    releaseSiblingDispatchFailureObserved = resolve;
  });
  if (faults.holdSiblingDispatchUntilIntegrationFailure) {
    const transitionIssueAdmission = IssueAdmissionLedger.prototype.transition;
    vi.spyOn(IssueAdmissionLedger.prototype, "transition").mockImplementation(async function (
      this: IssueAdmissionLedger,
      args,
    ) {
      if (
        faults.holdSiblingDispatchUntilIntegrationFailure &&
        args.workItem === 9 &&
        args.disposition === "dispatching"
      ) {
        releaseSiblingDispatchWaiting();
        const error = await integrationFailure;
        faults.holdSiblingDispatchUntilIntegrationFailure = false;
        releaseSiblingDispatchFailureObserved();
        throw error;
      }
      return transitionIssueAdmission.call(this, args);
    });
  }
  const retainedArtifactRoots = new Set<string>();
  vi.spyOn(GitHubControlStore.prototype, "addIssueComment").mockImplementation(
    async (node, body) => {
      const receipt = decodeEventComments(body);
      const integration = receipt.some((event) => event.event === "AttemptIntegrated");
      const loss = integration ? faults.loseIntegrationReceipt : undefined;
      if (loss) delete faults.loseIntegrationReceipt;
      const unavailable = () =>
        new PlatformUnavailableError(
          { kind: "server_error", retryAfterMs: 1 },
          new Error("simulated integration receipt transport outage"),
        );
      const lossError = loss ? unavailable() : undefined;
      const synchronizeSibling = Boolean(loss && faults.holdSiblingDispatchUntilIntegrationFailure);
      if (synchronizeSibling) await siblingDispatchWaiting;
      if (lossError) {
        receiptTransportUnavailable = true;
        releaseIntegrationFailure(lossError);
        if (synchronizeSibling) await siblingDispatchFailureObserved;
      }
      if (receiptTransportUnavailable && loss !== "after") throw lossError ?? unavailable();
      const target =
        node === snapshot.id ? snapshot : snapshot.workItems.find((item) => item.id === node)!;
      const recordedReceipt = receipt.map((event) =>
        faults.capabilityProviderReservationCommentMismatch &&
        event.kind === "attempt" &&
        event.event === "AttemptReserved" &&
        event.workItem === 8
          ? parseFactoryEvent({ ...event, reason: "forged mutable reservation comment" })
          : event,
      );
      target.factoryEvents!.push(...recordedReceipt);
      if (
        receipt.some(
          (event) =>
            event.kind === "attempt" && event.event === "AttemptIntegrated" && event.workItem === 8,
        )
      )
        capabilityProviderIntegrated = true;
      // Fault tests can remove receipts later; retain only the cleanup identity,
      // derived from reservations this fixture itself successfully recorded.
      for (const event of receipt) {
        if (
          event.kind !== "attempt" ||
          event.event !== "AttemptReserved" ||
          event.runId !== lease.runId
        )
          continue;
        const digest = artifactTransfers
          .artifactTransferRef({
            repository: "fixture/provider-qualification",
            objective: event.objective,
            workItem: event.workItem,
            attempt: event.attempt,
            runId: event.runId,
            directorEpoch: event.directorEpoch,
            policyDigest: event.policyDigest,
            baseSha: event.baseSha,
          })
          .split("/")
          .at(-1)!;
        retainedArtifactRoots.add(
          join(tmpdir(), `factory-collected-${process.getuid?.() ?? "unknown"}-${digest}`),
        );
        if (event.workItem === 9) {
          capabilityConsumerReserved = true;
          if (faults.capabilitySourceRefRaceAfterReservation) {
            const ref = "refs/heads/main";
            const current = refs.get(ref) ?? git("rev-parse", "main");
            const advanced = rawGit(
              ["commit-tree", git("rev-parse", `${current}^{tree}`), "-p", current],
              "simulated protected ref advance after reservation",
            ).trim();
            refs.set(ref, advanced);
          }
        }
      }
      if (loss === "after") throw unavailable();
      if (integration) faults.afterIntegration?.();
    },
  );
  vi.spyOn(GitHubControlStore.prototype, "closeIssue").mockImplementation(async (number) => {
    (number === 7 ? snapshot : snapshot.workItems.find((item) => item.number === number)!).closed =
      true;
    for (const item of snapshot.workItems)
      for (const dep of item.blockedBy) if (dep.number === number) dep.closed = true;
  });
  vi.spyOn(GitHubControlStore.prototype, "assignIssue").mockResolvedValue(undefined);
  let reads = 0;
  const notifications: string[] = [];
  vi.spyOn(GitHubReader.prototype, "readObjective").mockImplementation(async () => {
    if (++reads > 500)
      throw new Error(
        `bounded fixture snapshot budget exhausted: ${notifications.slice(-4).join("; ")}`,
      );
    snapshot.readAt = new Date();
    if (workflowCandidatePrepared) await faults.afterWorkflowCandidatePreparedSnapshot?.();
    return structuredClone(snapshot);
  });
  vi.spyOn(GitHubReader.prototype, "readWorkflowSafetyProfile").mockResolvedValue({
    defaultWorkflowPermissions: "read",
    referencedSecrets: [],
  });
  vi.spyOn(GitHubReader.prototype, "resolveUserId").mockResolvedValue("U_operator");
  vi.spyOn(GitHubReader.prototype, "readRunCancellationRequest").mockResolvedValue(null);
  vi.spyOn(LeaseManager.prototype, "read").mockResolvedValue(null);
  let leaseGeneration = 0;
  vi.spyOn(LeaseManager.prototype, "acquire").mockImplementation(async (identity) => ({
    ...lease,
    ...identity,
    // Every acquisition gets a new holder, including foreground restart. Model
    // the real lease's increasing epoch instead of lending epoch 1 to new owners.
    epoch: ++leaseGeneration,
  }));
  vi.spyOn(LeaseManager.prototype, "assertCurrent").mockResolvedValue(undefined);
  // This fixture replaces transport writes, so model the dispatch-time authority
  // check that the real GitHub transport performs after queueing.
  vi.spyOn(LeaseManager.prototype, "assertMutationAuthorized").mockImplementation(function (
    this: LeaseManager,
    lease,
  ) {
    return this.assertCurrent(lease);
  });
  vi.spyOn(LeaseManager.prototype, "assertGeneration").mockResolvedValue(undefined);
  vi.spyOn(LeaseManager.prototype, "release").mockImplementation(async (value) => value);
  const pulls = new Map<
    number,
    { pull: LinkedPullRequest; branch: string; base: string; baseRef: string; merged?: string }
  >();
  vi.spyOn(GitHubControlStore.prototype, "compareAndSwapRef").mockImplementation(
    async ({ ref, beforeOid, afterOid }) => {
      if (refs.get(ref) !== beforeOid) return false;
      if (
        ref.startsWith("refs/clockgrove-factory/integration-admissions/") ||
        ref.startsWith("refs/clockgrove-factory/admission/")
      ) {
        const commit = await readCommit(afterOid);
        if (
          commit.parentOids[0] !== beforeOid ||
          (ref.startsWith("refs/clockgrove-factory/integration-admissions/") &&
            commit.parentOids.length !== 1)
        )
          throw new Error("fixture control CAS must extend its exact observed OID");
        refs.set(ref, afterOid);
        return true;
      }
      const owned = [...pulls.values()].find((value) => `refs/heads/${value.branch}` === ref);
      if (!owned || owned.merged || owned.pull.state !== "OPEN" || owned.pull.headSha !== beforeOid)
        throw new Error("fixture refresh must bind an exact open Factory publication");
      const commit = await readCommit(afterOid);
      if (
        commit.parentOids.length !== 2 ||
        commit.parentOids[0] !== beforeOid ||
        commit.parentOids[1] !== git("rev-parse", "main")
      )
        throw new Error("fixture refresh must be an exact two-parent fast-forward");
      refs.set(ref, afterOid);
      owned.pull.headSha = afterOid;
      return true;
    },
  );
  const createPull = async (workItem: number, head: string, branch: string, baseRef = "main") => {
    const number = 100 + workItem;
    const item = snapshot.workItems.find((item) => item.number === workItem)!;
    const pull: LinkedPullRequest = {
      id: `PR_${number}`,
      number,
      state: "OPEN",
      isDraft: false,
      title: item.title,
      body: "",
      changedLines: 1,
      changedFiles: 1,
      changedFilePaths:
        (faults.greenfieldBootstrap || faults.greenfieldLifecycle) && workItem === 8
          ? bootstrapPaths
          : faults.workflowArtifact && workItem === 8
            ? [".github/workflows/ci.yml"]
            : [`${graph.workItems[workItem - 8]!.id}.txt`],
      commitSubjects: [item.title],
      checks: null,
      mergeable: "MERGEABLE",
      createdAt: new Date(Date.now() - 120_000),
      headSha: head,
      headCommittedAt: new Date(),
      mergedAt: null,
      closedAt: null,
      agentWorkEvents: [],
    };
    pulls.set(number, {
      pull,
      branch,
      base: refs.get(`refs/heads/${baseRef}`) ?? git("rev-parse", baseRef),
      baseRef,
    });
    item.linkedPullRequests.push(pull);
    return {
      number,
      htmlUrl: `https://github.com/fixture/provider-qualification/pull/${number}`,
      headSha: head,
    };
  };
  vi.spyOn(GitHubControlStore.prototype, "findPullRequestForBranch").mockImplementation(
    async (branch) => {
      const found = [...pulls.values()].find((value) => value.branch === branch);
      return found
        ? {
            number: found.pull.number,
            htmlUrl: `https://github.com/fixture/provider-qualification/pull/${found.pull.number}`,
            state: found.merged ? "closed" : "open",
            merged: Boolean(found.merged),
            headSha: found.pull.headSha,
          }
        : null;
    },
  );
  vi.spyOn(GitHubControlStore.prototype, "createPullRequest").mockImplementation(async (input) => {
    const workItem = Number(/work-item-(\d+)/.exec(input.head)?.[1]);
    const head = refs.get(`refs/heads/${input.head}`);
    if (!head) throw new Error("missing publication branch");
    return createPull(workItem, head, input.head, input.base);
  });
  vi.spyOn(GitHubControlStore.prototype, "readPullRequest").mockImplementation(async (number) => {
    const value = pulls.get(number)!;
    const currentBase = refs.get(`refs/heads/${value.baseRef}`) ?? git("rev-parse", value.baseRef);
    const observedBase = value.merged
      ? (await readCommit(value.merged)).parentOids[0]!
      : currentBase;
    const tree = git("merge-tree", "--write-tree", currentBase, value.pull.headSha).split("\n")[0]!;
    const preview = rawGit(
      ["commit-tree", tree, "-p", currentBase, "-p", value.pull.headSha],
      "simulated GitHub test merge",
    ).trim();
    return {
      state: value.merged ? "closed" : "open",
      number,
      nodeId: value.pull.id,
      headRef: value.branch,
      headRepository: "fixture/provider-qualification",
      baseRepository: "fixture/provider-qualification",
      merged: Boolean(value.merged),
      mergeable: true,
      mergeableState: "clean",
      draft: false,
      headSha:
        (faults.capabilityProviderLineageMismatch ||
          (faults.capabilityProviderLineageMismatchAfterReservation &&
            capabilityConsumerReserved)) &&
        capabilityProviderIntegrated &&
        number === 108 &&
        value.merged
          ? "a".repeat(40)
          : value.pull.headSha,
      baseSha: observedBase,
      baseRef: value.baseRef,
      mergeCommitSha: value.merged ?? preview,
      createdAt: value.pull.createdAt,
    };
  });
  vi.spyOn(GitHubControlStore.prototype, "closePullRequest").mockImplementation(async (number) => {
    pulls.get(number)!.pull.state = "CLOSED";
  });
  const mergePull = vi
    .spyOn(GitHubControlStore.prototype, "mergePullRequest")
    .mockImplementation(async ({ number, headSha }) => {
      if (faults.waitForSiblingLaunchBeforeIntegration && number === 108) {
        await siblingLaunch;
      }
      git("merge", "--squash", headSha);
      git("commit", "-qm", `integrate ${number}`);
      const value = pulls.get(number)!;
      value.merged = git("rev-parse", "HEAD");
      value.pull.state = "MERGED";
      if (faults.nativeStack) {
        for (const child of pulls.values()) {
          if (child.merged || child.baseRef !== value.branch) continue;
          const oldHead = child.pull.headSha;
          const newHead = faults.nativeRebaseConflict
            ? oldHead
            : rawGit(
                ["commit-tree", git("rev-parse", `${oldHead}^{tree}`), "-p", value.merged],
                "simulated GitHub cascading rebase",
              ).trim();
          child.pull.headSha = newHead;
          child.baseRef = "main";
          child.base = value.merged;
          refs.set(`refs/heads/${child.branch}`, newHead);
        }
        if (number === 108) {
          if (faults.nativeRebaseBudgetExhaustion) {
            // Supply distinct, completed provider usage before the separately
            // admitted rebase validator; never rewrite an existing receipt.
            const usage = events().find(
              (entry) =>
                entry.kind === "budget" &&
                entry.event === "BudgetReconciled" &&
                entry.workItem === 9 &&
                entry.unit === "sandbox_milliseconds",
            );
            if (!usage || usage.kind !== "budget") throw new Error("missing child sandbox usage");
            const priorSequence = Math.max(...events().map((entry) => entry.sequence));
            for (const [index, event] of ["BudgetReserved", "BudgetReconciled"].entries())
              snapshot.workItems[1]!.factoryEvents!.push(
                parseFactoryEvent({
                  ...usage,
                  event,
                  writerOperationId: `fixture-completed-prior-validation-${index}`,
                  usageId: "fixture-completed-prior-validation",
                  phase: "validation",
                  amount: policy.maxSandboxMinutes * 60_000,
                  sequence: priorSequence + index + 1,
                  at: new Date().toISOString(),
                }),
              );
          }
          faults.nativeAfterParentMerge?.();
        }
      }
      if (faults.externalAdvance) {
        faults.externalAdvance = false;
        await writeFile(join(repository, "external.txt"), "unrelated external actor\n");
        git("add", "external.txt");
        git("commit", "-qm", "external advance");
      }
      return value.merged;
    });
  if (faults.nativeStack) {
    const stack = () => ({
      number: 1,
      baseRef: "main",
      open: [...pulls.values()].some((value) => !value.merged),
      pullRequests: [...pulls.values()]
        .filter((value) => value.pull.number < 110)
        .map((value) => ({
          number: value.pull.number,
          state: value.merged ? "closed" : "open",
          draft: false,
          mergedAt: value.merged ? new Date().toISOString() : null,
          headRef: value.branch,
          headSha: value.pull.headSha,
          baseRef: value.baseRef,
          baseSha: value.base,
        })),
    });
    vi.spyOn(GitHubStacks.prototype, "ensureStack").mockImplementation(async () => stack());
    vi.spyOn(GitHubStacks.prototype, "get").mockImplementation(async () => stack());
    vi.spyOn(GitHubStacks.prototype, "requestMerge").mockImplementation(async (input) => ({
      state: "merged",
      mergeSha: await mergePull({
        number: input.pullRequest,
        headSha: input.expectedHeadSha,
        commitTitle: input.title,
      }),
    }));
  }
  const activity: Array<{
    operation: string;
    backend: string;
    workItem: number;
    invocation?: string;
  }> = [];
  const resources = new Set<string>();
  const execution = (id: string): ExecutionBackend => {
    const remote = id !== LOCAL;
    const providerManaged = [COPILOT, CODEX].includes(id);
    const capabilities: ExecutionBackendCapabilities = {
      id,
      agentKind: providerManaged ? "managed-fixture" : "codex",
      runtimeKind: remote ? "provider-fixture" : "local",
      hostExecution: !remote,
      isolation: providerManaged ? "managed" : remote ? "container" : "process",
      supportedOs: ["linux"],
      supportedArchitectures: ["x64", "arm64"],
      supportedTools:
        !faults.pnpmUnavailable &&
        (faults.greenfieldBootstrap || faults.greenfieldLifecycle || faults.capabilityAdmission)
          ? ["node", faults.capabilityAdapter ?? "pnpm"]
          : ["node"],
      supportedServices: [],
      supportsCancellation: true,
      supportsObservation: true,
      supportsResume: false,
      supportsLocalInference: false,
      reportsModelUsage: !remote,
      requiresPaidRuntime: remote,
      providerManagedPublication: providerManaged,
      requiredCredentials: [],
    };
    const running = new Map<string, AttemptContext>();
    return {
      capabilities,
      probe: async () => ({
        available: !(faults.unavailable && remote),
        authenticated: !(faults.unavailable && remote),
        measuredAt: new Date().toISOString(),
      }),
      probeValidation: async () => ({
        available: !(faults.unavailable && remote),
        authenticated: true,
        measuredAt: new Date().toISOString(),
      }),
      launch: async (input) => {
        activity.push({ operation: "launch", backend: id, workItem: input.workItem });
        if (input.workItem === 9) releaseSiblingLaunch();
        const resourceId = `${id}:${input.workItem}`;
        resources.add(resourceId);
        running.set(resourceId, input);
        const name = graph.workItems[input.workItem - 8]!.id;
        if ((faults.greenfieldBootstrap || faults.greenfieldLifecycle) && input.workItem === 8) {
          await mkdir(join(input.workspace, "packages", "example"), { recursive: true });
          await writeFile(
            join(input.workspace, "package.json"),
            JSON.stringify({
              name: "greenfield",
              private: true,
              packageManager: "pnpm@10.34.5",
              scripts: { check: "turbo run check" },
              devDependencies: { turbo: "2.5.6", typescript: "5.9.2" },
            }),
          );
          await writeFile(
            join(input.workspace, "pnpm-lock.yaml"),
            pnpmBootstrapLock([".", "packages/example"], ["turbo@2.5.6", "typescript@5.9.2"]),
          );
          await writeFile(
            join(input.workspace, "pnpm-workspace.yaml"),
            "packages:\n  - packages/*\n",
          );
          await writeFile(
            join(input.workspace, "turbo.json"),
            '{"tasks":{"check":{"dependsOn":["^check"]}}}\n',
          );
          await writeFile(
            join(input.workspace, "packages", "example", "package.json"),
            JSON.stringify({ name: "example", scripts: { check: "tsc --noEmit" } }),
          );
          execFileSync("git", ["add", ...bootstrapPaths], { cwd: input.workspace });
        } else if (faults.workflowArtifact && input.workItem === 8) {
          await mkdir(join(input.workspace, ".github", "workflows"), { recursive: true });
          await writeFile(
            join(input.workspace, ".github", "workflows", "ci.yml"),
            `name: CI
on:
  ${faults.workflowArtifact === "safe" ? "push:\n    branches:\n      - main" : "pull_request:"}
permissions:
  contents: read
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@0123456789012345678901234567890123456789
        with:
          persist-credentials: false
      - run: node --test
`,
          );
          execFileSync("git", ["add", ".github/workflows/ci.yml"], { cwd: input.workspace });
        } else {
          await writeFile(join(input.workspace, `${name}.txt`), `${name}\n`);
          execFileSync("git", ["add", `${name}.txt`], { cwd: input.workspace });
        }
        const handle: BackendHandle = {
          backendId: id,
          resourceId,
          startedAt: new Date().toISOString(),
        };
        if (providerManaged) {
          const tree = execFileSync("git", ["write-tree"], {
            cwd: input.workspace,
            encoding: "utf8",
          }).trim();
          const head = execFileSync(
            "git",
            [
              "-c",
              "user.name=Factory Fixture",
              "-c",
              "user.email=fixture@example.invalid",
              "commit-tree",
              tree,
              "-p",
              input.packet.baseSha,
            ],
            {
              cwd: input.workspace,
              input: "provider fixture result",
              encoding: "utf8",
            },
          ).trim();
          // Worker materializations have isolated object stores. Import the exact
          // produced commit into the simulated provider store before publishing.
          git("fetch", "--no-tags", "--no-write-fetch-head", input.workspace, head);
          const pull = await createPull(input.workItem, head, `provider/${input.workItem}`);
          handle.metadata = {
            pullNumber: String(pull.number),
            headSha: faults.changedManagedHead ? baseSha : head,
          };
        }
        return handle;
      },
      observe: async (handle) => ({
        state:
          !managed &&
          !faults.localOnly &&
          !faults.nativeStack &&
          ((running.get(handle.resourceId)!.workItem < 10 &&
            !activity.some(
              (entry) =>
                entry.operation === "launch" &&
                entry.workItem === (running.get(handle.resourceId)!.workItem === 8 ? 9 : 8),
            )) ||
            ((faults.localFinishesFirst ? id === DAYTONA : id === LOCAL) &&
              running.get(handle.resourceId)!.workItem === (faults.localFinishesFirst ? 9 : 8) &&
              !snapshot.workItems[faults.localFinishesFirst ? 0 : 1]!.closed))
            ? "running"
            : "succeeded",
        observedAt: new Date().toISOString(),
        ...(!remote ? { usage: { inputTokens: 4, outputTokens: 2, cachedInputTokens: 0 } } : {}),
      }),
      collect: async (handle) => {
        const input = running.get(handle.resourceId)!;
        const patch = execFileSync("git", ["diff", input.packet.baseSha, "--"], {
          cwd: input.workspace,
          encoding: "utf8",
        });
        return normalizeArtifact({
          baseSha: input.packet.baseSha,
          patch,
          changedPaths:
            (faults.greenfieldBootstrap || faults.greenfieldLifecycle) && input.workItem === 8
              ? bootstrapPaths
              : faults.workflowArtifact && input.workItem === 8
                ? [".github/workflows/ci.yml"]
                : [`${graph.workItems[input.workItem - 8]!.id}.txt`],
          commands: [],
          logs: "Simulated provider result",
          outcome: "succeeded",
        });
      },
      cancel: async (handle) => {
        activity.push({
          operation: "cancel",
          backend: id,
          workItem: running.get(handle.resourceId)!.workItem,
        });
        resources.delete(handle.resourceId);
      },
      cleanup: async (handle) => {
        activity.push({
          operation: "cleanup",
          backend: id,
          workItem: running.get(handle.resourceId)!.workItem,
        });
        if (faults.cleanupFailure && remote)
          throw new Error("simulated resource cleanup unavailable");
        resources.delete(handle.resourceId);
      },
      reconcileStale: async () => {
        if (faults.cleanupFailure && remote)
          throw new Error("simulated resource may still be active");
      },
      ...(id === DAYTONA
        ? {
            validate: async (input: Parameters<NonNullable<ExecutionBackend["validate"]>>[0]) => {
              activity.push({
                operation: "validate",
                backend: id,
                workItem: input.workItem,
                ...(input.validationInvocation
                  ? { invocation: input.validationInvocation.identityDigest }
                  : {}),
              });
              const candidate = Boolean(input.validationInvocation);
              if (faults.nativeStack && candidate) faults.nativeDuringRebaseValidation?.();
              const failed =
                faults.validationFailure || (candidate && faults.candidateValidationFailure);
              const name = `validator:${input.workItem}:${input.validationInvocation?.identityDigest ?? "initial"}`;
              resources.add(name);
              const result = await validateArtifactClean({
                repository,
                artifact: input.artifact,
                packet: {
                  ...input.packet,
                  requirements: { ...input.packet.requirements, trust: "trusted_local" },
                },
              });
              try {
                if (faults.nativeStack && candidate && faults.nativeHeadChangeAfterValidation) {
                  const child = pulls.get(109)!;
                  const changed = rawGit(
                    ["commit-tree", result.evidence.outputTreeSha, "-p", input.packet.baseSha],
                    "external head replacement during native validation",
                  ).trim();
                  child.pull.headSha = changed;
                  refs.set(`refs/heads/${child.branch}`, changed);
                }
                return {
                  outputTreeSha: result.evidence.outputTreeSha,
                  commands: result.evidence.commands,
                  passed: !failed && result.evidence.passed,
                  startedAt: result.evidence.startedAt,
                  completedAt: result.evidence.completedAt,
                  environmentIdentity: `docker.io/library/node@sha256:${"a".repeat(64)}`,
                  ...(failed ? { failureReason: "simulated isolated validation failure" } : {}),
                };
              } finally {
                await discardValidationResult(result);
                if (candidate && faults.candidateCleanupFailure)
                  // biome-ignore lint/correctness/noUnsafeFinally: simulated cleanup uncertainty overrides success, matching the provider contract
                  throw new Error(
                    "simulated candidate resource may still be active; automated replacement is blocked",
                  );
                resources.delete(name);
              }
            },
          }
        : {}),
    };
  };
  const registry = new BackendRegistry();
  const local = execution(LOCAL);
  registry.register(faults.configureLocalBackend?.(local) ?? local);
  registry.register(execution(DAYTONA));
  if (managed) registry.register(execution(provider));
  const management: ManagementBackend = {
    id: policy.managementBackend,
    probe: async () => ({ available: true, authenticated: true }),
    compile: async () => {
      throw new Error("already compiled immutable fixture");
    },
    review: async (context, checkpoint) => {
      const candidate = context.workItemNumber < 10 && context.packet.baseSha !== baseSha;
      const nativeRebase =
        faults.nativeStack && context.workItemNumber === 9 && Boolean(pulls.get(108)?.merged);
      activity.push({
        operation: nativeRebase ? "rebase-review" : candidate ? "candidate-review" : "review",
        backend: "fixture-management",
        workItem: context.workItemNumber,
      });
      const result = {
        review: {
          accepted:
            !(candidate && faults.candidateReviewRejects) &&
            !(nativeRebase && faults.nativeRebaseReviewRejects),
          summary: "Fixture semantic acceptance",
          unmetCriteria: [],
          risks: [],
        },
        usage: { inputTokens: 4, outputTokens: 2 },
      };
      await checkpoint(result);
      return result;
    },
  };
  const shared = createRepositorySupervisorResources(undefined, {
    maxLocalWorkers: 1,
    maxPaidWorkers: 2,
  });
  shared.resourceSampler = {
    sample: async () => ({
      measuredAt: new Date().toISOString(),
      logicalCpu: 8,
      effectiveCpu: 8,
      loadRatio: 0,
      totalMemoryMb: 32768,
      availableMemoryMb: 30000,
      memoryUsageRatio: 0.1,
      source: "host",
    }),
  };
  let controllerGeneration = 0;
  const retirement = new AbortController();
  const activeRuns = new Set<ReturnType<FactorySupervisor["run"]>>();
  let disposal: Promise<void> | undefined;
  return {
    repository,
    runId: lease.runId,
    graph,
    policy,
    snapshot,
    management,
    repositoryResources: shared,
    activity,
    resources,
    mergePull,
    events,
    refs,
    run: (signal?: AbortSignal) => {
      if (retirement.signal.aborted)
        return Promise.reject(new Error("provider Supervisor fixture is already retiring"));
      receiptTransportUnavailable = false;
      const generation = ++controllerGeneration;
      const controllerExpiresAt = new Date(Date.now() + 600_000).toISOString();
      const run = new FactorySupervisor({
        token: "fixture-only",
        owner: "fixture",
        repo: "provider-qualification",
        objective: 7,
        repository,
        policy,
        managementBackend: management,
        backendRegistry: registry,
        repositoryResources: shared,
        ...(faults.repositoryFence ? { repositoryFence: faults.repositoryFence } : {}),
        pollIntervalMs: 20,
        ...(faults.controllerActivation
          ? {
              activation: { requestId: "fixture-activation", baseSha },
              shutdownBehavior: "release-lease" as const,
              controllerObservation: () => ({
                controllerId: `fixture-controller-${generation}`,
                epoch: generation,
                expiresAt: controllerExpiresAt,
                controllerPolicyDigest: pd,
              }),
            }
          : {}),
        signal: signal ? AbortSignal.any([signal, retirement.signal]) : retirement.signal,
        onStatus: (message) => notifications.push(message),
      }).run();
      activeRuns.add(run);
      // Observe both outcomes immediately even when a timed-out test abandons
      // its promise. Return the original promise so callers retain its result.
      void run.then(
        () => {
          activeRuns.delete(run);
        },
        () => {
          activeRuns.delete(run);
        },
      );
      return run;
    },
    runRecovery: (recovery: NonNullable<SupervisorOptions["recovery"]>, signal?: AbortSignal) => {
      if (retirement.signal.aborted)
        return Promise.reject(new Error("provider Supervisor fixture is already retiring"));
      receiptTransportUnavailable = false;
      const run = new FactorySupervisor({
        token: "fixture-only",
        owner: "fixture",
        repo: "provider-qualification",
        objective: 7,
        repository,
        policy,
        managementBackend: management,
        backendRegistry: registry,
        repositoryResources: shared,
        ...(faults.repositoryFence ? { repositoryFence: faults.repositoryFence } : {}),
        pollIntervalMs: 20,
        recovery,
        signal: signal ? AbortSignal.any([signal, retirement.signal]) : retirement.signal,
        onStatus: (message) => notifications.push(message),
      }).run();
      activeRuns.add(run);
      void run.then(
        () => activeRuns.delete(run),
        () => activeRuns.delete(run),
      );
      return run;
    },
    storage,
    leases,
    lease,
    baseSha,
    dispose: () => {
      if (disposal) return disposal;
      disposal = (async () => {
        const pending = [...activeRuns];
        const drain = Promise.allSettled(pending);
        const retiring = {};
        pendingFixtureRetirements.add(retiring);
        try {
          retirement.abort(new Error("provider Supervisor fixture is retiring"));
          let timer: ReturnType<typeof setTimeout> | undefined;
          const settled = await Promise.race([
            drain,
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () =>
                  reject(
                    new Error(
                      "provider Supervisor fixture retirement exceeded 10000ms; runs and cleanup remain unresolved",
                    ),
                  ),
                10_000,
              );
            }),
          ]).finally(() => {
            if (timer) clearTimeout(timer);
          });
          const failure = settled.find((result) => result.status === "rejected");
          // Preserve the checkout/cache when interrupted work reports unresolved
          // cleanup; fixture deletion is not evidence that execution was retired.
          if (failure?.status === "rejected") throw failure.reason;
          // No old reader/store can reach a subsequent fixture's prototype spies.
          vi.restoreAllMocks();
          vi.unstubAllGlobals();
          // Never enumerate or sweep user caches, including interrupted real runs.
          for (const root of retainedArtifactRoots)
            await rm(root, { recursive: true, force: true });
          await rm(repository, { recursive: true, force: true });
        } finally {
          // After a timeout this callback only opens fixture admission once the
          // old run actually settles; it never restores mocks or deletes files.
          void drain.then(() => {
            pendingFixtureRetirements.delete(retiring);
          });
        }
      })();
      return disposal;
    },
  };
}
