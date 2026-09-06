import { access } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubControlStore } from "../src/control/github-store.js";
import { decodeEventComments } from "../src/control/receipts.js";
import * as worktrees from "../src/runtime/local-worktree.js";
import { providerSupervisorFixture } from "./helpers/provider-supervisor.js";

const fixtures: Awaited<ReturnType<typeof providerSupervisorFixture>>[] = [];
const retained: worktrees.LocalWorktree[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose();
  for (const worker of retained.splice(0))
    await worktrees.cleanupLocalWorktree(worker).catch(() => {});
});

describe("Supervisor collected artifact durability", () => {
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
        expect([...f.refs.keys()].some((ref) => ref.startsWith("refs/clockgrove-factory/artifact-transfers/") && ref.endsWith("/ready"))).toBe(true);
        expect(f.activity.some((entry) => entry.operation === "cleanup" && entry.workItem === event.workItem)).toBe(false);
      }
      await original(node, body);
    });
    await f.run();
    expect(collected).toBeGreaterThan(0);
  });

  it("stops resources but retains source and forbids replacement after failed ready publication", async () => {
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
    expect(f.events().some((event) => ["AttemptFailed", "AttemptDeferred", "FactoryRunCompleted"].includes(event.event))).toBe(false);
    expect([...f.refs.keys()].some((ref) => ref.endsWith("/intent"))).toBe(true);
    expect(retained.length).toBe(1);
    await expect(access(retained[0]!.path)).resolves.toBeUndefined();
  });
});
