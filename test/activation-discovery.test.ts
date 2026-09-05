import { describe, expect, it } from "vitest";
import {
  FactoryApplicationService,
  type ApplicationSnapshot,
} from "../src/application/services.js";
import { GitHubControlStore } from "../src/control/github-store.js";
import { decodeEventComments, encodeEventComment } from "../src/control/receipts.js";
import { parseFactoryEvent } from "../src/protocol/events.js";
import { cancellationRequestFromComments } from "../src/github.js";
import { DEFAULT_RUN_POLICY, parseRunPolicy } from "../src/protocol/policy.js";

function fixture(fault?: "comment-response" | "label-before" | "label-response") {
  const labels = new Set<string>();
  const repositoryLabels = new Set<string>();
  const comments: string[] = [];
  const writes: string[] = [];
  let faultUsed = false;
  let defaultBase = "a".repeat(40);
  let actor = "operator";
  let loseNextComment = false;
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
      if (route === "GET /user") return response({ login: actor });
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
        if (loseNextComment) {
          loseNextComment = false;
          return response({ message: "lost cancellation response" }, 400);
        }
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
    setActor: (value: string) => {
      actor = value;
    },
    loseNextCommentResponse: () => {
      loseNextComment = true;
    },
    advanceBase: () => {
      defaultBase = "b".repeat(40);
    },
  };
}

