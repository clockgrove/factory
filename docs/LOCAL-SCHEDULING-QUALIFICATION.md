# Installed local scheduling qualification

`scripts/verify-local-scheduling.mjs` is an explicitly authorized, one-shot installed
regular-PR scheduling exercise. It has deterministic tests, **not a live pass**.
It reuses the namespaced clamp/slugify/two-parent-join Objective, its exact installed
artifact checks, authenticated receipts, original local-only policy, complete-pipeline
serialization, independent validation, immutable PR/merge checks, and fresh merged tests.

The additional scope is deliberately narrow:

- A temporary **Director leaf service cgroup** initially has `CPUQuota=50%` (0.5 CPU).
  Factory's sampler observes that leaf; the default reserved headroom leaves no
  worker admission capacity. The harness independently binds the actual process,
  executable, checkout, boot, service invocation, cgroup, and `cpu.max`, and waits
  for authenticated local-capacity/pressure/cooldown queue receipts for both roots.
  This measures admission under a constrained Director; worker scopes are separate
  units and this is **not** evidence of worker throttling or whole-host stress.
- While there are no admitted workers, one native subissue-order mutation moves the
  second root ahead of the first. Exact issue database/node identities and order are
  read back. The first eventual reservation must record the promoted root's native
  position. This tests GitHub's native priority input, not `factory_priority` commands.
- A second installed MCP service makes one identical foreground `factory_run` call.
  It must be refused by the existing **outer repository-controller lease**, with the
  same authenticated controller ID, epoch, and policy around that refusal. This is
  not an inner Objective Director CAS race or a multi-computer controller test.
- After those observations, the harness rechecks zero admissions and changes only
  the captured primary service's cap to `CPUQuota=400%` (4 CPUs). Every reservation
  must follow that barrier and record a fresh 4-CPU resource measurement. The
  original two-worker/two-attempt policy is unchanged. Regular delivery still
  serializes complete Work Item pipelines through integration.

## Explicit invocation

The coordinator must first grant exclusive use of a private disposable repository;
do not run beside another fixture or repository controller. Use a clean checkout in
the Linux filesystem and a committed harness candidate whose bundle inventory equals
the installed plugin. Linux with a working systemd user manager and cgroup v2 is
required, including when Linux is hosted by WSL2 or macOS. No service is installed or
enabled permanently. No memory allocation/load generator, cloud route, model change,
native-head update, or host-wide setting is part of the exercise.

```bash
export FACTORY_LIVE_LOCAL_SCHEDULING=1
export FACTORY_LIVE_OBJECTIVE_REPOSITORY=example/disposable
export FACTORY_LIVE_OBJECTIVE_CHECKOUT=/home/USER/Codex/disposable
export FACTORY_LIVE_OBJECTIVE_NAMESPACE=scheduling-unique-20260905-a
export FACTORY_LIVE_OBJECTIVE_MAX_MODEL_TOKENS=500000
export FACTORY_LIVE_OBJECTIVE_EVIDENCE=/home/USER/private-evidence/scheduling-unique-20260905-a

FACTORY_LIVE_OBJECTIVE_PREFLIGHT=1 node scripts/verify-local-scheduling.mjs
```

Preflight checks existing repository/installed prerequisites and writes only private
local evidence; it does not prove that the service can launch or that scheduling works.
Before the separately authorized execution, unset `FACTORY_LIVE_OBJECTIVE_PREFLIGHT`:

```bash
export FACTORY_LIVE_OBJECTIVE=1
export FACTORY_LIVE_OBJECTIVE_MUTATION_ACK=example/disposable
export FACTORY_LIVE_LOCAL_SCHEDULING_ACK=example/disposable:owned-cpu-priority-contention
node scripts/verify-local-scheduling.mjs
```

Leave delivery unset or `regular-prs`, and the backend selector unset or `local-default`.
The default native qualifier is unchanged. The initial token threshold must remain
250,000–500,000 observed tokens, with the existing 45-minute Objective/two-attempt
limits and zero paid backends. It is a stop-before-next-call threshold, not a provider
hard cap. There is no allowance increase or automatic reinjection.

The existing local `gh auth` and Codex login must be usable from their normal Linux
home. The service runs the exact installed bundled MCP server using `env -i` with
computed HOME/USER, nonsecret PATH/CODEX_HOME, and the local user-bus paths. It never
copies GitHub/model secrets into systemd properties or command arguments. Unlike a
regular parent process, it cannot rely on an inherited `GITHUB_TOKEN` or `GH_TOKEN`;
the installed server resolves its existing local authentication itself. Paths with
spaces or shell expansions are rejected by this bounded qualifier.

## Bounds, evidence, and failure handling

`qualification-preflight.json` and `objective-evidence.json` are private; the output
directory must be current-user-owned mode `0700`, and files use `0600`. Start with a
new owned directory and a new namespace. The executable captures exact source and
installed inventory identities, foreground request, service birth identities, raw
authenticated receipt identities, priority readbacks, lease commits, post-release
admission counters, and collected-resource observations. Do not publish raw evidence.

The initial barrier has at most 48 mechanical ten-second waits. Priority readback has
at most six two-second waits. The contender is invoked once with a 60-second response
bound. Systemctl calls are bounded to 15 seconds, with at most ten 200-ms readbacks
after a single stop. API pages, receipt counts, commit reads, and recorded worker scope
identities are bounded. None of these loops invokes a model to decide what to do.

Immediately before each cap change or stop, the harness independently verifies its
captured service's exact unit, InvocationID, process birth, executable, checkout,
boot, and cgroup. It never uses broad unit patterns or kills unrelated processes.
On success, the explicitly refused contender is stopped; after completion the exact
recorded worker/validation scopes must be absent and the primary service is stopped
and observed collected. The shared qualifier then tests the fresh merged default tree.

An uncertain original call, missing authentication, changed service incarnation,
unexpected admission, unknown cleanup, or failed contender refusal is incomplete.
The harness does not repeat the model run, reorder mutation, contender call, CPU
release, or stop to hide an uncertain response. It retains the last captured identities
and fixed failure diagnostic. It does **not** automatically stop a possibly active
original run after failure: inspect authenticated GitHub state and the exact owned
units before choosing normal Factory cancellation or controlled cleanup. Never reuse
the failed Objective or original evidence file as a fresh injection.

Only a completed executable result and fresh merged tests qualify this subset. A pure
assessor or synthetic transcript is not live evidence. Native stack concurrency,
native-unavailable fallback, abrupt crashes, durable controller discovery/takeover,
paid providers, and resource-pressure recovery beyond this exact CPU observation
remain separate gates.

## Primary platform contracts

GitHub documents [reprioritizing a subissue](https://docs.github.com/en/rest/issues/sub-issues#reprioritize-sub-issue)
as `PATCH /repos/{owner}/{repo}/issues/{issue_number}/sub_issues/priority`, using the
numeric `sub_issue_id` and either `before_id` or `after_id`. The harness pins the
existing `2026-03-10` API header and makes no inferred issue-field mutation.

The systemd 259 primary manuals define the
[transient service, pipe/wait, and environment-expansion options](https://github.com/systemd/systemd/blob/v259/man/systemd-run.xml),
[CPUQuota units](https://github.com/systemd/systemd/blob/v259/man/systemd.resource-control.xml),
and [user-manager execution environment](https://github.com/systemd/systemd/blob/v259/man/systemd.exec.xml).
The concrete contracts are used with exact observed service identity; their presence
in documentation is not evidence that this installed scenario has run successfully.
