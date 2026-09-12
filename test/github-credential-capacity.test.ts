import { beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => vi.resetModules());

describe("process credential capacity", () => {
  it("retains shared quota and in-flight admission across 16 credentials and refuses the seventeenth", async () => {
    const platform = await import("../src/platform.js");
    const { createOctokit } = await import("../src/github.js");
    const token = "first-credential";
    const quota = platform.primaryQuotaForCredential(token);
    quota.observe({
      "x-ratelimit-resource": "core",
      "x-ratelimit-limit": "5000",
      "x-ratelimit-remaining": String(platform.GITHUB_PRIMARY_PROTECTED_RESERVE + 1),
      "x-ratelimit-reset": String(Math.floor(Date.now() / 1_000) + 3600),
    });
    const release = platform.admitGitHubRequest(token, quota, "https://api.github.com/user", {});
    for (let index = 1; index < 16; index++) {
      // Mix entry points: both must use the same capacity and preserve the first entry.
      if (index % 2) platform.githubRequestTelemetryForCredential(`credential-${index}`);
      else platform.primaryQuotaForCredential(`credential-${index}`);
    }
    const requestFetch = vi.fn<typeof fetch>();
    expect(() =>
      createOctokit({ token: "credential-17", owner: "o", repo: "r", requestFetch }),
    ).toThrow("at most 16 distinct GitHub credentials");
    expect(() =>
      createOctokit({
        token: "credential-17",
        owner: "o",
        repo: "r",
        requestFetch,
        primaryQuota: new platform.GitHubPrimaryQuotaCache(),
      }),
    ).toThrow("at most 16 distinct GitHub credentials");
    expect(() => platform.githubRequestTelemetryForCredential("credential-17")).toThrow(
      "at most 16 distinct GitHub credentials",
    );
    expect(requestFetch).not.toHaveBeenCalled();
    expect(platform.primaryQuotaForCredential(token)).toBe(quota);
    expect(() =>
      platform.admitGitHubRequest(token, quota, "https://api.github.com/user", {}),
    ).toThrow(platform.GitHubPrimaryAdmissionDeferredError);
    expect(platform.githubRequestTelemetryForCredential(token).endpoints).toContainEqual(
      expect.objectContaining({ admitted: 1, transported: 0 }),
    );
    release();
    const reused = createOctokit({ token, owner: "o", repo: "r", requestFetch });
    expect(reused).toBeDefined();
    const releaseAgain = platform.admitGitHubRequest(
      token,
      quota,
      "https://api.github.com/user",
      {},
    );
    releaseAgain();
    expect(platform.githubRequestTelemetryForCredential(token).endpoints).toContainEqual(
      expect.objectContaining({ admitted: 2, transported: 0 }),
    );
  });
});
