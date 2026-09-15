import { parseFactoryEvent } from "../src/protocol/events.js";
import { decodeEventComments } from "../src/control/receipts.js";
import { GitHubReader } from "../src/github.js";
import { describe, expect, it, vi } from "vitest";
import { GitHubControlStore } from "../src/control/github-store.js";
import {
  DISCOVERY_LOCATOR_PREFIX,
  discoveryLocatorRef,
  parseDiscoveryLocatorRef,
} from "../src/control/discovery-locators.js";
import { unresolvedModelInvocations } from "../src/control/budget.js";
import { providerSupervisorFixture } from "./helpers/provider-supervisor.js";

type Fixture = Awaited<ReturnType<typeof providerSupervisorFixture>>;
const locators = (f: Fixture) =>
  [...f.refs.keys()].filter((ref) => ref.startsWith(DISCOVERY_LOCATOR_PREFIX));

describe("Supervisor exact lifecycle discovery", () => {
  it("registers before execution and late review, then retires only disposable refs after known settlement", async () => {
    let f: Fixture;
    let launchRegistered = false;
    let reviewRegistered = false;
    f = await providerSupervisorFixture("daytona-burst", {
      localOnly: true,
      dependencyChain: true,
      configureLocalBackend: (backend) => ({
        ...backend,
        launch: async (...args) => {
          launchRegistered = locators(f).length > 0;
          expect(launchRegistered).toBe(true);
          return backend.launch(...args);
        },
      }),
    });
    const originalReview = f.management.review;
    f.management.review = async (...args) => {
      reviewRegistered = locators(f).length > 0;
      expect(reviewRegistered).toBe(true);
      return originalReview(...args);
    };
    try {
      expect(await f.run()).toMatchObject({ status: "completed" });
      expect(launchRegistered).toBe(true);
      expect(reviewRegistered).toBe(true);
      expect(locators(f)).toEqual([]);
      expect(unresolvedModelInvocations(f.events())).toEqual([]);
      expect(f.resources.size).toBe(0);
      expect([...f.refs.keys()].some((ref) => !parseDiscoveryLocatorRef(ref))).toBe(true);
    } finally {
      await f.dispose();
    }
  });

  it("retains externally closed compilation unknown usage before the first worker claim", async () => {
    const f = await providerSupervisorFixture("daytona-burst", { localOnly: true });
    // Start a pristine foreground Objective: no activation or compiled graph is
    // available as a discovery backstop before the management invocation.
    f.refs.clear();
    f.snapshot.workItems = [];
    f.snapshot.factoryEvents = [];
    vi.spyOn(GitHubReader.prototype, "readRepositoryLayout").mockResolvedValue({
      defaultBranch: "main",
      files: ["README.md"],
      totalFiles: 1,
      truncated: false,
      treeTruncatedByGitHub: false,
    });
    let compilationReached = false;
    f.management.proposePlan = async () => {
      compilationReached = true;
      expect(locators(f).length).toBeGreaterThan(0);
      expect(f.resources.size).toBe(0);
      f.snapshot.closed = true;
      throw new Error("simulated compiler process loss with unknown actual usage");
    };
    try {
      await f.run().catch(() => undefined);
      expect(compilationReached).toBe(true);
      expect(
        unresolvedModelInvocations(f.events()).some(
          (event) => event.phase === "management" && event.workItem === undefined,
        ),
      ).toBe(true);
      expect(locators(f).length).toBeGreaterThan(0);
      expect(f.activity.filter((entry) => entry.operation === "launch")).toEqual([]);
    } finally {
      await f.dispose();
    }
  });

  it("preserves a completed outcome when disposable locator retirement fails", async () => {
    const f = await providerSupervisorFixture("daytona-burst", {
      localOnly: true,
      dependencyChain: true,
    });
    vi.spyOn(GitHubControlStore.prototype, "deleteExactDiscoveryRef").mockRejectedValue(
      new Error("simulated discovery DELETE outage"),
    );
    try {
      expect(await f.run()).toMatchObject({ status: "completed" });
      expect(locators(f).length).toBeGreaterThan(0);
      expect(f.events().filter((event) => event.event === "FactoryRunEscalated")).toEqual([]);
      expect(
        f.notifications.some((message) => message.includes("retirement could not be confirmed")),
      ).toBe(true);
      expect(f.resources.size).toBe(0);
    } finally {
      await f.dispose();
    }
  });

  it("retains late review unknown usage after worker resources have gone", async () => {
    const f = await providerSupervisorFixture("daytona-burst", {
      localOnly: true,
      dependencyChain: true,
    });
    let reviewReached = false;
    f.management.review = async () => {
      reviewReached = true;
      expect(locators(f).length).toBeGreaterThan(0);
      expect(f.resources.size).toBe(0);
      throw new Error("simulated review response and actual usage unavailable");
    };
    try {
      await f.run().catch(() => undefined);
      expect(reviewReached).toBe(true);
      expect(
        unresolvedModelInvocations(f.events()).some((event) => event.phase === "management"),
      ).toBe(true);
      expect(locators(f).length).toBeGreaterThan(0);
      expect(f.resources.size).toBe(0);
    } finally {
      await f.dispose();
    }
  });

  it.each([false, true])(
    "retires an acknowledged pause without retiring its live generation (retry=%s)",
    async (failFirstDelete) => {
      const f = await providerSupervisorFixture("daytona-burst", {
        localOnly: true,
        controllerActivation: true,
      });
      const pause = parseFactoryEvent({
        protocol: "clockgrove.factory/v2",
        kind: "run",
        event: "RunPauseRequested",
        objective: 7,
        runId: f.runId,
        sequence: Math.max(...f.events().map((event) => event.sequence)) + 1,
        at: new Date().toISOString(),
        requestedBy: "operator",
        requestId: "pause-now",
      });
      f.snapshot.factoryEvents!.push(pause);
      const pauseRef = discoveryLocatorRef({
        kind: "request",
        objective: 7,
        requestId: "pause-now",
      });
      f.refs.set(pauseRef, f.baseSha);
      const remove = vi
        .mocked(GitHubControlStore.prototype.deleteExactDiscoveryRef)
        .getMockImplementation()!;
      let observed = false;
      let deletionFailed = false;
      vi.mocked(GitHubControlStore.prototype.deleteExactDiscoveryRef).mockImplementation(
        async function (this: GitHubControlStore, ref) {
          if (ref === pauseRef && !observed) {
            expect(f.events().some((event) => event.event === "RunPauseAcknowledged")).toBe(true);
            expect(locators(f).some((entry) => entry.includes("/run-"))).toBe(true);
            if (failFirstDelete && !deletionFailed) {
              deletionFailed = true;
              throw new Error("simulated disposable-ref deletion failure");
            }
            observed = true;
            f.snapshot.factoryEvents!.push(
              parseFactoryEvent({
                ...pause,
                event: "RunResumeRequested",
                requestId: "resume-next",
                sequence: Math.max(...f.events().map((event) => event.sequence)) + 1,
              }),
            );
            f.refs.set(
              discoveryLocatorRef({ kind: "request", objective: 7, requestId: "resume-next" }),
              f.baseSha,
            );
          }
          await remove.call(this, ref);
        },
      );
      try {
        expect(await f.run()).toMatchObject({ status: "completed" });
        expect(observed).toBe(true);
        expect(deletionFailed).toBe(failFirstDelete);
        expect(f.events().filter((event) => event.event === "RunPauseAcknowledged")).toHaveLength(
          1,
        );
        expect(locators(f)).toEqual([]);
        expect(f.resources.size).toBe(0);
      } finally {
        await f.dispose();
      }
    },
  );

  it("retires a drained generation without losing a resume accepted after its acknowledgement", async () => {
    const f = await providerSupervisorFixture("daytona-burst", {
      localOnly: true,
      controllerActivation: true,
    });
    const drain = parseFactoryEvent({
      protocol: "clockgrove.factory/v2",
      kind: "run",
      event: "RunDrainRequested",
      objective: 7,
      runId: f.runId,
      sequence: Math.max(...f.events().map((event) => event.sequence)) + 1,
      at: new Date().toISOString(),
      requestedBy: "operator",
      requestId: "drain-now",
    });
    f.snapshot.factoryEvents!.push(drain);
    const drainRef = discoveryLocatorRef({ kind: "request", objective: 7, requestId: "drain-now" });
    const resumeRef = discoveryLocatorRef({
      kind: "request",
      objective: 7,
      requestId: "resume-next",
    });
    f.refs.set(drainRef, f.baseSha);
    const write = vi.mocked(GitHubControlStore.prototype.addIssueComment).getMockImplementation()!;
    vi.mocked(GitHubControlStore.prototype.addIssueComment).mockImplementation(async function (
      this: GitHubControlStore,
      node,
      body,
    ) {
      await write.call(this, node, body);
      if (decodeEventComments(body).some((event) => event.event === "RunDrainCompleted")) {
        f.snapshot.factoryEvents!.push(
          parseFactoryEvent({
            ...drain,
            event: "RunResumeRequested",
            requestId: "resume-next",
            sequence: Math.max(...f.events().map((event) => event.sequence)) + 1,
          }),
        );
        f.refs.set(resumeRef, f.baseSha);
      }
    });
    try {
      expect(await f.run()).toMatchObject({ status: "drained" });
      expect(f.refs.has(drainRef)).toBe(false);
      expect(f.refs.has(resumeRef)).toBe(true);
      expect(locators(f).filter((ref) => ref.includes("/run-"))).toEqual([]);
      expect(f.activity.filter((entry) => entry.operation === "launch")).toEqual([]);
    } finally {
      await f.dispose();
    }
  });

  it("retains externally closed lifecycle even when terminal output is recorded", async () => {
    const f = await providerSupervisorFixture("daytona-burst", { localOnly: true });
    f.snapshot.closed = true;
    try {
      expect(await f.run()).toMatchObject({ status: "escalated" });
      expect(locators(f).length).toBeGreaterThan(0);
      expect(
        f.activity.filter((entry) => entry.operation === "launch" || entry.operation === "review"),
      ).toEqual([]);
    } finally {
      await f.dispose();
    }
  });

  it("retires a fresh generation refused before any run start or resource effect", async () => {
    const f = await providerSupervisorFixture("daytona-burst", { localOnly: true });
    f.refs.clear();
    f.snapshot.workItems = [];
    f.snapshot.factoryEvents = [];
    f.policy.economics!.modelTokenBudgetMode = "hard";
    try {
      await expect(f.run()).rejects.toThrow("hard is unsupported");
      expect(locators(f)).toEqual([]);
      expect(f.activity).toEqual([]);
      expect(f.events().some((event) => event.event === "FactoryRunStarted")).toBe(false);
    } finally {
      await f.dispose();
    }
  });

  it("blocks model/resource effects when generation registration cannot be confirmed", async () => {
    const f = await providerSupervisorFixture("daytona-burst", { localOnly: true });
    vi.spyOn(GitHubControlStore.prototype, "ensureDiscoveryLocator").mockRejectedValue(
      new Error("locator transport unavailable"),
    );
    try {
      await expect(f.run()).rejects.toThrow("locator transport unavailable");
      expect(
        f.activity.filter((entry) => entry.operation === "launch" || entry.operation === "review"),
      ).toEqual([]);
      expect(f.resources.size).toBe(0);
    } finally {
      await f.dispose();
    }
  });
});
