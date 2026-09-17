import { afterEach, describe, expect, it, vi } from "vitest";

import { assetDigest } from "../src/assets/contracts.js";
import { MediaAdapterRegistry, type MediaProducerAdapter } from "../src/media/adapter.js";
import { MediaExecutionPhaseError } from "../src/media/execution.js";
import { MediaProducerCapabilitySchema } from "../src/media/contracts.js";
import { parseFactoryEvent } from "../src/protocol/events.js";
import type { CompiledObjective } from "../src/graph.js";
import { providerSupervisorFixture } from "./helpers/provider-supervisor.js";

const capability = MediaProducerCapabilitySchema.parse({
  protocol: "clockgrove.factory/media-producer-capability-v1",
  id: "fixture/local-binary-v1",
  adapterVersion: "1",
  inputRoles: [],
  outputMediaTypes: ["application/octet-stream"],
  outputAuthority: { visibility: "private", rights: { basis: "unknown" } },
  intentRoles: ["implementation-reference"],
  purposes: ["implementation-reference"],
  profiles: [{ kind: "binary" }],
  models: ["fixture-deterministic"],
  qualities: ["fixture"],
  limits: { providerRequests: 0, variants: 1, generatedBytes: 1024, storageBytes: 1024 },
  network: { destinations: [], thirdPartyEgress: "denied" },
  recovery: {
    observation: true,
    idempotency: true,
    cancellation: true,
    resultCollection: "same-invocation",
  },
  nativeUsageKeys: [],
});

class CancelledOnTerminalAdapter implements MediaProducerAdapter {
  readonly capability = capability;
  readonly cancelled = new Set<string>();
  dispatches = 0;
  cancellations = 0;
  cleanups = 0;

  async probe() {
    return { available: true, authenticated: true };
  }

  async dispatch(request: Parameters<MediaProducerAdapter["dispatch"]>[0]) {
    this.dispatches += 1;
    return {
      invocationId: request.invocation.invocationId,
      providerRequestId: null,
      dispatchedAt: new Date().toISOString(),
    };
  }

  async observe(
    _request: Parameters<MediaProducerAdapter["observe"]>[0],
    handle: Parameters<MediaProducerAdapter["observe"]>[1],
  ) {
    return {
      state: this.cancelled.has(handle.invocationId)
        ? ("cancelled" as const)
        : ("running" as const),
      observedAt: new Date().toISOString(),
      providerResponseId: null,
      usage: [],
      output: { variants: 0, generatedBytes: 0, storageBytes: 0 },
    };
  }

  async collect(): Promise<never> {
    throw new Error("terminal recovery must cancel before collection");
  }

  async cancel(
    _request: Parameters<MediaProducerAdapter["cancel"]>[0],
    handle: Parameters<MediaProducerAdapter["cancel"]>[1],
  ) {
    this.cancellations += 1;
    this.cancelled.add(handle.invocationId);
  }

  async cleanup() {
    this.cleanups += 1;
  }
}

function graph(baseSha: string): CompiledObjective {
  return {
    title: "Restarted media terminal reconciliation",
    deferredCapabilityAdapters: [],
    workItems: [
      {
        id: "media",
        title: "Produce a private implementation reference",
        goal: "Produce one private opaque implementation reference.",
        acceptance: ["The exact media invocation is durably reconciled."],
        scope: [],
        preconditions: [],
        outOfScope: [],
        conventions: [],
        dependsOn: [],
        baseSha,
        validationCommands: [],
        requirements: {
          os: ["linux"],
          architecture: [],
          tools: [],
          services: [],
          networkDestinations: [],
          permittedSecretNames: [],
          trust: "trusted_local",
          estimatedDurationMinutes: 1,
        },
        assetInputs: [],
        deliverable: {
          kind: "asset-production",
          contract: "clockgrove.factory/asset-set",
          producerCapabilityId: capability.id,
          producerCapabilityDigest: assetDigest(capability),
          activationSelection: { minimumCount: 1, maximumCount: 1 },
          intent: {
            id: "implementation-reference",
            role: "implementation-reference",
            purpose: "implementation-reference",
            necessity: "required",
            obligationIds: ["durable-media-reconciliation"],
            rationale: "Exercise exact media lifecycle recovery after controller restart.",
            brief: "Produce one private opaque implementation reference.",
            fulfillment: { kind: "produced", inputRoleBindings: [] },
            output: {
              mediaTypes: ["application/octet-stream"],
              minimumCount: 1,
              maximumCount: 1,
              profile: null,
            },
            review: { kind: "human-required" },
            repositoryCapture: null,
            bindings: [],
          },
        },
      },
    ],
  };
}

