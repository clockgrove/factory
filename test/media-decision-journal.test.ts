import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { withMediaDigest } from "../src/media/contracts.js";
import {
  createMediaDecisionRequest,
  mediaRevisionRetryRequestId,
  persistMediaDecisionRequest,
  readMediaDecisionRequest,
  type MediaStore,
} from "../src/media/storage.js";
import { deriveDurableCommandState } from "../src/control/commands.js";
import type { GitCommitObject } from "../src/control/lease.js";
import { parseFactoryEvent } from "../src/protocol/events.js";

const gitOid = (bytes: Buffer) =>
  createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");

function memoryStore() {
  const blobs = new Map<string, Buffer>();
  const trees = new Map<string, Map<string, string>>();
  const commits = new Map<string, GitCommitObject>();
  const refs = new Map<string, string>();
  const store: MediaStore = {
    readRef: async (ref) => refs.get(ref) ?? null,
    readCommit: async (oid) => {
      const commit = commits.get(oid);
      if (!commit) throw new Error(`missing commit ${oid}`);
      return commit;
    },
    readTreeEntry: async (tree, path) => trees.get(tree)?.get(path) ?? null,
    readBlob: async (oid) => {
      const bytes = blobs.get(oid);
      if (!bytes) throw new Error(`missing blob ${oid}`);
      return Buffer.from(bytes);
    },
    createBlob: async (bytes) => {
      const oid = gitOid(bytes);
      blobs.set(oid, Buffer.from(bytes));
      return oid;
    },
    createTree: async ({ entries }) => {
      const oid = createHash("sha1").update(JSON.stringify(entries)).digest("hex");
      trees.set(oid, new Map(entries.map((entry) => [entry.path, entry.sha])));
      return oid;
    },
    createCommit: async ({ treeOid, parentOids, message }) => {
      const oid = createHash("sha1")
        .update(JSON.stringify({ treeOid, parentOids, message }))
        .digest("hex");
      commits.set(oid, { oid, treeOid, parentOids, message, serverTime: new Date(0) });
      return oid;
    },
    createRef: async (ref, oid) => {
      if (refs.has(ref)) return false;
      refs.set(ref, oid);
      return true;
    },
  };
  return store;
}

const authority = {
  repository: "fixture/project",
  objective: 7,
  baseSha: "b".repeat(40),
};

function decision(args: {
  requestId: string;
  assetSetDigest?: string;
  kind?: "approved" | "revision-requested";
  reason?: string;
}) {
  const kind = args.kind ?? "approved";
  const reasonDigest = args.reason ? createHash("sha256").update(args.reason).digest("hex") : null;
  return withMediaDigest({
    protocol: "clockgrove.factory/asset-decision-v1" as const,
    kind,
    requestId: args.requestId,
    requestedBy: "reviewer",
    runId: "run-media",
    intentId: "world-layout",
    intentDigest: "1".repeat(64),
    producerWorkItem: 17,
    producerAttempt: 1,
    producerReservationOid: "a".repeat(40),
    assetSetDigest: args.assetSetDigest ?? "2".repeat(64),
    invocationDigest: "3".repeat(64),
    storageManifestDigest: "4".repeat(64),
    selectedDescriptorDigests: kind === "approved" ? ["5".repeat(64)] : [],
    ruleId: null,
    ruleDigest: null,
    reasonDigest: null,
    feedbackDigest: kind === "revision-requested" ? reasonDigest : null,
  });
}

