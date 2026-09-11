import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FactorySupervisor } from "../src/supervisor.js";
import * as localScopes from "../src/runtime/local-scope.js";
import * as processGroup from "../src/runtime/process-group.js";
import { GitHubReader } from "../src/github.js";
import { GitHubControlStore } from "../src/control/github-store.js";
import { CompiledGraphManager, type CompiledGraphStore } from "../src/control/graphs.js";
import { LeaseManager, type GitCommitObject, type LeaseState } from "../src/control/lease.js";
import { attemptRef } from "../src/control/attempts.js";
import {
  MergeCandidateCheckpointStore,
  mergeCandidateIdentityDigest,
} from "../src/control/merge-candidates.js";
import { ReviewCheckpointManager, reviewIdentityDigest } from "../src/control/reviews.js";
import { normalizeArtifact } from "../src/execution/artifacts.js";
import { decodeEventComments, encodeEventTrailer } from "../src/control/receipts.js";
import { DEFAULT_RUN_POLICY, parseRunPolicy, policyDigest } from "../src/protocol/policy.js";
import { parseFactoryEvent } from "../src/protocol/events.js";
import {
  renderWorkPacket,
  parseWorkerPacketFromIssue,
  type CompiledObjective,
} from "../src/graph.js";
import { planDelivery } from "../src/publication/delivery.js";
import { publicationBranch } from "../src/publication/publisher.js";
import { bindValidationToPublishedHead } from "../src/validation/plan.js";
import { createValidationEvidence } from "../src/validation/evidence.js";
import { BackendRegistry } from "../src/execution/registry.js";
import { CodexSdkLocalBackend } from "../src/backends/codex-sdk-local.js";
import type { ManagementBackend } from "../src/management/backend.js";
import type { ObjectiveSnapshot, LinkedPullRequest } from "../src/types.js";
import { PlatformUnavailableError } from "../src/platform.js";
import { parseIssueAdmissionCommit } from "../src/control/issue-admission.js";
import {
  integrationAdmissionRef,
  withIntegrationAdmission,
} from "../src/control/integration-admission.js";
import * as cleanValidation from "../src/validation/clean-run.js";
const actualValidate = cleanValidation.validateArtifactClean;
const runContainedProcess = processGroup.runContainedProcess;

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
    regular?: boolean;
    peerAdvance?: boolean;
    foreignPeerGeneration?: boolean;
    foreignPeerActor?: boolean;
    missingPeerReview?: boolean;
    peerIsolated?: boolean;
    externalAdvance?: boolean;
    rejectReview?: boolean;
    failCombinedTests?: boolean;
    loseMergeResponse?: boolean;
    rejectMergeOnce?: boolean;
    wrongPreviewTree?: boolean;
    loseIntegrationReceipt?: boolean;
    stalePreviewOnce?: boolean;
    previewState?: () => "fresh" | "stale-base" | "stale-parents" | "absent";
    pollIntervalMs?: number;
    signal?: AbortSignal;
    onStatus?: (message: string) => void;
    thirdSibling?: boolean;
    afterMerge?: (number: number) => void;
    afterRefresh?: (number: number) => void;
    loseRefreshResponse?: boolean;
    foreignRefreshHead?: boolean;
    staleRefreshedHeadReads?: number;
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
  vi.spyOn(processGroup, "runContainedProcess").mockImplementation(async (input) => {
    if (input.command !== "git" || input.cwd !== repository) return runContainedProcess(input);
    const startedAt = Date.now();
    try {
      const stdout = execFileSync("git", input.args ?? [], {
        cwd: input.cwd,
        env: input.env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: input.timeoutMs,
        maxBuffer: input.maxOutputBytes,
      });
      return {
        exitCode: 0,
        signal: null,
        stdout,
        stderr: "",
        durationMs: Date.now() - startedAt,
        timedOut: false,
      };
    } catch (error) {
      const failure = error as {
        status?: number | null;
        signal?: NodeJS.Signals | null;
        stdout?: string | Buffer;
        stderr?: string | Buffer;
      };
      return {
        exitCode: failure.status ?? 1,
        signal: failure.signal ?? null,
        stdout: failure.stdout?.toString() ?? "",
        stderr: failure.stderr?.toString() ?? "",
        durationMs: Date.now() - startedAt,
        timedOut: failure.signal === "SIGTERM",
      };
    }
  });
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
    delivery: {
      mode: options.regular ? "regular-prs" : "stacked-prs",
      onUnavailable: "escalate",
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
    const synthetic = commits.get(id);
    if (synthetic) return synthetic;
    // Read fresh immutable metadata in one subprocess; do not cache observations
    // or spend three Git startups on every admission/recovery proof read.
    const output = git("show", "-s", "--format=%T%x00%P%x00%B", id);
    const treeEnd = output.indexOf("\0");
    const parentsEnd = output.indexOf("\0", treeEnd + 1);
    if (treeEnd < 0 || parentsEnd < 0) throw new Error("malformed fixture Git commit");
    return {
      oid: id,
      treeOid: output.slice(0, treeEnd),
      parentOids: output
        .slice(treeEnd + 1, parentsEnd)
        .split(" ")
        .filter(Boolean),
      message: output.slice(parentsEnd + 1).trim(),
      serverTime: new Date(),
    };
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
    createTree: async ({ baseTreeOid, entries }) => {
      const env = { ...process.env, GIT_INDEX_FILE: join(repository, ".git", "upload-index") };
      execFileSync("git", ["read-tree", baseTreeOid ?? "--empty"], { cwd: repository, env });
      execFileSync("git", ["update-index", "--index-info"], {
        cwd: repository,
        env,
        input: entries
          .map(
            (entry) =>
              `${entry.sha ? entry.mode : "0"} ${entry.sha ?? "0".repeat(40)}\t${entry.path}\n`,
          )
          .join(""),
      });
      const id = execFileSync("git", ["write-tree"], {
        cwd: repository,
        env,
        encoding: "utf8",
      }).trim();
      trees.set(
        id,
        new Map(entries.filter((entry) => entry.sha).map((entry) => [entry.path, entry.sha!])),
      );
      return id;
    },
    createCommit: async (args) => {
      const id = execFileSync(
        "git",
        ["commit-tree", args.treeOid, ...args.parentOids.flatMap((parent) => ["-p", parent])],
        { cwd: repository, input: args.message, encoding: "utf8" },
      ).trim();
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
  const assertCurrent = async () => {};
  const leases = {
    assertCurrent,
    assertMutationAuthorized: assertCurrent,
  } as unknown as LeaseManager;
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
        requested: options.regular ? "regular-prs" : "stacked-prs",
        selected: options.regular ? "regular-prs" : "native-stacks",
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
    refs.set(`refs/heads/${publicationBranch(7, number, 1)}`, head);
    const tree = (await readCommit(head)).treeOid;
    const validationDigest = createHash("sha256").update(item.id).digest("hex");
    const reviewIdentity = {
      kind: "artifact" as const,
      runId: "parallel",
      objective: 7,
      workItem: number,
      attempt: 1,
      artifactDigest: validationDigest,
      baseSha,
      outputTreeSha: tree,
      evidenceDigest: validationDigest,
    };
    await new ReviewCheckpointManager(storage, leases).persist({
      lease,
      identity: reviewIdentity,
      result: {
        review: {
          accepted: true,
          summary: "Original artifact accepted",
          unmetCriteria: [],
          risks: [],
        },
        usage: { inputTokens: 10, outputTokens: 5 },
      },
    });
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
    // These pre-existing attempts were admitted by the legacy controller:
    // retain its original issue ownership for the compatibility import.
    const ownerOid = await storage.createCommit({
      treeOid: (await readCommit(baseSha)).treeOid,
      parentOids: [baseSha],
      message: `Factory-Repository-Claim: ${Buffer.from(
        JSON.stringify({
          objective: 7,
          workItem: number,
          runId: reserved.runId,
          directorEpoch: 1,
        }),
      ).toString("base64url")}`,
    });
    refs.set(`refs/clockgrove-factory/repository/work-items/work-item-${number}`, ownerOid);
    const reservationOid = await storage.createCommit({
      treeOid: (await readCommit(baseSha)).treeOid,
      parentOids: [baseSha],
      message: encodeEventTrailer(reserved),
    });
    refs.set(attemptRef(7, number, 1), reservationOid);
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
          kind: "capacity",
          event: "CapacityReserved",
          workItem: number,
          attempt: 1,
          phase: "validation",
          backend: "codex-sdk/local-worktree",
          requestedCpu: 1,
          requestedMemoryMb: 512,
          directorEpoch: 1,
          policyDigest: pd,
        }),
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
        event({
          kind: "budget",
          event: "BudgetReconciled",
          workItem: number,
          attempt: 1,
          phase: "management",
          unit: "model_tokens",
          amount: 15,
          usageId: `review-${reviewIdentityDigest(reviewIdentity)}`,
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
          mode: options.regular ? "regular-prs" : "native-stacks",
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
  const controller = {
    controllerId: "shared-controller",
    epoch: 1,
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    controllerPolicyDigest: "c".repeat(64),
  };
  let peerSnapshot: ObjectiveSnapshot | undefined;
  let peerMergeSha: string | undefined;
  let peerHead: string | undefined;
  if (options.peerAdvance) {
    git("checkout", "-q", "-b", "peer-head", baseSha);
    await writeFile(join(repository, "peer.txt"), "peer\n");
    git("add", ".");
    git("commit", "-qm", "peer artifact");
    peerHead = git("rev-parse", "HEAD");
    git("checkout", "-q", "main");
    git("merge", "--squash", peerHead);
    git("commit", "-qm", "peer squash");
    peerMergeSha = git("rev-parse", "HEAD");
    const peerTree = (await readCommit(peerHead)).treeOid;
    const peerLease = { ...lease, objective: 6, runId: "peer" };
    const peerItem = {
      ...graph.workItems[0]!,
      id: "peer",
      title: "peer",
      goal: "Add peer",
      scope: ["peer.txt"],
      delivery: { group: "peer", relationship: "root" as const },
      requirements: {
        ...graph.workItems[0]!.requirements!,
        ...(options.peerIsolated ? { trust: "isolated" as const } : {}),
      },
    };
    const peerGraph = await graphManager.persist({
      lease: peerLease,
      base: await readCommit(baseSha),
      objective: { title: "Peer Objective", workItems: [peerItem] },
    });
    const peerProjection = await graphManager.persistProjection({
      lease: peerLease,
      graph: peerGraph,
      bindings: [{ compilerId: "peer", issueNodeId: "I_88", issueNumber: 88 }],
    });
    const validationDigest = createHash("sha256").update("peer").digest("hex");
    const reviewIdentity = {
      kind: "artifact" as const,
      runId: "peer",
      objective: 6,
      workItem: 88,
      attempt: 1,
      artifactDigest: validationDigest,
      baseSha,
      outputTreeSha: peerTree,
      evidenceDigest: validationDigest,
    };
    if (!options.missingPeerReview)
      await new ReviewCheckpointManager(storage, leases).persist({
        lease: peerLease,
        identity: reviewIdentity,
        result: {
          review: { accepted: true, summary: "Peer accepted", unmetCriteria: [], risks: [] },
          usage: { inputTokens: 10, outputTokens: 5 },
        },
      });
    const exact = bindValidationToPublishedHead({
      validation: { passed: true, digest: validationDigest, baseSha, outputTreeSha: peerTree },
      publishedBaseSha: baseSha,
      publishedTreeSha: peerTree,
      publishedHeadSha: peerHead,
    });
    const peerEvent = (fields: Record<string, unknown>) =>
      event({ ...fields, objective: 6, runId: "peer", sequence: sequence++ });
    const item = structuredClone(snapshot.workItems[0]!);
    Object.assign(item, {
      id: "I_88",
      number: 88,
      title: "peer",
      closed: true,
      body: renderWorkPacket(peerItem, {
        protocol: "clockgrove.factory/graph-v1",
        id: "peer",
        graphDigest: peerGraph.graphDigest,
        graphSize: 1,
        index: 0,
        dependsOn: [],
      }),
    });
    item.linkedPullRequests = [
      {
        ...item.linkedPullRequests[0]!,
        id: "PR_88",
        number: 88,
        state: "MERGED",
        headSha: peerHead,
        changedFilePaths: ["peer.txt"],
      },
    ];
    item.factoryEvents = item.factoryEvents!.map((original) =>
      peerEvent({
        ...original,
        workItem: 88,
        ...(original.kind === "attempt" && original.artifactDigest
          ? { artifactDigest: validationDigest }
          : {}),
        ...(original.kind === "attempt" && original.headSha ? { headSha: peerHead } : {}),
        ...(original.kind === "validation"
          ? { outputTreeSha: peerTree, evidenceDigest: validationDigest }
          : {}),
        ...(original.kind === "budget" && original.phase === "management"
          ? { usageId: `review-${reviewIdentityDigest(reviewIdentity)}` }
          : {}),
        ...(original.kind === "publication"
          ? {
              unitId: "delivery/peer",
              itemId: "peer",
              headSha: peerHead,
              branch: publicationBranch(6, 88, 1),
              pullRequest: 88,
              validationDigest,
              exactHeadValidationDigest: exact.digest,
            }
          : {}),
      }),
    );
    const reserved = item.factoryEvents.find((entry) => entry.event === "AttemptReserved")!;
    const reservedOid = oid();
    refs.set(attemptRef(6, 88, 1), reservedOid);
    refs.set(`refs/heads/${publicationBranch(6, 88, 1)}`, peerHead);
    commits.set(reservedOid, {
      oid: reservedOid,
      treeOid: (await readCommit(baseSha)).treeOid,
      parentOids: [baseSha],
      message: encodeEventTrailer(reserved),
      serverTime: now,
    });
    item.factoryEvents.push(
      peerEvent({ ...reserved, event: "AttemptIntegrated", headSha: peerMergeSha }),
    );
    peerSnapshot = {
      ...structuredClone(snapshot),
      number: 6,
      id: "I_6",
      title: "Peer Objective",
      closed: true,
      workItems: [item],
      factoryEvents: [
        peerEvent({
          kind: "run",
          event: "ActivationRequested",
          requestId: "peer-activation",
          requestedBy: options.foreignPeerActor ? "foreign" : "operator",
          repository: "o/r",
          baseSha,
          policy,
          policyDigest: pd,
          controllerProtocolMin: "clockgrove.factory/v2",
          controllerProtocolMax: "clockgrove.factory/v2",
        }),
        peerEvent({
          kind: "run",
          event: "FactoryRunStarted",
          activationRequestId: "peer-activation",
          actor: "operator",
          repository: "o/r",
          objectiveAuthor: "operator",
          fork: false,
          baseBranch: "main",
          baseSha,
          policy,
          policyDigest: pd,
        }),
        peerEvent({
          kind: "controller",
          event: "ControllerObserved",
          ...controller,
          ...(options.foreignPeerGeneration ? { controllerId: "foreign-controller" } : {}),
          protocolMin: "clockgrove.factory/v2",
          protocolMax: "clockgrove.factory/v2",
        }),
        peerEvent({
          kind: "graph",
          event: "GraphCompiled",
          graphDigest: peerGraph.graphDigest,
          graphSize: 1,
          baseSha,
          graphRef: peerGraph.ref,
          graphBlobSha: peerGraph.blobOid,
        }),
        peerEvent({
          kind: "graph",
          event: "GraphProjected",
          graphDigest: peerGraph.graphDigest,
          graphSize: 1,
          projectionRef: peerProjection.ref,
          projectionBlobSha: peerProjection.blobOid,
        }),
        peerEvent({ kind: "run", event: "FactoryRunCompleted", policyDigest: pd }),
      ],
    };
    const terminal = peerSnapshot.factoryEvents!.pop()!;
    let peerSequence = 1;
    peerSnapshot.factoryEvents = peerSnapshot.factoryEvents!.map((entry) =>
      parseFactoryEvent({
        ...entry,
        sequence: peerSequence++,
        ...(entry.event === "ActivationRequested" ? { runId: "peer-activation" } : {}),
      }),
    );
    item.factoryEvents = item.factoryEvents.map((entry) =>
      parseFactoryEvent({ ...entry, sequence: peerSequence++ }),
    );
    peerSnapshot.factoryEvents.push(parseFactoryEvent({ ...terminal, sequence: peerSequence }));
    commits.get(reservedOid)!.message = encodeEventTrailer(
      item.factoryEvents.find((entry) => entry.event === "AttemptReserved")!,
    );
  }
  for (const name of Object.keys(storage) as Array<keyof CompiledGraphStore>) {
    // The complete immutable-store API is the transport boundary; no protocol
    // manager or Supervisor decision is mocked.
    vi.spyOn(GitHubControlStore.prototype, name).mockImplementation(storage[name] as never);
  }
  vi.spyOn(GitHubControlStore.prototype, "listRefs").mockImplementation(async (prefix) =>
    [...refs].filter(([ref]) => ref.startsWith(prefix)).map(([ref, id]) => ({ ref, oid: id })),
  );
  vi.spyOn(GitHubControlStore.prototype, "readCommitObjectiveCandidates").mockImplementation(
    async (sha) => (sha === peerMergeSha ? [6] : []),
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
  vi.spyOn(GitHubReader.prototype, "readObjective").mockImplementation(async (number) => {
    if (number === 6 && peerSnapshot) return structuredClone(peerSnapshot);
    // Concurrent Git and validation work can require more than 80 observations
    // under the full coverage matrix. Keep a finite runaway fence aligned with
    // the provider Supervisor fixture instead of racing normal slow progress.
    if (++reads > 500) throw new Error("fixture exceeded bounded snapshot reads");
    return structuredClone(snapshot);
  });
  vi.spyOn(GitHubReader.prototype, "readRunCancellationRequest").mockResolvedValue(null);
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
    [...snapshot.workItems, ...(peerSnapshot?.workItems ?? [])].find(
      (item) => item.linkedPullRequests[0]!.number === number,
    )!.linkedPullRequests[0]!;
  let refreshResponseLost = false;
  const staleRefreshHeads = new Map<number, { head: string; remaining: number }>();
  const refresh = vi.fn(
    async ({ ref, beforeOid, afterOid }: { ref: string; beforeOid: string; afterOid: string }) => {
      const item = snapshot.workItems.find(
        (entry) => `refs/heads/${publicationBranch(7, entry.number, 1)}` === ref,
      )!;
      if (!item) throw new Error("fixture refresh tried to update an unowned branch");
      const current = refs.get(ref);
      if (options.foreignRefreshHead) {
        refs.set(ref, baseSha);
        item.linkedPullRequests[0]!.headSha = baseSha;
        return false;
      }
      if (current !== beforeOid) return false;
      expect((await readCommit(afterOid)).parentOids[0]).toBe(beforeOid);
      refs.set(ref, afterOid);
      item.linkedPullRequests[0]!.headSha = afterOid;
      if (options.staleRefreshedHeadReads)
        staleRefreshHeads.set(item.linkedPullRequests[0]!.number, {
          head: beforeOid,
          remaining: options.staleRefreshedHeadReads,
        });
      options.afterRefresh?.(item.number);
      if (options.loseRefreshResponse && !refreshResponseLost) {
        refreshResponseLost = true;
        throw new PlatformUnavailableError(
          { kind: "server_error", retryAfterMs: 1 },
          new Error("fixture refresh response lost"),
        );
      }
      return true;
    },
  );
  vi.spyOn(GitHubControlStore.prototype, "compareAndSwapRef").mockImplementation(async (args) => {
    const admissionIssue =
      /^refs\/clockgrove-factory\/(?:admission\/work-item-|repository\/work-items\/work-item-)([1-9][0-9]*)$/.exec(
        args.ref,
      );
    const ownedAdmission =
      admissionIssue &&
      snapshot.workItems.some((item) => item.number === Number(admissionIssue[1]));
    if (!args.ref.startsWith("refs/clockgrove-factory/integration-admissions/") && !ownedAdmission)
      return refresh(args);
    if (refs.get(args.ref) !== args.beforeOid) return false;
    const claim = await readCommit(args.afterOid);
    if (ownedAdmission && args.ref.startsWith("refs/clockgrove-factory/admission/")) {
      const record = parseIssueAdmissionCommit(claim, Number(admissionIssue![1]));
      expect(record.priorRevisionOid).toBe(args.beforeOid);
    } else if (claim.parentOids.length !== 1 || claim.parentOids[0] !== args.beforeOid)
      throw new Error("fixture integration claim must extend its exact observed OID");
    refs.set(args.ref, args.afterOid);
    return true;
  });
  const mergeShas = new Map<number, string>();
  if (peerMergeSha) mergeShas.set(88, peerMergeSha);
  let responseLost = false;
  let mergeRejected = false;
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
      const lag = staleRefreshHeads.get(number);
      const observedHead = lag && lag.remaining-- > 0 ? lag.head : pull.headSha;
      const currentBase = git("rev-parse", "main");
      const previewState = number === 19 ? options.previewState?.() : "fresh";
      const oneShotStaleParents =
        options.stalePreviewOnce &&
        !stalePreviewServed &&
        number === 19 &&
        [...refs.keys()].filter((ref) => ref.includes("/reviews/")).length > names.length;
      const previewTree =
        options.wrongPreviewTree && number === 19
          ? git("rev-parse", `${heads[number - 18]}^{tree}`)
          : git("merge-tree", "--write-tree", currentBase, pull.headSha).split("\n")[0]!;
      const previewParents = [
        oneShotStaleParents || previewState === "stale-parents" ? baseSha : currentBase,
        pull.headSha,
      ];
      const preview = execFileSync(
        "git",
        ["commit-tree", previewTree, ...previewParents.flatMap((parent) => ["-p", parent])],
        { cwd: repository, input: "GitHub test merge", encoding: "utf8" },
      ).trim();
      if (pull.state === "OPEN")
        commits.set(preview, {
          oid: preview,
          treeOid: previewTree,
          parentOids: previewParents,
          message: "GitHub test merge",
          serverTime: new Date(),
        });
      if (oneShotStaleParents) stalePreviewOid = preview;
      return {
        number,
        nodeId: pull.id,
        baseRepository: "o/r",
        headRepository: "o/r",
        headRef: number === 88 ? publicationBranch(6, 88, 1) : publicationBranch(7, number - 10, 1),
        state: pull.state === "OPEN" ? "open" : "closed",
        draft: false,
        merged: pull.state === "MERGED",
        mergeable: true,
        mergeableState: "clean",
        headSha: observedHead,
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
      const claimOid = refs.get(integrationAdmissionRef("o/r", "main"));
      expect(claimOid).toBeDefined();
      const line = commits
        .get(claimOid!)!
        .message.split("\n")
        .find((value) => value.startsWith("Factory-Integration: "))!;
      const claim = JSON.parse(Buffer.from(line.slice(21), "base64url").toString("utf8"));
      expect(claim).toMatchObject({
        state: "dispatched",
        identity: {
          objective: 7,
          runId: "parallel",
          pullRequest: number,
          headSha,
          baseSha: git("rev-parse", "main"),
        },
      });
      if (number === 19 && options.rejectMergeOnce && !mergeRejected) {
        mergeRejected = true;
        throw Object.assign(new Error("expected head SHA no longer matches"), { status: 409 });
      }
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
      ...(options.peerAdvance ? { controllerObservation: () => controller } : {}),
      pollIntervalMs: options.pollIntervalMs ?? 1,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.onStatus ? { onStatus: options.onStatus } : {}),
    }).run();
  return {
    run,
    peerSnapshot,
    peerMergeSha,
    refresh,
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
    storage,
    lease,
    event,
  };
}

