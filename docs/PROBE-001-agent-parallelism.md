# PROBE-001 — Copilot agent parallelism and terminal status

**Date:** 2026-08-30
**Repository:** a disposable probe repository (archived after the probe concluded)
**Question:** Does GitHub Copilot agent assignment parallelize, and does it report terminal status
reliably enough for an unattended orchestration loop?

This probe was run **before any implementation**, because the entire architecture rests on the
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

### Finding 4 — a third throttle plane, invisible to `/rate_limit`

Observed while building fixtures on 2026-08-30, and reproduced deliberately.

Every REST call returned:

```
403  API rate limit exceeded for user ID <id>
```

while the documented quota endpoint simultaneously reported:

```
core:    5000/5000
graphql: 5000/5000
```

Both planes fully unconsumed, yet every request refused. `git push` over HTTPS
continued to work throughout, so this is neither a token nor a network problem.

There are therefore **three distinct throttles on three planes**, and only one of them is
introspectable:

| # | Plane | Signal | Visible in `/rate_limit`? |
|---|---|---|---|
| 1 | REST/GraphQL quota | `429`, `x-ratelimit-remaining: 0` | ✅ |
| 2 | Agent engine | `HTTP 500` inside the session | ❌ |
| 3 | Per-user abuse/secondary | `403 rate limit exceeded` | ❌ **reports full quota** |

Plane 3 also produced a `403` on the Copilot session-creation endpoint under sustained
agent dispatch, so it is not specific to repository writes.

**Why this matters more than it looks.** Octokit's `plugin-throttling` and `plugin-retry`
model plane 1. Planes 2 and 3 are outside that model, and plane 3 is actively misleading:
a client that consults `/rate_limit` to decide whether it may proceed will conclude it has
full budget and keep hammering a closed door.

The failure mode this creates is specific and severe. A `403` arriving at dispatch time is
trivially misread as *"this Work Item failed"* — which triggers retry, then escalation,
then replanning, all against a platform that is merely asking the client to wait. That is
how a loop starts thrashing, and it is precisely the class of behavior a prior implementation
accumulated machinery to survive.

**Requirement.** Factory must classify platform refusals as **platform-unavailable, retry
later** — a property of the *substrate*, never of the *Work Item*. Concretely: a `403`
carrying rate-limit text, a `429`, or a `5xx` must not increment an attempt count, must not
mark an item failed, and must not reach the replanner. Corroborating this in the derived
model is cheap, because attempts are counted from linked PRs (§4.4): a refused dispatch
creates no PR, so a correctly-implemented client cannot inflate the count even if it
misclassifies.

Also: back off on wall-clock time, not on quota introspection. The only trustworthy signal
that plane 3 has cleared is a successful request.

**Addendum (2026-08-30, PRD investigation session, verified against
docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api and
.../best-practices-for-using-the-rest-api).** Plane 3 recurred five times in a single session of
light, non-burst API usage (a handful of GraphQL introspection calls, two issue mutations, and REST
reads spread over roughly 15 minutes) — not just under PROBE-001's original 26-parallel-dispatch
burst. One recurrence persisted through a 45s wall-clock backoff and a retry. This revises the
original framing: plane 3 is not solely a burst-ceiling effect; it can trigger and hold under
ordinary, low-volume interactive use, on an unknown and unobserved cooldown ("there is not a way to
check the status of your secondary rate limit" — same docs). The requirement is unchanged (classify
as platform-unavailable, never as Work Item failure) but the implication is stronger, and the
official docs make it explicit that this is not merely a pacing nuisance:

> Continuing to make requests while you are rate limited may result in the banning of your
> integration.

The documented secondary-limit triggers, any one of which is sufficient:

| Trigger | Documented threshold |
|---|---|
| Concurrent requests | > 100, shared across REST + GraphQL |
| Points per minute, single endpoint | > 900 (REST) / > 2,000 (GraphQL); GET/query = 1pt, mutation = 5pts |
| CPU time | > 90s CPU per 60s real time (≤ 60s of which may be GraphQL) |
| Content-creating requests | > 80/minute or > 500/hour (issues, comments, PRs, assignments) |
| OAuth token requests | > 2,000/hour |

Factory's original wave shapes sat directly on these: 26 issues created in ~35s, and bursts of
`session.create` calls, are exactly the concurrent-request and content-creation triggers, not a
platform anomaly. This was self-inflicted by wave shape, not something GitHub did to us.

## Design requirements

- **Confirm dispatch; never assume it.** Assignment success ≠ session started. Verify a session
  exists and re-dispatch when it does not.
- **Treat `[WIP]` + empty diff as a failed attempt** to retry, not a result to evaluate.
- **Make retry idempotent.** Transient infrastructure failure is normal at burst.
- **Budget ~85% first-pass success**; design retry as routine.
- **Throttle both dispatch and polling.** Both directions rate-limit.
- **Separate platform refusal from work failure.** `403`/`429`/`5xx` are substrate conditions;
  they must never consume an attempt or reach the replanner (Finding 4).
- **Do not trust `/rate_limit` as a gate.** It reports full quota while refusing every call.
  Back off on wall-clock time and treat a successful request as the only clear signal.
- **Pace well under the documented secondary limits, not up to them** (`src/platform.ts`,
  `FACTORY_PACING`): cap concurrent in-flight calls to a handful (not 99), cap content-creating
  calls to roughly half the documented 80/min and 500/hour, and enforce a minimum 1s gap between
  mutative calls, per GitHub's own best-practice guidance to prefer serial requests.
- **Trip a wave-level circuit breaker on repeated refusals, not just a per-call retry**
  (`src/platform.ts`, `CircuitBreaker`): after a small number of consecutive refusals, pause *all*
  dispatch for a cooldown measured in minutes, growing on repeated trips, and surface for a human
  decision (§7.3) once the breaker has tripped enough times — because continuing to retry through
  a secondary limit risks the integration being banned, not just a wasted call.

## Verdict

The load-bearing assumption **holds**, with a bounded caveat.

Cloud-hosted Copilot agent sessions are a viable execution substrate: parallel to at least 24, fast,
correct, honest about non-actionability, and non-self-merging. The caveat is that the substrate is
lossy under burst, so the loop needs exactly three things: **dispatch confirmation, no-op detection,
and idempotent retry**.

That is a small, well-understood supervisor — not a permit protocol, a serialization fence, or a
terminal router.
