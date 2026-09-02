/**
 * Mechanical, pre-merge checks on a Work Item's current pull request (§5.1).
 *
 * `conclusion: success` does not mean the work was done. These are the cheap,
 * deterministic checks that run before any model reads the diff (§5.2) — most
 * failures never reach a model, because they are already visible in the PR's
 * own artifacts. A no-op or a decline is a **failed attempt, not a result**
 * (§5.1): `evaluateMechanical` classifies it as such rather than as something
 * ready to merge.
 *
 * Every function here is pure, takes only a `LinkedPullRequest` (plus, for
 * `isUntouched`, the Work Item's declared file scope), and performs no I/O —
 * the same guarantee `state.ts` holds (§1), so this is unit-tested without a
 * network.
 */

import { DECLINE_TITLE_PATTERN, isNoOp, isWorkInProgress } from "./state.js";
import { executionAffectingReason } from "./approval.js";
import type { LinkedPullRequest } from "./types.js";

/**
 * A PR that explicitly declines the Work Item as not actionable.
 *
 * An impossible task ("target file does not exist") produces the *same*
 * artifact as a plain no-op: empty diff, only the `Initial plan` commit, with
 * the explanation appearing solely in the PR title (`No-op: impossible task —
 * target file does not exist`). `isNoOp` alone already catches that case. This
 * check exists so the reason is distinguishable in logs and escalation
 * messages (§10's "what did Director believe and why" must be answerable from
 * the log alone) — it is layered on top of `isNoOp`, never a replacement for
 * it, and deliberately conservative: free-text alone is not trusted as primary
 * evidence, since `[WIP]` titles appear on both genuine work and empty
 * failures.
 *
 * The pattern itself lives in `state.ts`, which needs it to exempt an explicit
 * decline from the empty-PR grace period — there is nothing to wait for once
 * the agent has given its final answer.
 */
export function isDeclined(pr: LinkedPullRequest): boolean {
  return isNoOp(pr) && DECLINE_TITLE_PATTERN.test(pr.title);
}

/**
 * Whether `path` falls inside a Work Item's declared file scope (§8's Work
 * Packet "Scope: files that may be modified"). An entry ending in `/` scopes
 * a whole directory; anything else must match exactly — deliberately no glob
 * engine, since agents given a one-line scope constraint have been measured
 * touching only the named file 11/11 times (docs/PLATFORM-BEHAVIOR.md), so
 * scope entries are expected to be concrete paths or directories, not patterns.
 */
function inScope(path: string, scope: string): boolean {
  return scope.endsWith("/") ? path.startsWith(scope) : path === scope;
}

/**
 * Whether `pr.changedFilePaths` is the *whole* file list.
 *
 * The GraphQL selection asks for `files(first: 100)` while `changedFiles` is
 * the true total, so a pull request touching more than 100 files arrives with a
 * silently partial list. Every scope judgment below is unsound on a partial
 * list, in both directions: an in-scope file may sit on page 2 (making a real
 * diff look `untouched`, which closes the pull request), and an out-of-scope
 * file may sit there too (making scope creep invisible).
 */
export function fileListComplete(pr: LinkedPullRequest): boolean {
  return pr.changedFilePaths.length >= pr.changedFiles;
}

/**
 * A PR that changed real files but none of the Work Item's declared scope
 * (§5.1 "untouched"). `expectedFiles` is the compiled Work Packet's scope
 * list; omit it before the compiler exists to skip
 * this check entirely rather than fail closed on an item with no declared
 * scope yet.
 */
export function isUntouched(
  pr: LinkedPullRequest,
  expectedFiles: string[] | undefined,
): boolean {
  if (!expectedFiles || expectedFiles.length === 0) return false;
  if (isNoOp(pr)) return false; // already classified as no-op; do not double-count
  // A partial file list cannot prove a negative. This verdict routes to
  // `retryOrEscalate`, which *closes the pull request* — so claiming "touched
  // nothing in scope" from incomplete evidence destroys correct work whose
  // in-scope file merely sorted past the first page.
  if (!fileListComplete(pr)) return false;
  return !pr.changedFilePaths.some((path) =>
    expectedFiles.some((scope) => inScope(path, scope)),
  );
}

