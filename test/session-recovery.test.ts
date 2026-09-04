import { expect, it, vi } from "vitest";

import type {
  AttemptContext,
  BackendHandle,
} from "../src/execution/backend.js";
import {
  durableAttemptId,
  recoverDurableSession,
  type DurableSessionIdentity,
} from "../src/execution/session.js";

function recoveryFixture(): {
  context: AttemptContext;
  identity: DurableSessionIdentity;
  handle: BackendHandle;
} {
  const context = {
    runId: "run",
    objective: 1,
    workItem: 2,
    attempt: 3,
    directorEpoch: 4,
    workspace: "/tmp/fenced",
    packet: { baseSha: "a".repeat(40) },
  } as AttemptContext;
  const handle = {
    backendId: "app/server",
    resourceId: "thread",
    startedAt: new Date().toISOString(),
  };
  return {
    context,
    handle,
    identity: {
      attemptId: durableAttemptId(context),
      backendId: handle.backendId,
      resourceId: handle.resourceId,
      threadId: "thread",
      workspace: context.workspace,
      baseSha: context.packet.baseSha,
      runId: context.runId,
      objective: context.objective,
      workItem: context.workItem,
      attempt: context.attempt,
      directorEpoch: context.directorEpoch,
      startedAt: handle.startedAt,
    },
  };
}

it("reconciles exactly once when a durable thread cannot resume and never launches", async () => {
  const { context, identity } = recoveryFixture();
  const reconcile = vi.fn(async () => {});
  const result = await recoverDurableSession(context, identity, {
    resume: async () => {
      throw new Error("gone");
    },
    reconcile,
  });
  expect(result).toMatchObject({
    outcome: "reconciled",
    reason: expect.stringContaining("stopped safely"),
  });
  expect(reconcile).toHaveBeenCalledOnce();
});

it("resumes exactly once without reconciliation or duplicate launch", async () => {
  const { context, identity, handle } = recoveryFixture();
  const resume = vi.fn(async () => handle);
  const reconcile = vi.fn(async () => {});
  const launch = vi.fn();

  const result = await recoverDurableSession(context, identity, {
    resume,
    reconcile,
  });

  expect(result).toEqual({ outcome: "resumed", handle });
  expect(resume).toHaveBeenCalledOnce();
  expect(reconcile).not.toHaveBeenCalled();
  expect(launch).not.toHaveBeenCalled();
});

it("rejects a mismatched fence before resume or reconciliation", async () => {
  const { context, identity } = recoveryFixture();
  const resume = vi.fn();
  const reconcile = vi.fn();

  await expect(
    recoverDurableSession(
      { ...context, directorEpoch: context.directorEpoch + 1 },
      identity,
      { resume, reconcile },
    ),
  ).rejects.toThrow("does not match the fenced attempt");
  expect(resume).not.toHaveBeenCalled();
  expect(reconcile).not.toHaveBeenCalled();
});
