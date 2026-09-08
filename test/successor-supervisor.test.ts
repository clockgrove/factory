import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FactorySupervisor, type SupervisorOptions } from "../src/supervisor.js";
import { integrationAdmissionRef } from "../src/control/integration-admission.js";
import * as localScopes from "../src/runtime/local-scope.js";
import { runContainedProcess } from "../src/runtime/process-group.js";
import { GitHubReader } from "../src/github.js";
import { GitHubControlStore } from "../src/control/github-store.js";
import { CompiledGraphManager, type CompiledGraphStore } from "../src/control/graphs.js";
import { LeaseManager, type GitCommitObject, type LeaseState } from "../src/control/lease.js";
import { attemptRef } from "../src/control/attempts.js";
import {
  decodeEventComments,
  encodeEventTrailer,
  latestRunReceipts,
} from "../src/control/receipts.js";
import { DEFAULT_RUN_POLICY, parseRunPolicy, policyDigest } from "../src/protocol/policy.js";
import { parseFactoryEvent } from "../src/protocol/events.js";
import { renderWorkPacket, type CompiledObjective } from "../src/graph.js";
import { planDelivery } from "../src/publication/delivery.js";
import { GitHubStacks } from "../src/publication/github-stacks.js";
import { publicationBranch } from "../src/publication/publisher.js";
import { bindValidationToPublishedHead } from "../src/validation/plan.js";
import { BackendRegistry } from "../src/execution/registry.js";
import { CodexSdkLocalBackend } from "../src/backends/codex-sdk-local.js";
import { DaytonaResourceCleanupError } from "../src/backends/daytona.js";
import type { ManagementBackend } from "../src/management/backend.js";
import type { ObjectiveSnapshot, LinkedPullRequest } from "../src/types.js";
import { PlatformUnavailableError } from "../src/platform.js";
import * as cleanValidation from "../src/validation/clean-run.js";
import { ReviewCheckpointManager } from "../src/control/reviews.js";
import {
  MergeCandidateCheckpointStore,
  mergeCandidateIdentityDigest,
  type MergeCandidateIdentity,
} from "../src/control/merge-candidates.js";
import { createValidationEvidence } from "../src/validation/evidence.js";
import { buildRecoveryProposal } from "../src/recovery/proposal.js";
import { RecoveryPlanManager } from "../src/recovery/plan.js";
import { RecoveryClaimManager } from "../src/recovery/claims.js";
import { recoveryAdoptionEvents } from "../src/recovery/transaction.js";
import { normalizeArtifact } from "../src/execution/artifacts.js";
import { workerPacketDigest } from "../src/protocol/worker-packet.js";
import { loadRecoveryRuntime } from "../src/recovery/runtime.js";
import * as siblingRefreshProof from "../src/recovery/sibling-refresh.js";
import { recoveryReadPort } from "../src/recovery/github-read-port.js";
import { verifyRecoveryProposalResources } from "../src/recovery/resources.js";
import { verifyPriorRecoveryDelivery } from "../src/recovery/outcomes.js";
import {
  localExecutionScopeBatch,
  type AttemptContext,
  type ExecutionBackend,
} from "../src/execution/backend.js";
import { validationInvocationOwnership } from "../src/backends/validation-invocation.js";

const validateFixtureTree = cleanValidation.validateArtifactClean;

const directories: string[] = [];
const fixtureRunOwners: Array<{
  retirement: AbortController;
  runs: Promise<unknown>[];
}> = [];

async function retireFixtureRuns() {
  const owners = fixtureRunOwners.splice(0);
  for (const owner of owners)
    owner.retirement.abort(new Error("successor Supervisor fixture is retiring"));
  return Promise.allSettled(owners.flatMap((owner) => owner.runs));
}

