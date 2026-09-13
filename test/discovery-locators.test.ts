import { parseFactoryEvent } from "../src/protocol/events.js";
import { describe, expect, it } from "vitest";
import {
  discoveryLocatorRef,
  ensureDiscoveryLocator,
  parseDiscoveryLocatorRef,
  retireDiscoveryLocator,
  type DiscoveryLocatorScope,
} from "../src/control/discovery-locators.js";
import { FactoryApplicationService, type ApplicationSnapshot } from "../src/application/index.js";
import { decodeEventComments } from "../src/control/receipts.js";

const request = (requestId: string): DiscoveryLocatorScope => ({
  kind: "request",
  objective: 7,
  requestId,
});

function applicationFixture() {
  const current: ApplicationSnapshot = {
    id: "objective-node",
    number: 7,
    title: "Objective",
    defaultBranch: "main",
    workItems: [],
    factoryEvents: [],
  };
  const refs = new Map<string, string>();
  const service = new FactoryApplicationService({
    owner: "o",
    repo: "r",
    reader: { readObjective: async () => structuredClone(current) },
    store: {
      getAuthenticatedLogin: async () => "actor",
      serverTime: async () => new Date("2026-01-01T00:00:00Z"),
      ensureObjectiveLabel: async () => {},
      ensureDiscoveryLocator: async (scope) => {
        refs.set(discoveryLocatorRef(scope), "a".repeat(40));
      },
      retireDiscoveryLocator: async (scope) => {
        refs.delete(discoveryLocatorRef(scope));
      },
      addIssueComment: async (_id, body) => {
        current.factoryEvents!.push(...decodeEventComments(body));
      },
    },
  });
  return { current, refs, service };
}