/**
 * Changed paths that fall outside the Work Item's declared scope.
 *
 * `isUntouched` fires only when *no* declared file was touched, so a pull
 * request that does everything it was asked **plus** anything else it likes has
 * always passed every mechanical check. Replacement pull requests can add files
 * such as a 1454-line `package-lock.json` that no Work Item declared; this is
 * where the pipeline makes that visible.
 *
 * This is reported rather than enforced. Scope creep is frequently legitimate —
 * a Work Item may correctly update a test outside its scope rather than leaving
 * it broken — and the `untouched` precedent shows what over-enforcing costs:
 * that verdict closes the pull request. So this feeds §5.2's semantic
 * review, where a model reads the diff, instead of mechanically failing the
 * item. The genuinely dangerous subset is handled separately and does block;
 * see `sensitiveSurfaceFiles`.
 */
export function outOfScopeFiles(
  pr: LinkedPullRequest,
  expectedFiles: string[] | undefined,
): string[] {
  if (!expectedFiles || expectedFiles.length === 0) return [];
  return pr.changedFilePaths.filter(
    (path) => !expectedFiles.some((scope) => inScope(path, scope)),
  );
}

/**
 * Changed paths that can redefine what CI executes or what it can reach —
 * workflows, composite actions, dependency manifests and lockfiles, registry
 * configuration (§7.3: "no security-sensitive surface: auth, secrets,
 * permissions, CI configuration, dependency sources").
 *
 * Deliberately **not** filtered by declared scope. Scope is written by the
 * compiler, which is itself a model reading an Objective body; letting a Work
 * Item declare `.github/workflows/ci.yml` in scope and thereby buy an
 * autonomous merge of it would make the safety property self-certifying. A
 * human confirms these whether or not someone wrote them down in advance.
 */
