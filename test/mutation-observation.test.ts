import { observeGitHubRequestTransport } from "../src/platform.js";
import { describe, expect, it } from "vitest";
import {
  observeGitHubTransport,
  observeGitHubTransportTrace,
  type GitHubTransportAttempt,
  observeGitHubTransportPhase,
  observeMutationFence,
  observeMutationOperation,
  observeMutationQueue,
  type GitHubTransportObservation,
  type MutationOperationObservation,
} from "../src/control/mutation-observation.js";

describe("controller phase observations", () => {
  it("reconciles actual attempts outside operations, refusals, 304s and transport failures", async () => {
    const attempts: GitHubTransportAttempt[] = [];
    const phases: GitHubTransportObservation[] = [];
    await observeGitHubTransportTrace(
      (attempt) => attempts.push(attempt),
      async () => {
        const send = (status: number) =>
          observeGitHubRequestTransport(
            "trace-test",
            "https://api.github.com/repos/private/repository",
            undefined,
            (async () =>
              new Response(null, { status, headers: { "content-length": "0" } })) as typeof fetch,
          );
        await send(304);
        await observeGitHubTransportPhase(
          "root",
          (value) => phases.push(value),
          async () => {
            await observeMutationOperation(
              "receipt",
              "objective-publication",
              "objective:1",
              () => {},
              async () => {
                await observeMutationFence(async () => {
                  await send(403);
                });
                await expect(
                  observeGitHubRequestTransport(
                    "trace-test",
                    "https://api.github.com/graphql",
                    { method: "POST", body: '{"query":"mutation { secret }"}' },
                    (async () => {
                      throw new Error("lost response");
                    }) as typeof fetch,
                  ),
                ).rejects.toThrow("lost response");
              },
            );
          },
        );
      },
    );
    expect(attempts).toHaveLength(3);
    expect(attempts[0]).toMatchObject({
      operation: "outside-operation",
      phase: "outside-phase",
      reason: "outside-operation",
      kind: "read",
      status: 304,
      responseBytes: 0,
    });
    expect(attempts[1]).toMatchObject({
      operation: "other-operation",
      phase: "other-phase",
      reason: "fence",
      status: 403,
    });
    expect(attempts[2]).toMatchObject({
      kind: "write",
      reason: "operation",
      outcome: "transport-error",
      requestBytes: 31,
    });
    expect(phases[0]).toMatchObject({ readRequests: 1, mutationRequests: 1 });
    expect(JSON.stringify(attempts)).not.toMatch(/private|secret/);
    expect(attempts.every((attempt) => /^[a-f0-9]{64}$/.test(attempt.objectIdentity))).toBe(true);
    await expect(
      observeGitHubTransportTrace(
        () => {
          throw new Error("sink");
        },
        () =>
          observeGitHubRequestTransport(
            "trace-test",
            "https://api.github.com/graphql",
            undefined,
            (async () => new Response(null, { status: 200 })) as typeof fetch,
          ),
      ),
    ).resolves.toBeInstanceOf(Response);
  });

  it("exports bounded route labels and separated scheduler waits without leaking paths", async () => {
    const phases: GitHubTransportObservation[] = [];
    await observeGitHubTransportPhase(
      "objective",
      (value) => phases.push(value),
      async () => {
        observeGitHubTransport(
          "https://api.github.com/repos/private/repository/git/ref/clockgrove-factory%2Fcoordination%2Fcapacity",
        );
        observeGitHubTransport(
          "https://api.github.com/repos/private/repository/git/commits/secret-sha",
        );
        observeGitHubTransport(
          "https://api.github.com/repos/private/repository/issues/123/comments?since=private",
        );
        observeMutationQueue(1200, { "admission-contention": 1200 });
      },
    );
    expect(phases[0]).toMatchObject({
      requestsByRoute: { "capacity-ref": 1, "git-commit": 1, "issue-comments": 1 },
      mutationWaitReasonMs: { "admission-contention": 1200 },
      aggregateQueueWaitMs: 1200,
    });
    expect(JSON.stringify(phases)).not.toMatch(/private|secret-sha|123/);
  });

  it("includes concurrent child work in its parent while preserving each child's attribution", async () => {
    const phases: GitHubTransportObservation[] = [];
    const mutations: MutationOperationObservation[] = [];
    await observeGitHubTransportPhase(
      "run",
      (value) => phases.push(value),
      async () => {
        observeGitHubTransport("https://api.github.com/repos/owner/repo");
        await Promise.all(
          ["compile", "validate"].map((phase) =>
            observeGitHubTransportPhase(
              phase,
              (value) => phases.push(value),
              async () => {
                await observeMutationOperation(
                  "receipt",
                  "objective-publication",
                  "objective:1",
                  (value) => mutations.push(value),
                  async () => {
                    observeMutationQueue(1_000);
                    await observeMutationFence(async () => {
                      observeGitHubTransport("https://api.github.com/repos/owner/repo/git/ref");
                      await Promise.resolve();
                    });
                    observeGitHubTransport("https://api.github.com/graphql", {
                      method: "POST",
                      body: JSON.stringify({ query: "mutation { updateRefs }" }),
                    });
                  },
                );
              },
            ),
          ),
        );
      },
    );
    const parent = phases.find((phase) => phase.phase === "run")!;
    const children = phases.filter((phase) => phase.phase !== "run");
    expect(parent).toMatchObject({
      readRequests: 3,
      mutationRequests: 2,
      aggregateQueueWaitMs: 2_000,
      outcome: "succeeded",
    });
    for (const child of children) {
      expect(child).toMatchObject({
        readRequests: 1,
        mutationRequests: 1,
        aggregateQueueWaitMs: 1_000,
      });
      expect(child.elapsedMs).toBeGreaterThanOrEqual(0);
      expect(Date.parse(child.endedAt)).toBeGreaterThanOrEqual(Date.parse(child.startedAt));
      expect(Object.isFrozen(child)).toBe(true);
    }
    expect(parent.aggregateFenceMs).toBe(
      children.reduce((total, child) => total + child.aggregateFenceMs, 0),
    );
    expect(mutations.map((mutation) => mutation.phase).sort()).toEqual(["compile", "validate"]);
    expect(parent.aggregateFenceMs).toBe(
      mutations.reduce((total, mutation) => total + mutation.fenceMs, 0),
    );
  });

  it("reports failed fence time without a mutation wrapper and keeps diagnostics fail-open", async () => {
    const phases: GitHubTransportObservation[] = [];
    const failure = new Error("lease changed");
    await expect(
      observeGitHubTransportPhase(
        "publish",
        (value) => {
          phases.push(value);
          throw new Error("diagnostic sink unavailable");
        },
        async () => {
          observeMutationQueue(25);
          await observeMutationFence(async () => {
            observeGitHubTransport("https://api.github.com/graphql", {
              method: "POST",
              body: "invalid",
            });
            throw failure;
          });
        },
      ),
    ).rejects.toBe(failure);
    expect(phases[0]).toMatchObject({
      outcome: "failed",
      aggregateQueueWaitMs: 25,
      unclassifiedRequests: 1,
    });
    expect(phases[0]!.aggregateFenceMs).toBeGreaterThanOrEqual(0);
    await expect(
      observeGitHubTransportPhase(
        "successful",
        () => {
          throw failure;
        },
        async () => 42,
      ),
    ).resolves.toBe(42);
  });
});
