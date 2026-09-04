import { describe, expect, it } from "vitest";

import type { GitCommitObject, LeaseStore } from "../src/control/lease.js";
import {
  REPOSITORY_LEASE_REF,
  RepositoryLeaseLostError,
  RepositoryLeaseManager,
} from "../src/controller/repository-lease.js";

class MemoryLeaseStore implements LeaseStore {
  readonly refs = new Map<string, string>();
  readonly commits = new Map<string, GitCommitObject>();
  now = new Date("2026-01-01T00:00:00.000Z");
  observations = 0;
  #next = 2;

  constructor() {
    this.commits.set("1".repeat(40), {
      oid: "1".repeat(40),
      treeOid: "a".repeat(40),
      parentOids: [],
      message: "base",
      serverTime: this.now,
    });
  }

  readRef(ref: string): Promise<string | null> {
    return Promise.resolve(this.refs.get(ref) ?? null);
  }

  readRefWithServerTime(
    ref: string,
  ): Promise<{ oid: string | null; serverTime: Date }> {
    this.observations += 1;
    return Promise.resolve({
      oid: this.refs.get(ref) ?? null,
      serverTime: this.now,
    });
  }

  readCommit(oid: string): Promise<GitCommitObject> {
    const commit = this.commits.get(oid);
    if (!commit) throw new Error(`missing commit ${oid}`);
    return Promise.resolve(commit);
  }

  createCommit(input: {
    treeOid: string;
    parentOids: string[];
    message: string;
  }): Promise<string> {
    const oid = this.#next.toString(16).padStart(40, "0");
    this.#next += 1;
    this.commits.set(oid, {
      oid,
      ...input,
      serverTime: this.now,
    });
    return Promise.resolve(oid);
  }

  createRef(ref: string, oid: string): Promise<boolean> {
    if (this.refs.has(ref)) return Promise.resolve(false);
    this.refs.set(ref, oid);
    return Promise.resolve(true);
  }

  compareAndSwapRef(input: {
    ref: string;
    beforeOid: string;
    afterOid: string;
  }): Promise<boolean> {
    if (this.refs.get(input.ref) !== input.beforeOid) {
      return Promise.resolve(false);
    }
    this.refs.set(input.ref, input.afterOid);
    return Promise.resolve(true);
  }

  serverTime(): Promise<Date> {
    return Promise.resolve(this.now);
  }

  base(): GitCommitObject {
    return this.commits.get("1".repeat(40))!;
  }
}

const digest = (character: string) => character.repeat(64);

describe("repository-controller lease", () => {
  it("excludes another controller, renews one epoch, and releases cleanly", async () => {
    const store = new MemoryLeaseStore();
    const manager = new RepositoryLeaseManager({
      store,
      durationMs: 60_000,
    });
    const first = await manager.acquire(
      { controllerId: "first", policyDigest: digest("a") },
      store.base(),
    );
    expect(first).toMatchObject({ epoch: 1, sequence: 1 });
    expect(store.refs.has(REPOSITORY_LEASE_REF)).toBe(true);
    await expect(
      manager.acquire(
        { controllerId: "second", policyDigest: digest("b") },
        store.base(),
      ),
    ).rejects.toBeInstanceOf(RepositoryLeaseLostError);

    store.now = new Date("2026-01-01T00:00:10.000Z");
    const renewed = await manager.renew(first);
    expect(renewed).toMatchObject({ epoch: 1, sequence: 2 });
    await expect(manager.assertCurrent(first)).resolves.toBeUndefined();
    expect(store.observations).toBeGreaterThan(0);

    const released = await manager.release(first);
    expect(released).toMatchObject({ epoch: 1, sequence: 3 });
    await expect(manager.assertCurrent(released)).rejects.toBeInstanceOf(
      RepositoryLeaseLostError,
    );
  });

  it("permits deterministic takeover only after authoritative server expiry", async () => {
    const store = new MemoryLeaseStore();
    const manager = new RepositoryLeaseManager({
      store,
      durationMs: 30_000,
    });
    const first = await manager.acquire(
      { controllerId: "first", policyDigest: digest("a") },
      store.base(),
    );
    store.now = new Date("2026-01-01T00:00:30.000Z");
    const second = await manager.acquire(
      { controllerId: "second", policyDigest: digest("b") },
      store.base(),
    );
    expect(second).toMatchObject({ epoch: 2, sequence: 2 });
    await expect(manager.assertCurrent(first)).rejects.toBeInstanceOf(
      RepositoryLeaseLostError,
    );
  });
});
