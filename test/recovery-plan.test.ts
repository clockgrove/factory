import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { attemptRef } from "../src/control/attempts.js";
import {
  compiledGraphRef,
  compiledGraphProjectionRef,
  type CompiledGraphReadStore,
  type CompiledGraphStore,
} from "../src/control/graphs.js";
import type { GitCommitObject, LeaseState } from "../src/control/lease.js";
import { DEFAULT_RUN_POLICY, policyDigest } from "../src/protocol/policy.js";
import {
  loadRecoveryPlan,
  MAX_RECOVERY_PLAN_BYTES,
  parseRecoveryPlan,
  RECOVERY_PLAN_PROTOCOL,
  recoveryHistoryDigest,
  recoveryPlanBindingDigest,
  recoveryPlanDigest,
  recoveryPlanRef,
  RecoveryPlanManager,
  type RecoveryPlan,
} from "../src/recovery/plan.js";

const sha = (character: string) => character.repeat(40);
const digest = (character: string) => character.repeat(64);
const base = sha("a");
function proposal(): RecoveryPlan {
  const acceptedPolicy = structuredClone(DEFAULT_RUN_POLICY);
  const history = [
    {
      runId: "source",
      startDigest: digest("b"),
      terminalDigest: digest("c"),
      terminalEvent: "FactoryRunEscalated" as const,
      terminalSequence: 10,
      policyDigest: policyDigest(acceptedPolicy),
    },
  ];
  const items: RecoveryPlan["items"] = [
    {
      workItem: 8,
      issueNodeId: "I_8",
      compilerId: "work",
      action: "execute",
      source: null,
      observedPullRequest: null,
      resources: { state: "not-required", receiptDigest: null, identities: [] },
    },
  ];
  const allowance = {
    modelTokens: null,
    sandboxMinutes: 0,
    managedSessions: 0,
    implementationAttemptsPerItem: 3,
  };
  return {
    protocol: RECOVERY_PLAN_PROTOCOL,
    repository: "fixture/project",
    repositoryId: "R_fixture",
    objective: 7,
    objectiveNodeId: "I_7",
    requestId: "request-one",
    successorRunId: "successor",
    predecessor: {
      runId: "source",
      startDigest: digest("b"),
      terminalDigest: digest("c"),
      terminalEvent: "FactoryRunEscalated",
      terminalSequence: 10,
    },
    history,
    historyDigest: recoveryHistoryDigest(history),
    sourceEventsDigest: digest("d"),
    sourceEventMaxSequence: 10,
    priorPlanDigest: null,
    expectedBaseSha: base,
    baseBranch: "main",
    graph: {
      sourceRunId: "source",
      ref: compiledGraphRef(7, "source"),
      commitOid: sha("b"),
      blobOid: sha("c"),
      digest: digest("e"),
      projection: {
        ref: compiledGraphProjectionRef(7, "source"),
        commitOid: sha("d"),
        blobOid: sha("e"),
        bindingDigest: recoveryPlanBindingDigest(items),
      },
    },
    acceptedPolicy,
    policyDigest: policyDigest(acceptedPolicy),
    allowance: {
      before: { ...allowance },
      increment: {
        modelTokens: 0,
        sandboxMinutes: 0,
        managedSessions: 0,
        implementationAttemptsPerItem: 0,
      },
      after: { ...allowance },
    },
    unknownUsageAcknowledgementDigest: null,
    items,
  };
}

