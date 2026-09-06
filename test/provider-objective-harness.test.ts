import { describe, expect, it } from "vitest";
import {
  providerAuthority,
  providerPolicy,
  providerObjective,
  assessProviderCompletion,
  observeManagedAgentTermination,
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
      headSha: String(number).repeat(40),
    });
    add("PublicationRecorded", {
      workItem: number,
      attempt: 1,
      pullRequest: number + 10,
      headSha: String(number).repeat(40),
    });
    add("AttemptIntegrated", {
      workItem: number,
      attempt: 1,
      headSha: String(number + 3).repeat(40),
    });
    pulls.push({
      id: number + 100,
      node_id: `PR_${number + 10}`,
      base: { repo: { node_id: "R_fixture", full_name: authority.repository } },
      number: number + 10,
      state: "closed",
      merged: true,
      head: { sha: String(number).repeat(40) },
    });
  }
  add("FactoryRunCompleted");
  return {
    repository: authority.repository,
    mergeProofs: [2, 3, 4].map((number) => ({
      runId: "run",
      objective: 1,
      workItem: number,
      attempt: 1,
      pullRequest: number + 10,
      pullRequestNodeId: `PR_${number + 10}`,
      repository: authority.repository,
      repositoryNodeId: "R_fixture",
      headSha: String(number).repeat(40),
      mergeSha: String(number + 3).repeat(40),
    })),
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

function managedEvidence() {
  const managedAuthority: ProviderAuthority = {
    ...authority,
    profile: "github-copilot",
    managedSessions: 3,
  };
  const input = evidence();
  const events: Array<Record<string, unknown>> = input.events
    .filter(
      (event) =>
        !["BudgetReserved", "BudgetReconciled", "CapacityReserved", "CapacityReconciled"].includes(
          String(event.event),
        ),
    )
    .flatMap<Record<string, unknown>>((event) => {
      if (event.event === "FactoryRunStarted")
        return [{ ...event, policy: providerPolicy(managedAuthority) }];
      if (event.event !== "AttemptStarted") return [event];
      const scope = { ...event, phase: "execution", unit: "managed_sessions", amount: 1 };
      const validation = { ...event, phase: "validation", backend: "codex-cli/daytona" };
      return [
        { ...scope, event: "BudgetReserved" },
        { ...event, backend: "github-copilot/github-managed" },
        { ...scope, event: "BudgetReconciled" },
        { ...validation, event: "CapacityReserved" },
        { ...validation, event: "CapacityReconciled" },
      ];
    })
    .map((event, index) => ({ ...event, sequence: index + 1 }));
  return {
    authority: managedAuthority,
    input: {
      ...input,
      events,
      billingObservation: { state: "unavailable" },
      managedSessionObservation: {
        state: "terminated",
        bindings: input.pulls.map((pull) => ({
          pullNumber: pull.number,
          pullDatabaseId: pull.id,
          taskId: `task-${pull.number}`,
          taskState: "completed",
          sessions: [{ id: `session-${pull.number}`, state: "completed" }],
        })),
      },
    },
  };
}

describe("installed provider Objective harness (no live calls)", () => {
  it("qualifies exact managed execution with unavailable billing, without inventing settlement or zero cost", () => {
    const fixture = managedEvidence();
    const before = structuredClone(fixture.input);
    expect(assessProviderCompletion(fixture.input, fixture.authority)).toMatchObject({
      result: "passed",
      scope: "installed-managed-objective-happy-path",
      billing: { availability: "unavailable" },
      excludes: expect.arrayContaining([
        "provider invoice settlement and billing finality",
        "provider billing accuracy and monetary cost",
      ]),
    });
    expect(fixture.input).toEqual(before);
    const { billingObservation: _unavailable, ...withoutBilling } = fixture.input;
    const result = assessProviderCompletion(withoutBilling, fixture.authority);
    expect(result.result).toBe("passed");
    expect(result.billing).not.toHaveProperty("amount");
    expect(result.billing).not.toHaveProperty("value");
  });

  it.each([
    "active",
    "unknown",
    "unknown-task",
    "active-session",
    "unknown-session",
    "duplicate-task",
    "foreign-pull",
    "extra-session",
    "budget",
    "validation",
    "head",
  ])(
    "does not waive %s evidence because billing settlement is excluded",
    (fault) => {
      const { input, authority: managedAuthority } = managedEvidence();
      const observation = input.managedSessionObservation;
      if (fault === "active") observation.state = "present";
      if (fault === "unknown") observation.state = "unknown";
      if (fault === "unknown-task") observation.bindings[0]!.taskState = "unknown";
      if (fault === "active-session") observation.bindings[0]!.sessions[0]!.state = "in_progress";
      if (fault === "unknown-session") observation.bindings[0]!.sessions[0]!.state = "unknown";
      if (fault === "duplicate-task")
        observation.bindings[1]!.taskId = observation.bindings[0]!.taskId;
      if (fault === "foreign-pull") observation.bindings[0]!.pullDatabaseId = 9999;
      if (fault === "extra-session")
        observation.bindings[0]!.sessions.push({ id: "extra", state: "completed" });
      if (fault === "budget")
        input.events = input.events.filter((event) => event.event !== "BudgetReserved");
      if (fault === "validation")
        input.events = input.events.filter((event) => event.event !== "CapacityReserved");
      if (fault === "head") input.pulls[0]!.head.sha = "a".repeat(40);
      expect(assessProviderCompletion(input, managedAuthority).result).toBe("incomplete");
    },
  );

  it("requires separate exact merge proofs and never recovers missing proof from legacy REST fields", () => {
    const value = evidence();
    expect(value.pulls.every((pull) => !("merge_commit_sha" in pull))).toBe(true);
    expect(assessProviderCompletion(value, authority).result).toBe("passed");
    Object.assign(value.pulls[0]!, { merge_commit_sha: value.mergeProofs[0]!.mergeSha });
    value.mergeProofs.pop();
    expect(assessProviderCompletion(value, authority).result).toBe("incomplete");
  });
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
      const objective = providerObjective(profile, "provider-20260905-a");
      expect(objective).toContain("src/factory-qualification/provider-20260905-a/clamp.js");
      expect(objective).toContain(
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

  it("observes managed termination only through exact owned task, PR and session bindings", async () => {
    const input = {
      actor: { id: 123 },
      startedAt: "2026-09-04T00:00:00.000Z",
      pulls: [
        {
          id: 9001,
          number: 12,
          base: { repo: { id: 77 } },
          head: { ref: "copilot/work-12" },
        },
      ],
    };
    let sessionState = "completed";
    const request = async (route: string, parameters: Record<string, unknown> = {}) => {
      if (route.endsWith("/{task_id}"))
        return {
          data: {
            id: "task-12",
            creator: { id: 123 },
            repository: { id: 77 },
            state: sessionState,
            session_count: 1,
            artifacts: [{ provider: "github", type: "pull", data: { id: 9001 } }],
            sessions: [
              {
                id: "session-12",
                task_id: "task-12",
                user: { id: 123 },
                repository: { id: 77 },
                state: sessionState,
                head_ref: "copilot/work-12",
              },
            ],
          },
        };
      return {
        data: {
          tasks:
            parameters.is_archived === true
              ? []
              : [
                  {
                    id: "task-12",
                    creator: { id: 123 },
                    repository: { id: 77 },
                    artifacts: [{ provider: "github", type: "pull", data: { id: 9001 } }],
                  },
                ],
        },
      };
    };
    await expect(observeManagedAgentTermination(request, input)).resolves.toMatchObject({
      state: "terminated",
      bindings: [{ pullNumber: 12, taskId: "task-12" }],
    });
    sessionState = "in_progress";
    await expect(observeManagedAgentTermination(request, input)).resolves.toMatchObject({
      state: "present",
      active: [{ taskId: "task-12", taskState: "in_progress" }],
    });
  });
});
