import { describe, expect, it, vi } from "vitest";
import { CompiledGraphManager, type CompiledGraphStore } from "../src/control/graphs.js";
import type { GitCommitObject, LeaseManager, LeaseState } from "../src/control/lease.js";
import { encodeEventTrailer } from "../src/control/receipts.js";
import { attemptRef } from "../src/control/attempts.js";
import { ReviewCheckpointManager } from "../src/control/reviews.js";
import { renderWorkPacket, type CompiledObjective } from "../src/graph.js";
import { parseFactoryEvent } from "../src/protocol/events.js";
import { DEFAULT_RUN_POLICY, policyDigest } from "../src/protocol/policy.js";
import type { FactoryReadSnapshot } from "../src/application/status.js";
import type { LinkedPullRequest } from "../src/types.js";
import { bindValidationToPublishedHead } from "../src/validation/plan.js";
import { assessRecovery, type RecoveryReadStore } from "../src/recovery/assessment.js";

const sha = (letter: string) => letter.repeat(40);
const now = new Date("2026-09-04T00:00:00.000Z");
const event = (fields: Record<string, unknown>) =>
  parseFactoryEvent({
    protocol: "clockgrove.factory/v2",
    objective: 7,
    runId: "source",
    sequence: 1,
    at: now.toISOString(),
    ...fields,
  });
const start = (runId = "source", sequence = 1) =>
  event({
    kind: "run",
    event: "FactoryRunStarted",
    runId,
    sequence,
    repository: "o/r",
    actor: "operator",
    objectiveAuthor: "operator",
    fork: false,
    baseBranch: "main",
    policy: DEFAULT_RUN_POLICY,
    policyDigest: policyDigest(DEFAULT_RUN_POLICY),
  });