function publicationProposal(): RecoveryPlan {
  const plan = proposal();
  const item = plan.items[0]!;
  item.action = "reuse-publication";
  item.source = {
    runId: "source",
    attempt: 1,
    reservationRef: attemptRef(7, 8, 1),
    reservationCommitOid: sha("1"),
    reservationReceiptDigest: digest("1"),
    artifactDigest: digest("2"),
    validation: {
      receiptDigest: digest("3"),
      evidenceDigest: digest("4"),
      baseSha: base,
      outputTreeSha: sha("2"),
    },
    review: {
      ref: `refs/clockgrove-factory/reviews/objective-7/work-item-8/attempt-1/artifact-${digest("5")}`,
      commitOid: sha("3"),
      blobOid: sha("4"),
      identityDigest: digest("5"),
    },
    publication: {
      receiptDigest: digest("6"),
      mode: "regular-prs",
      pullRequest: 9,
      pullRequestNodeId: "PR_9",
      branch: "factory/work-8",
      baseBranch: "main",
      baseSha: base,
      headSha: sha("5"),
      baseRepository: plan.repository,
      headRepository: plan.repository,
      stackNumber: null,
    },
  };
  item.observedPullRequest = {
    number: 9,
    nodeId: "PR_9",
    headSha: sha("5"),
    baseSha: base,
    treeSha: sha("2"),
    headRef: "factory/work-8",
    baseRef: "main",
    headRepository: plan.repository,
    baseRepository: plan.repository,
    state: "open",
  };
  return plan;
}

class Store implements CompiledGraphStore {
  refs = new Map<string, string>();
  commits = new Map<string, GitCommitObject>();
  blobs = new Map<string, Buffer>();
  trees = new Map<string, Map<string, string>>();
  operations: string[] = [];
  validLease = true;
  loseLeaseAfter: string | null = null;
  loseAfter: string | null = null;
  sequence = 0;
  constructor() {
    this.commits.set(base, {
      oid: base,
      treeOid: sha("f"),
      parentOids: [],
      message: "base",
      serverTime: new Date("2026-09-04T00:00:00Z"),
    });
  }
  async assertCurrent() {
    this.operations.push("fence");
    if (!this.validLease) throw new Error("lease lost");
  }
  private write(kind: string) {
    expect(this.operations.at(-1)).toBe("fence");
    this.operations.push(kind);
    return createHash("sha1")
      .update(`${kind}-${this.sequence++}`)
      .digest("hex");
  }
  private response(kind: string) {
    if (this.loseLeaseAfter === kind) this.validLease = false;
    if (this.loseAfter === kind) {
      this.loseAfter = null;
      throw new Error(`lost ${kind} response`);
    }
  }
  async readRef(ref: string) {
    return this.refs.get(ref) ?? null;
  }
  async readCommit(oid: string) {
    const value = this.commits.get(oid);
    if (!value) throw new Error("missing commit");
    return value;
  }
  async readBlob(oid: string) {
    const value = this.blobs.get(oid);
    if (!value) throw new Error("missing blob");
    return value;
  }
  async readTreeEntry(oid: string, path: string) {
    return this.trees.get(oid)?.get(path) ?? null;
  }
  async createBlob(content: Buffer) {
    const oid = this.write("blob");
    this.blobs.set(oid, content);
    this.response("blob");
    return oid;
  }
  async createTree(args: Parameters<CompiledGraphStore["createTree"]>[0]) {
    const oid = this.write("tree");
    this.trees.set(
      oid,
      new Map(
        args.entries.filter((entry) => entry.sha !== null).map((entry) => [entry.path, entry.sha!]),
      ),
    );
    this.response("tree");
    return oid;
  }
  async createCommit(args: Parameters<CompiledGraphStore["createCommit"]>[0]) {
    const oid = this.write("commit");
    this.commits.set(oid, { oid, ...args, serverTime: new Date("2026-09-04T00:00:00Z") });
    this.response("commit");
    return oid;
  }
  async createRef(ref: string, oid: string) {
    this.write("ref");
    const won = !this.refs.has(ref);
    if (won) this.refs.set(ref, oid);
    this.response("ref");
    return won;
  }
  readPort(): CompiledGraphReadStore {
    return Object.freeze({
      readRef: this.readRef.bind(this),
      readCommit: this.readCommit.bind(this),
      readBlob: this.readBlob.bind(this),
      readTreeEntry: this.readTreeEntry.bind(this),
    });
  }
}
function lease(plan: RecoveryPlan): LeaseState {
  return {
    objective: plan.objective,
    runId: plan.successorRunId,
    holder: "operator",
    policyDigest: plan.policyDigest,
    ref: "refs/clockgrove-factory/leases/objective-7",
    oid: sha("1"),
    treeOid: sha("f"),
    epoch: 1,
    sequence: 11,
    expiresAt: new Date("2026-09-04T00:10:00Z"),
  };
}

