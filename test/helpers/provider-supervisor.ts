/** Credential-free qualification driver. Runs the real Supervisor, Git object
 * stores, scheduler, validation, review checkpoints and publication decisions.
 * GitHub transport and execution resources are simulations, never live evidence. */
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import { FactorySupervisor, createRepositorySupervisorResources } from "../../src/supervisor.js";
import { GitHubReader } from "../../src/github.js";
import { GitHubControlStore } from "../../src/control/github-store.js";
import { CompiledGraphManager, type CompiledGraphStore } from "../../src/control/graphs.js";
import { LeaseManager, type GitCommitObject, type LeaseState } from "../../src/control/lease.js";
import { decodeEventComments } from "../../src/control/receipts.js";
import { DEFAULT_RUN_POLICY, parseRunPolicy, policyDigest } from "../../src/protocol/policy.js";
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

export const LOCAL = "codex-sdk/local-worktree";
export const DAYTONA = "codex-cli/daytona";
export const COPILOT = "github-copilot/github-managed";
export const CODEX = "openai-codex/github-managed";
export type ProviderScenario = "daytona-burst" | "copilot-objective" | "codex-objective";
export interface ProviderFaults {
  controllerActivation?: boolean;
  afterIntegration?: () => void;
  localOnly?: boolean;
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
}

