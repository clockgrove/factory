# Clockgrove Factory — PRD v2 (clean-room)

Status: draft for review
Supersedes: all v1 implementation (`clockgrove/factory` @ `main`, generations 1–56)
Date: 2026-08-30

---

## 1. Product

Factory is a **real, open-sourceable agent plugin** that turns Objectives into shipped software:
Objective → Work Items → parallel agent execution → merged outcomes.

Two design constraints define it:

- **No deployed infrastructure.** No database, queue, service, webhook receiver, or hosted runtime.
  GitHub and the harness are the only substrate.
- **Harness-agnostic.** Packaged as an agent plugin usable from any harness, not bound to one
  vendor's runtime.

We prove it by **using it ourselves** to build the Clockgrove platform. Clockgrove is the first
consumer and the proving ground — not a disposable test workload.

Those constraints are a thesis worth proving, but the output is a **product, not a prototype**.
Everything is built to be shipped, adopted by strangers, and maintained.

This document exists because none of the above was ever written down. Its absence is the direct
cause of the two inversions in §3.

---

## 2. Intended architecture

**The orchestration loop lives in the harness.** GitHub is durable state and the execution substrate — not the orchestrator.

```text
Human authors an Objective (GitHub Issue)
    ↓
Director — runs in the harness (Copilot CLI or any agent session)
    ├── reads current GitHub state
    ├── compiles Objective → Work Items  (the "high-level compiler")
    ├── applies the graph to GitHub (issues, sub-issues, dependencies)
    ├── assigns ready Work Items to GitHub Copilot agent sessions
    ├── observes PRs / checks / reviews
    ├── reviews, merges, accepts
    └── loops until the Objective is achieved
    ↓
GitHub
    ├── Issues / sub-issues / dependencies  → durable work state
    ├── Copilot agent sessions (issue-tied)  → parallel execution
    └── PRs / checks / reviews / merge queue → integration + acceptance
```

Director holds continuous in-process context. It knows what it dispatched, so it does not
reconstruct the world on every wake, and does not need to prove its own effects landed.

---

## 3. Why v1 is discarded

Two architectural inversions, both dated and traceable. Neither was ever presented as a choice.

**Inversion A — orchestration moved into GitHub Actions.**
Issue #53 (2026-08-21, day 5) opens: *"Repository events provide fast wakeups, a scheduled sweep
recovers missed/suppressed events."* This placed the top-level loop inside Actions. Intended location:
the harness.

**Inversion B — work execution moved out of GitHub.**
Issue #149 / PR #161 deleted GitHub-native Agent Tasks in favor of self-hosted runner SDK sessions.
Intended location: GitHub, tied to issues.

The two compound. Self-hosting execution is *why* an Actions-resident loop then needs session
reconciliation, capacity management, and ownership resolution.

**Measured outcome of v1:** 13 days, ~1.7 MB of Python, 46 workflows, 56 installed generations,
**zero completed work items**. Recent defect classes are all distributed-systems failures:
livelock, lost receipts, stale routing, paused-owner takeover, packet admission ordering.

---

## 4. Findings carried forward

These were expensive. They are the only artifacts of v1 that must survive.

| ID | Finding |
|----|---------|
| F1 | GitHub Agent Tasks accepts **only a prompt** — no model pin, tool allowlist, or structured context slots. |
| F2 | An Actions-resident loop has **no memory**. It must reconstruct all state per wake and cannot synchronously observe its own dispatch. This forces permits, receipts, propagation windows, serialization fences, and terminal routers into existence. |
| F3 | Synthesizing exactly-once orchestration from GitHub primitives is *possible* but its cost **dominates the system**. It consumed essentially all of v1. |
| F4 | A **wave is a workstream of multiple Objectives**, not a single Objective. Modeling wave = Objective produces Work Item title drift and unstable identity, and was the root of the v1 replan deadlock. |
| F5 | A gh-aw / Actions runtime is **GitHub-only** and can never satisfy "usable from any harness." Only the cognition layer is portable. |
| F6 | **"Zero open issues" is not a valid completion criterion** for a process whose normal operation emits issues. Completion must be an external capability demonstration. |
| F7 | Recording only *desiderata* ("we want model pinning") rather than *measured limits* lets a one-line platform gap justify an unbounded build. Capability findings must be recorded as measured limits, with the scope of response bounded against them. |

