# Security policy

Factory runs coding agents and Git commands against repositories selected by an operator. Treat its configuration, process environment, target repository, and GitHub permissions as security boundaries. Use a disposable repository when evaluating a development build.

## Local harness boundary

Codex, Claude and GitHub Copilot workers run as the operator's OS account, in a worktree Factory owns. Factory keeps its GitHub token and provider credentials out of the worker's environment. Workers never move `HEAD` or publish: Factory commits, pushes and merges.

- **Commands run in a sandbox.** Every command a worker causes (validation, setup and probes, and a Claude or Copilot worker's Validate tool) runs in bubblewrap. The sandbox hides the operator's home, logins and Factory's state, keeps the network off (except the exact dependency install, when configured), and writes only the checkout and private temporary directories.
- **Codex has its own sandbox.** A Codex worker's shell runs in Codex's sandbox under Factory's permission profile.
- **No settings hooks.** A Claude worker never loads project or local settings, whose hooks would run on the host.
- **No fallback.** A missing login stops the work with the fix; Factory never falls back to another provider.

See [sandbox and security](docs/USER-GUIDE.md#sandbox-and-security) and [CORE.md#Security](docs/CORE.md#security).

The managed workers (OpenAI Agents, Claude Managed Agents) are parked and not live-qualified; see [providers](docs/USER-GUIDE.md#providers).

## Report a vulnerability

Use [private vulnerability reporting](https://github.com/clockgrove/factory/security/advisories/new) for a suspected security issue. Include the affected version or commit, reproduction steps, expected and observed behavior, and potential impact. Do not include live credentials or private repository content. Please allow maintainers time to assess and coordinate a fix before public disclosure.

The maintainers will acknowledge a report and communicate the next steps in the private advisory. Public issues are appropriate for ordinary bugs that do not expose a security concern.

## Supported versions

Factory is pre-1.0 software. No published version is currently designated as a supported line, and no security maintenance or backport policy has been established. Suspected vulnerabilities in published versions can be reported through the private route above.
