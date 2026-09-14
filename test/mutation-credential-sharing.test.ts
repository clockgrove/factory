import { describe, expect, it, vi } from "vitest";
import { GitHubControlStore } from "../src/control/github-store.js";
import { createOctokit } from "../src/github.js";
import { MutationScheduler, createGitHubMutationScope } from "../src/platform.js";
import { createRepositorySupervisorResources } from "../src/supervisor.js";

describe("credential-shared mutation quota with owner-local retirement", () => {
  it("holds the shared gate through a delayed pretransport fence", async () => {
    const now = 0;
    const shared = new MutationScheduler({
      now: () => new Date(now),
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
    expect(now).toBe(0);
    peer.recordTransported!();
    expect(first.telemetry().transported).toBe(1);
    expect(second.telemetry().transported).toBe(1);
  });

  it("admits more than 500 writes across concurrent owners without a speculative quota and preserves peer/cleanup admission on stop", async () => {
    const now = 0;
    const shared = new MutationScheduler({
      now: () => new Date(now),
    });
    const first = shared.fork();
    const second = shared.fork();
    const timestamps: number[] = [];
    const run = async (owner: MutationScheduler) => {
      for (let i = 0; i < 300; i++) {
        const permit = await owner.acquire();
        permit.recordTransported!();
        timestamps.push(now);
      }
    };
    await Promise.all([run(first), run(second)]);
    expect(timestamps).toHaveLength(600);
    expect(now).toBe(0);
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
    expect(second.telemetry().transported).toBe(301);
    const next = await second.acquire();
    next.recordTransported!();
    expect(first.telemetry().transported).toBe(301);
    expect(second.telemetry().transported).toBe(302);
    expect(now).toBe(0);
  });

  it("transports 600 successful writes across two stores without an invented rolling allowance", async () => {
    const token = "successful-writes-without-local-estimate";
    const requestFetch = vi.fn(async () => Response.json({ sha: "a".repeat(40) }));
    const scopes = [createGitHubMutationScope(token), createGitHubMutationScope(token)];
    const stores = scopes.map(
      (scope, index) =>
        new GitHubControlStore({
          token,
          owner: "o",
          repo: `r${index}`,
          requestFetch,
          ...scope,
        }),
    );
    await Promise.all(
      stores.map(async (store) => {
        for (let i = 0; i < 300; i++)
          await store.createBlob(Buffer.from("successful fixture write"));
      }),
    );
    expect(requestFetch).toHaveBeenCalledTimes(600);
    for (const scope of scopes) {
      expect(scope.mutationScheduler.telemetry()).toMatchObject({
        transported: 300,
        successful: 300,
      });
      expect(scope.circuitBreaker.isOpen()).toBe(false);
    }
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
    expect(record).toHaveBeenCalledTimes(1);
    record.mockRestore();
  });

  it("shares quota across repository/foreground resources without sharing resource ownership", () => {
    const first = createRepositorySupervisorResources(undefined, "resource-quota-test");
    const second = createRepositorySupervisorResources(undefined, "resource-quota-test");
    expect(first.circuitBreaker).toBe(second.circuitBreaker);
    expect(first.concurrency).toBe(second.concurrency);
    expect(first.mutationScheduler).not.toBe(second.mutationScheduler);
    expect(first.capacityLedger).not.toBe(second.capacityLedger);
    expect(first.fairness).not.toBe(second.fairness);
    expect(first.integration).not.toBe(second.integration);
  });
});
