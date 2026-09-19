import { afterEach, describe, expect, it, vi } from "vitest";

const discoverLocalScopeHost = vi.hoisted(() => vi.fn());

vi.mock("../src/runtime/local-scope.js", () => ({ discoverLocalScopeHost }));

import { main } from "../src/cli.js";

describe("installed local-scope preflight", () => {
  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("reports the production durable local-scope capability", async () => {
    discoverLocalScopeHost.mockResolvedValueOnce({
      hostIdentity: "host",
      producerPid: 42,
      producerStartTicks: "100",
    });
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    await main(["local-scope-preflight"]);

    expect(discoverLocalScopeHost).toHaveBeenCalledOnce();
    expect(JSON.parse(String(stdout.mock.calls.at(-1)![0]))).toEqual({
      protocol: "clockgrove.factory/local-scope-preflight-v1",
      result: "passed",
      capability: "durable-local-scopes",
    });
    expect(process.exitCode).toBeUndefined();
  });

  it("preserves an actionable user-systemd diagnostic when unavailable", async () => {
    discoverLocalScopeHost.mockResolvedValueOnce(null);
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    await main(["local-scope-preflight"]);

    const report = JSON.parse(String(stdout.mock.calls.at(-1)![0]));
    expect(report).toMatchObject({
      protocol: "clockgrove.factory/local-scope-preflight-v1",
      result: "blocked",
      capability: "durable-local-scopes",
      blocker: "durable-local-scopes-unavailable",
    });
    expect(report.reason).toMatch(/systemd 254\+.*systemd manager/);
    expect(process.exitCode).toBe(2);
  });
});
