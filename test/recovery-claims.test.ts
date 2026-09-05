import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  compiledGraphProjectionRef,
  compiledGraphRef,
  type CompiledGraphReadStore,
  type CompiledGraphStore,
} from "../src/control/graphs.js";
import type { GitCommitObject, LeaseState } from "../src/control/lease.js";
import { DEFAULT_RUN_POLICY, policyDigest } from "../src/protocol/policy.js";
import {
  assertRecoveryClaimBinding,
  loadRecoveryClaim,
  MAX_RECOVERY_CLAIM_BYTES,
  RecoveryClaimManager,
  type AuthenticatedRecoveryRequest,
} from "../src/recovery/claims.js";
import { recoveryClaimRef, recoveryEventDigest } from "../src/recovery/identity.js";
import {
  RECOVERY_PLAN_PROTOCOL,
  RecoveryPlanManager,
  recoveryHistoryDigest,
  recoveryPlanBindingDigest,
  type RecoveryPlan,
} from "../src/recovery/plan.js";

const sha = (value: string) => value.repeat(40);
const digest = (value: string) => value.repeat(64);
const base = sha("a");
const now = new Date("2026-09-04T00:00:00Z");
function proposal(): RecoveryPlan {
  const policy = structuredClone(DEFAULT_RUN_POLICY);
  const predecessor = {
    runId: "source",
    startDigest: digest("1"),
    terminalDigest: digest("2"),
    terminalEvent: "FactoryRunEscalated" as const,
    terminalSequence: 10,
  };
  const history = [{ ...predecessor, policyDigest: policyDigest(policy) }];
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
    predecessor,
    history,
    historyDigest: recoveryHistoryDigest(history),
    sourceEventsDigest: digest("3"),
    sourceEventMaxSequence: 10,
    priorPlanDigest: null,
    expectedBaseSha: base,
    baseBranch: "main",
    graph: {
      sourceRunId: "source",
      ref: compiledGraphRef(7, "source"),
      commitOid: sha("1"),
      blobOid: sha("2"),
      digest: digest("4"),
      projection: {
        ref: compiledGraphProjectionRef(7, "source"),
        commitOid: sha("3"),
        blobOid: sha("4"),
        bindingDigest: recoveryPlanBindingDigest(items),
      },
    },
    acceptedPolicy: policy,
    policyDigest: policyDigest(policy),
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
function lease(plan: RecoveryPlan): LeaseState {
  return {
    objective: plan.objective,
    runId: plan.successorRunId,
    holder: "operator",
    policyDigest: plan.policyDigest,
    ref: "refs/clockgrove-factory/leases/objective-7",
    oid: sha("5"),
    treeOid: sha("6"),
    epoch: 1,
    sequence: 12,
    expiresAt: new Date(now.getTime() + 600_000),
  };
}

class Store implements CompiledGraphStore {
  refs = new Map<string, string>();
  commits = new Map<string, GitCommitObject>([
    [base, { oid: base, treeOid: sha("f"), parentOids: [], message: "base", serverTime: now }],
  ]);
  blobs = new Map<string, Buffer>();
  trees = new Map<string, Map<string, string>>();
  writes: string[] = [];
  fence = false;
  validLease = true;
  loseAfter: string | null = null;
  loseLeaseAfter: string | null = null;
  rejectRef = false;
  private sequence = 0;
  async assertCurrent() {
    if (!this.validLease) throw new Error("lease lost");
    this.fence = true;
  }
  private write(kind: string) {
    expect(this.fence).toBe(true);
    this.fence = false;
    this.writes.push(kind);
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
    const commit = this.commits.get(oid);
    if (!commit) throw new Error("missing commit");
    return commit;
  }
  async readBlob(oid: string) {
    const blob = this.blobs.get(oid);
    if (!blob) throw new Error("missing blob");
    return blob;
  }
  async readTreeEntry(tree: string, path: string) {
    return this.trees.get(tree)?.get(path) ?? null;
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
      new Map(args.entries.filter((entry) => entry.sha).map((entry) => [entry.path, entry.sha!])),
    );
    this.response("tree");
    return oid;
  }
  async createCommit(args: Parameters<CompiledGraphStore["createCommit"]>[0]) {
    const oid = this.write("commit");
    this.commits.set(oid, { ...args, oid, serverTime: now });
    this.response("commit");
    return oid;
  }
  async createRef(ref: string, oid: string) {
    this.write("ref");
    const created = !this.refs.has(ref) && !this.rejectRef;
    if (created) this.refs.set(ref, oid);
    this.response("ref");
    return created;
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
async function fixture(store = new Store(), plan = proposal()) {
  const currentLease = lease(plan);
  const planRecord = await new RecoveryPlanManager(store, store).persist({
    lease: currentLease,
    plan,
  });
  const authenticatedRequest: AuthenticatedRecoveryRequest = {
    protocol: "clockgrove.factory/v2",
    kind: "recovery",
    event: "RecoveryRequested",
    objective: plan.objective,
    runId: plan.predecessor.runId,
    sequence: 11,
    at: now.toISOString(),
    requestedBy: "operator",
    requestId: plan.requestId,
    repository: plan.repository,
    planDigest: planRecord.digest,
    predecessorRunId: plan.predecessor.runId,
    predecessorTerminalDigest: plan.predecessor.terminalDigest,
    successorRunId: plan.successorRunId,
    policyDigest: plan.policyDigest,
    baseSha: plan.expectedBaseSha,
  };
  store.writes = [];
  return {
    store,
    plan,
    manager: new RecoveryClaimManager(store, store),
    args: {
      lease: currentLease,
      planRecord,
      authenticatedRequest,
      transaction: {
        at: now.toISOString(),
        startSequence: 13,
        evidenceDigest: digest("7"),
        accountingDigest: digest("8"),
        resourceEvidenceDigest: digest("9"),
      },
    },
  };
}

describe("immutable successor claims", () => {
  it("rechecks a loaded claim against exact authenticated request and plan without writes", async () => {
    const { store, manager, args } = await fixture();
    const claim = await manager.claim(args);
    store.writes = [];
    expect(() => assertRecoveryClaimBinding({ claim, ...args })).not.toThrow();
    expect(() =>
      assertRecoveryClaimBinding({
        claim,
        ...args,
        authenticatedRequest: { ...args.authenticatedRequest, sequence: 12 },
      }),
    ).toThrow();
    expect(store.writes).toEqual([]);
  });

  it.each([
    "ref",
    "oid",
    "blobOid",
    "requestDigest",
    "planCommitOid",
    "executionAuthorized",
  ] as const)("binding helper rejects corrupted observed %s", async (field) => {
    const { manager, args } = await fixture();
    const claim = await manager.claim(args);
    const changed =
      field === "ref"
        ? recoveryClaimRef(8, "source")
        : field === "requestDigest"
          ? digest("f")
          : field === "planCommitOid"
            ? sha("f")
            : field === "executionAuthorized"
              ? true
              : "invalid";
    expect(() =>
      assertRecoveryClaimBinding({ ...args, claim: { ...claim, [field]: changed } }),
    ).toThrow();
  });

  it("binds the exact acknowledged plan and request without conferring execution authority", async () => {
    const { store, manager, args } = await fixture();
    const record = await manager.claim(args);
    expect(record).toMatchObject({
      ref: recoveryClaimRef(7, "source"),
      repositoryId: "R_fixture",
      objectiveNodeId: "I_7",
      planRef: args.planRecord.ref,
      planCommitOid: args.planRecord.commitOid,
      planBlobOid: args.planRecord.blobOid,
      requestDigest: recoveryEventDigest(args.authenticatedRequest),
      expectedBaseSha: base,
    });
    expect(record).not.toHaveProperty("executionAuthorized");
    expect(store.commits.get(record.oid)!.parentOids).toEqual([args.planRecord.commitOid]);
    expect(store.writes).toEqual(["blob", "tree", "commit", "ref"]);
    expect(await loadRecoveryClaim(store.readPort(), 7, "source")).toEqual(record);
    expect(await manager.claim(args)).toEqual(record);
    expect(store.writes).toEqual(["blob", "tree", "commit", "ref"]);
    expect(await loadRecoveryClaim(store.readPort(), 7, "other")).toBeNull();
  });

  it.each([
    "objective",
    "repository",
    "requestId",
    "predecessorRunId",
    "predecessorTerminalDigest",
    "successorRunId",
    "planDigest",
    "policyDigest",
    "baseSha",
    "sequence",
  ] as const)("rejects request with a mismatched %s before writes", async (field) => {
    const { store, manager, args } = await fixture();
    const values = {
      objective: 9,
      repository: "foreign/repository",
      requestId: "other",
      predecessorRunId: "other",
      predecessorTerminalDigest: digest("f"),
      successorRunId: "other",
      planDigest: digest("f"),
      policyDigest: digest("f"),
      baseSha: sha("f"),
      sequence: 10,
    };
    await expect(
      manager.claim({
        ...args,
        authenticatedRequest: { ...args.authenticatedRequest, [field]: values[field] },
      }),
    ).rejects.toThrow();
    expect(store.writes).toEqual([]);
  });

  it.each(["objective", "runId", "policyDigest"] as const)(
    "rejects a foreign %s lease before writes",
    async (field) => {
      const { store, manager, args } = await fixture();
      await expect(
        manager.claim({
          ...args,
          lease: { ...args.lease, [field]: field === "objective" ? 9 : "foreign" },
        }),
      ).rejects.toThrow("lease scope");
      expect(store.writes).toEqual([]);
    },
  );

  it("rejects a user-asserted plan record not matching loaded immutable storage", async () => {
    const { store, manager, args } = await fixture();
    await expect(
      manager.claim({ ...args, planRecord: { ...args.planRecord, commitOid: sha("f") } }),
    ).rejects.toThrow("immutable storage");
    expect(store.writes).toEqual([]);
  });

  it("preserves a winning predecessor claim against another request or successor", async () => {
    const first = await fixture();
    const record = await first.manager.claim(first.args);
    const secondPlan = proposal();
    secondPlan.successorRunId = "successor-two";
    secondPlan.requestId = "request-two";
    const second = await fixture(first.store, secondPlan);
    await expect(second.manager.claim(second.args)).rejects.toThrow("already claimed");
    expect(first.store.writes).toEqual([]);
    expect(first.store.refs.get(record.ref)).toBe(record.oid);
  });

  it("rejects a changed acknowledgement envelope even for the same plan and request ID", async () => {
    const { store, manager, args } = await fixture();
    await manager.claim(args);
    store.writes = [];
    await expect(
      manager.claim({
        ...args,
        authenticatedRequest: { ...args.authenticatedRequest, sequence: 12 },
      }),
    ).rejects.toThrow("already claimed");
    expect(store.writes).toEqual([]);
  });

  it.each([
    "at",
    "startSequence",
    "evidenceDigest",
    "accountingDigest",
    "resourceEvidenceDigest",
  ] as const)("replays only the exact immutable transaction %s", async (field) => {
    const { store, manager, args } = await fixture();
    const record = await manager.claim(args);
    expect(record.transaction).toEqual(args.transaction);
    store.writes = [];
    const changed =
      field === "startSequence" ? 14 : field === "at" ? "2026-09-04T00:00:01.000Z" : digest("f");
    await expect(
      manager.claim({ ...args, transaction: { ...args.transaction, [field]: changed } }),
    ).rejects.toThrow("already claimed");
    expect(store.writes).toEqual([]);
  });

  it.each([11, Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER, -1, 1.5])(
    "rejects invalid transaction sequence %s before writes",
    async (startSequence) => {
      const { store, manager, args } = await fixture();
      await expect(
        manager.claim({ ...args, transaction: { ...args.transaction, startSequence } }),
      ).rejects.toThrow();
      expect(store.writes).toEqual([]);
    },
  );

  it("resolves a competing ref-create winner without overwriting its immutable claim", async () => {
    const winner = await fixture();
    const record = await winner.manager.claim(winner.args);
    const secondPlan = proposal();
    secondPlan.successorRunId = "successor-two";
    secondPlan.requestId = "request-two";
    const second = await fixture(winner.store, secondPlan);
    // Hide the winner for the initial read, then publish it atomically at createRef.
    winner.store.refs.delete(record.ref);
    const create = winner.store.createRef.bind(winner.store);
    winner.store.createRef = async (ref, oid) => {
      if (ref === record.ref) winner.store.refs.set(ref, record.oid);
      return create(ref, oid);
    };
    await expect(second.manager.claim(second.args)).rejects.toThrow("already claimed");
    expect(winner.store.refs.get(record.ref)).toBe(record.oid);
    expect(await loadRecoveryClaim(winner.store.readPort(), 7, "source")).toEqual(record);
  });

  it.each(["blob", "tree", "commit", "ref"])(
    "reconstructs a lost %s response without duplicate claims",
    async (point) => {
      const { store, manager, args } = await fixture();
      store.loseAfter = point;
      if (point === "ref")
        await expect(manager.claim(args)).resolves.toMatchObject({ requestId: "request-one" });
      else await expect(manager.claim(args)).rejects.toThrow(`lost ${point} response`);
      const record = await new RecoveryClaimManager(store, store).claim(args);
      expect(store.refs.get(recoveryClaimRef(7, "source"))).toBe(record.oid);
      expect(
        [...store.refs.keys()].filter((ref) => ref.includes("/recovery-claims/")),
      ).toHaveLength(1);
    },
  );

  it.each(["before", "blob", "tree", "commit"])(
    "stops claim writes after lease loss at %s",
    async (point) => {
      const { store, manager, args } = await fixture();
      if (point === "before") store.validLease = false;
      else store.loseLeaseAfter = point;
      await expect(manager.claim(args)).rejects.toThrow("lease lost");
      expect(store.writes.at(-1)).toBe(point === "before" ? undefined : point);
      expect(store.refs.has(recoveryClaimRef(7, "source"))).toBe(false);
    },
  );

  it("fails closed if ref creation reports conflict but no claim can be observed", async () => {
    const { store, manager, args } = await fixture();
    store.rejectRef = true;
    await expect(manager.claim(args)).rejects.toThrow("creation was not observed");
  });

  it.each(["parent", "oversize", "encoding", "extra field", "scope", "plan blob"])(
    "rejects stored claim corruption: %s",
    async (kind) => {
      const { store, manager, args } = await fixture();
      const record = await manager.claim(args);
      const bytes = store.blobs.get(record.blobOid)!;
      const payload = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
      if (kind === "parent") store.commits.get(record.oid)!.parentOids = [base];
      else if (kind === "oversize")
        store.blobs.set(record.blobOid, Buffer.alloc(MAX_RECOVERY_CLAIM_BYTES + 1));
      else if (kind === "encoding")
        store.blobs.set(record.blobOid, Buffer.from(JSON.stringify(payload, null, 2)));
      else {
        if (kind === "extra field") payload.executionAuthorized = true;
        if (kind === "scope") payload.objective = 99;
        if (kind === "plan blob") payload.planBlobOid = sha("f");
        store.blobs.set(record.blobOid, Buffer.from(JSON.stringify(payload)));
      }
      store.writes = [];
      await expect(loadRecoveryClaim(store.readPort(), 7, "source")).rejects.toThrow();
      expect(store.writes).toEqual([]);
    },
  );
});
