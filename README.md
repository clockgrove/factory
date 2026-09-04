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
- Pull requests are regular siblings by default. An explicit `stacked-prs` policy uses native GitHub
  stacks only after an observed repository capability probe; an unavailable capability is durably
  recorded before the configured regular-PR fallback or escalation.
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
- Publication receipts bind every PR to its planned position, base SHA, exact published head, and
  independent validation digest. A lower-layer head change invalidates affected descendants before
  revalidation or integration, and asynchronous stack merges resume from durable GitHub receipts.
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
`codex-cli/local-worktree`, adapts local admission to CPU and memory headroom up to eight workers,
and never uses paid compute. The equivalent source-checkout command is:

```bash
npm ci
npm run build
node dist/factory.js run OWNER/REPO#OBJECTIVE --until-terminal --repo /absolute/repo/path
```

The process survives ordinary worker failures and reconstructs interrupted work from GitHub when
restarted. It cannot wake a powered-off machine. The repository controller provides one fenced
service per checkout and can be installed into an explicitly authorized host scheduler for login or
boot recovery. See
[docs/HOST-SCHEDULING.md](docs/HOST-SCHEDULING.md) for the current Linux/WSL boundary.

Request a fenced cancellation from another shell with:

```bash
node dist/factory.js cancel OWNER/REPO#OBJECTIVE --reason "operator request"
```

The request is a durable GitHub event. The active Supervisor stops workers, records terminal attempt
and run receipts, and releases the lease; killing a process is not used as the cancellation record.

## Inspect through chat or MCP

The Director skill uses bounded, read-only operations when the user is inspecting a run:

- `factory_status` returns the current Objective/run state, active and queued Work Items, resource
  pressure, burst activity, and aggregate execution economics.
- `factory_explain` returns stable reason codes, policy gates, observed evidence, and the concrete
  action needed to unblock waiting or escalated work.
- `factory_replay` reconstructs durable scheduling receipts and can replay a credential-free pinned
  admission snapshot without writing GitHub or launching a worker.

These reports mark unavailable observations explicitly. They do not invent token counts, provider
costs, capacity readings, or timing data that were not durably observed.

## Policy and paid backends

The default policy is exported as `DEFAULT_RUN_POLICY`. A complete JSON override looks like:

```json
{
  "backendOrder": ["codex-cli/local-worktree"],
  "maxParallel": 8,
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
  ],
  "priority": {
    "source": "subissue-order",
    "unsetRank": 100,
    "onUnavailable": "fallback-to-subissue-order"
  },
  "capacity": {
    "mode": "adaptive-local",
    "local": {
      "maxWorkers": 8,
      "defaultCpu": 1,
      "defaultMemoryMb": 2048,
      "reserveCpu": 0.5,
      "reserveMemoryMb": 1024,
      "minimumFreeMemoryMb": 1024,
      "maxLoadRatio": 0.9,
      "maxMemoryUsageRatio": 0.85,
      "sampleIntervalSeconds": 5,
      "admissionCooldownSeconds": 10
    }
  },
  "burst": {
    "mode": "never",
    "backendOrder": [],
    "maxCloudParallel": 1,
    "queueDelaySeconds": 120,
    "deadlineReserveMinutes": 60,
    "maxPriorityRank": 1000
  },
  "delivery": {
    "mode": "regular-prs",
    "onUnavailable": "regular-prs",
    "merge": "bottom-up"
  }
}
```

Set `delivery.mode` to `stacked-prs` to request native stacks. The GitHub stack surface is a public
preview pinned to API version `2026-03-10`; Factory probes it before compilation spend and never
silently changes the recorded delivery selection after publication begins.

To use Daytona or Vercel Sandbox, put its backend ID in both `backendOrder` and
`allowedPaidBackends`, set `cloudFallback` to `explicit`, and provide a nonzero sandbox-minute cap.
Sandbox validation consumes its own reservation because it runs in a fresh resource, separate from
the worker. See [docs/CREDENTIALS.md](docs/CREDENTIALS.md) for provider-specific credentials.

Use native sub-issue order as the zero-configuration priority. To configure an organization
single-select issue field, inspect its stable field and option IDs without writing GitHub:

```bash
node dist/factory.js priority-fields OWNER/REPO
```

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
npm run verify:release
```

`verify:package` rebuilds the committed bundles, validates every manifest/skill/schema, starts the
bundled MCP server with no token, installs a staged copy through an isolated Codex home, and starts
both installed executables without using worktree configuration. `verify:release` also runs the full
test suite, typecheck, and production dependency audit. See
[CONTRIBUTING.md](CONTRIBUTING.md) for contribution rules.

Current release evidence and the external gates that still require real provider credentials or a
published installation are tracked in [docs/CONFORMANCE.md](docs/CONFORMANCE.md).

Factory is MIT licensed.
