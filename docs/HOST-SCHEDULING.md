# Optional host scheduling

`factory run ... --until-terminal` is the scheduler while it is running. It owns the Objective lease,
mechanically polls GitHub, launches ready Work Items, and continues through dependency waves without
another model call for unchanged state.

A plugin cannot start a stopped process or wake a powered-off host. Operators who want recovery after
login or reboot can explicitly configure their operating system to restart the same command. Factory
does not install or enable a daemon during plugin installation.

## Linux and WSL with systemd

Factory's explicit repository-service lifecycle creates one deterministic user unit per checkout.
It never runs during plugin installation and never stores scheduler state. The managed command is:

```text
factory controller run OWNER/REPO --repo /absolute/path/to/repository
```

Lifecycle operations are deliberately idempotent: `install` atomically writes the unit, reloads
systemd and enables it; `start`, `stop`, `restart`, and `status` operate on that same deterministic
name; `uninstall` stops and disables it before removing the unit and reloading systemd. A successful
uninstall reports both `installed=false` and `enabled=false`.

The unit starts with a Factory ownership marker. Installation refuses to overwrite an existing unit
at the deterministic path unless that marker is present. It records both the absolute Node runtime
and shipped `dist/factory.js` path, so startup never relies on a login shell or `PATH`.

The generated unit is equivalent to:

```ini
[Unit]
Description=Clockgrove Factory repository controller for OWNER/REPO
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/absolute/path/to/repository
ExecStart=/absolute/path/to/node /absolute/path/to/installed/dist/factory.js controller run OWNER/REPO --repo /absolute/path/to/repository
Restart=on-failure
RestartPreventExitStatus=2 130
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

`Restart=on-failure` restarts operational crashes. A completed, cancelled, or durably escalated run
is terminal and should not be looped. Factory reconstructs the active run from GitHub after a restart;
the unit does not carry orchestration state.

## Stopping versus cancelling

Stopping the service interrupts the local process. To record an operator cancellation that another
Supervisor will also honor, use the durable cancellation command first:

```bash
node /absolute/path/to/installed/factory/dist/factory.js cancel OWNER/REPO#123 --reason "operator request"
```

Then allow the active Supervisor to observe the request and exit. If it is unavailable, the next
Supervisor observes the cancellation receipt before resuming work.

Equivalent `launchd` or Windows Task Scheduler entries may run the same long-lived command. Those
platforms are not part of the initial Codex CLI/Linux/WSL conformance claim.
