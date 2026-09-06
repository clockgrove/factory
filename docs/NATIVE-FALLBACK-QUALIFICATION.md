# Installed native-unavailability fallback qualification

`scripts/verify-native-fallback-objective.mjs` supplies the installed qualification path for
[#82](https://github.com/clockgrove/factory/issues/82). Implementation/fixture tests do not pass that
live gate. It reuses the existing three-item `clamp`/`slugify`/dependent-`describe` Objective and
installed `factory_run`, not a fake Supervisor, transport denial, or manually orchestrated Work Items.

## Actual unavailable-capability prerequisite

The initial immutable policy requests `stacked-prs`, with `onUnavailable: regular-prs`. Selecting
regular delivery directly does not exercise fallback. The existing native and explicit-regular
qualifiers keep their original behavior and cannot silently become this scenario.

Preflight uses the same authenticated GitHub transport as the installed invocation to read:

1. The exact private, unarchived disposable repository with push permission.
2. Its pull-request list successfully, establishing access to the Pull Requests read surface.
3. `GET /repos/{owner}/{repo}/stacks`, pinned to `2026-03-10`, returning an actual `404 Not Found`.
4. The same accessible repository again, with unchanged numeric/node identity and permissions.

The [documented stack-list endpoint](https://docs.github.com/en/rest/pulls/stacks#list-pull-request-stacks)
uses Pull Requests read permission and documents 404. This is the narrow repository-surface
unavailability observation recognized by Factory's existing probe, not a claim that every GitHub
404 proves unsupported functionality. The evidence retains exact route/parameters, response URL,
selected API version, request ID, server date, rate balance and bounded identity fields. Credentials,
raw exception messages and arbitrary response bodies are not retained in this additional evidence.

Available native capability, inaccessible repository/PR list, all 403 responses, authentication/SSO
or quota signals, malformed responses, timeouts and unknown failures block the scenario. Every new
read has a 15-second abort signal; there is no retry or setting/permission change to manufacture a
404. If the authorized fixture supports stacks, this case is **not exercised**. A genuinely eligible
authorized disposable repository is an external prerequisite, not permission to modify a repository
or token until the probe fails.

The full observation is repeated before Objective creation. If it changes, no Objective/model call
is started. This does not replace Factory's own subsequent probe: the run must independently record
`DeliverySelected` requesting native delivery, selecting regular delivery, and naming the exact
unsupported-surface reason and API version. A later available/unknown observation or an escalation
cannot pass. The qualifier never injects a receipt or edits the original policy to obtain fallback.

## Existing installed runner recipe

Use the installation, clean Linux-native checkout, dependency-free fixture package, unused namespace,
API quota and exclusive-repository prerequisites in [LIVE-OBJECTIVE-HARNESS.md](LIVE-OBJECTIVE-HARNESS.md).
No other controller/qualification may own the repository. Both installed bundle hashes/inventory must
match the committed qualification candidate. This is a new foreground Objective, not activation,
successor recovery, terminal revival or a retry of an uncertain invocation.

```bash
export CODEX_HOME=/home/USER/.codex
export FACTORY_LIVE_NATIVE_FALLBACK_OBJECTIVE=1
export FACTORY_LIVE_OBJECTIVE_DELIVERY=stacked-prs
export FACTORY_LIVE_OBJECTIVE_REPOSITORY=OWNER/DISPOSABLE_REPO
export FACTORY_LIVE_OBJECTIVE_CHECKOUT=/home/USER/disposable-checkout
export FACTORY_LIVE_OBJECTIVE_NAMESPACE=fallback-new-unused-namespace
export FACTORY_LIVE_OBJECTIVE_MAX_MODEL_TOKENS=250000
export FACTORY_LIVE_OBJECTIVE_EVIDENCE=/home/USER/private-evidence/fallback-new-unused-namespace

FACTORY_LIVE_OBJECTIVE_PREFLIGHT=1 node scripts/verify-native-fallback-objective.mjs
```

If and only if the actual preflight passes and this scenario's model/mutation authority is already
granted, invoke with preflight mode unset and the exact repository acknowledgement:

```bash
env -u FACTORY_LIVE_OBJECTIVE_PREFLIGHT \
  FACTORY_LIVE_OBJECTIVE=1 \
  FACTORY_LIVE_OBJECTIVE_MUTATION_ACK=OWNER/DISPOSABLE_REPO \
  node scripts/verify-native-fallback-objective.mjs
```

Unset other native-refresh/explicit-regular profile selectors. Prior Objective/run IDs are rejected.
The optional plugin-root override must identify the actual installed receipt, never a worktree MCP
override. Preflight and exercise write distinct exclusive private files; existing evidence is not
overwritten. Neither opt-in grants authority on its own. No provider/paid-cloud authority is added.

The original policy allows SDK-first local workers with CLI fallback, two local workers/two attempts
per item, ten-minute items and a 45-minute Objective. Regular fallback must demonstrate overlapping
independent root attempts with serialized, exact-candidate revalidated integration. The initial token
threshold must be 250,000–500,000; it stops later admission, not already-started provider calls.
Unknown interrupted usage remains unknown. All sandbox/session allowances are zero and cloud
fallback is disabled. The example threshold is not a new spending authorization or guaranteed cap.

## Completion boundary

The assessor preserves the original native-requested policy, authenticated actor/run/graph and
delivery selection. It reuses dependency-join completion, actual root overlap, independent
exact-head validation/publication and merge proofs, compilation/worker/review accounting, terminal
closure and zero reservations. It additionally observes **every reserved local execution and
validation scope** on the exact host and checks absence after terminal completion. Missing or
unknown scopes fail; no service identity is synthesized for foreground workers. The shared runner
then verifies delivered tests and independent behavior from the fresh merged checkout.

Failure preserves the original Objective, receipts and partial work. There is no automatic retry,
replacement activation, manual merge or controller action. A pass covers this native-unavailability
to regular-delivery case only, not native stacks themselves, SDK-backend fallback, merge queue,
all resilience/host scenarios or any complete release gate.
