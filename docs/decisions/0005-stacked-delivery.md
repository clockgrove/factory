# ADR 0005 — Native stacks for linear code dependencies

Date: 2026-09-03

Status: accepted behind capability probing

## Context

Independent Work Items should remain independently reviewable, while a linear chain whose code is a
real input to later work benefits from stacked pull requests. A dependency DAG cannot always be
represented by a single stack, and GitHub's stack surface is versioned public-preview behavior.

## Decision

Use native GitHub stacked pull requests for maximal linear code-dependency chains when capability
probing succeeds. Independent work publishes sibling pull requests. Multi-parent joins wait for
their parents to merge and start a new stack from trunk. Publication receipts bind stack identity,
position, parent, base, head, and capability version.

The delivery adapter is isolated from the scheduler. A run records whether unavailable stack support
falls back to regular pull requests or escalates; it never changes an already-published topology.

## Consequences

- Lower-layer changes invalidate and revalidate affected higher heads.
- Stack mutation and integration occur under a repository fence.
- Unknown or changed GitHub behavior fails closed.
- Existing runs retain their recorded regular-pull-request behavior.