describe("Supervisor parallel independent sibling integration", () => {
  it("integrates concurrent regular publications through exact refresh and candidate validation", async () => {
    const f = await fixture({ regular: true });
    const result = await f.run();
    expect(result, result.reason).toMatchObject({ status: "completed" });
    expect(f.merge.mock.calls.map(([input]) => input.number)).toEqual([18, 19]);
    expect(f.refresh).toHaveBeenCalledOnce();
    expect(f.review).toHaveBeenCalledOnce();
    expect(f.launch).not.toHaveBeenCalled();
    expect(f.git("show", "HEAD:a.txt")).toBe("a");
    expect(f.git("show", "HEAD:b.txt")).toBe("b");
  });

  it.each([false, true])(
    "accepts an authenticated terminal co-owned Objective's exact squash (regular=%s) without resuming it",
    async (regular) => {
      const f = await fixture({ regular, peerAdvance: true, foreignPeerGeneration: true });
      const originalPeer = structuredClone(f.peerSnapshot);
      const result = await f.run();
      expect(result, result.reason).toMatchObject({ status: "completed" });
      expect(f.merge.mock.calls.map(([input]) => input.number)).toEqual([18, 19]);
      expect(f.peerSnapshot).toEqual(originalPeer);
      expect(f.git("show", "HEAD:peer.txt")).toBe("peer");
      expect(f.launch).not.toHaveBeenCalled();
      expect(
        vi
          .mocked(LeaseManager.prototype.acquire)
          .mock.calls.every(([identity]) => identity.objective === 7),
      ).toBe(true);
    },
    // Two real Git integrations plus peer proof exceeded 5 s in the concurrent suite.
    // Keep every acceptance assertion and a bounded per-case deadline.
    15000,
  );

  it.each(["foreignPeerActor", "missingPeerReview"] as const)(
    "rejects peer history with %s before any merge or paid candidate review",
    async (fault) => {
      const f = await fixture({ regular: true, peerAdvance: true, [fault]: true });
      expect(await f.run()).toMatchObject({ status: "escalated" });
      expect(f.merge).not.toHaveBeenCalled();
      expect(f.review).not.toHaveBeenCalled();
      expect(f.launch).not.toHaveBeenCalled();
    },
  );

  it("does not turn isolated peer code into host validation or infer paid-validator authority", async () => {
    const f = await fixture({ regular: true, peerAdvance: true, peerIsolated: true });
    expect(await f.run()).toMatchObject({ status: "escalated" });
    expect(f.merge).not.toHaveBeenCalled();
    expect(f.review).not.toHaveBeenCalled();
    expect(f.validate).not.toHaveBeenCalled();
    expect(f.launch).not.toHaveBeenCalled();
  });

  it.each(["failCombinedTests", "rejectReview", "externalAdvance"] as const)(
    "regular concurrent integration does not waive %s",
    async (fault) => {
      const f = await fixture({ regular: true, [fault]: true });
      expect(await f.run()).toMatchObject({ status: "escalated" });
      expect(f.merge.mock.calls.map(([input]) => input.number)).toEqual([18]);
    },
  );

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
          (entry) =>
            entry.kind === "capacity" &&
            entry.event === "CapacityReserved" &&
            entry.backend.startsWith("factory/integration-validation-"),
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
        (entry) =>
          entry.kind === "capacity" &&
          entry.event === "CapacityReserved" &&
          entry.backend.startsWith("factory/integration-validation-"),
      ),
    ).toHaveLength(1);
    expect(f.launch).not.toHaveBeenCalled();
  });

  it("refreshes only B's delivery head, then fully validates and reviews it on A's exact merge", async () => {
    const f = await fixture();
    const result = await f.run();
    expect(result, result.reason).toMatchObject({ status: "completed", runId: "parallel" });
    expect(f.merge.mock.calls.map(([input]) => input.number)).toEqual([18, 19]);
    expect(f.review).toHaveBeenCalledOnce();
    expect(f.review.mock.calls[0]![0].evidence.baseSha).toBe(f.mergeShas.get(18));
    const refreshed = f.snapshot.workItems[1]!.linkedPullRequests[0]!.headSha;
    expect(refreshed).not.toBe(f.heads[1]);
    expect(f.git("show", "-s", "--format=%P", refreshed)).toBe(
      `${f.heads[1]} ${f.mergeShas.get(18)}`,
    );
    expect(f.refresh).toHaveBeenCalledOnce();
    expect(
      f.snapshot.workItems[1]!.factoryEvents!.filter(
        (event) => event.kind === "publication" && event.event === "PublicationRecorded",
      ),
    ).toEqual([expect.objectContaining({ headSha: f.heads[1], baseSha: f.baseSha })]);
    const documents = [...f.blobs.values()].flatMap((bytes) => {
      try {
        return [JSON.parse(bytes.toString())];
      } catch {
        return [];
      }
    });
    expect(
      documents.find(
        (record) => record.protocol === "clockgrove.factory/merge-candidate-checkpoint-v1",
      )?.identity.deliveryHeadSha,
    ).toBe(refreshed);
    expect(
      documents.find(
        (record) =>
          record.protocol === "clockgrove.factory/review-checkpoint-v1" &&
          record.identity.kind === "integration-candidate",
      )?.identity.headSha,
    ).toBe(refreshed);
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

  it("accepts only equivalent recovered publication receipts while preserving the original audit history", async () => {
    const f = await fixture();
    const events = f.snapshot.workItems[1]!.factoryEvents!;
    const original = events.find((event) => event.event === "PublicationRecorded")!;
    events.push(
      f.event({
        ...original,
        sequence: 80,
        at: new Date().toISOString(),
        reason: "recovered publication receipt",
      }),
    );
    const publications = structuredClone(
      events.filter((event) => event.event === "PublicationRecorded"),
    );
    const result = await f.run();
    expect(result, result.reason).toMatchObject({ status: "completed" });
    expect(events.filter((event) => event.event === "PublicationRecorded")).toEqual(publications);
    expect(f.refresh).toHaveBeenCalledOnce();
    expect(f.validate).toHaveBeenCalledOnce();
    expect(f.review).toHaveBeenCalledOnce();
  });

  it("retains an existing refresh's exact receipt pin when an earlier equivalent envelope arrives later", async () => {
    const f = await fixture({ loseRefreshResponse: true });
    const events = f.snapshot.workItems[1]!.factoryEvents!;
    const index = events.findIndex((event) => event.event === "PublicationRecorded");
    const original = events[index]!;
    events[index] = f.event({
      ...original,
      sequence: 80,
      at: new Date().toISOString(),
      reason: "recovered publication receipt",
    });
    await expect(f.run()).rejects.toThrow(PlatformUnavailableError);
    const pinned = [...f.refs].filter(([ref]) => ref.includes("/sibling-refreshes/"));
    expect(pinned).toHaveLength(1);
    events.push(original);
    const result = await f.run();
    expect(result, result.reason).toMatchObject({ status: "completed" });
    expect([...f.refs].filter(([ref]) => ref.includes("/sibling-refreshes/"))).toEqual(pinned);
    expect(f.refresh).toHaveBeenCalledOnce();
    expect(f.validate).toHaveBeenCalledOnce();
    expect(f.review).toHaveBeenCalledOnce();
  });

  it.each(["headSha", "pullRequest", "unitId", "validationDigest"] as const)(
    "rejects a conflicting %s publication before even the original-base sibling merges",
    async (field) => {
      const f = await fixture();
      const events = f.snapshot.workItems[0]!.factoryEvents!;
      const original = events.find((event) => event.event === "PublicationRecorded")!;
      events.push(
        f.event({
          ...original,
          sequence: 80,
          [field]:
            field === "pullRequest"
              ? 20
              : field === "headSha"
                ? f.heads[1]
                : field === "validationDigest"
                  ? "f".repeat(64)
                  : "delivery/other",
        }),
      );
      expect(await f.run()).toMatchObject({ status: "escalated" });
      expect(f.merge).not.toHaveBeenCalled();
      expect(f.refresh).not.toHaveBeenCalled();
      expect(f.validate).not.toHaveBeenCalled();
      expect(f.review).not.toHaveBeenCalled();
    },
  );

  it("accounts returned validation duration but rejects a divergent refreshed tree before review", async () => {
    const f = await fixture();
    let duration = -1;
    f.validate.mockImplementationOnce(async (input) => {
      const result = await actualValidate(input);
      const { digest: _digest, ...evidence } = result.evidence;
      duration = Date.parse(evidence.completedAt) - Date.parse(evidence.startedAt);
      result.evidence = createValidationEvidence({
        ...evidence,
        outputTreeSha: f.git("rev-parse", `${f.heads[1]}^{tree}`),
      });
      return result;
    });
    const result = await f.run();
    expect(result).toMatchObject({ status: "escalated" });
    expect(result.reason).toContain("differs from the full newly validated tree");
    expect(
      f.snapshot.workItems[1]!.factoryEvents!.filter(
        (event) =>
          event.kind === "budget" &&
          event.event === "BudgetReconciled" &&
          event.unit === "validation_milliseconds",
      ),
    ).toEqual([expect.objectContaining({ amount: duration })]);
    expect([...f.refs.keys()].filter((ref) => ref.includes("/merge-candidates/"))).toHaveLength(0);
    expect(f.review).not.toHaveBeenCalled();
    expect(f.merge.mock.calls.map(([input]) => input.number)).toEqual([18]);
  });

  it("accounts but rejects a contradictory accepted review with unmet criteria before merging", async () => {
    const f = await fixture();
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
    expect(await f.run()).toMatchObject({ status: "escalated" });
    expect(f.review).toHaveBeenCalledOnce();
    expect(
      f.snapshot.workItems[1]!.factoryEvents!.filter(
        (event) =>
          event.kind === "budget" &&
          event.event === "BudgetReconciled" &&
          event.unit === "model_tokens" &&
          event.usageId?.startsWith("integration-review-"),
      ),
    ).toEqual([expect.objectContaining({ amount: 15 })]);
    expect(f.merge.mock.calls.map(([input]) => input.number)).toEqual([18]);
  });

  it("recovers an applied refresh with a lost CAS response without a second mutation or replacement worker", async () => {
    const f = await fixture({ loseRefreshResponse: true });
    await expect(f.run()).rejects.toThrow(PlatformUnavailableError);
    const head = f.snapshot.workItems[1]!.linkedPullRequests[0]!.headSha;
    expect(head).not.toBe(f.heads[1]);
    expect(f.refresh).toHaveBeenCalledOnce();
    expect(f.validate).not.toHaveBeenCalled();
    expect(f.review).not.toHaveBeenCalled();
    const result = await f.run();
    expect(result, result.reason).toMatchObject({ status: "completed" });
    expect(f.snapshot.workItems[1]!.linkedPullRequests[0]!.headSha).toBe(head);
    expect(f.refresh).toHaveBeenCalledOnce();
    expect(f.validate).toHaveBeenCalledOnce();
    expect(f.review).toHaveBeenCalledOnce();
    expect(f.launch).not.toHaveBeenCalled();
  });

  it("reuses one immutable plan after an unapplied CAS response loss, only with the same exact old/new CAS", async () => {
    const f = await fixture();
    const original = f.refresh.getMockImplementation()!;
    f.refresh.mockImplementationOnce(async () => {
      throw new PlatformUnavailableError(
        { kind: "server_error", retryAfterMs: 1 },
        new Error("CAS outcome unavailable"),
      );
    });
    await expect(f.run()).rejects.toThrow(PlatformUnavailableError);
    const first = f.refresh.mock.calls[0]![0];
    expect([...f.refs.keys()].filter((ref) => ref.includes("/sibling-refreshes/"))).toHaveLength(1);
    f.refresh.mockImplementation(original);
    const result = await f.run();
    expect(result, result.reason).toMatchObject({ status: "completed" });
    expect(f.refresh.mock.calls[1]![0]).toEqual(first);
    expect([...f.refs.keys()].filter((ref) => ref.includes("/sibling-refreshes/"))).toHaveLength(1);
    expect(f.validate).toHaveBeenCalledOnce();
    expect(f.review).toHaveBeenCalledOnce();
  });

  it("rejects a third branch head without validating, reviewing, merging, or retrying the mutation", async () => {
    const f = await fixture({ foreignRefreshHead: true });
    const result = await f.run();
    expect(result.status).toBe("escalated");
    expect(f.refresh).toHaveBeenCalledOnce();
    expect(f.validate).not.toHaveBeenCalled();
    expect(f.review).not.toHaveBeenCalled();
    expect(f.merge.mock.calls.map(([call]) => call.number)).toEqual([18]);
  });

  it("honors cancellation immediately after the exact refresh without admitting validation or review", async () => {
    const controller = new AbortController();
    const f = await fixture({ signal: controller.signal, afterRefresh: () => controller.abort() });
    const result = await f.run();
    expect(result.status).toBe("cancelled");
    expect(f.refresh).toHaveBeenCalledOnce();
    expect(f.validate).not.toHaveBeenCalled();
    expect(f.review).not.toHaveBeenCalled();
    expect(f.launch).not.toHaveBeenCalled();
  });

  it("paces old-head PR metadata after a proved applied CAS without mutating the branch again", async () => {
    const statuses: string[] = [];
    const f = await fixture({
      staleRefreshedHeadReads: 1,
      onStatus: (message) => statuses.push(message),
    });
    const result = await f.run();
    expect(result, result.reason).toMatchObject({ status: "completed" });
    expect(statuses.some((message) => message.includes("observe the exact refreshed head"))).toBe(
      true,
    );
    expect(f.refresh).toHaveBeenCalledOnce();
    expect(f.validate).toHaveBeenCalledOnce();
    expect(f.review).toHaveBeenCalledOnce();
    expect(f.merge).toHaveBeenCalledTimes(2);
  });

  it("replans after another sibling integration with a new changed-head validation and review identity", async () => {
    let state: "stale-parents" | "fresh" = "stale-parents";
    const f = await fixture({
      thirdSibling: true,
      previewState: () => state,
      afterMerge: (number) => {
        if (number === 20) state = "fresh";
      },
    });
    const result = await f.run();
    expect(result, result.reason).toMatchObject({ status: "completed" });
    expect(f.merge.mock.calls.map(([input]) => input.number)).toEqual([18, 20, 19]);
    expect(f.refresh).toHaveBeenCalledTimes(3);
    expect(f.validate).toHaveBeenCalledTimes(3);
    expect(f.review).toHaveBeenCalledTimes(3);
    const records = [...f.blobs.values()]
      .flatMap((bytes) => {
        try {
          return [JSON.parse(bytes.toString())];
        } catch {
          return [];
        }
      })
      .filter(
        (record) =>
          record.protocol === "clockgrove.factory/sibling-refresh-v1" &&
          record.identity.workItem === 9,
      );
    expect(records).toHaveLength(2);
    const latest = records.find((record) => record.previous)!;
    expect(latest.expectedOldHeadSha).toBe(
      records.find((record) => !record.previous)!.plannedHeadSha,
    );
    expect(latest.identity.targetBaseSha).toBe(f.mergeShas.get(20));
    expect(f.launch).not.toHaveBeenCalled();
  }, 15_000); // Three real Git integrations and two distinct full revalidation rounds.

  it("durably accounts completed validation before a concurrently observed, fully proved sibling advances trunk", async () => {
    const f = await fixture({ thirdSibling: true });
    let advanced = false;
    f.validate.mockImplementation(async (input) => {
      const completed = await actualValidate(input);
      if (advanced) return completed;
      advanced = true;
      // C has an independently completed original-head candidate (the existing
      // pre-refresh contract). Its real merge becomes observable while B validates.
      const item = f.snapshot.workItems[2]!;
      const sourceValidation = item.factoryEvents!.find((event) => event.kind === "validation")!;
      if (sourceValidation.kind !== "validation") throw new Error("missing C validation");
      const target = f.mergeShas.get(18)!;
      const source = bindValidationToPublishedHead({
        validation: {
          passed: true,
          digest: sourceValidation.evidenceDigest,
          baseSha: f.baseSha,
          outputTreeSha: sourceValidation.outputTreeSha,
        },
        publishedHeadSha: f.heads[2]!,
        publishedTreeSha: sourceValidation.outputTreeSha,
        publishedBaseSha: f.baseSha,
      });
      const artifact = normalizeArtifact({
        baseSha: target,
        outcome: "succeeded",
        changedPaths: ["c.txt"],
        patch: `${f.git("diff", "--binary", f.baseSha, f.heads[2]!)}\n`,
      });
      const packet = { ...parseWorkerPacketFromIssue(item.body!), baseSha: target };
      const validation = await actualValidate({ repository: f.repository, artifact, packet });
      const identity = {
        runId: "parallel",
        objective: 7,
        workItem: 10,
        attempt: 1,
        pullRequest: 20,
        sourceHeadSha: f.heads[2]!,
        sourceExactHeadValidationDigest: source.digest,
        targetBaseSha: target,
      };
      const assertCurrent = async () => {};
      const leases = {
        assertCurrent,
        assertMutationAuthorized: assertCurrent,
      } as unknown as LeaseManager;
      const candidate = await new MergeCandidateCheckpointStore(f.storage, leases).persist({
        lease: f.lease,
        identity,
        source,
        validation: validation.evidence,
      });
      const reviewIdentity = {
        kind: "integration-candidate" as const,
        runId: "parallel",
        objective: 7,
        workItem: 10,
        attempt: 1,
        artifactDigest: candidate.validation.artifactDigest,
        baseSha: target,
        outputTreeSha: candidate.validation.outputTreeSha,
        evidenceDigest: candidate.validation.digest,
        headSha: f.heads[2]!,
      };
      await new ReviewCheckpointManager(f.storage, leases).persist({
        lease: f.lease,
        identity: reviewIdentity,
        result: {
          review: {
            accepted: true,
            summary: "C exact candidate accepted",
            unmetCriteria: [],
            risks: [],
          },
          usage: { inputTokens: 10, outputTokens: 5 },
        },
      });
      await cleanValidation.discardValidationResult(validation);
      item.factoryEvents!.push(
        f.event({
          kind: "budget",
          event: "BudgetReconciled",
          workItem: 10,
          attempt: 1,
          phase: "validation",
          unit: "validation_milliseconds",
          amount:
            Date.parse(candidate.validation.completedAt) -
            Date.parse(candidate.validation.startedAt),
          usageId: `integration-validation-${mergeCandidateIdentityDigest(identity)}`,
        }),
        f.event({
          kind: "budget",
          event: "BudgetReconciled",
          workItem: 10,
          attempt: 1,
          phase: "management",
          unit: "model_tokens",
          amount: 15,
          usageId: `integration-review-${reviewIdentityDigest(reviewIdentity)}`,
        }),
      );
      const claimStore = {
        ...f.storage,
        compareAndSwapRef: (args: { ref: string; beforeOid: string; afterOid: string }) =>
          GitHubControlStore.prototype.compareAndSwapRef.call(undefined as never, args),
        readPullRequest: (number: number) =>
          GitHubControlStore.prototype.readPullRequest.call(undefined as never, number),
      };
      const sha = await withIntegrationAdmission(
        claimStore,
        {
          repository: "o/r",
          branch: "main",
          objective: 7,
          runId: "parallel",
          epoch: f.lease.epoch,
          pullRequest: 20,
          headSha: f.heads[2]!,
          baseSha: target,
          outputTreeSha: candidate.validation.outputTreeSha,
        },
        assertCurrent,
        async (admission) => {
          await admission.markDispatched("regular");
          return f.merge({ number: 20, headSha: f.heads[2]!, commitTitle: "merge C" });
        },
      );
      const reserved = item.factoryEvents!.find(
        (event) => event.kind === "attempt" && event.event === "AttemptReserved",
      )!;
      item.factoryEvents!.push(
        f.event({
          ...reserved,
          event: "AttemptIntegrated",
          sequence:
            Math.max(
              ...f.snapshot.workItems.flatMap((work) =>
                work.factoryEvents!.map((event) => event.sequence),
              ),
            ) + 1,
          headSha: sha,
        }),
      );
      item.closed = true;
      return completed;
    });
    const result = await f.run();
    expect(result, result.reason).toMatchObject({ status: "completed" });
    expect(f.validate).toHaveBeenCalledTimes(2);
    expect(f.review).toHaveBeenCalledOnce();
    expect(f.refresh).toHaveBeenCalledTimes(2);
    expect(
      f.snapshot.workItems[2]!.factoryEvents!.filter(
        (event) => event.event === "AttemptIntegrated",
      ),
    ).toHaveLength(1);
    const events = f.snapshot.workItems[1]!.factoryEvents!;
    expect(
      events.filter((event) => event.kind === "capacity" && event.event === "CapacityReconciled"),
    ).toHaveLength(2);
    expect(
      events.filter((event) => event.kind === "budget" && event.unit === "validation_milliseconds"),
    ).toHaveLength(2);
    expect(f.launch).not.toHaveBeenCalled();
  }, 15_000); // Three real Git integrations, including nested and superseding candidate validation.

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

  it("records an authoritative head rejection without retaining the branch claim", async () => {
    const f = await fixture({ regular: true, rejectMergeOnce: true });
    const result = await f.run();
    expect(result).toMatchObject({
      status: "escalated",
      reason: "expected head SHA no longer matches",
    });
    expect(f.review).toHaveBeenCalledOnce();
    expect(f.validate).toHaveBeenCalledOnce();
    expect(f.merge.mock.calls.map(([input]) => input.number)).toEqual([18, 19]);
    const oid = f.refs.get(integrationAdmissionRef("o/r", "main"))!;
    const line = (await f.storage.readCommit(oid)).message
      .split(/\r?\n/)
      .find((value) => value.startsWith("Factory-Integration: "))!;
    expect(JSON.parse(Buffer.from(line.slice(21), "base64url").toString("utf8"))).toMatchObject({
      state: "released",
      dispatch: { kind: "regular", pullRequest: 19 },
      outcome: { kind: "regular-http-rejection", status: 409 },
    });
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
      // Each due observation now additionally rebinds the immutable refresh to
      // current PR/ref/base; pacing still bounds reads independently of loop ticks.
      expect(readsWhileWaiting).toBeLessThanOrEqual(40);
      expect(f.merge.mock.calls.map(([input]) => input.number)).toEqual([18]);
      expect(f.validate).toHaveBeenCalledOnce();
      expect(f.review).toHaveBeenCalledOnce();
      expect(statuses.filter((message) => message.includes("integration waiting:"))).toHaveLength(
        1,
      );
      state = "fresh";
      await vi.advanceTimersByTimeAsync(300_000);
      vi.useRealTimers();
      const result = await completion;
      expect(result, result.reason).toMatchObject({ status: "completed" });
      expect(f.merge.mock.calls.map(([input]) => input.number)).toEqual([18, 19]);
      expect(f.validate).toHaveBeenCalledOnce();
      expect(f.review).toHaveBeenCalledOnce();
      expect(f.launch).not.toHaveBeenCalled();
      expect(f.renewLease).toHaveBeenCalled();
    },
    // Includes real Git ancestry/import work around twelve simulated minutes.
    // Scheduling bounds remain the explicit read/review/validation assertions above.
    10_000,
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
    vi.advanceTimersByTime(60_000);
    vi.useRealTimers();
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

  it("integrates a ready sibling while a closed sibling's missing receipt is deferred", async () => {
    const abort = new AbortController();
    let observedWait!: () => void;
    const waiting = new Promise<void>((resolve) => {
      observedWait = resolve;
    });
    let deferredAt = 0;
    let f!: Awaited<ReturnType<typeof fixture>>;
    f = await fixture({
      thirdSibling: true,
      pollIntervalMs: 60_000,
      signal: abort.signal,
      onStatus: (message) => {
        if (message.includes("Work Item #8 integration waiting:")) {
          // The pending publication completes outside this observation. Its retry
          // deadline remains in the future, so the next snapshot must defer receipt
          // repair without blocking the third sibling behind it.
          const head = f.heads[0];
          if (!head) throw new Error("missing first sibling head");
          f.git("merge", "--squash", head);
          f.git("commit", "-qm", "external merge PR 18");
          f.mergeShas.set(18, f.git("rev-parse", "HEAD"));
          f.snapshot.workItems[0]!.linkedPullRequests[0]!.state = "MERGED";
          f.snapshot.workItems[0]!.linkedPullRequests[0]!.mergedAt = new Date();
          f.snapshot.workItems[0]!.closed = true;
          deferredAt = Date.now();
          observedWait();
        }
      },
      afterMerge: (number) => {
        if (number === 20) abort.abort();
      },
    });
    vi.mocked(GitHubControlStore.prototype.readChecks).mockImplementation(async (headSha) => ({
      pending: headSha === f.heads[0] ? ["fixture-ci"] : [],
      failed: [],
      observed: [],
      observedChecks: [],
    }));

    const completion = f.run();
    await waiting;
    expect(deferredAt).toBeGreaterThan(0);
    const result = await completion;
    expect(Date.now() - deferredAt).toBeLessThan(60_000);
    expect(result, result.reason).toMatchObject({ status: "cancelled" });
    expect(f.merge.mock.calls.map(([input]) => input.number)).toEqual([19, 20]);
    expect(f.snapshot.workItems[0]!.closed).toBe(true);
    expect(
      f.snapshot.workItems[0]!.factoryEvents!.some(
        (event) => event.kind === "attempt" && event.event === "AttemptIntegrated",
      ),
    ).toBe(false);
    expect(f.review).toHaveBeenCalledTimes(2);
    expect(f.validate).toHaveBeenCalledTimes(2);
    expect(f.launch).not.toHaveBeenCalled();
  }, 15_000);

  it("does not claim resource cleanup when clean validation throws without completion evidence", async () => {
    const f = await fixture();
    f.validate.mockRejectedValueOnce(new Error("validator process cleanup uncertain"));
    const result = await f.run();
    expect(result.status).toBe("escalated");
    expect(f.merge.mock.calls.map(([input]) => input.number)).toEqual([18]);
    expect(f.review).not.toHaveBeenCalled();
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
