# Clockgrove Factory — Implementation Plan

Peer document to [`PRD.md`](PRD.md). The PRD says *what and why*; this says *how*.

Status: draft for review
Date: 2026-08-30
Depends on: PRD (accepted), [`PROBE-001`](PROBE-001-agent-parallelism.md)

---

## 1. The governing idea: derived state

**Factory stores nothing. All work state is a pure function of GitHub state.**

This single decision is what removes the entire class of machinery that consumed the prior effort.
If state is
never stored, it can never be stale, never diverge, never need reconciliation, and never need a
permit protocol to protect it. There is nothing to recover because there is nothing to lose.

It also gives crash recovery for free: a fresh Director session on a different machine reads GitHub
and knows everything. "Resume" and "start" are the same code path — which means the recovery path is
exercised on every single run, not just after a failure.

The corollary is a hard rule:

> **If a decision cannot be derived from GitHub, Factory does not get to make it.**

Any temptation to persist a flag, a receipt, a session ID, or an attempt counter is Inversion A
returning. Attempt counts are derived (§4.4), not recorded.

---

## 2. Component map

```
plugin/
├── agents/director.md            the loop; runs in the harness
├── skills/                       management reasoning, invoked by Director
│   ├── objective-compilation.md  Objective → Work Item graph
│   ├── work-packet.md            Work Item → agent prompt
│   ├── outcome-evaluation.md     did the PR actually do the work?
│   └── replanning.md             repeated failure → graph change
├── schemas/                      validation contracts
│   ├── work-item.schema.json
│   └── objective.schema.json
└── factory/                      deterministic TypeScript; no judgment
    ├── types.ts                  shared shapes (§3.1)
    ├── github.ts                 read-only GraphQL client → snapshot (§2)
    ├── state.ts                  GitHub → derived state (§3)
    ├── platform.ts               refusal vs. work-failure, pacing (Finding 4)
    ├── graph.ts                  apply Work Item graph to Issues
    ├── dispatch.ts               assign + confirm + retry (§4)
    └── evaluate.ts               mechanical PR checks (§5)
```

**The split between code and reasoning is load-bearing:**

| Concern | Owner | Why |
|---|---|---|
| Reading GitHub, deriving state | code | mechanical, must be exact and cheap |
| Compiling Objective → Work Items | **skill** | judgment; the core product |
| Applying the graph to Issues | code | mechanical |
| Choosing what to dispatch | code | pure function of readiness (§3.2) |
| Writing the agent prompt | **skill** | judgment |
| Detecting a no-op / failed attempt | code | mechanical, from PROBE-001 |
| Judging whether work is *correct* | **skill** | judgment |
| Deciding to replan | **skill** | judgment |

The prior design wrote code for the judgment and accreted judgment into the code. Keeping this
boundary sharp is the main defense against that.

---

## 3. State model

### 3.1 Encoding

Everything uses GitHub-native primitives. No custom fields, no state labels, no sidecar files.

| Concept | GitHub primitive |
|---|---|
| Objective | Issue, labelled `factory:objective` |
| Work Item | Issue, **sub-issue** of the Objective |
| Dependency | native issue **`blocked by`** relationship |
| Assignment | `copilot-swe-agent` as assignee |
| Attempt | a linked PR (`closingIssuesReferences`) |
| Completion | PR merged → issue closed |

Only two labels exist: `factory:objective` and `factory:work-item`. Resist adding more — a status
label is stored state wearing a disguise.

### 3.2 Derived states

`state.ts` computes each Work Item's state per cycle. Pure function, no writes:

```
unstarted     open, no Copilot assignee, no linked PR
dispatched    Copilot assigned, no session and no PR yet
in_flight     session running, or draft PR with real commits
failed        session concluded failure, OR PR is a no-op (§5.1)
for_review    PR has a real diff and checks have settled
blocked       open, but some `blocked by` issue is still open
escalated     open, assigned to a human, Copilot not assigned (§7.2)
done          linked PR merged and issue closed
```

**Ready** = `unstarted` AND every `blocked by` issue is closed AND not `escalated`.

Note what is absent: no "claimed", no "leased", no "owned by run 12345". A Work Item's state is
whatever GitHub currently says it is, and two Directors reading simultaneously derive the same
answer.

---

## 4. The loop

Runs in the harness, holding continuous context. One cycle:

```ts
while (true) {
  const s = derive(await reader.readObjective(objective));   // one snapshot per cycle

  if (allDone(s)) { await closeObjective(s); break; }

  for (const wi of ready(s).slice(0, CONCURRENCY)) {         // 4.1
    await dispatch.start(wi);
  }

  await dispatch.confirm(inState(s, "dispatched"));          // 4.2 — required by PROBE-001

  for (const wi of inState(s, "failed")) {
    await dispatch.retryOrEscalate(wi);                      // 4.4
  }

  for (const wi of inState(s, "for_review")) {
    await integrate(wi);                                     // §6
  }

  if (isStalled(s)) await replan(s);                         // §7

  await sleep(POLL_INTERVAL);
}
```

### 4.1 Concurrency and pacing

From PROBE-001: 24 concurrent sessions ran with no queueing ceiling, but first-pass success at burst
was 85% and *my own polling triggered a 429*.

- `CONCURRENCY = 8` initially. Well inside measured limits, and Gate 2 only needs 8–10.
- Stagger dispatch ~1 s apart. The 26-issue burst went out in 35 s and lost two.
- `POLL_INTERVAL = 30 s`, one snapshot per cycle, shared by every check.
- Back off on 429 or 5xx.

These are dials with measured origins, not guesses — and each should be re-measured before being
raised.

### 4.2 Dispatch confirmation

**PROBE-001's most important operational finding: 2 of 26 assignments were accepted and never
produced a session.** Assignment success does not mean work started.

```
assign(issue)
wait up to 90s for: a workflow run OR a linked PR
if neither appears:
    unassign; reassign          # idempotent — no PR was created
    on second failure: mark for escalation
```

90 s is chosen against measured latency: assignment → draft PR was 3–7 s, assignment → terminal
~75–80 s. A missing session at 90 s is a real loss, not slowness.

This is the *only* reconciliation Factory performs, it is bounded, and it exists because a measured
platform behavior demands it — not because a design pattern suggested it.

**"On second failure" is derived, not counted.** The obvious implementation stores a retry counter —
but that is exactly the sidecar state §1 forbids, and an in-process counter would not survive a
restart honestly either. Instead, `state.ts`'s `confirmFailureStreak` walks the issue's own
`AssignedEvent` timeline (already fetched for the confirm-window check) and counts trailing
assignment windows that produced zero linked PRs, stopping at the first one that did. Every
unassign/reassign leaves a fresh `AssignedEvent`, so the timeline already encodes the retry history;
this reads it rather than duplicating it. A Dispatcher restart mid-retry loses nothing — the next
cycle recomputes the same streak from the same GitHub history and reaches the same decision.

### 4.3 Idempotency

Dispatch is keyed on the issue and guarded by GitHub state: an issue with a linked PR is never
re-dispatched. Re-running the loop after a crash cannot duplicate work, because the PR that already
exists is itself the record that the work started.

### 4.4 Attempts, derived

Attempt count = **number of linked PRs**. No counter is stored.

- attempts ≥ 3 → stop retrying, escalate to replanning (§7)
- a failed attempt's PR is closed before retry, so counting stays honest

---

## 5. Evaluation

PROBE-001's headline finding: **`conclusion: success` does not mean the work was done.** An
impossible task returned success. Evaluation must read the pull request.

### 5.1 Mechanical checks (`evaluate.ts`)

Cheap, deterministic, run first:

