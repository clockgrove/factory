import { describe, expect, it, vi } from "vitest";
import { GitHubControlStore } from "../src/control/github-store.js";
import { createOctokit } from "../src/github.js";
import { MutationScheduler, createGitHubMutationScope } from "../src/platform.js";
import { createRepositorySupervisorResources } from "../src/supervisor.js";

describe("credential-shared mutation quota with owner-local retirement", () => {
  it("holds the shared gate through a delayed pretransport fence", async () => {
    let now = 0;
    const shared = new MutationScheduler({
      now: () => new Date(now),
      sleep: async (ms) => {
        now += ms;
      },
    });
    const first = shared.fork();
    const second = shared.fork();
    const held = await first.acquire();
    let peerAdmitted = false;
    const pending = second.acquire().then((permit) => {
      peerAdmitted = true;
      return permit;
    });
    await Promise.resolve();
    expect(peerAdmitted).toBe(false);
    // The first owner's fence has not dispatched, so no quota has been spent.
    expect(first.telemetry().transported).toBe(0);
    held.recordTransported!();
    const peer = await pending;
    expect(now).toBe(1_000);
    peer.recordTransported!();
    expect(second.telemetry().localSecondaryEstimate.transportedLastHour).toBe(2);
    expect(first.telemetry().transported).toBe(1);
    expect(second.telemetry().transported).toBe(1);
  });

  it("shares one burst across concurrent owners and preserves peer/cleanup admission on stop", async () => {
    let now = 0;
    const shared = new MutationScheduler({
      now: () => new Date(now),
      sleep: async (ms) => {
        now += ms;
      },
    });
    const first = shared.fork();
    const second = shared.fork();
    const timestamps: number[] = [];
    const run = async (owner: MutationScheduler) => {
      for (let i = 0; i < 58; i++) {
        const permit = await owner.acquire();
        permit.recordTransported!();
        timestamps.push(now);
      }
    };
    await Promise.all([run(first), run(second)]);
    expect(timestamps).toHaveLength(116);
    expect(now).toBeGreaterThan(116_000);
    for (const at of timestamps)
      expect(timestamps.filter((t) => t > at - 60_000 && t <= at).length).toBeLessThanOrEqual(80);
    const held = await second.acquire();
    const cancelled = first.acquire();
    const rejection = expect(cancelled).rejects.toThrow("controller shutdown");
    const pendingPeer = second.acquire();
    first.stopNormalAdmission();
    await rejection;
    held.release(); // A fenced-out permit must not consume credit.
    const peer = await pendingPeer;
    peer.recordTransported!();
    const cleanup = await first.acquire("cleanup");
    cleanup.recordTransported!();
    expect(second.telemetry().transported).toBe(59);
  });

  it("shares actual secondary refusal feedback across stores but isolates credentials", async () => {
    let firstRequests = 0;
    let peerRequests = 0;
    const record = vi.spyOn(
      createGitHubMutationScope("shared-refusal-test").circuitBreaker,
      "recordRefusal",
    );
    const first = new GitHubControlStore({
      token: "shared-refusal-test",
      owner: "o",
      repo: "first",
      requestFetch: async () => {
        firstRequests++;
        return Response.json(
          { message: "You have exceeded a secondary rate limit" },
          {
            status: 403,
            headers: { "retry-after": "120" },
          },
        );
      },
    });
    const peer = new GitHubControlStore({
      token: "shared-refusal-test",
      owner: "o",
      repo: "peer",
      requestFetch: async () => {
        peerRequests++;
        return Response.json({ sha: "a".repeat(40) });
      },
    });
    await expect(first.createBlob(Buffer.from("first"))).rejects.toThrow();
    await expect(peer.createBlob(Buffer.from("peer"))).rejects.toThrow("platform unavailable");
    expect(firstRequests).toBe(1);
    expect(peerRequests).toBe(0);
    const rawPeer = createOctokit({
      token: "shared-refusal-test",
      owner: "o",
      repo: "read-peer",
      requestFetch: async () => {
        peerRequests++;
        return Response.json({});
      },
    });
    await expect(rawPeer.request("GET /user")).rejects.toThrow("platform unavailable");
    expect(peerRequests).toBe(0);
    expect(record).toHaveBeenCalledTimes(1);
    record.mockRestore();
    expect(
      createGitHubMutationScope("shared-refusal-test").pacer.snapshot().secondaryRefusals,
    ).toBe(1);
    expect(createGitHubMutationScope("separate-credential-test").circuitBreaker.isOpen()).toBe(
      false,
    );
  });

  it("a raw read refusal blocks peer writes without charging an untransported mutation", async () => {
    const token = "read-origin-refusal-test";
    const scope = createGitHubMutationScope(token);
    const record = vi.spyOn(scope.circuitBreaker, "recordRefusal");
    const reader = createOctokit({
      token,
      owner: "o",
      repo: "r",
      requestFetch: async () =>
        Response.json(
          { message: "secondary rate limit" },
          {
            status: 429,
            headers: { "retry-after": "120" },
          },
        ),
    });
    await expect(reader.request("GET /user")).rejects.toThrow("platform unavailable");
    let writes = 0;
    const peer = new GitHubControlStore({
      token,
      owner: "o",
      repo: "peer",
      ...scope,
      requestFetch: async () => {
        writes++;
        return Response.json({});
      },
    });
    await expect(peer.createBlob(Buffer.from("no dispatch"))).rejects.toThrow(
      "platform unavailable",
    );
    expect(writes).toBe(0);
    expect(scope.mutationScheduler.telemetry().transported).toBe(0);
    expect(scope.pacer.snapshot().transportedLastHour).toBe(0);
    expect(record).toHaveBeenCalledTimes(1);
    record.mockRestore();
  });

  it("shares quota across repository/foreground resources without sharing resource ownership", () => {
    const first = createRepositorySupervisorResources(undefined, undefined, "resource-quota-test");
    const second = createRepositorySupervisorResources(undefined, undefined, "resource-quota-test");
    expect(first.pacer).toBe(second.pacer);
    expect(first.circuitBreaker).toBe(second.circuitBreaker);
    expect(first.concurrency).toBe(second.concurrency);
    expect(first.mutationScheduler).not.toBe(second.mutationScheduler);
    expect(first.capacityLedger).not.toBe(second.capacityLedger);
    expect(first.fairness).not.toBe(second.fairness);
    expect(first.integration).not.toBe(second.integration);
  });
});
