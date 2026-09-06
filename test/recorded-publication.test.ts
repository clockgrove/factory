import { expect, it } from "vitest";
import { parseFactoryEvent, type FactoryEvent } from "../src/protocol/events.js";
import { selectEquivalentPublicationRecord } from "../src/publication/recorded-publication.js";

function receipt() {
  return parseFactoryEvent({
    protocol: "clockgrove.factory/v2",
    kind: "publication",
    event: "PublicationRecorded",
    objective: 7,
    runId: "fixture",
    workItem: 9,
    attempt: 1,
    sequence: 35,
    at: "2026-09-05T18:59:43.000Z",
    unitId: "delivery/b",
    itemId: "b",
    mode: "native-stacks",
    position: 0,
    branch: "factory/objective-7/work-item-9/attempt-1",
    baseBranch: "main",
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    pullRequest: 19,
    capabilityVersion: "2026-03-10",
    validationDigest: "c".repeat(64),
    exactHeadValidationDigest: "d".repeat(64),
  }) as Extract<FactoryEvent, { kind: "publication" }>;
}

it("selects earliest equivalent publication without changing either authenticated audit envelope", () => {
  const original = receipt();
  const recovered = {
    ...original,
    sequence: 36,
    at: "2026-09-05T18:59:48.000Z",
    reason: "recovered publication receipt",
  };
  const records = [recovered, original];
  const before = structuredClone(records);
  expect(selectEquivalentPublicationRecord(records)).toBe(original);
  expect(selectEquivalentPublicationRecord(records, recovered)).toBe(recovered);
  expect(records).toEqual(before);
  expect(() => selectEquivalentPublicationRecord([original], recovered)).toThrow("pinned");
});

it.each([
  ["objective", 8],
  ["runId", "other"],
  ["workItem", 10],
  ["attempt", 2],
  ["unitId", "delivery/other"],
  ["itemId", "other"],
  ["mode", "regular-prs"],
  ["position", 1],
  ["parentItemId", "a"],
  ["stackNumber", 90],
  ["branch", "factory/other"],
  ["baseBranch", "other"],
  ["baseSha", "e".repeat(40)],
  ["headSha", "f".repeat(40)],
  ["pullRequest", 20],
  ["capabilityVersion", "other"],
  ["validationDigest", "e".repeat(64)],
  ["exactHeadValidationDigest", "f".repeat(64)],
] as const)(
  "rejects a conflicting %s instead of treating it as audit duplication",
  (field, value) => {
    const original = receipt();
    expect(() =>
      selectEquivalentPublicationRecord([original, { ...original, sequence: 36, [field]: value }]),
    ).toThrow();
  },
);

it("does not accept a different publication event or unbounded equivalence class", () => {
  expect(() =>
    selectEquivalentPublicationRecord([{ ...receipt(), event: "StackLinked" }]),
  ).toThrow();
  expect(() => selectEquivalentPublicationRecord(Array.from({ length: 257 }, receipt))).toThrow();
  expect(selectEquivalentPublicationRecord([])).toBeNull();
});

it("preserves unknown protocol bindings and rejects contradictory same-sequence audit envelopes", () => {
  const original = receipt();
  expect(() =>
    selectEquivalentPublicationRecord([
      original,
      { ...original, sequence: 36, futureBinding: { head: "other" } },
    ]),
  ).toThrow("conflicting bindings");
  expect(() =>
    selectEquivalentPublicationRecord([original, { ...original, reason: "conflicting audit" }]),
  ).toThrow();
});