```
no-op        empty diff, OR no commit beyond "Initial plan"
declined     PR body states the task is not actionable
untouched    diff does not touch any file the Work Item names
checks       required checks concluded
conflict     PR not mergeable against base
```

A no-op or a decline is a **failed attempt**, not a result. Critically, `[WIP]` titles are *not* a
signal — PROBE-001 saw `[WIP]` on both genuine work and empty failures.

### 5.2 Semantic check (skill)

Only if mechanical checks pass. Director reads the diff and answers: does this satisfy the Work
Item's acceptance criteria, and nothing more?

Cheap checks gate expensive ones, so most failures never reach a model.

### 5.3 The decline path is a feature

PROBE-001 showed the agent refusing an impossible task, explaining why in the PR body, and declining
to invent a missing file. That honesty is what makes unattended operation safe, and it is why
preconditions belong in the Work Packet (§8): a well-specified Work Item lets the agent tell us the
plan is wrong. Frequent declines are a **compiler defect**, not an execution defect.

---

## 6. Integration

Factory merges; agents do not. PROBE-001 confirmed sessions never self-merge — PRs stay draft and
issues stay open, which hands the loop a free decision point.

```
mark ready → checks green → squash merge → issue auto-closes
```

Conflicts are the loop's problem (PROBE-001, finding 3: parallel PRs branch from the same base and
only collide at the second merge):

- attempt rebase; if clean, proceed
- if not, close the PR and re-dispatch against the new base
- repeated conflict on one file ⇒ the graph wrongly modelled two items as independent ⇒ replan

That third bullet is a **termination condition, not advice.** Re-dispatch on conflict is bounded by
the same derived attempt count as every other retry (§4.4): a rebase that cannot fix a conflict
means the next attempt branches from the same base and conflicts identically, so an unbounded
conflict path spins forever, spending one coding-agent run and one pull request per cycle and never
reaching a human. When attempts are exhausted the Work Item escalates with the *graph* diagnosis
rather than the usual "the agent failed" one — the fix is an added dependency edge or a merged pair
of items, which only replanning can supply. A successful rebase deliberately consumes no attempt,
since it opens no new pull request and therefore cannot be the thing that spins.

Merging one at a time per cycle keeps conflicts rare without a serialization protocol.

---

## 7. Replanning and escalation

Triggers: attempts exhausted (§4.4), repeated declines, or repeated conflicts.

Replanning **edits the graph** — split a Work Item, add a missing dependency, correct acceptance
criteria — and is the one place Factory changes its own plan. Per F4, a wave is a *workstream of
multiple Objectives*; Work Item identity is stable and titles are never rewritten to encode status.
Title drift was the root cause of the prior design's replan deadlock.

### 7.1 Escalation is a first-class outcome

**Unattended operation is a goal, not a mandate.** Some decisions legitimately require a human, and
a system that cannot say so will invent a way to keep going.

This is not a concession — it is a structural fix. The prior design had no legitimate "stop and
ask" state, so every problem had to be solved by more machinery; a circuit breaker had to be added
*by a human*, from outside, after the loop had already been spinning for days. A loop that can stop
does not need to be stopped.

Escalating is therefore a **successful outcome** of a cycle, not a failure of one. The metric that
matters is whether escalations are *well-founded*, not whether they are rare. Suppressing a needed
escalation is a defect; raising a clear one is the system working.

### 7.2 How escalation is represented

Derived state, like everything else (§1). No new label, no stored flag:

```
unassign copilot-swe-agent
assign the human owner
comment: what was attempted, what failed, the evidence, the specific question
```

`escalated` = open, assigned to a human, Copilot not assigned. Director does not re-dispatch an
issue assigned to a human. Reassigning Copilot is the human's "carry on" signal — an ordinary
GitHub gesture, not a Factory protocol.

### 7.3 The confidence bar

Director acts autonomously — including merging — only when **all** of these hold:

- mechanical checks pass (§5.1): real diff, declared scope respected, checks green, mergeable
- semantic review passes (§5.2): the diff satisfies the acceptance criteria and nothing more
- the change is **reversible**: one squash commit on a branch, revertible without coordination
- no security-sensitive surface: auth, secrets, permissions, CI configuration, dependency sources

Director **stops and asks** when **any** of these hold:

- intent is ambiguous, or acceptance criteria are open to more than one honest reading
- the diff touches workflows, permissions, secrets, or release configuration
- existing behavior not named in the Work Item is deleted or rewritten
- a conflict needs a judgment about intent rather than a mechanical rebase
- attempts are exhausted and no graph change looks likely to succeed
- the action is irreversible: force push, history rewrite, repository or settings mutation, release,
  or anything outside the target repository

The asymmetry is deliberate. Merging a reviewed, reversible, in-scope change is cheap to undo.
Guessing at intent is not.

---

## 8. Work Packet → prompt

Per PRD §6, F1 is accepted: Agent Tasks takes only a prompt, so the Work Packet **is** the prompt.

Compiled from the Work Item:

```
Goal              one sentence
Acceptance        explicit, checkable criteria
Scope             files that may be modified
Preconditions     what must already be true  ← enables the decline path
Out of scope      explicit non-goals
Conventions       repo-specific constraints
```

PROBE-001 evidence: agents given a one-line scope constraint touched only the named file, 11/11
times. Precision in the prompt is what replaces per-session tool allowlists.

---

## 9. Build order

Each step ends in something runnable. No step is "framework".

| # | Deliverable | Proves |
|---|---|---|
| 1 | `github.ts` + `state.ts` | derive full state of a hand-made Objective |
| 2 | `dispatch.ts` | assign, confirm, retry against a real repo |
| 3 | `evaluate.ts` | correctly classify a known no-op |
| 4 | integration | merge a PR and close its issue |
| 5 | `objective-compilation` skill + schema | Objective → validated Work Item graph |
| 6 | `graph.ts` | apply graph as sub-issues + dependencies |
| 7 | `director.md` | assemble the loop → **Gate 0** |

Steps 1–4 use a hand-written Work Item graph, so execution is proven before compilation is written.
That ordering is deliberate: the prior design built compilation first and never proved execution.

---

## 10. Gate 0

**Setup.** Disposable repo. One Objective: *"Add three pure utility functions with tests"* → three
independent Work Items.

**Run.** Author the Objective. Start Director. Do not intervene.

**Pass.** Three merged PRs, three closed Work Items, Objective closed, no human action after start.

**Budget.** 3 attempts or 4 hours active execution. On failure: **stop and revise the architecture**
(PRD §7). Do not harden forward.

**Instrumentation.** Log every cycle's derived state, dispatch, and decision. When Gate 0 fails, the
question "what did Director believe and why" must be answerable from the log alone.

### 10.1 Rehearsal repo setup checklist (applies to every gate, not just Gate 0)

Gate 1's setup hit a real, if mundane, failure mode: a freshly seeded disposable repo with no
`.gitignore` let the coding agent's `npm install` commit all of `node_modules` (800+ files) into a
Work Item's PR. This is not a Director/state-machine defect — Director evaluated and merged it
correctly once cleaned up — it is an operator setup gap that a checklist prevents cheaply. Before
authoring any Objective against a freshly seeded rehearsal repo:

- Seed a `.gitignore` (at minimum `node_modules/`, `dist/`, `*.log`) in the same commit as
  `package.json`/`tsconfig.json` — never in a follow-up.
- If a Work Item's PR shows up with hundreds of unexpected changed files, check for exactly this
  before treating it as a Director finding.