---

## 5. Non-goals (hard constraints)

Violating any of these means the thesis is no longer being tested.

- **No top-level orchestration in GitHub Actions.** No planner workflow, no scheduled sweep, no permit protocol, no terminal routers.
- **No self-hosted agent execution runtime.** No session manager, session identity scheme, cold-resume, or patch/publication receipt pipeline.
- **No synthesized queue, scheduler, or effect-reconciliation layer.**
- **No database, service, webhook receiver, or external persistence.**
- **No provider abstraction** beyond a single documented contract.
- **No product/domain skills** in Factory. Those belong to the consumer repository.

If a non-goal appears necessary, that is a **result** to record against the thesis — not a license to build it.

---

## 6. Explicit control tradeoff

F1 is accepted rather than engineered around.

**Decision:** compile the Work Packet **into the prompt**. Give up per-session model pinning and
tool allowlists in exchange for deleting the entire execution and reconciliation tier.

**Rationale:** per-session control produced zero completed work items in v1. Its demonstrated value
is currently zero; its architectural cost was most of the codebase.

**Revisit trigger:** a measured failure directly attributable to missing model or tool control —
recorded as a capability limit per F7, with the scope of any response bounded against it.

---

## 7. Gate 0 — minimum viable proof

v1 was only ever run at full scale, on an unproven mechanism, and never closed a single loop.
v2 inverts that: prove the loop closes on something trivial, then grow the workload.

**Setup:** one disposable repository. One trivial Objective decomposing into 2–3 independent Work
Items (e.g. "add three pure functions, each with tests").

**Run:** author the Objective. Do not intervene.

**Success:** Director compiles the Objective, applies the graph, dispatches parallel GitHub agent
sessions, and every Work Item reaches a merged PR with the Objective closed — unattended.

**If Gate 0 does not close** within a pre-committed budget (proposed: 3 attempts or 4 hours of
active execution), **stop and revise the architecture — do not harden forward.** A gate that will
not close is design feedback. Acting on it immediately is precisely what v1 failed to do for nine days.

---

## 8. Scope ladder

Advance only on a green gate. Never skip.

| Gate | Workload | Proves |
|------|----------|--------|
| 0 | 2–3 independent Work Items | the loop closes at all |
| 1 | dependent Work Items | sequencing and blocked-by handling |
| 2 | 8–10 mixed parallel + dependent | scale, capacity, contention |
| 3 | one real Clockgrove Objective | production viability |

Clockgrove work does not resume before Gate 2 is green.

---

## 9. Package shape

A **single plugin**: Director agent + management skills + schemas + a thin GitHub client.

- Harness-agnostic. No workflows required for the core loop.
- Installation grants no workflow, settings, secret, or activation authority.
- Installable from an exact Git ref by an unrelated adopter.

If any GitHub Actions workflow is required for the *core loop*, that contradicts §2 and must be
recorded as a finding against the thesis.

---

## 10. Completion

Factory v2 ships when:

- **Gate 2 is green** — the loop closes unattended on parallel + dependent work.
- The plugin **installs cleanly into a fresh repository** from an exact ref by an unrelated adopter.
- It is **open-source ready** — public repo, documented install/upgrade/uninstall, LICENSE and
  CONTRIBUTING, no private dependencies, no Clockgrove-specific hardcoding.
- **We are using it** to build Clockgrove.

Completion is **not** measured by open-issue count, generation number, release count, or
qualification runs.

---

## 11. v1 asset disposition

Clean-room: nothing is copied. v1 is readable as reference only.

| v1 asset | Disposition |
|---|---|
| 8 management skills + Director agent | **Reference.** The reasoning is sound; the packaging is not. Rewrite clean. |
| `objective_plan.py`, `objective_compilation.py` | **Reference.** The Objective → Work Item compiler is the core product. |
| `native_graph.py` | **Reference.** Graph application to Issues/sub-issues/dependencies is needed; 2,021 lines is not. |
| `work_packet.py` | **Reference.** Becomes the prompt compiler (§6). |
| Schemas | **Reference.** v1 had ~65; keep only those that earn their place. |
| `clockgrove_orchestrator.py`, `execution_scheduler.py`, `graph_application_runtime.py`, `routing_transition.py`, permit protocol, terminal routers | **Discard.** Artifacts of Inversion A. |
| `copilot_sdk_execution.py` + SDK session/receipt pipeline | **Discard.** Artifact of Inversion B. |
| 46 GitHub Actions workflows | **Discard.** §9 forbids workflows in the core loop. |
| `clockgrove/factory-controller` | **Discard.** See below. |

