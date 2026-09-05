# Installed explicit regular-PR qualification

`scripts/verify-regular-objective.mjs` exercises the existing **explicit regular-PR**
delivery contract. It does not qualify native stacked PRs, native worker concurrency,
automatic fallback when native support is unavailable, controller discovery, or
restart recovery. No live pass is implied by the harness or its deterministic tests.

This is a fresh, foreground, one-shot installed `factory_run` exercise. The captured
tool request is bound to the authenticated run start; foreground execution does not
emit `ActivationRequested`, and this harness never fabricates that receipt. The
Supervisor alone compiles, schedules, validates, publishes, integrates, and closes.

The shared namespaced fixture has exactly three Work Items: independent `clamp` and
`slugify` roots, followed by `describe`, which depends on both. The initial policy
still permits two local workers and two attempts per item, uses the existing SDK/CLI
backends and frontier-model defaults, and forbids all cloud spending. Regular delivery
must nevertheless serialize each complete Work Item pipeline: integration of the
previous item precedes every reservation/start for the next. Merely serializing worker
execution or choosing regular delivery after requesting native does not pass.

## Operator invocation

Coordinate exclusive use of a private disposable repository before execution. Do not
run beside a controller or another qualification. Use a committed candidate with exact
installed bundle-inventory identity, a clean Linux-filesystem checkout tracking that
repository's default branch, and working GitHub/local Codex authentication. Do not
reuse a namespace, existing Objective, or uncertain invocation.

```bash
export FACTORY_LIVE_REGULAR_OBJECTIVE=1
export FACTORY_LIVE_OBJECTIVE_REPOSITORY=OWNER/DISPOSABLE_REPO
export FACTORY_LIVE_OBJECTIVE_CHECKOUT=/home/USER/Codex/disposable-repo
export FACTORY_LIVE_OBJECTIVE_NAMESPACE=regular-unique-20260905-a
export FACTORY_LIVE_OBJECTIVE_MAX_MODEL_TOKENS=500000
export FACTORY_LIVE_OBJECTIVE_EVIDENCE=/home/USER/private-evidence/regular-unique-20260905-a

FACTORY_LIVE_OBJECTIVE_PREFLIGHT=1 node scripts/verify-regular-objective.mjs
```

The output directory is created owner-only; an existing directory must already be
owner-only and owned by the current user. Private JSON evidence files use mode `0600`.
Preflight performs bounded reads and writes only local evidence. Execution requires
both the shared execution opt-in and acknowledgment of the exact disposable repository:

```bash
export FACTORY_LIVE_OBJECTIVE=1
export FACTORY_LIVE_OBJECTIVE_MUTATION_ACK=OWNER/DISPOSABLE_REPO
node scripts/verify-regular-objective.mjs
```

Unset `FACTORY_LIVE_OBJECTIVE_PREFLIGHT` before execution. Leave
`FACTORY_LIVE_OBJECTIVE_DELIVERY` unset or explicitly `regular-prs`; a native selection
is rejected, not changed. The default `verify-live-objective.mjs` continues to require
native delivery and overlapping sibling lifecycles. Without this wrapper's own opt-in,
it performs no credential lookup, controller action, or provider call.

The model-token value must be explicitly within 250,000–500,000. It is an observed
stop-before-next-call threshold, not a provider-enforced hard cap. No timeout, retry,
fallback, or allowance is added after failure. The installed call retains the existing
45-minute Objective and two-attempt limits. An uncertain foreground response is
incomplete and requires inspection; the harness never reinjects it.

## Evidence and limitations

`qualification-preflight.json` records prerequisites. `objective-evidence.json` binds
the namespace, source commit, installed inventory, captured request, authenticated
run/validation/publication/budget receipts, GitHub issue/PR observations, and exact
immutable head/merge commits. Same-sequence independent application and leased
receipts use the shared production-aligned partial-order identity; contradictory
same-identity receipts still fail. Missing usage remains unavailable, never zero.

The qualifier checks every accepted publication's validation digest and exact-head
binding, validates both original head and squash singleton-parent/tree identities,
and requires each next item to build on the preceding integration. Exact commit reads
are bounded (six for the ordinary three-PR success, at most twelve with the original
two-attempt policy). It then clones the current merged default branch, requires the
join's integration SHA, runs all tests, and executes independent fixture behavior
assertions. Only after these checks does the executable save `result: passed`.

The pure completion assessor alone checks captured delivery evidence, not the fresh
clone execution or real provider resource absence. Inspect the top-level executable
result and retained test output for live qualification; never promote a synthetic
transcript or a partial assessor result into a release-wide pass. Keep raw evidence
private and publish only sanitized, accurately scoped conclusions.
