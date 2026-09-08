import { describe, expect, it, vi } from "vitest";
import {
  withIntegrationAdmission,
  integrationAdmissionRef,
  INTEGRATION_PREPARATION_TIMEOUT_MS,
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
  const record = () => {
    const oid = refs.get(integrationAdmissionRef("o/r", "main"))!;
    const line = commits
      .get(oid)!
      .message.split(/\r?\n/)
      .find((value) => value.startsWith("Factory-Integration: "))!;
    return JSON.parse(Buffer.from(line.slice(21), "base64url").toString("utf8")) as {
      nonce: string;
      state: string;
      identity: { objective: number; runId: string };
      dispatch?: { kind: string; asynchronousMergeUuid?: string };
      outcome?: { kind: string; asynchronousMergeUuid?: string };
    };
  };
  const agePrepared = (legacy = false) => {
    const oid = refs.get(integrationAdmissionRef("o/r", "main"))!;
    const commit = commits.get(oid)!;
    const line = commit.message
      .split(/\r?\n/)
      .find((value) => value.startsWith("Factory-Integration: "))!;
    const value = JSON.parse(Buffer.from(line.slice(21), "base64url").toString("utf8"));
    const old = new Date(commit.serverTime.getTime() - INTEGRATION_PREPARATION_TIMEOUT_MS - 1);
    if (legacy) {
      delete value.preparedAt;
      commit.committedAt = old;
    } else {
      value.preparedAt = old.toISOString();
    }
    commit.message =
      `Factory default-branch integration\n\nFactory-Integration: ` +
      Buffer.from(JSON.stringify(value)).toString("base64url");
  };
  return { store, refs, commits, merge, record, agePrepared, fence: vi.fn(async () => {}) };
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
      await claim.markDispatched("regular");
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
        await claim.markDispatched("regular");
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
        await claim.markDispatched("regular");
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
  it("retires an authoritative 409 for its exact request and admits an unrelated Objective", async () => {
    const f = fixture();
    const rejection = Object.assign(new Error("head SHA does not match"), { status: 409 });
    await expect(
      withIntegrationAdmission(f.store, identity, f.fence, async (claim) => {
        await claim.markDispatched("regular");
        await claim.authoritativeNonExecution({ kind: "regular-http-rejection", status: 409 });
        throw rejection;
      }),
    ).rejects.toBe(rejection);
    expect(f.record()).toMatchObject({
      state: "released",
      dispatch: { kind: "regular" },
      outcome: { kind: "regular-http-rejection", status: 409 },
    });
    const next = vi.fn(async () => "fresh readiness");
    await expect(
      withIntegrationAdmission(
        f.store,
        { ...identity, objective: 2, runId: "run-b", pullRequest: 12, headSha: sha(12) },
        f.fence,
        next,
      ),
    ).resolves.toBe("fresh readiness");
    expect(next).toHaveBeenCalledOnce();
  });
  it("does not let a stale holder retire a newer exact claim", async () => {
    const f = fixture();
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let resume!: () => void;
    const continueOld = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const old = withIntegrationAdmission(f.store, identity, f.fence, async (claim) => {
      await claim.markDispatched("regular");
      entered();
      await continueOld;
      await claim.authoritativeNonExecution({ kind: "regular-http-rejection", status: 409 });
      throw Error("original rejection");
    });
    const rejected = expect(old).rejects.toBeInstanceOf(IntegrationAdmissionPendingError);
    await ready;
    const ref = integrationAdmissionRef("o/r", "main");
    const oldOid = f.refs.get(ref)!;
    const oldCommit = f.commits.get(oldOid)!;
    const line = oldCommit.message
      .split(/\r?\n/)
      .find((value) => value.startsWith("Factory-Integration: "))!;
    const newer = JSON.parse(Buffer.from(line.slice(21), "base64url").toString("utf8"));
    newer.nonce = "00000000-0000-4000-8000-000000000002";
    newer.identity = { ...newer.identity, objective: 2, runId: "run-b" };
    const newerOid = await f.store.createCommit({
      treeOid: oldCommit.treeOid,
      parentOids: [oldOid],
      message: `Factory default-branch integration\n\nFactory-Integration: ${Buffer.from(JSON.stringify(newer)).toString("base64url")}`,
    });
    f.refs.set(ref, newerOid);
    resume();
    await rejected;
    expect(f.record()).toMatchObject({
      state: "dispatched",
      identity: { objective: 2, runId: "run-b" },
    });
  });
  it("retains the claim when an external writer wins the unguarded base race; head-only merge is not base CAS", async () => {
    const f = fixture();
    await expect(
      withIntegrationAdmission(f.store, identity, f.fence, async (claim) => {
        await claim.markDispatched("regular");
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
      await claim.markDispatched("regular");
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
  it.each([false, true])(
    "reclaims an aged preparation for an unrelated Objective and fences the abandoned sender (legacy=%s)",
    async (legacy) => {
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
        await claim.markDispatched("regular");
        send();
      });
      const rejected = expect(old).rejects.toBeInstanceOf(IntegrationAdmissionPendingError);
      await ready;
      f.agePrepared(legacy);
      await withIntegrationAdmission(
        f.store,
        {
          ...identity,
          objective: 2,
          runId: "run-b",
          pullRequest: 12,
          headSha: sha(12),
          outputTreeSha: sha(22),
        },
        f.fence,
        async () => "not-ready",
      );
      resume();
      await rejected;
      expect(send).not.toHaveBeenCalled();
      expect(f.record()).toMatchObject({
        state: "released",
        outcome: { kind: "not-dispatched" },
      });
    },
  );
  it("does not reclaim an aged preparation after its dispatched CAS wins", async () => {
    const f = fixture();
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let resume!: () => void;
    const hold = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const old = withIntegrationAdmission(f.store, identity, f.fence, async (claim) => {
      await claim.markDispatched("regular");
      entered();
      await hold;
      throw Error("response remains unknown");
    });
    const rejected = expect(old).rejects.toThrow("response remains unknown");
    await ready;
    f.agePrepared();
    await expect(
      withIntegrationAdmission(
        f.store,
        { ...identity, objective: 2, runId: "run-b", pullRequest: 12, headSha: sha(12) },
        f.fence,
        vi.fn(),
      ),
    ).rejects.toBeInstanceOf(IntegrationAdmissionPendingError);
    resume();
    await rejected;
    expect(f.record()).toMatchObject({ state: "dispatched", dispatch: { kind: "regular" } });
  });
  it("recovers only the exact native request UUID and retires its terminal failure", async () => {
    const f = fixture();
    await expect(
      withIntegrationAdmission(f.store, identity, f.fence, async (claim) => {
        await claim.markDispatched("native");
        await claim.bindAsynchronousMerge("async-1");
        throw Error("controller stopped while pending");
      }),
    ).rejects.toThrow("controller stopped while pending");
    await expect(
      withIntegrationAdmission(
        f.store,
        { ...identity, objective: 2, runId: "run-b", pullRequest: 12, headSha: sha(12) },
        f.fence,
        vi.fn(),
      ),
    ).rejects.toBeInstanceOf(IntegrationAdmissionPendingError);
    await expect(
      withIntegrationAdmission(f.store, identity, f.fence, async (claim) => {
        expect(claim.dispatch).toMatchObject({
          kind: "native",
          asynchronousMergeUuid: "async-1",
        });
        await claim.authoritativeNonExecution({
          kind: "native-terminal-failure",
          asynchronousMergeUuid: "async-1",
          reason: "provider rejected the exact request",
        });
        throw Error("provider rejected the exact request");
      }),
    ).rejects.toThrow("provider rejected the exact request");
    expect(f.record()).toMatchObject({
      state: "released",
      outcome: { kind: "native-terminal-failure", asynchronousMergeUuid: "async-1" },
    });
    await expect(
      withIntegrationAdmission(
        f.store,
        { ...identity, objective: 2, runId: "run-b", pullRequest: 12, headSha: sha(12) },
        f.fence,
        async () => "next",
      ),
    ).resolves.toBe("next");
  });
  it("binds an authenticated pending UUID when recovering a legacy dispatched record", async () => {
    const f = fixture();
    await expect(
      withIntegrationAdmission(f.store, identity, f.fence, async (claim) => {
        await claim.markDispatched("native");
        throw Error("legacy controller stopped before UUID persistence");
      }),
    ).rejects.toThrow("legacy controller stopped");
    const ref = integrationAdmissionRef("o/r", "main");
    const oid = f.refs.get(ref)!;
    const commit = f.commits.get(oid)!;
    const line = commit.message
      .split(/\r?\n/)
      .find((value) => value.startsWith("Factory-Integration: "))!;
    const legacy = JSON.parse(Buffer.from(line.slice(21), "base64url").toString("utf8"));
    delete legacy.dispatch;
    commit.message =
      `Factory default-branch integration\n\nFactory-Integration: ` +
      Buffer.from(JSON.stringify(legacy)).toString("base64url");
    await expect(
      withIntegrationAdmission(
        f.store,
        identity,
        f.fence,
        async (claim) => {
          expect(claim.dispatch).toMatchObject({
            kind: "native",
            asynchronousMergeUuid: "async-legacy",
          });
          await claim.authoritativeNonExecution({
            kind: "native-terminal-failure",
            asynchronousMergeUuid: "async-legacy",
            reason: "exact legacy request failed",
          });
          throw Error("exact legacy request failed");
        },
        { recoverNativeRequestUuid: "async-legacy" },
      ),
    ).rejects.toThrow("exact legacy request failed");
    expect(f.record()).toMatchObject({
      state: "released",
      dispatch: { kind: "native", asynchronousMergeUuid: "async-legacy" },
      outcome: { kind: "native-terminal-failure", asynchronousMergeUuid: "async-legacy" },
    });
  });
  it("retains a native claim when terminal failure conflicts with partial integration", async () => {
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
        await claim.markDispatched("native");
        await claim.bindAsynchronousMerge("async-partial");
        await f.merge(identity);
        await claim.authoritativeNonExecution({
          kind: "native-terminal-failure",
          asynchronousMergeUuid: "async-partial",
          reason: "remaining member failed",
        });
      }),
    ).rejects.toThrow("conflicts with an integrated member");
    expect(f.record()).toMatchObject({ state: "dispatched", dispatch: { kind: "native" } });
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
        await claim.markDispatched("native");
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
