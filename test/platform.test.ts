import { describe, expect, it } from "vitest";

import {
  CircuitBreaker,
  ConcurrencyLimiter,
  ContentCreationPacer,
  GitHubPrimaryQuotaCache,
  MutationScheduler,
  PlatformUnavailableError,
  classifyRefusal,
  isPlatformUnavailable,
} from "../src/platform.js";
import { createOctokit } from "../src/github.js";
import { GitHubControlStore } from "../src/control/github-store.js";

function err(
  status: number,
  message = "",
  headers: Record<string, string | undefined> = {},
): unknown {
  return { status, message, response: { headers } };
}

describe("classifyRefusal", () => {
  it("classifies the measured plane-3 403 as a rate limit", () => {
    // The exact shape observed: 403, rate-limit wording, and headers claiming
    // a completely unconsumed quota.
    const e = err(403, "API rate limit exceeded for user ID 318831919.", {
      "x-ratelimit-remaining": "5000",
      "x-ratelimit-limit": "5000",
    });
    expect(classifyRefusal(e).kind).toBe("rate_limit");
  });

  it("classifies GraphQL RATE_LIMITED responses even when quota remains", () => {
    const reset = Math.floor(Date.now() / 1000) + 120;
    const refusal = classifyRefusal({
      status: 403,
      message: "Something went wrong while executing your query",
      response: {
        headers: {
          "x-ratelimit-remaining": "76",
          "x-ratelimit-reset": String(reset),
        },
        data: { errors: [{ type: "RATE_LIMITED" }] },
      },
    });
    expect(refusal.kind).toBe("rate_limit");
    if (refusal.kind === "rate_limit") {
      expect(refusal.retryAfterMs).toBeGreaterThan(60_000);
    }
  });

  it("classifies the status-less GraphqlResponseError shape GitHub emits at zero quota", () => {
    const reset = Math.floor(Date.now() / 1000) + 120;
    const refusal = classifyRefusal({
      message: "Request failed due to following response errors",
      errors: [
        {
          type: "RATE_LIMIT",
          code: "graphql_rate_limit",
          message: "API rate limit already exceeded for user ID 318831919.",
        },
      ],
      headers: {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(reset),
      },
      response: {
        errors: [
          {
            type: "RATE_LIMIT",
            code: "graphql_rate_limit",
            message: "API rate limit already exceeded for user ID 318831919.",
          },
        ],
      },
    });
    expect(refusal.kind).toBe("rate_limit");
    if (refusal.kind === "rate_limit") {
      expect(refusal.retryAfterMs).toBeGreaterThan(60_000);
    }
  });

  it("does not trust a reset time when the quota reports budget remaining", () => {
    // Plane 3 refuses while reporting a full budget, so the reset timestamp
    // describes a window we are not in. Fixed backoff is the honest answer.
    const farFuture = Math.floor(Date.now() / 1000) + 3600;
    const e = err(403, "API rate limit exceeded", {
      "x-ratelimit-remaining": "5000",
      "x-ratelimit-reset": String(farFuture),
    });
    const r = classifyRefusal(e);
    expect(r).toMatchObject({ kind: "rate_limit" });
    if (r.kind === "rate_limit") expect(r.retryAfterMs).toBeLessThan(3_600_000);
  });

  it("uses the reset time when the quota really is exhausted", () => {
    const reset = Math.floor(Date.now() / 1000) + 120;
    const e = err(403, "API rate limit exceeded", {
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": String(reset),
    });
    const r = classifyRefusal(e);
    expect(r.kind).toBe("rate_limit");
    if (r.kind === "rate_limit") {
      expect(r.retryAfterMs).toBeGreaterThan(60_000);
    }
  });

  it("prefers an explicit Retry-After header", () => {
    const e = err(403, "You have exceeded a secondary rate limit", {
      "retry-after": "45",
    });
    expect(classifyRefusal(e)).toEqual({
      kind: "rate_limit",
      retryAfterMs: 45_000,
    });
  });

  it("classifies 429 as a rate limit even without wording", () => {
    expect(classifyRefusal(err(429)).kind).toBe("rate_limit");
  });

  it("classifies the measured agent-engine 500 as a server error", () => {
    expect(classifyRefusal(err(500, "Failed to fetch job details")).kind).toBe("server_error");
  });

  it("classifies 502 and 503 as server errors", () => {
    expect(classifyRefusal(err(502)).kind).toBe("server_error");
    expect(classifyRefusal(err(503)).kind).toBe("server_error");
  });

  it("does NOT treat a permissions 403 as a refusal", () => {
    // Retrying this forever would hide a real misconfiguration — exactly the
    // kind of silent stall that motivated escalation being first-class.
    const e = err(403, "Resource not accessible by integration");
    expect(classifyRefusal(e).kind).toBe("not_refusal");
    expect(isPlatformUnavailable(e)).toBe(false);
  });

  it("does not treat 404 or 422 as refusals", () => {
    expect(isPlatformUnavailable(err(404, "Not Found"))).toBe(false);
    expect(isPlatformUnavailable(err(422, "Validation Failed"))).toBe(false);
  });

  it("does not treat a non-HTTP error as a refusal", () => {
    expect(isPlatformUnavailable(new Error("boom"))).toBe(false);
    expect(isPlatformUnavailable(undefined)).toBe(false);
    expect(isPlatformUnavailable(null)).toBe(false);
  });
});

