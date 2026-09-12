# Agent operating rules

These rules govern AI contributors building Factory, not the workers Factory runs for adopters.

Use [`docs/DESIGN.md`](docs/DESIGN.md) for the product contract,
[Factory Project](https://github.com/orgs/clockgrove/projects/1) for current priorities and status,
[`CONTRIBUTING.md`](CONTRIBUTING.md) for contributor setup and PR expectations, and
[`docs/CONFORMANCE.md`](docs/CONFORMANCE.md#release-verification-procedure) for release procedures.
GitHub and the repository are the source of truth; conversation history is not.

The Factory Project owns scheduling through Status and Priority. Issues own concrete problems,
scope, acceptance, dependencies and evidence; PRs own implementation and review. Add each work
issue to the Project once and update its fields when work starts, blocks, is deferred or finishes.
Do not maintain #69, release issues, Project descriptions or repository documents as duplicate
status boards. See [CONTRIBUTING.md](CONTRIBUTING.md#tracking-work) for field meanings.
Repository documents retain contracts, procedures and historical evidence. Distinguish implemented,
integrated and qualified in the relevant issue's evidence, not additional tracking fields.

## Pragmatic solutions for every coding task

Apply this policy to planning, implementation, debugging, refactoring, and review. Choose the
simplest solution that fully satisfies current requirements and preserves correctness. Added
complexity needs evidence of a present need; hypothetical future value is not sufficient.

- Start with the concrete outcome, observed failure, and supported behavior. Do not turn imagined
  consumers, future providers, or unlikely failure combinations into acceptance requirements.
- Before adding machinery, consider removing the behavior causing the problem, retaining less data,
  using an existing facility, or expressing the solution directly. Fix the cause rather than adding
  layers to manage its side effects.
- Prefer fewer moving parts, state transitions, sources of truth, dependencies, and side effects.
  The smallest diff is not always the simplest design; deleting unnecessary machinery may be better.
- Reuse established patterns when they fit. New abstractions, extension points, configuration flags,
  compatibility layers, fallback chains, retries, recovery protocols, and persistent state must
  serve a current requirement or demonstrated failure, not flexibility or future-proofing alone.
- Keep authoritative data in its existing source of truth and retain only what current consumers
  need. Do not build duplicate stores, replay bundles, sidecars, or synchronization mechanisms
  without a current requirement. The resolution in [#322](https://github.com/clockgrove/factory/issues/322)
  illustrates this: validate full Git objects transiently and save compact receipts instead of a
  second durable copy of GitHub state.
- Before choosing a materially more complex design, identify what the simpler alternative cannot
  satisfy and account for the added operational and maintenance costs. If no concrete requirement
  rules out the simpler design, choose it. A brief explanation is enough; routine edits do not need
  a design document or another approval step.
- Preserve required authorization, security, data integrity, and supported behavior. Simplicity
  does not justify weakening validation, suppressing errors, or ignoring a demonstrated defect.
- Stop when the accepted outcome and relevant checks pass. Keep adjacent cleanup and speculative
  hardening out of the task unless necessary for its outcome.

## Mission: trunk, branches, leaves

Finish Factory in this order:

1. **Trunk:** the ordinary end-to-end path—Objective compilation, dependency-ready Work Items,
   local execution, validation, PR delivery, integration, accounting, cleanup, and terminal outcome.
2. **Branches:** promised differentiators—concurrency and scheduling, durable sessions, large files,
   provider routes, and failure/conflict safety.
3. **Leaves:** compounded outages, unusual multi-generation recovery, rare transport combinations,
   extra hardening, and non-critical polish.

Do not use issue age, issue count, test count, sunk cost, or the latest failure as a proxy for
priority. A defect blocks the current phase only when it prevents that phase's ordinary primary
acceptance scenario. Keep lower-tier requirements visible without promoting them to the critical
path.

Pilot readiness and full release qualification are separate milestones. Never silently drop a
release requirement, but do not make an unrelated release leaf block an earlier milestone.

## Architecture oversight

Do not let the agent that diagnosed an incident become the sole author and reviewer of the problem
framing. Before implementation, obtain a fresh-context architecture review when any of these are
true:

- the change crosses three or more architectural layers, such as compilation, supervision,
  scheduling, execution, validation, delivery, accounting, or recovery;
- a provider, framework, language, package manager, or other concrete technology would enter shared
  orchestration state or interfaces;
- one incident-specific exception must be propagated through multiple modules;
- repeated failures provide concrete evidence that an earlier abstraction or invariant is wrong; or
- the user explicitly requests an architecture review.

Words such as "permanent" or "end-to-end" do not alone require a redesign or an architecture review.
Use the actual scope and evidence above to decide.

The reviewer must receive the failure evidence and product contracts without first inheriting the
implementer's proposed solution. It must:

1. state the concrete outcome, supported behavior, and failure evidence;
2. challenge assumptions, including whether the problematic mechanism is necessary at all;
3. compare the simplest viable approach, including deletion or reuse, with any proposed additional
   machinery and its side effects;
4. check affected supported technologies and lifecycle paths without inventing requirements for
   hypothetical consumers or unsupported capabilities;
5. justify each added abstraction, state record, fallback, or recovery path with a current need; and
6. preserve established architectural boundaries without demanding generality for its own sake.

The implementer must reconcile the review before editing and briefly record the choice and any
material tradeoff in the PR, issue, or applicable decision record. Architecture findings must cite
concrete supported-path failures, violated contracts, or specific maintenance or operational costs.
Apply the blocker/follow-up definitions below; "not general enough" is insufficient. Revisit the
architecture review if the integrated diff materially changes the chosen design or reveals new
boundary violations. Otherwise, use ordinary diff review. Favor the least complex complete solution,
even when removing the faulty mechanism changes more lines than patching around it.

## Bound review loops

Freeze the PR's acceptance surface before its initial full-diff review. It consists of the linked
issue's accepted outcome, repository contracts that the change touches, and regressions introduced
by the proposed diff. Adjacent hardening, cleaner abstractions, and newly imagined failure
combinations remain valuable findings, but they do not silently expand that surface.

Use at most three substantive review rounds for one PR: the initial consolidated review followed by
no more than two repair-and-rereview rounds. A substantive round reviews a distinct candidate across
the declared acceptance surface; comment clarification and verification of an already reported fix
do not create another round. Reviewers must inspect the whole relevant diff and batch their findings
by invariant or root cause instead of serially revealing one adjacent instance per round.

Classify every finding when it is raised:

- **Blocker:** a P0/P1 defect, a failure of the declared acceptance criteria, a security or data-loss
  defect on a supported path, or a violation of a non-negotiable boundary in this file or
  [`docs/DESIGN.md`](docs/DESIGN.md).
- **Follow-up:** P2/P3 hardening, a compounded or unlikely failure outside the declared acceptance
  surface, an adjacent architectural improvement, or work assigned to another milestone.

At the third-round boundary, stop automatic full-diff review. Record each remaining finding in the
PR as resolved, an accepted risk, or a linked follow-up issue with an owner and acceptance boundary.
A follow-up is not silent debt and must not be described as implemented. If a genuine blocker
remains, the PR is not mergeable; the owner may authorize one bounded blocker-only repair and focused
verification, but that exception does not reopen the entire diff or admit adjacent scope. If the
blocker shows the accepted design itself is wrong, stop and redesign or replace the PR rather than
continuing an unbounded patch-and-review loop.

Run focused checks during repair rounds. Run the coordinated release gate only on the intended final
candidate, and rerun it only when that candidate changes as described under **Verify proportionally**.
Before merge, state the exact reviewed head, review-round count, unresolved follow-ups, and explicitly
accepted risks.

## Code Review Rules

### Simplicity and scope

- Challenge unnecessary machinery and duplicated state as well as correctness defects. State the
  concrete cost and a simpler viable alternative; do not demand cosmetic rewrites.
- Requests for more generality, resilience, or coverage must identify a current requirement or a
  concrete failure on a supported path. Imagined future cases do not block the accepted task.
- Apply the declared acceptance surface and review-round limits to every review pass below.

### Exhaustive review pass

- Review the complete pull-request diff and all materially affected call paths before finishing.
- Do not stop after identifying the first valid finding.
- Continue reviewing the remaining diff after every finding.
- Report all independent P0/P1 findings discovered in the same review pass.
- Before completing the review, make a second pass for correctness, invariant violations, race
  conditions, stale-state handling, error paths, compatibility regressions, and fail-closed behavior.
- Do not suppress a later finding merely because an earlier finding may require changes to the same
  code.

## When something fails

- Preserve the original failure and exact source, artifact, run, and accounting identities.
- Classify it immediately as a trunk blocker, branch blocker, or leaf.
- Before extending a failing recovery or exception path, consider whether simplifying or removing
  the mechanism would eliminate the failure while preserving the required behavior.
- Fix genuine blockers and add a regression for the concrete defect.
- Attempt recovery at most once when it is the shortest path to current acceptance, unless recovery
  itself is the capability being qualified.
- If recovery reveals a compounded failure, track it and return to the primary path. A qualification
  fixture must not become the roadmap.
- Reuse completed work when it advances current acceptance. Do not rescue a damaged run indefinitely
  to avoid sunk cost or create cleaner evidence.
- Missing accounting remains unknown. Never infer zero usage, duplicate uncertain model work, revive
  terminal runs, or bypass replacement/resource fences.

## Deliver capabilities

- Use one branch and PR per complete, testable capability; keep helper commits inside that batch.
- Run independent capabilities in parallel with explicit ownership. Serialize only real dependencies
  and overlapping edits. Do not create work merely to occupy agents.
- Track all remaining work in ordinary GitHub issues using the repository's established labels.
  Classification describes the work; it does not determine priority.
- After every PR or failed live run, reassess the critical path using trunk, branch, and leaf priority.
- Report capabilities completed, what remains, the critical path, and required decisions. Commits,
  tests, agents, and recovered runs are evidence, not progress measures.

## Verify proportionally

- Declare each candidate's capability set, owner and acceptance before qualification. Finish that
  batch; admit additional work only for a demonstrated acceptance blocker or non-negotiable safety
  violation. Retain other requirements in their milestone issues instead of expanding the batch.
- Before a code PR merges, check the proposed integrated tree with typecheck, changed-file checks
  and affected interface regressions. Restore broken main promptly; do not make unrelated lanes
  inherit known integration failures while waiting for a release candidate.
- During implementation, use focused checks and captured platform contracts when they reduce risk.
  Add a regression for each concrete defect.
- For instruction-only or documentation-only changes, check the diff, links, and applicable
  formatting. Runtime suites, builds, and installed qualification are required only when the changed
  behavior or documented procedure needs them; editing contributor guidance is not a release gate.
- Do not repeatedly run broad suites, packaging, plugin reinstalls, or live qualification between
  intermediate fixes.
- At a stable candidate boundary, freeze the candidate and run the release gates in
  [`docs/CONFORMANCE.md`](docs/CONFORMANCE.md#release-verification-procedure). Fix failures and rerun
  affected checks first; repeat broad gates only at the next stable boundary.
- Build and install the exact passing artifact once per stable candidate. Installed qualification
  must use that artifact, not a mutable worktree or handwritten MCP configuration.
- Evidence proves only its exact candidate, host, and scenario. Never relabel it more broadly.
- Mechanically preflight qualification fixture provenance, real validation recipes, dependencies
  and evidence identities before model-backed runs. Share compatible scenario evidence across
  issues; separate ordinary throughput cases from fault injection.

## Non-negotiable boundaries

- Follow the architecture in [`docs/DESIGN.md`](docs/DESIGN.md). Ask before changing product scope,
  architecture, authorization, spending, or correctness boundaries.
- Production GitHub access in `src/` uses Octokit and shared rate-limit controls. Runtime state comes
  from authenticated GitHub evidence, not reconstructable sidecar state.
- Honor primary resets and secondary retry delays. Never retry through an open circuit.
- Never bypass permissions, branch protection, leases, resource ownership, destructive-action
  guards, accounting fences, provider limits, or spending authority.
- Unsupported provider behavior is a documented boundary, not simulated success or a blocker for
  unrelated local work.
- Work on branches, never directly on `main`. Preserve unrelated user changes and avoid destructive
  Git or filesystem operations.
- Agents may merge reviewed Factory PRs after applicable acceptance and required checks pass. Merge
  only the exact reviewed head, never bypass protection, then verify the intended tree on `main`.
  This does not authorize package publication, provider spend, production activation, or mutations
  in other repositories.

## Resume efficiently

On resume, read the active task, `git status`, recent `git log`, the Project's Now view and the
relevant issue and PR. If Project access is unavailable, continue authorized work and report the
specific tracking update that remains; do not create a replacement status board.
Identify the current trunk, branches, and leaves before acting. Continue the highest-impact authorized
deliverable without replanning settled work. Keep tool output narrow and use parallel agents for
genuinely independent outcomes—not as a measure of progress.
