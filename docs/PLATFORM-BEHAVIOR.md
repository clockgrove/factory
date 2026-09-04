# Measured platform behavior

Factory's design rests on how GitHub's coding agent and API actually behave, not on how they are
documented to behave. This document records what was measured, so that every design consequence in
[`DESIGN.md`](DESIGN.md) can be traced to an observation rather than an assumption.

## v2 control-plane and local-harness conformance (September 2026)

- GitHub accepts custom refs under `refs/clockgrove-factory/...` through the Git data APIs.
- REST `PATCH /git/refs` with `force: false` is **not** compare-and-swap for custom refs: a sibling
  rewrite was accepted. Factory therefore uses GraphQL `updateRefs` with an exact `beforeOid`, which
  rejected the stale writer in the live probe.
- Codex CLI 0.153.0 supports the non-interactive flags Factory needs: ephemeral execution, ignored
  user configuration/rules, JSONL events, strict output schema, explicit sandbox mode, and working
  directory selection. A nested trivial worker completed successfully with the same contract. The
  installed CLI also accepts the release's explicit no-approval, disabled-web-search, command-network,
  network-proxy, and domain-policy overrides. Factory's argument-contract tests pin their exact
  composition so an empty Work Packet network list cannot silently become unrestricted egress.
- The pinned official `@openai/codex-sdk` exposes programmatic thread creation, streamed events,
  structured output, sandbox/approval/network options, usage, and abort signals. Factory's injected
  SDK contract tests prove option mapping, isolation, bounded event handling, artifact collection,
  cancellation, and cleanup without presenting the fake client as live Codex evidence. The installed
  default SDK route remains part of the live environment and adversarial release gates.
- The optional Daytona SDK exposes ephemeral sandboxes, TTL, domain allow-listing, named secrets,
  labels, file transfer, process execution, and deletion. The optional Vercel Sandbox SDK exposes
  non-persistent microVMs, hard timeouts, network policy/header injection, tags, file transfer,
  detached commands, and stop. Factory startup probes credentials without creating paid resources;
  paid-resource creation remains an opt-in integration test.

## Documented native-stack contract (not yet live conformance)

Factory isolates GitHub's versioned stacked-pull-request surface behind a capability probe and pins
the `2026-03-10` API version. The following are current documented contracts, not claims from
Factory's disposable-repository matrix:

