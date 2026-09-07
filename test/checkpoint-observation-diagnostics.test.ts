import { describe, expect, it, vi } from "vitest";
import {
  checkpointFailure,
  checkpointObservationFailure,
  checkpointObservationRead,
  type CheckpointObservationDiagnostic,
} from "../scripts/verify-local-checkpoint-restart.mjs";

const instant = Date.parse("2026-09-07T05:00:28.000Z");
type Recorded = CheckpointObservationDiagnostic & { attempt: number; retry: boolean };

function readFixture(deadline = instant + 10000) {
  let clock = instant;
  const records: Recorded[] = [];
  const wait = vi.fn(async (milliseconds: number) => {
    clock += milliseconds;
  });
  return {
    records,
    wait,
    context: {
      phase: "terminal-artifact-hold",
      stage: "objective",
      deadline,
      now: () => clock,
      wait,
      record: (diagnostic: Recorded) => {
        records.push(diagnostic);
      },
    },
  };
}

describe("checkpoint observation diagnostics", () => {
  it("records fixed phase, stage, time and status without disclosing arbitrary error content", () => {
    const secret = "private-response-and-credential";
    const diagnostic = checkpointObservationFailure(
      {
        status: 503,
        message: secret,
        body: secret,
        response: { headers: { authorization: secret }, data: secret },
        cause: { message: secret },
      },
      { phase: "terminal-artifact-hold", stage: "comments", now: instant },
    );
    expect(diagnostic).toEqual({
      boundary: "observation",
      phase: "terminal-artifact-hold",
      stage: "comments",
      failedAt: "2026-09-07T05:00:28.000Z",
      category: "http",
      code: "UNAVAILABLE",
      httpStatus: 503,
    });
    expect(JSON.stringify(diagnostic)).not.toContain(secret);
    expect(
      checkpointObservationFailure(Error(secret), {
        phase: secret,
        stage: secret,
        now: instant,
      }),
    ).toMatchObject({ phase: "observation", stage: "observation", category: "unavailable" });
    // Historical generic evidence remains unknown; no retrospective cause inference.
    expect(checkpointFailure(Error(secret))).toEqual({ boundary: "scenario", code: "UNAVAILABLE" });
  });

  it.each([
    [{ name: "TimeoutError" }, "timeout"],
    [{ name: "AbortError" }, "aborted"],
    [{ cause: { code: "ECONNRESET" } }, "transport"],
    [{ name: "McpError", code: -32001 }, "mcp"],
    [new SyntaxError("private body"), "parse"],
    [{ code: "ERR_ASSERTION" }, "assertion"],
    [{ code: "EACCES" }, "filesystem"],
    [{ status: 429 }, "http-refusal"],
  ])("classifies recognized failures without their messages (%j)", (error, category) => {
    expect(checkpointObservationFailure(error, { now: instant }).category).toBe(category);
  });

  it("records transient failures then completes the same read without resetting its deadline", async () => {
    const f = readFixture();
    const operation = vi
      .fn()
      .mockRejectedValueOnce({ status: 503 })
      .mockRejectedValueOnce({ code: "ECONNRESET" })
      .mockResolvedValue("observed");
    expect(await checkpointObservationRead(operation, f.context)).toBe("observed");
    expect(operation.mock.calls.map(([remaining]) => remaining)).toEqual([10000, 9000, 8000]);
    expect(f.records.map(({ attempt, retry }) => ({ attempt, retry }))).toEqual([
      { attempt: 1, retry: true },
      { attempt: 2, retry: true },
    ]);
    expect(f.records[1]?.failedAt).toBe("2026-09-07T05:00:29.000Z");
  });

  it("exhausts at most two retries and throws the original failure object", async () => {
    const f = readFixture();
    const failure = Object.assign(Error("not serialized"), { status: 502 });
    const operation = vi.fn().mockRejectedValue(failure);
    await expect(checkpointObservationRead(operation, f.context)).rejects.toBe(failure);
    expect(operation).toHaveBeenCalledTimes(3);
    expect(f.wait).toHaveBeenCalledTimes(2);
    expect(f.records.map(({ retry }) => retry)).toEqual([true, true, false]);
    expect(JSON.stringify(f.records)).not.toContain("not serialized");
  });

  it.each([
    { status: 401 },
    { status: 403 },
    { status: 429 },
    { status: 503, response: { headers: { "retry-after": "1" } } },
    { status: 503, response: { headers: { "x-ratelimit-remaining": "0" } } },
    { status: 503, response: { headers: { "x-ratelimit-reset": "9999999999" } } },
    new SyntaxError("private"),
    { code: "ERR_ASSERTION" },
    { name: "McpError", code: -32001 },
    Error("unclassified operator refusal"),
  ])("never retries a refusal, quota boundary or unclassified failure (%j)", async (failure) => {
    const f = readFixture();
    const operation = vi.fn().mockRejectedValue(failure);
    await expect(checkpointObservationRead(operation, f.context)).rejects.toBe(failure);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(f.wait).not.toHaveBeenCalled();
    expect(f.records[0]?.retry).toBe(false);
  });

  it.each(["receipts", "witness", "extension", "accept", "poll"])(
    "does not replay nontransport stage %s",
    async (stage) => {
      const f = readFixture();
      const failure = { code: "ECONNRESET" };
      const operation = vi.fn().mockRejectedValue(failure);
      await expect(checkpointObservationRead(operation, { ...f.context, stage })).rejects.toBe(
        failure,
      );
      expect(operation).toHaveBeenCalledTimes(1);
    },
  );

  it("does not admit mutation stages into the read retry port", async () => {
    const f = readFixture();
    const action = vi.fn();
    await expect(
      checkpointObservationRead(action, { ...f.context, stage: "activate" }),
    ).rejects.toThrow("unsupported observation read stage");
    expect(action).not.toHaveBeenCalled();
  });

  it("does not begin an expired read or grant time for another retry", async () => {
    const expired = readFixture(instant);
    const operation = vi.fn();
    await expect(checkpointObservationRead(operation, expired.context)).rejects.toMatchObject({
      code: "CHECKPOINT_DEADLINE",
    });
    expect(operation).not.toHaveBeenCalled();
    expect(expired.records[0]).toMatchObject({ category: "deadline", retry: false });
    const almostExpired = readFixture(instant + 1000);
    const failure = { status: 504 };
    const read = vi.fn().mockRejectedValue(failure);
    await expect(checkpointObservationRead(read, almostExpired.context)).rejects.toBe(failure);
    expect(read).toHaveBeenCalledTimes(1);
    expect(almostExpired.wait).not.toHaveBeenCalled();
  });
});
