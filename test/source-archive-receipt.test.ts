import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { parseFactoryEvent } from "../src/protocol/events.js";

const receipt = {
  protocol: "clockgrove.factory/v2",
  kind: "attempt",
  event: "AttemptStarted",
  objective: 1,
  workItem: 2,
  attempt: 1,
  runId: "archive-test",
  sequence: 1,
  at: "2026-09-06T00:00:00.000Z",
  backend: "daytona",
  baseSha: "a".repeat(40),
  directorEpoch: 1,
  policyDigest: "b".repeat(64),
};
describe("source archive identity receipt", () => {
  const ajv = new Ajv({ strict: false });
  addFormats(ajv);
  const validate = ajv.compile(
    JSON.parse(
      readFileSync(new URL("../schemas/factory-event.schema.json", import.meta.url), "utf8"),
    ),
  );
  it("retains the exact streamed archive identity without requiring it on old receipts", () => {
    expect(parseFactoryEvent(receipt)).toMatchObject(receipt);
    expect(
      parseFactoryEvent({
        ...receipt,
        sourceArchiveDigest: "c".repeat(64),
        sourceArchiveBytes: 17,
      }),
    ).toMatchObject({ sourceArchiveDigest: "c".repeat(64), sourceArchiveBytes: 17 });
  });
  it("rejects invalid digest and out-of-bound sizes", () => {
    expect(() => parseFactoryEvent({ ...receipt, sourceArchiveDigest: "c".repeat(64) })).toThrow();
    expect(() => parseFactoryEvent({ ...receipt, sourceArchiveBytes: 17 })).toThrow();
    expect(() => parseFactoryEvent({ ...receipt, sourceArchiveDigest: "not-a-digest" })).toThrow();
    for (const sourceArchiveBytes of [-1, NaN, 0.5, 256 * 1024 * 1024 + 1])
      expect(() =>
        parseFactoryEvent({ ...receipt, sourceArchiveDigest: "c".repeat(64), sourceArchiveBytes }),
      ).toThrow();
  });
  it("publishes the archive pair requirement in JSON Schema as well as runtime parsing", () => {
    expect(validate(receipt)).toBe(true);
    expect(
      validate({ ...receipt, sourceArchiveDigest: "c".repeat(64), sourceArchiveBytes: 17 }),
    ).toBe(true);
    expect(validate({ ...receipt, sourceArchiveDigest: "c".repeat(64) })).toBe(false);
    expect(validate({ ...receipt, sourceArchiveBytes: 17 })).toBe(false);
  });
  it("publishes exact conservative duration accounting, never a model-token substitute", () => {
    const charge = {
      ...receipt,
      kind: "budget",
      event: "BudgetReconciled",
      phase: "execution",
      unit: "local_milliseconds",
      amount: 1000,
      usageEvidence: "conservative-reservation",
      reason: "Original reserved duration; exact resource absence proven.",
    };
    expect(validate(charge)).toBe(true);
    expect(() => parseFactoryEvent(charge)).not.toThrow();
    for (const patch of [
      { unit: "model_tokens" },
      { event: "BudgetReserved" },
      { phase: "management" },
      { amount: 0 },
      { reason: "" },
      { usageEvidence: "invented" },
    ]) {
      expect(validate({ ...charge, ...patch })).toBe(false);
      expect(() => parseFactoryEvent({ ...charge, ...patch })).toThrow();
    }
    const incomplete = { ...charge };
    Reflect.deleteProperty(incomplete, "directorEpoch");
    expect(validate(incomplete)).toBe(false);
    expect(() => parseFactoryEvent(incomplete)).toThrow();
    for (const unit of ["local_milliseconds", "sandbox_milliseconds", "validation_milliseconds"]) {
      const validation = { ...charge, phase: "validation", unit };
      expect(validate(validation)).toBe(true);
      expect(() => parseFactoryEvent(validation)).not.toThrow();
    }
    expect(validate({ ...charge, unit: "validation_milliseconds" })).toBe(false);
    expect(() => parseFactoryEvent({ ...charge, unit: "validation_milliseconds" })).toThrow();
  });
});
