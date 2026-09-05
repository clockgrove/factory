import { describe, expect, it } from "vitest";
import {
  FactoryApplicationService,
  type ApplicationSnapshot,
} from "../src/application/services.js";
import { GitHubControlStore } from "../src/control/github-store.js";
import { decodeEventComments } from "../src/control/receipts.js";
import { DEFAULT_RUN_POLICY, parseRunPolicy } from "../src/protocol/policy.js";

function fixture(fault?: "comment-response" | "label-before" | "label-response") {
  const labels = new Set<string>();
  const repositoryLabels = new Set<string>();
  const comments: string[] = [];
  const writes: string[] = [];
  let faultUsed = false;
  let defaultBase = "a".repeat(40);
  const store = new GitHubControlStore({
    token: "fixture-only",
    owner: "fixture",
    repo: "activation",
    mutationScheduler: { acquire: async () => ({ waitedMs: 0, release: () => {} }) },
    requestFetch: async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const route = `${request.method} ${url.pathname}`;
      const data = (request.method === "POST" ? await request.json() : {}) as {
        body: string;
        name: string;
        labels: string[];
      };
      if (request.method === "POST") writes.push(route);
      const response = (value: unknown, status = 200) =>
        Response.json(value, { status, headers: { date: "Sat, 05 Sep 2026 10:00:00 GMT" } });
      const issue = { number: 7, state: "open", labels: [...labels].map((name) => ({ name })) };
      if (route === "GET /user") return response({ login: "operator" });
      if (route === "GET /repos/fixture/activation") return response({});
      if (route === "GET /repos/fixture/activation/issues")
        return response(
          !url.searchParams.get("labels") || labels.has(url.searchParams.get("labels")!)
            ? [issue]
            : [],
        );
      if (route === "GET /repos/fixture/activation/issues/7") return response(issue);
      if (route === "GET /repos/fixture/activation/issues/7/comments")
        return response(
          comments.map((body, index) => ({
            id: index + 1,
            body,
            user: { login: "operator" },
            author_association: "OWNER",
          })),
        );
      if (route === "POST /repos/fixture/activation/issues/7/comments") {
        comments.push(data.body);
        if (!faultUsed && fault === "comment-response") {
          faultUsed = true;
          return response({ message: "lost activation response" }, 400);
        }
        return response({ id: comments.length });
      }
      if (route.startsWith("GET /repos/fixture/activation/labels/")) {
        const name = decodeURIComponent(url.pathname.split("/").at(-1)!);
        return response(
          repositoryLabels.has(name) ? { name } : { message: "Not Found" },
          repositoryLabels.has(name) ? 200 : 404,
        );
      }
      if (route === "POST /repos/fixture/activation/labels") {
        repositoryLabels.add(data.name);
        return response({ name: data.name });
      }
      if (route === "POST /repos/fixture/activation/issues/7/labels") {
        if (!faultUsed && fault === "label-before") {
          faultUsed = true;
          return response({ message: "label write unavailable" }, 400);
        }
        for (const name of data.labels) {
          if (!repositoryLabels.has(name)) return response({ message: "label missing" }, 422);
          labels.add(name);
        }
        if (!faultUsed && fault === "label-response") {
          faultUsed = true;
          return response({ message: "lost label response" }, 400);
        }
        return response([...labels].map((name) => ({ name })));
      }
      throw new Error(`unexpected fixture route ${route}`);
    },
  });
  const reader = {
    readObjective: async (): Promise<ApplicationSnapshot> => ({
      id: "objective-node",
      number: 7,
      title: "Plain human issue",
      defaultBranch: "main",
      workItems: [],
      factoryEvents: comments.flatMap(decodeEventComments),
    }),
  };
  const service = () =>
    new FactoryApplicationService({
      owner: "fixture",
      repo: "activation",
      reader,
      store,
      readBaseSha: async () => defaultBase,
    });
  const activation = { objective: 7, requestId: "activate-plain-issue", baseSha: "a".repeat(40) };
  return {
    store,
    service,
    activation,
    labels,
    comments,
    writes,
    repositoryLabels,
    advanceBase: () => {
      defaultBase = "b".repeat(40);
    },
  };
}

describe("plain issue activation discovery", () => {
  it("repairs implicit-base replay from the original receipt after trunk advances", async () => {
    const f = fixture("label-before");
    const input = { objective: 7, requestId: f.activation.requestId };
    const policy = parseRunPolicy({
      ...DEFAULT_RUN_POLICY,
      objectiveTimeoutMinutes: DEFAULT_RUN_POLICY.objectiveTimeoutMinutes + 1,
    });
    await expect(f.service().activate({ ...input, policy })).rejects.toThrow();
    f.advanceBase();
    expect(await f.service().activate(input)).toMatchObject({ baseSha: "a".repeat(40), policy });
    expect(await f.store.discoverObjectiveActivations()).toHaveLength(1);
    expect(f.comments).toHaveLength(1);
    const writes = [...f.writes];
    await expect(f.service().activate({ ...input, baseSha: "b".repeat(40) })).rejects.toThrow(
      /idempotency key/,
    );
    await expect(f.service().activate({ ...input, policy: DEFAULT_RUN_POLICY })).rejects.toThrow(
      /idempotency key/,
    );
    expect(f.writes).toEqual(writes);
  });

  it("binds a subsequent explicit activation to its own request identity", async () => {
    const f = fixture();
    await f.service().activate(f.activation);
    const requestId = "second-explicit-activation";
    expect(await f.service().activate({ ...f.activation, requestId })).toMatchObject({
      runId: requestId,
      requestId,
    });
    expect(await f.store.discoverObjectiveActivations()).toMatchObject([{ requestId }]);
  });

  it("makes an explicitly activated plain issue discoverable without label-only authority", async () => {
    const f = fixture();
    expect(await f.store.discoverObjectiveActivations()).toEqual([]);
    f.labels.add("factory:objective");
    expect(await f.store.discoverObjectiveActivations()).toEqual([]);
    f.labels.clear();
    f.labels.add("human-label");
    await f.service().activate(f.activation);
    expect(await f.store.discoverObjectiveActivations()).toMatchObject([
      { objective: 7, requestId: f.activation.requestId },
    ]);
    expect(f.labels).toEqual(new Set(["human-label", "factory:objective"]));
    expect(f.comments).toHaveLength(1);
  });

  it.each(["comment-response", "label-before", "label-response"] as const)(
    "repairs %s with exact activation replay and no duplicate receipt",
    async (fault) => {
      const f = fixture(fault);
      await expect(f.service().activate(f.activation)).rejects.toThrow();
      expect(f.comments).toHaveLength(1);
      const receipt = await f.service().activate(f.activation);
      expect(receipt).toMatchObject({
        event: "ActivationRequested",
        requestId: f.activation.requestId,
      });
      expect(await f.store.discoverObjectiveActivations()).toHaveLength(1);
      expect(f.comments).toHaveLength(1);
      const completedWrites = [...f.writes];
      expect(await f.service().activate(f.activation)).toEqual(receipt);
      expect(f.writes).toEqual(completedWrites);
    },
  );

  it("does not repair discoverability for a conflicting activation replay", async () => {
    const f = fixture();
    await f.service().activate(f.activation);
    f.labels.clear();
    const completedWrites = [...f.writes];
    await expect(
      f.service().activate({ ...f.activation, baseSha: "b".repeat(40) }),
    ).rejects.toThrow(/idempotency key/);
    expect(f.writes).toEqual(completedWrites);
    expect(await f.store.discoverObjectiveActivations()).toEqual([]);
  });
});
