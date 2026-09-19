import type { GitCommitObject, LeaseStore } from "../control/lease.js";
import { observeLeaseAssertion } from "../control/mutation-observation.js";
import { gitSha } from "../protocol/limits.js";
import { retryGitHubQuota } from "../platform.js";

export const REPOSITORY_LEASE_REF = "refs/clockgrove-factory/leases/repository-controller";
export const DEFAULT_REPOSITORY_LEASE_DURATION_MS = 10 * 60_000;
export const DEFAULT_REPOSITORY_LEASE_RENEWAL_INTERVAL_MS = 8 * 60_000;

export type RepositoryLeaseOwner =
  | {
      kind: "managed-service";
      hostIdentity: string;
      configDigest: string;
      executableIdentity: string;
      unit: string;
      invocationId: string;
    }
  | { kind: "process" };

export interface RepositoryLeaseIdentity {
  controllerId: string;
  policyDigest: string;
  owner: RepositoryLeaseOwner;
}

export interface RepositoryLeaseState extends RepositoryLeaseIdentity {
  ref: typeof REPOSITORY_LEASE_REF;
  oid: string;
  treeOid: string;
  epoch: number;
  sequence: number;
  at: Date;
  expiresAt: Date;
}

interface RepositoryLeaseRecord extends RepositoryLeaseIdentity {
  protocol: "clockgrove.factory/v2";
  kind: "repository-lease";
  event: "RepositoryLeaseAcquired" | "RepositoryLeaseRenewed" | "RepositoryLeaseReleased";
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

/** A well-formed live lease that grants this claimant no repository authority. */
export class RepositoryLeaseContendedError extends Error {
  readonly retryAfterMs: number;

  constructor(
    readonly expiresAt: Date,
    readonly observedAt: Date,
  ) {
    super(`another repository controller holds the lease until ${expiresAt.toISOString()}`);
    this.name = "RepositoryLeaseContendedError";
    this.retryAfterMs = Math.max(0, expiresAt.getTime() - observedAt.getTime());
  }
}

export class RepositoryLeaseManager {
  readonly #store: LeaseStore;
  readonly #durationMs: number;

  constructor(options: { store: LeaseStore; durationMs?: number }) {
    this.#store = options.store;
    this.#durationMs = options.durationMs ?? DEFAULT_REPOSITORY_LEASE_DURATION_MS;
    if (this.#durationMs < 30_000 || this.#durationMs > DEFAULT_REPOSITORY_LEASE_DURATION_MS) {
      throw new Error("repository lease duration must be between 30 seconds and 10 minutes");
    }
  }

  #withLeaseClass<T>(operation: () => Promise<T>): Promise<T> {
    return this.#store.withMutationClass
      ? this.#store.withMutationClass("lease", operation)
      : operation();
  }