- **Ship a CI workflow that runs the tests and the typecheck on `pull_request`.** Without one,
  GitHub reports no check runs, `evaluate_mechanical`'s `checks_pending`/`checks_failed` branches
  can never fire, and a `ready` verdict silently narrows to "open, touches the expected files,
  mergeable" — nothing has actually executed the code. Gate 2 ran all 10 Work Items this way (see
  §10.3, F2). A rehearsal without CI leaves a whole branch of the evaluate layer untested, and
  makes the mechanical verdict weaker than it reads.
- **Leave "Require approval for workflow runs" alone — Factory now handles it (§10.6).** Shipping
  the workflow is not sufficient on its own: GitHub requires a maintainer to click "Approve and run
  workflows" on a pull request authored by the coding agent, so by default every `pull_request` run
  is created and then *waits*, executing nothing, while the identical workflow succeeds on `push` to
  `main` — which makes the problem look repo-specific rather than structural. Gate 3 shipped CI,
  satisfied the bullet above, and still never ran a single job (§10.5, F1). The earlier version of
  this bullet told operators to disable the setting; that was a fixture workaround for a Factory bug,
  and it traded a real security control for a green rehearsal. `approve_held_workflow_runs` now makes
  the approval decision behind a blast-radius review, so the setting can stay on. Still verify by
  opening the first PR of a rehearsal and confirming its checks actually execute before compiling the
  rest of the graph.

**A Director session must keep its automation interval short enough that its own message queue
never meaningfully backs up**, and must not proactively report on every healthy cycle — both fixed
directly in `skills/director/SKILL.md` (the cadence guidance in step 8, and the new "Reporting
discipline" section) so every future invocation inherits them regardless of kickoff wording.

**Whoever is monitoring a running Director session (human or another agent) must stay steerable and
process its own inbox too — this is not just a Director-side requirement.** Gate 1's actual backlog
(a dozen-plus messages, visible in the app under the *monitoring* session, not the Director session)
came from the parent/monitoring session chaining long, uninterrupted sequences of its own tool calls
(repo edits, `gh` checks, commits) without ending a turn to let the Director's incoming reports be
delivered and read — and then re-deriving the same status via direct `gh` polling instead of reading
what had already arrived. Fixed directly in this repo's `AGENTS.md` ("Staying steerable while
orchestrating a child session"), since that is what shapes the orchestrating agent's own behavior,
not a Factory skill. Nothing was lost or corrupted either way — every tool here is
idempotent/no-op-safe against a terminal state — but both sides need short, single-purpose turns
that yield control back often, so messages in either direction get processed close to when they
arrive rather than queuing.

**The skills a running Director actually loads are not automatically the ones in this repo — verify
they are in sync before every rehearsal.** Caught at the start of Gate 2: `~/.copilot/skills/director/SKILL.md`
was 3,169 characters shorter than this repo's committed copy, missing *both* Gate 1 fixes (the
"Reporting discipline" section and the settled test-path guidance). `~/.copilot/installed-plugins/`
was empty, and `~/.copilot/mcp-config.json` points the `factory` MCP server at a built artifact — so
the skill files are hand-copied to `~/.copilot/skills/`, and a committed-and-pushed fix to
`skills/**/SKILL.md` in this repo has **no effect on the next rehearsal** until it is copied across.
Gate 1's own fix would have silently not applied. Before authoring a rehearsal Objective, diff
`skills/*/SKILL.md` against `~/.copilot/skills/*/SKILL.md` and copy any drift over.

This is a **finding against §9/§15's packaging claim**, not just an operator slip: the rehearsals to
date have exercised hand-synced skill copies, not the real plugin-install path an unrelated adopter
would get. Gate 3 (or shipping) needs the install path itself exercised end-to-end — installing from
an exact Git ref and confirming Director loads *those* skills — otherwise "installable from an exact
Git ref by an unrelated adopter" is untested.

### 10.2 Gate 2 result (scale, capacity, contention)

Ran against `clockgrove/factory-gate2`, Objective #1, compiled to a deliberate diamond: six
independent Layer 1 primitives → three Layer 2 combinators (each depending on exactly two Layer 1
items) → one Layer 3 assembly depending on all three Layer 2 items. Ten Work Items, ten merged PRs,
Objective closed `COMPLETED` in ~22 minutes, unattended.

What the gate actually established, beyond "it closed":

- **Capacity held at a six-wide burst.** Six Work Items dispatched concurrently, six PRs open at
  once, no `platformExhausted` and no secondary rate limit. The `ContentCreationPacer` /
  `CircuitBreaker` path in `platform.ts` was exercised at real burst width for the first time.
- **Contention never materialised — by construction, not by recovery.** Six PRs branched from the
  same base and all merged without a conflict, because the compiler's non-overlapping-`scope`
  invariant (objective-compilation §5 self-check) meant no two items could touch the same file. This
  is the intended mitigation for PROBE-001 finding 3, and it is worth being explicit that the gate
  therefore did **not** exercise the conflict/rebase path. Deliberately inducing a conflict remains
  untested and should be covered before relying on it in anger.
- **Two-hop fan-in sequenced correctly.** Each Layer 2 item stayed `blocked` until *both* upstreams
  closed; Layer 3 until all three did. No premature dispatch at either hop.
- **`dependsOn` produced composable work, not just ordered work.** Verified by reading the merged
  source directly: every combinator imports its declared upstreams rather than reimplementing them.
  This is the property that actually distinguishes a dependency graph from a schedule, and it had not
  been checked at Gate 1.
- **Verified independently of Director's own reporting.** The merged result was cloned and run:
  41 tests across 10 files pass, `tsc --noEmit` clean, and all 10 test files are *discovered* by
  vitest — i.e. the path constraint was satisfied functionally, not merely string-matched.

**The acceptance-phrasing fix is now measured.** Gate 2's repo deliberately made the test path
load-bearing (`vitest.config.ts` includes only `test/**`, so a colocated test silently never runs).
Gate 1's descriptive phrasing produced 0/3 correct placements; Gate 2's hard `REQUIRED:` phrasing plus
an `outOfScope` restatement carrying the *reason* produced 10/10. Captured in
`skills/objective-compilation/SKILL.md`. The general lesson — state the constraint, its exact expected
value, and why it matters, rather than describing the desired end state — is the compiler's job, not
something Director's judgment layer should have to absorb per-cycle.

### 10.3 Gate 2's findings against Factory's own tool surface

Gate 2 passed on the criteria it was designed to test, but the Director driving it reported five
defects in the surface it was driving. They are recorded here because four of them were invisible
at Gates 0 and 1 — they only appear at scale, which is what Gate 2 was for. All are now addressed.

- **F1 — Director could not read a diff through Factory's own tools.** `read_objective` exposed
  `changedFilePaths`, `changedLines` and `commitSubjects`, but no patch content, while the director
  skill mandated checking the diff against §7.3's bar. That step was **not performable on Factory's
  surface**, so the semantic half of the confidence bar was unmet *by construction, not by choice*.
  It bit concretely: this Objective required combinators to "import and actually use the named
  functions, not reimplement their logic" — a criterion invisible in file paths, since both the
  correct and incorrect implementation touch the same file. Four Work Items merged with it
  unverified, on file-path, size and reversibility evidence alone. The PR bodies asserted
  compliance, but §15.7 forbids treating an agent's self-report as evidence.

  *Fixed* by a ninth tool, `read_pull_request_diff`, returning per-file patch text with
  `additions`/`deletions`/`status`. It uses the REST files endpoint rather than the `.diff` media
  type precisely because the bar reasons about per-file counts, not one flat patch. A total
  `maxPatchBytes` budget keeps it compatible with F3's constraint, and any file whose patch is
  shortened or withheld says so via `patchOmitted`, with `truncated` set — a partial read must
  never be mistaken for a clean one. The budgeting rules are a pure function (`budgetPatches`) so
  they are tested without the network.

