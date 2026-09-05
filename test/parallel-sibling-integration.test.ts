import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FactorySupervisor } from "../src/supervisor.js";
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

const directories: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
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
    previewState?: () => "fresh" | "stale-base" | "stale-parents" | "absent";
    pollIntervalMs?: number;
    signal?: AbortSignal;
    onStatus?: (message: string) => void;
    thirdSibling?: boolean;
    afterMerge?: (number: number) => void;
  } = {},
) {
  const repository = await mkdtemp(join(tmpdir(), "factory-sibling-integration-"));
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
  const names = options.thirdSibling ? ["a", "b", "c"] : ["a", "b"];
  for (const name of names) {
    git("checkout", "-q", "-b", name, baseSha);
    await writeFile(join(repository, `${name}.txt`), `${name}\n`);
    git("add", ".");
    git("commit", "-qm", name);
    heads.push(git("rev-parse", "HEAD"));
  }
  git("checkout", "-q", "main");
  const now = new Date();
  const policy = parseRunPolicy({
    ...DEFAULT_RUN_POLICY,
    capacity: { ...DEFAULT_RUN_POLICY.capacity, mode: "fixed" },
    delivery: { mode: "stacked-prs", onUnavailable: "escalate", merge: "bottom-up" },
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
      const id = createHash("sha1").update(bytes).digest("hex");
      blobs.set(id, bytes);
      return id;
    },
    createTree: async ({ entries }) => {
      const id = oid();
      trees.set(
        id,
        new Map(entries.filter((entry) => entry.sha).map((entry) => [entry.path, entry.sha!])),
      );
      return id;
    },
    createCommit: async (args) => {
      const id = oid();
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
    workItems: names.map((name) => ({
      id: name,
      title: name,
      goal: `Add ${name}`,
      acceptance: ["Tests pass"],
      scope: [`${name}.txt`],
      preconditions: [],
      outOfScope: [],
      conventions: [],
      dependsOn: [],
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
      delivery: { group: name, relationship: "root" },
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
        requested: "stacked-prs",
        selected: "native-stacks",
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
        graphSize: names.length,
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
          mode: "native-stacks",
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
    if (++reads > 80) throw new Error("fixture exceeded bounded snapshot reads");
    return structuredClone(snapshot);
  });
  vi.spyOn(LeaseManager.prototype, "read").mockResolvedValue(null);
  let acquisitions = 0;
  vi.spyOn(LeaseManager.prototype, "acquire").mockImplementation(
    async (identity, _base, requestedSequence) => ({
      ...lease,
      ...identity,
      sequence: requestedSequence ?? lease.sequence,
      epoch: ++acquisitions,
    }),
  );
  const renewLease = vi
    .spyOn(LeaseManager.prototype, "renew")
    .mockImplementation(async (current, requestedSequence) => {
      expect(requestedSequence).toBeGreaterThan(current.sequence);
      return {
        ...current,
        sequence: requestedSequence!,
        expiresAt: new Date(Date.now() + 600_000),
      };
    });
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
      const pull = item.linkedPullRequests[0]!;
      return {
        number: pull.number,
        htmlUrl: `https://github.com/o/r/pull/${pull.number}`,
        state: pull.state === "OPEN" ? "open" : "closed",
        merged: pull.state === "MERGED",
        headSha: pull.headSha,
      };
    },
  );
  const pullReads = vi
    .spyOn(GitHubControlStore.prototype, "readPullRequest")
    .mockImplementation(async (number) => {
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
      const previewState = number === 19 ? options.previewState?.() : "fresh";
      if (previewState === "stale-parents" && pull.state === "OPEN")
        commits.get(preview)!.parentOids = [baseSha, pull.headSha];
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
        baseSha: previewState === "stale-base" ? baseSha : currentBase,
        mergeCommitSha: previewState === "absent" ? null : (mergeShas.get(number) ?? preview),
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
      options.afterMerge?.(number);
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
  const validate = vi.spyOn(cleanValidation, "validateArtifactClean");
  const run = () =>
    new FactorySupervisor({
      token: "fixture-token",
      owner: "o",
      repo: "r",
      objective: 7,
      repository,
      policy,
      managementBackend: management,
      pollIntervalMs: options.pollIntervalMs ?? 1,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.onStatus ? { onStatus: options.onStatus } : {}),
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
    pullReads,
    renewLease,
    stalePreviewObserved: () => stalePreviewServed,
  };
}

describe("Supervisor parallel independent sibling integration", () => {
  it("records a complete candidate scope batch before any test command without per-command writes", async () => {
    const f = await fixture();
    vi.spyOn(localScopes, "discoverLocalScopeHost").mockResolvedValue({
      hostIdentity: "b".repeat(64),
      producerPid: 123,
      producerStartTicks: "456",
    });
    const scoped = vi
      .spyOn(localScopes, "runScopedLocalProcess")
      .mockImplementation(async (identity, options) => {
        const receipts = f.snapshot.workItems[1]!.factoryEvents!.filter(
          (entry) => entry.kind === "capacity" && entry.event === "CapacityReserved",
        );
        expect(receipts).toHaveLength(1);
        const receipt = receipts[0]!;
        expect(receipt.kind === "capacity" && receipt.localScopeBatch).toMatchObject({
          identity: { ...identity, commandIndex: 0 },
          producerPid: 123,
          producerStartTicks: "456",
        });
        expect(
          receipt.kind === "capacity" && receipt.localScopeBatch!.commandCount,
        ).toBeGreaterThan(identity.commandIndex);
        return runContainedProcess(options);
      });
    const result = await f.run();
    expect(result, result.reason).toMatchObject({ status: "completed" });
    expect(scoped).toHaveBeenCalled();
    expect(
      f.snapshot.workItems[1]!.factoryEvents!.filter(
        (entry) => entry.kind === "capacity" && entry.event === "CapacityReserved",
      ),
    ).toHaveLength(1);
    expect(f.launch).not.toHaveBeenCalled();
  });

  it("integrates A then validates unchanged B against the advanced trunk", async () => {
    const f = await fixture();
    const result = await f.run();
    expect(result, result.reason).toMatchObject({ status: "completed", runId: "parallel" });
    expect(f.merge.mock.calls.map(([input]) => input.number)).toEqual([18, 19]);
    expect(f.review).toHaveBeenCalledOnce();
    expect(f.review.mock.calls[0]![0].evidence.baseSha).toBe(f.mergeShas.get(18));
    expect(f.snapshot.workItems[1]!.linkedPullRequests[0]!.headSha).toBe(f.heads[1]);
    expect(f.git("show", `${f.mergeShas.get(19)}:a.txt`)).toBe("a");
    expect(f.git("show", `${f.mergeShas.get(19)}:b.txt`)).toBe("b");
    expect([...f.refs.keys()].filter((ref) => ref.includes("/merge-candidates/"))).toHaveLength(1);
    expect(f.launch).not.toHaveBeenCalled();
  });

  it("refuses an unrelated advance without reviewing or merging stale B", async () => {
    const f = await fixture({ externalAdvance: true });
    const result = await f.run();
    expect(result.status).toBe("escalated");
    expect(f.merge.mock.calls.map(([input]) => input.number)).toEqual([18]);
    expect(f.review).not.toHaveBeenCalled();
    expect(f.snapshot.workItems[1]!.closed).toBe(false);
    expect(f.launch).not.toHaveBeenCalled();
  });

  it("restarts after a lost merge response without validating or paying for review again", async () => {
    const f = await fixture({ loseMergeResponse: true });
    await expect(f.run()).rejects.toThrow(PlatformUnavailableError);
    expect(
      f.snapshot.factoryEvents!.some(
        (entry) => entry.kind === "run" && entry.event === "FactoryRunEscalated",
      ),
    ).toBe(false);
    expect(f.review).toHaveBeenCalledOnce();
    expect(f.validate).toHaveBeenCalledOnce();
    const result = await f.run();
    expect(result, result.reason).toMatchObject({ status: "completed" });
    expect(f.review).toHaveBeenCalledOnce();
    expect(f.validate).toHaveBeenCalledOnce();
    expect(f.merge).toHaveBeenCalledTimes(2);
    expect(
      f.snapshot.workItems[1]!.factoryEvents!.filter(
        (entry) => entry.kind === "attempt" && entry.event === "AttemptIntegrated",
      ),
    ).toHaveLength(1);
  });

  it("does not merge B when its clean combined-tree tests fail", async () => {
    const f = await fixture({ failCombinedTests: true });
    const result = await f.run();
    expect(result.status).toBe("escalated");
    expect(f.validate).toHaveBeenCalledOnce();
    expect(f.review).not.toHaveBeenCalled();
    expect(f.merge.mock.calls.map(([input]) => input.number)).toEqual([18]);
    const events = f.snapshot.workItems[1]!.factoryEvents!;
    expect(
      events.filter(
        (entry) =>
          entry.kind === "capacity" &&
          entry.event === "CapacityReserved" &&
          entry.backend.startsWith("factory/integration-validation-"),
      ),
    ).toHaveLength(1);
    expect(
      events.filter((entry) => entry.kind === "capacity" && entry.event === "CapacityReconciled"),
    ).toHaveLength(0);
    expect(
      events.filter(
        (entry) =>
          entry.kind === "budget" &&
          entry.unit === "validation_milliseconds" &&
          entry.usageId?.startsWith("integration-validation-"),
      ),
    ).toHaveLength(1);
  });

  it("repairs A's missing post-close receipt before using its merge to revalidate B", async () => {
    const f = await fixture({ loseIntegrationReceipt: true });
    await expect(f.run()).rejects.toThrow(PlatformUnavailableError);
    expect(f.snapshot.workItems[0]!.closed).toBe(true);
    expect(
      f.snapshot.workItems[0]!.factoryEvents!.some(
        (entry) => entry.kind === "attempt" && entry.event === "AttemptIntegrated",
      ),
    ).toBe(false);
    const result = await f.run();
    expect(result, result.reason).toMatchObject({ status: "completed" });
    expect(
      f.snapshot.workItems[0]!.factoryEvents!.filter(
        (entry) => entry.kind === "attempt" && entry.event === "AttemptIntegrated",
      ),
    ).toHaveLength(1);
    expect(f.merge).toHaveBeenCalledTimes(2);
    expect(f.review).toHaveBeenCalledOnce();
  });

  it("waits for a stale GitHub test-merge preview to refresh without repeating review", async () => {
    const f = await fixture({ stalePreviewOnce: true });
    const result = await f.run();
    expect(result, result.reason).toMatchObject({ status: "completed" });
    expect(f.merge).toHaveBeenCalledTimes(2);
    expect(f.review).toHaveBeenCalledOnce();
    expect(f.validate).toHaveBeenCalledOnce();
    expect(f.stalePreviewObserved()).toBe(true);
  });

  it.each(["stale-base", "stale-parents", "absent"] as const)(
    "paces prolonged %s evidence, then integrates fresh evidence without repeated paid work",
    async (initialState) => {
      let state: "fresh" | typeof initialState = initialState;
      let observedWait!: () => void;
      const waiting = new Promise<void>((resolve) => {
        observedWait = resolve;
      });
      const statuses: string[] = [];
      const f = await fixture({
        previewState: () => state,
        pollIntervalMs: 60_000,
        onStatus: (message) => {
          statuses.push(message);
          if (message.includes("integration waiting:")) {
            vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
            observedWait();
          }
        },
      });
      const completion = f.run();
      await waiting;
      await vi.advanceTimersByTimeAsync(0);
      const readsBefore = f.pullReads.mock.calls.length;
      for (let minute = 0; minute < 7; minute++) await vi.advanceTimersByTimeAsync(60_000);
      // Initial read, then 1m/3m/7m: not one full immutable-proof/API cycle per snapshot.
      const readsWhileWaiting = f.pullReads.mock.calls.length - readsBefore;
      expect(readsWhileWaiting).toBeGreaterThan(0);
      expect(readsWhileWaiting).toBeLessThanOrEqual(24);
      expect(f.merge.mock.calls.map(([input]) => input.number)).toEqual([18]);
      expect(f.validate).toHaveBeenCalledOnce();
      expect(f.review).toHaveBeenCalledOnce();
      expect(statuses.filter((message) => message.includes("integration waiting:"))).toHaveLength(
        1,
      );
      state = "fresh";
      await vi.advanceTimersByTimeAsync(300_000);
      const result = await completion;
      expect(result, result.reason).toMatchObject({ status: "completed" });
      expect(f.merge.mock.calls.map(([input]) => input.number)).toEqual([18, 19]);
      expect(f.validate).toHaveBeenCalledOnce();
      expect(f.review).toHaveBeenCalledOnce();
      expect(f.launch).not.toHaveBeenCalled();
      expect(f.renewLease).toHaveBeenCalled();
    },
  );

  it("observes durable cancellation during preview backoff without another candidate or merge", async () => {
    let observedWait!: () => void;
    const waiting = new Promise<void>((resolve) => {
      observedWait = resolve;
    });
    const f = await fixture({
      previewState: () => "stale-parents",
      pollIntervalMs: 60_000,
      onStatus: (message) => {
        if (message.includes("integration waiting:")) {
          vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
          observedWait();
        }
      },
    });
    const completion = f.run();
    await waiting;
    await vi.advanceTimersByTimeAsync(180_000);
    const readsBeforeCancel = f.pullReads.mock.calls.length;
    const events = [
      ...f.snapshot.factoryEvents!,
      ...f.snapshot.workItems.flatMap((item) => item.factoryEvents!),
    ];
    f.snapshot.factoryEvents!.push(
      parseFactoryEvent({
        protocol: "clockgrove.factory/v2",
        kind: "run",
        event: "FactoryRunCancellationRequested",
        objective: 7,
        runId: "parallel",
        requestedBy: "operator",
        requestId: "stop-during-preview-wait",
        sequence: Math.max(...events.map((event) => event.sequence)) + 1,
        at: new Date().toISOString(),
      }),
    );
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await completion).toMatchObject({ status: "cancelled" });
    expect(f.pullReads.mock.calls.length).toBe(readsBeforeCancel);
    expect(f.merge.mock.calls.map(([input]) => input.number)).toEqual([18]);
    expect(f.review).toHaveBeenCalledOnce();
    expect(f.validate).toHaveBeenCalledOnce();
    expect(f.launch).not.toHaveBeenCalled();
  });

  it("lets another ready sibling integrate while an earlier sibling's preview is stale", async () => {
    const abort = new AbortController();
    const f = await fixture({
      thirdSibling: true,
      previewState: () => "stale-parents",
      pollIntervalMs: 60_000,
      signal: abort.signal,
      afterMerge: (number) => {
        if (number === 20) abort.abort();
      },
    });
    const result = await f.run();
    expect(result, result.reason).toMatchObject({ status: "cancelled" });
    expect(f.merge.mock.calls.map(([input]) => input.number)).toEqual([18, 20]);
    expect(f.snapshot.workItems[1]!.closed).toBe(false);
    expect(f.review.mock.calls.map(([input]) => input.workItemNumber)).toEqual([9, 10]);
    expect(f.validate).toHaveBeenCalledTimes(2);
    expect(f.launch).not.toHaveBeenCalled();
  });

  it("does not claim resource cleanup when clean validation throws without completion evidence", async () => {
    const f = await fixture();
    f.validate.mockRejectedValueOnce(new Error("validator process cleanup uncertain"));
    const result = await f.run();
    expect(result.status).toBe("escalated");
    expect(f.merge.mock.calls.map(([input]) => input.number)).toEqual([18]);
    expect(f.review).not.toHaveBeenCalled();
    const events = f.snapshot.workItems[1]!.factoryEvents!;
    expect(
      events.filter((entry) => entry.kind === "capacity" && entry.event === "CapacityReserved"),
    ).toHaveLength(1);
    expect(
      events.filter((entry) => entry.kind === "capacity" && entry.event === "CapacityReconciled"),
    ).toHaveLength(0);
    expect([...f.refs.keys()].filter((ref) => ref.includes("/merge-candidates/"))).toHaveLength(0);
  });

  it("does not merge a semantically rejected combined tree", async () => {
    const f = await fixture({ rejectReview: true });
    const result = await f.run();
    expect(result.status).toBe("escalated");
    expect(result.reason).toMatch(/semantic review rejected/);
    expect(f.review).toHaveBeenCalledOnce();
    expect(f.merge.mock.calls.map(([input]) => input.number)).toEqual([18]);
  });

  it("rejects a GitHub test-merge tree different from the validated candidate before merging", async () => {
    const f = await fixture({ wrongPreviewTree: true });
    const result = await f.run();
    expect(result.status).toBe("escalated");
    expect(f.review).toHaveBeenCalledOnce();
    expect(f.merge.mock.calls.map(([input]) => input.number)).toEqual([18]);
  });
});