// Exercise real Octokit throttling: the longer cancellation/replay sequences
// contain multiple serialized writes and must finish before the next fixture.
describe("plain issue activation discovery", { timeout: 15_000 }, () => {
  it.each([
    { baseSha: "b".repeat(40) },
    { policyDigest: "c".repeat(64) },
    { repository: "fixture/another" },
  ])("rejects an authenticated withdrawal with changed immutable binding %j", (changed) => {
    const binding = {
      objective: 7,
      requestId: "activation",
      repository: "fixture/activation",
      requestedBy: "operator",
      baseSha: "a".repeat(40),
      policyDigest: "b".repeat(64),
    };
    const event = parseFactoryEvent({
      ...binding,
      ...changed,
      protocol: "clockgrove.factory/v2",
      kind: "run",
      event: "ActivationCancellationRequested",
      runId: "activation",
      activationRequestId: "activation",
      requestId: "withdraw",
      sequence: 2,
      at: "2026-09-05T10:00:00Z",
    });
    const comments = [
      {
        body: encodeEventComment("Withdraw", event),
        authorLogin: "operator",
        authorAssociation: "OWNER",
      },
    ];
    expect(() =>
      cancellationRequestFromComments(comments, "real-run", "operator", binding),
    ).toThrow(/immutable activation binding/);
    expect(
      cancellationRequestFromComments(
        [{ ...comments[0]!, authorLogin: "forged-actor" }],
        "real-run",
        "operator",
        binding,
      ),
    ).toBeNull();
    expect(
      cancellationRequestFromComments(comments, "real-run", "operator", {
        ...binding,
        objective: 8,
      }),
    ).toBeNull();
  });
  const cancel = {
    objective: 7,
    requestId: "withdraw-activation",
    reason: "operator withdrew queued work",
  };

  function start(f: ReturnType<typeof fixture>) {
    const activation = f.comments
      .flatMap(decodeEventComments)
      .find((event) => event.event === "ActivationRequested")!;
    const { requestId: _requestId, ...binding } = activation;
    const event = parseFactoryEvent({
      ...binding,
      event: "FactoryRunStarted",
      runId: "actual-started-run",
      activationRequestId: f.activation.requestId,
      actor: "operator",
      objectiveAuthor: "operator",
      fork: false,
      baseBranch: "main",
      sequence: f.comments.length + 1,
    });
    f.comments.push(encodeEventComment("Run adopted activation", event));
  }

  it("withdraws only exact queued authority, reports no invented run, and survives activation replay", async () => {
    const f = fixture();
    const activation = await f.service().activate(f.activation);
    const receipt = await f.service().command("cancel", cancel);
    expect(receipt).toMatchObject({
      event: "ActivationCancellationRequested",
      runId: activation.runId,
      activationRequestId: f.activation.requestId,
      requestedBy: "operator",
      baseSha: "a".repeat(40),
      repository: "fixture/activation",
      policyDigest: activation.policyDigest,
    });
    expect(await f.store.discoverObjectiveActivations()).toEqual([]);
    expect(await f.service().status(7)).toMatchObject({
      activation: {
        requestId: f.activation.requestId,
        state: "withdrawn",
        cancellationRequestId: cancel.requestId,
      },
      run: { availability: "unavailable", state: "not-started" },
    });
    expect(JSON.stringify(await f.service().explain(7))).toContain("was withdrawn");
    f.labels.clear();
    await f.service().activate(f.activation);
    expect(await f.store.discoverObjectiveActivations()).toEqual([]);
    const writes = [...f.writes];
    expect(await f.service().command("cancel", cancel)).toEqual(receipt);
    await expect(f.service().command("cancel", { ...cancel, reason: "different" })).rejects.toThrow(
      /idempotency key/,
    );
    expect(f.writes).toEqual(writes);
    expect(f.comments.flatMap(decodeEventComments).map((event) => event.event)).toEqual([
      "ActivationRequested",
      "ActivationCancellationRequested",
    ]);
  });

  it("repairs cancellation response loss after concurrent run start without reclassifying or duplicating", async () => {
    const f = fixture();
    await f.service().activate(f.activation);
    f.loseNextCommentResponse();
    await expect(f.service().command("cancel", cancel)).rejects.toThrow();
    start(f);
    const writes = [...f.writes];
    expect(await f.service().command("cancel", cancel)).toMatchObject({
      event: "ActivationCancellationRequested",
      runId: f.activation.requestId,
    });
    expect(f.writes).toEqual(writes);
    expect(await f.store.discoverObjectiveActivations()).toHaveLength(1);
    expect(await f.service().status(7)).toMatchObject({
      activation: { state: "cancellation-requested" },
      run: { availability: "observed", runId: "actual-started-run" },
    });
    for (const [index, fields] of [
      { event: "RunPauseRequested", requestId: "pause-racing-run", requestedBy: "operator" },
      { event: "RunPauseAcknowledged", commandRequestId: "pause-racing-run" },
    ].entries()) {
      f.comments.push(
        encodeEventComment(
          "Paused while withdrawal raced",
          parseFactoryEvent({
            protocol: "clockgrove.factory/v2",
            kind: "run",
            objective: 7,
            runId: "actual-started-run",
            sequence: 4 + index,
            at: "2026-09-05T10:00:00Z",
            ...fields,
          }),
        ),
      );
    }
    // Withdrawal remains actionable even when a pause was acknowledged while
    // the queued cancellation/start race was being resolved.
    expect(await f.store.discoverObjectiveActivations()).toHaveLength(1);
  });

  it("does not let an old withdrawal suppress a later distinct activation or change exact replay", async () => {
    const f = fixture();
    await f.service().activate(f.activation);
    const receipt = await f.service().command("cancel", cancel);
    await f.service().activate({ ...f.activation, requestId: "later-activation" });
    expect(await f.service().command("cancel", cancel)).toEqual(receipt);
    expect(await f.store.discoverObjectiveActivations()).toMatchObject([
      { requestId: "later-activation" },
    ]);
    expect(await f.service().status(7)).toMatchObject({
      activation: { requestId: "later-activation", state: "queued" },
    });
  });

  it("allows only the activating actor to withdraw or replay queued authority", async () => {
    const f = fixture();
    await f.service().activate(f.activation);
    const writes = [...f.writes];
    f.setActor("other-maintainer");
    await expect(f.service().command("cancel", cancel)).rejects.toThrow(
      /only the activating actor/,
    );
    expect(f.writes).toEqual(writes);
    f.setActor("operator");
    await f.service().command("cancel", cancel);
    f.setActor("other-maintainer");
    await expect(f.service().command("cancel", cancel)).rejects.toThrow(
      /only the activating actor/,
    );
  });

  it("uses normal run cancellation when start wins, and never withdraws terminal run history", async () => {
    const f = fixture();
    await f.service().activate(f.activation);
    start(f);
    expect(await f.service().command("cancel", cancel)).toMatchObject({
      event: "FactoryRunCancellationRequested",
      runId: "actual-started-run",
    });
    f.comments.push(
      encodeEventComment(
        "Terminal",
        parseFactoryEvent({
          protocol: "clockgrove.factory/v2",
          kind: "run",
          event: "FactoryRunCancelled",
          objective: 7,
          runId: "actual-started-run",
          sequence: 5,
          at: "2026-09-05T10:00:00.000Z",
          reason: "cancelled",
        }),
      ),
    );
    await expect(
      f.service().command("cancel", { ...cancel, requestId: "after-terminal" }),
    ).rejects.toThrow(/no active Factory run or pending activation/);
  });

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
