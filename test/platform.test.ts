import { describe, expect, it } from "vitest";

import {
  classifyRefusal,
  isPlatformUnavailable,
} from "../src/platform.js";

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
    expect(classifyRefusal(err(500, "Failed to fetch job details")).kind).toBe(
      "server_error",
    );
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
