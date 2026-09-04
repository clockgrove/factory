import { describe, expect, it } from "vitest";

import { deriveDurableCommandState } from "../src/control/commands.js";
import type { RunState } from "../src/control/runs.js";
import type { BackendCandidate } from "../src/execution/registry.js";
import { parseFactoryEvent } from "../src/protocol/events.js";
import { DEFAULT_RUN_POLICY, policyDigest } from "../src/protocol/policy.js";
import type { DerivedWorkItem } from "../src/state.js";
import { applyCloudPause, retryCommandAllows } from "../src/supervisor.js";

const run: RunState = {
  objective: 7,
  runId: "run-1",
  sequence: 1,
  actor: "operator",
  policy: DEFAULT_RUN_POLICY,
  policyDigest: policyDigest(DEFAULT_RUN_POLICY),
  startedAt: new Date("2026-09-04T00:00:00.000Z"),
};

const commands = deriveDurableCommandState({
  events: [
    parseFactoryEvent({
      protocol: "clockgrove.factory/v2",
      kind: "run",
      event: "WorkItemRetryRequested",
      objective: 7,
      runId: "run-1",
      sequence: 2,
      at: "2026-09-04T00:01:00.000Z",
      requestedBy: "operator",
      requestId: "retry-22",
      workItem: 22,
    }),
  ],
  objective: 7,
  runId: "run-1",
  runActor: "operator",
  runStartSequence: 1,
});

function item(overrides: Partial<DerivedWorkItem> = {}): DerivedWorkItem {
  return {
    id: "item-22",
    number: 22,
    title: "Retry safely",
    closed: false,
    assignees: [],
    labels: ["factory:work-item"],
    blockedBy: [],
    linkedPullRequests: [],
    copilotAssignments: [],
    factoryEvents: [],
    state: "failed",
    attempts: 1,
    doneWithoutMergedPullRequest: false,
    ...overrides,
  };
}

function candidate(id: string, paid: boolean): BackendCandidate {
  return {
    id,
    registered: true,
    backend: null,
    capabilities: null,
    probe: null,
    costClass: paid ? "sandbox" : "local",
    local: !paid,
    paid,
    permanentReasons: [],
    transientReasons: [],
  };
}

describe("Supervisor durable command gates", () => {
  it("allows a one-shot retry only for the named safely retryable item", () => {
    expect(retryCommandAllows(item(), commands, run, 3)).toBe(true);
    expect(retryCommandAllows(item({ number: 23 }), commands, run, 3)).toBe(false);
    expect(retryCommandAllows(item({ attempts: 3 }), commands, run, 3)).toBe(false);
    expect(retryCommandAllows(item({ state: "done", closed: true }), commands, run, 3)).toBe(false);
    expect(
      retryCommandAllows(item({ blockedBy: [{ number: 1, closed: false }] }), commands, run, 3),
    ).toBe(false);
    expect(retryCommandAllows(item({ assignees: ["someone-else"] }), commands, run, 3)).toBe(false);
    expect(retryCommandAllows(item({ assignees: ["operator"] }), commands, run, 3)).toBe(true);
  });

  it("blocks only paid candidates while cloud pause is active", () => {
    const local = candidate("codex-sdk/local-worktree", false);
    const cloud = candidate("codex-cli/daytona", true);
    const gated = applyCloudPause([local, cloud], true);

    expect(gated[0]).toEqual(local);
    expect(gated[1]?.transientReasons).toEqual([
      "paid admission is paused by the active run actor",
    ]);
    expect(gated[1]?.permanentReasons).toEqual([]);
    expect(applyCloudPause([cloud], false)).toEqual([cloud]);
  });
});
