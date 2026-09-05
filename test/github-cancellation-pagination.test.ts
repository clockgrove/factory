import { describe, expect, it } from "vitest";
import { encodeEventComment } from "../src/control/receipts.js";
import { GitHubReader, RECOVERY_READER_LIMITS } from "../src/github.js";
import { parseFactoryEvent } from "../src/protocol/events.js";

const binding = {
  objective: 7,
  requestId: "activation",
  repository: "fixture/activation",
  requestedBy: "operator",
  baseSha: "a".repeat(40),
  policyDigest: "b".repeat(64),
};
const cancellation = parseFactoryEvent({
  ...binding,
  protocol: "clockgrove.factory/v2",
  kind: "run",
  event: "ActivationCancellationRequested",
  runId: binding.requestId,
  activationRequestId: binding.requestId,
  requestId: "withdraw",
  sequence: 102,
  at: "2026-09-05T10:00:00Z",
});

function fixture(pageResponse: (page: number) => Response) {
  const requests: URL[] = [];
  const reader = new GitHubReader({
    token: "fixture-only",
    owner: "fixture",
    repo: "activation",
    requestFetch: async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      expect(request.method).toBe("GET");
      expect(url.pathname).toBe("/repos/fixture/activation/issues/7/comments");
      requests.push(url);
      return pageResponse(Number(url.searchParams.get("page") ?? 1));
    },
  });
  return { reader, requests };
}

function page(comments: unknown[], next?: number) {
  return Response.json(comments, {
    headers: next
      ? {
          link: `<https://api.github.com/repos/fixture/activation/issues/7/comments?per_page=100&page=${next}>; rel="next"`,
        }
      : {},
  });
}

describe("bounded cancellation receipt pagination", () => {
  it("finds withdrawal after the first 100 ascending issue comments without unsupported sorting", async () => {
    const f = fixture((number) =>
      number === 1
        ? page(
            Array.from({ length: 100 }, (_, index) => ({
              id: index + 1,
              body: "ordinary issue history",
            })),
            2,
          )
        : page([
            {
              id: 101,
              body: encodeEventComment("Withdraw", cancellation),
              user: { login: "operator" },
              author_association: "OWNER",
            },
          ]),
    );
    expect(await f.reader.readRunCancellationRequest(7, "real-run", "operator", binding)).toEqual(
      cancellation,
    );
    expect(f.requests.map((url) => url.searchParams.get("page"))).toEqual(["1", "2"]);
    expect(
      f.requests.every(
        (url) => !url.searchParams.has("sort") && !url.searchParams.has("direction"),
      ),
    ).toBe(true);
  });

  it("does not report absence when the next history page is unavailable", async () => {
    const f = fixture((number) =>
      number === 1
        ? page([{ id: 1, body: "ordinary" }], 2)
        : Response.json({ message: "history unavailable" }, { status: 403 }),
    );
    await expect(
      f.reader.readRunCancellationRequest(7, "real-run", "operator", binding),
    ).rejects.toThrow();
    expect(f.requests).toHaveLength(2);
  });

  it("fails closed at the existing bounded history limit instead of treating truncation as no cancellation", async () => {
    const f = fixture((number) =>
      page(
        Array.from({ length: 100 }, (_, index) => ({
          id: (number - 1) * 100 + index + 1,
          body: "ordinary issue history",
        })),
        number + 1,
      ),
    );
    await expect(
      f.reader.readRunCancellationRequest(7, "real-run", "operator", binding),
    ).rejects.toThrow(/cancellation.*bound/i);
    expect(f.requests).toHaveLength(RECOVERY_READER_LIMITS.commentsPerIssue / 100);
  });

  it("returns absence only after the complete bounded comment history is inspected", async () => {
    const f = fixture((number) =>
      number === 1 ? page([{ id: 1, body: "ordinary" }], 2) : page([]),
    );
    expect(
      await f.reader.readRunCancellationRequest(7, "real-run", "operator", binding),
    ).toBeNull();
    expect(f.requests).toHaveLength(2);
  });

  it("fails closed when comment bytes exceed the existing history bound", async () => {
    const f = fixture(() =>
      page([{ id: 1, body: "x".repeat(RECOVERY_READER_LIMITS.hydratedBytes) }]),
    );
    await expect(
      f.reader.readRunCancellationRequest(7, "real-run", "operator", binding),
    ).rejects.toThrow(/cancellation.*bound/i);
    expect(f.requests).toHaveLength(1);
  });
});