describe("media decision request journal", () => {
  it("makes concurrent exact requests one immutable replay across restarts", async () => {
    const store = memoryStore();
    const exactDecision = decision({ requestId: "review-1" });
    const request = createMediaDecisionRequest({ authority, decision: exactDecision });
    const publish = () =>
      persistMediaDecisionRequest({
        store,
        request,
        parentOids: ["c".repeat(40)],
        assertCurrent: async () => {},
      });
    const [left, right] = await Promise.all([publish(), publish()]);
    expect(right).toEqual(left);
    expect(
      await readMediaDecisionRequest({
        store,
        repository: authority.repository,
        objective: authority.objective,
        requestId: exactDecision.requestId,
      }),
    ).toEqual(left);
  });

  it("consumes a request ID when concurrent payloads bind different Asset Sets", async () => {
    const store = memoryStore();
    const first = createMediaDecisionRequest({
      authority,
      decision: decision({ requestId: "review-race", assetSetDigest: "6".repeat(64) }),
    });
    const changed = createMediaDecisionRequest({
      authority,
      decision: decision({ requestId: "review-race", assetSetDigest: "7".repeat(64) }),
    });
    const results = await Promise.allSettled(
      [first, changed].map((request) =>
        persistMediaDecisionRequest({
          store,
          request,
          parentOids: ["c".repeat(40)],
          assertCurrent: async () => {},
        }),
      ),
    );
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
    const stored = await readMediaDecisionRequest({
      store,
      repository: authority.repository,
      objective: authority.objective,
      requestId: "review-race",
    });
    expect([first.digest, changed.digest]).toContain(stored?.request.digest);
  });

  it("binds the canonical revision retry to the authenticated decision and feedback", () => {
    const feedback = "Increase contrast while retaining the approved spatial layout.";
    const revision = decision({
      requestId: "review-revise",
      kind: "revision-requested",
      reason: feedback,
    });
    const request = createMediaDecisionRequest({ authority, decision: revision, reason: feedback });
    const decisionEvent = parseFactoryEvent({
      protocol: "clockgrove.factory/v2",
      kind: "media",
      event: "AssetDecisionRecorded",
      objective: 7,
      runId: revision.runId,
      sequence: 2,
      at: "2026-01-01T00:01:00.000Z",
      workItem: revision.producerWorkItem,
      attempt: revision.producerAttempt,
      reservationOid: revision.producerReservationOid,
      invocationDigest: revision.invocationDigest,
      assetSetDigest: revision.assetSetDigest,
      decisionDigest: revision.digest,
      decisionKind: revision.kind,
      requestId: revision.requestId,
      requestedBy: revision.requestedBy,
      reason: feedback,
    });
    const retry = request.retry!;
    expect(retry.requestId).toBe(mediaRevisionRetryRequestId(authority, revision));
    expect(
      deriveDurableCommandState({
        events: [decisionEvent],
        objective: 7,
        runId: revision.runId,
        runActor: revision.requestedBy,
        runStartSequence: 1,
      }).retries.get(17),
    ).toEqual({
      workItem: 17,
      sequence: decisionEvent.sequence,
      requestedBy: revision.requestedBy,
      requestId: revision.requestId,
    });
    const retryEvent = parseFactoryEvent({
      protocol: "clockgrove.factory/v2",
      kind: "run",
      event: "WorkItemRetryRequested",
      objective: 7,
      runId: revision.runId,
      sequence: 4,
      at: "2026-01-01T00:03:00.000Z",
      requestedBy: revision.requestedBy,
      requestId: retry.requestId,
      workItem: retry.workItem,
      reason: feedback,
      mediaRevision: {
        decisionRequestId: revision.requestId,
        assetSetDigest: revision.assetSetDigest,
        decisionDigest: revision.digest,
        feedbackDigest: retry.feedbackDigest,
      },
    });
    expect(
      deriveDurableCommandState({
        events: [decisionEvent, retryEvent],
        objective: 7,
        runId: revision.runId,
        runActor: revision.requestedBy,
        runStartSequence: 1,
      }).retries.get(17),
    ).toEqual({
      workItem: 17,
      sequence: decisionEvent.sequence,
      requestedBy: revision.requestedBy,
      requestId: retry.requestId,
    });
    const reservation = parseFactoryEvent({
      protocol: "clockgrove.factory/v2",
      kind: "attempt",
      event: "AttemptReserved",
      objective: 7,
      runId: revision.runId,
      sequence: 3,
      at: "2026-01-01T00:02:00.000Z",
      workItem: revision.producerWorkItem,
      attempt: revision.producerAttempt + 1,
      backend: "codex",
      baseSha: authority.baseSha,
      directorEpoch: 1,
      policyDigest: "6".repeat(64),
    });
    expect(
      deriveDurableCommandState({
        events: [decisionEvent, reservation, retryEvent],
        objective: 7,
        runId: revision.runId,
        runActor: revision.requestedBy,
        runStartSequence: 1,
      }).retries.has(17),
    ).toBe(false);
    const changed = parseFactoryEvent({ ...retryEvent, reason: `${feedback} changed` });
    expect(() =>
      deriveDurableCommandState({
        events: [decisionEvent, changed],
        objective: 7,
        runId: revision.runId,
        runActor: revision.requestedBy,
        runStartSequence: 1,
      }),
    ).toThrow(/differs from its authenticated review decision/);
  });
});