export function sensitiveSurfaceFiles(
  pr: LinkedPullRequest,
): { path: string; reason: string }[] {
  const found: { path: string; reason: string }[] = [];
  for (const path of pr.changedFilePaths) {
    const reason = executionAffectingReason(path);
    if (reason !== null) found.push({ path, reason });
  }
  return found;
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
  | { kind: "mergeability_unknown" }
  | { kind: "checks_pending" }
  | { kind: "checks_missing" }
  | { kind: "checks_held" }
  | { kind: "checks_failed" }
  | { kind: "in_progress" }
  | { kind: "sensitive_surface"; files: { path: string; reason: string }[] }
  | {
      kind: "ready";
      /**
       * Changed paths outside the declared scope. Empty on a clean pull
       * request. Non-empty does not block the merge — it is evidence §5.2's
       * semantic review must account for before Director merges.
       */
      outOfScopeFiles: string[];
      /**
       * False when more than 100 files changed, so `outOfScopeFiles` is a
       * lower bound rather than the whole story.
       */
      fileListComplete: boolean;
    };

/**
 * Run every mechanical check in the precedence §5.1 implies — most-specific
 * failure reason first, so exactly one verdict falls out:
 *
 *  1. `declined` / `no_op` — no usable diff exists at all; nothing else
 *     about the PR (its checks, its mergeability) is worth inspecting.
 *  2. `in_progress` — the agent says it has not finished. Nothing below is meaningful
 *     yet, and several of those branches close or rebase the pull request.
 *  3. `untouched` — a real diff exists but not where the Work Item scoped it.
 *  4. `conflict` — GitHub cannot merge this cleanly against the base branch.
 *  5. `checks_pending` / `checks_missing` / `checks_failed` — required checks
 *     have not yet cleared, never arrived, or failed.
 *  6. `sensitive_surface` — mergeable, but the diff changes what CI executes or
 *     what it can reach, which §7.3 reserves for a human.
 *  7. `ready` — passed every mechanical check; only the semantic check (§5.2)
 *     remains before merge.
 *
 * `ciExpected` is the Objective snapshot's `ciExpectedOnPullRequests`: pass it
 * so a PR carrying *no* checks in a repository that demonstrably runs CI on
 * pull requests is reported as `checks_missing` rather than `ready`. Omitting
 * it treats absent checks as "this repository has no CI". `"unknown"` — the
 * probe failed rather than answered — blocks exactly as `true` does, because a
 * network error is not evidence that a repository has no CI.
 */
export function evaluateMechanical(
  pr: LinkedPullRequest,
  expectedFiles?: string[],
  ciExpected: boolean | "unknown" = false,
): MechanicalVerdict {
  if (isDeclined(pr)) return { kind: "declined" };
  if (isNoOp(pr)) return { kind: "no_op" };
  // Third, and ahead of every check that can *act* on the pull request. The
  // agent's own statement that it has not finished is the most authoritative
  // completion signal available — the agent knows, and nothing else here does.
  //
  // That signal is the `[WIP]` title prefix, **not** `isDraft`. Across observed
  // coding-agent pull requests (12/12 in one representative batch, plus
  // additional repositories), the agent opens as `[WIP] <title>` and renames the
  // prefix away when it finishes. It never clears the draft flag: observed
  // `ReadyForReviewEvent`s are Factory's own token, and finished-and-renamed
  // coding-agent pull requests can remain `isDraft: true`. Keying on `isDraft`
  // would therefore wait for an event that never arrives and stall every Work
  // Item permanently (§5.1).
  //
  // This prevents merging unfinished work. One measured late rename happened 98
  // seconds after merge eligibility; other early-merge shapes matched it. On any
  // change large enough to arrive in pieces — source first, tests second — a
  // merge before the completion signal lands half the work and closes the Work
  // Item as done.
  //
  // Ordered *after* `declined`/`no_op` deliberately, so an agent that died or
  // refused still retries on the existing schedule and this introduces no new
  // way to hang. Ordered *before* `untouched`, `conflict` and `checks_failed`
  // because each of those closes or rebases the pull request: judging work in
  // progress does not merely merge too early, it destroys work that was still
  // being written. A half-pushed change legitimately touches nothing in scope
  // yet, and legitimately fails its own tests.
  if (isWorkInProgress(pr)) return { kind: "in_progress" };
  if (isUntouched(pr, expectedFiles)) {
    return { kind: "untouched", touchedFiles: pr.changedFilePaths };
  }
  if (hasConflict(pr)) return { kind: "conflict" };
  if (pr.checks === "PENDING") return { kind: "checks_pending" };
  // Before `checks_failed`, because these are the same `FAILURE` rollup and
  // only this branch can tell them apart. A check suite that concluded without
  // ever emitting a run did not test anything and did not fail: on a
  // coding-agent pull request it means GitHub held the workflow awaiting a
  // maintainer's approval (§9). Reporting that as `checks_failed` sends it to
  // the retry path, which closes the pull request and re-dispatches — destroying
  // correct work because CI was never allowed to start, and producing a fresh
  // pull request held in exactly the same way.
  if (pr.checksNeverStarted) return { kind: "checks_held" };
  if (pr.checks === "FAILURE") return { kind: "checks_failed" };
  // `null` is not "no CI" when the repository is known to run CI on pull
  // requests. It also covers a workflow that fails to *start* — GitHub creates
  // the run, it produces zero jobs, and it therefore attaches zero checks to the
  // head commit, leaving the rollup null rather than failing. Merging on that is
  // merging with no CI evidence whatsoever.
  if (pr.checks === null && ciExpected !== false) return { kind: "checks_missing" };
  // Last, so a real check failure is still reported decisively rather than
  // delayed a cycle. `UNKNOWN` is GitHub still computing mergeability, not a
  // clean merge — and everything above has already passed, so without this the
  // verdict would be `ready`, which Director reads as "the mechanical half is
  // satisfied, only judgment remains". The merge itself is safe (a genuinely
  // conflicting merge is refused and deferred), so this is about not claiming
  // evidence that does not exist yet. It resolves within a cycle.
  if (pr.mergeable === "UNKNOWN") return { kind: "mergeability_unknown" };
  // Last of the blocking checks, and only reached by a pull request that is
  // otherwise mergeable — the point at which "merge this without asking"
  // becomes a live proposal. §7.3 makes a security-sensitive surface an
  // unconditional bar on autonomy, so this escalates to a human rather than
  // retrying: the work is not wrong, it simply is not Factory's to wave
  // through. Retrying would close a correct pull request and produce another
  // one just like it.
  const sensitive = sensitiveSurfaceFiles(pr);
  if (sensitive.length > 0) return { kind: "sensitive_surface", files: sensitive };
  return {
    kind: "ready",
    outOfScopeFiles: outOfScopeFiles(pr, expectedFiles),
    fileListComplete: fileListComplete(pr),
  };
}