afterEach(async () => {
  await retireFixtureRuns();
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
    artifactOnly?: boolean;
    loseArtifactPrResponse?: boolean;
    nativeSource?: boolean;
    retainedPrefix?: 1 | 2 | 3;
    stackLength?: 2 | 3 | 4;
    loseStackLinkResponse?: boolean;
    dropUpperAfterMerge?: boolean;
    premergedNativeRoot?: boolean;
    mixedRetainedPublication?: boolean;
    omitMergedNativePrefix?: boolean;
    nativeUuidDrift?: boolean;
    failC?: boolean;
    loseSiblingRefreshResponse?: boolean;
    completeSourceScopeEvidence?: boolean;
    isolatedItem?: string;
    isolatedWorker?: boolean;
    foregroundPredecessor?: boolean;
    historicalSuccessor?: boolean;
    staleRetainedBaseUntilRefresh?: boolean;
    providerOwnedRetainedBranch?: boolean;
    refreshedPreview?: "missing" | "old-parents";
    noJoin?: boolean;
    adoptedIsolatedValidation?: {
      paid?: boolean;
      available?: boolean;
      fault?: "validation" | "cleanup";
    };
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
  for (const name of ["a", "b", "c"].slice(0, Math.max(2, options.retainedPrefix ?? 2))) {
    git(
      "checkout",
      "-q",
      "-b",
      name,
      options.retainedPrefix && heads.length ? heads.at(-1)! : baseSha,
    );
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
  const now = new Date(Date.now() - (options.historicalSuccessor ? 120_000 : 0));
  const policy = parseRunPolicy({
    ...DEFAULT_RUN_POLICY,
    ...(options.failC ? { maxAttemptsPerItem: 1 } : {}),
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
    backendOrder: [
      ...(options.isolatedWorker ? ["fixture/isolated-worker"] : []),
      "codex-sdk/local-worktree",
      ...(options.isolatedItem ? ["fixture/isolated-validator"] : []),
      ...(options.adoptedIsolatedValidation && options.adoptedIsolatedValidation.paid !== false
        ? ["codex-cli/daytona"]
        : []),
    ],
    ...(options.adoptedIsolatedValidation
      ? {
          allowedPaidBackends:
            options.adoptedIsolatedValidation.paid === false ? [] : ["codex-cli/daytona"],
          cloudFallback: "explicit",
          maxSandboxMinutes: 90,
          workItemTimeoutMinutes: 2,
        }
      : {}),
    capacity: { ...DEFAULT_RUN_POLICY.capacity, mode: "fixed" },
    delivery: {
      mode: options.nativeSource ? "stacked-prs" : "regular-prs",
      onUnavailable: "regular-prs",
      merge: "bottom-up",
    },
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
  const immutableCommits = new Map<string, Omit<GitCommitObject, "serverTime">>();
  const previewTrees = new Map<string, string>();
  const readCommit = async (id: string): Promise<GitCommitObject> => {
    if (id === stalePreviewOid) stalePreviewServed = true;
    const synthetic = commits.get(id);
    if (synthetic) return synthetic;
    let immutable = immutableCommits.get(id);
    if (!immutable) {
      // Read the immutable commit's fresh metadata in one subprocess. The
      // fixture previously paid for three Git startups on every newly observed
      // merge while exercising the same production proof.
      const output = git("show", "-s", "--format=%T%x00%P%x00%B", id);
      const treeEnd = output.indexOf("\0");
      const parentsEnd = output.indexOf("\0", treeEnd + 1);
      if (treeEnd < 0 || parentsEnd < 0) throw new Error("malformed fixture Git commit");
      immutable = {
        oid: id,
        treeOid: output.slice(0, treeEnd),
        parentOids: output
          .slice(treeEnd + 1, parentsEnd)
          .split(" ")
          .filter(Boolean),
        message: output.slice(parentsEnd + 1).trim(),
      };
      immutableCommits.set(id, immutable);
    }
    return { ...immutable, parentOids: [...immutable.parentOids], serverTime: new Date() };
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
  const leases = {
    assertCurrent: async () => {},
    assertMutationAuthorized: async (lease: LeaseState) => leases.assertCurrent(lease),
  } as unknown as LeaseManager;
  const graph: CompiledObjective = {
    title: "Parallel siblings",
    workItems: ["a", "b", "c", "d"]
      .slice(0, options.noJoin ? 2 : (options.stackLength ?? 3))
      .map((name, index) => ({
        id: name,
        title: name,
        goal: `Add ${name}`,
        acceptance: ["Tests pass"],
        scope: [`${name}.txt`],
        preconditions: [],
        outOfScope: [],
        conventions: [],
        dependsOn: options.retainedPrefix
          ? index
            ? [["a", "b", "c"][index - 1]!]
            : []
          : name === "c"
            ? ["a", "b"]
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
          trust: options.isolatedItem === name ? "isolated" : "trusted_local",
        },
        artifactContract: "clockgrove.factory/artifact-v1",
        delivery: options.retainedPrefix
          ? {
              group: "a",
              relationship: index ? "continue-stack" : "root",
              ...(index ? { parentWorkItem: ["a", "b", "c"][index - 1]! } : {}),
            }
          : { group: name, relationship: name === "c" ? "join-after-merge" : "root" },
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
      delivery: {
        group: item.delivery!.group,
        relationship: item.delivery!.relationship,
        ...(item.delivery!.parentWorkItem ? { parentWorkItem: item.delivery!.parentWorkItem } : {}),
      },
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
        ...(options.foregroundPredecessor ? {} : { baseSha }),
        policy,
        policyDigest: pd,
      }),
      event({
        kind: "delivery",
        event: "DeliverySelected",
        requested: options.nativeSource ? "stacked-prs" : "regular-prs",
        selected: options.nativeSource ? "native-stacks" : "regular-prs",
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
    if (index >= (options.retainedPrefix ?? 2)) continue;
    const itemBase = options.retainedPrefix && index ? heads[index - 1]! : baseSha;
    const number = 8 + index;
    const head = heads[index]!;
    const branch =
      options.providerOwnedRetainedBranch && number === 9
        ? "provider/retained-b"
        : publicationBranch(7, number, 1);
    refs.set(`refs/heads/${branch}`, head);
    const tree = (await readCommit(head)).treeOid;
    const validationDigest = createHash("sha256").update(item.id).digest("hex");
    const exact = bindValidationToPublishedHead({
      validation: {
        passed: true,
        digest: validationDigest,
        baseSha: itemBase,
        outputTreeSha: tree,
      },
      publishedBaseSha: itemBase,
      publishedTreeSha: tree,
      publishedHeadSha: head,
    });
    const attempt = (fields: Record<string, unknown>) =>
      event({
        kind: "attempt",
        workItem: number,
        attempt: 1,
        backend: "codex-sdk/local-worktree",
        baseSha: itemBase,
        directorEpoch: 1,
        policyDigest: pd,
        ...fields,
      });
    const reserved = attempt({ event: "AttemptReserved" });
    const reservationOid = oid();
    refs.set(attemptRef(7, number, 1), reservationOid);
    commits.set(reservationOid, {
      oid: reservationOid,
      treeOid: (await readCommit(itemBase)).treeOid,
      parentOids: [itemBase],
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
        graphSize: graph.workItems.length,
        index,
        dependsOn: item.dependsOn,
      }),
      closed: false,
      assignees: [],
      labels: [],
      blockedBy: item.dependsOn.map((id) => ({
        number: 8 + graph.workItems.findIndex((entry) => entry.id === id),
        closed: false,
      })),
      linkedPullRequests: [pull],
      copilotAssignments: [],
      factoryEvents: [
        reserved,
        event({
          kind: "validation",
          event: "ValidationRecorded",
          workItem: number,
          attempt: 1,
          baseSha: itemBase,
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
          mode: options.nativeSource ? "native-stacks" : "regular-prs",
          position: plan.position,
          ...(plan.parentItemId ? { parentItemId: plan.parentItemId } : {}),
          branch,
          baseBranch:
            index && options.retainedPrefix ? publicationBranch(7, number - 1, 1) : "main",
          baseSha: itemBase,
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
    snapshot.workItems.find((item) => item.linkedPullRequests[0]?.number === number)!
      .linkedPullRequests[0]!;
  const refreshedPulls = new Set<number>();
  let siblingRefreshResponseLost = false;
  const refresh = vi.fn(
    async ({ ref, beforeOid, afterOid }: { ref: string; beforeOid: string; afterOid: string }) => {
      const item = snapshot.workItems.find(
        (entry) => ref === `refs/heads/${publicationBranch(7, entry.number, 1)}`,
      );
      if (!item || refs.get(ref) !== beforeOid) return false;
      const commit = await readCommit(afterOid);
      expect(commit.parentOids[0]).toBe(beforeOid);
      expect(commit.parentOids).toHaveLength(2);
      expect(commit.parentOids[1]).toBe(git("rev-parse", "main"));
      refs.set(ref, afterOid);
      item.linkedPullRequests[0]!.headSha = afterOid;
      refreshedPulls.add(item.linkedPullRequests[0]!.number);
      if (options.loseSiblingRefreshResponse && !siblingRefreshResponseLost) {
        siblingRefreshResponseLost = true;
        throw new PlatformUnavailableError(
          { kind: "server_error", retryAfterMs: 1 },
          new Error("sibling refresh response lost"),
        );
      }
      return true;
    },
  );
  vi.spyOn(GitHubControlStore.prototype, "compareAndSwapRef").mockImplementation(async (args) => {
    if (
      args.ref.startsWith("refs/clockgrove-factory/admission/") ||
      args.ref.startsWith("refs/clockgrove-factory/repository/work-items/")
    ) {
      if (refs.get(args.ref) !== args.beforeOid) return false;
      expect((await readCommit(args.afterOid)).parentOids[0]).toBe(args.beforeOid);
      refs.set(args.ref, args.afterOid);
      return true;
    }
    if (!args.ref.startsWith("refs/clockgrove-factory/integration-admissions/"))
      return refresh(args);
    if (refs.get(args.ref) !== args.beforeOid) return false;
    const claimCommit = await readCommit(args.afterOid);
    expect(claimCommit.parentOids).toEqual([args.beforeOid]);
    refs.set(args.ref, args.afterOid);
    return true;
  });
  const mergeShas = new Map<number, string>();
  const pullBases = new Map<number, string>(
    snapshot.workItems.map((item, index) => [
      item.number + 10,
      options.retainedPrefix && index ? publicationBranch(7, item.number - 1, 1) : "main",
    ]),
  );
  let responseLost = false;
  vi.spyOn(GitHubControlStore.prototype, "findPullRequestForBranch").mockImplementation(
    async (branch) => {
      const item = snapshot.workItems.find((entry) =>
        branch.startsWith(`factory/objective-7/work-item-${entry.number}/attempt-`),
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
    const baseRef = pullBases.get(number) ?? "main";
    const currentBase =
      baseRef === "main" ? git("rev-parse", "main") : refs.get(`refs/heads/${baseRef}`)!;
    // Captured GitHub shape: advancing trunk alone need not update the retained
    // PR's REST base or test-merge parents. Only the exact owned CAS fixes it.
    const reportedBase =
      options.staleRetainedBaseUntilRefresh && number === 19 && !refreshedPulls.has(number)
        ? baseSha
        : currentBase;
    const preview = createHash("sha1")
      .update(`preview:${reportedBase}:${pull.headSha}`)
      .digest("hex");
    if (pull.state === "OPEN") {
      let treeOid = previewTrees.get(preview);
      if (!treeOid) {
        treeOid =
          options.wrongPreviewTree && number === 19
            ? git("rev-parse", `${heads[1]}^{tree}`)
            : git("merge-tree", "--write-tree", reportedBase, pull.headSha).split("\n")[0]!;
        previewTrees.set(preview, treeOid);
      }
      commits.set(preview, {
        oid: preview,
        treeOid,
        parentOids: [reportedBase, pull.headSha],
        message: "GitHub test merge",
        serverTime: new Date(),
      });
      if (options.refreshedPreview === "old-parents" && refreshedPulls.has(number))
        commits.get(preview)!.parentOids = [baseSha, heads[1]!];
    }
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
      headRef:
        number === 19 && options.providerOwnedRetainedBranch
          ? "provider/retained-b"
          : number === 20 && options.failC
            ? publicationBranch(7, 10, 2)
            : publicationBranch(7, number - 10, 1),
      state: pull.state === "OPEN" ? "open" : "closed",
      draft: false,
      merged: pull.state === "MERGED",
      mergeable: true,
      mergeableState: "clean",
      headSha: pull.headSha,
      baseRef,
      baseSha:
        pull.state === "MERGED"
          ? (await readCommit(mergeShas.get(number)!)).parentOids[0]!
          : reportedBase,
      mergeCommitSha:
        options.refreshedPreview === "missing" &&
        refreshedPulls.has(number) &&
        !mergeShas.has(number)
          ? null
          : (mergeShas.get(number) ?? preview),
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
      if (options.retainedPrefix) {
        const branch = publicationBranch(7, number - 10, 1);
        const pending = [{ branch, base: merged, baseRef: "main" }];
        while (pending.length) {
          const parent = pending.shift()!;
          for (const [childNumber, childBase] of pullBases) {
            if (childBase !== parent.branch) continue;
            const child = findPull(childNumber);
            const tree = git("rev-parse", `${child.headSha}^{tree}`);
            child.headSha = git(
              "commit-tree",
              tree,
              "-p",
              parent.base,
              "-m",
              "provider cascading rebase",
            );
            const childBranch = publicationBranch(7, childNumber - 10, 1);
            refs.set(`refs/heads/${childBranch}`, child.headSha);
            pullBases.set(childNumber, parent.baseRef);
            pending.push({ branch: childBranch, base: child.headSha, baseRef: childBranch });
          }
        }
      }
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
  vi.spyOn(GitHubStacks.prototype, "probe").mockResolvedValue({
    available: true,
    observed: true,
    version: "2026-03-10",
    reason: "fixture observed native API",
  });
  const backendRegistry =
    options.isolatedItem || options.adoptedIsolatedValidation ? new BackendRegistry() : undefined;
  const isolatedResources = new Set<string>();
  // Same deterministic provider simulation boundary as helpers/provider-supervisor.ts:
  // owned local fixture Git substitutes for remote compute, never live provider proof.
  const isolatedValidate = vi.fn<NonNullable<ExecutionBackend["validate"]>>(async (input) => {
    const ownership = validationInvocationOwnership(input);
    if (!ownership) throw new Error("fixture requires exact candidate invocation");
    isolatedResources.add(ownership);
    const result = await validateFixtureTree({
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
        passed: result.evidence.passed,
        startedAt: result.evidence.startedAt,
        completedAt: result.evidence.completedAt,
        environmentIdentity: `docker.io/library/node@sha256:${"a".repeat(64)}`,
        ...(result.evidence.failureReason ? { failureReason: result.evidence.failureReason } : {}),
      };
    } finally {
      await cleanValidation.discardValidationResult(result);
      if (options.adoptedIsolatedValidation?.fault === "cleanup") {
        // biome-ignore lint/correctness/noUnsafeFinally: models the existing provider contract's cleanup refusal overriding successful commands
        throw new DaytonaResourceCleanupError({
          resourceId: `simulated-${ownership}`,
          resourceName: `simulated-validation-${ownership}`,
          operation: "validation cleanup",
          cause: "simulated isolated candidate termination is unknown",
        });
      }
      isolatedResources.delete(ownership);
    }
  });
  const isolatedReconcile = vi.fn<NonNullable<ExecutionBackend["reconcileStale"]>>(
    async (input) => {
      if (isolatedResources.size) {
        const ownership = validationInvocationOwnership(input);
        if (!ownership || !isolatedResources.has(ownership))
          throw new Error("fixture reconciliation does not own its simulated resource");
        throw new DaytonaResourceCleanupError({
          resourceId: `simulated-${ownership}`,
          resourceName: `simulated-validation-${ownership}`,
          operation: "stale-attempt reconciliation",
          cause: "simulated isolated candidate termination is still unknown",
        });
      }
    },
  );
  if (backendRegistry) {
    const local = new CodexSdkLocalBackend();
    backendRegistry.register(local);
    const unused = async (): Promise<never> => {
      throw new Error("fixture isolated validator must not execute before denied child admission");
    };
    // A separately available validator allows graph preflight to reach the
    // worker admission boundary; it cannot serve as an execution backend.
    backendRegistry.register({
      capabilities: {
        ...local.capabilities,
        id: "fixture/isolated-validator",
        isolation: "container",
      },
      policyRejectionReasons: ({ phase }) => (phase === "execution" ? ["validation only"] : []),
      probe: async () => ({ available: true, authenticated: true, measuredAt: now.toISOString() }),
      probeValidation: async () => ({
        available: true,
        authenticated: true,
        measuredAt: now.toISOString(),
      }),
      launch: unused,
      observe: unused,
      cancel: unused,
      collect: unused,
      cleanup: unused,
      validate: unused,
    });
    if (options.adoptedIsolatedValidation)
      backendRegistry.register({
        capabilities: {
          ...local.capabilities,
          id: "codex-cli/daytona",
          runtimeKind: "simulated-provider",
          hostExecution: false,
          isolation: "container",
          requiresPaidRuntime: true,
          reportsModelUsage: false,
          requiredCredentials: [],
        },
        probe: async () => ({
          available: options.adoptedIsolatedValidation?.available !== false,
          authenticated: true,
          measuredAt: now.toISOString(),
        }),
        probeValidation: async () => ({
          available: options.adoptedIsolatedValidation?.available !== false,
          authenticated: true,
          measuredAt: now.toISOString(),
        }),
        launch: unused,
        observe: unused,
        cancel: unused,
        collect: unused,
        cleanup: unused,
        validate: isolatedValidate,
        reconcileStale: isolatedReconcile,
      });
    if (options.isolatedWorker)
      backendRegistry.register({
        capabilities: {
          ...local.capabilities,
          id: "fixture/isolated-worker",
          isolation: "container",
        },
        probe: (requirements) => local.probe(requirements),
        launch: (context) => local.launch(context),
        observe: unused,
        cancel: unused,
        collect: unused,
        cleanup: unused,
      });
  }
  const retirement = new AbortController();
  const runs: Promise<unknown>[] = [];
  fixtureRunOwners.push({ retirement, runs });
  const run = (recovery?: SupervisorOptions["recovery"]) => {
    const operation = new FactorySupervisor({
      token: "fixture-token",
      owner: "o",
      repo: "r",
      objective: 7,
      repository,
      policy,
      managementBackend: management,
      ...(backendRegistry ? { backendRegistry } : {}),
      // Snapshot/recovery mocks execute real synchronous Git. A 1ms polling
      // cadence monopolizes the worker between each streamed artifact I/O step;
      // retain the 180-read guard while yielding enough for that pipeline to run.
      pollIntervalMs: 50,
      onStatus: (message) => messages.push(message),
      ...(recovery ? { recovery } : {}),
      signal: retirement.signal,
    }).run();
    // Keep every started operation until teardown so an assertion failure or
    // watchdog expiry cannot drop a settled or still-running Supervisor before
    // the fixture aborts and drains all of its work.
    runs.push(operation);
    void operation.catch(() => undefined);
    return operation;
  };
  return {
    run,
    snapshot,
    refs,
    blobs,
    merge,
    mergeShas,
    pullBases,
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
    refresh,
    isolatedValidate,
    isolatedReconcile,
    isolatedResources,
    get sequence() {
      return sequence;
    },
    messages,
  };
}

async function successorFixture(options: Parameters<typeof fixture>[0] = {}) {
  const f = await fixture(options);
  const sourceNativePulls = Array.from(
    { length: options.retainedPrefix ?? 2 },
    (_, index) => 18 + index,
  ).filter((number) => !options.omitMergedNativePrefix || number !== 18);
  const store = new GitHubControlStore({ token: "fixture-token", owner: "o", repo: "r" });
  if (options.premergedNativeRoot)
    vi.spyOn(GitHubStacks.prototype, "get").mockImplementation(async (number) => ({
      number,
      baseRef: "main",
      open: true,
      pullRequests: await Promise.all(
        sourceNativePulls.map(async (number) => {
          const pull = await store.readPullRequest(number);
          return {
            number,
            state: pull.state,
            draft: false,
            mergedAt: pull.merged ? new Date().toISOString() : null,
            headRef: pull.headRef!,
            headSha: pull.headSha,
            baseRef: pull.baseRef,
            baseSha: pull.baseSha,
          };
        }),
      ),
    }));
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
        baseSha: validated.baseSha,
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
          ...(options.completeSourceScopeEvidence ? { commandCount: 2 } : {}),
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
    if (options.completeSourceScopeEvidence)
      item.factoryEvents!.push(
        f.event({ ...reserved, event: "AttemptCollected", sequence: f.sequence, artifactDigest }),
        f.event({
          kind: "budget",
          event: "BudgetReconciled",
          workItem: item.number,
          attempt: 1,
          phase: "validation",
          unit: "validation_milliseconds",
          amount: 1,
        }),
      );
  }
  const c = f.graph.workItems[2]!;
  const order = [
    "AttemptReserved",
    "AttemptSucceeded",
    "CapacityReserved",
    "AttemptCollected",
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
  if (!options.retainedPrefix && !options.noJoin)
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
  if (options.retainedPrefix) {
    for (const [index, packet] of f.graph.workItems.entries()) {
      if (index < options.retainedPrefix) continue;
      f.snapshot.workItems.push({
        id: `I_${8 + index}`,
        number: 8 + index,
        title: packet.title,
        body: renderWorkPacket(packet, {
          protocol: "clockgrove.factory/graph-v1",
          id: packet.id,
          graphDigest: f.record.graphDigest,
          graphSize: f.graph.workItems.length,
          index,
          dependsOn: packet.dependsOn,
        }),
        closed: false,
        assignees: [],
        labels: [],
        blockedBy: packet.dependsOn.map((id) => ({
          number: 8 + f.graph.workItems.findIndex((entry) => entry.id === id),
          closed: false,
        })),
        linkedPullRequests: [],
        copilotAssignments: [],
        factoryEvents: [],
      });
    }
  }
  const read = vi.mocked(GitHubReader.prototype.readObjective).getMockImplementation()!;
  vi.mocked(GitHubReader.prototype.readObjective).mockImplementation(async (...args) => {
    for (const [index, packet] of f.graph.workItems.entries())
      f.snapshot.workItems[index]!.blockedBy = packet.dependsOn.map((id) => {
        const parent =
          f.snapshot.workItems[f.graph.workItems.findIndex((entry) => entry.id === id)]!;
        return { number: parent.number, closed: parent.closed };
      });
    return read.apply({} as GitHubReader, args);
  });
  if (!options.retainedPrefix || options.premergedNativeRoot) {
    if (options.premergedNativeRoot)
      for (const [index, head] of f.heads.entries())
        f.refs.set(`refs/heads/${publicationBranch(7, 8 + index, 1)}`, head);
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
    if (options.premergedNativeRoot) {
      const aPublication = a.factoryEvents!.find((event) => event.event === "PublicationRecorded")!;
      a.factoryEvents!.push(
        f.event({ ...aPublication, event: "StackLinked", sequence: f.sequence, stackNumber: 90 }),
      );
      for (const b of f.snapshot.workItems.slice(1, options.retainedPrefix ?? 2)) {
        const old = b.factoryEvents!.find((entry) => entry.event === "PublicationRecorded")!;
        if (old.kind !== "publication") throw new Error("native fixture original publication");
        const head = b.linkedPullRequests[0]!.headSha;
        const current = await store.readPullRequest(b.linkedPullRequests[0]!.number);
        const base = current.baseSha;
        const tree = (await f.readCommit(head)).treeOid;
        const digest = createHash("sha256").update(`${b.title}-revalidated`).digest("hex");
        const artifactDigest = createHash("sha256").update(b.title).digest("hex");
        const review = await new ReviewCheckpointManager(f.storage, f.leases).persist({
          lease: f.lease,
          identity: {
            kind: "rebase",
            runId: "parallel",
            objective: 7,
            workItem: b.number,
            attempt: 1,
            artifactDigest,
            baseSha: base,
            outputTreeSha: tree,
            evidenceDigest: digest,
            headSha: head,
          },
          result: {
            review: {
              accepted: true,
              summary: "revalidated exact rebased head",
              unmetCriteria: [],
              risks: [],
            },
            usage: { inputTokens: 10, outputTokens: 5 },
          },
        });
        const exact = bindValidationToPublishedHead({
          validation: { passed: true, digest, baseSha: base, outputTreeSha: tree },
          publishedHeadSha: head,
          publishedTreeSha: tree,
          publishedBaseSha: base,
        });
        const priorCapacity = b.factoryEvents!.find(
          (event) => event.kind === "capacity" && event.event === "CapacityReserved",
        )!;
        if (priorCapacity.kind !== "capacity" || !priorCapacity.localScopeBatch)
          throw new Error("fixture scoped source validation");
        b.factoryEvents!.push(
          f.event({
            ...priorCapacity,
            sequence: f.sequence,
            backend: `factory/integration-validation-${digest}`,
            localScopeBatch: {
              ...priorCapacity.localScopeBatch,
              identity: { ...priorCapacity.localScopeBatch.identity, invocationDigest: digest },
            },
          }),
          f.event({
            kind: "validation",
            event: "ValidationRecorded",
            workItem: b.number,
            attempt: 1,
            baseSha: base,
            outputTreeSha: tree,
            evidenceDigest: digest,
            passed: true,
          }),
          f.event({
            kind: "budget",
            event: "BudgetReconciled",
            workItem: b.number,
            attempt: 1,
            phase: "management",
            unit: "model_tokens",
            amount: 15,
            usageId: `rebase-review-${review.identityDigest}`,
          }),
          f.event({
            ...b.factoryEvents!.find((event) => event.event === "AttemptReserved")!,
            event: "AttemptPublished",
            sequence: f.sequence,
            localScopeBatch: undefined,
            headSha: head,
            artifactDigest,
          }),
          f.event({
            ...old,
            sequence: f.sequence,
            event: "PublicationRecorded",
            headSha: head,
            baseSha: base,
            baseBranch: current.baseRef,
            validationDigest: digest,
            exactHeadValidationDigest: exact.digest,
            stackNumber: 90,
          }),
          f.event({
            ...priorCapacity,
            event: "CapacityReconciled",
            sequence: f.sequence,
            backend: `factory/integration-validation-${digest}`,
            localScopeBatch: undefined,
          }),
        );
      }
    }
  }
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
  if ((options.artifactOnly || options.retainedPrefix) && !options.premergedNativeRoot) {
    for (const b of options.retainedPrefix
      ? f.snapshot.workItems.slice(0, options.retainedPrefix)
      : [f.snapshot.workItems[1]!]) {
      if (options.mixedRetainedPublication && b.number === 8) {
        f.refs.set(`refs/heads/${publicationBranch(7, b.number, 1)}`, f.heads[0]!);
        continue;
      }
      b.factoryEvents = b.factoryEvents!.filter(
        (event) => event.event !== "PublicationRecorded" && event.event !== "AttemptPublished",
      );
      b.linkedPullRequests = [];
      f.refs.set(`refs/heads/${publicationBranch(7, b.number, 1)}`, f.heads[b.number - 8]!);
    }
  }
  const proposal = await buildRecoveryProposal({
    repository: "o/r",
    snapshot: f.snapshot,
    historyComplete: true,
    store: recoveryReadPort(store, "o", "r"),
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
      at: new Date(Date.now() - (options.historicalSuccessor ? 60_000 : 0)).toISOString(),
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
      store: recoveryReadPort(store, "o", "r"),
      readSnapshot: async () => ({ snapshot: f.snapshot, historyComplete: true }),
    });
  expect(await runtime()).toMatchObject({ status: "verified" });
  let context: AttemptContext;
  f.launch.mockImplementation(async (value) => {
    if (options.retainedPrefix) {
      expect(value.workItem).toBeGreaterThanOrEqual(8 + options.retainedPrefix);
      const parent = f.snapshot.workItems[value.workItem - 9]!;
      expect(value.packet.baseSha).toBe(parent.linkedPullRequests[0]!.headSha);
    } else {
      expect(value.workItem).toBe(10);
      expect(f.snapshot.workItems.slice(0, 2).every((item) => item.closed)).toBe(true);
    }
    expect(localExecutionScopeBatch(value)).toBeTruthy();
    await value.localExecutionScope!.assertCurrent();
    context = value;
    return {
      backendId: "codex-sdk/local-worktree",
      resourceId: `fixture-worker-${value.workItem}`,
      startedAt: new Date().toISOString(),
      metadata: { resourceHostIdentity: hostIdentity },
    };
  });
  vi.spyOn(GitHubReader.prototype, "readRunCancellationRequest").mockResolvedValue(null);
  vi.spyOn(CodexSdkLocalBackend.prototype, "observe").mockImplementation(async () => ({
    state: options.failC && context.runId === "successor" ? "failed" : "succeeded",
    observedAt: new Date().toISOString(),
    usage: { inputTokens: 12, outputTokens: 8, cachedInputTokens: 0 },
  }));
  vi.spyOn(CodexSdkLocalBackend.prototype, "collect").mockImplementation(async () =>
    normalizeArtifact({
      baseSha: context.packet.baseSha,
      changedPaths: [`${options.retainedPrefix ? context.packet.goal.slice(-1) : "c"}.txt`],
      patch: `diff --git a/${options.retainedPrefix ? context.packet.goal.slice(-1) : "c"}.txt b/${options.retainedPrefix ? context.packet.goal.slice(-1) : "c"}.txt\nnew file mode 100644\n--- /dev/null\n+++ b/${options.retainedPrefix ? context.packet.goal.slice(-1) : "c"}.txt\n@@ -0,0 +1 @@\n+${options.retainedPrefix ? context.packet.goal.slice(-1) : "c"}\n`,
      outcome: "succeeded",
    }),
  );
  vi.spyOn(CodexSdkLocalBackend.prototype, "cleanup").mockResolvedValue(undefined);
  vi.spyOn(GitHubControlStore.prototype, "createPullRequest").mockImplementation(async (args) => {
    const workItem = Number(args.head.match(/work-item-(\d+)/)![1]);
    expect(args.head).toBe(publicationBranch(7, workItem, workItem === 10 ? context.attempt : 1));
    const pull: LinkedPullRequest = {
      ...(f.snapshot.workItems.find((item) => item.linkedPullRequests.length)
        ?.linkedPullRequests[0] ?? {
        isDraft: false,
        body: "",
        changedLines: 1,
        changedFiles: 1,
        commitSubjects: [],
        checks: null,
        mergeable: "MERGEABLE",
        createdAt: new Date(),
        headCommittedAt: new Date(),
        agentWorkEvents: [],
      }),
      id: `PR_${workItem + 10}`,
      number: workItem + 10,
      title: workItem === 9 ? "b" : "c",
      state: "OPEN",
      headSha: f.refs.get(`refs/heads/${args.head}`)!,
      mergedAt: null,
      closedAt: null,
      changedFilePaths: ["c.txt"],
    };
    f.snapshot.workItems[workItem - 8]!.linkedPullRequests.push(pull);
    f.pullBases.set(pull.number, args.base);
    if (options.loseArtifactPrResponse && workItem === 9)
      throw new PlatformUnavailableError(
        { kind: "server_error", retryAfterMs: 1 },
        new Error("fixture source PR response lost"),
      );
    return {
      number: pull.number,
      htmlUrl: `https://github.com/o/r/pull/${pull.number}`,
      headSha: pull.headSha,
    };
  });
  if (options.retainedPrefix) {
    let stackMembers: number[] = options.premergedNativeRoot ? [...sourceNativePulls] : [];
    let lostStackResponse = false;
    const observedStack = async () => ({
      number: 90,
      baseRef: "main",
      open: true,
      pullRequests: await Promise.all(
        stackMembers
          .filter(
            (number) => !(options.dropUpperAfterMerge && f.mergeShas.has(18) && number === 20),
          )
          .map(async (number) => {
            const pull = await store.readPullRequest(number);
            return {
              number,
              state: pull.state,
              draft: false,
              mergedAt: pull.merged ? new Date().toISOString() : null,
              headRef: pull.headRef!,
              headSha: pull.headSha,
              baseRef: pull.baseRef,
              baseSha: pull.baseSha,
            };
          }),
      ),
    });
    vi.spyOn(GitHubStacks.prototype, "list").mockImplementation(async (number) =>
      number !== undefined && stackMembers.includes(number) ? [await observedStack()] : [],
    );
    vi.spyOn(GitHubStacks.prototype, "get").mockImplementation(async (number) => {
      expect(number).toBe(90);
      return observedStack();
    });
    vi.spyOn(GitHubStacks.prototype, "ensureStack").mockImplementation(async (numbers) => {
      expect(
        stackMembers.length === 0 || JSON.stringify(stackMembers) === JSON.stringify(numbers),
      ).toBe(true);
      stackMembers = [...numbers];
      if (options.loseStackLinkResponse && !lostStackResponse) {
        lostStackResponse = true;
        throw new PlatformUnavailableError(
          { kind: "server_error", retryAfterMs: 1 },
          new Error("stack link response lost"),
        );
      }
      return observedStack();
    });
    vi.spyOn(GitHubStacks.prototype, "ensureExtended").mockImplementation(
      async (_number, prefix, additional) => {
        expect(prefix).toEqual(stackMembers);
        stackMembers = [...prefix, ...additional];
        return observedStack();
      },
    );
    vi.spyOn(GitHubStacks.prototype, "requestMerge").mockImplementation(async (input) => {
      const oid = await store.readRef(integrationAdmissionRef("o/r", "main"));
      expect(oid).not.toBeNull();
      const message = (await store.readCommit(oid!)).message;
      const line = message.split("\n").find((value) => value.startsWith("Factory-Integration: "))!;
      const admission = JSON.parse(Buffer.from(line.slice(21), "base64url").toString("utf8"));
      expect(admission).toMatchObject({
        state: "dispatched",
        identity: {
          objective: 7,
          pullRequest: input.pullRequest,
          headSha: input.expectedHeadSha,
          baseSha: f.git("rev-parse", "main"),
        },
      });
      if (options.nativeUuidDrift) {
        return {
          state: "pending",
          uuid: "request-a",
          expectedHeadSha: input.expectedHeadSha,
          mergeAction: "default",
          mergeMethod: "squash",
        };
      }
      return {
        state: "merged",
        mergeSha: await store.mergePullRequest({
          number: input.pullRequest,
          headSha: input.expectedHeadSha,
          commitTitle: input.title,
        }),
      };
    });
    if (options.nativeUuidDrift) {
      vi.spyOn(GitHubStacks.prototype, "mergeResult").mockImplementation(
        async (_pullRequest, uuid, expectedHeadSha) =>
          uuid === "request-a"
            ? {
                state: "pending",
                uuid: "request-b",
                expectedHeadSha,
                mergeAction: "default",
                mergeMethod: "squash",
              }
            : { state: "failed", reason: "different request failed" },
      );
    }
  }
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
    runRecovery: f.run,
    run: () =>
      f.run({
        requestId: planRecord.plan.requestId,
        planDigest: planRecord.digest,
        successorRunId: "successor",
      }),
  };
}

/** Historical fixture for the already-paid old-head candidate captured in #128.
 * This uses the real immutable checkpoint stores, not a mocked proof decision. */
async function retainOldHeadSuccessorCandidate(f: Awaited<ReturnType<typeof successorFixture>>) {
  const item = f.snapshot.workItems[1]!;
  const source = f.planRecord.plan.items[1]!.source!;
  const publication = source.publication!;
  const targetBaseSha = f.planRecord.plan.expectedBaseSha;
  const exact = bindValidationToPublishedHead({
    validation: {
      passed: true,
      digest: source.validation!.evidenceDigest,
      baseSha: source.validation!.baseSha,
      outputTreeSha: source.validation!.outputTreeSha,
    },
    publishedBaseSha: publication.baseSha,
    publishedHeadSha: publication.headSha,
    publishedTreeSha: (await f.readCommit(publication.headSha)).treeOid,
  });
  const artifact = normalizeArtifact({
    baseSha: targetBaseSha,
    changedPaths: ["b.txt"],
    patch: `${f.git("diff", "--binary", publication.baseSha, publication.headSha)}\n`,
    outcome: "succeeded",
  });
  const completedAt = new Date().toISOString();
  const startedAt = new Date(Date.parse(completedAt) - 12_963).toISOString();
  const validation = createValidationEvidence({
    protocol: "clockgrove.factory/validation-v1",
    artifactDigest: artifact.digest,
    baseSha: targetBaseSha,
    outputTreeSha: f
      .git("merge-tree", "--write-tree", targetBaseSha, publication.headSha)
      .split("\n")[0]!,
    commands: [{ command: "node --test", exitCode: 0, durationMs: 12_963 }],
    passed: true,
    startedAt,
    completedAt,
  });
  const lease = { ...f.lease, runId: "successor" };
  const candidate = await new MergeCandidateCheckpointStore(f.storage, f.leases).persist({
    lease,
    identity: {
      runId: "successor",
      objective: 7,
      workItem: 9,
      attempt: source.attempt,
      pullRequest: publication.pullRequest,
      sourceHeadSha: publication.headSha,
      sourceExactHeadValidationDigest: exact.digest,
      targetBaseSha,
    },
    source: exact,
    validation,
  });
  const digest = mergeCandidateIdentityDigest(candidate.identity);
  const review = await new ReviewCheckpointManager(f.storage, f.leases).persist({
    lease,
    identity: {
      kind: "integration-candidate",
      runId: "successor",
      objective: 7,
      workItem: 9,
      attempt: source.attempt,
      artifactDigest: validation.artifactDigest,
      baseSha: targetBaseSha,
      outputTreeSha: validation.outputTreeSha,
      evidenceDigest: validation.digest,
      headSha: publication.headSha,
    },
    result: {
      review: {
        accepted: true,
        summary: "Old head accepted before refresh",
        unmetCriteria: [],
        risks: [],
      },
      usage: { inputTokens: 75_000, outputTokens: 39 },
    },
  });
  const prior = item.factoryEvents!.find(
    (entry) => entry.kind === "capacity" && entry.event === "CapacityReserved",
  );
  if (prior?.kind !== "capacity" || !prior.localScopeBatch) throw new Error("fixture scope absent");
  const priorBatch = prior.localScopeBatch;
  let sequence =
    Math.max(
      ...[
        ...f.snapshot.factoryEvents!,
        ...f.snapshot.workItems.flatMap((entry) => entry.factoryEvents!),
      ].map((entry) => entry.sequence),
    ) + 1;
  const event = (fields: Record<string, unknown>) =>
    parseFactoryEvent({
      protocol: "clockgrove.factory/v2",
      objective: 7,
      runId: "successor",
      workItem: 9,
      sequence: sequence++,
      at: completedAt,
      ...fields,
    });
  const receipts = [
    ...(["CapacityReserved", "CapacityReconciled"] as const).map((name) =>
      event({
        kind: "capacity",
        event: name,
        attempt: source.attempt,
        sourceRunId: source.runId,
        targetBaseSha,
        directorEpoch: 1,
        policyDigest: f.pd,
        phase: "validation",
        backend: `factory/integration-validation-${digest}`,
        requestedCpu: 1,
        requestedMemoryMb: 512,
        ...(name === "CapacityReserved"
          ? {
              localScopeBatch: {
                ...priorBatch,
                commandCount: 2,
                identity: {
                  ...priorBatch.identity,
                  runId: "successor",
                  invocationDigest: artifact.digest,
                },
              },
            }
          : {}),
      }),
    ),
    event({
      kind: "budget",
      event: "BudgetReconciled",
      phase: "validation",
      unit: "validation_milliseconds",
      amount: 12_963,
      usageId: `integration-validation-${digest}`,
    }),
    event({
      kind: "budget",
      event: "BudgetReconciled",
      phase: "management",
      unit: "model_tokens",
      amount: 75_039,
      usageId: `integration-review-${review.identityDigest}`,
    }),
  ];
  item.factoryEvents!.push(...receipts);
  expect(await f.runtime()).toMatchObject({ status: "verified", usage: { modelTokens: 75_069 } });
  return { candidate, review, receipts: structuredClone(receipts), digest };
}

/** Stop a waiting fixture through its transport boundary after the real gate ran. */
function interruptAfterIntegrationWait(f: Awaited<ReturnType<typeof successorFixture>>) {
  const unavailable = new PlatformUnavailableError(
    { kind: "server_error", retryAfterMs: 1 },
    new Error("fixture stopped after observing exact integration wait"),
  );
  const reader = vi.mocked(GitHubReader.prototype.readObjective);
  const read = reader.getMockImplementation()!;
  reader.mockImplementation(async (...args) => {
    if (f.messages.some((message) => message.includes("integration waiting:"))) throw unavailable;
    return read.apply({} as GitHubReader, args);
  });
  return unavailable;
}

async function isolatedSuccessorFixture(
  options: {
    nativeSource?: boolean;
    paid?: boolean;
    available?: boolean;
    fault?: "validation" | "cleanup";
    loseMergeResponse?: boolean;
  } = {},
) {
  return successorFixture({
    noJoin: true,
    foregroundPredecessor: true,
    staleRetainedBaseUntilRefresh: true,
    isolatedItem: "b",
    failCombinedTests: options.fault === "validation",
    ...(options.nativeSource === undefined ? {} : { nativeSource: options.nativeSource }),
    ...(options.loseMergeResponse === undefined
      ? {}
      : { loseMergeResponse: options.loseMergeResponse }),
    adoptedIsolatedValidation: {
      ...(options.paid === undefined ? {} : { paid: options.paid }),
      ...(options.available === undefined ? {} : { available: options.available }),
      ...(options.fault === undefined ? {} : { fault: options.fault }),
    },
  });
}

async function isolatedCandidate(f: Awaited<ReturnType<typeof isolatedSuccessorFixture>>) {
  const refs = [...f.refs].filter(
    ([ref]) => ref.includes("/merge-candidates/") && ref.includes("/work-item-9/"),
  );
  expect(refs).toHaveLength(1);
  const document = JSON.parse(
    f.git("show", `${refs[0]![1]}:.clockgrove-factory/control/merge-candidate.json`),
  ) as { identity: MergeCandidateIdentity };
  const candidate = await new MergeCandidateCheckpointStore(f.storage, f.leases).load(
    document.identity,
  );
  if (!candidate?.isolatedResource) throw new Error("fixture isolated completion missing");
  return candidate;
}

describe("Supervisor adopted isolated candidate validation", () => {
  it.each([false, true])(
    "validates a retained sibling in a distinct authorized sandbox, native=%s",
    async (nativeSource) => {
      const f = await isolatedSuccessorFixture({ nativeSource });
      const originalSource = structuredClone(f.planRecord.plan.items[1]!.source);
      expect(await f.run(), JSON.stringify(f.messages)).toMatchObject({
        status: "completed",
        runId: "successor",
      });
      expect(f.isolatedValidate).toHaveBeenCalledOnce();
      expect(f.review).toHaveBeenCalledOnce();
      expect(f.launch).not.toHaveBeenCalled();
      expect(f.isolatedResources.size).toBe(0);
      expect(f.refresh).toHaveBeenCalledOnce();
      const input = f.isolatedValidate.mock.calls[0]![0];
      const candidate = await isolatedCandidate(f);
      expect(input).toMatchObject({
        repository: "o/r",
        objective: 7,
        workItem: 9,
        attempt: 1,
        runId: "successor",
        policyDigest: f.pd,
        packet: { baseSha: f.planRecord.plan.expectedBaseSha, requirements: { trust: "isolated" } },
        validationInvocation: {
          kind: "integration-candidate",
          identityDigest: mergeCandidateIdentityDigest(candidate.identity),
          artifactDigest: candidate.validation.artifactDigest,
          baseSha: candidate.identity.targetBaseSha,
        },
      });
      expect(input.runId).not.toBe(originalSource!.runId);
      expect(candidate.identity).toMatchObject({
        sourceHeadSha: originalSource!.publication!.headSha,
        deliveryHeadSha: f.refresh.mock.calls[0]![0].afterOid,
      });
      expect(candidate.isolatedResource).toMatchObject({
        backend: "codex-cli/daytona",
        invocationOwnershipDigest: validationInvocationOwnership(input),
      });
      expect(candidate.validation.environmentIdentity).toBe(
        `docker.io/library/node@sha256:${"a".repeat(64)}`,
      );
      expect(f.validate.mock.calls.every(([call]) => Boolean(call.isolatedValidator))).toBe(true);
      expect(f.planRecord.plan.items[1]!.source).toEqual(originalSource);
      expect(
        [
          ...f.snapshot.factoryEvents!,
          ...f.snapshot.workItems.flatMap((item) => item.factoryEvents!),
        ].filter((entry) => entry.runId === "parallel"),
      ).toEqual(f.original);
      const events = f.snapshot.workItems[1]!.factoryEvents!;
      const capacity = events.filter(
        (entry) => entry.kind === "capacity" && entry.runId === "successor",
      );
      expect(capacity.map((entry) => entry.event)).toEqual([
        "CapacityReserved",
        "CapacityReconciled",
      ]);
      expect(capacity[0]).toMatchObject({
        sourceRunId: "parallel",
        attempt: 1,
        directorEpoch: input.directorEpoch,
        backend: `factory/integration-sandbox-${mergeCandidateIdentityDigest(candidate.identity)}`,
        isolatedValidation: {
          backend: "codex-cli/daytona",
          artifactDigest: input.artifact.digest,
          invocationOwnershipDigest: validationInvocationOwnership(input),
        },
      });
      expect(capacity[0]).not.toHaveProperty("localScopeBatch");
      const sandboxUsage = events.filter(
        (entry) =>
          entry.kind === "budget" &&
          entry.unit === "sandbox_milliseconds" &&
          entry.runId === "successor",
      );
      expect(sandboxUsage.map((entry) => entry.event)).toEqual([
        "BudgetReserved",
        "BudgetReconciled",
      ]);
      expect(sandboxUsage[1]).toMatchObject({
        amount: candidate.isolatedResource!.sandboxMilliseconds,
        usageId: `integration-validation-${mergeCandidateIdentityDigest(candidate.identity)}`,
      });
      for (const receipt of sandboxUsage) expect(receipt).not.toHaveProperty("attempt");
      expect(
        events.filter((entry) => entry.kind === "attempt" && entry.runId === "successor"),
      ).toEqual([]);
      expect(await f.runtime()).toMatchObject({
        status: "verified",
        usage: {
          modelTokens: 45,
          sandboxMinutesReserved: candidate.isolatedResource!.sandboxMilliseconds / 60_000,
        },
      });
    },
    30000,
  );

  it.each([
    { paid: false, available: true },
    { paid: true, available: false },
  ])(
    "refuses isolated successor admission before CAS with paid=$paid available=$available",
    async (options) => {
      const f = await isolatedSuccessorFixture(options);
      if (!options.paid) {
        // Availability is not paid authority. Keep the run policy valid while
        // leaving the registered provider outside its permitted routes.
        expect(f.policy.backendOrder).not.toContain("codex-cli/daytona");
        expect(f.policy.allowedPaidBackends).not.toContain("codex-cli/daytona");
      }
      expect(await f.run(), JSON.stringify(f.messages)).toMatchObject({
        status: "escalated",
        reason: expect.stringContaining(
          options.paid
            ? "independent Daytona adopted-candidate validator is unavailable or unauthorized"
            : "adopted candidate requires original and successor authorization for independent Daytona validation",
        ),
      });
      expect(f.refresh).not.toHaveBeenCalled();
      expect(f.isolatedValidate).not.toHaveBeenCalled();
      expect(f.validate).not.toHaveBeenCalled();
      expect(f.review).not.toHaveBeenCalled();
      expect(f.launch).not.toHaveBeenCalled();
      expect(f.refs.get(`refs/heads/${publicationBranch(7, 9, 1)}`)).toBe(f.heads[1]);
      expect(f.merge.mock.calls.map(([input]) => input.number)).toEqual([18]);
      expect(f.isolatedResources.size).toBe(0);
    },
    30000,
  );

  it.each(["native-usage", "review-usage", "merge-response"] as const)(
    "restarts after isolated %s loss without another resource, paid review, or charge",
    async (point) => {
      const f = await isolatedSuccessorFixture({ loseMergeResponse: point === "merge-response" });
      const write = vi
        .mocked(GitHubControlStore.prototype.addIssueComment)
        .getMockImplementation()!;
      let interrupted = false;
      vi.mocked(GitHubControlStore.prototype.addIssueComment).mockImplementation(
        async (node, body) => {
          if (
            !interrupted &&
            point !== "merge-response" &&
            decodeEventComments(body).some(
              (entry) =>
                entry.kind === "budget" &&
                entry.runId === "successor" &&
                entry.event === "BudgetReconciled" &&
                entry.unit ===
                  (point === "native-usage" ? "sandbox_milliseconds" : "model_tokens") &&
                entry.usageId?.startsWith(
                  point === "native-usage" ? "integration-validation-" : "integration-review-",
                ),
            )
          ) {
            interrupted = true;
            throw new PlatformUnavailableError(
              { kind: "server_error", retryAfterMs: 1 },
              new Error("fixture lost isolated accounting write"),
            );
          }
          return write(node, body);
        },
      );
      await expect(f.run()).rejects.toThrow(PlatformUnavailableError);
      const completed = await isolatedCandidate(f);
      expect(f.isolatedValidate).toHaveBeenCalledOnce();
      expect(f.isolatedResources.size).toBe(0);
      expect(f.review).toHaveBeenCalledTimes(point === "native-usage" ? 0 : 1);
      expect(f.launch).not.toHaveBeenCalled();
      expect(await f.run(), JSON.stringify(f.messages)).toMatchObject({ status: "completed" });
      expect(await isolatedCandidate(f)).toEqual(completed);
      expect(f.isolatedValidate).toHaveBeenCalledOnce();
      expect(f.review).toHaveBeenCalledOnce();
      expect(f.refresh).toHaveBeenCalledOnce();
      expect(f.launch).not.toHaveBeenCalled();
      const events = f.snapshot.workItems[1]!.factoryEvents!;
      expect(
        events.filter(
          (entry) =>
            entry.kind === "budget" &&
            entry.runId === "successor" &&
            entry.event === "BudgetReconciled" &&
            entry.unit === "sandbox_milliseconds",
        ),
      ).toEqual([
        expect.objectContaining({ amount: completed.isolatedResource!.sandboxMilliseconds }),
      ]);
      expect(
        events.filter(
          (entry) =>
            entry.kind === "budget" &&
            entry.runId === "successor" &&
            entry.event === "BudgetReconciled" &&
            entry.unit === "model_tokens",
        ),
      ).toEqual([expect.objectContaining({ amount: 15 })]);
      expect(await f.runtime()).toMatchObject({
        status: "verified",
        usage: {
          modelTokens: 45,
          sandboxMinutesReserved: completed.isolatedResource!.sandboxMilliseconds / 60_000,
        },
      });
    },
    30000,
  );

  it.each([false, true])(
    "preserves failed isolated validation usage without source replacement, unavailable mutable target=%s",
    async (unavailableTarget) => {
      const f = await isolatedSuccessorFixture({ fault: "validation" });
      const write = vi
        .mocked(GitHubControlStore.prototype.addIssueComment)
        .getMockImplementation()!;
      let interrupted = false;
      vi.mocked(GitHubControlStore.prototype.addIssueComment).mockImplementation(
        async (node, body) => {
          if (
            !interrupted &&
            decodeEventComments(body).some(
              (entry) =>
                entry.kind === "budget" &&
                entry.runId === "successor" &&
                entry.event === "BudgetReconciled" &&
                entry.unit === "sandbox_milliseconds",
            )
          ) {
            interrupted = true;
            expect(
              f.snapshot.workItems[1]!.factoryEvents!.some(
                (entry) =>
                  entry.kind === "capacity" &&
                  entry.runId === "successor" &&
                  entry.event === "CapacityReconciled" &&
                  entry.isolatedFailure,
              ),
            ).toBe(true);
            expect(f.isolatedResources.size).toBe(0);
            throw new PlatformUnavailableError(
              { kind: "server_error", retryAfterMs: 1 },
              new Error("fixture interrupted failed validation accounting"),
            );
          }
          return write(node, body);
        },
      );
      await expect(f.run()).rejects.toThrow(PlatformUnavailableError);
      expect(interrupted).toBe(true);
      expect(f.isolatedValidate).toHaveBeenCalledOnce();
      expect(f.isolatedResources.size).toBe(0);
      const result = await f.isolatedValidate.mock.results[0]!.value;
      expect(result).toMatchObject({
        passed: false,
        failureReason: expect.stringContaining("combined regression"),
      });
      expect(result.commands.at(-1)!.exitCode).not.toBe(0);
      expect([...f.refs.keys()].filter((ref) => ref.includes("/merge-candidates/"))).toEqual([]);
      expect(f.review).not.toHaveBeenCalled();
      expect(f.launch).not.toHaveBeenCalled();
      expect(f.merge.mock.calls.map(([input]) => input.number)).toEqual([18]);
      const events = f.snapshot.workItems[1]!.factoryEvents!;
      const capacities = events.filter(
        (entry) => entry.kind === "capacity" && entry.runId === "successor",
      );
      expect(capacities.map((entry) => entry.event)).toEqual([
        "CapacityReserved",
        "CapacityReconciled",
      ]);
      const completion = capacities[1];
      if (completion?.kind !== "capacity" || !completion.isolatedFailure)
        throw new Error("fixture exact failed completion absent");
      const failure = completion.isolatedFailure;
      expect(failure).toMatchObject({
        validationDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        validationStartedAt: result.startedAt,
        validationCompletedAt: result.completedAt,
      });
      expect(failure.sandboxMilliseconds).toBe(
        Date.parse(failure.completedAt) - Date.parse(failure.startedAt),
      );
      expect(completion.isolatedValidation!.invocationOwnershipDigest).toBe(
        validationInvocationOwnership(f.isolatedValidate.mock.calls[0]![0]),
      );
      const immutableCompletion = structuredClone(completion);
      const unavailableHead = "f".repeat(40);
      if (unavailableTarget) {
        // This is only a changed mutable branch observation, deliberately lacking
        // commit/provenance evidence. It does not invent an authenticated peer
        // integration. Historical rejection and usage repair must precede any
        // attempt to inspect or authorize this new target.
        expect(unavailableHead).not.toBe(completion.targetBaseSha);
        const previousHead = await f.store.getBranchHead("main");
        vi.mocked(GitHubControlStore.prototype.getBranchHead).mockResolvedValue({
          ...previousHead,
          oid: unavailableHead,
        });
      }
      const refreshesBeforeRestart = f.refresh.mock.calls.length;
      // The failed result is a separate durable rejection, never a successful
      // merge-candidate checkpoint. A restart only repairs its exact usage.
      expect(await f.run(), JSON.stringify(f.messages)).toMatchObject({
        status: "escalated",
        reason: expect.stringContaining(
          "adopted isolated candidate validation was durably rejected",
        ),
      });
      expect(f.isolatedReconcile).not.toHaveBeenCalled();
      expect(f.isolatedValidate).toHaveBeenCalledOnce();
      expect(f.isolatedResources.size).toBe(0);
      expect(f.review).not.toHaveBeenCalled();
      expect(f.launch).not.toHaveBeenCalled();
      expect(f.refresh).toHaveBeenCalledTimes(refreshesBeforeRestart);
      if (unavailableTarget)
        expect(
          vi.mocked(GitHubControlStore.prototype.readCommit).mock.calls.map(([oid]) => oid),
        ).not.toContain(unavailableHead);
      const current = f.snapshot.workItems[1]!.factoryEvents!;
      expect(current).toContainEqual(immutableCompletion);
      expect(
        current.filter((entry) => entry.kind === "capacity" && entry.runId === "successor"),
      ).toEqual(capacities);
      const usage = current.filter(
        (entry) =>
          entry.kind === "budget" &&
          entry.runId === "successor" &&
          entry.event === "BudgetReconciled",
      );
      expect(usage).toHaveLength(2);
      expect(usage).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            unit: "sandbox_milliseconds",
            amount: failure.sandboxMilliseconds,
            usageId: `integration-validation-${completion.backend.slice("factory/integration-sandbox-".length)}`,
          }),
          expect.objectContaining({
            unit: "validation_milliseconds",
            amount: Date.parse(result.completedAt) - Date.parse(result.startedAt),
            usageId: `integration-validation-${completion.backend.slice("factory/integration-sandbox-".length)}`,
          }),
        ]),
      );
      expect([...f.refs.keys()].filter((ref) => ref.includes("/merge-candidates/"))).toEqual([]);
      expect(f.merge.mock.calls.map(([input]) => input.number)).toEqual([18]);
      expect(f.planRecord.plan.items[1]!.source!.publication!.headSha).toBe(f.heads[1]);
      expect(f.snapshot.workItems[1]!.closed).toBe(false);
      expect(await f.runtime()).toMatchObject({
        status: "verified",
        usage: { modelTokens: 30, sandboxMinutesReserved: failure.sandboxMilliseconds / 60_000 },
      });
    },
    30000,
  );

  it("retains unknown isolated termination and refuses a replacement candidate after restart", async () => {
    const f = await isolatedSuccessorFixture({ fault: "cleanup" });
    const first = await f.run().catch((error: unknown) => error);
    expect(first).toBeInstanceOf(DaytonaResourceCleanupError);
    expect((first as Error).message).toMatch(/termination|completion|reconciliation|replacement/);
    expect(f.isolatedValidate).toHaveBeenCalledOnce();
    expect(f.isolatedResources.size).toBe(1);
    expect([...f.refs.keys()].filter((ref) => ref.includes("/merge-candidates/"))).toEqual([]);
    const restarted = await f.run().catch((error: unknown) => error);
    expect(restarted, JSON.stringify(restarted)).toBeInstanceOf(DaytonaResourceCleanupError);
    expect(f.isolatedValidate).toHaveBeenCalledOnce();
    expect(f.isolatedReconcile).toHaveBeenCalled();
    const input = f.isolatedValidate.mock.calls[0]![0];
    const stale = f.isolatedReconcile.mock.calls.at(-1)![0];
    expect(stale).toMatchObject({
      repository: input.repository,
      objective: input.objective,
      runId: "successor",
      workItem: 9,
      attempt: 1,
      directorEpoch: input.directorEpoch,
      policyDigest: input.policyDigest,
      phase: "validation",
      validationInvocation: input.validationInvocation,
    });
    expect(validationInvocationOwnership(stale)).toBe(validationInvocationOwnership(input));
    expect(Date.parse(stale.noHandleReplacementNotBefore!)).toBeGreaterThanOrEqual(
      input.deadline.getTime() + 60_000,
    );
    expect(f.review).not.toHaveBeenCalled();
    expect(f.launch).not.toHaveBeenCalled();
    expect(f.merge.mock.calls.map(([input]) => input.number)).toEqual([18]);
    const events = f.snapshot.workItems[1]!.factoryEvents!;
    expect(
      events
        .filter((entry) => entry.kind === "capacity" && entry.runId === "successor")
        .map((entry) => entry.event),
    ).toEqual(["CapacityReserved"]);
    expect(
      events
        .filter(
          (entry) =>
            entry.kind === "budget" &&
            entry.runId === "successor" &&
            entry.unit === "sandbox_milliseconds",
        )
        .map((entry) => entry.event),
    ).toEqual(["BudgetReserved"]);
    expect(
      f.snapshot.factoryEvents!.filter(
        (entry) =>
          entry.runId === "successor" &&
          ["FactoryRunCompleted", "FactoryRunEscalated", "FactoryRunCancelled"].includes(
            entry.event,
          ),
      ),
    ).toEqual([]);
  }, 30000);
});

describe("Supervisor authenticated successor execution", () => {
  it("refreshes a retained ordinary foreground PR without relabelling its paid old-head candidate", async () => {
    const f = await successorFixture({
      foregroundPredecessor: true,
      historicalSuccessor: true,
      staleRetainedBaseUntilRefresh: true,
    });
    const old = await retainOldHeadSuccessorCandidate(f);
    const plan = structuredClone(f.planRecord);
    const before = await f.store.readPullRequest(19);
    expect(before.baseSha).toBe(f.baseSha);
    expect((await f.readCommit(before.mergeCommitSha!)).parentOids).toEqual([
      f.baseSha,
      f.heads[1],
    ]);
    expect(await f.run(), JSON.stringify(f.messages)).toMatchObject({ status: "completed" });
    expect(f.refresh).toHaveBeenCalledOnce();
    const cas = f.refresh.mock.calls[0]![0];
    expect(cas).toMatchObject({
      ref: `refs/heads/${publicationBranch(7, 9, 1)}`,
      beforeOid: f.heads[1],
    });
    const changedHead = await f.readCommit(cas.afterOid);
    expect(changedHead.parentOids).toEqual([f.heads[1], plan.plan.expectedBaseSha]);
    expect(f.planRecord).toEqual(plan);
    expect(f.launch.mock.calls.map(([context]) => context.workItem)).toEqual([10]);
    expect(f.review).toHaveBeenCalledTimes(2);
    const manager = new MergeCandidateCheckpointStore(f.storage, f.leases);
    expect(await manager.load(old.candidate.identity)).toEqual(old.candidate);
    expect(
      await new ReviewCheckpointManager(f.storage, f.leases).load(old.review.identity),
    ).toEqual(old.review);
    const current = await manager.load({
      ...old.candidate.identity,
      deliveryHeadSha: cas.afterOid,
    });
    expect(current).toMatchObject({
      source: old.candidate.source,
      identity: { sourceHeadSha: f.heads[1], deliveryHeadSha: cas.afterOid },
      validation: { outputTreeSha: changedHead.treeOid },
    });
    expect(current!.validation.digest).not.toBe(old.candidate.validation.digest);
    expect(f.review.mock.calls[0]![0].evidence.digest).toBe(current!.validation.digest);
    expect(
      await new ReviewCheckpointManager(f.storage, f.leases).load({
        ...old.review.identity,
        artifactDigest: current!.validation.artifactDigest,
        evidenceDigest: current!.validation.digest,
        outputTreeSha: current!.validation.outputTreeSha,
        headSha: cas.afterOid,
      }),
    ).toMatchObject({ review: { accepted: true }, identity: { headSha: cas.afterOid } });
    const events = f.snapshot.workItems[1]!.factoryEvents!;
    for (const receipt of old.receipts) {
      expect(events).toContainEqual(receipt);
      if (receipt.kind === "budget")
        expect(
          events.filter(
            (entry) =>
              entry.kind === "budget" &&
              entry.runId === receipt.runId &&
              entry.usageId === receipt.usageId,
          ),
        ).toHaveLength(1);
    }
    const predecessorEvents = [
      ...f.snapshot.factoryEvents!,
      ...f.snapshot.workItems.flatMap((item) => item.factoryEvents!),
    ].filter((entry) => entry.runId === "parallel");
    expect(predecessorEvents).toEqual(f.original);
    expect(
      events.filter((entry) => entry.kind === "attempt" && entry.runId === "successor"),
    ).toEqual([]);
    expect(events.filter((entry) => entry.event === "PublicationRecorded")).toHaveLength(1);
    expect(events.find((entry) => entry.event === "PublicationRecorded")).toMatchObject({
      runId: "parallel",
      headSha: f.heads[1],
    });
    const capacities = events.filter(
      (entry) =>
        entry.kind === "capacity" &&
        entry.event === "CapacityReserved" &&
        entry.runId === "successor",
    );
    expect(capacities).toHaveLength(2);
    expect(capacities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ backend: `factory/integration-validation-${old.digest}` }),
        expect.objectContaining({
          backend: `factory/integration-validation-${mergeCandidateIdentityDigest(current!.identity)}`,
        }),
      ]),
    );
    expect((await f.readCommit(f.mergeShas.get(19)!)).parentOids).toEqual([
      plan.plan.expectedBaseSha,
    ]);
    expect((await f.readCommit(f.mergeShas.get(19)!)).treeOid).toBe(changedHead.treeOid);
    expect(await f.runtime()).toMatchObject({ status: "verified", usage: { modelTokens: 75_119 } });
  }, 30000);

  it("reconciles a lost ordinary refresh CAS response with the same intent and historical accounting", async () => {
    const f = await successorFixture({
      foregroundPredecessor: true,
      historicalSuccessor: true,
      staleRetainedBaseUntilRefresh: true,
      loseSiblingRefreshResponse: true,
    });
    const old = await retainOldHeadSuccessorCandidate(f);
    await expect(f.run()).rejects.toThrow(PlatformUnavailableError);
    expect(f.refresh).toHaveBeenCalledOnce();
    const plannedHead = f.refresh.mock.calls[0]![0].afterOid;
    const refreshRefs = [...f.refs].filter(([ref]) => ref.includes("/sibling-refreshes/"));
    expect(refreshRefs).not.toHaveLength(0);
    expect(f.review).not.toHaveBeenCalled();
    expect(f.launch).not.toHaveBeenCalled();
    expect(await f.run(), JSON.stringify(f.messages)).toMatchObject({ status: "completed" });
    expect(f.refresh).toHaveBeenCalledOnce();
    expect([...f.refs].filter(([ref]) => ref.includes("/sibling-refreshes/"))).toEqual(refreshRefs);
    expect(f.snapshot.workItems[1]!.linkedPullRequests[0]!.headSha).toBe(plannedHead);
    expect(f.launch.mock.calls.map(([context]) => context.workItem)).toEqual([10]);
    expect(f.review).toHaveBeenCalledTimes(2);
    for (const receipt of old.receipts)
      expect(f.snapshot.workItems[1]!.factoryEvents).toContainEqual(receipt);
    expect(await f.runtime()).toMatchObject({ status: "verified", usage: { modelTokens: 75_119 } });
  }, 30000);

  it("does not rewrite a provider-owned retained branch to repair its stale preview", async () => {
    const f = await successorFixture({
      providerOwnedRetainedBranch: true,
      staleRetainedBaseUntilRefresh: true,
    });
    const unavailable = interruptAfterIntegrationWait(f);
    await expect(f.run()).rejects.toBe(unavailable);
    expect(f.refresh).not.toHaveBeenCalled();
    expect(f.merge.mock.calls.map(([input]) => input.number)).toEqual([18]);
    expect(f.refs.get("refs/heads/provider/retained-b")).toBe(f.heads[1]);
    expect(f.launch).not.toHaveBeenCalled();
    expect(f.messages.some((message) => message.includes("integration waiting:"))).toBe(true);
  }, 30000);

  it("refuses an isolated retained candidate before changing its owned ordinary branch", async () => {
    const f = await successorFixture({
      isolatedItem: "b",
      staleRetainedBaseUntilRefresh: true,
    });
    const originalHead = f.snapshot.workItems[1]!.linkedPullRequests[0]!.headSha;
    expect(await f.run(), JSON.stringify(f.messages)).toMatchObject({
      status: "escalated",
      reason: expect.stringContaining(
        "adopted candidate requires original and successor authorization for independent Daytona validation",
      ),
    });
    expect(f.refresh).not.toHaveBeenCalled();
    expect(f.validate).not.toHaveBeenCalled();
    expect(f.review).not.toHaveBeenCalled();
    expect(f.launch).not.toHaveBeenCalled();
    expect(f.refs.get(`refs/heads/${publicationBranch(7, 9, 1)}`)).toBe(originalHead);
    expect(f.merge.mock.calls.map(([input]) => input.number)).toEqual([18]);
    expect([...f.refs.keys()].filter((ref) => ref.includes("/sibling-refreshes/"))).toEqual([]);
  }, 30000);

  it.each([
    ["review", "model_tokens", 75_039],
    ["validation", "validation_milliseconds", 12_963],
  ] as const)(
    "repairs the completed old-head %s's missing usage receipt before ordinary refresh CAS",
    async (phase, unit, amount) => {
      const f = await successorFixture({
        foregroundPredecessor: true,
        historicalSuccessor: true,
        staleRetainedBaseUntilRefresh: true,
      });
      const old = await retainOldHeadSuccessorCandidate(f);
      const item = f.snapshot.workItems[1]!;
      const usageId =
        phase === "review"
          ? `integration-review-${old.review.identityDigest}`
          : `integration-validation-${old.digest}`;
      item.factoryEvents = item.factoryEvents!.filter(
        (entry) => !(entry.kind === "budget" && entry.usageId === usageId),
      );
      const cas = f.refresh.getMockImplementation()!;
      f.refresh.mockImplementation(async (input) => {
        // The repair is an authenticated usage write from the immutable result,
        // not another management invocation or a changed-head acceptance.
        expect(
          item.factoryEvents!.filter(
            (entry) => entry.kind === "budget" && entry.usageId === usageId,
          ),
        ).toEqual([
          expect.objectContaining({
            runId: "successor",
            amount,
            unit,
            event: "BudgetReconciled",
          }),
        ]);
        expect(f.validate).not.toHaveBeenCalled();
        expect(f.review).not.toHaveBeenCalled();
        return cas(input);
      });
      expect(await f.run(), JSON.stringify(f.messages)).toMatchObject({ status: "completed" });
      expect(f.refresh).toHaveBeenCalledOnce();
      expect(f.review).toHaveBeenCalledTimes(2);
      expect(f.launch.mock.calls.map(([context]) => context.workItem)).toEqual([10]);
      expect(
        await new ReviewCheckpointManager(f.storage, f.leases).load(old.review.identity),
      ).toEqual(old.review);
      expect(
        item.factoryEvents!.filter((entry) => entry.kind === "budget" && entry.usageId === usageId),
      ).toHaveLength(1);
      expect(await f.runtime()).toMatchObject({
        status: "verified",
        usage: { modelTokens: 75_119 },
      });
    },
    30000,
  );

  it.each(["review", "validation"] as const)(
    "refuses conflicting old-head %s accounting before ordinary refresh CAS",
    async (phase) => {
      const f = await successorFixture({
        foregroundPredecessor: true,
        historicalSuccessor: true,
        staleRetainedBaseUntilRefresh: true,
      });
      const old = await retainOldHeadSuccessorCandidate(f);
      const usageId =
        phase === "review"
          ? `integration-review-${old.review.identityDigest}`
          : `integration-validation-${old.digest}`;
      const receipt = f.snapshot.workItems[1]!.factoryEvents!.find(
        (entry) => entry.kind === "budget" && entry.usageId === usageId,
      );
      if (receipt?.kind !== "budget") throw new Error("fixture old usage receipt absent");
      receipt.amount = 0;
      expect(await f.run(), JSON.stringify(f.messages)).toMatchObject({
        status: "escalated",
        reason: expect.stringContaining("successor usage conflicts with immutable evidence"),
      });
      expect(f.refresh).not.toHaveBeenCalled();
      expect(f.validate).not.toHaveBeenCalled();
      expect(f.review).not.toHaveBeenCalled();
      expect(f.launch).not.toHaveBeenCalled();
      expect(f.refs.get(`refs/heads/${publicationBranch(7, 9, 1)}`)).toBe(f.heads[1]);
      expect(f.merge.mock.calls.map(([input]) => input.number)).toEqual([18]);
      expect(
        await new ReviewCheckpointManager(f.storage, f.leases).load(old.review.identity),
      ).toEqual(old.review);
      expect(receipt.amount).toBe(0);
    },
    30000,
  );

  it("refuses an old reconciled validator whose immutable completion is missing before CAS", async () => {
    const f = await successorFixture({
      foregroundPredecessor: true,
      historicalSuccessor: true,
      staleRetainedBaseUntilRefresh: true,
    });
    const old = await retainOldHeadSuccessorCandidate(f);
    f.refs.delete(old.candidate.ref);
    // Runtime reconstruction sees the completion-bound capacity receipt before
    // the refresh path: no invented duration or replacement invocation can
    // repair an absent immutable completion.
    expect(await f.runtime()).toMatchObject({
      status: "blocked",
      blockers: ["source-capacity-completion-unavailable"],
    });
    expect(f.refresh).not.toHaveBeenCalled();
    expect(f.validate).not.toHaveBeenCalled();
    expect(f.review).not.toHaveBeenCalled();
    expect(f.launch).not.toHaveBeenCalled();
    expect(f.refs.get(`refs/heads/${publicationBranch(7, 9, 1)}`)).toBe(f.heads[1]);
    expect(f.merge.mock.calls.map(([input]) => input.number)).toEqual([18]);
  }, 30000);

  it.each([
    ["completion", "source-capacity-prior-completion-unavailable"],
    ["reconciliation", "source-capacity-prior-reconciliation-unavailable"],
    ["accounting", "source-capacity-prior-accounting-unavailable"],
    ["artifact", "source-capacity-prior-artifact-mismatch"],
  ] as const)(
    "refuses to reinterpret old-head capacity after CAS with missing or conflicting %s",
    async (fault, blocker) => {
      const f = await successorFixture({
        foregroundPredecessor: true,
        historicalSuccessor: true,
        staleRetainedBaseUntilRefresh: true,
        loseSiblingRefreshResponse: true,
      });
      const old = await retainOldHeadSuccessorCandidate(f);
      await expect(f.run()).rejects.toThrow(PlatformUnavailableError);
      const item = f.snapshot.workItems[1]!;
      if (fault === "completion") f.refs.delete(old.candidate.ref);
      if (fault === "reconciliation")
        item.factoryEvents = item.factoryEvents!.filter(
          (entry) =>
            !(
              entry.kind === "capacity" &&
              entry.event === "CapacityReconciled" &&
              entry.backend === `factory/integration-validation-${old.digest}`
            ),
        );
      if (fault === "accounting") {
        const receipt = item.factoryEvents!.find(
          (entry) =>
            entry.kind === "budget" && entry.usageId === `integration-validation-${old.digest}`,
        );
        if (receipt?.kind !== "budget") throw new Error("fixture old native usage absent");
        receipt.amount = 0;
      }
      if (fault === "artifact") {
        const reserved = item.factoryEvents!.find(
          (entry) =>
            entry.kind === "capacity" &&
            entry.event === "CapacityReserved" &&
            entry.backend === `factory/integration-validation-${old.digest}`,
        );
        if (reserved?.kind !== "capacity" || !reserved.localScopeBatch)
          throw new Error("fixture old validator scope absent");
        reserved.localScopeBatch.identity.invocationDigest = "0".repeat(64);
      }
      expect(await f.runtime()).toMatchObject({ status: "blocked", blockers: [blocker] });
      expect(f.refresh).toHaveBeenCalledOnce();
      expect(f.review).not.toHaveBeenCalled();
      expect(f.launch).not.toHaveBeenCalled();
      expect(f.merge.mock.calls.map(([input]) => input.number)).toEqual([18]);
    },
    30000,
  );

  it.each(["missing", "old-parents"] as const)(
    "does not merge a refreshed ordinary head with %s preview evidence",
    async (refreshedPreview) => {
      const f = await successorFixture({ staleRetainedBaseUntilRefresh: true, refreshedPreview });
      const unavailable = interruptAfterIntegrationWait(f);
      await expect(f.run()).rejects.toBe(unavailable);
      expect(f.refresh).toHaveBeenCalledOnce();
      expect(f.review).toHaveBeenCalledOnce();
      expect(f.merge.mock.calls.map(([input]) => input.number)).toEqual([18]);
      expect(f.launch).not.toHaveBeenCalled();
      expect(
        f.snapshot.workItems[1]!.factoryEvents!.some(
          (entry) => entry.event === "RecoverySourceIntegrated",
        ),
      ).toBe(false);
    },
    30000,
  );

  it("refuses a third retained head after fresh review without another CAS or integration", async () => {
    const f = await successorFixture({ staleRetainedBaseUntilRefresh: true });
    const review = f.review.getMockImplementation()!;
    f.review.mockImplementationOnce(async (...args) => {
      const result = await review(...args);
      f.snapshot.workItems[1]!.linkedPullRequests[0]!.headSha = f.heads[0]!;
      f.refs.set(`refs/heads/${publicationBranch(7, 9, 1)}`, f.heads[0]!);
      return result;
    });
    expect(await f.run()).toMatchObject({ status: "escalated" });
    expect(f.refresh).toHaveBeenCalledOnce();
    expect(f.review).toHaveBeenCalledOnce();
    expect(f.launch).not.toHaveBeenCalled();
    expect(f.merge.mock.calls.map(([input]) => input.number)).toEqual([18]);
  }, 30000);

  it("refuses a refreshed ordinary preview whose tree differs from the accepted candidate", async () => {
    const f = await successorFixture({
      staleRetainedBaseUntilRefresh: true,
      wrongPreviewTree: true,
    });
    expect(await f.run()).toMatchObject({ status: "escalated" });
    expect(f.refresh).toHaveBeenCalledOnce();
    expect(f.review).toHaveBeenCalledOnce();
    expect(f.merge.mock.calls.map(([input]) => input.number)).toEqual([18]);
    expect(f.launch).not.toHaveBeenCalled();
  }, 30000);

  it.each([false, true])(
    "finalizes a fully accounted successor after deadline, prior integration=%s",
    async (premerged) => {
      const f = await successorFixture({ nativeSource: true, completeSourceScopeEvidence: true });
      const close = vi.mocked(GitHubControlStore.prototype.closeIssue);
      const original = close.getMockImplementation()!;
      const unavailable = new PlatformUnavailableError(
        { kind: "rate_limit", retryAfterMs: 60_000 },
        new Error("closure quota exhausted"),
      );
      close.mockImplementation(async (number) => {
        if (number === 7) throw unavailable;
        return original(number);
      });
      await expect(f.run()).rejects.toBe(unavailable);
      close.mockImplementation(original);
      const priorWriter = f.snapshot.factoryEvents!.find(
        (event) => event.event === "ControllerObserved" && event.runId === "successor",
      );
      expect(priorWriter?.writerEpoch).toBe(1);
      if (premerged) expect(f.planRecord.plan.items[0]!.action).toBe("integrated");
      // The already-integrated source keeps its original predecessor receipt;
      // a redundant successor outcome is not required for closure authority.
      if (premerged)
        f.snapshot.workItems[0]!.factoryEvents = f.snapshot.workItems[0]!.factoryEvents!.filter(
          (event) => event.event !== "RecoverySourceIntegrated",
        );
      else {
        const capacity = f.snapshot.workItems
          .flatMap((item) => item.factoryEvents!)
          .find(
            (event) =>
              event.kind === "capacity" && event.event === "CapacityReserved" && event.sourceRunId,
          );
        expect(capacity?.kind).toBe("capacity");
        if (capacity?.kind !== "capacity") throw new Error("fixture source capacity");
        expect(capacity.localScopeBatch!.identity.directorEpoch).toBe(
          capacity.recoveryEpoch ?? capacity.directorEpoch,
        );
      }
      const before = structuredClone(f.snapshot.workItems.flatMap((item) => item.factoryEvents!));
      const starts = f.launch.mock.calls.length;
      const reviews = f.review.mock.calls.length;
      const merges = f.merge.mock.calls.length;
      const start = f.snapshot.factoryEvents!.find(
        (event) => event.event === "FactoryRunStarted" && event.runId === "successor",
      )!;
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.parse(start.at) + f.policy.objectiveTimeoutMinutes * 60_000 + 60_000);
      try {
        expect(await f.run(), f.messages.join("; ")).toMatchObject({
          status: "completed",
          runId: "successor",
        });
        expect(f.launch).toHaveBeenCalledTimes(starts);
        expect(f.review).toHaveBeenCalledTimes(reviews);
        expect(f.merge).toHaveBeenCalledTimes(merges);
        expect(f.snapshot.workItems.flatMap((item) => item.factoryEvents!)).toEqual(before);
        const receipts = latestRunReceipts(f.snapshot.factoryEvents!);
        expect(receipts?.terminal).toMatchObject({ event: "FactoryRunCompleted", writerEpoch: 2 });
        expect(
          receipts?.events.some(
            (event) => event.event === "ControllerObserved" && event.writerEpoch === 2,
          ),
        ).toBe(true);
        const delayedOldTerminal = parseFactoryEvent({
          ...receipts!.terminal!,
          writerOperationId: "fixture-delayed-old-terminal",
          writerHolder: priorWriter!.writerHolder,
          writerEpoch: 1,
          sequence: receipts!.terminal!.sequence + 1,
          event: "FactoryRunEscalated",
        });
        expect(
          latestRunReceipts([...f.snapshot.factoryEvents!, delayedOldTerminal])?.terminal,
        ).toEqual(receipts!.terminal);
      } finally {
        vi.useRealTimers();
      }
    },
    60_000,
  );

  it("restores retained artifact B beside published A and executes only fresh C", async () => {
    const f = await successorFixture({
      retainedPrefix: 2,
      stackLength: 3,
      nativeSource: true,
      mixedRetainedPublication: true,
    });
    expect(f.planRecord.plan.items[0]!.source!.publication).not.toBeNull();
    expect(f.planRecord.plan.items[1]!.source!.publication).toBeNull();
    const result = await f.run();
    expect(result, JSON.stringify(result)).toMatchObject({ status: "completed" });
    expect(f.launch).toHaveBeenCalledTimes(1);
    expect(await f.runtime()).toMatchObject({ status: "verified" });
  }, 60_000);
  it.each([
    { omitMergedNativePrefix: false, retainedPrefix: 2 as const, stackLength: 3 as const },
    { omitMergedNativePrefix: true, retainedPrefix: 2 as const, stackLength: 3 as const },
    { omitMergedNativePrefix: true, retainedPrefix: 3 as const, stackLength: 4 as const },
  ])(
    "preserves revalidated source reservations across $stackLength layers, omitted prefix=$omitMergedNativePrefix",
    async ({ omitMergedNativePrefix, retainedPrefix, stackLength }) => {
      const f = await successorFixture({
        retainedPrefix,
        stackLength,
        nativeSource: true,
        premergedNativeRoot: true,
        omitMergedNativePrefix,
      });
      const reserved = f.snapshot.workItems[1]!.factoryEvents!.find(
        (event) => event.event === "AttemptReserved",
      )!;
      if (reserved.kind !== "attempt") throw new Error("fixture original reservation");
      expect(f.planRecord.plan.items[1]!.source!.validation!.baseSha).not.toBe(reserved.baseSha);
      const result = await f.run();
      expect(result, JSON.stringify(result)).toMatchObject({ status: "completed" });
      expect(f.launch).toHaveBeenCalledTimes(1);
      const runtime = await f.runtime();
      expect(runtime).toMatchObject({ status: "verified" });
      if (runtime.status !== "verified") throw new Error("fixture recovery proof unavailable");
      expect(runtime.sourceIntegrations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            status: "verified",
            outcome: expect.objectContaining({ workItem: 8, mergeCommitSha: f.mergeShas.get(18) }),
          }),
        ]),
      );
      expect(
        [
          ...f.snapshot.factoryEvents!,
          ...f.snapshot.workItems.flatMap((item) => item.factoryEvents!),
        ].filter((event) => event.runId === "parallel"),
      ).toEqual(f.original);
    },
    60_000,
  );
  it("rejects a changed remaining stack membership before integrating a retained upper", async () => {
    const f = await successorFixture({
      retainedPrefix: 2,
      stackLength: 3,
      nativeSource: true,
      dropUpperAfterMerge: true,
    });
    expect(await f.run()).toMatchObject({
      status: "escalated",
      reason: "partially integrated native stack membership changed",
    });
    expect(f.mergeShas.has(18)).toBe(true);
    expect(f.mergeShas.has(19)).toBe(false);
    expect(f.mergeShas.has(20)).toBe(false);
  }, 60_000);
  it("rejects a changed retained root without launching its child", async () => {
    const f = await successorFixture({ retainedPrefix: 1, stackLength: 2, nativeSource: true });
    f.refs.set(`refs/heads/${publicationBranch(7, 8, 1)}`, f.baseSha);
    const result = await f.run().catch((error: unknown) => ({ status: "blocked", error }));
    expect(result.status).not.toBe("completed");
    expect(f.launch).not.toHaveBeenCalled();
    expect(f.merge).not.toHaveBeenCalled();
  });
  it("rejects a pre-activation root without its authenticated validation before child execution", async () => {
    const f = await successorFixture({
      retainedPrefix: 2,
      stackLength: 3,
      nativeSource: true,
      premergedNativeRoot: true,
    });
    const root = f.snapshot.workItems[0]!;
    root.factoryEvents = root.factoryEvents!.filter(
      (event) => event.event !== "ValidationRecorded",
    );
    const merges = f.merge.mock.calls.length;
    const result = await f.run().catch((error: unknown) => ({ status: "blocked", error }));
    expect(result.status).not.toBe("completed");
    expect(f.launch).not.toHaveBeenCalled();
    expect(f.merge).toHaveBeenCalledTimes(merges);
  });
  it.each([
    { retainedPrefix: 2 as const, stackLength: 3 as const, premergedNativeRoot: false },
    { retainedPrefix: 2 as const, stackLength: 3 as const, premergedNativeRoot: true },
    { retainedPrefix: 3 as const, stackLength: 4 as const, premergedNativeRoot: true },
  ])(
    "inherits isolated intermediate B before fresh native admission across $stackLength layers, premerged=$premergedNativeRoot",
    async (options) => {
      const f = await successorFixture({ ...options, nativeSource: true, isolatedItem: "b" });
      const evaluate = vi.spyOn(BackendRegistry.prototype, "evaluate");
      const merges = f.merge.mock.calls.length;
      const result = await f.run();
      expect(result.status).toBe("escalated");
      expect(evaluate, JSON.stringify(result)).toHaveBeenCalled();
      expect(evaluate.mock.calls.every(([input]) => input.requirements.trust === "isolated")).toBe(
        true,
      );
      expect(f.launch).not.toHaveBeenCalled();
      expect(f.merge).toHaveBeenCalledTimes(merges);
      expect(
        f.snapshot.workItems
          .flatMap((item) => item.factoryEvents!)
          .filter((event) => event.runId === "successor" && event.event === "AttemptReserved"),
      ).toEqual([]);
    },
    60_000,
  );
  it("binds inherited intermediate isolation into the reserved and launched child packet", async () => {
    const f = await successorFixture({
      retainedPrefix: 2,
      stackLength: 3,
      nativeSource: true,
      premergedNativeRoot: true,
      isolatedItem: "b",
      isolatedWorker: true,
    });
    const evaluate = vi.spyOn(BackendRegistry.prototype, "evaluate");
    const validators = vi.spyOn(BackendRegistry.prototype, "evaluateIsolatedValidators");
    const stop = new PlatformUnavailableError(
      { kind: "server_error", retryAfterMs: 1 },
      new Error("fixture stops at isolated child dispatch boundary"),
    );
    f.launch.mockImplementation(async (context) => {
      expect(context.packet.requirements.trust).toBe("isolated");
      expect(context.packet.baseSha).toBe(f.snapshot.workItems[1]!.linkedPullRequests[0]!.headSha);
      throw stop;
    });
    await expect(f.run()).rejects.toThrow(
      "launch failed before returning a handle and cannot prove that no resource was created",
    );
    expect(f.launch).toHaveBeenCalledTimes(1);
    expect(evaluate.mock.calls.every(([input]) => input.requirements.trust === "isolated")).toBe(
      true,
    );
    expect(validators.mock.calls.some(([input]) => input.requirements.trust === "isolated")).toBe(
      true,
    );
    const context = f.launch.mock.calls[0]![0];
    const reserved = f.snapshot.workItems[2]!.factoryEvents!.find(
      (event) => event.runId === "successor" && event.event === "AttemptReserved",
    );
    expect(reserved).toMatchObject({
      backend: "fixture/isolated-worker",
      localScopeBatch: { identity: { invocationDigest: workerPacketDigest(context.packet) } },
    });
    expect(
      [
        ...f.snapshot.factoryEvents!,
        ...f.snapshot.workItems.flatMap((item) => item.factoryEvents!),
      ].filter((event) => event.runId === "parallel"),
    ).toEqual(f.original);
  }, 30_000);
  it("restarts a mixed native unit after linking loses its response without duplicate execution", async () => {
    const f = await successorFixture({
      retainedPrefix: 1,
      stackLength: 3,
      nativeSource: true,
      loseStackLinkResponse: true,
    });
    await expect(f.run()).rejects.toThrow("platform unavailable");
    expect(f.launch).toHaveBeenCalledTimes(2);
    expect(await f.run()).toMatchObject({ status: "completed" });
    expect(f.launch).toHaveBeenCalledTimes(2);
  }, 30_000);
  it("retains request A when its poll returns pending request B", async () => {
    const f = await successorFixture({
      retainedPrefix: 1,
      stackLength: 2,
      nativeSource: true,
      nativeUuidDrift: true,
    });
    const result = await f.run();
    expect(result).toMatchObject({
      status: "escalated",
      reason: expect.stringContaining("changed the exact request UUID"),
    });
    const polls = vi.mocked(GitHubStacks.prototype.mergeResult).mock.calls;
    expect(polls).toHaveLength(1);
    expect(polls[0]).toEqual([19, "request-a", expect.stringMatching(/^[0-9a-f]{40}$/)]);
    const oid = f.refs.get(integrationAdmissionRef("o/r", "main"))!;
    const message = (await f.storage.readCommit(oid)).message;
    const line = message.split(/\r?\n/).find((value) => value.startsWith("Factory-Integration: "))!;
    expect(JSON.parse(Buffer.from(line.slice(21), "base64url").toString("utf8"))).toMatchObject({
      state: "dispatched",
      dispatch: {
        kind: "native",
        expectedHeadSha: polls[0]![2],
        asynchronousMergeUuid: "request-a",
      },
    });
  }, 30_000);
  it.each([
    { retainedPrefix: 1 as const, stackLength: 2 as const },
    { retainedPrefix: 1 as const, stackLength: 3 as const },
    { retainedPrefix: 2 as const, stackLength: 3 as const },
  ])(
    "completes retained native prefix $retainedPrefix of $stackLength without rebuilding it",
    async (options) => {
      const f = await successorFixture({ ...options, nativeSource: true });
      const result = await f.run();
      expect(result, JSON.stringify(f.snapshot.factoryEvents?.at(-1))).toMatchObject({
        status: "completed",
      });
      expect(f.launch).toHaveBeenCalledTimes(options.stackLength - options.retainedPrefix);
      expect(f.snapshot.workItems.every((item) => item.closed)).toBe(true);
      const events = [
        ...f.snapshot.factoryEvents!,
        ...f.snapshot.workItems.flatMap((item) => item.factoryEvents!),
      ];
      expect(events.filter((event) => event.runId === "parallel")).toEqual(f.original);
      expect(events.filter((event) => event.event === "RecoverySourceIntegrated")).toHaveLength(
        options.retainedPrefix,
      );
      const terminalRuntime = await f.runtime();
      expect(
        terminalRuntime,
        JSON.stringify(terminalRuntime.status === "blocked" ? terminalRuntime : null),
      ).toMatchObject({ status: "verified" });
    },
    60_000,
  );
  // The failure-and-recovery variant can execute two complete successor
  // generations plus real Git recovery proofs. Its 120-second watchdog only
  // gives coordinated coverage headroom; production limits are unchanged.
  it.each([
    { artifactOnly: false, failC: false },
    { artifactOnly: true, failC: false },
    { artifactOnly: false, failC: true },
  ])(
    "continues an explicit second successor without recompilation or repeated source delivery (%j)",
    async ({ artifactOnly, failC }) => {
      const f = await successorFixture({ tokenLimit: failC ? 1000 : 45, artifactOnly, failC });
      expect(await f.run(), JSON.stringify(f.messages)).toMatchObject({ status: "escalated" });
      expect(f.snapshot.workItems.slice(0, 2).every((item) => item.closed)).toBe(true);
      expect(f.launch).toHaveBeenCalledTimes(failC ? 1 : 0);
      if (failC) {
        const withoutIncrement = await buildRecoveryProposal({
          repository: "o/r",
          snapshot: f.snapshot,
          historyComplete: true,
          store: f.store,
          requestId: "no-increment",
          successorRunId: "unapproved-retry",
        });
        expect(withoutIncrement.plan?.items[2]?.action).toBe("reconcile");
        vi.mocked(localScopes.linuxLocalScopeReadPort.hostIdentity).mockResolvedValue(
          "c".repeat(64),
        );
        const dirty = await buildRecoveryProposal({
          repository: "o/r",
          snapshot: f.snapshot,
          historyComplete: true,
          store: f.store,
          requestId: "dirty-resource",
          successorRunId: "blocked-retry",
          allowanceIncrement: {
            modelTokens: 100,
            sandboxMinutes: 0,
            managedSessions: 0,
            implementationAttemptsPerItem: 1,
          },
        });
        expect(dirty.status).toBe("proposed");
        expect(dirty.plan!.items[2]).toMatchObject({
          action: "execute",
          resources: { state: "reconciliation-required" },
        });
        expect(
          await verifyRecoveryProposalResources({
            plan: dirty.plan!,
            store: recoveryReadPort(f.store, "o", "r"),
            events: [
              ...f.snapshot.factoryEvents!,
              ...f.snapshot.workItems.flatMap((item) => item.factoryEvents!),
            ],
          }),
        ).toMatchObject({ status: "blocked" });
        vi.mocked(localScopes.linuxLocalScopeReadPort.hostIdentity).mockResolvedValue(
          "b".repeat(64),
        );
      }
      const proposal = await buildRecoveryProposal({
        repository: "o/r",
        snapshot: f.snapshot,
        historyComplete: true,
        store: f.store,
        requestId: "second-request",
        successorRunId: "second-successor",
        allowanceIncrement: {
          modelTokens: 100,
          sandboxMinutes: 0,
          managedSessions: 0,
          implementationAttemptsPerItem: failC ? 1 : 0,
        },
      });
      expect(proposal.blockers).toEqual([]);
      expect(proposal.plan!.items[1]!.source!.priorDelivery).toMatchObject({
        runId: "successor",
        planDigest: f.planRecord.digest,
      });
      const priorItem = structuredClone(proposal.plan!.items[1]!);
      priorItem.source!.priorDelivery!.planDigest = "0".repeat(64);
      await expect(
        verifyPriorRecoveryDelivery({
          plan: proposal.plan!,
          item: priorItem,
          events: [
            ...f.snapshot.factoryEvents!,
            ...f.snapshot.workItems.flatMap((item) => item.factoryEvents!),
          ],
          store: f.store,
        }),
      ).rejects.toThrow();
      const wrongDeliveredTree = structuredClone(proposal.plan!.items[1]!);
      expect(wrongDeliveredTree.source!.priorDelivery!.outputTreeSha).toMatch(/^[a-f0-9]{40}$/);
      expect(wrongDeliveredTree.source!.priorDelivery!.outputTreeSha).not.toBe("0".repeat(40));
      wrongDeliveredTree.source!.priorDelivery!.outputTreeSha = "0".repeat(40);
      // This resolver must independently reload the original delivered proof;
      // a parseable descriptor cannot substitute another tree for that result.
      await expect(
        verifyPriorRecoveryDelivery({
          plan: proposal.plan!,
          item: wrongDeliveredTree,
          events: [
            ...f.snapshot.factoryEvents!,
            ...f.snapshot.workItems.flatMap((item) => item.factoryEvents!),
          ],
          store: f.store,
        }),
      ).rejects.toThrow();
      const successorLease = {
        ...f.lease,
        runId: "second-successor",
        policyDigest: proposal.plan!.policyDigest,
      };
      const planRecord = await new RecoveryPlanManager(f.storage, f.leases).persist({
        lease: successorLease,
        plan: proposal.plan!,
      });
      const all = [
        ...f.snapshot.factoryEvents!,
        ...f.snapshot.workItems.flatMap((item) => item.factoryEvents!),
      ];
      const sequence = Math.max(...all.map((event) => event.sequence)) + 1;
      const request = parseFactoryEvent({
        protocol: "clockgrove.factory/v2",
        kind: "recovery",
        event: "RecoveryRequested",
        objective: 7,
        runId: "successor",
        sequence,
        at: new Date().toISOString(),
        requestedBy: "operator",
        requestId: planRecord.plan.requestId,
        repository: "o/r",
        planDigest: planRecord.digest,
        predecessorRunId: "successor",
        predecessorTerminalDigest: planRecord.plan.predecessor.terminalDigest,
        successorRunId: "second-successor",
        policyDigest: planRecord.plan.policyDigest,
        baseSha: planRecord.plan.expectedBaseSha,
      });
      if (request.event !== "RecoveryRequested") throw new Error("request fixture");
      f.snapshot.factoryEvents!.push(request);
      const claim = await new RecoveryClaimManager(f.storage, f.leases).claim({
        lease: successorLease,
        planRecord,
        authenticatedRequest: request,
        transaction: {
          at: new Date().toISOString(),
          startSequence: sequence + 1,
          evidenceDigest: "1".repeat(64),
          accountingDigest: "2".repeat(64),
          resourceEvidenceDigest: "3".repeat(64),
        },
      });
      const start = all.find(
        (event) => event.event === "FactoryRunStarted" && event.runId === "successor",
      );
      if (start?.event !== "FactoryRunStarted") throw new Error("start fixture");
      f.snapshot.factoryEvents!.push(
        ...recoveryAdoptionEvents({
          planRecord,
          claim,
          authenticatedRequest: request,
          predecessorStart: start,
        }),
      );
      const loaded = await loadRecoveryRuntime({
        objective: 7,
        runId: "second-successor",
        store: f.store,
        readSnapshot: async () => ({ snapshot: f.snapshot, historyComplete: true }),
      });
      expect(loaded).toMatchObject({
        status: "verified",
        usage: { modelTokens: failC ? 65 : 45 },
        historicalAccounting: { unknownModelUsageCount: 0 },
      });
      expect(
        await f.runRecovery({
          requestId: planRecord.plan.requestId,
          planDigest: planRecord.digest,
          successorRunId: "second-successor",
        }),
        JSON.stringify(f.messages),
      ).toMatchObject({ status: "completed" });
      expect(f.launch).toHaveBeenCalledTimes(failC ? 2 : 1);
      expect(f.review).toHaveBeenCalledTimes(2);
      expect(
        await loadRecoveryRuntime({
          objective: 7,
          runId: "second-successor",
          store: f.store,
          readSnapshot: async () => ({ snapshot: f.snapshot, historyComplete: true }),
        }),
      ).toMatchObject({ status: "verified", usage: { modelTokens: failC ? 100 : 80 } });
    },
    120_000,
  );
  // The two native sibling variants below perform real Git proof work. Under
  // coverage they use the suite's existing 60-second integration-test tier.
  it.each([false, true])(
    "preserves native sibling/join topology with artifact-only recovery %s",
    async (artifactOnly) => {
      const f = await successorFixture({ artifactOnly, nativeSource: true });
      const result = await f.run();
      expect(result, `${result.reason ?? ""} ${JSON.stringify(f.messages)}`).toMatchObject({
        status: "completed",
      });
      expect(f.launch).toHaveBeenCalledTimes(1);
      expect(f.review).toHaveBeenCalledTimes(2);
      expect(f.refresh).toHaveBeenCalledOnce();
      expect(f.snapshot.workItems[1]!.linkedPullRequests[0]!.headSha).not.toBe(f.heads[1]);
      expect(
        f.snapshot.factoryEvents!.find(
          (event) => event.kind === "delivery" && event.runId === "successor",
        ),
      ).toMatchObject({ selected: "native-stacks" });
      expect(await f.runtime()).toMatchObject({ status: "verified", usage: { modelTokens: 80 } });
    },
    60000,
  );
  it("retires an abandoned successor run before restoring mocks and removing its repository", async () => {
    const f = await successorFixture({
      nativeSource: true,
      providerOwnedRetainedBranch: true,
      staleRetainedBaseUntilRefresh: true,
    });
    const run = f.run();
    const settlements = await retireFixtureRuns();
    expect(settlements).toHaveLength(1);
    expect(settlements[0]).toMatchObject({ status: "fulfilled" });
    expect(await run).toMatchObject({ status: "cancelled" });
  });
  it("resumes the same adopted native sibling after lost refresh response without replacing retained work", async () => {
    const f = await successorFixture({ nativeSource: true, loseSiblingRefreshResponse: true });
    await expect(f.run()).rejects.toThrow(PlatformUnavailableError);
    expect(f.refresh).toHaveBeenCalledOnce();
    expect(f.launch).not.toHaveBeenCalled();
    expect(f.review).not.toHaveBeenCalled();
    const result = await f.run();
    expect(result, JSON.stringify(f.messages)).toMatchObject({ status: "completed" });
    expect(f.refresh).toHaveBeenCalledOnce();
    expect(f.launch).toHaveBeenCalledTimes(1);
    expect(f.review).toHaveBeenCalledTimes(2);
    expect(await f.runtime()).toMatchObject({ status: "verified", usage: { modelTokens: 80 } });
  }, 60_000);
  it("rejects contradictory accepted adopted refresh review before integration or fresh work", async () => {
    const f = await successorFixture({ nativeSource: true });
    f.review.mockImplementationOnce(async (_context, checkpoint) => {
      const result = {
        review: {
          accepted: true,
          summary: "Contradictory review",
          unmetCriteria: ["Unmet criterion"],
          risks: [],
        },
        usage: { inputTokens: 10, outputTokens: 5 },
      };
      await checkpoint(result);
      return result;
    });
    const result = await f.run();
    expect(result, JSON.stringify(f.messages)).toMatchObject({ status: "escalated" });
    expect(f.review).toHaveBeenCalledOnce();
    expect(f.launch).not.toHaveBeenCalled();
    expect(
      f.snapshot.workItems[1]!.factoryEvents!.some(
        (event) => event.event === "RecoverySourceIntegrated",
      ),
    ).toBe(false);
    expect(
      f.snapshot.workItems[1]!.factoryEvents!.filter(
        (event) =>
          event.kind === "budget" &&
          event.event === "BudgetReconciled" &&
          event.unit === "model_tokens" &&
          event.runId === "successor",
      ),
    ).toEqual([expect.objectContaining({ amount: 15 })]);
  }, 30000);
  it("restores a verified artifact branch after lost PR creation response without rerunning its worker", async () => {
    const f = await successorFixture({ artifactOnly: true, loseArtifactPrResponse: true });
    expect(f.planRecord.plan.items[1]!.source?.artifactHead?.headSha).toBe(f.heads[1]);
    expect(await f.run()).toMatchObject({ status: "completed" });
    expect(f.launch).toHaveBeenCalledTimes(1);
    expect(f.launch.mock.calls[0]![0].workItem).toBe(10);
    expect(
      f.snapshot.workItems[1]!.factoryEvents!.filter(
        (event) => event.event === "RecoverySourcePublished",
      ),
    ).toHaveLength(1);
    expect(
      f.snapshot.workItems[1]!.factoryEvents!.filter(
        (event) => event.event === "RecoverySourceIntegrated",
      ),
    ).toHaveLength(1);
    expect(
      f.snapshot.workItems[1]!.factoryEvents!.some(
        (event) => event.kind === "attempt" && event.runId === "successor",
      ),
    ).toBe(false);
    const deliveredHead = f.snapshot.workItems[1]!.linkedPullRequests[0]!.headSha;
    expect(deliveredHead).not.toBe(f.heads[1]);
    expect((await f.readCommit(deliveredHead)).parentOids).toEqual([
      f.heads[1],
      f.planRecord.plan.expectedBaseSha,
    ]);
    expect(f.planRecord.plan.items[1]!.source?.artifactHead?.headSha).toBe(f.heads[1]);
    expect(await f.runtime()).toMatchObject({ status: "verified", usage: { modelTokens: 80 } });
  }, 60000);

  it("rejects an artifact branch replacement after acknowledgement before opening a PR", async () => {
    const f = await successorFixture({ artifactOnly: true });
    f.refs.set(`refs/heads/${publicationBranch(7, 9, 1)}`, f.heads[0]!);
    expect(await f.run()).toMatchObject({ status: "escalated" });
    expect(f.launch).not.toHaveBeenCalled();
    expect(f.review).not.toHaveBeenCalled();
    expect(GitHubControlStore.prototype.createPullRequest).not.toHaveBeenCalled();
  }, 30000);
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
    await expect(f.run()).rejects.toThrow(/authority.*unavailable|successor runtime unavailable/);
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
    const refreshProof = vi.spyOn(siblingRefreshProof, "observeRecoverySiblingRefresh");
    sourceCapacity.backend = `factory/integration-validation-${"0".repeat(64)}`;
    // B now has an authenticated refreshed head. Its observer must resolve the
    // receipt's exact candidate digest before the later capacity tuple check;
    // the forged digest fails that earlier proof, not the unchanged-head gate.
    expect(await f.runtime()).toMatchObject({
      status: "blocked",
      adoptionVerified: false,
      executionAuthorized: false,
      blockers: ["runtime-binding-unavailable"],
    });
    const invalidInvocation = refreshProof.mock.calls.findIndex(
      ([input]) => input.candidateIdentityDigest === "0".repeat(64),
    );
    expect(invalidInvocation).toBeGreaterThanOrEqual(0);
    await expect(refreshProof.mock.results[invalidInvocation]!.value).rejects.toThrow(
      "sibling refresh recovery binding unavailable",
    );
    sourceCapacity.backend = backend;
    expect(await f.runtime()).toMatchObject({ status: "verified", usage: { modelTokens: 80 } });
    expect(f.launch).toHaveBeenCalledTimes(1);
    expect(f.review).toHaveBeenCalledTimes(2);
  }, 60_000);
});
