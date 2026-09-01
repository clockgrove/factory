import { describe, expect, it } from "vitest";

import {
  evaluateMechanical,
  hasConflict,
  isDeclined,
  isUntouched,
} from "../src/evaluate.js";
import { INITIAL_PLAN_COMMIT, type LinkedPullRequest } from "../src/types.js";

const NOW = new Date("2026-01-01T00:00:00Z");

function pr(over: Partial<LinkedPullRequest> = {}): LinkedPullRequest {
  return {
    id: "PR_1",
    number: 1,
    state: "OPEN",
    isDraft: true,
    title: "Add slugify",
    body: "",
    changedLines: 40,
    changedFiles: 2,
    changedFilePaths: ["src/slugify.ts"],
    commitSubjects: [INITIAL_PLAN_COMMIT, "Add slugify"],
    checks: "SUCCESS",
    mergeable: "MERGEABLE",
    createdAt: NOW,
    ...over,
  };
}

/**
 * PROBE-001's measured decline: an impossible task ("target file does not
 * exist") produced an empty diff, only the `Initial plan` commit, and a
 * title of `No-op: impossible task — target file does not exist`.
 */
function declinedPr(over: Partial<LinkedPullRequest> = {}): LinkedPullRequest {
  return pr({
    title: "No-op: impossible task — target file does not exist",
    body: "The referenced file does not exist, so this task cannot be completed.",
    changedLines: 0,
    changedFiles: 0,
    changedFilePaths: [],
    commitSubjects: [INITIAL_PLAN_COMMIT],
    ...over,
  });
}

describe("isDeclined", () => {
  it("recognizes PROBE-001's measured decline artifact", () => {
    expect(isDeclined(declinedPr())).toBe(true);
  });

  it("does not treat a real diff with a similar title as declined", () => {
    // Guards against a false positive from title text alone (§5.1: PROBE-001
    // found title text like `[WIP]` is not a reliable signal on its own).
    expect(
      isDeclined(
        pr({ title: "No-op: refactor internals", changedLines: 12 }),
      ),
    ).toBe(false);
  });

  it("does not treat a plain no-op without decline language as declined", () => {
    expect(
      isDeclined(
        pr({
          title: "Add slugify",
          changedLines: 0,
          changedFiles: 0,
          commitSubjects: [INITIAL_PLAN_COMMIT],
        }),
      ),
    ).toBe(false);
  });
});

describe("isUntouched", () => {
  it("is false when no expected files are given (compiler not yet wired up)", () => {
    expect(isUntouched(pr(), undefined)).toBe(false);
    expect(isUntouched(pr(), [])).toBe(false);
  });

  it("is false when the diff touches an exact-path scope entry", () => {
    expect(
      isUntouched(pr({ changedFilePaths: ["src/slugify.ts"] }), [
        "src/slugify.ts",
      ]),
    ).toBe(false);
  });

  it("is false when the diff touches a file inside a directory scope entry", () => {
    expect(
      isUntouched(pr({ changedFilePaths: ["src/utils/slugify.ts"] }), [
        "src/utils/",
      ]),
    ).toBe(false);
  });

  it("is true when the diff touches only files outside every scope entry", () => {
    expect(
      isUntouched(pr({ changedFilePaths: ["src/other.ts"] }), [
        "src/slugify.ts",
      ]),
    ).toBe(true);
  });

  it("defers to isNoOp rather than double-counting an empty diff", () => {
    expect(
      isUntouched(
        pr({
          changedLines: 0,
          changedFiles: 0,
          changedFilePaths: [],
          commitSubjects: [INITIAL_PLAN_COMMIT],
        }),
        ["src/slugify.ts"],
      ),
    ).toBe(false);
  });
});

describe("hasConflict", () => {
  it("is true only for a confirmed CONFLICTING verdict", () => {
    expect(hasConflict(pr({ mergeable: "CONFLICTING" }))).toBe(true);
  });

  it("is false while GitHub has not finished computing mergeability", () => {
    expect(hasConflict(pr({ mergeable: "UNKNOWN" }))).toBe(false);
  });

  it("is false when mergeable", () => {
    expect(hasConflict(pr({ mergeable: "MERGEABLE" }))).toBe(false);
  });
});

