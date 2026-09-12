import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  assertQualificationReservationAuthority,
  qualificationReservationAuthorityExpectation,
  observeQualificationReservationAuthority,
  qualificationReservationReadPort,
  revalidateQualificationReservationAuthority,
  resolveQualificationReservationAuthority,
} from "../scripts/qualification-reservation-authority.mjs";

const sha = (value: string) => createHash("sha1").update(value).digest("hex");
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const encoded = (marker: string, value: unknown) =>
  `${marker}: ${Buffer.from(JSON.stringify(value)).toString("base64url")}`;

function fixture({ canonical = true, legacy = false, barrier = false } = {}) {
  const baseSha = sha("base");
  const reserved = {
    protocol: "clockgrove.factory/v2",
    kind: "attempt",
    event: "AttemptReserved",
    objective: 7,
    workItem: 8,
    attempt: 1,
    runId: "run-7",
    sequence: 5,
    at: "2026-09-11T00:00:00.000Z",
    directorEpoch: 2,
    policyDigest: digest("policy"),
    baseSha,
    backend: "codex-app-server/local-worktree",
  };
  const logicalRef = "refs/clockgrove-factory/attempts/objective-7/work-item-8/attempt-1";
  const authorityRef = "refs/clockgrove-factory/admission/work-item-8";
  const reservationOid = sha("reservation");
  const reservationCommit = {
    oid: reservationOid,
    treeOid: sha("tree"),
    parentOids: [baseSha],
    message: `Fixture reservation\n\n${encoded("Factory-Event", reserved)}`,
  };
  const entry = {
    workItem: 8,
    workItemNodeId: "I_8",
    objective: 7,
    runId: reserved.runId,
    directorEpoch: 2,
    writerHolder: "holder",
    policyDigest: reserved.policyDigest,
    graphDigest: digest("graph"),
    graphCommitOid: sha("graph"),
    projectionCommitOid: sha("projection"),
    reservation: {
      ref: logicalRef,
      oid: reservationOid,
      attempt: 1,
      backend: reserved.backend,
      baseSha,
    },
    capacityReservationId: "capacity-1",
    budgetReservationId: "budget-1",
    resourceIdentity: "resource-1",
    compatibilityClaimOid: sha("compatibility"),
    disposition: "terminal",
    writerEpoch: 2,
    currentWriterHolder: "holder",
    dispatchPossible: true,
    evidence: undefined as
      | undefined
      | {
          reservationOid: string;
          resourceIdentity: string;
          capacityReservationId: string;
          budgetReservationId: string;
          producerStopped: true;
          resourcesReleased: true;
          capacityReleased: true;
          accountingSettled: boolean;
          evidenceOid: string;
        },
  };
  const priorRevisionOid = sha("ledger-prior");
  const record = {
    protocol: "clockgrove.factory/issue-admission-v1",
    workItem: 8,
    workItemNodeId: "I_8",
    revision: 3,
    operationId: "11111111-1111-4111-8111-111111111111",
    priorRevisionOid,
    history: [entry],
  };
  const ledgerOid = sha("ledger");
  const ledgerCommit = {
    oid: ledgerOid,
    treeOid: sha("tree"),
    parentOids: [priorRevisionOid],
    message: `Factory issue admission\n\n${encoded("Factory-Issue-Admission", record)}`,
  };
  const refs = new Map<string, string>();
  if (canonical) refs.set(authorityRef, ledgerOid);
  const barrierOid = sha("barrier");
  const barrierCommit = {
    oid: barrierOid,
    treeOid: sha("tree"),
    parentOids: [entry.compatibilityClaimOid],
    message: `Factory permanently sealed historical attempt namespace\n\n${encoded(
      "Factory-Admission-Barrier",
      {
        protocol: "clockgrove.factory/admission-barrier-v1",
        objective: reserved.objective,
        workItem: reserved.workItem,
        attempt: reserved.attempt,
      },
    )}`,
  };
  if (legacy) refs.set(logicalRef, barrier ? barrierOid : reservationOid);
  const commits = new Map([
    [reservationOid, reservationCommit],
    [ledgerOid, ledgerCommit],
    [barrierOid, barrierCommit],
  ]);
  const port = {
    readRef: vi.fn(async (ref: string) => refs.get(ref) ?? null),
    readCommit: vi.fn(async (oid: string) => {
      const commit = commits.get(oid);
      if (!commit) throw new Error("fixture commit missing");
      return structuredClone(commit);
    }),
  };
  return {
    reserved,
    logicalRef,
    authorityRef,
    reservationOid,
    reservationCommit,
    entry,
    record,
    ledgerOid,
    ledgerCommit,
    barrierOid,
    barrierCommit,
    refs,
    commits,
    port,
  };
}

