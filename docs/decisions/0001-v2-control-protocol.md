# ADR 0001 — V2 control refs and Codex CLI baseline

Date: 2026-09-03

Status: accepted for control refs and the Codex CLI fallback; default selection superseded by ADR 0008

## Decision

Use custom Git refs for lease and attempt receipts. Create immutable attempt refs with the REST Git
database API. Advance a lease ref with the GraphQL `updateRefs` mutation and an exact `beforeOid` /
`afterOid` compare-and-swap. Do not use REST `updateRef(force: false)` as a fencing primitive for a
custom ref.

Use Codex CLI non-interactively with an isolated configuration surface, `--ephemeral`,
`--ignore-user-config`, `--json`, `--output-schema`, and `--sandbox workspace-write`. Treat local OSS
inference as unavailable until either Ollama or LM Studio is installed and a real probe succeeds.

## Live GitHub evidence

Repository: `clockgrove/factory` at `a2ac7b39f96903691478c38f91f70ae343083d22`.
Temporary refs were deleted after each probe.

- GitHub accepted `refs/factory-conformance/20260903073644/lease` and a separate deterministic
  attempt ref. Both were visible through REST matching-refs and `git ls-remote`.
- A metadata commit using the default-branch tree compared one commit ahead with zero changed files.
  This is suitable as a pre-PR receipt and does not create a meaningless pull request.
- The response exposed a GitHub `Date` header (`Thu, 03 Sep 2026 07:37:02 GMT`) for server-relative
  lease timing.
- Branch rules for `main` were readable; none applied in the probe repository.
- REST `PATCH git/refs` with `force=false` accepted a sibling rewrite on the custom ref. It therefore
  does not provide fencing there and is rejected for lease advancement.
- The same REST operation rejected a sibling rewrite under `refs/heads/` with HTTP 422, but a control
  branch can trigger ordinary push workflows in consumer repositories and is rejected as the
  zero-configuration default.
- GraphQL `updateRefs` with `beforeOid` advanced the custom ref for the winner. A second mutation with
  the stale `beforeOid` failed and the ref remained on the winner SHA. This is the accepted atomic
  compare-and-swap primitive.
- Custom and temporary branch refs created for conformance caused zero workflow runs in this repository;
  custom refs remain the only design that does not depend on consumer workflow filters.

## Live Codex CLI evidence

Version: `codex-cli 0.153.0` on WSL/Linux.

- `codex exec` exposes `--ephemeral`, `--ignore-user-config`, `--ignore-rules`, `--json`,
  `--output-schema`, `--sandbox`, `--profile`, `--oss`, `--local-provider`, `--cd`, and cancellation
  through the parent process.
- A nested ephemeral invocation authenticated through the existing Codex login, emitted JSONL
  `thread.started`, `turn.started`, `item.completed`, and `turn.completed` events, honored a strict
  output schema, and returned `{"ok":true,"message":"conformance passed"}`.
- The successful trivial management call reported 14,045 input tokens and 21 output tokens. This
  validates the plan's requirement that unchanged polling stay mechanical; even tiny model decisions
  have meaningful fixed context cost.
- No `ollama` or `lmstudio` executable was present. The release must not advertise local inference on
  this host.
- An ephemeral invocation still attempted to initialize the host state database and emitted a warning
  when the surrounding app sandbox made it read-only. The run itself succeeded. The backend must keep
  its worker state directory isolated and must not classify this warning as task failure.

## Consequences

- The lease store must expose compare-and-swap, not merely fast-forward update.
- Every mutating Supervisor boundary checks the exact lease ref OID and fencing epoch.
- Attempt refs are immutable and never renewed.
- A fallback control branch is not enabled automatically; inability to use GraphQL `updateRefs`
  blocks v2 activation rather than silently weakening single-Director safety.
- Codex CLI remains a supported fallback inside native Linux, Windows WSL2, or a Linux guest hosted
  by macOS. ADR 0008 makes the official Codex SDK the preferred programmatic route. Additional
  clients remain Labs until their full execution and interruption probes pass.
