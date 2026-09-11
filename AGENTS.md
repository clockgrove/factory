# Agent operating rules

These rules govern AI contributors building Factory, not the workers Factory runs for adopters.

Use [`docs/DESIGN.md`](docs/DESIGN.md) for the product contract,
[GitHub #69](https://github.com/clockgrove/factory/issues/69) for current capability status, and
[`CONTRIBUTING.md`](CONTRIBUTING.md) for detailed procedures. GitHub and the repository are the
source of truth; conversation history is not.

Current project status lives in the body of #69, with linked issues owning detailed acceptance
and evidence. Update that body and affected issue dependencies when a capability changes state;
comments preserve history, not a competing current board. Repository documents retain contracts,
procedures and historical evidence, not a second live status table. Distinguish implemented,
integrated and qualified, and bind qualification to its exact candidate and scenario.

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
- repeated failures suggest that an earlier abstraction or invariant is wrong; or
- the user asks for a holistic, systemic, permanent, or end-to-end fix.

The reviewer must receive the failure evidence and product contracts without first inheriting the
implementer's proposed solution. It must:

1. restate the problem at the domain level without relying on incident-specific nouns;
2. identify material assumptions and actively try to falsify the initial framing;
3. compare at least two plausible designs and their second-order effects;
4. test each design against adjacent technologies, providers, repositories, and lifecycle stages;
5. distinguish a general core contract from adapters and explicitly unsupported capabilities; and
6. reject technology-specific leakage into shared architecture unless the product contract makes
   that technology fundamental.

The implementer must reconcile the review before editing and record the selected model and rejected
alternatives in the issue or applicable decision record. The reviewer has authority to block an
implementation whose concrete regression would pass but whose framing remains overfit. Repeat the
review after the first integrated diff, when names, state, and dependencies reveal abstraction
leakage that was not visible in the proposal. A concrete regression is necessary evidence, not proof
that the architecture is sound. "Smallest complete fix" means the smallest fix to the correct domain
model, not the fewest changed lines.

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

## When something fails

- Preserve the original failure and exact source, artifact, run, and accounting identities.
- Classify it immediately as a trunk blocker, branch blocker, or leaf.
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
- Do not repeatedly run broad suites, packaging, plugin reinstalls, or live qualification between
  intermediate fixes.
- At a stable candidate boundary, freeze the candidate and run the release gates in
  [`CONTRIBUTING.md`](CONTRIBUTING.md). Fix failures and rerun affected checks first; repeat broad
  gates only at the next stable boundary.
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

On resume, read the active goal, `git status`, recent `git log`, the #69 body and linked active issues.
Identify the current trunk, branches, and leaves before acting. Continue the highest-impact authorized
deliverable without replanning settled work. Keep tool output narrow and use parallel agents for
genuinely independent outcomes—not as a measure of progress.
