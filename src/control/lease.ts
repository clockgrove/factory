import { type LeaseEvent, parseFactoryEvent } from "../protocol/events.js";
import { PROTOCOL_V2, gitSha } from "../protocol/limits.js";

export interface GitCommitObject {
  oid: string;
  treeOid: string;
  parentOids: string[];
  message: string;
  serverTime: Date;
}

export interface LeaseStore {
  readRef(ref: string): Promise<string | null>;
  /** Optional single-call ref observation carrying authoritative server time. */
  readRefWithServerTime?(
    ref: string,
  ): Promise<{ oid: string | null; serverTime: Date }>;
  readCommit(oid: string): Promise<GitCommitObject>;
  createCommit(args: {
    treeOid: string;
    parentOids: string[];
    message: string;
  }): Promise<string>;
  createRef(ref: string, oid: string): Promise<boolean>;
  compareAndSwapRef(args: {
    ref: string;
    beforeOid: string;
    afterOid: string;
  }): Promise<boolean>;
  serverTime(): Promise<Date>;
}

export interface LeaseIdentity {
  objective: number;
  runId: string;
  holder: string;
  policyDigest: string;
}

export interface LeaseState extends LeaseIdentity {
  ref: string;
  oid: string;
  treeOid: string;
  epoch: number;
  sequence: number;
  expiresAt: Date;
}

export class LeaseLostError extends Error {
  constructor(message = "Factory Director lease was lost") {
    super(message);
    this.name = "LeaseLostError";
  }
}

export function leaseRef(objective: number): string {
  if (!Number.isInteger(objective) || objective <= 0) {
    throw new Error("objective number must be a positive integer");
  }
  return `refs/clockgrove-factory/leases/objective-${objective}`;
}

function leaseMessage(event: LeaseEvent): string {
  const encoded = Buffer.from(JSON.stringify(event), "utf8").toString("base64url");
  return `Factory lease ${event.event} for Objective #${event.objective}\n\nFactory-Event: ${encoded}`;
}

function parseLease(commit: GitCommitObject): LeaseState {
  const trailer = commit.message
    .split(/\r?\n/)
    .reverse()
    .find((line) => line.startsWith("Factory-Event: "));
  if (!trailer) throw new Error("lease commit has no Factory-Event trailer");
  const raw = Buffer.from(trailer.slice("Factory-Event: ".length), "base64url").toString("utf8");
  const parsed = parseFactoryEvent(JSON.parse(raw));
  if (parsed.kind !== "lease") throw new Error("control ref does not contain a lease event");
  gitSha.parse(commit.oid);
  return {
    ref: leaseRef(parsed.objective),
    oid: commit.oid,
    treeOid: commit.treeOid,
    objective: parsed.objective,
    runId: parsed.runId,
    holder: parsed.holder,
    policyDigest: parsed.policyDigest,
    epoch: parsed.epoch,
    sequence: parsed.sequence,
    expiresAt: new Date(parsed.expiresAt),
  };
}

export interface LeaseManagerOptions {
  store: LeaseStore;
  durationMs?: number;
}

export const DEFAULT_LEASE_DURATION_MS = 10 * 60_000;
export const DEFAULT_LEASE_RENEWAL_LEAD_MS = 2 * 60_000;
export const DEFAULT_LEASE_RENEWAL_INTERVAL_MS =
  DEFAULT_LEASE_DURATION_MS - DEFAULT_LEASE_RENEWAL_LEAD_MS;

export class LeaseManager {
  readonly #store: LeaseStore;
  readonly #durationMs: number;

  constructor(options: LeaseManagerOptions) {
    this.#store = options.store;
    this.#durationMs = options.durationMs ?? DEFAULT_LEASE_DURATION_MS;
    if (this.#durationMs < 30_000) {
      throw new Error("lease duration must be at least 30 seconds");
    }
  }

