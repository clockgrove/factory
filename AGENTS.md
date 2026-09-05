# Agent operating rules

Contributor rules for AI agents building Factory. These are not instructions for the agents that
Factory runs for adopters. [`docs/DESIGN.md`](docs/DESIGN.md) defines the product;
[`CONTRIBUTING.md`](CONTRIBUTING.md) covers development procedures and workflow evaluation.

## Orientation

- **`docs/DESIGN.md`** — goals, scope, non-goals, the loop, evaluation and integration rules, the
  confidence bar, packaging, and stated limitations. Read it before changing behavior.
- **`docs/PLATFORM-BEHAVIOR.md`** — the measured platform behavior the design rests on.
- **GitHub is the source of truth for status**, not this file and not session state. Reconstruct
  where things stand from `git log`, the code, and `origin/main` rather than assuming prior-session
  memory is accurate.

## Standing engineering discipline

These are settled. Do not relitigate them.

- **TypeScript/Node**, ESM, bundled to `dist/factory.js` and `dist/mcp-server.js` via esbuild with
  Octokit included. No install step is assumed at plugin-install time.
- **Octokit only.** No raw `fetch`/`axios`/`gh`-CLI calls anywhere in `src/`.
- **State is derived, never stored.** No sidecar files, counters, or status labels representing state
  a fresh read of GitHub can reconstruct. The labels `factory:objective` and `factory:work-item` are
  structural identity, not state.
- **Rate-limit discipline is mandatory.** Every GitHub write goes through `platform.ts`'s
  `CircuitBreaker`, `ContentCreationPacer`, and `ConcurrencyLimiter`. Never burst writes; never retry
  through an open circuit. A `403` alongside `5000/5000` on `/rate_limit` is the documented secondary
  limit, not a bug.
- **Verify platform claims live** against current documentation (docs.github.com, agent-plugins.org,
  modelcontextprotocol.io, npm) before writing code that depends on them. Never infer a mutation or
  field shape from training data — schemas change.
- **This applies to behavioral claims most of all.** A wrong field name looks like something you
  might misremember, so it prompts a check; a belief about how GitHub or the coding agent *behaves*
  looks like background knowledge and never triggers one. If a design rests on what something *will
  do* rather than what shape it returns, go and measure it. Being fully typechecked and tested does
  not make a wrong behavioral premise right.
- **A documented flow nobody has executed is an untested claim.** Prose is the only part of a release
  with no CI, and `npm run verify:package` does not cover it — it starts the committed bundle, which
  is strictly weaker than "a real CLI can install this". If you touch install, upgrade, or uninstall
  instructions, run them against the published artifact before claiming they work.
- **Work on a branch and open a pull request.** Do not push directly to `main`. Single, deliberate
  pushes, never bursts, and confirm what landed with `git fetch origin main` plus a SHA comparison.
- **Exercise Factory through the installed plugin**, not a hand-written MCP config pointing at a
  local worktree and not hand-copied skills. A local bundle tests something no adopter will ever run,
  and a worktree can change underneath a live run.

## Complete the authorized development task

- Carry implementation requests through the agreed acceptance criteria, required verification, and
  PR handoff. Resolve routine engineering choices from repository evidence and record consequential
  assumptions. A review or status request alone does not authorize implementation.
- Ask when a missing decision materially changes scope, architecture, authorization, spending, or
  correctness. Complete independent authorized work first. If blocked, identify the concrete missing
  decision or evidence; cite the instruction when a rule causes the stop. Do not bypass permissions,
  settled product boundaries, or required checks to keep moving.
- After each PR, compare delivered outcomes with the active goal, identify remaining acceptance
  gaps, and choose the next substantial authorized deliverable. Recalibrate when evidence changes;
  do not repeatedly replan settled work or expand the goal without authority.

## Capability-sized delivery

- Use **one PR per complete, testable capability**, with acceptance criteria spanning its end-to-end
  behavior. Helper modules, intermediate plumbing, and individual Work Items belong in that batch;
  do not turn each into a separate PR or stack layer merely because it can be committed independently.
- Use parallel subagents for bounded independent work and incremental commits inside the capability's
  integration branch. Keep file ownership explicit and integrate their work before the PR handoff.
