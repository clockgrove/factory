import { describe, expect, it, vi } from "vitest";
import { writerAuthority } from "../src/control/authority.js";
import { gitBlobOid, type CompiledGraphStore } from "../src/control/graphs.js";
import type { GitCommitObject, LeaseManager, LeaseState } from "../src/control/lease.js";
import { decodeEventComments } from "../src/control/receipts.js";
import {
  decodeResultReceiptComments,
  assertResultInvocationRecorded,
  RESULT_RECORD_PROTOCOL,
  resultEventsDigest,
  readResultSelection,
  validateResultReceiptComment,
  type ResultReceiptStore,
  type ResultReceiptReadStore,
  type ResultTransition,
} from "../src/control/result-receipts.js";
import { ReviewCheckpointManager, reviewIdentityDigest } from "../src/control/reviews.js";
import { ValidationCheckpointManager } from "../src/control/validation-checkpoints.js";
import { parseFactoryEvent, type FactoryEvent } from "../src/protocol/events.js";
import type { RecoveryReadStore } from "../src/recovery/assessment.js";
import { boundedReadStore } from "../src/recovery/runtime.js";
import { createValidationEvidence } from "../src/validation/evidence.js";

const lease = {
  objective: 1,
  runId: "result-run",
  holder: "director",
  epoch: 1,
  policyDigest: "a".repeat(64),
} as LeaseState;
const baseSha = "b".repeat(40);
const identity = {
  kind: "artifact" as const,
  runId: lease.runId,
  objective: 1,
  workItem: 2,
  attempt: 1,
  artifactDigest: "c".repeat(64),
  baseSha,
  outputTreeSha: "d".repeat(40),
  evidenceDigest: "e".repeat(64),
};
const usageId = `review-${reviewIdentityDigest(identity)}`;
const at = "2026-09-13T00:00:00.000Z";
const result = {
  review: { accepted: true, summary: "Verified", unmetCriteria: [], risks: [] },
  usage: { inputTokens: 10, outputTokens: 2 },
};
function event(sequence: number, fields: object): FactoryEvent {
  return parseFactoryEvent({
    protocol: "clockgrove.factory/v2",
    objective: 1,
    runId: lease.runId,
    sequence,
    at,
    ...writerAuthority(lease, sequence),
    ...fields,
  });
}
function reviewTransition(): ResultTransition {
  return {
    issueNodeId: "issue-2",
    sequence: 10,
    at,
    invocation: event(9, {
      kind: "budget",
      event: "BudgetReserved",
      phase: "management",
      unit: "model_tokens",
      amount: 0,
      workItem: 2,
      attempt: 1,
      modelInvocationId: usageId,
      usageId: `invocation-${usageId}`,
      directorEpoch: 1,
      policyDigest: lease.policyDigest,
    }),
    events: [
      event(11, {
        kind: "budget",
        event: "BudgetReconciled",
        phase: "management",
        unit: "model_tokens",
        amount: 12,
        reportedModelUsage: result.usage,
        workItem: 2,
        attempt: 1,
        usageId,
        modelInvocationId: usageId,
        directorEpoch: 1,
        policyDigest: lease.policyDigest,
      }),
      event(12, {
        kind: "attempt",
        event: "AttemptValidated",
        backend: "local",
        baseSha,
        directorEpoch: 1,
        policyDigest: lease.policyDigest,
        workItem: 2,
        attempt: 1,
        artifactDigest: identity.artifactDigest,
      }),
    ],
  };
}
function fixture() {
  const comments: string[] = [];
  const refs = new Map<string, string>();
  const commits = new Map<string, GitCommitObject>();
  const trees = new Map<string, Map<string, string>>();
  const blobs = new Map<string, Buffer>();
  const writes: string[] = [];
  let n = 1;
  let lostAck = false;
  let failBeforeComment = false;
  let protocol: typeof RESULT_RECORD_PROTOCOL | null = RESULT_RECORD_PROTOCOL;
  const oid = () => (n++).toString(16).padStart(40, "0");
  const store: CompiledGraphStore & ResultReceiptStore = {
    readResultReceipts: async (scope) => ({
      protocol,
      receipts: comments.flatMap((body, index) =>
        decodeResultReceiptComments(body)
          .filter(
            (receipt) =>
              receipt.kind === scope.kind && receipt.identityDigest === scope.identityDigest,
          )
          .map((receipt) => ({
            receipt,
            commentId: String(index + 1),
            events: decodeEventComments(body),
          })),
      ),
    }),
    publishResultReceipt: vi.fn(async ({ body }) => {
      writes.push("comment");
      if (failBeforeComment) throw new Error("before comment");
      comments.push(body);
      if (lostAck) throw new Error("lost acknowledgment");
      return { commentId: String(comments.length) };
    }),
    readRef: async (ref) => refs.get(ref) ?? null,
    readCommit: async (oid) => commits.get(oid)!,
    readBlob: async (oid) => blobs.get(oid)!,
    readTreeEntry: async (oid, path) => trees.get(oid)?.get(path) ?? null,
    createBlob: async () => {
      throw new Error("no separate blob writes");
    },
    createTree: async ({ entries }) => {
      writes.push("tree");
      const tree = new Map<string, string>();
      for (const entry of entries) {
        const bytes = Buffer.from(entry.content!);
        const blob = gitBlobOid(bytes);
        blobs.set(blob, bytes);
        tree.set(entry.path, blob);
      }
      const id = oid();
      trees.set(id, tree);
      return id;
    },
    createCommit: async (args) => {
      writes.push("commit");
      const id = oid();
      commits.set(id, { oid: id, ...args, serverTime: new Date(at) });
      return id;
    },
    createRef: async (ref, id) => {
      writes.push("ref");
      if (refs.has(ref)) return false;
      refs.set(ref, id);
      return true;
    },
  };
  const authorize = vi.fn(async () => {});
  const leases = { assertMutationAuthorized: authorize } as unknown as LeaseManager;
  return {
    store,
    blobs,
    leases,
    comments,
    writes,
    authorize,
    loseAck: () => {
      lostAck = true;
    },
    failComment: () => {
      failBeforeComment = true;
    },
    legacy: () => {
      protocol = null;
    },
  };
}

