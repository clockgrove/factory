import { expect, it } from "vitest";
import { providerSupervisorFixture } from "./helpers/provider-supervisor.js";

it("foreground admission persists its Objective writer boundary and matching terminal", async () => {
  // Deliberately stop at validation: exercise admission and terminal ownership
  // without making this receipt regression a full integration qualification.
  const f = await providerSupervisorFixture("daytona-burst", {
    localOnly: true,
    validationFailure: true,
  });
  try {
    const result = await f.run();
    expect(result.status, result.reason).toBe("escalated");
    const events = f.events();
    const boundary = events.find((event) => event.event === "ControllerObserved");
    const terminal = events.find((event) => event.event === "FactoryRunEscalated");
    const admitted = events.find((event) => event.event === "AttemptReserved");
    expect(boundary).toMatchObject({ observationScope: "objective-writer", writerEpoch: 1 });
    expect(terminal).toMatchObject({ writerEpoch: boundary?.writerEpoch });
    expect(boundary!.sequence).toBeLessThan(admitted!.sequence);
  } finally {
    await f.dispose();
  }
}, 30_000);
