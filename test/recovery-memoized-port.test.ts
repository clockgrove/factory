import { describe, expect, it, vi } from "vitest";
import { GitHubControlStore } from "../src/control/github-store.js";
import { recoveryReadPort } from "../src/recovery/github-read-port.js";
import { boundedReadStore } from "../src/recovery/runtime.js";

function productionPort() {
  const requestFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    expect(request.method).toBe("GET");
    return new Response(JSON.stringify({ object: { sha: "a".repeat(40) } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  const store = new GitHubControlStore({
    owner: "fixture",
    repo: "project",
    token: "test-token",
    requestFetch,
  });
  return { port: recoveryReadPort(store, "fixture", "project"), requestFetch };
}

describe("memoized production recovery read port", () => {
  it("memoizes concurrent and detached reads from the frozen production capability port", async () => {
    const { port, requestFetch } = productionPort();
    expect(Object.isFrozen(port)).toBe(true);
    const wrapped = boundedReadStore(port);
    const detached = wrapped.readRef;
    const first = detached("refs/heads/main");
    const second = wrapped.readRef("refs/heads/main");
    expect(second).toBe(first);
    await expect(first).resolves.toBe("a".repeat(40));
    await expect(wrapped.readRef("refs/heads/main")).resolves.toBe("a".repeat(40));
    expect(requestFetch).toHaveBeenCalledTimes(1);
    await expect(wrapped.readRef("refs/heads/other")).resolves.toBe("a".repeat(40));
    expect(requestFetch).toHaveBeenCalledTimes(2);
    for (const method of [
      "createRef",
      "createCommit",
      "addIssueComment",
      "stackRequest",
      "deleteRef",
    ])
      expect(Reflect.get(wrapped, method)).toBeUndefined();
    expect(Object.isFrozen(port)).toBe(true);
  });
  it("caches rejected reads and synchronous reader faults without retrying", async () => {
    const { port } = productionPort();
    for (const synchronous of [false, true]) {
      const error = new Error("reader failure");
      const readRef = vi.fn(() => {
        if (synchronous) throw error;
        return Promise.reject(error);
      });
      const wrapped = boundedReadStore(Object.freeze({ ...port, readRef }));
      const pending = wrapped.readRef("refs/heads/main");
      await expect(pending).rejects.toBe(error);
      expect(wrapped.readRef("refs/heads/main")).toBe(pending);
      await expect(wrapped.readRef("refs/heads/main")).rejects.toBe(error);
      expect(readRef).toHaveBeenCalledTimes(1);
    }
  });
  it("counts unique reads against the bound while allowing cached reads after exhaustion", async () => {
    const { port } = productionPort();
    const readRef = vi.fn(async () => null);
    const wrapped = boundedReadStore(Object.freeze({ ...port, readRef }));
    for (let index = 0; index < 1024; index++) await wrapped.readRef(`refs/heads/${index}`);
    expect(() => wrapped.readRef("refs/heads/overflow")).toThrow("runtime-read-bound");
    await expect(wrapped.readRef("refs/heads/0")).resolves.toBeNull();
    expect(readRef).toHaveBeenCalledTimes(1024);
  });
});