### factory-controller

A private repository that independently approves Factory releases *"so a Factory candidate cannot
approve itself."* It fetches an exact Factory commit read-only, validates package and syntax,
evaluates behavior once through hosted Copilot, and **cryptographically signs** the approval record.
Factory pins the accepted controller SHA, tag, and public key, with revocation lists.

The invariant is real — a behavior change should not govern its own review. The implementation is
disproportionate, and it is **disqualifying for an open-source product**:

- **GitHub already provides the mechanism.** `pull_request_target` runs the workflow definition from
  the **base branch** — the previously accepted rules — against the candidate's code. That is exactly
  the required semantic, combined with branch protection, required reviews, and CODEOWNERS.
- **A private trust root cannot be verified or reproduced by an external adopter**, so the security
  property it claims does not transfer to anyone who installs the plugin.
- It is a second repository, signing key, attestation format, and revocation list to maintain — a
  standing infrastructure cost that contradicts §1.

**Disposition:** discard. Re-express the invariant as branch protection + `pull_request_target` +
required review. If a concrete attack is later demonstrated against that, record it as a measured
finding per F7 *before* building anything.

---

## 12. Measured platform capabilities

Recorded per F7: measured limits, not desiderata. Probe **PROBE-001**, `clockgrove/factory-probe-parallel`,
2026-08-30, 12 issues across 2 waves.

| Capability | Measured |
|---|---|
| Agent assignable via API | ✅ `copilot-swe-agent` (`BOT_kgDOC9w8XQ`) via `replaceActorsForAssignable` |
| Concurrent sessions | **8 simultaneous, no ceiling hit.** 8 assigned in 9.6s; 5 briefly queued, all 8 `in_progress` within 40s |
| Assignment → draft PR | 3–7 s |
| Assignment → terminal | ~75–80 s (trivial task) |
| Wall clock, 8 parallel tasks | ~80 s (vs ~10 min serial) |
| Work correctness | 11/11 actionable tasks correct and minimal |
| PR → Issue linkage | ✅ `closingIssuesReferences` correct in 12/12 |
| Self-merge | ❌ never — PRs stay **draft**, issues stay **open** |

### The critical finding: run conclusion is not the outcome signal

**All 8 wave-2 runs reported `conclusion: success` — including a deliberately impossible task.**
The workflow run reports *"the session completed"*, never *"the work was done."*

The agent signalled failure correctly, but **only in the PR**: title `No-op: impossible task — target
file does not exist`, a body explaining the unmet precondition, an **empty diff**, and a single
`Initial plan` commit.

Design consequences:

- **Outcome evaluation must read the pull request** — diff, commits, body — not run status. An
  orchestrator that polls `conclusion` would have marked an impossible task complete.
- **A no-op is machine-detectable**: empty diff + no commit beyond `Initial plan`.
- **The agent self-reports non-actionability rather than failing or hallucinating** — it did not
  invent the missing file. This is the property that makes unattended operation viable, and it is
  why Work Packet preconditions belong in the prompt (§6).
- **Draft + open is the natural handoff point.** GitHub gives the loop an integration decision for
  free, with no permit protocol.

### Burst behavior at 26 concurrent (wave 3)

26 issues assigned in 35 s, including two deliberately targeting the **same file**.

| Outcome | Count |
|---|---|
| Assignments accepted (`Copilot` on issue) | 26 / 26 |
| Agent sessions actually created | **24 / 26** |
| Sessions succeeded | 22 |
| Sessions failed | 2 |
| Correct PRs produced | **22 / 26 (85%)** |
| Peak observed concurrency | **24, no queueing ceiling reached** |

Three distinct degradation modes appeared, and **all three are silent**:

1. **Dispatch loss.** Two issues (`W3-2`, `W3-3`) show `Copilot` as assignee but **never produced a
   session**. Assignment acknowledged, work never started. Nothing in the issue indicates this.
2. **Backend saturation.** Both failures were `[cca-engine] Fatal: Failed to fetch job details:
   HTTP 500`, ~13 s and ~3 s into the run. Infrastructure, not the task.
