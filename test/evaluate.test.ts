import { describe, expect, it } from "vitest";

import {
  evaluateMechanical,
  hasConflict,
  isDeclined,
  isUntouched,
  outOfScopeFiles,
  sensitiveSurfaceFiles,
} from "../src/evaluate.js";
import { INITIAL_PLAN_COMMIT, type LinkedPullRequest } from "../src/types.js";

/** The clean-PR verdict: in scope, and the whole file list was seen. */
const READY = {
  kind: "ready",
  outOfScopeFiles: [],
  fileListComplete: true,
} as const;

const NOW = new Date("2026-01-01T00:00:00Z");

function pr(over: Partial<LinkedPullRequest> = {}): LinkedPullRequest {
  const merged = {
    id: "PR_1",
    number: 1,
    state: "OPEN" as const,
    // A pull request the agent has marked ready for review. This defaulted to
    // `true` while nothing read the flag, so every test asserting `ready` was
    // quietly asserting that Factory merges drafts (§10.14). Draft is now an
    // explicit choice a test has to make.
    isDraft: false,
    title: "Add slugify",
    body: "",
    changedLines: 40,
    changedFiles: 2,
    changedFilePaths: ["src/slugify.ts"],
    commitSubjects: [INITIAL_PLAN_COMMIT, "Add slugify"],
    checks: "SUCCESS" as const,
    mergeable: "MERGEABLE" as const,
    createdAt: NOW,
    headSha: "deadbeef",
    headCommittedAt: NOW,
    mergedAt: null,
    closedAt: null,
    ...over,
  };
  // Keep the count consistent with the paths unless a test is deliberately
  // exercising a partial file list. GraphQL returns `files(first: 100)` beside
  // an authoritative `changedFiles`, so `changedFiles > paths.length` means
  // "page 2 exists" — a fixture that says so accidentally is claiming the
  // scope checks cannot see the whole diff, which suppresses them.
  return {
    ...merged,
    changedFiles: over.changedFiles ?? merged.changedFilePaths.length,
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
    expect(evaluateMechanical(pr())).toEqual(READY);
  });

  // Gate 4 (§10.7, F3). A held run reports the same `FAILURE` rollup as a real
  // test failure, and `checks_failed` sends the Work Item to `retryOrEscalate`,
  // which closes the pull request. That destroys correct work for a suite that
  // never ran, and the replacement pull request is held identically.
  it("distinguishes held checks from failed checks", () => {
    expect(
      evaluateMechanical(pr({ checks: "FAILURE", checksNeverStarted: true })),
    ).toEqual({ kind: "checks_held" });
  });

  it("still reports a genuine failure when checks did start", () => {
    expect(
      evaluateMechanical(pr({ checks: "FAILURE", checksNeverStarted: false })),
    ).toEqual({ kind: "checks_failed" });
  });

  it("prefers a conflict over held checks", () => {
    expect(
      evaluateMechanical(
        pr({ mergeable: "CONFLICTING", checks: "FAILURE", checksNeverStarted: true }),
      ),
    ).toEqual({ kind: "conflict" });
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
    expect(evaluateMechanical(pr({ checks: null }), undefined, false)).toEqual(READY);
  });

  it("defaults to the pre-Gate-3 behaviour when ciExpected is omitted", () => {
    expect(evaluateMechanical(pr({ checks: null }))).toEqual(READY);
  });

  // The probe is a REST call. Catching a 5xx or a rate limit and reporting
  // `false` reads as "this repository has no CI", which merges a pull request
  // carrying zero checks on the strength of a network error — Gate 3's flaw
  // arriving through a different door. Not knowing must block like knowing does.
  it("blocks on absent checks when CI expectation is unknown", () => {
    expect(evaluateMechanical(pr({ checks: null }), undefined, "unknown")).toEqual({
      kind: "checks_missing",
    });
  });

  it("does not let an unknown CI expectation override settled checks", () => {
    expect(
      evaluateMechanical(pr({ checks: "SUCCESS" }), undefined, "unknown"),
    ).toEqual(READY);
  });

  it("reports settled checks even when CI is expected", () => {
    expect(evaluateMechanical(pr({ checks: "SUCCESS" }), undefined, true)).toEqual(READY);
    expect(evaluateMechanical(pr({ checks: "FAILURE" }), undefined, true)).toEqual({
      kind: "checks_failed",
    });
    expect(evaluateMechanical(pr({ checks: "PENDING" }), undefined, true)).toEqual({
      kind: "checks_pending",
    });
  });

  // `UNKNOWN` is GitHub still computing mergeability, not a clean merge. Without
  // this the verdict falls through to `ready`, which Director reads as "the
  // mechanical half is satisfied" — claiming evidence that does not exist yet.
  it("reports unresolved mergeability rather than claiming ready", () => {
    expect(evaluateMechanical(pr({ mergeable: "UNKNOWN" }))).toEqual({
      kind: "mergeability_unknown",
    });
  });

  // Last in precedence deliberately: a real check failure is decisive and
  // should be reported now, not delayed a cycle behind a value GitHub will
  // settle on its own.
  it("reports a check failure ahead of unresolved mergeability", () => {
    expect(
      evaluateMechanical(pr({ mergeable: "UNKNOWN", checks: "FAILURE" })),
    ).toEqual({ kind: "checks_failed" });
  });

  it("reports held checks ahead of unresolved mergeability", () => {
    expect(
      evaluateMechanical(
        pr({ mergeable: "UNKNOWN", checks: "FAILURE", checksNeverStarted: true }),
      ),
    ).toEqual({ kind: "checks_held" });
  });

  it("prioritizes a no-op over missing checks", () => {    expect(
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

/**
 * Gate 5's finding. `isUntouched` fires only when *no* declared file is
 * touched, so a pull request that did everything asked of it **plus** anything
 * else passed every mechanical check. Measured live: both replacement pull
 * requests on `factory-gate2` added a 1454-line `package-lock.json` that no
 * Work Item declared, and nothing in the pipeline could see it.
 */
describe("scope creep", () => {
  it("reports extra files on an otherwise clean PR without blocking it", () => {
    const verdict = evaluateMechanical(
      pr({ changedFilePaths: ["src/slugify.ts", "docs/NOTES.md"] }),
      ["src/slugify.ts"],
    );
    expect(verdict).toEqual({
      kind: "ready",
      outOfScopeFiles: ["docs/NOTES.md"],
      fileListComplete: true,
    });
  });

  it("is silent when every changed file is in scope", () => {
    expect(
      evaluateMechanical(
        pr({ changedFilePaths: ["src/a.ts", "src/b.ts"] }),
        ["src/"],
      ),
    ).toEqual(READY);
  });

  it("cannot judge scope without a declared scope", () => {
    expect(
      outOfScopeFiles(pr({ changedFilePaths: ["anything.ts"] }), undefined),
    ).toEqual([]);
  });

  it("still merges in-scope work, so a legitimate extra file is not fatal", () => {
    // Gate 3's Work Item correctly updated a test outside its declared scope
    // rather than leaving it broken. Blocking that would have been wrong, which
    // is why this is evidence for §5.2 rather than a failing verdict.
    const verdict = evaluateMechanical(
      pr({ changedFilePaths: ["src/pipeline.ts", "test/loadConfig.test.ts"] }),
      ["src/pipeline.ts"],
    );
    expect(verdict.kind).toBe("ready");
  });
});

/**
 * §7.3 bars autonomous merges of "auth, secrets, permissions, CI
 * configuration, dependency sources" outright. This is the mechanical half of
 * that bar.
 */
describe("sensitive surfaces", () => {
  it("refuses to auto-merge a workflow change", () => {
    const verdict = evaluateMechanical(
      pr({ changedFilePaths: [".github/workflows/ci.yml"] }),
      [".github/workflows/ci.yml"],
    );
    expect(verdict.kind).toBe("sensitive_surface");
  });

  it("blocks even when the Work Item declared the file in scope", () => {
    // Scope is written by the compiler, which is a model reading an issue
    // body. If declaring a path in scope bought an autonomous merge of it, the
    // safety property would certify itself.
    const declared = evaluateMechanical(pr({ changedFilePaths: ["package.json"] }), [
      "package.json",
    ]);
    expect(declared.kind).toBe("sensitive_surface");
  });

  it("catches the lockfile Gate 5 merged by hand", () => {
    const verdict = evaluateMechanical(
      pr({ changedFilePaths: ["src/index.ts", "package-lock.json"] }),
      ["src/index.ts"],
    );
    expect(verdict.kind).toBe("sensitive_surface");
    if (verdict.kind !== "sensitive_surface") throw new Error("unreachable");
    expect(verdict.files.map((f) => f.path)).toEqual(["package-lock.json"]);
  });

  it("does not fire on ordinary source and test files", () => {
    expect(
      sensitiveSurfaceFiles(
        pr({ changedFilePaths: ["src/a.ts", "test/a.test.ts", "docs/x.md"] }),
      ),
    ).toEqual([]);
  });

  it("lets a failing check outrank it, so real defects still retry", () => {
    // A sensitive diff whose CI is red is still just a failed attempt; it
    // should not consume a human's attention before the tests even pass.
    expect(
      evaluateMechanical(
        pr({ changedFilePaths: [".github/workflows/ci.yml"], checks: "FAILURE" }),
        [".github/workflows/ci.yml"],
      ),
    ).toEqual({ kind: "checks_failed" });
  });
});

/**
 * `files(first: 100)` beside an authoritative `changedFiles` means a big pull
 * request arrives with a silently partial list, and every scope judgment is
 * unsound on one.
 */
describe("partial file lists", () => {
  const big = (paths: string[]) => pr({ changedFilePaths: paths, changedFiles: 150 });

  it("refuses to call a PR untouched from an incomplete list", () => {
    // The in-scope file may simply be on page 2. This verdict closes the pull
    // request, so guessing here destroys correct work.
    expect(isUntouched(big(["src/other.ts"]), ["src/slugify.ts"])).toBe(false);
  });

  it("still reports untouched when the whole list was seen", () => {
    expect(isUntouched(pr({ changedFilePaths: ["src/other.ts"] }), ["src/slugify.ts"])).toBe(
      true,
    );
  });

  it("marks the ready verdict so a caller knows scope creep is a lower bound", () => {
    const verdict = evaluateMechanical(big(["src/slugify.ts"]), ["src/slugify.ts"]);
    expect(verdict).toEqual({
      kind: "ready",
      outOfScopeFiles: [],
      fileListComplete: false,
    });
  });
});

/**
 * §10.15. The agent's own "I am not finished" signal was the one thing
 * `evaluate.ts` ignored, so Factory merged work in progress — measured on real
 * merge commits in two different gates (gate2 #26 and #36, gate3 #7).
 *
 * The signal is the `[WIP]` title prefix, not the draft flag. The agent opens
 * every pull request as `[WIP] <title>` and renames the prefix away when it
 * finishes; it never clears `isDraft`, so keying on the draft flag would wait
 * for an event that never arrives and stall every Work Item permanently.
 *
 * The interesting half is not "don't merge". It is that a half-finished pull
 * request legitimately looks *broken* to every other check here — it touches
 * nothing in scope yet, or fails its own tests — and those verdicts close the
 * pull request. Judging work in progress destroys it.
 */
describe("work the agent has not finished", () => {
  it("does not merge a pull request the agent still calls [WIP]", () => {
    expect(
      evaluateMechanical(pr({ title: "[WIP] Add slugify" }), ["src/slugify.ts"]),
    ).toEqual({ kind: "in_progress" });
  });

  it("is not confused by unfinished work that is otherwise perfectly mergeable", () => {
    // Exactly the Gate 6 shape: green, mergeable, in scope — and still not
    // ours to merge, because the author says it is not done.
    const verdict = evaluateMechanical(
      pr({ title: "[WIP] Add slugify", checks: "SUCCESS", mergeable: "MERGEABLE" }),
      ["src/slugify.ts"],
    );
    expect(verdict.kind).toBe("in_progress");
  });

  it("ignores the draft flag, which the agent never clears", () => {
    // gate3 PR #16: renamed away from `[WIP]` (finished) but still a draft,
    // hours later. Treating draft as unfinished would wait on it forever.
    const verdict = evaluateMechanical(pr({ isDraft: true, title: "Add slugify" }), [
      "src/slugify.ts",
    ]);
    expect(verdict.kind).toBe("ready");
  });

  it("does not report half-written work as untouched, which would close it", () => {
    // The agent pushed its test file first and has not written the source yet.
    // `untouched` routes to retryOrEscalate, which closes the pull request —
    // so without this check that deletes a session's work mid-flight.
    const verdict = evaluateMechanical(
      pr({ title: "[WIP] Add slugify", changedFilePaths: ["test/slugify.test.ts"] }),
      ["src/slugify.ts"],
    );
    expect(verdict.kind).toBe("in_progress");
  });

  it("does not report unfinished work's failing checks as a failed attempt", () => {
    // An unfinished change failing its own tests is expected, not a defect.
    const verdict = evaluateMechanical(
      pr({ title: "[WIP] Add slugify", checks: "FAILURE" }),
      ["src/slugify.ts"],
    );
    expect(verdict.kind).toBe("in_progress");
  });

  it("still retries work the agent declined, rather than waiting forever", () => {
    // Ordering guard: `declined` and `no_op` stay ahead of `in_progress` so an
    // agent that died or refused is still retried on the existing schedule.
    // Without this, adding the check would have introduced a new way to hang.
    const verdict = evaluateMechanical(
      pr({
        title: "[WIP] Add slugify",
        changedLines: 0,
        changedFiles: 0,
        changedFilePaths: [],
        commitSubjects: [INITIAL_PLAN_COMMIT],
      }),
      ["src/slugify.ts"],
    );
    expect(verdict.kind).toBe("no_op");
  });

  it("merges normally once the agent renames away the prefix", () => {
    const verdict = evaluateMechanical(pr({ title: "Add slugify" }), [
      "src/slugify.ts",
    ]);
    expect(verdict.kind).toBe("ready");
  });

  it("matches the prefix case-insensitively and with leading space", () => {
    expect(evaluateMechanical(pr({ title: "  [wip] Add slugify" })).kind).toBe(
      "in_progress",
    );
  });

  it("does not treat an incidental mention of WIP as unfinished", () => {
    // Only the prefix is the signal. A title merely containing the word must
    // not stall the item.
    expect(evaluateMechanical(pr({ title: "Add wip-status helper" })).kind).toBe(
      "ready",
    );
  });
});