describe("GitHub client throttling", () => {
  it("disables hidden Octokit retries so one admitted mutation has one transport", async () => {
    let attempts = 0;
    let now = Date.parse("2026-01-01T00:00:00Z");
    const scheduler = new MutationScheduler({
      now: () => new Date(now),
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
    });
    const store = new GitHubControlStore({
      token: "mutation-retry-test",
      owner: "clockgrove",
      repo: "factory",
      mutationScheduler: scheduler,
      requestFetch: async () => {
        attempts += 1;
        return new Response(JSON.stringify(attempts === 1 ? { message: "temporary" } : {}), {
          status: attempts === 1 ? 500 : 201,
          headers: { "content-type": "application/json", "retry-after": "0" },
        });
      },
    });
    await expect(
      store.stackRequest(
        "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
        { owner: "clockgrove", repo: "factory", issue_number: 188, body: "fixture" },
        true,
      ),
    ).rejects.toBeInstanceOf(PlatformUnavailableError);
    expect(attempts).toBe(1);
    expect(scheduler.telemetry()).toMatchObject({ admitted: 1, transported: 1, successful: 0 });
  });

  it("caches authoritative primary headers independently by resource", async () => {
    const quota = new GitHubPrimaryQuotaCache();
    const requestFetch: typeof globalThis.fetch = async () =>
      new Response(JSON.stringify({ login: "fixture" }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-ratelimit-resource": "core",
          "x-ratelimit-limit": "5000",
          "x-ratelimit-remaining": "4998",
          "x-ratelimit-used": "2",
          "x-ratelimit-reset": "1788647538",
        },
      });
    const octokit = createOctokit({
      token: "quota-cache-test",
      owner: "clockgrove",
      repo: "factory",
      requestFetch,
      primaryQuota: quota,
    });
    await octokit.request("GET /user");
    quota.observe({
      "x-ratelimit-resource": "graphql",
      "x-ratelimit-limit": "5000",
      "x-ratelimit-remaining": "4900",
      "x-ratelimit-reset": "1788647540",
    });
    expect(quota.snapshot()).toMatchObject([
      { resource: "core", limit: 5000, remaining: 4998, used: 2 },
      { resource: "graphql", limit: 5000, remaining: 4900 },
    ]);
  });

  it("surfaces quota refusal immediately instead of sleeping inside Octokit", async () => {
    const notices: string[] = [];
    const reset = Math.floor(Date.now() / 1000) + 3_600;
    const requestFetch: typeof globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          data: null,
          errors: [
            {
              type: "RATE_LIMITED",
              message: "API rate limit exceeded for test user",
            },
          ],
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-ratelimit-remaining": "76",
            "x-ratelimit-reset": String(reset),
          },
        },
      );
    const octokit = createOctokit({
      token: "test-token",
      owner: "clockgrove",
      repo: "factory",
      requestFetch,
      onThrottle: (message) => notices.push(message),
    });

    await expect(octokit.graphql("query { viewer { login } }")).rejects.toBeInstanceOf(
      PlatformUnavailableError,
    );
    expect(notices).toEqual([expect.stringContaining("yielding to Factory")]);
  });

  it("wraps GitHub's RATE_LIMIT/graphql_rate_limit GraphqlResponseError shape", async () => {
    const reset = Math.floor(Date.now() / 1000) + 3_600;
    const requestFetch: typeof globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          data: null,
          errors: [
            {
              type: "RATE_LIMIT",
              code: "graphql_rate_limit",
              message: "API rate limit already exceeded for test user",
            },
          ],
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String(reset),
          },
        },
      );
    const octokit = createOctokit({
      token: "test-token",
      owner: "clockgrove",
      repo: "factory",
      requestFetch,
    });

    await expect(octokit.graphql("query { viewer { login } }")).rejects.toBeInstanceOf(
      PlatformUnavailableError,
    );
  });
});

