import { expect, it, vi } from "vitest";
import { GitHubReader } from "../src/github.js";
import { GitHubControlStore } from "../src/control/github-store.js";
import { providerSupervisorFixture } from "./helpers/provider-supervisor.js";

it("rechecks a stale publication snapshot after pending sibling checks without emitting another receipt", async () => {
  const f = await providerSupervisorFixture("daytona-burst", {
    configureLocalBackend: (backend) => ({
      ...backend,
      observe: async (handle) => {
        const observed = await backend.observe(handle);
        // This scenario needs both finished roots waiting on checks; the normal
        // provider fixture intentionally holds local completion until cloud merge.
        return f.activity.some((entry) => entry.operation === "launch" && entry.workItem === 9)
          ? { ...observed, state: "succeeded" as const }
          : observed;
      },
    }),
  });
  const read = vi.mocked(GitHubReader.prototype.readObjective).getMockImplementation()!;
  const pull = vi.mocked(GitHubControlStore.prototype.readPullRequest).getMockImplementation()!;
  let stale = false;
  const pending = new Set<number>();
  vi.mocked(GitHubReader.prototype.readObjective).mockImplementation(async function (
    this: GitHubReader,
    ...args
  ) {
    const snapshot = await read.apply(this, args);
    if (
      !stale &&
      snapshot.workItems
        .slice(0, 2)
        .every(
          (item) =>
            item.factoryEvents?.some((event) => event.event === "PublicationRecorded") &&
            item.linkedPullRequests[0]?.state === "OPEN",
        )
    ) {
      stale = true;
      snapshot.workItems[1]!.factoryEvents = snapshot.workItems[1]!.factoryEvents!.filter(
        (event) => event.event !== "PublicationRecorded",
      );
    }
    return snapshot;
  });
  vi.mocked(GitHubControlStore.prototype.readPullRequest).mockImplementation(async function (
    this: GitHubControlStore,
    number,
  ) {
    const observed = await pull.call(this, number);
    if ((number === 108 || number === 109) && !stale)
      return { ...observed, mergeable: false, mergeableState: "unknown" };
    if (stale && (number === 108 || number === 109) && !pending.has(number)) {
      pending.add(number);
      return { ...observed, mergeable: false, mergeableState: "unknown" };
    }
    return observed;
  });
  try {
    const result = await f.run();
    expect(result, result.reason).toMatchObject({ status: "completed" });
    expect(stale).toBe(true);
    expect([...pending].sort()).toEqual([108, 109]);
    for (const workItem of [8, 9, 10])
      expect(
        f
          .events()
          .filter((event) => event.event === "PublicationRecorded" && event.workItem === workItem),
      ).toHaveLength(1);
    expect(GitHubControlStore.prototype.compareAndSwapRef).toHaveBeenCalledOnce();
    expect(f.activity.filter((entry) => entry.invocation)).toHaveLength(1);
    expect(f.activity.filter((entry) => entry.operation === "candidate-review")).toHaveLength(1);
    expect(f.resources.size).toBe(0);
  } finally {
    await f.dispose();
  }
}, 30_000);
