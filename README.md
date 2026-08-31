# Clockgrove Factory

A GitHub-native engineering-management plugin. You author an **Objective**; Factory compiles it into
**Work Items**, dispatches them to parallel GitHub Copilot agent sessions, supervises the results,
and replans — unattended.

> **Status: in implementation.** The PRD is accepted and build order steps 1–6 are complete — Factory
> can derive the full state of an Objective from GitHub alone, dispatch/confirm/retry/escalate Work
> Items against a real repo, mechanically classify a PR's outcome (no-op, declined, untouched,
> conflict, checks), integrate a mechanically-ready PR (mark ready, merge, resolve or reject a
> conflict) back through the same retry/escalate machinery, compile a human-authored Objective into a
> validated Work Item graph (`skills/objective-compilation/SKILL.md`,
> `schemas/objective.schema.json`, `schemas/work-item.schema.json`), and apply that graph to GitHub as
> sub-issues plus native `blocked by` edges (`src/graph.ts`), through the same
> breaker/pacer/concurrency discipline as dispatch. Step 4's live proof (actually merging a PR and
> watching its issue auto-close, per §9) is deferred to Gate 0's full-loop rehearsal rather than run
> standalone, to avoid a second live-GitHub pass over the same code path.
> See [`docs/PRD.md`](docs/PRD.md) and [`docs/IMPLEMENTATION-PLAN.md`](docs/IMPLEMENTATION-PLAN.md).

## Design in one picture

```
  Objective (human)
        │
        ▼
  ┌─────────────────────────────┐
  │  Factory — runs in the      │   the loop lives in the agent harness,
  │  agent harness              │   not in GitHub Actions
  │                             │
  │  compile → dispatch →       │
  │  supervise → replan         │
  └─────────────────────────────┘
        │                ▲
        │ Issues,        │ PRs, diffs,
        │ assignment     │ terminal state
        ▼                │
  ┌─────────────────────────────┐
  │  GitHub                     │   durable state + execution substrate
  │  Issues · Copilot sessions  │
  │  Pull Requests              │
  └─────────────────────────────┘
```

Two constraints shape everything:

1. **No deployed infrastructure.** No database, queue, dashboard, or service. GitHub holds the
   durable state; the harness holds the loop.
2. **Harness- and model-agnostic.** Packaged as an [Agent Plugins 1.0](https://agent-plugins.org)
   package — an open, vendor-neutral standard — targeting Codex, GitHub Copilot, and Claude Code
   with no architectural primacy for any. Factory selects no model anywhere.

### Derived state

Factory stores nothing. Every Work Item's state is a pure function of what GitHub currently says:

| Concept | GitHub primitive |
|---|---|
| Objective | Issue labelled `factory:objective` |
| Work Item | **sub-issue** of the Objective |
| Dependency | native **`blocked by`** relationship |
| Assignment | `copilot-swe-agent` as assignee |
| Attempt | a linked pull request |
| Completion | PR merged → issue closed |

There is no status label, no sidecar file, and no lease. Nothing stored can go stale or diverge,
crash recovery is free, and "resume" and "start" are the same code path.

## Try it

Read-only. Prints the derived state of an Objective and exits.

```bash
npm install && npm run build
GITHUB_TOKEN=$(gh auth token) node dist/factory.js owner/repo 42
```

## Why this design starts from a clean slate

An earlier attempt at this same idea inverted both halves of this design: it put the orchestration
loop *inside* CI, and moved work execution *out* of GitHub onto self-hosted infrastructure. Those two
choices compounded, producing a large amount of distributed-systems machinery — reconciliation,
recovery, ownership takeover — to recreate guarantees the platform already offers, and no product
code was ever shipped by it.

This is a clean-room rewrite, not an evolution of that codebase. Rationale in [`docs/PRD.md`](docs/PRD.md) §3.

## Measured platform evidence

Before writing any code, the load-bearing assumption was tested directly
([`docs/PROBE-001-agent-parallelism.md`](docs/PROBE-001-agent-parallelism.md)):

| | Measured |
|---|---|
| Concurrent agent sessions | **24, no queueing ceiling reached** |
| 8 parallel tasks, wall clock | ~80 s (vs ~10 min serial) |
| First-pass success at burst (26) | **85%** |
| Work correctness | 11/11 actionable tasks correct and minimal |
| Terminal status | **must be read from the PR, not the run conclusion** |
| Throttle planes | **3, only 1 visible to `/rate_limit`** |

The last two rows are the important ones. A workflow run reports that the *session finished*, never
that the *work was done* — an impossible task returned `conclusion: success`. And GitHub will refuse
requests with `403 API rate limit exceeded` while `/rate_limit` reports full quota, so platform
refusal must never be mistaken for work failure.

## License

TBD before public release.
