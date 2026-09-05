import { describe, expect, it } from "vitest";
import {
  providerAuthority,
  providerPolicy,
  providerObjective,
  assessProviderCompletion,
  observeProviderAbsence,
  type ProviderAuthority,
} from "../scripts/verify-provider-objective.mjs";
import { parseRunPolicy } from "../src/protocol/policy.js";

const authority: ProviderAuthority = {
  profile: "daytona-burst",
  repository: "fixture/provider",
  sandboxMinutes: 30,
  modelTokens: 150000,
  managedSessions: 0,
};
const env = {
  FACTORY_LIVE_PROVIDER: "1",
  FACTORY_LIVE_OBJECTIVE: "1",
  FACTORY_LIVE_PROVIDER_PROFILE: "daytona-burst",
  FACTORY_LIVE_OBJECTIVE_REPOSITORY: "fixture/provider",
  FACTORY_LIVE_PROVIDER_PAID_ACK: "daytona-burst:fixture/provider",
  FACTORY_LIVE_PROVIDER_CLEANUP_ACK: "fixture/provider:cancel-and-reconcile",
  FACTORY_LIVE_PROVIDER_MAX_SANDBOX_MINUTES: "30",
  FACTORY_LIVE_PROVIDER_MAX_MODEL_TOKENS: "150000",
};

function evidence() {
  let sequence = 0;
  const events: Array<Record<string, unknown>> = [];
  const add = (event: string, fields: Record<string, unknown> = {}) =>
    events.push({
      event,
      runId: "run",
      objective: 1,
      sequence: ++sequence,
      authorId: 123,
      ...fields,
    });
  add("FactoryRunStarted", { policy: providerPolicy(authority) });
  add("GraphProjected", { graphSize: 3 });
  add("AttemptStarted", { workItem: 2, attempt: 1, backend: "codex-sdk/local-worktree" });
  add("BudgetReserved", {
    workItem: 3,
    attempt: 1,
    phase: "execution",
    unit: "sandbox_milliseconds",
    amount: 10000,
  });
  add("AttemptStarted", { workItem: 3, attempt: 1, backend: "codex-cli/daytona" });
  add("AttemptSucceeded", { workItem: 2, attempt: 1 });
  add("AttemptSucceeded", { workItem: 3, attempt: 1 });
  add("CapacityReserved", {
    workItem: 3,
    attempt: 1,
    phase: "validation",
    backend: "codex-cli/daytona",
  });
  add("CapacityReconciled", {
    workItem: 3,
    attempt: 1,
    phase: "validation",
    backend: "codex-cli/daytona",
  });
  add("BudgetReconciled", {
    workItem: 3,
    attempt: 1,
    phase: "execution",
    unit: "sandbox_milliseconds",
    amount: 100,
  });
  const pulls = [];
  for (const number of [2, 3, 4]) {
    if (number === 4)
      add("AttemptStarted", { workItem: 4, attempt: 1, backend: "codex-sdk/local-worktree" });
    add("AttemptValidated", { workItem: number, attempt: 1, artifactDigest: `artifact-${number}` });
    add("AttemptPublished", {
      workItem: number,
      attempt: 1,
      artifactDigest: `artifact-${number}`,
      headSha: `head-${number}`,
    });
    add("PublicationRecorded", {
      workItem: number,
      attempt: 1,
      pullRequest: number + 10,
      headSha: `head-${number}`,
    });
    add("AttemptIntegrated", { workItem: number, attempt: 1, headSha: `merge-${number}` });
    pulls.push({
      number: number + 10,
      state: "closed",
      merged: true,
      head: { sha: `head-${number}` },
      merge_commit_sha: `merge-${number}`,
    });
  }
  add("FactoryRunCompleted");
  return {
    actor: { id: 123 },
    runResult: { status: "completed", runId: "run", objective: 1 },
    objective: { number: 1, state: "closed" },
    children: [2, 3, 4].map((number) => ({ number, state: "closed" })),
    dependencies: [
      { workItem: 2, blockedBy: [] },
      { workItem: 3, blockedBy: [] },
      { workItem: 4, blockedBy: [{ number: 2 }, { number: 3 }] },
    ],
    events,
    pulls,
    status: {
      run: { state: "completed", runId: "run" },
      objective: { number: 1, closed: true },
      summary: { runId: "run", outcome: "completed", attempts: { active: 0 } },
      capacity: { observed: { active: 0 }, activeReservations: [] },
      workItems: [2, 3, 4].map((number) => ({ number, state: "done", openDependencies: [] })),
    },
    cleanupObservation: { state: "absent" },
  };
}

