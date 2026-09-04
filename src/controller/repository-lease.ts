import type { GitCommitObject, LeaseStore } from "../control/lease.js";
import { gitSha } from "../protocol/limits.js";

export const REPOSITORY_LEASE_REF =
  "refs/clockgrove-factory/leases/repository-controller";
export const DEFAULT_REPOSITORY_LEASE_DURATION_MS = 10 * 60_000;
export const DEFAULT_REPOSITORY_LEASE_RENEWAL_INTERVAL_MS = 8 * 60_000;

export interface RepositoryLeaseIdentity {
  controllerId: string;
  policyDigest: string;
}

export interface RepositoryLeaseState extends RepositoryLeaseIdentity {
  ref: typeof REPOSITORY_LEASE_REF;
  oid: string;
  treeOid: string;
  epoch: number;
  sequence: number;
  expiresAt: Date;
}

interface RepositoryLeaseRecord extends RepositoryLeaseIdentity {
  protocol: "clockgrove.factory/v2";
  kind: "repository-lease";
  event:
    | "RepositoryLeaseAcquired"
    | "RepositoryLeaseRenewed"
    | "RepositoryLeaseReleased";
  epoch: number;
  sequence: number;
  at: string;
  expiresAt: string;
  previousOid?: string;
}

export class RepositoryLeaseLostError extends Error {
  constructor(message = "Factory repository-controller lease was lost") {
    super(message);
    this.name = "RepositoryLeaseLostError";
  }
}

export class RepositoryLeaseManager {
  readonly #store: LeaseStore;
  readonly #durationMs: number;

  constructor(options: { store: LeaseStore; durationMs?: number }) {
    this.#store = options.store;
    this.#durationMs =
      options.durationMs ?? DEFAULT_REPOSITORY_LEASE_DURATION_MS;
    if (this.#durationMs < 30_000) {
      throw new Error("repository lease duration must be at least 30 seconds");
    }
  }

  async read(): Promise<RepositoryLeaseState | null> {
    const oid = await this.#store.readRef(REPOSITORY_LEASE_REF);
    return oid ? parseRepositoryLease(await this.#store.readCommit(oid)) : null;
  }

  async acquire(
    identity: RepositoryLeaseIdentity,
    base: GitCommitObject,
  ): Promise<RepositoryLeaseState> {
    validateIdentity(identity);
    const now = await this.#store.serverTime();
    const current = await this.read();
    if (current && current.expiresAt.getTime() > now.getTime()) {
      if (current.controllerId === identity.controllerId) {
        return this.renew(current);
      }
      throw new RepositoryLeaseLostError(
        "another repository controller holds the lease",
      );
    }
    const record = makeRecord(
      "RepositoryLeaseAcquired",
      identity,
      (current?.epoch ?? 0) + 1,
      (current?.sequence ?? 0) + 1,
      now,
      this.#durationMs,
      current?.oid,
    );
    const oid = await this.#commit(
      record,
      current?.treeOid ?? base.treeOid,
      current?.oid ?? base.oid,
    );
    const won = current
      ? await this.#store.compareAndSwapRef({
          ref: REPOSITORY_LEASE_REF,
          beforeOid: current.oid,
          afterOid: oid,
        })
      : await this.#store.createRef(REPOSITORY_LEASE_REF, oid);
    if (!won) {
      throw new RepositoryLeaseLostError(
        "another repository controller won lease acquisition",
      );
    }
    return state(record, oid, current?.treeOid ?? base.treeOid);
  }

  async renew(lease: RepositoryLeaseState): Promise<RepositoryLeaseState> {
    await this.assertCurrent(lease);
    const current = await this.#currentGeneration(lease);
    const now = await this.#store.serverTime();
    const record = makeRecord(
      "RepositoryLeaseRenewed",
      lease,
      lease.epoch,
      current.sequence + 1,
      now,
      this.#durationMs,
      current.oid,
    );
    const oid = await this.#commit(record, current.treeOid, current.oid);
    const won = await this.#store.compareAndSwapRef({
      ref: REPOSITORY_LEASE_REF,
      beforeOid: current.oid,
      afterOid: oid,
    });
    if (!won) {
      throw new RepositoryLeaseLostError(
        "another repository controller advanced the lease",
      );
    }
    return state(record, oid, current.treeOid);
  }

  async release(lease: RepositoryLeaseState): Promise<RepositoryLeaseState> {
    await this.assertCurrent(lease);
    const current = await this.#currentGeneration(lease);
    const now = await this.#store.serverTime();
    const record = makeRecord(
      "RepositoryLeaseReleased",
      lease,
      lease.epoch,
      current.sequence + 1,
      now,
      0,
      current.oid,
    );
    const oid = await this.#commit(record, current.treeOid, current.oid);
    const won = await this.#store.compareAndSwapRef({
      ref: REPOSITORY_LEASE_REF,
      beforeOid: current.oid,
      afterOid: oid,
    });
    if (!won) {
      throw new RepositoryLeaseLostError(
        "another repository controller advanced the lease before release",
      );
    }
    return state(record, oid, current.treeOid);
  }

  async assertCurrent(lease: RepositoryLeaseState): Promise<void> {
    const observation = this.#store.readRefWithServerTime
      ? await this.#store.readRefWithServerTime(REPOSITORY_LEASE_REF)
      : {
          oid: await this.#store.readRef(REPOSITORY_LEASE_REF),
          serverTime: await this.#store.serverTime(),
        };
    if (!observation.oid) throw new RepositoryLeaseLostError();
    const current =
      observation.oid === lease.oid
        ? lease
        : parseRepositoryLease(await this.#store.readCommit(observation.oid));
    if (
      current.controllerId !== lease.controllerId ||
      current.policyDigest !== lease.policyDigest ||
      current.epoch !== lease.epoch ||
      current.sequence < lease.sequence ||
      current.expiresAt.getTime() <= observation.serverTime.getTime()
    ) {
      throw new RepositoryLeaseLostError();
    }
  }

  async #currentGeneration(
    lease: RepositoryLeaseState,
  ): Promise<RepositoryLeaseState> {
    const oid = await this.#store.readRef(REPOSITORY_LEASE_REF);
    if (!oid) throw new RepositoryLeaseLostError();
    const current =
      oid === lease.oid
        ? lease
        : parseRepositoryLease(await this.#store.readCommit(oid));
    if (
      current.controllerId !== lease.controllerId ||
      current.policyDigest !== lease.policyDigest ||
      current.epoch !== lease.epoch
    ) {
      throw new RepositoryLeaseLostError();
    }
    return current;
  }

  async #commit(
    record: RepositoryLeaseRecord,
    treeOid: string,
    parentOid: string,
  ): Promise<string> {
    return this.#store.createCommit({
      treeOid,
      parentOids: [parentOid],
      message: repositoryLeaseMessage(record),
    });
  }
}