async function fixture(topology: "regular" | "sibling" | "stack" = "regular") {
  let next = 1;
  const oid = () => (next++).toString(16).padStart(40, "0");
  const refs = new Map<string, string>();
  const commits = new Map<string, GitCommitObject>();
  const blobs = new Map<string, Buffer>();
  const trees = new Map<string, Map<string, string>>();
  const base: GitCommitObject = {
    oid: sha("a"),
    treeOid: sha("b"),
    parentOids: [],
    message: "base",
    serverTime: now,
  };
  commits.set(base.oid, base);
  const graphStore: CompiledGraphStore = {
    readRef: async (ref) => refs.get(ref) ?? null,
    readCommit: async (id) => {
      const value = commits.get(id);
      if (!value) throw new Error("unavailable");
      return value;
    },
    readBlob: async (id) => {
      const value = blobs.get(id);
      if (!value) throw new Error("unavailable");
      return value;
    },
    readTreeEntry: async (id, path) => trees.get(id)?.get(path) ?? null,
    createBlob: async (bytes) => {
      const id = oid();
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
    createCommit: async (input) => {
      const id = oid();
      commits.set(id, { ...input, oid: id, serverTime: now });
      return id;
    },
    createRef: async (ref, id) => {
      if (refs.has(ref)) return false;
      refs.set(ref, id);
      return true;
    },
  };
  const objective: CompiledObjective = {
    title: "Private Objective text",
    workItems: [
      {
        id: "feature",
        title: "Private feature text",
        goal: "Private requirement text",
        acceptance: ["Tests pass"],
        scope: ["src/feature.ts"],
        preconditions: [],
        outOfScope: [],
        conventions: [],
        dependsOn: [],
        baseSha: base.oid,
        validationCommands: ["npm test"],
        requirements: {
          os: [],
          architecture: [],
          tools: [],
          services: [],
          networkDestinations: [],
          permittedSecretNames: [],
          trust: "trusted_local",
        },
        artifactContract: "clockgrove.factory/artifact-v1",
      },
    ],
  };
  const policy =
    topology === "regular"
      ? DEFAULT_RUN_POLICY
      : {
          ...DEFAULT_RUN_POLICY,
          delivery: {
            mode: "stacked-prs" as const,
            onUnavailable: "escalate" as const,
            merge: "bottom-up" as const,
          },
        };
  if (topology !== "regular") {
    objective.workItems[0]!.delivery = { group: "feature", relationship: "root" };
    objective.workItems.push({
      ...objective.workItems[0]!,
      id: "other",
      title: "Other private feature",
      scope: ["src/other.ts"],
      dependsOn: topology === "stack" ? ["feature"] : [],
      delivery:
        topology === "stack"
          ? { group: "feature", relationship: "continue-stack", parentWorkItem: "feature" }
          : { group: "other", relationship: "root" },
    });
  }
  const lease: LeaseState = {
    objective: 7,
    runId: "source",
    holder: "operator",
    policyDigest: policyDigest(policy),
    ref: "lease",
    oid: sha("f"),
    treeOid: base.treeOid,
    epoch: 1,
    sequence: 1,
    expiresAt: now,
  };
  const manager = new CompiledGraphManager(graphStore, {
    assertCurrent: async () => {},
  } as unknown as LeaseManager);
  const graph = await manager.persist({ lease, base, objective });
  const projection = await manager.persistProjection({
    lease,
    graph,
    bindings: objective.workItems.map((item, index) => ({
      compilerId: item.id,
      issueNodeId: `issue-${8 + index}`,
      issueNumber: 8 + index,
    })),
  });
  const review = await new ReviewCheckpointManager(graphStore, {
    assertCurrent: async () => {},
  } as unknown as LeaseManager).persist({
    lease,
    identity: {
      kind: "artifact",
      runId: "source",
      objective: 7,
      workItem: 8,
      attempt: 1,
      artifactDigest: "e".repeat(64),
      baseSha: base.oid,
      outputTreeSha: sha("e"),
      evidenceDigest: "f".repeat(64),
    },
    result: {
      review: { accepted: true, summary: "Private semantic summary", unmetCriteria: [], risks: [] },
      usage: { inputTokens: 10, outputTokens: 5 },
    },
  });
  const snapshot: FactoryReadSnapshot = {
    id: "objective-7",
    number: 7,
    title: objective.title,
    repositoryId: "repo-1",
    authorLogin: "operator",
    defaultBranch: "main",
    closed: false,
    factoryEvents: [
      start(),
      event({
        kind: "graph",
        event: "GraphCompiled",
        sequence: 2,
        graphDigest: graph.graphDigest,
        graphSize: 1,
        baseSha: base.oid,
        graphRef: graph.ref,
        graphBlobSha: graph.blobOid,
      }),
      event({
        kind: "graph",
        event: "GraphProjected",
        sequence: 3,
        graphDigest: graph.graphDigest,
        graphSize: 1,
        projectionRef: projection.ref,
        projectionBlobSha: projection.blobOid,
      }),
      event({ kind: "run", event: "FactoryRunEscalated", sequence: 30 }),
    ],
    workItems: [
      {
        id: "issue-8",
        number: 8,
        title: objective.workItems[0]!.title,
        body: renderWorkPacket(objective.workItems[0]!, {
          protocol: "clockgrove.factory/graph-v1",
          id: "feature",
          graphDigest: graph.graphDigest,
          graphSize: 1,
          index: 0,
          dependsOn: [],
        }),
        closed: false,
        blockedBy: [],
        linkedPullRequests: [],
        copilotAssignments: [],
        factoryEvents: [],
      },
    ],
  };
  if (topology !== "regular") {
    snapshot.factoryEvents![0] = event({
      ...start("source", 0),
      policy,
      policyDigest: policyDigest(policy),
    });
    snapshot.factoryEvents!.push(
      event({
        kind: "delivery",
        event: "DeliverySelected",
        sequence: 1,
        requested: "stacked-prs",
        selected: "native-stacks",
        capabilityVersion: "2026-03-10",
        reason: "Observed supported native delivery",
      }),
    );
    for (let index = 1; index <= 2; index++)
      snapshot.factoryEvents![index] = event({ ...snapshot.factoryEvents![index]!, graphSize: 2 });
    snapshot.workItems = objective.workItems.map((item, index) => ({
      id: `issue-${8 + index}`,
      number: 8 + index,
      title: item.title,
      body: renderWorkPacket(item, {
        protocol: "clockgrove.factory/graph-v1",
        id: item.id,
        graphDigest: graph.graphDigest,
        graphSize: 2,
        index,
        dependsOn: item.dependsOn,
      }),
      closed: false,
      blockedBy: item.dependsOn.map(() => ({ number: 8, closed: false })),
      linkedPullRequests: [],
      copilotAssignments: [],
      factoryEvents: [],
    }));
  }
  const pull: Awaited<ReturnType<RecoveryReadStore["readPullRequest"]>> = {
    number: 9,
    nodeId: "pull-9",
    baseRepository: "o/r",
    headRepository: "o/r",
    headRef: "factory/objective-7/work-item-8/attempt-1",
    state: "open",
    merged: false,
    mergeable: true,
    mergeableState: "clean",
    draft: false,
    headSha: sha("c"),
    baseSha: base.oid,
    baseRef: "main",
    mergeCommitSha: null,
    createdAt: now,
  };
  const checks = {
    pending: [] as string[],
    failed: [] as string[],
    observed: [] as string[],
    observedChecks: [] as { context: string; integrationId: number | null }[],
  };
  const port = Object.freeze({
    readRef: vi.fn(graphStore.readRef),
    readCommit: vi.fn(graphStore.readCommit),
    readBlob: vi.fn(graphStore.readBlob),
    readTreeEntry: vi.fn(graphStore.readTreeEntry),
    listRefs: vi.fn(async (prefix: string) =>
      [...refs].filter(([ref]) => ref.startsWith(prefix)).map(([ref, oid]) => ({ ref, oid })),
    ),
    readPullRequest: vi.fn(async () => pull),
    getRepositoryFacts: vi.fn(async () => ({
      fullName: "o/r",
      fork: false,
      private: true,
      defaultBranch: "main",
      canPush: true,
    })),
    getBranchHead: vi.fn(async () => base),
    readBranchRules: vi.fn(async () => []),
    readChecks: vi.fn(async () => checks),
  } satisfies RecoveryReadStore);
  const attempt = (fields: Record<string, unknown>) =>
    event({
      kind: "attempt",
      workItem: 8,
      attempt: 1,
      backend: "codex-sdk/local-worktree",
      baseSha: base.oid,
      directorEpoch: 1,
      policyDigest: policyDigest(policy),
      ...fields,
    });
  const reserve = () => {
    const receipt = attempt({ event: "AttemptReserved", sequence: 4 });
    snapshot.workItems[0]!.factoryEvents!.push(receipt);
    refs.set(attemptRef(7, 8, 1), sha("d"));
    commits.set(sha("d"), {
      oid: sha("d"),
      treeOid: base.treeOid,
      parentOids: [base.oid],
      message: encodeEventTrailer(receipt),
      serverTime: now,
    });
  };
  const artifact = () => {
    reserve();
    snapshot.workItems[0]!.factoryEvents!.push(
      attempt({ event: "AttemptStarted", sequence: 5 }),
      attempt({ event: "AttemptCollected", sequence: 6, artifactDigest: "e".repeat(64) }),
      event({
        kind: "validation",
        event: "ValidationRecorded",
        sequence: 7,
        workItem: 8,
        attempt: 1,
        baseSha: base.oid,
        outputTreeSha: sha("e"),
        passed: true,
        evidenceDigest: "f".repeat(64),
      }),
      event({
        kind: "budget",
        event: "BudgetReconciled",
        sequence: 8,
        workItem: 8,
        attempt: 1,
        phase: "management",
        unit: "model_tokens",
        amount: 15,
        usageId: `review-${review.identityDigest}`,
      }),
      attempt({ event: "AttemptValidated", sequence: 9, artifactDigest: "e".repeat(64) }),
    );
    refs.set(`refs/heads/${pull.headRef}`, pull.headSha);
    commits.set(pull.headSha, {
      oid: pull.headSha,
      treeOid: sha("e"),
      parentOids: [base.oid],
      message:
        "Private commit text\nFactory-Artifact: " +
        "e".repeat(64) +
        "\nFactory-Validation: " +
        "f".repeat(64),
      serverTime: now,
    });
  };
  const publish = () => {
    artifact();
    const binding = bindValidationToPublishedHead({
      validation: {
        passed: true,
        digest: "f".repeat(64),
        baseSha: base.oid,
        outputTreeSha: sha("e"),
      },
      publishedHeadSha: pull.headSha,
      publishedTreeSha: sha("e"),
      publishedBaseSha: base.oid,
    });
    snapshot.workItems[0]!.factoryEvents!.push(
      attempt({
        event: "AttemptPublished",
        sequence: 10,
        headSha: pull.headSha,
        artifactDigest: "e".repeat(64),
      }),
      event({
        kind: "publication",
        event: "PublicationRecorded",
        sequence: 11,
        workItem: 8,
        attempt: 1,
        unitId: "delivery/feature",
        itemId: "feature",
        mode: topology === "regular" ? "regular-prs" : "native-stacks",
        ...(topology === "stack" ? { stackNumber: 1 } : {}),
        position: 0,
        branch: pull.headRef,
        baseBranch: "main",
        baseSha: base.oid,
        headSha: pull.headSha,
        pullRequest: 9,
        capabilityVersion: "2026-03-10",
        validationDigest: "f".repeat(64),
        exactHeadValidationDigest: binding.digest,
      }),
    );
    snapshot.workItems[0]!.linkedPullRequests = [
      {
        id: "pull-9",
        number: 9,
        state: "OPEN",
        headSha: pull.headSha,
        checks: null,
      } as LinkedPullRequest,
    ];
  };
  return {
    snapshot,
    port,
    refs,
    commits,
    blobs,
    base,
    graph,
    projection,
    review,
    graphStore,
    lease,
    pull,
    checks,
    reserve,
    artifact,
    publish,
    assess: () => assessRecovery({ repository: "o/r", snapshot, store: port }),
  };
}

describe("read-only recovery assessment", () => {
  it.each([
    "unfinished",
    "reconciliation-required",
    "recoverable-artifact",
    "reusable-publication",
    "already-integrated",
  ] as const)(
    "classifies %s without authorizing execution or mutating the store",
    async (classification) => {
      const f = await fixture();
      if (classification === "reconciliation-required") f.reserve();
      if (classification === "recoverable-artifact") f.artifact();
      if (classification === "reusable-publication" || classification === "already-integrated")
        f.publish();
      if (classification === "already-integrated") {
        f.pull.merged = true;
        f.pull.state = "closed";
        f.pull.mergeCommitSha = sha("9");
        f.snapshot.workItems[0]!.closed = true;
        f.snapshot.workItems[0]!.linkedPullRequests![0]!.state = "MERGED";
        f.commits.set(sha("9"), { ...f.commits.get(sha("c"))!, oid: sha("9") });
      }
      const before = structuredClone({ refs: f.refs, commits: f.commits, snapshot: f.snapshot });
      const result = await f.assess();
      expect(result).toMatchObject({
        executionAuthorized: false,
        successorAvailable: false,
        workItems: [{ number: 8, classification }],
      });
      expect(result.blockers).toContainEqual(
        expect.objectContaining({ code: "successor-unavailable" }),
      );
      expect({ refs: f.refs, commits: f.commits, snapshot: f.snapshot }).toEqual(before);
      expect(JSON.stringify(result)).not.toMatch(
        /Private (Objective|feature|requirement|commit) text/,
      );
      if (classification !== "unfinished")
        expect(result.workItems[0]).toMatchObject({
          resourceState: "unavailable",
          resourceReconciliationRequired: true,
        });
    },
  );

  it.each([
    "head",
    "base",
    "repository",
    "node",
    "tree",
    "closed-unmerged",
    "failed-check",
    "pending-check",
    "foreign-PR",
  ])("blocks a publication with changed or unavailable %s evidence", async (change) => {
    const f = await fixture();
    f.publish();
    if (change === "head") f.pull.headSha = sha("8");
    if (change === "base") f.pull.baseSha = sha("8");
    if (change === "repository") f.pull.headRepository = "foreign/repo";
    if (change === "node") f.pull.nodeId = "foreign-node";
    if (change === "tree") f.commits.get(sha("c"))!.treeOid = sha("8");
    if (change === "closed-unmerged") f.pull.state = "closed";
    if (change === "failed-check") f.checks.failed.push("review");
    if (change === "pending-check") f.checks.pending.push("tests");
    if (change === "foreign-PR") f.snapshot.workItems[0]!.linkedPullRequests = [];
    const result = await f.assess();
    expect(result.workItems[0]!.classification).toBe("blocked");
    if (change === "head" || change === "base")
      expect(result.workItems[0]!.requiresRevalidation).toBe(true);
  });

  it.each([
    "missing-graph",
    "missing-projection",
    "removed-child",
    "replaced-child",
    "body",
    "forged-start",
    "forged-reservation",
    "missing-start",
  ])("fails closed for %s instead of adopting history", async (change) => {
    const f = await fixture();
    f.publish();
    if (change === "missing-graph") f.refs.delete(f.graph.ref);
    if (change === "missing-projection") f.refs.delete(f.projection.ref);
    if (change === "removed-child") f.snapshot.workItems = [];
    if (change === "replaced-child") f.snapshot.workItems[0]!.id = "attacker-issue";
    if (change === "body") f.snapshot.workItems[0]!.body += "\nmalicious edit";
    if (change === "forged-start")
      f.snapshot.factoryEvents![0] = event({ ...start(), repository: "foreign/repo" });
    if (change === "forged-reservation")
      f.commits.get(sha("d"))!.message = encodeEventTrailer(
        event({ ...f.snapshot.workItems[0]!.factoryEvents![0]!, runId: "forged" }),
      );
    if (change === "missing-start") {
      f.snapshot.factoryEvents = [];
      f.snapshot.workItems[0]!.factoryEvents = [];
    }
    const result = await f.assess();
    expect(result.availability).toBe("incomplete");
    expect(result.workItems.every((item) => item.classification === "blocked")).toBe(true);
    if (change === "removed-child" || change === "missing-start")
      expect(result.orphanReservations).toHaveLength(1);
  });

  it("does not hide executed history behind a later empty failed run", async () => {
    const f = await fixture();
    f.publish();
    f.snapshot.factoryEvents!.push(
      start("later", 31),
      event({ kind: "run", event: "FactoryRunEscalated", sequence: 32, runId: "later" }),
    );
    const result = await f.assess();
    expect(result.runs).toHaveLength(2);
    expect(result.workItems[0]).toMatchObject({
      classification: "reusable-publication",
      runId: "source",
    });
  });

  it.each(["FAILURE", "PENDING", "missing"] as const)(
    "blocks a runless %s check-suite rollup despite empty REST checks",
    async (rollup) => {
      const f = await fixture();
      f.publish();
      const linked = f.snapshot.workItems[0]!.linkedPullRequests![0]!;
      if (rollup === "missing") Reflect.deleteProperty(linked, "checks");
      else linked.checks = rollup;
      expect(f.checks).toMatchObject({ failed: [], pending: [], observed: [] });
      const result = await f.assess();
      expect(result.workItems[0]).toMatchObject({
        classification: "blocked",
        blockerCode:
          rollup === "FAILURE"
            ? "checks-failed"
            : rollup === "PENDING"
              ? "checks-pending"
              : "checks-unavailable",
      });
      expect(f.port.readChecks).not.toHaveBeenCalled();
    },
  );

  it("retains proven integration despite a later failing check-suite rollup", async () => {
    const f = await fixture();
    f.publish();
    f.pull.merged = true;
    f.pull.state = "closed";
    f.pull.mergeCommitSha = sha("9");
    f.snapshot.workItems[0]!.closed = true;
    f.snapshot.workItems[0]!.linkedPullRequests![0]!.state = "MERGED";
    f.snapshot.workItems[0]!.linkedPullRequests![0]!.checks = "FAILURE";
    f.commits.set(sha("9"), { ...f.commits.get(sha("c"))!, oid: sha("9") });
    expect((await f.assess()).workItems[0]!.classification).toBe("already-integrated");
  });

  it.each([
    "missing-checkpoint",
    "stale-acceptance",
    "wrong-artifact",
    "wrong-usage",
    "missing-usage",
    "invalidated",
    "pending-integration",
    "conflicting-terminal",
    "pre-start-terminal",
  ])("rejects %s evidence instead of claiming publication reuse", async (change) => {
    const f = await fixture();
    f.publish();
    const history = f.snapshot.workItems[0]!.factoryEvents!;
    if (change === "missing-checkpoint") f.refs.delete(f.review.ref);
    if (change === "stale-acceptance") {
      const index = history.findIndex((receipt) => receipt.event === "AttemptValidated");
      history[index] = event({ ...history[index]!, sequence: 6 });
    }
    if (change === "wrong-artifact") {
      const index = history.findIndex((receipt) => receipt.event === "AttemptValidated");
      history[index] = event({ ...history[index]!, artifactDigest: "9".repeat(64) });
    }
    if (change === "wrong-usage") {
      const index = history.findIndex((receipt) => receipt.kind === "budget");
      history[index] = event({ ...history[index]!, amount: 16 });
    }
    if (change === "missing-usage")
      f.snapshot.workItems[0]!.factoryEvents = history.filter(
        (receipt) => receipt.kind !== "budget",
      );
    if (change === "invalidated" || change === "pending-integration") {
      const publication = history.find((receipt) => receipt.kind === "publication")!;
      history.push(
        event({
          ...publication,
          sequence: 12,
          event: change === "invalidated" ? "ValidationInvalidated" : "IntegrationPending",
          ...(change === "invalidated"
            ? { invalidatedByItem: "parent", invalidatedByHeadSha: sha("9") }
            : { operationId: "pending" }),
        }),
      );
    }
    if (change === "conflicting-terminal")
      f.snapshot.factoryEvents!.push(
        event({ kind: "run", event: "FactoryRunCancelled", sequence: 31 }),
      );
    if (change === "pre-start-terminal")
      f.snapshot.factoryEvents![3] = event({
        kind: "run",
        event: "FactoryRunEscalated",
        sequence: 0,
      });
    const result = await f.assess();
    expect(result.workItems[0]!.classification).toBe("blocked");
    expect(result.availability).toBe("incomplete");
  });

  it.each(["verified", "unavailable", "wrong-head", "wrong-position", "closed-stack"])(
    "checks observed native stack topology: %s",
    async (state) => {
      const f = await fixture("stack");
      f.publish();
      const history = f.snapshot.workItems[0]!.factoryEvents!;
      const index = history.findIndex((receipt) => receipt.kind === "publication");
      history[index] = event({ ...history[index]!, mode: "native-stacks", stackNumber: 1 });
      const member = {
        number: 9,
        state: "open",
        draft: false,
        mergedAt: null,
        headRef: f.pull.headRef!,
        headSha: state === "wrong-head" ? sha("8") : f.pull.headSha,
        baseRef: f.pull.baseRef,
        baseSha: f.pull.baseSha,
      };
      const readStack = vi.fn(async () => ({
        number: 1,
        baseRef: "main",
        open: state !== "closed-stack",
        pullRequests: state === "wrong-position" ? [{ ...member, number: 10 }, member] : [member],
      }));
      const result = await assessRecovery({
        repository: "o/r",
        snapshot: f.snapshot,
        store: { ...f.port, ...(state === "unavailable" ? {} : { readStack }) },
      });
      expect(result.workItems[0]!.classification).toBe(
        state === "verified" ? "reusable-publication" : "blocked",
      );
      if (state !== "unavailable") expect(readStack).toHaveBeenCalledOnce();
    },
  );

  it("accepts an independent native-mode sibling without inventing stack membership", async () => {
    const f = await fixture("sibling");
    f.publish();
    const readStack = vi.fn(async () => {
      throw new Error("sibling must not query a stack");
    });
    const result = await assessRecovery({
      repository: "o/r",
      snapshot: f.snapshot,
      store: { ...f.port, readStack },
    });
    expect(result.workItems).toEqual([
      expect.objectContaining({ number: 8, classification: "reusable-publication" }),
      expect.objectContaining({ number: 9, classification: "unfinished" }),
    ]);
    expect(readStack).not.toHaveBeenCalled();
  });

  it.each([
    "missing-stack-id",
    "wrong-unit",
    "missing-selection",
    "sibling-with-stack-id",
    "sibling-wrong-base",
  ])("rejects native delivery identity mismatch: %s", async (change) => {
    const f = await fixture(change.startsWith("sibling") ? "sibling" : "stack");
    f.publish();
    const history = f.snapshot.workItems[0]!.factoryEvents!;
    const index = history.findIndex((receipt) => receipt.kind === "publication");
    if (change === "missing-stack-id") {
      const changed = { ...history[index]! };
      delete changed.stackNumber;
      history[index] = event(changed);
    }
    if (change === "wrong-unit")
      history[index] = event({ ...history[index]!, unitId: "delivery/other" });
    if (change === "missing-selection")
      f.snapshot.factoryEvents = f.snapshot.factoryEvents!.filter(
        (receipt) => receipt.kind !== "delivery",
      );
    if (change === "sibling-with-stack-id")
      history[index] = event({ ...history[index]!, stackNumber: 1 });
    if (change === "sibling-wrong-base") f.pull.baseRef = "foreign-branch";
    expect((await f.assess()).workItems[0]!.classification).toBe("blocked");
  });

  it("does not leak provider exceptions or treat unreadable refs as absence", async () => {
    const f = await fixture();
    f.port.listRefs.mockRejectedValue(new Error("SECRET_PRIVATE_PROVIDER_EXCEPTION"));
    const result = await f.assess();
    expect(result.workItems[0]!.classification).toBe("blocked");
    expect(result.blockers).toContainEqual(
      expect.objectContaining({ code: "reservation-unavailable" }),
    );
    expect(JSON.stringify(result)).not.toContain("SECRET_PRIVATE_PROVIDER_EXCEPTION");
  });

  it.each(["objective-events", "child-events", "child-pulls", "child-assignments", "child-closed"])(
    "does not treat omitted %s observation as empty",
    async (missing) => {
      const f = await fixture();
      if (missing === "objective-events") delete f.snapshot.factoryEvents;
      if (missing === "child-events") delete f.snapshot.workItems[0]!.factoryEvents;
      if (missing === "child-pulls") delete f.snapshot.workItems[0]!.linkedPullRequests;
      if (missing === "child-assignments") delete f.snapshot.workItems[0]!.copilotAssignments;
      if (missing === "child-closed") delete f.snapshot.workItems[0]!.closed;
      const result = await f.assess();
      expect(result.workItems[0]).toMatchObject({
        classification: "blocked",
        blockerCode: "history-unavailable",
      });
    },
  );

  it("binds a completed rebase review without requiring a duplicate artifact-acceptance event", async () => {
    const f = await fixture();
    f.publish();
    const checkpoint = await new ReviewCheckpointManager(f.graphStore, {
      assertCurrent: async () => {},
    } as unknown as LeaseManager).persist({
      lease: f.lease,
      identity: {
        ...f.review.identity,
        kind: "rebase",
        evidenceDigest: "9".repeat(64),
        headSha: f.pull.headSha,
      },
      result: {
        review: { accepted: true, summary: "Private rebase review", unmetCriteria: [], risks: [] },
        usage: { inputTokens: 20, outputTokens: 5 },
      },
    });
    const history = f.snapshot.workItems[0]!.factoryEvents!;
    history.push(
      event({
        kind: "budget",
        event: "BudgetReconciled",
        sequence: 12,
        workItem: 8,
        attempt: 1,
        phase: "management",
        unit: "model_tokens",
        amount: 25,
        usageId: `rebase-review-${checkpoint.identityDigest}`,
      }),
      event({
        kind: "validation",
        event: "ValidationRecorded",
        sequence: 13,
        workItem: 8,
        attempt: 1,
        baseSha: f.base.oid,
        outputTreeSha: sha("e"),
        passed: true,
        evidenceDigest: "9".repeat(64),
      }),
    );
    const publication = history.find((receipt) => receipt.kind === "publication")!;
    const binding = bindValidationToPublishedHead({
      validation: {
        passed: true,
        digest: "9".repeat(64),
        baseSha: f.base.oid,
        outputTreeSha: sha("e"),
      },
      publishedHeadSha: f.pull.headSha,
      publishedTreeSha: sha("e"),
      publishedBaseSha: f.base.oid,
    });
    history.push(
      event({
        ...publication,
        sequence: 14,
        validationDigest: "9".repeat(64),
        exactHeadValidationDigest: binding.digest,
      }),
    );
    expect((await f.assess()).workItems[0]!.classification).toBe("reusable-publication");
    f.refs.delete(checkpoint.ref);
    expect((await f.assess()).workItems[0]).toMatchObject({
      classification: "blocked",
      blockerCode: "semantic-review-unavailable",
    });
  });

  it("sorts historical starts by sequence rather than raw snapshot order", async () => {
    const f = await fixture();
    f.publish();
    f.snapshot.factoryEvents!.push(
      start("later", 31),
      event({ kind: "run", event: "FactoryRunEscalated", sequence: 32, runId: "later" }),
    );
    f.snapshot.factoryEvents!.reverse();
    expect((await f.assess()).runs.map((run) => run.runId)).toEqual(["source", "later"]);
  });

  it("requires revalidation of a recoverable artifact when the current base advances", async () => {
    const f = await fixture();
    f.artifact();
    f.port.getBranchHead.mockResolvedValue({ ...f.base, oid: sha("8") });
    const result = await f.assess();
    expect(result.workItems[0]).toMatchObject({
      classification: "recoverable-artifact",
      requiresRevalidation: true,
    });
  });

  it("caches repeated commit reads and bounds complete reservation inspection", async () => {
    const f = await fixture();
    f.publish();
    const result = await f.assess();
    expect(f.port.readCommit.mock.calls.filter(([oid]) => oid === sha("c"))).toHaveLength(1);
    expect(result.reads.performed).toBeLessThanOrEqual(result.reads.limit);
    f.port.listRefs.mockResolvedValue(
      Array.from({ length: 1_001 }, (_, index) => ({ ref: `ref-${index}`, oid: sha("1") })),
    );
    const oversized = await f.assess();
    expect(oversized.blockers).toContainEqual(
      expect.objectContaining({ code: "reservation-unavailable" }),
    );
  });
});
