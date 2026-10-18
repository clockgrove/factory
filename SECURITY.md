# Security policy

Factory runs coding agents and Git commands against repositories selected by an operator. Treat its configuration, process environment, target repository, and GitHub permissions as security boundaries. Use a disposable repository when evaluating a development build.

## Local harness boundary

Local Codex, Claude, GitHub Copilot, and registered harnesses run as the developer's OS account. Factory supplies an owned worktree, filters the worker environment, keeps controller publication tokens out of that environment, and requires the harness to leave `HEAD` and all publication operations to the controller. Commands a worker can cause to run on the host (validation, setup, readiness probes, Claude's `Validate` and `run_command` shell) run in a bubblewrap sandbox that hides the developer's home directory, logins and Factory's state, keeps the network off and lets them write only their checkout and private temporary directories; see [command sandbox](docs/USER-GUIDE.md#command-sandbox). Codex workers run in Codex's sandbox. Other harnesses' own tools run as the developer's account. Provider credentials remain in the developer's existing local CLI/profile; Factory configuration and durable run state do not store them. A missing login stops the attempt and requires an explicit external login and retry rather than an interactive detached-worker prompt or provider fallback.

Assigned profile instructions are private additive worker inputs, bound by the accepted configuration digest. They do not confer authority. The optional Claude `factory-worktree-read@1` environment exposes one in-process regular-file reader with exact SDK provenance and runtime inventory checks; it grants no commands, credential configuration, new external destinations or installation. All model tools remain denied until this environment is ready. Each attempt owns its server, and opened file descriptors are checked against that attempt's worktree. Profile membership still authorizes access to the whole worktree and supplied inputs; owned paths are not a read-isolation boundary.

The local-process boundary is documented in [agent harnesses](docs/USER-GUIDE.md#local-providers); remote providers in [remote execution](docs/USER-GUIDE.md#managed-execution).

## Report a vulnerability

Use [private vulnerability reporting](https://github.com/clockgrove/factory/security/advisories/new) for a suspected security issue. Include the affected version or commit, reproduction steps, expected and observed behavior, and potential impact. Do not include live credentials or private repository content. Please allow maintainers time to assess and coordinate a fix before public disclosure.

The maintainers will acknowledge a report and communicate the next steps in the private advisory. Public issues are appropriate for ordinary bugs that do not expose a security concern.

## Supported versions

Factory is pre-1.0 software. No published version is currently designated as a supported line, and no security maintenance or backport policy has been established. Suspected vulnerabilities in published versions can be reported through the private route above.