3. **Empty `[WIP]` PRs.** Each failed session still opened a draft PR with an **empty diff** and a
   `[WIP]` title — indistinguishable by title from real work.
4. **Client-side `429`** on my own polling. The orchestrator will rate-limit itself observing at
   this scale.

**Conflicting writes are safe but not resolved.** Both `shared_hot.py` PRs branched from the same
base (`c2201cac`) and each produced a clean, correct, non-overlapping diff. GitHub isolates them by
branch; the *second merge* is where conflict surfaces. Integration is the loop's problem, not the
agent's — which is the correct place for it.

### Design requirements this imposes

- **Dispatch must be confirmed, not assumed.** Assignment success ≠ session started. The loop must
  verify a session exists and re-dispatch when it does not. This is the one reconciliation duty that
  is genuinely required — v1's instinct was right, its location was wrong.
- **`[WIP]` + empty diff = failed attempt**, and must be retried rather than evaluated.
- **Retry must be safe.** Two of 26 failures were transient infrastructure; retry is the correct
  response, and it must not duplicate work.
- **Budget ~85% first-pass success at burst.** Design for retry as normal, not exceptional.
- **Throttle dispatch and polling.** Both directions rate-limit.

### Verdict

**Gate 0's load-bearing assumption holds, with a bounded caveat.** Cloud-hosted agent sessions are
the execution substrate: parallel to at least 24, fast, correct, honest about non-actionability, and
non-self-merging. Inversion B (#149/#161) discarded a working primitive.

The caveat is that the substrate is **lossy under burst**, so the loop needs exactly three things —
dispatch confirmation, no-op detection, and idempotent retry. That is a small, well-understood
supervisor. It is *not* a permit protocol, a serialization fence, or a terminal router.

---

## 13. Open questions for review

1. ~~Does agent assignment parallelize and report terminal status reliably?~~ **Resolved by
   PROBE-001** (§12): parallelism confirmed to at least 8; terminal status must be read from the PR,
   not the run conclusion.
2. ~~What is the actual concurrency ceiling?~~ **Partially resolved** (§12, wave 3): no queueing
   ceiling to 24 concurrent, but ~85% first-pass success under burst with silent dispatch loss.
   Remaining unknown: whether the ceiling is a hard cap or purely capacity-dependent.
3. **Is a trivial Objective enough to exercise the compiler**, or does decomposition only become
   meaningful at Gate 1+?
4. **What is the harness's unattended story?** A scheduled session restores "no HITL"; confirm the
   intended trigger and whether crash recovery is simply "start a new session and re-read GitHub."
5. **Which harnesses must v1.0 support?** "Any harness" needs a concrete initial target list
   (Copilot CLI first) and a defined portability boundary.
6. **Public from day one, or public at Gate 2?** Building in the open from the start prevents
   private-dependency creep of the `factory-controller` kind.

---

## 14. Immediate actions

1. ~~Stop the running Codex session.~~ **Done** — stopped at `a3e5d83`, 15 commits, nothing in flight.
2. ~~Answer open question 1.~~ **Done** — PROBE-001, §12.
3. **Repo strategy.** ~~Rename `clockgrove/factory` → `clockgrove/factory-legacy`~~ **Done.** Next:
   create a **new** `clockgrove/factory`, public-ready from day one. v1 carried four configured
   environments holding credentials — `copilot`, `copilot-initial-assignment`,
   `copilot-initial-model`, `factory-qualification-consumer` — plus controller trust pins.
   **Do not inherit these implicitly.**
4. **Harvest from `factory-legacy` before it goes cold**: `docs/DIST-002-STANDARD-PACKAGE-BASELINE.md`
   (337-line packaging baseline) and the plugin install/uninstall evidence on
   `codex/factory-package-completion`. The packaging research is sound; only the packaged runtime is
   superseded.
5. **Reset `clockgrove/clockgrove`** to docs-only (keep `docs/`, `.source/`, `assets/`, `BRAND.md`,
   `STYLE.md`, `README.md`, `AGENTS.md`). **Deactivate Factory first** — 12 effect types are still
   live — and capture v1 run IDs as diagnostic evidence.
6. **Close the v1 Clockgrove issues** (#7, #88–#90, #109, #121–#127) as superseded by the
   wave ≠ Objective remodel (F4).
7. **Accept this PRD**, then start Gate 0.