describe("qualification reservation authority", () => {
  it.each([
    ["ledger-only", true, false, "issue-admission"],
    ["consistent dual", true, true, "issue-admission"],
    ["legacy-only", false, true, "legacy-attempt"],
  ])(
    "resolves %s evidence with a replayable stable snapshot",
    async (_name, canonical, legacy, source) => {
      const f = fixture({ canonical, legacy });
      const proof = await resolveQualificationReservationAuthority(f.port, f.reserved);
      expect(proof).toMatchObject({
        logicalRef: f.logicalRef,
        reservationOid: f.reservationOid,
        authority: {
          source,
          canonical: { ref: f.authorityRef },
          legacy: { ref: f.logicalRef },
        },
      });
      expect(() => assertQualificationReservationAuthority(proof, f.reserved)).not.toThrow();
      expect(proof.authority.canonical).not.toHaveProperty("record");
    },
  );

  it("accepts only an authenticated compatibility barrier beside canonical authority", async () => {
    const f = fixture({ canonical: true, legacy: true, barrier: true });
    const proof = await resolveQualificationReservationAuthority(f.port, f.reserved);
    expect(proof.authority.legacy).toMatchObject({
      openingOid: f.barrierOid,
      closingOid: f.barrierOid,
      commit: f.barrierCommit,
    });
    expect(qualificationReservationAuthorityExpectation(proof, f.reserved).legacy).toEqual({
      ref: f.logicalRef,
      oid: f.barrierOid,
      kind: "compatibility-barrier",
    });
    const expectation = qualificationReservationAuthorityExpectation(proof, f.reserved);
    f.refs.set(f.logicalRef, sha("replacement-barrier"));
    await expect(revalidateQualificationReservationAuthority(f.port, expectation)).rejects.toThrow(
      /changed/,
    );

    for (const fault of ["parent", "protocol", "binding", "unknown-field"]) {
      const broken = fixture({ canonical: true, legacy: true, barrier: true });
      if (fault === "parent") broken.barrierCommit.parentOids = [sha("foreign-claim")];
      const value = {
        protocol:
          fault === "protocol"
            ? "clockgrove.factory/admission-barrier-v2"
            : "clockgrove.factory/admission-barrier-v1",
        objective: broken.reserved.objective,
        workItem: broken.reserved.workItem,
        attempt: fault === "binding" ? 2 : broken.reserved.attempt,
        ...(fault === "unknown-field" ? { authority: "forged" } : {}),
      };
      if (fault !== "parent")
        broken.barrierCommit.message = encoded("Factory-Admission-Barrier", value);
      await expect(
        resolveQualificationReservationAuthority(broken.port, broken.reserved),
      ).rejects.toThrow();
    }
  });

  it.each([
    "conflicting-dual",
    "both-absent",
    "missing-target",
    "unknown-ledger-field",
    "bad-ledger-parent",
    "bad-reservation-parent",
    "bad-reservation-event",
  ])("fails closed on %s authority", async (kind) => {
    const f = fixture();
    if (kind === "conflicting-dual") f.refs.set(f.logicalRef, sha("other"));
    if (kind === "both-absent") f.refs.clear();
    if (kind === "missing-target") f.entry.runId = "another-run";
    if (kind === "unknown-ledger-field") Object.assign(f.record, { futureAuthority: true });
    if (kind === "bad-ledger-parent") f.ledgerCommit.parentOids = [sha("other-parent")];
    if (kind === "bad-reservation-parent") f.reservationCommit.parentOids = [sha("other-base")];
    if (kind === "bad-reservation-event") {
      f.reservationCommit.message = encoded("Factory-Event", {
        ...f.reserved,
        policyDigest: digest("other-policy"),
      });
    }
    if (["missing-target", "unknown-ledger-field"].includes(kind))
      f.ledgerCommit.message = encoded("Factory-Issue-Admission", f.record);
    await expect(resolveQualificationReservationAuthority(f.port, f.reserved)).rejects.toThrow();
  });

  it("never falls back after a present malformed ledger or a non-404 transport failure", async () => {
    const f = fixture({ canonical: true, legacy: true });
    f.ledgerCommit.message = "malformed";
    await expect(resolveQualificationReservationAuthority(f.port, f.reserved)).rejects.toThrow();
    expect(f.port.readRef).toHaveBeenCalledTimes(1);

    const refusal = Object.assign(new Error("quota"), { status: 403 });
    const request = vi.fn(async () => {
      throw refusal;
    });
    await expect(observeQualificationReservationAuthority(request, f.reserved)).rejects.toBe(
      refusal,
    );
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each(["canonical", "legacy", "canonical-appearance"])(
    "rejects %s movement without retrying",
    async (kind) => {
      const f = fixture({ canonical: kind !== "canonical-appearance", legacy: true });
      const counts = new Map<string, number>();
      f.port.readRef.mockImplementation(async (ref) => {
        const count = (counts.get(ref) ?? 0) + 1;
        counts.set(ref, count);
        if (kind === "canonical" && ref === f.authorityRef && count === 2) return sha("moved");
        if (kind === "legacy" && ref === f.logicalRef && count === 2) return sha("moved");
        if (kind === "canonical-appearance" && ref === f.authorityRef && count === 2)
          return f.ledgerOid;
        return f.refs.get(ref) ?? null;
      });
      await expect(resolveQualificationReservationAuthority(f.port, f.reserved)).rejects.toThrow(
        /moved|conflicts|canonical authority/,
      );
      expect(f.port.readCommit.mock.calls.length).toBeLessThanOrEqual(2);
    },
  );

  it.each(["canonical", "legacy", "canonical-appearance", "during-reobservation"])(
    "rejects %s movement after dependent proof reads",
    async (kind) => {
      const f = fixture({ canonical: kind !== "canonical-appearance", legacy: true });
      const proof = await resolveQualificationReservationAuthority(f.port, f.reserved);
      const expectation = qualificationReservationAuthorityExpectation(proof, f.reserved);
      const commitReads = f.port.readCommit.mock.calls.length;
      f.port.readRef.mockClear();
      if (kind === "canonical") f.refs.set(f.authorityRef, sha("later-ledger"));
      if (kind === "legacy") f.refs.set(f.logicalRef, sha("later-reservation"));
      if (kind === "canonical-appearance") f.refs.set(f.authorityRef, f.ledgerOid);
      if (kind === "during-reobservation") {
        let legacyReads = 0;
        f.port.readRef.mockImplementation(async (ref) => {
          if (ref === f.logicalRef && ++legacyReads === 2) return sha("moving-reservation");
          return f.refs.get(ref) ?? null;
        });
      }
      await expect(
        revalidateQualificationReservationAuthority(f.port, expectation),
      ).rejects.toThrow(/changed|appeared|moved/);
      expect(f.port.readCommit).toHaveBeenCalledTimes(commitReads);
    },
  );

  it("bounds the full GET-only adapter by one absolute deadline and maps only exact 404", async () => {
    const f = fixture({ canonical: false, legacy: true });
    let now = 1000;
    const request = vi.fn(async (route: string, args: Record<string, unknown>) => {
      expect(route.startsWith("GET ")).toBe(true);
      expect((args.request as { signal: AbortSignal }).signal).toBeInstanceOf(AbortSignal);
      now += 10;
      if (route.endsWith("/git/ref/{ref}")) {
        const ref = `refs/${args.ref}`;
        const oid = f.refs.get(ref);
        if (!oid) throw Object.assign(new Error("missing"), { status: 404 });
        return { data: { ref, object: { type: "commit", sha: oid } } };
      }
      const commit = f.commits.get(String(args.commit_sha))!;
      return {
        data: {
          sha: commit.oid,
          tree: { sha: commit.treeOid },
          parents: commit.parentOids.map((sha) => ({ sha })),
          message: commit.message,
        },
      };
    });
    await expect(
      observeQualificationReservationAuthority(request, f.reserved, {
        deadline: 1100,
        now: () => now,
      }),
    ).resolves.toMatchObject({ authority: { source: "legacy-attempt" } });
    expect(request).toHaveBeenCalledTimes(5);

    const expired = qualificationReservationReadPort(vi.fn(), {
      deadline: 1000,
      now: () => 1000,
    });
    await expect(expired.readRef(f.authorityRef)).rejects.toThrow(/deadline/);
  });

  it("locally races a signal-ignoring transport under the same absolute deadline", async () => {
    const f = fixture();
    const pending = new Promise<never>(() => {});
    await expect(
      observeQualificationReservationAuthority(() => pending, f.reserved, {
        deadline: Date.now() + 5,
      }),
    ).rejects.toThrow(/deadline/);
  });

  it("rejects a response that arrives beyond the absolute deadline before its timer callback", async () => {
    const f = fixture();
    let now = 1000;
    const port = qualificationReservationReadPort(
      async (_route, args) => {
        now = 1020;
        const ref = `refs/${args.ref}`;
        return { data: { ref, object: { type: "commit", sha: f.ledgerOid } } };
      },
      { deadline: 1010, now: () => now },
    );
    await expect(port.readRef(f.authorityRef)).rejects.toThrow(/deadline/);
  });

  it("does not map a late closing canonical 404 into accepted legacy stability", async () => {
    const f = fixture({ canonical: false, legacy: true });
    let now = 1000;
    let canonicalReads = 0;
    const request = async (route: string, args: Record<string, unknown>) => {
      if (route.endsWith("/git/ref/{ref}")) {
        const ref = `refs/${args.ref}`;
        if (ref === f.authorityRef) {
          canonicalReads++;
          if (canonicalReads === 2) now = 1020;
          throw Object.assign(new Error("missing"), { status: 404 });
        }
        return { data: { ref, object: { type: "commit", sha: f.reservationOid } } };
      }
      const commit = f.reservationCommit;
      return {
        data: {
          sha: commit.oid,
          tree: { sha: commit.treeOid },
          parents: commit.parentOids.map((sha) => ({ sha })),
          message: commit.message,
        },
      };
    };
    await expect(
      observeQualificationReservationAuthority(request, f.reserved, {
        deadline: 1010,
        now: () => now,
      }),
    ).rejects.toThrow(/deadline/);
  });

  it("enforces bounded ordered unique ledger history and settlement bindings", async () => {
    const f = fixture();
    f.entry.disposition = "released";
    Object.assign(f.entry, {
      evidence: {
        reservationOid: f.reservationOid,
        resourceIdentity: f.entry.resourceIdentity,
        capacityReservationId: f.entry.capacityReservationId,
        budgetReservationId: f.entry.budgetReservationId,
        producerStopped: true,
        resourcesReleased: true,
        capacityReleased: true,
        accountingSettled: true,
        evidenceOid: sha("settlement"),
      },
    });
    f.ledgerCommit.message = encoded("Factory-Issue-Admission", f.record);
    await expect(
      resolveQualificationReservationAuthority(f.port, f.reserved),
    ).resolves.toBeTruthy();
    f.entry.evidence!.resourceIdentity = "another-resource";
    f.ledgerCommit.message = encoded("Factory-Issue-Admission", f.record);
    await expect(resolveQualificationReservationAuthority(f.port, f.reserved)).rejects.toThrow();
  });

  it("rejects an issue ledger beyond the explicit history bound before following entries", async () => {
    const f = fixture();
    f.record.history = Array.from({ length: 4097 }, () => structuredClone(f.entry));
    f.ledgerCommit.message = encoded("Factory-Issue-Admission", f.record);
    await expect(resolveQualificationReservationAuthority(f.port, f.reserved)).rejects.toThrow(
      /history exceeds bound/,
    );
    expect(f.port.readCommit).toHaveBeenCalledTimes(1);
  });

  it("fully authenticates a near-maximum admission ledger without reducing the 8 MiB bound", async () => {
    const f = fixture();
    const history = [f.entry];
    for (let attempt = 2; attempt <= 4096; attempt++)
      history.push({
        ...structuredClone(f.entry),
        runId: `older-run-${attempt}`,
        reservation: {
          ...f.entry.reservation,
          ref: `refs/clockgrove-factory/attempts/objective-7/work-item-8/attempt-${attempt}`,
          oid: sha(`reservation-${attempt}`),
          attempt,
        },
      });
    f.record.history = history;
    let low = 1,
      high = 1024,
      message = "";
    while (low <= high) {
      const middle = Math.floor((low + high) / 2),
        holder = "h".repeat(middle);
      for (const entry of history) {
        entry.writerHolder = holder;
        entry.currentWriterHolder = holder;
      }
      const candidate = encoded("Factory-Issue-Admission", f.record);
      if (Buffer.byteLength(candidate) < 8 * 1024 * 1024) {
        message = candidate;
        low = middle + 1;
      } else high = middle - 1;
    }
    expect(Buffer.byteLength(message)).toBeGreaterThan(8 * 1024 * 1024 - 16 * 1024);
    f.ledgerCommit.message = message;
    await expect(
      resolveQualificationReservationAuthority(f.port, f.reserved),
    ).resolves.toMatchObject({
      reservationOid: f.reservationOid,
      authority: { source: "issue-admission" },
    });
    expect(f.port.readCommit).toHaveBeenCalledTimes(2);
  });

  it.each(["artifact-consumer", "managed-runtime"])(
    "rejects malformed optional %s data on an unrelated retained history entry",
    async (kind) => {
      const f = fixture();
      const unrelated = {
        ...structuredClone(f.entry),
        runId: "older-run",
        reservation: {
          ...f.entry.reservation,
          ref: "refs/clockgrove-factory/attempts/objective-7/work-item-8/attempt-2",
          oid: sha("older-reservation"),
          attempt: 2,
        },
      };
      unrelated.evidence = undefined;
      if (kind === "artifact-consumer")
        Object.assign(unrelated, {
          artifactConsumer: {
            sourceRunId: "unsafe identity with spaces",
            sourceReservationOid: sha("source-reservation"),
            sourceAttempt: 1,
            artifactDigest: digest("artifact"),
            recoveryPlanCommitOid: sha("plan"),
            recoveryClaimOid: sha("claim"),
          },
        });
      else
        Object.assign(unrelated, {
          managedRuntimeActivation: {
            protocol: "clockgrove.factory/managed-runtime-activation-v1",
            baseSha: f.reserved.baseSha,
            sourceRef: "refs/heads/main",
            requirements: [],
            receipts: [],
            packetDigest: digest("packet"),
            proofDigests: [],
            digest: digest("forged-activation"),
          },
        });
      f.record.history = [f.entry, unrelated];
      f.ledgerCommit.message = encoded("Factory-Issue-Admission", f.record);
      await expect(resolveQualificationReservationAuthority(f.port, f.reserved)).rejects.toThrow();
      expect(f.port.readCommit).toHaveBeenCalledTimes(1);
    },
  );
});
