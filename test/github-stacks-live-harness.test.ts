import { describe, expect, it, vi } from "vitest";

import { GitHubStacks, type GitHubStackTransport } from "../src/publication/github-stacks.js";
import { loseAcknowledgedResponse } from "./helpers/github-stack-response-loss.js";

describe("native-stack live harness fault injection (credential-free)", () => {
  it("drops only the first matching acknowledged mutation response", async () => {
    const request = vi.fn().mockResolvedValue({ status: 201, data: { number: 1 } });
    const fault = loseAcknowledgedResponse({ request }, "create", 201);
    await expect(fault.transport.request("other", {}, true)).resolves.toMatchObject({
      status: 201,
    });
    await expect(fault.transport.request("create", {}, false)).resolves.toMatchObject({
      status: 201,
    });
    expect(fault.lost()).toBe(false);
    await expect(fault.transport.request("create", { binding: "retained" }, true)).rejects.toThrow(
      "Injected response loss",
    );
    expect(request).toHaveBeenLastCalledWith("create", { binding: "retained" }, true);
    expect(fault.lost()).toBe(true);
    await expect(fault.transport.request("create", {}, true)).resolves.toMatchObject({
      status: 201,
    });
    expect(request).toHaveBeenCalledTimes(4);
  });

  it("does not disguise a refusal or consume the injection before success", async () => {
    const refused = new Error("platform refused mutation");
    const request = vi
      .fn()
      .mockRejectedValueOnce(refused)
      .mockResolvedValueOnce({ status: 409, data: {} })
      .mockResolvedValueOnce({ status: 201, data: {} });
    const fault = loseAcknowledgedResponse({ request }, "create", 201);
    await expect(fault.transport.request("create", {}, true)).rejects.toBe(refused);
    await expect(fault.transport.request("create", {}, true)).resolves.toMatchObject({
      status: 409,
    });
    expect(fault.lost()).toBe(false);
    await expect(fault.transport.request("create", {}, true)).rejects.toThrow(
      "Injected response loss",
    );
    expect(fault.lost()).toBe(true);
  });

  it.each(["create", "extend"] as const)(
    "proves %s response loss is recovered from the server and fresh-client replay stays read-only",
    async (operation) => {
      let members = operation === "create" ? [] : [1, 2];
      const stackData = () => ({
        number: 7,
        base: { ref: "fixture-base" },
        open: true,
        pull_requests: members.map((number) => ({
          number,
          state: "open",
          head: { ref: `fixture-${number}`, sha: String(number).repeat(40) },
        })),
      });
      let writes = 0;
      const routeToLose =
        operation === "create"
          ? "POST /repos/{owner}/{repo}/stacks"
          : "POST /repos/{owner}/{repo}/stacks/{stack_number}/add";
      const transport: GitHubStackTransport = {
        async request(route, parameters, mutating) {
          if (mutating) {
            expect(route).toBe(routeToLose);
            writes += 1;
            members =
              operation === "create"
                ? (parameters.pull_requests as number[])
                : [...members, ...(parameters.pull_requests as number[])];
            return { status: operation === "create" ? 201 : 200, data: stackData() };
          }
          if (route === "GET /repos/{owner}/{repo}/stacks") {
            return { status: 200, data: members.length ? [stackData()] : [] };
          }
          expect(route).toBe("GET /repos/{owner}/{repo}/stacks/{stack_number}");
          return { status: 200, data: stackData() };
        },
      };
      const fault = loseAcknowledgedResponse(
        transport,
        routeToLose,
        operation === "create" ? 201 : 200,
      );
      const perform = (stacks: GitHubStacks) =>
        operation === "create" ? stacks.ensureStack([1, 2]) : stacks.ensureExtended(7, [1, 2], [3]);
      const recovered = await perform(new GitHubStacks(fault.transport, "fixture", "repo"));
      expect(fault.lost()).toBe(true);
      expect(recovered.pullRequests.map((pull) => pull.number)).toEqual(members);
      expect(await perform(new GitHubStacks(transport, "fixture", "repo"))).toEqual(recovered);
      expect(writes).toBe(1);
    },
  );
});
