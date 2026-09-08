import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { attemptRef } from "../src/control/attempts.js";
import {
  listAttemptReservationRefs,
  readAttemptReservationRef,
} from "../src/control/attempt-readers.js";
import { issueAdmissionRef } from "../src/control/issue-admission.js";
import type { GitCommitObject } from "../src/control/lease.js";
const sha = (value: string) => createHash("sha1").update(value).digest("hex");
const encoded = (marker: string, value: unknown) =>
  `${marker}: ${Buffer.from(JSON.stringify(value)).toString("base64url")}`;
function fixture() {
  const refs = new Map<string, string>();
  const commits = new Map<string, GitCommitObject>();
  const event = {
    protocol: "clockgrove.factory/v2",
    kind: "attempt",
    event: "AttemptReserved",
    objective: 7,
    workItem: 12,
    attempt: 1,
    runId: "run",
    sequence: 1,
    at: "2026-09-07T00:00:00Z",
    directorEpoch: 2,
    policyDigest: "a".repeat(64),
    baseSha: sha("base"),
    backend: "codex-sdk/local-worktree",
  };
  const observation = { ref: attemptRef(7, 12, 1), oid: sha("reservation") };
  const metadata: GitCommitObject = {
    oid: observation.oid,
    treeOid: sha("tree"),
    parentOids: [event.baseSha],
    message: encoded("Factory-Event", event),
    serverTime: new Date(event.at),
  };
  commits.set(metadata.oid, metadata);
  const entry = {
    workItem: 12,
    workItemNodeId: "I_12",
    objective: 7,
    runId: "run",
    directorEpoch: 2,
    writerEpoch: 2,
    writerHolder: "holder",
    currentWriterHolder: "holder",
    dispatchPossible: true,
    policyDigest: event.policyDigest,
    graphDigest: "b".repeat(64),
    graphCommitOid: sha("graph"),
    projectionCommitOid: sha("projection"),
    reservation: { ...observation, attempt: 1, backend: event.backend, baseSha: event.baseSha },
    capacityReservationId: "capacity",
    budgetReservationId: "budget",
    resourceIdentity: "resource",
    compatibilityClaimOid: sha("compatibility"),
    disposition: "dispatching",
  };
  const record = {
    protocol: "clockgrove.factory/issue-admission-v1",
    workItem: 12,
    workItemNodeId: "I_12",
    revision: 1,
    priorRevisionOid: null,
    history: [entry],
  };
  const ledger: GitCommitObject = {
    oid: sha("ledger"),
    treeOid: metadata.treeOid,
    parentOids: [event.baseSha, metadata.oid],
    message: encoded("Factory-Issue-Admission", record),
    serverTime: metadata.serverTime,
  };
  const store = {
    listRefs: async (prefix: string) =>
      [...refs].filter(([ref]) => ref.startsWith(prefix)).map(([ref, oid]) => ({ ref, oid })),
    readCommit: async (oid: string) => {
      const commit = commits.get(oid);
      if (!commit) throw Error("missing commit");
      return commit;
    },
  };
  const publishLedger = () => {
    ledger.message = encoded("Factory-Issue-Admission", record);
    commits.set(ledger.oid, ledger);
    refs.set(issueAdmissionRef(12), ledger.oid);
  };
  return {
    refs,
    commits,
    event,
    observation,
    metadata,
    entry,
    record,
    ledger,
    store,
    publishLedger,
  };
}
describe("logical attempt reservation readers", () => {
  it("resolves ledger-only attempts to original immutable metadata", async () => {
    const f = fixture();
    f.publishLedger();
    expect(await listAttemptReservationRefs(f.store, 7)).toEqual([f.observation]);
    expect(await readAttemptReservationRef(f.store, 7, 12, 1)).toBe(f.metadata.oid);
    expect(f.refs.has(f.observation.ref)).toBe(false);
  });
  it("deduplicates consistent bridge history and skips only exact barriers", async () => {
    const f = fixture();
    f.publishLedger();
    f.refs.set(f.observation.ref, f.observation.oid);
    const ref = attemptRef(7, 12, 2),
      oid = sha("barrier");
    f.refs.set(ref, oid);
    f.commits.set(oid, {
      ...f.metadata,
      oid,
      message: encoded("Factory-Admission-Barrier", {
        protocol: "clockgrove.factory/admission-barrier-v1",
        objective: 7,
        workItem: 12,
        attempt: 2,
      }),
    });
    expect(await listAttemptReservationRefs(f.store, 7, 12)).toEqual([f.observation]);
    expect(await readAttemptReservationRef(f.store, 7, 12, 2)).toBeNull();
  });
  it("rejects divergent legacy and ledger identities", async () => {
    const f = fixture();
    f.publishLedger();
    const oid = sha("conflict");
    f.refs.set(f.observation.ref, oid);
    f.commits.set(oid, { ...f.metadata, oid });
    await expect(listAttemptReservationRefs(f.store, 7)).rejects.toThrow(/conflicting/);
  });
  it("rejects mutated reservation metadata and foreign barrier bindings", async () => {
    const f = fixture();
    f.publishLedger();
    f.metadata.parentOids = [f.ledger.oid];
    await expect(listAttemptReservationRefs(f.store, 7)).rejects.toThrow(/immutable metadata/);
    f.refs.clear();
    f.refs.set(f.observation.ref, f.observation.oid);
    f.metadata.message = encoded("Factory-Admission-Barrier", {
      protocol: "clockgrove.factory/admission-barrier-v1",
      objective: 7,
      workItem: 13,
      attempt: 1,
    });
    await expect(listAttemptReservationRefs(f.store, 7)).rejects.toThrow(/barrier binding/);
  });
  it("filters exact issue scope despite overlapping Git prefixes", async () => {
    const f = fixture();
    f.publishLedger();
    f.refs.set(issueAdmissionRef(120), sha("unread-related-issue"));
    expect(await readAttemptReservationRef(f.store, 7, 12, 1)).toBe(f.metadata.oid);
    expect(await listAttemptReservationRefs(f.store, 8, 12)).toEqual([]);
  });
  it("fails closed when ledger attribution contradicts metadata", async () => {
    const f = fixture();
    f.entry.runId = "other";
    f.publishLedger();
    await expect(listAttemptReservationRefs(f.store, 7)).rejects.toThrow(/identity mismatch/);
  });
});
