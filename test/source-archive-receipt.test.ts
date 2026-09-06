import { describe, expect, it } from "vitest";
import { parseFactoryEvent } from "../src/protocol/events.js";

const receipt = {
  protocol: "clockgrove.factory/v2", kind: "attempt", event: "AttemptStarted",
  objective: 1, workItem: 2, attempt: 1, runId: "archive-test", sequence: 1,
  at: "2026-09-06T00:00:00.000Z", backend: "daytona",
  baseSha: "a".repeat(40), directorEpoch: 1, policyDigest: "b".repeat(64),
};
describe("source archive identity receipt", () => {
  it("retains the exact streamed archive identity without requiring it on old receipts", () => {
    expect(parseFactoryEvent(receipt)).toMatchObject(receipt);
    expect(parseFactoryEvent({ ...receipt, sourceArchiveDigest: "c".repeat(64), sourceArchiveBytes: 17 })).toMatchObject({ sourceArchiveDigest: "c".repeat(64), sourceArchiveBytes: 17 });
  });
  it("rejects invalid digest and out-of-bound sizes", () => {
    expect(() => parseFactoryEvent({ ...receipt, sourceArchiveDigest: "c".repeat(64) })).toThrow();
    expect(() => parseFactoryEvent({ ...receipt, sourceArchiveBytes: 17 })).toThrow();
    expect(() => parseFactoryEvent({ ...receipt, sourceArchiveDigest: "not-a-digest" })).toThrow();
    for (const sourceArchiveBytes of [-1, NaN, 0.5, 256 * 1024 * 1024 + 1])
      expect(() => parseFactoryEvent({ ...receipt, sourceArchiveDigest: "c".repeat(64), sourceArchiveBytes })).toThrow();
  });
});
