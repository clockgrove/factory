import { describe, expect, it } from "vitest";

import { reportedModelTokens } from "../src/supervisor.js";

describe("worker model usage accounting", () => {
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