  async read(): Promise<RepositoryLeaseState | null> {
    return this.#withLeaseClass(async () => {
      const oid = await this.#store.readRef(REPOSITORY_LEASE_REF);
      return oid ? parseRepositoryLease(await this.#store.readCommit(oid)) : null;
    });
  }

  async acquire(
    identity: RepositoryLeaseIdentity,
    base: GitCommitObject,
  ): Promise<RepositoryLeaseState> {
    return this.#withLeaseClass(async () => {
      validateIdentity(identity);
      const observation = this.#store.readRefWithServerTime
        ? await this.#store.readRefWithServerTime(REPOSITORY_LEASE_REF)
        : {
            oid: await this.#store.readRef(REPOSITORY_LEASE_REF),
            serverTime: await this.#store.serverTime(),
          };
      const now = observation.serverTime;
      const current = observation.oid
        ? parseRepositoryLease(await this.#store.readCommit(observation.oid))
        : null;
      if (current) validateObservedLeaseTime(current, now);
      if (current && current.expiresAt.getTime() > now.getTime()) {
        if (current.controllerId === identity.controllerId) {
          if (
            current.policyDigest === identity.policyDigest &&
            sameOwner(current.owner, identity.owner)
          ) {
            return this.renew(current);
          }
          throw new RepositoryLeaseContendedError(current.expiresAt, now);
        }
        if (!eligibleManagedTakeover(current, identity)) {
          throw new RepositoryLeaseContendedError(current.expiresAt, now);
        }
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
        await this.#throwContention();
      }
      return state(record, oid, current?.treeOid ?? base.treeOid);
    });
  }

  async #throwContention(): Promise<never> {
    const observation = this.#store.readRefWithServerTime
      ? await this.#store.readRefWithServerTime(REPOSITORY_LEASE_REF)
      : {
          oid: await this.#store.readRef(REPOSITORY_LEASE_REF),
          serverTime: await this.#store.serverTime(),
        };
    if (!observation.oid) {
      throw new Error("repository lease acquisition lost CAS without an authoritative holder");
    }
    const current = parseRepositoryLease(await this.#store.readCommit(observation.oid));
    validateObservedLeaseTime(current, observation.serverTime);
    throw new RepositoryLeaseContendedError(current.expiresAt, observation.serverTime);
  }

  async renew(
    lease: RepositoryLeaseState,
    options: { allowExpiredAfterQuota?: boolean } = {},
  ): Promise<RepositoryLeaseState> {
    return retryGitHubQuota(
      (retried) =>
        this.#withLeaseClass(async () => {
          let current: RepositoryLeaseState;
          if (retried || options.allowExpiredAfterQuota) {
            current = await this.#quotaRenewalOwner(lease);
          } else {
            await this.assertCurrent(lease);
            current = await this.#currentGeneration(lease);
          }
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
            throw new RepositoryLeaseLostError("another repository controller advanced the lease");
          }
          return state(record, oid, current.treeOid);
        }),
      { refresh: false },
    );
  }

  async #quotaRenewalOwner(lease: RepositoryLeaseState): Promise<RepositoryLeaseState> {
    observeLeaseAssertion();
    if (lease.ref !== REPOSITORY_LEASE_REF) throw new RepositoryLeaseLostError();
    const oid = await this.#store.readRef(REPOSITORY_LEASE_REF);
    if (oid !== lease.oid) throw new RepositoryLeaseLostError();
    const commit = await this.#store.readCommit(oid);
    const record = repositoryLeaseRecord(commit);
    const current = state(record, commit.oid, commit.treeOid);
    validateObservedLeaseTime(current, await this.#store.serverTime());
    if (
      record.event === "RepositoryLeaseReleased" ||
      current.controllerId !== lease.controllerId ||
      current.policyDigest !== lease.policyDigest ||
      !sameOwner(current.owner, lease.owner) ||
      current.epoch !== lease.epoch ||
      current.sequence !== lease.sequence ||
      current.treeOid !== lease.treeOid
    )
      throw new RepositoryLeaseLostError();
    return current;
  }

  async release(lease: RepositoryLeaseState): Promise<RepositoryLeaseState> {
    return this.#withLeaseClass(async () => {
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
    });
  }

  async assertCurrent(lease: RepositoryLeaseState): Promise<void> {
    return this.#withLeaseClass(async () => {
      observeLeaseAssertion();
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
      validateObservedLeaseTime(current, observation.serverTime);
      if (
        current.controllerId !== lease.controllerId ||
        current.policyDigest !== lease.policyDigest ||
        !sameOwner(current.owner, lease.owner) ||
        current.epoch !== lease.epoch ||
        current.sequence < lease.sequence ||
        current.expiresAt.getTime() <= observation.serverTime.getTime()
      ) {
        throw new RepositoryLeaseLostError();
      }
    });
  }

  async #currentGeneration(lease: RepositoryLeaseState): Promise<RepositoryLeaseState> {
    return this.#withLeaseClass(async () => {
      const oid = await this.#store.readRef(REPOSITORY_LEASE_REF);
      if (!oid) throw new RepositoryLeaseLostError();
      const current =
        oid === lease.oid ? lease : parseRepositoryLease(await this.#store.readCommit(oid));
      if (
        current.controllerId !== lease.controllerId ||
        current.policyDigest !== lease.policyDigest ||
        !sameOwner(current.owner, lease.owner) ||
        current.epoch !== lease.epoch
      ) {
        throw new RepositoryLeaseLostError();
      }
      return current;
    });
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
    owner: identity.owner,
    epoch,
    sequence,
    at: now.toISOString(),
    expiresAt: new Date(now.getTime() + durationMs).toISOString(),
    ...(previousOid ? { previousOid } : {}),
  };
}

