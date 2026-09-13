import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubControlStore } from "../src/control/github-store.js";
import { encodeEventComment, encodeEventTrailer } from "../src/control/receipts.js";
import {
  encodeResultReceiptComment,
  RESULT_RECORD_PROTOCOL,
  resultEventsDigest,
  type ResultReceipt,
} from "../src/control/result-receipts.js";
import { reviewIdentityDigest } from "../src/control/reviews.js";
import { createValidationEvidence } from "../src/validation/evidence.js";
import {
  loadValidationCheckpoint,
  validationIdentityDigest,
} from "../src/control/validation-checkpoints.js";
import { parseFactoryEvent } from "../src/protocol/events.js";
import { DEFAULT_RUN_POLICY, policyDigest } from "../src/protocol/policy.js";

const at = "2026-09-13T00:00:00.000Z";
const headers = { date: "Sun, 13 Sep 2026 00:00:00 GMT" };
const oid = "a".repeat(40);
const tree = "b".repeat(40);
const digest = "c".repeat(64);
const policy = policyDigest(DEFAULT_RUN_POLICY);
const initialIdentity = {
  objective: 7,
  workItem: 8,
  runId: "result-fixture",
  attempt: 1,
  baseSha: oid,
  artifactDigest: digest,
  directorEpoch: 1,
  policyDigest: policy,
};
const scope = {
  objective: 7,
  workItem: 8,
  runId: "result-fixture",
  kind: "validation" as const,
  identityDigest: validationIdentityDigest(initialIdentity),
};
const writer = {
  writerEpoch: 1,
  writerHolder: "holder",
  writerOperationId: "operation",
  writerPolicyDigest: policy,
};
function result(overrides: Partial<ResultReceipt> = {}) {
  const identity = {
    ...initialIdentity,
    objective: overrides.objective ?? scope.objective,
    workItem: overrides.workItem ?? scope.workItem,
    runId: overrides.runId ?? scope.runId,
    policyDigest: overrides.writerPolicyDigest ?? policy,
  };
  const identityDigest = validationIdentityDigest(identity);
  const evidence = createValidationEvidence({
    protocol: "clockgrove.factory/validation-v1",
    artifactDigest: digest,
    baseSha: oid,
    outputTreeSha: tree,
    commands: [],
    passed: true,
    startedAt: at,
    completedAt: at,
  });
  const receipt: ResultReceipt = {
    protocol: RESULT_RECORD_PROTOCOL,
    ...scope,
    ...writer,
    baseSha: oid,
    sequence: 3,
    at,
    eventsDigest: digest,
    ...overrides,
    identityDigest,
    content: {
      kind: "inline",
      checkpoint: {
        protocol: "clockgrove.factory/validation-checkpoint-v1",
        identity,
        identityDigest,
        writerEpoch: overrides.writerEpoch ?? writer.writerEpoch,
        evidence,
      },
    },
  };
  const event = parseFactoryEvent({
    protocol: "clockgrove.factory/v2",
    kind: "validation",
    event: "ValidationRecorded",
    objective: receipt.objective,
    workItem: receipt.workItem,
    runId: receipt.runId,
    writerEpoch: receipt.writerEpoch,
    writerHolder: receipt.writerHolder,
    writerOperationId: receipt.writerOperationId,
    writerPolicyDigest: receipt.writerPolicyDigest,
    sequence: 3,
    at,
    attempt: 1,
    baseSha: evidence.baseSha,
    outputTreeSha: evidence.outputTreeSha,
    passed: evidence.passed,
    evidenceDigest: evidence.digest,
  });
  receipt.eventsDigest = resultEventsDigest([event]);
  return encodeResultReceiptComment("Validated", receipt, [event]);
}
function start(selected = true) {
  return encodeEventComment(
    "Run started",
    parseFactoryEvent({
      protocol: "clockgrove.factory/v2",
      kind: "run",
      event: "FactoryRunStarted",
      objective: 7,
      runId: scope.runId,
      sequence: 1,
      at,
      ...writer,
      actor: "operator",
      repository: "o/r",
      objectiveAuthor: "operator",
      fork: false,
      baseBranch: "main",
      policy: DEFAULT_RUN_POLICY,
      policyDigest: policy,
      ...(selected ? { recordProtocol: RESULT_RECORD_PROTOCOL } : {}),
    }),
  );
}
function comment(body: string, id = 1234, login = "operator", association = "OWNER") {
  return { id, body, user: { login }, author_association: association };
}
function fixture() {
  const requests: Array<{ path: string; method: string }> = [];
  let selected = true;
  let epoch = 1;
  let holder = "holder";
  let comments = [comment(result())];
  let pageMode: "single" | "two" | "unbounded" = "single";
  let post: "ok" | "lost" = "ok";
  const port = new GitHubControlStore({
    token: "result-transport-fixture",
    owner: "o",
    repo: "r",
    requestFetch: async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      requests.push({ path: url.pathname + url.search, method: request.method });
      if (request.method === "POST") {
        if (post === "lost")
          return Response.json({ message: "ambiguous upstream failure" }, { status: 500, headers });
        return Response.json({ id: 998877 }, { status: 201, headers });
      }
      if (url.pathname.endsWith("/issues/7/comments"))
        return Response.json([comment(start(selected))], { headers });
      if (url.pathname.endsWith("/issues/8/comments")) {
        const page = Number(url.searchParams.get("page"));
        const more = pageMode === "unbounded" || (pageMode === "two" && page === 1);
        return Response.json(pageMode === "two" && page === 1 ? [] : comments, {
          headers: {
            ...headers,
            ...(more
              ? {
                  link: `<https://api.github.com/repos/o/r/issues/8/comments?page=${page + 1}>; rel="next"`,
                }
              : {}),
          },
        });
      }
      if (url.pathname.includes("/git/ref/"))
        return Response.json({ object: { sha: oid } }, { headers });
      if (url.pathname.includes("/git/commits/"))
        return Response.json(
          {
            sha: oid,
            tree: { sha: tree },
            parents: [],
            committer: { date: at },
            message: encodeEventTrailer(
              parseFactoryEvent({
                protocol: "clockgrove.factory/v2",
                kind: "lease",
                event: "LeaseAcquired",
                objective: 7,
                runId: scope.runId,
                holder,
                epoch,
                sequence: 1,
                at,
                expiresAt: "2026-09-13T00:10:00.000Z",
                policyDigest: policy,
              }),
            ),
          },
          { headers },
        );
      throw Error(`unexpected fixture transport ${request.method} ${url.pathname}`);
    },
  });
  return {
    port,
    requests,
    setSelected: (value: boolean) => {
      selected = value;
    },
    setComments: (value: typeof comments) => {
      comments = value;
    },
    setPages: (value: typeof pageMode) => {
      pageMode = value;
    },
    setOwner: (value: number, owner: string) => {
      epoch = value;
      holder = owner;
    },
    setPost: (value: typeof post) => {
      post = value;
    },
  };
}
afterEach(() => vi.useRealTimers());
async function finish<T>(pending: Promise<T>): Promise<T> {
  let done = false;
  const settled = pending
    .then(
      (value) => ({ value }),
      (error) => ({ error }),
    )
    .finally(() => {
      done = true;
    });
  for (let tick = 0; !done && tick < 3000; tick++) await vi.advanceTimersByTimeAsync(10);
  if (!done) throw Error("result transport did not settle");
  const result = await settled;
  if ("error" in result) throw result.error;
  return result.value;
}

