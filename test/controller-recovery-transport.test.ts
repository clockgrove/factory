import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, expect, it, vi } from "vitest";
import { LeaseManager, type LeaseState } from "../src/control/lease.js";
import type {
  GitHubControlStore,
  DurableObjectiveActivation,
} from "../src/control/github-store.js";
import { adoptRecoveryActivation } from "../src/controller/recovery.js";

vi.mock("../src/recovery/github-read-port.js", () => ({ recoveryReadPort: () => ({}) }));
vi.mock("../src/recovery/runtime.js", () => ({
  loadRecoveryRuntime: async () => ({ status: "missing" }),
}));
vi.mock("../src/recovery/plan.js", () => ({
  loadRecoveryPlan: async () => ({
    plan: {
      successorRunId: "successor",
      requestId: "approved",
      policyDigest: "b".repeat(64),
      expectedBaseSha: "a".repeat(40),
    },
  }),
}));
vi.mock("../src/recovery/coordinator.js", () => ({
  RecoveryCoordinator: class {
    constructor(
      private readonly ports: {
        store: { addIssueComment(node: string, body: string): Promise<unknown> };
      },
    ) {}
    async adopt() {
      await this.ports.store.addIssueComment("objective-node", "retained adoption");
      return { status: "adopted", blockers: [] };
    }
  },
}));
afterEach(() => vi.restoreAllMocks());

it("rejects a queued adoption write after its captured Objective lease is replaced", async () => {
  const scopes = new AsyncLocalStorage<() => Promise<void>>();
  let queued!: () => void, dispatch!: () => void;
  const reachedQueue = new Promise<void>((resolve) => {
    queued = resolve;
  });
  const waitForDispatch = new Promise<void>((resolve) => {
    dispatch = resolve;
  });
  let current = true,
    writes = 0;
  const lease = {
    objective: 7,
    runId: "successor",
    epoch: 2,
    holder: "original-holder",
    policyDigest: "b".repeat(64),
  } as LeaseState;
  vi.spyOn(LeaseManager.prototype, "acquire").mockResolvedValue(lease);
  vi.spyOn(LeaseManager.prototype, "release").mockResolvedValue(lease);
  vi.spyOn(LeaseManager.prototype, "assertCurrent").mockImplementation(async (captured) => {
    expect(captured.holder).toBe("original-holder");
    if (!current) throw new Error("Objective replaced while queued");
  });
  const noop = async () => undefined;
  const store = {
    readCommit: async () => ({
      oid: "a".repeat(40),
      treeOid: "a".repeat(40),
      parentOids: [],
      message: "base",
      serverTime: new Date(),
    }),
    createBlob: noop,
    createTree: noop,
    createCommit: noop,
    createRef: noop,
    serverTime: async () => new Date(),
    withMutationFence: <T>(fence: () => Promise<void>, operation: () => Promise<T>) =>
      scopes.run(fence, operation),
    addIssueComment: async () => {
      queued();
      await waitForDispatch;
      const fence = scopes.getStore();
      expect(fence).toBeTypeOf("function");
      await fence!();
      writes++;
    },
  } as unknown as GitHubControlStore;
  const task = adoptRecoveryActivation({
    token: "test-only",
    owner: "fixture",
    repo: "project",
    checkout: "/unused",
    signal: new AbortController().signal,
    store,
    activation: {
      objective: 7,
      policyDigest: "b".repeat(64),
      baseSha: "a".repeat(40),
      recovery: { successorRunId: "successor", requestId: "approved", planDigest: "c".repeat(64) },
    } as DurableObjectiveActivation,
  });
  const rejected = expect(task).rejects.toThrow("Objective replaced while queued");
  await reachedQueue;
  current = false;
  dispatch();
  await rejected;
  expect(writes).toBe(0);
});