function state(record: RepositoryLeaseRecord, oid: string, treeOid: string): RepositoryLeaseState {
  return {
    ref: REPOSITORY_LEASE_REF,
    oid,
    treeOid,
    controllerId: record.controllerId,
    policyDigest: record.policyDigest,
    owner: record.owner,
    epoch: record.epoch,
    sequence: record.sequence,
    at: new Date(record.at),
    expiresAt: new Date(record.expiresAt),
  };
}

function repositoryLeaseMessage(record: RepositoryLeaseRecord): string {
  const trailer = Buffer.from(JSON.stringify(record), "utf8").toString("base64url");
  return `Factory repository-controller lease\n\nFactory-Repository-Lease: ${trailer}`;
}

function parseRepositoryLease(commit: GitCommitObject): RepositoryLeaseState {
  return state(repositoryLeaseRecord(commit), commit.oid, commit.treeOid);
}

function repositoryLeaseRecord(commit: GitCommitObject): RepositoryLeaseRecord {
  const prefix = "Factory-Repository-Lease: ";
  const trailers = commit.message.split(/\r?\n/).filter((line) => line.startsWith(prefix));
  if (trailers.length !== 1 || trailers[0]!.length >= 8_192) {
    throw new Error("repository lease commit must have one bounded lease trailer");
  }
  const encoded = trailers[0]!.slice(prefix.length);
  const bytes = Buffer.from(encoded, "base64url");
  if (!encoded || bytes.toString("base64url") !== encoded) {
    throw new Error("repository lease trailer encoding is invalid");
  }
  const parsed = JSON.parse(bytes.toString("utf8")) as Partial<RepositoryLeaseRecord>;
  const keys = Object.keys(parsed).sort();
  const expectedKeys = [
    "at",
    "controllerId",
    "epoch",
    "event",
    "expiresAt",
    "kind",
    "owner",
    "policyDigest",
    "protocol",
    "sequence",
    ...(parsed.previousOid === undefined ? [] : ["previousOid"]),
  ].sort();
  const at = typeof parsed.at === "string" ? new Date(parsed.at) : new Date(Number.NaN);
  const expiresAt =
    typeof parsed.expiresAt === "string" ? new Date(parsed.expiresAt) : new Date(Number.NaN);
  const liveDurationMs = expiresAt.getTime() - at.getTime();
  const parentOid = commit.parentOids.length === 1 ? commit.parentOids[0] : undefined;
  if (
    keys.join("\0") !== expectedKeys.join("\0") ||
    parsed.protocol !== "clockgrove.factory/v2" ||
    parsed.kind !== "repository-lease" ||
    !["RepositoryLeaseAcquired", "RepositoryLeaseRenewed", "RepositoryLeaseReleased"].includes(
      parsed.event ?? "",
    ) ||
    !Number.isSafeInteger(parsed.epoch) ||
    Number(parsed.epoch) < 1 ||
    !Number.isSafeInteger(parsed.sequence) ||
    Number(parsed.sequence) < 1 ||
    typeof parsed.controllerId !== "string" ||
    !parsed.controllerId ||
    parsed.controllerId.length > 160 ||
    typeof parsed.policyDigest !== "string" ||
    !/^[0-9a-f]{64}$/.test(parsed.policyDigest) ||
    !isRepositoryLeaseOwner(parsed.owner) ||
    !Number.isFinite(at.getTime()) ||
    at.toISOString() !== parsed.at ||
    !Number.isFinite(expiresAt.getTime()) ||
    expiresAt.toISOString() !== parsed.expiresAt ||
    (parsed.event === "RepositoryLeaseReleased"
      ? liveDurationMs !== 0 || parsed.previousOid === undefined
      : liveDurationMs <= 0 || liveDurationMs > DEFAULT_REPOSITORY_LEASE_DURATION_MS) ||
    (parsed.previousOid === undefined &&
      (parsed.event !== "RepositoryLeaseAcquired" ||
        parsed.epoch !== 1 ||
        parsed.sequence !== 1)) ||
    (parsed.previousOid !== undefined &&
      (Number(parsed.sequence) < Number(parsed.epoch) ||
        (parsed.event === "RepositoryLeaseAcquired"
          ? parsed.epoch === 1
          : Number(parsed.sequence) <= Number(parsed.epoch)))) ||
    parentOid === undefined ||
    (parsed.previousOid !== undefined &&
      (!/^[0-9a-f]{40}$/.test(parsed.previousOid) || parsed.previousOid !== parentOid))
  ) {
    throw new Error("repository lease record is invalid");
  }
  gitSha.parse(commit.oid);
  gitSha.parse(commit.treeOid);
  return parsed as RepositoryLeaseRecord;
}

