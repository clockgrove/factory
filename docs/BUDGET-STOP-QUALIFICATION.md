# Installed observed budget-stop qualification

`scripts/verify-budget-stop.mjs` is one explicit **negative** qualification. Its
deterministic tests are not a live pass. It uses the same fresh, namespaced
clamp/slugify/two-parent-join Objective and exact installed plugin checks, but it
intentionally authorizes only **one observed model token initially**. The regular
local SDK/CLI policy otherwise retains two workers, two attempts, 45 minutes, and
zero paid backends. This does not relax the happy/scheduling qualifiers' separate
250,000–500,000 token guard and never changes an existing run's allowance.

The threshold is stop-before-next-call accounting, **not a provider hard token cap**.
One ordinary successful compiler call is expected to overshoot it. The qualifier
requires real input/output counters whose sum equals its positive budget receipt;
it never substitutes an estimate, zero, or the configured threshold for actual use.
For cost context only, an earlier three-item SDK fixture compiler reported 15,542
tokens. This new scenario is expected to make **one compiler call, zero workers,
zero semantic reviews, and zero cloud calls**; the actual receipt determines cost.

## What passes

1. The captured foreground request and authenticated run start bind the exact
   initial negative policy, repository, actor, and fresh Objective. No activation
   receipt, successor, or terminal revival is manufactured.
2. Authenticated `GraphCompiled`/`GraphProjected` receipts name the same three-item
   graph at the preflight base. Exactly one Objective-scoped compiler usage receipt
   is known, positive, and above the initial threshold. Status must agree with its
   counters and the configured one-token allowance.
3. Two mechanical observations at least ten seconds apart show both ready roots
   blocked by `budget-exhausted`, with **no attempt or capacity admission and no
   outstanding native resource reservations**. A final fresh read repeats these
   checks immediately before cancellation.
4. Only then does the installed MCP surface receive one normal `factory_cancel`
   request with a captured stable request ID. The authentic cancelled run contains
   no workers, validators, PRs, additional model calls, or changed budget authority.
5. The exact captured installed-MCP service is stopped and observed absent. A fresh
   GitHub read confirms the recorded default branch still equals the original base.

This establishes **observed budget refusal followed by no-worker cancellation**.
It is not active-worker cancellation, failed-validation recovery, an autonomous
budget-specific terminal escalation, or successful Objective delivery. Current
ordinary-run budget exhaustion remains queued; the explicit no-worker cancellation
avoids waiting for the 45-minute Objective timeout. There are no merged-artifact
tests because no implementation or PR is permitted. Other qualifiers retain their
original mandatory fresh merged-tree and behavior checks.

## Explicit invocation

First coordinate exclusive access to a private disposable repository. Do not run
beside another fixture or repository controller. Use a new namespace, a clean
Linux-filesystem checkout at the current default branch, a committed harness whose
bundle inventory equals the installed plugin, and existing local GitHub/Codex auth.
Linux with systemd user services and cgroup v2 is required. The exact temporary MCP
service uses an observed 4-CPU quota; it does not throttle or start workers.

```bash
export FACTORY_LIVE_BUDGET_STOP=1
export FACTORY_LIVE_OBJECTIVE_REPOSITORY=example/disposable
export FACTORY_LIVE_OBJECTIVE_CHECKOUT=/home/USER/Codex/disposable
export FACTORY_LIVE_OBJECTIVE_NAMESPACE=budget-stop-unique-20260905-a
export FACTORY_LIVE_OBJECTIVE_MAX_MODEL_TOKENS=1
export FACTORY_LIVE_OBJECTIVE_EVIDENCE=/home/USER/private-evidence/budget-stop-unique-20260905-a

env -u GH_TOKEN -u GITHUB_TOKEN -u GH_HOST -u GH_CONFIG_DIR -u XDG_CONFIG_HOME \
  PATH=/home/USER/.local/bin:/usr/local/bin:/usr/bin:/bin \
  FACTORY_LIVE_OBJECTIVE_PREFLIGHT=1 node scripts/verify-budget-stop.mjs
```

Preflight is read-only except private local evidence; it does not start the service
or a model. Unset `FACTORY_LIVE_OBJECTIVE_PREFLIGHT` before the separately authorized
execution, and leave delivery/backend overrides unset or regular/local-default:

```bash
export FACTORY_LIVE_OBJECTIVE=1
export FACTORY_LIVE_OBJECTIVE_MUTATION_ACK=example/disposable
export FACTORY_LIVE_BUDGET_STOP_ACK=example/disposable:compile-once-budget-stop-no-worker

env -u GH_TOKEN -u GITHUB_TOKEN -u GH_HOST -u GH_CONFIG_DIR -u XDG_CONFIG_HOME \
  PATH=/home/USER/.local/bin:/usr/local/bin:/usr/bin:/bin \
  node scripts/verify-budget-stop.mjs
```

Adjust the process-only Linux PATH to contain the actual installed `node`, `codex`,
`gh`, `git`, `systemd-run`, and `systemctl`. WSL often inherits Windows directories
containing spaces; this bounded qualifier rejects them. Do not change global PATH
or auth configuration. Both parent and env-cleared service resolve the same normal
Linux-home GitHub configuration. No GitHub/model secret is copied into systemd
properties or command arguments.

## Failure and evidence boundaries

Use a new current-user-owned mode `0700` evidence directory. The shared collector
creates private `qualification-preflight.json` and `objective-evidence.json` files
with mode `0600`. Evidence retains installed/source identities, the exact initial
request, authenticated receipt/comment identities, repeated accounting/status
observations, the fixed cancellation request ID/response, terminal state, and exact
owned-service cleanup. Keep raw evidence private.

The observation loop performs at most 48 ten-second waits; GitHub reads have finite
15-second abort signals. The installed original run is called once. Cancellation
is called once, only after complete known no-worker observations, with no retry on
response loss. Service stop rechecks the exact unit, invocation, process birth,
executable, checkout, boot, and cgroup before one bounded stop/readback sequence.
No provider or model is used for polling or deciding whether the evidence passes.

If a worker/resource is admitted, compiler usage is missing or conflicting, the
original call becomes uncertain, a different terminal appears, or service ownership
changes, the qualifier preserves evidence and **does not automatically cancel or
reinject** the uncertain run. A cancellation-response loss also receives no retry.
Inspect the durable run and exact captured service before choosing normal Factory
cleanup; do not relabel that incomplete exercise as a budget-stop pass.
