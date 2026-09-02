# Factory — Design

This is the single design document for Factory. It covers what Factory is for, the constraints it
holds itself to, how the loop works, what it may and may not do on its own, how it is packaged, and
what it has not established. Sections are numbered so that code comments and skills can cite them.

---

## Purpose

Factory turns **Objectives** into shipped software: a human writes an Objective as a GitHub issue,
Factory compiles it into **Work Items**, dispatches them to parallel GitHub Copilot coding-agent
sessions, supervises the results, integrates what is good, and escalates what needs a person.

It is a product, not a prototype. It is built to be installed by strangers, run against their own
repositories, and maintained.

## Goals and constraints

Two constraints define the design. Neither is negotiable; either one being violated means Factory has
become a different system.

- **No deployed infrastructure.** No database, queue, service, webhook receiver, dashboard, or hosted
  runtime. GitHub holds durable state and executes the work; the agent harness holds the loop.
- **Harness- and model-agnostic.** Factory is packaged as an
  [Agent Plugins 1.0](https://agent-plugins.org) package targeting Codex, GitHub Copilot, and Claude
  Code, with no architectural primacy for any of them, and it selects no model anywhere (§11).

Beyond those, Factory aims to be:

- **Unattended, but not unaccountable.** Running without supervision is a goal, not a mandate.
  Stopping to ask a person is a first-class successful outcome (§7.1), and the measure of quality is
  whether escalations are *well-founded*, not whether they are rare.
- **Installable by an unrelated adopter** from a public repository, with no private dependencies, no
  install script, and no consumer-specific behavior compiled in.
- **Non-privileged at install.** Installing Factory grants no workflow, settings, secret, or
  activation authority. It acts with the operator's own credentials, at the moment the operator runs
  it.

### Non-goals

These are hard constraints. Each one names a class of machinery Factory deliberately does not build,
because building it would mean the design's central bet is no longer being tested.

- **No top-level orchestration in GitHub Actions.** No planner workflow, no scheduled sweep, no
  permit protocol, no terminal routers. The loop lives in the harness.
- **No self-hosted agent execution runtime.** No session manager, session identity scheme,
  cold-resume, or patch/publication receipt pipeline. Work executes in GitHub-hosted coding-agent
  sessions tied to issues.
- **No synthesized queue, scheduler, or effect-reconciliation layer.**
- **No database, service, webhook receiver, or external persistence.**
- **No provider abstraction** beyond a single documented contract.
- **No product or domain skills inside Factory.** Those belong to the repository being worked on.

If one of these appears to be necessary, that is a **result to record** — a measured limit, with the
smallest possible response bounded against it — not a license to build it.

### Record measured limits, not desiderata

A capability gap is only allowed to justify work in proportion to what has actually been observed.
"We would like model pinning" is a wish; "this specific run failed for this specific reason" is a
limit. Design responses are scoped against measured limits, and every API or behavioral claim in this
document is verified against the live platform rather than assumed (see §14, §15).

### Where the design has been exercised

The loop has been run end-to-end against real repositories at increasing workload classes:
independent Work Items; dependent chains with `blocked by` edges; eight-to-ten item graphs mixing
parallel and dependent work; brownfield changes to existing code with real CI; and deliberate
merge-conflict collisions. §15 states plainly which paths that does *not* cover.

---

## 1. The governing idea: derived state

**Factory stores nothing. All work state is a pure function of GitHub state.**

This single decision removes an entire class of machinery. If state is never stored, it can never be
stale, never diverge, never need reconciliation, and never need a permit protocol to protect it.
There is nothing to recover because there is nothing to lose.

It also makes crash recovery free: a fresh Director session on a different machine reads GitHub and
knows everything. "Resume" and "start" are the same code path — which means the recovery path is
exercised on every run, not only after a failure.

The corollary is a hard rule:

> **If a decision cannot be derived from GitHub, Factory does not get to make it.**

Any temptation to persist a flag, a receipt, a session ID, or an attempt counter is the orchestration
loop leaking back out of the harness. Attempt counts are derived (§4.4), not recorded.

---

## 2. Component map

```
factory/
├── plugin.json / mcp.json        Agent Plugins 1.0 manifests (Copilot CLI, Codex CLI)
├── .claude-plugin/ + .mcp.json   Claude Code's equivalents (§11.4)
├── skills/                       management reasoning, invoked by a harness
│   ├── director/SKILL.md         the loop itself (§11.1)
│   └── objective-compilation/SKILL.md   Objective → Work Item graph
├── schemas/                      validation contracts
│   ├── work-item.schema.json
│   └── objective.schema.json
├── dist/factory.js               committed bundle — the artifact the plugin launches
└── src/                          deterministic TypeScript; no judgment
    ├── types.ts                  shared shapes (§3.1)
    ├── github.ts                 read-only GraphQL client → snapshot
    ├── state.ts                  GitHub → derived state (§3)
    ├── platform.ts               refusal vs. work-failure, pacing (§14)
    ├── graph.ts                  apply Work Item graph to Issues
    ├── dispatch.ts               assign + confirm + retry (§4)
    ├── evaluate.ts               mechanical PR checks (§5)
    ├── approval.ts               CI blast-radius review (§9.3)
    ├── mcp-server.ts             Director's only write path (§11.3)
    └── cli.ts / index.ts         read-only entry point; library surface
```

Director is a **skill plus a bundled MCP server**, not an agent definition, because skills and MCP
servers are the only portable component types (§11.2). Work Packet content is compiled into the Work
Item issue body (§8); outcome evaluation splits into mechanical checks in `evaluate.ts` (§5.1) and a
semantic judgment Director makes itself (§5.2); replanning is a branch of Director's own loop (§7).

**The split between code and reasoning is load-bearing:**

| Concern | Owner | Why |
|---|---|---|
| Reading GitHub, deriving state | code | mechanical, must be exact and cheap |
| Compiling Objective → Work Items | **skill** | judgment; the core product |
| Applying the graph to Issues | code | mechanical |
| Choosing what to dispatch | code | pure function of readiness (§3.2) |
| Writing the agent prompt | **skill** | judgment |
| Detecting a no-op / failed attempt | code | mechanical |
| Judging whether work is *correct* | **skill** | judgment |
| Deciding to replan | **skill** | judgment |

Keeping that boundary sharp is what stops judgment accreting into the code and code accreting around
the judgment.

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
| Attempt | a linked pull request (`closingIssuesReferences`) |
| Completion | pull request merged → issue closed |

Only two labels exist: `factory:objective` and `factory:work-item`, and both are structural identity
rather than state. Resist adding more — a status label is stored state wearing a disguise.

The coding agent's **assignee** login (`Copilot`) differs from its **suggested-actor** login
(`copilot-swe-agent`). Both identify the same bot; treating the assignee login as a human co-assignee
misclassifies every dispatch as an escalation.

### 3.2 Derived states

`state.ts` computes each Work Item's state per cycle. Pure function, no writes:

```
unstarted     open, no Copilot assignee, no linked PR
dispatched    Copilot assigned, no session and no PR yet
in_flight     session running, or the PR still carries `[WIP]` and is being pushed to
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

A Work Item that is closed without any linked pull request having merged is reported as
`doneWithoutMergedPullRequest`. That is an observation, not a decision — nothing acts on it — and it
exists so "done" is never taken at face value when an item was closed by hand or abandoned.

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

  await dispatch.confirm(inState(s, "dispatched"));          // 4.2

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

GitHub does not auto-close a parent issue when its sub-issues close, so closing the Objective is an
explicit step once every Work Item is `done`.

### 4.1 Concurrency and pacing

The platform sustains 24 concurrent coding-agent sessions with no queueing ceiling reached, but
first-pass success under burst is about 85%, and polling at that scale rate-limits the client (§14).

- `CONCURRENCY = 8`. Well inside measured limits.
- Stagger dispatch ~1 s apart. A 26-issue burst sent over 35 s lost two dispatches.
- `POLL_INTERVAL = 30 s`, one snapshot per cycle, shared by every check.
- Back off on 429 or 5xx.

These are dials with measured origins, not guesses, and each should be re-measured before being
raised. Every write additionally passes through `platform.ts`'s pacing, concurrency and
circuit-breaker controls (§14).

**One-snapshot-per-cycle has exactly one sanctioned exception: `graph_apply`.** Compiling an
Objective is a write that invalidates the very snapshot that authorised it — the snapshot was taken
when the Objective had no Work Items, so its `ready` list is empty and stays empty however many
items the call just created. A Director that dispatches from it leaves a freshly compiled graph
untouched until the next cycle, which on a timer-driven loop is wall-clock minutes of dead time, not
milliseconds. So a Director re-reads immediately after `graph_apply` and uses *that* snapshot for the
rest of the cycle. The exception is narrow and it generalises: the one thing derived state cannot
reflect is a write you have just made yourself. `mergeability_unknown` (§5.1) is the same principle
seen from the other end — there the stale signal is GitHub's, and the answer is to wait a cycle
rather than to re-read, because the recomputation is not ours to trigger.

### 4.2 Dispatch confirmation

Assignment success does not mean work started: assignments are accepted that never produce a session,
and nothing on the issue indicates it.

```
assign(issue)
wait up to 90s for: a workflow run OR a linked PR
if neither appears:
    unassign; reassign          # idempotent — no PR was created
    on second failure: mark for escalation
```

90 s is chosen against measured latency: assignment → draft pull request is 3–7 s, assignment →
terminal about 75–80 s. A missing session at 90 s is a real loss, not slowness.

This is the *only* reconciliation Factory performs, it is bounded, and it exists because a measured
platform behavior demands it.

**"On second failure" is derived, not counted.** Storing a retry counter is exactly the sidecar state
§1 forbids, and an in-process counter would not survive a restart honestly either. Instead,
`confirmFailureStreak` walks the issue's own `AssignedEvent` timeline — already fetched for the
confirm-window check — and counts trailing assignment windows that produced zero linked pull
requests, stopping at the first one that did. Every unassign/reassign leaves a fresh `AssignedEvent`,
so the timeline already encodes the retry history. A restart mid-retry loses nothing: the next cycle
recomputes the same streak from the same history and reaches the same decision.

Re-dispatch must be an assignment *transition*, not a repeated assignment: removing the assignee and
re-adding it is what starts a fresh session.

### 4.3 Idempotency

Dispatch is keyed on the issue and guarded by GitHub state: an issue with a linked pull request is
never re-dispatched. Re-running the loop after a crash cannot duplicate work, because the pull
request that already exists is itself the record that the work started.

### 4.4 Attempts, derived

Attempt count = **number of linked pull requests**. No counter is stored.

- attempts ≥ 3 → stop retrying, escalate to replanning (§7)
- a failed attempt's pull request is closed before retry, so counting stays honest
- a platform refusal (§14) creates no pull request, so it cannot inflate the count

---

## 5. Evaluation

A workflow run's `conclusion` reports that the *session finished*, never that the *work was done* —
an impossible task returns `conclusion: success`. Evaluation must therefore read the pull request:
its diff, its commits, and its body.

### 5.1 Mechanical checks (`evaluate.ts`)

Cheap, deterministic, and run before anything expensive:

```
no_op                 empty diff, OR no commit beyond "Initial plan"
declined              PR body states the task is not actionable
in_progress           title still carries the `[WIP]` prefix — the agent is not finished
untouched             diff does not touch any file the Work Item names
conflict              PR not mergeable against base
mergeability_unknown  GitHub has not finished recomputing mergeability (`mergeable === "UNKNOWN"`)
checks_pending        checks exist and have not concluded
checks_failed         checks ran and concluded failure
checks_held           runs were created but never allowed to execute (§9.2)
checks_missing        no checks at all, in a repository known to run them
sensitive_surface     diff changes what CI runs or what it can reach
ready                 none of the above
```

A no-op or a decline is a **failed attempt**, not a result.

**`[WIP]` is a completion signal, not a quality signal.** The coding agent opens every pull request
as a draft, titles it `[WIP] <title>`, and removes that prefix when it considers itself finished. It
never clears the draft flag, so draftness carries no information; and a `[WIP]` pull request can
already carry its full diff, so diff presence carries none either. Of the three candidate signals the
title prefix is the only one that separates finished from unfinished.

The rule that follows: while the prefix is present, do not judge the attempt at all — that is
`in_progress`. It is checked *before* `untouched`, `conflict` and the checks verdicts, because a
half-written change legitimately touches nothing in scope yet and legitimately fails its own tests,
and each of those verdicts closes the pull request. Judging work in progress deletes it. Once the
prefix is gone, judge the diff entirely on its merits. The wait is bounded by an inactivity window
(`WIP_INACTIVITY_GRACE_MS`) measured from the head commit's `committedDate` — not from the pull
request's `updatedAt`, which comments and Factory's own audit comments refresh — so a dead agent
escalates rather than hanging. Tune that bound **upward only**: too short closes finished work, too
long merely wastes time.

**`untouched` is a deliberately weak check.** It fires only when the diff touches *nothing* the Work
Item declared, because it routes to close-and-retry and a false positive there destroys correct work.
The consequence is that it says nothing about *extra* files, so a pull request that does its job and
also edits whatever else it likes still passes. Extra files are reported separately as
`outOfScopeFiles` on the `ready` verdict — evidence for §5.2's semantic review rather than a failing
verdict, since scope creep is frequently legitimate (a Work Item correctly updating a test its change
broke).

**`sensitive_surface` is the exception that does block**, because §7.3 makes CI configuration and
dependency sources an unconditional bar on autonomy. It escalates rather than retrying — the work is
usually correct, so a replacement pull request would carry the same diff — and it ignores the
declared scope on purpose: scope is written by the compiler, so honouring it here would let the
safety property certify itself. It shares its path rules with the CI blast-radius review (§9.3),
which asks the same question about the same paths.

**Every scope judgment requires the whole file list.** GraphQL returns `files(first: 100)` beside an
authoritative `changedFiles`, so a large pull request arrives partial. `untouched` declines to fire on
a partial list — it cannot prove a negative from page one — and the `ready` verdict carries
`fileListComplete` so a caller knows whether `outOfScopeFiles` is exhaustive.

**Check verdicts read suites as well as runs.** `statusCheckRollup` is computed from check *runs*, so
a check *suite* that concludes without emitting a run leaves the rollup `null` — byte-identical to a
repository with no CI at all. Check suites are therefore consulted when the rollup is silent, and
`null` is never read as "this repository has no CI" when the repository is known to run it (§9.2).

### 5.2 Semantic check (skill)

Only if the mechanical checks pass. Director reads the actual patch text and answers: does this
satisfy the Work Item's acceptance criteria, and nothing more?

This is why the tool surface exposes the diff itself and not merely changed file paths. An acceptance
criterion about what the code *does* — "must import and call X rather than reimplement it" — is not
checkable from a file list, and must not be waved through on the agent's own report.

Cheap checks gate expensive ones, so most failures never reach a model.

### 5.3 The decline path is a feature

Given an impossible task, the agent explains why in the pull request body and declines to invent the
missing file rather than failing the run or hallucinating. That honesty is what makes unattended
operation safe, and it is why preconditions belong in the Work Packet (§8): a well-specified Work
Item lets the agent tell us the plan is wrong. Frequent declines are a **compiler defect**, not an
execution defect.

---

## 6. Integration

Factory merges; agents do not. Coding-agent sessions never self-merge — pull requests stay draft and
issues stay open — which hands the loop a free decision point.

```
mark ready → checks green → squash merge → issue auto-closes
```

Un-drafting before merge is required and is safe precisely because the completion signal is the title
prefix rather than the draft flag (§5.1).

Conflicts are the loop's problem: parallel pull requests branch from the same base and only collide
at the second merge.

- attempt a rebase; if it succeeds, proceed
- if it does not, close the pull request with an audit comment and re-dispatch against the new base
- repeated conflict on one file means the graph wrongly modelled two items as independent ⇒ replan

GitHub refuses `updatePullRequestBranch` outright when the merge would conflict, so a rebase never
silently "succeeds" without resolving anything, and reaching the rebase path again means the base
genuinely moved again.

That third bullet is a **termination condition, not advice.** Re-dispatch on conflict is bounded by
the same derived attempt count as every other retry (§4.4): a rebase that cannot fix a conflict means
the next attempt branches from the same base and conflicts identically, so an unbounded conflict path
spins forever, spending one coding-agent run and one pull request per cycle and never reaching a
human. When attempts are exhausted the Work Item escalates with the *graph* diagnosis rather than the
usual "the agent failed" one — the fix is an added dependency edge or a merged pair of items, which
only replanning can supply.

**Each conflict re-dispatch spends one of the Work Item's three attempts**, on work that was not
defective, so a multi-way collision on one file can exhaust the item that merges last. A successful
rebase deliberately consumes no attempt, since it opens no new pull request and therefore cannot be
the thing that spins.

Merging one at a time per cycle keeps conflicts rare without a serialization protocol.

---

## 7. Replanning and escalation

Triggers: attempts exhausted (§4.4), repeated declines, or repeated conflicts.

Replanning **edits the graph** — split a Work Item, add a missing dependency, correct acceptance
criteria — and is the one place Factory changes its own plan. Work Item identity is stable and titles
are never rewritten to encode status; title drift destabilises identity and deadlocks replanning.

### 7.1 Escalation is a first-class outcome

**Unattended operation is a goal, not a mandate.** Some decisions legitimately require a human, and a
system that cannot say so will invent a way to keep going.

This is a structural property, not a concession. A loop with no legitimate "stop and ask" state has to
solve every problem with more machinery, and eventually has to be stopped from outside. A loop that
can stop does not need to be stopped.

Escalating is therefore a **successful outcome** of a cycle, not a failure of one. The metric that
matters is whether escalations are well-founded, not whether they are rare. Suppressing a needed
escalation is a defect; raising a clear one is the system working.

### 7.2 How escalation is represented

Derived state, like everything else (§1). No new label, no stored flag:

```
unassign copilot-swe-agent
assign the human owner
comment: what was attempted, what failed, the evidence, the specific question
```

`escalated` = open, assigned to a human, Copilot not assigned. Director does not re-dispatch an issue
assigned to a human. Reassigning Copilot is the human's "carry on" signal — an ordinary GitHub
gesture, not a Factory protocol.

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

### 7.4 Replanning has no write path, and that is a decision

§7 describes replanning as editing the graph. The tool surface deliberately cannot do it.
`graph_apply` refuses outright when an Objective already has Work Items, and nothing else adds an
item, adds an edge, or edits acceptance criteria. A Director that concludes the graph is wrong can
only stop and say so — which `skills/director/SKILL.md` instructs explicitly, rather than leaving it
to be discovered.

This follows the measured-limits discipline. Building a graph-mutation write path against a
hypothesis would be expensive in exactly the wrong way: editing an in-flight Work Item races the agent
already working from its body, and re-parenting or splitting an item breaks the stable identity that
replanning depends on.

The fallback is not a degradation. §7.1 makes escalation a first-class successful outcome, so "the
graph is wrong and I cannot fix it" is a well-founded stop, not a failure to be engineered away.

**Revisit trigger:** an Objective that genuinely stalls — attempts exhausted, or repeated declines or
conflicts on one item — where a specific graph edit would demonstrably have unblocked it and a human
had to make that edit by hand. Record it as a measured limit, with the smallest write path that would
have sufficed. Adding new Work Items to an existing Objective is a strictly smaller change than
editing existing ones, and is the likely first step if the trigger fires.

---

## 8. Work Item → prompt

Issue-based coding-agent dispatch takes a prompt. The Work Packet therefore **is** the prompt, and it
is compiled into the Work Item's issue body:

```
Goal              one sentence
Acceptance        explicit, checkable criteria
Scope             files that may be modified
Preconditions     what must already be true  ← enables the decline path
Out of scope      explicit non-goals
Conventions       repo-specific constraints
```

Precision in the prompt is what replaces per-session tool allowlists: agents given a one-line scope
constraint touch only the named files.

**The control tradeoff is explicit.** Factory gives up per-session tool allowlists and session-status
polling in exchange for deleting the entire execution and reconciliation tier. Issue assignment does
accept structured fields (`customInstructions`, `customAgent`, `model`, `baseRef`), and Factory passes
the ones that cost nothing to pass, as a thin optional refinement. It does not stand up a
reconciliation tier or a task-status polling loop, because the Agent Tasks API carries no
issue-reference field and so cannot deterministically correlate a task to the issue that triggered it
under concurrent dispatch — which is Factory's normal operating mode. Session status is derived from
issue and pull-request timeline state (§3), never from a task API.

Acceptance criteria must be written as **hard constraints, not descriptions**. A path stated
descriptively ("tests live in `test/`") is followed unreliably; the same path stated as a `REQUIRED:`
constraint naming the exact location, with the reason restated under out-of-scope, is followed
reliably. Where a repository's test runner only discovers tests in one directory, that path is
load-bearing and a colocated test silently never runs.

---

## 9. Repository requirements

### 9.1 Before pointing Factory at a repository

- **Seed a `.gitignore`** (at minimum `node_modules/`, `dist/`, `*.log`) in the same commit as
  `package.json`/`tsconfig.json`, never in a follow-up. Without it a coding agent's `npm install` can
  commit hundreds of generated files into a Work Item's pull request. If a pull request arrives with
  hundreds of unexpected changed files, check for this before treating it as a Factory finding.
- **Ship a CI workflow that runs the tests and the typecheck on `pull_request`.** Without one, GitHub
  reports no check runs, the `checks_pending`/`checks_failed` branches can never fire, and a `ready`
  verdict silently narrows to "open, mergeable, touches the expected files" — nothing has actually
  executed the code.
- **Verify CI actually executes** by opening one pull request and confirming its checks run, before
  compiling a full Objective. See §9.2 for the reason this is not automatic.

### 9.2 The workflow-approval hold

GitHub holds workflow runs on coding-agent pull requests in `action_required` until a maintainer
clicks **"Approve and run workflows"**. Unapproved, a run is created and then waits, executing
nothing, while the identical workflow succeeds on `push` to the default branch — which makes the
problem look repository-specific rather than structural. This is an account-wide default, so a fresh
repository does not avoid it.

Two consequences matter:

- **A held run is not a failed run.** Check suites read `conclusion: failure` only because closing or
  merging the pull request cancels them; every run on a branch shares a single `updated_at` a second
  or two after that branch's `merged_at`, however far apart they were created. The honest verdict
  while the pull request is open is `checks_pending`, forever, because the checks genuinely never
  arrive. `checks_held` exists as a distinct verdict so this routes to escalation rather than to the
  retry path, which would close correct work as though its tests had failed.
- **Factory cannot clear the hold itself.** `POST /repos/{owner}/{repo}/actions/runs/{run_id}/approve`
  covers *fork* pull requests and refuses a same-repository coding-agent branch outright. The hold
  comes from the repository's Copilot coding-agent workflow-approval requirement, which is readable
  over REST and has no write API. The refusal is deterministic, so it is reported and escalated rather
  than retried.

The two fixes a human can apply are to approve the run on the pull request, or to change
**Settings → Copilot → Coding agent → Require approval for workflow runs**. The current value is
readable:

```bash
gh api repos/OWNER/REPO/copilot/cloud-agent/configuration --jq .require_actions_workflow_approval
```

That setting governs every future agent run in the repository, not one pull request, so it is a
deliberate decision rather than a workaround. Repositories with no pull-request CI are unaffected.

### 9.3 The blast-radius review

Where Factory *can* act — a held run it is permitted to approve — it does so behind a blast-radius
review (`src/approval.ts`, exposed as `approve_held_workflow_runs`), and records the decision and its
reasoning on the Work Item, because this is a decision a human would otherwise have made by hand.

The review deliberately does not ask "is this a good change" — running the agent's code is the entire
point of CI, and a test file can make a network call as easily as any other file. It asks the narrower
question the maintainer's click actually asks: *does approving escalate privilege beyond running the
tests in a sandbox holding nothing worth stealing?* Two halves:

- **What the run would execute.** Deny if the diff touches workflow definitions, composite actions,
  any `action.yml`, anything under `.github/`, dependency manifests, lockfiles, or registry config. A
  lockfile edit is not configuration: `npm ci` executes the dependency tree's lifecycle scripts, with
  the job's full permissions, before a single test runs.
- **What the run could reach.** Require the repository's `default_workflow_permissions` to be `read`,
  require that no `pull_request`-triggered workflow references any secret beyond the automatic
  `GITHUB_TOKEN`, and deny if a self-hosted runner is involved — the whole argument rests on the job
  being a sandbox holding nothing worth stealing, and a self-hosted runner is not that.

**Deny by default throughout.** A truncated file list, an empty diff, or an unreadable permissions
setting all block, because none of them is evidence of safety. Specifically:

- The review reads real patch text rather than changed file paths, and paginates: a pull request
  touching more than 100 files must not be able to hide a workflow edit past a page boundary.
- Pull-request triggering is detected in all four `on:` syntaxes, and answers "yes" when it cannot
  tell — `on: [push, pull_request]` must not read as *not* pull-request-triggered.
- `secrets: inherit` on a reusable-workflow call is reported as every repository secret, not as no
  secret by name.
- An unreadable workflow file inserts a sentinel that blocks, rather than being skipped as safe.
- Held runs are filtered by event: a `workflow_dispatch` or `schedule` run held for an unrelated
  reason is not what the review reasoned about, and is surfaced separately for escalation.

Workflows GitHub manages itself appear in `GET /actions/workflows` under synthetic `dynamic/…` paths
that 404 on the contents API. Paths outside `.github/` are skipped as GitHub-managed — a pull request
cannot edit them — and per-workflow read failures are scoped to that workflow rather than poisoning
the whole profile.

Four of the failure modes above are fail-*open* defects: the review passes and nothing looks wrong.
That is the failure mode this component is judged against, and it is why the deny-list stays narrow
and mechanical rather than clever.

---

## 10. Tool surface

Director's entire write path is the bundled MCP server (§11.3). The tools are deliberately few, and
each is either a pure read or one bounded action:

| Tool | Kind | Purpose |
|---|---|---|
| `read_objective` | read | one snapshot per cycle: the Objective, its Work Items, their derived states |
| `read_pull_request_diff` | read | actual patch text, so §5.2's semantic review is performable |
| `read_repository_layout` | read | every path on the default branch, so compilation names paths that exist |
| `read_repository_file` | read | one file's text, for writing acceptance criteria against real code |
| `evaluate_mechanical` | read | §5.1's verdict, without acting on it |
| `graph_apply` | write | apply a compiled Objective as sub-issues plus `blocked by` edges |
| `dispatch_start` | write | assign the coding agent to a ready Work Item |
| `dispatch_confirm` | write | §4.2's confirm window: wait, retry, or escalate |
| `dispatch_integrate` | write | §6: merge, rebase, close-and-retry, or escalate |
| `dispatch_retry_or_escalate` | write | §4.4: close an unusable pull request and retry, or escalate |
| `approve_held_workflow_runs` | write | §9.3's blast-radius review and approval |
| `close_objective` | write | close the Objective once every Work Item is `done` |

Several details of that surface are load-bearing:

- **`read_objective` takes a `minimal` flag.** The coding agent quotes the entire Work Item into its
  pull request body, so a ten-item graph can exceed the tool output limit outright. `minimal` drops
  prose no derivation reads — pull request bodies and the Objective body, replaced by a
  `bodyLength` — and retains everything the state machine and the confidence bar reason about.
- **`read_objective` validates the escalation login** at the start of a cycle, while nothing is at
  stake, rather than at the first escalation — which is precisely the moment it cannot afford to
  throw.
- **`read_pull_request_diff` takes `paths`.** The patch budget is otherwise first-come-first-served in
  GitHub's ordering, so one large generated file early in the alphabet starves the files actually
  under review. Filtered-out files are still listed with their status and line counts, so the file
  list stays complete and blast-radius and scope checks reason over the whole diff. `truncated` means
  content was requested and cut, never that a deliberate filter was applied; an empty `paths` array
  means no filter rather than no files.
- **Action-taking tools report which branch they took.** `dispatch_integrate` returns `action`
  (merged, rebased, redispatched, escalated, no-op) rather than only a verdict, because a rebase that
  succeeded without resolving anything leaves no trace anywhere else.
- **Linked pull requests carry `mergedAt` and `closedAt`.** No derivation reads them — state is
  derived from the present — but they make ordering reconstructable after the fact, for instance
  whether a dependent item was dispatched only after its dependency actually merged.
- **`graph_apply` resolves the `factory:work-item` label by name** and applies it automatically when
  the repository defines it, rather than requiring a node ID no caller can produce.
- **A 404 from the contents API means "missing" only once the repository is confirmed readable.** The
  contents API also answers 404 for a repository that does not exist or that the token cannot see, so
  a mistyped owner or repo would otherwise return a confident `exists: false` for every path and let
  compilation plan to create files that are already there.

---

## 11. Packaging and portability

Factory must work on Codex, GitHub Copilot, and Claude Code, and must not be architected around any
one of them.

### 11.1 A vendor-neutral standard

**Agent Plugins 1.0** is an open packaging standard that defines exactly two portable component types
and leaves everything else to individual clients:

```
factory/
├── plugin.json          # $schema = agent-plugins.org/schemas/1.0.0/plugin.schema.json
├── skills/              # PORTABLE — Agent Skills format
│   └── <name>/SKILL.md
├── mcp.json             # PORTABLE — MCP server definitions
└── com.github.copilot/  # client-owned, ignored by everyone else
```

Clients read the namespaces they implement and ignore the rest without failing validation. Format
detection is by manifest path, so one tree can carry per-client adapters: root `plugin.json` and
`mcp.json` for Agent Plugins 1.0 clients, and `.claude-plugin/plugin.json` plus `.mcp.json` for
Claude Code.

### 11.2 The portability boundary

| Component | Portable? |
|---|---|
| Skills (markdown) | **Yes** — the Agent Skills format is harness-agnostic |
| MCP servers | **Yes** — a standard protocol over stdio |
| Agents | No — each client has its own location and format, and Codex has none |
| Hooks | No — client-specific event vocabularies |
| Slash commands, rules | No |

This boundary is why **Director is a skill, not an agent**: an agent definition is client-specific by
construction, so a loop that lived in one could not be the same loop everywhere.

### 11.3 The MCP server is the only write path

**Every GitHub mutation Factory performs goes through the bundled MCP server.** The irreversible
operations §7.3 forbids — force push, history rewrite, repository or settings mutation, release,
writes outside the target repository — are simply not exposed as tools.

That places the guarantee in construction rather than instruction. A model cannot route around a
capability that does not exist, whereas an instruction holds exactly as long as the model's judgment
does. It is also why the server's own surface stays small and reviewable: a plugin's MCP server starts
automatically and is implicitly trusted once installed, so it is the component whose trust model has
to be worth that.

### 11.4 Distribution and pinning

Marketplaces are `marketplace.json` files listing versioned plugins; a marketplace can be a GitHub
repository, any Git host, or a local path. Installation is per-harness but uniformly
zero-infrastructure:

| Harness | Install path |
|---|---|
| GitHub Copilot | `copilot plugin marketplace add owner/repo` then `copilot plugin install name@owner`, or declaratively via `enabledPlugins` in `~/.copilot/settings.json` or `.github/copilot/settings.json` |
| Codex | `codex plugin marketplace add owner/repo --ref <ref>`; Git sources accept a `ref` or a `sha` selector |
| Claude Code | `.claude-plugin/marketplace.json` |

Factory ships **no release machinery**: a commit is the version, and a branch or tag is a name for
one.

Tracking the default branch is the normal path. Two situations warrant pinning instead, and they are
different arguments:

- **A run whose result has to mean something** must not have its instrument change underneath it
  mid-run. Pin for the duration, then unpin.
- **A deliberate review posture.** Factory holds a token and merges pull requests unattended, so
  adopting new code grants it that authority. Pinning trades staleness for reviewing what it adopts.

Pin by appending a `#<ref>` to the marketplace source. **`<ref>` must be a branch or tag name, never a
commit SHA**: the CLI resolves the fragment with `git clone --depth 1 --branch <ref>`, and `--branch`
accepts only branches and tags. A tag is the stable way to name a specific reviewed commit.

Pinning fidelity differs per client and should be verified on each rather than assumed.

### 11.5 Bundling

Factory ships as a single pre-bundled file (esbuild → `dist/factory.js`, Octokit included).

- No install step, no lifecycle scripts, and `node_modules` is never materialized on an adopter's
  machine.
- The exact tested bytes are the exact bytes that run; no dependency resolution happens at install.

The running server's advertised version string is taken from `package.json` rather than hardcoded,
and `npm run verify:package` asserts it against the manifests — a server announcing something other
than what it shipped as is a defect the manifests alone cannot catch.

### 11.6 Verifying the package, and what that does not cover

`npm run verify:package` checks the committed manifests and skills, starts the bundled MCP server
through the manifest's own command and arguments, and verifies its public tool surface: a manifest
pointing at a bundle that was never built, the two manifest pairs drifting apart, the running server's
version disagreeing with the manifests, a tool silently disappearing, or a tool shipped without a
description a model can route on.

**It is not an install test.** Starting the committed bundle the way the manifest says to is a
strictly weaker claim than "a real CLI can install this". Prose is the only part of a release with no
CI so a documented install, upgrade or uninstall flow is an untested claim until someone runs it
against the published artifact the way a stranger would.

### 11.7 Model neutrality

Factory chooses no model. The harness supplies whatever model the operator selected, and Factory's
logic does not vary with it. Outcomes are read from GitHub evidence — diffs, commits, checks — never
from an agent's self-report, so a better model should raise the pass rate without changing anything
Factory does.

---

## 12. Language and runtime

**TypeScript on Node**, decided on the merits of the deterministic layer's actual work.

Factory's deterministic layer is almost entirely GitHub API calls that must survive rate limits and
transient 5xx. Octokit is maintained by GitHub, is TypeScript-first, has first-class GraphQL, and
ships `plugin-throttling` and `plugin-retry` that implement exactly those behaviors and track the API
spec by definition. The Python equivalent is REST-only with no GraphQL, and GitHub publishes no
official Python SDK — so the same logic would be hand-rolled against a weaker client.

Typed GraphQL responses matter more than usual here, because §3's derived state is a projection over
GraphQL shapes. A wrong field name should fail at build time, not mid-loop.

- Node ≥ 20, TypeScript, ESM
- `@octokit/core` + `graphql`, `plugin-throttling`, `plugin-retry`, `plugin-paginate-rest`
- `vitest` for tests
- Distributed bundled, so the harness can invoke it without a global install

Harness-agnosticism lives in the markdown skills and JSON schemas, which are plain text under an open
standard. The TypeScript library is an implementation detail invoked through a shell boundary; any
harness that can run a command can use it.

---

## 13. Hooks

Hooks run commands on harness lifecycle events. They are **client-specific and not portable** (§11.2),
which bounds what they may be asked to carry.

The invariant they might have enforced — §7.3's list of actions Director must never take
autonomously — lives in the MCP server instead (§11.3). A guardrail present on one harness and absent
on another is not a guarantee.

What hooks are still good for is **defense in depth**, where a harness supports them. The MCP server
cannot see a raw `git push --force` issued through a shell tool; a pre-tool-use hook can block it.
That is real and additive value, and it stays deliberately narrow: a short denylist of irreversible
operations, not a policy engine and not a permission model. If the list grows past a handful of
entries, judgment is leaking into the guardrail.

Considered and rejected:

| Candidate | Verdict |
|---|---|
| `SessionStart` injecting current GitHub state | **No.** The loop reads state on cycle 1 anyway. A second path to the same fact. |
| `PostToolUse` audit trail of merges | **No.** GitHub already is the audit trail; duplicating it is stored state (§1). |
| `Stop` checkpointing progress | **No.** Directly violates §1. There is nothing to checkpoint. |
| Hook-driven dispatch or scheduling | **No.** That is the loop, and the loop belongs in the harness, not in event handlers. |

Hooks are **optional hardening and never required for the core loop.** If Factory stops working
correctly without them, portability is broken.

---

## 14. Measured platform behavior

The design rests on measured behavior of GitHub's coding agent and API, recorded in
[`PLATFORM-BEHAVIOR.md`](PLATFORM-BEHAVIOR.md). The load-bearing results:

| | Measured |
|---|---|
| Concurrent agent sessions | 24, no queueing ceiling reached |
| 8 parallel tasks, wall clock | ~80 s (versus ~10 min serial) |
| Assignment → draft pull request | 3–7 s |
| First-pass success at burst (26) | 85% |
| Work correctness | 11/11 actionable tasks correct and minimal |
| Pull request → issue linkage | `closingIssuesReferences` correct, 12/12 |
| Self-merge | never — pull requests stay draft, issues stay open |
| Terminal status | must be read from the pull request, not the run conclusion |
| Throttle planes | 3, only 1 visible to `/rate_limit` |

Two of those rows drive most of the design.

**A run conclusion is not an outcome signal.** A deliberately impossible task returned
`conclusion: success`; the agent reported the problem only in the pull request, with an explanatory
body, an empty diff, and no commit beyond `Initial plan`. Evaluation reads the pull request (§5), and
a no-op is machine-detectable.

**Platform refusal is not work failure.** GitHub refuses requests with `403 API rate limit exceeded`
while `/rate_limit` simultaneously reports full quota on both documented planes, because the
secondary/abuse limit is a third plane with no introspection endpoint. A `403` carrying rate-limit
text, a `429`, or a `5xx` is a property of the *substrate*, never of the *Work Item*: it must not
increment an attempt count, mark an item failed, or reach the replanner. Back off on wall-clock time,
never on quota introspection — the only trustworthy signal that the limit has cleared is a successful
request — and continuing to hammer through a secondary limit risks the integration being banned
rather than merely throttled.

`platform.ts` implements that as pacing well under the documented secondary limits rather than up to
them (a handful of concurrent in-flight calls, content-creating calls at roughly half the documented
allowance, a minimum gap between mutative calls), plus a wave-level circuit breaker that pauses all
dispatch for a growing cooldown after consecutive refusals and surfaces for a human decision once it
has tripped repeatedly.

The substrate is also **lossy under burst**, which is what the loop's three supervisory duties exist
for and all they exist for: dispatch confirmation (§4.2), no-op detection (§5.1), and idempotent
retry (§4.3).

---

## 15. Limitations

Stated plainly, because a list of things that work invites absence of evidence to read as evidence of
absence.

- **The attempts-exhausted escalation branch (§4.4) has not executed in a real run.** It is tested
  code, not observed behavior.
- **The rebase-success path (§6) has not been observed.** Every conflict encountered so far threw, so
  the branch that recovers without a re-dispatch is untested against the live API.
- **Unattended across turn boundaries is not the same claim as unattended within one turn.** Runs to
  date have been paced by a session that stayed awake throughout. That establishes the loop's logic —
  read, confirm, retry, integrate, replan, in the right order, against a real repository. It does not
  establish the property the derived-state design exists to provide: a session waking with no working
  memory, reconstructing everything from GitHub, and being re-entered by a timer rather than by its
  own control flow. A re-entry that is not timer-started does not count as a wake-up.
- **Cross-harness portability is verified by construction, not by a run.** The published package has
  been installed and exercised on GitHub Copilot CLI. Running one identical Objective on Codex and
  Claude Code is a separate check; any divergence would be a bug or a hidden client-specific
  dependency.
- **"The tests pass" is often static analysis of a diff.** Where a repository has no CI, or where CI
  is held (§9.2), the checks verdict is `null` or `checks_held` and nothing has executed the code.
- **A finished run cannot be audited from the API alone.** A pull request's title, body and draft flag
  are mutable, and the coding agent edits them after Factory acts, so reading a merged pull request
  later shows what is true now rather than what Factory decided on. The squash commit subject on the
  default branch is the durable evidence.
- **Hook event vocabularies differ per client** and are verified for only one of the three targets
  (§13). Skill-invocation syntax likewise varies, so "Director launches and stays live across
  multiple cycles" has to be confirmed per harness rather than inferred from the manifest being
  accepted.
