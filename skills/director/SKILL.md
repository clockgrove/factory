---
name: director
description: Runs Factory's dispatch/evaluate/integrate loop against a GitHub Objective (an issue labelled `factory:objective`) until every Work Item is done or a human is needed. Use when asked to start, resume, or drive an Objective, or when checking in on one already in flight.
---

# Director

This is Factory's loop (IMPLEMENTATION-PLAN.md §4), and the only judgment-bearing component left in
it — every other step is a call to the bundled MCP server, which wraps Factory's own deterministic
library (`state.ts`, `dispatch.ts`, `evaluate.ts`, `graph.ts`). You do not have, and must not
improvise, any other write path to GitHub: no raw `gh` CLI mutations, no hand-written GraphQL, no
shelling out. If a GitHub write you believe is needed has no corresponding tool below, that is not a
gap to route around — it means the write does not belong in this loop (§15.3), and either the
Objective needs replanning or a human needs to be asked.

## When to use this skill

- Starting an Objective that has no Work Item graph yet.
- Resuming an Objective already in flight (a fresh session, a restart, a scheduled check-in — state
  is derived, never stored, so there is no special "resume" path; §1).
- Checking the current status of an Objective without necessarily driving it further.

## Inputs you need before starting

- `owner`, `repo` — the target repository.
- `number` — the Objective issue's number.
- `escalateTo` — the GitHub login of the human who owns this Objective, to hand a Work Item to when
  a cycle decides escalation is warranted (§7.2). Ask if you were not told this. **Pass it to your
  first `read_objective` so it gets validated while nothing is at stake.** It is otherwise not
  checked until the first call that actually uses it, and if that call is an escalation, it throws
  at the exact moment you are trying to reach a human. Do not infer this login from your working
  branch's prefix — that is a plausible-looking guess that has already been wrong once (§10.2, F4).
- `GITHUB_TOKEN` (or `GH_TOKEN`) must already be set in the MCP server's environment — you cannot set
  it yourself; if `read_objective` fails with a missing-token error, stop and tell the human.

## The loop

One cycle is: read → compile-if-needed → dispatch ready items → confirm dispatched items → retry or
escalate failed items → integrate reviewable items → check for replanning → decide whether to
continue. Every step below is a tool call; nothing here is inline GitHub access.

