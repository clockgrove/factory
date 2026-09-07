# Agent operating rules

These rules govern AI contributors building Factory, not the workers Factory runs for adopters.

Use [`docs/DESIGN.md`](docs/DESIGN.md) for the product contract,
[`docs/COMPLETION.md`](docs/COMPLETION.md) for current capability status, and
[`CONTRIBUTING.md`](CONTRIBUTING.md) for detailed procedures. GitHub and the repository are the
source of truth; conversation history is not.

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

On resume, read the active goal, `git status`, recent `git log`, and relevant completion-board entries.
Identify the current trunk, branches, and leaves before acting. Continue the highest-impact authorized
deliverable without replanning settled work. Keep tool output narrow and use parallel agents for
genuinely independent outcomes—not as a measure of progress.
