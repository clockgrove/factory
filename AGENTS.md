# Agent operating rules

Rules for an AI agent working in this repository. [`docs/DESIGN.md`](docs/DESIGN.md) is the source of
truth for what Factory is and why; this file is about how to work on it.

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

## Staying steerable while orchestrating a child session

When driving or monitoring a child session, do not chain long, uninterrupted sequences of your own
tool calls. Cross-session messages, and redirections from the user, are only delivered between turns,
so a long unbroken run of tool calls silently queues them.

- Prefer several short responses over one long one: do a small batch of checks or edits, then let the
  turn end.
- Read what has already arrived before doing more independent verification. Re-deriving status you
  could simply read is a sign your own inbox is unprocessed.
- A human correction should be actionable in your next turn, not stuck behind minutes of self-directed
  work you had already decided to do.

## Cost discipline and context carry

Billing is dominated by carried context, not just by model choice or request count. A large tool
result produced early can be re-read on many later requests, so cost scales roughly with:
`result size × number of later requests`.

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
- Front-load precision early in a session. Early oversized outputs are the most expensive because
  they accumulate carrying cost over many downstream requests.

## When resuming after a gap

1. `git log --oneline -15` and read the code to find the real current state.
2. Do not re-decide anything `docs/DESIGN.md` already settles. If evidence suggests a settled decision
   was wrong, say so explicitly and ask — do not silently drift back toward it while acting as though
   you are still following the design.
3. If injected context describes something that does not match this repository's files, trust the
   files and the git history, and flag the mismatch rather than quietly reconciling it.
