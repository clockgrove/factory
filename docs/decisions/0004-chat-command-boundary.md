# ADR 0004 — Chat and MCP submit commands; the controller executes them

Date: 2026-09-03

Status: accepted for the agent-facing release

## Context

Keeping an agent chat turn open for polling is costly, fragile, and incompatible with unattended
operation. Allowing a skill to implement its own scheduler would create a second state machine that
cannot be recovered from GitHub.

## Decision

The Factory skill guides intent and invokes small typed MCP tools. Mutating tools authenticate the
actor and append idempotent durable command events, then return. Read tools reconstruct status,
plans, explanations, and replay from GitHub. The repository controller alone owns long-running
mechanical scheduling and reconciliation.

CLI commands mirror the same application services for diagnostics and service management. They do
not introduce a second protocol or scheduler.

## Consequences

- A successful activation survives the end of the originating chat turn.
- Read-only calls are mutation-free and unchanged-state polling is model-free.
- Every mutating tool needs an idempotency key, accurate MCP annotations, and authenticated actor
  verification.
- The skill may sequence operations but cannot widen authority or bypass controller fencing.
