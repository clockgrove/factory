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
