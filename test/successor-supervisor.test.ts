import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FactorySupervisor, type SupervisorOptions } from "../src/supervisor.js";
import * as localScopes from "../src/runtime/local-scope.js";
import { runContainedProcess } from "../src/runtime/process-group.js";
import { GitHubReader } from "../src/github.js";
import { GitHubControlStore } from "../src/control/github-store.js";
import { CompiledGraphManager, type CompiledGraphStore } from "../src/control/graphs.js";
import { LeaseManager, type GitCommitObject, type LeaseState } from "../src/control/lease.js";
import { attemptRef } from "../src/control/attempts.js";
import { decodeEventComments, encodeEventTrailer } from "../src/control/receipts.js";
import { DEFAULT_RUN_POLICY, parseRunPolicy, policyDigest } from "../src/protocol/policy.js";
import { parseFactoryEvent } from "../src/protocol/events.js";
import { renderWorkPacket, type CompiledObjective } from "../src/graph.js";
import { planDelivery } from "../src/publication/delivery.js";
import { publicationBranch } from "../src/publication/publisher.js";
import { bindValidationToPublishedHead } from "../src/validation/plan.js";
import { BackendRegistry } from "../src/execution/registry.js";
import { CodexSdkLocalBackend } from "../src/backends/codex-sdk-local.js";
import type { ManagementBackend } from "../src/management/backend.js";
import type { ObjectiveSnapshot, LinkedPullRequest } from "../src/types.js";
import { PlatformUnavailableError } from "../src/platform.js";
import * as cleanValidation from "../src/validation/clean-run.js";
import { ReviewCheckpointManager } from "../src/control/reviews.js";
import { buildRecoveryProposal } from "../src/recovery/proposal.js";
import { RecoveryPlanManager } from "../src/recovery/plan.js";
import { RecoveryClaimManager } from "../src/recovery/claims.js";
import { recoveryAdoptionEvents } from "../src/recovery/transaction.js";
import { normalizeArtifact } from "../src/execution/artifacts.js";
import { loadRecoveryRuntime } from "../src/recovery/runtime.js";
import { localExecutionScopeBatch, type AttemptContext } from "../src/execution/backend.js";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

/** Real Supervisor, state derivation, immutable stores and local Git validation;
 * only the GitHub transport and paid management response are simulated. */
