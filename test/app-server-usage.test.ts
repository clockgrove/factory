import { describe, expect, it } from "vitest";
import { completedAppServerUsage, EMPTY_APP_SERVER_USAGE, type AppServerRawTokens, type AppServerResponseUsage } from "../src/execution/app-server-session.js";

const first: AppServerRawTokens = { inputTokens: 40, outputTokens: 7, cachedInputTokens: 10, totalTokens: 47, cacheWriteInputTokens: 0, reasoningOutputTokens: 2 };
const last: AppServerRawTokens = { inputTokens: 20, outputTokens: 5, cachedInputTokens: 8, totalTokens: 25, cacheWriteInputTokens: 0, reasoningOutputTokens: 1 };
const total: AppServerRawTokens = Object.fromEntries(Object.keys(first).map((key) => [key, first[key as keyof AppServerRawTokens]! + last[key as keyof AppServerRawTokens]!])) as AppServerRawTokens;
const responses: AppServerResponseUsage[] = [{ responseId: "response-a", usage: first }, { responseId: "response-b", usage: last }];
const complete = () => ({ completed: true, baseline: { ...EMPTY_APP_SERVER_USAGE }, total, responses, streamComplete: true });

describe("pinned App Server exact completed usage", () => {
  it("sums every correlated upstream response, never the last response alone", () => {
    expect(completedAppServerUsage(complete())).toEqual({ inputTokens: 60, outputTokens: 12, cachedInputTokens: 18 });
    expect(completedAppServerUsage({ ...complete(), total: last })).toBeUndefined();
    expect(completedAppServerUsage({ ...complete(), responses: responses.slice(1) })).toBeUndefined();
  });
  it("subtracts a verified baseline without charging prior thread turns again", () => {
    expect(completedAppServerUsage({ ...complete(), baseline: first, responses: responses.slice(1) })).toEqual({ inputTokens: 20, outputTokens: 5, cachedInputTokens: 8 });
  });
  it("requires terminal completion, a complete stream and every response's actual usage", () => {
    expect(completedAppServerUsage({ ...complete(), completed: false })).toBeUndefined();
    expect(completedAppServerUsage({ ...complete(), streamComplete: false })).toBeUndefined();
    expect(completedAppServerUsage({ ...complete(), responses: [...responses, { responseId: "missing", usage: null }] })).toBeUndefined();
    expect(completedAppServerUsage({ ...complete(), responses: [] })).toBeUndefined();
    expect(completedAppServerUsage({ ...complete(), total: undefined })).toBeUndefined();
  });
  it("does not mistake persisted TokenUsageRecord sums for complete raw-response coverage", () => {
    // Pinned Codex skips TokenUsageRecord when an upstream completed response has
    // no usage. The persisted known sum can still equal thread total. Only the
    // live raw stream reveals that missing response; a cold reader cannot assert
    // streamComplete from the matching known subtotal.
    expect(completedAppServerUsage({ ...complete(), streamComplete: false })).toBeUndefined();
    expect(completedAppServerUsage({ ...complete(), responses: [...responses, { responseId: "unmetered-completed-response", usage: null }] })).toBeUndefined();
  });
  it("rejects replayed response IDs, overflows, invalid cache counts and malformed baselines", () => {
    expect(completedAppServerUsage({ ...complete(), responses: [responses[0]!, responses[0]!] })).toBeUndefined();
    expect(completedAppServerUsage({ ...complete(), baseline: { ...EMPTY_APP_SERVER_USAGE, inputTokens: -1 } })).toBeUndefined();
    const invalid = { ...first, cachedInputTokens: 41 };
    expect(completedAppServerUsage({ ...complete(), responses: [{ responseId: "bad-cache", usage: invalid }], total: invalid })).toBeUndefined();
    const huge = { ...first, totalTokens: Number.MAX_SAFE_INTEGER };
    expect(completedAppServerUsage({ ...complete(), responses: [{ responseId: "a", usage: huge }, { responseId: "b", usage: huge }] })).toBeUndefined();
  });
  it("keeps authoritative zero distinct from absent usage", () => {
    expect(completedAppServerUsage({ ...complete(), total: EMPTY_APP_SERVER_USAGE, responses: [{ responseId: "zero", usage: EMPTY_APP_SERVER_USAGE }] })).toEqual({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 });
    expect(completedAppServerUsage({ ...complete(), total: EMPTY_APP_SERVER_USAGE, responses: [{ responseId: "absent", usage: null }] })).toBeUndefined();
  });
});
