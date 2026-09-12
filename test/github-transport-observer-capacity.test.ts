import { describe, expect, it, vi } from "vitest";

// Hold requests before the transport and release them outside the caller's async
// context, as an external queue can do. This makes observer-header retention observable.
const queued = vi.hoisted(() => [] as Array<() => Promise<void>>);
vi.mock("@octokit/core", () => {
  class Octokit {
    static plugin() {
      return Octokit;
    }
    hook = { after: () => {} };
    request;
    graphql;
    constructor(options: { request: { fetch: typeof fetch } }) {
      const enqueue = (url: string, headers: RequestInit["headers"] | undefined) =>
        new Promise((resolve, reject) => {
          queued.push(async () => {
            try {
              resolve(await options.request.fetch(url, headers ? { headers } : {}));
            } catch (error) {
              reject(error);
            }
          });
        });
      this.request = Object.assign(
        (_route: string, parameters?: { headers?: RequestInit["headers"] }) =>
          enqueue("https://api.github.com/user", parameters?.headers),
        { endpoint: () => ({ url: "https://api.github.com/user", method: "GET", headers: {} }) },
      );
      this.graphql = (_query: string, variables?: { headers?: RequestInit["headers"] }) =>
        enqueue("https://api.github.com/graphql", variables?.headers);
    }
  }
  return { Octokit };
});

import { createOctokit, withGitHubTransportCallbacks } from "../src/github.js";
import { GitHubPrimaryQuotaCache, withGitHubRequestPriority } from "../src/platform.js";

describe("transport observer capacity", () => {
  it.each(["rest", "graphql"] as const)(
    "%s overflow preserves all 1,024 observers and releases its admission permit",
    async (kind) => {
      const quota = new GitHubPrimaryQuotaCache();
      const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
        expect(new Headers(init?.headers).has("x-clockgrove-factory-transport-observer")).toBe(
          false,
        );
        return new Response("{}", { headers: { "content-type": "application/json" } });
      });
      const client = createOctokit({
        token: `observer-${kind}`,
        owner: "o",
        repo: "r",
        primaryQuota: quota,
        requestFetch: fetch,
      });
      const invoke = () =>
        withGitHubRequestPriority(
          "normal",
          () =>
            kind === "rest"
              ? client.request("GET /user")
              : client.graphql("query { viewer { login } }"),
          1,
        );
      const callbacks = Array.from({ length: 1024 }, () => vi.fn());
      const pending = callbacks.map((onTransported) =>
        withGitHubTransportCallbacks({ onTransported }, invoke),
      );
      const overflowCallback = vi.fn();
      await expect(
        withGitHubTransportCallbacks({ onTransported: overflowCallback }, invoke),
      ).rejects.toThrow("at most 1,024 simultaneous GitHub transport observers");
      expect(queued).toHaveLength(1024);
      expect(fetch).not.toHaveBeenCalled();
      // Completing the oldest request must still deliver its observer, and frees a slot.
      await queued.shift()!();
      await pending[0];
      expect(callbacks[0]).toHaveBeenCalledTimes(1);
      // Exactly one additional protected request fits alongside the 1,023 still held.
      // A leaked permit from overflow would cause admission to fail here.
      quota.observe({
        "x-ratelimit-resource": kind === "rest" ? "core" : "graphql",
        "x-ratelimit-limit": "5000",
        "x-ratelimit-remaining": "1024",
        "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
      });
      const recoveryCallback = vi.fn();
      const recovered = withGitHubTransportCallbacks({ onTransported: recoveryCallback }, () =>
        withGitHubRequestPriority(
          "protected",
          () =>
            kind === "rest"
              ? client.request("GET /user")
              : client.graphql("query { viewer { login } }"),
          1,
        ),
      );
      expect(queued).toHaveLength(1024);
      await Promise.all(queued.splice(0).map((transport) => transport()));
      await Promise.all([...pending, recovered]);
      for (const callback of callbacks) expect(callback).toHaveBeenCalledTimes(1);
      expect(recoveryCallback).toHaveBeenCalledTimes(1);
      expect(overflowCallback).not.toHaveBeenCalled();
      expect(fetch).toHaveBeenCalledTimes(1025);
    },
  );
});
