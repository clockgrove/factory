# Clockgrove Factory

A GitHub-native engineering-management plugin. You author an **Objective**; Factory compiles it into
**Work Items**, dispatches them to parallel GitHub Copilot agent sessions, supervises the results,
and replans — unattended.

> **Status: pre-implementation.** This repository currently contains a PRD awaiting acceptance and
> the measured platform evidence behind it. No implementation has started. See
> [`docs/PRD.md`](docs/PRD.md).

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
2. **Harness-agnostic.** Packaged as an agent plugin, not as GitHub Actions workflows.

## Why this repository is new

A prior implementation (`clockgrove/factory-legacy`, archived) inverted both halves of this design:
it put the orchestration loop *inside* GitHub Actions, and moved work execution *out* of GitHub onto
self-hosted runners. Those two inversions produced ~1.7 MB of distributed-systems machinery — permit
protocols, serialization fences, terminal routers — to recreate guarantees the platform already
offers, and no product code was ever shipped by it.

This is a clean-room rewrite. Details and evidence in [`docs/PRD.md`](docs/PRD.md) §3.

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

The last row is the important one: a workflow run reports that the *session finished*, never that
the *work was done*. An impossible task returned `conclusion: success`.

## License

TBD before public release.
