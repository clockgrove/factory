# Clockgrove Factory — Implementation Plan

Peer document to [`PRD.md`](PRD.md). The PRD says *what and why*; this says *how*.

Status: draft for review
Date: 2026-08-30
Depends on: PRD v2 (accepted), [`PROBE-001`](PROBE-001-agent-parallelism.md)

---

## 1. The governing idea: derived state

**Factory stores nothing. All work state is a pure function of GitHub state.**

This single decision is what removes the entire class of machinery that consumed v1. If state is
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
└── factory/                      deterministic Python; no judgment
    ├── github.py                 thin gh/GraphQL client
    ├── state.py                  GitHub → derived state (§3)
    ├── graph.py                  apply Work Item graph to Issues
    ├── dispatch.py               assign + confirm + retry (§4)
    └── evaluate.py               mechanical PR checks (§5)
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

v1 wrote code for the judgment and accreted judgment into the code. Keeping this boundary sharp is
the main defense against that.

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

`state.py` computes each Work Item's state per cycle. Pure function, no writes:

```
unstarted     open, no Copilot assignee, no linked PR
dispatched    Copilot assigned, no session and no PR yet
in_flight     session running, or draft PR with real commits
failed        session concluded failure, OR PR is a no-op (§5.1)
for_review    PR has a real diff and checks have settled
blocked       open, but some `blocked by` issue is still open
done          linked PR merged and issue closed
```

**Ready** = `unstarted` AND every `blocked by` issue is closed.

Note what is absent: no "claimed", no "leased", no "owned by run 12345". A Work Item's state is
whatever GitHub currently says it is, and two Directors reading simultaneously derive the same
answer.

---

## 4. The loop

Runs in the harness, holding continuous context. One cycle:

```python
while True:
    s = state.read(objective)               # one snapshot per cycle

    if s.all_done():
        close_objective(); break

    for wi in s.ready()[:CONCURRENCY]:      # 4.1
        dispatch.start(wi)

    dispatch.confirm(s.dispatched)          # 4.2  — required by PROBE-001
    for wi in s.failed:
        dispatch.retry_or_escalate(wi)      # 4.4

    for wi in s.for_review:
        integrate(wi)                       # §6

    if s.stalled():
        replan(s)                           # §7

    sleep(POLL_INTERVAL)
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

### 5.1 Mechanical checks (`evaluate.py`)

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

Merging one at a time per cycle keeps conflicts rare without a serialization protocol.

---

## 7. Replanning

Triggers: attempts exhausted (§4.4), repeated declines, or repeated conflicts.

Replanning **edits the graph** — split a Work Item, add a missing dependency, correct acceptance
criteria — and is the one place Factory changes its own plan. Per F4, a wave is a *workstream of
multiple Objectives*; Work Item identity is stable and titles are never rewritten to encode status.
Title drift was the root of v1's replan deadlock.

If replanning cannot produce a change it believes will succeed, it stops and asks a human. Not every
loop closes, and pretending otherwise is what produces livelock.

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
| 1 | `github.py` + `state.py` | derive full state of a hand-made Objective |
| 2 | `dispatch.py` | assign, confirm, retry against a real repo |
| 3 | `evaluate.py` | correctly classify a known no-op |
| 4 | integration | merge a PR and close its issue |
| 5 | `objective-compilation` skill + schema | Objective → validated Work Item graph |
| 6 | `graph.py` | apply graph as sub-issues + dependencies |
| 7 | `director.md` | assemble the loop → **Gate 0** |

Steps 1–4 use a hand-written Work Item graph, so execution is proven before compilation is written.
That ordering is deliberate: v1 built compilation first and never proved execution.

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

---

## 11. Risks

| Risk | Mitigation |
|---|---|
| Compiler emits vague Work Items | schema validation; declines are a compiler defect (§5.3) |
| Harness session dies mid-loop | state is derived — restart resumes with no special path (§1) |
| Dispatch loss exceeds retry budget | measured at 2/26; bounded confirm + escalate (§4.2) |
| Rate limits at higher concurrency | one snapshot per cycle; staggered dispatch; backoff (§4.1) |
| Conflicts on shared files | rebase, else re-dispatch; repeat ⇒ replan (§6) |
| **Scope creep back into v1 shape** | PRD §5 non-goals; any "we need a queue" is a **finding**, not a task |

The last one is the real risk. Every piece of v1 was locally reasonable. The defense is that
non-goals are falsification evidence rather than obstacles to route around.

---

## 12. Open questions

1. **Is a 3-function Objective enough to exercise the compiler** (PRD Q3), or is it so trivial that
   compilation is nearly free and Gate 0 proves only execution? Leaning: fine — Gate 0 is meant to
   prove *the loop closes*, and Gate 1 introduces real decomposition.
2. **Unattended trigger** (PRD Q4). Gate 0 runs in a foreground session. Production needs a
   scheduled or long-lived session; needs confirmation.
3. **Harness targets** (PRD Q5). Copilot CLI first. The portability boundary is that `factory/` is
   plain Python driven by markdown skills — but this needs one non-Copilot dry run to be credible.
4. **Language.** Python for parity with v1's reference material and `gh` ergonomics. Node is
   defensible if harness packaging prefers it. Decide before step 1.
