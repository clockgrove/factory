# Installed local pressure qualification

`scripts/verify-local-pressure.mjs` adds the separately selected pressure scenario for
[#104](https://github.com/clockgrove/factory/issues/104). It is an implementation, not
a live pass. Execute only after the integrated candidate includes the ancestor sampler
fix [#105](https://github.com/clockgrove/factory/issues/105) and authenticated queue
reason transitions [#106](https://github.com/clockgrove/factory/issues/106), has passed
coordinated checks, and is installed with a matching bundle inventory. The original
[CPU/priority/outer-lease scenario](LOCAL-SCHEDULING-QUALIFICATION.md) and its assessment
are unchanged. Neither scenario substitutes for the other's acceptance.

The installed foreground Director runs in a fresh nonce/artifact/repository-bound
service, inside a uniquely named disposable slice. The slice has a 4 GiB memory
limit, zero swap and a four-CPU quota. A separately owned service inside that slice
allocates and touches 3.5 GiB of actual anonymous memory. Its kernel memory limit is
3.75 GiB, swap limit zero, CPU quota 25% of one CPU and task limit 32. Its executable
is the committed standalone allocator; it has no model/GitHub credentials and makes
no network calls. It writes no Factory receipts or resource samples.

The pressure helper exits after 90 seconds independently of the qualification
observer. `systemd` additionally enforces `RuntimeMaxSec=120s`, `Restart=no` and a
two-second stop timeout, with whole-control-group cleanup. It allocates in 64 MiB
steps, checking a 128 MiB parent margin and at least 2 GiB of free host memory before
each step and every second while holding memory. Before launch, the observer requires
6 GiB of **MemFree**, at least 6 GiB spare in every visible finite nonfixture ancestor,
at least four CPUs through the visible quota hierarchy, and a disposable slice
baseline of at most 256 MiB. Missing/unsafe prerequisites are a refused intervention.
No host settings, existing slices, unrelated processes, or cloud services are changed.

These bounds follow the kernel's hierarchical limits and actual aggregate
`memory.current` semantics. `memory.max` is an OOM containment boundary, not a promise
that allocation cannot fail or briefly exceed that limit. The extra headroom guards
are deliberate prerequisites; exhausting a hard limit is an incomplete qualification,
never a pressure pass. See the [kernel cgroup v2 contract](https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html)
and upstream [systemd resource controls](https://raw.githubusercontent.com/systemd/systemd/main/man/systemd.resource-control.xml),
[service lifetime controls](https://raw.githubusercontent.com/systemd/systemd/main/man/systemd.service.xml),
and [transient service/slice selection](https://raw.githubusercontent.com/systemd/systemd/main/man/systemd-run.xml),
checked during implementation on 2026-09-05. The rendered systemd man site returned
403, so the upstream manual XML was used as the primary source.

## What the original run must prove

The initial accepted policy retains regular PR delivery, the original local backend
selection, model profile, token threshold, two-attempt limits and zero cloud authority.
Only its **initial** `capacity.local.admissionCooldownSeconds` is 120. The ordinary
installed Supervisor waits 60 seconds when no workers are active; the existing CPU
fixture's ten-second cooldown cannot produce a cooldown observation in that loop.
The 120-second value is recorded in `FactoryRunStarted` before any injection and
remains immutable throughout the same run.

The Director starts with its ordinary 0.5-CPU admission barrier. After the real graph
and both queued roots appear with no reservations/attempts, the harness launches its
bounded pressure service once. It independently captures `/proc/meminfo`, load,
Director affinity, each visible cgroup's CPU quota/usage, memory limits/current/events,
and the owned helper's service/process incarnation. The measured parent ratio must
exceed the accepted ceiling, the helper's actual charge must reach the allocation
target, and an authenticated new `local-pressure` receipt must explicitly identify
memory pressure. A `local-capacity` or load-only reason is insufficient.

The exact helper is stopped and observed absent, and the same Director's CPU quota
is released to four. The original policy is not changed. A subsequent authenticated
`local-cooldown` decision must carry its actual deadline. Every implementation
reservation must follow that decision, use a resource sample at/after that deadline
and helper absence, show safe memory/load/headroom, and still be attempt one. Missing
cooldown visibility, a stale sample, premature admission, or an uncertain observation
leaves the case incomplete. Receipt timestamps are server observations; local kernel
samples are separately timestamped and are not atomic with GitHub reads.
The readmission observer has a four-minute wall-clock window from CPU release: the
accepted two-minute cooldown plus two ordinary one-minute idle intervals for admission
and durable visibility. This extends observation only, not run policy, resource lifetime
or execution authority; timeout never triggers another launch or pressure injection.

The same original Objective must then deliver through the shared installed regular
runner's independent validation, exact PR/head/tree/merge proof and fresh merged-tree
tests. Every execution and validation reservation must retain its exact owned scope
batch; all those scopes, the helper, the Director and the disposable slice must be
independently absent. Only the exact captured runtime slice overrides are reverted,
after their paths/content identities still match and the slice is empty. This uses
the documented [systemctl runtime property/revert contract](https://raw.githubusercontent.com/systemd/systemd/main/man/systemctl.xml).

## Explicit invocation

First obtain exclusive use of a private disposable repository and a fresh namespace
and private evidence directory. Use the same committed installed-artifact prerequisites,
authentication, Linux-only paths and environment clearing as the original scheduling
qualifier. Preflight does not allocate memory, create services, or claim runtime support:

```bash
export FACTORY_LIVE_LOCAL_PRESSURE=1
export FACTORY_LIVE_OBJECTIVE_REPOSITORY=example/disposable
export FACTORY_LIVE_OBJECTIVE_CHECKOUT=/home/USER/Codex/disposable
export FACTORY_LIVE_OBJECTIVE_NAMESPACE=pressure-unique-20260905-a
export FACTORY_LIVE_OBJECTIVE_MAX_MODEL_TOKENS=500000
export FACTORY_LIVE_OBJECTIVE_EVIDENCE=/home/USER/private-evidence/pressure-unique-20260905-a
env -u GH_TOKEN -u GITHUB_TOKEN -u GH_HOST -u GH_CONFIG_DIR -u XDG_CONFIG_HOME \
  PATH=/home/USER/.local/bin:/usr/local/bin:/usr/bin:/bin \
  FACTORY_LIVE_OBJECTIVE_PREFLIGHT=1 node scripts/verify-local-pressure.mjs
```

After separately authorizing execution, leave the preflight flag unset and use:

```bash
export FACTORY_LIVE_OBJECTIVE=1
export FACTORY_LIVE_OBJECTIVE_MUTATION_ACK=example/disposable
export FACTORY_LIVE_LOCAL_PRESSURE_ACK=example/disposable:owned-memory-pressure-cooldown-readmission
env -u GH_TOKEN -u GITHUB_TOKEN -u GH_HOST -u GH_CONFIG_DIR -u XDG_CONFIG_HOME \
  PATH=/home/USER/.local/bin:/usr/local/bin:/usr/bin:/bin \
  node scripts/verify-local-pressure.mjs
```

Do not also select `FACTORY_LIVE_LOCAL_SCHEDULING`. No failure causes automatic
reinjection, another Objective, token-limit changes or history repair. An uncertain
launch is reobserved only to stop its exact owned helper, never to launch again.
Changed artifact/process identity revokes injection authority and preserves the
original private evidence. A failed cleanup remains unverified; inspect the exact
recorded units and original authenticated history before an authorized recovery.
The helper's independent deadlines continue even if the observer loses its connection.
The Director has a separate 50-minute service lifetime bound; failure does not
automatically raise its CPU cap or claim that reserved worker scopes were cleaned.

This case qualifies bounded aggregate memory headroom, actual pressure/cooldown gates,
safe readmission and resource discharge on the observed host. It does not establish
fairness/starvation behavior, other hosts, an inner Director CAS race, phase recovery,
CPU starvation, kernel PSI-trigger behavior, hidden ancestors, nonstandard mounts,
or atomically sampled host/ancestor limits. The allocator cannot make inaccessible
ancestor evidence available. A prerequisite refusal is documented as such rather
than replaced by host-wide load, fake telemetry or simulated runtime receipts.