1. **Read.** Call `read_objective`. This is the cycle's one snapshot (§4.1) — every decision in this
   cycle is made from this single call's result, not a fresher read fetched mid-cycle. Its result
   already includes each Work Item's derived `state`, the list of `ready` Work Item numbers, and
   `platformExhausted`.

   - If `platformExhausted` is true, **stop and tell the human.** The circuit breaker inside the MCP
     server has tripped repeatedly (§7.3: "attempts are exhausted and no graph change looks likely to
     succeed" is a human question, not a retry). Do not keep cycling hoping it clears.
   - If the Objective is `closed`, stop; there is nothing to do.
   - **On an Objective with more than a handful of Work Items, pass `minimal: true`.** The coding
     agent quotes the entire Work Item issue back into its pull request body, so the response grows
     with both graph size and agent verbosity — a ten-item Objective overflowed the tool output
     limit outright (§10.2, F3). `minimal` drops only prose no derivation reads (each PR body and
     the Objective body, each replaced by a `bodyLength`); states, `ready`, `blockedBy` and
     `changedFilePaths` all survive. You need the Objective body only on the compile cycle, so a
     reasonable habit is: full read on cycle 1, `minimal: true` every cycle after.

2. **Compile, if this Objective has no Work Items yet.** `read_objective`'s `objective.items` will be
   empty. Invoke the `objective-compilation` skill against this Objective's title and body to produce
   a validated Work Item graph, then call `graph_apply` with it (plus `objectiveNumber`). Re-read
   (step 1) before doing anything else this cycle — `graph_apply`'s result is the created issues, but
   the loop always acts from a fresh `read_objective`, never from a prior tool's return value.

   `graph_apply` refuses (a no-op result, not an error) if the Objective already has Work Items — it
   is not idempotent by design (graph.ts's own contract). Never call it a second time against the
   same Objective; if you think the graph itself is wrong, that is replanning (step 6), not
   recompilation.

3. **Dispatch ready items.** For each Work Item number in `ready` (from step 1), call `dispatch_start`
   with that `objectiveNumber`/`workItemNumber`/`escalateTo`. Do this for every ready item in the
   snapshot — the MCP server's own pacing (`ContentCreationPacer`) staggers and rate-limits the actual
   GitHub calls underneath you (§4.1); you do not need to add your own delay between calls.

4. **Confirm dispatched items.** For each Work Item currently `dispatched` (from step 1's snapshot),
   call `dispatch_confirm`. This is §4.2's bounded reconciliation — a dispatched item that produced no
   pull request within the confirm window gets retried once, then escalated. You are not deciding
   this; the tool computes and applies the decision. Do not skip calling it just because the item
   "looks fine" — confirmation is how a lost assignment is ever discovered at all.

5. **Retry or escalate failed items.** For each Work Item currently `failed`, call
   `dispatch_retry_or_escalate` (an optional `reason` string is worth passing when you have specific
   evidence — e.g. what `evaluate_mechanical` reported — for why the last attempt was unusable).
   Attempts are counted from linked PRs, not a stored counter (§4.4); after 3, the tool escalates
   instead of retrying, on its own.

   `failed` is a settled judgment, not a guess: a pull request that exists but has no diff is left
   `in_flight` until it is past *both* the dispatch confirm window and its own ten-minute grace
   period, because the agent opens its draft PR within seconds and then works for minutes. You do
   not need to second-guess a `failed` verdict or "wait one more interval" to see if it self-corrects
   — if it says `failed`, the windows have already elapsed.

6. **Integrate reviewable items.** For each Work Item currently `for_review`, call
   `dispatch_integrate`, passing `expectedFiles` when the Work Item declared a `scope` (this is what
   lets `evaluate_mechanical`'s untouched-scope check run at all). Read the returned `verdict` kind:

   - `ready` — the pull request passed every mechanical check and a merge was attempted. Read
     `merged` in the result to know whether it actually landed. If `merged` is `false` there will be
     a `deferred` field explaining why: GitHub declined the merge for a transient reason, almost
     always that the base branch moved because a sibling pull request merged in the same window.
     **That is a race, not a failure.** Leave the pull request open, do not retry it, do not escalate
     it, and simply call `dispatch_integrate` again next cycle — the fresh snapshot will merge it.
     (Observed live in Gate 3, §10.5, where it surfaced as a thrown tool error; it no longer throws.)
   - `conflict` — the tool already attempted a rebase or closed-and-redispatched, per §6. If the same
     Work Item conflicts repeatedly, that is itself replanning evidence (step 7), not something to
     keep retrying past. The tool now stops on its own once attempts are exhausted, escalating with
     the *graph* diagnosis — a conflict a rebase cannot fix usually means two Work Items are editing
     one file with no dependency edge between them, which only replanning fixes.
   - `checks_pending` — usually settles within a cycle, so leave it. But if it persists and the pull
     request's checks have *never* started, GitHub is probably holding the run awaiting approval:
     call `approve_held_workflow_runs` rather than waiting indefinitely (see "CI that GitHub is
     holding" below).
   - `checks_missing` — the repository is known to run CI on pull requests, but this PR carries no
     checks at all. Usually a timing race that clears within a cycle, so leave it. If the *same*
     Work Item reports `checks_missing` for several consecutive cycles, call
     `approve_held_workflow_runs`; only escalate if that reports nothing was held, which means the
     repository's CI is failing to attach checks and no retry can fix it.
   - `checks_held` — the check suite concluded having run nothing, which means GitHub held the
     workflow awaiting approval. Not a failure. `dispatch_integrate` escalates it to a human on
     sight and never retries it; call `approve_held_workflow_runs` first (and read the
     `not_approvable` warning below before deciding what to do with the answer).
   - `mergeability_unknown` — GitHub has not finished computing whether the branch merges cleanly.
     Not a conflict, not a failure, and not `ready`: nothing is known yet. `dispatch_integrate`
     waits without writing anything, and GitHub settles it within a cycle. Simply come back next
     cycle; if it persists across several, push activity on the base branch is repeatedly
     invalidating the computation and that is worth reporting.
   - `checks_failed` / `untouched` / `no_op` / `declined` — the tool already closed the unusable PR
     and queued a retry (which the *next* cycle's step 5 will pick up as `failed`, or step 3 will
     redispatch once unassigned) — you do not need to act on the verdict directly, only read it to
     decide whether *you* should also be worried (repeated identical verdicts across cycles on the
     same Work Item is compiler-defect evidence, §5.3/§7.1, not something to keep silently absorbing).

   `dispatch_integrate` runs `evaluate_mechanical` internally to get its verdict — you do not need to
   call `evaluate_mechanical` first unless you specifically want to inspect the verdict before
   deciding whether to integrate at all (it never mutates anything on its own).

   **Mechanical checks are necessary, not sufficient.** Before treating a `ready` verdict as
   confidence to proceed, read the Work Item's diff yourself — **call `read_pull_request_diff` with
   the pull request's number** — and check it against §7.3's bar: acceptance criteria satisfied and
   nothing more, no deleted/rewritten behavior the Work Item did not
   name, nothing touching workflows/permissions/secrets/release configuration, and the change is a
   single reversible commit. `dispatch_integrate` will still merge a mechanically-clean PR that fails
   this bar — the semantic judgment (§5.2, §7.3) is yours, not the tool's. If it fails the bar, do not
   call `dispatch_integrate` for that item this cycle; stop and ask the human instead (§7.3's "stops
   and asks" list; see also the confidence bar below).

7. **Check for replanning.** If the snapshot looks stalled — every remaining Work Item is blocked on
   one that keeps failing, or a Work Item has repeatedly declined or repeatedly conflicted — invoke
   the `objective-compilation` skill to revise the graph (§7: split a Work Item, add a missing
   dependency, correct acceptance criteria). Replanning edits Work Items that are not yet `done`; it
   never touches ones already merged, and it never reassigns an `id` still in use. There is currently
   no tool to apply a *revision* to an existing graph (only `graph_apply`'s one-shot initial
   creation) — if replanning concludes new Work Items are needed for an Objective that already has
   some, stop and tell the human what the revised graph should be rather than inventing a write path
   that does not exist.

8. **Decide whether to continue.** If every Work Item is `done`, call `close_objective`. (Gate 0
   finding, 2026-09-01: GitHub does *not* auto-close a parent issue just because every sub-issue
   under it closed — an Objective with a 100%-complete Work Item graph was confirmed live to sit
   `OPEN` forever with no tool call here. `close_objective` is a no-op if the Objective is already
   closed or if any Work Item is not yet `done`, so it is always safe to call once you observe
   `allDone`.) Otherwise, if you are self-scheduling via a session automation, keep the interval
   short — closer to 1 minute than 5 for a small Objective (§4.1's 30s bare-metal `POLL_INTERVAL` is
   the right instinct; scale up only for a genuinely large Objective where a tight interval would
   just waste cycles reading unchanged state). A running Director must stay responsive to messages
   arriving between cycles — a human checking in, a correction, a nudge — not just to its own timer
   (Gate 1 finding, 2026-09-01: a 5-minute interval combined with a human messaging the same session
   directly queued a backlog of a dozen-plus messages behind long-running cycles). Keep each cycle's
   own work to exactly this loop — one `read_objective`, act on what it returns, stop — so the next
   queued message is always picked up promptly rather than sitting behind an oversized turn. Repeat
   from step 1 with a fresh read.

## The confidence bar (§7.3) — read this before calling any dispatch/integrate tool

Act autonomously, including merging, only when **all** hold:

- mechanical checks pass (the tool's own `verdict.kind === "ready"`)
- the diff satisfies the Work Item's acceptance criteria and nothing more — **your own read of the
  actual patch text, via `read_pull_request_diff`.** `evaluate_mechanical` deliberately does not
  make this judgment (§5.1 is mechanical only), and `read_objective` reports `changedFilePaths`
  but no content. A `ready` verdict therefore means "open, touches the expected files, mergeable" —
  considerably weaker than it reads. It is not a substitute for this line.
- the change is reversible: one squash commit on a branch, revertible without coordination
- nothing touches auth, secrets, permissions, CI configuration, or dependency sources

**Any acceptance criterion about what the code *does* requires the diff read, not file paths.**
"Must import and actually call `truncate` rather than reimplement it" is invisible in
`changedFilePaths` — both the correct and the incorrect implementation touch exactly the same file.
The pull request body will usually claim the criterion was met; §15.7 forbids treating that
self-report as evidence. Gate 2 merged four Work Items with exactly this criterion unverified,
because the tool to check it did not exist yet (§10.2, F1). It exists now — use it.

Two honest limits on that read, so you don't over-trust it either:

- If `truncated` is `true`, you did not see the whole change. Re-read the file you care about with
  a larger `maxPatchBytes` before concluding anything, or treat the criterion as unverified.
- Reading the diff tells you the code *says* the right thing, not that it *runs*. Where the
  repository has no CI, `checks` is `null` and nothing has executed the tests (§10.2, F2) — so
  "the tests pass" is an assumption, not an observation. Say so when you report.
- `checks: null` now means only one thing: nothing at all reported. If the repository *does* run CI
  on pull requests, an absent result surfaces as `checks_missing`, and CI that concluded without
  executing anything surfaces as `checks_failed` — neither will silently merge. Read
  `ciExpectedOnPullRequests` on the Objective to know which world you are in, and say which one when
  you report on the merge.

**CI that GitHub is holding is Factory's problem to resolve, not a human's to babysit.** GitHub
parks workflow runs on coding-agent pull requests in `action_required` until a maintainer clicks
"Approve and run workflows". While the pull request is open those runs sit there executing nothing,
so `evaluate_mechanical` honestly reports `checks_pending` — and it will report it forever, because
the checks genuinely never arrive. Gate 3 hit exactly this on all four items and merged through it
(§10.5, F1). Note the trap in the evidence: an unapproved run only flips to `failure` when the pull
request is *closed or merged*, which cancels it, so a post-mortem shows "CI failed" for something
that was never allowed to start.

Do not wait it out, and do not merge past it. Call **`approve_held_workflow_runs`**. It performs a
blast-radius review and only approves if approving cannot escalate what CI is permitted to do — the
diff must leave workflow definitions, actions, dependency manifests, lockfiles and registry config
untouched, the repository's default workflow token must be read-only, and no pull-request workflow
may reference a secret. If any of those fail it escalates to a human with the specific reason
instead. Either way you get a decision rather than a stall.

Call it as soon as `checks_held`, `checks_pending` or `checks_missing` persists past one cycle on a
pull request whose checks have never started. It is safe to call speculatively: with nothing held it
returns `no_runs_held` and writes nothing. If it returns `escalated`, do not try to route around it —
the review found something that genuinely needs a human, and merging on `mergeable` alone would be
the CI bypass this tool exists to close.

**Expect `not_approvable` on a coding-agent pull request.** GitHub's per-run approve endpoint covers
only *fork* pull requests. A coding-agent pull request is a same-repo branch held by the repository's
Copilot Actions workflow-approval requirement, and the per-run call is refused outright (Gates 4 and
4b, §10.7 — GitHub's verbatim reply: *"This run is not from a fork pull request or queued by the
Actions bot"*). The only mechanism that releases that hold is the repository setting itself, which is
readable over REST and **has no write API** — so Factory cannot clear it, and a human must. The tool
has already escalated by the time you see this. When you do:

- **Do not retry it.** The refusal is deterministic; a second call returns byte-identically.
- **Do not merge without CI to get moving.** That is precisely Gate 3's flaw.
- **Do not close and re-dispatch.** The replacement pull request will be held identically, and you
  will have destroyed correct work for nothing.
- **Report the two things a human can actually do**: click *Approve and run workflows* on the pull
  request, or turn the requirement off in Settings → Copilot → Coding agent so later Work Items are
  not blocked the same way. Include the review's repository-scoped finding — `repoScopeSafe` with no
  blockers means turning it off is low-risk for that repository; blockers listed means it is not, and
  approving the single run is the narrower action. That evidence is exactly what the human needs in
  order to decide, and the tool has already written it to the Work Item.

`not_approvable` is also what you get when the per-run approve fails for any other permanent reason.
Either way it carries a `failures[]` array naming each run and GitHub's own message — read that
rather than inferring the cause.

A `checks_held` verdict says the same thing from the evaluator's side: the check suite concluded
having emitted zero runs. It is *not* a test failure and must never be treated as one — `integrate`
escalates it directly rather than retrying, for the reason above.

Stop and ask a human (via `dispatch_retry_or_escalate` if the Work Item is `failed`, or by directly
telling the operator otherwise — there is no tool for "escalate a `for_review` or `dispatched` item
right now for a judgment reason" beyond what the confirm/retry tools already do on their own
mechanical triggers) when **any** hold:

- intent is ambiguous, or acceptance criteria admit more than one honest reading
- the diff touches workflows, permissions, secrets, or release configuration
- existing behavior not named in the Work Item is deleted or rewritten
- a conflict needs a judgment call about intent, not a mechanical rebase
- attempts are exhausted and no graph revision looks likely to succeed
- `platformExhausted` is true (step 1)

The asymmetry is deliberate (§7.3): merging a reviewed, reversible, in-scope change is cheap to undo;
guessing at intent is not. Escalating is a **successful outcome** of a cycle, not a failure of one
(§7.1) — a well-founded "I stopped because X" is exactly the loop working as designed.

**A settled example, so this does not have to be re-derived every cycle:** a compiled acceptance
criterion naming an exact test file path (e.g. `test/foo.test.ts`) is a common convention statement,
not a load-bearing scope boundary. Gate 1 observed the GitHub coding agent colocate test files next
to their source under `src/` instead of the declared `test/` path in 3 of 3 Work Items, consistently
— not a one-off mistake. Treat a test file that exists, is real (not empty/stubbed), and actually
covers the function as satisfying the criterion's substance even if its exact path differs from what
was declared, *provided* nothing about the repo's actual tooling depends on the literal path (e.g. a
test runner configured to glob only `test/`, which would make this a real functional break, not a
convention variance — check the repo's `conventions`/config before assuming it doesn't matter). This
is intent-is-ambiguous territory only if the Work Item's scope treats the path as load-bearing on its
own terms; do not manufacture that ambiguity by default.

## Reporting discipline

If you are running under supervision (a human or another agent watching this session, able to
receive a message from it), **do not send a progress notification for every healthy cycle.** A
routine cycle — read, dispatch/confirm/integrate exactly what the snapshot calls for, nothing
surprising — needs no outbound message at all; your own reasoning in this turn is already the
auditable log (§10's instrumentation requirement is about *being able to answer* "what did Director
believe and why" after the fact by inspecting the session, not about proactively pushing that answer
out on every cycle). Reserve an actual notification for the specific terminal/blocking conditions
this skill already names: the Objective closes, `platformExhausted` becomes true, a Work Item is
escalated, or a genuine stall (nothing ready/dispatched/for_review and no progress across several
consecutive cycles). Sending one message per cycle regardless of outcome does not make Director more
observable — it floods whatever is watching faster than a supervised turn can drain, which was
itself a real Gate 1 finding (§10.1): the fix belongs here, in the skill every invocation loads, not
in per-run kickoff wording that has to be reinvented (and re-forgotten) each time.

## Common edge cases

- **`read_objective` reports a Work Item in a state you did not expect.** Trust the derived state
  over your own memory of a previous cycle — it is recomputed fresh from GitHub every call, and a
  human may have acted on the issue directly between cycles (e.g. reassigning Copilot after
  escalation is the human's ordinary "carry on" gesture, §7.2 — you will simply see the item as
  `unstarted` or `dispatched` again next cycle, with no special handling needed).
- **A dispatch/confirm/retry/integrate tool returns `{"action": "no-op", ...}`.** This means the Work
  Item was not in the state the tool expects (e.g. you called `dispatch_confirm` on an item that is
  no longer `dispatched`) — read the reason, do not retry the same call; re-derive from a fresh
  `read_objective` next cycle instead.
- **A tool call fails outright (an error result).** Distinguish a platform refusal (rate limit,
  secondary abuse limit, GitHub outage) from a real Work Item failure. The former is not the Work
  Item's fault and must never consume one of its 3 attempts (§4.4) or trigger escalation — the tool
  itself already applies the shared circuit breaker/pacer before making the underlying GitHub call,
  so a thrown error here past that point is either a genuine, non-retryable defect (fix your call) or
  the platform is worse than the breaker's own budget accounts for (check `platformExhausted` next
  cycle, and stop if it is now true).
- **You are asked to drive multiple Objectives at once.** Run the loop for each independently; they
  share nothing but the same MCP server process (and therefore the same underlying circuit
  breaker/pacer/concurrency limiter — a refusal on one Objective's dispatch legitimately slows down
  another's, by design, §15.3's "one process allowed to write").
- **A merged pull request reports `mergeable: "UNKNOWN"`.** Expected, and not a problem: GitHub
  stops computing mergeability once a PR is closed. Never treat `mergeable` as evidence about a PR
  that is already merged, and never gate anything on it (§10.2, F5).
