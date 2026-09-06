import { access } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubControlStore } from "../src/control/github-store.js";
import { decodeEventComments } from "../src/control/receipts.js";
import * as worktrees from "../src/runtime/local-worktree.js";
import * as transfers from "../src/control/artifact-transfers.js";
import { publicationBranch } from "../src/publication/publisher.js";
import { providerSupervisorFixture } from "./helpers/provider-supervisor.js";

const fixtures: Awaited<ReturnType<typeof providerSupervisorFixture>>[] = [];
const retained: worktrees.LocalWorktree[] = [];
function interruptReady(workItem: number) {
  const persist = transfers.persistArtifactTransfer;
  let first = true;
  vi.spyOn(transfers, "persistArtifactTransfer").mockImplementation(async (args) => {
    const result = await persist(args);
    if (first && args.identity.workItem === workItem) {
      first = false;
      throw new Error("fixture: ready handoff interrupted");
    }
    return result;
  });
}
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose();
  for (const worker of retained.splice(0))
    await worktrees.cleanupLocalWorktree(worker).catch(() => {});
});

describe("Supervisor collected artifact durability", () => {
  it("does not turn an unknown post-dispatch observation into a retryable failure", async () => {
    const f = await providerSupervisorFixture("daytona-burst", {
      localOnly: true,
      configureLocalBackend: (backend) => ({
        ...backend,
        observe: async () => {
          throw new Error("fixture: observation unavailable");
        },
      }),
    });
    fixtures.push(f);
    const create = worktrees.createLocalWorktree;
    vi.spyOn(worktrees, "createLocalWorktree").mockImplementation(async (...args) => {
      const worker = await create(...args);
      retained.push(worker);
      return worker;
    });
    await expect(f.run()).rejects.toThrow(/artifact transfer recovery/);
    await expect(f.run()).rejects.toThrow(/completion is unknown after dispatch/);
    expect(
      f
        .events()
        .some(
          (event) =>
            event.kind === "run" &&
            ["FactoryRunCompleted", "FactoryRunCancelled", "FactoryRunEscalated"].includes(
              event.event,
            ),
        ),
    ).toBe(false);
    expect(f.activity.filter((entry) => entry.operation === "launch")).toHaveLength(1);
    await expect(access(retained[0]!.path)).resolves.toBeUndefined();
    expect(
      f
        .events()
        .some(
          (event) =>
            event.kind === "attempt" && ["AttemptFailed", "AttemptDeferred"].includes(event.event),
        ),
    ).toBe(false);
  });

  it("preserves explicit observed execution failure instead of classifying it as unknown completion", async () => {
    const f = await providerSupervisorFixture("daytona-burst", {
      localOnly: true,
      configureLocalBackend: (backend) => ({
        ...backend,
        observe: async () => ({
          state: "failed",
          reason: "fixture: explicit execution failure",
          observedAt: new Date().toISOString(),
          usage: { inputTokens: 4, outputTokens: 2, cachedInputTokens: null },
        }),
      }),
    });
    fixtures.push(f);
    await f.run();
    expect(
      f.events().some((event) => event.kind === "attempt" && event.event === "AttemptFailed"),
    ).toBe(true);
  });

  it("preserves recorded no-dispatch rejection after an execution reservation", async () => {
    const f = await providerSupervisorFixture("daytona-burst", { localOnly: true });
    fixtures.push(f);
    vi.spyOn(worktrees, "createLocalWorktree").mockRejectedValue(
      new Error("fixture: prelaunch materialization refused"),
    );
    await f.run();
    expect(
      f
        .events()
        .some(
          (event) =>
            event.kind === "budget" &&
            event.event === "BudgetReserved" &&
            event.phase === "execution",
        ),
    ).toBe(true);
    expect(
      f.events().some((event) => event.kind === "attempt" && event.event === "AttemptFailed"),
    ).toBe(true);
    expect(f.activity.some((entry) => entry.operation === "launch")).toBe(false);
    await f.run();
    expect(f.activity.some((entry) => entry.operation === "launch")).toBe(false);
  });

  it("reuses exact scalar usage without inventing a missing token breakdown", async () => {
    const f = await providerSupervisorFixture("daytona-burst", { localOnly: true });
    fixtures.push(f);
    interruptReady(8);
    await expect(f.run()).rejects.toThrow(/artifact transfer recovery/);
    for (const event of f.snapshot.workItems[0]!.factoryEvents ?? []) {
      if (event.kind === "budget" && event.phase === "execution" && event.unit === "model_tokens")
        delete event.reportedModelUsage;
    }
    await expect(f.run()).resolves.toMatchObject({ status: "completed" });
    const model = f
      .events()
      .filter(
        (event) =>
          event.kind === "budget" &&
          event.workItem === 8 &&
          event.phase === "execution" &&
          event.unit === "model_tokens",
      );
    expect(model).toHaveLength(1);
    expect(model[0]).toMatchObject({ amount: 6 });
    expect(model[0]).not.toHaveProperty("reportedModelUsage");
    expect(
      f.activity.filter((entry) => entry.operation === "launch" && entry.workItem === 8),
    ).toHaveLength(1);
  }, 15_000);

  it("does not replace a sandbox artifact when its independent validation allowance is absent", async () => {
    const f = await providerSupervisorFixture("daytona-burst", { nativeStack: true });
    fixtures.push(f);
    interruptReady(9);
    await expect(f.run()).rejects.toThrow(/artifact transfer recovery/);
    const item = f.snapshot.workItems[1]!;
    item.factoryEvents = item.factoryEvents!.filter(
      (event) =>
        !(
          event.kind === "budget" &&
          event.phase === "validation" &&
          event.event === "BudgetReserved"
        ),
    );
    await expect(f.run()).resolves.toMatchObject({
      status: "escalated",
      reason: expect.stringMatching(/existing unspent independent-validation allowance/),
    });
    expect(
      f.events().filter((event) => event.kind === "run" && event.event === "FactoryRunEscalated"),
    ).toHaveLength(1);
    expect(
      f.activity.filter((entry) => entry.operation === "launch" && entry.workItem === 9),
    ).toHaveLength(1);
    expect(f.activity.some((entry) => entry.operation === "validate" && entry.workItem === 9)).toBe(
      false,
    );
  });

  it("rejects conflicting terminal usage rather than relaunching or charging a new attempt", async () => {
    const f = await providerSupervisorFixture("daytona-burst", { localOnly: true });
    fixtures.push(f);
    interruptReady(8);
    await expect(f.run()).rejects.toThrow(/artifact transfer recovery/);
    const item = f.snapshot.workItems[0]!;
    const model = item.factoryEvents!.find(
      (event) => event.kind === "budget" && event.unit === "model_tokens",
    )!;
    if (model.kind !== "budget") throw new Error("fixture model receipt missing");
    item.factoryEvents!.push({
      ...model,
      sequence: Math.max(...f.events().map((event) => event.sequence)) + 1,
      amount: 7,
      reportedModelUsage: { inputTokens: 5, outputTokens: 2 },
    });
    await expect(f.run()).resolves.toMatchObject({
      status: "escalated",
      reason: expect.stringMatching(
        /conflicting model usage|exact reconciled execution accounting/,
      ),
    });
    expect(
      f.events().filter((event) => event.kind === "run" && event.event === "FactoryRunEscalated"),
    ).toHaveLength(1);
    expect(
      f.activity.filter((entry) => entry.operation === "launch" && entry.workItem === 8),
    ).toHaveLength(1);
  });
  for (const remote of [false, true]) {
    for (const phase of ["ready", "before-first-write"] as const) {
      it(`resumes ${remote ? "sandbox child" : "local"} ${phase} bytes without relaunch or new allowance`, async () => {
        const f = await providerSupervisorFixture(
          "daytona-burst",
          remote ? { nativeStack: true } : { localOnly: true },
        );
        fixtures.push(f);
        const target = remote ? 9 : 8;
        const persist = transfers.persistArtifactTransfer;
        let failed = false;
        vi.spyOn(transfers, "persistArtifactTransfer").mockImplementation(async (args) => {
          if (args.identity.workItem !== target || failed) return persist(args);
          failed = true;
          if (phase === "ready") {
            await persist(args);
            throw new Error("fixture: stop after exact ready publication");
          }
          const intercepted = new Proxy(args.store, {
            get(target, key) {
              if (key === "createBlob")
                return async () => {
                  throw new Error("fixture: first external transfer write unavailable");
                };
              const value: unknown = Reflect.get(target, key);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
          return persist({ ...args, store: intercepted });
        });
        await expect(f.run()).rejects.toThrow(/artifact transfer recovery/);
        expect(
          f.activity.filter((entry) => entry.operation === "launch" && entry.workItem === target),
        ).toHaveLength(1);
        if (remote)
          expect(
            f
              .events()
              .filter(
                (event) =>
                  event.kind === "budget" &&
                  event.event === "BudgetReserved" &&
                  event.workItem === target &&
                  event.phase === "validation",
              ),
          ).toHaveLength(1);
        await expect(f.run()).resolves.toMatchObject({ status: "completed" });
        expect(
          f.activity.filter((entry) => entry.operation === "launch" && entry.workItem === target),
        ).toHaveLength(1);
        expect(
          f
            .events()
            .filter(
              (event) =>
                event.kind === "budget" &&
                event.event === "BudgetReserved" &&
                event.workItem === target &&
                event.phase === "execution",
            ),
        ).toHaveLength(1);
        if (remote) {
          expect(
            f.activity.filter(
              (entry) =>
                entry.operation === "validate" && entry.workItem === target && !entry.invocation,
            ),
          ).toHaveLength(1);
          // Integrating the parent legitimately requires a new exact-head rebase
          // validation; it must not replay the original artifact invocation.
          const candidateValidations = f.activity.filter(
            (entry) =>
              entry.operation === "validate" && entry.workItem === target && entry.invocation,
          );
          expect(candidateValidations).toHaveLength(1);
          expect(new Set(candidateValidations.map((entry) => entry.invocation)).size).toBe(1);
          expect([...f.refs.keys()]).toContain(
            `refs/clockgrove-factory/native-rebases/objective-7/work-item-${target}/attempt-1/rebase-${candidateValidations[0]!.invocation}`,
          );
          const publication = f
            .events()
            .find(
              (event) =>
                event.kind === "publication" &&
                event.workItem === target &&
                event.event === "PublicationRecorded",
            );
          expect(publication).toMatchObject({ baseBranch: publicationBranch(7, 8, 1) });
        }
        expect(
          f
            .events()
            .some(
              (event) =>
                event.kind === "attempt" &&
                event.workItem === target &&
                ["AttemptFailed", "AttemptDeferred"].includes(event.event),
            ),
        ).toBe(false);
      }, 15_000);
    }
  }
  it("retains exact output before success receipts and backend cleanup", async () => {
    const f = await providerSupervisorFixture("daytona-burst", { localOnly: true });
    fixtures.push(f);
    const writer = vi.mocked(GitHubControlStore.prototype.addIssueComment);
    const original = writer.getMockImplementation()!;
    let collected = 0;
    writer.mockImplementation(async (node, body) => {
      for (const event of decodeEventComments(body)) {
        if (event.kind !== "attempt" || event.event !== "AttemptSucceeded") continue;
        collected += 1;
        expect(
          [...f.refs.keys()].some(
            (ref) =>
              ref.startsWith("refs/clockgrove-factory/artifact-transfers/") &&
              ref.endsWith("/ready"),
          ),
        ).toBe(true);
        expect(
          f.activity.some(
            (entry) => entry.operation === "cleanup" && entry.workItem === event.workItem,
          ),
        ).toBe(false);
      }
      await original(node, body);
    });
    await f.run();
    expect(collected).toBeGreaterThan(0);
  }, 15_000);

  it("stops resources and removes the workspace only after verifying independently retained bytes", async () => {
    const f = await providerSupervisorFixture("daytona-burst", { localOnly: true });
    fixtures.push(f);
    const create = worktrees.createLocalWorktree;
    vi.spyOn(worktrees, "createLocalWorktree").mockImplementation(async (...args) => {
      const worker = await create(...args);
      retained.push(worker);
      return worker;
    });
    const writer = vi.mocked(GitHubControlStore.prototype.createRef);
    const original = writer.getMockImplementation()!;
    writer.mockImplementation(async (ref, oid) => {
      if (ref.startsWith("refs/clockgrove-factory/artifact-transfers/") && ref.endsWith("/ready"))
        throw new Error("fixture: ready publication unavailable");
      return original(ref, oid);
    });
    await expect(f.run()).rejects.toThrow(/artifact transfer recovery/);
    expect(f.activity.filter((entry) => entry.operation === "launch")).toHaveLength(1);
    expect(f.resources.size).toBe(0);
    expect(
      f
        .events()
        .some((event) =>
          ["AttemptFailed", "AttemptDeferred", "FactoryRunCompleted"].includes(event.event),
        ),
    ).toBe(false);
    expect([...f.refs.keys()].some((ref) => ref.endsWith("/intent"))).toBe(true);
    expect(retained.length).toBe(1);
    await expect(access(retained[0]!.path)).rejects.toMatchObject({ code: "ENOENT" });
    // Restore only the failed transport. Reuse the original exact output and
    // reservation, then execute the remaining graph; never relaunch item 8.
    writer.mockImplementation(original);
    await expect(f.run()).resolves.toMatchObject({ status: "completed" });
    expect(
      f.activity.filter((entry) => entry.operation === "launch" && entry.workItem === 8),
    ).toHaveLength(1);
    expect(
      f
        .events()
        .filter(
          (event) =>
            event.kind === "budget" &&
            event.event === "BudgetReconciled" &&
            event.workItem === 8 &&
            event.unit === "local_milliseconds",
        ),
    ).toMatchObject([{ usageEvidence: "conservative-reservation" }]);
  }, 15_000);

  it("retains the owned workspace when collection copying fails before any independent recovery copy exists", async () => {
    const f = await providerSupervisorFixture("daytona-burst", { localOnly: true });
    fixtures.push(f);
    const create = worktrees.createLocalWorktree;
    vi.spyOn(worktrees, "createLocalWorktree").mockImplementation(async (...args) => {
      const worker = await create(...args);
      retained.push(worker);
      return worker;
    });
    vi.spyOn(transfers, "persistArtifactTransfer").mockRejectedValue(
      new Error("fixture: local retained-copy admission unavailable"),
    );
    await expect(f.run()).rejects.toThrow(/artifact transfer recovery/);
    expect(retained).toHaveLength(1);
    await expect(access(retained[0]!.path)).resolves.toBeUndefined();
    expect(f.activity.filter((entry) => entry.operation === "launch")).toHaveLength(1);
    expect([...f.refs.keys()].some((ref) => ref.includes("artifact-transfers"))).toBe(false);
    await expect(f.run()).rejects.toThrow(/completion is unknown after dispatch/);
    expect(f.activity.filter((entry) => entry.operation === "launch")).toHaveLength(1);
    await expect(access(retained[0]!.path)).resolves.toBeUndefined();
    expect(
      f
        .events()
        .some(
          (event) =>
            event.kind === "attempt" && ["AttemptFailed", "AttemptDeferred"].includes(event.event),
        ),
    ).toBe(false);
  });
});
