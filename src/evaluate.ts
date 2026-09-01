/**
 * Mechanical, pre-merge checks on a Work Item's current pull request (§5.1).
 *
 * PROBE-001's headline finding: `conclusion: success` does not mean the work
 * was done. These are the cheap, deterministic checks that run before any
 * model reads the diff (§5.2) — most failures never reach a model, because
 * they are already visible in the PR's own artifacts. A no-op or a decline is
 * a **failed attempt, not a result** (§5.1): `evaluateMechanical` classifies
 * it as such rather than as something ready to merge.
 *
 * Every function here is pure, takes only a `LinkedPullRequest` (plus, for
 * `isUntouched`, the Work Item's declared file scope), and performs no I/O —
 * the same guarantee `state.ts` holds (§1), so this is unit-tested without a
 * network.
 */

import { DECLINE_TITLE_PATTERN, isNoOp } from "./state.js";
import type { LinkedPullRequest } from "./types.js";

/**
 * A PR that explicitly declines the Work Item as not actionable.
 *
 * PROBE-001's only measured decline — an impossible task ("target file does
 * not exist") — produced the *same* artifact as a plain no-op: empty diff,
 * only the `Initial plan` commit, with the explanation appearing solely in
 * the PR title (`No-op: impossible task — target file does not exist`).
 * `isNoOp` alone already catches that case. This check exists so the reason
 * is distinguishable in logs and escalation messages (§10's "what did
 * Director believe and why" must be answerable from the log alone) — it is
 * layered on top of `isNoOp`, never a replacement for it, and deliberately
 * conservative: free-text alone is not trusted as primary evidence, since
 * PROBE-001 also found `[WIP]` titles appear on both genuine work and empty
 * failures.
 *
 * The pattern itself lives in `state.ts`, which needs it to exempt an explicit
 * decline from the empty-PR grace period (§10.5, F3) — there is nothing to
 * wait for once the agent has given its final answer.
 */
export function isDeclined(pr: LinkedPullRequest): boolean {
  return isNoOp(pr) && DECLINE_TITLE_PATTERN.test(pr.title);
}

/**
 * Whether `path` falls inside a Work Item's declared file scope (§8's Work
 * Packet "Scope: files that may be modified"). An entry ending in `/` scopes
 * a whole directory; anything else must match exactly — deliberately no glob
 * engine, since PROBE-001 measured agents given a one-line scope constraint
 * touching only the named file, 11/11 times, so scope entries are expected to
 * be concrete paths or directories, not patterns.
 */
function inScope(path: string, scope: string): boolean {
  return scope.endsWith("/") ? path.startsWith(scope) : path === scope;
}

/**
 * A PR that changed real files but none of the Work Item's declared scope
 * (§5.1 "untouched"). `expectedFiles` is the compiled Work Packet's scope
 * list; omit it (e.g. before the compiler exists, §9 build order) to skip
 * this check entirely rather than fail closed on an item with no declared
 * scope yet.
 */
export function isUntouched(
  pr: LinkedPullRequest,
  expectedFiles: string[] | undefined,
): boolean {
  if (!expectedFiles || expectedFiles.length === 0) return false;
  if (isNoOp(pr)) return false; // already classified as no-op; do not double-count
  return !pr.changedFilePaths.some((path) =>
    expectedFiles.some((scope) => inScope(path, scope)),
  );
}

/**
 * GitHub's own three-way mergeability verdict (`PullRequest.mergeable`).
 * `UNKNOWN` means GitHub has not finished computing it yet — a real
 * `CONFLICTING` result is required before treating a PR as blocked (§6:
 * "attempt rebase; if clean, proceed; if not, close and re-dispatch").
 */
export function hasConflict(pr: LinkedPullRequest): boolean {
  return pr.mergeable === "CONFLICTING";
}

export type MechanicalVerdict =
  | { kind: "declined" }
  | { kind: "no_op" }
  | { kind: "untouched"; touchedFiles: string[] }
  | { kind: "conflict" }
  | { kind: "checks_pending" }
  | { kind: "checks_missing" }
  | { kind: "checks_failed" }
  | { kind: "ready" };

/**
 * Run every mechanical check in the precedence §5.1 implies — most-specific
 * failure reason first, so exactly one verdict falls out:
 *
 *  1. `declined` / `no_op` — no usable diff exists at all; nothing else
 *     about the PR (its checks, its mergeability) is worth inspecting.
 *  2. `untouched` — a real diff exists but not where the Work Item scoped it.
 *  3. `conflict` — GitHub cannot merge this cleanly against the base branch.
 *  4. `checks_pending` / `checks_missing` / `checks_failed` — required checks
 *     have not yet cleared, never arrived, or failed.
 *  5. `ready` — passed every mechanical check; only the semantic check (§5.2)
 *     remains before merge.
 *
 * `ciExpected` is the Objective snapshot's `ciExpectedOnPullRequests`: pass it
 * so a PR carrying *no* checks in a repository that demonstrably runs CI on
 * pull requests is reported as `checks_missing` rather than `ready`. Omitting
 * it reproduces the pre-Gate-3 behaviour, where absent checks were silently
 * treated as "this repository has no CI" (§10.5, F1).
 */
export function evaluateMechanical(
  pr: LinkedPullRequest,
  expectedFiles?: string[],
  ciExpected = false,
): MechanicalVerdict {
  if (isDeclined(pr)) return { kind: "declined" };
  if (isNoOp(pr)) return { kind: "no_op" };
  if (isUntouched(pr, expectedFiles)) {
    return { kind: "untouched", touchedFiles: pr.changedFilePaths };
  }
  if (hasConflict(pr)) return { kind: "conflict" };
  if (pr.checks === "PENDING") return { kind: "checks_pending" };
  if (pr.checks === "FAILURE") return { kind: "checks_failed" };
  // Gate 3 (§10.5, F1): `null` is not "no CI" when the repository is known to
  // run CI on pull requests. It also covers a workflow that fails to *start* —
  // GitHub creates the run, it produces zero jobs, and it therefore attaches
  // zero checks to the head commit, leaving the rollup null rather than
  // failing. Merging on that is merging with no CI evidence whatsoever.
  if (pr.checks === null && ciExpected) return { kind: "checks_missing" };
  return { kind: "ready" };
}