async function fixture(
  options: {
    externalAdvance?: boolean;
    rejectReview?: boolean;
    failCombinedTests?: boolean;
    loseMergeResponse?: boolean;
    wrongPreviewTree?: boolean;
    loseIntegrationReceipt?: boolean;
    stalePreviewOnce?: boolean;
    tokenLimit?: number;
  } = {},
) {
  const repository = await mkdtemp(join(tmpdir(), "factory-successor-integration-"));
  directories.push(repository);
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: repository,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("remote", "add", "origin", "https://github.com/o/r.git");
  await writeFile(join(repository, "README.md"), "Fixture\n");
  if (options.failCombinedTests)
    await writeFile(
      join(repository, "combined.test.mjs"),
      'import { existsSync } from "node:fs";\nif (existsSync("a.txt") && existsSync("b.txt")) throw new Error("combined regression");\n',
    );
  git("add", ".");
  git("commit", "-qm", "base");
  const baseSha = git("rev-parse", "HEAD");
  const heads: string[] = [];
  for (const name of ["a", "b"]) {
    git("checkout", "-q", "-b", name, baseSha);
    await writeFile(join(repository, `${name}.txt`), `${name}\n`);
    git("add", ".");
    git(
      "commit",
      "-qm",
      `${name}\n\nFactory-Artifact: ${createHash("sha256").update(name).digest("hex")}\nFactory-Validation: ${createHash("sha256").update(name).digest("hex")}`,
    );
    heads.push(git("rev-parse", "HEAD"));
  }
  git("checkout", "-q", "main");
  const now = new Date();
  const policy = parseRunPolicy({
    ...DEFAULT_RUN_POLICY,
    ...(options.tokenLimit === undefined
      ? {}
      : {
          economics: {
            maxModelTokens: options.tokenLimit,
            maxSandboxMinutes: 0,
            maxManagedSessions: 0,
            minCloudTimeSavedMinutes: 0,
          },
        }),
    backendOrder: ["codex-sdk/local-worktree"],
    capacity: { ...DEFAULT_RUN_POLICY.capacity, mode: "fixed" },
    delivery: { mode: "regular-prs", onUnavailable: "regular-prs", merge: "bottom-up" },
  });
  const pd = policyDigest(policy);
  let sequence = 1;
  const event = (fields: Record<string, unknown>) =>
    parseFactoryEvent({
      protocol: "clockgrove.factory/v2",
      objective: 7,
      runId: "parallel",
      sequence: sequence++,
      at: now.toISOString(),
      ...fields,
    });
  const refs = new Map<string, string>();
  const commits = new Map<string, GitCommitObject>();
  const blobs = new Map<string, Buffer>();
  const trees = new Map<string, Map<string, string>>();
  let stalePreviewServed = false;
  let stalePreviewOid: string | undefined;
  let counter = 0;
  const oid = () => createHash("sha1").update(`metadata-${counter++}`).digest("hex");
  const readCommit = async (id: string): Promise<GitCommitObject> => {
    if (id === stalePreviewOid) stalePreviewServed = true;
    return (
      commits.get(id) ?? {
        oid: id,
        treeOid: git("rev-parse", `${id}^{tree}`),
        parentOids: git("show", "-s", "--format=%P", id).split(" ").filter(Boolean),
        message: git("show", "-s", "--format=%B", id),
        serverTime: new Date(),
      }
    );
  };
  const storage: CompiledGraphStore = {
    readRef: async (ref) => refs.get(ref) ?? null,
    readCommit,
    readBlob: async (id) => {
      const bytes = blobs.get(id);
      if (!bytes) throw new Error("missing blob");
      return bytes;
    },
    readTreeEntry: async (id, path) => trees.get(id)?.get(path) ?? null,
    createBlob: async (bytes) => {
      const id = execFileSync("git", ["hash-object", "-w", "--stdin"], {
        cwd: repository,
        input: bytes,
        encoding: "utf8",
      }).trim();
      blobs.set(id, bytes);
      return id;
    },
    createTree: async ({ entries, baseTreeOid }) => {
      const env = {
        ...process.env,
        GIT_INDEX_FILE: join(repository, `fixture-index-${counter++}`),
      };
      const run = (...args: string[]) =>
        execFileSync("git", args, { cwd: repository, env, encoding: "utf8" }).trim();
      run("read-tree", baseTreeOid ?? "--empty");
      for (const entry of entries) {
        if (entry.sha)
          run("update-index", "--add", "--cacheinfo", `${entry.mode},${entry.sha},${entry.path}`);
        else run("update-index", "--force-remove", entry.path);
      }
      const id = run("write-tree");
      trees.set(
        id,
        new Map(entries.filter((entry) => entry.sha).map((entry) => [entry.path, entry.sha!])),
      );
      return id;
    },
    createCommit: async (args) => {
      const id = git(
        "commit-tree",
        args.treeOid,
        ...args.parentOids.flatMap((sha) => ["-p", sha]),
        "-m",
        args.message,
      );
      commits.set(id, { ...args, oid: id, serverTime: new Date() });
      return id;
    },
    createRef: async (ref, id) => {
      if (refs.has(ref)) return false;
      refs.set(ref, id);
      return true;
    },
  };
  const lease: LeaseState = {
    objective: 7,
    runId: "parallel",
    holder: "operator",
    policyDigest: pd,
    ref: "lease",
    oid: "e".repeat(40),
    treeOid: (await readCommit(baseSha)).treeOid,
    epoch: 1,
    sequence: 100,
    expiresAt: new Date(Date.now() + 600_000),
  };
  const leases = { assertCurrent: async () => {} } as unknown as LeaseManager;
  const graph: CompiledObjective = {
    title: "Parallel siblings",
    workItems: ["a", "b", "c"].map((name) => ({
      id: name,
      title: name,
      goal: `Add ${name}`,
      acceptance: ["Tests pass"],
      scope: [`${name}.txt`],
      preconditions: [],
      outOfScope: [],
      conventions: [],
      dependsOn: name === "c" ? ["a", "b"] : [],
      baseSha,
      validationCommands: ["node --test"],
      requirements: {
        os: ["linux"],
        architecture: [],
        tools: ["node"],
        services: [],
        networkDestinations: [],
        permittedSecretNames: [],
        trust: "trusted_local",
      },
      artifactContract: "clockgrove.factory/artifact-v1",
      delivery: { group: name, relationship: name === "c" ? "join-after-merge" : "root" },
    })),
  };
  const graphManager = new CompiledGraphManager(storage, leases);
  const record = await graphManager.persist({
    lease,
    base: await readCommit(baseSha),
    objective: graph,
  });
  const projection = await graphManager.persistProjection({
    lease,
    graph: record,
    bindings: graph.workItems.map((item, index) => ({
      compilerId: item.id,
      issueNodeId: `I_${8 + index}`,
      issueNumber: 8 + index,
    })),
  });
  const delivery = planDelivery(
    graph.workItems.map((item) => ({
      id: item.id,
      dependsOn: item.dependsOn,
      delivery: { group: item.delivery!.group, relationship: item.delivery!.relationship },
    })),
  );
  if (delivery.result !== "supported") throw new Error("fixture delivery unsupported");
  const snapshot: ObjectiveSnapshot = {
    id: "I_7",
    number: 7,
    title: graph.title,
    body: "Implement two independent siblings",
    authorLogin: "operator",
    closed: false,
    repositoryId: "R_1",
    defaultBranch: "main",
    readAt: now,
    workItemLabelId: null,
    copilotBotId: null,
    ciExpectedOnPullRequests: false,
    factoryEvents: [
      event({
        kind: "run",
        event: "FactoryRunStarted",
        actor: "operator",
        repository: "o/r",
        objectiveAuthor: "operator",
        fork: false,
        baseBranch: "main",
        baseSha,
        policy,
        policyDigest: pd,
      }),
      event({
        kind: "delivery",
        event: "DeliverySelected",
        requested: "regular-prs",
        selected: "regular-prs",
        capabilityVersion: "2026-03-10",
        reason: "Fixture observed native support",
      }),
      event({
        kind: "graph",
        event: "GraphCompiled",
        graphDigest: record.graphDigest,
        graphSize: record.graphSize,
        baseSha,
        graphRef: record.ref,
        graphBlobSha: record.blobOid,
      }),
      event({
        kind: "graph",
        event: "GraphProjected",
        graphDigest: record.graphDigest,
        graphSize: record.graphSize,
        projectionRef: projection.ref,
        projectionBlobSha: projection.blobOid,
      }),
    ],
    workItems: [],
  };
  for (const [index, item] of graph.workItems.entries()) {
    if (index === 2) continue;
    const number = 8 + index;
    const head = heads[index]!;
    const tree = (await readCommit(head)).treeOid;
    const validationDigest = createHash("sha256").update(item.id).digest("hex");
    const exact = bindValidationToPublishedHead({
      validation: { passed: true, digest: validationDigest, baseSha, outputTreeSha: tree },
      publishedBaseSha: baseSha,
      publishedTreeSha: tree,
      publishedHeadSha: head,
    });
    const attempt = (fields: Record<string, unknown>) =>
      event({
        kind: "attempt",
        workItem: number,
        attempt: 1,
        backend: "codex-sdk/local-worktree",
        baseSha,
        directorEpoch: 1,
        policyDigest: pd,
        ...fields,
      });
    const reserved = attempt({ event: "AttemptReserved" });
    const reservationOid = oid();
    refs.set(attemptRef(7, number, 1), reservationOid);
    commits.set(reservationOid, {
      oid: reservationOid,
      treeOid: (await readCommit(baseSha)).treeOid,
      parentOids: [baseSha],
      message: encodeEventTrailer(reserved),
      serverTime: now,
    });
    const plan = delivery.items.find((entry) => entry.itemId === item.id)!;
    const pull: LinkedPullRequest = {
      id: `PR_${number}`,
      number: number + 10,
      state: "OPEN",
      isDraft: false,
      title: item.title,
      body: "",
      changedLines: 1,
      changedFiles: 1,
      changedFilePaths: [`${item.id}.txt`],
      commitSubjects: [item.id],
      checks: null,
      mergeable: "MERGEABLE",
      createdAt: now,
      headSha: head,
      headCommittedAt: now,
      mergedAt: null,
      closedAt: null,
      agentWorkEvents: [],
    };
    snapshot.workItems.push({
      id: `I_${number}`,
      number,
      title: item.title,
      body: renderWorkPacket(item, {
        protocol: "clockgrove.factory/graph-v1",
        id: item.id,
        graphDigest: record.graphDigest,
        graphSize: 3,
        index,
        dependsOn: [],
      }),
      closed: false,
      assignees: [],
      labels: [],
      blockedBy: [],
      linkedPullRequests: [pull],
      copilotAssignments: [],
      factoryEvents: [
        reserved,
        event({
          kind: "validation",
          event: "ValidationRecorded",
          workItem: number,
          attempt: 1,
          baseSha,
          outputTreeSha: tree,
          evidenceDigest: validationDigest,
          passed: true,
        }),
        attempt({ event: "AttemptValidated", artifactDigest: validationDigest }),
        attempt({ event: "AttemptPublished", headSha: head, artifactDigest: validationDigest }),
        event({
          kind: "publication",
          event: "PublicationRecorded",
          workItem: number,
          attempt: 1,
          unitId: plan.unitId,
          itemId: item.id,
          mode: "regular-prs",
          position: plan.position,
          branch: publicationBranch(7, number, 1),
          baseBranch: "main",
          baseSha,
          headSha: head,
          pullRequest: pull.number,
          capabilityVersion: "2026-03-10",
          validationDigest,
          exactHeadValidationDigest: exact.digest,
        }),
      ],
    });
  }
  for (const name of Object.keys(storage) as Array<keyof CompiledGraphStore>) {
    // The complete immutable-store API is the transport boundary; no protocol
    // manager or Supervisor decision is mocked.
    vi.spyOn(GitHubControlStore.prototype, name).mockImplementation(storage[name] as never);
  }
  vi.spyOn(GitHubControlStore.prototype, "listRefs").mockImplementation(async (prefix) =>
    [...refs].filter(([ref]) => ref.startsWith(prefix)).map(([ref, id]) => ({ ref, oid: id })),
  );
  vi.spyOn(GitHubControlStore.prototype, "serverTime").mockImplementation(async () => new Date());
  vi.spyOn(GitHubControlStore.prototype, "getRepositoryFacts").mockResolvedValue({
    fullName: "o/r",
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
  vi.spyOn(GitHubControlStore.prototype, "getBranchHead").mockImplementation(async () =>
    readCommit(git("rev-parse", "main")),
  );
  let lostIntegrationReceipt = false;
  vi.spyOn(GitHubControlStore.prototype, "addIssueComment").mockImplementation(
    async (node, body) => {
      const events = decodeEventComments(body);
      if (
        options.loseIntegrationReceipt &&
        !lostIntegrationReceipt &&
        events.some(
          (entry) =>
            entry.kind === "attempt" && entry.event === "AttemptIntegrated" && entry.workItem === 8,
        )
      ) {
        lostIntegrationReceipt = true;
        throw new PlatformUnavailableError(
          { kind: "server_error", retryAfterMs: 1 },
          new Error("receipt unavailable"),
        );
      }
      const target =
        node === snapshot.id ? snapshot : snapshot.workItems.find((item) => item.id === node)!;
      target.factoryEvents!.push(...events);
    },
  );
  vi.spyOn(GitHubControlStore.prototype, "closeIssue").mockImplementation(async (number) => {
    (number === 7 ? snapshot : snapshot.workItems.find((item) => item.number === number)!).closed =
      true;
  });
  vi.spyOn(GitHubControlStore.prototype, "assignIssue").mockResolvedValue(undefined);
  let reads = 0;
  vi.spyOn(GitHubReader.prototype, "readObjective").mockImplementation(async () => {
    if (++reads > 180) throw new Error("fixture exceeded bounded snapshot reads");
    return structuredClone(snapshot);
  });
  vi.spyOn(LeaseManager.prototype, "read").mockResolvedValue(null);
  let acquisitions = 0;
  vi.spyOn(LeaseManager.prototype, "acquire").mockImplementation(async (identity) => ({
    ...lease,
    ...identity,
    epoch: ++acquisitions,
  }));
  vi.spyOn(LeaseManager.prototype, "assertCurrent").mockResolvedValue(undefined);
  vi.spyOn(LeaseManager.prototype, "assertGeneration").mockResolvedValue(undefined);
  vi.spyOn(LeaseManager.prototype, "release").mockImplementation(async (value) => value);
  const findPull = (number: number) =>
    snapshot.workItems.find((item) => item.linkedPullRequests[0]!.number === number)!
      .linkedPullRequests[0]!;
  const mergeShas = new Map<number, string>();
  let responseLost = false;
  vi.spyOn(GitHubControlStore.prototype, "findPullRequestForBranch").mockImplementation(
    async (branch) => {
      const item = snapshot.workItems.find(
        (entry) => publicationBranch(7, entry.number, 1) === branch,
      )!;
      const pull = item?.linkedPullRequests[0];
      if (!pull) return null;
      return {
        number: pull.number,
        htmlUrl: `https://github.com/o/r/pull/${pull.number}`,
        state: pull.state === "OPEN" ? "open" : "closed",
        merged: pull.state === "MERGED",
        headSha: pull.headSha,
      };
    },
  );
  vi.spyOn(GitHubControlStore.prototype, "readPullRequest").mockImplementation(async (number) => {
    const pull = findPull(number);
    const currentBase = git("rev-parse", "main");
    const preview = createHash("sha1")
      .update(`preview:${currentBase}:${pull.headSha}`)
      .digest("hex");
    if (pull.state === "OPEN")
      commits.set(preview, {
        oid: preview,
        treeOid:
          options.wrongPreviewTree && number === 19
            ? git("rev-parse", `${pull.headSha}^{tree}`)
            : git("merge-tree", "--write-tree", currentBase, pull.headSha).split("\n")[0]!,
        parentOids: [currentBase, pull.headSha],
        message: "GitHub test merge",
        serverTime: new Date(),
      });
    if (
      options.stalePreviewOnce &&
      !stalePreviewServed &&
      number === 19 &&
      [...refs.keys()].some((ref) => ref.includes("/reviews/"))
    ) {
      stalePreviewOid = preview;
      commits.get(preview)!.parentOids = [baseSha, pull.headSha];
    }
    return {
      number,
      nodeId: pull.id,
      baseRepository: "o/r",
      headRepository: "o/r",
      headRef: publicationBranch(7, number - 10, 1),
      state: pull.state === "OPEN" ? "open" : "closed",
      draft: false,
      merged: pull.state === "MERGED",
      mergeable: true,
      mergeableState: "clean",
      headSha: pull.headSha,
      baseRef: "main",
      baseSha:
        pull.state === "MERGED"
          ? (await readCommit(mergeShas.get(number)!)).parentOids[0]!
          : currentBase,
      mergeCommitSha: mergeShas.get(number) ?? preview,
      createdAt: new Date(now.getTime() - 120_000),
    };
  });
  const merge = vi
    .spyOn(GitHubControlStore.prototype, "mergePullRequest")
    .mockImplementation(async ({ number, headSha }) => {
      expect(headSha).toBe(findPull(number).headSha);
      git("merge", "--squash", headSha);
      git("commit", "-qm", `merge PR ${number}`);
      const merged = git("rev-parse", "HEAD");
      mergeShas.set(number, merged);
      findPull(number).state = "MERGED";
      if (number === 19 && options.loseMergeResponse && !responseLost) {
        responseLost = true;
        throw new PlatformUnavailableError(
          { kind: "server_error", retryAfterMs: 1 },
          new Error("fixture merge response lost"),
        );
      }
      if (number === 18 && options.externalAdvance) {
        await writeFile(join(repository, "external.txt"), "outside this run\n");
        git("add", ".");
        git("commit", "-qm", "external advance");
      }
      return merged;
    });
  const review = vi.fn<ManagementBackend["review"]>(async (_context, checkpoint) => {
    const result = {
      review: {
        accepted: !options.rejectReview,
        summary: options.rejectReview ? "reject candidate" : "accept candidate",
        unmetCriteria: options.rejectReview ? ["fixture rejection"] : [],
        risks: [],
      },
      usage: { inputTokens: 10, outputTokens: 5 },
    };
    await checkpoint(result);
    return result;
  });
  const management: ManagementBackend = {
    id: policy.managementBackend,
    probe: async () => ({ available: true, authenticated: true }),
    compile: vi.fn(async () => {
      throw new Error("unexpected compilation");
    }),
    review,
  };
  vi.spyOn(BackendRegistry.prototype, "select").mockResolvedValue({
    backend: new CodexSdkLocalBackend(),
    probe: { available: true, authenticated: true, measuredAt: now.toISOString() },
  });
  const launch = vi
    .spyOn(CodexSdkLocalBackend.prototype, "launch")
    .mockRejectedValue(new Error("unexpected replacement worker"));
  vi.spyOn(CodexSdkLocalBackend.prototype, "probe").mockResolvedValue({
    available: true,
    authenticated: true,
    measuredAt: now.toISOString(),
  });
  const validate = vi.spyOn(cleanValidation, "validateArtifactClean");
  const messages: string[] = [];
  const run = (recovery?: SupervisorOptions["recovery"]) =>
    new FactorySupervisor({
      token: "fixture-token",
      owner: "o",
      repo: "r",
      objective: 7,
      repository,
      policy,
      managementBackend: management,
      pollIntervalMs: 1,
      onStatus: (message) => messages.push(message),
      ...(recovery ? { recovery } : {}),
    }).run();
  return {
    run,
    snapshot,
    refs,
    blobs,
    merge,
    mergeShas,
    review,
    launch,
    heads,
    baseSha,
    git,
    repository,
    validate,
    stalePreviewObserved: () => stalePreviewServed,
    storage,
    leases,
    lease,
    graph,
    record,
    projection,
    event,
    readCommit,
    policy,
    pd,
    commits,
    management,
    get sequence() {
      return sequence;
    },
    messages,
  };
}

async function successorFixture(options: Parameters<typeof fixture>[0] = {}) {
  const f = await fixture(options);
  const store = new GitHubControlStore({ token: "fixture-token", owner: "o", repo: "r" });
  const hostIdentity = "b".repeat(64);
  vi.spyOn(localScopes.linuxLocalScopeReadPort, "hostIdentity").mockResolvedValue(hostIdentity);
  vi.spyOn(localScopes.linuxLocalScopeReadPort, "read").mockRejectedValue(
    Object.assign(new Error("absent fixture producer"), { code: "ENOENT" }),
  );
  vi.spyOn(localScopes.linuxLocalScopeReadPort, "show").mockImplementation(
    async (unit) =>
      `Id=${unit}\nLoadState=not-found\nActiveState=inactive\nSubState=dead\nControlGroup=\nJob=\nInvocationID=\nKillMode=control-group\n`,
  );
  vi.spyOn(localScopes, "discoverLocalScopeHost").mockResolvedValue({
    hostIdentity,
    producerPid: process.pid,
    producerStartTicks: "456",
    producerUnit: "factory-fixture.service",
    producerInvocationId: "c".repeat(32),
  });
  vi.spyOn(localScopes, "runScopedLocalProcess").mockImplementation(async (_identity, options) =>
    runContainedProcess(options),
  );
  for (const item of f.snapshot.workItems) {
    const reserved = item.factoryEvents!.find((entry) => entry.event === "AttemptReserved")!;
    if (reserved.kind !== "attempt") throw new Error("fixture reservation");
    const batch = {
      identity: {
        protocol: "clockgrove.factory/local-scope-v1",
        repository: "o/r",
        objective: 7,
        runId: "parallel",
        workItem: item.number,
        attempt: 1,
        directorEpoch: 1,
        policyDigest: f.pd,
        phase: "execution",
        commandIndex: 0,
        invocationDigest: "a".repeat(64),
        hostIdentity,
        producerUnit: "factory-fixture.service",
        producerInvocationId: "c".repeat(32),
      },
      commandCount: 1,
      producerPid: 123,
      producerStartTicks: "456",
      deadline: new Date(Date.now() + 600_000).toISOString(),
    };
    const scoped = parseFactoryEvent({ ...reserved, localScopeBatch: batch });
    item.factoryEvents![item.factoryEvents!.indexOf(reserved)] = scoped;
    const ref = attemptRef(7, item.number, 1);
    f.commits.get(f.refs.get(ref)!)!.message = encodeEventTrailer(scoped);
    const validated = item.factoryEvents!.find((entry) => entry.kind === "validation")!;
    if (validated.kind !== "validation") throw new Error("fixture validation");
    const artifactDigest = createHash("sha256").update(item.title).digest("hex");
    const review = await new ReviewCheckpointManager(f.storage, f.leases).persist({
      lease: f.lease,
      identity: {
        kind: "artifact",
        runId: "parallel",
        objective: 7,
        workItem: item.number,
        attempt: 1,
        artifactDigest,
        baseSha: f.baseSha,
        outputTreeSha: validated.outputTreeSha,
        evidenceDigest: validated.evidenceDigest,
      },
      result: {
        review: { accepted: true, summary: "fixture accepted", unmetCriteria: [], risks: [] },
        usage: { inputTokens: 10, outputTokens: 5 },
      },
    });
    item.factoryEvents!.push(
      f.event({
        ...reserved,
        event: "AttemptSucceeded",
        sequence: f.sequence,
        reportedModelTokens: 0,
        artifactDigest,
      }),
      f.event({
        kind: "budget",
        event: "BudgetReconciled",
        workItem: item.number,
        attempt: 1,
        phase: "management",
        unit: "model_tokens",
        amount: 15,
        usageId: `review-${review.identityDigest}`,
      }),
      f.event({
        kind: "capacity",
        event: "CapacityReserved",
        workItem: item.number,
        attempt: 1,
        phase: "validation",
        backend: "factory/local-validation",
        requestedCpu: 1,
        requestedMemoryMb: 512,
        directorEpoch: 1,
        policyDigest: f.pd,
        localScopeBatch: {
          ...batch,
          identity: { ...batch.identity, phase: "validation", invocationDigest: artifactDigest },
        },
      }),
      f.event({
        kind: "capacity",
        event: "CapacityReconciled",
        workItem: item.number,
        attempt: 1,
        phase: "validation",
        backend: "factory/local-validation",
        requestedCpu: 1,
        requestedMemoryMb: 512,
        directorEpoch: 1,
        policyDigest: f.pd,
      }),
    );
  }
  const c = f.graph.workItems[2]!;
  const order = [
    "AttemptReserved",
    "AttemptSucceeded",
    "CapacityReserved",
    "ValidationRecorded",
    "BudgetReconciled",
    "AttemptValidated",
    "AttemptPublished",
    "PublicationRecorded",
    "CapacityReconciled",
  ];
  for (const item of f.snapshot.workItems) {
    item.factoryEvents = item
      .factoryEvents!.sort((a, b) => order.indexOf(a.event) - order.indexOf(b.event))
      .map((entry) => f.event({ ...entry, sequence: f.sequence }));
    const reserved = item.factoryEvents.find((entry) => entry.event === "AttemptReserved")!;
    f.commits.get(f.refs.get(attemptRef(7, item.number, 1))!)!.message =
      encodeEventTrailer(reserved);
  }
  f.snapshot.workItems.push({
    id: "I_10",
    number: 10,
    title: "c",
    body: renderWorkPacket(c, {
      protocol: "clockgrove.factory/graph-v1",
      id: "c",
      graphDigest: f.record.graphDigest,
      graphSize: 3,
      index: 2,
      dependsOn: ["a", "b"],
    }),
    closed: false,
    assignees: [],
    labels: [],
    blockedBy: [
      { number: 8, closed: false },
      { number: 9, closed: false },
    ],
    linkedPullRequests: [],
    copilotAssignments: [],
    factoryEvents: [],
  });
  const read = vi.mocked(GitHubReader.prototype.readObjective).getMockImplementation()!;
  vi.mocked(GitHubReader.prototype.readObjective).mockImplementation(async (...args) => {
    f.snapshot.workItems[2]!.blockedBy = f.snapshot.workItems
      .slice(0, 2)
      .map((item) => ({ number: item.number, closed: item.closed }));
    return read.apply({} as GitHubReader, args);
  });
  await store.mergePullRequest({ number: 18, headSha: f.heads[0]!, commitTitle: "A" });
  f.snapshot.workItems[0]!.closed = true;
  const a = f.snapshot.workItems[0]!;
  const aReserved = a.factoryEvents!.find((entry) => entry.event === "AttemptReserved")!;
  a.factoryEvents!.push(
    f.event({
      ...aReserved,
      localScopeBatch: undefined,
      event: "AttemptIntegrated",
      sequence: f.sequence,
      headSha: f.mergeShas.get(18),
    }),
  );
  f.snapshot.factoryEvents!.push(
    f.event({
      kind: "budget",
      event: "BudgetReconciled",
      phase: "management",
      unit: "model_tokens",
      amount: 0,
      usageId: `compile-${"0".repeat(64)}`,
    }),
  );
  const terminal = f.event({
    kind: "run",
    event: "FactoryRunEscalated",
    reason: "original sibling base advanced",
  });
  f.snapshot.factoryEvents!.push(terminal);
  const proposal = await buildRecoveryProposal({
    repository: "o/r",
    snapshot: f.snapshot,
    historyComplete: true,
    store,
    requestId: "fixture-recovery",
    successorRunId: "successor",
  });
  expect(proposal.blockers).toEqual([]);
  if (!proposal.plan) throw new Error("fixture proposal unavailable");
  const planRecord = await new RecoveryPlanManager(f.storage, f.leases).persist({
    lease: { ...f.lease, runId: "successor" },
    plan: proposal.plan,
  });
  const request = f.event({
    kind: "recovery",
    event: "RecoveryRequested",
    requestedBy: "operator",
    requestId: proposal.plan.requestId,
    repository: "o/r",
    planDigest: planRecord.digest,
    predecessorRunId: "parallel",
    predecessorTerminalDigest: proposal.plan.predecessor.terminalDigest,
    successorRunId: "successor",
    policyDigest: f.pd,
    baseSha: proposal.plan.expectedBaseSha,
  });
  if (request.event !== "RecoveryRequested") throw new Error("fixture request");
  f.snapshot.factoryEvents!.push(request);
  const claim = await new RecoveryClaimManager(f.storage, f.leases).claim({
    lease: { ...f.lease, runId: "successor" },
    planRecord,
    authenticatedRequest: request,
    transaction: {
      at: new Date().toISOString(),
      startSequence: f.sequence,
      evidenceDigest: "1".repeat(64),
      accountingDigest: "2".repeat(64),
      resourceEvidenceDigest: "3".repeat(64),
    },
  });
  const predecessorStart = f.snapshot.factoryEvents!.find(
    (entry) => entry.event === "FactoryRunStarted",
  )!;
  if (predecessorStart.event !== "FactoryRunStarted") throw new Error("fixture start");
  f.snapshot.factoryEvents!.push(
    ...recoveryAdoptionEvents({
      planRecord,
      claim,
      authenticatedRequest: request,
      predecessorStart,
    }),
  );
  const runtime = () =>
    loadRecoveryRuntime({
      objective: 7,
      runId: "successor",
      store,
      readSnapshot: async () => ({ snapshot: f.snapshot, historyComplete: true }),
    });
  expect(await runtime()).toMatchObject({ status: "verified" });
  let context: AttemptContext;
  f.launch.mockImplementation(async (value) => {
    expect(value.workItem).toBe(10);
    expect(f.snapshot.workItems.slice(0, 2).every((item) => item.closed)).toBe(true);
    expect(localExecutionScopeBatch(value)).toBeTruthy();
    await value.localExecutionScope!.assertCurrent();
    context = value;
    return {
      backendId: "codex-sdk/local-worktree",
      resourceId: "fixture-worker-C",
      startedAt: new Date().toISOString(),
      metadata: { resourceHostIdentity: hostIdentity },
    };
  });
  vi.spyOn(GitHubReader.prototype, "readRunCancellationRequest").mockResolvedValue(null);
  vi.spyOn(CodexSdkLocalBackend.prototype, "observe").mockImplementation(async () => ({
    state: "succeeded",
    observedAt: new Date().toISOString(),
    usage: { inputTokens: 12, outputTokens: 8, cachedInputTokens: 0 },
  }));
  vi.spyOn(CodexSdkLocalBackend.prototype, "collect").mockImplementation(async () =>
    normalizeArtifact({
      baseSha: context.packet.baseSha,
      changedPaths: ["c.txt"],
      patch:
        "diff --git a/c.txt b/c.txt\nnew file mode 100644\n--- /dev/null\n+++ b/c.txt\n@@ -0,0 +1 @@\n+c\n",
      outcome: "succeeded",
    }),
  );
  vi.spyOn(CodexSdkLocalBackend.prototype, "cleanup").mockResolvedValue(undefined);
  vi.spyOn(GitHubControlStore.prototype, "createPullRequest").mockImplementation(async (args) => {
    expect(args.head).toBe(publicationBranch(7, 10, 1));
    const pull: LinkedPullRequest = {
      ...f.snapshot.workItems[0]!.linkedPullRequests[0]!,
      id: "PR_20",
      number: 20,
      title: "c",
      state: "OPEN",
      headSha: f.refs.get(`refs/heads/${args.head}`)!,
      mergedAt: null,
      closedAt: null,
      changedFilePaths: ["c.txt"],
    };
    f.snapshot.workItems[2]!.linkedPullRequests.push(pull);
    return { number: 20, htmlUrl: "https://github.com/o/r/pull/20", headSha: pull.headSha };
  });
  const original = structuredClone(
    [
      ...f.snapshot.factoryEvents!,
      ...f.snapshot.workItems.flatMap((item) => item.factoryEvents!),
    ].filter((event) => event.runId === "parallel"),
  );
  return {
    ...f,
    store,
    planRecord,
    claim,
    original,
    runtime,
    run: () =>
      f.run({
        requestId: planRecord.plan.requestId,
        planDigest: planRecord.digest,
        successorRunId: "successor",
      }),
  };
}

describe("Supervisor authenticated successor execution", () => {
  it("replays a lost B merge response without a second B validation, review, or worker", async () => {
    const f = await successorFixture({ loseMergeResponse: true });
    await expect(f.run()).rejects.toThrow(PlatformUnavailableError);
    expect(f.launch).not.toHaveBeenCalled();
    expect(f.review).toHaveBeenCalledTimes(1);
    expect(f.validate).toHaveBeenCalledTimes(1);
    expect(await f.run()).toMatchObject({ status: "completed", runId: "successor" });
    expect(f.review).toHaveBeenCalledTimes(2);
    expect(f.validate).toHaveBeenCalledTimes(2);
    expect(f.launch).toHaveBeenCalledTimes(1);
    expect(f.merge.mock.calls.map(([input]) => input.number)).toEqual([18, 19, 20]);
    expect(await f.runtime()).toMatchObject({ status: "verified", usage: { modelTokens: 80 } });
  }, 30000);

  it("rejects a missing authenticated adoption envelope before any work", async () => {
    const f = await successorFixture();
    f.snapshot.factoryEvents = f.snapshot.factoryEvents!.filter(
      (event) => event.event !== "RecoveryAdoptionCompleted",
    );
    await expect(f.run()).rejects.toThrow("successor runtime unavailable");
    expect(f.launch).not.toHaveBeenCalled();
    expect(f.review).not.toHaveBeenCalled();
    expect(f.merge).toHaveBeenCalledTimes(1);
  });

  it("blocks a live predecessor producer without new validation, review, or workers", async () => {
    const f = await successorFixture();
    vi.mocked(localScopes.linuxLocalScopeReadPort.read).mockImplementation(async (path) => {
      const pid = path.split("/")[2];
      const fields = Array<string>(20).fill("0");
      fields[0] = "S";
      fields[19] = "456";
      return `${pid} (fixture producer) ${fields.join(" ")}`;
    });
    expect(await f.run()).toMatchObject({ status: "escalated" });
    expect(f.validate).not.toHaveBeenCalled();
    expect(f.review).not.toHaveBeenCalled();
    expect(f.launch).not.toHaveBeenCalled();
    expect(f.merge).toHaveBeenCalledTimes(1);
  }, 30000);

  it("does not reset historical model usage at successor startup", async () => {
    const f = await successorFixture({ tokenLimit: 30 });
    const result = await f.run();
    expect(result).toMatchObject({ status: "escalated" });
    expect(f.launch).not.toHaveBeenCalled();
    expect(f.review).not.toHaveBeenCalled();
    expect(f.merge).toHaveBeenCalledTimes(1);
    expect(await f.runtime()).toMatchObject({
      status: "verified",
      usage: { modelTokens: 30 },
      remaining: { modelTokens: 0 },
    });
  }, 30000);

  it("preserves integrated A and revalidates B without source attempts or source history mutation", async () => {
    const f = await successorFixture();
    const result = await f.run();
    expect(result, JSON.stringify(f.messages)).toMatchObject({ status: "completed" });
    expect(f.snapshot.workItems.slice(0, 2).map((item) => item.closed)).toEqual([true, true]);
    expect(
      f.snapshot.workItems
        .flatMap((item) => item.factoryEvents!)
        .filter((event) => event.event === "RecoverySourceIntegrated"),
    ).toHaveLength(2);
    expect(
      [
        ...f.snapshot.factoryEvents!,
        ...f.snapshot.workItems.flatMap((item) => item.factoryEvents!),
      ].filter((event) => event.runId === "parallel"),
    ).toEqual(f.original);
    expect(f.launch).toHaveBeenCalledTimes(1);
    expect(f.management.compile).not.toHaveBeenCalled();
    expect(f.review).toHaveBeenCalledTimes(2);
    expect(await f.runtime()).toMatchObject({ status: "verified", usage: { modelTokens: 80 } });
    expect(await f.run()).toMatchObject({ status: "completed" });
    expect(f.launch).toHaveBeenCalledTimes(1);
    expect(f.review).toHaveBeenCalledTimes(2);
    const sourceCapacity = f.snapshot.workItems[1]!.factoryEvents!.find(
      (event) => event.kind === "capacity" && event.sourceRunId,
    );
    expect(sourceCapacity?.kind).toBe("capacity");
    if (sourceCapacity?.kind !== "capacity") throw new Error("missing source capacity fixture");
    const backend = sourceCapacity.backend;
    sourceCapacity.backend = `factory/integration-validation-${"0".repeat(64)}`;
    expect(await f.runtime()).toMatchObject({
      status: "blocked",
      blockers: ["source-capacity-candidate-mismatch"],
    });
    sourceCapacity.backend = backend;
  }, 30000);
});
