# ADR 0005 — Native stacks for linear code dependencies

Date: 2026-09-03

Status: accepted behind capability probing

## Context

Independent Work Items should remain independently reviewable, while a linear chain whose code is a
real input to later work benefits from stacked pull requests. A dependency DAG cannot always be
represented by a single stack, and GitHub's stack surface is a versioned external API whose behavior
must be capability-probed and qualified live.

## Decision

Use native GitHub stacked pull requests for maximal linear code-dependency chains when capability
probing succeeds. Independent work publishes sibling pull requests. Multi-parent joins wait for
their parents to merge and start a new stack from trunk. Publication receipts bind stack identity,
position, parent, base, head, and capability version.

The delivery adapter is isolated from the scheduler. A run records whether unavailable stack support
falls back to regular pull requests or escalates; it never changes an already-published topology.
The versioned adapter is pinned to GitHub API version `2026-03-10`, creates and reads stacks through
the Stacks REST API, and integrates them only through the exact-head asynchronous merge API.
Native-stack mode retains dependency-ready execution concurrency and uses cascading revalidation to
keep higher layers sound. The regular-PR mode and fallback instead admit one complete Work Item
pipeline at a time because ordinary sibling pull requests have no equivalent cascade.

## Consequences

- Lower-layer changes invalidate and revalidate affected higher heads.
- Stack mutation and integration occur under a repository fence.
- Pending merge UUIDs and partial terminal effects are reconstructed from GitHub and durable issue
  events; response loss cannot authorize a different head or topology.
- GitHub documents no REST endpoint for triggering a cascading stack rebase. Factory observes the
  resulting base/head chain and fails closed within the Objective deadline rather than inventing an
  undocumented mutation.
- Unknown or changed GitHub behavior fails closed.
- Existing runs retain their recorded regular-pull-request behavior.
