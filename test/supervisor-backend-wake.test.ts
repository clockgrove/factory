import { expect, it, vi } from "vitest";
import * as terminalWake from "../src/execution/terminal-wake.js";
import { providerSupervisorFixture } from "./helpers/provider-supervisor.js";

it.each([false, true])(
  "observes a local terminal hint promptly; completion during observation=%s",
  async (duringObservation) => {
    const shutdown = new AbortController();
    let complete = false;
    let publishedAt = 0;
    let collectedAt = 0;
    let observations = 0;
    let waiting = false;
    let finish!: () => void;
    const terminal = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const publish = () => {
      publishedAt = Date.now();
      complete = true;
      finish();
    };
    const makeWake = terminalWake.createBackendObservationWake;
    vi.spyOn(terminalWake, "createBackendObservationWake").mockImplementation((...args) => {
      const wake = makeWake(...args);
      return {
        get revision() {
          return wake.revision;
        },
        waitForChange: (...waitArgs) => {
          waiting = true;
          return wake.waitForChange(...waitArgs).finally(() => {
            waiting = false;
          });
        },
        dispose: () => wake.dispose(),
      };
    });
    const f = await providerSupervisorFixture("daytona-burst", {
      localOnly: true,
      configureLocalBackend: (backend) => ({
        ...backend,
        waitForTerminal: () => terminal,
        observe: async (handle) => {
          observations++;
          if (complete || shutdown.signal.aborted) return backend.observe(handle);
          // Return the already-captured nonterminal state even if the hint arrives
          // before observe resolves; the Supervisor must retain that wake revision.
          if (duringObservation) publish();
          return { state: "running", observedAt: new Date().toISOString() };
        },
        collect: async (handle) => {
          collectedAt ||= Date.now();
          return backend.collect(handle);
        },
      }),
    });
    const running = f.run(shutdown.signal, 60_000);
    try {
      if (!duringObservation) {
        // Observe an actual registered backend wait after the initial probe's
        // microtasks settle, rather than completing before the loop sleeps.
        await vi.waitFor(() => expect(waiting && observations >= 1).toBe(true), {
          timeout: 8_000,
          interval: 10,
        });
        publish();
      }
      await vi.waitFor(() => expect(collectedAt).toBeGreaterThan(0), {
        timeout: duringObservation ? 8_000 : 1_000,
        interval: 10,
      });
      expect(observations).toBeGreaterThanOrEqual(2);
      expect(collectedAt - publishedAt).toBeLessThan(1_000);
      await expect(running).resolves.toMatchObject({ status: "completed" });
      const usage = f
        .events()
        .filter(
          (event) =>
            event.kind === "budget" &&
            event.event === "BudgetReconciled" &&
            event.phase === "execution" &&
            event.unit === "model_tokens",
        );
      expect(usage.length).toBeGreaterThan(0);
      expect(usage).toEqual(expect.arrayContaining([expect.objectContaining({ amount: 6 })]));
      expect(f.resources.size).toBe(0);
      expect(f.activity.filter((entry) => entry.operation === "cleanup").length).toBeGreaterThan(0);
    } finally {
      shutdown.abort();
      finish();
      await running.catch(() => {});
      await f.dispose();
      vi.restoreAllMocks();
    }
  },
  20_000,
);