describe("authenticated result receipt transport", () => {
  it.each(["exact", "missing", "other-actor", "other-attempt"] as const)(
    "authenticates the original review dispatch marker: %s",
    async (mode) => {
      const f = fixture();
      const identity = {
        kind: "artifact" as const,
        runId: scope.runId,
        objective: 7,
        workItem: 8,
        attempt: 1,
        artifactDigest: digest,
        baseSha: oid,
        outputTreeSha: tree,
        evidenceDigest: digest,
      };
      const identityDigest = reviewIdentityDigest(identity);
      const invocation = `review-${identityDigest}`;
      const usage = { inputTokens: 4, outputTokens: 2 };
      const common = {
        protocol: "clockgrove.factory/v2",
        objective: 7,
        runId: scope.runId,
        workItem: 8,
        attempt: 1,
        at,
        ...writer,
        directorEpoch: 1,
        policyDigest: policy,
      };
      const marker = parseFactoryEvent({
        ...common,
        kind: "budget",
        event: "BudgetReserved",
        sequence: 2,
        phase: "management",
        unit: "model_tokens",
        amount: 0,
        modelInvocationId: invocation,
        usageId: `invocation-${invocation}`,
        ...(mode === "other-attempt" ? { attempt: 2 } : {}),
      });
      const closure = parseFactoryEvent({
        ...common,
        kind: "budget",
        event: "BudgetReconciled",
        sequence: 3,
        phase: "management",
        unit: "model_tokens",
        amount: 6,
        modelInvocationId: invocation,
        usageId: invocation,
        reportedModelUsage: usage,
      });
      const accepted = parseFactoryEvent({
        ...common,
        kind: "attempt",
        event: "AttemptValidated",
        sequence: 4,
        backend: "codex-sdk/local-worktree",
        baseSha: oid,
        artifactDigest: digest,
      });
      const events = [closure, accepted];
      const body = encodeResultReceiptComment(
        "Reviewed",
        {
          protocol: RESULT_RECORD_PROTOCOL,
          kind: "review",
          objective: 7,
          workItem: 8,
          runId: scope.runId,
          ...writer,
          baseSha: oid,
          identityDigest,
          sequence: 5,
          at,
          eventsDigest: resultEventsDigest(events),
          content: {
            kind: "inline",
            checkpoint: {
              protocol: "clockgrove.factory/review-checkpoint-v1",
              identity,
              identityDigest,
              review: { accepted: true, summary: "Accepted", unmetCriteria: [], risks: [] },
              usage,
            },
          },
        },
        events,
      );
      f.setComments([
        ...(mode === "missing"
          ? []
          : [
              comment(
                encodeEventComment("Dispatch", marker),
                12,
                mode === "other-actor" ? "forger" : "operator",
                "COLLABORATOR",
              ),
            ]),
        comment(body),
      ]);
      const read = f.port.readResultReceipts({ ...scope, kind: "review", identityDigest });
      if (mode === "exact") expect((await read).receipts).toHaveLength(1);
      else await expect(read).rejects.toThrow("exact durable dispatch marker");
    },
  );

  it("reuses only positive authenticated snapshot membership and replaces removed results", async () => {
    const f = fixture();
    const observed = await f.port.readResultReceipts(scope);
    expect(f.requests).toHaveLength(4);
    f.port.observeResultReceipts({
      generation: 1,
      objective: scope.objective,
      receipts: observed.receipts,
    });
    f.requests.length = 0;
    const first = await loadValidationCheckpoint(f.port, initialIdentity);
    const second = await loadValidationCheckpoint(f.port, initialIdentity);
    expect(first!.locator).toEqual(second!.locator);
    expect(f.requests).toHaveLength(0);
    first!.evidence.passed = false;
    expect((await loadValidationCheckpoint(f.port, initialIdentity))!.evidence.passed).toBe(true);
    f.port.observeResultReceipts({ generation: 2, objective: scope.objective, receipts: [] });
    f.port.observeResultReceipts({
      generation: 1,
      objective: scope.objective,
      receipts: observed.receipts,
    });
    f.setComments([]);
    expect(await loadValidationCheckpoint(f.port, initialIdentity)).toBeNull();
    expect(f.requests).toHaveLength(3);
    // This absence cannot hide a later external result, even without another snapshot.
    f.setComments([comment(result())]);
    expect(await loadValidationCheckpoint(f.port, initialIdentity)).not.toBeNull();
    expect(f.requests).toHaveLength(6);
    // Local acknowledgment is not an authenticated snapshot observation.
    expect(f.port.observedResultReceipts(scope)).toBeUndefined();
    const cold = fixture();
    expect(await loadValidationCheckpoint(cold.port, initialIdentity)).not.toBeNull();
    expect(cold.requests).toHaveLength(4);
  });
  it("does not reuse a positive result for another immutable identity or Objective", async () => {
    const f = fixture();
    const observed = await f.port.readResultReceipts(scope);
    f.port.observeResultReceipts({
      generation: 1,
      objective: scope.objective,
      receipts: observed.receipts,
    });
    expect(f.port.observedResultReceipts({ ...scope, identityDigest: digest })).toBeUndefined();
    expect(f.port.observedResultReceipts({ ...scope, objective: 9 })).toBeUndefined();
  });

  it("selects the authenticated run protocol and exact actual comment identity", async () => {
    const f = fixture();
    const observed = await f.port.readResultReceipts(scope);
    expect(observed.protocol).toBe(RESULT_RECORD_PROTOCOL);
    expect(observed.receipts).toHaveLength(1);
    expect(observed.receipts[0]!.commentId).toBe("1234");
    expect(f.requests.map((x) => x.path)).toEqual([
      "/repos/o/r/issues/7/comments?per_page=100&page=1",
      "/repos/o/r/issues/8/comments?per_page=100&page=1",
      "/repos/o/r/git/ref/clockgrove-factory%2Fleases%2Fobjective-7",
      `/repos/o/r/git/commits/${oid}`,
    ]);
  });
  it("ignores forged collaborator and untrusted same-login envelopes", async () => {
    const f = fixture();
    f.setComments([
      comment(result(), 10, "other", "COLLABORATOR"),
      comment(result(), 11, "operator", "NONE"),
    ]);
    expect((await f.port.readResultReceipts(scope)).receipts).toEqual([]);
  });
  it("keeps historical runs explicitly on their legacy representation", async () => {
    const f = fixture();
    f.setSelected(false);
    expect(await f.port.readResultReceipts(scope)).toEqual({ protocol: null, receipts: [] });
  });
  it("hydrates all linked pages before observing authority", async () => {
    const f = fixture();
    f.setPages("two");
    expect((await f.port.readResultReceipts(scope)).receipts).toHaveLength(1);
    expect(f.requests[2]!.path).toContain("page=2");
    expect(f.requests[3]!.path).toContain("/git/ref/");
  });
  it("fails closed on history still incomplete at the pagination bound", async () => {
    const f = fixture();
    f.setPages("unbounded");
    await expect(f.port.readResultReceipts(scope)).rejects.toThrow(/complete pagination bound/);
    expect(f.requests.filter((x) => x.path.includes("/issues/8/comments"))).toHaveLength(20);
    expect(f.requests.some((x) => x.path.includes("/git/ref/"))).toBe(false);
  });
  it.each([
    { objective: 9 },
    { workItem: 9 },
    { writerPolicyDigest: "d".repeat(64) },
    { writerHolder: "forged" },
    { writerEpoch: 2 },
  ])("rejects authenticated scope or writer mismatch %j", async (overrides) => {
    const f = fixture();
    f.setComments([comment(result(overrides))]);
    const selectedScope = {
      ...scope,
      ...(overrides.writerPolicyDigest
        ? {
            identityDigest: validationIdentityDigest({
              ...initialIdentity,
              policyDigest: overrides.writerPolicyDigest,
            }),
          }
        : {}),
    };
    await expect(f.port.readResultReceipts(selectedScope)).rejects.toThrow(
      /another issue|writer differs/,
    );
  });
  it("reads takeover after comments and retains older authenticated results only as historical facts", async () => {
    const f = fixture();
    f.setOwner(2, "successor");
    const observed = await f.port.readResultReceipts(scope);
    expect(observed.receipts[0]!.receipt.writerEpoch).toBe(1);
    expect(f.requests.findIndex((x) => x.path.includes("/git/ref/"))).toBeGreaterThan(
      f.requests.findIndex((x) => x.path.includes("/issues/8/comments")),
    );
  });
  it("returns the actual publication comment id and never replays an ambiguous POST", async () => {
    vi.useFakeTimers();
    const success = fixture();
    expect(
      await finish(success.port.publishResultReceipt({ issueNodeId: "I_8", body: result() })),
    ).toEqual({ commentId: "998877" });
    expect(success.requests).toHaveLength(1);
    const lost = fixture();
    lost.setPost("lost");
    await expect(
      finish(lost.port.publishResultReceipt({ issueNodeId: "I_8", body: result() })),
    ).rejects.toThrow();
    expect(lost.requests.filter((x) => x.method === "POST")).toHaveLength(1);
  });
});
