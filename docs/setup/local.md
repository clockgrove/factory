# Local runner: start here

[Back to Factory](../../README.md) · [Choose another runner](README.md)

## TL;DR

1. Use a Linux checkout and Linux tools, including under WSL2 or a Linux guest on macOS.
2. Install Factory through your agent client's plugin installer and restart the client. The plugin
   includes Factory's runtime; npm/npx is not required. Check
   [verification status](../CONFORMANCE.md) for current installation limitations.
3. Make a compatible Codex CLI available to that Linux process and authenticate Codex there.
   Authenticate GitHub as the same Linux user with `gh auth login`, or supply a host token.
4. Open your checkout and ask the agent: “Use Factory director to inspect OWNER/REPO#OBJECTIVE
   with checkout /absolute/linux/checkout. Check prerequisites before starting anything.”
5. Review the reported gates, then explicitly authorize execution. Start local-only; no sandbox
   account, cloud key, Factory workflow, or paid-cloud policy is needed.

**Success looks like:** the plugin loads, the local backend reports available, and the exact GitHub
Objective and checkout are accessible. Inspection alone does not start work. Local-only excludes
paid cloud workers, not the cost or quota of your existing model account.

## Before you begin

You need an existing checkout and Objective issue for the inspect example; replace every placeholder.
If you have only an idea, ask the Director to help prepare an Objective first and approve the GitHub
writes separately. Do not substitute the Factory source checkout for the repository you want built.
Keep WSL work under a Linux path such as /home/you/src/project, not /mnt/c.

## Detailed installation and activation

Factory has two distribution artifacts built from the same source: the Agent Plugins package from
`clockgrove/factory` for chat/MCP use, and `@clockgrove/factory` on npm for the `factory` CLI and
repository controller. Installing either artifact runs no lifecycle scripts, changes no repository,
and starts no daemon. Until the npm artifact has passed the published-artifact gate in
[docs/CONFORMANCE.md](../CONFORMANCE.md), use the plugin installation supported by your client or
the source-checkout command below rather than assuming the npm package is available.

Once the npm package is published, the controller installation path will be:

```bash
npm install --global @clockgrove/factory
factory --help
```

Install the plugin using your Agent Plugins-compatible client, then restart the client so its skills
and bundled MCP server are reloaded. Provider SDK code required by shipped adapters is included in
the committed JavaScript bundle. The plugin artifact does not carry a platform-specific Codex
executable: using the default local Codex SDK worker requires a compatible `codex` CLI on `PATH`.
The npm artifact supplies the pinned Codex CLI transitively.

Authenticate GitHub on the host with `gh auth login`, or expose `GITHUB_TOKEN`/`GH_TOKEN` to the
plugin process. Installing the plugin does not install a GitHub Action and does not activate any
repository.

Before adding any sandbox or managed agent, follow [shared provider configuration](configuration.md).
Provider credentials, repository selection, and permission to spend are three separate settings.

In a supported harness, invoke the `director` skill with:

- `OWNER/REPO#OBJECTIVE`
- the absolute local checkout path
- an optional complete run-policy object

For unattended work, the skill checks the host, installs/starts one explicitly authorized
repository controller, and writes a durable `factory_activate` request. The chat can then disconnect;
the controller reconstructs work from GitHub. The authenticated Objective comment—not an in-memory
MCP queue—is the cross-process journal; centralized request-ID semantics make exact duplicate writes
safe after a lost response. For one-shot interactive work, the skill can instead make one long-lived
`factory_run` call. Both modes default to
`codex-sdk/local-worktree`, fall back to `codex-cli/local-worktree`, adapt admission to CPU and memory
headroom up to eight workers, and never use paid compute. The equivalent foreground source-checkout
command is:

```bash
npm ci
npm run build
node dist/factory.js run OWNER/REPO#OBJECTIVE --until-terminal --repo /absolute/repo/path
```

The process survives ordinary worker failures and reconstructs interrupted work from GitHub when
restarted. It cannot wake a powered-off machine. The repository controller provides one fenced
service per checkout. Each running controller has one random identity and repository-lease epoch;
every Objective Supervisor it starts carries that same observation, and restart/takeover establishes
a new fenced identity rather than impersonating the prior process. The service can be installed into
an explicitly authorized host scheduler for login or boot recovery. See
[docs/HOST-SCHEDULING.md](../HOST-SCHEDULING.md) for the supported Linux environment boundary.

Request a fenced cancellation from another shell with:

```bash
node dist/factory.js cancel OWNER/REPO#OBJECTIVE --request-id cancel-001 --reason "operator request"
```

The request is a durable GitHub event. The active Supervisor stops workers, records terminal attempt
and run receipts, and releases the lease; killing a process is not used as the cancellation record.


## Environment and troubleshooting

Factory reads the launching process's credentials, not a repository .env. A working terminal login
is not proof that a desktop client's MCP child or a separate service sees that login. See
[process and credential placement](configuration.md#1-identify-the-process-that-will-execute-the-objective).
For durable execution after chat disconnects, continue with [unattended setup](unattended.md).
For a missing executable/login, check the actual process PATH, Linux user, and CODEX_HOME before
reinstalling the plugin. Never print authentication files to diagnose setup.