describe("evaluateMechanical", () => {
  it("classifies PROBE-001's measured decline before anything else", () => {
    expect(evaluateMechanical(declinedPr())).toEqual({ kind: "declined" });
  });

  it("classifies a silent no-op", () => {
    expect(
      evaluateMechanical(
        pr({
          changedLines: 0,
          changedFiles: 0,
          changedFilePaths: [],
          commitSubjects: [INITIAL_PLAN_COMMIT],
        }),
      ),
    ).toEqual({ kind: "no_op" });
  });

  it("classifies a real diff outside the declared scope as untouched", () => {
    expect(
      evaluateMechanical(pr({ changedFilePaths: ["src/other.ts"] }), [
        "src/slugify.ts",
      ]),
    ).toEqual({ kind: "untouched", touchedFiles: ["src/other.ts"] });
  });

  it("classifies a confirmed merge conflict", () => {
    expect(
      evaluateMechanical(pr({ mergeable: "CONFLICTING" })),
    ).toEqual({ kind: "conflict" });
  });

  it("classifies pending checks", () => {
    expect(evaluateMechanical(pr({ checks: "PENDING" }))).toEqual({
      kind: "checks_pending",
    });
  });

  it("classifies failed checks", () => {
    expect(evaluateMechanical(pr({ checks: "FAILURE" }))).toEqual({
      kind: "checks_failed",
    });
  });

  it("classifies a clean PR as ready", () => {
    expect(evaluateMechanical(pr())).toEqual({ kind: "ready" });
  });

  // Gate 3 (§10.5, F1). All four PRs merged with a null rollup even though the
  // repository shipped a real workflow: the runs failed at startup, produced
  // zero jobs, and so attached zero checks to the head commit. Absent checks
  // must not read as "no CI configured" when the repository is known to run CI
  // on pull requests.
  it("classifies absent checks as missing when CI is expected", () => {
    expect(evaluateMechanical(pr({ checks: null }), undefined, true)).toEqual({
      kind: "checks_missing",
    });
  });

  it("still treats absent checks as ready when no CI is expected", () => {
    expect(evaluateMechanical(pr({ checks: null }), undefined, false)).toEqual({
      kind: "ready",
    });
  });

  it("defaults to the pre-Gate-3 behaviour when ciExpected is omitted", () => {
    expect(evaluateMechanical(pr({ checks: null }))).toEqual({ kind: "ready" });
  });

  it("reports settled checks even when CI is expected", () => {
    expect(evaluateMechanical(pr({ checks: "SUCCESS" }), undefined, true)).toEqual({
      kind: "ready",
    });
    expect(evaluateMechanical(pr({ checks: "FAILURE" }), undefined, true)).toEqual({
      kind: "checks_failed",
    });
    expect(evaluateMechanical(pr({ checks: "PENDING" }), undefined, true)).toEqual({
      kind: "checks_pending",
    });
  });

  it("prioritizes a no-op over missing checks", () => {
    expect(
      evaluateMechanical(
        pr({
          changedLines: 0,
          changedFiles: 0,
          changedFilePaths: [],
          commitSubjects: [INITIAL_PLAN_COMMIT],
          checks: null,
        }),
        undefined,
        true,
      ),
    ).toEqual({ kind: "no_op" });
  });

  it("prioritizes no-op over conflict and checks", () => {
    expect(
      evaluateMechanical(
        pr({
          changedLines: 0,
          changedFiles: 0,
          changedFilePaths: [],
          commitSubjects: [INITIAL_PLAN_COMMIT],
          mergeable: "CONFLICTING",
          checks: "FAILURE",
        }),
      ),
    ).toEqual({ kind: "no_op" });
  });

  it("prioritizes untouched over conflict and checks", () => {
    expect(
      evaluateMechanical(
        pr({
          changedFilePaths: ["src/other.ts"],
          mergeable: "CONFLICTING",
          checks: "FAILURE",
        }),
        ["src/slugify.ts"],
      ),
    ).toEqual({ kind: "untouched", touchedFiles: ["src/other.ts"] });
  });

  it("prioritizes conflict over checks", () => {
    expect(
      evaluateMechanical(pr({ mergeable: "CONFLICTING", checks: "FAILURE" })),
    ).toEqual({ kind: "conflict" });
  });
});