function validateObservedLeaseTime(lease: RepositoryLeaseState, observedAt: Date): void {
  const now = observedAt.getTime();
  if (
    !Number.isFinite(now) ||
    lease.at.getTime() > now ||
    lease.expiresAt.getTime() > now + DEFAULT_REPOSITORY_LEASE_DURATION_MS
  ) {
    throw new Error("repository lease time is outside the authoritative server window");
  }
}

function validateIdentity(identity: RepositoryLeaseIdentity): void {
  if (!identity.controllerId || identity.controllerId.length > 160) {
    throw new Error("controller ID is invalid");
  }
  if (!/^[0-9a-f]{64}$/.test(identity.policyDigest)) {
    throw new Error("controller policy digest is invalid");
  }
  if (!isRepositoryLeaseOwner(identity.owner)) {
    throw new Error("repository lease owner is invalid");
  }
}

function eligibleManagedTakeover(
  current: RepositoryLeaseIdentity,
  candidate: RepositoryLeaseIdentity,
): boolean {
  return (
    current.policyDigest === candidate.policyDigest &&
    current.owner.kind === "managed-service" &&
    candidate.owner.kind === "managed-service" &&
    current.owner.hostIdentity === candidate.owner.hostIdentity &&
    current.owner.configDigest === candidate.owner.configDigest &&
    current.owner.executableIdentity === candidate.owner.executableIdentity &&
    current.owner.unit === candidate.owner.unit &&
    current.owner.invocationId !== candidate.owner.invocationId
  );
}

function sameOwner(left: RepositoryLeaseOwner, right: RepositoryLeaseOwner): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "process" || right.kind === "process") return true;
  return (
    left.hostIdentity === right.hostIdentity &&
    left.configDigest === right.configDigest &&
    left.executableIdentity === right.executableIdentity &&
    left.unit === right.unit &&
    left.invocationId === right.invocationId
  );
}

function isRepositoryLeaseOwner(value: unknown): value is RepositoryLeaseOwner {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const owner = value as Record<string, unknown>;
  if (owner.kind === "process") {
    return Object.keys(owner).length === 1;
  }
  if (owner.kind !== "managed-service") return false;
  const keys = Object.keys(owner).sort();
  if (
    keys.join("\0") !==
    ["configDigest", "executableIdentity", "hostIdentity", "invocationId", "kind", "unit"].join(
      "\0",
    )
  ) {
    return false;
  }
  return (
    typeof owner.hostIdentity === "string" &&
    /^[0-9a-f]{64}$/.test(owner.hostIdentity) &&
    typeof owner.configDigest === "string" &&
    /^[0-9a-f]{64}$/.test(owner.configDigest) &&
    typeof owner.executableIdentity === "string" &&
    /^sha256:[0-9a-f]{64}$/.test(owner.executableIdentity) &&
    typeof owner.unit === "string" &&
    /^clockgrove-factory-[0-9a-f]{16}\.service$/.test(owner.unit) &&
    typeof owner.invocationId === "string" &&
    /^[0-9a-f]{32}$/.test(owner.invocationId)
  );
}
