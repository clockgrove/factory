import { expect, it } from "vitest";
import { DAYTONA, providerSupervisorFixture } from "./helpers/provider-supervisor.js";

it("executes a cloud child on its parent PR, then validates its rewritten head in a fresh sandbox before merge", async () => {
  const fixture = await providerSupervisorFixture("daytona-burst", { nativeStack: true });
  try {
    const result = await fixture.run();
    expect(result).toMatchObject({ status: "completed" });
    expect(fixture.activity.filter((entry) => entry.operation === "launch")).toEqual([
      expect.objectContaining({ workItem: 8 }),
      expect.objectContaining({ workItem: 9, backend: DAYTONA }),
      expect.objectContaining({ workItem: 10 }),
    ]);
    expect(
      fixture.activity.filter((entry) => entry.operation === "validate" && entry.invocation),
    ).toHaveLength(1);
    expect([...fixture.refs.keys()].filter((ref) => ref.includes("/native-rebases/"))).toHaveLength(
      1,
    );
    const events = fixture.events();
    const childPublications = events.filter(
      (event) =>
        event.kind === "publication" &&
        event.event === "PublicationRecorded" &&
        event.workItem === 9,
    );
    expect(childPublications).toHaveLength(2);
    expect(childPublications[0]).toMatchObject({ parentItemId: "a", mode: "native-stacks" });
    expect(childPublications[1]).toMatchObject({
      parentItemId: "a",
      mode: "native-stacks",
      baseBranch: "main",
    });
    expect(fixture.resources.size).toBe(0);
  } finally {
    await fixture.dispose();
  }
}, 30000);