function makeRecord(
  event: RepositoryLeaseRecord["event"],
  identity: RepositoryLeaseIdentity,
  epoch: number,
  sequence: number,
  now: Date,
  durationMs: number,
  previousOid?: string,
): RepositoryLeaseRecord {
  return {
    protocol: "clockgrove.factory/v2",
    kind: "repository-lease",
    event,
    controllerId: identity.controllerId,
    policyDigest: identity.policyDigest,
    epoch,
    sequence,
    at: now.toISOString(),
    expiresAt: new Date(now.getTime() + durationMs).toISOString(),
    ...(previousOid ? { previousOid } : {}),
  };
}

function state(
  record: RepositoryLeaseRecord,
  oid: string,
  treeOid: string,
): RepositoryLeaseState {
  return {
    ref: REPOSITORY_LEASE_REF,
    oid,
    treeOid,
    controllerId: record.controllerId,
    policyDigest: record.policyDigest,
    epoch: record.epoch,
    sequence: record.sequence,
    expiresAt: new Date(record.expiresAt),
  };
}

function repositoryLeaseMessage(record: RepositoryLeaseRecord): string {
  const trailer = Buffer.from(JSON.stringify(record), "utf8").toString(
    "base64url",
  );
  return `Factory repository-controller lease\n\nFactory-Repository-Lease: ${trailer}`;
}

function parseRepositoryLease(commit: GitCommitObject): RepositoryLeaseState {
  const trailer = commit.message
    .split(/\r?\n/)
    .reverse()
    .find((line) => line.startsWith("Factory-Repository-Lease: "));
  if (!trailer) {
    throw new Error("repository lease commit has no lease trailer");
  }
  const parsed = JSON.parse(
    Buffer.from(
      trailer.slice("Factory-Repository-Lease: ".length),
      "base64url",
    ).toString("utf8"),
  ) as Partial<RepositoryLeaseRecord>;
  if (
    parsed.protocol !== "clockgrove.factory/v2" ||
    parsed.kind !== "repository-lease" ||
    ![
      "RepositoryLeaseAcquired",
      "RepositoryLeaseRenewed",
      "RepositoryLeaseReleased",
    ].includes(parsed.event ?? "") ||
    !Number.isInteger(parsed.epoch) ||
    Number(parsed.epoch) < 1 ||
    !Number.isInteger(parsed.sequence) ||
    Number(parsed.sequence) < 1 ||
    typeof parsed.controllerId !== "string" ||
    !parsed.controllerId ||
    typeof parsed.policyDigest !== "string" ||
    !/^[0-9a-f]{64}$/.test(parsed.policyDigest) ||
    typeof parsed.expiresAt !== "string" ||
    Number.isNaN(new Date(parsed.expiresAt).getTime())
  ) {
    throw new Error("repository lease record is invalid");
  }
  gitSha.parse(commit.oid);
  gitSha.parse(commit.treeOid);
  return state(parsed as RepositoryLeaseRecord, commit.oid, commit.treeOid);
}

function validateIdentity(identity: RepositoryLeaseIdentity): void {
  if (!identity.controllerId || identity.controllerId.length > 160) {
    throw new Error("controller ID is invalid");
  }
  if (!/^[0-9a-f]{64}$/.test(identity.policyDigest)) {
    throw new Error("controller policy digest is invalid");
  }
}
