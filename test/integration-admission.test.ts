import { describe, expect, it, vi } from "vitest";
import {
  withIntegrationAdmission,
  integrationAdmissionRef,
  IntegrationAdmissionPendingError,
  type IntegrationAdmissionIdentity,
} from "../src/control/integration-admission.js";
import type { GitCommitObject } from "../src/control/lease.js";

const sha = (n: number) => n.toString(16).padStart(40, "0");
const identity: IntegrationAdmissionIdentity = {
  repository: "o/r",
  branch: "main",
  objective: 1,
  runId: "run-a",
  epoch: 1,
  pullRequest: 11,
  headSha: sha(11),
  baseSha: sha(1),
  outputTreeSha: sha(21),
};
function fixture() {
  const refs = new Map<string, string>();
  const commits = new Map<string, GitCommitObject>([
    [
      sha(1),
      {
        oid: sha(1),
        treeOid: sha(2),
        parentOids: [],
        message: "base",
        serverTime: new Date(),
      },
    ],
  ]);
  const pulls = new Map<number, { headSha: string; mergeCommitSha: string | null }>();
  let next = 100;
  const store = {
    readRef: vi.fn(async (ref: string) => refs.get(ref) ?? null),
    readCommit: vi.fn(async (oid: string) => {
      const value = commits.get(oid);
      if (!value) throw Error("missing commit");
      return value;
    }),
    createCommit: vi.fn(
      async (args: { treeOid: string; parentOids: string[]; message: string }) => {
        const oid = sha(next++);
        commits.set(oid, { ...args, oid, serverTime: new Date() });
        return oid;
      },
    ),
    createRef: vi.fn(async (ref: string, oid: string) => {
      if (refs.has(ref)) return false;
      refs.set(ref, oid);
      return true;
    }),
    compareAndSwapRef: vi.fn(async (args: { ref: string; beforeOid: string; afterOid: string }) => {
      if (refs.get(args.ref) !== args.beforeOid) return false;
      refs.set(args.ref, args.afterOid);
      return true;
    }),
    readPullRequest: vi.fn(async (number: number) => {
      const value = pulls.get(number) ?? { headSha: sha(number), mergeCommitSha: null };
      return {
        ...value,
        merged: value.mergeCommitSha !== null,
        state: value.mergeCommitSha ? "closed" : "open",
        mergeable: true,
        mergeableState: "clean",
        draft: false,
        baseSha: sha(1),
        baseRef: "main",
        headRepository: "o/r",
        baseRepository: "o/r",
      };
    }),
  };
  const merge = async (id: IntegrationAdmissionIdentity, parent = id.baseSha) => {
    const oid = await store.createCommit({
      treeOid: id.outputTreeSha,
      parentOids: [parent],
      message: "squash",
    });
    pulls.set(id.pullRequest, { headSha: id.headSha, mergeCommitSha: oid });
    return oid;
  };
  return { store, refs, commits, merge, fence: vi.fn(async () => {}) };
}
describe("short cross-session default-branch admission", () => {
  it("keeps the transaction inside the store's queued-transport Objective fence", async () => {
    const f = fixture();
    let inside = false;
    const store: Parameters<typeof withIntegrationAdmission>[0] = {
      ...f.store,
      withMutationFence: async <T>(fence: () => Promise<void>, operation: () => Promise<T>) => {
        expect(fence).toBe(f.fence);
        inside = true;
        try {
          return await operation();
        } finally {
          inside = false;
        }
      },
    };
    await withIntegrationAdmission(store, identity, f.fence, async () => {
      expect(inside).toBe(true);
      return "wait";
    });
    expect(inside).toBe(false);
  });
  it("serializes independent owners only at merge and lets the second validate on the advanced base", async () => {
    const f = fixture();
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    let finish!: () => void;
    const finishing = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const first = withIntegrationAdmission(f.store, identity, f.fence, async (claim) => {
      await claim.dispatch();
      enter();
      await finishing;
      return f.merge(identity);
    });
    await entered;
    const second = {
      ...identity,
      objective: 2,
      runId: "run-b",
      pullRequest: 12,
      headSha: sha(12),
      outputTreeSha: sha(22),
    };
    const transport = vi.fn();
    await expect(
      withIntegrationAdmission(f.store, second, f.fence, transport),
    ).rejects.toBeInstanceOf(IntegrationAdmissionPendingError);
    expect(transport).not.toHaveBeenCalled();
    finish();
    const advancedBase = await first;
    const rebased = { ...second, baseSha: advancedBase };
    await expect(
      withIntegrationAdmission(f.store, rebased, f.fence, async (claim) => {
        await claim.dispatch();
        return f.merge(rebased);
      }),
    ).resolves.toMatch(/^[0-9a-f]{40}$/);
    expect(f.store.createRef).toHaveBeenCalledTimes(1);
    expect(f.store.compareAndSwapRef).toHaveBeenCalledTimes(5);
  });
  it("releases a nonready pre-dispatch observation without sending a merge", async () => {
    const f = fixture();
    await expect(
      withIntegrationAdmission(f.store, identity, f.fence, async () => "wait"),
    ).resolves.toBe("wait");
    const send = vi.fn(async () => "wait");
    await withIntegrationAdmission(f.store, { ...identity, objective: 2 }, f.fence, send);
    expect(send).toHaveBeenCalledOnce();
    expect(f.store.readPullRequest).not.toHaveBeenCalled();
  });
  it("does not hand off an uncertain send until exact GitHub result proof, even to the same owner", async () => {
    const f = fixture();
    await expect(
      withIntegrationAdmission(f.store, identity, f.fence, async (claim) => {
        await claim.dispatch();
        throw Error("transport response lost");
      }),
    ).rejects.toThrow("response lost");
    const send = vi.fn();
    await expect(withIntegrationAdmission(f.store, identity, f.fence, send)).rejects.toBeInstanceOf(
      IntegrationAdmissionPendingError,
    );
    expect(send).not.toHaveBeenCalled();
    await f.merge(identity);
    await withIntegrationAdmission(
      f.store,
      { ...identity, objective: 2 },
      f.fence,
      async () => "wait",
    );
  });
  it("retains the claim when an external writer wins the unguarded base race; head-only merge is not base CAS", async () => {
    const f = fixture();
    await expect(
      withIntegrationAdmission(f.store, identity, f.fence, async (claim) => {
        await claim.dispatch();
        return f.merge(identity, sha(77));
      }),
    ).rejects.toThrow("validated base and tree");
    const oid = f.refs.get(integrationAdmissionRef("o/r", "main"))!;
    expect(f.commits.get(oid)!.message).not.toContain('"released"');
    await expect(
      withIntegrationAdmission(f.store, { ...identity, objective: 2 }, f.fence, vi.fn()),
    ).rejects.toThrow("validated base and tree");
  });
  it("refuses stale Objective authority before any claim write or merge callback", async () => {
    const f = fixture();
    const send = vi.fn();
    await expect(
      withIntegrationAdmission(
        f.store,
        identity,
        async () => {
          throw Error("Objective lost");
        },
        send,
      ),
    ).rejects.toThrow("Objective lost");
    expect(send).not.toHaveBeenCalled();
    expect(f.store.createRef).not.toHaveBeenCalled();
  });
  it("recovers only the same prepared operation in a higher fenced epoch and fences the old sender by CAS", async () => {
    const f = fixture();
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let resume!: () => void;
    const resumeOld = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const send = vi.fn();
    const old = withIntegrationAdmission(f.store, identity, f.fence, async (claim) => {
      entered();
      await resumeOld;
      await claim.dispatch();
      send();
    });
    // Attach rejection handling before resuming the old producer.
    const rejected = expect(old).rejects.toBeInstanceOf(IntegrationAdmissionPendingError);
    await ready;
    await expect(
      withIntegrationAdmission(f.store, { ...identity, objective: 2, epoch: 2 }, f.fence, vi.fn()),
    ).rejects.toBeInstanceOf(IntegrationAdmissionPendingError);
    await withIntegrationAdmission(
      f.store,
      { ...identity, epoch: 2 },
      f.fence,
      async () => "not-ready",
    );
    resume();
    await rejected;
    expect(send).not.toHaveBeenCalled();
  });
  it("retains native asynchronous ownership until every exact member squash is observed", async () => {
    const f = fixture();
    const native = {
      ...identity,
      pullRequest: 12,
      headSha: sha(12),
      outputTreeSha: sha(22),
      members: [
        { pullRequest: 11, headSha: sha(11), outputTreeSha: sha(21) },
        { pullRequest: 12, headSha: sha(12), outputTreeSha: sha(22) },
      ],
    };
    await expect(
      withIntegrationAdmission(f.store, native, f.fence, async (claim) => {
        await claim.dispatch();
        return "pending";
      }),
    ).rejects.toBeInstanceOf(IntegrationAdmissionPendingError);
    const firstMerge = await f.merge(identity);
    await expect(
      withIntegrationAdmission(f.store, { ...identity, objective: 2 }, f.fence, vi.fn()),
    ).rejects.toBeInstanceOf(IntegrationAdmissionPendingError);
    await f.merge(native, firstMerge);
    await withIntegrationAdmission(
      f.store,
      { ...identity, objective: 2 },
      f.fence,
      async () => "wait",
    );
  });
});