- **F2 — with no CI in the target repo, `checks` is always `null`.** `checks_pending`/`checks_failed`
  never fired on any of the 10 PRs, so nothing independently confirmed the tests passed, or even
  that vitest discovered them. Combined with F1, a mechanical `ready` verdict meant only "open,
  touches the expected files, mergeable" — considerably weaker than the word `ready` suggests.
  *Addressed* in two places: §10.1's checklist now requires rehearsal repos to ship a workflow, and
  the director skill now states plainly that where `checks` is `null`, "the tests pass" is an
  assumption rather than an observation, and must be reported as one.

- **F3 — `read_objective` did not scale with graph size.** It inlines every linked PR's full body,
  and the coding agent quotes the entire Work Item issue back into that body. At ten items the
  response reached 20.6 KB and **exceeded the tool output limit outright**; Director had to spill it
  to a file and extract fields with `jq`. Since Director re-reads every cycle, per-cycle context
  cost grew with both Objective size and agent verbosity. *Fixed* with a `minimal` flag that drops
  only prose no derivation reads — each PR body and the Objective body, each replaced by a
  `bodyLength`. `changedFilePaths` is deliberately **kept**: it is a handful of short strings and is
  the primary evidence the bar reasons about, so dropping it to save bytes would defeat the read.

- **F4 — `escalateTo` was not validated until first use.** Director passed `kirkmarple`, taken from
  the session's branch prefix; the real login is `kirkmarple-clockgrove`. It happened to fail on the
  first `dispatch_start`, before any state change, so it was harmless — but the same typo on an
  *escalation* path would have thrown at the exact moment a human was needed. A branch prefix that
  looks like a login is a false friend. *Fixed* by accepting an optional `escalateTo` on
  `read_objective` and resolving it eagerly, so a bad login fails loudly on cycle one while nothing
  is at stake; the resolver's error now also says what the login is not.

- **F5 — `mergeable` reads `UNKNOWN` on merged PRs.** Cosmetic: GitHub stops computing mergeability
  once a PR closes. *Addressed* as a documented edge case — never gate on `mergeable` post-merge.

**The pattern worth keeping.** F1 and F3 are both cases where the tool surface was shaped by what
was easy to query rather than by what the judgment layer actually needed, and neither was
detectable at three Work Items. A skill instruction that cannot be carried out on the available
surface does not degrade loudly — it degrades into the agent quietly substituting weaker evidence
and merging anyway. That is the failure mode to watch for in later gates: not a tool that errors,
but an instruction that silently has no way to be followed.

**Two of these fixes were themselves wrong, and only live testing found it.** After the F1–F5 work
typechecked and passed 130 unit tests, an end-to-end run against `clockgrove/factory-gate2` through
the real MCP stdio server (22 checks) exposed two defects in the fixes:

- **F4's improved error message was dead code.** GitHub does not return `user: null` for an unknown
  login — it fails the entire GraphQL request with a NOT_FOUND error — so the null branch carrying
  the guidance was never reached, and the caller saw only GitHub's raw error. Exactly the class of
  assumption AGENTS.md's "verify live, never assume a schema from training data" rule exists to
  catch, and a unit test with a mocked client would have happily confirmed the wrong behavior. Now
  caught and re-thrown with the guidance, GitHub's own message appended.
- **F3's fix left 40% of the win on the table.** Measuring the trimmed payload showed 5.4 KB of the
  remaining 13.3 KB was pretty-print indentation — 41% of a response that had just been shrunk for
  size. `textResult` now drops indentation above a threshold, which is a *general* size guard
  benefiting every tool rather than just `read_objective`. Net effect on Gate 2's Objective:
  minimal 13.3 KB → **7.7 KB**, and the full read 25.9 KB → **20.5 KB**, i.e. the unflagged read
  that originally blew the limit now fits under it.

The wider lesson is that the semantic-verification gap F1 describes applies to this repo's own
work too: typechecking and unit tests confirmed the code did what it said, and neither could tell
that what it said was based on a wrong belief about the platform. Only exercising it against the
real API could.

### 10.4 Gate 3 fixture (`clockgrove/factory-gate3`) — designed, not yet run

**Deviation to note up front:** PRD §8 defines Gate 3 as *one real Clockgrove Objective*. This
fixture is synthetic. It is a dress rehearsal for that gate, not the gate itself — the PRD's bar is
unchanged, and Gate 3 is not green until a real Clockgrove Objective closes.

The fixture exists because Gates 0–2 shared a property that production work does not have: **every
Work Item was purely additive**. All 10 of Gate 2's PRs added two brand-new files and touched
nothing existing. That makes several real risks structurally impossible, so the loop has never been
tested against them. `factory-gate3` seeds a small but genuine library (`appconfig`: `parse`,
`merge`, `validate`, a barrel, 11 passing tests, green CI) whose README documents three deliberate
design defects, and Objective #1 asks for those defects to be fixed.

What this fixture exercises that no previous gate did:

- **Modifying existing code and existing tests.** Each Work Item changes behavior that current
  tests assert, so the agent must update those tests rather than only adding new ones — and must
  not quietly delete an inconvenient assertion. Nothing in Gates 0–2 could catch that.
- **The conflict/rebase path (§6), still untested after Gate 2.** Gate 2 saw zero conflicts because
  the compiler's non-overlapping-`scope` invariant made them impossible. Here the barrel
  `src/index.ts` is genuinely shared: at least three Work Items must add exports to it. The
  invariant and the Objective are in direct tension, which is the point — either the compiler
  serializes that work with edges (correct, and worth confirming it notices), or concurrent items
  collide and §6's rebase path finally runs. Both outcomes are informative; silently producing
  overlapping scopes with no edge would be a compiler defect.
- **CI that actually reports.** Per §10.1 the repo ships a workflow running `npm test` and
  `npm run typecheck` on every PR, so `checks_pending`/`checks_failed` can fire for the first time
  (§10.3, F2). Strict compiler options plus a "do not relax `tsconfig.json`" constraint give the
  agent a tempting shortcut that CI will catch.
- **Semantic criteria that need `read_pull_request_diff`.** `loadConfig` "must be built out of the
  three functions above — not a fourth reimplementation" is invisible in `changedFilePaths`. This is
  the same criterion Gate 2 merged unverified four times (F1); now it is checkable, so the fixture
  also tests whether Director actually performs the read now that it can.