  async read(objective: number): Promise<LeaseState | null> {
    const ref = leaseRef(objective);
    const oid = await this.#store.readRef(ref);
    return oid ? parseLease(await this.#store.readCommit(oid)) : null;
  }

  async acquire(
    identity: LeaseIdentity,
    base: GitCommitObject,
    requestedSequence?: number,
  ): Promise<LeaseState> {
    const now = await this.#store.serverTime();
    const ref = leaseRef(identity.objective);
    const current = await this.read(identity.objective);
    if (current && current.expiresAt.getTime() > now.getTime()) {
      if (current.runId === identity.runId && current.holder === identity.holder) {
        return this.renew(current);
      }
      throw new LeaseLostError(`Objective #${identity.objective} is leased by ${current.holder}`);
    }

    const epoch = (current?.epoch ?? 0) + 1;
    const sequence = requestedSequence ?? (current?.sequence ?? 0) + 1;
    if (sequence <= (current?.sequence ?? 0)) {
      throw new Error("lease sequence must advance");
    }
    const event: LeaseEvent = {
      protocol: PROTOCOL_V2,
      kind: "lease",
      event: "LeaseAcquired",
      objective: identity.objective,
      runId: identity.runId,
      sequence,
      at: now.toISOString(),
      holder: identity.holder,
      epoch,
      expiresAt: new Date(now.getTime() + this.#durationMs).toISOString(),
      policyDigest: identity.policyDigest,
      ...(current ? { previousOid: current.oid } : {}),
    };
    const parentOid = current?.oid ?? base.oid;
    const treeOid = current?.treeOid ?? base.treeOid;
    const oid = await this.#store.createCommit({
      treeOid,
      parentOids: [parentOid],
      message: leaseMessage(event),
    });
    const won = current
      ? await this.#store.compareAndSwapRef({ ref, beforeOid: current.oid, afterOid: oid })
      : await this.#store.createRef(ref, oid);
    if (!won) throw new LeaseLostError("another Director won lease acquisition");
    return { ...identity, ref, oid, treeOid, epoch, sequence, expiresAt: new Date(event.expiresAt) };
  }

  async renew(lease: LeaseState, requestedSequence?: number): Promise<LeaseState> {
    await this.assertCurrent(lease);
    const now = await this.#store.serverTime();
    const event: LeaseEvent = {
      protocol: PROTOCOL_V2,
      kind: "lease",
      event: "LeaseRenewed",
      objective: lease.objective,
      runId: lease.runId,
      sequence: requestedSequence ?? lease.sequence + 1,
      at: now.toISOString(),
      holder: lease.holder,
      epoch: lease.epoch,
      expiresAt: new Date(now.getTime() + this.#durationMs).toISOString(),
      policyDigest: lease.policyDigest,
      previousOid: lease.oid,
    };
    if (event.sequence <= lease.sequence) throw new Error("lease sequence must advance");
    const oid = await this.#store.createCommit({
      treeOid: lease.treeOid,
      parentOids: [lease.oid],
      message: leaseMessage(event),
    });
    const won = await this.#store.compareAndSwapRef({
      ref: lease.ref,
      beforeOid: lease.oid,
      afterOid: oid,
    });
    if (!won) throw new LeaseLostError("another Director advanced the lease");
    return { ...lease, oid, sequence: event.sequence, expiresAt: new Date(event.expiresAt) };
  }

  async release(lease: LeaseState, requestedSequence?: number): Promise<LeaseState> {
    await this.assertCurrent(lease);
    const now = await this.#store.serverTime();
    const event: LeaseEvent = {
      protocol: PROTOCOL_V2,
      kind: "lease",
      event: "LeaseReleased",
      objective: lease.objective,
      runId: lease.runId,
      sequence: requestedSequence ?? lease.sequence + 1,
      at: now.toISOString(),
      holder: lease.holder,
      epoch: lease.epoch,
      expiresAt: now.toISOString(),
      policyDigest: lease.policyDigest,
      previousOid: lease.oid,
    };
    if (event.sequence <= lease.sequence) throw new Error("lease sequence must advance");
    const oid = await this.#store.createCommit({
      treeOid: lease.treeOid,
      parentOids: [lease.oid],
      message: leaseMessage(event),
    });
    const won = await this.#store.compareAndSwapRef({
      ref: lease.ref,
      beforeOid: lease.oid,
      afterOid: oid,
    });
    if (!won) throw new LeaseLostError("another Director advanced the lease before release");
    return { ...lease, oid, sequence: event.sequence, expiresAt: now };
  }

  async assertCurrent(lease: LeaseState): Promise<void> {
    const observation = this.#store.readRefWithServerTime
      ? await this.#store.readRefWithServerTime(lease.ref)
      : {
          oid: await this.#store.readRef(lease.ref),
          serverTime: await this.#store.serverTime(),
        };
    const { oid } = observation;
    if (!oid) throw new LeaseLostError();
    const current = oid === lease.oid
      ? lease
      : parseLease(await this.#store.readCommit(oid));
    if (
      current.objective !== lease.objective ||
      current.epoch !== lease.epoch ||
      current.runId !== lease.runId ||
      current.holder !== lease.holder ||
      current.policyDigest !== lease.policyDigest ||
      current.sequence < lease.sequence ||
      (current.sequence === lease.sequence && current.oid !== lease.oid) ||
      current.expiresAt.getTime() <= observation.serverTime.getTime()
    ) {
      throw new LeaseLostError();
    }
  }
}