- The [Stacks REST API](https://docs.github.com/en/rest/pulls/stacks) creates a stack from pull
  request numbers ordered bottom-to-top, and every higher PR base ref must match the head ref below.
- GitHub requires the [asynchronous merge endpoint](https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request-asynchronously)
  for a stacked PR. Factory binds the request and every pending poll to the validated head SHA and
  durably retains the returned UUID for response-loss and controller-restart recovery.
- GitHub documents a requested contiguous merge group as atomic. A completed lower group lands in
  order and [automatically rebases the next unmerged PR](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/merging-stacked-pull-requests),
  so Factory invalidates the changed head and reruns validation before requesting the next merge.
- Editing a lower layer or advancing trunk can require a cascading rebase. GitHub documents that
  operation through the website or `gh stack`, but does not document a REST rebase endpoint.
  Factory therefore never invents one: it waits with durable invalidation evidence for the observed
  base/head chain to become linear, and escalates on its existing bounded Objective deadline.

Native stacks are part of the v2 contract. The live gate in [`CONFORMANCE.md`](CONFORMANCE.md) must
exercise these behaviors with disposable branches before the v2 preview is published.

## Documented managed-agent contract (not yet live conformance)

GitHub documents both [Copilot cloud agent](https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-coding-agent)
and [OpenAI Codex](https://docs.github.com/en/copilot/concepts/agents/openai-codex) as coding agents
that can receive repository work and produce a branch or pull request. GitHub also documents
[third-party coding-agent assignment](https://docs.github.com/en/copilot/concepts/agents/about-third-party-coding-agents)
through issues and its agent surfaces. These are capability claims from GitHub, not evidence that
both agents are enabled or assignable in a particular adopter repository.

Factory therefore discovers assignable actors from the repository and requires one unambiguous,
provider-published identity before launch. GitHub documents the Copilot suggested-actor login
`copilot-swe-agent`, but its Codex documentation currently gives the GitHub App display name
`openai code agent` without a stable suggested-actor login or app identity. Factory pins the former
and keeps the latter profile fail-closed; a display name is not authorization evidence. The v2 live
gate must record a stable Codex identity and then exercise both GitHub Copilot and OpenAI Codex
through the same Work Item, session-budget, exact-head collection, independent-validation, and
recovery contract.

The remainder of this document records the original GitHub coding-agent measurements. Those findings
still govern the explicit `github-copilot/github-managed` compatibility backend; they are no longer
Factory's default execution architecture.

The measurements were taken in a disposable repository, before implementation, across three waves of
trivial independent tasks. Each task touched a distinct file, so any observed serialization would be
the platform's rather than an artifact of conflict avoidance. Issues were assigned to
`copilot-swe-agent` via the GraphQL `replaceActorsForAssignable` mutation.

| Wave | Tasks | Purpose |
|---|---|---|
| 1 | 4 | Baseline parallelism and correctness |
| 2 | 8 (incl. 1 impossible) | Failure signalling |
| 3 | 26 (incl. 2 same-file) | Burst ceiling, degradation, write conflicts |

## Capability

| Capability | Measured |
|---|---|
| Assignable actor | `copilot-swe-agent`, Bot `BOT_kgDOC9w8XQ` |
| Assignment mechanism | GraphQL `replaceActorsForAssignable` |
| Peak concurrent sessions | **24, no queueing ceiling reached** |
| Assignment → draft pull request | 3–7 s |
| Assignment → terminal | ~75–80 s (trivial task) |
| 8 parallel tasks, wall clock | ~80 s (vs ~10 min serial) |
| Correctness | 11/11 actionable tasks correct and minimal |
| Pull request → issue linkage | `closingIssuesReferences` correct, 12/12 |
| Self-merge | **Never.** Pull requests stay draft; issues stay open |

## Finding 1 — run conclusion is not the outcome signal

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

## Finding 2 — the substrate is lossy under burst

26 issues assigned in 35 s:

| Outcome | Count |
|---|---|
| Assignments accepted | 26 / 26 |
| Sessions actually created | **24 / 26** |
| Succeeded | 22 |
| Failed | 2 |
| Correct pull requests | **22 / 26 (85%)** |

Four degradation modes, **all silent**:

1. **Dispatch loss.** Two issues showed `Copilot` as assignee but never produced a session.
   Assignment acknowledged; work never started; nothing on the issue indicates it.
2. **Backend saturation.** Both failures were `[cca-engine] Fatal: Failed to fetch job details:
   HTTP 500`, 3–13 s into the run. Infrastructure, not task-related.
3. **Empty `[WIP]` pull requests.** Each failed session still opened a draft pull request with an
   empty diff and a `[WIP]` title — not distinguishable from real work by title alone.
4. **Client-side `429`** while polling run status at this scale.

## Finding 3 — conflicting writes are isolated, not resolved

Two issues deliberately targeted the same file. Both sessions branched from the same base commit and
each produced a clean, correct, non-overlapping diff. GitHub isolates them by branch; conflict
surfaces only at the *second merge*.

Integration is therefore the loop's responsibility, not the agent's — which is the correct place for
it.

## Finding 4 — a third throttle plane, invisible to `/rate_limit`

Every REST call returned:

```
403  API rate limit exceeded for user ID <id>
```

while the documented quota endpoint simultaneously reported:

```
core:    5000/5000
graphql: 5000/5000
```

Both planes fully unconsumed, yet every request refused. `git push` over HTTPS continued to work
throughout, so this is neither a token nor a network problem.

There are therefore **three distinct throttles on three planes**, and only one is introspectable:

| # | Plane | Signal | Visible in `/rate_limit`? |
|---|---|---|---|
| 1 | REST/GraphQL quota | `429`, `x-ratelimit-remaining: 0` | ✅ |
| 2 | Agent engine | `HTTP 500` inside the session | ❌ |
| 3 | Per-user abuse/secondary | `403 rate limit exceeded` | ❌ **reports full quota** |

Plane 3 also produced a `403` on the Copilot session-creation endpoint under sustained agent
dispatch, so it is not specific to repository writes. It recurs under ordinary, low-volume
interactive use as well as under burst, and one recurrence persisted through a 45 s wall-clock backoff
and retry — so it is not solely a burst-ceiling effect, and its cooldown is neither documented nor
observable ("there is not a way to check the status of your secondary rate limit").

**Why this matters more than it looks.** Octokit's `plugin-throttling` and `plugin-retry` model
plane 1. Planes 2 and 3 are outside that model, and plane 3 is actively misleading: a client that
consults `/rate_limit` to decide whether it may proceed will conclude it has full budget and keep
hammering a closed door. A `403` arriving at dispatch time is trivially misread as *"this Work Item
failed"* — which triggers retry, then escalation, then replanning, all against a platform that is
merely asking the client to wait. GitHub's own documentation is explicit about the stakes:

> Continuing to make requests while you are rate limited may result in the banning of your
> integration.

The documented secondary-limit triggers, any one of which is sufficient:

| Trigger | Documented threshold |
|---|---|
| Concurrent requests | > 100, shared across REST + GraphQL |
| Points per minute, single endpoint | > 900 (REST) / > 2,000 (GraphQL); GET/query = 1pt, mutation = 5pts |
| CPU time | > 90s CPU per 60s real time (≤ 60s of which may be GraphQL) |
| Content-creating requests | > 80/minute or > 500/hour (issues, comments, pull requests, assignments) |
| OAuth token requests | > 2,000/hour |

A 26-issue burst in ~35 s sits directly on the concurrent-request and content-creation triggers. This
is a consequence of wave shape, not a platform anomaly.

## Finding 5 — the agent *does* publish an outcome signal, on the pull request timeline

Finding 1 concluded that outcome must be read from the pull request rather than the run conclusion.
That is right, but it is not the whole picture: GitHub also publishes the agent's own verdict as
timeline events on the pull request, which Factory did not read for its first eight gates.

| REST timeline event | Meaning |
|---|---|
| `copilot_work_started` | A session began |
| `copilot_work_finished` | It completed |
| `copilot_work_finished_failure` | It stopped on an error |

These were originally available as the GraphQL types `CopilotWorkStartedEvent`,
`CopilotWorkFinishedEvent`, and `CopilotWorkFinishedFailureEvent`. A September 2026 live-schema
check found that GitHub had removed all three types and their corresponding
`PullRequestTimelineItemsItemType` enum values from the public GraphQL schema, although the REST issue
timeline continued to return the events. Factory therefore reads this one portion of the snapshot
through REST; leaving the old fragments in the query causes GitHub to reject the entire Objective
read during validation, even when the Objective has no Work Items.

The failure variant carries a failure message (historically `failureMessage` in GraphQL; represented
as `failure_message` by REST) and a session URL. Measured on Gate 8, where two
consecutive attempts on one Work Item produced a valid pull request with a single `Initial plan`
commit and an empty diff:

| Attempt | Started | Failed | `failureMessage` |
|---|---|---|---|
| 1 (PR #7) | 03:14:44Z | 03:15:24Z | `You have exceeded your monthly quota (Request ID: ...)` |
| 2 (PR #8) | 03:29:24Z | 03:30:13Z | `You've reached your additional usage limit for your plan. Go to https://github.com/settings/copilot/features ... (Request ID: ...)` |

Two things follow, and the second is the expensive one.

**The empty pull request was not the agent's doing.** GitHub opens the pull request and pushes
`Initial plan` *before* the first model call, so a denial at the quota gate leaves exactly the
artifact Finding 1 describes as a considered no-op — same shape, entirely different cause. The
`[WIP]`-plus-empty-diff heuristic cannot tell them apart. The timeline can.

**Reading liveness from proxies costs real time.** Without these events, an attempt's death is
only inferable from an absent diff or a stale head commit, and each proxy needs a grace window to
interpret — a window that is, by construction, waiting to answer a question GitHub has already
answered.

| Attempt | Agent reported failure | Factory closed the pull request | Waited |
|---|---|---|---|
| 1 (PR #7) | 03:15:24Z | 03:29:13Z | 13m49s |
| 2 (PR #8) | 03:30:13Z | 03:43:14Z | 13m01s |

The Work Item ran 33m26s from its first dispatch to its merge. **27m50s of that — 80% — was spent
waiting on a question already answered.**

**Some failures no retry can fix.** A quota is not a property of the Work Item, so the attempt
budget — which exists to absorb the variance of a confused session — has nothing to absorb. Three
attempts would fail identically and then escalate citing "no usable result", pointing a human at a
brief that was never read instead of at the billing page GitHub named in the message.

That is not hypothetical. The two close comments Factory actually wrote were:

> Closing: The coding agent's session ended without producing any changes: PR #7 remained titled
> `[WIP] ...` with 0 changed files and only the initial-plan commit

> Closing: Second consecutive attempt produced no work: PR #8 stayed at 0 changed files ...

Both are accurate descriptions of the symptom and both imply the agent was at fault, on pull
requests where GitHub had already recorded the real cause and the URL to fix it. A human reading
either one would go and inspect a brief that was never read.

**Consequence:** read the timeline events, treat a failure with no later `started` and no later
commit as immediately failed, and escalate a non-retryable cause on the first attempt rather than
the third, quoting GitHub's message verbatim so the request ID and settings URL survive.

Two cautions found while implementing this:

- **"Latest event wins" is unsafe as a completion rule.** Two merged pull requests each show a
  `copilot_work_started` *after* their `copilot_work_finished`, minutes post-merge. Completion is
  still read from the `[WIP]` rename; these events are used only to detect that the current session
  has *died*.
- **Escalating a quota failure immediately is a deliberate trade, not a free win.** In Gate 8 the
  limit was raised while attempt 2 was in flight, so attempt 3 succeeded on its own. An immediate
  escalation would have been early in hindsight. It is still the right default: the run recovered
  because a human topped up the quota, which is precisely the action an escalation would have
  prompted — Factory simply was not the one to tell them.

## Design requirements this imposes

- **Confirm dispatch; never assume it.** Assignment success ≠ session started. Verify a session
  exists and re-dispatch when it does not.
- **Treat `[WIP]` + empty diff as a failed attempt** to retry, not a result to evaluate.
- **Prefer the agent's own timeline events to any proxy for liveness**, and never let a grace window
  outlive a question GitHub has already answered.
- **Separate "this attempt failed" from "no attempt can succeed."** A stated cause outside the Work
  Item's control must not consume the attempt budget, and must reach a human in GitHub's own words.
- **Make retry idempotent.** Transient infrastructure failure is normal at burst.
- **Budget ~85% first-pass success**; design retry as routine.
- **Throttle both dispatch and polling.** Both directions rate-limit.
- **Separate platform refusal from work failure.** `403`/`429`/`5xx` are substrate conditions; they
  must never consume an attempt or reach the replanner.
- **Do not trust `/rate_limit` as a gate.** It reports full quota while refusing every call. Back off
  on wall-clock time and treat a successful request as the only clear signal.
- **Pace well under the documented secondary limits, not up to them** (`src/platform.ts`,
  `FACTORY_PACING`): cap concurrent in-flight calls to a handful, cap content-creating calls to
  roughly half the documented allowance, and enforce a minimum 1 s gap between mutative calls.
- **Trip a wave-level circuit breaker on repeated refusals**, not just a per-call retry
  (`src/platform.ts`, `CircuitBreaker`): after a small number of consecutive refusals, pause *all*
  dispatch for a cooldown measured in minutes, growing on repeated trips, and surface for a human
  decision once the breaker has tripped repeatedly.

## Verdict

Cloud-hosted Copilot agent sessions are a viable execution substrate: parallel to at least 24, fast,
correct, honest about non-actionability, and non-self-merging.

The caveat is that the substrate is lossy under burst, so the loop needs exactly three things:
**dispatch confirmation, no-op detection, and idempotent retry** — a small, well-understood
supervisor, not a permit protocol, a serialization fence, or a terminal router.