/**
 * The wave-level breaker exists because GitHub says continuing to retry
 * while rate limited risks the integration being banned — so a refusal must
 * pause every upcoming call, not just retry the one that hit it.
 */
describe("CircuitBreaker", () => {
  const t0 = new Date("2026-01-01T00:00:00Z");
  const refusal = { kind: "rate_limit" as const, retryAfterMs: 1_000 };

  it("honors a refusal immediately without counting it as a threshold trip", () => {
    const cb = new CircuitBreaker({ openAfterConsecutiveRefusals: 3 });
    cb.recordRefusal(refusal, t0);
    cb.recordRefusal(refusal, t0);
    expect(cb.isOpen(t0)).toBe(true);
    expect(cb.waitMs(t0)).toBe(1_000);
    expect(cb.exhausted()).toBe(false);
  });

  it("opens once consecutive refusals reach the threshold", () => {
    const cb = new CircuitBreaker({
      openAfterConsecutiveRefusals: 3,
      baseCooldownMs: 60_000,
    });
    cb.recordRefusal(refusal, t0);
    cb.recordRefusal(refusal, t0);
    cb.recordRefusal(refusal, t0);
    expect(cb.isOpen(t0)).toBe(true);
    expect(cb.waitMs(t0)).toBeGreaterThanOrEqual(60_000);
  });

  it("closes again once the cooldown elapses", () => {
    const cb = new CircuitBreaker({
      openAfterConsecutiveRefusals: 1,
      baseCooldownMs: 60_000,
    });
    cb.recordRefusal(refusal, t0);
    expect(cb.isOpen(t0)).toBe(true);
    const later = new Date(t0.getTime() + 60_001);
    expect(cb.isOpen(later)).toBe(false);
  });

  it("only a success resets the consecutive-refusal count", () => {
    const cb = new CircuitBreaker({ openAfterConsecutiveRefusals: 2 });
    cb.recordRefusal(refusal, t0);
    cb.recordSuccess();
    cb.recordRefusal(refusal, t0);
    expect(cb.waitMs(t0)).toBe(1_000);
    expect(cb.isOpen(new Date(t0.getTime() + 1_000))).toBe(false);
  });

  it("grows the cooldown on repeated trips, capped at maxCooldownMs", () => {
    const cb = new CircuitBreaker({
      openAfterConsecutiveRefusals: 1,
      baseCooldownMs: 60_000,
      maxCooldownMs: 90_000,
    });
    cb.recordRefusal(refusal, t0); // opens #1: 60_000
    const afterFirst = new Date(t0.getTime() + 60_001);
    cb.recordRefusal(refusal, afterFirst); // opens #2: min(120_000, 90_000)
    expect(cb.waitMs(afterFirst)).toBe(90_000);
  });

  it("reports exhausted once maxOpens trips have occurred", () => {
    const cb = new CircuitBreaker({
      openAfterConsecutiveRefusals: 1,
      baseCooldownMs: 1,
      maxOpens: 2,
    });
    let now = t0;
    cb.recordRefusal(refusal, now);
    now = new Date(now.getTime() + 2);
    cb.recordRefusal(refusal, now);
    expect(cb.exhausted()).toBe(true);
  });
});

