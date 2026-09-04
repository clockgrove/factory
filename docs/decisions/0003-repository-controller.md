# ADR 0003 — One repository-scoped local controller

Date: 2026-09-03

Status: accepted for the local-first release

## Context

An MCP request or chat turn is not a durable scheduler. A developer also needs several active
Objectives to share one laptop's capacity, GitHub pacing, backend limits, and integration boundary
without introducing a hosted queue or database.

## Decision

Run one explicitly installed controller per local repository checkout. The controller discovers
durable activation requests in GitHub, owns a compare-and-swap repository lease, acquires the
narrower Director lease for each Objective, and shares repository-wide capacity across those runs.
The foreground `factory run` command uses the same application services but cannot schedule while a
repository controller owns the lease.

One running process generates one controller ID and acquires one repository-lease epoch. All
Objective Supervisors started by it carry that observation. Restart/takeover creates a new identity
and epoch; unit names, PIDs, process-local queues, and cursors are not ownership evidence.

Application commands cross process boundaries through the Objective's authenticated issue-comment
stream, which is the single atomic request journal. Every transport uses the same semantic
request-ID normalizer. Response-loss retries may append an identical comment, but replay applies
at-least-once duplicates once and rejects conflicting reuse. A parallel Git-commit journal is
rejected because REST-created commit attribution is not a sufficient authenticated actor boundary.

Plugin installation never installs or starts the controller. Service installation is a distinct,
explicit operation, initially implemented as a systemd user service on Linux and WSL.

## Consequences

- A running local controller is the scheduler; GitHub Actions and hosted Factory infrastructure are
  unnecessary.
- GitHub remains the only durable control plane and restart source.
- Concurrent chat, MCP, and CLI writers share one idempotency boundary without private IPC.
- Repository-wide capacity and integration fences prevent independent Objective loops from racing.
- A powered-off laptop cannot wake itself; host restart integration is explicit and optional.
