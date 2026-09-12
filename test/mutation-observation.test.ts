import { describe, expect, it } from "vitest";
import {
  observeGitHubTransport,
  observeGitHubTransportPhase,
  observeMutationFence,
  observeMutationOperation,
  observeMutationQueue,
  type GitHubTransportObservation,
  type MutationOperationObservation,
} from "../src/control/mutation-observation.js";

describe("controller phase observations", () => {
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
