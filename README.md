# <img src="assets/logos/clockgrove-mark.png" alt="Clockgrove logo" width="48" height="48"> Factory

**Turn GitHub issues into tested pull requests with local coding agents.**

Describe what you want to build in a GitHub issue—an **Objective**. Factory breaks it into smaller
tasks called **Work Items**, tracks their dependencies, runs ready tasks in parallel, validates
their results, and integrates accepted changes. You direct the work through Codex chat;
GitHub holds the issues, dependencies, pull requests, and execution records.

Built for indie developers and small teams, Factory runs on your Linux computer. A local controller
keeps work moving while it is running and recovers progress from GitHub after a restart. No Factory
GitHub Actions workflow, hosted service, or database is required.

> [!IMPORTANT]
> **Development preview.** The plugin currently installs from reviewed repository snapshots on
> `main`, not a published release tag. Manifest versions identify development builds; older Git tags
> do not identify the current plugin. The npm CLI/controller is not yet a verified published install
> path. Record your installed commit/version and read the
> [verification status](https://github.com/clockgrove/factory/blob/main/docs/CONFORMANCE.md)
> before authorizing unattended work.

## Install and activate

<a id="tldr"></a>

Start in **Linux, Windows WSL2, or a Linux guest on macOS** with Node.js 20+, Git, GitHub CLI, and
Codex CLI. The installation procedure is verified with Codex CLI 0.153.0; newer clients must expose
the same plugin commands. Keep your target checkout and credentials inside the Linux environment.

1. Install the plugin:

   ```bash
   codex plugin marketplace add clockgrove/factory --ref main
   codex plugin add factory@clockgrove-factory
   codex plugin list
   ```

2. Authenticate in the same Linux user/process environment:

   ```bash
   codex login
   gh auth login
   ```

3. **Fully restart Codex** to load Factory's skills and bundled MCP server. Open your target
   repository's checkout and ask:

   > Use Factory director to inspect OWNER/REPO#OBJECTIVE with checkout /absolute/linux/checkout.
   > Check prerequisites before starting anything.

Replace the placeholders with an existing Objective issue and its clean checkout. Inspection checks
repository identity, access, branch rules, local runners, validation tools, and resource headroom.
Success means the plugin loads, an authenticated local backend is available, and the exact Objective
and checkout are accessible. **Inspection does not start workers.** Review the reported gates and
run policy, then explicitly authorize local-only execution.

The plugin bundles Factory's runtime; npm/npx and a sandbox account are not needed for this path.
Local workers use the Codex SDK by default, with Codex CLI fallback. Local-only work still consumes
your model account's quota. Follow the [local quick start](docs/setup/local.md) for permissions,
activation, troubleshooting, and the source-checkout CLI path.

## Try a small Objective

In a trusted Node.js repository with committed npm metadata, a lockfile, and a working `npm test`,
create an issue like this:

```markdown
## Outcome
Add a `healthcheck` npm script that runs the existing fast test command.

## Acceptance
- `npm run healthcheck` exits successfully from a clean checkout.
- Existing tests still pass.
- Change only package metadata and a focused regression test if needed.

## Boundaries
Use the existing Node/npm toolchain. Do not add dependencies, services,
secrets, network access, generated files, deployment, or release work.
```

Use its issue number in the inspection prompt above. After authorization, Factory compiles a Work
Item graph, runs workers, independently validates their artifacts, and delivers tested changes
through pull requests. The run ends with a terminal status and recorded usage, or a specific
escalation explaining what needs your attention. See the
[first-Objective walkthrough](docs/setup/local.md#a-small-first-objective) for expected evidence.

**An observed result:** on September 5, 2026, a staged 2.0.26 artifact completed a serialized
SDK-first run: three Work Items, three independently validated and merged PRs, and 30 passing tests
in a fresh clone. The [evidence record](https://github.com/clockgrove/factory/blob/main/docs/release-evidence/regular-delivery-component-2026-09-05.json)
identifies the exact candidate and scope; full release qualification remains in progress.

## What Factory handles

- **Planning and scheduling:** acceptance criteria, native GitHub dependencies, ready-task ordering,
  and local CPU/memory admission. The default ceiling is two workers; adaptive concurrency is opt-in.
- **Execution and delivery:** isolated Git worktrees, independent validation, ordinary pull requests,
  and explicitly selected native stacks with capability checks.
- **Recovery and inspection:** durable GitHub records, restart recovery, cancellation, status,
  explanations, and replay without a separate database.
- **Optional execution routes:** durable local Codex App Server sessions, Daytona cloud burst, and
  limited GitHub-managed integrations, subject to each provider's supported capabilities.

<a id="scope"></a>

Factory executes on Linux. Native Windows/macOS execution, coordinating multiple local computers,
and a custom UI are outside the current scope. Vercel Sandbox is a Labs adapter. Supported behavior
and live qualification are distinct; consult the
[operating scope](docs/OPERATING-REFERENCE.md#scope) and
[verification status](https://github.com/clockgrove/factory/blob/main/docs/CONFORMANCE.md).

## Safety and escalation

Use local workers only with trusted code: a same-user local process is not a hardened confidentiality
boundary. Workers use `workspace-write`; web search and command networking are off by default.
Factory checks repository identity, permissions, branch rules, scope, artifact evidence, and budget,
and escalates when it cannot safely proceed. Retries do not widen permissions, scope, or spending.

<a id="policy-and-paid-backends"></a>

Paid cloud execution requires explicit authorization and resource limits. Model-token budgets stop
before a subsequent call using observed usage; concurrent calls can overshoot them. Resource-minute
and session limits are not guaranteed dollar caps. You own provider billing and provider-side limits;
unavailable usage is never counted as zero. Read the
[full policy](docs/OPERATING-REFERENCE.md#policy-and-paid-backends) and
[threat model](docs/THREAT-MODEL.md) before unattended execution.

## Documentation

<a id="choose-your-setup"></a>
<a id="inspect-through-chat-or-mcp"></a>

| I want to… | Start here |
| --- | --- |
| Install and run locally | [Local quick start](docs/setup/local.md) |
| Continue after chat disconnects | [Unattended controller](docs/setup/unattended.md) |
| Inspect status, plans, recovery, or policy | [Operating reference](docs/OPERATING-REFERENCE.md) |
| Configure cloud or durable sessions | [Runner guides](docs/setup/README.md) |
| Handle binary assets and large files | [Large-file support](docs/LARGE-FILES.md) |
| Understand credentials and host limits | [Credentials](docs/CREDENTIALS.md) · [Host scheduling](docs/HOST-SCHEDULING.md) |

## Development

Contributions are welcome. Start with the
[contributor guide](https://github.com/clockgrove/factory/blob/main/CONTRIBUTING.md)
for setup, focused checks, and review expectations. The coordinated release gate is:

```bash
npm ci
npm run verify:release
```

It requires supported Linux, systemd 254+, and a reachable systemd user manager. See the
[release verification procedure](https://github.com/clockgrove/factory/blob/main/docs/CONFORMANCE.md#release-verification-procedure)
for exact prerequisites and remaining external gates.

Factory is [MIT licensed](https://github.com/clockgrove/factory/blob/main/LICENSE).
For questions and bug reports, use [support](SUPPORT.md). Report vulnerabilities through
[the security policy](SECURITY.md). Community participation follows the
[code of conduct](https://github.com/clockgrove/factory/blob/main/CODE_OF_CONDUCT.md) and
[governance](https://github.com/clockgrove/factory/blob/main/GOVERNANCE.md).