describe("authenticated consolidated result receipts", () => {
  it("writes one review result/usage/outcome comment and cold loads without Git checkpoint reads", async () => {
    const f = fixture();
    const record = await new ReviewCheckpointManager(f.store, f.leases).persist({
      lease,
      identity,
      result,
      transition: reviewTransition(),
    });
    expect(f.writes).toEqual(["comment"]);
    expect(record).not.toHaveProperty("commitOid");
    expect(record.locator?.commentId).toBe("1");
    expect(await new ReviewCheckpointManager(f.store, f.leases).load(identity)).toEqual(record);
    expect(decodeEventComments(f.comments[0]!)).toHaveLength(2);
  });
  it("reconciles a lost acknowledgment without replaying its mutation", async () => {
    const f = fixture();
    f.loseAck();
    const record = await new ReviewCheckpointManager(f.store, f.leases).persist({
      lease,
      identity,
      result,
      transition: reviewTransition(),
    });
    expect(record.locator?.commentId).toBe("1");
    expect(f.writes).toEqual(["comment"]);
  });
  it("preserves missing terminal result after crash before comment, with no fabricated result or retry", async () => {
    const f = fixture();
    f.failComment();
    await expect(
      new ReviewCheckpointManager(f.store, f.leases).persist({
        lease,
        identity,
        result,
        transition: reviewTransition(),
      }),
    ).rejects.toThrow("before comment");
    expect(await new ReviewCheckpointManager(f.store, f.leases).load(identity)).toBeNull();
    expect(f.writes).toEqual(["comment"]);
  });
  it("rejects modified adjacent usage and modified checkpoint projection", async () => {
    const f = fixture();
    await new ReviewCheckpointManager(f.store, f.leases).persist({
      lease,
      identity,
      result,
      transition: reviewTransition(),
    });
    expect(() =>
      decodeResultReceiptComments(f.comments[0]!.replace('"amount":12', '"amount":13')),
    ).toThrow("amount must equal");
    expect(() =>
      decodeResultReceiptComments(
        f.comments[0]!.replace('"usage":{"inputTokens":10', '"usage":{"inputTokens":11'),
      ),
    ).toThrow("usage differs");
  });
  it("rejects a recomputed event digest whose accepted outcome differs from the checkpoint", async () => {
    const f = fixture();
    await new ReviewCheckpointManager(f.store, f.leases).persist({
      lease,
      identity,
      result,
      transition: reviewTransition(),
    });
    const prior = f.comments[0]!;
    const events = decodeEventComments(prior).map((e) =>
      e.kind === "attempt" ? { ...e, artifactDigest: "f".repeat(64) } : e,
    );
    const modified = prior
      .replace(identity.artifactDigest, "f".repeat(64))
      .replace(resultEventsDigest(decodeEventComments(prior)), resultEventsDigest(events));
    expect(() => decodeResultReceiptComments(modified)).toThrow("acceptance projection differs");
  });
  it("refuses stale writer publication before any mutation", async () => {
    const f = fixture();
    f.authorize.mockRejectedValue(new Error("lease taken over"));
    await expect(
      new ReviewCheckpointManager(f.store, f.leases).persist({
        lease,
        identity,
        result,
        transition: reviewTransition(),
      }),
    ).rejects.toThrow("taken over");
    expect(f.writes).toEqual([]);
  });
  it("does not silently fall back to Git writes for a selected transition run", async () => {
    const f = fixture();
    await expect(
      new ReviewCheckpointManager(f.store, f.leases).persist({ lease, identity, result }),
    ).rejects.toThrow("explicit result transition");
    expect(f.writes).toEqual([]);
    f.legacy();
    await expect(
      new ReviewCheckpointManager(f.store, f.leases).persist({
        lease,
        identity,
        result,
        transition: reviewTransition(),
      }),
    ).rejects.toThrow("did not select");
  });
  it("retains larger supported reviews as authenticated external content in the same protocol", async () => {
    const f = fixture();
    const large = {
      ...result,
      review: {
        ...result.review,
        summary: "x".repeat(7500),
        risks: Array(28).fill("r".repeat(1900)),
      },
    };
    const record = await new ReviewCheckpointManager(f.store, f.leases).persist({
      lease,
      identity,
      result: large,
      transition: reviewTransition(),
    });
    expect(record.resultReceipt?.content.kind).toBe("git");
    expect(f.writes).toEqual(["tree", "commit", "ref", "comment"]);
    expect(await new ReviewCheckpointManager(f.store, f.leases).load(identity)).toEqual(record);
  });
  it("deduplicates exact acknowledged duplicates and rejects conflicting same-identity results", async () => {
    const f = fixture();
    const manager = new ReviewCheckpointManager(f.store, f.leases);
    const record = await manager.persist({
      lease,
      identity,
      result,
      transition: reviewTransition(),
    });
    f.comments.push(f.comments[0]!);
    expect(await manager.load(identity)).toEqual(record);
    f.comments.push(f.comments[0]!.replace('"summary":"Verified"', '"summary":"Changed"'));
    await expect(manager.load(identity)).rejects.toThrow("conflicting authenticated");
  });
  it("does not claim an externally prepared result before its authenticated comment", async () => {
    const f = fixture();
    f.failComment();
    const large = {
      ...result,
      review: {
        ...result.review,
        summary: "x".repeat(7500),
        risks: Array(28).fill("r".repeat(1900)),
      },
    };
    await expect(
      new ReviewCheckpointManager(f.store, f.leases).persist({
        lease,
        identity,
        result: large,
        transition: reviewTransition(),
      }),
    ).rejects.toThrow("before comment");
    expect(f.writes).toEqual(["tree", "commit", "ref", "comment"]);
    expect(await new ReviewCheckpointManager(f.store, f.leases).load(identity)).toBeNull();
  });
  it("validates externally stored bytes before exposing adjacent accounting or outcome", async () => {
    const f = fixture();
    const large = {
      ...result,
      review: {
        ...result.review,
        summary: "x".repeat(7500),
        risks: Array(28).fill("r".repeat(1900)),
      },
    };
    await new ReviewCheckpointManager(f.store, f.leases).persist({
      lease,
      identity,
      result: large,
      transition: reviewTransition(),
    });
    await expect(validateResultReceiptComment(f.store, f.comments[0]!)).resolves.toBeUndefined();
    const [blob] = f.blobs.keys();
    f.blobs.set(blob!, Buffer.from("altered"));
    await expect(validateResultReceiptComment(f.store, f.comments[0]!)).rejects.toThrow(
      "digest or size differs",
    );
  });
  it.each([
    ["execution phase", { phase: "execution" }],
    ["different attempt", { attempt: 2 }],
    ["missing attempt", { attempt: undefined }],
    ["different usage split", { reportedModelUsage: { inputTokens: 9, outputTokens: 3 } }],
    [
      "invented cached usage",
      { reportedModelUsage: { inputTokens: 10, outputTokens: 2, cachedInputTokens: 1 } },
    ],
    ["missing reported usage", { reportedModelUsage: undefined }],
  ])(
    "rejects edited %s even when the adjacent event digest is recomputed",
    async (_label, edit) => {
      const f = fixture();
      await new ReviewCheckpointManager(f.store, f.leases).persist({
        lease,
        identity,
        result,
        transition: reviewTransition(),
      });
      const body = f.comments[0]!;
      const events = decodeEventComments(body);
      const edited = events.map((value) =>
        value.kind === "budget"
          ? parseFactoryEvent(JSON.parse(JSON.stringify({ ...value, ...edit })))
          : value,
      );
      const changed = body
        .replace(JSON.stringify(events[0]), JSON.stringify(edited[0]))
        .replace(resultEventsDigest(events), resultEventsDigest(edited));
      expect(() => decodeResultReceiptComments(changed)).toThrow("review usage differs");
    },
  );
  it("preserves source-candidate absent attempt only when its exact original marker has no attempt", async () => {
    const f = fixture();
    const candidate = {
      ...identity,
      kind: "integration-candidate" as const,
      headSha: "f".repeat(40),
    };
    const invocationId = `integration-review-${reviewIdentityDigest(candidate)}`;
    const invocation = event(9, {
      kind: "budget",
      event: "BudgetReserved",
      phase: "management",
      unit: "model_tokens",
      amount: 0,
      workItem: 2,
      modelInvocationId: invocationId,
      usageId: `invocation-${invocationId}`,
      directorEpoch: 1,
      policyDigest: lease.policyDigest,
    });
    const closure = event(11, {
      kind: "budget",
      event: "BudgetReconciled",
      phase: "management",
      unit: "model_tokens",
      amount: 12,
      reportedModelUsage: result.usage,
      workItem: 2,
      modelInvocationId: invocationId,
      usageId: invocationId,
      directorEpoch: 1,
      policyDigest: lease.policyDigest,
    });
    const record = await new ReviewCheckpointManager(f.store, f.leases).persist({
      lease,
      identity: candidate,
      result,
      transition: { issueNodeId: "issue-2", sequence: 10, at, invocation, events: [closure] },
    });
    expect(record.resultEvents?.[0]).not.toHaveProperty("attempt");
    expect(() =>
      assertResultInvocationRecorded(record.resultReceipt!, [closure], [invocation]),
    ).not.toThrow();
    expect(() =>
      assertResultInvocationRecorded(
        record.resultReceipt!,
        [closure],
        [parseFactoryEvent({ ...invocation, attempt: 1 })],
      ),
    ).toThrow("exact durable dispatch");
    expect(() =>
      assertResultInvocationRecorded(
        record.resultReceipt!,
        [closure],
        [parseFactoryEvent({ ...invocation, directorEpoch: 2 })],
      ),
    ).toThrow("exact durable dispatch");
    expect(() =>
      assertResultInvocationRecorded(
        record.resultReceipt!,
        [closure],
        [invocation, parseFactoryEvent({ ...invocation, directorEpoch: 2 })],
      ),
    ).toThrow("exact durable dispatch");
    expect(() => assertResultInvocationRecorded(record.resultReceipt!, [closure], [])).toThrow(
      "exact durable dispatch",
    );
  });
  it("writes exact validation evidence and projection once", async () => {
    const f = fixture();
    const evidence = createValidationEvidence({
      protocol: "clockgrove.factory/validation-v1",
      artifactDigest: identity.artifactDigest,
      baseSha,
      outputTreeSha: identity.outputTreeSha,
      commands: [],
      passed: true,
      startedAt: at,
      completedAt: at,
      environmentIdentity: "independent",
    });
    const validationIdentity = {
      runId: lease.runId,
      objective: 1,
      workItem: 2,
      attempt: 1,
      artifactDigest: identity.artifactDigest,
      baseSha,
      directorEpoch: 1,
      policyDigest: lease.policyDigest,
    };
    const transition = {
      issueNodeId: "issue-2",
      sequence: 10,
      at,
      events: [
        event(11, {
          kind: "validation",
          event: "ValidationRecorded",
          workItem: 2,
          attempt: 1,
          baseSha,
          outputTreeSha: evidence.outputTreeSha,
          passed: true,
          evidenceDigest: evidence.digest,
        }),
      ],
    };
    const record = await new ValidationCheckpointManager(f.store, f.leases).persist({
      lease,
      identity: validationIdentity,
      evidence,
      transition,
    });
    expect(f.writes).toEqual(["comment"]);
    expect(
      await new ValidationCheckpointManager(f.store, f.leases).load(validationIdentity),
    ).toEqual(record);
    expect(() =>
      decodeResultReceiptComments(f.comments[0]!.replace('"passed":true', '"passed":false')),
    ).toThrow();
  });
});

describe("result selection through bounded recovery reads", () => {
  it.each([false, true])(
    "falls back only when positive observation is absent (observed=%s)",
    async (observed) => {
      const f = fixture();
      await new ReviewCheckpointManager(f.store, f.leases).persist({
        lease,
        identity,
        result,
        transition: reviewTransition(),
      });
      const scope = {
        objective: 1,
        runId: lease.runId,
        workItem: 2,
        kind: "review" as const,
        identityDigest: reviewIdentityDigest(identity),
      };
      const selected = await f.store.readResultReceipts(scope);
      expect(selected.receipts).toHaveLength(1);
      const positive = { ...selected, protocol: RESULT_RECORD_PROTOCOL };
      f.store.observedResultReceipts = vi.fn(() => (observed ? positive : undefined));
      const durableRead = vi.spyOn(f.store, "readResultReceipts");
      const bounded = boundedReadStore(f.store as unknown as RecoveryReadStore);
      expect(await readResultSelection(bounded as ResultReceiptReadStore, scope)).toEqual(selected);
      expect(f.store.observedResultReceipts).toHaveBeenCalledOnce();
      expect(durableRead).toHaveBeenCalledTimes(observed ? 0 : 1);
    },
  );
});
