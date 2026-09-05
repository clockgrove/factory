# Installed pre-projection budget refusal

`scripts/verify-budget-stop.mjs` is an explicit prospective negative qualifier. Its
policy permits one initial observed model token, two local workers, two attempts,
45 minutes and zero paid backends. It does not relax the separate 250,000–500,000
happy/scheduling guards or change an existing run's authority. The original call
runs once through the installed plugin. No cancellation, resume or retry is sent.

The expected boundary is **pre-projection backend refusal**, not a queued worker:

1. Normal compilation persists its immutable graph and compilation receipt.
2. Factory journals the actual compiler input/output usage. One-call overshoot is
   expected: the configured threshold is not a provider hard token limit.
3. Backend preflight observes the exhausted remaining allowance and rejects both
   requested local backends. Factory records its exact budget-related escalation
   before projecting Work Items or writing `GraphCompiled`/`GraphProjected` receipts.
4. The qualifier requires exactly that authenticated terminal, one known compiler
   usage receipt, no Work Items, attempts, validators, PRs or outstanding capacity,
   then exact owned-service absence and a fresh unchanged default-branch read.

The source order is `runDurableCompilationTransaction` followed by
`#preflightCompiledGraph` in `src/supervisor.ts`, with the budget rejection in
`BackendRegistry.select`. Missing graph-event receipts do **not** mean no durable
graph exists. This bounded qualifier leaves that immutable graph **uninspected**;
it does not claim a graph blob/digest was independently verified. It does not
qualify worker execution, active-worker cancellation, queued admission recovery,
failed tests, or full Objective completion. There are no merged-artifact tests
because no worker or implementation artifact is allowed.

## Historical exercise remains incomplete

The earlier queue-and-cancel qualifier at `2668f0b` exited 2 when this earlier
terminal appeared. Its expected repeated queue observations and cancellation were
never exercised; the original result remains failed/incomplete. A separate read-only
assessment may record its authenticated pre-projection budget refusal, known
15,919 compiler tokens (14,460 input and 1,459 output), zero worker admissions and
exact owned-service absence. It must not rewrite the original JSON/log, claim the
corrected prospective qualifier was run, or turn that narrower observation into a
queue/cancellation pass. No reinjection or additional allowance follows this fix.

## Explicit prospective invocation

Coordinate exclusive access to a private disposable repository and use a new
namespace. The checkout must be clean, on the current default branch and on the
Linux filesystem. The committed harness bundle inventory must match the installed
plugin. Existing local GitHub/Codex auth and Linux systemd user services with cgroup
v2 are required. The exact temporary Director service has a 4-CPU quota; it does
not start or throttle workers. One compiler call is expected; actual usage is
required, never estimated or replaced with zero. No new live call is authorized
by this document.

```bash
export FACTORY_LIVE_BUDGET_STOP=1
export FACTORY_LIVE_OBJECTIVE_REPOSITORY=example/disposable
export FACTORY_LIVE_OBJECTIVE_CHECKOUT=/home/USER/Codex/disposable
export FACTORY_LIVE_OBJECTIVE_NAMESPACE=budget-refusal-unique-20260905-a
export FACTORY_LIVE_OBJECTIVE_MAX_MODEL_TOKENS=1
export FACTORY_LIVE_OBJECTIVE_EVIDENCE=/home/USER/private-evidence/budget-refusal-unique-20260905-a

env -u GH_TOKEN -u GITHUB_TOKEN -u GH_HOST -u GH_CONFIG_DIR -u XDG_CONFIG_HOME \
  PATH=/home/USER/.local/bin:/usr/local/bin:/usr/bin:/bin \
  FACTORY_LIVE_OBJECTIVE_PREFLIGHT=1 node scripts/verify-budget-stop.mjs
```

Preflight does not start a service/model or mutate GitHub. For a separately
authorized fresh execution, unset `FACTORY_LIVE_OBJECTIVE_PREFLIGHT` and use the
**new, exact-scope ACK** (the old queue/cancel ACK is rejected):

```bash
export FACTORY_LIVE_OBJECTIVE=1
export FACTORY_LIVE_OBJECTIVE_MUTATION_ACK=example/disposable
export FACTORY_LIVE_BUDGET_STOP_ACK=example/disposable:pre-projection-refusal-no-cancel

env -u GH_TOKEN -u GITHUB_TOKEN -u GH_HOST -u GH_CONFIG_DIR -u XDG_CONFIG_HOME \
  PATH=/home/USER/.local/bin:/usr/local/bin:/usr/bin:/bin \
  node scripts/verify-budget-stop.mjs
```

Adjust the process-only Linux PATH for the actual `node`, `codex`, `gh`, `git`,
`systemd-run` and `systemctl` locations. WSL may import Windows paths with spaces;
the qualifier rejects them. Do not change global PATH/auth. No model/GitHub secret
is copied into systemd properties or command arguments.

## Failure and evidence

Use an owned mode `0700` evidence directory; the shared collector writes private
mode `0600` records. Evidence binds the captured request/checkout/policy, installed
identity, authenticated original start/full usage/terminal envelopes, independent
status, unchanged base and exact service cleanup. GitHub reads use bounded abort
signals. The original installed call is subject to its existing bounded timeout;
it is never retried after uncertainty. The qualifier performs no model-driven
polling and no cancellation fallback.

Unexpected workers, projection, unknown usage, another terminal reason, changed
authority, uncertain service ownership or unknown original outcome fail safely.
Only after the exact no-worker terminal is proven may the exact captured service
be stopped once and observed absent. Preserve uncertain evidence for normal
operator-directed inspection; do not automatically reinject or relabel the run.