- **Constraints stated as prose, not as a compiled scope.** The Objective is written as a product
  owner would write it, including negative constraints ("do not add runtime dependencies", "do not
  change the input format"). Compiling that into Work Packets with honest `outOfScope` entries is
  itself the test of `objective-compilation` against realistic input.

---

### 10.5 Gate 3 result (brownfield) and its one serious finding

Ran against `clockgrove/factory-gate3`, Objective #1, ~12 minutes end to end. All four Work Items
closed, all four PRs merged, `platformExhausted` never true, no unresolved escalation. The things the
fixture was built to test mostly worked:

- **The diff read did real work.** `read_pull_request_diff` confirmed `loadConfig` genuinely imports
  and calls `parse`/`merge`/`validate` rather than reimplementing them — the exact criterion Gate 2
  merged unverified four times, and one that is invisible in `changedFilePaths`. `truncated` was
  false on all four reads. F1 from §10.3 is closed by evidence, not by assertion.
- **Existing behavior was amended, not deleted.** Every item rewrote the existing test to the new
  behavior instead of weakening or removing it, and nothing relaxed `tsconfig.json`. The brownfield
  temptations the fixture was designed to bait did not materialize.
- **The base-moved path fired and self-healed.** `dispatch_integrate` on #2 threw "Base branch was
  modified" after two siblings merged; the next read showed the PR back at `for_review` and
  `MERGEABLE`, and a retry merged it cleanly. §6's recovery path is real.
- **The shared-file conflict path was avoided again, not exercised.** Director funnelled every
  `src/index.ts` edit into the one dependent item and forbade the other three from touching it. That
  is the correct engineering choice and it follows from the compiler's non-overlapping-`scope`
  invariant — which is precisely why no gate has yet reproduced §6's content-conflict path. Doing so
  requires deliberately compiling two concurrent items onto one file, against the invariant.

**F1 — CI never ran, and Factory could not tell that apart from a repository with no CI.** The
serious one. All four PRs merged with `checks: null` despite the fixture shipping a real workflow.
The Director's own explanation (the PRs were drafts) was wrong — they were not drafts at merge — so
the cause was chased down against the live API afterwards, and it is worse than reported:

1. GitHub requires a maintainer to click **"Approve and run workflows"** on a pull request authored
   by the coding agent (verified against docs.github.com, 2026-09-02; the toggle is Settings →
   Copilot → Coding agent). Unapproved, every `pull_request` run was created and then concluded
   `failure` having executed nothing. Every `push`-to-`main` run on the identical workflow succeeded,
   which is what made the failure look repo-specific rather than structural.
2. Those runs produced **zero jobs**, so their check suites concluded `FAILURE` with
   `latest_check_runs_count: 0`. `statusCheckRollup` is computed from check *runs*, so it stayed
   `null`.
3. `evaluateMechanical` read `null` as "no checks configured" and fell through to `ready`.

So GitHub said *CI failed*, and Factory read *this repository has no CI*, and merged. Three fixes,
all live-verified against the two rehearsal repos afterwards:

- `normalizeChecks` now consults the head commit's check **suites** when the rollup is silent. A
  suite that concluded without emitting a run reports `FAILURE`; one still in flight reports
  `PENDING`; a benign runless conclusion stays silent so ordinary repositories do not deadlock.
  Verified: gate3's four PRs flipped `null` → `FAILURE`, gate2's ten (genuinely no CI) stayed `null`.
- A new `checks_missing` verdict covers the remaining window — the repository is known to run CI on
  pull requests (`ObjectiveSnapshot.ciExpectedOnPullRequests`, one cached REST call asking whether a
  `pull_request` run has ever existed) but this PR has no checks yet. It waits rather than merging,
  and never auto-retries: a repository whose CI cannot attach checks is a human problem.
- `LinkedPullRequest.checksNeverStarted` distinguishes *CI that ran and failed* from *CI that never
  ran*, so the escalation names the approval setting instead of sending someone hunting for a
  phantom test failure.

**This makes the approval toggle a setup precondition, now in §10.1.** Without it, a repository with
CI cannot complete an Objective at all: every item would correctly stall at `checks_failed`. Gate 3
"passed" only because the bug and the misconfiguration cancelled out.

Confirmed by direct experiment rather than inference: a pull request opened on the *same* repository
against the *same* workflow, differing only in author, ran CI to `success` with jobs, while every
`Copilot`-authored one concluded `failure` with zero jobs. The workflow was never the problem. That
probe also exercised the green path for the first time in any gate — `statusCheckRollup` reported
`SUCCESS` and the rollup is preferred over the suites, so a genuinely passing PR still evaluates
`ready`.

**Open question this leaves — now answered in §10.6.** Requiring a human click makes an unattended
Objective impossible on any repository with CI and default settings, which is squarely against PRD
§1's premise. Three possible answers were on the table: make disabling the toggle a documented
install precondition; have Factory approve its own agent's runs; or accept that CI-gated repositories
always need one human gesture per Objective. **Resolved in favour of the second**, with the operator's
explicit condition that Factory perform a blast-radius review first and understand that it is causing
no data loss or bad impact. The first option was rejected as what it is — a fixture workaround that
trades a real security control for a green rehearsal. See §10.6.

**F3 — `failed` fired while the agent was still writing.** A Work Item derived `failed` during the
window where the coding agent had opened its draft PR but pushed only `Initial plan`. Following the
skill's "retry every failed item" instruction would have closed a live session's PR; the Director
happened to wait a cycle and it self-corrected. The cause was measuring an *empty pull request*
against `DISPATCH_CONFIRM_WINDOW_MS`, which answers a different question. The confirm window asks
"did dispatch take?", and its evidence is a PR appearing at all — so it is rightly 90 seconds from
assignment. Once a PR exists, dispatch demonstrably took, and the live question is "is the agent
still working?", which must be measured from the PR's own creation: agents open the draft within
seconds and then work for minutes. Fixed with `EMPTY_PULL_REQUEST_GRACE_MS` (10 minutes, from the
PR's `createdAt`), with an explicit decline exempted since that is a final answer rather than
silence. `failed` is now a settled judgment, and the skill says so.

**F2 — compilation still infers repository layout instead of reading it.** No tool exposes the target
repository's file tree, so `objective-compilation` derived `src/parse.ts` / `test/parse.test.ts` from
conventional layout alone. It was right here, but a wrong guess surfaces several steps later as an
untouched-scope failure, which is an expensive way to learn a path is wrong. Not fixed; a read-only
repo-tree/file-contents tool is the obvious answer and is deferred rather than dismissed.

### 10.6 Self-approving held workflow runs

Gate 3's F1 was reported as "the PRs were draft when I integrated, so no check had attached yet".
That diagnosis was wrong twice over, and the corrections matter more than the original finding.

**The PRs were not draft.** All four merged with `isDraft: false`. The real mechanism was that
`statusCheckRollup` is computed from check *runs*, and a check *suite* that concludes without ever
emitting a run contributes nothing — leaving the rollup `null`, byte-identical to a repository with
no CI at all. That is the bug fixed in §10.5.

**And the runs did not fail — they were held, then killed.** The check suites read
`conclusion: failure`, which invites the reading that CI ran and failed. It did not. GitHub parks
workflow runs on coding-agent pull requests in `action_required` until a maintainer clicks "Approve
and run workflows"; unapproved, a run simply waits. It only flips to `failure` when the pull request
is closed or merged, which cancels it.

The evidence is unambiguous and came from the fixture's own history: every run on a branch shares a
single `updated_at`, 1–2 seconds after that branch's `merged_at`, regardless of having been created
minutes apart.

| Branch | `merged_at` | runs' shared `updated_at` |
|---|---|---|
| `copilot/load-config-entry-point` | 06:33:22 | 06:33:23 |
| `copilot/update-validate-reporting-behavior` | 06:26:18 | 06:26:19 |
| `copilot/parse-collect-every-malformed-line` | 06:26:39 | 06:26:41 |

Four runs on `parse-collect...`, created between 06:23:41 and 06:26:40, all concluded at 06:26:41.
Runs do not fail in unison on a schedule set by an unrelated merge; they were cancelled by it.

**Why this needed a fix rather than a setting.** With §10.5 in place the honest verdict while the PR
is open is `checks_pending` — and it stays pending forever, because the checks genuinely never
arrive. The rehearsal checklist's original answer was to turn the approval requirement off. That is
a fixture workaround: it trades a real security control for a green run, and it does nothing for any
repository Factory is pointed at in anger.

So Factory makes the approval decision itself, behind a **blast-radius review** (`src/approval.ts`,
exposed as `approve_held_workflow_runs`). The review is deliberately not "is this a good change" —
running the agent's code is the entire point of CI, and a test file can `fetch()` as easily as any
other file. It asks the narrower question the maintainer's click actually asks: *does approving
escalate privilege beyond "run the tests in a sandbox holding nothing worth stealing"?* Two halves:

- **What the run would execute.** Deny if the diff touches workflow definitions, composite actions,
  any `action.yml`, anything under `.github/`, dependency manifests, lockfiles, or registry config.
  A lockfile edit is not configuration — `npm ci` executes the dependency tree's lifecycle scripts,
  with the job's full permissions, before a single test runs.
- **What the run could reach.** Require the repository's `default_workflow_permissions` to be `read`,
  and require that no `pull_request`-triggered workflow references any secret beyond the automatic
  `GITHUB_TOKEN`. A read-only, secretless job's worst case is a wasted runner minute.

Deny-by-default throughout: a truncated file list, an empty diff, or an unreadable permissions
setting all block, because none of them are evidence of safety. The review reads real patch text via
`read_pull_request_diff` rather than `changedFilePaths`, which is a first page and could silently
omit the one workflow file that matters. Approvals are written to the Work Item with their reasoning,
since this is a decision a human would otherwise have made by hand.

**A live-verification catch worth recording.** `GET /actions/workflows` does not return only files.
On any Copilot-enabled repository it also lists GitHub's own managed workflows under synthetic
`dynamic/...` paths (`dynamic/copilot-swe-agent/copilot`,
`dynamic/agents/copilot-pull-request-reviewer`) which 404 on the contents API. The first
implementation caught that failure at the loop level and poisoned the whole profile — meaning
self-approval would have refused on *every repository Factory is designed to work on*, and the unit
tests, which never saw a `dynamic/` path, all passed. Paths outside `.github/` are now skipped as
GitHub-managed (a pull request cannot edit them anyway) and per-workflow read failures are scoped to
that workflow. This is the second time in this area that a plausible, tested implementation was wrong
in a way only a live call could show.

**Adversarial review of the first implementation.** Because the approve write could not be
exercised live, the diff was instead put through a dedicated review pass. It found six ways the
control could be made to pass while being wrong, all of which are now fixed and covered by tests:

| Hole | Why it mattered |
| --- | --- |
| `readPullRequestDiff` read only the first page of files | A pull request touching more than 100 files could hide a `.github/workflows` edit past the page boundary and still present as a complete, safe file list. Now paginated, and the MCP tool cross-checks the returned count against the pull request's own `changedFiles` before reporting `truncated: false`. |
| `triggersOnPullRequest` matched only block mappings | `on: [push, pull_request]` — the most common shorthand — read as *not* pull-request-triggered, so that workflow's secrets were excluded from the review. Now parses the `on:` section in all four syntaxes, and answers `true` when it cannot tell. |
| `secrets: inherit` was invisible | A reusable-workflow call that hands the callee every repository secret referenced no secret *by name*, so the scan found none. Now reported as `<inherit: every repository secret>`. |
| Held runs were not filtered by event | `listRunsAwaitingApproval` returned every held run on the SHA. A `workflow_dispatch` or `schedule` run held for an unrelated reason is not the thing the blast-radius review reasoned about. Non-pull-request runs are now returned separately for Director to escalate. |
| An unreadable workflow file was skipped silently | The safest possible reading of a file it could not read. Now inserts an `<unreadable: path>` sentinel, which blocks. |
| Self-hosted runners were not considered | The whole argument rests on "a sandbox holding nothing worth stealing"; a self-hosted runner is not that. Now a blocker. |

Four of the six are fail-*open* defects in a security control — the review passes, and nothing looks
wrong. That is the failure mode this component has to be judged against, and it is why the reasoning
above deliberately keeps the deny-list narrow and mechanical rather than clever.

**The write was verified in Gate 4, and it does not work.** See §10.7 — the conclusion below stands
for the *review*, but the approve call itself is impossible against the hold Factory actually meets.

---

### 10.7 Gate 4 result: the approve write cannot work, and one destructive bug it exposed

Gate 4 (fixture `clockgrove/factory-gate3`, Objective #11) was built to execute the two paths no
earlier gate had ever reached: §6's conflict/rebase, and the `POST .../approve` write left unverified
above. It reached the second and was blocked before the first.

**The finding: `approve_held_workflow_runs`' write half is not merely broken, it is impossible.**
On the first held run, the blast-radius review worked exactly as designed — `safe: true`, no
blockers, three accurate assurances, and it correctly located the held run. The approve POST then
approved nothing, twice, byte-identically. GitHub's own reason, read off the audit comment:

> This run is not from a fork pull request or queued by the Actions bot.

`POST /repos/{owner}/{repo}/actions/runs/{run_id}/approve` is canonically *"Approve a workflow run
for a **fork** pull request"*. A coding-agent pull request is a **same-repo branch**, and the hold on
it comes from the repository's Copilot Actions workflow-approval policy — a different hold class with
**no approval API at all**. It is only clearable by a human clicking "Approve and run workflows", or
by turning that repository setting off before the run.

The held run's shape is worth recording, because it is not what the name suggests:
`status: "completed"`, `conclusion: "action_required"`, actor `Copilot`, event `pull_request`. The
REST `status=action_required` *filter* still matches it, which is why the read half works.

**This reverses §10.6's central claim.** "Factory makes the approval decision itself" is not
available. §10.6 called turning the setting off "a fixture workaround… it trades a real security
control for a green run" — that judgement was made believing an API alternative existed. It does not.
The setting, or a human, is the *only* mechanism. So the honest design is:

- The blast-radius review keeps its value, and arguably gains some: it is now **human-facing advice**
  — the reasoning a maintainer needs to decide, computed and recorded on the Work Item, rather than a
  decision Factory takes alone.
- `approve_held_workflow_runs` still tries (the endpoint does work for genuine fork pull requests),
  but a fork-only refusal now returns `action: "not_approvable"` with GitHub's message in
  `failures[]` and escalates the Work Item to a human. It no longer reports a permanent, total
  failure as a success-shaped `partially_approved` with an empty `approvedRunIds` — which was how
  Gate 4 first met it, detectable only by diffing two arrays.
- Repositories Factory runs against unattended should have the Copilot workflow-approval requirement
  disabled *deliberately and with that tradeoff understood*, not silently as a fixture convenience.

**And a destructive bug found on the way.** `evaluateMechanical` returned `checks_failed` for a run
that never started, without consulting `checksNeverStarted` — which the reader had already been
computing since §10.5. `integrate`'s `checks_failed` arm calls `retryOrEscalate`, which **closes the
pull request**. So a semantically correct Work Item whose CI was never *allowed* to start would have
had its work destroyed and been re-dispatched to produce a fresh pull request held in exactly the
same way. Gate 3's flaw was merging past held CI; this is its mirror image, and worse. The Gate 3 fix
had only reworded the escalation comment — telling the reader not to retry while the code retried
anyway.

Fixed with a distinct `checks_held` verdict, tested before `checks_failed` because both present as
the same `FAILURE` rollup, routed straight to `#escalate` rather than `retryOrEscalate`. Not a retry,
because a retry cannot succeed; not a wait, because nothing in the loop can change the outcome. A
human is genuinely required, which is what `escalated` means.

**Also observed.** No factory tool reads the target repository's file tree or file contents, so
compilation grounds `scope` in the Objective body alone. Gate 4 guessed right; a wrong guess would
surface several steps later as an untouched-scope failure. And `graph_apply` takes `workItemLabelId`
as a GraphQL node ID with nothing on the surface to resolve a label name to one.

**Not reached.** The conflict path is still unexercised — the fixture arms it correctly (three Work
Items with no edges between them, all appending to one array literal in `src/index.ts`), but the
foundation Work Item cannot merge while its CI is held. The graph is intact and the conflict remains
armed for the next attempt.

---

## 11. Risks

| Risk | Mitigation |
|---|---|
| Compiler emits vague Work Items | schema validation; declines are a compiler defect (§5.3) |
| Harness session dies mid-loop | state is derived — restart resumes with no special path (§1) |
| Dispatch loss exceeds retry budget | measured at 2/26; bounded confirm + escalate (§4.2) |
| Rate limits at higher concurrency | one snapshot per cycle; staggered dispatch; backoff (§4.1) |
| Conflicts on shared files | rebase, else re-dispatch; repeat ⇒ replan (§6) |
| **Scope creep back into the prior design's shape** | PRD §5 non-goals; any "we need a queue" is a **finding**, not a task |

The last one is the real risk. Every piece of the prior design was locally reasonable. The defense
is that non-goals are falsification evidence rather than obstacles to route around.

---

## 12. Open questions

1. ~~**Is a 3-function Objective enough to exercise the compiler** (PRD Q3)?~~ **Resolved by running
   it (2026-09-01, clockgrove/factory-gate0#6):** not "nearly free" at all — the rehearsal surfaced
   three real defects unit tests never caught (missing `objective.body`, the coding agent's
   assignee-login mismatch misclassifying every dispatch as an escalation, and no mechanism closing
   the Objective once every Work Item was done), each fixed live, after which the loop closed
   end-to-end with three merged PRs and zero further escalations. Gate 0 proved *the loop closes*
   exactly as intended; Gate 1 remains the place for real decomposition.
2. ~~**Unattended trigger** (PRD Q4).~~ **Resolved:** unattended operation is a goal, not a mandate.
   Escalation is a first-class outcome (§7.1) with an explicit confidence bar (§7.3). Gate 0 still
   runs in a foreground session; a scheduled or long-lived session remains the production shape, but
   nothing depends on it existing before Gate 2.
3. **Harness targets** (PRD Q5). Copilot CLI is proven — Gate 0 (§10) ran on it, live, this session.
   The portable boundary is skills + the bundled `dist/mcp-server.js` (TypeScript/Node, esbuild
   bundled, no Python — the plan's language decision moved on since this question was first written).
   Codex and Claude Code are unverified in a live run; that's §15.6's separate, deferred v0.2 check
   (run one identical Objective on all three), not a prerequisite for Gate 1 or Gate 2 — neither of
   those gates is tied to any specific harness.
4. ~~**Language.**~~ **Decided: TypeScript / Node.** See §13.

---

## 13. Language: TypeScript / Node

Decided after surveying how agent plugins are actually built and distributed.

### Evidence

| Signal | Finding |
|---|---|
| Claude Code plugins | `plugin.json` + `SKILL.md` + `bin/`; scripts run via the OS shell, so **language is unconstrained by the plugin format** |
| Agent Skills | An open, harness-agnostic standard — markdown, not code. Portability lives here, not in the library |
| MCP reference servers | ~70% TypeScript, ~30% Python |
| GitHub API client | **Octokit is officially maintained by GitHub**: first-class GraphQL, generated types, `plugin-throttling`, `plugin-retry`, built-in pagination |
| Python equivalent | **PyGithub is REST-only — no GraphQL** — and its README states it is seeking maintainers. GitHub publishes no official Python SDK |
| Install friction | `npx` is present wherever a Node-based harness is; `uvx` is equally reliable but is an extra install. Roughly a wash, slight edge to Node |

### Why the "keep Python" argument does not apply

The strongest case for Python is that the prior implementation has over a hundred Python files with
working GraphQL over `urllib`.
Three of its four supporting arguments are void under decisions already made:

- *"The library already exists"* — PRD §11 is clean-room. Nothing is copied. There is no incumbent.
- *"The Copilot SDK is Python-only"* — PRD §5 forbids a self-hosted agent execution runtime. We do
  not use that SDK; it was Inversion B. Issues are assigned over GraphQL, which is language-neutral.
- *"Python is dominant for ML tooling"* — Factory runs no models locally. Judgment lives in markdown
  skills executed by the harness.

What survives is that `uvx` is fine. True, and not decisive.

### Why TypeScript wins on the merits

Factory's deterministic layer is **almost entirely GitHub API calls that must survive rate limits and
transient 5xx**. PROBE-001 measured both: a client-side `429` from polling, and two `HTTP 500`
failures in 26 dispatches. `@octokit/plugin-throttling` and `@octokit/plugin-retry` implement exactly
those behaviors, are maintained by GitHub, and track the API spec by definition. In Python we would
hand-roll the same logic against a REST-only client or raw HTTP — which is precisely what the prior
design did.

Typed GraphQL responses also matter more than usual here, because §3's derived state is a projection
over GraphQL shapes. A wrong field name should fail at build time, not mid-loop.

### Shape

- Node ≥ 20, TypeScript, ESM
- `@octokit/core` + `graphql`, `plugin-throttling`, `plugin-retry`, `plugin-paginate-rest`
- `vitest` for tests
- Distributed so the harness can invoke it without a global install

**Portability note:** harness-agnosticism lives in the markdown skills and JSON schemas, which are
plain text under an open standard. The TypeScript library is an implementation detail invoked through
a shell boundary. Any harness that can run a command can use it.

---

## 14. Hooks

Hooks run commands on harness lifecycle events. They are **client-specific, not portable** (§15.2),
which bounds what they may be asked to carry.

### The invariant they were meant to enforce

§7.3 lists actions Director must never take autonomously — force push, history rewrite, repository or
settings mutation, release, writes outside the target repository. Today that is an *instruction*, and
instructions are advisory: they hold exactly as long as the model's judgment does.

Turning that into a mechanical block is right. Doing it with hooks is not: a guardrail present on one
harness and absent on another is not a guarantee. **§15.3 places the enforcement in the bundled MCP
server instead** — the only portable, behavior-bearing component — so the dangerous operations simply
are not exposed as tools.

### What hooks are still good for

**Defense in depth, where a harness supports them.** The MCP server cannot see a raw
`git push --force` issued through a shell tool; a pre-tool-use hook can block it. That is real value,
and it is additive.

Deliberately narrow: a short denylist of irreversible operations. Not a policy engine, not a
permission model. If the list grows past a handful of entries, that is a sign judgment is leaking
into the guardrail.

This is also where the prior design's "Keeper" idea lands — a deterministic guardrail built from
existing primitives rather than a custom service. Same invariant, no infrastructure.

### Considered and rejected

| Candidate | Verdict |
|---|---|
| `SessionStart` injecting current GitHub state | **No.** The loop reads state on cycle 1 anyway. Adds a second path to the same fact. |
| `PostToolUse` audit trail of merges | **No.** GitHub already is the audit trail. Duplicating it is stored state (§1). |
| `Stop` checkpointing progress | **No.** Directly violates §1. There is nothing to checkpoint. |
| Hook-driven dispatch or scheduling | **No.** That is the loop, and the loop belongs in the harness, not in event handlers. This is Inversion A in miniature. |

### Constraint

Hooks are **optional hardening and never required for the core loop**. If Factory stops working
correctly without them, portability is broken and that is a finding against the thesis (PRD §5).

*Open:* hook event vocabularies differ per client and are verified only for Claude Code (§15.8).

---

## 15. Harness targets: portable by construction

Factory must work on **Codex, GitHub Copilot, and Claude Code**, and must not be architected around
any one of them. This section establishes what "portable" means concretely, because there is now a
real standard to hold it to rather than a hopeful claim.

Verified against primary sources: the Agent Plugins 1.0 specification
(https://agent-plugins.org), the OpenAI plugin docs
(https://developers.openai.com/plugins/build/plugins), GitHub's plugin concept docs
(docs.github.com/copilot/concepts/agents/about-plugins), the VS Code agent-plugins reference,
and the Claude Code plugins reference (code.claude.com/docs/en/plugins-reference).

### 15.1 There is a vendor-neutral standard, and Factory should target it

**Agent Plugins 1.0** is an open, vendor-neutral packaging standard whose Technical Steering
Committee includes Amazon, Cursor, Microsoft, OpenAI, and Vercel. It defines exactly two portable
component types and leaves everything else to individual clients:

```
factory/
├── plugin.json          # $schema = agent-plugins.org/schemas/1.0.0/plugin.schema.json
├── skills/              # PORTABLE — Agent Skills format
│   └── <name>/SKILL.md
├── mcp.json             # PORTABLE — MCP server definitions
└── com.github.copilot/  # client-owned, ignored by everyone else
    └── hooks/hooks.json
```

Clients read namespaces they implement and ignore the rest without failing validation. Format
detection is by manifest path, so the same tree can carry adapters:

| Client | Manifest it looks for |
|---|---|
| Agent Plugins 1.0 | `plugin.json` with the canonical `$schema` |
| GitHub Copilot | `plugin.json` |
| Claude Code | `.claude-plugin/plugin.json` |
| Codex | `.codex-plugin/plugin.json` |

**Decision: author Factory as an Agent Plugins 1.0 package**, with thin per-harness manifest
adapters. The portable core is the product; the adapters are packaging.

### 15.2 The portability boundary is narrower than expected — and it is load-bearing

This is the finding that actually constrains the design:

| Capability | Portable? |
|---|---|
| **Skills** | ✅ standard |
| **MCP servers** | ✅ standard |
| Agents | ❌ client-specific |
| Hooks | ❌ client-specific |
| Slash commands / rules | ❌ client-specific |

Only **skills and MCP servers cross harnesses**. Three consequences follow, and they are not
cosmetic.

**1. Director must be a skill — and for a stronger reason than previously recorded.**
The earlier note said "Codex has no `agents` field." The real reason is more general: *agents are
non-portable on every client.* Claude Code puts them in `agents/`, Copilot in
`com.github.copilot/agents/`, Codex omits them. Any design in which Director is an agent is
harness-locked by construction. An early manifest draft declared `"agents": ".github/agents/"` — the
Claude Code shape — which is precisely the coupling to avoid.

**2. Hooks cannot carry the irreversibility guarantee.**
This corrects §14. Hooks are client-specific, so a hook-based guardrail protects Factory on
whichever harness implements it and silently protects nothing everywhere else. A safety property
that is present on one host and absent on another is not a safety property. §14's closing constraint
already said hooks are "optional hardening"; §15.3 says where the actual enforcement goes.

**3. MCP is the portable way to give Director deterministic tools.**
This is the design opportunity. Factory needs the Director skill to call the deterministic library
(§13). Shelling out to `node ${PLUGIN_ROOT}/dist/factory.js` works, but it is undeclared, needs
shell permission, and differs per harness. Bundling the library as an **MCP server declared in
`mcp.json`** is the standard, portable mechanism — the same tools appear on all three harnesses with
no adapter.

### 15.3 Where enforcement lives: inside the tools, not around them

Combining §15.2's points two and three produces a better answer than §14's hook:

> **Every GitHub mutation Factory performs goes through the bundled MCP server. The server refuses
> the irreversible-operation denylist. Director has no other write path.**

The guarantee then rests on the *only* behavior-bearing component that is portable, and it holds by
construction rather than by instruction — the model cannot route around a capability its tools do
not expose. This is the prior design's "Keeper" idea, finally sized correctly: not a custom service,
not a document, just the absence of a dangerous function in the one process allowed to write.

Hooks remain worthwhile as **defense in depth** where a harness supports them (Claude Code's
`PreToolUse` can block a raw `git push --force` typed into a shell tool, which the MCP server never
sees). They harden; they do not carry the invariant.

*Open:* this makes the MCP server load-bearing, so its trust and startup behavior need review —
plugin MCP servers start automatically and are implicitly trusted on install.

### 15.4 Distribution and pinning

Marketplaces are `marketplace.json` files listing versioned plugins; a marketplace can be a GitHub
repo, any Git host, or a local path. Installation is per-harness but uniformly zero-infrastructure:

- **Codex** — `codex plugin marketplace add owner/repo --ref <ref>`; Git sources accept `ref` **or
  `sha`** selectors.
- **Copilot CLI** — `copilot plugin install owner/repo`, or declaratively via `enabledPlugins` in
  `~/.copilot/settings.json` or `.github/copilot/settings.json`.
- **Claude Code** — `.claude-plugin/marketplace.json`.

PRD §9 requires installation from an **exact Git ref**. Codex satisfies this natively with a `sha`
selector, which is why Factory ships **no release machinery** — a commit SHA is the version. The
prior design built generations, qualification gates, signed approvals, and a release pipeline to
reach a guarantee the platform already provides. *Per-harness pinning fidelity is unverified for
Copilot CLI and Claude Code and must be tested, not assumed* (§15.6).

**Noted for later:** the Copilot **cloud agent** reads `enabledPlugins` from
`.github/copilot/settings.json`. That is a supported path for delivering the *project* skill package
to the agent sessions Factory dispatches — relevant to §8, and not something Factory needs to invent.

### 15.5 Bundling

For npm-sourced plugins, Codex "downloads the package without running lifecycle scripts." There is
no install step and `node_modules` is never materialized. The library therefore ships as a **single
pre-bundled file** (esbuild → `dist/factory.js`), Octokit included.

This is a constraint worth having, and it is harness-independent: install is a copy, there is no
network at install time, no dependency resolution on the adopter's machine, and the exact bytes
tested are the exact bytes that run.

### 15.6 How portability gets proven

The claim is only credible if it is exercised. Portability is verified by a deliberate, minimal check,
independent of and not a prerequisite for any numbered Gate:

**Install Factory on all three harnesses and run one identical Objective to terminal state.**

Same skills, same MCP server, same GitHub evidence — only the manifest adapter differs. Any behavior
that diverges is either a bug or a hidden dependency on a client-specific capability, and either way
it is a finding. Deferred until after Gate 0; the target is `v0.2`, not the first stable release.

### 15.7 Model neutrality

Distinct from harness neutrality, and cheaper to hold. Factory chooses no model anywhere: the
harness supplies whatever model the operator has selected for the Director session, and execution
uses whichever agent the *platform* provides — PROBE-001 measured `copilot-swe-agent`, which GitHub
may re-point at any time.

The load-bearing consequence, already established by PROBE-001: **outcomes are read from GitHub
evidence — diffs, commits, checks — never from an agent's self-report.** A `conclusion: success` on
an impossible task is exactly what model-agnosticism costs, and evidence-based evaluation (§5) is
what pays for it. Nothing in Factory should improve if the model improves, except the pass rate.

### 15.8 Open

- **Hook event vocabularies differ per client** and are unverified outside Claude Code. Confirm
  before relying on §14's hardening layer. Not blocking, given §15.3.
- **Does Codex support Agent Plugins 1.0 natively**, or only `.codex-plugin/plugin.json`? OpenAI
  sits on the TSC, so convergence is likely, but the currently documented Codex path is its own
  manifest. Ship both; verify at install.
- **Skill-invocation semantics vary.** Claude Code exposes skills as `/name`; other clients differ.
  Director must be invocable and long-running on each target — verify during §15.6.