describe("ContentCreationPacer", () => {
  it("allows the first call immediately", () => {
    const p = new ContentCreationPacer(40, 250, 1_000);
    expect(p.waitMs(new Date("2026-01-01T00:00:00Z"))).toBe(0);
  });

  it("enforces the minimum gap between mutative calls", () => {
    const p = new ContentCreationPacer(40, 100_000, 1_000);
    const t0 = new Date("2026-01-01T00:00:00.000Z");
    p.recordCall(t0);
    expect(p.waitMs(new Date(t0.getTime() + 200))).toBe(800);
  });

  it("blocks once the per-minute budget is spent", () => {
    const p = new ContentCreationPacer(2, 250, 0);
    const t0 = new Date("2026-01-01T00:00:00.000Z");
    p.recordCall(t0);
    p.recordCall(new Date(t0.getTime() + 10));
    expect(p.waitMs(new Date(t0.getTime() + 20))).toBeGreaterThan(0);
  });

  it("frees up the per-minute budget once the window slides past", () => {
    const p = new ContentCreationPacer(1, 250, 0);
    const t0 = new Date("2026-01-01T00:00:00.000Z");
    p.recordCall(t0);
    expect(p.waitMs(new Date(t0.getTime() + 60_001))).toBe(0);
  });

  it("smooths normal traffic across the documented hourly window", () => {
    const p = new ContentCreationPacer(80, 500, 0);
    const t0 = new Date("2026-01-01T00:00:00.000Z");
    p.recordCall(t0);
    expect(p.waitMs(new Date(t0.getTime() + 1_000))).toBeGreaterThan(6_000);
  });

  it("keeps lease priority while retaining the hard documented windows", () => {
    const p = new ContentCreationPacer(40, 5, 0);
    const t0 = new Date("2026-01-01T00:00:00.000Z");
    p.recordCall(t0);
    expect(p.waitMs(t0)).toBeGreaterThan(0);
    expect(p.waitMs(t0, { priority: true })).toBe(0);
  });

  it("adapts downward only after observed secondary feedback", () => {
    const p = new ContentCreationPacer(80, 500, 0);
    expect(p.snapshot(new Date("2026-01-01T00:00:00Z"))).toMatchObject({
      estimatedHourlyCapacity: 499,
      confidence: "low",
    });
    p.recordSecondaryRefusal();
    expect(p.snapshot(new Date("2026-01-01T00:00:00Z"))).toMatchObject({
      estimatedHourlyCapacity: 249,
      confidence: "high",
      secondaryRefusals: 1,
    });
  });

  it("paces two small Objectives without an hourly-cliff stall", () => {
    const p = new ContentCreationPacer();
    let now = new Date("2026-01-01T00:00:00Z");
    const start = now.getTime();
    // The retained two-Objective trace contained 58 transported mutations.
    for (let mutation = 0; mutation < 58; mutation += 1) {
      now = new Date(now.getTime() + p.waitMs(now));
      p.recordTransported(now);
      p.recordSuccess();
    }
    expect(now.getTime() - start).toBeLessThan(10 * 60_000);
  });
});

describe("MutationScheduler", () => {
  it("charges only transported writes and reports separate primary and secondary state", async () => {
    const t0 = new Date("2026-01-01T00:00:00.000Z");
    const now = t0;
    const pacer = new ContentCreationPacer(40, 100_000, 0);
    const scheduler = new MutationScheduler({
      pacer,
      now: () => now,
    });
    const fenced = await scheduler.acquire("normal");
    fenced.release();
    expect(scheduler.telemetry()).toMatchObject({ admitted: 1, transported: 0, successful: 0 });
    const sent = await scheduler.acquire("normal");
    sent.recordTransported?.();
    sent.recordSuccess?.();
    sent.release();
    expect(scheduler.telemetry()).toMatchObject({
      admitted: 2,
      transported: 1,
      successful: 1,
      serverPrimaryQuota: [],
      localSecondaryEstimate: { transportedLastHour: 1, confidence: "low" },
    });
  });
});

describe("ConcurrencyLimiter", () => {
  it("admits calls up to the limit without waiting", async () => {
    const limiter = new ConcurrencyLimiter(2);
    const release1 = await limiter.acquire();
    const release2 = await limiter.acquire();
    expect(release1).toBeInstanceOf(Function);
    expect(release2).toBeInstanceOf(Function);
  });

  it("queues a call beyond the limit until a slot is released", async () => {
    const limiter = new ConcurrencyLimiter(1);
    const release1 = await limiter.acquire();

    const order: string[] = [];
    const second = limiter.acquire().then((release2) => {
      order.push("second-acquired");
      release2();
    });

    // The second acquire should still be pending — the first slot is held.
    await Promise.resolve();
    order.push("checked-pending");
    release1();
    await second;

    expect(order).toEqual(["checked-pending", "second-acquired"]);
  });
});
