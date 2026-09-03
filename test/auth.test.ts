import { describe, expect, it, vi } from "vitest";

import { resolveGitHubToken } from "../src/auth.js";

describe("GitHub authentication", () => {
  it("prefers GITHUB_TOKEN without invoking gh", () => {
    const readGhToken = vi.fn(() => "from-gh");

    expect(resolveGitHubToken({ GITHUB_TOKEN: " direct " }, readGhToken)).toBe("direct");
    expect(readGhToken).not.toHaveBeenCalled();
  });

  it("accepts GH_TOKEN without invoking gh", () => {
    const readGhToken = vi.fn(() => "from-gh");

    expect(resolveGitHubToken({ GH_TOKEN: " alias " }, readGhToken)).toBe("alias");
    expect(readGhToken).not.toHaveBeenCalled();
  });

  it("falls back to the authenticated GitHub CLI", () => {
    expect(resolveGitHubToken({}, () => " cli-token\n")).toBe("cli-token");
  });

  it("gives an actionable error without exposing command output", () => {
    expect(() =>
      resolveGitHubToken({}, () => {
        throw new Error("secret-bearing gh failure");
      }),
    ).toThrow("set GITHUB_TOKEN or GH_TOKEN, or run `gh auth login`");
  });
});