describe("exact disposable discovery locators", () => {
  it("settles request A without deleting concurrently registered B or a new writer epoch", async () => {
    const refs = new Map<string, string>();
    const store = {
      readRef: async (ref: string) => refs.get(ref) ?? null,
      createRef: async (ref: string, oid: string) => {
        refs.set(ref, oid);
        return true;
      },
      deleteExactDiscoveryRef: async (ref: string) => {
        refs.delete(ref);
      },
    };
    const oldEpoch: DiscoveryLocatorScope = { kind: "run", objective: 7, runId: "run", epoch: 1 };
    const newEpoch: DiscoveryLocatorScope = { ...oldEpoch, epoch: 2 };
    for (const scope of [request("A"), request("B"), oldEpoch, newEpoch])
      await ensureDiscoveryLocator(store, scope, "a".repeat(40));
    await retireDiscoveryLocator(store, request("A"));
    await retireDiscoveryLocator(store, oldEpoch);
    expect([...refs.keys()]).toEqual([
      discoveryLocatorRef(request("B")),
      discoveryLocatorRef(newEpoch),
    ]);
    // Same-ID replay may restore a stale hint but cannot remove another scope.
    await ensureDiscoveryLocator(store, request("A"), "b".repeat(40));
    expect(refs.has(discoveryLocatorRef(request("B")))).toBe(true);
    expect(refs.has(discoveryLocatorRef(newEpoch))).toBe(true);
  });

  it("accepts only exact active namespace refs and never exposes request text", () => {
    const ref = discoveryLocatorRef(request("arbitrary/request/identity"));
    expect(parseDiscoveryLocatorRef(ref)).toEqual({ objective: 7 });
    expect(ref).not.toContain("arbitrary");
    expect(parseDiscoveryLocatorRef(`${ref}/child`)).toBeNull();
    expect(parseDiscoveryLocatorRef("refs/clockgrove-factory/objective-7/lease")).toBeNull();
    expect(
      parseDiscoveryLocatorRef(ref.replace("objective-7", "objective-9007199254740992")),
    ).toBeNull();
  });

  it("reconciles a competing create but never acknowledges absent registration", async () => {
    let reads = 0;
    const store = {
      readRef: async () => (++reads === 1 ? null : "a".repeat(40)),
      createRef: async () => false,
    };
    await ensureDiscoveryLocator(store, request("same"), "b".repeat(40));
    await expect(
      ensureDiscoveryLocator(
        { ...store, readRef: async () => null },
        request("missing"),
        "b".repeat(40),
      ),
    ).rejects.toThrow("registration is unresolved");
  });

  it("writes authenticated acceptance first and repairs registration before same-ID acknowledgement", async () => {
    const current: ApplicationSnapshot = {
      id: "objective-node",
      number: 7,
      title: "Objective",
      defaultBranch: "main",
      workItems: [],
      factoryEvents: [],
    };
    const order: string[] = [];
    let failLocator = true;
    const service = new FactoryApplicationService({
      owner: "o",
      repo: "r",
      reader: { readObjective: async () => structuredClone(current) },
      store: {
        getAuthenticatedLogin: async () => "actor",
        serverTime: async () => new Date("2026-01-01T00:00:00.000Z"),
        ensureObjectiveLabel: async () => {
          order.push("label");
        },
        ensureDiscoveryLocator: async (scope) => {
          order.push(`locator:${scope.kind}`);
          if (failLocator) {
            failLocator = false;
            throw new Error("response lost before locator");
          }
        },
        addIssueComment: async (_id, body) => {
          order.push("comment");
          current.factoryEvents!.push(...decodeEventComments(body));
        },
      },
    });
    const input = { objective: 7, requestId: "activation", baseSha: "a".repeat(40) };
    await expect(service.activate(input)).rejects.toThrow("response lost before locator");
    expect(order).toEqual(["comment", "locator:request"]);
    await expect(service.activate(input)).resolves.toMatchObject({ requestId: "activation" });
    expect(order).toEqual(["comment", "locator:request", "locator:request", "label"]);
    expect(current.factoryEvents).toHaveLength(1);
  });
  it("retires exact pre-start withdrawal and replay without erasing a later activation", async () => {
    const f = applicationFixture();
    const activation = { objective: 7, requestId: "activation-A", baseSha: "a".repeat(40) };
    await f.service.activate(activation);
    const withdrawal = { objective: 7, requestId: "withdraw-A" };
    await f.service.command("cancel", withdrawal);
    expect(f.refs.size).toBe(0);
    await f.service.activate({ ...activation, requestId: "activation-B" });
    await f.service.command("cancel", withdrawal);
    await f.service.activate(activation);
    expect([...f.refs.keys()]).toEqual([discoveryLocatorRef(request("activation-B"))]);
  });

  it("retire terminal request replay without certifying or deleting its unknown lifecycle", async () => {
    const f = applicationFixture();
    const input = { objective: 7, requestId: "activation", baseSha: "a".repeat(40) };
    const activation = await f.service.activate(input);
    if (activation.event !== "ActivationRequested") throw new Error("missing activation");
    f.current.factoryEvents!.push(
      parseFactoryEvent({
        protocol: activation.protocol,
        kind: "run",
        event: "FactoryRunStarted",
        objective: 7,
        runId: "run",
        sequence: 2,
        at: activation.at,
        actor: "actor",
        repository: "o/r",
        objectiveAuthor: "actor",
        fork: false,
        baseBranch: "main",
        policy: activation.policy,
        policyDigest: activation.policyDigest,
        activationRequestId: input.requestId,
        baseSha: input.baseSha,
      }),
      parseFactoryEvent({
        protocol: activation.protocol,
        kind: "run",
        event: "FactoryRunEscalated",
        objective: 7,
        runId: "run",
        sequence: 3,
        at: activation.at,
      }),
    );
    const runRef = discoveryLocatorRef({ kind: "run", objective: 7, runId: "run", epoch: 1 });
    f.refs.set(runRef, "a".repeat(40));
    await f.service.activate(input);
    expect([...f.refs.keys()]).toEqual([runRef]);
  });
});