describe("installed provider Objective harness (no live calls)", () => {
  it("is inert without explicit provider opt-in", () => expect(providerAuthority({})).toBeNull());
  it("requires exact target, paid budget and cleanup authority", () => {
    expect(providerAuthority(env)).toEqual(authority);
    for (const field of Object.keys(env).filter((key) => key !== "FACTORY_LIVE_PROVIDER")) {
      expect(() => providerAuthority({ ...env, [field]: undefined }), field).toThrow();
    }
    expect(() =>
      providerAuthority({ ...env, FACTORY_LIVE_PROVIDER_MAX_SANDBOX_MINUTES: "9999" }),
    ).toThrow();
  });
  it.each(["daytona-burst", "github-copilot", "openai-codex"] as const)(
    "builds valid bounded %s policy without implied fallback",
    (profile) => {
      const policy = parseRunPolicy(
        providerPolicy({
          ...authority,
          profile,
          managedSessions: profile === "daytona-burst" ? 0 : 3,
        }),
      );
      expect(policy.maxAttemptsPerItem).toBe(1);
      expect(policy.delivery?.onUnavailable).toBe("escalate");
      expect(policy.maxSandboxMinutes).toBe(30);
      expect(providerObjective(profile)).toContain(
        profile === "daytona-burst" ? "join-after-merge" : "managed execution trust",
      );
    },
  );
  it("qualifies only the explicitly bounded burst happy-path scope", () => {
    expect(assessProviderCompletion(evidence(), authority)).toMatchObject({
      result: "passed",
      scope: "installed-daytona-burst-objective-happy-path",
    });
  });
  it.each(["author", "no-overlap", "cleanup", "budget", "policy", "validation"])(
    "fails closed for %s evidence",
    (fault) => {
      const input = evidence();
      if (fault === "author") input.events[0]!.authorId = 999;
      if (fault === "no-overlap")
        input.events = input.events.filter((event) => event.event !== "AttemptSucceeded");
      if (fault === "cleanup") input.cleanupObservation.state = "unknown";
      if (fault === "budget")
        input.events = input.events.filter((event) => event.event !== "BudgetReserved");
      if (fault === "policy") input.events[0]!.policy = {};
      if (fault === "validation")
        input.events = input.events.filter((event) => event.event !== "CapacityReserved");
      expect(assessProviderCompletion(input, authority)).toMatchObject({ result: "incomplete" });
    },
  );
  it("observes scoped absence without accepting failed or incomplete provider reads", async () => {
    const input = { objective: { number: 1 }, runResult: { runId: "run" } };
    const empty = { async *list() {} };
    expect(await observeProviderAbsence(empty, input)).toMatchObject({ state: "absent" });
    expect(
      await observeProviderAbsence(
        {
          // biome-ignore lint/correctness/useYield: asynchronous iterator intentionally rejects before yielding provider state
          async *list() {
            throw new Error("unavailable");
          },
        },
        input,
      ),
    ).toMatchObject({ state: "unknown" });
    expect(await observeProviderAbsence(empty, {})).toMatchObject({ state: "unknown" });
    expect(
      await observeProviderAbsence(
        {
          async *list() {
            yield { labels: { factory: "v2", objective: "2", run: "run" } };
          },
        },
        input,
      ),
    ).toMatchObject({ state: "unknown" });
  });
});
