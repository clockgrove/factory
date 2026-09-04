import { describe, expect, it } from "vitest";

import {
  RepositoryController,
  createGitHubRepositoryController,
} from "../src/controller/repository-controller.js";
import {
  RepositoryControls,
  pathsOverlap,
  type RepositoryAdmission,
} from "../src/controller/repository-controls.js";
import type { LeaseManager, LeaseState } from "../src/control/lease.js";

function lease(objective: number, epoch = 1): LeaseState {
  return {
    objective,
    epoch,
    ref: `refs/lease/${objective}`,
    oid: "a".repeat(40),
    treeOid: "b".repeat(40),
    runId: `run-${objective}`,
    holder: "controller",
    policyDigest: "c".repeat(64),
    sequence: 1,
    expiresAt: new Date("2099-01-01T00:00:00Z"),
  };
}

function manager(
  current = new Map<number, number>([
    [1, 1],
    [2, 1],
  ]),
): LeaseManager {
  return {
    assertGeneration: async (value: LeaseState, boundary: string) => {
      if (current.get(value.objective) !== value.epoch)
        throw new Error(`stale lease generation rejected before ${boundary}`);
    },
  } as unknown as LeaseManager;
}

describe("repository controller", () => {
  it("connects durable discovery to fair per-Objective supervisors with shared resources", async () => {
    const seen: Array<{ objective: number; resources: unknown }> = [];
    const controller = createGitHubRepositoryController({
      token: "not-used-by-injected-store",
      owner: "owner",
      repo: "repo",
      repository: "/repo",
      capacity: 2,
      activationStore: {
        discoverObjectiveActivations: async () => [
          {
            objective: 2,
            activatedAt: "2026-01-01T00:00:00Z",
            requestId: "two",
            policy: {},
          },
          {
            objective: 1,
            activatedAt: "2026-01-01T00:00:00Z",
            requestId: "one",
            policy: {},
          },
          {
            objective: 1,
            activatedAt: "2026-01-01T00:00:00Z",
            requestId: "duplicate",
            policy: {},
          },
        ],
      },
      supervisorFactory: (activation, resources) => ({
        run: async () => {
          seen.push({ objective: activation.objective, resources });
        },
      }),
    });
    expect(await controller.reconcileOnce()).toBe(2);
    await controller.settle();
    expect(seen.map((item) => item.objective)).toEqual([1, 2]);
    expect(seen[0]!.resources).toBe(seen[1]!.resources);
  });

  it("fairly activates two Objectives and never admits a Work Item twice", async () => {
    const gates = new Map<number, () => void>();
    const started: number[] = [];
    const controls = new RepositoryControls(2, 2, manager());
    const admission = (
      objective: number,
      workItem: number,
    ): RepositoryAdmission => ({
      objective,
      workItem,
      lease: lease(objective),
      paidUnits: 1,
    });
    const controller = new RepositoryController({
      controls,
      source: {
        discover: async () => [{ number: 2 }, { number: 1 }, { number: 1 }],
        admissions: async (objective) => [
          admission(objective, objective === 1 ? 101 : 202),
        ],
        reconcile: async (_objective, item) => {
          started.push(item.workItem);
          await new Promise<void>((resolve) =>
            gates.set(item.workItem, resolve),
          );
        },
      },
    });

    expect(await controller.reconcileOnce()).toBe(2);
    expect(await controller.reconcileOnce()).toBe(0);
    expect(started).toEqual([101, 202]);
    gates.get(101)!();
    gates.get(202)!();
    await controller.settle();
  });

  it("rejects stale generations before admission, publication, and integration", async () => {
    const controls = new RepositoryControls(1, 1, manager(new Map([[1, 2]])));
    const stale = lease(1, 1);
    await expect(
      controls.admit({ objective: 1, workItem: 10, lease: stale }),
    ).rejects.toThrow("before admission");
    await expect(
      controls.publication(stale, async () => "published"),
    ).rejects.toThrow("before publication");
    await expect(
      controls.integrate(10, stale, async () => "merged"),
    ).rejects.toThrow("before integration");
  });

  it("shares capacity, budget, path claims, and integration serialization across Objectives", async () => {
    const controls = new RepositoryControls(2, 3, manager(), 2, 512);
    const first = await controls.admit({
      objective: 1,
      workItem: 11,
      lease: lease(1),
      paidUnits: 2,
      cpu: 1,
      memoryMb: 256,
      paths: ["src/a"],
    });
    expect(first).toBeTypeOf("function");
    expect(
      await controls.admit({
        objective: 2,
        workItem: 22,
        lease: lease(2),
        paidUnits: 2,
      }),
    ).toBeNull();
    expect(
      await controls.admit({
        objective: 2,
        workItem: 23,
        lease: lease(2),
        paths: ["src/a/file.ts"],
      }),
    ).toBeNull();
    expect(pathsOverlap(["src/a"], ["src/ab"])).toBe(false);
    let unblock!: () => void;
    const integrating = controls.integrate(
      11,
      lease(1),
      () =>
        new Promise<void>((resolve) => {
          unblock = resolve;
        }),
    );
    await Promise.resolve();
    await expect(
      controls.integrate(22, lease(2), async () => {}),
    ).rejects.toThrow("integration is in progress");
    unblock();
    await integrating;
    first!();
  });

  it("continues discovery when one Objective cannot be reconciled", async () => {
    const errors: number[] = [];
    const started: number[] = [];
    const controller = new RepositoryController({
      controls: new RepositoryControls(1, 1, manager()),
      onError: (_e, n) => errors.push(n),
      source: {
        discover: async () => [{ number: 1 }, { number: 2 }],
        admissions: async (n) =>
          n === 1
            ? Promise.reject(new Error("transient"))
            : [{ objective: 2, workItem: 22, lease: lease(2) }],
        reconcile: async (_n, item) => {
          started.push(item.workItem);
        },
      },
    });
    expect(await controller.reconcileOnce()).toBe(1);
    await controller.settle();
    expect(errors).toEqual([1]);
    expect(started).toEqual([22]);
  });

  it("supplies one shared platform and integration pool to every Objective", async () => {
    const seen: unknown[] = [];
    const controller = new RepositoryController({
      controls: new RepositoryControls(2, 2, manager()),
      source: {
        discover: async () => [{ number: 1 }, { number: 2 }],
        admissions: async (n) => [
          { objective: n, workItem: n * 10, lease: lease(n) },
        ],
        reconcile: async (_n, _item, _signal, resources) => {
          seen.push(resources);
        },
      },
    });
    await controller.reconcileOnce();
    await controller.settle();
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(seen[1]);
  });
});
