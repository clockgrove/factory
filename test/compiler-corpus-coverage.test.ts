import { describe, expect, it } from "vitest";

import {
  COMPILER_DIMENSIONS,
  REQUIRED_COMPILER_PAIRS,
  SEMANTIC_COMPILER_CASES,
  observeSemanticCompilerCase,
  type CompilerDimension,
  type CompilerObservation,
} from "./fixtures/compiler/semantic-cases.js";

const executed = SEMANTIC_COMPILER_CASES.map((entry) => ({
  ...entry,
  observed: observeSemanticCompilerCase(entry.input),
}));

const pairKey = (
  leftDimension: string,
  leftValue: string,
  rightDimension: string,
  rightValue: string,
) => `${leftDimension}:${leftValue}\0${rightDimension}:${rightValue}`;

function observedPairs(observation: CompilerObservation): Set<string> {
  const pairs = new Set<string>();
  const dimensions = Object.keys(COMPILER_DIMENSIONS) as CompilerDimension[];
  for (const [leftIndex, leftDimension] of dimensions.entries()) {
    for (const rightDimension of dimensions.slice(leftIndex + 1)) {
      for (const leftValue of observation[leftDimension])
        for (const rightValue of observation[rightDimension])
          pairs.add(pairKey(leftDimension, leftValue, rightDimension, rightValue));
    }
  }
  return pairs;
}

describe("semantic compiler executable corpus coverage", () => {
  it.each(executed)("executes $name", ({ observed, expected }) => {
    expect(observed).toEqual(expected);
  });

  it("has unique names and covers every declared observed value", () => {
    expect(new Set(executed.map((entry) => entry.name)).size).toBe(executed.length);
    for (const [dimension, expected] of Object.entries(COMPILER_DIMENSIONS)) {
      const observed = new Set(
        executed.flatMap(
          (entry) => entry.observed[dimension as CompilerDimension] as readonly string[],
        ),
      );
      expect([...observed].sort(), dimension).toEqual([...expected].sort());
    }
  });

  it("covers required cross-dimension pairs with the executed rows", () => {
    const pairs = new Set(executed.flatMap((entry) => [...observedPairs(entry.observed)]));
    const dimensions = Object.keys(COMPILER_DIMENSIONS) as CompilerDimension[];
    for (const [left, right] of REQUIRED_COMPILER_PAIRS) {
      const ordered =
        dimensions.indexOf(left.dimension) < dimensions.indexOf(right.dimension)
          ? [left, right]
          : [right, left];
      expect(
        pairs.has(
          pairKey(
            ordered[0]!.dimension,
            ordered[0]!.value,
            ordered[1]!.dimension,
            ordered[1]!.value,
          ),
        ),
        `${left.dimension}:${left.value} × ${right.dimension}:${right.value}`,
      ).toBe(true);
    }
  });
});
