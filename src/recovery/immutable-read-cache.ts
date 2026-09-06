import { createHash } from "node:crypto";
import type { GitCommitObject } from "../control/lease.js";
import type { RecoveryReadStore } from "./assessment.js";

const MAX_ENTRIES = 2048;
const MAX_BYTES = 32 * 1024 * 1024;
const sha = /^[a-f0-9]{40}$/;
type Value = GitCommitObject | Buffer | string | null;
interface Entry {
  pending: Promise<Value>;
  bytes: number;
}
interface Cache {
  entries: Map<string, Entry>;
  bytes: number;
}
// Ownership is one repository-specific store, not a process-global SHA namespace.
// A dead store releases its cache. No freshness/authority-bearing read is retained.
const caches = new WeakMap<object, Cache>();
const ports = new WeakMap<object, RecoveryReadStore>();

function copy<T extends Value>(value: T): T {
  return (
    Buffer.isBuffer(value)
      ? Buffer.from(value)
      : value && typeof value === "object"
        ? { ...value, parentOids: [...value.parentOids], serverTime: new Date(value.serverTime) }
        : value
  ) as T;
}

/** Successful immutable content only. Returned values cannot mutate retained bytes.
 * Commit serverTime is the ORIGINAL response observation, never a fresh clock.
 * This facade is for recovery evidence, never lease/time authority consumers. */
export function withImmutableRecoveryReads(store: RecoveryReadStore): RecoveryReadStore {
  const existing = ports.get(store);
  if (existing) return existing;
  let cache = caches.get(store);
  if (!cache) {
    cache = { entries: new Map(), bytes: 0 };
    caches.set(store, cache);
  }
  const retained = cache;
  const remove = (key: string, entry: Entry) => {
    if (retained.entries.get(key) !== entry) return;
    retained.entries.delete(key);
    retained.bytes -= entry.bytes;
  };
  const trim = () => {
    while (retained.entries.size > MAX_ENTRIES || retained.bytes > MAX_BYTES) {
      const [key, entry] = retained.entries.entries().next().value!;
      remove(key, entry);
    }
  };
  const read = <T extends Value>(
    key: string,
    operation: () => Promise<T>,
    retain: (value: T) => number | null,
  ): Promise<T> => {
    const prior = retained.entries.get(key);
    if (prior) {
      retained.entries.delete(key);
      retained.entries.set(key, prior);
      return prior.pending.then((value) => copy(value as T));
    }
    const keyBytes = Buffer.byteLength(key) + 64;
    const entry: Entry = { pending: Promise.resolve(null), bytes: keyBytes };
    entry.pending = Promise.resolve()
      .then(operation)
      .then((value) => {
        const privateValue = copy(value);
        const bytes = retain(privateValue);
        if (bytes === null || bytes > MAX_BYTES) remove(key, entry);
        else if (retained.entries.get(key) === entry) {
          entry.bytes += bytes;
          retained.bytes += bytes;
          trim();
        }
        return privateValue;
      })
      .catch((error) => {
        remove(key, entry);
        throw error;
      });
    retained.entries.set(key, entry);
    retained.bytes += keyBytes;
    trim();
    return entry.pending.then((value) => copy(value as T));
  };
  const port: RecoveryReadStore = {
    readRef: (ref) => store.readRef(ref),
    listRefs: (prefix) => store.listRefs(prefix),
    readPullRequest: (number) => store.readPullRequest(number),
    getRepositoryFacts: () => store.getRepositoryFacts(),
    getBranchHead: (branch) => store.getBranchHead(branch),
    readBranchRules: (branch) => store.readBranchRules(branch),
    readChecks: (oid) => store.readChecks(oid),
    ...(store.readStack ? { readStack: store.readStack.bind(store) } : {}),
    readCommit: (oid) => {
      if (!sha.test(oid)) return store.readCommit(oid);
      return read(
        `commit:${oid}`,
        () => store.readCommit(oid),
        (value) => {
          if (
            value.oid !== oid ||
            !sha.test(value.treeOid) ||
            value.parentOids.some((parent) => !sha.test(parent))
          )
            throw new Error("recovery immutable commit identity mismatch");
          return Buffer.byteLength(value.message) + value.parentOids.length * 40 + 256;
        },
      );
    },
    readBlob: (oid) => {
      if (!sha.test(oid)) return store.readBlob(oid);
      return read(
        `blob:${oid}`,
        () => store.readBlob(oid),
        (value) => {
          const actual = createHash("sha1")
            .update(`blob ${value.length}\0`)
            .update(value)
            .digest("hex");
          // A non-content-addressed test/legacy port still receives its own value,
          // but it cannot seed reusable immutable bytes.
          return actual === oid ? value.length : null;
        },
      );
    },
    readTreeEntry: (oid, path) => {
      if (!sha.test(oid)) return store.readTreeEntry(oid, path);
      return read(
        JSON.stringify(["tree-entry", oid, path]),
        () => store.readTreeEntry(oid, path),
        (value) => {
          if (value === null) return null; // Do not retain absence or incomplete observations.
          if (!sha.test(value)) throw new Error("recovery immutable tree entry identity mismatch");
          return Buffer.byteLength(path) + 80;
        },
      );
    },
  };
  caches.set(port, retained);
  ports.set(store, port);
  ports.set(port, port);
  return Object.freeze(port);
}