describe("immutable recovery proposal", () => {
  it("preserves exact original source provenance for open and integrated publications", () => {
    const plan = publicationProposal();
    expect(parseRecoveryPlan(plan)).toEqual(plan);
    plan.items[0]!.action = "integrated";
    plan.items[0]!.observedPullRequest!.state = "merged";
    expect(parseRecoveryPlan(plan)).toEqual(plan);
  });

  it("requires validation and semantic acceptance for artifact reuse; raw artifacts need revalidation", () => {
    const plan = publicationProposal();
    const item = plan.items[0]!;
    item.action = "reuse-artifact";
    item.source!.publication = null;
    item.observedPullRequest = null;
    expect(parseRecoveryPlan(plan)).toEqual(plan);
    item.source!.review = null;
    expect(() => parseRecoveryPlan(plan)).toThrow("semantic-review");
    item.source!.validation = null;
    expect(() => parseRecoveryPlan(plan)).toThrow("validation");
    item.action = "revalidate";
    expect(parseRecoveryPlan(plan)).toEqual(plan);
  });

  it.each([
    [
      "validation base",
      (p: RecoveryPlan) => {
        p.items[0]!.source!.validation!.baseSha = sha("9");
      },
    ],
    [
      "source run",
      (p: RecoveryPlan) => {
        p.items[0]!.source!.runId = "foreign";
      },
    ],
    [
      "reservation scope",
      (p: RecoveryPlan) => {
        p.items[0]!.source!.reservationRef = attemptRef(9, 8, 1);
      },
    ],
    [
      "review scope",
      (p: RecoveryPlan) => {
        p.items[0]!.source!.review!.ref =
          `refs/clockgrove-factory/reviews/objective-9/work-item-8/attempt-1/artifact-${digest("5")}`;
      },
    ],
    [
      "source repository",
      (p: RecoveryPlan) => {
        p.items[0]!.source!.publication!.headRepository = "foreign/repo";
      },
    ],
    [
      "observed PR node",
      (p: RecoveryPlan) => {
        p.items[0]!.observedPullRequest!.nodeId = "PR_10";
      },
    ],
    [
      "changed head",
      (p: RecoveryPlan) => {
        p.items[0]!.observedPullRequest!.headSha = sha("9");
      },
    ],
    [
      "changed base",
      (p: RecoveryPlan) => {
        p.items[0]!.observedPullRequest!.baseSha = sha("9");
      },
    ],
    [
      "changed tree",
      (p: RecoveryPlan) => {
        p.items[0]!.observedPullRequest!.treeSha = sha("9");
      },
    ],
    [
      "deleted head repository",
      (p: RecoveryPlan) => {
        p.items[0]!.observedPullRequest!.headRepository = null;
      },
    ],
  ] as const)("rejects reusable publication with mismatched %s", (_label, change) => {
    const plan = publicationProposal();
    change(plan);
    expect(() => parseRecoveryPlan(plan)).toThrow();
  });
  it("is deterministic across object-key order and carries no execution authorization", () => {
    const plan = proposal();
    expect(parseRecoveryPlan(plan)).toEqual(plan);
    expect(
      recoveryPlanDigest(Object.fromEntries(Object.entries(plan).reverse()) as RecoveryPlan),
    ).toBe(recoveryPlanDigest(plan));
    expect(plan).not.toHaveProperty("executionAuthorized");
    expect(() => parseRecoveryPlan({ ...plan, executionAuthorized: true })).toThrow();
    expect(() =>
      parseRecoveryPlan({
        ...plan,
        acceptedPolicy: { ...plan.acceptedPolicy, hiddenAuthority: true },
      }),
    ).toThrow();
  });

  it.each([
    [
      "duplicate history",
      (plan: RecoveryPlan) => {
        plan.history.push(plan.history[0]!);
      },
    ],
    [
      "self successor",
      (plan: RecoveryPlan) => {
        plan.successorRunId = "source";
      },
    ],
    [
      "duplicate item",
      (plan: RecoveryPlan) => {
        plan.items.push(plan.items[0]!);
      },
    ],
    [
      "history digest",
      (plan: RecoveryPlan) => {
        plan.historyDigest = digest("f");
      },
    ],
    [
      "source cutoff",
      (plan: RecoveryPlan) => {
        plan.sourceEventMaxSequence = 9;
      },
    ],
    [
      "predecessor",
      (plan: RecoveryPlan) => {
        plan.predecessor.terminalSequence = 9;
      },
    ],
    [
      "graph source",
      (plan: RecoveryPlan) => {
        plan.graph.sourceRunId = "foreign";
      },
    ],
    [
      "graph scope",
      (plan: RecoveryPlan) => {
        plan.graph.ref = compiledGraphRef(9, "source");
      },
    ],
    [
      "projection scope",
      (plan: RecoveryPlan) => {
        plan.graph.projection.ref = compiledGraphProjectionRef(9, "source");
      },
    ],
    [
      "binding digest",
      (plan: RecoveryPlan) => {
        plan.graph.projection.bindingDigest = digest("f");
      },
    ],
    [
      "allowance math",
      (plan: RecoveryPlan) => {
        plan.allowance.increment.sandboxMinutes = 1;
      },
    ],
    [
      "policy allowance",
      (plan: RecoveryPlan) => {
        plan.allowance.before.sandboxMinutes = 1;
        plan.allowance.after.sandboxMinutes = 1;
      },
    ],
    [
      "unknown bounded grant",
      (plan: RecoveryPlan) => {
        plan.allowance.increment.modelTokens = 1;
      },
    ],
    [
      "unsafe number",
      (plan: RecoveryPlan) => {
        plan.allowance.before.managedSessions = Number.MAX_SAFE_INTEGER + 1;
      },
    ],
    [
      "reuse without source",
      (plan: RecoveryPlan) => {
        plan.items[0]!.action = "reuse-artifact";
      },
    ],
    [
      "cleanup without evidence",
      (plan: RecoveryPlan) => {
        plan.items[0]!.resources.state = "verified-clean";
      },
    ],
  ] as const)("rejects %s", (_label, change) => {
    const plan = proposal();
    change(plan);
    expect(() => parseRecoveryPlan(plan)).toThrow();
  });

  it("requires bounded allowance increments to exactly match accepted ceilings", () => {
    const plan = proposal();
    plan.acceptedPolicy.economics = {
      maxModelTokens: 150,
      maxSandboxMinutes: 0,
      maxManagedSessions: 0,
      minCloudTimeSavedMinutes: 0,
    };
    plan.policyDigest = policyDigest(plan.acceptedPolicy);
    plan.allowance.before.modelTokens = 100;
    plan.allowance.increment.modelTokens = 50;
    plan.allowance.after.modelTokens = 150;
    expect(parseRecoveryPlan(plan).allowance.after.modelTokens).toBe(150);
    plan.allowance.after.modelTokens = null;
    expect(() => parseRecoveryPlan(plan)).toThrow();
  });

  it("bounds documents and rejects private prose/secret extensions", () => {
    expect(() =>
      parseRecoveryPlan({ ...proposal(), notes: "x".repeat(MAX_RECOVERY_PLAN_BYTES) }),
    ).toThrow("exceeds 256 KiB");
    const plan = proposal();
    plan.requestId = `ghp_${"a".repeat(30)}`;
    expect(() => parseRecoveryPlan(plan)).toThrow(/secret|token/i);
  });

  it("fences every write, loads through a frozen read-only port, and replays without new writes", async () => {
    const store = new Store();
    const plan = proposal();
    const manager = new RecoveryPlanManager(store, store);
    const saved = await manager.persist({ lease: lease(plan), plan });
    expect(saved.ref).toBe(recoveryPlanRef(7, recoveryPlanDigest(plan)));
    expect(store.commits.get(saved.commitOid)!.parentOids).toEqual([base]);
    expect(await loadRecoveryPlan(store.readPort(), 7, saved.digest)).toEqual(saved);
    const writes = store.operations.filter((value) => value !== "fence");
    expect(await manager.persist({ lease: lease(plan), plan })).toEqual(saved);
    expect(store.operations.filter((value) => value !== "fence")).toEqual(writes);
    await expect(loadRecoveryPlan(store.readPort(), 7, digest("f"))).resolves.toBeNull();
  });

  it.each(["blob", "tree", "commit", "ref"])(
    "recovers lost %s response without duplicate proposal refs",
    async (point) => {
      const store = new Store();
      const plan = proposal();
      store.loseAfter = point;
      const args = { lease: lease(plan), plan };
      const first = new RecoveryPlanManager(store, store).persist(args);
      if (point === "ref") await expect(first).resolves.toMatchObject({ plan });
      else await expect(first).rejects.toThrow(`lost ${point} response`);
      const saved = await new RecoveryPlanManager(store, store).persist(args);
      expect(saved.plan).toEqual(plan);
      expect(store.refs.size).toBe(1);
    },
  );

  it("refuses foreign or lost lease before any proposal write", async () => {
    const store = new Store();
    const plan = proposal();
    const manager = new RecoveryPlanManager(store, store);
    await expect(
      manager.persist({ lease: { ...lease(plan), runId: "source" }, plan }),
    ).rejects.toThrow("lease scope");
    store.validLease = false;
    await expect(manager.persist({ lease: lease(plan), plan })).rejects.toThrow("lease lost");
    expect(store.operations.filter((value) => value !== "fence")).toEqual([]);
  });

  it.each(["blob", "tree", "commit"])(
    "stops after lease loss following %s write",
    async (point) => {
      const store = new Store();
      const plan = proposal();
      store.loseLeaseAfter = point;
      await expect(
        new RecoveryPlanManager(store, store).persist({ lease: lease(plan), plan }),
      ).rejects.toThrow("lease lost");
      expect(store.operations.filter((value) => value !== "fence").at(-1)).toBe(point);
      expect(store.refs.size).toBe(0);
    },
  );

  it("rejects noncanonical stored bytes without rewriting the immutable ref", async () => {
    const store = new Store();
    const plan = proposal();
    const saved = await new RecoveryPlanManager(store, store).persist({ lease: lease(plan), plan });
    const before = store.operations.filter((value) => value !== "fence");
    store.blobs.set(saved.blobOid, Buffer.from(JSON.stringify(plan, null, 2)));
    await expect(loadRecoveryPlan(store.readPort(), 7, saved.digest)).rejects.toThrow(
      "canonically encoded",
    );
    await expect(
      new RecoveryPlanManager(store, store).persist({ lease: lease(plan), plan }),
    ).rejects.toThrow("canonically encoded");
    expect(store.operations.filter((value) => value !== "fence")).toEqual(before);
  });

  it("refuses a retargeted plan ref whose commit has another parent", async () => {
    const store = new Store();
    const plan = proposal();
    const saved = await new RecoveryPlanManager(store, store).persist({ lease: lease(plan), plan });
    store.commits.get(saved.commitOid)!.parentOids = [sha("f")];
    await expect(loadRecoveryPlan(store.readPort(), 7, saved.digest)).rejects.toThrow(
      "parent does not bind",
    );
  });
});