function maximumSequence(fixture: { events(): Array<{ sequence: number }> }) {
  return Math.max(...fixture.events().map(({ sequence }) => sequence));
}

async function interruptedFixture() {
  const adapter = new CancelledOnTerminalAdapter();
  const registry = new MediaAdapterRegistry();
  registry.register(adapter);
  let interrupt = true;
  const fixture = await providerSupervisorFixture("daytona-burst", {
    localOnly: true,
    graphFactory: graph,
    mediaAdapterRegistry: registry,
    afterComment: (events) => {
      if (interrupt && events.some((event) => event.event === "MediaDispatchRecorded")) {
        interrupt = false;
        throw new Error("fixture controller stopped after durable media dispatch");
      }
    },
  });
  await expect(fixture.run()).rejects.toBeInstanceOf(MediaExecutionPhaseError);
  expect(adapter.dispatches).toBe(1);
  expect(fixture.events().some((event) => event.event === "MediaDispatchRecorded")).toBe(true);
  expect(fixture.events().some((event) => event.event === "MediaUsageSettled")).toBe(false);
  return { fixture, adapter };
}

afterEach(() => vi.restoreAllMocks());

describe("Supervisor restarted media terminal reconciliation", () => {
  it.each(["cancelled", "expired"] as const)(
    "reconciles a dispatched media attempt before an otherwise %s run becomes terminal without a provider gate",
    async (terminal) => {
      const { fixture, adapter } = await interruptedFixture();
      try {
        let result;
        if (terminal === "cancelled") {
          const stop = new AbortController();
          stop.abort(new Error("fixture operator cancellation"));
          result = await fixture.run(stop.signal);
        } else {
          const start = fixture.snapshot.factoryEvents!.find(
            (event) => event.event === "FactoryRunStarted",
          )!;
          fixture.snapshot.factoryEvents = fixture.snapshot.factoryEvents!.map((event) =>
            event === start
              ? parseFactoryEvent({
                  ...start,
                  at: new Date(Date.now() - 21 * 60_000).toISOString(),
                })
              : event,
          );
          result = await fixture.run();
        }
        expect(result).toMatchObject({
          status: terminal === "cancelled" ? "cancelled" : "escalated",
        });
        expect(adapter).toMatchObject({ dispatches: 1, cancellations: 1, cleanups: 1 });
        const events = fixture.events();
        const terminalSequence = events.find(
          (event) =>
            event.event ===
            (terminal === "cancelled" ? "FactoryRunCancelled" : "FactoryRunEscalated"),
        )!.sequence;
        for (const event of [
          "MediaUsageSettled",
          "MediaCleanupCompleted",
          terminal === "cancelled" ? "AttemptCancelled" : "AttemptTimedOut",
        ])
          expect(events.find((candidate) => candidate.event === event)!.sequence).toBeLessThan(
            terminalSequence,
          );
        expect(events.some((event) => event.event === "ProviderQuotaBlocked")).toBe(false);
      } finally {
        await fixture.dispose();
      }
    },
    30_000,
  );

  it("reconciles media by reservation identity before terminalizing beside an unrelated objective provider gate", async () => {
    const { fixture, adapter } = await interruptedFixture();
    const common = {
      protocol: "clockgrove.factory/v2" as const,
      objective: 7,
      runId: fixture.runId,
      at: new Date().toISOString(),
    };
    const sequence = maximumSequence(fixture) + 1;
    fixture.snapshot.factoryEvents!.push(
      parseFactoryEvent({
        ...common,
        kind: "provider",
        event: "ProviderQuotaBlocked",
        sequence,
        reasonCode: "provider-quota-exhausted",
        provider: "fixture-management",
        phase: "management",
        backend: "fixture-management",
        modelInvocationId: "unrelated-management-invocation",
        providerMessage: "unrelated management quota gate",
        accounting: "unknown",
      }),
    );
    const stop = new AbortController();
    stop.abort(new Error("fixture operator cancellation"));
    try {
      await expect(fixture.run(stop.signal)).resolves.toMatchObject({ status: "cancelled" });
      expect(adapter).toMatchObject({ dispatches: 1, cancellations: 1, cleanups: 1 });
      const events = fixture.events();
      const terminalSequence = events.find(
        (event) => event.event === "FactoryRunCancelled",
      )!.sequence;
      expect(events.find((event) => event.event === "MediaUsageSettled")!.sequence).toBeLessThan(
        terminalSequence,
      );
      expect(
        events.find((event) => event.event === "MediaCleanupCompleted")!.sequence,
      ).toBeLessThan(terminalSequence);
    } finally {
      await fixture.dispose();
    }
  }, 30_000);
});
