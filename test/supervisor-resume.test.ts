import { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { GitHubControlStore } from "../src/control/github-store.js";
import { IssueAdmissionLedger } from "../src/control/issue-admission.js";
import { LeaseManager } from "../src/control/lease.js";
import { PlatformUnavailableError } from "../src/platform.js";
import { providerSupervisorFixture } from "./helpers/provider-supervisor.js";

describe("same-run controller restart after integration", () => {
  it.each(["before", "after"] as const)(
    "repairs a lost ordinary integration receipt %s the comment commits",
    async (loss) => {
      const f = await providerSupervisorFixture("daytona-burst", {
        controllerActivation: true,
        localOnly: true,
        dependencyChain: true,
        loseIntegrationReceipt: loss,
      });
      try {
        await expect(f.run()).rejects.toBeInstanceOf(PlatformUnavailableError);
        expect(f.snapshot.workItems[0]!.closed).toBe(true);
        expect(f.snapshot.workItems[0]!.linkedPullRequests[0]!.state).toBe("MERGED");
        expect(f.events().filter((event) => event.event === "AttemptIntegrated")).toHaveLength(
          loss === "before" ? 0 : 1,
        );
        const firstReviews = f.activity.filter(
          (entry) => entry.operation === "review" && entry.workItem === 8,
        );
        expect(firstReviews).toHaveLength(1);
        const firstBudget = f
          .events()
          .filter((event) => event.kind === "budget" && event.workItem === 8);
        const resumed = await f.run();
        expect(resumed, resumed.reason).toMatchObject({
          status: "completed",
          runId: f.runId,
        });
        expect(
          f.events().filter((event) => event.event === "AttemptIntegrated" && event.workItem === 8),
        ).toHaveLength(1);
        if (loss === "before")
          expect(
            f.events().find((event) => event.event === "AttemptIntegrated" && event.workItem === 8),
          ).toMatchObject({ directorEpoch: 1, recoveryEpoch: 2 });
        expect(
          f.events().filter((event) => event.kind === "budget" && event.workItem === 8),
        ).toEqual(firstBudget);
        expect(
          f.activity.filter((entry) => entry.operation === "launch").map((entry) => entry.workItem),
        ).toEqual([8, 9, 10]);
        expect(
          f.activity.filter((entry) => entry.operation === "review" && entry.workItem === 8),
        ).toEqual(firstReviews);
        expect(f.resources.size).toBe(0);
      } finally {
        await f.dispose();
      }
    },
    30_000,
  );

  it("does not repair a completed ordinary merge without its original acceptance checkpoint", async () => {
    const f = await providerSupervisorFixture("daytona-burst", {
      controllerActivation: true,
      localOnly: true,
      dependencyChain: true,
      loseIntegrationReceipt: "before",
    });
    try {
      await expect(f.run()).rejects.toBeInstanceOf(PlatformUnavailableError);
      const reviewRefs = [...f.refs.keys()].filter((ref) => ref.includes("/reviews/"));
      expect(reviewRefs).toHaveLength(1);
      f.refs.delete(reviewRefs[0]!);
      const invocations = [...f.activity];
      const publications = f.events().filter((event) => event.event === "PublicationRecorded");
      const result = await f.run();
      expect(result).toMatchObject({
        status: "escalated",
        reason: "completed ordinary integration lacks its original acceptance checkpoint",
      });
      expect(f.events().filter((event) => event.event === "AttemptIntegrated")).toHaveLength(0);
      expect(f.events().filter((event) => event.event === "PublicationRecorded")).toEqual(
        publications,
      );
      expect(f.activity).toEqual(invocations);
      expect(f.snapshot.workItems[0]!.linkedPullRequests[0]!.state).toBe("MERGED");
    } finally {
      await f.dispose();
    }
  }, 30_000);

  it.each([false, true])(
    "recovers an overlapping intent only with durable non-dispatch proof (dispatch possible: %s)",
    async (dispatchPossible) => {
      const f = await providerSupervisorFixture("daytona-burst", {
        controllerActivation: true,
        localOnly: true,
        loseIntegrationReceipt: "before",
      });
      try {
        await expect(f.run()).rejects.toBeInstanceOf(PlatformUnavailableError);
        expect(
          f.events().some((event) => event.event === "BudgetReserved" && event.workItem === 9),
        ).toBe(true);
        expect(
          f.events().some((event) => event.event === "AttemptStarted" && event.workItem === 9),
        ).toBe(false);
        const launches = f.activity.filter((entry) => entry.operation === "launch");
        const ledger = new IssueAdmissionLedger(
          new GitHubControlStore({
            token: "fixture-only",
            owner: "fixture",
            repo: "provider-qualification",
          }),
        );
        const original = (await ledger.read(9))?.history[0];
        expect(original).toMatchObject({ disposition: "prepared", dispatchPossible: false });
        if (!original) throw new Error("fixture omitted the original admission");
        const originalBudget = f
          .events()
          .filter((event) => event.kind === "budget" && event.workItem === 9);
        if (!dispatchPossible) {
          expect(await f.run()).toMatchObject({ status: "completed", runId: f.runId });
          const history = (await ledger.read(9))!.history;
          expect(history).toHaveLength(2);
          expect(history[0]).toMatchObject({
            reservation: original.reservation,
            disposition: "released",
            dispatchPossible: false,
            evidence: {
              accountingSettled: true,
              capacityReleased: true,
              producerStopped: true,
              resourcesReleased: true,
            },
          });
          expect(history[1]!.reservation.attempt).toBeGreaterThan(original.reservation.attempt);
          expect(
            f
              .events()
              .some(
                (event) =>
                  event.event === "AttemptStarted" &&
                  event.workItem === 9 &&
                  event.attempt === original.reservation.attempt,
              ),
          ).toBe(false);
          expect(
            f
              .events()
              .filter(
                (event) =>
                  event.event === "BudgetReconciled" &&
                  event.workItem === 9 &&
                  event.attempt === original.reservation.attempt,
              ),
          ).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                amount: 0,
                reason: "issue CAS permanently excluded dispatch of this original worker intent",
              }),
            ]),
          );
          for (const workItem of [8, 9, 10])
            expect(
              f.activity.filter(
                (entry) => entry.operation === "launch" && entry.workItem === workItem,
              ),
            ).toHaveLength(1);
          expect(f.resources.size).toBe(0);
          return;
        }
        // A committed write-ahead dispatch marker cannot be cleared merely because
        // no AttemptStarted receipt or provider completion survived the outage.
        await ledger.transition({
          workItem: 9,
          reservationOid: original.reservation.oid,
          objective: original.objective,
          runId: original.runId,
          directorEpoch: original.writerEpoch,
          writerHolder: original.currentWriterHolder,
          policyDigest: original.policyDigest,
          disposition: "dispatching",
          assertCurrent: async () => {},
        });
        await expect(f.run()).rejects.toThrow("execution completion is unknown after dispatch");
        expect(f.activity.filter((entry) => entry.operation === "launch")).toEqual(launches);
        expect((await ledger.read(9))!.history).toEqual([
          expect.objectContaining({
            disposition: "dispatching",
            dispatchPossible: true,
            reservation: original.reservation,
          }),
        ]);
        expect(
          f.events().filter((event) => event.kind === "budget" && event.workItem === 9),
        ).toEqual(originalBudget);
        expect(
          f
            .events()
            .some((event) =>
              ["FactoryRunCompleted", "FactoryRunEscalated", "FactoryRunCancelled"].includes(
                event.event,
              ),
            ),
        ).toBe(false);
        expect(
          f
            .events()
            .some(
              (event) =>
                event.workItem === 9 && ["AttemptFailed", "AttemptDeferred"].includes(event.event),
            ),
        ).toBe(false);
      } finally {
        await f.dispose();
      }
    },
    30_000,
  );

  it("reconstructs a chain including accepted sibling candidate integration after restart", async () => {
    const shutdown = new AbortController();
    let integrations = 0;
    const f = await providerSupervisorFixture("daytona-burst", {
      controllerActivation: true,
      afterIntegration: () => {
        if (++integrations === 2) shutdown.abort();
      },
    });
    try {
      expect(await f.run(shutdown.signal)).toMatchObject({ status: "cancelled" });
      expect(f.events().filter((event) => event.event === "AttemptIntegrated")).toHaveLength(2);
      expect(f.activity.filter((entry) => entry.operation === "candidate-review")).toHaveLength(1);
      const resumed = await f.run();
      expect(resumed, resumed.reason).toMatchObject({
        status: "completed",
        runId: f.runId,
      });
      expect(
        f.activity
          .filter((entry) => entry.operation === "launch")
          .map((entry) => entry.workItem)
          .sort((a, b) => a - b),
      ).toEqual([8, 9, 10]);
      expect(f.activity.filter((entry) => entry.operation === "candidate-review")).toHaveLength(1);
      expect(f.resources.size).toBe(0);
    } finally {
      await f.dispose();
    }
  }, 30_000);

  it.each(["validation", "acceptance", "reservation", "lease-race"])(
    "rejects resumed execution when %s evidence changes",
    async (fault) => {
      const shutdown = new AbortController();
      const f = await providerSupervisorFixture("daytona-burst", {
        controllerActivation: true,
        localOnly: true,
        afterIntegration: () => shutdown.abort(),
      });
      try {
        expect(await f.run(shutdown.signal)).toMatchObject({ status: "cancelled" });
        const item = f.snapshot.workItems[0]!;
        if (fault === "validation" || fault === "acceptance")
          item.factoryEvents = item.factoryEvents!.filter(
            (event) =>
              event.event !== (fault === "validation" ? "ValidationRecorded" : "AttemptValidated"),
          );
        if (fault === "reservation") {
          const ref = [...f.refs.keys()].find(
            (ref) => ref === "refs/clockgrove-factory/admission/work-item-8",
          );
          expect(ref).toBeDefined();
          f.refs.delete(ref!);
        }
        if (fault === "lease-race") {
          const acquire = vi.mocked(LeaseManager.prototype.acquire).getMockImplementation()!;
          vi.mocked(LeaseManager.prototype.acquire).mockImplementation(async function (
            this: LeaseManager,
            ...args
          ) {
            const lease = await acquire.apply(this, args);
            execFileSync(
              "git",
              ["commit", "--allow-empty", "-qm", "external advance during acquisition"],
              { cwd: f.repository },
            );
            return lease;
          });
        }
        const before = f.events();
        const launches = f.activity.filter((entry) => entry.operation === "launch").length;
        if (fault === "lease-race")
          await expect(f.run()).rejects.toThrow(
            "base branch advanced outside this run during startup",
          );
        else expect(await f.run()).toMatchObject({ status: "escalated", runId: "not-started" });
        expect(f.events()).toEqual(before);
        expect(f.activity.filter((entry) => entry.operation === "launch")).toHaveLength(launches);
      } finally {
        await f.dispose();
      }
    },
    30_000,
  );

  it.each([false, true])(
    "resumes own merges while rejecting external trunk progress (%s)",
    async (external) => {
      const shutdown = new AbortController();
      const f = await providerSupervisorFixture("daytona-burst", {
        controllerActivation: true,
        localOnly: true,
        afterIntegration: () => shutdown.abort(),
      });
      try {
        const first = await f.run(shutdown.signal);
        const sibling = f.events().filter((event) => "workItem" in event && event.workItem === 9);
        expect(
          sibling.filter(
            (event) =>
              event.kind === "attempt" &&
              ["AttemptCancelled", "AttemptFailed", "AttemptDeferred"].includes(event.event),
          ),
        ).toEqual([]);
        expect(sibling.filter((event) => event.event === "AttemptSucceeded")).toHaveLength(1);
        expect(sibling.some((event) => event.kind === "capacity")).toBe(false);
        const originalWorkerUsage = sibling.filter(
          (event) =>
            event.kind === "budget" &&
            event.event === "BudgetReconciled" &&
            event.phase === "execution",
        );
        expect(originalWorkerUsage).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ unit: "model_tokens", amount: 6 }),
            expect.objectContaining({ unit: "local_milliseconds", amount: expect.any(Number) }),
          ]),
        );
        expect(originalWorkerUsage).toHaveLength(2);
        const ready = [...f.refs].filter(
          ([ref]) => ref.includes("/artifact-transfers/") && ref.endsWith("/ready"),
        );
        expect(ready).toHaveLength(2);
        expect(first).toMatchObject({
          status: "cancelled",
          reason: "repository controller stopped; durable run remains active",
        });
        expect(f.events().filter((event) => event.event === "AttemptIntegrated")).toHaveLength(1);
        expect(f.events().filter((event) => event.event === "FactoryRunStarted")).toHaveLength(1);
        expect(
          f
            .events()
            .some((event) =>
              ["FactoryRunCompleted", "FactoryRunEscalated", "FactoryRunCancelled"].includes(
                event.event,
              ),
            ),
        ).toBe(false);
        if (external)
          execFileSync("git", ["commit", "--allow-empty", "-qm", "external trunk advance"], {
            cwd: f.repository,
          });
        const launches = f.activity.filter((entry) => entry.operation === "launch").length;
        const resumed = await f.run();
        for (const event of sibling) expect(f.events()).toContainEqual(event);
        for (const [ref, oid] of ready) expect(f.refs.get(ref)).toBe(oid);
        expect(
          f
            .events()
            .filter(
              (event) =>
                event.kind === "budget" &&
                event.workItem === 9 &&
                event.event === "BudgetReconciled" &&
                event.phase === "execution",
            ),
        ).toEqual(originalWorkerUsage);
        if (external) {
          expect(resumed).toMatchObject({ status: "escalated", runId: "not-started" });
          expect(f.activity.filter((entry) => entry.operation === "launch")).toHaveLength(launches);
        } else {
          expect(resumed, resumed.reason).toMatchObject({
            status: "completed",
            runId: first.runId,
          });
          expect(
            f.activity
              .filter((entry) => entry.operation === "launch")
              .map((entry) => entry.workItem),
          ).toEqual([8, 9, 10]);
          expect(f.events().filter((event) => event.event === "FactoryRunStarted")).toHaveLength(1);
          expect(f.resources.size).toBe(0);
          expect(
            f
              .events()
              .filter((event) => event.event === "ControllerObserved")
              .map((event) => event.controllerId),
          ).toEqual(["fixture-controller-1", "fixture-controller-2"]);
        }
      } finally {
        await f.dispose();
      }
    },
    30_000,
  );
});