- Optimize time to the overall goal by running independent capabilities concurrently, not only
  subtasks within one capability. Give each capability an owner, isolated worktree, and end-to-end
  acceptance criteria. Keep available agents on the highest-impact unblocked work within authorized
  budgets; serialize only genuine dependencies or conflicting changes. One PR per capability does
  not mean one capability at a time.
- Run targeted checks during development. Run the full required integration and release checks at
  the completed batch boundary, and rebuild/reinstall the updated plugin there when the batch changes
  it. Do not repeat full release verification or plugin reinstall after every helper change or commit.
  Repeat affected checks earlier only when changed behavior or a concrete failure invalidates the
  evidence, including installation-specific tests when relevant. Documentation-only batches retain
  their proportional checks; batching never waives required release or live-conformance gates.

## Parallel work and responsiveness

- When the harness permits delegation, delegate bounded independent work when it improves delivery
  time or review quality. Stay within the authorized concurrency and budget limits; trivial tasks
  and overlapping implementation usually do not justify another agent.
- Give each agent an outcome, file ownership, acceptance criteria, relevant context, and a concise
  return format. Keep shared-file edits under one owner. The coordinating agent owns integration
  and checks the returned evidence; do not duplicate an assigned investigation without a reason.
- Use additional Codex sessions as needed for genuinely independent work when a session's agent
  pool would otherwise serialize the project. The user has authorized this coordination pattern;
  each additional session needs an isolated worktree, explicit ownership, a bounded deliverable,
  and a handoff to the integration owner. Respect platform and account limits across sessions.
  Optimize completed capability throughput and quota use, not session count; do not duplicate
  active work, expand scope, or start deferred testing merely to occupy more workers.
- Process delivered user corrections and agent messages before further dependent work. Use the
  harness's supported steering and wait mechanisms. Verify its message-delivery behavior before
  relying on it; do not assume messages require a completed turn or end turns merely as a ritual.
- Keep progress updates concise: completed outcomes, evidence, blockers, and the next action.
  Avoid repeating plans and transcripts. Pause or redirect promptly when the user asks.

## Proportional verification

- During development, run checks targeted to the changed behavior and meaningful regression risks.
  Complete the required integration and release checks at their applicable gates; see
  [`CONTRIBUTING.md`](CONTRIBUTING.md#validate-changes).
- Broaden or repeat checks when relevant changes, failures, or unresolved concerns invalidate the
  existing evidence. Record the checked revision or working-tree state and commands so results can
  be reused only while applicable. Do not repeatedly run the full suite without a concrete reason.
- Verify observable behavior rather than adding tests that merely mirror implementation. This does
  not waive mandatory checks, independent validation, semantic review, or live conformance evidence.

## Cost discipline and context carry

Large tool results can be carried into later requests and increase token usage. Actual cost depends
on the model, caching, reasoning/output usage, harness, and delegated sessions. Use observed usage
when available; context size alone is not a billing formula. Optimize cost and elapsed time per
accepted deliverable without weakening correctness or changing the selected model without authority.

- Keep tool output intentionally small by default: narrow scope first (`view_range`, targeted `rg`
  globs), cap rows/lines (`Select-Object -First`, `LIMIT`), and avoid full-file/full-log dumps
  unless they are required for a decision.
- Prefer precise reads over broad scans. Expand only when the prior slice is insufficient.
- Avoid repeating the same large output in-thread; summarize once, then continue from the summary
  or from deltas.
- Treat sub-agents as context firebreaks for heavy exploration: pass tight prompts and require
  concise, structured returns. Do not paste raw blobs back into the parent session unless necessary.
- Be strict with high-AIU-per-call tools (for example, large task/read-agent outputs): use them
  when they change a decision, not by default.
- Front-load precision early in a session. Early oversized outputs can accumulate carrying cost
  over many downstream requests.

## When resuming after a gap

1. `git log --oneline -15` and read the code to find the real current state.
2. Do not re-decide anything `docs/DESIGN.md` already settles. If evidence suggests a settled decision
   was wrong, say so explicitly and ask — do not silently drift back toward it while acting as though
   you are still following the design.
3. If injected context describes something that does not match this repository's files, trust the
   files and the git history, and flag the mismatch rather than quietly reconciling it.
