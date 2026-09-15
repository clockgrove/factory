import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";

import {
  COMPILER_DIMENSIONS,
  SEMANTIC_COMPILER_CASES,
} from "./fixtures/compiler/semantic-cases.js";

describe("semantic compiler pairwise corpus coverage", () => {
  it("has stable unique case names and non-empty dimension tags", () => {
    expect(new Set(SEMANTIC_COMPILER_CASES.map((entry) => entry.name)).size).toBe(
      SEMANTIC_COMPILER_CASES.length,
    );
    for (const entry of SEMANTIC_COMPILER_CASES)
      for (const tags of Object.values(entry.tags))
        expect(tags.length, entry.name).toBeGreaterThan(0);
    for (const entry of SEMANTIC_COMPILER_CASES) expect(entry.tests.length).toBeGreaterThan(0);
  });

  it("binds every coverage bundle to named executable Vitest evidence", async () => {
    for (const entry of SEMANTIC_COMPILER_CASES) {
      for (const reference of entry.tests) {
        const [file, name] = reference.split("::") as [string, string];
        const source = await readFile(new URL(`./${file}`, import.meta.url), "utf8");
        expect(source, `${entry.name}: ${reference}`).toContain(name);
      }
    }
  });

  it.each([
    ["partial", "missing-provider"],
    ["mixed", "ambiguous-provider"],
    ["policy-blocked", "preflight-unsatisfiable"],
    ["unsupported", "cargo"],
    ["unsupported", "go"],
    ["unsupported", "ambient-python"],
    ["later-generation", "semantic-repair"],
    ["32-operation-boundary", "unchanged-report"],
    ["mutable-checkout-disagreement", "preflight-unsatisfiable"],
  ])("retains the focused pairwise interaction %s × %s", (left, right) => {
    expect(
      SEMANTIC_COMPILER_CASES.some(
        (entry) =>
          Object.values(entry.tags).some((tags) => tags.includes(left as never)) &&
          Object.values(entry.tags).some((tags) => tags.includes(right as never)),
      ),
    ).toBe(true);
  });

  it.each(Object.entries(COMPILER_DIMENSIONS))("covers every %s value", (dimension, expected) => {
    const observed = new Set(
      SEMANTIC_COMPILER_CASES.flatMap(
        (entry) => entry.tags[dimension as keyof typeof COMPILER_DIMENSIONS],
      ),
    );
    expect([...observed].sort()).toEqual([...expected].sort());
  });
});
