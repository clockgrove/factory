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

Plugin installation never installs or starts the controller. Service installation is a distinct,
explicit operation, initially implemented as a systemd user service on Linux and WSL.

## Consequences

- A running local controller is the scheduler; GitHub Actions and hosted Factory infrastructure are
  unnecessary.
- GitHub remains the only durable control plane and restart source.
- Repository-wide capacity and integration fences prevent independent Objective loops from racing.
- A powered-off laptop cannot wake itself; host restart integration is explicit and optional.
