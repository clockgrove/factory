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

function fixture(pageResponse: (page: number, url: URL) => Response) {
  const requests: URL[] = [];
  const reader = new GitHubReader({
    token: "fixture-only",
    owner: "fixture",
    repo: "activation",
    requestFetch: async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      expect(request.method).toBe("GET");
      expect(url.pathname).toMatch(/^\/repos\/fixture\/activation\/issues\/\d+\/comments$/);
      requests.push(url);
      return pageResponse(Number(url.searchParams.get("page") ?? 1), url);
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

describe("active cancellation observation cursor", () => {
  const start = "2026-09-12T10:00:00Z";
  const comment = (id: number, body = "ordinary", updated_at = start) => ({
    id,
    body,
    updated_at,
    user: { login: "operator" },
    author_association: "OWNER",
  });
  function dated(comments: unknown[], date = start, next?: number) {
    const response = page(comments, next);
    response.headers.set("date", new Date(date).toUTCString());
    return response;
  }
  const poll = (reader: GitHubReader) =>
    reader.readRunCancellationRequest(7, "real-run", "operator", binding);

  it("bootstraps all pages once, then performs one transport per unchanged poll", async () => {
    const f = fixture((number, url) =>
      url.searchParams.has("since")
        ? dated([])
        : dated(
            Array.from({ length: 100 }, (_, i) => comment((number - 1) * 100 + i + 1)),
            start,
            number < 10 ? number + 1 : undefined,
          ),
    );
    expect(await poll(f.reader)).toBeNull();
    expect(f.requests).toHaveLength(10);
    for (let i = 0; i < 10; i++) expect(await poll(f.reader)).toBeNull();
    expect(f.requests).toHaveLength(20);
    expect(
      f.requests
        .slice(10)
        .every((url) => url.searchParams.get("since") === "2026-09-12T09:59:58.000Z"),
    ).toBe(true);
  });

  it.each(["created", "edited"])(
    "observes a %s authenticated same-second request and deduplicates overlap",
    async (change) => {
      let changed = false;
      const f = fixture((_number, url) =>
        dated(
          changed
            ? [
                comment(change === "edited" ? 1 : 2, encodeEventComment("Withdraw", cancellation)),
                comment(change === "edited" ? 1 : 2, encodeEventComment("Withdraw", cancellation)),
              ]
            : url.searchParams.has("since")
              ? []
              : [comment(1)],
        ),
      );
      expect(await poll(f.reader)).toBeNull();
      changed = true;
      expect(await poll(f.reader)).toEqual(cancellation);
      expect(f.requests[1]!.searchParams.get("since")).toBe("2026-09-12T09:59:58.000Z");
      // Positive results are not retained: the next read reconstructs current evidence.
      changed = false;
      expect(await poll(f.reader)).toBeNull();
      expect(f.requests[2]!.searchParams.has("since")).toBe(false);
    },
  );

  it("uses page one's time so edits entering an earlier page remain eligible", async () => {
    const f = fixture((number, url) =>
      url.searchParams.has("since")
        ? dated(
            [comment(1, encodeEventComment("Withdraw", cancellation), "2026-09-12T10:00:01Z")],
            "2026-09-12T10:00:05Z",
          )
        : dated(
            [comment(number)],
            number === 1 ? start : "2026-09-12T10:00:04Z",
            number === 1 ? 2 : undefined,
          ),
    );
    expect(await poll(f.reader)).toBeNull();
    expect(await poll(f.reader)).toEqual(cancellation);
    expect(f.requests[2]!.searchParams.get("since")).toBe("2026-09-12T09:59:58.000Z");
  });

  it.each(["failed", "incomplete", "oversized"])(
    "does not publish results or advance after a %s delta",
    async (failure) => {
      let mode = "bootstrap";
      const f = fixture((number) => {
        if (mode !== "failure") return dated([]);
        if (failure === "oversized")
          return dated([comment(1, "x".repeat(RECOVERY_READER_LIMITS.hydratedBytes))]);
        if (failure === "failed" && number === 2)
          return Response.json({ message: "unavailable" }, { status: 403 });
        return dated(
          [comment(number, encodeEventComment("Withdraw", cancellation))],
          "2026-09-12T10:00:10Z",
          number + 1,
        );
      });
      expect(await poll(f.reader)).toBeNull();
      mode = "failure";
      await expect(poll(f.reader)).rejects.toThrow();
      mode = "retry";
      expect(await poll(f.reader)).toBeNull();
      expect(f.requests.at(-1)?.searchParams.get("since")).toBe("2026-09-12T09:59:58.000Z");
    },
  );

  it("keeps the authenticated parser on deltas", async () => {
    const f = fixture((_number, url) =>
      dated(
        url.searchParams.has("since")
          ? [
              {
                ...comment(1, encodeEventComment("Withdraw", cancellation)),
                user: { login: "stranger" },
              },
            ]
          : [],
      ),
    );
    expect(await poll(f.reader)).toBeNull();
    expect(await poll(f.reader)).toBeNull();
  });

  it("reconstructs on restart and every changed binding field", async () => {
    const f = fixture(() => dated([]));
    await poll(f.reader);
    for (const [field, value] of Object.entries(binding)) {
      await f.reader.readRunCancellationRequest(7, "real-run", "operator", {
        ...binding,
        [field]: typeof value === "number" ? value + 1 : `${value}-changed`,
      });
      expect(f.requests.at(-1)?.searchParams.has("since")).toBe(false);
    }
    await f.reader.readRunCancellationRequest(7, "other-run", "operator", binding);
    expect(f.requests.at(-1)?.searchParams.has("since")).toBe(false);
    await f.reader.readRunCancellationRequest(7, "other-run", "other-actor", binding);
    expect(f.requests.at(-1)?.searchParams.has("since")).toBe(false);
    await f.reader.readRunCancellationRequest(8, "other-run", "other-actor", binding);
    expect(f.requests.at(-1)?.searchParams.has("since")).toBe(false);
    const restarted = fixture(() => dated([]));
    await poll(restarted.reader);
    expect(restarted.requests[0]!.searchParams.has("since")).toBe(false);
  });

  it("falls back to full reconstruction when the server timestamp is unavailable or regresses", async () => {
    let date: string | undefined = start;
    const f = fixture(() => (date ? dated([], date) : page([])));
    await poll(f.reader);
    date = "2026-09-12T09:59:00Z";
    await poll(f.reader);
    date = undefined;
    await poll(f.reader);
    await poll(f.reader);
    expect(f.requests.slice(2).every((url) => !url.searchParams.has("since"))).toBe(true);
  });
});
