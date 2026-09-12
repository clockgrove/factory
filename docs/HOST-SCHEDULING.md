# Optional host scheduling

`factory run ... --until-terminal` is the scheduler while it is running. It owns the Objective lease,
mechanically polls GitHub, launches ready Work Items, and continues through dependency waves without
another model call for unchanged state.

A plugin cannot start a stopped process or wake a powered-off host. Operators who want recovery after
login or reboot can explicitly configure their operating system to restart the same command. Factory
does not install or enable a daemon during plugin installation.

## Supported environment boundary

Factory's runtime target is Linux. The same `systemd` lifecycle applies in three supported host
configurations:

- native Linux;
- a Linux distribution under Windows WSL2; and
- a Linux VM or equivalent Linux guest hosted by macOS.

In every case, run the controller, Git, Node.js, Codex SDK/CLI runtime, and validation tools inside
Linux. Keep the repository, worktrees, Factory state, sockets, and locks on the Linux filesystem. On WSL2 this
means a path such as `/home/alice/src/project`, not `/mnt/c/...`; Windows tools can still access it
through `\\wsl$`. On macOS, the Linux guest must provide the repository filesystem and `systemd`
user session rather than delegating lifecycle management to `launchd`.

Native Win32 and native Darwin execution and lifecycle management are out of scope. Factory does
not install Windows services, Task Scheduler entries, or `launchd` agents.

## Resource observation boundary

Local admission samples the process's visible cgroup ancestry, including its mount root, at the
standard Linux v2 mount and supported v1 CPU/memory mounts. CPU capacity is the minimum of host
parallelism and applicable quota/period limits. Memory capacity and free headroom are the minimum
of host observations and each applicable ancestor's limit and remaining capacity; the usage ratio
is the maximum observed ratio. Each limit is paired with that same ancestor's aggregate usage,
including sibling charges. A zero usage counter or zero-byte limit is not an unlimited sentinel.

