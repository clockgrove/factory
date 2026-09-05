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
import { GitHubStacks } from "../src/publication/github-stacks.js";
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
import { recoveryReadPort } from "../src/recovery/github-read-port.js";
import { verifyRecoveryProposalResources } from "../src/recovery/resources.js";
import { verifyPriorRecoveryDelivery } from "../src/recovery/outcomes.js";
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
    failC?: boolean;
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
  const now = new Date();
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
    backendOrder: ["codex-sdk/local-worktree"],
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
    workItems: ["a", "b", "c", "d"].slice(0, options.stackLength ?? 3).map((name, index) => ({
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
        trust: "trusted_local",
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
        baseSha,
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
          branch: publicationBranch(7, number, 1),
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
      headRef:
        number === 20 && options.failC
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
  if (!options.retainedPrefix)
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
    vi.spyOn(GitHubStacks.prototype, "requestMerge").mockImplementation(async (input) => ({
      state: "merged",
      mergeSha: await store.mergePullRequest({
        number: input.pullRequest,
        headSha: input.expectedHeadSha,
        commitTitle: input.title,
      }),
    }));
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

describe("Supervisor authenticated successor execution", () => {
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
      expect(await f.runtime()).toMatchObject({ status: "verified" });
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
    60000,
  );
  it.each([false, true])(
    "preserves native sibling/join topology with artifact-only recovery %s",
    async (artifactOnly) => {
      const f = await successorFixture({ artifactOnly, nativeSource: true });
      const result = await f.run();
      expect(result, JSON.stringify(f.messages)).toMatchObject({ status: "completed" });
      expect(f.launch).toHaveBeenCalledTimes(1);
      expect(f.review).toHaveBeenCalledTimes(2);
      expect(
        f.snapshot.factoryEvents!.find(
          (event) => event.kind === "delivery" && event.runId === "successor",
        ),
      ).toMatchObject({ selected: "native-stacks" });
      expect(await f.runtime()).toMatchObject({ status: "verified", usage: { modelTokens: 80 } });
    },
    30000,
  );
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
    expect(f.snapshot.workItems[1]!.linkedPullRequests[0]!.headSha).toBe(f.heads[1]);
    expect(await f.runtime()).toMatchObject({ status: "verified", usage: { modelTokens: 80 } });
  }, 30000);

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
    sourceCapacity.backend = `factory/integration-validation-${"0".repeat(64)}`;
    expect(await f.runtime()).toMatchObject({
      status: "blocked",
      blockers: ["source-capacity-candidate-mismatch"],
    });
    sourceCapacity.backend = backend;
  }, 30000);
});
