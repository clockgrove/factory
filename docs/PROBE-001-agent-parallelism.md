# PROBE-001 — Copilot agent parallelism and terminal status

**Date:** 2026-08-30
**Repository:** `clockgrove/factory-probe-parallel` (disposable)
**Question:** Does GitHub Copilot agent assignment parallelize, and does it report terminal status
reliably enough for an unattended orchestration loop?

This probe was run **before any implementation**, because the entire v2 architecture rests on the
answer. Recording measured limits rather than desired ones is a direct response to finding F7 in
[`PRD.md`](PRD.md).

## Method

Three waves of trivial, independent Python tasks in a disposable repository. Each task touched a
distinct file, so any observed serialization would be the platform's rather than conflict avoidance.
Issues were assigned to `copilot-swe-agent` via the GraphQL `replaceActorsForAssignable` mutation.

| Wave | Tasks | Purpose |
|---|---|---|
| 1 | 4 | Baseline parallelism and correctness |
| 2 | 8 (incl. 1 impossible) | Failure signalling |
| 3 | 26 (incl. 2 same-file) | Burst ceiling, degradation, write conflicts |

## Results

### Capability

| Capability | Measured |
|---|---|
| Assignable actor | `copilot-swe-agent`, Bot `BOT_kgDOC9w8XQ` |
| Assignment mechanism | GraphQL `replaceActorsForAssignable` |
| Peak concurrent sessions | **24, no queueing ceiling reached** |
| Assignment → draft PR | 3–7 s |
| Assignment → terminal | ~75–80 s (trivial task) |
| 8 parallel tasks, wall clock | ~80 s (vs ~10 min serial) |
| Correctness | 11/11 actionable tasks correct and minimal |
| PR → Issue linkage | `closingIssuesReferences` correct, 12/12 |
| Self-merge | **Never.** PRs stay draft; issues stay open |

### Finding 1 — run conclusion is not the outcome signal

All 8 wave-2 runs reported `conclusion: success`, **including a deliberately impossible task**
(modify a file stated to exist but which does not).

The agent handled it correctly, but signalled only in the pull request:

- Title: `No-op: impossible task — target file does not exist`
- Body: explains the unmet precondition, quoting the issue
- Diff: **empty**
- Commits: `Initial plan` only

It did not invent the missing file, and it did not fail the run.

**Consequence:** outcome evaluation must read the pull request — diff, commits, body — never the run
conclusion. An orchestrator polling `conclusion` would mark impossible work complete. A no-op is
machine-detectable as *empty diff + no commit beyond `Initial plan`*.

### Finding 2 — the substrate is lossy under burst

26 issues assigned in 35 s:

| Outcome | Count |
|---|---|
| Assignments accepted | 26 / 26 |
| Sessions actually created | **24 / 26** |
| Succeeded | 22 |
| Failed | 2 |
| Correct PRs | **22 / 26 (85%)** |

Four degradation modes, **all silent**:

1. **Dispatch loss.** Two issues showed `Copilot` as assignee but never produced a session.
   Assignment acknowledged; work never started; nothing on the issue indicates it.
2. **Backend saturation.** Both failures were `[cca-engine] Fatal: Failed to fetch job details:
   HTTP 500`, 3–13 s into the run. Infrastructure, not task-related.
3. **Empty `[WIP]` PRs.** Each failed session still opened a draft PR with an empty diff and a
   `[WIP]` title — not distinguishable from real work by title alone.
4. **Client-side `429`** while polling run status at this scale.

### Finding 3 — conflicting writes are isolated, not resolved

Two issues deliberately targeted the same file. Both sessions branched from the same base commit and
each produced a clean, correct, non-overlapping diff. GitHub isolates them by branch; conflict
surfaces only at the *second merge*.

Integration is therefore the loop's responsibility, not the agent's — which is the correct place
for it.

## Design requirements

- **Confirm dispatch; never assume it.** Assignment success ≠ session started. Verify a session
  exists and re-dispatch when it does not.
- **Treat `[WIP]` + empty diff as a failed attempt** to retry, not a result to evaluate.
- **Make retry idempotent.** Transient infrastructure failure is normal at burst.
- **Budget ~85% first-pass success**; design retry as routine.
- **Throttle both dispatch and polling.** Both directions rate-limit.

## Verdict

The load-bearing assumption **holds**, with a bounded caveat.

Cloud-hosted Copilot agent sessions are a viable execution substrate: parallel to at least 24, fast,
correct, honest about non-actionability, and non-self-merging. The caveat is that the substrate is
lossy under burst, so the loop needs exactly three things: **dispatch confirmation, no-op detection,
and idempotent retry**.

That is a small, well-understood supervisor — not a permit protocol, a serialization fence, or a
terminal router.
