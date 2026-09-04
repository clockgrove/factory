# ADR 0006 — Hosted coordination is a separate product boundary

Date: 2026-09-03

Status: accepted

## Context

A hosted coordinator could wake independently of a laptop and offer managed cloud capacity, but
making it part of the open-source execution path would add an account, service, queue, privacy
surface, and cost dependency that contradict Factory's local-first purpose.

## Decision

The open-source Factory product requires only an Agent Plugins-compatible host, one local checkout,
GitHub, and an explicitly started local controller. It has no required Clockgrove account, hosted
endpoint, private database, queue, telemetry service, or GitHub workflow.

Any hosted MCP/coordinator would be a separate product with its own threat model, authentication,
privacy, billing, and availability contracts. It could reuse the public protocol but cannot become
authoritative for local runs. This repository makes no hosted-product roadmap or availability
commitment.

## Consequences

- Provider-neutral records and adapters remain public extension points.
- Open-source installation and operation are testable without Clockgrove infrastructure.
- Hosted-specific abstractions do not enter the critical path before the local release is complete.
- Any optional outbound local-worker bridge requires explicit authorization and a separate design.