This follows the kernel's [v2 hierarchy rules](https://docs.kernel.org/admin-guide/cgroup-v2.html#what-is-cgroup)
and [CPU bandwidth hierarchy](https://docs.kernel.org/scheduler/sched-bwc.html#hierarchical-considerations).
For [legacy v1 memory accounting](https://docs.kernel.org/5.10/admin-guide/cgroup-v1/memory.html#hierarchy-support),
an ancestor limit applies only when its `memory.use_hierarchy` is observed as enabled; a leaf's own
limit always applies. Unknown hierarchy settings, malformed values, permission-denied reads and
incomplete constrained observations make the sample unavailable. Root-only v2 memory usage without
a limit is accounting telemetry, not a finite constraint. CPU and memory controllers are inspected
independently, including on hybrid v1/v2 hosts; the existing source field prefers v2 when both versions
contribute finite constraints.

Observation is read-only and bounded to 64 levels per hierarchy, 4 KiB membership paths and 64 KiB
per kernel file. It never walks above the visible mount root or into sibling directories. Missing
applicable cgroups fall back to host measurements. Nonstandard mount layouts and ancestors hidden
by a cgroup namespace or mount are not discovered; their limits or usage cannot be inferred from
this sample. Values are sampled across separate reads, not an atomic allocation guarantee, and v1
usage counters can be approximate. This component behavior does not qualify the full live scheduling
matrix or authorize changing host limits.

## Linux with systemd

Factory's explicit repository-service lifecycle creates one deterministic user unit per checkout.
It never runs during plugin installation and never stores scheduler state. The managed command is:

```text
factory controller run OWNER/REPO --repo /absolute/path/to/repository
```

The running process generates one controller identity and acquires the checkout's repository lease
under that identity for discovery leadership only. Every Objective has its own fenced lease epoch;
normal mutations never recheck the service lease. Independent foreground sessions can run alongside
the service and after its failure, subject to shared atomic capacity reservations. A restarted service
must reacquire leadership, but unrelated Objectives do not wait for that election. The unit name, PID,
or an in-memory queue is never used as durable ownership evidence.

The service's admission ceiling defaults to eight local workers and zero paid workers, shared across
the Objectives it starts. This is not a per-Objective adaptive default: a new run defaults to fixed concurrency
capped at two local workers, and physical headroom can narrow that further, including to zero.
Explicit adaptive policies retain their selected ceilings. Controller ceilings are configurable
through `--max-local-workers N` and `--max-paid-workers N`; the latter only permits capacity and never
supplies the separate immutable run-policy provider or budget authority.

Independent foreground sessions also use the durable repository capacity ledger. Its initial
capacity-only ceiling is eight local and eight paid slots; this does not authorize any paid launch,
and an unpaid run cannot use those paid slots. Explicit service worker-ceiling flags atomically
configure the corresponding repository ceiling while retaining outstanding claims. Unspecified
ceilings remain unchanged, and a later foreground session cannot widen an existing ceiling.

Lifecycle operations are deliberately idempotent: `install` atomically writes the unit, reloads
systemd and enables it; `start`, `stop`, `restart`, and `status` operate on that same deterministic
name; `uninstall` stops and disables it before removing the unit and reloading systemd. A successful
uninstall reports both `installed=false` and `enabled=false`.

The unit starts with a Factory ownership marker. Installation refuses to overwrite an existing unit
at the deterministic path unless that marker is present. It records both the absolute Node runtime
and shipped `dist/factory.js` path plus the Factory artifact's exact SHA-256 identity, so startup
never relies on a login shell or silently accepts changed bytes at the same path.

The generated unit is equivalent to:

```ini
[Unit]
Description=Clockgrove Factory repository controller for OWNER/REPO
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/absolute/path/to/repository
# FactoryExecutableIdentity=sha256:...
ExecStart=/absolute/path/to/node /absolute/path/to/installed/dist/factory.js controller run OWNER/REPO --repo /absolute/path/to/repository --executable-identity sha256:...
Restart=on-failure
RestartPreventExitStatus=2 65 70 72 78 130 203
RestartSec=30
TimeoutStopSec=90
KillMode=control-group

[Install]
WantedBy=default.target
```

Then inspect and enable it deliberately:

```bash
systemd-analyze --user verify ~/.config/systemd/user/factory-objective.service
systemctl --user daemon-reload
systemctl --user enable --now factory-objective.service
```

Use absolute paths. Confirm that the service account can read the repository, the policy file, the
Codex login, and the `gh` login. Do not put tokens in the unit. On WSL, systemd must already be enabled
for the distribution, and Windows must start that distribution before its user services can run.
For a Linux guest on macOS, the guest must likewise be running before its user service can start.

`Restart=on-failure` restarts unexpected process crashes and signals. Fatal controller exits are a
different contract: durable-state incompatibility (65), internal invariant (70), discovery failure
(72), local configuration (78), and launcher execution failure (203) trip the service fuse and do
not automatically restart. `controller status` and `doctor` return the exact executable identity,
restart count, fuse state, last safe diagnostic code, and recovery action without requiring journal
access. The fatal log line contains a stable fingerprint keyed by artifact identity but never the raw
exception, provider headers, response body, token, or Objective content.

Correct the reported condition, reinstall when the artifact identity changed, then explicitly start
or restart the unit. That operator action re-evaluates a tripped controller. Never replace bytes or
restart merely to pick up an upgrade while active work or resource cleanup is unresolved; drain and
confirm the owned generation first. Factory reconstructs active state from GitHub after a restart;
the unit does not carry orchestration authority.

An Objective snapshot can temporarily lag the repository shared-capacity journal after cleanup.
If it reconstructs an exactly matching released claim, Factory checks at most three complete
Objective snapshots before making further snapshot-dependent decisions. It does not resurrect the
claim or relax owner, policy, resource or lease checks. Already-admitted work retains its existing
execution and accounting fences. Persistent lag reports `SharedCapacitySnapshotLagError` and parks
that activation without replacing the Objective's terminal cause. Discovery changes alone do not
restart it; a new explicit activation or controller restart re-evaluates the durable evidence.

## Stopping versus cancelling

Stopping the service interrupts the local process. To record an operator cancellation that another
Supervisor will also honor, use the durable cancellation command first:

```bash
node /absolute/path/to/installed/factory/dist/factory.js cancel OWNER/REPO#123 --reason "operator request"
```

Then allow the active Supervisor to observe the request and exit. If it is unavailable, the next
Supervisor observes the cancellation receipt before resuming work.

Host-native wrappers may start the supported Linux environment, but they are outside Factory's
service contract. Once Linux is running, `systemd` owns the Factory controller lifecycle.
