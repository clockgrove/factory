# ADR 0008 — Codex SDK as the default local worker

Date: 2026-09-04

Status: accepted

## Context

Factory needs a supported, programmatic local worker boundary for unattended operation. The Codex
CLI established the Linux security and execution baseline, but parsing and supervising a CLI is a
lower-level integration than the official TypeScript SDK. Codex App Server exposes richer client
protocols but remains a Labs integration and is not required for job automation.

## Decision

Prefer `codex-sdk/local-worktree` in the default backend order and retain
`codex-cli/local-worktree` as the supported portable fallback. Both run in an exact-SHA worktree and
receive the same Work Packet, isolated Codex home, sanitized environment, approval policy, network
rules, output schema, cancellation boundary, artifact collection, validation, and cleanup contract.

Factory owns admission, GitHub state, budgets, publication, and integration regardless of which
local adapter executes the work. The SDK backend does not gain Director tools or GitHub write
credentials and does not make local thread state authoritative.

## Consequences

- `DEFAULT_RUN_POLICY.backendOrder` lists the SDK before the CLI fallback.
- Package and backend conformance include the pinned `@openai/codex-sdk` dependency.
- The same Linux environment matrix exercises both local routes.
- SDK unavailability may select the CLI fallback without selecting paid compute.
- Codex App Server remains Labs and is not part of the supported local fallback chain.

## Reference

- [OpenAI Codex SDK](https://developers.openai.com/codex/sdk)

