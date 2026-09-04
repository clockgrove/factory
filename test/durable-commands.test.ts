import { describe, expect, it } from "vitest";

import { deriveDurableCommandState } from "../src/control/commands.js";
import { parseFactoryEvent, type FactoryEvent } from "../src/protocol/events.js";

const base = {
  protocol: "clockgrove.factory/v2" as const,
  kind: "run" as const,
  objective: 7,
  runId: "run-1",
  at: "2026-09-04T00:00:00.000Z",
  requestedBy: "actor",
};

function command(
  event:
    | "RunPauseRequested"
    | "RunResumeRequested"
    | "RunDrainRequested"
    | "CloudPauseRequested"
    | "WorkItemRetryRequested"
    | "WorkItemPriorityChanged",
  sequence: number,
  overrides: Record<string, unknown> = {},
): FactoryEvent {
  return parseFactoryEvent({
    ...base,
    event,
    sequence,
    requestId: `${event}-${sequence}`,
    ...(event === "WorkItemRetryRequested" ? { workItem: 22 } : {}),
    ...(event === "WorkItemPriorityChanged"
      ? { workItem: 22, priorityRank: 10, prioritySource: "operator-command" }
      : {}),
    ...overrides,
  });
}

function reservation(sequence: number, workItem = 22): FactoryEvent {
  return parseFactoryEvent({
    protocol: "clockgrove.factory/v2",
    kind: "attempt",
    event: "AttemptReserved",
    objective: 7,
    runId: "run-1",
    sequence,
    at: "2026-09-04T00:00:00.000Z",
    workItem,
    attempt: 2,
    backend: "codex-sdk/local-worktree",
    baseSha: "a".repeat(40),
    directorEpoch: 1,
    policyDigest: "b".repeat(64),
  });
}

function derive(events: FactoryEvent[]) {
  return deriveDurableCommandState({
    events,
    objective: 7,
    runId: "run-1",
    runActor: "actor",
    runStartSequence: 1,
  });
}

describe("durable application command state", () => {
  it("applies pause, drain, cloud-pause, and a later resume deterministically", () => {
    expect(derive([command("RunPauseRequested", 2)])).toMatchObject({
      admissionsPaused: true,
      draining: false,
      cloudPaused: false,
      admissionGate: { kind: "pause", requestId: "RunPauseRequested-2" },
    });
    expect(
      derive([command("CloudPauseRequested", 2), command("RunDrainRequested", 3)]),
    ).toMatchObject({
      admissionsPaused: true,
      draining: true,
      cloudPaused: true,
      admissionGate: { kind: "drain", requestId: "RunDrainRequested-3" },
    });
    expect(
      derive([
        command("CloudPauseRequested", 2),
        command("RunDrainRequested", 3),
        command("RunResumeRequested", 4),
      ]),
    ).toMatchObject({
      admissionsPaused: false,
      draining: false,
      cloudPaused: false,
      admissionGate: null,
    });
  });

  it("fails safe when pause and resume race at the same sequence", () => {
    const state = derive([
      command("RunPauseRequested", 2, { requestId: "pause" }),
      command("RunResumeRequested", 2, { requestId: "resume" }),
    ]);
    expect(state.admissionsPaused).toBe(true);
  });

  it("ignores stale, other-run, and non-actor commands", () => {
    const state = derive([
      command("RunPauseRequested", 1),
      command("RunDrainRequested", 2, { runId: "other-run" }),
      command("CloudPauseRequested", 3, { requestedBy: "intruder" }),
      command("WorkItemPriorityChanged", 4, {
        objective: 8,
        priorityRank: 0,
      }),
    ]);
    expect(state).toMatchObject({
      admissionsPaused: false,
      draining: false,
      cloudPaused: false,
    });
    expect(state.priorities.size).toBe(0);

    expect(
      derive([
        command("RunPauseRequested", 2, { requestId: "shared" }),
        command("RunPauseRequested", 2, {
          requestId: "shared",
          requestedBy: "intruder",
          reason: "conflicting forgery",
        }),
      ]).admissionsPaused,
    ).toBe(true);
  });

  it("treats request IDs as idempotency keys at their first sequence", () => {
    const state = derive([
      command("RunPauseRequested", 2, { requestId: "same" }),
      command("RunPauseRequested", 2, {
        requestId: "same",
        at: "2026-09-04T00:00:01.000Z",
      }),
      command("RunResumeRequested", 4),
      command("RunPauseRequested", 6, { requestId: "same" }),
    ]);
    expect(state.admissionsPaused).toBe(false);
    expect(() =>
      derive([
        command("RunPauseRequested", 2, { requestId: "conflict" }),
        command("RunDrainRequested", 3, { requestId: "conflict" }),
      ]),
    ).toThrow(/conflicting Factory application requests/);
  });

  it("keeps retry one-shot and scoped to only its named Work Item", () => {
    const pending = derive([
      command("WorkItemRetryRequested", 2, {
        requestId: "retry-22",
        workItem: 22,
      }),
      command("WorkItemRetryRequested", 3, {
        requestId: "retry-23",
        workItem: 23,
      }),
      reservation(4, 22),
    ]);
    expect([...pending.retries.keys()]).toEqual([23]);
  });

  it("persists the latest explicit priority and rejects an unordered conflict", () => {
    const state = derive([
      command("WorkItemPriorityChanged", 2, { priorityRank: 50 }),
      command("WorkItemPriorityChanged", 3, { priorityRank: 4 }),
    ]);
    expect(state.priorities.get(22)).toMatchObject({ rank: 4, sequence: 3 });
    expect(() =>
      derive([
        command("WorkItemPriorityChanged", 2, {
          requestId: "priority-a",
          priorityRank: 1,
        }),
        command("WorkItemPriorityChanged", 2, {
          requestId: "priority-b",
          priorityRank: 2,
        }),
      ]),
    ).toThrow(/conflicting priority commands/);
  });
});