export async function providerSupervisorFixture(
  scenario: ProviderScenario,
  faults: ProviderFaults = {},
) {
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
  git("add", ".");
  git("commit", "-qm", "base");
  const baseSha = git("rev-parse", "HEAD");
  const managed = scenario !== "daytona-burst";
  const provider =
    scenario === "copilot-objective" ? COPILOT : scenario === "codex-objective" ? CODEX : DAYTONA;
  const policy = parseRunPolicy({
    ...DEFAULT_RUN_POLICY,
    ...(faults.sandboxUntrusted ? { trust: "sandbox_untrusted" } : {}),
    backendOrder: faults.localOnly ? [LOCAL] : managed ? [provider, DAYTONA] : [LOCAL, DAYTONA],
    maxParallel: managed || faults.localOnly ? 1 : 2,
    maxAttemptsPerItem: 1,
    workItemTimeoutMinutes: 2,
    objectiveTimeoutMinutes: 20,
    allowedPaidBackends: faults.localOnly ? [] : managed ? [provider, DAYTONA] : [DAYTONA],
    cloudFallback: faults.localOnly ? "never" : "explicit",
    maxSandboxMinutes: 30,
    maxManagedAgentSessions: managed ? 3 : 0,
    economics: {
      maxModelTokens: 10_000,
      maxSandboxMinutes: 30,
      maxManagedSessions: managed ? 3 : 0,
      minCloudTimeSavedMinutes: 0,
    },
    capacity: {
      ...DEFAULT_RUN_POLICY.capacity,
      mode: "fixed",
      local: { ...DEFAULT_RUN_POLICY.capacity!.local, maxWorkers: 1 },
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
  const readCommit = async (oid: string): Promise<GitCommitObject> => ({
    oid,
    treeOid: git("rev-parse", `${oid}^{tree}`),
    parentOids: git("show", "-s", "--format=%P", oid).split(" ").filter(Boolean),
    message: rawGit(["show", "-s", "--format=%B", oid]),
    serverTime: new Date(),
  });
  const storage: CompiledGraphStore = {
    readRef: async (ref) => refs.get(ref) ?? null,
    readCommit,
    readBlob: async (oid) => Buffer.from(rawGit(["cat-file", "blob", oid])),
    readTreeEntry: async (oid, path) => git("ls-tree", oid, "--", path).split(/\s+/)[2] ?? null,
    createBlob: async (bytes) => rawGit(["hash-object", "-w", "--stdin"], bytes).trim(),
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
    runId: "provider-fixture",
    holder: "operator",
    policyDigest: pd,
    ref: "lease",
    oid: baseSha,
    treeOid: git("rev-parse", "HEAD^{tree}"),
    epoch: 1,
    sequence: 100,
    expiresAt: new Date(Date.now() + 600_000),
  };
  const graph: CompiledObjective = {
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
      dependsOn: index === 2 ? ["a", "b"] : faults.nativeStack && index === 1 ? ["a"] : [],
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
  const graphManager = new CompiledGraphManager(storage, {
    assertCurrent: async () => undefined,
  } as unknown as LeaseManager);
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
        graphSize: 3,
        baseSha,
        graphRef: graphRecord.ref,
        graphBlobSha: graphRecord.blobOid,
      }),
      event({
        kind: "graph",
        event: "GraphProjected",
        graphDigest: graphRecord.graphDigest,
        graphSize: 3,
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
        graphSize: 3,
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
  vi.spyOn(GitHubControlStore.prototype, "readChecks").mockResolvedValue({
    pending: [],
    failed: [],
    observed: [],
    observedChecks: [],
  });
  vi.spyOn(GitHubControlStore.prototype, "getBranchHead").mockImplementation(async (branch) =>
    readCommit(refs.get(`refs/heads/${branch}`) ?? git("rev-parse", branch)),
  );
  vi.spyOn(GitHubControlStore.prototype, "addIssueComment").mockImplementation(
    async (node, body) => {
      const target =
        node === snapshot.id ? snapshot : snapshot.workItems.find((item) => item.id === node)!;
      target.factoryEvents!.push(...decodeEventComments(body));
      if (decodeEventComments(body).some((event) => event.event === "AttemptIntegrated"))
        faults.afterIntegration?.();
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
    return structuredClone(snapshot);
  });
  vi.spyOn(GitHubReader.prototype, "resolveUserId").mockResolvedValue("U_operator");
  vi.spyOn(GitHubReader.prototype, "readRunCancellationRequest").mockResolvedValue(null);
  vi.spyOn(LeaseManager.prototype, "read").mockResolvedValue(null);
  let leaseGeneration = 0;
  vi.spyOn(LeaseManager.prototype, "acquire").mockImplementation(async (identity) => ({
    ...lease,
    ...identity,
    ...(faults.controllerActivation ? { epoch: ++leaseGeneration } : {}),
  }));
  vi.spyOn(LeaseManager.prototype, "assertCurrent").mockResolvedValue(undefined);
  vi.spyOn(LeaseManager.prototype, "assertGeneration").mockResolvedValue(undefined);
  vi.spyOn(LeaseManager.prototype, "release").mockImplementation(async (value) => value);
  const pulls = new Map<
    number,
    { pull: LinkedPullRequest; branch: string; base: string; baseRef: string; merged?: string }
  >();
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
      changedFilePaths: [`${graph.workItems[workItem - 8]!.id}.txt`],
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
    const base = refs.get(`refs/heads/${value.baseRef}`) ?? git("rev-parse", value.baseRef);
    const tree = git("merge-tree", "--write-tree", base, value.pull.headSha).split("\n")[0]!;
    const preview = rawGit(
      ["commit-tree", tree, "-p", base, "-p", value.pull.headSha],
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
      headSha: value.pull.headSha,
      baseSha: base,
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
      git("merge", "--squash", headSha);
      git("commit", "-qm", `integrate ${number}`);
      const value = pulls.get(number)!;
      value.merged = git("rev-parse", "HEAD");
      value.pull.state = "MERGED";
      if (faults.nativeStack) {
        for (const child of pulls.values()) {
          if (child.merged || child.baseRef !== value.branch) continue;
          const oldHead = child.pull.headSha;
          const newHead = rawGit(
            ["commit-tree", git("rev-parse", `${oldHead}^{tree}`), "-p", value.merged],
            "simulated GitHub cascading rebase",
          ).trim();
          child.pull.headSha = newHead;
          child.baseRef = "main";
          child.base = value.merged;
          refs.set(`refs/heads/${child.branch}`, newHead);
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
      supportedTools: ["node"],
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
        const resourceId = `${id}:${input.workItem}`;
        resources.add(resourceId);
        running.set(resourceId, input);
        const name = graph.workItems[input.workItem - 8]!.id;
        await writeFile(join(input.workspace, `${name}.txt`), `${name}\n`);
        execFileSync("git", ["add", `${name}.txt`], { cwd: input.workspace });
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
          const head = rawGit(
            ["commit-tree", tree, "-p", input.packet.baseSha],
            "provider fixture result",
          ).trim();
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
          changedPaths: [`${graph.workItems[input.workItem - 8]!.id}.txt`],
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
  registry.register(execution(LOCAL));
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
      activity.push({
        operation: candidate ? "candidate-review" : "review",
        backend: "fixture-management",
        workItem: context.workItemNumber,
      });
      const result = {
        review: {
          accepted: !(candidate && faults.candidateReviewRejects),
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
  return {
    repository,
    policy,
    snapshot,
    activity,
    resources,
    events,
    refs,
    run: (signal?: AbortSignal) => {
      const generation = ++controllerGeneration;
      const controllerExpiresAt = new Date(Date.now() + 600_000).toISOString();
      return new FactorySupervisor({
        token: "fixture-only",
        owner: "fixture",
        repo: "provider-qualification",
        objective: 7,
        repository,
        policy,
        managementBackend: management,
        backendRegistry: registry,
        repositoryResources: shared,
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
        ...(signal ? { signal } : {}),
        onStatus: (message) => notifications.push(message),
      }).run();
    },
    dispose: async () => {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      await rm(repository, { recursive: true, force: true });
    },
  };
}
