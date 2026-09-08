import { expect, it } from "vitest";
import { providerSupervisorFixture } from "./helpers/provider-supervisor.js";
import { GitHubControlStore } from "../src/control/github-store.js";

it.each([true, false])(
  "foreground admission persists writer authority through executionFailure=%s",
  async (executionFailure) => {
    // Exercise both a provider-confirmed failed execution and ordinary completion.
    const f = await providerSupervisorFixture("daytona-burst", {
      localOnly: true,
      ...(executionFailure
        ? {
            configureLocalBackend: (backend) => ({
              ...backend,
              observe: async (handle) => ({
                ...(await backend.observe(handle)),
                state: "failed",
                reason: "intentional writer-boundary execution failure",
              }),
            }),
          }
        : {}),
    });
    try {
      const result = await f.run();
      expect(result.status, result.reason).toBe(executionFailure ? "escalated" : "completed");
      const events = f.events();
      const boundary = events.find((event) => event.event === "ControllerObserved");
      const terminal = events.find(
        (event) =>
          event.event === (executionFailure ? "FactoryRunEscalated" : "FactoryRunCompleted"),
      );
      const admitted = events.find((event) => event.event === "AttemptReserved");
      expect(boundary).toMatchObject({ observationScope: "objective-writer", writerEpoch: 1 });
      expect(terminal).toMatchObject({ writerEpoch: boundary?.writerEpoch });
      expect(boundary!.sequence).toBeLessThan(admitted!.sequence);
      if (!executionFailure) {
        const claim = [...f.refs.entries()].find(([ref]) =>
          ref.startsWith("refs/clockgrove-factory/integration-admissions/"),
        );
        expect(claim).toBeDefined();
        const [ref, oid] = claim!;
        expect(
          await GitHubControlStore.prototype.compareAndSwapRef({
            ref,
            beforeOid: "0".repeat(40),
            afterOid: oid,
          }),
        ).toBe(false);
        expect(f.refs.get(ref)).toBe(oid);
        await expect(
          GitHubControlStore.prototype.compareAndSwapRef({ ref, beforeOid: oid, afterOid: oid }),
        ).rejects.toThrow("exact observed OID");
        expect(f.refs.get(ref)).toBe(oid);
      }
    } finally {
      await f.dispose();
    }
  },
  30_000,
);
