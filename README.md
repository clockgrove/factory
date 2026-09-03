# Factory

Factory is a catalyst and multiplier for an indie developer or small trusted team. It turns one
developer, one computer, and the AI agents they already use into a coordinated software studio. A
human writes an Objective; Factory compiles it into native GitHub sub-issues, schedules
dependency-ready Work Items, runs coding workers, independently validates their artifacts, opens and
integrates pull requests, and continues until the Objective ships or a specific human decision is
required.

Factory is not a coding-agent competitor. Codex, Claude Code, and other agent runtimes perform the
engineering work; Factory supplies the cost-aware compiler, local-first scheduler, durable GitHub
protocol, recovery loop, and pull-request integration that make those sessions work as one system.
Its optimization target is validated progress per dollar and per hour, not raw concurrency.

Factory does **not** require a Factory GitHub Action, workflow, hosted service, database, queue, or
sidecar state. The plugin supplies the orchestration code. GitHub supplies the durable control plane.
A local process supplies the scheduler; the implementation roadmap replaces one manually started
process per Objective with one explicitly installed repository controller.

```text
Objective issue
      │
      ▼
Factory Supervisor ── compile / lease / schedule / budget / recover
      │                                      │
      │ durable receipts                     │ restricted Worker Packets
      ▼                                      ▼
GitHub issues, refs, PRs              local Codex CLI (default)
and native dependencies               or opt-in sandbox/managed backends
      ▲                                      │
      └──── validate / publish / merge ──────┘
```

## Product contract

- Work Items are GitHub sub-issues; dependencies are native `blocked by` relationships.
- Versioned run, lease, graph, attempt, validation, and budget receipts are reconstructable from
  GitHub. The full compiled graph is stored under an immutable custom ref before the first sub-issue
  is created, so a partial graph application replays facts without another model call.
- One compare-and-swap Director lease fences competing schedulers per Objective.
- Workers receive no GitHub mutation or merge authority. The host publishes only a bounded,
  content-addressed artifact after independent validation.
- Trusted work runs in an exact-SHA local Git worktree by default.
- Daytona, Vercel Sandbox, and GitHub's managed coding agent are explicit paid options. There is no
  implicit cloud fallback.
- Mechanical polling never calls a model. Model calls are bounded compilation and semantic-review
  decisions.
- Work Item count is derived from the work. It is never hard-coded.

The authoritative contract and failure model are in [docs/DESIGN.md](docs/DESIGN.md). The concrete
priority and local-to-cloud burst implementation is specified in
[docs/ADAPTIVE-SCHEDULING-IMPLEMENTATION-PLAN.md](docs/ADAPTIVE-SCHEDULING-IMPLEMENTATION-PLAN.md).
The accepted product scope, chat/MCP boundary, repository controller, cost-aware compiler, durable
Codex sessions, native stacked-PR delivery, and ordered release plan are specified in
[docs/INDIE-FACTORY-IMPLEMENTATION-PLAN.md](docs/INDIE-FACTORY-IMPLEMENTATION-PLAN.md).
The original GitHub-Copilot-specific protocol is preserved in
[docs/PROTOCOL-V1.md](docs/PROTOCOL-V1.md) only for compatibility with already-running work.

## Install and activate

Install Factory from `clockgrove/factory` using your Agent Plugins-compatible client, then restart the
client so its skills and bundled MCP server are reloaded. Installation runs no lifecycle scripts and
does not need `node_modules`; provider SDKs are included in the committed JavaScript bundle.

Authenticate GitHub on the host with `gh auth login`, or expose `GITHUB_TOKEN`/`GH_TOKEN` to the
plugin process. Installing the plugin does not install a GitHub Action and does not activate any
repository.

In a supported harness, invoke the `director` skill with:

- `OWNER/REPO#OBJECTIVE`
- the absolute local checkout path
- an optional complete run-policy object

The skill makes one long-lived `factory_run` call. The default policy uses only
`codex-cli/local-worktree`, never paid compute. The equivalent source-checkout command is:

```bash
npm ci
npm run build
node dist/factory.js run OWNER/REPO#OBJECTIVE --until-terminal --repo /absolute/repo/path
```

The process survives ordinary worker failures and reconstructs interrupted work from GitHub when
restarted. It cannot wake a powered-off machine. The current release can use an optional
user-authorized host scheduler to restart the same command at login or boot; the planned repository
controller will make that one service per checkout instead of one service per Objective. See
[docs/HOST-SCHEDULING.md](docs/HOST-SCHEDULING.md) for the current Linux/WSL boundary.

Request a fenced cancellation from another shell with:

```bash
node dist/factory.js cancel OWNER/REPO#OBJECTIVE --reason "operator request"
```

The request is a durable GitHub event. The active Supervisor stops workers, records terminal attempt
and run receipts, and releases the lease; killing a process is not used as the cancellation record.

## Policy and paid backends

The default policy is exported as `DEFAULT_RUN_POLICY`. A complete JSON override looks like:

```json
{
  "backendOrder": ["codex-cli/local-worktree"],
  "maxParallel": 2,
  "workItemTimeoutMinutes": 30,
  "objectiveTimeoutMinutes": 720,
  "maxAttemptsPerItem": 3,
  "allowedPaidBackends": [],
  "cloudFallback": "never",
  "maxSandboxMinutes": 0,
  "maxManagedAgentSessions": 0,
  "trust": "explicitly_activated_repo",
  "managementBackend": "codex-cli/local",
  "allowedNetworkDestinations": [
    "registry.npmjs.org",
    "*.npmjs.org",
    "api.openai.com"
  ]
}
```

To use Daytona or Vercel Sandbox, put its backend ID in both `backendOrder` and
`allowedPaidBackends`, set `cloudFallback` to `explicit`, and provide a nonzero sandbox-minute cap.
Sandbox validation consumes its own reservation because it runs in a fresh resource, separate from
the worker. See [docs/CREDENTIALS.md](docs/CREDENTIALS.md) for provider-specific credentials.

Probe without creating paid resources:

```bash
node dist/factory.js backends probe
```

## Safety and escalation

Factory checks repository identity, Objective provenance, fork status, branch rules, backend
capabilities, trust boundary, credentials, and remaining budget before launch. It rejects artifacts
with a wrong base, out-of-scope paths, sensitive execution surfaces, suspected secrets, malformed
evidence, or a validated tree that differs from the tree being published.

Local Codex workers never wait on an approval prompt. They stay inside `workspace-write`, run with
web search and command networking off by default, and receive only the Work Packet's preflighted
domain allowlist when command networking is required. Provider workers run inside an explicitly
selected, separately metered outer sandbox with provider-enforced TTL and egress policy.

It escalates with evidence when autonomy would require human review, unavailable credentials,
privileged/destructive changes, unsupported branch rules, exhausted budgets, repeated failure, or
semantic judgment below the acceptance bar.

Retries receive the prior attempt's bounded failure evidence as explicitly untrusted diagnostic
data. Factory never widens scope, trust, backend permissions, or budget to make a retry succeed.

## Development

```bash
npm ci
npm run typecheck
npm test
npm run verify:package
```

`verify:package` rebuilds the committed bundles, validates every manifest/skill/schema, starts the
bundled MCP server with no token, and verifies its public tool surface. See
[CONTRIBUTING.md](CONTRIBUTING.md) for contribution rules.

Current release evidence and the external gates that still require real provider credentials or a
published installation are tracked in [docs/CONFORMANCE.md](docs/CONFORMANCE.md).

Factory is MIT licensed.
