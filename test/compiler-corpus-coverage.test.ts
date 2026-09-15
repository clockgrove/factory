import { describe, expect, it } from "vitest";

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
