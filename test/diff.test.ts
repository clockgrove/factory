import { describe, expect, it } from "vitest";

import { budgetPatches, type RawDiffFile } from "../src/github.js";

/**
 * Tests for the diff-read budgeting introduced to close Gate 2's finding F1
 * (IMPLEMENTATION-PLAN.md §10.2): Director could see `changedFilePaths` but no
 * patch content, so the semantic half of the §7.3 confidence bar — "the diff
 * satisfies the acceptance criteria and nothing more" — was unperformable.
 *
 * The budget exists because F3 showed the tool surface can overflow its own
 * output limit on a large Objective. So the rule under test is really: never
 * exceed the budget, and never let the caller mistake a withheld patch for an
 * empty one.
 */

function file(overrides: Partial<RawDiffFile> = {}): RawDiffFile {
  return {
    filename: "src/a.ts",
    status: "added",
    additions: 3,
    deletions: 0,
    patch: "@@ -0,0 +1,3 @@\n+one\n+two\n+three",
    ...overrides,
  };
}

/** Index into a result, failing the test loudly if the entry isn't there. */
function at<T>(items: T[], i: number): T {
  const item = items[i];
  if (item === undefined) throw new Error(`expected an entry at index ${i}, got ${items.length} entries`);
  return item;
}

describe("budgetPatches", () => {
  it("returns every patch intact when the budget is ample", () => {
    const patch = "@@ -0,0 +1,1 @@\n+hello";
    const { files, truncated } = budgetPatches(
      [file({ filename: "src/a.ts", patch }), file({ filename: "src/b.ts", patch })],
      10_000,
    );

    expect(truncated).toBe(false);
    expect(files.map((f) => f.path)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(files.every((f) => f.patch === patch)).toBe(true);
    expect(files.every((f) => f.patchOmitted === undefined)).toBe(true);
  });

  it("carries through the per-file metadata the confidence bar reasons about", () => {
    const { files } = budgetPatches(
      [file({ filename: "src/x.ts", status: "modified", additions: 12, deletions: 4 })],
      10_000,
    );

    expect(files[0]).toMatchObject({
      path: "src/x.ts",
      status: "modified",
      additions: 12,
      deletions: 4,
    });
  });

  it("truncates mid-file rather than overshooting the budget", () => {
    const patch = "x".repeat(500);
    const { files, truncated } = budgetPatches([file({ patch })], 100);

    expect(truncated).toBe(true);
    expect(at(files, 0).patch).toHaveLength(100);
    expect(at(files, 0).patchOmitted).toBe("truncated mid-file");
  });

  it("never spends more than the budget across many files", () => {
    const files = Array.from({ length: 20 }, (_, i) =>
      file({ filename: `src/f${i}.ts`, patch: "y".repeat(100) }),
    );
    const result = budgetPatches(files, 250);

    const spent = result.files.reduce((n, f) => n + (f.patch?.length ?? 0), 0);
    expect(spent).toBe(250);
    expect(result.truncated).toBe(true);
  });

  it("still lists files whose patches were dropped, so nothing looks unchanged", () => {
    const result = budgetPatches(
      [
        file({ filename: "src/first.ts", patch: "z".repeat(100) }),
        file({ filename: "src/second.ts", additions: 40, patch: "z".repeat(100) }),
      ],
      100,
    );

    // The second file is still visible with its real +40, just without content —
    // the caller must not conclude it was untouched.
    const second = at(result.files, 1);
    expect(second.path).toBe("src/second.ts");
    expect(second.additions).toBe(40);
    expect(second.patch).toBeNull();
    expect(second.patchOmitted).toMatch(/budget exhausted/);
  });

  it("distinguishes a patch GitHub withheld from one the budget dropped", () => {
    const { files, truncated } = budgetPatches(
      [file({ filename: "logo.png", patch: null })],
      10_000,
    );

    expect(at(files, 0).patch).toBeNull();
    expect(at(files, 0).patchOmitted).toMatch(/binary/);
    // A binary file is not a truncation: re-reading with a bigger budget
    // would not produce content, so the caller shouldn't be told to retry.
    expect(truncated).toBe(false);
  });

  it("treats an absent patch field the same as an explicit null", () => {
    const { files } = budgetPatches([{ filename: "b.bin", status: "added", additions: 0, deletions: 0 }], 10_000);
    expect(at(files, 0).patch).toBeNull();
    expect(at(files, 0).patchOmitted).toMatch(/binary/);
  });

  it("handles an empty pull request without reporting truncation", () => {
    expect(budgetPatches([], 10_000)).toEqual({ files: [], truncated: false });
  });

  it("withholds everything, but loses no file, at a zero budget", () => {
    const { files, truncated } = budgetPatches([file(), file({ filename: "src/b.ts" })], 0);

    expect(files).toHaveLength(2);
    expect(files.every((f) => f.patch === null)).toBe(true);
    expect(truncated).toBe(true);
  });
});
