# Installed Linux qualification

Run the same qualification command on native Linux, Windows WSL2, and a Linux guest hosted by
macOS. It installs the staged npm package and plugin into fresh temporary locations, then exercises
their installed entry points and disposable local host resources. It runs no models, paid workers,
GitHub requests, or real Factory controller. It does not publish packages.

```bash
node scripts/verify-portable-qualification.mjs --output /absolute/path/new-evidence.json --host-class wsl2
```

Use `--host-class native-linux` on a native Linux host, or `--host-class macos-linux-guest` inside
the guest. `auto` records detection without a requested class. The output must not already exist.
The runner uses the existing package verifiers and their required Node, npm, Codex CLI, and cached
or publicly downloadable npm dependencies. Set `FACTORY_CODEX_COMMAND` or `FACTORY_NPM_CACHE` only
when those existing verifiers need a specific executable or cache. A working systemd user manager
and readable unified cgroup v2 mount are required for the host component checks. Missing host
capabilities produce incomplete evidence; native Windows and macOS are unsupported runtimes.

The command temporarily installs and enables one generated Factory service for a unique disposable
checkout, verifies its definition and idempotent installation, then uninstalls it. It never starts
that controller. Separately, a uniquely named transient service starts the installed CLI's
`--version` command and a synthetic Node workload. That service is limited to 25% of one CPU,
384 MiB memory, 64 tasks, and 20 seconds per invocation with a maximum of three starts. The runner
observes cgroup CPU throttling and memory use, crashes only that disposable service's main process,
checks that restart changes its generation and removes its old detached descendant, then stops it
and independently verifies process and cgroup cleanup. It never signals an existing controller.

Evidence contains installed bundle hashes, version, installation source, classified host facts,
numeric resource measurements, and bounded result codes. It excludes raw subprocess logs,
credentials, machine IDs, user paths, PIDs, and service names. Every artifact is checked against its
installed bundle inventory; npm and plugin results must agree on the exact version and bundle bytes.
The plugin verifier requires one enabled installed receipt from the isolated Codex home and executes
that exact cache path. A marketplace listing or the staged plugin source cannot satisfy that check.
Exit codes are 0 for this component scope passing, 1 for a failed check, and 2 for incomplete scope.

Passing these checks does **not** close the Linux host matrix or publication gates. The report keeps
those gates open. Each physical host still needs the installed default SDK route and CLI fallback
through real Factory implementation, clean validation, adaptive admission under pressure, durable
cancellation, and GitHub-fenced restart. Use the separately authorized live Objective harness for
those cases; this runner cannot grant model, GitHub, or paid-provider authority.

The [recorded WSL2 component run](release-evidence/portable-host-component-2026-09-05.json) passed
both staged installation paths, disposable host checks, and batch-boundary release verification.
It identifies the exact executable subjects and distinguishes its two staged tarballs; it is not
published-distribution or full Factory Objective evidence.

A Linux guest cannot reliably identify its physical host operating system from its architecture or
virtualization vendor. A requested macOS guest label therefore remains an unverified claim until
external host provenance accompanies that host's evidence. A WSL2 result cannot satisfy native Linux
or macOS guest coverage. Staged tarball and local-marketplace installation evidence also cannot
substitute for the published artifact's clean-install gate.

The runner uses the documented [npm local package installation](https://docs.npmjs.com/cli/v11/commands/npm-install/)
and [Codex plugin testing boundary](https://learn.chatgpt.com/docs/plugins).
Its host probes use [systemd transient services](https://raw.githubusercontent.com/systemd/systemd/v259/man/systemd-run.xml)
and [cgroup resource limits](https://raw.githubusercontent.com/systemd/systemd/v259/man/systemd.resource-control.xml).
These references establish the interfaces; a recorded live run establishes only the observations on
its actual host.
