import { describe, expect, it, vi } from "vitest";
import { createCheckpointList } from "../scripts/verify-local-checkpoint-restart.mjs";
import {
  qualificationNamespaceMarker,
  waitForCreatedObjectiveNamespace,
} from "../scripts/verify-live-objective.mjs";

const instant = Date.parse("2026-09-07T07:00:00Z");
const namespace = "checkpoint-list-contract";
const createdIssue = {
  number: 109,
  id: 109001,
  body: qualificationNamespaceMarker(namespace),
};

describe("checkpoint namespace list adapter", () => {
  it("passes the actual shared namespace helper's 1000-entry limit without treating it as a deadline", async () => {
    const request = vi.fn(async () => ({ data: [createdIssue] }));
    const list = createCheckpointList(request, { now: () => instant });
    await waitForCreatedObjectiveNamespace({ list, namespace, createdIssue });
    expect(request).toHaveBeenCalledExactlyOnceWith(
      "GET /repos/{owner}/{repo}/issues",
      { state: "all", page: 1, per_page: 100 },
      15000,
    );
  });

  it("retries only successful absent namespace observations through the real list adapter", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ data: [createdIssue] });
    const wait = vi.fn(async () => {});
    await waitForCreatedObjectiveNamespace({
      list: createCheckpointList(request, { now: () => instant }),
      namespace,
      createdIssue,
      wait,
    });
    expect(wait).toHaveBeenCalledExactlyOnceWith(1000);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls.every((call) => call[2] === 15000)).toBe(true);
  });

  it("preserves failure rather than retrying a refused namespace read", async () => {
    const failure = Object.assign(Error("read refused"), { status: 403 });
    const request = vi.fn().mockRejectedValue(failure);
    const wait = vi.fn(async () => {});
    await expect(
      waitForCreatedObjectiveNamespace({
        list: createCheckpointList(request),
        namespace,
        createdIssue,
        wait,
      }),
    ).rejects.toBe(failure);
    expect(request).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it("enforces the caller's entry limit across pages without returning a partial list", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ data: Array.from({ length: 100 }, () => createdIssue) })
      .mockResolvedValueOnce({ data: Array.from({ length: 51 }, () => createdIssue) });
    const list = createCheckpointList(request);
    await expect(list("GET /repos/{owner}/{repo}/issues", {}, 150)).rejects.toThrow(
      "paginated GitHub observation bound exceeded",
    );
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("keeps deadline accounting explicit and refuses the next page after expiry", async () => {
    let now = instant;
    const request = vi.fn(async () => {
      now += 2000;
      return { data: Array.from({ length: 100 }, () => createdIssue) };
    });
    const list = createCheckpointList(request, { now: () => now });
    await expect(
      list("GET /repos/{owner}/{repo}/issues", {}, 1000, {
        deadline: instant + 2000,
      }),
    ).rejects.toMatchObject({ code: "CHECKPOINT_DEADLINE" });
    expect(request).toHaveBeenCalledExactlyOnceWith(
      "GET /repos/{owner}/{repo}/issues",
      { page: 1, per_page: 100 },
      2000,
    );
  });

  it("rejects an already expired explicit deadline before any read", async () => {
    const request = vi.fn(async () => ({ data: [] }));
    const list = createCheckpointList(request, { now: () => instant });
    await expect(
      list("GET /repos/{owner}/{repo}/issues", {}, 1000, {
        deadline: instant,
      }),
    ).rejects.toMatchObject({ code: "CHECKPOINT_DEADLINE" });
    expect(request).not.toHaveBeenCalled();
  });

  it("retains the ten-page completeness fence even with a larger entry allowance", async () => {
    const request = vi.fn(async () => ({ data: Array.from({ length: 100 }, () => createdIssue) }));
    const list = createCheckpointList(request);
    await expect(list("GET /repos/{owner}/{repo}/issues", {}, 2000)).rejects.toThrow(
      "complete bounded GitHub listing unavailable",
    );
    expect(request).toHaveBeenCalledTimes(10);
  });
});
