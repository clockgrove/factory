import { describe, expect, it } from "vitest";

import { reportedModelTokens } from "../src/supervisor.js";
import { reportedModelUsage } from "../src/protocol/model-usage.js";

describe("worker model usage accounting", () => {
  it("preserves supplied zero and partial usage without inventing missing counters", () => {
    expect(
      reportedModelUsage({ inputTokens: 120, outputTokens: null, cachedInputTokens: 0 }),
    ).toEqual({ inputTokens: 120, cachedInputTokens: 0 });
    expect(
      reportedModelUsage({ inputTokens: null, outputTokens: null, cachedInputTokens: null }),
    ).toBeUndefined();
    expect(reportedModelUsage()).toBeUndefined();
  });

  it("omits invalid optional cache telemetry without losing trustworthy scalar usage", () => {
    for (const cachedInputTokens of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 121]) {
      const usage = { inputTokens: 120, outputTokens: 30, cachedInputTokens };
      expect(reportedModelUsage(usage)).toEqual({ inputTokens: 120, outputTokens: 30 });
      expect(reportedModelTokens(usage)).toBe(150);
    }
  });
  it("charges terminal input and output tokens without double-charging cached input", () => {
    expect(
      reportedModelTokens({
        inputTokens: 120,
        outputTokens: 30,
        cachedInputTokens: 80,
      }),
    ).toBe(150);
  });

  it("keeps incomplete provider counters unavailable rather than treating them as zero", () => {
    expect(
      reportedModelTokens({
        inputTokens: 120,
        outputTokens: null,
        cachedInputTokens: null,
      }),
    ).toBeNull();
    expect(reportedModelTokens()).toBeNull();
  });
});
