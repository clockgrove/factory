import { describe, expect, it } from "vitest";

import {
  planDelivery,
  selectDelivery,
  type DeliveryWorkItem,
} from "../src/publication/delivery.js";

const root = (id: string): DeliveryWorkItem => ({
  id,
  dependsOn: [],
  delivery: { group: id, relationship: "root" },
});
const continuation = (id: string, parent: string, group = "a"): DeliveryWorkItem => ({
  id,
  dependsOn: [parent],
  delivery: { group, relationship: "continue-stack", parentWorkItem: parent },
});

function permutations<T>(values: T[]): T[][] {
  if (values.length < 2) return [values];
  return values.flatMap((value, index) =>
    permutations(values.filter((_, candidate) => candidate !== index)).map(
      (rest) => [value, ...rest],
    ),
  );
}

describe("delivery topology planning", () => {
  it("keeps independent roots as deterministic sibling pull requests", () => {
    const plan = planDelivery([root("b"), root("a")]);
    expect(plan).toMatchObject({
      result: "supported",
      units: [
        { id: "delivery/a", kind: "sibling", items: ["a"] },
        { id: "delivery/b", kind: "sibling", items: ["b"] },
      ],
    });
  });

  it("forms a maximal linear code-dependency stack", () => {
    const plan = planDelivery([
      continuation("c", "b"),
      root("a"),
      continuation("b", "a"),
    ]);
    expect(plan).toMatchObject({
      result: "supported",
      units: [{ id: "delivery/a", kind: "stack", items: ["a", "b", "c"] }],
      items: [
        { itemId: "a", position: 0, waitsForMerge: [] },
        { itemId: "b", position: 1, parentItemId: "a", waitsForMerge: [] },
        { itemId: "c", position: 2, parentItemId: "b", waitsForMerge: [] },
      ],
    });
  });

  it("ends stacks at a diamond fork and makes the join wait for both parents", () => {
    const diamond: DeliveryWorkItem[] = [
      {
        id: "d",
        dependsOn: ["b", "c"],
        delivery: { group: "d", relationship: "join-after-merge" },
      },
      continuation("c", "a"),
      continuation("b", "a"),
      root("a"),
    ];
    const plan = planDelivery(diamond);
    expect(plan).toMatchObject({
      result: "supported",
      units: [
        { kind: "sibling", items: ["a"] },
        { kind: "sibling", items: ["b"] },
        { kind: "sibling", items: ["c"] },
        { kind: "sibling", items: ["d"] },
      ],
      items: [
        { itemId: "a", waitsForMerge: [] },
        { itemId: "b", waitsForMerge: ["a"] },
        { itemId: "c", waitsForMerge: ["a"] },
        { itemId: "d", waitsForMerge: ["b", "c"] },
      ],
    });
    const replayed = permutations(diamond).map((candidate) =>
      JSON.stringify(planDelivery(candidate)),
    );
    expect(new Set(replayed).size).toBe(1);
  });

  it("returns an explicit unsupported result for malformed graph input", () => {
    expect(
      planDelivery([
        {
          id: "a",
          dependsOn: ["missing"],
          delivery: { group: "a", relationship: "continue-stack", parentWorkItem: "missing" },
        },
      ]),
    ).toMatchObject({ result: "unsupported", code: "unknown-dependency" });
  });

  it("selects native stacks only from observed support and records fallback", () => {
    expect(
      selectDelivery({
        requested: "stacked-prs",
        onUnavailable: "regular-prs",
        capability: {
          available: true,
          observed: true,
          version: "2026-03-10",
          reason: "probe accepted",
        },
      }),
    ).toMatchObject({ selected: "native-stacks", reason: "probe accepted" });
    expect(
      selectDelivery({
        requested: "stacked-prs",
        onUnavailable: "regular-prs",
        capability: {
          available: false,
          observed: true,
          version: "2026-03-10",
          reason: "endpoint unavailable",
        },
      }),
    ).toEqual({
      requested: "stacked-prs",
      selected: "regular-prs",
      capabilityVersion: "2026-03-10",
      reason: "endpoint unavailable",
    });
    expect(
      selectDelivery({
        requested: "stacked-prs",
        onUnavailable: "regular-prs",
        capability: {
          available: false,
          observed: false,
          version: "2026-03-10",
          reason: "probe timed out",
        },
      }),
    ).toMatchObject({ selected: "escalate" });
    expect(
      selectDelivery({
        requested: "stacked-prs",
        onUnavailable: "regular-prs",
        capability: {
          available: true,
          observed: false,
          version: "2026-03-10",
          reason: "client cache claimed support without a repository response",
        },
      }),
    ).toMatchObject({ selected: "escalate" });
  });
});
